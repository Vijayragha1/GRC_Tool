-- 046_tprm_domain_foundation.sql
-- Standalone, production-grade TPRM domain foundation.
--
-- This migration is deliberately additive and forward-only. Existing supplier
-- assessments, snapshots, hashes and decisions remain untouched. Legacy facts
-- whose decision-maker role or lifecycle lineage cannot be proved are recorded
-- in migration_quarantine instead of being silently reinterpreted.

-- Contract assurance starts before an executed agreement exists. Migration 042
-- accidentally required agreement identity even for an in-progress review.
-- Keep the completion gate, but permit a draft/in-progress review to be opened.
DROP TRIGGER IF EXISTS trg_supplier_contract_agreement_insert;
CREATE TRIGGER IF NOT EXISTS trg_supplier_contract_agreement_complete_insert
BEFORE INSERT ON supplier_contract_reviews
FOR EACH ROW
WHEN NEW.status='complete' AND (
  trim(COALESCE(NEW.agreement_reference,''))=''
  OR NEW.agreement_reference<>trim(NEW.agreement_reference)
  OR length(COALESCE(NEW.agreement_date,''))!=10
  OR COALESCE(NEW.agreement_date,'') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR strftime('%Y-%m-%d',NEW.agreement_date||' 00:00:00','+0 days') IS NOT NEW.agreement_date
)
BEGIN
  SELECT RAISE(ABORT,'completed supplier contract review requires an agreement reference and valid ISO agreement date');
END;

