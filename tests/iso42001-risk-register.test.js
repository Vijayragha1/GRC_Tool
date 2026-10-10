'use strict';
// The AIMS's risk register inside the ISO 42001 module: its own list, risk
// pages, risk criteria and assessment records, with treatment actions,
// acceptance, control links and deletion returning to the module.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, systemId;
const base = () => `/workspaces/${wsId}/iso42001/risks`;
const risk = (title) => db.prepare('SELECT * FROM risks WHERE workspace_id=? AND title=?').get(wsId, title);
const toast = (res) => decodeURIComponent(res.location || '');

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Harbour Analytics', '["iso27001","iso42001"]', 'certification_support')`)
    .run(actor.firm_id).lastInsertRowid);
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Scoring model', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO risks (workspace_id, title, likelihood, impact) VALUES (?, 'Office flood', 4, 4)`).run(wsId);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the AI risk register lists and adds the AIMS\'s risks only', async () => {
  const empty = await client.get(base());
  assert.equal(empty.status, 200);
  assert.match(empty.text, /AI risk register/);
  assert.doesNotMatch(empty.text, /Office flood/, 'the ISMS risk stays on the shared register');
  assert.match(empty.text, /href="\/workspaces\/\d+\/iso42001\/stages\/assess" class="nav-subitem active"/, 'the register marks its stage in the menu');

  const nameless = await client.post(base(), { likelihood: 3, impact: 3 });
  assert.match(toast(nameless), /Name the risk/);
  const unrated = await client.post(base(), { title: 'Unrated' });
  assert.match(toast(unrated), /Rate the likelihood/);

  const added = await client.post(base(), { title: 'Scores under-rate thin-file applicants', likelihood: 4, impact: 3,
    ai_system_id: systemId, risk_source: 'data', impact_individuals: 5, owner_name: 'Head of credit' });
  const r = risk('Scores under-rate thin-file applicants');
  assert.equal(added.location.split('?')[0], `${base()}/${r.id}`);
  assert.equal(r.management_system, 'iso42001', 'a risk added in the module is the AIMS\'s, on a client with both systems');
  assert.equal(r.impact, 5);
  const list = await client.get(base());
  assert.match(list.text, /Scores under-rate thin-file applicants/);
  assert.match(list.text, /Scoring model/);
});

test('a risk\'s page edits it and runs treatment, links and acceptance from the module', async () => {
  const r = risk('Scores under-rate thin-file applicants');
  const page = await client.get(`${base()}/${r.id}`);
  assert.equal(page.status, 200);
  const picker = page.text.slice(page.text.indexOf('id="arLink"'), page.text.indexOf('</select>', page.text.indexOf('id="arLink"')));
  const offered = [...picker.matchAll(/value="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(offered.length > 30 && offered.every((v) => v.startsWith('ai-')), 'only ISO 42001 controls are offered');
  assert.equal((await client.get(`/workspaces/${wsId}/risks/${r.id}`)).location, `${base()}/${r.id}`);

  const saved = await client.post(`${base()}/${r.id}`, { title: r.title, likelihood: 2, impact: 3, impact_individuals: 4, residual_likelihood: 1, residual_impact: 2, status: 'treated' });
  assert.equal(saved.location.split('?')[0], `${base()}/${r.id}`);
  assert.deepEqual([risk(r.title).likelihood, risk(r.title).status, risk(r.title).residual_impact], [2, 'treated', 2]);

  const here = `${base()}/${r.id}`;
  const linked = await client.post(`/workspaces/${wsId}/risks/${r.id}/link`, { iso_item_id: 'ai-annex-a-6-2-4', return_to: `${here}#controls` });
  assert.equal(linked.location, `${here}#controls`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_risk_controls WHERE risk_id=?').get(r.id).c, 1);
  const escaped = await client.post(`/workspaces/${wsId}/risks/${r.id}/unlink`, { iso_item_id: 'ai-annex-a-6-2-4', return_to: 'https://example.com/' });
  assert.equal(escaped.location, `/workspaces/${wsId}/risks/${r.id}`, 'a return address outside the module is ignored');

  const action = await client.post(`/workspaces/${wsId}/risks/${r.id}/actions`, { title: 'Add a fairness test to release criteria', owner_name: 'ML lead', return_to: `${here}#actions` });
  assert.equal(action.location, `${here}#actions`);
  const noTitle = await client.post(`/workspaces/${wsId}/risks/${r.id}/actions`, { return_to: `${here}#actions` });
  assert.match(toast(noTitle), /Name the treatment action/);
  const actionId = db.prepare('SELECT id FROM risk_treatment_actions WHERE risk_id=?').get(r.id).id;
  await client.post(`/workspaces/${wsId}/risks/${r.id}/actions/${actionId}`, { title: 'Add a fairness test to release criteria', status: 'done', residual_likelihood: 1, residual_impact: 1, return_to: `${here}#actions` });
  assert.equal(risk(r.title).residual_impact, 1, 'closing an action records the residual rating');

  const refused = await client.post(`/workspaces/${wsId}/risks/${r.id}/accept`, { accepter_name: 'CRO', return_to: `${here}#acceptance` });
  assert.match(toast(refused), /rationale and the attestation/);
  const accepted = await client.post(`/workspaces/${wsId}/risks/${r.id}/accept`, { accepter_name: 'Asha Rao', accepter_role: 'CRO', rationale: 'Residual is low after the fairness test', attestation: '1', return_to: `${here}#acceptance` });
  assert.match(accepted.location, new RegExp(`^${here.replace(/\//g, '\\/')}\\?toast=.*#acceptance$`));
  assert.equal(risk(r.title).status, 'accepted');
  const after = await client.get(here);
  assert.match(after.text, /Accepted by Asha Rao, CRO/);
  assert.match(after.text, /Add a fairness test to release criteria/);
});

test('the AIMS\'s risk criteria and assessment records live in the module', async () => {
  const criteria = await client.get(`${base()}/criteria`);
  assert.equal(criteria.status, 200);
  assert.match(criteria.text, /AI risk criteria/);
  assert.match(criteria.text, new RegExp(`name="return_to" value="${base().replace(/\//g, '\\/')}\\/criteria"`));
  assert.match(criteria.text, /name="standard" value="iso42001"/);

  const recorded = await client.post(`${base()}/assessments`, { label: 'AI risk assessment, Q4', performed_on: '2026-10-01' });
  const recordId = Number(recorded.location.match(/assessments\/(\d+)/)[1]);
  assert.equal(db.prepare('SELECT scope FROM risk_assessment_records WHERE id=?').get(recordId).scope, 'ai');
  const record = await client.get(`${base()}/assessments/${recordId}`);
  assert.equal(record.status, 200);
  assert.match(record.text, /AI risk register<\/a> · Risk assessment record/);
  assert.doesNotMatch(record.text, /Office flood/);
  const register = await client.get(base());
  assert.match(register.text, /AI risk assessment, Q4/);
});

test('deleting from the module returns to the register', async () => {
  const r = risk('Scores under-rate thin-file applicants');
  const deleted = await client.post(`/workspaces/${wsId}/risks/${r.id}/delete`, { return_to: base() });
  assert.equal(deleted.location, base());
  assert.equal(risk(r.title), undefined);
  assert.equal((await client.get(`${base()}/${r.id}`)).status, 404);
  const ismsRisk = risk('Office flood');
  assert.equal((await client.get(`${base()}/${ismsRisk.id}`)).status, 404, 'an ISMS risk has no page in the module');
});
