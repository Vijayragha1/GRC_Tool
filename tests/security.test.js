// Security tests: CSRF rejection, XSS roundtrip, auth gating.
//
// Run: node --test tests/security.test.js
//
// These boot the real server in-process (no spawn) against a tmp DB so each
// test owns isolated state. Auth is enforced now: the harness logs in (see
// bootClient in helpers.js), and these tests exercise the live CSRF / XSS /
// auth controls against an authenticated session.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { bootApp, bootClient, makeClient } = require('./helpers');
const { sanitizeDocumentHtml } = require('../lib/document-html');

test('document HTML sanitizer removes executable and remote-content payloads while preserving controlled prose', () => {
  const clean = sanitizeDocumentHtml(`<h2>Controlled policy</h2>
    <script>window.pwned=1</script>
    <p onclick="window.pwned=2" style="color:#123456;background-image:url(https://tracker.invalid/pixel)">Body</p>
    <a href="javascript:window.pwned=3">unsafe link</a>
    <img src="https://tracker.invalid/pixel.png" onerror="window.pwned=4">
    <iframe src="https://attacker.invalid"></iframe>`);
  assert.match(clean, /<h2>Controlled policy<\/h2>/);
  assert.match(clean, /<p[^>]*>Body<\/p>/);
  assert.doesNotMatch(clean, /script|onclick|onerror|javascript:|iframe|tracker\.invalid|attacker\.invalid|background-image/i);
});

test('Public trust path explains evaluation, access, security, privacy, and disclosure before sign-in', async (t) => {
  const { app, dbPath } = bootApp();
  const client = makeClient(app);
  t.after(() => client.close());

  const conn = new Database(dbPath);
  conn.prepare(`INSERT INTO firms (name) VALUES (?)`).run('PRIVATE-TENANT-CANARY');
  conn.close();

  const expected = new Map([
    ['/', /Request an evaluation/],
    ['/register', /Access starts with an invitation/],
    ['/security', /Security boundaries should be testable/],
    ['/privacy', /Privacy responsibilities are shared/],
    ['/terms', /does not itself certify conformity/],
    ['/contact', /Start with the workflow you need to test/],
  ]);
  for (const [url, marker] of expected) {
    const response = await client.get(url);
    assert.equal(response.status, 200, `${url} should be public`);
    assert.match(response.text, marker, `${url} should provide its promised next step`);
    assert.doesNotMatch(response.text, /PRIVATE-TENANT-CANARY/, `${url} must not expose tenant data`);
  }

  const disclosure = await client.get('/.well-known/security.txt');
  assert.equal(disclosure.status, 200);
  assert.match(String(disclosure.headers['content-type']), /^text\/plain/);
  assert.match(disclosure.text, /^Contact: /m);
  assert.match(disclosure.text, /^Expires: /m);
  assert.match(disclosure.text, /^Policy: /m);
});

test('CSRF - POST without token is rejected with 403', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  // Use opts.csrf=false to suppress auto-injection.
  const r = await client.post('/tenants', { name: 'EvilCorp' }, { csrf: false });
  assert.equal(r.status, 403);
  assert.match(r.text, /CSRF token missing or invalid/);
});

