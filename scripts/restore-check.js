#!/usr/bin/env node
// Manual restore drill: prove the newest encrypted backup restores cleanly.
//
//   npm run restore-check
//
// Exit 0 when the restore passes integrity + row-count sanity, 1 otherwise.
// The verdict is also recorded in backup_runs (kind 'restore_drill') and
// shown on the system page. The monthly job runs this automatically.

const { runDrill } = require('../lib/restore-check');

const r = runDrill();
if (r.ok) {
  console.log(`restore drill PASSED in ${r.ms}ms`);
  console.log(`  backup: ${r.file}`);
  for (const [t, c] of Object.entries(r.counts)) console.log(`  ${t}: restored ${c.restored} vs live ${c.live}`);
  process.exit(0);
}
console.error(`restore drill FAILED: ${r.error}`);
process.exit(1);
