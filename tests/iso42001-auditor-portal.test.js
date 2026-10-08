'use strict';
// The certification auditor's view of an ISO 42001 client: the portal names
// the AI management system, shows the approved ISO 42001 SoA, the AI system
// register and approved impact assessments, and names ISO 42001 controls on
// documents and findings; the audit pack carries the same.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

let env, client, auditor, db, actor, wsId, otherWsId, systemId, iaId, draftId, snapId, raw, otherRaw;

function share(workspaceId, token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare(`INSERT INTO auditor_shares (workspace_id, token, token_hash, token_last4, label, expires_at, created_by)
    VALUES (?, ?, ?, ?, 'Stage 2 auditor', ?, ?)`).run(workspaceId, `sha256:${hash}`, hash, token.slice(-4),
    new Date(Date.now() + 86400000).toISOString(), actor.id);
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  auditor = makeClient(env.app);
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id, name FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  otherWsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Harbour Freight', '["iso27001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);

  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, purpose, org_roles, lifecycle_stage, in_scope, created_by)
    VALUES (?, 'Triage assistant', 'Rank referrals by urgency', '["customer"]', 'in_use', 1, ?)`).run(wsId, actor.id).lastInsertRowid);
  iaId = Number(db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, affected_parties, societal_impacts,
      residual_level, decision, approved_by, approved_at, next_review_date)
    VALUES (?, ?, 1, 'approved', 'Patients referred to the clinic', 'Trust in automated triage', 'medium', 'proceed', ?, datetime('now'), '2027-09-01')`)
    .run(wsId, systemId, actor.id).lastInsertRowid);
  draftId = Number(db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, affected_parties) VALUES (?, ?, 2, 'draft', 'DRAFT-WORKING-PAPER')`)
    .run(wsId, systemId).lastInsertRowid);

  const reqId = (ref) => db.prepare('SELECT id FROM requirements WHERE ref=?').get(ref).id;
  db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, applicability, status) VALUES (?, ?, 'undecided', 'Not Assessed')`).run(wsId, reqId('ai-annex-a-2-2'));
  db.prepare(`UPDATE control_instances SET applicability='applicable', status='Implemented', inclusion_justification='Policy sets the rules for every AI system'
    WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(wsId, reqId('ai-annex-a-2-2'));
  const aimsSoa = require('../lib/iso42001-soa');
  snapId = aimsSoa.capture(db, ws, actor.id, { label: 'Stage 2 SoA', version: '2.0', owner: 'Head of AI Governance' });
  db.prepare(`UPDATE iso42001_soa_snapshots SET approval_status='approved', approved_by_name='Chief Executive', approved_on=datetime('now') WHERE id=?`).run(snapId);

  const docId = Number(db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, status, created_by) VALUES (?, 'AI Policy', 'policy', 'approved', ?)`).run(wsId, actor.id).lastInsertRowid);
  require('../lib/doc-links').addLink(db, 'iso42001', docId, 'ai-annex-a-2-2', null);
  const auditId = Number(db.prepare(`INSERT INTO audits (workspace_id, title, status, created_by) VALUES (?, 'AIMS internal audit', 'completed', ?)`).run(wsId, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, description, severity, status) VALUES (?, 'ai-annex-a-5-2', 'nonconformity', 'Pilot chatbot has no impact assessment', 'minor', 'open')`).run(auditId);

  raw = crypto.randomBytes(24).toString('hex');
  otherRaw = crypto.randomBytes(24).toString('hex');
  share(wsId, raw);
  share(otherWsId, otherRaw);
});
test.after(async () => { db?.close(); await client?.close(); await auditor?.close(); });

test('the portal names the AI management system and lists the ISO 42001 records', async () => {
  const landing = await auditor.get(`/auditor/${raw}`);
  assert.equal(landing.status, 200, landing.text.slice(0, 300));
  assert.match(landing.text, /AI Management System/);
  assert.match(landing.text, /ISO\/IEC 42001:2023/);
  assert.doesNotMatch(landing.text, /ISO\/IEC(&nbsp;| )27001/, 'no ISO 27001 wording for a 42001-only client');
  assert.match(landing.text, new RegExp(`/auditor/${raw}/aims/soa"`));
  assert.match(landing.text, new RegExp(`/auditor/${raw}/aims/systems"`));
  assert.match(landing.text, /1 system in scope · 1 approved assessment/);
  const soaRedirect = await auditor.get(`/auditor/${raw}/soa`);
  assert.equal(soaRedirect.status, 302);
  assert.match(soaRedirect.location, /\/aims\/soa$/);
});

test('the auditor sees the approved ISO 42001 SoA, and only this client\'s snapshots', async () => {
  const soa = await auditor.get(`/auditor/${raw}/aims/soa`);
  assert.equal(soa.status, 200);
  assert.match(soa.text, /Approved version <strong>2\.0<\/strong> by <strong>Chief Executive<\/strong>/);
  assert.match(soa.text, /<span class="iso-ref">A\.2\.2<\/span><\/td>\s*<td>AI policy<\/td>/);
  assert.match(soa.text, /Policy sets the rules for every AI system/);
  assert.equal((await auditor.get(`/auditor/${raw}/aims/soa/snapshots/${snapId}`)).status, 200);
  assert.equal((await auditor.get(`/auditor/${otherRaw}/aims/soa/snapshots/${snapId}`)).status, 404, 'a 27001-only share has no ISO 42001 pages');
  assert.equal((await auditor.get(`/auditor/${otherRaw}/aims/systems`)).status, 404);
});

