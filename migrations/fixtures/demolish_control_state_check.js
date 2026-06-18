#!/usr/bin/env node
/**
 * demolish_control_state_check.js  (POST-DROP ROUTE-LEVEL E2E for the control-state demolition)
 *
 * Boots the real server on a copy of the live DB (the chain runs at boot, so
 * migration 019 DROPS control_states / iso42001_control_states + their 8 sync
 * triggers). Then exercises the major control-state surfaces over HTTP and asserts
 * the legacy tables are gone while control_instances + the views + history survive:
 *   - the previously-table-backed pages render 200 (assess wizard, SoA, summary,
 *     dashboard, readiness/auditor, crosswalks, controls, review-queue, 42001 roadmap);
 *   - assess save (27001) writes control_instances + appends a history snapshot;
 *   - SoA save + review lifecycle (flag -> approve -> clear) work converged;
 *   - 42001 assess save works.
 *
 *   node migrations/fixtures/demolish_control_state_check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-cs-'));
const TMP_DB = path.join(TMP, 'iso27001.db');
const PORT = 3413;
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), DB_PATH: TMP_DB,
  SESSION_SECRET: 'demo-cs-secret', DISABLE_CSRF: '1', PORT: String(PORT) };
const TEST_EMAIL = 'democs@test.local', TEST_PASSWORD = 'demo-cs-1234';

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
    else sdb.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES (?,?,'DemoCS',?, 'firm','manager',1)`).run(TEST_EMAIL, hash, firm.id);
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
    check('control_states demolished', !exTbl('control_states'), exTbl('control_states') ? 'present' : 'gone');
    check('iso42001_control_states demolished', !exTbl('iso42001_control_states'), exTbl('iso42001_control_states') ? 'present' : 'gone');
    check('control_instances + views + history survive', exTbl('control_instances') && exTbl('v_control_states') && exTbl('control_state_history') && exTbl('assessment_passes'), 'ok');
    const trig = vdb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND (name LIKE '%_to_ci_%' OR name LIKE 'ci_to_cs%')").get().n;
    check('control-state sync triggers gone (0)', trig === 0, `n=${trig}`);

    // ---- the surfaces that read the (now demolished) tables must still render 200 ----
    const pages = [
      ['assess wizard', `/workspaces/${ws}/controls/assess/annex-a.5.1`],
      ['SoA', `/workspaces/${ws}/soa`],
      ['assess summary', `/workspaces/${ws}/controls/assess/summary`],
      ['dashboard', `/dashboard`],
      ['readiness/auditor', `/workspaces/${ws}/readiness/auditor`],
      ['crosswalks', `/workspaces/${ws}/crosswalks`],
      ['controls list', `/workspaces/${ws}/iso42001/controls`],
      ['review-queue', `/workspaces/${ws}/review-queue`],
      ['42001 roadmap', `/workspaces/${ws}/iso42001/roadmap`],
      ['42001 SoA', `/workspaces/${ws}/iso42001/soa`],
    ];
    const bad = [];
    for (const [name, p] of pages) { const r = await get(p); if (r.status !== 200) bad.push(`${name}=${r.status}`); }
    check('all table-backed pages render 200', bad.length === 0, bad.join(' ') || 'all 200');

    // ---- assess save (27001) -> control_instances + history snapshot ----
    const ITEM = 'annex-a.5.1';
    const rid = vdb.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.ref=?`).get(ITEM).id;
    const histBefore = vdb.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM).c;
    const save = await post(`/workspaces/${ws}/controls/assess/${ITEM}`, { status: 'Implemented', applicability: 'included', maturity: 4, action: 'save', q_0: 'yes' });
    check('assess save accepted', save.status >= 300 && save.status < 400, `status=${save.status}`);
    const ci = vdb.prepare(`SELECT status FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid);
    check('assess save wrote control_instances (token)', ci && ci.status === 'implemented', ci && ci.status);
    const histAfter = vdb.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM).c;
    check('history snapshot appended (sourced from converged view)', histAfter === histBefore + 1, `before=${histBefore} after=${histAfter}`);

    // ---- SoA save ----
    const soa = await post(`/workspaces/${ws}/soa/${ITEM}`, { applicability: 'excluded', exclusion_justification: 'e2e', status: 'Not Applicable' });
    const ciSoa = vdb.prepare(`SELECT applicability FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid);
    check('SoA save converged (applicability=excluded)', ciSoa && ciSoa.applicability === 'excluded', ciSoa && ciSoa.applicability);

    // ---- review lifecycle ----
    await post(`/workspaces/${ws}/controls/assess/${ITEM}/flag-for-review`, { reason: 'r' });
    let rv = vdb.prepare(`SELECT review_status FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid);
    check('review flag -> requested (converged)', rv && rv.review_status === 'requested', rv && rv.review_status);
    await post(`/workspaces/${ws}/controls/assess/${ITEM}/review-action`, { action: 'approve' });
    rv = vdb.prepare(`SELECT review_status FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid);
    check('review approve -> reviewed (converged)', rv && rv.review_status === 'reviewed', rv && rv.review_status);
    await post(`/workspaces/${ws}/controls/assess/${ITEM}/clear-flag`, {});
    rv = vdb.prepare(`SELECT review_status FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid);
    check('review clear -> none (converged)', rv && rv.review_status === 'none', rv && rv.review_status);

    // ---- 42001 assess save ----
    const I42 = vdb.prepare(`SELECT i.id FROM iso42001_items i WHERE i.type='control' AND EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=i.id) LIMIT 1`).get();
    if (I42) {
      const r42 = vdb.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=?`).get(I42.id).id;
      const s42 = await post(`/workspaces/${ws}/iso42001/gap/${I42.id}`, { status: 'Implemented', applicability: 'included', action: 'save' });
      check('42001 assess save accepted', s42.status >= 300 && s42.status < 400, `status=${s42.status}`);
      const ci42 = vdb.prepare(`SELECT status FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, r42);
      check('42001 assess save wrote control_instances (token)', ci42 && ci42.status === 'implemented', ci42 && ci42.status);
    } else { check('42001 control mapping present', false, 'no mapping'); }

    vdb.close();
  } catch (e) { console.error('HARNESS ERROR:', e.message); failures++; }
  finally { if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM'); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
  const w = Math.max(...results.map(r => r[1].length), 10);
  for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
  console.log(`\ncontrol-state demolition check: ${results.length - failures}/${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
