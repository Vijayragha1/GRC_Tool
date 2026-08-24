#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Enable HTTPS with Let's Encrypt
# Usage: sudo ./deploy/ssl-setup.sh yourdomain.com
# ─────────────────────────────────────────────────────────────────────

DOMAIN="${1:-}"

if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <your-domain.com>"
  echo "Example: $0 grc.mycompany.com"
  exit 1
fi

echo "==> Updating Nginx config for domain: $DOMAIN"
cat > /etc/nginx/conf.d/grc-log-format.conf <<'LOGEOF'
log_format grc_no_query '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                        '$status $body_bytes_sent "$http_user_agent"';
LOGEOF
cat > /etc/nginx/sites-available/grc-tool <<NGINXEOF
server {
    listen 80;
    server_name ${DOMAIN};
    access_log /var/log/nginx/grc-tool.access.log grc_no_query;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
    }
}
NGINXEOF

nginx -t && systemctl reload nginx

echo "==> Requesting SSL certificate..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect \
  --email "$(read -rp 'Enter email for certificate notifications: ' email && echo "$email")"

echo "==> Setting up auto-renewal..."
systemctl enable certbot.timer
systemctl start certbot.timer

echo "==> Updating APP_BASE_URL in .env..."
ENV_FILE="/opt/grc-tool/.env"
if grep -q "^APP_BASE_URL=" "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^APP_BASE_URL=.*|APP_BASE_URL=https://${DOMAIN}|" "$ENV_FILE"
elif grep -q "^# APP_BASE_URL=" "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^# APP_BASE_URL=.*|APP_BASE_URL=https://${DOMAIN}|" "$ENV_FILE"
else
  echo "APP_BASE_URL=https://${DOMAIN}" >> "$ENV_FILE"
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

echo "==> Restarting app with new config..."
cd /opt/grc-tool && docker compose up -d

echo ""
echo "  HTTPS enabled! Visit: https://${DOMAIN}"
echo ""
