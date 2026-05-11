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
  // Lazy auto-rebuild: if the index is empty for this workspace, populate it.
  // (indexEntity hooks are not wired on every entity write, so the index can
  // legitimately be empty on first use even though entities exist.)
  const have = db.prepare(`SELECT COUNT(*) AS n FROM search_index WHERE workspace_id=?`).get(workspaceId);
  if (!have || have.n === 0) {
    try { rebuildAll(workspaceId); } catch (e) { /* ignore */ }
  }
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

module.exports = { indexEntity, removeEntity, search, rebuildAll };
