-- 057_vciso_service.sql
-- Governed vCISO service activation linked to the consulting delivery OS.

CREATE TABLE IF NOT EXISTS vciso_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','on_hold','closed')),
  activation_reason TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(engagement_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vciso_one_current_service
  ON vciso_services(workspace_id) WHERE status IN ('active','on_hold');
CREATE INDEX IF NOT EXISTS idx_vciso_services_status
  ON vciso_services(status,workspace_id);

CREATE TRIGGER IF NOT EXISTS trg_vciso_engagement_workspace_insert
BEFORE INSERT ON vciso_services
WHEN NOT EXISTS (
  SELECT 1 FROM consulting_engagements e
  WHERE e.id=NEW.engagement_id AND e.workspace_id=NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT,'vCISO engagement must belong to the same workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_vciso_identity_immutable
BEFORE UPDATE OF workspace_id,engagement_id ON vciso_services
BEGIN
  SELECT RAISE(ABORT,'vCISO service identity is immutable');
END;
