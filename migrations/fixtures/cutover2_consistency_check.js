#!/usr/bin/env node
/**
 * cutover2_consistency_check.js  (READ-ONLY consistency gate for cutover 2)
 *
 * Proves the legacy evidence join tables (evidence_controls + evidence_links)
 * and the converged evidence_requirement_links (erl) are ROW-CONSISTENT: the
 * erl_to_legacy_* sync triggers (migration 010) keep them mirrored as the app
 * writes erl. Run this after any evidence write activity, and immediately before
 * the Phase 2 demolition, to confirm the legacy shadow is faithful.
 *
 *   DB_PATH=/path/to/iso27001.db node migrations/fixtures/cutover2_consistency_check.js
 *
 * Checks (all must be 0):
 *  1. link-set symmetric difference  legacy (ec UNION el, valid evidence) vs erl
 *  2. ISO 27001 section_ref drift     erl vs evidence_controls
 *  3. cross-framework section_ref drift erl vs evidence_links (iso42001/csf)
 *
 * Exit 0 = consistent; exit 1 = drift (cutover/demolition blocked). Read-only.
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath, { readonly: true });

const symDiff = db.prepare(`
  WITH L AS (
    SELECT ec.evidence_id eid, 'iso27001' fw, ec.iso_item_id ref FROM evidence_controls ec JOIN evidence e ON e.id=ec.evidence_id
    UNION
    SELECT el.evidence_id, el.framework, el.item_ref FROM evidence_links el JOIN evidence e ON e.id=el.evidence_id
  ),
  C AS (
    SELECT erl.evidence_id eid, f.code fw, r.ref ref FROM evidence_requirement_links erl
      JOIN requirements r ON r.id=erl.requirement_id JOIN frameworks f ON f.id=r.framework_id
      WHERE f.code IN ('iso27001','iso42001','csf')
  )
  SELECT
    (SELECT COUNT(*) FROM (SELECT * FROM L EXCEPT SELECT * FROM C)) AS l_not_c,
    (SELECT COUNT(*) FROM (SELECT * FROM C EXCEPT SELECT * FROM L)) AS c_not_l
`).get();

const isoSection = db.prepare(`
  SELECT COUNT(*) n FROM evidence_requirement_links erl
    JOIN requirements r ON r.id=erl.requirement_id
    JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001'
    JOIN evidence_controls ec ON ec.evidence_id=erl.evidence_id AND ec.iso_item_id=r.ref
  WHERE IFNULL(ec.section_ref,'') <> IFNULL(erl.section_ref,'')
`).get().n;

const crossSection = db.prepare(`
  SELECT COUNT(*) n FROM evidence_requirement_links erl
    JOIN requirements r ON r.id=erl.requirement_id
    JOIN frameworks f ON f.id=r.framework_id AND f.code IN ('iso42001','csf')
    JOIN evidence_links el ON el.evidence_id=erl.evidence_id AND el.framework=f.code AND el.item_ref=r.ref
  WHERE IFNULL(el.section_ref,'') <> IFNULL(erl.section_ref,'')
`).get().n;

const checks = [
  ['link-set symmetric difference (legacy -> erl)', symDiff.l_not_c],
  ['link-set symmetric difference (erl -> legacy)', symDiff.c_not_l],
  ['ISO 27001 section_ref drift (erl vs evidence_controls)', isoSection],
  ['cross-framework section_ref drift (erl vs evidence_links)', crossSection],
];
console.log('CUTOVER 2 LEGACY<->CONVERGED CONSISTENCY');
console.log('DB:', dbPath);
console.log('='.repeat(60));
let fail = 0;
for (const [label, n] of checks) {
  console.log(`  ${n === 0 ? 'ok  ' : 'FAIL'} ${label}: ${n}`);
  if (n !== 0) fail++;
}
console.log('='.repeat(60));
console.log(fail === 0 ? 'CONSISTENCY: PASS (legacy tables faithfully mirror erl)' : `CONSISTENCY: FAIL (${fail} drift checks)`);
db.close();
process.exit(fail === 0 ? 0 : 1);
