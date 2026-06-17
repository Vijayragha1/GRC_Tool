#!/usr/bin/env node
/**
 * cutover4_w6_check.js  (BEHAVIORAL test for cutover-4 W6: document links)
 *
 * Proves the converged-authoritative doc-link path and the read/write coupling:
 *   - a converged ADD writes document_requirement_links (drl); 014 mirrors it into
 *     legacy document_controls;
 *   - the actionable link_id the panel renders (drl.id via v_document_controls) is
 *     the id the UNLINK deletes; deleting drl by that id removes BOTH rows (014
 *     mirrors the delete to legacy);
 *   - 42001 path via v_iso42001_document_controls.
 *
 * Uses the EXACT converged SQL the handlers run. Route-level HTTP E2E at the gate.
 *
 *   node migrations/fixtures/cutover4_w6_check.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4w6-'));
const dbPath = path.join(tmpDir, 'c4w6.db');
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

  const ws = db.prepare(`INSERT INTO workspaces (firm_id, client_name) VALUES (1, 'W6 DocLinks')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO feature_flags (key, workspace_id, enabled) VALUES ('control_writes_converged', ?, 1)`).run(ws);
  const doc = db.prepare(`INSERT INTO generated_docs (workspace_id, name, created_by) VALUES (?, 'Policy', 1)`).run(ws).lastInsertRowid;

  // ---- 27001 ADD (converged) -> 014 mirror to legacy ----
  const ITEM = 'annex-a.5.1';
  const rid = ctlWrites.requirementId(db, 'iso27001', ITEM);
  db.prepare(`INSERT OR IGNORE INTO document_requirement_links (document_id, requirement_id, section_ref) VALUES (?, ?, '4.2')`).run(doc, rid);
  const drlCnt = db.prepare(`SELECT COUNT(*) n FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).get(doc, rid).n;
  const dcCnt = db.prepare(`SELECT COUNT(*) n FROM document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, ITEM).n;
  check('27001 ADD: drl row created (converged-authoritative)', drlCnt === 1, `drl=${drlCnt}`);
  check('27001 ADD: 014 mirrored to legacy document_controls', dcCnt === 1, `dc=${dcCnt}`);

  // ---- the panel renders drl.id; the unlink deletes by that id ----
  const panel = db.prepare(`SELECT dc.id AS link_id, dc.iso_item_id, dc.section_ref FROM v_document_controls dc
    INNER JOIN generated_docs d ON d.id=dc.document_id WHERE dc.iso_item_id=? AND d.workspace_id=?`).get(ITEM, ws);
  const drlId = db.prepare(`SELECT id FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).get(doc, rid).id;
  check('27001 panel link_id IS drl.id (matches unlink target)', panel && panel.link_id === drlId, panel && `link_id=${panel.link_id} drl.id=${drlId}`);
  check('27001 panel section_ref mirrored', panel && panel.section_ref === '4.2', panel && panel.section_ref);

  // unlink: resolve via view (as the handler does) then delete drl by id
  const resolved = db.prepare(`SELECT * FROM v_document_controls WHERE id=? AND document_id=?`).get(panel.link_id, doc);
  check('27001 UNLINK: view resolves the link by rendered id', !!resolved, resolved ? 'resolved' : 'not found');
  db.prepare(`DELETE FROM document_requirement_links WHERE id=?`).run(panel.link_id);
  const drlAfter = db.prepare(`SELECT COUNT(*) n FROM document_requirement_links WHERE document_id=? AND requirement_id=?`).get(doc, rid).n;
  const dcAfter = db.prepare(`SELECT COUNT(*) n FROM document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, ITEM).n;
  check('27001 UNLINK: drl row deleted', drlAfter === 0, `drl=${drlAfter}`);
  check('27001 UNLINK: 014 mirrored the delete to legacy', dcAfter === 0, `dc=${dcAfter}`);

  // ---- 42001 ADD + UNLINK round-trip ----
  const I42 = db.prepare(`SELECT i.id FROM iso42001_items i WHERE EXISTS (SELECT 1 FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref=i.id) LIMIT 1`).get();
  if (I42) {
    const rid42 = ctlWrites.requirementId(db, 'iso42001', I42.id);
    db.prepare(`INSERT OR IGNORE INTO document_requirement_links (document_id, requirement_id, section_ref) VALUES (?, ?, '9.1')`).run(doc, rid42);
    const dc42 = db.prepare(`SELECT COUNT(*) n FROM iso42001_document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, I42.id).n;
    check('42001 ADD: 014 mirrored to iso42001_document_controls', dc42 === 1, `dc42=${dc42}`);
    const p42 = db.prepare(`SELECT id AS link_id FROM v_iso42001_document_controls WHERE iso_item_id=? AND document_id=?`).get(I42.id, doc);
    db.prepare(`DELETE FROM document_requirement_links WHERE id=?`).run(p42.link_id);
    const dc42After = db.prepare(`SELECT COUNT(*) n FROM iso42001_document_controls WHERE document_id=? AND iso_item_id=?`).get(doc, I42.id).n;
    check('42001 UNLINK: delete drl by view id removes legacy mirror', dc42After === 0, `dc42=${dc42After}`);
  } else {
    check('42001 mapping present', false, 'no iso42001 requirement mapping');
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
console.log(`\ncutover4 W6 check: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
