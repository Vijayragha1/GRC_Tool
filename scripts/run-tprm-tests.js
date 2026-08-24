#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const testsDir = path.join(projectRoot, 'tests');
const tests = fs.readdirSync(testsDir)
  .filter(name => /^tprm-.*\.test\.js$/.test(name))
  .sort()
  .map(name => path.join('tests', name));

if (!tests.length) {
  console.error('No TPRM test files were discovered; refusing to report a passing production suite.');
  process.exit(1);
}

console.log(`[test:tprm] running ${tests.length} discovered suite(s)`);
const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...tests], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`[test:tprm] could not start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
