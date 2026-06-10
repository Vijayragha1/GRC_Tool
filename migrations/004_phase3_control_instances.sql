-- 004_phase3_control_instances.sql
-- Phase 3 schema: one control-instance table replacing control_states /
-- entity_control_states / iso42001_control_states; one source-attributed history
-- table; proposed-change arbitration; one document->requirement join.
-- Additive; legacy tables untouched. Backfill: migrations/data/004_phase3_backfill.js.
-- Compatibility views (v_control_states / v_iso42001_control_states) are deferred
-- to the read-cutover step (they require status DE-normalization and are part of
-- the gated app-integration half).

CREATE TABLE IF NOT EXISTS control_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  entity_id INTEGER REFERENCES entities(id),          -- NULL = whole-org instance
  applicability TEXT NOT NULL DEFAULT 'undecided'
    CHECK (applicability IN ('undecided','applicable','excluded')),
  inclusion_justification TEXT,
  exclusion_justification TEXT,
  status TEXT NOT NULL DEFAULT 'not_assessed',
  maturity INTEGER,
  scope_pct INTEGER,
  notes TEXT,
  internal_notes TEXT,
  local_override_text TEXT,
  owner_id INTEGER REFERENCES users(id),
  due_date TEXT,
  next_review TEXT,
  review_status TEXT DEFAULT 'none',
  last_verified_at TEXT,
  end_dated_at TEXT,
  last_updated TEXT DEFAULT (datetime('now')),
  migrated_from TEXT,
  UNIQUE (workspace_id, requirement_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_ci_ws ON control_instances(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ci_req ON control_instances(requirement_id);
-- SQLite treats NULLs as distinct in UNIQUE, so the table constraint does not
-- dedupe whole-org rows. This partial index enforces one whole-org instance per
-- (workspace, requirement) and makes the INSERT OR IGNORE backfill idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_wholeorg
  ON control_instances(workspace_id, requirement_id) WHERE entity_id IS NULL;

CREATE TABLE IF NOT EXISTS control_instance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  old_status TEXT, new_status TEXT,
  old_maturity INTEGER, new_maturity INTEGER,
  old_applicability TEXT, new_applicability TEXT,
  source TEXT NOT NULL CHECK (source IN
    ('assessment','audit','remediation','evidence','manual','migration','ai_suggestion')),
  source_ref TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT DEFAULT (datetime('now')),
  reason TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_cih_inst ON control_instance_history(instance_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS proposed_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  proposed_status TEXT,
  proposed_maturity INTEGER,
  source TEXT NOT NULL CHECK (source IN
    ('assessment','audit','remediation','evidence','external_respondent','ai_suggestion')),
  source_ref TEXT,
  rationale TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id),
  decision TEXT CHECK (decision IN ('accepted','rejected','superseded')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pc_inst ON proposed_changes(instance_id);
CREATE INDEX IF NOT EXISTS idx_pc_ws_open ON proposed_changes(workspace_id, decision);

-- One document -> requirement join (replaces document_controls / iso42001_document_controls)
CREATE TABLE IF NOT EXISTS document_requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES generated_docs(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  section_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (document_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_docreq_doc ON document_requirement_links(document_id);
CREATE INDEX IF NOT EXISTS idx_docreq_req ON document_requirement_links(requirement_id);
