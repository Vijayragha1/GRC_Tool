'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env;
let client;
let portalClient;
let restrictedClient;
let db;
let domain;
let auditLog;
let manager;
let restrictedUser;
let workspaceId;
let disabledWorkspaceId;
let otherWorkspaceId;
let assessment;
let snapshot;

function insertWorkspace(firmId, name, frameworks) {
  return Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,frameworks)
    VALUES (?,?,'Technology','DPDPA route integration scope',?)`)
    .run(firmId, name, JSON.stringify(frameworks)).lastInsertRowid);
}

function applicabilityProfile() {
  return {
    organisation_roles: ['Data Fiduciary'],
    digital_personal_data_in_scope: 'Yes',
    children_or_guardian_processing: 'No',
    sdf_designation_state: 'Not Designated',
    statutory_consent_manager_activity: 'No',
    cross_border_processing_or_transfers: 'Yes',
    exemptions_or_public_data_assumptions: 'No exemption or public-data assumption is relied on for this controlled route test.',
    legacy_consent_cohort: 'Yes',
    scope_limitations: 'This route test covers the governed DPDPA catalogue and frozen assessment-report boundary.',
  };
}

function audited(input) {
  return { ...input, logAction: auditLog };
}

async function authenticateAs(app, email, password) {
  const scoped = makeClient(app);
  const login = await scoped.get('/login');
  const token = (login.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const response = await scoped.post('/login', { email, password, _csrf: token }, { csrf: false });
  assert.ok(response.status >= 300 && response.status < 400, `login returned ${response.status}`);
  await scoped.get('/dashboard');
  return scoped;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  domain = require('../lib/dpdpa-gap-domain');
  auditLog = require('../db').logAction;
  manager = db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();

  const approverId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('dpdpa-route-approver@example.test','!test','DPDPA Route Approver',?,'firm','manager',1)`)
    .run(manager.firm_id).lastInsertRowid);
  workspaceId = insertWorkspace(manager.firm_id, 'Frozen DPDPA Client', ['dpdpa']);
  disabledWorkspaceId = insertWorkspace(manager.firm_id, 'DPDPA Disabled Client', ['iso27001']);
  otherWorkspaceId = insertWorkspace(manager.firm_id, 'Other DPDPA Tenant', ['dpdpa']);
  const restrictedPassword = 'dpdpa-restricted-password-1234';
  const restrictedUserId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('dpdpa-route-senior@example.test',?,'DPDPA Route Senior',?,'firm','senior_consultant',1)`)
    .run(bcrypt.hashSync(restrictedPassword, 4), manager.firm_id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'senior_consultant')")
    .run(workspaceId, restrictedUserId);
  restrictedUser = db.prepare('SELECT * FROM users WHERE id=?').get(restrictedUserId);
  restrictedClient = await authenticateAs(
    env.app, 'dpdpa-route-senior@example.test', restrictedPassword,
  );

  assessment = domain.createAssessment(db, audited({
    workspaceId,
    title: 'Production DPDPA route baseline',
    scopeStatement: 'The assessment covers the Indian digital-personal-data processing boundary retained in this route test.',
    asOfDate: '2026-11-13',
    applicabilityProfile: applicabilityProfile(),
    createdBy: manager.id,
  }));
  const items = domain.getAssessmentItems(db, workspaceId, assessment.id);
  for (const item of items) {
    domain.updateAssessmentItem(db, audited({
      workspaceId,
      assessmentId: assessment.id,
      itemId: item.id,
      actorId: manager.id,
      rowVersion: item.row_version,
      status: 'Not Implemented',
      assessmentNote: `The assessed organisation has not implemented the capability required by ${item.ref}.`,
      gapDescription: `A controlled implementation gap remains for ${item.ref} within the frozen assessment boundary.`,
      recommendation: `Assign an accountable owner and implement evidence-backed remediation for ${item.ref}.`,
      ownerId: manager.id,
      dueDate: '2027-04-30',
    }));
  }
  let current = domain.getAssessment(db, workspaceId, assessment.id);
  current = domain.submitAssessment(db, audited({
    workspaceId,
    assessmentId: assessment.id,
    actorId: manager.id,
    rowVersion: current.row_version,
    note: 'The complete evidence-backed assessment is submitted for independent quality review.',
  }));
  const approved = domain.approveAssessment(db, audited({
    workspaceId,
    assessmentId: assessment.id,
    actorId: approverId,
    rowVersion: current.row_version,
    note: 'I independently reviewed the complete assessment and approve this controlled readiness baseline.',
  }));
  assessment = approved.assessment;
  snapshot = approved.snapshot;

  const clientPassword = 'client-dpdpa-password-1234';
  const clientUserId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'client',NULL,NULL,1)`)
    .run('dpdpa-client@example.test', bcrypt.hashSync(clientPassword, 4), 'DPDPA Client User').lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')")
    .run(workspaceId, clientUserId);
  portalClient = await authenticateAs(env.app, 'dpdpa-client@example.test', clientPassword);
});

