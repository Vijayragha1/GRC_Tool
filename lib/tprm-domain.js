'use strict';

const crypto = require('crypto');
const defaultMethodology = require('../data/supplier-methodology-v2026.1.json');
const enc = require('./encryption');
const serviceCapabilities = require('./tprm-capabilities');

const SERVICE_MODELS = Object.freeze(['assessment_only', 'programme_setup', 'managed_lifecycle']);
const MODULE_STATUSES = Object.freeze(['active', 'needs_classification', 'closed']);
const CYCLE_TYPES = Object.freeze(['onboarding', 'periodic', 'triggered']);
const CYCLE_STATUSES = Object.freeze(['active', 'completed', 'cancelled']);
const LIFECYCLE_STAGES = Object.freeze([
  'module_setup', 'intake', 'inherent_risk', 'due_diligence', 'contract_assurance',
  'consultancy_review', 'quality_review', 'client_decision', 'monitoring', 'deferred',
  'rejected', 'offboarding', 'closed',
]);
const RECOMMENDATION_OUTCOMES = Object.freeze([
  'recommend_onboard', 'recommend_with_conditions', 'do_not_recommend', 'insufficient_information',
]);
const CLIENT_DECISIONS = Object.freeze([
  'onboard', 'onboard_with_conditions', 'do_not_onboard', 'defer_request_information',
]);
const CONDITION_TYPES = Object.freeze([
  'remediation', 'control', 'contract', 'evidence', 'monitoring', 'risk_acceptance', 'other',
]);
const CONDITION_STATUSES = Object.freeze([
  'open', 'in_progress', 'evidence_submitted', 'verified', 'waived', 'cancelled',
]);
const CONDITION_EVENT_TYPES = Object.freeze([
  'work_started', 'evidence_submitted', 'changes_requested', 'verified', 'waived',
]);
const ACTOR_TYPES = Object.freeze([
  'consultant', 'consultancy_manager', 'client', 'external_provider', 'system', 'migration',
]);
const EVENT_TYPES = Object.freeze([
  'module_enabled', 'module_classified', 'module_closed', 'cycle_started', 'cycle_cancelled',
  'artifact_linked', 'evidence_released', 'evidence_release_withdrawn', 'decision_authority_assigned', 'stage_transition', 'recommendation_issued', 'client_decision_recorded',
  'condition_completed', 'clarification_requested', 'clarification_responded', 'clarification_resolved',
  'monitoring_signal_recorded', 'monitoring_signal_triaged', 'reassessment_scheduled', 'legacy_history_linked',
]);

const POSITIVE_CLIENT_DECISIONS = new Set(['onboard', 'onboard_with_conditions']);
const POSITIVE_RECOMMENDATIONS = new Set(['recommend_onboard', 'recommend_with_conditions']);
const FINAL_CLIENT_DECISIONS = new Set(['onboard', 'onboard_with_conditions', 'do_not_onboard']);

function conditionWaiverExpired(condition, asOfDate = utcNow().slice(0, 10)) {
  return Boolean(condition && condition.status === 'waived'
    && condition.waiver_expires_at && condition.waiver_expires_at < asOfDate);
}

function conditionEffectiveStatus(condition, asOfDate = utcNow().slice(0, 10)) {
  return conditionWaiverExpired(condition, asOfDate) ? 'waiver_expired' : condition && condition.status;
}

function isConditionOperative(condition, asOfDate = utcNow().slice(0, 10)) {
  return ['open', 'in_progress', 'evidence_submitted', 'waiver_expired']
    .includes(conditionEffectiveStatus(condition, asOfDate));
}

function conditionProjection(condition, asOfDate = utcNow().slice(0, 10)) {
  const effectiveStatus = conditionEffectiveStatus(condition, asOfDate);
  return {
    ...condition,
    stored_status: condition.status,
    effective_status: effectiveStatus,
    waiver_expired: effectiveStatus === 'waiver_expired',
  };
}
const ALLOWED_TRANSITIONS = Object.freeze({
  module_setup: new Set(['intake']),
  intake: new Set(['inherent_risk', 'offboarding', 'closed']),
  inherent_risk: new Set(['intake', 'due_diligence', 'offboarding']),
  due_diligence: new Set(['contract_assurance', 'consultancy_review', 'offboarding']),
  contract_assurance: new Set(['due_diligence', 'consultancy_review', 'offboarding']),
  consultancy_review: new Set(['due_diligence', 'quality_review', 'offboarding']),
  quality_review: new Set(['consultancy_review', 'client_decision', 'offboarding']),
  client_decision: new Set(['monitoring', 'deferred', 'rejected', 'offboarding']),
  deferred: new Set(['due_diligence', 'client_decision', 'offboarding']),
  monitoring: new Set(['intake', 'offboarding', 'closed']),
  rejected: new Set(['intake', 'offboarding', 'closed']),
  offboarding: new Set(['closed']),
  closed: new Set(),
});

class TprmDomainError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = 'TprmDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 409, details = null) {
  throw new TprmDomainError(code, message, status, details);
}

function utcNow() {
  return new Date().toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function requiredText(value, field, minimum = 1) {
  const text = cleanText(value);
  if (text.length < minimum) fail('TPRM_VALIDATION', `${field} must contain at least ${minimum} characters.`, 400);
  return text;
}

function optionalText(value) {
  const text = cleanText(value);
  return text || null;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) fail('TPRM_VALIDATION', `${field} is invalid.`, 400);
  return id;
}

function validIsoDate(value) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function optionalIsoDate(value, field) {
  const text = optionalText(value);
  if (text && !validIsoDate(text)) fail('TPRM_VALIDATION', `${field} must be a valid ISO date.`, 400);
  return text;
}

function validIdempotency(value) {
  const text = optionalText(value);
  if (text && (text.length < 32 || text.length > 128 || text !== cleanText(value))) {
    fail('TPRM_IDEMPOTENCY_KEY_INVALID', 'Idempotency key must contain 32 to 128 trimmed characters.', 400);
  }
  return text;
}

function expectedId(value) {
  if (value == null || value === '' || value === 'none' || value === '0' || value === 0) return null;
  return positiveId(value, 'expectedCurrentId');
}

function tableRow(db, table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) || null;
}

function workspaceRow(db, workspaceId) {
  const id = positiveId(workspaceId, 'workspaceId');
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  if (!row) fail('TPRM_WORKSPACE_NOT_FOUND', 'Client workspace not found.', 404);
  return row;
}

function supplierRow(db, workspaceId, supplierId) {
  const row = db.prepare('SELECT * FROM suppliers WHERE workspace_id=? AND id=?').get(
    positiveId(workspaceId, 'workspaceId'), positiveId(supplierId, 'supplierId')
  );
  if (!row) fail('TPRM_THIRD_PARTY_NOT_FOUND', 'Third party not found in this client workspace.', 404);
  return row;
}

function firmActor(db, workspaceId, actorId) {
  const row = db.prepare(`SELECT u.*,w.firm_id AS workspace_firm_id
    FROM users u JOIN workspaces w ON w.id=?
    WHERE u.id=? AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(actorId, 'actorId')
    );
  if (!row) fail('TPRM_FIRM_ACTOR_REQUIRED', 'An active consultancy user for this client is required.', 403);
  return row;
}

function clientActor(db, workspaceId, actorId) {
  const row = db.prepare(`SELECT u.*,wm.role AS workspace_role
    FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
    WHERE u.id=? AND u.user_type='client' AND u.active=1`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(actorId, 'actorId')
    );
  if (!row) fail('TPRM_CLIENT_AUTHORITY_REQUIRED', 'An active client decision-maker in this workspace is required.', 403);
  return row;
}

function portalViewer(db, workspaceId, actorId) {
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(positiveId(actorId, 'actorId'));
  if (!user) fail('TPRM_PORTAL_VIEWER_REQUIRED', 'An active portal viewer is required.', 403);
  if (user.user_type === 'client') return { actor: clientActor(db, workspaceId, user.id), isClient: true, isFirmPreview: false };
  if (user.user_type === 'firm') return { actor: firmActor(db, workspaceId, user.id), isClient: false, isFirmPreview: true };
  fail('TPRM_PORTAL_VIEWER_REQUIRED', 'This user cannot view the client TPRM portal.', 403);
}

function actorForEvent(db, workspaceId, input = {}) {
  const actorType = input.actorType || 'consultant';
  if (!ACTOR_TYPES.includes(actorType)) fail('TPRM_ACTOR_TYPE_INVALID', 'Lifecycle actor type is invalid.', 400);
  if (actorType === 'system' || actorType === 'migration' || actorType === 'external_provider') {
    return {
      id: input.actorId ? positiveId(input.actorId, 'actorId') : null,
      name: requiredText(input.actorName || (actorType === 'system' ? 'Nimbus system' : actorType === 'migration' ? 'Nimbus migration' : 'External provider'), 'actorName'),
      type: actorType,
    };
  }
  if (actorType === 'client') {
    const actor = clientActor(db, workspaceId, input.actorId);
    return { id: actor.id, name: actor.name, type: actorType, row: actor };
  }
  const actor = firmActor(db, workspaceId, input.actorId);
  const type = actorType === 'consultancy_manager' || actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant';
  return { id: actor.id, name: actor.name, type, row: actor };
}

function assertMakerChecker(db, { workspaceId, makerId, checkerId }) {
  const maker = firmActor(db, workspaceId, makerId);
  const checker = firmActor(db, workspaceId, checkerId);
  if (maker.id === checker.id) {
    fail('TPRM_MAKER_CHECKER_REQUIRED', 'Recommendation author and quality reviewer must be different people.', 409);
  }
  return { maker, checker };
}

function moduleForWorkspace(db, workspaceId, options = {}) {
  const id = positiveId(workspaceId, 'workspaceId');
  const open = db.prepare(`SELECT * FROM tprm_modules
    WHERE workspace_id=? AND status IN ('active','needs_classification')
    ORDER BY id DESC LIMIT 1`).get(id);
  const row = open || (options.includeClosed
    ? db.prepare('SELECT * FROM tprm_modules WHERE workspace_id=? ORDER BY id DESC LIMIT 1').get(id)
    : null);
  return row ? {
    ...row,
    serviceModel: row.service_model,
    enabled: row.status === 'active',
    needsClassification: row.status === 'needs_classification',
  } : null;
}

function isEnabled(db, workspaceId) {
  return Boolean(db.prepare("SELECT 1 FROM tprm_modules WHERE workspace_id=? AND status='active'").get(
    positiveId(workspaceId, 'workspaceId')
  ));
}

function currentCycle(db, workspaceId, supplierId) {
  return db.prepare(`SELECT * FROM tprm_assessment_cycles
    WHERE workspace_id=? AND supplier_id=? AND status='active'
    ORDER BY cycle_number DESC LIMIT 1`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(supplierId, 'supplierId')
    ) || null;
}

function latestCycle(db, workspaceId, supplierId) {
  return db.prepare(`SELECT * FROM tprm_assessment_cycles
    WHERE workspace_id=? AND supplier_id=?
    ORDER BY cycle_number DESC,id DESC LIMIT 1`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(supplierId, 'supplierId')
    ) || null;
}

function currentRecommendation(db, workspaceId, supplierId, cycleId) {
  return db.prepare(`SELECT r.* FROM tprm_recommendations r
    WHERE r.workspace_id=? AND r.supplier_id=? AND r.cycle_id=?
      AND NOT EXISTS (SELECT 1 FROM tprm_recommendations successor WHERE successor.supersedes_id=r.id)
    ORDER BY r.version DESC LIMIT 1`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(supplierId, 'supplierId'), positiveId(cycleId, 'cycleId')
    ) || null;
}

function currentClientDecision(db, workspaceId, supplierId) {
  return db.prepare(`SELECT d.* FROM tprm_client_decisions d
    WHERE d.workspace_id=? AND d.supplier_id=?
      AND NOT EXISTS (SELECT 1 FROM tprm_client_decisions successor WHERE successor.supersedes_id=d.id)
    ORDER BY d.version DESC LIMIT 1`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(supplierId, 'supplierId')
    ) || null;
}

function latestFinalClientDecision(db, workspaceId, supplierId) {
  return db.prepare(`SELECT d.* FROM tprm_client_decisions d
    WHERE d.workspace_id=? AND d.supplier_id=?
      AND d.decision IN ('onboard','onboard_with_conditions','do_not_onboard')
    ORDER BY d.version DESC,d.id DESC LIMIT 1`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(supplierId, 'supplierId')
    ) || null;
}

// A positive client decision is operational authority only while every
// governed expiry that made the decision acceptable is still current.  Keep
// this calculation in one place so lifecycle projections and relationship
// activation cannot disagree about an expired risk acceptance.
function currentPositiveDecisionAuthority(db, workspaceIdInput, supplierIdInput, options = {}) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const asOfDate = cleanText(options.asOfDate || utcNow().slice(0, 10));
  if (!validIsoDate(asOfDate)) fail('TPRM_AUTHORITY_DATE_INVALID', 'Decision-authority date must be a valid ISO date.', 400);
  const candidate = options.decision === undefined
    ? currentClientDecision(db, workspaceId, supplierId)
    : options.decision;
  const decision = candidate && candidate.id
    ? db.prepare(`SELECT * FROM tprm_client_decisions
        WHERE id=? AND workspace_id=? AND supplier_id=?`).get(candidate.id, workspaceId, supplierId) || null
    : null;
  const state = (authorised, code, message, extra = {}) => ({
    authorised, code, message, asOfDate, decision, ...extra,
  });
  if (!decision) {
    return state(false, 'TPRM_CLIENT_DECISION_REQUIRED',
      'A current positive client onboarding decision is required.');
  }
  if (!POSITIVE_CLIENT_DECISIONS.has(decision.decision)) {
    return state(false, 'TPRM_POSITIVE_CLIENT_DECISION_REQUIRED',
      'The selected client decision does not authorise onboarding.');
  }
  if (decision.valid_until && decision.valid_until < asOfDate) {
    return state(false, 'TPRM_CLIENT_DECISION_EXPIRED',
      'The client onboarding decision has expired.');
  }
  const recommendation = db.prepare(`SELECT * FROM tprm_recommendations
    WHERE id=? AND workspace_id=? AND supplier_id=?`).get(
      decision.recommendation_id, workspaceId, supplierId
    ) || null;
  if (!recommendation) {
    return state(false, 'TPRM_CLIENT_DECISION_RECOMMENDATION_MISSING',
      'The recommendation governed by this client decision is unavailable.');
  }
  const riskAcceptanceRequired = decision.diverges_from_recommendation === 1
    || ['high', 'critical'].includes(String(recommendation.residual_risk_band || '').toLowerCase());
  if (riskAcceptanceRequired
    && (!cleanText(decision.risk_acceptance_statement) || !decision.risk_acceptance_expires_at)) {
    return state(false, 'TPRM_RISK_ACCEPTANCE_REQUIRED',
      'The onboarding decision requires a governed, expiring risk acceptance.',
      { recommendation, riskAcceptanceRequired });
  }
  if (riskAcceptanceRequired && decision.risk_acceptance_expires_at < asOfDate) {
    return state(false, 'TPRM_RISK_ACCEPTANCE_EXPIRED',
      'The risk acceptance supporting this onboarding decision has expired.',
      { recommendation, riskAcceptanceRequired });
  }
  return state(true, null, null, { recommendation, riskAcceptanceRequired });
}

function approvedBaseline(db, workspaceId, supplierId, options = {}) {
  const latestFinal = latestFinalClientDecision(db, workspaceId, supplierId);
  if (!latestFinal) return null;
  const authority = currentPositiveDecisionAuthority(db, workspaceId, supplierId, {
    decision: latestFinal,
    asOfDate: options.asOfDate,
  });
  return authority.authorised ? latestFinal : null;
}

function decisionAuthorityLapseSignal(db, workspaceId, supplierId, options = {}) {
  const latestFinal = latestFinalClientDecision(db, workspaceId, supplierId);
  if (!latestFinal || !POSITIVE_CLIENT_DECISIONS.has(latestFinal.decision)) return null;
  const authority = currentPositiveDecisionAuthority(db, workspaceId, supplierId, {
    decision: latestFinal,
    asOfDate: options.asOfDate,
  });
  if (authority.authorised) return null;
  const dueDate = authority.code === 'TPRM_CLIENT_DECISION_EXPIRED'
    ? latestFinal.valid_until
    : authority.code === 'TPRM_RISK_ACCEPTANCE_EXPIRED'
      ? latestFinal.risk_acceptance_expires_at
      : null;
  return {
    key: 'client_authority_lapsed',
    type: 'governance_authority_lapse',
    code: authority.code,
    severity: 'high',
    priority: 'high',
    requiresReassessment: true,
    serviceStatusPreserved: true,
    decisionId: latestFinal.id,
    dueDate,
    title: 'Client onboarding authority requires reassessment',
    message: `${authority.message} The recorded service status is preserved, but a governed reassessment and current client decision are required.`,
  };
}

function latestSchedule(db, workspaceId, supplierId) {
  return db.prepare(`SELECT s.* FROM tprm_review_schedules s
    WHERE s.workspace_id=? AND s.supplier_id=?
      AND NOT EXISTS (SELECT 1 FROM tprm_review_schedules successor WHERE successor.supersedes_id=s.id)
    ORDER BY s.version DESC LIMIT 1`).get(
      positiveId(workspaceId, 'workspaceId'), positiveId(supplierId, 'supplierId')
    ) || null;
}

function currentSchedule(db, workspaceId, supplierId) {
  const schedule = latestSchedule(db, workspaceId, supplierId);
  if (!schedule) return null;
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='tprm_review_schedule_closures'`).get()
    && db.prepare('SELECT 1 FROM tprm_review_schedule_closures WHERE schedule_id=?').get(schedule.id)) {
    return null;
  }
  return schedule;
}

function materialSignalState(db, workspaceIdInput, supplierIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const latest = db.prepare(`SELECT * FROM tprm_monitoring_signals
    WHERE workspace_id=? AND supplier_id=?
      AND (severity IN ('high','critical') OR requires_reassessment=1)
    ORDER BY id DESC LIMIT 1`).get(workspaceId, supplierId) || null;
  const unresolved = db.prepare(`SELECT COUNT(*) AS count FROM tprm_monitoring_signals
    WHERE workspace_id=? AND supplier_id=? AND status='new'
      AND (severity IN ('high','critical') OR requires_reassessment=1)`).get(workspaceId, supplierId).count;
  return { latest, latestId: latest && latest.id || null, unresolved };
}

