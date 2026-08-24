'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootApp, makeClient } = require('./helpers');

const PASSWORD = 'Boundary-test-password-1234';

async function login(client, email, password = PASSWORD) {
  const page = await client.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF token missing for ${email}`);
  const signedIn = await client.post('/login', { email, password, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302, signedIn.text.slice(0, 300));
  let warm = await client.get('/dashboard');
  if (warm.status === 302 && warm.location) warm = await client.get(warm.location);
  assert.equal(warm.status, 200, warm.text.slice(0, 300));
}

function insertUser(db, { email, name, role, type = 'firm', firmId = null }) {
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`)
    .run(email, bcrypt.hashSync(PASSWORD, 4), name, type, firmId, type === 'firm' ? role : null).lastInsertRowid);
}

function seedAuthorizationScenario(dbPath) {
  const db = new Database(dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const managerId = insertUser(db, { email: 'boundary-manager@test.local', name: 'Boundary Manager', role: 'manager', firmId });
  const seniorId = insertUser(db, { email: 'boundary-senior@test.local', name: 'Boundary Senior', role: 'senior_consultant', firmId });
  const consultantId = insertUser(db, { email: 'boundary-consultant@test.local', name: 'Boundary Consultant', role: 'consultant', firmId });
  const candidateId = insertUser(db, { email: 'boundary-candidate@test.local', name: 'Candidate Consultant', role: 'consultant', firmId });
  const removableId = insertUser(db, { email: 'boundary-removable@test.local', name: 'Removable Consultant', role: 'consultant', firmId });
  const clientId = insertUser(db, { email: 'boundary-client@test.local', name: 'Boundary Client', type: 'client', firmId });
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,scope,lead_consultant_id,frameworks)
    VALUES (?,'Boundary Workspace','Authorization regression scope',?,'["iso27001"]')`)
    .run(firmId, managerId).lastInsertRowid);
  const addMember = db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
  addMember.run(workspaceId, consultantId, 'consultant');
  const removableMemberId = Number(addMember.run(workspaceId, removableId, 'consultant').lastInsertRowid);
  addMember.run(workspaceId, clientId, 'client_owner');
  const inviteId = Number(db.prepare(`INSERT INTO user_invitations
    (email,name,firm_id,user_type,workspace_id,workspace_role,token_hash,expires_at,invited_by)
    VALUES ('pending-boundary@test.local','Pending Boundary',?,'client',?,'contributor',?,datetime('now','+1 day'),?)`)
    .run(firmId, workspaceId, crypto.randomBytes(32).toString('hex'), managerId).lastInsertRowid);
  db.close();
  return { firmId, managerId, seniorId, consultantId, candidateId, removableId, clientId, workspaceId, removableMemberId, inviteId };
}

test('AUTHZ-001/002/003 - tenant, firm-library and team mutations enforce their dedicated permissions', async (t) => {
  const { app, dbPath } = bootApp();
  const ids = seedAuthorizationScenario(dbPath);
  const manager = makeClient(app);
  const senior = makeClient(app);
  const consultant = makeClient(app);
  const client = makeClient(app);
  t.after(async () => { await Promise.all([manager.close(), senior.close(), consultant.close(), client.close()]); });
  await login(manager, 'boundary-manager@test.local');
  await login(senior, 'boundary-senior@test.local');
  await login(consultant, 'boundary-consultant@test.local');
  await login(client, 'boundary-client@test.local');

  const before = new Database(dbPath);
  const firmCount = before.prepare('SELECT COUNT(*) c FROM firms').get().c;
  const libraryCount = before.prepare('SELECT COUNT(*) c FROM firm_risk_library WHERE firm_id=?').get(ids.firmId).c;
  before.close();

  for (const [label, actor] of [['client', client], ['consultant', consultant]]) {
    const tenantAttempt = await actor.post('/tenants', { name: `${label} illicit tenant` });
    assert.equal(tenantAttempt.status, 403, `${label} must not create tenants`);
    const libraryAttempt = await actor.post('/firm/library/risks', {
      title: `${label} illicit library risk`, description: 'must not persist'
    });
    assert.equal(libraryAttempt.status, 403, `${label} must not mutate the firm library`);
  }

  const consultantTeamAttempts = [
    () => consultant.post(`/workspaces/${ids.workspaceId}/team/set-lead`, { lead_consultant_id: ids.candidateId }),
    () => consultant.post(`/workspaces/${ids.workspaceId}/team/add-firm-member`, { user_id: ids.candidateId, role: 'consultant' }),
    () => consultant.post(`/workspaces/${ids.workspaceId}/members/firm`, { user_id: ids.candidateId, role: 'consultant' }),
    () => consultant.post(`/workspaces/${ids.workspaceId}/team/remove-firm-member/${ids.removableMemberId}`, {}),
    () => consultant.post(`/workspaces/${ids.workspaceId}/team/invite-client`, { email: 'illicit-invite@test.local', name: 'Illicit Invite', workspace_role: 'contributor' }),
    () => consultant.post(`/workspaces/${ids.workspaceId}/team/revoke-invite/${ids.inviteId}`, {}),
    () => consultant.post(`/workspaces/${ids.workspaceId}/update`, {
      client_name: 'Boundary Workspace', scope: 'Authorization regression scope', stage: 'gap_assessment',
      lead_consultant_id: ids.candidateId
    })
  ];
  for (let index = 0; index < consultantTeamAttempts.length; index++) {
    const result = await consultantTeamAttempts[index]();
    assert.equal(result.status, 403, `consultant team mutation ${index + 1} must be denied`);
  }

  // A senior consultant has the explicit member-role permission, so the same
  // lead assignment succeeds without turning the gate into a blanket deny.
  const seniorLead = await senior.post(`/workspaces/${ids.workspaceId}/team/set-lead`, { lead_consultant_id: ids.seniorId });
  assert.equal(seniorLead.status, 302);
  const seniorLibrary = await senior.post('/firm/library/risks', { title: 'Senior governed library risk' });
  assert.equal(seniorLibrary.status, 302);
  const managerTenant = await manager.post('/tenants', { name: 'Manager-created tenant' });
  assert.equal(managerTenant.status, 302);

  const verify = new Database(dbPath);
  assert.equal(verify.prepare('SELECT COUNT(*) c FROM firms').get().c, firmCount + 1);
  assert.equal(verify.prepare(`SELECT COUNT(*) c FROM firm_risk_library
    WHERE firm_id=? AND title LIKE '%illicit library risk'`).get(ids.firmId).c, 0);
  assert.equal(verify.prepare('SELECT COUNT(*) c FROM firm_risk_library WHERE firm_id=?').get(ids.firmId).c, libraryCount + 1);
  assert.equal(verify.prepare('SELECT lead_consultant_id FROM workspaces WHERE id=?').get(ids.workspaceId).lead_consultant_id, ids.seniorId);
  assert.equal(verify.prepare('SELECT COUNT(*) c FROM workspace_members WHERE workspace_id=? AND user_id=?').get(ids.workspaceId, ids.candidateId).c, 0);
  assert.equal(verify.prepare('SELECT COUNT(*) c FROM workspace_members WHERE id=?').get(ids.removableMemberId).c, 1);
  assert.equal(verify.prepare(`SELECT COUNT(*) c FROM user_invitations WHERE email='illicit-invite@test.local'`).get().c, 0);
  assert.equal(verify.prepare('SELECT revoked_at FROM user_invitations WHERE id=?').get(ids.inviteId).revoked_at, null);
  verify.close();

  // Adjacent hardening: an explicitly delegated add-only user still cannot
  // smuggle client_owner through the CSV path, and role assignment cannot pull
  // a user from another tenant or an unrelated client population.
  const hardening = new Database(dbPath);
  hardening.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?, 'members.add',1,?,'Regression test: add without assign')`)
    .run(ids.workspaceId, ids.consultantId, ids.managerId);
  const foreignFirmId = Number(hardening.prepare(`INSERT INTO firms (name) VALUES ('Foreign Boundary Firm')`).run().lastInsertRowid);
  const foreignUserId = insertUser(hardening, {
    email: 'foreign-boundary@test.local', name: 'Foreign Boundary', role: 'consultant', firmId: foreignFirmId
  });
  const unscopedClientId = insertUser(hardening, {
    email: 'unscoped-boundary@test.local', name: 'Unscoped Boundary', type: 'client', firmId: ids.firmId
  });
  hardening.close();

  const elevatedBulk = await consultant.post(`/workspaces/${ids.workspaceId}/members/bulk`, {
    csv: 'Injected Owner,injected-owner@test.local,client_owner'
  });
  assert.equal(elevatedBulk.status, 403);
  const basicBulk = await consultant.post(`/workspaces/${ids.workspaceId}/members/bulk`, {
    csv: 'Basic Contributor,basic-contributor@test.local,contributor'
  });
  assert.equal(basicBulk.status, 302);
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/access/role`, {
    user_id: foreignUserId, role: 'consultant'
  })).status, 403);
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/access/role`, {
    user_id: unscopedClientId, role: 'client_owner'
  })).status, 403);
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/access/role`, {
    user_id: ids.candidateId, role: 'consultant'
  })).status, 302);

  const hardenedVerify = new Database(dbPath);
  assert.equal(hardenedVerify.prepare(`SELECT COUNT(*) c FROM users WHERE email='injected-owner@test.local'`).get().c, 0);
  assert.equal(hardenedVerify.prepare(`SELECT wm.role FROM workspace_members wm
    INNER JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? AND u.email='basic-contributor@test.local'`).get(ids.workspaceId).role, 'contributor');
  assert.equal(hardenedVerify.prepare(`SELECT COUNT(*) c FROM workspace_members
    WHERE workspace_id=? AND user_id IN (?,?)`).get(ids.workspaceId, foreignUserId, unscopedClientId).c, 0);
  assert.equal(hardenedVerify.prepare(`SELECT role FROM workspace_members
    WHERE workspace_id=? AND user_id=?`).get(ids.workspaceId, ids.candidateId).role, 'consultant');
  hardenedVerify.close();
});

test('AUTHZ-004 - auditor credentials are Manager-only, hashed at rest, shown once, and document output is governed', async (t) => {
  const { app, dbPath } = bootApp();
  const ids = seedAuthorizationScenario(dbPath);
  const manager = makeClient(app);
  const senior = makeClient(app);
  const consultant = makeClient(app);
  t.after(async () => { await Promise.all([manager.close(), senior.close(), consultant.close()]); });
  await login(manager, 'boundary-manager@test.local');
  await login(senior, 'boundary-senior@test.local');
  await login(consultant, 'boundary-consultant@test.local');

  assert.equal((await consultant.get(`/workspaces/${ids.workspaceId}/auditor-access`)).status, 200);
  assert.equal((await consultant.post(`/workspaces/${ids.workspaceId}/auditor-access`, { label: 'Illicit consultant link' })).status, 403);
  assert.equal((await senior.post(`/workspaces/${ids.workspaceId}/auditor-access`, { label: 'Illicit senior link' })).status, 403);

  const created = await manager.post(`/workspaces/${ids.workspaceId}/auditor-access`, {
    label: 'Stage 2 auditor', expires_days: '30'
  });
  assert.equal(created.status, 200, created.text.slice(0, 500));
  const raw = (created.text.match(/\/auditor\/([A-Za-z0-9_-]{32})/) || [])[1];
  assert.ok(raw, 'new raw auditor credential must be revealed in the create response');

  const db = new Database(dbPath);
  const share = db.prepare(`SELECT id,token,token_hash,token_last4 FROM auditor_shares
    WHERE workspace_id=? AND label='Stage 2 auditor'`).get(ids.workspaceId);
  assert.equal(share.token_hash, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(share.token_last4, raw.slice(-4));
  assert.notEqual(share.token, raw, 'raw auditor credential must not be stored');
  const approvedDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,content,status,created_by,approved_by,approved_at)
    VALUES (?,'Approved security policy','<p>SAFE-AUDITOR-CONTENT</p><script>window.XSSCANARY=1</script>','approved',?,?,CURRENT_TIMESTAMP)`)
    .run(ids.workspaceId, ids.managerId, ids.managerId).lastInsertRowid);
  const draftDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,content,status,created_by)
    VALUES (?,'Draft secret policy','DRAFT-SECRET-CONTENT','draft',?)`)
    .run(ids.workspaceId, ids.managerId).lastInsertRowid);
  const legacyRaw = 'LegacyAuditorCredential_1234567890';
  const legacyShareId = Number(db.prepare(`INSERT INTO auditor_shares
    (workspace_id,token,label,expires_at,created_by)
    VALUES (?,?, 'Legacy rolling-upgrade link',?,?)`)
    .run(ids.workspaceId, legacyRaw, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), ids.managerId).lastInsertRowid);
  db.close();

  const laterConsole = await manager.get(`/workspaces/${ids.workspaceId}/auditor-access`);
  assert.equal(laterConsole.status, 200);
  assert.ok(!laterConsole.text.includes(raw), 'raw link must not be recoverable after the create response');
  const auditor = makeClient(app);
  t.after(() => auditor.close());
  assert.equal((await auditor.get(`/auditor/${raw}`)).status, 200);
  assert.equal((await auditor.get(`/auditor/${legacyRaw}`)).status, 200, 'legacy raw token must survive a rolling upgrade');
  const legacyVerify = new Database(dbPath);
  const upgradedLegacy = legacyVerify.prepare(`SELECT token,token_hash,token_last4
    FROM auditor_shares WHERE id=?`).get(legacyShareId);
  assert.notEqual(upgradedLegacy.token, legacyRaw, 'lazy migration must scrub the legacy raw token');
  assert.equal(upgradedLegacy.token_hash, crypto.createHash('sha256').update(legacyRaw).digest('hex'));
  assert.equal(upgradedLegacy.token_last4, legacyRaw.slice(-4));
  legacyVerify.close();
  const documents = await auditor.get(`/auditor/${raw}/documents`);
  assert.equal(documents.status, 200);
  assert.match(documents.text, /Approved security policy/);
  assert.doesNotMatch(documents.text, /Draft secret policy|DRAFT-SECRET-CONTENT/);
  const detail = await auditor.get(`/auditor/${raw}/documents/${approvedDocId}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /SAFE-AUDITOR-CONTENT/);
  assert.doesNotMatch(detail.text, /XSSCANARY|<script[^>]*>\s*window\./i);
  assert.equal((await auditor.get(`/auditor/${raw}/documents/${draftDocId}`)).status, 404);

  assert.equal((await consultant.post(`/workspaces/${ids.workspaceId}/auditor-access/${share.id}/revoke`, {})).status, 403);
  assert.equal((await manager.post(`/workspaces/${ids.workspaceId}/auditor-access/${share.id}/revoke`, {})).status, 302);
  assert.equal((await auditor.get(`/auditor/${raw}`)).status, 403);
});

