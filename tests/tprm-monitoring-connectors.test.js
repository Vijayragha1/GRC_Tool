'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');

const domain = require('../lib/tprm-domain');
const monitoring = require('../lib/tprm-monitoring-connectors');
const relationships = require('../lib/tprm-relationships');

function setup(t) {
  const env = bootApp();
  const appDb = require('../db').db;
  const db = new Database(env.dbPath);
  db.pragma('foreign_keys = ON');
  const firm = db.prepare('SELECT * FROM firms ORDER BY id LIMIT 1').get();
  const suffix = crypto.randomBytes(4).toString('hex');
  const managerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,'manager',1)`).run(
    `monitoring-manager-${suffix}@example.test`, '!test-only', 'Monitoring Manager', firm.id
  ).lastInsertRowid);
  const workspaceOne = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Monitoring client one','[]')`).run(firm.id).lastInsertRowid);
  const workspaceTwo = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Monitoring client two','[]')`).run(firm.id).lastInsertRowid);
  const supplierOne = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,'Mapped cloud provider','Managed hosting','prospect','tier_1')`).run(workspaceOne).lastInsertRowid);
  const supplierTwo = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,'Other tenant provider','Payroll','prospect','tier_2')`).run(workspaceTwo).lastInsertRowid);
  domain.enableModule(db, {
    workspaceId: workspaceOne, serviceModel: 'managed_lifecycle', actorId: managerId,
    reason: 'Continuous third-party risk monitoring is contracted for this client.',
  });
  domain.enableModule(db, {
    workspaceId: workspaceTwo, serviceModel: 'managed_lifecycle', actorId: managerId,
    reason: 'Separate client tenant used to verify the isolation boundary.',
  });
  const relationshipOne = relationships.createRelationship(db, {
    workspaceId: workspaceOne,
    supplierId: supplierOne,
    actorId: managerId,
    relationshipName: 'Managed hosting service',
    serviceCategory: 'Cloud hosting',
    serviceDescription: 'Production hosting and managed infrastructure supporting the client service.',
    provisionModel: 'saas',
    status: 'active',
    criticality: 'critical',
    dataAccess: 'restricted',
    privilegedAccess: true,
    isPrimary: true,
    legalName: 'Mapped cloud provider',
    reason: 'Establish the exact monitored service relationship for reassessment scope.',
    idempotencyKey: `monitoring-relationship-${suffix}`,
  }).relationship;
  const secret = 'test-webhook-secret-material-32-bytes';
  const connector = monitoring.createConnector(db, {
    workspaceId: workspaceOne, actorId: managerId, providerType: 'generic_webhook',
    capabilityMode: 'webhook', name: 'Signed intelligence feed', status: 'active',
    secretReference: 'vault://nimbus-test/client-one/webhook',
    adapterConfig: { environment: 'test', acceptedSchema: 'nimbus.monitoring.v1' },
  });
  const mapping = monitoring.createSupplierMapping(db, {
    workspaceId: workspaceOne, connectorId: connector.id, actorId: managerId,
    supplierId: supplierOne, providerEntityId: 'provider-entity-001',
    mappingNote: 'Verified against the provider account identifier.',
  });
  t.after(() => {
    db.close();
    try { appDb.close(); } catch (_) {}
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  });
  return {
    env, db, firm, managerId, workspaceOne, workspaceTwo, supplierOne, supplierTwo,
    connector, mapping, relationshipOne, secret,
  };
}

function signedEvent(ids, overrides = {}) {
  const timestamp = overrides.timestamp || Math.floor(Date.now() / 1000);
  const event = {
    event_id: overrides.eventId || `event-${crypto.randomBytes(5).toString('hex')}`,
    provider_entity_id: overrides.providerEntityId || 'provider-entity-001',
    observed_at: overrides.observedAt || new Date(timestamp * 1000).toISOString(),
    signal_type: overrides.signalType || 'control_change',
    severity: overrides.severity || 'low',
    title: overrides.title || 'External security score changed',
    description: overrides.description || 'The independently observed security score crossed a governed threshold.',
    metrics: overrides.metrics === undefined ? { score: 42 } : overrides.metrics,
  };
  const rawBody = JSON.stringify(event);
  const signature = monitoring.signWebhook({ secret: ids.secret, timestamp, rawBody });
  return { timestamp, event, rawBody, signature, now: new Date(timestamp * 1000) };
}

