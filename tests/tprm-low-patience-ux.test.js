'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('TPRM templates compile after the low-patience copy and action sweep', () => {
  [
    'views/tprm_new_third_party.ejs',
    'views/tprm_firm_portfolio.ejs',
    'views/tprm_third_parties.ejs',
    'views/tprm_relationships.ejs',
    'views/tprm_findings.ejs',
    'views/tprm_reports.ejs',
    'views/partials/tprm_recommendation_workflow.ejs',
    'views/tprm_assurance.ejs',
    'views/tprm_third_party.ejs',
    'views/client_tprm_portfolio.ejs',
    'views/tprm_relationship_detail.ejs',
    'views/tprm_connector_settings.ejs',
    'views/supplier_due_diligence.ejs',
    'views/supplier_methodology.ejs',
    'views/external_supplier_ddq.ejs',
  ].forEach(relative => {
    assert.doesNotThrow(() => ejs.compile(source(relative), { filename:path.join(root, relative) }), relative);
  });
});

test('visible decision roles use the client decision authority boundary', () => {
  const recommendation = source('views/partials/tprm_recommendation_workflow.ejs');
  const assurance = source('views/tprm_assurance.ejs');
  const thirdParty = source('views/tprm_third_party.ejs');
  const clientPortfolio = source('views/client_tprm_portfolio.ejs');

  assert.match(recommendation, /assigned client decision authority/);
  assert.doesNotMatch(recommendation, /client sponsor/i);
  assert.match(assurance, /Residual-risk acceptance<\/strong><\/span><span>Client decision authority/);
  assert.match(thirdParty, /Only the assigned client decision authority/);
  assert.doesNotMatch(thirdParty, /these supplier decisions/i);
  assert.match(clientPortfolio, /other client reviewers remain read only/);
});

test('peer reports and intake actions do not compete as duplicate primaries', () => {
  const reports = source('views/tprm_reports.ejs');
  const intake = source('views/tprm_new_third_party.ejs');

  assert.equal((reports.match(/btn-primary/g) || []).length, 0, 'peer report cards should use equal action hierarchy');
  assert.equal((intake.match(/>Cancel<\/a>/g) || []).length, 1, 'intake should expose one cancel action');
  assert.equal((intake.match(/btn-primary/g) || []).length, 1, 'intake should expose one primary action');
  assert.match(intake, /Third-party organisation name/);
  assert.doesNotMatch(intake, /Legal or trading name/);
});

test('filters and relationship mutations state the exact action and consequence', () => {
  for (const relative of [
    'views/tprm_firm_portfolio.ejs',
    'views/tprm_third_parties.ejs',
    'views/tprm_relationships.ejs',
    'views/tprm_findings.ejs',
  ]) assert.match(source(relative), />Apply filters<\/button>/, relative);

  const relationship = source('views/tprm_relationship_detail.ejs');
  assert.match(relationship, /Record service status change/);
  assert.match(relationship, /does not record or change the client onboarding decision/);
  assert.match(relationship, /Save service relationship changes/);
  assert.match(relationship, /retained in the relationship audit history/);
  assert.doesNotMatch(relationship, />Continue<\/a>/);
});

test('connector identity mapping explains the external identifier boundary', () => {
  const connector = source('views/tprm_connector_settings.ejs');
  assert.match(connector, /Monitoring-provider entity ID/);
  assert.match(connector, /This is not the Nimbus third-party record ID/);
  assert.match(connector, /Create verified mapping/);
});

test('module navigation wraps into discoverable tabs at phone and compact-tablet widths', () => {
  const css = source('public/tprm.css');
  assert.match(css, /@media\(max-width:720px\)\{\.tprm-module-nav\{flex-wrap:wrap;overflow:visible/);
  assert.match(css, /\.tprm-module-nav a,\.tprm-module-nav \.tprm-nav-disabled\{flex:1 1 145px/);
  assert.match(css, /@media\(max-width:460px\).*flex-basis:130px/);
});

test('due-diligence and methodology surfaces use canonical external-party terms', () => {
  const dueDiligence = source('views/supplier_due_diligence.ejs');
  const methodology = source('views/supplier_methodology.ejs');
  const external = source('views/external_supplier_ddq.ejs');

  for (const legacy of [
    'Vendor due diligence', 'Issue to vendor', 'Vendor answered', 'Waiting for vendor',
    'Vendor submission', 'Vendor response',
  ]) assert.doesNotMatch(dueDiligence, new RegExp(legacy, 'i'), legacy);
  assert.match(dueDiligence, /Provider contact answered/);
  assert.match(dueDiligence, /Issue to provider contact/);
  assert.match(dueDiligence, /canManageMethodology/);
  assert.match(dueDiligence, /Read-only assessment snapshot/);

  assert.match(methodology, /Third-party assessment methodology/);
  assert.match(methodology, /Third-party register/);
  assert.doesNotMatch(methodology, /Supplier assessment configuration|Supplier portfolio|issued to suppliers|new supplier assessment/i);
  assert.match(methodology, /canonicalTprmText\(question\.question\)/);
  assert.match(external, /<title>Third-party due diligence<\/title>/);
  assert.match(external, /canonicalTprmText\(question\.question\)/);
});

test('retired questionnaire links use canonical provider due-diligence terminology', () => {
  const route = source('routes/engagement-ops.js');

  assert.match(route, /res\.status\(410\)\.send\('This provider questionnaire link has been retired\./);
  assert.match(route, /new governed provider due-diligence link/);
  assert.match(route, /assessment from the third-party record/);
  assert.doesNotMatch(route, /This supplier questionnaire link/);
});
