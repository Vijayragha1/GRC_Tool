'use strict';

const crypto = require('crypto');
const { currentPositiveDecisionAuthority } = require('./tprm-domain');
const serviceCapabilities = require('./tprm-capabilities');

const RELATIONSHIP_STATUSES = Object.freeze(['intake', 'active', 'suspended', 'offboarding', 'terminated', 'rejected']);
const CRITICALITIES = Object.freeze(['low', 'moderate', 'high', 'critical', 'unknown']);
const SUBSTITUTABILITY = Object.freeze([
  'readily_substitutable', 'substitutable_with_effort', 'difficult', 'not_substitutable', 'unknown',
]);
const PROVISION_MODELS = Object.freeze([
  'saas', 'paas', 'iaas', 'managed_service', 'professional_service', 'data_provider', 'physical_service', 'other',
]);
const DATA_ACCESS_LEVELS = Object.freeze(['none', 'internal', 'confidential', 'restricted', 'mixed', 'unknown']);
const CONTRACT_TYPES = Object.freeze(['msa', 'order_form', 'dpa', 'sla', 'licence', 'statement_of_work', 'other']);
const CONTRACT_STATUSES = Object.freeze(['draft', 'under_review', 'executed', 'expired', 'terminated']);
const DEPENDENCY_TYPES = Object.freeze(['subprocessor', 'fourth_party', 'cloud', 'infrastructure', 'payment', 'identity', 'data', 'other']);
const DEPENDENCY_STATUSES = Object.freeze(['disclosed', 'under_review', 'approved', 'rejected', 'ended']);
const LOCATION_TYPES = Object.freeze(['legal_entity', 'service_delivery', 'data_processing', 'data_storage', 'backup', 'support', 'administration']);
class TprmRelationshipError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = 'TprmRelationshipError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 409, details = null) {
  throw new TprmRelationshipError(code, message, status, details);
}

function now() {
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

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function requiredText(value, field, minimum = 2, maximum = 10000) {
  const text = cleanText(value);
  if (text.length < minimum || text.length > maximum) {
    fail('TPRM_RELATIONSHIP_VALIDATION', `${field} must contain ${minimum} to ${maximum} characters.`, 400);
  }
  return text;
}

function optionalText(value, maximum = 10000) {
  const text = cleanText(value);
  if (!text) return null;
  if (text.length > maximum) fail('TPRM_RELATIONSHIP_VALIDATION', `Text cannot exceed ${maximum} characters.`, 400);
  return text;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) fail('TPRM_RELATIONSHIP_VALIDATION', `${field} is invalid.`, 400);
  return id;
}

function optionalId(value, field) {
  if (value == null || value === '' || value === 0 || value === '0' || value === 'none') return null;
  return positiveId(value, field);
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, nullable = true } = {}) {
  if (value == null || value === '') {
    if (nullable) return null;
    fail('TPRM_RELATIONSHIP_VALIDATION', `${field} is required.`, 400);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail('TPRM_RELATIONSHIP_VALIDATION', `${field} must be a whole number between ${minimum} and ${maximum}.`, 400);
  }
  return number;
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback ? 1 : 0;
  if ([true, 1, '1', 'true', 'on', 'yes'].includes(value)) return 1;
  if ([false, 0, '0', 'false', 'off', 'no'].includes(value)) return 0;
  fail('TPRM_RELATIONSHIP_VALIDATION', 'Boolean value is invalid.', 400);
}

function enumValue(value, values, field, fallback = null) {
  const text = optionalText(value, 100);
  if (!text && fallback != null) return fallback;
  if (!text || !values.includes(text)) {
    fail('TPRM_RELATIONSHIP_VALIDATION', `${field} is invalid.`, 400, { allowed: values });
  }
  return text;
}

function validIsoDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function isoDate(value, field) {
  const text = optionalText(value, 10);
  if (text && !validIsoDate(text)) fail('TPRM_RELATIONSHIP_VALIDATION', `${field} must be a valid ISO date.`, 400);
  return text;
}

function countryCode(value, field = 'Country code', nullable = true) {
  const text = optionalText(value, 2);
  if (!text && nullable) return null;
  const upper = (text || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) fail('TPRM_RELATIONSHIP_VALIDATION', `${field} must be a two-letter country code.`, 400);
  return upper;
}

function currencyCode(value, field = 'Currency', nullable = true) {
  const text = optionalText(value, 3);
  if (!text && nullable) return null;
  const upper = (text || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) fail('TPRM_RELATIONSHIP_VALIDATION', `${field} must be a three-letter currency code.`, 400);
  return upper;
}

function hashValue(value, field) {
  const text = optionalText(value, 64);
  if (text && !/^[0-9a-f]{64}$/.test(text)) fail('TPRM_RELATIONSHIP_VALIDATION', `${field} must be a lowercase SHA-256 hash.`, 400);
  return text;
}

function idempotencyKey(value) {
  const text = optionalText(value, 128);
  if (text && text.length < 32) fail('TPRM_RELATIONSHIP_IDEMPOTENCY_INVALID', 'Idempotency key must contain 32 to 128 trimmed characters.', 400);
  return text;
}

function textArray(value, field, { countryCodes = false } = {}) {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = list.split(','); }
  }
  if (list == null || list === '') return [];
  if (!Array.isArray(list)) fail('TPRM_RELATIONSHIP_VALIDATION', `${field} must be a list.`, 400);
  const clean = list.map(item => requiredText(item, field, countryCodes ? 2 : 1, countryCodes ? 2 : 200));
  const normalized = countryCodes ? clean.map(item => countryCode(item, field, false)) : clean;
  return [...new Set(normalized)].sort();
}

function workspaceRow(db, workspaceIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  if (!row) fail('TPRM_WORKSPACE_NOT_FOUND', 'Client workspace not found.', 404);
  return row;
}

function supplierRow(db, workspaceIdInput, supplierIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const supplierId = positiveId(supplierIdInput, 'supplierId');
  const row = db.prepare('SELECT * FROM suppliers WHERE workspace_id=? AND id=?').get(workspaceId, supplierId);
  if (!row) fail('TPRM_THIRD_PARTY_NOT_FOUND', 'Third party not found in this client workspace.', 404);
  return row;
}

function firmActor(db, workspaceIdInput, actorIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const actorId = positiveId(actorIdInput, 'actorId');
  const actor = db.prepare(`SELECT u.*,w.firm_id AS workspace_firm_id
    FROM users u JOIN workspaces w ON w.id=?
    WHERE u.id=? AND u.active=1 AND u.user_type='firm' AND u.firm_id=w.firm_id`).get(workspaceId, actorId);
  if (!actor) fail('TPRM_FIRM_ACTOR_REQUIRED', 'An active consultancy user for this client is required.', 403);
  return actor;
}

function relationshipRow(db, workspaceIdInput, relationshipIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const relationshipId = positiveId(relationshipIdInput, 'relationshipId');
  const row = db.prepare('SELECT * FROM tprm_service_relationships WHERE workspace_id=? AND id=?').get(workspaceId, relationshipId);
  if (!row) fail('TPRM_RELATIONSHIP_NOT_FOUND', 'Service relationship not found in this client workspace.', 404);
  return row;
}

