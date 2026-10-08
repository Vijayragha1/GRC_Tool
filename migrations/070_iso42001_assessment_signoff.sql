-- Retain independently reviewed AIMS assessment records without upgrading
-- historical completion toggles into review decisions.
CREATE TABLE iso42001_assessment_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  pass_id INTEGER NOT NULL UNIQUE REFERENCES iso42001_assessment_passes(id),
  prepared_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  CHECK(prepared_by<>reviewed_by)
);
CREATE INDEX idx_iso42001_reviewed_workspace ON iso42001_assessment_snapshots(workspace_id,pass_id);
CREATE TRIGGER iso42001_snapshot_scope BEFORE INSERT ON iso42001_assessment_snapshots
WHEN NOT EXISTS (SELECT 1 FROM iso42001_assessment_passes p JOIN workspaces w ON w.id=p.workspace_id
 JOIN users u ON u.id=NEW.reviewed_by AND u.firm_id=w.firm_id AND u.user_type='firm' AND u.active=1
 WHERE p.id=NEW.pass_id AND p.workspace_id=NEW.workspace_id AND p.started_by=NEW.prepared_by AND p.status='open')
BEGIN SELECT RAISE(ABORT,'AIMS snapshot requires an open pass and an eligible workspace reviewer'); END;
CREATE TRIGGER iso42001_snapshot_no_update BEFORE UPDATE ON iso42001_assessment_snapshots
BEGIN SELECT RAISE(ABORT,'AIMS assessment snapshots are immutable'); END;
CREATE TRIGGER iso42001_snapshot_no_delete BEFORE DELETE ON iso42001_assessment_snapshots
BEGIN SELECT RAISE(ABORT,'AIMS assessment snapshots are immutable'); END;
CREATE TRIGGER iso42001_completed_pass_no_update BEFORE UPDATE ON iso42001_assessment_passes WHEN OLD.status='completed'
BEGIN SELECT RAISE(ABORT,'Completed AIMS passes are immutable; start a new pass'); END;
CREATE TRIGGER iso42001_completed_pass_no_delete BEFORE DELETE ON iso42001_assessment_passes WHEN OLD.status='completed'
BEGIN SELECT RAISE(ABORT,'Completed AIMS passes are immutable; start a new pass'); END;
CREATE TRIGGER iso42001_history_closed_insert BEFORE INSERT ON iso42001_control_state_history
WHEN NEW.pass_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM iso42001_assessment_passes p WHERE p.id=NEW.pass_id AND p.workspace_id=NEW.workspace_id AND p.status='open')
BEGIN SELECT RAISE(ABORT,'AIMS history requires an open pass in the same workspace'); END;
CREATE TRIGGER iso42001_history_no_update BEFORE UPDATE ON iso42001_control_state_history
WHEN OLD.pass_id IS NOT NULL AND EXISTS (SELECT 1 FROM iso42001_assessment_passes p WHERE p.id=OLD.pass_id AND p.status='completed')
 OR NEW.pass_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM iso42001_assessment_passes p WHERE p.id=NEW.pass_id AND p.workspace_id=NEW.workspace_id AND p.status='open')
BEGIN SELECT RAISE(ABORT,'Completed AIMS assessment history is immutable'); END;
CREATE TRIGGER iso42001_history_no_delete BEFORE DELETE ON iso42001_control_state_history
WHEN EXISTS (SELECT 1 FROM iso42001_assessment_passes p WHERE p.id=OLD.pass_id AND p.status='completed')
BEGIN SELECT RAISE(ABORT,'Completed AIMS assessment history is immutable'); END;
