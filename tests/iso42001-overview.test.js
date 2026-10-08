'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aims-overview-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.ISMS_KEY_FILE = path.join(tmp, 'master.key');
const { db, init } = require('../db');
init();
const { buildOverview } = require('../lib/iso42001-overview');
const delivery = require('../lib/engagement-delivery');
const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
let sequence = 0;
function workspace(frameworks = ['iso42001']) {
  const id = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,?,'certification_support')`).run(user.firm_id, `Overview ${++sequence}`, JSON.stringify(frameworks)).lastInsertRowid);
  return db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
}
function request(ws, status = 'open', released = true) {
  return Number(db.prepare(`INSERT INTO client_requests(workspace_id,request_type,title,status,created_by,released_at)
    VALUES (?,'evidence',?,?,?,?)`).run(ws.id, `Request ${++sequence}`, status, user.id, released ? '2026-09-20 09:00:00' : null).lastInsertRowid);
}
function auditLink(ws, id) {
  return Number(db.prepare(`INSERT INTO aims_audit_requests(workspace_id,ref,kind,stage,description,client_request_id)
    VALUES (?,?,'evidence','fieldwork','Evidence request',?)`).run(ws.id, `TEST-${++sequence}`, id).lastInsertRowid);
}
function finding(ws, source = 'ISO42001:demo', status = 'open') {
  return Number(db.prepare(`INSERT INTO nonconformities(workspace_id,title,source_ref,status)
    VALUES (?, ?, ?, ?)`).run(ws.id, `Finding ${++sequence}`, source, status).lastInsertRowid);
}
function evidence(ws, item = null, superseded = false) {
  return Number(db.prepare(`INSERT INTO evidence(workspace_id,filename,stored_path,uploaded_by,iso_item_id,superseded_at,uploaded_at)
    VALUES (?,?,?,?,?,?,?)`).run(ws.id, `Evidence ${++sequence}.txt`, '/synthetic', user.id, item,
      superseded ? '2026-09-24' : null, '2026-09-25 10:00:00').lastInsertRowid);
}
function readOnly(ws) {
  const before = db.prepare('SELECT total_changes() n').get().n;
  db.pragma('query_only=ON');
  try {
    const model = buildOverview(db, ws, user.id);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
    return model;
  } finally { db.pragma('query_only=OFF'); }
}
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('overview reads an empty workspace without creating a plan or implying approval', () => {
  const ws = workspace();
  const model = readOnly(ws);
  assert.equal(model.plan, null);
  assert.equal(model.projection, null);
  assert.deepEqual(model.assessment, { assessed: 0, total: 65, reviewed: false, complete: false,
    href: `/workspaces/${ws.id}/iso42001/gap-assessment` });
  assert.equal(model.report.status, 'not_started');
  assert.equal(model.report.published, false);
  assert.equal(model.findings.open, 0);
  assert.equal(model.requests.open, 0);
  assert.equal(model.evidence.total, 0);
  assert.deepEqual(model.recentActivity, []);
  assert.equal(db.prepare('SELECT count(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id).c, 0);
});

test('native requests count once, preserve release/review status, and isolate workspace records', () => {
  const ws = workspace(), other = workspace();
  const submitted = request(ws, 'submitted');
  auditLink(ws, submitted); auditLink(ws, submitted);
  const returned = request(ws, 'changes_requested');
  const unsent = request(ws, 'open', false);
  request(ws, 'accepted'); request(ws, 'cancelled');
  const privateRequest = request(other, 'submitted'); auditLink(other, privateRequest);
  finding(ws); finding(ws, 'ISO42001:closed', 'closed'); finding(ws, 'ISO42001:verified', 'verified');
  finding(ws, 'ISO27001:other'); finding(other);
  const shared = evidence(ws);
  db.prepare('INSERT INTO client_request_evidence(request_id,evidence_id,linked_by) VALUES (?,?,?)').run(submitted, shared, user.id);
  db.prepare('INSERT INTO client_request_evidence(request_id,evidence_id,linked_by) VALUES (?,?,?)').run(returned, shared, user.id);
  evidence(ws, 'ai-4.1', true); evidence(other);
  const addEvent = db.prepare(`INSERT INTO client_request_events(request_id,workspace_id,actor_id,event_type,to_status,created_at)
    VALUES (?,?,?,'status_changed',?,?)`);
  addEvent.run(submitted, ws.id, user.id, 'submitted', '2026-09-26 10:00:00');
  addEvent.run(privateRequest, other.id, user.id, 'submitted', '2026-09-27 11:00:00');
  const model = readOnly(ws);
  assert.equal(model.requests.open, 3);
  assert.equal(model.requests.withClient, 1);
  assert.equal(model.requests.toReview, 1);
  assert.equal(model.requests.rows.filter(row => row.id === submitted).length, 1);
  assert.equal(model.requests.rows.find(row => row.id === unsent).statusLabel, 'Not sent');
  assert.equal(model.requests.rows.find(row => row.id === submitted).statusLabel, 'Awaiting review');
  assert.equal(model.findings.open, 1);
  assert.equal(model.evidence.total, 1);
  assert.equal(model.recentActivity[0].title, 'Awaiting review');
  assert.ok(model.recentActivity.every(row => row.href.startsWith(`/workspaces/${ws.id}/`)));
  assert.ok(!model.recentActivity.some(row => row.href.endsWith(`/client-portal/requests/${privateRequest}`)));
});

test('combined programmes require explicit AIMS attribution and label delivery progress as combined', () => {
  const ws = workspace(['iso27001', 'iso42001']);
  const aims = request(ws, 'submitted'); auditLink(ws, aims);
  request(ws, 'submitted'); // Generic combined request is not attributable to AIMS.
  const otherControl = db.prepare('SELECT id FROM iso_items ORDER BY id LIMIT 1').get().id;
  const isms = request(ws);
  db.prepare('UPDATE client_requests SET control_id=? WHERE id=?').run(otherControl, isms);
  const standaloneEngagement = Number(db.prepare(`INSERT INTO consulting_engagements(workspace_id,engagement_code,name,framework_scope_json,created_by)
    VALUES (?,'AIMS-01',?,'["iso42001"]',?)`).run(ws.id, 'AIMS assessment', user.id).lastInsertRowid);
  const specific = request(ws);
  db.prepare('UPDATE client_requests SET engagement_id=? WHERE id=?').run(standaloneEngagement, specific);
  finding(ws, 'ISO 42001:manual'); finding(ws, 'ISO42001:closed', 'closed');
  finding(ws, 'ISO27001:manual'); finding(ws, 'generic');
  const aiEvidence = evidence(ws);
  db.prepare('INSERT INTO client_request_evidence(request_id,evidence_id,linked_by) VALUES (?,?,?)').run(aims, aiEvidence, user.id);
  evidence(ws, otherControl); evidence(ws);
  delivery.ensurePlan(db, ws, user.id);
  const model = readOnly(ws);
  assert.equal(model.planScope, 'combined');
  assert.match(model.planLabel, /Combined ISO 27001 \/ ISO 42001/);
  assert.ok(model.plan && model.projection);
  assert.equal(model.requests.open, 2);
  assert.equal(model.requests.toReview, 1);
  assert.equal(model.findings.open, 1);
  assert.equal(model.evidence.total, 1);
  assert.ok(model.recentActivity.length <= 5);
  assert.ok(model.recentActivity.filter(row => row.kind === 'engagement').every(row => /Combined/.test(row.detail)));
});

test('legacy pass completion and intake conclusions do not imply independent review or report publication', () => {
  const ws = workspace();
  db.prepare(`INSERT INTO iso42001_assessment_passes(workspace_id,pass_number,name,started_by,status,completed_at)
    VALUES (?,1,'Legacy completion',?,'completed','2026-09-20')`).run(ws.id, user.id);
  const item = db.prepare('SELECT id FROM iso42001_items ORDER BY sort_order LIMIT 1').get().id;
  const requirement = require('../lib/control-writes').requirementId(db, 'iso42001', item);
  db.prepare(`INSERT INTO control_instances(workspace_id,requirement_id,status) VALUES (?,?,'partially_implemented')`).run(ws.id, requirement);
  const model = readOnly(ws);
  assert.equal(model.assessment.assessed, 1);
  assert.equal(model.assessment.reviewed, false);
  assert.equal(model.assessment.complete, false);
  assert.equal(model.report.status, 'not_started');
  assert.equal(model.report.reviewed, false);
  assert.equal(model.report.published, false);
});
