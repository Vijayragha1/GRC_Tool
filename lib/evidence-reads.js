'use strict';

const { ALLOWED_FRAMEWORKS, byFramework } = require('./frameworks');

// Evidence-linkage READ paths, converged (post Phase 2 demolition).
//
// Evidence is linked to controls/requirements through `evidence_requirement_links`
// (erl) -> requirements -> frameworks. The legacy evidence_controls / evidence_links
// join tables were demolished (migration 011); the actionable link handle is now
// erl.id (erl-native). Control titles/types still come from the per-framework
// catalogs (iso_items / iso42001_items / csf_subcategories) joined via requirements.ref,
// so rendered output is unchanged. The core `evidence` table (primary iso_item_id
// column) persists and backs the coverage "primary path" half, unchanged.

// ---- Correlated subquery STRINGS (interpolated into a host query) ----------
// Each references an OUTER evidence row aliased `e` (or control row aliased `i`).

// COUNT of every governed requirement link for the outer evidence row `e`.
// This is intentionally framework-neutral: an artefact linked only to DPDPA
// must not appear as "unlinked" in the shared evidence library.
function linkCountSubquery() {
  return `(SELECT COUNT(*) FROM evidence_requirement_links erl_lc
            WHERE erl_lc.evidence_id = e.id)`;
}

// GROUP_CONCAT of framework-qualified requirement refs for the outer evidence row `e`
// (the manifest "linked_controls" cell in evidence packs).
function linkedControlsSubquery() {
  return `(SELECT GROUP_CONCAT(f_lk.code || ':' || rq_lk.ref, '; ') FROM evidence_requirement_links erl_lk
            JOIN requirements rq_lk ON rq_lk.id = erl_lk.requirement_id
            JOIN frameworks f_lk ON f_lk.id = rq_lk.framework_id
            WHERE erl_lk.evidence_id = e.id)`;
}

// COUNT of ISO 27001 evidence for the outer control row `i`, scoped to a
// workspace param (one trailing `?` bound to the workspace id).
function checklistEvidenceCountSubquery() {
  return `(SELECT COUNT(*) FROM evidence_requirement_links erl_ck
            JOIN evidence e_ck ON e_ck.id = erl_ck.evidence_id
            JOIN requirements rq_ck ON rq_ck.id = erl_ck.requirement_id
            JOIN frameworks f_ck ON f_ck.id = rq_ck.framework_id AND f_ck.code='iso27001'
            WHERE rq_ck.ref = i.id AND e_ck.workspace_id = ?)`;
}

// ---- Full read functions returning JS structures the views consume ----------

