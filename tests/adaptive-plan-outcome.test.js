'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-plan-outcome-'));
process.env.DB_PATH = path.join(tmpDir, 'iso27001.db');
process.env.ISMS_KEY_FILE = path.join(tmpDir, 'master.key');

const { db, init } = require('../db');
init();
const delivery = require('../lib/engagement-delivery');

let firmId;
let managerId;
let reviewerId;

function workspace(outcome, name) {
  const id = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,created_at)
    VALUES (?,?,'gap_assessment','["iso27001"]',?,'2026-01-01')`).run(firmId, name, outcome).lastInsertRowid);
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = ['iso27001'];
  return row;
}

function engagement(ws, type, status = 'active') {
  const id = Number(db.prepare(`INSERT INTO consulting_engagements
    (workspace_id,engagement_code,name,engagement_type,framework_scope_json,status,lead_consultant_id,created_by,
     completed_at)
    VALUES (?,?,?,?, '["iso27001"]',?,?,?,CASE WHEN ?='complete' THEN datetime('now') END)`).run(
      ws.id, `ENG-${ws.id}-${Date.now()}`, `${ws.client_name} delivery`, type, status, managerId, managerId, status).lastInsertRowid);
  db.prepare('INSERT INTO engagement_commercials (engagement_id,updated_by) VALUES (?,?)').run(id, managerId);
  return id;
}

function governedGapRecords(ws, engagementId) {
  const passId = Number(db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,status,started_by,completed_by,completed_at)
    VALUES (?,1,'Governed gap assessment','completed',?,?,datetime('now'))`).run(
      ws.id, managerId, reviewerId).lastInsertRowid);
  const decision = db.prepare(`INSERT INTO gap_assessment_phase_decisions
    (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by)
    VALUES (?,?,?,'complete','Independent decision retained.',?)`);
  for (const phase of ['mobilisation', 'fieldwork', 'validation']) decision.run(ws.id, passId, phase, reviewerId);
  db.prepare(`INSERT INTO consulting_report_snapshots
    (workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,
     generated_by,approved_by,approved_at,published_by,published_at)
    VALUES (?,?,'assessment','ISO 27001 gap assessment report',1,'published','{}',?,
      ?,?,datetime('now'),?,datetime('now'))`).run(
        ws.id, engagementId, 'b'.repeat(64), managerId, reviewerId, managerId);
}

test.before(() => {
  firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  reviewerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('plan-outcome-reviewer@example.com','not-used','Plan Outcome Reviewer',?,'firm','manager',1)`).run(firmId).lastInsertRowid);
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('gap-only projection exposes only the governed report journey while retaining future rows for conversion', () => {
  const ws = workspace('gap_assessment_only', 'Report Journey Client');
  const plan = delivery.ensurePlan(db, ws, managerId);
  const projection = delivery.getProjection(db, ws, managerId);

  assert.equal(plan.name, 'ISO 27001 gap assessment delivery plan');
  assert.match(plan.objective, /independently approve and publish the report/i);
  assert.match(plan.completion_criteria, /formally closed/i);
  assert.deepEqual(projection.phases.map(phase => phase.phase_key), ['gap_assessment']);
  assert.deepEqual(projection.milestones.map(milestone => milestone.milestone_key), [
    'gap-fieldwork-validation', 'gap-controlled-report'
  ]);
  assert.equal(projection.outcome.gapOnly, true);
  assert.equal(projection.summary.completionReady, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_phases WHERE plan_id=?').get(plan.id).c, 12,
    'future certification phases remain retained for a one-way contract expansion');
  assert.ok(db.prepare(`SELECT 1 FROM engagement_delivery_phases WHERE plan_id=? AND phase_key='stage_2'`).get(plan.id));

  const hidden = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases p ON p.id=m.phase_id
    WHERE m.plan_id=? AND p.phase_key='context' LIMIT 1`).get(plan.id);
  assert.throws(() => delivery.addDependency(db, ws, managerId, projection.milestones[0].id, hidden.id, 'finish_to_start', 0),
    /different milestones|contracted/i);
});

