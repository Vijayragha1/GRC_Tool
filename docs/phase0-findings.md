# Phase 0 findings — Converged GRC schema migration

Date: 2026-06-10
DB of record: `iso27001.db` (SQLite, better-sqlite3, no ORM). 170 tables + FTS5 `search_index`.
Schema snapshot: [`schema_current.sql`](../schema_current.sql). Data-access map: [`data-access-inventory.md`](data-access-inventory.md).
Reproduce this census: `sqlite3 iso27001.db < migrations/analysis/phase0_discovery.sql`.

> **Read this first.** This database behaves like a **demo / development instance**: the ISO 27001 control catalogue and per-control *status* are richly populated, but almost every *workflow* table (answers, passes, evidence requests, supplier questionnaires, SOC 2, remediation trackers) is empty or near-empty. That inverts the program's risk profile: **data-movement risk is low; code-path / structural risk is high.** Confirm this matches your understanding of which DB I should be planning against, because if there is a separate production DB with real workflow data, several findings below change.

---

## Standing assumptions: one confirmed-moot, one CONTRADICTED

### Assumption A — answer keying (index vs stable key)
`iso_items.questions` is a **JSON array of plain strings** (118/118 items, all valid JSON), e.g.
`["What internal issues…","What external issues…", …]`. So any answers would be **positional (index-keyed)**, and the Phase 4 `stable_key = '{iso_item_id}:q{n}'` scheme is the right normalization. **However, see Assumption B: there are no answers to key.** Keying matters only for designing the question set, not for migrating data.

### Assumption B — "history is authoritative" — **CONTRADICTED**
| Probe | Result |
|---|---|
| `control_states` rows | 434 |
| `control_states` with a populated `assessment_answers` | **0** |
| `control_state_history` rows | **2** (vs 434 current states) |
| history rows with populated `assessment_answers` | **0** |
| `assessment_passes` | 2 (ids 16, 18; both `in_progress`) |

History is **not** authoritative here; it is nearly empty (2 rows) and holds **no** answer blobs. The current `control_states` row is authoritative for `status` / `applicability` / `maturity`, but **`assessment_answers` is empty across the board** (current and history). 

**Consequence for Phase 4:** the "explode `iso_items.questions` → responses from `control_state_history.assessment_answers`" step has **essentially zero source data** in this DB. The pass/answer machinery exists structurally but was never populated.

> **DECISION 1 (blocks Phase 0 gate):** Is the empty `assessment_answers` expected (this is a demo DB / the per-question gap-answer capture was never used in the field), or do live per-control answers exist somewhere I have not looked (a production DB, an export, or a different column)? If they genuinely don't exist, Phase 4's blob migration becomes a no-op and "history-as-authoritative" should be struck from the plan.

---

## ISO 42001 answer question (brief's explicit Phase 0 ask)
| Table | Rows | Notes |
|---|---|---|
| `iso42001_control_states` | 0 | `assessment_answers` column already dropped |
| `iso42001_control_state_history` | 0 | still has the `assessment_answers` column, but no rows |
| `iso42001_items` | 65 | catalogue only |

**No orphaned ISO 42001 answer data exists anywhere.** The 42001 silo has catalogue rows only and zero tenant state. Phase 4's blob migration is correctly scoped to **ISO 27001 only**, and there is nothing to quarantine. (Matches the brief's expectation.)

---

## Status / applicability vocabulary census → normalization map needed
`control_states.status` (n=434):
| legacy value | n | proposed canonical |
|---|---|---|
| Implemented | 257 | `implemented` |
| Partially Implemented | 104 | `partially_implemented` |
| Not Assessed | 36 | `not_assessed` |
| Not Implemented | 27 | `not_implemented` |
| Not Applicable | 10 | `not_applicable` |

`control_states.applicability` (n=434):
| legacy value | n | proposed canonical (control_instances CHECK) |
|---|---|---|
| included | 388 | `applicable` |
| undecided | 36 | `undecided` |
| excluded | 10 | `excluded` |

The 10 `Not Applicable` statuses line up 1:1 with the 10 `excluded` applicabilities. `control_instances.status` has **no CHECK constraint** in the brief (free TEXT, default `not_assessed`), so the target vocabulary is open; `applicability` **does** have a CHECK (`undecided`/`applicable`/`excluded`), and legacy `included` must map to `applicable`.

