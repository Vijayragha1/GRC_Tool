-- 011_phase2_demolition_evidence_joins.sql
-- PHASE 2 DEMOLITION (the first demolition of the program; 2026-06-11).
--
-- Drops the legacy evidence join tables and every evidence sync trigger. By the
-- time this runs, all workspaces are read+write converged onto
-- evidence_requirement_links and the app code is erl-native (no legacy path),
-- and db.js init() no longer creates evidence_controls / evidence_links / the
-- evctrl_to_evlinks_* triggers.
--
-- Order: triggers first (so dropping the tables cannot fire a sync trigger),
-- then the tables. Everything is IF EXISTS so this is coherent on BOTH:
--   * the dev DB (warm): evidence_controls/_links + evctrl_to_evlinks_* (from the
--     old db.js) + erl_to_legacy_* (migration 010) all exist -> all dropped.
--   * a pristine DB (full chain): db.js never created the legacy tables/triggers;
--     migration 010 created the erl_to_legacy_* triggers (CREATE TRIGGER resolves
--     referenced tables lazily, so it succeeds without the tables) and this file
--     drops them before they could ever fire. The DROP TABLE/TRIGGER IF EXISTS
--     for the never-created objects are no-ops.

DROP TRIGGER IF EXISTS erl_to_legacy_ins;
DROP TRIGGER IF EXISTS erl_to_legacy_del;
DROP TRIGGER IF EXISTS erl_to_legacy_upd;

DROP TRIGGER IF EXISTS evctrl_to_evlinks_ins;
DROP TRIGGER IF EXISTS evctrl_to_evlinks_del;
DROP TRIGGER IF EXISTS evctrl_to_evlinks_upd;

DROP TABLE IF EXISTS evidence_controls;
DROP TABLE IF EXISTS evidence_links;
