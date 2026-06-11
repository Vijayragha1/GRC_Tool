'use strict';
// Evidence-linkage WRITE paths, converged (post Phase 2 demolition).
//
// Writes go to evidence_requirement_links (erl). The legacy evidence_controls /
// evidence_links join tables and the new->legacy sync triggers were demolished
// (migration 011), so there is no legacy branch and no trigger mirror: erl is the
// single source of truth. Unlink / section-edit are addressed by the erl-native
// handle (evidence_requirement_links.id) that the read path now renders.

function reqId(db, framework, ref) {
  const r = db.prepare('SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code=? AND r.ref=?').get(framework, ref);
  return r ? r.id : null;
}

// Resolve an erl link id (scoped to an evidence row) to its framework + ref.
function linkInfo(db, linkId, evidenceId) {
  return db.prepare(
    `SELECT erl.id, f.code AS framework, rq.ref AS item_ref
     FROM evidence_requirement_links erl
     JOIN requirements rq ON rq.id = erl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id
     WHERE erl.id = ? AND erl.evidence_id = ?`
  ).get(linkId, evidenceId);
}

// Attach an ISO 27001 control to an evidence row (INSERT OR IGNORE into erl).
function attachIsoControl(db, evidenceId, isoItemId, sectionRef) {
  const rid = reqId(db, 'iso27001', isoItemId);
  if (!rid) return false; // unresolved ref (e.g. unseeded catalog): skip
  db.prepare('INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?)')
    .run(evidenceId, rid, sectionRef ?? null);
  return true;
}

// Attach a cross-framework (iso42001 / csf) link.
function attachCrossLink(db, evidenceId, framework, ref, sectionRef) {
  const rid = reqId(db, framework, ref);
  if (!rid) return false;
  db.prepare('INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?)')
    .run(evidenceId, rid, sectionRef ?? null);
  return true;
}

// Copy every link from one evidence row to another (supersede).
function copyControlLinks(db, fromEvidenceId, toEvidenceId) {
  const rows = db.prepare('SELECT requirement_id, section_ref FROM evidence_requirement_links WHERE evidence_id=?').all(fromEvidenceId);
  const ins = db.prepare('INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?)');
  for (const l of rows) ins.run(toEvidenceId, l.requirement_id, l.section_ref);
  return rows.length;
}

// Update section_ref on a link addressed by erl.id. Returns true if a row matched.
function updateSection(db, evidenceId, linkId, newRef) {
  const info = db.prepare('UPDATE evidence_requirement_links SET section_ref=? WHERE id=? AND evidence_id=?').run(newRef ?? null, linkId, evidenceId);
  return info.changes > 0;
}

// Unlink an ISO 27001 link addressed by erl.id. Returns the removed iso_item_id
// (ref, so the caller can clear evidence.iso_item_id if it was primary), or null
// if no matching iso27001 link.
function unlinkIsoControl(db, evidenceId, linkId) {
  const info = linkInfo(db, linkId, evidenceId);
  if (!info || info.framework !== 'iso27001') return null;
  db.prepare('DELETE FROM evidence_requirement_links WHERE id=? AND evidence_id=?').run(linkId, evidenceId);
  return info.item_ref;
}

// Unlink a cross-framework link addressed by erl.id (non-iso27001). Returns the
// removed { framework, item_ref } or null.
function unlinkCrossLink(db, evidenceId, linkId) {
  const info = linkInfo(db, linkId, evidenceId);
  if (!info || info.framework === 'iso27001') return null;
  db.prepare('DELETE FROM evidence_requirement_links WHERE id=? AND evidence_id=?').run(linkId, evidenceId);
  return { framework: info.framework, item_ref: info.item_ref };
}

module.exports = {
  reqId,
  attachIsoControl,
  attachCrossLink,
  copyControlLinks,
  updateSection,
  unlinkIsoControl,
  unlinkCrossLink,
};
