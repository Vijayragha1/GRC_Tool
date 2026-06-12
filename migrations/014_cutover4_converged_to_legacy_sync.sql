-- 014_cutover4_converged_to_legacy_sync.sql
-- Cutover 4 of 5 (control-instance WRITES): TEMPORARY converged->legacy sync triggers.
--
-- WHY THIS EXISTS
-- Cutover 4 flips control WRITES onto the converged tables (control_instances /
-- document_requirement_links) per workspace (control_writes_converged). Reads are
-- already converged (cutover 3). These triggers mirror every converged write BACK
-- into the still-present legacy tables (control_states / iso42001_control_states /
-- document_controls / iso42001_document_controls), so the legacy shadow stays
-- row-consistent for as long as those tables exist. That gives:
--   * rollback safety (a workspace flipped back to legacy writes finds legacy fresh)
--   * fail-safe reads (control-reads.js falls back to legacy on flag/view absence)
--   * a faithful legacy copy right up to the control-state demolition
-- This is the same shape as the cutover-2 evidence sync (migration 010), and the
-- opposite direction of the cutover-3 sync (013, legacy->converged).
--
-- NO LOOP with 013: PRAGMA recursive_triggers = 0, so a trigger's writes never
-- fire another trigger. The app writes exactly ONE table per workspace (flag-gated):
--   * non-flipped ws writes control_states -> 013 mirrors to control_instances
--     (014 does NOT fire on that control_instances write)
--   * flipped ws writes control_instances -> 014 mirrors to control_states
--     (013 does NOT fire on that control_states write)
-- so no row is double-applied and nothing recurses.
--
-- DE-NORMALIZATION reverses the views: status token -> display value, applicability
-- token -> legacy value; ELSE passes the raw value through (loud, not silent).
-- last_updated and doc-link created_at are copied VERBATIM so legacy stays
-- byte-equal to the converged stamp.
--
-- WHOLE-ORG ONLY: mirrors rows with entity_id IS NULL (the legacy tables have no
-- entity dimension); entity-scoped instances have no legacy equivalent and are not
-- mirrored. Legacy keys (workspace_id, iso_item_id) are both NOT NULL, so these
-- triggers CAN use ON CONFLICT(workspace_id, iso_item_id) DO UPDATE (unlike 013,
-- whose NULL entity_id target forced UPDATE-then-INSERT).
--
-- SCHEMA-DRIFT (per the cutover-3 finding): iso42001_control_states has no
-- review_status / scope_pct / last_verified_at on a fresh db.js boot, so the 42001
-- mirror writes only the live<->fresh column INTERSECTION. control_states is
-- identical across both, so the 27001 mirror writes the full set (review_status
-- included; the converged write path leaves review_* unmanaged, review stays a
-- legacy-only workflow per the manifest).
--
-- ============================ DEMOLITION ============================
-- TEMPORARY. Drop all of these triggers at the control-state DEMOLITION step,
-- together with control_states / iso42001_control_states / document_controls /
-- iso42001_document_controls AND the 013 triggers, after cutover 4 lands, the
-- review-convergence mini-step lifts the review-column dependency, and the
-- standing demolition gate clears. Recorded in MIGRATION_NOTES at creation time.
-- ===================================================================

