'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootApp, makeClient } = require('./helpers');
const relationships = require('../lib/tprm-relationships');

const PASSWORD = 'Tprm-client-test-password-1234';
let env;
let db;
let ids;
let manager;
let consultant;
let clientOwner;
let clientAdmin;
let securityReviewer;
let otherClient;
const generatedEvidencePaths = [];

function retainTestEvidence(firmId, storedPath, contents) {
  const directory = path.join(__dirname, '..', 'uploads', `firm_${firmId}`);
  fs.mkdirSync(directory, { recursive:true, mode:0o700 });
  const filePath = path.join(directory, storedPath);
  fs.writeFileSync(filePath, contents, { mode:0o600 });
  generatedEvidencePaths.push(filePath);
  return storedPath;
}

function futureDate(days = 365) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function insertUser({ email, name, userType, firmId, firmRole = null }) {
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(
      email, bcrypt.hashSync(PASSWORD, 4), name, userType, firmId, firmRole
    ).lastInsertRowid);
}

async function login(client, email) {
  const page = await client.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF missing for ${email}`);
  const signedIn = await client.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302, signedIn.text.slice(0, 300));
  const warm = await client.get('/dashboard');
  assert.ok([200, 302].includes(warm.status));
}

function seedRecommendation(workspaceId, supplierId, moduleId, makerId, checkerId, authorityId, options = {}) {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE workspace_id=? AND id=?').get(workspaceId, supplierId);
  const serviceRelationship = relationships.createRelationship(db, {
    workspaceId,
    supplierId,
    actorId: makerId,
    relationshipName: options.relationshipName || `${supplier.service_provided} service`,
    serviceDescription: options.serviceDescription || `${supplier.service_provided} assessed for the client onboarding decision.`,
    serviceCategory: options.serviceCategory || 'Managed service',
    provisionModel: options.provisionModel || 'managed_service',
    status: 'active',
    criticality: supplier.tier === 'tier_1' ? 'critical' : 'high',
    dataAccess: supplier.tier === 'tier_1' ? 'restricted' : 'confidential',
    privilegedAccess: supplier.tier === 'tier_1',
    businessOwner: supplier.business_owner,
    relationshipOwner: supplier.relationship_owner,
    isPrimary: true,
    reason: 'Define the exact client-facing service scope for the governed assessment.',
  }).relationship;
  const cycleId = Number(db.prepare(`INSERT INTO tprm_assessment_cycles
    (workspace_id,supplier_id,module_id,cycle_number,cycle_type,status,client_decision_authority_id,started_by)
    VALUES (?,?,?,1,'onboarding','active',?,?)`).run(
      workspaceId, supplierId, moduleId, authorityId, makerId
    ).lastInsertRowid);
  relationships.linkAssessmentCycle(db, {
    workspaceId,
    relationshipId: serviceRelationship.id,
    cycleId,
    actorId: makerId,
    scopeRole: 'primary',
    scopeRationale: 'This named service relationship is the exact boundary of the issued recommendation.',
  });
  const outcome = options.outcome || 'recommend_onboard';
  const residualRiskBand = options.residualRiskBand || 'moderate';
  const residualRiskScore = options.residualRiskScore || 38;
  const artifactSnapshot = JSON.stringify({
    cycle: { id: cycleId, number: 1, type: 'onboarding' },
    serviceRelationships: [{
      id: serviceRelationship.id,
      key: serviceRelationship.relationship_key,
      name: serviceRelationship.relationship_name,
      legalName: supplier.name,
      role: 'primary',
      category: serviceRelationship.service_category,
      criticality: serviceRelationship.criticality,
      dataAccess: serviceRelationship.data_access,
    }],
  });
  const recommendationId = Number(db.prepare(`INSERT INTO tprm_recommendations
    (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
     residual_risk_score,residual_risk_band,readiness_snapshot_json,artifact_snapshot_json,
     recommendation_hash,issued_by,issuer_name,quality_reviewed_by,quality_reviewer_name,
     quality_review_rationale)
    VALUES (?,?,?,1,?,?,?,?,?,'{}',?,?,?,?,?,?,?)`).run(
      workspaceId, supplierId, cycleId, outcome,
      options.summary || 'The provider can be onboarded within the assessed scope.',
      options.rationale || 'Due diligence and contract assurance support the issued recommendation for the stated scope.',
      residualRiskScore, residualRiskBand,
      artifactSnapshot, crypto.randomBytes(32).toString('hex'), makerId, 'TPRM Consultant', checkerId,
      'TPRM Quality Reviewer', 'Independent quality review completed against the issued evidence set.'
    ).lastInsertRowid);
  return { cycleId, recommendationId, relationshipId: serviceRelationship.id };
}

test.before(async () => {
  env = bootApp();
  db = new Database(env.dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const managerId = insertUser({ email:'tprm-manager@test.local', name:'TPRM Manager', userType:'firm', firmId, firmRole:'manager' });
  const consultantId = insertUser({ email:'tprm-consultant@test.local', name:'TPRM Consultant', userType:'firm', firmId, firmRole:'consultant' });
  const seniorId = insertUser({ email:'tprm-senior@test.local', name:'TPRM Quality Reviewer', userType:'firm', firmId, firmRole:'senior_consultant' });
  const clientOwnerId = insertUser({ email:'tprm-owner@test.local', name:'Client Decision Authority', userType:'client', firmId });
  const clientAdminId = insertUser({ email:'tprm-admin@test.local', name:'Client Administrator', userType:'client', firmId });
  const securityReviewerId = insertUser({ email:'tprm-security@test.local', name:'Client Security Reviewer', userType:'client', firmId });
  const otherClientId = insertUser({ email:'tprm-other@test.local', name:'Other Client Owner', userType:'client', firmId });
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,lead_consultant_id)
    VALUES (?,'TPRM Client','active','[]',?)`).run(firmId, consultantId).lastInsertRowid);
  const otherWorkspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,lead_consultant_id)
    VALUES (?,'Other TPRM Client','active','[]',?)`).run(firmId, consultantId).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')`).run(workspaceId, clientOwnerId);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_admin')`).run(workspaceId, clientAdminId);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'isms_manager')`).run(workspaceId, securityReviewerId);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')`).run(otherWorkspaceId, otherClientId);
  const moduleId = Number(db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Contracted managed TPRM service',?)`).run(workspaceId, managerId).lastInsertRowid);
  const otherModuleId = Number(db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'assessment_only','active','Contracted assessment',?)`).run(otherWorkspaceId, managerId).lastInsertRowid);
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,business_owner,relationship_owner,lifecycle_stage,notes)
    VALUES (?,'Production Cloud Provider','Managed production hosting','tier_2','Technology Director','Vendor Manager','active','INTERNAL-SUPPLIER-NOTE-MUST-NOT-LEAK')`).run(workspaceId).lastInsertRowid);
  const otherSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,lifecycle_stage)
    VALUES (?,'Other Client Secret Provider','Restricted service','tier_2','active')`).run(otherWorkspaceId).lastInsertRowid);
  const overrideSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,business_owner,lifecycle_stage)
    VALUES (?,'High Risk Analytics Provider','Sensitive analytics','tier_1','Technology Director','active')`).run(workspaceId).lastInsertRowid);
  const conditionalSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,business_owner,lifecycle_stage)
    VALUES (?,'Conditional Payments Provider','Payment processing','tier_2','Finance Director','active')`).run(workspaceId).lastInsertRowid);
  const adminSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,business_owner,lifecycle_stage)
    VALUES (?,'Administrator Decision Provider','Managed HR service','tier_2','People Director','active')`).run(workspaceId).lastInsertRowid);
  const deferredSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,business_owner,lifecycle_stage)
    VALUES (?,'Deferred Decision Provider','Managed identity service','tier_2','Technology Director','active')`).run(workspaceId).lastInsertRowid);
  const unassessedSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,business_owner,lifecycle_stage)
    VALUES (?,'Profile Tier Must Not Leak Provider','Unassessed legacy-profile service','tier_1','Technology Director','prospect')`).run(workspaceId).lastInsertRowid);
  db.prepare(`INSERT INTO supplier_notes
    (workspace_id,supplier_id,user_name,body,internal_only)
    VALUES (?,?,'TPRM Consultant','INTERNAL-WORKPAPER-CANARY',1)`).run(workspaceId, supplierId);
  const sourceExpiry = futureDate(730);
  const evidenceAccessExpiry = futureDate(365);
  const releasedStoredPath = retainTestEvidence(
    firmId, `client-released-evidence-${process.pid}.pdf`, 'client released evidence bytes'
  );
  const supplierDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,notes,
     effective_date,expiry_date,uploaded_by)
    VALUES (?,?,'soc2_type2','SOC 2 Type II','internal-soc2-report.pdf',?,?,1024,
      'INTERNAL-DOCUMENT-NOTE-CANARY','2026-01-01',?,?)`).run(
      workspaceId, supplierId, releasedStoredPath, crypto.randomBytes(32).toString('hex'), sourceExpiry,
      consultantId).lastInsertRowid);
  const primary = seedRecommendation(workspaceId, supplierId, moduleId, consultantId, seniorId, clientOwnerId);
  const override = seedRecommendation(workspaceId, overrideSupplierId, moduleId, consultantId, seniorId, clientOwnerId, {
    outcome:'do_not_recommend', residualRiskBand:'high', residualRiskScore:78,
    summary:'The consultancy does not recommend onboarding at the current control maturity.',
    rationale:'Material access-control weaknesses remain unresolved in the reviewed assurance evidence.'
  });
  const conditional = seedRecommendation(workspaceId, conditionalSupplierId, moduleId, consultantId, seniorId, clientOwnerId, {
    outcome:'recommend_with_conditions', residualRiskBand:'moderate', residualRiskScore:49,
    summary:'Onboarding is supportable only with the issued condition.',
    rationale:'The payment service is supportable after the named client owner completes and evidences the condition.'
  });
  const adminDecision = seedRecommendation(workspaceId, adminSupplierId, moduleId, consultantId, seniorId, clientAdminId);
  const deferred = seedRecommendation(workspaceId, deferredSupplierId, moduleId, consultantId, seniorId, clientOwnerId, {
    outcome:'insufficient_information', residualRiskBand:'moderate', residualRiskScore:52,
    summary:'The consultancy requires additional current assurance before it can support onboarding.',
    rationale:'The submitted evidence does not yet establish the required production identity-control effectiveness.'
  });
  const overrideInherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,
     module_applicability_json,approved_at,approved_by,created_by)
    VALUES (?,?,'2026.1','approved','tier_4',0,'[]',datetime('now'),?,?)`).run(
      workspaceId, overrideSupplierId, seniorId, consultantId).lastInsertRowid);
  db.prepare(`UPDATE tprm_assessment_cycles SET inherent_assessment_id=? WHERE id=?`)
    .run(overrideInherentId, override.cycleId);
  db.prepare(`INSERT INTO tprm_conditions
    (workspace_id,supplier_id,cycle_id,source_type,recommendation_id,condition_type,title,description,
     severity,owner_type,owner_user_id,owner_name,due_date,verification_criteria,created_by)
    VALUES (?,?,?,'recommendation',?,'control','Enforce phishing-resistant MFA',
      'Enforce phishing-resistant MFA for every privileged production account.',
      'high','client',?,'Client Decision Authority','2026-10-31',
      'Provide an approved access standard and a sampled privileged-access configuration export.',?)`).run(
        workspaceId, conditionalSupplierId, conditional.cycleId, conditional.recommendationId,
        clientOwnerId, consultantId);
  db.prepare(`INSERT INTO tprm_evidence_releases
    (workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,client_label,
     client_description,allow_download,expires_at,released_by,release_hash)
    VALUES (?,?,?,'supplier_document',?,'Independent control assurance','SOC 2 Type II report reviewed by the consultancy.',1,?,?,?)`).run(
      workspaceId, supplierId, primary.cycleId, supplierDocumentId, evidenceAccessExpiry, consultantId,
      crypto.randomBytes(32).toString('hex'));
  const downloadableReleaseId = db.prepare(`SELECT id FROM tprm_evidence_releases
    WHERE workspace_id=? AND supplier_id=? AND supplier_document_id=?`).get(
      workspaceId, supplierId, supplierDocumentId).id;
  const metadataStoredPath = retainTestEvidence(
    firmId, `client-metadata-only-${process.pid}.pdf`, 'metadata only evidence bytes'
  );
  const metadataDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,expiry_date,uploaded_by)
    VALUES (?,?,'assurance','Metadata-only assurance','internal-metadata-only.pdf',?,?,128,?,?)`).run(
      workspaceId, supplierId, metadataStoredPath, crypto.randomBytes(32).toString('hex'),
      sourceExpiry, consultantId).lastInsertRowid);
  const metadataReleaseId = Number(db.prepare(`INSERT INTO tprm_evidence_releases
    (workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,client_label,
     client_description,allow_download,expires_at,released_by,release_hash)
    VALUES (?,?,?,'supplier_document',?,'Assurance review confirmation',
      'Metadata is released, but the underlying file remains private.',0,?,?,?)`).run(
      workspaceId, supplierId, primary.cycleId, metadataDocumentId, evidenceAccessExpiry,
      consultantId, crypto.randomBytes(32).toString('hex')).lastInsertRowid);
  const staleSourceStoredPath = retainTestEvidence(
    firmId, `client-stale-source-${process.pid}.pdf`, 'expired source bytes'
  );
  const staleSourceDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,expiry_date,uploaded_by)
    VALUES (?,?,'assurance','Stale source assurance','internal-stale-source.pdf',?,?,128,'2000-01-01',?)`).run(
      workspaceId, supplierId, staleSourceStoredPath, crypto.randomBytes(32).toString('hex'),
      consultantId).lastInsertRowid);
  const staleSourceReleaseId = Number(db.prepare(`INSERT INTO tprm_evidence_releases
    (workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,client_label,
     client_description,allow_download,expires_at,released_by,release_hash)
    VALUES (?,?,?,'supplier_document',?,'Historic assurance metadata',
      'The release remains visible, but its source has expired.',1,?,?,?)`).run(
      workspaceId, supplierId, primary.cycleId, staleSourceDocumentId, evidenceAccessExpiry,
      consultantId, crypto.randomBytes(32).toString('hex')).lastInsertRowid);
  const missingSourceStoredPath = `client-missing-source-${process.pid}.pdf`;
  const missingSourceDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,expiry_date,uploaded_by)
    VALUES (?,?,'assurance','Unavailable source assurance','internal-missing-source.pdf',?,?,128,?,?)`).run(
      workspaceId, supplierId, missingSourceStoredPath, crypto.randomBytes(32).toString('hex'),
      sourceExpiry, consultantId).lastInsertRowid);
  const missingSourceReleaseId = Number(db.prepare(`INSERT INTO tprm_evidence_releases
    (workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,client_label,
     client_description,allow_download,expires_at,released_by,release_hash)
    VALUES (?,?,?,'supplier_document',?,'Unavailable assurance metadata',
      'The retained source file is unavailable.',1,?,?,?)`).run(
      workspaceId, supplierId, primary.cycleId, missingSourceDocumentId, evidenceAccessExpiry,
      consultantId, crypto.randomBytes(32).toString('hex')).lastInsertRowid);
  const expiredReleaseStoredPath = retainTestEvidence(
    firmId, `client-expired-release-${process.pid}.pdf`, 'expired release bytes'
  );
  const expiredDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,expiry_date,uploaded_by)
    VALUES (?,?,'assurance','Expired release canary','internal-expired-release.pdf',?,?,128,?,?)`).run(
      workspaceId, supplierId, expiredReleaseStoredPath, crypto.randomBytes(32).toString('hex'),
      sourceExpiry, consultantId).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_evidence_releases
    (workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,client_label,
     client_description,allow_download,expires_at,released_by,release_hash)
    VALUES (?,?,?,'supplier_document',?,'EXPIRED-RELEASE-MUST-NOT-APPEAR','Expired disclosure canary.',1,'2000-01-01',?,?)`).run(
      workspaceId, supplierId, primary.cycleId, expiredDocumentId, consultantId,
      crypto.randomBytes(32).toString('hex'));
  const expiredReleaseId = db.prepare(`SELECT id FROM tprm_evidence_releases
    WHERE workspace_id=? AND supplier_id=? AND supplier_document_id=?`).get(
      workspaceId, supplierId, expiredDocumentId).id;
  const withdrawnStoredPath = retainTestEvidence(
    firmId, `client-withdrawn-release-${process.pid}.pdf`, 'withdrawn release bytes'
  );
  const withdrawnDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,uploaded_by)
    VALUES (?,?,'assurance','Withdrawn release canary','internal-withdrawn-release.pdf',?,?,128,?)`).run(
      workspaceId, supplierId, withdrawnStoredPath, crypto.randomBytes(32).toString('hex'),
      consultantId).lastInsertRowid);
  const withdrawnReleaseId = Number(db.prepare(`INSERT INTO tprm_evidence_releases
    (workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,client_label,
     client_description,allow_download,released_by,release_hash)
    VALUES (?,?,?,'supplier_document',?,'WITHDRAWN-RELEASE-MUST-NOT-APPEAR','Withdrawn disclosure canary.',1,?,?)`).run(
      workspaceId, supplierId, primary.cycleId, withdrawnDocumentId, consultantId,
      crypto.randomBytes(32).toString('hex')).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_evidence_release_withdrawals
    (workspace_id,supplier_id,release_id,reason,withdrawn_by,request_fingerprint)
    VALUES (?,?,?,'Withdraw the canary before client portal rendering.',?,?)`).run(
      workspaceId, supplierId, withdrawnReleaseId, seniorId, crypto.randomBytes(32).toString('hex'));
  seedRecommendation(otherWorkspaceId, otherSupplierId, otherModuleId, consultantId, seniorId, otherClientId);
  ids = { firmId, managerId, consultantId, seniorId, clientOwnerId, clientAdminId, securityReviewerId, otherClientId,
    workspaceId, otherWorkspaceId, supplierId, otherSupplierId, overrideSupplierId, conditionalSupplierId,
    adminSupplierId, deferredSupplierId, unassessedSupplierId,
    supplierDocumentId, metadataDocumentId, expiredDocumentId:staleSourceDocumentId,
    expiredReleaseDocumentId:expiredDocumentId, sourceExpiry, evidenceAccessExpiry,
    downloadableReleaseId, metadataReleaseId, staleSourceReleaseId, missingSourceReleaseId,
    expiredReleaseId, withdrawnReleaseId, moduleId, ...primary,
    overrideCycleId:override.cycleId, overrideRecommendationId:override.recommendationId,
    conditionalCycleId:conditional.cycleId, conditionalRecommendationId:conditional.recommendationId,
    adminCycleId:adminDecision.cycleId, adminRecommendationId:adminDecision.recommendationId,
    deferredCycleId:deferred.cycleId, deferredRecommendationId:deferred.recommendationId };

  manager = makeClient(env.app);
  consultant = makeClient(env.app);
  clientOwner = makeClient(env.app);
  clientAdmin = makeClient(env.app);
  securityReviewer = makeClient(env.app);
  otherClient = makeClient(env.app);
  await login(manager, 'tprm-manager@test.local');
  await login(consultant, 'tprm-consultant@test.local');
  await login(clientOwner, 'tprm-owner@test.local');
  await login(clientAdmin, 'tprm-admin@test.local');
  await login(securityReviewer, 'tprm-security@test.local');
  await login(otherClient, 'tprm-other@test.local');
});

test.after(async () => {
  if (db) db.close();
  if (manager) await manager.close();
  if (consultant) await consultant.close();
  if (clientOwner) await clientOwner.close();
  if (clientAdmin) await clientAdmin.close();
  if (securityReviewer) await securityReviewer.close();
  if (otherClient) await otherClient.close();
  for (const filePath of generatedEvidencePaths) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
  }
});

test('maker-checker rejects self-review and accepts distinct active consultancy users', () => {
  const domain = require('../lib/tprm-domain');
  assert.throws(() => domain.assertMakerChecker(db, {
    workspaceId: ids.workspaceId, makerId: ids.consultantId, checkerId: ids.consultantId
  }), error => error.code === 'TPRM_MAKER_CHECKER_REQUIRED');
  const pair = domain.assertMakerChecker(db, {
    workspaceId: ids.workspaceId, makerId: ids.consultantId, checkerId: ids.seniorId
  });
  assert.equal(pair.maker.id, ids.consultantId);
  assert.equal(pair.checker.id, ids.seniorId);
});

test('client and firm preview see only released TPRM assurance fields', async () => {
  for (const actor of [clientOwner, clientAdmin, securityReviewer]) {
    const portfolio = await actor.get(`/workspaces/${ids.workspaceId}/client-portal/tprm`);
    assert.equal(portfolio.status, 200, portfolio.text.slice(0, 500));
    assert.match(portfolio.text, /Production Cloud Provider/);
    assert.match(portfolio.text, /Recommend Onboard/);
    assert.doesNotMatch(portfolio.text, /INTERNAL-SUPPLIER-NOTE|INTERNAL-WORKPAPER|INTERNAL-DOCUMENT-NOTE/);
  }
  const ownerDetail = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}`);
  assert.equal(ownerDetail.status, 200, ownerDetail.text.slice(0, 500));
  assert.match(ownerDetail.text, /Source document valid until/);
  assert.match(ownerDetail.text, /Portal access available until/);
  const conditionOwnerSelector = (ownerDetail.text.match(/<select[^>]+id="condition-owner"[\s\S]*?<\/select>/) || [])[0];
  assert.ok(conditionOwnerSelector, 'condition owner selector should be available to the decision authority');
  assert.match(conditionOwnerSelector, /Client Decision Authority/);
  assert.match(conditionOwnerSelector, /Client Administrator/);
  assert.doesNotMatch(conditionOwnerSelector, /Client Security Reviewer/);
  const domain = require('../lib/tprm-domain');
  const clientProjection = domain.clientThirdPartyProjection(
    db, ids.workspaceId, ids.supplierId, ids.clientOwnerId
  );
  const projectedEvidence = clientProjection.evidence.find(item => item.filename === 'Independent control assurance');
  assert.ok(projectedEvidence);
  assert.equal(projectedEvidence.sourceExpiry, ids.sourceExpiry);
  assert.equal(projectedEvidence.accessExpiresAt, ids.evidenceAccessExpiry);
  assert.doesNotMatch(JSON.stringify(projectedEvidence), /soc2-report\.pdf|INTERNAL-DOCUMENT-NOTE/);
  assert.throws(() => domain.releaseEvidence(db, {
    workspaceId:ids.workspaceId,
    supplierId:ids.supplierId,
    cycleId:ids.cycleId,
    sourceType:'supplier_document',
    sourceId:ids.expiredDocumentId,
    actorId:ids.seniorId,
    clientLabel:'Expired source must remain internal',
    clientDescription:'This stale source must fail closed before a new client release can be recorded.',
  }), error => error.code === 'TPRM_EVIDENCE_SOURCE_EXPIRED' && error.status === 409);
  const preview = await manager.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}?preview=client`);
  assert.equal(preview.status, 200, preview.text.slice(0, 500));
  assert.match(preview.text, /Read-only client preview/);
  assert.match(preview.text, /Independent control assurance/);
  assert.match(preview.text, /Managed production hosting service/);
  assert.match(preview.text, /Exact assessed service relationships/);
  assert.match(preview.text, /Other services from the same third party are not automatically covered/);
  assert.doesNotMatch(preview.text, /Record final client decision|INTERNAL-SUPPLIER-NOTE|INTERNAL-WORKPAPER|INTERNAL-DOCUMENT-NOTE|soc2-report\.pdf/);
  assert.doesNotMatch(preview.text, /EXPIRED-RELEASE-MUST-NOT-APPEAR|WITHDRAWN-RELEASE-MUST-NOT-APPEAR/);
});

test('client-safe tier and risk labels use governed assessment truth without internal relationship IDs', async () => {
  const unassessed = await clientOwner.get(
    `/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.unassessedSupplierId}`
  );
  assert.equal(unassessed.status, 200, unassessed.text.slice(0, 500));
  assert.match(unassessed.text, /Not assessed residual risk/);
  assert.match(unassessed.text, /Approved tier<\/span><strong>Not assessed<\/strong>/);
  assert.doesNotMatch(unassessed.text, /Tier 1/,
    'the legacy supplier-profile tier is not an approved client assurance result');

  const governed = await clientOwner.get(
    `/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.overrideSupplierId}`
  );
  assert.equal(governed.status, 200, governed.text.slice(0, 500));
  assert.match(governed.text, /Approved tier<\/span><strong>Tier 4<\/strong>/);
  assert.doesNotMatch(governed.text, /Relationship ID:/,
    'client-safe service scope must not expose internal database row identifiers');

  const portfolio = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm`);
  assert.equal(portfolio.status, 200);
  const unassessedRow = (portfolio.text.match(
    /Profile Tier Must Not Leak Provider[\s\S]*?<\/tr>/
  ) || [])[0];
  assert.ok(unassessedRow, 'unassessed provider should remain visible in the client portfolio');
  assert.match(unassessedRow, /Not assessed/);
});

