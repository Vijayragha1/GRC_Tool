'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const gapAssessmentReport = require('../lib/gap-assessment-report');

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
  assert.match(page.text, new RegExp(`href="/workspaces/${workspaceId}/client-portal\\?preview=client"[^>]*>Client view<`));
  assert.doesNotMatch(page.text, /12-week client plan/);
  const plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId);
  assert.ok(plan);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_phases WHERE plan_id=?').get(plan.id).c, 11);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_milestones WHERE plan_id=?').get(plan.id).c, 27);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_deliverables WHERE plan_id=?').get(plan.id).c, 27);
  const clientPresentation = db.prepare(`SELECT d.client_title,d.client_description,d.framework_code,d.requirement_refs
    FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    WHERE d.plan_id=? AND m.milestone_key='w1-kickoff'`).get(plan.id);
  assert.equal(clientPresentation.client_title, 'Kick-off records and role acknowledgements');
  assert.equal(clientPresentation.client_description, 'Provide this item for review and approval.');
  assert.equal(clientPresentation.framework_code, 'iso27001');
  assert.equal(clientPresentation.requirement_refs, '5.1, 5.3');
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

test('ISO 27001 client setup remains discoverable after scope confirmation', async () => {
  db.prepare(`UPDATE workspaces SET frameworks='["iso27001"]',scope_confirmed_at=datetime('now'),stage='implementation' WHERE id=?`)
    .run(workspaceId);
  const page = await client.get(`/workspaces/${workspaceId}/intake`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`href="/workspaces/${workspaceId}/intake"[^>]*>\\s*<span class="nav-subitem-text">Client setup</span>`));
});

test('incident actions stay on the incident page when no Referer header is supplied', async () => {
  const incidentId = Number(db.prepare(`INSERT INTO incidents
    (workspace_id,title,category,severity,status)
    VALUES (?,'Runbook redirect regression','dos','high','open')`).run(workspaceId).lastInsertRowid);
  const runbook = db.prepare(`SELECT id,name FROM runbooks WHERE is_system=1 ORDER BY id LIMIT 1`).get();
  assert.ok(runbook, 'the seeded system runbook should exist');
  const detailPath = `/workspaces/${workspaceId}/incidents/${incidentId}`;

  const attached = await client.post(`${detailPath}/runbook`, { runbook_id: String(runbook.id) });
  assert.equal(attached.status, 302);
  assert.equal(new URL(attached.location, 'http://local.test').pathname, detailPath);
  assert.match(decodeURIComponent(attached.location), /Runbook attached/);
  assert.equal(db.prepare('SELECT runbook_id FROM incidents WHERE id=?').get(incidentId).runbook_id, runbook.id);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log
    WHERE workspace_id=? AND entity_type='incident' AND entity_id=? AND action='attach_runbook'`)
    .get(workspaceId, String(incidentId)));

  const unavailable = await client.post(`${detailPath}/runbook`, { runbook_id: '999999999' });
  assert.equal(unavailable.status, 302);
  assert.equal(new URL(unavailable.location, 'http://local.test').pathname, detailPath);
  assert.match(unavailable.location, /toastKind=error/);
  assert.equal(db.prepare('SELECT runbook_id FROM incidents WHERE id=?').get(incidentId).runbook_id, runbook.id,
    'an unavailable runbook must not replace the current selection');

  const clock = await client.post(`${detailPath}/regulator-clock`, {
    detected_at: '2026-08-15T12:00', regulator: 'GDPR DPA', hours: '72'
  });
  assert.equal(clock.location, detailPath);
  const pir = await client.post(`${detailPath}/pir`, { pir_summary: 'Root cause and follow-up reviewed.' });
  assert.equal(pir.location, detailPath);
});

test('client setup supports additional crown jewels and idempotently links them to the asset inventory', async () => {
  const page = await client.get(`/workspaces/${workspaceId}/intake`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Add another crown jewel/);
  assert.match(page.text, /linked to the asset register/);

  const created = await client.post(`/workspaces/${workspaceId}/intake/field`, {
    question_id: 'crown-jewel-1', answer: 'Customer identity vault'
  });
  assert.equal(created.status, 200);
  assert.equal(JSON.parse(created.text).asset.status, 'created');
  let asset = db.prepare(`SELECT * FROM assets WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref='crown-jewel-1'`)
    .get(workspaceId);
  assert.equal(asset.name, 'Customer identity vault');
  assert.equal(asset.business_criticality, 'critical');
  assert.equal(asset.classification, 'restricted');
  assert.equal(asset.type, 'information');

  const updated = await client.post(`/workspaces/${workspaceId}/intake/field`, {
    question_id: 'crown-jewel-1', answer: 'Customer identity and authentication vault'
  });
  assert.equal(JSON.parse(updated.text).asset.status, 'updated');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM assets WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref='crown-jewel-1'`).get(workspaceId).c, 1);
  asset = db.prepare(`SELECT * FROM assets WHERE workspace_id=? AND source_ref='crown-jewel-1'`).get(workspaceId);
  assert.equal(asset.name, 'Customer identity and authentication vault');

  const extra = await client.post(`/workspaces/${workspaceId}/intake/field`, {
    question_id: 'crown-jewel-7', answer: 'Production signing keys'
  });
  assert.equal(extra.status, 200);
  assert.equal(JSON.parse(extra.text).asset.status, 'created');
  const refreshed = await client.get(`/workspaces/${workspaceId}/intake`);
  assert.match(refreshed.text, /Crown jewel #7/);
  assert.match(refreshed.text, /Production signing keys/);

  await client.post(`/workspaces/${workspaceId}/intake/field`, {
    question_id: 'crown-jewel-7', answer: ''
  });
  const retained = db.prepare(`SELECT * FROM assets WHERE workspace_id=? AND name='Production signing keys'`).get(workspaceId);
  assert.ok(retained, 'clearing setup must not destroy a previously enriched asset');
  assert.equal(retained.source_ref, null, 'clearing setup must release lineage so a later item cannot rename the retained asset');
  assert.equal((await client.post(`/workspaces/${workspaceId}/intake/field`, {
    question_id: 'crown-jewel-51', answer: 'Out of range'
  })).status, 400);
});

