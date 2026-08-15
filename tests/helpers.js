// Shared test helpers. Boots the express app in-process against a freshly
// seeded tmp DB and returns a fetch-like client with cookie persistence and
// CSRF-token auto-injection. Each test file owns its own DB and port, so tests
// run in parallel with no cross-contamination.
//
// Auth is real and enforced now, so bootClient() seeds a known firm user and
// logs in: an unauthenticated client is redirected to /login and can never
// exercise the post-auth security controls (CSRF/XSS render surfaces). Tests
// that need an *unauthenticated* client build one directly with makeClient(app).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

function bootApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-test-'));
  const dbPath = path.join(tmpDir, 'iso27001.db');
  const keyPath = path.join(tmpDir, 'master.key');
  // Override env BEFORE require so server.js picks up the right DB / key paths.
  process.env.DB_PATH = dbPath;
  process.env.ISMS_KEY_FILE = keyPath;
  // Force a deterministic session secret so cookie scoping is stable.
  process.env.SESSION_SECRET = 'test-secret-' + crypto.randomBytes(4).toString('hex');
  // Bust the require cache so each boot gets a fresh module + DB.
  const PROJECT_ROOT = path.resolve(__dirname, '..');
  Object.keys(require.cache).filter(k => k.startsWith(PROJECT_ROOT)).forEach(k => delete require.cache[k]);
  const { app } = require('../server.js');
  return { app, tmpDir, dbPath };
}

function makeClient(app) {
  // Let the OS allocate an available loopback port. Node's test runner executes
  // files in separate processes, so a process-local counter can otherwise give
  // two suites the same port and produce a nondeterministic EADDRINUSE failure.
  const server = app.listen(0, '127.0.0.1');
  const listening = server.listening
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  let cookieJar = '';
  let csrfToken = null;

  async function request(method, urlPath, body, opts = {}) {
    await listening;
    const port = server.address().port;
    const headers = { ...(opts.headers || {}) };
    if (cookieJar) headers['cookie'] = cookieJar;
    let payload = null;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      // urlencoded by default; JSON if opts.json
      if (opts.json) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      } else {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        // Auto-attach CSRF token unless caller explicitly disabled it.
        if (csrfToken && opts.csrf !== false && !body._csrf) body._csrf = csrfToken;
        payload = new URLSearchParams(body).toString();
      }
    } else if (typeof body === 'string') {
      payload = body;
      if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, method, path: urlPath, headers,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          // Persist any Set-Cookie back to the jar.
          const sc = res.headers['set-cookie'];
          if (sc) {
            const cookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
            const existing = cookieJar ? cookieJar.split('; ').filter(c => !cookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
            cookieJar = [...existing, ...cookies].join('; ');
          }
          // Snapshot the CSRF token from the meta tag if present (authed pages only).
          const m = text.match(/name="csrf-token" content="([a-f0-9]+)"/);
          if (m) csrfToken = m[1];
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer,
            text,
            location: res.headers.location || null,
            cookies: cookieJar,
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    get: (p, opts) => request('GET', p, null, opts),
    post: (p, body, opts) => request('POST', p, body || {}, opts),
    delete: (p, opts) => request('DELETE', p, null, opts),
    close: () => new Promise(resolve => {
      // Force lingering keep-alive sockets closed so a completed integration
      // suite cannot hang indefinitely in its after hook.
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }),
    getCsrfToken: () => csrfToken,
    getCookies: () => cookieJar,
  };
}

// Seed a known firm-manager user in the freshly-booted DB and log `client` in.
// The login page exposes the CSRF token as a hidden `_csrf` input (it has no
// <meta> tag), so the login POST reads it from there; afterwards the token is
// warmed from an authenticated page's meta tag for subsequent POSTs.
async function authenticate(client, dbPath) {
  const email = 'sec-test@example.com';
  const password = 'sec-test-password-1234';
  const conn = new Database(dbPath);
  let firm = conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  if (!firm) { conn.prepare('INSERT INTO firms (name) VALUES (?)').run('Security Test Firm'); firm = conn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get(); }
  const hash = bcrypt.hashSync(password, 4); // low rounds: test speed
  const existing = conn.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) conn.prepare("UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?").run(hash, firm.id, existing.id);
  else conn.prepare("INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES (?, ?, 'Security Tester', ?, 'firm', 'manager', 1)").run(email, hash, firm.id);
  conn.close();

  const lg = await client.get('/login');
  const token = (lg.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await client.post('/login', { email, password, _csrf: token }, { csrf: false });
  if (res.status < 300 || res.status >= 400) throw new Error(`test login failed: expected 3xx, got ${res.status}`);
  await client.get('/dashboard'); // warm the meta token from an authed page
  return { email, password };
}

// Boot + open client + AUTHENTICATE + warm the CSRF token.
async function bootClient() {
  const { app, tmpDir, dbPath } = bootApp();
  const client = makeClient(app);
  const login = await authenticate(client, dbPath);
  return { client, app, tmpDir, dbPath, login };
}

module.exports = { bootApp, makeClient, bootClient, authenticate };
