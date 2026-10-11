'use strict';
// A client that runs ISO 42001 without ISO 27001 never lands on ISO 27001's
// control register, SoA, gap assessment or readiness pages: they open the
// module's own page (server.js requireWorkspace), and the search palette
// offers the module's pages instead (routes/workspace-ops-b.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, aimsId, bothId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  const actor = db.prepare("SELECT firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name, frameworks) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`)
    .run(actor.firm_id, name, frameworks).lastInsertRowid);
  aimsId = add('Kestrel Lending', '["iso42001"]');
  bothId = add('Harbour Analytics', '["iso27001","iso42001"]');
});
test.after(async () => { db?.close(); await client?.close(); });

test('ISO 27001 pages open the module\'s own page for an ISO 42001-only client', async () => {
  for (const [from, to] of [['/controls', '/iso42001/controls'], ['/controls/annex-5-1', '/iso42001/controls'], ['/controls/kanban', '/iso42001/controls'],
    ['/soa', '/iso42001/soa'], ['/soa/snapshots', '/iso42001/soa'], ['/gap-assessment', '/iso42001/gap-assessment'],
    ['/gap-assessment/fieldwork', '/iso42001/gap-assessment'], ['/readiness', '/iso42001/readiness']]) {
    const res = await client.get(`/workspaces/${aimsId}${from}`);
    assert.equal(res.status, 302, from);
    assert.equal(res.location, `/workspaces/${aimsId}${to}`, from);
  }
  const write = await client.post(`/workspaces/${aimsId}/controls/annex-5-1/autosave`, { status: 'Implemented' });
  assert.equal(write.status, 404, 'ISO 27001 control state cannot be written for it');
  assert.equal((await client.get(`/workspaces/${aimsId}/iso42001/controls`)).status, 200);

  const both = await client.get(`/workspaces/${bothId}/controls`);
  assert.equal(both.status, 200, 'a client with ISO 27001 keeps its control register');
});

test('the search palette offers the module\'s pages, not ISO 27001\'s', async () => {
  const hrefs = async (id, q) => JSON.parse((await client.get(`/api/search?wsId=${id}&q=${encodeURIComponent(q)}`)).text)
    .filter((r) => r.type === 'Page').map((r) => [r.label, r.href.replace(`/workspaces/${id}`, '')]);
  assert.deepEqual(await hrefs(aimsId, 'controls'), [['Requirements', '/iso42001/controls']]);
  assert.ok((await hrefs(aimsId, 'statement')).some(([, h]) => h === '/iso42001/soa'));
  assert.ok(!(await hrefs(aimsId, 'statement')).some(([, h]) => h === '/soa'));
  assert.ok((await hrefs(aimsId, 'risk')).some(([, h]) => h === '/iso42001/risks'));
  assert.ok(!(await hrefs(aimsId, 'risk')).some(([, h]) => h === '/risks' || h === '/risk-methodology'));
  assert.ok((await hrefs(aimsId, 'evidence')).some(([, h]) => h === '/evidence'), 'shared pages stay');
  assert.ok((await hrefs(bothId, 'controls')).some(([, h]) => h === '/controls'), 'a client with ISO 27001 keeps them');
});
