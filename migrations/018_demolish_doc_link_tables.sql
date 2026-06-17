-- 018_demolish_doc_link_tables.sql
-- DEMOLITION: drop the legacy document_controls / iso42001_document_controls join
-- tables, their bidirectional sync triggers, and the now-unused compat views.
--
-- Per the demolition playbook (set at the Phase 2 evidence demolition): drop via
-- the runner + remove the module's legacy DDL from db.js init() in the same PR, so
-- init() shrinks monotonically. Doc links are fully converged to
-- document_requirement_links (drl); reads/writes are drl-native (lib/doc-links.js).
--
-- Preconditions verified before this migration was authored: drl<->legacy parity
-- (drl 193 = the 193 VALID legacy rows; the 14 legacy-only rows are orphans whose
-- generated_doc was deleted, intentionally excluded by the Phase 3 backfill);
-- backup_runs id 255 ok < 24h; cutover 4 W6 merged (drl is the write source).
--
-- Order: triggers first (so dropping the tables cannot fire a sync trigger), then
-- the views, then the tables. The drl_to_dc_* triggers fire on the SURVIVING drl
-- table and write to document_controls, so they MUST be dropped explicitly or a
-- doc-link write would error against the dropped table. The dc_to_drl_* triggers
-- are ON the dropped tables (auto-dropped with them) but are dropped here too for
-- clarity. All IF EXISTS, so this is coherent on a pristine DB (db.js no longer
-- creates the tables, so the DROPs are no-ops there).

-- 013 legacy->converged doc-link triggers (on the legacy tables)
DROP TRIGGER IF EXISTS dc_to_drl_ins;
DROP TRIGGER IF EXISTS dc_to_drl_del;
DROP TRIGGER IF EXISTS dc_to_drl_upd;
DROP TRIGGER IF EXISTS dc42_to_drl_ins;
DROP TRIGGER IF EXISTS dc42_to_drl_del;
DROP TRIGGER IF EXISTS dc42_to_drl_upd;

-- 014 converged->legacy doc-link triggers (on the surviving drl table)
DROP TRIGGER IF EXISTS drl_to_dc_ins;
DROP TRIGGER IF EXISTS drl_to_dc42_ins;
DROP TRIGGER IF EXISTS drl_to_dc_del;
DROP TRIGGER IF EXISTS drl_to_dc_upd;

-- the legacy-shaped compat views (drl reads are inline drl-native now)
DROP VIEW IF EXISTS v_document_controls;
DROP VIEW IF EXISTS v_iso42001_document_controls;

-- the legacy join tables
DROP TABLE IF EXISTS document_controls;
DROP TABLE IF EXISTS iso42001_document_controls;
