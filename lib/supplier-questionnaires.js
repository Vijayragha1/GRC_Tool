// Shared supplier-questionnaire issuance: create a row, mint a fresh external token,
// and send the invite email. Used by the bulk-send route and the recurring
// re-attestation job so neither needs Express. Every call creates a NEW questionnaire
// row with a FRESH token; a prior completed row is never reused (the public /q/:token
// view treats a row with external_completed_at set as already done).

'use strict';
const crypto = require('crypto');
const { db } = require('../db');
const email = require('./email');

const TOKEN_TTL_DAYS = 30;

// Resolve the best recipient email for a supplier: a contact matching the preferred
// role, then the primary contact, then any contact with an email, then the legacy
// suppliers.contact field. Returns null when nothing usable is on file.
function pickRecipientEmail(supplierId, preferredRole) {
  const contacts = db.prepare(`SELECT email, role, is_primary FROM supplier_contacts WHERE supplier_id=? AND email IS NOT NULL AND email <> ''`).all(supplierId);
  if (preferredRole) { const m = contacts.find(c => c.role === preferredRole); if (m) return m.email; }
  const prim = contacts.find(c => c.is_primary); if (prim) return prim.email;
  if (contacts[0]) return contacts[0].email;
  const s = db.prepare('SELECT contact FROM suppliers WHERE id=?').get(supplierId);
  return (s && s.contact) ? s.contact : null;
}

// Create + token-mint + (optionally) email one questionnaire. Returns
// { questionnaireId, token, emailedTo } or null if the template/supplier is invalid.
function issueQuestionnaire({ workspaceId, supplierId, templateId, toEmail, contactRole, brandName, firmId }) {
  const tpl = db.prepare(`SELECT * FROM questionnaire_templates WHERE id=? AND (is_system=1 OR firm_id=?)`).get(templateId, firmId);
  if (!tpl) return null;
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id=? AND workspace_id=?').get(supplierId, workspaceId);
  if (!supplier) return null;
  const qCount = db.prepare(`SELECT COUNT(*) c FROM questionnaire_questions WHERE template_id=?`).get(templateId).c;
  const token = crypto.randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString();
  const recipient = (toEmail && toEmail.trim()) || pickRecipientEmail(supplierId, contactRole);
  const qid = db.prepare(`INSERT INTO supplier_questionnaires
      (workspace_id, supplier_id, template_id, template_name, status, sent_at, total_questions, external_token, external_email, external_expires_at)
      VALUES (?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP, ?, ?, ?, ?)`)
    .run(workspaceId, supplierId, templateId, tpl.name, qCount, token, recipient || null, expiresAt).lastInsertRowid;
  if (recipient) {
    email.sendSupplierQuestionnaireEmail({
      toEmail: recipient,
      supplierName: supplier.name,
      templateName: tpl.name,
      templateDescription: tpl.description || null,
      questionCount: qCount,
      workspaceName: brandName || null,
      workspaceId, firmId,
      token, expiresAt,
      questionnaireId: qid
    }).catch(err => console.error('[supplier-questionnaire email] send failed:', err && err.message));
  }
  return { questionnaireId: qid, token, emailedTo: recipient || null };
}

module.exports = { issueQuestionnaire, pickRecipientEmail, TOKEN_TTL_DAYS };
