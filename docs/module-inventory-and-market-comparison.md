# Compliance Sphere — Module Inventory & Market Comparison

**Purpose:** a complete inventory of what this tool does today, followed by a
capability-by-capability comparison against the compliance-automation and GRC
platforms it will be measured against in a sales conversation.

**Two parts:**
1. [Part 1 — Module inventory](#part-1--module-inventory) (what's built, by area)
2. [Part 2 — Market comparison](#part-2--market-comparison) (what's there and what isn't, vs Drata / Vanta / Apptega / others)

> **Accuracy note on Part 2.** Capabilities attributed to competitor products are
> drawn from general product knowledge as of early-to-mid 2026. These platforms
> ship monthly and reposition constantly — ISO 42001 support in particular moved
> fast across the whole market. **Verify anything you intend to put in a client
> proposal or an RFP response against the vendor's current documentation.** The
> Compliance Sphere column is authoritative; it was derived from the codebase.

---

# Part 1 — Module inventory

## Positioning in one line

Compliance Sphere is **consultant-side engagement tooling** for running ISO 27001
(and ISO 42001 / NIST CSF) certification programmes end to end — not a
continuous-monitoring platform that plugs into a client's cloud estate. That
distinction drives nearly every difference in Part 2.

Supported frameworks are a closed set of three (`lib/frameworks.js`):
`iso27001`, `iso42001`, `csf`. Frameworks are enabled per workspace.

---

## A. Engagement scaffolding — the consultant layer

The part with no equivalent in the compliance-automation category.

| Module | Route | What it does |
|---|---|---|
| **Engagement intake** | `/workspaces/:id/intake` | 25-question scoping questionnaire across 6 sections (business context, scope, organisation, interested parties, crown jewels, existing posture). Each question tagged to the clause it feeds. Auto-drafts the clause 4.3 scope statement and seeds the interested-parties register in one click. |
| **12-week engagement plan** | `/workspaces/:id/engagement-plan` | Pre-loaded roadmap from kickoff to Stage 2 readiness. Timed milestones with deliverables and clause tags, click-to-toggle completion, per-phase progress bars. |
| **Facilitator playbooks** | `/playbooks` | Three timed, scripted workshop scripts — Kickoff (60 min), Scoping (90 min), Risk assessment (90 min). Segment-by-segment prompts, decisions to leave with, watch-outs. Print-friendly. |
| **Engagement team setup** | `/workspaces/:id/team` | Pick lead + senior + consultants; invite client owner, ISMS manager, contributors. |
| **Pass model** | throughout | A "pass" is one round of consultant assessment. Pass 1 = initial gap, Pass 2+ = re-assessment. Saves are tagged to the active pass, so any two passes can be diffed per control (improved / regressed / unchanged). Notes are scoped per pass. |
| **Firm content library** | `/firm/library` | The firm's own curated content, separate from shipped defaults, cloned into each new engagement. Today: firm risk library (59-entry starter set auto-copied to new firms), with stubs for policy templates and control narratives. |
| **Portfolio view** | dashboard | Across all engagements in the firm: every overdue item and every item due this week (tasks, NCs, audits, MRMs), with per-client roll-up. |
| **Per-client branding** | workspace settings | Brand display name, primary colour (server-validated hex), logo URL, sector. Renders as the sidebar accent rail and on deliverables. |

---

## B. Frameworks, assessment & content

| Module | Detail |
|---|---|
| **ISO 27001:2022** | All 25 main-body clauses + 93 Annex A controls, walked in audit order. Per-item Yes/Partial/No diagnostic questions compute a status hint; consultant sets final status. Append-only history snapshot per save. |
| **Gap assessment** | Heatmap by Annex A theme (Organizational / People / Physical / Technological). Trend chart of average maturity per theme across passes. Re-engagement orientation panel showing what changed since the last pass closed. Left-rail theme-jump navigator with per-theme completion meters. |
| **Statement of Applicability** | All 93 controls, inclusion/exclusion + justification. Risks treating each control surfaced inline (the 6.1.3.d.1 trace). Custom non-Annex-A controls supported. Metadata header (version/owner/approver/approved-on). Auto-justify from linked risks. Snapshot history with diffs. Per-row autosave plus batch save. |
| **ISO 42001 (AI management)** | Full parallel module: catalog, controls, SoA + snapshots + snapshot diff, gap assessment + detail, readiness + blockers, roadmap, certification cycle, exec brief, intake. |
| **NIST CSF 2.0** | Catalog, engagements, assessments + detail, scoring, findings, version management with version diff, client portal, analyst learning content. |
| **Crosswalks** | `/workspaces/:id/crosswalks` — ISO 27001 Annex A mapped to SOC 2 Trust Services Criteria, NIST CSF 2.0 subcategories, and GDPR Articles (`data/framework-mappings.js`). Reference mappings, not assessable frameworks in their own right. |
| **Audit-grade content** | All 118 ISO 27001 items written up in `data/iso-content.js`: purpose, what good looks like, **minimum certifiable** (smallest version that still passes Stage 2), where it usually goes wrong, evidence to gather, scoping notes, maturity ladder. |
| **Content provenance gate** | `data/content-meta.js` records what each source was last reviewed against (standard editions, amendments, IAF guidance) + next-review date. `npm run content-staleness` exits non-zero on overdue content — a CI gate against silent drift. |
| **Glossary** | 168 GRC/ISO terms with inline expand and deep-link detail pages. |

---

## C. Registers & operational modules

| Module | Notes |
|---|---|
| **Risk register** | 59-entry starter library (ISO 27001 + AI/ML + software supply chain + cloud config + regulatory change). Guided assessment, risk detail, treatments, acceptances (with clause 6.1.3.g DOCX export), appetite, configurable methodology (scales/criteria presets). |
| **Asset register** | With asset detail pages and CSV import. |
| **Supplier risk management** | Vendor register with risk tiering, vendor detail, questionnaires. Templates inspired by SIG Lite / CAIQ plus privacy questionnaires. External respondents answer via time-bound magic link — no account needed. |
| **Internal audit programme** | Audit programme, audits, findings, timeline. **SoA-driven checklist generator** (one observation per applicable control, with sample-size hints, linked-policy/evidence counts, finding-wording template) alongside a category-based generator; both dedupe on re-run. Inline checklist UI with per-row auditor notes, filter pills, promote-to-finding, mark-closed/reopen. |
| **Management review (9.3)** | All **6 of 6 Clause 9.3.2 inputs auto-populated on creation** (prior actions, context changes, performance, interested-party feedback, risk treatment, improvements), with a preview panel on the create form. |
| **Nonconformities & CAPA** | NC register + detail with corrective actions. |
| **Incidents** | Incident register + detail, with response runbooks (ransomware, etc.). |
| **Improvements** | Continual-improvement register (clause 10). |
| **Registers (4.2 / 6.2)** | Interested parties (party, type, needs, how addressed, owner, review cadence). Information security objectives (title, measurement, target, current, owner, due, status). Both surface overdue rows and feed the readiness pack. |
| **Change management** | Change register + change detail. |
| **Access reviews** | Access review campaigns + detail. |
| **BCP & BIA** | Business continuity and business impact analysis, with plan detail pages. |
| **Training / competence / communication** | Clause 7.2 / 7.3 / 7.4. Training tracker (courses, validity months, required-for roles, optional quiz, records, completion KPI, overdue list, per-role coverage). Competence matrix (roles → required competences, per-person evidence, expiry). Communication plan (what/audience/channel/frequency/owner/next-due/trigger). |
| **Tasks** | Task register with reusable task templates (onboarding, offboarding, etc.). |
| **Compliance calendar** | Training, comms, competence, supplier reviews, BCP, ISO 42001 cert cycle woven together. Manager calendar view. |
| **ISMS metrics** | ISO/IEC 27004:2016 Annex B — 36 standardised measures as an adoptable library, plus metrics-adopted tracking, targets, readings over time, and metric detail. |
| **Performance dashboard** | Implementation %, evidence coverage %, NC closure rate (90/180d), risk-acceptance velocity, audit findings open/closed, MRM action-closure rate, document review-age distribution. Each tile has a one-click **"feed into next MRM"** that appends a timestamped snapshot into the upcoming management review's 9.3.2(c) input. |
| **Continuous control monitoring** | `data/ccm-rules.js` + `lib/ccm.js`. Rules evaluated against the tool's own state (SQL-count assertions and similar), producing pass/fail/warn results that feed the readiness flag stream. **Internal-state monitoring — not cloud/SaaS integration.** |
| **Readiness scoring** | Stage 1 / Stage 2 readiness scorecard, blockers view, readiness overview, auditor-facing readiness view. **Prioritized actions** scores each fixable item (open NCs, not-implemented controls, missing mandatory docs, first MRM, first audit) by lift ÷ effort, showing current readiness → top-5 fixed → top-10 fixed with cumulative running total. |

---

## D. Documents & evidence

| Module | Notes |
|---|---|
| **Document management** | WYSIWYG editor (self-hosted TinyMCE 6), versioning, version diff, DOCX export, print view, document tree, review-due snooze with audit-trailed reason. |
| **Approval workflow** | Policy submission emails each approver in turn; every sign-off advances the chain; approval or rejection emails the submitter with chain summary or reason. External approvers use one-shot magic links — never accounts. |
| **Policy template library** | 74 ISO 27001:2022-aligned policy + procedure starters, tiered mandatory ★ / expected ◆ / recommended ·. Annex A control references extracted at boot, so adopting a template auto-links every referenced control. "Adopt all mandatory" covers the 10 ISO-required documents in one click; preview renders markdown with client-name substitution before adoption. |
| **Policy adoption dashboard** | Per template: adopted or not, status (draft / pending review / approved), version, owner, last review date, count of controls covered. "Still missing" panel. |
| **Evidence library** | Upload once, link to many controls. SHA-256 dedupe. Versioning via supersede (old version stays in the audit trail). Bulk upload with shared metadata. Per-link sub-clause references. Tags. Expiry tracking. |
| **Evidence coverage matrix** | One row per Annex A control: applicability, status, evidence count, last-evidence date, linked-policy count, days since last evidence. Flags "Implemented with 0 evidence" in red — the most common Stage 2 finding. CSV export. |
| **CSV import** | Assets and risks. Drag-drop, per-row validation (header synonyms, methodology-aware likelihood/impact ranges, asset-name resolution), preview, then commit valid rows in one transaction. Downloadable template with example rows. |
| **Full-text search** | `lib/fts.js` — cross-entity search. |

---

## E. Deliverables & reporting

| Deliverable | Format | Notes |
|---|---|---|
| **ISMS Audit Pack** | PDF | The headline artefact. Puppeteer-rendered from a print-optimised template: branded cover, exec summary, full SoA snapshot with SHA-256 hash, risk register + heatmap, evidence index with per-file hashes, internal audit findings, NCs, MRMs, improvements, audit-trail tail. Section toggles + brand overrides on a config page. |
| **Audit Pack companion** | ZIP | Raw CSVs + DOCX + evidence files, for auditors who want to grep. |
| **Gap Assessment Report** | DOCX | Per pass: exec summary, gaps identified, full results. |
| **Recommendations memo** | DOCX | Ranked remediation list with consultant notes. |
| **Risk Treatment Plan** | DOCX | Clause 6.1.3.e — risks with treatment, owner, controls, actions. |
| **Risk acceptance record** | DOCX | Clause 6.1.3.g audit artefact. |
| **Stage 1 / 2 readiness pack** | ZIP | SoA + RTP + audits + MRMs + parties + objectives + evidence manifest + every active evidence file. |
| **Executive brief** | HTML / A4 print | One-page sponsor summary: Stage 1/2 readiness, velocity (controls implemented last 30d vs prior 30d), residual ALE estimate, top-5 risks, top-5 NCs. |
| **Custom reports** | Markdown → rendered | Report builder with templates and `{{placeholders}}` resolved against workspace/controls/risks/NCs/audits/MRMs/suppliers context. |
| **Deliverables hub** | — | One canonical home grouping every export semantically: for the certification body, for internal stakeholders, and raw data. |
| **Raw exports** | CSV | SoA, risks, assets, evidence coverage, ISO 42001 SoA. |

---

## F. External access

| Surface | Mechanism |
|---|---|
| **Auditor portal** | Time-bound magic link (`/auditor/{token}`). No account, no email setup. Stripped-chrome read-only portal: cover letter with Roman-numeral TOC, SoA (current or any snapshot), risk register + heatmap, evidence index with per-file download, policies + procedures with control mappings, internal audits + NCs, on-demand audit-pack PDF regen. Every access timestamped and logged; revocable at any time. |
| **External approvers** | One-shot magic links at `/approve/:token` for auditors and supplier reviewers. |
| **Supplier questionnaire respondents** | External questionnaire link — vendor answers without an account. |
| **CSF client portal** | Read-only CSF engagement view for client-side stakeholders. |

---

## G. Platform, security & operations

| Area | Detail |
|---|---|
| **Multitenancy** | Each firm has its own workspaces, users, evidence storage, audit log. Per-tenant uploads partitioning (`uploads/firm_{id}/`). Tenant switcher appears only when more than one firm exists. |
| **RBAC** | Six roles — firm side: Manager, Senior consultant, Consultant; client side: Client owner, ISMS manager, Contributor. ~50 individual permissions with per-workspace per-user overrides and an audit-trail reason field (`/workspaces/:id/access`). Permission lookup tool. |
| **User provisioning** | `/admin/users` (firm-wide) and `/workspaces/:id/team` (per engagement). Email invite with one-time link (7-day expiry) or admin-created temp password. Inline firm-role edit with last-active-manager and self-edit guards. Deactivate / reactivate. Duplicate detection turns collisions into inline actions (send reset / reactivate / replace pending invite) instead of errors. |
| **Authentication** | Email + password (bcrypt cost 12), session regeneration on privilege change, remember-me, forgot-password, brute-force lockout (8 fails / 15 min / email). |
| **Encryption** | Field-level AES-256-GCM with HKDF-derived per-workspace keys; master key in `data/master.key` or `ISMS_MASTER_KEY`. |
| **CSRF** | On every state-changing request. Token rotated per session, validated against body / `X-CSRF-Token` header / query string, auto-stamped into every form including dynamic and multipart. |
| **Audit trail** | Activity log with tabs for Log / Timeline / Anomalies / **Verify (hash-chain integrity)**. |
| **Email** | Three providers auto-selected in order — Brevo (HTTP API), Gmail SMTP, Resend (HTTP API) — with a dev fallback that writes to `data/email-dev-outbox.log` while still recording the `email_outbox` row. Per-firm branded From/Reply-to, on/off switch, test send, 50-row outbox log for deliverability triage. |
| **Backup** | `scripts/backup.js` (online SQLite backup + uploads tar), `scripts/restore-check.js`, daily cron in the Lightsail deployment. |
| **Deployment** | Docker + Nginx + Let's Encrypt on a single VM. `deploy/lightsail-setup.sh`, `ssl-setup.sh`, `update.sh`. Self-hosted, no cloud dependency. |
| **Testing** | Smoke suite, security tests (CSRF/XSS/auth), RBAC permission matrix, Puppeteer UI crawler over ~40 pages / ~450 buttons. |

---

# Part 2 — Market comparison

## The category problem

These products are not the same kind of thing, and a feature table flatters or
punishes them unfairly unless that's stated up front:

- **Drata, Vanta** — *compliance automation*. Sold to the company being audited.
  Core value is integrations that pull evidence out of AWS/Okta/GitHub/HRIS
  automatically and monitor controls continuously. Consultants use them via
  partner programmes, but the buyer is the client.
- **Apptega** — *MSSP/consultant-oriented GRC*. Closest positional peer to
  Compliance Sphere. Multi-client portfolio, framework crosswalking, scorecards.
- **Eramba** — *self-hosted open-source GRC*. Same deployment model as
  Compliance Sphere, broader generic GRC, no consultant engagement layer.
- **Compliance Sphere** — *consultant engagement tooling*. The unit of work is an
  engagement with passes and deliverables, not a continuously monitored estate.

## Legend

✅ Full capability · ◐ Partial / limited · ❌ Not present

## Comparison matrix

| Capability | Compliance Sphere | Drata | Vanta | Apptega | Eramba |
|---|---|---|---|---|---|
| **FRAMEWORKS** ||||||
| ISO 27001:2022 | ✅ 118 items, audit-order | ✅ | ✅ | ✅ | ✅ |
| ISO 42001 (AI) | ✅ full parallel module | ✅ | ✅ | ◐ | ◐ import |
| NIST CSF 2.0 | ✅ scoring + versioning | ✅ | ✅ | ✅ | ◐ import |
| SOC 2 | ❌ crosswalk refs only | ✅ | ✅ | ✅ | ◐ import |
| GDPR / privacy | ❌ crosswalk refs only | ✅ | ✅ | ✅ | ◐ import |
| PCI DSS / HIPAA / CMMC / others | ❌ | ✅ | ✅ | ✅ 25+ | ◐ import |
| Total assessable frameworks | **3** | 20+ | 35+ | 25+ | user-defined |
| Cross-framework crosswalk | ◐ reference map | ✅ | ✅ | ✅ flagship | ✅ |
| **ASSESSMENT & DELIVERY** ||||||
| Gap assessment with pass-over-pass diff | ✅ **distinctive** | ◐ | ◐ | ◐ | ❌ |
| "Minimum certifiable" guidance per item | ✅ **rare** | ❌ | ❌ | ❌ | ❌ |
| Statement of Applicability + snapshots | ✅ | ✅ | ✅ | ◐ | ✅ |
| Maturity ladder / scoring | ✅ | ◐ | ◐ | ✅ | ✅ |
| Readiness scoring + prioritised actions | ✅ lift÷effort | ✅ | ✅ | ✅ | ❌ |
| **AUTOMATION — the category gap** ||||||
| Cloud/SaaS integrations (AWS, Okta, GitHub, HRIS…) | ❌ **none** | ✅ 100+ | ✅ 300+ | ◐ some | ❌ |
| Automated evidence collection | ❌ all manual upload | ✅ | ✅ | ◐ | ❌ |
| Continuous control monitoring | ◐ internal state only | ✅ live infra | ✅ live infra | ◐ | ◐ |
| Personnel automation (onboarding, background checks, awareness training delivery) | ❌ | ✅ | ✅ | ❌ | ❌ |
| Automated security questionnaire answering | ❌ | ✅ | ✅ | ❌ | ❌ |
| **REGISTERS & OPERATIONS** ||||||
| Risk register + configurable methodology | ✅ + 59-risk library | ✅ | ✅ | ✅ | ✅ strong |
| Asset register | ✅ | ◐ via integrations | ◐ via integrations | ◐ | ✅ |
| Vendor/supplier risk + questionnaires | ✅ + external links | ✅ | ✅ | ◐ | ✅ |
| Policy templates + lifecycle + approvals | ✅ 74 templates | ✅ | ✅ | ✅ | ✅ |
| Evidence library (dedupe, supersede, expiry) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Access reviews | ✅ | ✅ automated | ✅ automated | ❌ | ◐ |
| Incident management + runbooks | ✅ | ◐ | ◐ | ◐ | ✅ |
| BCP / BIA | ✅ | ❌ | ❌ | ◐ | ✅ |
| Change management register | ✅ | ◐ | ◐ | ❌ | ✅ |
| Training / competence / communication (7.2–7.4) | ✅ all three | ◐ training only | ◐ training only | ❌ | ◐ |
| **ISO MANAGEMENT-SYSTEM MECHANICS** ||||||
| Internal audit programme + checklist generator | ✅ SoA-driven | ◐ | ◐ | ◐ | ✅ |
| Management review with 9.3.2 auto-population | ✅ **6 of 6 inputs** | ❌ | ❌ | ❌ | ◐ |
| Nonconformities + corrective actions | ✅ | ◐ | ◐ | ◐ | ✅ |
| ISO 27004 metrics library | ✅ 36 measures | ❌ | ❌ | ❌ | ◐ |
| Interested parties (4.2) + objectives (6.2) | ✅ | ❌ | ❌ | ❌ | ◐ |
| **DELIVERABLES** ||||||
| Branded audit-pack PDF | ✅ **distinctive** | ◐ | ◐ | ✅ reports | ◐ |
| DOCX consultant deliverables (gap report, RTP, memo) | ✅ | ❌ | ❌ | ◐ | ◐ |
| Executive brief / board pack | ✅ | ✅ | ✅ | ✅ | ◐ |
| Custom report builder | ✅ | ◐ | ◐ | ✅ | ✅ |
| **EXTERNAL & CLIENT SURFACES** ||||||
| Auditor portal (read-only, time-bound) | ✅ magic link | ✅ Audit Hub | ✅ | ◐ | ◐ |
| Public trust center | ❌ | ✅ | ✅ | ❌ | ❌ |
| Read-write client portal | ❌ | ✅ | ✅ | ✅ | ◐ |
| Auditor marketplace / referral network | ❌ | ✅ | ✅ | ◐ | ❌ |
| **CONSULTANT / MSP LAYER** ||||||
| Multi-client portfolio view | ✅ | ◐ partner portal | ◐ partner portal | ✅ flagship | ◐ |
| Engagement intake → scope auto-draft | ✅ **unique** | ❌ | ❌ | ❌ | ❌ |
| 12-week engagement plan template | ✅ **unique** | ❌ | ❌ | ❌ | ❌ |
| Facilitator workshop playbooks | ✅ **unique** | ❌ | ❌ | ❌ | ❌ |
| Firm content library cloned per engagement | ✅ | ❌ | ❌ | ◐ | ❌ |
| Per-client branding on deliverables | ✅ | ◐ | ◐ | ✅ | ❌ |
| Time tracking / billing per engagement | ❌ | ❌ | ❌ | ❌ | ❌ |
| **PLATFORM** ||||||
| Self-hosted / full data residency | ✅ **distinctive** | ❌ SaaS only | ❌ SaaS only | ❌ SaaS only | ✅ |
| SSO (SAML / OIDC) | ❌ | ✅ | ✅ | ✅ | ✅ enterprise |
| REST API | ❌ | ✅ | ✅ | ✅ | ✅ |
| Field-level encryption at rest | ✅ AES-256-GCM | ◐ platform-level | ◐ platform-level | ◐ | ◐ |
| Hash-chain audit trail with verification | ✅ **rare** | ◐ | ◐ | ◐ | ◐ |
| Mobile app | ❌ | ◐ | ◐ | ✅ | ❌ |
| Pricing model | self-hosted, no per-seat | SaaS subscription | SaaS subscription | SaaS subscription | open-source + paid support |

---

## Where Compliance Sphere genuinely wins

1. **The engagement layer has no competitor.** Intake → auto-drafted 4.3 scope →
   12-week plan → facilitator playbooks → pass-over-pass diffing → DOCX
   deliverables is a consultant's actual workflow. Drata and Vanta don't model
   engagements at all; Apptega models multi-client but not the delivery method.

2. **ISO management-system mechanics are properly built.** Clause 9.3.2 with all
   six inputs auto-populated, ISO 27004 metrics, interested parties, objectives,
   competence, communication plan. The automation platforms treat ISO 27001 as a
   control checklist and largely skip the management-system clauses — which is
   exactly what Stage 1 audits examine.

3. **"Minimum certifiable" content.** 118 items each stating the smallest version
   that still passes Stage 2. For a consultant working small clients on fixed
   fee, this is the single most commercially useful thing in the tool, and
   nothing else on the market has it.

4. **Self-hosting.** Full data residency, no per-seat pricing, client data never
   leaves infrastructure you control. In regulated sectors and in jurisdictions
   with data-localisation rules this converts deals the SaaS platforms can't bid on.

5. **Evidentiary integrity.** SHA-256 evidence hashes surfaced in the audit pack,
   hash-chained audit log with a verification view, per-workspace encryption keys.
   Stronger than what the mainstream platforms expose to an auditor.

## Where it loses, ranked by commercial impact

1. **No integrations, no automated evidence collection.** This is the entire value
   proposition of Drata and Vanta. Every piece of evidence here is hand-uploaded.
   In a head-to-head against a client who wants "compliance on autopilot", this
   loses on the first slide — and it is expensive to close (each integration is a
   separate OAuth app, API client, and normalisation layer).

2. **Three frameworks vs 20–35.** A client asking for SOC 2 alongside ISO 27001
   can't be served today. SOC 2 and GDPR exist only as crosswalk *references*,
   not as assessable frameworks with their own control sets and evidence mapping.
   SOC 2 is the highest-value addition — it's the most common companion ask.

3. **No SSO.** Any client above roughly $8K/yr of spend will have corporate IT
   reject a password-only application. This is a procurement blocker, not a
   feature request, and it's the cheapest of the big three gaps to close.

4. **No REST API.** Procurement-grade buyers want to pull SoA, control state, and
   evidence lists out programmatically. Also blocks any future integration work.

5. **No read-write client portal.** The auditor portal is excellent; its client
   twin doesn't exist. Clients currently can't self-serve evidence upload or
   policy review, which pushes coordination work back onto the consultant —
   directly eroding the tool's own efficiency argument.

6. **No trust center.** Table stakes for SaaS clients using compliance as a sales
   asset. Less relevant if the client base is enterprises seeking certification
   rather than startups seeking to close deals.

## Honest positioning

Compliance Sphere is not a Drata or Vanta competitor and shouldn't be sold as
one. It competes with **the consultant's current stack of Word, Excel, and
SharePoint** — and against that it wins decisively. Its nearest true competitor
is **Apptega**, on the consultant/MSSP axis, where it beats Apptega on ISO depth,
deliverable quality, and self-hosting, and loses on framework breadth and
platform maturity (SSO, API, mobile).

The sharpest wedge: *"ISO 27001 and ISO 42001 certification engagements, run by
consultants, on infrastructure you control, producing the deliverables the
certification body actually asks for."* Every one of those clauses is a place a
larger competitor is weak.

## Others worth knowing about

- **Sprinto, Scrut Automation** — Drata/Vanta-model automation, strong in India
  and APAC, aggressive on price. The most likely competitors in a Mumbai-based
  engagement.
- **AuditBoard, LogicGate, Archer, ServiceNow IRM** — enterprise IRM. Different
  buyer (internal audit / risk function at large enterprises), six-figure
  contracts, heavy implementation. Not a competitor for SME certification work.
- **Hyperproof, StandardFusion** — mid-market GRC, between the automation
  platforms and enterprise IRM.
- **Secureframe, Thoropass** — Drata/Vanta-model; Thoropass bundles the audit
  itself, which is a genuinely different commercial shape.

## If the roadmap were being sequenced on this analysis

| Priority | Item | Why |
|---|---|---|
| 1 | **SSO (OIDC)** | Procurement blocker, cheapest of the blockers to close |
| 2 | **SOC 2 as a first-class framework** | Highest-frequency companion ask; crosswalk data already exists |
| 3 | **REST API (read-only first)** | Unblocks procurement and all future integration work |
| 4 | **Read-write client portal** | Reclaims the consultant time the tool exists to save |
| 5 | **First 3 integrations** (AWS Config, Google Workspace, Okta) | Narrows the automation gap where it's most visible; large effort — scope deliberately |

---

*Generated from the codebase at `docs/module-inventory-and-market-comparison.md`.
Competitor rows are directional and should be re-verified before external use.*
