'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-ai-cert-integrity-'));
process.env.DB_PATH = path.join(tmpDir, 'iso27001.db');
process.env.ISMS_KEY_FILE = path.join(tmpDir, 'master.key');
const { db, init } = require('../db');
init();
const certification = require('../lib/iso42001-certification');
const routes = require('../routes/iso42001');
const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
const actorId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
const handlers = new Map();
const logs = [];
const middleware = (_req, _res, next) => next();
const app = {};
for (const method of ['get', 'post']) app[method] = (route, ...stack) => handlers.set(`${method} ${route}`, stack);
routes.register(app, {
  db, requireAuth: middleware, requireWorkspace: middleware,
  requirePermission: () => middleware, logAction: (...args) => logs.push(args), computeReadiness: () => ({})
});

function workspace(outcome = 'certification_support', frameworks = ['iso42001']) {
  const id = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,'AI certification integrity',?,?)`).run(firmId, JSON.stringify(frameworks), outcome).lastInsertRowid);
  return { ...db.prepare('SELECT * FROM workspaces WHERE id=?').get(id), frameworks };
}
function event(ws, type, actual = null, status = 'planned', planned = null) {
  return Number(db.prepare(`INSERT INTO iso42001_cert_cycle_events
    (workspace_id,event_type,actual_date,status,planned_date) VALUES (?,?,?,?,?)`).run(ws.id, type, actual, status, planned).lastInsertRowid);
}
function invoke(method, route, ws, body = {}, params = {}) {
  const req = { workspace: ws, user: { id: actorId }, body, params, headers: {}, originalUrl: route };
  const res = {
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    redirect(url) { this.redirected = url; return this; }, send(message) { this.message = message; return this; },
    render(view, data) { this.view = view; this.data = data; return this; }
  };
  const stack = handlers.get(`${method} /workspaces/:wsId/iso42001/cert-cycle${route}`);
  assert.ok(stack, `registered ${method} ${route}`);
  let index = 0;
  const next = () => stack[index++]?.(req, res, next);
  next();
  return res;
}
const rejected = response => assert.match(response.redirected || '', /toastKind=error/);
const row = id => db.prepare('SELECT * FROM iso42001_cert_cycle_events WHERE id=?').get(id);
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('AI certification state rejects duplicate, invalid and misordered legacy records', () => {
  assert.equal(certification.isValidISODate('2028-02-29'), true);
  assert.equal(certification.isValidISODate('2027-02-29'), false);
  const ws = workspace();
  event(ws, 'Stage 1 audit', '2027-03-10', 'completed');
  const stage2 = event(ws, 'stage_2', '2027-03-09', 'closed');
  assert.equal(certification.certificationAuditState(db, ws.id, 'stage_1').auditComplete, true);
  let state = certification.stage2AssuranceState(db, ws.id);
  assert.equal(state.rawAuditComplete, true);
  assert.equal(state.stageSequenceValid, false);
  assert.equal(state.auditComplete, false);
  db.prepare('UPDATE iso42001_cert_cycle_events SET actual_date=? WHERE id=?').run('2027-03-11', stage2);
  assert.equal(certification.stage2AssuranceState(db, ws.id).auditComplete, true);
  event(ws, 'stage1', '2027-03-10', 'closed');
  state = certification.certificationAuditState(db, ws.id, 'Stage 1 audit');
  assert.equal(state.duplicateEvents, 1);
  assert.equal(state.auditComplete, false);
  assert.equal(certification.stage2AssuranceState(db, ws.id).auditComplete, false);
  const invalid = workspace();
  event(invalid, 'Stage 1 audit', '2027-02-29', 'completed', '2027-2-01');
  state = certification.certificationAuditState(db, invalid.id, 'stage_1');
  assert.equal(state.invalidDateEvents, 1);
  assert.equal(state.invalidClosedDates, 1);
  assert.equal(state.auditComplete, false);
});

test('AI assurance includes stage lineage and conservatively retains unassigned AI findings', () => {
  const ws = workspace();
  const stage1 = event(ws, 'Stage 1 audit', '2027-03-10', 'completed');
  const stage2 = event(ws, 'Stage 2 audit', '2027-03-11', 'completed');
  const add = (ref, severity, status, item = null) => db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source_ref,severity,status,iso_item_id) VALUES (?,'Finding',?,?,?,?)`).run(ws.id, ref, severity, status, item);
  add(`iso42001_cert_cycle_event:${stage1}`, 'major', 'open');
  add(`iso42001_cert_cycle_event:${stage2}`, 'observation', 'open');
  add(null, 'minor', 'open');
  add(null, 'minor', 'verified');
  add('iso42001_cert_cycle_event:999999', 'observation', 'open');
  let state = certification.certificationAuditState(db, ws.id, 'stage_1');
  assert.equal(state.openFindings, 3);
  assert.equal(state.openMaterialFindings, 2);
  assert.equal(state.openObservations, 1);
  assert.equal(state.totalFindings, 4);
  assert.equal(state.allClear, false);
  const mixed = workspace('certification_support', ['iso27001', 'iso42001']);
  db.prepare(`INSERT INTO nonconformities (workspace_id,title,iso_item_id,status) VALUES (?,'AI gap','ai-clause-9.2','open')`).run(mixed.id);
  db.prepare(`INSERT INTO nonconformities (workspace_id,title,iso_item_id,status) VALUES (?,'Security gap','clause-9.2','open')`).run(mixed.id);
  state = certification.certificationAuditState(db, mixed.id, 'stage_1');
  assert.equal(state.openFindings, 1, 'the AI item remains a blocker in mixed-framework engagements');
});

