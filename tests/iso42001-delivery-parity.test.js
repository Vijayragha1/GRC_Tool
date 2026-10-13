'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
let env, client, db, ws, actor, maker, delivery, aims, assessment, reportId;
test.before(async () => {
  env = await bootClient(); client = env.client; db = new Database(env.dbPath);
  actor = db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  maker = Number(db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES('ai-delivery-maker@example.test','unused','AI Preparer',?,'firm','manager',1)").run(actor.firm_id).lastInsertRowid);
  const created = await client.post('/workspaces', { client_name: 'AI governed delivery', frameworks: 'iso42001', engagement_outcome: 'gap_assessment_only', scope: 'AI support service' });
  assert.equal(created.status, 302);
  ws = db.prepare("SELECT * FROM workspaces WHERE client_name='AI governed delivery'").get();
  ws.frameworks = JSON.parse(ws.frameworks);
  delivery = require('../lib/engagement-delivery'); aims = require('../lib/iso42001-delivery'); assessment = require('../lib/iso42001-assessment');
});
test.after(async () => { db?.close(); await client?.close(); });

test('shared AIMS plan has AI content, protected gates, working views and safe legacy redirect', async () => {
  const projection = delivery.getProjection(db, ws, actor.id);
  assert.match(projection.plan.name, /ISO 42001 gap assessment/);
  assert.deepEqual(projection.phases.map(p => p.phase_key), ['gap_assessment']);
  assert.equal(projection.summary.completionReady, false);
  reportId = projection.deliverables[0].id;
  assert.equal(projection.deliverables[0].framework_code, 'iso42001');
  for (const view of ['plan', 'timeline', 'gates']) {
    const result = await client.get(`/workspaces/${ws.id}/engagement-plan?view=${view}`);
    assert.equal(result.status, 200, result.text.slice(-1200));
    assert.match(result.text, /ISO 42001 gap assessment delivery plan/);
    assert.doesNotMatch(result.text, /href="\/workspaces\/\d+\/gap-assessment\/fieldwork"/);
  }
  assert.equal((await client.get(`/workspaces/${ws.id}/iso42001/engagement-plan?view=gates`)).location, `/workspaces/${ws.id}/engagement-plan?view=gates`);
  assert.equal((await client.post(`/workspaces/${ws.id}/iso42001/engagement-plan/kickoff/toggle`, {})).status, 409);
  assert.throws(() => delivery.decideGate(db, ws, actor.id, projection.phases[0].id, 'waived', 'Skip review', '2029-01-01'), /cannot be manually/);
  assert.equal((await client.get(`/workspaces/${ws.id}/iso42001/cert-cycle`)).status, 409);
  assert.equal((await client.post(`/workspaces/${ws.id}/iso42001/checklist`, {})).status, 409);
  assert.equal((await client.get(`/workspaces/${ws.id}/iso42001/requests`)).status, 409);
});

test('report publication and closure reject incomplete assessment and evidence-free acceptance', async () => {
  for (const action of ['publish-report','close-gap']) {
    const result = await client.post(`/workspaces/${ws.id}/engagement-plan/${action}`, { note: 'Close engagement' });
    assert.match(result.location, /toastKind=error/);
  }
  assert.throws(() => delivery.transitionDeliverable(db, ws, maker, reportId, 'submit'), /evidence|assessment/i);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id).status, 'active');
});

