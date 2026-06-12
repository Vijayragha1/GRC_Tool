#!/usr/bin/env node
/**
 * cutover4_w1_check.js  (BEHAVIORAL test for cutover-4 W1: lazy-create writes)
 *
 * Drives the REAL server.js getOrCreateState / getOrCreate42State against a
 * throwaway DB and proves that on a write-flipped workspace
 * (control_writes_converged=1) the lazy create writes the converged
 * control_instances as the authoritative row (mirrored to legacy by 014), while
 * still returning a full legacy-shaped row (assessment_answers preserved), and
 * that with the flag OFF the original legacy-only behaviour is unchanged.
 *
 *   node migrations/fixtures/cutover4_w1_check.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4w1-'));
const dbPath = path.join(tmpDir, 'c4w1.db');
process.env.DB_PATH = dbPath;

let failures = 0;
const results = [];
function check(name, cond, detail) { results.push([cond ? 'PASS' : 'FAIL', name, detail || '']); if (!cond) failures++; }

try {
  // Requiring server.js runs init() (schema + 012/013/014) against DB_PATH and
  // does NOT bind a port (listen is guarded by require.main === module).
  const srv = require(path.join(ROOT, 'server.js'));
  const db = srv.db;

  // seed frameworks + requirements (catalog backfill's soc2 dep was removed)
  db.prepare(`INSERT OR IGNORE INTO frameworks (code, name, version) VALUES ('iso27001','ISO/IEC 27001','2022')`).run();
  db.prepare(`INSERT OR IGNORE INTO frameworks (code, name, version) VALUES ('iso42001','ISO/IEC 42001','2023')`).run();
  const fwId = (c) => db.prepare(`SELECT id FROM frameworks WHERE code=?`).get(c).id;
  const insReq = db.prepare(`INSERT OR IGNORE INTO requirements (framework_id, ref, req_type, title) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (const i of db.prepare(`SELECT id, type, title FROM iso_items WHERE type IN ('clause','control')`).all())
      insReq.run(fwId('iso27001'), i.id, i.type === 'clause' ? 'clause' : 'control', i.title || i.id);
    for (const i of db.prepare(`SELECT id, title FROM iso42001_items`).all())
      insReq.run(fwId('iso42001'), i.id, 'control', i.title || i.id);
  })();

  const wsOff = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'W1 flag OFF')`).run().lastInsertRowid;
  const wsOn = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'W1 flag ON')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES ('control_writes_converged', ?, 1)`).run(wsOn);

  const ITEM = 'annex-a.5.1';
  const reqId = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.ref=?`).get(ITEM).id;
  const ciCount = (ws, rid) => db.prepare(`SELECT COUNT(*) n FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid).n;
  const ciSource = (ws, rid) => { const r = db.prepare(`SELECT migrated_from FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid); return r ? r.migrated_from : '(no row)'; };

  // Both tables are always populated during cutover 4 (013 + 014 both active);
  // the flag determines which side is AUTHORITATIVE. migrated_from distinguishes:
  // NULL = app wrote control_instances directly; 'sync:control_states' = the 013
  // trigger created it from a legacy write.

  // ---- flag OFF: legacy-primary; converged row exists only via 013 mirror ---
  const sOff = srv.getOrCreateState(wsOff, ITEM);
  check('OFF: returns a legacy-shaped row', sOff && sOff.iso_item_id === ITEM && 'assessment_answers' in sOff, sOff && Object.keys(sOff).length + ' cols');
  check('OFF: converged row exists but created by the 013 mirror (legacy-primary)', ciCount(wsOff, reqId) === 1 && ciSource(wsOff, reqId) === 'sync:control_states', `ci=${ciCount(wsOff, reqId)} src=${ciSource(wsOff, reqId)}`);

  // ---- flag ON: converged row is authoritative (app-written), legacy mirror --
  const sOn = srv.getOrCreateState(wsOn, ITEM);
  check('ON: converged row created by the app, authoritative (migrated_from NULL)', ciCount(wsOn, reqId) === 1 && ciSource(wsOn, reqId) === null, `ci=${ciCount(wsOn, reqId)} src=${ciSource(wsOn, reqId)}`);
  check('ON: still returns a full legacy-shaped row (assessment_answers present)', sOn && sOn.iso_item_id === ITEM && 'assessment_answers' in sOn, sOn && Object.keys(sOn).length + ' cols');
  check('ON: legacy control_states mirror exists (via 014)', !!db.prepare(`SELECT 1 FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(wsOn, ITEM), 'present');
  // idempotent: calling again does not duplicate
  srv.getOrCreateState(wsOn, ITEM);
  check('ON: idempotent (still exactly one converged row)', ciCount(wsOn, reqId) === 1, `ci=${ciCount(wsOn, reqId)}`);

  // ---- 42001 W1 ----------------------------------------------------------
  const I42 = db.prepare(`SELECT i.id FROM iso42001_items i WHERE EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=i.id) LIMIT 1`).get();
  if (I42) {
    const r42 = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=?`).get(I42.id).id;
    const s42 = srv.getOrCreate42State(wsOn, I42.id); // wsOn flag already set above
    check('42001 ON: converged row created', ciCount(wsOn, r42) === 1, `ci=${ciCount(wsOn, r42)}`);
    check('42001 ON: returns legacy-shaped row', s42 && s42.iso_item_id === I42.id, s42 && s42.iso_item_id);
    check('42001 ON: legacy iso42001_control_states mirror exists', !!db.prepare(`SELECT 1 FROM iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(wsOn, I42.id), 'present');
  } else {
    check('42001 mapping present', false, 'no iso42001 requirement mapping');
  }
} catch (e) {
  console.error('HARNESS ERROR:', e.message, '\n', e.stack);
  failures++;
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

const w = Math.max(...results.map(r => r[1].length), 10);
for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
console.log(`\ncutover4 W1 check: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
