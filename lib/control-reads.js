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

// Post control-state demolition (migration 019): the legacy control_states /
// iso42001_control_states tables are gone, so reads are UNCONDITIONALLY converged
// (the compat views over control_instances). The per-workspace flag and the
// fail-safe-to-legacy path are retired; there is no legacy table to fall back to.
function converged(/* db, workspaceId */) {
  return true;
}

// Table/view names to interpolate into this workspace's control-instance reads.
// doc/doc42 were removed when the document_controls join tables + their compat
// views were demolished (migration 018): doc<->control links are drl-native now
// (lib/doc-links.js), not routed through this helper.
function tables(/* db, workspaceId */) {
  return {
    converged: true,
    cs:    'v_control_states',
    cs42:  'v_iso42001_control_states',
  };
}

module.exports = { FLAG_KEY, converged, tables };
