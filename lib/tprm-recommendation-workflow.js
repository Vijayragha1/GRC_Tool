'use strict';

const crypto = require('crypto');
const rbac = require('./rbac');
const tprmDomain = require('./tprm-domain');
const serviceCapabilities = require('./tprm-capabilities');

const EDITABLE_STATUSES = new Set(['draft', 'changes_requested']);
const OUTCOMES = new Set([
  'recommend_onboard',
  'recommend_with_conditions',
  'do_not_recommend',
  'insufficient_information',
]);
const RISK_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

class TprmRecommendationWorkflowError extends tprmDomain.TprmDomainError {
  constructor(code, message, status = 409, details = null) {
    super(code, message, status, details);
    this.name = 'TprmRecommendationWorkflowError';
  }
}

function fail(code, message, status = 409, details = null) {
  throw new TprmRecommendationWorkflowError(code, message, status, details);
}

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function requiredText(value, field, minimum = 1, maximum = 8000) {
  const text = cleanText(value);
  if (text.length < minimum) fail('TPRM_RECOMMENDATION_VALIDATION', `${field} must contain at least ${minimum} characters.`, 400);
  if (text.length > maximum) fail('TPRM_RECOMMENDATION_VALIDATION', `${field} must contain no more than ${maximum} characters.`, 400);
  return text;
}

function positiveId(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail('TPRM_RECOMMENDATION_VALIDATION', `${field} is invalid.`, 400);
  return number;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) fail('TPRM_RECOMMENDATION_VALIDATION', `${field} is invalid.`, 400);
  return number;
}

function expectedRecommendationId(value) {
  if (value == null || value === '' || value === 0 || value === '0' || value === 'none') return null;
  return positiveId(value, 'expectedCurrentRecommendationId');
}

function utcNow() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : tprmDomain.stableStringify(value)).digest('hex');
}

function idempotencyKey(value) {
  const key = cleanText(value);
  if (key.length < 32 || key.length > 128 || key !== String(value == null ? '' : value)) {
    fail('TPRM_IDEMPOTENCY_KEY_INVALID', 'A 32 to 128 character idempotency key is required.', 400);
  }
  return key;
}

function permissionSet(db, workspaceId, actor) {
  const overrides = db.prepare(`SELECT permission,granted FROM workspace_role_overrides
    WHERE workspace_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>=datetime('now'))`).all(workspaceId, actor.id);
  return rbac.effectivePermissions(actor.firm_role, overrides);
}

function firmActor(db, workspaceIdInput, actorIdInput, permission) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const actorId = positiveId(actorIdInput, 'actorId');
  const actor = db.prepare(`SELECT u.*,w.firm_id AS workspace_firm_id
    FROM users u JOIN workspaces w ON w.id=?
    WHERE u.id=? AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id`).get(workspaceId, actorId);
  if (!actor) fail('TPRM_FIRM_ACTOR_REQUIRED', 'An active consultancy user for this client is required.', 403);
  const permissions = permissionSet(db, workspaceId, actor);
  if (permission && !rbac.hasPermission(permissions, permission)) {
    fail('TPRM_RECOMMENDATION_PERMISSION_DENIED', `The ${permission} permission is required for this action.`, 403);
  }
  const canCrossView = rbac.hasPermission(permissions, 'firm.cross_view');
  const assigned = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, actor.id);
  if (!canCrossView && !assigned) {
    fail('TPRM_RECOMMENDATION_WORKSPACE_ACCESS_DENIED', 'This consultancy user is not assigned to the client workspace.', 403);
  }
  return { actor, permissions };
}

function firmViewer(db, workspaceId, actorId) {
  const result = firmActor(db, workspaceId, actorId);
  if (!rbac.hasPermission(result.permissions, 'tprm.recommendation.draft')
      && !rbac.hasPermission(result.permissions, 'tprm.recommendation.issue')) {
    fail('TPRM_RECOMMENDATION_PERMISSION_DENIED', 'Recommendation workflow access is required.', 403);
  }
  return result;
}

