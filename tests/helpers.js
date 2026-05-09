// Shared test helpers. Boots the express app in-process against a freshly
// seeded tmp DB, returns a small fetch-like client with cookie persistence
// and CSRF-token auto-injection. Each test file owns its own DB and port,
// so tests can run in parallel with no cross-contamination.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let _portCursor = 14000;

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
  Object.keys(require.cache).filter(k => k.includes('/iso27001-tool/')).forEach(k => delete require.cache[k]);
  const { app } = require('../server.js');
  return { app, tmpDir, dbPath };
}

function makeClient(app) {
  const port = ++_portCursor;
  const server = app.listen(port);
  let cookieJar = '';
  let csrfToken = null;

  async function request(method, urlPath, body, opts = {}) {
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
          const text = Buffer.concat(chunks).toString('utf8');
          // Persist any Set-Cookie back to the jar.
          const sc = res.headers['set-cookie'];
          if (sc) {
            const cookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
            const existing = cookieJar ? cookieJar.split('; ').filter(c => !cookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
            cookieJar = [...existing, ...cookies].join('; ');
          }
          // Snapshot the CSRF token from the meta tag if present.
          const m = text.match(/name="csrf-token" content="([a-f0-9]+)"/);
          if (m) csrfToken = m[1];
          resolve({
            status: res.statusCode,
            headers: res.headers,
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
    close: () => new Promise(r => server.close(r)),
    getCsrfToken: () => csrfToken,
    getCookies: () => cookieJar,
  };
}

// Convenience: boot + open client + warm CSRF token from /dashboard.
async function bootClient() {
  const { app, tmpDir, dbPath } = bootApp();
  const client = makeClient(app);
  await client.get('/dashboard'); // sets session cookie + csrf token
  return { client, tmpDir, dbPath };
}

module.exports = { bootApp, makeClient, bootClient };
