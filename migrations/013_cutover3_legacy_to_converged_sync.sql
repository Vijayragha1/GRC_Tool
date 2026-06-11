-- 013_cutover3_legacy_to_converged_sync.sql
-- Cutover 3 of 5 (control-instance READS): TEMPORARY legacy->converged sync triggers.
--
-- WHY THIS EXISTS
-- Cutover 3 flips all control-state and document-link READS onto the converged
-- tables (control_instances / document_requirement_links) through the 012
-- compatibility views. WRITES stay legacy until cutover 4. The 012 views source
-- from control_instances, which is populated only by the Phase 3 backfill: a
-- point-in-time snapshot. Without a sync, the first legacy write after the read
-- flip would leave the converged read stale ("I saved a control, the dashboard
-- still shows the old value"). These triggers mirror every legacy write into the
-- converged tables so the read cutover is self-consistent on its own.
--
-- DIRECTION: legacy -> converged (the opposite of the cutover-2 evidence sync,
-- which was converged -> legacy because evidence WRITES had already flipped).
-- Cutover 4 adds the converged -> legacy direction for write-flipped workspaces;
-- with PRAGMA recursive_triggers = 0 the two directions cannot loop (a trigger's
-- writes never fire another trigger), and the app writes exactly one table per
-- workspace (flag-gated), so no row is double-applied.
--
-- NORMALIZATION fails loud, matching the 012 views: status maps the six display
-- values to converged tokens, ELSE passes the raw value through so it surfaces as
-- '!!UNMAPPED:<value>' in the view; applicability ELSE passes through to the
-- CHECK constraint, which throws and fails the write loudly. last_updated (and
-- doc-link created_at) are copied VERBATIM so the converged read stays byte-equal
-- to the legacy stamp (the re-backfill-at-switch finding, kept fresh continuously).
--
-- NULL-entity_id NOTE: control_instances UNIQUE(workspace_id, requirement_id,
-- entity_id) does NOT dedupe whole-org rows because SQLite treats NULL as
-- distinct in UNIQUE. So these triggers cannot use ON CONFLICT; they UPDATE the
-- existing whole-org row (entity_id IS NULL) then INSERT only WHERE NOT EXISTS.
--
-- ============================ DEMOLITION ============================
-- TEMPORARY. Drop all ten triggers at the control-state DEMOLITION step, together
-- with control_states / iso42001_control_states / document_controls /
-- iso42001_document_controls, after cutover 4 lands and the standing demolition
-- gate clears (per-module parity + latest backup_runs ok and < 24h + Vijay's
-- approval), AND after the review-convergence mini-step lifts the review-column
-- dependency. They have no purpose once the legacy tables are gone. Recorded in
-- MIGRATION_NOTES at creation time per the standing rule.
-- ===================================================================

-- ---------- ISO 27001 control_states -> control_instances ----------
CREATE TRIGGER IF NOT EXISTS cs_to_ci_ins
AFTER INSERT ON control_states
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id)
BEGIN
  UPDATE control_instances SET
    applicability = CASE NEW.applicability WHEN 'included' THEN 'applicable'
                      WHEN 'excluded' THEN 'excluded' WHEN 'undecided' THEN 'undecided'
                      ELSE NEW.applicability END,
    status = CASE NEW.status WHEN 'Implemented' THEN 'implemented'
                WHEN 'Partially Implemented' THEN 'partially_implemented'
                WHEN 'Work In Progress' THEN 'work_in_progress'
                WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented'
                WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity, scope_pct = NEW.scope_pct,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    last_verified_at = NEW.last_verified_at, review_status = NEW.review_status,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity, scope_pct,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, last_updated, migrated_from)
  SELECT NEW.workspace_id,
    (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id),
    NULL,
    CASE NEW.applicability WHEN 'included' THEN 'applicable' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    CASE NEW.status WHEN 'Implemented' THEN 'implemented'
      WHEN 'Partially Implemented' THEN 'partially_implemented'
      WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
      WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
      ELSE NEW.status END,
    NEW.maturity, NEW.scope_pct, NEW.inclusion_justification, NEW.exclusion_justification,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date, NEW.last_verified_at,
    NEW.review_status, NEW.last_updated, 'sync:control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id));
END;

CREATE TRIGGER IF NOT EXISTS cs_to_ci_upd
AFTER UPDATE ON control_states
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id)
BEGIN
  UPDATE control_instances SET
    applicability = CASE NEW.applicability WHEN 'included' THEN 'applicable'
                      WHEN 'excluded' THEN 'excluded' WHEN 'undecided' THEN 'undecided'
                      ELSE NEW.applicability END,
    status = CASE NEW.status WHEN 'Implemented' THEN 'implemented'
                WHEN 'Partially Implemented' THEN 'partially_implemented'
                WHEN 'Work In Progress' THEN 'work_in_progress'
                WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented'
                WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity, scope_pct = NEW.scope_pct,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    last_verified_at = NEW.last_verified_at, review_status = NEW.review_status,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity, scope_pct,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, last_updated, migrated_from)
  SELECT NEW.workspace_id,
    (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id),
    NULL,
    CASE NEW.applicability WHEN 'included' THEN 'applicable' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    CASE NEW.status WHEN 'Implemented' THEN 'implemented'
      WHEN 'Partially Implemented' THEN 'partially_implemented'
      WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
      WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
      ELSE NEW.status END,
    NEW.maturity, NEW.scope_pct, NEW.inclusion_justification, NEW.exclusion_justification,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date, NEW.last_verified_at,
    NEW.review_status, NEW.last_updated, 'sync:control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id));
