'use strict';
// The ISO 27001 <-> ISO 42001 crosswalk (migration 074) put to work for a
// client on both standards: on an ISO 42001 requirement, what the matching ISO
// 27001 requirement already has on record (its status and its evidence), and
// a way to reuse that evidence without uploading it again. Each pair is
// partial, so the note on what ISO 42001 adds is shown with it.

const reqOpts = require('./requirement-options');
const evWrites = require('./evidence-writes');

const STATE_VIEW = { iso27001: 'v_control_states', iso42001: 'v_iso42001_control_states' };
const ISO = Object.keys(STATE_VIEW);

class CrosswalkError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Current evidence linked to a requirement, by either link path.
function evidenceFor(db, workspace, framework, ref) {
  return db.prepare(`SELECT e.id, e.filename, e.uploaded_at, e.valid_until FROM evidence e
    WHERE e.workspace_id=? AND e.superseded_at IS NULL AND e.id IN (
      SELECT id FROM evidence WHERE workspace_id=? AND iso_item_id=?
      UNION
      SELECT erl.evidence_id FROM evidence_requirement_links erl
        JOIN requirements rq ON rq.id = erl.requirement_id
        JOIN frameworks f ON f.id = rq.framework_id AND f.code = ?
        WHERE rq.ref = ?)
    ORDER BY e.uploaded_at DESC`).all(workspace.id, workspace.id, ref, framework, ref);
}

// The other standard's requirements paired with this one, for the standards
// the client works to.
function counterparts(db, workspace, framework, ref) {
  const enabled = reqOpts.enabledCodes(workspace).filter((c) => ISO.includes(c) && c !== framework);
  if (!enabled.length || !ISO.includes(framework)) return [];
  const rows = db.prepare(`SELECT other.ref, other.title, fo.code AS framework, m.coverage, m.residual_gap_note AS note
    FROM requirements me
    JOIN frameworks fm ON fm.id = me.framework_id AND fm.code = ?
    JOIN requirement_mappings m ON me.id IN (m.canonical_requirement_id, m.mapped_requirement_id)
    JOIN requirements other ON other.id = CASE WHEN m.canonical_requirement_id = me.id THEN m.mapped_requirement_id ELSE m.canonical_requirement_id END
    JOIN frameworks fo ON fo.id = other.framework_id
    WHERE me.ref = ? AND fo.code IN (${enabled.map(() => '?').join(',')})
    ORDER BY fo.code, other.id`).all(framework, ref, ...enabled);
  const mine = new Set(evidenceFor(db, workspace, framework, ref).map((e) => e.id));
  return rows.map((r) => {
    const state = db.prepare(`SELECT status, applicability FROM ${STATE_VIEW[r.framework]} WHERE workspace_id=? AND iso_item_id=?`).get(workspace.id, r.ref) || {};
    const evidence = evidenceFor(db, workspace, r.framework, r.ref);
    return {
      ...r,
      code: reqOpts.codeOf({ id: r.ref, title: r.title }),
      frameworkLabel: reqOpts.label(r.framework),
      status: state.status || 'Not Assessed',
      evidence: evidence.map((e) => ({ ...e, alreadyLinked: mine.has(e.id) })),
    };
  });
}

// Link a file already on record against the paired requirement to this one.
function reuseEvidence(db, workspace, framework, ref, evidenceId) {
  const pairs = counterparts(db, workspace, framework, ref);
  const source = pairs.find((p) => p.evidence.some((e) => e.id === Number(evidenceId)));
  if (!source) throw new CrosswalkError('That file is not on record against a paired requirement.', 404);
  const linked = evWrites.attachCrossLink(db, Number(evidenceId), framework, ref, null);
  if (!linked) throw new CrosswalkError('The requirement is unavailable.', 404);
  return { from: source };
}

module.exports = { CrosswalkError, counterparts, reuseEvidence, evidenceFor };
