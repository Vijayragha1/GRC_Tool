'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let domain;
let relationships;
let monitoring;
let capabilities;
let manager;
let makerId;
let clientOwnerId;
let sequence = 0;
const fixtures = {};

function unique(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function addWorkspace(serviceModel, label) {
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,lead_consultant_id)
    VALUES (?,?,'active','[]',?)`).run(manager.firm_id, label, makerId).lastInsertRowid);
  const enabled = domain.enableModule(db, {
    workspaceId,
    serviceModel,
    actorId: manager.id,
    reason: `${label} explicitly contracts the ${serviceModel} test service period.`,
  });
  return { workspaceId, moduleId: enabled.module.id, serviceModel };
}

function addSupplier(fixture, label) {
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier,business_owner,relationship_owner)
    VALUES (?,?,?,'prospect','tier_2','Client Technology Owner','Consultancy TPRM Lead')`).run(
      fixture.workspaceId, label, `${label} production service`
    ).lastInsertRowid);
  const relationship = relationships.createRelationship(db, {
    workspaceId: fixture.workspaceId,
    supplierId,
    actorId: makerId,
    relationshipName: `${label} production service`,
    serviceDescription: `The exact ${label} production service boundary used for capability regression testing.`,
    serviceCategory: 'Managed service',
    provisionModel: 'managed_service',
    status: 'intake',
    criticality: 'high',
    dataAccess: 'confidential',
    businessOwner: 'Client Technology Owner',
    relationshipOwner: 'Consultancy TPRM Lead',
    isPrimary: true,
    reason: 'Create the exact service relationship before exercising the contracted service model.',
    idempotencyKey: unique('relationship').padEnd(32, 'x'),
  }).relationship;
  return Object.assign(fixture, { supplierId, relationshipId: relationship.id });
}

