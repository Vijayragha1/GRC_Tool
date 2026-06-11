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

// ---- normalization (writable display values -> converged tokens) -----------
// Mirrors the 012 view de-normalization and the 013/014 trigger CASE maps. The
// writable vocabulary is closed (6 statuses, 3 applicabilities); an unmapped
// value passes through RAW so it fails loud downstream (surfaces as
// '!!UNMAPPED:<value>' in the read views, or trips the applicability CHECK).
const STATUS_TO_TOKEN = {
  'Implemented': 'implemented',
  'Partially Implemented': 'partially_implemented',
  'Work In Progress': 'work_in_progress',
  'Not Assessed': 'not_assessed',
  'Not Implemented': 'not_implemented',
  'Not Applicable': 'not_applicable',
};
const APPLIC_TO_TOKEN = { 'included': 'applicable', 'excluded': 'excluded', 'undecided': 'undecided' };

function normStatus(displayValue) {
  if (displayValue == null) return displayValue;
  return Object.prototype.hasOwnProperty.call(STATUS_TO_TOKEN, displayValue) ? STATUS_TO_TOKEN[displayValue] : displayValue;
}
function normApplic(legacyValue) {
  if (legacyValue == null) return legacyValue;
  return Object.prototype.hasOwnProperty.call(APPLIC_TO_TOKEN, legacyValue) ? APPLIC_TO_TOKEN[legacyValue] : legacyValue;
}

// Transform a legacy (sets, vals) UPDATE spec into the converged equivalent for
// control_instances. control_instances shares the legacy column NAMES, so most
// pairs pass through unchanged; only `status` and `applicability` values are
// normalized to tokens. `assessment_answers` has NO converged column (deferred to
// the Phase 4 / wizard-detail convergence), so it is DROPPED here; the caller
// persists it to legacy control_states separately. CURRENT_TIMESTAMP sets (which
// carry no bound value) pass through. sets and vals are parallel: each set ending
// in '=?' consumes the next vals entry, in order.
function convergeSets(sets, vals) {
  const cSets = [], cVals = [];
  let vi = 0;
  for (const s of sets) {
    const hasVal = s.endsWith('=?');
    const col = s.split('=')[0].trim();
    const v = hasVal ? vals[vi++] : undefined;
    if (col === 'assessment_answers') continue;            // deferred: no converged column
    if (col === 'status') { cSets.push('status=?'); cVals.push(normStatus(v)); }
    else if (col === 'applicability') { cSets.push('applicability=?'); cVals.push(normApplic(v)); }
    else { cSets.push(s); if (hasVal) cVals.push(v); }
  }
  return { sets: cSets, vals: cVals };
}

module.exports = { FLAG_KEY, converged, requirementId, normStatus, normApplic, convergeSets };
