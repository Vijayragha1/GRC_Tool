#!/usr/bin/env node
/**
 * cutover4_sync_check.js  (BEHAVIORAL test for the cutover-4 converged->legacy sync)
 *
 * Proves migration 014: a CONVERGED write (control_instances /
 * document_requirement_links) is mirrored back into the still-present legacy
 * tables (control_states / iso42001_control_states / document_controls) with
 * de-normalized display values and last_updated verbatim. Also proves the 013 +
 * 014 pair does NOT loop or double-apply (recursive_triggers=0): exactly one row
 * on each side, values consistent, no errors, regardless of which side is written.
 *
 * Self-contained: same throwaway-DB chain as cutover3_sync_check.js (init -> seed
 * frameworks + requirements from the catalogs). Exit 0 = pass, 1 = a sync gap.
 *
 *   node migrations/fixtures/cutover4_sync_check.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4sync-'));
const dbPath = path.join(tmpDir, 'c4.db');
const env = { ...process.env, DB_PATH: dbPath };

let failures = 0;
const results = [];
function check(name, cond, detail) { results.push([cond ? 'PASS' : 'FAIL', name, detail || '']); if (!cond) failures++; }

try {
  execSync(`node -e "require('./db').init()"`, { cwd: ROOT, env, stdio: 'ignore' });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

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

  const trigN = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND (name LIKE '%_to_cs%' OR name LIKE '%_to_dc%')").get().n;
  check('014 converged->legacy triggers installed (8)', trigN === 8, `found ${trigN}`);

  const ws = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'C4 Sync Test')`).run().lastInsertRowid;
  const ITEM = 'annex-a.5.1';
  const reqId = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.ref=?`).get(ITEM).id;
  const legacy = () => db.prepare(`SELECT status, applicability, maturity, owner_id, inclusion_justification, last_updated FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM);
  const legacyCount = () => db.prepare(`SELECT COUNT(*) n FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM).n;
  const ciCount = () => db.prepare(`SELECT COUNT(*) n FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, reqId).n;

  // ---- TEST 1: converged INSERT -> legacy mirror appears, de-normalized -----
  const STAMP = '2026-06-11 11:00:00';
  db.prepare(`INSERT INTO control_instances (workspace_id, requirement_id, entity_id, status, applicability, maturity, owner_id, inclusion_justification, last_updated)
              VALUES (?, ?, NULL, 'implemented', 'applicable', 3, 1, 'why', ?)`).run(ws, reqId, STAMP);
  let l = legacy();
  check('1 converged INSERT: legacy mirror row created', !!l, l ? 'present' : 'missing');
  check('1 status de-normalized to display', l && l.status === 'Implemented', l && l.status);
  check('1 applicability de-normalized to legacy', l && l.applicability === 'included', l && l.applicability);
  check('1 maturity mirrored', l && l.maturity === 3, l && String(l.maturity));
  check('1 owner_id mirrored', l && l.owner_id === 1, l && String(l.owner_id));
  check('1 justification mirrored', l && l.inclusion_justification === 'why', l && l.inclusion_justification);
  check('1 last_updated VERBATIM', l && l.last_updated === STAMP, l && l.last_updated);
  check('1 exactly one legacy row (no dup)', legacyCount() === 1, `n=${legacyCount()}`);
  check('1 exactly one converged row (013 did not loop back a dup)', ciCount() === 1, `n=${ciCount()}`);

  // ---- TEST 2: converged UPDATE -> legacy mirror reflects -------------------
  const STAMP2 = '2026-06-11 12:30:00';
  db.prepare(`UPDATE control_instances SET status='partially_implemented', applicability='excluded', maturity=2, last_updated=? WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(STAMP2, ws, reqId);
  l = legacy();
  check('2 converged UPDATE: status reflected', l && l.status === 'Partially Implemented', l && l.status);
  check('2 converged UPDATE: applicability reflected', l && l.applicability === 'excluded', l && l.applicability);
  check('2 converged UPDATE: last_updated verbatim', l && l.last_updated === STAMP2, l && l.last_updated);
  check('2 still exactly one legacy + one converged row', legacyCount() === 1 && ciCount() === 1, `cs=${legacyCount()} ci=${ciCount()}`);

  // ---- TEST 3: no-loop the OTHER way (legacy write -> 013 -> converged; 014 must not fire back a dup)
  const ITEM2 = 'annex-a.5.2';
  const reqId2 = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.ref=?`).get(ITEM2).id;
  db.prepare(`INSERT INTO control_states (workspace_id, iso_item_id, status, last_updated) VALUES (?, ?, 'Implemented', '2026-06-11 13:00:00')`).run(ws, ITEM2);
  const cs2 = db.prepare(`SELECT COUNT(*) n FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, ITEM2).n;
  const ci2 = db.prepare(`SELECT COUNT(*) n FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, reqId2).n;
  const ci2status = db.prepare(`SELECT status FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(ws, reqId2);
  check('3 legacy write -> 013 created exactly one converged row (no 014 loop)', cs2 === 1 && ci2 === 1, `cs=${cs2} ci=${ci2}`);
  check('3 converged row normalized from legacy write', ci2status && ci2status.status === 'implemented', ci2status && ci2status.status);

  // ---- TEST 4: 42001 converged -> legacy mirror (intersection columns) ------
  const I42 = db.prepare(`SELECT i.id FROM iso42001_items i WHERE EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=i.id) LIMIT 1`).get();
  if (I42) {
    const r42 = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=?`).get(I42.id).id;
    db.prepare(`INSERT INTO control_instances (workspace_id, requirement_id, entity_id, status, applicability, last_updated) VALUES (?, ?, NULL, 'not_implemented', 'undecided', '2026-06-11 14:00:00')`).run(ws, r42);
    const l42 = db.prepare(`SELECT status, applicability, last_updated FROM iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(ws, I42.id);
    check('4 42001 converged INSERT: legacy mirror de-normalized', l42 && l42.status === 'Not Implemented' && l42.applicability === 'undecided', l42 && `${l42.status}/${l42.applicability}`);
    check('4 42001 last_updated verbatim', l42 && l42.last_updated === '2026-06-11 14:00:00', l42 && l42.last_updated);
  } else {
    check('4 42001 mapping present', false, 'no iso42001 requirement mapping');
  }

  // ---- TEST 5: doc-link converged -> legacy mirror -------------------------
  const doc = db.prepare(`INSERT INTO generated_docs (workspace_id, name, created_by) VALUES (?, 'Policy', 1)`).run(ws).lastInsertRowid;
  db.prepare(`INSERT INTO document_requirement_links (document_id, requirement_id, section_ref) VALUES (?, ?, '7.1')`).run(doc, reqId);
  const dl = db.prepare(`SELECT section_ref FROM document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, ITEM);
  check('5 doc-link converged INSERT: legacy mirror appears', dl && dl.section_ref === '7.1', dl && dl.section_ref);
  db.prepare(`DELETE FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).run(doc, reqId);
  const dl2 = db.prepare(`SELECT 1 FROM document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, ITEM);
  check('5 doc-link converged DELETE: legacy mirror dropped', !dl2, dl2 ? 'still present' : 'gone');

  db.close();
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

const w = Math.max(...results.map(r => r[1].length), 10);
for (const [st, name, detail] of results) console.log(`  [${st}] ${name.padEnd(w)} ${detail ? '| ' + detail : ''}`);
console.log(`\ncutover4 sync check: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
