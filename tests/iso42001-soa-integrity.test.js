'use strict';
// ISO/IEC 42001 SoA integrity: a justification is never lost when a control
// moves between included and excluded, and one client cannot remove another
// client's risk-to-control link.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsA, wsB;
const CONTROL = 'ai-annex-a-2-2';

const instance = (wsId, ref) => db.prepare(`SELECT ci.applicability, ci.inclusion_justification, ci.exclusion_justification
  FROM control_instances ci JOIN requirements rq ON rq.id = ci.requirement_id JOIN frameworks f ON f.id = rq.framework_id
  WHERE ci.workspace_id=? AND f.code='iso42001' AND rq.ref=? AND ci.entity_id IS NULL`).get(wsId, ref);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const mk = (name) => Number(db.prepare('INSERT INTO workspaces (firm_id, client_name, frameworks) VALUES (?, ?, ?)')
    .run(actor.firm_id, name, '["iso42001"]').lastInsertRowid);
  wsA = mk('Aurora Diagnostics');
  wsB = mk('Borealis Logistics');
});
test.after(async () => { db?.close(); await client?.close(); });

test('switching a control to excluded files the new reason as an exclusion and keeps the inclusion reason', async () => {
  const url = `/workspaces/${wsA}/iso42001/soa/${CONTROL}?ajax=1`;
  assert.equal((await client.post(url, { applicability: 'included', status: 'Implemented', justification: 'Needed for the triage model.' })).status, 204);
  assert.equal((await client.post(url, { applicability: 'excluded', status: 'Not Applicable', justification: 'No AI systems are built in house.' })).status, 204);
  let row = instance(wsA, CONTROL);
  assert.equal(row.applicability, 'excluded');
  assert.equal(row.exclusion_justification, 'No AI systems are built in house.');
  assert.equal(row.inclusion_justification, 'Needed for the triage model.', 'the other side is left as it was');

  await client.post(url, { applicability: 'included', status: 'Implemented', justification: 'Needed for the triage model and the chatbot.' });
  row = instance(wsA, CONTROL);
  assert.equal(row.inclusion_justification, 'Needed for the triage model and the chatbot.');
  assert.equal(row.exclusion_justification, 'No AI systems are built in house.', 'switching back does not clear the exclusion reason');

  await client.post(url, { applicability: 'included', status: 'Implemented', justification: '' });
  assert.equal(instance(wsA, CONTROL).inclusion_justification, null, 'an emptied box clears only its own side');
});

test('the SoA page gives each row one justification box carrying both saved reasons', async () => {
  const page = await client.get(`/workspaces/${wsA}/iso42001/soa`);
  assert.equal(page.status, 200);
  assert.match(page.text, /name="justification" data-soa-justification data-incl="[^"]*" data-excl="No AI systems are built in house\."/);
  assert.doesNotMatch(page.text, /textarea name="(inclusion|exclusion)_justification"/);
});

test('custom controls keep both reasons in the same way', async () => {
  await client.post(`/workspaces/${wsA}/iso42001/soa/custom-controls`, { code: 'X-1', title: 'Model card review', applicability: 'included', inclusion_justification: 'Customer contract.' });
  const id = db.prepare('SELECT id FROM iso42001_soa_custom_controls WHERE workspace_id=? AND code=?').get(wsA, 'X-1').id;
  await client.post(`/workspaces/${wsA}/iso42001/soa/custom-controls/${id}?ajax=1`, { code: 'X-1', title: 'Model card review', applicability: 'excluded', status: 'Not Applicable', justification: 'Contract ended.' });
  const row = db.prepare('SELECT * FROM iso42001_soa_custom_controls WHERE id=?').get(id);
  assert.equal(row.exclusion_justification, 'Contract ended.');
  assert.equal(row.inclusion_justification, 'Customer contract.');
});

test("a risk link can only be removed by the client the risk belongs to, and the removal is logged", async () => {
  const riskB = Number(db.prepare(`INSERT INTO risks (workspace_id, title, likelihood, impact, status) VALUES (?, 'Model drift in routing', 3, 4, 'open')`)
    .run(wsB).lastInsertRowid);
  assert.equal((await client.post(`/workspaces/${wsB}/iso42001/controls/${CONTROL}/risks`, { risk_id: riskB })).status, 302);
  const linked = () => db.prepare('SELECT COUNT(*) c FROM iso42001_risk_controls WHERE risk_id=? AND iso_item_id=?').get(riskB, CONTROL).c;
  assert.equal(linked(), 1);

  const cross = await client.post(`/workspaces/${wsA}/iso42001/controls/${CONTROL}/risks/${riskB}/delete`, {});
  assert.equal(cross.status, 404, "another client's risk cannot be unlinked through this workspace");
  assert.equal(linked(), 1);

  const own = await client.post(`/workspaces/${wsB}/iso42001/controls/${CONTROL}/risks/${riskB}/delete`, {});
  assert.equal(own.status, 302);
  assert.equal(linked(), 0);
  const logged = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE workspace_id=? AND action='unlink_iso42001_risk'").get(wsB).c;
  assert.equal(logged, 1);
});
