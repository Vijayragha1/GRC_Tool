'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-outcome-scope-'));
process.env.DB_PATH = path.join(tmpDir, 'iso27001.db');
process.env.ISMS_KEY_FILE = path.join(tmpDir, 'master.key');

const { db, init } = require('../db');
init();
const delivery = require('../lib/engagement-delivery');
const scope = require('../lib/engagement-outcome-scope');
const notificationsRoutes = require('../routes/notifications');
const dashboardRoutes = require('../routes/dashboard');
const workspaceOpsRoutes = require('../routes/workspace-ops');
const jobs = require('../lib/jobs');
const { buildIntegratedDashboard } = require('../lib/integrated-dashboard');

let firmId;
let managerId;
let clientId;

function createWorkspace(name, outcome) {
  const id = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,target_cert_date,created_at)
    VALUES (?,?,'gap_assessment','["iso27001"]',?,'2026-12-31','2026-01-01')`)
    .run(firmId, name, outcome).lastInsertRowid);
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = ['iso27001'];
  return row;
}

function captureRoutes(register, deps) {
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
  };
  register(app, deps);
  return routes;
}

test.before(() => {
  firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  clientId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,firm_id,user_type,active)
    VALUES ('outcome-scope-client@example.com','not-used','Outcome Scope Client',?,'client',1)`)
    .run(firmId).lastInsertRowid);
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('shared scope distinguishes full support, gap-only, and non-ISO programmes', () => {
  const gap = { frameworks: '["iso27001"]', engagement_outcome: 'gap_assessment_only' };
  const full = { frameworks: ['iso27001'], engagement_outcome: 'certification_support' };
  const generic = { frameworks: ['csf'], engagement_outcome: 'gap_assessment_only' };

  assert.equal(scope.workspaceMode(gap), scope.MODE.GAP_ASSESSMENT);
  assert.equal(scope.workspaceMode(full), scope.MODE.CERTIFICATION);
  assert.equal(scope.workspaceMode(generic), scope.MODE.GENERIC);
  assert.equal(scope.isPhaseInContract(gap, 'gap_assessment'), true);
  assert.equal(scope.isPhaseInContract(gap, 'stage_1'), false);
  assert.equal(scope.isPhaseInContract(full, 'stage_1'), true);
  assert.equal(scope.isPhaseInContract(generic, 'stage_1'), true,
    'a non-ISO programme remains generic rather than inheriting ISO outcome semantics');
  assert.equal(scope.phaseSqlForWorkspace(gap, 'phase'), "phase.phase_key='gap_assessment'");
  assert.throws(() => scope.phaseSqlForWorkspace(gap, 'phase;DROP TABLE workspaces'), /Invalid phase alias/);
});

