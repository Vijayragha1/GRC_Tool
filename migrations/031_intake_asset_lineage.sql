-- 031_intake_asset_lineage.sql
-- Crown-jewel answers captured during client setup are authoritative inputs to
-- the asset inventory. Retain explicit lineage so repeated autosaves update the
-- same asset instead of creating duplicates, while allowing consultants to
-- enrich the asset later without the intake overwriting their work.

ALTER TABLE assets ADD COLUMN source_type TEXT;
ALTER TABLE assets ADD COLUMN source_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_workspace_source
  ON assets(workspace_id, source_type, source_ref)
  WHERE source_type IS NOT NULL AND source_ref IS NOT NULL;
