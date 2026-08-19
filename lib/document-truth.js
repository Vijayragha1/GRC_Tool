'use strict';

// Canonical document projection used by policy adoption, readiness and the
// client portal. A controlled document is the same record regardless of
// whether it originated from a system template, a client upload or a locally
// authored policy.

const CURRENT_STATUSES = new Set(['approved', 'published']);
const STOP_WORDS = new Set(['the','and','of','for','a','an','to','on','information','document','policy']);

function normalizeName(value) {
  return String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function meaningfulTokens(value) {
  return normalizeName(value).split(/\s+/).filter(token => token.length > 2 && !STOP_WORDS.has(token));
}

function semanticNameMatch(documentName, expectedName) {
  const actual = normalizeName(documentName);
  const expected = normalizeName(expectedName);
  if (!actual || !expected) return false;
  if (actual.includes(expected) || expected.includes(actual)) return true;
  const tokens = meaningfulTokens(expectedName);
  return tokens.length > 0 && tokens.every(token => actual.includes(token));
}

function workspaceDocuments(db, workspaceId) {
  return db.prepare(`SELECT d.*,t.name AS template_name,t.tier AS template_tier
    FROM generated_docs d LEFT JOIN doc_templates t ON t.id=d.template_id
    WHERE d.workspace_id=? AND d.retired_at IS NULL ORDER BY d.id DESC`).all(workspaceId);
}

function matchDocument(documents, requirement, options = {}) {
  const statuses = options.statuses || CURRENT_STATUSES;
  const names = [requirement.name, ...(requirement.aliases || [])].filter(Boolean);
  return documents.find(document => {
    const status = String(document.status || '').toLowerCase();
    if (statuses && !statuses.has(status)) return false;
    if (requirement.template_id && Number(document.template_id) === Number(requirement.template_id)) return true;
    return names.some(name => semanticNameMatch(document.name, name));
  }) || null;
}

function mandatoryTemplateAdoption(db, workspaceId, documentsInput) {
  const documents = documentsInput || workspaceDocuments(db, workspaceId);
  return db.prepare(`SELECT id AS template_id,name,tier FROM doc_templates
    WHERE tier='mandatory' AND is_system=1 ORDER BY name`).all().map(template => {
      const document = matchDocument(documents, template);
      return {
        template_id: template.template_id,
        template_name: template.name,
        adopted: !!document,
        status: document ? document.status : null,
        doc_id: document ? document.id : null,
        document_name: document ? document.name : null
      };
    });
}

function findControlledDocument(db, workspaceId, names, options = {}) {
  const documents = options.documents || workspaceDocuments(db, workspaceId);
  return matchDocument(documents, {
    name: Array.isArray(names) ? names[0] : names,
    aliases: Array.isArray(names) ? names.slice(1) : []
  }, options);
}

function documentRegisterTruth(db, workspaceId) {
  const documents = workspaceDocuments(db, workspaceId);
  const mandatory = mandatoryTemplateAdoption(db, workspaceId, documents);
  const current = documents.filter(document => CURRENT_STATUSES.has(String(document.status || '').toLowerCase()));
  return {
    documents,
    current,
    mandatory,
    mandatoryAdopted: mandatory.filter(item => item.adopted).length,
    mandatoryTotal: mandatory.length,
    mandatoryComplete: mandatory.length > 0 && mandatory.every(item => item.adopted)
  };
}

module.exports = {
  CURRENT_STATUSES, normalizeName, semanticNameMatch, workspaceDocuments,
  matchDocument, mandatoryTemplateAdoption, findControlledDocument, documentRegisterTruth
};
