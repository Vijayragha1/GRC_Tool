# Compliance Sphere

Self-hosted web app for running ISO 27001:2022 engagements. Built around the way I actually work - assess gaps, write up recommendations, hand off to the client, return to re-assess, produce the deliverables a certification audit asks for.

Stack: Node + SQLite + EJS. No cloud, no build step, single binary worth of moving parts.

## Status

Email + password authentication is wired and enforced. The firm's first user is bootstrapped from `INITIAL_ADMIN_PASSWORD` in `.env`; every other firm consultant and client-side user is invited by email (one-time link, 7-day expiry) or admin-created with a temp password. Forgot-password, remember-me cookies, and Brute-force lockout (8 fails / 15 min / email) all included.

Most of what's here exists because I needed it on a real engagement and it wasn't there.

## The engagement flow it supports

```
kickoff workshop          ← /playbooks/kickoff (60-min facilitator script)
  → engagement intake     ← 25 Qs, auto-drafts clause 4.3 scope    [Setup · step 1]
  → confirm scope         ← gate that locks in clause 4.3
  → assemble engagement team ← /workspaces/:id/team               [Setup · step 2]
                              · pick lead + senior + consultants
                              · invite client owner, ISMS manager, contributors
  → 12-week plan started  ← /workspaces/:id/engagement-plan
  → risk workshop         ← /playbooks/risk-workshop (90-min script)
  → Pass 1 gap assessment (every clause + Annex A control)         [Setup · step 3]
  → upload evidence as it comes in
  → generate Gap Assessment Report + Recommendations memo
  → hand off to client
  → client implements (out of scope for the tool)
  → Pass 2 re-assessment, diff against Pass 1
  → generate Stage 1/2 readiness pack
  → cert audit
```

A "pass" is one round of consultant assessment. Pass 1 = initial gap. Pass 2+ = re-assessments. Saves are tagged to the active pass so you can diff any two passes and see what improved, regressed, or stayed the same per control. Notes are scoped per pass - write gap-finding text in Pass 1 and verification text in Pass 2 without overwriting either.

## What's in it

### Engagement scaffolding

A senior consultant runs a kickoff from muscle memory. A junior reinvents it each time. The scaffolding bakes the senior's playbook into the tool so the junior can pick up an engagement on day one.

- **Engagement intake** - 25-question scoping questionnaire across 6 sections (business context, scope, organisation, interested parties, crown jewels, existing posture). Each question tagged with the clause it feeds. Auto-drafts the clause 4.3 scope statement and seeds the interested-parties register from the answers in one click.
- **12-week engagement plan** - pre-loaded roadmap (kickoff → Stage 2 readiness). Each phase has timed milestones with deliverables and clause tags. Click-to-toggle completion, per-phase progress bars.
- **Three facilitator playbooks** at `/playbooks` - *Kickoff workshop* (60 min), *Scoping workshop* (90 min), *Risk-assessment workshop* (90 min). Each is timed, scripted, segment-by-segment, with prompts, decisions to leave with, and watch-outs. Print-friendly so you can run from paper if the meeting screen is shared.

### Firm content library

Lives at `/firm/library`. The firm's own curated content, separate from the shipped defaults, that gets cloned into each new engagement. Today: a **firm risk library** (search/filter by domain or sector, add/edit/delete, re-seed from starter set). New firms auto-get the 59-risk starter library copied in as a seed - ISO 27001 + AI/ML (shadow AI, prompt injection, training-data leakage, model drift, automation bias, third-party model API change) + software supply chain (npm/PyPI compromise, build-pipeline tampering, stolen dev credentials, container CVEs, OSS licence) + cloud configuration (IAM, public buckets, KMS rotation, public mgmt plane, multi-account isolation) + regulatory change (EU AI Act, DORA, NIS2, India DPDP, sector-specific). The firm then customises (sector tweaks, internal additions) without touching code. The "+ Firm library" button on a workspace's risk register clones every entry in (idempotent - duplicates skipped). Stubs for policy templates and control narratives are visible on the hub.

### Gap assessment

Walks all 25 main-body clauses + 93 Annex A controls in audit order. Per-item Yes / Partial / No diagnostic questions compute a status hint; you set the final status. Append-only history snapshot per save. Heatmap by Annex A theme (Organizational / People / Physical / Technological). Trend chart of average maturity per theme across passes. Re-engagement orientation panel showing what changed since the last pass closed (new evidence, NCs, controls touched, evidence superseded).