function parseJson(value, fallback = null) {
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

// A consultancy status change must never become an alternate path for making
// the client's onboarding decision. Activation (including reactivation after
// suspension or offboarding) is authorised only by the latest, still-current
// positive client decision and its immutable, exact service-scope snapshot.
function relationshipActivationAuthority(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const relationship = relationshipRow(db, workspaceId, input.relationshipId);
  const decision = db.prepare(`SELECT d.* FROM tprm_client_decisions d
    WHERE d.workspace_id=? AND d.supplier_id=?
      AND NOT EXISTS (
        SELECT 1 FROM tprm_client_decisions successor
        WHERE successor.workspace_id=d.workspace_id
          AND successor.supplier_id=d.supplier_id
          AND successor.supersedes_id=d.id
      )
    ORDER BY d.version DESC,d.id DESC LIMIT 1`).get(workspaceId, relationship.supplier_id) || null;
  const today = cleanText(input.asOfDate) || now().slice(0, 10);
  const decisionAuthority = currentPositiveDecisionAuthority(db, workspaceId, relationship.supplier_id, {
    decision,
    asOfDate: today,
  });
  if (!decisionAuthority.authorised) {
    const messages = {
      TPRM_CLIENT_DECISION_REQUIRED: 'The service cannot be activated until the client records a positive onboarding decision for this exact service scope.',
      TPRM_POSITIVE_CLIENT_DECISION_REQUIRED: 'The latest client decision does not authorise this service to operate. Only the client can change that decision.',
      TPRM_CLIENT_DECISION_EXPIRED: 'The client onboarding decision has expired. Complete the governed reassessment and obtain a current client decision before activation.',
      TPRM_RISK_ACCEPTANCE_REQUIRED: 'The onboarding decision requires a governed risk acceptance before this service can be activated.',
      TPRM_RISK_ACCEPTANCE_EXPIRED: 'The risk acceptance supporting this onboarding decision has expired. Obtain a current client decision before activation.',
    };
    return {
      allowed: false,
      code: decisionAuthority.code,
      message: messages[decisionAuthority.code] || decisionAuthority.message,
      relationship,
      decision,
      decisionAuthority,
    };
  }
  const latestRecommendation = db.prepare(`SELECT recommendation.*
    FROM tprm_recommendations recommendation
    WHERE recommendation.workspace_id=? AND recommendation.supplier_id=?
      AND NOT EXISTS (
        SELECT 1 FROM tprm_recommendations successor
        WHERE successor.workspace_id=recommendation.workspace_id
          AND successor.supplier_id=recommendation.supplier_id
          AND successor.supersedes_id=recommendation.id
      )
    ORDER BY datetime(recommendation.issued_at) DESC,recommendation.id DESC LIMIT 1`)
    .get(workspaceId, relationship.supplier_id) || null;
  if (!latestRecommendation || latestRecommendation.id !== decision.recommendation_id) {
    return {
      allowed: false,
      code: 'TPRM_CLIENT_DECISION_STALE',
      message: 'A newer consultancy recommendation exists. The client must decide on the current recommendation before this service can be activated.',
      relationship,
      decision,
      latestRecommendation,
    };
  }
  const snapshot = parseJson(decision.decision_snapshot_json, {});
  const scopedRelationships = Array.isArray(snapshot && snapshot.serviceRelationships)
    ? snapshot.serviceRelationships
    : [];
  const scope = scopedRelationships.find(item => Number(item && item.id) === relationship.id) || null;
  if (!scope) {
    return {
      allowed: false,
      code: 'TPRM_RELATIONSHIP_NOT_CLIENT_AUTHORISED',
      message: 'The client decision does not include this exact service relationship. Assess this service and obtain the client’s decision before activation.',
      relationship,
      decision,
      latestRecommendation,
    };
  }
  return {
    allowed: true,
    code: null,
    message: null,
    relationship,
    decision,
    decisionAuthority,
    latestRecommendation,
    scope,
  };
}

function assertRelationshipActivationAuthority(db, input) {
  const authority = relationshipActivationAuthority(db, input);
  if (!authority.allowed) fail(authority.code, authority.message, 409, {
    relationshipId: authority.relationship.id,
    clientDecisionId: authority.decision && authority.decision.id || null,
  });
  return authority;
}

function dependencyEdgeRow(db, workspaceIdInput, edgeIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const edgeId = positiveId(edgeIdInput, 'edgeId');
  const row = db.prepare('SELECT * FROM tprm_dependency_edges WHERE workspace_id=? AND id=?').get(workspaceId, edgeId);
  if (!row) fail('TPRM_DEPENDENCY_NOT_FOUND', 'Dependency edge not found in this client workspace.', 404);
  return row;
}

function actorType(actor) {
  return actor.firm_role === 'manager' ? 'consultancy_manager' : 'consultant';
}

function recordEvent(db, input) {
  const previous = input.relationshipId
    ? db.prepare(`SELECT event_hash FROM tprm_relationship_events
        WHERE workspace_id=? AND relationship_id=? AND event_hash IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get(input.workspaceId, input.relationshipId)
    : null;
  const occurredAt = input.occurredAt || now();
  const payloadJson = stableStringify(input.payload || {});
  const previousHash = previous && previous.event_hash || null;
  const eventHash = sha256({
    workspaceId: input.workspaceId,
    relationshipId: input.relationshipId || null,
    eventType: input.eventType,
    actorUserId: input.actor && input.actor.id || null,
    actorName: input.actor && input.actor.name || input.actorName || 'System',
    reason: input.reason || null,
    payload: input.payload || {},
    previousHash,
    occurredAt,
  });
  const result = db.prepare(`INSERT INTO tprm_relationship_events
    (workspace_id,relationship_id,event_type,actor_user_id,actor_type,actor_name,reason,
     payload_json,idempotency_key,previous_event_hash,event_hash,occurred_at)
    VALUES (@workspaceId,@relationshipId,@eventType,@actorUserId,@actorType,@actorName,@reason,
            @payloadJson,@idempotencyKey,@previousHash,@eventHash,@occurredAt)`).run({
    workspaceId: input.workspaceId,
    relationshipId: input.relationshipId || null,
    eventType: input.eventType,
    actorUserId: input.actor && input.actor.id || null,
    actorType: input.actor ? actorType(input.actor) : (input.actorType || 'system'),
    actorName: input.actor && input.actor.name || input.actorName || 'System',
    reason: optionalText(input.reason),
    payloadJson,
    idempotencyKey: input.idempotencyKey || null,
    previousHash,
    eventHash,
    occurredAt,
  });
  return db.prepare('SELECT * FROM tprm_relationship_events WHERE id=?').get(Number(result.lastInsertRowid));
}

function _ensureLegalEntityForSupplier(db, input) {
  const supplier = supplierRow(db, input.workspaceId, input.supplierId);
  const existing = db.prepare('SELECT * FROM tprm_legal_entities WHERE workspace_id=? AND supplier_id=?')
    .get(supplier.workspace_id, supplier.id);
  if (existing) return existing;
  const actor = input.actor || (input.actorId ? firmActor(db, supplier.workspace_id, input.actorId) : null);
  const lei = input.lei ? requiredText(input.lei, 'LEI', 20, 20).toUpperCase() : null;
  if (lei && !/^[A-Z0-9]{20}$/.test(lei)) fail('TPRM_RELATIONSHIP_VALIDATION', 'LEI must contain 20 letters or digits.', 400);
  const result = db.prepare(`INSERT INTO tprm_legal_entities
    (workspace_id,supplier_id,legal_name,trading_name,entity_type,registration_number,
     registration_country_code,lei,parent_entity_name,ultimate_parent_name,status,
     identity_source,created_by,updated_by)
    VALUES (@workspaceId,@supplierId,@legalName,@tradingName,@entityType,@registrationNumber,
            @registrationCountryCode,@lei,@parentEntityName,@ultimateParentName,@status,
            'user_maintained',@actorId,@actorId)`).run({
    workspaceId: supplier.workspace_id,
    supplierId: supplier.id,
    legalName: requiredText(input.legalName || supplier.name, 'Legal name', 2, 300),
    tradingName: optionalText(input.tradingName, 300),
    entityType: enumValue(input.entityType, ['corporation', 'partnership', 'government', 'nonprofit', 'sole_trader', 'unknown'], 'Entity type', 'unknown'),
    registrationNumber: optionalText(input.registrationNumber, 200),
    registrationCountryCode: countryCode(input.registrationCountryCode),
    lei,
    parentEntityName: optionalText(input.parentEntityName || supplier.parent_company, 300),
    ultimateParentName: optionalText(input.ultimateParentName, 300),
    status: enumValue(input.entityStatus, ['active', 'inactive', 'merged', 'dissolved', 'unknown'], 'Entity status', 'unknown'),
    actorId: actor && actor.id || null,
  });
  return db.prepare('SELECT * FROM tprm_legal_entities WHERE id=?').get(Number(result.lastInsertRowid));
}

function ensureLegalEntityForSupplier(db, input) {
  return db.transaction(() => {
    workspaceRow(db, input.workspaceId);
    const actor = firmActor(db, input.workspaceId, input.actorId);
    return { legalEntity: _ensureLegalEntityForSupplier(db, { ...input, actor }) };
  }).immediate();
}

function relationshipFingerprint(input) {
  return sha256(input);
}

function createRelationship(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const supplierId = positiveId(input.supplierId, 'supplierId');
    workspaceRow(db, workspaceId);
    const supplier = supplierRow(db, workspaceId, supplierId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const key = idempotencyKey(input.idempotencyKey);
    const replay = key
      ? db.prepare('SELECT * FROM tprm_service_relationships WHERE workspace_id=? AND idempotency_key=?').get(workspaceId, key)
      : null;
    const legalEntity = input.legalEntityId
      ? db.prepare('SELECT * FROM tprm_legal_entities WHERE workspace_id=? AND supplier_id=? AND id=?')
        .get(workspaceId, supplierId, positiveId(input.legalEntityId, 'legalEntityId'))
      : replay
        ? db.prepare('SELECT * FROM tprm_legal_entities WHERE workspace_id=? AND supplier_id=? AND id=?')
          .get(workspaceId, supplierId, replay.legal_entity_id)
      : _ensureLegalEntityForSupplier(db, { ...input, workspaceId, supplierId, actor });
    if (!legalEntity) fail('TPRM_LEGAL_ENTITY_NOT_FOUND', 'Legal entity does not belong to this third party and client workspace.', 404);
    // Creation never grants operating authority. Even trusted server-side
    // callers must create an intake record and use updateRelationship for the
    // separately authorised client-decision transition to active.
    enumValue(input.status, RELATIONSHIP_STATUSES, 'Relationship status', 'intake');
    const status = 'intake';
    const relationshipKey = optionalText(input.relationshipKey, 100) || replay && replay.relationship_key || `rel-${supplierId}-${crypto.randomUUID()}`;
    const annualSpendMinor = integer(input.annualSpendMinor, 'Annual spend', { nullable: true });
    const currency = currencyCode(input.currency);
    if (annualSpendMinor != null && !currency) fail('TPRM_RELATIONSHIP_VALIDATION', 'Currency is required when annual spend is recorded.', 400);
    const alternateProviderRelationshipId = optionalId(input.alternateProviderRelationshipId, 'alternateProviderRelationshipId');
    if (alternateProviderRelationshipId) relationshipRow(db, workspaceId, alternateProviderRelationshipId);
    const facts = {
      workspaceId, supplierId, legalEntityId: legalEntity.id, relationshipKey,
      relationshipName: requiredText(input.relationshipName || input.name, 'Relationship name', 2, 300),
      serviceCategory: optionalText(input.serviceCategory, 200),
      serviceDescription: requiredText(input.serviceDescription || input.description, 'Service description', 2, 5000),
      provisionModel: enumValue(input.provisionModel, PROVISION_MODELS, 'Provision model', 'other'),
      status,
      criticality: enumValue(input.criticality, CRITICALITIES, 'Criticality', 'unknown'),
      dataAccess: enumValue(input.dataAccess, DATA_ACCESS_LEVELS, 'Data access', 'unknown'),
      annualSpendMinor, currency,
      privilegedAccess: bool(input.privilegedAccess),
      relationshipOwner: optionalText(input.relationshipOwner, 300),
      businessOwner: optionalText(input.businessOwner, 300),
      securityOwner: optionalText(input.securityOwner, 300),
      procurementOwner: optionalText(input.procurementOwner, 300),
      startDate: isoDate(input.startDate, 'Start date'),
      targetEndDate: isoDate(input.targetEndDate, 'Target end date'),
      rtoHours: integer(input.rtoHours, 'RTO hours', { nullable: true }),
      rpoHours: integer(input.rpoHours, 'RPO hours', { nullable: true }),
      maxTolerableDisruptionHours: integer(input.maxTolerableDisruptionHours, 'Maximum tolerable disruption hours', { nullable: true }),
      substitutability: enumValue(input.substitutability, SUBSTITUTABILITY, 'Substitutability', 'unknown'),
      alternateProviderRelationshipId,
      estimatedExitDays: integer(input.estimatedExitDays, 'Estimated exit days', { nullable: true }),
      exitPlanStatus: enumValue(input.exitPlanStatus, ['not_started', 'documented', 'tested', 'needs_update', 'not_applicable'], 'Exit plan status', 'not_started'),
      lastExitTestedAt: isoDate(input.lastExitTestedAt, 'Last exit test date'),
      exitOwner: optionalText(input.exitOwner, 300),
      exitStrategy: optionalText(input.exitStrategy, 5000),
      transitionAssistance: optionalText(input.transitionAssistance, 5000),
      dataReturnDeletionRequirements: optionalText(input.dataReturnDeletionRequirements, 5000),
      soleSource: bool(input.soleSource),
      materialOutsourcing: bool(input.materialOutsourcing),
      regulatedService: bool(input.regulatedService),
      isPrimary: bool(input.isPrimary),
    };
    const fingerprint = relationshipFingerprint(facts);
    if (replay) {
      if (fingerprint !== replay.request_fingerprint) {
        fail('TPRM_RELATIONSHIP_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different relationship facts.');
      }
      return { relationship: replay, legalEntity, replayed: true };
    }
    const occurredAt = now();
    const result = db.prepare(`INSERT INTO tprm_service_relationships
      (workspace_id,supplier_id,legal_entity_id,relationship_key,relationship_name,service_category,
       service_description,provision_model,status,criticality,data_access,privileged_access,
       annual_spend_minor,currency,relationship_owner,business_owner,security_owner,procurement_owner,
       start_date,target_end_date,rto_hours,rpo_hours,max_tolerable_disruption_hours,substitutability,
       alternate_provider_relationship_id,estimated_exit_days,exit_plan_status,last_exit_tested_at,
       exit_owner,exit_strategy,transition_assistance,data_return_deletion_requirements,sole_source,
       material_outsourcing,regulated_service,source,is_primary,idempotency_key,request_fingerprint,
       created_by,created_at,updated_by,updated_at,offboarding_started_at,terminated_at)
      VALUES (@workspaceId,@supplierId,@legalEntityId,@relationshipKey,@relationshipName,@serviceCategory,
       @serviceDescription,@provisionModel,@status,@criticality,@dataAccess,@privilegedAccess,
       @annualSpendMinor,@currency,@relationshipOwner,@businessOwner,@securityOwner,@procurementOwner,
       @startDate,@targetEndDate,@rtoHours,@rpoHours,@maxTolerableDisruptionHours,@substitutability,
       @alternateProviderRelationshipId,@estimatedExitDays,@exitPlanStatus,@lastExitTestedAt,
       @exitOwner,@exitStrategy,@transitionAssistance,@dataReturnDeletionRequirements,@soleSource,
       @materialOutsourcing,@regulatedService,'user_maintained',@isPrimary,@idempotencyKey,@fingerprint,
       @actorId,@occurredAt,@actorId,@occurredAt,@offboardingStartedAt,@terminatedAt)`).run({
      ...facts,
      idempotencyKey: key,
      fingerprint,
      actorId: actor.id,
      occurredAt,
      offboardingStartedAt: null,
      terminatedAt: null,
    });
    const relationship = relationshipRow(db, workspaceId, Number(result.lastInsertRowid));
    recordEvent(db, {
      workspaceId, relationshipId: relationship.id, eventType: 'relationship_created', actor,
      reason: optionalText(input.reason) || 'Service relationship created.',
      payload: { supplierId: supplier.id, legalEntityId: legalEntity.id, relationshipKey, status, criticality: relationship.criticality },
      idempotencyKey: key,
      occurredAt,
    });
    return { relationship, legalEntity, replayed: false };
  }).immediate();
}

const RELATIONSHIP_PATCHERS = Object.freeze({
  relationshipName: ['relationship_name', value => requiredText(value, 'Relationship name', 2, 300)],
  serviceCategory: ['service_category', value => optionalText(value, 200)],
  serviceDescription: ['service_description', value => requiredText(value, 'Service description', 2, 5000)],
  provisionModel: ['provision_model', value => enumValue(value, PROVISION_MODELS, 'Provision model')],
  status: ['status', value => enumValue(value, RELATIONSHIP_STATUSES, 'Relationship status')],
  criticality: ['criticality', value => enumValue(value, CRITICALITIES, 'Criticality')],
  dataAccess: ['data_access', value => enumValue(value, DATA_ACCESS_LEVELS, 'Data access')],
  privilegedAccess: ['privileged_access', value => bool(value)],
  annualSpendMinor: ['annual_spend_minor', value => integer(value, 'Annual spend', { nullable: true })],
  currency: ['currency', value => currencyCode(value)],
  relationshipOwner: ['relationship_owner', value => optionalText(value, 300)],
  businessOwner: ['business_owner', value => optionalText(value, 300)],
  securityOwner: ['security_owner', value => optionalText(value, 300)],
  procurementOwner: ['procurement_owner', value => optionalText(value, 300)],
  startDate: ['start_date', value => isoDate(value, 'Start date')],
  targetEndDate: ['target_end_date', value => isoDate(value, 'Target end date')],
  rtoHours: ['rto_hours', value => integer(value, 'RTO hours', { nullable: true })],
  rpoHours: ['rpo_hours', value => integer(value, 'RPO hours', { nullable: true })],
  maxTolerableDisruptionHours: ['max_tolerable_disruption_hours', value => integer(value, 'Maximum tolerable disruption hours', { nullable: true })],
  substitutability: ['substitutability', value => enumValue(value, SUBSTITUTABILITY, 'Substitutability')],
  alternateProviderRelationshipId: ['alternate_provider_relationship_id', value => optionalId(value, 'alternateProviderRelationshipId')],
  estimatedExitDays: ['estimated_exit_days', value => integer(value, 'Estimated exit days', { nullable: true })],
  exitPlanStatus: ['exit_plan_status', value => enumValue(value, ['not_started', 'documented', 'tested', 'needs_update', 'not_applicable'], 'Exit plan status')],
  lastExitTestedAt: ['last_exit_tested_at', value => isoDate(value, 'Last exit test date')],
  exitOwner: ['exit_owner', value => optionalText(value, 300)],
  exitStrategy: ['exit_strategy', value => optionalText(value, 5000)],
  transitionAssistance: ['transition_assistance', value => optionalText(value, 5000)],
  dataReturnDeletionRequirements: ['data_return_deletion_requirements', value => optionalText(value, 5000)],
  soleSource: ['sole_source', value => bool(value)],
  materialOutsourcing: ['material_outsourcing', value => bool(value)],
  regulatedService: ['regulated_service', value => bool(value)],
});

function updateRelationship(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const relationship = relationshipRow(db, workspaceId, input.relationshipId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const expected = integer(input.expectedRowVersion, 'Expected row version', { minimum: 1, nullable: false });
    if (relationship.row_version !== expected) {
      fail('TPRM_RELATIONSHIP_CONFLICT', 'Service relationship changed after it was opened. Refresh and try again.', 409, { expected, actual: relationship.row_version });
    }
    const patch = input.patch || input.changes || {};
    const assignments = [];
    const values = { workspaceId, relationshipId: relationship.id, expected, actorId: actor.id, updatedAt: now() };
    const changed = {};
    for (const [apiField, [column, normalizer]] of Object.entries(RELATIONSHIP_PATCHERS)) {
      if (!Object.prototype.hasOwnProperty.call(patch, apiField)) continue;
      const value = normalizer(patch[apiField]);
      if (column === 'alternate_provider_relationship_id' && value != null) {
        if (value === relationship.id) fail('TPRM_RELATIONSHIP_VALIDATION', 'A relationship cannot be its own alternate provider.', 400);
        relationshipRow(db, workspaceId, value);
      }
      assignments.push(`${column}=@${apiField}`);
      values[apiField] = value;
      changed[apiField] = { from: relationship[column], to: value };
    }
    if (!assignments.length) fail('TPRM_RELATIONSHIP_VALIDATION', 'No supported relationship changes were supplied.', 400);
    const finalSpend = Object.hasOwn(values, 'annualSpendMinor') ? values.annualSpendMinor : relationship.annual_spend_minor;
    const finalCurrency = Object.hasOwn(values, 'currency') ? values.currency : relationship.currency;
    if (finalSpend != null && !finalCurrency) fail('TPRM_RELATIONSHIP_VALIDATION', 'Currency is required when annual spend is recorded.', 400);
    let activationAuthority = null;
    if (Object.hasOwn(values, 'status')) {
      if (values.status === 'active' && relationship.status !== 'active') {
        activationAuthority = assertRelationshipActivationAuthority(db, {
          workspaceId,
          relationshipId: relationship.id,
        });
      }
      if (values.status === 'offboarding') {
        assignments.push('offboarding_started_at=@offboardingStartedAt');
        values.offboardingStartedAt = values.updatedAt;
      } else if (values.status === 'terminated') {
        assignments.push('terminated_at=@terminatedAt');
        values.terminatedAt = values.updatedAt;
      } else {
        assignments.push('offboarding_started_at=NULL', 'terminated_at=NULL');
      }
    }
    const reason = requiredText(input.reason, 'Change reason', 5, 2000);
    const result = db.prepare(`UPDATE tprm_service_relationships
      SET ${assignments.join(',')},updated_by=@actorId,updated_at=@updatedAt,row_version=row_version+1
      WHERE workspace_id=@workspaceId AND id=@relationshipId AND row_version=@expected`).run(values);
    if (result.changes !== 1) fail('TPRM_RELATIONSHIP_CONFLICT', 'Service relationship changed during update. Refresh and try again.');
    const updated = relationshipRow(db, workspaceId, relationship.id);
    recordEvent(db, {
      workspaceId, relationshipId: relationship.id,
      eventType: Object.hasOwn(values, 'status') ? 'relationship_status_changed' : 'relationship_updated',
      actor, reason, payload: {
        changed,
        fromRowVersion: expected,
        toRowVersion: updated.row_version,
        clientActivationAuthority: activationAuthority ? {
          decisionId: activationAuthority.decision.id,
          recommendationId: activationAuthority.latestRecommendation.id,
          relationshipId: activationAuthority.relationship.id,
        } : null,
      },
    });
    return { relationship: updated };
  }).immediate();
}

function currentContract(db, workspaceIdInput, relationshipIdInput, familyKeyInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const relationshipId = positiveId(relationshipIdInput, 'relationshipId');
  const familyKey = requiredText(familyKeyInput, 'Contract family key', 3, 100);
  return db.prepare(`SELECT c.* FROM tprm_relationship_contracts c
    WHERE c.workspace_id=? AND c.relationship_id=? AND c.contract_family_key=?
      AND NOT EXISTS (SELECT 1 FROM tprm_relationship_contracts n WHERE n.supersedes_id=c.id)
    ORDER BY c.version DESC LIMIT 1`).get(workspaceId, relationshipId, familyKey) || null;
}

function addContractVersion(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const relationship = relationshipRow(db, workspaceId, input.relationshipId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const familyKey = requiredText(input.contractFamilyKey, 'Contract family key', 3, 100);
    const key = idempotencyKey(input.idempotencyKey);
    const facts = {
      workspaceId,
      relationshipId: relationship.id,
      contractFamilyKey: familyKey,
      contractType: enumValue(input.contractType, CONTRACT_TYPES, 'Contract type'),
      status: enumValue(input.status, CONTRACT_STATUSES, 'Contract status'),
      title: requiredText(input.title, 'Contract title', 2, 300),
      reference: optionalText(input.reference, 300),
      effectiveDate: isoDate(input.effectiveDate, 'Effective date'),
      endDate: isoDate(input.endDate, 'End date'),
      renewalDate: isoDate(input.renewalDate, 'Renewal date'),
      noticeDeadline: isoDate(input.noticeDeadline, 'Notice deadline'),
      autoRenew: bool(input.autoRenew),
      committedSpendMinor: integer(input.committedSpendMinor, 'Committed spend', { nullable: true }),
      currency: currencyCode(input.currency),
      terminationRights: optionalText(input.terminationRights, 5000),
      transitionAssistance: optionalText(input.transitionAssistance, 5000),
      dataReturnDeletionTerms: optionalText(input.dataReturnDeletionTerms, 5000),
      auditRights: optionalText(input.auditRights, 5000),
      incidentNotificationHours: integer(input.incidentNotificationHours, 'Incident notification hours', { nullable: true }),
      subprocessorControls: optionalText(input.subprocessorControls, 5000),
      governingLawCountryCode: countryCode(input.governingLawCountryCode),
      documentSha256: hashValue(input.documentSha256, 'Document hash'),
    };
    if (facts.committedSpendMinor != null && !facts.currency) {
      fail('TPRM_RELATIONSHIP_VALIDATION', 'Currency is required when committed spend is recorded.', 400);
    }
    if (['executed', 'expired', 'terminated'].includes(facts.status) && (!facts.reference || !facts.effectiveDate)) {
      fail('TPRM_RELATIONSHIP_VALIDATION', 'Executed or concluded contract versions require a reference and effective date.', 400);
    }
    if (facts.endDate && facts.effectiveDate && facts.endDate < facts.effectiveDate) {
      fail('TPRM_RELATIONSHIP_VALIDATION', 'Contract end date cannot precede the effective date.', 400);
    }
    const fingerprint = sha256(facts);
    if (key) {
      const replay = db.prepare('SELECT * FROM tprm_relationship_contracts WHERE workspace_id=? AND idempotency_key=?').get(workspaceId, key);
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) fail('TPRM_CONTRACT_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different contract facts.');
        return { contract: replay, replayed: true };
      }
    }
    if (!Object.prototype.hasOwnProperty.call(input, 'expectedCurrentContractId')) {
      fail('TPRM_CONTRACT_CONCURRENCY_REQUIRED', 'Expected current contract version is required.', 400);
    }
    const current = currentContract(db, workspaceId, relationship.id, familyKey);
    const expected = optionalId(input.expectedCurrentContractId, 'expectedCurrentContractId');
    if ((current && current.id || null) !== expected) {
      fail('TPRM_CONTRACT_CONFLICT', 'Contract family changed after it was opened. Refresh and try again.', 409, {
        expected, actual: current && current.id || null,
      });
    }
    const recordedAt = now();
    const version = current ? current.version + 1 : 1;
    const previousContractHash = current && current.contract_hash || null;
    const contractHash = sha256({ ...facts, version, supersedesId: current && current.id || null, previousContractHash, actorId: actor.id, recordedAt });
    const result = db.prepare(`INSERT INTO tprm_relationship_contracts
      (workspace_id,relationship_id,contract_family_key,version,supersedes_id,contract_type,status,
       title,reference,effective_date,end_date,renewal_date,notice_deadline,auto_renew,
       committed_spend_minor,currency,termination_rights,transition_assistance,
       data_return_deletion_terms,audit_rights,incident_notification_hours,subprocessor_controls,
       governing_law_country_code,document_sha256,contract_hash,previous_contract_hash,
       idempotency_key,request_fingerprint,recorded_by,recorded_at)
      VALUES (@workspaceId,@relationshipId,@contractFamilyKey,@version,@supersedesId,@contractType,@status,
       @title,@reference,@effectiveDate,@endDate,@renewalDate,@noticeDeadline,@autoRenew,
       @committedSpendMinor,@currency,@terminationRights,@transitionAssistance,
       @dataReturnDeletionTerms,@auditRights,@incidentNotificationHours,@subprocessorControls,
       @governingLawCountryCode,@documentSha256,@contractHash,@previousContractHash,
       @idempotencyKey,@fingerprint,@actorId,@recordedAt)`).run({
      ...facts,
      version,
      supersedesId: current && current.id || null,
      contractHash,
      previousContractHash,
      idempotencyKey: key,
      fingerprint,
      actorId: actor.id,
      recordedAt,
    });
    const contract = db.prepare('SELECT * FROM tprm_relationship_contracts WHERE id=?').get(Number(result.lastInsertRowid));
    recordEvent(db, {
      workspaceId, relationshipId: relationship.id, eventType: 'contract_version_added', actor,
      reason: requiredText(input.reason, 'Contract version reason', 5, 2000),
      payload: { contractId: contract.id, familyKey, version, status: contract.status, supersedesId: contract.supersedes_id },
      idempotencyKey: key,
      occurredAt: recordedAt,
    });
    return { contract, replayed: false };
  }).immediate();
}

function _createDependencyEntity(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = input.actor || firmActor(db, workspaceId, input.actorId);
  const entityKey = optionalText(input.entityKey, 100) || `dep-${crypto.randomUUID()}`;
  if (db.prepare('SELECT 1 FROM tprm_dependency_entities WHERE workspace_id=? AND entity_key=?').get(workspaceId, entityKey)) {
    fail('TPRM_DEPENDENCY_ENTITY_KEY_CONFLICT', 'Dependency entity key already exists. Reuse its id explicitly or choose another key.');
  }
  const knownSupplierId = optionalId(input.knownSupplierId, 'knownSupplierId');
  if (knownSupplierId) supplierRow(db, workspaceId, knownSupplierId);
  const result = db.prepare(`INSERT INTO tprm_dependency_entities
    (workspace_id,entity_key,name,entity_type,legal_country_code,registration_number,
     parent_entity_name,known_supplier_id,source,created_by)
    VALUES (@workspaceId,@entityKey,@name,@entityType,@legalCountryCode,@registrationNumber,
            @parentEntityName,@knownSupplierId,@source,@actorId)`).run({
    workspaceId,
    entityKey,
    name: requiredText(input.name, 'Dependency entity name', 2, 300),
    entityType: enumValue(input.entityType, ['subprocessor', 'fourth_party', 'infrastructure_provider', 'other'], 'Dependency entity type'),
    legalCountryCode: countryCode(input.legalCountryCode),
    registrationNumber: optionalText(input.registrationNumber, 200),
    parentEntityName: optionalText(input.parentEntityName, 300),
    knownSupplierId,
    source: enumValue(input.source, ['user_disclosed', 'provider_disclosed', 'contractual', 'import'], 'Dependency entity source', 'user_disclosed'),
    actorId: actor.id,
  });
  return db.prepare('SELECT * FROM tprm_dependency_entities WHERE id=?').get(Number(result.lastInsertRowid));
}

function createDependencyEntity(db, input) {
  return db.transaction(() => {
    workspaceRow(db, input.workspaceId);
    const actor = firmActor(db, input.workspaceId, input.actorId);
    return { dependencyEntity: _createDependencyEntity(db, { ...input, actor }) };
  }).immediate();
}

function wouldCreateRelationshipCycle(db, workspaceId, sourceRelationshipId, targetRelationshipId) {
  const rows = db.prepare(`SELECT source_relationship_id,target_relationship_id
    FROM tprm_dependency_edges
    WHERE workspace_id=? AND target_relationship_id IS NOT NULL AND status NOT IN ('rejected','ended')`).all(workspaceId);
  const outgoing = new Map();
  for (const row of rows) {
    if (!outgoing.has(row.source_relationship_id)) outgoing.set(row.source_relationship_id, []);
    outgoing.get(row.source_relationship_id).push(row.target_relationship_id);
  }
  const queue = [targetRelationshipId];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (id === sourceRelationshipId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    (outgoing.get(id) || []).forEach(next => queue.push(next));
  }
  return false;
}

function addDependencyEdge(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const source = relationshipRow(db, workspaceId, input.sourceRelationshipId || input.relationshipId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const targetRelationshipId = optionalId(input.targetRelationshipId, 'targetRelationshipId');
    let dependencyEntityId = optionalId(input.dependencyEntityId, 'dependencyEntityId');
    const key = idempotencyKey(input.idempotencyKey);
    if ((targetRelationshipId ? 1 : 0) + (dependencyEntityId ? 1 : 0) + (input.dependencyEntity ? 1 : 0) !== 1) {
      fail('TPRM_DEPENDENCY_TARGET_REQUIRED', 'Choose exactly one portfolio relationship or external dependency entity.', 400);
    }
    if (targetRelationshipId) {
      relationshipRow(db, workspaceId, targetRelationshipId);
      if (targetRelationshipId === source.id || wouldCreateRelationshipCycle(db, workspaceId, source.id, targetRelationshipId)) {
        fail('TPRM_DEPENDENCY_CYCLE', 'Dependency edge would create a circular service chain.', 409);
      }
    }
    if (key && input.dependencyEntity && !optionalText(input.dependencyEntity.entityKey, 100)) {
      fail('TPRM_RELATIONSHIP_IDEMPOTENCY_INVALID', 'An explicit dependency entity key is required when idempotently creating an entity with an edge.', 400);
    }
    const facts = {
      workspaceId,
      sourceRelationshipId: source.id,
      edgeKey: optionalText(input.edgeKey, 100) || `edge-${crypto.randomUUID()}`,
      targetRelationshipId,
      dependencyEntityId,
      dependencyEntityDefinition: input.dependencyEntity ? stableValue(input.dependencyEntity) : null,
      dependencyType: enumValue(input.dependencyType, DEPENDENCY_TYPES, 'Dependency type'),
      serviceDescription: requiredText(input.serviceDescription, 'Dependency service description', 2, 5000),
      dataAccess: enumValue(input.dataAccess, DATA_ACCESS_LEVELS, 'Data access', 'unknown'),
      countries: textArray(input.countries, 'Dependency countries', { countryCodes: true }),
      criticality: enumValue(input.criticality, ['low', 'moderate', 'high', 'critical'], 'Criticality', 'moderate'),
      concentrationKey: optionalText(input.concentrationKey, 200),
      singlePointOfFailure: bool(input.singlePointOfFailure),
      substitutability: enumValue(input.substitutability, SUBSTITUTABILITY, 'Substitutability', 'unknown'),
      dueDiligenceRequired: bool(input.dueDiligenceRequired, true),
      evidenceSummary: optionalText(input.evidenceSummary, 5000),
      status: enumValue(input.status, DEPENDENCY_STATUSES, 'Dependency status', 'disclosed'),
    };
    if (facts.status === 'ended') fail('TPRM_RELATIONSHIP_VALIDATION', 'A new dependency edge cannot begin in ended status.', 400);
    const fingerprint = sha256(facts);
    if (key) {
      const replay = db.prepare('SELECT * FROM tprm_dependency_edges WHERE workspace_id=? AND idempotency_key=?').get(workspaceId, key);
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) fail('TPRM_DEPENDENCY_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different dependency facts.');
        return { edge: replay, dependencyEntity: replay.dependency_entity_id ? db.prepare('SELECT * FROM tprm_dependency_entities WHERE id=?').get(replay.dependency_entity_id) : null, replayed: true };
      }
    }
    let dependencyEntity = null;
    if (input.dependencyEntity) {
      dependencyEntity = _createDependencyEntity(db, { ...input.dependencyEntity, workspaceId, actor });
      dependencyEntityId = dependencyEntity.id;
    } else if (dependencyEntityId) {
      dependencyEntity = db.prepare('SELECT * FROM tprm_dependency_entities WHERE workspace_id=? AND id=?').get(workspaceId, dependencyEntityId);
      if (!dependencyEntity) fail('TPRM_DEPENDENCY_ENTITY_NOT_FOUND', 'Dependency entity not found in this client workspace.', 404);
    }
    const occurredAt = now();
    const result = db.prepare(`INSERT INTO tprm_dependency_edges
      (workspace_id,source_relationship_id,edge_key,target_relationship_id,dependency_entity_id,
       dependency_type,service_description,data_access,countries_json,criticality,concentration_key,
       single_point_of_failure,substitutability,due_diligence_required,evidence_summary,status,
       effective_from,idempotency_key,request_fingerprint,created_by,created_at,updated_at)
      VALUES (@workspaceId,@sourceRelationshipId,@edgeKey,@targetRelationshipId,@dependencyEntityId,
       @dependencyType,@serviceDescription,@dataAccess,@countriesJson,@criticality,@concentrationKey,
       @singlePointOfFailure,@substitutability,@dueDiligenceRequired,@evidenceSummary,@status,
       @occurredAt,@idempotencyKey,@fingerprint,@actorId,@occurredAt,@occurredAt)`).run({
      ...facts,
      dependencyEntityId,
      countriesJson: JSON.stringify(facts.countries),
      idempotencyKey: key,
      fingerprint,
      actorId: actor.id,
      occurredAt,
    });
    const edge = dependencyEdgeRow(db, workspaceId, Number(result.lastInsertRowid));
    recordEvent(db, {
      workspaceId, relationshipId: source.id, eventType: 'dependency_edge_added', actor,
      reason: requiredText(input.reason, 'Dependency rationale', 5, 2000),
      payload: { edgeId: edge.id, targetRelationshipId, dependencyEntityId, dependencyType: edge.dependency_type, criticality: edge.criticality },
      idempotencyKey: key,
      occurredAt,
    });
    return { edge, dependencyEntity, replayed: false };
  }).immediate();
}

function transitionDependencyEdge(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const edge = dependencyEdgeRow(db, workspaceId, input.edgeId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const expected = integer(input.expectedRowVersion, 'Expected row version', { minimum: 1, nullable: false });
    if (edge.row_version !== expected) fail('TPRM_DEPENDENCY_CONFLICT', 'Dependency edge changed after it was opened. Refresh and try again.');
    const status = enumValue(input.status, DEPENDENCY_STATUSES, 'Dependency status');
    if (status === edge.status) fail('TPRM_RELATIONSHIP_VALIDATION', 'Dependency edge is already in that status.', 400);
    const occurredAt = now();
    const result = db.prepare(`UPDATE tprm_dependency_edges
      SET status=?,evidence_summary=COALESCE(?,evidence_summary),ended_at=?,updated_by=?,updated_at=?,row_version=row_version+1
      WHERE workspace_id=? AND id=? AND row_version=?`).run(
      status, optionalText(input.evidenceSummary, 5000), status === 'ended' ? occurredAt : null,
      actor.id, occurredAt, workspaceId, edge.id, expected
    );
    if (result.changes !== 1) fail('TPRM_DEPENDENCY_CONFLICT', 'Dependency edge changed during update. Refresh and try again.');
    const updated = dependencyEdgeRow(db, workspaceId, edge.id);
    recordEvent(db, {
      workspaceId, relationshipId: edge.source_relationship_id, eventType: 'dependency_status_changed', actor,
      reason: requiredText(input.reason, 'Dependency status reason', 5, 2000),
      payload: { edgeId: edge.id, from: edge.status, to: status, fromRowVersion: expected, toRowVersion: updated.row_version },
    });
    return { edge: updated };
  }).immediate();
}

function createBusinessService(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    workspaceRow(db, workspaceId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const serviceKey = optionalText(input.serviceKey, 100) || `business-${crypto.randomUUID()}`;
    if (db.prepare('SELECT 1 FROM tprm_business_services WHERE workspace_id=? AND service_key=?').get(workspaceId, serviceKey)) {
      fail('TPRM_BUSINESS_SERVICE_KEY_CONFLICT', 'Business service key already exists in this client workspace.');
    }
    const result = db.prepare(`INSERT INTO tprm_business_services
      (workspace_id,service_key,name,description,owner_name,criticality,impact_tolerance_hours,
       rto_hours,rpo_hours,regulatory_designations_json,status,created_by,updated_by)
      VALUES (@workspaceId,@serviceKey,@name,@description,@ownerName,@criticality,@impactToleranceHours,
       @rtoHours,@rpoHours,@regulatoryDesignationsJson,'active',@actorId,@actorId)`).run({
      workspaceId,
      serviceKey,
      name: requiredText(input.name, 'Business service name', 2, 300),
      description: optionalText(input.description, 5000),
      ownerName: optionalText(input.ownerName, 300),
      criticality: enumValue(input.criticality, ['low', 'moderate', 'high', 'critical'], 'Criticality', 'moderate'),
      impactToleranceHours: integer(input.impactToleranceHours, 'Impact tolerance hours', { nullable: true }),
      rtoHours: integer(input.rtoHours, 'RTO hours', { nullable: true }),
      rpoHours: integer(input.rpoHours, 'RPO hours', { nullable: true }),
      regulatoryDesignationsJson: JSON.stringify(textArray(input.regulatoryDesignations, 'Regulatory designations')),
      actorId: actor.id,
    });
    return { businessService: db.prepare('SELECT * FROM tprm_business_services WHERE id=?').get(Number(result.lastInsertRowid)) };
  }).immediate();
}

function linkBusinessService(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const relationship = relationshipRow(db, workspaceId, input.relationshipId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const businessServiceId = positiveId(input.businessServiceId, 'businessServiceId');
    const service = db.prepare('SELECT * FROM tprm_business_services WHERE workspace_id=? AND id=? AND status=?')
      .get(workspaceId, businessServiceId, 'active');
    if (!service) fail('TPRM_BUSINESS_SERVICE_NOT_FOUND', 'Active business service not found in this client workspace.', 404);
    const result = db.prepare(`INSERT INTO tprm_relationship_business_dependencies
      (workspace_id,relationship_id,business_service_id,dependency_type,criticality,
       minimum_capacity_percent,maximum_outage_hours,manual_workaround,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      workspaceId, relationship.id, service.id,
      enumValue(input.dependencyType, ['essential', 'significant', 'supporting'], 'Business dependency type'),
      enumValue(input.criticality, ['low', 'moderate', 'high', 'critical'], 'Criticality', service.criticality),
      integer(input.minimumCapacityPercent, 'Minimum capacity percent', { minimum: 0, maximum: 100, nullable: true }),
      integer(input.maximumOutageHours, 'Maximum outage hours', { nullable: true }),
      optionalText(input.manualWorkaround, 5000), actor.id
    );
    const dependency = db.prepare('SELECT * FROM tprm_relationship_business_dependencies WHERE id=?')
      .get(Number(result.lastInsertRowid));
    recordEvent(db, {
      workspaceId, relationshipId: relationship.id, eventType: 'business_dependency_added', actor,
      reason: requiredText(input.reason, 'Business dependency rationale', 5, 2000),
      payload: { dependencyId: dependency.id, businessServiceId: service.id, dependencyType: dependency.dependency_type, criticality: dependency.criticality },
    });
    return { dependency, businessService: service };
  }).immediate();
}

