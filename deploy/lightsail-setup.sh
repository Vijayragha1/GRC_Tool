#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Lightsail Instance Setup Script for GRC Tool (ISO 27001)
#
# Run this on a fresh Ubuntu 22.04/24.04 Lightsail instance:
#   curl -sSL https://raw.githubusercontent.com/vijayragha1/grc_tool/main/deploy/lightsail-setup.sh | bash
#
# Or clone the repo first and run locally:
#   chmod +x deploy/lightsail-setup.sh && sudo ./deploy/lightsail-setup.sh
# ─────────────────────────────────────────────────────────────────────

APP_DIR="/opt/grc-tool"
REPO_URL="https://github.com/vijayragha1/grc_tool.git"

echo "==> Updating system packages..."
apt-get update && apt-get upgrade -y

echo "==> Installing Docker..."
apt-get install -y ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker

echo "==> Installing Nginx (reverse proxy)..."
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> Cloning application..."
if [ -d "$APP_DIR" ]; then
  echo "    $APP_DIR already exists, pulling latest..."
  cd "$APP_DIR" && git pull origin main
else
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

echo "==> Creating data and upload directories..."
mkdir -p data uploads

echo "==> Generating secrets..."
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  SESSION_SECRET=$(openssl rand -hex 48)
  ISMS_MASTER_KEY=$(openssl rand -hex 48)

  cat > "$ENV_FILE" <<ENVEOF
# GRC Tool — production environment
NODE_ENV=production
PORT=3000

# Required secrets (auto-generated — keep safe, back up separately)
SESSION_SECRET=${SESSION_SECRET}
ISMS_MASTER_KEY=${ISMS_MASTER_KEY}

# Optional: Email integration (uncomment and configure)
# RESEND_API_KEY=
# EMAIL_FROM_DEFAULT="ISMS <noreply@yourdomain.com>"
# APP_BASE_URL=https://yourdomain.com
ENVEOF

  chmod 600 "$ENV_FILE"
  echo "    .env created with generated secrets"
else
  echo "    .env already exists, skipping secret generation"
fi

echo "==> Building and starting containers..."
docker compose up -d --build

echo "==> Setting up Nginx reverse proxy..."
cat > /etc/nginx/sites-available/grc-tool <<'NGINXEOF'
server {
    listen 80;
    server_name _;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/grc-tool /etc/nginx/sites-enabled/grc-tool
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Setting up automatic backups (daily at 2am)..."
cat > /etc/cron.d/grc-backup <<'CRONEOF'
0 2 * * * root cd /opt/grc-tool && docker compose exec -T isms node scripts/backup.js >> /var/log/grc-backup.log 2>&1
CRONEOF

echo "==> Setting up automatic Docker container restart monitoring..."
cat > /etc/cron.d/grc-healthcheck <<'CRONEOF'
*/5 * * * * root docker inspect --format='{{.State.Running}}' iso27001-tool 2>/dev/null | grep -q true || (cd /opt/grc-tool && docker compose up -d)
CRONEOF

echo ""
echo "============================================"
echo "  GRC Tool deployment complete!"
echo "============================================"
echo ""
echo "  App running at: http://$(curl -s ifconfig.me):80"
echo ""
echo "  Next steps:"
echo "  1. Point your domain's DNS to this server's IP"
echo "  2. Run: sudo certbot --nginx -d yourdomain.com"
echo "     to enable HTTPS (free SSL via Let's Encrypt)"
echo "  3. Log in and create your first workspace"
echo ""
echo "  Useful commands:"
echo "    cd /opt/grc-tool"
echo "    docker compose logs -f        # view logs"
echo "    docker compose restart         # restart app"
echo "    docker compose down && docker compose up -d  # full restart"
echo "    sudo certbot renew --dry-run   # test SSL renewal"
echo ""
