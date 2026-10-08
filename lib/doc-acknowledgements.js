'use strict';
// Policy acknowledgements (clause 7.3 awareness): the people a published
// document applies to confirm they have read it.
//
// A campaign is raised for one published version of a document. Each
// recipient gets a link of their own; opening it shows that version and a
// single confirmation. The link is a credential, so only its SHA-256 is
// stored (in doc_ack_recipients.token) and the raw link is shown once, when it
// is issued; a lost link is reissued, which retires the old one. The record of
// who acknowledged which version, and when, is the awareness evidence an
// auditor samples.

const crypto = require('crypto');

class AckError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const hash = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const clean = (v, max = 300) => (v == null ? null : (String(v).trim().slice(0, max) || null));

// One recipient per line: "Name <email>", "Name, email", or just a name.
function parseRecipients(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    let m = /^(.*?)\s*<\s*([^>\s]+@[^>\s]+)\s*>\s*$/.exec(l);
    if (!m) m = /^(.*?)\s*[,;]\s*([^,\s]+@[^,\s]+)\s*$/.exec(l);
    if (m) out.push({ name: clean(m[1]) || m[2], email: m[2].toLowerCase() });
    else if (/^[^\s@]+@[^\s@]+$/.test(l)) out.push({ name: l, email: l.toLowerCase() });
    else out.push({ name: clean(l), email: null });
  }
  const seen = new Set();
  return out.filter((r) => { const k = (r.email || r.name).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 500);
}

function publishedVersion(db, workspace, documentId) {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(documentId, workspace.id);
  if (!doc) throw new AckError('Document not found.', 404);
  const version = db.prepare(`SELECT * FROM doc_versions WHERE document_id=? AND workspace_id=? AND status='published'
    ORDER BY version DESC LIMIT 1`).get(doc.id, workspace.id);
  if (!version) throw new AckError('Publish the document before asking people to acknowledge it.', 409);
  return { doc, version };
}

// Raise a campaign. Returns its id and each recipient's one-time link token.
function create(db, workspace, actorId, documentId, input) {
  const { doc, version } = publishedVersion(db, workspace, documentId);
  const recipients = Array.isArray(input.recipients) ? input.recipients : parseRecipients(input.recipients);
  if (!recipients.length) throw new AckError('Add at least one person, one per line.');
  const due = clean(input.due_date, 10);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new AckError('The due date must be a date (YYYY-MM-DD).');
  const links = [];
  const id = db.transaction(() => {
    const campaignId = Number(db.prepare(`INSERT INTO doc_ack_campaigns (workspace_id, document_id, version_id, name, description, due_date, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(workspace.id, doc.id, version.id,
      clean(input.name, 200) || `${doc.name} v${version.version} acknowledgement`, clean(input.description, 2000), due, actorId).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO doc_ack_recipients (campaign_id, recipient_name, recipient_email, recipient_role, token) VALUES (?, ?, ?, ?, ?)`);
    for (const r of recipients) {
      const token = newToken();
      const rid = Number(ins.run(campaignId, r.name, r.email || null, clean(r.role, 120), hash(token)).lastInsertRowid);
      links.push({ recipientId: rid, name: r.name, email: r.email || null, token });
    }
    return campaignId;
  })();
  return { id, links };
}

function campaigns(db, workspace, documentId) {
  const rows = db.prepare(`SELECT c.*, v.version AS version_number, u.name AS created_by_name FROM doc_ack_campaigns c
    JOIN doc_versions v ON v.id = c.version_id LEFT JOIN users u ON u.id = c.created_by
    WHERE c.workspace_id=? AND c.document_id=? ORDER BY c.created_at DESC, c.id DESC`).all(workspace.id, documentId);
  const rec = db.prepare(`SELECT id, recipient_name, recipient_email, recipient_role, acknowledged_at FROM doc_ack_recipients
    WHERE campaign_id=? ORDER BY acknowledged_at IS NULL DESC, recipient_name`);
  return rows.map((c) => {
    const recipients = rec.all(c.id);
    return { ...c, recipients, acknowledged: recipients.filter((r) => r.acknowledged_at).length };
  });
}

function reissue(db, workspace, recipientId) {
  const r = db.prepare(`SELECT r.*, c.status FROM doc_ack_recipients r JOIN doc_ack_campaigns c ON c.id = r.campaign_id
    WHERE r.id=? AND c.workspace_id=?`).get(recipientId, workspace.id);
  if (!r) throw new AckError('That person is not on this campaign.', 404);
  if (r.acknowledged_at) throw new AckError('This person has already acknowledged the document.', 409);
  if (r.status !== 'active') throw new AckError('This campaign is closed.', 409);
  const token = newToken();
  db.prepare(`UPDATE doc_ack_recipients SET token=?, reminded_count=reminded_count+1, last_reminded_at=datetime('now') WHERE id=?`).run(hash(token), r.id);
  return { name: r.recipient_name, email: r.recipient_email, token, campaignId: r.campaign_id };
}

function close(db, workspace, campaignId) {
  db.prepare(`UPDATE doc_ack_campaigns SET status='closed', closed_at=datetime('now') WHERE id=? AND workspace_id=? AND status='active'`).run(campaignId, workspace.id);
}

// What a recipient's link opens: the campaign, the version to read, and
// whether it is still open.
function byToken(db, raw) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return null;
  const r = db.prepare(`SELECT r.*, c.status AS campaign_status, c.due_date, c.name AS campaign_name, c.workspace_id, c.document_id, c.version_id
    FROM doc_ack_recipients r JOIN doc_ack_campaigns c ON c.id = r.campaign_id WHERE r.token=?`).get(hash(raw));
  if (!r) return null;
  const version = db.prepare('SELECT id, version, name, content FROM doc_versions WHERE id=? AND workspace_id=?').get(r.version_id, r.workspace_id);
  const ws = db.prepare('SELECT id, client_name, brand_display_name FROM workspaces WHERE id=?').get(r.workspace_id);
  return { recipient: r, version, workspace: ws };
}

function acknowledge(db, raw, { ip, userAgent } = {}) {
  const found = byToken(db, raw);
  if (!found) throw new AckError('This link is not valid.', 404);
  if (found.recipient.acknowledged_at) return found;
  if (found.recipient.campaign_status !== 'active') throw new AckError('This acknowledgement has been closed.', 410);
  db.prepare(`UPDATE doc_ack_recipients SET acknowledged_at=datetime('now'), ip_address=?, user_agent=? WHERE id=? AND acknowledged_at IS NULL`)
    .run(clean(ip, 64), clean(userAgent, 300), found.recipient.id);
  return byToken(db, raw);
}

module.exports = { AckError, parseRecipients, create, campaigns, reissue, close, byToken, acknowledge };