function endBusinessDependency(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const dependencyId = positiveId(input.dependencyId, 'dependencyId');
    const dependency = db.prepare('SELECT * FROM tprm_relationship_business_dependencies WHERE workspace_id=? AND id=?')
      .get(workspaceId, dependencyId);
    if (!dependency) fail('TPRM_BUSINESS_DEPENDENCY_NOT_FOUND', 'Business dependency not found in this client workspace.', 404);
    const actor = firmActor(db, workspaceId, input.actorId);
    const expected = integer(input.expectedRowVersion, 'Expected row version', { minimum: 1, nullable: false });
    if (dependency.row_version !== expected) fail('TPRM_BUSINESS_DEPENDENCY_CONFLICT', 'Business dependency changed after it was opened.');
    const occurredAt = now();
    const result = db.prepare(`UPDATE tprm_relationship_business_dependencies
      SET status='ended',ended_at=?,updated_by=?,updated_at=?,row_version=row_version+1
      WHERE workspace_id=? AND id=? AND status='active' AND row_version=?`).run(
      occurredAt, actor.id, occurredAt, workspaceId, dependency.id, expected
    );
    if (result.changes !== 1) fail('TPRM_BUSINESS_DEPENDENCY_CONFLICT', 'Business dependency is no longer active.');
    const updated = db.prepare('SELECT * FROM tprm_relationship_business_dependencies WHERE id=?').get(dependency.id);
    recordEvent(db, {
      workspaceId, relationshipId: dependency.relationship_id, eventType: 'business_dependency_ended', actor,
      reason: requiredText(input.reason, 'End reason', 5, 2000), payload: { dependencyId: dependency.id },
    });
    return { dependency: updated };
  }).immediate();
}

