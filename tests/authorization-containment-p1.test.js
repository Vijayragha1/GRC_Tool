'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');
const rbac = require('../lib/rbac');
const { requireInternalEvidenceMutation } = require('../lib/evidence-access');
const { TABLE_QUERIES, loadHandoverRows } = require('../lib/handover-export');
const {
  listVisibleReportTemplates,
  loadVisibleReportTemplate,
} = require('../lib/report-template-access');

const PASSWORD = 'Containment-test-password-1234';

let env;
let db;
let manager;
let client;
let firmAId;
let firmBId;
let workspaceAId;
let workspaceBId;
let managerId;
let clientId;
let requestId;
let evidenceId;
let foreignTemplateId;
let ownTemplateId;
let uploadedFilePath;

async function login(http, email) {
  const page = await http.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF missing for ${email}`);
  const signedIn = await http.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302, signedIn.text.slice(0, 300));
  const portal = await http.get(`/workspaces/${workspaceAId}/client-portal`);
  assert.equal(portal.status, 200, portal.text.slice(0, 300));
}

test.before(async () => {
  process.env.UPLOAD_AV_MODE = 'off';
  env = await bootClient();
  manager = env.client;
  db = new Database(env.dbPath);

  const managerRow = db.prepare("SELECT id,firm_id FROM users WHERE email='sec-test@example.com'").get();
  managerId = managerRow.id;
  firmAId = managerRow.firm_id;
  firmBId = Number(db.prepare("INSERT INTO firms(name) VALUES ('Containment Firm B')").run().lastInsertRowid);
  workspaceAId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Containment Workspace A','["iso27001"]')`).run(firmAId).lastInsertRowid);
  workspaceBId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Containment Workspace B','["iso27001"]')`).run(firmBId).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'manager')")
    .run(workspaceAId, managerId);

  const passwordHash = bcrypt.hashSync(PASSWORD, 4);
  clientId = Number(db.prepare(`INSERT INTO users(email,password_hash,name,user_type,active)
    VALUES ('containment-client@test.local',?,'Containment Client','client',1)`).run(passwordHash).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'contributor')")
    .run(workspaceAId, clientId);
  requestId = Number(db.prepare(`INSERT INTO client_requests
    (workspace_id,request_type,title,description,assignee_id,created_by)
    VALUES (?,'evidence','Scoped portal evidence','Upload the assigned record',?,?)`)
    .run(workspaceAId, clientId, managerId).lastInsertRowid);
  evidenceId = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?,'internal-record.txt','not-a-real-file','internal-sha',10,?,'Firm workpaper')`)
    .run(workspaceAId, managerId).lastInsertRowid);

  ownTemplateId = Number(db.prepare(`INSERT INTO report_templates
    (workspace_id,firm_id,name,description,body,is_system)
    VALUES (?,NULL,'VISIBLE-A-TEMPLATE','Own workspace','Own body',0)`)
    .run(workspaceAId).lastInsertRowid);
  foreignTemplateId = Number(db.prepare(`INSERT INTO report_templates
    (workspace_id,firm_id,name,description,body,is_system)
    VALUES (NULL,?,'SECRET-B-TEMPLATE','Foreign firm','Foreign body',0)`)
    .run(firmBId).lastInsertRowid);

  client = makeClient(env.app);
  await login(client, 'containment-client@test.local');
});

test.after(async () => {
  if (uploadedFilePath) {
    try { fs.unlinkSync(uploadedFilePath); } catch (_) {}
  }
  if (db) db.close();
  if (client) await client.close();
  if (manager) await manager.close();
});

test('handover parent rows are isolated by explicit two-firm joins', () => {
  const handoverDb = new Database(':memory:');
  handoverDb.exec(`
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,firm_id INTEGER,client_name TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,workspace_id INTEGER);
    CREATE TABLE comment_mentions(id INTEGER PRIMARY KEY,comment_id INTEGER,marker TEXT);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,workspace_id INTEGER);
    CREATE TABLE audit_findings(id INTEGER PRIMARY KEY,audit_id INTEGER,marker TEXT);
    CREATE TABLE audit_observations(id INTEGER PRIMARY KEY,audit_id INTEGER,marker TEXT);
    CREATE TABLE suppliers(id INTEGER PRIMARY KEY,workspace_id INTEGER);
    CREATE TABLE supplier_controls(id INTEGER PRIMARY KEY,supplier_id INTEGER,marker TEXT);
    CREATE TABLE supplier_questionnaires(id INTEGER PRIMARY KEY,workspace_id INTEGER);
    CREATE TABLE supplier_questionnaire_responses(id INTEGER PRIMARY KEY,questionnaire_id INTEGER,marker TEXT);
    CREATE TABLE generated_docs(id INTEGER PRIMARY KEY,workspace_id INTEGER);
    CREATE TABLE document_requirement_links(id INTEGER PRIMARY KEY,document_id INTEGER,marker TEXT);
    CREATE TABLE access_reviews(id INTEGER PRIMARY KEY,workspace_id INTEGER);
    CREATE TABLE access_review_items(id INTEGER PRIMARY KEY,review_id INTEGER,marker TEXT);
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY,workspace_id INTEGER);
    CREATE TABLE audit_chain(id INTEGER PRIMARY KEY,audit_log_id INTEGER,marker TEXT);
  `);
  handoverDb.prepare("INSERT INTO workspaces VALUES (7,1,'Firm A')").run();
  handoverDb.prepare("INSERT INTO workspaces VALUES (8,2,'Firm B')").run();

  const relationships = [
    ['comment_mentions', 'comments', 'comment_id'],
    ['audit_findings', 'audits', 'audit_id'],
    ['audit_observations', 'audits', 'audit_id'],
    ['supplier_controls', 'suppliers', 'supplier_id'],
    ['supplier_questionnaire_responses', 'supplier_questionnaires', 'questionnaire_id'],
    ['document_requirement_links', 'generated_docs', 'document_id'],
    ['access_review_items', 'access_reviews', 'review_id'],
    ['audit_chain', 'audit_log', 'audit_log_id'],
  ];
  for (const [index, [child, parent, parentColumn]] of relationships.entries()) {
    const ownParentId = 100 + index * 2;
    const foreignParentId = ownParentId + 1;
    handoverDb.prepare(`INSERT INTO ${parent}(id,workspace_id) VALUES (?,?)`).run(ownParentId, 7);
    handoverDb.prepare(`INSERT INTO ${parent}(id,workspace_id) VALUES (?,?)`).run(foreignParentId, 8);
    handoverDb.prepare(`INSERT INTO ${child}(id,${parentColumn},marker) VALUES (?,?,?)`)
      .run(700 + index, ownParentId, `${child}-own`);
    // The foreign child's global id deliberately equals workspace A's id,
    // reproducing the old `WHERE id=workspace_id` collision.
    handoverDb.prepare(`INSERT INTO ${child}(id,${parentColumn},marker) VALUES (?,?,?)`)
      .run(7, foreignParentId, `${child}-foreign`);
  }

  try {
    assert.deepEqual(loadHandoverRows(handoverDb, 'workspaces', 7), [
      { id: 7, firm_id: 1, client_name: 'Firm A' },
    ]);
    for (const [child] of relationships) {
      const rows = loadHandoverRows(handoverDb, child, 7);
      assert.deepEqual(rows.map(row => row.marker), [`${child}-own`], `${child} leaked across firms`);
      assert.match(TABLE_QUERIES[child], /\bJOIN\b/i, `${child} must retain an explicit parent join`);
    }
  } finally {
    handoverDb.close();
  }
});

test('report-template loader exposes only canonical system, current workspace, or current firm rows', () => {
  const templateDb = new Database(':memory:');
  templateDb.exec(`CREATE TABLE report_templates(
    id INTEGER PRIMARY KEY,workspace_id INTEGER,firm_id INTEGER,name TEXT,
    description TEXT,body TEXT,is_system INTEGER
  )`);
  const insert = templateDb.prepare(`INSERT INTO report_templates
    (id,workspace_id,firm_id,name,description,body,is_system) VALUES (?,?,?,?,?,'body',?)`);
  insert.run(1, null, null, 'Canonical system', '', 1);
  insert.run(2, 7, null, 'Workspace A', '', 0);
  insert.run(3, null, 1, 'Firm A', '', 0);
  insert.run(4, 8, null, 'Workspace B', '', 0);
  insert.run(5, null, 2, 'Firm B', '', 0);
  insert.run(6, null, null, 'Unowned custom', '', 0);
  insert.run(7, null, 2, 'Noncanonical system B', '', 1);

  try {
    const workspace = { id: 7, firm_id: 1 };
    assert.deepEqual(listVisibleReportTemplates(templateDb, workspace).map(row => row.name), [
      'Canonical system', 'Firm A', 'Workspace A',
    ]);
    assert.equal(loadVisibleReportTemplate(templateDb, workspace, 2).name, 'Workspace A');
    for (const hiddenId of [4, 5, 6, 7]) {
      assert.equal(loadVisibleReportTemplate(templateDb, workspace, hiddenId), undefined);
    }
  } finally {
    templateDb.close();
  }
});

test('client roles keep scoped upload capability but fail the internal evidence boundary', () => {
  for (const role of ['client_owner', 'isms_manager', 'contributor']) {
    assert.ok(rbac.rolePermissions(role).includes('evidence.upload'), `${role} must retain portal upload capability`);
    let status;
    let nextCalled = false;
    requireInternalEvidenceMutation(
      { user: { user_type: 'client', role } },
      { status(code) { status = code; return this; }, send() { return this; } },
      () => { nextCalled = true; }
    );
    assert.equal(status, 403);
    assert.equal(nextCalled, false);
  }

  let firmNext = false;
  requireInternalEvidenceMutation(
    { user: { user_type: 'firm', role: 'consultant' } },
    {},
    () => { firmNext = true; }
  );
  assert.equal(firmNext, true);
});

test('client cannot mutate internal evidence or engagement-plan evidence routes', async () => {
  const routes = [
    `/workspaces/${workspaceAId}/evidence`,
    `/workspaces/${workspaceAId}/evidence/bulk`,
    `/workspaces/${workspaceAId}/evidence/${evidenceId}/supersede`,
    `/workspaces/${workspaceAId}/evidence/${evidenceId}/links`,
    `/workspaces/${workspaceAId}/evidence/${evidenceId}/links/1/delete`,
    `/workspaces/${workspaceAId}/evidence/${evidenceId}/controls`,
    `/workspaces/${workspaceAId}/evidence/${evidenceId}/controls/1/section`,
    `/workspaces/${workspaceAId}/evidence/${evidenceId}/controls/1/delete`,
    `/workspaces/${workspaceAId}/evidence/${evidenceId}/delete`,
    `/workspaces/${workspaceAId}/engagement-plan/deliverables/999999/evidence`,
    `/workspaces/${workspaceAId}/engagement-plan/deliverables/999999/evidence/link`,
  ];
  for (const route of routes) {
    const response = await client.post(route, { evidence_id: evidenceId });
    assert.equal(response.status, 403, `${route} must be firm-only`);
  }
  const unchanged = db.prepare('SELECT superseded_at,superseded_by_id FROM evidence WHERE id=?').get(evidenceId);
  assert.deepEqual(unchanged, { superseded_at: null, superseded_by_id: null });
});

test('assigned client can still upload through the scoped portal request route', async () => {
  const form = new FormData();
  form.set('_csrf', client.getCsrfToken());
  form.set('description', 'Scoped client upload regression');
  form.append('file', new Blob(['scoped client evidence\n'], { type: 'text/plain' }), 'scoped-client-upload.txt');
  const baseUrl = await client.baseUrl();
  const response = await fetch(`${baseUrl}/workspaces/${workspaceAId}/client-portal/requests/${requestId}/evidence`, {
    method: 'POST',
    headers: {
      cookie: client.getCookies(),
      referer: `${baseUrl}/workspaces/${workspaceAId}/client-portal/requests/${requestId}`,
      'x-csrf-token': client.getCsrfToken(),
    },
    body: form,
    redirect: 'manual',
  });
  assert.equal(response.status, 302, await response.text());

  const uploaded = db.prepare(`SELECT id,workspace_id,stored_path FROM evidence
    WHERE filename='scoped-client-upload.txt' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(uploaded);
  assert.equal(uploaded.workspace_id, workspaceAId);
  assert.ok(db.prepare('SELECT 1 FROM client_request_evidence WHERE request_id=? AND evidence_id=?')
    .get(requestId, uploaded.id));
  const uploadRoot = path.resolve(__dirname, '..', 'uploads', `firm_${firmAId}`);
  uploadedFilePath = path.resolve(uploadRoot, uploaded.stored_path);
  assert.ok(uploadedFilePath.startsWith(`${uploadRoot}${path.sep}`));
});

test('report endpoints do not reveal a foreign firm template by id or list', async () => {
  const list = await manager.get(`/workspaces/${workspaceAId}/reports`);
  assert.equal(list.status, 200, list.text.slice(0, 300));
  assert.match(list.text, /VISIBLE-A-TEMPLATE/);
  assert.doesNotMatch(list.text, /SECRET-B-TEMPLATE/);
  assert.equal((await manager.get(`/workspaces/${workspaceAId}/reports/${ownTemplateId}`)).status, 200);
  assert.equal((await manager.get(`/workspaces/${workspaceAId}/reports/${foreignTemplateId}`)).status, 404);
  assert.equal((await manager.get(`/workspaces/${workspaceAId}/reports/${foreignTemplateId}/docx`)).status, 404);
});
