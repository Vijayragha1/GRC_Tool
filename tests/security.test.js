// Security tests: CSRF rejection, XSS roundtrip, auth gating.
//
// Run: node --test tests/security.test.js
//
// These boot the real server in-process (no spawn) against a tmp DB so each
// test owns isolated state. Auth is currently disabled — the auth tests
// exercise the route shape so they keep working when auth is turned on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient } = require('./helpers');

test('CSRF — POST without token is rejected with 403', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  // Use opts.csrf=false to suppress auto-injection.
  const r = await client.post('/tenants', { name: 'EvilCorp' }, { csrf: false });
  assert.equal(r.status, 403);
  assert.match(r.text, /CSRF token missing or invalid/);
});

test('CSRF — POST with wrong token is rejected with 403', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.post('/tenants', { name: 'EvilCorp', _csrf: 'deadbeef' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('CSRF — POST with correct token + cookie is accepted', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.post('/tenants', { name: 'LegitCorp' });
  // Successful tenant creation redirects to /onboarding.
  assert.equal(r.status, 302);
  assert.match(r.location, /\/onboarding/);
});

test('CSRF — GET requests do not require a token (safe method)', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  for (const url of ['/dashboard', '/tenants', '/glossary']) {
    const r = await client.get(url);
    assert.equal(r.status, 200, `GET ${url} returned ${r.status}`);
  }
});

test('CSRF — token is exposed in <meta name="csrf-token">', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.get('/dashboard');
  const m = r.text.match(/name="csrf-token" content="([a-f0-9]+)"/);
  assert.ok(m, 'meta tag must include csrf token');
  assert.equal(m[1].length, 64, 'token should be 64 hex chars');
});

test('CSRF — token is stable across the same session', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const a = await client.get('/dashboard');
  const b = await client.get('/glossary');
  const ta = a.text.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
  const tb = b.text.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
  assert.equal(ta, tb, 'token must persist for the lifetime of the session');
});

test('CSRF — different sessions get different tokens', async (t) => {
  const { client: c1 } = await bootClient();
  const { client: c2 } = await bootClient();
  t.after(async () => { await c1.close(); await c2.close(); });

  const t1 = c1.getCsrfToken();
  const t2 = c2.getCsrfToken();
  assert.notEqual(t1, t2, 'sessions must not share tokens');
});

test('XSS — script tag in tenant name is escaped on render', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const payload = '<script>window.__pwn=true</script>';
  const post = await client.post('/tenants', { name: payload });
  assert.equal(post.status, 302);

  // The new tenant page lists tenants in an HTML table. The script tag must
  // be escaped — appear as &lt; not <.
  const list = await client.get('/tenants');
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(payload), 'raw script tag must not render');
  assert.ok(list.text.includes('&lt;script&gt;'), 'angle brackets must be escaped');
});

test('XSS — event-handler attribute payload is escaped', async (t) => {
  const { client } = await bootClient();
  t.after(() => client.close());

  const payload = '" onclick="window.__pwn=true"';
  const post = await client.post('/tenants', { name: 'X' + payload });
  assert.equal(post.status, 302);

  const list = await client.get('/tenants');
  // The payload's quote-and-attribute must not break out of the value="" attribute.
  assert.ok(!/value="X"\s+onclick=/.test(list.text), 'attribute injection must be neutralised');
});

test('Auth — default user lookup never returns null on bare-DB fallback', async (t) => {
  // Auth is disabled per README; the fallback in currentUser must always
  // resolve a user so requireAuth doesn't 500. This test pins that contract.
  const { client } = await bootClient();
  t.after(() => client.close());

  const r = await client.get('/dashboard');
  assert.equal(r.status, 200, 'default-user fallback must succeed on a fresh DB');
  assert.ok(!/No default user found/.test(r.text), 'must not show no-user error');
});
