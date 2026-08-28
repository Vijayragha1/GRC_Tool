#!/usr/bin/env node
'use strict';

// Raw SQLite online clone for release preflight. This script intentionally
// does not import db.js: no application init or migration may run against the
// live source before the candidate has been proven on the clone.

process.umask(0o077);

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument || sourceArgument === '--help' || sourceArgument === '-h') {
  console.log('Usage: node scripts/online-db-clone.js <source.db> <new-destination.db>');
  process.exit(sourceArgument ? 0 : 1);
}

const sourcePath = path.resolve(sourceArgument);
const destinationPath = path.resolve(destinationArgument);
if (sourcePath === destinationPath) {
  console.error('[online-db-clone] source and destination must differ');
  process.exit(1);
}
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  console.error(`[online-db-clone] source database does not exist: ${sourcePath}`);
  process.exit(1);
}
if (!fs.existsSync(path.dirname(destinationPath)) || !fs.statSync(path.dirname(destinationPath)).isDirectory()) {
  console.error('[online-db-clone] destination parent must already exist');
  process.exit(1);
}
if (fs.existsSync(destinationPath)) {
  console.error(`[online-db-clone] destination already exists: ${destinationPath}`);
  process.exit(1);
}

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
source.pragma('busy_timeout = 5000');

(async () => {
  try {
    const sourceIntegrity = source.pragma('quick_check', { simple: true });
    if (sourceIntegrity !== 'ok') throw new Error(`source quick_check failed: ${sourceIntegrity}`);
    await source.backup(destinationPath);
    fs.chmodSync(destinationPath, 0o600);
    const clone = new Database(destinationPath, { readonly: true, fileMustExist: true });
    try {
      const cloneIntegrity = clone.pragma('integrity_check', { simple: true });
      if (cloneIntegrity !== 'ok') throw new Error(`clone integrity_check failed: ${cloneIntegrity}`);
    } finally {
      clone.close();
    }
    console.log(JSON.stringify({ ok: true, source: sourcePath, destination: destinationPath }));
  } catch (error) {
    try { fs.unlinkSync(destinationPath); } catch (_) {}
    console.error(`[online-db-clone] failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    source.close();
  }
})();
