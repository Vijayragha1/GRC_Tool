'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

let client;
let restrictedClient;
let app;
let dbPath;
let workspaceId;
let programmeWorkspaceId;
let isolationWorkspaceId;
let supplierId;
let otherSupplierId;
let ddqId;
let contractId;
let questionId;
let clauseId;
let managerId;
let foreignFindingId;

async function loginAs(http, email, password) {
  const page = await http.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF token missing for ${email}`);
  const response = await http.post('/login', { email, password, _csrf:csrf }, { csrf:false });
  assert.equal(response.status, 302);
  await http.get('/dashboard');
}

function findingContextPath(source, assessmentId, itemKey) {
  return `/workspaces/${workspaceId}/vendors/${supplierId}/assessment-findings/new?source=${source}&assessment_id=${assessmentId}&item_key=${encodeURIComponent(itemKey)}`;
}

test.before(async () => {
  const booted = await bootClient();
  ({ client, app, dbPath } = booted);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const manager = db.prepare(`SELECT id,password_hash FROM users
    WHERE email='sec-test@example.com' AND user_type='firm' AND firm_id=? AND firm_role='manager'`).get(firm.id);
  managerId = manager.id;

  workspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Assessment Finding Client','[]')`).run(firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Exercise governed assessment finding flow',?)`).run(workspaceId, managerId);
  supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,security_reviewer,relationship_owner,business_owner)
    VALUES (?,?,'Cloud hosting','assessment','Security Lead','Consultancy Lead','Technology Owner')`)
    .run(workspaceId, 'Finding Flow Provider').lastInsertRowid);
  otherSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage) VALUES (?,?,'Payroll','assessment')`)
    .run(workspaceId, 'Unrelated Provider').lastInsertRowid);

  const methodologies = require('../lib/supplier-methodologies');
  const methodology = methodologies.active(db, workspaceId, managerId);
  const snapshot = methodologies.snapshot(methodology);
  const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,methodology_id,methodology_snapshot_json,methodology_hash,
     assessment_type,status,physical_data_centre_applicability,weighted_score,assigned_tier,
     mandatory_floors_json,module_applicability_json,unknown_count,approved_at,approved_by,approval_rationale,created_by)
    VALUES (?,?,?,?,?,?,'onboarding','approved','no',10,'tier_4','[]','[]',0,datetime('now'),?,'Approved for finding-flow regression.',?)`)
    .run(workspaceId, supplierId, snapshot.methodologyVersion, snapshot.methodologyId,
      snapshot.methodologyJson, snapshot.methodologyHash, managerId, managerId).lastInsertRowid);

  const question = methodology.definition.ddqQuestions.find(item => item.enabled !== false && item.tiers.includes('tier_4'));
  questionId = question.id;
  ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,methodology_id,methodology_snapshot_json,
     methodology_hash,tier,assessment_type,status,modules_json,vendor_contact_email,due_date,created_by)
    VALUES (?,?,?,?,?,?,?,'tier_4','onboarding','under_review','[]','provider@example.test','2099-12-31',?)`)
    .run(workspaceId, supplierId, inherentId, snapshot.methodologyVersion, snapshot.methodologyId,
      snapshot.methodologyJson, snapshot.methodologyHash, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO supplier_ddq_responses
    (assessment_id,question_id,response,detail,evidence_reference,status,reviewer_conclusion,reviewer_comments,reviewer_id)
    VALUES (?,?,'No','The expected control is not implemented.','Provider response and evidence review','Review / Finding','Unsatisfactory','Raise a governed finding.',?)`)
    .run(ddqId, questionId, managerId);

  const clause = methodology.definition.contractClauses.find(item => item.requiredWhen !== 'Conditional');
  clauseId = clause.id;
  contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,methodology_id,methodology_snapshot_json,
     methodology_hash,status,agreement_reference,agreement_date,reviewer_id)
    VALUES (?,?,?,?,?,?,?,'in_progress','MSA-FINDING-1','2026-08-01',?)`)
    .run(workspaceId, supplierId, inherentId, snapshot.methodologyVersion, snapshot.methodologyId,
      snapshot.methodologyJson, snapshot.methodologyHash, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO supplier_contract_review_items
    (review_id,clause_id,required,status,contract_reference,reviewer_comments)
    VALUES (?,?,1,'Missing','MSA-FINDING-1','Required language is absent.')`).run(contractId, clauseId);

  foreignFindingId = Number(db.prepare(`INSERT INTO findings
    (workspace_id,source_type,source_id,title,description,severity,status,created_by)
    VALUES (?,'manual','unrelated-provider','Unrelated provider finding','Must never be linkable across third parties.','high','open',?)`)
    .run(workspaceId, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO supplier_finding_links(finding_id,supplier_id,domain,due_date,owner_name)
    VALUES (?,?,'Security','2099-12-31','Other Owner')`).run(foreignFindingId, otherSupplierId);

  programmeWorkspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Programme Setup Finding Client','[]')`).run(firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'programme_setup','active','Programme setup capability boundary',?)`).run(programmeWorkspaceId, managerId);
  db.prepare(`INSERT INTO suppliers(workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,?,'Inventory only','prospect')`).run(programmeWorkspaceId, 'Inventory-only Provider');

  isolationWorkspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Isolated Managed Finding Client','[]')`).run(firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Cross-client isolation boundary',?)`).run(isolationWorkspaceId, managerId);
  db.prepare(`INSERT INTO suppliers(workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,?,'Unrelated managed service','assessment')`).run(isolationWorkspaceId, 'Isolated Provider');

  const restrictedUserId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('assessment-reviewer-no-findings@example.test',?,'Restricted Reviewer','firm',?,'consultant',1)`)
    .run(manager.password_hash, firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')`)
    .run(workspaceId, restrictedUserId);
  db.prepare(`INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted,granted_by)
    VALUES (?,?,'tprm.finding.manage',0,?)`).run(workspaceId, restrictedUserId, managerId);
  db.close();

  restrictedClient = makeClient(app);
  await loginAs(restrictedClient, 'assessment-reviewer-no-findings@example.test', booted.login.password);
});

