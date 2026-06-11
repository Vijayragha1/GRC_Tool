#!/usr/bin/env node
/**
 * Forward-only migration runner.
 *
 * Applies migrations/NNN_*.sql in filename order, once each, recording the
 * applied id + sha256 checksum in schema_migrations. Re-runnable: already
 * applied files are skipped (only PENDING ones run), and the migration bodies
 * use CREATE ... IF [NOT] EXISTS / DROP ... IF EXISTS, so a manual re-exec is
 * also safe. The analysis/ subdirectory is intentionally NOT picked up.
 *
 * As of the Phase 2 demolition this IS wired into app startup: db.js init()
 * calls applyPending(db) after the hand-written core schema, so the migration
 * chain is the single source of truth for the converged schema. On a warm DB
 * only pending migrations run (near-instant); a pristine DB pays for the full
 * chain once. A migration failure THROWS so startup fails loudly (refuse to
 * serve) rather than serving a half-migrated database.
 *
 * Usage:  node migrations/run.js        (or: npm run migrate)
 *         DB_PATH=/path/to.db node migrations/run.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const migrationsDir = __dirname;

// Apply every pending migration on an OPEN better-sqlite3 handle. Returns
// { applied, total, ms }. Throws on the first failing migration (fail loud).
function applyPending(db, { log = false } = {}) {
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

  const startedNs = process.hrtime.bigint();
  let count = 0;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum && log) {
        console.warn(`! ${file}: already applied but contents changed (checksum drift). ` +
          `Skipping. Create a new migration rather than editing an applied one.`);
      } else if (log) {
        console.log(`= ${file} (already applied)`);
      }
      continue;
    }
    try {
      const apply = db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, datetime('now'))")
          .run(file, checksum);
      });
      apply();
    } catch (e) {
      // Fail loud: a half-migrated database is worse than a refusal to serve.
      throw new Error(`Migration failed: ${file}: ${(e && e.message) || e}`);
    }
    if (log) console.log(`+ ${file} (applied)`);
    count++;
  }
  const ms = Number(process.hrtime.bigint() - startedNs) / 1e6;
  return { applied: count, total: files.length, ms };
}

module.exports = { applyPending, migrationsDir };

// CLI: open our own connection and run with logging.
if (require.main === module) {
  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'iso27001.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const r = applyPending(db, { log: true });
  console.log(`\nDone. ${r.applied} migration(s) applied this run; ${r.total} known; ${r.ms.toFixed(0)}ms; db=${dbPath}`);
  db.close();
}
