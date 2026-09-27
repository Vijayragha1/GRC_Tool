'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-ai-full-delivery-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.ISMS_KEY_FILE = path.join(tmp, 'test.key');
const { db, init } = require('../db');
init();
const assessment = require('../lib/iso42001-assessment');
const aims = require('../lib/iso42001-delivery');
const delivery = require('../lib/engagement-delivery');
const consulting = require('../lib/consulting-delivery');
const writes = require('../lib/control-writes');
const certification = require('../lib/iso42001-certification');
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('complete AI certification delivery passes real assessment, acceptance and phase gates, then reopens on a new certification finding', () => {
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const newUser = (email, name) => Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active) VALUES (?,'unused',?,?,'firm','manager',1)`)
    .run(email, name, firmId).lastInsertRowid);
  const author = newUser('ai-full-author@example.test', 'AI Assessment Author');
  const reviewer = newUser('ai-full-reviewer@example.test', 'Independent AI Reviewer');
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,frameworks,engagement_outcome,scope,created_at)
    VALUES (?,'Full AI certification fixture','["iso42001"]','certification_support','AI support service and its lifecycle','2026-01-01')`)
    .run(firmId).lastInsertRowid);
  const ws = { ...db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId), frameworks: ['iso42001'] };
  const engagement = consulting.ensureEngagement(db, ws, author);
  const plan = delivery.ensurePlan(db, ws, author);
  assert.equal(engagement.engagement_type, 'implementation');

  const evidence = (filename, body, itemId = null) => {
    const contents = Buffer.from(body);
    fs.writeFileSync(path.join(tmp, filename), contents);
    const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    return Number(db.prepare(`INSERT INTO evidence
      (workspace_id,iso_item_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
      VALUES (?,?,?,?,?,?,?,?)`).run(ws.id, itemId, filename, filename, sha256, contents.length, author, body).lastInsertRowid);
  };

  // Real current conclusions and retained history for every AIMS requirement.
  // Each has its own file/hash; the independent review creates the immutable
  // assessment snapshot through the production domain command.
  const passId = assessment.startPass(db, ws.id, author);
  const items = db.prepare('SELECT * FROM iso42001_items ORDER BY sort_order').all();
  assert.equal(items.length, 65);
  for (const item of items) {
    const requirementId = writes.requirementId(db, 'iso42001', item.id);
    const note = `Test fixture: implemented ${item.title}; reviewer examined retained procedure and operating sample.`;
    db.prepare(`INSERT INTO control_instances
      (workspace_id,requirement_id,entity_id,status,applicability,maturity,notes)
      VALUES (?,?,NULL,'implemented','applicable',3,?)`).run(ws.id, requirementId, note);
    evidence(`${item.id}.txt`, `${item.id}: ${note}`, item.id);
    const current = db.prepare('SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(ws.id, item.id);
    db.prepare(`INSERT INTO iso42001_control_state_history
      (workspace_id,iso_item_id,pass_id,changed_by,status,applicability,maturity,inclusion_justification,exclusion_justification,notes,assessment_answers)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ws.id, item.id, passId, author, current.status, current.applicability,
        current.maturity, current.inclusion_justification, current.exclusion_justification, current.notes, current.assessment_answers);
  }
  const signed = assessment.completePass(db, ws.id, passId, reviewer);
  assert.equal(signed.data.items.length, 65);
  assert.equal(signed.reviewed_by, reviewer);
  assert.equal(assessment.getGapState(db, ws.id).complete, true);

  // Native assurance events use the statuses emitted by the current app.
  db.prepare(`INSERT INTO audits(workspace_id,title,scope,audit_date,status,summary,created_by)
    VALUES (?,'AIMS internal audit','ISO 42001 scoped AI service','2026-07-01','complete','All scoped requirements tested; findings closed.',?)`).run(ws.id, reviewer);
  db.prepare(`INSERT INTO mrms(workspace_id,meeting_date,attendees,status,decisions,created_by)
    VALUES (?,'2026-07-15','Sponsor and AI owner','completed','Approved AIMS performance, resources and improvement actions.',?)`).run(ws.id, author);
  const stage1 = Number(db.prepare(`INSERT INTO iso42001_cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'Stage 1 audit','2026-08-01','completed')`).run(ws.id).lastInsertRowid);
  const stage2 = Number(db.prepare(`INSERT INTO iso42001_cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'Stage 2 audit','2026-09-01','completed')`).run(ws.id).lastInsertRowid);
  db.prepare(`INSERT INTO nonconformities(workspace_id,title,source,source_ref,severity,status,corrective_action,effectiveness_check,closed_at)
    VALUES (?,'Closed Stage 1 observation','external_audit',?,'observation','closed','Operating record clarified.','Independent review confirmed effectiveness.','2026-08-15')`)
    .run(ws.id, `iso42001_cert_cycle_event:${stage1}`);
  assert.equal(certification.stage2AssuranceState(db, ws.id).auditComplete, true);

  // Every required deliverable is submitted by its owner and accepted by the
  // assigned independent approver through real shared transition commands.
  const deliverables = db.prepare(`SELECT d.*,m.milestone_key FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id WHERE d.plan_id=? ORDER BY d.id`).all(plan.id);
  assert.ok(deliverables.length > 20);
  let controlledReport;
  for (const item of deliverables) {
    const evidenceId = evidence(`deliverable-${item.id}.txt`, `Accepted test evidence for ${item.title}.`);
    db.prepare('INSERT INTO engagement_delivery_evidence(workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)')
      .run(ws.id, item.id, evidenceId, author);
    db.prepare('UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=? WHERE id=?').run(author, reviewer, item.id);
    delivery.transitionDeliverable(db, ws, author, item.id, 'submit', 'Prepared evidence retained for review.');
    delivery.transitionDeliverable(db, ws, reviewer, item.id, 'accept', 'Examined the retained acceptance evidence.');
    const accepted = db.prepare('SELECT * FROM engagement_delivery_deliverables WHERE id=?').get(item.id);
    assert.equal(accepted.status, 'accepted');
    assert.ok(JSON.parse(accepted.evidence_snapshot_json).evidence.length);
    if (item.milestone_key === 'gap-controlled-report') controlledReport = accepted;
  }
  assert.ok(controlledReport);
  const reviewedGap = aims.gapContext(db, ws);
  assert.equal(reviewedGap.completed.report, false);
  delivery.event(db, ws.id, plan.id, reviewer, 'deliverable', controlledReport.id, 'aims_report_published', 'accepted', 'published', {
    report_id: controlledReport.id, assessment_hash: reviewedGap.snapshotHash, approval_hash: aims.approvalHash(controlledReport)
  });
  assert.equal(aims.gapContext(db, ws).completed.report, true);
  assert.equal(aims.readiness(db, ws).stage2Ready, true);
  assert.equal(delivery.getProjection(db, ws, reviewer).summary.completionReady, false, 'evidence and audits do not skip delivery gates');

  const phases = delivery.getProjection(db, ws, reviewer).phases;
  for (const phase of phases.filter(item => !item.is_continuous)) {
    const current = delivery.getProjection(db, ws, reviewer).phases.find(item => item.id === phase.id);
    if (current.governed) {
      assert.equal(current.effective_status, 'complete', 'reviewed and published AI gap automatically satisfies its governed phase');
    } else {
      assert.equal(current.gate_ready, true, `${current.phase_key}: all required evidence is accepted`);
      delivery.decideGate(db, ws, reviewer, current.id, 'passed', 'Required deliverables and their retained evidence examined.');
    }
  }
  const complete = delivery.getProjection(db, ws, reviewer);
  assert.equal(complete.summary.completionReady, true, complete.summary.completionBlockers.join(' '));
  assert.equal(complete.summary.readinessReady, true);
  assert.equal(complete.summary.stage1AuditComplete, true);
  assert.equal(complete.summary.stage2AuditComplete, true);
  assert.deepEqual(complete.summary.completionBlockers, []);
  delivery.syncOutcomePlanStatus(db, ws, reviewer);
  delivery.syncCertificationEngagementCompletion(db, ws, reviewer);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id).status, 'completed');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagement.id).status, 'complete');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assessment_passes WHERE workspace_id=?').get(ws.id).c, 0, 'no ISMS assessment supplied assurance');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cert_cycle_events WHERE workspace_id=?').get(ws.id).c, 0, 'no ISMS certification records supplied assurance');

  const findingId = Number(db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,severity,status) VALUES (?,'New Stage 2 observation','external_audit',?,'observation','open')`)
    .run(ws.id, `iso42001_cert_cycle_event:${stage2}`).lastInsertRowid);
  const reopened = delivery.reopenForCertificationFinding(db, ws, reviewer, findingId);
  assert.equal(reopened.planReopened, true);
  assert.equal(reopened.engagementReopened, true);
  assert.equal(delivery.getProjection(db, ws, reviewer).summary.completionReady, false);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id).status, 'active');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagement.id).status, 'active');
  assert.equal(assessment.loadSnapshot(db, ws.id, passId).snapshot_hash, signed.snapshot_hash, 'reopening retains the signed assessment history');
});
