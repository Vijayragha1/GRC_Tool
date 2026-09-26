-- Presentation rollout only: no source work, permissions or decisions change.
CREATE TABLE IF NOT EXISTS experience_rollouts (
  firm_id INTEGER PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  wave INTEGER NOT NULL DEFAULT 1 CHECK(wave BETWEEN 1 AND 6),
  cohort TEXT NOT NULL DEFAULT 'pilot',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS experience_workspace_overrides (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
