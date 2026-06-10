#!/usr/bin/env node
/**
 * 012_phase7_exception_expiry.js  (DATA op / job; additive, mirrors lib/jobs.js notify())
 *
 * Wires control_exceptions expiry into the existing notification machinery:
 *   1. factual auto-expiry: control_exceptions past expiry & still 'active' -> 'expired'
 *   2. surface expired-but-unreviewed (state 'expired', i.e. not yet moved to under_review/closed)
 *      as a workspace notification, using the same dedup-insert contract as lib/jobs.js notify()
 *      (no duplicate while an unread notification for that title already exists).
 *
 * Writes only to existing tables (control_exceptions.state, notifications); edits NO app code.
 * GATED (not done here): registering this as a scheduled job in lib/jobs.js, and the dashboard
 * read. Idempotent: re-running flips nothing new and the dedup guard prevents repeat notifications.
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db'));
db.pragma('foreign_keys = ON');

const run = db.transaction(() => {
  const flipped = db.prepare(`UPDATE control_exceptions SET state='expired' WHERE state='active' AND expiry < date('now')`).run().changes;
  let notified = 0;
  const rows = db.prepare(`SELECT ce.id, ce.workspace_id, ce.description, ce.expiry, r.ref
    FROM control_exceptions ce
    JOIN control_instances ci ON ci.id=ce.instance_id
    JOIN requirements r ON r.id=ci.requirement_id
    WHERE ce.expiry < date('now') AND ce.state='expired'`).all();
  for (const ex of rows) {
    const title = `Control exception expired: ${ex.ref}`;
    const exists = db.prepare(`SELECT id FROM notifications WHERE workspace_id=? AND user_id IS NULL AND category='control_exception_expired' AND title=? AND read_at IS NULL AND dismissed_at IS NULL`).get(ex.workspace_id, title);
    if (exists) continue;
    db.prepare(`INSERT INTO notifications (workspace_id,user_id,category,severity,title,body,link) VALUES (?,NULL,'control_exception_expired','high',?,?,?)`)
      .run(ex.workspace_id, title, `Exception "${ex.description}" expired ${ex.expiry}; needs review or closure.`, `/workspaces/${ex.workspace_id}/exceptions/${ex.id}`);
    notified++;
  }
  return { flipped, notified };
});

const r = run();
console.log(`exception-expiry: auto-expired ${r.flipped}, notifications raised ${r.notified}`);
db.close();