test('HMAC verification binds timestamp and exact body and enforces replay-window controls', () => {
  const secret = 'test-webhook-secret-material-32-bytes';
  const timestamp = 1787151600;
  const rawBody = JSON.stringify({ event_id: 'evt-1', provider_entity_id: 'entity-1' });
  const signature = monitoring.signWebhook({ secret, timestamp, rawBody });
  const accepted = monitoring.verifyWebhookSignature({
    secret, timestamp, rawBody, signature: `t=${timestamp},v1=${signature}`,
    now: new Date(timestamp * 1000),
  });
  assert.equal(accepted.valid, true);
  assert.match(accepted.signatureDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => monitoring.verifyWebhookSignature({
    secret, timestamp, rawBody: `${rawBody} `, signature, now: new Date(timestamp * 1000),
  }), error => error.code === 'TPRM_WEBHOOK_SIGNATURE_INVALID');
  assert.throws(() => monitoring.verifyWebhookSignature({
    secret, timestamp, rawBody, signature, now: new Date((timestamp + 301) * 1000),
  }), error => error.code === 'TPRM_WEBHOOK_TIMESTAMP_STALE');
  assert.throws(() => monitoring.verifyWebhookSignature({
    secret, timestamp, rawBody, signature, now: new Date(timestamp * 1000), replayGuard: () => false,
  }), error => error.code === 'TPRM_WEBHOOK_REPLAY');
});

test('connector configuration stores a secret reference only and paid adapters disclose their boundary', t => {
  const ids = setup(t);
  assert.throws(() => monitoring.createConnector(ids.db, {
    workspaceId: ids.workspaceOne, actorId: ids.managerId, providerType: 'generic_webhook',
    name: 'Unsafe connector', status: 'active', secretReference: 'vault://unsafe/ref',
    adapterConfig: { apiKey: ids.secret },
  }), error => error.code === 'TPRM_SECRET_MATERIAL_FORBIDDEN');
  assert.throws(() => ids.db.prepare(`INSERT INTO tprm_monitoring_connectors
    (workspace_id,module_id,provider_type,capability_mode,name,ingress_key,status,secret_reference,
     adapter_config_json,created_by)
    VALUES (?,(SELECT id FROM tprm_modules WHERE workspace_id=? AND status='active'),
      'generic_webhook','webhook','Direct unsafe connector',?,'active','vault://unsafe/direct',?,?)`).run(
    ids.workspaceOne, ids.workspaceOne, 'f'.repeat(32), JSON.stringify({ nested: { clientSecret: ids.secret } }), ids.managerId
  ), /cannot contain secret material/);

  const stored = ids.db.prepare('SELECT * FROM tprm_monitoring_connectors WHERE id=?').get(ids.connector.id);
  assert.equal(stored.secret_reference, 'vault://nimbus-test/client-one/webhook');
  assert.equal(JSON.stringify(stored).includes(ids.secret), false);
  const entireConnectorStore = JSON.stringify({
    connectors: ids.db.prepare('SELECT * FROM tprm_monitoring_connectors').all(),
    audit: ids.db.prepare('SELECT * FROM tprm_monitoring_connector_audit').all(),
  });
  assert.equal(entireConnectorStore.includes(ids.secret), false, 'resolved credential material never enters connector or audit storage');

  const paid = monitoring.listAdapters().filter(adapter => ['securityscorecard', 'bitsight', 'riskrecon'].includes(adapter.providerType));
  assert.equal(paid.length, 3);
  paid.forEach(adapter => {
    assert.equal(adapter.integrationState, 'adapter_contract_only');
    assert.equal(adapter.liveOutbound, false);
    assert.throws(() => monitoring.getAdapter(adapter.providerType).poll(),
      error => error.code === 'TPRM_PAID_ADAPTER_NOT_CONNECTED');
  });
});

