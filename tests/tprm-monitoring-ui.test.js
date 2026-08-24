'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const { bootApp, makeClient } = require('./helpers');

const rbac = require('../lib/rbac');
const relationships = require('../lib/tprm-relationships');

let env;
let db;
let appDb;
let app;
let client;
let manager;
let clientUser;
let workspaceId;
let otherWorkspaceId;
let supplierId;
let otherSupplierId;
let relationshipId;
let connector;
let secret;

function rawRequest(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const listening = server.listening ? Promise.resolve() : new Promise((yes, no) => {
      server.once('listening', yes);
      server.once('error', no);
    });
    listening.then(() => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        method,
        path: urlPath,
        headers,
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.once('error', reject);
      if (body != null) request.write(body);
      request.end();
    }, reject);
  });
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).send('Authentication required');
  return next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = rbac.rolePermissions(req.workspace && req.workspace._userRole || req.user.firm_role);
    req.userPerms = permissions;
    res.locals.userPerms = permissions;
    if (!rbac.hasPermission(permissions, permission)) return res.status(403).send('Permission denied');
    return next();
  };
}

function requireWorkspace(req, res, next) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(Number(req.params.wsId));
  if (!workspace || (req.user.user_type === 'firm' && workspace.firm_id !== req.user.firm_id)) {
    return res.status(403).send('Workspace denied');
  }
  const member = req.user.user_type === 'client'
    ? db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id, req.user.id)
    : null;
  if (req.user.user_type === 'client' && !member) return res.status(403).send('Workspace denied');
  req.workspace = {
    ...workspace,
    frameworks: [],
    stage: workspace.stage || 'new',
    _userRole: member && member.role || req.user.firm_role,
    tprm_enabled: 1,
    tprm_active: 1,
  };
  res.locals.entitySelectorWs = req.workspace;
  res.locals.activeFirm = db.prepare('SELECT id,name FROM firms WHERE id=?').get(workspace.firm_id);
  res.locals.firmWorkspaces = [req.workspace];
  return next();
}

test.before(async () => {
  env = bootApp();
  appDb = require('../db').db;
  db = new Database(env.dbPath);
  db.pragma('foreign_keys = ON');
  const domain = require('../lib/tprm-domain');
  const monitoring = require('../lib/tprm-monitoring-connectors');
  const routes = require('../routes/tprm-monitoring');

  const firm = db.prepare('SELECT * FROM firms ORDER BY id LIMIT 1').get();
  const suffix = crypto.randomBytes(4).toString('hex');
  manager = db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,'manager',1) RETURNING *`).get(
      `monitoring-ui-manager-${suffix}@example.test`, '!test', 'Monitoring UI manager', firm.id
    );
  clientUser = db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,active)
    VALUES (?,?,?,'client',?,1) RETURNING *`).get(
      `monitoring-ui-client-${suffix}@example.test`, '!test', 'Client user', firm.id
    );
  workspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks,stage)
    VALUES (?,'Monitoring UI client','[]','new')`).run(firm.id).lastInsertRowid);
  otherWorkspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks,stage)
    VALUES (?,'Other monitoring client','[]','new')`).run(firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')`)
    .run(workspaceId, clientUser.id);
  supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,'Mapped provider','Production hosting','active','tier_1')`).run(workspaceId).lastInsertRowid);
  otherSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,'Other client provider','Payroll','active','tier_2')`).run(otherWorkspaceId).lastInsertRowid);
  domain.enableModule(db, {
    workspaceId,
    serviceModel: 'managed_lifecycle',
    actorId: manager.id,
    reason: 'Enable production-grade connector route testing for this client.',
  });
  domain.enableModule(db, {
    workspaceId: otherWorkspaceId,
    serviceModel: 'managed_lifecycle',
    actorId: manager.id,
    reason: 'Enable a separate tenant for isolation testing.',
  });
  relationshipId = relationships.createRelationship(db, {
    workspaceId,
    supplierId,
    actorId: manager.id,
    relationshipName: 'Production hosting service',
    serviceCategory: 'Cloud hosting',
    serviceDescription: 'The exact production hosting service covered by monitoring and reassessment.',
    provisionModel: 'saas',
    status: 'active',
    criticality: 'critical',
    dataAccess: 'restricted',
    privilegedAccess: true,
    isPrimary: true,
    legalName: 'Mapped provider',
    reason: 'Define the monitored service relationship before activating continuous monitoring.',
  }).relationship.id;
  secret = 'monitoring-ui-hmac-secret-material-32-bytes';
  connector = monitoring.createConnector(db, {
    workspaceId,
    actorId: manager.id,
    providerType: 'generic_webhook',
    capabilityMode: 'webhook',
    name: 'Signed production feed',
    status: 'active',
    secretReference: 'env://NIMBUS_TPRM_TEST_FEED',
    adapterConfig: { acceptedSchema: 'nimbus.monitoring.v1' },
  });
  monitoring.createSupplierMapping(db, {
    workspaceId,
    connectorId: connector.id,
    actorId: manager.id,
    supplierId,
    providerEntityId: 'mapped-entity-1',
    mappingNote: 'Verified test mapping.',
  });
  monitoring.createRule(db, {
    workspaceId,
    connectorId: connector.id,
    actorId: manager.id,
    ruleKey: 'score-critical',
    metricPath: 'metrics.score',
    operator: 'lte',
    threshold: 60,
    signalType: 'control_change',
    severity: 'critical',
    requiresReassessment: true,
    missingBehavior: 'quarantine',
    title: 'External score requires reassessment',
  });

  app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.rbac = rbac;
  app.locals.assetVersion = 'test';
  routes.registerPublic(app, { db, secretResolver: reference => {
    assert.equal(reference, 'env://NIMBUS_TPRM_TEST_FEED');
    return secret;
  } });
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    const requestedUser = Number(req.get('x-test-user') || manager.id);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(requestedUser) || null;
    res.locals.csrfToken = 'test-csrf';
    res.locals.allFirms = [];
    res.locals.lastWs = null;
    res.locals.openReviewCount = 0;
    res.locals.unreadNotifications = 0;
    return next();
  });
  const memoryCsv = { single: field => multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single(field) };
  routes.register(app, {
    db,
    requireAuth,
    requireWorkspace,
    requirePermission,
    csvUpload: memoryCsv,
    secretResolver: () => secret,
    logAction: () => {},
  });
  app.use((error, _req, res, _next) => res.status(500).send(`Unexpected error: ${error.message}`));
  client = makeClient(app);
});

