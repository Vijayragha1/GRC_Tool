'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const ejs = require('ejs');
const { bootClient, makeClient } = require('./helpers');

let client;
let authorClient;
let dbPath;
let app;
let managerId;
let activeWorkspaceId;
let classifiedWorkspaceId;
let thirdPartyId;
let primaryRelationshipId;
let recommendationAuthorId;
let clientOwnerId;
let relationshipDocumentId;
let relationshipDocumentPath;

function formFor(html, action) {
  const marker = `action="${action}"`;
  const markerAt = html.indexOf(marker);
  assert.notEqual(markerAt, -1, `expected form action ${action}`);
  const formAt = html.lastIndexOf('<form', markerAt);
  const endAt = html.indexOf('</form>', markerAt);
  return html.slice(formAt, endAt + 7);
}

function hiddenValue(form, name) {
  const match = form.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert.ok(match, `expected hidden form field ${name}`);
  return match[1];
}

async function loginAs(browser, email, password) {
  const page = await browser.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF missing for ${email}`);
  const signedIn = await browser.post('/login', { email, password, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302);
  await browser.get('/dashboard');
}

test.before(async () => {
  const booted = await bootClient();
  ({ client, dbPath, app } = booted);
  const db = new Database(dbPath);
  const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const manager = db.prepare("SELECT id,password_hash FROM users WHERE user_type='firm' AND firm_id=? ORDER BY id DESC LIMIT 1").get(firm.id);
  managerId = manager.id;

  activeWorkspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks) VALUES (?,?,?)`)
    .run(firm.id, 'TPRM Active Client', '["csf"]').lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Test production module',?)`).run(activeWorkspaceId, manager.id);
  thirdPartyId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,business_owner,relationship_owner,security_reviewer,next_review_date)
    VALUES (?,?,?,'prospect','Client Risk Owner','Consultancy Lead','QA Reviewer','2026-12-31')`)
    .run(activeWorkspaceId, 'Acme Cloud', 'Production data hosting').lastInsertRowid);
  primaryRelationshipId = require('../lib/tprm-relationships').createRelationship(db, {
    workspaceId:activeWorkspaceId, supplierId:thirdPartyId, actorId:manager.id,
    relationshipName:'Production data hosting', serviceDescription:'Production data hosting',
    criticality:'high', dataAccess:'confidential', status:'intake', isPrimary:true,
    reason:'Primary service relationship for the TPRM module integration fixture.',
  }).relationship.id;
  db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,assessment_type,status,created_by)
    VALUES (?,?,'2026.1','onboarding','draft',?)`).run(activeWorkspaceId, thirdPartyId, manager.id);
  db.prepare(`INSERT INTO supplier_decisions
    (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name,residual_risk_band)
    VALUES (?,?,'approved','Historic firm-authored supplier decision.',40,1,'Legacy consultant','moderate')`)
    .run(activeWorkspaceId, thirdPartyId);

  recommendationAuthorId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,'consultant',1)`).run(
      'tprm-author@example.test', manager.password_hash, 'Assessment Author', firm.id
    ).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'consultant')`)
    .run(activeWorkspaceId, recommendationAuthorId);
  clientOwnerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'client',?,NULL,1)`).run(
      'tprm-owner@example.test', manager.password_hash, 'Client Decision Owner', firm.id
    ).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')`)
    .run(activeWorkspaceId, clientOwnerId);
  const relationshipDocumentStoredPath = `tprm-governed-evidence-${process.pid}.pdf`;
  const firmUploadDir = path.join(__dirname, '..', 'uploads', `firm_${firm.id}`);
  fs.mkdirSync(firmUploadDir, { recursive:true });
  relationshipDocumentPath = path.join(firmUploadDir, relationshipDocumentStoredPath);
  fs.writeFileSync(relationshipDocumentPath, 'immutable governed evidence bytes');
  relationshipDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,effective_date,expiry_date,uploaded_by)
    VALUES (?,?,'assurance','Independent assurance report','internal-assurance-report.pdf',?,?,2048,'2026-08-01','2027-08-01',?)`)
    .run(activeWorkspaceId, thirdPartyId, relationshipDocumentStoredPath, 'a'.repeat(64), manager.id).lastInsertRowid);

  classifiedWorkspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks) VALUES (?,?,?)`)
    .run(firm.id, 'TPRM Classification Client', '["iso27001"]').lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules (workspace_id,service_model,status,activation_reason)
    VALUES (?,NULL,'needs_classification','Historic records require classification')`).run(classifiedWorkspaceId);
  db.prepare(`INSERT INTO suppliers (workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,?,'Legacy payment service','active')`).run(classifiedWorkspaceId, 'Legacy Payments');

  const otherFirm = Number(db.prepare(`INSERT INTO firms (name) VALUES ('Other Firm')`).run().lastInsertRowid);
  const otherWorkspace = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks) VALUES (?,?,?)`)
    .run(otherFirm, 'Unauthorized Client', '["csf"]').lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules (workspace_id,service_model,status,activation_reason)
    VALUES (?,'managed_lifecycle','active','Other tenant')`).run(otherWorkspace);
  db.prepare(`INSERT INTO suppliers (workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,?,'Must never be exposed','active')`).run(otherWorkspace, 'Hidden Provider');
  db.close();
  authorClient = makeClient(app);
  await loginAs(authorClient, 'tprm-author@example.test', booted.login.password);
});

test.after(async () => {
  if (client) await client.close();
  if (authorClient) await authorClient.close();
  if (relationshipDocumentPath && fs.existsSync(relationshipDocumentPath)) fs.unlinkSync(relationshipDocumentPath);
});

test('standalone navigation is framework-independent and uses canonical terms', async () => {
  const navigation = await ejs.renderFile(path.join(__dirname, '..', 'views', 'partials', 'client_navigation.ejs'), {
    ws: { id: 77, frameworks: ['csf'], tprm_enabled: 1 },
    user: { user_type: 'firm', firm_role: 'manager' },
    rbac: { isManager: () => true }, active: 'tprm-overview', openReviewCount: 0,
  });
  assert.match(navigation, /Third-party risk/);
  assert.match(navigation, /Third parties/);
  assert.match(navigation, /Monitoring &amp; renewals/);
  assert.match(navigation, /Methodology &amp; settings/);
  assert.doesNotMatch(navigation, />Suppliers</);
});

test('overview provides traceable metrics and exactly one next action per third party', async () => {
  const response = await client.get(`/workspaces/${activeWorkspaceId}/tprm`);
  assert.equal(response.status, 200);
  for (const label of ['Action required', 'Waiting on provider', 'High or critical risk', 'Overdue or expiring']) assert.match(response.text, new RegExp(label));
  assert.match(response.text, new RegExp(`/workspaces/${activeWorkspaceId}/tprm/assessments\\?attention=1`));
  assert.match(response.text, /Every record has one next action/);
  const ids = [...response.text.matchAll(/data-third-party-id="(\d+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'the prioritized queue must not duplicate a third party');
  assert.match(response.text, /Start onboarding assessment/);
});

test('register, assessment, reporting and assurance surfaces render end to end', async () => {
  for (const route of [
    'third-parties', 'third-parties/new', `third-parties/${thirdPartyId}`,
    'assessments', 'findings', 'monitoring', 'reports', 'assurance', 'settings',
  ]) {
    const response = await client.get(`/workspaces/${activeWorkspaceId}/tprm/${route}`);
    assert.equal(response.status, 200, `${route} should render`);
    assert.doesNotMatch(response.text, /ReferenceError|SQLITE_ERROR/);
  }
});

test('consultant due-diligence view uses canonical terms and hides manager-only methodology actions', async () => {
  const response = await authorClient.get(`/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}/due-diligence`);
  assert.equal(response.status, 200);
  assert.match(response.text, /Third-party due diligence/);
  assert.doesNotMatch(response.text, /Vendor due diligence|Issue to vendor|Vendor answered|Waiting for vendor/i);
  assert.doesNotMatch(response.text, /href="\/workspaces\/[^\"]+\/supplier-methodology"/);
  assert.doesNotMatch(response.text, /Configure methodology|View configuration|Open methodology workbench/);
});

test('legacy supplier decisions are quarantined and never shown as client decisions', async () => {
  const response = await client.get(`/workspaces/${activeWorkspaceId}/tprm/third-parties/${thirdPartyId}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /Pending Client Decision/i);
  assert.match(response.text, /Legacy decision quarantine/);
  assert.match(response.text, /Not a client decision/);
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tprm.js'), 'utf8');
  assert.match(routeSource, /supplier_decisions pre-dates the client-only decision boundary/);
  assert.doesNotMatch(routeSource, /return row\.legacy_decision/);
});

