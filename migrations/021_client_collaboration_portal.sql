-- 021_client_collaboration_portal.sql
-- Production client-collaboration request lifecycle. Requests are the durable
-- hand-off between consultants and client-side users; evidence is linked rather
-- than copied, and the event table is append-only so the full conversation and
-- state history remains auditable independently of the mutable request row.

CREATE TABLE IF NOT EXISTS client_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN ('evidence','policy','control','action')),
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','submitted','accepted','changes_requested','cancelled')),
  assignee_id INTEGER,
  control_id TEXT,
  document_id INTEGER,
  due_date DATE,
  response_note TEXT,
  created_by INTEGER NOT NULL,
  reviewed_by INTEGER,
  submitted_at DATETIME,
  closed_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (control_id) REFERENCES iso_items(id) ON DELETE SET NULL,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_client_requests_workspace_status
  ON client_requests(workspace_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_client_requests_assignee
  ON client_requests(workspace_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_client_requests_control
  ON client_requests(workspace_id, control_id);
CREATE INDEX IF NOT EXISTS idx_client_requests_document
  ON client_requests(workspace_id, document_id);

CREATE TABLE IF NOT EXISTS client_request_evidence (
  request_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  linked_by INTEGER NOT NULL,
  linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, evidence_id),
  FOREIGN KEY (request_id) REFERENCES client_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_client_request_evidence_evidence
  ON client_request_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS client_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','assigned','commented','evidence_linked','status_changed','response_updated','target_updated')),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  metadata TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES client_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_client_request_events_request
  ON client_request_events(request_id, created_at, id);
