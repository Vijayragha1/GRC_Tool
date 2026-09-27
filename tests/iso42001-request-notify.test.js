'use strict';
// ISO 42001 auditor requests sent to the client reach them by email as well as
// in the app (through the notification outbox), and requests the client has
// not answered by their date are chased once per date, with the consultant
// told as well.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, gapOnlyId, clientUser, requestId;
const TODAY = '2026-09-27';

function addRequest(workspaceId, ref) {
  return Number(db.prepare(`INSERT INTO aims_audit_requests (workspace_id, ref, source, kind, stage, description, status, sort_order)
    VALUES (?, ?, 'manual', 'evidence', 'stage1', 'Approved AI policy', 'not_started', 1)`).run(workspaceId, ref).lastInsertRowid);
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  gapOnlyId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Delta Lending', '["iso42001"]', 'gap_assessment_only')`).run(actor.firm_id).lastInsertRowid);
  clientUser = Number(db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active) VALUES ('owner@aurora.example', '!noauth', 'Priya Owner', 'client', 1)`).run().lastInsertRowid);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'client_owner')").run(wsId, clientUser);
  requestId = addRequest(wsId, 'S1-01');
});
test.after(async () => { db?.close(); await client?.close(); });

test('sending a request to the client queues an email as well as the in-app notice', async () => {
  const res = await client.post(`/workspaces/${wsId}/iso42001/requests/${requestId}/send`, { assignee_id: String(clientUser), due_date: '2026-10-10', note: 'The signed copy, please' });
  assert.equal(res.status, 302, res.text.slice(0, 200));
  const outbox = db.prepare(`SELECT o.*, n.title, n.link FROM notification_outbox o JOIN notifications n ON n.id = o.notification_id WHERE o.recipient_id=?`).all(clientUser);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, 'pending', 'queued for the outbox, not sent from the request');
  assert.equal(outbox[0].source_type, 'request');
  assert.match(outbox[0].title, /New request: S1-01/);

  const delivered = [];
  const result = await require('../lib/notification-delivery').dispatchPending(db, { send: async (m) => { delivered.push(m); return { ok: true }; } });
  assert.equal(result.sent, 1);
  assert.equal(delivered[0].toEmail, 'owner@aurora.example');
  assert.match(delivered[0].body, /The signed copy, please/);
  assert.match(delivered[0].body, /Please respond by 2026-10-10/);
});

test('an unanswered request is chased once for each due date, and the consultant is told', () => {
  const jobs = require('../lib/jobs');
  const clientRequest = db.prepare('SELECT client_request_id FROM aims_audit_requests WHERE id=?').get(requestId).client_request_id;
  db.prepare("UPDATE client_requests SET due_date='2026-09-20' WHERE id=?").run(clientRequest);
  const reminders = () => db.prepare(`SELECT COUNT(*) c FROM notification_outbox WHERE recipient_id=? AND event_key LIKE 'aims_request_overdue:%'`).get(clientUser).c;
  const consultantNotices = () => db.prepare(`SELECT COUNT(*) c FROM notifications WHERE workspace_id=? AND category='aims_request_overdue'`).get(wsId).c;

  assert.ok(jobs.jobAimsRequestReminders(TODAY) >= 1);
  assert.equal(reminders(), 1);
  assert.equal(consultantNotices(), 1);
  jobs.jobAimsRequestReminders(TODAY);
  assert.equal(reminders(), 1, 'not chased twice for the same date');
  assert.equal(consultantNotices(), 1);

  db.prepare("UPDATE client_requests SET due_date='2026-09-25' WHERE id=?").run(clientRequest);
  jobs.jobAimsRequestReminders(TODAY);
  assert.equal(reminders(), 2, 'a new date earns a new reminder');

  db.prepare("UPDATE client_requests SET status='submitted' WHERE id=?").run(clientRequest);
  db.prepare("UPDATE client_requests SET due_date='2026-09-26' WHERE id=?").run(clientRequest);
  jobs.jobAimsRequestReminders(TODAY);
  assert.equal(reminders(), 2, 'an answered request is not chased');
});
