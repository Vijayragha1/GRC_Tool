'use strict';
// The AI system register asks what each role needs (lib/ai-roles.js SECTIONS,
// migration 081): supplier terms for bought AI, rules of use for AI staff
// use, version and checks for AI built here, user information for AI offered
// to others. A part applies by the answers, or by ticked roles where the
// questions are unanswered; a part holding data is never hidden.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const { ROLE_FIELDS } = require('../lib/ai-systems');

let env, client, db, actor, wsId;
const base = () => `/workspaces/${wsId}/iso42001`;
const system = (id) => db.prepare('SELECT * FROM ai_systems WHERE id=?').get(id);
const toast = (res) => decodeURIComponent(res.location || '');
const answers = (yes) => Object.fromEntries(['builds', 'trains', 'sourced', 'uses', 'offers', 'partners'].map((k) => [`role_${k}`, yes.includes(k) ? 'yes' : 'no']));
const add = (name, roles = '[]', extra = {}) => {
  const cols = Object.keys(extra);
  return Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, org_roles, role_answers, lifecycle_stage, in_scope, created_by${cols.map((c) => `, ${c}`).join('')})
    VALUES (?, ?, ?, ?, 'in_use', 1, ?${cols.map(() => ', ?').join('')})`).run(wsId, name, roles, extra.role_answers || null, actor.id, ...Object.values(extra)).lastInsertRowid);
};
// Which panels the system page shows.
const panels = (html) => ['Bought from a supplier', 'Used by the organisation', 'Built or trained by the organisation',
  'Offered to people outside the organisation', 'Worked on for another organisation'].filter((t) => html.includes(`>${t}</h2>`));

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Kestrel Lending', '["iso42001"]', 'certification_support')`)
    .run(actor.firm_id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

test('every field of every role is saved when a system is added and when it is edited', async () => {
  const values = Object.fromEntries(ROLE_FIELDS.map((f) => [f, f === 'validated_on' ? '2026-09-30' : `First ${f}`]));
  const created = await client.post(`${base()}/ai-systems`, { name: 'Claims assistant', lifecycle_stage: 'in_use', in_scope: '1',
    ...answers(['builds', 'trains', 'sourced', 'uses', 'offers', 'partners']), ...values });
  const id = Number(created.location.match(/ai-systems\/(\d+)/)[1]);
  for (const f of ROLE_FIELDS) assert.equal(system(id)[f], values[f], `${f} is saved on create`);

  const changed = Object.fromEntries(ROLE_FIELDS.map((f) => [f, f === 'validated_on' ? '2026-10-05' : `Second ${f}`]));
  await client.post(`${base()}/ai-systems/${id}`, { name: 'Claims assistant', lifecycle_stage: 'in_use', in_scope: '1', version: system(id).version,
    ...answers(['builds', 'trains', 'sourced', 'uses', 'offers', 'partners']), ...changed });
  for (const f of ROLE_FIELDS) assert.equal(system(id)[f], changed[f], `${f} is saved on edit`);

  const bad = await client.post(`${base()}/ai-systems/${id}`, { name: 'Claims assistant', lifecycle_stage: 'in_use', in_scope: '1', version: system(id).version, validated_on: '30/09/2026' });
  assert.match(toast(bad), /Enter a valid date of the last verification and validation/);

  const page = await client.get(`${base()}/ai-systems/${id}`);
  assert.deepEqual(panels(page.text), ['Bought from a supplier', 'Used by the organisation', 'Built or trained by the organisation',
    'Offered to people outside the organisation', 'Worked on for another organisation']);
  assert.match(page.text, /Last verified and validated<\/dt><dd[^>]*>5 Oct 2026/);
});

test('an AI system the organisation buys and uses asks about the supplier and the rules of use, not about building it', async () => {
  const id = add('Writing assistant', '["customer"]', { role_answers: JSON.stringify({ builds: 'no', trains: 'no', sourced: 'yes', uses: 'yes', offers: 'no', partners: 'no' }) });
  const page = await client.get(`${base()}/ai-systems/${id}`);
  assert.deepEqual(panels(page.text), ['Bought from a supplier', 'Used by the organisation']);
  assert.doesNotMatch(page.text, />Tooling<\/dt>/, 'tooling belongs to systems the organisation builds');

  const form = await client.get(`${base()}/ai-systems/${id}?edit=1`);
  const applies = Object.fromEntries([...form.text.matchAll(/data-role-section="([a-z]+)" data-when="[a-z ]+" data-filled="(\d)" data-applies="(\d)"/g)].map((m) => [m[1], m[3]]));
  assert.deepEqual(applies, { bought: '1', used: '1', built: '0', offered: '0', partner: '0' });
  assert.match(form.text, /name="supplier_terms"/, 'every part stays in the form, so answering yes shows it without losing anything');
});

test('a system built and offered to customers asks about its version and its users', async () => {
  const id = add('Credit scoring', '["producer","provider"]', { role_answers: JSON.stringify({ builds: 'yes', trains: 'yes', sourced: 'no', uses: 'no', offers: 'yes', partners: 'no' }) });
  assert.deepEqual(panels((await client.get(`${base()}/ai-systems/${id}`)).text), ['Built or trained by the organisation', 'Offered to people outside the organisation']);
});

test('roles ticked before the questions existed still decide the parts, and a part holding data is never hidden', async () => {
  const legacy = add('Fraud alerts', '["producer"]');
  assert.deepEqual(panels((await client.get(`${base()}/ai-systems/${legacy}`)).text), ['Built or trained by the organisation']);

  const kept = add('Document search', '["customer"]', { role_answers: JSON.stringify({ builds: 'no', trains: 'no', sourced: 'yes', uses: 'yes', offers: 'no', partners: 'no' }), model_version: '1.4' });
  const page = await client.get(`${base()}/ai-systems/${kept}`);
  assert.ok(panels(page.text).includes('Built or trained by the organisation'));
  assert.match(page.text, /Kept because it holds data, though the answers no longer call for it/);

  const bare = add('Unlabelled model');
  const empty = await client.get(`${base()}/ai-systems/${bare}`);
  assert.deepEqual(panels(empty.text), []);
  assert.match(empty.text, /Answer what the organisation does with this system<\/a>, and the register asks what that role needs/);
});
