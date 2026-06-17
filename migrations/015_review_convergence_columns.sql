-- 015_review_convergence_columns.sql
-- Review-convergence mini-step (prerequisite of the control-state demolition).
--
-- Adds the review-workflow columns to the converged control_instances so the
-- review reads + writes can converge off the legacy control_states /
-- iso42001_control_states (their review_* columns are the last review dependency
-- blocking those tables' demolition). review_status already exists on
-- control_instances (migration 004); this adds the remaining five.
--
-- Plain ADD COLUMN: control_instances never had these, so this is clean on both a
-- fresh boot (after 004 creates the table) and the live DB (pending application).
-- The companion fresh-boot schema reconciliation for iso42001_control_states (which
-- lacked review_* on a fresh boot due to an ordering bug in db.js) is in db.js, so
-- live and fresh now match. Doctrine: schema drift between live and fresh-boot is
-- RECONCILED, never coded around.

ALTER TABLE control_instances ADD COLUMN review_requested_by INTEGER REFERENCES users(id);
ALTER TABLE control_instances ADD COLUMN review_requested_at TEXT;
ALTER TABLE control_instances ADD COLUMN review_reason TEXT;
ALTER TABLE control_instances ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
ALTER TABLE control_instances ADD COLUMN reviewed_at TEXT;
