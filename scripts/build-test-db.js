#!/usr/bin/env node
// Build a migrated, realistically-seeded database at a target path, without
// touching the repo-root iso27001.db. The test suites use this in CI, where
// the live DB (gitignored) does not exist.
//
//   node scripts/build-test-db.js /path/to/target.db
//
// Requiring the seeder pulls in ../db, which runs every migration against
// DB_PATH and then populates the demo firm, users, and two engagements
// (Apex ~100% complete, Stellar ~60%). Run this in a child process: db.js
// caches its connection at require time, so DB_PATH must be set before any
// other module in the process has touched the database.

const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/build-test-db.js <target.db>');
  process.exit(1);
}
process.env.DB_PATH = path.resolve(target);

// Migrations run via init(), not at require time (server.js calls it at boot);
// a fresh DB has no schema until then.
require('../db').init();
require('./seed-realistic-engagements');
