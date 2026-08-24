'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdpa-gap-domain-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.ISMS_KEY_FILE = path.join(tempDir, 'master.key');

const core = require('../db');
const domain = require('../lib/dpdpa-gap-domain');
const { deleteWorkspace } = require('../lib/workspace-deletion');
core.init();
const { db } = core;

function makeCatalog(version = 'test-1.0', suffix = '') {
  return {
    metadata: {
      code: 'dpdpa',
      name: `DPDPA governed test catalog ${suffix}`.trim(),
      version,
      sourceReference: `Focused domain test source ${version}`,
    },
    requirements: [
      {
        ref: `TEST-CURRENT${suffix}`,
        reqType: 'control',
        title: 'Current effective implementation requirement',
        summary: 'A currently effective requirement used to test evidence gates.',
        domain: 'current_domain',
        effectiveDate: '2025-01-01',
        sourceSectionRule: 'Test Act s. 1',
        sortOrder: 1,
      },
      {
        ref: `TEST-FUTURE${suffix}`,
        reqType: 'control',
        title: 'Future effective implementation requirement',
        summary: 'A future requirement used to test readiness separation and remediation.',
        domain: 'future_domain',
        effectiveDate: '2027-01-01',
        sourceSectionRule: 'Test Rules r. 2',
        sortOrder: 2,
      },
      {
        ref: `TEST-NA${suffix}`,
        reqType: 'control',
        title: 'Conditional current requirement',
        summary: 'A conditional requirement used to test explicit Not Applicable review.',
        domain: 'conditional_domain',
        effectiveDate: '2025-01-01',
        sourceSectionRule: 'Test Act s. 3',
        appliesWhen: { children_or_guardian_processing: ['Yes'] },
        sortOrder: 3,
      },
    ],
  };
}

function insertUser(firmId, email, name, role, userType = 'firm') {
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,'!test',?,?,?,?,1)`).run(
      email, name, userType, userType === 'firm' ? firmId : null,
      userType === 'firm' ? role : null
    ).lastInsertRowid);
}

function insertWorkspace(firmId, name) {
  return Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,?,'["dpdpa"]')`).run(firmId, name).lastInsertRowid);
}

function profile() {
  return {
    organisation_roles: ['Data Fiduciary'],
    digital_personal_data_in_scope: 'Yes',
    children_or_guardian_processing: 'No',
    sdf_designation_state: 'Not Designated',
    statutory_consent_manager_activity: 'No',
    cross_border_processing_or_transfers: 'Unknown',
    exemptions_or_public_data_assumptions: 'No exemption or public-data assumption is relied on for this focused assessment.',
    legacy_consent_cohort: 'No',
    scope_limitations: 'The focused test is limited to the three synthetic catalog requirements.',
  };
}

