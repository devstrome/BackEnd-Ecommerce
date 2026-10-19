#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/aws/fetch-secrets.sh" >&2
  exit 1
fi

parameter_name="${1:-/belorella/prod/env}"
region="${AWS_REGION:-ap-southeast-2}"
install -d -o root -g root -m 0700 /etc/belorella
temp_file="$(mktemp /etc/belorella/backend.env.XXXXXX)"
trap 'rm -f "$temp_file"' EXIT

aws ssm get-parameter \
  --name "$parameter_name" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --region "$region" > "$temp_file"

test -s "$temp_file"
grep -Eq '^[[:space:]]*DATABASE_URI[[:space:]]*=' "$temp_file"
grep -Eq '^[[:space:]]*JWT_SECRET[[:space:]]*=' "$temp_file"
grep -Eq '^[[:space:]]*EMAIL_PASSWORD[[:space:]]*=' "$temp_file"

chown root:root "$temp_file"
chmod 0600 "$temp_file"
mv -f "$temp_file" /etc/belorella/backend.env
trap - EXIT
echo "Loaded $parameter_name into /etc/belorella/backend.env (secret values suppressed)."
