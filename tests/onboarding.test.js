'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const { getOnboardingProgress } = require('../routes/tenants');

function workspaceId(location) {
  const match = String(location || '').match(/workspaces\/(\d+)/);
  assert.ok(match, `expected a workspace redirect, got ${location}`);
  return Number(match[1]);
}

test('fresh-firm onboarding is framework-neutral and contains one working required step', async (t) => {
  const { client, dbPath } = await bootClient();
  t.after(() => client.close());

  const conn = new Database(dbPath);
  const firm = conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const foreignFirm = conn.prepare('INSERT INTO firms (name) VALUES (?)').run('FOREIGN-ONBOARDING-CANARY').lastInsertRowid;
  conn.prepare('INSERT INTO workspaces (firm_id,client_name,frameworks) VALUES (?,?,?)')
    .run(foreignFirm, 'FOREIGN-CLIENT-CANARY', JSON.stringify(['iso27001']));

  const progress = getOnboardingProgress(conn, firm.id);
  assert.equal(progress.done, 0);
  assert.equal(progress.total, 1);
  assert.equal(progress.pct, 0);
  assert.equal(progress.nextStep.title, 'Create your first client');
  conn.close();

  const page = await client.get('/onboarding');
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.match(page.text, /Set up your firm/);
  assert.match(page.text, /0\s*<\/strong>\s*\/\s*1 required/);
  assert.match(page.text, /href="\/workspaces\/new"[^>]*>Create first client</);
  assert.equal((page.text.match(/href="\/workspaces\/new"/g) || []).length, 1,
    'zero-client onboarding exposes one authoritative create-client action');
  assert.match(page.text, /No client has been created yet/);
  assert.doesNotMatch(page.text, /Define ISMS scope|ISO 27001|Annex A|118 items|certification cycle/i);
  assert.doesNotMatch(page.text, /FOREIGN-(?:ONBOARDING|CLIENT)-CANARY/,
    'another firm must never satisfy or appear in this firm onboarding');
  const afterGet = new Database(dbPath);
  assert.equal(afterGet.prepare('SELECT 1 FROM tenant_onboarding WHERE firm_id=?').get(firm.id), undefined,
    'reading onboarding must not create lifecycle state');
  afterGet.close();

  const createPage = await client.get('/workspaces/new');
  assert.equal(createPage.status, 200);
  assert.match(createPage.text, /Initial engagement scope/);
  assert.doesNotMatch(createPage.text, /ISMS scope statement/);
});

test('client summaries are rebuilt from only the programmes actually selected', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const created = await client.post('/workspaces', {
    client_name: 'AI and Privacy Client',
    industry: 'Technology',
    frameworks: ['iso42001', 'dpdpa'],
  });
  assert.equal(created.status, 302);
  const id = workspaceId(created.location);

  const page = await client.get('/onboarding');
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.match(page.text, /AI and Privacy Client/);
  assert.match(page.text, /ISO 42001/);
  assert.match(page.text, /DPDPA/);
  assert.match(page.text, /AI management-system intake/);
  assert.match(page.text, /Assessment boundary and applicability/);
  assert.match(page.text, new RegExp(`href="/workspaces/${id}/setup"`));
  assert.doesNotMatch(page.text, /ISO 27001|Engagement intake and scope sign-off|certification cycle/i);
});

test('programme-neutral clients receive a working assignment path instead of an ISO intake', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const created = await client.post('/workspaces', {
    client_name: 'Planning Only Client',
    industry: 'Professional services',
  });
  assert.equal(created.status, 302);
  const id = workspaceId(created.location);

  const page = await client.get('/onboarding');
  assert.match(page.text, /No services assigned/);
  assert.match(page.text, new RegExp(`href="/workspaces/${id}#programme-enable-form"[^>]*>Assign services</`));

  const clientPage = await client.get(`/workspaces/${id}`);
  assert.equal(clientPage.status, 200);
  assert.match(clientPage.text, /href="#programme-enable-form"[^>]*>Choose services</);
  assert.doesNotMatch(clientPage.text, /href="\/workspaces\/[^"]+\/intake"[^>]*>Client setup</);
});