test('SESS-001 - password reset revokes every prior session and new logins bind to the incremented epoch', async (t) => {
  const { app, dbPath } = bootApp();
  const db = new Database(dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const resetUserId = insertUser(db, { email: 'reset-boundary@test.local', name: 'Reset Boundary', role: 'consultant', firmId });
  insertUser(db, { email: 'unrelated-session@test.local', name: 'Unrelated Session', role: 'manager', firmId });
  db.close();

  const oldA = makeClient(app);
  const oldB = makeClient(app);
  const unrelated = makeClient(app);
  const resetClient = makeClient(app);
  t.after(async () => { await Promise.all([oldA.close(), oldB.close(), unrelated.close(), resetClient.close()]); });
  await login(oldA, 'reset-boundary@test.local');
  await login(oldB, 'reset-boundary@test.local');
  await login(unrelated, 'unrelated-session@test.local');

  const rawReset = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawReset).digest('hex');
  const issue = new Database(dbPath);
  issue.prepare(`INSERT INTO password_reset_tokens (user_id,token_hash,expires_at)
    VALUES (?,?,?)`).run(resetUserId, tokenHash, new Date(Date.now() + 60 * 60 * 1000).toISOString());
  issue.close();

  const resetPage = await resetClient.get(`/reset/${rawReset}`);
  assert.equal(resetPage.status, 200);
  const csrf = (resetPage.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf);
  const changed = await resetClient.post(`/reset/${rawReset}`, {
    password: 'Replacement-password-5678', password2: 'Replacement-password-5678', _csrf: csrf
  }, { csrf: false });
  assert.equal(changed.status, 302, changed.text.slice(0, 300));
  assert.equal((await resetClient.get('/dashboard')).status, 200, 'resetting browser receives the new epoch session');
  assert.equal((await oldA.get('/dashboard')).status, 302, 'first old session must be revoked');
  assert.equal((await oldB.get('/dashboard')).status, 302, 'second old session must be revoked');
  assert.equal((await unrelated.get('/dashboard')).status, 200, 'revocation must not affect a different user');

  const verify = new Database(dbPath);
  assert.equal(verify.prepare('SELECT auth_epoch FROM users WHERE id=?').get(resetUserId).auth_epoch, 1);
  assert.equal(verify.prepare(`SELECT COUNT(*) c FROM sessions
    WHERE CAST(json_extract(sess,'$.userId') AS INTEGER)=?`).get(resetUserId).c, 1,
    'only the post-reset session should remain');
  verify.close();

  const cleanLogin = makeClient(app);
  const oldPassword = makeClient(app);
  t.after(async () => { await Promise.all([cleanLogin.close(), oldPassword.close()]); });
  await login(cleanLogin, 'reset-boundary@test.local', 'Replacement-password-5678');
  const oldLoginPage = await oldPassword.get('/login');
  const oldCsrf = (oldLoginPage.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const rejected = await oldPassword.post('/login', {
    email: 'reset-boundary@test.local', password: PASSWORD, _csrf: oldCsrf
  }, { csrf: false });
  assert.equal(rejected.status, 401);
});
