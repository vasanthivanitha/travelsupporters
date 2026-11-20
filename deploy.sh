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
aws s3 sync web/ "s3://$bucket/" --region "$region"
printf 'Website: %s\nDynamoDB table: %s\n' "$website" "$(stack_output RegistrationsTableName)"
