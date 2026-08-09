'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let workspaceId;
let managerId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId = db.prepare(`SELECT id FROM users WHERE email='sec-test@example.com'`).get().id;
  workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,target_cert_date,created_at)
    VALUES (?, 'Adaptive Plan Client', 'gap_assessment', '2027-12-31', '2026-01-01')`).run(firmId).lastInsertRowid);
});

test.after(async () => {
  if (db) db.close();
  if (client) await client.close();
});

test('adaptive plan seeds flexible phases, milestones and deliverables once', async () => {
  const page = await client.get(`/workspaces/${workspaceId}/engagement-plan`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Adaptive delivery/);
  assert.doesNotMatch(page.text, /12-week client plan/);
  const plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId);
  assert.ok(plan);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_phases WHERE plan_id=?').get(plan.id).c, 11);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_milestones WHERE plan_id=?').get(plan.id).c, 27);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_deliverables WHERE plan_id=?').get(plan.id).c, 27);
  await client.get(`/workspaces/${workspaceId}/engagement-plan`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId).c, 1);
});

test('timeline and gates are projections and the legacy roadmap redirects', async () => {
  assert.equal((await client.get(`/workspaces/${workspaceId}/engagement-plan?view=timeline`)).status, 200);
  assert.equal((await client.get(`/workspaces/${workspaceId}/engagement-plan?view=gates`)).status, 200);
  const roadmap = await client.get(`/workspaces/${workspaceId}/roadmap`);
  assert.equal(roadmap.status, 302);
  assert.equal(roadmap.location, `/workspaces/${workspaceId}/engagement-plan?view=timeline`);
});

test('approved baselines are immutable snapshots with hashes', async () => {
  const response = await client.post(`/workspaces/${workspaceId}/engagement-plan/baselines`, {
    label: 'Client-approved baseline', reason: 'Scope and target dates approved at steering committee.'
  });
  assert.equal(response.status, 302);
  const baseline = db.prepare(`SELECT * FROM engagement_delivery_baselines b JOIN engagement_delivery_plans p ON p.id=b.plan_id WHERE p.workspace_id=?`).get(workspaceId);
  assert.equal(baseline.version_number, 1);
  assert.equal(baseline.snapshot_hash.length, 64);
  assert.match(baseline.snapshot_json, /Adaptive Plan Client|ISO 27001 adaptive delivery plan/);
});

test('deliverable acceptance completes its milestone and retains decision history', async () => {
  const deliverable = db.prepare(`SELECT d.* FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id JOIN engagement_delivery_phases p ON p.id=m.phase_id
    JOIN engagement_delivery_plans ep ON ep.id=d.plan_id
    WHERE ep.workspace_id=? ORDER BY p.sort_order,m.id LIMIT 1`).get(workspaceId);
  db.prepare(`UPDATE engagement_delivery_deliverables SET approver_id=? WHERE id=?`).run(managerId, deliverable.id);
  const evidenceId = Number(db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?, 'kickoff-minutes.pdf', 'test-kickoff-minutes.pdf', 'test-sha-256', 128, ?, 'Signed kickoff minutes')`).run(workspaceId, managerId).lastInsertRowid);
  db.prepare(`INSERT INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`)
    .run(workspaceId, deliverable.id, evidenceId, managerId);
  assert.equal((await client.post(`/workspaces/${workspaceId}/engagement-plan/deliverables/${deliverable.id}/submit`, { note: 'Ready for review' })).status, 302);
  assert.equal((await client.post(`/workspaces/${workspaceId}/engagement-plan/deliverables/${deliverable.id}/accept`, { note: 'Accepted against the agreed criteria' })).status, 302);
  const accepted = db.prepare('SELECT * FROM engagement_delivery_deliverables WHERE id=?').get(deliverable.id);
  const milestone = db.prepare('SELECT * FROM engagement_delivery_milestones WHERE id=?').get(deliverable.milestone_id);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.accepted_by, managerId);
  assert.match(accepted.evidence_snapshot_json, /kickoff-minutes\.pdf/);
  assert.equal(milestone.status, 'complete');
  assert.ok(db.prepare(`SELECT 1 FROM engagement_delivery_events WHERE entity_type='deliverable' AND entity_id=? AND action='accept'`).get(deliverable.id));
});

