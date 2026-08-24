'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');

let env;
let db;
let domain;
let ids;

function token(label) {
  return crypto.createHash('sha256').update(`tprm-condition-governance:${label}`).digest('hex');
}

function addUser({ email, name, userType, firmId, firmRole = null }) {
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, '!test-only', name, userType, firmId, firmRole).lastInsertRowid);
}

function addSupplier(name) {
  return Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,?,?,'prospect','tier_2')`).run(ids.workspaceId, name, `${name} managed service`).lastInsertRowid);
}

function issueDecisionCycle(supplierId) {
  const cycle = domain.ensureCurrentCycle(db, {
    workspaceId: ids.workspaceId, supplierId, actorId: ids.consultantId,
    cycleType: 'onboarding', clientDecisionAuthorityId: ids.clientOwnerId,
  }).cycle;
  const recommendationId = Number(db.prepare(`INSERT INTO tprm_recommendations
    (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
     residual_risk_score,residual_risk_band,readiness_snapshot_json,artifact_snapshot_json,
     recommendation_hash,issued_by,issuer_name,quality_reviewed_by,quality_reviewer_name,
     quality_review_rationale)
    VALUES (?,?,?,1,'recommend_with_conditions',
      'Independent due diligence supports onboarding with a governed client-owned condition.',
      'The condition must be completed by the assigned client owner and independently verified.',
      42,'moderate','{}','{}',?,?,?,?,?,?)`).run(
        ids.workspaceId, supplierId, cycle.id, token(`recommendation-${supplierId}`),
        ids.consultantId, 'Condition Consultant', ids.managerId, 'Condition Manager',
        'Independent quality review confirmed the exact recommendation and condition.'
      ).lastInsertRowid);
  const decisionId = Number(db.prepare(`INSERT INTO tprm_client_decisions
    (workspace_id,supplier_id,cycle_id,version,recommendation_id,recommendation_version,
     decision,rationale,diverges_from_recommendation,client_actor_user_id,client_actor_name,
     client_actor_title,authority_basis,decision_snapshot_json,decision_hash)
    VALUES (?,?,?,?,?,1,'onboard_with_conditions',?,0,?,?,?,?,?,?)`).run(
      ids.workspaceId, supplierId, cycle.id, 1, recommendationId,
      'The client authorises onboarding only after the recorded condition is completed and reviewed.',
      ids.clientOwnerId, 'Assigned Client Owner', 'Chief Information Security Officer',
      'Delegated third-party onboarding authority', '{}', token(`decision-${supplierId}`)
    ).lastInsertRowid);
  db.prepare(`UPDATE tprm_assessment_cycles
    SET status='completed',completed_at=datetime('now'),row_version=row_version+1
    WHERE id=? AND status='active'`).run(cycle.id);
  return { cycleId: cycle.id, recommendationId, decisionId };
}

function addCondition(decision, title) {
  return Number(db.prepare(`INSERT INTO tprm_conditions
    (workspace_id,supplier_id,cycle_id,source_type,client_decision_id,condition_type,
     title,description,severity,owner_type,owner_user_id,owner_name,due_date,
     verification_criteria,created_by)
    VALUES (?,?,?,'client_decision',?,'control',?,?,
      'high','client',?,'Assigned Client Owner','2028-01-31',?,?)`).run(
        ids.workspaceId, ids.conditionSupplierId, decision.cycleId, decision.decisionId,
        title, `${title} must be completed before unrestricted production use is permitted.`,
        ids.clientOwnerId,
        'Inspect the approved standard and a current configuration export for the in-scope service.',
        ids.clientOwnerId
      ).lastInsertRowid);
}

test.before(() => {
  env = bootApp();
  db = new Database(env.dbPath);
  domain = require('../lib/tprm-domain');
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const managerId = addUser({
    email: 'condition-manager@test.local', name: 'Condition Manager',
    userType: 'firm', firmId, firmRole: 'manager',
  });
  const consultantId = addUser({
    email: 'condition-consultant@test.local', name: 'Condition Consultant',
    userType: 'firm', firmId, firmRole: 'consultant',
  });
  const clientOwnerId = addUser({
    email: 'condition-owner@test.local', name: 'Assigned Client Owner',
    userType: 'client', firmId,
  });
  const otherClientId = addUser({
    email: 'condition-other@test.local', name: 'Other Client Owner',
    userType: 'client', firmId,
  });
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,frameworks) VALUES (?,'Condition Governance Client','[]')`).run(firmId).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')")
    .run(workspaceId, clientOwnerId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')")
    .run(workspaceId, otherClientId);
  ids = { firmId, managerId, consultantId, clientOwnerId, otherClientId, workspaceId };
  const module = domain.enableModule(db, {
    workspaceId, serviceModel: 'managed_lifecycle', actorId: managerId,
    reason: 'Enable the production condition-governance test service period.',
  }).module;
  ids.moduleId = module.id;
  ids.conditionSupplierId = addSupplier('Condition Lifecycle Provider');
  const decision = issueDecisionCycle(ids.conditionSupplierId);
  ids.decision = decision;
  ids.conditionId = addCondition(decision, 'Deploy phishing-resistant privileged access');
  ids.waiverConditionId = addCondition(decision, 'Complete secondary recovery exercise');
});

