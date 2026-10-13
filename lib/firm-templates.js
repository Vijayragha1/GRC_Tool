'use strict';
// The firm's own templates: a document written for one client, saved so the
// next client starts from it. A firm template sits beside the system templates
// in the template library of every client of the firm (doc_templates with the
// firm's id), under the framework its source document serves.
//
// The document belongs to one client, so saving it takes the client out: the
// client's name goes back to {{client_name}} and the values set for that
// client (lib/template-values.js) go back to their placeholders. Anything else
// specific to the client has to be removed by the consultant; the save form
// says so.

const enc = require('./encryption');
const templateValues = require('./template-values');
const reqOpts = require('./requirement-options');

class FirmTemplateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace the client's own words with placeholders.
function deidentify(db, workspace, content) {
  let out = String(content || '');
  const names = [workspace.brand_display_name, workspace.client_name].filter((n) => n && n.trim().length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of names) out = out.replace(new RegExp(escapeRe(name.trim()), 'g'), '{{client_name}}');
  for (const f of templateValues.values(db, workspace)) {
    if (f.saved && f.saved.length >= 3) out = out.replace(new RegExp(escapeRe(f.saved), 'g'), f.tokens[0]);
  }
  return out;
}

// What the source document serves: its own template's framework and
// requirements, else the requirements the document is linked to, else the
// standard the client works to.
function mappingFor(db, workspace, doc) {
  const source = doc.template_id ? db.prepare('SELECT framework, requirement_refs, tier, controls, clauses FROM doc_templates WHERE id=?').get(doc.template_id) : null;
  const links = db.prepare(`SELECT rq.ref, f.code FROM document_requirement_links drl JOIN requirements rq ON rq.id = drl.requirement_id
    JOIN frameworks f ON f.id = rq.framework_id WHERE drl.document_id=? AND f.code IN ('iso27001','iso42001')`).all(doc.id);
  const codes = reqOpts.enabledCodes(workspace);
  const fallback = codes.includes('iso42001') && !codes.includes('iso27001') ? 'iso42001' : 'iso27001';
  const linked = [...new Set(links.map((l) => l.code))];
  const framework = (source && source.framework) || (linked.length === 1 ? linked[0] : fallback);
  const refs = links.filter((l) => l.code === framework).map((l) => l.ref);
  if (framework === 'iso42001') {
    return { framework, requirement_refs: source && source.requirement_refs ? source.requirement_refs : JSON.stringify(refs), controls: '[]', clauses: '[]', tier: (source && source.tier) || 'recommended' };
  }
  return {
    framework,
    requirement_refs: null,
    controls: source && source.controls ? source.controls : JSON.stringify(refs.filter((r) => r.startsWith('annex-a.'))),
    clauses: source && source.clauses ? source.clauses : JSON.stringify(refs.filter((r) => r.startsWith('clause-'))),
    tier: (source && source.tier) || 'recommended',
  };
}

function saveFromDocument(db, workspace, docId, input) {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(docId, workspace.id);
  if (!doc) throw new FirmTemplateError('Document not found.', 404);
  const name = clean(input.name, 160) || doc.name;
  if (db.prepare('SELECT 1 FROM doc_templates WHERE firm_id=? AND is_system=0 AND name=?').get(workspace.firm_id, name)) {
    throw new FirmTemplateError('The firm already has a template with that name. Choose another name.', 409);
  }
  const content = deidentify(db, workspace, enc.decryptIfNeeded(doc.content || '', workspace.id));
  if (!content.trim()) throw new FirmTemplateError('The document is empty.');
  const m = mappingFor(db, workspace, doc);
  const id = Number(db.prepare(`INSERT INTO doc_templates (firm_id, name, category, description, content, is_system, framework, requirement_refs, tier, controls, clauses)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(workspace.firm_id, name, doc.category || 'policy',
    clean(input.description, 500) || `Firm template, first written as ${doc.name}.`, content, m.framework, m.requirement_refs, m.tier, m.controls, m.clauses).lastInsertRowid);
  return { id, name, framework: m.framework, clientNameLeft: content.includes(workspace.client_name) };
}

function list(db, firmId) {
  return db.prepare(`SELECT t.id, t.name, t.category, t.framework, t.tier, t.created_at,
      (SELECT COUNT(*) FROM generated_docs d WHERE d.template_id = t.id) AS used
    FROM doc_templates t WHERE t.firm_id=? AND t.is_system=0 ORDER BY t.framework, t.name`).all(firmId);
}

function remove(db, firmId, templateId) {
  const t = db.prepare('SELECT id, name FROM doc_templates WHERE id=? AND firm_id=? AND is_system=0').get(templateId, firmId);
  if (!t) throw new FirmTemplateError('That firm template was not found.', 404);
  // Documents adopted from it are copies and stay as they are; only their
  // pointer back to the template goes.
  db.transaction(() => {
    db.prepare('UPDATE generated_docs SET template_id=NULL WHERE template_id=?').run(t.id);
    db.prepare('DELETE FROM doc_templates WHERE id=?').run(t.id);
  })();
  return t;
}

module.exports = { FirmTemplateError, saveFromDocument, list, remove, deidentify };
