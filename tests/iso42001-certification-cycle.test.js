'use strict';
// ISO 42001 engagements are contracted like ISO 27001 ones, to end with the
// gap report or to continue through certification, and the certification
// cycle holds every audit date and the certification body's findings.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor;

const wsId = (location) => Number(String(location || '').match(/workspaces\/(\d+)/)[1]);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
});
test.after(async () => { db?.close(); await client?.close(); });

test('an ISO 42001 client is contracted to a gap assessment or to certification support', async () => {
  const missing = await client.post('/workspaces', { client_name: 'Undecided AI Client', frameworks: ['iso42001'] });
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Choose whether this engagement ends/);

  const gap = await client.post('/workspaces', { client_name: 'Gap Only AI Client', frameworks: ['iso42001'], engagement_outcome: 'gap_assessment_only', target_cert_date: '2027-03-01' });
  assert.equal(gap.status, 302);
  const row = db.prepare('SELECT engagement_outcome, target_cert_date FROM workspaces WHERE id=?').get(wsId(gap.location));
  assert.equal(row.engagement_outcome, 'gap_assessment_only');
  assert.equal(row.target_cert_date, null, 'a gap-only contract has no certification target');
});

test('a gap-only ISO 42001 engagement keeps its gap assessment and closes certification work', async () => {
  const id = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Report Only AI', '["iso42001"]', 'gap_assessment_only')`).run(actor.firm_id).lastInsertRowid);
  assert.equal((await client.get(`/workspaces/${id}/iso42001/gap-assessment`)).status, 200, 'the gap assessment stays open');
  assert.equal((await client.get(`/workspaces/${id}/iso42001/ai-systems`)).status, 200, 'the AI system register stays open');
  for (const path of ['/audits', '/mrms', '/iso42001/cert-cycle', '/iso42001/requests']) {
    const res = await client.get(`/workspaces/${id}${path}`);
    assert.equal(res.status, 409, `${path} is outside a gap-only contract`);
    assert.match(res.text, /gap-assessment-only engagement/);
  }
  assert.equal((await client.post(`/workspaces/${id}/iso42001/checklist`, {})).status, 409);
  assert.equal((await client.post(`/workspaces/${id}/audits`, { title: 'Should not exist' })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audits WHERE workspace_id=?').get(id).c, 0);
});

test('certification support cannot be shortened to gap-only once audit work has started', async () => {
  const id = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Committed AI', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  await client.post(`/workspaces/${id}/audits`, { title: 'AIMS internal audit' });
  const res = await client.post(`/workspaces/${id}/frameworks`, { frameworks: ['iso42001'], engagement_outcome: 'gap_assessment_only' });
  assert.equal(res.status, 409);
  assert.equal(db.prepare('SELECT engagement_outcome FROM workspaces WHERE id=?').get(id).engagement_outcome, 'certification_support');
});

let cert;
test('the certification cycle is the one record of audit dates', async () => {
  cert = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome, target_cert_date) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support', '2027-02-15')`).run(actor.firm_id).lastInsertRowid);
  assert.equal((await client.post(`/workspaces/${cert}/iso42001/cert-cycle/seed`, {})).status, 302);
  const events = db.prepare('SELECT event_key, planned_date, cycle_no FROM iso42001_cert_cycle_events WHERE workspace_id=? ORDER BY planned_date').all(cert);
  assert.deepEqual(events.map((e) => e.event_key), ['stage1', 'stage2', 'surv1', 'surv2', 'recert']);
  assert.deepEqual(events.map((e) => e.planned_date), ['2027-01-16', '2027-02-15', '2028-02-15', '2029-02-15', '2030-02-15']);
  assert.ok(events.every((e) => e.cycle_no === 1));

  const audit = require('../lib/iso42001-audit');
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(cert);
  assert.equal(audit.programme(db, ws).stage2_date, '2027-02-15', 'the overview reads the cycle');

  await client.post(`/workspaces/${cert}/iso42001/programme`, { stage1_date: '2027-01-10', stage2_date: '2027-02-20', certification_body: 'Example Certification Ltd' });
  const stage2 = db.prepare(`SELECT * FROM iso42001_cert_cycle_events WHERE workspace_id=? AND event_key='stage2'`).get(cert);
  assert.equal(stage2.planned_date, '2027-02-20', 'dates saved on the overview move the cycle event');
  assert.equal(stage2.certification_body, 'Example Certification Ltd');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=? AND event_key='stage2'`).get(cert).c, 1, 'no second Stage 2 is created');

  await client.post(`/workspaces/${cert}/iso42001/cert-cycle/${stage2.id}/update`, { planned_date: '2027-03-01', status: 'scheduled' });
  assert.equal(audit.programme(db, ws).stage2_date, '2027-03-01', 'dates changed on the cycle move the overview');
  assert.equal(db.prepare('SELECT stage2_date FROM aims_audit_programmes WHERE workspace_id=?').get(cert).stage2_date, '2027-03-01');

  const dup = await client.post(`/workspaces/${cert}/iso42001/cert-cycle/add`, { event_key: 'stage2', planned_date: '2027-04-01' });
  assert.match(decodeURIComponent(dup.location), /already has a Stage 2 audit/);
});

test("the certification body's findings are recorded against the audit and keep their lineage to closure", async () => {
  const stage1 = db.prepare(`SELECT id FROM iso42001_cert_cycle_events WHERE workspace_id=? AND event_key='stage1'`).get(cert).id;
  const res = await client.post(`/workspaces/${cert}/iso42001/cert-cycle/${stage1}/findings`, {
    severity: 'minor', iso_item_id: 'ai-annex-a-5-3', due_date: '2027-03-15',
    description: 'Two impact assessments were approved without a recorded review date.',
  });
  assert.equal(res.status, 302);
  const nc = db.prepare(`SELECT * FROM nonconformities WHERE workspace_id=? AND source='external_audit'`).get(cert);
  assert.equal(nc.source_ref, `iso42001_cert_cycle_event:${stage1}`);
  assert.equal(nc.iso_item_id, 'ai-annex-a-5-3');
  assert.equal(nc.severity, 'minor');
  assert.equal(nc.due_date, '2027-03-15');

  const cyclePage = await client.get(`/workspaces/${cert}/iso42001/cert-cycle`);
  assert.match(cyclePage.text, /Minor nonconformity/);
  assert.match(cyclePage.text, /A\.5\.3 Documentation of AI system impact assessments/);
  assert.match(cyclePage.text, /1 major|0 major &middot; 1 minor/);

  const detail = await client.get(`/workspaces/${cert}/nonconformities/${nc.id}`);
  assert.match(detail.text, /Retained ISO 42001 Stage 1 audit finding/);

  const forged = await client.post(`/workspaces/${cert}/nonconformities/${nc.id}`, { source: 'internal_audit' });
  assert.match(decodeURIComponent(forged.location), /lineage is immutable/);
  const deleted = await client.post(`/workspaces/${cert}/nonconformities/${nc.id}/delete`, {});
  assert.match(decodeURIComponent(deleted.location), /cannot be deleted/);
  assert.ok(db.prepare('SELECT 1 FROM nonconformities WHERE id=?').get(nc.id));

  const early = await client.post(`/workspaces/${cert}/nonconformities/${nc.id}`, { status: 'closed', corrective_action: 'Added a review date field' });
  assert.match(decodeURIComponent(early.location), /cannot be closed. Add root-cause analysis, effectiveness conclusion, independent validation evidence first/);

  const ev = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, uploaded_by) VALUES (?, 'ia-review-dates.pdf', 'fixture-ia', ?, ?)`)
    .run(cert, crypto.createHash('sha256').update('ia').digest('hex'), actor.id).lastInsertRowid);
  await client.post(`/workspaces/${cert}/nonconformities/${nc.id}/evidence`, { evidence_id: ev, evidence_role: 'validation' });
  const closed = await client.post(`/workspaces/${cert}/nonconformities/${nc.id}`, {
    status: 'closed', root_cause: 'The form had no review date', corrective_action: 'Added a review date field', effectiveness_check: 'Checked three later assessments',
  });
  assert.equal(closed.status, 302);
  assert.equal(db.prepare('SELECT status FROM nonconformities WHERE id=?').get(nc.id).status, 'closed');

  const keep = await client.post(`/workspaces/${cert}/iso42001/cert-cycle/${stage1}/delete`, {});
  assert.match(decodeURIComponent(keep.location), /findings recorded against it/);
  assert.ok(db.prepare('SELECT 1 FROM iso42001_cert_cycle_events WHERE id=?').get(stage1));

  const internal = await client.post(`/workspaces/${cert}/iso42001/cert-cycle/add`, { event_key: 'internal', planned_date: '2026-12-01' });
  const internalId = db.prepare(`SELECT id FROM iso42001_cert_cycle_events WHERE workspace_id=? AND event_key='internal'`).get(cert).id;
  assert.equal(internal.status, 302);
  const notCb = await client.post(`/workspaces/${cert}/iso42001/cert-cycle/${internalId}/findings`, { severity: 'minor', description: 'x' });
  assert.match(decodeURIComponent(notCb.location), /recorded against the certification body/);
});

