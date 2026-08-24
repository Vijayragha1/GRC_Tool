'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');

const domain = require('../lib/tprm-domain');
const relationships = require('../lib/tprm-relationships');

function applyFoundationToLegacyDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, firm_id INTEGER NOT NULL, client_name TEXT NOT NULL);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_type TEXT NOT NULL, firm_id INTEGER,
      firm_role TEXT, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE workspace_members (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL,
      UNIQUE(workspace_id,user_id)
    );
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, name TEXT NOT NULL,
      lifecycle_stage TEXT, created_at TEXT, archived_at TEXT, next_review_date TEXT,
      tier TEXT, approved_by TEXT, approved_at TEXT
    );
    CREATE TABLE supplier_inherent_assessments (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      assessment_type TEXT NOT NULL, status TEXT NOT NULL, created_by INTEGER, created_at TEXT,
      methodology_version TEXT, methodology_id INTEGER, methodology_hash TEXT,
      module_applicability_json TEXT, approved_at TEXT, assigned_tier TEXT
    );
    CREATE TABLE supplier_ddq_assessments (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      inherent_assessment_id INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT,
      methodology_version TEXT, methodology_id INTEGER, methodology_hash TEXT, completed_at TEXT
    );
    CREATE TABLE supplier_contract_reviews (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      inherent_assessment_id INTEGER, status TEXT NOT NULL, agreement_reference TEXT,
      agreement_date TEXT, created_at TEXT, methodology_version TEXT, methodology_id INTEGER,
      methodology_hash TEXT, completed_at TEXT
    );
    CREATE TABLE supplier_documents (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      doc_type TEXT, name TEXT, filename TEXT, sha256 TEXT, size_bytes INTEGER,
      effective_date TEXT, expiry_date TEXT, uploaded_at TEXT
    );
    CREATE TABLE supplier_ddq_evidence (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, assessment_id INTEGER NOT NULL,
      question_id TEXT, filename TEXT, stored_path TEXT, sha256 TEXT, size_bytes INTEGER,
      mime_type TEXT, source TEXT, uploaded_at TEXT
    );
    CREATE TABLE findings (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, title TEXT, severity TEXT, status TEXT);
    CREATE TABLE supplier_finding_links (finding_id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL, domain TEXT, due_date TEXT, owner_name TEXT);
    CREATE TABLE supplier_decisions (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      decision TEXT NOT NULL, decider_name TEXT NOT NULL, decided_at TEXT, superseded_at TEXT
    );
    CREATE TABLE migration_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT NOT NULL, source_table TEXT NOT NULL,
      source_id TEXT, reason TEXT NOT NULL, raw_payload TEXT, created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT, resolution_note TEXT
    );

    INSERT INTO workspaces VALUES (1,10,'Historic client');
    INSERT INTO users VALUES (1,'Historic consultant','firm',10,'manager',1);
    INSERT INTO suppliers VALUES (7,1,'Historic provider','terminating','2026-01-01',NULL,NULL,'tier_2',NULL,NULL);
    INSERT INTO supplier_inherent_assessments
      (id,workspace_id,supplier_id,assessment_type,status,created_by,created_at,methodology_version)
      VALUES (11,1,7,'periodic','approved',1,'2026-01-02','2026.1'),
             (12,1,7,'triggered','draft',1,'2026-02-02','2026.1');
    INSERT INTO supplier_decisions VALUES (21,1,7,'approved','Historic manager','2026-02-03',NULL);
  `);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '046_tprm_domain_foundation.sql'), 'utf8');
  db.transaction(() => db.exec(sql))();
  return db;
}

test('migration 046 preserves ambiguous history, quarantines guesses and fixes contract-start semantics', () => {
  const db = applyFoundationToLegacyDatabase();
  try {
    const module = db.prepare('SELECT * FROM tprm_modules WHERE workspace_id=1').get();
    assert.equal(module.status, 'needs_classification');
    assert.equal(module.service_model, null);
    assert.equal(db.prepare('SELECT lifecycle_stage FROM suppliers WHERE id=7').get().lifecycle_stage, 'offboarding');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_assessment_cycles').get().count, 0,
      'two current inherent assessments are ambiguous and must not be linked by guesswork');
    assert.ok(db.prepare(`SELECT 1 FROM migration_quarantine
      WHERE phase='tprm046' AND source_table='supplier_decisions' AND source_id='21'`).get());
    assert.ok(db.prepare(`SELECT 1 FROM migration_quarantine
      WHERE phase='tprm046' AND source_table='suppliers' AND reason LIKE 'Historic assessment lineage%'`).get());
    assert.deepEqual(db.prepare('SELECT decision,decider_name,decided_at,superseded_at FROM supplier_decisions WHERE id=21').get(), {
      decision: 'approved', decider_name: 'Historic manager', decided_at: '2026-02-03', superseded_at: null,
    });

    assert.doesNotThrow(() => db.prepare(`INSERT INTO supplier_contract_reviews
      (id,workspace_id,supplier_id,inherent_assessment_id,status,created_at,methodology_version)
      VALUES (31,1,7,11,'in_progress','2026-03-01','2026.1')`).run(),
    'an in-progress contract review does not yet have an executed agreement');
    assert.throws(() => db.prepare(`INSERT INTO supplier_contract_reviews
      (id,workspace_id,supplier_id,inherent_assessment_id,status,created_at,methodology_version)
      VALUES (32,1,7,11,'complete','2026-03-01','2026.1')`).run(), /completed supplier contract review requires/);
  } finally {
    db.close();
  }
});

function setupProductionDomain() {
  const env = bootApp();
  const db = new Database(env.dbPath);
  const firm = db.prepare('SELECT * FROM firms ORDER BY id LIMIT 1').get();
  const passwordHash = '!test-only';
  const addUser = (email, name, type, role = null) => Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, passwordHash, name, type, firm.id, role).lastInsertRowid);
  const makerId = addUser('tprm-maker@example.test', 'TPRM Maker', 'firm', 'consultant');
  const checkerId = addUser('tprm-checker@example.test', 'TPRM Quality Reviewer', 'firm', 'manager');
  const clientAuthorityId = addUser('tprm-authority@example.test', 'Client Decision Authority', 'client');
  const otherClientId = addUser('tprm-other-client@example.test', 'Other Client User', 'client');
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,frameworks) VALUES (?,'Standalone TPRM client','[]')`).run(firm.id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(workspaceId, clientAuthorityId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(workspaceId, otherClientId);
  domain.enableModule(db, {
    workspaceId, serviceModel: 'managed_lifecycle', actorId: checkerId,
    reason: 'Test fixture explicitly contracts managed Third-party risk capabilities.',
  });
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,'Critical cloud provider','Hosted transaction processing','prospect','tier_2')`).run(workspaceId).lastInsertRowid);
  const relationshipId = relationships.createRelationship(db, {
    workspaceId,
    supplierId,
    actorId: makerId,
    relationshipName: 'Hosted transaction processing service',
    serviceDescription: 'Production transaction processing and supporting managed cloud operations.',
    serviceCategory: 'Cloud transaction processing',
    provisionModel: 'managed_service',
    status: 'intake',
    criticality: 'high',
    dataAccess: 'restricted',
    privilegedAccess: true,
    businessOwner: 'Client Operations Director',
    relationshipOwner: 'Client Vendor Manager',
    isPrimary: true,
    reason: 'Create the exact service relationship governed by this assessment.',
  }).relationship.id;
  return { env, db, firm, makerId, checkerId, clientAuthorityId, otherClientId, workspaceId, supplierId, relationshipId };
}

function linkCycleService(db, ids, cycleId) {
  return relationships.linkAssessmentCycle(db, {
    workspaceId: ids.workspaceId,
    relationshipId: ids.relationshipId,
    cycleId,
    actorId: ids.makerId,
    scopeRole: 'primary',
    scopeRationale: 'The production hosted transaction-processing service is the exact assessment scope.',
  });
}

function createCompletedArtifacts(db, ids, cycleId, suffix = 'A') {
  const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
     module_applicability_json,approved_at,approved_by,created_by)
    VALUES (?,?,'2026.1','approved','tier_2',0,'[]',datetime('now'),?,?)`).run(
      ids.workspaceId, ids.supplierId, ids.checkerId, ids.makerId
    ).lastInsertRowid);
  const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,
     completed_at,completed_by,created_by)
    VALUES (?,?,?,'2026.1','tier_2','complete',datetime('now'),?,?)`).run(
      ids.workspaceId, ids.supplierId, inherentId, ids.makerId, ids.makerId
    ).lastInsertRowid);
  const contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
    (workspace_id,supplier_id,methodology_version,status,agreement_reference,agreement_date,
     inherent_assessment_id,reviewer_id,completed_at)
    VALUES (?,?,'2026.1','complete',?,'2026-08-01',?,?,datetime('now'))`).run(
      ids.workspaceId, ids.supplierId, `MSA-${suffix}`, inherentId, ids.makerId
    ).lastInsertRowid);
  domain.linkCycleArtifacts(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId,
    inherentAssessmentId: inherentId, ddqAssessmentId: ddqId, contractReviewId: contractId,
    actorId: ids.makerId,
  });
  return { inherentId, ddqId, contractId };
}