function scopedSupplierAndCycle(db, workspaceIdInput, supplierIdInput, cycleIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const cycleId = positiveId(cycleIdInput, 'cycleId');
  const row = db.prepare(`SELECT c.*,s.name AS supplier_name,m.status AS module_status FROM tprm_assessment_cycles c
    JOIN suppliers s ON s.id=c.supplier_id AND s.workspace_id=c.workspace_id
    JOIN tprm_modules m ON m.id=c.module_id AND m.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND c.supplier_id=? AND c.id=?`).get(workspaceId, supplierId, cycleId);
  if (!row) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle not found for this third party.', 404);
  if (row.module_status !== 'active') fail('TPRM_MODULE_INACTIVE', 'The Third-party risk module is not active for recommendation work.', 409);
  if (row.status !== 'active') fail('TPRM_CYCLE_FROZEN', 'The assessment cycle is no longer accepting recommendation work.', 409);
  return row;
}

function scopedDraft(db, workspaceIdInput, supplierIdInput, draftIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const draftId = positiveId(draftIdInput, 'draftId');
  const draft = db.prepare(`SELECT d.*,author.name AS author_name,reviewer.name AS reviewer_name
    FROM tprm_recommendation_drafts d
    JOIN users author ON author.id=d.author_id
    LEFT JOIN users reviewer ON reviewer.id=d.reviewer_id
    WHERE d.workspace_id=? AND d.supplier_id=? AND d.id=?`).get(workspaceId, supplierId, draftId);
  if (!draft) fail('TPRM_RECOMMENDATION_DRAFT_NOT_FOUND', 'Recommendation draft not found for this third party.', 404);
  return draft;
}

function parseConditions(value) {
  let input = value;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); }
    catch (_) { fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', 'Recommendation conditions must be a valid list.', 400); }
  }
  if (input == null) input = [];
  if (!Array.isArray(input)) fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', 'Recommendation conditions must be a list.', 400);
  if (input.length > 100) fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', 'A recommendation cannot contain more than 100 conditions.', 400);
  return input.map((condition, index) => {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
      fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', `Condition ${index + 1} is invalid.`, 400);
    }
    const findingId = condition.findingId ?? condition.finding_id ?? null;
    const normalized = {
      findingId: findingId === '' || findingId == null ? null : positiveId(findingId, `conditions[${index}].findingId`),
      conditionType: cleanText(condition.conditionType ?? condition.condition_type),
      title: requiredText(condition.title, `Condition ${index + 1} title`, 3, 240),
      description: requiredText(condition.description, `Condition ${index + 1} description`, 10, 2000),
      severity: cleanText(condition.severity || 'moderate'),
      ownerType: cleanText(condition.ownerType ?? condition.owner_type),
      ownerUserId: condition.ownerUserId ?? condition.owner_user_id ?? null,
      ownerName: requiredText(condition.ownerName ?? condition.owner_name, `Condition ${index + 1} owner`, 2, 160),
      dueDate: cleanText(condition.dueDate ?? condition.due_date) || null,
      verificationCriteria: requiredText(condition.verificationCriteria ?? condition.verification_criteria, `Condition ${index + 1} verification criteria`, 5, 2000),
    };
    if (normalized.ownerUserId === '') normalized.ownerUserId = null;
    if (normalized.ownerUserId != null) normalized.ownerUserId = positiveId(normalized.ownerUserId, `conditions[${index}].ownerUserId`);
    if (!['remediation', 'control', 'contract', 'evidence', 'monitoring', 'risk_acceptance', 'other'].includes(normalized.conditionType)) {
      fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', `Condition ${index + 1} type is invalid.`, 400);
    }
    if (!['low', 'moderate', 'high', 'critical'].includes(normalized.severity)) {
      fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', `Condition ${index + 1} severity is invalid.`, 400);
    }
    if (!['client', 'third_party', 'consultancy'].includes(normalized.ownerType)) {
      fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', `Condition ${index + 1} owner type is invalid.`, 400);
    }
    if (!normalized.dueDate || !tprmDomain.validIsoDate(normalized.dueDate)) {
      fail('TPRM_RECOMMENDATION_CONDITIONS_INVALID', `Condition ${index + 1} requires a valid due date.`, 400);
    }
    return normalized;
  });
}