test('CSRF - POST with wrong token is rejected with 403', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.post('/tenants', { name: 'EvilCorp', _csrf: 'deadbeef' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('CSRF - authenticated state-changing POST is rejected without a token and accepted with one', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  // The control must FIRE for an authenticated request. A state-changing POST
  // with no token is rejected by CSRF (the body proves it is CSRF, not auth).
  const noToken = await client.post('/tenants', { name: 'NoTokenCorp' }, { csrf: false });
  assert.equal(noToken.status, 403, 'authenticated POST without a CSRF token must be 403');
  assert.match(noToken.text, /CSRF token missing or invalid/, 'rejection must come from CSRF, not auth');
  assert.doesNotMatch(noToken.text, /auth_required/, 'must not be an auth (401) failure masquerading as a CSRF pass');

  // The same request WITH the auto-injected token is accepted.
  const withToken = await client.post('/tenants', { name: 'LegitCorp' });
  assert.equal(withToken.status, 302);
  assert.match(withToken.location, /\/onboarding/);
});

test('CSRF - safe GET requests do not require a token', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  for (const url of ['/dashboard', '/tenants', '/glossary']) {
    const r = await client.get(url);
    assert.equal(r.status, 200, `GET ${url} returned ${r.status}`);
  }
});

test('CSRF - token is exposed as a 64-hex meta tag on rendered pages', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.get('/dashboard');
  const m = r.text.match(/name="csrf-token" content="([a-f0-9]+)"/);
  assert.ok(m, 'meta tag must include csrf token');
  assert.equal(m[1].length, 64, 'token should be 64 hex chars');
});

test('CSRF - token is stable across requests in the same session', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const a = await client.get('/dashboard');
  const b = await client.get('/glossary');
  const ta = (a.text.match(/name="csrf-token" content="([a-f0-9]+)"/) || [])[1];
  const tb = (b.text.match(/name="csrf-token" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(ta && tb, 'both pages must expose a token');
  assert.equal(ta, tb, 'token must persist for the lifetime of the session');
});

test('CSRF - different sessions get different tokens', async (t) => {
  const { client: c1 } = await bootClient();
  const { client: c2 } = await bootClient();
  t.after(async () => { await c1.close(); await c2.close(); });

  const t1 = c1.getCsrfToken();
  const t2 = c2.getCsrfToken();
  assert.ok(t1 && t1.length === 64, 'session 1 must have a 64-hex token');
  assert.ok(t2 && t2.length === 64, 'session 2 must have a 64-hex token');
  assert.notEqual(t1, t2, 'sessions must not share tokens');
});

test('XSS - a script payload in a client name is HTML-escaped on render', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  // Distinctive canary: the XSSCANARY marker survives escaping (so we can prove
  // the name was actually rendered, not silently dropped), while the <script>
  // proves neutralisation. The client list on /dashboard is a surface the test
  // user genuinely sees (unlike /tenants firm creation, which the original test
  // posted to but never rendered for a normal user - a false pass waiting to happen).
  const CANARY = 'XSSCANARY<script>window.__xss_canary=1</script>END';
  const post = await client.post('/workspaces', { client_name: CANARY, name: CANARY, industry: 'T', frameworks: 'iso27001', engagement_outcome: 'certification_support' });
  assert.equal(post.status, 302, 'client creation should redirect');

  const dash = await client.get('/dashboard');
  assert.equal(dash.status, 200);
  // (a) the raw executable payload must never reach the response. The marker is
  //     distinctive enough that a partial-strip bypass (e.g. <scr<script>ipt>)
  //     would still leave a raw "<script" for this substring check to catch.
  assert.ok(!dash.text.includes('<script>window.__xss_canary'), 'raw script must not render');
  // (b) the name must be present AND escaped - so the test fails if escaping is
  //     dropped OR the surface silently stops rendering user input.
  assert.ok(dash.text.includes('XSSCANARY'), 'the client name must be rendered');
  assert.ok(dash.text.includes('&lt;script&gt;'), 'angle brackets must be HTML-escaped');
});

test('XSS - an attribute-breakout payload in a client name cannot escape its element', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const CANARY = 'XSSATTR" onclick="window.__xss_pwn=1"';
  const post = await client.post('/workspaces', { client_name: CANARY, name: CANARY, industry: 'T', frameworks: 'iso27001', engagement_outcome: 'certification_support' });
  assert.equal(post.status, 302);

  const dash = await client.get('/dashboard');
  assert.ok(dash.text.includes('XSSATTR'), 'the client name must be rendered');
  // The raw event handler must never appear as live markup, and the quote that
  // would start a new attribute must be HTML-escaped (EJS emits &#34;).
  assert.ok(!/onclick="window\.__xss_pwn/.test(dash.text), 'attribute injection must be neutralised');
  assert.ok(dash.text.includes('&quot;') || dash.text.includes('&#34;') || dash.text.includes('&#x22;'), 'the breakout quote must be HTML-escaped');
});

