-- 026_consulting_delivery_operating_system.sql
-- Consultant-led delivery layer: multi-engagement scoping, defensible
-- workpapers, maker-checker review, common controls, governed methods and
-- commercial oversight. Mutable operational rows are paired with append-only
-- events/reviews/snapshots so management decisions remain reconstructable.

CREATE TABLE IF NOT EXISTS consulting_engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_code TEXT NOT NULL,
  name TEXT NOT NULL,
  engagement_type TEXT NOT NULL DEFAULT 'implementation'
    CHECK(engagement_type IN ('implementation','readiness','internal_audit','gap_assessment','advisory','surveillance')),
  framework_scope_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(framework_scope_json)),
  scope_statement TEXT,
  included_entities TEXT,
  included_locations TEXT,
  included_systems TEXT,
  exclusions TEXT,
  assessment_period_start DATE,
  assessment_period_end DATE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','active','on_hold','quality_review','complete','cancelled')),
  lead_consultant_id INTEGER REFERENCES users(id),
  quality_reviewer_id INTEGER REFERENCES users(id),
  client_sponsor_id INTEGER REFERENCES users(id),
  start_date DATE,
  target_date DATE,
  completed_at TEXT,
  completion_note TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, engagement_code)
);
CREATE INDEX IF NOT EXISTS idx_consulting_engagements_ws ON consulting_engagements(workspace_id,status,target_date);
CREATE INDEX IF NOT EXISTS idx_consulting_engagements_lead ON consulting_engagements(lead_consultant_id,status);

CREATE TABLE IF NOT EXISTS consulting_engagement_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('engagement_lead','consultant','quality_reviewer','subject_matter_expert','client_sponsor','client_contributor')),
  planned_hours REAL NOT NULL DEFAULT 0 CHECK(planned_hours >= 0),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(engagement_id,user_id,role)
);
CREATE INDEX IF NOT EXISTS idx_consulting_team_eng ON consulting_engagement_team(engagement_id,role);

