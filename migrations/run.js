#!/usr/bin/env node
/**
 * Minimal forward-only migration runner (Phase 0 scaffolding).
 *
 * Applies migrations/NNN_*.sql in filename order, once each, recording the
 * applied id + sha256 checksum in schema_migrations. Re-runnable: already
 * applied files are skipped, and the migration bodies themselves use
 * CREATE TABLE IF NOT EXISTS, so a manual re-exec is also safe.
 *
 * The analysis/ subdirectory is intentionally NOT picked up: those are
 * read-only discovery queries, not forward schema, and may be re-run ad hoc.
 *
 * This runner is standalone and is NOT wired into app startup; the app's
 * existing db.js schema bootstrap is left unchanged (additive-first).
 *
 * Usage:  node migrations/run.js        (or: npm run migrate)
 *         DB_PATH=/path/to.db node migrations/run.js
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'iso27001.db');
const migrationsDir = __dirname;

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now')),
  checksum TEXT
);`);

const files = fs.readdirSync(migrationsDir)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort();

const applied = new Map(
  db.prepare('SELECT id, checksum FROM schema_migrations').all().map((r) => [r.id, r.checksum])
);

let count = 0;
for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  if (applied.has(file)) {
    if (applied.get(file) !== checksum) {
      console.warn(`! ${file}: already applied but contents changed (checksum drift). ` +
        `Skipping. Create a new migration rather than editing an applied one.`);
    } else {
      console.log(`= ${file} (already applied)`);
    }
    continue;
  }
  const apply = db.transaction(() => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, datetime('now'))")
      .run(file, checksum);
  });
  apply();
  console.log(`+ ${file} (applied)`);
  count++;
}

console.log(`\nDone. ${count} migration(s) applied this run; ${files.length} known; db=${dbPath}`);
db.close();
