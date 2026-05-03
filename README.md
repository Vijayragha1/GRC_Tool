# ISO 27001:2022 Implementation Tool — V3

A multi-tenant web app for consulting firms to drive their clients through ISO 27001 implementation, internal audit, management review, and certification.

## What it does

### Compliance Intelligence (V3)
- **Stage 1 & Stage 2 readiness scores** — weighted live KPIs visible on every workspace dashboard
- **Mandatory records detection** — 22 ISO 27001 documented information items auto-detected from your workspace data
- **Validation engine** — automatic detection of: controls marked Implemented without evidence, SoA-included controls without driving risk or justification, SoA-excluded controls without justification, open major NCs, overdue NCs, orphan risks, ownerless risks, stale access reviews
- **Annex A control specifications** — every one of the 93 controls populated with: applicability criteria, acceptable evidence types, common audit failure modes (audit-reference voice, not tutorial)
- **5×5 risk heatmap** — visual inherent-risk distribution by likelihood × impact

### Foundation
- **Multi-tenant**: one consulting firm, many client workspaces
- **Role-based access**: firm owner / consultant / lead consultant / client admin / contributor / reviewer
- **Full ISO 27001:2022 catalog**: 25 ISMS clauses (4–10) + 93 Annex A controls
- **Audit log** of every change — required certification evidence

### Implementation
- **Asset inventory** with CIA scoring
- **Risk register** with likelihood × impact, treatment, residual risk
- **Risk → control linkage** that auto-populates the SoA
- **Statement of Applicability** with inclusion/exclusion + justification
- **Per-control state**: status, maturity (0–5), owner, due date
- **Evidence upload** with SHA-256 integrity hashing
- **Tasks** with assignees and statuses
- **Comments** per control + per document, with consultant-only "internal" notes

### Certification Operations (V2)
- **Document Generation** — 15 ISO 27001 policy & procedure templates with auto-filled placeholders ({{client_name}}, {{scope}}, {{date}}, etc.). Markdown editor + live preview + print/PDF + autosave.
- **Internal Audit Module** (Clause 9.2) — audit programs, findings (Major NC / Minor NC / Observation / OFI), one-click promotion of findings to nonconformities
- **Management Review Module** (Clause 9.3) — meeting records with all required inputs (9.3.2) and outputs (9.3.3); auto-pulled context (open NCs, audit status, risk summary)
- **Nonconformity & CAPA** (Clause 10.2) — NC register, root-cause analysis, corrective action, effectiveness check, close-out
- **Framework Cross-Mapping** — Annex A controls mapped to SOC 2 (TSC), NIST CSF 2.0, GDPR Articles. 100+ mappings shipped.

### UX
- **Bulk control updates** — select multiple controls, update status/applicability/owner in one action
- **Autosave** on control fields — no more "did I forget to click save?"
- **Live activity feed** on workspace dashboard
- **Search + filter** on controls (by clause/control/category/needs-attention)
- **CSV exports** for SoA, Risk Register, Asset Inventory

## How to run

```bash
cd ~/iso27001-tool
npm start
```

Open: **http://localhost:3000**

First time? Click "Register here" to create your firm account.

## Workflow guide (consultant)

1. **Register your firm** — first user is the firm owner
2. **(Owner)** Add other consultants
3. **Create a client workspace** — one per engagement
4. In the workspace:
   - **Members** → invite client users
   - **Assets** → build inventory
   - **Risks** → identify, link to Annex A controls (auto-includes them in SoA)
   - **Documents** → generate policies from templates
   - **Controls** → assess each clause/control, attach evidence
   - **SoA** → review applicability + justifications
   - **Audits** → plan and run internal audits, promote findings to NCs
   - **MRM** → record management reviews
   - **NCs** → track corrective actions to closure
   - **Tasks** → assign work to consultants and client team
   - **Cross-map** → see which evidence also satisfies SOC 2 / NIST / GDPR
   - **Activity** → full audit trail

## Roles

| Role | Scope | Key abilities |
|---|---|---|
| Firm owner | All firm workspaces | Add/remove consultants, full edit on every workspace |
| Consultant | Firm workspaces | Full edit on every workspace |
| Lead consultant | One workspace | Same as consultant; the "owner" of that engagement |
| Client admin | One workspace | Edit everything in their workspace, invite contributors/reviewers |
| Contributor | One workspace | Upload evidence, edit assigned items, comment |
| Reviewer | One workspace | Read-only, can comment & approve |

## Document Generation

The 15 system templates ship with the app:

| Category | Templates |
|---|---|
| Policy | Information Security, Access Control, Acceptable Use, Incident Management, Cryptography, Supplier Security |
| Procedure | Risk Management, Backup & Restore, Asset Management, Internal Audit, Management Review, Document Control |
| Plan | Business Continuity, Awareness & Training |
| Record | Statement of Applicability (cover page) |

**To generate**: pick a template, fill three fields (document owner, approval authority, review period), click Generate. The tool auto-fills `{{client_name}}`, `{{scope}}`, `{{date}}`, `{{firm_name}}`, etc., and produces a Markdown document you can edit, version, approve, and print to PDF.

## Framework Cross-Mapping

Each Annex A control is mapped to equivalent requirements in:
- **SOC 2** (Trust Services Criteria — CC, A, P series)
- **NIST CSF 2.0** (GV / ID / PR / DE / RS / RC functions)
- **GDPR** (Article references)

The cross-map view tells your client: "evidence collected here satisfies these other audits too."

## Reset / fresh start

```bash
rm iso27001.db iso27001.db-wal iso27001.db-shm
rm -rf uploads/*
npm start
```

## What's still NOT in (V3 candidates)

- **Cryptographic e-signatures** with HSM integration (currently: status-based approval + audit log)
- **Email notifications** (currently: in-app activity feed)
- **Native .docx / .pdf export** (currently: print-to-PDF from browser, .md download)
- **Vendor / supplier risk register** (use the manual NC + supplier policy template for now)
- **Training tracker** (use the awareness training plan template + tasks for now)
- **Incident log** (use the NC module with source = "incident")
- **White-label branding** per firm
- **LDAP / SSO**
- **Time tracking** for engagements

## Tech stack

- Node.js + Express
- SQLite (better-sqlite3)
- EJS templates + Tailwind CSS via CDN
- bcrypt + express-session for auth
- multer for uploads
- ~3,500 lines of code total

## Folder structure

```
iso27001-tool/
├── server.js              # Express app — all routes
├── db.js                  # Schema + seed
├── data/
│   ├── iso-catalog.js     # Clauses + Annex A
│   ├── policy-templates.js  # 15 starter policies
│   └── framework-mappings.js  # SOC 2 / NIST / GDPR mappings
├── views/                 # EJS templates (15+)
├── public/
├── uploads/               # evidence files
├── iso27001.db            # SQLite (auto-created)
└── package.json
```
