#!/usr/bin/env node
'use strict';

// Discover every repository test suite instead of maintaining a long list in
// package.json. Feature families run in separate Node test invocations to keep
// their database fixtures isolated, while the two legacy end-to-end walkers
// remain standalone processes because they manage their own server lifecycle.

const fs = require('node:fs');
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

function runNodeTests(label, files) {
  if (!files.length) {
    console.error(`[test] no ${label} suites were discovered`);
    return 1;
  }
  const concurrency = process.env.TEST_CONCURRENCY || '4';
  return run(process.execPath, [
    '--test',
    '--test-force-exit',
    `--test-concurrency=${concurrency}`,
    ...files,
  ], `${label}: ${files.length} suite(s)`);
}

function main() {
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
  for (const [label, suites] of [
    ['core', groups.core],
    ['DPDPA', groups.dpdpa],
    ['TPRM', groups.tprm],
  ]) {
    const status = runNodeTests(label, suites);
    if (status !== 0) return status;
  }

  for (const suite of groups.standalone) {
    const status = run(process.execPath, [suite], `standalone: ${suite}`);
    if (status !== 0) return status;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { discoverTestFiles, groupFor, groupTests, main, STANDALONE };