CREATE TABLE IF NOT EXISTS engagement_commercials (
  engagement_id INTEGER PRIMARY KEY REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(length(currency)=3),
  contract_value_minor INTEGER NOT NULL DEFAULT 0 CHECK(contract_value_minor >= 0),
  planned_hours REAL NOT NULL DEFAULT 0 CHECK(planned_hours >= 0),
  internal_cost_rate_minor INTEGER NOT NULL DEFAULT 0 CHECK(internal_cost_rate_minor >= 0),
  billing_model TEXT NOT NULL DEFAULT 'fixed_fee' CHECK(billing_model IN ('fixed_fee','time_and_materials','retainer','milestone')),
  billing_status TEXT NOT NULL DEFAULT 'not_started' CHECK(billing_status IN ('not_started','in_progress','fully_billed','on_hold')),
  invoiced_minor INTEGER NOT NULL DEFAULT 0 CHECK(invoiced_minor >= 0),
  collected_minor INTEGER NOT NULL DEFAULT 0 CHECK(collected_minor >= 0),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS engagement_time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date DATE NOT NULL,
  hours REAL NOT NULL CHECK(hours > 0 AND hours <= 24),
  category TEXT NOT NULL CHECK(category IN ('planning','assessment','client_meeting','workpaper','review','reporting','remediation','administration')),
  description TEXT NOT NULL,
  billable INTEGER NOT NULL DEFAULT 1 CHECK(billable IN (0,1)),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_engagement ON engagement_time_entries(engagement_id,work_date,user_id);

CREATE TABLE IF NOT EXISTS engagement_scope_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  schedule_impact_days INTEGER NOT NULL DEFAULT 0,
  fee_impact_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','rejected','withdrawn')),
  proposed_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scope_changes_eng ON engagement_scope_changes(engagement_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS client_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  control_code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  control_owner_id INTEGER REFERENCES users(id),
  process_owner TEXT,
  frequency TEXT,
  control_type TEXT CHECK(control_type IN ('preventive','detective','corrective','directive')),
  nature TEXT CHECK(nature IN ('manual','automated','hybrid')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,control_code)
);
CREATE INDEX IF NOT EXISTS idx_client_controls_ws ON client_controls(workspace_id,status);

CREATE TABLE IF NOT EXISTS client_control_requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_control_id INTEGER NOT NULL REFERENCES client_controls(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  coverage TEXT NOT NULL CHECK(coverage IN ('full','partial','supporting')),
  mapping_rationale TEXT NOT NULL,
  mapped_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_control_id,requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_client_control_req ON client_control_requirement_links(requirement_id,client_control_id);

CREATE TABLE IF NOT EXISTS consultant_workpapers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  client_control_id INTEGER REFERENCES client_controls(id) ON DELETE SET NULL,
  workpaper_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT,
  procedure_performed TEXT,
  persons_interviewed TEXT,
  testing_period_start DATE,
  testing_period_end DATE,
  population_description TEXT,
  population_size INTEGER CHECK(population_size IS NULL OR population_size >= 0),
  sample_method TEXT,
  sample_size INTEGER CHECK(sample_size IS NULL OR sample_size >= 0),
  exceptions_count INTEGER NOT NULL DEFAULT 0 CHECK(exceptions_count >= 0),
  exception_summary TEXT,
  management_claim TEXT NOT NULL DEFAULT 'not_provided'
    CHECK(management_claim IN ('not_provided','implemented','partially_implemented','not_implemented','not_applicable')),
  design_conclusion TEXT NOT NULL DEFAULT 'not_assessed'
    CHECK(design_conclusion IN ('not_assessed','suitable','partially_suitable','unsuitable','not_applicable')),
  implementation_conclusion TEXT NOT NULL DEFAULT 'not_assessed'
    CHECK(implementation_conclusion IN ('not_assessed','implemented','partially_implemented','not_implemented','not_applicable')),
  operating_effectiveness TEXT NOT NULL DEFAULT 'not_tested'
    CHECK(operating_effectiveness IN ('not_tested','effective','partially_effective','ineffective','not_applicable')),
  evidence_sufficiency TEXT NOT NULL DEFAULT 'not_assessed'
    CHECK(evidence_sufficiency IN ('not_assessed','insufficient','partially_sufficient','sufficient')),
  conclusion_rationale TEXT,
  internal_notes TEXT,
  client_visible_summary TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0 CHECK(client_visible IN (0,1)),
  requires_client_validation INTEGER NOT NULL DEFAULT 0 CHECK(requires_client_validation IN (0,1)),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  reviewer_id INTEGER REFERENCES users(id),
  client_validator_id INTEGER REFERENCES users(id),
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','manager_review','changes_requested','client_validation','approved','frozen','superseded')),
  prepared_by INTEGER REFERENCES users(id),
  prepared_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  frozen_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(engagement_id,requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_workpapers_ws_status ON consultant_workpapers(workspace_id,status,due_date);
CREATE INDEX IF NOT EXISTS idx_workpapers_eng ON consultant_workpapers(engagement_id,requirement_id);
CREATE INDEX IF NOT EXISTS idx_workpapers_reviewer ON consultant_workpapers(reviewer_id,status);

CREATE TABLE IF NOT EXISTS consultant_workpaper_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workpaper_id INTEGER NOT NULL REFERENCES consultant_workpapers(id) ON DELETE CASCADE,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  relevance TEXT NOT NULL DEFAULT 'pending' CHECK(relevance IN ('pending','relevant','partially_relevant','not_relevant')),
  period_covered_start DATE,
  period_covered_end DATE,
  reviewer_note TEXT,
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workpaper_id,evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_workpaper_evidence_wp ON consultant_workpaper_evidence(workpaper_id,relevance);

CREATE TABLE IF NOT EXISTS consultant_workpaper_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workpaper_id INTEGER NOT NULL REFERENCES consultant_workpapers(id) ON DELETE CASCADE,
  review_type TEXT NOT NULL CHECK(review_type IN ('consultant_submission','manager_review','client_validation','approval','freeze','reopen')),
  decision TEXT NOT NULL CHECK(decision IN ('submitted','approved','changes_requested','validated','rejected','frozen','reopened')),
  note TEXT,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workpaper_reviews_wp ON consultant_workpaper_reviews(workpaper_id,created_at,id);

CREATE TABLE IF NOT EXISTS consultant_workpaper_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workpaper_id INTEGER NOT NULL REFERENCES consultant_workpapers(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  frozen_by INTEGER NOT NULL REFERENCES users(id),
  frozen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workpaper_id,version_number)
);
CREATE INDEX IF NOT EXISTS idx_workpaper_snapshots_wp ON consultant_workpaper_snapshots(workpaper_id,version_number DESC);

CREATE TABLE IF NOT EXISTS firm_methodologies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  framework_code TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(firm_id,code)
);

CREATE TABLE IF NOT EXISTS firm_methodology_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  methodology_id INTEGER NOT NULL REFERENCES firm_methodologies(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  change_summary TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  approved_by INTEGER NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(methodology_id,version_number)
);

CREATE TABLE IF NOT EXISTS consulting_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consulting_events_eng ON consulting_events(engagement_id,created_at DESC,id DESC);

ALTER TABLE engagement_delivery_plans ADD COLUMN consulting_engagement_id INTEGER REFERENCES consulting_engagements(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_plan_consulting_eng ON engagement_delivery_plans(consulting_engagement_id);

ALTER TABLE client_requests ADD COLUMN engagement_id INTEGER REFERENCES consulting_engagements(id) ON DELETE SET NULL;
ALTER TABLE client_requests ADD COLUMN workpaper_id INTEGER REFERENCES consultant_workpapers(id) ON DELETE SET NULL;
ALTER TABLE client_requests ADD COLUMN request_reason TEXT;
ALTER TABLE client_requests ADD COLUMN acceptable_examples TEXT;
ALTER TABLE client_requests ADD COLUMN evidence_period_start DATE;
ALTER TABLE client_requests ADD COLUMN evidence_period_end DATE;
ALTER TABLE client_requests ADD COLUMN confidentiality TEXT DEFAULT 'client_confidential'
  CHECK(confidentiality IN ('standard','client_confidential','restricted'));
ALTER TABLE client_requests ADD COLUMN consultant_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE client_requests ADD COLUMN evidence_quality TEXT DEFAULT 'not_reviewed'
  CHECK(evidence_quality IN ('not_reviewed','insufficient','partially_sufficient','sufficient'));
CREATE INDEX IF NOT EXISTS idx_client_requests_workpaper ON client_requests(workspace_id,workpaper_id,status);
CREATE INDEX IF NOT EXISTS idx_client_requests_engagement ON client_requests(engagement_id,status,due_date);

-- Cross-workspace links are rejected at the database boundary, not merely by
-- route code. This prevents a future route regression from joining one
-- client's evidence or controls to another client's workpaper.
CREATE TRIGGER IF NOT EXISTS trg_workpaper_engagement_tenant_insert
BEFORE INSERT ON consultant_workpapers
WHEN NOT EXISTS (SELECT 1 FROM consulting_engagements e WHERE e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'workpaper engagement belongs to another workspace'); END;

CREATE TRIGGER IF NOT EXISTS trg_workpaper_engagement_tenant_update
BEFORE UPDATE OF workspace_id,engagement_id ON consultant_workpapers
WHEN NOT EXISTS (SELECT 1 FROM consulting_engagements e WHERE e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'workpaper engagement belongs to another workspace'); END;

CREATE TRIGGER IF NOT EXISTS trg_workpaper_control_tenant
BEFORE INSERT ON consultant_workpapers
WHEN NEW.client_control_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM client_controls c WHERE c.id=NEW.client_control_id AND c.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'client control belongs to another workspace'); END;

CREATE TRIGGER IF NOT EXISTS trg_workpaper_evidence_tenant
BEFORE INSERT ON consultant_workpaper_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM consultant_workpapers w JOIN evidence e ON e.id=NEW.evidence_id
  WHERE w.id=NEW.workpaper_id AND e.workspace_id=w.workspace_id
)
BEGIN SELECT RAISE(ABORT,'evidence belongs to another workspace'); END;

