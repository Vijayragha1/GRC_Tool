'use strict';
// The records an ISO 42001 auditor samples: context and interested parties,
// impact assessments with societal impact and review triggers, AI measures,
// objectives with their plan, competence evidence, document retention, policy
// acknowledgements and sealed audit rounds.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

let env, client, db, actor, wsId, systemId;
const base = () => `/workspaces/${wsId}/iso42001`;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id, name FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Triage assistant', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

test('context issues and interested parties are kept as records, with obligations marked', async () => {
  const { shared } = require('../routes/iso42001');
  const flagged = () => shared.computeIso42001Readiness(wsId).flags.some((f) => f.kind === 'context_missing');
  assert.equal(flagged(), true);
  await client.post(`${base()}/context/issues`, { kind: 'external', issue: 'Customers ask for AI governance evidence in tenders', response: 'Certify the AIMS', next_review: '2027-01-01' });
  await client.post(`${base()}/context/issues`, { kind: 'sideways', issue: 'Not a real kind' });
  await client.post(`${base()}/context/parties`, { party: 'Patients triaged by the assistant', party_type: 'affected', needs: 'Fair and explainable triage', requirement_kind: 'regulatory', how_addressed: 'Impact assessment and clinician review' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM context_issues WHERE workspace_id=?').get(wsId).c, 1, 'an issue needs a real kind');
  assert.equal(db.prepare('SELECT requirement_kind FROM interested_parties WHERE workspace_id=?').get(wsId).requirement_kind, 'regulatory');
  const page = await client.get(`${base()}/context`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Patients triaged by the assistant/);
  assert.match(page.text, /<span>Obligations<\/span><strong>1<\/strong>/, 'one obligation is counted');
  assert.equal(flagged(), false);
});

test('an impact assessment records societal impact and harm ratings, and no editor can approve it', () => {
  const registry = require('../lib/ai-systems');
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const iaId = registry.startAssessment(db, ws, actor.id, systemId);
  const ia = () => db.prepare('SELECT * FROM ai_impact_assessments WHERE id=?').get(iaId);
  const base = { affected_parties: 'Patients', potential_harms: 'Missed urgent case', mitigations: 'Clinician review', residual_level: 'medium', decision: 'proceed' };
  const editor = Number(db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES ('editor@firm.example', '!noauth', 'Editor', ?, 'firm', 'consultant', 1)`).run(actor.firm_id).lastInsertRowid);
  const reviewer = Number(db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES ('reviewer@firm.example', '!noauth', 'Reviewer', ?, 'firm', 'manager', 1)`).run(actor.firm_id).lastInsertRowid);
  registry.saveAssessment(db, ws, editor, systemId, iaId, { ...base, version: ia().version });
  assert.throws(() => registry.approveAssessment(db, ws, reviewer, systemId, iaId, { version: ia().version }), /impact on society, how severe and likely/);
  registry.saveAssessment(db, ws, editor, systemId, iaId, { ...base, societal_impacts: 'Trust in automated triage', harm_severity: 4, harm_likelihood: 2, version: ia().version });
  assert.throws(() => registry.approveAssessment(db, ws, reviewer, systemId, iaId, { version: ia().version }), /deployed, the jurisdictions/);
  registry.saveAssessment(db, ws, editor, systemId, iaId, { ...base, societal_impacts: 'Trust in automated triage', harm_severity: 4, harm_likelihood: 2,
    deployment_context: 'Hospital emergency department, on the triage nurse workstation', jurisdictions: 'India: DPDP Act 2023', retention_period: 'Six years', version: ia().version });
  assert.throws(() => registry.approveAssessment(db, ws, actor.id, systemId, iaId, { version: ia().version }), /prepared or edited/, 'the person who started it edited it');
  assert.throws(() => registry.approveAssessment(db, ws, editor, systemId, iaId, { version: ia().version }), /prepared or edited/);
  registry.approveAssessment(db, ws, reviewer, systemId, iaId, { version: ia().version });
  assert.equal(ia().status, 'approved');
  assert.equal(ia().harm_severity, 4);
  assert.ok(ia().next_review_date >= new Date().toISOString().slice(0, 10));
  assert.throws(() => db.prepare('UPDATE ai_impact_assessments SET harm_severity=1 WHERE id=?').run(iaId), /frozen/);
  assert.equal(registry.reassessment(db, ws, systemId).state, 'current');

  const change = Number(db.prepare(`INSERT INTO changes (workspace_id, title, created_by, created_at) VALUES (?, 'Retrain on 2026 data', ?, datetime('now','+1 minute'))`).run(wsId, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO ai_system_links (ai_system_id, workspace_id, link_type, target_id, linked_by) VALUES (?, ?, 'change', ?, ?)`).run(systemId, wsId, change, actor.id);
  const due = registry.reassessment(db, ws, systemId);
  assert.equal(due.state, 'due');
  assert.match(due.reason, /Retrain on 2026 data/);
});

test('the AI system page says when the impact assessment is overtaken by a change', async () => {
  const page = await client.get(`${base()}/ai-systems/${systemId}`);
  assert.match(page.text, /Reassessment due\./);
  const { shared } = require('../routes/iso42001');
  assert.ok(shared.computeIso42001Readiness(wsId).flags.some((f) => f.kind === 'reassessment_due'));
});

test('AI measures can be adopted and the consultant can define their own', async () => {
  const lib = await client.get(`/workspaces/${wsId}/metrics/library`);
  assert.match(lib.text, /Model performance drift/);
  assert.match(lib.text, /Define a measure of your own/);
  await client.post(`/workspaces/${wsId}/metrics/library`, { pick: ['aims-drift', 'aims-override-rate'] });
  const adopted = db.prepare('SELECT metric_key, framework FROM isms_metrics WHERE workspace_id=? ORDER BY metric_key').all(wsId);
  assert.deepEqual(adopted, [{ metric_key: 'aims-drift', framework: 'iso42001' }, { metric_key: 'aims-override-rate', framework: 'iso42001' }]);
  const custom = await client.post(`/workspaces/${wsId}/metrics/custom`, { name: 'Recall on urgent cases', unit: '%', direction: 'higher', target_value: '95', ai_system_id: systemId });
  assert.equal(custom.status, 302);
  const m = db.prepare(`SELECT * FROM isms_metrics WHERE workspace_id=? AND name='Recall on urgent cases'`).get(wsId);
  assert.equal(m.ai_system_id, systemId);
  assert.equal(m.framework, 'iso42001');
  assert.equal(m.target_value, 95);
});

test('an objective carries the plan behind it, and readiness counts it only then', async () => {
  const { shared } = require('../routes/iso42001');
  const objective = () => shared.computeIso42001Readiness(wsId).records.mandatory.checks.find((c) => c.clause === '6.2');
  await client.post(`/workspaces/${wsId}/objectives`, { title: 'Keep triage drift under 5%' });
  assert.equal(objective().found, false, 'an objective with no plan is not counted');
  const id = db.prepare('SELECT id FROM security_objectives WHERE workspace_id=?').get(wsId).id;
  await client.post(`/workspaces/${wsId}/objectives/${id}`, { title: 'Keep triage drift under 5%', plan_actions: 'Monthly drift check with rollback', resources: 'ML lead, 2 days a month', evaluation_method: 'Reviewed at each management review', communicated_on: '2026-10-01' });
  const row = db.prepare('SELECT * FROM security_objectives WHERE id=?').get(id);
  assert.equal(row.plan_actions, 'Monthly drift check with rollback');
  assert.equal(row.framework, 'iso42001');
  assert.equal(row.communicated_on, '2026-10-01');
  assert.equal(objective().found, true);
});

test('competence points at the evidence file, and a document records how long it is kept', async () => {
  const ev = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, uploaded_by) VALUES (?, 'ml-cert.pdf', 'fixture-cert', ?, ?)`).run(wsId, crypto.createHash('sha256').update('c').digest('hex'), actor.id).lastInsertRowid);
  const role = Number(db.prepare(`INSERT INTO competence_roles (workspace_id, name) VALUES (?, 'ML engineer')`).run(wsId).lastInsertRowid);
  await client.post(`/workspaces/${wsId}/competence/records`, { role_id: role, person_name: 'Priya Nair', competence: 'Model validation', evidence_id: ev });
  assert.equal(db.prepare('SELECT evidence_id FROM competence_records WHERE workspace_id=?').get(wsId).evidence_id, ev);
  const page = await client.get(`/workspaces/${wsId}/competence`);
  assert.match(page.text, /ml-cert\.pdf/);

  const doc = Number(db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, content, status, created_by) VALUES (?, 'AI Policy', 'policy', 'x', 'published', ?)`).run(wsId, actor.id).lastInsertRowid);
  await client.post(`/workspaces/${wsId}/documents/${doc}/retention`, { retention_period: '3 years after it is superseded' });
  assert.equal(db.prepare('SELECT retention_period FROM generated_docs WHERE id=?').get(doc).retention_period, '3 years after it is superseded');
});

test('people acknowledge a published document through links of their own', async () => {
  const doc = Number(db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, content, status, created_by) VALUES (?, 'Acceptable Use of AI', 'policy', '<p>Use approved tools only.</p>', 'published', ?)`).run(wsId, actor.id).lastInsertRowid);
  const early = await client.post(`/workspaces/${wsId}/documents/${doc}/acknowledgements`, { recipients: 'Maya Iyer <maya@aurora.example>' });
  assert.match(decodeURIComponent(early.location), /Publish the document/);
  db.prepare(`INSERT INTO doc_versions (workspace_id, document_id, version, name, content, content_hash, status, created_by) VALUES (?, ?, 1, 'Acceptable Use of AI', '<p>Use approved tools only.</p>', 'h', 'published', ?)`).run(wsId, doc, actor.id);

  const made = await client.post(`/workspaces/${wsId}/documents/${doc}/acknowledgements`, { recipients: 'Maya Iyer <maya@aurora.example>\nTom Reyes, tom@aurora.example', due_date: '2026-11-01' });
  assert.equal(made.status, 302);
  const page = await client.get(`/workspaces/${wsId}/documents/${doc}/acknowledgements`);
  const links = [...page.text.matchAll(/value="(https?:\/\/[^"]+\/ack\/([a-f0-9]{64}))"/g)].map((m) => m[2]);
  assert.equal(links.length, 2, 'both links are shown once');
  assert.doesNotMatch((await client.get(`/workspaces/${wsId}/documents/${doc}/acknowledgements`)).text, /\/ack\/[a-f0-9]{64}/, 'and not again');
  const stored = db.prepare('SELECT token FROM doc_ack_recipients').all().map((r) => r.token);
  assert.ok(!stored.includes(links[0]), 'only the hash of a link is stored');

  const visitor = makeClient(env.app);
  const open = await visitor.get(`/ack/${links[0]}`);
  assert.equal(open.status, 200);
  assert.match(open.text, /Use approved tools only\./);
  assert.match(open.text, /I, Maya Iyer, have read and understood this document/);
  const ack = await visitor.post(`/ack/${links[0]}`, {}, { csrf: false });
  assert.equal(ack.status, 302);
  assert.match((await visitor.get(`/ack/${links[0]}`)).text, /Thank you, Maya Iyer/);
  await visitor.close();

  const tom = db.prepare("SELECT id FROM doc_ack_recipients WHERE recipient_name='Tom Reyes'").get().id;
  await client.post(`/workspaces/${wsId}/documents/${doc}/acknowledgements/recipients/${tom}/reissue`, {});
  assert.equal((await makeClient(env.app).get(`/ack/${links[1]}`)).status, 404, 'a reissued link retires the old one');
  const status = await client.get(`/workspaces/${wsId}/documents/${doc}/acknowledgements`);
  assert.match(status.text, /1 of 2 acknowledged/);
});

