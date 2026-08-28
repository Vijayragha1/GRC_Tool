'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const {
  verifyUploadsBundle,
  verifyDatabaseUploadReferences,
} = require('../lib/restore-check');
const { signManifest } = require('../lib/backup');

const ROOT = path.resolve(__dirname, '..');

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-recovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'live.db');
  const uploadsDir = path.join(root, 'uploads');
  const backupDir = path.join(root, 'backups');
  const mirrorDir = path.join(root, 'mirror');
  const keyPath = options.keyInsideUploads
    ? path.join(uploadsDir, 'future-master.key')
    : path.join(root, 'escrow', 'master.key');
  fs.mkdirSync(path.join(uploadsDir, 'firm_1', 'nested'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(uploadsDir, 'firm_1', 'evidence.txt'), 'recoverable evidence\n');
  fs.writeFileSync(path.join(uploadsDir, 'firm_1', 'nested', 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]));
  const source = new Database(dbPath);
  source.exec(`
    CREATE TABLE canary (value TEXT NOT NULL);
    INSERT INTO canary VALUES ('online backup source');
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, firm_id INTEGER);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE risks (id INTEGER PRIMARY KEY);
    CREATE TABLE iso_items (id TEXT PRIMARY KEY);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY);
    CREATE TABLE backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, path TEXT NOT NULL,
      size_bytes INTEGER, sha256 TEXT, encrypted INTEGER DEFAULT 1,
      status TEXT NOT NULL, error TEXT, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  source.close();
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    ISMS_UPLOADS_DIR: uploadsDir,
    ISMS_BACKUP_DIR: backupDir,
    BACKUP_MIRROR_DIR: mirrorDir,
    ISMS_KEY_FILE: keyPath,
    ISMS_BACKUP_RETAIN: '2',
  };
  delete env.ISMS_MASTER_KEY;
  return { root, dbPath, uploadsDir, backupDir, mirrorDir, keyPath, env };
}

function command(script, env, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function generationNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.startsWith('isms-')).sort();
}

test('complete recovery generations include DB, uploads, signed manifest, mirror, and group retention', t => {
  const fixture = createFixture(t);
  for (let i = 0; i < 3; i++) {
    const backup = command('scripts/backup.js', fixture.env);
    assert.equal(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
    assert.match(backup.stdout, /uploads captured: 2 files \(26 bytes\)/);
    assert.match(backup.stdout, /encryption key included: no/);
  }

  const local = generationNames(fixture.backupDir);
  const mirrored = generationNames(fixture.mirrorDir);
  assert.deepEqual(mirrored, local);
  assert.equal(local.filter(name => name.endsWith('.db.gz.enc')).length, 2);
  assert.equal(local.filter(name => name.endsWith('.uploads.enc')).length, 2);
  assert.equal(local.filter(name => name.endsWith('.manifest.json')).length, 2);
  assert.ok(!local.some(name => name.includes('master.key')));
  assert.ok(fs.existsSync(fixture.keyPath));
  assert.ok(!fs.existsSync(path.join(fixture.backupDir, path.basename(fixture.keyPath))));

  const manifestName = local.filter(name => name.endsWith('.manifest.json')).at(-1);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.backupDir, manifestName), 'utf8'));
  assert.equal(manifest.format, 'nimbus-recovery-generation-v2');
  assert.equal(manifest.key_included, false);
  assert.equal(manifest.key_escrow_required, true);
  assert.equal(manifest.uploads.file_count, 2);
  assert.equal(manifest.uploads.files_size_bytes, 26);
  assert.match(manifest.integrity.manifest_hmac_sha256, /^[a-f0-9]{64}$/);
  for (const entry of manifest.uploads.files) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.path.startsWith('firm_1/'));
  }

  const restore = command('scripts/restore-check.js', fixture.env);
  assert.equal(restore.status, 0, `${restore.stdout}\n${restore.stderr}`);
  assert.match(restore.stdout, /manifest: hmac-sha256-verified/);
  assert.match(restore.stdout, /uploads: 2 files, 26 bytes, paths\/hashes verified/);
});

test('restore drill fails closed for artifact tampering and legacy DB-only generations by default', t => {
  const fixture = createFixture(t);
  const backup = command('scripts/backup.js', fixture.env);
  assert.equal(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
  const names = generationNames(fixture.backupDir);
  const uploadsPath = path.join(fixture.backupDir, names.find(name => name.endsWith('.uploads.enc')));
  const manifestPath = path.join(fixture.backupDir, names.find(name => name.endsWith('.manifest.json')));
  const originalManifest = fs.readFileSync(manifestPath);
  const changedManifest = JSON.parse(originalManifest.toString('utf8'));
  changedManifest.uploads.file_count += 1;
  fs.writeFileSync(manifestPath, JSON.stringify(changedManifest, null, 2));
  const badManifest = command('scripts/restore-check.js', fixture.env);
  assert.equal(badManifest.status, 1, `${badManifest.stdout}\n${badManifest.stderr}`);
  assert.match(badManifest.stderr, /manifest HMAC verification failed/);
  fs.writeFileSync(manifestPath, originalManifest);

  const originalUploadArchive = fs.readFileSync(uploadsPath);
  const tampered = Buffer.from(originalUploadArchive);
  tampered[tampered.length - 1] ^= 0xff;
  fs.writeFileSync(uploadsPath, tampered);
  const badArchive = command('scripts/restore-check.js', fixture.env);
  assert.equal(badArchive.status, 1, `${badArchive.stdout}\n${badArchive.stderr}`);
  assert.match(badArchive.stderr, /uploads archive SHA-256 mismatch/);
  fs.writeFileSync(uploadsPath, originalUploadArchive);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.format = 'nimbus-sqlite-aes256gcm-v1';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const legacyDefault = command('scripts/restore-check.js', fixture.env);
  assert.equal(legacyDefault.status, 1, `${legacyDefault.stdout}\n${legacyDefault.stderr}`);
  assert.match(legacyDefault.stderr, /legacy database-only backup has no uploads snapshot/);
  const legacyExplicit = command('scripts/restore-check.js', fixture.env, ['--allow-legacy-database-only']);
  assert.equal(legacyExplicit.status, 0, `${legacyExplicit.stdout}\n${legacyExplicit.stderr}`);
  assert.match(legacyExplicit.stdout, /legacy-not-in-generation/);
});

test('backup refuses a not-yet-created encryption key path beneath uploads', t => {
  const fixture = createFixture(t, { keyInsideUploads: true });
  assert.equal(fs.existsSync(fixture.keyPath), false);
  const backup = command('scripts/backup.js', fixture.env);
  assert.equal(backup.status, 1, `${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stderr, /uploads directory includes the encryption key|ISMS_UPLOADS_DIR includes the encryption key/i);
  assert.equal(fs.existsSync(fixture.keyPath), false, 'layout validation must run before key generation');
  assert.equal(generationNames(fixture.backupDir).length, 0);
});

