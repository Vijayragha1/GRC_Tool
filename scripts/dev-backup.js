#!/usr/bin/env node
// Dev backup wrapper for the launchd daily job (com.grc.dev-backup).
//
// scripts/backup.js (npm run backup) writes a file bundle to backups/ but does
// NOT record a backup_runs row. The Phase 7 demolition gate keys off backup_runs
// (latest must be status='ok' and < 24h old), so this wrapper runs the bundle
// backup and then records the backup_runs row, keeping the launchd job and the
// gate in sync. Run by launchd; also runnable directly: node scripts/dev-backup.js
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(ROOT, 'iso27001.db');
const backupsDir = path.join(ROOT, 'backups');

let status = 'ok', error = null, destRel = null, size = null;
try {
  execSync(`"${process.execPath}" "${path.join(ROOT, 'scripts', 'backup.js')}"`, { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  status = 'error';
  error = String((e && e.message) || e).slice(0, 500);
}

// locate the newest bundle dir (the one backup.js just wrote)
try {
  const dirs = fs.readdirSync(backupsDir)
    .filter((d) => /^iso27001-\d{8}-\d{6}$/.test(d))
    .map((d) => ({ d, t: fs.statSync(path.join(backupsDir, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (dirs[0]) {
    destRel = path.join('backups', dirs[0].d);
    const dbf = path.join(backupsDir, dirs[0].d, 'iso27001.db');
    if (fs.existsSync(dbf)) size = fs.statSync(dbf).size; else if (status === 'ok') { status = 'error'; error = 'bundle dir present but iso27001.db missing'; }
  } else if (status === 'ok') { status = 'error'; error = 'no backup bundle produced'; }
} catch (e) {
  if (status === 'ok') { status = 'error'; error = `locate bundle failed: ${String((e && e.message) || e).slice(0, 300)}`; }
}

const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
db.prepare(`INSERT INTO backup_runs (kind, path, size_bytes, encrypted, status, error) VALUES ('full', ?, ?, 0, ?, ?)`)
  .run(destRel || '(none)', size, status, error);
db.close();

console.log(`[dev-backup] backup_runs recorded: status=${status} path=${destRel || '(none)'} size=${size || 0}`);
process.exit(status === 'ok' ? 0 : 1);
