#!/usr/bin/env node
// Manual restore drill: prove the newest encrypted backup restores cleanly.
//
//   npm run restore-check
//
// Exit 0 when the signed manifest, archive hashes, database, and every uploaded
// evidence file pass the recovery drill; 1 otherwise.
// The verdict is also recorded in backup_runs (kind 'restore_drill') and
// shown on the system page. The monthly job runs this automatically.

process.umask(0o077);

const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const allowLegacyDatabaseOnly = args.includes('--allow-legacy-database-only');
const allowStaleGeneration = args.includes('--allow-stale-generation');
const standalone = args.includes('--standalone-no-migrations');
const generationIndex = args.indexOf('--generation');
const generationId = generationIndex === -1 ? null : args[generationIndex + 1];
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/restore-check.js [--generation <id>] [--standalone-no-migrations] [--allow-stale-generation] [--allow-legacy-database-only]');
  console.log('Legacy mode validates only SQLite and does not satisfy a full recovery drill.');
  process.exit(0);
}
if (generationIndex !== -1 && (!generationId || generationId.startsWith('-'))) {
  console.error('restore drill FAILED: --generation requires an id');
  process.exit(1);
}
const allowed = new Set(['--allow-legacy-database-only', '--allow-stale-generation', '--standalone-no-migrations']);
const optionValues = new Set(generationIndex === -1 ? [] : [generationId]);
const unknown = args.find(arg => arg !== '--generation' && !allowed.has(arg) && !optionValues.has(arg));
if (unknown) {
  console.error(`restore drill FAILED: unknown option ${unknown}`);
  process.exit(1);
}

const { runDrill } = require('../lib/restore-check');
let standaloneDb = null;
if (standalone) {
  const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'iso27001.db'));
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    console.error(`restore drill FAILED: configured database does not exist: ${dbPath}`);
    process.exit(1);
  }
  const Database = require('better-sqlite3');
  standaloneDb = new Database(dbPath, { fileMustExist: true });
  standaloneDb.pragma('busy_timeout = 5000');
}

const r = runDrill({
  db: standaloneDb || undefined,
  generationId: generationId || undefined,
  allowLegacyDatabaseOnly,
  allowStaleGeneration,
});
if (standaloneDb && standaloneDb.open) standaloneDb.close();
if (r.ok) {
  console.log(`restore drill PASSED in ${r.ms}ms`);
  console.log(`  generation: ${r.generationId}`);
  console.log(`  manifest: ${r.manifestIntegrity}`);
  if (r.generationAge) console.log(`  recovery age: ${(r.generationAge.ageMs / 3600000).toFixed(2)}h (maximum ${r.generationAge.maxAgeHours}h)`);
  console.log(`  database: integrity ${r.database.sqliteIntegrity}, archive SHA-256 verified`);
  if (r.uploads.status === 'verified') {
    console.log(`  uploads: ${r.uploads.fileCount} files, ${r.uploads.bytes} bytes, paths/hashes verified`);
    console.log(`  database file references: ${r.databaseUploadReferences.checked} resolved, ${r.databaseUploadReferences.virtual} virtual`);
  } else {
    console.log(`  uploads: ${r.uploads.status} (legacy database-only backup)`);
  }
  for (const [t, c] of Object.entries(r.counts)) console.log(`  ${t}: restored ${c.restored} vs live ${c.live}`);
  process.exit(0);
}
console.error(`restore drill FAILED: ${r.error}`);
process.exit(1);
