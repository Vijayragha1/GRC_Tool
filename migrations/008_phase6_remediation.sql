-- 008_phase6_remediation.sql
-- Phase 6 schema: unified remediation pipeline. Additive.
-- Backfill: migrations/data/011_phase6_remediation.js (dev real data + fixture-proven CSF/risk/dedup paths).

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('assessment','audit','incident','risk','manual','migration')),
  source_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  severity_scheme TEXT NOT NULL DEFAULT 'hml',     -- 'hml' | 'nc' | custom (per-source / per-row)
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('draft','open','in_remediation','verified','closed','accepted_risk')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_ws ON findings(workspace_id, status);

CREATE TABLE IF NOT EXISTS finding_controls (
  finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  PRIMARY KEY (finding_id, instance_id)
);

CREATE TABLE IF NOT EXISTS firm_recommendation_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL,
  domain TEXT, default_effort TEXT, tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_id INTEGER REFERENCES findings(id) ON DELETE CASCADE,
  library_id INTEGER REFERENCES firm_recommendation_library(id),
  text TEXT NOT NULL,
  priority TEXT, effort_estimate TEXT,
  client_decision TEXT CHECK (client_decision IN ('accepted','rejected','deferred')),
  decided_at TEXT, decision_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_recs_finding ON recommendations(finding_id);

CREATE TABLE IF NOT EXISTS roadmap_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort_order INTEGER, target_date TEXT
);

CREATE TABLE IF NOT EXISTS remediation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_id INTEGER REFERENCES findings(id),
  recommendation_id INTEGER REFERENCES recommendations(id),
  title TEXT NOT NULL, description TEXT,
  owner_kind TEXT CHECK (owner_kind IN ('consultant','client')),
  owner_user_id INTEGER REFERENCES users(id), owner_name TEXT,
  roadmap_phase_id INTEGER REFERENCES roadmap_phases(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','done_unverified','verified','closed','cancelled')),
  verification_evidence_id INTEGER REFERENCES evidence(id),
  verified_by INTEGER REFERENCES users(id), verified_at TEXT,
  closed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_remact_ws ON remediation_actions(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_remact_finding ON remediation_actions(finding_id);
