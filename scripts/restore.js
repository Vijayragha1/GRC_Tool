#!/usr/bin/env node
// Restore an ISMS database backup. Closes the loop that scripts/backup.js and
// lib/backup.js open: a backup you cannot restore is not a backup.
//
// Usage:
//   node scripts/restore.js <backup>                 → verify only, write to <backup>.restored.db
//   node scripts/restore.js <backup> --out target.db → restore to a chosen path
//   node scripts/restore.js <backup> --force         → allow overwriting the live DB (DB_PATH)
//
// <backup> may be:
//   - an encrypted in-process backup    (data/backups/isms-*.db.gz.enc)   Needs the master key
//   - a plain bundle directory          (backups/iso27001-*/)             Uses its iso27001.db
//   - a plain SQLite file               (any *.db)
//
// Every restore runs `PRAGMA integrity_check` and reports row counts before it
// is considered successful. The encrypted path needs the SAME master key the
// backup was written with (ISMS_MASTER_KEY env or data/master.key); without
// it the bytes are unrecoverable, by design.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const enc = require('../lib/encryption');

const ROOT = path.resolve(__dirname, '..');
const LIVE_DB = process.env.DB_PATH || path.join(ROOT, 'iso27001.db');

function fail(msg) { console.error(`[restore] ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
const force = args.includes('--force');
const outIdx = args.indexOf('--out');
const explicitOut = outIdx >= 0 ? args[outIdx + 1] : null;
const src = args.find(a => !a.startsWith('--') && a !== explicitOut);

if (!src) {
  console.error('Usage: node scripts/restore.js <backup> [--out target.db] [--force]');
  process.exit(1);
}
if (!fs.existsSync(src)) fail(`backup not found: ${src}`);

// Resolve the source to raw SQLite bytes.
function loadSqliteBytes(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const inner = path.join(p, 'iso27001.db');
    if (!fs.existsSync(inner)) fail(`bundle has no iso27001.db: ${p}`);
    console.log(`[restore] bundle directory → ${inner}`);
    return fs.readFileSync(inner);
  }
  if (p.endsWith('.db.gz.enc')) {
    console.log('[restore] encrypted backup → decrypt + gunzip');
    const raw = fs.readFileSync(p);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    let gz;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', enc.masterKey(), iv);
      decipher.setAuthTag(tag);
      gz = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (e) {
      fail(`decrypt failed (wrong master key, or backup is corrupt/tampered): ${e.message}`);
    }
    return zlib.gunzipSync(gz);
  }
  console.log('[restore] plain SQLite file');
  return fs.readFileSync(p);
}

const bytes = loadSqliteBytes(src);

const out = explicitOut
  ? path.resolve(explicitOut)
  : (path.resolve(src) === path.resolve(LIVE_DB)
      ? fail('refusing to read and write the live DB in place')
      : `${src.replace(/\/$/, '')}.restored.db`);

if (path.resolve(out) === path.resolve(LIVE_DB) && !force) {
  fail(`refusing to overwrite the live database at ${LIVE_DB} without --force`);
}
if (fs.existsSync(out) && !force) {
  fail(`output already exists (${out}); pass --force to overwrite`);
}

fs.writeFileSync(out, bytes);
console.log(`[restore] wrote ${(bytes.length / 1024 / 1024).toFixed(1)} MiB → ${out}`);

// Verify: integrity_check + a few headline row counts.
const probe = new Database(out, { readonly: true });
const integrity = probe.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') {
  probe.close();
  fail(`integrity_check FAILED: ${integrity}`);
}
const userVersion = probe.pragma('user_version', { simple: true });
function count(table) {
  try { return probe.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c; } catch (_) { return 'n/a'; }
}
const counts = {
  firms: count('firms'),
  workspaces: count('workspaces'),
  users: count('users'),
  risks: count('risks'),
  generated_docs: count('generated_docs'),
  audit_log: count('audit_log'),
};
probe.close();

console.log('[restore] integrity_check: ok');
console.log(`[restore] schema user_version: ${userVersion}`);
console.log('[restore] row counts:', JSON.stringify(counts));
console.log('[restore] done. To go live: stop the server, replace the DB file, restart.');
if (path.resolve(out) === path.resolve(LIVE_DB)) {
  console.log('[restore] (live DB was overwritten via --force).');
}
