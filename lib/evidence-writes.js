'use strict';
// Evidence-linkage WRITE paths, dual-sourced for cutover 2 of 5 (evidence writes).
//
// Cutover 1 switched evidence READS onto evidence_requirement_links (erl). This
// module switches the WRITES. On a write-flipped workspace the app writes linkage
// to erl; the temporary erl_to_legacy_* triggers (migration 010) mirror every erl
// write back into the legacy join tables (evidence_controls / evidence_links), so
// the legacy tables stay row-consistent with erl until they are demolished.
//
// Each helper takes a `conv` boolean (evidence_writes_converged for the workspace)
// and is byte-for-byte the legacy behaviour when conv=false, so a non-flipped
// workspace and the test harness (no feature_flags table) keep writing legacy.
//
// Handle resolution note (transitional): the unlink / section-edit routes receive
// the LEGACY link id (evidence_controls.id / evidence_links.id) that the cutover-1
// read still exposes as the actionable handle. The converged branch resolves that
// legacy id to the erl row (the legacy row still exists during cutover 2) and
// operates on erl; the trigger mirrors the delete/update back to legacy. At Phase 2
// demolition the read handle must switch to erl-native and this resolution dropped.

const FLAG_KEY = 'evidence_writes_converged';

// Per-workspace flag with a global default fallback. Fails SAFE to legacy when the
// flag system / converged schema is absent (fresh boots, tests). A flag lookup
// must never break a write.
function writesConverged(db, workspaceId) {
  if (!workspaceId) return false;
  try {
    const ws = db.prepare('SELECT enabled FROM feature_flags WHERE key=? AND workspace_id=?').get(FLAG_KEY, workspaceId);
    if (ws) return !!ws.enabled;
    const g = db.prepare('SELECT enabled FROM feature_flags WHERE key=? AND workspace_id IS NULL').get(FLAG_KEY);
    return g ? !!g.enabled : false;
  } catch (_) {
    return false;
  }
}

function reqId(db, framework, ref) {
  const r = db.prepare('SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code=? AND r.ref=?').get(framework, ref);
  return r ? r.id : null;
}

// Attach an ISO 27001 control to an evidence row. Legacy: INSERT OR IGNORE
// evidence_controls. Converged: INSERT OR IGNORE erl (trigger mirrors to legacy).
function attachIsoControl(db, conv, evidenceId, isoItemId, sectionRef) {
  if (!conv) {
    db.prepare('INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)')
      .run(evidenceId, isoItemId, sectionRef ?? null);
    return true;
  }
  const rid = reqId(db, 'iso27001', isoItemId);
  if (!rid) return false; // unresolved ref: legacy FK would also reject; skip
  db.prepare('INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?)')
    .run(evidenceId, rid, sectionRef ?? null);
  return true;
}

// Attach a cross-framework (iso42001 / csf) link. Legacy: INSERT OR IGNORE
// evidence_links. Converged: INSERT OR IGNORE erl (trigger mirrors to evidence_links).
function attachCrossLink(db, conv, evidenceId, framework, ref, sectionRef) {
  if (!conv) {
    db.prepare('INSERT OR IGNORE INTO evidence_links (evidence_id, framework, item_ref, section_ref) VALUES (?, ?, ?, ?)')
      .run(evidenceId, framework, ref, sectionRef ?? null);
    return true;
  }
  const rid = reqId(db, framework, ref);
  if (!rid) return false;
  db.prepare('INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?)')
    .run(evidenceId, rid, sectionRef ?? null);
  return true;
}

// Copy every ISO 27001 link from one evidence row to another (supersede). Legacy
// copies evidence_controls rows; converged copies erl rows (trigger mirrors).
function copyControlLinks(db, conv, fromEvidenceId, toEvidenceId) {
  if (!conv) {
    const rows = db.prepare('SELECT iso_item_id, section_ref FROM evidence_controls WHERE evidence_id=?').all(fromEvidenceId);
    const ins = db.prepare('INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)');
    for (const l of rows) ins.run(toEvidenceId, l.iso_item_id, l.section_ref);
    return rows.length;
  }
  const rows = db.prepare('SELECT requirement_id, section_ref FROM evidence_requirement_links WHERE evidence_id=?').all(fromEvidenceId);
  const ins = db.prepare('INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, section_ref) VALUES (?, ?, ?)');
  for (const l of rows) ins.run(toEvidenceId, l.requirement_id, l.section_ref);
  return rows.length;
}

// Update section_ref on an ISO 27001 link addressed by the legacy
// evidence_controls.id handle. Returns true if a row matched.
function updateIsoSection(db, conv, evidenceId, legacyLinkId, newRef) {
  if (!conv) {
    const info = db.prepare('UPDATE evidence_controls SET section_ref=? WHERE id=? AND evidence_id=?').run(newRef ?? null, legacyLinkId, evidenceId);
    return info.changes > 0;
  }
  const ec = db.prepare('SELECT iso_item_id FROM evidence_controls WHERE id=? AND evidence_id=?').get(legacyLinkId, evidenceId);
  if (!ec) return false;
  const rid = reqId(db, 'iso27001', ec.iso_item_id);
  if (!rid) return false;
  db.prepare('UPDATE evidence_requirement_links SET section_ref=? WHERE evidence_id=? AND requirement_id=?').run(newRef ?? null, evidenceId, rid);
  return true;
}

// Unlink an ISO 27001 control addressed by the legacy evidence_controls.id handle.
// Returns the removed iso_item_id (so the caller can clear evidence.iso_item_id if
// it was the primary), or null if no row matched.
function unlinkIsoControl(db, conv, evidenceId, legacyLinkId) {
  const ec = db.prepare('SELECT id, iso_item_id FROM evidence_controls WHERE id=? AND evidence_id=?').get(legacyLinkId, evidenceId);
  if (!ec) return null;
  if (!conv) {
    db.prepare('DELETE FROM evidence_controls WHERE id=?').run(ec.id);
    return ec.iso_item_id;
  }
  const rid = reqId(db, 'iso27001', ec.iso_item_id);
  if (!rid) return null;
  db.prepare('DELETE FROM evidence_requirement_links WHERE evidence_id=? AND requirement_id=?').run(evidenceId, rid);
  return ec.iso_item_id;
}

// Unlink a cross-framework link addressed by the legacy evidence_links.id handle
// (non-iso27001). Returns the removed { framework, item_ref } or null.
function unlinkCrossLink(db, conv, evidenceId, legacyLinkId) {
  const el = db.prepare("SELECT id, framework, item_ref FROM evidence_links WHERE id=? AND evidence_id=? AND framework != 'iso27001'").get(legacyLinkId, evidenceId);
  if (!el) return null;
  if (!conv) {
    db.prepare('DELETE FROM evidence_links WHERE id=?').run(el.id);
    return { framework: el.framework, item_ref: el.item_ref };
  }
  const rid = reqId(db, el.framework, el.item_ref);
  if (!rid) return null;
  db.prepare('DELETE FROM evidence_requirement_links WHERE evidence_id=? AND requirement_id=?').run(evidenceId, rid);
  return { framework: el.framework, item_ref: el.item_ref };
}

module.exports = {
  FLAG_KEY,
  writesConverged,
  reqId,
  attachIsoControl,
  attachCrossLink,
  copyControlLinks,
  updateIsoSection,
  unlinkIsoControl,
  unlinkCrossLink,
};
