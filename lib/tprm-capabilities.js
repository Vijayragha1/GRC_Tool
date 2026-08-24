'use strict';

// Contract boundary for Third-party risk service periods. Permissions answer
// who may act; this policy answers whether the contracted service model
// includes the action at all. Read access is deliberately outside this matrix
// so retained and historic records remain inspectable.

const CAPABILITIES = Object.freeze({
  INVENTORY_REGISTER: 'inventory_register',
  METHODOLOGY_GOVERNANCE: 'methodology_governance',
  DRAFT_INTAKE: 'draft_intake',
  BOUNDED_ASSESSMENT: 'bounded_assessment',
  RECOMMENDATION: 'recommendation',
  CLIENT_DECISION_REPORT: 'client_decision_report',
  EVIDENCE_DISCLOSURE: 'evidence_disclosure',
  MONITORING_CONNECTORS: 'monitoring_connectors',
  MONITORING_SIGNALS: 'monitoring_signals',
  REASSESSMENT_QUEUE: 'reassessment_queue',
  PERIODIC_SCHEDULES: 'periodic_schedules',
  MANAGED_CONDITION_EXECUTION: 'managed_condition_execution',
  OPERATIONAL_LIFECYCLE: 'operational_lifecycle',
});

const CAPABILITY_DETAILS = Object.freeze({
  [CAPABILITIES.INVENTORY_REGISTER]: Object.freeze({ label: 'third-party inventory and register maintenance' }),
  [CAPABILITIES.METHODOLOGY_GOVERNANCE]: Object.freeze({ label: 'methodology and programme governance' }),
  [CAPABILITIES.DRAFT_INTAKE]: Object.freeze({ label: 'draft third-party intake' }),
  [CAPABILITIES.BOUNDED_ASSESSMENT]: Object.freeze({ label: 'bounded onboarding assessment' }),
  [CAPABILITIES.RECOMMENDATION]: Object.freeze({ label: 'consultancy recommendation workflow' }),
  [CAPABILITIES.CLIENT_DECISION_REPORT]: Object.freeze({ label: 'client decision and assessment reporting' }),
  [CAPABILITIES.EVIDENCE_DISCLOSURE]: Object.freeze({ label: 'assessment evidence disclosure' }),
  [CAPABILITIES.MONITORING_CONNECTORS]: Object.freeze({ label: 'continuous-monitoring connectors' }),
  [CAPABILITIES.MONITORING_SIGNALS]: Object.freeze({ label: 'continuous-monitoring signals' }),
  [CAPABILITIES.REASSESSMENT_QUEUE]: Object.freeze({ label: 'managed reassessment queue' }),
  [CAPABILITIES.PERIODIC_SCHEDULES]: Object.freeze({ label: 'periodic review schedules' }),
  [CAPABILITIES.MANAGED_CONDITION_EXECUTION]: Object.freeze({ label: 'managed condition execution' }),
  [CAPABILITIES.OPERATIONAL_LIFECYCLE]: Object.freeze({ label: 'operational lifecycle management' }),
});

const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));

const MODEL_CAPABILITIES = Object.freeze({
  programme_setup: Object.freeze([
    CAPABILITIES.INVENTORY_REGISTER,
    CAPABILITIES.METHODOLOGY_GOVERNANCE,
    CAPABILITIES.DRAFT_INTAKE,
  ]),
  assessment_only: Object.freeze([
    // Inventory and draft intake are necessary prerequisites for defining the
    // exact service scope assessed in a bounded engagement.
    CAPABILITIES.INVENTORY_REGISTER,
    CAPABILITIES.DRAFT_INTAKE,
    CAPABILITIES.BOUNDED_ASSESSMENT,
    CAPABILITIES.RECOMMENDATION,
    CAPABILITIES.CLIENT_DECISION_REPORT,
    CAPABILITIES.EVIDENCE_DISCLOSURE,
  ]),
  managed_lifecycle: ALL_CAPABILITIES,
});

const SERVICE_MODEL_DETAILS = Object.freeze({
  programme_setup: Object.freeze({
    label: 'Programme setup',
    summary: 'Inventory, register, methodology governance and draft intake only.',
    exclusion: 'Assessments, recommendations, client decisions, monitoring and operational lifecycle work are not included.',
  }),
  assessment_only: Object.freeze({
    label: 'Assessment only',
    summary: 'A bounded onboarding assessment through recommendation, client decision and report.',
    exclusion: 'Continuous monitoring, reassessment queues, periodic schedules, managed condition execution and operational lifecycle management are not included.',
  }),
  managed_lifecycle: Object.freeze({
    label: 'Managed lifecycle',
    summary: 'End-to-end third-party inventory, assessment, decision, monitoring and operational lifecycle management.',
    exclusion: null,
  }),
});

class TprmCapabilityError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = 'TprmCapabilityError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function moduleRow(value) {
  return value && value.row && typeof value.row === 'object' ? value.row : value;
}

function latestModule(db, workspaceIdInput) {
  const workspaceId = Number(workspaceIdInput);
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new TprmCapabilityError('TPRM_WORKSPACE_INVALID', 'Client workspace is invalid.', 400);
  }
  return db.prepare('SELECT * FROM tprm_modules WHERE workspace_id=? ORDER BY id DESC LIMIT 1')
    .get(workspaceId) || null;
}