test('Workspace creation preserves an intentionally empty programme selection', async (t) => {
  const { client, dbPath } = await bootClient();
  t.after(() => client.close());
  const created = await client.post('/workspaces', { client_name:'Programme Pending Client', industry:'Technology', scope:'Programme selection remains under client discussion.', engagement_outcome:'certification_support' });
  assert.equal(created.status,302);
  const conn = new Database(dbPath);
  const workspace = conn.prepare(`SELECT id,frameworks FROM workspaces WHERE client_name='Programme Pending Client'`).get();
  assert.equal(workspace.frameworks,'[]');
  conn.close();
  const overview = await client.get(`/workspaces/${workspace.id}`);
  assert.equal(overview.status,200,overview.text.slice(0,500));
  assert.match(overview.text,/Programme decision pending/);
  assert.doesNotMatch(overview.text,/ISO 27001 programme|Stage 1 maturity/);
});

test('Workspace deletion removes a populated client while restoring immutable-history guards', async (t) => {
  const { client, dbPath } = await bootClient();
  t.after(() => client.close());

  const created = await client.post('/workspaces', {
    client_name: 'Deletion Regression Client',
    industry: 'Technology',
    scope: 'A disposable workspace containing governed history.',
    frameworks: 'iso27001',
    engagement_outcome: 'certification_support',
  });
  assert.equal(created.status, 302);

  const conn = new Database(dbPath);
  const workspace = conn.prepare(`SELECT id FROM workspaces WHERE client_name=?`).get('Deletion Regression Client');
  const user = conn.prepare(`SELECT id FROM users WHERE email=?`).get('sec-test@example.com');
  const snapshot = JSON.stringify({ workspaceId: workspace.id, covered: 1 });
  conn.prepare(`INSERT INTO gap_fieldwork_snapshots
    (workspace_id,week_ending,requirements_covered,requirements_total,interviews_completed,
     interviews_planned,requests_received,requests_total,active_blockers,declared_defaults,
     snapshot_json,snapshot_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(workspace.id, '2026-08-16', 1, 118, 1, 2, 1, 3, 0, 0,
      snapshot, crypto.createHash('sha256').update(snapshot).digest('hex'), user.id);

  assert.throws(
    () => conn.prepare(`DELETE FROM gap_fieldwork_snapshots WHERE workspace_id=?`).run(workspace.id),
    /fieldwork snapshots are immutable/,
    'ordinary history deletion must remain blocked before the workspace purge'
  );
  conn.close();

  const deleted = await client.post(`/workspaces/${workspace.id}/delete`, {
    confirm_name: 'Deletion Regression Client',
  });
  assert.equal(deleted.status, 302, deleted.text.slice(0, 500));
  assert.match(deleted.location, /^\/dashboard\?/);

  const verify = new Database(dbPath);
  assert.equal(verify.prepare(`SELECT COUNT(*) c FROM workspaces WHERE id=?`).get(workspace.id).c, 0);
  assert.equal(verify.prepare(`SELECT COUNT(*) c FROM gap_fieldwork_snapshots WHERE workspace_id=?`).get(workspace.id).c, 0);
  assert.ok(verify.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_gap_snapshot_no_delete'`).get(),
    'immutable-history trigger must be restored before commit');
  assert.deepEqual(verify.pragma('foreign_key_check'), []);
  verify.close();
});

