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

test('dialogs are hidden when closed, contain keyboard focus, and restore their opener', () => {
  const header = read('views/partials/header.ejs');
  const footer = read('views/partials/footer.ejs');
  assert.match(header, /aria-controls="cpBackdrop" aria-expanded="false"/);
  assert.match(header, /aria-controls="helpBackdrop" aria-expanded="false"/);
  assert.match(footer, /id="cpBackdrop"[^>]*role="dialog"[^>]*hidden/);
  assert.match(footer, /id="helpBackdrop"[^>]*role="dialog"[^>]*hidden/);
  assert.match(footer, /id="appConfirmModal"[^>]*role="dialog"[^>]*hidden/);
  assert.match(footer, /id="cpBackdrop"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(footer, /modal\.removeAttribute\('aria-hidden'\)/);
  assert.match(footer, /modal\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(footer, /setAttribute\('inert', ''\)/);
  assert.match(footer, /function trap\(modal, event\)/);
  assert.match(footer, /returnFocus\.get\(modal\)/);
});

test('public buyer path is explicit, accessible, and avoids certification claims', () => {
  const page = read('views/auth/public.ejs');
  const css = read('public/public.css');
  const server = read('server.js');
  assert.match(page, /Request an evaluation/);
  // The programme names used to be typed into this view, which is how the page
  // came to advertise three standards after a fourth had shipped. They now come
  // from the framework registry, so the guarantee is checked where it lives:
  // the view must render the registry's formal designation, and the registry
  // must carry a proper external name for every framework it lists.
  assert.match(page, /<%= p\.formalName %>/, 'the public register must render the registry name, not a typed literal');
  const formalNames = require('../lib/frameworks').FRAMEWORK_LIST.map((f) => f.formalName);
  assert.ok(formalNames.includes('ISO/IEC 27001:2022'), `expected the ISO 27001 designation, got ${formalNames.join(', ')}`);
  assert.ok(formalNames.includes('NIST CSF 2.0'), `expected the CSF designation, got ${formalNames.join(', ')}`);
  for (const name of formalNames) {
    assert.ok(name && name.length > 3, `every framework needs an external name, got ${JSON.stringify(name)}`);
  }
  assert.match(page, /No public contact has been configured/);
  assert.match(page, /does not itself certify conformity/);
  assert.match(page, /class="skip-link"[^>]*href="#mainContent"/);
  assert.equal((page.match(/<main\b/g) || []).length, 1);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
  assert.match(server, /Symbol\.for\('complianceSphere\.unhandledRejectionHandler'\)/,
    'repeated in-process boots must replace the global rejection handler instead of leaking listeners');
});

test('application pages expose exactly the shell main landmark', () => {
  const nestedMainViews = [
    'views/delivery_cockpit.ejs', 'views/consulting_finding.ejs',
    'views/consultant_workpaper.ejs', 'views/controls_assess_summary.ejs',
    'views/data_quality.ejs'
  ];
  nestedMainViews.forEach(file => {
    assert.doesNotMatch(read(file), /<\/?main(?:\s|>)/, `${file} must not nest another main landmark inside the shell`);
  });
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

test('client deletion confirmation offers an exact-name copy action without weakening the guard', () => {
  const dashboard = read('views/dashboard.ejs');
  assert.match(dashboard, /id="dcmCopyName"[^>]*data-copy-target="#dcmExpected"/);
  assert.match(dashboard, /aria-label="Copy client name"[^>]*aria-live="polite"/);
  assert.match(dashboard, /data-delete-client-id="<%= w\.id %>"/);
  assert.match(dashboard, /data-delete-client-name="<%= w\.client_name %>"/);
  assert.match(dashboard, /querySelectorAll\('\[data-delete-client-id\]\[data-delete-client-name\]'\)/);
  assert.doesNotMatch(dashboard, /onclick="deleteClient\(/,
    'database-backed names must not be interpolated into executable JavaScript');
  assert.match(dashboard, /copyName\.addEventListener\('click',[\s\S]*input\.focus\(\)/);
  assert.match(dashboard, /input\.value\.trim\(\) !== currentName/,
    'copy assistance must not remove the exact-name confirmation check');
});

test('ISO 27001 diagnostic answers can return to an unanswered state', () => {
  const view = read('views/controls_assess.ejs');
  const route = read('routes/controls.js');

  assert.match(view, /data-diagnostic-group[^>]*role="group"[^>]*aria-label=/);
  assert.match(view, /type="hidden" data-diagnostic-value name="q_<%= i %>"/);
  assert.match(view, /<button type="button" class="diag-pill/,
    'diagnostic choices must be keyboard-operable toggle buttons, not one-way radios');
  assert.match(view, /aria-pressed="<%= isOn \? 'true' : 'false' %>"/);
  assert.doesNotMatch(view, /type="radio" name="q_<%= i %>"/);
  assert.match(view, /field\.value = field\.value === selected \? '' : selected/,
    'activating the selected answer must clear it');
  assert.match(view, /window\.recomputeSuggested\(\)/,
    'answer changes must immediately update the heuristic');
  assert.match(view, /id="suggestedStatusText"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(route, /sawDiagnosticField = true/);
  assert.match(route, /JSON\.stringify\(answers\)/,
    'the legacy storage path must be able to replace the final answer with an empty object');
});

test('dashboard quick-create offers the governed DPDPA assessment programme', () => {
  // The programme checkboxes render from the framework registry now, so the
  // literal markup this used to grep for no longer exists in the view. Assert
  // the two things that actually keep the behaviour: the registry carries the
  // programme with its picker copy, and the view still builds the element id
  // the onboarding flows key on. Rendered output is covered end-to-end by
  // tests/dpdpa-gap-routes.test.js and tests/vciso-onboarding.test.js.
  const { FRAMEWORK_REGISTRY } = require('../lib/frameworks');
  assert.equal(FRAMEWORK_REGISTRY.dpdpa.pickerLabel, 'India DPDPA');
  assert.equal(FRAMEWORK_REGISTRY.dpdpa.pickerNote, 'Gap assessment');

  const dashboard = read('views/dashboard.ejs');
  assert.match(dashboard, /id="dashboard-<%= fw\.code %>-programme"[^>]*name="frameworks"[^>]*value="<%= fw\.code %>"/);
  assert.match(dashboard, /<strong[^>]*><%= fw\.pickerLabel %><\/strong><span class="meta"><%= fw\.pickerNote %><\/span>/);
  assert.doesNotMatch(dashboard, /name="frameworks"\s+value="[a-z0-9]+"/,
    'programme checkboxes must render from the registry, not be hand-written per framework');
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

test('light theme uses warm shell surfaces while TPRM handoffs use neutral paper controls', () => {
  const css = read('public/app.css');
  const questionnaire = read('views/external_questionnaire.ejs');
  const supplierDdq = read('views/external_supplier_ddq.ejs');
  const approval = read('views/approve.ejs');

  assert.match(css, /--bg: #fbfbf8/);
  assert.match(css, /--bg-deep: #f2f1ec/);
  assert.match(css, /--paper: #ffffff/);
  assert.match(questionnaire, /--bg:#f2f1ec; --card:#fbfbf8/);
  assert.match(supplierDdq, /--bg:#f4f4f4;--card:#ffffff;--field:#ffffff/);
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