test('the register shows approved impact assessments and never the drafts', async () => {
  const page = await auditor.get(`/auditor/${raw}/aims/systems`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Triage assistant/);
  assert.match(page.text, new RegExp(`/aims/systems/${systemId}/impact-assessments/${iaId}"`));
  assert.doesNotMatch(page.text, new RegExp(`impact-assessments/${draftId}"`));
  const ia = await auditor.get(`/auditor/${raw}/aims/systems/${systemId}/impact-assessments/${iaId}`);
  assert.equal(ia.status, 200);
  assert.match(ia.text, /Trust in automated triage/);
  const draft = await auditor.get(`/auditor/${raw}/aims/systems/${systemId}/impact-assessments/${draftId}`);
  assert.equal(draft.status, 404);
  assert.doesNotMatch(draft.text, /DRAFT-WORKING-PAPER/);
});

test('documents and findings name their ISO 42001 controls', async () => {
  const docs = await auditor.get(`/auditor/${raw}/documents`);
  assert.equal(docs.status, 200);
  assert.match(docs.text, /AI Policy/);
  const docId = db.prepare("SELECT id FROM generated_docs WHERE workspace_id=? AND name='AI Policy'").get(wsId).id;
  const detail = await auditor.get(`/auditor/${raw}/documents/${docId}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, />A\.2\.2<\/span>\s*<span class="meta text-sm" style="line-height:1.45;">AI policy<\/span>/);
  assert.match(detail.text, /ISO 42001 requirements covered/);
  const audits = await auditor.get(`/auditor/${raw}/audits`);
  assert.match(audits.text, /A\.5\.2 AI system impact assessment process/);
});

test('the audit pack is an AIMS pack with the ISO 42001 SoA and the AI register', async () => {
  const preview = await client.get(`/workspaces/${wsId}/audit-pack/preview`);
  assert.equal(preview.status, 200, preview.text.slice(0, 300));
  assert.match(preview.text, /<title>AIMS Audit Pack/);
  assert.match(preview.text, /An ISO\/IEC 42001:2023 deliverable/);
  assert.doesNotMatch(preview.text, /ISO\/IEC 27001/);
  assert.match(preview.text, /AI system register and impact assessments/);
  assert.match(preview.text, /<span class="iso-ref">A\.2\.2<\/span>/);
  assert.match(preview.text, /Approved version 2\.0/);
  const numbers = [...preview.text.matchAll(/<div class="section-eyebrow">Section (\d+)<\/div>/g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), 'sections are numbered in order');
  const config = await client.get(`/workspaces/${wsId}/audit-pack`);
  assert.equal(config.status, 200);
  assert.match(config.text, /name="aiSnapshotId"/);
  assert.doesNotMatch(config.text, /name="snapshotId"/, 'no ISO 27001 snapshot picker for a 42001-only client');
});

test('a client on both standards gets both SoAs in the portal, the pack and the ZIP', async () => {
  const bothId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Northwind Health', '["iso27001","iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  const bothRaw = crypto.randomBytes(24).toString('hex');
  share(bothId, bothRaw);
  const landing = await auditor.get(`/auditor/${bothRaw}`);
  assert.equal(landing.status, 200);
  assert.match(landing.text, /Information Security and AI Management Systems/);
  assert.match(landing.text, /ISO\/IEC 27001:2022 and ISO\/IEC 42001:2023/);
  assert.match(landing.text, new RegExp(`href="/auditor/${bothRaw}/soa" class="a-tab[^"]*">[\\s\\S]*?SoA\\s*</a>`));
  assert.match(landing.text, /AI SoA\s*<\/a>/);
  assert.match(landing.text, /Statement of Applicability · ISO\/IEC 42001/);
  assert.equal((await auditor.get(`/auditor/${bothRaw}/soa`)).status, 200, 'the ISO 27001 SoA is still served');

  const preview = await client.get(`/workspaces/${bothId}/audit-pack/preview`);
  assert.equal(preview.status, 200, preview.text.slice(0, 300));
  assert.match(preview.text, /<title>ISMS and AIMS Audit Pack/);
  assert.match(preview.text, /Statement of Applicability · ISO\/IEC 27001/);
  assert.match(preview.text, /Statement of Applicability · ISO\/IEC 42001/);
  const numbers = [...preview.text.matchAll(/<div class="section-eyebrow">Section (\d+)<\/div>/g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  assert.ok(numbers.length >= 11, 'every section, including both ISO 42001 sections');

  const zip = await client.get(`/workspaces/${bothId}/audit-pack/zip`);
  assert.equal(zip.status, 200);
  for (const name of ['01_Statement_of_Applicability.csv', '01_ISO42001_Statement_of_Applicability.csv', '01_AI_System_Register.csv']) {
    assert.ok(zip.buffer.includes(Buffer.from(name)), `${name} is in the ZIP`);
  }
});
