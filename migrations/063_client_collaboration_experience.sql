-- Release is a disclosure decision; assignment is responsibility and may change.
ALTER TABLE client_requests ADD COLUMN released_at DATETIME;
ALTER TABLE client_requests ADD COLUMN released_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE client_requests ADD COLUMN responded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE client_requests ADD COLUMN responded_for INTEGER REFERENCES users(id) ON DELETE SET NULL;
UPDATE client_requests SET released_at=created_at,released_by=created_by WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_client_requests_released ON client_requests(workspace_id,released_at,assignee_id,status);
-- Older programme authors issue requests by assigning a client. Keep that
-- explicit issuance compatible while never withdrawing release on reassignment.
CREATE TRIGGER client_request_release_on_insert AFTER INSERT ON client_requests
WHEN NEW.assignee_id IS NOT NULL AND NEW.released_at IS NULL
BEGIN UPDATE client_requests SET released_at=CURRENT_TIMESTAMP,released_by=NEW.created_by WHERE id=NEW.id; END;
CREATE TRIGGER client_request_release_on_assignment AFTER UPDATE OF assignee_id ON client_requests
WHEN NEW.assignee_id IS NOT NULL AND NEW.released_at IS NULL
BEGIN UPDATE client_requests SET released_at=CURRENT_TIMESTAMP,released_by=NEW.created_by WHERE id=NEW.id; END;

CREATE TABLE notification_receipts (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at DATETIME,
  dismissed_at DATETIME,
  PRIMARY KEY(notification_id,user_id)
);
-- Preserve existing targeted read history. Broadcast history remains shared only
-- as historical state; all future read/dismiss actions are recipient-specific.
INSERT INTO notification_receipts(notification_id,user_id,read_at,dismissed_at)
SELECT id,user_id,read_at,dismissed_at FROM notifications WHERE user_id IS NOT NULL;

CREATE TABLE notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at DATETIME,
  last_error TEXT,
  sent_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_key,recipient_id)
);
CREATE INDEX idx_notification_outbox_ready ON notification_outbox(status,available_at);