Each item also carries a **`minimum_certifiable` MVP target** - 2-4 sentences describing the smallest version that will still pass Stage 2, rendered as a green-tinted tile alongside "What good looks like" so a consultant on a small client has an explicit floor. Covers all 118 items.

### Statement of Applicability

All 93 Annex A controls. Inclusion / exclusion + justification. The risks treating each control are surfaced inline so the 6.1.3.d.1 trace is visible without clicking through. Custom non-Annex-A controls supported (NIST CSF, internal). Metadata header with version / owner / approver / approved-on. Auto-justify from linked risks. Snapshot history. Per-row autosave + a `Save all changes` batch button that flushes every dirty row in one transaction (useful at the end of a sweep).

### Evidence library

Upload once, link to many controls. SHA-256 dedupe. Versioning via supersede - the old version stays in the audit trail. Bulk upload of multiple files with shared metadata. Per-link sub-clause references. Tags. Expiry tracking.

### CSV import for assets + risks

`/workspaces/:id/assets/import` and `/workspaces/:id/risks/import`. Drag-drop a spreadsheet, get a preview with per-row validation (header synonyms, methodology-aware likelihood / impact ranges, asset-name resolution for risks, single-row error messages), then commit the valid rows in one transaction. Downloads a CSV template with example rows on demand. Fastest way to populate a new engagement on day one.

### Policy template library

`/workspaces/:id/templates`. 74 ISO 27001:2022-aligned policy + procedure starters (organisational, technical, people-physical, forms-roles, bundles), tiered into mandatory ★ / expected ◆ / recommended ·. Each template has a description with Annex A control references extracted at boot — adopting a template auto-links every referenced control to the resulting document. "Adopt all mandatory" bulk action covers the 10 ISO-required documents in one click; preview shows the rendered markdown with client-name substitution before adoption.

### Audit pack PDF

`/workspaces/:id/audit-pack`. Single branded PDF, generated by Puppeteer (bundled Chromium) from a print-optimised EJS template. Cover sheet with firm wordmark + hairline rule, executive summary, full SoA snapshot with SHA-256 hash, risk register + heatmap, evidence index with per-file hashes, internal audit findings, NCs, MRMs, improvements, audit-trail tail. Section toggles + brand overrides on the config page. The companion ZIP archive (raw CSVs + DOCX + evidence files) lives at `/audit-pack/zip` for auditors who want to grep.

### Auditor portal

`/workspaces/:id/auditor-access`. Mint a time-bound magic link to share read-only access with an external auditor — no account, no email setup, no integration. The auditor opens `/auditor/{token}` and sees a stripped-chrome read-only portal: a McKinsey-style cover letter with a Roman-numeral table of contents, then SoA (current or any snapshot), risk register + heatmap, evidence index with per-file download, policies + procedures viewer with control mappings, internal audits + NCs combined, and on-demand audit-pack PDF regen. Every access is timestamped and logged; the consultant sees the access log in the share-management console and can revoke at any time.

### Client collaboration portal

`/workspaces/:id/client-portal`. Production read-write workspace for the consultant/client hand-off: durable evidence, policy, control, and action requests with named assignees, priorities, due dates, acceptance criteria, optimistic-concurrency protection, and an append-only lifecycle history. Client users upload SHA-256-hashed evidence directly against a request, discuss scoped controls and policies, submit work for review, receive requested changes, and complete sequenced policy approvals through the existing tamper-evident signature flow. Contributor accounts are hard-confined to the portal and see only assigned requests plus explicitly scoped controls/documents; client owners and ISMS managers retain the full operator surface. Every lifecycle action is CSRF-protected, workspace-qualified, notified, and written to the hash-chained audit log.

### Changes since last audit