function currentLocation(db, workspaceIdInput, relationshipIdInput, locationKeyInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const relationshipId = positiveId(relationshipIdInput, 'relationshipId');
  const locationKey = requiredText(locationKeyInput, 'Location key', 3, 100);
  return db.prepare(`SELECT l.* FROM tprm_relationship_locations l
    WHERE l.workspace_id=? AND l.relationship_id=? AND l.location_key=?
      AND NOT EXISTS (SELECT 1 FROM tprm_relationship_locations n WHERE n.supersedes_id=l.id)
    ORDER BY l.version DESC LIMIT 1`).get(workspaceId, relationshipId, locationKey) || null;
}

function addLocationExposure(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const relationship = relationshipRow(db, workspaceId, input.relationshipId);
    const actor = firmActor(db, workspaceId, input.actorId);
    const locationKey = requiredText(input.locationKey, 'Location key', 3, 100);
    if (!Object.prototype.hasOwnProperty.call(input, 'expectedCurrentLocationId')) {
      fail('TPRM_LOCATION_CONCURRENCY_REQUIRED', 'Expected current location assertion is required.', 400);
    }
    const current = currentLocation(db, workspaceId, relationship.id, locationKey);
    const expected = optionalId(input.expectedCurrentLocationId, 'expectedCurrentLocationId');
    if ((current && current.id || null) !== expected) {
      fail('TPRM_LOCATION_CONFLICT', 'Location assertion changed after it was opened. Refresh and try again.', 409, {
        expected, actual: current && current.id || null,
      });
    }
    const facts = {
      workspaceId,
      relationshipId: relationship.id,
      locationKey,
      exposureType: enumValue(input.exposureType, LOCATION_TYPES, 'Location exposure type'),
      countryCode: countryCode(input.countryCode, 'Country code', false),
      region: optionalText(input.region, 300),
      siteReference: optionalText(input.siteReference, 300),
      dataCategories: textArray(input.dataCategories, 'Data categories'),
      transferMechanism: enumValue(input.transferMechanism, ['adequacy', 'scc', 'bcr', 'derogation', 'local_only', 'not_applicable', 'unknown'], 'Transfer mechanism', 'unknown'),
      criticality: enumValue(input.criticality, ['low', 'moderate', 'high', 'critical'], 'Criticality', 'moderate'),
      status: enumValue(input.status, ['planned', 'current', 'exited'], 'Location status', 'current'),
      effectiveFrom: isoDate(input.effectiveFrom, 'Effective from date'),
      effectiveTo: isoDate(input.effectiveTo, 'Effective to date'),
      assertionSource: enumValue(input.assertionSource, ['user_maintained', 'contract', 'provider_disclosure', 'evidence', 'import'], 'Assertion source', 'user_maintained'),
    };
    if (facts.status === 'exited' && !facts.effectiveTo) fail('TPRM_RELATIONSHIP_VALIDATION', 'Exited location assertions require an effective-to date.', 400);
    const version = current ? current.version + 1 : 1;
    const recordedAt = now();
    const previousAssertionHash = current && current.assertion_hash || null;
    const assertionHash = sha256({ ...facts, version, supersedesId: current && current.id || null, previousAssertionHash, actorId: actor.id, recordedAt });
    const result = db.prepare(`INSERT INTO tprm_relationship_locations
      (workspace_id,relationship_id,location_key,version,supersedes_id,exposure_type,country_code,
       region,site_reference,data_categories_json,transfer_mechanism,criticality,status,effective_from,
       effective_to,assertion_source,assertion_hash,previous_assertion_hash,recorded_by,recorded_at)
      VALUES (@workspaceId,@relationshipId,@locationKey,@version,@supersedesId,@exposureType,@countryCode,
       @region,@siteReference,@dataCategoriesJson,@transferMechanism,@criticality,@status,@effectiveFrom,
       @effectiveTo,@assertionSource,@assertionHash,@previousAssertionHash,@actorId,@recordedAt)`).run({
      ...facts,
      version,
      supersedesId: current && current.id || null,
      dataCategoriesJson: JSON.stringify(facts.dataCategories),
      assertionHash,
      previousAssertionHash,
      actorId: actor.id,
      recordedAt,
    });
    const location = db.prepare('SELECT * FROM tprm_relationship_locations WHERE id=?').get(Number(result.lastInsertRowid));
    recordEvent(db, {
      workspaceId, relationshipId: relationship.id, eventType: 'location_version_added', actor,
      reason: requiredText(input.reason, 'Location assertion reason', 5, 2000),
      payload: { locationId: location.id, locationKey, version, countryCode: location.country_code, exposureType: location.exposure_type, status: location.status },
      occurredAt: recordedAt,
    });
    return { location };
  }).immediate();
}

