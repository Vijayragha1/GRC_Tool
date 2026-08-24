'use strict';
// Document<->control link READS + WRITES, converged (post doc-link demolition).
//
// Links live in document_requirement_links (drl) -> requirements -> frameworks.
// The legacy document_controls / iso42001_document_controls join tables and the
// v_document_controls / v_iso42001_document_controls compat views were demolished
// (migration 018); these helpers are drl-native. The actionable link handle is
// drl.id. Control titles/types come from the per-framework catalogs (iso_items /
// iso42001_items) joined via requirements.ref, so rendered output is unchanged.

// Per-framework catalog table for title/category/type joins.
function catalog(framework) {
  return framework === 'iso42001' ? 'iso42001_items' : 'iso_items';
}

// Documents linked to a control (the assess/gap "linked docs" panel).
// Returns rows shaped { id, name, category, status, section_ref, link_id }.
function linkedDocsForControl(db, framework, isoItemId, workspaceId) {
  return db.prepare(
    `SELECT d.id, d.name, d.category, d.status, drl.section_ref, drl.id AS link_id
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id AND f.code = ?
     JOIN generated_docs d ON d.id = drl.document_id
     WHERE rq.ref = ? AND d.workspace_id = ?
     ORDER BY d.name`
  ).all(framework, isoItemId, workspaceId);
}

// Controls linked to a document (the doc-detail "linked controls" panel).
// Returns { link_id, iso_item_id, section_ref, title, category, type }.
function linkedControlsForDoc(db, framework, documentId) {
  return db.prepare(
    `SELECT drl.id AS link_id, rq.ref AS iso_item_id, drl.section_ref, i.title, i.category, i.type
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     JOIN frameworks f ON f.id = rq.framework_id AND f.code = ?
     JOIN ${catalog(framework)} i ON i.id = rq.ref
     WHERE drl.document_id = ?
     ORDER BY i.sort_order`
  ).all(framework, documentId);
}

// Subquery STRING: document_ids already linked to a control, for the "linkable
// docs" NOT IN dropdown. Two bound params: (framework, iso_item_id).
function linkedDocIdsSubquery() {
  return `SELECT drl.document_id FROM document_requirement_links drl
            JOIN requirements rq ON rq.id = drl.requirement_id
            JOIN frameworks f ON f.id = rq.framework_id AND f.code = ?
            WHERE rq.ref = ?`;
}

// Correlated COUNT subquery STRING for an outer control row aliased `i`, scoped to
// a workspace param. One bound param: the workspace id. (framework hardcoded by
// the caller via the returned string.)
function docCountSubquery(framework) {
  const fw = framework === 'iso42001' ? 'iso42001' : 'iso27001';
  return `(SELECT COUNT(*) FROM document_requirement_links drl
            JOIN requirements rq ON rq.id = drl.requirement_id
            JOIN frameworks f ON f.id = rq.framework_id AND f.code = '${fw}'
            JOIN generated_docs gd ON gd.id = drl.document_id
            WHERE rq.ref = i.id AND gd.workspace_id = ? AND gd.retired_at IS NULL)`;
}

// Parenthesized subquery EXPRESSION that reproduces the demolished
// v_document_controls / v_iso42001_document_controls view shape (columns:
// id, document_id, iso_item_id, section_ref, created_at) drl-native. Drops in
// where the view/table name used to go, e.g. `FROM ${docControlsExpr('iso27001')} dc`.
function docControlsExpr(framework) {
  const fw = framework === 'iso42001' ? 'iso42001' : 'iso27001';
  return `(SELECT drl.id AS id, drl.document_id AS document_id, rq.ref AS iso_item_id,
                  drl.section_ref AS section_ref, drl.created_at AS created_at
           FROM document_requirement_links drl
           JOIN requirements rq ON rq.id = drl.requirement_id
           JOIN frameworks f ON f.id = rq.framework_id AND f.code = '${fw}')`;
}

// ---- writes ----------------------------------------------------------------
function requirementId(db, framework, isoItemId) {
  const r = db.prepare(
    `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
     WHERE f.code = ? AND rq.ref = ? AND f.status='active'
     ORDER BY f.id DESC LIMIT 1`
  ).get(framework, isoItemId);
  return r ? r.id : null;
}

// Add a link (idempotent). Returns the run result (.changes). No-op if the
// iso_item_id has no requirement mapping (returns { changes: 0 }).
function addLink(db, framework, documentId, isoItemId, sectionRef) {
  const rid = requirementId(db, framework, isoItemId);
  if (!rid) return { changes: 0 };
  return db.prepare(
    `INSERT OR IGNORE INTO document_requirement_links (document_id, requirement_id, section_ref) VALUES (?, ?, ?)`
  ).run(documentId, rid, sectionRef == null ? null : sectionRef);
}

// Resolve a link by its drl.id, scoped to a document (doc-side unlink).
function resolveLinkByDoc(db, linkId, documentId) {
  return db.prepare(
    `SELECT drl.id, drl.document_id, rq.ref AS iso_item_id
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     WHERE drl.id = ? AND drl.document_id = ?`
  ).get(linkId, documentId);
}

// Resolve a link by drl.id, scoped to a control + workspace (control-side unlink).
function resolveLinkByControl(db, linkId, isoItemId, workspaceId) {
  return db.prepare(
    `SELECT drl.id, drl.document_id, rq.ref AS iso_item_id
     FROM document_requirement_links drl
     JOIN requirements rq ON rq.id = drl.requirement_id
     JOIN generated_docs d ON d.id = drl.document_id
     WHERE drl.id = ? AND rq.ref = ? AND d.workspace_id = ?`
  ).get(linkId, isoItemId, workspaceId);
}

function deleteLink(db, linkId) {
  return db.prepare(`DELETE FROM document_requirement_links WHERE id = ?`).run(linkId);
}

module.exports = {
  linkedDocsForControl, linkedControlsForDoc, linkedDocIdsSubquery, docCountSubquery,
  docControlsExpr, requirementId, addLink, resolveLinkByDoc, resolveLinkByControl, deleteLink,
};