test.after(async () => {
  if (client) await client.close();
  if (db) db.close();
  try { if (appDb) appDb.close(); } catch (_) {}
  if (env && env.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test('connector cockpit renders honest state and masks the secret-store reference', async () => {
  const response = await client.get(`/workspaces/${workspaceId}/tprm/monitoring/connectors`);
  assert.equal(response.status, 200);
  assert.match(response.text, /Connectors &amp; signal triage/);
  assert.match(response.text, /Adapter contract only/);
  assert.match(response.text, /Not connected/);
  assert.match(response.text, /env:\/\/…[a-f0-9]{8}/);
  assert.doesNotMatch(response.text, /env:\/\/NIMBUS_TPRM_TEST_FEED/);
  assert.doesNotMatch(response.text, new RegExp(secret));
  assert.match(response.text, new RegExp(`/integrations/tprm/monitoring/${connector.ingress_key}`));
});

test('public webhook verifies exact raw JSON bytes, stays tenant-scoped and returns generic errors', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const event = {
      event_id: 'ui-webhook-event-1',
      provider_entity_id: 'mapped-entity-1',
      observed_at: new Date(timestamp * 1000).toISOString(),
      signal_type: 'control_change',
      severity: 'low',
      title: 'Provider score fell below threshold',
      metrics: { score: 42 },
    };
    const rawBody = ` {\n  "event_id": ${JSON.stringify(event.event_id)},\n  "provider_entity_id": ${JSON.stringify(event.provider_entity_id)},\n  "observed_at": ${JSON.stringify(event.observed_at)},\n  "signal_type": "control_change",\n  "severity": "low",\n  "title": "Provider score fell below threshold",\n  "metrics": { "score": 42 }\n}`;
    const monitoring = require('../lib/tprm-monitoring-connectors');
    const signature = monitoring.signWebhook({ secret, timestamp, rawBody });
    const accepted = await rawRequest(server, 'POST', `/integrations/tprm/monitoring/${connector.ingress_key}`, rawBody, {
      'content-type': 'application/json',
      'x-nimbus-timestamp': String(timestamp),
      'x-nimbus-signature': signature,
      'content-length': Buffer.byteLength(rawBody),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(JSON.parse(accepted.text), { accepted: true, disposition: 'processed' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_signals WHERE workspace_id=?').get(workspaceId).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_signals WHERE workspace_id=?').get(otherWorkspaceId).count, 0);
    const queue = db.prepare('SELECT * FROM tprm_reassessment_queue WHERE workspace_id=?').get(workspaceId);
    assert.equal(queue.status, 'pending');

    const cockpit = await client.get(`/workspaces/${workspaceId}/tprm/monitoring/connectors?connector=${connector.id}`);
    assert.equal(cockpit.status, 200);
    assert.match(cockpit.text, /Connected and verified by a successful run/);
    assert.match(cockpit.text, /External score requires reassessment/);
    assert.match(cockpit.text, /Triage signal/);
    const signal = db.prepare('SELECT * FROM tprm_monitoring_signals WHERE workspace_id=?').get(workspaceId);
    const triaged = await client.post(`/workspaces/${workspaceId}/tprm/monitoring/signals/${signal.id}/triage`, {
      connector_id: String(connector.id),
      status: 'escalated',
      note: 'Escalated to the client security owner for immediate action.',
      idempotency_key: 'a'.repeat(48),
    });
    assert.equal(triaged.status, 303);
    const recordedSignal = db.prepare('SELECT * FROM tprm_monitoring_signals WHERE id=?').get(signal.id);
    assert.equal(recordedSignal.status, 'escalated');
    assert.equal(recordedSignal.triaged_by, manager.id);
    assert.match(recordedSignal.triage_note, /client security owner/);

    const invalid = await rawRequest(server, 'POST', `/integrations/tprm/monitoring/${connector.ingress_key}`, rawBody, {
      'content-type': 'application/json',
      'x-nimbus-timestamp': String(timestamp),
      'x-nimbus-signature': '0'.repeat(64),
      'content-length': Buffer.byteLength(rawBody),
    });
    assert.equal(invalid.status, 401);
    assert.deepEqual(JSON.parse(invalid.text), { accepted: false, message: 'Webhook authentication failed.' });
    assert.doesNotMatch(invalid.text, /TPRM_|NIMBUS_TPRM_TEST_FEED|Signed production feed/);

    const malformedBody = '{"event_id":';
    const malformed = await rawRequest(server, 'POST', `/integrations/tprm/monitoring/${connector.ingress_key}`, malformedBody, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(malformedBody),
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(JSON.parse(malformed.text), { accepted: false, message: 'Webhook delivery is not valid.' });
    assert.doesNotMatch(malformed.text, /SyntaxError|Unexpected end|TPRM_/);

    const wrongType = await rawRequest(server, 'POST', `/integrations/tprm/monitoring/${connector.ingress_key}`, rawBody, {
      'content-type': 'text/plain',
      'x-nimbus-timestamp': String(timestamp),
      'x-nimbus-signature': signature,
      'content-length': Buffer.byteLength(rawBody),
    });
    assert.equal(wrongType.status, 400);
    assert.deepEqual(JSON.parse(wrongType.text), { accepted: false, message: 'Webhook delivery is not valid.' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('public webhook rejects oversized bodies before parsing and rate-limits bursts with bounded state', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    const eventsBefore = db.prepare(`SELECT COUNT(*) AS count FROM tprm_monitoring_received_events
      WHERE workspace_id=? AND connector_id=?`).get(workspaceId, connector.id).count;
    const oversizedBody = Buffer.alloc(1024 * 1024 + 1, 0x7b);
    const oversized = await rawRequest(server, 'POST', `/integrations/tprm/monitoring/${connector.ingress_key}`, oversizedBody, {
      'content-type': 'application/json',
      'content-length': oversizedBody.length,
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(JSON.parse(oversized.text), { accepted: false, message: 'Webhook delivery is too large.' });
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_monitoring_received_events
      WHERE workspace_id=? AND connector_id=?`).get(workspaceId, connector.id).count, eventsBefore,
    'oversized input is rejected before event persistence');

    const timestamp = Math.floor(Date.now() / 1000);
    const badBody = JSON.stringify({ event_id: 'rate-limit-probe', provider_entity_id: 'mapped-entity-1' });
    let limited = null;
    for (let index = 0; index < 35; index += 1) {
      const response = await rawRequest(server, 'POST', `/integrations/tprm/monitoring/${connector.ingress_key}`, badBody, {
        'content-type': 'application/json',
        'x-nimbus-timestamp': String(timestamp),
        'x-nimbus-signature': '0'.repeat(64),
        'content-length': Buffer.byteLength(badBody),
      });
      if (response.status === 429) { limited = response; break; }
    }
    assert.ok(limited, 'a single-source burst must be rate limited');
    assert.equal(JSON.parse(limited.text).message, 'Webhook delivery is temporarily rate limited.');
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_monitoring_connector_runs
      WHERE workspace_id=? AND connector_id=? AND status='rejected'`).get(workspaceId, connector.id).count, 0,
    'invalid public traffic is aggregated instead of creating immutable run rows');
    const buckets = db.prepare(`SELECT * FROM tprm_webhook_ingress_buckets
      WHERE workspace_id=? AND connector_id=?`).all(workspaceId, connector.id);
    assert.ok(buckets.length >= 1 && buckets.length <= 3);
    assert.ok(buckets.some(row => row.rejected_count > 0));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('public webhook rejects unknown locators and IP bursts before the raw body parser', async () => {
  const routes = require('../routes/tprm-monitoring');
  routes.resetPublicPrebodyLimiterForTests();
  const server = app.listen(0, '127.0.0.1');
  try {
    const oversizedBody = Buffer.alloc(1024 * 1024 + 1, 0x7b);
    const invalidShape = await rawRequest(server, 'POST', '/integrations/tprm/monitoring/not-a-valid-key', oversizedBody, {
      'content-type': 'application/json',
      'content-length': oversizedBody.length,
    });
    assert.equal(invalidShape.status, 404,
      'invalid locator shape must be rejected before the 1 MiB parser can return 413');

    routes.resetPublicPrebodyLimiterForTests();
    let last = null;
    for (let index = 0; index <= 60; index += 1) {
      const unknownKey = index.toString(16).padStart(32, '0');
      last = await rawRequest(server, 'POST', `/integrations/tprm/monitoring/${unknownKey}`, null);
      if (index < 60) assert.equal(last.status, 404);
    }
    assert.equal(last.status, 429);
    assert.equal(JSON.parse(last.text).message, 'Webhook delivery is temporarily rate limited.');
    assert.equal(last.headers['retry-after'], '60');
  } finally {
    routes.resetPublicPrebodyLimiterForTests();
    await new Promise(resolve => server.close(resolve));
  }
});

test('firm-only configuration rejects credential fields, cross-client mappings and unprovisioned paid activation', async () => {
  const root = `/workspaces/${workspaceId}/tprm/monitoring/connectors`;
  const before = db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_connectors WHERE workspace_id=?').get(workspaceId).count;
  const unsafe = await client.post(root, {
    name: 'Unsafe raw key',
    provider_type: 'generic_webhook',
    secret_reference: 'env://NIMBUS_TPRM_SAFE_REFERENCE',
    api_key: 'must-never-be-accepted',
  });
  assert.equal(unsafe.status, 303);
  assert.match(unsafe.location, /Credential%20material%20cannot%20be%20submitted/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_monitoring_connectors WHERE workspace_id=?').get(workspaceId).count, before);

  const created = await client.post(root, {
    name: 'SecurityScorecard contract',
    provider_type: 'securityscorecard',
    capability_mode: 'webhook',
    secret_reference: 'env://NIMBUS_TPRM_PAID_ADAPTER',
  });
  assert.equal(created.status, 303);
  const paid = db.prepare(`SELECT * FROM tprm_monitoring_connectors
    WHERE workspace_id=? AND name='SecurityScorecard contract'`).get(workspaceId);
  assert.equal(paid.status, 'draft');
  const activation = await client.post(`${root}/${paid.id}/status`, {
    status: 'active',
    reason: 'Attempt activation without a real provider transport.',
    external_provisioning_confirmed: '1',
  });
  assert.equal(activation.status, 303);
  assert.match(activation.location, /no%20verified%20provider%20transport/i);
  assert.equal(db.prepare('SELECT status FROM tprm_monitoring_connectors WHERE id=?').get(paid.id).status, 'draft');

  const mapping = await client.post(`${root}/${connector.id}/mappings`, {
    supplier_id: String(otherSupplierId),
    provider_entity_id: 'cross-client-attempt',
    mapping_note: 'This must be rejected.',
  });
  assert.equal(mapping.status, 303);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_connector_supplier_mappings
    WHERE workspace_id=? AND provider_entity_id='cross-client-attempt'`).get(workspaceId).count, 0);

  const clientMutation = await client.post(root, {
    name: 'Client-created connector',
    provider_type: 'csv_import',
  }, { headers: { 'x-test-user': String(clientUser.id) } });
  assert.equal(clientMutation.status, 403);
});

test('CSV import shows per-row outcomes and controlled queue processing starts a governed reassessment', async () => {
  const root = `/workspaces/${workspaceId}/tprm/monitoring/connectors`;
  const created = await client.post(root, {
    name: 'Governed weekly CSV',
    provider_type: 'csv_import',
    start_active: '1',
  });
  assert.equal(created.status, 303);
  const csvConnector = db.prepare(`SELECT * FROM tprm_monitoring_connectors
    WHERE workspace_id=? AND name='Governed weekly CSV'`).get(workspaceId);
  assert.equal(csvConnector.status, 'active');
  const mapping = await client.post(`${root}/${csvConnector.id}/mappings`, {
    supplier_id: String(supplierId),
    provider_entity_id: 'csv-mapped-entity',
    mapping_note: 'Matched to the governed provider account.',
  });
  assert.equal(mapping.status, 303);

  const observedAt = new Date().toISOString();
  const csv = [
    'event_id,provider_entity_id,observed_at,signal_type,severity,title,score',
    `csv-event-1,csv-mapped-entity,${observedAt},availability,high,Availability score changed,72`,
    `,csv-mapped-entity,${observedAt},availability,high,Missing event identifier,70`,
  ].join('\n');
  const imported = await client.post(`${root}/${csvConnector.id}/import`, { csv_text: csv });
  assert.equal(imported.status, 200);
  assert.match(imported.text, /2 received, 1 processed, 0 duplicate and 1 quarantined or rejected/);
  assert.match(imported.text, /CSV row/);
  assert.match(imported.text, /csv-event-1/);
  assert.match(imported.text, /Not accepted/);

  let queue = db.prepare(`SELECT * FROM tprm_reassessment_queue
    WHERE workspace_id=? AND status='pending' ORDER BY id LIMIT 1`).get(workspaceId);
  if (!queue) {
    const monitoring = require('../lib/tprm-monitoring-connectors');
    const timestamp = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      event_id: `queue-test-${crypto.randomBytes(4).toString('hex')}`,
      provider_entity_id: 'mapped-entity-1',
      observed_at: new Date(timestamp * 1000).toISOString(),
      signal_type: 'control_change',
      severity: 'low',
      title: 'Queue test score crossed the critical threshold',
      metrics: { score: 41 },
    });
    monitoring.ingestWebhook(db, {
      workspaceId,
      connectorId: connector.id,
      rawBody,
      timestamp,
      signature: monitoring.signWebhook({ secret, timestamp, rawBody }),
      now: new Date(timestamp * 1000),
      secretResolver: () => secret,
    });
    queue = db.prepare(`SELECT * FROM tprm_reassessment_queue
      WHERE workspace_id=? AND status='pending' ORDER BY id LIMIT 1`).get(workspaceId);
  }
  assert.ok(queue, 'the signed critical-score event must remain in the controlled queue');
  const processed = await client.post(`/workspaces/${workspaceId}/tprm/monitoring/reassessment/${queue.id}/process`, {});
  assert.equal(processed.status, 303);
  const completed = db.prepare('SELECT * FROM tprm_reassessment_queue WHERE id=?').get(queue.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.ok(completed.resulting_cycle_id);
  assert.ok(db.prepare(`SELECT 1 FROM tprm_assessment_cycles
    WHERE workspace_id=? AND supplier_id=? AND id=? AND cycle_type='triggered'`).get(
      workspaceId, supplierId, completed.resulting_cycle_id
  ));
  assert.ok(db.prepare(`SELECT 1 FROM tprm_cycle_relationship_scopes
    WHERE workspace_id=? AND cycle_id=? AND relationship_id=?`).get(
    workspaceId, completed.resulting_cycle_id, relationshipId
  ), 'the triggered reassessment must freeze the affected service relationship');
});

test('route registration and views retain the raw-body and honest-status security contracts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tprm-monitoring.js'), 'utf8');
  assert.match(source, /express\.raw/);
  assert.match(source, /PUBLIC_WEBHOOK_PATH = '\/integrations\/tprm\/monitoring\/:ingressKey'/);
  assert.match(source, /consumeWebhookIngressBudget/);
  assert.match(source, /requirePermission\('tprm\.monitoring\.manage'\)/);
  assert.match(source, /requireFirm/);
  assert.match(source, /adapter\.integrationState === 'implemented'/);
  const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'tprm_connector_settings.ejs'), 'utf8');
  assert.match(view, /never presented as connected until/i);
  assert.match(view, /never decides whether to onboard/i);
  assert.match(view, /client decision remains untouched/i);
  assert.doesNotMatch(view, /name="(?:api_key|secret|password|access_token)"/i);
});
