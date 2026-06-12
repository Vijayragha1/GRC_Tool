#!/usr/bin/env node
/**
 * cutover3_sync_check.js  (BEHAVIORAL test for the cutover-3 legacy->converged sync)
 *
 * Proves the core cutover-3 invariant: on a workspace whose control READS are
 * flipped to the converged views (control_reads_converged=1), a LEGACY write
 * (control_states / iso42001_control_states / document_controls) is reflected by
 * the converged read IMMEDIATELY, via the migration 013 sync triggers. This is
 * what makes the read cutover self-consistent before writes move (cutover 4).
 *
 * Self-contained: builds a throwaway DB through the real chain
 *   1. require('./db').init()  -> schema + 012 views + 013 triggers
 *   2. populate `requirements` from the seeded iso_items / iso42001_items catalogs
 *      (the trigger's iso_item_id -> requirement_id mapping; the live DB has this
 *      from the Phase 1 data backfill, but that script's soc2 catalog was removed
 *      when soc2 was descoped, so we reproduce just the iso mapping the test needs)
 * then drives legacy writes and asserts the converged view + control-reads.js path.
 *
 *   node migrations/fixtures/cutover3_sync_check.js
 *
 * Exit 0 = all assertions pass; exit 1 = a sync gap (cutover-3 merge blocked).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3sync-'));
const dbPath = path.join(tmpDir, 'c3.db');
const env = { ...process.env, DB_PATH: dbPath };

function step(cmd) { execSync(cmd, { cwd: ROOT, env, stdio: 'ignore' }); }

let failures = 0;
const results = [];
function check(name, cond, detail) {
  results.push([cond ? 'PASS' : 'FAIL', name, detail || '']);
  if (!cond) failures++;
}

try {
  // ---- build the chain on a throwaway DB --------------------------------
  step(`node -e "require('./db').init()"`);              // schema + 012 + 013

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const ctlReads = require(path.join(ROOT, 'lib', 'control-reads.js'));

  // Populate `frameworks` + `requirements` from the seeded catalogs so the
  // trigger mapping (iso_item_id -> requirement_id) resolves, matching the live
  // data shape (both are empty on a bare boot; the live DB has them from Phase 1).
  db.prepare(`INSERT OR IGNORE INTO frameworks (code, name, version) VALUES ('iso27001','ISO/IEC 27001','2022')`).run();
  db.prepare(`INSERT OR IGNORE INTO frameworks (code, name, version) VALUES ('iso42001','ISO/IEC 42001','2023')`).run();
  const fwId = (code) => db.prepare(`SELECT id FROM frameworks WHERE code=?`).get(code).id;
  const insReq = db.prepare(`INSERT OR IGNORE INTO requirements (framework_id, ref, req_type, title) VALUES (?, ?, ?, ?)`);
  const popReq = db.transaction(() => {
    for (const i of db.prepare(`SELECT id, type, title FROM iso_items WHERE type IN ('clause','control')`).all()) {
      insReq.run(fwId('iso27001'), i.id, i.type === 'clause' ? 'clause' : 'control', i.title || i.id);
    }
    for (const i of db.prepare(`SELECT id, title FROM iso42001_items`).all()) {
      insReq.run(fwId('iso42001'), i.id, 'control', i.title || i.id);
    }
  });
  popReq();

  // sanity: triggers + views + requirements present
  const trigN = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE '%_to_%'").get().n;
  check('013 sync triggers installed (10)', trigN === 10, `found ${trigN}`);
  const reqN = db.prepare("SELECT COUNT(*) n FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001'").get().n;
  check('iso27001 requirements populated', reqN > 0, `${reqN} requirements`);

  // ---- a read-flipped workspace -----------------------------------------
  const ws = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'C3 Sync Test')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES ('control_reads_converged', ?, 1)`).run(ws);
  const t = ctlReads.tables(db, ws);
  check('read switch points at the converged view', t.cs === 'v_control_states' && t.cs42 === 'v_iso42001_control_states' && t.doc === 'v_document_controls', `cs=${t.cs}`);

  const ITEM = 'annex-a.5.1';
  const readCs = (item) => db.prepare(`SELECT status, applicability, maturity, owner_id, inclusion_justification, last_updated FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, item);
  const ciRow = (item, fw) => db.prepare(`SELECT ci.status, ci.applicability, ci.migrated_from, COUNT(*) OVER () AS n
     FROM control_instances ci JOIN requirements rq ON rq.id=ci.requirement_id JOIN frameworks f ON f.id=rq.framework_id
     WHERE ci.workspace_id=? AND ci.entity_id IS NULL AND f.code=? AND rq.ref=?`).get(ws, fw, item);

  // ---- TEST 1: legacy INSERT (lazy create) -> converged read sees it -----
  db.prepare(`INSERT INTO control_states (workspace_id, iso_item_id) VALUES (?, ?)`).run(ws, ITEM);
  let r = readCs(ITEM);
  check('1 INSERT: converged read reflects the new row', !!r, r ? 'present' : 'row missing from v_control_states');
  check('1 INSERT: default status de-normalizes to Not Assessed', r && r.status === 'Not Assessed', r && r.status);
  let ci = ciRow(ITEM, 'iso27001');
  check('1 INSERT: exactly one converged whole-org row created', ci && ci.n === 1, ci && `n=${ci.n}`);
  check('1 INSERT: converged row tagged migrated_from=sync', ci && ci.migrated_from === 'sync:control_states', ci && ci.migrated_from);

  // ---- TEST 2: legacy UPDATE -> converged read reflects, last_updated verbatim
  const STAMP = '2026-06-11 09:00:00';
  db.prepare(`UPDATE control_states SET status='Implemented', applicability='included', maturity=4, owner_id=1, inclusion_justification='because', last_updated=? WHERE workspace_id=? AND iso_item_id=?`).run(STAMP, ws, ITEM);
  r = readCs(ITEM);
  check('2 UPDATE: status reflected', r && r.status === 'Implemented', r && r.status);
  check('2 UPDATE: applicability reflected', r && r.applicability === 'included', r && r.applicability);
  check('2 UPDATE: maturity reflected', r && r.maturity === 4, r && String(r.maturity));
  check('2 UPDATE: owner_id reflected', r && r.owner_id === 1, r && String(r.owner_id));
  check('2 UPDATE: justification reflected', r && r.inclusion_justification === 'because', r && r.inclusion_justification);
  check('2 UPDATE: last_updated copied VERBATIM (byte-parity)', r && r.last_updated === STAMP, r && r.last_updated);
  ci = ciRow(ITEM, 'iso27001');
  check('2 UPDATE: converged status normalized to token', ci && ci.status === 'implemented', ci && ci.status);
  check('2 UPDATE: converged applicability normalized to token', ci && ci.applicability === 'applicable', ci && ci.applicability);
  check('2 UPDATE: still exactly one converged row (no dup)', ci && ci.n === 1, ci && `n=${ci.n}`);

  // ---- TEST 3: every writable status value round-trips the sync ----------
  const STATUSES = ['Implemented', 'Partially Implemented', 'Work In Progress', 'Not Assessed', 'Not Implemented', 'Not Applicable'];
  const TOKENS = { 'Implemented': 'implemented', 'Partially Implemented': 'partially_implemented', 'Work In Progress': 'work_in_progress', 'Not Assessed': 'not_assessed', 'Not Implemented': 'not_implemented', 'Not Applicable': 'not_applicable' };
  let allRound = true, badStatus = '';
  for (const s of STATUSES) {
    db.prepare(`UPDATE control_states SET status=? WHERE workspace_id=? AND iso_item_id=?`).run(s, ws, ITEM);
    const rr = readCs(ITEM);
    const cc = ciRow(ITEM, 'iso27001');
    if (!rr || rr.status !== s || !cc || cc.status !== TOKENS[s]) { allRound = false; badStatus = `${s} -> view=${rr && rr.status} token=${cc && cc.status}`; break; }
  }
  check('3 every status value round-trips view + normalizes token', allRound, badStatus);

  // ---- TEST 4: document-link legacy INSERT/DELETE -> converged doc read ---
  const doc = db.prepare(`INSERT INTO generated_docs (workspace_id, name, created_by) VALUES (?, 'Policy', 1)`).run(ws).lastInsertRowid;
  db.prepare(`INSERT INTO document_controls (document_id, iso_item_id, section_ref) VALUES (?, ?, '4.2')`).run(doc, ITEM);
  let dl = db.prepare(`SELECT section_ref FROM v_document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, ITEM);
  check('4 doc-link INSERT: converged doc read reflects it', dl && dl.section_ref === '4.2', dl && dl.section_ref);
  db.prepare(`DELETE FROM document_controls WHERE document_id=? AND iso_item_id=?`).run(doc, ITEM);
  dl = db.prepare(`SELECT section_ref FROM v_document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, ITEM);
  check('4 doc-link DELETE: converged doc read drops it', !dl, dl ? 'still present' : 'gone');

  // ---- TEST 5: ISO 42001 parity -----------------------------------------
  const I42 = db.prepare(`SELECT i.id FROM iso42001_items i WHERE EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=i.id) LIMIT 1`).get();
  if (I42) {
    const item42 = I42.id;
    db.prepare(`INSERT INTO iso42001_control_states (workspace_id, iso_item_id, status, applicability, last_updated) VALUES (?, ?, 'Partially Implemented', 'excluded', '2026-06-11 10:00:00')`).run(ws, item42);
    const r42 = db.prepare(`SELECT status, applicability, last_updated FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, item42);
    check('5 42001 INSERT: converged read reflects status', r42 && r42.status === 'Partially Implemented', r42 && r42.status);
    check('5 42001 INSERT: applicability reflected', r42 && r42.applicability === 'excluded', r42 && r42.applicability);
    check('5 42001 INSERT: last_updated verbatim', r42 && r42.last_updated === '2026-06-11 10:00:00', r42 && r42.last_updated);
    const cc42 = ciRow(item42, 'iso42001');
    check('5 42001 INSERT: converged token normalized', cc42 && cc42.status === 'partially_implemented', cc42 && cc42.status);
  } else {
    check('5 42001 mapping present', false, 'no iso42001 requirement mapping found');
  }

  // ---- TEST 6: flag OFF falls back to legacy table (no view) -------------
  db.prepare(`UPDATE feature_flags SET enabled=0 WHERE key='control_reads_converged' AND workspace_id=?`).run(ws);
  check('6 flag OFF: read switch falls back to legacy table', ctlReads.tables(db, ws).cs === 'control_states', ctlReads.tables(db, ws).cs);

  db.close();
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ---- report -----------------------------------------------------------------
const w = Math.max(...results.map(r => r[1].length), 10);
for (const [st, name, detail] of results) {
  console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
}
console.log(`\ncutover3 sync check: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
