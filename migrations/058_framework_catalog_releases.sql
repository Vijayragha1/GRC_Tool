-- One catalogue lock table for every governed framework.
--
-- Two locks already existed and they were not the same shape:
--   dpdpa_gap_catalog_versions  keyed (framework_id, catalog_version, catalog_hash),
--                               carries a manifest, generic.
--   csf_catalog_versions        keyed on catalog_version alone, no framework_id,
--                               no manifest, and hardcoded count CHECKs
--                               (function_count=6, category_count=22,
--                               outcome_count=106) that only describe CSF 2.0.
--
-- Every new catalogue was going to mint a third. This table takes the DPDPA
-- shape, which is the general one, and both existing locks are backfilled into
-- it so supersession can be reasoned about across all frameworks at once.
--
-- The originals are deliberately left in place: dpdpa_gap_assessments and the
-- CSF engagement tables reference their own lock rows, and rewriting those
-- foreign keys would rewrite approved client assessments. This table is the
-- registry of record for what is current; the originals remain the per-module
-- history they always were.

CREATE TABLE IF NOT EXISTS framework_catalog_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_id INTEGER NOT NULL REFERENCES frameworks(id),
  framework_code TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  requirement_count INTEGER NOT NULL CHECK(requirement_count >= 0),
  source_reference TEXT NOT NULL,
  catalog_manifest_json TEXT NOT NULL CHECK(json_valid(catalog_manifest_json)),
  -- Exactly one release per framework_code carries is_current=1. The seeder
  -- maintains it; the supersession job reads it.
  is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_at TEXT,
  UNIQUE(framework_id, catalog_version, catalog_hash),
  CHECK(length(catalog_hash)=64 AND catalog_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(is_current=1 OR superseded_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_framework_catalog_releases_current
  ON framework_catalog_releases(framework_code, is_current);

-- Backfill: DPDPA maps one-to-one.
INSERT OR IGNORE INTO framework_catalog_releases
  (framework_id, framework_code, catalog_version, catalog_hash, requirement_count,
   source_reference, catalog_manifest_json, is_current, locked_at)
SELECT v.framework_id, f.code, v.catalog_version, v.catalog_hash, v.requirement_count,
       v.source_reference, v.catalog_manifest_json, 1, v.locked_at
FROM dpdpa_gap_catalog_versions v
JOIN frameworks f ON f.id = v.framework_id;

-- Backfill: CSF has no framework_id and no manifest, so both are derived. The
-- manifest records the source identity the CSF lock does carry, which is what
-- supersession detection needs.
INSERT OR IGNORE INTO framework_catalog_releases
  (framework_id, framework_code, catalog_version, catalog_hash, requirement_count,
   source_reference, catalog_manifest_json, is_current, locked_at)
SELECT f.id, f.code, c.catalog_version, c.catalog_hash,
       c.outcome_count,
       c.source_identifier,
       json_object(
         'source_identifier', c.source_identifier,
         'source_url', c.source_url,
         'published_date', c.published_date,
         'function_count', c.function_count,
         'category_count', c.category_count,
         'outcome_count', c.outcome_count,
         'methodology_version', c.methodology_version,
         'methodology_hash', c.methodology_hash,
         'backfilled_from', 'csf_catalog_versions'
       ),
       1, c.locked_at
FROM csf_catalog_versions c
JOIN frameworks f ON f.code = 'csf'
WHERE length(c.catalog_hash) = 64;

-- Only the newest backfilled row per framework stays current.
UPDATE framework_catalog_releases
   SET is_current = 0,
       superseded_at = COALESCE(superseded_at, datetime('now'))
 WHERE id NOT IN (
   SELECT id FROM (
     SELECT id, ROW_NUMBER() OVER (PARTITION BY framework_code ORDER BY locked_at DESC, id DESC) AS rn
     FROM framework_catalog_releases
   ) WHERE rn = 1
 );
