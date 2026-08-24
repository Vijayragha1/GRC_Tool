'use strict';
// Restore drill: prove the newest encrypted backup actually restores. A backup
// that has never been restored is a hope, not a backup. Decrypts the latest
// dump with the master key, gunzips it, opens the result, runs an integrity
// check plus row-count sanity against the live DB, and records the verdict in
// backup_runs (kind 'restore_drill') so the system page can surface it.
//
// Used by scripts/restore-check.js (manual) and the monthly job in lib/jobs.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { db } = require('../db');
const enc = require('./encryption');

const BACKUP_DIR = process.env.ISMS_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');

// Row-count tolerance vs live: the backup is up to a day old, so small drift
// is normal; an empty or wildly divergent table is what the drill must catch.
const SANITY_TABLES = ['workspaces', 'users', 'risks', 'iso_items', 'audit_log'];
const TOLERANCE = 0.5; // restored count must be at least half the live count

function newestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('isms-') && f.endsWith('.db.gz.enc')).sort();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

function runDrill() {
  const started = Date.now();
  const file = newestBackup();
  const record = (status, error, detail) => {
    try {
      db.prepare(`INSERT INTO backup_runs (kind, path, size_bytes, status, error, encrypted) VALUES ('restore_drill', ?, ?, ?, ?, 1)`)
        .run(file || '(no backup found)', file && fs.existsSync(file) ? fs.statSync(file).size : null, status, error || (detail ? JSON.stringify(detail) : null));
    } catch (e) { console.error('[restore-drill] could not record verdict:', e.message); }
  };

  if (!file) { record('fail', 'no backup file found in ' + BACKUP_DIR); return { ok: false, error: 'no backup file found' }; }

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isms-restore-')), 'restored.db');
  try {
    // File layout (see lib/backup.js): 12-byte IV + 16-byte GCM tag + ciphertext.
    const blob = fs.readFileSync(file);
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const ct = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', enc.masterKey(), iv);
    decipher.setAuthTag(tag);
    const gz = Buffer.concat([decipher.update(ct), decipher.final()]);
    fs.writeFileSync(tmp, zlib.gunzipSync(gz));

    const restored = new Database(tmp, { readonly: true });
    const integrity = restored.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') { restored.close(); record('fail', 'integrity_check: ' + integrity); return { ok: false, error: 'integrity_check: ' + integrity }; }

    const counts = {};
    for (const t of SANITY_TABLES) {
      const live = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      const back = restored.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      counts[t] = { live, restored: back };
      if (live > 0 && back < live * TOLERANCE) {
        restored.close();
        record('fail', `row-count sanity: ${t} restored=${back} live=${live}`);
        return { ok: false, error: `row-count sanity failed on ${t}`, counts };
      }
    }
    restored.close();
    const ms = Date.now() - started;
    record('ok', null, { ms, counts });
    return { ok: true, file, ms, counts };
  } catch (e) {
    record('fail', e.message);
    return { ok: false, error: e.message };
  } finally {
    try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch (_) {}
  }
}

function lastDrill() {
  try {
    return db.prepare(`SELECT * FROM backup_runs WHERE kind='restore_drill' ORDER BY ran_at DESC LIMIT 1`).get() || null;
  } catch (_) { return null; }
}

module.exports = { runDrill, lastDrill };
