'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { discoverTestFiles, groupTests, main, parseTapCounts, reportSummary } = require('../scripts/run-tests');

const ROOT = path.resolve(__dirname, '..');

function silently(fn) {
  const log = console.log, error = console.error, lines = [];
  console.log = console.error = (...args) => lines.push(args.join(' '));
  try { return { value: fn(), lines }; } finally { console.log = log; console.error = error; }
}

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

test('a failing group never stops a later group from running', () => {
  const ran = [];
  const stub = (label, suites) => {
    ran.push(label);
    // core fails; every later group must still be measured.
    return label === 'core'
      ? { label, suites: suites.length, pass: 629, fail: 4, status: 1 }
      : { label, suites: suites.length, pass: suites.length, fail: 0, status: 0 };
  };
  const { value, lines } = silently(() => main({
    runGroup: stub,
    runStandaloneGroup: suites => stub('standalone', suites),
  }));

  assert.deepEqual(ran, ['core', 'DPDPA', 'TPRM', 'standalone']);
  assert.equal(value, 1, 'a failed group must exit non-zero');
  const summary = lines.join('\n');
  for (const group of ['core', 'DPDPA', 'TPRM', 'standalone']) assert.match(summary, new RegExp(`^\\[test\\] ${group}\\s`, 'm'));
  assert.match(summary, /^\[test\] core\s+\d+ suite\(s\)\s+629 pass\s+4 fail\s+FAILED$/m);
  assert.match(summary, /^\[test\] TOTAL\s+\d+ suite\(s\)\s+\d+ pass\s+4 fail\s+FAIL \(core\)$/m);
});

test('the runner reports PASS and exits zero only when every group passed', () => {
  const ok = (label, suites) => ({ label, suites: suites.length, pass: suites.length, fail: 0, status: 0 });
  const { value, lines } = silently(() => main({ runGroup: ok, runStandaloneGroup: suites => ok('standalone', suites) }));
  assert.equal(value, 0);
  assert.match(lines.join('\n'), /^\[test\] TOTAL\s+\d+ suite\(s\)\s+\d+ pass\s+0 fail\s+PASS$/m);
});

test('an empty group still refuses to pass', () => {
  const { value, lines } = silently(() => reportSummary([
    { label: 'core', suites: 0, pass: 0, fail: 0, status: 1 },
  ]));
  assert.equal(value, 1);
  assert.match(lines.join('\n'), /FAIL \(core\)/);
});

test('group pass and fail counts come from the TAP summary the run wrote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-counts-'));
  const tapPath = path.join(dir, 'core.tap');
  fs.writeFileSync(tapPath, [
    '# Subtest: something',
    'ok 1 - something',
    '# tests 10', '# suites 0', '# pass 7', '# fail 2', '# cancelled 1',
    '# skipped 0', '# todo 0', '# duration_ms 12.5', '',
  ].join('\n'));
  assert.deepEqual(parseTapCounts(tapPath), { pass: 7, fail: 2, cancelled: 1 });
  assert.equal(parseTapCounts(path.join(dir, 'missing.tap')), null, 'a run that wrote no TAP is not reported as green');
  fs.rmSync(dir, { recursive: true, force: true });
});
