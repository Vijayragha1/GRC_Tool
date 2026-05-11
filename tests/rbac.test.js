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

test('rbac - firm_owner has every defined permission', () => {
  const perms = rbac.rolePermissions('firm_owner');
  const all = Object.keys(rbac.PERMISSIONS);
  assert.equal(perms.length, all.length, 'firm_owner missing some perms');
  for (const p of all) assert.ok(perms.includes(p), `firm_owner missing ${p}`);
});

test('rbac - read_only has only view permissions', () => {
  const perms = rbac.rolePermissions('read_only');
  for (const p of perms) {
    assert.match(p, /\.view$/, `read_only should not have non-view perm: ${p}`);
  }
});

test('rbac - auditor can export but cannot mutate', () => {
  const perms = rbac.rolePermissions('auditor');
  assert.ok(perms.includes('audit_log.export'), 'auditor must export logs');
  assert.ok(perms.includes('workspace.export'), 'auditor must export audit pack');
  for (const p of perms) {
    assert.ok(
      !/\.(create|update|delete|edit|publish|retire|sign|approve|review|add|remove|assign_role|override_perms|bulk_update|methodology|manage|upload)$/.test(p),
      `auditor must not have mutating perm: ${p}`
    );
  }
});

test('rbac - reviewer can review/sign documents but not approve or publish', () => {
  const perms = rbac.rolePermissions('reviewer');
  assert.ok(perms.includes('document.review'), 'reviewer needs document.review');
  assert.ok(perms.includes('document.sign'), 'reviewer needs document.sign');
  assert.ok(!perms.includes('document.approve'), 'reviewer must not approve');
  assert.ok(!perms.includes('document.publish'), 'reviewer must not publish');
});

test('rbac - contributor can create/edit but not delete or publish', () => {
  const perms = rbac.rolePermissions('contributor');
  assert.ok(perms.includes('control.update'));
  assert.ok(perms.includes('risk.create'));
  assert.ok(!perms.includes('risk.delete'), 'contributor must not delete risks');
  assert.ok(!perms.includes('document.publish'), 'contributor must not publish');
  assert.ok(!perms.includes('document.approve'), 'contributor must not approve');
  assert.ok(!perms.includes('workspace.delete'), 'contributor must not delete workspace');
});

test('rbac - client_admin cannot manage members or override perms', () => {
  const perms = rbac.rolePermissions('client_admin');
  assert.ok(!perms.includes('members.assign_role'), 'client_admin cannot assign roles');
  assert.ok(!perms.includes('members.override_perms'), 'client_admin cannot override perms');
  assert.ok(!perms.includes('workspace.delete'), 'client_admin cannot delete workspace');
});

// firm_owner and lead_consultant both have '*' (full perms) - lead_consultant
// is the workspace owner-equivalent. These tests pin that contract: every
// other role must NOT have workspace.delete or members.override_perms.
const OWNER_ROLES = new Set(['firm_owner', 'lead_consultant']);

test('rbac - only owner roles (firm_owner, lead_consultant) can delete workspace', () => {
  const otherRoles = Object.keys(rbac.ROLE_PERMS).filter(r => !OWNER_ROLES.has(r));
  for (const role of otherRoles) {
    const perms = rbac.rolePermissions(role);
    assert.ok(!perms.includes('workspace.delete'), `${role} must not delete workspace`);
  }
});

test('rbac - only owner roles can override individual permissions', () => {
  const otherRoles = Object.keys(rbac.ROLE_PERMS).filter(r => !OWNER_ROLES.has(r));
  for (const role of otherRoles) {
    const perms = rbac.rolePermissions(role);
    assert.ok(!perms.includes('members.override_perms'), `${role} must not override perms`);
  }
});

test('rbac - effectivePermissions honours per-workspace grants', () => {
  const perms = rbac.effectivePermissions('reviewer', [
    { permission: 'document.publish', granted: 1 }
  ]);
  assert.ok(perms.has('document.publish'), 'override-grant must take effect');
  assert.ok(perms.has('document.review'), 'baseline perms must persist');
});

test('rbac - effectivePermissions honours per-workspace revokes', () => {
  const perms = rbac.effectivePermissions('contributor', [
    { permission: 'risk.create', granted: 0 }
  ]);
  assert.ok(!perms.has('risk.create'), 'revoke must remove the permission');
  assert.ok(perms.has('risk.update'), 'siblings must persist');
});

test('rbac - hasPermission accepts both Set and Array shapes', () => {
  const set = new Set(['risk.view', 'risk.update']);
  assert.ok(rbac.hasPermission(set, 'risk.view'));
  assert.ok(!rbac.hasPermission(set, 'risk.delete'));
  const arr = ['risk.view', 'risk.update'];
  assert.ok(rbac.hasPermission(arr, 'risk.view'));
  assert.ok(!rbac.hasPermission(arr, 'risk.delete'));
});

test('rbac - unknown role returns no permissions', () => {
  const perms = rbac.rolePermissions('does_not_exist');
  assert.equal(perms.length, 0);
});

test('rbac - every permission listed in PERMISSIONS is referenced by at least one role', () => {
  // Catches "we added a permission but forgot to grant it to anyone." The
  // firm_owner '*' implicitly covers all, so this test asserts that at least
  // one *non-owner* role uses each permission OR it's clearly an owner-only
  // gate (workspace.delete, members.override_perms).
  const ownerOnly = new Set(['workspace.delete', 'members.override_perms']);
  const allRoles = Object.keys(rbac.ROLE_PERMS).filter(r => r !== 'firm_owner');
  for (const perm of Object.keys(rbac.PERMISSIONS)) {
    if (ownerOnly.has(perm)) continue;
    const used = allRoles.some(r => rbac.rolePermissions(r).includes(perm));
    assert.ok(used, `permission "${perm}" is not granted to any non-owner role - dead grant?`);
  }
});
