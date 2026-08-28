'use strict';
// Governed recovery-generation service. Each committed generation contains an
// online SQLite backup, an encrypted snapshot of uploads, and an HMAC-signed
// manifest tying every artifact and uploaded file to the same generation.
// The encryption key is deliberately never copied into a generation or mirror.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const enc = require('./encryption');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.resolve(process.env.ISMS_BACKUP_DIR || path.join(ROOT, 'data', 'backups'));
const UPLOADS_DIR = path.resolve(process.env.ISMS_UPLOADS_DIR || path.join(ROOT, 'uploads'));
const RETAIN = positiveInteger(process.env.ISMS_BACKUP_RETAIN, 14);
const LOCK_STALE_MS = positiveInteger(process.env.ISMS_BACKUP_LOCK_STALE_MIN, 360) * 60_000;
const LOCK_PATH = path.join(BACKUP_DIR, '.backup.lock');
const UPLOAD_BUNDLE_MAGIC = 'NIMBUS-UPLOADS-V1\n';
const MANIFEST_FORMAT = 'nimbus-recovery-generation-v2';
const MANIFEST_HMAC_DOMAIN = 'nimbus-recovery-manifest-v2\0';

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

function sourceDatabasePath(database, configuredPath) {
  return path.resolve(configuredPath || process.env.DB_PATH || database.name || path.join(ROOT, 'iso27001.db'));
}

function recordFailure(database, target, error) {
  try {
    database.prepare(`INSERT INTO backup_runs (kind, path, status, error) VALUES ('full', ?, 'fail', ?)`)
      .run(target || BACKUP_DIR, String(error && error.message || error).slice(0, 4000));
  } catch (recordError) {
    console.error('[backup] could not record failure:', recordError.message);
  }
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.partial-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(candidate, seen = new Set()) {
  const absolute = path.resolve(candidate);
  if (seen.has(absolute)) throw new Error(`symbolic-link loop in recovery path: ${absolute}`);
  seen.add(absolute);
  let existing = absolute;
  const suffix = [];
  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (stat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(existing), fs.readlinkSync(existing));
        return canonicalPath(path.join(target, ...suffix), seen);
      }
      return path.join(fs.realpathSync(existing), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return path.join(existing, ...suffix);
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function assertSafeSourceLayout() {
  // A broad/mistyped uploads root must never capture its own recovery output or
  // the separately escrowed encryption key.
  const uploads = canonicalPath(UPLOADS_DIR);
  const backup = canonicalPath(BACKUP_DIR);
  if (isInside(uploads, backup)) {
    throw new Error('ISMS_BACKUP_DIR must not be inside ISMS_UPLOADS_DIR');
  }
  const mirror = process.env.BACKUP_MIRROR_DIR && path.resolve(process.env.BACKUP_MIRROR_DIR);
  if (mirror) {
    const canonicalMirror = canonicalPath(mirror);
    if (isInside(uploads, canonicalMirror)) {
      throw new Error('BACKUP_MIRROR_DIR must not be inside ISMS_UPLOADS_DIR');
    }
    if (isInside(backup, canonicalMirror) || isInside(canonicalMirror, backup)) {
      throw new Error('BACKUP_MIRROR_DIR must not overlap ISMS_BACKUP_DIR');
    }
  }
  const keyFile = path.resolve(process.env.ISMS_KEY_FILE || path.join(ROOT, 'data', 'master.key'));
  if (isInside(uploads, canonicalPath(keyFile))) {
    throw new Error('ISMS_UPLOADS_DIR includes the encryption key; refusing to archive it');
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function unsignedManifest(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  if (copy.integrity) delete copy.integrity.manifest_hmac_sha256;
  return copy;
}

function signManifest(manifest, key) {
  return crypto.createHmac('sha256', key)
    .update(MANIFEST_HMAC_DOMAIN)
    .update(canonicalJson(unsignedManifest(manifest)))
    .digest('hex');
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function uploadDescriptors() {
  if (!fs.existsSync(UPLOADS_DIR)) return { sourcePresent: false, files: [] };
  const rootStat = fs.lstatSync(UPLOADS_DIR);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('ISMS_UPLOADS_DIR must be a real directory, not a symlink');
  }
  const files = [];
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`uploads snapshot refuses symbolic link: ${relative}`);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) files.push({ absolute, path: relative, size: stat.size, dev: stat.dev, ino: stat.ino });
      else throw new Error(`uploads snapshot refuses non-regular entry: ${relative}`);
    }
  };
  visit(UPLOADS_DIR, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sourcePresent: true, files };
}

