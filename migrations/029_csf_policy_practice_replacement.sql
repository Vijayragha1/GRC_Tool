-- 029_csf_policy_practice_replacement.sql
-- Replaces the legacy single-score CSF assessment with two independently
-- evidenced CMMI-aligned axes: Policy maturity and Practice maturity.
-- Existing CSF rows are preserved. Legacy current_score/target_score fields
-- remain read-only historical data and are never silently converted.

CREATE TABLE IF NOT EXISTS csf_catalog_versions (
  catalog_version TEXT PRIMARY KEY,
  source_identifier TEXT NOT NULL,
  source_url TEXT NOT NULL,
  published_date TEXT NOT NULL,
  function_count INTEGER NOT NULL CHECK(function_count=6),
  category_count INTEGER NOT NULL CHECK(category_count=22),
  outcome_count INTEGER NOT NULL CHECK(outcome_count=106),
  catalog_hash TEXT NOT NULL CHECK(length(catalog_hash)=64),
  methodology_version TEXT NOT NULL,
  methodology_hash TEXT NOT NULL CHECK(length(methodology_hash)=64),
  locked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS csf_methodology_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subcategory_id INTEGER NOT NULL REFERENCES csf_subcategories(id),
  methodology_version TEXT NOT NULL,
  policy_anchors_json TEXT NOT NULL CHECK(json_valid(policy_anchors_json)),
  practice_anchors_json TEXT NOT NULL CHECK(json_valid(practice_anchors_json)),
  policy_evidence_json TEXT NOT NULL CHECK(json_valid(policy_evidence_json)),
  practice_evidence_json TEXT NOT NULL CHECK(json_valid(practice_evidence_json)),
  interview_roles_json TEXT NOT NULL CHECK(json_valid(interview_roles_json)),
  test_procedures_json TEXT NOT NULL CHECK(json_valid(test_procedures_json)),
  measures_json TEXT NOT NULL CHECK(json_valid(measures_json)),
  failure_indicators_json TEXT NOT NULL CHECK(json_valid(failure_indicators_json)),
  evidence_gates_json TEXT NOT NULL CHECK(json_valid(evidence_gates_json)),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  reviewed_at TEXT NOT NULL,
  UNIQUE(subcategory_id,methodology_version)
);
CREATE INDEX IF NOT EXISTS idx_csf_methodology_sub ON csf_methodology_outcomes(subcategory_id,methodology_version);

ALTER TABLE csf_subcategory_assessments ADD COLUMN applicability_status TEXT NOT NULL DEFAULT 'in_scope'
  CHECK(applicability_status IN ('in_scope','not_applicable'));
ALTER TABLE csf_subcategory_assessments ADD COLUMN policy_score INTEGER CHECK(policy_score BETWEEN 0 AND 5);
ALTER TABLE csf_subcategory_assessments ADD COLUMN practice_score INTEGER CHECK(practice_score BETWEEN 0 AND 5);
ALTER TABLE csf_subcategory_assessments ADD COLUMN target_policy_score INTEGER CHECK(target_policy_score BETWEEN 0 AND 5);
ALTER TABLE csf_subcategory_assessments ADD COLUMN target_practice_score INTEGER CHECK(target_practice_score BETWEEN 0 AND 5);
ALTER TABLE csf_subcategory_assessments ADD COLUMN policy_rationale TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN practice_rationale TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN policy_owner TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN practice_owner TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN assurance_outcome TEXT NOT NULL DEFAULT 'not_assessed'
  CHECK(assurance_outcome IN ('not_assessed','effective','partially_effective','ineffective','alternate_control','no_visibility','not_implemented','not_applicable'));
