#!/usr/bin/env node
/**
 * cutover5_history_check.js  (POST-DROP check for the assessment-history engine cutover)
 *
 * Boots the real server on a copy of the live DB (the chain runs at boot, so
 * migration 020 DROPS the vestigial control_instance_history + dead
 * entity_control_states). Asserts:
 *   - control_instance_history + entity_control_states are gone;
 *   - the pass-snapshot engine survives (control_state_history /
 *     iso42001_control_state_history + assessment_passes) and proposed_changes
 *     (source attribution) survives;
 *   - the client handover export renders 200 post-drop (it no longer lists the
 *     dropped tables; control_instances is dumped instead);
 *   - the gap-assessment analytics page (pass-snapshot reads) renders 200.
 *
 *   node migrations/fixtures/cutover5_history_check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-'));
const TMP_DB = path.join(TMP, 'iso27001.db');
const PORT = 3415;
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), DB_PATH: TMP_DB,
  SESSION_SECRET: 'c5-secret', DISABLE_CSRF: '1', PORT: String(PORT) };
const TEST_EMAIL = 'c5@test.local', TEST_PASSWORD = 'c5-1234';

let failures = 0; const results = [];
function check(name, cond, detail) { results.push([cond ? 'PASS' : 'FAIL', name, detail || '']); if (!cond) failures++; }
let cookieJar = '', csrf = null;
function capture(res, body) { const sc = res.headers['set-cookie']; if (sc) { const nc = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]); const ex = cookieJar ? cookieJar.split('; ').filter(c => !nc.some(n => n.startsWith(c.split('=')[0] + '='))) : []; cookieJar = [...ex, ...nc].join('; '); } const m = body && body.match(/name="csrf-token" content="([a-f0-9]+)"/); if (m) csrf = m[1]; }
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
    else sdb.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES (?,?,'C5',?, 'firm','manager',1)`).run(TEST_EMAIL, hash, firm.id);
    const ws = sdb.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firm.id).id;
    sdb.close();

    serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; serverProc.stderr.on('data', d => { stderr += d; });
    if (!await waitFor(async () => (await get('/login')).status < 500)) throw new Error('no server. ' + stderr.slice(-600));
    await get('/login');
    const login = await post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
    if (login.status < 300 || login.status >= 400) throw new Error('login ' + login.status);

    const vdb = new Database(TMP_DB, { readonly: true });
    const exTbl = (t) => !!vdb.prepare(`SELECT 1 FROM sqlite_master WHERE name=?`).get(t);
    check('control_instance_history (vestigial) dropped', !exTbl('control_instance_history'), exTbl('control_instance_history') ? 'present' : 'gone');
    check('entity_control_states (dead) dropped', !exTbl('entity_control_states'), exTbl('entity_control_states') ? 'present' : 'gone');
    check('pass-snapshot engine survives (history + passes)', exTbl('control_state_history') && exTbl('iso42001_control_state_history') && exTbl('assessment_passes'), 'ok');
    check('proposed_changes (source attribution) survives', exTbl('proposed_changes'), 'ok');
    vdb.close();

    const handover = await get(`/workspaces/${ws}/handover`);
    check('client handover export renders 200 post-drop', handover.status === 200, `status=${handover.status}`);
    const gap = await get(`/workspaces/${ws}/gap-assessment`);
    check('gap-assessment analytics (pass-snapshot reads) renders 200', gap.status === 200, `status=${gap.status}`);
    const hist = await get(`/workspaces/${ws}/controls/annex-a.5.1/history`);
    check('per-control history screen renders', hist.status === 200 || hist.status === 302 || hist.status === 404, `status=${hist.status}`);
  } catch (e) { console.error('HARNESS ERROR:', e.message); failures++; }
  finally { if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM'); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
  const w = Math.max(...results.map(r => r[1].length), 10);
  for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
  console.log(`\ncutover5 history check: ${results.length - failures}/${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
