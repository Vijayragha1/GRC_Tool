#!/usr/bin/env node
'use strict';
// Compatibility entry point for the optional development LaunchAgent. The
// governed CLI now records backup_runs itself, so this wrapper must delegate
// exactly once and must not create a second, unencrypted backup record.

process.umask(0o077);

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, [path.join(__dirname, 'backup.js')], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[dev-backup] failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(Number.isInteger(result.status) ? result.status : 1);