function recommendationDecisionBlocker(db, workspaceId, supplierId, recommendation, decisionDate = utcNow().slice(0, 10)) {
  if (!recommendation) return 'No issued consultancy recommendation is available.';
  if (recommendation.valid_until && recommendation.valid_until < decisionDate) {
    return 'The consultancy recommendation has expired. A current successor recommendation is required.';
  }
  const signalState = materialSignalState(db, workspaceId, supplierId);
  const snapshot = parseJson(recommendation.readiness_snapshot_json, {}) || {};
  const capturedId = Number(snapshot?.gates?.latestMaterialSignalId ?? snapshot.latestMaterialSignalId);
  if (Number.isInteger(capturedId) && capturedId >= 0) {
    if (signalState.latestId && signalState.latestId > capturedId) {
      return 'A material monitoring signal was recorded after this recommendation. The consultancy must issue a successor recommendation.';
    }
  } else {
    const later = db.prepare(`SELECT 1 FROM tprm_monitoring_signals
      WHERE workspace_id=? AND supplier_id=?
        AND (severity IN ('high','critical') OR requires_reassessment=1)
        AND (julianday(observed_at)>=julianday(?) OR julianday(received_at)>=julianday(?))
      LIMIT 1`).get(workspaceId, supplierId, recommendation.issued_at, recommendation.issued_at);
    if (later) {
      return 'A material monitoring signal was recorded after this recommendation. The consultancy must issue a successor recommendation.';
    }
  }
  return null;
}

function eventFingerprint(input) {
  return sha256({
    workspaceId: Number(input.workspaceId), supplierId: input.supplierId ? Number(input.supplierId) : null,
    moduleId: Number(input.moduleId), cycleId: input.cycleId ? Number(input.cycleId) : null,
    eventType: input.eventType, fromStage: input.fromStage || null, toStage: input.toStage || null,
    actorId: input.actorId || null, actorType: input.actorType, reason: input.reason || null,
    payload: input.payload || {},
  });
}

function recordEvent(db, input) {
  if (!EVENT_TYPES.includes(input.eventType)) fail('TPRM_EVENT_TYPE_INVALID', 'Lifecycle event type is invalid.', 400);
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const moduleId = positiveId(input.moduleId, 'moduleId');
  const supplierId = input.supplierId == null ? null : positiveId(input.supplierId, 'supplierId');
  const cycleId = input.cycleId == null ? null : positiveId(input.cycleId, 'cycleId');
  if ((supplierId == null) !== (cycleId == null) && cycleId != null) {
    fail('TPRM_EVENT_SCOPE_INVALID', 'A cycle event must identify its third party.', 400);
  }
  if (input.fromStage && !LIFECYCLE_STAGES.includes(input.fromStage)) fail('TPRM_STAGE_INVALID', 'Lifecycle source stage is invalid.', 400);
  if (input.toStage && !LIFECYCLE_STAGES.includes(input.toStage)) fail('TPRM_STAGE_INVALID', 'Lifecycle target stage is invalid.', 400);
  const actor = actorForEvent(db, workspaceId, input);
  const idempotencyKey = validIdempotency(input.idempotencyKey);
  const requestFingerprint = eventFingerprint({ ...input, workspaceId, supplierId, moduleId, cycleId, actorId: actor.id, actorType: actor.type });
  if (idempotencyKey) {
    const replay = db.prepare('SELECT * FROM tprm_lifecycle_events WHERE idempotency_key=?').get(idempotencyKey);
    if (replay) {
      if (replay.request_fingerprint !== requestFingerprint) {
        fail('TPRM_IDEMPOTENCY_CONFLICT', 'This lifecycle request token was already used for different content.', 409);
      }
      return { event: replay, replayed: true };
    }
  }
  const prior = db.prepare(`SELECT event_hash FROM tprm_lifecycle_events
    WHERE workspace_id=? AND module_id=? AND COALESCE(supplier_id,0)=COALESCE(?,0)
    ORDER BY id DESC LIMIT 1`).get(workspaceId, moduleId, supplierId);
  const occurredAt = input.occurredAt || utcNow();
  const payloadJson = stableStringify(input.payload || {});
  const previousHash = prior && prior.event_hash || null;
  const eventHash = sha256({
    workspaceId, supplierId, moduleId, cycleId, eventType: input.eventType,
    fromStage: input.fromStage || null, toStage: input.toStage || null,
    actorId: actor.id, actorType: actor.type, actorName: actor.name,
    reason: optionalText(input.reason), payload: parseJson(payloadJson, {}), occurredAt, previousHash,
  });
  const id = Number(db.prepare(`INSERT INTO tprm_lifecycle_events
    (workspace_id,supplier_id,module_id,cycle_id,event_type,from_stage,to_stage,actor_user_id,
     actor_type,actor_name,reason,payload_json,idempotency_key,request_fingerprint,
     previous_event_hash,event_hash,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      workspaceId, supplierId, moduleId, cycleId, input.eventType, input.fromStage || null,
      input.toStage || null, actor.id, actor.type, actor.name, optionalText(input.reason), payloadJson,
      idempotencyKey, requestFingerprint, previousHash, eventHash, occurredAt
    ).lastInsertRowid);
  return { event: tableRow(db, 'tprm_lifecycle_events', id), replayed: false };
}

function enableModule(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  workspaceRow(db, workspaceId);
  if (!SERVICE_MODELS.includes(input.serviceModel)) fail('TPRM_SERVICE_MODEL_INVALID', 'Select a valid TPRM service model.', 400);
  const actor = firmActor(db, workspaceId, input.actorId);
  return db.transaction(() => {
    const existing = moduleForWorkspace(db, workspaceId);
    if (existing && existing.status === 'active') {
      if (existing.service_model !== input.serviceModel) {
        fail('TPRM_MODULE_ALREADY_ACTIVE', 'Close the current TPRM service period before changing service model.', 409);
      }
      return { module: existing, created: false, classified: false };
    }
    if (existing && existing.status === 'needs_classification') {
      db.prepare(`UPDATE tprm_modules SET service_model=?,status='active',classified_by=?,classified_at=? WHERE id=?`)
        .run(input.serviceModel, actor.id, utcNow(), existing.id);
      const module = moduleForWorkspace(db, workspaceId);
      recordEvent(db, {
        workspaceId, moduleId: module.id, eventType: 'module_classified', toStage: 'module_setup',
        actorId: actor.id, actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
        reason: input.reason || 'Historic module service model classified.',
        payload: { serviceModel: input.serviceModel }, idempotencyKey: input.idempotencyKey,
      });
      return { module, created: false, classified: true };
    }
    const id = Number(db.prepare(`INSERT INTO tprm_modules
      (workspace_id,service_model,status,activation_reason,created_by)
      VALUES (?,?,'active',?,?)`).run(
        workspaceId, input.serviceModel, optionalText(input.reason) || 'TPRM module enabled.', actor.id
      ).lastInsertRowid);
    const module = moduleForWorkspace(db, workspaceId);
    recordEvent(db, {
      workspaceId, moduleId: id, eventType: 'module_enabled', toStage: 'module_setup',
      actorId: actor.id, actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason: input.reason || 'TPRM module enabled.', payload: { serviceModel: input.serviceModel },
      idempotencyKey: input.idempotencyKey,
    });
    return { module, created: true, classified: false };
  }).immediate();
}

function closeModule(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  if (!['manager', 'firm_owner'].includes(String(actor.firm_role || '').toLowerCase())) {
    fail('TPRM_MANAGER_REQUIRED', 'Only a consultancy manager can close the Third-party risk service period.', 403);
  }
  if (input.force === true || input.force === '1' || input.force === 'true') {
    fail('TPRM_FORCE_CLOSE_FORBIDDEN', 'Third-party risk cannot be force-closed. Resolve or cancel every active assessment cycle first.', 400);
  }
  const reason = requiredText(input.reason, 'Closure reason', 10);
  const requestedRetentionUntil = optionalIsoDate(input.retentionUntil, 'Retention-until date');
  const retentionPolicy = requiredText(
    input.retentionPolicy || 'Retain governed TPRM records for seven years after service-period closure.',
    'Retention policy', 10
  );
  const legalHold = input.legalHold === true || input.legalHold === '1' || input.legalHold === 'true';
  const asOfDate = optionalIsoDate(input.asOfDate, 'Closure evaluation date') || utcNow().slice(0, 10);
  return db.transaction(() => {
    const module = moduleForWorkspace(db, workspaceId);
    if (!module) return { module: null, closed: false };
    if (input.expectedModuleId != null && Number(input.expectedModuleId) !== Number(module.id)) {
      fail('TPRM_STALE_MODULE', 'The Third-party risk service period changed; reload before closing it.', 409);
    }
    const activeCycles = db.prepare("SELECT COUNT(*) AS count FROM tprm_assessment_cycles WHERE module_id=? AND status='active'").get(module.id).count;
    if (activeCycles > 0) {
      fail('TPRM_ACTIVE_CYCLES', `${activeCycles} active assessment cycle(s) must be completed or cancelled before closing TPRM.`, 409);
    }
    const openConditions = db.prepare(`SELECT COUNT(*) AS count FROM tprm_conditions c
      JOIN tprm_assessment_cycles cycle ON cycle.id=c.cycle_id AND cycle.workspace_id=c.workspace_id
      WHERE cycle.module_id=?
        AND (c.status IN ('open','in_progress','evidence_submitted')
          OR (c.status='waived' AND c.waiver_expires_at < ?))
        AND (c.source_type='client_decision' OR NOT EXISTS (
          SELECT 1 FROM tprm_conditions adopted
          WHERE adopted.workspace_id=c.workspace_id AND adopted.cycle_id=c.cycle_id
            AND adopted.source_type='client_decision'
        ))`).get(module.id, asOfDate).count;
    if (openConditions > 0) {
      fail('TPRM_OPEN_CONDITIONS', `${openConditions} operative condition(s) must be verified or formally waived before closing TPRM.`, 409);
    }
    const closedAt = utcNow();
    const retentionUntil = requestedRetentionUntil || db.prepare("SELECT date(?,'+7 years') AS value").get(closedAt.slice(0, 10)).value;
    if (!retentionUntil || retentionUntil < closedAt.slice(0, 10)) {
      fail('TPRM_RETENTION_DATE_INVALID', 'Retention must extend through or beyond the service-period closure date.', 400);
    }
    const changed = db.prepare(`UPDATE tprm_modules SET status='closed',effective_to=?,closed_by=?,close_reason=?
      WHERE id=? AND workspace_id=? AND status IN ('active','needs_classification')`)
      .run(closedAt, actor.id, reason, module.id, workspaceId);
    if (changed.changes !== 1) fail('TPRM_STALE_MODULE', 'The Third-party risk service period changed; reload before closing it.', 409);
    const closureHash = sha256({
      workspaceId, moduleId: module.id, serviceModel: module.service_model,
      effectiveFrom: module.effective_from, closedAt, closedBy: actor.id,
      reason, retentionUntil, legalHold, retentionPolicy,
    });
    const closureId = Number(db.prepare(`INSERT INTO tprm_module_closure_records
      (workspace_id,module_id,retention_until,legal_hold,retention_policy,closure_reason,
       closed_by,closed_at,closure_hash)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, module.id, retentionUntil, legalHold ? 1 : 0, retentionPolicy,
        reason, actor.id, closedAt, closureHash
      ).lastInsertRowid);
    recordEvent(db, {
      workspaceId, moduleId: module.id, eventType: 'module_closed', fromStage: 'module_setup',
      actorId: actor.id, actorType: 'consultancy_manager', reason,
      payload: {
        serviceModel: module.service_model, activeCyclesAtClosure: 0,
        closureRecordId: closureId, retentionUntil, legalHold,
      }, idempotencyKey: input.idempotencyKey,
    });
    return {
      module: tableRow(db, 'tprm_modules', module.id),
      closure: tableRow(db, 'tprm_module_closure_records', closureId),
      closed: true,
    };
  }).immediate();
}

function linkCycleArtifacts(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const cycle = db.prepare(`SELECT * FROM tprm_assessment_cycles
    WHERE id=? AND workspace_id=? AND supplier_id=?`).get(cycleId, workspaceId, supplierId);
  if (!cycle) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle not found.', 404);
  if (cycle.status !== 'active') fail('TPRM_CYCLE_FROZEN', 'Completed or cancelled assessment cycles cannot be changed.', 409);
  const ids = {
    inherent: input.inherentAssessmentId == null ? cycle.inherent_assessment_id : positiveId(input.inherentAssessmentId, 'inherentAssessmentId'),
    ddq: input.ddqAssessmentId == null ? cycle.ddq_assessment_id : positiveId(input.ddqAssessmentId, 'ddqAssessmentId'),
    contract: input.contractReviewId == null ? cycle.contract_review_id : positiveId(input.contractReviewId, 'contractReviewId'),
  };
  const inherent = ids.inherent ? db.prepare(`SELECT * FROM supplier_inherent_assessments
    WHERE id=? AND workspace_id=? AND supplier_id=?`).get(ids.inherent, workspaceId, supplierId) : null;
  if (ids.inherent && !inherent) fail('TPRM_ARTIFACT_SCOPE', 'Inherent-risk assessment is outside this cycle scope.', 409);
  const ddq = ids.ddq ? db.prepare(`SELECT * FROM supplier_ddq_assessments
    WHERE id=? AND workspace_id=? AND supplier_id=?`).get(ids.ddq, workspaceId, supplierId) : null;
  if (ids.ddq && (!ddq || !inherent || ddq.inherent_assessment_id !== inherent.id)) {
    fail('TPRM_ARTIFACT_LINEAGE', 'Due diligence must reference this cycle’s inherent-risk assessment.', 409);
  }
  const contract = ids.contract ? db.prepare(`SELECT * FROM supplier_contract_reviews
    WHERE id=? AND workspace_id=? AND supplier_id=?`).get(ids.contract, workspaceId, supplierId) : null;
  if (ids.contract && (!contract || !inherent || contract.inherent_assessment_id !== inherent.id)) {
    fail('TPRM_ARTIFACT_LINEAGE', 'Contract assurance must reference this cycle’s inherent-risk assessment.', 409);
  }
  const changes = [];
  if (!cycle.inherent_assessment_id && ids.inherent) changes.push(['inherent_assessment_id', ids.inherent]);
  if (!cycle.ddq_assessment_id && ids.ddq) changes.push(['ddq_assessment_id', ids.ddq]);
  if (!cycle.contract_review_id && ids.contract) changes.push(['contract_review_id', ids.contract]);
  if (!changes.length) return { cycle, changed: false };
  const setSql = changes.map(([column]) => `${column}=?`).join(',');
  db.prepare(`UPDATE tprm_assessment_cycles SET ${setSql},row_version=row_version+1 WHERE id=?`)
    .run(...changes.map(([, value]) => value), cycle.id);
  const updated = tableRow(db, 'tprm_assessment_cycles', cycle.id);
  recordEvent(db, {
    workspaceId, supplierId, moduleId: cycle.module_id, cycleId: cycle.id,
    eventType: 'artifact_linked', actorId: input.actorId, actorType: input.actorType || 'consultant',
    reason: input.reason || 'Assessment artifact linked to governed cycle.',
    payload: Object.fromEntries(changes), idempotencyKey: input.idempotencyKey,
  });
  return { cycle: updated, changed: true };
}

function ensureCurrentCycle(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  supplierRow(db, workspaceId, supplierId);
  const actor = firmActor(db, workspaceId, input.actorId);
  const module = moduleForWorkspace(db, workspaceId);
  if (!module || module.status !== 'active') {
    fail(module && module.status === 'needs_classification' ? 'TPRM_MODULE_NEEDS_CLASSIFICATION' : 'TPRM_MODULE_DISABLED',
      module ? 'Classify the historic TPRM service model before starting work.' : 'Enable the Third-party risk module before starting an assessment cycle.', 409);
  }
  const cycleType = input.cycleType || 'onboarding';
  if (!CYCLE_TYPES.includes(cycleType)) fail('TPRM_CYCLE_TYPE_INVALID', 'Assessment cycle type is invalid.', 400);
  const authority = input.clientDecisionAuthorityId
    ? clientActor(db, workspaceId, input.clientDecisionAuthorityId) : null;
  if (authority && !['client_owner', 'client_admin'].includes(authority.workspace_role)) {
    fail('TPRM_CLIENT_DECISION_ROLE_REQUIRED', 'Decision authority must be an authorised client sponsor.', 403);
  }
  return db.transaction(() => {
    let cycle = currentCycle(db, workspaceId, supplierId);
    let created = false;
    if (!cycle) {
      const cycleNumber = Number(db.prepare(`SELECT COALESCE(MAX(cycle_number),0)+1 AS next
        FROM tprm_assessment_cycles WHERE workspace_id=? AND supplier_id=?`).get(workspaceId, supplierId).next);
      const baseline = approvedBaseline(db, workspaceId, supplierId);
      const id = Number(db.prepare(`INSERT INTO tprm_assessment_cycles
        (workspace_id,supplier_id,module_id,cycle_number,cycle_type,status,trigger_reason,
         baseline_decision_id,client_decision_authority_id,started_by,due_at)
        VALUES (?,?,?,?,?,'active',?,?,?,?,?)`).run(
          workspaceId, supplierId, module.id, cycleNumber, cycleType,
          optionalText(input.triggerReason), baseline && baseline.id, authority && authority.id,
          actor.id, optionalText(input.dueAt)
        ).lastInsertRowid);
      cycle = tableRow(db, 'tprm_assessment_cycles', id);
      recordEvent(db, {
        workspaceId, supplierId, moduleId: module.id, cycleId: id, eventType: 'cycle_started',
        fromStage: baseline ? 'monitoring' : 'module_setup', toStage: 'intake', actorId: actor.id,
        actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
        reason: input.triggerReason || `${cycleType} assessment cycle started.`,
        payload: { cycleNumber, cycleType, baselineDecisionId: baseline && baseline.id || null },
        idempotencyKey: input.idempotencyKey,
      });
      created = true;
    } else if (authority) {
      if (cycle.client_decision_authority_id && cycle.client_decision_authority_id !== authority.id) {
        fail('TPRM_DECISION_AUTHORITY_IMMUTABLE', 'A different client decision authority is already assigned to this cycle.', 409);
      }
      if (!cycle.client_decision_authority_id) {
        db.prepare('UPDATE tprm_assessment_cycles SET client_decision_authority_id=?,row_version=row_version+1 WHERE id=?')
          .run(authority.id, cycle.id);
        cycle = tableRow(db, 'tprm_assessment_cycles', cycle.id);
      }
    }
    if (input.inherentAssessmentId || input.ddqAssessmentId || input.contractReviewId) {
      cycle = linkCycleArtifacts(db, {
        ...input, workspaceId, supplierId, cycleId: cycle.id,
        actorId: actor.id, actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
        idempotencyKey: null,
      }).cycle;
    }
    return { cycle, created, approvedBaseline: cycle.baseline_decision_id ? tableRow(db, 'tprm_client_decisions', cycle.baseline_decision_id) : null };
  }).immediate();
}