function expectCode(code) {
  return error => {
    assert.equal(error && error.code, code);
    return true;
  };
}

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('governed lifecycle enforces tenant, as-of evidence, N/A review, projections and snapshots', () => {
  const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const creator = insertUser(firm.id, 'dpdpa-creator@example.test', 'DPDPA Creator', 'consultant');
  const approver = insertUser(firm.id, 'dpdpa-approver@example.test', 'DPDPA Approver', 'manager');
  const unassigned = insertUser(firm.id, 'dpdpa-unassigned@example.test', 'Unassigned Consultant', 'consultant');
  const clientOwner = insertUser(firm.id, 'dpdpa-client@example.test', 'Client Action Owner', null, 'client');
  const otherClient = insertUser(firm.id, 'dpdpa-other-client@example.test', 'Other Client', null, 'client');
  const workspaceId = insertWorkspace(firm.id, 'DPDPA Test Client');
  const otherWorkspaceId = insertWorkspace(firm.id, 'Other Client Workspace');
  db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)')
    .run(workspaceId, creator, 'consultant');
  db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)')
    .run(workspaceId, clientOwner, 'client_owner');
  db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)')
    .run(otherWorkspaceId, otherClient, 'client_owner');

  const catalogV1 = makeCatalog();
  const seeded = domain.ensureFrameworkSeeded(db, catalogV1);
  assert.equal(seeded.requirement_count, 3);
  assert.match(seeded.catalog_hash, /^[a-f0-9]{64}$/);

  assert.throws(() => domain.createAssessment(db, {
    workspaceId,
    title: 'Unauthorized assessment',
    scopeStatement: 'This scope statement is intentionally long enough for validation.',
    asOfDate: '2026-01-15',
    applicabilityProfile: profile(),
    createdBy: unassigned,
    catalog: catalogV1,
  }), expectCode('DPDPA_ACTOR_REQUIRED'));

  const assessment = domain.createAssessment(db, {
    workspaceId,
    title: 'DPDPA implementation gap baseline',
    scopeStatement: 'The assessment covers the synthetic processing scope used by this focused domain test.',
    asOfDate: '2026-01-15',
    applicabilityProfile: profile(),
    createdBy: creator,
    catalog: catalogV1,
  });
  assert.equal(assessment.status, 'Draft');
  let items = domain.getAssessmentItems(db, workspaceId, assessment.id);
  assert.equal(items.length, 3);
  assert.equal(items.filter(item => item.legal_effective_status === 'Effective').length, 2);
  assert.equal(items.filter(item => item.legal_effective_status === 'Future Effective').length, 1);
  assert.equal(items.find(item => item.ref === 'TEST-NA').applicability_hint, 'Potentially Out of Scope');

  const currentItem = items.find(item => item.ref === 'TEST-CURRENT');
  const futureItem = items.find(item => item.ref === 'TEST-FUTURE');
  const naItem = items.find(item => item.ref === 'TEST-NA');
  assert.throws(() => domain.updateAssessmentItem(db, {
    workspaceId,
    assessmentId: assessment.id,
    itemId: futureItem.id,
    actorId: creator,
    rowVersion: futureItem.row_version,
    status: 'Not Implemented',
    assessmentNote: 'The control is not implemented in the assessed environment.',
    gapDescription: 'The required implementation capability has not yet been established.',
    recommendation: 'Define, own and deliver the missing capability before its effective date.',
    ownerId: otherClient,
    dueDate: '2026-12-01',
  }), expectCode('DPDPA_OWNER_INVALID'));

  domain.updateAssessmentItem(db, {
    workspaceId,
    assessmentId: assessment.id,
    itemId: currentItem.id,
    actorId: creator,
    rowVersion: currentItem.row_version,
    status: 'Implemented',
    assessmentNote: 'The current requirement is implemented through a documented and repeatable control.',
  });
  domain.updateAssessmentItem(db, {
    workspaceId,
    assessmentId: assessment.id,
    itemId: futureItem.id,
    actorId: creator,
    rowVersion: futureItem.row_version,
    status: 'Not Implemented',
    assessmentNote: 'The future requirement is not implemented in the assessed environment.',
    gapDescription: 'The required future capability has not yet been established or assigned.',
    recommendation: 'Define, own and deliver the missing capability before its effective date.',
    ownerId: clientOwner,
    dueDate: '2026-12-01',
  });
  const firstRationale = 'This requirement is outside the assessed processing profile because the organisation does not process children data; the reviewer must still accept this documented conclusion.';
  domain.updateAssessmentItem(db, {
    workspaceId,
    assessmentId: assessment.id,
    itemId: naItem.id,
    actorId: creator,
    rowVersion: naItem.row_version,
    status: 'Not Applicable',
    naRationale: firstRationale,
  });

  const requirementId = currentItem.requirement_id;
  const futureEvidence = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,uploaded_by,description,uploaded_at,valid_from,valid_until)
    VALUES (?,?,?,?,?,?,? ,?,?)`).run(
      workspaceId, 'future.txt', '/test/future.txt', 'a'.repeat(64), creator,
      'Evidence uploaded after the assessment date.', '2026-02-01T00:00:00.000Z',
      '2026-02-01', '2027-01-01'
    ).lastInsertRowid);
  db.prepare('INSERT INTO evidence_requirement_links(evidence_id,requirement_id) VALUES (?,?)')
    .run(futureEvidence, requirementId);
  let current = domain.getAssessment(db, workspaceId, assessment.id);
  items = domain.getAssessmentItems(db, workspaceId, assessment.id);
  const evidenceItem = items.find(item => item.id === currentItem.id);
  assert.equal(evidenceItem.evidence_total_count, 1);
  assert.equal(evidenceItem.evidence_current_count, 0);
  assert.equal(evidenceItem.evidence_stale_count, 1);
  assert.throws(() => domain.submitAssessment(db, {
    workspaceId,
    assessmentId: assessment.id,
    actorId: creator,
    rowVersion: current.row_version,
  }), expectCode('DPDPA_EVIDENCE_INSUFFICIENT'));

  const currentEvidence = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,uploaded_by,description,uploaded_at,valid_from,valid_until)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      workspaceId, 'current.txt', '/test/current.txt', 'b'.repeat(64), creator,
      'Evidence current at the assessment date.', '2025-12-20T00:00:00.000Z',
      '2025-12-01', '2026-12-31'
    ).lastInsertRowid);
  db.prepare('INSERT INTO evidence_requirement_links(evidence_id,requirement_id) VALUES (?,?)')
    .run(currentEvidence, requirementId);
  current = domain.getAssessment(db, workspaceId, assessment.id);
  let submitted = domain.submitAssessment(db, {
    workspaceId,
    assessmentId: assessment.id,
    actorId: creator,
    rowVersion: current.row_version,
  });
  assert.equal(submitted.status, 'Under Review');

  let reviewedNa = domain.getAssessmentItems(db, workspaceId, assessment.id)
    .find(item => item.id === naItem.id);
  domain.acceptNotApplicable(db, {
    workspaceId,
    assessmentId: assessment.id,
    itemId: reviewedNa.id,
    actorId: approver,
    rowVersion: reviewedNa.row_version,
    note: 'I accept the documented rationale for this pinned workpaper version.',
  });
  let returned = domain.returnAssessment(db, {
    workspaceId,
    assessmentId: assessment.id,
    actorId: approver,
    rowVersion: submitted.row_version,
    note: 'Please strengthen and resubmit the Not Applicable rationale for independent approval.',
  });
  assert.equal(returned.status, 'In Progress');
  reviewedNa = domain.getAssessmentItems(db, workspaceId, assessment.id)
    .find(item => item.id === naItem.id);
  const revisedRationale = 'This revised rationale confirms, from the pinned applicability profile and documented processing scope, that no children or guardian processing occurs and explains why this conditional requirement is outside the assessment.';
  domain.updateAssessmentItem(db, {
    workspaceId,
    assessmentId: assessment.id,
    itemId: reviewedNa.id,
    actorId: creator,
    rowVersion: reviewedNa.row_version,
    status: 'Not Applicable',
    naRationale: revisedRationale,
  });
  current = domain.getAssessment(db, workspaceId, assessment.id);
  submitted = domain.submitAssessment(db, {
    workspaceId,
    assessmentId: assessment.id,
    actorId: creator,
    rowVersion: current.row_version,
  });
  assert.throws(() => domain.approveAssessment(db, {
    workspaceId,
    assessmentId: assessment.id,
    actorId: approver,
    rowVersion: submitted.row_version,
    note: 'I reviewed the resubmitted baseline and am testing the N/A acceptance gate.',
  }), expectCode('DPDPA_NA_ACCEPTANCE_REQUIRED'));

  reviewedNa = domain.getAssessmentItems(db, workspaceId, assessment.id)
    .find(item => item.id === naItem.id);
  domain.acceptNotApplicable(db, {
    workspaceId,
    assessmentId: assessment.id,
    itemId: reviewedNa.id,
    actorId: approver,
    rowVersion: reviewedNa.row_version,
    note: 'I accept the revised rationale after independently reviewing the scope.',
  });
  const approved = domain.approveAssessment(db, {
    workspaceId,
    assessmentId: assessment.id,
    actorId: approver,
    rowVersion: submitted.row_version,
    note: 'I approve this controlled baseline after independent review of all conclusions.',
  });
  assert.equal(approved.assessment.status, 'Approved');
  assert.equal(approved.projected_findings.length, 1);
  assert.match(approved.snapshot.snapshot_hash, /^[a-f0-9]{64}$/);
  const rawSnapshot = db.prepare('SELECT snapshot_json,snapshot_hash FROM dpdpa_gap_assessment_snapshots WHERE id=?')
    .get(approved.snapshot.id);
  assert.equal(crypto.createHash('sha256').update(rawSnapshot.snapshot_json).digest('hex'), rawSnapshot.snapshot_hash);
  const frozenFuture = approved.snapshot.snapshot_json.items.find(item => item.ref === 'TEST-FUTURE');
  assert.equal(frozenFuture.legal_effective_status, 'Future Effective');
  assert.equal(frozenFuture.findings.length, 1);
  assert.equal(frozenFuture.findings[0].remediation_actions[0].owner_user_id, clientOwner);

  const dashboard = domain.getDashboard(db, workspaceId, assessment.id);
  assert.equal(dashboard.currently_effective.total, 2);
  assert.equal(dashboard.future_effective.total, 1);
  assert.equal(dashboard.summary.evidence_current, 1);
  assert.equal(dashboard.summary.evidence_stale, 1);

  const catalogV2 = makeCatalog('test-2.0', '-V2');
  const seededV2 = domain.ensureFrameworkSeeded(db, catalogV2);
  const versions = db.prepare(`SELECT version,status,is_canonical FROM frameworks
    WHERE code='dpdpa' ORDER BY version`).all();
  assert.equal(seededV2.framework.version, 'test-2.0');
  assert.deepEqual(versions.map(row => [row.version, row.status, row.is_canonical]), [
    ['test-1.0', 'retired', 0],
    ['test-2.0', 'active', 1],
  ]);
});

test('workspace deletion cascades governed DPDPA workpapers while direct deletion remains blocked', () => {
  const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const manager = db.prepare("SELECT id FROM users WHERE firm_id=? AND firm_role='manager' ORDER BY id LIMIT 1")
    .get(firm.id);
  const workspaceId = insertWorkspace(firm.id, 'Cascade Test Client');
  const catalog = makeCatalog('cascade-1.0', '-C');
  const assessment = domain.createAssessment(db, {
    workspaceId,
    title: 'Cascade deletion assessment',
    scopeStatement: 'This assessment exists only to prove governed workspace deletion can cascade.',
    asOfDate: '2026-01-15',
    applicabilityProfile: profile(),
    createdBy: manager.id,
    catalog,
  });
  assert.throws(() => db.prepare('DELETE FROM dpdpa_gap_assessments WHERE workspace_id=? AND id=?')
    .run(workspaceId, assessment.id), /cannot be deleted/);
  deleteWorkspace(db, workspaceId);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dpdpa_gap_assessments WHERE workspace_id=?')
    .get(workspaceId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dpdpa_gap_assessment_items WHERE workspace_id=?')
    .get(workspaceId).c, 0);
});
