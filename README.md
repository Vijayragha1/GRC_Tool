# ISO 27001:2022 Implementation Tool

A self-hosted web app for taking an organization through ISO 27001:2022 implementation, internal audit, management review, and certification. Built around the auditor-evidence workflow rather than process orchestration: the artefacts an ISO 27001 auditor actually opens during a Stage 2 visit are first-class; everything else is supporting.

Single-binary install (Node + SQLite + EJS), no cloud dependencies, encryption at rest for sensitive fields.

## Status

- **Auth is currently disabled** — the tool runs in single-user-per-tenant local mode. Real auth (login, session enforcement, RBAC at the route level) is on the deferred list. If this leaves your machine, that's the work to do first.
- **Suitable for**: walking through gap assessments and SoA decisions, drafting documents, capturing evidence, dogfooding the workflow.
- **Not yet suitable for**: production multi-user engagements over the network. CSRF, XSS sanitization, and per-user audit attribution all depend on real auth being on.

## What it does

### Audit-grade content for every clause and control

All **118 ISO 27001:2022 items** (25 main-body clauses + 93 Annex A controls) are written up in [data/iso-content.js](data/iso-content.js) with a structured shape:

- **Purpose** — what the clause/control is actually trying to achieve, in plain English
- **What good looks like** — a credible mid-size-org implementation
- **Where this usually goes wrong** — real audit-finding patterns
- **Evidence the auditor will ask for** — concrete artefacts and what each tells the auditor
- **Scoping notes** — common carve-outs and structure decisions
- **Maturity ladder** — concrete description per CMMI level (1–4)
- **Related items** — cross-references to other clauses/controls

This is the spine of the wizard. Edits go in `data/iso-content.js`; the migration syncs them into `iso_items` columns on every server restart.

### PDCA-aligned implementation roadmap

The workspace overview shows an 18-step roadmap mapped to the ISO 27001:2022 PDCA structure:

- **Plan** (clauses 4–7): scope, context (4.1 + 4.2), policy, roles, objectives, methodology, asset register, gap assessment, risks, SoA, awareness/competence/comms, mandatory documented information
- **Do** (clause 8): implement Annex A controls, run supplier security operationally
- **Check** (clause 9): monitoring, internal audit, management review
- **Act** (clause 10): nonconformity + corrective action

Each step has a tracked completion signal — workspace data, registered records, or approved-document detection where there's no dedicated module.

### Gap-assessment wizard

- Walks all 25 clauses + 93 Annex A controls one item at a time, in audit order
- Per-item diagnostic questions (Yes / Partial / No) — bespoke per item, not generic checklist text
- Heuristic status hint computed from answers; user always sets the final status
- Scope-of-implementation slider (0–100%) — captures partial coverage that pure status hides
- Append-only history snapshot per save → `control_state_history`
- Bulk-spawn remediation tasks from the post-assessment summary, with auto-derived priority (critical / high / normal / low) based on gap severity × max linked-risk score
- Pre-fill notes from gap answers, evidence upload, linked risks/documents/NCs all in the same view

### Statement of Applicability that's audit-defensible

- Every "included" control surfaces the actual risks treating it (R-12, R-19) inline, satisfying the 6.1.3.d.1 requirement that controls be derived from risks
- Bare "included" controls with no linked risk are flagged `unjustified`
- CSV export includes the risk-treatment chain

### Risk register

- Risks linked to assets, threats, vulnerabilities
- Risk methodology (likelihood/impact scales, acceptance criteria, matrix) configurable per workspace
- Starter library of 40 pre-written ISO 27001 risks across 11 domains
- Risk-control linkage drives the SoA

### Document management

- Word-like WYSIWYG editor (TinyMCE) with full inline formatting
- Upload existing client docs (DOCX / PDF / MD / TXT) — original preserved as audit-source-of-truth, content extracted to editable HTML
- ~70 ISO 27001 policy/procedure templates seeded
- Approval workflow (draft → in_review → approved)
- Document-control linkage drives "Covered by" data on the SoA
- Native DOCX export

### Other modules

- **Asset register** with classification and ownership
- **Suppliers** with risk tiering, security review tracking, document attachments
- **Internal audit** records (programme + per-audit findings)
- **Management review** records with all 9.3.2 inputs auto-pulled from workspace data
- **Nonconformities + corrective actions** with task linkage
- **Pre-cert blocker check** — surfaces the things that will fail Stage 2

### Multitenancy

- Each tenant (firm) has its own workspaces, users, evidence storage, audit log
- Tenant switcher in the topbar; tenant management page at `/tenants`
- Per-tenant uploads partitioning at `uploads/firm_{id}/` with legacy fallback
- Workspace-scoped field-level encryption (AES-256-GCM, HKDF-derived per-workspace keys, master key in `data/master.key`)

## Quick start

```bash
git clone https://github.com/Vijayragha1/GRC_Tool.git
cd GRC_Tool
npm install
npm start
```

Open **http://localhost:3000**. First boot creates the database, seeds ISO 27001 content + document templates, and generates an encryption master key at `data/master.key` (mode 0600 — back this up; losing it makes encrypted document content unrecoverable).

A default tenant ("My firm") and workspace ("Acme") are seeded so you can start exploring immediately.