test('a new three-year cycle starts only after recertification, keeping the earlier history', async () => {
  const early = await client.post(`/workspaces/${cert}/iso42001/cert-cycle/next`, {});
  assert.match(decodeURIComponent(early.location), /Complete this cycle's recertification audit/);
  const recert = db.prepare(`SELECT id FROM iso42001_cert_cycle_events WHERE workspace_id=? AND event_key='recert'`).get(cert).id;
  await client.post(`/workspaces/${cert}/iso42001/cert-cycle/${recert}/update`, { planned_date: '2030-02-15', actual_date: '2030-02-18', status: 'completed' });
  assert.equal((await client.post(`/workspaces/${cert}/iso42001/cert-cycle/next`, {})).status, 302);
  const next = db.prepare('SELECT event_key, planned_date FROM iso42001_cert_cycle_events WHERE workspace_id=? AND cycle_no=2 ORDER BY planned_date').all(cert);
  assert.deepEqual(next, [{ event_key: 'surv1', planned_date: '2031-02-18' }, { event_key: 'surv2', planned_date: '2032-02-18' }, { event_key: 'recert', planned_date: '2033-02-18' }]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=? AND cycle_no=1').get(cert).c, 6, 'cycle 1 is kept');
});

test('migration 070 names older events and turns programme-only dates into cycle events', () => {
  const id = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks) VALUES (?, 'Legacy AI', '["iso42001"]')`).run(actor.firm_id).lastInsertRowid);
  db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, planned_date) VALUES (?, 'Surveillance audit (year 1)', '2028-01-01')`).run(id);
  db.prepare(`INSERT INTO aims_audit_programmes (workspace_id, stage1_date, stage2_date, certification_body) VALUES (?, '2027-01-01', '2027-02-01', 'Legacy CB')`).run(id);
  require('../migrations/070_iso42001_certification_cycle').up(db);
  const rows = db.prepare('SELECT event_key, planned_date, certification_body FROM iso42001_cert_cycle_events WHERE workspace_id=? ORDER BY planned_date').all(id);
  assert.deepEqual(rows, [
    { event_key: 'stage1', planned_date: '2027-01-01', certification_body: 'Legacy CB' },
    { event_key: 'stage2', planned_date: '2027-02-01', certification_body: 'Legacy CB' },
    { event_key: 'surv1', planned_date: '2028-01-01', certification_body: null },
  ]);
  require('../migrations/070_iso42001_certification_cycle').up(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=?').get(id).c, 3, 'running it again adds nothing');
});
