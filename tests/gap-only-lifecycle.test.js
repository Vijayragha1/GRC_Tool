'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let firmId;
let managerId;
let reviewerId;

function createWorkspace(outcome, name) {
  return Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,lead_consultant_id,created_at)
    VALUES (?,?,'gap_assessment','["iso27001"]',?,?,datetime('now'))`).run(
      firmId, name, outcome, managerId).lastInsertRowid);
}

function createEngagement(workspaceId, type = 'gap_assessment') {
  const id = Number(db.prepare(`INSERT INTO consulting_engagements
    (workspace_id,engagement_code,name,engagement_type,framework_scope_json,status,lead_consultant_id,created_by)
    VALUES (?,?,?,?,'["iso27001"]','active',?,?)`).run(
      workspaceId, `GAP-${workspaceId}`, 'ISO 27001 gap assessment', type, managerId, managerId).lastInsertRowid);
  db.prepare('INSERT INTO engagement_commercials (engagement_id,updated_by) VALUES (?,?)').run(id, managerId);
  return id;
}

function createFinding(workspaceId, engagementId, status = 'confirmed') {
  return Number(db.prepare(`INSERT INTO consulting_findings
    (workspace_id,engagement_id,finding_ref,title,finding_type,severity,condition_text,criteria_text,effect_text,
     recommendation_text,client_visible,status,created_by,confirmed_by,confirmed_at)
    VALUES (?,?,?,'Access reviews are incomplete','gap','high','Reviews do not cover every privileged account.',
      'Privileged access must be reviewed at planned intervals.','Access may remain beyond business need.',
      'Complete the population and retain review evidence.',1,?,?,?,datetime('now'))`).run(
        workspaceId, engagementId, `F-${engagementId}-001`, status, managerId, reviewerId).lastInsertRowid);
}

function publishAssessmentReport(workspaceId, engagementId) {
  return Number(db.prepare(`INSERT INTO consulting_report_snapshots
    (workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,
     generated_by,approved_by,approved_at,published_by,published_at)
    VALUES (?,?,'assessment','ISO 27001 gap assessment report',1,'published','{}',?,
      ?,?,datetime('now'),?,datetime('now'))`).run(
        workspaceId, engagementId, 'a'.repeat(64), managerId, reviewerId, managerId).lastInsertRowid);
}

function completeGovernedAssessment(workspaceId) {
  const passId = Number(db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,status,started_by,completed_by,completed_at)
    VALUES (?,1,'Gap assessment','completed',?,?,datetime('now'))`).run(
      workspaceId, managerId, reviewerId).lastInsertRowid);
  const decide = db.prepare(`INSERT INTO gap_assessment_phase_decisions
    (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by)
    VALUES (?,?,?,'complete',?,?)`);
  decide.run(workspaceId, passId, 'mobilisation', 'Scope and method approved.', reviewerId);
  decide.run(workspaceId, passId, 'fieldwork', 'All assessment conclusions independently reviewed.', reviewerId);
  decide.run(workspaceId, passId, 'validation', 'Client factual validation concluded.', reviewerId);
  return passId;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId = db.prepare("SELECT id FROM users WHERE email='sec-test@example.com'").get().id;
  reviewerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('gap-lifecycle-reviewer@example.com','not-used','Independent Reviewer',?,'firm','manager',1)`).run(firmId).lastInsertRowid);
});

test.after(async () => {
  if (db) db.close();
  if (client) await client.close();
});

test('gap-only lifecycle ends at the published report in firm and client presentations', async () => {
  const workspaceId = createWorkspace('gap_assessment_only', 'Report Only Client');
  const engagementId = createEngagement(workspaceId);
  createFinding(workspaceId, engagementId);
  completeGovernedAssessment(workspaceId);
  publishAssessmentReport(workspaceId, engagementId);

  const fieldwork = await client.get(`/workspaces/${workspaceId}/gap-assessment/fieldwork`);
  assert.equal(fieldwork.status, 200);
  assert.match(fieldwork.text, /Current governed phase[\s\S]*Report issued - ready for closure/);
  assert.match(fieldwork.text, /Close at the controlled report/);
  assert.doesNotMatch(fieldwork.text, />Post-report</);

  const portal = await client.get(`/workspaces/${workspaceId}/client-portal?preview=client`);
  assert.equal(portal.status, 200);
  assert.match(portal.text, /Report issued - ready for governed closure/);
  assert.match(portal.text, /open as recommendations owned by your organisation/i);
  assert.doesNotMatch(portal.text, />Post-report</);

  const projection = require('../lib/client-gap-assessment').buildClientGapAssessmentProjection(
    db, db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId));
  assert.equal(projection.currentPhase, 'complete');
  assert.equal(projection.currentPhaseLabel, 'Report issued - ready for governed closure');
  assert.equal(projection.assessmentDelivered, true);
  assert.equal(projection.engagementComplete, false);
  assert.equal(projection.contractClosed, false);
  assert.deepEqual(projection.phases.map(phase => phase.key), ['mobilisation', 'fieldwork', 'validation', 'report']);
});

test('gap-only contract closure retains confirmed findings as open recommendations', async () => {
  const workspaceId = createWorkspace('gap_assessment_only', 'Closure Evidence Client');
  const engagementId = createEngagement(workspaceId);
  const findingId = createFinding(workspaceId, engagementId);
  completeGovernedAssessment(workspaceId);
  const reportId = publishAssessmentReport(workspaceId, engagementId);
  const engagement = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagementId);

  const response = await client.post(`/workspaces/${workspaceId}/delivery/engagements/${engagementId}/complete-gap-assessment`, {
    row_version: String(engagement.row_version),
    completion_note: 'Final report handed to the client sponsor.'
  });
  assert.equal(response.status, 302);
  assert.doesNotMatch(response.location, /toastKind=error/);

  const completed = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagementId);
  assert.equal(completed.status, 'complete');
  assert.ok(completed.completed_at);
  assert.match(completed.completion_note, /client-owned improvement recommendation/);
  assert.match(completed.completion_note, /does not represent remediation or finding closure/);
  assert.equal(db.prepare('SELECT status FROM consulting_findings WHERE id=?').get(findingId).status, 'confirmed');

  const event = db.prepare(`SELECT action,details_json FROM consulting_events
    WHERE engagement_id=? AND entity_type='engagement' AND action='completed_at_report' ORDER BY id DESC LIMIT 1`).get(engagementId);
  assert.ok(event);
  assert.equal(JSON.parse(event.details_json).report_id, reportId);
  assert.equal(JSON.parse(event.details_json).open_findings_retained, 1);

  const blockerCount = db.prepare('SELECT COUNT(*) c FROM gap_fieldwork_blockers WHERE workspace_id=?').get(workspaceId).c;
  const retainedMutation = await client.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/blockers`, {
    title: 'Replayed post-closure blocker',
    description: 'This must not alter the retained assessment record.',
    priority: 'high'
  });
  assert.equal(retainedMutation.status, 302);
  assert.match(decodeURIComponent(retainedMutation.location), /formally closed/i);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM gap_fieldwork_blockers WHERE workspace_id=?').get(workspaceId).c, blockerCount);

  const readinessPack = await client.get(`/workspaces/${workspaceId}/export/readiness-pack.zip?stage=1`);
  assert.equal(readinessPack.status, 409);
  assert.match(readinessPack.text, /outside this gap-assessment-only engagement/i);
});

