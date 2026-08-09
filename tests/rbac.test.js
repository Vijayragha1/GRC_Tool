// Permission matrix tests for lib/rbac.js. Pure unit tests - no server boot.
//
// Run: node --test tests/rbac.test.js
//
// What this catches: an accidental permission grant or revoke in the role
// table reaches production. The role bundles are the load-bearing security
// posture for any future multi-user deployment, so they need pinning even
// while auth is disabled.

const test = require('node:test');
const assert = require('node:assert/strict');
const rbac = require('../lib/rbac');

test('rbac - manager has every defined permission', () => {
  const perms = rbac.rolePermissions('manager');
  const all = Object.keys(rbac.PERMISSIONS);
  assert.equal(perms.length, all.length, 'manager missing some perms');
  for (const p of all) assert.ok(perms.includes(p), `manager missing ${p}`);
});

test('rbac - senior_consultant has broad perms but not firm.manage, firm.users.manage, workspace.delete, or document.approve', () => {
  const perms = rbac.rolePermissions('senior_consultant');
  // Should have document.review but NOT document.approve
  assert.ok(perms.includes('document.review'), 'senior_consultant needs document.review');
  assert.ok(!perms.includes('document.approve'), 'senior_consultant must not approve documents');
  // Should not have firm-admin or destructive workspace perms
  assert.ok(!perms.includes('firm.manage'), 'senior_consultant must not manage firm');
  assert.ok(!perms.includes('firm.users.manage'), 'senior_consultant must not manage firm users');
  assert.ok(!perms.includes('workspace.delete'), 'senior_consultant must not delete workspace');
  // Should have workspace.create, members.override_perms, assessment.signoff
  assert.ok(perms.includes('workspace.create'), 'senior_consultant needs workspace.create');
  assert.ok(perms.includes('members.override_perms'), 'senior_consultant needs members.override_perms');
  assert.ok(perms.includes('assessment.signoff'), 'senior_consultant needs assessment.signoff');
});

test('rbac - consultant has working-level perms but no member management or document lifecycle', () => {
  const perms = rbac.rolePermissions('consultant');
  assert.ok(perms.includes('control.view'));
  assert.ok(perms.includes('control.update'));
  assert.ok(perms.includes('risk.create'));
  assert.ok(perms.includes('document.create'));
  assert.ok(perms.includes('document.edit'));
  assert.ok(perms.includes('document.submit_review'));
  // Should NOT have review/approve/publish/retire/sign
  assert.ok(!perms.includes('document.review'), 'consultant must not review documents');
  assert.ok(!perms.includes('document.approve'), 'consultant must not approve documents');
  assert.ok(!perms.includes('document.publish'), 'consultant must not publish documents');
  assert.ok(!perms.includes('document.retire'), 'consultant must not retire documents');
  assert.ok(!perms.includes('document.sign'), 'consultant must not sign documents');
  // Should NOT have member management
  assert.ok(!perms.includes('members.add'), 'consultant must not add members');
  assert.ok(!perms.includes('members.remove'), 'consultant must not remove members');
  assert.ok(!perms.includes('members.assign_role'), 'consultant must not assign roles');
  assert.ok(!perms.includes('members.override_perms'), 'consultant must not override perms');
  // Should NOT delete workspace
  assert.ok(!perms.includes('workspace.delete'), 'consultant must not delete workspace');
});

test('rbac - client_owner is a portal sponsor, never a workspace administrator', () => {
  const perms = rbac.rolePermissions('client_owner');
  assert.ok(perms.includes('client_portal.view'));
  assert.ok(perms.includes('client_request.manage'));
  assert.ok(perms.includes('client_request.respond'));
  assert.ok(perms.includes('document.approve'), 'client_owner needs document.approve');
  assert.ok(perms.includes('document.sign'), 'client_owner needs document.sign');
  assert.ok(!perms.includes('workspace.delete'));
  assert.ok(!perms.includes('workspace.update'));
  assert.ok(!perms.includes('workspace.users.manage'));
  assert.ok(!perms.includes('members.assign_role'));
  assert.ok(!perms.includes('members.override_perms'));
  assert.ok(!perms.includes('document.publish'));
  assert.ok(!perms.includes('firm.manage'), 'client_owner must not manage firm');
  assert.ok(!perms.includes('firm.users.manage'), 'client_owner must not manage firm users');
  assert.ok(!perms.includes('workspace.create'), 'client_owner must not create workspaces');
});

