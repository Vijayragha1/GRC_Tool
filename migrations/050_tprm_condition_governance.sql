-- 050_tprm_condition_governance.sql
-- Governed follow-through for client-owned onboarding conditions.
--
-- Condition definitions remain frozen in tprm_conditions. This migration adds
-- an append-only, hash-linked fulfilment ledger and immutable links to the
-- exact evidence bytes a client owner submitted. The mutable columns on
-- tprm_conditions are only a current-state projection of that ledger.

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_conditions_workspace_supplier_cycle_id
  ON tprm_conditions(workspace_id,supplier_id,cycle_id,id);

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_owner_tenant
BEFORE INSERT ON tprm_conditions
WHEN (
  (NEW.owner_type='client' AND (
    NEW.owner_user_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM users u
      JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
      WHERE u.id=NEW.owner_user_id AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')
    )
  ))
  OR (NEW.owner_type='consultancy' AND (
    NEW.owner_user_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.owner_user_id AND u.user_type='firm' AND u.active=1
        AND u.firm_id=w.firm_id
    )
  ))
  OR (NEW.owner_type='third_party' AND NEW.owner_user_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition owner does not match the owner type and tenant');
END;

CREATE TABLE IF NOT EXISTS tprm_condition_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  condition_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'work_started','evidence_submitted','changes_requested','verified','waived'
  )),
  from_status TEXT NOT NULL CHECK(from_status IN (
    'open','in_progress','evidence_submitted','verified','waived','cancelled'
  )),
  to_status TEXT NOT NULL CHECK(to_status IN (
    'open','in_progress','evidence_submitted','verified','waived','cancelled'
  )),
  completion_statement TEXT,
  review_note TEXT,
  waiver_expires_at TEXT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('client_owner','consultant','consultancy_manager')),
  actor_name TEXT NOT NULL,
  expected_row_version INTEGER NOT NULL CHECK(expected_row_version>0),
  resulting_row_version INTEGER NOT NULL CHECK(resulting_row_version=expected_row_version+1),
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,supplier_id,cycle_id,condition_id,id),
  UNIQUE(idempotency_key),
  UNIQUE(event_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,condition_id)
    REFERENCES tprm_conditions(workspace_id,supplier_id,cycle_id,id),
  CHECK(length(trim(actor_name))>=2),
  CHECK(completion_statement IS NULL OR length(trim(completion_statement))>=10),
  CHECK(review_note IS NULL OR length(trim(review_note))>=10),
  CHECK(waiver_expires_at IS NULL OR (
    waiver_expires_at GLOB '????-??-??'
    AND strftime('%Y-%m-%d',waiver_expires_at||' 00:00:00','+0 days')=waiver_expires_at
  )),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  )),
  CHECK(
    (event_type='work_started' AND from_status='open' AND to_status='in_progress'
      AND completion_statement IS NULL AND review_note IS NULL AND waiver_expires_at IS NULL)
    OR (event_type='evidence_submitted' AND from_status='in_progress' AND to_status='evidence_submitted'
      AND completion_statement IS NOT NULL AND review_note IS NULL AND waiver_expires_at IS NULL)
    OR (event_type='changes_requested' AND from_status='evidence_submitted' AND to_status='in_progress'
      AND completion_statement IS NULL AND review_note IS NOT NULL AND waiver_expires_at IS NULL)
    OR (event_type='verified' AND from_status='evidence_submitted' AND to_status='verified'
      AND completion_statement IS NULL AND review_note IS NOT NULL AND waiver_expires_at IS NULL)
    OR (event_type='waived' AND from_status IN ('open','in_progress','evidence_submitted') AND to_status='waived'
      AND completion_statement IS NULL AND review_note IS NOT NULL AND waiver_expires_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_tprm_condition_events_condition
  ON tprm_condition_events(workspace_id,condition_id,occurred_at,id);

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_scope_and_version
BEFORE INSERT ON tprm_condition_events
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_conditions c
  WHERE c.id=NEW.condition_id AND c.workspace_id=NEW.workspace_id
    AND c.supplier_id=NEW.supplier_id AND c.cycle_id=NEW.cycle_id
    AND c.status=NEW.from_status AND c.row_version=NEW.expected_row_version
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition event is stale or outside its tenant and cycle');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_actor
BEFORE INSERT ON tprm_condition_events
WHEN (
  (NEW.actor_type='client_owner' AND (
    NEW.event_type NOT IN ('work_started','evidence_submitted')
    OR NOT EXISTS (
      SELECT 1 FROM tprm_conditions c
      JOIN users u ON u.id=NEW.actor_user_id
      JOIN workspace_members wm ON wm.workspace_id=NEW.workspace_id AND wm.user_id=u.id
      WHERE c.id=NEW.condition_id AND c.workspace_id=NEW.workspace_id
        AND c.supplier_id=NEW.supplier_id AND c.owner_type='client'
        AND c.owner_user_id=u.id AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')
    )
  ))
  OR (NEW.actor_type IN ('consultant','consultancy_manager') AND (
    NEW.event_type NOT IN ('changes_requested','verified','waived')
    OR NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.actor_user_id AND u.user_type='firm' AND u.active=1
        AND u.firm_id=w.firm_id
        AND (NEW.actor_type!='consultancy_manager' OR u.firm_role IN ('manager','firm_owner'))
    )
  ))
  OR (NEW.event_type='waived' AND NEW.actor_type!='consultancy_manager')
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition action is not authorized for this actor');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_hash_chain
BEFORE INSERT ON tprm_condition_events
WHEN COALESCE(NEW.previous_event_hash,'')<>COALESCE((
  SELECT event_hash FROM tprm_condition_events
  WHERE workspace_id=NEW.workspace_id AND condition_id=NEW.condition_id
  ORDER BY id DESC LIMIT 1
),'')
BEGIN
  SELECT RAISE(ABORT,'TPRM condition event hash chain does not match current history');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_no_update
BEFORE UPDATE ON tprm_condition_events
BEGIN
  SELECT RAISE(ABORT,'TPRM condition events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_no_delete
BEFORE DELETE ON tprm_condition_events
BEGIN
  SELECT RAISE(ABORT,'TPRM condition events cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_condition_evidence_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  condition_id INTEGER NOT NULL,
  condition_event_id INTEGER NOT NULL,
  original_filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0 AND size_bytes<=52428800),
  inspection_result TEXT NOT NULL CHECK(inspection_result IN ('inspected_upload_facade')),
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  evidence_hash TEXT NOT NULL,
  UNIQUE(condition_event_id),
  UNIQUE(evidence_hash),
  UNIQUE(workspace_id,supplier_id,cycle_id,condition_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,condition_id)
    REFERENCES tprm_conditions(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,condition_id,condition_event_id)
    REFERENCES tprm_condition_events(workspace_id,supplier_id,cycle_id,condition_id,id),
  CHECK(length(trim(original_filename)) BETWEEN 1 AND 500),
  CHECK(length(trim(stored_path)) BETWEEN 1 AND 500),
  CHECK(instr(stored_path,'/')=0 AND instr(stored_path,char(92))=0),
  CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(evidence_hash)=64 AND evidence_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX IF NOT EXISTS idx_tprm_condition_evidence_condition
  ON tprm_condition_evidence_links(workspace_id,condition_id,uploaded_at,id);

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_evidence_scope
BEFORE INSERT ON tprm_condition_evidence_links
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_condition_events e
  JOIN tprm_conditions c
    ON c.workspace_id=e.workspace_id AND c.supplier_id=e.supplier_id
      AND c.cycle_id=e.cycle_id AND c.id=e.condition_id
  WHERE e.id=NEW.condition_event_id AND e.workspace_id=NEW.workspace_id
    AND e.supplier_id=NEW.supplier_id AND e.cycle_id=NEW.cycle_id
    AND e.condition_id=NEW.condition_id AND e.event_type='evidence_submitted'
    AND e.actor_type='client_owner' AND e.actor_user_id=NEW.uploaded_by
    AND c.owner_type='client' AND c.owner_user_id=NEW.uploaded_by
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition evidence is outside the authorized client submission');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_evidence_no_update
BEFORE UPDATE ON tprm_condition_evidence_links
BEGIN
  SELECT RAISE(ABORT,'TPRM condition evidence links are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_evidence_no_delete
BEFORE DELETE ON tprm_condition_evidence_links
BEGIN
  SELECT RAISE(ABORT,'TPRM condition evidence links cannot be deleted');
END;

-- Replace the permissive foundation transition with the governed sequence.
DROP TRIGGER IF EXISTS trg_tprm_condition_status_transition;
CREATE TRIGGER trg_tprm_condition_status_transition
BEFORE UPDATE OF status ON tprm_conditions
WHEN NOT (
  (OLD.status='open' AND NEW.status IN ('in_progress','waived'))
  OR (OLD.status='in_progress' AND NEW.status IN ('evidence_submitted','waived'))
  OR (OLD.status='evidence_submitted' AND NEW.status IN ('in_progress','verified','waived'))
)
BEGIN
  SELECT RAISE(ABORT,'invalid governed TPRM condition status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_status_requires_event
BEFORE UPDATE OF status ON tprm_conditions
WHEN NEW.status<>OLD.status AND (
  NEW.row_version<>OLD.row_version+1
  OR NOT EXISTS (
    SELECT 1 FROM tprm_condition_events e
    WHERE e.workspace_id=OLD.workspace_id AND e.supplier_id=OLD.supplier_id
      AND e.cycle_id=OLD.cycle_id AND e.condition_id=OLD.id
      AND e.from_status=OLD.status AND e.to_status=NEW.status
      AND e.expected_row_version=OLD.row_version
      AND e.resulting_row_version=NEW.row_version
    ORDER BY e.id DESC LIMIT 1
  )
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition status requires its append-only governed event');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_projection_guard
BEFORE UPDATE OF evidence_summary,completion_note,completed_at,completed_by,
  verified_at,verified_by,waiver_rationale,waiver_expires_at,row_version
ON tprm_conditions
WHEN NEW.status=OLD.status
BEGIN
  SELECT RAISE(ABORT,'TPRM condition fulfilment projection changes only with a governed status event');
END;

-- Closing a contracted service period never deletes its records. The manager
-- records the retention policy applied at closure; a later enablement creates
-- a new tprm_modules row and therefore a distinct service period.
CREATE TABLE IF NOT EXISTS tprm_module_closure_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  retention_until TEXT NOT NULL,
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
  retention_policy TEXT NOT NULL,
  closure_reason TEXT NOT NULL,
  closed_by INTEGER NOT NULL REFERENCES users(id),
  closed_at TEXT NOT NULL,
  closure_hash TEXT NOT NULL,
  UNIQUE(module_id),
  UNIQUE(closure_hash),
  UNIQUE(workspace_id,module_id,id),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  CHECK(retention_until GLOB '????-??-??'
    AND strftime('%Y-%m-%d',retention_until||' 00:00:00','+0 days')=retention_until),
  CHECK(length(trim(retention_policy))>=10),
  CHECK(length(trim(closure_reason))>=10),
  CHECK(length(closure_hash)=64 AND closure_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX IF NOT EXISTS idx_tprm_module_closure_retention
  ON tprm_module_closure_records(workspace_id,retention_until,legal_hold);
CREATE TRIGGER IF NOT EXISTS trg_tprm_module_closure_actor
BEFORE INSERT ON tprm_module_closure_records
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_modules m
  JOIN workspaces w ON w.id=m.workspace_id
  JOIN users u ON u.id=NEW.closed_by
  WHERE m.id=NEW.module_id AND m.workspace_id=NEW.workspace_id AND m.status='closed'
    AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    AND u.firm_role IN ('manager','firm_owner')
)
BEGIN
  SELECT RAISE(ABORT,'TPRM closure policy requires the manager who closed the service period');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_module_closure_no_update
BEFORE UPDATE ON tprm_module_closure_records
BEGIN
  SELECT RAISE(ABORT,'TPRM module closure policy is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_module_closure_no_delete
BEFORE DELETE ON tprm_module_closure_records
BEGIN
  SELECT RAISE(ABORT,'TPRM module closure policy cannot be deleted');
END;
