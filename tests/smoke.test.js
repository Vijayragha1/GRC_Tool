#!/usr/bin/env node
// Bare-node smoke test suite. Boots a fresh DB in a tmp dir, spawns the server
// against it, and walks the most load-bearing routes.
//
//   npm test
//
// Failure mode: prints which route/assertion failed and exits non-zero.
//
// What this catches: schema migrations don't crash on a clean DB, the
// load-bearing GETs return 200, the wizard POST persists state + writes a
// history snapshot, the SoA renders linked risks, the bulk-spawn route
// derives priority. It does NOT cover auth, CSRF, or XSS — those require a
// real test framework with cookie + session handling.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-smoke-'));
const TMP_DB = path.join(TMP, 'iso27001.db');
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), DB_PATH: TMP_DB };

let serverProc = null;
let port = 3344;
let assertions = 0, failures = 0;

function ok(name, cond, detail) {
  assertions++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
}

function get(pathStr) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'GET' }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(pathStr, formObj) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(formObj).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map(vi => `${encodeURIComponent(k)}=${encodeURIComponent(vi)}`)
                       : [`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`]
    ).join('&');
    const req = http.request({
      host: '127.0.0.1', port, path: pathStr, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => resolve({ status: res.statusCode, body: resp, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function startServer() {
  // Copy a freshly-seeded DB from the live one — gives us an Acme workspace + iso_items.
  // db.js honours DB_PATH so the server writes its migrations to the tmp copy.
  const seedDb = path.join(ROOT, 'iso27001.db');
  if (fs.existsSync(seedDb)) fs.copyFileSync(seedDb, TMP_DB);
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...ENV, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  const ready = await waitFor(async () => (await get('/dashboard')).status < 500);
  if (!ready) throw new Error('server did not start within 8s');
}

function stopServer() {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
}

(async () => {
  console.log(`smoke tests in ${TMP}\n`);
  try {
    await startServer();

    console.log('boot');
    const dash = await get('/dashboard');
    ok('GET /dashboard returns 200', dash.status === 200, `got ${dash.status}`);

    console.log('\nworkspace pages');
    for (const [pathStr, name] of [
      ['/workspaces/1/controls/assess/clause-4.1', 'wizard renders for clause-4.1'],
      ['/workspaces/1/controls/assess/annex-a.5.1', 'wizard renders for annex-a.5.1'],
      ['/workspaces/1/controls/assess/summary', 'post-assessment summary renders'],
      ['/workspaces/1/soa', 'SoA renders'],
      ['/workspaces/1/risks', 'risks list renders'],
      ['/workspaces/1/tasks', 'tasks list renders'],
      ['/workspaces/1/readiness/blockers', 'blockers page renders'],
      ['/workspaces/1/export/soa.csv', 'SoA CSV exports']
    ]) {
      const r = await get(pathStr);
      ok(name, r.status === 200, `got ${r.status} for ${pathStr}`);
    }

    console.log('\nbespoke question coverage');
    const { getQuestions } = require(path.join(ROOT, 'data', 'assessment-questions'));
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB, { readonly: true });
    const items = db.prepare('SELECT id, title, evidence_needed FROM iso_items').all();
    let mech = 0;
    for (const it of items) {
      const qs = getQuestions(it);
      if (!qs || qs.length === 0) mech++;
      for (const q of qs || []) if (/^Are you doing this:/.test(q)) mech++;
    }
    ok('all 118 items return bespoke questions (no mechanical fallthrough)', items.length === 118 && mech === 0, `${items.length} items, ${mech} mechanical`);

    console.log('\nwizard POST + history snapshot');
    const before = db.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=1 AND iso_item_id='clause-5.1'`).get().c;
    db.close();
    const saveResp = await post('/workspaces/1/controls/assess/clause-5.1', {
      status: 'Partially Implemented',
      maturity: 2,
      scope_pct: 70,
      notes: 'smoke-test note',
      action: 'save',
      q_0: 'yes', q_1: 'partial', q_2: 'no'
    });
    ok('wizard POST returns 3xx redirect', saveResp.status >= 300 && saveResp.status < 400, `got ${saveResp.status}`);
    const dbCheck = new Database(TMP_DB, { readonly: true });
    const after = dbCheck.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=1 AND iso_item_id='clause-5.1'`).get().c;
    ok('history snapshot was appended', after === before + 1, `before=${before}, after=${after}`);
    const cur = dbCheck.prepare(`SELECT status, scope_pct, notes FROM control_states WHERE workspace_id=1 AND iso_item_id='clause-5.1'`).get();
    ok('control_states.status persisted', cur.status === 'Partially Implemented', JSON.stringify(cur));
    ok('control_states.scope_pct persisted', cur.scope_pct === 70, JSON.stringify(cur));
    ok('control_states.notes persisted', cur.notes === 'smoke-test note', JSON.stringify(cur));
    dbCheck.close();

    console.log('\ncontrol history page');
    const histResp = await get('/workspaces/1/controls/clause-5.1/history');
    ok('history page renders', histResp.status === 200, `got ${histResp.status}`);
    ok('history page lists the snapshot', histResp.body.includes('Partially Implemented'), 'snapshot row missing');
    ok('history page shows scope %', histResp.body.includes('70%'), 'scope % missing');

    console.log('\nbulk-spawn priority derivation');
    const spawnResp = await post('/workspaces/1/controls/assess/summary/spawn-tasks', {
      iso_id: ['clause-5.1'],
      due_date: ''
    });
    ok('spawn-tasks returns 3xx redirect', spawnResp.status >= 300 && spawnResp.status < 400, `got ${spawnResp.status}`);
    const dbTask = new Database(TMP_DB, { readonly: true });
    const tasks = dbTask.prepare(`SELECT priority, iso_item_id FROM tasks WHERE workspace_id=1 AND iso_item_id='clause-5.1' ORDER BY id DESC LIMIT 1`).get();
    ok('task created with priority field', tasks && ['low','normal','high','critical'].includes(tasks.priority), JSON.stringify(tasks));
    dbTask.close();

    console.log('\nSoA shows risk linkage');
    const soaResp = await get('/workspaces/1/soa');
    ok('SoA includes "Risks treated" header', soaResp.body.includes('Risks treated'), 'header missing');

  } catch (e) {
    failures++;
    console.error(`\n✗ test crashed: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    stopServer();
    console.log(`\n${assertions} assertions, ${failures} failure${failures === 1 ? '' : 's'}`);
    process.exit(failures > 0 ? 1 : 0);
  }
})();