test('rbac - isms_manager coordinates the portal without operator access', () => {
  const perms = rbac.rolePermissions('isms_manager');
  assert.ok(perms.includes('document.approve'), 'isms_manager needs document.approve');
  assert.ok(perms.includes('document.review'), 'isms_manager needs document.review');
  assert.ok(perms.includes('document.sign'), 'isms_manager needs document.sign');
  assert.ok(perms.includes('client_request.manage'));
  assert.ok(!perms.includes('document.publish'));
  assert.ok(!perms.includes('workspace.delete'), 'isms_manager must not delete workspace');
  assert.ok(!perms.includes('workspace.update'), 'isms_manager must not update workspace');
  assert.ok(!perms.includes('members.assign_role'), 'isms_manager must not assign roles');
  assert.ok(!perms.includes('members.override_perms'), 'isms_manager must not override perms');
  assert.ok(!perms.includes('workspace.create'), 'isms_manager must not create workspaces');
});

test('rbac - contributor has the narrowest perm set', () => {
  const perms = rbac.rolePermissions('contributor');
  assert.deepEqual(perms, ['client_portal.view','client_request.respond','evidence.upload','comment.create']);
  assert.ok(perms.includes('evidence.upload'));
  assert.ok(perms.includes('comment.create'));
  // Should NOT have destructive/elevated perms
  assert.ok(!perms.includes('risk.create'), 'contributor must not create risks');
  assert.ok(!perms.includes('risk.delete'), 'contributor must not delete risks');
  assert.ok(!perms.includes('document.review'), 'contributor must not review documents');
  assert.ok(!perms.includes('document.approve'), 'contributor must not approve documents');
  assert.ok(!perms.includes('document.publish'), 'contributor must not publish documents');
  assert.ok(!perms.includes('workspace.delete'), 'contributor must not delete workspace');
  assert.ok(!perms.includes('workspace.create'), 'contributor must not create workspaces');
  assert.ok(!perms.includes('members.assign_role'), 'contributor must not assign roles');
  assert.ok(!perms.includes('members.override_perms'), 'contributor must not override perms');
});

test('rbac - role aliases resolve correctly', () => {
  // firm_owner -> manager (gets all perms)
  assert.equal(rbac.normalizeRole('firm_owner'), 'manager');
  const fOwnerPerms = rbac.rolePermissions('firm_owner');
  assert.equal(fOwnerPerms.length, Object.keys(rbac.PERMISSIONS).length, 'firm_owner alias must resolve to manager (all perms)');

  // lead_consultant -> senior_consultant
  assert.equal(rbac.normalizeRole('lead_consultant'), 'senior_consultant');
  const lcPerms = rbac.rolePermissions('lead_consultant');
  const scPerms = rbac.rolePermissions('senior_consultant');
  assert.deepEqual(lcPerms, scPerms, 'lead_consultant alias must resolve to senior_consultant');

  // client_admin -> client_owner
  assert.equal(rbac.normalizeRole('client_admin'), 'client_owner');
  const caPerms = rbac.rolePermissions('client_admin');
  const coPerms = rbac.rolePermissions('client_owner');
  assert.deepEqual(caPerms, coPerms, 'client_admin alias must resolve to client_owner');

  // Dropped roles -> contributor
  for (const old of ['reviewer', 'auditor', 'read_only']) {
    assert.equal(rbac.normalizeRole(old), 'contributor', `${old} must alias to contributor`);
    const oldPerms = rbac.rolePermissions(old);
    const contribPerms = rbac.rolePermissions('contributor');
    assert.deepEqual(oldPerms, contribPerms, `${old} alias must resolve to contributor perms`);
  }
});

