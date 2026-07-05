// Local SQLite backup. Uses better-sqlite3's `backup()` to atomically copy
// the database, then GZIPs and AES-encrypts the dump with the master key.
// Retains the most recent N backups, oldest deleted.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { db } = require('../db');
const enc = require('./encryption');

const BACKUP_DIR = process.env.ISMS_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');
const RETAIN = parseInt(process.env.ISMS_BACKUP_RETAIN || '14', 10);

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function runBackup() {
  ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpPath = path.join(BACKUP_DIR, `tmp-${stamp}.db`);
  const finalPath = path.join(BACKUP_DIR, `isms-${stamp}.db.gz.enc`);

  let row;
  try {
    await db.backup(tmpPath);
    const raw = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    const gz = zlib.gzipSync(raw);
    // AES-256-GCM with master key - workspaceId 0 namespace.
    const cipher = crypto.createCipheriv('aes-256-gcm', enc.masterKey(), Buffer.alloc(12, stamp.slice(0, 12)));
    const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(finalPath, Buffer.concat([Buffer.from(stamp.slice(0, 12)), tag, ct]));
    const sha = enc.sha256(fs.readFileSync(finalPath));
    row = db.prepare(`INSERT INTO backup_runs (kind, path, size_bytes, sha256, encrypted, status) VALUES ('full', ?, ?, ?, 1, 'ok')`).run(finalPath, fs.statSync(finalPath).size, sha);
    rotate();
    mirror(finalPath);
    return { ok: true, path: finalPath, size: fs.statSync(finalPath).size, sha256: sha };
  } catch (e) {
    db.prepare(`INSERT INTO backup_runs (kind, path, status, error) VALUES ('full', ?, 'fail', ?)`).run(finalPath, e.message);
    return { ok: false, error: e.message };
  }
}

// Copy each successful dump to a second destination (mounted drive, synced
// folder) so the DB, master key, and backups do not share one failure domain.
// Cloud sync is descoped; BACKUP_MIRROR_DIR is whatever second disk exists.
function mirror(finalPath) {
  const dir = process.env.BACKUP_MIRROR_DIR;
  if (!dir) return;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(finalPath, path.join(dir, path.basename(finalPath)));
    // Prune the mirror to the same retention as the primary.
    const files = fs.readdirSync(dir).filter(f => f.startsWith('isms-') && f.endsWith('.db.gz.enc')).sort();
    while (files.length > RETAIN) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch (_) {} }
  } catch (e) {
    console.error('[backup] mirror copy failed:', e.message);
  }
}

function rotate() {
  ensureDir();
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('isms-') && f.endsWith('.db.gz.enc')).sort();
  while (files.length > RETAIN) {
    const f = files.shift();
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
  }
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('isms-') && f.endsWith('.db.gz.enc'))
    .map(f => {
      const fp = path.join(BACKUP_DIR, f);
      const st = fs.statSync(fp);
      return { name: f, path: fp, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

let timer = null;
function start(intervalHours = 24) {
  if (timer) clearInterval(timer);
  // First run after 60s, then every interval
  // unref: see lib/jobs.js - schedules must not hold a finished process open.
  setTimeout(runBackup, 60_000).unref();
  timer = setInterval(runBackup, intervalHours * 3600 * 1000);
  timer.unref();
}

module.exports = { runBackup, listBackups, start, BACKUP_DIR };