test('consultancy recommendation and client decision remain separate, immutable and maker-checker governed', () => {
  const ids = setupProductionDomain();
  const { db } = ids;
  try {
    const enabled = domain.enableModule(db, {
      workspaceId: ids.workspaceId, serviceModel: 'managed_lifecycle', actorId: ids.checkerId,
      reason: 'Client contracted a managed third-party risk lifecycle.',
    });
    assert.equal(enabled.module.status, 'active');
    assert.equal(domain.isEnabled(db, ids.workspaceId), true);

    const firstCycle = domain.ensureCurrentCycle(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.makerId,
      cycleType: 'onboarding', clientDecisionAuthorityId: ids.clientAuthorityId,
    }).cycle;
    linkCycleService(db, ids, firstCycle.id);
    assert.equal(firstCycle.client_decision_authority_id, ids.clientAuthorityId);
    const artifacts = createCompletedArtifacts(db, ids, firstCycle.id);

    assert.throws(() => domain.issueRecommendation(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      outcome: 'recommend_onboard', executiveSummary: 'Evidence supports onboarding.',
      rationale: 'All applicable assessment and contract gates have been completed.',
      authorId: ids.makerId, reviewerId: ids.makerId,
      qualityReviewRationale: 'The same person attempted both roles.',
    }), error => error.code === 'TPRM_MAKER_CHECKER_REQUIRED');

    const recommendationResult = domain.issueRecommendation(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      outcome: 'recommend_with_conditions',
      executiveSummary: 'Evidence supports onboarding subject to a dated assurance condition.',
      rationale: 'Due diligence and contract assurance are complete and residual exposure is manageable.',
      residualRiskScore: 26, residualRiskBand: 'moderate',
      authorId: ids.makerId, reviewerId: ids.checkerId,
      qualityReviewRationale: 'Independent review confirmed the evidence, scope and conclusion.',
      expectedCurrentRecommendationId: null,
      conditions: [{
        conditionType: 'monitoring', title: 'Quarterly service assurance report',
        description: 'Provide the first quarterly service assurance report after onboarding.',
        severity: 'moderate', ownerType: 'client', ownerUserId: ids.clientAuthorityId,
        ownerName: 'Client Decision Authority',
        dueDate: '2027-01-31', verificationCriteria: 'Consultancy verifies the signed report and exceptions.',
      }],
    });
    const recommendation = recommendationResult.recommendation;
    const issuedArtifacts = JSON.parse(recommendation.artifact_snapshot_json);
    assert.deepEqual(issuedArtifacts.serviceRelationships.map(item => item.name), [
      'Hosted transaction processing service',
    ]);
    assert.equal(recommendation.outcome, 'recommend_with_conditions');
    assert.equal(recommendation.issued_by, ids.makerId);
    assert.equal(recommendation.quality_reviewed_by, ids.checkerId);
    assert.equal(recommendationResult.conditions.length, 1);
    assert.throws(() => db.prepare('UPDATE tprm_recommendations SET rationale=? WHERE id=?')
      .run('Tampered rationale', recommendation.id), /immutable/);

    assert.throws(() => domain.recordClientDecision(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      recommendationId: recommendation.id, actorId: ids.otherClientId,
      decision: 'onboard_with_conditions',
      rationale: 'A different client user attempted to exercise the assigned authority.',
      clientActorTitle: 'Security analyst', authorityBasis: 'Contributor role',
      expectedCurrentDecisionId: null,
    }), error => error.code === 'TPRM_DECISION_AUTHORITY_MISMATCH');

    const decisionResult = domain.recordClientDecision(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: firstCycle.id,
      recommendationId: recommendation.id, actorId: ids.clientAuthorityId,
      decision: 'onboard_with_conditions',
      rationale: 'The client accepts the residual risk and authorises onboarding with the stated condition.',
      clientActorTitle: 'Chief Information Security Officer',
      authorityBasis: 'Delegated third-party onboarding authority',
      expectedCurrentDecisionId: null,
    });
    const decision = decisionResult.decision;
    assert.equal(decision.recommendation_id, recommendation.id);
    assert.equal(decision.recommendation_version, recommendation.version);
    assert.equal(decision.diverges_from_recommendation, 0);
    assert.deepEqual(JSON.parse(decision.decision_snapshot_json).serviceRelationships.map(item => item.id), [
      ids.relationshipId,
    ], 'the immutable client decision is bound to the exact service scope frozen in the recommendation');
    assert.equal(decisionResult.conditions.length, 1, 'client adoption creates the operative condition');
    assert.equal(decisionResult.schedule.next_review_date.length, 10);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_decisions WHERE supplier_id=?').get(ids.supplierId).count, 0,
      'the new client decision never overwrites or impersonates legacy supplier_decisions');
    assert.throws(() => db.prepare('DELETE FROM tprm_client_decisions WHERE id=?').run(decision.id), /cannot be deleted/);

    const operativeConditions = domain.listConditions(db, ids.workspaceId, ids.supplierId);
    assert.equal(operativeConditions.length, 1, 'proposed conditions are replaced by the adopted client-decision condition in operational views');
    const startedCondition = domain.clientStartConditionWork(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      conditionId: operativeConditions[0].id, actorId: ids.clientAuthorityId,
      expectedRowVersion: operativeConditions[0].row_version,
    });
    const submittedCondition = domain.clientSubmitCondition(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      conditionId: operativeConditions[0].id, actorId: ids.clientAuthorityId,
      completionStatement: 'The first signed quarterly service assurance report has been received and retained for review.',
      expectedRowVersion: startedCondition.condition.row_version,
    });
    const completed = domain.verifyCondition(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      conditionId: operativeConditions[0].id, actorId: ids.checkerId,
      reviewNote: 'Signed report independently reviewed; no material exceptions were identified.',
      expectedRowVersion: submittedCondition.condition.row_version,
    });
    assert.equal(completed.condition.status, 'verified');

    const firstProjection = domain.lifecycleProjection(db, ids.workspaceId, ids.supplierId);
    assert.equal(firstProjection.stage, 'monitoring');
    assert.equal(firstProjection.clientDecision.id, decision.id);

    const reassessment = domain.ensureCurrentCycle(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.makerId,
      cycleType: 'periodic', triggerReason: 'Scheduled periodic reassessment.',
      clientDecisionAuthorityId: ids.clientAuthorityId,
    }).cycle;
    linkCycleService(db, ids, reassessment.id);
    assert.equal(reassessment.baseline_decision_id, decision.id);
    assert.equal(db.prepare('SELECT status FROM supplier_inherent_assessments WHERE id=?').get(artifacts.inherentId).status, 'approved');
    assert.equal(db.prepare('SELECT decision_hash FROM tprm_client_decisions WHERE id=?').get(decision.id).decision_hash, decision.decision_hash);
    const reassessmentProjection = domain.lifecycleProjection(db, ids.workspaceId, ids.supplierId);
    assert.equal(reassessmentProjection.stage, 'intake');
    assert.equal(reassessmentProjection.operationalStatus, 'monitoring', 'the approved baseline remains operational during reassessment');
  } finally {
    db.close();
  }
});