test('provider-to-third-party mappings enforce tenant isolation in both domain and SQL', t => {
  const ids = setup(t);
  assert.throws(() => monitoring.createSupplierMapping(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id, actorId: ids.managerId,
    supplierId: ids.supplierTwo, providerEntityId: 'cross-tenant-provider',
  }), error => error.code === 'TPRM_MAPPING_CROSS_TENANT');
  assert.throws(() => ids.db.prepare(`INSERT INTO tprm_connector_supplier_mappings
    (workspace_id,connector_id,provider_entity_id,supplier_id,created_by)
    VALUES (?,?,?,?,?)`).run(
    ids.workspaceOne, ids.connector.id, 'direct-cross-tenant', ids.supplierTwo, ids.managerId
  ), /FOREIGN KEY constraint failed/);
  assert.throws(() => monitoring.createSupplierMapping(ids.db, {
    workspaceId: ids.workspaceTwo, connectorId: ids.connector.id, actorId: ids.managerId,
    supplierId: ids.supplierTwo, providerEntityId: 'wrong-connector-tenant',
  }), error => error.code === 'TPRM_CONNECTOR_NOT_FOUND');
});

test('signed intake deduplicates provider events, escalates threshold severity and queues one reassessment', t => {
  const ids = setup(t);
  monitoring.createRule(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id, actorId: ids.managerId,
    ruleKey: 'security-score-critical', metricPath: 'metrics.score', operator: 'lte', threshold: 60,
    signalType: 'control_change', severity: 'critical', requiresReassessment: true,
    title: 'Security score crossed the critical reassessment threshold',
  });
  const event = signedEvent(ids, { eventId: 'provider-event-dedupe-1' });
  const input = {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
    rawBody: event.rawBody, signature: event.signature, timestamp: event.timestamp, now: event.now,
    secretResolver: reference => {
      assert.equal(reference, 'vault://nimbus-test/client-one/webhook');
      return ids.secret;
    },
  };
  const first = monitoring.ingestWebhook(ids.db, input);
  assert.equal(first.status, 'processed');
  assert.equal(first.signal.severity, 'critical');
  assert.equal(first.signal.requires_reassessment, 1);
  assert.equal(first.queueItem.status, 'pending');
  const second = monitoring.ingestWebhook(ids.db, input);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.replayed, true);
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_received_events').get().count, 1);
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_signals').get().count, 1);
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_reassessment_queue').get().count, 1);
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_processing_attempts').get().count, 2);
  assert.deepEqual(monitoring.verifyReceivedEventChain(ids.db, ids.workspaceOne, ids.connector.id), {
    valid: true, checked: 1, firstInvalidId: null, headHash: first.receivedEvent.event_hash,
  });
  assert.equal(monitoring.verifyConnectorAuditChain(ids.db, ids.workspaceOne, ids.connector.id).valid, true);
  assert.throws(() => ids.db.prepare('UPDATE tprm_monitoring_received_events SET provider_event_id=? WHERE id=?')
    .run('tampered', first.receivedEvent.id), /immutable/);

  const conflicting = signedEvent(ids, { eventId: 'provider-event-dedupe-1', metrics: { score: 41 } });
  assert.throws(() => monitoring.ingestWebhook(ids.db, {
    ...input, rawBody: conflicting.rawBody, signature: conflicting.signature,
    timestamp: conflicting.timestamp, now: conflicting.now,
  }), error => error.code === 'TPRM_EVENT_IDEMPOTENCY_CONFLICT');
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_received_events').get().count, 1,
    'an event-id replay with different content cannot rewrite or fork the immutable fact');

  const processed = monitoring.processReassessmentQueueItem(ids.db, {
    workspaceId: ids.workspaceOne, queueId: first.queueItem.id, actorId: ids.managerId,
  });
  assert.equal(processed.processed, true);
  assert.equal(processed.queueItem.status, 'completed');
  assert.equal(processed.cycle.cycle_type, 'triggered');
  const serviceScope = ids.db.prepare(`SELECT * FROM tprm_cycle_relationship_scopes
    WHERE workspace_id=? AND cycle_id=? AND relationship_id=?`).get(
    ids.workspaceOne, processed.cycle.id, ids.relationshipOne.id
  );
  assert.ok(serviceScope, 'a monitoring-triggered reassessment must freeze the affected service relationship scope');
  assert.equal(serviceScope.scope_role, 'primary');
  assert.ok(ids.db.prepare(`SELECT 1 FROM tprm_lifecycle_events
    WHERE event_type='reassessment_scheduled' AND supplier_id=?`).get(ids.supplierOne));
});

