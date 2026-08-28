'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootApp, makeClient } = require('./helpers');
const assuranceReports = require('../lib/assurance-reports');

const PASSWORD = 'Export-source-test-password-1234';

async function login(client, email) {
  const page = await client.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF token missing for ${email}`);
  const signedIn = await client.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302, signedIn.text.slice(0, 300));
  let warm = await client.get('/dashboard');
  if (warm.status === 302 && warm.location) warm = await client.get(warm.location);
  assert.equal(warm.status, 200, warm.text.slice(0, 300));
}

function insertUser(db, { email, name, role = null, type = 'firm', firmId }) {
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`)
    .run(email, bcrypt.hashSync(PASSWORD, 4), name, type, firmId, type === 'firm' ? role : null).lastInsertRowid);
}

function seedScenario(dbPath) {
  const db = new Database(dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const managerId = insertUser(db, {
    email: 'export-manager@test.local', name: 'Export Manager', role: 'manager', firmId,
  });
  const seniorId = insertUser(db, {
    email: 'export-senior@test.local', name: 'Export Senior', role: 'senior_consultant', firmId,
  });
  const clientId = insertUser(db, {
    email: 'export-client@test.local', name: 'Export Client', type: 'client', firmId,
  });
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,scope,lead_consultant_id,frameworks,engagement_outcome)
    VALUES (?,'Export Source Workspace','Source permission regression scope',?,'["iso27001","iso42001"]','certification_support')`)
    .run(firmId, managerId).lastInsertRowid);
  const member = db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
  member.run(workspaceId, seniorId, 'senior_consultant');
  member.run(workspaceId, clientId, 'client_owner');
  db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Source permission regression',?)`)
    .run(workspaceId, managerId);
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage)
    VALUES (?,'Assurance Source Supplier','Controlled hosting','active')`)
    .run(workspaceId).lastInsertRowid);

  const engagementId = Number(db.prepare(`INSERT INTO consulting_engagements
    (workspace_id,engagement_code,name,engagement_type,framework_scope_json,status,created_by)
    VALUES (?,'EXP-AUTH-1','Export authorization engagement','implementation','["iso27001"]','active',?)`)
    .run(workspaceId, managerId).lastInsertRowid);
  const snapshot = JSON.stringify({
    engagement: {
      id: engagementId,
      code: 'EXP-AUTH-1',
      name: 'Export authorization engagement',
      type: 'implementation',
      frameworks: ['iso27001'],
      scope: 'Published client-safe scope',
      period: [],
    },
    workpapers: [],
    findings: [],
    basis: 'Published authorization regression fixture.',
  });
  const reportId = Number(db.prepare(`INSERT INTO consulting_report_snapshots
    (workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,
      generated_by,approved_by,approved_at,published_by,published_at)
    VALUES (?,?, 'assessment','PUBLISHED-REPORT-AUTH-CANARY',1,'published',?,?,?, ?,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP)`)
    .run(
      workspaceId,
      engagementId,
      snapshot,
      crypto.createHash('sha256').update(snapshot).digest('hex'),
      managerId,
      managerId,
      managerId,
    ).lastInsertRowid);
  const reportTemplateId = Number(db.prepare(`INSERT INTO report_templates
    (workspace_id,firm_id,name,description,body,is_system)
    VALUES (?,NULL,'SOURCE-AUTH-REPORT-TEMPLATE','Aggregate source authorization regression',?,0)`)
    .run(workspaceId, `# {{workspace.client_name}}

{{top_risks_table}}

{{audits_table}}

{{top_suppliers_table}}

