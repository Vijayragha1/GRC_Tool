#!/usr/bin/env node
/**
 * cutover4_w2_check.js  (BEHAVIORAL test for cutover-4 W2: gap-assessment save)
 *
 * Proves the converged W2 write mechanism on a write-flipped workspace:
 *   - the authoritative state write lands in control_instances (normalized tokens),
 *     014 mirrors it to control_states (display values), last_verified_at stamped;
 *   - the optimistic-concurrency CAS runs against control_instances.last_updated:
 *     two competing saves with the same rendered snapshot -> the SECOND is rejected
 *     (changes=0), the conflict path the route turns into a 409;
 *   - EVERY writable status value round-trips, with both-direction consistency
 *     (control_instances token <-> control_states display) checked after each write;
 *   - assessment_answers (no converged column, deferred) is persisted to legacy.
 *
 * Uses the EXACT converged UPDATE + convergeSets the route handler runs. The full
 * route-level HTTP E2E (login + POST + history) is built at the cutover-4 gate.
 *
 *   node migrations/fixtures/cutover4_w2_check.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4w2-'));
const dbPath = path.join(tmpDir, 'c4w2.db');
const env = { ...process.env, DB_PATH: dbPath };
const ctlWrites = require(path.join(ROOT, 'lib', 'control-writes.js'));

let failures = 0;
const results = [];
function check(name, cond, detail) { results.push([cond ? 'PASS' : 'FAIL', name, detail || '']); if (!cond) failures++; }

try {
  execSync(`node -e "require('./db').init()"`, { cwd: ROOT, env, stdio: 'ignore' });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT OR IGNORE INTO frameworks (code, name, version) VALUES ('iso27001','ISO/IEC 27001','2022')`).run();
  const fwId = (c) => db.prepare(`SELECT id FROM frameworks WHERE code=?`).get(c).id;
  const insReq = db.prepare(`INSERT OR IGNORE INTO requirements (framework_id, ref, req_type, title) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (const i of db.prepare(`SELECT id, type, title FROM iso_items WHERE type IN ('clause','control')`).all())
      insReq.run(fwId('iso27001'), i.id, i.type === 'clause' ? 'clause' : 'control', i.title || i.id);
  })();

  const ws = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'W2 E2E')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES ('control_writes_converged', ?, 1)`).run(ws);
  db.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES ('control_reads_converged', ?, 1)`).run(ws);

  const ITEM = 'annex-a.5.1';
  const reqId = ctlWrites.requirementId(db, 'iso27001', ITEM);
  // getOrCreateState equivalent: authoritative converged create
  db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)`).run(ws, reqId);

  const viewRow = () => db.prepare(`SELECT status, applicability, last_updated, last_verified_at FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM);
  const ciRow = () => db.prepare(`SELECT status, applicability, last_updated FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, reqId);
  const csRow = () => db.prepare(`SELECT status, applicability, assessment_answers, last_verified_at FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM);

  // Replicate the handler's converged save exactly (convergeSets + CAS UPDATE).
  // Returns the better-sqlite3 run() result (with .changes).
  function convergedSave({ status, applicability, maturity, notes, answers, snapshot }) {
    const sets = [], vals = [];
    if (applicability !== undefined) { sets.push('applicability=?'); vals.push(applicability); }
    if (status !== undefined) { sets.push('status=?'); vals.push(status); }
    if (maturity !== undefined) { sets.push('maturity=?'); vals.push(maturity); }
    if (notes !== undefined) { sets.push('notes=?'); vals.push(notes); }
    if (answers && Object.keys(answers).length) { sets.push('assessment_answers=?'); vals.push(JSON.stringify(answers)); }
    sets.push('last_updated=CURRENT_TIMESTAMP');
    if (status && status !== 'Not Assessed') sets.push('last_verified_at=CURRENT_TIMESTAMP');
    const c = ctlWrites.convergeSets(sets, vals);
    const cVals = c.vals.slice();
    let sql = `UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`;
    cVals.push(ws, reqId);
    if (snapshot !== undefined) { sql += ` AND last_updated = ?`; cVals.push(snapshot); }
    const result = db.prepare(sql).run(...cVals);
    if (!(snapshot !== undefined && result.changes === 0) && answers && Object.keys(answers).length) {
      db.prepare(`UPDATE control_states SET assessment_answers=? WHERE workspace_id=? AND iso_item_id=?`).run(JSON.stringify(answers), ws, ITEM);
    }
    return result;
  }

  // ---- TEST 1: converged save lands authoritative + 014 mirror consistent ---
  convergedSave({ status: 'Implemented', applicability: 'included', maturity: 4, notes: 'n', answers: { 0: 'yes' } });
  check('1 control_instances has normalized token', ciRow().status === 'implemented' && ciRow().applicability === 'applicable', `${ciRow().status}/${ciRow().applicability}`);
  check('1 014 mirror: control_states display consistent', csRow().status === 'Implemented' && csRow().applicability === 'included', `${csRow().status}/${csRow().applicability}`);
  check('1 last_verified_at stamped (status != Not Assessed)', !!csRow().last_verified_at, csRow().last_verified_at || 'null');
  check('1 assessment_answers persisted to legacy (deferred column)', csRow().assessment_answers === '{"0":"yes"}', csRow().assessment_answers);
  check('1 converged read view shows display status', viewRow().status === 'Implemented', viewRow().status);

  // ---- TEST 2: CAS conflict on the converged table -------------------------
  // Two consultants render the form at the SAME snapshot. Seed a known past
  // last_updated so the first save provably advances it (CURRENT_TIMESTAMP has
  // second granularity, so without this two saves in the same second would not
  // differ; the legacy CAS has the same property). First save wins; the second,
  // carrying the now-stale snapshot, must be rejected.
  db.prepare(`UPDATE control_instances SET last_updated='2000-01-01 00:00:00' WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(ws, reqId);
  const snap = viewRow().last_updated;          // both consultants render with this
  check('2 setup: snapshot is the seeded stamp', snap === '2000-01-01 00:00:00', snap);
  const r1 = convergedSave({ status: 'Partially Implemented', snapshot: snap });
  check('2 first save with the rendered snapshot succeeds', r1.changes === 1 && ciRow().status === 'partially_implemented', `changes=${r1.changes}`);
  const r2 = convergedSave({ status: 'Not Implemented', snapshot: snap });   // same snapshot, now STALE
  check('2 second competing save with STALE snapshot is rejected (would 409)', r2.changes === 0, `changes=${r2.changes}`);
  check('2 rejected save did not change state', ciRow().status === 'partially_implemented', ciRow().status);
  const snap2 = viewRow().last_updated;         // re-render, fresh snapshot
  const r3 = convergedSave({ status: 'Not Implemented', snapshot: snap2 });
  check('2 re-rendered fresh snapshot succeeds', r3.changes === 1 && ciRow().status === 'not_implemented', `changes=${r3.changes} status=${ciRow().status}`);

  // ---- TEST 3: every writable status value round-trips, both directions -----
  const STATUSES = ['Implemented', 'Partially Implemented', 'Work In Progress', 'Not Assessed', 'Not Implemented', 'Not Applicable'];
  const TOKENS = { 'Implemented': 'implemented', 'Partially Implemented': 'partially_implemented', 'Work In Progress': 'work_in_progress', 'Not Assessed': 'not_assessed', 'Not Implemented': 'not_implemented', 'Not Applicable': 'not_applicable' };
  let allOk = true, bad = '';
  for (const s of STATUSES) {
    convergedSave({ status: s });
    const ci = ciRow(), cs = csRow(), v = viewRow();
    if (ci.status !== TOKENS[s] || cs.status !== s || v.status !== s) { allOk = false; bad = `${s}: ci=${ci.status} cs=${cs.status} view=${v.status}`; break; }
  }
  check('3 every status: converged token <-> legacy display consistent (both directions)', allOk, bad || 'all 6 ok');

  db.close();
} catch (e) {
  console.error('HARNESS ERROR:', e.message, '\n', e.stack);
  failures++;
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

const w = Math.max(...results.map(r => r[1].length), 10);
for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
console.log(`\ncutover4 W2 check: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
