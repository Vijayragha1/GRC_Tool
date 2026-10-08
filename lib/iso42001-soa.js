'use strict';
// ISO 42001 Statement of Applicability snapshots and their approval
// (migration 072).
//
// A snapshot seals the SoA as it stood: every Annex A control and custom
// control with its applicability, status and justifications, and the risks
// and documents behind each one. It is approved by a user with sign-off
// permission who did not capture it, and only when the SoA is complete: no
// control undecided, every exclusion justified and every inclusion
// justified. The approved snapshot is the SoA the auditor is given.

const crypto = require('crypto');
const ctlReads = require('./control-reads');
const docLinks = require('./doc-links');

class SoaError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function payloadFor(db, workspace) {
  const T = ctlReads.tables(db, workspace.id);
  const rows = db.prepare(`SELECT i.id, i.title, i.category, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.inclusion_justification, cs.exclusion_justification
    FROM iso42001_items i
    LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type = 'control' ORDER BY i.sort_order`).all(workspace.id);
  const risks = db.prepare(`SELECT rc.iso_item_id, r.id, r.title FROM iso42001_risk_controls rc
    JOIN risks r ON r.id = rc.risk_id WHERE r.workspace_id=? ORDER BY r.id`).all(workspace.id);
  const docs = db.prepare(`SELECT dc.iso_item_id, d.id, d.name FROM ${docLinks.docControlsExpr('iso42001')} dc
    JOIN generated_docs d ON d.id = dc.document_id WHERE d.workspace_id=? AND d.retired_at IS NULL ORDER BY d.name`).all(workspace.id);
  for (const r of rows) {
    r.risks = risks.filter((x) => x.iso_item_id === r.id).map((x) => ({ id: x.id, title: x.title }));
    r.documents = docs.filter((x) => x.iso_item_id === r.id).map((x) => ({ id: x.id, name: x.name }));
  }
  const customs = db.prepare(`SELECT id, code, title, source, summary, applicability, status, inclusion_justification, exclusion_justification
    FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY code, id`).all(workspace.id);
  return { rows, customs };
}

const hash = (payload) => crypto.createHash('sha256').update(payload).digest('hex');

// What stops the SoA being approved: controls still undecided, and included
// or excluded controls without their justification.
function issues(payload) {
  const all = [
    ...(payload.rows || []).map((r) => ({ ref: r.title, ...r })),
    ...(payload.customs || []).map((c) => ({ ref: `${c.code} ${c.title}`, ...c })),
  ];
  const blank = (v) => !String(v || '').trim();
  return {
    undecided: all.filter((r) => r.applicability === 'undecided').map((r) => r.ref),
    excludedUnjustified: all.filter((r) => r.applicability === 'excluded' && blank(r.exclusion_justification)).map((r) => r.ref),
    includedUnjustified: all.filter((r) => r.applicability === 'included' && blank(r.inclusion_justification)).map((r) => r.ref),
  };
}
const issueCount = (i) => i.undecided.length + i.excludedUnjustified.length + i.includedUnjustified.length;

function capture(db, workspace, actorId, meta = {}) {
  const payloadObj = payloadFor(db, workspace);
  const payload = JSON.stringify(payloadObj);
  const all = [...payloadObj.rows, ...payloadObj.customs];
  const clean = (v, max = 200) => (v == null ? null : (String(v).trim().slice(0, max) || null));
  return Number(db.prepare(`INSERT INTO iso42001_soa_snapshots
      (workspace_id, label, reason, version, owner, payload, payload_hash, control_count, included_count, excluded_count, created_by, approval_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
    .run(workspace.id, clean(meta.label) || 'Snapshot', clean(meta.reason, 2000), clean(meta.version, 40), clean(meta.owner),
      payload, hash(payload), all.length,
      all.filter((r) => r.applicability === 'included').length,
      all.filter((r) => r.applicability === 'excluded').length, actorId).lastInsertRowid);
}

function load(db, workspace, id) {
  const row = db.prepare(`SELECT s.*, u.name AS created_by_name FROM iso42001_soa_snapshots s
    LEFT JOIN users u ON u.id = s.created_by WHERE s.id=? AND s.workspace_id=?`).get(id, workspace.id);
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  return { ...row, content: payload, intact: hash(row.payload) === row.payload_hash, issues: issues(payload) };
}

function approve(db, workspace, actor, id, note) {
  const snap = load(db, workspace, id);
  if (!snap) throw new SoaError('That snapshot was not found.', 404);
  if (snap.approval_status === 'approved') throw new SoaError('This snapshot is already approved.', 409);
  if (!snap.intact) throw new SoaError('This snapshot no longer matches its seal and cannot be approved. Capture a new one.', 409);
  if (Number(snap.created_by) === Number(actor.id)) {
    throw new SoaError('The SoA is approved by someone other than the person who captured it.', 409);
  }
  const problems = snap.issues;
  if (issueCount(problems)) {
    const parts = [];
    if (problems.undecided.length) parts.push(`${problems.undecided.length} undecided`);
    if (problems.excludedUnjustified.length) parts.push(`${problems.excludedUnjustified.length} excluded without a justification`);
    if (problems.includedUnjustified.length) parts.push(`${problems.includedUnjustified.length} included without a justification`);
    throw new SoaError(`This snapshot cannot be approved: ${parts.join(', ')}. Complete the SoA and capture a new snapshot.`, 409);
  }
  db.prepare(`UPDATE iso42001_soa_snapshots SET approval_status='approved', approved_by_user_id=?, approved_by_name=?,
      approved_on=datetime('now'), approval_note=? WHERE id=? AND workspace_id=?`)
    .run(actor.id, actor.name || null, note ? String(note).trim().slice(0, 2000) : null, snap.id, workspace.id);
  return snap.id;
}

function latestApproved(db, workspace) {
  return db.prepare(`SELECT id, label, version, approved_by_name, approved_on FROM iso42001_soa_snapshots
    WHERE workspace_id=? AND approval_status='approved' ORDER BY approved_on DESC, id DESC LIMIT 1`).get(workspace.id) || null;
}

module.exports = { SoaError, payloadFor, issues, issueCount, capture, load, approve, latestApproved };
