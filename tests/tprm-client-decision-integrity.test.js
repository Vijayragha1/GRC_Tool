'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');
const domain = require('../lib/tprm-domain');
const relationships = require('../lib/tprm-relationships');

let env;
let db;
let ids;
let sequence = 0;

function addUser(email, name, userType, firmId, firmRole = null) {
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,'!test-only',?,?,?,?,1)`).run(email, name, userType, firmId, firmRole).lastInsertRowid);
}

function token(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}`.padEnd(32, 'x');
}

function futureDate(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function makeCase(authorityId = ids.ownerId, relationshipStatus = 'active') {
  sequence += 1;
  const suffix = sequence;
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,?,?,'prospect','tier_2')`).run(
      ids.workspaceId, `Decision integrity provider ${suffix}`, `Governed service ${suffix}`
    ).lastInsertRowid);
  const relationship = relationships.createRelationship(db, {
    workspaceId: ids.workspaceId,
    supplierId,
    actorId: ids.makerId,
    relationshipName: `Production service ${suffix}`,
    serviceDescription: `Exact production service boundary ${suffix} governed by the client decision.`,
    serviceCategory: 'Managed service',
    provisionModel: 'managed_service',
    status: relationshipStatus,
    criticality: 'high',
    dataAccess: 'restricted',
    privilegedAccess: true,
    businessOwner: 'Client Technology Director',
    isPrimary: true,
    reason: 'Create the exact assessed service relationship for decision-integrity testing.',
  }).relationship;
  const cycle = domain.ensureCurrentCycle(db, {
    workspaceId: ids.workspaceId, supplierId, actorId: ids.makerId,
    cycleType: 'onboarding', clientDecisionAuthorityId: authorityId,
  }).cycle;
  relationships.linkAssessmentCycle(db, {
    workspaceId: ids.workspaceId, relationshipId: relationship.id, cycleId: cycle.id,
    actorId: ids.makerId, scopeRole: 'primary',
    scopeRationale: 'This is the exact service relationship covered by the recommendation and decision.',
  });
  completeArtifacts({ supplierId, cycleId: cycle.id, suffix });
  return { supplierId, relationshipId: relationship.id, cycleId: cycle.id, authorityId };
}

function completeArtifacts(context) {
  const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
     module_applicability_json,approved_at,approved_by,created_by)
    VALUES (?,?,'2026.1','approved','tier_2',0,'[]',datetime('now'),?,?)`).run(
      ids.workspaceId, context.supplierId, ids.checkerId, ids.makerId
    ).lastInsertRowid);
  const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,
     completed_at,completed_by,created_by)
    VALUES (?,?,?,'2026.1','tier_2','complete',datetime('now'),?,?)`).run(
      ids.workspaceId, context.supplierId, inherentId, ids.makerId, ids.makerId
    ).lastInsertRowid);
  const contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
    (workspace_id,supplier_id,methodology_version,status,agreement_reference,agreement_date,
     inherent_assessment_id,reviewer_id,completed_at)
    VALUES (?,?,'2026.1','complete',?,'2026-08-01',?,?,datetime('now'))`).run(
      ids.workspaceId, context.supplierId, `MSA-${context.suffix || sequence}`, inherentId, ids.makerId
    ).lastInsertRowid);
  domain.linkCycleArtifacts(db, {
    workspaceId: ids.workspaceId, supplierId: context.supplierId, cycleId: context.cycleId,
    inherentAssessmentId: inherentId, ddqAssessmentId: ddqId, contractReviewId: contractId,
    actorId: ids.makerId,
  });
}

function issue(context, outcome = 'recommend_onboard', expectedCurrentRecommendationId = null, extra = {}) {
  return domain.issueRecommendation(db, {
    workspaceId: ids.workspaceId, supplierId: context.supplierId, cycleId: context.cycleId,
    outcome,
    executiveSummary: extra.executiveSummary || 'The assessed evidence supports the stated consultancy conclusion.',
    rationale: extra.rationale || 'The governed assessment, due diligence and contract assurance support this conclusion.',
    residualRiskScore: extra.residualRiskScore ?? (outcome === 'do_not_recommend' ? 82 : 24),
    residualRiskBand: extra.residualRiskBand || (outcome === 'do_not_recommend' ? 'high' : 'moderate'),
    authorId: ids.makerId, reviewerId: ids.checkerId,
    qualityReviewRationale: 'Independent quality review confirmed the evidence, scope and decision boundary.',
    expectedCurrentRecommendationId,
    validUntil: extra.validUntil || '2099-12-31',
    conditions: [],
    idempotencyKey: token('recommendation'),
  }).recommendation;
}