-- ---------- ISO 27001 control_instances -> control_states ----------
CREATE TRIGGER IF NOT EXISTS ci_to_cs_ins
AFTER INSERT ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso27001')
BEGIN
  INSERT INTO control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, scope_pct, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, last_updated)
  VALUES (
    NEW.workspace_id,
    (SELECT rq.ref FROM requirements rq WHERE rq.id = NEW.requirement_id),
    CASE NEW.status WHEN 'implemented' THEN 'Implemented'
      WHEN 'partially_implemented' THEN 'Partially Implemented'
      WHEN 'work_in_progress' THEN 'Work In Progress' WHEN 'not_assessed' THEN 'Not Assessed'
      WHEN 'not_implemented' THEN 'Not Implemented' WHEN 'not_applicable' THEN 'Not Applicable'
      ELSE NEW.status END,
    CASE NEW.applicability WHEN 'applicable' THEN 'included' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    NEW.inclusion_justification, NEW.exclusion_justification, NEW.maturity, NEW.scope_pct,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date, NEW.last_verified_at,
    NEW.review_status, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, scope_pct = excluded.scope_pct,
    notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date,
    last_verified_at = excluded.last_verified_at, review_status = excluded.review_status,
    last_updated = excluded.last_updated;
END;

CREATE TRIGGER IF NOT EXISTS ci_to_cs_upd
AFTER UPDATE ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso27001')
BEGIN
  INSERT INTO control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, scope_pct, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, last_updated)
  VALUES (
    NEW.workspace_id,
    (SELECT rq.ref FROM requirements rq WHERE rq.id = NEW.requirement_id),
    CASE NEW.status WHEN 'implemented' THEN 'Implemented'
      WHEN 'partially_implemented' THEN 'Partially Implemented'
      WHEN 'work_in_progress' THEN 'Work In Progress' WHEN 'not_assessed' THEN 'Not Assessed'
      WHEN 'not_implemented' THEN 'Not Implemented' WHEN 'not_applicable' THEN 'Not Applicable'
      ELSE NEW.status END,
    CASE NEW.applicability WHEN 'applicable' THEN 'included' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    NEW.inclusion_justification, NEW.exclusion_justification, NEW.maturity, NEW.scope_pct,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date, NEW.last_verified_at,
    NEW.review_status, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, scope_pct = excluded.scope_pct,
    notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date,
    last_verified_at = excluded.last_verified_at, review_status = excluded.review_status,
    last_updated = excluded.last_updated;
END;

-- ---------- ISO 42001 control_instances -> iso42001_control_states ----------
-- Intersection columns only (no scope_pct / last_verified_at / review_status).
CREATE TRIGGER IF NOT EXISTS ci_to_cs42_ins
AFTER INSERT ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso42001')
BEGIN
  INSERT INTO iso42001_control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, notes, internal_notes, owner_id, due_date, last_updated)
  VALUES (
    NEW.workspace_id,
    (SELECT rq.ref FROM requirements rq WHERE rq.id = NEW.requirement_id),
    CASE NEW.status WHEN 'implemented' THEN 'Implemented'
      WHEN 'partially_implemented' THEN 'Partially Implemented'
      WHEN 'work_in_progress' THEN 'Work In Progress' WHEN 'not_assessed' THEN 'Not Assessed'
      WHEN 'not_implemented' THEN 'Not Implemented' WHEN 'not_applicable' THEN 'Not Applicable'
      ELSE NEW.status END,
    CASE NEW.applicability WHEN 'applicable' THEN 'included' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    NEW.inclusion_justification, NEW.exclusion_justification, NEW.maturity,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date, last_updated = excluded.last_updated;
END;

CREATE TRIGGER IF NOT EXISTS ci_to_cs42_upd
AFTER UPDATE ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso42001')
BEGIN
  INSERT INTO iso42001_control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, notes, internal_notes, owner_id, due_date, last_updated)
  VALUES (
    NEW.workspace_id,
    (SELECT rq.ref FROM requirements rq WHERE rq.id = NEW.requirement_id),
    CASE NEW.status WHEN 'implemented' THEN 'Implemented'
      WHEN 'partially_implemented' THEN 'Partially Implemented'
      WHEN 'work_in_progress' THEN 'Work In Progress' WHEN 'not_assessed' THEN 'Not Assessed'
      WHEN 'not_implemented' THEN 'Not Implemented' WHEN 'not_applicable' THEN 'Not Applicable'
      ELSE NEW.status END,
    CASE NEW.applicability WHEN 'applicable' THEN 'included' WHEN 'excluded' THEN 'excluded'
      WHEN 'undecided' THEN 'undecided' ELSE NEW.applicability END,
    NEW.inclusion_justification, NEW.exclusion_justification, NEW.maturity,
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date, last_updated = excluded.last_updated;
END;

-- ---------- document_requirement_links -> document_controls (per framework) ----------
CREATE TRIGGER IF NOT EXISTS drl_to_dc_ins
AFTER INSERT ON document_requirement_links
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso27001')
BEGIN
  INSERT OR IGNORE INTO document_controls (document_id, iso_item_id, section_ref, created_at)
  SELECT NEW.document_id, (SELECT rq.ref FROM requirements rq WHERE rq.id = NEW.requirement_id),
         NEW.section_ref, NEW.created_at;
END;

CREATE TRIGGER IF NOT EXISTS drl_to_dc42_ins
AFTER INSERT ON document_requirement_links
WHEN EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso42001')
BEGIN
  INSERT OR IGNORE INTO iso42001_document_controls (document_id, iso_item_id, section_ref, created_at)
  SELECT NEW.document_id, (SELECT rq.ref FROM requirements rq WHERE rq.id = NEW.requirement_id),
         NEW.section_ref, NEW.created_at;
END;

CREATE TRIGGER IF NOT EXISTS drl_to_dc_del
AFTER DELETE ON document_requirement_links
BEGIN
  DELETE FROM document_controls
   WHERE document_id = OLD.document_id
     AND iso_item_id = (SELECT rq.ref FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                        WHERE rq.id = OLD.requirement_id AND f.code = 'iso27001');
  DELETE FROM iso42001_document_controls
   WHERE document_id = OLD.document_id
     AND iso_item_id = (SELECT rq.ref FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                        WHERE rq.id = OLD.requirement_id AND f.code = 'iso42001');
END;

CREATE TRIGGER IF NOT EXISTS drl_to_dc_upd
AFTER UPDATE OF section_ref ON document_requirement_links
BEGIN
  UPDATE document_controls SET section_ref = NEW.section_ref
   WHERE document_id = NEW.document_id
     AND iso_item_id = (SELECT rq.ref FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                        WHERE rq.id = NEW.requirement_id AND f.code = 'iso27001');
  UPDATE iso42001_document_controls SET section_ref = NEW.section_ref
   WHERE document_id = NEW.document_id
     AND iso_item_id = (SELECT rq.ref FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                        WHERE rq.id = NEW.requirement_id AND f.code = 'iso42001');
END;
