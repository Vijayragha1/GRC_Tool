'use strict';
// Evidence-linkage READ paths, dual-sourced for cutover 1 of 5 (evidence reads).
//
// Background: evidence is linked to controls/requirements through two LEGACY
// join tables scheduled for demolition - `evidence_controls` (ISO 27001) and
// `evidence_links` (cross-framework, trigger-mirrored). The converged schema
// replaces both with `evidence_requirement_links` (erl -> requirements ->
// frameworks). The Phase 2 backfill made erl a faithful copy of the legacy
// join set (verified: 0/0 symmetric difference on the dev instance).
//
// This module is the SINGLE home for every evidence-linkage read that touched
// a demolition table. Each function takes a `converged` boolean and returns
// BYTE-IDENTICAL output whether it reads the legacy tables (converged=false) or
// erl (converged=true). server.js picks the branch per request via the
// per-workspace feature flag `evidence_reads_converged`; the parity harness
// (migrations/fixtures/cutover1_evidence_parity.js) calls both branches and
// asserts deep equality, which is the cutover's parity proof.
//
// WRITES STAY LEGACY in this cutover. The two surfaces that render an
// actionable `link_id` (the evidence-library unlink / section-edit forms) keep
// the legacy `evidence_controls.id` / `evidence_links.id` as the handle even on
// the converged path (recovered via a LEFT JOIN), so the still-legacy write
// routes keep working until cutover 2 moves writes too.
//
// Notes on exact parity:
//  - Control titles/types come from the SAME catalogs (`iso_items`,
//    `iso42001_items`, `csf_subcategories`) on both paths; only the LINKAGE
//    source changes. requirements.ref == the legacy item ref (the backfill
//    resolved every link by exact ref match), so JOIN iso_items i ON i.id=rq.ref
//    reproduces the legacy title/type.
//  - The coverage counts use legacy `UNION ALL` (primary `evidence.iso_item_id`
//    + join table). The primary half reads the core `evidence` table, which
//    PERSISTS, so it is unchanged on both paths; only the join half switches.
//  - erl.section_ref was backfilled from the legacy section_ref (ISO controls
//    first, INSERT OR IGNORE), so per-link section refs match.

const FLAG_KEY = 'evidence_reads_converged';

// Per-workspace flag with a global default fallback. No row => false (legacy).
// Fails SAFE to the legacy path: if the flag system (or the converged schema)
// is not present - e.g. a fresh app boot seeded by db.js without the migration
// runner having created feature_flags, as in the test harness - this returns
// false so reads stay on the proven legacy tables. A flag lookup must never
// break a page.
function readsConverged(db, workspaceId) {
  if (!workspaceId) return false;
  try {
    const ws = db.prepare('SELECT enabled FROM feature_flags WHERE key=? AND workspace_id=?').get(FLAG_KEY, workspaceId);
    if (ws) return !!ws.enabled;
    const g = db.prepare('SELECT enabled FROM feature_flags WHERE key=? AND workspace_id IS NULL').get(FLAG_KEY);
    return g ? !!g.enabled : false;
  } catch (_) {
    return false; // no feature_flags table / converged schema not applied -> legacy
  }
}

// ---- Correlated subquery STRINGS (interpolated into a host query) ----------
// Each references an OUTER evidence row aliased `e` (or control row aliased `i`).

// COUNT of ISO 27001 links for the outer evidence row `e`.
function linkCountSubquery(converged) {
  return converged
    ? `(SELECT COUNT(*) FROM evidence_requirement_links erl_lc
          JOIN requirements rq_lc ON rq_lc.id = erl_lc.requirement_id
          JOIN frameworks f_lc ON f_lc.id = rq_lc.framework_id AND f_lc.code='iso27001'
          WHERE erl_lc.evidence_id = e.id)`
    : `(SELECT COUNT(*) FROM evidence_controls ec WHERE ec.evidence_id = e.id)`;
}

