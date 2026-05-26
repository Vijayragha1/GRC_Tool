#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Update script — pull latest code and redeploy
# Run from the server: sudo /opt/grc-tool/deploy/update.sh
# ─────────────────────────────────────────────────────────────────────

APP_DIR="/opt/grc-tool"
cd "$APP_DIR"

echo "==> Pulling latest code..."
git pull origin main

echo "==> Rebuilding and restarting containers..."
docker compose up -d --build

echo "==> Pruning old Docker images..."
docker image prune -f

echo "==> Done! App is running."
docker compose ps
