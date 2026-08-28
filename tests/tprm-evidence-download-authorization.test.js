'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootApp, makeClient } = require('./helpers');

const PASSWORD = 'Tprm-evidence-download-password-1234';

let env;
let db;
let consultant;
let ids;
const generatedFiles = [];

function retainFile(firmId, name, contents) {
  const directory = path.join(__dirname, '..', 'uploads', `firm_${firmId}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const storedPath = `tprm-authz-${process.pid}-${name}`;
  const absolutePath = path.join(directory, storedPath);
  fs.writeFileSync(absolutePath, contents, { mode: 0o600 });
  generatedFiles.push(absolutePath);
  return storedPath;
}

async function login(http, email) {
  const page = await http.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF missing for ${email}`);
  const signedIn = await http.post('/login', {
    email, password: PASSWORD, _csrf: csrf,
  }, { csrf: false });
  assert.equal(signedIn.status, 302, signedIn.text.slice(0, 300));
}

test.before(async () => {
  env = bootApp();
  db = new Database(env.dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const passwordHash = bcrypt.hashSync(PASSWORD, 4);
  const managerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('tprm-download-manager@test.local',?,'TPRM Download Manager','firm',?,'manager',1)`)
    .run(passwordHash, firmId).lastInsertRowid);
  const consultantId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('tprm-download-consultant@test.local',?,'TPRM Download Consultant','firm',?,'consultant',1)`)
    .run(passwordHash, firmId).lastInsertRowid);
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,frameworks,lead_consultant_id)
    VALUES (?,'TPRM evidence authorization','[]',?)`)
    .run(firmId, consultantId).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Physical evidence authorization regression',?)`)
    .run(workspaceId, managerId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')")
    .run(workspaceId, consultantId);
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,'Scoped evidence provider','Hosted security service','active')`)
    .run(workspaceId).lastInsertRowid);
  const otherSupplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,'Different provider','Unrelated service','active')`)
    .run(workspaceId).lastInsertRowid);

  const supplierDocumentPath = retainFile(firmId, 'supplier-document.txt', 'supplier document bytes');
  const questionnairePath = retainFile(firmId, 'questionnaire-attachment.txt', 'questionnaire attachment bytes');
  const ddqPath = retainFile(firmId, 'ddq-evidence.txt', 'ddq evidence bytes');
  const supplierDocumentId = Number(db.prepare(`INSERT INTO supplier_documents
    (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,uploaded_by)
    VALUES (?,?,'assurance','Assurance record','supplier-assurance.txt',?,?,?,?)`)
    .run(workspaceId, supplierId, supplierDocumentPath,
      crypto.createHash('sha256').update('supplier document bytes').digest('hex'),
      Buffer.byteLength('supplier document bytes'), consultantId).lastInsertRowid);

  const templateId = db.prepare('SELECT id FROM questionnaire_templates ORDER BY id LIMIT 1').get().id;
  const questionnaireId = Number(db.prepare(`INSERT INTO supplier_questionnaires
    (workspace_id,supplier_id,template_id,template_name,status)
    VALUES (?,?,?,'Authorization questionnaire','reviewed')`)
    .run(workspaceId, supplierId, templateId).lastInsertRowid);
  const attachmentId = Number(db.prepare(`INSERT INTO questionnaire_attachments
    (questionnaire_id,workspace_id,filename,stored_path,mime,size_bytes,sha256,source,uploaded_by)
    VALUES (?,?,'questionnaire-evidence.txt',?,'text/plain',?,?, 'consultant',?)`)
    .run(questionnaireId, workspaceId, questionnairePath,
      Buffer.byteLength('questionnaire attachment bytes'),
      crypto.createHash('sha256').update('questionnaire attachment bytes').digest('hex'),
      consultantId).lastInsertRowid);

  const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
    (workspace_id,supplier_id,methodology_version,status,assigned_tier,unknown_count,created_by)
    VALUES (?,?,'2026.1','approved','tier_2',0,?)`)
    .run(workspaceId, supplierId, consultantId).lastInsertRowid);
  const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
    (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,status,modules_json,created_by)
    VALUES (?,?,?,'2026.1','tier_2','under_review','[]',?)`)
    .run(workspaceId, supplierId, inherentId, consultantId).lastInsertRowid);
  const ddqEvidenceId = Number(db.prepare(`INSERT INTO supplier_ddq_evidence
    (workspace_id,assessment_id,question_id,filename,stored_path,sha256,size_bytes,mime_type,source,uploaded_by)
    VALUES (?,?,'IAM-1','ddq-evidence.txt',?,?,?,'text/plain','reviewer',?)`)
    .run(workspaceId, ddqId, ddqPath,
      crypto.createHash('sha256').update('ddq evidence bytes').digest('hex'),
      Buffer.byteLength('ddq evidence bytes'), consultantId).lastInsertRowid);

  ids = {
    firmId, managerId, consultantId, workspaceId, supplierId, otherSupplierId,
    supplierDocumentId, questionnaireId, attachmentId, ddqEvidenceId,
  };
  consultant = makeClient(env.app);
  await login(consultant, 'tprm-download-consultant@test.local');
});

