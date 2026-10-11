'use strict';
// A report export must not depend on which HOME the server process happens to
// have been started with. puppeteer resolves its browser cache from $HOME, so
// a service account started with a different HOME than the account that ran
// the install used to fail every PDF export with a 500 HTML page. The pack
// falls back to discovering the browser instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { browserCacheRoots, fallbackExecutablePath, findBrowserUnder } = require('../lib/audit-pack');

function cacheFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-browser-'));
  for (const [relative, mode] of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\n', { mode });
  }
  return root;
}

test('the browser is found inside a puppeteer cache whatever the platform layout is', () => {
  const root = cacheFixture([['chrome-headless-shell/linux-139.0.1/chrome-headless-shell-linux64/chrome-headless-shell', 0o755]]);
  assert.equal(findBrowserUnder(root), path.join(root, 'chrome-headless-shell/linux-139.0.1/chrome-headless-shell-linux64/chrome-headless-shell'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the newest cached version wins and a non-executable file is not offered as a browser', () => {
  const root = cacheFixture([
    ['chrome-headless-shell/linux-120.0.1/chrome-headless-shell-linux64/chrome-headless-shell', 0o755],
    ['chrome-headless-shell/linux-139.0.1/chrome-headless-shell-linux64/chrome-headless-shell', 0o755],
  ]);
  assert.match(findBrowserUnder(root), /linux-139\.0\.1/);
  fs.rmSync(root, { recursive: true, force: true });

  const unusable = cacheFixture([['chrome/linux-139.0.1/chrome-linux64/chrome', 0o644]]);
  assert.equal(findBrowserUnder(unusable), null);
  fs.rmSync(unusable, { recursive: true, force: true });
});

test('discovery looks under the account home, not only the HOME the process was given', () => {
  const roots = browserCacheRoots();
  let accountHome = null;
  try { accountHome = os.userInfo().homedir; } catch (_) { /* no passwd entry */ }
  if (accountHome) assert.ok(roots.includes(path.join(accountHome, '.cache', 'puppeteer')), roots.join(', '));
  assert.ok(roots.includes(path.join(__dirname, '..', 'node_modules', '.cache', 'puppeteer')));
  assert.equal(new Set(roots).size, roots.length, 'candidate roots are de-duplicated');
});

test('an explicit executable path overrides discovery', () => {
  const root = cacheFixture([['custom/chrome', 0o755]]);
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.PUPPETEER_EXECUTABLE_PATH = path.join(root, 'custom', 'chrome');
  // fallbackExecutablePath memoises, so assert against a fresh module instance.
  delete require.cache[require.resolve('../lib/audit-pack')];
  try {
    assert.equal(require('../lib/audit-pack').fallbackExecutablePath(), path.join(root, 'custom', 'chrome'));
  } finally {
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH; else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
    delete require.cache[require.resolve('../lib/audit-pack')];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('this checkout can actually resolve a browser to render a PDF with', () => {
  assert.ok(fallbackExecutablePath(), 'no Chromium found; run `npx puppeteer browsers install chrome-headless-shell`');
});