function decide(context, recommendation, decision, expectedCurrentDecisionId, actorId = context.authorityId, extra = {}) {
  return domain.recordClientDecision(db, {
    workspaceId: ids.workspaceId, supplierId: context.supplierId, cycleId: context.cycleId,
    recommendationId: recommendation.id, actorId, decision,
    rationale: extra.rationale || 'The client has reviewed the exact service scope and records this final business decision.',
    clientActorTitle: 'Authorised client decision-maker',
    authorityBasis: 'Delegated third-party onboarding authority',
    expectedCurrentDecisionId,
    validUntil: extra.validUntil,
    riskAcceptance: extra.riskAcceptance,
    idempotencyKey: token('client-decision'),
  });
}

function activateRelationship(context) {
  const relationship = db.prepare('SELECT * FROM tprm_service_relationships WHERE id=?')
    .get(context.relationshipId);
  return relationships.updateRelationship(db, {
    workspaceId:ids.workspaceId,
    relationshipId:context.relationshipId,
    actorId:ids.makerId,
    expectedRowVersion:relationship.row_version,
    patch:{ status:'active' },
    reason:'Activate the exact service scope after the positive client onboarding decision.',
  }).relationship;
}

test.before(() => {
  env = bootApp();
  db = new Database(env.dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const makerId = addUser('integrity-maker@example.test', 'Integrity Consultant', 'firm', firmId, 'consultant');
  const checkerId = addUser('integrity-checker@example.test', 'Integrity Quality Reviewer', 'firm', firmId, 'manager');
  const ownerId = addUser('integrity-owner@example.test', 'Client Owner', 'client', firmId);
  const adminId = addUser('integrity-admin@example.test', 'Client Administrator', 'client', firmId);
  const reviewerId = addUser('integrity-reviewer@example.test', 'Client Security Reviewer', 'client', firmId);
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,lead_consultant_id)
    VALUES (?,'Decision Integrity Client','active','[]',?)`).run(firmId, makerId).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(workspaceId, ownerId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_admin')").run(workspaceId, adminId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'isms_manager')").run(workspaceId, reviewerId);
  ids = { firmId, makerId, checkerId, ownerId, adminId, reviewerId, workspaceId };
  domain.enableModule(db, {
    workspaceId, serviceModel: 'managed_lifecycle', actorId: checkerId,
    reason: 'Enable governed TPRM decision-integrity coverage for this client.',
  });
});

test.after(() => {
  if (db) db.close();
  if (env?.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test('same-cycle deferral requires a successor recommendation and an explicit latest-decision expectation', () => {
  const context = makeCase();
  const first = issue(context, 'insufficient_information');
  assert.throws(() => domain.recordClientDecision(db, {
    workspaceId: ids.workspaceId, supplierId: context.supplierId, cycleId: context.cycleId,
    recommendationId: first.id, actorId: ids.ownerId, decision: 'defer_request_information',
    rationale: 'The client needs additional current assurance before making the final onboarding decision.',
  }), error => error.code === 'TPRM_EXPECTED_CLIENT_DECISION_REQUIRED' && error.status === 400);

  const deferred = decide(context, first, 'defer_request_information', null).decision;
  assert.equal(db.prepare('SELECT status FROM tprm_assessment_cycles WHERE id=?').get(context.cycleId).status, 'active');
  assert.throws(() => decide(context, first, 'onboard', deferred.id),
    error => error.code === 'TPRM_SUCCESSOR_RECOMMENDATION_REQUIRED' && error.status === 409);

  const successor = issue(context, 'recommend_onboard', first.id);
  const projection = domain.lifecycleProjection(db, ids.workspaceId, context.supplierId);
  assert.equal(projection.stage, 'client_decision');
  const final = decide(context, successor, 'onboard', deferred.id).decision;
  assert.equal(final.supersedes_id, deferred.id);
  assert.equal(final.cycle_id, deferred.cycle_id);
  assert.equal(db.prepare('SELECT status FROM tprm_assessment_cycles WHERE id=?').get(context.cycleId).status, 'completed');
  assert.throws(() => decide(context, successor, 'onboard', deferred.id),
    error => error.status === 409, 'a stale predecessor cannot replace the final same-cycle decision');
});

test('client_admin is a decision authority while the client security reviewer remains read-only', () => {
  const context = makeCase(ids.adminId);
  const recommendation = issue(context);
  assert.throws(() => decide(context, recommendation, 'onboard', null, ids.reviewerId),
    error => ['TPRM_CLIENT_DECISION_ROLE_REQUIRED', 'TPRM_DECISION_AUTHORITY_MISMATCH'].includes(error.code)
      && error.status === 403);
  const result = decide(context, recommendation, 'onboard', null, ids.adminId);
  assert.equal(result.decision.client_actor_user_id, ids.adminId);
});

test('expired recommendations and non-future risk acceptance are rejected deterministically', () => {
  const issuanceContext = makeCase();
  assert.throws(() => issue(issuanceContext, 'recommend_onboard', null, { validUntil: '2000-01-01' }),
    error => error.code === 'TPRM_RECOMMENDATION_VALIDITY_INVALID');

  const context = makeCase();
  const artifacts = domain.cycleBundle(db, ids.workspaceId, context.cycleId);
  const expiredId = Number(db.prepare(`INSERT INTO tprm_recommendations
    (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
     residual_risk_score,residual_risk_band,valid_until,inherent_assessment_id,ddq_assessment_id,
     contract_review_id,readiness_snapshot_json,artifact_snapshot_json,recommendation_hash,
     issued_by,issuer_name,quality_reviewed_by,quality_reviewer_name,quality_review_rationale)
    VALUES (?,?,?,1,'recommend_onboard',?,?,20,'moderate','2000-01-01',?,?,?,'{}',?,?,?,'Integrity Consultant',?,'Integrity Quality Reviewer',?)`).run(
      ids.workspaceId, context.supplierId, context.cycleId,
      'An intentionally expired historic recommendation.',
      'This row verifies that decision-time validity is enforced independently from issuance-time validation.',
      artifacts.inherent.id, artifacts.ddq.id, artifacts.contract.id,
      JSON.stringify({ serviceRelationships: artifacts.relationshipScopes.map(scope => ({ id: scope.relationship_id })) }),
      crypto.randomBytes(32).toString('hex'), ids.makerId, ids.checkerId,
      'Independent review was recorded for the historic recommendation.'
    ).lastInsertRowid);
  const expired = db.prepare('SELECT * FROM tprm_recommendations WHERE id=?').get(expiredId);
  assert.throws(() => decide(context, expired, 'onboard', null),
    error => error.code === 'TPRM_RECOMMENDATION_NOT_CURRENT' && error.status === 409);

  const riskContext = makeCase();
  const recommendation = issue(riskContext);
  const today = new Date().toISOString().slice(0, 10);
  assert.throws(() => decide(riskContext, recommendation, 'onboard', null, ids.ownerId, {
    riskAcceptance: {
      accepted: true,
      rationale: 'The client records a voluntary acceptance statement solely to test strict expiry enforcement.',
      expiresAt: today,
    },
  }), error => error.code === 'TPRM_RISK_ACCEPTANCE_EXPIRY_INVALID' && error.status === 400);
});

test('only unexpired positive decisions and required risk acceptances provide current operating authority', () => {
  const decisionContext = makeCase(ids.ownerId, 'intake');
  const recommendation = issue(decisionContext, 'recommend_onboard', null, { validUntil:'2199-12-31' });
  assert.throws(() => decide(decisionContext, recommendation, 'onboard', null, ids.ownerId, {
    validUntil:'2000-01-01',
  }), error => error.code === 'TPRM_CLIENT_DECISION_VALIDITY_INVALID' && error.status === 400);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_client_decisions
    WHERE workspace_id=? AND supplier_id=?`).get(ids.workspaceId, decisionContext.supplierId).count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_review_schedules
    WHERE workspace_id=? AND supplier_id=?`).get(ids.workspaceId, decisionContext.supplierId).count, 0);
  assert.equal(db.prepare('SELECT lifecycle_stage FROM suppliers WHERE id=?').get(decisionContext.supplierId).lifecycle_stage, 'prospect');

  const decisionExpiry = futureDate(45);
  const decision = decide(decisionContext, recommendation, 'onboard', null, ids.ownerId, {
    validUntil:decisionExpiry,
  }).decision;
  const decisionSchedule = db.prepare(`SELECT * FROM tprm_review_schedules
    WHERE workspace_id=? AND supplier_id=? ORDER BY version DESC LIMIT 1`).get(
      ids.workspaceId, decisionContext.supplierId
    );
  assert.equal(decisionSchedule.next_review_date, decisionExpiry);
  assert.match(decisionSchedule.schedule_basis, /client decision validity/);
  assert.equal(db.prepare('SELECT next_review_date FROM suppliers WHERE id=?')
    .get(decisionContext.supplierId).next_review_date, decisionExpiry);
  activateRelationship(decisionContext);
  assert.equal(domain.currentPositiveDecisionAuthority(db, ids.workspaceId, decisionContext.supplierId, {
    decision, asOfDate:decisionExpiry,
  }).authorised, true, 'decision authority remains valid through its stated date');
  const expiredDecisionAuthority = domain.currentPositiveDecisionAuthority(
    db, ids.workspaceId, decisionContext.supplierId, { decision, asOfDate:'2100-01-01' }
  );
  assert.equal(expiredDecisionAuthority.authorised, false);
  assert.equal(expiredDecisionAuthority.code, 'TPRM_CLIENT_DECISION_EXPIRED');
  assert.equal(domain.approvedBaseline(db, ids.workspaceId, decisionContext.supplierId, {
    asOfDate:'2100-01-01',
  }), null);
  const expiredDecisionProjection = domain.lifecycleProjection(
    db, ids.workspaceId, decisionContext.supplierId, { asOfDate:'2100-01-01' }
  );
  assert.equal(expiredDecisionProjection.stage, 'monitoring');
  assert.equal(expiredDecisionProjection.operationalStatus, 'monitoring');
  assert.equal(expiredDecisionProjection.nextReviewDate, decisionExpiry);
  assert.equal(expiredDecisionProjection.authorityLapse.priority, 'high');
  assert.equal(expiredDecisionProjection.authorityLapse.requiresReassessment, true);
  assert.equal(expiredDecisionProjection.authorityLapse.serviceStatusPreserved, true);
  assert.equal(expiredDecisionProjection.nextAction.key, 'start_reassessment');
  assert.equal(expiredDecisionProjection.nextAction.priority, 'high');
  assert.match(expiredDecisionProjection.blockers.join(' '), /recorded service status is preserved/i);
  assert.equal(db.prepare('SELECT lifecycle_stage FROM suppliers WHERE id=?')
    .get(decisionContext.supplierId).lifecycle_stage, 'active');
  assert.equal(db.prepare('SELECT status FROM tprm_service_relationships WHERE id=?')
    .get(decisionContext.relationshipId).status, 'active');
  const deniedExpiredDecisionActivation = relationships.relationshipActivationAuthority(db, {
    workspaceId:ids.workspaceId, relationshipId:decisionContext.relationshipId, asOfDate:'2100-01-01',
  });
  assert.equal(deniedExpiredDecisionActivation.allowed, false);
  assert.equal(deniedExpiredDecisionActivation.code, 'TPRM_CLIENT_DECISION_EXPIRED');

  const riskContext = makeCase(ids.ownerId, 'intake');
  const highRiskRecommendation = issue(riskContext, 'recommend_onboard', null, {
    residualRiskBand:'high', residualRiskScore:76, validUntil:'2199-12-31',
  });
  const riskAcceptanceExpiry = futureDate(30);
  const riskDecision = decide(riskContext, highRiskRecommendation, 'onboard', null, ids.ownerId, {
    validUntil:'2199-12-31',
    riskAcceptance: {
      accepted:true,
      rationale:'The client accepts the documented high residual risk for the governed service boundary.',
      statement:'The authorised client decision-maker explicitly accepts this residual risk.',
      expiresAt:riskAcceptanceExpiry,
    },
  }).decision;
  const riskSchedule = db.prepare(`SELECT * FROM tprm_review_schedules
    WHERE workspace_id=? AND supplier_id=? ORDER BY version DESC LIMIT 1`).get(
      ids.workspaceId, riskContext.supplierId
    );
  assert.equal(riskSchedule.next_review_date, riskAcceptanceExpiry);
  assert.match(riskSchedule.schedule_basis, /mandatory risk-acceptance validity/);
  assert.equal(db.prepare('SELECT next_review_date FROM suppliers WHERE id=?')
    .get(riskContext.supplierId).next_review_date, riskAcceptanceExpiry);
  activateRelationship(riskContext);
  assert.equal(domain.currentPositiveDecisionAuthority(db, ids.workspaceId, riskContext.supplierId, {
    decision:riskDecision, asOfDate:riskAcceptanceExpiry,
  }).authorised, true, 'risk acceptance remains valid through its stated expiry date');
  const expiredRiskAuthority = domain.currentPositiveDecisionAuthority(db, ids.workspaceId, riskContext.supplierId, {
    decision:riskDecision, asOfDate:'2100-01-01',
  });
  assert.equal(expiredRiskAuthority.authorised, false);
  assert.equal(expiredRiskAuthority.code, 'TPRM_RISK_ACCEPTANCE_EXPIRED');
  assert.equal(domain.approvedBaseline(db, ids.workspaceId, riskContext.supplierId, {
    asOfDate:'2100-01-01',
  }), null);
  const expiredRiskProjection = domain.lifecycleProjection(
    db, ids.workspaceId, riskContext.supplierId, { asOfDate:'2100-01-01' }
  );
  assert.equal(expiredRiskProjection.stage, 'monitoring');
  assert.equal(expiredRiskProjection.operationalStatus, 'monitoring');
  assert.equal(expiredRiskProjection.nextReviewDate, riskAcceptanceExpiry);
  assert.equal(expiredRiskProjection.authorityLapse.code, 'TPRM_RISK_ACCEPTANCE_EXPIRED');
  assert.equal(expiredRiskProjection.authorityLapse.priority, 'high');
  assert.equal(expiredRiskProjection.nextAction.key, 'start_reassessment');
  assert.equal(expiredRiskProjection.nextAction.priority, 'high');
  assert.equal(db.prepare('SELECT lifecycle_stage FROM suppliers WHERE id=?')
    .get(riskContext.supplierId).lifecycle_stage, 'active');
  assert.equal(db.prepare('SELECT status FROM tprm_service_relationships WHERE id=?')
    .get(riskContext.relationshipId).status, 'active');
  const deniedExpiredRiskActivation = relationships.relationshipActivationAuthority(db, {
    workspaceId:ids.workspaceId, relationshipId:riskContext.relationshipId, asOfDate:'2100-01-01',
  });
  assert.equal(deniedExpiredRiskActivation.allowed, false);
  assert.equal(deniedExpiredRiskActivation.code, 'TPRM_RISK_ACCEPTANCE_EXPIRED');
});

test('material signals block issuance and make an issued recommendation stale until a post-signal successor', () => {
  const context = makeCase();
  const firstSignal = domain.recordMonitoringSignal(db, {
    workspaceId: ids.workspaceId, supplierId: context.supplierId,
    source: 'Security monitoring', sourceReference: token('signal-reference'),
    signalType: 'security_incident', severity: 'high',
    title: 'Material incident requires review before recommendation',
    detail: 'The event affects the exact assessed production service.',
    observedAt: new Date().toISOString(), requiresReassessment: true,
  }).signal;
  assert.throws(() => issue(context),
    error => error.code === 'TPRM_MONITORING_SIGNAL_TRIAGE_REQUIRED' && error.status === 409);
  domain.triageMonitoringSignal(db, {
    workspaceId: ids.workspaceId, signalId: firstSignal.id, actorId: ids.checkerId,
    status: 'triaged', note: 'Impact reviewed and reflected in the recommendation rationale.',
  });
  const recommendation = issue(context);

  const laterSignal = domain.recordMonitoringSignal(db, {
    workspaceId: ids.workspaceId, supplierId: context.supplierId,
    source: 'Security monitoring', sourceReference: token('later-signal-reference'),
    signalType: 'breach', severity: 'critical',
    title: 'Post-recommendation breach signal',
    detail: 'This later event invalidates the earlier recommendation conclusion.',
    observedAt: new Date().toISOString(), requiresReassessment: true,
  }).signal;
  domain.triageMonitoringSignal(db, {
    workspaceId: ids.workspaceId, signalId: laterSignal.id, actorId: ids.checkerId,
    status: 'escalated', note: 'Escalated for a successor recommendation and updated client decision.',
  });
  assert.throws(() => decide(context, recommendation, 'onboard', null),
    error => error.code === 'TPRM_RECOMMENDATION_NOT_CURRENT' && error.status === 409);

  const successor = issue(context, 'recommend_onboard', recommendation.id, {
    executiveSummary: 'The later material signal was reviewed and incorporated into this successor conclusion.',
    rationale: 'Updated evidence and escalation analysis support the refreshed consultancy conclusion.',
  });
  const decision = decide(context, successor, 'onboard', null).decision;
  assert.equal(decision.recommendation_id, successor.id);
});

test('a later negative reassessment is authoritative across projection, supplier, relationship and schedule', () => {
  const context = makeCase(ids.ownerId, 'active');
  const initialRecommendation = issue(context);
  const initialDecision = decide(context, initialRecommendation, 'onboard', null).decision;
  const initialSchedule = db.prepare(`SELECT * FROM tprm_review_schedules
    WHERE client_decision_id=?`).get(initialDecision.id);
  assert.ok(initialSchedule);
  const intakeRelationship = db.prepare('SELECT * FROM tprm_service_relationships WHERE id=?')
    .get(context.relationshipId);
  relationships.updateRelationship(db, {
    workspaceId:ids.workspaceId,
    relationshipId:context.relationshipId,
    actorId:ids.makerId,
    expectedRowVersion:intakeRelationship.row_version,
    patch:{ status:'active' },
    reason:'Activate the exact service scope after the positive client onboarding decision.',
  });
  assert.equal(db.prepare('SELECT status FROM tprm_service_relationships WHERE id=?')
    .get(context.relationshipId).status, 'active');

  const reassessment = domain.ensureCurrentCycle(db, {
    workspaceId: ids.workspaceId, supplierId: context.supplierId, actorId: ids.makerId,
    cycleType: 'periodic', triggerReason: 'Scheduled reassessment identified a material risk change.',
    clientDecisionAuthorityId: ids.ownerId,
  }).cycle;
  relationships.linkAssessmentCycle(db, {
    workspaceId: ids.workspaceId, relationshipId: context.relationshipId, cycleId: reassessment.id,
    actorId: ids.makerId, scopeRole: 'primary',
    scopeRationale: 'The same production service is in scope for the reassessment decision.',
  });
  completeArtifacts({ supplierId: context.supplierId, cycleId: reassessment.id, suffix: `re-${sequence}` });
  const reassessmentContext = { ...context, cycleId: reassessment.id };
  const negativeRecommendation = issue(reassessmentContext, 'do_not_recommend');
  const negativeResult = decide(
    reassessmentContext, negativeRecommendation, 'do_not_onboard', initialDecision.id
  );

  assert.equal(negativeResult.decision.supersedes_id, initialDecision.id);
  assert.equal(domain.approvedBaseline(db, ids.workspaceId, context.supplierId), null);
  const projection = domain.lifecycleProjection(db, ids.workspaceId, context.supplierId);
  assert.equal(projection.clientDecision.id, negativeResult.decision.id);
  assert.equal(projection.stage, 'rejected');
  assert.equal(projection.operationalStatus, 'rejected');
  assert.equal(projection.nextReviewDate, null);

  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=? AND workspace_id=?')
    .get(context.supplierId, ids.workspaceId);
  assert.equal(supplier.lifecycle_stage, 'rejected');
  assert.equal(supplier.next_review_date, null);
  assert.equal(supplier.approved_by, null);
  assert.equal(supplier.approved_at, null);

  const relationship = db.prepare('SELECT * FROM tprm_service_relationships WHERE id=?')
    .get(context.relationshipId);
  assert.equal(relationship.status, 'suspended');
  const relationshipEvent = db.prepare(`SELECT * FROM tprm_relationship_events
    WHERE relationship_id=? ORDER BY id DESC LIMIT 1`).get(context.relationshipId);
  assert.equal(relationshipEvent.event_type, 'relationship_status_changed');
  assert.equal(relationshipEvent.actor_type, 'client');
  assert.equal(JSON.parse(relationshipEvent.payload_json).clientDecisionId, negativeResult.decision.id);

  const closure = db.prepare(`SELECT * FROM tprm_review_schedule_closures
    WHERE schedule_id=?`).get(initialSchedule.id);
  assert.equal(closure.superseded_by_decision_id, negativeResult.decision.id);
  assert.equal(negativeResult.scheduleClosure.id, closure.id);
  assert.throws(() => db.prepare('UPDATE tprm_review_schedule_closures SET reason=? WHERE id=?')
    .run('Tamper with schedule closure.', closure.id), /immutable/i);
});
