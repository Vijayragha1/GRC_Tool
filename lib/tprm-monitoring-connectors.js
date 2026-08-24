'use strict';

const crypto = require('crypto');
const tprmDomain = require('./tprm-domain');
const tprmRelationships = require('./tprm-relationships');
const serviceCapabilities = require('./tprm-capabilities');

const PROVIDER_TYPES = Object.freeze([
  'securityscorecard', 'bitsight', 'riskrecon', 'generic_webhook', 'csv_import',
]);
const SIGNAL_TYPES = Object.freeze([
  'security_incident', 'breach', 'financial', 'regulatory', 'availability',
  'control_change', 'contract', 'concentration', 'news', 'other',
]);
const SEVERITIES = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);
const SECRET_SCHEMES = Object.freeze([
  'vault://', 'aws-secretsmanager://', 'azure-keyvault://', 'gcp-secretmanager://',
  'env://', 'keychain://',
]);
const SENSITIVE_KEYS = new Set([
  'secret', 'password', 'passphrase', 'api_key', 'apikey', 'access_token',
  'refresh_token', 'authorization', 'credential', 'credentials', 'private_key',
  'client_secret', 'webhook_secret',
]);
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_NORMALIZED_BYTES = 64 * 1024;
const WEBHOOK_RATE_LIMITS = Object.freeze({
  sourcePerMinute: 30,
  connectorPerMinute: 120,
  maxSourceBucketsPerConnector: 256,
  retentionHours: 24,
});
const FAILURE_POLICY = Object.freeze({
  mode: 'fail_closed',
  summary: 'Unmapped, unverifiable or unevaluable events are retained as immutable hashes and quarantined; reassessment requests remain pending or require manual review until explicitly resolved.',
});

class TprmConnectorError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = 'TprmConnectorError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 409, details = null) {
  throw new TprmConnectorError(code, message, status, details);
}

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function requiredText(value, label, minimum = 1, maximum = 1000) {
  const text = cleanText(value);
  if (text.length < minimum || text.length > maximum) {
    fail('TPRM_CONNECTOR_VALIDATION', `${label} must contain ${minimum} to ${maximum} characters.`, 400);
  }
  return text;
}

function optionalText(value, maximum = 1000) {
  const text = cleanText(value);
  if (!text) return null;
  if (text.length > maximum) fail('TPRM_CONNECTOR_VALIDATION', `Text cannot exceed ${maximum} characters.`, 400);
  return text;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) fail('TPRM_CONNECTOR_VALIDATION', `${label} is invalid.`, 400);
  return id;
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
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function utcNow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) fail('TPRM_CONNECTOR_TIME_INVALID', 'A valid timestamp is required.', 400);
  return date.toISOString();
}

function utcMillis(value) {
  const text = cleanText(value);
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z` : text;
  return new Date(normalized).getTime();
}

function parseJson(value, fallback = null) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function normalizeSensitiveKey(key) {
  return String(key || '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase().replace(/[\s-]+/g, '_');
}

function isSensitiveKey(key) {
  const normalized = normalizeSensitiveKey(key);
  return SENSITIVE_KEYS.has(normalized)
    || /(^|_)(secret|password|passphrase|token|credential|credentials|private_key)($|_)/.test(normalized)
    || /(^|_)(api_key|access_token|refresh_token|client_secret|webhook_secret)($|_)/.test(normalized);
}

function assertNoSecretMaterial(value, path = 'adapterConfig', depth = 0) {
  if (depth > 12) fail('TPRM_CONFIG_TOO_DEEP', 'Connector configuration nesting is too deep.', 400);
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Buffer.isBuffer(value) || value instanceof Date || typeof value !== 'object') {
    fail('TPRM_CONFIG_INVALID', 'Connector configuration must contain JSON-compatible values only.', 400);
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) fail('TPRM_CONFIG_TOO_LARGE', 'Connector configuration array is too large.', 400);
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`, depth + 1));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      fail('TPRM_SECRET_MATERIAL_FORBIDDEN', `Secret material is not allowed in ${path}; use secretReference.`, 400);
    }
    assertNoSecretMaterial(nested, `${path}.${key}`, depth + 1);
  }
}

function safeJson(value, label = 'JSON value', maxBytes = MAX_NORMALIZED_BYTES) {
  assertNoSecretMaterial(value, label);
  const json = stableStringify(value == null ? {} : value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    fail('TPRM_CONFIG_TOO_LARGE', `${label} exceeds the ${maxBytes}-byte limit.`, 413);
  }
  return json;
}

function validateSecretReference(reference, required) {
  const value = optionalText(reference, 512);
  if (!value && required) fail('TPRM_SECRET_REFERENCE_REQUIRED', 'An external secret-store reference is required.', 400);
  if (!value) return null;
  if (!SECRET_SCHEMES.some(prefix => value.startsWith(prefix)) || value.length < 8) {
    fail('TPRM_SECRET_REFERENCE_INVALID', 'Use a supported external secret-store reference; do not enter the credential itself.', 400);
  }
  return value;
}

function redactError(error) {
  let value = error && error.message ? String(error.message) : String(error == null ? '' : error);
  value = value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(secret|password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret)(\s*[=:]\s*|["']\s*:\s*["'])([^\s,;"'}]+)/gi, '$1$2[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, '[redacted-long-value]');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000) || 'Processing failed.';
}

function errorCode(error, fallback = 'TPRM_CONNECTOR_PROCESSING_FAILED') {
  const code = cleanText(error && error.code);
  return /^[A-Z0-9_]{3,100}$/.test(code) ? code : fallback;
}

function isInboundRejectionCode(code) {
  return new Set([
    'TPRM_WEBHOOK_SIGNATURE_INVALID', 'TPRM_WEBHOOK_TIMESTAMP_INVALID',
    'TPRM_WEBHOOK_TIMESTAMP_STALE', 'TPRM_WEBHOOK_REPLAY', 'TPRM_WEBHOOK_RAW_BODY_REQUIRED',
    'TPRM_WEBHOOK_SIZE_INVALID', 'TPRM_EVENT_JSON_INVALID', 'TPRM_EVENT_PAYLOAD_INVALID',
    'TPRM_EVENT_TIME_INVALID', 'TPRM_EVENT_IDEMPOTENCY_CONFLICT', 'TPRM_CONNECTOR_VALIDATION',
  ]).has(code);
}

function firmActor(db, workspaceIdInput, actorIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const actorId = positiveId(actorIdInput, 'actorId');
  const actor = db.prepare(`SELECT u.* FROM users u JOIN workspaces w ON w.id=?
    WHERE u.id=? AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id`).get(workspaceId, actorId);
  if (!actor) fail('TPRM_CONNECTOR_FIRM_ACTOR_REQUIRED', 'An active consultancy user for this client is required.', 403);
  return actor;
}

function activeModule(db, workspaceIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  return serviceCapabilities.assertCapability(
    db, workspaceId, serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS
  ).module;
}

function connectorRow(db, workspaceIdInput, connectorIdInput, options = {}) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const connectorId = positiveId(connectorIdInput, 'connectorId');
  const connector = db.prepare('SELECT * FROM tprm_monitoring_connectors WHERE workspace_id=? AND id=?').get(workspaceId, connectorId);
  if (!connector) fail('TPRM_CONNECTOR_NOT_FOUND', 'Monitoring connector not found in this client workspace.', 404);
  if (options.requireActive && connector.status !== 'active') {
    fail('TPRM_CONNECTOR_NOT_ACTIVE', 'Monitoring connector is not active.', 409, { status: connector.status });
  }
  return connector;
}

