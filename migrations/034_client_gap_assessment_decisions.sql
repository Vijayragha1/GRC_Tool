-- 034_client_gap_assessment_decisions.sql
-- Govern the management estimates and assurance conditions surfaced in the
-- client-facing ISO 27001 gap-assessment roadmap. These remain separate from
-- the assessor's condition / criteria / risk conclusion.

ALTER TABLE consulting_findings ADD COLUMN effort_estimate TEXT;
ALTER TABLE consulting_findings ADD COLUMN cost_estimate TEXT;
ALTER TABLE consulting_findings ADD COLUMN retest_criteria TEXT;
ALTER TABLE consulting_findings ADD COLUMN closure_evidence_requirements TEXT;
