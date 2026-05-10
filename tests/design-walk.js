// Interactive design walkthrough. Boots a test server against a copy of the
// live DB, opens a real (non-headless) Chrome so the operator can see the
// browser, navigates through key pages and captures full-page screenshots
// for design review. Stays open at the end so you can poke at it manually.
//
// Run: node tests/design-walk.js

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = path.join(__dirname, 'design-shots');
const TMP_DB = path.join('/tmp', `iso27001-design-${Date.now()}.db`);
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const liveDb = path.join(ROOT, 'iso27001.db');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function log(...a) { console.log('[design-walk]', ...a); }

async function startServer() {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  proc.stdout.on('data', d => buf += d.toString());
  proc.stderr.on('data', d => buf += d.toString());
  const ready = await new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 15000);
    const i = setInterval(() => { if (buf.includes('running at')) { clearTimeout(t); clearInterval(i); resolve(true); } }, 200);
  });
  if (!ready) { console.error(buf); proc.kill(); process.exit(1); }
  log('Server up.');
  return proc;
}

(async () => {
  // Use SQLite's online-backup API to snapshot the live DB. fs.copyFileSync
  // only copies the .db file and misses uncommitted writes still in the WAL —
  // that produced stale screenshots before this fix.
  const Database = require('better-sqlite3');
  const _src = new Database(liveDb);
  await _src.backup(TMP_DB);
  _src.close();

  const server = await startServer();
  const db = new Database(TMP_DB, { readonly: true });
  const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  let ws = db.prepare('SELECT id, firm_id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firm.id);
  let switchToFirm = null;
  if (!ws) { ws = db.prepare('SELECT id, firm_id FROM workspaces ORDER BY id LIMIT 1').get(); if (ws) switchToFirm = ws.firm_id; }
  db.close();
  const wsId = ws.id;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  if (switchToFirm) {
    await page.goto(BASE + '/tenants', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async fid => { await fetch('/tenants/' + fid + '/switch', { method: 'POST', body: new FormData() }); }, switchToFirm);
  }

  const routes = [
    ['dashboard', '/dashboard'],
    ['workspace-overview', `/workspaces/${wsId}`],
    ['readiness', `/workspaces/${wsId}/readiness`],
    ['gap-assessment', `/workspaces/${wsId}/gap-assessment`],
    ['controls', `/workspaces/${wsId}/controls`],
    ['controls-assess', `/workspaces/${wsId}/controls/assess`],
    ['risks', `/workspaces/${wsId}/risks`],
    ['soa', `/workspaces/${wsId}/soa`],
    ['evidence', `/workspaces/${wsId}/evidence`],
    ['documents', `/workspaces/${wsId}/documents`],
    ['interested-parties', `/workspaces/${wsId}/interested-parties`],
    ['objectives', `/workspaces/${wsId}/objectives`],
    ['audits', `/workspaces/${wsId}/audits`],
    ['nonconformities', `/workspaces/${wsId}/nonconformities`],
    ['vendors', `/workspaces/${wsId}/vendors`],
    ['reports', `/workspaces/${wsId}/reports`],
    ['glossary', '/glossary'],
    ['tenants', '/tenants'],
  ];

  for (const [name, url] of routes) {
    try {
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 400));
      const shot = path.join(SHOT_DIR, name + '.png');
      await page.screenshot({ path: shot, fullPage: true });
      log('  shot ' + name);
    } catch (e) { log('  fail ' + name + ': ' + e.message); }
  }

  // Above-the-fold (single viewport, not full page) for "first impression" review
  for (const [name, url] of routes) {
    try {
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 300));
      const shot = path.join(SHOT_DIR, name + '__fold.png');
      await page.screenshot({ path: shot, fullPage: false });
    } catch (_) {}
  }

  await browser.close();
  server.kill();
  await new Promise(r => setTimeout(r, 300));
  try { fs.unlinkSync(TMP_DB); } catch (_) {}
  log('Done. Screenshots in', SHOT_DIR);
})();