ALTER TABLE csf_subcategory_assessments ADD COLUMN assessment_period_start DATE;
ALTER TABLE csf_subcategory_assessments ADD COLUMN assessment_period_end DATE;
ALTER TABLE csf_subcategory_assessments ADD COLUMN population_description TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN population_size INTEGER CHECK(population_size IS NULL OR population_size >= 0);
ALTER TABLE csf_subcategory_assessments ADD COLUMN sample_size INTEGER CHECK(sample_size IS NULL OR sample_size >= 0);
ALTER TABLE csf_subcategory_assessments ADD COLUMN sample_rationale TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN methodology_version TEXT NOT NULL DEFAULT 'CSF-PP-2.0';
ALTER TABLE csf_subcategory_assessments ADD COLUMN review_conclusion TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN policy_scored_by INTEGER REFERENCES users(id);
ALTER TABLE csf_subcategory_assessments ADD COLUMN practice_scored_by INTEGER REFERENCES users(id);
ALTER TABLE csf_subcategory_assessments ADD COLUMN legacy_preserved INTEGER NOT NULL DEFAULT 1;

ALTER TABLE csf_evidence_items ADD COLUMN evidence_axis TEXT NOT NULL DEFAULT 'both'
  CHECK(evidence_axis IN ('policy','practice','both'));
ALTER TABLE csf_evidence_items ADD COLUMN evidence_quality TEXT NOT NULL DEFAULT 'fair'
  CHECK(evidence_quality IN ('poor','fair','good','excellent'));
ALTER TABLE csf_evidence_items ADD COLUMN source_reliability TEXT
  CHECK(source_reliability IS NULL OR source_reliability IN ('low','medium','high'));
ALTER TABLE csf_evidence_items ADD COLUMN scope_coverage TEXT;
ALTER TABLE csf_evidence_items ADD COLUMN testing_method TEXT;
ALTER TABLE csf_evidence_items ADD COLUMN test_result TEXT;

CREATE TABLE IF NOT EXISTS csf_assessment_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES csf_engagements(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL REFERENCES csf_subcategory_assessments(id) ON DELETE CASCADE,
  test_code TEXT NOT NULL,
  axis TEXT NOT NULL CHECK(axis IN ('policy','practice','both')),
  procedure_text TEXT NOT NULL,
  population_description TEXT,
  population_size INTEGER CHECK(population_size IS NULL OR population_size >= 0),
  sample_size INTEGER CHECK(sample_size IS NULL OR sample_size >= 0),
  sample_selection TEXT,
  result TEXT NOT NULL CHECK(result IN ('not_run','pass','partial','fail','no_visibility','not_applicable')),
  exception_count INTEGER NOT NULL DEFAULT 0 CHECK(exception_count >= 0),
  conclusion TEXT,
  performed_by INTEGER REFERENCES users(id),
  performed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(assessment_id,test_code)
);
CREATE INDEX IF NOT EXISTS idx_csf_tests_assessment ON csf_assessment_tests(assessment_id,result);

