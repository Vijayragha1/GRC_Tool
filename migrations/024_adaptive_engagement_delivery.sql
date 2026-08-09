-- 024_adaptive_engagement_delivery.sql
-- One adaptive delivery model for plan, timeline, tasks and calendar.

CREATE TABLE IF NOT EXISTS engagement_delivery_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'ISO 27001 delivery plan',
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('draft','active','on_hold','completed','cancelled')),
  target_start_date DATE,
  target_completion_date DATE,
  forecast_completion_date DATE,
  completion_criteria TEXT,
  baseline_version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engagement_delivery_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  phase_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(status IN ('not_started','in_progress','blocked','complete','waived')),
  planned_start_date DATE,
  planned_end_date DATE,
  forecast_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  is_continuous INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_id, phase_key)
);
CREATE INDEX IF NOT EXISTS idx_delivery_phases_plan ON engagement_delivery_phases(plan_id, sort_order);

CREATE TABLE IF NOT EXISTS engagement_delivery_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  phase_id INTEGER NOT NULL REFERENCES engagement_delivery_phases(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(status IN ('not_started','in_progress','blocked','workspace_verified','complete','waived')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('low','normal','high','critical')),
  is_required INTEGER NOT NULL DEFAULT 1,
  completion_mode TEXT NOT NULL DEFAULT 'deliverable'
    CHECK(completion_mode IN ('manual','deliverable','workspace_record','gate')),
  owner_id INTEGER REFERENCES users(id),
  planned_start_date DATE,
  planned_end_date DATE,
  forecast_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  completion_note TEXT,
  source_rule TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_id, milestone_key)
);
CREATE INDEX IF NOT EXISTS idx_delivery_milestones_phase ON engagement_delivery_milestones(phase_id, status, planned_end_date);
CREATE INDEX IF NOT EXISTS idx_delivery_milestones_plan ON engagement_delivery_milestones(plan_id, status);

CREATE TABLE IF NOT EXISTS engagement_delivery_deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  milestone_id INTEGER NOT NULL REFERENCES engagement_delivery_milestones(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','workspace_verified','submitted','changes_requested','accepted','rejected','superseded')),
  is_required INTEGER NOT NULL DEFAULT 1,
  owner_id INTEGER REFERENCES users(id),
  approver_id INTEGER REFERENCES users(id),
  due_date DATE,
  linked_record_type TEXT,
  linked_record_id TEXT,
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  accepted_by INTEGER REFERENCES users(id),
  accepted_at TEXT,
  decision_note TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_milestone ON engagement_delivery_deliverables(milestone_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_workspace ON engagement_delivery_deliverables(workspace_id, due_date, status);

CREATE TABLE IF NOT EXISTS engagement_delivery_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  predecessor_milestone_id INTEGER NOT NULL REFERENCES engagement_delivery_milestones(id) ON DELETE CASCADE,
  successor_milestone_id INTEGER NOT NULL REFERENCES engagement_delivery_milestones(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'finish_to_start'
    CHECK(dependency_type IN ('finish_to_start','start_to_start','finish_to_finish')),
  lag_days INTEGER NOT NULL DEFAULT 0,
  is_mandatory INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(predecessor_milestone_id <> successor_milestone_id),
  UNIQUE(plan_id, predecessor_milestone_id, successor_milestone_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_dependencies_successor ON engagement_delivery_dependencies(successor_milestone_id);

CREATE TABLE IF NOT EXISTS engagement_delivery_gate_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id INTEGER NOT NULL REFERENCES engagement_delivery_phases(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('passed','waived','reopened')),
  criteria_snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  note TEXT,
  waiver_expires_at DATE,
  decided_by INTEGER NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_gate_decisions_phase ON engagement_delivery_gate_decisions(phase_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS engagement_delivery_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  label TEXT NOT NULL,
  reason TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  approved_by INTEGER NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_delivery_baselines_plan ON engagement_delivery_baselines(plan_id, version_number DESC);

CREATE TABLE IF NOT EXISTS engagement_delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  details TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_events_plan ON engagement_delivery_events(plan_id, created_at DESC, id DESC);

ALTER TABLE tasks ADD COLUMN engagement_milestone_id INTEGER REFERENCES engagement_delivery_milestones(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN engagement_deliverable_id INTEGER REFERENCES engagement_delivery_deliverables(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_delivery_milestone ON tasks(workspace_id, engagement_milestone_id, status);