function cancelAssessmentCycle(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const reason = requiredText(input.reason, 'Cycle cancellation reason', 10);
  const expectedRowVersion = Number(input.expectedRowVersion);
  if (!Number.isInteger(expectedRowVersion) || expectedRowVersion <= 0) {
    fail('TPRM_CYCLE_VERSION_REQUIRED', 'Reload the assessment cycle before cancelling it.', 400);
  }
  return db.transaction(() => {
    const cycle = db.prepare(`SELECT c.*,m.status AS module_status FROM tprm_assessment_cycles c
      JOIN tprm_modules m ON m.workspace_id=c.workspace_id AND m.id=c.module_id
      WHERE c.id=? AND c.workspace_id=? AND c.supplier_id=?`).get(cycleId, workspaceId, supplierId);
    if (!cycle) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle not found.', 404);
    if (cycle.status !== 'active') fail('TPRM_CYCLE_FROZEN', 'Only an active assessment cycle can be cancelled.', 409);
    if (cycle.module_status !== 'active') fail('TPRM_MODULE_DISABLED', 'This Third-party risk service period is read only.', 409);
    if (cycle.row_version !== expectedRowVersion) {
      fail('TPRM_STALE_CYCLE', 'The assessment cycle changed; reload before cancelling it.', 409);
    }
    const issued = db.prepare(`SELECT
        EXISTS(SELECT 1 FROM tprm_recommendations WHERE workspace_id=? AND supplier_id=? AND cycle_id=?) AS recommendation,
        EXISTS(SELECT 1 FROM tprm_client_decisions WHERE workspace_id=? AND supplier_id=? AND cycle_id=?) AS client_decision`)
      .get(workspaceId, supplierId, cycleId, workspaceId, supplierId, cycleId);
    if (issued.recommendation || issued.client_decision) {
      fail('TPRM_CYCLE_ISSUED_ARTIFACT', 'A cycle cannot be cancelled after a consultancy recommendation or client decision has been issued.', 409);
    }
    const cancelledAt = utcNow();
    const changed = db.prepare(`UPDATE tprm_assessment_cycles
      SET status='cancelled',cancelled_at=?,cancellation_reason=?,row_version=row_version+1
      WHERE id=? AND workspace_id=? AND supplier_id=? AND status='active' AND row_version=?`).run(
        cancelledAt, reason, cycleId, workspaceId, supplierId, expectedRowVersion
      );
    if (changed.changes !== 1) fail('TPRM_STALE_CYCLE', 'The assessment cycle changed; reload before cancelling it.', 409);
    recordEvent(db, {
      workspaceId, supplierId, moduleId: cycle.module_id, cycleId,
      eventType: 'cycle_cancelled', fromStage: canonicalStage(input.fromStage || 'intake'),
      toStage: cycle.baseline_decision_id ? 'monitoring' : 'intake',
      actorId: actor.id,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason,
      payload: {
        cancelledCycleNumber: cycle.cycle_number,
        preservedBaselineDecisionId: cycle.baseline_decision_id || null,
        issuedRecommendation: false,
        issuedClientDecision: false,
      },
      idempotencyKey: input.idempotencyKey,
    });
    return { cycle: tableRow(db, 'tprm_assessment_cycles', cycleId), cancelled: true };
  }).immediate();
}

function assignClientDecisionAuthority(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const assigningActor = firmActor(db, workspaceId, input.actorId);
  const authority = clientActor(db, workspaceId, input.clientDecisionAuthorityId);
  if (!['client_owner', 'client_admin'].includes(authority.workspace_role)) {
    fail('TPRM_CLIENT_DECISION_ROLE_REQUIRED', 'Decision authority must be an authorised client sponsor.', 403);
  }
  return db.transaction(() => {
    const cycle = db.prepare(`SELECT * FROM tprm_assessment_cycles
      WHERE id=? AND workspace_id=? AND supplier_id=?`).get(cycleId, workspaceId, supplierId);
    if (!cycle) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle not found.', 404);
    if (cycle.status !== 'active') fail('TPRM_CYCLE_FROZEN', 'Decision authority cannot be changed after cycle completion.', 409);
    if (cycle.client_decision_authority_id && cycle.client_decision_authority_id !== authority.id) {
      fail('TPRM_DECISION_AUTHORITY_IMMUTABLE', 'Client decision authority is already assigned and cannot be replaced.', 409);
    }
    if (!cycle.client_decision_authority_id) {
      db.prepare('UPDATE tprm_assessment_cycles SET client_decision_authority_id=?,row_version=row_version+1 WHERE id=?')
        .run(authority.id, cycle.id);
      recordEvent(db, {
        workspaceId, supplierId, moduleId: cycle.module_id, cycleId,
        eventType: 'decision_authority_assigned',
        actorId: assigningActor.id,
        actorType: assigningActor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
        reason: input.reason || `Client decision authority assigned to ${authority.name}.`,
        payload: { clientDecisionAuthorityId: authority.id }, idempotencyKey: input.idempotencyKey,
      });
    }
    return { cycle: tableRow(db, 'tprm_assessment_cycles', cycle.id), authority };
  }).immediate();
}

function cycleBundle(db, workspaceIdInput, cycleIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const cycleId = positiveId(cycleIdInput, 'cycleId');
  const cycle = db.prepare('SELECT * FROM tprm_assessment_cycles WHERE id=? AND workspace_id=?').get(cycleId, workspaceId);
  if (!cycle) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle not found.', 404);
  const supplier = supplierRow(db, workspaceId, cycle.supplier_id);
  const recommendation = currentRecommendation(db, workspaceId, supplier.id, cycle.id);
  const decision = db.prepare(`SELECT * FROM tprm_client_decisions
    WHERE workspace_id=? AND supplier_id=? AND cycle_id=? ORDER BY version DESC LIMIT 1`).get(workspaceId, supplier.id, cycle.id) || null;
  const relationshipScopes = db.prepare(`SELECT scope.id,scope.relationship_id,scope.scope_role,scope.scope_rationale,scope.linked_at,
      relationship.relationship_key,relationship.relationship_name,relationship.service_category,
      relationship.service_description,relationship.criticality,relationship.data_access,relationship.status,
      legal.legal_name
    FROM tprm_cycle_relationship_scopes scope
    JOIN tprm_service_relationships relationship
      ON relationship.workspace_id=scope.workspace_id AND relationship.id=scope.relationship_id
    JOIN tprm_legal_entities legal
      ON legal.workspace_id=relationship.workspace_id AND legal.id=relationship.legal_entity_id
    WHERE scope.workspace_id=? AND scope.supplier_id=? AND scope.cycle_id=?
    ORDER BY CASE scope.scope_role WHEN 'primary' THEN 0 WHEN 'in_scope' THEN 1 ELSE 2 END,
      relationship.relationship_name,scope.id`).all(workspaceId, supplier.id, cycle.id);
  return {
    module: tableRow(db, 'tprm_modules', cycle.module_id),
    supplier,
    cycle,
    approvedBaseline: cycle.baseline_decision_id ? tableRow(db, 'tprm_client_decisions', cycle.baseline_decision_id) : null,
    inherent: cycle.inherent_assessment_id ? tableRow(db, 'supplier_inherent_assessments', cycle.inherent_assessment_id) : null,
    ddq: cycle.ddq_assessment_id ? tableRow(db, 'supplier_ddq_assessments', cycle.ddq_assessment_id) : null,
    contract: cycle.contract_review_id ? tableRow(db, 'supplier_contract_reviews', cycle.contract_review_id) : null,
    recommendation,
    clientDecision: decision,
    relationshipScopes,
    conditions: db.prepare('SELECT * FROM tprm_conditions WHERE cycle_id=? ORDER BY due_date,id').all(cycle.id),
    clarifications: db.prepare('SELECT * FROM tprm_clarifications WHERE cycle_id=? ORDER BY requested_at,id').all(cycle.id),
    events: db.prepare('SELECT * FROM tprm_lifecycle_events WHERE cycle_id=? ORDER BY id').all(cycle.id),
    evidenceReleases: listReleasedEvidence(db, workspaceId, supplier.id, { cycleId: cycle.id }),
    schedules: db.prepare('SELECT * FROM tprm_review_schedules WHERE workspace_id=? AND supplier_id=? ORDER BY version').all(workspaceId, supplier.id),
  };
}

function findingSnapshot(db, workspaceId, supplierId) {
  return db.prepare(`SELECT f.id,f.title,f.severity,f.status,l.domain,l.due_date,l.owner_name
    FROM findings f JOIN supplier_finding_links l ON l.finding_id=f.id
    WHERE f.workspace_id=? AND l.supplier_id=?
    ORDER BY f.id`).all(workspaceId, supplierId);
}

function artifactReadiness(db, bundle) {
  const unresolvedModules = (parseJson(bundle.inherent && bundle.inherent.module_applicability_json, []) || [])
    .filter(item => item && item.applicability === 'Unknown / Validation Required').length;
  const openClarifications = db.prepare(`SELECT COUNT(*) AS count FROM tprm_clarifications
    WHERE cycle_id=? AND status IN ('open','responded')`).get(bundle.cycle.id).count;
  const findings = findingSnapshot(db, bundle.cycle.workspace_id, bundle.supplier.id);
  const openHighFindings = findings.filter(item => ['high', 'critical'].includes(item.severity)
    && !['closed', 'verified', 'accepted_risk'].includes(item.status));
  const monitoring = materialSignalState(db, bundle.cycle.workspace_id, bundle.supplier.id);
  const gates = {
    relationshipScopeDeclared: bundle.relationshipScopes.length > 0,
    inherentApproved: Boolean(bundle.inherent && bundle.inherent.status === 'approved'),
    ddqComplete: Boolean(bundle.ddq && bundle.ddq.status === 'complete'),
    contractComplete: Boolean(bundle.contract && bundle.contract.status === 'complete'),
    contractIdentityComplete: Boolean(bundle.contract && cleanText(bundle.contract.agreement_reference) && validIsoDate(bundle.contract.agreement_date)),
    unresolvedModules,
    openClarifications,
    openHighFindings: openHighFindings.length,
    unresolvedMaterialSignals: monitoring.unresolved,
    latestMaterialSignalId: monitoring.latestId,
  };
  const blockers = [];
  if (!gates.relationshipScopeDeclared) blockers.push({ key: 'service_scope', message: 'No service relationship is linked to this assessment cycle.' });
  if (!gates.inherentApproved) blockers.push({ key: 'inherent_risk', message: 'Inherent-risk assessment is not approved.' });
  if (!gates.ddqComplete) blockers.push({ key: 'due_diligence', message: 'Provider due diligence and consultancy review are not complete.' });
  if (!gates.contractComplete || !gates.contractIdentityComplete) blockers.push({ key: 'contract_assurance', message: 'Contract assurance is not complete against an identified executed agreement.' });
  if (unresolvedModules) blockers.push({ key: 'module_scope', message: `${unresolvedModules} conditional due-diligence module(s) remain unresolved.` });
  if (openClarifications) blockers.push({ key: 'clarifications', message: `${openClarifications} clarification request(s) remain unresolved.` });
  if (openHighFindings.length) blockers.push({ key: 'findings', message: `${openHighFindings.length} high or critical finding(s) remain open.` });
  if (monitoring.unresolved) blockers.push({
    key: 'monitoring_signals',
    message: `${monitoring.unresolved} new material monitoring signal(s) require documented triage before a recommendation can be issued.`,
  });
  return {
    ...gates,
    hardReady: gates.relationshipScopeDeclared && gates.inherentApproved && gates.ddqComplete && gates.contractComplete
      && gates.contractIdentityComplete && !unresolvedModules && !openClarifications && !monitoring.unresolved,
    readyWithoutConditions: blockers.length === 0,
    blockers,
    openHighFindingIds: openHighFindings.map(item => item.id),
    findings,
  };
}

// Read-only projection used by the firm UI to explain exactly which
// recommendation outcomes are currently supportable. Keeping this calculation
// beside issueRecommendation prevents the page from advertising a positive
// recommendation that the governed issuance boundary will reject later.
function recommendationReadiness(db, workspaceIdInput, supplierIdInput, cycleIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const bundle = cycleBundle(db, workspaceId, positiveId(cycleIdInput, 'cycleId'));
  if (bundle.supplier.id !== supplierId) {
    fail('TPRM_CYCLE_SCOPE', 'Assessment cycle belongs to another third party.', 409);
  }
  return artifactReadiness(db, bundle);
}

function normalizeCondition(db, workspaceId, supplierId, condition) {
  const type = condition.conditionType || condition.condition_type || 'other';
  const severity = condition.severity || 'moderate';
  const ownerType = condition.ownerType || condition.owner_type || 'client';
  if (!CONDITION_TYPES.includes(type)) fail('TPRM_CONDITION_TYPE_INVALID', 'Condition type is invalid.', 400);
  if (!['low', 'moderate', 'high', 'critical'].includes(severity)) fail('TPRM_CONDITION_SEVERITY_INVALID', 'Condition severity is invalid.', 400);
  if (!['client', 'third_party', 'consultancy'].includes(ownerType)) fail('TPRM_CONDITION_OWNER_INVALID', 'Condition owner type is invalid.', 400);
  let ownerUserId = condition.ownerUserId || condition.owner_user_id
    ? positiveId(condition.ownerUserId || condition.owner_user_id, 'ownerUserId') : null;
  let governedOwnerName = requiredText(condition.ownerName || condition.owner_name, 'Condition owner');
  if (ownerType === 'client') {
    if (!ownerUserId) fail('TPRM_CONDITION_CLIENT_OWNER_REQUIRED', 'A client-owned condition requires an assigned active client owner.', 400);
    const owner = db.prepare(`SELECT u.id,u.name FROM users u
      JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
      WHERE u.id=? AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')`).get(workspaceId, ownerUserId);
    if (!owner) fail('TPRM_CONDITION_OWNER_SCOPE', 'The condition owner is not an active client owner in this workspace.', 409);
    governedOwnerName = owner.name;
  } else if (ownerType === 'consultancy') {
    if (!ownerUserId) fail('TPRM_CONDITION_CONSULTANCY_OWNER_REQUIRED', 'A consultancy-owned condition requires an assigned active consultancy user.', 400);
    const owner = db.prepare(`SELECT u.id,u.name FROM users u JOIN workspaces w ON w.id=?
      WHERE u.id=? AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id`).get(workspaceId, ownerUserId);
    if (!owner) fail('TPRM_CONDITION_OWNER_SCOPE', 'The condition owner is not an active consultancy user for this workspace.', 409);
    governedOwnerName = owner.name;
  } else if (ownerUserId) {
    fail('TPRM_CONDITION_OWNER_TYPE_MISMATCH', 'A third-party-owned condition cannot be assigned to an internal user account.', 400);
  }
  const dueDate = optionalIsoDate(condition.dueDate || condition.due_date, 'Condition due date');
  if (!dueDate) fail('TPRM_CONDITION_DUE_DATE_REQUIRED', 'Condition due date is required.', 400);
  const findingId = condition.findingId || condition.finding_id ? positiveId(condition.findingId || condition.finding_id, 'findingId') : null;
  if (findingId) {
    const linked = db.prepare(`SELECT 1 FROM findings f JOIN supplier_finding_links l ON l.finding_id=f.id
      WHERE f.id=? AND f.workspace_id=? AND l.supplier_id=?`).get(findingId, workspaceId, supplierId);
    if (!linked) fail('TPRM_CONDITION_FINDING_SCOPE', 'Condition finding is not linked to this third party.', 409);
  }
  return {
    findingId,
    conditionType: type,
    title: requiredText(condition.title, 'Condition title', 3),
    description: requiredText(condition.description, 'Condition description', 10),
    severity,
    ownerType,
    ownerUserId,
    ownerName: governedOwnerName,
    dueDate,
    verificationCriteria: requiredText(condition.verificationCriteria || condition.verification_criteria, 'Verification criteria', 5),
  };
}

