'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const views = path.join(__dirname, '..', 'views', 'partials');

function renderPartial(name, locals) {
  return ejs.renderFile(path.join(views, name), locals);
}

const firmUser = { user_type: 'firm', firm_role: 'manager' };
const rbac = { isManager: () => true };

test('gap-assessment-only navigation shows only the contracted assessment journey', async () => {
  const ws = {
    id: 41,
    frameworks: ['iso27001'],
    engagement_outcome: 'gap_assessment_only',
  };
  const html = await renderPartial('client_navigation.ejs', {
    ws,
    user: firmUser,
    rbac,
    active: '',
    openReviewCount: 0,
  });

  assert.match(html, /Assessment reporting/);
  assert.match(html, /Assessment reports/);
  assert.doesNotMatch(html, /href="\/workspaces\/41\/cert-cycle"/);
  for (const retainedRecord of ['Gap assessment', 'Control register', 'Evidence library', 'Assessment context']) {
    assert.match(html, new RegExp(retainedRecord), `${retainedRecord} should remain discoverable`);
  }
  for (const outOfScopeSurface of ['Certification readiness', 'Policy templates', 'Policy adoption', 'Management reviews', 'Internal audits', 'Nonconformities', 'Auditor access']) {
    assert.doesNotMatch(html, new RegExp(outOfScopeSurface), `${outOfScopeSurface} must not be presented as contracted gap-only work`);
  }
});

test('certification-support navigation remains unchanged', async () => {
  const ws = {
    id: 42,
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
  };
  const html = await renderPartial('client_navigation.ejs', {
    ws,
    user: firmUser,
    rbac,
    active: '',
    openReviewCount: 0,
  });

  assert.match(html, /Assurance &amp; certification/);
  assert.match(html, /Assurance &amp; reports/);
  assert.match(html, /href="\/workspaces\/42\/cert-cycle"/);
  assert.doesNotMatch(html, /Assessment reporting|Assessment reports/);
});

test('client portal describes gap-only findings as recommendations', async () => {
  const gapHtml = await renderPartial('client_portal_navigation.ejs', {
    ws: { id: 43, frameworks: ['iso27001'], engagement_outcome: 'gap_assessment_only' },
    portalView: 'findings',
    clientPreview: false,
  });
  const fullHtml = await renderPartial('client_portal_navigation.ejs', {
    ws: { id: 44, frameworks: ['iso27001'], engagement_outcome: 'certification_support' },
    portalView: 'findings',
    clientPreview: false,
  });

  assert.match(gapHtml, /Findings &amp; recommendations/);
  assert.doesNotMatch(gapHtml, /Findings &amp; remediation/);
  assert.match(fullHtml, /Findings &amp; remediation/);
  assert.doesNotMatch(fullHtml, /Findings &amp; recommendations/);
});

test('non-ISO programmes do not expose or materialise the ISO 27001 plan', async () => {
  for (const frameworks of [['csf'], ['iso42001']]) {
    const html = await renderPartial('client_navigation.ejs', {
      ws: { id: 45, frameworks, engagement_outcome: 'certification_support' },
      user: firmUser,
      rbac,
      active: '',
      openReviewCount: 0,
    });
    assert.doesNotMatch(html, /href="\/workspaces\/45\/engagement-plan"/);
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'engagement.js'), 'utf8');
  assert.match(source, /app\.use\('\/workspaces\/:wsId\/engagement-plan', requireAuth, requireWorkspace, requireIso27001Plan\)/);
});

test('certification-cycle routes enforce the contracted service path on the server', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'workspace-ops.js'), 'utf8');
  assert.match(source, /const requireCertificationSupport =/);
  const routeDefinitions = source.match(/app\.(?:get|post)\('\/workspaces\/:wsId\/cert-cycle[^\n]+/g) || [];
  assert.equal(routeDefinitions.length, 6);
  routeDefinitions.forEach(definition => assert.match(definition, /requireCertificationSupport/));
  assert.match(source, /outside this gap-assessment-only engagement/);
});