## Daily workflow

1. **Top of overview** → walk the PDCA roadmap. Each step links to the page that moves it forward.
2. **Gap assessment** → walk every clause + Annex A control once. Status, scope %, notes; save & next.
3. **Risks** → identify, score, link to relevant Annex A controls.
4. **SoA** → review applicability decisions; check that every included control traces back to a risk.
5. **Documents** → generate policies from templates, edit, approve.
6. **Evidence** → upload per control via the wizard's Evidence panel.
7. **Internal audit + MRM** → record per the standard's input/output requirements.
8. **NCs** → track to closure with root-cause analysis.

## Editing the content

To refine a clause or control's audit-grade content:

1. Open [data/iso-content.js](data/iso-content.js)
2. Find the entry by id (`clause-9.3`, `annex-a.5.15`, etc.)
3. Edit the `purpose`, `what_good_looks_like`, `common_pitfalls`, etc.
4. Restart the server — changes propagate automatically via the boot-time sync

Diagnostic questions live in [data/assessment-questions.js](data/assessment-questions.js) keyed by the same ids.

## Backup

```bash
npm run backup                  # writes to ./backups/iso27001-{timestamp}/
npm run backup /path/to/dir     # custom destination
```

Online SQLite backup (no downtime) + tar of `uploads/` + master.key + manifest. Schedule via cron and rsync the output offsite.

## Tests

```bash
npm test
```

Bare-node smoke tests (no framework dependency) covering boot, wizard POST, history-snapshot insert, bulk-spawn priority derivation, SoA risk-linkage rendering. 21 assertions; runs in a fresh tmp directory so the live database isn't touched.

## Tech stack

- Node.js + Express + EJS
- SQLite via better-sqlite3 (single file, no migration tooling, schema declared inline in [db.js](db.js))
- TinyMCE 6 (GPL self-hosted) for the document editor
- mammoth / pdf-parse for DOCX/PDF extraction
- bcrypt + express-session (currently auth-disabled; framework wired in for when it's enabled)
- multer for uploads, with per-tenant disk-storage partitioning
- AES-256-GCM field encryption with per-workspace HKDF-derived keys
- No frontend build step — server-rendered EJS, vanilla JS where interactivity is needed

## Folder structure

```
.
├── server.js                       # Express app — all routes
├── db.js                           # Schema, migrations, content sync, seeding
├── data/
│   ├── iso-content.js              # Audit-grade content for all 118 items
│   ├── assessment-questions.js     # Per-item diagnostic questions
│   ├── risk-library.js             # Starter library of 40 ISO 27001 risks
│   └── ...                         # Catalog, policy templates, methodology presets
├── lib/
│   ├── encryption.js               # AES-256-GCM + HKDF
│   ├── rbac.js                     # Permissions model (ready for auth-on)
│   └── ...
├── views/                          # EJS templates
│   ├── workspace.ejs               # Overview with PDCA roadmap
│   ├── controls_assess.ejs         # The wizard (= canonical control page)
│   ├── controls_assess_summary.ejs # Post-assessment worklist
│   ├── soa.ejs                     # Statement of Applicability
│   ├── tenants.ejs                 # Tenant management
│   ├── partials/header.ejs         # Topbar incl. tenant switcher
│   └── ...
├── scripts/
│   └── backup.js                   # Online backup
├── tests/
│   └── smoke.test.js               # Bare-node smoke suite
├── public/                         # Static assets, TinyMCE bundle
├── uploads/                        # Evidence files (partitioned per firm)
└── data/master.key                 # Encryption master key (auto-generated, 0600)
```

## What's intentionally NOT in scope

The tool has been deliberately pruned to focus on auditor-evidence workflows. The following are out of scope by design — re-add only if there's clear engagement value:

- Real-time integrations with Microsoft 365 / Google Workspace / cloud providers (out of roadmap)
- AI-assisted assessment / auto-classification (out of roadmap)
- Training-record tracking (zero value at audit; record-keeping outside the tool)
- Phishing-simulation tracking (not part of any cert audit)
- Document acknowledgement campaigns (paper exercise; auditors look at the policy + sample staff)
- DPIAs / GDPR-specific privacy modules (privacy is its own discipline)
- KRIs / KPI dashboards beyond what monitoring + objectives produce naturally
- Cross-framework mapping (SOC 2 / NIST CSF / GDPR) — was in V2, removed; reintroduce if a real customer needs it

## What I'd build next

In priority order:

1. **Risk treatment plan as a tracked workflow** (clause 6.1.3) — actions, owners, due dates, residual-risk re-evaluation. The single biggest correctness gap against the standard.
2. **Evidence expiry / freshness tracking** — auditors care that evidence is current; the tool should warn on expiring items.
3. **Surveillance audit cadence calendar** — Stage 1 → Stage 2 → annual surveillance → 3-year recertification.
4. **Internal audit lifecycle** — currently just metadata; needs plan → fieldwork → findings → report → follow-up.
5. **MRM creation pre-fills the 9.3.2 input pack** automatically.
6. **Audit-log drill-down view** — the data is being written; just no UI.
7. **Real auth** — the elephant. Required for any deployment beyond a single user.

## License

Private — repository is for personal / engagement use. Not currently open-sourced.