function insertConditions(db, { workspaceId, supplierId, cycleId, sourceType, sourceId, conditions, createdBy }) {
  const insert = db.prepare(`INSERT INTO tprm_conditions
    (workspace_id,supplier_id,cycle_id,source_type,recommendation_id,client_decision_id,finding_id,
     condition_type,title,description,severity,owner_type,owner_user_id,owner_name,due_date,
     verification_criteria,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return conditions.map(condition => {
    const id = Number(insert.run(
      workspaceId, supplierId, cycleId, sourceType,
      sourceType === 'recommendation' ? sourceId : null,
      sourceType === 'client_decision' ? sourceId : null,
      condition.findingId, condition.conditionType, condition.title, condition.description,
      condition.severity, condition.ownerType, condition.ownerUserId, condition.ownerName,
      condition.dueDate, condition.verificationCriteria, createdBy
    ).lastInsertRowid);
    return tableRow(db, 'tprm_conditions', id);
  });
}

function recommendationArtifacts(bundle, readiness) {
  const artifact = row => row ? {
    id: row.id, status: row.status, methodologyId: row.methodology_id || null,
    methodologyVersion: row.methodology_version || null, methodologyHash: row.methodology_hash || null,
    completedAt: row.completed_at || row.approved_at || null,
  } : null;
  return {
    cycle: { id: bundle.cycle.id, number: bundle.cycle.cycle_number, type: bundle.cycle.cycle_type },
    serviceRelationships: bundle.relationshipScopes.map(scope => ({
      id: scope.relationship_id, key: scope.relationship_key, name: scope.relationship_name,
      legalName: scope.legal_name, role: scope.scope_role, category: scope.service_category,
      criticality: scope.criticality, dataAccess: scope.data_access,
    })),
    inherent: artifact(bundle.inherent), ddq: artifact(bundle.ddq), contract: artifact(bundle.contract),
    contractIdentity: bundle.contract ? {
      agreementReference: bundle.contract.agreement_reference || null,
      agreementDate: bundle.contract.agreement_date || null,
    } : null,
    findingIds: readiness.findings.map(item => item.id),
    capturedAt: utcNow(),
  };
}

function issueRecommendation(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const outcome = input.outcome;
  if (!RECOMMENDATION_OUTCOMES.includes(outcome)) fail('TPRM_RECOMMENDATION_OUTCOME_INVALID', 'Recommendation outcome is invalid.', 400);
  const { maker, checker } = assertMakerChecker(db, {
    workspaceId, makerId: input.authorId || input.issuedBy, checkerId: input.reviewerId || input.qualityReviewedBy,
  });
  const rationale = requiredText(input.rationale, 'Recommendation rationale', 20);
  const executiveSummary = requiredText(input.executiveSummary, 'Executive summary', 10);
  const qualityReviewRationale = requiredText(input.qualityReviewRationale, 'Quality-review rationale', 10);
  const residualRiskBand = input.residualRiskBand || 'unknown';
  if (!['low', 'moderate', 'high', 'critical', 'unknown'].includes(residualRiskBand)) {
    fail('TPRM_RESIDUAL_RISK_INVALID', 'Residual-risk band is invalid.', 400);
  }
  const residualRiskScore = input.residualRiskScore == null ? null : Number(input.residualRiskScore);
  if (residualRiskScore != null && (!Number.isInteger(residualRiskScore) || residualRiskScore < 0 || residualRiskScore > 100)) {
    fail('TPRM_RESIDUAL_RISK_INVALID', 'Residual-risk score must be an integer from 0 to 100.', 400);
  }
  const idempotencyKey = validIdempotency(input.idempotencyKey || input.idempotencyNonce);
  const validUntil = optionalIsoDate(input.validUntil, 'Recommendation validity date');
  if (validUntil && validUntil < utcNow().slice(0, 10)) {
    fail('TPRM_RECOMMENDATION_VALIDITY_INVALID', 'Recommendation validity cannot already have expired when it is issued.', 400);
  }
  return db.transaction(() => {
    const bundle = cycleBundle(db, workspaceId, cycleId);
    if (bundle.supplier.id !== supplierId) fail('TPRM_CYCLE_SCOPE', 'Assessment cycle belongs to another third party.', 409);
    if (bundle.cycle.status !== 'active') fail('TPRM_CYCLE_FROZEN', 'A recommendation cannot be issued for a completed or cancelled cycle.', 409);
    const readiness = artifactReadiness(db, bundle);
    if (readiness.unresolvedMaterialSignals) {
      fail('TPRM_MONITORING_SIGNAL_TRIAGE_REQUIRED',
        'Every new material monitoring signal must be triaged before a recommendation is issued.', 409,
        readiness.blockers.filter(item => item.key === 'monitoring_signals'));
    }
    const normalizedConditions = (input.conditions || []).map(item => normalizeCondition(db, workspaceId, supplierId, item));
    if (outcome === 'recommend_onboard' && !readiness.readyWithoutConditions) {
      fail('TPRM_RECOMMENDATION_BLOCKED', 'Unconditional onboarding cannot be recommended until every governed gate passes.', 409, readiness.blockers);
    }
    if (outcome === 'recommend_with_conditions') {
      if (!readiness.hardReady) fail('TPRM_RECOMMENDATION_BLOCKED', 'Conditional onboarding still requires completed assessment, due diligence, contract assurance and clarifications.', 409, readiness.blockers);
      if (!normalizedConditions.length) fail('TPRM_CONDITIONS_REQUIRED', 'A conditional recommendation requires structured conditions.', 400);
      const covered = new Set(normalizedConditions.map(item => item.findingId).filter(Boolean));
      const uncovered = readiness.openHighFindingIds.filter(id => !covered.has(id));
      if (uncovered.length) fail('TPRM_HIGH_FINDINGS_UNCONDITIONED', 'Every open high or critical finding must have a linked condition.', 409, uncovered);
    }
    if (outcome !== 'recommend_with_conditions' && normalizedConditions.length) {
      fail('TPRM_CONDITIONS_NOT_APPLICABLE', 'Structured recommendation conditions require the conditional recommendation outcome.', 400);
    }
    const prior = currentRecommendation(db, workspaceId, supplierId, cycleId);
    const expected = Object.prototype.hasOwnProperty.call(input, 'expectedCurrentRecommendationId')
      ? expectedId(input.expectedCurrentRecommendationId)
      : (prior && prior.id || null);
    if ((prior && prior.id || null) !== expected) fail('TPRM_STALE_RECOMMENDATION', 'The current recommendation changed; reload before issuing a successor.', 409);
    const version = prior ? prior.version + 1 : 1;
    const issuedAt = utcNow();
    const artifactSnapshot = recommendationArtifacts(bundle, readiness);
    const readinessSnapshot = {
      hardReady: readiness.hardReady, readyWithoutConditions: readiness.readyWithoutConditions,
      gates: {
        relationshipScopeDeclared: readiness.relationshipScopeDeclared,
        inherentApproved: readiness.inherentApproved, ddqComplete: readiness.ddqComplete,
        contractComplete: readiness.contractComplete, contractIdentityComplete: readiness.contractIdentityComplete,
        unresolvedModules: readiness.unresolvedModules, openClarifications: readiness.openClarifications,
        openHighFindings: readiness.openHighFindings,
        unresolvedMaterialSignals: readiness.unresolvedMaterialSignals,
        latestMaterialSignalId: readiness.latestMaterialSignalId,
      },
      blockers: readiness.blockers,
    };
    const hashPayload = {
      workspaceId, supplierId, cycleId, version, outcome, executiveSummary, rationale,
      residualRiskScore, residualRiskBand, validUntil, readinessSnapshot, artifactSnapshot,
      conditions: normalizedConditions, issuedBy: maker.id, issuedAt,
      qualityReviewedBy: checker.id, qualityReviewRationale,
    };
    const recommendationHash = sha256(hashPayload);
    const requestFingerprint = sha256({ ...hashPayload, idempotencyKey });
    if (idempotencyKey) {
      const replay = db.prepare('SELECT * FROM tprm_recommendations WHERE idempotency_key=?').get(idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) fail('TPRM_IDEMPOTENCY_CONFLICT', 'Recommendation token was already used for different content.', 409);
        return { recommendation: replay, conditions: db.prepare("SELECT * FROM tprm_conditions WHERE recommendation_id=?").all(replay.id), replayed: true };
      }
    }
    const id = Number(db.prepare(`INSERT INTO tprm_recommendations
      (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
       residual_risk_score,residual_risk_band,valid_until,inherent_assessment_id,ddq_assessment_id,
       contract_review_id,readiness_snapshot_json,artifact_snapshot_json,recommendation_hash,
       issued_by,issuer_name,issued_at,quality_reviewed_by,quality_reviewer_name,quality_reviewed_at,
       quality_review_rationale,supersedes_id,idempotency_key,request_fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, supplierId, cycleId, version, outcome, executiveSummary, rationale,
        residualRiskScore, residualRiskBand, validUntil, bundle.inherent && bundle.inherent.id,
        bundle.ddq && bundle.ddq.id, bundle.contract && bundle.contract.id,
        stableStringify(readinessSnapshot), stableStringify(artifactSnapshot), recommendationHash,
        maker.id, maker.name, issuedAt, checker.id, checker.name, issuedAt,
        qualityReviewRationale, prior && prior.id, idempotencyKey, requestFingerprint
      ).lastInsertRowid);
    const conditions = insertConditions(db, {
      workspaceId, supplierId, cycleId, sourceType: 'recommendation', sourceId: id,
      conditions: normalizedConditions, createdBy: maker.id,
    });
    const projected = lifecycleProjection(db, workspaceId, supplierId);
    recordEvent(db, {
      workspaceId, supplierId, moduleId: bundle.cycle.module_id, cycleId,
      eventType: 'recommendation_issued', fromStage: projected.stage === 'client_decision' ? 'quality_review' : projected.stage,
      toStage: 'client_decision', actorId: checker.id, actorType: 'consultancy_manager',
      reason: qualityReviewRationale, payload: { recommendationId: id, version, outcome, conditionCount: conditions.length, recommendationHash },
    });
    return { recommendation: tableRow(db, 'tprm_recommendations', id), conditions, replayed: false };
  }).immediate();
}

function recommendationDecisionDiverges(recommendationOutcome, decision) {
  return !(
    (recommendationOutcome === 'recommend_onboard' && decision === 'onboard')
    || (recommendationOutcome === 'recommend_with_conditions' && decision === 'onboard_with_conditions')
    || (recommendationOutcome === 'do_not_recommend' && decision === 'do_not_onboard')
    || (recommendationOutcome === 'insufficient_information' && decision === 'defer_request_information')
  );
}

function cadenceMonthsForTier(tier, definition = defaultMethodology) {
  const months = Number(definition && definition.tiers && definition.tiers[tier] && definition.tiers[tier].reviewCadenceMonths);
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    fail('TPRM_CADENCE_INVALID', `No valid review cadence is configured for ${tier}.`, 409);
  }
  return months;
}