test('released evidence downloads are explicit, current, client-safe and deny by default', async () => {
  const detailPath = `/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}`;
  const downloadPath = `${detailPath}/evidence-releases/${ids.downloadableReleaseId}/download`;
  const page = await clientOwner.get(detailPath);
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.match(page.text, new RegExp(`href="${downloadPath}"`));
  assert.match(page.text, /Download client-released file/);
  assert.match(page.text, /Metadata released only\. The underlying file has not been shared for download/);
  assert.match(page.text, /source file is expired or unavailable and cannot be downloaded/);
  assert.doesNotMatch(page.text,
    /internal-soc2-report|client-released-evidence-|internal-metadata-only|internal-stale-source|client-missing-source-/);
  for (const unavailableId of [
    ids.metadataReleaseId, ids.staleSourceReleaseId, ids.missingSourceReleaseId,
    ids.expiredReleaseId, ids.withdrawnReleaseId,
  ]) {
    assert.doesNotMatch(page.text, new RegExp(`evidence-releases/${unavailableId}/download`));
  }

  for (const actor of [clientOwner, clientAdmin, securityReviewer]) {
    const downloaded = await actor.get(downloadPath);
    assert.equal(downloaded.status, 200, downloaded.text.slice(0, 300));
    assert.equal(downloaded.buffer.toString('utf8'), 'client released evidence bytes');
    assert.match(String(downloaded.headers['content-disposition']),
      /^attachment; filename="Independent control assurance\.pdf"$/);
    assert.doesNotMatch(String(downloaded.headers['content-disposition']),
      /internal-soc2-report|client-released-evidence-/);
    assert.equal(downloaded.headers['cache-control'], 'private, no-store, max-age=0');
    assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
  }

  const preview = await manager.get(`${detailPath}?preview=client`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Client download enabled/);
  assert.doesNotMatch(preview.text, new RegExp(`href="${downloadPath}"`));
  assert.equal((await manager.get(downloadPath)).status, 403,
    'firm preview cannot turn into a client download session');

  for (const unavailableId of [
    ids.metadataReleaseId, ids.staleSourceReleaseId, ids.missingSourceReleaseId,
    ids.expiredReleaseId, ids.withdrawnReleaseId,
  ]) {
    const blocked = await clientOwner.get(
      `${detailPath}/evidence-releases/${unavailableId}/download`
    );
    assert.equal(blocked.status, 404, `release ${unavailableId} must fail closed`);
  }
  const wrongThirdParty = await clientOwner.get(
    `/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.overrideSupplierId}/evidence-releases/${ids.downloadableReleaseId}/download`
  );
  assert.equal(wrongThirdParty.status, 404);
  const otherTenant = await otherClient.get(downloadPath);
  assert.ok([403, 404].includes(otherTenant.status));
});

