-- 069_audit_samples_any_framework.sql
-- An internal audit sample can name a requirement of any framework the client
-- works to.
--
-- audit_samples.iso_item_id carried a foreign key to iso_items, the ISO 27001
-- catalogue, so a sample taken in an ISO 42001 internal audit could not name
-- an ISO 42001 clause or control. Findings and checklist items already store
-- the same TEXT reference without that key. Requirement refs are unique across
-- every framework in `requirements` (see lib/requirement-options.js), so the
-- column keeps its name and its values; only the key is dropped. SQLite cannot
-- drop a foreign key in place, so the table is rebuilt with the same columns
-- and its index, and every row is copied across.

CREATE TABLE audit_samples_069 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL,
  iso_item_id TEXT,
  description TEXT NOT NULL,
  sample_taken_at DATE,
  population_size INTEGER,
  sample_size INTEGER,
  finding TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

INSERT INTO audit_samples_069 (id, audit_id, iso_item_id, description, sample_taken_at, population_size, sample_size, finding, created_at)
  SELECT id, audit_id, iso_item_id, description, sample_taken_at, population_size, sample_size, finding, created_at FROM audit_samples;

DROP TABLE audit_samples;
ALTER TABLE audit_samples_069 RENAME TO audit_samples;
CREATE INDEX IF NOT EXISTS idx_audsamp_audit ON audit_samples(audit_id);
