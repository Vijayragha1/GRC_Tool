#!/usr/bin/env node
// Online backup of the ISMS database + uploads.
//
//   node scripts/backup.js                      → ./backups/iso27001-YYYYMMDD-HHmmss/
//   node scripts/backup.js /path/to/backups     → /path/to/backups/iso27001-...
//
// Uses SQLite's online-backup API (via better-sqlite3 .backup()), so the live
// server can keep running. Then tars the uploads/ directory next to it.
//
// What this does NOT do:
//   - Off-site replication. Schedule this from cron and rsync the output dir.
//   - Encrypt the backup. Pipe through gpg/age in a wrapper if needed.
//   - Verify restoration. Run a periodic restore drill against a scratch dir.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DEST_BASE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'backups');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const destDir = path.join(DEST_BASE, `iso27001-${stamp}`);
fs.mkdirSync(destDir, { recursive: true });

const dbPath = path.join(ROOT, 'iso27001.db');
const dbBackupPath = path.join(destDir, 'iso27001.db');
const uploadsDir = path.join(ROOT, 'uploads');
const masterKeyPath = path.join(ROOT, 'data', 'master.key');

(async () => {
  if (!fs.existsSync(dbPath)) {
    console.error(`[backup] No database at ${dbPath} — nothing to back up.`);
    process.exit(1);
  }

  console.log(`[backup] → ${destDir}`);

  // Online backup: better-sqlite3 .backup() acquires a shared lock, copies
  // page-by-page, and tolerates concurrent writes from the live server.
  const db = new Database(dbPath, { readonly: true });
  await db.backup(dbBackupPath);
  db.close();
  const dbSize = fs.statSync(dbBackupPath).size;
  console.log(`[backup]  db: ${dbBackupPath} (${(dbSize / 1024 / 1024).toFixed(1)} MiB)`);

  if (fs.existsSync(uploadsDir)) {
    const tarPath = path.join(destDir, 'uploads.tar.gz');
    execSync(`tar -czf "${tarPath}" -C "${ROOT}" uploads`, { stdio: 'inherit' });
    const tarSize = fs.statSync(tarPath).size;
    console.log(`[backup]  uploads: ${tarPath} (${(tarSize / 1024 / 1024).toFixed(1)} MiB)`);
  } else {
    console.log(`[backup]  uploads: skipped (no uploads dir)`);
  }

  // Master key: if you lose this, all encrypted document content is unrecoverable.
  // We deliberately copy it into the same backup bundle so restore is one-step;
  // if you'd rather keep keys separate (recommended), point this at a different
  // dest or strip it out before shipping the bundle off-site.
  if (fs.existsSync(masterKeyPath)) {
    const keyDest = path.join(destDir, 'master.key');
    fs.copyFileSync(masterKeyPath, keyDest);
    fs.chmodSync(keyDest, 0o600);
    console.log(`[backup]  master.key: ${keyDest} (mode 0600)`);
  }

  // Manifest for restore-time sanity check.
  const manifest = {
    created_at: new Date().toISOString(),
    db_size_bytes: dbSize,
    has_uploads: fs.existsSync(uploadsDir),
    has_master_key: fs.existsSync(masterKeyPath),
    node_version: process.version,
    schema_user_version: (() => {
      const probe = new Database(dbBackupPath, { readonly: true });
      const v = probe.pragma('user_version', { simple: true });
      probe.close();
      return v;
    })()
  };
  fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`[backup] done.`);
})().catch(err => {
  console.error(`[backup] failed: ${err.message}`);
  process.exit(1);
});
