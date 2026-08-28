'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { discoverTestFiles, groupTests } = require('../scripts/run-tests');

const ROOT = path.resolve(__dirname, '..');

test('the primary test command uses suite discovery', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.js');
});

test('every tests/*.test.js suite is assigned exactly once', () => {
  const discovered = discoverTestFiles();
  const groups = groupTests(discovered);
  const assigned = Object.values(groups).flat().map(file => path.basename(file));

  assert.ok(discovered.length > 0);
  assert.deepEqual(assigned.slice().sort(), discovered);
  assert.equal(new Set(assigned).size, discovered.length);
  assert.ok(discovered.includes('vciso-onboarding.test.js'));
});