CREATE TABLE IF NOT EXISTS csf_assessment_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES csf_engagements(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL REFERENCES csf_subcategory_assessments(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  justification TEXT NOT NULL,
  compensating_controls TEXT,
  inherent_risk TEXT,
  residual_risk TEXT,
  owner_id INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  expires_on DATE NOT NULL,
  next_review_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','expired','closed')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_csf_exceptions_assessment ON csf_assessment_exceptions(assessment_id,status,expires_on);

CREATE TABLE IF NOT EXISTS csf_score_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES csf_engagements(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL REFERENCES csf_subcategory_assessments(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('policy','practice','target_policy','target_practice','applicability','assurance')),
  previous_value TEXT,
  new_value TEXT,
  rationale TEXT,
  evidence_manifest_json TEXT CHECK(evidence_manifest_json IS NULL OR json_valid(evidence_manifest_json)),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_csf_score_decisions_assessment ON csf_score_decisions(assessment_id,created_at,id);

CREATE TABLE IF NOT EXISTS csf_assessment_versions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES csf_engagements(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reviewed','approved','published','superseded')),
  catalog_version TEXT NOT NULL,
  catalog_hash TEXT NOT NULL CHECK(length(catalog_hash)=64),
  methodology_version TEXT NOT NULL,
  methodology_hash TEXT NOT NULL CHECK(length(methodology_hash)=64),
  profile_snapshot_json TEXT NOT NULL CHECK(json_valid(profile_snapshot_json)),
  rollup_snapshot_json TEXT NOT NULL CHECK(json_valid(rollup_snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  change_summary TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  published_by INTEGER REFERENCES users(id),
  published_at TEXT,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(engagement_id,version_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_csf_v2_current ON csf_assessment_versions_v2(engagement_id) WHERE is_current=1;

CREATE TABLE IF NOT EXISTS csf_assessment_version_outcomes_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES csf_assessment_versions_v2(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL,
  subcategory_id INTEGER NOT NULL REFERENCES csf_subcategories(id),
  outcome_code TEXT NOT NULL,
  applicability_status TEXT NOT NULL,
  profile_priority TEXT NOT NULL,
  policy_score INTEGER,
  practice_score INTEGER,
  target_policy_score INTEGER,
  target_practice_score INTEGER,
  policy_rationale TEXT,
  practice_rationale TEXT,
  assurance_outcome TEXT NOT NULL,
  evidence_confidence TEXT,
  business_impact TEXT,
  assessment_period_start DATE,
  assessment_period_end DATE,
  population_description TEXT,
  population_size INTEGER,
  sample_size INTEGER,
  sample_rationale TEXT,
  evidence_manifest_json TEXT NOT NULL CHECK(json_valid(evidence_manifest_json)),
  tests_snapshot_json TEXT NOT NULL CHECK(json_valid(tests_snapshot_json)),
  exceptions_snapshot_json TEXT NOT NULL CHECK(json_valid(exceptions_snapshot_json)),
  findings_snapshot_json TEXT NOT NULL CHECK(json_valid(findings_snapshot_json)),
  methodology_content_hash TEXT NOT NULL CHECK(length(methodology_content_hash)=64),
  UNIQUE(version_id,subcategory_id)
);
CREATE INDEX IF NOT EXISTS idx_csf_v2_outcomes_version ON csf_assessment_version_outcomes_v2(version_id,outcome_code);

CREATE TRIGGER IF NOT EXISTS trg_csf_methodology_no_update BEFORE UPDATE ON csf_methodology_outcomes
BEGIN SELECT RAISE(ABORT,'Published CSF methodology content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_methodology_no_delete BEFORE DELETE ON csf_methodology_outcomes
BEGIN SELECT RAISE(ABORT,'Published CSF methodology content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_score_decisions_no_update BEFORE UPDATE ON csf_score_decisions
BEGIN SELECT RAISE(ABORT,'CSF score decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_score_decisions_no_delete BEFORE DELETE ON csf_score_decisions
BEGIN SELECT RAISE(ABORT,'CSF score decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_v2_versions_payload_no_update
BEFORE UPDATE OF catalog_hash,methodology_hash,profile_snapshot_json,rollup_snapshot_json,snapshot_hash ON csf_assessment_versions_v2
BEGIN SELECT RAISE(ABORT,'CSF version snapshot payload is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_v2_outcomes_no_update BEFORE UPDATE ON csf_assessment_version_outcomes_v2
BEGIN SELECT RAISE(ABORT,'CSF outcome snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_v2_outcomes_no_delete BEFORE DELETE ON csf_assessment_version_outcomes_v2
BEGIN SELECT RAISE(ABORT,'CSF outcome snapshots are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_csf_tests_tenant BEFORE INSERT ON csf_assessment_tests
WHEN NOT EXISTS (
  SELECT 1 FROM csf_subcategory_assessments a JOIN csf_engagements e ON e.id=a.engagement_id
  WHERE a.id=NEW.assessment_id AND e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT,'CSF test crosses workspace boundary'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_exceptions_tenant BEFORE INSERT ON csf_assessment_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM csf_subcategory_assessments a JOIN csf_engagements e ON e.id=a.engagement_id
  WHERE a.id=NEW.assessment_id AND e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT,'CSF exception crosses workspace boundary'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_score_decisions_tenant BEFORE INSERT ON csf_score_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM csf_subcategory_assessments a JOIN csf_engagements e ON e.id=a.engagement_id
  WHERE a.id=NEW.assessment_id AND e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT,'CSF score decision crosses workspace boundary'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_v2_versions_tenant BEFORE INSERT ON csf_assessment_versions_v2
WHEN NOT EXISTS (SELECT 1 FROM csf_engagements e WHERE e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'CSF version crosses workspace boundary'); END;
