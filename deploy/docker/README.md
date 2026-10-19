# BELORELLA Docker deployment on EC2

This deployment runs the Next.js storefront and Express/Socket.IO API in Docker on one Ubuntu EC2 instance. Host Nginx is the only public listener. CloudFront provides public HTTPS, redirects viewer HTTP to HTTPS, and forwards requests to the origin over HTTP. Docker binds both application ports to loopback. MongoDB Atlas, Cloudinary, Gmail SMTP, and payment/courier providers remain external.

The current preview is `https://djpbx0x4mkv17.cloudfront.net`; the main domain stays on its current host until its owner approves a DNS cutover. The single EC2 host is a single point of failure, not a high availability setup.

## EC2 and network

- Ubuntu EC2 with Docker Engine and Compose plugin. The provisioned instance uses an EC2 instance profile and Systems Manager; port 22 is closed.
- Allow inbound TCP 80 only from the AWS-managed CloudFront origin-facing prefix list. Keep SSH, 3000, 3001, and 443 closed.
- The encrypted EBS volume holds images and app files. MongoDB remains external.
- Next.js standalone output creates a smaller runtime image while retaining server features. `NEXT_PUBLIC_*` values are embedded during the frontend image build, so changing those values requires rebuilding that image.

## Release layout

The release bundle contains both repositories under `/opt/belorella/current`:

```text
/opt/belorella/current/backend
/opt/belorella/current/frontend
```

The Compose file is `backend/deploy/docker/compose.yaml`; its frontend build context points to the sibling `frontend` directory.

## Public frontend configuration

Create `/etc/belorella/docker.env` from `backend/deploy/docker/.env.example`. Set `PUBLIC_ORIGIN` to the HTTPS CloudFront preview URL (no trailing slash), `SITE_URL` to the canonical website URL used in SEO/email links, and `CLIENT_URL` to the browser origins that should be allowed by the API. Keep this file free of private credentials; mode `0640` is sufficient.

## Backend secrets

The API reads backend secrets from `/etc/belorella/backend.env`. Store the rotated backend environment as the SecureString parameter `/belorella/prod/env` in Systems Manager Parameter Store. Retrieve it on EC2 with the attached instance profile by running `sudo bash /opt/belorella/current/backend/deploy/aws/fetch-secrets.sh`; it writes the decrypted value to `/etc/belorella/backend.env`, owned by `root:root`, mode `0600`. Never place backend secrets in the release bundle, the public Docker environment file, or frontend build arguments.

Credentials shared earlier must be rotated before production: MongoDB Atlas, Gmail App Password, JWT signing keys, Cloudinary, courier, and webhook credentials. Add the EC2 Elastic IP to MongoDB Atlas Network Access; avoid `0.0.0.0/0`. The release preparation script excludes environment files other than `.env.example`.

## Nginx and startup

Install `nginx-ec2.conf` as the only enabled Nginx site. It is the single port 80 `default_server`, accepts CloudFront's origin host, and routes `/api/*`, `/socket.io/*`, and the storefront to loopback-only containers. CloudFront redirects public HTTP viewers to HTTPS; the origin does not need a separate public TLS listener.

After both `/etc/belorella/docker.env` and `/etc/belorella/backend.env` have been created:

```bash
sudo nginx -t && sudo systemctl reload nginx
cd /opt/belorella/current/backend
sudo docker compose --env-file /etc/belorella/docker.env -f deploy/docker/compose.yaml up -d --build
sudo docker compose --env-file /etc/belorella/docker.env -f deploy/docker/compose.yaml ps
```

Check the services locally and through the preview:

```bash
curl -i http://127.0.0.1:3000/api/products
curl -i http://127.0.0.1:3001/
curl -i http://127.0.0.1/api/products
```

Then open `https://djpbx0x4mkv17.cloudfront.net`. Frontend API and Socket.IO URLs use `PUBLIC_ORIGIN`, so browser traffic returns through CloudFront and Nginx.

## Operations

Run from `/opt/belorella/current/backend`:

```bash
# Follow logs
sudo docker compose --env-file /etc/belorella/docker.env -f deploy/docker/compose.yaml logs -f --tail=100

# Restart the application containers
sudo docker compose --env-file /etc/belorella/docker.env -f deploy/docker/compose.yaml restart

# Rebuild after installing a new release
sudo docker compose --env-file /etc/belorella/docker.env -f deploy/docker/compose.yaml up -d --build
```

Docker is enabled at boot and both containers use `restart: unless-stopped`. This provides restart recovery on this single EC2 host; it does not provide high availability.
