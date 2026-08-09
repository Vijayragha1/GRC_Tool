'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootApp, makeClient } = require('./helpers');
const mfa = require('../lib/mfa');

test('TOTP verifies within the clock window and rejects replay', () => {
  const secret = mfa.generateSecret();
  const now = 1_800_000_000_000;
  const counter = Math.floor(now / 1000 / mfa.STEP_SECONDS);
  const token = mfa.tokenForCounter(secret, counter);
  assert.equal(mfa.verifyTotp(secret, token, { now, lastCounter: -1 }), counter);
  assert.equal(mfa.verifyTotp(secret, token, { now, lastCounter: counter }), null);
});

test('recovery codes are hashed, one-time, and consumed atomically', () => {
  const [code] = mfa.generateRecoveryCodes(1);
  const stored = JSON.stringify([mfa.hashRecoveryCode(code)]);
  const consumed = mfa.consumeRecoveryCode(stored, code.toLowerCase());
  assert.equal(consumed, '[]');
  assert.equal(mfa.consumeRecoveryCode(consumed, code), null);
});

test('password login for an enrolled user requires the second factor', async () => {
  const previousRequired = process.env.REQUIRE_MFA;
  process.env.REQUIRE_MFA = '1';
  const env = bootApp();
  const db = new Database(env.dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const secret = mfa.generateSecret();
  const enc = require('../lib/encryption');
  const password = 'mfa-test-password-1234';
  const userId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active,mfa_secret,mfa_enabled_at,mfa_recovery_codes,mfa_last_counter)
    VALUES ('mfa-user@example.com',?,'MFA User','firm',?,'consultant',1,?,CURRENT_TIMESTAMP,'[]',-1)`)
    .run(bcrypt.hashSync(password, 4), firmId, enc.encrypt(secret, 'mfa:999999')).lastInsertRowid);
  db.prepare('UPDATE users SET mfa_secret=? WHERE id=?').run(enc.encrypt(secret, `mfa:${userId}`), userId);
  const client = makeClient(env.app);
  try {
    const loginPage = await client.get('/login');
    const loginCsrf = (loginPage.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
    const passwordResult = await client.post('/login', { email: 'mfa-user@example.com', password, _csrf: loginCsrf }, { csrf: false });
    assert.equal(passwordResult.status, 302);
    assert.equal(passwordResult.location, '/mfa/verify');
    const challenge = await client.get('/mfa/verify');
    assert.match(challenge.text, /Verify it’s you/);
    const csrf = (challenge.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
    const counter = Math.floor(Date.now() / 1000 / mfa.STEP_SECONDS);
    const verified = await client.post('/mfa/verify', { code: mfa.tokenForCounter(secret, counter), _csrf: csrf }, { csrf: false });
    assert.equal(verified.status, 302);
    assert.equal(verified.location, '/dashboard');
    assert.equal((await client.get('/dashboard')).status, 200);
  } finally {
    await client.close();
    db.close();
    if (previousRequired === undefined) delete process.env.REQUIRE_MFA;
    else process.env.REQUIRE_MFA = previousRequired;
  }
});
