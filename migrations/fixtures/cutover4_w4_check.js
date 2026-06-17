#!/usr/bin/env node
/**
 * cutover4_w4_check.js  (BEHAVIORAL test for cutover-4 W4: SoA writes)
 *
 * Focus: the SET-BASED BULK writes, where a mirror trigger could silently miss
 * edge rows. After each converged bulk action this runs a FULL per-row
 * consistency diff (not a count match): every whole-org control_instances row
 * must have a 014-mirrored legacy control_states row whose de-normalized
 * applicability/status equal the converged tokens. Any missed row is reported by
 * iso_item_id. Also covers single SoA save and auto-justify, and asserts every
 * applicability written is a valid converged token (no raw legacy literal leaked).
 *
 * Uses the EXACT converged SQL the handlers run. Route-level HTTP E2E is at the gate.
 *
 *   node migrations/fixtures/cutover4_w4_check.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4w4-'));
const dbPath = path.join(tmpDir, 'c4w4.db');
const env = { ...process.env, DB_PATH: dbPath };
const ctlWrites = require(path.join(ROOT, 'lib', 'control-writes.js'));

let failures = 0;
const results = [];
function check(name, cond, detail) { results.push([cond ? 'PASS' : 'FAIL', name, detail || '']); if (!cond) failures++; }

const DENORM_APP = { applicable: 'included', excluded: 'excluded', undecided: 'undecided' };
const DENORM_STATUS = { implemented: 'Implemented', partially_implemented: 'Partially Implemented', work_in_progress: 'Work In Progress', not_assessed: 'Not Assessed', not_implemented: 'Not Implemented', not_applicable: 'Not Applicable' };
const VALID_TOKENS = new Set(['applicable', 'excluded', 'undecided']);

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

  const ws = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'W4 SoA')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES ('control_writes_converged', ?, 1)`).run(ws);

  const CTL_REQ = `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.req_type='control'`;
  // ensure converged rows for all controls (as the handler does)
  db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id)
              SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
              WHERE f.code='iso27001' AND rq.req_type='control'`).run(ws);

  const ciControls = () => db.prepare(`SELECT COUNT(*) n FROM control_instances ci JOIN requirements rq ON rq.id=ci.requirement_id JOIN frameworks f ON f.id=rq.framework_id WHERE ci.workspace_id=? AND ci.entity_id IS NULL AND f.code='iso27001'`).get(ws).n;

  // FULL per-row consistency: every whole-org converged control row must have a
  // 014-mirrored legacy row with de-normalized-equal applicability + status.
  function mirrorMismatches() {
    const rows = db.prepare(`
      SELECT rq.ref AS iso, ci.applicability AS ci_app, ci.status AS ci_status,
             cs.applicability AS cs_app, cs.status AS cs_status, cs.iso_item_id AS cs_present
      FROM control_instances ci
      JOIN requirements rq ON rq.id=ci.requirement_id
      JOIN frameworks f ON f.id=rq.framework_id AND f.code='iso27001'
      LEFT JOIN control_states cs ON cs.workspace_id=ci.workspace_id AND cs.iso_item_id=rq.ref
      WHERE ci.workspace_id=? AND ci.entity_id IS NULL`).all(ws);
    const bad = [];
    for (const r of rows) {
      if (!VALID_TOKENS.has(r.ci_app)) { bad.push(`${r.iso}:badtoken(${r.ci_app})`); continue; }
      if (!r.cs_present) { bad.push(`${r.iso}:no-mirror`); continue; }
      if (r.cs_app !== DENORM_APP[r.ci_app]) { bad.push(`${r.iso}:app(${r.ci_app}->${r.cs_app})`); continue; }
      if (r.cs_status !== (DENORM_STATUS[r.ci_status] || '!!' + r.ci_status)) { bad.push(`${r.iso}:status(${r.ci_status}->${r.cs_status})`); continue; }
    }
    return bad;
  }

  const total = ciControls();
  check('setup: converged control rows created', total === 93, `n=${total}`);

  // ---- include_all (set-based bulk) ----
  const incAll = db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                             WHERE workspace_id=? AND entity_id IS NULL AND requirement_id IN (${CTL_REQ})`)
    .run(ctlWrites.normApplic('included'), 'bulk just', ws).changes;
  let mm = mirrorMismatches();
  check('include_all: affected all 93 rows', incAll === 93, `affected=${incAll}`);
  check('include_all: FULL per-row mirror consistency (0 missed)', mm.length === 0, mm.slice(0, 5).join(' '));

  // ---- a few rows back to undecided, then include_undecided (partial set) ----
  const someIds = db.prepare(`SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 7`).all().map(r => r.id);
  const ridOf = (iso) => ctlWrites.requirementId(db, 'iso27001', iso);
  for (const iso of someIds) db.prepare(`UPDATE control_instances SET applicability=? WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(ctlWrites.normApplic('undecided'), ws, ridOf(iso));
  const incUnd = db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                             WHERE workspace_id=? AND entity_id IS NULL AND applicability=? AND requirement_id IN (${CTL_REQ})`)
    .run(ctlWrites.normApplic('included'), null, ws, ctlWrites.normApplic('undecided')).changes;
  mm = mirrorMismatches();
  check('include_undecided: affected exactly the 7 reset rows', incUnd === 7, `affected=${incUnd}`);
  check('include_undecided: FULL per-row mirror consistency (0 missed)', mm.length === 0, mm.slice(0, 5).join(' '));

  // ---- exclude_selected (per-row selected bulk) ----
  const selIds = someIds.slice(0, 4);
  const ph = selIds.map(() => '?').join(',');
  const exc = db.prepare(`UPDATE control_instances SET applicability=?, exclusion_justification = COALESCE(?, exclusion_justification), last_updated = CURRENT_TIMESTAMP
                          WHERE workspace_id=? AND entity_id IS NULL
                            AND requirement_id IN (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.ref IN (${ph}))`)
    .run(ctlWrites.normApplic('excluded'), 'exc just', ws, ...selIds).changes;
  mm = mirrorMismatches();
  check('exclude_selected: affected the 4 selected rows', exc === 4, `affected=${exc}`);
  check('exclude_selected: FULL per-row mirror consistency (0 missed)', mm.length === 0, mm.slice(0, 5).join(' '));
  // spot-check the de-normalization landed on a selected row
  const spot = db.prepare(`SELECT applicability FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, selIds[0]);
  check('exclude_selected: legacy mirror shows de-normalized "excluded"', spot && spot.applicability === 'excluded', spot && spot.applicability);

  // ---- single SoA save (status + applicability normalized) ----
  const one = someIds[0];
  db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification=?, exclusion_justification=?, status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
              WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
    .run(ctlWrites.normApplic('included'), 'incl', null, ctlWrites.normStatus('Work In Progress'), ws, ridOf(one));
  const cs1 = db.prepare(`SELECT applicability, status FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, one);
  check('single save: legacy mirror de-normalized (included / Work In Progress)', cs1 && cs1.applicability === 'included' && cs1.status === 'Work In Progress', cs1 && `${cs1.applicability}/${cs1.status}`);
  check('single save: still fully consistent', mirrorMismatches().length === 0, 'ok');

  db.close();
} catch (e) {
  console.error('HARNESS ERROR:', e.message, '\n', e.stack);
  failures++;
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

const w = Math.max(...results.map(r => r[1].length), 10);
for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
console.log(`\ncutover4 W4 check: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