test('certification routes reject unsupported types, invalid dates and duplicate stage aliases', () => {
  const ws = workspace();
  rejected(invoke('post', '/add', ws, { event_type: 'Made up audit' }));
  rejected(invoke('post', '/add', ws, { event_type: 'Stage 1 audit', planned_date: '2027-02-29' }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=?').get(ws.id).c, 0);
  invoke('post', '/add', ws, { event_type: 'stage_1', planned_date: '2027-03-01' });
  rejected(invoke('post', '/add', ws, { event_type: 'Stage 1 audit' }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=?').get(ws.id).c, 1);
});

test('certification routes require actual audit dates and Stage 1 before completing Stage 2', () => {
  const ws = workspace();
  const first = event(ws, 'Stage 1 audit');
  const second = event(ws, 'Stage 2 audit');
  rejected(invoke('post', '/:id/update', ws, { status: 'completed' }, { id: first }));
  rejected(invoke('post', '/:id/update', ws, { status: 'completed', actual_date: '2027-03-02' }, { id: second }));
  assert.equal(row(first).status, 'planned');
  invoke('post', '/:id/update', ws, { status: 'completed', actual_date: '2027-03-02' }, { id: first });
  rejected(invoke('post', '/:id/update', ws, { status: 'completed', actual_date: '2027-03-01' }, { id: second }));
  invoke('post', '/:id/update', ws, { status: 'closed', actual_date: '2027-03-03' }, { id: second });
  assert.equal(row(second).status, 'completed');
  assert.equal(certification.stage2AssuranceState(db, ws.id).auditComplete, true);
  rejected(invoke('post', '/:id/update', ws, { status: 'planned' }, { id: first }));
  rejected(invoke('post', '/:id/update', ws, { actual_date: '2027-03-04' }, { id: first }));
  rejected(invoke('post', '/:id/update', ws, { status: 'planned', actual_date: '' }, { id: second }));
  assert.equal(row(first).actual_date, '2027-03-02');
  assert.ok(logs.some(log => log[2] === 'update_iso42001_cert_event' && log[4] === second));
});

test('certification routes retain completed, dated and finding-linked audit records', () => {
  const ws = workspace();
  const completed = event(ws, 'Stage 1 audit', '2027-03-02', 'completed');
  const dated = event(ws, 'Internal audit', '2027-03-01', 'in_progress');
  const linked = event(ws, 'Management review');
  db.prepare(`INSERT INTO nonconformities (workspace_id,title,source_ref) VALUES (?,'Review finding',?)`)
    .run(ws.id, `iso42001_cert_cycle_event:${linked}`);
  for (const id of [completed, dated, linked]) {
    rejected(invoke('post', '/:id/delete', ws, {}, { id }));
    assert.ok(row(id));
  }
  const planned = event(ws, 'Internal audit');
  invoke('post', '/:id/delete', ws, {}, { id: planned });
  assert.equal(row(planned), undefined);
  assert.ok(logs.some(log => log[2] === 'delete_iso42001_cert_event' && log[4] === planned));
  const other = workspace();
  assert.equal(invoke('post', '/:id/delete', other, {}, { id: completed }).statusCode, 404);
  assert.equal(invoke('post', '/:id/update', other, { notes: 'Cross-workspace edit' }, { id: completed }).statusCode, 404);
});

test('cycle seeding is idempotent and validates the target before writing', () => {
  const ws = workspace();
  event(ws, 'stage_1', null, 'planned', '2027-01-01');
  invoke('post', '/seed', ws);
  invoke('post', '/seed', ws);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=?').get(ws.id).c, 5);
  assert.equal(certification.certificationAuditState(db, ws.id, 'stage_1').eventCount, 1);
  const invalid = workspace();
  db.prepare('UPDATE workspaces SET target_cert_date=? WHERE id=?').run('2027-02-29', invalid.id);
  rejected(invoke('post', '/seed', invalid));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=?').get(invalid.id).c, 0);
});

test('gap-only contracts cannot access or mutate certification cycle routes', () => {
  const ws = workspace('gap_assessment_only');
  for (const [method, route] of [['get', ''], ['post', '/seed'], ['post', '/add'], ['post', '/:id/update'], ['post', '/:id/delete']]) {
    const response = invoke(method, route, ws, { event_type: 'Stage 1 audit', status: 'completed' }, { id: 999 });
    assert.equal(response.statusCode, 409, `${method} ${route} guards the contracted service`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_cert_cycle_events WHERE workspace_id=?').get(ws.id).c, 0);
});

test('generic NC governance retains AI certification finding lineage and closure evidence', () => {
  const delivery = require('../lib/engagement-delivery');
  const ws = workspace();
  const stage1 = event(ws, 'Stage 1 audit', '2027-03-02', 'completed');
  const finding = Number(db.prepare(`INSERT INTO nonconformities (workspace_id,title,source,source_ref,severity,status)
    VALUES (?,'AI Stage 1 finding','external_audit',?,'minor','open')`).run(ws.id, `iso42001_cert_cycle_event:${stage1}`).lastInsertRowid);
  const lineage = delivery.certificationFindingLineage(db, ws.id, finding);
  assert.equal(lineage.event_type, 'stage_1');
  assert.equal(lineage.cert_event_id, stage1);
  assert.equal(delivery.certificationEventForSourceRef(db, workspace().id, `iso42001_cert_cycle_event:${stage1}`), null);
  const ncHandlers = {};
  require('../routes/governance').register({ get() {}, post(route, ...stack) { ncHandlers[route] = stack.at(-1); } }, {
    db, requireAuth: middleware, requireWorkspace: middleware, requirePermission: () => middleware,
    logAction() {}, workspaceProgress() { return {}; }
  });
  const request = body => ({ params: { id: finding }, workspace: ws, user: { id: actorId }, body, headers: {} });
  const response = () => ({ redirect(url) { this.redirected = url; return this; } });
  let res = response();
  ncHandlers['/workspaces/:wsId/nonconformities/:id'](request({ source: 'other', source_ref: '' }), res);
  rejected(res);
  res = response();
  ncHandlers['/workspaces/:wsId/nonconformities/:id'](request({ status: 'closed' }), res);
  rejected(res);
  res = response();
  ncHandlers['/workspaces/:wsId/nonconformities/:id/delete'](request({}), res);
  rejected(res);
  const retained = db.prepare('SELECT * FROM nonconformities WHERE id=?').get(finding);
  assert.equal(retained.source_ref, `iso42001_cert_cycle_event:${stage1}`);
  assert.equal(retained.status, 'open');
});