test('security reviewer can comment but cannot record or accept the client decision', async () => {
  const detail = await securityReviewer.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}`);
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.text, /Record final client decision/);
  assert.match(detail.text, /Waiting for the client decision authority/);
  const comment = await securityReviewer.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}/comments`, {
    body: 'Please confirm the stated production hosting boundary.'
  });
  assert.equal(comment.status, 302);
  const stored = db.prepare(`SELECT body,internal_only FROM comments
    WHERE workspace_id=? AND parent_type='tprm_third_party' AND parent_id=? ORDER BY id DESC LIMIT 1`).get(
      ids.workspaceId, String(ids.supplierId));
  assert.equal(stored.internal_only, 0);
  assert.notEqual(stored.body, 'Please confirm the stated production hosting boundary.', 'client comment should be encrypted at rest');
  const afterComment = await securityReviewer.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}`);
  assert.match(afterComment.text, /Please confirm the stated production hosting boundary/);
  const denied = await securityReviewer.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}/decision`, {
    decision:'onboard', rationale:'Security reviewer must not become the client decision authority.'
  });
  assert.equal(denied.status, 403);
});

test('firm users cannot use the client decision endpoint, including Manager wildcard', async () => {
  for (const actor of [manager, consultant]) {
    const attempt = await actor.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}/decision`, {
      decision:'onboard', rationale:'A consultancy user must never record the final client decision.',
      expected_recommendation_id:ids.recommendationId, idempotency_nonce:'a'.repeat(48), acknowledge_authority:'1'
    });
    assert.equal(attempt.status, 403);
  }
});

test('tenant scoping blocks direct-route access to another client third party', async () => {
  const crossWorkspace = await clientOwner.get(`/workspaces/${ids.otherWorkspaceId}/client-portal/tprm/${ids.otherSupplierId}`);
  assert.ok([403, 404].includes(crossWorkspace.status));
  const guessedId = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.otherSupplierId}`);
  assert.equal(guessedId.status, 404);
  assert.doesNotMatch(guessedId.text, /Other Client Secret Provider/);
});