test('backup rejects a symlinked backup directory resolving beneath uploads before locking', t => {
  const fixture = createFixture(t);
  const target = path.join(fixture.uploadsDir, 'backup-target');
  const alias = path.join(fixture.root, 'backup-alias');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, alias, 'dir');
  const env = { ...fixture.env, ISMS_BACKUP_DIR: alias };

  const backup = command('scripts/backup.js', env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 1, `${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stderr, /ISMS_BACKUP_DIR must not be inside ISMS_UPLOADS_DIR/);
  assert.equal(fs.existsSync(path.join(target, '.backup.lock')), false);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(fixture.keyPath), false, 'layout rejection must precede key generation');
});

test('backup rejects a symlinked mirror directory resolving beneath uploads', t => {
  const fixture = createFixture(t);
  const target = path.join(fixture.uploadsDir, 'mirror-target');
  const alias = path.join(fixture.root, 'mirror-alias');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, alias, 'dir');
  const env = { ...fixture.env, BACKUP_MIRROR_DIR: alias };

  const backup = command('scripts/backup.js', env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 1, `${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stderr, /BACKUP_MIRROR_DIR must not be inside ISMS_UPLOADS_DIR/);
  assert.equal(fs.existsSync(path.join(fixture.backupDir, '.backup.lock')), false);
  assert.equal(fs.existsSync(fixture.backupDir), false);
  assert.equal(fs.existsSync(fixture.keyPath), false, 'layout rejection must precede key generation');
});