> **DECISION 2 (per rule "status-vocabulary normalization map before applying it"):** Approve the two maps above for Phase 3. In particular confirm `included → applicable` and the five status targets.

---

## CSF engine: orphaned assessment data (schema vs reality)
| Probe | Result |
|---|---|
| `csf_engagements` | **0** |
| `csf_subcategory_assessments` | 212 (status: Not Started 180, Draft Complete 31, Approved 1) |
| …of which have **no parent engagement** | **212 (all)** |
| `csf_weighting_profile_items` | 212 |
| `catalog_version` | `2.0` (single CSF framework row) |

All 212 CSF subcategory assessments reference an `engagement_id` that does not exist, even though the FK is `ON DELETE CASCADE`. That can only happen if FK enforcement was off during seeding/deletion. This is orphaned data.

> **DECISION 3:** Are these 212 orphaned CSF assessments real client work to be migrated, or demo/seed cruft to be excluded (or quarantined) in the Phase 4 CSF port? The `csf_engagements`-driven UI shows nothing today regardless.

---

## framework_mappings: most of it cannot become `requirement_mappings`
`framework_mappings` has 234 rows. `requirement_mappings` FKs **both** sides to `requirements`, so a mapping only survives if its target framework is loaded as requirements (we load iso27001, iso42001, csf, soc2):
| target framework | n | disposition |
|---|---|---|
| soc2 | 53 | resolvable once SOC 2 / TSC loaded (Phase 1) |
| nist_csf | 38 | maybe, if `external_ref` matches CSF subcategory codes |
| nist_800_53 | 57 | **not loaded** |
| pci_dss | 26 | **not loaded** |
| hipaa | 14 | **not loaded** |
| dora | 14 | **not loaded** |
| gdpr | 10 | **not loaded** |
| iso_27017 / iso_27018 / iso_27701 | 9 / 7 / 6 | **not loaded** |

~143 of 234 mappings point at frameworks **not** in scope as requirements. The existing **crosswalks screen** reads `framework_mappings` directly (see inventory), so the table can't simply be abandoned.

> **DECISION 4 (Phase 1 design):** For the ~143 unresolvable mappings, pick one: (a) load those frameworks as lightweight "external reference" requirement rows so mappings resolve; (b) keep `framework_mappings` as-is for the crosswalk feature and only mirror the resolvable subset into `requirement_mappings`; (c) quarantine the unresolvable rows. My default recommendation is **(b)**: lowest blast radius, preserves the crosswalk UI, no fictitious requirements.

Related: `csf_subcategory_iso_refs` (392 rows: annex_a 250, mandatory_clause 142) uses bare refs like `4.1` / `8.2`, while `iso_items.id` is `clause-4.1` / `annex-a.5.19`. A naive normalizer resolves only **120/392**; Phase 1 needs a real ref-format mapper, with unresolved refs quarantined.

---

## Evidence reconciliation baseline (Phase 2)
| Table | Rows |
|---|---|
| `evidence` | 165 |
| `evidence_controls` | 186 |
| `evidence_links` | 166 (100% `framework='iso27001'`) |
| `csf_evidence_items` | 31 |
| `evidence_controls` **not** mirrored into `evidence_links` | **20** |
| `evidence_links` not backed by an `evidence_controls` row | 0 |

The 3 `evctrl_to_evlinks_*` triggers only ever write `framework='iso27001'`; CSF/42001 evidence does not flow through `evidence_links`. **20 `evidence_controls` rows predate the trigger** and were never mirrored. So the Phase 2 backfill superset for ISO 27001 is **186** (`evidence_links` 166 + the 20 unmirrored controls), plus **31** `csf_evidence_items` to fold into central `evidence`. Reconciliation target to assert at the gate: `186 + 31 = 217` resolvable links (minus any that quarantine on ref-resolution).

---

## Remediation trackers (Phase 6) — sparse, with a severity-scheme wrinkle
| Tracker | Rows | severity scheme |
|---|---|---|
| `nonconformities` | 17 | minor/major (`nc`) |
| `audit_findings` | 22 | **mixed**: low 10, medium 10, minor 2 |
| `audit_observations` | 16 | n/a |
| `improvements` | 17 | n/a (`manual`) |
| `csf_findings` / `csf_recommendations` | 2 / 2 | hml-ish |
| `csf_remediation_status` | 0 | — |
| `supplier_findings` (6th tracker) | **0** | — |
| `risk_treatments` | **0** | — |
| `risk_treatment_actions` | **0** | — |

