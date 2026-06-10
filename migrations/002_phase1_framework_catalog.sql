-- 002_phase1_framework_catalog.sql
-- Phase 1 schema: frameworks + requirements + requirement_mappings, plus the
-- read-only compatibility views. Additive only; legacy catalog tables untouched.
-- Backfill is performed by migrations/data/002_phase1_backfill.js (run after this).
--
-- Dialect discipline: explicit FKs, CHECK enums, ISO-8601 text datetimes.

CREATE TABLE IF NOT EXISTS frameworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','transitional','retired')),
  is_canonical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (code, version)
);

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_id INTEGER NOT NULL REFERENCES frameworks(id),
  ref TEXT NOT NULL,
  parent_ref TEXT,
  req_type TEXT NOT NULL
    CHECK (req_type IN ('clause','control','function','category','subcategory')),
  title TEXT NOT NULL,
  summary TEXT,
  guidance TEXT,                 -- JSON
  sort_order INTEGER,
  UNIQUE (framework_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_requirements_fw ON requirements(framework_id, sort_order);

CREATE TABLE IF NOT EXISTS requirement_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  mapped_requirement_id    INTEGER NOT NULL REFERENCES requirements(id),
  coverage TEXT NOT NULL CHECK (coverage IN ('full','partial','supporting')),
  residual_gap_note TEXT,
  mapped_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (canonical_requirement_id, mapped_requirement_id)
);

-- Compatibility views: reproduce the legacy iso_items / iso42001_items shapes
-- from requirements. Read-only; the application is NOT switched to these yet
-- (that happens in Phase 3). json_extract returns nested arrays as JSON text,
-- matching the legacy columns' original JSON-text storage.
CREATE VIEW IF NOT EXISTS v_iso_items AS
SELECT r.ref AS id,
       r.req_type AS type,
       json_extract(r.guidance,'$.category') AS category,
       r.title AS title,
       r.summary AS summary,
       json_extract(r.guidance,'$.questions') AS questions,
       json_extract(r.guidance,'$.evidence_needed') AS evidence_needed,
       json_extract(r.guidance,'$.documentation_needed') AS documentation_needed,
       r.sort_order AS sort_order,
       json_extract(r.guidance,'$.purpose') AS purpose,
       json_extract(r.guidance,'$.what_good_looks_like') AS what_good_looks_like,
       json_extract(r.guidance,'$.common_pitfalls') AS common_pitfalls,
       json_extract(r.guidance,'$.evidence_to_look_for') AS evidence_to_look_for,
       json_extract(r.guidance,'$.scoping_notes') AS scoping_notes,
       json_extract(r.guidance,'$.maturity_ladder') AS maturity_ladder,
       json_extract(r.guidance,'$.related_items') AS related_items,
       json_extract(r.guidance,'$.minimum_certifiable') AS minimum_certifiable
FROM requirements r
JOIN frameworks f ON f.id = r.framework_id
WHERE f.code = 'iso27001' AND f.version = '2022';

CREATE VIEW IF NOT EXISTS v_iso42001_items AS
SELECT r.ref AS id,
       r.req_type AS type,
       json_extract(r.guidance,'$.category') AS category,
       r.title AS title,
       r.summary AS summary,
       json_extract(r.guidance,'$.questions') AS questions,
       json_extract(r.guidance,'$.evidence_needed') AS evidence_needed,
       json_extract(r.guidance,'$.documentation_needed') AS documentation_needed,
       r.sort_order AS sort_order,
       json_extract(r.guidance,'$.purpose') AS purpose,
       json_extract(r.guidance,'$.what_good_looks_like') AS what_good_looks_like,
       json_extract(r.guidance,'$.common_pitfalls') AS common_pitfalls,
       json_extract(r.guidance,'$.evidence_to_look_for') AS evidence_to_look_for,
       json_extract(r.guidance,'$.scoping_notes') AS scoping_notes,
       json_extract(r.guidance,'$.maturity_ladder') AS maturity_ladder,
       json_extract(r.guidance,'$.related_items') AS related_items
FROM requirements r
JOIN frameworks f ON f.id = r.framework_id
WHERE f.code = 'iso42001' AND f.version = '2023';