function concludePass() {
  const passId = assessment.startPass(db, ws.id, maker);
  for (const item of db.prepare('SELECT * FROM iso42001_items ORDER BY sort_order').all()) {
    const rid = require('../lib/control-writes').requirementId(db, 'iso42001', item.id);
    const note = `Observed ${item.title} is not yet implemented; the client must establish and evidence this requirement.`;
    db.prepare("INSERT INTO control_instances(workspace_id,requirement_id,entity_id,status,applicability,maturity,notes) VALUES(?,?,NULL,'not_implemented','applicable',0,?)").run(ws.id, rid, note);
    const c = db.prepare('SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(ws.id, item.id);
    db.prepare(`INSERT INTO iso42001_control_state_history(workspace_id,iso_item_id,pass_id,changed_by,status,applicability,maturity,inclusion_justification,exclusion_justification,notes,assessment_answers) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(ws.id,item.id,passId,maker,c.status,c.applicability,c.maturity,c.inclusion_justification,c.exclusion_justification,c.notes,c.assessment_answers);
  }
  assessment.completePass(db, ws.id, passId, actor.id);
  return passId;
}

test('reviewed assessment, independent report approval, publication and formal closure complete gap-only delivery', async () => {
  concludePass();
  const gap = aims.gapContext(db, ws); assert.equal(gap.complete, true); assert.ok(gap.snapshotHash);
  const evidence = Number(db.prepare("INSERT INTO evidence(workspace_id,filename,stored_path,size_bytes,sha256,uploaded_by) VALUES(?,'controlled-report.txt','controlled-report.txt',10,?,?)").run(ws.id, 'a'.repeat(64), maker).lastInsertRowid);
  db.prepare('INSERT INTO engagement_delivery_evidence(workspace_id,deliverable_id,evidence_id,linked_by) VALUES(?,?,?,?)').run(ws.id,reportId,evidence,maker);
  db.prepare('UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=? WHERE id=?').run(maker,actor.id,reportId);
  delivery.transitionDeliverable(db, ws, maker, reportId, 'submit');
  db.prepare('UPDATE engagement_delivery_deliverables SET approver_id=? WHERE id=?').run(maker,reportId);
  assert.throws(() => delivery.transitionDeliverable(db, ws, maker, reportId, 'accept'), /different assigned reviewer/);
  db.prepare('UPDATE engagement_delivery_deliverables SET approver_id=? WHERE id=?').run(actor.id,reportId);
  delivery.transitionDeliverable(db, ws, actor.id, reportId, 'accept');
  assert.equal(aims.gapContext(db, ws).completed.report, false, 'acceptance alone is not publication');
  const publish = await client.post(`/workspaces/${ws.id}/engagement-plan/publish-report`, {});
  assert.doesNotMatch(publish.location, /toastKind=error/);
  assert.equal(aims.gapContext(db, ws).completed.report, true);
  const mutate = await client.post(`/workspaces/${ws.id}/engagement-plan/deliverables/${reportId}/evidence/link`, { evidence_id: evidence });
  assert.match(mutate.location, /toastKind=error/);
  assert.equal(delivery.getProjection(db, ws, actor.id).summary.completionReady, false, 'formal closure remains required');
  const close = await client.post(`/workspaces/${ws.id}/engagement-plan/close-gap`, { note: 'Approved report delivered; recommendations handed over to client.' });
  assert.doesNotMatch(close.location, /toastKind=error/);
  assert.equal(delivery.getProjection(db, ws, actor.id).summary.completionReady, true);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id).status, 'completed');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE workspace_id=?').get(ws.id).status, 'complete');
});

test('reopening the approved report invalidates and reopens both linked completion records', () => {
  delivery.transitionDeliverable(db, ws, actor.id, reportId, 'changes', 'New material information requires report revision.');
  assert.equal(delivery.getProjection(db, ws, actor.id).summary.completionReady, false);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id).status, 'active');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE workspace_id=?').get(ws.id).status, 'active');
});

test('reapproval cannot reuse an earlier publication or closure decision', async () => {
  delivery.transitionDeliverable(db, ws, maker, reportId, 'submit');
  delivery.transitionDeliverable(db, ws, actor.id, reportId, 'accept');
  assert.equal(aims.gapContext(db, ws).completed.report, false);
  assert.equal(aims.gapContext(db, ws).closure.complete, false);
  await client.post(`/workspaces/${ws.id}/engagement-plan/publish-report`, {});
  assert.equal(aims.gapContext(db, ws).completed.report, true);
  assert.equal(aims.gapContext(db, ws).closure.complete, false, 'fresh publication needs a new closure decision');
});

test('full certification uses AI requirements and actual assurance records, never ISMS readiness or manual phase ticks', async () => {
  const full = { ...ws, engagement_outcome: 'certification_support' };
  const projection = delivery.getProjection(db, full, actor.id);
  assert.equal(projection.phases.length, 12);
  assert.ok(projection.milestones.some(m => /impacts on individuals/.test(m.title)));
  assert.ok(projection.deliverables.every(d => d.framework_code === 'iso42001'));
  assert.equal(projection.summary.readinessReady, false);
  assert.equal(projection.summary.stage1AuditComplete, false);
  assert.equal(projection.summary.completionReady, false);
  assert.doesNotMatch(projection.milestones.map(m => `${m.title} ${m.description}`).join(' '), /30 risks|30-50 assets|ISMS|information.security/i);
});
