#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Update script — pull latest code and redeploy
# Run from the server: sudo /opt/grc-tool/deploy/update.sh
# ─────────────────────────────────────────────────────────────────────

APP_DIR="/opt/grc-tool"
APP_UID="1000"
APP_GID="1000"
cd "$APP_DIR"

echo "==> Pulling latest code..."
git pull origin main

echo "==> Checking and enforcing private runtime permissions..."
install -d -m 0700 -o "$APP_UID" -g "$APP_GID" data data/backups uploads
find data uploads -xdev \( ! -user "$APP_UID" -o ! -group "$APP_GID" \) -print 2>/dev/null || true
find data uploads -xdev -type d ! -perm 0700 -print 2>/dev/null || true
find data uploads -xdev -type f ! -perm 0600 -print 2>/dev/null || true
chown -R "$APP_UID:$APP_GID" data uploads
find data uploads -xdev -type d -exec chmod 0700 {} +
find data uploads -xdev -type f -exec chmod 0600 {} +
chown root:root .env
chmod 0600 .env

echo "==> Enforcing query-free reverse-proxy access logs..."
cat > /etc/nginx/conf.d/grc-log-format.conf <<'LOGEOF'
log_format grc_no_query '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                        '$status $body_bytes_sent "$http_user_agent"';
LOGEOF
if [ -f /etc/nginx/sites-available/grc-tool ] && ! grep -q 'grc_no_query' /etc/nginx/sites-available/grc-tool; then
  sed -i '/server_name/a\    access_log /var/log/nginx/grc-tool.access.log grc_no_query;' /etc/nginx/sites-available/grc-tool
fi
nginx -t
systemctl reload nginx

echo "==> Rebuilding without cache and restarting containers..."
# A no-cache rebuild is required after SEC-001 because deleting a secret in a
# later layer does not remove it from an older image layer.
docker compose build --pull --no-cache
docker compose up -d

echo "==> Pruning old Docker images..."
docker image prune -f

echo "==> Done! App is running."
docker compose ps
