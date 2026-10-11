'use strict';
// Sharing a client request with the client team only reports success when
// somebody on that team is actually told. A request nobody can receive is
// refused with an actionable message and left unshared, rather than redirecting
// with a "shared with the client team" toast that nothing backs up.
//
// No email leaves this suite: nothing is dispatched from the outbox, and
// delivery is disabled in the environment before the app boots.

process.env.EMAIL_DELIVERY_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, contributorId;

function addClientMember(email, name, role) {
  const id = Number(db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active)
    VALUES (?, '!noauth', ?, 'client', 1)`).run(email, name).lastInsertRowid);
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, id, role);
  return id;
}

// Created through the route, so the request starts unassigned and unreleased
// exactly as the portal leaves a draft.
async function draftRequest(title) {
  const created = await client.post(`/workspaces/${wsId}/client-portal/requests`,
    { request_type: 'evidence', title, description: 'Provide the approved AI management system scope.' });
  assert.equal(created.status, 302, created.text.slice(0, 200));
  const row = db.prepare('SELECT * FROM client_requests WHERE workspace_id=? ORDER BY id DESC').get(wsId);
  assert.equal(row.released_at, null, 'a request with no assignee starts as a draft');
  return row;
}

const outboxFor = requestId => db.prepare(`SELECT o.*, n.title, n.user_id, n.severity
  FROM notification_outbox o JOIN notifications n ON n.id=o.notification_id
  WHERE o.workspace_id=? AND o.source_type='request' AND o.source_id=?`).all(wsId, String(requestId));
const shareEvents = requestId => db.prepare(`SELECT COUNT(*) c FROM client_request_events
  WHERE request_id=? AND event_type='target_updated'`).get(requestId).c;
const visibleTo = (row, userId) => require('../lib/client-work-policy').clientWorkPolicy({
  db, workspace: db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId),
  actor: db.prepare('SELECT * FROM users WHERE id=?').get(userId), sourceType: 'request',
  row: db.prepare('SELECT * FROM client_requests WHERE id=?').get(row.id),
}).visible;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome)
    VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  // An active contributor and nobody to coordinate for them: a contributor only
  // ever sees the requests assigned to them.
  contributorId = addClientMember('contributor@aurora.example', 'Theo Contributor', 'contributor');
});
test.after(async () => { db?.close(); await client?.close(); });

test('an unassigned request with no client coordinator is refused, not reported as shared', async () => {
  const row = await draftRequest('Unassigned AI scope evidence');
  const release = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });

  assert.equal(release.status, 422, release.text.slice(0, 300));
  assert.match(release.text, /has no assignee/);
  assert.match(release.text, /Assign it to an active client team member/);

  // The whole share rolled back: not released, no share event, nothing queued.
  const after = db.prepare('SELECT * FROM client_requests WHERE id=?').get(row.id);
  assert.equal(after.released_at, null, 'the refused share left the request unreleased');
  assert.equal(after.released_by, null);
  assert.equal(after.version, row.version, 'the refused share did not consume the request version');
  assert.equal(shareEvents(row.id), 0, 'no share event survived the rollback');
  assert.equal(outboxFor(row.id).length, 0);
  // The defect must not be hidden by widening what a contributor can see.
  assert.equal(visibleTo(row, contributorId), false, 'an unassigned request stays outside a contributor scope');
});

test('an inactive client coordinator cannot receive a share either', async () => {
  const dormantId = addClientMember('dormant-owner@aurora.example', 'Dormant Owner', 'client_owner');
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(dormantId);
  const row = await draftRequest('Share aimed at a dormant owner');

  const release = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });
  assert.equal(release.status, 422, release.text.slice(0, 300));
  assert.equal(db.prepare('SELECT released_at FROM client_requests WHERE id=?').get(row.id).released_at, null);
  assert.equal(outboxFor(row.id).length, 0, 'a dormant account is not a reachable recipient');
});

test('the same share succeeds once an active coordinator can receive it, and queues one notice', async () => {
  const ownerId = addClientMember('owner@aurora.example', 'Priya Owner', 'client_owner');
  const row = await draftRequest('Shareable AI scope evidence');

  const release = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });
  assert.equal(release.status, 302, release.text.slice(0, 300));
  assert.match(release.location, /toast=Request%20shared%20with%20the%20client%20team/);

  const shared = db.prepare('SELECT * FROM client_requests WHERE id=?').get(row.id);
  assert.ok(shared.released_at, 'the request is released');
  assert.equal(Number(shared.released_by), Number(actor.id));
  assert.equal(shareEvents(row.id), 1);

  const queued = outboxFor(row.id);
  assert.equal(queued.length, 1, 'exactly one recipient, queued once');
  assert.equal(Number(queued[0].recipient_id), ownerId, 'the coordinator who can act on it');
  assert.equal(queued[0].status, 'pending', 'queued for the outbox, not sent from the request');
  assert.match(queued[0].title, /^Request shared: Shareable AI scope evidence$/);
  assert.equal(visibleTo(row, ownerId), true);
  assert.equal(visibleTo(row, contributorId), false, 'releasing to the team queue is not a contributor disclosure');

  // Replaying the same submission is rejected on the version it already spent,
  // so a double-click cannot queue the notice twice.
  const replay = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/release`, { version: String(row.version) });
  assert.equal(replay.status, 409);
  assert.equal(outboxFor(row.id).length, 1, 'the replay queued nothing new');
  assert.equal(shareEvents(row.id), 1);
  assert.equal(db.prepare('SELECT released_at FROM client_requests WHERE id=?').get(row.id).released_at, shared.released_at);
});

test('a share aimed at its assignee reaches that assignee and nobody else', async () => {
  const row = await draftRequest('Assigned AI scope evidence');
  // Assigning through the route releases the request as part of the hand-off,
  // which is the path the share notice has to cover for a scoped contributor.
  const assigned = await client.post(`/workspaces/${wsId}/client-portal/requests/${row.id}/assign`,
    { version: String(row.version), assignee_id: String(contributorId) });
  assert.equal(assigned.status, 302, assigned.text.slice(0, 300));

  const queued = outboxFor(row.id);
  assert.equal(queued.length, 1, 'the assignee alone is told');
  assert.equal(Number(queued[0].recipient_id), contributorId);
  assert.equal(queued[0].status, 'pending');
  assert.equal(visibleTo(row, contributorId), true, 'the assignee can open what they were told about');
});