{{calendar_table}}`).lastInsertRowid);

  const commonAssuranceRun = assuranceReports.createRun(
    db, workspaceId, seniorId, 'executive_posture', {
      selected_sections: assuranceReports.REPORTS.executive_posture.sections,
    },
  );
  const supplierAssuranceRun = assuranceReports.createRun(
    db, workspaceId, seniorId, 'supplier_due_diligence', {
      supplier_id: supplierId,
      selected_sections: assuranceReports.REPORTS.supplier_due_diligence.sections,
    },
  );
  const insertArtifact = db.prepare(`INSERT INTO assurance_report_artifacts
    (run_id,format,filename,mime_type,content_blob,content_hash,size_bytes,generated_by)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const run of [commonAssuranceRun, supplierAssuranceRun]) {
    for (const [format, mime] of [
      ['pdf', 'application/pdf'],
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['json', 'application/json'],
    ]) {
      const content = Buffer.from(`assurance-${run.id}-${format}`);
      insertArtifact.run(
        run.id, format, `assurance-${run.id}.${format}`, mime, content,
        crypto.createHash('sha256').update(content).digest('hex'), content.length, seniorId,
      );
    }
  }
  db.close();
  return {
    firmId, managerId, seniorId, clientId, workspaceId, reportId, reportTemplateId,
    supplierId, commonAssuranceRunId: commonAssuranceRun.id,
    supplierAssuranceRunId: supplierAssuranceRun.id,
  };
}