test.after(async () => {
  if (restrictedClient) await restrictedClient.close();
  if (client) await client.close();
});

test('DDQ and contract rows expose an exact create-or-link path instead of the dead legacy register', async () => {
  const ddq = await client.get(`/workspaces/${workspaceId}/vendors/${supplierId}/due-diligence`);
  assert.equal(ddq.status, 200);
  assert.match(ddq.text, new RegExp(`id="question-${questionId}"`));
  assert.match(ddq.text, new RegExp(`assessment-findings/new\\?source=ddq&amp;assessment_id=${ddqId}&amp;item_key=${questionId}`));
  assert.match(ddq.text, /Create or link/);
  assert.doesNotMatch(ddq.text, /view=legacy&amp;tab=findings|>Open register</);

  const contract = await client.get(`/workspaces/${workspaceId}/vendors/${supplierId}/contract-review`);
  assert.equal(contract.status, 200);
  assert.match(contract.text, new RegExp(`id="clause-${clauseId}"`));
  assert.match(contract.text, new RegExp(`assessment-findings/new\\?source=contract&amp;assessment_id=${contractId}&amp;item_key=${clauseId}`));
  assert.match(contract.text, /Create or link/);
  assert.doesNotMatch(contract.text, /view=legacy&amp;tab=findings|>Open register</);
});

test('context page names the exact row, offers both explicit actions and returns to that row', async () => {
  const response = await client.get(findingContextPath('ddq', ddqId, questionId));
  assert.equal(response.status, 200);
  assert.match(response.text, new RegExp(`data-assessment-finding-context="ddq:${ddqId}:${questionId}"`));
  assert.match(response.text, new RegExp(`Due-diligence question ${questionId}`));
  assert.match(response.text, /Link an existing finding/);
  assert.match(response.text, /Create a new finding/);
  assert.match(response.text, /Create, link and return/);
  assert.match(response.text, /Security Lead/);
  assert.match(response.text, new RegExp(`#question-${questionId}`));
  assert.doesNotMatch(response.text, /Unrelated provider finding/);
});

