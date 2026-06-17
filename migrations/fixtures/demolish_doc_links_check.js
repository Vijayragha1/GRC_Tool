#!/usr/bin/env node
/**
 * demolish_doc_links_check.js  (POST-DROP ROUTE-LEVEL E2E for the doc-link demolition)
 *
 * Boots the real server on a copy of the live DB (the migration chain runs at boot,
 * so migration 018 DROPS document_controls / iso42001_document_controls + their
 * triggers + the compat views). Then exercises the drl-native doc-link routes over
 * HTTP and asserts the legacy tables are gone:
 *   - control-side add -> drl row created; the assess panel renders link_id = drl.id;
 *     unlink by that id removes the drl row;
 *   - 42001 add/unlink drl-native;
 *   - document_controls / iso42001_document_controls + the doc views no longer exist.
 *
 *   node migrations/fixtures/demolish_doc_links_check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-dl-'));
const TMP_DB = path.join(TMP, 'iso27001.db');
const PORT = 3411;
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), DB_PATH: TMP_DB,
  SESSION_SECRET: 'demo-dl-secret', DISABLE_CSRF: '1', PORT: String(PORT) };
const TEST_EMAIL = 'demodl@test.local', TEST_PASSWORD = 'demo-dl-1234';

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
    else sdb.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES (?,?,'DemoDL',?, 'firm','manager',1)`).run(TEST_EMAIL, hash, firm.id);
    const ws = sdb.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firm.id).id;
    // a document to link
    const docId = sdb.prepare(`INSERT INTO generated_docs (workspace_id, name, created_by) VALUES (?, 'DemoDL Policy', ?)`).run(ws, ex ? ex.id : 1).lastInsertRowid;
    sdb.close();

    serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; serverProc.stderr.on('data', d => { stderr += d; });
    if (!await waitFor(async () => (await get('/login')).status < 500)) throw new Error('no server. ' + stderr.slice(-500));
    await get('/login');
    const login = await post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
    if (login.status < 300 || login.status >= 400) throw new Error('login ' + login.status);

    const vdb = new Database(TMP_DB, { readonly: true });
    const exists = (t) => !!vdb.prepare(`SELECT 1 FROM sqlite_master WHERE name=?`).get(t);
    check('document_controls table demolished at runtime', !exists('document_controls'), exists('document_controls') ? 'still present' : 'gone');
    check('iso42001_document_controls demolished', !exists('iso42001_document_controls'), exists('iso42001_document_controls') ? 'still present' : 'gone');
    check('doc compat views demolished', !exists('v_document_controls') && !exists('v_iso42001_document_controls'), 'gone');
    check('drl + control views survive', exists('document_requirement_links') && exists('v_control_states'), 'ok');

    const ITEM = 'annex-a.5.1';
    const rid = vdb.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.ref=?`).get(ITEM).id;
    const drlCount = () => vdb.prepare(`SELECT COUNT(*) n FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).get(docId, rid).n;

    // ---- control-side add (drl-native) ----
    const add = await post(`/workspaces/${ws}/controls/${ITEM}/documents`, { document_id: docId, section_ref: '4.2' });
    check('control-side add accepted', add.status >= 300 && add.status < 400, `status=${add.status}`);
    check('add: drl link row created', drlCount() === 1, `drl=${drlCount()}`);

    // ---- assess panel renders the link with link_id = drl.id ----
    const page = await get(`/workspaces/${ws}/controls/assess/${ITEM}`);
    const drlId = vdb.prepare(`SELECT id FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).get(docId, rid).id;
    check('assess panel renders 200', page.status === 200, `status=${page.status}`);
    check('panel exposes the drl-native unlink link_id', page.body.includes(`/documents/${drlId}/delete`), `expected link_id=${drlId}`);

    // ---- unlink by drl.id ----
    const del = await post(`/workspaces/${ws}/controls/${ITEM}/documents/${drlId}/delete`, {});
    check('unlink accepted', del.status >= 300 && del.status < 400, `status=${del.status}`);
    check('unlink: drl link row gone', drlCount() === 0, `drl=${drlCount()}`);

    // ---- 42001 add/unlink drl-native ----
    const I42 = vdb.prepare(`SELECT i.id FROM iso42001_items i WHERE EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=i.id) LIMIT 1`).get();
    if (I42) {
      const r42 = vdb.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=?`).get(I42.id).id;
      const d42 = () => vdb.prepare(`SELECT COUNT(*) n FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).get(docId, r42).n;
      const a42 = await post(`/workspaces/${ws}/iso42001/controls/${I42.id}/documents`, { document_id: docId, section_ref: '9.1' });
      check('42001 add accepted + drl row', a42.status >= 300 && a42.status < 400 && d42() === 1, `status=${a42.status} drl=${d42()}`);
      const drl42Id = vdb.prepare(`SELECT id FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).get(docId, r42).id;
      const u42 = await post(`/workspaces/${ws}/iso42001/controls/${I42.id}/documents/${drl42Id}/delete`, {});
      check('42001 unlink accepted + drl row gone', u42.status >= 300 && u42.status < 400 && d42() === 0, `status=${u42.status} drl=${d42()}`);
    } else { check('42001 mapping present', false, 'no mapping'); }

    vdb.close();
  } catch (e) { console.error('HARNESS ERROR:', e.message); failures++; }
  finally { if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM'); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }
  const w = Math.max(...results.map(r => r[1].length), 10);
  for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
  console.log(`\ndoc-link demolition check: ${results.length - failures}/${results.length} passed`);
  process.exit(failures ? 1 : 0);
})();
