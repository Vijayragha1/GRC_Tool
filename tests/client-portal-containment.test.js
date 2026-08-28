'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'Portal-containment-password-1234';

let env;
let db;
let manager;
let consultant;
let contributor;
let otherContributor;
let clientOwner;
let ismsManager;
let workspaceId;
let managerId;
let consultantId;
let contributorId;
let otherContributorId;
let clientOwnerId;
let ismsManagerId;
let unsharedDocumentId;
let scopedDocumentId;
let teamDocumentId;
let approvalDocumentId;
let unassignedRequestId;
let teamRequestId;
let requestEvidenceId;
let unassignedDeliverableId;
let otherApproverDeliverableId;
let ownDeliverableId;
let deliveryEvidenceId;

async function login(http, email) {
  const page = await http.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF missing for ${email}`);
  const signedIn = await http.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302, signedIn.text.slice(0, 300));
  const portal = await http.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(portal.status, 200, portal.text.slice(0, 300));
}

function insertClient(email, name, role, passwordHash) {
  const userId = Number(db.prepare(`INSERT INTO users(email,password_hash,name,user_type,active)
    VALUES (?,?,?,'client',1)`).run(email, passwordHash, name).lastInsertRowid);
  db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)')
    .run(workspaceId, userId, role);
  return userId;
}

function insertDocument(name, content = name) {
  return Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,version,created_by)
    VALUES (?,?,'Policy',?,'draft',1,?)`).run(workspaceId, name, content, managerId).lastInsertRowid);
}

function markerContext(text, marker) {
  const index = text.indexOf(marker);
  return index < 0 ? 'marker absent' : text.slice(Math.max(0, index - 240), index + marker.length + 240);
}