test('controlled register export keeps consultancy advice and the client decision in separate columns', async () => {
  const response = await client.get(`/workspaces/${activeWorkspaceId}/vendors/export.csv`);
  assert.equal(response.status, 200);
  assert.match(String(response.headers['content-disposition'] || ''), /third-party-risk-register-/);
  const header = response.text.split('\n')[0];
  assert.match(header, /"consultancy_recommendation"/);
  assert.match(header, /"consultancy_rationale"/);
  assert.match(header, /"client_final_decision"/);
  assert.match(header, /"client_decision_rationale"/);
  assert.match(header, /"client_decision_authority"/);
  assert.doesNotMatch(header, /"current_decision"/);
  assert.doesNotMatch(response.text, /Legacy consultancy-authored decision|Historic firm-authored supplier decision/);
});

test('third-party intake atomically creates its legal entity and primary service relationship', async () => {
  const newPath = `/workspaces/${activeWorkspaceId}/tprm/third-parties/new`;
  const page = await client.get(newPath);
  const action = `/workspaces/${activeWorkspaceId}/vendors`;
  const form = formFor(page.text, action);
  const payload = {
    _csrf: hiddenValue(form, '_csrf'),
    name: 'Atomic Intake Provider',
    service_provided: 'Managed identity verification service',
    business_owner: 'Client Identity Owner',
    relationship_owner: 'Consultancy TPRM Lead',
    security_reviewer: 'Independent Security Reviewer',
    contact: 'security@atomic-intake.example.test',
    business_criticality: 'high',
    data_access: 'sensitive',
    dependency_type: 'single_source',
    processing_purpose: 'Verify customer identity before regulated account onboarding.',
  };
  const created = await client.post(action, payload);
  assert.ok([302, 303].includes(created.status));

  const db = new Database(dbPath);
  try {
    const thirdParty = db.prepare(`SELECT * FROM suppliers WHERE workspace_id=? AND name=?`).get(activeWorkspaceId, payload.name);
    assert.ok(thirdParty);
    const legalEntity = db.prepare(`SELECT * FROM tprm_legal_entities WHERE workspace_id=? AND supplier_id=?`).get(activeWorkspaceId, thirdParty.id);
    const relationship = db.prepare(`SELECT * FROM tprm_service_relationships WHERE workspace_id=? AND supplier_id=?`).get(activeWorkspaceId, thirdParty.id);
    assert.ok(legalEntity);
    assert.equal(relationship.legal_entity_id, legalEntity.id);
    assert.equal(relationship.relationship_name, payload.service_provided);
    assert.equal(relationship.criticality, 'high');
    assert.equal(relationship.data_access, 'restricted');
    assert.equal(relationship.sole_source, 1);
    assert.equal(relationship.is_primary, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM supplier_inherent_assessments
      WHERE workspace_id=? AND supplier_id=?`).get(activeWorkspaceId, thirdParty.id).count, 0,
    'fieldwork must not exist before the exact service scope is frozen in a governed cycle');
    assert.match(String(created.headers.location || ''), new RegExp(`/tprm/third-parties/${thirdParty.id}`));
  } finally { db.close(); }

  const duplicate = await client.post(action, payload);
  assert.equal(duplicate.status, 303);
  const verify = new Database(dbPath);
  try {
    assert.equal(verify.prepare(`SELECT COUNT(*) AS count FROM suppliers WHERE workspace_id=? AND name=?`).get(activeWorkspaceId, payload.name).count, 1);
  } finally { verify.close(); }
});

test('governed cycle, maker-checker recommendation and evidence disclosure run end to end', async () => {
  const detailPath = `/workspaces/${activeWorkspaceId}/tprm/third-parties/${thirdPartyId}`;
  let page = await client.get(detailPath);
  const cycleAction = `${detailPath}/cycles`;
  const cycleForm = formFor(page.text, cycleAction);
  const start = await client.post(cycleAction, {
    cycle_type: 'onboarding',
    due_at: '2027-01-31',
    client_decision_authority_id: String(clientOwnerId),
    trigger_reason: 'New provider onboarding assessment requested by the client.',
    relationship_ids: String(primaryRelationshipId),
    expected_current_cycle_id: hiddenValue(cycleForm, 'expected_current_cycle_id'),
    idempotency_key: hiddenValue(cycleForm, 'idempotency_key'),
  });
  assert.equal(start.status, 303);

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  let cycle = db.prepare(`SELECT * FROM tprm_assessment_cycles
    WHERE workspace_id=? AND supplier_id=? AND status='active'`).get(activeWorkspaceId, thirdPartyId);
  assert.ok(cycle);
  assert.equal(cycle.client_decision_authority_id, clientOwnerId);
  const cycleScope = db.prepare(`SELECT * FROM tprm_cycle_relationship_scopes
    WHERE workspace_id=? AND cycle_id=? AND relationship_id=?`).get(activeWorkspaceId, cycle.id, primaryRelationshipId);
  assert.equal(cycleScope.scope_role, 'primary');
  const gatedPage = await authorClient.get(detailPath);
  assert.match(gatedPage.text, /Positive recommendation is currently locked/);
  assert.match(gatedPage.text, /Save negative or insufficient-information draft/);
  assert.match(gatedPage.text, /value="recommend_onboard"[^>]*disabled/);
  assert.match(gatedPage.text, /value="recommend_with_conditions"[^>]*disabled/);
  const inherent = db.prepare(`SELECT * FROM supplier_inherent_assessments
    WHERE workspace_id=? AND supplier_id=? ORDER BY id DESC LIMIT 1`).get(activeWorkspaceId, thirdPartyId);
  assert.equal(cycle.inherent_assessment_id, inherent.id);
  db.prepare(`UPDATE supplier_inherent_assessments SET status='approved',weighted_score=32,
    assigned_tier='tier_2',unknown_count=0,module_applicability_json='[]',approved_at=datetime('now'),approved_by=?
    WHERE id=?`).run(recommendationAuthorId, inherent.id);
  const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,assessment_type,status,
     modules_json,completed_at,completed_by,created_by)
    VALUES (?,?,?,'2026.1','tier_2','onboarding','complete','[]',datetime('now'),?,?)`)
    .run(activeWorkspaceId, thirdPartyId, inherent.id, recommendationAuthorId, recommendationAuthorId).lastInsertRowid);
  const contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,status,agreement_reference,
     agreement_date,reviewer_id,completed_at)
    VALUES (?,?,?,'2026.1','complete','MSA-ACME-2026','2026-08-15',?,datetime('now'))`)
    .run(activeWorkspaceId, thirdPartyId, inherent.id, recommendationAuthorId).lastInsertRowid);
  const domain = require('../lib/tprm-domain');
  domain.linkCycleArtifacts(db, {
    workspaceId: activeWorkspaceId, supplierId: thirdPartyId, cycleId: cycle.id,
    actorId: recommendationAuthorId, inherentAssessmentId: inherent.id,
    ddqAssessmentId: ddqId, contractReviewId: contractId,
    reason: 'Bound completed assessment artifacts for quality review.',
    idempotencyKey: 'test-artifact-linkage-0000000000000001',
  });
  cycle = db.prepare('SELECT * FROM tprm_assessment_cycles WHERE id=?').get(cycle.id);
  assert.equal(domain.lifecycleProjection(db, activeWorkspaceId, thirdPartyId).stage, 'quality_review');
  db.close();

  page = await authorClient.get(detailPath);
  assert.match(page.text, /Client Decision Owner/);
  assert.match(page.text, /Draft, independent review and issue/);
  const draftAction = `${detailPath}/recommendation-drafts`;
  const draftForm = formFor(page.text, draftAction);
  const drafted = await authorClient.post(draftAction, {
    cycle_id: hiddenValue(draftForm, 'cycle_id'),
    expected_cycle_row_version: hiddenValue(draftForm, 'expected_cycle_row_version'),
    idempotency_key: hiddenValue(draftForm, 'idempotency_key'),
    outcome: 'recommend_onboard',
    residual_risk_band: 'moderate',
    residual_risk_score: '32',
    valid_until: '2027-08-31',
    executive_summary: 'The completed evidence supports onboarding at moderate residual risk.',
    rationale: 'Inherent risk, provider due diligence and contract assurance are complete, with no unresolved high findings.',
  });
  assert.equal(drafted.status, 303);

  let workflowDb = new Database(dbPath, { readonly: true });
  const draft = workflowDb.prepare(`SELECT * FROM tprm_recommendation_drafts
    WHERE workspace_id=? AND supplier_id=? AND status='draft'`).get(activeWorkspaceId, thirdPartyId);
  assert.ok(draft);
  assert.equal(draft.author_id, recommendationAuthorId);
  workflowDb.close();

  page = await authorClient.get(detailPath);
  assert.match(page.text, /Save immutable revision/);
  const submitAction = `${detailPath}/recommendation-drafts/${draft.id}/submit`;
  const submitForm = formFor(page.text, submitAction);
  const submitted = await authorClient.post(submitAction, {
    expected_row_version: hiddenValue(submitForm, 'expected_row_version'),
    expected_revision_number: hiddenValue(submitForm, 'expected_revision_number'),
    idempotency_key: hiddenValue(submitForm, 'idempotency_key'),
    reviewer_id: String(managerId),
  });
  assert.equal(submitted.status, 303);

  page = await client.get(detailPath);
  assert.match(page.text, /Revision 1 is frozen for independent review/);
  assert.match(page.text, /Assessment Author/);
  const issueAction = `${detailPath}/recommendation-drafts/${draft.id}/issue`;
  const issueForm = formFor(page.text, issueAction);
  const issued = await client.post(issueAction, {
    expected_row_version: hiddenValue(issueForm, 'expected_row_version'),
    expected_revision_number: hiddenValue(issueForm, 'expected_revision_number'),
    expected_current_recommendation_id: hiddenValue(issueForm, 'expected_current_recommendation_id'),
    idempotency_key: hiddenValue(issueForm, 'idempotency_key'),
    quality_review_rationale: 'Independently challenged the evidence scope, scoring and contract conclusion.',
    quality_review_confirmed: '1',
  });
  assert.equal(issued.status, 303);

  let verify = new Database(dbPath, { readonly: true });
  const recommendation = verify.prepare(`SELECT * FROM tprm_recommendations
    WHERE workspace_id=? AND supplier_id=?`).get(activeWorkspaceId, thirdPartyId);
  assert.ok(recommendation);
  assert.equal(recommendation.issued_by, recommendationAuthorId);
  assert.notEqual(recommendation.quality_reviewed_by, recommendationAuthorId);
  assert.equal(verify.prepare(`SELECT COUNT(*) AS count FROM tprm_client_decisions
    WHERE workspace_id=? AND supplier_id=?`).get(activeWorkspaceId, thirdPartyId).count, 0,
  'consultancy issuance must not silently create a client decision');
  verify.close();

  page = await client.get(detailPath);
  assert.match(page.text, /Recommend Onboard/);
  assert.match(page.text, /Pending client decision/i);
  const releaseAction = `${detailPath}/evidence-releases`;
  const releaseForm = formFor(page.text, releaseAction);
  assert.match(releaseForm, new RegExp(`supplier_document:${relationshipDocumentId}`));
  const released = await client.post(releaseAction, {
    cycle_id: hiddenValue(releaseForm, 'cycle_id'),
    expected_cycle_row_version: hiddenValue(releaseForm, 'expected_cycle_row_version'),
    idempotency_key: hiddenValue(releaseForm, 'idempotency_key'),
    evidence_reference: `supplier_document:${relationshipDocumentId}`,
    client_label: 'Independent assurance report',
    client_description: 'Provides approved assurance metadata for the client onboarding decision.',
    expires_at: '2099-12-31',
    allow_download: '1',
    release_confirmed: '1',
  });
  assert.equal(released.status, 303);

  page = await client.get(detailPath);
  assert.match(page.text, /Provides approved assurance metadata/);
  assert.match(page.text, /access expires 2099-12-31/);
  assert.doesNotMatch(page.text, /internal-do-not-expose/);
  const disclosureRegister = await client.get(`/workspaces/${activeWorkspaceId}/tprm/assurance`);
  assert.match(disclosureRegister.text, /Independent assurance report/);
  assert.doesNotMatch(disclosureRegister.text, /internal-do-not-expose/);

  verify = new Database(dbPath, { readonly: true });
  const release = verify.prepare(`SELECT * FROM tprm_evidence_releases
    WHERE workspace_id=? AND supplier_id=?`).get(activeWorkspaceId, thirdPartyId);
  assert.equal(release.expires_at, '2099-12-31');
  verify.close();
  const withdrawAction = `${detailPath}/evidence-releases/${release.id}/withdraw`;
  const withdrawForm = formFor(page.text, withdrawAction);
  const withdrawBody = {
    expected_release_hash: hiddenValue(withdrawForm, 'expected_release_hash'),
    expected_withdrawal_id: hiddenValue(withdrawForm, 'expected_withdrawal_id'),
    idempotency_key: hiddenValue(withdrawForm, 'idempotency_key'),
    reason: 'The client-approved report is being replaced with a corrected evidence version.',
  };
  const withdrawn = await client.post(withdrawAction, { ...withdrawBody });
  assert.equal(withdrawn.status, 303);
  const replay = await client.post(withdrawAction, { ...withdrawBody });
  assert.equal(replay.status, 303, 'an identical withdrawal retry must be idempotent');
  page = await client.get(detailPath);
  assert.match(page.text, /Withdrawn/);
  assert.match(page.text, /being replaced with a corrected evidence version/);
  verify = new Database(dbPath, { readonly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM tprm_evidence_release_withdrawals WHERE release_id=?').get(release.id).count, 1);
  assert.deepEqual(domain.listReleasedEvidence(verify, activeWorkspaceId, thirdPartyId), []);
  verify.close();
});

test('legacy document deletion preserves bytes and rows once evidence enters governed release history', async () => {
  assert.equal(fs.existsSync(relationshipDocumentPath), true);
  const response = await client.post(
    `/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}/documents/${relationshipDocumentId}/delete`,
    {}
  );
  assert.equal(response.status, 409);
  assert.match(response.text, /immutable client evidence-release history|cannot be deleted/i);
  const verify = new Database(dbPath, { readonly:true });
  assert.ok(verify.prepare(`SELECT id FROM supplier_documents
    WHERE workspace_id=? AND supplier_id=? AND id=?`).get(activeWorkspaceId, thirdPartyId, relationshipDocumentId));
  assert.ok(verify.prepare(`SELECT id FROM tprm_evidence_releases
    WHERE workspace_id=? AND supplier_id=? AND supplier_document_id=?`).get(activeWorkspaceId, thirdPartyId, relationshipDocumentId));
  verify.close();
  assert.equal(fs.existsSync(relationshipDocumentPath), true, 'a rejected database deletion must never destroy the evidence bytes');
});

test('needs-classification modules remain visible but reject mutation entry', async () => {
  const overview = await client.get(`/workspaces/${classifiedWorkspaceId}/tprm`);
  assert.equal(overview.status, 200);
  assert.match(overview.text, /Legacy records need classification/);
  assert.match(overview.text, /read-only until a firm manager/i);
  const create = await client.get(`/workspaces/${classifiedWorkspaceId}/tprm/third-parties/new`);
  assert.equal(create.status, 409);
  assert.match(create.text, /Classify and activate/i);
});

test('firm portfolio preserves tenant and client authorization boundaries', async () => {
  const response = await client.get('/tprm');
  assert.equal(response.status, 200);
  assert.match(response.text, /TPRM Active Client/);
  assert.match(response.text, /TPRM Classification Client/);
  assert.match(response.text, /Acme Cloud/);
  assert.doesNotMatch(response.text, /Unauthorized Client|Hidden Provider|Must never be exposed/);
  assert.match(response.text, /Same-named providers remain separate client records/);
});

test('source enforces granular view permission and manager-only settings', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tprm.js'), 'utf8');
  assert.match(source, /requirePermission\('tprm\.third_party\.view'\)/);
  assert.match(source, /requirePermission\('tprm\.third_party\.manage'\)/);
  assert.match(source, /requirePermission\('tprm\.recommendation\.issue'\)/);
  assert.match(source, /recommendation-drafts\/:draftId/);
  assert.doesNotMatch(source, /third-parties\/:id\/recommendations'/);
  assert.match(source, /requirePermission\('tprm\.assurance\.view'\)/);
  assert.match(source, /requirePermission\('tprm\.assurance\.export'\)/);
  assert.match(source, /rbac\.isManager\(req\.user\.firm_role\)/);
  assert.match(source, /status === 'needs_classification'/);
  assert.doesNotMatch(source.match(/function evidenceReleaseHistory[\s\S]*?function releasableEvidence/)[0], /SELECT[^;]*stored_path/i);
});

test('legacy supplier profile, archive and finding actions cannot bypass governed TPRM workflows', async () => {
  let db = new Database(dbPath);
  const before = db.prepare(`SELECT lifecycle_stage,next_review_date,approved_by,last_assessed,
      service_provided,relationship_owner,contact FROM suppliers WHERE id=? AND workspace_id=?`)
    .get(thirdPartyId, activeWorkspaceId);
  db.close();

  const smuggled = await client.post(`/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}`, {
    contact:'safe-change@example.test', lifecycle_stage:'active', status:'approved',
    next_review_date:'2099-01-01', approved_by:'Consultancy override', last_assessed:'2099-01-01',
    service_provided:'Different unassessed service', relationship_owner:'Bypass owner',
  });
  assert.equal(smuggled.status, 409);
  db = new Database(dbPath, { readonly:true });
  assert.deepEqual(
    db.prepare(`SELECT lifecycle_stage,next_review_date,approved_by,last_assessed,
        service_provided,relationship_owner,contact FROM suppliers WHERE id=? AND workspace_id=?`)
      .get(thirdPartyId, activeWorkspaceId),
    before
  );
  db.close();

  const metadata = await client.post(`/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}`, {
    contact:'approved-metadata@example.test', website:'https://acme.example', industry:'Technology',
  });
  assert.equal(metadata.status, 303);
  db = new Database(dbPath);
  assert.equal(db.prepare('SELECT contact FROM suppliers WHERE id=?').get(thirdPartyId).contact, 'approved-metadata@example.test');
  const findingId = Number(db.prepare(`INSERT INTO findings
    (workspace_id,source_type,source_id,title,severity,status,created_by)
    VALUES (?,'manual',?,'Critical provider control gap','critical','open',?)`)
    .run(activeWorkspaceId, `supplier:${thirdPartyId}`, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO supplier_finding_links(finding_id,supplier_id,domain)
    VALUES (?,?,'Security')`).run(findingId, thirdPartyId);
  const governed = db.prepare(`SELECT c.id AS cycle_id,r.id AS recommendation_id
    FROM tprm_assessment_cycles c JOIN tprm_recommendations r
      ON r.workspace_id=c.workspace_id AND r.supplier_id=c.supplier_id AND r.cycle_id=c.id
    WHERE c.workspace_id=? AND c.supplier_id=? ORDER BY r.id DESC LIMIT 1`)
    .get(activeWorkspaceId, thirdPartyId);
  db.prepare(`INSERT INTO tprm_conditions
    (workspace_id,supplier_id,cycle_id,source_type,recommendation_id,condition_type,title,
     description,severity,owner_type,owner_name,due_date,verification_criteria,status,
     owner_user_id,waiver_rationale,waiver_expires_at,created_by)
    VALUES (?,?,?,'recommendation',?,'monitoring','Expired continuity waiver',
      'The time-limited continuity exception requires renewed governance.','moderate','consultancy',
      'Consultancy lead','2026-01-15','Document a current client-approved treatment.','waived',
      ?,'Temporary exception expired and must no longer suppress the obligation.','2026-01-31',?)`)
    .run(activeWorkspaceId, thirdPartyId, governed.cycle_id, governed.recommendation_id, managerId, managerId);
  db.close();

  const terminal = await client.post(`/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}/findings/${findingId}/status`, { status:'verified' });
  assert.equal(terminal.status, 409);
  assert.match(terminal.text, /governed evidence|independent reviewer/i);
  const progress = await client.post(`/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}/findings/${findingId}/status`, { status:'in_remediation' });
  assert.equal(progress.status, 303);
  const archive = await client.post(`/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}/archive`, { reason:'Attempt archive while governed work remains.' });
  assert.equal(archive.status, 409);
  assert.match(archive.text, /service relationship|assessment cycle/i);
  assert.match(archive.text, /open or expired-waiver condition/i);
  const legacyDelete = await client.post(`/workspaces/${activeWorkspaceId}/vendors/${thirdPartyId}/delete`, {});
  assert.equal(legacyDelete.status, 409);
  db = new Database(dbPath, { readonly:true });
  assert.equal(db.prepare('SELECT status FROM findings WHERE id=?').get(findingId).status, 'in_remediation');
  assert.equal(db.prepare('SELECT archived_at FROM suppliers WHERE id=?').get(thirdPartyId).archived_at, null);
  db.close();
});

