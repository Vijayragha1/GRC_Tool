# Deploy to AWS Lightsail

This guide deploys the ISO 27001 GRC tool on a Lightsail instance using Docker Compose. Estimated cost: **$3.50-$5/mo** for the smallest instance that fits.

## Prerequisites

- An AWS account
- A domain name (optional but recommended for HTTPS)

## 1. Create the Lightsail instance

1. Go to [Lightsail console](https://lightsail.aws.amazon.com)
2. Click **Create instance**
3. Choose **Linux/Unix** → **OS Only** → **Ubuntu 24.04 LTS**
4. Pick the **$5/mo** plan (1 GB RAM, 1 vCPU, 40 GB SSD) — the $3.50 plan (512 MB) works but is tight once Puppeteer runs for PDF generation
5. Name it (e.g. `grc-tool`) and create

## 2. Configure networking

In the Lightsail console under your instance's **Networking** tab:

- Keep **SSH (22)** open
- Add **HTTP (80)** and **HTTPS (443)**
- Attach a **static IP** (free while attached to a running instance)

If you have a domain, point an A record to the static IP.

## 3. SSH in and install Docker

```bash
ssh ubuntu@<your-static-ip>

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu

# Log out and back in for group change to take effect
exit
ssh ubuntu@<your-static-ip>

# Verify
docker --version
docker compose version
```

## 4. Clone and configure

```bash
git clone https://github.com/vijayragha1/grc_tool.git
cd grc_tool

# Create persistent directories
mkdir -p data uploads
```

### Generate secrets

```bash
# Generate SESSION_SECRET
echo "SESSION_SECRET=$(openssl rand -hex 48)" >> .env

# Generate ISMS_MASTER_KEY
echo "ISMS_MASTER_KEY=$(openssl rand -hex 32)" >> .env

# Set production mode
echo "NODE_ENV=production" >> .env

# Optional: initial admin password (only used on first run)
echo "INITIAL_ADMIN_PASSWORD=$(openssl rand -base64 16)" >> .env
```

**Save a copy of `.env` somewhere secure** — if you lose `ISMS_MASTER_KEY`, encrypted data becomes unrecoverable.

## 5. Deploy

```bash
docker compose up -d
```

The app is now running on port 3000. Verify:

```bash
curl -s http://localhost:3000 | head -5
```

## 6. Set up HTTPS with Caddy (recommended)

Caddy auto-provisions Let's Encrypt certificates with zero config.

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Edit `/etc/caddy/Caddyfile`:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

Then:

```bash
sudo systemctl restart caddy
```

Caddy automatically obtains and renews TLS certificates. Your app is now live at `https://your-domain.com`.

Update `.env` to set the base URL for email links:

```bash
echo "APP_BASE_URL=https://your-domain.com" >> .env
docker compose up -d   # restart to pick up the change
```

### Without a domain (IP-only access)

If you don't have a domain yet, access the app directly at `http://<your-static-ip>:3000`. To expose it on port 80, change the port mapping in `docker-compose.yml`:

```yaml
ports:
  - "80:3000"
```

## 7. Backups

The app runs automatic daily backups (SQLite snapshots in `data/backups/`). For off-instance protection:

### Option A: Lightsail snapshots

Set up automatic instance snapshots in the Lightsail console (costs ~$0.05/GB/mo). This captures everything — OS, Docker images, data.

### Option B: S3 sync (data only)

```bash
# Install AWS CLI
sudo apt install awscli

# Configure (use an IAM user with S3-only access)
aws configure

# Cron job — daily at 2 AM
(crontab -l 2>/dev/null; echo "0 2 * * * aws s3 sync /home/ubuntu/grc_tool/data s3://your-bucket/grc-backups/data/ --quiet") | crontab -
(crontab -l 2>/dev/null; echo "0 2 * * * aws s3 sync /home/ubuntu/grc_tool/uploads s3://your-bucket/grc-backups/uploads/ --quiet") | crontab -
```

## 8. Updates

```bash
cd ~/grc_tool
git pull
docker compose build
docker compose up -d
```

## 9. Monitoring

```bash
# View logs
docker compose logs -f

# Check container health
docker ps

# Disk usage (watch the 40 GB SSD)
df -h
```

## Cost summary

| Item | Monthly cost |
|---|---|
| Lightsail instance (1 GB) | $5.00 |
| Static IP (attached) | Free |
| Lightsail snapshots (10 GB) | ~$0.50 |
| **Total** | **~$5.50/mo** |

## Troubleshooting

**Container won't start — FATAL: SESSION_SECRET must be set**
Your `.env` file is missing or not being read. Run `cat .env` to verify it exists, then `docker compose up -d` again.

**PDF generation fails or is slow**
The $3.50 plan (512 MB) may OOM when Puppeteer launches Chromium. Upgrade to the $5 plan, or add swap:

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Can't connect from browser**
Check that ports 80/443 (or 3000) are open in the Lightsail Networking tab.
