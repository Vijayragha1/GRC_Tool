const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('mobile viewport and drawer controls expose an accessible state contract', () => {
  const header = read('views/partials/header.ejs');

  assert.match(header, /viewport-fit=cover/);
  assert.match(header, /id="sidebar" aria-label="Primary navigation"/);
  assert.match(header, /class="sidebar-mobile-close"/);
  assert.match(header, /id="mobileMenuButton"[\s\S]*aria-controls="sidebar"[\s\S]*aria-expanded="false"/);
  assert.match(header, /id="sidebarBackdrop"[\s\S]*aria-hidden="true"/);
});

test('drawer lifecycle locks background, manages focus and survives shell swaps', () => {
  const footer = read('views/partials/footer.ejs');

  assert.match(footer, /function syncMobileSidebar\(\)/);
  assert.match(footer, /sidebar\.toggleAttribute\('inert', mobile && !open\)/);
  assert.match(footer, /sidebar\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(footer, /menuButton\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(footer, /app\?\.classList\.toggle\('drawer-open', open\)/);
  assert.match(footer, /sidebarReturnFocus\.focus/);
  assert.match(footer, /event\.key !== 'Tab'/);
  assert.match(footer, /if \(typeof syncMobileSidebar === 'function'\) syncMobileSidebar\(\)/);
});

test('shared mobile CSS covers safe areas, touch targets and viewport-bound content', () => {
  const css = read('public/app.css');
  const mobileShell = css.slice(css.indexOf('SHARED MOBILE SHELL'));

  assert.match(mobileShell, /@media \(max-width: 900px\)/);
  assert.match(mobileShell, /env\(safe-area-inset-bottom\)/);
  assert.match(mobileShell, /\.app\.drawer-open \.main/);
  assert.match(mobileShell, /\.nav-item, \.nav-domain-summary, \.nav-subitem \{ min-height: 44px/);
  assert.match(mobileShell, /\.btn, \.btn-xs,[\s\S]*min-height: 44px/);
  assert.match(mobileShell, /\.subtabs[\s\S]*overflow-x: auto/);
  assert.match(mobileShell, /\[class\$="-table-wrap"\]/);
  assert.match(mobileShell, /\.cp-modal[\s\S]*max-height: calc\(100dvh/);
  assert.match(mobileShell, /\.app-confirm-sheet[\s\S]*width: 100% !important/);
  assert.match(mobileShell, /@media \(max-width: 430px\)/);
});

test('command palette search remains a full-size mobile control', () => {
  const footer = read('views/partials/footer.ejs');
  const css = read('public/app.css');
  const mobileShell = css.slice(css.indexOf('SHARED MOBILE SHELL'));

  assert.match(footer, /<input type="search" id="cpInput"/);
  assert.match(mobileShell, /\.cp-search input \{ min-width: 0; min-height: 44px; font-size: 16px; \}/);
});