function calculateNextReview(tierOrOptions, fromDateInput, definitionInput = defaultMethodology) {
  const options = tierOrOptions && typeof tierOrOptions === 'object'
    ? tierOrOptions
    : { tier: tierOrOptions, fromDate: fromDateInput, definition: definitionInput };
  const tier = options.tier;
  if (!['tier_1', 'tier_2', 'tier_3', 'tier_4'].includes(tier)) fail('TPRM_TIER_INVALID', 'A governed third-party tier is required.', 400);
  const fromDate = cleanText(options.fromDate || fromDateInput || utcNow().slice(0, 10));
  if (!validIsoDate(fromDate)) fail('TPRM_REVIEW_DATE_INVALID', 'Review schedule start must be a valid ISO date.', 400);
  const months = options.cadenceMonths || cadenceMonthsForTier(tier, options.definition || definitionInput || defaultMethodology);
  if (!Number.isInteger(Number(months)) || Number(months) < 1 || Number(months) > 120) fail('TPRM_CADENCE_INVALID', 'Review cadence must be between 1 and 120 months.', 400);
  const [year, month, day] = fromDate.split('-').map(Number);
  const monthIndex = month - 1 + Number(months);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonthIndex, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function closeCurrentReviewSchedule(db, { workspaceId, supplierId, decisionId, actor, decidedAt }) {
  const schedule = currentSchedule(db, workspaceId, supplierId);
  if (!schedule) return null;
  const payload = {
    workspaceId, supplierId, scheduleId: schedule.id, supersededByDecisionId: decisionId,
    reason: 'A later final client decision does not authorise continued onboarding.',
    closedBy: actor.id, closedAt: decidedAt,
  };
  const closureHash = sha256(payload);
  const id = Number(db.prepare(`INSERT INTO tprm_review_schedule_closures
    (workspace_id,supplier_id,schedule_id,superseded_by_decision_id,reason,closed_by,closed_at,closure_hash)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      workspaceId, supplierId, schedule.id, decisionId, payload.reason, actor.id, decidedAt, closureHash
    ).lastInsertRowid);
  return tableRow(db, 'tprm_review_schedule_closures', id);
}

function transitionRejectedDecisionScope(db, { workspaceId, relationshipScopes, decisionId, actor, decidedAt, rationale }) {
  const transitioned = [];
  for (const scope of relationshipScopes) {
    const relationship = db.prepare(`SELECT * FROM tprm_service_relationships
      WHERE workspace_id=? AND id=?`).get(workspaceId, scope.relationship_id);
    if (!relationship || !['active', 'intake'].includes(relationship.status)) continue;
    const targetStatus = relationship.status === 'active' ? 'suspended' : 'rejected';
    const result = db.prepare(`UPDATE tprm_service_relationships
      SET status=?,updated_by=?,updated_at=?,row_version=row_version+1
      WHERE workspace_id=? AND id=? AND row_version=? AND status=?`).run(
        targetStatus, actor.id, decidedAt, workspaceId, relationship.id,
        relationship.row_version, relationship.status
      );
    if (result.changes !== 1) {
      fail('TPRM_RELATIONSHIP_CONFLICT', 'An assessed service relationship changed while the client decision was being recorded.', 409);
    }
    const priorEvent = db.prepare(`SELECT event_hash FROM tprm_relationship_events
      WHERE workspace_id=? AND relationship_id=? AND event_hash IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get(workspaceId, relationship.id);
    const previousHash = priorEvent && priorEvent.event_hash || null;
    const payload = {
      fromStatus: relationship.status, toStatus: targetStatus, clientDecisionId: decisionId,
      reason: 'Final client decision does not authorise this assessed service relationship.',
    };
    const eventHash = sha256({
      workspaceId, relationshipId: relationship.id, eventType: 'relationship_status_changed',
      actorUserId: actor.id, actorName: actor.name, reason: rationale, payload, previousHash,
      occurredAt: decidedAt,
    });
    db.prepare(`INSERT INTO tprm_relationship_events
      (workspace_id,relationship_id,event_type,actor_user_id,actor_type,actor_name,reason,
       payload_json,previous_event_hash,event_hash,occurred_at)
      VALUES (?,?,'relationship_status_changed',?,'client',?,?,?,?,?,?)`).run(
        workspaceId, relationship.id, actor.id, actor.name, rationale,
        stableStringify(payload), previousHash, eventHash, decidedAt
      );
    transitioned.push({ id: relationship.id, fromStatus: relationship.status, toStatus: targetStatus });
  }
  return transitioned;
}

function recordClientDecision(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const recommendationId = positiveId(input.recommendationId, 'recommendationId');
  const servicePeriod = serviceCapabilities.assertCapability(
    db, workspaceId, serviceCapabilities.CAPABILITIES.CLIENT_DECISION_REPORT
  ).module;
  const managesOperationalLifecycle = servicePeriod.service_model === 'managed_lifecycle';
  const decisionValue = input.decision === 'defer' ? 'defer_request_information' : input.decision;
  if (!CLIENT_DECISIONS.includes(decisionValue)) fail('TPRM_CLIENT_DECISION_INVALID', 'Client onboarding decision is invalid.', 400);
  const actor = clientActor(db, workspaceId, input.clientActorId || input.actorId);
  if (!['client_owner', 'client_admin'].includes(actor.workspace_role)) {
    fail('TPRM_CLIENT_DECISION_ROLE_REQUIRED', 'Only an authorised client sponsor can record the onboarding decision.', 403);
  }
  const rationale = requiredText(input.rationale, 'Client decision rationale', 20);
  const clientActorTitle = requiredText(input.clientActorTitle || input.actorTitle || actor.workspace_role, 'Client decision-maker title', 2);
  const authorityBasis = requiredText(input.authorityBasis || `Workspace role: ${actor.workspace_role}`, 'Decision authority basis', 5);
  const idempotencyKey = validIdempotency(input.idempotencyKey || input.idempotencyNonce);
  const validUntil = optionalIsoDate(input.validUntil, 'Decision validity date');
  const riskAcceptanceInput = input.riskAcceptance || {};
  if (!Object.prototype.hasOwnProperty.call(input, 'expectedCurrentDecisionId')) {
    fail('TPRM_EXPECTED_CLIENT_DECISION_REQUIRED', 'The latest supplier decision version must be acknowledged before recording a decision.', 400);
  }
  return db.transaction(() => {
    const cycle = db.prepare(`SELECT * FROM tprm_assessment_cycles WHERE id=? AND workspace_id=? AND supplier_id=?`).get(cycleId, workspaceId, supplierId);
    if (!cycle) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle not found.', 404);
    if (cycle.status !== 'active') fail('TPRM_CYCLE_FROZEN', 'The assessment cycle is no longer accepting a client decision.', 409);
    if (cycle.client_decision_authority_id && cycle.client_decision_authority_id !== actor.id) {
      fail('TPRM_DECISION_AUTHORITY_MISMATCH', 'Only the client decision authority assigned to this cycle can record the onboarding decision.', 403);
    }
    const recommendation = db.prepare(`SELECT * FROM tprm_recommendations
      WHERE id=? AND workspace_id=? AND supplier_id=? AND cycle_id=?`).get(recommendationId, workspaceId, supplierId, cycleId);
    if (!recommendation) fail('TPRM_RECOMMENDATION_NOT_FOUND', 'The selected recommendation version was not found.', 404);
    const currentRec = currentRecommendation(db, workspaceId, supplierId, cycleId);
    if (!currentRec || currentRec.id !== recommendation.id) fail('TPRM_STALE_RECOMMENDATION', 'The client must decide against the latest issued recommendation.', 409);
    const decidedAt = utcNow();
    if (validUntil && validUntil <= decidedAt.slice(0, 10)) {
      fail('TPRM_CLIENT_DECISION_VALIDITY_INVALID', 'Decision validity must end on a future date.', 400);
    }
    const recommendationBlocker = recommendationDecisionBlocker(
      db, workspaceId, supplierId, recommendation, decidedAt.slice(0, 10)
    );
    if (recommendationBlocker) fail('TPRM_RECOMMENDATION_NOT_CURRENT', recommendationBlocker, 409);
    const prior = currentClientDecision(db, workspaceId, supplierId);
    const expected = expectedId(input.expectedCurrentDecisionId);
    if ((prior && prior.id || null) !== expected) fail('TPRM_STALE_CLIENT_DECISION', 'The client decision changed; reload before recording another version.', 409);
    if (prior && prior.cycle_id === cycleId) {
      if (prior.decision !== 'defer_request_information') {
        fail('TPRM_FINAL_CLIENT_DECISION_IMMUTABLE', 'A final decision in this assessment cycle cannot be replaced.', 409);
      }
      if (prior.recommendation_id === recommendation.id || recommendation.version <= prior.recommendation_version) {
        fail('TPRM_SUCCESSOR_RECOMMENDATION_REQUIRED', 'The consultancy must issue a newer recommendation after the client deferral before a final decision can be recorded.', 409);
      }
    }
    const relationshipScopes = db.prepare(`SELECT scope.relationship_id,scope.scope_role,
        relationship.relationship_key,relationship.relationship_name,legal.legal_name
      FROM tprm_cycle_relationship_scopes scope
      JOIN tprm_service_relationships relationship
        ON relationship.workspace_id=scope.workspace_id AND relationship.id=scope.relationship_id
      JOIN tprm_legal_entities legal
        ON legal.workspace_id=relationship.workspace_id AND legal.id=relationship.legal_entity_id
      WHERE scope.workspace_id=? AND scope.supplier_id=? AND scope.cycle_id=?
      ORDER BY CASE scope.scope_role WHEN 'primary' THEN 0 WHEN 'in_scope' THEN 1 ELSE 2 END,
        scope.relationship_id`).all(workspaceId, supplierId, cycleId);
    if (!relationshipScopes.length) {
      fail('TPRM_SERVICE_SCOPE_REQUIRED', 'The client cannot decide until the assessed service relationships are explicitly defined.', 409);
    }
    const recommendationArtifacts = parseJson(recommendation.artifact_snapshot_json, {}) || {};
    const decisionServiceRelationships = Array.isArray(recommendationArtifacts.serviceRelationships)
      && recommendationArtifacts.serviceRelationships.length
      ? recommendationArtifacts.serviceRelationships
      : relationshipScopes.map(scope => ({
        id: scope.relationship_id,
        key: scope.relationship_key,
        name: scope.relationship_name,
        legalName: scope.legal_name,
        role: scope.scope_role,
      }));
    const diverges = recommendationDecisionDiverges(recommendation.outcome, decisionValue);
    const overrideRationale = optionalText(input.overrideRationale || riskAcceptanceInput.rationale);
    const riskAcceptanceStatement = optionalText(input.riskAcceptanceStatement || riskAcceptanceInput.statement || (riskAcceptanceInput.accepted ? riskAcceptanceInput.rationale : null));
    const riskAcceptanceExpiresAt = optionalIsoDate(input.riskAcceptanceExpiresAt || riskAcceptanceInput.expiresAt, 'Risk-acceptance expiry');
    if (riskAcceptanceExpiresAt && riskAcceptanceExpiresAt <= decidedAt.slice(0, 10)) {
      fail('TPRM_RISK_ACCEPTANCE_EXPIRY_INVALID', 'Risk acceptance must expire on a future date.', 400);
    }
    const riskAcceptanceRequired = POSITIVE_CLIENT_DECISIONS.has(decisionValue)
      && (diverges || ['high', 'critical'].includes(recommendation.residual_risk_band));
    if (riskAcceptanceRequired) {
      if (riskAcceptanceInput.accepted !== true && riskAcceptanceInput.accepted !== '1' && riskAcceptanceInput.accepted !== 'true') {
        fail('TPRM_RISK_ACCEPTANCE_REQUIRED', 'The client must explicitly accept the risk before overriding the consultancy recommendation.', 400);
      }
      requiredText(overrideRationale, 'Override rationale', 10);
      requiredText(riskAcceptanceStatement, 'Risk-acceptance statement', 10);
      if (!riskAcceptanceExpiresAt) fail('TPRM_RISK_ACCEPTANCE_EXPIRY_REQUIRED', 'A divergent onboarding risk acceptance must expire.', 400);
    }
    let conditionsInput = input.conditions || [];
    if (decisionValue === 'onboard_with_conditions' && !conditionsInput.length) {
      conditionsInput = db.prepare('SELECT * FROM tprm_conditions WHERE recommendation_id=? ORDER BY id').all(recommendation.id).map(row => ({
        findingId: row.finding_id, conditionType: row.condition_type, title: row.title,
        description: row.description, severity: row.severity, ownerType: row.owner_type,
        ownerUserId: row.owner_user_id, ownerName: row.owner_name, dueDate: row.due_date,
        verificationCriteria: row.verification_criteria,
      }));
    }
    const normalizedConditions = conditionsInput.map(item => normalizeCondition(db, workspaceId, supplierId, item));
    if (decisionValue === 'onboard_with_conditions' && !normalizedConditions.length) {
      fail('TPRM_CONDITIONS_REQUIRED', 'Onboarding with conditions requires structured, owned and dated conditions.', 400);
    }
    if (decisionValue !== 'onboard_with_conditions' && normalizedConditions.length) {
      fail('TPRM_CONDITIONS_NOT_APPLICABLE', 'Use “Onboard with conditions” when the client imposes conditions.', 400);
    }
    const version = prior ? prior.version + 1 : 1;
    const snapshot = {
      recommendation: {
        id: recommendation.id, version: recommendation.version, outcome: recommendation.outcome,
        hash: recommendation.recommendation_hash,
      },
      serviceRelationships: decisionServiceRelationships,
      decision: decisionValue, rationale, divergesFromRecommendation: diverges,
      overrideRationale, riskAcceptanceStatement, riskAcceptanceExpiresAt, validUntil,
      conditions: normalizedConditions,
      authority: { actorId: actor.id, actorName: actor.name, actorTitle: clientActorTitle, authorityBasis },
      decidedAt,
    };
    const decisionHash = sha256(snapshot);
    const requestFingerprint = sha256({ ...snapshot, idempotencyKey });
    if (idempotencyKey) {
      const replay = db.prepare('SELECT * FROM tprm_client_decisions WHERE idempotency_key=?').get(idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) fail('TPRM_IDEMPOTENCY_CONFLICT', 'Client decision token was already used for different content.', 409);
        return { decision: replay, conditions: db.prepare('SELECT * FROM tprm_conditions WHERE client_decision_id=?').all(replay.id), replayed: true };
      }
    }
    const id = Number(db.prepare(`INSERT INTO tprm_client_decisions
      (workspace_id,supplier_id,cycle_id,version,recommendation_id,recommendation_version,
       decision,rationale,diverges_from_recommendation,override_rationale,risk_acceptance_statement,
       risk_acceptance_expires_at,valid_until,client_actor_user_id,client_actor_name,client_actor_title,
       authority_basis,decided_at,decision_snapshot_json,decision_hash,supersedes_id,idempotency_key,
       request_fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, supplierId, cycleId, version, recommendation.id, recommendation.version,
        decisionValue, rationale, diverges ? 1 : 0, overrideRationale, riskAcceptanceStatement,
        riskAcceptanceExpiresAt, validUntil, actor.id, actor.name, clientActorTitle, authorityBasis,
        decidedAt, stableStringify(snapshot), decisionHash, prior && prior.id, idempotencyKey, requestFingerprint
      ).lastInsertRowid);
    const conditions = insertConditions(db, {
      workspaceId, supplierId, cycleId, sourceType: 'client_decision', sourceId: id,
      conditions: normalizedConditions, createdBy: actor.id,
    });
    let schedule = null;
    let scheduleClosure = null;
    let relationshipTransitions = [];
    // An assessment-only engagement records the client's decision and freezes
    // the bounded assessment, but it must not silently become a managed
    // monitoring service. Review schedules and operational supplier state are
    // created only by the managed-lifecycle service model.
    if (managesOperationalLifecycle && POSITIVE_CLIENT_DECISIONS.has(decisionValue)) {
      const inherent = cycle.inherent_assessment_id ? tableRow(db, 'supplier_inherent_assessments', cycle.inherent_assessment_id) : null;
      const tier = inherent && inherent.assigned_tier || supplierRow(db, workspaceId, supplierId).tier;
      const definition = parseJson(inherent && inherent.methodology_snapshot_json, defaultMethodology) || defaultMethodology;
      const cadenceMonths = cadenceMonthsForTier(tier, definition);
      const cadenceReviewDate = calculateNextReview({ tier, fromDate: decidedAt.slice(0, 10), cadenceMonths });
      const reviewDeadlines = [
        { date: cadenceReviewDate, basis: 'tier cadence' },
        ...(validUntil ? [{ date: validUntil, basis: 'client decision validity' }] : []),
        ...(riskAcceptanceRequired && riskAcceptanceExpiresAt
          ? [{ date: riskAcceptanceExpiresAt, basis: 'mandatory risk-acceptance validity' }]
          : []),
      ].sort((left, right) => left.date.localeCompare(right.date));
      const nextReviewDate = reviewDeadlines[0].date;
      const limitingBases = reviewDeadlines
        .filter(item => item.date === nextReviewDate)
        .map(item => item.basis)
        .join(' and ');
      const scheduleBasis = `Earliest governed review deadline: ${limitingBases}. `
        + `Tier cadence ${cadenceReviewDate}`
        + (validUntil ? `; client decision valid until ${validUntil}` : '')
        + (riskAcceptanceRequired ? `; mandatory risk acceptance valid until ${riskAcceptanceExpiresAt}` : '');
      const priorSchedule = latestSchedule(db, workspaceId, supplierId);
      const scheduleVersion = priorSchedule ? priorSchedule.version + 1 : 1;
      const scheduleId = Number(db.prepare(`INSERT INTO tprm_review_schedules
        (workspace_id,supplier_id,module_id,client_decision_id,version,tier,cadence_months,
         scheduled_from,next_review_date,schedule_basis,supersedes_id,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          workspaceId, supplierId, cycle.module_id, id, scheduleVersion, tier, cadenceMonths,
          decidedAt.slice(0, 10), nextReviewDate,
          scheduleBasis,
          priorSchedule && priorSchedule.id, actor.id
        ).lastInsertRowid);
      schedule = tableRow(db, 'tprm_review_schedules', scheduleId);
      db.prepare(`UPDATE suppliers SET lifecycle_stage='active',next_review_date=?,approved_by=?,approved_at=?
        WHERE id=? AND workspace_id=?`).run(nextReviewDate, actor.name, decidedAt, supplierId, workspaceId);
    } else if (managesOperationalLifecycle && decisionValue === 'do_not_onboard') {
      scheduleClosure = closeCurrentReviewSchedule(db, {
        workspaceId, supplierId, decisionId: id, actor, decidedAt,
      });
      relationshipTransitions = transitionRejectedDecisionScope(db, {
        workspaceId, relationshipScopes, decisionId: id, actor, decidedAt, rationale,
      });
      db.prepare(`UPDATE suppliers SET lifecycle_stage='rejected',next_review_date=NULL,
        approved_by=NULL,approved_at=NULL WHERE id=? AND workspace_id=?`).run(supplierId, workspaceId);
    }
    if (FINAL_CLIENT_DECISIONS.has(decisionValue)) {
      db.prepare(`UPDATE tprm_assessment_cycles SET status='completed',completed_at=?,row_version=row_version+1 WHERE id=? AND status='active'`)
        .run(decidedAt, cycle.id);
    }
    recordEvent(db, {
      workspaceId, supplierId, moduleId: cycle.module_id, cycleId,
      eventType: 'client_decision_recorded', fromStage: 'client_decision',
      toStage: decisionValue === 'defer_request_information' ? 'deferred'
        : managesOperationalLifecycle
          ? (decisionValue === 'do_not_onboard' ? 'rejected' : 'monitoring')
          : 'client_decision',
      actorId: actor.id, actorType: 'client', reason: rationale,
      payload: {
        decisionId: id, version, decision: decisionValue, recommendationId: recommendation.id,
        recommendationVersion: recommendation.version, divergesFromRecommendation: diverges,
        conditionCount: conditions.length, scheduleId: schedule && schedule.id || null,
        nextReviewDate: schedule && schedule.next_review_date || null,
        reviewScheduleBasis: schedule && schedule.schedule_basis || null,
        closedScheduleId: scheduleClosure && scheduleClosure.schedule_id || null,
        relationshipTransitions,
      },
    });
    return {
      decision: tableRow(db, 'tprm_client_decisions', id), conditions, schedule,
      scheduleClosure, relationshipTransitions, replayed: false,
    };
  }).immediate();
}

function canonicalStage(value) {
  const normalized = cleanText(value).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  const aliases = {
    terminating: 'offboarding', termination: 'offboarding', terminated: 'closed',
    approved: 'monitoring', active: 'monitoring', prospect: 'intake',
    assessment: 'inherent_risk', due_diligence_review: 'consultancy_review',
  };
  const stage = aliases[normalized] || normalized;
  return LIFECYCLE_STAGES.includes(stage) ? stage : 'intake';
}

function lifecycleProjection(db, workspaceIdInput, supplierIdInput, options = {}) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const supplier = supplierRow(db, workspaceId, supplierId);
  const module = moduleForWorkspace(db, workspaceId, { includeClosed: true });
  if (!module || module.status !== 'active') {
    return {
      module, supplier, cycle: null, approvedBaseline: approvedBaseline(db, workspaceId, supplierId, options),
      recommendation: null, clientDecision: currentClientDecision(db, workspaceId, supplierId),
      stage: 'module_setup', operationalStatus: canonicalStage(supplier.lifecycle_stage),
      blockers: [module && module.status === 'needs_classification'
        ? 'Classify the historic TPRM service model.' : 'Enable the Third-party risk module.'],
      waitingOn: 'consultancy',
      nextAction: { key: module && module.status === 'needs_classification' ? 'classify_module' : 'enable_module', label: module && module.status === 'needs_classification' ? 'Classify TPRM service model' : 'Enable Third-party risk' },
      nextReviewDate: supplier.next_review_date || null,
    };
  }
  const active = currentCycle(db, workspaceId, supplierId);
  const cycle = active || latestCycle(db, workspaceId, supplierId);
  const baseline = approvedBaseline(db, workspaceId, supplierId, options);
  const authorityLapse = decisionAuthorityLapseSignal(db, workspaceId, supplierId, options);
  const schedule = currentSchedule(db, workspaceId, supplierId);
  const terminalLegacy = canonicalStage(supplier.lifecycle_stage);
  if (['offboarding', 'closed'].includes(terminalLegacy)) {
    return {
      module, supplier, cycle, approvedBaseline: baseline, recommendation: null,
      clientDecision: currentClientDecision(db, workspaceId, supplierId), stage: terminalLegacy,
      operationalStatus: terminalLegacy, blockers: [], waitingOn: terminalLegacy === 'offboarding' ? 'client' : null,
      nextAction: terminalLegacy === 'offboarding' ? { key: 'complete_offboarding', label: 'Complete offboarding controls' } : null,
      nextReviewDate: null,
    };
  }
  if (!cycle || !active) {
    const currentDecision = currentClientDecision(db, workspaceId, supplierId);
    if (module.service_model === 'assessment_only'
        && currentDecision && FINAL_CLIENT_DECISIONS.has(currentDecision.decision)) {
      const assessmentStage = currentDecision.decision === 'do_not_onboard' ? 'rejected' : 'client_decision';
      return {
        module, supplier, cycle, approvedBaseline: baseline,
        recommendation: cycle ? currentRecommendation(db, workspaceId, supplierId, cycle.id) : null,
        clientDecision: currentDecision,
        stage: assessmentStage,
        operationalStatus: canonicalStage(supplier.lifecycle_stage),
        blockers: [], waitingOn: null,
        nextAction: {
          key: 'view_assessment_report',
          label: 'Assessment complete - view report',
          priority: 'closed',
        },
        nextReviewDate: null,
        assessmentComplete: true,
        authorityLapse: null,
        governanceSignals: [],
      };
    }
    const stage = baseline || authorityLapse
      ? terminalLegacy
      : currentDecision && currentDecision.decision === 'do_not_onboard' ? 'rejected' : 'intake';
    const highSignals = db.prepare(`SELECT COUNT(*) AS count FROM tprm_monitoring_signals
      WHERE workspace_id=? AND supplier_id=? AND status='new' AND severity IN ('high','critical')`).get(workspaceId, supplierId).count;
    const blockers = [];
    if (authorityLapse) blockers.push(authorityLapse.message);
    if (highSignals) blockers.push(`${highSignals} high or critical monitoring signal(s) require triage.`);
    const nextAction = authorityLapse
      ? {
          key: 'start_reassessment',
          label: 'Start authority-lapse reassessment',
          priority: 'high',
          rank: 1,
          dueDate: authorityLapse.dueDate,
        }
      : highSignals
        ? { key: 'triage_monitoring', label: 'Triage monitoring signals' }
        : { key: baseline ? 'start_reassessment' : 'start_assessment', label: baseline ? 'Start reassessment' : 'Start onboarding assessment' };
    return {
      module, supplier, cycle, approvedBaseline: baseline, recommendation: cycle ? currentRecommendation(db, workspaceId, supplierId, cycle.id) : null,
      clientDecision: currentDecision,
      stage,
      operationalStatus: baseline || authorityLapse ? terminalLegacy : stage,
      blockers,
      waitingOn: authorityLapse || highSignals ? 'consultancy' : null,
      nextAction,
      nextReviewDate: baseline || authorityLapse ? schedule && schedule.next_review_date || supplier.next_review_date || null : null,
      authorityLapse,
      governanceSignals: authorityLapse ? [authorityLapse] : [],
    };
  }
  const bundle = cycleBundle(db, workspaceId, active.id);
  const rec = bundle.recommendation;
  const decision = bundle.clientDecision;
  const successorAfterDeferral = Boolean(decision && decision.decision === 'defer_request_information'
    && rec && rec.id !== decision.recommendation_id && rec.version > decision.recommendation_version);
  let stage = 'intake';
  let waitingOn = 'consultancy';
  let nextAction = { key: 'start_inherent_risk', label: 'Start inherent-risk assessment' };
  const blockers = [];
  if (authorityLapse) blockers.push(authorityLapse.message);
  if (decision) {
    if (successorAfterDeferral) {
      stage = 'client_decision'; waitingOn = 'client'; nextAction = { key: 'record_client_decision', label: 'Review successor recommendation and record client decision' };
    } else if (decision.decision === 'defer_request_information') {
      stage = 'deferred'; waitingOn = 'consultancy'; nextAction = { key: 'address_client_deferral', label: 'Address client request for information' };
    } else if (decision.decision === 'do_not_onboard') {
      stage = 'rejected'; waitingOn = null; nextAction = { key: 'close_or_reassess', label: 'Close record or start a new assessment' };
    } else {
      stage = 'monitoring'; waitingOn = null; nextAction = { key: 'monitor', label: 'Monitor conditions and review schedule' };
    }
  } else if (rec) {
    stage = 'client_decision'; waitingOn = 'client'; nextAction = { key: 'record_client_decision', label: 'Record client onboarding decision' };
  } else if (!bundle.inherent) {
    stage = 'intake';
  } else if (bundle.inherent.status !== 'approved') {
    stage = 'inherent_risk';
    waitingOn = bundle.inherent.status === 'submitted' ? 'consultancy_manager' : 'consultancy';
    nextAction = { key: bundle.inherent.status === 'submitted' ? 'approve_inherent_risk' : 'complete_inherent_risk', label: bundle.inherent.status === 'submitted' ? 'Review inherent-risk assessment' : 'Complete inherent-risk assessment' };
  } else if (!bundle.ddq) {
    stage = 'due_diligence'; nextAction = { key: 'issue_due_diligence', label: 'Issue provider due diligence' };
  } else if (['draft', 'issued', 'in_progress'].includes(bundle.ddq.status)) {
    stage = 'due_diligence'; waitingOn = bundle.ddq.status === 'draft' ? 'consultancy' : 'third_party';
    nextAction = { key: bundle.ddq.status === 'draft' ? 'issue_due_diligence' : 'await_provider', label: bundle.ddq.status === 'draft' ? 'Issue provider due diligence' : 'Await provider response' };
  } else if (['submitted', 'under_review'].includes(bundle.ddq.status)) {
    stage = 'consultancy_review'; waitingOn = 'consultancy'; nextAction = { key: 'review_due_diligence', label: 'Review questionnaire and evidence' };
  } else if (!bundle.contract || bundle.contract.status !== 'complete') {
    stage = 'contract_assurance'; waitingOn = 'consultancy'; nextAction = { key: 'complete_contract_assurance', label: 'Complete contract assurance' };
  } else {
    const readiness = artifactReadiness(db, bundle);
    stage = readiness.openClarifications ? 'consultancy_review' : 'quality_review';
    waitingOn = readiness.openClarifications ? 'third_party' : 'consultancy_manager';
    nextAction = readiness.openClarifications
      ? { key: 'resolve_clarifications', label: 'Resolve provider clarifications' }
      : { key: 'issue_recommendation', label: 'Quality-review and issue recommendation' };
    blockers.push(...readiness.blockers.map(item => item.message));
  }
  if (authorityLapse) {
    nextAction = {
      ...nextAction,
      priority: 'high',
      rank: 1,
      dueDate: authorityLapse.dueDate,
    };
  }
  return {
    module, supplier, cycle: active, approvedBaseline: baseline, recommendation: rec,
    clientDecision: decision,
    stage,
    operationalStatus: baseline || authorityLapse ? terminalLegacy : stage,
    blockers, waitingOn, nextAction,
    nextReviewDate: baseline || authorityLapse ? schedule && schedule.next_review_date || supplier.next_review_date || null : null,
    authorityLapse,
    governanceSignals: authorityLapse ? [authorityLapse] : [],
  };
}

