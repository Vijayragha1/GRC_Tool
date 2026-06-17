-- 017_review_convergence_sync.sql
-- Review-convergence mini-step: extend the 013 (legacy->converged) and 014
-- (converged->legacy) control-state sync triggers to carry the full review_*
-- column set, so a converged review write mirrors to legacy and vice versa.
--
-- 42001 now syncs review_* too: the db.js fresh-boot schema reconciliation gave
-- iso42001_control_states the review_* columns on a fresh boot (it already had
-- them on live), so the drift that forced their exclusion from the 013/014 42001
-- triggers is gone. Doctrine: reconcile schema drift, never code around it.
--
-- Triggers cannot be ALTERed; 013/014 are already applied, so we DROP + recreate
-- the eight control-state triggers here. Bodies are identical to 013/014 with the
-- review columns added (review_status was already synced for 27001; the other five
-- are new for 27001, and all six are new for 42001). recursive_triggers=0 keeps
-- 013+014 from looping, unchanged. These remain TEMPORARY: dropped at the
-- control-state demolition with the legacy tables.

DROP TRIGGER IF EXISTS cs_to_ci_ins;
DROP TRIGGER IF EXISTS cs_to_ci_upd;
DROP TRIGGER IF EXISTS cs42_to_ci_ins;
DROP TRIGGER IF EXISTS cs42_to_ci_upd;
DROP TRIGGER IF EXISTS ci_to_cs_ins;
DROP TRIGGER IF EXISTS ci_to_cs_upd;
DROP TRIGGER IF EXISTS ci_to_cs42_ins;
DROP TRIGGER IF EXISTS ci_to_cs42_upd;

-- ================= ISO 27001 legacy -> converged (cs -> ci) =================
CREATE TRIGGER cs_to_ci_ins
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
                WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity, scope_pct = NEW.scope_pct,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    last_verified_at = NEW.last_verified_at, review_status = NEW.review_status,
    review_requested_by = NEW.review_requested_by, review_requested_at = NEW.review_requested_at,
    review_reason = NEW.review_reason, reviewed_by = NEW.reviewed_by, reviewed_at = NEW.reviewed_at,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity, scope_pct,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, review_requested_by, review_requested_at,
     review_reason, reviewed_by, reviewed_at, last_updated, migrated_from)
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
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated, 'sync:control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id));
END;

CREATE TRIGGER cs_to_ci_upd
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
                WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity, scope_pct = NEW.scope_pct,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    last_verified_at = NEW.last_verified_at, review_status = NEW.review_status,
    review_requested_by = NEW.review_requested_by, review_requested_at = NEW.review_requested_at,
    review_reason = NEW.review_reason, reviewed_by = NEW.reviewed_by, reviewed_at = NEW.reviewed_at,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity, scope_pct,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, review_requested_by, review_requested_at,
     review_reason, reviewed_by, reviewed_at, last_updated, migrated_from)
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
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated, 'sync:control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso27001' AND rq.ref = NEW.iso_item_id));
END;

-- ================= ISO 42001 legacy -> converged (cs42 -> ci) =================
-- Now syncs review_* (the fresh-boot schema reconciliation added them).
CREATE TRIGGER cs42_to_ci_ins
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
                WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    review_status = NEW.review_status,
    review_requested_by = NEW.review_requested_by, review_requested_at = NEW.review_requested_at,
    review_reason = NEW.review_reason, reviewed_by = NEW.reviewed_by, reviewed_at = NEW.reviewed_at,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, review_status, review_requested_by, review_requested_at, review_reason,
     reviewed_by, reviewed_at, last_updated, migrated_from)
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
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated, 'sync:iso42001_control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id));
END;

