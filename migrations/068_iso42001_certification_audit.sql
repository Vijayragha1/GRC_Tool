-- 068_iso42001_certification_audit.sql
-- ISO/IEC 42001 certification audit workspace.
--
-- A certification audit is a set of requests: every document, record,
-- population and sample the auditors ask for, each mapped to a clause or
-- Annex A control and belonging to Stage 1 (document review), Stage 2
-- (operation) or fieldwork samples. The product ships a standard checklist of
-- these that every ISO 42001 client starts from; a certification body's own
-- list can be imported instead or as well. Audit dates belong to the client
-- and are optional.
--
-- Ownership is split deliberately. Fields the checklist or list owns
-- (description, guidance, clause mapping, any due date) are replaced when a
-- newer version is applied. Fields the consulting team owns (status, owner,
-- client hand-off, linked records, notes) are never touched. A request that
-- disappears from a later version is marked withdrawn, not deleted, so the
-- history of what was asked for survives.
--
-- The AI system register is the population the auditor samples from: newly
-- implemented AI systems, vendors in the AI lifecycle, changes and incidents
-- affecting AI systems. Impact assessments (clause 6.1.4, 8.4, Annex A.5) are
-- versioned per system and frozen on approval.
--
-- Every table carries workspace_id so tenant deletion finds it, and every
-- cross-record link is checked against the workspace at the database boundary.

CREATE TABLE IF NOT EXISTS aims_request_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','committed','discarded')),
  source_filename TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT,
  payload_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  committed_by INTEGER REFERENCES users(id),
  committed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_aims_request_imports_ws ON aims_request_imports(workspace_id, status, id);

CREATE TABLE IF NOT EXISTS aims_audit_programmes (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  certification_body TEXT,
  stage1_date DATE,
  stage2_date DATE,
  review_period_start DATE,
  review_period_end DATE,
  current_import_id INTEGER REFERENCES aims_request_imports(id) ON DELETE SET NULL,
  checklist_version TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS aims_audit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  -- 'standard' requests come from the product's ISO 42001 evidence checklist
  -- (data/iso42001-audit-checklist.js), the same for every client. 'import'
  -- requests come from a list a certification body sent for this client.
  -- 'manual' covers something the auditor raised outside any list (by email,
  -- in a call). Each source only ever withdraws its own requests.
  source TEXT NOT NULL DEFAULT 'import' CHECK(source IN ('standard','import','manual')),
  kind TEXT NOT NULL CHECK(kind IN ('evidence','policy','population','sample')),
  stage TEXT NOT NULL CHECK(stage IN ('stage1','stage2','fieldwork')),
  description TEXT NOT NULL,
  guidance TEXT,
  cb_advice TEXT,
  cb_class TEXT,
  cb_category TEXT,
  cb_type TEXT,
  cb_status TEXT,
  requirement_text TEXT,
  due_date DATE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(status IN ('not_started','with_client','ready','submitted','accepted','follow_up','not_applicable')),
  status_note TEXT,
  consultant_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  client_request_id INTEGER REFERENCES client_requests(id) ON DELETE SET NULL,
  submitted_at TEXT,
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at TEXT,
  first_import_id INTEGER REFERENCES aims_request_imports(id) ON DELETE SET NULL,
  last_import_id INTEGER REFERENCES aims_request_imports(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_aims_audit_requests_stage ON aims_audit_requests(workspace_id, stage, status);
CREATE INDEX IF NOT EXISTS idx_aims_audit_requests_client ON aims_audit_requests(client_request_id);

CREATE TRIGGER IF NOT EXISTS trg_aims_request_client_tenant_insert
BEFORE INSERT ON aims_audit_requests
WHEN NEW.client_request_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM client_requests cr WHERE cr.id=NEW.client_request_id AND cr.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'audit request client hand-off crosses workspace boundary'); END;

CREATE TRIGGER IF NOT EXISTS trg_aims_request_client_tenant_update
BEFORE UPDATE OF client_request_id, workspace_id ON aims_audit_requests
WHEN NEW.client_request_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM client_requests cr WHERE cr.id=NEW.client_request_id AND cr.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'audit request client hand-off crosses workspace boundary'); END;

