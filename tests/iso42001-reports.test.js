'use strict';
// The documents an ISO 42001 engagement hands over, built from the records
// the tool keeps: the gap assessment report, an impact assessment, management
// review minutes, the internal audit report, the approved SoA and the AI
// system register.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, ws, systemId, iaId, draftId, mrmId, auditId, otherWsId;
const base = () => `/workspaces/${wsId}/iso42001`;
const isDocx = (res) => {
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.match(res.headers['content-type'], /officedocument\.wordprocessingml\.document/);
  assert.equal(res.buffer.subarray(0, 2).toString('ascii'), 'PK');
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id, name FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  otherWsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks) VALUES (?, 'Harbour Freight', '["iso27001"]')`).run(actor.firm_id).lastInsertRowid);
  ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, purpose, org_roles, lifecycle_stage, in_scope, system_owner, created_by)
    VALUES (?, 'Triage assistant', '=Rank referrals by urgency', '["customer"]', 'in_use', 1, 'Head of Clinical Ops', ?)`).run(wsId, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO ai_system_suppliers (ai_system_id, workspace_id, supplier_name, lifecycle_role, created_by) VALUES (?, ?, 'Model vendor', 'model', ?)`).run(systemId, wsId, actor.id);
  iaId = Number(db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, affected_parties, potential_harms,
      societal_impacts, mitigations, residual_level, decision, harm_severity, harm_likelihood, prepared_by, approved_by, approved_at, next_review_date)
    VALUES (?, ?, 1, 'approved', 'Patients referred to the clinic', 'An urgent case ranked as routine', 'Trust in automated triage',
      'Clinician reviews every ranking', 'medium', 'proceed', 4, 2, ?, ?, datetime('now'), '2027-09-01')`).run(wsId, systemId, actor.id, actor.id).lastInsertRowid);
  draftId = Number(db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status) VALUES (?, ?, 2, 'draft')`).run(wsId, systemId).lastInsertRowid);
  mrmId = Number(db.prepare(`INSERT INTO mrms (workspace_id, meeting_date, attendees, status, performance_review, decisions, action_items, created_by)
    VALUES (?, '2026-08-14', 'CEO, Head of Clinical Ops', 'completed', 'Drift within target', 'Retrain the triage model quarterly', 'Schedule the Q4 retraining', ?)`).run(wsId, actor.id).lastInsertRowid);
  auditId = Number(db.prepare(`INSERT INTO audits (workspace_id, title, scope, audit_date, auditor_name, status, created_by)
    VALUES (?, 'AIMS internal audit 2026', 'Triage assistant', '2026-08-01', 'Priya Nair', 'completed', ?)`).run(wsId, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, description, severity, status) VALUES (?, 'ai-annex-a-5-2', 'nonconformity', 'No impact assessment for the pilot chatbot', 'minor', 'open')`).run(auditId);
  db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, recommendation, status) VALUES (?, 'ai-annex-a-2-2', 'AI policy approved and published', 'Add the review date to the policy', 'closed')`).run(auditId);
  db.prepare(`INSERT INTO audit_samples (audit_id, iso_item_id, description, sample_size, population_size, finding) VALUES (?, 'ai-annex-a-6-2-4', 'Releases since January', 5, 12, 'All had validation results')`).run(auditId);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the ISO 42001 gap assessment report is its own standard, on the page and in Word', async () => {
  const page = await client.get(`${base()}/gap-report`);
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.match(page.text, /ISO\/IEC 42001:2023/);
  assert.doesNotMatch(page.text, /ISO\/IEC 27001/, 'a 42001-only client gets no 27001 wording');
  assert.match(page.text, /AI management system|AIMS/);
  isDocx(await client.get(`${base()}/gap-report.docx`));
  assert.equal((await client.get(`/workspaces/${otherWsId}/iso42001/gap-report`)).status, 404, 'not for a client without ISO 42001');
});

test('an impact assessment exports with its ratings, approver and every section', async () => {
  const report = require('../lib/aims-reports').impactAssessment(db, ws, systemId, iaId);
  assert.match(report.title, /Triage assistant v1$/);
  assert.match(report.body, /Trust in automated triage/);
  assert.match(report.body, /4 - Major/);
  assert.match(report.body, /2 - Unlikely/);
  assert.match(report.body, /Proceed/);
  assert.match(report.body, /Conditions on the decision/, 'every section is present, even if not recorded');
  assert.match(require('../lib/aims-reports').impactAssessment(db, ws, systemId, draftId).title, /\(draft\)$/);
  assert.equal(require('../lib/aims-reports').impactAssessment(db, { id: otherWsId }, systemId, iaId), null, 'scoped to the client');
  isDocx(await client.get(`${base()}/ai-systems/${systemId}/impact-assessments/${iaId}/report.docx`));
  assert.equal((await client.get(`${base()}/ai-systems/${systemId}/impact-assessments/99999/report.docx`)).status, 404);
  const page = await client.get(`${base()}/ai-systems/${systemId}/impact-assessments/${iaId}`);
  assert.match(page.text, new RegExp(`impact-assessments/${iaId}/report\\.docx`));
});

test('management review minutes and the internal audit report are written from the records', async () => {
  const reports = require('../lib/aims-reports');
  const minutes = reports.managementReview(db, ws, mrmId);
  assert.match(minutes.body, /Retrain the triage model quarterly/);
  assert.match(minutes.body, /Drift within target/);
  assert.match(minutes.body, /Feedback from interested parties<\/h3><p class="meta">Not recorded/);
  isDocx(await client.get(`/workspaces/${wsId}/mrms/${mrmId}/minutes.docx`));
  assert.match((await client.get(`/workspaces/${wsId}/mrms/${mrmId}`)).text, /minutes\.docx/);

  const audit = reports.internalAudit(db, ws, auditId);
  assert.match(audit.body, /A\.5\.2 /, 'findings name the ISO 42001 control');
  assert.match(audit.body, /No impact assessment for the pilot chatbot/);
  assert.match(audit.body, /AI policy approved and published/);
  assert.match(audit.body, /Recommendation: Add the review date/);
  assert.match(audit.body, /5 of 12/);
  isDocx(await client.get(`/workspaces/${wsId}/audits/${auditId}/report.docx`));
  assert.equal((await client.get(`/workspaces/${otherWsId}/audits/${auditId}/report.docx`)).status, 404, 'another client\'s audit is not found');
});

test('the SoA snapshot and the AI register export, and the register CSV cannot run as a formula', async () => {
  const aimsSoa = require('../lib/iso42001-soa');
  const reqId = db.prepare("SELECT id FROM requirements WHERE ref='ai-annex-a-2-2'").get().id;
  db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, applicability, status) VALUES (?, ?, 'undecided', 'Not Assessed')`).run(wsId, reqId);
  db.prepare(`UPDATE control_instances SET applicability='applicable', status='Implemented', inclusion_justification='Needed for the triage assistant'
    WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(wsId, reqId);
  const snapId = aimsSoa.capture(db, ws, actor.id, { label: 'Test', version: '1.0', owner: 'CISO' });
  const soa = require('../lib/aims-reports').soaSnapshot(db, ws, aimsSoa.load(db, ws, snapId));
  assert.match(soa.body, /<td>A\.2\.2<\/td><td>AI policy<\/td>/);
  assert.match(soa.body, /Needed for the triage assistant/);
  assert.match(soa.body, /Not approved/);
  isDocx(await client.get(`${base()}/soa/snapshots/${snapId}/report.docx`));
  assert.equal((await client.get(`/workspaces/${otherWsId}/iso42001/soa/snapshots/${snapId}/report.docx`)).status, 404);

  isDocx(await client.get(`${base()}/ai-register.docx`));
  const csv = await client.get(`${base()}/ai-register.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Triage assistant,'=Rank referrals by urgency,,AI customer/);
  assert.match(csv.text, /Model vendor/);
  assert.match(csv.text, /Next review 2027-09-01/);
  assert.match((await client.get(`${base()}/ai-systems`)).text, /ai-register\.csv/);
});