test('a post-recommendation material signal requires an independently reviewed successor before queue closure', t => {
  const ids = setup(t);
  const authorId = Number(ids.db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,'consultant',1)`).run(
      `monitoring-author-${crypto.randomBytes(4).toString('hex')}@example.test`,
      '!test-only', 'Monitoring recommendation author', ids.firm.id
    ).lastInsertRowid);
  const cycle = domain.ensureCurrentCycle(ids.db, {
    workspaceId: ids.workspaceOne, supplierId: ids.supplierOne,
    actorId: ids.managerId, cycleType: 'onboarding',
  }).cycle;
  relationships.linkAssessmentCycle(ids.db, {
    workspaceId: ids.workspaceOne, relationshipId: ids.relationshipOne.id,
    cycleId: cycle.id, actorId: ids.managerId, scopeRole: 'primary',
    scopeRationale: 'Exact production service assessed before the monitoring signal arrived.',
  });
  const insertRecommendation = (version, issuedAt, supersedesId = null) => Number(ids.db.prepare(`INSERT INTO tprm_recommendations
    (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
     residual_risk_band,readiness_snapshot_json,artifact_snapshot_json,recommendation_hash,
     issued_by,issuer_name,issued_at,quality_reviewed_by,quality_reviewer_name,quality_reviewed_at,
     quality_review_rationale,supersedes_id)
    VALUES (?,?,?,?,'recommend_onboard',?,?,'low','{}','{}',?,?,?,?,?,?,?, ?,?)`).run(
      ids.workspaceOne, ids.supplierOne, cycle.id, version,
      `Recommendation version ${version} for monitored service scope.`,
      'The independently reviewed evidence supported this recommendation at its issue time.',
      crypto.createHash('sha256').update(`monitoring-recommendation-${cycle.id}-${version}`).digest('hex'),
      authorId, 'Monitoring recommendation author', issuedAt,
      ids.managerId, 'Monitoring Manager', issuedAt,
      'Independent quality review completed against the evidence available at issue time.',
      supersedesId
    ).lastInsertRowid);
  const firstRecommendationId = insertRecommendation(1, '2000-01-01T00:00:00.000Z');
  monitoring.createRule(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id, actorId: ids.managerId,
    ruleKey: 'post-recommendation-critical', metricPath: 'metrics.score', operator: 'lte', threshold: 60,
    signalType: 'control_change', severity: 'critical', requiresReassessment: true,
    title: 'Post-recommendation signal requires renewed review',
  });
  const event = signedEvent(ids, {
    eventId: 'post-recommendation-material-event',
    observedAt: '2026-08-20T09:00:00.000Z',
  });
  const intake = monitoring.ingestWebhook(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
    rawBody: event.rawBody, signature: event.signature, timestamp: event.timestamp, now: event.now,
    secretResolver: () => ids.secret,
  });
  const held = monitoring.processReassessmentQueueItem(ids.db, {
    workspaceId: ids.workspaceOne, queueId: intake.queueItem.id, actorId: ids.managerId,
  });
  assert.equal(held.processed, false);
  assert.equal(held.successorRecommendationRequired, true);
  assert.equal(held.queueItem.status, 'manual_review');
  assert.equal(held.queueItem.resulting_cycle_id, null);

  insertRecommendation(2, '2099-08-20T10:00:00.000Z', firstRecommendationId);
  ids.db.prepare(`UPDATE tprm_reassessment_queue SET status='pending',next_attempt_at=datetime('now'),
    last_error_code=NULL,last_error_redacted=NULL,updated_at=datetime('now'),row_version=row_version+1
    WHERE id=? AND status='manual_review'`).run(intake.queueItem.id);
  const completed = monitoring.processReassessmentQueueItem(ids.db, {
    workspaceId: ids.workspaceOne, queueId: intake.queueItem.id, actorId: ids.managerId,
  });
  assert.equal(completed.processed, true);
  assert.equal(completed.queueItem.status, 'completed');
  assert.equal(completed.cycle.id, cycle.id, 'the existing governed cycle is reused only after a fresh successor recommendation');
});

test('bounded scheduled worker converts verified signals into service-scoped reassessments', t => {
  const ids = setup(t);
  monitoring.createRule(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id, actorId: ids.managerId,
    ruleKey: 'scheduled-worker-critical', metricPath: 'metrics.score', operator: 'lte', threshold: 60,
    signalType: 'control_change', severity: 'critical', requiresReassessment: true,
    title: 'Scheduled worker reassessment threshold',
  });
  const event = signedEvent(ids, { eventId: 'scheduled-worker-event-1' });
  const intake = monitoring.ingestWebhook(ids.db, {
    workspaceId: ids.workspaceOne,
    connectorId: ids.connector.id,
    rawBody: event.rawBody,
    signature: event.signature,
    timestamp: event.timestamp,
    now: event.now,
    secretResolver: () => ids.secret,
  });
  assert.equal(intake.queueItem.status, 'pending');

  const jobs = require('../lib/jobs');
  const summary = jobs.jobTprmReassessmentQueue();
  assert.equal(summary.processed, 1);
  assert.equal(summary.failed, 0);
  const completed = ids.db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(intake.queueItem.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.resulting_cycle_id);
  assert.ok(ids.db.prepare(`SELECT 1 FROM tprm_cycle_relationship_scopes
    WHERE workspace_id=? AND cycle_id=? AND relationship_id=?`).get(
    ids.workspaceOne, completed.resulting_cycle_id, ids.relationshipOne.id
  ));
  assert.ok(ids.db.prepare(`SELECT 1 FROM notifications
    WHERE workspace_id=? AND category='tprm_reassessment_started'`).get(ids.workspaceOne));
});

test('missing rule data and disabled-module processing fail closed without erasing received facts', t => {
  const ids = setup(t);
  monitoring.createRule(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id, actorId: ids.managerId,
    ruleKey: 'required-rating', metricPath: 'metrics.required_rating', operator: 'lte', threshold: 50,
    signalType: 'control_change', severity: 'high', requiresReassessment: true,
    missingBehavior: 'quarantine', title: 'Required provider rating threshold',
  });
  const missing = signedEvent(ids, { eventId: 'provider-event-missing-field', metrics: { score: 72 } });
  const quarantined = monitoring.ingestWebhook(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
    rawBody: missing.rawBody, signature: missing.signature, timestamp: missing.timestamp, now: missing.now,
    secretResolver: () => ids.secret,
  });
  assert.equal(quarantined.status, 'quarantined');
  assert.equal(quarantined.signal, null);
  assert.equal(quarantined.attempt.error_code, 'TPRM_RULE_REQUIRED_FIELD_MISSING');
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_received_events').get().count, 1,
    'the immutable event digest remains available for investigation');
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_signals').get().count, 0,
    'an unevaluable event cannot create an apparently trusted signal');
  assert.equal(monitoring.connectorHealth(ids.db, ids.workspaceOne, ids.connector.id).health, 'degraded');

  const secondConnector = monitoring.createConnector(ids.db, {
    workspaceId: ids.workspaceOne, actorId: ids.managerId, providerType: 'generic_webhook',
    name: 'Second signed feed', status: 'active', secretReference: 'vault://nimbus-test/second-feed',
    adapterConfig: { schema: 'nimbus.monitoring.v1' },
  });
  monitoring.createSupplierMapping(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: secondConnector.id, actorId: ids.managerId,
    supplierId: ids.supplierOne, providerEntityId: 'provider-entity-001',
  });
  monitoring.createRule(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: secondConnector.id, actorId: ids.managerId,
    ruleKey: 'critical-score', metricPath: 'metrics.score', operator: 'lte', threshold: 60,
    signalType: 'control_change', severity: 'critical', requiresReassessment: true,
    title: 'Critical external score',
  });
  const actionable = signedEvent(ids, { eventId: 'provider-event-disabled-module' });
  const accepted = monitoring.ingestWebhook(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: secondConnector.id,
    rawBody: actionable.rawBody, signature: actionable.signature, timestamp: actionable.timestamp,
    now: actionable.now, secretResolver: () => ids.secret,
  });
  assert.equal(accepted.queueItem.status, 'pending');
  domain.closeModule(ids.db, {
    workspaceId: ids.workspaceOne, actorId: ids.managerId,
    reason: 'Contracted monitoring service is being intentionally closed for the fail-closed test.',
  });
  assert.throws(() => monitoring.processReassessmentQueueItem(ids.db, {
    workspaceId: ids.workspaceOne, queueId: accepted.queueItem.id, actorId: ids.managerId,
  }), error => error.code === 'TPRM_SERVICE_PERIOD_CLOSED' && error.status === 409);
  const retained = ids.db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(accepted.queueItem.id);
  assert.equal(retained.status, 'pending');
  assert.equal(retained.resulting_cycle_id, null);
  assert.equal(ids.db.prepare(`SELECT COUNT(*) AS count FROM tprm_assessment_cycles
    WHERE workspace_id=? AND trigger_reason LIKE 'Monitoring reassessment:%'`).get(ids.workspaceOne).count, 0);
});

test('invalid signatures are rejected before event creation and errors/runs remain redacted', t => {
  const ids = setup(t);
  const event = signedEvent(ids, { eventId: 'provider-event-invalid-signature' });
  assert.throws(() => monitoring.ingestWebhook(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
    rawBody: event.rawBody, signature: '0'.repeat(64), timestamp: event.timestamp, now: event.now,
    secretResolver: () => ids.secret,
  }), error => error.code === 'TPRM_WEBHOOK_SIGNATURE_INVALID');
  assert.equal(ids.db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_received_events').get().count, 0);
  assert.equal(ids.db.prepare(`SELECT COUNT(*) AS count FROM tprm_monitoring_connector_runs
    WHERE status='rejected'`).get().count, 0,
  'untrusted failures are bounded aggregates, not an attacker-controlled immutable run stream');
  const aggregate = ids.db.prepare(`SELECT SUM(rejected_count) AS count FROM tprm_webhook_ingress_buckets
    WHERE workspace_id=? AND connector_id=?`).get(ids.workspaceOne, ids.connector.id);
  assert.ok(aggregate.count >= 1);
  const rejectedHealth = monitoring.connectorHealth(ids.db, ids.workspaceOne, ids.connector.id);
  assert.equal(rejectedHealth.health, 'never_run');
  assert.equal(rejectedHealth.connected, false);
  assert.equal(JSON.stringify(rejectedHealth).includes(ids.secret), false);

  const valid = signedEvent(ids, { eventId: 'provider-event-after-invalid-signature' });
  const accepted = monitoring.ingestWebhook(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
    rawBody: valid.rawBody, signature: valid.signature, timestamp: valid.timestamp, now: valid.now,
    secretResolver: () => ids.secret,
  });
  assert.equal(accepted.status, 'processed', 'an invalid unauthenticated request cannot back off a later valid webhook');
  assert.equal(monitoring.connectorHealth(ids.db, ids.workspaceOne, ids.connector.id).connected, true);
});

test('ingress budgets enforce source and connector limits while capping source state', t => {
  const ids = setup(t);
  const now = new Date('2026-08-20T09:15:10.000Z');
  for (let index = 0; index < 2; index += 1) {
    monitoring.consumeWebhookIngressBudget(ids.db, {
      workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
      sourceIdentifier: '192.0.2.10', now, sourcePerMinute: 2,
      connectorPerMinute: 100, maxSourceBucketsPerConnector: 2,
    });
  }
  assert.throws(() => monitoring.consumeWebhookIngressBudget(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
    sourceIdentifier: '192.0.2.10', now, sourcePerMinute: 2,
    connectorPerMinute: 100, maxSourceBucketsPerConnector: 2,
  }), error => error.code === 'TPRM_WEBHOOK_INGRESS_RATE_LIMITED' && error.status === 429);

  for (let index = 0; index < 20; index += 1) {
    monitoring.consumeWebhookIngressBudget(ids.db, {
      workspaceId: ids.workspaceOne, connectorId: ids.connector.id,
      sourceIdentifier: `198.51.100.${index}`, now,
      sourcePerMinute: 100, connectorPerMinute: 100,
      maxSourceBucketsPerConnector: 2,
    });
  }
  const rowCount = ids.db.prepare(`SELECT COUNT(*) AS count FROM tprm_webhook_ingress_buckets
    WHERE workspace_id=? AND connector_id=?`).get(ids.workspaceOne, ids.connector.id).count;
  assert.ok(rowCount <= 4, `source-bucket storage must remain bounded, found ${rowCount}`);
});

test('governed CSV adapter parses quoted rows and uses the same mapping, rule and queue controls', t => {
  const ids = setup(t);
  const connector = monitoring.createConnector(ids.db, {
    workspaceId: ids.workspaceOne, actorId: ids.managerId, providerType: 'csv_import',
    capabilityMode: 'csv', name: 'Monthly governed CSV feed', status: 'active',
    adapterConfig: { sourceOwner: 'Security assurance team' },
  });
  monitoring.createSupplierMapping(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: connector.id, actorId: ids.managerId,
    supplierId: ids.supplierOne, providerEntityId: 'provider-entity-001',
  });
  monitoring.createRule(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: connector.id, actorId: ids.managerId,
    ruleKey: 'csv-score-critical', metricPath: 'metrics.score', operator: 'lte', threshold: 50,
    signalType: 'control_change', severity: 'critical', requiresReassessment: true,
    title: 'Imported rating crossed the critical threshold',
  });
  const csv = [
    'event_id,provider_entity_id,observed_at,signal_type,severity,title,score',
    'csv-event-1,provider-entity-001,2026-08-20T08:00:00Z,control_change,low,"Rating, threshold alert",44',
  ].join('\n');
  const parsed = monitoring.parseCsv(csv);
  assert.equal(parsed[0].title, 'Rating, threshold alert');
  const result = monitoring.ingestCsvRows(ids.db, {
    workspaceId: ids.workspaceOne, connectorId: connector.id, rows: parsed,
    now: new Date('2026-08-20T08:05:00Z'),
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.counts, { received: 1, processed: 1, duplicate: 0, quarantined: 0 });
  assert.equal(result.results[0].signal.severity, 'critical');
  assert.equal(result.results[0].queueItem.status, 'pending');
  assert.equal(result.connectorRun.status, 'succeeded');
});
