# Deploying GRC Tool on AWS Lightsail

## 1. Create a Lightsail Instance

1. Log into [AWS Lightsail Console](https://lightsail.aws.amazon.com)
2. Click **Create instance**
3. Select:
   - **Region**: Pick the closest to your users
   - **Platform**: Linux/Unix
   - **Blueprint**: Ubuntu 22.04 LTS or 24.04 LTS
   - **Instance plan**: $5/mo (1 GB RAM, 1 vCPU) for small teams; $10/mo (2 GB RAM) recommended for 10+ users
4. Under **Networking**, attach a **Static IP** (free while attached to a running instance)
5. Click **Create instance**

## 2. Open Firewall Ports

In the Lightsail console under your instance's **Networking** tab, ensure these ports are open:

| Port | Protocol | Purpose      |
|------|----------|--------------|
| 22   | TCP      | SSH          |
| 80   | TCP      | HTTP         |
| 443  | TCP      | HTTPS (SSL)  |

## 3. Run the Setup Script

SSH into your instance (use the browser-based SSH in the Lightsail console, or your own terminal):

```bash
ssh ubuntu@<your-static-ip>
```

Then run:

```bash
curl -sSL https://raw.githubusercontent.com/vijayragha1/grc_tool/main/deploy/lightsail-setup.sh | sudo bash
```

This installs Docker, Nginx, clones the repo, generates secrets, and starts the app.

## 4. Enable HTTPS (Recommended)

Point your domain's DNS (A record) to your Lightsail static IP, then:

```bash
sudo /opt/grc-tool/deploy/ssl-setup.sh yourdomain.com
```

## 5. Verify

Visit `http://<your-static-ip>` (or `https://yourdomain.com` after SSL setup). You should see the login page.

## Ongoing Operations

### View logs
```bash
cd /opt/grc-tool && docker compose logs -f
```

### Update to latest version
```bash
sudo /opt/grc-tool/deploy/update.sh
```

### Restart the app
```bash
cd /opt/grc-tool && docker compose restart
```

### Manual backup
```bash
cd /opt/grc-tool && docker compose exec -T isms node scripts/backup.js
```

The command backs up the configured `DB_PATH` and writes an encrypted database
plus a checksum manifest under `/app/data/backups` (`./data/backups` on the
host), so the result survives container replacement. The encryption key is not
included in the backup and must be held separately. Automated backups run once
daily at 2am from `/etc/cron.d/grc-backup`; the application does not start a
second in-process schedule, and both cron and the backup service use locks.

After the first backup, prove it is usable:

```bash
cd /opt/grc-tool && docker compose exec -T isms node scripts/restore-check.js
```

For off-host redundancy, mount encrypted storage into the container and set
`BACKUP_MIRROR_DIR` to that mount. Do not point it back at `/app/data/backups`.

The deployment also configures Nginx access logs to record `$uri` without the
query string. This prevents filters, reset links, and legacy CSRF-bearing URLs
from being retained in proxy logs. Review and securely expire any access logs
created before this configuration was installed according to your retention
policy.

### Runtime file permissions

The container runs as UID/GID `1000:1000`. Deployment scripts enforce `0700`
on `data`, `data/backups`, and `uploads`, `0600` on their files, and `0600`
root ownership on `.env`. Re-run `sudo /opt/grc-tool/deploy/update.sh` to
remediate permissions on an existing deployment before restarting it.

### Check SSL certificate renewal
```bash
sudo certbot renew --dry-run
```

## Architecture

```
Internet → Lightsail Static IP
         → Nginx (port 80/443, SSL termination)
         → Docker: GRC Tool (port 3000)
         → SQLite DB (./data/iso27001.db)
         → File uploads (./uploads/)
```

## Costs

| Resource          | Cost       |
|-------------------|------------|
| Lightsail $5 plan | $5/mo      |
| Static IP         | Free       |
| SSL (Let's Encrypt)| Free      |
| **Total**         | **$5/mo**  |

Upgrade to $10/mo plan if you need more resources.
