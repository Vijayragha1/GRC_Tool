'use strict';
// The screens every framework shares work for a client whose programme is
// ISO 42001: internal audit findings, samples and checklists, and
// nonconformities, name ISO 42001 clauses and controls.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsAi, wsBoth, auditId;

const mkWs = (name, frameworks) => Number(db.prepare('INSERT INTO workspaces (firm_id, client_name, frameworks) VALUES (?, ?, ?)')
  .run(actor.firm_id, name, JSON.stringify(frameworks)).lastInsertRowid);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsAi = mkWs('Aurora Diagnostics', ['iso42001']);
  wsBoth = mkWs('Borealis Logistics', ['iso27001', 'iso42001']);
  const created = await client.post(`/workspaces/${wsAi}/audits`, { title: '2026 AIMS internal audit', audit_date: '2026-10-01' });
  assert.equal(created.status, 302);
  auditId = db.prepare('SELECT id FROM audits WHERE workspace_id=?').get(wsAi).id;
});
test.after(async () => { db?.close(); await client?.close(); });

test('an ISO 42001 audit offers ISO 42001 requirements, not the ISO 27001 catalogue', async () => {
  const page = await client.get(`/workspaces/${wsAi}/audits/${auditId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<option value="ai-annex-a-6-2-4"[^>]*>A\.6\.2\.4 AI system verification and validation<\/option>/);
  assert.match(page.text, /<option value="ai-clause-9\.2"/);
  assert.doesNotMatch(page.text, /value="annex-a\.5\.1"/, 'ISO 27001 controls are not offered to an ISO 42001 client');
  assert.match(page.text, /value="iso42001:e-lifecycle"/, 'checklist sections are the ISO 42001 ones');
  assert.doesNotMatch(page.text, /By Annex A section/);
});

test('findings and samples keep an ISO 42001 requirement and drop one from a framework the client does not use', async () => {
  const base = `/workspaces/${wsAi}/audits/${auditId}`;
  await client.post(`${base}/findings`, { iso_item_id: 'ai-annex-a-6-2-4', finding_type: 'minor_nc', description: 'Release 3.2 went live without recorded validation results.', severity: 'medium' });
  await client.post(`${base}/findings`, { iso_item_id: 'annex-a.5.1', finding_type: 'observation', description: 'Policy review date passed.', severity: 'low' });
  const rows = db.prepare('SELECT iso_item_id, description FROM audit_findings WHERE audit_id=? ORDER BY id').all(auditId);
  assert.equal(rows[0].iso_item_id, 'ai-annex-a-6-2-4');
  assert.equal(rows[1].iso_item_id, null, 'an ISO 27001 control is not stored against an ISO 42001-only client');

  const sample = await client.post(`${base}/samples`, { iso_item_id: 'ai-annex-a-7-5', description: '3 of 11 training datasets', population_size: 11, sample_size: 3 });
  assert.equal(sample.status, 302, 'a sample can name an ISO 42001 control now the ISO 27001-only key is gone');
  assert.equal(db.prepare('SELECT iso_item_id FROM audit_samples WHERE audit_id=?').get(auditId).iso_item_id, 'ai-annex-a-7-5');

  const page = await client.get(base);
  assert.match(page.text, /A\.6\.2\.4 AI system verification and validation/);
  assert.match(page.text, /A\.7\.5 Data provenance/);
});

test('checklists are generated from the ISO 42001 SoA and its sections', async () => {
  for (const id of ['ai-annex-a-5-2', 'ai-annex-a-7-4']) {
    await client.post(`/workspaces/${wsAi}/iso42001/soa/${id}?ajax=1`, { applicability: 'included', status: 'Implemented', justification: 'In scope for the triage model.' });
  }
  const base = `/workspaces/${wsAi}/audits/${auditId}`;
  assert.equal((await client.post(`${base}/checklist-from-soa`, {})).status, 302);
  const fromSoa = db.prepare('SELECT iso_item_id, description FROM audit_observations WHERE audit_id=? ORDER BY id').all(auditId);
  assert.deepEqual(fromSoa.map((r) => r.iso_item_id), ['ai-annex-a-5-2', 'ai-annex-a-7-4']);
  assert.match(fromSoa[0].description, /^A\.5\.2 - AI system impact assessment process/);
  assert.match(fromSoa[0].description, /impact assessment before go-live/, 'the sample hint is the ISO 42001 one');

  await client.post(`${base}/checklist`, { category: 'iso42001:e-lifecycle' });
  const lifecycle = db.prepare("SELECT COUNT(*) c FROM audit_observations WHERE audit_id=? AND iso_item_id LIKE 'ai-annex-a-6-%'").get(auditId).c;
  assert.equal(lifecycle, 9, 'every A.6 control is added');
  const before = db.prepare('SELECT COUNT(*) c FROM audit_observations WHERE audit_id=?').get(auditId).c;
  await client.post(`${base}/checklist`, { category: 'org' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_observations WHERE audit_id=?').get(auditId).c, before, 'an ISO 27001 section is refused');
});

test('a nonconformity can be tied to an ISO 42001 control, shown by name, and closed', async () => {
  const created = await client.post(`/workspaces/${wsAi}/nonconformities`, { title: 'Validation not recorded', severity: 'minor', source: 'internal_audit', iso_item_id: 'ai-annex-a-6-2-4' });
  assert.equal(created.status, 302);
  const nc = db.prepare('SELECT * FROM nonconformities WHERE workspace_id=?').get(wsAi);
  assert.equal(nc.iso_item_id, 'ai-annex-a-6-2-4');

  const list = await client.get(`/workspaces/${wsAi}/nonconformities`);
  assert.match(list.text, /A\.6\.2\.4 AI system verification and validation/);
  const detail = await client.get(`/workspaces/${wsAi}/nonconformities/${nc.id}`);
  assert.match(detail.text, /<option value="ai-annex-a-6-2-4" selected>/);

  const closed = await client.post(`/workspaces/${wsAi}/nonconformities/${nc.id}`, { status: 'closed', root_cause: 'No release gate', corrective_action: 'Added a validation sign-off step', effectiveness_check: 'Two releases checked' });
  assert.equal(closed.status, 302, 'closing an ISO 42001 nonconformity no longer falls into the dropped legacy table');
  const verified = db.prepare(`SELECT ci.last_verified_at FROM control_instances ci JOIN requirements rq ON rq.id=ci.requirement_id
    WHERE ci.workspace_id=? AND rq.ref='ai-annex-a-6-2-4' AND ci.entity_id IS NULL`).get(wsAi);
  assert.ok(verified && verified.last_verified_at, 'the ISO 42001 control is marked verified');
});

test('a client working to both standards sees both catalogues, grouped and named', async () => {
  const created = await client.post(`/workspaces/${wsBoth}/audits`, { title: 'Integrated internal audit' });
  assert.equal(created.status, 302);
  const id = db.prepare('SELECT id FROM audits WHERE workspace_id=?').get(wsBoth).id;
  const page = await client.get(`/workspaces/${wsBoth}/audits/${id}`);
  assert.match(page.text, /<optgroup label="ISO 27001">/);
  assert.match(page.text, /<optgroup label="ISO 42001">/);
  await client.post(`/workspaces/${wsBoth}/audits/${id}/findings`, { iso_item_id: 'ai-clause-4.1', finding_type: 'observation', description: 'Context review is overdue.' });
  const again = await client.get(`/workspaces/${wsBoth}/audits/${id}`);
  assert.match(again.text, /ISO 42001 4\.1 Understanding the organization and its context/, 'clause 4.1 is named with its standard');
});

test('a risk is linked to ISO 42001 controls from the risk page and the library, and the SoA includes them', async () => {
  const riskId = Number(db.prepare(`INSERT INTO risks (workspace_id, title, likelihood, impact, status) VALUES (?, 'Triage model drifts after retraining', 3, 4, 'open')`).run(wsAi).lastInsertRowid);
  const page = await client.get(`/workspaces/${wsAi}/risks/${riskId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<option value="ai-annex-a-6-2-6"/);
  assert.doesNotMatch(page.text, /value="annex-a\.8\.16"/);
  await client.post(`/workspaces/${wsAi}/risks/${riskId}/link`, { iso_item_id: 'ai-annex-a-6-2-6' });
  await client.post(`/workspaces/${wsAi}/risks/${riskId}/link`, { iso_item_id: 'annex-a.8.16' });
  assert.deepEqual(db.prepare('SELECT iso_item_id FROM iso42001_risk_controls WHERE risk_id=?').all(riskId).map((r) => r.iso_item_id), ['ai-annex-a-6-2-6']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM risk_controls WHERE risk_id=?').get(riskId).c, 0, 'no ISO 27001 link for an ISO 42001-only client');
  const state = db.prepare(`SELECT applicability FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id='ai-annex-a-6-2-6'`).get(wsAi);
  assert.equal(state.applicability, 'included', 'the control a risk depends on is included on the ISO 42001 SoA');
  const shown = await client.get(`/workspaces/${wsAi}/risks/${riskId}`);
  assert.match(shown.text, /href="\/workspaces\/\d+\/iso42001\/gap\/ai-annex-a-6-2-6"/);
  await client.post(`/workspaces/${wsAi}/risks/${riskId}/unlink`, { iso_item_id: 'ai-annex-a-6-2-6' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_risk_controls WHERE risk_id=?').get(riskId).c, 0);

  const library = require('../data/risk-library');
  const idx = library.findIndex((r) => r.title.startsWith('Prompt injection'));
  await client.post(`/workspaces/${wsAi}/risks/library`, { pick: [String(idx)] });
  const added = db.prepare(`SELECT id FROM risks WHERE workspace_id=? AND title LIKE 'Prompt injection%'`).get(wsAi);
  assert.deepEqual(db.prepare('SELECT iso_item_id FROM iso42001_risk_controls WHERE risk_id=? ORDER BY iso_item_id').all(added.id).map((r) => r.iso_item_id),
    ['ai-annex-a-6-2-4', 'ai-annex-a-6-2-6', 'ai-annex-a-6-2-8']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM risk_controls WHERE risk_id=?').get(added.id).c, 0);

  const treatments = await client.get(`/workspaces/${wsAi}/risks/${riskId}/treatments`);
  assert.match(treatments.text, /<option value="ai-annex-a-6-2-4"/);
  await client.post(`/workspaces/${wsAi}/risks/${riskId}/treatments`, { title: 'Add drift alerts', iso_item_id: 'ai-annex-a-6-2-6' });
  assert.equal(db.prepare('SELECT iso_item_id FROM risk_treatments WHERE risk_id=?').get(riskId).iso_item_id, 'ai-annex-a-6-2-6');
});

test("the management review pack takes the client's AI records and names the AIMS", async () => {
  const sys = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Triage assistant', 'in_use', 1, ?)`).run(wsAi, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Claims summariser', 'in_development', 1, ?)`).run(wsAi, actor.id);
  db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, approved_at) VALUES (?, ?, 1, 'approved', datetime('now'))`).run(wsAi, sys);
  const inc = Number(db.prepare(`INSERT INTO incidents (workspace_id, title, status) VALUES (?, 'Wrong triage priority', 'open')`).run(wsAi).lastInsertRowid);
  db.prepare(`INSERT INTO ai_system_links (ai_system_id, workspace_id, link_type, target_id, linked_by) VALUES (?, ?, 'incident', ?, ?)`).run(sys, wsAi, inc, actor.id);

  const preview = await client.get(`/workspaces/${wsAi}/mrms`);
  assert.equal(preview.status, 200);
  await client.post(`/workspaces/${wsAi}/mrms`, { meeting_date: '2026-11-15', attendees: 'CEO, CTO, AI lead' });
  const mrm = db.prepare('SELECT * FROM mrms WHERE workspace_id=?').get(wsAi);
  assert.match(mrm.context_changes, /AI systems in scope: 2 \(1 in use, 1 planned or in development, 0 retired\)/);
  assert.match(mrm.context_changes, /relevant to the AIMS/);
  assert.doesNotMatch(mrm.context_changes, /ISMS/);
  assert.match(mrm.performance_review, /Impact assessments: 1 in-scope system has an approved assessment, 1 does not/);
  assert.match(mrm.performance_review, /Incidents involving an AI system in the last 12 months: 1 \(1 still open\)/);
  assert.match(mrm.performance_review, /Nonconformities against ISO 42001 requirements: 0 open/);
  assert.match(mrm.risk_treatment_status, /Open risks treated by ISO 42001 controls: 1/);

  const both = await client.post(`/workspaces/${wsBoth}/mrms`, { meeting_date: '2026-11-20' });
  assert.equal(both.status, 302);
  assert.match(db.prepare('SELECT context_changes FROM mrms WHERE workspace_id=?').get(wsBoth).context_changes, /relevant to the ISMS and AIMS/);
});

test('documents, evidence coverage and search cover the ISO 42001 catalogue', async () => {
  const docId = Number(db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, content, status, created_by) VALUES (?, 'AI Policy', 'policy', '<p>Policy</p>', 'draft', ?)`).run(wsAi, actor.id).lastInsertRowid);
  const page = await client.get(`/workspaces/${wsAi}/documents/${docId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-value="ai-annex-a-2-2"/);
  assert.doesNotMatch(page.text, /data-value="annex-a\.5\.1"/);
  await client.post(`/workspaces/${wsAi}/documents/${docId}/controls`, { iso_item_id: 'ai-annex-a-2-2' });
  await client.post(`/workspaces/${wsAi}/documents/${docId}/controls`, { iso_item_id: 'annex-a.5.1' });
  const links = db.prepare(`SELECT rq.ref FROM document_requirement_links drl JOIN requirements rq ON rq.id=drl.requirement_id WHERE drl.document_id=?`).all(docId).map((r) => r.ref);
  assert.deepEqual(links, ['ai-annex-a-2-2']);
  assert.match((await client.get(`/workspaces/${wsAi}/documents/${docId}`)).text, /<code class="text-sm">A\.2\.2<\/code>/);

  const coverage = await client.get(`/workspaces/${wsAi}/evidence-coverage?filter=all`);
  assert.equal(coverage.status, 200);
  assert.match(coverage.text, /href="\/workspaces\/\d+\/iso42001\/gap\/ai-annex-a-7-5"/);
  assert.doesNotMatch(coverage.text, /controls\/assess\/annex-a\.5\.1"/);
  const csv = await client.get(`/workspaces/${wsAi}/evidence-coverage.csv`);
  assert.match(csv.text, /^Framework,Code,Title/);
  assert.match(csv.text, /"ISO 42001","A\.7\.5","A\.7\.5 Data provenance"/);
});

test('search finds ISO 42001 controls for an ISO 42001 client and opens them on the programme', async () => {
  const res = await client.get(`/api/search?q=provenance&wsId=${wsAi}`);
  assert.equal(res.status, 200);
  const hits = JSON.parse(res.text).filter((r) => r.type === 'Control');
  assert.ok(hits.some((h) => h.label === 'A.7.5 Data provenance' && /\/iso42001\/gap\/ai-annex-a-7-5$/.test(h.href)), JSON.stringify(hits));
  const iso27 = JSON.parse((await client.get(`/api/search?q=access%20control&wsId=${wsAi}`)).text).filter((r) => r.type === 'Control');
  assert.ok(!iso27.some((h) => /\/controls\/annex-a/.test(h.href)), 'ISO 27001 controls are not offered to an ISO 42001-only client');
});
