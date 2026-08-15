-- 035_gap_fieldwork_governance.sql
-- Structured, auditable fieldwork records for the ISO 27001 client journey.
-- Replaces title-based interview inference and gives blockers, declared
-- defaults, weekly progress, and phase decisions durable governed homes.

CREATE TABLE IF NOT EXISTS gap_fieldwork_interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  source_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  objective TEXT,
  participant_role TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at TEXT NOT NULL,
  duration_minutes INTEGER CHECK(duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','completed','rescheduled','cancelled')),
  completion_summary TEXT,
  completed_at TEXT,
  client_visible INTEGER NOT NULL DEFAULT 1 CHECK(client_visible IN (0,1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,source_task_id)
);
CREATE INDEX IF NOT EXISTS idx_gap_interviews_workspace
  ON gap_fieldwork_interviews(workspace_id,assessment_pass_id,status,scheduled_at);

CREATE TABLE IF NOT EXISTS gap_fieldwork_blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'high' CHECK(priority IN ('normal','high','critical')),
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','accepted_risk')),
  resolution_note TEXT,
  resolved_at TEXT,
  client_visible INTEGER NOT NULL DEFAULT 1 CHECK(client_visible IN (0,1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gap_blockers_workspace
  ON gap_fieldwork_blockers(workspace_id,assessment_pass_id,status,due_date);

CREATE TABLE IF NOT EXISTS gap_declared_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  declaration TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','withdrawn')),
  client_visible INTEGER NOT NULL DEFAULT 1 CHECK(client_visible IN (0,1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,assessment_pass_id,requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_gap_defaults_workspace
  ON gap_declared_defaults(workspace_id,assessment_pass_id,status,requirement_id);

CREATE TABLE IF NOT EXISTS gap_fieldwork_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  week_ending DATE NOT NULL,
  requirements_covered INTEGER NOT NULL,
  requirements_total INTEGER NOT NULL,
  interviews_completed INTEGER NOT NULL,
  interviews_planned INTEGER NOT NULL,
  requests_received INTEGER NOT NULL,
  requests_total INTEGER NOT NULL,
  active_blockers INTEGER NOT NULL,
  declared_defaults INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,assessment_pass_id,week_ending)
);
CREATE INDEX IF NOT EXISTS idx_gap_snapshots_workspace
  ON gap_fieldwork_snapshots(workspace_id,assessment_pass_id,week_ending DESC);

CREATE TABLE IF NOT EXISTS gap_assessment_phase_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER NOT NULL REFERENCES assessment_passes(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK(phase IN ('mobilisation','fieldwork','validation','post_report')),
  decision TEXT NOT NULL CHECK(decision IN ('complete','not_required','reopened')),
  rationale TEXT NOT NULL,
  decided_by INTEGER NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id,assessment_pass_id,phase)
);

CREATE TABLE IF NOT EXISTS gap_assessment_phase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_decision_id INTEGER NOT NULL REFERENCES gap_assessment_phase_decisions(id) ON DELETE CASCADE,
  from_decision TEXT,
  to_decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_gap_snapshot_no_update BEFORE UPDATE ON gap_fieldwork_snapshots
BEGIN SELECT RAISE(ABORT,'fieldwork snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_gap_snapshot_no_delete BEFORE DELETE ON gap_fieldwork_snapshots
BEGIN SELECT RAISE(ABORT,'fieldwork snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_gap_phase_events_no_update BEFORE UPDATE ON gap_assessment_phase_events
BEGIN SELECT RAISE(ABORT,'phase decision events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_gap_phase_events_no_delete BEFORE DELETE ON gap_assessment_phase_events
BEGIN SELECT RAISE(ABORT,'phase decision events are immutable'); END;

-- Preserve any genuine interview tasks already recorded before this migration.
INSERT OR IGNORE INTO gap_fieldwork_interviews
  (workspace_id,assessment_pass_id,source_task_id,title,objective,participant_role,
   owner_id,scheduled_at,status,completed_at,created_by,updated_by,created_at,updated_at)
SELECT t.workspace_id,
  (SELECT p.id FROM assessment_passes p WHERE p.workspace_id=t.workspace_id
   ORDER BY (p.status='in_progress') DESC,p.pass_number DESC,p.id DESC LIMIT 1),
  t.id,t.title,t.description,'Client stakeholder',t.assignee_id,
  COALESCE(t.due_date,substr(t.created_at,1,10)),
  CASE t.status WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'scheduled' END,
  CASE WHEN t.status='done' THEN t.created_at ELSE NULL END,
  t.created_by,t.created_by,t.created_at,t.created_at
FROM tasks t
WHERE LOWER(t.title) LIKE '%interview%'
   OR LOWER(COALESCE(t.description,'')) LIKE '%interview%';
