'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-combined-iso-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.ISMS_KEY_FILE = path.join(tmp, 'test.key');
const { db, init } = require('../db');
init();
const delivery = require('../lib/engagement-delivery');
const gapFieldwork = require('../lib/gap-fieldwork');
const { combinedAssurance } = require('../lib/iso42001-combined-assurance');
const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
const actorId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
function workspace(outcome) {
  const id = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,'Combined framework test','["iso27001","iso42001"]',?)`).run(firmId, outcome).lastInsertRowid);
  return { ...db.prepare('SELECT * FROM workspaces WHERE id=?').get(id), frameworks: ['iso27001', 'iso42001'] };
}
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('successful ISMS gap closure cannot complete a combined contract without independent AI assurance', t => {
  const ws = workspace('gap_assessment_only');
  // Isolate the framework aggregation boundary: the existing ISMS engine has
  // already concluded its reviewed assessment, report and formal closure.
  t.mock.method(gapFieldwork, 'assessmentContext', () => ({
    pass: { status: 'completed' }, engagement: null,
    completed: { mobilisation: true, fieldwork: true, validation: true, report: true },
    closure: { ready: true, complete: true, blockers: [], independentlyApprovedReports: 1 }
  }));
  const isms = delivery.getProjection(db, { ...ws, frameworks: ['iso27001'] }, actorId);
  assert.equal(isms.summary.completionReady, true, 'the pre-existing ISMS completion signals are sufficient for ISMS alone');
  const combined = delivery.getProjection(db, ws, actorId);
  assert.equal(combined.summary.completionReady, false);
  assert.equal(combined.summary.combinedFrameworkAssurance.assessmentReviewed, false);
  assert.ok(combined.summary.completionBlockers.some(text => /current ISO 42001 assessment/.test(text)));
  assert.ok(combined.summary.completionBlockers.some(text => /ISO 42001 assessment report.*separate from the ISO 27001 report/.test(text)));
  assert.ok(!combined.summary.completionBlockers.some(text => /Formally close the gap-assessment/.test(text)),
    'do not misleadingly ask to repeat the already completed ISMS closure');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_assessment_passes WHERE workspace_id=?').get(ws.id).c, 0,
    'projection must not manufacture an AI assessment from ISMS completion');
  const synchronized = delivery.syncOutcomePlanStatus(db, ws, actorId);
  assert.equal(synchronized.status, 'active', 'gap-only synchronization obeys the same mixed-framework guard');
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id).status, 'active');
});

test('ISMS certification audit records cannot satisfy the additional AI certification gates', () => {
  const ws = workspace('certification_support');
  db.prepare(`INSERT INTO cert_cycle_events(workspace_id,event_type,status,actual_date)
    VALUES (?,'stage_1','closed','2027-01-01'),(?,'stage_2','closed','2027-02-01')`).run(ws.id, ws.id);
  const projection = delivery.getProjection(db, ws, actorId);
  assert.equal(projection.summary.stage1AuditComplete, true);
  assert.equal(projection.summary.stage2AuditComplete, true);
  assert.equal(projection.summary.combinedFrameworkAssurance.stage1AuditComplete, false);
  assert.equal(projection.summary.combinedFrameworkAssurance.stage2AuditComplete, false);
  assert.equal(projection.summary.combinedFrameworkAssurance.readinessReady, false);
  assert.equal(projection.summary.completionReady, false);
  assert.ok(projection.summary.completionBlockers.some(text => /ISO 42001 Stage 1/.test(text)));
  assert.ok(projection.summary.completionBlockers.some(text => /ISO 42001 Stage 2/.test(text)));
});

test('single-framework and unrelated contracts retain their existing completion behavior', () => {
  const untouchedDb = { prepare() { throw new Error('No combined-framework queries should run.'); } };
  for (const frameworks of [['iso27001'], ['iso42001'], ['csf'], []]) {
    assert.deepEqual(combinedAssurance(untouchedDb, { frameworks }), { applicable: false, ready: true, blockers: [] });
  }
});

test('generic consulting closure cannot bypass the AI plan or the combined contract guard', t => {
  const handlers = {};
  const middleware = (_req, _res, next) => next();
  const helpers = require('../lib/http-helpers');
  require('../routes/consulting-delivery').register({ get() {}, post(route, ...stack) { handlers[route] = stack.at(-1); } }, {
    db, requireAuth: middleware, requireWorkspace: middleware, requirePermission: () => middleware,
    withToast: helpers.withToast, auditCtx: helpers.auditCtx, logAction() {}, listWorkspaces() { return []; }
  });
  const approver = Number(db.prepare(`INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('combined-reviewer@example.test','unused','Reviewer',?,'firm','manager',1)`).run(firmId).lastInsertRowid);
  for (const frameworks of [['iso42001'], ['iso27001', 'iso42001']]) {
    const ws = workspace('gap_assessment_only');
    ws.frameworks = frameworks;
    db.prepare('UPDATE workspaces SET frameworks=? WHERE id=?').run(JSON.stringify(frameworks), ws.id);
    const engagementId = Number(db.prepare(`INSERT INTO consulting_engagements
      (workspace_id,engagement_code,name,engagement_type,framework_scope_json,status,created_by)
      VALUES (?,?,'Controlled engagement','gap_assessment',?,'active',?)`).run(ws.id, `TEST-${ws.id}`, JSON.stringify(frameworks), actorId).lastInsertRowid);
    const plan = delivery.ensurePlan(db, ws, actorId);
    db.prepare('UPDATE engagement_delivery_plans SET consulting_engagement_id=? WHERE id=?').run(engagementId, plan.id);
    db.prepare(`INSERT INTO consulting_report_snapshots
      (workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,generated_by,approved_by,approved_at,published_by,published_at)
      VALUES (?,?,'assessment','Published ISMS report',1,'published','{}',?,?,?,datetime('now'),?,datetime('now'))`)
      .run(ws.id, engagementId, 'a'.repeat(64), actorId, approver, approver);
    // The ISMS route has satisfied every pre-existing gap closure condition.
    // No AI assessment/publication has been performed in either workspace.
    t.mock.method(gapFieldwork, 'assessmentContext', () => ({
      pass: { status: 'completed' }, engagement: { id: engagementId },
      completed: { mobilisation: true, fieldwork: true, validation: true, report: true },
      closure: { ready: true, complete: true, blockers: [], independentlyApprovedReports: 1 }
    }));
    for (const suffix of ['', '/complete-gap-assessment']) {
      const route = `/workspaces/:wsId/delivery/engagements/:id${suffix}`;
      const req = { workspace: ws, user: { id: actorId, user_type: 'firm' }, params: { id: String(engagementId) },
        path: route, headers: {}, body: { status: 'complete', row_version: 1, completion_note: 'Attempt direct completion' } };
      const res = { redirect(url) { this.redirected = url; return this; } };
      handlers[route](req, res);
      assert.match(res.redirected, /toastKind=error/);
      const message = decodeURIComponent(res.redirected);
      assert.match(message, /ISO 42001/);
      if (frameworks.length === 2) assert.match(message, /separate from the ISO 27001 report/);
      assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'active');
      assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id).status, 'active');
    }
  }
});

test('a combined contract closes once its separate ISO 42001 report is approved by a second person and published, and reopens when the assessment changes', t => {
  const ws = workspace('gap_assessment_only');
  t.mock.method(gapFieldwork, 'assessmentContext', () => ({
    pass: { status: 'completed' }, engagement: null,
    completed: { mobilisation: true, fieldwork: true, validation: true, report: true },
    closure: { ready: true, complete: true, blockers: [], independentlyApprovedReports: 1 }
  }));
  // The ISO 42001 assessment is independently reviewed and frozen.
  const assessment = require('../lib/iso42001-assessment');
  let assessmentHash = 'a'.repeat(64);
  t.mock.method(assessment, 'getGapState', () => ({ complete: true, reviewed: true, blockers: [],
    pass: { id: 1, status: 'completed' }, snapshot: { snapshot_hash: assessmentHash } }));
  const aims = require('../lib/iso42001-delivery');
  const { createReportVisibility } = require('../lib/iso42001-client-publication');
  const person = email => Number(db.prepare(`INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES (?,'unused',?,?,'firm','manager',1)`).run(email, email, firmId).lastInsertRowid);
  const author = person('aims-report-author@example.test');
  const approver = person('aims-report-approver@example.test');

  const isms = workspace('gap_assessment_only');
  db.prepare(`UPDATE workspaces SET frameworks='["iso27001"]' WHERE id=?`).run(isms.id);
  const ismsPlan = delivery.ensurePlan(db, { ...isms, frameworks: ['iso27001'] }, author);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key='aims-controlled-report'`).get(ismsPlan.id).c, 0,
    'an ISO 27001-only plan has no ISO 42001 report step');

  const plan = delivery.ensurePlan(db, ws, author);
  delivery.ensurePlan(db, ws, author);
  const steps = db.prepare(`SELECT * FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key='aims-controlled-report'`).all(plan.id);
  assert.equal(steps.length, 1, 'added once, however often the plan is opened');
  const report = db.prepare('SELECT * FROM engagement_delivery_deliverables WHERE milestone_id=?').get(steps[0].id);
  assert.equal(report.framework_code, 'iso42001');
  assert.equal(report.requires_evidence, 1);

  const contents = Buffer.from('ISO 42001 assessment report');
  const evidenceId = Number(db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by)
    VALUES (?,'aims-report.pdf','aims-report.pdf',?,?,?)`).run(ws.id, require('node:crypto').createHash('sha256').update(contents).digest('hex'), contents.length, author).lastInsertRowid);
  db.prepare('INSERT INTO engagement_delivery_evidence(workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)').run(ws.id, report.id, evidenceId, author);
  db.prepare('UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=? WHERE id=?').run(author, approver, report.id);
  delivery.transitionDeliverable(db, ws, author, report.id, 'submit', 'Report prepared from the frozen assessment.');
  assert.throws(() => delivery.transitionDeliverable(db, ws, author, report.id, 'accept', 'Self approval'), /approver/);
  delivery.transitionDeliverable(db, ws, approver, report.id, 'accept', 'Checked against the frozen ISO 42001 assessment.');
  assert.equal(JSON.parse(db.prepare('SELECT evidence_snapshot_json j FROM engagement_delivery_deliverables WHERE id=?').get(report.id).j).assessment_hash, assessmentHash);

  let summary = delivery.getProjection(db, ws, approver).summary;
  assert.deepEqual([summary.combinedFrameworkAssurance.report.accepted, summary.combinedFrameworkAssurance.report.published], [true, false]);
  assert.equal(summary.completionReady, false);
  assert.ok(summary.completionBlockers.some(text => /Publish the approved ISO 42001 assessment report/.test(text)));
  assert.equal(createReportVisibility(db, ws)({ id: report.id }), false, 'the client cannot see it before publication');
  assert.notEqual(delivery.getProjection(db, ws, approver).milestones.find(m => m.milestone_key === 'aims-controlled-report').effective_status, 'complete',
    'acceptance alone does not complete the step');

  assert.throws(() => aims.publishReport(db, ws, author, plan, delivery.event), /approver must publish/);
  aims.publishReport(db, ws, approver, plan, delivery.event);
  const projection = delivery.getProjection(db, ws, approver);
  summary = projection.summary;
  assert.equal(summary.combinedFrameworkAssurance.ready, true, summary.combinedFrameworkAssurance.blockers.join(' '));
  assert.equal(summary.completionReady, true, summary.completionBlockers.join(' '));
  assert.equal(projection.milestones.find(m => m.milestone_key === 'aims-controlled-report').effective_status, 'complete');
  assert.equal(createReportVisibility(db, ws)({ id: report.id }), true);

  // A new reviewed assessment leaves the published report describing an old one.
  assessmentHash = 'b'.repeat(64);
  summary = delivery.getProjection(db, ws, approver).summary;
  assert.equal(summary.combinedFrameworkAssurance.report.accepted, false);
  assert.equal(summary.completionReady, false);
  assert.equal(createReportVisibility(db, ws)({ id: report.id }), false);
});