-- Decision history and frozen snapshots are append-only workpaper records.
CREATE TRIGGER IF NOT EXISTS trg_workpaper_reviews_no_update BEFORE UPDATE ON consultant_workpaper_reviews
BEGIN SELECT RAISE(ABORT,'workpaper review history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_workpaper_reviews_no_delete BEFORE DELETE ON consultant_workpaper_reviews
BEGIN SELECT RAISE(ABORT,'workpaper review history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_workpaper_snapshots_no_update BEFORE UPDATE ON consultant_workpaper_snapshots
BEGIN SELECT RAISE(ABORT,'workpaper snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_workpaper_snapshots_no_delete BEFORE DELETE ON consultant_workpaper_snapshots
BEGIN SELECT RAISE(ABORT,'workpaper snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_method_versions_no_update BEFORE UPDATE ON firm_methodology_versions
BEGIN SELECT RAISE(ABORT,'methodology versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_method_versions_no_delete BEFORE DELETE ON firm_methodology_versions
BEGIN SELECT RAISE(ABORT,'methodology versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_consulting_events_no_update BEFORE UPDATE ON consulting_events
BEGIN SELECT RAISE(ABORT,'consulting events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_consulting_events_no_delete BEFORE DELETE ON consulting_events
BEGIN SELECT RAISE(ABORT,'consulting events are immutable'); END;
