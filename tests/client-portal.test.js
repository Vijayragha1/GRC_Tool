'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

let env;
let db;
let manager;
let contributor;
let clientOwner;
let workspaceId;
let otherWorkspaceId;
let contributorId;
let clientOwnerId;
let otherContributorId;
let managerId;
let requestId;
let policyId;

async function login(client, email, password) {
  const page = await client.get('/login');
  const token = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(token, 'login CSRF token should render');
  const result = await client.post('/login', { email, password, _csrf: token }, { csrf: false });
  assert.ok(result.status >= 300 && result.status < 400, `login failed with ${result.status}`);
  await client.get('/dashboard');
}

test.before(async () => {
  env = await bootClient();
  manager = env.client;
  db = new Database(env.dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId = db.prepare(`SELECT id FROM users WHERE email='sec-test@example.com'`).get().id;
  workspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, stage, locale) VALUES (?, 'Portal Client', 'gap_assessment', 'en-GB')`).run(firmId).lastInsertRowid);
  otherWorkspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, stage) VALUES (?, 'Other Client', 'gap_assessment')`).run(firmId).lastInsertRowid);
  const pw = bcrypt.hashSync('client-test-password-1234', 4);
  contributorId = Number(db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES ('portal-client@example.com',?,'Portal Contributor','client',1)`).run(pw).lastInsertRowid);
  otherContributorId = Number(db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES ('other-client@example.com',?,'Other Contributor','client',1)`).run(pw).lastInsertRowid);
  clientOwnerId = Number(db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES ('portal-owner@example.com',?,'Portal Sponsor','client',1)`).run(pw).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'contributor')`).run(workspaceId, contributorId);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'contributor')`).run(workspaceId, otherContributorId);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')`).run(workspaceId, clientOwnerId);
  policyId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,version,created_by)
    VALUES (?, 'Scoped Security Policy', 'Policy', '<h2>Safe heading</h2><script>window.portalPwned=1</script><p onclick="window.portalPwned=2">Policy body</p>', 'draft', 1, ?)`)
    .run(workspaceId, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO member_scopes (workspace_id,user_id,scope_type,scope_id,granted_by)
    VALUES (?,?,'document',?,?)`).run(workspaceId, contributorId, String(policyId), managerId);
  // Ensure the manager's account is the request creator expected by assertions.
  assert.ok(managerId);

  const page = await manager.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  const created = await manager.post(`/workspaces/${workspaceId}/client-portal/requests`, {
    request_type: 'control', title: 'Explain access review operation',
    description: 'Describe the quarterly process and attach a reviewed sample.',
    priority: 'high', assignee_id: String(contributorId), control_id: 'annex-a.5.18',
    due_date: '2026-09-01'
  });
  assert.equal(created.status, 302);
  requestId = Number((created.location.match(/\/requests\/(\d+)/) || [])[1]);
  assert.ok(requestId);

  contributor = makeClient(env.app);
  await login(contributor, 'portal-client@example.com', 'client-test-password-1234');
  clientOwner = makeClient(env.app);
  await login(clientOwner, 'portal-owner@example.com', 'client-test-password-1234');
});

test.after(async () => {
  if (db) db.close();
  if (contributor) await contributor.close();
  if (clientOwner) await clientOwner.close();
  if (manager) await manager.close();
});

