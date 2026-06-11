'use strict';
// Control-instance WRITE routing for cutover 4.
//
// Per-workspace flag `control_writes_converged` selects whether a workspace's
// control-state writes target the converged `control_instances` (primary) or the
// legacy `control_states` / `iso42001_control_states`. Reads are already converged
// (cutover 3); the bidirectional sync triggers (013 legacy->converged + 014
// converged->legacy) keep BOTH tables row-consistent throughout the cutover, so a
// workspace can be mid-conversion (some write sites flipped, some not) and stay
// consistent. The flag's effect is which table is the AUTHORITATIVE write target,
// which matters for the eventual control-state demolition (when legacy is dropped
// and every write must already be converged-primary).
//
// Fails SAFE to legacy when the flag system / converged schema / requirement
// mapping is absent (fresh boots, the suite, an unmapped item), so a write site
// that calls converged() can always fall back to its original legacy path.

const FLAG_KEY = 'control_writes_converged';

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

// Map a legacy iso_item_id (e.g. 'annex-a.5.1' / 'ai-annex-a-2-2') to its
// converged requirement_id for a framework. Returns null when unmapped (fresh
// boots without the catalog backfill, or an item with no requirement), so callers
// fall back to the legacy write path.
function requirementId(db, framework, isoItemId) {
  if (!isoItemId) return null;
  try {
    const r = db.prepare(
      `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
       WHERE f.code = ? AND rq.ref = ?`
    ).get(framework, isoItemId);
    return r ? r.id : null;
  } catch (_) {
    return null;
  }
}

module.exports = { FLAG_KEY, converged, requirementId };