test.before(async () => {
  env = await bootClient();
  manager = env.client;
  db = new Database(env.dbPath);
  const managerRow = db.prepare("SELECT id,firm_id FROM users WHERE email='sec-test@example.com'").get();
  managerId = managerRow.id;
  workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome)
    VALUES (?,'Portal containment client','gap_assessment','["iso27001"]','certification_support')`)
    .run(managerRow.firm_id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'manager')")
    .run(workspaceId, managerId);

  const passwordHash = bcrypt.hashSync(PASSWORD, 4);
  consultantId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES (?,?,?,?,'firm','consultant',1)`).run(
      'containment-consultant@test.local', passwordHash, 'Scoped Consultant', managerRow.firm_id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')")
    .run(workspaceId, consultantId);
  contributorId = insertClient('containment-contributor@test.local', 'Scoped Contributor', 'contributor', passwordHash);
  otherContributorId = insertClient('containment-other@test.local', 'Other Contributor', 'contributor', passwordHash);
  clientOwnerId = insertClient('containment-owner@test.local', 'Client Owner', 'client_owner', passwordHash);
  ismsManagerId = insertClient('containment-isms@test.local', 'ISMS Manager', 'isms_manager', passwordHash);

  unsharedDocumentId = insertDocument('UNSHARED-INTERNAL-DRAFT', '<p>UNSHARED-DRAFT-CONTENT</p>');
  scopedDocumentId = insertDocument('EXPLICIT-CONTRIBUTOR-POLICY');
  teamDocumentId = insertDocument('TEAM-REQUEST-POLICY');
  approvalDocumentId = insertDocument('ISMS-APPROVAL-POLICY');
  db.prepare(`INSERT INTO member_scopes(workspace_id,user_id,scope_type,scope_id,granted_by)
    VALUES (?,?,'document',?,?)`).run(workspaceId, contributorId, String(scopedDocumentId), managerId);

  teamRequestId = Number(db.prepare(`INSERT INTO client_requests
    (workspace_id,request_type,title,document_id,assignee_id,created_by)
    VALUES (?,'policy','TEAM-VISIBLE-POLICY-REQUEST',?,?,?)`)
    .run(workspaceId, teamDocumentId, otherContributorId, managerId).lastInsertRowid);
  unassignedRequestId = Number(db.prepare(`INSERT INTO client_requests
    (workspace_id,request_type,title,description,assignee_id,created_by)
    VALUES (?,'evidence','UNASSIGNED-FIRM-DRAFT-REQUEST','UNRELEASED-REQUEST-DETAIL',NULL,?)`)
    .run(workspaceId, managerId).lastInsertRowid);
  requestEvidenceId = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?,'UNRELEASED-REQUEST-EVIDENCE.txt','missing-request-file','request-containment-sha',10,?,'Unreleased')`)
    .run(workspaceId, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO client_request_evidence(request_id,evidence_id,linked_by)
    VALUES (?,?,?)`).run(unassignedRequestId, requestEvidenceId, managerId);

  const versionId = Number(db.prepare(`INSERT INTO doc_versions
    (workspace_id,document_id,version,name,content,content_hash,status,created_by)
    VALUES (?,?,1,'ISMS-APPROVAL-POLICY','<p>Approval body</p>','approval-hash','review',?)`)
    .run(workspaceId, approvalDocumentId, managerId).lastInsertRowid);
  db.prepare('UPDATE generated_docs SET current_version_id=? WHERE id=? AND workspace_id=?')
    .run(versionId, approvalDocumentId, workspaceId);
  db.prepare(`INSERT INTO doc_approvers
    (workspace_id,document_id,version_id,sequence,user_id,role_label)
    VALUES (?,?,?,?,?,'Client security reviewer')`)
    .run(workspaceId, approvalDocumentId, versionId, 1, ismsManagerId);

  const planPage = await manager.get(`/workspaces/${workspaceId}/engagement-plan`);
  assert.equal(planPage.status, 200, planPage.text.slice(0, 300));
  const parent = db.prepare(`SELECT d.plan_id,d.milestone_id FROM engagement_delivery_deliverables d
    INNER JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    INNER JOIN engagement_delivery_phases p ON p.id=m.phase_id
    WHERE d.workspace_id=? ORDER BY p.sort_order,m.id,d.id LIMIT 1`).get(workspaceId);
  assert.ok(parent, 'delivery fixture should have an in-scope milestone');
  const insertDeliverable = db.prepare(`INSERT INTO engagement_delivery_deliverables
    (workspace_id,plan_id,milestone_id,title,client_title,status,client_visible,owner_id,approver_id)
    VALUES (?,?,?,?,?,'draft',1,?,?)`);
  unassignedDeliverableId = Number(insertDeliverable.run(
    workspaceId, parent.plan_id, parent.milestone_id, 'UNASSIGNED-INTERNAL-DELIVERABLE',
    'UNASSIGNED-INTERNAL-DELIVERABLE', null, null).lastInsertRowid);
  otherApproverDeliverableId = Number(insertDeliverable.run(
    workspaceId, parent.plan_id, parent.milestone_id, 'OTHER-APPROVER-DELIVERABLE',
    'OTHER-APPROVER-DELIVERABLE', null, otherContributorId).lastInsertRowid);
  ownDeliverableId = Number(insertDeliverable.run(
    workspaceId, parent.plan_id, parent.milestone_id, 'OWN-CONTRIBUTOR-DELIVERABLE',
    'OWN-CONTRIBUTOR-DELIVERABLE', contributorId, managerId).lastInsertRowid);
  deliveryEvidenceId = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?,'UNRELEASED-DELIVERY-EVIDENCE.txt','missing-delivery-file','delivery-containment-sha',10,?,'Unreleased')`)
    .run(workspaceId, managerId).lastInsertRowid);
  const linkEvidence = db.prepare(`INSERT INTO engagement_delivery_evidence
    (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`);
  linkEvidence.run(workspaceId, unassignedDeliverableId, deliveryEvidenceId, managerId);
  linkEvidence.run(workspaceId, otherApproverDeliverableId, deliveryEvidenceId, managerId);
  linkEvidence.run(workspaceId, ownDeliverableId, deliveryEvidenceId, managerId);

  consultant = makeClient(env.app);
  contributor = makeClient(env.app);
  otherContributor = makeClient(env.app);
  clientOwner = makeClient(env.app);
  ismsManager = makeClient(env.app);
  await login(consultant, 'containment-consultant@test.local');
  await login(contributor, 'containment-contributor@test.local');
  await login(otherContributor, 'containment-other@test.local');
  await login(clientOwner, 'containment-owner@test.local');
  await login(ismsManager, 'containment-isms@test.local');
});

test.after(async () => {
  if (db) db.close();
  await Promise.all([consultant, contributor, otherContributor, clientOwner, ismsManager, manager]
    .filter(Boolean).map(http => http.close()));
});

test('policy preview requires an explicit client share and honors firm document.view revocation', async () => {
  for (const http of [contributor, clientOwner, ismsManager]) {
    const hidden = await http.get(`/workspaces/${workspaceId}/client-portal/policies/${unsharedDocumentId}`);
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(hidden.text, /UNSHARED-DRAFT-CONTENT/);
  }
  const hiddenComment = await clientOwner.post(
    `/workspaces/${workspaceId}/client-portal/policies/${unsharedDocumentId}/comments`,
    { body: 'This must not attach to an internal draft.' });
  assert.equal(hiddenComment.status, 404);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM comments
    WHERE workspace_id=? AND parent_type='document' AND parent_id=?`).get(
    workspaceId, String(unsharedDocumentId)).c, 0);

  assert.equal((await contributor.get(`/workspaces/${workspaceId}/client-portal/policies/${scopedDocumentId}`)).status, 200);
  assert.equal((await contributor.get(`/workspaces/${workspaceId}/client-portal/policies/${teamDocumentId}`)).status, 404);
  assert.equal((await otherContributor.get(`/workspaces/${workspaceId}/client-portal/policies/${teamDocumentId}`)).status, 200);
  assert.equal((await clientOwner.get(`/workspaces/${workspaceId}/client-portal/policies/${teamDocumentId}`)).status, 200);
  assert.equal((await ismsManager.get(`/workspaces/${workspaceId}/client-portal/policies/${teamDocumentId}`)).status, 200);
  assert.equal((await ismsManager.get(`/workspaces/${workspaceId}/client-portal/policies/${approvalDocumentId}`)).status, 200);
  assert.equal((await clientOwner.get(`/workspaces/${workspaceId}/client-portal/policies/${approvalDocumentId}`)).status, 404);

  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,'document.view',0,?,'Portal containment regression')`)
    .run(workspaceId, consultantId, managerId);
  assert.equal((await consultant.get(`/workspaces/${workspaceId}/client-portal/policies/${unsharedDocumentId}`)).status, 403);
  db.prepare(`DELETE FROM workspace_role_overrides
    WHERE workspace_id=? AND user_id=? AND permission='document.view'`).run(workspaceId, consultantId);
});

test('request detail and linked evidence follow the same released-team visibility as the list', async () => {
  for (const http of [clientOwner, ismsManager, contributor]) {
    const page = await http.get(`/workspaces/${workspaceId}/client-portal?view=actions&status=open`);
    assert.equal(page.text.includes('UNASSIGNED-FIRM-DRAFT-REQUEST'), false,
      markerContext(page.text, 'UNASSIGNED-FIRM-DRAFT-REQUEST'));
    assert.equal((await http.get(`/workspaces/${workspaceId}/client-portal/requests/${unassignedRequestId}`)).status, 404);
    assert.equal((await http.get(`/workspaces/${workspaceId}/client-portal/requests/${unassignedRequestId}/evidence/${requestEvidenceId}/download`)).status, 404);
  }

  db.prepare(`UPDATE client_requests SET assignee_id=? WHERE id=? AND workspace_id=?`)
    .run(otherContributorId, unassignedRequestId, workspaceId);
  for (const http of [clientOwner, ismsManager, otherContributor]) {
    const detail = await http.get(`/workspaces/${workspaceId}/client-portal/requests/${unassignedRequestId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.text, /UNASSIGNED-FIRM-DRAFT-REQUEST/);
  }
  assert.equal((await contributor.get(`/workspaces/${workspaceId}/client-portal/requests/${unassignedRequestId}`)).status, 404);

  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,'evidence.download',0,?,'Portal containment regression')`)
    .run(workspaceId, consultantId, managerId);
  assert.equal((await consultant.get(`/workspaces/${workspaceId}/client-portal/requests/${unassignedRequestId}/evidence/${requestEvidenceId}/download`)).status, 403);
  db.prepare(`DELETE FROM workspace_role_overrides
    WHERE workspace_id=? AND user_id=? AND permission='evidence.download'`).run(workspaceId, consultantId);
});

test('deliverable direct routes match owner, approver, and team list visibility', async () => {
  for (const http of [clientOwner, ismsManager]) {
    const page = await http.get(`/workspaces/${workspaceId}/client-portal?view=actions`);
    assert.doesNotMatch(page.text, /UNASSIGNED-INTERNAL-DELIVERABLE/);
    assert.ok(page.text.includes('OTHER-APPROVER-DELIVERABLE'),
      markerContext(page.text, 'OTHER-APPROVER-DELIVERABLE'));
    assert.match(page.text, /OWN-CONTRIBUTOR-DELIVERABLE/);
    assert.equal((await http.post(`/workspaces/${workspaceId}/client-portal/deliverables/${unassignedDeliverableId}/comments`, {
      body: 'Do not attach this comment.'
    })).status, 400);
    assert.equal((await http.get(`/workspaces/${workspaceId}/client-portal/deliverables/${unassignedDeliverableId}/evidence/${deliveryEvidenceId}/download`)).status, 404);
  }

  const contributorPage = await contributor.get(`/workspaces/${workspaceId}/client-portal?view=actions`);
  assert.doesNotMatch(contributorPage.text, /UNASSIGNED-INTERNAL-DELIVERABLE|OTHER-APPROVER-DELIVERABLE/);
  assert.match(contributorPage.text, /OWN-CONTRIBUTOR-DELIVERABLE/);
  assert.equal((await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${otherApproverDeliverableId}/comments`, {
    body: 'Different approver work must stay hidden.'
  })).status, 400);
  assert.equal((await contributor.get(`/workspaces/${workspaceId}/client-portal/deliverables/${otherApproverDeliverableId}/evidence/${deliveryEvidenceId}/download`)).status, 404);

  const otherPage = await otherContributor.get(`/workspaces/${workspaceId}/client-portal?view=actions`);
  assert.match(otherPage.text, /OTHER-APPROVER-DELIVERABLE/);
  assert.doesNotMatch(otherPage.text, /UNASSIGNED-INTERNAL-DELIVERABLE|OWN-CONTRIBUTOR-DELIVERABLE/);
  assert.equal((await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${ownDeliverableId}/comments`, {
    body: 'Legitimate owner comment.'
  })).status, 302);
  assert.equal((await ismsManager.post(`/workspaces/${workspaceId}/client-portal/deliverables/${otherApproverDeliverableId}/comments`, {
    body: 'Legitimate team reviewer comment.'
  })).status, 302);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM comments WHERE workspace_id=?
    AND parent_type='engagement_deliverable' AND parent_id IN (?,?)`).get(
    workspaceId, String(ownDeliverableId), String(otherApproverDeliverableId)).c, 2);

  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,'evidence.download',0,?,'Portal containment regression')`)
    .run(workspaceId, consultantId, managerId);
  assert.equal((await consultant.get(`/workspaces/${workspaceId}/client-portal/deliverables/${ownDeliverableId}/evidence/${deliveryEvidenceId}/download`)).status, 403);
  db.prepare(`DELETE FROM workspace_role_overrides
    WHERE workspace_id=? AND user_id=? AND permission='evidence.download'`).run(workspaceId, consultantId);
});
