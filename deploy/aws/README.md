# BELORELLA AWS deployment

This deployment targets the selected AWS Region `ap-southeast-2`. It runs the existing Express/Socket.IO API and Next.js storefront on one Ubuntu ARM64 EC2 host, with CloudFront in front of the host. MongoDB Atlas and Cloudinary remain external services. This is a small-site starting point; one EC2 host is a single point of failure and should be scaled or moved to a managed multi-instance design as traffic grows.

## Email and admin notices

- Gmail SMTP uses `smtp.gmail.com:587` and a Google App Password in `EMAIL_PASSWORD`.
- Superadmins receive every operational notification. Other active admins receive notices only for their assigned admin permissions (for example, Inbox receives chat messages and Orders receives order notices); no separate recipient-list environment variable is required.
- Customer chat, contact-form messages, online order events, invoice sends, digital fulfillment status, POS receipts, and admin-sent customer notices produce permission-scoped admin notifications.
- OTPs, passwords, invoice attachments, and digital redemption/access details are not copied to admin inboxes.
- After deployment, use the admin-only `/api/email-config/verify` and `/api/email-config/test-admin` endpoints to verify SMTP authentication and delivery. The verify call does not send a message; the test call does.

## Before production launch

Credentials were pasted into a chat earlier in the setup. Rotate every exposed provider secret before adding values to AWS: MongoDB Atlas database password, Gmail App Password, JWT signing secrets, Cloudinary API secret, Pathao and Steadfast credentials, and webhook tokens. Do not paste replacement secrets into chat or commit them.

1. Update the backend `.env` locally with the newly rotated values. Admin recipients are selected from active admin accounts and their assigned permissions.
2. Add the EC2 Elastic IP to the MongoDB Atlas IP access list. Do not open Atlas to `0.0.0.0/0`.
3. Run `push-secrets.ps1` from this directory to place the backend environment in SSM Parameter Store as a `SecureString` at `/belorella/prod/env`.
4. Allowlist any temporary CloudFront preview origin in `CLIENT_URL`; keep `https://belorella.com` in the list for the eventual domain cutover.
5. Build the release bundle with `prepare-release.ps1`. It excludes environment files and local-only workspace files.

The temporary CloudFront URL can be reviewed before production DNS changes. The main domain remains on its current host until the owner approves and performs the DNS cutover.

## AWS operational notes

- The instance uses an EC2 instance profile and Systems Manager Session Manager. Port 22 is closed.
- The app should read `/belorella/prod/env` at deploy and write its process environment to a root-owned `0640` file, readable only by the app service group, on the encrypted EBS volume.
- Security group ingress allows HTTP only from the AWS-managed CloudFront origin-facing prefix list. CloudFront redirects viewers to HTTPS, caches only immutable `/_next/static/*` assets, and forwards API/socket requests without caching.
- A CloudFront WAF rate rule blocks an IP after about 2,000 requests in five minutes. WAF logs go to an encrypted CloudWatch log group in `us-east-1` with 14-day retention; authorization and cookie headers are redacted. `us-east-1` is used only for the global CloudFront WAF resource.
- Use standard CPU credits on the T4g instance, not unlimited mode.
- The existing AWS Free plan is active until its expiry or remaining credits run out, whichever comes first. AWS closes Free-plan accounts at expiry, so upgrade before then if the deployment must remain available.

