'use strict';
// ISO/IEC 42001 template pack: content rules, seeding, the framework-aware
// library, adoption with requirement links, and the one-step path from a
// certification request to a drafted document.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

const PACK = require('../data/policy-templates-iso42001');
const CATALOG = require('../data/iso42001-catalog');
const ISO27001_NAMES = new Set([
  'policy-templates', 'policy-templates-people-physical', 'policy-templates-technical',
  'policy-templates-organisational', 'policy-templates-forms-roles', 'policy-templates-bundles',
].flatMap(f => require(`../data/${f}`)).map(t => t.name));
const ALLOWED_TOKENS = new Set(['client_name', 'date', 'firm_name', 'document_owner', 'approval_authority', 'review_period', 'industry']);

test('every pack template is complete, mapped to real requirements and written to the house rules', () => {
  const ids = new Set(CATALOG.map(i => i.id));
  const names = new Set();
  assert.ok(PACK.length >= 30, `expected the full pack, got ${PACK.length}`);
  for (const t of PACK) {
    assert.ok(t.name && !names.has(t.name), `duplicate or missing name: ${t.name}`);
    names.add(t.name);
    assert.ok(!ISO27001_NAMES.has(t.name), `${t.name} collides with an ISO 27001 template; seeding is by name`);
    assert.ok(['policy', 'procedure', 'plan', 'record', 'form'].includes(t.category), `${t.name}: category ${t.category}`);
    assert.ok(['mandatory', 'expected', 'recommended'].includes(t.tier), `${t.name}: tier ${t.tier}`);
    assert.ok(t.description && t.description.length > 30, `${t.name}: description`);
    assert.ok(Array.isArray(t.requirement_refs) && t.requirement_refs.length, `${t.name}: requirement_refs`);
    for (const ref of t.requirement_refs) assert.ok(ids.has(ref), `${t.name}: ${ref} is not in the ISO 42001 catalogue`);
    assert.ok(t.content.startsWith(`# ${t.name}\n`), `${t.name}: content must open with its title`);
    assert.match(t.content, /\{\{document_owner\}\}/, `${t.name}: document control block`);
    assert.match(t.content, /Starting point\./, `${t.name}: starter note`);
    assert.ok(t.content.split('\n').length >= 30, `${t.name}: too short to be usable`);
    for (const [, token] of t.content.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(ALLOWED_TOKENS.has(token), `${t.name}: unknown placeholder {{${token}}}`);
    const text = `${t.name} ${t.description} ${t.content}`;
    assert.doesNotMatch(text, /[–—]/, `${t.name}: en or em dash`);
    assert.doesNotMatch(text, /\b(leverage|seamless|holistic|cutting-edge)\b/i, `${t.name}: banned wording`);
    assert.doesNotMatch(text, /\brobust\b/i, `${t.name}: "robust" (robustness as a model property is fine)`);
  }
});

test('the pack covers every clause and Annex A control, with a required document for each mandatory clause', () => {
  const covered = new Set(PACK.flatMap(t => t.requirement_refs));
  const missing = CATALOG.map(i => i.id).filter(id => !covered.has(id));
  assert.deepEqual(missing, [], `no template covers: ${missing.join(', ')}`);
  const mandatory = new Set(PACK.filter(t => t.tier === 'mandatory').flatMap(t => t.requirement_refs));
  for (const clause of ['4.3', '5.2', '5.3', '6.1.2', '6.1.3', '6.1.4', '6.2', '7.2', '7.5', '8.4', '9.2', '9.3', '10.2']) {
    assert.ok(mandatory.has(`ai-clause-${clause}`), `clause ${clause} needs a mandatory template`);
  }
});

let env, db, client, actor;
const ws = (name, frameworks, outcome) => Number(db.prepare('INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, ?)')
  .run(actor.firm_id, name, JSON.stringify(frameworks), outcome || 'certification_support').lastInsertRowid);
const tpl = name => db.prepare('SELECT * FROM doc_templates WHERE name=? AND is_system=1').get(name);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
});
test.after(async () => { db?.close(); await client?.close(); });

