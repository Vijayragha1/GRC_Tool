#!/usr/bin/env node
'use strict';
// Regenerates migrations/CHECKSUMS.json. Run this after ADDING a migration.
//
// Do not run it to silence a failure in tests/migration-checksums.test.js on a
// migration that already shipped. That failure means an applied migration was
// edited, and deployed databases will refuse to start on the drift. Restore the
// original bytes and add a new forward migration instead.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'migrations');
const MANIFEST = path.join(DIR, 'CHECKSUMS.json');

const files = fs.readdirSync(DIR).filter((f) => /^\d+.*\.(?:sql|js)$/.test(f)).sort();
const existing = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};

const next = {};
const changed = [];
for (const file of files) {
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(DIR, file), 'utf8'))
    .digest('hex');
  if (existing[file] && existing[file] !== hash) changed.push(file);
  next[file] = hash;
}

if (changed.length) {
  console.error('Refusing to repin. These already-pinned migrations changed:');
  for (const f of changed) console.error(`  ${f}`);
  console.error('\nA deployed database has applied them at their old checksum and will');
  console.error('refuse to start. Restore the original bytes and add a new forward');
  console.error('migration. If you are certain this is intentional, delete the entry by');
  console.error('hand and document why.');
  process.exit(1);
}

fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
const added = files.filter((f) => !existing[f]);
console.log(`Pinned ${files.length} migrations` + (added.length ? `, ${added.length} new: ${added.join(', ')}` : ', no new files'));
