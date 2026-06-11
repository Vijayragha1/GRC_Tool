#!/usr/bin/env node
/**
 * cutover1_evidence_parity.js  (READ-ONLY parity proof for cutover 1 of 5)
 *
 * Proves that the converged evidence-linkage read paths produce output
 * IDENTICAL to the legacy join-table reads, per workspace, for every evidence
 * read surface that touched a demolition-scheduled table. This is the parity
 * gate for cutover 1 (evidence reads). It calls lib/evidence-reads.js with
 * converged=false and converged=true and deep-compares, independent of the
 * feature flag, so it proves the code path itself is faithful on real data.
 *
 *   DB_PATH=/path/to/iso27001.db node migrations/fixtures/cutover1_evidence_parity.js
 *
 * Exit 0 = every surface byte-identical (or set-identical for the unordered
 * GROUP_CONCAT manifest cell). Exit 1 = a real mismatch (cutover blocked).
 * Opens the DB read-only; writes nothing.
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const ev = require('../../lib/evidence-reads');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath, { readonly: true });
db.pragma('foreign_keys = ON');

// Stable stringify (sorted keys) for deep comparison.
function canon(v) {
  return JSON.stringify(v, (k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce((o, kk) => { o[kk] = val[kk]; return o; }, {});
    }
    return val;
  });
}
function eq(a, b) { return canon(a) === canon(b); }

const workspaces = db.prepare('SELECT id, client_name FROM workspaces ORDER BY id').all();
const results = [];   // { site, ws, ok, note }
let hardFail = 0;

function record(site, wsId, ok, note) {
  results.push({ site, ws: wsId, ok, note: note || '' });
  if (!ok) hardFail++;
}

// ---- Site 1: evidence library links (linksByEvidence + crossLinksByEvidence)
for (const w of workspaces) {
  const ids = db.prepare('SELECT id FROM evidence WHERE workspace_id=? AND superseded_at IS NULL ORDER BY id').all(w.id).map(r => r.id);
  const legacy = ev.libraryLinks(db, ids, false);
  const conv = ev.libraryLinks(db, ids, true);
  record('library.links', w.id, eq(legacy, conv));
}

// ---- Site 2: control-detail evidence panel, per control that has evidence
for (const w of workspaces) {
  const controls = db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order").all().map(r => r.id);
  let mism = 0, checked = 0;
  for (const cid of controls) {
    const legacy = ev.controlPanelEvidence(db, w.id, cid, false);
    const conv = ev.controlPanelEvidence(db, w.id, cid, true);
    if (legacy.length || conv.length) {
      checked++;
      if (!eq(legacy, conv)) mism++;
    }
  }
  record('control_panel.evidence', w.id, mism === 0, `${checked} controls with evidence`);
}

// ---- Site 3: evidence-coverage matrix (evidenceByControl map)
for (const w of workspaces) {
  const legacy = ev.coverageEvidenceByControl(db, w.id, false);
  const conv = ev.coverageEvidenceByControl(db, w.id, true);
  record('coverage.matrix', w.id, eq(legacy, conv));
}

// ---- Site 4: link_count correlated subquery (library main query)
for (const w of workspaces) {
  const q = (converged) => db.prepare(
    `SELECT e.id, ${ev.linkCountSubquery(converged)} AS link_count
     FROM evidence e WHERE e.workspace_id=? ORDER BY e.id`).all(w.id);
  record('library.link_count', w.id, eq(q(false), q(true)));
}

// ---- Site 5: linked_controls GROUP_CONCAT (pack + readiness-pack manifests)
for (const w of workspaces) {
  const q = (converged) => db.prepare(
    `SELECT e.id, ${ev.linkedControlsSubquery(converged)} AS linked_controls
     FROM evidence e WHERE e.workspace_id=? AND e.superseded_at IS NULL ORDER BY e.id`).all(w.id);
  const legacy = q(false), conv = q(true);
  const exact = eq(legacy, conv);
  // GROUP_CONCAT order is unspecified; if not byte-equal, fall back to set equality.
  let setEqual = true, orderOnly = 0;
  if (!exact) {
    const norm = (s) => (s == null ? null : String(s).split('; ').sort().join('; '));
    for (let i = 0; i < legacy.length; i++) {
      const a = norm(legacy[i].linked_controls), b = norm(conv[i].linked_controls);
      if (a !== b) { setEqual = false; }
      else if (legacy[i].linked_controls !== conv[i].linked_controls) { orderOnly++; }
    }
  }
  record('manifest.linked_controls', w.id, exact || setEqual,
    exact ? 'byte-identical' : (setEqual ? `set-identical (${orderOnly} rows order-only)` : 'SET MISMATCH'));
}

// ---- Site 6: checklist-from-soa evidence count subquery
for (const w of workspaces) {
  const q = (converged) => db.prepare(
    `SELECT i.id, ${ev.checklistEvidenceCountSubquery(converged)} AS evi_count
     FROM iso_items i WHERE i.type='control' ORDER BY i.id`).all(w.id);
  record('checklist.evi_count', w.id, eq(q(false), q(true)));
}

// ---- Report ---------------------------------------------------------------
const sites = [...new Set(results.map(r => r.site))];
console.log('CUTOVER 1 EVIDENCE-READ PARITY  (legacy vs converged, per workspace)');
console.log('DB:', dbPath);
console.log('='.repeat(72));
for (const site of sites) {
  const rows = results.filter(r => r.site === site);
  const pass = rows.filter(r => r.ok).length;
  const flag = pass === rows.length ? 'PASS' : 'FAIL';
  console.log(`\n[${flag}] ${site}  (${pass}/${rows.length} workspaces)`);
  for (const r of rows) {
    const wsLabel = (workspaces.find(w => w.id === r.ws) || {}).client_name || '';
    console.log(`   ws ${String(r.ws).padEnd(3)} ${(r.ok ? 'ok  ' : 'FAIL')} ${wsLabel.slice(0, 26).padEnd(26)} ${r.note}`);
  }
}
console.log('\n' + '='.repeat(72));
console.log(hardFail === 0
  ? `PARITY PROOF: PASS  (all ${results.length} workspace×site checks identical)`
  : `PARITY PROOF: FAIL  (${hardFail} mismatched checks)`);
db.close();
process.exit(hardFail === 0 ? 0 : 1);
