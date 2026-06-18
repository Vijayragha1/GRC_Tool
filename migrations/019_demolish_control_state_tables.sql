-- 019_demolish_control_state_tables.sql
-- DEMOLITION (largest in the program): drop the legacy current-state tables
-- control_states / iso42001_control_states and their bidirectional sync triggers.
-- control_instances is now the sole source of truth; reads go through the compat
-- views (v_control_states / v_iso42001_control_states), which read control_instances
-- and SURVIVE this drop. Writes are converged-only (control_instances).
--
-- TOTAL vs PARTIAL (recorded in MIGRATION_NOTES): this drops the CURRENT-STATE
-- tables only. The HISTORY tables (control_state_history /
-- iso42001_control_state_history) and assessment_passes REMAIN, blocked on the
-- Phase 4 engine cutover (the pass-snapshot read model). The W2 history WRITE was
-- repointed to source `cur` from v_control_states, so it no longer reads the legacy
-- tables; assessment_answers is recorded NULL (dead, deferred-drop).
--
-- Preconditions (verified before authoring): cutover 4 + review-convergence on main;
-- backup_runs id 255 ok < 24h; full cross-codebase reference audit (server.js /
-- routes / lib) with every hit repointed (converged views / control_instances) or
-- confirmed-dead (legacy else/ternary branches, never prepared since converged is
-- unconditional); the 5 unconditional legacy prepares collapsed to converged-only.
--
-- Order: triggers FIRST (the ci_to_cs_* triggers fire on control_instances writes
-- and would otherwise write the dropped tables; the cs_to_ci_* triggers are ON the
-- dropped tables). Then the tables. All IF EXISTS, so this is a no-op on a pristine
-- DB after db.js stops being the table source (the db.js CREATEs stay as transient
-- chain-scaffolding because the immutable migrations 013/017 attach triggers ON
-- these tables; full DDL removal awaits a chain baseline).

-- bidirectional control-state sync triggers (013 + 014, recreated by 017)
DROP TRIGGER IF EXISTS cs_to_ci_ins;
DROP TRIGGER IF EXISTS cs_to_ci_upd;
DROP TRIGGER IF EXISTS cs42_to_ci_ins;
DROP TRIGGER IF EXISTS cs42_to_ci_upd;
DROP TRIGGER IF EXISTS ci_to_cs_ins;
DROP TRIGGER IF EXISTS ci_to_cs_upd;
DROP TRIGGER IF EXISTS ci_to_cs42_ins;
DROP TRIGGER IF EXISTS ci_to_cs42_upd;

-- the legacy current-state tables (the views over control_instances survive)
DROP TABLE IF EXISTS control_states;
DROP TABLE IF EXISTS iso42001_control_states;