CREATE TABLE IF NOT EXISTS aims_request_requirements (
  request_id INTEGER NOT NULL REFERENCES aims_audit_requests(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES iso42001_items(id),
  PRIMARY KEY (request_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_aims_request_requirements_item ON aims_request_requirements(workspace_id, item_id);

CREATE TRIGGER IF NOT EXISTS trg_aims_request_requirements_tenant
BEFORE INSERT ON aims_request_requirements
WHEN NOT EXISTS (SELECT 1 FROM aims_audit_requests r WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'audit request mapping crosses workspace boundary'); END;

CREATE TABLE IF NOT EXISTS aims_request_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES aims_audit_requests(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK(record_type IN ('evidence','document')),
  record_id INTEGER NOT NULL,
  note TEXT,
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(request_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_aims_request_records_request ON aims_request_records(request_id);

CREATE TRIGGER IF NOT EXISTS trg_aims_request_records_tenant
BEFORE INSERT ON aims_request_records
WHEN NOT EXISTS (SELECT 1 FROM aims_audit_requests r WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id)
  OR (NEW.record_type='evidence' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.id=NEW.record_id AND e.workspace_id=NEW.workspace_id))
  OR (NEW.record_type='document' AND NOT EXISTS (SELECT 1 FROM generated_docs d WHERE d.id=NEW.record_id AND d.workspace_id=NEW.workspace_id))
BEGIN SELECT RAISE(ABORT,'audit request record crosses workspace boundary'); END;

CREATE TABLE IF NOT EXISTS aims_request_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES aims_audit_requests(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','evidenced','exception')),
  evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL,
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(request_id, label)
);

CREATE TRIGGER IF NOT EXISTS trg_aims_request_samples_tenant
BEFORE INSERT ON aims_request_samples
WHEN NOT EXISTS (SELECT 1 FROM aims_audit_requests r WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id)
  OR (NEW.evidence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.id=NEW.evidence_id AND e.workspace_id=NEW.workspace_id))
BEGIN SELECT RAISE(ABORT,'audit sample crosses workspace boundary'); END;

CREATE TRIGGER IF NOT EXISTS trg_aims_request_samples_tenant_update
BEFORE UPDATE OF evidence_id ON aims_request_samples
WHEN NEW.evidence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.id=NEW.evidence_id AND e.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'audit sample crosses workspace boundary'); END;

-- Append-only: the trail of what was asked, sent, received and submitted.
CREATE TABLE IF NOT EXISTS aims_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES aims_audit_requests(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'imported','added_manually','updated_by_cb','withdrawn_by_cb','restored_by_cb','status_changed','sent_to_client',
    'client_response_accepted','client_response_returned','record_linked','record_unlinked',
    'sample_added','sample_updated','owner_changed')),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_aims_request_events_request ON aims_request_events(request_id, id);

CREATE TRIGGER IF NOT EXISTS trg_aims_request_events_no_update
BEFORE UPDATE ON aims_request_events
BEGIN SELECT RAISE(ABORT,'audit request events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_aims_request_events_no_delete
BEFORE DELETE ON aims_request_events
BEGIN SELECT RAISE(ABORT,'audit request events are immutable'); END;

-- AI system register.
CREATE TABLE IF NOT EXISTS ai_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT,
  intended_users TEXT,
  org_roles TEXT NOT NULL DEFAULT '[]',
  lifecycle_stage TEXT NOT NULL DEFAULT 'in_use'
    CHECK(lifecycle_stage IN ('planned','in_development','in_use','retired')),
  go_live_date DATE,
  retired_date DATE,
  in_scope INTEGER NOT NULL DEFAULT 1 CHECK(in_scope IN (0,1)),
  scope_note TEXT,
  system_owner TEXT,
  automation_level TEXT CHECK(automation_level IS NULL OR automation_level IN ('assistive','human_in_loop','human_on_loop','autonomous')),
  human_oversight TEXT,
  data_resources TEXT,
  tooling_resources TEXT,
  compute_resources TEXT,
  human_resources TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS ai_system_suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ai_system_id INTEGER NOT NULL REFERENCES ai_systems(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_name TEXT NOT NULL,
  lifecycle_role TEXT NOT NULL,
  service TEXT,
  assurance TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_ai_system_suppliers_tenant
BEFORE INSERT ON ai_system_suppliers
WHEN NOT EXISTS (SELECT 1 FROM ai_systems s WHERE s.id=NEW.ai_system_id AND s.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'AI system supplier crosses workspace boundary'); END;

CREATE TABLE IF NOT EXISTS ai_system_links (
  ai_system_id INTEGER NOT NULL REFERENCES ai_systems(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK(link_type IN ('change','incident')),
  target_id INTEGER NOT NULL,
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ai_system_id, link_type, target_id)
);

CREATE TRIGGER IF NOT EXISTS trg_ai_system_links_tenant
BEFORE INSERT ON ai_system_links
WHEN NOT EXISTS (SELECT 1 FROM ai_systems s WHERE s.id=NEW.ai_system_id AND s.workspace_id=NEW.workspace_id)
  OR (NEW.link_type='change' AND NOT EXISTS (SELECT 1 FROM changes c WHERE c.id=NEW.target_id AND c.workspace_id=NEW.workspace_id))
  OR (NEW.link_type='incident' AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.id=NEW.target_id AND i.workspace_id=NEW.workspace_id))
BEGIN SELECT RAISE(ABORT,'AI system link crosses workspace boundary'); END;

-- AI system impact assessments. A draft is edited in place; approval freezes
-- the content with a hash, and a reassessment is a new version that
-- supersedes the approved one rather than rewriting it.
CREATE TABLE IF NOT EXISTS ai_impact_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ai_system_id INTEGER NOT NULL REFERENCES ai_systems(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
  trigger_reason TEXT,
  affected_parties TEXT,
  intended_benefits TEXT,
  potential_harms TEXT,
  failure_modes TEXT,
  misuse TEXT,
  demographic_notes TEXT,
  oversight_measures TEXT,
  mitigations TEXT,
  residual_level TEXT CHECK(residual_level IS NULL OR residual_level IN ('low','medium','high')),
  decision TEXT CHECK(decision IS NULL OR decision IN ('proceed','proceed_with_conditions','do_not_proceed')),
  conditions TEXT,
  prepared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  snapshot_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(ai_system_id, version_no)
);

CREATE TRIGGER IF NOT EXISTS trg_ai_impact_assessments_tenant
BEFORE INSERT ON ai_impact_assessments
WHEN NOT EXISTS (SELECT 1 FROM ai_systems s WHERE s.id=NEW.ai_system_id AND s.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'AI impact assessment crosses workspace boundary'); END;

CREATE TRIGGER IF NOT EXISTS trg_ai_impact_assessments_frozen
BEFORE UPDATE ON ai_impact_assessments
WHEN OLD.status IN ('approved','superseded') AND (
  NEW.status NOT IN ('approved','superseded')
  OR (OLD.status='superseded' AND NEW.status!='superseded')
  OR NEW.trigger_reason IS NOT OLD.trigger_reason OR NEW.affected_parties IS NOT OLD.affected_parties
  OR NEW.intended_benefits IS NOT OLD.intended_benefits OR NEW.potential_harms IS NOT OLD.potential_harms
  OR NEW.failure_modes IS NOT OLD.failure_modes OR NEW.misuse IS NOT OLD.misuse
  OR NEW.demographic_notes IS NOT OLD.demographic_notes OR NEW.oversight_measures IS NOT OLD.oversight_measures
  OR NEW.mitigations IS NOT OLD.mitigations OR NEW.residual_level IS NOT OLD.residual_level
  OR NEW.decision IS NOT OLD.decision OR NEW.conditions IS NOT OLD.conditions
  OR NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at
  OR NEW.snapshot_hash IS NOT OLD.snapshot_hash OR NEW.ai_system_id IS NOT OLD.ai_system_id
  OR NEW.version_no IS NOT OLD.version_no)
BEGIN SELECT RAISE(ABORT,'an approved AI impact assessment is frozen; start a new version'); END;

CREATE TRIGGER IF NOT EXISTS trg_ai_impact_assessments_no_delete
BEFORE DELETE ON ai_impact_assessments
WHEN OLD.status IN ('approved','superseded')
BEGIN SELECT RAISE(ABORT,'an approved AI impact assessment cannot be deleted'); END;
