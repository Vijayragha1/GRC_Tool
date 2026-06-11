-- 012_phase3_compat_views.sql
-- Cutover 3 (control-instance READS): compatibility views that present the
-- converged control_instances / document_requirement_links with the LEGACY
-- column names and DE-NORMALIZED display values, so the read sites can swap the
-- table name behind the per-workspace flag `control_reads_converged` with the
-- query structure (and therefore the rendered output) unchanged.
--
-- DE-NORMALIZATION FAILS LOUD: a converged status/applicability value outside the
-- approved 1:1 map renders as '!!UNMAPPED:<value>', never NULL or a silent
-- fallback, so a future vocabulary addition can never leak invisible corruption
-- into a rendered SoA. (A missing instance row stays NULL here and the read's own
-- COALESCE(...,'Not Assessed'/'undecided') supplies the legacy default, exactly
-- as it did for a missing control_states row.)
--
-- v_control_states reproduces the LEGACY control_states population: whole-org
-- instances only (entity_id IS NULL). Entity-scoped instances came from
-- entity_control_states, which has ZERO read surfaces in the app.
--
-- Columns control_instances does not track (assessment_answers + the review_*
-- workflow columns) are exposed as NULL: they are only read by the assess wizard
-- / review workflow, which are read-modify-write paths that stay on the legacy
-- tables until cutover 4 (writes).
--
-- TEMPORARY: drop these views at the Phase 3 demolition step, with the legacy
-- control_states / iso42001_control_states / document_controls tables.

DROP VIEW IF EXISTS v_control_states;
CREATE VIEW v_control_states AS
SELECT
  ci.id                       AS id,
  ci.workspace_id             AS workspace_id,
  rq.ref                      AS iso_item_id,
  CASE ci.status
    WHEN 'implemented'           THEN 'Implemented'
    WHEN 'partially_implemented' THEN 'Partially Implemented'
    WHEN 'not_implemented'       THEN 'Not Implemented'
    WHEN 'not_applicable'        THEN 'Not Applicable'
    WHEN 'not_assessed'          THEN 'Not Assessed'
    ELSE '!!UNMAPPED:' || ci.status
  END                         AS status,
  CASE ci.applicability
    WHEN 'applicable' THEN 'included'
    WHEN 'excluded'   THEN 'excluded'
    WHEN 'undecided'  THEN 'undecided'
    ELSE '!!UNMAPPED:' || ci.applicability
  END                         AS applicability,
  ci.inclusion_justification  AS inclusion_justification,
  ci.exclusion_justification  AS exclusion_justification,
  ci.maturity                 AS maturity,
  ci.notes                    AS notes,
  ci.internal_notes           AS internal_notes,
  ci.owner_id                 AS owner_id,
  ci.due_date                 AS due_date,
  ci.last_updated             AS last_updated,
  ci.last_verified_at         AS last_verified_at,
  ci.scope_pct                AS scope_pct,
  ci.review_status            AS review_status,
  NULL                        AS assessment_answers,
  NULL                        AS review_requested_by,
  NULL                        AS review_requested_at,
  NULL                        AS review_reason,
  NULL                        AS reviewed_by,
  NULL                        AS reviewed_at
FROM control_instances ci
JOIN requirements rq ON rq.id = ci.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso27001'
WHERE ci.entity_id IS NULL;

DROP VIEW IF EXISTS v_iso42001_control_states;
CREATE VIEW v_iso42001_control_states AS
SELECT
  ci.id                       AS id,
  ci.workspace_id             AS workspace_id,
  rq.ref                      AS iso_item_id,
  CASE ci.status
    WHEN 'implemented'           THEN 'Implemented'
    WHEN 'partially_implemented' THEN 'Partially Implemented'
    WHEN 'not_implemented'       THEN 'Not Implemented'
    WHEN 'not_applicable'        THEN 'Not Applicable'
    WHEN 'not_assessed'          THEN 'Not Assessed'
    ELSE '!!UNMAPPED:' || ci.status
  END                         AS status,
  CASE ci.applicability
    WHEN 'applicable' THEN 'included'
    WHEN 'excluded'   THEN 'excluded'
    WHEN 'undecided'  THEN 'undecided'
    ELSE '!!UNMAPPED:' || ci.applicability
  END                         AS applicability,
  ci.inclusion_justification  AS inclusion_justification,
  ci.exclusion_justification  AS exclusion_justification,
  ci.maturity                 AS maturity,
  ci.notes                    AS notes,
  ci.internal_notes           AS internal_notes,
  ci.owner_id                 AS owner_id,
  ci.due_date                 AS due_date,
  ci.last_updated             AS last_updated,
  ci.review_status            AS review_status,
  NULL                        AS review_requested_by,
  NULL                        AS review_requested_at,
  NULL                        AS review_reason,
  NULL                        AS reviewed_by,
  NULL                        AS reviewed_at
FROM control_instances ci
JOIN requirements rq ON rq.id = ci.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso42001'
WHERE ci.entity_id IS NULL;

-- document_controls / iso42001_document_controls -> document_requirement_links
DROP VIEW IF EXISTS v_document_controls;
CREATE VIEW v_document_controls AS
SELECT drl.id AS id, drl.document_id AS document_id, rq.ref AS iso_item_id,
       drl.section_ref AS section_ref, drl.created_at AS created_at
FROM document_requirement_links drl
JOIN requirements rq ON rq.id = drl.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso27001';

DROP VIEW IF EXISTS v_iso42001_document_controls;
CREATE VIEW v_iso42001_document_controls AS
SELECT drl.id AS id, drl.document_id AS document_id, rq.ref AS iso_item_id,
       drl.section_ref AS section_ref, drl.created_at AS created_at
FROM document_requirement_links drl
JOIN requirements rq ON rq.id = drl.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso42001';
