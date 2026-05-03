// Master key rotation. Re-encrypts every encrypted column under a new master key
// inside a single transaction. Old key is needed to decrypt; new key persisted
// after success. Clears in-memory key cache so subsequent requests use the new key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const enc = require('./encryption');

const KEY_FILE = process.env.ISMS_KEY_FILE || path.join(__dirname, '..', 'data', 'master.key');

// Returns short hex fingerprint for a master key buffer.
function fingerprint(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function rotate(userId) {
  // Capture old key + fingerprint
  const oldKey = enc.masterKey();
  const oldFp = fingerprint(oldKey);
  const newKey = crypto.randomBytes(32);
  const newFp = fingerprint(newKey);

  // Encrypted-column inventory: (table, idColumn, blobColumn, workspaceColumn)
  const cols = [
    ['generated_docs', 'id', 'content', 'workspace_id'],
    ['comments',       'id', 'body',    'workspace_id'],
    ['supplier_notes', 'id', 'body',    'workspace_id'],
    ['soa_snapshots',  'id', 'payload', 'workspace_id'],
    ['doc_versions',   'id', 'content', 'workspace_id']
  ];

  // Helpers for old/new — we need to decrypt with oldKey then re-encrypt with newKey.
  function decryptOld(blob, wsId) {
    if (!blob || typeof blob !== 'string' || !blob.startsWith('enc:v1:')) return blob;
    const raw = Buffer.from(blob.slice('enc:v1:'.length), 'base64');
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const ct = raw.slice(28);
    const salt = crypto.createHash('sha256').update('isms-ws-salt').digest();
    const dk = crypto.hkdfSync('sha256', oldKey, salt, Buffer.from('ws:' + wsId), 32);
    const key = Buffer.from(dk);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  }
  function encryptNew(plain, wsId) {
    if (plain == null) return null;
    const salt = crypto.createHash('sha256').update('isms-ws-salt').digest();
    const dk = crypto.hkdfSync('sha256', newKey, salt, Buffer.from('ws:' + wsId), 32);
    const key = Buffer.from(dk);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'enc:v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
  }

  let total = 0;
  const tx = db.transaction(() => {
    for (const [table, idCol, blob, wsCol] of cols) {
      const rows = db.prepare(`SELECT ${idCol} AS id, ${blob} AS data, ${wsCol} AS ws FROM ${table} WHERE ${blob} LIKE 'enc:v1:%'`).all();
      const upd = db.prepare(`UPDATE ${table} SET ${blob}=? WHERE ${idCol}=?`);
      for (const r of rows) {
        const plain = decryptOld(r.data, r.ws);
        upd.run(encryptNew(plain, r.ws), r.id);
        total++;
      }
    }
    // Persist new key file (atomic)
    const tmp = KEY_FILE + '.tmp';
    fs.writeFileSync(tmp, newKey.toString('hex'), { mode: 0o600 });
    fs.renameSync(tmp, KEY_FILE);
    db.prepare(`INSERT INTO key_rotations (prev_key_fp, new_key_fp, rotated_by, rows_reencrypted, status, notes) VALUES (?, ?, ?, ?, 'ok', NULL)`)
      .run(oldFp, newFp, userId || null, total);
  });

  try {
    tx();
    // Reset cached key in encryption module so next requests use the new key
    enc._reset && enc._reset();
    return { ok: true, rows: total, oldFp, newFp };
  } catch (e) {
    db.prepare(`INSERT INTO key_rotations (prev_key_fp, new_key_fp, rotated_by, rows_reencrypted, status, notes) VALUES (?, ?, ?, ?, 'fail', ?)`)
      .run(oldFp, newFp, userId || null, 0, e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { rotate, fingerprint };