test('consultants see setup guidance only for clients assigned to them', async (t) => {
  const { client, dbPath, login } = await bootClient();
  t.after(() => client.close());

  const assigned = await client.post('/workspaces', {
    client_name: 'ASSIGNED-ONBOARDING-CLIENT',
    frameworks: ['iso42001'],
  });
  const assignedId = workspaceId(assigned.location);
  const hidden = await client.post('/workspaces', {
    client_name: 'UNASSIGNED-ONBOARDING-CANARY',
    frameworks: ['dpdpa'],
  });
  assert.equal(hidden.status, 302);

  const conn = new Database(dbPath);
  const user = conn.prepare('SELECT id FROM users WHERE email=?').get(login.email);
  conn.prepare("UPDATE users SET firm_role='consultant' WHERE id=?").run(user.id);
  conn.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role)
    VALUES (?,?,'consultant')`).run(assignedId, user.id);
  conn.close();

  const page = await client.get('/onboarding');
  assert.equal(page.status, 200);
  assert.match(page.text, /ASSIGNED-ONBOARDING-CLIENT/);
  assert.match(page.text, /AI management-system intake/);
  assert.doesNotMatch(page.text, /UNASSIGNED-ONBOARDING-CANARY|Assessment boundary and applicability/);
  assert.doesNotMatch(page.text, /href="\/admin\/(?:users|email)"/);
});

test('onboarding state changes are manager-only and skip is not completion', async (t) => {
  const { client, dbPath, login } = await bootClient();
  t.after(() => client.close());

  const conn = new Database(dbPath);
  const firm = conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const foreignFirm = conn.prepare('INSERT INTO firms (name) VALUES (?)').run('Foreign Completion Firm').lastInsertRowid;
  conn.prepare('INSERT INTO workspaces (firm_id,client_name,frameworks) VALUES (?,?,?)')
    .run(foreignFirm, 'Foreign Completion Client', '[]');

  const premature = await client.post('/onboarding/complete', {});
  assert.equal(premature.status, 302);
  assert.match(premature.location, /^\/onboarding\?/);
  let state = conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id) || {
    skipped: 0,
    completed_at: null,
  };
  assert.equal(state.completed_at, null, 'a foreign-firm client cannot complete this firm onboarding');

  const skipped = await client.post('/onboarding/skip', {});
  assert.equal(skipped.status, 302);
  state = conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.skipped, 1);
  assert.equal(state.completed_at, null, 'dismissing the guide is not completion');

  const created = await client.post('/workspaces', { client_name: 'Completion Client' });
  assert.equal(created.status, 302);
  const createdId = workspaceId(created.location);
  const completed = await client.post('/onboarding/complete', {});
  assert.equal(completed.status, 302);
  state = conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.skipped, 0);
  assert.ok(state.completed_at);

  const completedAt = state.completed_at;
  assert.equal((await client.post('/onboarding/complete', {})).status, 302);
  assert.equal(conn.prepare('SELECT completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id).completed_at,
    completedAt, 'repeated completion is idempotent');
  assert.equal((await client.post('/onboarding/skip', {})).status, 302);
  state = conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.skipped, 0, 'a stale dismiss action cannot replace a completed state');
  assert.equal(state.completed_at, completedAt);

  const deleted = await client.post(`/workspaces/${createdId}/delete`, { confirm_name: 'Completion Client' });
  assert.equal(deleted.status, 302);
  state = conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(state.completed_at, null, 'removing the final client invalidates live first-client completion');
  assert.equal(getOnboardingProgress(conn, firm.id).done, 0);
  const dashboard = await client.get('/dashboard');
  assert.match(dashboard.text, /Next:\s*Create your first client/);

  conn.prepare("UPDATE users SET firm_role='consultant' WHERE email=?").run(login.email);
  const readOnly = await client.get('/onboarding');
  assert.equal(readOnly.status, 200);
  assert.doesNotMatch(readOnly.text, /action="\/onboarding\/(?:skip|complete)"/);
  assert.doesNotMatch(readOnly.text, /href="\/admin\/(?:users|email)"/);
  assert.equal((await client.post('/onboarding/skip', {})).status, 403);
  assert.equal((await client.post('/onboarding/complete', {})).status, 403);

  conn.prepare("UPDATE users SET user_type='client',firm_role='client_owner' WHERE email=?").run(login.email);
  assert.equal((await client.get('/onboarding')).status, 403);
  assert.equal((await client.post('/onboarding/skip', {})).status, 403);
  assert.equal((await client.post('/onboarding/complete', {})).status, 403);

  const unchanged = conn.prepare('SELECT skipped,completed_at FROM tenant_onboarding WHERE firm_id=?').get(firm.id);
  assert.equal(unchanged.skipped, 0);
  assert.equal(unchanged.completed_at, state.completed_at);
  conn.close();
});