-- Composite keys make tenant ownership enforceable by foreign keys in every
-- new TPRM table. id remains the historic primary key in each parent table.
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_workspace_id
  ON suppliers(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_inherent_workspace_supplier_id
  ON supplier_inherent_assessments(workspace_id,supplier_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_ddq_workspace_supplier_id
  ON supplier_ddq_assessments(workspace_id,supplier_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_contract_workspace_supplier_id
  ON supplier_contract_reviews(workspace_id,supplier_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_workspace_id
  ON findings(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_documents_workspace_supplier_id
  ON supplier_documents(workspace_id,supplier_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_ddq_evidence_workspace_id
  ON supplier_ddq_evidence(workspace_id,id);

-- Operational module activation is independent from workspace.frameworks.
-- needs_classification is migration-only: it keeps historic supplier records
-- visible without guessing which commercial service model the client bought.
CREATE TABLE IF NOT EXISTS tprm_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_model TEXT CHECK(service_model IN ('assessment_only','programme_setup','managed_lifecycle')),
  status TEXT NOT NULL CHECK(status IN ('active','needs_classification','closed')),
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_to TEXT,
  activation_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  classified_by INTEGER REFERENCES users(id),
  classified_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  close_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,id),
  CHECK(
    (status='needs_classification' AND service_model IS NULL)
    OR (status='active' AND service_model IS NOT NULL AND effective_to IS NULL)
    OR (status='closed' AND effective_to IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_module_open_workspace
  ON tprm_modules(workspace_id) WHERE status IN ('active','needs_classification');
CREATE INDEX IF NOT EXISTS idx_tprm_modules_workspace_history
  ON tprm_modules(workspace_id,effective_from DESC,id DESC);

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_identity_immutable
BEFORE UPDATE OF workspace_id,effective_from,activation_reason,created_by,created_at
ON tprm_modules
BEGIN
  SELECT RAISE(ABORT,'TPRM module activation identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_module_service_model_transition
BEFORE UPDATE OF service_model ON tprm_modules
WHEN NOT (
  OLD.status='needs_classification'
  AND OLD.service_model IS NULL
  AND NEW.service_model IN ('assessment_only','programme_setup','managed_lifecycle')
  AND NEW.status='active'
)
BEGIN
  SELECT RAISE(ABORT,'TPRM service model is immutable after classification');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_module_status_transition
BEFORE UPDATE OF status ON tprm_modules
WHEN NOT (
  (OLD.status='needs_classification' AND NEW.status IN ('active','closed'))
  OR (OLD.status='active' AND NEW.status='closed')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM module status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_module_no_delete
BEFORE DELETE ON tprm_modules
BEGIN
  SELECT RAISE(ABORT,'TPRM module history cannot be deleted');
END;

-- A cycle is one onboarding, periodic or event-triggered assessment. A new
-- reassessment links to the last client decision as its approved baseline; it
-- never supersedes that baseline until a new client decision is recorded.
CREATE TABLE IF NOT EXISTS tprm_assessment_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  cycle_number INTEGER NOT NULL CHECK(cycle_number>0),
  cycle_type TEXT NOT NULL CHECK(cycle_type IN ('onboarding','periodic','triggered')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  trigger_reason TEXT,
  baseline_decision_id INTEGER,
  inherent_assessment_id INTEGER,
  ddq_assessment_id INTEGER,
  contract_review_id INTEGER,
  client_decision_authority_id INTEGER REFERENCES users(id),
  started_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id,supplier_id,cycle_number),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,inherent_assessment_id)
    REFERENCES supplier_inherent_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,ddq_assessment_id)
    REFERENCES supplier_ddq_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,contract_review_id)
    REFERENCES supplier_contract_reviews(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,baseline_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  CHECK((status='completed')=(completed_at IS NOT NULL)),
  CHECK((status='cancelled')=(cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_cycle_active_supplier
  ON tprm_assessment_cycles(workspace_id,supplier_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_tprm_cycles_module_status
  ON tprm_assessment_cycles(module_id,status,due_at);

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_identity_immutable
BEFORE UPDATE OF workspace_id,supplier_id,module_id,cycle_number,cycle_type,trigger_reason,
  baseline_decision_id,started_by,started_at
ON tprm_assessment_cycles
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment cycle identity and baseline are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_authority_insert
BEFORE INSERT ON tprm_assessment_cycles
WHEN NEW.client_decision_authority_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM users u
  JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
  WHERE u.id=NEW.client_decision_authority_id AND u.user_type='client' AND u.active=1
    AND wm.role IN ('client_owner','client_admin')
)
BEGIN
  SELECT RAISE(ABORT,'TPRM decision authority must be an active client workspace member');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_authority_update
BEFORE UPDATE OF client_decision_authority_id ON tprm_assessment_cycles
WHEN (OLD.client_decision_authority_id IS NOT NULL AND NEW.client_decision_authority_id IS NOT OLD.client_decision_authority_id)
 OR (NEW.client_decision_authority_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM users u
   JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
   WHERE u.id=NEW.client_decision_authority_id AND u.user_type='client' AND u.active=1
     AND wm.role IN ('client_owner','client_admin')
 ))
BEGIN
  SELECT RAISE(ABORT,'TPRM decision authority is immutable once assigned and must be an active client workspace member');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_artifact_lineage_immutable
BEFORE UPDATE OF inherent_assessment_id,ddq_assessment_id,contract_review_id
ON tprm_assessment_cycles
WHEN (OLD.inherent_assessment_id IS NOT NULL AND NEW.inherent_assessment_id IS NOT OLD.inherent_assessment_id)
  OR (OLD.ddq_assessment_id IS NOT NULL AND NEW.ddq_assessment_id IS NOT OLD.ddq_assessment_id)
  OR (OLD.contract_review_id IS NOT NULL AND NEW.contract_review_id IS NOT OLD.contract_review_id)
BEGIN
  SELECT RAISE(ABORT,'linked TPRM assessment artifacts cannot be replaced');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_status_transition
BEFORE UPDATE OF status ON tprm_assessment_cycles
WHEN NOT (OLD.status='active' AND NEW.status IN ('completed','cancelled'))
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM assessment cycle status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_no_delete
BEFORE DELETE ON tprm_assessment_cycles
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment cycle history cannot be deleted');
END;

-- Append-only lifecycle history. Domain writes include a SHA-256 chain; NULL
-- hashes are accepted only for a migration-created historic link if required.
CREATE TABLE IF NOT EXISTS tprm_lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER,
  module_id INTEGER NOT NULL,
  cycle_id INTEGER,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'module_enabled','module_classified','module_closed','cycle_started','cycle_cancelled',
    'artifact_linked','evidence_released','evidence_release_withdrawn','decision_authority_assigned','stage_transition','recommendation_issued','client_decision_recorded',
    'condition_completed','clarification_requested','clarification_responded','clarification_resolved',
    'monitoring_signal_recorded','monitoring_signal_triaged','reassessment_scheduled','legacy_history_linked'
  )),
  from_stage TEXT CHECK(from_stage IS NULL OR from_stage IN (
    'module_setup','intake','inherent_risk','due_diligence','contract_assurance',
    'consultancy_review','quality_review','client_decision','monitoring','deferred',
    'rejected','offboarding','closed'
  )),
  to_stage TEXT CHECK(to_stage IS NULL OR to_stage IN (
    'module_setup','intake','inherent_risk','due_diligence','contract_assurance',
    'consultancy_review','quality_review','client_decision','monitoring','deferred',
    'rejected','offboarding','closed'
  )),
  actor_user_id INTEGER REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('consultant','consultancy_manager','client','external_provider','system','migration')),
  actor_name TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  idempotency_key TEXT,
  request_fingerprint TEXT,
  previous_event_hash TEXT,
  event_hash TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_hash),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  CHECK((supplier_id IS NULL AND cycle_id IS NULL) OR supplier_id IS NOT NULL),
  CHECK(event_hash IS NULL OR (length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(previous_event_hash IS NULL OR (length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
);
CREATE INDEX IF NOT EXISTS idx_tprm_events_supplier_time
  ON tprm_lifecycle_events(workspace_id,supplier_id,occurred_at,id);
CREATE INDEX IF NOT EXISTS idx_tprm_events_cycle_time
  ON tprm_lifecycle_events(cycle_id,occurred_at,id);
CREATE TRIGGER IF NOT EXISTS trg_tprm_event_no_update
BEFORE UPDATE ON tprm_lifecycle_events
BEGIN
  SELECT RAISE(ABORT,'TPRM lifecycle events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_event_no_delete
BEFORE DELETE ON tprm_lifecycle_events
BEGIN
  SELECT RAISE(ABORT,'TPRM lifecycle events cannot be deleted');
END;

-- Consultancy recommendations are issued, immutable snapshots. Author and QA
-- reviewer must be distinct firm-side users. A correction is a successor row.
CREATE TABLE IF NOT EXISTS tprm_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'recommend_onboard','recommend_with_conditions','do_not_recommend','insufficient_information'
  )),
  executive_summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  residual_risk_score INTEGER CHECK(residual_risk_score BETWEEN 0 AND 100),
  residual_risk_band TEXT CHECK(residual_risk_band IN ('low','moderate','high','critical','unknown')),
  valid_until TEXT,
  inherent_assessment_id INTEGER,
  ddq_assessment_id INTEGER,
  contract_review_id INTEGER,
  readiness_snapshot_json TEXT NOT NULL CHECK(json_valid(readiness_snapshot_json)),
  artifact_snapshot_json TEXT NOT NULL CHECK(json_valid(artifact_snapshot_json)),
  recommendation_hash TEXT NOT NULL,
  issued_by INTEGER NOT NULL REFERENCES users(id),
  issuer_name TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  quality_reviewed_by INTEGER NOT NULL REFERENCES users(id),
  quality_reviewer_name TEXT NOT NULL,
  quality_reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  quality_review_rationale TEXT NOT NULL,
  supersedes_id INTEGER,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  UNIQUE(workspace_id,supplier_id,cycle_id,version),
  UNIQUE(workspace_id,supplier_id,cycle_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(idempotency_key),
  UNIQUE(recommendation_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,inherent_assessment_id)
    REFERENCES supplier_inherent_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,ddq_assessment_id)
    REFERENCES supplier_ddq_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,contract_review_id)
    REFERENCES supplier_contract_reviews(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,supersedes_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  CHECK(issued_by<>quality_reviewed_by),
  CHECK(length(recommendation_hash)=64 AND recommendation_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key))),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX IF NOT EXISTS idx_tprm_recommendations_cycle_version
  ON tprm_recommendations(cycle_id,version DESC);

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_actor_governance
BEFORE INSERT ON tprm_recommendations
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w
  JOIN users author ON author.id=NEW.issued_by
  JOIN users reviewer ON reviewer.id=NEW.quality_reviewed_by
  WHERE w.id=NEW.workspace_id
    AND author.user_type='firm' AND reviewer.user_type='firm'
    AND author.firm_id=w.firm_id AND reviewer.firm_id=w.firm_id
    AND author.active=1 AND reviewer.active=1
    AND author.id<>reviewer.id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation requires distinct active firm author and quality reviewer');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_lineage
BEFORE INSERT ON tprm_recommendations
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_recommendations prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.supplier_id=NEW.supplier_id
      AND prior.cycle_id=NEW.cycle_id
      AND NEW.version=prior.version+1
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM recommendation version lineage');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_no_update
BEFORE UPDATE ON tprm_recommendations
BEGIN
  SELECT RAISE(ABORT,'issued TPRM recommendations are immutable; issue a successor version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_no_delete
BEFORE DELETE ON tprm_recommendations
BEGIN
  SELECT RAISE(ABORT,'issued TPRM recommendations cannot be deleted');
END;

-- Client onboarding decisions are deliberately separate. The client actor must
-- be an active client-side workspace member. Divergence from the consultancy
-- recommendation is calculated and enforced at the database boundary.
CREATE TABLE IF NOT EXISTS tprm_client_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  recommendation_id INTEGER NOT NULL,
  recommendation_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN (
    'onboard','onboard_with_conditions','do_not_onboard','defer_request_information'
  )),
  rationale TEXT NOT NULL,
  diverges_from_recommendation INTEGER NOT NULL CHECK(diverges_from_recommendation IN (0,1)),
  override_rationale TEXT,
  risk_acceptance_statement TEXT,
  risk_acceptance_expires_at TEXT,
  valid_until TEXT,
  client_actor_user_id INTEGER NOT NULL REFERENCES users(id),
  client_actor_name TEXT NOT NULL,
  client_actor_title TEXT NOT NULL,
  authority_basis TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  decision_snapshot_json TEXT NOT NULL CHECK(json_valid(decision_snapshot_json)),
  decision_hash TEXT NOT NULL,
  supersedes_id INTEGER,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  UNIQUE(workspace_id,supplier_id,version),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(idempotency_key),
  UNIQUE(decision_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,recommendation_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,supersedes_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  CHECK(length(decision_hash)=64 AND decision_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key))),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX IF NOT EXISTS idx_tprm_client_decisions_supplier_version
  ON tprm_client_decisions(workspace_id,supplier_id,version DESC);
CREATE INDEX IF NOT EXISTS idx_tprm_client_decisions_cycle
  ON tprm_client_decisions(cycle_id,decided_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_actor
BEFORE INSERT ON tprm_client_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM users u
  JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
  WHERE u.id=NEW.client_actor_user_id AND u.user_type='client' AND u.active=1
    AND wm.role IN ('client_owner','client_admin')
)
OR EXISTS (
  SELECT 1 FROM tprm_assessment_cycles c
  WHERE c.id=NEW.cycle_id AND c.client_decision_authority_id IS NOT NULL
    AND c.client_decision_authority_id<>NEW.client_actor_user_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM onboarding decision requires the assigned active client decision authority');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_recommendation
BEFORE INSERT ON tprm_client_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_recommendations r
  WHERE r.id=NEW.recommendation_id
    AND r.workspace_id=NEW.workspace_id
    AND r.supplier_id=NEW.supplier_id
    AND r.cycle_id=NEW.cycle_id
    AND r.version=NEW.recommendation_version
)
BEGIN
  SELECT RAISE(ABORT,'client decision must reference the exact recommendation version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_divergence
BEFORE INSERT ON tprm_client_decisions
WHEN NEW.diverges_from_recommendation IS NOT (
  SELECT CASE
    WHEN (r.outcome='recommend_onboard' AND NEW.decision='onboard')
      OR (r.outcome='recommend_with_conditions' AND NEW.decision='onboard_with_conditions')
      OR (r.outcome='do_not_recommend' AND NEW.decision='do_not_onboard')
      OR (r.outcome='insufficient_information' AND NEW.decision='defer_request_information')
    THEN 0 ELSE 1 END
  FROM tprm_recommendations r WHERE r.id=NEW.recommendation_id
)
BEGIN
  SELECT RAISE(ABORT,'client decision divergence flag does not match the recommendation');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_override_acceptance
BEFORE INSERT ON tprm_client_decisions
WHEN NEW.diverges_from_recommendation=1
 AND NEW.decision IN ('onboard','onboard_with_conditions')
 AND (
   length(trim(COALESCE(NEW.override_rationale,'')))<10
   OR length(trim(COALESCE(NEW.risk_acceptance_statement,'')))<10
   OR NEW.risk_acceptance_expires_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT,'divergent onboarding requires explicit client override rationale and expiring risk acceptance');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_lineage
BEFORE INSERT ON tprm_client_decisions
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_client_decisions prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.supplier_id=NEW.supplier_id
      AND NEW.version=prior.version+1
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM client-decision version lineage');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_no_update
BEFORE UPDATE ON tprm_client_decisions
BEGIN
  SELECT RAISE(ABORT,'client onboarding decisions are immutable; record a successor version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_no_delete
BEFORE DELETE ON tprm_client_decisions
BEGIN
  SELECT RAISE(ABORT,'client onboarding decisions cannot be deleted');
END;

-- Conditions are structured, owned and verifiable. Their definition is frozen;
-- only the governed fulfilment state may advance.
CREATE TABLE IF NOT EXISTS tprm_conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('recommendation','client_decision')),
  recommendation_id INTEGER,
  client_decision_id INTEGER,
  finding_id INTEGER,
  condition_type TEXT NOT NULL CHECK(condition_type IN ('remediation','control','contract','evidence','monitoring','risk_acceptance','other')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('low','moderate','high','critical')),
  owner_type TEXT NOT NULL CHECK(owner_type IN ('client','third_party','consultancy')),
  owner_user_id INTEGER REFERENCES users(id),
  owner_name TEXT NOT NULL,
  due_date TEXT NOT NULL,
  verification_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','evidence_submitted','verified','waived','cancelled')),
  evidence_summary TEXT,
  completion_note TEXT,
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  verified_by INTEGER REFERENCES users(id),
  waiver_rationale TEXT,
  waiver_expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,recommendation_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,client_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,finding_id) REFERENCES findings(workspace_id,id),
  CHECK(
    (source_type='recommendation' AND recommendation_id IS NOT NULL AND client_decision_id IS NULL)
    OR (source_type='client_decision' AND recommendation_id IS NULL AND client_decision_id IS NOT NULL)
  ),
  CHECK(status!='verified' OR (verified_at IS NOT NULL AND verified_by IS NOT NULL AND length(trim(COALESCE(completion_note,'')))>=5)),
  CHECK(status!='waived' OR (length(trim(COALESCE(waiver_rationale,'')))>=10 AND waiver_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tprm_conditions_supplier_status
  ON tprm_conditions(workspace_id,supplier_id,status,due_date);
CREATE INDEX IF NOT EXISTS idx_tprm_conditions_cycle
  ON tprm_conditions(cycle_id,status,severity);
CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_definition_immutable
BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,source_type,recommendation_id,client_decision_id,
  finding_id,condition_type,title,description,severity,owner_type,owner_user_id,owner_name,due_date,
  verification_criteria,created_by,created_at
ON tprm_conditions
BEGIN
  SELECT RAISE(ABORT,'issued TPRM condition definition is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_supplier_finding
BEFORE INSERT ON tprm_conditions
WHEN NEW.finding_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM supplier_finding_links l
  WHERE l.finding_id=NEW.finding_id AND l.supplier_id=NEW.supplier_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition finding is not linked to this third party');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_status_transition
BEFORE UPDATE OF status ON tprm_conditions
WHEN NOT (
  (OLD.status='open' AND NEW.status IN ('in_progress','evidence_submitted','verified','waived','cancelled'))
  OR (OLD.status='in_progress' AND NEW.status IN ('evidence_submitted','verified','waived','cancelled'))
  OR (OLD.status='evidence_submitted' AND NEW.status IN ('in_progress','verified','waived','cancelled'))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM condition status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_no_delete
BEFORE DELETE ON tprm_conditions
BEGIN
  SELECT RAISE(ABORT,'TPRM conditions cannot be deleted');
END;

-- Client evidence disclosure is deny-by-default. A release is an immutable,
-- explicit allowlist entry; withdrawal is a second append-only fact rather
-- than a rewrite of the original authorization.
CREATE TABLE IF NOT EXISTS tprm_evidence_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('supplier_document','ddq_evidence')),
  supplier_document_id INTEGER,
  ddq_evidence_id INTEGER,
  client_label TEXT NOT NULL,
  client_description TEXT,
  allow_download INTEGER NOT NULL DEFAULT 0 CHECK(allow_download IN (0,1)),
  expires_at TEXT,
  released_by INTEGER NOT NULL REFERENCES users(id),
  released_at TEXT NOT NULL DEFAULT (datetime('now')),
  release_hash TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE(workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,ddq_evidence_id),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(release_hash),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,supplier_document_id)
    REFERENCES supplier_documents(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,ddq_evidence_id)
    REFERENCES supplier_ddq_evidence(workspace_id,id),
  CHECK(
    (source_type='supplier_document' AND supplier_document_id IS NOT NULL AND ddq_evidence_id IS NULL)
    OR (source_type='ddq_evidence' AND supplier_document_id IS NULL AND ddq_evidence_id IS NOT NULL)
  ),
  CHECK(length(release_hash)=64 AND release_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(expires_at IS NULL OR (expires_at GLOB '????-??-??' AND strftime('%Y-%m-%d',expires_at||' 00:00:00','+0 days')=expires_at)),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
);
CREATE INDEX IF NOT EXISTS idx_tprm_evidence_releases_cycle
  ON tprm_evidence_releases(cycle_id,released_at,id);
CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_actor
BEFORE INSERT ON tprm_evidence_releases
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.released_by
  WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM evidence release requires an active consultancy user');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_ddq_scope
BEFORE INSERT ON tprm_evidence_releases
WHEN NEW.source_type='ddq_evidence' AND NOT EXISTS (
  SELECT 1 FROM supplier_ddq_evidence e
  JOIN supplier_ddq_assessments a ON a.id=e.assessment_id
  JOIN tprm_assessment_cycles c ON c.id=NEW.cycle_id
  WHERE e.id=NEW.ddq_evidence_id AND e.workspace_id=NEW.workspace_id
    AND a.workspace_id=NEW.workspace_id AND a.supplier_id=NEW.supplier_id
    AND c.workspace_id=NEW.workspace_id AND c.supplier_id=NEW.supplier_id
    AND c.ddq_assessment_id=a.id
)
BEGIN
  SELECT RAISE(ABORT,'released DDQ evidence is outside this governed assessment cycle');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_no_update
BEFORE UPDATE ON tprm_evidence_releases
BEGIN
  SELECT RAISE(ABORT,'TPRM evidence releases are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_no_delete
BEFORE DELETE ON tprm_evidence_releases
BEGIN
  SELECT RAISE(ABORT,'TPRM evidence releases cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_evidence_release_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  release_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  withdrawn_by INTEGER NOT NULL REFERENCES users(id),
  withdrawn_at TEXT NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  UNIQUE(release_id),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,supplier_id,release_id)
    REFERENCES tprm_evidence_releases(workspace_id,supplier_id,id),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key))),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_withdrawal_actor
BEFORE INSERT ON tprm_evidence_release_withdrawals
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.withdrawn_by
  WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM evidence withdrawal requires an active consultancy user');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_withdrawal_no_update
BEFORE UPDATE ON tprm_evidence_release_withdrawals
BEGIN
  SELECT RAISE(ABORT,'TPRM evidence-release withdrawals are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_withdrawal_no_delete
BEFORE DELETE ON tprm_evidence_release_withdrawals
BEGIN
  SELECT RAISE(ABORT,'TPRM evidence-release withdrawals cannot be deleted');
END;

-- Immutable cadence versions. The current schedule is the row with no
-- successor; a reassessment produces a successor without rewriting history.
CREATE TABLE IF NOT EXISTS tprm_review_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  client_decision_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  tier TEXT NOT NULL CHECK(tier IN ('tier_1','tier_2','tier_3','tier_4')),
  cadence_months INTEGER NOT NULL CHECK(cadence_months BETWEEN 1 AND 120),
  scheduled_from TEXT NOT NULL,
  next_review_date TEXT NOT NULL,
  schedule_basis TEXT NOT NULL,
  supersedes_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,supplier_id,version),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(client_decision_id),
  UNIQUE(supersedes_id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,client_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,supersedes_id)
    REFERENCES tprm_review_schedules(workspace_id,supplier_id,id)
);
CREATE INDEX IF NOT EXISTS idx_tprm_review_schedule_due
  ON tprm_review_schedules(workspace_id,next_review_date);
CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_positive_decision
BEFORE INSERT ON tprm_review_schedules
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_client_decisions d
  WHERE d.id=NEW.client_decision_id
    AND d.workspace_id=NEW.workspace_id
    AND d.supplier_id=NEW.supplier_id
    AND d.decision IN ('onboard','onboard_with_conditions')
)
BEGIN
  SELECT RAISE(ABORT,'review cadence requires a positive client onboarding decision');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_no_update
BEFORE UPDATE ON tprm_review_schedules
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedules are immutable; create a successor schedule');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_no_delete
BEFORE DELETE ON tprm_review_schedules
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedules cannot be deleted');
END;

-- Clarifications are separate from submitted DDQ responses. The request text
-- is immutable and a provider response can be recorded only once.
CREATE TABLE IF NOT EXISTS tprm_clarifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  ddq_assessment_id INTEGER NOT NULL,
  question_id TEXT,
  request_text TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','responded','resolved','withdrawn')),
  provider_response TEXT,
  provider_responder_name TEXT,
  provider_responder_email TEXT,
  responded_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT,
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,ddq_assessment_id)
    REFERENCES supplier_ddq_assessments(workspace_id,supplier_id,id),
  CHECK(status='open' OR status='withdrawn' OR provider_response IS NOT NULL),
  CHECK(status!='resolved' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND length(trim(COALESCE(resolution_note,'')))>=5))
);
CREATE INDEX IF NOT EXISTS idx_tprm_clarifications_cycle_status
  ON tprm_clarifications(cycle_id,status,due_date);
CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_request_immutable
BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,ddq_assessment_id,question_id,request_text,
  requested_by,requested_at,due_date
ON tprm_clarifications
BEGIN
  SELECT RAISE(ABORT,'TPRM clarification request is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_response_immutable
BEFORE UPDATE OF provider_response,provider_responder_name,provider_responder_email,responded_at
ON tprm_clarifications
WHEN OLD.provider_response IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'provider clarification response is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_status_transition
BEFORE UPDATE OF status ON tprm_clarifications
WHEN NOT (
  (OLD.status='open' AND NEW.status IN ('responded','withdrawn'))
  OR (OLD.status='responded' AND NEW.status='resolved')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM clarification status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_no_delete
BEFORE DELETE ON tprm_clarifications
BEGIN
  SELECT RAISE(ABORT,'TPRM clarifications cannot be deleted');
END;

-- Normalized, append-preserving intake for external monitoring sources. The
-- signal itself cannot change; triage metadata may advance once reviewed.
CREATE TABLE IF NOT EXISTS tprm_monitoring_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  cycle_id INTEGER,
  source TEXT NOT NULL,
  source_reference TEXT,
  fingerprint TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK(signal_type IN ('security_incident','breach','financial','regulatory','availability','control_change','contract','concentration','news','other')),
  severity TEXT NOT NULL CHECK(severity IN ('info','low','moderate','high','critical')),
  title TEXT NOT NULL,
  detail TEXT,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  requires_reassessment INTEGER NOT NULL DEFAULT 0 CHECK(requires_reassessment IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','triaged','dismissed','escalated')),
  triage_note TEXT,
  triaged_by INTEGER REFERENCES users(id),
  triaged_at TEXT,
  UNIQUE(workspace_id,source,fingerprint),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id)
);
CREATE INDEX IF NOT EXISTS idx_tprm_monitoring_signal_queue
  ON tprm_monitoring_signals(workspace_id,status,severity,observed_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_signal_definition_immutable
BEFORE UPDATE OF workspace_id,supplier_id,module_id,cycle_id,source,source_reference,fingerprint,
  signal_type,severity,title,detail,observed_at,received_at,requires_reassessment,metadata_json
ON tprm_monitoring_signals
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring signal facts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_signal_status_transition
BEFORE UPDATE OF status ON tprm_monitoring_signals
WHEN NOT (OLD.status='new' AND NEW.status IN ('triaged','dismissed','escalated'))
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM monitoring signal status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_signal_no_delete
BEFORE DELETE ON tprm_monitoring_signals
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring signals cannot be deleted');
END;

-- ---------- Conservative historic linkage ----------

-- Normalize the one known vocabulary collision. Record the original value so
-- the transformation remains transparent and auditable.
INSERT INTO migration_quarantine(phase,source_table,source_id,reason,raw_payload)
SELECT 'tprm046','suppliers',CAST(s.id AS TEXT),
       'Normalized legacy lifecycle alias terminating to canonical offboarding.',
       json_object('workspace_id',s.workspace_id,'supplier_id',s.id,'lifecycle_stage',s.lifecycle_stage)
FROM suppliers s
WHERE lower(trim(COALESCE(s.lifecycle_stage,'')))='terminating'
  AND NOT EXISTS (
    SELECT 1 FROM migration_quarantine q
    WHERE q.phase='tprm046' AND q.source_table='suppliers' AND q.source_id=CAST(s.id AS TEXT)
      AND q.reason LIKE 'Normalized legacy lifecycle alias%'
  );
UPDATE suppliers SET lifecycle_stage='offboarding'
 WHERE lower(trim(COALESCE(lifecycle_stage,'')))='terminating';

-- A workspace with supplier history clearly used TPRM, but its contracted
-- service model cannot be inferred. Preserve access behind classification.
INSERT INTO tprm_modules(workspace_id,service_model,status,effective_from,activation_reason)
SELECT s.workspace_id,NULL,'needs_classification',COALESCE(MIN(s.created_at),datetime('now')),
       'Historic supplier records detected; service model requires authorised classification.'
FROM suppliers s
GROUP BY s.workspace_id
HAVING NOT EXISTS (
  SELECT 1 FROM tprm_modules m
  WHERE m.workspace_id=s.workspace_id AND m.status IN ('active','needs_classification')
);

INSERT INTO migration_quarantine(phase,source_table,source_id,reason,raw_payload)
SELECT 'tprm046','workspaces',CAST(m.workspace_id AS TEXT),
       'Historic TPRM service model is ambiguous; module requires classification.',
       json_object('workspace_id',m.workspace_id,'module_id',m.id,'supplier_count',(
         SELECT COUNT(*) FROM suppliers s WHERE s.workspace_id=m.workspace_id
       ))
FROM tprm_modules m
WHERE m.status='needs_classification'
  AND NOT EXISTS (
    SELECT 1 FROM migration_quarantine q
    WHERE q.phase='tprm046' AND q.source_table='workspaces'
      AND q.source_id=CAST(m.workspace_id AS TEXT)
      AND q.reason LIKE 'Historic TPRM service model is ambiguous%'
  );

-- Link a historic current assessment set only when exactly one inherent record
-- exists and every current DDQ/contract record points to that same inherent
-- assessment. Anything else is quarantined below.
INSERT INTO tprm_assessment_cycles(
  workspace_id,supplier_id,module_id,cycle_number,cycle_type,status,trigger_reason,
  inherent_assessment_id,ddq_assessment_id,contract_review_id,started_by,started_at
)
SELECT s.workspace_id,s.id,m.id,1,ia.assessment_type,'active',
       'Conservatively linked from an unambiguous historic assessment set.',
       ia.id,
       (SELECT d.id FROM supplier_ddq_assessments d
         WHERE d.workspace_id=s.workspace_id AND d.supplier_id=s.id AND d.status!='superseded'
         LIMIT 1),
       (SELECT c.id FROM supplier_contract_reviews c
         WHERE c.workspace_id=s.workspace_id AND c.supplier_id=s.id AND c.status!='superseded'
         LIMIT 1),
       ia.created_by,ia.created_at
FROM suppliers s
JOIN tprm_modules m ON m.workspace_id=s.workspace_id AND m.status IN ('active','needs_classification')
JOIN supplier_inherent_assessments ia
  ON ia.workspace_id=s.workspace_id AND ia.supplier_id=s.id AND ia.status!='superseded'
WHERE (SELECT COUNT(*) FROM supplier_inherent_assessments x
       WHERE x.workspace_id=s.workspace_id AND x.supplier_id=s.id AND x.status!='superseded')=1
  AND (SELECT COUNT(*) FROM supplier_ddq_assessments d
       WHERE d.workspace_id=s.workspace_id AND d.supplier_id=s.id AND d.status!='superseded')<=1
  AND NOT EXISTS (
    SELECT 1 FROM supplier_ddq_assessments d
    WHERE d.workspace_id=s.workspace_id AND d.supplier_id=s.id AND d.status!='superseded'
      AND d.inherent_assessment_id<>ia.id
  )
  AND (SELECT COUNT(*) FROM supplier_contract_reviews c
       WHERE c.workspace_id=s.workspace_id AND c.supplier_id=s.id AND c.status!='superseded')<=1
  AND NOT EXISTS (
    SELECT 1 FROM supplier_contract_reviews c
    WHERE c.workspace_id=s.workspace_id AND c.supplier_id=s.id AND c.status!='superseded'
      AND c.inherent_assessment_id IS NOT ia.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM tprm_assessment_cycles cy
    WHERE cy.workspace_id=s.workspace_id AND cy.supplier_id=s.id
  );

INSERT INTO migration_quarantine(phase,source_table,source_id,reason,raw_payload)
SELECT 'tprm046','suppliers',CAST(s.id AS TEXT),
       'Historic assessment lineage is absent or ambiguous; no TPRM cycle was guessed.',
       json_object(
         'workspace_id',s.workspace_id,'supplier_id',s.id,
         'current_inherent_count',(SELECT COUNT(*) FROM supplier_inherent_assessments ia WHERE ia.supplier_id=s.id AND ia.status!='superseded'),
         'current_ddq_count',(SELECT COUNT(*) FROM supplier_ddq_assessments d WHERE d.supplier_id=s.id AND d.status!='superseded'),
         'current_contract_count',(SELECT COUNT(*) FROM supplier_contract_reviews c WHERE c.supplier_id=s.id AND c.status!='superseded')
       )
FROM suppliers s
WHERE NOT EXISTS (
  SELECT 1 FROM tprm_assessment_cycles cy
  WHERE cy.workspace_id=s.workspace_id AND cy.supplier_id=s.id
)
AND NOT EXISTS (
  SELECT 1 FROM migration_quarantine q
  WHERE q.phase='tprm046' AND q.source_table='suppliers' AND q.source_id=CAST(s.id AS TEXT)
    AND q.reason LIKE 'Historic assessment lineage is absent or ambiguous%'
);

-- Historic supplier_decisions combined consultancy and client authority. Their
-- exact rows remain in place; each is quarantined for explicit human mapping.
INSERT INTO migration_quarantine(phase,source_table,source_id,reason,raw_payload)
SELECT 'tprm046','supplier_decisions',CAST(d.id AS TEXT),
       'Legacy decision-maker role is ambiguous; retained but not promoted to a consultancy recommendation or client decision.',
       json_object(
         'workspace_id',d.workspace_id,'supplier_id',d.supplier_id,'decision',d.decision,
         'decider_name',d.decider_name,'decided_at',d.decided_at,'superseded_at',d.superseded_at
       )
FROM supplier_decisions d
WHERE NOT EXISTS (
  SELECT 1 FROM migration_quarantine q
  WHERE q.phase='tprm046' AND q.source_table='supplier_decisions' AND q.source_id=CAST(d.id AS TEXT)
);
