'use strict';
// Incidents and changes as ISO 42001 reads them (lib/aims-operations.js,
// migration 082): AI categories and the affected AI system on the shared
// registers, who must be told about an AI incident and by when (A.8.4), and
// a significant change to an AI system bringing its impact and risk
// assessments forward (8.2, 8.4). A change judged not significant does not;
// one not yet judged still does.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, aimsId, bothId, ismsId, systemId, otherSystem;
const toast = (res) => decodeURIComponent(res.location || '');
const ws = (id) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const reassessment = () => require('../lib/ai-systems').reassessment(db, ws(aimsId), systemId);
const flag = (kind) => require('../routes/iso42001').shared.computeIso42001Readiness(aimsId).flags.find((f) => f.kind === kind);
const change = (title, significant, createdAt = "datetime('now')") => {
  const id = Number(db.prepare(`INSERT INTO changes (workspace_id, title, significant, created_by, created_at) VALUES (?, ?, ?, ?, ${createdAt})`)
    .run(aimsId, title, significant, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO ai_system_links (ai_system_id, workspace_id, link_type, target_id, linked_by) VALUES (?, ?, 'change', ?, ?)`).run(systemId, aimsId, id, actor.id);
  return id;
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name, frameworks) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`)
    .run(actor.firm_id, name, frameworks).lastInsertRowid);
  aimsId = add('Kestrel Lending', '["iso42001"]');
  bothId = add('Harbour Analytics', '["iso27001","iso42001"]');
  ismsId = add('Harbour Freight', '["iso27001"]');
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Claims assistant', 'in_use', 1, ?)`).run(aimsId, actor.id).lastInsertRowid);
  otherSystem = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Someone else''s model', 'in_use', 1, ?)`).run(bothId, actor.id).lastInsertRowid);
  db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, approved_at) VALUES (?, ?, 1, 'approved', datetime('now','-30 days'))`).run(aimsId, systemId);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the registers speak the standards the client runs', async () => {
  const aims = await client.get(`/workspaces/${aimsId}/incidents`);
  assert.match(aims.text, /<h1 class="page-title">Incidents<\/h1>/);
  assert.match(aims.text, /ISO 42001 A\.8\.4 and A\.6\.2\.6/);
  assert.doesNotMatch(aims.text, /A\.5\.24/);
  assert.match(aims.text, /<optgroup label="AI system">[\s\S]*Unfair outcome for a person or group/);
  assert.match(aims.text, /name="ai_system_id"[\s\S]*Claims assistant/);

  const both = await client.get(`/workspaces/${bothId}/incidents`);
  assert.match(both.text, /ISO 27001 A\.5\.24–A\.5\.28\) and incidents with AI systems \(ISO 42001 A\.8\.4/);
  const isms = await client.get(`/workspaces/${ismsId}/incidents`);
  assert.match(isms.text, /<h1 class="page-title">Information security incidents<\/h1>/, 'an ISO 27001 client sees no change');
  assert.match((await client.get(`/workspaces/${ismsId}/changes`)).text, /A\.8\.32 requires a structured approach/);
  assert.doesNotMatch(isms.text, /optgroup|ai_output/);

  const changes = await client.get(`/workspaces/${aimsId}/changes`);
  assert.match(changes.text, /<h1 class="page-title">Change register<\/h1>/);
  assert.doesNotMatch(changes.text, /A\.8\.32/, 'not even in the empty register\'s message');
  assert.doesNotMatch(aims.text, /A\.5\.2[4-8]/);
  assert.match(aims.text, /ISO 42001 A\.8\.4 asks for a plan/, 'A.8.4 is named as ISO 42001\'s, not ISO 27001\'s');
  assert.match(changes.text, /Model retrained, fine-tuned or replaced/);
  assert.match((await client.get(`/workspaces/${ismsId}/changes`)).text, /Change management register/);
});

test('a change judged not significant does not call for a new impact assessment; one not yet judged still does', () => {
  assert.equal(reassessment().state, 'current');
  const undecided = change('Retrain on Q3 claims', null);
  assert.equal(reassessment().state, 'due', 'a change recorded before the flag existed keeps triggering');
  db.prepare('UPDATE changes SET significant=0 WHERE id=?').run(undecided);
  assert.equal(reassessment().state, 'current', 'judged not significant');
  db.prepare('UPDATE changes SET significant=1 WHERE id=?').run(undecided);
  assert.equal(reassessment().state, 'due');
  assert.deepEqual(flag('changes_unassessed').items.map((i) => i.id), [undecided]);
  assert.match(flag('changes_unassessed').items[0].href, new RegExp(`/changes/${undecided}#aims$`));
  db.prepare('UPDATE changes SET significant=0 WHERE id=?').run(undecided);
  assert.equal(flag('changes_unassessed'), undefined);
});