test('clarifications and monitoring signals preserve submitted evidence history', () => {
  const ids = setupProductionDomain();
  const { db } = ids;
  try {
    domain.enableModule(db, {
      workspaceId: ids.workspaceId, serviceModel: 'managed_lifecycle', actorId: ids.checkerId,
      reason: 'Client contracted a governed managed TPRM lifecycle.',
    });
    const cycle = domain.ensureCurrentCycle(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.makerId,
      clientDecisionAuthorityId: ids.clientAuthorityId,
    }).cycle;
    linkCycleService(db, ids, cycle.id);
    const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
      (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
       module_applicability_json,approved_at,approved_by,created_by)
      VALUES (?,?,'2026.1','approved','tier_2',0,'[]',datetime('now'),?,?)`).run(
        ids.workspaceId, ids.supplierId, ids.checkerId, ids.makerId
      ).lastInsertRowid);
    const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
      (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,
       submitted_at,created_by)
      VALUES (?,?,?,'2026.1','tier_2','submitted',datetime('now'),?)`).run(
        ids.workspaceId, ids.supplierId, inherentId, ids.makerId
      ).lastInsertRowid);
    domain.linkCycleArtifacts(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: cycle.id,
      inherentAssessmentId: inherentId, ddqAssessmentId: ddqId, actorId: ids.makerId,
    });
    const submittedBefore = db.prepare('SELECT status,submitted_at FROM supplier_ddq_assessments WHERE id=?').get(ddqId);
    const requested = domain.requestClarification(db, {
      workspaceId: ids.workspaceId, cycleId: cycle.id, ddqAssessmentId: ddqId,
      questionId: 'DDQ-17', requestText: 'Provide the latest penetration-test executive summary and remediation status.',
      dueDate: '2027-02-15', actorId: ids.makerId,
    }).clarification;
    assert.throws(() => db.prepare('UPDATE tprm_clarifications SET request_text=? WHERE id=?')
      .run('Changed request', requested.id), /immutable/);
    const responded = domain.respondClarification(db, {
      clarificationId: requested.id, responderName: 'Provider security lead',
      responderEmail: 'security@provider.example',
      responseText: 'The executive summary and remediation tracker are attached to the evidence request.',
    }).clarification;
    assert.equal(responded.status, 'responded');
    assert.throws(() => db.prepare('UPDATE tprm_clarifications SET provider_response=? WHERE id=?')
      .run('Replacement response', requested.id), /immutable/);
    const resolved = domain.resolveClarification(db, {
      workspaceId: ids.workspaceId, clarificationId: requested.id, actorId: ids.checkerId,
      resolutionNote: 'Evidence reviewed and the clarification is satisfactorily resolved.',
    }).clarification;
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(db.prepare('SELECT status,submitted_at FROM supplier_ddq_assessments WHERE id=?').get(ddqId), submittedBefore,
      'clarification workflow must not reopen or rewrite the submitted DDQ baseline');

    const documentId = Number(db.prepare(`INSERT INTO supplier_documents
      (workspace_id,supplier_id,doc_type,name,filename,sha256,size_bytes,uploaded_by)
      VALUES (?,?,'assurance','Internal assurance report','assurance.pdf',?,1024,?)`).run(
        ids.workspaceId, ids.supplierId, 'a'.repeat(64), ids.makerId
      ).lastInsertRowid);
    assert.deepEqual(domain.clientThirdPartyProjection(db, ids.workspaceId, ids.supplierId, ids.clientAuthorityId).evidence, [],
      'client projection is deny-by-default even when internal evidence exists');
    const release = domain.releaseEvidence(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: cycle.id,
      sourceType: 'supplier_document', sourceId: documentId, actorId: ids.checkerId,
      clientLabel: 'Assurance report', clientDescription: 'Approved client-facing report metadata.',
      allowDownload: false,
    }).release;
    const releasedEvidence = domain.clientThirdPartyProjection(db, ids.workspaceId, ids.supplierId, ids.clientAuthorityId).evidence;
    assert.equal(releasedEvidence.length, 1);
    assert.equal(releasedEvidence[0].filename, 'Assurance report');
    assert.equal(Object.hasOwn(releasedEvidence[0], 'stored_path'), false);
    assert.throws(() => db.prepare('UPDATE tprm_evidence_releases SET client_label=? WHERE id=?')
      .run('Rewritten label', release.id), /immutable/);
    domain.withdrawEvidenceRelease(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId, releaseId: release.id,
      actorId: ids.checkerId, reason: 'The report is being replaced by a corrected client-approved edition.',
    });
    assert.deepEqual(domain.clientThirdPartyProjection(db, ids.workspaceId, ids.supplierId, ids.clientAuthorityId).evidence, []);

    const signal = domain.recordMonitoringSignal(db, {
      workspaceId: ids.workspaceId, supplierId: ids.supplierId,
      source: 'Regulatory feed', sourceReference: 'REG-2027-44', signalType: 'regulatory',
      severity: 'high', title: 'Provider received a regulatory enforcement notice',
      detail: 'Notice may affect the contracted processing service.', observedAt: '2027-01-10T09:30:00Z',
      requiresReassessment: true,
    }).signal;
    assert.equal(signal.status, 'new');
    const triaged = domain.triageMonitoringSignal(db, {
      workspaceId: ids.workspaceId, signalId: signal.id, actorId: ids.checkerId,
      status: 'escalated', note: 'Trigger a focused reassessment and request the provider response plan.',
    }).signal;
    assert.equal(triaged.status, 'escalated');
    assert.throws(() => db.prepare('UPDATE tprm_monitoring_signals SET title=? WHERE id=?')
      .run('Rewritten signal', signal.id), /immutable/);

    const events = db.prepare('SELECT * FROM tprm_lifecycle_events WHERE supplier_id=? ORDER BY id').all(ids.supplierId);
    assert.ok(events.length >= 9);
    events.filter(event => event.event_hash).forEach((event, index, hashed) => {
      assert.match(event.event_hash, /^[0-9a-f]{64}$/);
      if (index) assert.equal(event.previous_event_hash, hashed[index - 1].event_hash);
    });
    assert.throws(() => db.prepare('DELETE FROM tprm_lifecycle_events WHERE id=?').run(events[0].id), /cannot be deleted/);
  } finally {
    db.close();
  }
});

test('review dates use calendar-month cadence with end-of-month clamping', () => {
  assert.equal(domain.calculateNextReview('tier_1', '2026-08-31'), '2027-02-28');
  assert.equal(domain.calculateNextReview({ tier: 'tier_2', fromDate: '2028-02-29', cadenceMonths: 12 }), '2029-02-28');
  assert.equal(domain.calculateNextReview({ tier: 'tier_4', fromDate: '2026-01-31', cadenceMonths: 1 }), '2026-02-28');
});
