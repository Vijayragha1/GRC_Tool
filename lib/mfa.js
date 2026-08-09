'use strict';

// RFC 6238 TOTP with replay protection plus one-time recovery codes. Secrets
// are encrypted by the caller before persistence; recovery codes are stored
// only as SHA-256 hashes and are shown once during enrolment.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(value) {
  const clean = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 secret');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function counterBuffer(counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

function tokenForCounter(secret, counter) {
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer(counter)).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function verifyTotp(secret, submitted, options = {}) {
  const token = String(submitted || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const now = options.now == null ? Date.now() : options.now;
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  const lastCounter = Number.isFinite(Number(options.lastCounter)) ? Number(options.lastCounter) : -1;
  const window = options.window == null ? 1 : Number(options.window);
  for (let delta = -window; delta <= window; delta++) {
    const counter = current + delta;
    if (counter <= lastCounter) continue;
    const expected = tokenForCounter(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return counter;
  }
  return null;
}

function normaliseRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(value) {
  return crypto.createHash('sha256').update(normaliseRecoveryCode(value)).digest('hex');
}

function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

function consumeRecoveryCode(storedJson, submitted) {
  let hashes = [];
  try { hashes = JSON.parse(storedJson || '[]'); } catch (_) { hashes = []; }
  const candidate = hashRecoveryCode(submitted);
  const index = hashes.findIndex(hash => typeof hash === 'string' && hash.length === candidate.length &&
    crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(candidate)));
  if (index < 0) return null;
  hashes.splice(index, 1);
  return JSON.stringify(hashes);
}

function otpauthUri({ secret, email, issuer = 'Compliance Sphere' }) {
  const label = `${issuer}:${email}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

module.exports = {
  STEP_SECONDS, generateSecret, tokenForCounter, verifyTotp,
  generateRecoveryCodes, hashRecoveryCode, consumeRecoveryCode, otpauthUri,
  base32Encode, base32Decode
};