test('full certification projection inserts governed gap assessment before implementation and keeps surveillance non-blocking', () => {
  const ws = workspace('certification_support', 'Certification Journey Client');
  const plan = delivery.ensurePlan(db, ws, managerId);
  const projection = delivery.getProjection(db, ws, managerId);
  const keys = projection.phases.map(phase => phase.phase_key);

  assert.equal(plan.name, 'ISO 27001 certification support delivery plan');
  assert.equal(keys.length, 12);
  assert.ok(keys.indexOf('mobilisation') < keys.indexOf('gap_assessment'));
  assert.ok(keys.indexOf('gap_assessment') < keys.indexOf('context'));
  assert.ok(keys.indexOf('stage_1') < keys.indexOf('stage_2'));
  assert.ok(keys.indexOf('stage_2') < keys.indexOf('continuous'));
  assert.equal(projection.phases.find(phase => phase.phase_key === 'continuous').is_continuous, 1);
  assert.equal(db.prepare(`SELECT title FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w11-stage1'`).get(plan.id).title,
    'Support and represent client during Stage 1 audit');
  assert.match(plan.completion_criteria, /dated Stage 1 and Stage 2 certification audits/i);
});

test('gap-only completion follows governed closure and contract expansion reactivates a customized plan', () => {
  const ws = workspace('gap_assessment_only', 'Governed Closure Client');
  const engagementId = engagement(ws, 'gap_assessment');
  const plan = delivery.ensurePlan(db, ws, managerId);
  db.prepare('UPDATE engagement_delivery_plans SET consulting_engagement_id=? WHERE id=?').run(engagementId, plan.id);
  governedGapRecords(ws, engagementId);

  let projection = delivery.getProjection(db, ws, managerId);
  assert.equal(projection.summary.reportPublished, true);
  assert.equal(projection.summary.gapClosureReady, true);
  assert.equal(projection.summary.completionReady, false, 'publication alone is not formal contract closure');
  assert.match(projection.summary.completionBlockers.join(' '), /formally close/i);

  db.prepare(`UPDATE consulting_engagements SET status='complete',completed_at=datetime('now') WHERE id=?`).run(engagementId);
  const synced = delivery.syncOutcomePlanStatus(db, ws, managerId);
  assert.equal(synced.changed, true);
  projection = delivery.getProjection(db, ws, managerId);
  assert.equal(projection.summary.completionReady, true);
  assert.equal(projection.plan.status, 'completed');
  assert.equal(projection.phases[0].effective_status, 'complete');

  db.prepare(`UPDATE engagement_delivery_plans SET
    name='Client-specific delivery record',objective='Client-approved custom objective',completion_criteria='Client-approved custom closure text'
    WHERE id=?`).run(plan.id);
  db.prepare(`UPDATE workspaces SET engagement_outcome='certification_support' WHERE id=?`).run(ws.id);
  ws.engagement_outcome = 'certification_support';
  const expanded = delivery.ensurePlan(db, ws, managerId);
  assert.equal(expanded.id, plan.id);
  assert.equal(expanded.status, 'active');
  assert.equal(expanded.name, 'Client-specific delivery record');
  assert.equal(expanded.objective, 'Client-approved custom objective');
  assert.equal(expanded.completion_criteria, 'Client-approved custom closure text');
  assert.equal(delivery.getProjection(db, ws, managerId).phases.length, 12);
});

test('existing plans receive the gap checkpoint additively without overwriting customized metadata or row identity', () => {
  const ws = workspace('certification_support', 'Additive Repair Client');
  const plan = delivery.ensurePlan(db, ws, managerId);
  const retained = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    WHERE m.plan_id=? AND m.milestone_key='w2-assets'`).get(plan.id);
  const gapPhase = db.prepare(`SELECT id FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='gap_assessment'`).get(plan.id);
  db.prepare(`UPDATE engagement_delivery_plans SET name='Custom programme',objective='Custom objective',
    completion_criteria='Custom criteria' WHERE id=?`).run(plan.id);
  db.prepare('DELETE FROM engagement_delivery_phases WHERE id=?').run(gapPhase.id);

  const repaired = delivery.ensurePlan(db, ws, managerId);
  assert.equal(repaired.id, plan.id);
  assert.equal(repaired.name, 'Custom programme');
  assert.equal(repaired.objective, 'Custom objective');
  assert.equal(repaired.completion_criteria, 'Custom criteria');
  assert.equal(db.prepare(`SELECT id FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w2-assets'`).get(plan.id).id, retained.id);
  assert.deepEqual(db.prepare(`SELECT milestone_key FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key LIKE 'gap-%' ORDER BY id`).all(plan.id).map(row => row.milestone_key),
    ['gap-fieldwork-validation', 'gap-controlled-report']);
});

