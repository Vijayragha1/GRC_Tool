#!/usr/bin/env node
'use strict';

// Materialize a verified signed recovery generation without touching live
// database or uploads paths. Promotion is deliberately a separate offline
// operator action after the generated report has been reviewed.

process.umask(0o077);

const path = require('path');

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/restore.js --destination <empty-directory> [--backup-dir <directory>] [--generation <id>] [--allow-stale-generation]');
  console.log('Writes restored.db, uploads/, and recovery-report.json; it never promotes them over live data.');
  process.exit(0);
}

try {
  const destination = optionValue(args, '--destination');
  const backupDir = optionValue(args, '--backup-dir');
  const generationId = optionValue(args, '--generation');
  const valued = new Set(['--destination', '--backup-dir', '--generation']);
  const flags = new Set(['--allow-stale-generation']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valued.has(arg)) { index++; continue; }
    if (!flags.has(arg)) throw new Error(`unknown option ${arg}`);
  }
  if (!destination) throw new Error('--destination is required');

  const { materializeRecovery } = require('../lib/restore-check');
  const result = materializeRecovery({
    destination: path.resolve(destination),
    backupDir: backupDir ? path.resolve(backupDir) : undefined,
    generationId: generationId || undefined,
    allowStaleGeneration: args.includes('--allow-stale-generation'),
  });
  console.log('recovery materialization PASSED');
  console.log(`  generation: ${result.generationId}`);
  console.log(`  database: ${result.restoredDatabase}`);
  console.log(`  uploads: ${result.restoredUploads} (${result.uploads.fileCount} files, ${result.uploads.bytes} bytes)`);
  console.log(`  report: ${result.report}`);
  console.log('  live data changed: no');
  console.log('  next step: stop the application and explicitly promote the verified files using the offline runbook');
} catch (error) {
  console.error(`recovery materialization FAILED: ${error.message}`);
  process.exitCode = 1;
}