Two notes:
- `audit_findings.severity` mixes an HML scale (low/medium) **and** an NC scale (minor) in the same column — Phase 6 will need per-row scheme inference, not a blanket `severity_scheme='nc'`.
- `risk_treatments` and `risk_treatment_actions` are **both empty**, so the survivor decision is **design-only with zero data-migration impact**.

> **DECISION 5 (per rule "`risk_treatments` vs `risk_treatment_actions` survivor"):** Which table is the survivor for the unified remediation pipeline? No data rides on it; this is purely which schema/UX shape to keep. (`risk_treatment_actions` is the newer, leaner action-oriented table; `risk_treatments` carries cost/expected-residual fields.)

---

## Phase 2b / Phase 5 donor + post-delta volumes — structural, not data, migrations
| Table | Rows |
|---|---|
| `soc2_engagements` / `soc2_requests` / `soc2_request_evidence` | 0 / 0 / 0 |
| `supplier_questionnaires` / responses | 0 / 0 |
| `questionnaire_templates` / `questionnaire_questions` | 3 / 66 |
| `questionnaire_template_versions` | 0 |
| `questionnaire_question_bank` | 0 |
| `recurring_questionnaire_schedules` | 0 |
| `supplier_reviews` | 0 |

The SOC 2 PBC workflow and the DDQ workflow have schema but **no live rows** (only 3 template definitions + 66 template questions). Phases 2b and 5 are therefore mostly **structural / code-path** migrations with negligible data to move or reconcile in this DB.

---

## SoA payload shape (Phase 3 compatibility)
`soa_snapshots.payload` (6 rows) is a JSON array of control objects:
`{id,title,category,applicability,status,inclusion_justification,exclusion_justification}` — **no answer-derived data embedded** (0/6 mention answers). So the Phase 3 "SoA byte-equivalence" gate depends only on **status/applicability normalization**, not on answers. `iso42001_soa_snapshots` has 0 rows.

---

## Per-workspace footprint + pilot recommendation
| workspace_id | client | control_states |
|---|---|---|
| 16 | Northwind Financial Services | 102 |
| 17 | Helio Software Inc. | 93 |
| 30 | office | 3 |
| 31 | Apex Manufacturing Ltd. | 118 |
| 32 | Stellar Logistics PLC | 118 |

All workspaces declare `frameworks=["iso27001"]` only. Workspace 30 ("office") is a near-empty scratch workspace. **Recommended pilot for read-cutover parity checks: workspace 31 or 32** (full 118-control coverage).

---

## Dead / unused schema
- **`entity_control_states`**: 0 rows **and** 0 code references (per inventory). Phase 3 plans to migrate it into `control_instances(entity_id)`; since it is empty and unreferenced, there is nothing to migrate — treat it as a **demolition candidate** (with approval) rather than a migration source.
- `entities`: 0 rows, read-only joins only (no app write path found). Phase 3/4 will need to **create** the per-workspace `organization` entity rather than migrate existing ones.

---

## Scaffolding built this phase (additive, reversible)
- `migration_quarantine`, `feature_flags` (+ two partial unique indexes), `schema_migrations` — created via the new runner.
- `migrations/` with a forward-only runner ([`run.js`](../migrations/run.js)) + [`001_phase0_scaffolding.sql`](../migrations/001_phase0_scaffolding.sql); discovery in [`analysis/phase0_discovery.sql`](../migrations/analysis/phase0_discovery.sql).
- Backup gate: `backups/2026-06-10-pre-phase-0.db` (integrity_check `ok`, 171/171 tables, row parity).
- App test suite: see `MIGRATION_NOTES.md` for the green-bar result.

---

## Decisions required before Phase 1 (the Phase 0 gate)
1. **Empty `assessment_answers`** — is this a demo DB / unused feature, or is there live answer data elsewhere? (Determines whether Phase 4's blob migration is a no-op.)
2. **Status/applicability normalization maps** — approve the two tables above (esp. `included → applicable`).
3. **212 orphaned CSF assessments** — real work to migrate, or demo cruft to exclude/quarantine?
4. **framework_mappings** — disposition for the ~143 unresolvable rows (recommend option **b**).
5. **`risk_treatments` vs `risk_treatment_actions` survivor** — design-only, no data impact.

Standing per the brief, I will also pause and ask before: any demolition; quarantine batches > 20 rows; TSC catalogue content (Phase 1); and any further schema-vs-reality conflicts.