test("an audit's requests are sealed as a round and the tracker resets for the next audit", async () => {
  const audit = require('../lib/iso42001-audit');
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  audit.applyStandardChecklist(db, ws, actor.id);
  const req1 = db.prepare(`SELECT id FROM aims_audit_requests WHERE workspace_id=? ORDER BY id LIMIT 1`).get(wsId).id;
  const ev = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, uploaded_by) VALUES (?, 'scope-v1.pdf', 'fixture-scope', ?, ?)`).run(wsId, crypto.createHash('sha256').update('s').digest('hex'), actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO aims_request_records (request_id, workspace_id, record_type, record_id, linked_by) VALUES (?, ?, 'evidence', ?, ?)`).run(req1, wsId, ev, actor.id);
  db.prepare(`UPDATE aims_audit_requests SET status='accepted' WHERE id=?`).run(req1);
  await client.post(`${base()}/cert-cycle/seed`, {});
  const stage2 = db.prepare(`SELECT id FROM iso42001_cert_cycle_events WHERE workspace_id=? AND event_key='stage2'`).get(wsId).id;

  const res = await client.post(`${base()}/requests/rounds`, { cycle_event_id: stage2, label: 'Initial certification 2027' });
  assert.equal(res.status, 302);
  const round = db.prepare('SELECT * FROM aims_audit_rounds WHERE workspace_id=?').get(wsId);
  assert.equal(round.accepted_count, 1);
  assert.equal(round.cycle_event_id, stage2);
  const sealed = JSON.parse(round.payload);
  assert.equal(sealed.find((r) => r.status === 'accepted').records[0].label, 'scope-v1.pdf');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM aims_audit_requests WHERE workspace_id=? AND status != 'not_started' AND withdrawn_at IS NULL`).get(wsId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM aims_request_records WHERE workspace_id=?').get(wsId).c, 0);
  assert.throws(() => db.prepare('UPDATE aims_audit_rounds SET label=? WHERE id=?').run('x', round.id), /cannot be changed/);
  const view = await client.get(`${base()}/requests/rounds/${round.id}`);
  assert.match(view.text, /Initial certification 2027/);
  assert.match(view.text, /scope-v1\.pdf/);
});