function transition(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const projection = lifecycleProjection(db, workspaceId, supplierId);
  const fromStage = canonicalStage(input.fromStage || projection.stage);
  const toStage = canonicalStage(input.toStage);
  if (input.expectedStage && canonicalStage(input.expectedStage) !== projection.stage) {
    fail('TPRM_STALE_LIFECYCLE', 'Lifecycle state changed; reload before taking this action.', 409, projection);
  }
  if (fromStage === toStage) return { projection, event: null, changed: false };
  if (!ALLOWED_TRANSITIONS[fromStage] || !ALLOWED_TRANSITIONS[fromStage].has(toStage)) {
    fail('TPRM_TRANSITION_INVALID', `TPRM lifecycle cannot move directly from ${fromStage} to ${toStage}.`, 409);
  }
  const actor = actorForEvent(db, workspaceId, input);
  const cycle = input.cycleId ? tableRow(db, 'tprm_assessment_cycles', positiveId(input.cycleId, 'cycleId')) : projection.cycle;
  if (!cycle || cycle.workspace_id !== workspaceId || cycle.supplier_id !== supplierId) fail('TPRM_CYCLE_NOT_FOUND', 'An in-scope assessment cycle is required for this transition.', 404);
  return db.transaction(() => {
    const event = recordEvent(db, {
      workspaceId, supplierId, moduleId: cycle.module_id, cycleId: cycle.id,
      eventType: 'stage_transition', fromStage, toStage, actorId: actor.id, actorType: actor.type,
      actorName: actor.name, reason: requiredText(input.reason, 'Transition reason', 5),
      payload: input.metadata || {}, idempotencyKey: input.idempotencyKey,
    }).event;
    const baseline = approvedBaseline(db, workspaceId, supplierId);
    if (!baseline || ['monitoring', 'rejected', 'offboarding', 'closed'].includes(toStage)) {
      const legacyStage = { monitoring: 'active', closed: 'terminated' }[toStage] || toStage;
      db.prepare('UPDATE suppliers SET lifecycle_stage=? WHERE id=? AND workspace_id=?').run(legacyStage, supplierId, workspaceId);
    }
    return { projection: lifecycleProjection(db, workspaceId, supplierId), event, changed: true };
  }).immediate();
}

function listConditions(db, workspaceIdInput, supplierIdInput, options = {}) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  supplierRow(db, workspaceId, supplierId);
  const clauses = ['workspace_id=?', 'supplier_id=?'];
  const params = [workspaceId, supplierId];
  if (options.cycleId) { clauses.push('cycle_id=?'); params.push(positiveId(options.cycleId, 'cycleId')); }
  const requestedStatuses = options.status
    ? (Array.isArray(options.status) ? options.status : [options.status]) : null;
  if (requestedStatuses && requestedStatuses.some(status => ![...CONDITION_STATUSES, 'waiver_expired'].includes(status))) {
    fail('TPRM_CONDITION_STATUS_INVALID', 'Condition status is invalid.', 400);
  }
  if (!options.includeProposed) {
    clauses.push(`(source_type='client_decision' OR NOT EXISTS (
      SELECT 1 FROM tprm_conditions adopted
      WHERE adopted.cycle_id=tprm_conditions.cycle_id AND adopted.source_type='client_decision'
    ))`);
  }
  const rows = db.prepare(`SELECT * FROM tprm_conditions WHERE ${clauses.join(' AND ')} ORDER BY due_date,id`)
    .all(...params).map(row => conditionProjection(row, options.asOfDate));
  return requestedStatuses ? rows.filter(row => requestedStatuses.includes(row.effective_status)) : rows;
}

function governedConditionRow(db, workspaceId, conditionId, supplierId = null) {
  const params = [positiveId(conditionId, 'conditionId'), positiveId(workspaceId, 'workspaceId')];
  const supplierClause = supplierId == null ? '' : ' AND c.supplier_id=?';
  if (supplierId != null) params.push(positiveId(supplierId, 'supplierId'));
  return db.prepare(`SELECT c.*,cycle.module_id,cycle.status AS cycle_status,m.status AS module_status
    FROM tprm_conditions c
    JOIN tprm_assessment_cycles cycle
      ON cycle.workspace_id=c.workspace_id AND cycle.supplier_id=c.supplier_id
        AND cycle.id=c.cycle_id
    JOIN tprm_modules m ON m.workspace_id=cycle.workspace_id AND m.id=cycle.module_id
    WHERE c.id=? AND c.workspace_id=?${supplierClause}`).get(...params) || null;
}

function requireActiveConditionModule(condition) {
  if (condition.module_status !== 'active') {
    fail('TPRM_MODULE_READ_ONLY', 'This Third-party risk service period is closed and its condition history is read only.', 409);
  }
}

function requireAssignedClientConditionOwner(db, workspaceId, condition, actorId) {
  const actor = clientActor(db, workspaceId, actorId);
  if (!['client_owner', 'client_admin'].includes(actor.workspace_role)
      || condition.source_type !== 'client_decision'
      || condition.owner_type !== 'client'
      || Number(condition.owner_user_id || 0) !== Number(actor.id)) {
    fail('TPRM_CONDITION_CLIENT_OWNER_REQUIRED', 'Only the active client owner assigned to this operative condition can submit its completion.', 403);
  }
  return actor;
}

function conditionActionFingerprint(input) {
  return sha256({
    workspaceId: Number(input.workspaceId), supplierId: Number(input.supplierId),
    conditionId: Number(input.conditionId), eventType: input.eventType,
    actorId: Number(input.actorId), completionStatement: input.completionStatement || null,
    reviewNote: input.reviewNote || null, waiverExpiresAt: input.waiverExpiresAt || null,
    evidence: input.evidence ? {
      originalFilename: input.evidence.originalFilename,
      sha256: input.evidence.sha256,
      sizeBytes: input.evidence.sizeBytes,
      mimeType: input.evidence.mimeType || null,
    } : null,
  });
}

function expectedConditionVersion(condition, input) {
  if (input.expectedRowVersion != null && input.expectedRowVersion !== '') {
    const version = Number(input.expectedRowVersion);
    if (!Number.isInteger(version) || version <= 0) {
      fail('TPRM_CONDITION_VERSION_REQUIRED', 'Reload the condition before taking this action.', 400);
    }
    if (version !== condition.row_version) {
      fail('TPRM_STALE_CONDITION', 'The condition changed; reload before taking this action.', 409);
    }
    return version;
  }
  const expectedStatus = optionalText(input.expectedStatus);
  if (!expectedStatus || !CONDITION_STATUSES.includes(expectedStatus)) {
    fail('TPRM_CONDITION_VERSION_REQUIRED', 'Reload the condition before taking this action.', 400);
  }
  if (expectedStatus !== condition.status) {
    fail('TPRM_STALE_CONDITION', 'The condition changed; reload before taking this action.', 409);
  }
  return condition.row_version;
}