// Client accounts never own the consulting firm's workspace.
const WORKSPACE_DELETE_ROLES = new Set(['manager']);

test('rbac - only manager can delete workspace', () => {
  const otherRoles = Object.keys(rbac.ROLE_PERMS).filter(r => !WORKSPACE_DELETE_ROLES.has(r));
  for (const role of otherRoles) {
    const perms = rbac.rolePermissions(role);
    assert.ok(!perms.includes('workspace.delete'), `${role} must not delete workspace`);
  }
});

const OVERRIDE_PERMS_ROLES = new Set(['manager', 'senior_consultant']);

test('rbac - only manager and senior_consultant can override individual permissions', () => {
  const otherRoles = Object.keys(rbac.ROLE_PERMS).filter(r => !OVERRIDE_PERMS_ROLES.has(r));
  for (const role of otherRoles) {
    const perms = rbac.rolePermissions(role);
    assert.ok(!perms.includes('members.override_perms'), `${role} must not override perms`);
  }
});

test('rbac - effectivePermissions honours per-workspace grants', () => {
  const perms = rbac.effectivePermissions('contributor', [
    { permission: 'document.publish', granted: 1 }
  ]);
  assert.ok(perms.has('document.publish'), 'override-grant must take effect');
  assert.ok(perms.has('client_portal.view'), 'baseline perms must persist');
});

test('rbac - effectivePermissions honours per-workspace revokes', () => {
  const perms = rbac.effectivePermissions('contributor', [
    { permission: 'client_request.respond', granted: 0 }
  ]);
  assert.ok(!perms.has('client_request.respond'), 'revoke must remove the permission');
  assert.ok(perms.has('evidence.upload'), 'siblings must persist');
});

test('rbac - hasPermission accepts both Set and Array shapes', () => {
  const set = new Set(['risk.view', 'risk.update']);
  assert.ok(rbac.hasPermission(set, 'risk.view'));
  assert.ok(!rbac.hasPermission(set, 'risk.delete'));
  const arr = ['risk.view', 'risk.update'];
  assert.ok(rbac.hasPermission(arr, 'risk.view'));
  assert.ok(!rbac.hasPermission(arr, 'risk.delete'));
});

test('rbac - isManager returns true for manager and its alias firm_owner', () => {
  assert.ok(rbac.isManager('manager'));
  assert.ok(rbac.isManager('firm_owner'), 'firm_owner alias must resolve to manager');
  // No other role should be manager
  assert.ok(!rbac.isManager('senior_consultant'));
  assert.ok(!rbac.isManager('lead_consultant'));
  assert.ok(!rbac.isManager('consultant'));
  assert.ok(!rbac.isManager('client_owner'));
  assert.ok(!rbac.isManager('client_admin'));
  assert.ok(!rbac.isManager('isms_manager'));
  assert.ok(!rbac.isManager('contributor'));
});

test('rbac - unknown role returns no permissions', () => {
  const perms = rbac.rolePermissions('does_not_exist');
  assert.equal(perms.length, 0);
});

test('rbac - every permission listed in PERMISSIONS is referenced by at least one role', () => {
  // Catches "we added a permission but forgot to grant it to anyone." The
  // manager '*' implicitly covers all, so this test asserts that at least
  // one *non-manager* role uses each permission OR it's clearly a restricted
  // gate (firm.manage, firm.users.manage are manager-only).
  const managerOnly = new Set(['firm.manage', 'firm.users.manage', 'workspace.delete', 'report.approve']);
  const allRoles = Object.keys(rbac.ROLE_PERMS).filter(r => r !== 'manager');
  for (const perm of Object.keys(rbac.PERMISSIONS)) {
    if (managerOnly.has(perm)) continue;
    const used = allRoles.some(r => rbac.rolePermissions(r).includes(perm));
    assert.ok(used, `permission "${perm}" is not granted to any non-manager role - dead grant?`);
  }
});
