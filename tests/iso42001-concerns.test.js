'use strict';
// The Stage 2 records that had nowhere to live: the log of concerns raised
// inside the organisation (A.3.3) and adverse impacts reported from outside
// (A.8.3), and AI suppliers tied to the client's supplier register (A.10.3).

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, otherWsId, systemId, foreignSystem, incidentId;
const base = () => `/workspaces/${wsId}/iso42001`;
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const report = (summary) => db.prepare('SELECT * FROM ai_concern_reports WHERE workspace_id=? AND summary=?').get(wsId, summary);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const ws = (name) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, '["iso42001"]', 'certification_support')`)
    .run(actor.firm_id, name).lastInsertRowid);
  wsId = ws('Kestrel Lending');
  otherWsId = ws('Other AI client');
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Credit scoring model', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
  foreignSystem = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Other model', 'in_use', ?)`).run(otherWsId, actor.id).lastInsertRowid);
  incidentId = Number(db.prepare(`INSERT INTO incidents (workspace_id, title, severity, status) VALUES (?, 'Scoring outage', 'medium', 'open')`).run(wsId).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

test('concerns and outside reports are logged without the reporter\'s identity', async () => {
  const empty = await client.post(`${base()}/concerns`, { channel: 'concern' });
  assert.match(decodeURIComponent(empty.location), /what was raised/);
  const future = await client.post(`${base()}/concerns`, { channel: 'concern', summary: 'x', received_on: '2999-01-01' });
  assert.match(decodeURIComponent(future.location), /in the future/);
  const crossed = await client.post(`${base()}/concerns`, { channel: 'adverse_impact', summary: 'Borrowed system', ai_system_id: foreignSystem });
  assert.match(decodeURIComponent(crossed.location), /not in this client workspace/);
  assert.throws(() => db.prepare(`INSERT INTO ai_concern_reports (workspace_id, channel, received_on, summary, ai_system_id) VALUES (?, 'concern', ?, 'x', ?)`)
    .run(wsId, today, foreignSystem), /crosses workspace boundary/);

  await client.post(`${base()}/concerns`, { channel: 'concern', summary: 'Underwriters are told not to override low scores', reporter_type: 'employee', anonymous: '1',
    ai_system_id: systemId, impact_area: 'accountability', severity: 'high', handler: 'Head of compliance', received_on: daysAgo(20), respond_by: daysAgo(5) });
  await client.post(`${base()}/concerns`, { channel: 'adverse_impact', summary: 'Applicant refused with no reason given', reporter_type: 'affected_person',
    ai_system_id: systemId, impact_area: 'transparency', received_on: daysAgo(3), respond_by: daysAgo(-10) });
  const concern = report('Underwriters are told not to override low scores');
  assert.equal(concern.anonymous, 1);
  assert.equal(concern.reporter_type, 'employee');
  const columns = db.prepare('PRAGMA table_info(ai_concern_reports)').all().map((c) => c.name);
  assert.ok(!columns.some((c) => /name|email|contact/.test(c)), 'no column can hold who reported it');

  const { shared } = require('../routes/iso42001');
  const late = () => shared.computeIso42001Readiness(wsId).flags.find((f) => f.kind === 'concerns_late');
  assert.deepEqual(late().items.map((i) => i.title), ['Underwriters are told not to override low scores']);

  const page = await client.get(`${base()}/concerns`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Employee, anonymous/);
  assert.match(page.text, /<span>Past their response date<\/span><strong>1<\/strong>/);

  const unresolved = await client.post(`${base()}/concerns/${concern.id}`, { channel: 'concern', summary: concern.summary, status: 'resolved', version: concern.version });
  assert.match(decodeURIComponent(unresolved.location), /how it was resolved/);
  const stale = await client.post(`${base()}/concerns/${concern.id}`, { channel: 'concern', summary: concern.summary, version: concern.version + 5 });
  assert.match(decodeURIComponent(stale.location), /changed in another session/);
  await client.post(`${base()}/concerns/${concern.id}`, { channel: 'concern', summary: concern.summary, reporter_type: 'employee', anonymous: '1', ai_system_id: systemId,
    received_on: concern.received_on, status: 'resolved', escalated_on: daysAgo(10), incident_id: incidentId,
    resolution: 'Override guidance reissued; overrides now reviewed monthly', version: concern.version });
  const resolved = report('Underwriters are told not to override low scores');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_on, today, 'resolution date defaults to today');
  assert.equal(resolved.incident_id, incidentId);
  assert.equal(late(), undefined);
  assert.equal(require('../lib/ai-concerns').since(db, { id: wsId }, daysAgo(30), today).reports, 1);
});

test('an AI supplier can be the client\'s supplier register entry', async () => {
  const supplierId = Number(db.prepare(`INSERT INTO suppliers (workspace_id, name, service_provided) VALUES (?, 'Northwind Cloud', 'Hosting')`).run(wsId).lastInsertRowid);
  const foreignSupplier = Number(db.prepare(`INSERT INTO suppliers (workspace_id, name) VALUES (?, 'Elsewhere Ltd')`).run(otherWsId).lastInsertRowid);

  const crossed = await client.post(`${base()}/ai-systems/${systemId}/suppliers`, { supplier_id: foreignSupplier, lifecycle_role: 'Model provider' });
  assert.match(decodeURIComponent(crossed.location), /not in this client's supplier register/);
  assert.throws(() => db.prepare(`INSERT INTO ai_system_suppliers (ai_system_id, workspace_id, supplier_name, lifecycle_role, supplier_id, created_by) VALUES (?, ?, 'x', 'y', ?, ?)`)
    .run(systemId, wsId, foreignSupplier, actor.id), /crosses workspace boundary/);

  await client.post(`${base()}/ai-systems/${systemId}/suppliers`, { supplier_id: supplierId, lifecycle_role: 'Hosting and compute' });
  await client.post(`${base()}/ai-systems/${systemId}/suppliers`, { supplier_name: 'Bureau partner', lifecycle_role: 'Data provider' });
  const rows = db.prepare('SELECT supplier_name, supplier_id FROM ai_system_suppliers WHERE ai_system_id=? ORDER BY supplier_name').all(systemId);
  assert.deepEqual(rows, [{ supplier_name: 'Bureau partner', supplier_id: null }, { supplier_name: 'Northwind Cloud', supplier_id: supplierId }]);

  const page = await client.get(`${base()}/ai-systems/${systemId}`);
  assert.match(page.text, new RegExp(`href="/workspaces/${wsId}/vendors/${supplierId}">In the supplier register`));
  const pop = require('../lib/ai-systems').population(db, { id: wsId }, 'ai-vendors');
  assert.deepEqual(pop.rows.map((r) => [r[0], r[5]]), [['Bureau partner', 'No'], ['Northwind Cloud', 'Yes']]);
});
