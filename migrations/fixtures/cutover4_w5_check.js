#!/usr/bin/env node
/**
 * cutover4_w5_check.js  (BEHAVIORAL test for cutover-4 W5: bulk/autosave/verify)
 *
 * Covers the remaining converged write surfaces:
 *   - autosave: a W2-class write WITH CAS via convergeSets -> CAS enforced on
 *     control_instances.last_updated (second competing save rejected);
 *   - bulk-controls (per-row dynamic sets): full per-row mirror consistency;
 *   - NC-close last_verified_at bump: converged ensure+update, 014 mirrors;
 *   - 42001 bulk toggle: status/applicability normalized + mirrored.
 *
 * Uses the EXACT converged SQL/helpers the handlers run. Route-level E2E at the gate.
 *   node migrations/fixtures/cutover4_w5_check.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4w5-'));
const dbPath = path.join(tmpDir, 'c4w5.db');
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
  db.prepare(`INSERT OR IGNORE INTO frameworks (code, name, version) VALUES ('iso42001','ISO/IEC 42001','2023')`).run();
  const fwId = (c) => db.prepare(`SELECT id FROM frameworks WHERE code=?`).get(c).id;
  const insReq = db.prepare(`INSERT OR IGNORE INTO requirements (framework_id, ref, req_type, title) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (const i of db.prepare(`SELECT id, type, title FROM iso_items WHERE type IN ('clause','control')`).all())
      insReq.run(fwId('iso27001'), i.id, i.type === 'clause' ? 'clause' : 'control', i.title || i.id);
    for (const i of db.prepare(`SELECT id, title FROM iso42001_items`).all())
      insReq.run(fwId('iso42001'), i.id, 'control', i.title || i.id);
  })();

  const ws = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'W5')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES ('control_writes_converged', ?, 1)`).run(ws);
  const ITEM = 'annex-a.5.1';
  const rid = ctlWrites.requirementId(db, 'iso27001', ITEM);
  db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)`).run(ws, rid);
  const ci = () => db.prepare(`SELECT status, applicability, last_verified_at, last_updated FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, rid);
  const cs = () => db.prepare(`SELECT status, applicability, last_verified_at FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM);

  // ---- autosave CAS (dynamic sets via convergeSets) ----
  function autosave(fields, clientStamp) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); vals.push(v); }
    sets.push('last_updated=CURRENT_TIMESTAMP');
    const c = ctlWrites.convergeSets(sets, vals);
    const cVals = c.vals.slice();
    let sql = `UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`;
    cVals.push(ws, rid);
    if (clientStamp !== undefined) { sql += ` AND last_updated = ?`; cVals.push(clientStamp); }
    return db.prepare(sql).run(...cVals);
  }
  autosave({ status: 'Implemented', applicability: 'included', maturity: 3 });
  check('autosave: converged token write + 014 mirror', ci().status === 'implemented' && cs().status === 'Implemented' && cs().applicability === 'included', `${ci().status}/${cs().status}/${cs().applicability}`);
  db.prepare(`UPDATE control_instances SET last_updated='2000-01-01 00:00:00' WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(ws, rid);
  const snap = ci().last_updated;
  const a1 = autosave({ status: 'Partially Implemented' }, snap);
  const a2 = autosave({ status: 'Not Implemented' }, snap);
  check('autosave CAS: first save accepted', a1.changes === 1, `changes=${a1.changes}`);
  check('autosave CAS: second competing save rejected (would 409)', a2.changes === 0 && ci().status === 'partially_implemented', `changes=${a2.changes} status=${ci().status}`);

  // ---- bulk-controls (per-row dynamic sets) full mirror consistency ----
  const ids = db.prepare(`SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 10`).all().map(r => r.id);
  for (const id of ids) {
    const r2 = ctlWrites.requirementId(db, 'iso27001', id);
    db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)`).run(ws, r2);
    const sets = ['status=?', 'applicability=?', 'last_updated=CURRENT_TIMESTAMP'], vals = ['Not Applicable', 'excluded'];
    const c = ctlWrites.convergeSets(sets, vals);
    db.prepare(`UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(...c.vals, ws, r2);
  }
  let mismatch = 0;
  for (const id of ids) {
    const r2 = ctlWrites.requirementId(db, 'iso27001', id);
    const c = db.prepare(`SELECT status, applicability FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, r2);
    const l = db.prepare(`SELECT status, applicability FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, id);
    if (!l || c.status !== 'not_applicable' || l.status !== 'Not Applicable' || l.applicability !== 'excluded') mismatch++;
  }
  check('bulk-controls: 10/10 per-row mirror consistent', mismatch === 0, `mismatches=${mismatch}`);

  // ---- NC-close last_verified_at bump (converged ensure+update) ----
  db.prepare(`UPDATE control_instances SET last_verified_at = CURRENT_TIMESTAMP WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(ws, rid);
  check('NC-close: last_verified_at set on converged + mirrored to legacy', !!ci().last_verified_at && !!cs().last_verified_at, `ci=${!!ci().last_verified_at} cs=${!!cs().last_verified_at}`);

  // ---- 42001 bulk toggle normalization + mirror ----
  const I42 = db.prepare(`SELECT i.id FROM iso42001_items i WHERE EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=i.id) LIMIT 1`).get();
  if (I42) {
    const r42 = ctlWrites.requirementId(db, 'iso42001', I42.id);
    db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)`).run(ws, r42);
    db.prepare(`UPDATE control_instances SET status=?, last_updated=CURRENT_TIMESTAMP WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(ctlWrites.normStatus('Implemented'), ws, r42);
    const l42 = db.prepare(`SELECT status FROM iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, I42.id);
    check('42001 toggle: normalized token + legacy mirror', l42 && l42.status === 'Implemented', l42 && l42.status);
  } else {
    check('42001 mapping present', false, 'no mapping');
  }

  db.close();
} catch (e) {
  console.error('HARNESS ERROR:', e.message, '\n', e.stack);
  failures++;
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

const w = Math.max(...results.map(r => r[1].length), 10);
for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
console.log(`\ncutover4 W5 check: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