test('invalid creation stays in context and cannot create a partial finding', async () => {
  let db = new Database(dbPath, { readonly:true });
  const before = db.prepare('SELECT COUNT(*) AS count FROM findings WHERE workspace_id=?').get(workspaceId).count;
  db.close();
  const response = await client.post(`/workspaces/${workspaceId}/vendors/${supplierId}/assessment-findings/create`, {
    source:'ddq', assessment_id:String(ddqId), item_key:questionId,
    title:'Missing control', description:'short', severity:'high', owner_name:'Security Lead', due_date:'2099-12-31',
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /Nothing was changed/);
  assert.match(response.text, /Describe the verified gap/);
  db = new Database(dbPath, { readonly:true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM findings WHERE workspace_id=?').get(workspaceId).count, before);
  db.close();
});

test('creating from a DDQ row atomically creates, governs and links the finding', async () => {
  const response = await client.post(`/workspaces/${workspaceId}/vendors/${supplierId}/assessment-findings/create`, {
    source:'ddq', assessment_id:String(ddqId), item_key:questionId,
    title:'Provider control not implemented',
    description:'The provider response and reviewed evidence confirm the required control is not implemented.',
    severity:'high', owner_name:'Security Lead', due_date:'2099-12-31',
  });
  assert.equal(response.status, 303);
  assert.match(response.location, new RegExp(`/due-diligence\\?toast=.*#question-${questionId}$`));

  const db = new Database(dbPath, { readonly:true });
  const finding = db.prepare(`SELECT f.*,l.supplier_id,l.domain,l.due_date,l.owner_name
    FROM findings f INNER JOIN supplier_finding_links l ON l.finding_id=f.id
    WHERE f.workspace_id=? AND f.title='Provider control not implemented'`).get(workspaceId);
  assert.ok(finding);
  assert.equal(finding.source_type, 'assessment');
  assert.equal(finding.source_id, `supplier_ddq:${ddqId}:${questionId}`);
  assert.equal(finding.supplier_id, supplierId);
  assert.equal(finding.owner_name, 'Security Lead');
  assert.equal(finding.due_date, '2099-12-31');
  const responseRow = db.prepare(`SELECT finding_id,status FROM supplier_ddq_responses
    WHERE assessment_id=? AND question_id=?`).get(ddqId, questionId);
  assert.equal(responseRow.finding_id, finding.id);
  assert.equal(responseRow.status, 'Response Complete');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_log
    WHERE workspace_id=? AND action='create_supplier_assessment_finding' AND entity_id=?`)
    .get(workspaceId, String(finding.id)).count, 1);
  db.close();

  const refreshed = await client.get(`/workspaces/${workspaceId}/vendors/${supplierId}/due-diligence`);
  assert.match(refreshed.text, new RegExp(`<option value="${finding.id}" selected>`));
});

test('linking an existing governed finding updates the exact contract clause and rejects another supplier finding', async () => {
  const rejected = await client.post(`/workspaces/${workspaceId}/vendors/${supplierId}/assessment-findings/link`, {
    source:'contract', assessment_id:String(contractId), item_key:clauseId, finding_id:String(foreignFindingId),
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /Choose an open finding already governed for this third party/);

  let db = new Database(dbPath);
  assert.equal(db.prepare(`SELECT finding_id FROM supplier_contract_review_items
    WHERE review_id=? AND clause_id=?`).get(contractId, clauseId).finding_id, null);
  const findingId = db.prepare(`SELECT id FROM findings
    WHERE workspace_id=? AND title='Provider control not implemented'`).get(workspaceId).id;
  db.close();

  const linked = await client.post(`/workspaces/${workspaceId}/vendors/${supplierId}/assessment-findings/link`, {
    source:'contract', assessment_id:String(contractId), item_key:clauseId, finding_id:String(findingId),
  });
  assert.equal(linked.status, 303);
  assert.match(linked.location, new RegExp(`/contract-review\\?toast=.*#clause-${clauseId}$`));
  db = new Database(dbPath, { readonly:true });
  assert.equal(db.prepare(`SELECT finding_id FROM supplier_contract_review_items
    WHERE review_id=? AND clause_id=?`).get(contractId, clauseId).finding_id, findingId);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_log
    WHERE workspace_id=? AND action='link_supplier_assessment_finding' AND entity_id=?`)
    .get(workspaceId, String(findingId)).count, 1);
  db.close();
});

test('permission, service-model, tenant and terminal-state guards hold on direct URLs', async () => {
  const restrictedPage = await restrictedClient.get(findingContextPath('ddq', ddqId, questionId));
  assert.equal(restrictedPage.status, 403);
  assert.match(restrictedPage.text, /tprm\.finding\.manage/);

  const capabilityDenied = await client.post(`/workspaces/${programmeWorkspaceId}/vendors/${supplierId}/assessment-findings/create`, {
    source:'ddq', assessment_id:String(ddqId), item_key:questionId,
    title:'Must not be created', description:'This mutation is outside the service model.',
    severity:'high', owner_name:'Nobody', due_date:'2099-12-31',
  });
  assert.equal(capabilityDenied.status, 409);
  assert.match(capabilityDenied.text, /not included in the Programme setup service model/);

  const crossClient = await client.get(`/workspaces/${programmeWorkspaceId}/vendors/${supplierId}/assessment-findings/new?source=ddq&assessment_id=${ddqId}&item_key=${questionId}`);
  assert.equal(crossClient.status, 409, 'the service-model boundary is evaluated before any assessment lookup');

  const isolated = await client.get(`/workspaces/${isolationWorkspaceId}/vendors/${supplierId}/assessment-findings/new?source=ddq&assessment_id=${ddqId}&item_key=${questionId}`);
  assert.equal(isolated.status, 404);
  assert.match(isolated.text, /does not exist for this third party and client/);

  const db = new Database(dbPath);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM findings WHERE title='Must not be created'`).get().count, 0);
  db.prepare(`UPDATE supplier_contract_reviews SET status='complete',completed_at=datetime('now') WHERE id=?`).run(contractId);
  db.close();
  const terminal = await client.get(findingContextPath('contract', contractId, clauseId));
  assert.equal(terminal.status, 409);
  assert.match(terminal.text, /no longer open for review/);
});