function normalizeRevision(input) {
  const outcome = cleanText(input.outcome);
  if (!OUTCOMES.has(outcome)) fail('TPRM_RECOMMENDATION_OUTCOME_INVALID', 'Recommendation outcome is invalid.', 400);
  const residualRiskBand = cleanText(input.residualRiskBand ?? input.residual_risk_band) || 'unknown';
  if (!RISK_BANDS.has(residualRiskBand)) fail('TPRM_RESIDUAL_RISK_INVALID', 'Residual-risk band is invalid.', 400);
  const scoreValue = input.residualRiskScore ?? input.residual_risk_score;
  const residualRiskScore = scoreValue === '' || scoreValue == null ? null : Number(scoreValue);
  if (residualRiskScore != null && (!Number.isInteger(residualRiskScore) || residualRiskScore < 0 || residualRiskScore > 100)) {
    fail('TPRM_RESIDUAL_RISK_INVALID', 'Residual-risk score must be an integer from 0 to 100.', 400);
  }
  const validUntil = cleanText(input.validUntil ?? input.valid_until) || null;
  if (validUntil && !tprmDomain.validIsoDate(validUntil)) fail('TPRM_RECOMMENDATION_VALIDITY_INVALID', 'Recommendation validity date is invalid.', 400);
  const conditions = parseConditions(input.conditions);
  if (outcome === 'recommend_with_conditions' && !conditions.length) {
    fail('TPRM_CONDITIONS_REQUIRED', 'A conditional recommendation requires at least one structured condition.', 400);
  }
  if (outcome !== 'recommend_with_conditions' && conditions.length) {
    fail('TPRM_CONDITIONS_NOT_APPLICABLE', 'Structured conditions apply only to a conditional recommendation.', 400);
  }
  return {
    outcome,
    executiveSummary: requiredText(input.executiveSummary ?? input.executive_summary, 'Executive summary', 20, 4000),
    rationale: requiredText(input.rationale, 'Recommendation rationale', 20, 8000),
    residualRiskScore,
    residualRiskBand,
    validUntil,
    conditions,
  };
}

function revisionHashPayload(draft, revisionNumber, revision, createdBy) {
  return {
    workspaceId: draft.workspace_id,
    supplierId: draft.supplier_id,
    cycleId: draft.cycle_id,
    draftId: draft.id,
    revisionNumber,
    outcome: revision.outcome,
    executiveSummary: revision.executiveSummary,
    rationale: revision.rationale,
    residualRiskScore: revision.residualRiskScore,
    residualRiskBand: revision.residualRiskBand,
    validUntil: revision.validUntil,
    conditions: revision.conditions,
    createdBy,
  };
}

function decodeRevision(row) {
  if (!row) return null;
  let conditions;
  try { conditions = JSON.parse(row.conditions_json); }
  catch (_) { fail('TPRM_RECOMMENDATION_INTEGRITY_FAILURE', 'Stored recommendation conditions are invalid.', 500); }
  return {
    ...row,
    executiveSummary: row.executive_summary,
    residualRiskScore: row.residual_risk_score,
    residualRiskBand: row.residual_risk_band,
    validUntil: row.valid_until,
    conditions,
  };
}

function assertRevisionIntegrity(draft, row) {
  const decoded = decodeRevision(row);
  const calculated = sha256(revisionHashPayload(draft, row.revision_number, decoded, row.created_by));
  if (calculated !== row.revision_hash) {
    fail('TPRM_RECOMMENDATION_INTEGRITY_FAILURE', 'The submitted recommendation revision failed its integrity check.', 500);
  }
  return decoded;
}

function eventReplay(db, workspaceId, key, fingerprint) {
  const event = db.prepare('SELECT * FROM tprm_recommendation_draft_events WHERE idempotency_key=?').get(key);
  if (!event) return null;
  if (event.workspace_id !== workspaceId || event.request_fingerprint !== fingerprint) {
    fail('TPRM_IDEMPOTENCY_CONFLICT', 'This recommendation action token was already used for different content.', 409);
  }
  return event;
}

