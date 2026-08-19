'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const performance = require('../lib/performance-objectives');
const { bootClient } = require('./helpers');

test('metric status respects direction and near-target tolerance', () => {
  assert.equal(performance.metricRag(97, 95, 'higher'), 'green');
  assert.equal(performance.metricRag(91, 95, 'higher'), 'amber');
  assert.equal(performance.metricRag(70, 95, 'higher'), 'red');
  assert.equal(performance.metricRag(5, 7, 'lower'), 'green');
  assert.equal(performance.metricRag(7.5, 7, 'lower'), 'amber');
  assert.equal(performance.metricRag(null, 7, 'lower'), null);
});

test('metric-driven objectives expose governed values rather than manual duplicates', () => {
  const objective = performance.decorateObjective({
    metric_id: 9, metric_name: 'Closure within SLA', metric_ref: 'B.9', metric_unit: '%',
    metric_direction: 'higher', metric_target_value: 95, latest_value: 91, latest_at: '2026-08-17',
    status_mode: 'metric', target_value: 'manual target', current_value: 'manual current', status: 'achieved',
  });
  assert.equal(objective.effectiveMeasurement, 'B.9 · Closure within SLA');
  assert.equal(objective.effectiveTarget, '95%');
  assert.equal(objective.effectiveCurrent, '91%');
  assert.equal(objective.effectiveStatus, 'at_risk');
});

test('objective position updates from the latest reading and linked measures cannot be removed', async t => {
  const env = await bootClient();
  const db = new Database(env.dbPath);
  t.after(async () => { db.close(); await env.client.close(); });
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const userId = db.prepare(`SELECT id FROM users WHERE email='sec-test@example.com'`).get().id;
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,stage) VALUES (?,'Performance Client','implementation')`).run(firmId).lastInsertRowid);
  const metricId = Number(db.prepare(`INSERT INTO isms_metrics
    (workspace_id,metric_key,ref,name,category,unit,direction,target_value,frequency,created_by)
    VALUES (?,'test-closure','B.9','Closure within SLA','Governance & leadership','%','higher',95,'Monthly',?)`).run(workspaceId,userId).lastInsertRowid);
  db.prepare(`INSERT INTO isms_metric_readings (metric_id,value,measured_at,status,recorded_by) VALUES (?,91,'2026-08-01','amber',?)`).run(metricId,userId);

  const created = await env.client.post(`/workspaces/${workspaceId}/objectives`, {
    title: 'Close critical control gaps', description: 'Resolve critical gaps within the approved treatment period.',
    owner: 'CISO', due_date: '2026-12-31', metric_id: String(metricId), status: 'achieved',
  });
  assert.equal(created.status, 302);
  const stored = db.prepare(`SELECT * FROM security_objectives WHERE workspace_id=?`).get(workspaceId);
  assert.equal(stored.metric_id, metricId);
  assert.equal(stored.status_mode, 'metric');

  const near = await env.client.get(`/workspaces/${workspaceId}/objectives`);
  assert.equal(near.status, 200);
  assert.match(near.text, /Performance &amp; objectives/);
  assert.match(near.text, /91%/);
  assert.match(near.text, /Near target/);

  await env.client.post(`/workspaces/${workspaceId}/metrics/adopted/${metricId}/readings`, { value: '97', measured_at: '2026-08-17', notes: 'Verified monthly close report' });
  const onTarget = await env.client.get(`/workspaces/${workspaceId}/objectives`);
  assert.match(onTarget.text, /97%/);
  assert.match(onTarget.text, /On target/);

  const register = await env.client.get(`/workspaces/${workspaceId}/metrics/readings`);
  assert.equal(register.status, 200);
  assert.match(register.text, /Measurement record/);
  assert.match(register.text, /Verified monthly close report/);
  assert.match(register.text, /Close critical control gaps/);

  const removal = await env.client.post(`/workspaces/${workspaceId}/metrics/adopted/${metricId}/delete`, {});
  assert.equal(removal.status, 302);
  assert.ok(db.prepare(`SELECT 1 FROM isms_metrics WHERE id=?`).get(metricId), 'linked measure must be retained');
});
