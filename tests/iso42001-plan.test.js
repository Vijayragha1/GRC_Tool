'use strict';
// Owners and due dates on ISO 42001 requirements, the roadmap phase that
// follows the due date, the readiness flags for late and unowned work, and an
// executive brief that reports AI risks from the register instead of an
// invented money figure.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const plan = require('../lib/iso42001-plan');

let env, client, db, actor, wsId, outsiderId, systemId;
const base = () => `/workspaces/${wsId}/iso42001`;
const state = (id) => db.prepare('SELECT owner_id, due_date FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(wsId, id) || {};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id, name FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  const otherFirm = Number(db.prepare(`INSERT INTO firms (name) VALUES ('Another Firm')`).run().lastInsertRowid);
  outsiderId = Number(db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES ('outsider@other.example', '!noauth', 'Outsider', ?, 'firm', 'consultant', 1)`).run(otherFirm).lastInsertRowid);
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Triage assistant', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the phase follows the due date, and choosing a phase sets a date inside it', () => {
  const today = '2026-09-27';
  assert.equal(plan.phaseFor(null, today), '');
  assert.equal(plan.phaseFor('2026-01-01', today), '0_3M', 'overdue work belongs to now');
  assert.equal(plan.phaseFor('2026-12-27', today), '0_3M');
  assert.equal(plan.phaseFor('2027-02-01', today), '3_6M');
  assert.equal(plan.phaseFor('2027-09-27', today), '6_12M');
  assert.equal(plan.phaseFor('2027-09-28', today), '12M_plus');
  assert.equal(plan.dueForPhase('3_6M', '2027-02-01', today), '2027-02-01', 'a date already in the phase is kept');
  assert.equal(plan.dueForPhase('3_6M', '2026-10-01', today), '2027-03-27');
  assert.equal(plan.dueForPhase('12M_plus', null, today), '2028-03-27');
  assert.equal(plan.dueForPhase('', '2027-02-01', today), null);
  assert.throws(() => plan.dueForPhase('someday', null, today), /Choose a phase/);
});

test('owners and due dates are set per requirement and in bulk, and only to people on the engagement', async () => {
  let res = await client.post(`${base()}/controls/ai-annex-a-2-2/plan`, { owner_id: String(actor.id), due_date: '2026-11-30' });
  assert.equal(res.status, 302);
  assert.deepEqual(state('ai-annex-a-2-2'), { owner_id: actor.id, due_date: '2026-11-30' });
  res = await client.post(`${base()}/controls/ai-annex-a-2-2/plan`, { owner_id: String(outsiderId), due_date: '2026-12-31' });
  assert.match(decodeURIComponent(res.location), /member of this client or of the firm/);
  assert.equal(state('ai-annex-a-2-2').due_date, '2026-11-30', 'nothing is saved when the owner is refused');
  res = await client.post(`${base()}/controls/ai-annex-a-2-2/plan`, { owner_id: String(actor.id), due_date: '30/11/2026' });
  assert.match(decodeURIComponent(res.location), /YYYY-MM-DD/);

  await client.post(`${base()}/bulk-controls`, { ids: ['ai-annex-a-2-3', 'ai-annex-a-2-4'], owner_id: String(actor.id), due_date: '2027-01-15' });
  assert.deepEqual(state('ai-annex-a-2-3'), { owner_id: actor.id, due_date: '2027-01-15' });
  assert.deepEqual(state('ai-annex-a-2-4'), { owner_id: actor.id, due_date: '2027-01-15' });
  await client.post(`${base()}/bulk-controls`, { ids: ['ai-annex-a-2-4'], owner_id: 'none', clear_due: '1' });
  assert.deepEqual(state('ai-annex-a-2-4'), { owner_id: null, due_date: null });
  await client.post(`${base()}/bulk-controls`, { ids: ['ai-annex-a-2-3'], status: 'Work In Progress' });
  assert.equal(state('ai-annex-a-2-3').due_date, '2027-01-15', 'a status-only bulk change leaves the plan alone');

  const grid = await client.get(`${base()}/controls`);
  assert.equal(grid.status, 200);
  const bulk = grid.text.slice(grid.text.indexOf('id="bulkForm"'), grid.text.indexOf('</form>', grid.text.indexOf('id="bulkForm"')));
  assert.doesNotMatch(bulk, /<form/, 'no form is nested inside the bulk form');
  assert.match(grid.text, /name="due_date" form="plan-ai-annex-a-2-2" value="2026-11-30"/);
  assert.match(grid.text, /<form method="POST" action="\/workspaces\/\d+\/iso42001\/controls\/ai-annex-a-2-2\/plan" id="plan-ai-annex-a-2-2" hidden>/);
});

test('moving a control on the roadmap changes its due date, and Unscheduled clears it', async () => {
  let res = await client.post(`${base()}/roadmap/ai-annex-a-3-2/phase`, { phase: '6_12M' });
  assert.equal(res.status, 302);
  const due = state('ai-annex-a-3-2').due_date;
  assert.equal(plan.phaseFor(due), '6_12M');
  const page = await client.get(`${base()}/roadmap`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`Due ${due}`));
  await client.post(`${base()}/roadmap/ai-annex-a-3-2/phase`, { phase: '' });
  assert.equal(state('ai-annex-a-3-2').due_date, null);
  res = await client.post(`${base()}/roadmap/not-a-control/phase`, { phase: '0_3M' });
  assert.match(decodeURIComponent(res.location), /not in ISO 42001/);
});

test('readiness flags late and unowned work', async () => {
  const { shared } = require('../routes/iso42001');
  await client.post(`${base()}/controls/ai-annex-a-4-2/plan`, { owner_id: '', due_date: '2020-01-01' });
  await client.post(`${base()}/bulk-controls`, { ids: ['ai-annex-a-4-2', 'ai-annex-a-4-3'], applicability: 'included', status: 'Work In Progress' });
  const flags = shared.computeIso42001Readiness(wsId).flags;
  const overdue = flags.find((f) => f.kind === 'controls_overdue');
  assert.ok(overdue && overdue.items.some((i) => i.id === 'ai-annex-a-4-2'));
  const unowned = flags.find((f) => f.kind === 'controls_unowned');
  assert.ok(unowned && unowned.items.some((i) => i.id === 'ai-annex-a-4-3'));
});

test('the executive brief reports AI risks by band, with no invented money figure', async () => {
  db.prepare(`INSERT INTO risks (workspace_id, title, likelihood, impact, status, ai_system_id) VALUES (?, 'Missed urgent referral', 5, 5, 'open', ?)`).run(wsId, systemId);
  db.prepare(`INSERT INTO risks (workspace_id, title, likelihood, impact, residual_likelihood, residual_impact, status, risk_source) VALUES (?, 'Biased triage outcomes', 3, 4, 1, 2, 'open', 'data')`).run(wsId);
  db.prepare(`INSERT INTO risks (workspace_id, title, likelihood, impact, status) VALUES (?, 'Office flood', 5, 5, 'open')`).run(wsId);
  const page = await client.get(`${base()}/exec-brief`);
  assert.equal(page.status, 200, page.text.slice(0, 300));
  assert.doesNotMatch(page.text, /\$\d|50k|annual loss/i);
  assert.match(page.text, /Open AI risks<\/div>\s*<div class="kpi-num exec-num" style="color:#b91c1c">2<\/div>/);
  assert.match(page.text, /1 high or critical, 1 not formally accepted · 1 without a residual rating/);
  assert.match(page.text, /Missed urgent referral/);
  assert.doesNotMatch(page.text, /Office flood/, 'only AI risks are counted');
});