test.after(async () => {
  if (portalClient) await portalClient.close();
  if (restrictedClient) await restrictedClient.close();
  if (client) await client.close();
});

test('manager quick-create exposes, persists and opens a DPDPA-only programme', async () => {
  const dashboard = await client.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /id="dashboard-dpdpa-programme"[^>]*value="dpdpa"/);

  const created = await client.post('/workspaces', {
    client_name: 'DPDPA Quick Create Regression Client',
    industry: 'Technology',
    frameworks: 'dpdpa',
  });
  assert.equal(created.status, 302);
  assert.match(created.location, /^\/workspaces\/\d+\/dpdpa(?:\?|$)/);

  const workspace = db.prepare('SELECT frameworks FROM workspaces WHERE client_name=?')
    .get('DPDPA Quick Create Regression Client');
  assert.deepEqual(JSON.parse(workspace.frameworks), ['dpdpa']);
});

test('module routes enforce explicit enablement, tenant boundaries and the firm delivery boundary', async () => {
  const overview = await client.get(`/workspaces/${workspaceId}/dpdpa`);
  assert.equal(overview.status, 200, overview.text.slice(0, 500));
  assert.match(overview.text, /DPDPA readiness/);
  assert.match(overview.text, /Production DPDPA route baseline/);

  const disabled = await client.get(`/workspaces/${disabledWorkspaceId}/dpdpa`);
  assert.equal(disabled.status, 404);
  assert.match(disabled.text, /DPDPA is not enabled/);

  const crossTenant = await client.get(`/workspaces/${otherWorkspaceId}/dpdpa/assessments/${assessment.id}`);
  assert.equal(crossTenant.status, 404);
  assert.match(crossTenant.text, /not found in this client workspace/i);

  const clientDenied = await portalClient.get(`/workspaces/${workspaceId}/dpdpa`);
  assert.equal(clientDenied.status, 403);
  assert.match(clientDenied.text, /limited to the client portal/i);
});

test('workbench and frozen preview expose controlled lifecycle, legal timing and integrity facts', async () => {
  const workbench = await client.get(`/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}`);
  assert.equal(workbench.status, 200, workbench.text.slice(0, 500));
  assert.match(workbench.text, /Approved/);
  assert.match(workbench.text, /obligations are currently effective/);
  assert.match(workbench.text, /future-effective/);
  assert.match(workbench.text, /Applicability, scope and accountability/);

  const report = await client.get(`/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}/report?snapshot=${snapshot.id}`);
  assert.equal(report.status, 200, report.text.slice(0, 500));
  assert.match(report.text, /Approved frozen readiness snapshot/);
  assert.match(report.text, /Frozen DPDPA Client/);
  assert.match(report.text, new RegExp(snapshot.snapshot_hash));
  assert.match(report.text, /Download PDF/);
  assert.match(report.text, /Download DOCX/);
  assert.match(report.text, /Download CSV/);
  assert.match(report.text, /not legal certification/i);

  const invalid = await client.get(`/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}/report?snapshot=not-a-number`);
  assert.equal(invalid.status, 400);
  const absent = await client.get(`/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}/report?snapshot=999999`);
  assert.equal(absent.status, 404);
});

