-- 009_phase7_exceptions.sql
-- Phase 7 schema: control exceptions register. Additive. A control exception is
-- structurally bound to a risk_acceptance (NOT NULL FK) per the brief. This is a
-- forward-only register (no legacy backfill source: risk_acceptances has 0 rows
-- in dev, and excluded controls are out-of-scope, not exceptions). Wiring expiry
-- into the task/notification machinery is app code and is part of the GATED
-- app-integration work, not this additive step.

CREATE TABLE IF NOT EXISTS control_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  compensating_controls TEXT,
  risk_acceptance_id INTEGER NOT NULL REFERENCES risk_acceptances(id),  -- structurally mandatory
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  expiry TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','under_review','expired','closed')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exceptions_ws ON control_exceptions(workspace_id, expiry);