function addCompletedAssessmentArtifacts(fixture, cycleId) {
  const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
     module_applicability_json,approved_at,approved_by,created_by)
    VALUES (?,?,'2026.1','approved','tier_2',0,'[]',datetime('now'),?,?)`).run(
      fixture.workspaceId, fixture.supplierId, manager.id, makerId
    ).lastInsertRowid);
  const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,
     completed_at,completed_by,created_by)
    VALUES (?,?,?,'2026.1','tier_2','complete',datetime('now'),?,?)`).run(
      fixture.workspaceId, fixture.supplierId, inherentId, makerId, makerId
    ).lastInsertRowid);
  const contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
    (workspace_id,supplier_id,methodology_version,status,agreement_reference,agreement_date,
     inherent_assessment_id,reviewer_id,completed_at)
    VALUES (?,?,'2026.1','complete','MSA-CAPABILITY-TEST','2026-08-01',?,?,datetime('now'))`).run(
      fixture.workspaceId, fixture.supplierId, inherentId, makerId
    ).lastInsertRowid);
  domain.linkCycleArtifacts(db, {
    workspaceId: fixture.workspaceId,
    supplierId: fixture.supplierId,
    cycleId,
    inherentAssessmentId: inherentId,
    ddqAssessmentId: ddqId,
    contractReviewId: contractId,
    actorId: makerId,
  });
  return { inherentId, ddqId, contractId };
}

function capabilityError(code) {
  return error => error && error.code === code && error.status === 409;
}

function navMarkup(html) {
  const start = html.indexOf('<nav class="tprm-module-nav"');
  const end = html.indexOf('</nav>', start);
  assert.notEqual(start, -1, 'TPRM navigation should render');
  assert.notEqual(end, -1, 'TPRM navigation should close');
  return html.slice(start, end + 6);
}

test.before(async () => {
  env = await bootClient();
  ({ client } = env);
  db = new Database(env.dbPath);
  domain = require('../lib/tprm-domain');
  relationships = require('../lib/tprm-relationships');
  monitoring = require('../lib/tprm-monitoring-connectors');
  capabilities = require('../lib/tprm-capabilities');

  manager = db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  makerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,'!test-only','Capability Assessment Author','firm',?,'consultant',1)`).run(
      `${unique('capability-maker')}@example.test`, manager.firm_id
    ).lastInsertRowid);
  clientOwnerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,active)
    VALUES (?,'!test-only','Capability Client Owner','client',?,1)`).run(
      `${unique('capability-owner')}@example.test`, manager.firm_id
    ).lastInsertRowid);

  fixtures.programme = addSupplier(addWorkspace('programme_setup', 'Programme Setup Capability Client'), 'Programme Setup Provider');
  fixtures.assessment = addSupplier(addWorkspace('assessment_only', 'Assessment Only Capability Client'), 'Assessment Only Provider');
  fixtures.managed = addSupplier(addWorkspace('managed_lifecycle', 'Managed Lifecycle Capability Client'), 'Managed Lifecycle Provider');
  fixtures.retained = addSupplier(addWorkspace('managed_lifecycle', 'Retained Capability Client'), 'Retained History Provider');
  fixtures.boundary = addWorkspace('programme_setup', 'Service Period Boundary Client');
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')")
    .run(fixtures.assessment.workspaceId, clientOwnerId);
});

test.after(async () => {
  if (db) db.close();
  if (client) await client.close();
  if (env && env.tmpDir) fs.rmSync(env.tmpDir, { recursive:true, force:true });
});

test('the centralized matrix defines the exact three service models', () => {
  const C = capabilities.CAPABILITIES;
  assert.deepEqual(capabilities.MODEL_CAPABILITIES.programme_setup, [
    C.INVENTORY_REGISTER, C.METHODOLOGY_GOVERNANCE, C.DRAFT_INTAKE,
  ]);
  assert.deepEqual(capabilities.MODEL_CAPABILITIES.assessment_only, [
    C.INVENTORY_REGISTER, C.DRAFT_INTAKE, C.BOUNDED_ASSESSMENT,
    C.RECOMMENDATION, C.CLIENT_DECISION_REPORT, C.EVIDENCE_DISCLOSURE,
  ]);
  assert.deepEqual(capabilities.MODEL_CAPABILITIES.managed_lifecycle, capabilities.ALL_CAPABILITIES);

  for (const [model, fixture] of Object.entries({
    programme_setup: fixtures.programme,
    assessment_only: fixtures.assessment,
    managed_lifecycle: fixtures.managed,
  })) {
    for (const capability of capabilities.ALL_CAPABILITIES) {
      const expected = capabilities.MODEL_CAPABILITIES[model].includes(capability);
      assert.equal(capabilities.policyForModule(
        db.prepare('SELECT * FROM tprm_modules WHERE id=?').get(fixture.moduleId)
      ).capabilities[capability].allowed, expected, `${model}:${capability}`);
    }
  }
});

test('domain entry points allow contracted work and deny out-of-model mutations', () => {
  assert.equal(relationships.relationshipBundle(
    db, fixtures.programme.workspaceId, fixtures.programme.relationshipId
  ).relationship.supplier_id, fixtures.programme.supplierId,
  'programme setup may maintain the inventory and draft relationship');
  assert.throws(() => domain.ensureCurrentCycle(db, {
    workspaceId: fixtures.programme.workspaceId,
    supplierId: fixtures.programme.supplierId,
    actorId: makerId,
    cycleType: 'onboarding',
  }), capabilityError('TPRM_SERVICE_MODEL_CAPABILITY_REQUIRED'));
  assert.throws(() => monitoring.createConnector(db, {
    workspaceId: fixtures.assessment.workspaceId,
    actorId: manager.id,
  }), capabilityError('TPRM_SERVICE_MODEL_CAPABILITY_REQUIRED'));
  assert.throws(() => domain.recordMonitoringSignal(db, {
    workspaceId: fixtures.assessment.workspaceId,
  }), capabilityError('TPRM_SERVICE_MODEL_CAPABILITY_REQUIRED'));

  const connector = monitoring.createConnector(db, {
    workspaceId: fixtures.managed.workspaceId,
    actorId: manager.id,
    providerType: 'csv_import',
    capabilityMode: 'csv',
    name: 'Managed lifecycle test connector',
    status: 'draft',
    adapterConfig: { acceptedSchema: 'nimbus.monitoring.v1' },
  });
  assert.equal(connector.workspace_id, fixtures.managed.workspaceId);
});

test('direct HTTP POSTs reject capabilities outside programme and assessment-only contracts', async () => {
  const programmeCycle = await client.post(
    `/workspaces/${fixtures.programme.workspaceId}/tprm/third-parties/${fixtures.programme.supplierId}/cycles`,
    { cycle_type:'onboarding', relationship_ids:String(fixtures.programme.relationshipId) }
  );
  assert.equal(programmeCycle.status, 409);
  assert.match(programmeCycle.text, /not included in the Programme setup service model/i);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_assessment_cycles
    WHERE workspace_id=?`).get(fixtures.programme.workspaceId).count, 0);

  const assessmentConnector = await client.post(
    `/workspaces/${fixtures.assessment.workspaceId}/tprm/monitoring/connectors`,
    { provider_type:'csv_import', name:'Must not be created' }
  );
  assert.equal(assessmentConnector.status, 409);
  assert.match(assessmentConnector.text, /not included in the Assessment only service model/i);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_monitoring_connectors
    WHERE workspace_id=?`).get(fixtures.assessment.workspaceId).count, 0);

  const operationalStatus = await client.post(
    `/workspaces/${fixtures.assessment.workspaceId}/tprm/relationships/${fixtures.assessment.relationshipId}/status`,
    { status:'active', reason:'Attempt operational activation outside the contracted service model.' }
  );
  assert.equal(operationalStatus.status, 409);
  assert.match(operationalStatus.text, /not included in the Assessment only service model/i);
  assert.equal(db.prepare('SELECT status FROM tprm_service_relationships WHERE id=?')
    .get(fixtures.assessment.relationshipId).status, 'intake');
});

test('navigation explains each service model and disables out-of-contract destinations', async () => {
  const programmePage = await client.get(`/workspaces/${fixtures.programme.workspaceId}/tprm`);
  assert.equal(programmePage.status, 200);
  assert.match(programmePage.text, /Programme setup service period/);
  assert.doesNotMatch(navMarkup(programmePage.text), /\/tprm\/assessments/);
  assert.doesNotMatch(navMarkup(programmePage.text), /\/tprm\/monitoring/);

  const assessmentPage = await client.get(`/workspaces/${fixtures.assessment.workspaceId}/tprm`);
  assert.equal(assessmentPage.status, 200);
  assert.match(assessmentPage.text, /Assessment only service period/);
  assert.match(navMarkup(assessmentPage.text), /\/tprm\/assessments/);
  assert.doesNotMatch(navMarkup(assessmentPage.text), /\/tprm\/monitoring/);

  const managedPage = await client.get(`/workspaces/${fixtures.managed.workspaceId}/tprm`);
  assert.equal(managedPage.status, 200);
  assert.match(managedPage.text, /Managed lifecycle service period/);
  assert.match(navMarkup(managedPage.text), /\/tprm\/assessments/);
  assert.match(navMarkup(managedPage.text), /\/tprm\/monitoring/);
});

test('assessment-only completes one bounded assessment without operational lifecycle side effects', () => {
  const fixture = fixtures.assessment;
  const cycle = domain.ensureCurrentCycle(db, {
    workspaceId: fixture.workspaceId,
    supplierId: fixture.supplierId,
    actorId: makerId,
    cycleType: 'onboarding',
    clientDecisionAuthorityId: clientOwnerId,
    triggerReason: 'Perform the single bounded onboarding assessment in the contracted service period.',
  }).cycle;
  relationships.linkAssessmentCycle(db, {
    workspaceId: fixture.workspaceId,
    relationshipId: fixture.relationshipId,
    cycleId: cycle.id,
    actorId: makerId,
    scopeRole: 'primary',
    scopeRationale: 'This exact service is the bounded assessment scope.',
  });
  addCompletedAssessmentArtifacts(fixture, cycle.id);
  const recommendation = domain.issueRecommendation(db, {
    workspaceId: fixture.workspaceId,
    supplierId: fixture.supplierId,
    cycleId: cycle.id,
    outcome: 'recommend_onboard',
    executiveSummary: 'The completed evidence supports onboarding this exact assessed service.',
    rationale: 'Inherent risk, due diligence and contract assurance all passed their governed completion gates.',
    residualRiskScore: 28,
    residualRiskBand: 'moderate',
    authorId: makerId,
    reviewerId: manager.id,
    qualityReviewRationale: 'An independent manager verified the scope, evidence lineage and recommendation.',
    expectedCurrentRecommendationId: null,
    conditions: [],
    idempotencyKey: unique('assessment-recommendation').padEnd(32, 'x'),
  }).recommendation;
  const result = domain.recordClientDecision(db, {
    workspaceId: fixture.workspaceId,
    supplierId: fixture.supplierId,
    cycleId: cycle.id,
    recommendationId: recommendation.id,
    actorId: clientOwnerId,
    decision: 'onboard',
    rationale: 'The client accepts the bounded assessment conclusion for the exact service scope reviewed.',
    clientActorTitle: 'Client Technology Owner',
    authorityBasis: 'Delegated third-party onboarding authority',
    expectedCurrentDecisionId: null,
    idempotencyKey: unique('assessment-client-decision').padEnd(32, 'x'),
  });

  assert.equal(result.schedule, null);
  assert.equal(db.prepare('SELECT status FROM tprm_assessment_cycles WHERE id=?').get(cycle.id).status, 'completed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tprm_review_schedules
    WHERE workspace_id=? AND supplier_id=?`).get(fixture.workspaceId, fixture.supplierId).count, 0);
  assert.deepEqual(db.prepare(`SELECT lifecycle_stage,next_review_date FROM suppliers
    WHERE id=?`).get(fixture.supplierId), { lifecycle_stage:'prospect', next_review_date:null });
  assert.equal(db.prepare('SELECT status FROM tprm_service_relationships WHERE id=?')
    .get(fixture.relationshipId).status, 'intake');

  const projection = domain.lifecycleProjection(db, fixture.workspaceId, fixture.supplierId);
  assert.equal(projection.assessmentComplete, true);
  assert.equal(projection.waitingOn, null);
  assert.equal(projection.nextAction.key, 'view_assessment_report');
  assert.equal(projection.nextReviewDate, null);
  assert.equal(domain.cycleBundle(db, fixture.workspaceId, cycle.id).clientDecision.id, result.decision.id,
    'completed assessment history remains readable');

  assert.throws(() => domain.ensureCurrentCycle(db, {
    workspaceId: fixture.workspaceId, supplierId: fixture.supplierId,
    actorId: makerId, cycleType: 'periodic',
  }), capabilityError('TPRM_ASSESSMENT_ONLY_CYCLE_TYPE'));
  assert.throws(() => domain.ensureCurrentCycle(db, {
    workspaceId: fixture.workspaceId, supplierId: fixture.supplierId,
    actorId: makerId, cycleType: 'onboarding',
  }), capabilityError('TPRM_ASSESSMENT_ONLY_BOUNDARY'));
});

