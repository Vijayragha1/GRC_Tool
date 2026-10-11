'use strict';
// Proposed applicability of each Annex A control from the organisation's AI
// roles (lib/aims-soa-proposals.js): proposed, never applied until a person
// accepts it, with the drafted reason filling only an empty justification,
// and flagged when a role changes after the decision.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const P = require('../lib/aims-soa-proposals');

let env, client, db, actor, wsId, emptyId, systemId;
const base = (id = wsId) => `/workspaces/${id}/iso42001`;
const toast = (res) => decodeURIComponent(res.location || '');
const state = (ref, id = wsId) => db.prepare(`SELECT COALESCE(applicability,'undecided') AS applicability, inclusion_justification, exclusion_justification
  FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(id, ref) || { applicability: 'undecided' };
const ws = (id = wsId) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const row = (html, ref) => {
  const at = html.indexOf(`id="soa-${ref}"`);
  assert.ok(at > 0, `${ref} has a row`);
  // The row and the proposal line under it, up to the next control's row.
  const next = html.indexOf('<tr id="soa-', at + 1);
  return html.slice(at, next > 0 ? next : html.indexOf('</tbody>', at));
};
const answers = (overrides) => ({ role_builds: 'no', role_trains: 'no', role_sourced: 'yes', role_uses: 'yes', role_offers: 'no', role_partners: 'no', ...overrides });

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, '["iso42001"]', 'certification_support')`)
    .run(actor.firm_id, name).lastInsertRowid);
  wsId = add('Kestrel Lending');
  emptyId = add('Wren Insurance');
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Writing assistant', 'in_use', 1, ?)`)
    .run(wsId, actor.id).lastInsertRowid);
  const version = db.prepare('SELECT version FROM ai_systems WHERE id=?').get(systemId).version;
  await client.post(`${base()}/roles/${systemId}`, { version, ...answers() });
});
test.after(async () => { db?.close(); await client?.close(); });

test('every Annex A control has a rule, and no rule names a control that does not exist', () => {
  const controls = db.prepare("SELECT id FROM iso42001_items WHERE type='control' ORDER BY id").all().map((r) => r.id);
  assert.equal(controls.length, 38);
  assert.deepEqual(Object.keys(P.RULES).sort(), controls.sort());
});

test('an organisation that only uses bought AI is proposed the use and supplier controls, not the development ones', () => {
  const p = P.forWorkspace(db, ws()).byId;
  assert.equal(p['ai-annex-a-9-2'].kind, 'include');
  assert.match(p['ai-annex-a-9-2'].reason, /The organisation uses Writing assistant in its own work or decisions \(AI customer or user, clause 4\.1\)/);
  assert.equal(p['ai-annex-a-10-3'].kind, 'include');
  assert.equal(p['ai-annex-a-6-1-2'].kind, 'exclude');
  assert.match(p['ai-annex-a-6-1-2'].reason, /does not design, build, train or adapt any AI system in scope.*Writing assistant comes from a supplier/);
  assert.equal(p['ai-annex-a-10-4'].kind, 'exclude');
  assert.equal(p['ai-annex-a-7-2'].kind, 'exclude');
  assert.equal(p['ai-annex-a-6-2-2'].kind, 'review', 'whether a buyer sets requirements is a question, not a rule');
  assert.equal(p['ai-annex-a-2-2'].kind, 'include');
  assert.equal(P.forWorkspace(db, ws(emptyId)).ready, false, 'no roles, no proposals');
});

