'use strict';
// The organisation's role for each AI system (lib/ai-roles.js, clause 4.1):
// derived from what the organisation does with the system, shown as a
// profile, and asked for wherever the engagement starts.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const aiRoles = require('../lib/ai-roles');

let env, client, db, actor, wsId, ids;
const base = () => `/workspaces/${wsId}/iso42001`;
const system = (id) => db.prepare('SELECT * FROM ai_systems WHERE id=?').get(id);
const toast = (res) => decodeURIComponent(res.location || '');
const all = (value) => Object.fromEntries(aiRoles.KEYS.map((k) => [`role_${k}`, value]));

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Kestrel Lending', '["iso42001"]', 'certification_support')`)
    .run(actor.firm_id).lastInsertRowid);
  const add = (name, roles, stage = 'in_use') => Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, purpose, org_roles, lifecycle_stage, in_scope, created_by)
    VALUES (?, ?, 'Purpose', ?, ?, 1, ?)`).run(wsId, name, roles, stage, actor.id).lastInsertRowid);
  ids = { copilot: add('Writing assistant', '["customer"]'), scoring: add('Credit scoring', '[]'), legacy: add('Old chatbot', '[]', 'retired') };
});
test.after(async () => { db?.close(); await client?.close(); });

test('the answers decide the roles, and connecting a supplier\'s model to your own data makes you its producer', () => {
  assert.deepEqual(aiRoles.derive({ sourced: 'yes', uses: 'yes', builds: 'no', trains: 'no' }), ['customer']);
  assert.deepEqual(aiRoles.derive({ sourced: 'yes', uses: 'yes', trains: 'yes' }), ['customer', 'producer']);
  assert.deepEqual(aiRoles.derive({ builds: 'yes', offers: 'yes' }), ['producer', 'provider']);
  assert.deepEqual(aiRoles.derive({ partners: 'yes' }), ['partner']);
  assert.deepEqual(aiRoles.derive({ builds: 'no' }), []);
  assert.deepEqual(aiRoles.parseAnswers({ role_builds: 'yes', role_trains: 'maybe', role_offers: 'no', other: 'yes' }), { builds: 'yes', offers: 'no' });
  assert.equal(aiRoles.joinRoles(['customer', 'producer', 'provider']), 'customer, producer and provider');
});

test('the roles page shows the profile and asks the questions per system', async () => {
  const page = await client.get(`${base()}/roles`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1 class="page-title">AI roles<\/h1>/);
  assert.match(page.text, /Customer of 1 AI system/, 'a role ticked before the questions still counts');
  assert.match(page.text, /Ticked before the questions existed; answer them to confirm/);
  const open = page.text.match(/<li id="system-(\d+)">(?:(?!<\/li>)[\s\S])*<details class="a42-fold" open>/g) || [];
  assert.deepEqual(open.map((m) => Number(m.match(/system-(\d+)/)[1])), [ids.scoring], 'only the first system to answer, by name, is open');
  assert.match(page.text, /Old chatbot[\s\S]{0,400}outside the AIMS scope or retired, so not counted/);
  assert.equal(page.text.match(/name="role_trains" value="yes"/g).length, 3, 'every system has the questions');
});

test('answering the questions sets the roles and says which the organisation gained', async () => {
  const before = system(ids.copilot);
  const trained = await client.post(`${base()}/roles/${ids.copilot}`, { version: before.version, ...all('no'), role_sourced: 'yes', role_uses: 'yes', role_trains: 'yes' });
  assert.match(toast(trained), /Writing assistant: the organisation is now also its producer/);
  assert.match(trained.location, new RegExp(`/roles\\?toast=.*#system-${ids.copilot}$`));
  const after = system(ids.copilot);
  assert.deepEqual(JSON.parse(after.org_roles), ['customer', 'producer']);
  assert.equal(JSON.parse(after.role_answers).trains, 'yes');

  const stale = await client.post(`${base()}/roles/${ids.copilot}`, { version: before.version, ...all('no') });
  assert.match(toast(stale), /changed in another session/);
  const empty = await client.post(`${base()}/roles/${ids.scoring}`, { version: system(ids.scoring).version });
  assert.match(toast(empty), /Answer at least one question about Credit scoring/);

  const offered = await client.post(`${base()}/roles/${ids.scoring}`, { version: system(ids.scoring).version, ...all('no'), role_builds: 'yes', role_offers: 'yes' });
  assert.match(toast(offered), /Credit scoring: the organisation is its producer and provider/);

  const page = await client.get(`${base()}/roles`);
  assert.match(page.text, /Producer and provider of 1 AI system · customer and producer of 1/);
  assert.match(page.text, /AI provider<\/span>\s*<p>1 system: Credit scoring/);
  assert.doesNotMatch(page.text, /<details class="a42-fold" open>/, 'nothing left to answer');
});

