'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient } = require('./helpers');

let env;
let client;
let db;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
});

test.after(async () => {
  if (client) await client.close();
});

test('new-client surfaces expose DPDPA and vCISO choices', async () => {
  const dashboard = await client.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /id="dashboard-dpdpa-programme"[^>]*value="dpdpa"/);
  assert.match(dashboard.text, /id="dashboard-vciso-module"[^>]*name="vciso_enabled"[^>]*value="1"/);

  const fullForm = await client.get('/workspaces/new');
  assert.equal(fullForm.status, 200);
  assert.match(fullForm.text, /id="vciso-module"[^>]*name="vciso_enabled"[^>]*value="1"/);
});

test('vCISO-only onboarding creates one governed advisory engagement and opens it', async () => {
  const name = `vCISO Onboarding ${Date.now()}`;
  const created = await client.post('/workspaces', {
    client_name: name,
    industry: 'Technology',
    vciso_enabled: '1',
  });
  assert.equal(created.status, 302);
  assert.match(created.location, /^\/workspaces\/\d+\/delivery(?:\?|$)/);

  const workspace = db.prepare('SELECT * FROM workspaces WHERE client_name=?').get(name);
  assert.ok(workspace);
  assert.deepEqual(JSON.parse(workspace.frameworks), []);
  const service = db.prepare('SELECT * FROM vciso_services WHERE workspace_id=?').get(workspace.id);
  assert.ok(service);
  assert.equal(service.status, 'active');
  assert.match(service.activation_reason, /governed client onboarding/i);

  const engagement = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(service.engagement_id);
  assert.equal(engagement.workspace_id, workspace.id);
  assert.equal(engagement.engagement_type, 'advisory');
  assert.equal(engagement.status, 'active');
  assert.match(engagement.name, /vCISO advisory$/);
  assert.equal(db.prepare('SELECT billing_model FROM engagement_commercials WHERE engagement_id=?')
    .get(engagement.id).billing_model, 'retainer');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM consulting_engagement_team WHERE engagement_id=? AND role='engagement_lead'")
    .get(engagement.id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM consulting_events WHERE engagement_id=? AND action='vciso_service_activated'")
    .get(engagement.id).count, 1);

  const cockpit = await client.get(`/workspaces/${workspace.id}/delivery`);
  assert.equal(cockpit.status, 200, cockpit.text.slice(0, 500));
  assert.match(cockpit.text, /vCISO advisory/);
  assert.match(cockpit.text, /Advisory cockpit/);
  assert.match(cockpit.text, /Virtual security leadership delivered through governed scope/);

  const workspaceHome = await client.get(`/workspaces/${workspace.id}`);
  assert.equal(workspaceHome.status, 302);
  assert.equal(workspaceHome.location, `/workspaces/${workspace.id}/delivery`);
});

test('vCISO activation is idempotent and tenant-safe', () => {
  const manager = db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  const workspace = db.prepare("SELECT * FROM workspaces WHERE client_name LIKE 'vCISO Onboarding %' ORDER BY id DESC LIMIT 1").get();
  const service = require('../lib/vciso-service');
  const first = service.currentService(db, workspace.id);
  const repeated = service.enableService(db, {
    workspaceId: workspace.id,
    actorId: manager.id,
    reason: 'Repeated activation should return the existing governed service.',
  });
  assert.equal(repeated.id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM vciso_services WHERE workspace_id=?').get(workspace.id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM consulting_engagements WHERE workspace_id=? AND engagement_code LIKE 'VCISO-%'")
    .get(workspace.id).count, 1);

  const otherFirm = Number(db.prepare("INSERT INTO firms(name) VALUES ('Other vCISO Firm')").run().lastInsertRowid);
  const outsider = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('vciso-outsider@example.test','!test','Outsider',?,'firm','manager',1)`)
    .run(otherFirm).lastInsertRowid);
  assert.throws(() => service.enableService(db, {
    workspaceId: workspace.id,
    actorId: outsider,
    reason: 'This cross-tenant activation must be rejected by the domain boundary.',
  }), error => error && error.code === 'VCISO_ACTOR_OUT_OF_SCOPE' && error.status === 403);
});
