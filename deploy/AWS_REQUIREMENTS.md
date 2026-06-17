# GRC Tool — AWS Hosting Requirements

This document lists what is needed to host the GRC Tool on AWS. It is written
for whoever is provisioning the AWS account and infrastructure. It describes the
application's shape, the resources it needs, the operational requirements
(backups, TLS, secrets), and three concrete deployment options with cost
estimates.

---

## 1. What the application is (so you can size it correctly)

| Property | Detail | Hosting implication |
|----------|--------|---------------------|
| Runtime | Node.js 20+ (Docker image ships Node 22) | Any AWS compute that runs a Node process or a Linux container |
| Architecture | Single monolithic Express app, server-rendered (EJS). No separate frontend, no build step. | One process, one port (`3000`). No microservices. |
| Database | **SQLite** (`better-sqlite3`), a single file on local disk | **Stateful.** Needs persistent block storage. Not a managed DB. Does **not** horizontally scale across multiple instances. |
| File storage | User-uploaded evidence files written to `uploads/` on local disk | Needs persistent storage that survives restarts/redeploys |
| Encryption key | `data/master.key` (or `ISMS_MASTER_KEY`) — AES-256 master key for field-level encryption | Must persist and be backed up **separately**. If lost, encrypted document content is unrecoverable. |
| PDF generation | Puppeteer + headless **Chromium** (~170 MB) for the audit-pack PDF | Memory-heavy and CPU-spiky during export. Drives the RAM floor (see sizing). |
| Email (optional) | Outbound only, via Resend / Brevo HTTP API or Gmail SMTP | Needs outbound HTTPS / SMTP egress. No inbound mail. |
| Sessions | Server-side sessions stored in SQLite | Tied to the single instance; another reason this is single-node. |

**Key takeaway:** this is a **single-node, stateful** application. The simplest
correct AWS design is **one instance + one persistent volume + scheduled
off-instance backups**, fronted by TLS. It is *not* a candidate for
auto-scaling / multi-instance horizontal scaling without first migrating SQLite
to a networked database — which the app does not currently support.

---

## 2. Minimum resource requirements

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| vCPU | 1 | 2 | Chromium PDF rendering is the spiky workload |
| RAM | 1 GB | **2 GB** | <1 GB risks OOM-killing Chromium during audit-pack export. 2 GB for 10+ concurrent users. |
| Disk | 20 GB | 40–80 GB | DB is small (MBs–low GBs); evidence uploads dominate growth. SSD/gp3. |
| OS | Ubuntu 22.04 / 24.04 LTS, or Amazon Linux 2023 | — | Container image is Alpine-based and OS-agnostic |
| Network | 1 public IPv4 (Elastic/static IP) | — | Stable address for DNS + TLS |

Storage grows with the number of uploaded evidence documents, not with users.
Size the volume to your expected evidence corpus and leave headroom for backups.

---

## 3. Network & security requirements

**Inbound ports** (Security Group / Lightsail firewall):

| Port | Protocol | Purpose |
|------|----------|---------|
| 443 | TCP | HTTPS (primary) |
| 80 | TCP | HTTP → redirect to HTTPS, and Let's Encrypt ACME challenge |
| 22 | TCP | SSH admin (lock down to your office/VPN IP range) |

The app itself listens on **3000**; that port should **not** be exposed
publicly — it sits behind a reverse proxy (Nginx / ALB) that terminates TLS.

**Outbound:** HTTPS (443) for OS/package updates and the optional email API; SMTP
(587) only if using Gmail SMTP for email. Otherwise no outbound dependency.

**TLS:** Required for production. Either Let's Encrypt on the instance (free, the
included `deploy/ssl-setup.sh` does this) or AWS Certificate Manager if you front
the app with an Application Load Balancer.

**Body size:** The reverse proxy must allow large request bodies for evidence
uploads (the provided Nginx config sets `client_max_body_size 50M`).

---

## 4. Configuration / secrets the company must provide

These are set as environment variables (see `.env.example`). The three marked
**required** must be generated before first boot:

| Variable | Required | Purpose |
|----------|----------|---------|
| `SESSION_SECRET` | **Yes** | Signs session cookies. Generate 48 random bytes. |
| `ISMS_MASTER_KEY` | **Yes** | Field-level encryption master key. **Back up separately; loss = unrecoverable encrypted data.** |
| `INITIAL_ADMIN_EMAIL` / `_NAME` / `_PASSWORD` | First boot | Bootstraps the first admin account. |
| `NODE_ENV=production` | Yes | Enables production hardening (rejects insecure default keys). |
| `PORT` | No (default 3000) | App listen port. |
| `APP_BASE_URL` | If email used | Public URL so links in emails resolve. |
| `RESEND_API_KEY` / `EMAIL_FROM_DEFAULT` | Optional | Outbound email. If unset, mail is written to a log file instead of sent. |

