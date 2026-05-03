// API token issuance + verification. Tokens are stored as SHA-256 hashes;
// the plaintext is shown ONCE at creation time and never recoverable.
//
// Format: `isms_<prefix:8>_<random:32>`. The prefix is searchable but the
// secret part is hashed. Scopes restrict actions ("read:risks", "write:tasks", "*").

const crypto = require('crypto');
const { db, logAction } = require('../db');
const rbac = require('./rbac');

function generate({ workspaceId, userId, name, scopes, expiresAt, ipLock }) {
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const plaintext = `isms_${prefix}_${secret}`;
  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const id = db.prepare(`INSERT INTO api_tokens (workspace_id, user_id, name, token_hash, prefix, scopes, expires_at, ip_lock)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    workspaceId || null, userId, name,
    tokenHash, prefix, JSON.stringify(scopes || ['*']),
    expiresAt || null, ipLock || null).lastInsertRowid;
  return { id, prefix, plaintext };
}

function verify(plaintext, ip) {
  if (!plaintext || typeof plaintext !== 'string' || !plaintext.startsWith('isms_')) return null;
  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const row = db.prepare(`SELECT * FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL`).get(tokenHash);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  if (row.ip_lock && ip && row.ip_lock !== ip) return null;
  // Update last_used_at (best-effort)
  try { db.prepare('UPDATE api_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id); } catch (_) {}
  return { ...row, scopes: JSON.parse(row.scopes || '["*"]') };
}

function hasScope(token, want) {
  if (!token) return false;
  if (token.scopes.includes('*')) return true;
  return token.scopes.includes(want);
}

// Express middleware: looks for `Authorization: Bearer <token>` and attaches
// req.apiToken / req.user / req.workspace if valid.
function requireApiToken(scope) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(\S+)/);
    if (!m) return res.status(401).json({ error: 'missing_authorization' });
    const ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '').toString().split(',')[0].trim();
    const token = verify(m[1], ip);
    if (!token) return res.status(401).json({ error: 'invalid_token' });
    if (scope && !hasScope(token, scope)) return res.status(403).json({ error: 'insufficient_scope', required: scope });
    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(token.user_id);
    if (!user) return res.status(401).json({ error: 'user_inactive' });
    req.apiToken = token;
    req.user = user;
    if (token.workspace_id) {
      req.workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(token.workspace_id);
    }
    logAction(user.id, token.workspace_id, 'api_call', 'api_token', token.id,
      { route: req.method + ' ' + req.path, scope }, { ip, userAgent: req.headers['user-agent'], requestId: req.id });
    next();
  };
}

module.exports = { generate, verify, hasScope, requireApiToken };