test('closed service periods retain relationship and assessment GETs but reject every workflow POST', async () => {
  const db = new Database(dbPath);
  const firmId = db.prepare('SELECT firm_id FROM workspaces WHERE id=?').get(activeWorkspaceId).firm_id;
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Retained TPRM History','[]')`).run(firmId).lastInsertRowid);
  const moduleId = Number(db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Create retained-history fixture',?)`).run(workspaceId, managerId).lastInsertRowid);
  const supplierId = Number(db.prepare(`INSERT INTO suppliers(workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,'Retained Provider','Retained hosting service','prospect')`).run(workspaceId).lastInsertRowid);
  const relationship = require('../lib/tprm-relationships').createRelationship(db, {
    workspaceId, supplierId, actorId:managerId, relationshipName:'Retained hosting service',
    serviceDescription:'Historic service relationship retained after module closure.', status:'intake',
    reason:'Create a retained service relationship for closure-boundary testing.',
  }).relationship;
  db.prepare(`UPDATE tprm_modules SET status='closed',effective_to=datetime('now'),closed_by=?,close_reason=?
    WHERE id=?`).run(managerId, 'Conclude the service period after retaining its full history.', moduleId);
  const methodologyCount = db.prepare('SELECT COUNT(*) AS count FROM supplier_risk_methodologies WHERE workspace_id=?').get(workspaceId).count;
  db.close();

  for (const path of [
    `/workspaces/${workspaceId}/tprm/relationships`,
    `/workspaces/${workspaceId}/tprm/relationships/${relationship.id}`,
    `/workspaces/${workspaceId}/tprm/concentration`,
    `/workspaces/${workspaceId}/vendors/${supplierId}/inherent-risk`,
    `/workspaces/${workspaceId}/supplier-methodology`,
  ]) {
    const response = await client.get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.text, /Retained history.+read only/is);
  }
  const relationshipPost = await client.post(`/workspaces/${workspaceId}/tprm/relationships`, { supplier_id:String(supplierId) });
  assert.equal(relationshipPost.status, 409);
  const assessmentPost = await client.post(`/workspaces/${workspaceId}/vendors/${supplierId}/inherent-risk/start`, { assessment_type:'onboarding' });
  assert.equal(assessmentPost.status, 409);
  const methodologyPost = await client.post(`/workspaces/${workspaceId}/supplier-methodology/draft`, {});
  assert.equal(methodologyPost.status, 409);
  const verify = new Database(dbPath, { readonly:true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM supplier_risk_methodologies WHERE workspace_id=?').get(workspaceId).count, methodologyCount,
    'retained GETs must not create a methodology version');
  verify.close();
});