async function* uploadBundleSource(descriptors, entries) {
  yield Buffer.from(UPLOAD_BUNDLE_MAGIC, 'utf8');
  for (const descriptor of descriptors) {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(descriptor.absolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== descriptor.dev || opened.ino !== descriptor.ino || opened.size !== descriptor.size) {
      fs.closeSync(fd);
      throw new Error(`upload changed while snapshot was starting: ${descriptor.path}`);
    }
    yield Buffer.from(JSON.stringify({ path: descriptor.path, size_bytes: descriptor.size }) + '\n', 'utf8');
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = fs.createReadStream(null, { fd, autoClose: true });
    for await (const chunk of stream) {
      bytes += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== descriptor.size) throw new Error(`upload changed while snapshot was running: ${descriptor.path}`);
    entries.push({ path: descriptor.path, size_bytes: bytes, sha256: hash.digest('hex') });
  }
  yield Buffer.from('{"end":true}\n', 'utf8');
}

async function writeEncryptedUploadsArchive(target, cipherTemporary, descriptors, key) {
  const entries = [];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  await pipeline(
    Readable.from(uploadBundleSource(descriptors, entries)),
    cipher,
    fs.createWriteStream(cipherTemporary, { flags: 'wx', mode: 0o600 }),
  );
  const tag = cipher.getAuthTag();
  const outFd = fs.openSync(target, 'wx', 0o600);
  const inFd = fs.openSync(cipherTemporary, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    fs.writeSync(outFd, iv);
    fs.writeSync(outFd, tag);
    let bytesRead;
    do {
      bytesRead = fs.readSync(inFd, chunk, 0, chunk.length, null);
      if (bytesRead) fs.writeSync(outFd, chunk, 0, bytesRead);
    } while (bytesRead);
    fs.fsyncSync(outFd);
    fs.fchmodSync(outFd, 0o600);
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    try { fs.unlinkSync(cipherTemporary); } catch (_) {}
  }
  return entries;
}

function mirrorArtifacts(files) {
  const configured = process.env.BACKUP_MIRROR_DIR;
  if (!configured) return [];
  const dir = path.resolve(configured);
  if (dir === BACKUP_DIR) throw new Error('BACKUP_MIRROR_DIR must be separate from ISMS_BACKUP_DIR');
  ensurePrivateDir(dir);
  const mirrored = [];
  try {
    // The signed manifest is copied last and acts as the commit record.
    for (const source of files) {
      const target = path.join(dir, path.basename(source));
      const temporary = `${target}.partial-${process.pid}`;
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      mirrored.push(target);
    }
  } catch (error) {
    for (const target of mirrored) {
      try { fs.unlinkSync(target); } catch (_) {}
    }
    throw error;
  }
  rotateDirectory(dir);
  return mirrored;
}

