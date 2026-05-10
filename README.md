# ISO 27001 tool

Self-hosted web app for running ISO 27001:2022 engagements. Built around the way I actually work — assess gaps, write up recommendations, hand off to the client, return to re-assess, produce the deliverables a certification audit asks for.

Stack: Node + SQLite + EJS. No cloud, no build step, single binary worth of moving parts.

## Status

Auth is off. The tool runs in single-user-per-tenant local mode. Fine for personal use and engagements you run on your own machine. Don't put it on the open internet until login is wired up.

Most of what's here exists because I needed it on a real engagement and it wasn't there.

## The engagement flow it supports

```
kickoff workshop          ← /playbooks/kickoff (60-min facilitator script)
  → engagement intake     ← 25 Qs, auto-drafts clause 4.3 scope
  → scoping workshop      ← /playbooks/scoping (90-min facilitator script)
  → 12-week plan started  ← /workspaces/:id/engagement-plan
  → risk workshop         ← /playbooks/risk-workshop (90-min script)
  → Pass 1 gap assessment (every clause + Annex A control)
  → upload evidence as it comes in
  → generate Gap Assessment Report + Recommendations memo
  → hand off to client
  → client implements (out of scope for the tool)
  → Pass 2 re-assessment, diff against Pass 1
  → generate Stage 1/2 readiness pack
  → cert audit
```

A "pass" is one round of consultant assessment. Pass 1 = initial gap. Pass 2+ = re-assessments. Saves are tagged to the active pass so you can diff any two passes and see what improved, regressed, or stayed the same per control. Notes are scoped per pass — write gap-finding text in Pass 1 and verification text in Pass 2 without overwriting either.

## What's in it

### Engagement scaffolding

A senior consultant runs a kickoff from muscle memory. A junior reinvents it each time. The scaffolding bakes the senior's playbook into the tool so the junior can pick up an engagement on day one.

- **Engagement intake** — 25-question scoping questionnaire across 6 sections (business context, scope, organisation, interested parties, crown jewels, existing posture). Each question tagged with the clause it feeds. Auto-drafts the clause 4.3 scope statement and seeds the interested-parties register from the answers in one click.
- **12-week engagement plan** — pre-loaded roadmap (kickoff → Stage 2 readiness). Each phase has timed milestones with deliverables and clause tags. Click-to-toggle completion, per-phase progress bars.
- **Three facilitator playbooks** at `/playbooks` — *Kickoff workshop* (60 min), *Scoping workshop* (90 min), *Risk-assessment workshop* (90 min). Each is timed, scripted, segment-by-segment, with prompts, decisions to leave with, and watch-outs. Print-friendly so you can run from paper if the meeting screen is shared.

### Firm content library

Lives at `/firm/library`. The firm's own curated content, separate from the shipped defaults, that gets cloned into each new engagement. Today: a **firm risk library** (search/filter by domain or sector, add/edit/delete, re-seed from starter set). New firms auto-get the 40-risk starter library copied in as a seed; the firm then customises (sector tweaks, internal additions) without touching code. The "+ Firm library" button on a workspace's risk register clones every entry in (idempotent — duplicates skipped). Stubs for policy templates and control narratives are visible on the hub.

### Gap assessment

Walks all 25 main-body clauses + 93 Annex A controls in audit order. Per-item Yes / Partial / No diagnostic questions compute a status hint; you set the final status. Append-only history snapshot per save. Heatmap by Annex A theme (Organizational / People / Physical / Technological). Trend chart of average maturity per theme across passes. Re-engagement orientation panel showing what changed since the last pass closed (new evidence, NCs, controls touched, evidence superseded).

### Statement of Applicability

All 93 Annex A controls. Inclusion / exclusion + justification. The risks treating each control are surfaced inline so the 6.1.3.d.1 trace is visible without clicking through. Custom non-Annex-A controls supported (NIST CSF, internal). Metadata header with version / owner / approver / approved-on. Auto-justify from linked risks. Snapshot history.

### Evidence library

Upload once, link to many controls. SHA-256 dedupe. Versioning via supersede — the old version stays in the audit trail. Bulk upload of multiple files with shared metadata. Per-link sub-clause references. Tags. Expiry tracking.

### Registers (clauses 4.2, 6.2)

Interested parties: party, type, needs, how addressed, owner, review cadence, next review. Information security objectives: title, measurement, target, current, owner, due, status. Both surface overdue rows in the inbox and feed the readiness pack.

### Pass deliverables