test('request creation records scope, event history, and audit entry', () => {
  const request = db.prepare('SELECT * FROM client_requests WHERE id=? AND workspace_id=?').get(requestId, workspaceId);
  assert.equal(request.assignee_id, contributorId);
  assert.equal(request.control_id, 'annex-a.5.18');
  assert.equal(request.status, 'open');
  assert.ok(db.prepare(`SELECT 1 FROM member_scopes WHERE workspace_id=? AND user_id=? AND scope_type='control' AND scope_id='annex-a.5.18'`).get(workspaceId, contributorId));
  assert.ok(db.prepare(`SELECT 1 FROM client_request_events WHERE request_id=? AND event_type='created'`).get(requestId));
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND entity_type='client_request' AND entity_id=? AND action='create_client_request'`).get(workspaceId, String(requestId)));
});

test('consultant workspace navigation exposes the integrated overview and separates framework programmes without a duplicate audit-pack entry', async () => {
  const page = await manager.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/class="nav-domain-summary"/g) || []).length, 11);
  assert.match(page.text, /nav-item-text">Integrated overview/);
  assert.match(page.text, /ISO 27001 programme/);
  assert.match(page.text, /Cybersecurity maturity/);
  assert.match(page.text, /AI management system/);
  assert.doesNotMatch(page.text, /nav-item-text">Audit pack/);
});

test('consultants can open a read-only client-shell preview without impersonating a client', async () => {
  const preview = await manager.get(`/workspaces/${workspaceId}/client-portal?preview=client`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Client view preview/);
  assert.match(preview.text, /read-only and does not impersonate a client account/i);
  assert.match(preview.text, /Your engagement/);
  assert.match(preview.text, /Read-only client preview/);
  assert.match(preview.text, new RegExp(`/workspaces/${workspaceId}/engagement-plan[^>]*>Exit preview<`));
  assert.match(preview.text, /nav-item-text">Home/);
  assert.match(preview.text, new RegExp(`href="/workspaces/${workspaceId}/client-portal\\?view=progress&amp;preview=client#programme-iso27001"`));
  assert.match(preview.text, /id="programme-iso27001"/);
  assert.match(preview.text, /Search this engagement/);
  assert.doesNotMatch(preview.text, /Consultant view|Create a client request|title="Inbox"/);
  assert.doesNotMatch(preview.text, /action="[^\"]+"[^>]*method="POST"/i);
});

test('contributor is redirected from workspace root and blocked from legacy workspace routes', async () => {
  const root = await contributor.get(`/workspaces/${workspaceId}`);
  assert.equal(root.status, 302);
  assert.equal(root.location, `/workspaces/${workspaceId}/client-portal`);
  const legacy = await contributor.get(`/workspaces/${workspaceId}/controls`);
  assert.equal(legacy.status, 403);
  assert.match(legacy.text, /limited to the client portal/i);
});

test('client accounts never render the consulting firm dashboard after login', async () => {
  for (const client of [clientOwner, contributor]) {
    const dashboard = await client.get('/dashboard');
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.location, `/workspaces/${workspaceId}/client-portal`);
  }
});

test('client sponsor is portal-only despite seeing all shared client work', async () => {
  const root = await clientOwner.get(`/workspaces/${workspaceId}`);
  assert.equal(root.status, 302);
  assert.equal(root.location, `/workspaces/${workspaceId}/client-portal`);
  assert.equal((await clientOwner.get(`/workspaces/${workspaceId}/controls`)).status, 403);
  assert.equal((await clientOwner.get(`/workspaces/${workspaceId}/delivery`)).status, 403);
  assert.equal((await clientOwner.get(`/workspaces/${workspaceId}/members`)).status, 403);
  const portal = await clientOwner.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(portal.status, 200);
  assert.doesNotMatch(portal.text, /My action centre/);
  assert.match(portal.text, /client-portal\?view=actions/);
  assert.match(portal.text, /client-portal\?view=progress/);
  assert.match(portal.text, new RegExp(`href="/workspaces/${workspaceId}/client-portal\\?view=progress#programme-iso27001"`));
  assert.match(portal.text, /View programme/);
  assert.match(portal.text, /Explain access review operation/);
});

test('every client account receives the same restricted client workspace shell', async () => {
  for (const client of [clientOwner, contributor]) {
    const portal = await client.get(`/workspaces/${workspaceId}/client-portal`);
    assert.equal(portal.status, 200);

    for (const destination of ['Home', 'My actions', 'Progress', 'Findings &amp; remediation', 'Reports']) {
      assert.match(portal.text, new RegExp(`nav-item-text">${destination}`));
    }
    for (const section of ['engagement', 'requests', 'approvals', 'reports', 'team-help']) {
      assert.match(portal.text, new RegExp(`id="${section}"`));
    }

    assert.match(portal.text, /Client portal/);
    assert.match(portal.text, /Your engagement/);
    assert.match(portal.text, /Engagement progress/);
    assert.match(portal.text, /Reports and completed work/);
    assert.match(portal.text, /Your engagement contacts/);
    assert.match(portal.text, /Portal help/);
    assert.match(portal.text, /Search this engagement/);
    assert.match(portal.text, /class="palette-trigger"/);
    assert.doesNotMatch(portal.text, /Create a client request|Go to \(within a client\)|Search controls, risks, documents, clients/);

    for (const internalLabel of [
      'Integrated overview', 'ISO 27001 programme', 'Cybersecurity maturity',
      'AI management system', 'Plan &amp; work', 'Delivery cockpit', 'Settings',
      'All clients', 'Other Client'
    ]) {
      assert.doesNotMatch(portal.text, new RegExp(`nav-item-text">${internalLabel}`));
    }
    assert.doesNotMatch(portal.text, /title="Inbox"/);
  }
});