function rotateDirectory(dir = BACKUP_DIR) {
  ensurePrivateDir(dir);
  const backups = fs.readdirSync(dir)
    .filter(name => /^isms-.*\.db\.gz\.enc$/.test(name))
    .filter(name => fs.existsSync(path.join(dir, name.replace(/\.db\.gz\.enc$/, '.manifest.json'))))
    .sort();
  while (backups.length > RETAIN) {
    const backupName = backups.shift();
    const base = backupName.replace(/\.db\.gz\.enc$/, '');
    // Delete only deterministic generation filenames. Never trust a manifest
    // to supply deletion paths.
    for (const name of [backupName, `${base}.uploads.enc`, `${base}.manifest.json`]) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function runBackup(options = {}) {
  // CLI one-shot mode supplies a directly-opened SQLite handle so requiring
  // this module never imports db.js or runs application migrations.
  const database = options.db || require('../db').db;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `isms-${stamp}`;
  const temporaryDb = path.join(BACKUP_DIR, `.${base}.source.partial-${process.pid}`);
  const partialDbArchive = path.join(BACKUP_DIR, `.${base}.db.partial-${process.pid}`);
  const partialUploadsArchive = path.join(BACKUP_DIR, `.${base}.uploads.partial-${process.pid}`);
  const uploadsCipherTemporary = path.join(BACKUP_DIR, `.${base}.uploads-cipher.partial-${process.pid}`);
  const databasePath = path.join(BACKUP_DIR, `${base}.db.gz.enc`);
  const uploadsPath = path.join(BACKUP_DIR, `${base}.uploads.enc`);
  const manifestPath = path.join(BACKUP_DIR, `${base}.manifest.json`);
  let lock;
  let committed = false;

  try {
    assertSafeSourceLayout();
    lock = acquireLock();
    const dbPath = sourceDatabasePath(database, options.databasePath);
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
      throw new Error(`configured database does not exist: ${dbPath}`);
    }

    const integrity = database.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`live database quick_check failed: ${integrity}`);

    await database.backup(temporaryDb);
    fs.chmodSync(temporaryDb, 0o600);
    const recovery = require('./restore-check');
    const snapshot = new Database(temporaryDb, { readonly: true, fileMustExist: true });
    let snapshotCounts;
    let snapshotUserVersion;
    try {
      const snapshotIntegrity = snapshot.pragma('quick_check', { simple: true });
      if (snapshotIntegrity !== 'ok') throw new Error(`snapshot database quick_check failed: ${snapshotIntegrity}`);
      snapshotCounts = recovery.snapshotCounts(snapshot);
      snapshotUserVersion = snapshot.pragma('user_version', { simple: true });
    } finally {
      snapshot.close();
    }
    const raw = fs.readFileSync(temporaryDb);
    fs.unlinkSync(temporaryDb);

    const key = enc.masterKey();
    const gz = zlib.gzipSync(raw);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(gz), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(partialDbArchive, Buffer.concat([iv, tag, ciphertext]), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(partialDbArchive, 0o600);

    const uploadScan = uploadDescriptors();
    const uploadEntries = await writeEncryptedUploadsArchive(
      partialUploadsArchive, uploadsCipherTemporary, uploadScan.files, key,
    );

    fs.renameSync(partialDbArchive, databasePath);
    fs.chmodSync(databasePath, 0o600);
    fs.renameSync(partialUploadsArchive, uploadsPath);
    fs.chmodSync(uploadsPath, 0o600);

    const databaseSize = fs.statSync(databasePath).size;
    const uploadsArchiveSize = fs.statSync(uploadsPath).size;
    const databaseSha256 = hashFile(databasePath);
    const uploadsArchiveSha256 = hashFile(uploadsPath);
    const uploadBytes = uploadEntries.reduce((sum, entry) => sum + entry.size_bytes, 0);
    const createdAt = new Date().toISOString();
    const manifest = {
      format: MANIFEST_FORMAT,
      generation_id: base,
      created_at: createdAt,
      source_database: path.basename(dbPath),
      archive: path.basename(databasePath),
      size_bytes: databaseSize,
      sha256: databaseSha256,
      encrypted: true,
      sqlite_integrity: integrity,
      schema_user_version: snapshotUserVersion,
      database_snapshot_counts: snapshotCounts,
      key_included: false,
      key_escrow_required: true,
      key_fingerprint_sha256: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
      artifacts: {
        database: {
          name: path.basename(databasePath),
          format: 'nimbus-sqlite-gzip-aes256gcm-v1',
          size_bytes: databaseSize,
          sha256: databaseSha256,
        },
        uploads: {
          name: path.basename(uploadsPath),
          format: 'nimbus-uploads-framed-aes256gcm-v1',
          size_bytes: uploadsArchiveSize,
          sha256: uploadsArchiveSha256,
        },
      },
      uploads: {
        source_present: uploadScan.sourcePresent,
        archive: path.basename(uploadsPath),
        archive_size_bytes: uploadsArchiveSize,
        archive_sha256: uploadsArchiveSha256,
        file_count: uploadEntries.length,
        files_size_bytes: uploadBytes,
        files: uploadEntries,
      },
      integrity: {
        algorithm: 'hmac-sha256',
        domain: 'nimbus-recovery-manifest-v2',
      },
    };
    manifest.integrity.manifest_hmac_sha256 = signManifest(manifest, key);

    // Do not publish the manifest commit record until the exact encrypted
    // generation has survived a full restore and DB-to-upload consistency
    // check. A file deletion/race therefore leaves no committed generation.
    const precommit = recovery.verifyRecoveryGeneration({
      backupDir: BACKUP_DIR,
      manifest,
      key,
      db: database,
      allowStaleGeneration: true,
    });
    if (!precommit.fullGenerationVerified) {
      throw new Error('pre-commit recovery verification did not prove a full signed generation');
    }
    writeJsonAtomic(manifestPath, manifest);
    committed = true;

    const mirrored = mirrorArtifacts([databasePath, uploadsPath, manifestPath]);
    const generationSize = databaseSize + uploadsArchiveSize + fs.statSync(manifestPath).size;
    database.prepare(`INSERT INTO backup_runs (kind, path, size_bytes, sha256, encrypted, status)
      VALUES ('full', ?, ?, ?, 1, 'ok')`).run(manifestPath, generationSize, databaseSha256);
    rotateDirectory();
    return {
      ok: true,
      generationId: base,
      path: databasePath,
      database: databasePath,
      uploads: uploadsPath,
      manifest: manifestPath,
      artifacts: [databasePath, uploadsPath, manifestPath],
      mirrored,
      size: generationSize,
      databaseSize,
      uploadsArchiveSize,
      uploadCount: uploadEntries.length,
      uploadBytes,
      sha256: databaseSha256,
      uploadsSha256: uploadsArchiveSha256,
      manifestHmac: manifest.integrity.manifest_hmac_sha256,
      precommitVerified: true,
      keyIncluded: false,
    };
  } catch (error) {
    for (const file of [temporaryDb, partialDbArchive, partialUploadsArchive, uploadsCipherTemporary]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
    if (!committed) {
      for (const file of [databasePath, uploadsPath, manifestPath]) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
    recordFailure(database, manifestPath, error);
    return { ok: false, error: error.message };
  } finally {
    releaseLock(lock);
  }
}

function listBackups() {
  ensurePrivateDir(BACKUP_DIR);
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => /^isms-.*\.db\.gz\.enc$/.test(name))
    .filter(name => fs.existsSync(path.join(BACKUP_DIR, name.replace(/\.db\.gz\.enc$/, '.manifest.json'))))
    .map(name => {
      const file = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(file);
      const manifestPath = path.join(BACKUP_DIR, name.replace(/\.db\.gz\.enc$/, '.manifest.json'));
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
      const uploadsPath = path.join(BACKUP_DIR, name.replace(/\.db\.gz\.enc$/, '.uploads.enc'));
      return {
        name,
        path: file,
        size: stat.size,
        mtime: stat.mtime,
        generationId: manifest && manifest.generation_id || name.replace(/\.db\.gz\.enc$/, ''),
        format: manifest && manifest.format || 'legacy',
        complete: Boolean(manifest && (manifest.format !== MANIFEST_FORMAT || fs.existsSync(uploadsPath))),
        uploadCount: manifest && manifest.uploads ? manifest.uploads.file_count : null,
        uploadBytes: manifest && manifest.uploads ? manifest.uploads.files_size_bytes : null,
        manifest: manifestPath,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = {
  runBackup,
  listBackups,
  BACKUP_DIR,
  UPLOADS_DIR,
  acquireLock,
  releaseLock,
  // Shared with restore-check and focused tests; not an encryption-key API.
  canonicalJson,
  signManifest,
  MANIFEST_FORMAT,
  MANIFEST_HMAC_DOMAIN,
  UPLOAD_BUNDLE_MAGIC,
};
