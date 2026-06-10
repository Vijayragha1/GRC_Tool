-- 001_phase0_scaffolding.sql
-- Phase 0: shared migration infrastructure. Additive only; nothing existing
-- is altered or dropped. Safe to re-run (CREATE ... IF NOT EXISTS).
--
-- Dialect discipline (rule 9): ISO-8601 text datetimes via datetime('now'),
-- explicit FK clauses. Partial unique indexes below are supported by both
-- SQLite and PostgreSQL.

-- Quarantine: malformed / unmappable legacy rows land here with their raw
-- payload during later phases. Zero silent data loss (rule 5).
CREATE TABLE IF NOT EXISTS migration_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT,
  reason TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution_note TEXT
);

-- Feature flags: per-workspace dual-read switches that gate every read cutover
-- in this program. workspace_id NULL = global default for the key; a row with
-- a workspace_id overrides the default for that workspace. The two partial
-- unique indexes enforce "at most one global row per key" and "at most one row
-- per (key, workspace)".
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_global
  ON feature_flags(key) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_ws
  ON feature_flags(key, workspace_id) WHERE workspace_id IS NOT NULL;
