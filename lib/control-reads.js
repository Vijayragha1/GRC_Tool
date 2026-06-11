'use strict';
// Control-instance READ routing for cutover 3.
//
// Per-workspace flag `control_reads_converged` selects whether a workspace's
// control-state / document-link DISPLAY reads come from the legacy tables or the
// converged compatibility views (migration 012), which present control_instances /
// document_requirement_links with the legacy column names + de-normalized display
// values. Because the views are column-compatible, a read site only swaps the
// table NAME; the query structure (and rendered output) is unchanged.
//
// Fails SAFE to legacy when the flag system / converged schema is absent (fresh
// boots without the flag rows, tests). WRITES stay on the legacy tables until
// cutover 4, so read-modify-write paths (assess wizard, getOrCreateState, review
// workflow, SoA save) must NOT use these helpers.

const FLAG_KEY = 'control_reads_converged';

function converged(db, workspaceId) {
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

// Table/view names to interpolate into this workspace's control-instance reads.
function tables(db, workspaceId) {
  const c = converged(db, workspaceId);
  return {
    converged: c,
    cs:    c ? 'v_control_states'            : 'control_states',
    cs42:  c ? 'v_iso42001_control_states'   : 'iso42001_control_states',
    doc:   c ? 'v_document_controls'         : 'document_controls',
    doc42: c ? 'v_iso42001_document_controls': 'iso42001_document_controls',
  };
}

module.exports = { FLAG_KEY, converged, tables };
