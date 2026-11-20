#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

stack="${1:-travel-supporters}"
region="${2:-us-east-1}"
aws sts get-caller-identity --region "$region"
sam validate --region "$region"
sam deploy --template-file template.yaml --stack-name "$stack" --region "$region" \
  --resolve-s3 --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset

stack_output() {
  aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

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
  echo "Trip board API failed its health check. Read the Lambda logs with:" >&2
  printf 'sam logs --name Register --stack-name %q --region %q --tail\n' "$stack" "$region" >&2
  exit 1
fi

aws s3 sync web/ "s3://$bucket/" --region "$region"
printf 'Website: %s\nDynamoDB table: %s\n' "$website" "$table"