test('gap-only closure is blocked until the governed report and assessment gates are complete', async () => {
  const workspaceId = createWorkspace('gap_assessment_only', 'Incomplete Report Client');
  const engagementId = createEngagement(workspaceId);
  createFinding(workspaceId, engagementId);
  const engagement = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagementId);

  const response = await client.post(`/workspaces/${workspaceId}/delivery/engagements/${engagementId}/complete-gap-assessment`, {
    row_version: String(engagement.row_version)
  });
  assert.equal(response.status, 302);
  assert.match(response.location, /toastKind=error/);
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'active');
});

test('certification-support completion remains blocked while confirmed findings need remediation', async () => {
  const workspaceId = createWorkspace('certification_support', 'Certification Client');
  const engagementId = createEngagement(workspaceId, 'implementation');
  createFinding(workspaceId, engagementId);
  const engagement = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagementId);

  const response = await client.post(`/workspaces/${workspaceId}/delivery/engagements/${engagementId}`, {
    row_version: String(engagement.row_version),
    name: engagement.name,
    status: 'complete',
    completion_note: 'Attempted certification-support completion.'
  });
  assert.equal(response.status, 302);
  assert.match(response.location, /toastKind=error/);
  assert.match(decodeURIComponent(response.location), /confirmed finding/i);
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'active');
});
