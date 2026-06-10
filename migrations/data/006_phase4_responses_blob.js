#!/usr/bin/env node
/**
 * 006_phase4_responses_blob.js  (DATA op; proven on fixtures, data deferred to AWS pass)
 *
 * Explodes control_state_history.assessment_answers (by pass) and the current
 * control_states.assessment_answers blob into `responses`.
 *
 * ASSUMED blob shape (item-scoped; control_state* rows are per (workspace,item)).
 * TO BE CONFIRMED against the AWS snapshot dry run:
 *   - JSON array   ["ans0","ans1",...]            -> positional, 1-based: index i -> '{item}:q{i+1}'
 *   - JSON object  {"1":"..","2":".."}            -> numeric keys, 1-based:  key k -> '{item}:q{k}'
 *   - JSON object  {"q1":"..","q2":".."}          -> 'qN' keys map straight through
 * Anything else (scalar / non-JSON) => the row is quarantined as malformed.
 *
 * Routing (per the brief):
 *   - history row with pass_id  -> the assessment migrated_from 'assessment_passes:{pass_id}'
 *   - history row pass_id NULL  -> synthetic "Pre-passes import" assessment (per workspace)
 *   - current control_states    -> synthetic "Working (current state import)" assessment (per workspace)
 *   - iso_item_id not in catalog (retired item) -> row quarantined
 *   - answer key out of range / unkeyable        -> that entry quarantined
 *
 * Reconciliation gate: exploded_entries == responses_inserted + entry_quarantine + dedup_skipped (exact).
 * Idempotent: INSERT OR IGNORE on responses UNIQUE(assessment_id,question_id); phase-4 blob quarantine recomputed.
 */
const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const qs = db.prepare(`SELECT id FROM question_sets WHERE firm_id IS NULL AND name='ISO 27001:2022 gap assessment' AND version=1`).get();
if (!qs) { console.error('ISO question set missing; run 005 structural backfill first.'); process.exit(1); }

const reqIso = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' AND r.ref=?`);
const qByKey = db.prepare(`SELECT id FROM questions WHERE question_set_id=? AND stable_key=?`);
const orgOf = db.prepare(`SELECT id FROM entities WHERE workspace_id=? AND entity_type='organization'`);
const assessByMigrated = db.prepare(`SELECT id FROM assessments WHERE migrated_from=?`);
const insResp = db.prepare(`INSERT OR IGNORE INTO responses (assessment_id,question_id,answer,assessor_note,respondent_kind,raw_source) VALUES (?,?,?,?,'consultant',?)`);
const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT 'phase4',@t,@id,@reason,@payload WHERE NOT EXISTS(SELECT 1 FROM migration_quarantine WHERE phase='phase4' AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ t, id: String(id), reason, payload });

const stringifyAns = (a) => (a == null ? null : (typeof a === 'string' ? a : JSON.stringify(a)));
function entries(blob) {
  let v; try { v = JSON.parse(blob); } catch { return null; }
  const out = [];
  if (Array.isArray(v)) {
    v.forEach((ans, i) => out.push({ suffix: `q${i + 1}`, answer: stringifyAns(ans), rawkey: String(i) }));
  } else if (v && typeof v === 'object') {
    for (const [k, ans] of Object.entries(v)) {
      let suffix = null;
      if (/^q\d+$/i.test(k)) suffix = k.toLowerCase();
      else if (/^\d+$/.test(k)) suffix = `q${parseInt(k, 10)}`;
      out.push({ suffix, answer: stringifyAns(ans), rawkey: k });
    }
  } else { return null; }
  return out;
}

function syntheticAssessment(ws, kind) {
  const mf = `synthetic:${kind}:ws${ws}`;
  const a = assessByMigrated.get(mf);
  if (a) return a.id;
  const org = orgOf.get(ws); if (!org) return null;
  const label = kind === 'working' ? 'Working (current state import)' : 'Pre-passes import';
  return db.prepare(`INSERT INTO assessments (workspace_id,entity_id,question_set_id,question_set_version,label,status,propagation_done,migrated_from) VALUES (?,?,?,1,?,?,0,?)`)
    .run(ws, org.id, qs.id, label, 'in_progress', mf).lastInsertRowid;
}

const s = { entries: 0, responses: 0, entryQ: 0, dedup: 0, rowsMalformed: 0, rowsRetired: 0 };

const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase4' AND source_table IN ('control_state_history','control_states') AND resolved_at IS NULL").run();

  const processRow = (table, row, target, itemRef) => {
    const list = entries(row.assessment_answers);
    if (list === null) { s.rowsMalformed++; quarantine(table, row.id, 'assessment_answers malformed JSON', String(row.assessment_answers).slice(0, 500)); return; }
    for (const e of list) {
      s.entries++;
      if (!e.suffix) { s.entryQ++; quarantine(table, `${row.id}:${e.rawkey}`, `unkeyable answer key '${e.rawkey}' for ${itemRef}`, JSON.stringify(e)); continue; }
      const q = qByKey.get(qs.id, `${itemRef}:${e.suffix}`);
      if (!q) { s.entryQ++; quarantine(table, `${row.id}:${e.suffix}`, `no question ${itemRef}:${e.suffix} (out of range / retired)`, JSON.stringify(e)); continue; }
      const res = insResp.run(target, q.id, e.answer, null, JSON.stringify({ src: table, id: row.id, key: e.rawkey }));
      if (res.changes > 0) s.responses++; else s.dedup++;
    }
  };

  for (const h of db.prepare(`SELECT * FROM control_state_history WHERE assessment_answers IS NOT NULL AND assessment_answers<>''`).all()) {
    if (!reqIso.get(h.iso_item_id)) { s.rowsRetired++; quarantine('control_state_history', h.id, `iso_item_id retired/absent: ${h.iso_item_id}`, JSON.stringify(h)); continue; }
    let target;
    if (h.pass_id != null) { const a = assessByMigrated.get(`assessment_passes:${h.pass_id}`); target = a ? a.id : syntheticAssessment(h.workspace_id, 'pre-passes-import'); }
    else target = syntheticAssessment(h.workspace_id, 'pre-passes-import');
    if (!target) { quarantine('control_state_history', h.id, 'no org entity for workspace', JSON.stringify(h)); continue; }
    processRow('control_state_history', h, target, h.iso_item_id);
  }

  for (const cs of db.prepare(`SELECT * FROM control_states WHERE assessment_answers IS NOT NULL AND assessment_answers<>''`).all()) {
    if (!reqIso.get(cs.iso_item_id)) { s.rowsRetired++; quarantine('control_states', cs.id, `iso_item_id retired/absent: ${cs.iso_item_id}`, JSON.stringify(cs)); continue; }
    const target = syntheticAssessment(cs.workspace_id, 'working');
    if (!target) { quarantine('control_states', cs.id, 'no org entity for workspace', JSON.stringify(cs)); continue; }
    processRow('control_states', cs, target, cs.iso_item_id);
  }
  return s;
});

run();
const reconcile = s.entries === s.responses + s.entryQ + s.dedup;
console.log(`responses-blob: entries=${s.entries} responses=${s.responses} entry_quarantine=${s.entryQ} dedup=${s.dedup} | rows_malformed=${s.rowsMalformed} rows_retired=${s.rowsRetired}`);
console.log(`RECONCILE entries == responses + entry_quarantine + dedup : ${reconcile ? 'PASS' : 'FAIL'}`);
if (!reconcile) process.exitCode = 1;
db.close();