function appendAudit(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connectorId = positiveId(input.connectorId, 'connectorId');
  const connector = connectorRow(db, workspaceId, connectorId);
  let actor = null;
  if (input.actorId) actor = firmActor(db, workspaceId, input.actorId);
  const actorType = actor ? 'consultancy' : 'system';
  const actorName = actor ? actor.name : requiredText(input.actorName || 'Nimbus monitoring', 'actorName', 2, 200);
  const detailsJson = safeJson(input.details || {}, 'audit details');
  const previous = db.prepare(`SELECT event_hash FROM tprm_monitoring_connector_audit
    WHERE workspace_id=? AND connector_id=? ORDER BY id DESC LIMIT 1`).get(workspaceId, connectorId);
  const occurredAt = utcNow(input.occurredAt || new Date());
  const eventHash = sha256(stableStringify({
    workspaceId, connectorId, eventType: input.eventType, actorUserId: actor && actor.id || null,
    actorType, actorName, details: parseJson(detailsJson, {}), previousEventHash: previous && previous.event_hash || null,
    occurredAt,
  }));
  const id = Number(db.prepare(`INSERT INTO tprm_monitoring_connector_audit
    (workspace_id,connector_id,event_type,actor_user_id,actor_type,actor_name,details_json,
     previous_event_hash,event_hash,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    workspaceId, connectorId, input.eventType, actor && actor.id || null, actorType, actorName,
    detailsJson, previous && previous.event_hash || null, eventHash, occurredAt
  ).lastInsertRowid);
  return db.prepare('SELECT * FROM tprm_monitoring_connector_audit WHERE id=?').get(id);
}

function capabilityFor(providerType, mode) {
  const adapter = ADAPTERS[providerType];
  if (!adapter || !adapter.supportedModes.includes(mode)) {
    fail('TPRM_CONNECTOR_CAPABILITY_INVALID', 'The selected provider does not support this connector mode.', 400);
  }
  return adapter;
}

function createConnector(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const module = activeModule(db, workspaceId);
  const providerType = requiredText(input.providerType, 'providerType', 3, 40).toLowerCase();
  if (!PROVIDER_TYPES.includes(providerType)) fail('TPRM_CONNECTOR_PROVIDER_INVALID', 'Monitoring provider type is invalid.', 400);
  const defaultMode = providerType === 'csv_import' ? 'csv' : 'webhook';
  const capabilityMode = cleanText(input.capabilityMode || defaultMode).toLowerCase();
  const adapter = capabilityFor(providerType, capabilityMode);
  const config = input.adapterConfig || {};
  assertNoSecretMaterial(config);
  for (const forbidden of ['secret', 'password', 'apiKey', 'accessToken', 'clientSecret', 'webhookSecret']) {
    if (input[forbidden] != null) fail('TPRM_SECRET_MATERIAL_FORBIDDEN', 'Credential material must be placed in the external secret store, never in Nimbus.', 400);
  }
  const secretReference = validateSecretReference(input.secretReference, providerType !== 'csv_import');
  const externalConfirmed = Boolean(input.externalProvisioningConfirmed);
  let status = cleanText(input.status || 'draft').toLowerCase();
  if (!['draft', 'active'].includes(status)) fail('TPRM_CONNECTOR_STATUS_INVALID', 'A connector can be created as draft or active.', 400);
  if (status === 'active' && adapter.integrationState === 'adapter_contract_only' && !externalConfirmed) {
    fail('TPRM_EXTERNAL_PROVISIONING_REQUIRED', 'Confirm the separately contracted provider integration before activating this adapter.', 409);
  }
  const name = requiredText(input.name, 'Connector name', 3, 120);
  const adapterConfigJson = safeJson(config, 'adapterConfig');
  const ingressKey = crypto.randomBytes(16).toString('hex');
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO tprm_monitoring_connectors
      (workspace_id,module_id,provider_type,capability_mode,name,ingress_key,status,secret_reference,
       adapter_config_json,external_provisioning_confirmed,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      workspaceId, module.id, providerType, capabilityMode, name, ingressKey, status, secretReference,
      adapterConfigJson, externalConfirmed ? 1 : 0, actor.id
    ).lastInsertRowid);
    db.prepare(`INSERT INTO tprm_monitoring_connector_state(workspace_id,connector_id)
      VALUES (?,?)`).run(workspaceId, id);
    appendAudit(db, {
      workspaceId, connectorId: id, eventType: 'connector_created', actorId: actor.id,
      details: { providerType, capabilityMode, status, externalProvisioningConfirmed: externalConfirmed,
        referenceDigest: secretReference ? sha256(secretReference) : null },
    });
    if (status === 'active') appendAudit(db, {
      workspaceId, connectorId: id, eventType: 'connector_activated', actorId: actor.id,
      details: { activation: 'created_active' },
    });
    return connectorRow(db, workspaceId, id);
  }).immediate();
}

function updateConnectorStatus(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const connector = connectorRow(db, workspaceId, input.connectorId);
  const target = requiredText(input.status, 'status', 3, 20).toLowerCase();
  const allowed = {
    draft: ['active', 'disabled'], active: ['paused', 'disabled'], paused: ['active', 'disabled'], disabled: [],
  };
  if (!allowed[connector.status].includes(target)) fail('TPRM_CONNECTOR_STATUS_TRANSITION_INVALID', 'Monitoring connector status transition is invalid.', 409);
  const adapter = capabilityFor(connector.provider_type, connector.capability_mode);
  const externallyConfirmed = connector.external_provisioning_confirmed || Boolean(input.externalProvisioningConfirmed);
  if (target === 'active') {
    activeModule(db, workspaceId);
    if (adapter.integrationState === 'adapter_contract_only' && !externallyConfirmed) {
      fail('TPRM_EXTERNAL_PROVISIONING_REQUIRED', 'Confirm the separately contracted provider integration before activation.', 409);
    }
  }
  const eventType = target === 'active'
    ? (connector.status === 'paused' ? 'connector_resumed' : 'connector_activated')
    : target === 'paused' ? 'connector_paused' : 'connector_disabled';
  return db.transaction(() => {
    db.prepare(`UPDATE tprm_monitoring_connectors SET status=?,external_provisioning_confirmed=?,
      updated_by=?,updated_at=?,row_version=row_version+1 WHERE workspace_id=? AND id=? AND row_version=?`).run(
      target, externallyConfirmed ? 1 : 0, actor.id, utcNow(), workspaceId, connector.id, connector.row_version
    );
    appendAudit(db, { workspaceId, connectorId: connector.id, eventType, actorId: actor.id,
      details: { from: connector.status, to: target, reason: optionalText(input.reason, 500) } });
    return connectorRow(db, workspaceId, connector.id);
  }).immediate();
}

function rotateSecretReference(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const connector = connectorRow(db, workspaceId, input.connectorId);
  if (connector.provider_type === 'csv_import') fail('TPRM_SECRET_REFERENCE_NOT_APPLICABLE', 'CSV import connectors do not use a webhook credential.', 400);
  const secretReference = validateSecretReference(input.secretReference, true);
  if (secretReference === connector.secret_reference) return { connector, changed: false };
  return db.transaction(() => {
    db.prepare(`UPDATE tprm_monitoring_connectors SET secret_reference=?,updated_by=?,updated_at=?,
      row_version=row_version+1 WHERE workspace_id=? AND id=? AND row_version=?`).run(
      secretReference, actor.id, utcNow(), workspaceId, connector.id, connector.row_version
    );
    appendAudit(db, {
      workspaceId, connectorId: connector.id, eventType: 'secret_reference_rotated', actorId: actor.id,
      details: { priorReferenceDigest: sha256(connector.secret_reference), newReferenceDigest: sha256(secretReference) },
    });
    return { connector: connectorRow(db, workspaceId, connector.id), changed: true };
  }).immediate();
}

function createSupplierMapping(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const connector = connectorRow(db, workspaceId, input.connectorId);
  const supplierId = positiveId(input.supplierId, 'supplierId');
  if (!db.prepare('SELECT 1 FROM suppliers WHERE workspace_id=? AND id=?').get(workspaceId, supplierId)) {
    fail('TPRM_MAPPING_CROSS_TENANT', 'The selected third party is not in this client workspace.', 403);
  }
  const providerEntityId = requiredText(input.providerEntityId, 'providerEntityId', 1, 240);
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO tprm_connector_supplier_mappings
      (workspace_id,connector_id,provider_entity_id,supplier_id,mapping_note,created_by)
      VALUES (?,?,?,?,?,?)`).run(
      workspaceId, connector.id, providerEntityId, supplierId, optionalText(input.mappingNote, 1000), actor.id
    ).lastInsertRowid);
    appendAudit(db, { workspaceId, connectorId: connector.id, eventType: 'mapping_created', actorId: actor.id,
      details: { mappingId: id, supplierId, providerEntityIdHash: sha256(providerEntityId) } });
    return db.prepare('SELECT * FROM tprm_connector_supplier_mappings WHERE id=?').get(id);
  }).immediate();
}

function retireSupplierMapping(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const connectorId = positiveId(input.connectorId, 'connectorId');
  connectorRow(db, workspaceId, connectorId);
  const mappingId = positiveId(input.mappingId, 'mappingId');
  const mapping = db.prepare(`SELECT * FROM tprm_connector_supplier_mappings
    WHERE workspace_id=? AND connector_id=? AND id=?`).get(workspaceId, connectorId, mappingId);
  if (!mapping) fail('TPRM_MAPPING_NOT_FOUND', 'Connector mapping not found.', 404);
  if (!mapping.active) return { mapping, changed: false };
  return db.transaction(() => {
    db.prepare(`UPDATE tprm_connector_supplier_mappings SET active=0,valid_to=?,retired_by=?
      WHERE id=? AND active=1`).run(utcNow(), actor.id, mapping.id);
    appendAudit(db, { workspaceId, connectorId, eventType: 'mapping_retired', actorId: actor.id,
      details: { mappingId, reason: optionalText(input.reason, 500) } });
    return { mapping: db.prepare('SELECT * FROM tprm_connector_supplier_mappings WHERE id=?').get(mapping.id), changed: true };
  }).immediate();
}

function validateThreshold(operator, threshold) {
  if (operator === 'exists') return null;
  if (['gt', 'gte', 'lt', 'lte'].includes(operator) && (typeof threshold !== 'number' || !Number.isFinite(threshold))) {
    fail('TPRM_RULE_THRESHOLD_INVALID', 'Numeric monitoring operators require a finite numeric threshold.', 400);
  }
  if (operator === 'contains' && !['string', 'number', 'boolean'].includes(typeof threshold)) {
    fail('TPRM_RULE_THRESHOLD_INVALID', 'Contains requires a scalar threshold.', 400);
  }
  if (threshold === undefined) fail('TPRM_RULE_THRESHOLD_INVALID', 'A monitoring threshold is required.', 400);
  return threshold;
}