test('assigned client_admin can record a decision through the portal', async () => {
  const page = await clientAdmin.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.adminSupplierId}`);
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.match(page.text, /Record final client decision/);
  assert.match(page.text, /name="expected_current_decision_id" value="0"/);
  const nonce = (page.text.match(/name="idempotency_nonce" value="([a-f0-9]{48})"/) || [])[1];
  const result = await clientAdmin.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.adminSupplierId}/decision`, {
    decision:'onboard',
    rationale:'The authorised client administrator approves onboarding for the exact assessed managed HR service scope.',
    acknowledge_authority:'1',
    expected_recommendation_id:String(ids.adminRecommendationId),
    expected_current_decision_id:'0',
    idempotency_nonce:nonce
  });
  assert.equal(result.status, 302, result.text.slice(0, 300));
  const decision = db.prepare('SELECT * FROM tprm_client_decisions WHERE supplier_id=?').get(ids.adminSupplierId);
  assert.equal(decision.client_actor_user_id, ids.clientAdminId);
  assert.equal(decision.decision, 'onboard');
});

test('portal supports defer, a newer same-cycle recommendation, then a final successor decision', async () => {
  const firstPage = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.deferredSupplierId}`);
  assert.equal(firstPage.status, 200);
  const firstNonce = (firstPage.text.match(/name="idempotency_nonce" value="([a-f0-9]{48})"/) || [])[1];
  const deferredResponse = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.deferredSupplierId}/decision`, {
    decision:'defer_request_information',
    rationale:'The client requests additional current identity-control assurance before making a final onboarding decision.',
    acknowledge_authority:'1', expected_recommendation_id:String(ids.deferredRecommendationId),
    expected_current_decision_id:'0', idempotency_nonce:firstNonce
  });
  assert.equal(deferredResponse.status, 302, deferredResponse.text.slice(0, 300));
  const deferredDecision = db.prepare('SELECT * FROM tprm_client_decisions WHERE supplier_id=?').get(ids.deferredSupplierId);
  assert.equal(deferredDecision.decision, 'defer_request_information');
  assert.equal(db.prepare('SELECT status FROM tprm_assessment_cycles WHERE id=?').get(ids.deferredCycleId).status, 'active');

  const prior = db.prepare('SELECT * FROM tprm_recommendations WHERE id=?').get(ids.deferredRecommendationId);
  const successorId = Number(db.prepare(`INSERT INTO tprm_recommendations
    (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
     residual_risk_score,residual_risk_band,valid_until,inherent_assessment_id,ddq_assessment_id,
     contract_review_id,readiness_snapshot_json,artifact_snapshot_json,recommendation_hash,
     issued_by,issuer_name,issued_at,quality_reviewed_by,quality_reviewer_name,quality_reviewed_at,
     quality_review_rationale,supersedes_id)
    VALUES (?,?,?,2,'recommend_onboard',?,?,31,'moderate',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      prior.workspace_id, prior.supplier_id, prior.cycle_id,
      'Additional assurance supports onboarding within the unchanged assessed service scope.',
      'The requested identity-control evidence was reviewed and resolves the prior information gap.',
      futureDate(365), prior.inherent_assessment_id, prior.ddq_assessment_id, prior.contract_review_id,
      prior.readiness_snapshot_json, prior.artifact_snapshot_json, crypto.randomBytes(32).toString('hex'),
      prior.issued_by, prior.issuer_name, new Date(Date.now() + 1000).toISOString(),
      prior.quality_reviewed_by, prior.quality_reviewer_name, new Date(Date.now() + 1000).toISOString(),
      'Independent review confirmed the additional evidence and refreshed conclusion.', prior.id
    ).lastInsertRowid);

  const successorPage = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.deferredSupplierId}`);
  assert.equal(successorPage.status, 200, successorPage.text.slice(0, 500));
  assert.match(successorPage.text, /Successor recommendation issued/);
  assert.match(successorPage.text, new RegExp(`name="expected_current_decision_id" value="${deferredDecision.id}"`));
  const successorNonce = (successorPage.text.match(/name="idempotency_nonce" value="([a-f0-9]{48})"/) || [])[1];
  const finalResponse = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.deferredSupplierId}/decision`, {
    decision:'onboard',
    rationale:'The client reviewed the successor recommendation and now approves the exact managed identity service scope.',
    acknowledge_authority:'1', expected_recommendation_id:String(successorId),
    expected_current_decision_id:String(deferredDecision.id), idempotency_nonce:successorNonce
  });
  assert.equal(finalResponse.status, 302, finalResponse.text.slice(0, 300));
  const finalDecision = db.prepare(`SELECT * FROM tprm_client_decisions
    WHERE supplier_id=? ORDER BY version DESC LIMIT 1`).get(ids.deferredSupplierId);
  assert.equal(finalDecision.supersedes_id, deferredDecision.id);
  assert.equal(finalDecision.decision, 'onboard');

  const stale = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.deferredSupplierId}/decision`, {
    decision:'onboard', rationale:'A stale browser tab must not overwrite the immutable final decision record.',
    acknowledge_authority:'1', expected_recommendation_id:String(successorId),
    expected_current_decision_id:String(deferredDecision.id), idempotency_nonce:successorNonce
  });
  assert.equal(stale.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tprm_client_decisions WHERE supplier_id=?').get(ids.deferredSupplierId).c, 2);
});