// GROUP_CONCAT of ISO 27001 control refs for the outer evidence row `e`
// (the manifest "linked_controls" cell in evidence packs).
function linkedControlsSubquery(converged) {
  return converged
    ? `(SELECT GROUP_CONCAT(rq_lk.ref, '; ') FROM evidence_requirement_links erl_lk
          JOIN requirements rq_lk ON rq_lk.id = erl_lk.requirement_id
          JOIN frameworks f_lk ON f_lk.id = rq_lk.framework_id AND f_lk.code='iso27001'
          WHERE erl_lk.evidence_id = e.id)`
    : `(SELECT GROUP_CONCAT(iso_item_id, '; ') FROM evidence_controls WHERE evidence_id = e.id)`;
}

// COUNT of ISO 27001 evidence for the outer control row `i`, scoped to a
// workspace param (one trailing `?` bound to the workspace id).
function checklistEvidenceCountSubquery(converged) {
  return converged
    ? `(SELECT COUNT(*) FROM evidence_requirement_links erl_ck
          JOIN evidence e_ck ON e_ck.id = erl_ck.evidence_id
          JOIN requirements rq_ck ON rq_ck.id = erl_ck.requirement_id
          JOIN frameworks f_ck ON f_ck.id = rq_ck.framework_id AND f_ck.code='iso27001'
          WHERE rq_ck.ref = i.id AND e_ck.workspace_id = ?)`
    : `(SELECT COUNT(*) FROM evidence_controls ec INNER JOIN evidence e ON e.id = ec.evidence_id
          WHERE ec.iso_item_id = i.id AND e.workspace_id = ?)`;
}

// ---- Full read functions returning JS structures the views consume ----------

// Evidence library: { linksByEvidence, crossLinksByEvidence } for the given
// evidence ids. linksByEvidence[evId] = [{ link_id, evidence_id, iso_item_id,
// section_ref, iso_title, iso_type }] (ISO 27001 chips, actionable).
// crossLinksByEvidence[evId] = { iso27001:[], iso42001:[], csf:[] } (iso27001
// used for the count badge only; iso42001/csf are actionable chips).
function libraryLinks(db, evidenceIds, converged) {
  const linksByEvidence = {};
  const crossLinksByEvidence = {};
  if (!evidenceIds || !evidenceIds.length) return { linksByEvidence, crossLinksByEvidence };
  const ph = evidenceIds.map(() => '?').join(',');

  const isoSql = converged
    ? `SELECT ec.id AS link_id, erl.evidence_id, rq.ref AS iso_item_id, erl.section_ref,
              i.title AS iso_title, i.type AS iso_type
         FROM evidence_requirement_links erl
         JOIN requirements rq ON rq.id = erl.requirement_id
         JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
         JOIN iso_items i ON i.id = rq.ref
         LEFT JOIN evidence_controls ec ON ec.evidence_id = erl.evidence_id AND ec.iso_item_id = rq.ref
         WHERE erl.evidence_id IN (${ph})
         ORDER BY i.sort_order ASC`
    : `SELECT ec.id AS link_id, ec.evidence_id, ec.iso_item_id, ec.section_ref,
              i.title AS iso_title, i.type AS iso_type
         FROM evidence_controls ec
         INNER JOIN iso_items i ON i.id = ec.iso_item_id
         WHERE ec.evidence_id IN (${ph})
         ORDER BY i.sort_order ASC`;
  for (const l of db.prepare(isoSql).all(...evidenceIds)) {
    if (!linksByEvidence[l.evidence_id]) linksByEvidence[l.evidence_id] = [];
    linksByEvidence[l.evidence_id].push(l);
  }

  const crossSql = converged
    ? `SELECT el.id AS link_id, erl.evidence_id, f.code AS framework, rq.ref AS item_ref, erl.section_ref,
              ai.title AS iso42001_title, cs.description AS csf_description
         FROM evidence_requirement_links erl
         JOIN requirements rq ON rq.id = erl.requirement_id
         JOIN frameworks f ON f.id = rq.framework_id
         LEFT JOIN iso42001_items ai ON f.code='iso42001' AND ai.id = rq.ref
         LEFT JOIN csf_subcategories cs ON f.code='csf' AND cs.code = rq.ref
         LEFT JOIN evidence_links el ON el.evidence_id = erl.evidence_id AND el.framework = f.code AND el.item_ref = rq.ref
         WHERE erl.evidence_id IN (${ph}) AND f.code IN ('iso27001','iso42001','csf')
         ORDER BY f.code, rq.ref`
    : `SELECT el.id AS link_id, el.evidence_id, el.framework, el.item_ref, el.section_ref,
              ai.title AS iso42001_title, cs.description AS csf_description
         FROM evidence_links el
         LEFT JOIN iso42001_items ai ON el.framework='iso42001' AND ai.id = el.item_ref
         LEFT JOIN csf_subcategories cs ON el.framework='csf' AND cs.code = el.item_ref
         WHERE el.evidence_id IN (${ph})
         ORDER BY el.framework, el.item_ref`;
  for (const l of db.prepare(crossSql).all(...evidenceIds)) {
    if (!crossLinksByEvidence[l.evidence_id]) crossLinksByEvidence[l.evidence_id] = { iso27001: [], iso42001: [], csf: [] };
    crossLinksByEvidence[l.evidence_id][l.framework].push(l);
  }
  return { linksByEvidence, crossLinksByEvidence };
}

