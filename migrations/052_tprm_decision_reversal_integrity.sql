-- 052_tprm_decision_reversal_integrity.sql
-- A negative reassessment decision must end the previously authorised review
-- cadence without rewriting its immutable schedule snapshot. This append-only
-- closure record is the governed successor fact for that schedule.

CREATE TABLE IF NOT EXISTS tprm_review_schedule_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  schedule_id INTEGER NOT NULL,
  superseded_by_decision_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  closed_by INTEGER NOT NULL REFERENCES users(id),
  closed_at TEXT NOT NULL,
  closure_hash TEXT NOT NULL,
  UNIQUE(schedule_id),
  UNIQUE(superseded_by_decision_id),
  UNIQUE(closure_hash),
  FOREIGN KEY(workspace_id,supplier_id,schedule_id)
    REFERENCES tprm_review_schedules(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,superseded_by_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  CHECK(length(trim(reason))>=10),
  CHECK(length(closure_hash)=64 AND closure_hash NOT GLOB '*[^0-9a-f]*')
);

CREATE INDEX IF NOT EXISTS idx_tprm_review_schedule_closures_supplier
  ON tprm_review_schedule_closures(workspace_id,supplier_id,closed_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_negative_decision
BEFORE INSERT ON tprm_review_schedule_closures
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_client_decisions d
  WHERE d.id=NEW.superseded_by_decision_id
    AND d.workspace_id=NEW.workspace_id
    AND d.supplier_id=NEW.supplier_id
    AND d.decision='do_not_onboard'
)
BEGIN
  SELECT RAISE(ABORT,'review schedule closure requires a final negative client decision');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_client_actor
BEFORE INSERT ON tprm_review_schedule_closures
WHEN NOT EXISTS (
  SELECT 1 FROM users u
  JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
  WHERE u.id=NEW.closed_by AND u.user_type='client' AND u.active=1
    AND wm.role IN ('client_owner','client_admin')
)
BEGIN
  SELECT RAISE(ABORT,'review schedule closure requires an authorised active client decision-maker');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_no_update
BEFORE UPDATE ON tprm_review_schedule_closures
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedule closures are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_no_delete
BEFORE DELETE ON tprm_review_schedule_closures
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedule closures cannot be deleted');
END;
