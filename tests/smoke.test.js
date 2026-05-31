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
// derives priority. It does NOT cover auth, CSRF, or XSS - those require a
// real test framework with cookie + session handling.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-smoke-'));
const TMP_DB = path.join(TMP, 'iso27001.db');
// SESSION_SECRET pinned so the session cookie is stable; auth is now real, the
// firm-owner no-auth fallback was removed in commit a573539. DISABLE_CSRF=1 is
// the server's built-in test escape hatch - the body parser and CSRF middleware
// have a chicken-and-egg with multi-request cookie capture in this bare-node
// test, so we turn CSRF off and rely on the security.test.js suite to cover it.
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), DB_PATH: TMP_DB,
  SESSION_SECRET: 'smoke-test-fixed-secret-for-deterministic-cookies-only',
  DISABLE_CSRF: '1' };

// Login credentials seeded into the test user before the server boots.
const TEST_EMAIL = 'smoke@test.local';
const TEST_PASSWORD = 'smoke-test-password-1234';

let serverProc = null;
let port = 3344;
let assertions = 0, failures = 0;

function ok(name, cond, detail) {
  assertions++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
}

// Cookie jar + CSRF token, both updated from every response. The test bench
// has to act like a real browser now that CSRF protection is on.
let cookieJar = '';
let csrfToken = null;

