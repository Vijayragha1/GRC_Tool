'use strict';
// Guards the one failure mode that the rest of the suite structurally cannot
// see. Every other test builds a pristine database, so a migration applies for
// the first time and its checksum always matches. A deployed database has
// already recorded the checksum of every migration it ran, and
// migrations/run.js is fail-closed on drift: change one byte of an applied
// migration and the app refuses to start. That is a total outage, not a
// degraded feature, and it reaches production green.
//
// This happened. A single trailing newline was appended to
// 039_supplier_methodology_governance.sql, which changed its sha256 from
// a3a74002... to 9a1d7cc5... and took the Lightsail deployment down with a 502
// while all 359 tests passed.
//
// migrations/CHECKSUMS.json pins the hash of every migration. Editing a
// released migration fails here instead of at boot on the server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'migrations');
const MANIFEST = path.join(DIR, 'CHECKSUMS.json');

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, file), 'utf8')).digest('hex');

const migrationFiles = () =>
  fs.readdirSync(DIR).filter((f) => /^\d+.*\.(?:sql|js)$/.test(f)).sort();

test('no released migration has been edited since it was pinned', () => {
  const pinned = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const drifted = [];
  for (const [file, expected] of Object.entries(pinned)) {
    if (!fs.existsSync(path.join(DIR, file))) {
      drifted.push(`${file}: deleted, but a deployed database has already applied it`);
      continue;
    }
    const actual = sha256(file);
    if (actual !== expected) {
      drifted.push(`${file}: pinned ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}`);
    }
  }
  assert.deepStrictEqual(
    drifted,
    [],
    'A migration that deployed databases have already applied was modified.\n' +
      'migrations/run.js refuses to start on checksum drift, so this would 502 in\n' +
      'production while every other test stays green. Restore the original bytes\n' +
      'and put the change in a new forward migration instead:\n  ' +
      drifted.join('\n  ')
  );
});

test('every migration on disk is pinned', () => {
  const pinned = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const missing = migrationFiles().filter((f) => !(f in pinned));
  assert.deepStrictEqual(
    missing,
    [],
    'New migrations must be added to migrations/CHECKSUMS.json so they are\n' +
      'protected from later edits. Regenerate with:\n' +
      '  node scripts/pin-migration-checksums.js\n  ' +
      missing.join('\n  ')
  );
});
