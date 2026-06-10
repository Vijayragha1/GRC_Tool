# WIP convergence audit — `3fa38bf` "WIP: audit hardening checkpoint"

Branch: `fix/audit-hardening-2026-06`. Commit: `3fa38bf` (Thu Jun 11 2026).
Scope: 79 files, +4074 / -484. Inspected via `git show` only (no checkout).

Question answered: per area/file, which WIP changes **depend on demolition-scheduled
legacy tables** (coupled to the converged-schema migration, will need rebuilding after
cutover) vs which are **schema-independent / persist-safe** (survive convergence as-is).

Categories:
- **A — COUPLED**: the *added* lines read/write one or more demolition-scheduled tables.
- **B — SCHEMA-INDEPENDENT**: UI/styling/copy/JS-only, config, or no DB access.
- **C — PERSIST-SAFE**: touches only tables on the persist list (core suppliers, risks,
  incidents, workspaces, generated_docs, auditor_shares, search_index, etc.).

---

## 1. Summary table

| Feature / module | Cat | Demolition tables it depends on | Survives convergence? |
|---|---|---|---|
| **SOC 2 PBC workflow** (engagements, requests, evidence, comments, activity) | A | `soc2_engagements`, `soc2_requests`, `soc2_request_evidence`, `soc2_request_comments`, `soc2_request_activity` | **needs-rebuild** |
| **Firm questionnaire builder** (templates, questions, versioning, question bank) | A | `questionnaire_templates`, `questionnaire_questions`, `questionnaire_template_versions`, `questionnaire_question_bank` | **needs-rebuild** |
| **Supplier questionnaire issuance + recurring re-attestation** | A | `supplier_questionnaires`, `supplier_questionnaire_responses`, `recurring_questionnaire_schedules`, `questionnaire_templates`, `questionnaire_questions` | **needs-rebuild** |
| **Supplier findings → NC promotion + TPRM dashboard** | A | `supplier_findings`, `supplier_reviews`, plus writes to `nonconformities` | **needs-rebuild** |
| FTS drift-reconcile (`rebuildStaleWorkspaces`) | A (minor) | `control_states` (read, in drift COUNT only) | **partial** — one COUNT term breaks |
| Supplier contacts / onboarding / approval gate | C | none (suppliers core + new `supplier_contacts`, `supplier_onboarding_items` — both persist-class) | yes |
| Supplier CSV import / export / DOCX reports | C | none (`suppliers` core) | yes |
| HTML sanitisation of document bodies (XSS hardening) | B | none | yes |
| Helmet / CSP, session hardening, auditor-share token hashing | B/C | none (`auditor_shares` persists) | yes |
| Backup writability assert + restore script | B/C | counts only persist tables | yes |
| Incident/risk → supplier link dropdown | C | `incidents.supplier_id`, `risks.supplier_id` (core cols) | yes |
| Copy/style/em-dash cleanups across ~50 views + 2 data files | B | none | yes |

---

## 2. Per-file / per-area breakdown

### A. COUPLED to demolition tables (needs rebuild on converged schema)

**`db.js` (DDL + migrations) — MIXED, the coupled half is the schema source of truth.**
Added `CREATE TABLE` for the demolition stack: `soc2_engagements`, `soc2_requests`,
`soc2_request_evidence`, `soc2_request_comments`, `soc2_request_activity`,
`questionnaire_template_versions`, `questionnaire_question_bank`,
`recurring_questionnaire_schedules`, `supplier_findings`. These DDL blocks are
superseded by the converged schema and should NOT be carried forward as-is.
(Also adds persist-class `supplier_contacts`, `supplier_onboarding_items`, suppliers
onboarding/approval columns, and an `auditor_shares` token-hash backfill migration —
those are Category C, see below.)

**`server.js` — the bulk of the coupling lives here.** Distinct added route slices:

- *SOC 2 module* (`@@ -14956 … +15604,313`, app routes `/workspaces/:wsId/soc2/*`):
  full CRUD over `soc2_engagements` / `soc2_requests` / `soc2_request_evidence` /
  `soc2_request_comments` / `soc2_request_activity`, plus `soc2cat` lookups from
  `data/soc2-catalog.js`. Feature: SOC 2 PBC / audit-collaboration workflow →
  Phase 2b convergence + demolition. **Rebuild entirely on converged
  frameworks/requirements/control_instances/findings tables.**
- *Firm questionnaire builder* (`/firm/questionnaires/*`, ~13 routes): reads/writes
  `questionnaire_templates`, `questionnaire_questions`,
  `questionnaire_template_versions`, `questionnaire_question_bank`. **Rebuild.**
- *Vendor questionnaire dashboard + funnel* (`/workspaces/:wsId/vendors/dashboard`):
  aggregates `supplier_questionnaires`, `supplier_questionnaire_responses`,
  `supplier_findings`, `supplier_reviews`, `recurring_questionnaire_schedules`,
  `questionnaire_templates`. **Rebuild.**
