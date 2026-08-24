// Document approval helpers - shared between submit-review, decide,
// /approve/:token, and the resend/revoke routes.
//
// The two approver tables (doc_approvers for internal users,
// external_approvers for magic-link recipients) get merged into a
// single ordered chain for the view layer; this module owns the
// canonical "what does the chain look like" logic so each caller
// doesn't reinvent it.

const crypto = require('crypto');

const TOKEN_EXPIRY_DAYS = 7;
const MAX_DECISION_REASON = 4000;

function validateDecision(decision, reason) {
  if (!['approve', 'reject'].includes(decision)) {
    return { ok: false, error: 'Choose approve or reject.', reason: '' };
  }
  const cleanReason = String(reason == null ? '' : reason).trim();
  if (cleanReason.length > MAX_DECISION_REASON) {
    return { ok: false, error: `Reason must be ${MAX_DECISION_REASON} characters or fewer.`, reason: cleanReason };
  }
  if (decision === 'reject' && !cleanReason) {
    return { ok: false, error: 'Explain why the document is being rejected so the author can correct it.', reason: '' };
  }
  return { ok: true, error: null, reason: cleanReason || null };
}

// 32 random bytes = 64 hex chars. URL-safe by virtue of being hex.
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function expiryFromNow(days = TOKEN_EXPIRY_DAYS) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Returns the merged approver chain for a version, ordered by sequence.
// Each row has a `kind` field ('internal'|'external') so the view layer
// can render differently. Decision-status normalised to the same shape
// for both ('approved'|'rejected'|null).
function listChain(db, versionId) {
  const internal = db.prepare(`
    SELECT a.id, a.sequence, a.role_label, a.decision, a.decision_reason,
           a.decided_at, a.notified_at, u.id AS user_id, u.name AS person_name,
           u.email AS person_email
    FROM doc_approvers a INNER JOIN users u ON u.id = a.user_id
    WHERE a.version_id = ?`).all(versionId);
  const external = db.prepare(`
    SELECT id, sequence, role_label, decision, decision_reason,
           decided_at, notified_at, expires_at, revoked_at, email AS person_email,
           name AS person_name
    FROM external_approvers WHERE version_id = ?`).all(versionId);

  const rows = [
    ...internal.map(r => ({ ...r, kind: 'internal' })),
    ...external.map(r => ({ ...r, kind: 'external' }))
  ];
  rows.sort((a, b) => a.sequence - b.sequence);
  return rows;
}

// Effective status for an external row: revoked overrides any other
// state; expired-without-decision flags as 'expired' so the UI can
// show why the link no longer works.
function externalEffectiveStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.decision) return row.decision;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  return 'pending';
}

// How many approvers across both tables are still waiting on a
// decision? Used by the "all approved?" check on every decision.
// Revoked + expired don't count as pending (treated as terminal -
// the firm needs to revoke/replace them or extend explicitly).
function countPending(db, versionId) {
  const internal = db.prepare(
    `SELECT COUNT(*) c FROM doc_approvers WHERE version_id=? AND decision IS NULL`
  ).get(versionId).c;
  const external = db.prepare(
    `SELECT * FROM external_approvers WHERE version_id=? AND decision IS NULL AND revoked_at IS NULL`
  ).all(versionId);
  const externalActivePending = external.filter(r => externalEffectiveStatus(r) === 'pending').length;
  return internal + externalActivePending;
}

// The next approver in sequence who can act (any kind, lowest pending
// sequence number). Returns { kind, row } or null if chain is complete.
function nextPending(db, versionId) {
  const chain = listChain(db, versionId);
  for (const row of chain) {
    if (row.kind === 'internal') {
      if (!row.decision) return { kind: 'internal', row };
    } else {
      const status = externalEffectiveStatus(row);
      if (status === 'pending') return { kind: 'external', row };
    }
  }
  return null;
}

// Find an external approver by raw token (lookup uses the hash so the
// raw token never round-trips through the DB). Returns the joined row
// with doc + version + workspace context, or null on miss / expired /
// revoked / already decided.
function findByToken(db, token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const hash = hashToken(token);
  const row = db.prepare(`
    SELECT ea.*,
           d.id AS doc_id, d.name AS doc_name, d.status AS doc_status,
           dv.version, dv.content, dv.content_hash, dv.created_at AS version_created_at,
           dv.change_summary,
           w.id AS workspace_id, w.client_name AS workspace_name,
           w.brand_primary_color, w.firm_id,
           subm.name AS submitter_name
    FROM external_approvers ea
    INNER JOIN generated_docs d ON d.id = ea.document_id
    INNER JOIN doc_versions dv ON dv.id = ea.version_id
    INNER JOIN workspaces w ON w.id = ea.workspace_id
    LEFT JOIN users subm ON subm.id = dv.created_by
    WHERE ea.token_hash = ? LIMIT 1`).get(hash);
  if (!row) return null;
  row.effective_status = externalEffectiveStatus(row);
  return row;
}

// Is this row the one whose turn it is? Mixed-chain rule: the row's
// sequence must equal the minimum sequence of any not-yet-decided row
// across BOTH tables (excluding revoked/expired externals).
function isExternalRowMyTurn(db, externalRow) {
  const internalSeqs = db.prepare(
    `SELECT MIN(sequence) AS s FROM doc_approvers WHERE version_id=? AND decision IS NULL`
  ).get(externalRow.version_id).s;
  const externalRows = db.prepare(
    `SELECT * FROM external_approvers WHERE version_id=? AND decision IS NULL AND revoked_at IS NULL`
  ).all(externalRow.version_id);
  const externalActiveSeqs = externalRows
    .filter(r => externalEffectiveStatus(r) === 'pending')
    .map(r => r.sequence);
  const candidates = [];
  if (internalSeqs != null) candidates.push(internalSeqs);
  candidates.push(...externalActiveSeqs);
  if (!candidates.length) return false;
  const next = Math.min(...candidates);
  return externalRow.sequence === next;
}

module.exports = {
  TOKEN_EXPIRY_DAYS,
  MAX_DECISION_REASON,
  validateDecision,
  generateToken,
  hashToken,
  expiryFromNow,
  listChain,
  externalEffectiveStatus,
  countPending,
  nextPending,
  findByToken,
  isExternalRowMyTurn
};