function linkAssessmentCycle(db, input) {
  return db.transaction(() => {
    const workspaceId = positiveId(input.workspaceId, 'workspaceId');
    const relationship = relationshipRow(db, workspaceId, input.relationshipId);
    const cycleId = positiveId(input.cycleId, 'cycleId');
    const cycle = db.prepare('SELECT * FROM tprm_assessment_cycles WHERE workspace_id=? AND supplier_id=? AND id=?')
      .get(workspaceId, relationship.supplier_id, cycleId);
    if (!cycle) fail('TPRM_CYCLE_NOT_FOUND', 'Assessment cycle does not belong to this service relationship and client workspace.', 404);
    const actor = firmActor(db, workspaceId, input.actorId);
    const result = db.prepare(`INSERT INTO tprm_cycle_relationship_scopes
      (workspace_id,supplier_id,cycle_id,relationship_id,scope_role,scope_rationale,linked_by)
      VALUES (?,?,?,?,?,?,?)`).run(
      workspaceId, relationship.supplier_id, cycle.id, relationship.id,
      enumValue(input.scopeRole, ['primary', 'in_scope', 'supporting'], 'Scope role', 'in_scope'),
      requiredText(input.scopeRationale, 'Scope rationale', 5, 2000), actor.id
    );
    const scope = db.prepare('SELECT * FROM tprm_cycle_relationship_scopes WHERE id=?').get(Number(result.lastInsertRowid));
    recordEvent(db, {
      workspaceId, relationshipId: relationship.id, eventType: 'cycle_scope_linked', actor,
      reason: scope.scope_rationale, payload: { scopeId: scope.id, cycleId: cycle.id, scopeRole: scope.scope_role },
    });
    return { scope };
  }).immediate();
}