test('client override of a negative recommendation requires explicit expiring risk acceptance', async () => {
  const page = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.overrideSupplierId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Do Not Recommend/);
  const nonce = (page.text.match(/name="idempotency_nonce" value="([a-f0-9]{48})"/) || [])[1];
  const base = {
    decision:'onboard',
    rationale:'The client has a time-bound operational requirement and elects to override the consultancy recommendation.',
    acknowledge_authority:'1',
    expected_recommendation_id:String(ids.overrideRecommendationId),
    idempotency_nonce:nonce
  };
  const missingAcceptance = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.overrideSupplierId}/decision`, { ...base });
  assert.equal(missingAcceptance.status, 422);
  assert.match(missingAcceptance.text, /Explicit residual-risk acceptance is required/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tprm_client_decisions WHERE supplier_id=?').get(ids.overrideSupplierId).c, 0);

  const refreshedNonce = (missingAcceptance.text.match(/name="idempotency_nonce" value="([a-f0-9]{48})"/) || [])[1];
  const accepted = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.overrideSupplierId}/decision`, {
    ...base,
    idempotency_nonce:refreshedNonce,
    accept_residual_risk:'1',
    risk_acceptance_rationale:'The client accepts the stated access-control exposure temporarily while compensating monitoring is implemented.',
    risk_acceptance_expires_at:futureDate(180)
  });
  assert.equal(accepted.status, 302, accepted.text.slice(0, 300));
  const row = db.prepare('SELECT * FROM tprm_client_decisions WHERE supplier_id=?').get(ids.overrideSupplierId);
  assert.equal(row.decision, 'onboard');
  assert.equal(row.diverges_from_recommendation, 1);
  assert.match(row.risk_acceptance_statement, /accepts the stated access-control exposure/i);
  assert.equal(row.risk_acceptance_expires_at, futureDate(180));
});

