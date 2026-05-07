# ISO 27001 tool

Self-hosted web app for running ISO 27001:2022 engagements. Built around the way I actually work — assess gaps, write up recommendations, hand off to the client, return to re-assess, produce the deliverables a certification audit asks for.

Stack: Node + SQLite + EJS. No cloud, no build step, single binary worth of moving parts.

## Status

Auth is off. The tool runs in single-user-per-tenant local mode. Fine for personal use and engagements you run on your own machine. Don't put it on the open internet until login is wired up.

Most of what's here exists because I needed it on a real engagement and it wasn't there.

## The engagement flow it supports

```
new engagement
  → set scope, interested parties, objectives
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

### Audit-grade content for every clause and control

All 118 items written up in [data/iso-content.js](data/iso-content.js): purpose, what good looks like, where it usually goes wrong, evidence to gather, scoping notes, maturity ladder. Edits go in the file and sync into the database on boot.

### Other modules

Asset register · risk register with starter library of 40 ISO 27001 risks · risk methodology (configurable scales / criteria) · document management with WYSIWYG editor + DOCX export and ~70 policy templates · internal audit programme · management review with auto-pulled 9.3.2 inputs · nonconformities + corrective actions · incidents · suppliers with risk tiering · tasks · compliance calendar · 168-term glossary with cross-links and clickable clause references · cross-client at-risk dashboard.

### Multitenancy + security

Each tenant has its own workspaces, users, evidence storage, audit log. Tenant switcher in the topbar. Per-tenant uploads partitioning. Field-level encryption (AES-256-GCM, HKDF-derived per-workspace keys, master key in `data/master.key`).

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
npm test
```

21 bare-node smoke assertions. Boots a fresh tmp DB so the live one isn't touched. Covers the wizard POST, history-snapshot insert, bulk-spawn priority derivation, SoA risk-linkage rendering.

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

- Real auth. Not blocking single-user local use; required for anything multi-user.
- Read-only client view so the client can see deliverables without editing consultant assessments.
- Calendar integration (iCal export of audits / MRMs / reviews).
- Email / Slack digest of overdue items.

## Stack

Node 20+ · Express · EJS · better-sqlite3 · TinyMCE 6 (self-hosted) · html-to-docx · archiver · mammoth / pdf-parse · multer · bcrypt + express-session (wired but disabled). No frontend build step.

## Folder structure

```
.
├── server.js                       # Express app — all routes
├── db.js                           # Schema, migrations, content sync, seeding
├── data/                           # Content + templates (edit here, syncs on boot)
├── lib/
│   ├── encryption.js               # AES-256-GCM + HKDF
│   ├── rbac.js                     # Permissions model (ready for auth-on)
│   └── ...
├── views/                          # EJS templates
├── scripts/backup.js               # Online backup
├── tests/smoke.test.js             # Smoke suite
├── public/                         # Static assets, TinyMCE bundle
├── uploads/firm_{id}/              # Evidence files (per-tenant partitioned)
└── data/master.key                 # Encryption master key (auto-generated, 0600)
```

## License

Private. Not currently open-sourced.