test('a significant change since the last AI risk assessment brings the next one forward', () => {
  const aiRisk = require('../lib/ai-risk');
  db.prepare(`INSERT INTO risk_assessment_records (workspace_id, scope, label, performed_on, methodology_name, risk_count, above_appetite, payload, payload_hash, recorded_by)
    VALUES (?, 'ai', 'AI risk assessment', date('now','-60 days'), 'Default', 0, 0, '[]', 'test', ?)`).run(aimsId, actor.id);
  const before = aiRisk.nextDue(db, ws(aimsId), 'iso42001');
  assert.equal(before.reason, undefined);
  change('Connect the claims archive', 1);
  const after = aiRisk.nextDue(db, ws(aimsId), 'iso42001');
  assert.equal(after.due, new Date().toISOString().slice(0, 10));
  assert.match(after.reason, /Significant change "Connect the claims archive" since the last assessment/);
  assert.ok(after.due < before.due);
});

test('an AI incident records who must be told and by when, and a missed deadline is flagged', async () => {
  const created = await client.post(`/workspaces/${aimsId}/incidents`, { title: 'Scores skewed against older applicants', category: 'ai_bias', severity: 'high', ai_system_id: String(systemId) });
  const id = Number(created.location.match(/incidents\/(\d+)/)[1]);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM ai_system_links WHERE link_type='incident' AND target_id=? AND ai_system_id=?`).get(id, systemId).c, 1);
  const list = await client.get(`/workspaces/${aimsId}/incidents`);
  assert.match(list.text, />Unfair outcome for a person or group</);

  await client.post(`/workspaces/${aimsId}/incidents/${id}/ai`, { notify_who: 'Applicants scored since July; the regulator', notification_required_by: '2026-01-05T09:00', notification_sent_at: '' });
  const row = db.prepare('SELECT notify_who, notification_required_by, notification_sent_at FROM incidents WHERE id=?').get(id);
  assert.deepEqual(row, { notify_who: 'Applicants scored since July; the regulator', notification_required_by: '2026-01-05 09:00', notification_sent_at: null });
  assert.deepEqual(flag('incident_notice_late').items.map((i) => i.id), [id]);
  assert.equal(flag('incident_notice_late').severity, 'high');

  const page = await client.get(`/workspaces/${aimsId}/incidents/${id}`);
  assert.match(page.text, /id="aims"[\s\S]*AI systems and telling those affected[\s\S]*Claims assistant/);
  assert.doesNotMatch(page.text, /A\.5\.2[4-8]/, 'no ISO 27001 references on an ISO 42001 client\'s incident');
  assert.match(page.text, /Lessons learned \(clause 10\.2\)/);
  assert.match(page.text, /What was told, and to whom/);
  const path = await client.get(`/workspaces/${aimsId}/iso42001/path`);
  assert.match(path.text, /Handle AI incidents and tell those affected<\/a>[\s\S]{0,400}1 notice past the deadline/);

  await client.post(`/workspaces/${aimsId}/incidents/${id}/ai`, { notify_who: 'Applicants scored since July; the regulator', notification_required_by: '2026-01-05T09:00', notification_sent_at: '2026-01-04T16:30' });
  assert.equal(flag('incident_notice_late'), undefined, 'told in time');
});

test('a change records its AI system and significance at any status, and another client\'s system cannot be linked', async () => {
  const created = await client.post(`/workspaces/${aimsId}/changes`, { title: 'Swap to the vendor\'s new model', category: 'ai_supplier', ai_system_id: String(systemId), significant: 'yes' });
  const id = Number(created.location.match(/changes\/(\d+)/)[1]);
  assert.equal(db.prepare('SELECT significant FROM changes WHERE id=?').get(id).significant, 1);
  db.prepare("UPDATE changes SET status='approved' WHERE id=?").run(id);
  const saved = await client.post(`/workspaces/${aimsId}/changes/${id}/ai`, { significant: 'no' });
  assert.match(toast(saved), /Saved/);
  assert.equal(db.prepare('SELECT significant FROM changes WHERE id=?').get(id).significant, 0);
  await client.post(`/workspaces/${aimsId}/changes/${id}/ai`, { significant: '' });
  assert.equal(db.prepare('SELECT significant FROM changes WHERE id=?').get(id).significant, null, 'back to not decided');

  await client.post(`/workspaces/${aimsId}/changes/${id}/ai`, { ai_system_id: String(otherSystem) });
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM ai_system_links WHERE link_type='change' AND target_id=? AND ai_system_id=?`).get(id, otherSystem).c, 0);
  const page = await client.get(`/workspaces/${aimsId}/changes/${id}`);
  assert.match(page.text, /id="aims"[\s\S]*AI systems and significance[\s\S]*Claims assistant/);
  assert.match(page.text, /Supplier model or service updated/);
});
