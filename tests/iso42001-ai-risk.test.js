'use strict';
// AI risk assessment: a risk names its AI system and source, is rated for its
// impact on the organisation, people and society, and each assessment run is
// kept as a sealed record. The ISO 42001 risk treatment plan is exported.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsAi, wsOther, systemId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const mk = (name, fw) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`).run(actor.firm_id, name, JSON.stringify(fw)).lastInsertRowid);
  wsAi = mk('Aurora Diagnostics', ['iso42001']);
  wsOther = mk('Borealis Logistics', ['iso27001']);
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Triage assistant', 'in_use', ?)`).run(wsAi, actor.id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

const risk = (title) => db.prepare('SELECT * FROM risks WHERE title=?').get(title);

test('an AI risk names its system and source and is scored on its worst consequence', async () => {
  const form = await client.get(`/workspaces/${wsAi}/risks`);
  assert.match(form.text, /name="impact_individuals"/);
  assert.match(form.text, new RegExp(`<option value="${systemId}"[^>]*>Triage assistant</option>`));
  assert.match(form.text, /Data: quality, bias, provenance or rights/);

  await client.post(`/workspaces/${wsAi}/risks`, {
    title: 'Triage assistant under-prioritises older patients', likelihood: 3, impact: 2,
    ai_system_id: systemId, risk_source: 'data', impact_individuals: 4, impact_society: 3, next_review_date: '2027-06-30',
  });
  const r = risk('Triage assistant under-prioritises older patients');
  assert.equal(r.ai_system_id, systemId);
  assert.equal(r.risk_source, 'data');
  assert.equal(r.impact_organisation, 2);
  assert.equal(r.impact_individuals, 4);
  assert.equal(r.impact_society, 3);
  assert.equal(r.impact, 4, 'the score uses the highest consequence');
  assert.equal(r.next_review_date, '2027-06-30');

  await client.post(`/workspaces/${wsAi}/risks/${r.id}`, { title: r.title, likelihood: 3, impact: 2, impact_individuals: '', impact_society: '', risk_source: 'data', ai_system_id: systemId });
  assert.equal(risk(r.title).impact, 2, 'without people or society ratings the organisational impact stands');

  const foreignSystem = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, created_by) VALUES (?, 'Route optimiser', ?)`).run(wsOther, actor.id).lastInsertRowid);
  await client.post(`/workspaces/${wsAi}/risks/${r.id}`, { title: r.title, likelihood: 3, impact: 2, ai_system_id: foreignSystem, risk_source: 'not-a-source' });
  const after = risk(r.title);
  assert.equal(after.ai_system_id, null, "another client's AI system cannot be named");
  assert.equal(after.risk_source, null);

  await client.post(`/workspaces/${wsAi}/risks/${r.id}`, { title: r.title, likelihood: 3, impact: 2, ai_system_id: systemId, impact_individuals: 5 });
  const page = await client.get(`/workspaces/${wsAi}/iso42001/ai-systems/${systemId}`);
  assert.match(page.text, /Risks from this system/);
  assert.match(page.text, /Triage assistant under-prioritises older patients/);
  const detail = await client.get(`/workspaces/${wsAi}/risks/${r.id}`);
  assert.match(detail.text, /Impact on the organisation/);
  assert.match(detail.text, /Scored at 5, its highest consequence for people or society/);
});

test('an ISO 27001 client keeps the single impact rating', async () => {
  const form = await client.get(`/workspaces/${wsOther}/risks`);
  assert.doesNotMatch(form.text, /name="impact_individuals"/);
  await client.post(`/workspaces/${wsOther}/risks`, { title: 'Backup restore untested', likelihood: 2, impact: 4 });
  const r = risk('Backup restore untested');
  assert.equal(r.impact, 4);
  assert.equal(r.impact_individuals, null);
});

test('each risk assessment run is kept as a sealed record with the next one due', async () => {
  await client.post(`/workspaces/${wsAi}/risks`, { title: 'Office flood', likelihood: 1, impact: 3 });
  const res = await client.post(`/workspaces/${wsAi}/risks/assessments`, { scope: 'ai', performed_on: '2026-09-01', label: 'AI risk assessment Q3', notes: 'Held with the AI lead' });
  assert.equal(res.status, 302);
  const rec = db.prepare('SELECT * FROM risk_assessment_records WHERE workspace_id=?').get(wsAi);
  assert.equal(rec.scope, 'ai');
  assert.equal(rec.risk_count, 1, 'only AI risks are in an AI-scoped record');
  const rows = JSON.parse(rec.payload);
  assert.equal(rows[0].ai_system, 'Triage assistant');
  assert.equal(rows[0].impact_individuals, 5);

  const view = await client.get(`/workspaces/${wsAi}/risks/assessments/${rec.id}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /Sealed record/);
  assert.match(view.text, /Triage assistant under-prioritises older patients/);
  assert.throws(() => db.prepare('UPDATE risk_assessment_records SET risk_count=9 WHERE id=?').run(rec.id), /cannot be changed/);

  const list = await client.get(`/workspaces/${wsAi}/risks`);
  assert.match(list.text, /Last performed 2026-09-01 · next due <strong[^>]*>2027-09-01<\/strong>/);
  assert.equal((await client.get(`/workspaces/${wsOther}/risks/assessments/${rec.id}`)).status, 404, "another client's record is not reachable");
});

test('the AI risk treatment plan exports for an ISO 42001 client', async () => {
  const res = await client.get(`/workspaces/${wsAi}/export/rtp.docx?framework=iso42001`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /ai-risk-treatment-plan/);
  const plain = await client.get(`/workspaces/${wsOther}/export/rtp.docx`);
  assert.equal(plain.status, 200);
  assert.doesNotMatch(plain.headers['content-disposition'], /ai-risk/);
});
