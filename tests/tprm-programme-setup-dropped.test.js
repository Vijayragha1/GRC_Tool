'use strict';
// Programme setup is no longer a TPRM service a client can be given: it
// included no assessments, so the module offered nothing to do. New clients
// and new service periods choose Assessment only or Managed lifecycle. A
// period already contracted as Programme setup keeps its record, and points
// to Settings to change the service instead of offering an assessment it
// refuses.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
});
test.after(async () => { db?.close(); await client?.close(); });

test('Programme setup is not offered to a new client or a new service period', async () => {
  for (const page of ['/workspaces/new', '/dashboard?legacy=1']) {
    const res = await client.get(page);
    assert.equal(res.status, 200, page);
    assert.doesNotMatch(res.text, /value="programme_setup"|Programme setup/, page);
  }
  const refused = await client.post('/workspaces', { client_name: 'Setup Only Client', frameworks: ['iso27001'],
    engagement_outcome: 'certification_support', tprm_enabled: '1', tprm_service_model: 'programme_setup' });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /Choose how the Third-party risk service will be delivered/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE client_name='Setup Only Client'").get().c, 0);

  const created = await client.post('/workspaces', { client_name: 'Assessed Client', frameworks: ['iso27001'],
    engagement_outcome: 'certification_support', tprm_enabled: '1', tprm_service_model: 'assessment_only' });
  assert.equal(created.status, 302, created.text.slice(0, 200));

  const wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, stage, frameworks, lead_consultant_id) VALUES (?, 'No TPRM Yet', 'active', '[]', ?)`)
    .run(actor.firm_id, actor.id).lastInsertRowid);
  const enable = await client.post(`/workspaces/${wsId}/modules/tprm`, { service_model: 'programme_setup', reason: 'Trying the service that is no longer offered.' });
  assert.equal(enable.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tprm_modules WHERE workspace_id=?').get(wsId).c, 0);
});

test('a client already on Programme setup is pointed to Settings, not to an assessment it cannot start', async () => {
  const wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, stage, frameworks, lead_consultant_id) VALUES (?, 'Legacy Setup Client', 'active', '[]', ?)`)
    .run(actor.firm_id, actor.id).lastInsertRowid);
  require('../lib/tprm-domain').enableModule(db, { workspaceId: wsId, serviceModel: 'programme_setup', actorId: actor.id,
    reason: 'Contracted as Programme setup before it was withdrawn.' });

  const page = await client.get(`/workspaces/${wsId}/tprm/third-parties/new`);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const saved = await client.post(`/workspaces/${wsId}/vendors`, { _csrf: csrf, name: 'Payroll Provider', service_provided: 'Monthly payroll',
    business_owner: 'Head of HR', relationship_owner: 'Consultancy TPRM Lead' });
  assert.equal(saved.status, 303, 'the register still works on Programme setup');
  const supplierId = Number(saved.location.match(/third-parties\/(\d+)/)[1]);

  const overview = await client.get(`/workspaces/${wsId}/tprm`);
  assert.match(overview.text, /Change the service to Assessment only to assess this third party/);
  assert.doesNotMatch(overview.text, /Start onboarding assessment/);
  assert.match(overview.text, new RegExp(`href="/workspaces/${wsId}/tprm/settings"[^>]*>\\s*Open action`));

  const detail = await client.get(`/workspaces/${wsId}/tprm/third-parties/${supplierId}`);
  assert.match(detail.text, /Cycle not started\.<\/strong> Bounded onboarding assessment is not included in the Programme setup service model\./);
  assert.doesNotMatch(detail.text, /Your role cannot start a cycle/);
  assert.match(detail.text, new RegExp(`href="/workspaces/${wsId}/tprm/settings">Open TPRM settings</a>`));
});