function appendConditionEvent(db, input) {
  if (!CONDITION_EVENT_TYPES.includes(input.eventType)) {
    fail('TPRM_CONDITION_EVENT_INVALID', 'Condition event type is invalid.', 400);
  }
  const idempotencyKey = validIdempotency(input.idempotencyKey);
  const requestFingerprint = conditionActionFingerprint(input);
  if (idempotencyKey) {
    const replay = db.prepare('SELECT * FROM tprm_condition_events WHERE idempotency_key=?').get(idempotencyKey);
    if (replay) {
      if (replay.request_fingerprint !== requestFingerprint) {
        fail('TPRM_IDEMPOTENCY_CONFLICT', 'This condition action token was already used for different content.', 409);
      }
      return { event: replay, replayed: true };
    }
  }
  const condition = input.condition;
  if (!input.allowedFromStatuses.includes(condition.status)) {
    fail('TPRM_CONDITION_STATE_INVALID', input.stateMessage || 'The condition is not in the required state for this action.', 409);
  }
  const expectedRowVersion = expectedConditionVersion(condition, input);
  const prior = db.prepare(`SELECT event_hash FROM tprm_condition_events
    WHERE workspace_id=? AND condition_id=? ORDER BY id DESC LIMIT 1`).get(input.workspaceId, condition.id);
  const previousEventHash = prior?.event_hash || null;
  const occurredAt = utcNow();
  const resultingRowVersion = expectedRowVersion + 1;
  const eventHash = sha256({
    workspaceId: input.workspaceId, supplierId: condition.supplier_id,
    cycleId: condition.cycle_id, conditionId: condition.id,
    eventType: input.eventType, fromStatus: condition.status, toStatus: input.toStatus,
    completionStatement: input.completionStatement || null,
    reviewNote: input.reviewNote || null, waiverExpiresAt: input.waiverExpiresAt || null,
    actorId: input.actor.id, actorType: input.actorType, actorName: input.actor.name,
    expectedRowVersion, resultingRowVersion, evidence: input.evidence ? {
      originalFilename: input.evidence.originalFilename, sha256: input.evidence.sha256,
      sizeBytes: input.evidence.sizeBytes, mimeType: input.evidence.mimeType || null,
    } : null,
    occurredAt, previousEventHash,
  });
  const id = Number(db.prepare(`INSERT INTO tprm_condition_events
    (workspace_id,supplier_id,cycle_id,condition_id,event_type,from_status,to_status,
     completion_statement,review_note,waiver_expires_at,actor_user_id,actor_type,actor_name,
     expected_row_version,resulting_row_version,idempotency_key,request_fingerprint,
     previous_event_hash,event_hash,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.workspaceId, condition.supplier_id, condition.cycle_id, condition.id,
      input.eventType, condition.status, input.toStatus, input.completionStatement || null,
      input.reviewNote || null, input.waiverExpiresAt || null, input.actor.id,
      input.actorType, input.actor.name, expectedRowVersion, resultingRowVersion,
      idempotencyKey, requestFingerprint, previousEventHash, eventHash, occurredAt
    ).lastInsertRowid);
  return { event: tableRow(db, 'tprm_condition_events', id), replayed: false };
}

function normalizedConditionEvidence(input) {
  if (!input) return null;
  const originalFilename = requiredText(input.originalFilename, 'Evidence filename', 1).slice(0, 500);
  const storedPath = requiredText(input.storedPath, 'Stored evidence path', 1);
  if (storedPath.length > 500 || /[\\/]/.test(storedPath)) {
    fail('TPRM_CONDITION_EVIDENCE_PATH', 'Condition evidence storage identity is invalid.', 400);
  }
  const digest = cleanText(input.sha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) fail('TPRM_CONDITION_EVIDENCE_HASH', 'Condition evidence hash is invalid.', 400);
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 50 * 1024 * 1024) {
    fail('TPRM_CONDITION_EVIDENCE_SIZE', 'Condition evidence must be no larger than 50 MB.', 400);
  }
  return {
    originalFilename, storedPath, sha256: digest, sizeBytes,
    mimeType: optionalText(input.mimeType)?.slice(0, 200) || null,
  };
}

function clientStartConditionWork(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const conditionId = positiveId(input.conditionId, 'conditionId');
  return db.transaction(() => {
    const condition = governedConditionRow(db, workspaceId, conditionId, input.supplierId);
    if (!condition) fail('TPRM_CONDITION_NOT_FOUND', 'Condition not found.', 404);
    requireActiveConditionModule(condition);
    const actor = requireAssignedClientConditionOwner(db, workspaceId, condition, input.actorId);
    const appended = appendConditionEvent(db, {
      ...input, workspaceId, supplierId: condition.supplier_id, conditionId, condition, actor,
      actorType: 'client_owner', eventType: 'work_started', toStatus: 'in_progress',
      allowedFromStatuses: ['open'], stateMessage: 'Only an open condition can be started.',
    });
    if (appended.replayed) return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: true };
    const changed = db.prepare(`UPDATE tprm_conditions SET status='in_progress',updated_at=?,row_version=row_version+1
      WHERE id=? AND workspace_id=? AND status='open' AND row_version=?`).run(
        appended.event.occurred_at, condition.id, workspaceId, condition.row_version
      );
    if (changed.changes !== 1) fail('TPRM_STALE_CONDITION', 'The condition changed; reload before starting work.', 409);
    return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: false };
  }).immediate();
}

function clientSubmitCondition(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const conditionId = positiveId(input.conditionId, 'conditionId');
  const completionStatement = requiredText(input.completionStatement, 'Completion statement', 20);
  const evidence = normalizedConditionEvidence(input.evidence);
  return db.transaction(() => {
    const condition = governedConditionRow(db, workspaceId, conditionId, input.supplierId);
    if (!condition) fail('TPRM_CONDITION_NOT_FOUND', 'Condition not found.', 404);
    requireActiveConditionModule(condition);
    const actor = requireAssignedClientConditionOwner(db, workspaceId, condition, input.actorId);
    const appended = appendConditionEvent(db, {
      ...input, workspaceId, supplierId: condition.supplier_id, conditionId, condition, actor,
      actorType: 'client_owner', eventType: 'evidence_submitted', toStatus: 'evidence_submitted',
      completionStatement, evidence, allowedFromStatuses: ['in_progress'],
      stateMessage: 'Start the condition before submitting its completion.',
    });
    if (appended.replayed) {
      const linkedEvidence = db.prepare('SELECT * FROM tprm_condition_evidence_links WHERE condition_event_id=?').get(appended.event.id) || null;
      return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, evidence: linkedEvidence, replayed: true };
    }
    const evidenceSummary = evidence ? evidence.originalFilename : null;
    const changed = db.prepare(`UPDATE tprm_conditions SET status='evidence_submitted',
      evidence_summary=?,completion_note=?,completed_at=?,completed_by=?,updated_at=?,row_version=row_version+1
      WHERE id=? AND workspace_id=? AND status='in_progress' AND row_version=?`).run(
        evidenceSummary, completionStatement, appended.event.occurred_at, actor.id,
        appended.event.occurred_at, condition.id, workspaceId, condition.row_version
      );
    if (changed.changes !== 1) fail('TPRM_STALE_CONDITION', 'The condition changed; reload before submitting completion.', 409);
    let linkedEvidence = null;
    if (evidence) {
      const evidenceHash = sha256({
        eventHash: appended.event.event_hash, workspaceId, supplierId: condition.supplier_id,
        cycleId: condition.cycle_id, conditionId: condition.id, originalFilename: evidence.originalFilename,
        storedPath: evidence.storedPath, sha256: evidence.sha256, sizeBytes: evidence.sizeBytes,
        mimeType: evidence.mimeType, uploadedBy: actor.id,
      });
      const evidenceId = Number(db.prepare(`INSERT INTO tprm_condition_evidence_links
        (workspace_id,supplier_id,cycle_id,condition_id,condition_event_id,original_filename,
         stored_path,mime_type,sha256,size_bytes,inspection_result,uploaded_by,evidence_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,'inspected_upload_facade',?,?)`).run(
          workspaceId, condition.supplier_id, condition.cycle_id, condition.id, appended.event.id,
          evidence.originalFilename, evidence.storedPath, evidence.mimeType, evidence.sha256,
          evidence.sizeBytes, actor.id, evidenceHash
        ).lastInsertRowid);
      linkedEvidence = tableRow(db, 'tprm_condition_evidence_links', evidenceId);
    }
    return {
      condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event,
      evidence: linkedEvidence, replayed: false,
    };
  }).immediate();
}

function requestConditionChanges(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const conditionId = positiveId(input.conditionId, 'conditionId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const reviewNote = requiredText(input.reviewNote || input.reason, 'Requested changes', 10);
  return db.transaction(() => {
    const condition = governedConditionRow(db, workspaceId, conditionId, input.supplierId);
    if (!condition) fail('TPRM_CONDITION_NOT_FOUND', 'Condition not found.', 404);
    requireActiveConditionModule(condition);
    const appended = appendConditionEvent(db, {
      ...input, workspaceId, supplierId: condition.supplier_id, conditionId, condition, actor,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      eventType: 'changes_requested', toStatus: 'in_progress', reviewNote,
      allowedFromStatuses: ['evidence_submitted'],
      stateMessage: 'Changes can be requested only after the client submits completion evidence.',
    });
    if (appended.replayed) return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: true };
    const changed = db.prepare(`UPDATE tprm_conditions SET status='in_progress',updated_at=?,row_version=row_version+1
      WHERE id=? AND workspace_id=? AND status='evidence_submitted' AND row_version=?`).run(
        appended.event.occurred_at, condition.id, workspaceId, condition.row_version
      );
    if (changed.changes !== 1) fail('TPRM_STALE_CONDITION', 'The condition changed; reload before requesting changes.', 409);
    return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: false };
  }).immediate();
}

function verifyCondition(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const conditionId = positiveId(input.conditionId, 'conditionId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const reviewNote = requiredText(input.reviewNote || input.completionNote, 'Verification conclusion', 10);
  return db.transaction(() => {
    const condition = governedConditionRow(db, workspaceId, conditionId, input.supplierId);
    if (!condition) fail('TPRM_CONDITION_NOT_FOUND', 'Condition not found.', 404);
    requireActiveConditionModule(condition);
    const appended = appendConditionEvent(db, {
      ...input, workspaceId, supplierId: condition.supplier_id, conditionId, condition, actor,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      eventType: 'verified', toStatus: 'verified', reviewNote,
      allowedFromStatuses: ['evidence_submitted'],
      stateMessage: 'The client must submit a completion statement before consultancy verification.',
    });
    if (appended.replayed) return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: true };
    const changed = db.prepare(`UPDATE tprm_conditions SET status='verified',verified_at=?,verified_by=?,
      updated_at=?,row_version=row_version+1
      WHERE id=? AND workspace_id=? AND status='evidence_submitted' AND row_version=?`).run(
        appended.event.occurred_at, actor.id, appended.event.occurred_at,
        condition.id, workspaceId, condition.row_version
      );
    if (changed.changes !== 1) fail('TPRM_STALE_CONDITION', 'The condition changed; reload before verification.', 409);
    recordEvent(db, {
      workspaceId, supplierId: condition.supplier_id, moduleId: condition.module_id,
      cycleId: condition.cycle_id, eventType: 'condition_completed', actorId: actor.id,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason: reviewNote,
      payload: { conditionId: condition.id, conditionEventId: appended.event.id, outcome: 'verified' },
    });
    return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: false };
  }).immediate();
}

function waiveCondition(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const conditionId = positiveId(input.conditionId, 'conditionId');
  const actor = firmActor(db, workspaceId, input.actorId);
  if (!['manager', 'firm_owner'].includes(String(actor.firm_role || '').toLowerCase())) {
    fail('TPRM_MANAGER_REQUIRED', 'Only a consultancy manager can approve a condition waiver.', 403);
  }
  const reviewNote = requiredText(input.rationale || input.reviewNote, 'Waiver rationale', 20);
  const waiverExpiresAt = optionalIsoDate(input.expiresAt || input.waiverExpiresAt, 'Waiver expiry');
  if (!waiverExpiresAt || waiverExpiresAt <= utcNow().slice(0, 10)) {
    fail('TPRM_CONDITION_WAIVER_EXPIRY', 'A condition waiver requires a future expiry date.', 400);
  }
  return db.transaction(() => {
    const condition = governedConditionRow(db, workspaceId, conditionId, input.supplierId);
    if (!condition) fail('TPRM_CONDITION_NOT_FOUND', 'Condition not found.', 404);
    requireActiveConditionModule(condition);
    const appended = appendConditionEvent(db, {
      ...input, workspaceId, supplierId: condition.supplier_id, conditionId, condition, actor,
      actorType: 'consultancy_manager', eventType: 'waived', toStatus: 'waived',
      reviewNote, waiverExpiresAt,
      allowedFromStatuses: ['open', 'in_progress', 'evidence_submitted'],
      stateMessage: 'A final condition cannot be waived.',
    });
    if (appended.replayed) return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: true };
    const changed = db.prepare(`UPDATE tprm_conditions SET status='waived',waiver_rationale=?,waiver_expires_at=?,
      updated_at=?,row_version=row_version+1
      WHERE id=? AND workspace_id=? AND status=? AND row_version=?`).run(
        reviewNote, waiverExpiresAt, appended.event.occurred_at, condition.id,
        workspaceId, condition.status, condition.row_version
      );
    if (changed.changes !== 1) fail('TPRM_STALE_CONDITION', 'The condition changed; reload before approving the waiver.', 409);
    return { condition: tableRow(db, 'tprm_conditions', condition.id), event: appended.event, replayed: false };
  }).immediate();
}

function conditionEvidence(db, workspaceIdInput, conditionIdInput, options = {}) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const conditionId = positiveId(conditionIdInput, 'conditionId');
  const clauses = ['e.workspace_id=?', 'e.condition_id=?'];
  const params = [workspaceId, conditionId];
  if (options.supplierId != null) {
    clauses.push('e.supplier_id=?');
    params.push(positiveId(options.supplierId, 'supplierId'));
  }
  if (options.evidenceId != null && options.evidenceId !== 'latest') {
    clauses.push('e.id=?');
    params.push(positiveId(options.evidenceId, 'evidenceId'));
  }
  const rows = db.prepare(`SELECT e.*,event.event_hash,event.occurred_at AS submitted_at,
      event.completion_statement,u.name AS uploaded_by_name
    FROM tprm_condition_evidence_links e
    JOIN tprm_condition_events event
      ON event.workspace_id=e.workspace_id AND event.id=e.condition_event_id
    JOIN users u ON u.id=e.uploaded_by
    WHERE ${clauses.join(' AND ')} ORDER BY e.id DESC`).all(...params);
  return options.evidenceId != null ? (rows[0] || null) : rows;
}

// Compatibility name retained for internal callers. The governed function no
// longer permits a consultancy user to skip the client's submission stage.
function completeCondition(db, input) {
  return verifyCondition(db, input);
}

function listReleasedEvidence(db, workspaceIdInput, supplierIdInput, options = {}) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  supplierRow(db, workspaceId, supplierId);
  const cycleClause = options.cycleId ? ' AND r.cycle_id=?' : '';
  const params = options.cycleId
    ? [workspaceId, supplierId, positiveId(options.cycleId, 'cycleId')]
    : [workspaceId, supplierId];
  return db.prepare(`SELECT r.id AS release_id,r.cycle_id,r.source_type,r.client_label,r.client_description,
      r.allow_download,r.released_at,r.expires_at AS release_expires_at,
      CASE WHEN r.source_type='supplier_document' THEN sd.id ELSE de.id END AS id,
      CASE WHEN r.source_type='supplier_document' THEN sd.filename ELSE de.filename END AS filename,
      CASE WHEN r.source_type='supplier_document' THEN sd.sha256 ELSE de.sha256 END AS sha256,
      CASE WHEN r.source_type='supplier_document' THEN sd.size_bytes ELSE de.size_bytes END AS size_bytes,
      CASE WHEN r.source_type='supplier_document' THEN sd.doc_type ELSE 'due_diligence_evidence' END AS category,
      CASE WHEN r.source_type='supplier_document' THEN sd.effective_date ELSE de.uploaded_at END AS issued_at,
      CASE WHEN r.source_type='supplier_document' THEN sd.expiry_date ELSE NULL END AS source_expiry,
      CASE WHEN r.source_type='supplier_document' THEN sd.expiry_date ELSE NULL END AS expiry_date,
      r.expires_at AS access_expiry,
      CASE WHEN r.source_type='ddq_evidence' THEN de.question_id ELSE NULL END AS question_id
    FROM tprm_evidence_releases r
    LEFT JOIN tprm_evidence_release_withdrawals w ON w.release_id=r.id
    LEFT JOIN supplier_documents sd ON sd.id=r.supplier_document_id
      AND sd.workspace_id=r.workspace_id AND sd.supplier_id=r.supplier_id
    LEFT JOIN supplier_ddq_evidence de ON de.id=r.ddq_evidence_id AND de.workspace_id=r.workspace_id
    WHERE r.workspace_id=? AND r.supplier_id=? AND w.id IS NULL
      AND (r.expires_at IS NULL OR r.expires_at>=date('now'))${cycleClause}
    ORDER BY r.released_at,r.id`).all(...params);
}

function releaseEvidence(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const cycle = db.prepare(`SELECT * FROM tprm_assessment_cycles
    WHERE id=? AND workspace_id=? AND supplier_id=?`).get(cycleId, workspaceId, supplierId);
  if (!cycle) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle not found.', 404);
  const sourceType = input.sourceType;
  if (!['supplier_document', 'ddq_evidence'].includes(sourceType)) fail('TPRM_EVIDENCE_SOURCE_INVALID', 'Evidence release source is invalid.', 400);
  const sourceId = positiveId(input.sourceId || input.evidenceId, 'sourceId');
  let sourceExpiry = null;
  if (sourceType === 'supplier_document') {
    const row = db.prepare(`SELECT id,expiry_date FROM supplier_documents
      WHERE id=? AND workspace_id=? AND supplier_id=?`).get(sourceId, workspaceId, supplierId);
    if (!row) fail('TPRM_EVIDENCE_SCOPE', 'Supplier document is outside this third party.', 409);
    sourceExpiry = row.expiry_date || null;
    if (sourceExpiry && (!validIsoDate(sourceExpiry) || sourceExpiry < utcNow().slice(0, 10))) {
      fail('TPRM_EVIDENCE_SOURCE_EXPIRED',
        'This supplier document is already expired and cannot be newly released to the client portal.', 409,
        { sourceType, sourceId, sourceExpiry });
    }
  } else {
    const row = db.prepare(`SELECT 1 FROM supplier_ddq_evidence e
      JOIN supplier_ddq_assessments a ON a.id=e.assessment_id
      WHERE e.id=? AND e.workspace_id=? AND a.workspace_id=? AND a.supplier_id=?
        AND a.id=?`).get(sourceId, workspaceId, workspaceId, supplierId, cycle.ddq_assessment_id);
    if (!row) fail('TPRM_EVIDENCE_SCOPE', 'Due-diligence evidence is outside this governed assessment cycle.', 409);
  }
  const clientLabel = requiredText(input.clientLabel, 'Client evidence label', 3);
  const clientDescription = optionalText(input.clientDescription);
  const allowDownload = input.allowDownload === true || input.allowDownload === '1' ? 1 : 0;
  const expiresAt = optionalIsoDate(input.expiresAt, 'Evidence release expiry');
  if (expiresAt && expiresAt < utcNow().slice(0, 10)) {
    fail('TPRM_EVIDENCE_RELEASE_EXPIRY_INVALID', 'Evidence release expiry cannot be in the past.', 400);
  }
  const idempotencyKey = validIdempotency(input.idempotencyKey);
  const releaseHash = sha256({
    workspaceId, supplierId, cycleId, sourceType, sourceId,
    clientLabel, clientDescription, allowDownload, expiresAt, releasedBy: actor.id,
  });
  return db.transaction(() => {
    if (idempotencyKey) {
      const replay = db.prepare('SELECT * FROM tprm_evidence_releases WHERE idempotency_key=?').get(idempotencyKey);
      if (replay) {
        if (replay.release_hash !== releaseHash) fail('TPRM_IDEMPOTENCY_CONFLICT', 'Evidence release token was already used for different content.', 409);
        return { release: replay, replayed: true };
      }
    }
    const existing = db.prepare(`SELECT * FROM tprm_evidence_releases
      WHERE workspace_id=? AND supplier_id=? AND cycle_id=? AND source_type=?
        AND COALESCE(supplier_document_id,0)=? AND COALESCE(ddq_evidence_id,0)=?`).get(
          workspaceId, supplierId, cycleId, sourceType,
          sourceType === 'supplier_document' ? sourceId : 0,
          sourceType === 'ddq_evidence' ? sourceId : 0
        );
    if (existing) {
      if (existing.release_hash !== releaseHash) {
        fail('TPRM_EVIDENCE_ALREADY_RELEASED', 'This evidence version already has immutable client-release terms. Create a new governed evidence version before releasing different terms.', 409);
      }
      return { release: existing, replayed: true };
    }
    const id = Number(db.prepare(`INSERT INTO tprm_evidence_releases
      (workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,ddq_evidence_id,
       client_label,client_description,allow_download,expires_at,released_by,release_hash,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, supplierId, cycleId, sourceType,
        sourceType === 'supplier_document' ? sourceId : null,
        sourceType === 'ddq_evidence' ? sourceId : null,
        clientLabel, clientDescription, allowDownload, expiresAt, actor.id, releaseHash, idempotencyKey
      ).lastInsertRowid);
    recordEvent(db, {
      workspaceId, supplierId, moduleId: cycle.module_id, cycleId,
      eventType: 'evidence_released', actorId: actor.id,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason: input.reason || `Released ${clientLabel} to the client portal.`,
      payload: {
        releaseId: id, sourceType, sourceId, sourceExpiry,
        allowDownload: Boolean(allowDownload), accessExpiresAt: expiresAt,
      },
    });
    return { release: tableRow(db, 'tprm_evidence_releases', id), replayed: false };
  }).immediate();
}

