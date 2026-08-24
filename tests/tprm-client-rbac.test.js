'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rbac = require('../lib/rbac');

test('TPRM role bundles separate consultancy assurance from the client decision', () => {
  const consultant = rbac.rolePermissions('consultant');
  assert.ok(consultant.includes('tprm.assessment.review'));
  assert.ok(consultant.includes('tprm.recommendation.draft'));
  assert.ok(!consultant.includes('tprm.recommendation.issue'));
  assert.ok(!consultant.includes('tprm.client_decide'));
  assert.ok(!consultant.includes('tprm.client_risk_accept'));

  const senior = rbac.rolePermissions('senior_consultant');
  assert.ok(senior.includes('tprm.recommendation.issue'));
  assert.ok(!senior.includes('tprm.client_decide'));
  assert.ok(!senior.includes('tprm.client_risk_accept'));
  assert.ok(!senior.includes('supplier.risk_accept'), 'legacy risk override is Manager-only');
});

test('client sponsor decides and accepts risk while security reviewer can only review and comment', () => {
  const sponsor = rbac.rolePermissions('client_owner');
  assert.ok(sponsor.includes('tprm.client_portal.view'));
  assert.ok(sponsor.includes('tprm.client_comment'));
  assert.ok(sponsor.includes('tprm.client_decide'));
  assert.ok(sponsor.includes('tprm.client_risk_accept'));
  assert.ok(!sponsor.includes('tprm.recommendation.issue'));
  assert.ok(!sponsor.includes('supplier.approve'));

  const securityReviewer = rbac.rolePermissions('isms_manager');
  assert.ok(securityReviewer.includes('tprm.client_portal.view'));
  assert.ok(securityReviewer.includes('tprm.client_comment'));
  assert.ok(!securityReviewer.includes('tprm.client_decide'));
  assert.ok(!securityReviewer.includes('tprm.client_risk_accept'));
  assert.ok(!securityReviewer.includes('tprm.recommendation.issue'));
});

test('legacy supplier gates resolve only to safe consultancy-side compatibility aliases', () => {
  assert.ok(rbac.hasPermission(new Set(['tprm.third_party.manage']), 'supplier.manage'));
  assert.ok(rbac.hasPermission(new Set(['supplier.manage']), 'tprm.third_party.manage'));
  assert.ok(rbac.hasPermission(new Set(['tprm.recommendation.issue']), 'supplier.approve'));
  assert.ok(rbac.hasPermission(new Set(['tprm.assurance.export']), 'supplier.export'));
  assert.ok(!rbac.hasPermission(new Set(['tprm.client_risk_accept']), 'supplier.risk_accept'),
    'client risk acceptance must not unlock the legacy firm override endpoint');
});

