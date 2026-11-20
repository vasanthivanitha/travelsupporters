# Travel Supporters

The India–U.S. travel companion website lives in `web/`. Both registration forms submit to `POST /api/registrations`. API Gateway invokes a Python Lambda function that validates the form and writes either a companion request or a supporter offer to DynamoDB. The confirmation displays a reference ID. Retrying the same submission from the open page reuses that ID.

## Deploy to AWS

Install AWS CLI v2 and AWS SAM CLI. Sign in to an AWS account with permission to deploy CloudFormation, its artifact bucket, IAM roles, API Gateway, Lambda, DynamoDB, S3, and CloudFront. For AWS IAM Identity Center, run `aws sso login --profile YOUR_PROFILE` and select that profile when deploying.

```bash
git clone https://github.com/vasanthivanitha/travelsupporters.git
cd travelsupporters
AWS_PROFILE=YOUR_PROFILE ./deploy.sh travel-supporters us-east-1
```

The script defaults to stack `travel-supporters` in `us-east-1`. It deploys the infrastructure, uploads the website to a private S3 bucket, and prints the public HTTPS CloudFront URL and DynamoDB table name. The same command updates the stack and uploads changed files. AWS resources can incur charges.

## Verify and manage registrations

Open the printed website URL and submit one companion request and one supporter offer using test data. Find each confirmation ID in the DynamoDB console under the table's **Explore table items** view. The `role` value is `request` or `offer`. Use authorized AWS access to view entries and contact emails. The table is retained if the CloudFormation stack is removed.

The trip board displays labeled examples. Registrations are stored privately for operator follow-up. The site currently offers registration receipts and leaves contact, matching, and edits to the operator.