test('client search is restricted to client-visible engagement destinations', async () => {
  const actual = await clientOwner.get(`/api/search?wsId=${workspaceId}&q=report`);
  assert.equal(actual.status, 200);
  const actualResults = JSON.parse(actual.text);
  assert.ok(actualResults.length > 0);
  assert.ok(actualResults.every(result => result.href.startsWith(`/workspaces/${workspaceId}/client-portal?`)));
  assert.ok(actualResults.every(result => result.type === 'Page'));

  const preview = await manager.get(`/api/search?wsId=${workspaceId}&clientMode=1&q=progress`);
  assert.equal(preview.status, 200);
  const previewResults = JSON.parse(preview.text);
  assert.ok(previewResults.length > 0);
  assert.ok(previewResults.every(result => result.href.includes('preview=client')));
  assert.doesNotMatch(actual.text + preview.text, /\/risks\/|\/controls\/|\/documents\/|Other Client/);
});

test('ISO 27001 clients receive a governed five-stage gap-assessment journey without draft workpaper content', async () => {
  const requirementId = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code='iso27001' AND r.ref='annex-a.5.18'`).get().id;
  const engagementId = Number(db.prepare(`INSERT INTO consulting_engagements
    (workspace_id,engagement_code,name,engagement_type,framework_scope_json,scope_statement,status,created_by)
    VALUES (?,?,?,'gap_assessment','["iso27001"]','Portal assessment boundary','active',?)`)
    .run(workspaceId, `GA-PORTAL-${workspaceId}`, 'Portal gap assessment', managerId).lastInsertRowid);
  const workpaperId = Number(db.prepare(`INSERT INTO consultant_workpapers
    (workspace_id,engagement_id,requirement_id,workpaper_ref,title,procedure_performed,persons_interviewed,
     internal_notes,client_visible_summary,client_visible,owner_id,status,created_by)
    VALUES (?,?,?,?,?,'Secret raw procedure','Named Witness Secret','Secret internal note',?,1,?,'approved',?)`)
    .run(workspaceId, engagementId, requirementId, 'WP-PORTAL-001', 'Access review workpaper',
      'Confirmed information suitable for sharing', managerId, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO consulting_findings
    (workspace_id,engagement_id,workpaper_id,finding_ref,title,finding_type,severity,condition_text,criteria_text,
     effect_text,recommendation_text,internal_notes,client_visible,status,created_by)
    VALUES (?,?,?,?,?,'gap','high',?,?,?,?,?,1,'draft',?)`).run(
      workspaceId, engagementId, workpaperId, 'F-DRAFT-PORTAL', 'DO NOT SHOW DRAFT FINDING',
      'Hidden condition', 'Hidden criteria', 'Hidden risk', 'Hidden recommendation', 'Hidden assessor note', managerId);
  db.prepare(`INSERT INTO consulting_findings
    (workspace_id,engagement_id,workpaper_id,finding_ref,title,finding_type,severity,condition_text,criteria_text,
     effect_text,recommendation_text,client_visible,status,owner_id,due_date,created_by)
    VALUES (?,?,?,?,?,'gap','high',?,?,?,?,1,'confirmed',?,'2026-10-15',?)`).run(
      workspaceId, engagementId, workpaperId, 'F-SHARED-PORTAL', 'Shared confirmed gap',
      'Observed state shared', 'Expected requirement shared', 'Read-only risk rationale shared',
      'Recommended action shared', clientOwnerId, managerId);
  db.prepare(`UPDATE consulting_findings SET effort_estimate='5-8 person days',cost_estimate='GBP 8,000-12,000',
    retest_criteria='Re-perform the approved access-review sample with no unresolved exceptions.',
    closure_evidence_requirements='Approved review record and dated exception closures.'
    WHERE workspace_id=? AND finding_ref='F-SHARED-PORTAL'`).run(workspaceId);
  db.prepare(`INSERT INTO consulting_report_snapshots
    (workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,generated_by,published_by,published_at)
    VALUES (?,?,'assessment','Portal gap assessment report',1,'published','{}',?, ?, ?, datetime('now'))`)
    .run(workspaceId, engagementId, 'a'.repeat(64), managerId, managerId);

  const page = await clientOwner.get(`/workspaces/${workspaceId}/client-portal#gap-assessment`);
  assert.equal(page.status, 200);
  for (const heading of ['Mobilisation', 'Fieldwork', 'Validation', 'Report', 'Post-report']) {
    assert.match(page.text, new RegExp(`>${heading}<`));
  }
  assert.match(page.text, /Clause and Annex A boundary/);
  assert.match(page.text, /How each requirement is rated/);
  assert.match(page.text, /E1[\s\S]*Documented design[\s\S]*E2[\s\S]*Operating record[\s\S]*E3[\s\S]*Tested assurance/);
  assert.match(page.text, /RFI and document tracker/);
  assert.match(page.text, /Shared confirmed gap/);
  assert.match(page.text, /Observed state shared/);
  assert.match(page.text, /Read-only risk rationale shared/);
  assert.match(page.text, /5-8 person days/);
  assert.match(page.text, /GBP 8,000-12,000/);
  assert.doesNotMatch(page.text, /DO NOT SHOW DRAFT FINDING|Secret raw procedure|Named Witness Secret|Secret internal note|Hidden assessor note/);
});

