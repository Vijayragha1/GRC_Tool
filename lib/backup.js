'use strict';
// Governed SQLite backup service. The configured live database is copied with
// SQLite's online-backup API, compressed, AES-256-GCM encrypted, checksummed,
// and atomically promoted into a durable private directory. The encryption key
// is intentionally not copied into the archive: key and data custody must stay
// separate.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { db } = require('../db');
const enc = require('./encryption');

const BACKUP_DIR = path.resolve(process.env.ISMS_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'));
const RETAIN = positiveInteger(process.env.ISMS_BACKUP_RETAIN, 14);
const LOCK_STALE_MS = positiveInteger(process.env.ISMS_BACKUP_LOCK_STALE_MIN, 360) * 60_000;
const LOCK_PATH = path.join(BACKUP_DIR, '.backup.lock');

function positiveInteger(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  fs.chmodSync(dir, 0o700);
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function acquireLock(retryStale = true) {
  ensurePrivateDir(BACKUP_DIR);
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
    const token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }), { encoding: 'utf8' });
    fs.fchmodSync(fd, 0o600);
    return { fd, token };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try { stale = Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS; } catch (_) {}
    if (stale && retryStale) {
      fs.unlinkSync(LOCK_PATH);
      return acquireLock(false);
    }
    throw new Error(`backup already running (lock: ${LOCK_PATH})`);
  }
}

function releaseLock(lock) {
  // Never remove a lock that this invocation did not acquire.
  if (!lock || lock.fd === undefined || !lock.token) return;
  try { fs.closeSync(lock.fd); } catch (_) {}
  try {
    const current = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (current.token === lock.token) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
}

function sourceDatabasePath() {
  return path.resolve(process.env.DB_PATH || db.name || path.join(__dirname, '..', 'iso27001.db'));
}

function recordFailure(target, error) {
  try {
    db.prepare(`INSERT INTO backup_runs (kind, path, status, error) VALUES ('full', ?, 'fail', ?)`)
      .run(target || BACKUP_DIR, String(error && error.message || error).slice(0, 4000));
  } catch (recordError) {
    console.error('[backup] could not record failure:', recordError.message);
  }
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.partial-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function mirrorArtifacts(files) {
  const configured = process.env.BACKUP_MIRROR_DIR;
  if (!configured) return [];
  const dir = path.resolve(configured);
  if (dir === BACKUP_DIR) throw new Error('BACKUP_MIRROR_DIR must be separate from ISMS_BACKUP_DIR');
  ensurePrivateDir(dir);
  const mirrored = [];
  for (const source of files) {
    const target = path.join(dir, path.basename(source));
    const temporary = `${target}.partial-${process.pid}`;
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    mirrored.push(target);
  }
  rotateDirectory(dir);
  return mirrored;
}

function rotateDirectory(dir = BACKUP_DIR) {
  ensurePrivateDir(dir);
  const backups = fs.readdirSync(dir)
    .filter(name => /^isms-.*\.db\.gz\.enc$/.test(name))
    .sort();
  while (backups.length > RETAIN) {
    const backupName = backups.shift();
    const base = backupName.replace(/\.db\.gz\.enc$/, '');
    for (const name of [backupName, `${base}.manifest.json`]) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function runBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `isms-${stamp}`;
  const temporaryDb = path.join(BACKUP_DIR, `.${base}.source.partial-${process.pid}`);
  const partialArchive = path.join(BACKUP_DIR, `.${base}.archive.partial-${process.pid}`);
  const finalPath = path.join(BACKUP_DIR, `${base}.db.gz.enc`);
  const manifestPath = path.join(BACKUP_DIR, `${base}.manifest.json`);
  let lock;

  try {
    lock = acquireLock();
    const dbPath = sourceDatabasePath();
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
      throw new Error(`configured database does not exist: ${dbPath}`);
    }

    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`live database quick_check failed: ${integrity}`);

    await db.backup(temporaryDb);
    fs.chmodSync(temporaryDb, 0o600);
    const raw = fs.readFileSync(temporaryDb);
    fs.unlinkSync(temporaryDb);

    const gz = zlib.gzipSync(raw);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', enc.masterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(gz), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(partialArchive, Buffer.concat([iv, tag, ciphertext]), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(partialArchive, 0o600);
    fs.renameSync(partialArchive, finalPath);
    fs.chmodSync(finalPath, 0o600);

    const archive = fs.readFileSync(finalPath);
    const sha256 = enc.sha256(archive);
    const size = archive.length;
    const manifest = {
      format: 'nimbus-sqlite-aes256gcm-v1',
      created_at: new Date().toISOString(),
      source_database: path.basename(dbPath),
      archive: path.basename(finalPath),
      size_bytes: size,
      sha256,
      encrypted: true,
      sqlite_integrity: integrity,
      schema_user_version: db.pragma('user_version', { simple: true }),
      key_included: false,
    };
    writeJsonAtomic(manifestPath, manifest);

    const mirrored = mirrorArtifacts([finalPath, manifestPath]);
    db.prepare(`INSERT INTO backup_runs (kind, path, size_bytes, sha256, encrypted, status)
      VALUES ('full', ?, ?, ?, 1, 'ok')`).run(finalPath, size, sha256);
    rotateDirectory();
    return { ok: true, path: finalPath, manifest: manifestPath, mirrored, size, sha256 };
  } catch (error) {
    for (const file of [temporaryDb, partialArchive]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
    recordFailure(finalPath, error);
    return { ok: false, error: error.message };
  } finally {
    releaseLock(lock);
  }
}

function listBackups() {
  ensurePrivateDir(BACKUP_DIR);
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => /^isms-.*\.db\.gz\.enc$/.test(name))
    .map(name => {
      const file = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(file);
      return { name, path: file, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = {
  runBackup,
  listBackups,
  BACKUP_DIR,
  acquireLock,
  releaseLock,
};
