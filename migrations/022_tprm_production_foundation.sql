-- 022_tprm_production_foundation.sql
-- Production TPRM foundation: accountable supplier ownership, versioned risk,
-- approval decisions, supplier-scoped findings, archival, and hardened vendor
-- questionnaire invitations. Additive and forward-only.

ALTER TABLE suppliers ADD COLUMN relationship_owner TEXT;
ALTER TABLE suppliers ADD COLUMN business_owner TEXT;
ALTER TABLE suppliers ADD COLUMN security_reviewer TEXT;
ALTER TABLE suppliers ADD COLUMN privacy_owner TEXT;
ALTER TABLE suppliers ADD COLUMN service_category TEXT;
ALTER TABLE suppliers ADD COLUMN processing_purpose TEXT;
ALTER TABLE suppliers ADD COLUMN data_categories TEXT;
ALTER TABLE suppliers ADD COLUMN hosting_locations TEXT;
ALTER TABLE suppliers ADD COLUMN critical_processes TEXT;
ALTER TABLE suppliers ADD COLUMN system_access TEXT;
ALTER TABLE suppliers ADD COLUMN rto_hours INTEGER;
ALTER TABLE suppliers ADD COLUMN rpo_hours INTEGER;
ALTER TABLE suppliers ADD COLUMN exit_strategy TEXT;
ALTER TABLE suppliers ADD COLUMN archived_at TEXT;
ALTER TABLE suppliers ADD COLUMN archived_by INTEGER REFERENCES users(id);
ALTER TABLE suppliers ADD COLUMN archive_reason TEXT;
ALTER TABLE suppliers ADD COLUMN risk_override_score INTEGER;
ALTER TABLE suppliers ADD COLUMN risk_override_reason TEXT;
ALTER TABLE suppliers ADD COLUMN risk_override_by INTEGER REFERENCES users(id);
ALTER TABLE suppliers ADD COLUMN risk_override_at TEXT;

ALTER TABLE supplier_questionnaires ADD COLUMN invitation_status TEXT DEFAULT 'not_sent';
ALTER TABLE supplier_questionnaires ADD COLUMN external_contact_name TEXT;
ALTER TABLE supplier_questionnaires ADD COLUMN external_opened_at TEXT;
ALTER TABLE supplier_questionnaires ADD COLUMN external_last_saved_at TEXT;
ALTER TABLE supplier_questionnaires ADD COLUMN due_date TEXT;
ALTER TABLE supplier_questionnaires ADD COLUMN clarification_message TEXT;
ALTER TABLE supplier_questionnaires ADD COLUMN clarification_requested_at TEXT;
ALTER TABLE supplier_questionnaires ADD COLUMN reopened_at TEXT;
ALTER TABLE supplier_questionnaires ADD COLUMN reopened_by INTEGER REFERENCES users(id);

-- Links the converged, hash-only external token table to legacy DDQ records
-- while the questionnaire UI is migrated to the generic assessment engine.
ALTER TABLE external_assessment_tokens ADD COLUMN questionnaire_id INTEGER REFERENCES supplier_questionnaires(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_extok_questionnaire ON external_assessment_tokens(questionnaire_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS supplier_risk_methodologies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  domain_weights TEXT NOT NULL,
  control_weights TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  review_cadence TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_method_active
  ON supplier_risk_methodologies(workspace_id) WHERE is_active=1;

CREATE TABLE IF NOT EXISTS supplier_risk_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  methodology_id INTEGER REFERENCES supplier_risk_methodologies(id),
  methodology_version INTEGER NOT NULL,
  inherent_score INTEGER NOT NULL,
  control_effectiveness INTEGER NOT NULL,
  calculated_residual_score INTEGER NOT NULL,
  effective_residual_score INTEGER NOT NULL,
  risk_band TEXT NOT NULL,
  components TEXT NOT NULL,
  rationale TEXT,
  event_type TEXT NOT NULL DEFAULT 'recalculation',
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_risk_history
  ON supplier_risk_snapshots(supplier_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS supplier_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('approved','conditional','rejected','renewed','offboard')),
  rationale TEXT NOT NULL,
  conditions TEXT,
  valid_until TEXT,
  residual_risk_score INTEGER NOT NULL,
  methodology_version INTEGER NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decider_name TEXT NOT NULL,
  decided_at TEXT DEFAULT (datetime('now')),
  superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_decisions
  ON supplier_decisions(supplier_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS supplier_finding_links (
  finding_id INTEGER PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  questionnaire_id INTEGER REFERENCES supplier_questionnaires(id) ON DELETE SET NULL,
  domain TEXT,
  due_date TEXT,
  owner_name TEXT,
  risk_acceptance_reason TEXT,
  risk_acceptance_expires_at TEXT,
  accepted_by INTEGER REFERENCES users(id),
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_findings
  ON supplier_finding_links(supplier_id, due_date);

-- Preserve existing lifecycle state while introducing archival semantics.
UPDATE suppliers SET lifecycle_stage='active' WHERE lifecycle_stage IS NULL;
UPDATE supplier_questionnaires
   SET invitation_status=CASE
     WHEN external_completed_at IS NOT NULL THEN 'submitted'
     WHEN responded_at IS NOT NULL THEN 'submitted'
     WHEN sent_at IS NOT NULL THEN 'sent'
     ELSE 'not_sent'
   END
 WHERE invitation_status IS NULL OR invitation_status='not_sent';