test('boot seeds the pack with explicit framework, tier and requirement mapping, leaving ISO 27001 templates alone', () => {
  const rows = db.prepare("SELECT * FROM doc_templates WHERE is_system=1 AND framework='iso42001'").all();
  assert.equal(rows.length, PACK.length);
  const policy = tpl('AI Policy');
  assert.equal(policy.tier, 'mandatory');
  assert.deepEqual(JSON.parse(policy.requirement_refs).sort(), ['ai-annex-a-2-2', 'ai-annex-a-2-3', 'ai-annex-a-2-4', 'ai-clause-5.2']);
  assert.equal(policy.controls, '[]', 'the ISO 27001 description parser must not map an ISO 42001 template');
  assert.equal(policy.clauses, '[]');
  // ISO 27001 templates keep their default framework and carry no ISO 42001
  // mapping. (Their tier and control columns are owned by the ISO 27001
  // tagging in db.js and are not asserted here.)
  const isms = tpl('Information Security Policy');
  assert.equal(isms.framework || 'iso27001', 'iso27001');
  assert.equal(isms.requirement_refs, null);
});

test('the library shows the pack for the programme the client runs', async () => {
  const aiOnly = ws('Library AI client', ['iso42001']);
  const both = ws('Library dual client', ['iso27001', 'iso42001'], 'certification_support');
  const isoOnly = ws('Library ISMS client', ['iso27001'], 'certification_support');

  const ai = await client.get(`/workspaces/${aiOnly}/templates`);
  assert.equal(ai.status, 200);
  assert.match(ai.text, /AI Policy/);
  assert.match(ai.text, /ISO\/IEC 42001 AI management system templates/);
  assert.doesNotMatch(ai.text, />Information Security Policy</, 'a 42001-only client is not offered ISO 27001 policies');
  assert.match(ai.text, /tpl-card-control">A\.2\.2</, 'cards show ISO 42001 control codes');

  const dual = await client.get(`/workspaces/${both}/templates`);
  assert.match(dual.text, /aria-label="Template pack"/);
  assert.match(dual.text, />Information Security Policy</);
  assert.doesNotMatch(dual.text, />AI Policy</);
  const dualAi = await client.get(`/workspaces/${both}/templates?framework=iso42001`);
  assert.match(dualAi.text, />AI Policy</);

  const isms = await client.get(`/workspaces/${isoOnly}/templates?framework=iso42001`);
  assert.doesNotMatch(isms.text, />AI Policy</, 'a framework the client does not run is not reachable by query string');

  const detail = await client.get(`/workspaces/${aiOnly}/templates/${tpl('AI Policy').id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /ISO 42001 requirements/);
  assert.match(detail.text, /AIMS Manager/, 'the preview names the AIMS owner, not the CISO');
});

test('adopting a pack template links ISO 42001 requirements, and bulk adoption stays inside the programme', async () => {
  const aiOnly = ws('Adoption AI client', ['iso42001']);
  const adopted = await client.post(`/workspaces/${aiOnly}/templates/${tpl('AI Policy').id}/adopt`, {});
  assert.equal(adopted.status, 302);
  const doc = db.prepare('SELECT * FROM generated_docs WHERE workspace_id=? AND template_id=?').get(aiOnly, tpl('AI Policy').id);
  assert.ok(doc);
  const links = db.prepare(`SELECT f.code, rq.ref FROM document_requirement_links l JOIN requirements rq ON rq.id=l.requirement_id
    JOIN frameworks f ON f.id=rq.framework_id WHERE l.document_id=? ORDER BY rq.ref`).all(doc.id);
  assert.deepEqual(links.map(l => `${l.code}:${l.ref}`), ['iso42001:ai-annex-a-2-2', 'iso42001:ai-annex-a-2-3', 'iso42001:ai-annex-a-2-4', 'iso42001:ai-clause-5.2']);

  await client.post(`/workspaces/${aiOnly}/templates/adopt-mandatory?framework=iso42001`, {});
  const adoptedIds = db.prepare('SELECT DISTINCT template_id FROM generated_docs WHERE workspace_id=?').all(aiOnly).map(r => r.template_id);
  const frameworks = new Set(adoptedIds.map(id => db.prepare('SELECT framework FROM doc_templates WHERE id=?').get(id).framework));
  assert.deepEqual([...frameworks], ['iso42001']);
  assert.equal(adoptedIds.length, PACK.filter(t => t.tier === 'mandatory').length, 'every mandatory pack template, once');

  const isoOnly = ws('Adoption ISMS client', ['iso27001'], 'certification_support');
  await client.post(`/workspaces/${isoOnly}/templates/adopt-mandatory`, {});
  const leaked = db.prepare(`SELECT COUNT(*) c FROM generated_docs d JOIN doc_templates t ON t.id=d.template_id
    WHERE d.workspace_id=? AND t.framework='iso42001'`).get(isoOnly).c;
  assert.equal(leaked, 0, 'an ISO 27001 client never receives ISO 42001 documents in a bulk adoption');
});

test('a certification request drafts its document from the matching template in one step, and reuses it after', async () => {
  const aiOnly = ws('Request template client', ['iso42001']);
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(aiOnly);
  const audit = require('../lib/iso42001-audit');
  const add = (ref, reqs) => audit.addManualRequest(db, workspace, actor.id, { ref, description: `Provide the AI policy (${ref})`, stage: 'stage1', requirements: reqs });
  const first = add('R-1', '5.2');
  const second = add('R-2', 'A.2.4');

  const overview = await client.get(`/workspaces/${aiOnly}/iso42001/overview`);
  assert.match(overview.text, /0 of \d+<\/strong> documents the standard requires are drafted/);

  const page = await client.get(`/workspaces/${aiOnly}/iso42001/requests/${first}`);
  assert.match(page.text, /Templates for this request/);
  assert.match(page.text, /AI Policy/);
  assert.match(page.text, /Draft from template/);

  const drafted = await client.post(`/workspaces/${aiOnly}/iso42001/requests/${first}/from-template`, { template_id: tpl('AI Policy').id });
  assert.match(decodeURIComponent(drafted.location), /AI Policy drafted from the template and linked/);
  const docs = db.prepare('SELECT id FROM generated_docs WHERE workspace_id=? AND template_id=?').all(aiOnly, tpl('AI Policy').id);
  assert.equal(docs.length, 1);
  const linked = db.prepare("SELECT record_id FROM aims_request_records WHERE request_id=? AND record_type='document'").get(first);
  assert.equal(linked.record_id, docs[0].id);

  const again = await client.post(`/workspaces/${aiOnly}/iso42001/requests/${second}/from-template`, { template_id: tpl('AI Policy').id });
  assert.match(decodeURIComponent(again.location), /The existing AI Policy is linked/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND template_id=?').get(aiOnly, tpl('AI Policy').id).c, 1, 'no second draft');
  const unrelated = await client.post(`/workspaces/${aiOnly}/iso42001/requests/${second}/from-template`, { template_id: tpl('AI Event Logging Standard').id });
  assert.match(decodeURIComponent(unrelated.location), /does not cover this request/);

  const after = await client.get(`/workspaces/${aiOnly}/iso42001/overview`);
  assert.match(after.text, /1 of \d+<\/strong> documents the standard requires are drafted/);

  const gapOnly = ws('Gap-only dual client', ['iso27001', 'iso42001'], 'gap_assessment_only');
  const gapWs = db.prepare('SELECT * FROM workspaces WHERE id=?').get(gapOnly);
  const gapReq = audit.addManualRequest(db, gapWs, actor.id, { ref: 'R-9', description: 'AI policy', stage: 'stage1', requirements: '5.2' });
  const refused = await client.post(`/workspaces/${gapOnly}/iso42001/requests/${gapReq}/from-template`, { template_id: tpl('AI Policy').id });
  assert.match(decodeURIComponent(refused.location), /outside this gap-assessment-only engagement/);
});
