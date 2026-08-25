const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('dashboard uses a mobile card list and touch-safe client actions', () => {
  const view = read('views/dashboard.ejs');
  assert.match(view, /#clientTable tr\.dash-row\s*\{[\s\S]*display:\s*grid/);
  assert.match(view, /data-label="Engagement"/);
  assert.match(view, /data-label="Progress"/);
  assert.match(view, /data-label="Next milestone"/);
  assert.match(view, /data-label="Attention"/);
  assert.match(view, /\.dashboard-delete-client\s*\{\s*min-width:\s*44px/);
  assert.match(view, /\.dashboard-dialog-grid\s*\{[\s\S]*grid-template-columns:\s*1fr\s*!important/);
});

test('workspace overview keeps trend charts within responsive grid tracks', () => {
  const view = read('views/workspace.ejs');
  assert.match(view, /workspace-trends-grid/);
  assert.match(view, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*!important/);
  assert.match(view, /<svg width="100%"[^>]+preserveAspectRatio="none"/);
  assert.match(view, /workspace-overview-pair\s*\{\s*grid-template-columns:\s*1fr\s*!important/);
});

test('client creation, onboarding and intake expose narrow-screen layouts', () => {
  const create = read('views/workspace_new.ejs');
  const onboarding = read('views/onboarding.ejs');
  const intake = read('views/intake.ejs');
  assert.match(create, /\.client-create-form,[\s\S]*\.client-create-options\s*\{\s*grid-template-columns:\s*1fr\s*!important/);
  assert.match(onboarding, /\.onboarding-required-row\s*\{[\s\S]*grid-template-columns:\s*40px minmax\(0,\s*1fr\)\s*!important/);
  assert.match(intake, /intake-mobile-position/);
  assert.match(intake, /\.intake-status-banner\s*>\s*form,[\s\S]*grid-column:\s*2/);
});

test('workspace calendar provides a phone agenda rather than a seven-column squeeze', () => {
  const view = read('views/calendar.ejs');
  assert.match(view, /\.calendar-desktop-grid\s*\{\s*display:\s*none/);
  assert.match(view, /\.calendar-mobile-agenda\s*\{\s*display:\s*block/);
  assert.match(view, /\.calendar-mobile-event\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(view, /<section class="panel calendar-mobile-agenda"/);
  assert.match(view, /agendaDays\.forEach/);
});

test('ISO diagnostic choices keep the shared mobile touch target', () => {
  const iso27001 = read('views/controls_assess.ejs');
  const iso42001 = read('views/iso42001_gap_detail.ejs');
  assert.match(iso27001, /\.assess-shell \.diag-pill\s*\{\s*min-height:\s*44px/);
  assert.match(iso42001, /\.iso42-assessment \.diag-pill\s*\{\s*min-height:\s*44px/);
});

test('ISO Statement of Applicability keeps every editable column reachable', () => {
  const soa = read('views/soa.ejs');
  assert.match(soa, /\.soa-table-wrap\s*\{[\s\S]*overflow-x:\s*auto\s*!important/);
  assert.match(soa, /class="panel soa-table-wrap"/);
  assert.match(soa, /\.soa-table-wrap\s*>\s*table\s*\{[\s\S]*display:\s*table;[\s\S]*min-width:\s*1100px;[\s\S]*overflow:\s*visible/);
});

test('operational forms and registers stay usable without iOS focus zoom', () => {
  const delivery = read('views/delivery_cockpit.ejs');
  const tprm = read('public/tprm.css');
  const evidence = read('views/evidence_library.ejs');
  const risk = read('views/risk_detail.ejs');
  assert.match(delivery, /\.dco-grid\s*>\s*\*,[\s\S]*\.dco-main,[\s\S]*\.dco-aside\s*\{\s*min-width:\s*0/);
  assert.match(delivery, /\.dco-table-wrap\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(delivery, /\.dco-form input,\.dco-form select,\.dco-form textarea\s*\{[\s\S]*font-size:\s*16px/);
  assert.match(tprm, /\.tprm-section \.input,[\s\S]*font-size:\s*16px/);
  assert.match(evidence, /\.ev-row-list\s*\{\s*grid-template-columns:\s*1fr\s*!important/);
  assert.match(evidence, /\.evidence-record-actions\s*>\s*details\s*\.popover-panel\s*\{[\s\S]*left:\s*0\s*!important;[\s\S]*width:\s*100%\s*!important;[\s\S]*min-width:\s*0/);
  assert.match(risk, /\.risk-action-create,[\s\S]*\.risk-accept-form\s*\{\s*grid-template-columns:\s*1fr\s*!important/);
});
