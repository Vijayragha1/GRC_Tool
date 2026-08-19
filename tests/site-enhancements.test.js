'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('shared application shell exposes the production interaction layer', () => {
  const header = read('views/partials/header.ejs');
  const footer = read('views/partials/footer.ejs');
  assert.match(header, /class="skip-link"[^>]*href="#mainContent"/);
  assert.match(header, /site-enhancements\.js\?v=/);
  assert.match(header, /data-theme-toggle/);
  assert.match(header, /class="palette-trigger"/);
  assert.match(footer, /Frequently asked questions/);
  assert.match(footer, /role="dialog" aria-modal="true"/);
  assert.match(footer, /role="status" aria-live="polite"/);
});

test('shared interaction controller covers all progressive enhancement contracts', () => {
  const source = read('public/site-enhancements.js');
  for (const marker of [
    'installCookieBanner', 'captureAttribution', 'enhancePasswords', 'enhanceCopyBlocks',
    'installFormValidation', 'enhanceBulkSelectForms', 'enhanceLegacyConfirmations', 'installScrollTools', 'addLastRefreshed',
    'installFloatingContact', 'enhanceDialogs', 'syncThemeControls',
    'toggleThemeState',
  ]) assert.match(source, new RegExp(`function ${marker}\\b`), `${marker} must remain implemented`);
  for (const parameter of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    assert.match(source, new RegExp(parameter));
  }
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'optional campaign attribution must not send data to a third party');
  assert.match(source, /prefers-color-scheme|data-theme/);
});

test('risk library bulk actions expose an explicit selection contract', () => {
  const view = read('views/risks_library.ejs');
  const routes = read('routes/risks.js');
  assert.match(view, /data-bulk-select-form/);
  assert.match(view, /data-selected-count/);
  assert.match(view, /data-bulk-submit[^>]*disabled/);
  assert.doesNotMatch(view, /onclick="pickAll|function pickAll/);
  assert.match(routes, /Select at least one risk before adding to the register\./);
});

test('shared stylesheet covers sticky, responsive, reduced-motion and print states', () => {
  const css = read('public/app.css');
  for (const selector of [
    '.skip-link', '.page-scroll-progress', '.back-to-top', '.floating-contact',
    '.cookie-consent', '.password-toggle', '.copy-button', '.field-invalid',
    '.help-faq', '.app-page-meta', ':focus-visible',
  ]) assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(css, /\.topbar\{position:sticky/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /@media print\{/);
});

test('dark theme uses a coherent graphite surface system', () => {
  const css = read('public/app.css');
  assert.match(css, /\[data-theme="dark"\][\s\S]*--bg: #1c2023/);
  assert.match(css, /--sidebar-bg: #181c1f/);
  assert.match(css, /--primary-bg: #e1e7e4/);
  assert.match(css, /background: var\(--sidebar-bg\)/);
  assert.match(css, /background: var\(--nav-active\)/);
  assert.doesNotMatch(css, /#D49595|#ECCCCC/);
});

test('light theme uses warm surfaces and reserves white for paper or controls', () => {
  const css = read('public/app.css');
  const questionnaire = read('views/external_questionnaire.ejs');
  const supplierDdq = read('views/external_supplier_ddq.ejs');
  const approval = read('views/approve.ejs');

  assert.match(css, /--bg: #fbfbf8/);
  assert.match(css, /--bg-deep: #f2f1ec/);
  assert.match(css, /--paper: #ffffff/);
  assert.match(questionnaire, /--bg:#f2f1ec; --card:#fbfbf8/);
  assert.match(supplierDdq, /--bg:#f2f1ec;--card:#fbfbf8;--field:#ffffff/);
  assert.match(approval, /--bg: #fbfbf8;[\s\S]*--paper: #ffffff/);
  assert.match(approval, /\.doc-preview \{ background: var\(--paper\)/);
});

test('firm client switcher and Delivery QA use shared theme and typography tokens', () => {
  const header = read('views/partials/header.ejs');
  const delivery = read('views/delivery_portfolio.ejs');
  const firmSwitcher = header.slice(header.indexOf('Jump to a client') - 1200, header.indexOf('Jump to a client') + 2600);
  assert.match(firmSwitcher, /background:var\(--nav-hover\)/);
  assert.match(firmSwitcher, /color:var\(--text\)/);
  assert.match(firmSwitcher, /background:var\(--bg\)/);
  assert.doesNotMatch(firmSwitcher, /color:#1a1a1a|background:#ffffff/);
  assert.match(delivery, /\.dp-head h1\{font-family:inherit/);
  assert.match(delivery, /\.dp-metric b\{font-family:inherit/);
  assert.doesNotMatch(delivery, /font-family:Georgia/);
});

test('visual system avoids template-signature styling on core product surfaces', () => {
  const css = read('public/app.css');
  const header = read('views/partials/header.ejs');
  const assurance = read('views/assurance_center.ejs');
  const quality = read('views/data_quality.ejs');

  assert.match(css, /--font-sans: -apple-system/);
  assert.match(css, /--shadow-sm: none/);
  assert.match(css, /\.panel \{[^}]*box-shadow: none/);
  assert.match(css, /\.cp-programme-grid-client\{display:block/);
  assert.match(css, /\.cp-home-decisions\{gap:0/);
  assert.match(css, /\.cm-decision-hero\{background:#1f444b/);
  assert.match(assurance, /class="page-head assurance-page-head"/);
  assert.doesNotMatch(assurance, /assurance-hero|#30272b|Controlled assurance output|Snapshot-backed/);
  assert.match(quality, /class="page-head dq-page-head"/);
  assert.match(quality, /Current readiness position/);
  assert.doesNotMatch(quality, /dq-hero|#20343b|Authoritative workspace truth|Certification verdict/);
  assert.doesNotMatch(header, /fonts\/inter\.css|linear-gradient/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(assurance, /linear-gradient|font-family:Georgia|border-left:4px/);
  assert.doesNotMatch(quality, /linear-gradient|font-family:Georgia/);
});

test('status cards do not use decorative side-border accents', () => {
  const sources = [
    read('views/changes_since.ejs'),
    read('views/import.ejs'),
    read('public/auditor.css'),
    read('views/audit_pack.ejs'),
  ];

  for (const source of sources) {
    assert.doesNotMatch(source, /\.(?:cs-stat|preview-tile|kpi)::before/);
    assert.doesNotMatch(source, /border-left(?:-color)?\s*:/);
  }
});
