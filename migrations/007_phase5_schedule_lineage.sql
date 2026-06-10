-- 007_phase5_schedule_lineage.sql
-- Adds migrated_from to assessment_schedules so the Phase 5 schedule backfill
-- (migrations/data/010) is idempotent. Additive.
ALTER TABLE assessment_schedules ADD COLUMN migrated_from TEXT;