| File | What it is |
|---|---|
| Gap Assessment Report (DOCX) | Per-pass: exec summary, gaps identified, full results |
| Recommendations memo (DOCX) | Ranked remediation list with consultant notes |
| Risk Treatment Plan (DOCX) | Clause 6.1.3.e document — risks with treatment, owner, controls, actions |
| Stage 1 / 2 readiness pack (ZIP) | Single ZIP: SoA + RTP + audits + MRMs + parties + objectives + evidence manifest + every active evidence file |

The readiness pack is the artefact you hand the certification body. The other three are for the client during the engagement.

### Portfolio & analytics

- **Portfolio "this week"** on the dashboard — across all engagements in the active firm, every overdue item and every item due this week (tasks, NCs, audits, MRMs), with a per-client roll-up. The MSSP consultant's morning-standup view.
- **Prioritized actions** at `/workspaces/:id/prioritized-actions` — score-driven sequencing using the actual Stage 1 readiness formula. Each fixable item (open NCs, not-implemented controls, missing mandatory docs, first MRM, first audit) gets a lift estimate ÷ effort tag. KPI band shows current readiness → top-5 fixed → top-10 fixed, with the cumulative running total per row.
- **Executive brief** at `/workspaces/:id/exec-brief` — one-page, A4-printable health summary for the sponsor. Stage 1 / Stage 2 readiness, velocity (controls implemented in last 30d vs prior 30d), residual ALE estimate, top-5 risks, top-5 NCs. Print stylesheet hides chrome.
- **Per-client branding** — workspace settings carry brand display name, primary color (#RRGGBB validated server-side), logo URL, and sector. The brand color renders as the sidebar accent rail per workspace; the dashboard Clients table shows brand dot + sector chip per row. Customising for a new client is now config in workspace settings, not a code edit.

### Audit-grade content for every clause and control

All 118 items written up in [data/iso-content.js](data/iso-content.js): purpose, what good looks like, where it usually goes wrong, evidence to gather, scoping notes, maturity ladder. Edits go in the file and sync into the database on boot.

### Other modules

Asset register · risk register with starter library of 40 ISO 27001 risks · risk methodology (configurable scales / criteria) · document management with WYSIWYG editor + DOCX export and ~70 policy templates · internal audit (programme + audits + findings, on one tabbed page) · management review with auto-pulled 9.3.2 inputs · nonconformities + corrective actions · incidents · suppliers with risk tiering · tasks · compliance calendar · 168-term glossary (with inline-expand on the index plus deep-link detail pages) · cross-client at-risk dashboard. Activity log has tabs for Log / Timeline / Anomalies / Verify (hash-chain integrity).

### Multitenancy + security

Each tenant (firm) has its own workspaces, users, evidence storage, audit log. Tenant switcher in the topbar shows up only when more than one firm exists; almost no consulting practice needs more than one. Per-tenant uploads partitioning. Field-level encryption (AES-256-GCM, HKDF-derived per-workspace keys, master key in `data/master.key`). CSRF protection on every state-changing request — token rotated per session, validated against body / X-CSRF-Token header / query string, auto-stamped into every form by client-side JS (including dynamic forms and multipart uploads).

## Install

You need Node.js 20 or newer and Git. `better-sqlite3` is a native module so the install step compiles C++ on first run — that needs the platform's build tools.

### Windows

1. Install **Node.js LTS** from https://nodejs.org/. In the installer, **tick "Tools for Native Modules"** — it pulls in Python and Visual Studio Build Tools, which `better-sqlite3` needs. Reboot after.
2. Install **Git for Windows** from https://git-scm.com/download/win.
3. Open PowerShell or Git Bash and run:

```powershell
git clone https://github.com/Vijayragha1/GRC_Tool.git
cd GRC_Tool
npm install
npm start
```

If `npm install` fails on `better-sqlite3`, the build tools didn't install. Either re-run the Node installer with "Tools for Native Modules" ticked, or install Visual Studio Build Tools directly from https://visualstudio.microsoft.com/visual-cpp-build-tools/ (pick the "Desktop development with C++" workload), then retry.

Don't put the project inside OneDrive — SQLite + sync conflicts are bad. Use a short path like `C:\dev\GRC_Tool`.

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

Open http://localhost:3000. First boot creates the SQLite database, seeds the ISO content + document templates + glossary, and generates an encryption master key at `data/master.key`. A default tenant and workspace are seeded.

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

## Editing the content

| File | What's in it |
|---|---|
| [data/iso-content.js](data/iso-content.js) | Per-clause / control writeups |
| [data/assessment-questions.js](data/assessment-questions.js) | Diagnostic questions per item |
| [data/glossary.js](data/glossary.js) | 168 GRC / ISO terms with cross-references |
| [data/risk-library.js](data/risk-library.js) | Starter risks |
| [data/policy-templates*.js](data/) | Document templates |

Edits go in the file. Restart the server — the content sync runs at boot.

## Backup

```bash
npm run backup                  # ./backups/iso27001-{timestamp}/
npm run backup /path/to/dir     # custom destination
```

Online SQLite backup (no downtime), tar of `uploads/`, master.key, manifest. Schedule via cron and rsync offsite.

## Tests

```bash
npm test                # smoke + security + rbac
npm run test:security   # node:test — CSRF, XSS, auth gating, rbac matrix
npm run test:browser    # puppeteer crawler — every sidebar route, every button
```

- **Smoke** (21 assertions, bare-node): boots a fresh tmp DB, walks the wizard POST, history-snapshot insert, bulk-spawn priority derivation, SoA risk-linkage rendering. Discovers workspace IDs at runtime + auto-stamps CSRF tokens, so it survives schema changes.
- **Security** (10 tests, `node:test`): CSRF reject without token, accept with valid token + cookie, token stability across requests, distinct tokens per session, XSS escape on tenant name + attribute injection, default-user fallback contract.
- **Rbac** (13 tests, `node:test`): pins the role permission matrix. Catches accidental privilege grants and unreferenced permissions.
- **Browser crawler** (`tests/browser-ui.js`): puppeteer-core driving headless Chrome through every sidebar route. Counts buttons, clicks every non-submit, validates modals, captures screenshots, asserts no console / network / page errors. 40 pages, ~450 buttons.

## What's not in it (and why)

Deliberately out of scope. The tool is consultant-side; anything client-ops belongs in the client's own systems.

- Training records — auditors look at the awareness programme and a sample of staff, not your LMS
- Phishing-sim tracking — not part of any cert audit
- Document acknowledgement campaigns — paper exercise
- AI-assisted assessment / auto-classification
- Real-time integrations with Microsoft 365 / Google Workspace / cloud providers
- Multi-framework crosswalks (SOC 2 / NIST CSF / GDPR)
- KPI dashboards beyond what objectives + monitoring naturally produce

## What's still open

- Real auth. Not blocking single-user local use; required for anything multi-user. CSRF is wired and tested; routes know how to enforce permissions but the auth gate is currently disabled.
- Read-only client view so the client can see deliverables without editing consultant assessments.
- Cloud evidence integrations (AWS Config / GCP Asset Inventory / Azure Resource Graph). Today every piece of evidence is hand-uploaded.
- Continuous compliance flow — quarterly evidence re-attestation cadence with auto-spawned tasks.
- Industry overlay packs (pharma, fintech, legal, manufacturing). Pattern was prototyped and removed; concept is documented and trivial to restore.
- More route extraction. `routes/tenants.js` and `routes/engagement.js` proved the pattern (`register(app, deps)`); the rest of `server.js` can follow incrementally.

## Stack

Node 20+ · Express · EJS · better-sqlite3 · TinyMCE 6 (self-hosted) · html-to-docx · archiver · mammoth / pdf-parse · multer · bcrypt + express-session (auth wired but disabled). Tests use node:test plus puppeteer-core (drives the system Chrome — no bundled Chromium download). No frontend build step. Client-side JS does SPA-lite content swaps on same-origin nav — sidebar element stays in place, only the right pane re-renders, falls back to standard navigation on file downloads / failures / modifier-key clicks.

## Folder structure

```
.
├── server.js                       # Express app — most routes (extraction in progress)
├── db.js                           # Schema, migrations, content sync, seeding
├── data/                           # Content + templates (edit here, syncs on boot)
│   ├── iso-content.js              # Per-clause / control writeups (118 items)
│   ├── assessment-questions.js     # Diagnostic Y/P/N questions per item
│   ├── glossary.js                 # 168 GRC / ISO terms
│   ├── intake-questions.js         # 25-question scoping questionnaire
│   ├── engagement-plan.js          # 12-week project plan template
│   ├── playbooks.js                # Kickoff / scoping / risk workshop scripts
│   ├── risk-library.js             # 40 starter risks
│   └── policy-templates*.js        # ~70 document templates
├── routes/                         # Extracted route modules (register(app, deps))
│   ├── tenants.js                  # Firm CRUD + onboarding wizard
│   └── engagement.js               # Intake + 12-week plan
├── lib/
│   ├── encryption.js               # AES-256-GCM + HKDF
│   ├── csrf.js                     # Per-session token + validate middleware
│   ├── rbac.js                     # Permissions model (ready for auth-on)
│   └── ...
├── views/                          # EJS templates
├── scripts/backup.js               # Online backup
├── tests/
│   ├── smoke.test.js               # Smoke suite (21 bare-node assertions)
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