CREATE TRIGGER cs42_to_ci_upd
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
                WHEN 'Work In Progress' THEN 'work_in_progress' WHEN 'Not Assessed' THEN 'not_assessed'
                WHEN 'Not Implemented' THEN 'not_implemented' WHEN 'Not Applicable' THEN 'not_applicable'
                ELSE NEW.status END,
    maturity = NEW.maturity,
    inclusion_justification = NEW.inclusion_justification,
    exclusion_justification = NEW.exclusion_justification,
    notes = NEW.notes, internal_notes = NEW.internal_notes,
    owner_id = NEW.owner_id, due_date = NEW.due_date,
    review_status = NEW.review_status,
    review_requested_by = NEW.review_requested_by, review_requested_at = NEW.review_requested_at,
    review_reason = NEW.review_reason, reviewed_by = NEW.reviewed_by, reviewed_at = NEW.reviewed_at,
    last_updated = NEW.last_updated
  WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
    AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                          WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id);

  INSERT INTO control_instances
    (workspace_id, requirement_id, entity_id, applicability, status, maturity,
     inclusion_justification, exclusion_justification, notes, internal_notes, owner_id,
     due_date, review_status, review_requested_by, review_requested_at, review_reason,
     reviewed_by, reviewed_at, last_updated, migrated_from)
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
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated, 'sync:iso42001_control_states'
  WHERE NOT EXISTS (
    SELECT 1 FROM control_instances
    WHERE workspace_id = NEW.workspace_id AND entity_id IS NULL
      AND requirement_id = (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
                            WHERE f.code = 'iso42001' AND rq.ref = NEW.iso_item_id));
END;

-- ================= ISO 27001 converged -> legacy (ci -> cs) =================
CREATE TRIGGER ci_to_cs_ins
AFTER INSERT ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso27001')
BEGIN
  INSERT INTO control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, scope_pct, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, review_requested_by, review_requested_at,
     review_reason, reviewed_by, reviewed_at, last_updated)
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
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, scope_pct = excluded.scope_pct,
    notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date,
    last_verified_at = excluded.last_verified_at, review_status = excluded.review_status,
    review_requested_by = excluded.review_requested_by, review_requested_at = excluded.review_requested_at,
    review_reason = excluded.review_reason, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
    last_updated = excluded.last_updated;
END;

CREATE TRIGGER ci_to_cs_upd
AFTER UPDATE ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso27001')
BEGIN
  INSERT INTO control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, scope_pct, notes, internal_notes, owner_id,
     due_date, last_verified_at, review_status, review_requested_by, review_requested_at,
     review_reason, reviewed_by, reviewed_at, last_updated)
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
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, scope_pct = excluded.scope_pct,
    notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date,
    last_verified_at = excluded.last_verified_at, review_status = excluded.review_status,
    review_requested_by = excluded.review_requested_by, review_requested_at = excluded.review_requested_at,
    review_reason = excluded.review_reason, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
    last_updated = excluded.last_updated;
END;

-- ================= ISO 42001 converged -> legacy (ci -> cs42) =================
-- Now mirrors review_* (the fresh-boot schema reconciliation added them).
CREATE TRIGGER ci_to_cs42_ins
AFTER INSERT ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso42001')
BEGIN
  INSERT INTO iso42001_control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, notes, internal_notes, owner_id, due_date,
     review_status, review_requested_by, review_requested_at, review_reason,
     reviewed_by, reviewed_at, last_updated)
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
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date,
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date,
    review_status = excluded.review_status,
    review_requested_by = excluded.review_requested_by, review_requested_at = excluded.review_requested_at,
    review_reason = excluded.review_reason, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
    last_updated = excluded.last_updated;
END;

CREATE TRIGGER ci_to_cs42_upd
AFTER UPDATE ON control_instances
WHEN NEW.entity_id IS NULL
 AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
             WHERE rq.id = NEW.requirement_id AND f.code = 'iso42001')
BEGIN
  INSERT INTO iso42001_control_states
    (workspace_id, iso_item_id, status, applicability, inclusion_justification,
     exclusion_justification, maturity, notes, internal_notes, owner_id, due_date,
     review_status, review_requested_by, review_requested_at, review_reason,
     reviewed_by, reviewed_at, last_updated)
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
    NEW.notes, NEW.internal_notes, NEW.owner_id, NEW.due_date,
    NEW.review_status, NEW.review_requested_by, NEW.review_requested_at, NEW.review_reason,
    NEW.reviewed_by, NEW.reviewed_at, NEW.last_updated)
  ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET
    status = excluded.status, applicability = excluded.applicability,
    inclusion_justification = excluded.inclusion_justification,
    exclusion_justification = excluded.exclusion_justification,
    maturity = excluded.maturity, notes = excluded.notes, internal_notes = excluded.internal_notes,
    owner_id = excluded.owner_id, due_date = excluded.due_date,
    review_status = excluded.review_status,
    review_requested_by = excluded.review_requested_by, review_requested_at = excluded.review_requested_at,
    review_reason = excluded.review_reason, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
    last_updated = excluded.last_updated;
END;
