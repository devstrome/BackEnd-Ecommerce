#!/usr/bin/env bash
set -Eeuo pipefail

ARTIFACT_BUCKET="${1:?Pass the private release bucket name}"
ARTIFACT_KEY="${2:-releases/current.zip}"
AWS_REGION="ap-southeast-2"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg unzip jq python3 snapd

# Ubuntu ARM64 does not publish the AWS CLI v2 package under the awscli name.
# Install the official ARM64 bundle so this works on the selected t4g host.
curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip
unzip -q -o /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update
rm -rf /tmp/aws /tmp/awscliv2.zip
aws --version

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

install -d -m 0755 /usr/share/keyrings
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Keep a small-instance Next.js production build from being killed by the OOM killer.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id -u belorella >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/belorella --shell /usr/sbin/nologin belorella
install -d -o belorella -g belorella -m 0750 /opt/belorella/releases/current
install -d -o root -g root -m 0700 /etc/belorella

aws s3 cp "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}" /tmp/belorella-release.zip --region "$AWS_REGION"
unzip -q -o /tmp/belorella-release.zip -d /opt/belorella/releases/current
chown -R belorella:belorella /opt/belorella/releases/current
ln -sfn /opt/belorella/releases/current /opt/belorella/current
rm -f /tmp/belorella-release.zip

install -m 0644 /opt/belorella/current/backend/deploy/aws/Caddyfile /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

# Ubuntu's official images commonly ship the SSM agent. Install it if absent.
if systemctl list-unit-files | grep -q '^amazon-ssm-agent.service'; then
  systemctl enable --now amazon-ssm-agent.service
else
  snap install amazon-ssm-agent --classic
  systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
fi

