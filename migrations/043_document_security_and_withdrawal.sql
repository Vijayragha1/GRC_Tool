-- SEC-002 / AUTHZ-005 / GOV-001 / AUDIT-001
-- Defense-in-depth guards for controlled-document boundaries and governed
-- withdrawal metadata. Application code remains the primary authorization and
-- validation layer; these triggers prevent direct/forgotten write paths from
-- recreating the confirmed failures.

ALTER TABLE generated_docs ADD COLUMN withdrawn_at TEXT;
ALTER TABLE generated_docs ADD COLUMN withdrawn_by INTEGER REFERENCES users(id);
ALTER TABLE generated_docs ADD COLUMN withdrawal_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_generated_docs_workspace_status
  ON generated_docs(workspace_id, status, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_doc_approver_workspace_guard
BEFORE INSERT ON doc_approvers
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM generated_docs d
  JOIN doc_versions dv
    ON dv.id = NEW.version_id
   AND dv.document_id = NEW.document_id
   AND dv.workspace_id = NEW.workspace_id
  JOIN workspaces w
    ON w.id = NEW.workspace_id
   AND d.workspace_id = w.id
   AND d.id = NEW.document_id
  JOIN users u
    ON u.id = NEW.user_id
   AND u.active = 1
  LEFT JOIN workspace_members wm
    ON wm.workspace_id = NEW.workspace_id
   AND wm.user_id = u.id
  WHERE (u.user_type = 'firm' AND u.firm_id = w.firm_id)
     OR (u.user_type = 'client' AND wm.user_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'internal document approver is outside the workspace boundary');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_internal_rejection_reason_insert
BEFORE INSERT ON doc_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_internal_rejection_reason_update
BEFORE UPDATE OF decision, decision_reason ON doc_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_external_rejection_reason_insert
BEFORE INSERT ON external_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_external_rejection_reason_update
BEFORE UPDATE OF decision, decision_reason ON external_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_generated_doc_withdrawal_metadata
BEFORE UPDATE OF status ON generated_docs
FOR EACH ROW
WHEN NEW.status = 'withdrawn'
 AND (NEW.withdrawn_at IS NULL
   OR NEW.withdrawn_by IS NULL
   OR trim(COALESCE(NEW.withdrawal_reason, '')) = '')
BEGIN
  SELECT RAISE(ABORT, 'document withdrawal requires actor, time, and reason');
END;
