'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootApp, makeClient } = require('./helpers');

const domain = require('../lib/tprm-domain');
const relationships = require('../lib/tprm-relationships');
const workflow = require('../lib/tprm-recommendation-workflow');

const PASSWORD = 'Recommendation-workflow-test-1234';
const token = label => crypto.createHash('sha256').update(`tprm-recommendation-test:${label}`).digest('hex');

let env;
let db;
let ids;
let issuedDraftId;
let clientBrowser;
let authorBrowser;
let reviewerBrowser;

function addUser({ email, name, userType, firmId, firmRole = null }) {
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(
      email, bcrypt.hashSync(PASSWORD, 4), name, userType, firmId, firmRole
    ).lastInsertRowid);
}

function completeAssessmentArtifacts() {
  const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
     module_applicability_json,approved_at,approved_by,created_by)
    VALUES (?,?,'2026.1','approved','tier_2',0,'[]',datetime('now'),?,?)`).run(
      ids.workspaceId, ids.supplierId, ids.reviewerId, ids.authorId
    ).lastInsertRowid);
  const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,assessment_type,status,
     modules_json,completed_at,completed_by,created_by)
    VALUES (?,?,?,'2026.1','tier_2','onboarding','complete','[]',datetime('now'),?,?)`).run(
      ids.workspaceId, ids.supplierId, inherentId, ids.authorId, ids.authorId
    ).lastInsertRowid);
  const contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,status,agreement_reference,
     agreement_date,reviewer_id,completed_at)
    VALUES (?,?,?,'2026.1','complete','MSA-RECOMMENDATION-2026','2026-08-15',?,datetime('now'))`).run(
      ids.workspaceId, ids.supplierId, inherentId, ids.authorId
    ).lastInsertRowid);
  domain.linkCycleArtifacts(db, {
    workspaceId: ids.workspaceId,
    supplierId: ids.supplierId,
    cycleId: ids.cycleId,
    actorId: ids.authorId,
    inherentAssessmentId: inherentId,
    ddqAssessmentId: ddqId,
    contractReviewId: contractId,
    reason: 'Bind the completed assessment evidence for recommendation drafting.',
  });
}

async function loginActor(email) {
  const browser = makeClient(env.app);
  const page = await browser.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf);
  const signedIn = await browser.post('/login', {
    email, password: PASSWORD, _csrf: csrf,
  }, { csrf: false });
  assert.equal(signedIn.status, 302);
  await browser.get('/dashboard');
  return browser;
}

test.before(async () => {
  env = bootApp();
  db = new Database(env.dbPath);
  db.pragma('foreign_keys = ON');
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const authorId = addUser({ email: 'recommendation-author@test.local', name: 'Recommendation Author', userType: 'firm', firmId, firmRole: 'consultant' });
  const otherAuthorId = addUser({ email: 'recommendation-other-author@test.local', name: 'Other Consultant', userType: 'firm', firmId, firmRole: 'consultant' });
  const reviewerId = addUser({ email: 'recommendation-reviewer@test.local', name: 'Independent Reviewer', userType: 'firm', firmId, firmRole: 'senior_consultant' });
  const otherReviewerId = addUser({ email: 'recommendation-other-reviewer@test.local', name: 'Other Reviewer', userType: 'firm', firmId, firmRole: 'manager' });
  const clientId = addUser({ email: 'recommendation-client@test.local', name: 'Client Sponsor', userType: 'client', firmId });
  const foreignFirmId = Number(db.prepare("INSERT INTO firms(name) VALUES ('Foreign Consultancy')").run().lastInsertRowid);
  const foreignManagerId = addUser({ email: 'recommendation-foreign@test.local', name: 'Foreign Manager', userType: 'firm', firmId: foreignFirmId, firmRole: 'manager' });
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,lead_consultant_id)
    VALUES (?,'Recommendation Governance Client','active','[]',?)`).run(firmId, authorId).lastInsertRowid);
  const otherWorkspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,lead_consultant_id)
    VALUES (?,'Other Client','active','[]',?)`).run(firmId, authorId).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')").run(workspaceId, authorId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')").run(workspaceId, otherAuthorId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(workspaceId, clientId);
  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,'tprm.recommendation.issue',1,?,'Test maker-checker when one actor holds both capabilities')`).run(
      workspaceId, authorId, otherReviewerId
    );
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,lifecycle_stage)
    VALUES (?,'Governed Cloud Provider','Critical hosting','tier_2','prospect')`).run(workspaceId).lastInsertRowid);
  ids = { firmId, authorId, otherAuthorId, reviewerId, otherReviewerId, clientId, foreignManagerId, workspaceId, otherWorkspaceId, supplierId };
  domain.enableModule(db, {
    workspaceId, serviceModel: 'managed_lifecycle', actorId: otherReviewerId,
    reason: 'The client contracted the managed third-party risk lifecycle.',
  });
  const relationship = relationships.createRelationship(db, {
    workspaceId,
    supplierId,
    actorId: authorId,
    relationshipName: 'Governed production cloud hosting',
    serviceDescription: 'Production cloud hosting assessed for the client onboarding decision.',
    serviceCategory: 'Cloud hosting',
    provisionModel: 'iaas',
    status: 'intake',
    criticality: 'high',
    dataAccess: 'restricted',
    privilegedAccess: true,
    businessOwner: 'Client Technology Director',
    isPrimary: true,
    reason: 'Establish the exact service scope before assessment work begins.',
  }).relationship;
  const cycle = domain.ensureCurrentCycle(db, {
    workspaceId, supplierId, actorId: authorId, cycleType: 'onboarding', clientDecisionAuthorityId: clientId,
  }).cycle;
  relationships.linkAssessmentCycle(db, {
    workspaceId,
    relationshipId: relationship.id,
    cycleId: cycle.id,
    actorId: authorId,
    scopeRole: 'primary',
    scopeRationale: 'The production hosting relationship is the exact scope of this recommendation.',
  });
  ids.cycleId = cycle.id;
  ids.relationshipId = relationship.id;
  completeAssessmentArtifacts();
});

test.after(async () => {
  if (clientBrowser) await clientBrowser.close();
  if (authorBrowser) await authorBrowser.close();
  if (reviewerBrowser) await reviewerBrowser.close();
  if (db) db.close();
  if (env?.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test('draft, independent review, changes loop and exact-revision issue are governed and replay-safe', () => {
  const created = workflow.createDraft(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: ids.cycleId,
    actorId: ids.authorId, idempotencyKey: token('create'),
  });
  issuedDraftId = created.draft.id;
  assert.equal(created.draft.status, 'draft');
  const createReplay = workflow.createDraft(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: ids.cycleId,
    actorId: ids.authorId, idempotencyKey: token('create'),
  });
  assert.equal(createReplay.replayed, true);
  assert.equal(createReplay.draft.id, created.draft.id);

  const first = workflow.saveRevision(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, expectedRowVersion: created.draft.row_version, expectedRevisionNumber: 0,
    outcome: 'recommend_onboard', residualRiskBand: 'low', residualRiskScore: 18,
    executiveSummary: 'FIRST-REVISION-CANARY Evidence supports onboarding within the assessed service scope.',
    rationale: 'The completed due-diligence evidence and executed agreement support the initial conclusion.',
    conditions: [], idempotencyKey: token('save-first'),
  });
  assert.equal(first.currentRevision.revision_number, 1);
  assert.equal(first.currentRevision.revision_hash.length, 64);
  const firstReplay = workflow.saveRevision(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, expectedRowVersion: created.draft.row_version, expectedRevisionNumber: 0,
    outcome: 'recommend_onboard', residualRiskBand: 'low', residualRiskScore: 18,
    executiveSummary: 'FIRST-REVISION-CANARY Evidence supports onboarding within the assessed service scope.',
    rationale: 'The completed due-diligence evidence and executed agreement support the initial conclusion.',
    conditions: [], idempotencyKey: token('save-first'),
  });
  assert.equal(firstReplay.replayed, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_recommendation_draft_revisions WHERE draft_id=?').get(created.draft.id).count, 1);
  assert.throws(() => workflow.saveRevision(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, expectedRowVersion: created.draft.row_version, expectedRevisionNumber: 0,
    outcome: 'recommend_onboard', residualRiskBand: 'low', residualRiskScore: 18,
    executiveSummary: 'Changed content cannot reuse the action token for another immutable revision.',
    rationale: 'This different content must be rejected as an idempotency conflict without writing anything.',
    conditions: [], idempotencyKey: token('save-first'),
  }), error => error.code === 'TPRM_IDEMPOTENCY_CONFLICT');

  assert.throws(() => workflow.submitForReview(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, reviewerId: ids.authorId, expectedRowVersion: first.draft.row_version,
    expectedRevisionNumber: 1, idempotencyKey: token('self-review'),
  }), error => error.code === 'TPRM_MAKER_CHECKER_REQUIRED');
  const submitted = workflow.submitForReview(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, reviewerId: ids.reviewerId, expectedRowVersion: first.draft.row_version,
    expectedRevisionNumber: 1, idempotencyKey: token('submit-first'),
  });
  assert.equal(submitted.draft.status, 'in_review');
  assert.equal(submitted.draft.reviewer_id, ids.reviewerId);
  assert.throws(() => workflow.requestChanges(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.otherReviewerId, expectedRowVersion: submitted.draft.row_version,
    expectedRevisionNumber: 1, note: 'A non-assigned reviewer attempted to return the recommendation.',
    idempotencyKey: token('wrong-reviewer'),
  }), error => error.code === 'TPRM_RECOMMENDATION_REVIEWER_ONLY');
  const changes = workflow.requestChanges(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.reviewerId, expectedRowVersion: submitted.draft.row_version,
    expectedRevisionNumber: 1,
    note: 'Clarify the assessed production boundary and state the final residual-risk conclusion.',
    idempotencyKey: token('request-changes'),
  });
  assert.equal(changes.draft.status, 'changes_requested');
  assert.match(changes.draft.changes_requested_note, /production boundary/);

  assert.throws(() => workflow.saveRevision(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, expectedRowVersion: first.draft.row_version, expectedRevisionNumber: 1,
    outcome: 'recommend_onboard', residualRiskBand: 'low', residualRiskScore: 16,
    executiveSummary: 'This stale edit must never become another immutable recommendation revision.',
    rationale: 'The row-version expectation deliberately predates the quality-review change request.',
    conditions: [], idempotencyKey: token('stale-save'),
  }), error => error.code === 'TPRM_RECOMMENDATION_STALE_DRAFT');
  const second = workflow.saveRevision(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, expectedRowVersion: changes.draft.row_version, expectedRevisionNumber: 1,
    outcome: 'recommend_onboard', residualRiskBand: 'low', residualRiskScore: 16,
    executiveSummary: 'FINAL-REVISION-CANARY The assessed production boundary supports onboarding at low residual risk.',
    rationale: 'The revised conclusion explicitly covers production hosting, reviewed evidence and the executed agreement.',
    conditions: [], idempotencyKey: token('save-second'),
  });
  assert.equal(second.currentRevision.revision_number, 2);
  const resubmitted = workflow.submitForReview(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, reviewerId: ids.reviewerId, expectedRowVersion: second.draft.row_version,
    expectedRevisionNumber: 2, idempotencyKey: token('submit-second'),
  });
  const issued = workflow.issue(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.reviewerId, expectedRowVersion: resubmitted.draft.row_version,
    expectedRevisionNumber: 2, expectedCurrentRecommendationId: null,
    qualityReviewRationale: 'Independent review confirmed the revised scope, evidence lineage, contract identity and conclusion.',
    idempotencyKey: token('issue-second'),
  });
  assert.equal(issued.draft.status, 'issued');
  assert.equal(issued.recommendation.issued_by, ids.authorId);
  assert.equal(issued.recommendation.quality_reviewed_by, ids.reviewerId);
  assert.match(issued.recommendation.executive_summary, /FINAL-REVISION-CANARY/);
  assert.doesNotMatch(issued.recommendation.executive_summary, /FIRST-REVISION-CANARY/);
  assert.deepEqual(JSON.parse(issued.recommendation.artifact_snapshot_json).serviceRelationships, [{
    id: ids.relationshipId,
    key: db.prepare('SELECT relationship_key FROM tprm_service_relationships WHERE id=?').get(ids.relationshipId).relationship_key,
    name: 'Governed production cloud hosting',
    legalName: 'Governed Cloud Provider',
    role: 'primary',
    category: 'Cloud hosting',
    criticality: 'high',
    dataAccess: 'restricted',
  }]);
  const issueReplay = workflow.issue(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.reviewerId, expectedRowVersion: resubmitted.draft.row_version,
    expectedRevisionNumber: 2, expectedCurrentRecommendationId: null,
    qualityReviewRationale: 'Independent review confirmed the revised scope, evidence lineage, contract identity and conclusion.',
    idempotencyKey: token('issue-second'),
  });
  assert.equal(issueReplay.replayed, true);
  assert.equal(issueReplay.recommendation.id, issued.recommendation.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_recommendations WHERE cycle_id=?').get(ids.cycleId).count, 1);
});

test('author-only and tenant controls deny stale, client, foreign-firm and cross-workspace access', () => {
  const created = workflow.createDraft(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, cycleId: ids.cycleId,
    actorId: ids.authorId, idempotencyKey: token('successor-create'),
  });
  assert.throws(() => workflow.saveRevision(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.otherAuthorId, expectedRowVersion: created.draft.row_version, expectedRevisionNumber: 0,
    outcome: 'do_not_recommend', residualRiskBand: 'high',
    executiveSummary: 'Another consultant cannot edit a recommendation draft owned by the assigned author.',
    rationale: 'Assignment and authorship are controlled independently from generic drafting permission.',
    conditions: [], idempotencyKey: token('other-author-edit'),
  }), error => error.code === 'TPRM_RECOMMENDATION_AUTHOR_ONLY');
  assert.throws(() => workflow.currentDraft(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.clientId,
  }), error => error.code === 'TPRM_FIRM_ACTOR_REQUIRED');
  assert.throws(() => workflow.currentDraft(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, actorId: ids.foreignManagerId,
  }), error => error.code === 'TPRM_FIRM_ACTOR_REQUIRED');
  assert.throws(() => workflow.draftById(db, {
    workspaceId: ids.otherWorkspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.otherReviewerId,
  }), error => error.code === 'TPRM_RECOMMENDATION_DRAFT_NOT_FOUND');

  const secret = workflow.saveRevision(db, {
    workspaceId: ids.workspaceId, supplierId: ids.supplierId, draftId: created.draft.id,
    actorId: ids.authorId, expectedRowVersion: created.draft.row_version, expectedRevisionNumber: 0,
    outcome: 'do_not_recommend', residualRiskBand: 'high', residualRiskScore: 82,
    executiveSummary: 'INTERNAL-DRAFT-SECRET-CANARY This working conclusion has not completed quality review.',
    rationale: 'INTERNAL-DRAFT-RATIONALE-CANARY This rationale remains a consultancy workpaper until exact-revision issuance.',
    conditions: [], idempotencyKey: token('successor-secret'),
  });
  assert.equal(secret.currentRevision.revision_number, 1);
});

test('draft revisions and event chain are append-only, and internal draft text never reaches client projections or pages', async () => {
  const revision = db.prepare(`SELECT * FROM tprm_recommendation_draft_revisions
    WHERE draft_id=? ORDER BY revision_number LIMIT 1`).get(issuedDraftId);
  assert.throws(() => db.prepare('UPDATE tprm_recommendation_draft_revisions SET rationale=? WHERE id=?')
    .run('Tampered recommendation draft rationale.', revision.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM tprm_recommendation_draft_revisions WHERE id=?').run(revision.id), /cannot be deleted/);
  const events = db.prepare(`SELECT * FROM tprm_recommendation_draft_events
    WHERE draft_id=? ORDER BY id`).all(issuedDraftId);
  assert.deepEqual(events.map(event => event.action), [
    'created', 'revision_saved', 'submitted', 'changes_requested', 'revision_saved', 'submitted', 'issued',
  ]);
  events.forEach((event, index) => {
    assert.equal(event.event_hash.length, 64);
    assert.equal(event.previous_event_hash, index ? events[index - 1].event_hash : null);
  });
  assert.throws(() => db.prepare('UPDATE tprm_recommendation_draft_events SET note=? WHERE id=?')
    .run('Tamper attempt', events[0].id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM tprm_recommendation_draft_events WHERE id=?').run(events[0].id), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE tprm_recommendation_drafts SET reviewer_id=author_id WHERE id=?').run(issuedDraftId), /distinct active consultancy user/);
  assert.throws(() => db.prepare('DELETE FROM tprm_recommendation_drafts WHERE id=?').run(issuedDraftId), /cannot be deleted/);

  const projection = domain.clientThirdPartyProjection(db, ids.workspaceId, ids.supplierId, ids.clientId);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /INTERNAL-DRAFT-SECRET-CANARY|INTERNAL-DRAFT-RATIONALE-CANARY/);
  assert.equal(Object.prototype.hasOwnProperty.call(projection, 'recommendationDraft'), false);
  clientBrowser = await loginActor('recommendation-client@test.local');
  const page = await clientBrowser.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}`);
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.doesNotMatch(page.text, /INTERNAL-DRAFT-SECRET-CANARY|INTERNAL-DRAFT-RATIONALE-CANARY/);

  authorBrowser = await loginActor('recommendation-author@test.local');
  const authorPage = await authorBrowser.get(`/workspaces/${ids.workspaceId}/tprm/third-parties/${ids.supplierId}`);
  assert.equal(authorPage.status, 200, authorPage.text.slice(0, 500));
  assert.match(authorPage.text, /Save immutable revision/);
  assert.match(authorPage.text, /Submit revision 1 for independent review/);
  assert.doesNotMatch(authorPage.text, new RegExp(`${ids.supplierId}/recommendations["']`));

  reviewerBrowser = await loginActor('recommendation-reviewer@test.local');
  const reviewerPage = await reviewerBrowser.get(`/workspaces/${ids.workspaceId}/tprm/third-parties/${ids.supplierId}`);
  assert.equal(reviewerPage.status, 200, reviewerPage.text.slice(0, 500));
  assert.match(reviewerPage.text, /Waiting for Recommendation Author/);
  const directBypass = await reviewerBrowser.post(`/workspaces/${ids.workspaceId}/tprm/third-parties/${ids.supplierId}/recommendations`, {
    outcome: 'recommend_onboard', executive_summary: 'Unsafe direct issue attempt must fail.',
  });
  assert.equal(directBypass.status, 404);
});