test.after(() => {
  if (db) db.close();
  if (env?.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test('assigned client owner submits, consultancy requests changes and independently verifies', () => {
  const open = db.prepare('SELECT * FROM tprm_conditions WHERE id=?').get(ids.conditionId);
  assert.throws(() => domain.clientStartConditionWork(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.otherClientId, expectedStatus: 'open',
  }), error => error.code === 'TPRM_CONDITION_CLIENT_OWNER_REQUIRED');

  const started = domain.clientStartConditionWork(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.clientOwnerId, expectedStatus: 'open',
    idempotencyKey: token('start-condition'),
  });
  assert.equal(started.condition.status, 'in_progress');
  assert.equal(started.condition.row_version, open.row_version + 1);

  assert.throws(() => db.prepare("UPDATE tprm_conditions SET status='waived',row_version=row_version+1 WHERE id=?")
    .run(open.id), /requires its append-only governed event|invalid governed/);

  const firstSubmission = domain.clientSubmitCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.clientOwnerId,
    expectedRowVersion: started.condition.row_version,
    completionStatement: 'The approved standard is effective and phishing-resistant MFA now protects every privileged production account.',
    evidence: {
      originalFilename: 'privileged-access-export.pdf', storedPath: 'condition-evidence-first.pdf',
      mimeType: 'application/pdf', sizeBytes: 2048, sha256: token('evidence-first'),
    },
    idempotencyKey: token('submit-condition-first'),
  });
  assert.equal(firstSubmission.condition.status, 'evidence_submitted');
  assert.equal(firstSubmission.evidence.sha256, token('evidence-first'));
  assert.throws(() => db.prepare('UPDATE tprm_condition_evidence_links SET original_filename=? WHERE id=?')
    .run('tampered.pdf', firstSubmission.evidence.id), /immutable/);

  assert.throws(() => domain.verifyCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.clientOwnerId,
    expectedRowVersion: firstSubmission.condition.row_version,
    reviewNote: 'The client attempted to self-verify the condition.',
  }), error => error.code === 'TPRM_FIRM_ACTOR_REQUIRED');

  const changes = domain.requestConditionChanges(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.consultantId,
    expectedRowVersion: firstSubmission.condition.row_version,
    reviewNote: 'The export omits the break-glass account; include that account and the current enforcement state.',
    idempotencyKey: token('request-condition-changes'),
  });
  assert.equal(changes.condition.status, 'in_progress');
  assert.throws(() => domain.clientSubmitCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.clientOwnerId,
    expectedRowVersion: firstSubmission.condition.row_version,
    completionStatement: 'This stale client submission must be rejected before it can change the condition.',
  }), error => error.code === 'TPRM_STALE_CONDITION');

  const resubmitted = domain.clientSubmitCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.clientOwnerId,
    expectedRowVersion: changes.condition.row_version,
    completionStatement: 'The revised export now includes the break-glass account and confirms phishing-resistant MFA enforcement.',
    idempotencyKey: token('submit-condition-second'),
  });
  assert.equal(resubmitted.evidence, null, 'supporting evidence is optional when the completion statement is sufficient');
  const verified = domain.verifyCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: open.id, actorId: ids.consultantId,
    expectedRowVersion: resubmitted.condition.row_version,
    reviewNote: 'The approved standard and revised configuration export were independently inspected and meet the criterion.',
    idempotencyKey: token('verify-condition'),
  });
  assert.equal(verified.condition.status, 'verified');
  assert.equal(verified.condition.verified_by, ids.consultantId);

  const events = db.prepare('SELECT * FROM tprm_condition_events WHERE condition_id=? ORDER BY id').all(open.id);
  assert.deepEqual(events.map(event => event.event_type), [
    'work_started', 'evidence_submitted', 'changes_requested', 'evidence_submitted', 'verified',
  ]);
  for (let index = 1; index < events.length; index++) {
    assert.equal(events[index].previous_event_hash, events[index - 1].event_hash);
  }
  assert.throws(() => db.prepare('DELETE FROM tprm_condition_events WHERE id=?').run(events[0].id), /cannot be deleted/);
});