test('backup rejects a mirror nested inside the primary backup directory', t => {
  const fixture = createFixture(t);
  const nestedMirror = path.join(fixture.backupDir, 'mirror');
  const env = { ...fixture.env, BACKUP_MIRROR_DIR: nestedMirror };

  const backup = command('scripts/backup.js', env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 1, `${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stderr, /BACKUP_MIRROR_DIR must not overlap ISMS_BACKUP_DIR/);
  assert.equal(fs.existsSync(fixture.backupDir), false, 'layout rejection must precede backup writes');
  assert.equal(fs.existsSync(fixture.keyPath), false, 'layout rejection must precede key generation');
});

test('backup rejects a primary backup directory nested inside its mirror', t => {
  const fixture = createFixture(t);
  const containingMirror = path.join(fixture.root, 'recovery-root');
  const nestedBackup = path.join(containingMirror, 'primary');
  const env = {
    ...fixture.env,
    ISMS_BACKUP_DIR: nestedBackup,
    BACKUP_MIRROR_DIR: containingMirror,
  };

  const backup = command('scripts/backup.js', env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 1, `${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stderr, /BACKUP_MIRROR_DIR must not overlap ISMS_BACKUP_DIR/);
  assert.equal(fs.existsSync(containingMirror), false, 'layout rejection must precede recovery-directory writes');
  assert.equal(fs.existsSync(fixture.keyPath), false, 'layout rejection must precede key generation');
});

test('backup rejects an encryption-key symlink alias resolving beneath uploads', t => {
  const fixture = createFixture(t);
  const keyTarget = path.join(fixture.uploadsDir, 'real-master.key');
  const keyAlias = path.join(fixture.root, 'key-alias');
  fs.symlinkSync(keyTarget, keyAlias);
  const env = { ...fixture.env, ISMS_KEY_FILE: keyAlias };

  const backup = command('scripts/backup.js', env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 1, `${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stderr, /includes the encryption key/);
  assert.equal(fs.existsSync(keyTarget), false, 'layout rejection must precede key creation through the alias');
  assert.equal(fs.existsSync(fixture.backupDir), false);
});

test('upload extraction rejects traversal before writing outside its isolated root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-bundle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'malicious.bundle');
  const extractRoot = path.join(root, 'extract');
  const body = Buffer.from('x');
  fs.writeFileSync(bundle, Buffer.concat([
    Buffer.from('NIMBUS-UPLOADS-V1\n'),
    Buffer.from(JSON.stringify({ path: '../x.txt', size_bytes: body.length }) + '\n'),
    body,
    Buffer.from('{"end":true}\n'),
  ]));
  const manifest = {
    file_count: 1,
    files_size_bytes: 1,
    files: [{ path: 'safe.txt', size_bytes: 1, sha256: crypto.createHash('sha256').update(body).digest('hex') }],
  };
  assert.throws(() => verifyUploadsBundle(bundle, manifest, extractRoot), /unsafe upload path rejected/);
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
});

test('restored database file references must resolve to extracted uploads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-reference-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firm_7'), { recursive: true });
  fs.writeFileSync(path.join(root, 'firm_7', 'present.txt'), 'present');
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, firm_id INTEGER);
    CREATE TABLE evidence (id INTEGER PRIMARY KEY, workspace_id INTEGER, stored_path TEXT, sha256 TEXT, size_bytes INTEGER);
    INSERT INTO workspaces VALUES (1, 7);
    INSERT INTO evidence VALUES (1, 1, 'present.txt', '${crypto.createHash('sha256').update('present').digest('hex')}', 7);
    INSERT INTO evidence VALUES (2, 1, 'ddq://42', NULL, NULL);
  `);
  assert.deepEqual(verifyDatabaseUploadReferences(db, root), {
    checked: 1, virtual: 1, metadataChecked: 1, missing: 0,
  });
  db.prepare(`INSERT INTO evidence VALUES (3, 1, 'missing.txt', NULL, NULL)`).run();
  assert.throws(() => verifyDatabaseUploadReferences(db, root), /evidence#3 -> missing\.txt/);
  db.prepare('DELETE FROM evidence WHERE id=3').run();
  db.prepare('UPDATE evidence SET size_bytes=999 WHERE id=1').run();
  assert.throws(() => verifyDatabaseUploadReferences(db, root), /byte count mismatch/);
  db.prepare('UPDATE evidence SET size_bytes=7, sha256=? WHERE id=1').run('0'.repeat(64));
  assert.throws(() => verifyDatabaseUploadReferences(db, root), /SHA-256 mismatch/);
});

test('physical CSF evidence is included in restored upload reference checks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-csf-reference-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, firm_id INTEGER);
    CREATE TABLE csf_engagements (id INTEGER PRIMARY KEY, workspace_id INTEGER);
    CREATE TABLE csf_subcategory_assessments (id INTEGER PRIMARY KEY, engagement_id INTEGER);
    CREATE TABLE csf_evidence_items (
      id INTEGER PRIMARY KEY, assessment_id INTEGER, type TEXT, file_path TEXT, deleted_at TEXT
    );
    INSERT INTO workspaces VALUES (1, 9);
    INSERT INTO csf_engagements VALUES (2, 1);
    INSERT INTO csf_subcategory_assessments VALUES (3, 2);
    INSERT INTO csf_evidence_items VALUES (4, 3, 'FILE', 'missing-csf.pdf', NULL);
  `);
  assert.throws(() => verifyDatabaseUploadReferences(db, root), /csf_evidence_items#4 -> missing-csf\.pdf/);
  fs.mkdirSync(path.join(root, 'firm_9'), { recursive: true });
  fs.writeFileSync(path.join(root, 'firm_9', 'missing-csf.pdf'), 'csf bytes');
  assert.deepEqual(verifyDatabaseUploadReferences(db, root), {
    checked: 1, virtual: 0, metadataChecked: 0, missing: 0,
  });
});

test('backup fails before manifest commit when its DB snapshot references a missing upload', t => {
  const fixture = createFixture(t);
  const database = new Database(fixture.dbPath);
  database.exec(`
    INSERT INTO workspaces (id, firm_id) VALUES (1, 1);
    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY, workspace_id INTEGER, stored_path TEXT, sha256 TEXT, size_bytes INTEGER
    );
    INSERT INTO evidence VALUES (1, 1, 'deleted-before-snapshot.txt', NULL, NULL);
  `);
  database.close();
  const backup = command('scripts/backup.js', fixture.env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 1, `${backup.stdout}\n${backup.stderr}`);
  assert.match(backup.stderr, /database upload reference missing from recovery snapshot/);
  assert.equal(generationNames(fixture.backupDir).filter(name => name.endsWith('.manifest.json')).length, 0);
  assert.equal(fs.existsSync(fixture.mirrorDir) ? generationNames(fixture.mirrorDir).length : 0, 0);
});

test('restore enforces signed generation RPO and allows explicit stale salvage', t => {
  const fixture = createFixture(t);
  const backup = command('scripts/backup.js', fixture.env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
  const manifestName = generationNames(fixture.backupDir).find(name => name.endsWith('.manifest.json'));
  const manifestPath = path.join(fixture.backupDir, manifestName);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.created_at = new Date(Date.now() - 27 * 60 * 60_000).toISOString();
  const key = Buffer.from(fs.readFileSync(fixture.keyPath, 'utf8').trim(), 'hex');
  manifest.integrity.manifest_hmac_sha256 = signManifest(manifest, key);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const stale = command('scripts/restore-check.js', fixture.env, ['--standalone-no-migrations']);
  assert.equal(stale.status, 1, `${stale.stdout}\n${stale.stderr}`);
  assert.match(stale.stderr, /generation is stale/);
  const salvage = command('scripts/restore-check.js', fixture.env,
    ['--standalone-no-migrations', '--allow-stale-generation']);
  assert.equal(salvage.status, 0, `${salvage.stdout}\n${salvage.stderr}`);
});

test('small core-table loss fails live row-count sanity', t => {
  const fixture = createFixture(t);
  const backup = command('scripts/backup.js', fixture.env, ['--standalone-no-migrations']);
  assert.equal(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
  const database = new Database(fixture.dbPath);
  const insert = database.prepare('INSERT INTO workspaces (id, firm_id) VALUES (?, 1)');
  for (let id = 1; id <= 9; id++) insert.run(id);
  database.close();
  const restore = command('scripts/restore-check.js', fixture.env, ['--standalone-no-migrations']);
  assert.equal(restore.status, 1, `${restore.stdout}\n${restore.stderr}`);
  assert.match(restore.stderr, /live row-count sanity failed on workspaces: restored=0 live=9/);
});

test('operator restore materializes an exact generation into an empty destination only', t => {
  const fixture = createFixture(t);
  for (let index = 0; index < 2; index++) {
    const backup = command('scripts/backup.js', fixture.env, ['--standalone-no-migrations']);
    assert.equal(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
  }
  const generation = generationNames(fixture.backupDir)
    .filter(name => name.endsWith('.manifest.json'))[0].replace(/\.manifest\.json$/, '');
  const destination = path.join(fixture.root, 'materialized');
  fs.mkdirSync(destination, { mode: 0o700 });
  const restore = command('scripts/restore.js', fixture.env,
    ['--destination', destination, '--generation', generation]);
  assert.equal(restore.status, 0, `${restore.stdout}\n${restore.stderr}`);
  assert.match(restore.stdout, new RegExp(`generation: ${generation}`));
  assert.ok(fs.statSync(path.join(destination, 'restored.db')).isFile());
  assert.equal(fs.readFileSync(path.join(destination, 'uploads', 'firm_1', 'evidence.txt'), 'utf8'), 'recoverable evidence\n');
  const report = JSON.parse(fs.readFileSync(path.join(destination, 'recovery-report.json'), 'utf8'));
  assert.equal(report.generation_id, generation);
  assert.equal(report.promotion_required, true);

  const second = command('scripts/restore.js', fixture.env,
    ['--destination', destination, '--generation', generation]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /destination must be empty/);

  const liveSubdirectory = path.join(fixture.uploadsDir, 'empty-restore-target');
  fs.mkdirSync(liveSubdirectory, { mode: 0o700 });
  const liveOverlap = command('scripts/restore.js', fixture.env,
    ['--destination', liveSubdirectory, '--generation', generation]);
  assert.equal(liveOverlap.status, 1);
  assert.match(liveOverlap.stderr, /overlaps a protected live or backup path/);

  const redirectedParent = path.join(fixture.root, 'redirected-parent');
  fs.symlinkSync(fixture.uploadsDir, redirectedParent, 'dir');
  const escapedDestination = path.join(redirectedParent, 'symlink-escape');
  const symlinkEscape = command('scripts/restore.js', fixture.env,
    ['--destination', escapedDestination, '--generation', generation]);
  assert.equal(symlinkEscape.status, 1);
  assert.match(symlinkEscape.stderr, /overlaps a protected live or backup path/);
  assert.equal(fs.existsSync(path.join(fixture.uploadsDir, 'symlink-escape')), false);
});

test('raw online clone script copies a consistent DB without importing app migrations', t => {
  const fixture = createFixture(t);
  const clonePath = path.join(fixture.root, 'clone.db');
  const clone = command('scripts/online-db-clone.js', fixture.env, [fixture.dbPath, clonePath]);
  assert.equal(clone.status, 0, `${clone.stdout}\n${clone.stderr}`);
  const database = new Database(clonePath, { readonly: true });
  assert.equal(database.prepare('SELECT value FROM canary').get().value, 'online backup source');
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  database.close();
});