test('fieldwork interviews use governed records, publish weekly snapshots, and never infer new task titles', async () => {
  const passId = Number(db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,status,started_by) VALUES (?,1,'Portal fieldwork','in_progress',?)`)
    .run(workspaceId, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO tasks (workspace_id,title,description,status,created_by)
    VALUES (?,'Ghost interview task','This ordinary task must not enter the interview schedule','done',?)`)
    .run(workspaceId, managerId);

  const managerPage = await manager.get(`/workspaces/${workspaceId}/gap-assessment/fieldwork`);
  assert.equal(managerPage.status, 200);
  assert.match(managerPage.text, /Structured interview records replace task-title inference/);
  assert.doesNotMatch(managerPage.text, /Ghost interview task/);

  const created = await manager.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/interviews`, {
    title: 'Risk ownership and operations interview',
    participant_role: 'Head of IT operations',
    objective: 'Confirm ownership, review cadence and retained operating evidence.',
    owner_id: String(managerId), scheduled_at: '2026-09-04T10:30', duration_minutes: '60', client_visible: '1'
  });
  assert.equal(created.status, 302);
  let interview = db.prepare(`SELECT * FROM gap_fieldwork_interviews
    WHERE workspace_id=? AND assessment_pass_id=? AND source_task_id IS NULL`).get(workspaceId, passId);
  assert.ok(interview);
  assert.equal(interview.status, 'scheduled');

  const completed = await manager.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/interviews/${interview.id}/status`, {
    row_version: String(interview.row_version), status: 'completed',
    completion_summary: 'Ownership and review cadence were confirmed; supporting records remain tracked through the RFI log.'
  });
  assert.equal(completed.status, 302);
  interview = db.prepare('SELECT * FROM gap_fieldwork_interviews WHERE id=?').get(interview.id);
  assert.equal(interview.status, 'completed');
  assert.ok(interview.completed_at);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND action='update_gap_interview' AND entity_id=?`)
    .get(workspaceId, String(interview.id)));

  const frozen = await manager.post(`/workspaces/${workspaceId}/gap-assessment/fieldwork/snapshots`, {
    week_ending: '2026-09-04'
  });
  assert.equal(frozen.status, 302);
  const snapshot = db.prepare(`SELECT * FROM gap_fieldwork_snapshots WHERE workspace_id=? AND assessment_pass_id=?`)
    .get(workspaceId, passId);
  assert.equal(snapshot.interviews_completed, 1);
  assert.equal(snapshot.interviews_planned, 1);
  assert.equal(snapshot.snapshot_hash.length, 64);

  const portal = await clientOwner.get(`/workspaces/${workspaceId}/client-portal#gap-fieldwork`);
  assert.equal(portal.status, 200);
  assert.match(portal.text, /Risk ownership and operations interview/);
  assert.match(portal.text, /Head of IT operations/);
  assert.match(portal.text, /Frozen fieldwork record/);
  assert.match(portal.text, /1\/1/);
  assert.doesNotMatch(portal.text, /Ghost interview task/);
});