function createRule(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const connector = connectorRow(db, workspaceId, input.connectorId);
  const ruleKey = requiredText(input.ruleKey, 'ruleKey', 2, 100);
  const metricPath = requiredText(input.metricPath, 'metricPath', 1, 240);
  if (!/^[A-Za-z0-9_.-]+$/.test(metricPath) || metricPath.includes('..')) {
    fail('TPRM_RULE_PATH_INVALID', 'Monitoring metric path contains invalid characters.', 400);
  }
  const operator = requiredText(input.operator, 'operator', 2, 20).toLowerCase();
  if (!['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains', 'exists'].includes(operator)) {
    fail('TPRM_RULE_OPERATOR_INVALID', 'Monitoring rule operator is invalid.', 400);
  }
  const threshold = validateThreshold(operator, input.threshold);
  const signalType = cleanText(input.signalType || 'other').toLowerCase();
  if (!SIGNAL_TYPES.includes(signalType)) fail('TPRM_RULE_SIGNAL_TYPE_INVALID', 'Monitoring signal type is invalid.', 400);
  const severity = cleanText(input.severity || 'moderate').toLowerCase();
  if (!SEVERITIES.includes(severity)) fail('TPRM_RULE_SEVERITY_INVALID', 'Monitoring severity is invalid.', 400);
  const missingBehavior = cleanText(input.missingBehavior || 'quarantine').toLowerCase();
  if (!['quarantine', 'ignore'].includes(missingBehavior)) fail('TPRM_RULE_MISSING_BEHAVIOR_INVALID', 'Monitoring missing-field behavior is invalid.', 400);
  const title = requiredText(input.title, 'Rule title', 3, 240);
  return db.transaction(() => {
    const prior = db.prepare(`SELECT * FROM tprm_monitoring_rules
      WHERE workspace_id=? AND connector_id=? AND rule_key=? AND enabled=1`).get(workspaceId, connector.id, ruleKey);
    const version = Number(db.prepare(`SELECT COALESCE(MAX(version),0)+1 AS next FROM tprm_monitoring_rules
      WHERE workspace_id=? AND connector_id=? AND rule_key=?`).get(workspaceId, connector.id, ruleKey).next);
    if (prior) db.prepare(`UPDATE tprm_monitoring_rules SET enabled=0,disabled_by=?,disabled_at=? WHERE id=? AND enabled=1`)
      .run(actor.id, utcNow(), prior.id);
    const id = Number(db.prepare(`INSERT INTO tprm_monitoring_rules
      (workspace_id,connector_id,rule_key,version,metric_path,operator,threshold_json,
       signal_type,severity,requires_reassessment,missing_behavior,title,supersedes_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      workspaceId, connector.id, ruleKey, version, metricPath, operator, stableStringify(threshold),
      signalType, severity, input.requiresReassessment ? 1 : 0, missingBehavior, title,
      prior && prior.id || null, actor.id
    ).lastInsertRowid);
    if (prior) appendAudit(db, { workspaceId, connectorId: connector.id, eventType: 'rule_disabled', actorId: actor.id,
      details: { ruleId: prior.id, replacementRuleId: id } });
    appendAudit(db, { workspaceId, connectorId: connector.id, eventType: 'rule_created', actorId: actor.id,
      details: { ruleId: id, ruleKey, version, severity, requiresReassessment: Boolean(input.requiresReassessment) } });
    return db.prepare('SELECT * FROM tprm_monitoring_rules WHERE id=?').get(id);
  }).immediate();
}

function safeExternalValue(value, key = '', depth = 0) {
  if (isSensitiveKey(key)) return undefined;
  if (depth > 5 || value == null) return value == null ? null : undefined;
  if (typeof value === 'string') return value.slice(0, 2000).replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeExternalValue(item, key, depth + 1)).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const result = {};
    for (const [nestedKey, nested] of Object.entries(value).slice(0, 200)) {
      const safe = safeExternalValue(nested, nestedKey, depth + 1);
      if (safe !== undefined) result[nestedKey] = safe;
    }
    return result;
  }
  return undefined;
}

function firstValue(payload, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let current = payload;
    for (const part of parts) current = current && typeof current === 'object' ? current[part] : undefined;
    if (current !== undefined && current !== null && cleanText(current)) return current;
  }
  return null;
}

function normalizeSeverity(value, fallback = 'moderate') {
  const raw = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    informational: 'info', medium: 'moderate', med: 'moderate', warning: 'moderate',
    severe: 'critical', urgent: 'critical', very_high: 'critical',
  };
  const normalized = aliases[raw] || raw;
  return SEVERITIES.includes(normalized) ? normalized : fallback;
}

function normalizeSignalType(value) {
  const raw = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    incident: 'security_incident', security: 'security_incident', cyber_incident: 'security_incident',
    data_breach: 'breach', outage: 'availability', downtime: 'availability', rating_change: 'control_change',
    score_change: 'control_change', compliance: 'regulatory', regulatory_action: 'regulatory',
  };
  const normalized = aliases[raw] || raw;
  return SIGNAL_TYPES.includes(normalized) ? normalized : 'other';
}

function validObservedAt(value) {
  const text = cleanText(value);
  const date = new Date(text);
  if (!text || !Number.isFinite(date.getTime())) fail('TPRM_EVENT_TIME_INVALID', 'Monitoring event has no valid observed timestamp.', 400);
  return date.toISOString();
}

function genericNormalize(payload, context = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('TPRM_EVENT_PAYLOAD_INVALID', 'Monitoring event payload must be a JSON object.', 400);
  }
  const providerEventId = requiredText(firstValue(payload, [
    'event_id', 'eventId', 'id', 'reference', 'alert.id', 'event.id',
  ]), 'provider event id', 1, 240);
  const providerEntityId = requiredText(firstValue(payload, [
    'provider_entity_id', 'providerEntityId', 'entity_id', 'entityId', 'company_id',
    'companyId', 'vendor_id', 'vendorId', 'supplier_id', 'supplierId', 'company.id',
    'vendor.id', 'supplier.id', 'entity.id',
  ]), 'provider entity id', 1, 240);
  const observedAt = validObservedAt(firstValue(payload, [
    'observed_at', 'observedAt', 'occurred_at', 'occurredAt', 'timestamp', 'created_at',
    'createdAt', 'event.timestamp',
  ]) || context.receivedAt || new Date());
  const signalType = normalizeSignalType(firstValue(payload, [
    'signal_type', 'signalType', 'event_type', 'eventType', 'type', 'category', 'alert.type',
  ]));
  const severity = normalizeSeverity(firstValue(payload, [
    'severity', 'risk_level', 'riskLevel', 'priority', 'alert.severity',
  ]), 'moderate');
  const title = requiredText(firstValue(payload, [
    'title', 'summary', 'name', 'alert.title', 'event.title',
  ]) || `${context.providerLabel || 'Third-party'} monitoring event`, 'event title', 3, 240);
  const detail = optionalText(firstValue(payload, [
    'detail', 'description', 'message', 'alert.description', 'event.description',
  ]), 4000);
  const suppliedMetrics = payload.metrics && typeof payload.metrics === 'object' ? payload.metrics : {};
  const metrics = safeExternalValue(suppliedMetrics, 'metrics') || {};
  for (const candidate of ['score', 'rating', 'security_rating', 'securityRating', 'risk_score', 'riskScore', 'grade']) {
    if (payload[candidate] !== undefined) metrics[candidate] = safeExternalValue(payload[candidate], candidate);
  }
  return {
    providerEventId, providerEntityId, observedAt, signalType, severity, title, detail,
    metrics,
    attributes: safeExternalValue(payload.attributes || {}, 'attributes') || {},
  };
}

function interfaceOnlyPoll() {
  fail('TPRM_PAID_ADAPTER_NOT_CONNECTED', 'This provider adapter is an integration contract only; configure an authorised subscription and transport before polling.', 501);
}

const ADAPTERS = Object.freeze({
  securityscorecard: Object.freeze({
    providerType: 'securityscorecard', label: 'SecurityScorecard', integrationState: 'adapter_contract_only',
    supportedModes: Object.freeze(['webhook', 'poll']), liveOutbound: false,
    normalize: (payload, context) => genericNormalize(payload, { ...context, providerLabel: 'SecurityScorecard' }),
    poll: interfaceOnlyPoll,
  }),
  bitsight: Object.freeze({
    providerType: 'bitsight', label: 'BitSight', integrationState: 'adapter_contract_only',
    supportedModes: Object.freeze(['webhook', 'poll']), liveOutbound: false,
    normalize: (payload, context) => genericNormalize(payload, { ...context, providerLabel: 'BitSight' }),
    poll: interfaceOnlyPoll,
  }),
  riskrecon: Object.freeze({
    providerType: 'riskrecon', label: 'RiskRecon', integrationState: 'adapter_contract_only',
    supportedModes: Object.freeze(['webhook', 'poll']), liveOutbound: false,
    normalize: (payload, context) => genericNormalize(payload, { ...context, providerLabel: 'RiskRecon' }),
    poll: interfaceOnlyPoll,
  }),
  generic_webhook: Object.freeze({
    providerType: 'generic_webhook', label: 'Generic signed webhook', integrationState: 'implemented',
    supportedModes: Object.freeze(['webhook']), liveOutbound: false, normalize: genericNormalize,
  }),
  csv_import: Object.freeze({
    providerType: 'csv_import', label: 'Governed CSV import', integrationState: 'implemented',
    supportedModes: Object.freeze(['csv']), liveOutbound: false, normalize: genericNormalize,
  }),
});

function listAdapters() {
  return Object.values(ADAPTERS).map(adapter => ({
    providerType: adapter.providerType, label: adapter.label, integrationState: adapter.integrationState,
    supportedModes: [...adapter.supportedModes], liveOutbound: adapter.liveOutbound,
  }));
}

function getAdapter(providerTypeInput) {
  const providerType = cleanText(providerTypeInput).toLowerCase();
  const adapter = ADAPTERS[providerType];
  if (!adapter) fail('TPRM_CONNECTOR_PROVIDER_INVALID', 'Monitoring provider type is invalid.', 400);
  return adapter;
}

function normalizeRawBody(rawBody) {
  let body;
  if (Buffer.isBuffer(rawBody)) body = rawBody;
  else if (typeof rawBody === 'string') body = Buffer.from(rawBody, 'utf8');
  else fail('TPRM_WEBHOOK_RAW_BODY_REQUIRED', 'Webhook verification requires the exact raw request body.', 400);
  if (!body.length || body.length > MAX_WEBHOOK_BYTES) {
    fail('TPRM_WEBHOOK_SIZE_INVALID', `Webhook payload must contain 1 to ${MAX_WEBHOOK_BYTES} bytes.`, 413);
  }
  return body;
}

function parseSignatureHeader(signatureInput, timestampInput) {
  const raw = requiredText(signatureInput, 'signature', 8, 1000);
  let timestamp = timestampInput;
  const candidates = [];
  if (raw.includes('=')) {
    for (const part of raw.split(',')) {
      const index = part.indexOf('=');
      if (index < 1) continue;
      const key = part.slice(0, index).trim().toLowerCase();
      const value = part.slice(index + 1).trim();
      if (key === 't' && timestamp == null) timestamp = value;
      if (key === 'v1' || key === 'sha256') candidates.push(value.toLowerCase());
    }
  } else {
    candidates.push(raw.toLowerCase());
  }
  const signature = candidates.find(candidate => /^[0-9a-f]{64}$/.test(candidate));
  if (!signature) fail('TPRM_WEBHOOK_SIGNATURE_INVALID', 'Webhook signature format is invalid.', 401);
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || timestampSeconds <= 0) {
    fail('TPRM_WEBHOOK_TIMESTAMP_INVALID', 'Webhook signature timestamp is invalid.', 401);
  }
  return { signature, timestampSeconds };
}

function verifyWebhookSignature(input) {
  const body = normalizeRawBody(input.rawBody);
  const secret = Buffer.isBuffer(input.secret) ? input.secret : Buffer.from(String(input.secret || ''), 'utf8');
  if (secret.length < 16 || secret.length > 4096) {
    fail('TPRM_WEBHOOK_SECRET_INVALID', 'Resolved webhook verification material is unavailable or invalid.', 503);
  }
  const { signature, timestampSeconds } = parseSignatureHeader(input.signature, input.timestamp);
  const maxSkewSeconds = input.maxSkewSeconds == null ? 300 : Number(input.maxSkewSeconds);
  if (!Number.isInteger(maxSkewSeconds) || maxSkewSeconds < 30 || maxSkewSeconds > 900) {
    fail('TPRM_WEBHOOK_TOLERANCE_INVALID', 'Webhook clock-skew tolerance must be between 30 and 900 seconds.', 400);
  }
  const nowMilliseconds = input.now == null ? Date.now()
    : input.now instanceof Date ? input.now.getTime()
      : Number(input.now) < 100000000000 ? Number(input.now) * 1000 : Number(input.now);
  if (!Number.isFinite(nowMilliseconds)) fail('TPRM_WEBHOOK_TIMESTAMP_INVALID', 'Webhook verification time is invalid.', 400);
  const skewSeconds = Math.abs(Math.floor(nowMilliseconds / 1000) - timestampSeconds);
  if (skewSeconds > maxSkewSeconds) {
    fail('TPRM_WEBHOOK_TIMESTAMP_STALE', 'Webhook signature is outside the permitted replay window.', 401);
  }
  const expected = crypto.createHmac('sha256', secret)
    .update(String(timestampSeconds)).update('.').update(body).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    fail('TPRM_WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed.', 401);
  }
  const signatureDigest = sha256(signature);
  if (typeof input.replayGuard === 'function' && input.replayGuard(signatureDigest, timestampSeconds) === false) {
    fail('TPRM_WEBHOOK_REPLAY', 'Webhook delivery has already been accepted.', 409);
  }
  return { valid: true, timestampSeconds, signatureDigest, payloadHash: sha256(body), body };
}

function signWebhook(input) {
  const body = normalizeRawBody(input.rawBody);
  const secret = Buffer.isBuffer(input.secret) ? input.secret : Buffer.from(String(input.secret || ''), 'utf8');
  const timestamp = Number(input.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0) fail('TPRM_WEBHOOK_TIMESTAMP_INVALID', 'Webhook signature timestamp is invalid.', 400);
  return crypto.createHmac('sha256', secret).update(String(timestamp)).update('.').update(body).digest('hex');
}

function resolveSecret(connector, resolver) {
  if (typeof resolver !== 'function') {
    fail('TPRM_SECRET_RESOLVER_REQUIRED', 'A runtime secret resolver is required for signed webhook verification.', 503);
  }
  let value;
  try {
    value = resolver(connector.secret_reference, {
      workspaceId: connector.workspace_id, connectorId: connector.id, providerType: connector.provider_type,
    });
  } catch (_) {
    fail('TPRM_SECRET_RESOLUTION_FAILED', 'Webhook verification material could not be resolved.', 503);
  }
  if (value && typeof value.then === 'function') {
    fail('TPRM_ASYNC_SECRET_RESOLVER_UNSUPPORTED', 'Use the asynchronous ingestion boundary for an asynchronous secret resolver.', 500);
  }
  const secret = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
  if (secret.length < 16) fail('TPRM_SECRET_RESOLUTION_FAILED', 'Webhook verification material could not be resolved.', 503);
  return secret;
}

function getMetric(normalized, path) {
  let current = normalized;
  for (const part of String(path).split('.')) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function compareRule(operator, observed, threshold) {
  if (operator === 'exists') return observed !== undefined && observed !== null;
  if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
    const numeric = typeof observed === 'number' ? observed : Number(observed);
    if (!Number.isFinite(numeric)) fail('TPRM_RULE_VALUE_INVALID', 'A monitored numeric field was not numeric.', 422);
    if (operator === 'gt') return numeric > threshold;
    if (operator === 'gte') return numeric >= threshold;
    if (operator === 'lt') return numeric < threshold;
    return numeric <= threshold;
  }
  if (operator === 'contains') {
    if (Array.isArray(observed)) return observed.some(value => stableStringify(value) === stableStringify(threshold));
    return String(observed).includes(String(threshold));
  }
  const equal = stableStringify(observed) === stableStringify(threshold);
  return operator === 'eq' ? equal : !equal;
}

function evaluateRules(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connectorId = positiveId(input.connectorId, 'connectorId');
  connectorRow(db, workspaceId, connectorId);
  const normalized = input.normalized;
  const rules = db.prepare(`SELECT * FROM tprm_monitoring_rules
    WHERE workspace_id=? AND connector_id=? AND enabled=1 ORDER BY id`).all(workspaceId, connectorId);
  const evaluations = [];
  const matched = [];
  let quarantine = null;
  for (const rule of rules) {
    const metric = getMetric(normalized, rule.metric_path);
    if (!metric.found) {
      const outcome = rule.missing_behavior === 'ignore' ? 'missing_ignored' : 'quarantined';
      evaluations.push({ rule, matched: false, outcome, observed: undefined });
      if (outcome === 'quarantined' && !quarantine) quarantine = {
        code: 'TPRM_RULE_REQUIRED_FIELD_MISSING',
        message: `Required normalized metric ${rule.metric_path} was absent; event quarantined by fail-closed policy.`,
      };
      continue;
    }
    try {
      const isMatch = compareRule(rule.operator, metric.value, parseJson(rule.threshold_json));
      evaluations.push({ rule, matched: isMatch, outcome: isMatch ? 'matched' : 'not_matched', observed: metric.value });
      if (isMatch) matched.push(rule);
    } catch (error) {
      evaluations.push({ rule, matched: false, outcome: 'quarantined', observed: metric.value });
      if (!quarantine) quarantine = { code: errorCode(error, 'TPRM_RULE_EVALUATION_FAILED'), message: redactError(error) };
    }
  }
  const highest = matched.slice().sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.id - b.id)[0] || null;
  const baseSeverity = normalizeSeverity(normalized.severity, 'moderate');
  const severity = highest && SEVERITIES.indexOf(highest.severity) > SEVERITIES.indexOf(baseSeverity)
    ? highest.severity : baseSeverity;
  return {
    evaluations, matchedRules: matched, quarantine,
    signal: {
      signalType: highest ? highest.signal_type : normalizeSignalType(normalized.signalType),
      severity,
      title: highest ? highest.title : normalized.title,
      detail: normalized.detail,
      requiresReassessment: matched.some(rule => Boolean(rule.requires_reassessment)),
    },
  };
}

function resolveMapping(db, workspaceId, connectorId, providerEntityId) {
  return db.prepare(`SELECT * FROM tprm_connector_supplier_mappings
    WHERE workspace_id=? AND connector_id=? AND provider_entity_id=? AND active=1`).get(
    workspaceId, connectorId, providerEntityId
  ) || null;
}

function findReceivedDuplicate(db, input) {
  if (input.signatureDigest) {
    const bySignature = db.prepare(`SELECT * FROM tprm_monitoring_received_events
      WHERE workspace_id=? AND connector_id=? AND signature_digest=?`).get(
      input.workspaceId, input.connectorId, input.signatureDigest
    );
    if (bySignature) return bySignature;
  }
  return db.prepare(`SELECT * FROM tprm_monitoring_received_events
    WHERE workspace_id=? AND connector_id=? AND (provider_event_id=? OR idempotency_key=?)
    ORDER BY id LIMIT 1`).get(input.workspaceId, input.connectorId, input.providerEventId, input.idempotencyKey) || null;
}

function persistReceivedEvent(db, input) {
  const normalizedSummaryJson = safeJson(input.normalized, 'normalized monitoring event');
  const normalizedHash = sha256(normalizedSummaryJson);
  const duplicate = findReceivedDuplicate(db, input);
  if (duplicate) {
    if (duplicate.payload_hash !== input.payloadHash || duplicate.normalized_hash !== normalizedHash) {
      fail('TPRM_EVENT_IDEMPOTENCY_CONFLICT', 'This provider event identifier was already used for different content.', 409);
    }
    return { event: duplicate, duplicate: true };
  }
  const previous = db.prepare(`SELECT event_hash FROM tprm_monitoring_received_events
    WHERE workspace_id=? AND connector_id=? ORDER BY id DESC LIMIT 1`).get(input.workspaceId, input.connectorId);
  const eventFact = {
    workspaceId: input.workspaceId, connectorId: input.connectorId,
    mappingId: input.mapping && input.mapping.id || null,
    supplierId: input.mapping && input.mapping.supplier_id || null,
    providerEventId: input.providerEventId, providerEntityId: input.providerEntityId || null,
    idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash, normalizedHash,
    signatureTimestamp: input.signatureTimestamp || null, signatureDigest: input.signatureDigest || null,
    observedAt: input.normalized.observedAt || null, receivedAt: input.receivedAt,
    previousEventHash: previous && previous.event_hash || null,
  };
  const eventHash = sha256(stableStringify(eventFact));
  try {
    const id = Number(db.prepare(`INSERT INTO tprm_monitoring_received_events
      (workspace_id,connector_id,mapping_id,supplier_id,provider_event_id,provider_entity_id,
       idempotency_key,payload_hash,normalized_hash,normalized_summary_json,signature_timestamp,
       signature_digest,observed_at,received_at,previous_event_hash,event_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.workspaceId, input.connectorId, eventFact.mappingId, eventFact.supplierId,
      input.providerEventId, input.providerEntityId || null, input.idempotencyKey, input.payloadHash,
      normalizedHash, normalizedSummaryJson, eventFact.signatureTimestamp, eventFact.signatureDigest,
      eventFact.observedAt, input.receivedAt, eventFact.previousEventHash, eventHash
    ).lastInsertRowid);
    return { event: db.prepare('SELECT * FROM tprm_monitoring_received_events WHERE id=?').get(id), duplicate: false };
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      const raced = findReceivedDuplicate(db, input);
      if (raced) return { event: raced, duplicate: true };
    }
    throw error;
  }
}

function appendAttempt(db, input) {
  const attemptNumber = Number(db.prepare(`SELECT COALESCE(MAX(attempt_number),0)+1 AS next
    FROM tprm_monitoring_processing_attempts WHERE received_event_id=?`).get(input.receivedEventId).next);
  const id = Number(db.prepare(`INSERT INTO tprm_monitoring_processing_attempts
    (workspace_id,connector_id,received_event_id,attempt_number,status,supplier_id,signal_id,
     error_code,error_redacted,retryable,started_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.workspaceId, input.connectorId, input.receivedEventId, attemptNumber, input.status,
    input.supplierId || null, input.signalId || null, input.errorCode || null,
    input.errorRedacted || null, input.retryable ? 1 : 0, input.startedAt, input.completedAt
  ).lastInsertRowid);
  return db.prepare('SELECT * FROM tprm_monitoring_processing_attempts WHERE id=?').get(id);
}

function persistEvaluations(db, workspaceId, connectorId, receivedEventId, evaluations) {
  const insert = db.prepare(`INSERT OR IGNORE INTO tprm_monitoring_rule_evaluations
    (workspace_id,connector_id,received_event_id,rule_id,matched,observed_value_json,
     observed_value_hash,outcome) VALUES (?,?,?,?,?,?,?,?)`);
  for (const evaluation of evaluations) {
    const observedJson = evaluation.observed === undefined ? null : stableStringify(safeExternalValue(evaluation.observed));
    insert.run(workspaceId, connectorId, receivedEventId, evaluation.rule.id,
      evaluation.matched ? 1 : 0, observedJson, observedJson == null ? null : sha256(observedJson), evaluation.outcome);
  }
}

function queueReassessment(db, input) {
  const existing = db.prepare('SELECT * FROM tprm_reassessment_queue WHERE workspace_id=? AND signal_id=?').get(
    input.workspaceId, input.signalId
  );
  if (existing) return { queueItem: existing, created: false };
  const severity = input.severity === 'info' ? 'low' : input.severity;
  const id = Number(db.prepare(`INSERT INTO tprm_reassessment_queue
    (workspace_id,supplier_id,module_id,signal_id,received_event_id,reason,priority,max_attempts)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    input.workspaceId, input.supplierId, input.moduleId, input.signalId, input.receivedEventId,
    requiredText(input.reason, 'reassessment reason', 5, 1000), severity,
    input.maxAttempts == null ? 3 : Math.max(1, Math.min(20, Number(input.maxAttempts) || 3))
  ).lastInsertRowid);
  return { queueItem: db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(id), created: true };
}

function ingestNormalizedEventInternal(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connector = connectorRow(db, workspaceId, input.connectorId, { requireActive: true });
  const receivedAt = utcNow(input.receivedAt || new Date());
  const normalized = input.normalized;
  const mapping = resolveMapping(db, workspaceId, connector.id, normalized.providerEntityId);
  const providerEventId = requiredText(normalized.providerEventId, 'provider event id', 1, 240);
  const idempotencyKey = input.idempotencyKey
    ? requiredText(input.idempotencyKey, 'idempotencyKey', 32, 128)
    : sha256(`${workspaceId}:${connector.id}:${providerEventId}`);
  const payloadHash = input.payloadHash || sha256(stableStringify(normalized));
  const persisted = persistReceivedEvent(db, {
    workspaceId, connectorId: connector.id, mapping, providerEventId,
    providerEntityId: normalized.providerEntityId, idempotencyKey, payloadHash, normalized,
    signatureTimestamp: input.signatureTimestamp, signatureDigest: input.signatureDigest, receivedAt,
  });
  const startedAt = input.startedAt || receivedAt;
  if (persisted.duplicate) {
    const attempt = appendAttempt(db, {
      workspaceId, connectorId: connector.id, receivedEventId: persisted.event.id, status: 'duplicate',
      supplierId: persisted.event.supplier_id, startedAt, completedAt: utcNow(),
    });
    return { status: 'duplicate', receivedEvent: persisted.event, attempt, replayed: true, signal: null, queueItem: null };
  }
  if (!mapping) {
    const attempt = appendAttempt(db, {
      workspaceId, connectorId: connector.id, receivedEventId: persisted.event.id, status: 'quarantined',
      errorCode: 'TPRM_PROVIDER_ENTITY_UNMAPPED',
      errorRedacted: 'Provider entity is not mapped to a third party in this client workspace.',
      retryable: true, startedAt, completedAt: utcNow(),
    });
    return { status: 'quarantined', receivedEvent: persisted.event, attempt, replayed: false, signal: null, queueItem: null };
  }
  const evaluation = evaluateRules(db, { workspaceId, connectorId: connector.id, normalized });
  persistEvaluations(db, workspaceId, connector.id, persisted.event.id, evaluation.evaluations);
  if (evaluation.quarantine) {
    const attempt = appendAttempt(db, {
      workspaceId, connectorId: connector.id, receivedEventId: persisted.event.id, status: 'quarantined',
      supplierId: mapping.supplier_id, errorCode: evaluation.quarantine.code,
      errorRedacted: redactError(evaluation.quarantine.message), retryable: true,
      startedAt, completedAt: utcNow(),
    });
    return { status: 'quarantined', receivedEvent: persisted.event, attempt, replayed: false, signal: null, queueItem: null };
  }
  try {
    return db.transaction(() => {
      const result = tprmDomain.recordMonitoringSignal(db, {
        workspaceId, supplierId: mapping.supplier_id,
        source: `connector:${connector.provider_type}:${connector.id}`,
        sourceReference: providerEventId,
        fingerprint: sha256(`${connector.id}:${providerEventId}:${payloadHash}`),
        signalType: evaluation.signal.signalType, severity: evaluation.signal.severity,
        title: evaluation.signal.title, detail: evaluation.signal.detail,
        observedAt: normalized.observedAt,
        requiresReassessment: evaluation.signal.requiresReassessment,
        actorType: 'system', actorName: `Nimbus ${getAdapter(connector.provider_type).label} connector`,
        metadata: {
          connectorId: connector.id, receivedEventId: persisted.event.id,
          providerType: connector.provider_type, providerEventId,
          matchedRuleIds: evaluation.matchedRules.map(rule => rule.id), metrics: normalized.metrics,
        },
        idempotencyKey: sha256(`tprm-monitoring-signal:${workspaceId}:${connector.id}:${providerEventId}`),
      });
      let queueItem = null;
      if (evaluation.signal.requiresReassessment) {
        queueItem = queueReassessment(db, {
          workspaceId, supplierId: mapping.supplier_id, moduleId: connector.module_id,
          signalId: result.signal.id, receivedEventId: persisted.event.id,
          reason: `${evaluation.signal.title}: threshold rule requires a triggered reassessment.`,
          severity: evaluation.signal.severity,
        }).queueItem;
      }
      const attempt = appendAttempt(db, {
        workspaceId, connectorId: connector.id, receivedEventId: persisted.event.id, status: 'processed',
        supplierId: mapping.supplier_id, signalId: result.signal.id,
        startedAt, completedAt: utcNow(),
      });
      return { status: 'processed', receivedEvent: persisted.event, attempt, replayed: result.replayed,
        signal: result.signal, queueItem };
    }).immediate();
  } catch (error) {
    const attempt = appendAttempt(db, {
      workspaceId, connectorId: connector.id, receivedEventId: persisted.event.id, status: 'failed',
      supplierId: mapping.supplier_id, errorCode: errorCode(error), errorRedacted: redactError(error),
      retryable: true, startedAt, completedAt: utcNow(),
    });
    return { status: 'failed', receivedEvent: persisted.event, attempt, replayed: false, signal: null, queueItem: null };
  }
}

function ingestNormalizedEvent(db, input) {
  // Received fact, rule evaluations, normalized signal, reassessment request
  // and processing outcome commit as one unit. A crash cannot leave an event
  // falsely deduplicated before its governed processing result exists.
  return db.transaction(() => ingestNormalizedEventInternal(db, input)).immediate();
}

function addSeconds(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function recordRun(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connector = connectorRow(db, workspaceId, input.connectorId);
  const startedAt = utcNow(input.startedAt || new Date());
  const completedAt = utcNow(input.completedAt || new Date());
  const counts = {
    received: Math.max(0, Number(input.receivedCount) || 0),
    processed: Math.max(0, Number(input.processedCount) || 0),
    duplicate: Math.max(0, Number(input.duplicateCount) || 0),
    quarantined: Math.max(0, Number(input.quarantinedCount) || 0),
  };
  const status = input.status;
  if (!['succeeded', 'partial', 'failed', 'rate_limited', 'quarantined', 'rejected'].includes(status)) {
    fail('TPRM_CONNECTOR_RUN_STATUS_INVALID', 'Connector run status is invalid.', 400);
  }
  return db.transaction(() => {
    const runId = Number(db.prepare(`INSERT INTO tprm_monitoring_connector_runs
      (workspace_id,connector_id,run_type,status,received_count,processed_count,duplicate_count,
       quarantined_count,error_code,error_redacted,retry_after,started_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      workspaceId, connector.id, input.runType || connector.capability_mode, status, counts.received,
      counts.processed, counts.duplicate, counts.quarantined, input.errorCode || null,
      input.errorRedacted ? redactError(input.errorRedacted) : null, input.retryAfter || null,
      startedAt, completedAt
    ).lastInsertRowid);
    const state = db.prepare(`SELECT * FROM tprm_monitoring_connector_state
      WHERE workspace_id=? AND connector_id=?`).get(workspaceId, connector.id);
    let failures = state.consecutive_failures;
    let retries = state.retry_count;
    let circuit = state.circuit_state;
    let nextAllowed = null;
    let lastSuccess = state.last_success_at;
    let lastFailure = state.last_failure_at;
    if (input.affectsRetryState === false) {
      // Untrusted inbound authentication/format failures are auditable but do
      // not create a denial-of-service backoff against subsequent valid events.
      nextAllowed = state.next_allowed_at;
    } else if (status === 'succeeded') {
      failures = 0; retries = 0; circuit = 'closed'; lastSuccess = completedAt;
    } else {
      failures += 1; retries += 1; lastFailure = completedAt;
      const backoffSeconds = Math.min(86400, 30 * (2 ** Math.min(retries - 1, 11)));
      nextAllowed = input.retryAfter || addSeconds(completedAt, backoffSeconds);
      circuit = failures >= 5 || status === 'rate_limited' ? 'open' : 'closed';
    }
    db.prepare(`UPDATE tprm_monitoring_connector_state SET consecutive_failures=?,retry_count=?,
      circuit_state=?,next_allowed_at=?,last_success_at=?,last_failure_at=?,last_run_id=?,
      updated_at=?,row_version=row_version+1 WHERE workspace_id=? AND connector_id=? AND row_version=?`).run(
      failures, retries, circuit, nextAllowed, lastSuccess, lastFailure, runId, completedAt,
      workspaceId, connector.id, state.row_version
    );
    return {
      run: db.prepare('SELECT * FROM tprm_monitoring_connector_runs WHERE id=?').get(runId),
      state: db.prepare('SELECT * FROM tprm_monitoring_connector_state WHERE workspace_id=? AND connector_id=?').get(workspaceId, connector.id),
    };
  }).immediate();
}

function checkRateState(db, workspaceId, connectorId, now) {
  const state = db.prepare(`SELECT * FROM tprm_monitoring_connector_state
    WHERE workspace_id=? AND connector_id=?`).get(workspaceId, connectorId);
  if (state && state.next_allowed_at && new Date(state.next_allowed_at).getTime() > new Date(now).getTime()) {
    fail('TPRM_CONNECTOR_BACKOFF_ACTIVE', 'Connector retry/backoff window is still active.', 429, {
      nextAllowedAt: state.next_allowed_at, circuitState: state.circuit_state,
    });
  }
  return state;
}

function webhookWindowStart(now) {
  const value = new Date(now);
  value.setUTCSeconds(0, 0);
  return value.toISOString();
}

function webhookSourceHash(value) {
  return sha256(cleanText(value) || '__unknown_source__');
}

function selectBoundedSourceHash(db, workspaceId, connectorId, sourceIdentifier, maxSourceBuckets) {
  const requested = webhookSourceHash(sourceIdentifier);
  const exists = db.prepare(`SELECT 1 FROM tprm_webhook_ingress_buckets
    WHERE workspace_id=? AND connector_id=? AND source_key_hash=?`).get(workspaceId, connectorId, requested);
  if (exists) return requested;
  const globalHash = webhookSourceHash('__connector_global__');
  const overflowHash = webhookSourceHash('__overflow_sources__');
  const count = db.prepare(`SELECT COUNT(*) AS count FROM tprm_webhook_ingress_buckets
    WHERE workspace_id=? AND connector_id=? AND source_key_hash NOT IN (?,?)`).get(
    workspaceId, connectorId, globalHash, overflowHash
  ).count;
  return count >= maxSourceBuckets ? overflowHash : requested;
}

function upsertIngressBucket(db, input) {
  db.prepare(`INSERT INTO tprm_webhook_ingress_buckets
    (workspace_id,connector_id,source_key_hash,window_started_at,request_count,rejected_count,
     last_rejection_code,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,connector_id,source_key_hash) DO UPDATE SET
      window_started_at=excluded.window_started_at,
      request_count=CASE
        WHEN tprm_webhook_ingress_buckets.window_started_at=excluded.window_started_at
          THEN tprm_webhook_ingress_buckets.request_count+excluded.request_count
        ELSE excluded.request_count END,
      rejected_count=CASE
        WHEN tprm_webhook_ingress_buckets.window_started_at=excluded.window_started_at
          THEN tprm_webhook_ingress_buckets.rejected_count+excluded.rejected_count
        ELSE excluded.rejected_count END,
      last_rejection_code=COALESCE(excluded.last_rejection_code,
        CASE WHEN tprm_webhook_ingress_buckets.window_started_at=excluded.window_started_at
          THEN tprm_webhook_ingress_buckets.last_rejection_code ELSE NULL END),
      updated_at=excluded.updated_at`).run(
    input.workspaceId, input.connectorId, input.sourceHash, input.windowStartedAt,
    input.requestCount || 0, input.rejectedCount || 0, input.rejectionCode || null, input.updatedAt
  );
  return db.prepare(`SELECT * FROM tprm_webhook_ingress_buckets
    WHERE workspace_id=? AND connector_id=? AND source_key_hash=?`).get(
    input.workspaceId, input.connectorId, input.sourceHash
  );
}

/**
 * Fixed-window ingress budget evaluated before secret resolution, signature
 * verification and JSON parsing. Source rows are capped and overflow is
 * aggregated, so rotating addresses cannot grow operational state without
 * bound. A connector-global bucket also limits distributed bursts.
 */
function consumeWebhookIngressBudget(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connector = connectorRow(db, workspaceId, input.connectorId, { requireActive: true });
  const now = utcNow(input.now || new Date());
  const limits = {
    sourcePerMinute: Math.max(1, Number(input.sourcePerMinute) || WEBHOOK_RATE_LIMITS.sourcePerMinute),
    connectorPerMinute: Math.max(1, Number(input.connectorPerMinute) || WEBHOOK_RATE_LIMITS.connectorPerMinute),
    maxSourceBucketsPerConnector: Math.max(1, Number(input.maxSourceBucketsPerConnector)
      || WEBHOOK_RATE_LIMITS.maxSourceBucketsPerConnector),
  };
  const windowStartedAt = webhookWindowStart(now);
  const cutoff = new Date(new Date(now).getTime() - WEBHOOK_RATE_LIMITS.retentionHours * 3600000).toISOString();
  const result = db.transaction(() => {
    db.prepare('DELETE FROM tprm_webhook_ingress_buckets WHERE updated_at<?').run(cutoff);
    const sourceHash = selectBoundedSourceHash(
      db, workspaceId, connector.id, input.sourceIdentifier, limits.maxSourceBucketsPerConnector
    );
    const globalHash = webhookSourceHash('__connector_global__');
    const global = upsertIngressBucket(db, {
      workspaceId, connectorId: connector.id, sourceHash: globalHash, windowStartedAt,
      requestCount: 1, updatedAt: now,
    });
    const source = upsertIngressBucket(db, {
      workspaceId, connectorId: connector.id, sourceHash, windowStartedAt,
      requestCount: 1, updatedAt: now,
    });
    const allowed = global.request_count <= limits.connectorPerMinute
      && source.request_count <= limits.sourcePerMinute;
    if (!allowed) {
      for (const row of [global, source]) {
        db.prepare(`UPDATE tprm_webhook_ingress_buckets
          SET rejected_count=rejected_count+1,last_rejection_code='TPRM_WEBHOOK_INGRESS_RATE_LIMITED',updated_at=?
          WHERE workspace_id=? AND connector_id=? AND source_key_hash=?`).run(
          now, workspaceId, connector.id, row.source_key_hash
        );
      }
    }
    return { allowed, global, source };
  }).immediate();
  if (!result.allowed) {
    const nextAllowedAt = new Date(new Date(windowStartedAt).getTime() + 60000).toISOString();
    fail('TPRM_WEBHOOK_INGRESS_RATE_LIMITED', 'Webhook ingress rate limit exceeded.', 429, { nextAllowedAt });
  }
  return { ...result, windowStartedAt };
}

function recordWebhookRejectionAggregate(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connector = connectorRow(db, workspaceId, input.connectorId);
  const now = utcNow(input.now || new Date());
  const windowStartedAt = webhookWindowStart(now);
  const rejectionCode = errorCode(input.error, input.errorCode || 'TPRM_WEBHOOK_REJECTED');
  return db.transaction(() => {
    const sourceHash = selectBoundedSourceHash(
      db, workspaceId, connector.id, input.sourceIdentifier, WEBHOOK_RATE_LIMITS.maxSourceBucketsPerConnector
    );
    const globalHash = webhookSourceHash('__connector_global__');
    for (const hash of new Set([globalHash, sourceHash])) {
      upsertIngressBucket(db, {
        workspaceId, connectorId: connector.id, sourceHash: hash, windowStartedAt,
        rejectedCount: 1, rejectionCode, updatedAt: now,
      });
    }
    return { recorded: true, rejectionCode };
  }).immediate();
}

function ingestWebhook(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connector = connectorRow(db, workspaceId, input.connectorId, { requireActive: true });
  if (connector.capability_mode !== 'webhook') fail('TPRM_CONNECTOR_MODE_INVALID', 'This connector does not accept webhooks.', 409);
  const startedAt = utcNow(input.now || new Date());
  try {
    checkRateState(db, workspaceId, connector.id, startedAt);
    const body = normalizeRawBody(input.rawBody);
    const secret = resolveSecret(connector, input.secretResolver);
    const verified = verifyWebhookSignature({
      rawBody: body, secret, signature: input.signature, timestamp: input.timestamp,
      now: input.now, maxSkewSeconds: input.maxSkewSeconds,
    });
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch (_) {
      fail('TPRM_EVENT_JSON_INVALID', 'Webhook body is not valid JSON.', 400);
    }
    const adapter = getAdapter(connector.provider_type);
    const normalized = adapter.normalize(payload, { receivedAt: startedAt });
    return db.transaction(() => {
      const result = ingestNormalizedEvent(db, {
        workspaceId, connectorId: connector.id, normalized, payloadHash: verified.payloadHash,
        signatureTimestamp: verified.timestampSeconds, signatureDigest: verified.signatureDigest,
        receivedAt: startedAt, startedAt,
        idempotencyKey: input.idempotencyKey,
      });
      const runResult = recordRun(db, {
        workspaceId, connectorId: connector.id, runType: 'webhook',
        status: result.status === 'quarantined' ? 'quarantined' : result.status === 'failed' ? 'failed' : 'succeeded',
        receivedCount: 1, processedCount: result.status === 'processed' ? 1 : 0,
        duplicateCount: result.status === 'duplicate' ? 1 : 0,
        quarantinedCount: result.status === 'quarantined' ? 1 : 0,
        errorCode: result.attempt.error_code, errorRedacted: result.attempt.error_redacted,
        startedAt, completedAt: utcNow(input.now || new Date()),
      });
      return { ...result, connectorRun: runResult.run };
    }).immediate();
  } catch (error) {
    const rejected = isInboundRejectionCode(errorCode(error));
    try {
      if (rejected) {
        recordWebhookRejectionAggregate(db, {
          workspaceId, connectorId: connector.id, sourceIdentifier: input.sourceIdentifier,
          error, now: input.now || new Date(),
        });
      } else {
        recordRun(db, {
          workspaceId, connectorId: connector.id, runType: 'webhook', status: 'failed',
          receivedCount: 0, errorCode: errorCode(error), errorRedacted: redactError(error),
          startedAt, completedAt: utcNow(input.now || new Date()),
        });
      }
    } catch (_) {
      // Preserve the original verification/processing error; run recording must
      // never turn a rejected webhook into an accepted one.
    }
    throw error;
  }
}

function parseCsv(textInput, options = {}) {
  const text = String(textInput == null ? '' : textInput).replace(/^\uFEFF/, '');
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  const maxRows = options.maxRows || 10000;
  const maxColumns = options.maxColumns || 200;
  if (!text || Buffer.byteLength(text, 'utf8') > maxBytes || text.includes('\u0000')) {
    fail('TPRM_CSV_SIZE_INVALID', 'CSV input is empty, invalid, or exceeds the configured size limit.', 413);
  }
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) fail('TPRM_CSV_ROW_LIMIT', 'CSV row limit exceeded.', 413);
    } else cell += char;
    if (cell.length > 10000) fail('TPRM_CSV_CELL_LIMIT', 'CSV cell length limit exceeded.', 413);
  }
  if (quoted) fail('TPRM_CSV_FORMAT_INVALID', 'CSV contains an unterminated quoted field.', 400);
  if (cell || row.length) { row.push(cell); if (row.some(value => value !== '')) rows.push(row); }
  if (rows.length < 2) fail('TPRM_CSV_ROWS_REQUIRED', 'CSV requires a header and at least one data row.', 400);
  const headers = rows.shift().map(header => cleanText(header));
  if (!headers.every(Boolean) || new Set(headers).size !== headers.length || headers.length > maxColumns) {
    fail('TPRM_CSV_HEADER_INVALID', 'CSV headers must be non-empty, unique, and within the column limit.', 400);
  }
  return rows.map((values, index) => {
    if (values.length !== headers.length) fail('TPRM_CSV_COLUMN_MISMATCH', `CSV row ${index + 2} has the wrong number of columns.`, 400);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

function ingestCsvRows(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const connector = connectorRow(db, workspaceId, input.connectorId, { requireActive: true });
  if (connector.capability_mode !== 'csv') fail('TPRM_CONNECTOR_MODE_INVALID', 'This connector does not accept CSV imports.', 409);
  const rows = Array.isArray(input.rows) ? input.rows : parseCsv(input.csvText, input.csvOptions);
  if (!rows.length || rows.length > 10000) fail('TPRM_CSV_ROW_LIMIT', 'CSV import must contain 1 to 10,000 rows.', 413);
  const startedAt = utcNow(input.now || new Date());
  checkRateState(db, workspaceId, connector.id, startedAt);
  const adapter = getAdapter('csv_import');
  return db.transaction(() => {
    const results = [];
    for (const row of rows) {
      const raw = Buffer.from(stableStringify(row), 'utf8');
      try {
        const normalized = adapter.normalize(row, { receivedAt: startedAt });
        results.push(ingestNormalizedEvent(db, {
          workspaceId, connectorId: connector.id, normalized, payloadHash: sha256(raw),
          receivedAt: startedAt, startedAt,
        }));
      } catch (error) {
        results.push({ status: 'rejected', errorCode: errorCode(error), errorRedacted: redactError(error) });
      }
    }
    const counts = {
      processed: results.filter(result => result.status === 'processed').length,
      duplicate: results.filter(result => result.status === 'duplicate').length,
      quarantined: results.filter(result => ['quarantined', 'rejected', 'failed'].includes(result.status)).length,
    };
    const status = counts.quarantined === rows.length ? 'quarantined'
      : counts.quarantined ? 'partial' : 'succeeded';
    const runResult = recordRun(db, {
      workspaceId, connectorId: connector.id, runType: 'csv', status,
      receivedCount: rows.length, processedCount: counts.processed, duplicateCount: counts.duplicate,
      quarantinedCount: counts.quarantined,
      errorCode: counts.quarantined ? 'TPRM_CSV_ROWS_QUARANTINED' : null,
      errorRedacted: counts.quarantined ? `${counts.quarantined} CSV row(s) were rejected, quarantined, or failed closed.` : null,
      startedAt, completedAt: utcNow(input.now || new Date()),
    });
    return { status, counts: { received: rows.length, ...counts }, results, connectorRun: runResult.run };
  }).immediate();
}

function processReassessmentQueueItem(db, input) {
  const workspaceId = positiveId(input.workspaceId, 'workspaceId');
  const actor = firmActor(db, workspaceId, input.actorId);
  const queueId = positiveId(input.queueId, 'queueId');
  let item = db.prepare('SELECT * FROM tprm_reassessment_queue WHERE workspace_id=? AND id=?').get(workspaceId, queueId);
  if (!item) fail('TPRM_REASSESSMENT_QUEUE_NOT_FOUND', 'Reassessment request not found.', 404);
  if (item.status === 'completed') return { queueItem: item, processed: false, replayed: true };
  if (item.status !== 'pending') fail('TPRM_REASSESSMENT_QUEUE_NOT_READY', 'Reassessment request is not ready for processing.', 409);
  if (new Date(item.next_attempt_at).getTime() > Date.now()) {
    fail('TPRM_REASSESSMENT_BACKOFF_ACTIVE', 'Reassessment request retry window has not opened.', 429);
  }
  const claimedAt = utcNow();
  const claimed = db.prepare(`UPDATE tprm_reassessment_queue SET status='processing',attempt_count=attempt_count+1,
    claimed_at=?,last_error_code=NULL,last_error_redacted=NULL,updated_at=?,row_version=row_version+1
    WHERE workspace_id=? AND id=? AND status='pending' AND row_version=?`).run(
    claimedAt, claimedAt, workspaceId, item.id, item.row_version
  );
  if (claimed.changes !== 1) fail('TPRM_REASSESSMENT_QUEUE_RACE', 'Reassessment request was claimed by another worker.', 409);
  item = db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(item.id);
  try {
    return db.transaction(() => {
      const signal = db.prepare(`SELECT * FROM tprm_monitoring_signals
        WHERE workspace_id=? AND supplier_id=? AND id=?`).get(workspaceId, item.supplier_id, item.signal_id);
      if (!signal || !signal.requires_reassessment) fail('TPRM_REASSESSMENT_SIGNAL_INVALID', 'The queued monitoring signal does not require reassessment.', 409);
      const cycleResult = tprmDomain.ensureCurrentCycle(db, {
        workspaceId, supplierId: item.supplier_id, actorId: actor.id, cycleType: 'triggered',
        triggerReason: item.reason,
        idempotencyKey: sha256(`tprm-reassessment-cycle:${workspaceId}:${item.id}`),
      });
      const currentRecommendation = tprmDomain.currentRecommendation(
        db, workspaceId, item.supplier_id, cycleResult.cycle.id
      );
      const signalReceivedAt = utcMillis(signal.received_at || signal.observed_at);
      const recommendationIssuedAt = currentRecommendation
        ? utcMillis(currentRecommendation.issued_at) : null;
      if (!cycleResult.created && currentRecommendation
          && Number.isFinite(signalReceivedAt) && Number.isFinite(recommendationIssuedAt)
          && recommendationIssuedAt <= signalReceivedAt) {
        tprmDomain.recordEvent(db, {
          workspaceId, supplierId: item.supplier_id, moduleId: item.module_id,
          cycleId: cycleResult.cycle.id, eventType: 'reassessment_scheduled',
          actorType: 'system', actorName: 'Nimbus continuous monitoring', reason: item.reason,
          payload: {
            queueId: item.id, signalId: item.signal_id, receivedEventId: item.received_event_id,
            cycleCreated: false, successorRecommendationRequired: true,
            staleRecommendationId: currentRecommendation.id,
          },
          idempotencyKey: sha256(`tprm-reassessment-successor-required:${workspaceId}:${item.id}`),
        });
        const reviewCode = 'TPRM_REASSESSMENT_SUCCESSOR_RECOMMENDATION_REQUIRED';
        const reviewMessage = 'A material signal arrived after the current recommendation. Independent review and a successor recommendation are required before the queue can close.';
        db.prepare(`UPDATE tprm_reassessment_queue SET status='manual_review',claimed_at=NULL,
          last_error_code=?,last_error_redacted=?,updated_at=?,row_version=row_version+1
          WHERE workspace_id=? AND id=? AND status='processing' AND row_version=?`).run(
          reviewCode, reviewMessage, utcNow(), workspaceId, item.id, item.row_version
        );
        return {
          queueItem: db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(item.id),
          cycle: cycleResult.cycle, processed: false, replayed: false,
          failedClosed: true, successorRecommendationRequired: true,
          error: { code: reviewCode, message: reviewMessage },
        };
      }
      let serviceScopes = db.prepare(`SELECT relationship_id,scope_role
        FROM tprm_cycle_relationship_scopes
        WHERE workspace_id=? AND cycle_id=?
        ORDER BY relationship_id`).all(workspaceId, cycleResult.cycle.id);
      if (!serviceScopes.length) {
        const relationships = db.prepare(`SELECT id,is_primary FROM tprm_service_relationships
          WHERE workspace_id=? AND supplier_id=? AND status NOT IN ('rejected','terminated')
          ORDER BY is_primary DESC,id`).all(workspaceId, item.supplier_id);
        if (!relationships.length) {
          fail(
            'TPRM_REASSESSMENT_SERVICE_SCOPE_REQUIRED',
            'Reassessment was retained for manual review because no active service relationship is available to scope it.',
            409
          );
        }
        for (const relationship of relationships) {
          tprmRelationships.linkAssessmentCycle(db, {
            workspaceId,
            relationshipId: relationship.id,
            cycleId: cycleResult.cycle.id,
            actorId: actor.id,
            scopeRole: relationship.is_primary ? 'primary' : 'in_scope',
            scopeRationale: 'Included because the supplier-level monitoring signal could affect this active service relationship.',
          });
        }
        serviceScopes = db.prepare(`SELECT relationship_id,scope_role
          FROM tprm_cycle_relationship_scopes
          WHERE workspace_id=? AND cycle_id=?
          ORDER BY relationship_id`).all(workspaceId, cycleResult.cycle.id);
      }
      tprmDomain.recordEvent(db, {
        workspaceId, supplierId: item.supplier_id, moduleId: item.module_id,
        cycleId: cycleResult.cycle.id, eventType: 'reassessment_scheduled',
        actorType: 'system', actorName: 'Nimbus continuous monitoring', reason: item.reason,
        payload: { queueId: item.id, signalId: item.signal_id, receivedEventId: item.received_event_id,
          cycleCreated: cycleResult.created,
          serviceScopeCount: serviceScopes.length,
          serviceRelationshipIds: serviceScopes.map(scope => scope.relationship_id) },
        idempotencyKey: sha256(`tprm-reassessment-scheduled:${workspaceId}:${item.id}`),
      });
      const completedAt = utcNow();
      db.prepare(`UPDATE tprm_reassessment_queue SET status='completed',completed_at=?,
        resulting_cycle_id=?,updated_at=?,row_version=row_version+1
        WHERE workspace_id=? AND id=? AND status='processing' AND row_version=?`).run(
        completedAt, cycleResult.cycle.id, completedAt, workspaceId, item.id, item.row_version
      );
      return {
        queueItem: db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(item.id),
        cycle: cycleResult.cycle, processed: true, replayed: false,
      };
    }).immediate();
  } catch (error) {
    const current = db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(item.id);
    const manualReview = current.attempt_count >= current.max_attempts;
    const nextAttemptAt = addSeconds(utcNow(), Math.min(86400, 60 * (2 ** Math.min(current.attempt_count - 1, 10))));
    db.prepare(`UPDATE tprm_reassessment_queue SET status=?,claimed_at=NULL,next_attempt_at=?,
      last_error_code=?,last_error_redacted=?,updated_at=?,row_version=row_version+1
      WHERE id=? AND status='processing' AND row_version=?`).run(
      manualReview ? 'manual_review' : 'pending', nextAttemptAt, errorCode(error), redactError(error),
      utcNow(), current.id, current.row_version
    );
    return {
      queueItem: db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(current.id),
      cycle: null, processed: false, replayed: false, failedClosed: true,
      error: { code: errorCode(error), message: redactError(error) },
    };
  }
}

function recoverStaleReassessmentClaims(db, input = {}) {
  if (input.workspaceId) {
    serviceCapabilities.assertCapability(
      db, input.workspaceId, serviceCapabilities.CAPABILITIES.REASSESSMENT_QUEUE
    );
  }
  const cutoffMinutes = Math.max(1, Math.min(1440, Number(input.olderThanMinutes) || 15));
  const rows = input.workspaceId
    ? db.prepare(`SELECT * FROM tprm_reassessment_queue WHERE workspace_id=? AND status='processing'
        AND claimed_at<=datetime('now',?)`).all(positiveId(input.workspaceId, 'workspaceId'), `-${cutoffMinutes} minutes`)
    : db.prepare(`SELECT * FROM tprm_reassessment_queue WHERE status='processing'
        AND claimed_at<=datetime('now',?)`).all(`-${cutoffMinutes} minutes`);
  const update = db.prepare(`UPDATE tprm_reassessment_queue SET status=?,claimed_at=NULL,
    next_attempt_at=datetime('now'),last_error_code='TPRM_WORKER_LEASE_EXPIRED',
    last_error_redacted='A processing lease expired before completion; work was retained for retry or manual review.',
    updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND status='processing' AND row_version=?`);
  let recovered = 0;
  db.transaction(() => {
    for (const item of rows) {
      // A global worker may encounter retained queue history from a closed or
      // narrower service period. Such rows remain readable but are never
      // operationally rewritten.
      try {
        serviceCapabilities.assertCapability(
          db, item.workspace_id, serviceCapabilities.CAPABILITIES.REASSESSMENT_QUEUE
        );
      } catch (error) {
        if (error instanceof serviceCapabilities.TprmCapabilityError) continue;
        throw error;
      }
      const status = item.attempt_count >= item.max_attempts ? 'manual_review' : 'pending';
      recovered += update.run(status, item.id, item.row_version).changes;
    }
  }).immediate();
  return { recovered };
}

function connectorHealth(db, workspaceIdInput, connectorIdInput) {
  const connector = connectorRow(db, workspaceIdInput, connectorIdInput);
  const state = db.prepare(`SELECT * FROM tprm_monitoring_connector_state
    WHERE workspace_id=? AND connector_id=?`).get(connector.workspace_id, connector.id);
  const lastRun = db.prepare(`SELECT * FROM tprm_monitoring_connector_runs
    WHERE workspace_id=? AND connector_id=? AND status!='rejected' ORDER BY id DESC LIMIT 1`).get(connector.workspace_id, connector.id) || null;
  const lastRejectedRun = db.prepare(`SELECT * FROM tprm_monitoring_connector_runs
    WHERE workspace_id=? AND connector_id=? AND status='rejected' ORDER BY id DESC LIMIT 1`).get(connector.workspace_id, connector.id) || null;
  let health = 'never_run';
  if (connector.status === 'disabled') health = 'disabled';
  else if (connector.status === 'paused') health = 'paused';
  else if (state && state.circuit_state === 'open') health = 'unhealthy';
  else if (lastRun && ['failed', 'rate_limited'].includes(lastRun.status)) health = 'unhealthy';
  else if (lastRun && ['partial', 'quarantined'].includes(lastRun.status)) health = 'degraded';
  else if (lastRun && lastRun.status === 'succeeded') health = 'healthy';
  const connected = connector.status === 'active' && Boolean(lastRun && lastRun.status === 'succeeded');
  return { connector, state, lastRun, lastRejectedRun, health, connected, failurePolicy: FAILURE_POLICY };
}

function verifyReceivedEventChain(db, workspaceIdInput, connectorIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const connector = connectorRow(db, workspaceId, connectorIdInput);
  const events = db.prepare(`SELECT * FROM tprm_monitoring_received_events
    WHERE workspace_id=? AND connector_id=? ORDER BY id`).all(workspaceId, connector.id);
  let previousEventHash = null;
  for (const event of events) {
    const expected = sha256(stableStringify({
      workspaceId, connectorId: connector.id, mappingId: event.mapping_id,
      supplierId: event.supplier_id, providerEventId: event.provider_event_id,
      providerEntityId: event.provider_entity_id, idempotencyKey: event.idempotency_key,
      payloadHash: event.payload_hash, normalizedHash: event.normalized_hash,
      signatureTimestamp: event.signature_timestamp, signatureDigest: event.signature_digest,
      observedAt: event.observed_at, receivedAt: event.received_at, previousEventHash,
    }));
    if (event.previous_event_hash !== previousEventHash || event.event_hash !== expected) {
      return { valid: false, checked: events.indexOf(event), firstInvalidId: event.id };
    }
    previousEventHash = event.event_hash;
  }
  return { valid: true, checked: events.length, firstInvalidId: null, headHash: previousEventHash };
}

function verifyConnectorAuditChain(db, workspaceIdInput, connectorIdInput) {
  const workspaceId = positiveId(workspaceIdInput, 'workspaceId');
  const connector = connectorRow(db, workspaceId, connectorIdInput);
  const events = db.prepare(`SELECT * FROM tprm_monitoring_connector_audit
    WHERE workspace_id=? AND connector_id=? ORDER BY id`).all(workspaceId, connector.id);
  let previousEventHash = null;
  for (const event of events) {
    const expected = sha256(stableStringify({
      workspaceId, connectorId: connector.id, eventType: event.event_type,
      actorUserId: event.actor_user_id, actorType: event.actor_type, actorName: event.actor_name,
      details: parseJson(event.details_json, {}), previousEventHash, occurredAt: event.occurred_at,
    }));
    if (event.previous_event_hash !== previousEventHash || event.event_hash !== expected) {
      return { valid: false, checked: events.indexOf(event), firstInvalidId: event.id };
    }
    previousEventHash = event.event_hash;
  }
  return { valid: true, checked: events.length, firstInvalidId: null, headHash: previousEventHash };
}

function guardServiceMutation(capability, operation) {
  return serviceCapabilities.withCapability(capability, operation);
}

module.exports = {
  TprmConnectorError,
  PROVIDER_TYPES,
  SIGNAL_TYPES,
  SEVERITIES,
  SECRET_SCHEMES,
  FAILURE_POLICY,
  ADAPTERS,
  stableStringify,
  sha256,
  redactError,
  listAdapters,
  getAdapter,
  createConnector: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, createConnector),
  updateConnectorStatus: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, updateConnectorStatus),
  rotateSecretReference: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, rotateSecretReference),
  createSupplierMapping: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, createSupplierMapping),
  retireSupplierMapping: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, retireSupplierMapping),
  createRule: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, createRule),
  evaluateRules,
  signWebhook,
  verifyWebhookSignature,
  parseCsv,
  ingestWebhook: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_SIGNALS, ingestWebhook),
  consumeWebhookIngressBudget: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, consumeWebhookIngressBudget),
  recordWebhookRejectionAggregate: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, recordWebhookRejectionAggregate),
  ingestCsvRows: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_SIGNALS, ingestCsvRows),
  ingestNormalizedEvent: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_SIGNALS, ingestNormalizedEvent),
  recordRun: guardServiceMutation(serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS, recordRun),
  connectorHealth,
  verifyReceivedEventChain,
  verifyConnectorAuditChain,
  processReassessmentQueueItem: guardServiceMutation(serviceCapabilities.CAPABILITIES.REASSESSMENT_QUEUE, processReassessmentQueueItem),
  recoverStaleReassessmentClaims,
  serviceCapabilities,
};