function appendEvent(db, input) {
  const previous = db.prepare(`SELECT event_hash FROM tprm_recommendation_draft_events
    WHERE draft_id=? ORDER BY id DESC LIMIT 1`).get(input.draftId);
  const occurredAt = utcNow();
  const eventPayload = {
    workspaceId: input.workspaceId,
    supplierId: input.supplierId,
    cycleId: input.cycleId,
    draftId: input.draftId,
    action: input.action,
    fromStatus: input.fromStatus || null,
    toStatus: input.toStatus || null,
    revisionNumber: input.revisionNumber || null,
    note: input.note || null,
    actorId: input.actorId,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    previousEventHash: previous?.event_hash || null,
    occurredAt,
  };
  const eventHash = sha256(eventPayload);
  const id = Number(db.prepare(`INSERT INTO tprm_recommendation_draft_events
    (workspace_id,supplier_id,cycle_id,draft_id,action,from_status,to_status,revision_number,
     note,actor_id,request_fingerprint,idempotency_key,previous_event_hash,event_hash,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.workspaceId, input.supplierId, input.cycleId, input.draftId, input.action,
      input.fromStatus || null, input.toStatus || null, input.revisionNumber || null,
      input.note || null, input.actorId, input.requestFingerprint, input.idempotencyKey,
      previous?.event_hash || null, eventHash, occurredAt
    ).lastInsertRowid);
  return db.prepare('SELECT * FROM tprm_recommendation_draft_events WHERE id=?').get(id);
}

function workflowBundle(db, draft) {
  const revisions = db.prepare(`SELECT r.*,u.name AS created_by_name
    FROM tprm_recommendation_draft_revisions r JOIN users u ON u.id=r.created_by
    WHERE r.workspace_id=? AND r.supplier_id=? AND r.draft_id=? ORDER BY r.revision_number DESC`).all(
      draft.workspace_id, draft.supplier_id, draft.id
    ).map(decodeRevision);
  const events = db.prepare(`SELECT e.*,u.name AS actor_name
    FROM tprm_recommendation_draft_events e JOIN users u ON u.id=e.actor_id
    WHERE e.workspace_id=? AND e.supplier_id=? AND e.draft_id=? ORDER BY e.id`).all(
      draft.workspace_id, draft.supplier_id, draft.id
    );
  return { draft: scopedDraft(db, draft.workspace_id, draft.supplier_id, draft.id), currentRevision: revisions[0] || null, revisions, events };
}

function currentDraft(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = input.cycleId == null ? null : positiveId(input.cycleId, 'cycleId');
  firmViewer(db, workspaceId, input.actorId);
  const draft = db.prepare(`SELECT d.*,author.name AS author_name,reviewer.name AS reviewer_name
    FROM tprm_recommendation_drafts d JOIN users author ON author.id=d.author_id
    LEFT JOIN users reviewer ON reviewer.id=d.reviewer_id
    WHERE d.workspace_id=? AND d.supplier_id=? AND d.status NOT IN ('issued','withdrawn')
      AND (? IS NULL OR d.cycle_id=?)
    ORDER BY d.id DESC LIMIT 1`).get(workspaceId, supplierId, cycleId, cycleId);
  return draft ? workflowBundle(db, draft) : null;
}

function draftById(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  firmViewer(db, workspaceId, input.actorId);
  return workflowBundle(db, scopedDraft(db, workspaceId, supplierId, input.draftId));
}

function createDraft(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const { actor } = firmActor(db, workspaceId, input.actorId, 'tprm.recommendation.draft');
  const key = idempotencyKey(input.idempotencyKey);
  const fingerprint = sha256({ action: 'created', workspaceId, supplierId, cycleId, actorId: actor.id, key });
  const replay = eventReplay(db, workspaceId, key, fingerprint);
  if (replay) return { ...workflowBundle(db, scopedDraft(db, workspaceId, supplierId, replay.draft_id)), replayed: true };
  scopedSupplierAndCycle(db, workspaceId, supplierId, cycleId);
  return db.transaction(() => {
    const existing = db.prepare(`SELECT id FROM tprm_recommendation_drafts
      WHERE workspace_id=? AND supplier_id=? AND cycle_id=? AND status NOT IN ('issued','withdrawn')`).get(workspaceId, supplierId, cycleId);
    if (existing) fail('TPRM_RECOMMENDATION_DRAFT_EXISTS', 'An active recommendation draft already exists for this assessment cycle.', 409);
    const id = Number(db.prepare(`INSERT INTO tprm_recommendation_drafts
      (workspace_id,supplier_id,cycle_id,author_id) VALUES (?,?,?,?)`).run(
        workspaceId, supplierId, cycleId, actor.id
      ).lastInsertRowid);
    appendEvent(db, {
      workspaceId, supplierId, cycleId, draftId: id, action: 'created',
      fromStatus: null, toStatus: 'draft', actorId: actor.id,
      requestFingerprint: fingerprint, idempotencyKey: key,
    });
    return { ...workflowBundle(db, scopedDraft(db, workspaceId, supplierId, id)), replayed: false };
  }).immediate();
}

function saveRevision(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const { actor } = firmActor(db, workspaceId, input.actorId, 'tprm.recommendation.draft');
  const draft = scopedDraft(db, workspaceId, supplierId, input.draftId);
  if (draft.author_id !== actor.id) fail('TPRM_RECOMMENDATION_AUTHOR_ONLY', 'Only the assigned recommendation author can save a revision.', 403);
  const expectedRowVersion = nonNegativeInteger(input.expectedRowVersion, 'expectedRowVersion');
  const expectedRevisionNumber = nonNegativeInteger(input.expectedRevisionNumber, 'expectedRevisionNumber');
  const revision = normalizeRevision(input);
  const key = idempotencyKey(input.idempotencyKey);
  const fingerprint = sha256({
    action: 'revision_saved', workspaceId, supplierId, draftId: draft.id, actorId: actor.id,
    expectedRowVersion, expectedRevisionNumber, revision, key,
  });
  const replay = eventReplay(db, workspaceId, key, fingerprint);
  if (replay) return { ...workflowBundle(db, draft), replayed: true };
  return db.transaction(() => {
    const current = scopedDraft(db, workspaceId, supplierId, draft.id);
    if (!EDITABLE_STATUSES.has(current.status)) fail('TPRM_RECOMMENDATION_DRAFT_FROZEN', 'This recommendation draft is not editable.', 409);
    if (current.row_version !== expectedRowVersion || current.current_revision_number !== expectedRevisionNumber) {
      fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The recommendation draft changed; reload before saving another revision.', 409);
    }
    scopedSupplierAndCycle(db, workspaceId, supplierId, current.cycle_id);
    const revisionNumber = current.current_revision_number + 1;
    const revisionHash = sha256(revisionHashPayload(current, revisionNumber, revision, actor.id));
    db.prepare(`INSERT INTO tprm_recommendation_draft_revisions
      (workspace_id,supplier_id,cycle_id,draft_id,revision_number,outcome,executive_summary,rationale,
       residual_risk_score,residual_risk_band,valid_until,conditions_json,revision_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, supplierId, current.cycle_id, current.id, revisionNumber, revision.outcome,
        revision.executiveSummary, revision.rationale, revision.residualRiskScore,
        revision.residualRiskBand, revision.validUntil, tprmDomain.stableStringify(revision.conditions),
        revisionHash, actor.id
      );
    const changed = db.prepare(`UPDATE tprm_recommendation_drafts
      SET current_revision_number=?,row_version=row_version+1,updated_at=?
      WHERE id=? AND workspace_id=? AND supplier_id=? AND row_version=? AND status IN ('draft','changes_requested')`).run(
        revisionNumber, utcNow(), current.id, workspaceId, supplierId, expectedRowVersion
      );
    if (changed.changes !== 1) fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The recommendation draft changed; reload before saving another revision.', 409);
    appendEvent(db, {
      workspaceId, supplierId, cycleId: current.cycle_id, draftId: current.id,
      action: 'revision_saved', fromStatus: current.status, toStatus: current.status,
      revisionNumber, actorId: actor.id, requestFingerprint: fingerprint, idempotencyKey: key,
    });
    return { ...workflowBundle(db, current), replayed: false };
  }).immediate();
}