function withdrawEvidenceRelease(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  const releaseId = positiveId(input.releaseId, 'releaseId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const release = db.prepare(`SELECT * FROM tprm_evidence_releases
    WHERE id=? AND workspace_id=? AND supplier_id=?`).get(releaseId, workspaceId, supplierId);
  if (!release) fail('TPRM_EVIDENCE_RELEASE_NOT_FOUND', 'Evidence release not found.', 404);
  const reason = requiredText(input.reason, 'Evidence withdrawal reason', 10);
  const idempotencyKey = validIdempotency(input.idempotencyKey);
  const requestFingerprint = sha256({ workspaceId, supplierId, releaseId, reason, actorId:actor.id });
  return db.transaction(() => {
    if (idempotencyKey) {
      const replay = db.prepare('SELECT * FROM tprm_evidence_release_withdrawals WHERE idempotency_key=?').get(idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) fail('TPRM_IDEMPOTENCY_CONFLICT', 'Evidence-withdrawal token was already used for different content.', 409);
        return { withdrawal:replay, replayed:true };
      }
    }
    const existing = db.prepare('SELECT * FROM tprm_evidence_release_withdrawals WHERE release_id=?').get(release.id);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) fail('TPRM_EVIDENCE_ALREADY_WITHDRAWN', 'This evidence release was already withdrawn with a different recorded reason.', 409);
      return { withdrawal: existing, replayed: true };
    }
    const id = Number(db.prepare(`INSERT INTO tprm_evidence_release_withdrawals
      (workspace_id,supplier_id,release_id,reason,withdrawn_by,idempotency_key,request_fingerprint)
      VALUES (?,?,?,?,?,?,?)`).run(workspaceId, supplierId, release.id, reason, actor.id, idempotencyKey, requestFingerprint).lastInsertRowid);
    const cycle = tableRow(db, 'tprm_assessment_cycles', release.cycle_id);
    recordEvent(db, {
      workspaceId, supplierId, moduleId: cycle.module_id, cycleId: cycle.id,
      eventType: 'evidence_release_withdrawn', actorId: actor.id,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason, payload: { releaseId: release.id, withdrawalId: id }, idempotencyKey: input.idempotencyKey,
    });
    return { withdrawal: tableRow(db, 'tprm_evidence_release_withdrawals', id), replayed: false };
  }).immediate();
}

function requestClarification(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const cycleId = positiveId(input.cycleId, 'cycleId');
  const ddqAssessmentId = positiveId(input.ddqAssessmentId, 'ddqAssessmentId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const cycle = db.prepare('SELECT * FROM tprm_assessment_cycles WHERE id=? AND workspace_id=?').get(cycleId, workspaceId);
  if (!cycle || cycle.ddq_assessment_id !== ddqAssessmentId) fail('TPRM_CLARIFICATION_SCOPE', 'Clarification must reference this cycle’s due-diligence assessment.', 409);
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO tprm_clarifications
      (workspace_id,supplier_id,cycle_id,ddq_assessment_id,question_id,request_text,requested_by,due_date)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        workspaceId, cycle.supplier_id, cycle.id, ddqAssessmentId, optionalText(input.questionId),
        requiredText(input.requestText, 'Clarification request', 10), actor.id,
        optionalIsoDate(input.dueDate, 'Clarification due date')
      ).lastInsertRowid);
    recordEvent(db, {
      workspaceId, supplierId: cycle.supplier_id, moduleId: cycle.module_id, cycleId: cycle.id,
      eventType: 'clarification_requested', actorId: actor.id,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason: input.requestText, payload: { clarificationId: id, ddqAssessmentId, questionId: optionalText(input.questionId) },
      idempotencyKey: input.idempotencyKey,
    });
    return { clarification: tableRow(db, 'tprm_clarifications', id) };
  }).immediate();
}

function respondClarification(db, input) {
  const id = positiveId(input.clarificationId, 'clarificationId');
  const clarification = tableRow(db, 'tprm_clarifications', id);
  if (!clarification) fail('TPRM_CLARIFICATION_NOT_FOUND', 'Clarification request not found.', 404);
  if (clarification.status !== 'open') fail('TPRM_CLARIFICATION_FROZEN', 'Clarification request is not awaiting a response.', 409);
  return db.transaction(() => {
    const respondedAt = utcNow();
    db.prepare(`UPDATE tprm_clarifications SET status='responded',provider_response=?,
      provider_responder_name=?,provider_responder_email=?,responded_at=? WHERE id=? AND status='open'`).run(
        requiredText(input.responseText, 'Provider response', 5),
        requiredText(input.responderName, 'Provider responder name', 2),
        optionalText(input.responderEmail), respondedAt, clarification.id
      );
    const cycle = tableRow(db, 'tprm_assessment_cycles', clarification.cycle_id);
    recordEvent(db, {
      workspaceId: clarification.workspace_id, supplierId: clarification.supplier_id,
      moduleId: cycle.module_id, cycleId: cycle.id, eventType: 'clarification_responded',
      actorType: 'external_provider', actorName: input.responderName,
      reason: 'Provider responded to clarification request.', payload: { clarificationId: clarification.id },
      idempotencyKey: input.idempotencyKey,
    });
    return { clarification: tableRow(db, 'tprm_clarifications', clarification.id) };
  }).immediate();
}

function resolveClarification(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const clarification = db.prepare('SELECT * FROM tprm_clarifications WHERE id=? AND workspace_id=?').get(
    positiveId(input.clarificationId, 'clarificationId'), workspaceId
  );
  if (!clarification) fail('TPRM_CLARIFICATION_NOT_FOUND', 'Clarification request not found.', 404);
  if (clarification.status !== 'responded') fail('TPRM_CLARIFICATION_RESPONSE_REQUIRED', 'A provider response is required before resolution.', 409);
  const actor = firmActor(db, workspaceId, input.actorId);
  const note = requiredText(input.resolutionNote, 'Clarification resolution note', 5);
  return db.transaction(() => {
    const resolvedAt = utcNow();
    db.prepare(`UPDATE tprm_clarifications SET status='resolved',resolved_by=?,resolved_at=?,resolution_note=?
      WHERE id=? AND status='responded'`).run(actor.id, resolvedAt, note, clarification.id);
    const cycle = tableRow(db, 'tprm_assessment_cycles', clarification.cycle_id);
    recordEvent(db, {
      workspaceId, supplierId: clarification.supplier_id, moduleId: cycle.module_id, cycleId: cycle.id,
      eventType: 'clarification_resolved', actorId: actor.id,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason: note, payload: { clarificationId: clarification.id }, idempotencyKey: input.idempotencyKey,
    });
    return { clarification: tableRow(db, 'tprm_clarifications', clarification.id) };
  }).immediate();
}

function recordMonitoringSignal(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  supplierRow(db, workspaceId, supplierId);
  const module = moduleForWorkspace(db, workspaceId);
  if (!module || module.status !== 'active') fail('TPRM_MODULE_DISABLED', 'Enable TPRM before recording monitoring signals.', 409);
  const signalType = input.signalType || 'other';
  const severity = input.severity || 'moderate';
  if (!['security_incident', 'breach', 'financial', 'regulatory', 'availability', 'control_change', 'contract', 'concentration', 'news', 'other'].includes(signalType)) fail('TPRM_SIGNAL_TYPE_INVALID', 'Monitoring signal type is invalid.', 400);
  if (!['info', 'low', 'moderate', 'high', 'critical'].includes(severity)) fail('TPRM_SIGNAL_SEVERITY_INVALID', 'Monitoring signal severity is invalid.', 400);
  const source = requiredText(input.source, 'Monitoring source', 2);
  const observedAt = requiredText(input.observedAt, 'Observed time', 10);
  const fingerprint = optionalText(input.fingerprint) || sha256({ source, sourceReference: input.sourceReference || null, supplierId, signalType, title: input.title, observedAt });
  const existing = db.prepare('SELECT * FROM tprm_monitoring_signals WHERE workspace_id=? AND source=? AND fingerprint=?').get(workspaceId, source, fingerprint);
  if (existing) return { signal: existing, replayed: true };
  const cycle = currentCycle(db, workspaceId, supplierId);
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO tprm_monitoring_signals
      (workspace_id,supplier_id,module_id,cycle_id,source,source_reference,fingerprint,signal_type,
       severity,title,detail,observed_at,requires_reassessment,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, supplierId, module.id, cycle && cycle.id, source, optionalText(input.sourceReference),
        fingerprint, signalType, severity, requiredText(input.title, 'Monitoring signal title', 3),
        optionalText(input.detail), observedAt, input.requiresReassessment ? 1 : 0,
        stableStringify(input.metadata || {})
      ).lastInsertRowid);
    recordEvent(db, {
      workspaceId, supplierId, moduleId: module.id, cycleId: cycle && cycle.id,
      eventType: 'monitoring_signal_recorded', actorId: input.actorId,
      actorType: input.actorType || 'system', actorName: input.actorName || 'Nimbus monitoring',
      reason: input.title, payload: { signalId: id, signalType, severity, requiresReassessment: Boolean(input.requiresReassessment) },
      idempotencyKey: input.idempotencyKey,
    });
    return { signal: tableRow(db, 'tprm_monitoring_signals', id), replayed: false };
  }).immediate();
}

function triageMonitoringSignal(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const signal = db.prepare('SELECT * FROM tprm_monitoring_signals WHERE id=? AND workspace_id=?').get(
    positiveId(input.signalId, 'signalId'), workspaceId
  );
  if (!signal) fail('TPRM_SIGNAL_NOT_FOUND', 'Monitoring signal not found.', 404);
  if (signal.status !== 'new') fail('TPRM_SIGNAL_FROZEN', 'Monitoring signal has already been triaged.', 409);
  const status = input.status || 'triaged';
  if (!['triaged', 'dismissed', 'escalated'].includes(status)) fail('TPRM_SIGNAL_STATUS_INVALID', 'Monitoring triage outcome is invalid.', 400);
  const note = requiredText(input.note, 'Triage note', 5);
  return db.transaction(() => {
    db.prepare(`UPDATE tprm_monitoring_signals SET status=?,triage_note=?,triaged_by=?,triaged_at=? WHERE id=? AND status='new'`)
      .run(status, note, actor.id, utcNow(), signal.id);
    recordEvent(db, {
      workspaceId, supplierId: signal.supplier_id, moduleId: signal.module_id, cycleId: signal.cycle_id,
      eventType: 'monitoring_signal_triaged', actorId: actor.id,
      actorType: actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant',
      reason: note, payload: { signalId: signal.id, status }, idempotencyKey: input.idempotencyKey,
    });
    return { signal: tableRow(db, 'tprm_monitoring_signals', signal.id) };
  }).immediate();
}

function clientThirdPartyProjection(db, workspaceIdInput, supplierIdInput, actorIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const viewer = portalViewer(db, workspaceId, actorIdInput);
  const actor = viewer.actor;
  const projection = lifecycleProjection(db, workspaceId, supplierId);
  const cycle = projection.cycle || latestCycle(db, workspaceId, supplierId);
  const bundle = cycle ? cycleBundle(db, workspaceId, cycle.id) : null;
  const latestDecision = currentClientDecision(db, workspaceId, supplierId);
  const recommendation = bundle && bundle.recommendation || null;
  const cycleDecision = bundle && bundle.clientDecision || null;
  const successorAfterDeferral = Boolean(cycleDecision && cycleDecision.decision === 'defer_request_information'
    && recommendation && recommendation.id !== cycleDecision.recommendation_id
    && recommendation.version > cycleDecision.recommendation_version);
  const decisionBlocker = recommendation
    ? recommendationDecisionBlocker(db, workspaceId, supplierId, recommendation)
    : null;
  const authorisedRole = ['client_owner', 'client_admin'].includes(actor.workspace_role);
  const cycleAcceptsDecision = Boolean(bundle && bundle.cycle.status === 'active'
    && (!cycleDecision || successorAfterDeferral));
  const clientEvidence = listReleasedEvidence(
    db, workspaceId, supplierId, cycle ? { cycleId: cycle.id } : {}
  ).map(item => ({
    id: item.release_id,
    releaseId: item.release_id,
    sourceType: item.source_type,
    filename: item.client_label,
    description: item.client_description,
    category: item.category,
    status: 'released',
    issuedAt: item.issued_at,
    releasedAt: item.released_at,
    sourceExpiry: item.source_expiry,
    accessExpiresAt: item.release_expires_at,
    allowDownload: Boolean(item.allow_download),
    sha256: item.sha256,
  }));
  const governedTier = bundle && bundle.inherent && bundle.inherent.status === 'approved'
    ? bundle.inherent.assigned_tier || null : null;
  return {
    // A legacy supplier profile tier is an intake hint, not an approved
    // assurance conclusion. The client portal receives only the approved tier
    // from this exact cycle, or an explicit unassessed state.
    thirdParty: { ...projection.supplier, governed_tier: governedTier },
    lifecycle: projection,
    cycle: bundle && bundle.cycle || null,
    serviceRelationships: bundle && bundle.relationshipScopes || [],
    recommendation,
    clientDecision: cycleDecision,
    conditions: listConditions(db, workspaceId, supplierId),
    evidence: clientEvidence,
    decisionHistory: db.prepare(`SELECT * FROM tprm_client_decisions
      WHERE workspace_id=? AND supplier_id=? ORDER BY version DESC`).all(workspaceId, supplierId),
    events: db.prepare(`SELECT id,event_type,from_stage,to_stage,actor_type,actor_name,reason,occurred_at
      FROM tprm_lifecycle_events WHERE workspace_id=? AND supplier_id=?
        AND event_type IN ('recommendation_issued','client_decision_recorded','condition_completed','clarification_requested','clarification_responded','clarification_resolved','reassessment_scheduled')
      ORDER BY id DESC`).all(workspaceId, supplierId),
    comments: db.prepare(`SELECT c.id,c.body,c.created_at,u.name AS actor_name
      FROM comments c INNER JOIN users u ON u.id=c.user_id
      WHERE c.workspace_id=? AND c.parent_type='tprm_third_party' AND c.parent_id=? AND c.internal_only=0
      ORDER BY c.id`).all(workspaceId, String(supplierId)).map(comment => ({
        ...comment,
        body:enc.decryptIfNeeded(comment.body, workspaceId),
      })),
    clientDecisionAuthorityId: bundle && bundle.cycle.client_decision_authority_id || null,
    latestClientDecisionId: latestDecision && latestDecision.id || null,
    recommendationDecisionBlocker: decisionBlocker,
    canRecordClientDecision: Boolean(projection.module && projection.module.status === 'active'
      && viewer.isClient && authorisedRole && cycleAcceptsDecision
      && !decisionBlocker
      && (!bundle.cycle.client_decision_authority_id || bundle.cycle.client_decision_authority_id === actor.id)),
    viewerMode: viewer.isFirmPreview ? 'firm_preview' : 'client',
  };
}

function addClientComment(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const supplierId = positiveId(input.supplierId, 'supplierId');
  supplierRow(db, workspaceId, supplierId);
  const workspace = workspaceRow(db, workspaceId);
  const actor = clientActor(db, workspaceId, input.actorId);
  if (!['client_owner', 'client_admin', 'isms_manager'].includes(actor.workspace_role)) {
    fail('TPRM_CLIENT_COMMENT_ROLE_REQUIRED', 'Only the client sponsor or security reviewer can comment on this assurance record.', 403);
  }
  const body = requiredText(input.body || input.comment, 'Comment', 2);
  const storedBody = enc.encryptIfNeeded(body, workspaceId, Boolean(workspace.encryption_enabled));
  const id = Number(db.prepare(`INSERT INTO comments
    (workspace_id,parent_type,parent_id,user_id,body,internal_only)
    VALUES (?,'tprm_third_party',?,?,?,0)`).run(
      workspaceId, String(supplierId), actor.id, storedBody
    ).lastInsertRowid);
  return { comment: db.prepare('SELECT * FROM comments WHERE id=? AND workspace_id=?').get(id, workspaceId) };
}

function clientPortfolioProjection(db, workspaceIdInput, actorIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const viewer = portalViewer(db, workspaceId, actorIdInput);
  const module = moduleForWorkspace(db, workspaceId, { includeClosed: true });
  const retainedReadOnly = Boolean(module && module.status === 'closed');
  const thirdParties = db.prepare(`SELECT id FROM suppliers WHERE workspace_id=? AND archived_at IS NULL ORDER BY name`).all(workspaceId)
    .map(row => {
      const item = lifecycleProjection(db, workspaceId, row.id);
      const cycle = item.cycle || latestCycle(db, workspaceId, row.id);
      const bundle = cycle ? cycleBundle(db, workspaceId, cycle.id) : null;
      const openConditionCount = listConditions(db, workspaceId, row.id, {
        status: ['open', 'in_progress', 'evidence_submitted', 'waiver_expired'],
      }).length;
      const recommendation = item.recommendation || bundle && bundle.recommendation || null;
      const clientDecision = bundle && bundle.clientDecision || item.clientDecision || currentClientDecision(db, workspaceId, row.id);
      const governedTier = bundle && bundle.inherent && bundle.inherent.status === 'approved'
        ? bundle.inherent.assigned_tier || null : null;
      return {
        ...item,
        supplier: { ...item.supplier, governed_tier: governedTier },
        cycle: cycle || null, recommendation, clientDecision, openConditionCount,
        residualRiskBand: recommendation && recommendation.residual_risk_band || null,
      };
    });
  const actions = [];
  if (!retainedReadOnly) {
    thirdParties.filter(item => item.waitingOn === 'client' || item.nextAction && item.nextAction.key === 'record_client_decision')
      .forEach(item => actions.push({ supplierId: item.supplier.id, supplierName: item.supplier.name, stage: item.stage, action: item.nextAction, title: item.nextAction && item.nextAction.label, status: 'open' }));
    db.prepare(`SELECT c.id,c.supplier_id,c.title,c.due_date,c.status,c.severity,c.waiver_expires_at,s.name AS supplier_name
      FROM tprm_conditions c JOIN suppliers s ON s.id=c.supplier_id AND s.workspace_id=c.workspace_id
      WHERE c.workspace_id=? AND c.owner_type='client'
        AND (c.status IN ('open','in_progress','evidence_submitted')
          OR (c.status='waived' AND c.waiver_expires_at < date('now')))
        AND (c.owner_user_id IS NULL OR c.owner_user_id=?) ORDER BY c.due_date,c.id`).all(workspaceId, viewer.actor.id)
      .forEach(item => {
        const expiredWaiver = conditionWaiverExpired(item);
        actions.push({
          id: `condition-${item.id}`, supplierId: item.supplier_id, supplierName: item.supplier_name,
          title: expiredWaiver ? `Waiver expired - reassessment required: ${item.title}` : item.title,
          dueDate: item.due_date, status: expiredWaiver ? 'waiver_expired' : item.status,
          priority: expiredWaiver ? 'critical' : item.severity,
          waitingOn: expiredWaiver ? 'consultancy' : 'client',
        });
      });
  }
  return {
    thirdParties,
    actions,
    metrics: {
      total: thirdParties.length,
      awaitingClientDecision: thirdParties.filter(item => item.stage === 'client_decision' && item.waitingOn === 'client').length,
      onboarded: thirdParties.filter(item => item.operationalStatus === 'monitoring').length,
      highOrCriticalResidualRisk: thirdParties.filter(item => ['high', 'critical'].includes(item.residualRiskBand)).length,
      overdueConditions: db.prepare(`SELECT COUNT(*) AS count FROM tprm_conditions
        WHERE workspace_id=? AND due_date<date('now')
          AND (status IN ('open','in_progress','evidence_submitted')
            OR (status='waived' AND waiver_expires_at < date('now')))`).get(workspaceId).count,
    },
    retainedReadOnly,
    viewerMode: viewer.isFirmPreview ? 'firm_preview' : 'client',
  };
}

function guardServiceMutation(capability, operation) {
  return serviceCapabilities.withCapability(capability, operation);
}

function ensureCurrentCycleForServiceModel(db, input) {
  const state = serviceCapabilities.assertCapability(
    db, input?.workspaceId, serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT
  );
  const cycleType = input?.cycleType || 'onboarding';
  if (state.module.service_model === 'assessment_only') {
    if (cycleType !== 'onboarding') {
      throw new serviceCapabilities.TprmCapabilityError(
        'TPRM_ASSESSMENT_ONLY_CYCLE_TYPE',
        'Assessment only includes one bounded onboarding assessment; periodic and triggered reassessments require Managed lifecycle. Close this service period and start a new governed service period to change the contracted service model.',
        409,
        { workspaceId: Number(input.workspaceId), serviceModel: state.module.service_model, cycleType }
      );
    }
    const supplierId = positiveId(input.supplierId, 'supplierId');
    const active = currentCycle(db, input.workspaceId, supplierId);
    if (!active) {
      const prior = db.prepare(`SELECT id,status FROM tprm_assessment_cycles
        WHERE workspace_id=? AND supplier_id=? AND module_id=? ORDER BY cycle_number DESC,id DESC LIMIT 1`)
        .get(Number(input.workspaceId), supplierId, state.module.id);
      if (prior) {
        throw new serviceCapabilities.TprmCapabilityError(
          'TPRM_ASSESSMENT_ONLY_BOUNDARY',
          'This Assessment only service period already contains its bounded assessment for this third party. Periodic, triggered or repeat assessment requires a new contracted service period.',
          409,
          { workspaceId: Number(input.workspaceId), supplierId, moduleId: state.module.id, priorCycleId: prior.id }
        );
      }
    }
  }
  return ensureCurrentCycle(db, input);
}

function transitionForServiceModel(db, input) {
  const state = serviceCapabilities.assertCapability(
    db, input?.workspaceId, serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT
  );
  const target = canonicalStage(input?.toStage);
  if (state.module.service_model !== 'managed_lifecycle'
      && ['monitoring', 'offboarding', 'closed'].includes(target)) {
    serviceCapabilities.assertCapability(
      db, input?.workspaceId, serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE
    );
  }
  return transition(db, input);
}

function respondClarificationForServiceModel(db, input) {
  const clarificationId = positiveId(input?.clarificationId, 'clarificationId');
  const clarification = tableRow(db, 'tprm_clarifications', clarificationId);
  if (!clarification) fail('TPRM_CLARIFICATION_NOT_FOUND', 'Clarification request not found.', 404);
  serviceCapabilities.assertCapability(
    db, clarification.workspace_id, serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT
  );
  return respondClarification(db, input);
}

module.exports = {
  TprmDomainError,
  SERVICE_MODELS,
  MODULE_STATUSES,
  CYCLE_TYPES,
  CYCLE_STATUSES,
  LIFECYCLE_STAGES,
  RECOMMENDATION_OUTCOMES,
  CLIENT_DECISIONS,
  CONDITION_TYPES,
  CONDITION_STATUSES,
  CONDITION_EVENT_TYPES,
  ACTOR_TYPES,
  EVENT_TYPES,
  ALLOWED_TRANSITIONS,
  stableStringify,
  sha256,
  validIsoDate,
  canonicalStage,
  assertMakerChecker,
  makerChecker: assertMakerChecker,
  moduleForWorkspace,
  isEnabled,
  enableModule,
  closeModule,
  ensureCurrentCycle: ensureCurrentCycleForServiceModel,
  cancelAssessmentCycle: guardServiceMutation(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT, cancelAssessmentCycle),
  assignClientDecisionAuthority: guardServiceMutation(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT, assignClientDecisionAuthority),
  currentCycle,
  cycleBundle,
  recommendationReadiness,
  linkCycleArtifacts: guardServiceMutation(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT, linkCycleArtifacts),
  lifecycleProjection,
  transition: transitionForServiceModel,
  recordEvent: guardServiceMutation(serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE, recordEvent),
  issueRecommendation: guardServiceMutation(serviceCapabilities.CAPABILITIES.RECOMMENDATION, issueRecommendation),
  recordClientDecision,
  currentRecommendation,
  currentClientDecision,
  currentPositiveDecisionAuthority,
  approvedBaseline,
  conditionWaiverExpired,
  conditionEffectiveStatus,
  isConditionOperative,
  listConditions,
  completeCondition: guardServiceMutation(serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION, completeCondition),
  clientStartConditionWork: guardServiceMutation(serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION, clientStartConditionWork),
  clientSubmitCondition: guardServiceMutation(serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION, clientSubmitCondition),
  requestConditionChanges: guardServiceMutation(serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION, requestConditionChanges),
  verifyCondition: guardServiceMutation(serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION, verifyCondition),
  waiveCondition: guardServiceMutation(serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION, waiveCondition),
  conditionEvidence,
  listReleasedEvidence,
  releaseEvidence: guardServiceMutation(serviceCapabilities.CAPABILITIES.EVIDENCE_DISCLOSURE, releaseEvidence),
  withdrawEvidenceRelease: guardServiceMutation(serviceCapabilities.CAPABILITIES.EVIDENCE_DISCLOSURE, withdrawEvidenceRelease),
  cadenceMonthsForTier,
  calculateNextReview,
  requestClarification: guardServiceMutation(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT, requestClarification),
  respondClarification: respondClarificationForServiceModel,
  resolveClarification: guardServiceMutation(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT, resolveClarification),
  recordMonitoringSignal: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_SIGNALS, recordMonitoringSignal),
  triageMonitoringSignal: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_SIGNALS, triageMonitoringSignal),
  clientPortfolioProjection,
  clientThirdPartyProjection,
  addClientComment: guardServiceMutation(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT, addClientComment),
  serviceCapabilities,
};
