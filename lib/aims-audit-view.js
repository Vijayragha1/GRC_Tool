'use strict';
// What a certification auditor sees of an ISO 42001 AI management system, for
// the auditor portal (routes/auditor.js) and the audit pack (lib/audit-pack.js):
// the Statement of Applicability the client approved, the AI system register
// and the approved impact assessments. The portal and the pack also name the
// management system after the standards the client works to.

const reqOpts = require('./requirement-options');
const aimsSoa = require('./iso42001-soa');
const registry = require('./ai-systems');

const STANDARD = { iso27001: 'ISO/IEC 27001:2022', iso42001: 'ISO/IEC 42001:2023' };

function standards(workspace) {
  const codes = reqOpts.enabledCodes(workspace);
  const isms = codes.includes('iso27001');
  const aims = codes.includes('iso42001');
  // A client with neither standard enabled is treated as ISO 27001, as before.
  const shown = [isms || !aims ? 'iso27001' : null, aims ? 'iso42001' : null].filter(Boolean);
  return {
    isms: isms || !aims,
    aims,
    system: shown.length > 1 ? 'ISMS and AIMS' : aims ? 'AIMS' : 'ISMS',
    systemLong: shown.length > 1 ? 'Information Security and AI Management Systems'
      : aims ? 'AI Management System' : 'Information Security Management System',
    standardText: shown.map((c) => STANDARD[c]).join(' and '),
  };
}

const counts = (rows) => ({
  total: rows.length,
  included: rows.filter((r) => r.applicability === 'included').length,
  excluded: rows.filter((r) => r.applicability === 'excluded').length,
  undecided: rows.filter((r) => !['included', 'excluded'].includes(r.applicability)).length,
});

// Annex A rows plus the client's own controls, in one list the auditor reads.
function soaRows(content) {
  const rows = (content.rows || []).map((r) => ({ ...r, code: reqOpts.codeOf(r), title: String(r.title || '').replace(/^A\.[0-9.]+ /, '') }));
  const customs = (content.customs || []).map((r) => ({ ...r, id: `custom-${r.id}`, custom: true }));
  return [...rows, ...customs];
}

const snapshotList = (db, workspace) => db.prepare(`SELECT id, label, version, created_at, payload_hash, included_count, approval_status, approved_on
  FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC`).all(workspace.id);

// The SoA to show: the one asked for, else the latest approved, else the
// latest captured, else the live state (flagged as such).
function soa(db, workspace, snapshotId = null) {
  let snapshot = null;
  if (snapshotId) {
    snapshot = aimsSoa.load(db, workspace, snapshotId);
    if (!snapshot) return null;
  } else {
    const approved = aimsSoa.latestApproved(db, workspace);
    const latest = db.prepare('SELECT id FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT 1').get(workspace.id);
    const id = approved ? approved.id : latest && latest.id;
    snapshot = id ? aimsSoa.load(db, workspace, id) : null;
  }
  const rows = soaRows(snapshot ? snapshot.content : aimsSoa.payloadFor(db, workspace));
  return {
    from: snapshot ? (snapshot.approval_status === 'approved' ? 'approved' : 'snapshot') : 'live',
    snapshot, rows, counts: counts(rows), allSnaps: snapshotList(db, workspace),
  };
}

function systems(db, workspace) {
  return registry.list(db, workspace).map((s) => ({
    ...s,
    rolesText: s.roles.map((r) => registry.ROLES[r] || r).join(', '),
    lifecycleText: registry.LIFECYCLE[s.lifecycle_stage] || s.lifecycle_stage,
    assessment: registry.reassessment(db, workspace, s.id),
  }));
}

// Approved impact assessments, newest version first for each system. Drafts
// are the consultant's working papers and are not shown.
function assessments(db, workspace) {
  return db.prepare(`SELECT ia.id, ia.ai_system_id, ia.version_no, ia.status, ia.approved_at, ia.residual_level, ia.decision,
      ia.next_review_date, s.name AS system_name, u.name AS approved_by_name
    FROM ai_impact_assessments ia JOIN ai_systems s ON s.id = ia.ai_system_id AND s.workspace_id = ia.workspace_id
    LEFT JOIN users u ON u.id = ia.approved_by
    WHERE ia.workspace_id=? AND ia.status IN ('approved','superseded')
    ORDER BY s.name, ia.version_no DESC`).all(workspace.id).map((a) => ({
    ...a,
    residualText: a.residual_level ? registry.RESIDUAL[a.residual_level] : null,
    decisionText: a.decision ? registry.DECISIONS[a.decision] : null,
  }));
}

function gather(db, workspace) {
  return { soa: soa(db, workspace), systems: systems(db, workspace), assessments: assessments(db, workspace) };
}

module.exports = { STANDARD, standards, soa, systems, assessments, gather };