function revokeOnly(dbPath, ids, permission) {
  const db = new Database(dbPath);
  db.prepare('DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=?')
    .run(ids.workspaceId, ids.seniorId);
  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,?,0,?,'Source-domain export regression')`)
    .run(ids.workspaceId, ids.seniorId, permission, ids.managerId);
  db.close();
}

async function assertGetDenied(client, workspaceId, routes, permission) {
  for (const suffix of routes) {
    const route = `/workspaces/${workspaceId}${suffix}`;
    const response = await client.get(route);
    assert.equal(response.status, 403, `${route} must honor a ${permission} revoke`);
  }
}

test('bulk exports honor source-domain revokes and published client reports preserve contextual access', async (t) => {
  const { app, dbPath } = bootApp();
  const ids = seedScenario(dbPath);
  const senior = makeClient(app);
  const client = makeClient(app);
  t.after(async () => { await Promise.all([senior.close(), client.close()]); });
  await login(senior, 'export-senior@test.local');
  await login(client, 'export-client@test.local');

  // Built-in legitimate roles retain the ordinary export and published-report
  // paths before an explicit per-user revoke is applied.
  for (const suffix of [
    '/export/soa.csv',
    '/export/risks.csv',
    '/export/assets.csv',
    '/iso42001/export/soa.csv',
    '/activity-log.csv',
    '/evidence-coverage.csv',
    '/evidence/pack.zip',
    '/vendors/export.csv',
    '/audit-pack',
    '/assurance',
    '/handover',
  ]) {
    const response = await senior.get(`/workspaces/${ids.workspaceId}${suffix}`);
    assert.equal(response.status, 200, `${suffix} must remain available to a senior consultant`);
  }
  const firmPortal = await senior.get(`/workspaces/${ids.workspaceId}/client-portal?view=reports`);
  assert.equal(firmPortal.status, 200);
  assert.match(firmPortal.text, /PUBLISHED-REPORT-AUTH-CANARY/);
  assert.equal((await senior.get(`/workspaces/${ids.workspaceId}/client-portal/reports/${ids.reportId}`)).status, 200);
  const reportRoutes = [
    `/reports/${ids.reportTemplateId}`,
    `/reports/${ids.reportTemplateId}/docx`,
  ];
  assert.equal((await senior.get(
    `/workspaces/${ids.workspaceId}/reports/${ids.reportTemplateId}`
  )).status, 200, 'report preview must remain available before a source revoke');
  assert.equal((await senior.get(
    `/workspaces/${ids.workspaceId}/reports/999999999/docx`
  )).status, 404, 'authorized DOCX routing must reach the scoped template lookup');

  for (const [key, runId, extra] of [
    ['executive_posture', ids.commonAssuranceRunId, ''],
    ['supplier_due_diligence', ids.supplierAssuranceRunId, `&supplier_id=${ids.supplierId}`],
  ]) {
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance/new?type=${key}${extra}`
    )).status, 200, `${key} builder must remain available with every source permission`);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/assurance/runs`, {
      report_key: key,
      title: `Positive ${key} authorization run`,
      supplier_id: key === 'supplier_due_diligence' ? ids.supplierId : '',
      ack_quality: '1',
    })).status, 302, `${key} generation must remain available with every source permission`);
    for (const suffix of ['', '/preview', '/pdf', '/docx', '/json']) {
      assert.equal((await senior.get(
        `/workspaces/${ids.workspaceId}/assurance/runs/${runId}${suffix}`
      )).status, 200, `${key}${suffix || ' detail'} must remain available with every source permission`);
    }
  }

  // buildContext resolves every source domain even when a template happens not
  // to reference one of its placeholders. The preview and generated DOCX must
  // therefore fail closed if any unconditional source permission is revoked.
  for (const permission of [
    'control.view', 'risk.view', 'document.view', 'tprm.third_party.view',
    'tprm.assurance.view', 'tprm.assurance.export',
    'audit.manage', 'nc.manage', 'mrm.manage', 'task.manage',
  ]) {
    revokeOnly(dbPath, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, reportRoutes, permission);
  }

  const commonAssuranceRoutes = [
    `/assurance/runs/${ids.commonAssuranceRunId}`,
    `/assurance/runs/${ids.commonAssuranceRunId}/preview`,
    `/assurance/runs/${ids.commonAssuranceRunId}/pdf`,
    `/assurance/runs/${ids.commonAssuranceRunId}/docx`,
    `/assurance/runs/${ids.commonAssuranceRunId}/json`,
  ];
  for (const permission of [
    'control.view', 'risk.view', 'evidence.view', 'evidence.export', 'document.view',
    'audit.manage', 'mrm.manage', 'nc.manage',
  ]) {
    revokeOnly(dbPath, ids, permission);
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance/new?type=executive_posture`
    )).status, 403, `assurance builder must honor a ${permission} revoke`);
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance`
    )).status, 403, `assurance center must honor a ${permission} revoke`);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/assurance/runs`, {
      report_key: 'executive_posture', ack_quality: '1',
    })).status, 403, `assurance generation must honor a ${permission} revoke`);
    await assertGetDenied(senior, ids.workspaceId, commonAssuranceRoutes, permission);
    for (const action of ['submit', 'request-changes', 'publish']) {
      assert.equal((await senior.post(
        `/workspaces/${ids.workspaceId}/assurance/runs/${ids.commonAssuranceRunId}/${action}`, {}
      )).status, 403, `assurance ${action} must honor a ${permission} revoke`);
    }
  }

  const supplierAssuranceRoutes = [
    `/assurance/runs/${ids.supplierAssuranceRunId}`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/preview`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/pdf`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/docx`,
    `/assurance/runs/${ids.supplierAssuranceRunId}/json`,
  ];
  for (const permission of [
    'tprm.third_party.view', 'tprm.assurance.view', 'tprm.assurance.export',
  ]) {
    revokeOnly(dbPath, ids, permission);
    assert.equal((await senior.get(
      `/workspaces/${ids.workspaceId}/assurance/new?type=supplier_due_diligence&supplier_id=${ids.supplierId}`
    )).status, 403, `supplier assurance builder must honor a ${permission} revoke`);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/assurance/runs`, {
      report_key: 'supplier_due_diligence', supplier_id: ids.supplierId, ack_quality: '1',
    })).status, 403, `supplier assurance generation must honor a ${permission} revoke`);
    await assertGetDenied(senior, ids.workspaceId, supplierAssuranceRoutes, permission);
  }

  // Handover includes decrypted structured records and physical source files
  // across every domain below, so a revoke in any one domain contains the
  // aggregate export rather than silently including that source.
  for (const permission of [
    'evidence.export', 'evidence.view', 'evidence.download', 'control.view', 'risk.view',
    'asset.view', 'entity.view', 'document.view', 'audit.manage', 'nc.manage',
    'mrm.manage', 'incident.manage', 'task.manage', 'audit_log.view',
    'audit_log.export', 'tprm.third_party.view', 'tprm.assurance.view',
    'tprm.assurance.export', 'members.view',
  ]) {
    revokeOnly(dbPath, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, ['/handover'], permission);
  }

  for (const permission of ['audit.manage', 'nc.manage', 'mrm.manage']) {
    revokeOnly(dbPath, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, [
      '/audit-pack', '/audit-pack/preview', '/audit-pack/zip',
    ], permission);
    assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403,
      `/audit-pack/pdf must honor a ${permission} revoke`);
  }

  for (const permission of ['audit.manage', 'mrm.manage']) {
    revokeOnly(dbPath, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, ['/export/readiness-pack.zip'], permission);
  }

  revokeOnly(dbPath, ids, 'evidence.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/evidence-coverage.csv', '/evidence/pack.zip',
    '/audit-pack', '/audit-pack/preview', '/audit-pack/zip',
    '/export/readiness-pack.zip',
  ], 'evidence.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403,
    '/audit-pack/pdf must honor an evidence.view revoke');

  revokeOnly(dbPath, ids, 'evidence.download');
  await assertGetDenied(senior, ids.workspaceId, [
    '/evidence/pack.zip', '/audit-pack/zip', '/export/readiness-pack.zip',
  ], 'evidence.download');

  revokeOnly(dbPath, ids, 'control.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/export/soa.csv',
    '/export/rtp.docx',
    '/export/gap-report.docx',
    '/export/gap-report.pdf',
    '/export/recommendations.docx',
    '/iso42001/export/soa.csv',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
    '/export/readiness-pack.zip',
  ], 'control.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  for (const permission of [
    'evidence.view', 'evidence.export', 'task.manage', 'nc.manage',
    'members.view', 'audit.manage',
  ]) {
    revokeOnly(dbPath, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, [
      '/export/gap-report.docx', '/export/gap-report.pdf',
    ], permission);
    if (['evidence.view', 'evidence.export', 'task.manage', 'members.view'].includes(permission)) {
      await assertGetDenied(senior, ids.workspaceId, [
        '/engagement-plan/export.csv', '/engagement-plan/report.pdf',
      ], permission);
    }
    if (['evidence.view', 'evidence.export'].includes(permission)) {
      await assertGetDenied(senior, ids.workspaceId, [
        '/controls/assess/summary.docx',
      ], permission);
    }
  }

  revokeOnly(dbPath, ids, 'risk.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/export/soa.csv',
    '/export/risks.csv',
    '/export/rtp.docx',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
    '/export/readiness-pack.zip',
  ], 'risk.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  revokeOnly(dbPath, ids, 'asset.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/export/assets.csv', '/export/risks.csv',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
  ], 'asset.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  revokeOnly(dbPath, ids, 'document.view');
  await assertGetDenied(senior, ids.workspaceId, ['/audit-pack/zip'], 'document.view');

  revokeOnly(dbPath, ids, 'audit_log.export');
  await assertGetDenied(senior, ids.workspaceId, [
    '/audit-pack', '/audit-pack/preview', '/audit-pack/zip',
  ], 'audit_log.export');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  revokeOnly(dbPath, ids, 'audit_log.view');
  await assertGetDenied(senior, ids.workspaceId, [
    '/activity-log.csv',
    '/audit-pack',
    '/audit-pack/preview',
    '/audit-pack/zip',
  ], 'audit_log.view');
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/audit-pack/pdf`, {})).status, 403);

  for (const permission of [
    'tprm.third_party.view', 'tprm.assurance.view', 'tprm.assurance.export',
  ]) {
    revokeOnly(dbPath, ids, permission);
    await assertGetDenied(senior, ids.workspaceId, [
      '/vendors/export.csv',
      '/assurance',
    ], permission);
  }

  // The client-context report surface must not let a firm actor route around a
  // revoked report.view, while real client accounts retain published access.
  revokeOnly(dbPath, ids, 'report.view');
  assert.equal(
    (await senior.get(`/workspaces/${ids.workspaceId}/client-portal/reports/${ids.reportId}`)).status,
    403,
  );
  const revokedFirmPortal = await senior.get(`/workspaces/${ids.workspaceId}/client-portal?view=reports`);
  assert.equal(revokedFirmPortal.status, 200);
  assert.doesNotMatch(
    revokedFirmPortal.text,
    new RegExp(`/client-portal/reports/${ids.reportId}(?:["?#]|$)`),
  );
  const clientPortal = await client.get(`/workspaces/${ids.workspaceId}/client-portal?view=reports`);
  assert.equal(clientPortal.status, 200);
  assert.match(clientPortal.text, /PUBLISHED-REPORT-AUTH-CANARY/);
  assert.equal((await client.get(`/workspaces/${ids.workspaceId}/client-portal/reports/${ids.reportId}`)).status, 200);
});
