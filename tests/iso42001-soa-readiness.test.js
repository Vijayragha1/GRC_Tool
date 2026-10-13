'use strict';
// The ISO 42001 SoA is sealed on capture and approved by a second person once
// it is complete, and readiness counts a mandatory record only when the record
// itself exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

let env, client, second, db, actor, reviewer, wsId;

async function signIn(app, email, password) {
  const c = makeClient(app);
  const page = await c.get('/login');
  const token = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await c.post('/login', { email, password, _csrf: token }, { csrf: false });
  assert.ok(res.status >= 300 && res.status < 400, `login for ${email} failed: ${res.status}`);
  let landing = await c.get('/dashboard');
  for (let i = 0; landing.location && i < 5; i++) landing = await c.get(landing.location);
  return c;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  reviewer = Number(db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active)
    VALUES ('second-reviewer@example.com', ?, 'Second Reviewer', ?, 'firm', 'manager', 1)`).run(bcrypt.hashSync('second-pass-1234', 4), actor.firm_id).lastInsertRowid);
  second = await signIn(env.app, 'second-reviewer@example.com', 'second-pass-1234');
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); await second?.close(); });

const soa = `/workspaces/${'WS'}/iso42001/soa`;
const url = (path) => path.replace('WS', wsId);

test('a snapshot is sealed, keeps the risks behind each control, and cannot be approved while incomplete', async () => {
  const riskId = Number(db.prepare(`INSERT INTO risks (workspace_id, title, likelihood, impact, status) VALUES (?, 'Unreviewed model release', 3, 4, 'open')`).run(wsId).lastInsertRowid);
  db.prepare(`INSERT INTO iso42001_risk_controls (risk_id, iso_item_id) VALUES (?, 'ai-annex-a-6-2-4')`).run(riskId);
  await client.post(url(`${soa}/ai-annex-a-6-2-4?ajax=1`), { applicability: 'included', status: 'Implemented', justification: 'Treats R-1' });

  const cap = await client.post(url(`${soa}/snapshot`), { label: 'Before Stage 1' });
  assert.equal(cap.status, 302);
  const snap = db.prepare('SELECT * FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY id DESC').get(wsId);
  assert.equal(snap.approval_status, 'draft');
  const row = JSON.parse(snap.payload).rows.find((r) => r.id === 'ai-annex-a-6-2-4');
  assert.deepEqual(row.risks, [{ id: riskId, title: 'Unreviewed model release' }]);
  assert.throws(() => db.prepare('UPDATE iso42001_soa_snapshots SET payload=? WHERE id=?').run('{}', snap.id), /cannot be changed once captured/);

  const self = await client.post(url(`${soa}/snapshots/${snap.id}/approve`), {});
  assert.match(decodeURIComponent(self.location), /someone other than the person who captured it/);
  const incomplete = await second.post(url(`${soa}/snapshots/${snap.id}/approve`), {});
  assert.match(decodeURIComponent(incomplete.location), /cannot be approved: 37 undecided/);
  const page = await client.get(url(`${soa}/snapshots/${snap.id}`));
  assert.match(page.text, /Not ready for approval/);
  assert.match(page.text, /Sealed/);
});

test('a complete SoA is approved by a second person and the approval is final', async () => {
  const rows = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.req_type='control'`).all();
  for (const r of rows) {
    db.prepare('INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)').run(wsId, r.id);
    db.prepare(`UPDATE control_instances SET applicability='applicable', inclusion_justification=COALESCE(inclusion_justification, 'Required by the AI risk assessment') WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(wsId, r.id);
  }
  await client.post(url(`${soa}/metadata`), { version: '1.0', owner: 'AI governance lead' });
  const snap = db.prepare('SELECT * FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY id DESC').get(wsId);
  assert.equal(snap.version, '1.0');
  const ok = await second.post(url(`${soa}/snapshots/${snap.id}/approve`), { note: 'AI governance board, 2 Oct' });
  assert.match(decodeURIComponent(ok.location), /Statement of Applicability approved/);
  const approved = db.prepare('SELECT * FROM iso42001_soa_snapshots WHERE id=?').get(snap.id);
  assert.equal(approved.approval_status, 'approved');
  assert.equal(approved.approved_by_user_id, reviewer);
  assert.equal(approved.approved_by_name, 'Second Reviewer');
  assert.throws(() => db.prepare("UPDATE iso42001_soa_snapshots SET label='edited' WHERE id=?").run(snap.id), /approved SoA snapshot is final/);

  const current = await client.get(url(soa));
  assert.match(current.text, /approved by Second Reviewer on/);
  assert.doesNotMatch(current.text, /name="approved_by"/, 'the approver is no longer a typed name');
});

test('readiness counts a mandatory record only when the record exists', async () => {
  const clause = (ref, status) => {
    const rid = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=?`).get(ref).id;
    db.prepare('INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)').run(wsId, rid);
    db.prepare('UPDATE control_instances SET status=? WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL').run(status, wsId, rid);
  };
  clause('ai-clause-9.3', 'implemented');
  clause('ai-clause-8.4', 'implemented');
  const { shared } = require('../routes/iso42001');
  const checks = () => Object.fromEntries(shared.computeIso42001Readiness(wsId).records.mandatory.checks.map((c) => [c.clause, c]));

  let c = checks();
  assert.equal(c['6.1.3'].found, true, 'the approved SoA counts');
  assert.equal(c['9.3'].found, false, 'a clause marked implemented is not a management review');
  assert.equal(c['9.3'].declaredOnly, true);
  assert.equal(c['8.4'].found, false);

  const sys = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Triage assistant', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
  assert.equal(checks()['8.4'].found, false, 'a system without an approved impact assessment');
  db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, approved_at) VALUES (?, ?, 1, 'approved', datetime('now'))`).run(wsId, sys);
  db.prepare(`INSERT INTO mrms (workspace_id, meeting_date, status, created_by) VALUES (?, date('now','-10 days'), 'complete', ?)`).run(wsId, actor.id);
  db.prepare(`INSERT INTO risk_assessment_records (workspace_id, label, performed_on, risk_count, above_appetite, payload, payload_hash, recorded_by)
    VALUES (?, 'AI risk assessment', date('now'), 1, 0, '[]', 'x', ?)`).run(wsId, actor.id);
  c = checks();
  assert.equal(c['8.4'].found, true);
  assert.equal(c['9.3'].found, true);
  assert.equal(c['8.2'].found, true);
  assert.equal(c['9.2'].found, false, 'no ISO 42001 internal audit has reached its report');

  const page = await client.get(`/workspaces/${wsId}/iso42001/readiness`);
  assert.equal(page.status, 200);
  assert.match(page.text, /1 of 1 in-scope AI systems have an approved impact assessment/);
  assert.match(page.text, /An internal audit covering ISO 42001 that has reached its report/);
});
