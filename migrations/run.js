#!/usr/bin/env node
/**
 * Forward-only migration runner.
 *
 * Applies migrations/NNN_*.sql and migrations/NNN_*.js in filename order,
 * once each, recording the
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
 * JavaScript migrations are reserved for schema reconciliations that require
 * SQLite introspection (for example, conditionally adding a column to an
 * already-deployed table). They must export a synchronous `up(db)` function;
 * the runner executes it in the same transaction as the migration ledger row.
 *
 * Usage:  node migrations/run.js        (or: npm run migrate)
 *         DB_PATH=/path/to.db node migrations/run.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const migrationsDir = __dirname;

// These TPRM files were changed during the pre-release hardening cycle
// after a development database had already recorded their earlier checksums.
// Migration 054 reconciles that exact deployed shape. Only these exact
// old/current checksum pairs receive the specific reconciliation message.
// Unknown checksum drift remains fail-closed. Exact older non-TPRM pairs that
// pre-date this release are separately enumerated below so deployed databases
// can reach the forward reconciliation without weakening checksum validation.
const RECONCILED_DRIFTS = Object.freeze({
  '046_tprm_domain_foundation.sql': Object.freeze({
    applied: '8a7ace8a6d33d3db5c69b579b904e205dac925eccb428ddc2786a24115c5bda3',
    current: '8c828fd9a713cf0353007749d4d69875100527d537b901ff57d2527f5bbe1d13',
    reconciledBy: '054_tprm_upgrade_reconciliation.js',
  }),
  '047_tprm_relationships_concentration.sql': Object.freeze({
    applied: '9b560770f02c1d7c639b0953cfeac8bc6ed46fbe6579d6d3426c4f7600e67c83',
    current: '798f70831f661dbda20a642d61d837b235a4ead16228f07c1b1b7949fb8dd641',
    reconciledBy: '054_tprm_upgrade_reconciliation.js',
  }),
  '048_tprm_monitoring_connectors.sql': Object.freeze({
    applied: 'a08af315b0756170ca63c6d54c7d9bfeb610629425d969c3c9394c710572932d',
    current: 'b567765c2817c77a246828f08630a4d7980309d8bf14b38b0af191de02177687',
    reconciledBy: '054_tprm_upgrade_reconciliation.js',
  }),
  '050_tprm_condition_governance.sql': Object.freeze({
    applied: 'ffa4cc978694b730488ace582861633a074ea5c16fc5de99d5527d81f5b102d6',
    current: '0566b51f0829ba2cf4ea6f4ea82a716290e5232caa43b848f1f83ae212d92aac',
    reconciledBy: '054_tprm_upgrade_reconciliation.js',
  }),
  '054_tprm_upgrade_reconciliation.js': Object.freeze({
    applied: Object.freeze([
      '9ce929a79ea0d25ef9732ee3077199d3588ecaa09cc99e037be66f278e7229d5',
      '40a05fbce451be761aaadd65d8a57513938d5113eaba179cec373a1daecc051a',
    ]),
    current: '97c8795eb2673f4f6d18039781293eeae9281b252c74c74066a70e93ca5c3703',
    reconciledBy: '060_tprm_foreign_key_scope_reconciliation.js',
  }),
  '055_tprm_exact_schema_reconciliation.js': Object.freeze({
    applied: '636205b23b077ee9e0899c5ab3b78853e38491b9649a4f1d14e9f188582f5ff6',
    current: 'a3171275db81df0fd6f212361f4647d7dfe4a8f06effd8ea157140c3ab1627e3',
    reconciledBy: '060_tprm_foreign_key_scope_reconciliation.js',
  }),
});

// Exact historic pairs that pre-date this TPRM release and are already present
// in the supplied deployment database. Listing both hashes preserves startup
// compatibility without turning checksum validation into a blanket bypass.
const KNOWN_LEGACY_DRIFTS = Object.freeze({
  '021_client_collaboration_portal.sql': Object.freeze({
    applied: 'd323e04cadeeebf8fe743f2f3e412401b881b73766bced4f1816ec2fadea1ac4',
    current: '6e88341fde094acf2ae50cbff0272a4095c1e609e4eeaf5dd67fe2da6d610955',
  }),
  '031_intake_asset_lineage.sql': Object.freeze({
    applied: 'f97b9e2c4bf674650b955a25f842c1659eebf6f77b5758a0867f113a0d23762c',
    current: 'f06f7a620295bb595f3ff4ec76f7e0e1829830d977360510d6b6e9bc58a731bf',
  }),
  '032_backfill_intake_crown_jewels.sql': Object.freeze({
    applied: 'bbde8d44c6ceea3d676300948666746ba44a09495b198e5f115399afedcdb720',
    current: 'f87467e6d7bbc86e598427b69b3fa4266ac9e5c762a6e18e5f74652de68aea0d',
  }),
  '033_asset_edit_concurrency.sql': Object.freeze({
    applied: '90061ef39a6e69be09f87d1abec4a3c69af857f2a55a4d4421cf867eda71be20',
    current: 'adc0d3b91114f821361d7ccdc515d9b8298642a39f9b830f0ed86793ecd6de93',
  }),
  '034_client_gap_assessment_decisions.sql': Object.freeze({
    applied: 'd04e71c319c0aa7c38d8c3cfa3fa7246b3432ee600259f029c8d9d3c345f9653',
    current: 'd3a75bc74734c9e0f64f37a73c322f70cea12339800b359ecde1fd57b9a2b634',
  }),
  '045_certification_finding_evidence.sql': Object.freeze({
    applied: '1b1802746f99f845f723dcd9f3a66fecc2a67455922a35937491a784ec2424c6',
    current: '98957d493c4907c38660bde6ad0e3f26957c453a66060b30782bbb3d5e65ec48',
  }),
});

function isKnownReconciledDrift(file, appliedChecksum, currentChecksum) {
  const known = RECONCILED_DRIFTS[file];
  const acceptedApplied = known && (Array.isArray(known.applied) ? known.applied : [known.applied]);
  return Boolean(known && acceptedApplied.includes(appliedChecksum) && known.current === currentChecksum);
}

function isKnownLegacyDrift(file, appliedChecksum, currentChecksum) {
  const known = KNOWN_LEGACY_DRIFTS[file];
  return Boolean(known && known.applied === appliedChecksum && known.current === currentChecksum);
}

function loadJavascriptMigration(file) {
  const migrationPath = path.join(migrationsDir, file);
  delete require.cache[require.resolve(migrationPath)];
  const migration = require(migrationPath);
  if (!migration || typeof migration.up !== 'function') {
    throw new Error(`${file} must export a synchronous up(db) function`);
  }
  return migration;
}

function executeMigration(db, file, source, loadedMigration = null) {
  if (file.endsWith('.sql')) {
    db.exec(source);
    return;
  }
  const migration = loadedMigration || loadJavascriptMigration(file);
  const result = migration.up(db);
  if (result && typeof result.then === 'function') {
    throw new Error(`${file} returned a Promise; migrations must be synchronous and transactional`);
  }
}

// Apply every pending migration on an OPEN better-sqlite3 handle. Returns
// { applied, total, ms }. Throws on the first failing migration (fail loud).
function applyPending(db, { log = false } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now')),
    checksum TEXT
  );`);

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d+.*\.(?:sql|js)$/.test(f))
    .sort();

  const applied = new Map(
    db.prepare('SELECT id, checksum FROM schema_migrations').all().map((r) => [r.id, r.checksum])
  );

  const startedNs = process.hrtime.bigint();
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(source).digest('hex');
    if (applied.has(file)) {
      const recorded = applied.get(file);
      const knownDrift = recorded !== checksum && isKnownReconciledDrift(file, recorded, checksum);
      const knownLegacyDrift = recorded !== checksum && isKnownLegacyDrift(file, recorded, checksum);
      if (knownDrift && !files.includes(RECONCILED_DRIFTS[file].reconciledBy)) {
        throw new Error(`Migration checksum drift: ${file} requires missing ${RECONCILED_DRIFTS[file].reconciledBy}`);
      }
      if (recorded !== checksum && !knownDrift && !knownLegacyDrift) {
        throw new Error(`Migration checksum drift: ${file}. Refusing to start; restore the applied migration and add a new forward migration.`);
      }
      if (knownDrift && log) {
        console.warn(`! ${file}: known pre-release checksum drift; ${RECONCILED_DRIFTS[file].reconciledBy} owns the forward reconciliation.`);
      } else if (knownLegacyDrift && log) {
        console.warn(`! ${file}: exact audited legacy checksum pair; later forward migrations own the deployed schema.`);
      } else if (log) {
        console.log(`= ${file} (already applied)`);
      }
      continue;
    }
    let restoreForeignKeys = null;
    try {
      const loadedMigration = file.endsWith('.js') ? loadJavascriptMigration(file) : null;
      if (loadedMigration && loadedMigration.foreignKeysOff === true) {
        restoreForeignKeys = db.pragma('foreign_keys', { simple: true });
        if (db.inTransaction) throw new Error(`${file} requires foreign_keys=OFF but a transaction is already active`);
        db.pragma('foreign_keys = OFF');
      }
      const apply = db.transaction(() => {
        executeMigration(db, file, source, loadedMigration);
        db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, datetime('now'))")
          .run(file, checksum);
      });
      apply();
    } catch (e) {
      // Fail loud: a half-migrated database is worse than a refusal to serve.
      throw new Error(`Migration failed: ${file}: ${(e && e.message) || e}`);
    } finally {
      if (restoreForeignKeys != null) db.pragma(`foreign_keys = ${restoreForeignKeys ? 'ON' : 'OFF'}`);
    }
    if (log) console.log(`+ ${file} (applied)`);
    count++;
  }
  const ms = Number(process.hrtime.bigint() - startedNs) / 1e6;
  return { applied: count, total: files.length, ms };
}

module.exports = { applyPending, migrationsDir, RECONCILED_DRIFTS, KNOWN_LEGACY_DRIFTS };

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
