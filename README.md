# Travel Supporters

The website in `web/` supports companion requests and supporter offers for international flights departing from India. Both forms accept any three-letter IATA destination code through **Other airport (enter code)**. Both registration forms submit to `POST /api/registrations`. API Gateway invokes a Python Lambda function that validates the form and writes either a companion request or a supporter offer to DynamoDB. The confirmation displays a reference ID. Retrying the same submission from the open page reuses that ID.

## Deploy to AWS

Install AWS CLI v2 and AWS SAM CLI. Sign in to an AWS account with permission to deploy CloudFormation, its artifact bucket, IAM roles, API Gateway, Lambda, DynamoDB, S3, and CloudFront. For AWS IAM Identity Center, run `aws sso login --profile YOUR_PROFILE` and select that profile when deploying.

```bash
git clone https://github.com/vasanthivanitha/travelsupporters.git
cd travelsupporters
AWS_PROFILE=YOUR_PROFILE ./deploy.sh travel-supporters us-east-1
```

The script defaults to stack `travel-supporters` in `us-east-1`. It deploys the infrastructure, uploads the website to a private S3 bucket, and prints the public HTTPS CloudFront URL and DynamoDB table name. The same command updates the stack and uploads changed files. AWS resources can incur charges.

## Deploy from CloudShell to the existing travelsupporters.com bucket

Open AWS CloudShell in the account that owns the bucket. The bucket is in `us-east-1`, and the deployment uses it as-is.

```bash
git clone https://github.com/vasanthivanitha/travelsupporters.git
cd travelsupporters
./deploy-existing.sh
```

If you already cloned the repository, run `git pull --ff-only` from the existing checkout before deploying. The script needs AWS CLI and SAM CLI. It uses CloudShell's AWS session, creates the separate `travel-supporters-registrations` backend stack, checks API Gateway CORS, and uploads the page and its assets. Back up the current `index.html`, `style.css`, and `airport.webp` if you need to restore the old website. The script updates those keys and adds a versioned JavaScript file. Bucket settings and other objects are preserved.

### HTTPS for the custom domain

The S3 static website endpoint serves HTTP. To serve the custom domain over HTTPS, request a public ACM certificate for `travelsupporters.com` in `us-east-1` and complete its DNS validation. In CloudFront, configure a distribution with the existing S3 bucket's **regional REST endpoint** as its origin, select Origin Access Control, and grant that distribution read access in the bucket policy. Use `index.html` as the default root object, set the viewer protocol policy to redirect HTTP to HTTPS, and attach the validated certificate and `travelsupporters.com` alternate domain. Point the domain's DNS to the distribution, using a Route 53 alias or your DNS provider's equivalent for the apex domain. If a CloudFront distribution already serves the domain, use it and verify the origin, certificate, and DNS.

Run `curl -I https://travelsupporters.com/` to verify the domain responds successfully before running the deployment. If it still serves the old page after uploading, invalidate `/` and `/index.html` on the distribution serving the domain and check again.

## Verify and manage registrations

Open the printed website URL and submit one companion request and one supporter offer using test data. Find each confirmation ID in the DynamoDB console under the table's **Explore table items** view. The `role` value is `request` or `offer`. Use authorized AWS access to view entries and contact emails. The table is retained if the CloudFormation stack is removed.

The trip board displays labeled examples. Registrations are stored privately for operator follow-up. The site currently offers registration receipts and leaves contact, matching, and edits to the operator.
