#!/usr/bin/env node
/**
 * 002_phase1_backfill.js  (DATA op; run after migrations/002 schema is applied)
 *
 * Phase 1 backfill of the unified framework catalog. Idempotent: every insert is
 * INSERT OR IGNORE keyed on a natural unique constraint, so re-running is safe.
 * Reference (catalog) data only; no workspace-scoped data, no destructive writes.
 *
 *   node migrations/data/002_phase1_backfill.js
 *
 * Reverse (Phase 1 only): DELETE FROM requirement_mappings; DELETE FROM requirements;
 *   DELETE FROM frameworks; DELETE FROM migration_quarantine WHERE phase='phase1';
 */
const Database = require('better-sqlite3');
const path = require('path');
// data/soc2-catalog.js was removed pending approval; the SOC 2 sections below
// are skipped when it is absent. The iso27001 / iso42001 / csf catalog (which
// the app cannot run without, post-019) loads regardless.
let soc2 = null;
try { soc2 = require('../../data/soc2-catalog.js'); } catch (_) { /* absent: skip SOC 2 rows */ }

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const NOTE = 'coverage not yet graded: legacy import';

// ---- helpers ---------------------------------------------------------------
const jparse = (v) => { if (v == null || v === '') return null; try { return JSON.parse(v); } catch { return v; } };

// Normalize a csf_subcategory_iso_refs ref_value into candidate iso_items ids.
// Handles comma multi-refs ("7.1, 7.2") and sub-letter refs ("4.2(a)" -> clause-4.2).
// ref_value 'None'/'' => explicit non-mapping (no target intended).
const isoRefParts = (ref_type, ref_value) => {
  const v = String(ref_value == null ? '' : ref_value).trim();
  if (v === '' || v.toLowerCase() === 'none') return { explicitNone: true, ids: [] };
  const prefix = ref_type === 'annex_a' ? 'annex-a.' : ref_type === 'mandatory_clause' ? 'clause-' : null;
  if (!prefix) return { explicitNone: false, ids: [] };
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean)
    .map((p) => prefix + p.replace(/\s*\([a-z]\)\s*$/i, '').trim());   // strip trailing (a)/(b)
  return { explicitNone: false, ids: [...new Set(ids)] };
};

const insFw = db.prepare(`INSERT OR IGNORE INTO frameworks (code,name,version,status,is_canonical) VALUES (?,?,?,?,?)`);
const getFw = db.prepare(`SELECT id FROM frameworks WHERE code=? AND version=?`);
const framework = (code, name, version, canonical) => {
  insFw.run(code, name, version, 'active', canonical ? 1 : 0);
  return getFw.get(code, version).id;
};

const insReq = db.prepare(`INSERT OR IGNORE INTO requirements
  (framework_id,ref,parent_ref,req_type,title,summary,guidance,sort_order)
  VALUES (@framework_id,@ref,@parent_ref,@req_type,@title,@summary,@guidance,@sort_order)`);
const getReqStmt = db.prepare(`SELECT id FROM requirements WHERE framework_id=? AND ref=?`);
const reqId = (fwId, ref) => { const r = getReqStmt.get(fwId, ref); return r ? r.id : null; };
// Children of a parent ref (e.g. clause-6.1 -> clause-6.1.1/6.1.2/6.1.3). The ISO
// catalog has no bare 'clause-6.1' row; clause 6.1 exists only via its children.
const getKidsStmt = db.prepare(`SELECT id FROM requirements WHERE framework_id=? AND ref LIKE ? ORDER BY ref`);
const reqIdsExactOrChildren = (fwId, ref) => {
  const exact = reqId(fwId, ref);
  if (exact) return [exact];
  return getKidsStmt.all(fwId, ref + '.%').map((x) => x.id);   // empty if neither exact nor children
};

const insMap = db.prepare(`INSERT OR IGNORE INTO requirement_mappings
  (canonical_requirement_id,mapped_requirement_id,coverage,residual_gap_note) VALUES (?,?,?,?)`);

const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT @phase,@t,@id,@reason,@payload
  WHERE NOT EXISTS (SELECT 1 FROM migration_quarantine
                    WHERE phase=@phase AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) =>
  insQ.run({ phase: 'phase1', t, id: String(id), reason, payload });