test('the SoA shows each proposal where a decision is needed, and the roles page points to it', async () => {
  const page = await client.get(`${base()}/soa`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Proposed from the organisation&#39;s AI roles|Proposed from the organisation's AI roles/);
  assert.match(page.text, /undecided controls the roles say apply/);
  assert.match(row(page.text, 'ai-annex-a-6-1-2'), /Proposed: can be excluded[\s\S]*form="soaAccept-ai-annex-a-6-1-2"[^>]*onclick="return confirm/);
  assert.match(row(page.text, 'ai-annex-a-6-2-2'), /Decide on the facts/);
  assert.doesNotMatch(row(page.text, 'ai-annex-a-6-2-2'), /form="soaAccept-/, 'nothing to accept on a question');
  assert.match(page.text, /<form id="soaAccept-ai-annex-a-9-2" method="POST" action="\/workspaces\/\d+\/iso42001\/soa\/ai-annex-a-9-2\/accept-proposal" hidden>/);

  const roles = await client.get(`${base()}/roles`);
  assert.match(roles.text, /For the Statement of Applicability: 20 controls apply, 8 can be excluded, 10 to decide on the facts/);
  const none = await client.get(`${base(emptyId)}/soa`);
  assert.match(none.text, /Record what the organisation does with each AI system on the AI roles page/);
  assert.match(toast(await client.post(`${base(emptyId)}/soa/ai-annex-a-9-2/accept-proposal`, {})), /Record the organisation's role/);
});

test('accepting a proposal records the decision and fills only an empty reason', async () => {
  const excluded = await client.post(`${base()}/soa/ai-annex-a-7-2/accept-proposal`, {});
  assert.match(toast(excluded), /Excluded, with the drafted reason/);
  assert.match(excluded.location, /#soa-ai-annex-a-7-2$/);
  assert.equal(state('ai-annex-a-7-2').applicability, 'excluded');
  assert.match(state('ai-annex-a-7-2').exclusion_justification, /No AI system in scope is trained, fine-tuned or connected/);
  const logged = db.prepare(`SELECT details FROM audit_log WHERE workspace_id=? AND action='accept_iso42001_soa_proposal' ORDER BY id DESC LIMIT 1`).get(wsId);
  assert.match(logged.details, /"kind":"exclude"/);
  assert.match(logged.details, /Writing assistant/);

  await client.post(`${base()}/soa/ai-annex-a-9-2`, { applicability: 'undecided', justification: 'Staff use approved tools under our AI use policy' });
  await client.post(`${base()}/soa/ai-annex-a-9-2/accept-proposal`, {});
  assert.deepEqual([state('ai-annex-a-9-2').applicability, state('ai-annex-a-9-2').inclusion_justification], ['included', 'Staff use approved tools under our AI use policy'],
    'the consultant\'s own reason is kept');

  const question = await client.post(`${base()}/soa/ai-annex-a-6-2-2/accept-proposal`, {});
  assert.match(toast(question), /The roles leave this control to you/);
  assert.equal(state('ai-annex-a-6-2-2').applicability, 'undecided');
  assert.equal((await client.post(`${base()}/soa/ai-annex-a-99/accept-proposal`, {})).status, 404);
});

test('accepting in bulk marks only undecided controls the roles say apply', async () => {
  const bulk = await client.post(`${base()}/soa/accept-proposals`, {});
  assert.match(toast(bulk), /19 controls marked as applying, with the drafted reasons/);
  assert.equal(state('ai-annex-a-10-3').applicability, 'included');
  assert.match(state('ai-annex-a-10-3').inclusion_justification, /Writing assistant comes from a supplier/);
  assert.equal(state('ai-annex-a-7-2').applicability, 'excluded', 'an earlier exclusion stands');
  assert.equal(state('ai-annex-a-10-4').applicability, 'undecided', 'exclusions are accepted one at a time');
  assert.equal(state('ai-annex-a-6-2-2').applicability, 'undecided', 'questions stay open');
});

test('a role that changes after the decision shows where the SoA no longer agrees', async () => {
  const version = db.prepare('SELECT version FROM ai_systems WHERE id=?').get(systemId).version;
  await client.post(`${base()}/roles/${systemId}`, { version, ...answers({ role_trains: 'yes' }) });
  const p = P.forWorkspace(db, ws()).byId['ai-annex-a-7-2'];
  assert.equal(p.kind, 'include');
  assert.equal(P.compare(p, 'excluded'), 'contradicted');
  assert.equal(P.compare(P.forWorkspace(db, ws()).byId['ai-annex-a-10-4'], 'included'), 'wider');
  const design = P.forWorkspace(db, ws()).byId['ai-annex-a-6-1-2'];
  assert.equal(design.kind, 'review', 'connecting its own data does not make the organisation the designer of a bought system');
  assert.match(design.reason, /Writing assistant is trained, fine-tuned or connected to the organisation's own data, though not built by it/);

  const page = await client.get(`${base()}/soa`);
  assert.match(row(page.text, 'ai-annex-a-7-2'), /Excluded, but the roles say it applies[\s\S]*>Include it</);
  assert.match(page.text, /1 excluded control the roles now say apply/);
  await client.post(`${base()}/soa/ai-annex-a-7-2/accept-proposal`, {});
  assert.equal(state('ai-annex-a-7-2').applicability, 'included');
  assert.match(state('ai-annex-a-7-2').inclusion_justification, /trains, fine-tunes or connects its own data to Writing assistant/);
  assert.match(state('ai-annex-a-7-2').exclusion_justification, /No AI system in scope is trained/, 'the earlier exclusion reason is kept on its side');
});