function captureResponse(res, body) {
  const sc = res.headers['set-cookie'];
  if (sc) {
    const newCookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
    const existing = cookieJar ? cookieJar.split('; ').filter(c => !newCookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
    cookieJar = [...existing, ...newCookies].join('; ');
  }
  const m = body && body.match(/name="csrf-token" content="([a-f0-9]+)"/);
  if (m) csrfToken = m[1];
}

function get(pathStr) {
  return new Promise((resolve, reject) => {
    const headers = cookieJar ? { cookie: cookieJar } : {};
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'GET', headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { captureResponse(res, body); resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(pathStr, formObj) {
  return new Promise((resolve, reject) => {
    // Auto-attach the live CSRF token unless caller already supplied one.
    const payload = { ...formObj };
    if (csrfToken && !payload._csrf) payload._csrf = csrfToken;
    const body = Object.entries(payload).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map(vi => `${encodeURIComponent(k)}=${encodeURIComponent(vi)}`)
                       : [`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`]
    ).join('&');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    };
    if (cookieJar) headers['cookie'] = cookieJar;
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'POST', headers }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => { captureResponse(res, resp); resolve({ status: res.statusCode, body: resp, headers: res.headers }); });
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
  // Copy a freshly-seeded DB from the live one - gives us an Acme workspace + iso_items.
  // db.js honours DB_PATH so the server writes its migrations to the tmp copy.
  const seedDb = path.join(ROOT, 'iso27001.db');
  if (fs.existsSync(seedDb)) fs.copyFileSync(seedDb, TMP_DB);

  // Auth is real now (commit a573539). Seed a known test user with a known
  // password so the test can log in before walking the assertions. Reuse the
  // first firm so the user lands as its manager. Low bcrypt rounds for speed.
  const bcrypt = require('bcrypt');
  const Database = require('better-sqlite3');
  const seedConn = new Database(TMP_DB);
  const firm = seedConn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  if (!firm) {
    seedConn.prepare(`INSERT INTO firms (name) VALUES (?)`).run('Smoke Test Firm');
  }
  const firmId = firm ? firm.id : seedConn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const hash = bcrypt.hashSync(TEST_PASSWORD, 4);
  const existing = seedConn.prepare('SELECT id FROM users WHERE email=?').get(TEST_EMAIL);
  if (existing) {
    seedConn.prepare(`UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?`)
      .run(hash, firmId, existing.id);
  } else {
    seedConn.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active)
                      VALUES (?, ?, 'Smoke Tester', ?, 'firm', 'manager', 1)`)
      .run(TEST_EMAIL, hash, firmId);
  }
  seedConn.close();

  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...ENV, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  // Server is ready once /login responds (it's public and doesn't require auth).
  const ready = await waitFor(async () => (await get('/login')).status < 500);
  if (!ready) throw new Error('server did not start within 8s');

  // Authenticate: GET /login to capture CSRF token + initial session cookie,
  // then POST /login with the seeded credentials. The login handler regenerates
  // the session id and sets userId; subsequent requests via cookieJar are auth'd.
  await get('/login');
  const loginRes = await post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  if (loginRes.status < 300 || loginRes.status >= 400) {
    throw new Error(`login failed: expected 3xx, got ${loginRes.status}. Body preview: ${(loginRes.body || '').slice(0, 200)}`);
  }
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

    // Discover the active workspace ID from the seeded DB so the test isn't
    // pinned to a specific id (which the user's live DB no longer matches).
    // Pick the first workspace whose firm_id matches the lowest-id firm -
    // that matches the server's getActiveFirmId fallback.
    const Database = require('better-sqlite3');
    const dbDiscover = new Database(TMP_DB, { readonly: true });
    const firm = dbDiscover.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    let wsRow = firm ? dbDiscover.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firm.id) : null;
    if (!wsRow) wsRow = dbDiscover.prepare('SELECT id, firm_id FROM workspaces ORDER BY id LIMIT 1').get();
    dbDiscover.close();
    if (!wsRow) throw new Error('no workspace in seeded DB to test against');
    const wsId = wsRow.id;
    // If the workspace is in a non-default firm, switch the session active firm
    // so requireWorkspace doesn't 403.
    if (wsRow.firm_id && firm && wsRow.firm_id !== firm.id) {
      await post(`/tenants/${wsRow.firm_id}/switch`, {});
    }
    console.log(`  (using workspace id=${wsId})`);

    console.log('\nworkspace pages');
    for (const [pathStr, name] of [
      [`/workspaces/${wsId}/controls/assess/clause-4.1`, 'wizard renders for clause-4.1'],
      [`/workspaces/${wsId}/controls/assess/annex-a.5.1`, 'wizard renders for annex-a.5.1'],
      [`/workspaces/${wsId}/controls/assess/summary`, 'post-assessment summary renders'],
      [`/workspaces/${wsId}/soa`, 'SoA renders'],
      [`/workspaces/${wsId}/risks`, 'risks list renders'],
      [`/workspaces/${wsId}/tasks`, 'tasks list renders'],
      [`/workspaces/${wsId}/readiness/blockers`, 'blockers page renders'],
      [`/workspaces/${wsId}/export/soa.csv`, 'SoA CSV exports']
    ]) {
      const r = await get(pathStr);
      ok(name, r.status === 200, `got ${r.status} for ${pathStr}`);
    }

    console.log('\nbespoke question coverage');
    const { getQuestions } = require(path.join(ROOT, 'data', 'assessment-questions'));
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
    const before = db.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId).c;
    db.close();
    const saveResp = await post(`/workspaces/${wsId}/controls/assess/clause-5.1`, {
      status: 'Partially Implemented',
      maturity: 2,
      scope_pct: 70,
      notes: 'smoke-test note',
      action: 'save',
      q_0: 'yes', q_1: 'partial', q_2: 'no'
    });
    ok('wizard POST returns 3xx redirect', saveResp.status >= 300 && saveResp.status < 400, `got ${saveResp.status}`);
    const dbCheck = new Database(TMP_DB, { readonly: true });
    const after = dbCheck.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId).c;
    ok('history snapshot was appended', after === before + 1, `before=${before}, after=${after}`);
    const cur = dbCheck.prepare(`SELECT status, scope_pct, notes FROM control_states WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId);
    ok('control_states.status persisted', cur && cur.status === 'Partially Implemented', JSON.stringify(cur));
    ok('control_states.scope_pct persisted', cur && cur.scope_pct === 70, JSON.stringify(cur));
    ok('control_states.notes persisted', cur && cur.notes === 'smoke-test note', JSON.stringify(cur));
    dbCheck.close();

    console.log('\ncontrol history page');
    const histResp = await get(`/workspaces/${wsId}/controls/clause-5.1/history`);
    ok('history page renders', histResp.status === 200, `got ${histResp.status}`);
    ok('history page lists the snapshot', histResp.body.includes('Partially Implemented'), 'snapshot row missing');
    ok('history page shows scope %', histResp.body.includes('70%'), 'scope % missing');

    console.log('\nbulk-spawn priority derivation');
    const spawnResp = await post(`/workspaces/${wsId}/controls/assess/summary/spawn-tasks`, {
      iso_id: ['clause-5.1'],
      due_date: ''
    });
    ok('spawn-tasks returns 3xx redirect', spawnResp.status >= 300 && spawnResp.status < 400, `got ${spawnResp.status}`);
    const dbTask = new Database(TMP_DB, { readonly: true });
    const tasks = dbTask.prepare(`SELECT priority, iso_item_id FROM tasks WHERE workspace_id=? AND iso_item_id='clause-5.1' ORDER BY id DESC LIMIT 1`).get(wsId);
    ok('task created with priority field', tasks && ['low','normal','high','critical'].includes(tasks.priority), JSON.stringify(tasks));
    dbTask.close();

    console.log('\nSoA shows risk linkage');
    const soaResp = await get(`/workspaces/${wsId}/soa`);
    ok('SoA includes "Risks treated" header', soaResp.body.includes('Risks treated'), 'header missing');

    // Firm-manager cross-engagement surfaces (portfolio + calendar). The seeded
    // user is a firm manager, so they clear the firm.cross_view gate. Markers
    // are structural (grid scaffolding), not data-dependent, so these pass on
    // any seed - they catch render/route regressions, not specific content.
    console.log('\nfirm manager surfaces');
    const portfolioResp = await get('/portfolio');
    ok('GET /portfolio returns 200', portfolioResp.status === 200, `got ${portfolioResp.status}`);
    ok('portfolio renders the health board', portfolioResp.body.includes('Portfolio health'), 'heading missing');

    const calYear = await get('/calendar');
    ok('GET /calendar (year overview) returns 200', calYear.status === 200, `got ${calYear.status}`);
    ok('year view renders the connected month grid', calYear.body.includes('mc-year'), 'mc-year grid missing');
    ok('year view renders the 3 month rows', calYear.body.includes('mc-yrow'), 'mc-yrow rows missing');

    const calMonth = await get('/calendar?month=2026-05');
    ok('GET /calendar?month= (month detail) returns 200', calMonth.status === 200, `got ${calMonth.status}`);
    ok('month view renders the weekday day-grid header', calMonth.body.includes('mc-cal-head'), 'mc-cal-head missing');

    const wsCal = await get(`/workspaces/${wsId}/calendar`);
    ok('GET /workspaces/:id/calendar returns 200', wsCal.status === 200, `got ${wsCal.status}`);

    // Glossary is a firm-level reference page. The run has already visited
    // workspace pages above, so last_ws_id is set - that is the exact condition
    // that used to make /glossary inherit a stale client sidebar ("lands in a
    // client page"). Assert it renders the firm sidebar (Glossary nav present +
    // active) and did NOT leak the client sidebar.
    const glossary = await get('/glossary');
    ok('GET /glossary returns 200', glossary.status === 200, `got ${glossary.status}`);
    ok('glossary renders the firm sidebar with Glossary active',
       glossary.body.includes('href="/glossary" class="nav-item active"'),
       'firm-level active Glossary nav item missing');
    ok('glossary did not inherit the client sidebar',
       !glossary.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /glossary');

    // Playbooks, Firm library, and Admin email are the other firm-level pages
    // that shared the glossary defect (they rendered with the sticky client
    // sidebar). Same guard: firm sidebar present + active, client sidebar absent.
    // last_ws_id is still set from the workspace visits above.
    const playbooks = await get('/playbooks');
    ok('GET /playbooks returns 200', playbooks.status === 200, `got ${playbooks.status}`);
    ok('playbooks renders the firm sidebar with Playbooks active',
       playbooks.body.includes('href="/playbooks" class="nav-item active"'),
       'firm-level active Playbooks nav item missing');
    ok('playbooks did not inherit the client sidebar',
       !playbooks.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /playbooks');

    const playbookDetail = await get('/playbooks/kickoff');
    ok('GET /playbooks/:id (detail) returns 200', playbookDetail.status === 200, `got ${playbookDetail.status}`);
    ok('playbook detail did not inherit the client sidebar',
       playbookDetail.body.includes('href="/playbooks" class="nav-item active"') &&
       !playbookDetail.body.includes('>Compliance calendar<'),
       'playbook detail did not render the firm sidebar');

    const firmLib = await get('/firm/library');
    ok('GET /firm/library returns 200', firmLib.status === 200, `got ${firmLib.status}`);
    ok('firm library renders the firm sidebar with Library active',
       firmLib.body.includes('href="/firm/library" class="nav-item active"'),
       'firm-level active Library nav item missing');
    ok('firm library did not inherit the client sidebar',
       !firmLib.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /firm/library');

    const firmLibRisks = await get('/firm/library/risks');
    ok('GET /firm/library/risks returns 200', firmLibRisks.status === 200, `got ${firmLibRisks.status}`);
    ok('firm library risks did not inherit the client sidebar',
       firmLibRisks.body.includes('href="/firm/library" class="nav-item active"') &&
       !firmLibRisks.body.includes('>Compliance calendar<'),
       'firm library risks did not render the firm sidebar');

    // /admin/email is gated by isFirmOwner(), which in this codebase resolves to
    // rbac.isManager() - a firm manager IS allowed in. The seeded smoke user is a
    // manager, so this page is reachable and renders the same firm-level chrome.
    const adminEmail = await get('/admin/email');
    ok('GET /admin/email returns 200 (managers allowed)', adminEmail.status === 200, `got ${adminEmail.status}`);
    ok('admin email renders the firm sidebar with Admin email active',
       adminEmail.body.includes('href="/admin/email" class="nav-item active"'),
       'firm-level active Admin email nav item missing');
    ok('admin email did not inherit the client sidebar',
       !adminEmail.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /admin/email');

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
