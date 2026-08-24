'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const { canDeferMultipart, urlWithoutCsrf } = require('../lib/csrf');

const ROOT = path.resolve(__dirname, '..');

function multipartBody(fields, file) {
  const boundary = `nimbus-${crypto.randomBytes(8).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields || {})) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  if (file) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n${file.body}\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return { boundary, body: chunks.join('') };
}

test('SEC-001 image contract uses an explicit source allowlist and a non-root runtime', () => {
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerignore, /^\*$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^\*\*\/\*\.db$/m);
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s+\.$/m);
  assert.match(dockerfile, /^COPY routes\/ \.\/routes\/$/m);
  assert.match(dockerfile, /^USER node:node$/m);
  assert.match(dockerfile, /ISMS_BACKUP_DIR=\/app\/data\/backups/);
});

test('SEC-003 safe URL cleaning removes every CSRF query value and preserves filters', () => {
  const cleaned = urlWithoutCsrf({
    originalUrl: '/workspaces/7/client-portal?view=actions&_csrf=secret&status=open&_csrf=second',
    path: '/workspaces/7/client-portal',
  });
  assert.equal(cleaned, '/workspaces/7/client-portal?view=actions&status=open');
});

test('SEC-003 only registered upload endpoints may defer multipart CSRF parsing', () => {
  const multipart = { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } };
  assert.equal(canDeferMultipart({ ...multipart, path: '/workspaces/4/evidence' }), true);
  assert.equal(canDeferMultipart({ ...multipart, path: '/workspaces/4/assets/import/preview' }), true);
  assert.equal(canDeferMultipart({ ...multipart, path: '/tenants' }), false);
});

test('SEC-003 browser stamper never places tokens in GET or multipart action URLs', () => {
  const footer = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'footer.ejs'), 'utf8');
  assert.match(footer, /const safe = method === 'GET' \|\| method === 'HEAD'/);
  assert.match(footer, /inputs\.forEach\(inp => inp\.remove\(\)\)/);
  assert.doesNotMatch(footer, /action \+ sep \+ '_csrf='/);
});

test('SEC-003 live middleware cleans legacy GET URLs and rejects query tokens on mutations', async t => {
  const { client } = await bootClient();
  t.after(() => client.close());
  const token = client.getCsrfToken();

  const get = await client.get(`/dashboard?view=portfolio&_csrf=${token}`);
  assert.equal(get.status, 303);
  assert.equal(get.location, '/dashboard?view=portfolio');
  assert.doesNotMatch(get.location, /_csrf|secret/i);

  const post = await client.post(`/tenants?_csrf=${token}`, { name: 'Query Token Must Fail' }, { csrf: false });
  assert.equal(post.status, 403);
  assert.match(post.text, /CSRF token missing or invalid/);
});

test('SEC-003 multipart mutations validate the hidden body token after parsing', async t => {
  const { client, dbPath } = await bootClient();
  t.after(() => client.close());
  const created = await client.post('/workspaces', {
    client_name: 'Multipart Security Client',
    industry: 'Technology',
    frameworks: 'iso27001',
    engagement_outcome: 'certification_support',
  });
  assert.equal(created.status, 302);
  const conn = new Database(dbPath);
  const workspace = conn.prepare(`SELECT id FROM workspaces WHERE client_name=?`).get('Multipart Security Client');
  assert.ok(workspace);

  const missing = multipartBody({}, { name: 'missing-token.txt', body: 'must not persist' });
  const rejected = await client.post(`/workspaces/${workspace.id}/evidence`, missing.body, {
    csrf: false,
    headers: { 'content-type': `multipart/form-data; boundary=${missing.boundary}` },
  });
  assert.equal(rejected.status, 403);
  assert.equal(conn.prepare(`SELECT COUNT(*) count FROM evidence WHERE workspace_id=?`).get(workspace.id).count, 0);

  const valid = multipartBody({ _csrf: client.getCsrfToken(), description: 'CSRF multipart regression' },
    { name: 'valid-token.txt', body: 'safe evidence text' });
  const accepted = await client.post(`/workspaces/${workspace.id}/evidence`, valid.body, {
    csrf: false,
    headers: { 'content-type': `multipart/form-data; boundary=${valid.boundary}` },
  });
  assert.equal(accepted.status, 302, accepted.text.slice(0, 300));
  assert.equal(conn.prepare(`SELECT COUNT(*) count FROM evidence WHERE workspace_id=?`).get(workspace.id).count, 1);
  conn.close();
});

test('OPS-001 CLI backs up DB_PATH into a private durable bundle and preserves an active lock', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-backup-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dbPath = path.join(temp, 'configured-live.db');
  const backupDir = path.join(temp, 'durable-backups');
  const keyPath = path.join(temp, 'master.key');
  fs.mkdirSync(backupDir, { mode: 0o700 });
  const source = new Database(dbPath);
  source.exec(`
    CREATE TABLE canary (value TEXT NOT NULL);
    INSERT INTO canary VALUES ('configured DB_PATH was backed up');
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
    ISMS_BACKUP_DIR: backupDir,
    ISMS_KEY_FILE: keyPath,
    ISMS_BACKUP_RETAIN: '2',
  };
  const lockPath = path.join(backupDir, '.backup.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, token: 'owned-by-another-run' }), { mode: 0o600 });
  const locked = spawnSync(process.execPath, ['scripts/backup.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /backup already running/);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'owned-by-another-run');
  fs.unlinkSync(lockPath);

  const run = spawnSync(process.execPath, ['scripts/backup.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const archiveName = fs.readdirSync(backupDir).find(name => name.endsWith('.db.gz.enc'));
  const manifestName = fs.readdirSync(backupDir).find(name => name.endsWith('.manifest.json'));
  assert.ok(archiveName && manifestName);
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(backupDir, archiveName)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(backupDir, manifestName)).mode & 0o777, 0o600);

  const archive = fs.readFileSync(path.join(backupDir, archiveName));
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, manifestName), 'utf8'));
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(archive).digest('hex'));
  assert.equal(manifest.source_database, path.basename(dbPath));
  assert.equal(manifest.key_included, false);

  const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, archive.subarray(0, 12));
  decipher.setAuthTag(archive.subarray(12, 28));
  const restoredBytes = zlib.gunzipSync(Buffer.concat([decipher.update(archive.subarray(28)), decipher.final()]));
  const restoredPath = path.join(temp, 'restored.db');
  fs.writeFileSync(restoredPath, restoredBytes, { mode: 0o600 });
  const restored = new Database(restoredPath, { readonly: true });
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(restored.prepare('SELECT value FROM canary').get().value, 'configured DB_PATH was backed up');
  restored.close();
});