test('closed periods retain reads while rejecting mutations', async () => {
  const fixture = fixtures.retained;
  const closed = domain.closeModule(db, {
    workspaceId: fixture.workspaceId,
    actorId: manager.id,
    expectedModuleId: fixture.moduleId,
    reason: 'Retain the completed service period as read-only assurance history.',
  });
  assert.equal(closed.module.status, 'closed');
  assert.equal(relationships.relationshipBundle(
    db, fixture.workspaceId, fixture.relationshipId
  ).relationship.supplier_id, fixture.supplierId);

  const page = await client.get(`/workspaces/${fixture.workspaceId}/tprm/relationships`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Retained History Provider/);
  assert.match(page.text, /Service period closed|retained history/i);

  assert.throws(() => relationships.createRelationship(db, {
    workspaceId: fixture.workspaceId,
    supplierId: fixture.supplierId,
    actorId: makerId,
    relationshipName: 'Forbidden retained-period mutation',
    serviceDescription: 'This relationship must not be written after closure.',
  }), capabilityError('TPRM_SERVICE_PERIOD_CLOSED'));
});

test('service model changes require closing the current period and starting a new one', () => {
  const fixture = fixtures.boundary;
  assert.throws(() => domain.enableModule(db, {
    workspaceId: fixture.workspaceId,
    serviceModel: 'managed_lifecycle',
    actorId: manager.id,
    reason: 'Attempt to change the active model in place.',
  }), error => error && error.code === 'TPRM_MODULE_ALREADY_ACTIVE' && error.status === 409);
  assert.equal(domain.moduleForWorkspace(db, fixture.workspaceId).service_model, 'programme_setup');

  const closed = domain.closeModule(db, {
    workspaceId: fixture.workspaceId,
    actorId: manager.id,
    expectedModuleId: fixture.moduleId,
    reason: 'Close the programme-setup period before contracting managed lifecycle.',
  });
  const opened = domain.enableModule(db, {
    workspaceId: fixture.workspaceId,
    serviceModel: 'managed_lifecycle',
    actorId: manager.id,
    reason: 'Start the separately governed managed-lifecycle service period.',
  });
  assert.notEqual(opened.module.id, closed.module.id);
  assert.deepEqual(db.prepare(`SELECT service_model,status FROM tprm_modules
    WHERE workspace_id=? ORDER BY id`).all(fixture.workspaceId), [
      { service_model:'programme_setup', status:'closed' },
      { service_model:'managed_lifecycle', status:'active' },
    ]);
});