test('the system form asks the same questions and keeps roles it is not given', async () => {
  const s = system(ids.copilot);
  const fields = { name: s.name, purpose: 'Drafts letters', lifecycle_stage: 'in_use', in_scope: '1' };
  const form = await client.get(`${base()}/ai-systems/${s.id}?edit=1`);
  assert.match(form.text, /name="role_trains" value="yes" id="aiRole-trains-yes" checked/);
  assert.doesNotMatch(form.text, /name="org_roles"/, 'the role boxes are gone');

  await client.post(`${base()}/ai-systems/${s.id}`, { ...fields, version: s.version });
  assert.deepEqual(JSON.parse(system(s.id).org_roles), ['customer', 'producer'], 'a save without answers keeps the roles');
  await client.post(`${base()}/ai-systems/${s.id}`, { ...fields, version: system(s.id).version, ...all('no'), role_uses: 'yes', role_sourced: 'yes' });
  assert.deepEqual(JSON.parse(system(s.id).org_roles), ['customer'], 'the answers on the form set the roles');
  await client.post(`${base()}/ai-systems/${s.id}`, { ...fields, version: system(s.id).version, org_roles: ['customer', 'provider'] });
  assert.deepEqual([JSON.parse(system(s.id).org_roles), system(s.id).role_answers], [['customer', 'provider'], null], 'roles set directly drop the answers they no longer follow');
  await client.post(`${base()}/roles/${s.id}`, { version: system(s.id).version, ...all('no'), role_uses: 'yes', role_sourced: 'yes' });

  const created = await client.post(`${base()}/ai-systems`, { name: 'Fraud alerts', purpose: 'Flags payments', lifecycle_stage: 'in_use', in_scope: '1', org_roles: ['customer'] });
  const newId = Number(created.location.match(/ai-systems\/(\d+)/)[1]);
  assert.deepEqual(JSON.parse(system(newId).org_roles), ['customer'], 'roles posted directly still work');
  assert.equal(system(newId).role_answers, null);
});

test('the overview, the Mobilise stage and readiness ask for the roles still missing', async () => {
  const overview = await client.get(`${base()}/overview`);
  assert.match(overview.text, /The organisation&#39;s AI roles|The organisation's AI roles/);
  assert.match(overview.text, /Record what the organisation does with 1 AI system/, 'Fraud alerts was ticked, not answered');

  const mobilise = await client.get(`${base()}/stages/mobilise`);
  const line = mobilise.text.slice(mobilise.text.indexOf('>AI roles</a>'), mobilise.text.indexOf('</li>', mobilise.text.indexOf('>AI roles</a>')));
  assert.match(line, /In progress/);
  assert.match(line, /2 of 3 AI systems answered/);

  const bare = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Unlabelled model', 'in_use', 1, ?)`).run(wsId, actor.id).lastInsertRowid);
  const { shared } = require('../routes/iso42001');
  const flag = shared.computeIso42001Readiness(wsId).flags.find((f) => f.kind === 'roles_missing');
  assert.deepEqual(flag.items.map((i) => i.id), [bare], 'only the in-scope system with no role; the retired one is not counted');
  const readiness = await client.get(`${base()}/readiness`);
  assert.match(readiness.text, new RegExp(`href="${base()}/roles#system-${bare}"`));
  const register = await client.get(`${base()}/ai-systems`);
  assert.match(register.text, new RegExp(`href="${base()}/roles#system-${bare}">Not recorded`));
});