Generate the two secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Recommended AWS-native option: store these in **AWS Secrets Manager** or **SSM
Parameter Store (SecureString)** and inject at deploy time rather than committing
a `.env` file.

---

## 5. Backups & data durability (a compliance tool's data is the product)

The app ships an online backup script (`scripts/backup.js`) that snapshots the
live SQLite DB (no downtime), tars `uploads/`, and copies `master.key`, with a
manifest. Requirements:

- **Schedule** it (cron / systemd timer) — the provided setup runs it daily at 02:00.
- **Ship backups off the instance** — to **Amazon S3** (with versioning + lifecycle
  rules), ideally cross-region. The instance's local volume is not a backup.
- **Store the `master.key` separately** from the encrypted DB bundle so a single
  leaked bucket object can't both expose and decrypt your data.
- **EBS snapshots** of the data volume (via Amazon Data Lifecycle Manager) are a
  good second layer.
- **Test restores** periodically against a scratch instance.

---

## 6. Three deployment options on AWS

### Option A — Lightsail (simplest; this is what the repo already automates) ✅ recommended for a single firm

A single Lightsail instance running the app in Docker behind Nginx, with
Let's Encrypt TLS. The repo includes `deploy/lightsail-setup.sh`,
`deploy/ssl-setup.sh`, and `deploy/DEPLOY.md` that fully automate this.

- **Compute:** Lightsail $10/mo plan (2 GB RAM, 2 vCPU) recommended; $5/mo (1 GB) only for tiny pilots.
- **Static IP:** free while attached.
- **TLS:** free (Let's Encrypt).
- **Backups:** Lightsail automatic snapshots + push `scripts/backup.js` output to S3.
- **Est. cost:** **~$10–12/month** + a few dollars S3.
- **Pros:** cheapest, fastest, already scripted. **Cons:** least "AWS-native"; manual instance management.

### Option B — EC2 + EBS + Elastic IP (more control, AWS-native)

- **Compute:** EC2 `t3.small` (2 GB) or `t3.medium` (4 GB) for headroom.
- **Storage:** dedicated **gp3 EBS volume** for `data/` + `uploads/` (so you can snapshot/grow independently).
- **IP/TLS:** Elastic IP + Let's Encrypt, **or** put an **Application Load Balancer** in front with an **ACM** certificate.
- **Secrets:** Secrets Manager / SSM Parameter Store.
- **Backups:** EBS snapshots via Data Lifecycle Manager + `backup.js` → S3.
- **Est. cost:** **~$20–40/month** (instance + EBS + optional ALB ~$16/mo).
- **Pros:** standard AWS tooling, IAM, VPC isolation. **Cons:** you manage the OS.

### Option C — ECS Fargate (containerised, less server management)

Run the existing `Dockerfile` as an ECS Fargate task.

- **Important caveat:** SQLite + uploads need persistent storage, so you must
  attach **Amazon EFS** to the task for `/app/data` and `/app/uploads`, and run
  **exactly one task** (`desiredCount: 1`, no horizontal scaling) because SQLite
  is single-writer. EFS adds latency vs local disk.
- **TLS:** ALB + ACM certificate.
- **Secrets:** Secrets Manager injected into the task definition.
- **Est. cost:** **~$40–70/month** (Fargate task + ALB + EFS).
- **Pros:** no instance to patch, image-based deploys. **Cons:** most moving parts;
  EFS/SQLite is a workable but not ideal pairing; still single-task.

---

## 7. Scaling note (important to set expectations)

Because state lives in a local SQLite file and server-side sessions, the app runs
as **a single instance**. Vertical scaling (bigger instance) is the supported path.
True horizontal scaling / high-availability would require migrating the data layer
to a networked database (e.g. RDS Postgres) and an external session store — that is
a development effort, not a hosting configuration. For a single consulting firm or
client tenant, a single right-sized instance with solid backups is the correct and
sufficient design.

---

## 8. Recommended baseline for the company

> **One Lightsail $10/mo instance (2 GB / 2 vCPU) in Docker, Elastic IP, Let's
> Encrypt TLS, `ISMS_MASTER_KEY` and `SESSION_SECRET` generated and stored in a
> password manager / Secrets Manager, daily `backup.js` pushed to a versioned,
> cross-region S3 bucket with the master key stored separately.**

This is the path the repository already scripts end-to-end (`deploy/DEPLOY.md`),
gets the company to production in under an hour, and costs ~$12/month. Move to
EC2 (Option B) when you want VPC isolation, ACM/ALB, and finer IAM control.
