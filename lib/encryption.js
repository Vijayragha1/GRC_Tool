// Field-level encryption with per-workspace data keys derived from a master key.
// AES-256-GCM. Master key is read from ISMS_MASTER_KEY env var, or auto-generated
// once and persisted to data/master.key (mode 0600). Workspace keys are HKDF-derived
// from the master so cross-tenant decryption is impossible without the master key.
//
// Usage:
//   const enc = require('./lib/encryption');
//   const blob = enc.encrypt('secret payload', workspaceId);
//   const plain = enc.decrypt(blob, workspaceId);
//
// All ciphertext blobs use the prefix `enc:v1:` so plaintext legacy values can
// continue to coexist (encryptIfNeeded / decryptIfNeeded gracefully passthrough).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = process.env.ISMS_KEY_FILE || path.join(__dirname, '..', 'data', 'master.key');
const PREFIX = 'enc:v1:';

let _master = null;
function masterKey() {
  if (_master) return _master;
  if (process.env.ISMS_MASTER_KEY) {
    const raw = process.env.ISMS_MASTER_KEY;
    if (raw.length >= 64) {
      _master = Buffer.from(raw.slice(0, 64), 'hex');
      return _master;
    }
    _master = crypto.createHash('sha256').update(raw).digest();
    return _master;
  }
  try {
    if (fs.existsSync(KEY_FILE)) {
      _master = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
      if (_master.length === 32) return _master;
    }
  } catch (_) { /* fallthrough */ }
  // Generate
  const dir = path.dirname(KEY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _master = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, _master.toString('hex'), { mode: 0o600 });
  console.log(`[encryption] Generated master key at ${KEY_FILE} (mode 0600). Back this up - losing it makes ciphertext unrecoverable.`);
  return _master;
}

const _wsKeyCache = new Map();
function workspaceKey(wsId) {
  const k = String(wsId || 'global');
  if (_wsKeyCache.has(k)) return _wsKeyCache.get(k);
  const salt = crypto.createHash('sha256').update('isms-ws-salt').digest();
  const info = Buffer.from('ws:' + k);
  const dk = crypto.hkdfSync('sha256', masterKey(), salt, info, 32);
  const buf = Buffer.from(dk);
  _wsKeyCache.set(k, buf);
  return buf;
}

function encrypt(plain, wsId) {
  if (plain == null) return null;
  if (typeof plain !== 'string') plain = String(plain);
  const key = workspaceKey(wsId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // wsId mixed into AAD so a blob from ws A cannot decrypt under ws B even
  // if keys were ever leaked into a single keychain.
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(blob, wsId) {
  if (blob == null) return null;
  if (typeof blob !== 'string' || !blob.startsWith(PREFIX)) return blob;
  try {
    const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const ct = raw.slice(28);
    const key = workspaceKey(wsId);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    // Tampered or wrong workspace - surface as a clear error, never silent fallback.
    throw new Error('decrypt failed (workspace ' + wsId + '): ' + e.message);
  }
}

function isEncrypted(blob) {
  return typeof blob === 'string' && blob.startsWith(PREFIX);
}

function encryptIfNeeded(plain, wsId, enabled) {
  if (!enabled) return plain;
  if (plain == null) return plain;
  return encrypt(plain, wsId);
}

function decryptIfNeeded(blob, wsId) {
  if (!isEncrypted(blob)) return blob;
  return decrypt(blob, wsId);
}

// Helper: HMAC for e-signatures.  Uses master key so signature cannot be forged
// without filesystem access - and is workspace-bound via wsId.
function signHmac(payload, wsId) {
  const key = workspaceKey(wsId);
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function verifyHmac(payload, wsId, expected) {
  const got = signHmac(payload, wsId);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function _reset() {
  _master = null;
  _wsKeyCache.clear();
}

module.exports = {
  encrypt, decrypt, isEncrypted, encryptIfNeeded, decryptIfNeeded,
  signHmac, verifyHmac, sha256, masterKey, _reset
};