test('onboarding with conditions carries forward structured ownership and verification criteria', async () => {
  const page = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.conditionalSupplierId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Enforce phishing-resistant MFA/);
  const nonce = (page.text.match(/name="idempotency_nonce" value="([a-f0-9]{48})"/) || [])[1];
  const result = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.conditionalSupplierId}/decision`, {
    decision:'onboard_with_conditions',
    rationale:'The client approves onboarding only while the issued MFA condition remains owned, dated and independently verified.',
    acknowledge_authority:'1',
    expected_recommendation_id:String(ids.conditionalRecommendationId),
    idempotency_nonce:nonce
  });
  assert.equal(result.status, 302, result.text.slice(0, 300));
  const decision = db.prepare('SELECT * FROM tprm_client_decisions WHERE supplier_id=?').get(ids.conditionalSupplierId);
  assert.equal(decision.decision, 'onboard_with_conditions');
  const copied = db.prepare(`SELECT * FROM tprm_conditions
    WHERE supplier_id=? AND source_type='client_decision' AND client_decision_id=?`).get(ids.conditionalSupplierId, decision.id);
  assert.equal(copied.owner_user_id, ids.clientOwnerId);
  assert.equal(copied.due_date, '2026-10-31');
  assert.match(copied.verification_criteria, /configuration export/i);
});

test('assigned owner and ISMS reviewer can discover and download protected condition evidence', async () => {
  const condition = db.prepare(`SELECT * FROM tprm_conditions
    WHERE workspace_id=? AND supplier_id=? AND source_type='client_decision'`).get(
      ids.workspaceId, ids.conditionalSupplierId
    );
  assert.ok(condition, 'the client-owned condition should exist before evidence submission');
  const domain = require('../lib/tprm-domain');
  const started = domain.clientStartConditionWork(db, {
    workspaceId:ids.workspaceId, supplierId:ids.conditionalSupplierId,
    conditionId:condition.id, actorId:ids.clientOwnerId,
    expectedStatus:condition.status,
  });
  const storedPath = retainTestEvidence(
    ids.firmId, `protected-condition-evidence-${process.pid}.pdf`,
    'protected condition evidence bytes'
  );
  const submitted = domain.clientSubmitCondition(db, {
    workspaceId:ids.workspaceId, supplierId:ids.conditionalSupplierId,
    conditionId:condition.id, actorId:ids.clientOwnerId,
    expectedRowVersion:started.condition.row_version,
    completionStatement:'Phishing-resistant MFA is now enforced for every privileged production account in the assessed service.',
    evidence:{
      originalFilename:'internal-client-export-name.pdf', storedPath,
      mimeType:'application/pdf', sizeBytes:35,
      sha256:crypto.createHash('sha256').update('protected condition evidence bytes').digest('hex'),
    },
  });
  assert.ok(submitted.evidence);
  const detailPath = `/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.conditionalSupplierId}`;
  const downloadPath = `${detailPath}/conditions/${condition.id}/evidence/${submitted.evidence.id}/download`;

  for (const actor of [clientOwner, securityReviewer]) {
    const page = await actor.get(detailPath);
    assert.equal(page.status, 200, page.text.slice(0, 500));
    assert.match(page.text, /Submitted condition evidence/);
    assert.match(page.text, new RegExp(`href="${downloadPath}"`));
    assert.doesNotMatch(page.text, /internal-client-export-name|protected-condition-evidence-/);
    const downloaded = await actor.get(downloadPath);
    assert.equal(downloaded.status, 200, downloaded.text.slice(0, 300));
    assert.equal(downloaded.buffer.toString('utf8'), 'protected condition evidence bytes');
    assert.equal(String(downloaded.headers['content-disposition']),
      `attachment; filename="condition-evidence-${submitted.evidence.id}.pdf"`);
    assert.doesNotMatch(String(downloaded.headers['content-disposition']),
      /internal-client-export-name|protected-condition-evidence-/);
  }

  const unassigned = await clientAdmin.get(detailPath);
  assert.equal(unassigned.status, 200);
  assert.doesNotMatch(unassigned.text, new RegExp(`href="${downloadPath}"`));
  assert.equal((await clientAdmin.get(downloadPath)).status, 403);
  assert.equal((await manager.get(downloadPath)).status, 403);
});

test('client decision endpoint enforces CSRF and records one immutable decision', async () => {
  const page = await clientOwner.get(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}`);
  assert.equal(page.status, 200, page.text.slice(0, 500));
  const nonce = (page.text.match(/name="idempotency_nonce" value="([a-f0-9]{48})"/) || [])[1];
  assert.ok(nonce);
  const body = {
    decision:'onboard',
    rationale:'The client accepts the assessed moderate residual risk and approves onboarding for the stated scope.',
    valid_until:futureDate(365),
    acknowledge_authority:'1',
    expected_recommendation_id:String(ids.recommendationId),
    idempotency_nonce:nonce
  };
  const noCsrf = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}/decision`, { ...body }, { csrf:false });
  assert.equal(noCsrf.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tprm_client_decisions WHERE workspace_id=? AND supplier_id=?').get(ids.workspaceId, ids.supplierId).c, 0);

  const pastDated = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}/decision`, {
    ...body, valid_until:'2000-01-01'
  });
  assert.equal(pastDated.status, 422);
  assert.match(pastDated.text, /Decision review date must be in the future/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tprm_client_decisions WHERE workspace_id=? AND supplier_id=?').get(ids.workspaceId, ids.supplierId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tprm_review_schedules WHERE workspace_id=? AND supplier_id=?').get(ids.workspaceId, ids.supplierId).c, 0);

  const recorded = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}/decision`, { ...body });
  assert.equal(recorded.status, 302, recorded.text.slice(0, 300));
  const row = db.prepare('SELECT * FROM tprm_client_decisions WHERE workspace_id=? AND supplier_id=?').get(ids.workspaceId, ids.supplierId);
  assert.equal(row.decision, 'onboard');
  assert.equal(row.client_actor_user_id, ids.clientOwnerId);
  assert.equal(row.recommendation_id, ids.recommendationId);
  assert.equal(db.prepare('SELECT status FROM tprm_assessment_cycles WHERE id=?').get(ids.cycleId).status, 'completed');

  assert.throws(() => db.prepare('UPDATE tprm_client_decisions SET rationale=? WHERE id=?').run('Changed after decision', row.id), /immutable/i);
  assert.throws(() => db.prepare('DELETE FROM tprm_client_decisions WHERE id=?').run(row.id), /cannot be deleted/i);
  const replay = await clientOwner.post(`/workspaces/${ids.workspaceId}/client-portal/tprm/${ids.supplierId}/decision`, { ...body });
  assert.equal(replay.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tprm_client_decisions WHERE workspace_id=? AND supplier_id=?').get(ids.workspaceId, ids.supplierId).c, 1);
});

test('closed TPRM service period remains visible as retained read-only history', async () => {
  const domain = require('../lib/tprm-domain');
  const closedWorkspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,lead_consultant_id)
    VALUES (?,'Closed TPRM History Client','active','[]',?)`).run(ids.firmId, ids.consultantId).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')")
    .run(closedWorkspaceId, ids.clientOwnerId);
  const closedModuleId = Number(db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Completed managed TPRM service period',?)`).run(
      closedWorkspaceId, ids.managerId).lastInsertRowid);
  const closedSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,lifecycle_stage)
    VALUES (?,'Retained Assurance Provider','Retained production service','tier_2','active')`).run(
      closedWorkspaceId).lastInsertRowid);
  const governed = seedRecommendation(
    closedWorkspaceId, closedSupplierId, closedModuleId, ids.consultantId, ids.seniorId, ids.clientOwnerId,
    { summary:'RETAINED-RECOMMENDATION-CANARY The assessed service was approved during the closed service period.' }
  );
  const decision = domain.recordClientDecision(db, {
    workspaceId:closedWorkspaceId, supplierId:closedSupplierId, cycleId:governed.cycleId,
    recommendationId:governed.recommendationId, actorId:ids.clientOwnerId, decision:'onboard',
    rationale:'RETAINED-DECISION-CANARY The client approved the exact assessed service during the governed period.',
    expectedCurrentDecisionId:null,
  }).decision;
  assert.equal(decision.decision, 'onboard');
  const retainedDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,sha256,size_bytes,uploaded_by)
    VALUES (?,?,'assurance','Retained assurance','retained-assurance.pdf',?,512,?)`).run(
      closedWorkspaceId, closedSupplierId, crypto.randomBytes(32).toString('hex'), ids.consultantId).lastInsertRowid);
  domain.releaseEvidence(db, {
    workspaceId:closedWorkspaceId, supplierId:closedSupplierId, cycleId:governed.cycleId,
    sourceType:'supplier_document', sourceId:retainedDocumentId, actorId:ids.seniorId,
    clientLabel:'RETAINED-EVIDENCE-CANARY', clientDescription:'Released before service-period closure.',
    expiresAt:futureDate(365), allowDownload:false,
  });
  domain.closeModule(db, {
    workspaceId:closedWorkspaceId, actorId:ids.managerId, expectedModuleId:closedModuleId,
    reason:'The contracted managed TPRM service period has ended with all governed work complete.',
  });
  assert.equal(db.prepare('SELECT status FROM tprm_modules WHERE id=?').get(closedModuleId).status, 'closed');
  assert.equal(domain.moduleForWorkspace(db, closedWorkspaceId, { includeClosed:true }).status, 'closed');

  const portfolio = await clientOwner.get(`/workspaces/${closedWorkspaceId}/client-portal/tprm`);
  assert.equal(portfolio.status, 200, portfolio.text.slice(0, 500));
  // The application-wide typography normalizer renders the em dash as a
  // plain hyphen in HTTP responses; either representation carries the banner.
  assert.match(portfolio.text, /Closed TPRM service period (?:—|-) retained read-only/);
  assert.match(portfolio.text, /Retained Assurance Provider/);
  assert.match(portfolio.text, /Recommend Onboard/);
  assert.match(portfolio.text, /Onboard/);
  assert.doesNotMatch(portfolio.text, /Record final client decision/);

  const detail = await clientOwner.get(`/workspaces/${closedWorkspaceId}/client-portal/tprm/${closedSupplierId}`);
  assert.equal(detail.status, 200, detail.text.slice(0, 500));
  assert.match(detail.text, /RETAINED-RECOMMENDATION-CANARY/);
  assert.match(detail.text, /RETAINED-DECISION-CANARY/);
  assert.match(detail.text, /RETAINED-EVIDENCE-CANARY/);
  assert.doesNotMatch(detail.text, /Record final client decision|Add a comment/);

  const decisionCount = db.prepare('SELECT COUNT(*) AS c FROM tprm_client_decisions WHERE workspace_id=?').get(closedWorkspaceId).c;
  const deniedDecision = await clientOwner.post(`/workspaces/${closedWorkspaceId}/client-portal/tprm/${closedSupplierId}/decision`, {
    decision:'onboard', rationale:'No successor decision may be recorded after module closure.'
  });
  assert.equal(deniedDecision.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tprm_client_decisions WHERE workspace_id=?').get(closedWorkspaceId).c, decisionCount);
  const deniedComment = await clientOwner.post(`/workspaces/${closedWorkspaceId}/client-portal/tprm/${closedSupplierId}/comments`, {
    body:'No new comment may be appended after module closure.'
  });
  assert.equal(deniedComment.status, 409);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM comments
    WHERE workspace_id=? AND parent_type='tprm_third_party' AND parent_id=?`).get(
      closedWorkspaceId, String(closedSupplierId)).c, 0);
});