function assertKnownCapability(capability) {
  if (!ALL_CAPABILITIES.includes(capability)) {
    throw new TprmCapabilityError('TPRM_CAPABILITY_INVALID', 'Third-party risk capability is invalid.', 500);
  }
}

function serviceModelLabel(serviceModel) {
  return SERVICE_MODEL_DETAILS[serviceModel]?.label || 'Unclassified';
}

function allows(serviceModel, capability) {
  assertKnownCapability(capability);
  return Boolean(MODEL_CAPABILITIES[serviceModel]?.includes(capability));
}

function changeServiceModelReason() {
  return 'Close this service period and start a new governed service period to change the contracted service model.';
}

function denialReason(moduleInput, capability) {
  assertKnownCapability(capability);
  const row = moduleRow(moduleInput);
  if (!row) return 'Third-party risk is not enabled for this client.';
  if (row.status === 'closed') {
    return 'This Third-party risk service period is closed. Its retained history remains read-only; start a new governed service period before making changes.';
  }
  if (row.status === 'needs_classification') {
    return 'Classify the historic Third-party risk service model before changing governed records.';
  }
  if (row.status !== 'active') return 'This Third-party risk service period is not active.';
  const detail = CAPABILITY_DETAILS[capability];
  return `${detail.label[0].toUpperCase()}${detail.label.slice(1)} is not included in the ${serviceModelLabel(row.service_model)} service model. ${changeServiceModelReason()}`;
}

function policyForModule(moduleInput) {
  const row = moduleRow(moduleInput) || null;
  const model = row?.service_model || null;
  const active = row?.status === 'active';
  const allowedCapabilities = active && MODEL_CAPABILITIES[model]
    ? [...MODEL_CAPABILITIES[model]] : [];
  const detail = SERVICE_MODEL_DETAILS[model] || null;
  const capabilityState = Object.fromEntries(ALL_CAPABILITIES.map(capability => [capability, {
    allowed: active && allows(model, capability),
    reason: active && allows(model, capability) ? null : denialReason(row, capability),
  }]));
  return {
    moduleId: row?.id || null,
    status: row?.status || 'not_enabled',
    serviceModel: model,
    serviceModelLabel: serviceModelLabel(model),
    summary: detail?.summary || 'The service model has not been classified.',
    exclusion: detail?.exclusion || null,
    active,
    readOnly: !active,
    allowedCapabilities,
    capabilities: capabilityState,
    modelChangeRule: changeServiceModelReason(),
  };
}

function assertCapability(db, workspaceId, capability) {
  assertKnownCapability(capability);
  const row = latestModule(db, workspaceId);
  if (!row) {
    throw new TprmCapabilityError('TPRM_MODULE_DISABLED', denialReason(null, capability), 409, {
      workspaceId: Number(workspaceId), capability,
    });
  }
  if (row.status !== 'active') {
    const code = row.status === 'closed' ? 'TPRM_SERVICE_PERIOD_CLOSED'
      : row.status === 'needs_classification' ? 'TPRM_MODULE_NEEDS_CLASSIFICATION'
        : 'TPRM_MODULE_DISABLED';
    throw new TprmCapabilityError(code, denialReason(row, capability), 409, {
      workspaceId: Number(workspaceId), moduleId: row.id, serviceModel: row.service_model, capability,
    });
  }
  if (!allows(row.service_model, capability)) {
    throw new TprmCapabilityError('TPRM_SERVICE_MODEL_CAPABILITY_REQUIRED', denialReason(row, capability), 409, {
      workspaceId: Number(workspaceId), moduleId: row.id, serviceModel: row.service_model,
      capability, allowedServiceModels: Object.keys(MODEL_CAPABILITIES).filter(model => allows(model, capability)),
    });
  }
  return { module: row, policy: policyForModule(row), capability };
}

function requireCapability(db, capability) {
  assertKnownCapability(capability);
  return (req, res, next) => {
    try {
      const state = assertCapability(db, req.workspace?.id || req.params?.wsId, capability);
      req.tprmCapability = state;
      res.locals.tprmPolicy = state.policy;
      return next();
    } catch (error) {
      if (!(error instanceof TprmCapabilityError)) return next(error);
      return res.status(error.status).render('error', {
        user: req.user || null,
        ws: req.workspace || null,
        message: error.message,
      });
    }
  };
}

function withCapability(capability, operation) {
  assertKnownCapability(capability);
  if (typeof operation !== 'function') throw new TypeError('A capability-guarded operation must be a function.');
  return function capabilityGuardedOperation(db, input, ...rest) {
    assertCapability(db, input?.workspaceId, capability);
    return operation(db, input, ...rest);
  };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_DETAILS,
  ALL_CAPABILITIES,
  MODEL_CAPABILITIES,
  SERVICE_MODEL_DETAILS,
  TprmCapabilityError,
  latestModule,
  allows,
  denialReason,
  policyForModule,
  assertCapability,
  requireCapability,
  withCapability,
  serviceModelLabel,
  changeServiceModelReason,
};
