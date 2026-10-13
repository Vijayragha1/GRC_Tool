'use strict';
// Names set once per client fill the bracketed placeholders of adopted
// templates and of drafts; a document can be saved as a firm template with the
// client taken out, and it then appears in every client's template library.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, otherWsId, templateId, draftId, approvedId;
const content = (id) => db.prepare('SELECT content FROM generated_docs WHERE id=?').get(id).content;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const ws = (name) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome, encryption_enabled) VALUES (?, ?, '["iso42001"]', 'certification_support', 0)`)
    .run(actor.firm_id, name).lastInsertRowid);
  wsId = ws('Aurora Diagnostics');
  otherWsId = ws('Northwind Health');
  templateId = db.prepare(`SELECT id FROM doc_templates WHERE is_system=1 AND framework='iso42001' AND content LIKE '%[AIMS MANAGER]%' AND content LIKE '%[AI GOVERNANCE COMMITTEE]%' ORDER BY id LIMIT 1`).get().id;
  draftId = Number(db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, content, status, created_by) VALUES (?, 'AI Roles Draft', 'policy', 'Chaired by the [AI GOVERNANCE COMMITTEE].', 'draft', ?)`).run(wsId, actor.id).lastInsertRowid);
  approvedId = Number(db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, content, status, locked, created_by) VALUES (?, 'Approved Charter', 'policy', 'Chaired by the [AI GOVERNANCE COMMITTEE].', 'approved', 1, ?)`).run(wsId, actor.id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

test('values set for the client fill adopted templates and its drafts, never approved documents', async () => {
  let res = await client.post(`/workspaces/${wsId}/templates/values`, { framework: 'iso42001', aims_manager: 'Head of [AI]' });
  assert.match(decodeURIComponent(res.location), /cannot contain square brackets/);
  res = await client.post(`/workspaces/${wsId}/templates/values`, { framework: 'iso42001', aims_manager: 'Head of AI Governance', governance_committee: 'AI Risk Council', apply_to_drafts: '1' });
  assert.match(decodeURIComponent(res.location), /filled into 1 draft/);
  assert.equal(content(draftId), 'Chaired by the AI Risk Council.');
  assert.equal(content(approvedId), 'Chaired by the [AI GOVERNANCE COMMITTEE].', 'an approved document is not touched');

  res = await client.post(`/workspaces/${wsId}/templates/${templateId}/adopt`, {});
  assert.equal(res.status, 302);
  const docId = Number(res.location.match(/documents\/(\d+)/)[1]);
  const adopted = content(docId);
  assert.doesNotMatch(adopted, /\[AIMS MANAGER\]|\[AI GOVERNANCE COMMITTEE\]/);
  assert.match(adopted, /Head of AI Governance/);
  assert.match(adopted, /AI Risk Council/);

  const page = await client.get(`/workspaces/${wsId}/templates?framework=iso42001`);
  assert.match(page.text, /Names filled into the templates/);
  assert.match(page.text, /name="aims_manager" value="Head of AI Governance"/);
});

test('the role placeholder defaults from the register only when every system has the same single role', () => {
  const values = require('../lib/template-values');
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(otherWsId);
  const role = () => values.values(db, ws).find((f) => f.key === 'ai_roles').fromRecords;
  const add = (name, roles) => db.prepare(`INSERT INTO ai_systems (workspace_id, name, org_roles, lifecycle_stage, in_scope, created_by) VALUES (?, ?, ?, 'in_use', 1, ?)`)
    .run(otherWsId, name, JSON.stringify(roles), actor.id);
  assert.equal(role(), null);
  add('Chat assistant', ['customer']);
  add('Claims triage', ['customer']);
  assert.equal(role(), 'customer');
  add('Pricing model', ['producer']);
  assert.equal(role(), null, 'a mixed register is left for each system record');
});

test('a document saved as a firm template leaves the client behind and reaches the firm\'s other clients', async () => {
  db.prepare(`UPDATE generated_docs SET content='Aurora Diagnostics appoints the Head of AI Governance. Aurora Diagnostics reviews it yearly.' WHERE id=?`).run(draftId);
  let res = await client.post(`/workspaces/${wsId}/documents/${draftId}/save-as-firm-template`, { name: 'AI Roles and Responsibilities', description: 'Roles for an AIMS' });
  assert.match(decodeURIComponent(res.location), /Saved as the firm template "AI Roles and Responsibilities"/);
  const tpl = db.prepare(`SELECT * FROM doc_templates WHERE firm_id=? AND is_system=0 AND name='AI Roles and Responsibilities'`).get(actor.firm_id);
  assert.equal(tpl.content, '{{client_name}} appoints the [AIMS MANAGER]. {{client_name}} reviews it yearly.');
  res = await client.post(`/workspaces/${wsId}/documents/${draftId}/save-as-firm-template`, { name: 'AI Roles and Responsibilities' });
  assert.match(decodeURIComponent(res.location), /already has a template with that name/);

  const otherLibrary = await client.get(`/workspaces/${otherWsId}/templates?framework=iso42001`);
  assert.match(otherLibrary.text, /AI Roles and Responsibilities/);
  res = await client.post(`/workspaces/${otherWsId}/templates/${tpl.id}/adopt`, {});
  const copyId = Number(res.location.match(/documents\/(\d+)/)[1]);
  assert.match(content(copyId), /^Northwind Health appoints the \[AIMS MANAGER\]\./, 'the next client gets its own name, and its own values when set');

  const library = await client.get('/firm/library/templates');
  assert.equal(library.status, 200);
  assert.match(library.text, /AI Roles and Responsibilities/);
  res = await client.post(`/firm/library/templates/${tpl.id}/delete`, {});
  assert.match(decodeURIComponent(res.location), /Documents already made from it are unchanged/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM doc_templates WHERE id=?').get(tpl.id).c, 0);
  assert.equal(db.prepare('SELECT template_id FROM generated_docs WHERE id=?').get(copyId).template_id, null);
  assert.match(content(copyId), /Northwind Health appoints/);
});