function submitForReview(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const { actor } = firmActor(db, workspaceId, input.actorId, 'tprm.recommendation.draft');
  const draft = scopedDraft(db, workspaceId, supplierId, input.draftId);
  if (draft.author_id !== actor.id) fail('TPRM_RECOMMENDATION_AUTHOR_ONLY', 'Only the assigned recommendation author can submit it for quality review.', 403);
  const reviewerId = positiveId(input.reviewerId, 'reviewerId');
  const { actor: reviewer } = firmActor(db, workspaceId, reviewerId, 'tprm.recommendation.issue');
  if (reviewer.id === actor.id) fail('TPRM_MAKER_CHECKER_REQUIRED', 'Recommendation author and quality reviewer must be different people.', 409);
  const expectedRowVersion = nonNegativeInteger(input.expectedRowVersion, 'expectedRowVersion');
  const expectedRevisionNumber = positiveId(input.expectedRevisionNumber, 'expectedRevisionNumber');
  const key = idempotencyKey(input.idempotencyKey);
  const fingerprint = sha256({ action: 'submitted', workspaceId, supplierId, draftId: draft.id, actorId: actor.id, reviewerId, expectedRowVersion, expectedRevisionNumber, key });
  const replay = eventReplay(db, workspaceId, key, fingerprint);
  if (replay) return { ...workflowBundle(db, draft), replayed: true };
  return db.transaction(() => {
    const current = scopedDraft(db, workspaceId, supplierId, draft.id);
    if (!EDITABLE_STATUSES.has(current.status)) fail('TPRM_RECOMMENDATION_DRAFT_FROZEN', 'This recommendation draft is not awaiting author submission.', 409);
    if (current.row_version !== expectedRowVersion || current.current_revision_number !== expectedRevisionNumber) {
      fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The recommendation draft changed; reload before submitting it.', 409);
    }
    const submitted = db.prepare(`SELECT * FROM tprm_recommendation_draft_revisions
      WHERE draft_id=? AND revision_number=?`).get(current.id, expectedRevisionNumber);
    if (!submitted) fail('TPRM_RECOMMENDATION_REVISION_NOT_FOUND', 'Save a recommendation revision before submitting it.', 409);
    assertRevisionIntegrity(current, submitted);
    scopedSupplierAndCycle(db, workspaceId, supplierId, current.cycle_id);
    const now = utcNow();
    const changed = db.prepare(`UPDATE tprm_recommendation_drafts
      SET status='in_review',reviewer_id=?,submitted_revision_number=?,submitted_at=?,
          changes_requested_note=NULL,row_version=row_version+1,updated_at=?
      WHERE id=? AND workspace_id=? AND supplier_id=? AND row_version=? AND status IN ('draft','changes_requested')`).run(
        reviewer.id, expectedRevisionNumber, now, now, current.id, workspaceId, supplierId, expectedRowVersion
      );
    if (changed.changes !== 1) fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The recommendation draft changed; reload before submitting it.', 409);
    appendEvent(db, {
      workspaceId, supplierId, cycleId: current.cycle_id, draftId: current.id,
      action: 'submitted', fromStatus: current.status, toStatus: 'in_review', revisionNumber: expectedRevisionNumber,
      actorId: actor.id, requestFingerprint: fingerprint, idempotencyKey: key,
    });
    return { ...workflowBundle(db, current), replayed: false };
  }).immediate();
}