test('dependency cycles are rejected and task linkage is tenant-scoped', async () => {
  const plan = db.prepare('SELECT id FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId);
  const edge = db.prepare('SELECT * FROM engagement_delivery_dependencies WHERE plan_id=? ORDER BY id LIMIT 1').get(plan.id);
  const before = db.prepare('SELECT COUNT(*) c FROM engagement_delivery_dependencies WHERE plan_id=?').get(plan.id).c;
  const cycle = await client.post(`/workspaces/${workspaceId}/engagement-plan/dependencies`, {
    predecessor_id: String(edge.successor_milestone_id), successor_id: String(edge.predecessor_milestone_id),
    dependency_type: 'finish_to_start', lag_days: '0'
  });
  assert.equal(cycle.status, 302);
  assert.match(cycle.location, /toastKind=error/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_dependencies WHERE plan_id=?').get(plan.id).c, before);

  const task = await client.post(`/workspaces/${workspaceId}/tasks`, {
    title: 'Prepare kickoff acceptance pack', engagement_milestone_id: String(edge.predecessor_milestone_id),
    due_date: '2026-02-01'
  });
  assert.equal(task.status, 302);
  assert.equal(db.prepare(`SELECT engagement_milestone_id FROM tasks WHERE workspace_id=? AND title='Prepare kickoff acceptance pack'`).get(workspaceId).engagement_milestone_id, edge.predecessor_milestone_id);
});

test('a phase cannot pass until every required acceptance criterion passes', async () => {
  const phase = db.prepare(`SELECT ph.id FROM engagement_delivery_phases ph JOIN engagement_delivery_plans p ON p.id=ph.plan_id WHERE p.workspace_id=? ORDER BY ph.sort_order LIMIT 1`).get(workspaceId);
  const result = await client.post(`/workspaces/${workspaceId}/engagement-plan/phases/${phase.id}/gate`, {
    decision: 'passed', note: 'Attempted early pass'
  });
  assert.equal(result.status, 302);
  assert.match(result.location, /toastKind=error/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_gate_decisions WHERE phase_id=?').get(phase.id).c, 0);
});

test('target fitting creates a governed schedule run and aligns the forecast', async () => {
  const response = await client.post(`/workspaces/${workspaceId}/engagement-plan/fit-target`, {});
  assert.equal(response.status, 302);
  const plan = db.prepare(`SELECT * FROM engagement_delivery_plans WHERE workspace_id=?`).get(workspaceId);
  assert.equal(plan.forecast_completion_date, plan.target_completion_date);
  assert.ok(db.prepare(`SELECT 1 FROM engagement_delivery_schedule_runs WHERE plan_id=? AND trigger_type='fit_to_target'`).get(plan.id));
});

test('revising a rejected deliverable retains immutable supersession lineage', async () => {
  const row = db.prepare(`SELECT d.* FROM engagement_delivery_deliverables d JOIN engagement_delivery_plans p ON p.id=d.plan_id WHERE p.workspace_id=? AND d.status='draft' ORDER BY d.id LIMIT 1`).get(workspaceId);
  db.prepare(`UPDATE engagement_delivery_deliverables SET status='rejected',decision_note='Evidence period is incomplete' WHERE id=?`).run(row.id);
  const response = await client.post(`/workspaces/${workspaceId}/engagement-plan/deliverables/${row.id}/revise`, { note: 'Rework requested by the approver.' });
  assert.equal(response.status, 302);
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(row.id).status, 'superseded');
  const replacement = db.prepare(`SELECT * FROM engagement_delivery_deliverables WHERE supersedes_deliverable_id=?`).get(row.id);
  assert.equal(replacement.status, 'draft');
  assert.equal(replacement.revision_number, row.revision_number + 1);
});

test('engagement completion is rejected while required phase gates remain open', async () => {
  const plan = db.prepare(`SELECT * FROM engagement_delivery_plans WHERE workspace_id=?`).get(workspaceId);
  const response = await client.post(`/workspaces/${workspaceId}/engagement-plan/settings`, {
    name: plan.name, objective: plan.objective, status: 'completed', target_start_date: plan.target_start_date,
    target_completion_date: plan.target_completion_date, forecast_completion_date: plan.forecast_completion_date,
    completion_criteria: plan.completion_criteria, updated_at_snapshot: plan.updated_at
  });
  assert.equal(response.status, 302);
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_plans WHERE id=?`).get(plan.id).status, 'active');
});
