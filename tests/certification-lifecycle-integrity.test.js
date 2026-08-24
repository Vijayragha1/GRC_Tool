'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-cert-integrity-'));
process.env.DB_PATH = path.join(tmpDir, 'iso27001.db');
process.env.ISMS_KEY_FILE = path.join(tmpDir, 'master.key');

const { db, init } = require('../db');
init();
const delivery = require('../lib/engagement-delivery');
const governanceRoutes = require('../routes/governance');

let firmId;
let actorId;

function workspace(name, frameworks = ['iso27001']) {
  const id = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,created_at)
    VALUES (?,?,'implementation',?,'certification_support','2026-01-01')`).run(
      firmId, name, JSON.stringify(frameworks)).lastInsertRowid);
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = frameworks;
  return row;
}

function completedEngagement(ws) {
  return Number(db.prepare(`INSERT INTO consulting_engagements
    (workspace_id,engagement_code,name,engagement_type,framework_scope_json,status,lead_consultant_id,created_by,completed_at)
    VALUES (?,?,?,'implementation','["iso27001"]','complete',?,?,datetime('now'))`).run(
      ws.id, `ENG-${ws.id}`, `${ws.client_name} delivery`, actorId, actorId).lastInsertRowid);
}

test.before(() => {
  firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  actorId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Stage 1 and Stage 2 accept only valid, unique and chronological audit records', () => {
  const ws = workspace('Certification event integrity client');
  assert.equal(delivery.isValidISODate('2028-02-29'), true);
  assert.equal(delivery.isValidISODate('2027-02-29'), false);
  assert.equal(delivery.isValidISODate('2027-2-09'), false);

  let result = delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_1', planned_date: '2027-02-29', status: 'planned'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /valid ISO date/i);

  result = delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_2', actual_date: '2027-09-01', status: 'closed'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /until exactly one retained Stage 1/i);

  const stage1Id = Number(db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-09-10','closed')`)
    .run(ws.id).lastInsertRowid);
  result = delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_2', actual_date: '2027-09-01', status: 'closed'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /cannot be before/i);

  result = delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_2', actual_date: '2027-09-11', status: 'closed'
  });
  assert.equal(result.valid, true);
  db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_2','2027-09-11','closed')`).run(ws.id);

  result = delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_1', actual_date: '2027-09-12', status: 'closed'
  }, { excludeEventId: stage1Id });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /cannot be after/i);

  result = delivery.validateCertificationEvent(db, ws.id, {
    event_type: 'stage_1', actual_date: '2027-09-10', status: 'closed'
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /already exists/i);

  db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-09-10','closed')`).run(ws.id);
  const ambiguous = delivery.certificationAuditState(db, ws.id, 'stage_1');
  assert.equal(ambiguous.eventCount, 2);
  assert.equal(ambiguous.duplicateEvents, 1);
  assert.equal(ambiguous.auditComplete, false, 'duplicate legacy rows cannot satisfy the completion gate');
  assert.equal(delivery.stage2AssuranceState(db, ws.id).auditComplete, false,
    'Stage 2 cannot satisfy completion while Stage 1 lineage is ambiguous');

  const invalidLegacy = workspace('Invalid legacy certification date client');
  db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,planned_date,actual_date,status)
    VALUES (?,'stage_1','2027-02-29','2027-03-01','closed')`).run(invalidLegacy.id);
  const invalidState = delivery.certificationAuditState(db, invalidLegacy.id, 'stage_1');
  assert.equal(invalidState.invalidDateEvents, 1);
  assert.equal(invalidState.auditComplete, false, 'an invalid retained planned date cannot satisfy the audit gate');
});

test('an invalidated completed plan reopens together with only its linked consulting engagement', () => {
  const ws = workspace('Reconciliation client');
  const engagementId = completedEngagement(ws);
  const plan = delivery.ensurePlan(db, ws, actorId);
  db.prepare(`UPDATE engagement_delivery_plans SET status='completed',consulting_engagement_id=? WHERE id=?`)
    .run(engagementId, plan.id);
  const stage1Id = Number(db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-08-01','closed')`)
    .run(ws.id).lastInsertRowid);
  const findingId = Number(db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'Reopened Stage 1 observation','external_audit',?,'observation','open')`).run(
      ws.id, `cert_cycle_event:${stage1Id}`).lastInsertRowid);

  assert.equal(delivery.certificationFindingLineage(db, ws.id, findingId).event_type, 'stage_1');
  const reconciled = delivery.reconcileCompletionState(db, ws, actorId, {
    reason: 'A generic status change reopened the certification observation.',
    details: { finding_id: findingId }
  });
  assert.equal(reconciled.planReopened, true);
  assert.equal(reconciled.engagementReopened, true);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id).status, 'active');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'active');
  assert.ok(db.prepare(`SELECT 1 FROM engagement_delivery_events
    WHERE plan_id=? AND action='reopened_after_completion_invalidated'`).get(plan.id));
  assert.ok(db.prepare(`SELECT 1 FROM consulting_events
    WHERE engagement_id=? AND action='reopened_after_completion_invalidated'`).get(engagementId));

  assert.equal(delivery.reconcileCompletionState(db, ws, actorId).changed, false,
    'reconciliation is idempotent after both records are active');

  db.prepare(`UPDATE engagement_delivery_plans SET status='completed' WHERE id=?`).run(plan.id);
  db.prepare(`UPDATE consulting_engagements SET status='complete',completed_at=datetime('now') WHERE id=?`).run(engagementId);
  const synced = delivery.syncOutcomePlanStatus(db, ws, actorId);
  assert.equal(synced.changed, true, 'status synchronization also reconciles a stale completed record');
  assert.equal(synced.status, 'active');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'active');
});

test('explicit non-ISO workspaces cannot seed or project an ISO delivery plan', () => {
  const nonIso = workspace('ISO 42001 only client', ['iso42001']);
  assert.equal(delivery.ensurePlan(db, nonIso, actorId), null);
  assert.equal(delivery.getProjection(db, nonIso, actorId), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(nonIso.id).c, 0);

  const legacy = workspace('Legacy unselected framework fixture', []);
  const legacyPlan = delivery.ensurePlan(db, legacy, actorId);
  assert.ok(legacyPlan, 'empty legacy fixtures retain backward-compatible plan behavior');
  const fullDeliverable = db.prepare(`SELECT id FROM engagement_delivery_deliverables WHERE plan_id=? ORDER BY id LIMIT 1`)
    .get(legacyPlan.id);
  assert.equal(delivery.isDeliverableInOutcomeScope(db, legacy, fullDeliverable.id), true);
  assert.equal(delivery.isDeliverableInOutcomeScope(db, nonIso, fullDeliverable.id), false);
});

test('generic governance routes cannot rewrite or delete certification finding lineage', () => {
  const ws = workspace('Immutable finding lineage client');
  const eventId = Number(db.prepare(`INSERT INTO cert_cycle_events
    (workspace_id,event_type,actual_date,status) VALUES (?,'stage_1','2027-08-01','closed')`)
    .run(ws.id).lastInsertRowid);
  const findingId = Number(db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'Certification finding','external_audit',?,'minor','open')`).run(
      ws.id, `cert_cycle_event:${eventId}`).lastInsertRowid);

  const handlers = {};
  const middleware = (_req, _res, next) => next();
  const app = {
    get() {},
    post(route, ...stack) { handlers[route] = stack[stack.length - 1]; }
  };
  governanceRoutes.register(app, {
    db,
    requireAuth: middleware,
    requireWorkspace: middleware,
    requirePermission: () => middleware,
    logAction() {},
    workspaceProgress() { return {}; }
  });
  const response = () => ({
    statusCode: 200,
    redirected: null,
    status(code) { this.statusCode = code; return this; },
    send(message) { this.message = message; return message; },
    redirect(url) { this.redirected = url; return url; }
  });

  let res = response();
  handlers['/workspaces/:wsId/nonconformities/:id']({
    params: { id: String(findingId) },
    workspace: ws,
    user: { id: actorId },
    body: { source: 'other', source_ref: '', status: 'open' }
  }, res);
  assert.match(res.redirected, /toastKind=error/);
  let retained = db.prepare('SELECT source,source_ref FROM nonconformities WHERE id=?').get(findingId);
  assert.equal(retained.source, 'external_audit');
  assert.equal(retained.source_ref, `cert_cycle_event:${eventId}`);

  res = response();
  handlers['/workspaces/:wsId/nonconformities/:id/delete']({
    params: { id: String(findingId) }, workspace: ws, user: { id: actorId }, body: {}
  }, res);
  assert.match(res.redirected, /toastKind=error/);
  retained = db.prepare('SELECT id FROM nonconformities WHERE id=?').get(findingId);
  assert.equal(retained.id, findingId);
});