function requestChanges(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const { actor } = firmActor(db, workspaceId, input.actorId, 'tprm.recommendation.issue');
  const draft = scopedDraft(db, workspaceId, supplierId, input.draftId);
  if (draft.reviewer_id !== actor.id) fail('TPRM_RECOMMENDATION_REVIEWER_ONLY', 'Only the assigned quality reviewer can request changes.', 403);
  const expectedRowVersion = nonNegativeInteger(input.expectedRowVersion, 'expectedRowVersion');
  const expectedRevisionNumber = positiveId(input.expectedRevisionNumber, 'expectedRevisionNumber');
  const note = requiredText(input.note, 'Change-request rationale', 10, 4000);
  const key = idempotencyKey(input.idempotencyKey);
  const fingerprint = sha256({ action: 'changes_requested', workspaceId, supplierId, draftId: draft.id, actorId: actor.id, expectedRowVersion, expectedRevisionNumber, note, key });
  const replay = eventReplay(db, workspaceId, key, fingerprint);
  if (replay) return { ...workflowBundle(db, draft), replayed: true };
  return db.transaction(() => {
    const current = scopedDraft(db, workspaceId, supplierId, draft.id);
    if (current.status !== 'in_review') fail('TPRM_RECOMMENDATION_NOT_IN_REVIEW', 'This recommendation is not awaiting quality review.', 409);
    if (current.row_version !== expectedRowVersion || current.submitted_revision_number !== expectedRevisionNumber) {
      fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The submitted recommendation changed; reload before completing review.', 409);
    }
    const now = utcNow();
    const changed = db.prepare(`UPDATE tprm_recommendation_drafts
      SET status='changes_requested',changes_requested_note=?,row_version=row_version+1,updated_at=?
      WHERE id=? AND workspace_id=? AND supplier_id=? AND row_version=? AND status='in_review'`).run(
        note, now, current.id, workspaceId, supplierId, expectedRowVersion
      );
    if (changed.changes !== 1) fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The submitted recommendation changed; reload before completing review.', 409);
    appendEvent(db, {
      workspaceId, supplierId, cycleId: current.cycle_id, draftId: current.id,
      action: 'changes_requested', fromStatus: 'in_review', toStatus: 'changes_requested', revisionNumber: expectedRevisionNumber,
      note, actorId: actor.id, requestFingerprint: fingerprint, idempotencyKey: key,
    });
    return { ...workflowBundle(db, current), replayed: false };
  }).immediate();
}

