const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('auditor pages opt into safe-area-aware physical viewport sizing', () => {
  const header = read('views/partials/auditor_header.ejs');
  assert.match(
    header,
    /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/
  );

  const auditorViews = [
    'auditor_landing.ejs',
    'auditor_soa.ejs',
    'auditor_risks.ejs',
    'auditor_evidence.ejs',
    'auditor_documents.ejs',
    'auditor_document_detail.ejs',
    'auditor_audits.ejs'
  ];
  auditorViews.forEach(view => {
    assert.match(
      read(`views/${view}`),
      /include\('partials\/auditor_header'/,
      `${view} must inherit the auditor viewport policy`
    );
  });
});

test('auditor shell uses dynamic viewport and safe-area gutters', () => {
  const css = read('public/auditor.css');
  assert.match(css, /body\s*\{[\s\S]*min-height:\s*100vh;\s*min-height:\s*100dvh;[\s\S]*overflow-x:\s*hidden/);
  assert.match(css, /\.a-topbar\s*\{[\s\S]*env\(safe-area-inset-top\)/);
  assert.match(css, /\.a-main\s*\{[\s\S]*100dvh[\s\S]*env\(safe-area-inset-right\)[\s\S]*env\(safe-area-inset-bottom\)[\s\S]*env\(safe-area-inset-left\)/);
});

test('auditor phone layout contains navigation, KPIs, records and documents', () => {
  const css = read('public/auditor.css');
  assert.match(css, /@media \(max-width:\s*760px\)/);
  assert.match(css, /@media \(max-width:\s*430px\)/);
  assert.match(css, /@media \(max-width:\s*360px\)/);
  assert.match(css, /\.a-tabs-row\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.a-tab\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.kpi-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /table\.t\s*\{[\s\S]*width:\s*max-content;[\s\S]*min-width:\s*680px/);
  assert.match(css, /body \.doc-body\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /body \.a-toc-item\s*\{[\s\S]*grid-template-columns:\s*26px minmax\(0,\s*1fr\)/);
});

test('auditor controls remain touch-safe without mobile focus zoom', () => {
  const css = read('public/auditor.css');
  assert.match(css, /a\.btn, \.a-pack-cta, button, input, select, textarea\s*\{\s*min-height:\s*44px/);
  assert.match(css, /input, select, textarea\s*\{\s*width:\s*100%;\s*font-size:\s*16px/);
});