// ---- backfill (single transaction; catalog reference data) -----------------
const run = db.transaction(() => {
  // Recompute phase-1 quarantine cleanly on every run (idempotent), but preserve
  // rows already resolved by hand (resolved_at set) so manual triage sticks.
  // Scoped to phase='phase1' so the Phase 0 CSF-seed quarantine (212) is untouched.
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase1' AND resolved_at IS NULL").run();

  const fwIso = framework('iso27001', 'ISO/IEC 27001', '2022', 1);
  const fw42 = framework('iso42001', 'ISO/IEC 42001', '2023', 0);
  const fwCsf = framework('csf', 'NIST Cybersecurity Framework', '2.0', 0);
  const fwSoc2 = framework('soc2', 'SOC 2 (Trust Services Criteria)', '2017-rev2022', 0);

  // --- ISO 27001 + ISO 42001 from *_items ---
  const loadIso = (fwId, table, withMinCert) => {
    for (const it of db.prepare(`SELECT * FROM ${table}`).all()) {
      const guidance = {
        category: it.category,
        questions: jparse(it.questions),
        evidence_needed: jparse(it.evidence_needed),
        documentation_needed: jparse(it.documentation_needed),
        purpose: it.purpose ?? null,
        what_good_looks_like: it.what_good_looks_like ?? null,
        common_pitfalls: jparse(it.common_pitfalls),
        evidence_to_look_for: jparse(it.evidence_to_look_for),
        scoping_notes: it.scoping_notes ?? null,
        maturity_ladder: jparse(it.maturity_ladder),
        related_items: jparse(it.related_items),
      };
      if (withMinCert) guidance.minimum_certifiable = it.minimum_certifiable ?? null;
      insReq.run({
        framework_id: fwId, ref: it.id, parent_ref: null, req_type: it.type,
        title: it.title, summary: it.summary ?? null,
        guidance: JSON.stringify(guidance), sort_order: it.sort_order ?? null,
      });
    }
  };
  loadIso(fwIso, 'iso_items', true);
  loadIso(fw42, 'iso42001_items', false);

  // --- CSF: functions -> categories -> subcategories (parent_ref chaining by code) ---
  for (const f of db.prepare(`SELECT * FROM csf_functions`).all()) {
    insReq.run({ framework_id: fwCsf, ref: f.code, parent_ref: null, req_type: 'function',
      title: f.name, summary: f.description, guidance: null, sort_order: f.display_order });
  }
  for (const c of db.prepare(`SELECT c.*, fn.code AS fn_code FROM csf_categories c JOIN csf_functions fn ON fn.id=c.function_id`).all()) {
    insReq.run({ framework_id: fwCsf, ref: c.code, parent_ref: c.fn_code, req_type: 'category',
      title: c.name, summary: c.description, guidance: null, sort_order: c.display_order });
  }
  for (const s of db.prepare(`SELECT s.*, cat.code AS cat_code FROM csf_subcategories s JOIN csf_categories cat ON cat.id=s.category_id`).all()) {
    const guidance = s.implementation_examples ? JSON.stringify({ implementation_examples: s.implementation_examples }) : null;
    insReq.run({ framework_id: fwCsf, ref: s.code, parent_ref: s.cat_code, req_type: 'subcategory',
      title: s.description, summary: null, guidance, sort_order: s.display_order });
  }

  // --- SOC 2 TSC from data/soc2-catalog.js (PENDING VIJAY APPROVAL) ---
  // 5 top categories (req_type=category, parent NULL); 20 groups (category, parent=top cat);
  // 61 criteria (control, parent=group). Refs are the codes so Phase 2b tsc_criteria resolve.
  if (soc2) {
  soc2.CATEGORIES.forEach((c, i) => {
    insReq.run({ framework_id: fwSoc2, ref: c.code, parent_ref: null, req_type: 'category',
      title: c.name, summary: c.blurb, guidance: JSON.stringify({ short: c.short, required: !!c.required }), sort_order: i });
  });
  const groupCat = {};            // group code -> top category code (from criteria)
  const groupOrder = [];          // preserve first-seen order
  for (const cr of soc2.CRITERIA) { if (!(cr.group in groupCat)) { groupCat[cr.group] = cr.category; groupOrder.push(cr.group); } }
  groupOrder.forEach((g, i) => {
    insReq.run({ framework_id: fwSoc2, ref: g, parent_ref: groupCat[g], req_type: 'category',
      title: soc2.GROUP_LABELS[g] || g, summary: null, guidance: JSON.stringify({ category: groupCat[g] }), sort_order: 100 + i });
  });
  soc2.CRITERIA.forEach((cr, i) => {
    insReq.run({ framework_id: fwSoc2, ref: cr.code, parent_ref: cr.group, req_type: 'control',
      title: cr.title, summary: cr.description, guidance: JSON.stringify({ category: cr.category, group: cr.group }), sort_order: 1000 + i });
  });
  }

  // --- requirement_mappings: framework_mappings (soc2, nist_csf) ; ISO = canonical ---
  let fmMapped = 0, fmQuar = 0;
  for (const r of db.prepare(`SELECT iso_item_id, framework, external_ref FROM framework_mappings WHERE framework IN ('soc2','nist_csf')`).all()) {
    const canon = reqId(fwIso, r.iso_item_id);
    if (!canon) { quarantine('framework_mappings', r.iso_item_id, 'canonical iso ref unresolved', JSON.stringify(r)); fmQuar++; continue; }
    const targetFw = r.framework === 'soc2' ? fwSoc2 : fwCsf;
    for (const code of String(r.external_ref).split(',').map((s) => s.trim()).filter(Boolean)) {
      const mapped = reqId(targetFw, code);
      if (!mapped) { quarantine('framework_mappings', `${r.iso_item_id}->${code}`, `mapped ${r.framework} ref unresolved: ${code}`, JSON.stringify(r)); fmQuar++; continue; }
      insMap.run(canon, mapped, 'partial', NOTE); fmMapped++;
    }
  }

  // --- requirement_mappings: csf_subcategory_iso_refs ; ISO = canonical, CSF = mapped ---
  let crMapped = 0, crQuarNone = 0, crQuarUnres = 0;
  for (const r of db.prepare(`SELECT ref.id rid, ref.ref_type, ref.ref_value, s.code subcode
                              FROM csf_subcategory_iso_refs ref JOIN csf_subcategories s ON s.id=ref.subcategory_id`).all()) {
    const mapped = reqId(fwCsf, r.subcode);
    const { explicitNone, ids } = isoRefParts(r.ref_type, r.ref_value);
    if (explicitNone) { quarantine('csf_subcategory_iso_refs', r.rid, 'explicit non-mapping (ref_value=None)', JSON.stringify(r)); crQuarNone++; continue; }
    if (!mapped) { quarantine('csf_subcategory_iso_refs', r.rid, `csf subcategory unresolved: ${r.subcode}`, JSON.stringify(r)); crQuarUnres++; continue; }
    if (ids.length === 0) { quarantine('csf_subcategory_iso_refs', r.rid, `iso ref unparseable: ${r.ref_type}/${r.ref_value}`, JSON.stringify(r)); crQuarUnres++; continue; }
    for (const isoId of ids) {
      const canonIds = reqIdsExactOrChildren(fwIso, isoId);   // exact, else expand parent clause -> children
      if (canonIds.length === 0) { quarantine('csf_subcategory_iso_refs', `${r.rid}:${isoId}`, `iso ref unresolved: ${isoId}`, JSON.stringify(r)); crQuarUnres++; continue; }
      for (const canon of canonIds) { insMap.run(canon, mapped, 'partial', NOTE); crMapped++; }
    }
  }
  const crQuar = crQuarNone + crQuarUnres;

  return { fmMapped, fmQuar, crMapped, crQuar, crQuarNone, crQuarUnres };
});

const res = run();

// ---- report ----------------------------------------------------------------
const perFw = db.prepare(`SELECT f.code, f.version, count(r.id) n
  FROM frameworks f LEFT JOIN requirements r ON r.framework_id=f.id GROUP BY f.id ORDER BY f.id`).all();
console.log('frameworks + requirements loaded:');
for (const x of perFw) console.log(`  ${x.code} ${x.version}: ${x.n} requirements`);
console.log(`requirement_mappings from framework_mappings: ${res.fmMapped} (quarantined ${res.fmQuar})`);
console.log(`requirement_mappings from csf_subcategory_iso_refs: ${res.crMapped} (quarantined ${res.crQuar} = ${res.crQuarNone} explicit-None + ${res.crQuarUnres} unresolved)`);
console.log(`total requirement_mappings: ${db.prepare('SELECT count(*) n FROM requirement_mappings').get().n}`);
db.close();