function issue(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const { actor } = firmActor(db, workspaceId, input.actorId, 'tprm.recommendation.issue');
  const draft = scopedDraft(db, workspaceId, supplierId, input.draftId);
  if (draft.reviewer_id !== actor.id) fail('TPRM_RECOMMENDATION_REVIEWER_ONLY', 'Only the assigned quality reviewer can issue this recommendation.', 403);
  const expectedRowVersion = nonNegativeInteger(input.expectedRowVersion, 'expectedRowVersion');
  const expectedRevisionNumber = positiveId(input.expectedRevisionNumber, 'expectedRevisionNumber');
  if (!Object.prototype.hasOwnProperty.call(input, 'expectedCurrentRecommendationId')) {
    fail('TPRM_RECOMMENDATION_EXPECTATION_REQUIRED', 'The expected issued-recommendation version is required.', 400);
  }
  const expectedCurrentRecommendation = expectedRecommendationId(input.expectedCurrentRecommendationId);
  const qualityReviewRationale = requiredText(input.qualityReviewRationale, 'Quality-review rationale', 10, 4000);
  const key = idempotencyKey(input.idempotencyKey);
  const fingerprint = sha256({
    action: 'issued', workspaceId, supplierId, draftId: draft.id, actorId: actor.id,
    expectedRowVersion, expectedRevisionNumber, expectedCurrentRecommendation, qualityReviewRationale, key,
  });
  const replay = eventReplay(db, workspaceId, key, fingerprint);
  if (replay) {
    const bundle = workflowBundle(db, draft);
    return { ...bundle, recommendation: db.prepare('SELECT * FROM tprm_recommendations WHERE id=?').get(bundle.draft.issued_recommendation_id), replayed: true };
  }
  return db.transaction(() => {
    const current = scopedDraft(db, workspaceId, supplierId, draft.id);
    if (current.status !== 'in_review') fail('TPRM_RECOMMENDATION_NOT_IN_REVIEW', 'This recommendation is not awaiting quality review.', 409);
    if (current.row_version !== expectedRowVersion || current.submitted_revision_number !== expectedRevisionNumber
        || current.current_revision_number !== expectedRevisionNumber) {
      fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The submitted recommendation changed; reload before issuing it.', 409);
    }
    const storedRevision = db.prepare(`SELECT * FROM tprm_recommendation_draft_revisions
      WHERE draft_id=? AND revision_number=?`).get(current.id, expectedRevisionNumber);
    if (!storedRevision) fail('TPRM_RECOMMENDATION_REVISION_NOT_FOUND', 'The exact submitted recommendation revision was not found.', 409);
    const revision = assertRevisionIntegrity(current, storedRevision);
    scopedSupplierAndCycle(db, workspaceId, supplierId, current.cycle_id);
    const issued = tprmDomain.issueRecommendation(db, {
      workspaceId, supplierId, cycleId: current.cycle_id,
      outcome: revision.outcome,
      executiveSummary: revision.executiveSummary,
      rationale: revision.rationale,
      residualRiskScore: revision.residualRiskScore,
      residualRiskBand: revision.residualRiskBand,
      validUntil: revision.validUntil,
      conditions: revision.conditions,
      authorId: current.author_id,
      reviewerId: actor.id,
      qualityReviewRationale,
      expectedCurrentRecommendationId: expectedCurrentRecommendation,
      idempotencyKey: sha256({ scope: 'tprm-recommendation-issue', key }),
    });
    const now = utcNow();
    const changed = db.prepare(`UPDATE tprm_recommendation_drafts
      SET status='issued',issued_recommendation_id=?,issued_at=?,row_version=row_version+1,updated_at=?
      WHERE id=? AND workspace_id=? AND supplier_id=? AND row_version=? AND status='in_review'`).run(
        issued.recommendation.id, now, now, current.id, workspaceId, supplierId, expectedRowVersion
      );
    if (changed.changes !== 1) fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The submitted recommendation changed; reload before issuing it.', 409);
    appendEvent(db, {
      workspaceId, supplierId, cycleId: current.cycle_id, draftId: current.id,
      action: 'issued', fromStatus: 'in_review', toStatus: 'issued', revisionNumber: expectedRevisionNumber,
      note: qualityReviewRationale, actorId: actor.id, requestFingerprint: fingerprint, idempotencyKey: key,
    });
    return { ...workflowBundle(db, current), recommendation: issued.recommendation, conditions: issued.conditions, replayed: false };
  }).immediate();
}

