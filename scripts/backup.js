#!/usr/bin/env node
'use strict';
// CLI for the governed backup implementation used by the application UI.
// It always backs up DB_PATH and defaults to the durable data volume:
// /app/data/backups in the container, ./data/backups for local operation.

process.umask(0o077);

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const destination = process.argv[2];
if (destination === '--help' || destination === '-h') {
  console.log('Usage: node scripts/backup.js [destination-directory]');
  process.exit(0);
}
if (destination) process.env.ISMS_BACKUP_DIR = path.resolve(destination);

const dbPath = path.resolve(process.env.DB_PATH || path.join(ROOT, 'iso27001.db'));
if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
  console.error(`[backup] configured database does not exist: ${dbPath}`);
  process.exit(1);
}

const { runBackup } = require('../lib/backup');

runBackup().then(result => {
  if (!result.ok) {
    console.error(`[backup] failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[backup] encrypted database: ${result.path}`);
  console.log(`[backup] manifest: ${result.manifest}`);
  console.log(`[backup] sha256: ${result.sha256}`);
  if (result.mirrored && result.mirrored.length) {
    console.log(`[backup] mirrored: ${result.mirrored.join(', ')}`);
  }
}).catch(error => {
  console.error(`[backup] failed: ${error.message}`);
  process.exitCode = 1;
});