test('full completion blockers include consulting findings, workpapers and client RFIs', () => {
  const ws = workspace('certification_support', 'Consulting Closure Client');
  const engagementId = engagement(ws, 'implementation');
  const plan = delivery.ensurePlan(db, ws, managerId);
  db.prepare('UPDATE engagement_delivery_plans SET consulting_engagement_id=? WHERE id=?').run(engagementId, plan.id);
  const requirementId = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code='iso27001' ORDER BY r.sort_order LIMIT 1`).get().id;
  db.prepare(`INSERT INTO consultant_workpapers
    (workspace_id,engagement_id,requirement_id,workpaper_ref,title,status,owner_id,prepared_by,created_by)
    VALUES (?,?,?,?,'Open assessment workpaper','draft',?,?,?)`).run(
      ws.id, engagementId, requirementId, `WP-${ws.id}`, managerId, managerId, managerId);
  db.prepare(`INSERT INTO client_requests
    (workspace_id,engagement_id,request_type,title,status,created_by)
    VALUES (?,?,'evidence','Outstanding evidence RFI','open',?)`).run(ws.id, engagementId, managerId);
  db.prepare(`INSERT INTO consulting_findings
    (workspace_id,engagement_id,finding_ref,title,finding_type,severity,condition_text,criteria_text,
     effect_text,recommendation_text,client_visible,status,created_by,confirmed_by,confirmed_at)
    VALUES (?,?,?,'Confirmed gap finding','gap','high','Condition','Criteria','Effect','Recommendation',1,'confirmed',?,?,datetime('now'))`).run(
      ws.id, engagementId, `F-${ws.id}`, managerId, reviewerId);

  const summary = delivery.getProjection(db, ws, managerId).summary;
  assert.equal(summary.openConsultingWorkpapers, 1);
  assert.equal(summary.openConsultingRequests, 1);
  assert.equal(summary.openConsultingFindings, 1);
  assert.match(summary.completionBlockers.join(' '), /workpaper/i);
  assert.match(summary.completionBlockers.join(' '), /RFI/i);
  assert.match(summary.completionBlockers.join(' '), /consulting finding/i);
  assert.equal(summary.completionReady, false);
});

test('a late Stage 1 or Stage 2 finding reopens both completed delivery records with an event trail', () => {
  for (const auditStage of ['stage_1', 'stage_2']) {
    const ws = workspace('certification_support', `Late ${auditStage} Finding Client`);
    const engagementId = engagement(ws, 'implementation', 'complete');
    const plan = delivery.ensurePlan(db, ws, managerId);
    db.prepare(`UPDATE engagement_delivery_plans SET status='completed',consulting_engagement_id=? WHERE id=?`).run(engagementId, plan.id);
    const eventId = Number(db.prepare(`INSERT INTO cert_cycle_events
      (workspace_id,event_type,actual_date,status,certification_body)
      VALUES (?,?,'2027-09-01','closed','Independent Certification Body')`).run(ws.id, auditStage).lastInsertRowid);
    const findingId = Number(db.prepare(`INSERT INTO nonconformities
      (workspace_id,title,source,source_ref,severity,status)
      VALUES (?,'Late certification observation','external_audit',?,'observation','open')`).run(
        ws.id, `cert_cycle_event:${eventId}`).lastInsertRowid);

    const reopened = delivery.reopenForCertificationFinding(db, ws, managerId, findingId);
    assert.equal(reopened.planReopened, true);
    assert.equal(reopened.engagementReopened, true);
    assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id).status, 'active');
    assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'active');
    const planEvent = db.prepare(`SELECT details FROM engagement_delivery_events
      WHERE plan_id=? AND action='reopened_for_certification_finding' ORDER BY id DESC LIMIT 1`).get(plan.id);
    assert.equal(JSON.parse(planEvent.details).audit_stage, auditStage);
    const consultingEvent = db.prepare(`SELECT details_json FROM consulting_events
      WHERE engagement_id=? AND action='reopened_for_certification_finding' ORDER BY id DESC LIMIT 1`).get(engagementId);
    assert.equal(JSON.parse(consultingEvent.details_json).finding_id, findingId);
  }
});
