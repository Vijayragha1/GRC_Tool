'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');
const relationships = require('../lib/tprm-relationships');

test('third-party report preserves recommendation/client-decision separation and omits storage paths', () => {
  const env = bootApp();
  const db = new Database(env.dbPath);
  const domain = require('../lib/tprm-domain');
  const reports = require('../lib/assurance-reports');
  try {
    const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    const addUser = (email, name, userType, firmRole = null) => Number(db.prepare(`INSERT INTO users
      (email,password_hash,name,user_type,firm_id,firm_role,active)
      VALUES (?,?,?,?,?,?,1)`).run(email, '!test-only', name, userType, firm.id, firmRole).lastInsertRowid);
    const authorId = addUser('report-maker@example.test', 'Assessment Consultant', 'firm', 'consultant');
    const reviewerId = addUser('report-reviewer@example.test', 'Independent Quality Reviewer', 'firm', 'manager');
    const clientId = addUser('report-client@example.test', 'Client Risk Owner', 'client');
    const workspaceId = Number(db.prepare(`INSERT INTO workspaces
      (firm_id,client_name,frameworks) VALUES (?,'Standalone TPRM report client','[]')`).run(firm.id).lastInsertRowid);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(workspaceId, clientId);
    domain.enableModule(db, {
      workspaceId, serviceModel: 'managed_lifecycle', actorId: reviewerId,
      reason: 'Client contracted a managed third-party risk lifecycle.',
    });
    const supplierId = Number(db.prepare(`INSERT INTO suppliers
      (workspace_id,name,service_provided,lifecycle_stage,tier,business_owner,exit_strategy)
      VALUES (?,'Decision Boundary Cloud','Critical hosted processing','prospect','tier_2','Client Risk Owner','Migrate service and verify data deletion')`).run(workspaceId).lastInsertRowid);
    const assessedRelationship = relationships.createRelationship(db, {
      workspaceId,
      supplierId,
      actorId: authorId,
      relationshipName: 'Production payment transaction hosting',
      serviceDescription: 'Production transaction hosting, database operations and managed recovery.',
      serviceCategory: 'Payment infrastructure',
      provisionModel: 'managed_service',
      status: 'intake',
      criticality: 'critical',
      dataAccess: 'restricted',
      privilegedAccess: true,
      businessOwner: 'Client Risk Owner',
      isPrimary: true,
      reason: 'Create the exact production service relationship assessed for onboarding.',
    }).relationship;
    const unassessedRelationship = relationships.createRelationship(db, {
      workspaceId,
      supplierId,
      actorId: authorId,
      relationshipName: 'Unassessed marketing analytics service',
      serviceDescription: 'A separate analytics service that is not part of this onboarding assessment.',
      serviceCategory: 'Marketing analytics',
      provisionModel: 'saas',
      status: 'intake',
      criticality: 'low',
      dataAccess: 'internal',
      isPrimary: false,
      reason: 'Record a distinct relationship to prove assessment scope is not provider-wide.',
    }).relationship;
    const cycle = domain.ensureCurrentCycle(db, {
      workspaceId, supplierId, actorId: authorId, cycleType: 'onboarding', clientDecisionAuthorityId: clientId,
    }).cycle;
    relationships.linkAssessmentCycle(db, {
      workspaceId,
      relationshipId: assessedRelationship.id,
      cycleId: cycle.id,
      actorId: authorId,
      scopeRole: 'primary',
      scopeRationale: 'Only the production payment transaction hosting relationship is assessed in this cycle.',
    });
    const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
      (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
       module_applicability_json,weighted_score,approved_at,approved_by,created_by)
      VALUES (?,?,'2026.1','approved','tier_2',0,'[]',42,datetime('now'),?,?)`).run(
        workspaceId, supplierId, reviewerId, authorId
      ).lastInsertRowid);
    const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
      (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,
       completed_at,completed_by,created_by)
      VALUES (?,?,?,'2026.1','tier_2','complete',datetime('now'),?,?)`).run(
        workspaceId, supplierId, inherentId, authorId, authorId
      ).lastInsertRowid);
    db.prepare(`INSERT INTO supplier_ddq_evidence
      (workspace_id,assessment_id,question_id,filename,stored_path,sha256,size_bytes,mime_type,source)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, ddqId, 'SEC-01', 'soc2.pdf', '/private/internal/storage/soc2.pdf', 'a'.repeat(64), 1234,
        'application/pdf', 'vendor'
      );
    const contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
      (workspace_id,supplier_id,methodology_version,status,agreement_reference,agreement_date,
       inherent_assessment_id,reviewer_id,completed_at)
      VALUES (?,?,'2026.1','complete','MSA-REPORT-1','2026-08-01',?,?,datetime('now'))`).run(
        workspaceId, supplierId, inherentId, authorId
      ).lastInsertRowid);
    domain.linkCycleArtifacts(db, {
      workspaceId, supplierId, cycleId: cycle.id, inherentAssessmentId: inherentId,
      ddqAssessmentId: ddqId, contractReviewId: contractId, actorId: authorId,
    });
    const recommendation = domain.issueRecommendation(db, {
      workspaceId, supplierId, cycleId: cycle.id, outcome: 'recommend_with_conditions',
      executiveSummary: 'The consultancy recommends onboarding subject to one monitored condition.',
      rationale: 'The scoped evidence and contract review support a controlled onboarding decision.',
      residualRiskScore: 31, residualRiskBand: 'moderate', authorId, reviewerId,
      qualityReviewRationale: 'Independent review confirmed scope, evidence lineage and conclusion.',
      expectedCurrentRecommendationId: null,
      conditions: [{
        conditionType: 'monitoring', title: 'Quarterly assurance statement',
        description: 'The provider must supply a quarterly assurance statement after onboarding.',
        severity: 'moderate', ownerType: 'third_party', ownerName: 'Provider security lead',
        dueDate: '2027-01-31', verificationCriteria: 'Consultancy verifies the signed statement.',
      }],
    }).recommendation;
    domain.recordClientDecision(db, {
      workspaceId, supplierId, cycleId: cycle.id, recommendationId: recommendation.id, actorId: clientId,
      decision: 'onboard_with_conditions',
      rationale: 'The client accepts the recommendation and authorises onboarding with the stated condition.',
      clientActorTitle: 'Client Risk Owner', authorityBasis: 'Delegated onboarding authority',
      expectedCurrentDecisionId: null,
    });
    relationships.updateRelationship(db, {
      workspaceId,
      relationshipId: assessedRelationship.id,
      actorId: authorId,
      expectedRowVersion: assessedRelationship.row_version,
      patch: { relationshipName: 'Renamed after recommendation issuance' },
      reason: 'Simulate a later catalogue-name correction without changing the frozen recommendation scope.',
    });
    db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,decider_name,decided_by,residual_risk_score,methodology_version)
      VALUES (?,?,'approved','Legacy consultancy-authored decision','Legacy Consultant',?,31,1)`).run(
        workspaceId, supplierId, authorId
      );

    const built = reports.buildSnapshot(db, workspaceId, 'supplier_due_diligence', {
      supplier_id: supplierId, title: 'Decision-grade third-party report',
    });
    assert.equal(built.snapshot.supplier.currentRecommendation.id, recommendation.id);
    assert.equal(built.snapshot.supplier.currentClientDecision.client_actor_user_id, clientId);
    assert.deepEqual(built.snapshot.supplier.assessedServiceRelationships.map(item => item.id), [assessedRelationship.id]);
    assert.equal(built.snapshot.supplier.assessedServiceRelationships[0].name, 'Production payment transaction hosting');
    assert.equal(built.snapshot.supplier.assessedServiceRelationships[0].scopeRationale,
      'Only the production payment transaction hosting relationship is assessed in this cycle.');
    assert.equal(built.snapshot.supplier.assessedServiceRelationships[0].frozenAtRecommendationIssue, true);
    assert.ok(!built.snapshot.supplier.assessedServiceRelationships.some(item => item.id === unassessedRelationship.id));
    assert.equal(built.snapshot.supplier.legacyDecisions.length, 1);
    assert.equal(Object.hasOwn(built.snapshot.supplier, 'decisions'), false,
      'legacy decisions must never be promoted into the canonical client-decision field');
    assert.match(built.snapshot.metadata.framework, /A\.5\.19.*GV\.SC/);
    assert.ok(!built.quality.some(item => ['scope_unconfirmed', 'controls_missing'].includes(item.code)),
      'standalone TPRM reports must not inherit unrelated ISMS completeness gates');
    assert.ok(built.manifest.some(item => item.source_type === 'tprm_consultancy_recommendation'));
    assert.ok(built.manifest.some(item => item.source_type === 'tprm_client_decision'));
    assert.ok(built.manifest.some(item => item.source_type === 'tprm_cycle_relationship_scope'));
    assert.ok(built.manifest.some(item => item.source_type === 'legacy_supplier_decision_quarantined'));
    assert.doesNotMatch(JSON.stringify(built.snapshot), /\/private\/internal\/storage/);

    const html = reports.renderHtml({
      id: 99, title: 'Decision-grade third-party report', version_number: 1,
      status: 'generated', snapshot_hash: built.snapshotHash, generated_at: built.snapshot.generated_at,
    }, built.snapshot, built.quality, built.manifest);
    assert.match(html, /Consultancy recommendation/);
    assert.match(html, /Client decision/);
    assert.match(html, /Assessment Consultant/);
    assert.match(html, /Client Risk Owner/);
    assert.match(html, /Exact assessed service relationships/);
    assert.match(html, /Production payment transaction hosting/);
    assert.doesNotMatch(html, /Unassessed marketing analytics service|Renamed after recommendation issuance/);
    assert.doesNotMatch(html, /Legacy consultancy-authored decision/);
  } finally {
    db.close();
  }
});