test('only a manager can grant an explicit expiring waiver', () => {
  const condition = db.prepare('SELECT * FROM tprm_conditions WHERE id=?').get(ids.waiverConditionId);
  assert.throws(() => domain.waiveCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: condition.id, actorId: ids.consultantId,
    expectedRowVersion: condition.row_version,
    rationale: 'The consultant attempted to exercise manager waiver authority.',
    expiresAt: '2028-03-31',
  }), error => error.code === 'TPRM_MANAGER_REQUIRED');
  assert.throws(() => domain.waiveCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: condition.id, actorId: ids.managerId,
    expectedRowVersion: condition.row_version,
    rationale: 'The manager supplied an expired waiver date for a current condition.',
    expiresAt: '2020-01-01',
  }), error => error.code === 'TPRM_CONDITION_WAIVER_EXPIRY');
  const waived = domain.waiveCondition(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: condition.id, actorId: ids.managerId,
    expectedRowVersion: condition.row_version,
    rationale: 'Temporary waiver approved while the contracted recovery facility completes its scheduled maintenance.',
    expiresAt: '2028-03-31', idempotencyKey: token('waive-condition'),
  });
  assert.equal(waived.condition.status, 'waived');
  assert.equal(waived.condition.waiver_expires_at, '2028-03-31');
  assert.equal(waived.event.actor_type, 'consultancy_manager');
  assert.equal(domain.conditionEffectiveStatus(waived.condition, '2028-03-31'), 'waived',
    'the waiver remains effective through its stated expiry date');
  assert.equal(domain.conditionEffectiveStatus(waived.condition, '2028-04-01'), 'waiver_expired');
  const operative = domain.listConditions(db, ids.workspaceId, ids.conditionSupplierId, {
    status: ['waiver_expired'], asOfDate: '2028-04-01',
  });
  assert.deepEqual(operative.map(row => row.id), [condition.id]);
  assert.throws(() => domain.closeModule(db, {
    workspaceId: ids.workspaceId, actorId: ids.managerId,
    expectedModuleId: ids.moduleId, asOfDate: '2028-04-01',
    reason: 'An expired condition waiver must block service-period closure.',
  }), error => error.code === 'TPRM_OPEN_CONDITIONS');
});