test.after(async () => {
  if (db) db.close();
  if (consultant) await consultant.close();
  for (const file of generatedFiles) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  }
});

function physicalRoutes() {
  const base = `/workspaces/${ids.workspaceId}/vendors/${ids.supplierId}`;
  return [
    { path: `${base}/documents/${ids.supplierDocumentId}/download`, contents: 'supplier document bytes' },
    { path: `${base}/questionnaires/${ids.questionnaireId}/attachments/${ids.attachmentId}/download`, contents: 'questionnaire attachment bytes' },
    { path: `${base}/due-diligence/evidence/${ids.ddqEvidenceId}`, contents: 'ddq evidence bytes' },
  ];
}

function responseSummary(response) {
  return response.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

test('authorized firm actor can download each tenant-scoped TPRM evidence source', async () => {
  for (const route of physicalRoutes()) {
    const response = await consultant.get(route.path);
    assert.equal(response.status, 200,
      `${route.path} should retain authorized access: ${responseSummary(response)}`);
    assert.equal(response.buffer.toString('utf8'), route.contents);
  }

  assert.equal((await consultant.get(
    `/workspaces/${ids.workspaceId}/vendors/${ids.otherSupplierId}/documents/${ids.supplierDocumentId}/download`
  )).status, 404);
  assert.equal((await consultant.get(
    `/workspaces/${ids.workspaceId}/vendors/${ids.otherSupplierId}/questionnaires/${ids.questionnaireId}/attachments/${ids.attachmentId}/download`
  )).status, 404);
  assert.equal((await consultant.get(
    `/workspaces/${ids.workspaceId}/vendors/${ids.otherSupplierId}/due-diligence/evidence/${ids.ddqEvidenceId}`
  )).status, 404);

  for (const suffix of [
    'conditions/999999/evidence/999999/download',
    'conditions/999999/evidence/latest/download',
  ]) {
    const response = await consultant.get(
      `/workspaces/${ids.workspaceId}/tprm/third-parties/${ids.supplierId}/${suffix}`
    );
    assert.equal(response.status, 404, 'authorized firm condition-evidence lookup should reach row scoping');
  }
});

test('evidence.download revoke contains every firm-side TPRM physical path', async () => {
  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,'evidence.download',0,?,'TPRM physical evidence authorization regression')`)
    .run(ids.workspaceId, ids.consultantId, ids.managerId);

  const paths = physicalRoutes().map(route => route.path).concat([
    `/workspaces/${ids.workspaceId}/tprm/third-parties/${ids.supplierId}/conditions/999999/evidence/999999/download`,
    `/workspaces/${ids.workspaceId}/tprm/third-parties/${ids.supplierId}/conditions/999999/evidence/latest/download`,
  ]);
  for (const route of paths) {
    const response = await consultant.get(route);
    assert.equal(response.status, 403,
      `${route} must honor evidence.download revocation: ${responseSummary(response)}`);
  }
});
