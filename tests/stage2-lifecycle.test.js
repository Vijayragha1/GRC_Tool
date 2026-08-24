'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-stage2-'));
process.env.DB_PATH = path.join(tmpDir, 'iso27001.db');
process.env.ISMS_KEY_FILE = path.join(tmpDir, 'master.key');

const { db, init } = require('../db');
init();
const delivery = require('../lib/engagement-delivery');

let workspace;
let managerId;

test.before(() => {
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,target_cert_date,created_at)
    VALUES (?,'Stage 2 Lifecycle Client','implementation','2027-12-31','2026-01-01')`).run(firmId).lastInsertRowid);
  workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('delivery plan includes Stage 2 representation, remediation, then transition', () => {
  const plan = delivery.ensurePlan(db, workspace, managerId);
  const stage2 = db.prepare(`SELECT * FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='stage_2'`).get(plan.id);
  const milestones = db.prepare(`SELECT id,milestone_key,title FROM engagement_delivery_milestones
    WHERE phase_id=? ORDER BY id`).all(stage2.id);

  assert.deepEqual(milestones.map(row => row.milestone_key), [
    'w12-stage2-audit', 'w12-stage2-remediation', 'w12-handoff'
  ]);
  assert.equal(milestones[0].title, 'Support and represent client during Stage 2 audit');
  assert.equal(milestones[1].title, 'Resolve Stage 2 nonconformities and observations');
  assert.equal(milestones[2].title, 'Close the engagement and transition the certified ISMS');
  assert.match(plan.completion_criteria, /no open Stage 1 or Stage 2 nonconformities or observations/i);
  assert.equal(db.prepare(`SELECT title FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w11-stage1'`).get(plan.id).title,
    'Support and represent client during Stage 1 audit');

  const links = db.prepare(`SELECT pre.milestone_key predecessor,post.milestone_key successor
    FROM engagement_delivery_dependencies dep
    JOIN engagement_delivery_milestones pre ON pre.id=dep.predecessor_milestone_id
    JOIN engagement_delivery_milestones post ON post.id=dep.successor_milestone_id
    WHERE dep.plan_id=?`).all(plan.id);
  const linkSet = new Set(links.map(link => `${link.predecessor}->${link.successor}`));
  assert.ok(linkSet.has('w11-remediation->w12-stage2-audit'));
  assert.ok(linkSet.has('w12-stage2-audit->w12-stage2-remediation'));
  assert.ok(linkSet.has('w12-stage2-remediation->w12-handoff'));
});