test('contributor sees only assigned requests and can open its scoped control', async () => {
  const second = await manager.post(`/workspaces/${workspaceId}/client-portal/requests`, {
    request_type: 'action', title: 'Request belonging to someone else', priority: 'normal',
    assignee_id: String(otherContributorId), due_date: '2026-09-02'
  });
  assert.equal(second.status, 302);
  const page = await contributor.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Explain access review operation/);
  assert.doesNotMatch(page.text, /Request belonging to someone else/);
  assert.doesNotMatch(page.text, /Other Client/);
  assert.doesNotMatch(page.text, /nav-domain-summary/);
  const control = await contributor.get(`/workspaces/${workspaceId}/client-portal/controls/annex-a.5.18`);
  assert.equal(control.status, 200);
  assert.match(control.text, /Access rights/);
});

test('contributor cannot access a different workspace or another assignee request', async () => {
  const otherWs = await contributor.get(`/workspaces/${otherWorkspaceId}/client-portal`);
  assert.equal(otherWs.status, 403);
  const otherRequest = db.prepare('SELECT id FROM client_requests WHERE workspace_id=? AND assignee_id=?').get(workspaceId, otherContributorId);
  const detail = await contributor.get(`/workspaces/${workspaceId}/client-portal/requests/${otherRequest.id}`);
  assert.equal(detail.status, 404);
});

