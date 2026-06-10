-- 003_phase2_evidence_links.sql
-- Phase 2 schema: one evidence -> requirement join, replacing the trigger-synced
-- evidence_controls / evidence_links pair. Additive; legacy tables/triggers untouched.
-- Backfill: migrations/data/003_phase2_backfill.js (run after this).

CREATE TABLE IF NOT EXISTS evidence_requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  relevance_note TEXT,
  section_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (evidence_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_evreq_ev ON evidence_requirement_links(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evreq_req ON evidence_requirement_links(requirement_id);