test('gap-only readiness links and direct server routes are both blocked', () => {
  const readiness = fs.readFileSync(path.join(__dirname, '..', 'routes', 'readiness.js'), 'utf8');
  for (const route of [
    /app\.get\('\/workspaces\/:wsId\/readiness', requireAuth, requireWorkspace, requireCertificationSupport/,
    /app\.get\('\/api\/workspaces\/:wsId\/readiness', requireAuth, requireWorkspace, requireCertificationSupport/,
    /app\.get\('\/workspaces\/:wsId\/readiness\/blockers', requireAuth, requireWorkspace, requireCertificationSupport/,
  ]) assert.match(readiness, route);
  assert.match(readiness, /Certification readiness is outside this gap-assessment-only engagement/);

  const engagementOps = fs.readFileSync(path.join(__dirname, '..', 'routes', 'engagement-ops.js'), 'utf8');
  assert.match(engagementOps, /app\.get\('\/workspaces\/:wsId\/export\/readiness-pack\.zip',[\s\S]{0,240}requirePermission\('workspace\.export'\)[\s\S]{0,120}requireReadinessService/);
  assert.match(engagementOps, /app\.get\('\/workspaces\/:wsId\/readiness\/auditor', requireAuth, requireWorkspace, requireReadinessService/);
  assert.match(engagementOps, /Certification readiness is outside this gap-assessment-only engagement/);
});

test('post-assessment contract surfaces have server-side outcome guards', () => {
  const guardedLine = (source, route, guard) => {
    const sourceRoute = route.replace(/\\/g, '\\\\');
    const start = source.indexOf(`'${sourceRoute}'`);
    assert.notEqual(start, -1, `missing route ${route}`);
    const callback = source.indexOf('=>', start);
    assert.notEqual(callback, -1, `missing callback for ${route}`);
    const declaration = source.slice(start, callback);
    assert.match(declaration, new RegExp(`\\b${guard}\\b`), `${route} must use ${guard}`);
  };

  const governance = fs.readFileSync(path.join(__dirname, '..', 'routes', 'governance.js'), 'utf8');
  for (const route of [
    '/workspaces/:wsId/audits', '/workspaces/:wsId/audits/:id',
    '/workspaces/:wsId/audits/:id/sampling', '/workspaces/:wsId/audits/:id/samples',
    '/workspaces/:wsId/audits/:id/samples/:sid/delete', '/workspaces/:wsId/audits/:id/lifecycle',
    '/workspaces/:wsId/audits/:id/findings', '/workspaces/:wsId/audits/:id/findings/:fId/promote',
    '/workspaces/:wsId/audits/:id/delete',
  ]) guardedLine(governance, route, 'requireInternalAuditService');
  for (const route of [
    '/workspaces/:wsId/mrms', '/workspaces/:wsId/mrms/:id/refresh-inputs',
    '/workspaces/:wsId/mrms/:id', '/workspaces/:wsId/mrms/:id/delete',
  ]) guardedLine(governance, route, 'requireManagementReviewService');

  const ops = fs.readFileSync(path.join(__dirname, '..', 'routes', 'engagement-ops.js'), 'utf8');
  for (const route of [
    '/workspaces/:wsId/audit-programme', '/workspaces/:wsId/audit-programme/:id',
    '/workspaces/:wsId/audits/:id/checklist-from-soa', '/workspaces/:wsId/audits/:id/checklist',
    '/workspaces/:wsId/audits/:id/observations', '/workspaces/:wsId/audits/observations/:obsId/close',
    '/workspaces/:wsId/audits/:id/checklist/clear', '/workspaces/:wsId/audits/observations/:obsId/reopen',
    '/workspaces/:wsId/audits/observations/:obsId/notes', '/workspaces/:wsId/audits/observations/:obsId/promote',
  ]) guardedLine(ops, route, 'requireInternalAuditService');
  guardedLine(ops, '/workspaces/:wsId/documents/:id/parent', 'requireDocumentImplementation');

  const exportsSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'exports.js'), 'utf8');
  for (const route of [
    '/workspaces/:wsId/audit-pack/zip', '/workspaces/:wsId/audit-pack',
    '/workspaces/:wsId/audit-pack/preview', '/workspaces/:wsId/audit-pack/pdf',
  ]) guardedLine(exportsSource, route, 'requireReadinessService');

  const auditor = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auditor.js'), 'utf8');
  for (const route of [
    '/auditor/:token', '/auditor/:token/soa', '/auditor/:token/soa/snapshots/:id(\\d+)',
    '/auditor/:token/risks', '/auditor/:token/evidence', '/auditor/:token/evidence/:id(\\d+)/download',
    '/auditor/:token/documents', '/auditor/:token/documents/:id(\\d+)', '/auditor/:token/audits',
    '/auditor/:token/audit-pack',
  ]) {
    const sourceRoute = route.replace(/\\/g, '\\\\');
    const line = auditor.split('\n').find(candidate => candidate.includes(`'${sourceRoute}'`));
    assert.ok(line, `missing route ${route}`);
    assert.match(line, /requireAuditorToken, requireAuditorService/);
  }
  for (const route of [
    '/workspaces/:wsId/auditor-access', '/workspaces/:wsId/auditor-access/:id(\\d+)/revoke',
  ]) guardedLine(auditor, route, 'requireAuditorService');

  const documents = fs.readFileSync(path.join(__dirname, '..', 'routes', 'documents.js'), 'utf8');
  for (const route of [
    '/workspaces/:wsId/templates', '/workspaces/:wsId/templates/:id(\\d+)',
    '/workspaces/:wsId/templates/adopt-mandatory', '/workspaces/:wsId/templates/:id(\\d+)/adopt',
    '/workspaces/:wsId/documents/from-template', '/workspaces/:wsId/documents/blank',
    '/workspaces/:wsId/documents/upload',
    '/workspaces/:wsId/documents/:id/delete', '/workspaces/:wsId/documents/:id/snooze-review',
    '/workspaces/:wsId/documents/:id/submit-review', '/workspaces/:wsId/documents/:id/decide',
    '/workspaces/:wsId/documents/:id/sign', '/workspaces/:wsId/documents/:id/publish',
    '/workspaces/:wsId/documents/:id/retire', '/workspaces/:wsId/documents/:id/new-version',
  ]) guardedLine(documents, route, 'requireDocumentImplementation');
  assert.match(documents, /app\.post\('\/workspaces\/:wsId\/documents\/:id', requireAuth, requireWorkspace, requireDocumentImplementation/);
  assert.match(documents, /app\.post\('\/workspaces\/:wsId\/documents\/:id\/external-approvers\/:eaId\/resend',[\s\S]*?requireWorkspace, requireDocumentImplementation/);
  assert.match(documents, /app\.post\('\/workspaces\/:wsId\/documents\/:id\/external-approvers\/:eaId\/revoke',[\s\S]*?requireWorkspace, requireDocumentImplementation/);
  assert.equal((documents.match(/if \(rejectGapOnlyExternalApproval\(res, row\)\)/g) || []).length, 2,
    'both external approval GET and POST must enforce the contract boundary');

  // Assessment-input reads and mappings intentionally remain available.
  for (const route of [
    '/workspaces/:wsId/documents', '/workspaces/:wsId/documents/:id/source',
    '/workspaces/:wsId/documents/:id/controls', '/workspaces/:wsId/controls/:isoId/documents',
  ]) {
    const sourceRoute = route.replace(/\\/g, '\\\\');
    const line = documents.split('\n').find(candidate => candidate.includes(`'${sourceRoute}'`));
    assert.ok(line, `missing retained route ${route}`);
    assert.doesNotMatch(line, /requireDocumentImplementation/);
  }
});

test('shared guard applies only to ISO 27001 gap-only workspaces', () => {
  const scope = require('../lib/engagement-outcome-scope');
  const guard = scope.requirePostGapService('Out of contract');
  const nextCalls = [];
  const next = () => nextCalls.push(true);
  const response = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    render(view, locals) { this.view = view; this.locals = locals; return this; },
    json(body) { this.body = body; return this; },
  });

  const gapRes = response();
  guard({ workspace: { frameworks: ['iso27001'], engagement_outcome: 'gap_assessment_only' }, path: '/audits' }, gapRes, next);
  assert.equal(gapRes.statusCode, 409);
  assert.equal(gapRes.locals.message, 'Out of contract');

  guard({ workspace: { frameworks: ['iso27001'], engagement_outcome: 'certification_support' }, path: '/audits' }, response(), next);
  guard({ workspace: { frameworks: ['csf'], engagement_outcome: 'gap_assessment_only' }, path: '/audits' }, response(), next);
  assert.equal(nextCalls.length, 2, 'full-support and non-ISO programmes keep existing access');

  const apiRes = response();
  guard({ workspace: { frameworks: ['iso27001'], engagement_outcome: 'gap_assessment_only' }, originalUrl: '/api/workspaces/1/readiness' }, apiRes, next);
  assert.equal(apiRes.statusCode, 409);
  assert.deepEqual(apiRes.body, { error: 'Out of contract' });
});