function percentage(numerator, denominator) {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : null;
}

function concentrationProjection(db, workspaceIdInput, options = {}) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  workspaceRow(db, workspaceId);
  const includeConcluded = Boolean(options.includeConcluded);
  const relationships = db.prepare(`SELECT r.*,le.legal_name,le.trading_name
    FROM tprm_service_relationships r
    JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
    WHERE r.workspace_id=? ${includeConcluded ? '' : "AND r.status NOT IN ('terminated','rejected')"}
    ORDER BY le.legal_name,r.relationship_name`).all(workspaceId);
  const currencies = {};
  for (const row of relationships) {
    if (row.annual_spend_minor == null || !row.currency) continue;
    currencies[row.currency] = (currencies[row.currency] || 0) + row.annual_spend_minor;
  }
  const providersMap = new Map();
  const categoriesMap = new Map();
  for (const row of relationships) {
    if (!providersMap.has(row.legal_entity_id)) providersMap.set(row.legal_entity_id, {
      legalEntityId: row.legal_entity_id, legalName: row.legal_name, relationshipCount: 0,
      criticalRelationshipCount: 0, spendByCurrency: {}, relationshipIds: [],
    });
    const provider = providersMap.get(row.legal_entity_id);
    provider.relationshipCount++;
    provider.relationshipIds.push(row.id);
    if (['high', 'critical'].includes(row.criticality)) provider.criticalRelationshipCount++;
    if (row.annual_spend_minor != null && row.currency) {
      provider.spendByCurrency[row.currency] = (provider.spendByCurrency[row.currency] || 0) + row.annual_spend_minor;
    }
    const categoryKey = row.service_category || 'Unclassified';
    if (!categoriesMap.has(categoryKey)) categoriesMap.set(categoryKey, { serviceCategory: categoryKey, relationshipCount: 0, criticalRelationshipCount: 0 });
    const category = categoriesMap.get(categoryKey);
    category.relationshipCount++;
    if (['high', 'critical'].includes(row.criticality)) category.criticalRelationshipCount++;
  }
  const providers = [...providersMap.values()].map(provider => ({
    ...provider,
    relationshipSharePercent: percentage(provider.relationshipCount, relationships.length),
    spendShareByCurrency: Object.fromEntries(Object.entries(provider.spendByCurrency)
      .map(([currency, value]) => [currency, percentage(value, currencies[currency])])),
  })).sort((a, b) => b.relationshipCount - a.relationshipCount || a.legalName.localeCompare(b.legalName));

  const locations = db.prepare(`SELECT l.*,r.annual_spend_minor,r.currency,r.criticality AS relationship_criticality
    FROM tprm_relationship_locations l
    JOIN tprm_service_relationships r ON r.workspace_id=l.workspace_id AND r.id=l.relationship_id
    WHERE l.workspace_id=? AND l.status!='exited'
      AND NOT EXISTS (SELECT 1 FROM tprm_relationship_locations n WHERE n.supersedes_id=l.id)
      ${includeConcluded ? '' : "AND r.status NOT IN ('terminated','rejected')"}`).all(workspaceId);
  const countriesMap = new Map();
  for (const location of locations) {
    if (!countriesMap.has(location.country_code)) countriesMap.set(location.country_code, {
      countryCode: location.country_code, relationshipIds: new Set(), dataHostingRelationshipIds: new Set(), criticalRelationshipIds: new Set(),
    });
    const country = countriesMap.get(location.country_code);
    country.relationshipIds.add(location.relationship_id);
    if (['data_processing', 'data_storage', 'backup'].includes(location.exposure_type)) country.dataHostingRelationshipIds.add(location.relationship_id);
    if (['high', 'critical'].includes(location.relationship_criticality)) country.criticalRelationshipIds.add(location.relationship_id);
  }
  const countries = [...countriesMap.values()].map(item => ({
    countryCode: item.countryCode,
    relationshipCount: item.relationshipIds.size,
    dataHostingRelationshipCount: item.dataHostingRelationshipIds.size,
    criticalRelationshipCount: item.criticalRelationshipIds.size,
    relationshipSharePercent: percentage(item.relationshipIds.size, relationships.length),
  })).sort((a, b) => b.relationshipCount - a.relationshipCount || a.countryCode.localeCompare(b.countryCode));

  const fourthParties = db.prepare(`SELECT de.id AS dependency_entity_id,de.name,de.entity_type,
      COUNT(DISTINCT e.source_relationship_id) AS relationship_count,
      SUM(CASE WHEN e.criticality IN ('high','critical') THEN 1 ELSE 0 END) AS high_critical_edge_count,
      MAX(e.single_point_of_failure) AS single_point_of_failure
    FROM tprm_dependency_entities de
    JOIN tprm_dependency_edges e ON e.workspace_id=de.workspace_id AND e.dependency_entity_id=de.id
    WHERE de.workspace_id=? AND e.status NOT IN ('rejected','ended')
    GROUP BY de.id,de.name,de.entity_type
    ORDER BY relationship_count DESC,de.name`).all(workspaceId).map(item => ({
      ...item,
      relationshipSharePercent: percentage(item.relationship_count, relationships.length),
    }));
  const businessServices = db.prepare(`SELECT bs.id AS business_service_id,bs.name,bs.criticality,
      COUNT(DISTINCT d.relationship_id) AS provider_relationship_count,
      SUM(CASE WHEN d.dependency_type='essential' THEN 1 ELSE 0 END) AS essential_dependency_count
    FROM tprm_business_services bs
    LEFT JOIN tprm_relationship_business_dependencies d
      ON d.workspace_id=bs.workspace_id AND d.business_service_id=bs.id AND d.status='active'
    WHERE bs.workspace_id=? AND bs.status='active'
    GROUP BY bs.id,bs.name,bs.criticality ORDER BY bs.criticality DESC,bs.name`).all(workspaceId).map(item => ({
      ...item,
      singleProviderDependency: item.provider_relationship_count === 1,
      noMappedProvider: item.provider_relationship_count === 0,
    }));
  const activeRelationshipIds = new Set(relationships.map(row => row.id));
  const locationRelationshipIds = new Set(locations.map(row => row.relationship_id));
  return {
    workspaceId,
    asOf: now(),
    dataProvenance: 'Client-maintained legal entity, service relationship, contract and disclosed dependency inventory. No external intelligence is applied.',
    externalIntelligenceApplied: false,
    totals: {
      relationships: relationships.length,
      legalEntities: providers.length,
      highOrCriticalRelationships: relationships.filter(row => ['high', 'critical'].includes(row.criticality)).length,
      soleSourceRelationships: relationships.filter(row => row.sole_source === 1).length,
      spendByCurrency: currencies,
    },
    providers,
    serviceCategories: [...categoriesMap.values()].map(item => ({
      ...item, relationshipSharePercent: percentage(item.relationshipCount, relationships.length),
    })).sort((a, b) => b.relationshipCount - a.relationshipCount || a.serviceCategory.localeCompare(b.serviceCategory)),
    countries,
    fourthParties,
    businessServices,
    concentrationFlags: {
      providersWithMultipleServices: providers.filter(item => item.relationshipCount > 1),
      fourthPartiesSharedAcrossServices: fourthParties.filter(item => item.relationship_count > 1),
      businessServicesWithSingleProvider: businessServices.filter(item => item.singleProviderDependency),
      relationshipSinglePointsOfFailure: relationships.filter(item => item.sole_source === 1 || item.substitutability === 'not_substitutable')
        .map(item => ({ relationshipId: item.id, relationshipName: item.relationship_name, criticality: item.criticality })),
    },
    dataQuality: {
      relationshipsMissingSpend: relationships.filter(row => row.annual_spend_minor == null).map(row => row.id),
      relationshipsWithUnknownCriticality: relationships.filter(row => row.criticality === 'unknown').map(row => row.id),
      relationshipsMissingCurrentLocation: [...activeRelationshipIds].filter(id => !locationRelationshipIds.has(id)),
      businessServicesWithoutProviderMapping: businessServices.filter(item => item.noMappedProvider).map(item => item.business_service_id),
    },
  };
}