`/workspaces/:id/changes-since`. Surveillance + recertification handoff. Pick an anchor date (default: last audit's `audit_date`, fallback to last snapshot, fallback to -365d) and see a structured diff: SoA changes (snapshot-to-snapshot), risks added since, evidence uploaded since, documents new + version-bumped + retired, NCs opened + closed, internal audits conducted, MRMs held, improvements opened + closed, audit-log activity roll-up by action.

### Deliverables hub

`/workspaces/:id/deliverables`. One canonical home for every export this workspace produces, grouped semantically: for the certification body (audit pack PDF, companion ZIP, readiness pack), for internal stakeholders (gap report DOCX, RTP DOCX, recommendations DOCX, post-assessment summary DOCX), and raw data (SoA CSV, risks CSV, assets CSV, ISO 42001 SoA CSV if framework enabled). Each row has a format chip in semantic colour, a one-line description, and a single download button.

### Review workflow + in-app comments

Threaded comments on every control assessment (`views/partials/comments_thread.ejs`) with `@mention` hints and inline @-mention rendering. Any consultant can **flag a control for senior review** with a reason; the row tags `review_requested` and a reviewer takes action (approve / send back / dismiss) from a cross-framework **`/workspaces/:id/review-queue`** with KPIs and status filters. Reviewer-action events log to the audit trail. Works the same on ISO 27001 and ISO 42001.

### ISMS performance metrics + feed to MRM

`/workspaces/:id/metrics`. One dashboard pulling the numbers a clause 9.1 monitoring + 9.3 management-review session actually needs: implementation %, evidence coverage %, NC closure rate (last 90 / 180 days), risk-acceptance velocity, audit findings open / closed, MRM action-closure rate, document review-age distribution. Each tile has a one-click **"feed into next MRM"** action that appends the snapshot (with timestamp) into the upcoming MRM's performance-review input - so the 9.3.2(c) field isn't a blank prompt at MRM time.

### Evidence coverage matrix

`/workspaces/:id/evidence-coverage`. One row per Annex A control, with: applicability, status, evidence count, last-evidence date, linked-policy count, days-since-last-evidence. Highlights "Implemented with 0 evidence" rows in red - the most common Stage 2 finding. CSV export at `/evidence-coverage.csv` for the auditor or the engagement lead's followup.

### Policy adoption dashboard

`/workspaces/:id/policy-adoption`. For each mandatory + expected document template, shows whether it's been adopted in this workspace, its current status (draft / pending review / approved), version, owner, last review date, and the count of controls it covers. The "still missing" panel surfaces the templates the workspace hasn't adopted yet.

### Training, competence, communication (Clauses 7.2 / 7.3 / 7.4)

- **Training tracker** at `/workspaces/:id/training` - courses (name, duration, validity months, required-for roles, optional quiz with passing score, ISO control ref) + records (assigned / due / completed / score / status). Completion KPI, overdue list, per-role coverage. Maps to A.6.3 + Clause 7.3.
- **Competence matrix** at `/workspaces/:id/competence` - roles with their required competences, plus per-person records (certificate / experience / training-record evidence, recorded-at, expires-on). Surfaces gaps. Maps to Clause 7.2.
- **Communication plan** at `/workspaces/:id/communication-plan` - what / audience / channel / frequency / owner / internal vs external / last-sent / next-due / trigger event. Overdue and "due soon" rows highlight on the dashboard. Maps to Clause 7.4.

### Email integration

`/admin/email` (Manager-only). Per-firm branded transactional mail — `From name`, `From email`, `Reply-to`, on/off switch, test-send button, and a 50-row outbox log for deliverability triage. The status strip at the top reflects whichever provider is actually active.

Three providers supported, picked in this order by the dispatcher:

| Provider | Env vars | Free tier | When it fits |
|---|---|---|---|
| **Brevo** (HTTP API) | `BREVO_API_KEY`, optional `BREVO_SENDER_EMAIL` | 300/day, no domain verification | Best for testing real delivery — verify one sender email, done |
| **Gmail SMTP** | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | ~500/day per personal account | Quickest for solo dev — 2FA + app password, then it works |
| **Resend** (HTTP API) | `RESEND_API_KEY` | 3,000/month | Production fit once you verify your own sending domain |
| Dev fallback | — | unlimited | Without any of the above, outbound mail is appended to `data/email-dev-outbox.log` and the `email_outbox` row still gets written so flows are testable end-to-end without sending real mail |

Wired-in use cases: policy submission emails each approver in turn; every sign-off advances the chain (next approver gets nudged); approval or rejection emails the original submitter with the chain summary or rejection reason; invitations (firm + client users) send a one-time accept link; forgot-password sends a one-time reset link; admin-triggered password resets from the duplicate-detection inline action. Configured via env: provider keys above, plus `EMAIL_FROM_DEFAULT` and `APP_BASE_URL`.

### Authentication & roles

Six roles, three on the firm side, three on the client side. Defined in [lib/rbac.js](lib/rbac.js).

| Side | Role | Default capability |
|---|---|---|
| Firm | **Manager** | All permissions, firm-wide. Billing, user provisioning, all clients. |
| Firm | **Senior consultant** | Engagement lead. Reviews documents and forwards to client for approval; signs off assessments. |
| Firm | **Consultant** | Does engagement work. No approvals, no workspace deletion. |
| Client | **Client owner** | Executive sponsor. Final policy approver, signs off final assessments. |
| Client | **ISMS manager** | Day-to-day operator. Full workspace access; can approve operational docs. |
| Client | **Contributor** | Scoped SME (HR, IT, etc.). Uploads evidence + completes assigned items. |

Per-user permission overrides live at `/workspaces/:id/access` — a Manager / Sr consultant / Client owner can grant or revoke any of the ~50 individual permissions on top of the role baseline, per workspace, with an audit-trail reason field.

**Provisioning surfaces:**
- `/admin/users` (Manager-only) — firm-wide. Invite or create firm consultants; invite client-side users scoped to a specific workspace. **Inline firm-role edit** (dropdown per row, with last-active-manager + self-edit guards) and deactivate / reactivate per row.
- `/workspaces/:id/team` (any firm user) — per-engagement. Pick the lead consultant, add other firm consultants on the engagement, invite client owner / ISMS manager / contributors.

**Duplicate detection** on invites: an active account → inline "Send password reset instead" button; a deactivated account → inline "Reactivate" button; a pending invitation → silently revoked and replaced with a fresh one. No dead-end errors.

**External approvers** (auditors, supplier reviewers) never get accounts — they use one-shot magic links (`/approve/:token`). Same pattern as the auditor portal.

### Registers (clauses 4.2, 6.2)

Interested parties: party, type, needs, how addressed, owner, review cadence, next review. Information security objectives: title, measurement, target, current, owner, due, status. Both surface overdue rows in the inbox and feed the readiness pack.

### Pass deliverables

| File | What it is |
|---|---|
| **ISMS Audit Pack (PDF)** | **Branded headline deliverable: cover + exec summary + SoA + risk register + heatmap + evidence index + audits + NCs + MRMs + improvements. Section toggles, brand overrides, Puppeteer-rendered.** |
| Audit Pack companion ZIP | Raw CSVs + DOCX + evidence files — for an auditor who wants to grep |
| Gap Assessment Report (DOCX) | Per-pass: exec summary, gaps identified, full results |
| Recommendations memo (DOCX) | Ranked remediation list with consultant notes |
| Risk Treatment Plan (DOCX) | Clause 6.1.3.e document - risks with treatment, owner, controls, actions |
| Stage 1 / 2 readiness pack (ZIP) | SoA + RTP + audits + MRMs + parties + objectives + evidence manifest + every active evidence file |

The PDF Audit Pack is the auditor-facing deliverable. The readiness pack is its internal counterpart; the DOCX reports are consultant-to-client.

### Portfolio & analytics

- **Portfolio "this week"** on the dashboard - across all engagements in the active firm, every overdue item and every item due this week (tasks, NCs, audits, MRMs), with a per-client roll-up. The MSSP consultant's morning-standup view.
- **Prioritized actions** at `/workspaces/:id/prioritized-actions` - score-driven sequencing using the actual Stage 1 readiness formula. Each fixable item (open NCs, not-implemented controls, missing mandatory docs, first MRM, first audit) gets a lift estimate ÷ effort tag. KPI band shows current readiness → top-5 fixed → top-10 fixed, with the cumulative running total per row.
- **Executive brief** at `/workspaces/:id/exec-brief` - one-page, A4-printable health summary for the sponsor. Stage 1 / Stage 2 readiness, velocity (controls implemented in last 30d vs prior 30d), residual ALE estimate, top-5 risks, top-5 NCs. Print stylesheet hides chrome.
- **Per-client branding** - workspace settings carry brand display name, primary color (#RRGGBB validated server-side), logo URL, and sector. The brand color renders as the sidebar accent rail per workspace; the dashboard Clients table shows brand dot + sector chip per row. Customising for a new client is now config in workspace settings, not a code edit.

### Audit-grade content for every clause and control

All 118 items written up in [data/iso-content.js](data/iso-content.js): purpose, what good looks like, **minimum certifiable** (smallest version that will still pass Stage 2), where it usually goes wrong, evidence to gather, scoping notes, maturity ladder. Edits go in the file and sync into the database on boot.

**Provenance + staleness gate.** [data/content-meta.js](data/content-meta.js) records what each content source was last reviewed against (specific standard editions, amendments, IAF guidance) and a next-review date. `npm run content-staleness` walks every source, flags overdue + due-soon items, and exits non-zero if anything is overdue - drop it into CI so the content can't silently drift past the standard it claims to cover. Per-entry overrides supported.

### Other modules

Asset register · risk register with 59-entry starter library covering ISO 27001 + AI/ML + supply chain + cloud + regulatory change · risk methodology (configurable scales / criteria) · risk-acceptance DOCX export (clause 6.1.3.g audit artefact) · document management with WYSIWYG editor + DOCX export + **review-due snooze with audit-trailed reason** · internal audit programme with **SoA-driven checklist generator** (one observation per applicable control, with auditor-norm sample-size hints, linked-policy / linked-evidence counts, and a finding-wording template — alongside the existing category-based generator) plus an **inline checklist UI**: per-row auditor-notes textarea + save, filter pills (All / Clauses / A.5 / A.6 / A.7 / A.8) with live counts, **promote-to-finding** form (type + severity + description that defaults to the auditor's notes), mark-closed / reopen, and a **Clear open items** reset. Both generators dedupe — re-running doesn't double-insert. · management review with the full **6-of-6 Clause 9.3.2 inputs auto-populated on creation** (a–prior actions / b–context changes / c–performance / d–interested-party feedback / e–risk treatment / f–improvements) and a preview panel on the create form so the consultant sees exactly what will be auto-filled · nonconformities + corrective actions · incidents · suppliers with risk tiering · tasks · compliance calendar (training, comms, competence, supplier reviews, BCP, ISO 42001 cert woven in) · 168-term glossary (with inline-expand on the index plus deep-link detail pages) · cross-client at-risk dashboard with overdue / due-this-week roll-up. Activity log has tabs for Log / Timeline / Anomalies / Verify (hash-chain integrity). Gap-assessment wizard has a left-rail **theme-jump navigator** with per-theme completion meters so the consultant can bounce between Clauses / A.5 / A.6 / A.7 / A.8 instead of walking 118 items linearly.

### Multitenancy + security

Each tenant (firm) has its own workspaces, users, evidence storage, audit log. Tenant switcher in the topbar shows up only when more than one firm exists; almost no consulting practice needs more than one. Per-tenant uploads partitioning. Field-level encryption (AES-256-GCM, HKDF-derived per-workspace keys, master key in `data/master.key`). CSRF protection on every state-changing request - token rotated per session, validated against body / X-CSRF-Token header / query string, auto-stamped into every form by client-side JS (including dynamic forms and multipart uploads). External access — auditors, supplier-questionnaire respondents — uses time-bound magic-link tokens, never accounts; the token IS the credential and every access is logged.

### Design language

Oxblood `#5C0A0A` accent throughout. Display typography in self-hosted Source Serif 4 (variable woff2, 122 KB latin subset) on page titles, section titles, and the audit-pack PDF cover; body and tables in Inter. Status uses bold-weight semantic-coloured text rather than pill chips. Tag chips are outlined-only (no fill). ISO 27001 control + clause references carry a dotted-underline `.iso-ref` treatment in the accent colour — the typographic fingerprint that runs across the consultant app, the auditor portal, and the audit-pack PDF. Empty states are serif-titled prose notes, not centered icon cards.

## Install

You need Node.js 20 or newer and Git. `better-sqlite3` is a native module so the install step compiles C++ on first run - that needs the platform's build tools.

### Windows

1. Install **Node.js LTS** from https://nodejs.org/. In the installer, **tick "Tools for Native Modules"** - it pulls in Python and Visual Studio Build Tools, which `better-sqlite3` needs. Reboot after.
2. Install **Git for Windows** from https://git-scm.com/download/win.
3. Open PowerShell or Git Bash and run:

```powershell
git clone https://github.com/Vijayragha1/GRC_Tool.git
cd GRC_Tool
npm install
npm start
```

If `npm install` fails on `better-sqlite3`, the build tools didn't install. Either re-run the Node installer with "Tools for Native Modules" ticked, or install Visual Studio Build Tools directly from https://visualstudio.microsoft.com/visual-cpp-build-tools/ (pick the "Desktop development with C++" workload), then retry.

Don't put the project inside OneDrive - SQLite + sync conflicts are bad. Use a short path like `C:\dev\GRC_Tool`.

### macOS

1. Install **Homebrew** if you don't have it: https://brew.sh
2. Install Node + Git:

```bash
brew install node git
```

3. Clone and run:

```bash
git clone https://github.com/Vijayragha1/GRC_Tool.git
cd GRC_Tool
npm install
npm start
```

If `npm install` errors on `better-sqlite3`, install Xcode Command Line Tools: `xcode-select --install`, then retry.

### Linux (Debian / Ubuntu)

```bash
sudo apt update
sudo apt install -y nodejs npm git build-essential python3
git clone https://github.com/Vijayragha1/GRC_Tool.git
cd GRC_Tool
npm install
npm start
```

If your distro's `nodejs` package is older than 20, install from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### Linux (Fedora / RHEL)

```bash
sudo dnf install -y nodejs git gcc-c++ make python3
git clone https://github.com/Vijayragha1/GRC_Tool.git
cd GRC_Tool
npm install
npm start
```

### After install

Open http://localhost:3000. First boot creates the SQLite database, seeds the ISO content + document templates + glossary, and generates an encryption master key at `data/master.key`. A default tenant and a placeholder firm-owner account are seeded.

**Bootstrap your real password.** Add to `.env`:

```
INITIAL_ADMIN_PASSWORD=pick-something-strong
INITIAL_ADMIN_EMAIL=you@yourfirm.com           # optional, renames the placeholder local@local user
INITIAL_ADMIN_NAME=Your Name                   # optional, sets display name
SESSION_SECRET=a-random-32-char-string         # required in production; auto-generated dev fallback otherwise
APP_BASE_URL=http://localhost:3000             # used in email links
UPLOAD_AV_MODE=required                        # requires clamdscan for client evidence uploads
```

Restart the server. The bootstrap promotes the `!noauth` placeholder to a real bcrypt hash and (optionally) renames the email. Sign in at `/login`.

**Back up `data/master.key` immediately.** If you lose it, encrypted document content in the database is unrecoverable.

For dev with auto-restart on file save:

```bash
npm run dev      # node --watch server.js
```

To run on a different port:

```bash
PORT=3001 npm start            # macOS / Linux
$env:PORT=3001; npm start      # PowerShell
```

### Demo data

To see the tool with realistic content rather than an empty database:

```bash
node scripts/seed-realistic-engagements.js
```

For a single cross-framework management demonstration covering ISO 27001,
ISO 42001, NIST CSF 2.0, risk, policies, audit, TPRM, incidents, change and
business continuity:

```bash
DEMO_SEED_PASSWORD='use-a-unique-secret' npm run seed:management-demo
```

This creates or replaces only **Aurelis Group — Management Demo**. The seed is
idempotent, writes synthetic downloadable evidence under the firm's upload
partition, and validates minimum record counts before completing. Client portal
login: `client.management@demo.invalid` with the password supplied through
`DEMO_SEED_PASSWORD`. Production seeding refuses to run without this variable;
rotate or disable the synthetic accounts before exposing the deployment publicly.

Creates 5 demo accounts (manager / two senior consultants / consultant / client owner, with cross-engagement role assignments) and two client workspaces:
- **Apex Manufacturing Ltd.** at 100% implementation - 93/93 controls Implemented, every control has evidence, all NCs closed, two internal audits + two MRMs with everything actioned, full training / competence / supplier records.
- **Stellar Logistics PLC** at ~60% implementation - 57 / 27 / 9 (Implemented / Partial / Not Impl), mid-flight internal audit with open findings, mixed training and supplier review state.

All demo accounts share password `12345678`. **Demo-only - do not run this seed on a production database.** Idempotent: re-running wipes the prior demo workspaces by `client_name` before re-seeding.

## Editing the content

| File | What's in it |
|---|---|
| [data/iso-content.js](data/iso-content.js) | Per-clause / control writeups (118 items) - purpose / WGLT / `minimum_certifiable` MVP target / pitfalls / evidence / scoping notes / maturity ladder |
| [data/assessment-questions.js](data/assessment-questions.js) | Diagnostic questions per item |
| [data/glossary.js](data/glossary.js) | 168 GRC / ISO terms with cross-references |
| [data/risk-library.js](data/risk-library.js) | 59 starter risks (ISO 27001 + AI/ML + supply chain + cloud + regulatory change) |
| [data/policy-templates*.js](data/) | Document templates |
| [data/content-meta.js](data/content-meta.js) | Review cadence + provenance per source. `npm run content-staleness` walks this and fails CI on overdue content. |

Edits go in the file. Restart the server - the content sync runs at boot.

## Backup

```bash
npm run backup                       # uses ISMS_BACKUP_DIR
npm run backup -- /path/to/dir       # custom destination
npm run restore-check                # prove the newest generation restores
node scripts/restore-check.js --generation <id>  # prove one exact generation
node scripts/restore.js --destination /empty/path --generation <id>
```

Each committed recovery generation contains three `0600` artifacts: an online
SQLite backup, an encrypted snapshot of `ISMS_UPLOADS_DIR` (default `uploads/`),
and an HMAC-signed manifest containing archive and per-upload byte counts and
SHA-256 hashes. The manifest is written last, so it is the generation's commit
record only after that exact DB-and-uploads generation passes a full internal
restore. Retention and `BACKUP_MIRROR_DIR` copying operate on all three files.

The encryption master key is **never** included in a local or mirrored recovery
generation. Escrow `ISMS_MASTER_KEY` or `data/master.key` separately, with access
controls and failure-domain separation, and compare its fingerprint during
recovery. A generation without its matching key cannot be restored.

`npm run restore-check` verifies the signed manifest and both archive hashes,
restores SQLite and runs integrity/row-count checks, then safely extracts every
upload into a temporary directory and verifies its path, byte count, and hash.
Traversal, symlinks in the source snapshot, missing files, extra files, and
tampering fail closed. It also proves that retained file references in the
restored database resolve inside that upload tree. Legacy database-only archives
fail the full drill; `--allow-legacy-database-only` exists only for an explicit
SQLite salvage check. Signed generations older than
`ISMS_BACKUP_MAX_AGE_HOURS` (26 hours by default) fail the RPO gate; only an
explicit `--allow-stale-generation` salvage operation bypasses it.

`scripts/restore.js` is the operator restore path. It accepts an exact generation
ID and a nonexistent or empty destination, then writes `restored.db`, `uploads/`,
and `recovery-report.json`. It never overwrites or promotes live paths. Review
the report and perform promotion only in a separately approved offline change
window after stopping application traffic and retaining the current live data.
Schedule the backup daily, mirror it off-host, and require a successful full
restore drill at least monthly.

## Tests

```bash
npm test                # discovers and runs every tests/*.test.js suite
npm run test:security   # node:test - CSRF, XSS, auth gating, rbac matrix
npm run test:browser    # puppeteer crawler - every sidebar route, every button
```

- **Discovery guard**: `scripts/run-tests.js` assigns every `tests/*.test.js` file exactly once and fails when a family is empty or a suite is undiscovered.
- **Smoke** (bare-node): boots a fresh temporary DB through the migration chain and walks load-bearing authenticated workflows.
- **Security and RBAC** (`node:test`): cover CSRF, XSS, authorization boundaries, expiring overrides, evidence/export permissions, sessions, uploads, runtime failure handling, and recovery/deployment contracts.
- **Recovery**: builds and restores database-plus-upload generations, checks reference integrity, and exercises tamper and traversal failure paths.
- **Browser crawler** (`tests/browser-ui.js`): puppeteer-core driving headless Chrome through every sidebar route. Counts buttons, clicks every non-submit, validates modals, captures screenshots, asserts no console / network / page errors. 40 pages, ~450 buttons.

## What's not in it (and why)

Deliberately out of scope. The tool is consultant-side; anything client-ops belongs in the client's own systems.

- Phishing-sim tracking - not part of any cert audit
- Document acknowledgement campaigns - paper exercise
- AI-assisted assessment / auto-classification
- Real-time integrations with Microsoft 365 / Google Workspace / cloud providers
- Full LMS replacement - the training tracker captures completion records for clause 7.3 / A.6.3 evidence but isn't an authoring platform

## What's still open

- **SSO** (SAML / OIDC) — table stakes above $8K/yr; corporate IT will reject the password-only path.
- **REST API** — server-rendered only today. Procurement-grade buyers want to pull SoA / control state / evidence list out programmatically.
- **Cloud evidence integrations** (AWS Config / GCP Asset Inventory / Azure Resource Graph). Today every piece of evidence is hand-uploaded.
- **AI-assisted editing** (rewrite policy in $client's voice, draft a risk description from asset + threat keywords, suggest controls per risk). Gated on choosing an LLM provider + budget.
- **Real-time presence** — no "X is editing this" indicator anywhere. Optimistic-concurrency CAS catches conflicts on save, but the UI doesn't warn beforehand.
- **Continuous compliance flow** — quarterly evidence re-attestation cadence with auto-spawned tasks.
- **Time tracking + billing per workspace.**
- **More route extraction.** `routes/tenants.js`, `routes/engagement.js`, and `routes/auditor.js` prove the pattern (`register(app, deps)`); the rest of `server.js` can follow incrementally.

## Stack

Node 22 · Express · EJS · better-sqlite3 · TinyMCE 8 (self-hosted) · html-to-docx · archiver · mammoth / pdf-parse · multer · bcrypt + express-session (auth wired and enforced) · nodemailer (Gmail SMTP) + Brevo HTTP API + Resend HTTP API (provider auto-selected, dev-fallback writes to log) · **puppeteer (bundled Chromium, ~170 MB) for the audit-pack PDF generator**. Tests use node:test plus puppeteer-core. Self-hosted typography: Inter variable + Source Serif 4 variable, both as woff2 in `public/fonts/`. No frontend build step. Client-side JS does SPA-lite content swaps on same-origin nav - sidebar element stays in place, only the right pane re-renders, falls back to standard navigation on file downloads / failures / modifier-key clicks.

## Folder structure

```
.
├── server.js                       # Express app - most routes (extraction in progress)
├── db.js                           # Core schema + seeding; runs the migration chain on boot (init -> applyPending)
├── migrations/                     # Numbered SQL/data migrations (the runner is the source of truth for schema)
│   ├── run.js                      # applyPending(): runs only pending migrations, fails loud
│   └── fixtures/                   # Standalone post-cutover / post-demolition verification harnesses
├── schema_current.sql              # Schema of record (regenerated from a fresh boot at program close)
├── data/                           # Content + templates (edit here, syncs on boot)
│   ├── iso-content.js              # Per-clause / control writeups (118 items)
│   ├── assessment-questions.js     # Diagnostic Y/P/N questions per item
│   ├── glossary.js                 # 168 GRC / ISO terms
│   ├── intake-questions.js         # 25-question scoping questionnaire
│   ├── engagement-plan.js          # 12-week project plan template
│   ├── playbooks.js                # Kickoff / scoping / risk workshop scripts
│   ├── risk-library.js             # 59 starter risks (27001 + AI/ML + supply chain + cloud + reg change)
│   ├── content-meta.js             # Per-source provenance + review cadence
│   └── policy-templates*.js        # ~70 document templates
├── routes/                         # Extracted route modules (register(app, deps))
│   ├── tenants.js                  # Firm CRUD + onboarding wizard
│   ├── engagement.js               # Intake + scope confirm + 12-week plan
│   └── auditor.js                  # Magic-link auditor portal (token middleware + 8 read-only views)
├── lib/
│   ├── control-reads.js            # Converged control-state reads (the v_control_states / v_iso42001_control_states compat views over control_instances)
│   ├── control-writes.js           # Converged control-state writes (normalize display<->token, convergeSets)
│   ├── doc-links.js                # Document<->control links, drl-native (document_requirement_links)
│   ├── evidence-reads.js           # Evidence<->control links, erl-native (evidence_requirement_links)
│   ├── evidence-writes.js          # Evidence link writes, erl-native
│   ├── encryption.js               # AES-256-GCM + HKDF
│   ├── csrf.js                     # Per-session token + validate middleware
│   ├── rbac.js                     # Permissions model (ready for auth-on)
│   ├── audit-pack.js               # Gather + Puppeteer-render the PDF audit pack
│   ├── changes-since.js            # Surveillance / recert diff data gatherer
│   ├── csv-import.js               # RFC-4180 parser + schemas + validators for assets / risks
│   ├── template-refs.js            # Extract Annex A + clause refs from template descriptions
│   └── ...
├── views/                          # EJS templates
│   ├── auth/                       # Login, forgot, reset, accept-invite (unauth pages)
│   ├── admin_users.ejs             # Manager-only user provisioning
│   ├── team_setup.ejs              # Per-engagement team kickoff (Setup step 2)
│   ├── exec_brief.ejs              # Big-4 board pack (workpaper idiom)
│   ├── readiness.ejs               # Stage-gate scorecard (workpaper idiom)
│   ├── controls_assess_summary.ejs # Findings & worklist (workpaper idiom)
│   └── … other operator + deliverable views
├── public/fonts/                   # Self-hosted Inter + Source Serif 4 (woff2)
├── scripts/
│   ├── backup.js                   # SQLite + uploads recovery generation
│   ├── content-staleness.js        # Walk data/content-meta.js; CI gate for overdue content
│   └── seed-realistic-engagements.js  # Demo seed - 5 users + 2 engagements (100% / 60%)
├── tests/
│   ├── smoke.test.js               # Smoke suite (45 bare-node assertions)
│   ├── security.test.js            # CSRF + XSS + auth (node:test)
│   ├── rbac.test.js                # Role permission matrix (node:test)
│   ├── helpers.js                  # In-process app boot, cookie + CSRF jar
│   └── browser-ui.js               # Puppeteer crawler (40 pages, ~450 buttons)
├── public/                         # Static assets, TinyMCE bundle
├── uploads/firm_{id}/              # Evidence files (per-tenant partitioned)
└── data/master.key                 # Encryption master key (auto-generated, 0600)
```

## License

Private. Not currently open-sourced.
