-- 028_csf_production_assessment.sql
-- Production governance for NIST CSF 2.0 Organizational Profiles.
-- Capability scores are firm-defined; NIST Tiers are separately evidenced
-- conclusions and are never inferred from capability-score averages.

CREATE TABLE IF NOT EXISTS csf_profile_contexts (
  engagement_id INTEGER PRIMARY KEY REFERENCES csf_engagements(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_context TEXT,
  mission_objectives TEXT,
  critical_services TEXT,
  critical_assets_data TEXT,
  threat_landscape TEXT,
  legal_contractual_requirements TEXT,
  stakeholder_expectations TEXT,
  risk_appetite TEXT,
  scope_statement TEXT,
  assessment_limitations TEXT,
  community_profile_reference TEXT,
  methodology_version TEXT NOT NULL DEFAULT 'CSF-CAP-1.0',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','submitted','approved','superseded')),
  prepared_by INTEGER REFERENCES users(id),
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_csf_profile_context_ws ON csf_profile_contexts(workspace_id,status);

ALTER TABLE csf_subcategory_assessments ADD COLUMN profile_priority TEXT NOT NULL DEFAULT 'medium'
  CHECK(profile_priority IN ('critical','high','medium','low'));
ALTER TABLE csf_subcategory_assessments ADD COLUMN current_profile_statement TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN target_profile_statement TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN business_impact TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN effectiveness_conclusion TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN evidence_confidence TEXT
  CHECK(evidence_confidence IS NULL OR evidence_confidence IN ('low','medium','high'));
ALTER TABLE csf_subcategory_assessments ADD COLUMN client_validation_status TEXT NOT NULL DEFAULT 'not_requested'
  CHECK(client_validation_status IN ('not_requested','requested','validated','changes_requested'));
ALTER TABLE csf_subcategory_assessments ADD COLUMN client_validated_by INTEGER REFERENCES users(id);
ALTER TABLE csf_subcategory_assessments ADD COLUMN client_validated_at TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN approved_by INTEGER REFERENCES users(id);
ALTER TABLE csf_subcategory_assessments ADD COLUMN approved_at TEXT;
ALTER TABLE csf_subcategory_assessments ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE csf_evidence_items ADD COLUMN evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL;
ALTER TABLE csf_evidence_items ADD COLUMN evidence_period_start DATE;
ALTER TABLE csf_evidence_items ADD COLUMN evidence_period_end DATE;
ALTER TABLE csf_evidence_items ADD COLUMN confidentiality TEXT NOT NULL DEFAULT 'internal'
  CHECK(confidentiality IN ('public','internal','confidential','restricted'));
ALTER TABLE csf_evidence_items ADD COLUMN relevance_note TEXT;

ALTER TABLE csf_subcategory_assessment_snapshots ADD COLUMN profile_priority TEXT;
ALTER TABLE csf_subcategory_assessment_snapshots ADD COLUMN current_profile_statement TEXT;
ALTER TABLE csf_subcategory_assessment_snapshots ADD COLUMN target_profile_statement TEXT;
ALTER TABLE csf_subcategory_assessment_snapshots ADD COLUMN business_impact TEXT;
ALTER TABLE csf_subcategory_assessment_snapshots ADD COLUMN effectiveness_conclusion TEXT;
ALTER TABLE csf_subcategory_assessment_snapshots ADD COLUMN evidence_confidence TEXT;
ALTER TABLE csf_subcategory_assessment_snapshots ADD COLUMN client_validation_status TEXT;

ALTER TABLE csf_engagement_versions ADD COLUMN profile_context_json TEXT CHECK(profile_context_json IS NULL OR json_valid(profile_context_json));
ALTER TABLE csf_engagement_versions ADD COLUMN tier_snapshot_json TEXT CHECK(tier_snapshot_json IS NULL OR json_valid(tier_snapshot_json));
ALTER TABLE csf_engagement_versions ADD COLUMN snapshot_hash TEXT CHECK(snapshot_hash IS NULL OR length(snapshot_hash)=64);

CREATE TABLE IF NOT EXISTS csf_tier_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER NOT NULL REFERENCES csf_engagements(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('overall','function')),
  function_code TEXT NOT NULL DEFAULT '',
  current_tier INTEGER CHECK(current_tier BETWEEN 1 AND 4),
  target_tier INTEGER CHECK(target_tier BETWEEN 1 AND 4),
  governance_rationale TEXT,
  risk_management_rationale TEXT,
  evidence_summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','submitted','reviewed','approved')),
  prepared_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(engagement_id,scope_type,function_code)
);
CREATE INDEX IF NOT EXISTS idx_csf_tiers_eng ON csf_tier_assessments(engagement_id,status,function_code);

CREATE TABLE IF NOT EXISTS csf_assessment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER NOT NULL REFERENCES csf_engagements(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL REFERENCES csf_subcategory_assessments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  metadata TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_csf_assessment_events ON csf_assessment_events(assessment_id,created_at,id);

CREATE TABLE IF NOT EXISTS csf_tier_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier_assessment_id INTEGER NOT NULL REFERENCES csf_tier_assessments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_csf_tier_events ON csf_tier_events(tier_assessment_id,created_at,id);

CREATE TABLE IF NOT EXISTS csf_action_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES csf_engagements(id) ON DELETE CASCADE,
  recommendation_id INTEGER REFERENCES csf_recommendations(id) ON DELETE CASCADE,
  assessment_id INTEGER REFERENCES csf_subcategory_assessments(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  risk_id INTEGER REFERENCES risks(id) ON DELETE SET NULL,
  client_request_id INTEGER REFERENCES client_requests(id) ON DELETE SET NULL,
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(recommendation_id IS NOT NULL OR assessment_id IS NOT NULL),
  CHECK(task_id IS NOT NULL OR risk_id IS NOT NULL OR client_request_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_csf_action_links_eng ON csf_action_links(engagement_id,recommendation_id,assessment_id);

CREATE TRIGGER IF NOT EXISTS trg_csf_assessment_events_no_update BEFORE UPDATE ON csf_assessment_events
BEGIN SELECT RAISE(ABORT,'CSF assessment events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_assessment_events_no_delete BEFORE DELETE ON csf_assessment_events
BEGIN SELECT RAISE(ABORT,'CSF assessment events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_tier_events_no_update BEFORE UPDATE ON csf_tier_events
BEGIN SELECT RAISE(ABORT,'CSF Tier events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_tier_events_no_delete BEFORE DELETE ON csf_tier_events
BEGIN SELECT RAISE(ABORT,'CSF Tier events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_csf_profile_context_tenant BEFORE INSERT ON csf_profile_contexts
WHEN NOT EXISTS (SELECT 1 FROM csf_engagements e WHERE e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'CSF profile belongs to another workspace'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_tier_tenant BEFORE INSERT ON csf_tier_assessments
WHEN NOT EXISTS (SELECT 1 FROM csf_engagements e WHERE e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'CSF Tier assessment belongs to another workspace'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_evidence_tenant BEFORE UPDATE OF evidence_id ON csf_evidence_items
WHEN NEW.evidence_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM evidence ev
  JOIN csf_subcategory_assessments a ON a.id=NEW.assessment_id
  JOIN csf_engagements e ON e.id=a.engagement_id
  WHERE ev.id=NEW.evidence_id AND ev.workspace_id=e.workspace_id
)
BEGIN SELECT RAISE(ABORT,'CSF evidence belongs to another workspace'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_evidence_tenant_insert BEFORE INSERT ON csf_evidence_items
WHEN NEW.evidence_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM evidence ev
  JOIN csf_subcategory_assessments a ON a.id=NEW.assessment_id
  JOIN csf_engagements e ON e.id=a.engagement_id
  WHERE ev.id=NEW.evidence_id AND ev.workspace_id=e.workspace_id
)
BEGIN SELECT RAISE(ABORT,'CSF evidence belongs to another workspace'); END;
CREATE TRIGGER IF NOT EXISTS trg_csf_action_links_tenant BEFORE INSERT ON csf_action_links
WHEN NOT EXISTS (SELECT 1 FROM csf_engagements e WHERE e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id)
  OR (NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=NEW.task_id AND t.workspace_id=NEW.workspace_id))
  OR (NEW.risk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM risks r WHERE r.id=NEW.risk_id AND r.workspace_id=NEW.workspace_id))
  OR (NEW.client_request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM client_requests cr WHERE cr.id=NEW.client_request_id AND cr.workspace_id=NEW.workspace_id))
BEGIN SELECT RAISE(ABORT,'CSF action link crosses workspace boundary'); END;

CREATE TRIGGER IF NOT EXISTS trg_csf_versions_no_update_payload
BEFORE UPDATE OF profile_context_json,tier_snapshot_json,snapshot_hash ON csf_engagement_versions
WHEN OLD.snapshot_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT,'CSF published snapshot payload is immutable'); END;
