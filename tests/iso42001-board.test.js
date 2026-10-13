'use strict';
// The firm's ISO 42001 clients on one board: the nearest certification body
// audit, readiness, open and overdue auditor requests, open findings and what
// needs attention, most pressing first.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const ws = (name, frameworks, outcome) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, ?)`)
    .run(actor.firm_id, name, frameworks, outcome).lastInsertRowid);
  const soon = ws('Aurora Diagnostics', '["iso42001"]', 'certification_support');
  const troubled = ws('Northwind Health', '["iso27001","iso42001"]', 'certification_support');
  ws('Harbour Freight', '["iso27001"]', 'certification_support');
  ws('Delta Lending', '["iso42001"]', 'gap_assessment_only');

  const event = (wsId, key, type, planned) => Number(db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, event_key, planned_date, status, cycle_no) VALUES (?, ?, ?, ?, 'planned', 1)`)
    .run(wsId, type, key, planned).lastInsertRowid);
  event(soon, 'stage1', 'Stage 1 audit', day(12));
  const stage2 = event(troubled, 'stage2', 'Stage 2 audit', day(60));
  db.prepare(`INSERT INTO nonconformities (workspace_id, title, severity, status, source, source_ref, iso_item_id) VALUES (?, 'No monitoring of drift', 'major', 'open', 'external_audit', ?, 'ai-annex-a-6-2-6')`)
    .run(troubled, `aims_cert_event:${stage2}`);
  db.prepare(`INSERT INTO aims_audit_requests (workspace_id, ref, kind, stage, description, due_date, status, sort_order) VALUES (?, 'R1', 'policy', 'stage1', 'AI policy', ?, 'with_client', 1)`).run(soon, day(-3));
  db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Triage assistant', 'in_use', 1, ?)`).run(soon, actor.id);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the board lists only ISO 42001 clients, the most pressing first', async () => {
  const page = await client.get('/portfolio/iso42001');
  assert.equal(page.status, 200, page.text.slice(0, 300));
  const table = page.text.slice(page.text.indexOf('<table class="t">'), page.text.indexOf('</table>'));
  assert.doesNotMatch(table, /Harbour Freight/, 'an ISO 27001-only client is not on the board');
  const order = ['Northwind Health', 'Aurora Diagnostics', 'Delta Lending'].map((n) => table.indexOf(n));
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'open major finding first, then the nearest audit, then the rest');
  assert.match(table, /Stage 1 audit<\/a><div class="meta text-xs" style="color:#b45309;">[0-9-]+ · in 12 days/);
  assert.match(page.text, /1 overdue<\/div>/);
  assert.match(page.text, /1 major · 0 minor/);
  assert.match(page.text, /1 AI system without an impact assessment/);
  assert.match(page.text, /Gap assessment only/);
  assert.match(page.text, /<strong[^>]*>1<\/strong> audit in the next 30 days/);
});
