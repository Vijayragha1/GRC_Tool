#!/usr/bin/env node
'use strict';

// Discover every repository test suite instead of maintaining a long list in
// package.json. Feature families run in separate Node test invocations to keep
// their database fixtures isolated, while the two legacy end-to-end walkers
// remain standalone processes because they manage their own server lifecycle.
//
// Every group runs even after an earlier one fails: stopping at the first red
// group hides the state of every group behind it, so a single known failure
// used to leave DPDPA, TPRM and the standalone walkers completely unmeasured.
// Results are collected, summarised per group, and the process exits non-zero
// if any group failed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(PROJECT_ROOT, 'tests');
const STANDALONE = new Set(['routes.test.js', 'smoke.test.js']);

function discoverTestFiles(testsDir = TESTS_DIR) {
  return fs.readdirSync(testsDir)
    .filter(name => name.endsWith('.test.js'))
    .sort();
}

function groupFor(name) {
  if (STANDALONE.has(name)) return 'standalone';
  if (name.startsWith('dpdpa-')) return 'dpdpa';
  if (name.startsWith('tprm-')) return 'tprm';
  return 'core';
}

function groupTests(files) {
  const groups = { core: [], standalone: [], dpdpa: [], tprm: [] };
  for (const name of files) groups[groupFor(name)].push(path.join('tests', name));
  return groups;
}

function run(command, args, label) {
  console.log(`\n[test] ${label}`);
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[test] ${label} could not start: ${result.error.message}`);
    return 1;
  }
  return result.status == null ? 1 : result.status;
}

// The spec reporter stays on stdout for a human; a second TAP reporter writes
// to a scratch file purely so the per-group pass/fail counts can be summarised
// without re-parsing the console output.
function parseTapCounts(tapPath) {
  let text;
  try { text = fs.readFileSync(tapPath, 'utf8'); } catch (_) { return null; }
  const total = count => {
    const matches = text.match(new RegExp(`^# ${count} (\\d+)$`, 'gm')) || [];
    return matches.reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
  };
  return { pass: total('pass'), fail: total('fail'), cancelled: total('cancelled') };
}

function runNodeTests(label, files) {
  if (!files.length) {
    console.error(`[test] no ${label} suites were discovered`);
    return { label, suites: 0, pass: 0, fail: 0, status: 1 };
  }
  const concurrency = process.env.TEST_CONCURRENCY || '4';
  const tapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grc-test-')), `${label}.tap`);
  const status = run(process.execPath, [
    '--test',
    '--test-force-exit',
    `--test-concurrency=${concurrency}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=tap',
    `--test-reporter-destination=${tapPath}`,
    ...files,
  ], `${label}: ${files.length} suite(s)`);
  const counts = parseTapCounts(tapPath);
  try { fs.rmSync(path.dirname(tapPath), { recursive: true, force: true }); } catch (_) {}
  // A crashed run can exit non-zero with no usable TAP; never report it green.
  const fail = counts ? counts.fail + counts.cancelled : (status === 0 ? 0 : 1);
  return { label, suites: files.length, pass: counts ? counts.pass : 0, fail, status };
}

// The legacy walkers manage their own server and print their own results, so
// they are only measured at suite granularity.
function runStandalone(suites) {
  if (!suites.length) {
    console.error('[test] no standalone suites were discovered');
    return { label: 'standalone', suites: 0, pass: 0, fail: 0, status: 1 };
  }
  let pass = 0, fail = 0, status = 0;
  for (const suite of suites) {
    const suiteStatus = run(process.execPath, [suite], `standalone: ${suite}`);
    if (suiteStatus === 0) pass++; else { fail++; status = suiteStatus; }
  }
  return { label: 'standalone', suites: suites.length, pass, fail, status };
}

function pad(value, width, left = false) {
  const text = String(value);
  return left ? text.padStart(width) : text.padEnd(width);
}

function reportSummary(results) {
  const nameWidth = Math.max(10, ...results.map(r => r.label.length));
  console.log(`\n[test] ${'='.repeat(20)} summary ${'='.repeat(20)}`);
  for (const r of results) {
    console.log(`[test] ${pad(r.label, nameWidth)}  ${pad(r.suites, 4, true)} suite(s)  ${pad(r.pass, 5, true)} pass  ${pad(r.fail, 5, true)} fail  ${r.status === 0 ? 'ok' : 'FAILED'}`);
  }
  const totals = results.reduce((acc, r) => ({
    suites: acc.suites + r.suites, pass: acc.pass + r.pass, fail: acc.fail + r.fail,
  }), { suites: 0, pass: 0, fail: 0 });
  const failedGroups = results.filter(r => r.status !== 0).map(r => r.label);
  console.log(`[test] ${pad('TOTAL', nameWidth)}  ${pad(totals.suites, 4, true)} suite(s)  ${pad(totals.pass, 5, true)} pass  ${pad(totals.fail, 5, true)} fail  ${failedGroups.length ? `FAIL (${failedGroups.join(', ')})` : 'PASS'}`);
  return failedGroups.length ? 1 : 0;
}

// Runners are injectable so the "a failing group never stops a later group"
// contract can be tested without spawning 121 suites.
function main({ runGroup = runNodeTests, runStandaloneGroup = runStandalone } = {}) {
  const files = discoverTestFiles();
  if (!files.length) {
    console.error('[test] no tests/*.test.js files were discovered; refusing to pass');
    return 1;
  }

  const groups = groupTests(files);
  const assigned = Object.values(groups).flat();
  if (assigned.length !== files.length || new Set(assigned).size !== files.length) {
    console.error('[test] discovery assigned a suite more or less than once');
    return 1;
  }

  console.log(`[test] discovered ${files.length} suite(s)`);
  const results = [];
  for (const [label, suites] of [
    ['core', groups.core],
    ['DPDPA', groups.dpdpa],
    ['TPRM', groups.tprm],
  ]) {
    results.push(runGroup(label, suites));
  }
  results.push(runStandaloneGroup(groups.standalone));
  return reportSummary(results);
}

if (require.main === module) process.exitCode = main();

module.exports = { discoverTestFiles, groupFor, groupTests, main, parseTapCounts, reportSummary, STANDALONE };