// Control-detail evidence panel: evidence rows linked to `isoItemId` via the
// primary path (evidence.iso_item_id, core table, unchanged) OR the join.
function controlPanelEvidence(db, workspaceId, isoItemId, converged) {
  const joinSet = converged
    ? `SELECT erl.evidence_id FROM evidence_requirement_links erl
         JOIN requirements rq ON rq.id = erl.requirement_id
         JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
         WHERE rq.ref = ?`
    : `SELECT evidence_id FROM evidence_controls WHERE iso_item_id = ?`;
  return db.prepare(
    `SELECT e.id, e.filename, e.size_bytes, e.description, e.uploaded_at,
            e.valid_from, e.valid_until, e.period_label, e.clause_section,
            u.name AS uploader,
            ${linkCountSubquery(converged)} AS link_count
     FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
     WHERE e.workspace_id=? AND e.id IN (
       SELECT id FROM evidence WHERE workspace_id=? AND iso_item_id=?
       UNION
       ${joinSet}
     )
     ORDER BY e.uploaded_at DESC`
  ).all(workspaceId, workspaceId, isoItemId, isoItemId);
}

// Evidence-coverage matrix: { iso_item_id: { attached, last_uploaded_at } }.
// Legacy UNION ALL (primary + join) is preserved; only the join half switches.
function coverageEvidenceByControl(db, workspaceId, converged) {
  const joinHalf = converged
    ? `SELECT rq.ref AS iso_item_id, e.uploaded_at FROM evidence_requirement_links erl
         INNER JOIN evidence e ON e.id = erl.evidence_id
         INNER JOIN requirements rq ON rq.id = erl.requirement_id
         INNER JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
         WHERE e.workspace_id=? AND e.superseded_at IS NULL`
    : `SELECT ec.iso_item_id AS iso_item_id, e.uploaded_at FROM evidence_controls ec
         INNER JOIN evidence e ON e.id = ec.evidence_id
         WHERE e.workspace_id=? AND e.superseded_at IS NULL`;
  const out = {};
  db.prepare(
    `SELECT iso_item_id, MAX(uploaded_at) AS last_uploaded_at, COUNT(*) AS attached
     FROM (
       SELECT iso_item_id, uploaded_at FROM evidence WHERE workspace_id=? AND iso_item_id IS NOT NULL AND superseded_at IS NULL
       UNION ALL
       ${joinHalf}
     )
     GROUP BY iso_item_id`
  ).all(workspaceId, workspaceId).forEach(r => {
    out[r.iso_item_id] = { attached: r.attached, last_uploaded_at: r.last_uploaded_at };
  });
  return out;
}

module.exports = {
  FLAG_KEY,
  readsConverged,
  linkCountSubquery,
  linkedControlsSubquery,
  checklistEvidenceCountSubquery,
  libraryLinks,
  controlPanelEvidence,
  coverageEvidenceByControl,
};
