-- 005_phase4_assessment_engine.sql
-- Phase 4 schema: generic assessment engine (donor architecture: the csf_* model).
-- Additive. Backfill: migrations/data/005_phase4_structural_backfill.js (structural),
-- migrations/data/006_phase4_responses_blob.js + 007_phase4_csf_engine.js (DATA;
-- validated on fixtures + an AWS-snapshot dry run, data deferred to the AWS pass).

CREATE TABLE IF NOT EXISTS scoring_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER REFERENCES firms(id),              -- NULL = system
  name TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('conformity','maturity','weighted_risk')),
  scale_def TEXT NOT NULL,                           -- JSON
  rollup_rules TEXT NOT NULL,                        -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS question_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER REFERENCES firms(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  scoring_model_id INTEGER REFERENCES scoring_models(id),
  target_entity_type TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (firm_id, name, version)
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,                          -- 'A.5.19:q2' survives reordering
  ordinal INTEGER NOT NULL,
  section TEXT,
  text TEXT NOT NULL,
  answer_type TEXT NOT NULL DEFAULT 'single_select'
    CHECK (answer_type IN ('single_select','multi_select','yes_no','free_text','evidence_required','na_with_justification')),
  options TEXT,                                      -- JSON
  weight REAL DEFAULT 1.0,
  expected_answer TEXT,
  guidance TEXT,
  conditional_on TEXT,                               -- JSON
  UNIQUE (question_set_id, stable_key)
);

CREATE TABLE IF NOT EXISTS question_requirement_map (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  PRIMARY KEY (question_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
  question_set_version INTEGER NOT NULL,
  label TEXT,
  pass_number INTEGER,
  period_start TEXT, period_end TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','in_review','finalized')),
  propagation_done INTEGER NOT NULL DEFAULT 0,
  started_by INTEGER REFERENCES users(id), started_at TEXT,
  completed_by INTEGER REFERENCES users(id), finalized_at TEXT,
  migrated_from TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assessments_ws ON assessments(workspace_id, status);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer TEXT,
  assessor_note TEXT,
  respondent_id INTEGER REFERENCES users(id),
  respondent_kind TEXT NOT NULL DEFAULT 'consultant'
    CHECK (respondent_kind IN ('consultant','client','external')),
  raw_source TEXT,                                   -- original JSON fragment (drop post-cleanup)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (assessment_id, question_id)
);

CREATE TABLE IF NOT EXISTS assessment_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
  cadence TEXT NOT NULL,
  next_run TEXT,
  trigger_rule TEXT,                                 -- JSON
  is_active INTEGER DEFAULT 1
);

-- Versioning + snapshots, generalized from csf_engagement_versions /
-- csf_subcategory_assessment_snapshots (framework-agnostic).
CREATE TABLE IF NOT EXISTS assessment_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  published_at TEXT DEFAULT (datetime('now')),
  published_by INTEGER REFERENCES users(id),
  change_summary TEXT,
  is_current INTEGER DEFAULT 0,
  migrated_from TEXT,
  UNIQUE (assessment_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_av_assessment ON assessment_versions(assessment_id);

CREATE TABLE IF NOT EXISTS response_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer TEXT,
  assessor_note TEXT,
  weight REAL DEFAULT 1.0,
  UNIQUE (version_id, question_id)
);

-- Multi-entity attributes bag (tier/data_access/criticality for suppliers, etc.).
-- entity_type stays free TEXT (no CHECK to avoid a destructive table rebuild);
-- canonical accepted values: organization, supplier, ai_system, business_unit, department.
ALTER TABLE entities ADD COLUMN attributes TEXT;
