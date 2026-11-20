# Travel Supporters

The website in `web/` supports companion requests and supporter offers for international flights to and from India. Type a three-letter IATA airport code in either form. Suggestions and airport names come from the bundled public-domain [OurAirports directory](https://ourairports.com/data/). Codes missing from the directory can still be entered. Both registration forms submit to `POST /api/registrations`. API Gateway invokes a Python Lambda function that validates the form and writes either a companion request or a supporter offer to DynamoDB. The confirmation displays a reference ID. Retrying the same submission from the open page reuses that ID.

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

The trip board displays upcoming companion requests and supporter offers that opt into publication. The public API returns only airport codes, date, registration type, selected help categories, and spoken languages if separately shared. Earlier registrations show **Not shared** for languages. Names, email addresses, phone numbers, notes, and detailed itineraries stay private for operator follow-up. New opt-in submissions appear automatically after DynamoDB indexes them.

To publish a previously submitted trip with the traveler's permission, open **DynamoDB → Explore table items**, select the registration by its reference ID, and add the String attribute `listing` with value `PUBLIC`. Remove that attribute to unlist a trip. Earlier records stay private until this field is set. The `PublicTrips` index can take a few minutes to become active on the first deployment.

## Manage listings in the admin panel

Deploy the latest stack and open the HTTPS admin URL printed by the script. The managed deployment supports the CloudFront URL directly as well as [the custom domain](https://travelsupporters.com/admin.html) when DNS and HTTPS are set up.

To invite your first administrator, open **Amazon Cognito → User pools** in the stack's AWS region, select the user pool ID printed by the deploy script, and open **Users → Create user**. Enter the administrator's email and send the invitation. Sign in with the temporary password and set a new password when prompted. Only invite trusted administrators. Self-registration is disabled, and every account in this dedicated pool can manage listings.

The panel shows registration references, trip routes, dates, and visibility. Choose **Publish** with the traveler's permission or **Unlist** to return a trip to private visibility. The public board can take a moment to reflect changes. The admin-side status updates immediately after saving.