test('cycle cancellation is pre-issue only and service-period closure has no force bypass', () => {
  const cancellableSupplierId = addSupplier('Cancellable Assessment Provider');
  const cancellable = domain.ensureCurrentCycle(db, {
    workspaceId: ids.workspaceId, supplierId: cancellableSupplierId,
    actorId: ids.consultantId, triggerReason: 'Start a cycle that is later cancelled before issue.',
  }).cycle;
  const cancelled = domain.cancelAssessmentCycle(db, {
    workspaceId: ids.workspaceId, supplierId: cancellableSupplierId,
    cycleId: cancellable.id, actorId: ids.consultantId,
    expectedRowVersion: cancellable.row_version,
    reason: 'The proposed service scope was withdrawn before due diligence began.',
  });
  assert.equal(cancelled.cycle.status, 'cancelled');
  const replacement = domain.ensureCurrentCycle(db, {
    workspaceId: ids.workspaceId, supplierId: cancellableSupplierId,
    actorId: ids.consultantId, triggerReason: 'Start a new assessment for the revised service scope.',
  }).cycle;
  assert.equal(replacement.cycle_number, cancellable.cycle_number + 1);

  const issuedSupplierId = addSupplier('Issued Recommendation Provider');
  const issuedCycle = domain.ensureCurrentCycle(db, {
    workspaceId: ids.workspaceId, supplierId: issuedSupplierId, actorId: ids.consultantId,
  }).cycle;
  db.prepare(`INSERT INTO tprm_recommendations
    (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
     residual_risk_band,readiness_snapshot_json,artifact_snapshot_json,recommendation_hash,
     issued_by,issuer_name,quality_reviewed_by,quality_reviewer_name,quality_review_rationale)
    VALUES (?,?,?,1,'insufficient_information',
      'The issued conclusion requests more evidence before any onboarding decision.',
      'Material evidence remains unavailable and the assessment cannot reach a positive conclusion.',
      'unknown','{}','{}',?,?,?,?,?,?)`).run(
        ids.workspaceId, issuedSupplierId, issuedCycle.id, token('issued-cancel-block'),
        ids.consultantId, 'Condition Consultant', ids.managerId, 'Condition Manager',
        'Independent review confirmed the insufficient-information conclusion.'
      );
  assert.throws(() => domain.cancelAssessmentCycle(db, {
    workspaceId: ids.workspaceId, supplierId: issuedSupplierId,
    cycleId: issuedCycle.id, actorId: ids.consultantId,
    expectedRowVersion: issuedCycle.row_version,
    reason: 'This issued cycle must not be cancellable after recommendation publication.',
  }), error => error.code === 'TPRM_CYCLE_ISSUED_ARTIFACT');

  assert.throws(() => domain.closeModule(db, {
    workspaceId: ids.workspaceId, actorId: ids.managerId, force: true,
    reason: 'A force-close attempt must always be rejected by the domain.',
  }), error => error.code === 'TPRM_FORCE_CLOSE_FORBIDDEN');
  assert.throws(() => domain.closeModule(db, {
    workspaceId: ids.workspaceId, actorId: ids.managerId,
    expectedModuleId: ids.moduleId,
    reason: 'Closure is blocked while active assessment cycles still exist.',
  }), error => error.code === 'TPRM_ACTIVE_CYCLES');

  domain.cancelAssessmentCycle(db, {
    workspaceId: ids.workspaceId, supplierId: cancellableSupplierId,
    cycleId: replacement.id, actorId: ids.consultantId,
    expectedRowVersion: replacement.row_version,
    reason: 'Cancel the replacement test cycle before closing the service period.',
  });
  db.prepare(`UPDATE tprm_assessment_cycles SET status='completed',completed_at=datetime('now'),
    row_version=row_version+1 WHERE id=? AND status='active'`).run(issuedCycle.id);

  const countsBefore = {
    decisions: db.prepare('SELECT COUNT(*) AS count FROM tprm_client_decisions WHERE workspace_id=?').get(ids.workspaceId).count,
    conditions: db.prepare('SELECT COUNT(*) AS count FROM tprm_conditions WHERE workspace_id=?').get(ids.workspaceId).count,
    events: db.prepare('SELECT COUNT(*) AS count FROM tprm_condition_events WHERE workspace_id=?').get(ids.workspaceId).count,
  };
  const closed = domain.closeModule(db, {
    workspaceId: ids.workspaceId, actorId: ids.managerId,
    expectedModuleId: ids.moduleId,
    reason: 'The managed Third-party risk contract ended after all governed work was resolved.',
    retentionUntil: '2035-12-31', legalHold: true,
    retentionPolicy: 'Retain all assurance records through 2035 and thereafter while the legal hold remains active.',
  });
  assert.equal(closed.module.status, 'closed');
  assert.equal(closed.closure.retention_until, '2035-12-31');
  assert.equal(closed.closure.legal_hold, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_client_decisions WHERE workspace_id=?').get(ids.workspaceId).count, countsBefore.decisions);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_conditions WHERE workspace_id=?').get(ids.workspaceId).count, countsBefore.conditions);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_condition_events WHERE workspace_id=?').get(ids.workspaceId).count, countsBefore.events);

  const nextPeriod = domain.enableModule(db, {
    workspaceId: ids.workspaceId, serviceModel: 'assessment_only', actorId: ids.managerId,
    reason: 'A later, separately contracted assessment-only service period begins.',
  }).module;
  assert.notEqual(nextPeriod.id, closed.module.id);
  assert.equal(nextPeriod.status, 'active');
  assert.throws(() => domain.clientStartConditionWork(db, {
    workspaceId: ids.workspaceId, supplierId: ids.conditionSupplierId,
    conditionId: ids.waiverConditionId, actorId: ids.clientOwnerId,
    expectedStatus: 'waived',
  }), error => ['TPRM_MODULE_READ_ONLY', 'TPRM_CONDITION_STATE_INVALID',
    'TPRM_SERVICE_MODEL_CAPABILITY_REQUIRED'].includes(error.code));
});