END;

-- ---------- ISO 42001 iso42001_control_states -> control_instances ----------
-- Note: the iso42001_control_states legacy schema diverges across environments:
-- the live DB (instance of record) carries review_status + review_* columns,
-- while a fresh db.js boot carries roadmap_phase + assessment_answers instead and
-- has NO review_status. So this trigger syncs only the columns present in BOTH
-- (status, applicability, justifications, maturity, notes, internal_notes,
-- owner_id, due_date, last_updated); it does NOT reference review_status,
-- scope_pct, or last_verified_at (none exist on the 42001 legacy table on a fresh
-- boot, and referencing a missing NEW.column would throw at write time and break
-- 42001 writes in the suite). The v_iso42001_control_states view reads
-- ci.review_status from control_instances (always present); 42001 review stays a
-- legacy-only workflow per the cutover-3 manifest, so a synced 42001 row keeping
-- ci.review_status at its default is correct.
CREATE TRIGGER IF NOT EXISTS cs42_to_ci_ins
AFTER INSERT ON iso42001_control_states
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id)
BEGIN
  UPDATE control_instances SET
    applicability = CASE NEW.applicability WHEN 'included' THEN 'applicable'
                      WHEN 'excluded' THEN 'excluded' WHEN 'undecided' THEN 'undecided'
                      ELSE NEW.applicability END,
    status = CASE NEW.status WHEN 'Implemented' THEN 'implemented'
                WHEN 'Partially Implemented' THEN 'partially_implemented'
                WHEN 'Work In Progress' THEN 'work_in_progress'
                WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented'
                WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, last_updated, migrated_from)
  SELECT NEW.workspace_id,
    (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id),
    NULL,
    CASE NEW.applicability WHEN 'included' THEN 'applicable' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    CASE NEW.status WHEN 'Implemented' THEN 'implemented'
      WHEN 'Partially Implemented' THEN 'partially_implemented'
      WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
      WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
      ELSE NEW.status END,
    NEW.maturity, NEW.inclusion_justification, NEW.exclusion_justification,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date,
    NEW.last_updated, 'sync:iso42001_control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id));
END;

CREATE TRIGGER IF NOT EXISTS cs42_to_ci_upd
AFTER UPDATE ON iso42001_control_states
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id)
BEGIN
  UPDATE control_instances SET
    applicability = CASE NEW.applicability WHEN 'included' THEN 'applicable'
                      WHEN 'excluded' THEN 'excluded' WHEN 'undecided' THEN 'undecided'
                      ELSE NEW.applicability END,
    status = CASE NEW.status WHEN 'Implemented' THEN 'implemented'
                WHEN 'Partially Implemented' THEN 'partially_implemented'
                WHEN 'Work In Progress' THEN 'work_in_progress'
                WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented'
                WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, last_updated, migrated_from)
  SELECT NEW.workspace_id,
    (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id),
    NULL,
    CASE NEW.applicability WHEN 'included' THEN 'applicable' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    CASE NEW.status WHEN 'Implemented' THEN 'implemented'
      WHEN 'Partially Implemented' THEN 'partially_implemented'
      WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
      WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
      ELSE NEW.status END,
    NEW.maturity, NEW.inclusion_justification, NEW.exclusion_justification,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date,
    NEW.last_updated, 'sync:iso42001_control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id));
END;

-- ---------- ISO 27001 document_controls -> document_requirement_links ----------
CREATE TRIGGER IF NOT EXISTS dc_to_drl_ins
AFTER INSERT ON document_controls
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id)
BEGIN
  INSERT OR IGNORE INTO document_requirement_links (document_id, requirement_id, section_ref, created_at)
  SELECT NEW.document_id,
    (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id),
    NEW.section_ref, NEW.created_at;
END;

CREATE TRIGGER IF NOT EXISTS dc_to_drl_del
AFTER DELETE ON document_controls
BEGIN
  DELETE FROM document_requirement_links
   WHERE document_id = OLD.document_id
     AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                           WHERE f.code = 'iso27001' AND rq.ref = OLD.iso_item_id);
END;

CREATE TRIGGER IF NOT EXISTS dc_to_drl_upd
AFTER UPDATE OF section_ref ON document_controls
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id)
BEGIN
  UPDATE document_requirement_links SET section_ref = NEW.section_ref
   WHERE document_id = NEW.document_id
     AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                           WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id);
END;

-- ---------- ISO 42001 iso42001_document_controls -> document_requirement_links ----------
CREATE TRIGGER IF NOT EXISTS dc42_to_drl_ins
AFTER INSERT ON iso42001_document_controls
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id)
BEGIN
  INSERT OR IGNORE INTO document_requirement_links (document_id, requirement_id, section_ref, created_at)
  SELECT NEW.document_id,
    (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id),
    NEW.section_ref, NEW.created_at;
END;

CREATE TRIGGER IF NOT EXISTS dc42_to_drl_del
AFTER DELETE ON iso42001_document_controls
BEGIN
  DELETE FROM document_requirement_links
   WHERE document_id = OLD.document_id
     AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                           WHERE f.code = 'iso42001' AND rq.ref = OLD.iso_item_id);
END;

CREATE TRIGGER IF NOT EXISTS dc42_to_drl_upd
AFTER UPDATE OF section_ref ON iso42001_document_controls
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id)
BEGIN
  UPDATE document_requirement_links SET section_ref = NEW.section_ref
   WHERE document_id = NEW.document_id
     AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                           WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id);
END;