- *Supplier findings CRUD + promote-to-NC* (`/vendors/:id/findings*`): writes
  `supplier_findings`; `promote-nc` also INSERTs into `nonconformities` (persist) and
  back-links. **Rebuild the findings half**; the NC write is the integration seam.
- *Bulk send + recurring schedules* (`/vendor-bulk-send`, `/vendor-schedules*`):
  writes `recurring_questionnaire_schedules`, calls `supplierQ.issueQuestionnaire`
  (→ `supplier_questionnaires`). **Rebuild.**
- *Existing questionnaire response/share routes* touched by the WIP continue to read
  `questionnaire_questions` / `supplier_questionnaire_responses`. **Rebuild.**

**`lib/supplier-questionnaires.js` (NEW, whole file = WIP) — fully coupled.**
`issueQuestionnaire()` INSERTs `supplier_questionnaires`; `pickRecipientEmail` reads
`supplier_contacts` (persist) and `suppliers.contact` (persist). The issuance write is
coupled. **Rebuild against converged questionnaire/assessment tables.**

**`lib/jobs.js` — coupled (new job).** `jobRecurringQuestionnaires` selects
`recurring_questionnaire_schedules` and updates it, calling `issueQuestionnaire`
(→ `supplier_questionnaires`). Job registration `['recurringQuestionnaires', …]`.
**Rebuild.**

**`lib/fts.js` — minor/partial coupling.** The WIP-refactored `rebuildStaleWorkspaces`
drift COUNT includes `SELECT COUNT(*) FROM control_states` (carried into the new
function). Reads only, but the term breaks when `control_states` is demolished.
The surrounding refactor (off-request-path reconcile, per-write `refresh()`) is
schema-independent; only this one COUNT term needs repointing to the converged
`control_instances`/`assessments` source. **Partial.**

**`data/soc2-catalog.js` (NEW, whole file = WIP) — NOT itself coupled.** Pure static
TSC reference data, zero SQL. Survives as a lookup table, but it is *only useful to*
the SOC 2 module, so its fate tracks that feature. Category B in isolation.

### B. SCHEMA-INDEPENDENT (survive untouched)

- **`lib/sanitize.js`** (NEW): allowlist HTML sanitiser, no DB. Pure security hardening.
- **`server.js`** sanitize wiring (`sanitizeDocHtml` on doc bodies, approver/print
  surfaces), `helmet`/CSP block, session cookie hardening — no schema dependency.
- **`routes/auditor.js`**: adds `sanitizeDocHtml` on rendered audit-share bodies; the
  only table touched is `auditor_shares` (persist) for token hashing → C, not coupled.
- **Views — new feature surfaces** (`soc2_home.ejs`, `soc2_engagement.ejs`,
  `soc2_request.ejs`, `questionnaire_templates.ejs`, `questionnaire_builder.ejs`,
  `tprm_dashboard.ejs`, plus edits to `vendor_detail.ejs`, `vendors.ejs`,
  `vendor_questionnaire.ejs`, `external_questionnaire.ejs`): contain **no SQL** — they
  consume controller-supplied vars (`eng`, `requests`, `templates`, `summary`, etc.).
  Markup survives, but it renders demolition-bound data, so it only "works" once the
  controllers behind it are rebuilt. Treat as B (no schema dep) but feature-tied.
- **`data/iso27004-metrics.js`**: em-dash→colon comment/copy cleanup only.
- **`docker-compose.yml`** (`shm_size`), **`package.json` / `package-lock.json`**
  (adds `helmet`, `sanitize-html`, csv dep), **`public/fonts/*`, README**: config/deps/docs.
- **~50 view edits** (`header.ejs`, `footer.ejs`, dashboards, auditor_*, admin_*, etc.):
  styling/copy/em-dash cleanup, no DB.
- **`lib/csf-policy.js`, `lib/csf-scoring.js`, `lib/template-refs.js`,
  `lib/rbac.js`, `lib/audit-pack.js`, `lib/email.js`**: WIP lines are
  comments/copy/escaping/queue-isolation — no demolition-table reads/writes added.
  (`email.js` adds the supplier-questionnaire invite body; the DB read that feeds it
  lives in the coupled lib.)

### C. PERSIST-SAFE (touch only surviving tables)

- **`lib/csv-import.js`**: `SUPPLIER_SCHEMA` imports into `suppliers` (core). Survives.
- **`server.js`** vendor import/export/report routes (`/vendors/import*`,
  `/export/vendors.csv`, `/vendors/:id/report.docx`, `/export/vendors-report.docx`):
  read/write `suppliers` core + persist child tables. Survives.
- **`server.js`** supplier contacts (`supplier_contacts`) and onboarding/approval
  (`supplier_onboarding_items`, suppliers approval columns) routes: new tables are on
  the persist side of the line. Survives.
