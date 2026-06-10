// Full-text search index management using SQLite FTS5 (built-in, no external deps).

const { db } = require('./../db');
const enc = require('./encryption');

function indexEntity({ workspaceId, entityType, entityId, title, body }) {
  // Decrypt before indexing - search index is treated as derived data.
  const t = enc.decryptIfNeeded(title || '', workspaceId);
  const b = enc.decryptIfNeeded(body || '', workspaceId);
  // Replace existing rows for this entity
  db.prepare(`DELETE FROM search_index WHERE workspace_id=? AND entity_type=? AND entity_id=?`)
    .run(workspaceId, entityType, String(entityId));
  db.prepare(`INSERT INTO search_index (workspace_id, entity_type, entity_id, title, body) VALUES (?, ?, ?, ?, ?)`)
    .run(workspaceId, entityType, String(entityId), String(t || ''), String(b || ''));
}

function removeEntity({ workspaceId, entityType, entityId }) {
  db.prepare(`DELETE FROM search_index WHERE workspace_id=? AND entity_type=? AND entity_id=?`).run(workspaceId, entityType, String(entityId));
}

function search(workspaceId, query, limit = 50) {
  if (!query || !query.trim()) return [];
  // Keep the read path cheap. We do NOT rebuild on staleness here: the old
  // behaviour ran a full multi-table DELETE+re-INSERT for the whole workspace
  // inside the user's search request while holding the single SQLite writer -
  // a write storm that blocked every other writer on a mature workspace.
  // Drift is reconciled off the request path by rebuildStaleWorkspaces()
  // (called from the scheduled job runner) plus the per-write refresh() hook.
  // The only thing we still do lazily is a one-time build when the index is
  // completely empty for this workspace (bounded - happens at most once).
  try {
    const indexCount = db.prepare(`SELECT COUNT(*) AS n FROM search_index WHERE workspace_id=?`).get(workspaceId).n;
    if (indexCount === 0) rebuildAll(workspaceId);
  } catch (_) { /* ignore - rebuild errors shouldn't block search */ }
  // Build a tolerant FTS5 query: split on whitespace, strip non-word chars,
  // wrap each term as a quoted prefix so apostrophes/punctuation never blow up
  // the parser, and AND them together.
  const terms = String(query)
    .split(/\s+/)
    .map(t => t.replace(/["*()]/g, '').trim())
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"*`);
  if (!terms.length) return [];
  const matchExpr = terms.join(' AND ');
  try {
    return db.prepare(`SELECT entity_type, entity_id, title, snippet(search_index, 4, '<<', '>>', '…', 12) AS excerpt,
      bm25(search_index) AS score
      FROM search_index WHERE workspace_id=? AND search_index MATCH ?
      ORDER BY score LIMIT ?`).all(workspaceId, matchExpr, limit);
  } catch (e) {
    return [];
  }
}

// Per-entity write-through hook. Callers do INSERT/UPDATE on a source table
// then call refresh(wsId, type, id) to re-index that one row. Each branch
// reads the canonical fields from the source table - keeps the per-type
// schema knowledge in one file. Silently no-ops if the row doesn't exist
// any more (e.g., raced with a delete).
function refresh(workspaceId, entityType, entityId) {
  if (!workspaceId || !entityType || entityId == null) return;
  try {
    let row;
    switch (entityType) {
      case 'risk':
        row = db.prepare(`SELECT title, description FROM risks WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
        if (row) indexEntity({ workspaceId, entityType, entityId, title: row.title, body: row.description });
        break;
      case 'asset':
        row = db.prepare(`SELECT name, description FROM assets WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
        if (row) indexEntity({ workspaceId, entityType, entityId, title: row.name, body: row.description });
        break;
      case 'control':
        // entityId is the iso_item_id string (e.g., 'annex-a.5.1'). We need the
        // workspace's notes from control_states plus the title from iso_items.
        row = db.prepare(`SELECT i.title, cs.notes FROM iso_items i
          LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
          WHERE i.id=?`).get(workspaceId, entityId);
        if (row) indexEntity({ workspaceId, entityType, entityId, title: row.title, body: row.notes });
        break;
      case 'document':
        row = db.prepare(`SELECT name, content FROM generated_docs WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
        if (row) indexEntity({ workspaceId, entityType, entityId, title: row.name, body: row.content });
        break;
      case 'supplier':
        row = db.prepare(`SELECT name, service_provided, notes FROM suppliers WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
        if (row) indexEntity({ workspaceId, entityType, entityId, title: row.name,
          body: (row.service_provided || '') + '\n' + (row.notes || '') });
        break;
      case 'nc':
        row = db.prepare(`SELECT title, description FROM nonconformities WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
        if (row) indexEntity({ workspaceId, entityType, entityId, title: row.title, body: row.description });
        break;
      case 'incident':
        row = db.prepare(`SELECT title, description FROM incidents WHERE id=? AND workspace_id=?`).get(entityId, workspaceId);
        if (row) indexEntity({ workspaceId, entityType, entityId, title: row.title, body: row.description });
        break;
    }
  } catch (e) {
    // Never let an indexing failure crash the write that's calling us.
    if (process.env.DEBUG_FTS === '1') console.warn('[fts] refresh failed:', e.message);
  }
}

function rebuildAll(workspaceId) {
  let n = 0;
  // Clear
  db.prepare(`DELETE FROM search_index WHERE workspace_id=?`).run(workspaceId);
  // Risks
  for (const r of db.prepare(`SELECT id, title, description FROM risks WHERE workspace_id=?`).all(workspaceId)) {
    indexEntity({ workspaceId, entityType: 'risk', entityId: r.id, title: r.title, body: r.description });
    n++;
  }
  // Assets
  for (const a of db.prepare(`SELECT id, name, description FROM assets WHERE workspace_id=?`).all(workspaceId)) {
    indexEntity({ workspaceId, entityType: 'asset', entityId: a.id, title: a.name, body: a.description });
    n++;
  }
  // Controls (per workspace state)
  for (const c of db.prepare(`SELECT cs.iso_item_id, i.title, cs.notes FROM control_states cs INNER JOIN iso_items i ON i.id=cs.iso_item_id WHERE cs.workspace_id=?`).all(workspaceId)) {
    indexEntity({ workspaceId, entityType: 'control', entityId: c.iso_item_id, title: c.title, body: c.notes });
    n++;
  }
  // Documents
  for (const d of db.prepare(`SELECT id, name, content FROM generated_docs WHERE workspace_id=?`).all(workspaceId)) {
    indexEntity({ workspaceId, entityType: 'document', entityId: d.id, title: d.name, body: d.content });
    n++;
  }
  // Suppliers
  for (const s of db.prepare(`SELECT id, name, service_provided, notes FROM suppliers WHERE workspace_id=?`).all(workspaceId)) {
    indexEntity({ workspaceId, entityType: 'supplier', entityId: s.id, title: s.name, body: (s.service_provided || '') + '\n' + (s.notes || '') });
    n++;
  }
  // NCs
  for (const nc of db.prepare(`SELECT id, title, description FROM nonconformities WHERE workspace_id=?`).all(workspaceId)) {
    indexEntity({ workspaceId, entityType: 'nc', entityId: nc.id, title: nc.title, body: nc.description });
    n++;
  }
  // Incidents
  for (const i of db.prepare(`SELECT id, title, description FROM incidents WHERE workspace_id=?`).all(workspaceId)) {
    indexEntity({ workspaceId, entityType: 'incident', entityId: i.id, title: i.title, body: i.description });
    n++;
  }
  return n;
}

// Reconcile index drift off the request path. For each workspace, compare the
// index row count to the source-table row count and rebuild only those that
// drifted. Called from the scheduled job runner (and once at boot) so a stale
// index never forces a synchronous rebuild during a user's search.
function rebuildStaleWorkspaces() {
  let rebuilt = 0;
  let workspaces;
  try {
    workspaces = db.prepare(`SELECT id FROM workspaces`).all();
  } catch (_) { return 0; }
  for (const { id: workspaceId } of workspaces) {
    try {
      const indexCount = db.prepare(`SELECT COUNT(*) AS n FROM search_index WHERE workspace_id=?`).get(workspaceId).n;
      const src = db.prepare(`SELECT
        (SELECT COUNT(*) FROM risks WHERE workspace_id=?)
        + (SELECT COUNT(*) FROM assets WHERE workspace_id=?)
        + (SELECT COUNT(*) FROM control_states WHERE workspace_id=?)
        + (SELECT COUNT(*) FROM generated_docs WHERE workspace_id=?)
        + (SELECT COUNT(*) FROM suppliers WHERE workspace_id=?)
        + (SELECT COUNT(*) FROM nonconformities WHERE workspace_id=?)
        + (SELECT COUNT(*) FROM incidents WHERE workspace_id=?) AS n`)
        .get(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId).n;
      if (indexCount !== src) { rebuildAll(workspaceId); rebuilt++; }
    } catch (_) { /* per-workspace failure shouldn't stop the sweep */ }
  }
  return rebuilt;
}

module.exports = { indexEntity, removeEntity, refresh, search, rebuildAll, rebuildStaleWorkspaces };
