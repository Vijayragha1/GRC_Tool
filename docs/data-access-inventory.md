# Data-access inventory

This document maps each migration-critical table to the code that reads and writes it, for the GRC platform migration. All database access in this app is hand-written raw SQL via better-sqlite3 prepared statements: there is NO ORM, so every reference below is a literal `FROM` / `INTO` / `UPDATE` / `JOIN` against the named table. References are concise (file plus representative line numbers), not exhaustive. Schema (CREATE TABLE) lives in `db.js`.

Date: 2026-06-10

Refs are line numbers at time of writing on branch `fix/audit-hardening-2026-06`. Views (.ejs) consume route-passed data and contain no SQL; the "screens/views" column is inferred from the route's `res.render(...)`.

## Core / tenancy

| table | written by (INSERT/UPDATE/DELETE) | read by (SELECT/JOIN) | screens/views | notes |
|---|---|---|---|---|
| workspaces | server.js (INSERT L2208; UPDATE L2386/L2391/L2573/L10651/L15567; DELETE L2447); routes/tenants.js (DELETE L169); routes/engagement.js (UPDATE L55/L61/L128/L142) | server.js (many: e.g. L432, L506, L747, L917, L9841, L15261); lib/*.js (audit-pack L70, jobs L29/L51/L263, reports L13); routes/auditor.js L47; routes/tenants.js L66/L155 | dashboard, workspace, intake, engagement screens | Tenant root: nearly every route filters by `workspace_id`. Very high blast radius. |
| firms | server.js (INSERT L86 via tenants); routes/tenants.js (INSERT L86, UPDATE L127, DELETE L180) | server.js (many: e.g. L346, L381, L721, L1005, L5228, L10725, L12371); routes/auditor.js L98/L235; lib/audit-pack.js L72 | firm_library, admin screens, branded headers | Firm = consultancy tenant above workspace. |
| audit_log | db.js (INSERT via logging helper); server.js append-only writes through helper | server.js (many: e.g. L1549, L2304, L7236, L10035, L11465, L13529, L13544); routes/auditor.js L270; lib/audit-pack.js L223; lib/changes-since.js L137 | audit_timeline, audit_anomalies, audit_chain_verify, audit_pack | Append-only activity log; feeds audit pack and anomaly detection. |
| audit_chain | db.js (INSERT L3722; CREATE L1111) | db.js (SELECT L3712 prev hash; JOIN L3732 for verify) | audit_chain_verify | Hash-chain integrity over audit_log, entirely managed in db.js. NOT dead despite zero hits in server/routes/lib. |
| entities | none (read-only in app code) | server.js (JOIN only: L4046, L4176, L4346, L10548, L13377) | risks, risk_detail, soa_snapshots list | Multi-entity grouping; joined for display of entity_name only. No app-level INSERT/UPDATE/DELETE found: seeded/managed outside the grepped code (or schema-only). Migration: verify seeding path. |

## ISO 27001 catalog & state

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| iso_items | none (catalog, seeded in db.js) | server.js (many: e.g. L517, L2075, L2859, L4663, L5403, L6440, L8745, L14056); lib/reports.js L24/L74; lib/fts.js L76; lib/audit-pack.js L112; routes/auditor.js L117/L200/L211 | controls, controls_assess, soa, control_history, gap_assessment, audit_detail | Static ISO 27001 clause/control catalog (`type` in clause/control). Read-only reference; highest read fan-out. |
| control_states | server.js (INSERT OR IGNORE L582/L3168/L4650/L4750/L4781/L6005; UPDATE L3087/L3169/L3203/L4624/L4724/L4751/L6049/L6078/L13622) | server.js (many: e.g. L490, L566, L2354, L4502, L6179, L8589, L10116, L13432); lib/reports.js L23/L27; lib/fts.js L120/L163; lib/jobs.js L224; lib/audit-pack.js L113; routes/auditor.js L87/L117; routes/tenants.js L52 | controls_assess, controls_assess_summary, soa, readiness, dashboard | Per-workspace SoA applicability/status/maturity. Heavily referenced; top migration blast radius. |
| control_state_history | server.js (INSERT L3110) | server.js (L2986, L3005, L3263, L3295, L3315, L3467, L3528, L11160, L12822) | control_history, gap_assessment_diff, readiness (velocity) | Append-on-change history; `pass_id` ties to assessment_passes. |
| framework_mappings | none (seeded from data/framework-mappings.js) | server.js (L2969, L4835, L6097) | controls_assess (crosswalk refs), soa | Crosswalk ISO item -> external framework ref. Read-only. |

## ISO 42001

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| iso42001_items | none (catalog, seeded in db.js) | server.js (L3704, L3943, L10002, L14226, L14242, L14258, L14283, L14495, L14725, L15016, L15240) | iso42001_controls, iso42001_gap_assessment, iso42001_soa | ISO 42001 clause/control catalog. Read-only reference. |
| iso42001_control_states | server.js (INSERT OR IGNORE L14218/L14282/L14384/L14536/L14919; UPDATE L14271/L14394/L14521/L14540/L14863/L14920/L14937/L15136/L15534) | server.js (L491, L10001, L14219, L14243, L14676, L15056, L15157, L15224) | iso42001_controls, iso42001_soa, iso42001_gap_assessment | Per-workspace AI-management-system control state. |
| iso42001_control_state_history | server.js (INSERT L14887) | server.js (L14805, L15391, L15393) | iso42001 control history / velocity | History for 42001 control states. |

## CSF engine

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| csf_functions | none (catalog, seeded in db.js) | server.js (L11354, L11578, L11599, L11665, L11679); lib/csf-scoring.js L85; lib/csf-versioning.js L92 | csf_catalog, csf_engagement_detail, csf_scores | NIST CSF function catalog (by catalog_version). |
| csf_categories | none (catalog) | server.js (L11355, L11577, L11664, L11678); lib/csf-scoring.js L86; lib/csf-versioning.js L93 | csf_catalog, csf_engagement_detail | CSF category catalog. |
| csf_subcategories | none (catalog) | server.js (many: L3669, L3706, L3946, L11333, L11356, L11432, L11576, L11663, L12143); lib/csf-policy.js L203; lib/csf-scoring.js L87 | csf_catalog, csf_assess_detail, evidence (csf refs) | CSF subcategory catalog. |
| csf_engagements | server.js (INSERT L11318; UPDATE L11337/L11527/L12092/L12108) | server.js (L11277, L11382, L11506, L11549, L12304, L12336, L15336); lib/csf-versioning.js L89 | csf_engagements, csf_engagement_detail | CSF assessment engagement (per workspace). |
| csf_subcategory_assessments | server.js (INSERT L11852-trigger via evidence; UPDATE L11624/L11641/L11801/L11823/L11858/L12050); lib/csf-policy.js (INSERT L204) | server.js (many: L11405, L11431, L11574, L11662, L11750, L11921, L15345); lib/csf-reports.js L293; lib/csf-scoring.js L93; lib/csf-versioning.js L33 | csf_assess, csf_assess_detail, csf_scores | Per-subcategory score/status. Core CSF state. |
| csf_findings | server.js (INSERT L11915; UPDATE L11947/L11960) | server.js (L11445, L11453, L11695, L11886, L11931, L11970, L12289, L12343); lib/csf-reports.js L49/L294; lib/csf-versioning.js L50 | csf_findings, csf_engagement_detail | CSF findings per assessment/engagement. |
| csf_recommendations | server.js (INSERT L11978; UPDATE L12005/L12022) | server.js (L11457, L11991, L12017, L12315); lib/csf-reports.js L55; lib/csf-versioning.js L68 | csf_findings, csf_portal (roadmap) | Remediation recommendations under findings. |
| csf_remediation_status | server.js (INSERT/UPSERT L12322) | server.js (JOIN L12280) | csf_portal (client remediation) | Client-side remediation tracking per recommendation. |
| csf_evidence_items | server.js (INSERT L11852; UPDATE soft-delete L11871) | server.js (L11434, L11574, L11670); lib/csf-reports.js L293 | csf_assess_detail | Evidence attached to a CSF subcategory assessment. |
| csf_subcategory_iso_refs | none (seeded mapping) | server.js (L11357, L11671) | csf_assess_detail, csf_catalog | Maps CSF subcategory -> ISO/other refs. Read-only. |

## SOC 2

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| soc2_engagements | server.js (INSERT L15685; UPDATE L15744) | server.js (L15633, L15662) | soc2_home, soc2_engagement | SOC 2 audit engagement per workspace. |
| soc2_requests | server.js (INSERT L15770; UPDATE L15815/L15835) | server.js (L15664, L15706, L15767, L15786, L15807, L15826, L15848, L15874, L15893, L15902) | soc2_engagement, soc2_request | Evidence/PBC request items. |
| soc2_request_evidence | server.js (INSERT L15855/L15860/L15864; DELETE L15884) | server.js (L15790, L15876, L15891) | soc2_request | Files/URLs/notes submitted against a request. |
| soc2_request_comments | server.js (INSERT L15839/L15908) | server.js (L15793) | soc2_request | Threaded comments on a request (internal/shared). |
| soc2_request_activity | server.js (INSERT L15644) | server.js (L15795) | soc2_request | Activity/audit trail per request. |

## Evidence

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| evidence | server.js (INSERT/UPDATE in upload + supersede flows; see lib/fts.js indexing) | server.js (L2936, L3608, L8955, L9016, L14009); referenced by evidence_controls joins | evidence_library, evidence_coverage, auditor_evidence | Evidence records (workspace-scoped, supersede via superseded_at). Note: not in `search_index` feeders (only control/risk/asset/document/supplier/incident are indexed). |
| evidence_controls | server.js (INSERT OR IGNORE L3750/L3768/L3795/L3810/L3847/L3982; UPDATE L4001; DELETE L4011) | server.js (L2936, L2941, L3608, L3650, L3845, L3867, L8955, L9016, L12983, L14009) | evidence_library, evidence_coverage | Links evidence -> ISO item (iso_item_id, section_ref). |
| evidence_links | server.js (INSERT OR IGNORE L3950; DELETE L3969) | server.js (L3667, L3966) | evidence_library (cross-framework tags) | Links evidence -> non-ISO27001 frameworks (framework, item_ref); guarded so iso27001 stays in evidence_controls. |

## Suppliers / DDQ

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| suppliers | server.js (INSERT L7818/L7875; UPDATE many: L7730/L7833/L8115/L8198/L8300/L8320; DELETE L8124) | server.js (many: e.g. L4354, L6185, L7726, L7913, L7991, L8050); lib/reports.js L80-L99; lib/fts.js L86/L130; lib/jobs.js L144/L268 | vendors, vendor_detail | Supplier/vendor master, lifecycle_stage + risk scores. High fan-out across TPRM. |
| supplier_questionnaires | server.js (INSERT L8370; UPDATE L13179/L13301/L8434); lib/supplier-questionnaires.js (INSERT L37) | server.js (L283, L7698, L7935, L8047, L8078, L8379, L13189, L13253); lib/jobs.js L204 | vendor_detail, vendor_questionnaire, external_questionnaire | DDQ instances sent to suppliers. |
| supplier_questionnaire_responses | server.js (UPSERT L8418/L13294) | server.js (L7763, L8385, L8462, L13264) | vendor_questionnaire, external_questionnaire | Per-question answers for a questionnaire instance. |
| questionnaire_templates | server.js (INSERT L10835/L10872; UPDATE L10862/L10887/L10899; archive via UPDATE) | server.js (L8052, L8079, L8367, L10809, L10825, L10849, L10869, L13191); lib/supplier-questionnaires.js L29 | questionnaire_templates, questionnaire_builder | DDQ template (firm-owned or is_system). |
| questionnaire_questions | server.js (INSERT L10875/L10910/L10963; UPDATE L10816/L10919/L10941; DELETE L10927) | server.js (L7762, L8369, L8384, L10815, L10851, L10949, L13263); lib/supplier-questionnaires.js L33 | questionnaire_builder, vendor_questionnaire | Questions belonging to a template. |
| questionnaire_template_versions | server.js (INSERT L10897) | server.js (L10852) | questionnaire_builder (version history) | Snapshot of template at publish. |
| questionnaire_question_bank | server.js (INSERT L10952; DELETE L10843) | server.js (L10853, L10960) | questionnaire_builder (insert from bank) | Reusable question library (firm/system). |
| recurring_questionnaire_schedules | server.js (INSERT L13235; UPDATE toggle L13242; DELETE L13246); lib/jobs.js (UPDATE last_sent L281) | server.js (L8053); lib/jobs.js L259 | soc2_home / TPRM ops (schedules list at L8053) | Cadence-based auto-send schedules; driven by lib/jobs.js. |
| supplier_findings | server.js (INSERT L8257/L8288; UPDATE L8268/L8290; DELETE L8278) | server.js (L7714, L7936, L7992, L8031, L8049, L8083, L8284, L8313) | vendor_detail, vendors | Findings raised against a supplier; can promote to nonconformities (L8288). |
| supplier_reviews | server.js (INSERT L8190) | server.js (L8051, L8067, L10406; review-recency subqueries L5912/L6850); routes lib reports usage indirect | vendor_detail | Periodic supplier review records (drives next_review_date). |
| supplier_contacts | server.js (INSERT L7881/L8231; UPDATE L8224/L8242; DELETE L8249) | server.js (L7939, L8082); lib/supplier-questionnaires.js L18 | vendor_detail | Supplier contact list (used for questionnaire delivery). |
| supplier_onboarding_items | server.js (INSERT L7662; UPDATE L8306) | server.js (L8087, L8298, L8312) | vendor_detail (onboarding checklist) | Onboarding checklist items per supplier. |

## Risk

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| risks | server.js (INSERT L4188/L4216/L4310/L11058; UPDATE L4399/L4598/L13674/L13773; DELETE L4641) | server.js (many: e.g. L1583, L2285, L4174, L5000, L7158, L8089, L10138); lib/fts.js L66/L110; lib/reports.js L52; lib/changes-since.js L71; routes/auditor.js L89/L150 | risks, risk_detail | Risk register. High fan-out (links to controls, assets, suppliers, entities). |
| risk_acceptances | server.js (INSERT L13669; UPDATE revoke L13770/L13773) | server.js (L4363, L8618, L10228, L10389, L13683, L13693, L13772); lib/reports.js L62 | risk_detail, risk_acceptances | Signed risk acceptances (residual_score, signature, expiry). |
| risk_treatments | server.js (INSERT L10470; UPDATE L10491; DELETE L10500) | server.js (L10460); lib/reports.js L57 | risk_detail, risk_treatments | Treatment plan entries per risk. |
| risk_treatment_actions | server.js (INSERT L4374; UPDATE L4387; DELETE L4407) | server.js (L1734, L4359, L5769, L6498, L10238, L10387, L12773) | risk_detail, risk_treatments | Actionable treatment tasks (due_date driven). |

## Remediation / findings

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| improvements | server.js (INSERT L5617; UPDATE L5628; DELETE L5642) | server.js (L5607, L10731, L5796); lib/audit-pack.js L182; lib/changes-since.js L126 | improvements | Continual-improvement register. |
| nonconformities | server.js (INSERT L5730/L5966/L7302/L8288; UPDATE L5997; DELETE L6030) | server.js (many: e.g. L1398, L2302, L4660, L5762, L5954, L11203, L15065); lib/fts.js L91/L135; lib/reports.js L31/L67; routes/auditor.js L216 | nonconformities, nonconformity_detail | NC register; sourced from audit findings and supplier findings. |
| audit_findings | server.js (INSERT L5715/L14130; UPDATE L5734/L14133) | server.js (L5559, L5579, L6599, L7199); lib/reports.js L74; lib/audit-pack.js L197; routes/auditor.js L210 | audit_detail, audit_pack | Findings raised inside an internal audit. |
| audit_observations | server.js (INSERT L14026/L14063/L14086; UPDATE L14092/L14106/L14115/L14133; DELETE L14099) | server.js (L5587, L14022, L14059, L14111, L14121) | audit_detail | Audit observations (can be promoted to findings). |

## Assessment passes

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| assessment_passes | server.js (INSERT L3237/L3382; UPDATE L3372/L3400/L3418/L3422/L3433) | server.js (L1423, L1584, L2335, L3219, L3265, L3448, L10105, L12811) | gap_assessment, gap_assessment_diff, readiness | Assessment "pass" sessions; control_state_history.pass_id links here. |

## Misc

| table | written by | read by | screens/views | notes |
|---|---|---|---|---|
| entity_control_states | none found | none found | none | ZERO references in server.js / routes / lib. Candidate dead/unused schema (see Coverage gaps). |
| soa_snapshots | server.js (INSERT L10532; UPDATE L12548) | server.js (L10547, L10560, L10584, L10591, L10662, L10724, L4700); lib/audit-pack.js L97; lib/changes-since.js L21/L35; routes/auditor.js L88/L107/L128/L133 | soa_snapshots, soa_snapshot_detail, soa_snapshot_diff, auditor_soa | Immutable SoA snapshots (payload + hash) for evidence/audit. |
| iso42001_soa_snapshots | server.js (INSERT L14338/L14369) | server.js (L14317, L14449, L14456, L14462, L14463) | iso42001_soa_snapshots, iso42001_soa_snapshot_diff | ISO 42001 SoA snapshots. |
| document_controls | server.js (INSERT OR IGNORE L5256/L5425/L5461; DELETE L5443/L5474) | server.js (L2749, L2952, L5038, L5063, L5398, L13388, L14006); routes/auditor.js L184/L199 | controls_assess, evidence_coverage, auditor_documents | Links generated docs -> ISO items. |
| iso42001_document_controls | server.js (INSERT OR IGNORE L14909; DELETE L14967) | server.js (L14304, L14785, L14793, L14963) | iso42001_controls, iso42001_soa | Links docs -> ISO 42001 items. |
| search_index | lib/fts.js (INSERT L13; DELETE L11/L18/L108) | lib/fts.js (SELECT/MATCH L46-L48; COUNT L32/L159) | global search box (all screens) | FTS5 virtual table. See feeders below. |

## FTS5 search_index feeders

`search_index` is an FTS5 virtual table. All writes go through `lib/fts.js`:
- `indexEntity(...)` inserts one row: `INSERT INTO search_index (workspace_id, entity_type, entity_id, title, body)` (lib/fts.js L13), preceded by a delete of the prior row (L11/L18).
- `reindexEntity` / `reindexWorkspace` (full rebuild wipes with `DELETE FROM search_index WHERE workspace_id=?` at L108) repopulate from the source tables.
- Search reads use `search_index MATCH ?` with `bm25()` ranking and `snippet()` (L46-L48).

Entity types fed into the index (lib/fts.js L65-L141), with their source tables:
- `risk` (from `risks`, L110-L111)
- `asset` (from `assets`, L116)
- `control` (from `control_states` JOIN `iso_items`, L120-L121; entity_id = iso_item_id)
- `document` (from generated/firm documents, L126)
- `supplier` (from `suppliers`, L130-L131)
- `incident` (from incidents, L141)

Notable absences from the index: `evidence`, `nonconformities`, CSF/SOC2 entities, and ISO 42001 items are NOT indexed by current feeders. Migration note: any reindex must re-run `reindexWorkspace` per workspace; the FTS table holds no source-of-truth data.

## Coverage gaps / TODO

Tables from the requested set with ZERO read/write references in `server.js`, `routes/`, and `lib/`:

- entity_control_states: no `FROM/INTO/UPDATE/JOIN entity_control_states` anywhere in app code. Likely dead/unused schema (multi-entity control state was probably superseded by per-workspace `control_states`). Confirm against `db.js` CREATE TABLE and drop if unused.

Tables that exist but have no app-level INSERT/UPDATE/DELETE (read-only in app code), worth flagging for migration completeness:

- entities: only joined for display (entity_name). No write path found in the grepped code; confirm how rows are created (seed script or another module) before migrating.
- Catalog/seed tables (read-only by design, populated in db.js / data/*.js): iso_items, iso42001_items, csf_functions, csf_categories, csf_subcategories, csf_subcategory_iso_refs, framework_mappings. These migrate as reference data, not tenant data.

Note: audit_chain showed zero hits in server/routes/lib but IS used (read + write) in `db.js` (L3712/L3722, CREATE L1111): NOT dead.
