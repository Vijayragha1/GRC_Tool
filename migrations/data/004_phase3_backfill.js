#!/usr/bin/env node
/**
 * 004_phase3_backfill.js  (DATA op; run after migrations/004 schema is applied)
 *
 * Phase 3 backfill: control_states / entity_control_states / iso42001_control_states
 * -> control_instances; control_state_history / iso42001_control_state_history ->
 * control_instance_history (source='migration'); document_controls /
 * iso42001_document_controls -> document_requirement_links.
 *
 * Status/applicability normalized via the maps approved by Vijay (2026-06-10).
 * Idempotent (INSERT OR IGNORE on natural keys / partial unique index; history and
 * quarantine guarded by NOT EXISTS). Re-runnable; resolved quarantine preserved.
 *
 *   node migrations/data/004_phase3_backfill.js
 *
 * Reverse: DELETE FROM document_requirement_links; DELETE FROM control_instance_history;
 *   DELETE FROM proposed_changes; DELETE FROM control_instances;
 *   DELETE FROM migration_quarantine WHERE phase='phase3' AND resolved_at IS NULL;
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// --- approved normalization maps (Phase 0 census -> Vijay sign-off) ---
const STATUS = {
  'Implemented': 'implemented', 'Partially Implemented': 'partially_implemented',
  'Not Assessed': 'not_assessed', 'Not Implemented': 'not_implemented', 'Not Applicable': 'not_applicable',
};
const APPLIC = { 'included': 'applicable', 'undecided': 'undecided', 'excluded': 'excluded' };
const normStatus = (s) => (s == null ? { ok: true, v: 'not_assessed' } : (s in STATUS ? { ok: true, v: STATUS[s] } : { ok: false, v: s }));
const normApplic = (a) => (a == null ? { ok: true, v: 'undecided' } : (a in APPLIC ? { ok: true, v: APPLIC[a] } : { ok: false, v: a }));

// --- statements ---
const reqByCodeRef = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code=? AND r.ref=?`);
const req = (code, ref) => { const r = reqByCodeRef.get(code, ref); return r ? r.id : null; };
const userExists = (id) => id != null && !!db.prepare('SELECT 1 FROM users WHERE id=?').get(id);
const docExists = (id) => !!db.prepare('SELECT 1 FROM generated_docs WHERE id=?').get(id);

const insCI = db.prepare(`INSERT OR IGNORE INTO control_instances
  (workspace_id, requirement_id, entity_id, applicability, inclusion_justification, exclusion_justification,
   status, maturity, scope_pct, notes, internal_notes, owner_id, due_date, review_status, last_verified_at,
   last_updated, migrated_from)
  VALUES (@workspace_id,@requirement_id,@entity_id,@applicability,@inclusion_justification,@exclusion_justification,
   @status,@maturity,@scope_pct,@notes,@internal_notes,@owner_id,@due_date,@review_status,@last_verified_at,
   @last_updated,@migrated_from)`);
const getInstance = db.prepare(`SELECT id FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS ?`);
const insHist = db.prepare(`INSERT INTO control_instance_history
  (instance_id, new_status, new_maturity, new_applicability, source, source_ref, changed_by, changed_at, reason, payload)
  SELECT @instance_id,@new_status,@new_maturity,@new_applicability,'migration',@source_ref,@changed_by,@changed_at,@reason,@payload
  WHERE NOT EXISTS (SELECT 1 FROM control_instance_history WHERE source='migration' AND source_ref=@source_ref)`);
const insDocLink = db.prepare(`INSERT OR IGNORE INTO document_requirement_links (document_id, requirement_id, section_ref) VALUES (?,?,?)`);

const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT @phase,@t,@id,@reason,@payload
  WHERE NOT EXISTS (SELECT 1 FROM migration_quarantine WHERE phase=@phase AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ phase: 'phase3', t, id: String(id), reason, payload });

const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase3' AND resolved_at IS NULL").run();

  const stats = { ci: 0, ciQ: 0, hist: 0, doc: 0, docQ: 0 };

  // helper to load a *_control_states table into control_instances
  const loadStates = (rows, fwCode, entityOf) => {
    for (const cs of rows) {
      const rid = req(fwCode, cs.iso_item_id);
      if (!rid) { quarantine('control_states', `${fwCode}:${cs.id}`, `iso_item_id unresolved: ${cs.iso_item_id}`, JSON.stringify(cs)); stats.ciQ++; continue; }
      const st = normStatus(cs.status), ap = normApplic(cs.applicability);
      if (!st.ok) { quarantine('control_states', cs.id, `unmapped status: ${cs.status}`, JSON.stringify(cs)); stats.ciQ++; continue; }
      if (!ap.ok) { quarantine('control_states', cs.id, `unmapped applicability: ${cs.applicability}`, JSON.stringify(cs)); stats.ciQ++; continue; }
      insCI.run({
        workspace_id: cs.workspace_id, requirement_id: rid, entity_id: entityOf(cs),
        applicability: ap.v, inclusion_justification: cs.inclusion_justification ?? null,
        exclusion_justification: cs.exclusion_justification ?? null, status: st.v,
        maturity: cs.maturity ?? null, scope_pct: cs.scope_pct ?? null, notes: cs.notes ?? null,
        internal_notes: cs.internal_notes ?? null,
        owner_id: userExists(cs.owner_id) ? cs.owner_id : null,
        due_date: cs.due_date ?? null, review_status: cs.review_status ?? 'none',
        last_verified_at: cs.last_verified_at ?? null, last_updated: cs.last_updated ?? null,
        migrated_from: `${fwCode === 'iso42001' ? 'iso42001_control_states' : (entityOf(cs) == null ? 'control_states' : 'entity_control_states')}:${cs.id}`,
      });
      stats.ci++;
    }
  };

  loadStates(db.prepare('SELECT * FROM control_states').all(), 'iso27001', () => null);
  loadStates(db.prepare('SELECT * FROM entity_control_states').all(), 'iso27001', (cs) => cs.entity_id);
  loadStates(db.prepare('SELECT * FROM iso42001_control_states').all(), 'iso42001', () => null);

  // history -> control_instance_history (source='migration'); snapshot stored as new_* + payload
  const loadHist = (rows, fwCode, table) => {
    for (const h of rows) {
      const rid = req(fwCode, h.iso_item_id);
      if (!rid) { quarantine(table, h.id, `iso_item_id unresolved: ${h.iso_item_id}`, JSON.stringify(h)); continue; }
      const inst = getInstance.get(h.workspace_id, rid, null);
      if (!inst) { quarantine(table, h.id, `no control_instance for ws=${h.workspace_id} ref=${h.iso_item_id}`, JSON.stringify(h)); continue; }
      const st = normStatus(h.status), ap = normApplic(h.applicability);
      insHist.run({
        instance_id: inst.id, new_status: st.ok ? st.v : h.status, new_maturity: h.maturity ?? null,
        new_applicability: ap.ok ? ap.v : null, source_ref: `${table}:${h.id}`,
        changed_by: userExists(h.changed_by) ? h.changed_by : null,
        changed_at: h.snapshot_at ?? null, reason: 'migrated from legacy control-state history',
        payload: JSON.stringify(h),
      });
      stats.hist++;
    }
  };
  loadHist(db.prepare('SELECT * FROM control_state_history').all(), 'iso27001', 'control_state_history');
  loadHist(db.prepare('SELECT * FROM iso42001_control_state_history').all(), 'iso42001', 'iso42001_control_state_history');

  // document_controls / iso42001_document_controls -> document_requirement_links
  const loadDocs = (rows, fwCode) => {
    for (const d of rows) {
      if (!docExists(d.document_id)) { quarantine('document_controls', `${fwCode}:${d.id}`, `document_id orphaned (doc deleted): ${d.document_id}`, JSON.stringify(d)); stats.docQ++; continue; }
      const rid = req(fwCode, d.iso_item_id);
      if (!rid) { quarantine('document_controls', `${fwCode}:${d.id}`, `iso_item_id unresolved: ${d.iso_item_id}`, JSON.stringify(d)); stats.docQ++; continue; }
      insDocLink.run(d.document_id, rid, d.section_ref ?? null); stats.doc++;
    }
  };
  loadDocs(db.prepare('SELECT * FROM document_controls').all(), 'iso27001');
  loadDocs(db.prepare('SELECT * FROM iso42001_document_controls').all(), 'iso42001');

  return stats;
});

const s = run();
console.log(`control_instances: ${s.ci} loaded, ${s.ciQ} quarantined`);
console.log(`control_instance_history (migration): ${s.hist}`);
console.log(`document_requirement_links: ${s.doc} loaded, ${s.docQ} quarantined`);
console.log(`totals -> control_instances=${db.prepare('SELECT count(*) n FROM control_instances').get().n}, history=${db.prepare('SELECT count(*) n FROM control_instance_history').get().n}, doc_links=${db.prepare('SELECT count(*) n FROM document_requirement_links').get().n}`);
db.close();
