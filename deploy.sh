#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

stack="${1:-travel-supporters}"
region="${2:-us-east-1}"
aws sts get-caller-identity --region "$region"
stack_output() {
  aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

deploy_stack() {
  local -a overrides=("$@")
  if [[ -n "${EMAIL_SENDER:-}" ]]; then overrides+=("EmailSender=$EMAIL_SENDER"); fi
  if [[ -n "${MATCH_ALERT_EMAIL:-}" ]]; then overrides+=("MatchAlertEmail=$MATCH_ALERT_EMAIL"); fi
  if (( ${#overrides[@]} )); then
    set -- --parameter-overrides "${overrides[@]}"
  else
    set --
  fi
  sam deploy --template-file template.yaml --stack-name "$stack" --region "$region" \
    --resolve-s3 --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset "$@"
}

sam validate --region "$region"
if existing_website="$(stack_output WebsiteUrl 2>/dev/null)" && [[ "$existing_website" == https://*.cloudfront.net ]]; then
  deploy_stack "AdminCloudFrontOrigin=$existing_website"
else
  deploy_stack
  new_website="$(stack_output WebsiteUrl)"
  if [[ "$new_website" == https://*.cloudfront.net ]]; then
    deploy_stack "AdminCloudFrontOrigin=$new_website"
  fi
fi

bucket="$(stack_output WebsiteBucketName)"
website="$(stack_output WebsiteUrl)"
if [[ "$bucket" == None || -z "$bucket" || "$website" != https://* ]]; then
  echo "Expected deployment outputs are missing." >&2
  exit 1
fi
table="$(stack_output RegistrationsTableName)"
api="$(stack_output RegistrationEndpoint)"
if [[ "$table" == None || -z "$table" || "$api" != https://* ]]; then
  echo "Expected registration outputs are missing." >&2
  exit 1
fi

admin_config="$(mktemp)"
trap 'rm -f -- "$admin_config"' EXIT
stack_output AdminConfig > "$admin_config"
aws s3 cp "$admin_config" "s3://$bucket/admin-config.json" --content-type application/json --cache-control no-store --region "$region"
aws s3 sync web/ "s3://$bucket/" --region "$region"
printf 'Website: %s\nAdmin panel: %s/admin.html\nCognito user pool: %s\nDynamoDB table: %s\n' \
  "$website" "$website" "$(stack_output AdminPoolId)" "$table"

for page in "/" "/admin.html" "/trip.html" "/alerts.html"; do
  if ! curl --fail --silent --show-error --retry 3 --retry-delay 5 --max-time 15 "$website$page" >/dev/null; then
    printf 'CloudFront did not serve %s. Check the distribution origin and S3 bucket policy.\n' "$website$page" >&2
    exit 1
  fi
done

for ((attempt = 1; attempt <= 40; attempt++)); do
  index_status="$(aws dynamodb describe-table --table-name "$table" --region "$region" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='PublicTrips'].IndexStatus | [0]" --output text)"
  if [[ "$index_status" == ACTIVE ]]; then
    break
  fi
  printf 'Waiting for the PublicTrips index (%s).\n' "$index_status"
  sleep 15
done
if [[ "$index_status" != ACTIVE ]]; then
  echo "PublicTrips is not active yet. Rerun this command after the index becomes ACTIVE." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --retry 4 --retry-delay 3 --max-time 15 "$api" >/dev/null; then
  echo "The site was uploaded, but the trip board API failed its health check. Read the Lambda logs with:" >&2
  printf 'sam logs --name Register --stack-name %q --region %q --tail\n' "$stack" "$region" >&2
  exit 1
fi

printf 'Trip board API is ready.\n'