test('existing plans are repaired additively without replacing retained rows', () => {
  const plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(workspace.id);
  const handoff = db.prepare(`SELECT * FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w12-handoff'`).get(plan.id);
  const stage1 = db.prepare(`SELECT * FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w11-stage1'`).get(plan.id);
  db.transaction(() => {
    db.prepare(`DELETE FROM engagement_delivery_milestones
      WHERE plan_id=? AND milestone_key IN ('w12-stage2-audit','w12-stage2-remediation')`).run(plan.id);
    db.prepare(`UPDATE engagement_delivery_milestones
      SET title='Hand engagement to client for Stage 2 audit',description='Handover pack: residual risks, year-1 surveillance plan'
      WHERE id=?`).run(handoff.id);
    db.prepare(`UPDATE engagement_delivery_deliverables
      SET title='Handover pack: residual risks, year-1 surveillance plan',client_title='Ongoing assurance and surveillance plan'
      WHERE milestone_id=?`).run(handoff.id);
    db.prepare(`UPDATE engagement_delivery_phases SET name='Stage 2 & transition',description='Final handover and transition into certification operations.'
      WHERE plan_id=? AND phase_key='stage_2'`).run(plan.id);
    db.prepare(`UPDATE engagement_delivery_phases SET description='External Stage 1 audit and closure of resulting nonconformities.'
      WHERE plan_id=? AND phase_key='stage_1'`).run(plan.id);
    db.prepare(`UPDATE engagement_delivery_milestones
      SET title='Stage 1 certification audit (documentation review)',description='Certifier Stage 1 report; minor NCs catalogued'
      WHERE id=?`).run(stage1.id);
    db.prepare(`UPDATE engagement_delivery_plans SET completion_criteria=? WHERE id=?`).run(
      'All required implementation phase gates passed or explicitly waived; readiness hard gates passed; no unresolved critical blockers; transition deliverables accepted; continuous operating cycle activated.',
      plan.id
    );
  })();

  const repaired = delivery.ensurePlan(db, workspace, managerId);
  assert.equal(repaired.id, plan.id);
  assert.equal(db.prepare(`SELECT id FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key='w12-handoff'`).get(plan.id).id, handoff.id);
  assert.equal(db.prepare(`SELECT id FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key='w11-stage1'`).get(plan.id).id, stage1.id);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM engagement_delivery_milestones WHERE plan_id=?`).get(plan.id).c, 31);
  assert.equal(db.prepare(`SELECT title FROM engagement_delivery_milestones WHERE id=?`).get(handoff.id).title,
    'Close the engagement and transition the certified ISMS');
  assert.equal(db.prepare(`SELECT title FROM engagement_delivery_milestones WHERE id=?`).get(stage1.id).title,
    'Support and represent client during Stage 1 audit');
  assert.match(db.prepare(`SELECT description FROM engagement_delivery_phases WHERE plan_id=? AND phase_key='stage_1'`).get(plan.id).description,
    /Stage 1 representation.*nonconformity and observation/i);
  assert.match(db.prepare(`SELECT description FROM engagement_delivery_phases WHERE plan_id=? AND phase_key='stage_2'`).get(plan.id).description,
    /Stage 2 representation.*nonconformity and observation/i);
  assert.match(repaired.completion_criteria, /observations/i);
});

test('certification findings retain stage lineage and every open observation blocks Stage 2 closure', () => {
  const stage1Id = Number(db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status,certification_body)
    VALUES (?,'stage_1','2027-08-01','closed','Test Certification Body')`).run(workspace.id).lastInsertRowid);
  const stage2Id = Number(db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status,certification_body)
    VALUES (?,'stage_2','2027-09-15','closed','Test Certification Body')`).run(workspace.id).lastInsertRowid);
  const majorId = Number(db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'Stage 2 major','external_audit',?,'major','open')`).run(workspace.id, `cert_cycle_event:${stage2Id}`).lastInsertRowid);
  const observationId = Number(db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'Stage 2 observation','external_audit',?,'observation','open')`).run(workspace.id, `cert_cycle_event:${stage2Id}`).lastInsertRowid);

  assert.equal(delivery.certificationAuditState(db, workspace.id, 'stage_1').auditComplete, true);
  assert.equal(stage1Id > 0, true);
  let stage2 = delivery.stage2AssuranceState(db, workspace.id);
  assert.equal(stage2.auditComplete, true);
  assert.equal(stage2.openMaterialFindings, 1);
  assert.equal(stage2.openObservations, 1);
  assert.equal(stage2.allClear, false);

  const validationEvidenceId = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by)
    VALUES (?,'certification-validation.pdf','certification-validation.pdf',?,128,?)`)
    .run(workspace.id, 'c'.repeat(64), managerId).lastInsertRowid);
  const linkValidation = db.prepare(`INSERT INTO nonconformity_evidence_links
    (workspace_id,nonconformity_id,evidence_id,evidence_role,linked_by)
    VALUES (?,?,?,'validation',?)`);
  linkValidation.run(workspace.id, majorId, validationEvidenceId, managerId);
  linkValidation.run(workspace.id, observationId, validationEvidenceId, managerId);

  db.prepare(`UPDATE nonconformities SET root_cause='The certification control owner was not assigned.',
    corrective_action='Assign the control owner and complete the corrective action.',
    effectiveness_check='Independent validation confirmed the corrective action operates.',
    status='verified',closed_at=datetime('now') WHERE id=?`).run(majorId);
  stage2 = delivery.stage2AssuranceState(db, workspace.id);
  assert.equal(stage2.openMaterialFindings, 0);
  assert.equal(stage2.openObservations, 1);
  assert.equal(stage2.allClear, false, 'an observation still requires resolution before engagement completion');

  db.prepare(`UPDATE nonconformities SET corrective_action='Update the retained operating record.',
    effectiveness_check='Independent validation confirmed the observation was resolved.',
    status='closed',closed_at=datetime('now') WHERE id=?`).run(observationId);
  stage2 = delivery.stage2AssuranceState(db, workspace.id);
  assert.equal(stage2.openFindings, 0);
  assert.equal(stage2.allClear, true);
});

test('continuous surveillance is outside completion while Stage 2 audit and finding closure remain mandatory', () => {
  const phases = [
    { is_continuous: 0, effective_status: 'complete' },
    { is_continuous: 0, effective_status: 'waived' },
    { is_continuous: 1, effective_status: 'not_started' }
  ];
  const clear = delivery.certificationCompletionState(phases, true, 0, {
    auditComplete: true, openMaterialFindings: 0, openObservations: 0, openFindings: 0
  });
  assert.equal(clear.completionReady, true);
  assert.equal(clear.requiredPhases.length, 2);

  assert.equal(delivery.certificationCompletionState(phases, true, 0, {
    auditComplete: false, openFindings: 0
  }).completionReady, false);
  assert.equal(delivery.certificationCompletionState(phases, true, 0, {
    auditComplete: true, openMaterialFindings: 0, openObservations: 1, openFindings: 1
  }).completionReady, false);
  assert.equal(delivery.certificationCompletionState(phases, true, 0, {
    auditComplete: true, openFindings: 0
  }, {
    auditComplete: false, openFindings: 0
  }).completionReady, false, 'a waived Stage 1 phase cannot replace the actual certification audit');
  assert.equal(delivery.certificationCompletionState(phases, true, 0, {
    auditComplete: true, openFindings: 0
  }, {
    auditComplete: true, openFindings: 1, openObservations: 1
  }).completionReady, false, 'Stage 1 observations must also be closed');
});
