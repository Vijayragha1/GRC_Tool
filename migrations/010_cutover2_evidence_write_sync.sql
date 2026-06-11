-- 010_cutover2_evidence_write_sync.sql
-- Cutover 2 of 5 (evidence writes): TEMPORARY new->legacy sync triggers.
--
-- During cutover 2 the app writes evidence linkage to evidence_requirement_links
-- (erl) on write-flipped workspaces. These triggers mirror every erl write back
-- into the demolition-scheduled legacy join tables: evidence_controls (ISO 27001)
-- and evidence_links (all frameworks). That keeps the legacy tables row-consistent
-- with erl for as long as they exist, which gives rollback safety and keeps
-- anything not yet converged readable from the legacy shape.
--
-- recursive_triggers is OFF in this app (PRAGMA recursive_triggers = 0), so these
-- triggers do NOT chain through the existing evctrl_to_evlinks_* triggers; they
-- therefore write BOTH legacy tables directly. INSERT OR IGNORE keeps them
-- idempotent against the legacy UNIQUE constraints. soc2 is intentionally
-- excluded: evidence_links CHECK only permits iso27001/iso42001/csf, so a soc2
-- erl link (none exist on dev) would live only in erl, which is correct.
--
-- ============================ DEMOLITION ============================
-- TEMPORARY. Drop these three triggers at the Phase 2 DEMOLITION step, together
-- with evidence_controls + evidence_links + the evctrl_to_evlinks_* triggers,
-- after cutover 2 lands on main and the standing demolition gate clears
-- (per-module parity + latest backup_runs ok and < 24h + Vijay's approval).
-- They have no purpose once the legacy join tables are gone. Recorded in
-- MIGRATION_NOTES at creation time per the standing rule.
-- ===================================================================

CREATE TRIGGER IF NOT EXISTS erl_to_legacy_ins
AFTER INSERT ON evidence_requirement_links
BEGIN
  -- ISO 27001 -> evidence_controls
  INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref)
    SELECT NEW.evidence_id, r.ref, NEW.section_ref
    FROM requirements r JOIN frameworks f ON f.id = r.framework_id
    WHERE r.id = NEW.requirement_id AND f.code = 'iso27001';
  -- All supported frameworks -> evidence_links (iso27001 rows here mirror the
  -- evidence_controls rows, matching the legacy evctrl_to_evlinks behaviour).
  INSERT OR IGNORE INTO evidence_links (evidence_id, framework, item_ref, section_ref)
    SELECT NEW.evidence_id, f.code, r.ref, NEW.section_ref
    FROM requirements r JOIN frameworks f ON f.id = r.framework_id
    WHERE r.id = NEW.requirement_id AND f.code IN ('iso27001','iso42001','csf');
END;

CREATE TRIGGER IF NOT EXISTS erl_to_legacy_del
AFTER DELETE ON evidence_requirement_links
BEGIN
  DELETE FROM evidence_controls
   WHERE evidence_id = OLD.evidence_id
     AND iso_item_id = (SELECT r.ref FROM requirements r JOIN frameworks f ON f.id = r.framework_id
                        WHERE r.id = OLD.requirement_id AND f.code = 'iso27001');
  DELETE FROM evidence_links
   WHERE evidence_id = OLD.evidence_id
     AND item_ref = (SELECT r.ref FROM requirements r WHERE r.id = OLD.requirement_id)
     AND framework = (SELECT f.code FROM requirements r JOIN frameworks f ON f.id = r.framework_id
                      WHERE r.id = OLD.requirement_id);
END;

CREATE TRIGGER IF NOT EXISTS erl_to_legacy_upd
AFTER UPDATE OF section_ref ON evidence_requirement_links
BEGIN
  UPDATE evidence_controls SET section_ref = NEW.section_ref
   WHERE evidence_id = NEW.evidence_id
     AND iso_item_id = (SELECT r.ref FROM requirements r JOIN frameworks f ON f.id = r.framework_id
                        WHERE r.id = NEW.requirement_id AND f.code = 'iso27001');
  UPDATE evidence_links SET section_ref = NEW.section_ref
   WHERE evidence_id = NEW.evidence_id
     AND item_ref = (SELECT r.ref FROM requirements r WHERE r.id = NEW.requirement_id)
     AND framework = (SELECT f.code FROM requirements r JOIN frameworks f ON f.id = r.framework_id
                      WHERE r.id = NEW.requirement_id);
END;