function criticalChainProjection(db, input, relationshipIdInput = null) {
  const args = typeof input === 'object' && input !== null
    ? input
    : { workspaceId: input, relationshipId: relationshipIdInput };
  const workspaceId = positiveId(args.workspaceId, 'workspaceId');
  workspaceRow(db, workspaceId);
  const relationshipId = optionalId(args.relationshipId, 'relationshipId');
  const businessServiceId = optionalId(args.businessServiceId, 'businessServiceId');
  const maxDepth = integer(args.maxDepth == null ? 6 : args.maxDepth, 'Maximum chain depth', { minimum: 1, maximum: 12, nullable: false });
  if (relationshipId) relationshipRow(db, workspaceId, relationshipId);
  const relationships = db.prepare(`SELECT r.*,le.legal_name
    FROM tprm_service_relationships r
    JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
    WHERE r.workspace_id=? AND r.status NOT IN ('terminated','rejected')`).all(workspaceId);
  const relationshipMap = new Map(relationships.map(row => [row.id, row]));
  const dependencyEntities = new Map(db.prepare('SELECT * FROM tprm_dependency_entities WHERE workspace_id=?').all(workspaceId)
    .map(row => [row.id, row]));
  const edges = db.prepare(`SELECT * FROM tprm_dependency_edges
    WHERE workspace_id=? AND status NOT IN ('rejected','ended') ORDER BY source_relationship_id,id`).all(workspaceId);
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.source_relationship_id)) outgoing.set(edge.source_relationship_id, []);
    outgoing.get(edge.source_relationship_id).push(edge);
  }
  let roots = db.prepare(`SELECT d.*,bs.name AS business_service_name,bs.criticality AS business_service_criticality,
      r.relationship_name,r.legal_entity_id
    FROM tprm_relationship_business_dependencies d
    JOIN tprm_business_services bs ON bs.workspace_id=d.workspace_id AND bs.id=d.business_service_id
    JOIN tprm_service_relationships r ON r.workspace_id=d.workspace_id AND r.id=d.relationship_id
    WHERE d.workspace_id=@workspaceId AND d.status='active' AND bs.status='active'
      ${relationshipId ? 'AND d.relationship_id=@relationshipId' : ''}
      ${businessServiceId ? 'AND d.business_service_id=@businessServiceId' : ''}
    ORDER BY bs.criticality DESC,bs.name,r.relationship_name`).all({ workspaceId, relationshipId, businessServiceId });
  if (!roots.length && relationshipId) {
    const relationship = relationshipMap.get(relationshipId);
    roots = relationship ? [{
      relationship_id: relationship.id,
      business_service_id: null,
      business_service_name: null,
      business_service_criticality: null,
      dependency_type: null,
    }] : [];
  }
  const chains = [];
  let maxDepthReached = false;
  function relationshipNode(row) {
    return {
      type: 'service_relationship', id: row.id, name: row.relationship_name,
      legalEntityId: row.legal_entity_id, legalName: row.legal_name,
      criticality: row.criticality, soleSource: Boolean(row.sole_source), substitutability: row.substitutability,
    };
  }
  function walk(currentId, path, visited, depth, root) {
    const current = relationshipMap.get(currentId);
    if (!current) {
      chains.push({ root, path: [...path, { type: 'unresolved_relationship', id: currentId }], unresolved: true, cycle: false });
      return;
    }
    const nextPath = [...path, relationshipNode(current)];
    if (visited.has(currentId)) {
      chains.push({ root, path: [...nextPath, { type: 'cycle', relationshipId: currentId }], unresolved: false, cycle: true });
      return;
    }
    const nextVisited = new Set(visited).add(currentId);
    const nextEdges = outgoing.get(currentId) || [];
    if (!nextEdges.length) {
      chains.push({ root, path: nextPath, unresolved: false, cycle: false });
      return;
    }
    if (depth >= maxDepth) {
      maxDepthReached = true;
      chains.push({ root, path: [...nextPath, { type: 'depth_limit', maxDepth }], unresolved: true, cycle: false });
      return;
    }
    for (const edge of nextEdges) {
      const edgeNode = {
        type: 'dependency_edge', id: edge.id, dependencyType: edge.dependency_type,
        serviceDescription: edge.service_description, criticality: edge.criticality,
        singlePointOfFailure: Boolean(edge.single_point_of_failure), substitutability: edge.substitutability,
        status: edge.status,
      };
      if (edge.target_relationship_id) {
        walk(edge.target_relationship_id, [...nextPath, edgeNode], nextVisited, depth + 1, root);
      } else {
        const entity = dependencyEntities.get(edge.dependency_entity_id);
        chains.push({
          root,
          path: [...nextPath, edgeNode, entity
            ? { type: 'external_dependency_entity', id: entity.id, name: entity.name, entityType: entity.entity_type, countryCode: entity.legal_country_code }
            : { type: 'unresolved_dependency_entity', id: edge.dependency_entity_id }],
          unresolved: !entity,
          cycle: false,
        });
      }
    }
  }
  for (const rootRow of roots) {
    const root = rootRow.business_service_id ? {
      type: 'business_service', id: rootRow.business_service_id, name: rootRow.business_service_name,
      criticality: rootRow.business_service_criticality, dependencyType: rootRow.dependency_type,
    } : null;
    walk(rootRow.relationship_id, root ? [root] : [], new Set(), 1, root);
  }
  const singlePoints = [];
  for (const relationship of relationships) {
    if (relationship.sole_source || ['difficult', 'not_substitutable'].includes(relationship.substitutability)) {
      singlePoints.push({ type: 'service_relationship', id: relationship.id, name: relationship.relationship_name, reason: relationship.sole_source ? 'sole_source' : relationship.substitutability });
    }
  }
  for (const edge of edges.filter(row => row.single_point_of_failure)) {
    singlePoints.push({ type: 'dependency_edge', id: edge.id, relationshipId: edge.source_relationship_id, reason: 'declared_single_point_of_failure' });
  }
  return {
    workspaceId,
    relationshipId,
    businessServiceId,
    asOf: now(),
    dataProvenance: 'Client-maintained service and disclosed dependency inventory. No external intelligence or undisclosed fourth-party discovery is applied.',
    externalIntelligenceApplied: false,
    maxDepth,
    maxDepthReached,
    chains,
    singlePointsOfFailure: singlePoints,
    unresolvedChainCount: chains.filter(chain => chain.unresolved).length,
    cycleCount: chains.filter(chain => chain.cycle).length,
  };
}