- **`db.js`** `supplier_contacts` / `supplier_onboarding_items` DDL, suppliers column
  migrations, `auditor_shares` token-hash backfill: persist-class. Survives.
- **`routes/auditor.js`** `auditor_shares` hashing: persist. Survives.
- **`lib/backup.js`, `scripts/backup.js`, `scripts/restore.js`**: backup/restore;
  `restore.js` row-count probe touches only `firms/workspaces/users/risks/generated_docs/audit_log`
  (all persist). Survives.
- **`views/incident_detail.ejs`, `views/risk_detail.ejs`**: supplier-link dropdown →
  writes `incidents.supplier_id` / `risks.supplier_id` (core columns). Survives.
- **`scripts/seed-demo-clients.js`**: demo evidence/comment data tweaks on persist
  tables. Survives.

---

## 3. Bottom line

**Split (by feature weight, not raw line count):** roughly **two-thirds of the WIP is
schema-independent or persist-safe and survives convergence as-is** — the entire
security-hardening track (HTML sanitiser, Helmet/CSP, session + auditor-share token
hashing, backup-writability + restore), the supplier *core* expansion (contacts,
onboarding, CSV import/export, DOCX reports, incident/risk supplier links), and ~50
copy/style view edits. **Roughly one-third is coupled to demolition tables and must be
rebuilt on the converged schema after cutover.**

**The 3–5 most coupled features (highest rebuild cost):**
1. **SOC 2 PBC workflow** → `soc2_engagements`, `soc2_requests`, `soc2_request_evidence`,
   `soc2_request_comments`, `soc2_request_activity` (server.js SOC 2 slice + db.js DDL +
   `data/soc2-catalog.js` + 3 views). Largest single coupled surface.
2. **Firm questionnaire builder** → `questionnaire_templates`, `questionnaire_questions`,
   `questionnaire_template_versions`, `questionnaire_question_bank`.
3. **Supplier questionnaire issuance + recurring re-attestation** →
   `supplier_questionnaires`, `supplier_questionnaire_responses`,
   `recurring_questionnaire_schedules` (`lib/supplier-questionnaires.js`, `lib/jobs.js`,
   bulk-send/schedule routes).
4. **Supplier findings + TPRM dashboard** → `supplier_findings`, `supplier_reviews`.
5. **(minor) FTS drift COUNT** → `control_states` — one query term to repoint.

**Conflict risk with the migration's read/write cutover:**
- **`lib/jobs.js` recurring-questionnaire job** is the sharpest risk: it runs on the
  scheduler (background, not request-gated) and **WRITES** `supplier_questionnaires` +
  `recurring_questionnaire_schedules` and mints external tokens / sends email. If this
  job is left enabled during the migration's read/write cutover window, it can INSERT
  into a table the migration is mid-flight on, diverging the legacy and converged copies
  and emitting live emails. **Disable `recurringQuestionnaires` before cutover.**
- **`supplier_findings.promote-nc`** writes across a demolition table (`supplier_findings`)
  *and* a persist table (`nonconformities`) in one logical action; during cutover this
  cross-table write can half-land (NC created, finding back-link lost, or vice versa).
- All other coupling is request-path CRUD that is naturally quiesced once the routes are
  taken down for cutover; lower risk.

**Recommendation:** carry forward Categories B and C unchanged. For Category A, keep the
EJS view markup and `data/soc2-catalog.js`, but rebuild the controllers/queries and drop
the legacy DDL from `db.js`, repointing onto the converged
`frameworks` / `requirements` / `control_instances` / `assessments` / `findings` /
`evidence_requirement_links` tables. Gate the recurring-questionnaire job off before the
migration's read/write cutover.

---

## 4. Approved disposition (Vijay, 2026-06-11)

The recommendation above is **approved as written**. Standing decisions:

- **Categories B and C (security-hardening track + supplier-core) continue on `fix/audit-hardening-2026-06`** as ordinary feature work. They are schema-independent / persist-safe and survive convergence unchanged.
- **Category A controller work is FROZEN on the legacy schema.** No further SOC 2 PBC or questionnaire/DDQ controller/query development against `soc2_*`, `questionnaire_*`, `supplier_questionnaires`, `supplier_findings`, etc. on `fix/audit-hardening-2026-06`.
- **The frozen Category A controllers will be rebuilt as the app-integration (read/write cutover) half of Phases 2b (SOC 2) and 5 (supplier/DDQ) post-cutover,** repointed onto the converged `frameworks` / `requirements` / `control_instances` / `assessments` / `findings` / `evidence_requirement_links` tables. The existing EJS views and `data/soc2-catalog.js` are reused as-is (they carry no SQL).
- This freeze is recorded in MIGRATION_NOTES under the cutover standing rules.
