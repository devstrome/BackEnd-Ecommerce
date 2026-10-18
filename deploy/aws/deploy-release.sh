#!/usr/bin/env bash
set -Eeuo pipefail

API_BASE_URL="${1:?Pass the CloudFront HTTPS URL, for example https://d123.cloudfront.net}"
API_BASE_URL="${API_BASE_URL%/}"
PARAMETER_NAME="/belorella/prod/env"
RELEASE_ROOT="/opt/belorella/current"

case "$API_BASE_URL" in
  https://*.cloudfront.net) ;;
  *) echo 'Expected an HTTPS CloudFront distribution URL.' >&2; exit 2 ;;
esac

umask 077
aws ssm get-parameter --name "$PARAMETER_NAME" --with-decryption --region ap-southeast-2 --query 'Parameter.Value' --output text \
  | python3 -c 'import json,sys; value=json.load(sys.stdin); required=("DATABASE_URI","JWT_SECRET","JWT_REFRESH_SECRET","EMAIL_USER","EMAIL_PASSWORD"); missing=[key for key in required if not str(value.get(key,"")).strip()]; (sys.stderr.write("Missing required SSM settings: "+", ".join(missing)+"\n"),sys.exit(2)) if missing else None; json.dump(value,open("/etc/belorella/backend-env.json","w"),ensure_ascii=False)' 
chmod 0600 /etc/belorella/backend-env.json
chown root:belorella /etc/belorella/backend-env.json
chmod 0640 /etc/belorella/backend-env.json

cd "$RELEASE_ROOT/backend"
npm ci --omit=dev --no-audit --no-fund

cat >"$RELEASE_ROOT/frontend/.env.production.local" <<EOF
NEXT_PUBLIC_API_URI=${API_BASE_URL}
NEXT_PUBLIC_SITE_URL=https://belorella.com
EOF
chown belorella:belorella "$RELEASE_ROOT/frontend/.env.production.local"
chmod 0640 "$RELEASE_ROOT/frontend/.env.production.local"

cd "$RELEASE_ROOT/frontend"
npm ci --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=1536 NEXT_TELEMETRY_DISABLED=1 npm run build

cat >/etc/systemd/system/belorella-backend.service <<'UNIT'
[Unit]
Description=BELORELLA Express API and Socket.IO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=belorella
Group=belorella
WorkingDirectory=/opt/belorella/current/backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/belorella/current/backend/deploy/aws/run-backend-with-env.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadOnlyPaths=/etc/belorella/backend-env.json
MemoryMax=800M

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/belorella-frontend.service <<'UNIT'
[Unit]
Description=BELORELLA Next.js storefront
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=belorella
Group=belorella
WorkingDirectory=/opt/belorella/current/frontend
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3001
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
MemoryMax=900M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable belorella-backend belorella-frontend
systemctl restart belorella-backend belorella-frontend
systemctl restart caddy
systemctl --no-pager --full status belorella-backend belorella-frontend caddy

