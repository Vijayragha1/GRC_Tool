'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, workspaceId, managerId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  const manager = db.prepare(`SELECT * FROM users WHERE email='sec-test@example.com'`).get();
  managerId = manager.id;
  workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id, client_name, industry, scope, lead_consultant_id, frameworks)
    VALUES (?, 'Framework Evidence Test', 'Technology', 'Integrated assurance scope', ?, ?)`)
    .run(manager.firm_id, managerId, JSON.stringify(['iso27001', 'iso42001', 'csf'])).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'firm_owner')`)
    .run(workspaceId, managerId);
});

test.after(async () => {
  if (db) db.close();
  if (client) await client.close();
});

test('evidence upload renders every enabled framework catalog', async () => {
  const page = await client.get(`/workspaces/${workspaceId}/evidence`);
  assert.equal(page.status, 200, page.text.slice(0, 500));
  assert.match(page.text, />ISO 27001</);
  assert.match(page.text, />ISO 42001</);
  assert.match(page.text, />NIST CSF 2\.0</);
  assert.match(page.text, /name="iso_item_id" value="clause-4\.1"/);
  assert.match(page.text, /name="iso42001_item_ref" value="ai-clause-4\.1"/);
  assert.match(page.text, /name="csf_item_ref" value="GV\.OC-01"/);
});

test('one upload links to ISO 27001, ISO 42001 and NIST CSF through canonical requirements', async () => {
  const form = new FormData();
  form.set('_csrf', client.getCsrfToken());
  form.set('iso_item_id', 'clause-4.1');
  form.set('iso42001_item_ref', 'ai-clause-4.1');
  form.set('csf_item_ref', 'GV.OC-01');
  form.set('description', 'Cross-framework governance evidence');
  form.append('file', new Blob(['approved governance record\n'], { type: 'text/plain' }), 'cross-framework-evidence.txt');
  const response = await fetch(`${await client.baseUrl()}/workspaces/${workspaceId}/evidence`, {
    method: 'POST',
    headers: {
      cookie: client.getCookies(),
      referer: `${await client.baseUrl()}/workspaces/${workspaceId}/evidence`,
      'x-csrf-token': client.getCsrfToken()
    },
    body: form,
    redirect: 'manual'
  });
  assert.equal(response.status, 302, await response.text());

  const evidence = db.prepare(`SELECT id, iso_item_id FROM evidence WHERE workspace_id=? AND filename=?`)
    .get(workspaceId, 'cross-framework-evidence.txt');
  assert.ok(evidence);
  assert.equal(evidence.iso_item_id, 'clause-4.1');
  const links = db.prepare(`SELECT f.code framework, r.ref
    FROM evidence_requirement_links erl
    JOIN requirements r ON r.id=erl.requirement_id
    JOIN frameworks f ON f.id=r.framework_id
    WHERE erl.evidence_id=? ORDER BY f.code`).all(evidence.id);
  assert.deepEqual(links, [
    { framework: 'csf', ref: 'GV.OC-01' },
    { framework: 'iso27001', ref: 'clause-4.1' },
    { framework: 'iso42001', ref: 'ai-clause-4.1' }
  ]);
});

test('the picker and write routes reject frameworks not enabled for the client', async () => {
  db.prepare(`UPDATE workspaces SET frameworks=? WHERE id=?`).run(JSON.stringify(['csf']), workspaceId);
  const page = await client.get(`/workspaces/${workspaceId}/evidence`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-picker-tab="csf"/);
  assert.doesNotMatch(page.text, /data-picker-tab="iso27001"/);
  assert.doesNotMatch(page.text, /data-picker-tab="iso42001"/);
  assert.doesNotMatch(page.text, /name="iso_item_id"/);
  assert.doesNotMatch(page.text, /name="iso42001_item_ref"/);

  const evidenceId = db.prepare(`SELECT id FROM evidence WHERE workspace_id=? ORDER BY id DESC LIMIT 1`).get(workspaceId).id;
  const rejected = await client.post(`/workspaces/${workspaceId}/evidence/${evidenceId}/links`, {
    framework: 'iso42001', item_ref: 'ai-clause-4.1'
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /Framework is not enabled/);
});
