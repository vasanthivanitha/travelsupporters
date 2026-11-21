#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

region=us-east-1
bucket=travelsupporters.com
website="https://$bucket"
stack=travel-supporters-registrations

aws sts get-caller-identity --region "$region"
aws s3api head-bucket --bucket "$bucket" --region "$region"
status="$(curl --silent --show-error --max-time 20 --output /dev/null --write-out '%{http_code}' "$website/")"
if [[ "$status" != 2?? ]]; then
  printf '%s returned HTTP %s over HTTPS. Enable HTTPS on this domain before uploading the registration forms.\n' "$website" "$status" >&2
  exit 1
fi

email_parameters=("ExistingWebsiteOrigin=$website")
if [[ -n "${EMAIL_SENDER:-}" ]]; then email_parameters+=("EmailSender=$EMAIL_SENDER"); fi
if [[ -n "${MATCH_ALERT_EMAIL:-}" ]]; then email_parameters+=("MatchAlertEmail=$MATCH_ALERT_EMAIL"); fi
sam validate --region "$region"
sam deploy --template-file template.yaml --stack-name "$stack" --region "$region" \
  --resolve-s3 --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "${email_parameters[@]}"

stack_output() {
  aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

endpoint="$(stack_output RegistrationEndpoint)"
if [[ "$endpoint" != https://*.execute-api.us-east-1.amazonaws.com/api/registrations ]]; then
  echo "The stack did not return the expected HTTPS registration endpoint." >&2
  exit 1
fi

preflight="$(curl --fail --silent --show-error --max-time 20 --dump-header - --output /dev/null \
  -X OPTIONS -H "Origin: $website" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' "$endpoint")"
if ! printf '%s\n' "$preflight" | tr -d '\r' | grep -Fxi "access-control-allow-origin: $website" >/dev/null; then
  echo "API Gateway did not authorize this website origin." >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
revision="$(sha256sum web/app.js | cut -c1-16)"
app_file="travel-registration-$revision.js"
sed -e "/<title>/i <meta name=\"registration-endpoint\" content=\"$endpoint\">" \
  -e "s/src=\"app[.]js[^\"]*\"/src=\"$app_file\"/" web/index.html > "$stage/index.html"

stack_output AdminConfig > "$stage/admin-config.json"
aws s3 cp "$stage/admin-config.json" "s3://$bucket/admin-config.json" --content-type application/json --cache-control no-store --region "$region"
aws s3 cp web/admin.html "s3://$bucket/admin.html" --region "$region"
aws s3 cp web/admin.js "s3://$bucket/admin.js" --region "$region"
aws s3 cp web/trip.html "s3://$bucket/trip.html" --region "$region"
aws s3 cp web/trip.js "s3://$bucket/trip.js" --region "$region"
aws s3 cp web/alerts.html "s3://$bucket/alerts.html" --region "$region"
aws s3 cp web/alerts.js "s3://$bucket/alerts.js" --region "$region"
printf 'Admin panel: https://travelsupporters.com/admin.html\nCognito user pool: %s\n' "$(stack_output AdminPoolId)"
aws s3 cp web/style.css "s3://$bucket/style.css" --region "$region"
aws s3 cp web/airports.json "s3://$bucket/airports.json" --region "$region"
aws s3 cp web/airport.webp "s3://$bucket/airport.webp" --region "$region"
aws s3 cp web/app.js "s3://$bucket/$app_file" --content-type text/javascript --region "$region"
aws s3 cp "$stage/index.html" "s3://$bucket/index.html" --content-type text/html \
  --cache-control 'no-cache' --region "$region"

printf 'Website: %s\nDynamoDB table: %s\n' "$website" "$(stack_output RegistrationsTableName)"
if ! curl --fail --silent --show-error --max-time 20 "$website/" | grep -F "$endpoint" >/dev/null; then
  echo "Files uploaded, but the domain is not yet serving the new page. Check the CloudFront origin and invalidate / and /index.html if cached." >&2
  exit 1
fi
