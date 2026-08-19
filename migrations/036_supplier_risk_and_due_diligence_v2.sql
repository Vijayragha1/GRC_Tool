-- 036_supplier_risk_and_due_diligence_v2.sql
-- Workbook-governed supplier inherent-risk, tiered DDQ, module routing and
-- internal contract review. Additive so historic supplier records remain intact.

CREATE TABLE IF NOT EXISTS supplier_inherent_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  methodology_version TEXT NOT NULL,
  assessment_type TEXT NOT NULL DEFAULT 'onboarding' CHECK(assessment_type IN ('onboarding','periodic','triggered')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','superseded')),
  physical_data_centre_applicability TEXT NOT NULL DEFAULT 'unknown' CHECK(physical_data_centre_applicability IN ('yes','no','unknown')),
  weighted_score REAL,
  assigned_tier TEXT CHECK(assigned_tier IN ('tier_1','tier_2','tier_3','tier_4')),
  mandatory_floors_json TEXT NOT NULL DEFAULT '[]',
  module_applicability_json TEXT NOT NULL DEFAULT '[]',
  unknown_count INTEGER NOT NULL DEFAULT 25,
  due_date TEXT,
  submitted_at TEXT,
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approval_rationale TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_inherent_current ON supplier_inherent_assessments(supplier_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_inherent_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES supplier_inherent_assessments(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  score INTEGER CHECK(score BETWEEN 0 AND 5),
  response_label TEXT,
  comment TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(assessment_id,question_id)
);

CREATE TABLE IF NOT EXISTS supplier_ddq_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  inherent_assessment_id INTEGER NOT NULL REFERENCES supplier_inherent_assessments(id),
  methodology_version TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('tier_1','tier_2','tier_3','tier_4')),
  assessment_type TEXT NOT NULL DEFAULT 'onboarding',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','in_progress','submitted','under_review','complete','superseded')),
  modules_json TEXT NOT NULL DEFAULT '[]',
  vendor_contact_name TEXT,
  vendor_contact_email TEXT,
  due_date TEXT,
  token_hash TEXT,
  token_expires_at TEXT,
  issued_at TEXT,
  opened_at TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_ddq_current ON supplier_ddq_assessments(supplier_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_ddq_token ON supplier_ddq_assessments(token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_ddq_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES supplier_ddq_assessments(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  response TEXT,
  detail TEXT,
  evidence_reference TEXT,
  evidence_date TEXT,
  evidence_owner TEXT,
  status TEXT NOT NULL DEFAULT 'Unanswered',
  reviewer_conclusion TEXT NOT NULL DEFAULT 'Not Reviewed',
  finding_id INTEGER REFERENCES findings(id) ON DELETE SET NULL,
  reviewer_comments TEXT,
  vendor_updated_at TEXT,
  reviewer_updated_at TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(assessment_id,question_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_ddq_response_status ON supplier_ddq_responses(assessment_id,status);

CREATE TABLE IF NOT EXISTS supplier_ddq_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL REFERENCES supplier_ddq_assessments(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT,
  source TEXT NOT NULL CHECK(source IN ('vendor','reviewer')),
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_ddq_evidence_question ON supplier_ddq_evidence(assessment_id,question_id,uploaded_at);

CREATE TABLE IF NOT EXISTS supplier_contract_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  methodology_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','complete','superseded')),
  agreement_reference TEXT,
  agreement_date TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_contract_review_current ON supplier_contract_reviews(supplier_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_contract_review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES supplier_contract_reviews(id) ON DELETE CASCADE,
  clause_id TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Not Reviewed',
  contract_reference TEXT,
  reviewer_comments TEXT,
  finding_id INTEGER REFERENCES findings(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(review_id,clause_id)
);

-- Existing suppliers enter the new methodology as a draft; legacy risk values
-- remain visible in history but are not treated as an approved workbook result.
INSERT INTO supplier_inherent_assessments
  (workspace_id,supplier_id,methodology_version,assessment_type,status,created_by)
SELECT s.workspace_id,s.id,'2026.1','periodic','draft',NULL
  FROM suppliers s
 WHERE s.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM supplier_inherent_assessments ia WHERE ia.supplier_id=s.id);

ALTER TABLE supplier_decisions ADD COLUMN residual_risk_band TEXT;
ALTER TABLE supplier_decisions ADD COLUMN residual_risk_rationale TEXT;
ALTER TABLE supplier_decisions ADD COLUMN readiness_snapshot_json TEXT;
ALTER TABLE supplier_decisions ADD COLUMN inherent_assessment_id INTEGER REFERENCES supplier_inherent_assessments(id);
ALTER TABLE supplier_decisions ADD COLUMN ddq_assessment_id INTEGER REFERENCES supplier_ddq_assessments(id);
ALTER TABLE supplier_decisions ADD COLUMN contract_review_id INTEGER REFERENCES supplier_contract_reviews(id);