test('Auth - protected pages require authentication (no default-user bypass)', async (t) => {
  // The old assertion pinned a no-auth "default user" fallback so /dashboard
  // returned 200 without logging in. That bypass was removed when real
  // email/password auth was enabled (currentUser returns null with no session).
  // This test now proves auth is ENFORCED: an unauthenticated request is
  // challenged, and an authenticated one is served.
  const { client, app } = await bootClient();
  t.after(() => client.close());

  // Authenticated session works and shows no "no user" error.
  const authed = await client.get('/dashboard');
  assert.equal(authed.status, 200, 'authenticated dashboard must render');
  assert.ok(!/No default user found/.test(authed.text), 'must not show a no-user error');
  assert.match(authed.text, /id="pageLoader"/, 'protected app shell must include the branded page loader');
  assert.match(authed.text, /page-loader\.js\?v=/, 'protected app shell must load the transition controller');
  assert.match(authed.text, /class="skip-link"[^>]*>Skip to content</, 'protected app shell must offer a keyboard skip link');
  assert.match(authed.text, /site-enhancements\.js\?v=/, 'protected app shell must load the shared interaction layer');
  assert.match(authed.text, /data-theme-toggle/, 'protected app shell must expose the theme control');
  const authedRoot = await client.get('/');
  assert.equal(authedRoot.status, 302, 'signed-in users should go directly to their dashboard');
  assert.equal(authedRoot.location, '/dashboard');

  // A fresh, unauthenticated client on the same app must be redirected to login.
  // Regression guard: if a default-user bypass is ever reintroduced, this 200s.
  const anon = makeClient(app);
  t.after(() => anon.close());
  const r = await anon.get('/dashboard');
  assert.equal(r.status, 302, 'unauthenticated dashboard must redirect, not serve a default user');
  assert.match(r.location, /\/login/, 'must redirect to /login');
  const login = await anon.get('/login');
  assert.equal(login.status, 200);
  assert.match(login.text, /id="pageLoader"/, 'authentication shell must include the branded page loader');
  assert.match(login.text, /page-loader\.css\?v=/, 'authentication shell must load the loader presentation');
});

test('Auth - logout crosses the view-transition boundary without retaining the authenticated session', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const logout = await client.post('/logout');
  assert.equal(logout.status, 302);
  assert.equal(logout.location, '/login?signed_out=1');

  const signedOut = await client.get(logout.location);
  assert.equal(signedOut.status, 200);
  assert.match(signedOut.text, /You have been signed out\./);
  assert.match(signedOut.text, /<meta name="view-transition" content="same-origin"\s*\/?>/,
    'logout destination must share the protected shell transition contract');
  assert.match(signedOut.text, /@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/,
    'logout destination must opt into cross-document transitions');
  assert.match(signedOut.text, /::view-transition-old\(root\)[\s\S]*animation-duration:\s*0s/,
    'the auth boundary must not cross-fade the previously authenticated page');

  const protectedPage = await client.get('/dashboard');
  assert.equal(protectedPage.status, 302, 'the destroyed session must not retain protected access');
  assert.match(protectedPage.location, /^\/login/);
});

test('Auth - legacy MFA account data cannot trigger a second-factor challenge', async (t) => {
  const { app, dbPath } = bootApp();
  const db = new Database(dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const password = 'password-only-login-1234';
  db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active,mfa_secret,mfa_enabled_at,mfa_recovery_codes,mfa_last_counter)
    VALUES ('legacy-mfa@example.com',?,'Legacy MFA User','firm',?,'consultant',1,'legacy-secret',CURRENT_TIMESTAMP,'["legacy-code"]',42)`)
    .run(bcrypt.hashSync(password, 4), firmId);
  const client = makeClient(app);
  t.after(async () => { await client.close(); db.close(); });

  const loginPage = await client.get('/login');
  const csrf = (loginPage.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const signedIn = await client.post('/login', {
    email: 'legacy-mfa@example.com', password, _csrf: csrf
  }, { csrf: false });
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.location, '/dashboard');
  assert.equal((await client.get('/dashboard')).status, 200);
  assert.equal((await client.get('/mfa/verify')).status, 404);
  assert.equal((await client.get('/security/mfa/setup')).status, 404);
});
