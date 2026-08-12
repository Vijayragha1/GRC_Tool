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
  workspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, stage) VALUES (?, 'Portal Client', 'gap_assessment')`).run(firmId).lastInsertRowid);
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

test('contributor is redirected from workspace root and blocked from legacy workspace routes', async () => {
  const root = await contributor.get(`/workspaces/${workspaceId}`);
  assert.equal(root.status, 302);
  assert.equal(root.location, `/workspaces/${workspaceId}/client-portal`);
  const legacy = await contributor.get(`/workspaces/${workspaceId}/controls`);
  assert.equal(legacy.status, 403);
  assert.match(legacy.text, /limited to the controlled collaboration portal/i);
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
  assert.match(portal.text, /My action centre/);
  assert.match(portal.text, /Explain access review operation/);
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

test('client portal exposes only assigned delivery work and permits owner submission', async () => {
  assert.equal((await manager.get(`/workspaces/${workspaceId}/engagement-plan`)).status, 200);
  const rows = db.prepare(`SELECT d.id,d.title FROM engagement_delivery_deliverables d JOIN engagement_delivery_plans p ON p.id=d.plan_id WHERE p.workspace_id=? ORDER BY d.id LIMIT 2`).all(workspaceId);
  db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1 WHERE id=?`).run(contributorId, managerId, rows[0].id);
  db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,client_visible=1 WHERE id=?`).run(otherContributorId, managerId, rows[1].id);
  const page = await contributor.get(`/workspaces/${workspaceId}/client-portal`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Engagement delivery/);
  assert.match(page.text, new RegExp(rows[0].title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(page.text, new RegExp(rows[1].title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const submitted = await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/submit`, { note: 'Ready for formal review.' });
  assert.equal(submitted.status, 302);
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id).status, 'submitted');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND entity_type='engagement_deliverable' AND entity_id=? AND action='client_submit_delivery_deliverable'`).get(workspaceId, String(rows[0].id)));
  await contributor.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/accept`, { note: 'Owner must not self-approve.' });
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id).status, 'submitted', 'non-approver cannot accept');
  await manager.post(`/workspaces/${workspaceId}/client-portal/deliverables/${rows[0].id}/accept`, { note: 'No evidence yet.' });
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(rows[0].id).status, 'submitted', 'assigned approver still needs evidence');
});

test('portal POST routes remain CSRF protected', async () => {
  const noCsrf = await contributor.post(`/workspaces/${workspaceId}/client-portal/requests/${requestId}/comments`,
    { body: 'This must be rejected.' }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM comments WHERE workspace_id=? AND parent_type='client_request' AND parent_id=?`).get(workspaceId, String(requestId)).c, 0);
});
