-- Report payloads remain immutable. Review feedback creates a separate,
-- attributable obligation, resolved by a new explicitly linked report version.
CREATE TABLE consulting_report_revision_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  report_id INTEGER NOT NULL UNIQUE REFERENCES consulting_report_snapshots(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  request_note TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  replacement_report_id INTEGER UNIQUE REFERENCES consulting_report_snapshots(id),
  replaced_at TEXT,
  CHECK((replacement_report_id IS NULL AND replaced_at IS NULL) OR (replacement_report_id IS NOT NULL AND replaced_at IS NOT NULL))
);
CREATE INDEX idx_report_revision_requests_open ON consulting_report_revision_requests(workspace_id,replacement_report_id,report_id);
CREATE TRIGGER trg_report_revision_request_scope BEFORE INSERT ON consulting_report_revision_requests
WHEN NEW.replacement_report_id IS NOT NULL OR NEW.replaced_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM consulting_report_snapshots r JOIN workspaces w ON w.id=r.workspace_id JOIN users u ON u.id=NEW.requested_by
 WHERE r.id=NEW.report_id AND r.workspace_id=NEW.workspace_id AND r.status='superseded' AND r.generated_by<>NEW.requested_by
 AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id)
BEGIN SELECT RAISE(ABORT,'Report revision request requires an independent reviewer in the report workspace'); END;
CREATE TRIGGER trg_report_revision_request_no_change BEFORE UPDATE OF workspace_id,report_id,requested_by,request_note,requested_at ON consulting_report_revision_requests
BEGIN SELECT RAISE(ABORT,'Report revision requests are immutable'); END;
CREATE TRIGGER trg_report_revision_request_replacement BEFORE UPDATE OF replacement_report_id,replaced_at ON consulting_report_revision_requests
WHEN OLD.replacement_report_id IS NOT NULL OR NEW.replacement_report_id IS NULL OR NOT EXISTS (
 SELECT 1 FROM consulting_report_snapshots source JOIN consulting_report_snapshots replacement
  ON replacement.workspace_id=source.workspace_id AND replacement.engagement_id=source.engagement_id AND replacement.report_type=source.report_type
 WHERE source.id=OLD.report_id AND source.workspace_id=OLD.workspace_id AND source.status='superseded'
  AND replacement.id=NEW.replacement_report_id AND replacement.id<>source.id AND replacement.version_number>source.version_number AND replacement.status='generated')
BEGIN SELECT RAISE(ABORT,'Report replacement must be a new version in the same workspace, engagement and report type'); END;
CREATE TRIGGER trg_report_revision_request_no_delete BEFORE DELETE ON consulting_report_revision_requests
BEGIN SELECT RAISE(ABORT,'Report revision requests are immutable'); END;
