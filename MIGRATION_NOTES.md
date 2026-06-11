# MIGRATION_NOTES

Running log of the converged GRC schema migration. Newest phase last.
Schema of record: `schema_current.sql` (regenerated at the end of Phase 7).

---

## Environments & cutover policy (standing — Vijay; AWS DESCOPED 2026-06-10)
- **Single instance of record:** local `iso27001.db` (dev). **AWS is out of scope** — removed from all gates and outstanding items. There is no second environment.
- **Runner is the single source of truth for schema:** no manual schema changes outside the `migrations/` runner; `schema_migrations` is authoritative.
- **Deferred migrations are permanently fixture-only:** `006` (responses-blob), `007` (CSF engine port), `009` (DDQ history) have NO legacy data anywhere. They stay in the replay chain as **no-op-safe insurance** only. The `006` blob-keying assumption is now **untestable and irrelevant** (no real answer blobs exist to validate against).
- **Cutover gate:** full test suite green on `main`. Satisfied once the test-only security-suite fix (PR #24, branch `fix/security-test-suite`) merges to `main`: that branch makes `tests/security.test.js` green (8 fixes; harness authenticates, CSRF/XSS/auth controls proven to fire) with a diff limited to `tests/`. `fix/audit-hardening-2026-06` is **decoupled from this gate** and continues as ordinary feature work; it is no longer a cutover precondition (the security-test fixes it originated were cherry-picked to `main` independently). (No AWS precondition.)
- **Demolition gate:** per-module cutover parity passes + Vijay's explicit approval per item + the latest `backup_runs` row is `status='ok'` and under 24h old at execution time. Verify with: `SELECT status='ok' AND (julianday('now')-julianday(ran_at))<1 FROM backup_runs ORDER BY id DESC LIMIT 1;` (must return 1). No AWS precondition.
- **Standing pre-cutover rule:** immediately before any cutover, re-run that phase's idempotent backfill so the new tables are current (point-in-time). **Empirically validated (cutover 3, 2026-06-11):** the first 42001 SoA byte-compare FAILED on a `last_updated` cell because the legacy SoA auto-creates rows on load that were not yet in the converged table; re-running the backfill at switch fixed it to byte-identical. Re-backfill-at-switch is load-bearing, not ceremonial; cite for cutovers 4 and 5.
- **Truncation-without-ordering doctrine (cutover 3, 2026-06-11):** a read that truncates a multi-row result (`LIMIT`, `.slice()`, `[0]`, first-row `.get()` on a non-unique query) WITHOUT an `ORDER BY` is a latent parity bug: the legacy table and the converged view return the same SET in different storage order, so the truncated subset differs. Caught by the cross-workspace function deep-diff (`computeReadiness` flag item-lists differed on ws31/ws32 only, not the pilot). **Hunt the class, do not wait for the harness:** before converting a cluster, grep its unconverted reads for `LIMIT`/`slice`/`[0]`/first-row picks and add an explicit `ORDER BY` to BOTH paths. Verify aggregations with a function-level deep-diff across ALL workspaces, not just the pilot (workspace-specific data shapes hide these). Carry to cutovers 4 and 5.
- **Normalization-map doctrine (cutover 3, 2026-06-11):** a converged normalization map must cover the app's PRODUCIBLE vocabulary, not just the values observed in current data. Caught via `'Work In Progress'`: app-producible (`suggestStatusFromAnswers`) but absent from the Phase 3 STATUS map, so a WIP control would have been quarantined and rendered `Not Assessed` on converged reads (a silent divergence the fail-loud view cannot catch, since the row is ABSENT not mismapped). Audited the writable status/applicability vocabulary in `server.js` (the 6-value `STATUSES` allow-list + `included/excluded/undecided`): every value now round-trips the map. **Cutover 4 requirement:** the converged WRITE path must normalize all writable values (reject/sentinel the unknown), and its E2E suite must write every status value at least once.
- **Cutover order:** one module at a time, smallest blast radius first: evidence reads → evidence writes → control instances → engine → remediation. No feature work on a module during its cutover window.
- **Pre-cutover job freeze (`recurringQuestionnaires`):** before ANY cutover begins, disable the `recurringQuestionnaires` job in `lib/jobs.js` and verify the disabled state. Rationale: the job runs on the scheduler (background, not request-gated), writes `supplier_questionnaires` + `recurring_questionnaire_schedules`, and mints external tokens / sends live email; left enabled during a read/write cutover window it can INSERT into a table the migration is mid-flight on, diverging the legacy and converged copies and emitting live mail. Re-enable ONLY after the supplier/engine cutovers (Phase 5) complete on the converged tables.
- **Remediation-cutover freeze (`supplier_findings` promote-to-NC):** the supplier-findings "promote to nonconformity" action writes across a demolition table (`supplier_findings`) and a persist table (`nonconformities`) in one logical action. It is FROZEN for the duration of the remediation-module cutover window, so a cutover-time write cannot half-land (NC created, finding back-link lost, or vice versa).
- **Green baseline (cutover gate satisfied 2026-06-11):** full suite green on `main` at `b7deabf` — `node tests/smoke.test.js` 45 assertions / 0 failures; `node --test tests/security.test.js tests/rbac.test.js` 25 checks (10 security + 15 rbac) / 0 failures. This is the "zero new failures" reference for every cutover: a cutover must not add a single failure to these counts. (Note: `npm test` lacks `--test-force-exit`; it can hang on an open server handle after all tests pass, so verify by the printed `✔`/`✖` tallies, not by process exit alone.)
- **WIP freeze (recorded):** per `docs/wip-convergence-audit.md` §4 (approved 2026-06-11), the SOC 2 PBC and questionnaire/DDQ controller work on `fix/audit-hardening-2026-06` is frozen on the legacy schema and will be rebuilt as the app-integration half of Phases 2b and 5 post-cutover, reusing the existing views. Security-hardening and supplier-core continue on that branch as ordinary feature work.
- **Backup discipline (dev = single instance of record):** the dev DB is the ONLY recovery path. A **launchd daily job** (`com.grc.dev-backup`, 02:30) runs `scripts/dev-backup.js`, which performs the file-bundle backup (`scripts/backup.js`) AND records a `backup_runs` row. The wrapper exists because `scripts/backup.js` (`npm run backup`) writes bundles to `backups/` but does NOT write `backup_runs`, and the demolition gate keys off `backup_runs`. Plist version-controlled at `deploy/com.grc.dev-backup.plist`, installed at `~/Library/LaunchAgents/`. Verified firing 2026-06-10 (`backup_runs` row `status='ok'`, gate freshness query returns 1).
- **Quarantine approvals:** Phase 1 (65), Phase 2 (53), Phase 6 (3) approved by Vijay. The 22 orphaned-evidence + 14 orphaned-document references stand as dev data-quality findings (no second environment to cross-check).

---

## Phase 0 — Discovery & scaffolding (2026-06-10)

### What changed (additive only; nothing dropped/renamed/altered)
- New migration infrastructure under `migrations/`:
  - `run.js` — forward-only runner. Applies `migrations/NNN_*.sql` once each, records `id` + sha256 in `schema_migrations`, skips already-applied files, warns on checksum drift. The `analysis/` subdir is not picked up. Standalone (`npm run migrate` / `node migrations/run.js`); **not** wired into app startup, so `db.js`'s existing schema bootstrap is unchanged.
  - `001_phase0_scaffolding.sql` — creates `migration_quarantine` and `feature_flags`.
  - `analysis/phase0_discovery.sql` — read-only discovery census (not applied by the runner).
- Tables created in `iso27001.db`:
  - `schema_migrations(id PK, applied_at, checksum)` — created by the runner.
  - `migration_quarantine(...)` — per the brief verbatim.
  - `feature_flags(key, workspace_id NULL, enabled, updated_at)` with two **partial unique indexes** (`WHERE workspace_id IS NULL` / `WHERE workspace_id IS NOT NULL`).
- Discovery deliverables: `docs/phase0-findings.md`, `docs/data-access-inventory.md`.
- Backup gate: `backups/2026-06-10-pre-phase-0.db` via `sqlite3 .backup` (consistent online copy). Verified: `PRAGMA integrity_check` = `ok`, 171/171 tables, `control_states` row parity 434/434.

### Dialect discipline (rule 9) notes
- All new objects use ISO-8601 text datetimes (`TEXT DEFAULT (datetime('now'))`) and explicit FK clauses; no SQLite-only pragmas in the schema bodies.
- **Deliberate refinement of the brief's loose DDL:** the brief specifies `feature_flags` as `key TEXT PRIMARY KEY, workspace_id INTEGER NULL`, but a sole `key` PK cannot represent both a global default and per-workspace overrides. Implemented instead as a plain table with two **partial unique indexes** ("one global row per key", "one row per (key, workspace)"). Partial indexes are supported by both SQLite and PostgreSQL, so this stays port-safe.
- `migration_quarantine` intentionally has no `workspace_id` (it is cross-cutting infra holding raw payloads), matching the brief's DDL. Rule 11 (workspace scoping) applies to tenant-data tables, which this is not.

### Verification gate
- (a) Discovery census passing → `docs/phase0-findings.md`.
- (b) App test suite: `npm test` — result recorded below.
- (c) This summary.

### Test suite result (2026-06-10)
- `node tests/smoke.test.js`: **PASS** (45 assertions, 0 failures).
- `node --test tests/security.test.js tests/rbac.test.js`: **FAIL — 8 failing tests**, all in `security.test.js`: 5 CSRF (token accept/expose/stability/per-session), 2 XSS escaping, 1 Auth bare-DB fallback. `rbac.test.js` passes.

**Attribution: these failures are pre-existing on branch `fix/audit-hardening-2026-06`, NOT caused by Phase 0.** Proof:
1. Phase 0 modified **zero tracked files** (all `git status` `M` entries predate this work; Phase 0 added only untracked files).
2. The security/rbac tests boot the server against a fresh `mkdtemp` tmp DB (`tests/helpers.js:15-19`) built from `db.js`'s schema bootstrap. The Phase 0 tables (`migration_quarantine`, `feature_flags`, `schema_migrations`) are applied only via the standalone runner against `iso27001.db`; they are not in `db.js` SCHEMA, so the tmp test DB never contains them. The tests cannot see Phase 0's changes.

**Gate condition (b) is therefore blocked by a pre-existing red baseline, not by this phase.** The branch is mid-security-hardening (CSRF/XSS work), and its own tests are red independent of the migration. Recommendation: establish a green baseline (fix or quarantine the 8 failing tests on this branch) before "test suite green" can serve as a meaningful per-phase gate. Phase 0's own deliverable (smoke green + additive, reversible scaffolding) is complete.

### Open decisions blocking Phase 1 (see phase0-findings.md §"Decisions required")
1. Empty `assessment_answers` everywhere — demo DB / unused feature, or live data elsewhere? (Phase 4 may be a no-op.)
2. Status/applicability normalization maps (esp. `included → applicable`).
3. 212 orphaned CSF subcategory assessments (no parent engagement) — migrate or exclude?
4. `framework_mappings`: ~143/234 rows target frameworks not loaded as requirements — disposition (recommend keep-for-crosswalk + mirror resolvable subset).
5. `risk_treatments` vs `risk_treatment_actions` survivor (design-only; both tables empty).

### Gate sign-off — Vijay, 2026-06-10
1. **Empty `assessment_answers`:** confirmed dev has no answer data anywhere and dev is the single instance of record. (Superseded: an earlier note speculated the real data lived on an AWS prod/test instance; AWS was fully descoped 2026-06-10.) Phase 4's blob migration is therefore permanently fixture-only.
2. **Status/applicability normalization maps:** approved as written in `phase0-findings.md` (incl. `included → applicable`, `Not Assessed → not_assessed`, etc.). Apply in Phase 3.
3. **212 orphaned CSF assessments:** ran the requested forensic check → **seed data** (106 subcats × 2 engagements, contiguous ids 1–212, single-second timestamps, one templated "Acme" narrative). Quarantined all 212 via `migrations/data/001_phase0_quarantine_csf_orphans.sql` with reason `orphaned seed data`; **source rows preserved, not deleted**. Related orphaned CSF rows (`csf_weighting_profile_items` 212, `csf_evidence_items` 31, `csf_findings` 2, `csf_recommendations` 2) belong to the same demo engagements and will be triaged in the Phase 4 CSF port.
4. **framework_mappings:** approved default (option b) — keep `framework_mappings` for the crosswalk screen; mirror only the resolvable subset (`soc2`, matchable `nist_csf`) into `requirement_mappings`; the ~143 rows targeting unloaded frameworks stay in `framework_mappings` only.
5. **risk_treatments vs risk_treatment_actions survivor:** the unified `remediation_actions` is the survivor. `risk_treatment_actions` are remediation actions with risk lineage → map into `remediation_actions` preserving the link back to the originating risk (Phase 6 design: likely via a `findings` row with `source_type='risk'`, or a direct risk reference; confirm at Phase 6). Both legacy tables are currently empty.

### Reversibility
Phase 0 is fully reversible: `DELETE FROM migration_quarantine WHERE reason='orphaned seed data';` then `DROP TABLE migration_quarantine; DROP TABLE feature_flags; DROP TABLE schema_migrations;` and remove `migrations/` + `docs/` artifacts. No pre-existing table was altered; the only data writes were additive rows into `migration_quarantine`.

---

## Phase 1 — Unified framework catalog (2026-06-10)

### What changed (additive only)
- Backup gate: `backups/2026-06-10-pre-phase-1.db` (integrity `ok`).
- Schema `migrations/002_phase1_framework_catalog.sql`: created `frameworks`, `requirements`, `requirement_mappings` (+ `idx_requirements_fw`) and read-only compatibility views `v_iso_items`, `v_iso42001_items`.
- Backfill `migrations/data/002_phase1_backfill.js` (idempotent; INSERT OR IGNORE on natural keys; recomputes phase-1 quarantine on each run):
  - **frameworks (4):** iso27001:2022 (`is_canonical=1`), iso42001:2023, csf:2.0, soc2:2017-rev2022.
  - **requirements (403):** iso27001 118 (from `iso_items`), iso42001 65 (from `iso42001_items`), csf 134 (functions 6 + categories 22 + subcategories 106, `parent_ref` chained by code), soc2 86 (5 categories + 20 groups + 61 criteria, from `data/soc2-catalog.js`). Rich ISO guidance columns folded into the `guidance` JSON blob.
  - **requirement_mappings (422):** from `framework_mappings` (soc2 + nist_csf, ISO = canonical, `external_ref` comma-split) = 118; from `csf_subcategory_iso_refs` (ISO = canonical, CSF = mapped) = 335; overlap deduped by `UNIQUE(canonical,mapped)`. All `coverage='partial'`, `residual_gap_note='coverage not yet graded: legacy import'` (note: colon, not em dash, per standing style rule). **Coverage grading is Vijay's consulting work; left ungraded.**

### Ref normalizer (the "real ref-format mapper" Phase 0 called for)
`csf_subcategory_iso_refs` ISO refs: `annex_a` value `5.20` → `annex-a.5.20`; `mandatory_clause` `4.1` → `clause-4.1`; comma multi-refs split; trailing sub-letters stripped (`4.2(a)` → `clause-4.2`). `framework_mappings.external_ref` comma-split.

### Verification gate — PASS
- Row-count parity exact: iso27001 118/118, iso42001 65/65, csf 134/134; soc2 86 = catalog total.
- Orphan mappings: 0. Invalid `guidance` JSON: 0. Spot-checks extract `purpose`/`questions` cleanly; views return 118 / 65 legacy-shaped rows.
- Tests: `tests/smoke.test.js` PASS (45/45). Security suite still has the same 8 pre-existing branch failures (unrelated; tmp-DB isolated). `db.js`/`server.js` not edited by this work.

### Quarantine triage (Vijay's directives, 2026-06-10) — final: 65 rows, 60 resolved / 5 open
- **60 × `ref_value='None'`** → **marked resolved** (`resolved_at` set) with note "deliberate no-mapping marker: CSF subcategory has no ISO crosswalk; assess subcategory directly (no cross-framework inheritance)". Design follow-on for Phase 4: the assessment engine must treat a subcategory with no `requirement_mappings` row as **assessed directly**, not inherited.
- **The two `clause-6.1` refs — investigated per Vijay, root cause found, FIXED (recovered):** Vijay correctly noted clause 6.1 is real. Traced all 6 `csf_subcategory_iso_refs` rows with `ref_value='6.1'`: 4 are `ref_type='annex_a'` → `annex-a.6.1` (A.6.1 Screening), which exists and mapped correctly; only the 2 `mandatory_clause` rows (GV.OC-01, GV.OC-02) failed. **Not silent loss** (every row was either mapped or quarantined) and **not a string-format bug**: the ISO catalog models clause 6.1 only via children `6.1.1/6.1.2/6.1.3` with no bare `clause-6.1` row, so exact-match missed. Fix: resolver now expands a parent clause to its children when no exact row exists. GV.OC-01/GV.OC-02 now map to `clause-6.1.1/6.1.2/6.1.3` (+6 mappings). **No other rows were affected** (6.1 is the only parent-with-children clause in the catalog).
- **5 still OPEN (legitimately unmappable, stay quarantined per Vijay):** 2 × `csf_subcategory_iso_refs` typo clauses (`6.11`, `6.13` — no such clause, no children); 3 × `framework_mappings` stale CSF 1.1 codes (`PR.DS-03` ×2, `PR.DS-04`) absent from CSF 2.0.
- Zero genuine data loss: every source row preserved; `framework_mappings` and `csf_subcategory_iso_refs` untouched.

### Open items / pending approval
- **SOC 2 TSC — structure APPROVED (Vijay, 2026-06-10); content sign-off PENDING.** Counts reconcile with the real TSC; Vijay will spot-check ~10 paraphrases (CC6.x weighted) and confirm content sign-off. This is a **pending gate that must clear before Phase 2b starts**, but is **not a blocker for Phase 2**. The 86 SOC 2 requirements are loaded from `data/soc2-catalog.js`.
- **framework_mappings option (b) confirmed:** unloaded-framework rows (nist_800_53, pci_dss, hipaa, dora, gdpr, iso_2701x ≈ 143) intentionally NOT mirrored into `requirement_mappings`; they remain in `framework_mappings` for the crosswalk screen.

### Reversibility
`DELETE FROM requirement_mappings; DELETE FROM requirements; DELETE FROM frameworks; DELETE FROM migration_quarantine WHERE phase='phase1';` then drop the two views + three tables and remove migration 002 files. No pre-existing table altered.

---

## Phase 2 — Evidence migration (foundation) (2026-06-10)

### What changed (additive only)
- Backup gate: `backups/2026-06-10-pre-phase-2.db` (integrity `ok`).
- Schema `migrations/003_phase2_evidence_links.sql`: created `evidence_requirement_links` (+ `idx_evreq_ev`, `idx_evreq_req`).
- Backfill `migrations/data/003_phase2_backfill.js` (idempotent; re-run keeps 165):
  - From `evidence_controls` (ISO 27001, the table the app writes): 165 → links, 21 quarantined.
  - From `evidence_links` (any framework, the trigger mirror): 165 resolved (deduped into the same 165 by `UNIQUE(evidence_id,requirement_id)`), 1 quarantined.
  - **165 `evidence_requirement_links`** total (all ISO 27001; no CSF/42001 evidence links exist in this DB).

### Data-integrity issue surfaced (FK enforcement caught it)
With `foreign_keys=ON`, the first run failed on `evidence_id → evidence(id)`: **22 legacy rows reference evidence that was deleted** while FKs were off (21 in `evidence_controls` across 11 distinct missing evidence ids, 1 in `evidence_links`). These cannot become links to a nonexistent evidence row, so the backfill now guards on evidence existence and quarantines them. Good signal that the legacy trigger pair tolerated orphans that the new FK-clean table will not.

### Verification gate — RECONCILIATION PASS (exact)
- `legacy_ec_distinct (186) == new_links (165) + ec_quarantine (21)`. Exact.
- 0 dangling links in the new table (every `evidence_id`/`requirement_id` resolves); 0 non-orphan `evidence_links` pairs missing from the new table.
- Per-framework: 165 ISO 27001 (CSF/42001 = 0, as expected).
- `tests/smoke.test.js` PASS (45/45). Security suite unchanged (pre-existing branch failures). No app code edited.
- **Not yet done (the other half of the gate):** "evidence screens render identically on a pilot workspace" requires the app read cutover (server.js), which is deferred to the flagged read/write-switch step below.

### Quarantine — 53 rows (phase='phase2'), all legitimately orphaned/seed (>20 → flagged for Vijay)
- 31 × `csf_evidence_items`: seed (all attached to the Phase 0 quarantined seed assessments; templated `confluence.acme.example/...` links; single-second bulk insert `2026-05-14 15:45:53`). NOT folded into central `evidence`; real CSF evidence folding deferred to the Phase 4 CSF port.
- 21 × `evidence_controls` + 1 × `evidence_links`: orphaned `evidence_id` (evidence row deleted under FK-off).

### Deferred (remaining Phase 2 work — needs server.js changes, flag-gated)
1. **Read cutover:** switch evidence screens to read `evidence_requirement_links` behind a per-workspace `feature_flags` switch; verify byte-identical render on pilot workspace 31/32.
2. **Write cutover + temporary sync trigger:** switch app writes to `evidence_requirement_links`; add a transition trigger that maintains the legacy `evidence_links` shape for any un-migrated readers. **Demolition date for that trigger to be recorded here when it is created.**
3. **Demolition (with approval only):** drop `evidence_controls` + its 3 `evctrl_to_evlinks_*` triggers, then later `evidence_links`. Not done; requires explicit go-ahead.
These are deferred because they modify the heavily-WIP `server.js` and must be flag-gated and verified, and the branch's security test baseline is currently red (separate issue).

### Reversibility
`DELETE FROM evidence_requirement_links; DELETE FROM migration_quarantine WHERE phase='phase2' AND resolved_at IS NULL;` then drop the table + remove migration 003 files. No pre-existing table altered; all legacy evidence tables/triggers untouched.

---

## Phase 3 — Unified control instances (data half) (2026-06-10)

### What changed (additive only)
- Backup gate: `backups/2026-06-10-pre-phase-3.db` (integrity `ok`).
- Schema `migrations/004_phase3_control_instances.sql`: `control_instances` (+ `idx_ci_ws`, `idx_ci_req`, and partial unique `idx_ci_wholeorg` to dedupe whole-org rows since SQLite treats NULL `entity_id` as distinct), `control_instance_history`, `proposed_changes`, `document_requirement_links`.
- Backfill `migrations/data/004_phase3_backfill.js` (idempotent; re-run stable at 434/2/193):
  - `control_states` 434 → `control_instances` (`entity_id` NULL), status/applicability normalized via the **approved maps** (`Implemented→implemented`, …, `included→applicable`); `owner_id` guarded against orphans; `migrated_from='control_states:ID'`.
  - `entity_control_states` 0, `iso42001_control_states` 0 → none (both empty; `entity_control_states` also dead per Phase 0).
  - `control_state_history` 2 → `control_instance_history` (`source='migration'`, snapshot stored as `new_*` + full legacy row in `payload`, original `snapshot_at` preserved). `iso42001_control_state_history` 0.
  - `document_controls` 207 → `document_requirement_links`: 193 links, 14 quarantined. `iso42001_document_controls` 0.

### Verification gate — PASS (data half)
- Count parity: 434 legacy states == 434 instances (all whole-org / `entity_id` NULL).
- **Per-workspace NORMALIZED status histogram identical pre/post** (bidirectional `EXCEPT` empty).
- History exact: 2 == 2. Doc-link reconciliation exact: 207 == 193 + 14. FK integrity: 0 dangling. Smoke 45/45.

### Quarantine — 14 (phase='phase3')
- 14 × `document_controls` orphaned `document_id` (deleted documents). Same legacy-integrity-drift pattern as Phase 2's orphaned evidence; logged as a dev data-quality finding (no second environment).

### Deferred (gated app-integration half)
- Compatibility views `v_control_states` / `v_iso42001_control_states` (need status DE-normalization to reproduce legacy strings).
- Read/write cutover behind `feature_flags`; **SoA byte-equivalence** gate for 27001 + 42001 (needs the app reading the new tables).
- Demolition (with approval): `control_states`, `entity_control_states`, `iso42001_control_states`, both history tables, `document_controls`, `iso42001_document_controls`.

### Reversibility
`DELETE FROM document_requirement_links; DELETE FROM control_instance_history; DELETE FROM proposed_changes; DELETE FROM control_instances; DELETE FROM migration_quarantine WHERE phase='phase3' AND resolved_at IS NULL;` then drop the 4 tables + remove migration 004 files. No pre-existing table altered.

---

## Phase 4 — Assessment engine + ISO/CSF data scripts (2026-06-10)

Amendment (Vijay): the structural half is applied to dev; the data scripts (`006`/`007`) are written and proven against fixtures + a full-chain dry run. AWS was later descoped (2026-06-10), so no real-data execution exists anywhere: these scripts are permanently fixture-only, kept in the replay chain as no-op-safe insurance.

### Structural half (applied to dev)
- Backup: `backups/2026-06-10-pre-phase-4.db` (integrity `ok`).
- Schema `migrations/005_phase4_assessment_engine.sql`: `scoring_models`, `question_sets`, `questions`, `question_requirement_map`, `assessments`, `responses`, `assessment_schedules`, `assessment_versions`, `response_snapshots`; `ALTER TABLE entities ADD COLUMN attributes`. `entity_type` canonical values documented (`organization/supplier/ai_system/business_unit/department`; no CHECK, to avoid a destructive table rebuild).
- Backfill `migrations/data/005_phase4_structural_backfill.js` (idempotent): system conformity scoring model; **ISO 27001:2022 gap question set = 159 questions exploded from `iso_items.questions` across all 118 items** (`stable_key='{id}:q{n}'`, each mapped to its requirement; per-item count report produced, 0 empty items); **5 organization entities**; **2 shell assessments** from `assessment_passes`.
- Structural gate PASS: questions 159 / qr_maps 159 (every question → exactly 1 requirement) / org entities 5 == workspaces 5 / assessments 2 / responses 0; idempotent.

### Data scripts (written; permanently fixture-only, AWS descoped)
- `006_phase4_responses_blob.js`: explodes `control_state_history` (by pass) + current `control_states` blob → `responses`. Routing: pass_id → that pass's assessment; null pass_id → synthetic "Pre-passes import"; current blob → synthetic "Working"; retired-item rows + malformed JSON + out-of-range entries → quarantine. **ASSUMED blob shape documented** (array positional 1-based / numeric-key 1-based / `qN` keys) — now untestable and moot (AWS descoped, no real blobs exist). Reconciliation: `entries == responses + entry_quarantine + dedup`.
- `007_phase4_csf_engine.js`: creates system maturity model + NIST CSF 2.0 question set (one question per subcategory → requirement); `csf_engagements`→`assessments`, `csf_subcategory_assessments`→`responses`, `csf_engagement_versions`→`assessment_versions`, `csf_subcategory_assessment_snapshots`→`response_snapshots`; orphaned subcat assessments skipped if Phase-0 seed-quarantined, else quarantined. Reconciliation: `subcat == responses + orphan_q + dedup + seed_skip`.

### Fixture validation `migrations/fixtures/phase4_validate.js` — ALL PASS
Synthetic fixtures on a scratch copy covering: normal array blob (4q→4 resp), object numeric-key blob (3q→3), null pass_id (→pre-passes synthetic, 2 resp), out-of-range answer index (→entry quarantine), malformed JSON (→row quarantine), retired-item ref (→row quarantine), and a CSF engagement with 3 subcat assessments + 1 version + 3 snapshots. Both reconciliation gates PASS; all 11 routing assertions PASS.

### Dry-run replay `migrations/replay.js` — full chain on a pristine legacy-state copy
Ran the entire chain (schema 001-005 + data 001-007) against a copy of `backups/2026-06-10-pre-phase-0.db` (legacy state, 0 converged tables). All steps clean; both Phase 4 reconciliations PASS; deterministic converged result: frameworks 4, requirements 403, requirement_mappings 422, evidence_requirement_links 165, control_instances 434, control_instance_history 2, document_requirement_links 193, question_sets 2, questions 265 (159 ISO + 106 CSF), assessments 2, responses 0, versions 0, snapshots 0; quarantine phase0 212 / phase1 65 / phase2 53 / phase3 14. **Deterministic dev replay; retained as no-op-safe insurance (AWS descoped).**

### Dev state: STRUCTURAL ONLY (data deferred)
006/007 were NOT run against dev's real tables (no answer data; CSF is seed). Dev: `question_sets`=1 (ISO), `questions`=159, `responses`=0. Smoke 45/45.

### AWS — DESCOPED (Vijay, 2026-06-10)
AWS is no longer in scope; the AWS replay/dry-run is removed from all gates and outstanding items. Consequence: `006` (responses-blob), `007` (CSF engine port), `009` (DDQ history) are **permanently fixture-only** — no legacy answer/CSF/DDQ data exists anywhere. They remain in the replay chain as **no-op-safe insurance**. The `006` blob-keying assumption is now **untestable and moot**. The orphaned-CSF seed forensic was already completed on dev (Phase 0); there is no second dataset to re-run it against.

### Reversibility
`DELETE FROM response_snapshots, assessment_versions, responses, assessments, question_requirement_map, questions, question_sets, scoring_models; DELETE FROM migration_quarantine WHERE phase='phase4';` drop the 9 new tables + remove migration 005 files. `entities.attributes` column is additive/harmless and may stay. No pre-existing table altered.

---

## Phase 5 — Supplier/DDQ convergence (2026-06-10)

Structural half applied to dev; DDQ-history + schedules scripts written and fixture-proven; the DDQ/schedule **data** is permanently fixture-only (no legacy data anywhere; AWS descoped).

### Structural half (dev)
- Backup: `backups/2026-06-10-pre-phase-5.db` (integrity `ok`).
- Schema `migrations/006_phase5_supplier_ddq.sql` (`question_sets.cloned_from`, `questions.tags`, `external_assessment_tokens`) + `migrations/007_phase5_schedule_lineage.sql` (`assessment_schedules.migrated_from`).
- Backfill `migrations/data/008_phase5_structural.js` (idempotent): **14 supplier entities** + `suppliers.entity_id` backfilled (0 null); **weighted_risk scoring model** reproducing `scoreQuestionnaire` (server.js:7745-7773); 3 `questionnaire_templates` → `question_sets` (`target_entity_type='supplier'`, clone lineage); 66 `questionnaire_questions` → `questions` (`stable_key='qqid:{id}'`); `iso_control_ref` → `question_requirement_map` (A.x→annex-a.x, N.M→clause-N.M, comma-split, parent-clause expansion): **64/66 questions mapped, 73 maps, 0 unresolved**.
- **`questionnaire_template_versions` + `questionnaire_question_bank` (gap closed 2026-06-10):** 0 rows in dev, but 008 still migrates them if such data ever exists (no-op-safe insurance): `questionnaire_template_versions.snapshot` (JSON array per server.js:10894) → a **retired** `question_sets` version with exploded `questions`; `questionnaire_question_bank` → a firm-scoped (or system, when `is_system`) **"Question Bank"** `question_set` with `tags` → `questions.tags` and `iso_control_ref` → `question_requirement_map`. Both proven on populated fixtures (an earlier header comment claimed these were "handled by 009/AWS" — that was wrong; now genuinely implemented). **CONFIRMED (Vijay, 2026-06-10): one Question Bank `question_set` per firm + the system set (`is_system` → firm_id NULL). No change to 008.**

### Data scripts (written; permanently fixture-only, AWS descoped)
- `009_phase5_ddq_history.js`: `supplier_questionnaires` → finalized read-only assessments; `supplier_questionnaire_responses` → responses (`respondent_kind='external'`); **recomputes score/risk_rating with the exact legacy math and diffs vs stored** (mismatch → quarantine); `external_assessment_tokens` from `external_*` (token stored as sha256 hash, expiry/completion preserved); finalized DDQs → `evidence` on the A.5.19-A.5.23 family + `proposed_changes` (`source='external_respondent'`, never direct status writes).
- `010_phase5_schedules.js`: `recurring_questionnaire_schedules` + `supplier_reviews` → `assessment_schedules` (`cadence_months`→`cadence`, `tier_filter`/`contact_role`→`trigger_rule` JSON). Retirement of `recurring_questionnaire_schedules` (view-then-drop) is deferred/gated.

### Fixture validation `migrations/fixtures/phase5_validate.js` — 15/15 PASS
Match DDQ (stored == recomputed) → not quarantined, finalized assessment + 15 responses; mismatch DDQ → score quarantine; external token issued (sha256 hash, expiry + completion preserved); proposed_changes (5) + evidence links (5) for the workspace's supplier-control instances; recurring schedule → `annual` `assessment_schedule`; supplier_review → `assessment_schedule`. **Score math verified exact** (computed 67/medium == stored). Plus the gap-closure checks: `template_version` snapshot exploded (2 questions → retired v99 set), `question_bank` entries migrated (2, tags preserved, iso ref mapped).

### Dry-run replay — full chain through Phase 5 on a pristine legacy-state copy
`replay.js` updated to run 008/009/010. Re-ran the entire chain against a fresh pre-phase-0 copy: all reconciliations PASS; Phase 5 structural produced 14 supplier entities + 3 question_sets; 009/010 produced 0 (no legacy DDQ/schedule data). Final: question_sets 5 (1 ISO + 1 CSF + 3 supplier), questions 331 (159 + 106 + 66).

### Dev state: STRUCTURAL ONLY
009/010 not run on dev (0 questionnaires/schedules). Dev: 14 supplier entities, 3 supplier question_sets, 0 DDQ assessments / tokens / schedules, phase5 quarantine 0. Smoke 45/45.

### Gate
- Score recompute: validated exact on fixtures; no real historical DDQ data exists anywhere (AWS descoped), so the fixture diff is the only validation.
- External-token flow: issue / answer / expire / revoke fields preserved + represented (lifecycle fixture PASS).

### Reversibility
`DELETE FROM assessment_schedules WHERE migrated_from LIKE 'recurring_%' OR migrated_from LIKE 'supplier_reviews:%'; DELETE FROM external_assessment_tokens; DELETE FROM responses/assessments/proposed_changes/evidence_requirement_links by their DDQ migrated_from; DELETE supplier question_sets/questions; reset suppliers.entity_id + delete supplier entities; DELETE FROM migration_quarantine WHERE phase='phase5';` drop `external_assessment_tokens` + remove migration 006/007 + data 008-010 files. The added columns (`cloned_from`, `tags`, `migrated_from`) are additive and may stay. No pre-existing table altered.

---

## Phase 6 — Unified remediation pipeline (2026-06-10)

**Real dev data migrated** for 4 trackers; CSF / risk / supplier-dedup paths written + fixture-proven (0 dev rows). Decisions applied (Vijay): `risk_treatments` + `risk_treatment_actions` retire with no successor (actions → `remediation_actions` hung off a per-risk finding `source_type='risk'`); `supplier_findings` dedup on `nonconformity_id` (ambiguous → quarantine); `severity_scheme` per-source/per-row; `audit_observations` keep a **distinct `observation` severity** (not flattened to minor NC).

### What changed
- Backup: `backups/2026-06-10-pre-phase-6.db` (integrity `ok`).
- Schema `migrations/008_phase6_remediation.sql`: `findings`, `finding_controls`, `firm_recommendation_library`, `recommendations`, `roadmap_phases`, `remediation_actions`.
- Backfill `migrations/data/011_phase6_remediation.js` (idempotent): **71 findings, 53 finding_controls, 3 quarantined**.

### Per-source × per-workspace reconciliation (legacy total → migrated; exact)
| Source | Legacy | Migrated | Quarantined | Per-workspace (migrated) |
|---|---|---|---|---|
| nonconformities | 17 | 17 | 0 | 16:6, 17:2, 31:4, 32:5 |
| audit_findings | 22 | 21 | 1 | 16:6 (5 + 1 lost-parent), 31:8, 32:7 |
| audit_observations | 16 | 16 | 0 | 16:8, 31:8 |
| improvements | 17 | 17 | 0 | 16:4, 17:2, 31:5, 32:6 |
| csf_findings | 2 | 0 | 2 (seed) | — |
| risk_treatment_actions | 0 | 0 | 0 | fixture-only |
| supplier_findings | 0 | 0 | 0 | fixture-only |

### Severity mapping (shown per your request)
| Source | severity | severity_scheme | n |
|---|---|---|---|
| nonconformities | minor / major | `nc` | 15 / 2 |
| audit_findings | low / medium | `hml` | 10 / 9 |
| audit_findings | minor | `nc` | 2 |
| audit_observations | **observation** | `nc` | 16 |
| improvements | medium (default) | `hml` | 17 |

### Orphaned audit_findings disposition (your refinement: content rows, not auto-quarantined)
- **id 1** (`description='test'`, no iso ref) → quarantined as seed-like.
- **id 2** (`"2 of 12 sampled accounts exceeded the 1-day leaver-revocation SLA"`, `annex-a.5.18`) → **migrated** as genuine: `source_id=NULL`, description prefixed `[lost parent audit_id=2]`, `migrated_from='audit_findings:2'`, landed in ws16 (derived from the iso requirement's control instances).

### Fixture validation `migrations/fixtures/phase6_validate.js` — 8/8 PASS
Real CSF `engagement→finding→recommendation→remediation_status` chain migrates end-to-end (so the replay chain re-executes a proven CSF path as no-op-safe insurance); `supplier_finding` with matching `nonconformity_id` → **merged into the existing NC finding, no duplicate** + DEDUP quarantine note; dangling `nonconformity_id` → AMBIGUOUS quarantine; `risk_treatment_action` → per-risk `source_type='risk'` finding + `remediation_action`.

### Dry-run replay + dev state
`replay.js` updated to run 011. Full chain on a pristine legacy copy → findings 71, finding_controls 53, phase6 quarantine 3 (matches dev). Smoke 45/45.

### Reversibility
`DELETE FROM remediation_actions; DELETE FROM recommendations; DELETE FROM finding_controls; DELETE FROM findings; DELETE FROM migration_quarantine WHERE phase='phase6';` drop the 6 tables + remove migration 008 + data 011 files. No pre-existing table altered.

---

## Phase 7 — Exceptions register (additive half) (2026-06-10)

- Backup: `backups/2026-06-10-pre-phase-7.db` (integrity `ok`).
- Schema `migrations/009_phase7_exceptions.sql`: `control_exceptions` (+ `idx_exceptions_ws`). `risk_acceptance_id` is a **NOT NULL FK** (structurally mandatory per the brief).
- **No backfill** — forward-only register. No legacy source: `risk_acceptances` has 0 dev rows, and excluded controls are out-of-scope (not exceptions). Dev `control_exceptions` = 0 rows.
- **Expiry wiring** `migrations/data/012_phase7_exception_expiry.js` (additive job; mirrors `lib/jobs.js` `notify()` contract, edits no app code; wired into `replay.js`): (1) factual auto-expiry `active`→`expired` past `expiry`; (2) raises a workspace `notifications` row (`category='control_exception_expired'`) for expired-but-unreviewed exceptions, with the same dedup guard as the existing review-reminder jobs. `under_review` and future exceptions are left alone.
- Fixture `migrations/fixtures/phase7_validate.js` — **7/7 PASS**: FK linkage, `state` CHECK, mandatory `risk_acceptance_id`; expiry job auto-expires the active+past row, leaves future `active` + expired `under_review` untouched, and raises exactly 1 notification across two runs (dedup).
- **Still GATED (app integration, not built):** registering `012` as a scheduled job in `lib/jobs.js`, and the consultant-dashboard read of these notifications.

### Reversibility
`DELETE FROM notifications WHERE category='control_exception_expired'; DROP TABLE control_exceptions;` + remove migration 009 + data 012 files. No pre-existing table altered.

---

## Cutover 1 of 5 — evidence reads (branch `feat/cutover-1-evidence-reads`, 2026-06-11)

**Scope:** switch evidence→control/requirement READ paths off the demolition-scheduled join tables (`evidence_controls`, `evidence_links`) onto the converged `evidence_requirement_links`, behind the per-workspace flag `evidence_reads_converged`. WRITES STAY LEGACY (that is cutover 2). Smallest blast radius first per the standing cutover order.

**Procedure executed:**
- Backup gate: `backups/iso27001-20260610-211444` via `scripts/dev-backup.js`; `backup_runs` id 237 `status='ok'`, freshness query returns 1.
- Re-ran the idempotent Phase 2 backfill (`migrations/data/003_phase2_backfill.js`): no change (erl 165 → 165; 165 ec ok / 21 orphaned-evidence quarantined, 165 el ok / 1 quarantined, 31 CSF seed). Link-set symmetric difference legacy vs converged = 0/0.
- Code: `lib/evidence-reads.js` (per-workspace flag helper + converged read functions; `readsConverged` FAILS SAFE to legacy when `feature_flags` / the converged schema is absent, e.g. a fresh boot or the test harness) plus 8 read sites in `server.js` dual-pathed. Legacy SQL is preserved verbatim on the `converged=false` branch. The two write-coupled surfaces (evidence-library unlink / section-edit) keep the legacy `link_id` handle on the converged path so the still-legacy writes keep working.

**Read sites switched (→ screen):** evidence-library `link_count` + ISO chips + cross-framework chips (`/workspaces/:id/evidence`); control-detail evidence panel (`/controls/assess/:isoId`); evidence-coverage matrix + CSV (`/evidence-coverage[.csv]`); evidence pack + readiness-pack manifests (`evidence/pack.zip`, `export/readiness-pack.zip`); audit checklist-from-soa counts. Sites that read only the core `evidence` table (file counts, primary-path `evidence.iso_item_id`, audit-pack index, auditor portal) are already framework-agnostic and were left untouched; the coverage `UNION ALL` keeps its primary-path half (core table) and switches only the join half, preserving the legacy double-count exactly.

**Parity proof (the gate):**
- Query-level (`migrations/fixtures/cutover1_evidence_parity.js`, read-only, flag-independent): legacy vs converged deep-equal across **all 5 workspaces × 6 read surfaces = 30/30 identical**; pack manifests byte-identical.
- Render-level (real app booted against a consistent `.backup` snapshot copy; pilot ws16; flag ON vs OFF in one session): **4/4 evidence screens render byte-identical HTML** (evidence library 1,156,049 B, coverage 213,361 B, coverage CSV 8,429 B, control-detail panel identical apart from one per-request random widget id `data-mention-id`, which differs between any two renders).
- Suite: smoke 45/0, node:test 25/0; zero new failures vs the `b7deabf` baseline.

**Flip state:** pilot ws16 flipped and proven first, then the rest. `feature_flags.evidence_reads_converged=1` for ws 16/17/30/31/32 (every current workspace). New workspaces default to legacy (no row) until flipped. Revert is instant and data-safe: set the flags to 0 (or delete the rows) and reads fall back to legacy.

**Caveat, and the dependency on cutover 2 (writes):** while reads are converged but writes are legacy, a NEW link write (upload / link / supersede) updates `evidence_controls`/`evidence_links` but NOT `evidence_requirement_links`, so converged reads will not reflect it until the backfill re-runs. Cutover 1 therefore relies on the standing "no feature work on a module during its cutover window" freeze (linkage writes quiesced), and must be followed by cutover 2 (writes → erl, or an `evidence_controls→erl` sync trigger mirroring the existing `evctrl_to_evlinks_*` triggers) to lift the freeze. Interim mitigation if a linkage write does happen: re-run the Phase 2 backfill to resync.

**Gate status:** parity PASS (query 30/30 + render 4/4), suite green, backup fresh. STOPPED at the verification gate for review before cutover 2. Phase 2 demolition (drop `evidence_controls`/`evidence_links` + the `evctrl_to_evlinks_*` triggers) stays gated on cutover 2 plus the standing demolition gate.

---

## Cutover 2 of 5 — evidence writes (branch `feat/cutover-2-evidence-writes`, 2026-06-11)

**Scope:** move evidence-linkage WRITES (create, link, edit note, supersede, unlink, delete) off the legacy join tables onto `evidence_requirement_links` (erl), behind a second per-workspace flag `evidence_writes_converged`. A temporary new→legacy trigger keeps the legacy tables a faithful shadow of erl so they can still be demolished safely. This lifts the cutover-1 read/write-split freeze.

**Pre-cutover-2 confirmations:** (1) cutover-1 parity evidence is in this file (query 30/30 + render 4/4, pilot ws16, full flip). (2) all 5 workspaces have `evidence_reads_converged=1`. (3) the `recurringQuestionnaires` scheduler job does NOT exist on `main` (it is WIP-only on `fix/audit-hardening-2026-06`); the only questionnaire job on main, `questionnaireResponseReminders`, just reads + notifies and nothing writes `recurring_questionnaire_schedules`, so there is no scheduler job on the cutover line to disable. The freeze rule stays recorded for the Phase 5 rebuild.

**Procedure executed:**
- Backup gate: `backups/iso27001-20260611-030755` via `scripts/dev-backup.js`; `backup_runs` 238 `status='ok'`, freshness query = 1.
- Sync trigger: migration `010_cutover2_evidence_write_sync.sql` (applied via the runner; `schema_migrations` records it). Creates `erl_to_legacy_ins` / `_del` / `_upd` AFTER triggers on `evidence_requirement_links` that mirror every erl write into `evidence_controls` (ISO 27001) and `evidence_links` (all frameworks). `recursive_triggers` is OFF, so they write both legacy tables directly rather than chaining through `evctrl_to_evlinks_*`; `INSERT OR IGNORE` keeps them idempotent. **DEMOLITION DATE: drop these three triggers at the Phase 2 demolition step, together with `evidence_controls` + `evidence_links` (recorded at creation time per the standing rule).**
- Final idempotent Phase 2 backfill re-run (point-in-time current at switch): erl 165, link-set symmetric difference 0/0.
- Code: `lib/evidence-writes.js` (per-workspace `writesConverged` flag helper, fails safe to legacy; one helper per write op, legacy SQL verbatim on the `conv=false` branch) wired into 8 write routes in `server.js`. The hard-delete route is unchanged: deleting the `evidence` row FK-cascades to erl + ec + el (with `recursive_triggers` OFF the cascade does not re-fire the sync trigger). Writes resolve the legacy `link_id` handle (which the cutover-1 read still exposes) to the erl row; the trigger mirrors the change back to legacy.

**Verification (the gate):**
- E2E write consistency (real app booted on a snapshot copy, pilot ws16 write-flipped, driven through the live HTTP routes): **18/18 checks PASS** across upload → link → edit note → supersede → unlink → delete; after EVERY operation the legacy join tables and erl are row-consistent (link-set symmetric difference 0 and `section_ref` aligned), and the specific link appears in erl + `evidence_controls` + `evidence_links`. Created test files cleaned up; the live dev DB was not touched by the E2E (it ran on a copy).
- Committed read-only checker `migrations/fixtures/cutover2_consistency_check.js`: link-set symmetric difference 0/0 + ISO/cross-framework `section_ref` drift 0 on the live dev DB. Re-run this before demolition.
- Suite: smoke 45/0, node:test 25/0; zero new failures vs the `b7deabf` baseline (fresh boots / tests have no `feature_flags` table, so `writesConverged` returns false and writes stay legacy).

**Flip state:** pilot ws16 flipped + proven first (per-workspace gating confirmed: ws16 writes=true, others false), then ws 17/30/31/32. `feature_flags.evidence_writes_converged=1` for every current workspace (alongside the cutover-1 read flags). New workspaces default to legacy writes until flipped. Revert is data-safe: set the write flags to 0 and writes fall back to legacy (the trigger simply stops receiving erl writes; legacy stays current because legacy writes resume).

**Transitional note for demolition:** the unlink / section-edit converged writes resolve the legacy `evidence_controls.id` / `evidence_links.id` handle that the cutover-1 read still renders. At Phase 2 demolition the read must switch to an erl-native handle (`evidence_requirement_links.id`) and that legacy resolution be removed, in the same change that drops the legacy tables + all four triggers.

**Gate status:** E2E consistency PASS (18/18), checker PASS, suite green, backup fresh. STOPPED at the verification gate for review. Phase 2 demolition stays gated on this cutover landing on `main` plus the standing demolition gate (per-module parity + latest `backup_runs` ok and < 24h + Vijay's approval).

---

## Cutover 3 of 5: control-instance reads (branch `feat/cutover-3-instance-reads`, 2026-06-11)

**Scope:** switch control-state + document-link READ paths off `control_states` / `iso42001_control_states` / `document_controls` / `iso42001_document_controls` onto the converged `control_instances` / `document_requirement_links`, behind the per-workspace flag `control_reads_converged`. Widest blast radius in the program (~100 read sites), run in stages. WRITES stay legacy (cutover 4). Control-state HISTORY reads deferred to Phase 4 (see manifest).

**Mechanism:** compatibility views (migration `012_phase3_compat_views.sql`): `v_control_states` / `v_iso42001_control_states` present `control_instances` with the LEGACY column names and DE-NORMALIZED display values (whole-org only, `entity_id IS NULL`); `v_document_controls` / `v_iso42001_document_controls` present `document_requirement_links`. De-normalization FAILS LOUD (`'!!UNMAPPED:<value>'`, never a silent fallback). Reads swap the table NAME via `lib/control-reads.js` (`control_reads_converged`, fail-safe to legacy), so query structure and rendered output are unchanged. Views applied at merge-boot via the startup runner (not run on live dev pre-merge, to avoid prematurely executing the still-pending evidence-demolition 011).

**Stage 1:** backup gate ok; Phase 3 backfill idempotent (`control_instances` 434/0 quarantined, `document_requirement_links` 193/14 orphan); **histogram reconciliation 0 mismatched status/applicability buckets, 0 `!!UNMAPPED`, doc-links 193=193**; view-vs-legacy parity 0/0 on display columns, `last_updated` preserved.

**Stage 2 (Increment 1) converted + verified:** SoA (27001+42001 render + CSV + auditor + snapshot/metadata), control list/detail screens, crosswalks, controls_assess_summary, dashboard/roadmap/badge/progress, `computeReadiness`, `computeIso42001Readiness`, iso42001/roadmap, ISMS performance metrics + 30-day trends, evidence-coverage matrix + CSV, SoA snapshot capture, audit-pack/recommendations/controls/kanban CSV exports, member-profile + asset-detail panels, `computeNextStep` + `computeNeedsAttention`, documents-library tagged-items, `lib/reports.js`, `lib/audit-pack.js`, `lib/fts.js` (drift COUNT + refresh + rebuildAll), auditor + documents-library doc consumers. **(Increment 2)** gap-assessment CURRENT-STATE reads (assessedNow, Annex A heatmap, summary.docx, iso42001 gap counts).

**Evidence ledger:**
- **SoA byte-comparison** (pilot ws16, flag OFF vs ON, both frameworks): 4/4 BYTE-IDENTICAL (with the backfill re-run at switch).
- **Function deep-diff** (flag OFF vs ON, JSON equality, ALL 5 workspaces): `computeReadiness` + `buildContext` + `computeIso42001Readiness` identical.
- **Render parity** (flag OFF vs ON, ALL 5 workspaces): dashboard, controls list, summary, crosswalks, documents, review-queue, readiness/auditor, roadmap, gap-assessment byte-identical.
- **FTS** drift COUNT + `rebuildAll` control index match; **`lib/reports` buildContext** byte-identical.
- Suite green throughout (smoke 45/0, node:test 25/0).

**Findings (recorded as doctrine):** (1) `'Work In Progress'` was app-producible but missing from the Phase 3 STATUS map -> closed in backfill + views; writable-vocabulary audit confirms all 6 statuses + 3 applicabilities round-trip. (2) Re-backfill-at-switch is load-bearing (the 42001 SoA `last_updated` failure). (3) Truncation-without-ordering: `computeReadiness` flag item-lists differed on ws31/ws32 only (no `ORDER BY`); fixed; bug-class hunt run across all unconverted reads (no second instance).

**Stage 3:** backup `backup_runs` 242 ok; re-backfill at switch; **all 5 workspaces flipped** `control_reads_converged=1`; full suite green.

### DEFERRAL MANIFEST (reads intentionally left on legacy; the Phase 4 / cutover-4 cutovers inherit these)
- **Write / read-modify-write paths -> cutover 4 (writes):** `getOrCreateState` (27001 + 42001); `nextUnassessedItem` / `nextUnassessed42` wizard nav; the assess-wizard detail reads; control status/review save; SoA save/bulk/auto-justify; doc-link add/unlink writes and the control-detail doc panels that render the actionable `link_id`; checklist-from-soa (creates `audit_observations`); control-save `last_updated` reads.
- **Review-workflow columns -> cutover 4 (or a review-converged design):** review-queue (27001 + 42001) and review-detail read `review_requested_by` / `reviewed_by` / `reviewed_at` / `review_reason`, which `control_instances` does NOT track (the compat view exposes them as NULL). Converting would change rendered output, so they stay legacy until the review workflow is modelled on the converged schema.
- **`assessment_passes` / `control_state_history` coupled -> Phase 4 (assessment-engine cutover):** the control-history screen, gap-assessment diff / trend / velocity / orientation / controlsTouched. They read `control_state_history` JOIN `assessment_passes` (pass-snapshot model). The converged `control_instance_history` is a change-log with no `pass_id`, so these are not byte-equivalent until the engine cutover. ~20 `control_state_history` read sites.

**Demolition split (later):** `control_states` / `iso42001_control_states` / `entity_control_states` (dead) / `document_controls` / `iso42001_document_controls` demolish after cutover 4 (writes) + the standing demolition gate; `control_state_history` / `iso42001_control_state_history` demolish only after the Phase 4 engine cutover lifts the manifest's history items.

**Gate status:** Stages 1-3 complete; SoA byte 4/4, deep-diff + render parity across all workspaces, suite green, backup fresh, flags flipped. STOPPED at the verification gate for review. Views + flags activate at merge-boot.

---

## Phase 2 demolition — evidence join tables (branch `feat/phase2-demolition-evidence`, 2026-06-11)

The FIRST demolition of the program; it sets the playbook below.

**Preconditions (met):** `backup_runs` 239 `ok` (< 24h); `cutover2_consistency_check.js` 0/0 symmetric difference + 0 section drift on live dev; full code-reference audit of `evidence_controls` / `evidence_links` (every live reference repointed; see the audit in the cutover-2 handoff).

**Architectural finding + decision:** `db.js init()` (run on every server start, server.js) recreated `evidence_controls` / `evidence_links` + the `evctrl_to_evlinks_*` triggers on every boot, and did NOT build the converged schema (whose catalog seed lives in a manual data backfill). So a migration-only drop would be undone on the next restart (proven empirically). Decision (Vijay, Option 2): **wire the migration runner into app startup so the chain is the single source of truth for the schema**, and remove the legacy DDL from `db.js`.

**What changed:**
- `migrations/run.js`: extracted `applyPending(db)`; `db.js init()` now calls it after the hand-written core schema. Only PENDING migrations run (warm boots near-instant); a pristine DB runs the full chain once. It THROWS on the first failing migration, so a half-migrated DB refuses to serve (fail loud).
- `db.js init()`: removed the `evidence_controls` / `evidence_links` CREATE + indexes + backfills + the three `evctrl_to_evlinks_*` triggers.
- `migrations/011_phase2_demolition_evidence_joins.sql`: drops the six triggers (`erl_to_legacy_*` + `evctrl_to_evlinks_*`) then `evidence_controls` + `evidence_links`, all `IF EXISTS`. Coherent on both the warm dev DB and a pristine DB (CREATE TRIGGER resolves referenced tables lazily, so migration 010 still applies before 011 drops it).
- `lib/evidence-reads.js` + `lib/evidence-writes.js`: collapsed to erl-only (legacy branches + the feature-flag check removed). The actionable link handle is now `evidence_requirement_links.id` (erl-native); unlink / section-edit operate on erl directly.
- `server.js`: read/write sites call the erl-only helpers; demo seeders (`seed-demo-clients.js`, `seed-realistic-engagements.js`) repointed to erl via `attachIsoControl` / `evidence_requirement_links`; coverage help text updated. `cutover2_consistency_check.js` is now historical (it reads the dropped tables).

**Verification:**
- Suite green: smoke 45/0, node:test 25/0. Fresh test boots run the FULL chain including the demolition, so the suite exercises the erl-only end state.
- Timing: cold fresh-boot `init()` total (core schema + seed + full 11-migration chain) 120 ms; warm chain 0.2 ms (0 pending). Under the ~2s threshold, so no baseline-snapshot optimization built (per the standing decision).
- Post-drop E2E (real app on a snapshot copy where 011 auto-applied at boot): **12/12 PASS**. `evidence_controls` + `evidence_links` gone, no sync triggers remain, and upload → link → edit note → supersede → unlink → delete all work erl-only; the library renders 200.

**Execution model (why the live DB is not yet demolished):** the drop is a pending migration; it AUTO-APPLIES at the first boot of the merged code (db.init -> applyPending -> 011). It was applied + proven only on a COPY. The live instance of record still has `evidence_controls` / `evidence_links` (consistency 0/0), so during review it works under both `main` and this branch and stays fully revertible (backup 239). The live drop happens when the merged code first boots, after approval.

**DEMOLITION PLAYBOOK (standing, Vijay):** every subsequent module demolition = drop the legacy tables via the runner + remove that module's legacy DDL from `db.js init()` in the SAME PR, so `init()` shrinks monotonically toward zero hand-written legacy DDL while the migration chain remains the single source of truth. End-state note: once all demolitions land, consider collapsing the chain into a single baseline migration for fresh installs (decide then, not now).

---

## Cleanup pass — GATED (cutover gate: full test suite green on `main`, satisfied once PR #24 merges; then per demolition: per-module cutover parity + latest `backup_runs` `ok` and under 24h + Vijay's explicit approval. `fix/audit-hardening-2026-06` decoupled. AWS descoped.)

Demolitions in dependency order:
1. ~~**Phase 2:** drop `evidence_controls` + `evidence_links` + the 6 triggers; switch the link handle to `evidence_requirement_links.id`.~~ **DONE** (2026-06-11, migration 011 + `db.js` legacy DDL removed + erl-native code). Executes on live at the first boot after merge. See "Phase 2 demolition" above. This established the demolition playbook (drop via runner + remove legacy DDL from `db.js init()` in the same PR).
2. **Phase 3:** drop `control_states`, `entity_control_states`, `iso42001_control_states`, `control_state_history`, `iso42001_control_state_history`, `document_controls`, `iso42001_document_controls`.
3. **Phase 4:** drop `assessment_answers` columns, `assessment_passes` (+ `iso42001_assessment_passes`), and the `csf_*` engine tables. The CSF port is fixture-only (no real data; AWS descoped).
4. **Phase 5:** drop `recurring_questionnaire_schedules`, `supplier_questionnaires`(+responses), `questionnaire_templates`/`_questions`/`_template_versions`/`_question_bank`, `supplier_reviews` — after the DDQ cutover.
5. **Phase 6:** drop `csf_findings`/`csf_recommendations`/`csf_remediation_status`, `audit_findings`/`audit_observations`, `nonconformities`, `risk_treatment_actions`, `risk_treatments`, `improvements`, `supplier_findings`.
6. `framework_mappings` is **retained** (option b: the crosswalk screen still reads it) unless/until that screen is re-pointed at `requirement_mappings`.
7. Remove transitional triggers + dual-write code + compatibility views whose consumers are gone; regenerate `schema_current.sql` and commit as the new schema of record.
