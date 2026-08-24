-- 044_iso_engagement_outcome.sql
-- Make the contracted ISO 27001 service endpoint explicit. Existing
-- workspaces retain the historical full-certification behaviour; new clients
-- must choose an outcome at the application boundary.

ALTER TABLE workspaces ADD COLUMN engagement_outcome TEXT NOT NULL DEFAULT 'certification_support'
  CHECK(engagement_outcome IN ('gap_assessment_only','certification_support'));

CREATE INDEX IF NOT EXISTS idx_workspaces_engagement_outcome
  ON workspaces(firm_id, engagement_outcome);