function scoreExitReadiness(relationship, contracts) {
  const criteria = [];
  function add(key, label, weight, earned, evidence, missing) {
    criteria.push({ key, label, weight, earned, met: earned === weight, evidence: evidence || null, missing: missing || null });
  }
  add('exit_strategy', 'Documented exit strategy', 15, relationship.exit_strategy ? 15 : 0,
    relationship.exit_strategy ? 'Exit strategy recorded' : null, relationship.exit_strategy ? null : 'Document an actionable exit strategy.');
  add('exit_owner', 'Named exit owner', 10, relationship.exit_owner ? 10 : 0,
    relationship.exit_owner || null, relationship.exit_owner ? null : 'Assign an accountable exit owner.');
  const planScores = { tested: relationship.last_exit_tested_at ? 20 : 15, documented: 15, needs_update: 5, not_started: 0, not_applicable: 0 };
  const planEarned = planScores[relationship.exit_plan_status] || 0;
  add('exit_plan', 'Documented and tested exit plan', 20, planEarned,
    relationship.exit_plan_status === 'tested' && relationship.last_exit_tested_at
      ? `Tested ${relationship.last_exit_tested_at}` : relationship.exit_plan_status,
    planEarned === 20 ? null : 'Document and exercise the exit plan, including the test date.');
  let substituteEarned = 0;
  if (relationship.alternate_provider_relationship_id && !['terminated', 'rejected'].includes(relationship.alternate_provider_status)) substituteEarned = 15;
  else if (relationship.substitutability === 'readily_substitutable') substituteEarned = 15;
  else if (relationship.substitutability === 'substitutable_with_effort') substituteEarned = 10;
  else if (relationship.substitutability === 'difficult') substituteEarned = 4;
  add('substitute', 'Viable substitute or transition option', 15, substituteEarned,
    substituteEarned === 15 && relationship.alternate_provider_relationship_id
      ? `Active alternate relationship ${relationship.alternate_provider_relationship_id}` : relationship.substitutability,
    substituteEarned === 15 ? null : 'Identify and validate a viable substitute or transition option.');
  add('exit_duration', 'Estimated exit duration', 10, relationship.estimated_exit_days != null ? 10 : 0,
    relationship.estimated_exit_days != null ? `${relationship.estimated_exit_days} days` : null,
    relationship.estimated_exit_days != null ? null : 'Estimate the end-to-end exit duration.');
  const recoveryEarned = relationship.rto_hours != null && relationship.rpo_hours != null ? 10
    : (relationship.rto_hours != null || relationship.rpo_hours != null ? 5 : 0);
  add('recovery_targets', 'Defined RTO and RPO', 10, recoveryEarned,
    `RTO ${relationship.rto_hours == null ? 'missing' : relationship.rto_hours}; RPO ${relationship.rpo_hours == null ? 'missing' : relationship.rpo_hours}`,
    recoveryEarned === 10 ? null : 'Define both relationship RTO and RPO.');
  const contractDataTerms = contracts.some(contract => contract.data_return_deletion_terms);
  const dataTermsPresent = Boolean(relationship.data_return_deletion_requirements || contractDataTerms);
  add('data_return', 'Data return and deletion requirements', 10, dataTermsPresent ? 10 : 0,
    dataTermsPresent ? 'Relationship or current contract terms recorded' : null,
    dataTermsPresent ? null : 'Define verified data return and deletion requirements.');
  const contractTransition = contracts.some(contract => contract.transition_assistance);
  const transitionPresent = Boolean(relationship.transition_assistance || contractTransition);
  add('transition_assistance', 'Transition assistance provisions', 5, transitionPresent ? 5 : 0,
    transitionPresent ? 'Relationship or current contract terms recorded' : null,
    transitionPresent ? null : 'Define provider transition-assistance obligations.');
  const contractExit = contracts.some(contract => contract.end_date || contract.notice_deadline || contract.termination_rights);
  add('contract_exit', 'Contract termination timing or rights', 5, contractExit ? 5 : 0,
    contractExit ? 'Current contract exit timing or rights recorded' : null,
    contractExit ? null : 'Record termination rights, end date, or notice deadline.');
  const score = criteria.reduce((sum, item) => sum + item.earned, 0);
  const readinessBand = score >= 80 ? 'ready' : score >= 55 ? 'needs_attention' : score >= 30 ? 'weak' : 'not_ready';
  const blockers = [];
  if (['high', 'critical'].includes(relationship.criticality) && !['documented', 'tested'].includes(relationship.exit_plan_status)) blockers.push('Critical relationship has no current documented exit plan.');
  if (relationship.sole_source && ['not_substitutable', 'unknown'].includes(relationship.substitutability)
      && (!relationship.alternate_provider_relationship_id || ['terminated', 'rejected'].includes(relationship.alternate_provider_status))) {
    blockers.push('Sole-source relationship has no validated substitute.');
  }
  if (relationship.rto_hours == null || relationship.rpo_hours == null) blockers.push('Recovery targets are incomplete.');
  return {
    relationshipId: relationship.id,
    relationshipName: relationship.relationship_name,
    legalEntityId: relationship.legal_entity_id,
    legalName: relationship.legal_name,
    status: relationship.status,
    criticality: relationship.criticality,
    score,
    maximumScore: 100,
    readinessBand,
    criteria,
    blockers,
    missingActions: criteria.filter(item => !item.met && item.missing).map(item => item.missing),
  };
}

function exitReadinessProjection(db, input, relationshipIdInput = null) {
  const args = typeof input === 'object' && input !== null
    ? input
    : { workspaceId: input, relationshipId: relationshipIdInput };
  const workspaceId = positiveId(args.workspaceId, 'workspaceId');
  workspaceRow(db, workspaceId);
  const relationshipId = optionalId(args.relationshipId, 'relationshipId');
  const relationships = db.prepare(`SELECT r.*,le.legal_name,alt.status AS alternate_provider_status
    FROM tprm_service_relationships r
    JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
    LEFT JOIN tprm_service_relationships alt
      ON alt.workspace_id=r.workspace_id AND alt.id=r.alternate_provider_relationship_id
    WHERE r.workspace_id=@workspaceId ${relationshipId ? 'AND r.id=@relationshipId' : "AND r.status NOT IN ('terminated','rejected')"}
    ORDER BY r.criticality DESC,r.relationship_name`).all({ workspaceId, relationshipId });
  if (relationshipId && !relationships.length) fail('TPRM_RELATIONSHIP_NOT_FOUND', 'Service relationship not found in this client workspace.', 404);
  const assessments = relationships.map(relationship => {
    const contracts = db.prepare(`SELECT c.* FROM tprm_relationship_contracts c
      WHERE c.workspace_id=? AND c.relationship_id=?
        AND NOT EXISTS (SELECT 1 FROM tprm_relationship_contracts n WHERE n.supersedes_id=c.id)`)
      .all(workspaceId, relationship.id);
    return scoreExitReadiness(relationship, contracts);
  });
  const averageScore = assessments.length
    ? Number((assessments.reduce((sum, item) => sum + item.score, 0) / assessments.length).toFixed(2))
    : null;
  return {
    workspaceId,
    relationshipId,
    asOf: now(),
    dataProvenance: 'Readiness is calculated only from client-maintained relationship and current contract records. It is not an external assurance opinion.',
    externalIntelligenceApplied: false,
    assessments,
    portfolioSummary: {
      relationshipCount: assessments.length,
      averageScore,
      ready: assessments.filter(item => item.readinessBand === 'ready').length,
      needsAttention: assessments.filter(item => item.readinessBand === 'needs_attention').length,
      weak: assessments.filter(item => item.readinessBand === 'weak').length,
      notReady: assessments.filter(item => item.readinessBand === 'not_ready').length,
      relationshipsWithBlockers: assessments.filter(item => item.blockers.length).length,
    },
  };
}

function relationshipBundle(db, workspaceIdInput, relationshipIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const relationship = relationshipRow(db, workspaceId, relationshipIdInput);
  const legalEntity = db.prepare('SELECT * FROM tprm_legal_entities WHERE workspace_id=? AND id=?')
    .get(workspaceId, relationship.legal_entity_id);
  const contracts = db.prepare(`SELECT c.*,
      CASE WHEN NOT EXISTS (SELECT 1 FROM tprm_relationship_contracts n WHERE n.supersedes_id=c.id) THEN 1 ELSE 0 END AS is_current
    FROM tprm_relationship_contracts c WHERE c.workspace_id=? AND c.relationship_id=?
    ORDER BY c.contract_family_key,c.version DESC`).all(workspaceId, relationship.id);
  const dependencies = db.prepare(`SELECT e.*,de.name AS dependency_entity_name,de.entity_type AS dependency_entity_type,
      target.relationship_name AS target_relationship_name
    FROM tprm_dependency_edges e
    LEFT JOIN tprm_dependency_entities de ON de.workspace_id=e.workspace_id AND de.id=e.dependency_entity_id
    LEFT JOIN tprm_service_relationships target ON target.workspace_id=e.workspace_id AND target.id=e.target_relationship_id
    WHERE e.workspace_id=? AND e.source_relationship_id=? ORDER BY e.id`).all(workspaceId, relationship.id);
  const locations = db.prepare(`SELECT l.*,
      CASE WHEN NOT EXISTS (SELECT 1 FROM tprm_relationship_locations n WHERE n.supersedes_id=l.id) THEN 1 ELSE 0 END AS is_current
    FROM tprm_relationship_locations l WHERE l.workspace_id=? AND l.relationship_id=?
    ORDER BY l.location_key,l.version DESC`).all(workspaceId, relationship.id);
  const businessDependencies = db.prepare(`SELECT d.*,bs.name AS business_service_name,bs.criticality AS business_service_criticality
    FROM tprm_relationship_business_dependencies d
    JOIN tprm_business_services bs ON bs.workspace_id=d.workspace_id AND bs.id=d.business_service_id
    WHERE d.workspace_id=? AND d.relationship_id=? ORDER BY d.id`).all(workspaceId, relationship.id);
  const assessmentScopes = db.prepare(`SELECT s.*,c.cycle_number,c.cycle_type,c.status AS cycle_status
    FROM tprm_cycle_relationship_scopes s
    JOIN tprm_assessment_cycles c ON c.workspace_id=s.workspace_id AND c.id=s.cycle_id
    WHERE s.workspace_id=? AND s.relationship_id=? ORDER BY c.cycle_number DESC`).all(workspaceId, relationship.id);
  const events = db.prepare(`SELECT * FROM tprm_relationship_events
    WHERE workspace_id=? AND relationship_id=? ORDER BY occurred_at DESC,id DESC`).all(workspaceId, relationship.id);
  return {
    relationship,
    legalEntity,
    contracts,
    dependencies,
    locations,
    businessDependencies,
    assessmentScopes,
    events,
    exitReadiness: exitReadinessProjection(db, { workspaceId, relationshipId: relationship.id }).assessments[0],
  };
}

function guardServiceMutation(capability, operation) {
  return serviceCapabilities.withCapability(capability, operation);
}

function updateRelationshipForServiceModel(db, input) {
  serviceCapabilities.assertCapability(
    db, input?.workspaceId, serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER
  );
  const patch = input?.patch || input?.changes || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    serviceCapabilities.assertCapability(
      db, input?.workspaceId, serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE
    );
  }
  return updateRelationship(db, input);
}

module.exports = {
  TprmRelationshipError,
  RELATIONSHIP_STATUSES,
  CRITICALITIES,
  SUBSTITUTABILITY,
  PROVISION_MODELS,
  DATA_ACCESS_LEVELS,
  CONTRACT_TYPES,
  CONTRACT_STATUSES,
  DEPENDENCY_TYPES,
  DEPENDENCY_STATUSES,
  LOCATION_TYPES,
  stableStringify,
  sha256,
  ensureLegalEntityForSupplier: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, ensureLegalEntityForSupplier),
  createRelationship: guardServiceMutation(serviceCapabilities.CAPABILITIES.DRAFT_INTAKE, createRelationship),
  relationshipActivationAuthority,
  assertRelationshipActivationAuthority,
  updateRelationship: updateRelationshipForServiceModel,
  currentContract,
  addContractVersion: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, addContractVersion),
  versionContract: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, addContractVersion),
  createDependencyEntity: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, createDependencyEntity),
  addDependencyEdge: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, addDependencyEdge),
  transitionDependencyEdge: guardServiceMutation(serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE, transitionDependencyEdge),
  createBusinessService: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, createBusinessService),
  linkBusinessService: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, linkBusinessService),
  endBusinessDependency: guardServiceMutation(serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE, endBusinessDependency),
  currentLocation,
  addLocationExposure: guardServiceMutation(serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER, addLocationExposure),
  linkAssessmentCycle: guardServiceMutation(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT, linkAssessmentCycle),
  concentrationProjection,
  criticalChainProjection,
  exitReadinessProjection,
  relationshipBundle,
  serviceCapabilities,
};