test('optimistic item concurrency returns a recoverable 409 without overwriting the frozen baseline', async () => {
  const draft = domain.createAssessment(db, audited({
    workspaceId,
    title: 'Concurrent DPDPA reassessment',
    scopeStatement: 'This reassessment exists to prove stale browser writes cannot overwrite controlled workpapers.',
    asOfDate: '2027-05-13',
    applicabilityProfile: applicabilityProfile(),
    createdBy: manager.id,
  }));
  const item = domain.getAssessmentItems(db, workspaceId, draft.id)[0];
  const conflict = await client.post(`/workspaces/${workspaceId}/dpdpa/assessments/${draft.id}/items/${item.id}`, {
    row_version: item.row_version + 10,
    requirement_ref: item.ref,
    status: 'Not Implemented',
    assessment_note: 'This attempted change is based on a stale browser version and must not persist.',
    gap_description: 'This attempted gap description must be rejected by optimistic concurrency.',
    recommendation: 'Reload the controlled workpaper before recording an implementation conclusion.',
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.text, /changed before your action completed/i);
  const unchanged = domain.getAssessmentItems(db, workspaceId, draft.id)
    .find(row => row.id === item.id);
  assert.equal(unchanged.status, 'Not Assessed');
  assert.equal(unchanged.row_version, item.row_version);
});

test('CSV, DOCX and PDF endpoints deliver exact frozen artifacts with no-store controls', async () => {
  const base = `/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}/exports`;
  const csv = await client.get(`${base}/data.csv?snapshot=${snapshot.id}`);
  assert.equal(csv.status, 200, csv.text.slice(0, 300));
  assert.match(csv.headers['content-type'], /^text\/csv/);
  assert.equal(csv.headers['cache-control'], 'private, no-store');
  assert.equal(csv.headers['x-content-type-options'], 'nosniff');
  assert.ok(csv.buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.match(csv.text, new RegExp(snapshot.snapshot_hash));
  assert.match(csv.text, /Future Effective/);

  const docx = await client.get(`${base}/report.docx?snapshot=${snapshot.id}`);
  assert.equal(docx.status, 200, docx.text.slice(0, 200));
  assert.match(docx.headers['content-type'], /officedocument\.wordprocessingml\.document/);
  assert.equal(docx.buffer.subarray(0, 2).toString('ascii'), 'PK');

  const pdf = await client.get(`${base}/report.pdf?snapshot=${snapshot.id}`);
  assert.equal(pdf.status, 200, pdf.text.slice(0, 200));
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.buffer.subarray(0, 4).toString('ascii'), '%PDF');

  const auditActions = db.prepare(`SELECT action,details FROM audit_log
    WHERE workspace_id=? AND entity_type='dpdpa_gap_assessment_snapshot'
      AND action LIKE 'dpdpa_gap_snapshot_export_%' ORDER BY action`).all(workspaceId);
  assert.deepEqual(auditActions.map(row => row.action), [
    'dpdpa_gap_snapshot_export_csv',
    'dpdpa_gap_snapshot_export_docx',
    'dpdpa_gap_snapshot_export_pdf',
  ]);
  for (const row of auditActions) {
    const details = JSON.parse(row.details);
    assert.equal(details.snapshot_hash, snapshot.snapshot_hash);
    assert.ok(details.bytes > 0);
  }
});

test('snapshot creation, preview and exports honor evidence source revocations', async () => {
  const insertOverride = db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,?,0,?,'DPDPA aggregate evidence authorization regression')`);
  const clearOverrides = db.prepare(`DELETE FROM workspace_role_overrides
    WHERE workspace_id=? AND user_id=?`);
  const preview = `/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}/report?snapshot=${snapshot.id}`;
  const exportBase = `/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}/exports`;

  for (const permission of ['evidence.view', 'evidence.export']) {
    clearOverrides.run(workspaceId, restrictedUser.id);
    insertOverride.run(workspaceId, restrictedUser.id, permission, manager.id);
    assert.equal((await restrictedClient.post(
      `/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}/snapshots`,
      { reason: 'This request must be denied before snapshot creation.' },
    )).status, 403, `snapshot creation must honor a ${permission} revoke`);
    assert.equal((await restrictedClient.get(preview)).status, 403,
      `snapshot preview must honor a ${permission} revoke`);
    for (const suffix of ['/report.pdf', '/report.docx', '/data.csv']) {
      assert.equal((await restrictedClient.get(`${exportBase}${suffix}?snapshot=${snapshot.id}`)).status, 403,
        `${suffix} must honor a ${permission} revoke`);
    }
  }
  clearOverrides.run(workspaceId, restrictedUser.id);
});
