#!/usr/bin/env node
/**
 * review_convergence_check.js  (ROUTE-LEVEL E2E + render parity for the review mini-step)
 *
 * Boots the real server on a copy of the live DB and drives the review lifecycle
 * (flag-for-review -> review-action approve -> clear-flag) over HTTP on a
 * write-flipped workspace, asserting after each step that the converged
 * control_instances review columns are authoritative AND the legacy control_states
 * mirror matches (014). Then checks review-queue READ parity (the converged views
 * vs the legacy tables) across ALL workspaces.
 *
 *   node migrations/fixtures/review_convergence_check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-e2e-'));
const TMP_DB = path.join(TMP, 'iso27001.db');
const PORT = 3409;
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), DB_PATH: TMP_DB,
  SESSION_SECRET: 'rc-e2e-fixed-secret', DISABLE_CSRF: '1', PORT: String(PORT) };
const TEST_EMAIL = 'rc@test.local', TEST_PASSWORD = 'rc-password-1234';

let failures = 0; const results = [];
function check(name, cond, detail) { results.push([cond ? 'PASS' : 'FAIL', name, detail || '']); if (!cond) failures++; }
let cookieJar = '', csrf = null;
function capture(res, body) {
  const sc = res.headers['set-cookie'];
  if (sc) { const nc = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
    const ex = cookieJar ? cookieJar.split('; ').filter(c => !nc.some(n => n.startsWith(c.split('=')[0] + '='))) : [];
    cookieJar = [...ex, ...nc].join('; '); }
  const m = body && body.match(/name="csrf-token" content="([a-f0-9]+)"/); if (m) csrf = m[1];
}
function get(p) { return new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers: cookieJar ? { cookie: cookieJar } : {} }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => { capture(x, b); res({ status: x.statusCode, body: b }); }); }); r.on('error', rej); r.end(); }); }
function post(p, form) { return new Promise((res, rej) => { const payload = { ...form }; if (csrf && !payload._csrf) payload._csrf = csrf; const body = Object.entries(payload).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`).join('&'); const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }; if (cookieJar) headers['cookie'] = cookieJar; const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => { capture(x, b); res({ status: x.statusCode, body: b }); }); }); r.on('error', rej); r.write(body); r.end(); }); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (_) {} await wait(150); } return false; }

let serverProc = null;
(async () => {
  try {
    const seedDb = path.join(ROOT, 'iso27001.db');
    if (!fs.existsSync(seedDb)) { console.log('SKIP: no live iso27001.db'); process.exit(0); }
    fs.copyFileSync(seedDb, TMP_DB);
    const bcrypt = require('bcrypt');
    const sdb = new Database(TMP_DB);
    const firm = sdb.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    const hash = bcrypt.hashSync(TEST_PASSWORD, 4);
    const ex = sdb.prepare('SELECT id FROM users WHERE email=?').get(TEST_EMAIL);
    if (ex) sdb.prepare(`UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?`).run(hash, firm.id, ex.id);
    else sdb.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES (?,?,'RC',?, 'firm','manager',1)`).run(TEST_EMAIL, hash, firm.id);
    const ws = sdb.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firm.id).id;
    const setFlag = (k, w, v) => { sdb.prepare(`DELETE FROM feature_flags WHERE key=? AND workspace_id=?`).run(k, w); sdb.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES (?,?,?)`).run(k, w, v); };
    setFlag('control_reads_converged', ws, 1); setFlag('control_writes_converged', ws, 1);
    sdb.close();

    serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; serverProc.stderr.on('data', d => { stderr += d; });
    if (!await waitFor(async () => (await get('/login')).status < 500)) throw new Error('no server. ' + stderr.slice(-400));
    await get('/login');
    const login = await post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
    if (login.status < 300 || login.status >= 400) throw new Error('login ' + login.status);

    const vdb = new Database(TMP_DB, { readonly: true });
    const ITEM = 'annex-a.5.1';
    const rid = vdb.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.ref=?`).get(ITEM).id;
    const ci = () => vdb.prepare(`SELECT review_status, review_requested_by, review_reason, reviewed_by FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid);
    const cs = () => vdb.prepare(`SELECT review_status, review_requested_by, review_reason, reviewed_by FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM);
    const me = vdb.prepare('SELECT id FROM users WHERE email=?').get(TEST_EMAIL).id;

    // ---- flag-for-review (request) ----
    const r1 = await post(`/workspaces/${ws}/controls/assess/${ITEM}/flag-for-review`, { reason: 'please review' });
    check('flag-for-review accepted', r1.status >= 300 && r1.status < 400, `status=${r1.status}`);
    check('request: converged review_status=requested + requester + reason', ci() && ci().review_status === 'requested' && ci().review_requested_by === me && ci().review_reason === 'please review', JSON.stringify(ci()));
    check('request: legacy mirror matches (014)', cs() && cs().review_status === 'requested' && cs().review_requested_by === me && cs().review_reason === 'please review', JSON.stringify(cs()));

    // ---- review-action approve ----
    const r2 = await post(`/workspaces/${ws}/controls/assess/${ITEM}/review-action`, { action: 'approve', note: 'ok' });
    check('review-action accepted', r2.status >= 300 && r2.status < 400, `status=${r2.status}`);
    check('approve: converged review_status=reviewed + reviewer', ci() && ci().review_status === 'reviewed' && ci().reviewed_by === me, JSON.stringify(ci()));
    check('approve: legacy mirror matches (014)', cs() && cs().review_status === 'reviewed' && cs().reviewed_by === me, JSON.stringify(cs()));

    // ---- review-queue renders + shows the item ----
    const q = await get(`/workspaces/${ws}/review-queue?filter=all`);
    check('review-queue renders 200', q.status === 200, `status=${q.status}`);

    // ---- clear-flag ----
    const r3 = await post(`/workspaces/${ws}/controls/assess/${ITEM}/clear-flag`, {});
    check('clear-flag accepted', r3.status >= 300 && r3.status < 400, `status=${r3.status}`);
    check('clear: converged review_status=none + all NULL', ci() && ci().review_status === 'none' && ci().review_requested_by === null && ci().reviewed_by === null && ci().review_reason === null, JSON.stringify(ci()));
    check('clear: legacy mirror matches (014)', cs() && cs().review_status === 'none' && cs().review_requested_by === null && cs().reviewed_by === null, JSON.stringify(cs()));

    // ---- queue READ parity (views vs legacy) across ALL workspaces ----
    const queueRead = (csTbl, cs42Tbl, w) => {
      const a = vdb.prepare(`SELECT cs.iso_item_id, cs.review_status, cs.review_requested_at, cs.reviewed_at, cs.review_reason, cs.review_requested_by, cs.reviewed_by FROM ${csTbl} cs WHERE cs.workspace_id=? AND cs.review_status!='none' ORDER BY cs.iso_item_id`).all(w);
      const b = vdb.prepare(`SELECT cs.iso_item_id, cs.review_status, cs.review_requested_at, cs.reviewed_at, cs.review_reason, cs.review_requested_by, cs.reviewed_by FROM ${cs42Tbl} cs WHERE cs.workspace_id=? AND cs.review_status!='none' ORDER BY cs.iso_item_id`).all(w);
      return JSON.stringify({ a, b });
    };
    const allWs = vdb.prepare('SELECT id FROM workspaces ORDER BY id').all().map(r => r.id);
    let parityOk = true, parityBad = '';
    for (const w of allWs) {
      const legacy = queueRead('control_states', 'iso42001_control_states', w);
      const view = queueRead('v_control_states', 'v_iso42001_control_states', w);
      if (legacy !== view) { parityOk = false; parityBad = `ws${w}`; break; }
    }
    check(`review-queue read parity (view == legacy) across all ${allWs.length} workspaces`, parityOk, parityBad || 'identical');

    vdb.close();
  } catch (e) { console.error('HARNESS ERROR:', e.message); failures++; }
  finally { if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM'); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
  const w = Math.max(...results.map(r => r[1].length), 10);
  for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
  console.log(`\nreview-convergence check: ${results.length - failures}/${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
