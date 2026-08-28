const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function viewFiles(directory = path.join(root, 'views')) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? viewFiles(target) : [target];
  });
}

test('mobile viewport and drawer controls expose an accessible state contract', () => {
  const header = read('views/partials/header.ejs');

  assert.match(
    header,
    /<meta name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover">/
  );
  assert.match(header, /id="sidebar" aria-label="Primary navigation"/);
  assert.match(header, /class="sidebar-mobile-close"/);
  assert.match(header, /id="mobileMenuButton"[\s\S]*aria-controls="sidebar"[\s\S]*aria-expanded="false"/);
  assert.match(header, /id="sidebarBackdrop"[\s\S]*aria-hidden="true"/);
});

test('every standalone HTML view opts into the physical device width', () => {
  const standaloneViews = viewFiles().filter(file => {
    if (!file.endsWith('.ejs')) return false;
    return /<!doctype html/i.test(fs.readFileSync(file, 'utf8'));
  });

  assert.ok(standaloneViews.length > 0);
  standaloneViews.forEach(file => {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(
      source,
      /<meta\s+name=["']viewport["']\s+content=["'][^"']*width=device-width[^"']*initial-scale=1(?:\.0)?[^"']*["']\s*\/?\s*>/i,
      `${path.relative(root, file)} must auto-fit the device viewport`
    );
  });
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

  assert.match(mobileShell, /@media \(max-width: 960px\)/);
  assert.match(css, /\.app\s*\{[\s\S]*?width: 100%;[\s\S]*?height: 100vh; height: 100dvh;/);
  assert.match(css, /\.sidebar\s*\{[\s\S]*?height: 100vh; height: 100dvh; max-height: 100dvh;/);
  assert.match(css, /\.main\s*\{[\s\S]*?width: 100%; max-width: 100%; min-width: 0;[\s\S]*?height: 100vh; height: 100dvh;/);
  assert.match(css, /\.main-inner\s*\{ width: 100%; max-width: 1280px; min-width: 0;/);
  assert.match(mobileShell, /\.sidebar[\s\S]*env\(safe-area-inset-left\)/);
  assert.match(mobileShell, /#app \.topbar[\s\S]*env\(safe-area-inset-top\)/);
  assert.match(mobileShell, /#app \.main-inner[\s\S]*env\(safe-area-inset-right\)[\s\S]*env\(safe-area-inset-bottom\)[\s\S]*env\(safe-area-inset-left\)/);
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

test('drawer JavaScript uses the same wide-phone breakpoint as CSS', () => {
  const footer = read('views/partials/footer.ejs');
  const tprm = read('public/tprm.css');
  assert.match(footer, /window\.matchMedia\('\(max-width: 960px\)'\)/);
  assert.match(tprm, /@media \(min-width: 961px\)\s*\{\s*\.tprm-module-nav\s*\{\s*display: none/);
  assert.match(tprm, /@media \(max-width: 960px\)\s*\{\s*\.tprm-module-nav\s*\{\s*display: flex/);
});

test('standalone centered flows follow the live mobile browser height', () => {
  [
    'views/auth/login.ejs',
    'views/auth/accept_invite.ejs',
    'views/auth/forgot.ejs',
    'views/auth/reset.ejs',
    'views/approve_done.ejs',
    'views/approve_error.ejs',
  ].forEach(file => {
    assert.match(read(file), /min-height:\s*100vh;\s*min-height:\s*100dvh;/);
  });
});
