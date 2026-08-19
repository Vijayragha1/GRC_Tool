'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

test('management review form owns save, refresh, and delete actions without nested forms', async t => {
  const env = await bootClient();
  const db = new Database(env.dbPath);
  t.after(async () => { db.close(); await env.client.close(); });

  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const userId = db.prepare(`SELECT id FROM users WHERE email='sec-test@example.com'`).get().id;
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,stage) VALUES (?,'MRM Client','implementation')`).run(firmId).lastInsertRowid);
  const mrmId = Number(db.prepare(`INSERT INTO mrms (workspace_id,meeting_date,status,decisions,created_by) VALUES (?,'2026-08-17','planned','Original decision',?)`).run(workspaceId,userId).lastInsertRowid);

  const page = await env.client.get(`/workspaces/${workspaceId}/mrms/${mrmId}`);
  assert.equal(page.status, 200);
  const form = page.text.match(/<form id="mrmReviewForm"[\s\S]*?<\/form>/)?.[0] || '';
  assert.ok(form, 'management review form should render');
  assert.equal((form.match(/<form\b/g) || []).length, 1, 'management review form must not contain nested forms');
  assert.match(form, />Save changes<\/button>/);
  assert.match(form, new RegExp(`formaction="/workspaces/${workspaceId}/mrms/${mrmId}/refresh-inputs"`));
  assert.match(form, new RegExp(`formaction="/workspaces/${workspaceId}/mrms/${mrmId}/delete"`));

  const register = await env.client.get(`/workspaces/${workspaceId}/mrms`);
  assert.equal(register.status, 200);
  const recordHref = `/workspaces/${workspaceId}/mrms/${mrmId}`;
  assert.ok((register.text.match(new RegExp(`href="${recordHref}"`, 'g')) || []).length >= 4,
    'date, attendees, status, and action should all open the review');
  assert.match(register.text, />Open →<\/a>/);

  const saved = await env.client.post(`/workspaces/${workspaceId}/mrms/${mrmId}`, {
    meeting_date: '2026-08-18', status: 'complete', decisions: 'Approved updated decision',
  });
  assert.equal(saved.status, 302);
  assert.match(saved.headers.location, /toast=Management%20review%20saved/);
  const stored = db.prepare('SELECT meeting_date,status,decisions FROM mrms WHERE id=?').get(mrmId);
  assert.deepEqual(stored, { meeting_date: '2026-08-18', status: 'complete', decisions: 'Approved updated decision' });
});
