-- 025_engagement_delivery_production.sql
-- Production hardening for adaptive engagement delivery: evidence-backed
-- decisions, client participation, revision lineage and schedule controls.

ALTER TABLE engagement_delivery_deliverables ADD COLUMN client_visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE engagement_delivery_deliverables ADD COLUMN requires_evidence INTEGER NOT NULL DEFAULT 1;
ALTER TABLE engagement_delivery_deliverables ADD COLUMN revision_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE engagement_delivery_deliverables ADD COLUMN supersedes_deliverable_id INTEGER REFERENCES engagement_delivery_deliverables(id) ON DELETE SET NULL;
ALTER TABLE engagement_delivery_deliverables ADD COLUMN evidence_snapshot_json TEXT;

ALTER TABLE engagement_delivery_gate_decisions ADD COLUMN evidence_snapshot_json TEXT;

CREATE TABLE IF NOT EXISTS engagement_delivery_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deliverable_id INTEGER NOT NULL REFERENCES engagement_delivery_deliverables(id) ON DELETE CASCADE,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(deliverable_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_evidence_deliverable ON engagement_delivery_evidence(deliverable_id, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_evidence_workspace ON engagement_delivery_evidence(workspace_id, evidence_id);

CREATE TABLE IF NOT EXISTS engagement_delivery_schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  changed_milestones INTEGER NOT NULL DEFAULT 0,
  forecast_before DATE,
  forecast_after DATE,
  details_json TEXT,
  run_by INTEGER NOT NULL REFERENCES users(id),
  run_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_schedule_runs_plan ON engagement_delivery_schedule_runs(plan_id, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_approver ON engagement_delivery_deliverables(workspace_id, approver_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_owner ON engagement_delivery_deliverables(workspace_id, owner_id, status);
