'use strict';
// Fixes for what blocked ISO 42001 engagements from completing: which shared
// audits, reviews and findings count for the AIMS (lib/aims-shared-records.js),
// the ISO 42001 pages being refused to clients without the programme, the
// supplier register link without the third-party risk module, and the runway
// of a gap-assessment-only engagement.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, aiOnlyId, combinedId, ismsId;
const ws = (id) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const shared = () => require('../lib/aims-shared-records');

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name, frameworks) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`)
    .run(actor.firm_id, name, frameworks).lastInsertRowid);
  aiOnlyId = add('Kestrel Lending', '["iso42001"]');
  combinedId = add('Harbour Analytics', '["iso27001","iso42001"]');
  ismsId = add('Harbour Freight', '["iso27001"]');
});
test.after(async () => { db?.close(); await client?.close(); });

test('a management review saved as the form saves it counts towards ISO 42001 readiness', () => {
  for (const [status, counts] of [['planned', 0], ['complete', 1], ['completed', 2], ['done', 3]]) {
    db.prepare(`INSERT INTO mrms (workspace_id, meeting_date, status, created_by) VALUES (?, date('now','-5 days'), ?, ?)`).run(aiOnlyId, status, actor.id);
    assert.equal(shared().heldReviews(db, ws(aiOnlyId)), counts, `after a '${status}' review`);
  }
  const { shared: routes } = require('../routes/iso42001');
  assert.equal(routes.computeIso42001Readiness(aiOnlyId).records.mandatory.checks.find((c) => c.clause === '9.3').found, true);
});

test('on a client with both standards, only ISO 42001 audits and findings count for the AIMS', () => {
  const audit = (wsId, title) => Number(db.prepare(`INSERT INTO audits (workspace_id, title, status, created_by) VALUES (?, ?, 'complete', ?)`).run(wsId, title, actor.id).lastInsertRowid);
  const ncs = (wsId) => shared().openNonconformities(db, ws(wsId));

  const isms = audit(combinedId, 'ISMS internal audit');
  db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description) VALUES (?, 'clause-9.2', 'Audit programme tested')`).run(isms);
  assert.equal(shared().reportedAudits(db, ws(combinedId)), 0, 'an audit of the ISMS alone is not an AIMS audit');
  const aims = audit(combinedId, 'Integrated internal audit');
  db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description) VALUES (?, 'ai-clause-9.2', 'AIMS audit programme tested')`).run(aims);
  assert.equal(shared().reportedAudits(db, ws(combinedId)), 1);
  audit(aiOnlyId, 'AIMS internal audit');
  assert.equal(shared().reportedAudits(db, ws(aiOnlyId)), 1, 'on an ISO 42001-only client every reported audit is the AIMS\'s');

  db.prepare(`INSERT INTO nonconformities (workspace_id, title, iso_item_id, status) VALUES (?, 'Patching late', 'clause-8.8', 'open')`).run(combinedId);
  assert.equal(ncs(combinedId), 0, 'an open ISO 27001 finding does not block ISO 42001');
  db.prepare(`INSERT INTO nonconformities (workspace_id, title, iso_item_id, status) VALUES (?, 'No impact assessment', 'ai-clause-8.4', 'open')`).run(combinedId);
  db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, status) VALUES (?, 'Stage 1 observation', 'external_audit', 'iso42001_cert_cycle_event:1', 'open')`).run(combinedId);
  db.prepare(`INSERT INTO nonconformities (workspace_id, title, iso_item_id, status) VALUES (?, 'Closed AI gap', 'ai-clause-6.2', 'closed')`).run(combinedId);
  assert.equal(ncs(combinedId), 2, 'a requirement finding and a certification audit finding without a requirement both count');
  db.prepare(`INSERT INTO nonconformities (workspace_id, title, status) VALUES (?, 'Unassigned', 'open')`).run(aiOnlyId);
  assert.equal(ncs(aiOnlyId), 1);

  const { shared: routes } = require('../routes/iso42001');
  assert.equal(routes.computeIso42001Readiness(aiOnlyId).records.mandatory.checks.find((c) => c.clause === '9.2').found, true,
    'readiness and the delivery plan read audits the same way');
});

test('ISO 42001 pages are refused for a client without the programme', async () => {
  for (const path of ['readiness', 'readiness/blockers', 'exec-brief', 'soa', 'gap-assessment', 'overview', 'ai-systems']) {
    const isms = await client.get(`/workspaces/${ismsId}/iso42001/${path}`);
    assert.equal(isms.status, 404, `/${path} on an ISO 27001-only client`);
  }
  assert.match((await client.get(`/workspaces/${ismsId}/iso42001/readiness`)).text, /ISO 42001 is not part of this client/);
  assert.equal((await client.get(`/workspaces/${aiOnlyId}/iso42001/readiness`)).status, 200);
  assert.equal((await client.get(`/workspaces/${ismsId}/iso42001-unrelated`)).status, 404, 'only the ISO 42001 path is gated');
});

test('a supplier register entry is linked only when the client has third-party risk', async () => {
  const systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Credit scoring model', 'in_use', ?)`).run(aiOnlyId, actor.id).lastInsertRowid);
  const page = () => client.get(`/workspaces/${aiOnlyId}/iso42001/ai-systems/${systemId}`);
  assert.doesNotMatch((await page()).text, /name="supplier_id"/, 'no register to pick from');

  const supplierId = Number(db.prepare(`INSERT INTO suppliers (workspace_id, name) VALUES (?, 'Northwind Cloud')`).run(aiOnlyId).lastInsertRowid);
  assert.match((await page()).text, /name="supplier_id"/);
  await client.post(`/workspaces/${aiOnlyId}/iso42001/ai-systems/${systemId}/suppliers`, { supplier_id: supplierId, lifecycle_role: 'Hosting and compute' });
  let text = (await page()).text;
  assert.match(text, /In the supplier register/);
  assert.doesNotMatch(text, new RegExp(`/vendors/${supplierId}`), 'without the module the entry is named, not linked');

  db.prepare(`INSERT INTO tprm_modules (workspace_id, service_model, status, activation_reason, created_by) VALUES (?, 'managed_lifecycle', 'active', 'Test', ?)`).run(aiOnlyId, actor.id);
  text = (await page()).text;
  assert.match(text, new RegExp(`href="/workspaces/${aiOnlyId}/vendors/${supplierId}">In the supplier register`));
});

test('a gap-assessment-only runway shows the assessment and its report', () => {
  const { gapOnlyLifecycle } = require('../lib/iso42001-masthead');
  const projection = (fieldwork, report) => ({ milestones: [
    { milestone_key: 'gap-fieldwork-validation', effective_status: fieldwork },
    { milestone_key: 'gap-controlled-report', effective_status: report },
  ] });
  const shape = (p) => gapOnlyLifecycle(p).map((s) => `${s.name}:${s.done ? 'done' : s.current ? 'current' : '-'}`);
  assert.deepEqual(shape(projection('in_progress', 'not_started')), ['Assess:current', 'Report:-']);
  assert.deepEqual(shape(projection('complete', 'in_progress')), ['Assess:done', 'Report:current']);
  assert.deepEqual(shape(projection('complete', 'complete')), ['Assess:done', 'Report:done']);
  assert.deepEqual(shape(null), ['Assess:-', 'Report:-'], 'no plan lights nothing');
});
