#!/usr/bin/env node
/**
 * 003_phase2_backfill.js  (DATA op; run after migrations/003 schema is applied)
 *
 * Phase 2 backfill: populate evidence_requirement_links from the legacy
 * evidence_controls (ISO 27001, the table the app writes) and evidence_links
 * (any framework, the trigger-mirrored / non-ISO join). Idempotent (INSERT OR
 * IGNORE on UNIQUE(evidence_id, requirement_id); recomputes phase-2 quarantine).
 *
 * csf_evidence_items: in THIS database all 31 are seed (attached to the Phase 0
 * quarantined seed assessments, templated acme.example links, single-second
 * insert), so they are quarantined, NOT folded into central evidence. Folding of
 * any real csf_evidence_items is deferred to the Phase 4 CSF port.
 *
 *   node migrations/data/003_phase2_backfill.js
 *
 * Reverse: DELETE FROM evidence_requirement_links;
 *          DELETE FROM migration_quarantine WHERE phase='phase2' AND resolved_at IS NULL;
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const reqByCodeRef = db.prepare(
  `SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code=? AND r.ref=?`
);
const insLink = db.prepare(
  `INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, section_ref, relevance_note) VALUES (?,?,?,?)`
);
const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT @phase,@t,@id,@reason,@payload
  WHERE NOT EXISTS (SELECT 1 FROM migration_quarantine WHERE phase=@phase AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ phase: 'phase2', t, id: String(id), reason, payload });
const req = (code, ref) => { const r = reqByCodeRef.get(code, ref); return r ? r.id : null; };
const evExistsStmt = db.prepare(`SELECT 1 FROM evidence WHERE id=?`);
const evExists = (id) => !!evExistsStmt.get(id);

const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase2' AND resolved_at IS NULL").run();

  // 1. evidence_controls (ISO 27001) -> evidence_requirement_links
  let ecOk = 0, ecQ = 0;
  for (const ec of db.prepare(`SELECT * FROM evidence_controls`).all()) {
    if (!evExists(ec.evidence_id)) { quarantine('evidence_controls', ec.id, `evidence_id orphaned (evidence row deleted): ${ec.evidence_id}`, JSON.stringify(ec)); ecQ++; continue; }
    const rid = req('iso27001', ec.iso_item_id);
    if (!rid) { quarantine('evidence_controls', ec.id, `iso_item_id unresolved: ${ec.iso_item_id}`, JSON.stringify(ec)); ecQ++; continue; }
    insLink.run(ec.evidence_id, rid, ec.section_ref ?? null, null); ecOk++;
  }

  // 2. evidence_links (any framework) -> evidence_requirement_links (dedups vs step 1; catches non-ISO)
  let elOk = 0, elQ = 0;
  for (const el of db.prepare(`SELECT * FROM evidence_links`).all()) {
    if (!evExists(el.evidence_id)) { quarantine('evidence_links', el.id, `evidence_id orphaned (evidence row deleted): ${el.evidence_id}`, JSON.stringify(el)); elQ++; continue; }
    const rid = req(el.framework, el.item_ref);
    if (!rid) { quarantine('evidence_links', el.id, `framework+item_ref unresolved: ${el.framework}/${el.item_ref}`, JSON.stringify(el)); elQ++; continue; }
    insLink.run(el.evidence_id, rid, el.section_ref ?? null, null); elOk++;
  }

  // 3. csf_evidence_items: quarantine seed-attached; defer real ones to Phase 4
  const seedAssessments = new Set(
    db.prepare(`SELECT source_id FROM migration_quarantine WHERE source_table='csf_subcategory_assessments' AND reason='orphaned seed data'`)
      .all().map((r) => String(r.source_id))
  );
  let csfSeed = 0, csfDefer = 0;
  for (const ev of db.prepare(`SELECT * FROM csf_evidence_items`).all()) {
    if (seedAssessments.has(String(ev.assessment_id))) {
      quarantine('csf_evidence_items', ev.id, 'orphaned seed data: on quarantined seed assessment', JSON.stringify(ev)); csfSeed++;
    } else {
      csfDefer++;   // real csf evidence: fold deferred to Phase 4 CSF port
    }
  }

  return { ecOk, ecQ, elOk, elQ, csfSeed, csfDefer };
});

const r = run();
console.log(`evidence_controls -> links: ${r.ecOk} ok, ${r.ecQ} quarantined`);
console.log(`evidence_links     -> links: ${r.elOk} ok, ${r.elQ} quarantined (deduped vs above by UNIQUE)`);
console.log(`csf_evidence_items: ${r.csfSeed} quarantined as seed, ${r.csfDefer} real (deferred to Phase 4)`);
console.log(`total evidence_requirement_links: ${db.prepare('SELECT count(*) n FROM evidence_requirement_links').get().n}`);
db.close();
