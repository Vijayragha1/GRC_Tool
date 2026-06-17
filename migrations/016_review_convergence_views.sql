-- 016_review_convergence_views.sql
-- Review-convergence mini-step: recreate the control-state compat views so the
-- review columns come from control_instances (migration 015 added them) instead of
-- the NULL placeholders cutover 3 used. Reads of the review workflow (review-queue,
-- assess badge) now see live converged review data through the views.
--
-- Only the two control-state views change; the document views are untouched.
-- assessment_answers stays NULL (still deferred to the Phase 4 engine cutover).

DROP VIEW IF EXISTS v_control_states;
CREATE VIEW v_control_states AS
SELECT
  ci.id                       AS id,
  ci.workspace_id             AS workspace_id,
  rq.ref                      AS iso_item_id,
  CASE ci.status
    WHEN 'implemented'           THEN 'Implemented'
    WHEN 'partially_implemented' THEN 'Partially Implemented'
    WHEN 'work_in_progress'      THEN 'Work In Progress'
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
  ci.review_requested_by      AS review_requested_by,
  ci.review_requested_at      AS review_requested_at,
  ci.review_reason            AS review_reason,
  ci.reviewed_by              AS reviewed_by,
  ci.reviewed_at              AS reviewed_at
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
    WHEN 'work_in_progress'      THEN 'Work In Progress'
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
  ci.review_requested_by      AS review_requested_by,
  ci.review_requested_at      AS review_requested_at,
  ci.review_reason            AS review_reason,
  ci.reviewed_by              AS reviewed_by,
  ci.reviewed_at              AS reviewed_at
FROM control_instances ci
JOIN requirements rq ON rq.id = ci.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso42001'
WHERE ci.entity_id IS NULL;