test('asset editor updates governed fields, syncs intake names, and rejects stale writes', async () => {
  let asset = db.prepare(`SELECT * FROM assets WHERE workspace_id=? AND source_ref='crown-jewel-1'`).get(workspaceId);
  const editPage = await client.get(`/workspaces/${workspaceId}/assets/${asset.id}?edit=1`);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, /Edit asset/);
  assert.match(editPage.text, /Linked to Crown jewel #1 in Client setup/);
  assert.match(editPage.text, /Save changes/);

  const updated = await client.post(`/workspaces/${workspaceId}/assets/${asset.id}`, {
    version: String(asset.version),
    name: 'Customer authentication and identity vault',
    type: 'information', classification: 'confidential', owner_name: 'Identity platform team',
    cia_c: '3', cia_i: '3', cia_a: '2',
    description: 'Authoritative customer identity and authentication records.',
    business_criticality: 'low', rto_hours: '4', rpo_hours: '1',
    bia_notes: 'Loss prevents customer authentication and account recovery.'
  });
  assert.equal(updated.status, 302);
  asset = db.prepare(`SELECT * FROM assets WHERE id=?`).get(asset.id);
  assert.equal(asset.name, 'Customer authentication and identity vault');
  assert.equal(asset.owner_name, 'Identity platform team');
  assert.equal(asset.classification, 'confidential');
  assert.equal(asset.cia_a, 2);
  assert.equal(asset.business_criticality, 'critical', 'intake-linked crown jewels cannot be downgraded');
  assert.equal(asset.rto_hours, 4);
  assert.equal(asset.rpo_hours, 1);
  assert.equal(asset.version, 2);
  assert.equal(db.prepare(`SELECT answer FROM engagement_intake WHERE workspace_id=? AND question_id='crown-jewel-1'`).get(workspaceId).answer,
    'Customer authentication and identity vault');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND action='update_asset' AND entity_id=?`).get(workspaceId, String(asset.id)));

  const stale = await client.post(`/workspaces/${workspaceId}/assets/${asset.id}`, {
    version: '1', name: asset.name, type: asset.type, classification: asset.classification,
    owner_name: 'Stale owner', cia_c: '3', cia_i: '3', cia_a: '2', business_criticality: 'critical'
  });
  assert.equal(stale.status, 302);
  assert.match(stale.location, /toastKind=error/);
  assert.equal(db.prepare(`SELECT owner_name FROM assets WHERE id=?`).get(asset.id).owner_name, 'Identity platform team');
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

test('the shared deliverable state machine rejects evidence-free submission', async () => {
  const deliverable = db.prepare(`SELECT d.* FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_plans p ON p.id=d.plan_id
    WHERE p.workspace_id=? AND m.milestone_key='w1-intake'`).get(workspaceId);
  assert.ok(deliverable);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM engagement_delivery_evidence WHERE deliverable_id=?`).get(deliverable.id).c, 0);
  const response = await client.post(`/workspaces/${workspaceId}/engagement-plan/deliverables/${deliverable.id}/submit`, {
    note: 'Attempted without evidence'
  });
  assert.equal(response.status, 302);
  assert.match(response.location, /toastKind=error/);
  assert.equal(db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE id=?`).get(deliverable.id).status, 'draft');
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
  assert.equal(replacement.client_title, row.client_title);
  assert.equal(replacement.client_description, row.client_description);
  assert.equal(replacement.framework_code, row.framework_code);
  assert.equal(replacement.requirement_refs, row.requirement_refs);
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

test('a complete imported baseline can be adopted once as an auditable, reportable Pass 1', async () => {
  const firmId = db.prepare('SELECT firm_id FROM workspaces WHERE id=?').get(workspaceId).firm_id;
  const importedWorkspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,target_cert_date,created_at)
    VALUES (?, 'Imported Baseline Client', 'gap_assessment', '2027-12-31', '2026-01-01')`).run(firmId).lastInsertRowid);
  const requirements = db.prepare(`SELECT rq.id AS requirement_id, rq.ref
    FROM requirements rq INNER JOIN frameworks f ON f.id=rq.framework_id
    INNER JOIN iso_items i ON i.id=rq.ref
    WHERE f.code='iso27001' AND i.type IN ('clause','control')
    ORDER BY i.sort_order`).all();
  assert.equal(requirements.length, 118);
  const insertState = db.prepare(`INSERT INTO control_instances
    (workspace_id,requirement_id,entity_id,applicability,status,maturity,scope_pct,notes,last_updated)
    VALUES (?,?,NULL,'applicable','implemented',3,100,'Imported conclusion','2026-07-01 09:00:00')`);
  db.transaction(() => requirements.forEach(row => insertState.run(importedWorkspaceId, row.requirement_id)))();

  const before = await client.get(`/workspaces/${importedWorkspaceId}/gap-assessment`);
  assert.equal(before.status, 200);
  assert.match(before.text, /Imported assessment baseline · current status report available/);
  assert.match(before.text, /Adopt baseline and enable reports/);
  assert.match(before.text, new RegExp(`/workspaces/${importedWorkspaceId}/export/gap-report\\.pdf`));
  assert.match(before.text, /Working snapshot/);

  const currentReport = await client.get(`/workspaces/${importedWorkspaceId}/export/gap-report.docx`);
  assert.equal(currentReport.status, 200);
  assert.match(String(currentReport.headers['content-type']), /wordprocessingml/);
  assert.match(currentReport.text, /^PK/);

  const adopted = await client.post(`/workspaces/${importedWorkspaceId}/gap-assessment/adopt-baseline`, {});
  assert.equal(adopted.status, 302);
  assert.match(decodeURIComponent(adopted.location), /Imported baseline adopted as Pass 1/);
  const pass = db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=?`).get(importedWorkspaceId);
  assert.equal(pass.pass_number, 1);
  assert.equal(pass.status, 'completed');
  assert.equal(pass.label, 'Imported assessment baseline');
  assert.equal(pass.started_by, managerId);
  assert.equal(pass.completed_by, managerId);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND pass_id=?`).get(importedWorkspaceId, pass.id).c, 118);

  const audit = db.prepare(`SELECT a.details,c.entry_hash FROM audit_log a
    INNER JOIN audit_chain c ON c.audit_log_id=a.id
    WHERE a.workspace_id=? AND a.action='adopt_assessment_baseline' ORDER BY a.id DESC LIMIT 1`).get(importedWorkspaceId);
  assert.ok(audit);
  assert.ok(audit.entry_hash);
  const auditDetails = JSON.parse(audit.details);
  assert.equal(auditDetails.item_count, 118);
  assert.match(auditDetails.snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.equal(auditDetails.source_first_updated_at, '2026-07-01 09:00:00');
  assert.equal(auditDetails.source_last_updated_at, '2026-07-01 09:00:00');

  const after = await client.get(`/workspaces/${importedWorkspaceId}/gap-assessment`);
  assert.equal(after.status, 200);
  assert.match(after.text, /Current status PDF/);
  assert.match(after.text, new RegExp(`/export/gap-report\\.pdf\\?pass=${pass.id}`));
  assert.match(after.text, new RegExp(`/export/gap-report\\.docx\\?pass=${pass.id}`));

  const duplicate = await client.post(`/workspaces/${importedWorkspaceId}/gap-assessment/adopt-baseline`, {});
  assert.equal(duplicate.status, 302);
  assert.match(decodeURIComponent(duplicate.location), /already has formal assessment-pass history/);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM assessment_passes WHERE workspace_id=?`).get(importedWorkspaceId).c, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=?`).get(importedWorkspaceId).c, 118);
});