test('scoped policy review sanitizes stored HTML before rendering to clients', async () => {
  const page = await contributor.get(`/workspaces/${workspaceId}/client-portal/policies/${policyId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Safe heading/);
  assert.match(page.text, /Policy body/);
  assert.doesNotMatch(page.text, /window\.portalPwned/);
  const controlledBody = (page.text.match(/<article class="panel-pad doc-content"[^>]*>([\s\S]*?)<\/article>/) || [])[1];
  assert.ok(controlledBody, 'controlled policy body should render');
  assert.doesNotMatch(controlledBody, /onclick=/i);
});

test('request transition uses optimistic concurrency and appends an event', async () => {
  const detail = await contributor.get(`/workspaces/${workspaceId}/client-portal/requests/${requestId}`);
  assert.equal(detail.status, 200);
  const current = db.prepare('SELECT version FROM client_requests WHERE id=?').get(requestId).version;
  const transition = await contributor.post(`/workspaces/${workspaceId}/client-portal/requests/${requestId}/transition`, {
    status: 'in_progress', response_note: 'Reviewing the sample now.', version: String(current)
  });
  assert.equal(transition.status, 302);
  const updated = db.prepare('SELECT status, version FROM client_requests WHERE id=?').get(requestId);
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.version, current + 1);
  assert.ok(db.prepare(`SELECT 1 FROM client_request_events WHERE request_id=? AND event_type='status_changed' AND from_status='open' AND to_status='in_progress'`).get(requestId));

  const stale = await contributor.post(`/workspaces/${workspaceId}/client-portal/requests/${requestId}/transition`, {
    status: 'submitted', response_note: 'Stale browser submission.', version: String(current)
  });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /changed in another session/i);
});

test('client portal excludes unassigned delivery work and blocks evidence-free submission once assigned', async () => {
  assert.equal((await manager.get(`/workspaces/${workspaceId}/engagement-plan`)).status, 200);
  const rows = db.prepare(`SELECT d.id,d.title FROM engagement_delivery_deliverables d JOIN engagement_delivery_plans p ON p.id=d.plan_id WHERE p.workspace_id=? ORDER BY d.id LIMIT 2`).all(workspaceId);
  db.prepare(`UPDATE engagement_delivery_deliverables SET due_date='2020-08-20' WHERE id=?`).run(rows[0].id);
  const unassignedPage = await clientOwner.get(`/workspaces/${workspaceId}/client-portal?view=actions`);
  assert.match(unassignedPage.text, /Deliverables to provide[\s\S]*?<strong>0<\/strong>/);
  assert.match(unassignedPage.text, /Overdue items[\s\S]*?<strong>0<\/strong>/);
  assert.doesNotMatch(unassignedPage.text, /Kick-off records and role acknowledgements/);
  assert.doesNotMatch(unassignedPage.text, /20 Aug 2020/);
  db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1 WHERE id=?`).run(contributorId, managerId, rows[0].id);
  db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1 WHERE id=?`).run(otherContributorId, managerId, rows[1].id);
  const page = await contributor.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Deliverables and approvals/);
  assert.match(page.text, /Review what’s required, provide supporting evidence and track formal sign-off/);
  assert.doesNotMatch(page.text, /client-visible|factual validation|workspace verified|append-only|controlled deliverable|internal consultant|version-controlled/i);
  assert.match(page.text, /Kick-off records and role acknowledgements/);
  assert.doesNotMatch(page.text, /Completed engagement intake and draft scope statement/);
  assert.match(page.text, /Evidence required/);
  assert.match(page.text, /scope="col"/);
  assert.match(page.text, /role="progressbar"[\s\S]*?aria-valuenow="0"/);
  assert.match(page.text, /for="delivery-file-/);
  assert.match(page.text, /for="delivery-comment-/);
  assert.doesNotMatch(page.text, /onchange="this\.form\.submit\(\)"/);
  assert.match(page.text, /disabled aria-disabled="true" title="Upload evidence before submitting"/);

  const blocked = await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/submit`, { note: 'No evidence attached.' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.text, /Upload and link at least one evidence file/i);
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id).status, 'draft');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE workspace_id=? AND entity_type='engagement_deliverable' AND entity_id=? AND action='client_submit_delivery_deliverable'`).get(workspaceId, String(rows[0].id)).c, 0);

  const evidenceId = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?, 'client-evidence.pdf', 'test-client-evidence.pdf', 'client-evidence-sha', 128, ?, 'Client submission evidence')`)
    .run(workspaceId, contributorId).lastInsertRowid);
  db.prepare(`INSERT INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`)
    .run(workspaceId, rows[0].id, evidenceId, contributorId);

  const readyPage = await contributor.get(`/workspaces/${workspaceId}/client-portal`);
  const readyDeliverableRow = (readyPage.text.match(/<tr><td[^>]*><strong>Kick-off records and role acknowledgements<\/strong>[\s\S]*?<\/tr>/) || [])[0];
  assert.ok(readyDeliverableRow, 'the assigned deliverable row should render');
  assert.doesNotMatch(readyDeliverableRow, /disabled aria-disabled="true" title="Upload evidence before submitting"/);
  const submitted = await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/submit`, { note: 'Ready for formal review.' });
  assert.equal(submitted.status, 302);
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id).status, 'submitted');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND entity_type='engagement_deliverable' AND entity_id=? AND action='client_submit_delivery_deliverable'`).get(workspaceId, String(rows[0].id)));
  const underReviewPage = await contributor.get(`/workspaces/${workspaceId}/client-portal?view=actions`);
  assert.match(underReviewPage.text, /Deliverables to provide[\s\S]*?<strong>0<\/strong>/);
  assert.match(underReviewPage.text, /Awaiting review[\s\S]*?<strong>1<\/strong>/);
  assert.match(underReviewPage.text, /Overdue items[\s\S]*?<strong>0<\/strong>/);
  await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/accept`, { note: 'Owner must not self-approve.' });
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id).status, 'submitted', 'non-approver cannot accept');
  await manager.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/accept`, { note: 'Accepted against the linked evidence.' });
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id).status, 'accepted');
});

test('portal POST routes remain CSRF protected', async () => {
  const noCsrf = await contributor.post(`/workspaces/${workspaceId}/client-portal/requests/${requestId}/comments`,
    { body: 'This must be rejected.' }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM comments WHERE workspace_id=? AND parent_type='client_request' AND parent_id=?`).get(workspaceId, String(requestId)).c, 0);
});
