'use strict';
// ISO/IEC 42001:2023 template pack: seeding, metadata and lookup.
//
// The ISO 27001 system templates carry their control mapping inside the
// description text ("(A.5.15)") and get their tier from name patterns. Neither
// works for ISO 42001: its Annex A uses the same "A.x.y" form with different
// meanings, so the ISO 27001 parser would link an AI policy to an unrelated
// access-control requirement. Pack templates therefore state their framework,
// tier and requirement ids explicitly, and applyTemplatePack() runs after the
// ISO 27001 tagging on every boot so its values are the ones that stick.

const PACK = require('../data/policy-templates-iso42001');

const FRAMEWORK = 'iso42001';
const TIER_RANK = { mandatory: 0, expected: 1, recommended: 2 };

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function ensureColumns(db) {
  if (!hasColumn(db, 'doc_templates', 'framework')) db.exec(`ALTER TABLE doc_templates ADD COLUMN framework TEXT DEFAULT 'iso27001'`);
  if (!hasColumn(db, 'doc_templates', 'requirement_refs')) db.exec('ALTER TABLE doc_templates ADD COLUMN requirement_refs TEXT');
  for (const col of ['tier', 'controls', 'clauses']) {
    if (!hasColumn(db, 'doc_templates', col)) db.exec(`ALTER TABLE doc_templates ADD COLUMN ${col} TEXT`);
  }
}

// Inserts any pack template that is missing and refreshes the metadata and
// body of the ones already present. System templates are masters: a document
// adopted from one is a copy, so updating the master never touches a client's
// document.
function applyTemplatePack(db) {
  ensureColumns(db);
  const find = db.prepare('SELECT id FROM doc_templates WHERE name=? AND is_system=1');
  const insert = db.prepare(`INSERT INTO doc_templates (firm_id, name, category, description, content, is_system, framework, requirement_refs, tier, controls, clauses)
    VALUES (NULL, ?, ?, ?, ?, 1, ?, ?, ?, '[]', '[]')`);
  const update = db.prepare(`UPDATE doc_templates SET category=?, description=?, content=?, framework=?, requirement_refs=?, tier=?,
    controls='[]', clauses='[]' WHERE id=?`);
  let added = 0;
  db.transaction(() => {
    for (const t of PACK) {
      const refs = JSON.stringify(t.requirement_refs);
      const row = find.get(t.name);
      if (row) update.run(t.category, t.description, t.content, FRAMEWORK, refs, t.tier, row.id);
      else { insert.run(t.name, t.category, t.description, t.content, FRAMEWORK, refs, t.tier); added++; }
    }
  })();
  return { added, total: PACK.length };
}

function frameworkOf(template) {
  return (template && template.framework) || 'iso27001';
}

function refsOf(template) {
  try { return JSON.parse(template.requirement_refs || '[]'); } catch (_) { return []; }
}

function code(itemId) {
  const id = String(itemId || '');
  if (id.startsWith('ai-annex-')) return id.replace('ai-annex-', '').toUpperCase().replace(/-/g, '.');
  return id.replace('ai-clause-', '');
}

// Pack templates mapped to any of the given requirements, most important
// first, with the workspace's adopted copy (if any) so a caller can offer
// "link the existing document" instead of a second draft.
function templatesForItems(db, workspaceId, itemIds) {
  const wanted = new Set(itemIds || []);
  if (!wanted.size) return [];
  const adopted = new Map(db.prepare(`SELECT template_id, MAX(id) AS doc_id FROM generated_docs
    WHERE workspace_id=? AND template_id IS NOT NULL AND status NOT IN ('withdrawn','retired') GROUP BY template_id`)
    .all(workspaceId).map(r => [r.template_id, r.doc_id]));
  return db.prepare(`SELECT id, name, category, description, tier, requirement_refs FROM doc_templates
      WHERE is_system=1 AND framework=?`).all(FRAMEWORK)
    .map(t => ({ ...t, refs: refsOf(t) }))
    .map(t => ({ ...t, matched: t.refs.filter(r => wanted.has(r)) }))
    .filter(t => t.matched.length)
    .map(t => ({ ...t, codes: t.refs.map(code), adoptedDocId: adopted.get(t.id) || null }))
    .sort((a, b) => b.matched.length - a.matched.length
      || (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3) || a.name.localeCompare(b.name));
}

// How far the client's AIMS documentation has got against the pack: for each
// tier, how many templates have a live document (any status short of
// withdrawn or retired) and how many of those are approved or published.
function documentationStatus(db, workspaceId) {
  const docs = new Map(db.prepare(`SELECT template_id, MAX(id) AS doc_id,
      MAX(CASE WHEN status IN ('approved','published') THEN 1 ELSE 0 END) AS approved
    FROM generated_docs WHERE workspace_id=? AND template_id IS NOT NULL AND status NOT IN ('withdrawn','retired')
    GROUP BY template_id`).all(workspaceId).map(r => [r.template_id, r]));
  const templates = db.prepare(`SELECT id, name, tier, category FROM doc_templates WHERE is_system=1 AND framework=? ORDER BY name`).all(FRAMEWORK)
    .map(t => ({ ...t, doc: docs.get(t.id) || null }));
  const tally = tier => {
    const rows = templates.filter(t => t.tier === tier);
    return { total: rows.length, drafted: rows.filter(t => t.doc).length, approved: rows.filter(t => t.doc && t.doc.approved).length };
  };
  return {
    mandatory: tally('mandatory'),
    expected: tally('expected'),
    missingMandatory: templates.filter(t => t.tier === 'mandatory' && !t.doc),
    awaitingApproval: templates.filter(t => t.tier === 'mandatory' && t.doc && !t.doc.approved),
  };
}

module.exports = { FRAMEWORK, PACK, applyTemplatePack, templatesForItems, documentationStatus, frameworkOf, refsOf, code };