function withdraw(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const draft = scopedDraft(db, workspaceId, supplierId, input.draftId);
  const permission = draft.status === 'in_review' ? 'tprm.recommendation.issue' : 'tprm.recommendation.draft';
  const { actor } = firmActor(db, workspaceId, input.actorId, permission);
  const authorized = draft.status === 'in_review' ? draft.reviewer_id === actor.id : draft.author_id === actor.id;
  if (!authorized) fail('TPRM_RECOMMENDATION_ACTOR_MISMATCH', 'Only the accountable author or assigned reviewer can withdraw this draft.', 403);
  const expectedRowVersion = nonNegativeInteger(input.expectedRowVersion, 'expectedRowVersion');
  const reason = requiredText(input.reason, 'Withdrawal reason', 10, 2000);
  const key = idempotencyKey(input.idempotencyKey);
  const fingerprint = sha256({ action: 'withdrawn', workspaceId, supplierId, draftId: draft.id, actorId: actor.id, expectedRowVersion, reason, key });
  const replay = eventReplay(db, workspaceId, key, fingerprint);
  if (replay) return { ...workflowBundle(db, draft), replayed: true };
  return db.transaction(() => {
    const current = scopedDraft(db, workspaceId, supplierId, draft.id);
    if (!['draft', 'changes_requested', 'in_review'].includes(current.status)) fail('TPRM_RECOMMENDATION_DRAFT_FROZEN', 'This recommendation draft cannot be withdrawn.', 409);
    if (current.row_version !== expectedRowVersion) fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The recommendation draft changed; reload before withdrawing it.', 409);
    const now = utcNow();
    const changed = db.prepare(`UPDATE tprm_recommendation_drafts
      SET status='withdrawn',withdrawn_at=?,withdrawal_reason=?,row_version=row_version+1,updated_at=?
      WHERE id=? AND workspace_id=? AND supplier_id=? AND row_version=?`).run(
        now, reason, now, current.id, workspaceId, supplierId, expectedRowVersion
      );
    if (changed.changes !== 1) fail('TPRM_RECOMMENDATION_STALE_DRAFT', 'The recommendation draft changed; reload before withdrawing it.', 409);
    appendEvent(db, {
      workspaceId, supplierId, cycleId: current.cycle_id, draftId: current.id,
      action: 'withdrawn', fromStatus: current.status, toStatus: 'withdrawn',
      revisionNumber: current.current_revision_number || null, note: reason,
      actorId: actor.id, requestFingerprint: fingerprint, idempotencyKey: key,
    });
    return { ...workflowBundle(db, current), replayed: false };
  }).immediate();
}

function guardRecommendationMutation(operation) {
  return serviceCapabilities.withCapability(
    serviceCapabilities.CAPABILITIES.RECOMMENDATION, operation
  );
}

module.exports = {
  TprmRecommendationWorkflowError,
  currentDraft,
  draftById,
  createDraft: guardRecommendationMutation(createDraft),
  saveRevision: guardRecommendationMutation(saveRevision),
  submitForReview: guardRecommendationMutation(submitForReview),
  requestChanges: guardRecommendationMutation(requestChanges),
  issue: guardRecommendationMutation(issue),
  withdraw: guardRecommendationMutation(withdraw),
  normalizeRevision,
  assertRevisionIntegrity,
  serviceCapabilities,
};
