#!/usr/bin/env node
'use strict';
// CLI for the governed recovery-generation implementation used by the UI.
// It backs up DB_PATH plus ISMS_UPLOADS_DIR and defaults to the durable volume:
// /app/data/backups in the container, ./data/backups for local operation.

process.umask(0o077);

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/backup.js [--standalone-no-migrations] [destination-directory]');
  process.exit(0);
}
const standalone = args.includes('--standalone-no-migrations');
const unknown = args.filter(arg => arg.startsWith('-') && arg !== '--standalone-no-migrations');
if (unknown.length) {
  console.error(`[backup] unknown option: ${unknown[0]}`);
  process.exit(1);
}
const positional = args.filter(arg => !arg.startsWith('-'));
if (positional.length > 1) {
  console.error('[backup] only one destination directory may be supplied');
  process.exit(1);
}
const destination = positional[0];
if (destination) process.env.ISMS_BACKUP_DIR = path.resolve(destination);

const dbPath = path.resolve(process.env.DB_PATH || path.join(ROOT, 'iso27001.db'));
if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
  console.error(`[backup] configured database does not exist: ${dbPath}`);
  process.exit(1);
}

const { runBackup } = require('../lib/backup');
let standaloneDb = null;
if (standalone) {
  const Database = require('better-sqlite3');
  standaloneDb = new Database(dbPath, { fileMustExist: true });
  standaloneDb.pragma('busy_timeout = 5000');
}

runBackup({ db: standaloneDb || undefined, databasePath: dbPath }).then(result => {
  if (!result.ok) {
    console.error(`[backup] failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[backup] recovery generation: ${result.generationId}`);
  console.log(`[backup] encrypted database: ${result.database}`);
  console.log(`[backup] encrypted uploads: ${result.uploads}`);
  console.log(`[backup] uploads captured: ${result.uploadCount} files (${result.uploadBytes} bytes)`);
  console.log(`[backup] manifest: ${result.manifest}`);
  console.log(`[backup] database sha256: ${result.sha256}`);
  console.log(`[backup] uploads sha256: ${result.uploadsSha256}`);
  console.log(`[backup] signed manifest: HMAC-SHA-256 ${result.manifestHmac}`);
  console.log('[backup] encryption key included: no (verify separate escrow before relying on this generation)');
  if (result.mirrored && result.mirrored.length) {
    console.log(`[backup] mirrored: ${result.mirrored.join(', ')}`);
  }
}).catch(error => {
  console.error(`[backup] failed: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  if (standaloneDb && standaloneDb.open) standaloneDb.close();
});