test('certification-cycle and task routes enforce the service-path boundary without materialising plans', () => {
  const gap = createWorkspace('Gap Task Boundary Client', 'gap_assessment_only');
  const full = createWorkspace('Full Cert Boundary Client', 'certification_support');
  const gapPlan = delivery.ensurePlan(db, gap, managerId);
  const visible = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='gap_assessment' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hidden = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='stage_1' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hiddenDeliverable = db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE d.plan_id=? AND ph.phase_key='stage_1' ORDER BY d.id LIMIT 1`).get(gapPlan.id);
  assert.ok(visible && hidden && hiddenDeliverable);

  db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by) VALUES (?,'Generic contracted task','todo',?)`)
    .run(gap.id, managerId);
  db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by,engagement_milestone_id)
    VALUES (?,'Visible gap task','todo',?,?)`).run(gap.id, managerId, visible.id);
  db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by,engagement_milestone_id)
    VALUES (?,'Hidden certification task','todo',?,?)`).run(gap.id, managerId, hidden.id);
  const hiddenDeliverableTaskId = Number(db.prepare(`INSERT INTO tasks
    (workspace_id,title,status,created_by,engagement_deliverable_id)
    VALUES (?,'Hidden certification deliverable task','todo',?,?)`).run(
      gap.id, managerId, hiddenDeliverable.id).lastInsertRowid);

  const middleware = (_req, _res, next) => { if (next) next(); };
  const stacks = new Map();
  const app = {
    get(route, ...handlers) { stacks.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { stacks.set(`POST ${route}`, handlers); },
  };
  workspaceOpsRoutes.register(app, {
    db,
    requireAuth: middleware,
    requireWorkspace: middleware,
    requirePermission: () => middleware,
    logAction: () => {},
    csvUpload: { single: () => middleware },
    activeEntityFilter: () => ({ sql: '', params: [] }),
    getOrCreateState: () => {},
    isFirmUser: () => true,
  });

  const user = { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' };
  const response = () => ({
    statusCode: 200,
    rendered: null,
    redirected: null,
    status(code) { this.statusCode = code; return this; },
    render(view, locals) { this.rendered = { view, locals }; return this; },
    redirect(url) { this.redirected = url; return this; },
  });

  const certGuard = stacks.get('GET /workspaces/:wsId/cert-cycle').at(-2);
  let nextCalled = false;
  certGuard({ workspace: gap, user }, response(), () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'gap-only clients cannot enter the certification cycle');
  certGuard({ workspace: full, user }, response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'full ISO support can enter the certification cycle');

  const nonIsoId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,created_at)
    VALUES (?,'Programme Neutral Task Client','onboarding','[]','certification_support','2026-01-01')`)
    .run(firmId).lastInsertRowid);
  const nonIso = db.prepare('SELECT * FROM workspaces WHERE id=?').get(nonIsoId);
  nonIso.frameworks = [];
  nextCalled = false;
  const nonIsoGuardResponse = response();
  certGuard({ workspace: nonIso, user }, nonIsoGuardResponse, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(nonIsoGuardResponse.statusCode, 409);

  const getTasks = stacks.get('GET /workspaces/:wsId/tasks').at(-1);
  const gapTasksResponse = response();
  getTasks({ workspace: gap, user, query: { filter: 'all' } }, gapTasksResponse);
  const taskTitles = gapTasksResponse.rendered.locals.tasks.map(row => row.title);
  assert.ok(taskTitles.includes('Generic contracted task'));
  assert.ok(taskTitles.includes('Visible gap task'));
  assert.ok(!taskTitles.includes('Hidden certification task'));
  assert.ok(!taskTitles.includes('Hidden certification deliverable task'));
  assert.ok(gapTasksResponse.rendered.locals.planMilestones.every(row => row.id === visible.id
    || !db.prepare(`SELECT 1 FROM engagement_delivery_milestones m
      JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
      WHERE m.id=? AND ph.phase_key<>'gap_assessment'`).get(row.id)));

  const nonIsoTasksResponse = response();
  getTasks({ workspace: nonIso, user, query: { filter: 'all' } }, nonIsoTasksResponse);
  assert.equal(nonIsoTasksResponse.rendered.locals.planMilestones.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(nonIso.id).c, 0,
    'opening generic Tasks must not materialise an ISO plan for an unassigned programme');

  const createTask = stacks.get('POST /workspaces/:wsId/tasks').at(-1);
  const before = db.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id=?').get(gap.id).c;
  const blockedCreate = response();
  createTask({ workspace: gap, user, body: { title: 'Direct hidden task', engagement_milestone_id: String(hidden.id) } }, blockedCreate);
  assert.equal(blockedCreate.statusCode, 409);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id=?').get(gap.id).c, before);

  const allowedCreate = response();
  createTask({ workspace: gap, user, body: { title: 'Direct visible task', engagement_milestone_id: String(visible.id) } }, allowedCreate);
  assert.ok(allowedCreate.redirected);
  assert.equal(db.prepare(`SELECT engagement_milestone_id FROM tasks
    WHERE workspace_id=? AND title='Direct visible task'`).get(gap.id).engagement_milestone_id, visible.id);

  const genericTaskId = Number(db.prepare(`INSERT INTO tasks (workspace_id,title,status,created_by)
    VALUES (?,'Retarget boundary task','todo',?)`).run(gap.id, managerId).lastInsertRowid);
  const updateTask = stacks.get('POST /workspaces/:wsId/tasks/:id').at(-1);
  const blockedUpdate = response();
  updateTask({
    workspace: gap,
    user,
    params: { id: String(genericTaskId) },
    body: { engagement_milestone_id: String(hidden.id) }
  }, blockedUpdate);
  assert.equal(blockedUpdate.statusCode, 409);
  assert.equal(db.prepare('SELECT engagement_milestone_id FROM tasks WHERE id=?').get(genericTaskId).engagement_milestone_id, null);

  const hiddenTaskId = db.prepare(`SELECT id FROM tasks
    WHERE workspace_id=? AND title='Hidden certification task'`).get(gap.id).id;
  const blockedExistingUpdate = response();
  updateTask({ workspace: gap, user, params: { id: String(hiddenTaskId) }, body: { status: 'done' } }, blockedExistingUpdate);
  assert.equal(blockedExistingUpdate.statusCode, 409);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(hiddenTaskId).status, 'todo');

  const deleteTask = stacks.get('POST /workspaces/:wsId/tasks/:id/delete').at(-1);
  const blockedDelete = response();
  deleteTask({ workspace: gap, user, params: { id: String(hiddenDeliverableTaskId) }, body: {} }, blockedDelete);
  assert.equal(blockedDelete.statusCode, 409);
  assert.ok(db.prepare('SELECT id FROM tasks WHERE id=?').get(hiddenDeliverableTaskId),
    'a retained out-of-contract deliverable task cannot be deleted through the generic task route');
});

test('portfolio templates render service semantics instead of assuming certification for every row', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
  const portfolio = fs.readFileSync(path.join(__dirname, '..', 'views', 'portfolio.ejs'), 'utf8');

  // Bind to the service semantics rather than to column headings: a heading can
  // be renamed without changing behaviour, but reading w.truth / w.readiness
  // directly is the actual regression this guards against.
  assert.match(dashboard, /w\.service\.position/);
  assert.match(dashboard, /w\.service\.target/);
  assert.match(dashboard, /gap-assessment-only/);
  assert.doesNotMatch(dashboard, /[rw]\.truth\./);
  assert.doesNotMatch(dashboard, /[rw]\.readiness\./);
  assert.match(portfolio, /e\.service\.position/);
  assert.match(portfolio, /e\.gapAssessment\.reportState/);
});

test('all downstream readers ignore retained certification rows for a gap-only contract', () => {
  const gap = createWorkspace('Gap Scope Client', 'gap_assessment_only');
  const full = createWorkspace('Full Scope Client', 'certification_support');
  const gapPlan = delivery.ensurePlan(db, gap, managerId);
  const fullPlan = delivery.ensurePlan(db, full, managerId);
  const dueDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

  db.prepare('UPDATE engagement_delivery_milestones SET planned_end_date=NULL,forecast_end_date=NULL WHERE plan_id IN (?,?)')
    .run(gapPlan.id, fullPlan.id);
  db.prepare('UPDATE engagement_delivery_deliverables SET due_date=NULL WHERE plan_id IN (?,?)')
    .run(gapPlan.id, fullPlan.id);

  const visibleGapMilestone = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='gap_assessment' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hiddenGapMilestone = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE m.plan_id=? AND ph.phase_key='context' ORDER BY m.id LIMIT 1`).get(gapPlan.id);
  const hiddenGapDeliverable = db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE d.plan_id=? AND ph.phase_key='context' ORDER BY d.id LIMIT 1`).get(gapPlan.id);
  const fullDeliverable = db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE d.plan_id=? AND ph.phase_key='context' ORDER BY d.id LIMIT 1`).get(fullPlan.id);
  assert.ok(visibleGapMilestone && hiddenGapMilestone && hiddenGapDeliverable && fullDeliverable);

  db.prepare(`UPDATE engagement_delivery_milestones SET title='VISIBLE GAP MILESTONE',forecast_end_date=? WHERE id=?`)
    .run(dueDate, visibleGapMilestone.id);
  db.prepare(`UPDATE engagement_delivery_milestones SET title='HIDDEN CERT MILESTONE',forecast_end_date=? WHERE id=?`)
    .run(dueDate, hiddenGapMilestone.id);
  db.prepare(`UPDATE engagement_delivery_deliverables
    SET title='HIDDEN CERT DELIVERABLE',client_title='Hidden client action',due_date=?,owner_id=?,client_visible=1,status='draft'
    WHERE id=?`).run(dueDate, clientId, hiddenGapDeliverable.id);
  db.prepare(`UPDATE engagement_delivery_deliverables
    SET title='FULL CONTRACT DELIVERABLE',client_title='Full client action',due_date=?,owner_id=?,client_visible=1,status='draft'
    WHERE id=?`).run(dueDate, managerId, fullDeliverable.id);
  db.prepare(`INSERT INTO cert_cycle_events (workspace_id,event_type,planned_date,status)
    VALUES (?,'stage_1',?,'planned')`).run(gap.id, dueDate);

  const middleware = (_req, _res, next) => { if (next) next(); };
  const notificationHandlers = captureRoutes(notificationsRoutes.register, {
    db,
    requireAuth: middleware,
    requireWorkspace: middleware,
    requirePermission: () => middleware,
    logAction: () => {},
  });
  let workspaceCalendar;
  notificationHandlers.get('GET /workspaces/:wsId/calendar')({
    workspace: gap,
    user: { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' },
    query: { month: dueDate.slice(0, 7) },
  }, {
    render(_view, locals) { workspaceCalendar = locals; },
  });
  const workspaceEvents = workspaceCalendar.cells.filter(Boolean).flatMap(cell => cell.events);
  assert.ok(workspaceEvents.some(event => event.title === 'VISIBLE GAP MILESTONE'));
  assert.ok(!workspaceEvents.some(event => event.title === 'HIDDEN CERT MILESTONE'));
  assert.ok(!workspaceEvents.some(event => event.title === 'HIDDEN CERT DELIVERABLE'));
  assert.ok(!workspaceEvents.some(event => event.kind === 'cert'));

  const dashboardDeps = {
    db,
    requireAuth: middleware,
    logAction: () => {},
    isFirmUser: user => user.user_type === 'firm',
    isFirmOwner: () => true,
    getActiveFirmId: user => user.firm_id,
    listWorkspaces: () => [gap],
    workspaceProgress: () => ({ assessed: 0, total: 118, percent: 0 }),
  };
  const dashboardHandlers = captureRoutes(dashboardRoutes.register, dashboardDeps);
  let managerCalendar;
  dashboardHandlers.get('GET /calendar')({
    user: { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' },
    query: { month: dueDate.slice(0, 7) },
  }, {
    status() { return this; },
    render(_view, locals) { managerCalendar = locals; },
  });
  const managerEvents = managerCalendar.cells.filter(Boolean).flatMap(cell => cell.events);
  assert.ok(managerEvents.some(event => event.title === 'VISIBLE GAP MILESTONE'));
  assert.ok(!managerEvents.some(event => event.title === 'HIDDEN CERT MILESTONE'));
  assert.ok(!managerEvents.some(event => event.title === 'HIDDEN CERT DELIVERABLE'));
  assert.ok(!managerEvents.some(event => event.kind === 'cert'));

  let dashboard;
  dashboardHandlers.get('GET /dashboard')({
    user: { id: managerId, firm_id: firmId, user_type: 'firm', firm_role: 'manager' },
  }, {
    redirect() { throw new Error('unexpected redirect'); },
    status() { return this; },
    render(_view, locals) { dashboard = locals; },
  });
  // Addressed by name, not index: the dashboard now orders clients by attention
  // severity, so position is not stable.
  const gapRow = dashboard.workspaces.find(w => w.client_name === 'Gap Scope Client');
  assert.ok(gapRow, 'the gap-only client must appear on the dashboard');
  assert.equal(gapRow.readiness, null);
  assert.equal(gapRow.truth, null);
  assert.equal(gapRow.service.path, 'Gap assessment only');
  assert.match(gapRow.service.targetDetail, /gap-assessment report/i);
  assert.equal(dashboard.totals.certification, 0);
  assert.equal(dashboard.totals.nearCert, 0);
  // The at-risk table was folded into the client row, so the reasons that must
  // never mention certification now travel on w.attention.
  assert.ok(dashboard.workspaces.every(row =>
    (row.attention.reasons || []).every(reason => !/cert target|readiness gap|truth conflict/i.test(reason))));

  const clientTruth = buildIntegratedDashboard(db, gap, {
    actorId: clientId,
    clientFacing: true,
    today: dueDate,
  }).client;
  assert.ok(!clientTruth.actions.some(action => action.id === hiddenGapDeliverable.id));

  db.prepare('DELETE FROM notifications WHERE workspace_id IN (?,?)').run(gap.id, full.id);
  jobs.jobEngagementDeliveryAlerts();
  const gapNotifications = db.prepare(`SELECT title FROM notifications WHERE workspace_id=?`).all(gap.id);
  const fullNotifications = db.prepare(`SELECT title FROM notifications WHERE workspace_id=?`).all(full.id);
  assert.ok(!gapNotifications.some(row => /HIDDEN CERT DELIVERABLE/.test(row.title)));
  assert.ok(fullNotifications.some(row => /FULL CONTRACT DELIVERABLE/.test(row.title)),
    'the same phase remains actionable for a full-support contract');

  const hiddenPhase = db.prepare(`SELECT id,status FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='stage_1'`).get(gapPlan.id);
  db.prepare(`INSERT INTO engagement_delivery_gate_decisions
    (phase_id,decision,criteria_snapshot,snapshot_hash,note,waiver_expires_at,decided_by)
    VALUES (?,'waived','{}',?,'Hidden retained waiver','2000-01-01',?)`)
    .run(hiddenPhase.id, 'a'.repeat(64), managerId);
  jobs.jobEngagementDeliveryAlerts();
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM engagement_delivery_gate_decisions WHERE phase_id=?`).get(hiddenPhase.id).c, 1,
    'an expired waiver in a retained out-of-contract phase must not reopen or notify');
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_phases WHERE id=?').get(hiddenPhase.id).status, hiddenPhase.status);

  const linkedEngagementId = Number(db.prepare(`INSERT INTO consulting_engagements
    (workspace_id,engagement_code,name,engagement_type,framework_scope_json,status,lead_consultant_id,created_by,completed_at)
    VALUES (?,?,?,'implementation','["iso27001"]','complete',?,?,datetime('now'))`).run(
      full.id, `ENG-WAIVER-${full.id}`, 'Completed delivery before waiver expiry', managerId, managerId).lastInsertRowid);
  db.prepare(`UPDATE engagement_delivery_plans SET status='completed',consulting_engagement_id=? WHERE id=?`)
    .run(linkedEngagementId, fullPlan.id);
  const fullPhase = db.prepare(`SELECT id FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='context'`).get(fullPlan.id);
  db.prepare(`UPDATE engagement_delivery_phases SET status='waived' WHERE id=?`).run(fullPhase.id);
  db.prepare(`INSERT INTO engagement_delivery_gate_decisions
    (phase_id,decision,criteria_snapshot,snapshot_hash,note,waiver_expires_at,decided_by)
    VALUES (?,'waived','{}',?,'Expired contracted waiver','2000-01-01',?)`)
    .run(fullPhase.id, 'b'.repeat(64), managerId);

  jobs.jobEngagementDeliveryAlerts();
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_phases WHERE id=?').get(fullPhase.id).status, 'in_progress');
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(fullPlan.id).status, 'active',
    'an expired contracted waiver must invalidate stale plan completion');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(linkedEngagementId).status, 'active',
    'the linked consulting engagement reopens with the plan');
  assert.ok(db.prepare(`SELECT 1 FROM engagement_delivery_events
    WHERE plan_id=? AND action='reopened_after_waiver_expiry'`).get(fullPlan.id));
});
