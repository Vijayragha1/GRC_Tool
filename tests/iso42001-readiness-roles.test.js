'use strict';
// The readiness check expects an Annex A record only where the control
// applies: as decided in the Statement of Applicability, or, while the
// control is undecided, as the organisation's AI roles propose
// (lib/aims-soa-proposals.js). An organisation that only uses bought AI is
// not counted as missing model documentation it will never hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, bareId;
const base = (id = wsId) => `/workspaces/${id}/iso42001`;
const readiness = (id = wsId) => require('../routes/iso42001').shared.computeIso42001Readiness(id);
const byClause = (list) => Object.fromEntries(list.map((c) => [c.clause, c]));

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, '["iso42001"]', 'certification_support')`)
    .run(actor.firm_id, name).lastInsertRowid);
  wsId = add('Kestrel Lending');
  bareId = add('Wren Insurance');
  for (const id of [wsId, bareId]) {
    db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Writing assistant', 'in_use', 1, ?)`).run(id, actor.id);
  }
  const system = db.prepare('SELECT id, version FROM ai_systems WHERE workspace_id=?').get(wsId);
  await client.post(`${base()}/roles/${system.id}`, { version: system.version,
    role_builds: 'no', role_trains: 'no', role_sourced: 'yes', role_uses: 'yes', role_offers: 'no', role_partners: 'no' });
});
test.after(async () => { db?.close(); await client?.close(); });

test('without roles every expected record counts, as before', () => {
  const r = readiness(bareId);
  assert.equal(r.roles.ready, false);
  assert.equal(r.records.expected.total, 11);
  assert.deepEqual(r.records.expected.notExpected, []);
});

test('an organisation that only uses bought AI is not expected to hold development records', () => {
  const r = readiness();
  const expected = byClause(r.records.expected.checks);
  const dropped = byClause(r.records.expected.notExpected);
  for (const ref of ['A.6.2.3', 'A.6.2.7', 'A.7.6']) {
    assert.ok(dropped[ref], `${ref} is not expected`);
    assert.equal(dropped[ref].proposed, true);
    assert.match(dropped[ref].why, new RegExp(`The organisation's AI roles propose excluding ${ref.replace(/\./g, '\\.')}`));
  }
  assert.ok(expected['A.4.2'] && expected['A.5.3'], 'the inventory and impact assessments are expected of everyone');
  assert.match(expected['A.7.4'].note, /Expected unless A\.7\.4 is excluded/, 'a control the roles leave open stays expected');
  assert.equal(r.records.expected.total, 11 - r.records.expected.notExpected.length);
  assert.equal(r.records.total, r.records.mandatory.total + r.records.expected.total);
});

test('the Statement of Applicability decides over the roles', async () => {
  await client.post(`${base()}/soa/ai-annex-a-7-4`, { applicability: 'excluded', justification: 'Staff do not feed the assistant any data set of ours' });
  await client.post(`${base()}/soa/ai-annex-a-6-2-3`, { applicability: 'included', justification: 'We document how the assistant is configured' });
  const r = readiness();
  const dropped = byClause(r.records.expected.notExpected);
  assert.match(dropped['A.7.4'].why, /A\.7\.4 is excluded in the Statement of Applicability/);
  assert.equal(dropped['A.7.4'].proposed, undefined);
  assert.ok(byClause(r.records.expected.checks)['A.6.2.3'], 'an included control brings its record back');
});

test('the readiness page and the stage pages say which records are not expected and why', async () => {
  const page = await client.get(`${base()}/readiness`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Read against the organisation(&#39;|')s AI roles \(Customer of 1 AI system\)/);
  assert.match(page.text, /Not expected for this organisation \(\d+\)/);
  assert.match(page.text, new RegExp(`href="${base()}/soa#soa-ai-annex-a-7-6">Open the row`));
  const bare = await client.get(`${base(bareId)}/readiness`);
  assert.match(bare.text, /Record the AI roles<\/a> so records the organisation will never hold drop out/);
  assert.doesNotMatch(bare.text, /Not expected for this organisation/);

  await client.post(`${base()}/soa/ai-annex-a-4-3`, { applicability: 'excluded', justification: 'No data of ours goes into the assistant' });
  const assess = await client.get(`${base()}/stages/assess`);
  const at = assess.text.indexOf('>Record the data behind each AI system</a>');
  assert.ok(at > 0, 'the data step is shown');
  assert.match(assess.text.slice(at, assess.text.indexOf('</li>', at)), /Not needed<\/span> · A\.4\.3 is excluded in the Statement of Applicability/);
});