// Evidence library: { linksByEvidence, crossLinksByEvidence } for the given
// evidence ids. linksByEvidence[evId] = [{ link_id, evidence_id, iso_item_id,
// section_ref, iso_title, iso_type }] (ISO 27001 chips, actionable; link_id=erl.id).
// crossLinksByEvidence[evId] is keyed by the governed framework registry.
// ISO 27001 also retains linksByEvidence for its legacy detail URLs.
function libraryLinks(db, evidenceIds) {
  const linksByEvidence = {};
  const crossLinksByEvidence = {};
  if (!evidenceIds || !evidenceIds.length) return { linksByEvidence, crossLinksByEvidence };
  const ph = evidenceIds.map(() => '?').join(',');

  const isoRows = db.prepare(
    `SELECT erl.id AS link_id, erl.evidence_id, rq.ref AS iso_item_id, erl.section_ref,
            i.title AS iso_title, i.type AS iso_type
     FROM evidence_requirement_links erl
     JOIN requirements rq ON rq.id = erl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
     JOIN iso_items i ON i.id = rq.ref
     WHERE erl.evidence_id IN (${ph})
     ORDER BY i.sort_order ASC`
  ).all(...evidenceIds);
  for (const l of isoRows) {
    if (!linksByEvidence[l.evidence_id]) linksByEvidence[l.evidence_id] = [];
    linksByEvidence[l.evidence_id].push(l);
  }

  // The framework filter is built from the registry, not typed out here. When
  // this list was a literal, a newly registered framework's cross-links were
  // dropped by the WHERE clause and the bucket was missing from the shape
  // below, so the evidence library silently showed the file as unlinked.
  // The two LEFT JOINs stay framework-specific on purpose: they enrich from
  // per-framework catalog tables, and a framework without one simply gets no
  // enrichment rather than being excluded.
  const codePh = ALLOWED_FRAMEWORKS.map(() => '?').join(',');
  const crossRows = db.prepare(
    `SELECT erl.id AS link_id, erl.evidence_id, f.code AS framework, rq.ref AS item_ref, erl.section_ref,
            ai.title AS iso42001_title, cs.description AS csf_description,
            rq.title AS requirement_title
     FROM evidence_requirement_links erl
     JOIN requirements rq ON rq.id = erl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id
     LEFT JOIN iso42001_items ai ON f.code='iso42001' AND ai.id = rq.ref
     LEFT JOIN csf_subcategories cs ON f.code='csf' AND cs.code = rq.ref
     WHERE erl.evidence_id IN (${ph}) AND f.code IN (${codePh})
     ORDER BY f.code, rq.ref`
  ).all(...evidenceIds, ...ALLOWED_FRAMEWORKS);
  for (const l of crossRows) {
    if (!crossLinksByEvidence[l.evidence_id]) crossLinksByEvidence[l.evidence_id] = byFramework();
    crossLinksByEvidence[l.evidence_id][l.framework].push(l);
  }
  return { linksByEvidence, crossLinksByEvidence };
}

// Control-detail evidence panel: evidence rows linked to `isoItemId` via the
// primary path (evidence.iso_item_id, core table) OR the converged join.
function controlPanelEvidence(db, workspaceId, isoItemId) {
  return db.prepare(
    `SELECT e.id, e.filename, e.size_bytes, e.description, e.uploaded_at,
            e.valid_from, e.valid_until, e.period_label, e.clause_section,
            u.name AS uploader,
            ${linkCountSubquery()} AS link_count
     FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
     WHERE e.workspace_id=? AND e.id IN (
       SELECT id FROM evidence WHERE workspace_id=? AND iso_item_id=?
       UNION
       SELECT erl.evidence_id FROM evidence_requirement_links erl
         JOIN requirements rq ON rq.id = erl.requirement_id
         JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
         WHERE rq.ref = ?
     )
     ORDER BY e.uploaded_at DESC`
  ).all(workspaceId, workspaceId, isoItemId, isoItemId);
}

// Evidence-coverage matrix: { iso_item_id: { attached, last_uploaded_at } }.
// Legacy UNION ALL (primary evidence.iso_item_id + join) preserved; the join half
// now reads erl.
function coverageEvidenceByControl(db, workspaceId) {
  const out = {};
  db.prepare(
    `SELECT iso_item_id, MAX(uploaded_at) AS last_uploaded_at, COUNT(*) AS attached
     FROM (
       SELECT iso_item_id, uploaded_at FROM evidence WHERE workspace_id=? AND iso_item_id IS NOT NULL AND superseded_at IS NULL
       UNION ALL
       SELECT rq.ref AS iso_item_id, e.uploaded_at FROM evidence_requirement_links erl
         INNER JOIN evidence e ON e.id = erl.evidence_id
         INNER JOIN requirements rq ON rq.id = erl.requirement_id
         INNER JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso27001'
         WHERE e.workspace_id=? AND e.superseded_at IS NULL
     )
     GROUP BY iso_item_id`
  ).all(workspaceId, workspaceId).forEach(r => {
    out[r.iso_item_id] = { attached: r.attached, last_uploaded_at: r.last_uploaded_at };
  });
  return out;
}

module.exports = {
  linkCountSubquery,
  linkedControlsSubquery,
  checklistEvidenceCountSubquery,
  libraryLinks,
  controlPanelEvidence,
  coverageEvidenceByControl,
};
