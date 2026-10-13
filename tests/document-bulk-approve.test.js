'use strict';
// Approving several documents at once: each is checked as its own decision
// would be, a version the approver prepared is never approved in bulk, and
// the documents that fail a check are skipped and named while the rest go
// ahead.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, colleague, wsId;
const docs = {};

function inReview(name, preparedBy, approvers) {
  const id = Number(db.prepare(`INSERT INTO generated_docs (workspace_id, name, category, status, created_by, locked) VALUES (?, ?, 'policy', 'in_review', ?, 1)`)
    .run(wsId, name, preparedBy).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO doc_versions (workspace_id, document_id, version, name, content, content_hash, status, created_by, submitted_at)
    VALUES (?, ?, 1, ?, 'Body', 'hash', 'in_review', ?, datetime('now'))`).run(wsId, id, name, preparedBy).lastInsertRowid);
  db.prepare('UPDATE generated_docs SET current_version_id=? WHERE id=?').run(versionId, id);
  approvers.forEach((userId, i) => db.prepare(`INSERT INTO doc_approvers (workspace_id, document_id, version_id, sequence, user_id) VALUES (?, ?, ?, ?, ?)`)
    .run(wsId, id, versionId, i + 1, userId));
  return id;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  colleague = Number(db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES ('author@firm.example', '!noauth', 'Author', ?, 'firm', 'consultant', 1)`)
    .run(actor.firm_id).lastInsertRowid);
  wsId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  docs.ready = inReview('AI Policy', colleague, [actor.id]);
  docs.own = inReview('AI Risk Methodology', actor.id, [actor.id]);
  docs.waiting = inReview('Data Governance Procedure', colleague, [colleague, actor.id]);
  docs.partial = inReview('Impact Assessment Procedure', colleague, [actor.id, colleague]);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the queue lists what is waiting on the user, with their own work not selectable', async () => {
  const page = await client.get(`/workspaces/${wsId}/documents`);
  assert.equal(page.status, 200);
  const queue = page.text.slice(page.text.indexOf('Waiting for your approval'), page.text.indexOf('</form>', page.text.indexOf('Waiting for your approval')));
  assert.match(queue, /Waiting for your approval \(3\)/);
  assert.match(queue, new RegExp(`name="document_ids" value="${docs.ready}" >`));
  assert.match(queue, new RegExp(`name="document_ids" value="${docs.own}" disabled>`));
  assert.doesNotMatch(queue, /Data Governance Procedure/, 'an earlier approver must decide first');
});

test('bulk approval approves what passes the checks and names what it skipped', async () => {
  const res = await client.post(`/workspaces/${wsId}/documents/bulk-approve`, { document_ids: [String(docs.ready), String(docs.own), String(docs.waiting), String(docs.partial)] });
  assert.equal(res.status, 302);
  const toast = decodeURIComponent(res.location);
  assert.match(toast, /Approved 2 documents/);
  assert.match(toast, /AI Risk Methodology \(you prepared this version/);
  assert.match(toast, /Data Governance Procedure \(an earlier approver has not decided\)/);
  const status = (id) => db.prepare('SELECT status FROM generated_docs WHERE id=?').get(id).status;
  assert.equal(status(docs.ready), 'approved');
  assert.equal(status(docs.own), 'in_review');
  assert.equal(status(docs.waiting), 'in_review');
  assert.equal(status(docs.partial), 'in_review', 'the next approver still has to decide');
  assert.equal(db.prepare('SELECT decision FROM doc_approvers WHERE document_id=? AND user_id=?').get(docs.partial, actor.id).decision, 'approved');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='approve_document' AND CAST(entity_id AS TEXT)=?").get(String(docs.ready)).c, 1, 'the approval is in the audit log');
});
