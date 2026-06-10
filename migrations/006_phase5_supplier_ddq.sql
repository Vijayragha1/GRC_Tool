-- 006_phase5_supplier_ddq.sql
-- Phase 5 schema: supplier/DDQ convergence onto the generic engine.
-- Additive. Backfill: migrations/data/008_phase5_structural.js (structural, dev),
-- migrations/data/009_phase5_ddq_history.js + 010_phase5_schedules.js (DATA; fixture-proven, deferred).

-- question_sets gains clone lineage (questionnaire_templates.cloned_from); questions gain tags
-- (questionnaire_question_bank.tags). Added via ALTER (runner applies once).
ALTER TABLE question_sets ADD COLUMN cloned_from INTEGER REFERENCES question_sets(id);
ALTER TABLE questions ADD COLUMN tags TEXT;

-- Generalized external-respondent token (issue / answer / expire / revoke), modeled on
-- supplier_questionnaires.external_* + external_approvers. Stores a token HASH, never the raw token.
CREATE TABLE IF NOT EXISTS external_assessment_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id INTEGER REFERENCES assessments(id) ON DELETE CASCADE,
  entity_id INTEGER REFERENCES entities(id),          -- the supplier / external entity
  email TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  issued_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  revoked_at TEXT,
  created_by INTEGER REFERENCES users(id),
  migrated_from TEXT,
  UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS idx_extok_assessment ON external_assessment_tokens(assessment_id);
CREATE INDEX IF NOT EXISTS idx_extok_ws ON external_assessment_tokens(workspace_id, expires_at);