test('baseline adoption stays locked until every requirement has a conclusion', async () => {
  const firmId = db.prepare('SELECT firm_id FROM workspaces WHERE id=?').get(workspaceId).firm_id;
  const partialWorkspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,target_cert_date,created_at)
    VALUES (?, 'Partial Baseline Client', 'gap_assessment', '2027-12-31', '2026-01-01')`).run(firmId).lastInsertRowid);
  const requirements = db.prepare(`SELECT rq.id AS requirement_id
    FROM requirements rq INNER JOIN frameworks f ON f.id=rq.framework_id
    INNER JOIN iso_items i ON i.id=rq.ref
    WHERE f.code='iso27001' AND i.type IN ('clause','control')
    ORDER BY i.sort_order LIMIT 117`).all();
  const insertState = db.prepare(`INSERT INTO control_instances
    (workspace_id,requirement_id,entity_id,applicability,status,maturity,scope_pct)
    VALUES (?,?,NULL,'applicable','implemented',3,100)`);
  db.transaction(() => requirements.forEach(row => insertState.run(partialWorkspaceId, row.requirement_id)))();

  const page = await client.get(`/workspaces/${partialWorkspaceId}/gap-assessment`);
  assert.equal(page.status, 200);
  assert.match(page.text, /1 CONCLUSIONS REMAIN/);
  assert.doesNotMatch(page.text, /Adopt baseline and enable reports/);
  assert.match(page.text, /1 requirement will appear as Not Assessed in the report/);
  assert.match(page.text, new RegExp(`/workspaces/${partialWorkspaceId}/export/gap-report\\.pdf`));
  const rejected = await client.post(`/workspaces/${partialWorkspaceId}/gap-assessment/adopt-baseline`, {});
  assert.equal(rejected.status, 302);
  assert.match(decodeURIComponent(rejected.location), /1 requirement still needs a conclusion/);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM assessment_passes WHERE workspace_id=?`).get(partialWorkspaceId).c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=?`).get(partialWorkspaceId).c, 0);
});

test('formal gap-assessment outputs and pass completion require decision-ready coverage', async () => {
  const passId = Number(db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,status,started_by)
    VALUES (?,1,'Initial gap assessment','in_progress',?)`).run(workspaceId, managerId).lastInsertRowid);

  const gatedPage = await client.get(`/workspaces/${workspaceId}/gap-assessment`);
  assert.equal(gatedPage.status, 200);
  assert.match(gatedPage.text, /Pass completion locked/);
  assert.match(gatedPage.text, /118 requirements still need a recorded conclusion/);
  assert.match(gatedPage.text, new RegExp(`/export/gap-report\\.pdf\\?pass=${passId}`));
  assert.match(gatedPage.text, new RegExp(`/export/gap-report\\.docx\\?pass=${passId}`));

  const workspace = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(workspaceId);
  const workingData = gapAssessmentReport.buildGapAssessmentReportData(db, workspace, null, { currentState: true });
  assert.equal(workingData.currentState, true);
  assert.equal(workingData.notAssessedCount, 118);
  assert.equal(workingData.rows.length, 118);
  const workingHtml = gapAssessmentReport.renderGapAssessmentHtml(workingData);
  assert.match(workingHtml, /118 requirements have not yet been assessed/);
  assert.match(workingHtml, /NOT ASSESSED/);

  const prematureComplete = await client.post(`/workspaces/${workspaceId}/gap-assessment/${passId}/complete`, {});
  assert.equal(prematureComplete.status, 302);
  assert.match(prematureComplete.location, /toastKind=error/);
  assert.equal(db.prepare('SELECT status FROM assessment_passes WHERE id=?').get(passId).status, 'in_progress');

  const prematureReport = await client.get(`/workspaces/${workspaceId}/export/gap-report.docx?pass=${passId}`);
  assert.equal(prematureReport.status, 200);
  assert.match(String(prematureReport.headers['content-type']), /wordprocessingml/);
  assert.match(prematureReport.text, /^PK/);

  const itemIds = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order`).all();
  assert.equal(itemIds.length, 118);
  const saveConclusion = db.prepare(`INSERT INTO control_state_history
    (workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,pass_id)
    VALUES (?,?,?,'Implemented','included',3,'Verified for regression coverage',?)`);
  db.transaction(() => itemIds.forEach(item => saveConclusion.run(workspaceId, item.id, managerId, passId)))();
  db.prepare(`INSERT INTO control_state_history
    (workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,pass_id)
    VALUES (?,'clause-4.1',?,'Not Implemented','included',0,'Organizational context is not documented or approved.',?)`)
    .run(workspaceId, managerId, passId);
  db.prepare(`INSERT INTO evidence (workspace_id,iso_item_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?,'clause-4.1','scope-workshop-notes.pdf','scope-workshop-notes.pdf','report-evidence-sha',256,?,'Assessment workshop record')`)
    .run(workspaceId, managerId);
  db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,description,severity,iso_item_id,corrective_action,responsible,due_date,status)
    VALUES (?,'Organizational context not documented','No approved context analysis is retained.','major','clause-4.1','Approve the context and interested-parties analysis.','ISMS Manager','2027-02-01','open')`)
    .run(workspaceId);

  const readyPage = await client.get(`/workspaces/${workspaceId}/gap-assessment`);
  assert.equal(readyPage.status, 200);
  assert.doesNotMatch(readyPage.text, /Pass completion locked/);
  assert.match(readyPage.text, new RegExp(`/export/gap-report\\.pdf\\?pass=${passId}`));
  assert.match(readyPage.text, new RegExp(`/export/gap-report\\.docx\\?pass=${passId}`));

  const wordReport = await client.get(`/workspaces/${workspaceId}/export/gap-report.docx?pass=${passId}`);
  assert.equal(wordReport.status, 200, wordReport.text.slice(0, 300));
  assert.match(String(wordReport.headers['content-type']), /wordprocessingml/);
  assert.match(wordReport.text, /^PK/);

  const pdfReport = await client.get(`/workspaces/${workspaceId}/export/gap-report.pdf?pass=${passId}`);
  assert.equal(pdfReport.status, 200, pdfReport.text.slice(0, 300));
  assert.match(String(pdfReport.headers['content-type']), /^application\/pdf/);
  assert.match(pdfReport.text, /^%PDF-/);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND action='export_gap_assessment_pdf'`).get(workspaceId));

  const complete = await client.post(`/workspaces/${workspaceId}/gap-assessment/${passId}/complete`, {});
  assert.equal(complete.status, 302);
  assert.equal(db.prepare('SELECT status FROM assessment_passes WHERE id=?').get(passId).status, 'completed');
});
