'use strict';
// Operational registers. Slice 10 of the server.js modularization:
// incidents, business continuity / BIA, change management, vendors (TPRM)
// including questionnaires and the external vendor link flow.

const crypto = require('crypto');
const fts = require('../lib/fts');
const enc = require('../lib/encryption');
const email = require('../lib/email');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, escapeHtml } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          upload, resolveUploadPath, activeEntityFilter, qUploadAny } = deps;

  // ==================== INCIDENTS ====================
  app.get('/workspaces/:wsId/incidents', requireAuth, requireWorkspace, (req, res) => {
    const filter = req.query.filter || 'open';
    let q = `SELECT * FROM incidents WHERE workspace_id = ?`;
    if (filter === 'open') q += ` AND status NOT IN ('closed')`;
    const pgInc = paginate(db, req, {
      count: q.replace('SELECT *', 'SELECT COUNT(*) c'),
      rows: q + ` ORDER BY detected_at DESC, created_at DESC`,
      params: [req.workspace.id], perPage: 100,
    });
    res.render('incidents', { user: req.user, ws: req.workspace, incidents: pgInc.rows, filter,
      pg: pgInc, pagerHref: p => pageHref(req, p) });
  });

  app.post('/workspaces/:wsId/incidents', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    const { title, category, severity, detected_at, reported_by, description } = req.body;
    if (!title) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO incidents (workspace_id, title, category, severity, detected_at, reported_by, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.workspace.id, title, category || 'other', severity || 'medium',
      detected_at || null, reported_by || null, description || null).lastInsertRowid;
    fts.refresh(req.workspace.id, 'incident', id);
    logAction(req.user.id, req.workspace.id, 'create_incident', 'incident', id, { title });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/incidents/' + id, 'Incident logged'));
  });

  app.get('/workspaces/:wsId/incidents/:id', requireAuth, requireWorkspace, (req, res) => {
    const inc = db.prepare(`SELECT * FROM incidents WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!inc) return res.status(404).send('Not found');
    const events = db.prepare('SELECT * FROM incident_events WHERE incident_id=? ORDER BY event_at').all(inc.id);
    const runbooks = db.prepare(`SELECT id, name, category, trigger_severity FROM runbooks WHERE is_system=1 OR firm_id=? ORDER BY name`).all(req.workspace.firm_id);
    let runbook = null;
    if (inc.runbook_id) {
      runbook = db.prepare('SELECT * FROM runbooks WHERE id=?').get(inc.runbook_id);
      if (runbook) runbook.steps = JSON.parse(runbook.steps);
    }
    res.render('incident_detail', { user: req.user, ws: req.workspace, inc, events, runbooks, runbook });
  });

  app.post('/workspaces/:wsId/incidents/:id', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    const f = ['title','category','severity','detected_at','reported_by','status','description','affected_assets',
              'containment_actions','eradication_actions','recovery_actions','lessons_learned','external_notification'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (req.body.status === 'closed') set.push('closed_at=CURRENT_TIMESTAMP');
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE incidents SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      fts.refresh(req.workspace.id, 'incident', req.params.id);
      logAction(req.user.id, req.workspace.id, 'update_incident', 'incident', req.params.id, null);
    }
    res.redirect('/workspaces/' + req.workspace.id + '/incidents/' + req.params.id);
  });

  app.post('/workspaces/:wsId/incidents/:id/promote-nc', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    const inc = db.prepare(`SELECT * FROM incidents WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!inc) return redirectBack(req, res);
    if (inc.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + inc.nonconformity_id);
    const sev = inc.severity === 'critical' || inc.severity === 'high' ? 'major' : 'minor';
    const ncId = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity)
      VALUES (?, ?, 'incident', ?, ?, ?)`).run(req.workspace.id, inc.title, 'Incident #' + inc.id, inc.description, sev).lastInsertRowid;
    db.prepare(`UPDATE incidents SET nonconformity_id=? WHERE id=? AND workspace_id=?`).run(ncId, inc.id, req.workspace.id);
    fts.refresh(req.workspace.id, 'nc', ncId);
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
  });

  app.post('/workspaces/:wsId/incidents/:id/delete', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    db.prepare(`DELETE FROM incidents WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'incident', entityId: req.params.id });
    res.redirect('/workspaces/' + req.workspace.id + '/incidents');
  });

  // ==================== BUSINESS CONTINUITY / BIA (A.5.29, A.5.30) ====================

  app.get('/workspaces/:wsId/bcp', requireAuth, requireWorkspace, (req, res) => {
    const wsId = req.workspace.id;
    const processes = db.prepare(`SELECT * FROM bcp_processes WHERE workspace_id=? ORDER BY
      CASE criticality WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, name`).all(wsId);
    const plans = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM bcp_plan_processes pp WHERE pp.plan_id=p.id) AS linked_count,
      (SELECT MAX(t.test_date) FROM bcp_tests t WHERE t.plan_id=p.id) AS last_tested,
      (SELECT COUNT(*) FROM bcp_tests t WHERE t.plan_id=p.id AND t.pass=1) AS tests_pass,
      (SELECT COUNT(*) FROM bcp_tests t WHERE t.plan_id=p.id AND (t.pass=0 OR t.pass IS NULL)) AS tests_fail
      FROM bcp_plans p WHERE p.workspace_id=? ORDER BY p.name`).all(wsId);
    // Summary stats
    const totalProcesses = processes.length;
    const criticalProcesses = processes.filter(p => p.criticality === 'critical').length;
    // Critical processes with no linked plan
    const linkedProcessIds = new Set(db.prepare(`SELECT DISTINCT process_id FROM bcp_plan_processes pp
      JOIN bcp_plans pl ON pl.id=pp.plan_id WHERE pl.workspace_id=?`).all(wsId).map(r => r.process_id));
    const criticalUnlinked = processes.filter(p => p.criticality === 'critical' && !linkedProcessIds.has(p.id));
    const today = new Date().toISOString().split('T')[0];
    const overdueReview = plans.filter(p => p.next_review_date && p.next_review_date < today).length;
    const lastTestRow = db.prepare(`SELECT MAX(test_date) AS d FROM bcp_tests WHERE workspace_id=?`).get(wsId);
    const lastTestDate = lastTestRow ? lastTestRow.d : null;
    const summary = { totalProcesses, criticalProcesses, criticalUnlinked: criticalUnlinked.length, overdueReview, lastTestDate };
    res.render('bcp', { user: req.user, ws: req.workspace, processes, plans, summary, criticalUnlinked, today });
  });

  // BCP Processes CRUD
  app.post('/workspaces/:wsId/bcp/processes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { name, description, owner_name, criticality, max_tolerable_downtime_hours, rto_hours, rpo_hours, dependencies, peak_periods, status } = req.body;
    if (!name) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO bcp_processes (workspace_id, name, description, owner_name, criticality,
      max_tolerable_downtime_hours, rto_hours, rpo_hours, dependencies, peak_periods, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, name, description || null, owner_name || null, criticality || 'medium',
      max_tolerable_downtime_hours || null, rto_hours || null, rpo_hours || null,
      dependencies || null, peak_periods || null, status || 'active'
    ).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_bcp_process', 'bcp_process', id, { name }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Process added'));
  });

  app.post('/workspaces/:wsId/bcp/processes/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const f = ['name','description','owner_name','criticality','max_tolerable_downtime_hours','rto_hours','rpo_hours','dependencies','peak_periods','status'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE bcp_processes SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'update_bcp_process', 'bcp_process', req.params.id, null, auditCtx(req));
    }
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/bcp/processes/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM bcp_processes WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'delete_bcp_process', 'bcp_process', req.params.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Process deleted'));
  });

  // BCP Plans CRUD
  app.post('/workspaces/:wsId/bcp/plans', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { name, description, plan_type, recovery_steps, key_contacts, alternate_site, status, next_review_date } = req.body;
    if (!name) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO bcp_plans (workspace_id, name, description, plan_type, recovery_steps,
      key_contacts, alternate_site, status, next_review_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, name, description || null, plan_type || 'bcp', recovery_steps || null,
      key_contacts || null, alternate_site || null, status || 'draft', next_review_date || null, req.user.id
    ).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_bcp_plan', 'bcp_plan', id, { name }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + id, 'Plan created'));
  });

  app.get('/workspaces/:wsId/bcp/plans/:id', requireAuth, requireWorkspace, (req, res) => {
    const plan = db.prepare(`SELECT * FROM bcp_plans WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!plan) return res.status(404).send('Not found');
    const linkedProcesses = db.prepare(`SELECT p.*, pp.id AS link_id FROM bcp_processes p
      JOIN bcp_plan_processes pp ON pp.process_id=p.id WHERE pp.plan_id=? AND p.workspace_id=?`).all(plan.id, req.workspace.id);
    const tests = db.prepare(`SELECT * FROM bcp_tests WHERE plan_id=? AND workspace_id=? ORDER BY test_date DESC`).all(plan.id, req.workspace.id);
    const allProcesses = db.prepare(`SELECT * FROM bcp_processes WHERE workspace_id=? ORDER BY name`).all(req.workspace.id);
    const linkedIds = new Set(linkedProcesses.map(p => p.id));
    const unlinkableProcesses = allProcesses.filter(p => !linkedIds.has(p.id));
    res.render('bcp_plan', { user: req.user, ws: req.workspace, plan, linkedProcesses, tests, allProcesses, unlinkableProcesses });
  });

  app.post('/workspaces/:wsId/bcp/plans/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const f = ['name','description','plan_type','recovery_steps','key_contacts','alternate_site','status','next_review_date'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (req.body.mark_reviewed) {
      set.push('last_reviewed_at=CURRENT_TIMESTAMP');
    }
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE bcp_plans SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'update_bcp_plan', 'bcp_plan', req.params.id, null, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + req.params.id);
  });

  app.post('/workspaces/:wsId/bcp/plans/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM bcp_plans WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'delete_bcp_plan', 'bcp_plan', req.params.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Plan deleted'));
  });

  // Link/unlink processes to a plan
  app.post('/workspaces/:wsId/bcp/plans/:id/processes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const planId = req.params.id;
    const plan = db.prepare(`SELECT id FROM bcp_plans WHERE id=? AND workspace_id=?`).get(planId, req.workspace.id);
    if (!plan) return res.status(404).send('Not found');
    if (req.body.action === 'link' && req.body.process_id) {
      const proc = db.prepare(`SELECT id FROM bcp_processes WHERE id=? AND workspace_id=?`).get(req.body.process_id, req.workspace.id);
      if (proc) {
        db.prepare(`INSERT OR IGNORE INTO bcp_plan_processes (plan_id, process_id) VALUES (?, ?)`).run(planId, proc.id);
        logAction(req.user.id, req.workspace.id, 'link_bcp_process', 'bcp_plan', planId, { process_id: proc.id }, auditCtx(req));
      }
    } else if (req.body.action === 'unlink' && req.body.process_id) {
      db.prepare(`DELETE FROM bcp_plan_processes WHERE plan_id=? AND process_id=?`).run(planId, req.body.process_id);
      logAction(req.user.id, req.workspace.id, 'unlink_bcp_process', 'bcp_plan', planId, { process_id: req.body.process_id }, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + planId);
  });

  // BCP Tests CRUD
  app.post('/workspaces/:wsId/bcp/plans/:id/tests', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const planId = req.params.id;
    const plan = db.prepare(`SELECT id FROM bcp_plans WHERE id=? AND workspace_id=?`).get(planId, req.workspace.id);
    if (!plan) return res.status(404).send('Not found');
    const { test_type, test_date, participants, scenario_description, results, lessons_learned,
      rto_achieved_hours, rpo_achieved_hours, pass, action_items, next_test_date } = req.body;
    const id = db.prepare(`INSERT INTO bcp_tests (workspace_id, plan_id, test_type, test_date, participants,
      scenario_description, results, lessons_learned, rto_achieved_hours, rpo_achieved_hours, pass,
      action_items, next_test_date, conducted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, planId, test_type || 'tabletop', test_date || null, participants || null,
      scenario_description || null, results || null, lessons_learned || null,
      rto_achieved_hours || null, rpo_achieved_hours || null,
      pass === '1' ? 1 : (pass === '0' ? 0 : null),
      action_items || null, next_test_date || null, req.user.id
    ).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_bcp_test', 'bcp_test', id, { plan_id: planId, test_type }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + planId, 'Test recorded'));
  });

  app.post('/workspaces/:wsId/bcp/tests/:testId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const test = db.prepare(`SELECT * FROM bcp_tests WHERE id=? AND workspace_id=?`).get(req.params.testId, req.workspace.id);
    if (!test) return res.status(404).send('Not found');
    const f = ['test_type','test_date','participants','scenario_description','results','lessons_learned',
      'rto_achieved_hours','rpo_achieved_hours','action_items','next_test_date'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (req.body.pass !== undefined) { set.push('pass=?'); vals.push(req.body.pass === '1' ? 1 : (req.body.pass === '0' ? 0 : null)); }
    if (set.length) {
      vals.push(req.params.testId, req.workspace.id);
      db.prepare(`UPDATE bcp_tests SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'update_bcp_test', 'bcp_test', req.params.testId, null, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + test.plan_id);
  });

  app.post('/workspaces/:wsId/bcp/tests/:testId/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const test = db.prepare(`SELECT plan_id FROM bcp_tests WHERE id=? AND workspace_id=?`).get(req.params.testId, req.workspace.id);
    if (!test) return res.status(404).send('Not found');
    db.prepare(`DELETE FROM bcp_tests WHERE id=? AND workspace_id=?`).run(req.params.testId, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'delete_bcp_test', 'bcp_test', req.params.testId, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + test.plan_id, 'Test deleted'));
  });

  // ==================== CHANGE MANAGEMENT REGISTER (A.8.32) ====================
  app.get('/workspaces/:wsId/changes', requireAuth, requireWorkspace, (req, res) => {
    const { status, change_type, risk_level } = req.query;
    let q = `SELECT * FROM changes WHERE workspace_id=?`;
    const params = [req.workspace.id];
    if (status && status !== 'all') { q += ` AND status=?`; params.push(status); }
    if (change_type && change_type !== 'all') { q += ` AND change_type=?`; params.push(change_type); }
    if (risk_level && risk_level !== 'all') { q += ` AND risk_level=?`; params.push(risk_level); }
    const pgCh = paginate(db, req, {
      count: q.replace('SELECT *', 'SELECT COUNT(*) c'),
      rows: q + ` ORDER BY created_at DESC`,
      params, perPage: 100,
    });
    const changes = pgCh.rows;

    // Summary stats
    const total = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=?`).get(req.workspace.id).c;
    const openCount = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status NOT IN ('closed')`).get(req.workspace.id).c;
    const emergencyCount = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND change_type='emergency'`).get(req.workspace.id).c;
    const pendingApproval = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status='submitted'`).get(req.workspace.id).c;
    const implemented = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status IN ('implemented','closed')`).get(req.workspace.id).c;
    const closed = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status='closed'`).get(req.workspace.id).c;
    const pirPct = implemented > 0 ? Math.round((closed / implemented) * 100) : 0;

    res.render('changes', {
      user: req.user, ws: req.workspace, changes,
      filters: { status: status || 'all', change_type: change_type || 'all', risk_level: risk_level || 'all' },
      stats: { total, openCount, emergencyCount, pendingApproval, pirPct },
      pg: pgCh, pagerHref: p => pageHref(req, p)
    });
  });

  app.get('/workspaces/:wsId/changes/:id', requireAuth, requireWorkspace, (req, res) => {
    const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return res.status(404).render('error', { user: req.user, message: 'Change request not found.' });
    const approvals = db.prepare(`SELECT * FROM change_approvals WHERE change_id=? AND workspace_id=? ORDER BY sequence, id`).all(change.id, req.workspace.id);
    res.render('change_detail', { user: req.user, ws: req.workspace, change, approvals });
  });

  app.post('/workspaces/:wsId/changes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { title, description, change_type, category, risk_assessment, risk_level, impact_assessment, rollback_plan, requester_name } = req.body;
    if (!title || !title.trim()) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO changes (workspace_id, title, description, change_type, category, requester_name, requester_id, risk_assessment, risk_level, impact_assessment, rollback_plan, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, title.trim(), description || null, change_type || 'normal', category || null,
      requester_name || req.user.name || req.user.email, req.user.id,
      risk_assessment || null, risk_level || 'medium', impact_assessment || null, rollback_plan || null,
      req.user.id
    ).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_change', 'change', id, { title: title.trim() }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + id, 'Change request created'));
  });

  app.post('/workspaces/:wsId/changes/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    const { title, description, change_type, category, risk_assessment, risk_level, impact_assessment, rollback_plan, requester_name, implementation_notes, test_results } = req.body;
    db.prepare(`UPDATE changes SET title=?, description=?, change_type=?, category=?, risk_assessment=?, risk_level=?, impact_assessment=?, rollback_plan=?, requester_name=?, implementation_notes=?, test_results=?
      WHERE id=? AND workspace_id=?`).run(
      title || change.title, description || null, change_type || change.change_type, category || null,
      risk_assessment || null, risk_level || change.risk_level, impact_assessment || null, rollback_plan || null,
      requester_name || change.requester_name, implementation_notes || null, test_results || null,
      req.params.id, req.workspace.id
    );
    logAction(req.user.id, req.workspace.id, 'update_change', 'change', req.params.id, null, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/changes/' + req.params.id);
  });

  app.post('/workspaces/:wsId/changes/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM change_approvals WHERE change_id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    db.prepare(`DELETE FROM changes WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'delete_change', 'change', req.params.id, null, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes', 'Change request deleted'));
  });

  app.post('/workspaces/:wsId/changes/:id/submit', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=? AND status='draft'`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res, 'Change must be in draft status to submit', 'warn');
    db.prepare(`UPDATE changes SET status='submitted', submitted_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'submit_change', 'change', req.params.id, { from: 'draft', to: 'submitted' }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + req.params.id, 'Change submitted for approval'));
  });

  app.post('/workspaces/:wsId/changes/:id/approve', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    // Allow approval on submitted changes or retrospective approval on implemented emergency changes
    if (change.status !== 'submitted' && !(change.change_type === 'emergency' && change.status === 'implemented')) {
      return redirectBack(req, res, 'Change is not awaiting approval', 'warn');
    }
    const reason = req.body.reason || null;
    db.prepare(`INSERT INTO change_approvals (change_id, workspace_id, approver_id, approver_name, decision, reason, decided_at)
      VALUES (?, ?, ?, ?, 'approved', ?, CURRENT_TIMESTAMP)`).run(
      change.id, req.workspace.id, req.user.id, req.user.name || req.user.email, reason
    );
    // Update status to approved (for submitted changes)
    if (change.status === 'submitted') {
      db.prepare(`UPDATE changes SET status='approved', approved_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(change.id, req.workspace.id);
    }
    logAction(req.user.id, req.workspace.id, 'approve_change', 'change', change.id, { decision: 'approved', reason }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change approved'));
  });

  app.post('/workspaces/:wsId/changes/:id/reject', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=? AND status='submitted'`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res, 'Change is not awaiting approval', 'warn');
    const reason = req.body.reason || null;
    db.prepare(`INSERT INTO change_approvals (change_id, workspace_id, approver_id, approver_name, decision, reason, decided_at)
      VALUES (?, ?, ?, ?, 'rejected', ?, CURRENT_TIMESTAMP)`).run(
      change.id, req.workspace.id, req.user.id, req.user.name || req.user.email, reason
    );
    db.prepare(`UPDATE changes SET status='rejected' WHERE id=? AND workspace_id=?`).run(change.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'reject_change', 'change', change.id, { decision: 'rejected', reason }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change rejected'));
  });

  app.post('/workspaces/:wsId/changes/:id/implement', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    // Normal/standard: must be approved. Emergency: can go from draft directly.
    const allowedStatuses = change.change_type === 'emergency' ? ['draft', 'approved'] : ['approved'];
    if (!allowedStatuses.includes(change.status)) {
      return redirectBack(req, res, 'Change must be approved before implementation' + (change.change_type === 'emergency' ? ' (or draft for emergency)' : ''), 'warn');
    }
    const { implementation_notes, test_results } = req.body;
    db.prepare(`UPDATE changes SET status='implemented', implemented_at=CURRENT_TIMESTAMP, implementation_notes=?, test_results=?
      WHERE id=? AND workspace_id=?`).run(
      implementation_notes || change.implementation_notes || null,
      test_results || change.test_results || null,
      change.id, req.workspace.id
    );
    logAction(req.user.id, req.workspace.id, 'implement_change', 'change', change.id, { from: change.status, to: 'implemented' }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change marked as implemented'));
  });

  app.post('/workspaces/:wsId/changes/:id/close', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!change) return redirectBack(req, res);
    if (change.status !== 'implemented') return redirectBack(req, res, 'Change must be implemented before closing', 'warn');
    // Emergency changes need retrospective approval before closing
    if (change.change_type === 'emergency') {
      const hasApproval = db.prepare(`SELECT COUNT(*) c FROM change_approvals WHERE change_id=? AND workspace_id=? AND decision='approved'`).get(change.id, req.workspace.id).c;
      if (!hasApproval) return redirectBack(req, res, 'Emergency changes require retrospective approval before closing', 'warn');
    }
    const { post_implementation_review, success, pir_date } = req.body;
    db.prepare(`UPDATE changes SET status='closed', closed_at=CURRENT_TIMESTAMP, post_implementation_review=?, success=?, pir_date=?
      WHERE id=? AND workspace_id=?`).run(
      post_implementation_review || null,
      success === 'yes' || success === '1' ? 1 : 0,
      pir_date || new Date().toISOString().split('T')[0],
      change.id, req.workspace.id
    );
    logAction(req.user.id, req.workspace.id, 'close_change', 'change', change.id, { success: success === 'yes' || success === '1' ? 1 : 0 }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change closed with PIR'));
  });

  // ==================== VENDORS / SUPPLIERS - TPRM ====================
  const STANDARD_CLAUSES = [
    ['confidentiality', 'Confidentiality / non-disclosure'],
    ['data_handling', 'Data handling and classification'],
    ['security_obligations', 'Information security obligations (referencing standards)'],
    ['breach_notification', 'Breach notification (within 72 hours of awareness)'],
    ['subprocessor_approval', 'Sub-processor approval and notification'],
    ['audit_rights', 'Right to audit / receive assurance reports'],
    ['data_return_destruction', 'Data return / destruction at termination'],
    ['liability_indemnity', 'Liability and indemnity for security failures'],
    ['compliance', 'Compliance with applicable laws and regulations'],
    ['dpa', 'Data Processing Agreement (where personal data is processed)'],
    ['change_management', 'Change management / notice of material changes'],
    ['service_levels', 'Service levels and remedies']
  ];

  // Inherent risk: 1-25 based on data access × business criticality, then add weights for volume / dependency / regulatory exposure
  function computeInherentRisk(s) {
    const dataMap = { none: 1, public: 1, internal: 2, confidential: 4, restricted: 5 };
    const critMap = { low: 1, medium: 2, high: 3, critical: 4, '': 2 };
    const volMap = { none: 0, low: 0, medium: 1, high: 2, '': 0 };
    const depMap = { multi_source: 0, alternative: 1, single_source: 2, '': 0 };
    const dataScore = dataMap[s.data_access || 'none'] || 1;
    const critScore = critMap[s.business_criticality || 'medium'] || 2;
    const volBonus = volMap[s.data_volume || 'low'] || 0;
    const depBonus = depMap[s.dependency_type || 'multi_source'] || 0;
    const regBonus = s.regulatory_exposure ? Math.min(2, s.regulatory_exposure.split(',').filter(x => x.trim()).length) : 0;
    // Likelihood proxy = dependency + 2; Impact = data * crit / 5
    const impact = Math.min(5, dataScore + Math.floor(critScore / 2));
    const likelihood = Math.min(5, 2 + depBonus + Math.floor(volBonus / 2) + Math.floor(regBonus / 2));
    return Math.max(1, Math.min(25, impact * likelihood));
  }

  // Residual risk: inherent minus controls credit derived from documents + questionnaire score
  function computeResidualRisk(supplierId, inherent) {
    let credit = 0;
    const docs = db.prepare(`SELECT doc_type, expiry_date FROM supplier_documents WHERE supplier_id=?`).all(supplierId);
    const today = new Date().toISOString().split('T')[0];
    const validDocs = docs.filter(d => !d.expiry_date || d.expiry_date >= today);
    const hasType = (t) => validDocs.some(d => d.doc_type === t);
    if (hasType('iso_27001') || hasType('soc2_type2')) credit += 4;
    else if (hasType('soc2_type1')) credit += 2;
    if (hasType('iso_27017') || hasType('iso_27018') || hasType('iso_27701')) credit += 2;
    if (hasType('pentest')) credit += 2;
    if (hasType('dpa')) credit += 2;
    if (hasType('insurance')) credit += 1;

    // Questionnaire credit (best score across questionnaires)
    const bestQ = db.prepare(`SELECT MAX(score) AS s FROM supplier_questionnaires WHERE supplier_id=? AND status IN ('reviewed','responded') AND score IS NOT NULL`).get(supplierId);
    if (bestQ.s !== null) {
      if (bestQ.s >= 90) credit += 5;
      else if (bestQ.s >= 75) credit += 3;
      else if (bestQ.s >= 60) credit += 2;
      else if (bestQ.s >= 40) credit += 1;
    }

    // Clauses credit
    const presentClauses = db.prepare(`SELECT COUNT(*) AS c FROM supplier_clauses WHERE supplier_id=? AND status='present'`).get(supplierId).c;
    if (presentClauses >= 8) credit += 2;
    else if (presentClauses >= 5) credit += 1;

    return Math.max(1, Math.min(25, inherent - credit));
  }

  function recomputeSupplierRisk(supplierId, wsId) {
    const s = db.prepare(`SELECT * FROM suppliers WHERE id=? AND workspace_id=?`).get(supplierId, wsId);
    if (!s) return;
    const inherent = computeInherentRisk(s);
    const residual = computeResidualRisk(supplierId, inherent);
    db.prepare(`UPDATE suppliers SET inherent_risk_score=?, residual_risk_score=? WHERE id=? AND workspace_id=?`).run(inherent, residual, supplierId, wsId);
  }

  function tierFromRisk(score) {
    if (score >= 18) return 'tier_1';
    if (score >= 10) return 'tier_2';
    return 'tier_3';
  }

  app.get('/workspaces/:wsId/vendors', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const filter = req.query.filter || 'active';
    const ef = activeEntityFilter(req, 's');
    let q = `SELECT s.*,
      (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id=s.id) AS doc_count,
      (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id=s.id AND expiry_date IS NOT NULL AND expiry_date < date('now','+30 days') AND expiry_date >= date('now')) AS expiring_docs,
      (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id=s.id AND expiry_date IS NOT NULL AND expiry_date < date('now')) AS expired_docs,
      (SELECT COUNT(*) FROM supplier_subprocessors WHERE supplier_id=s.id) AS subproc_count,
      (SELECT COUNT(*) FROM supplier_questionnaires WHERE supplier_id=s.id) AS q_count,
      (SELECT MAX(score) FROM supplier_questionnaires WHERE supplier_id=s.id AND score IS NOT NULL) AS best_q_score
      FROM suppliers s WHERE s.workspace_id=?${ef.sql}`;
    if (filter === 'active') q += ` AND s.lifecycle_stage NOT IN ('terminated')`;
    else if (filter === 'review') q += ` AND s.next_review_date < date('now','+30 days')`;
    else if (filter === 'high_risk') q += ` AND s.residual_risk_score >= 15`;
    const pgV = paginate(db, req, {
      count: q.replace(/SELECT s\.\*[\s\S]*?FROM suppliers s/, 'SELECT COUNT(*) c FROM suppliers s'),
      rows: q + ` ORDER BY s.residual_risk_score DESC, s.name`,
      params: [req.workspace.id, ...ef.params], perPage: 100,
    });
    const vendors = pgV.rows;

    // TPRM dashboard summary
    const summary = {
      total: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated'`).get(req.workspace.id).c,
      tier1: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND residual_risk_score >= 18`).get(req.workspace.id).c,
      expiring: db.prepare(`SELECT COUNT(*) c FROM supplier_documents d INNER JOIN suppliers s ON s.id=d.supplier_id WHERE s.workspace_id=? AND d.expiry_date IS NOT NULL AND d.expiry_date < date('now','+30 days') AND d.expiry_date >= date('now')`).get(req.workspace.id).c,
      overdueReview: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND next_review_date IS NOT NULL AND next_review_date < date('now')`).get(req.workspace.id).c,
      questionnairesPending: db.prepare(`SELECT COUNT(*) c FROM supplier_questionnaires q INNER JOIN suppliers s ON s.id=q.supplier_id WHERE s.workspace_id=? AND q.status IN ('draft','sent')`).get(req.workspace.id).c
    };

    // Concentration: count tier_1/critical suppliers by industry / parent / region
    const concentration = {
      by_region: db.prepare(`SELECT location, COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND residual_risk_score >= 15 AND location IS NOT NULL GROUP BY location ORDER BY c DESC LIMIT 5`).all(req.workspace.id),
      by_parent: db.prepare(`SELECT parent_company, COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND parent_company IS NOT NULL GROUP BY parent_company HAVING c > 1 ORDER BY c DESC LIMIT 5`).all(req.workspace.id),
      single_source: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND dependency_type='single_source'`).get(req.workspace.id).c
    };

    // Upcoming renewals (next 90 days)
    const renewals = db.prepare(`SELECT id, name, contract_end, renewal_notice_days, auto_renew FROM suppliers WHERE workspace_id=? AND contract_end IS NOT NULL AND contract_end >= date('now') AND contract_end <= date('now','+90 days') ORDER BY contract_end`).all(req.workspace.id);

    res.render('vendors', { user: req.user, ws: req.workspace, vendors, filter, summary, concentration, renewals,
      pg: pgV, pagerHref: p => pageHref(req, p) });
  });

  app.post('/workspaces/:wsId/vendors', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const { name, service_provided, business_criticality, data_access, data_volume, dependency_type, location, regulatory_exposure } = req.body;
    if (!name) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO suppliers (workspace_id, name, service_provided, business_criticality, data_access, data_volume, dependency_type, location, regulatory_exposure, lifecycle_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prospect')`).run(
      req.workspace.id, name, service_provided || null,
      business_criticality || 'medium', data_access || 'none', data_volume || 'low',
      dependency_type || 'multi_source', location || null, regulatory_exposure || null
    ).lastInsertRowid;

    // Seed standard contract clauses checklist
    const insClause = db.prepare(`INSERT INTO supplier_clauses (workspace_id, supplier_id, clause_key, clause_label, status) VALUES (?, ?, ?, ?, 'pending')`);
    STANDARD_CLAUSES.forEach(([k, label]) => insClause.run(req.workspace.id, id, k, label));

    recomputeSupplierRisk(id, req.workspace.id);
    // Auto-tier from inherent risk
    const cur = db.prepare(`SELECT inherent_risk_score FROM suppliers WHERE id=? AND workspace_id=?`).get(id, req.workspace.id);
    db.prepare(`UPDATE suppliers SET tier=? WHERE id=? AND workspace_id=?`).run(tierFromRisk(cur.inherent_risk_score), id, req.workspace.id);
    fts.refresh(req.workspace.id, 'supplier', id);

    logAction(req.user.id, req.workspace.id, 'create_supplier', 'supplier', id, { name });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/vendors/' + id, 'Supplier added'));
  });

  app.get('/workspaces/:wsId/vendors/:id', requireAuth, requireWorkspace, (req, res) => {
    const v = db.prepare(`SELECT * FROM suppliers WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!v) return res.status(404).send('Not found');

    const tab = req.query.tab || 'overview';
    const docs = db.prepare(`SELECT * FROM supplier_documents WHERE supplier_id=? ORDER BY uploaded_at DESC`).all(v.id);
    const subprocessors = db.prepare(`SELECT * FROM supplier_subprocessors WHERE supplier_id=? ORDER BY name`).all(v.id);
    const reviews = db.prepare(`SELECT * FROM supplier_reviews WHERE supplier_id=? ORDER BY review_date DESC, created_at DESC`).all(v.id);
    const notesRaw = db.prepare(`SELECT * FROM supplier_notes WHERE supplier_id=? ORDER BY created_at DESC, id DESC`).all(v.id);
    const notes = notesRaw.map(n => ({ ...n, body: enc.decryptIfNeeded(n.body, req.workspace.id) }));
    const clauses = db.prepare(`SELECT * FROM supplier_clauses WHERE supplier_id=? ORDER BY id`).all(v.id);
    const supplierControls = db.prepare(`
      SELECT sc.id AS link_id, sc.iso_item_id, sc.notes, i.title, i.category
      FROM supplier_controls sc
      INNER JOIN iso_items i ON i.id = sc.iso_item_id
      WHERE sc.supplier_id = ? ORDER BY i.sort_order
    `).all(v.id);
    const allControlsForVendor = db.prepare(`SELECT id, title FROM iso_items WHERE type='control' ORDER BY sort_order`).all();
    const questionnaires = db.prepare(`SELECT q.*, t.category FROM supplier_questionnaires q LEFT JOIN questionnaire_templates t ON t.id=q.template_id WHERE q.supplier_id=? ORDER BY q.created_at DESC`).all(v.id);
    const templates = db.prepare(`SELECT id, name, description, category, (SELECT COUNT(*) FROM questionnaire_questions WHERE template_id=questionnaire_templates.id) AS q_count FROM questionnaire_templates WHERE is_system=1 OR firm_id=? ORDER BY name`).all(req.workspace.firm_id);
    const monitoring = db.prepare('SELECT * FROM supplier_monitoring WHERE supplier_id=? ORDER BY recorded_at DESC').all(v.id);
    const terminationItems = db.prepare('SELECT * FROM supplier_termination_items WHERE supplier_id=? ORDER BY id').all(v.id);

    res.render('vendor_detail', {
      user: req.user, ws: req.workspace, v, tab,
      docs, subprocessors, reviews, notes, clauses, questionnaires, templates,
      monitoring, terminationItems, supplierControls, allControlsForVendor,
      inherent: v.inherent_risk_score, residual: v.residual_risk_score
    });
  });

  app.post('/workspaces/:wsId/vendors/:id', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const f = ['name','service_provided','tier','data_access','data_volume','business_criticality','dependency_type',
              'lifecycle_stage','contract_start','contract_end','next_review_date','attestations','contact','website',
              'industry','location','parent_company','regulatory_exposure','annual_spend','renewal_notice_days',
              'auto_renew','approved_by','notes','status','last_assessed'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (req.body.lifecycle_stage === 'approved' && !req.body.approved_at) {
      set.push(`approved_at = CURRENT_TIMESTAMP`);
    }
    if (req.body.lifecycle_stage === 'terminated' && !req.body.terminated_at) {
      set.push(`terminated_at = CURRENT_TIMESTAMP`);
    }
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE suppliers SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      recomputeSupplierRisk(req.params.id, req.workspace.id);
      fts.refresh(req.workspace.id, 'supplier', req.params.id);
      logAction(req.user.id, req.workspace.id, 'update_supplier', 'supplier', req.params.id, null);
    }
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id);
  });

  app.post('/workspaces/:wsId/vendors/:id/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    db.prepare(`DELETE FROM suppliers WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'supplier', entityId: req.params.id });
    res.redirect('/workspaces/' + req.workspace.id + '/vendors');
  });

  // Documents
  app.post('/workspaces/:wsId/vendors/:id/documents', requireAuth, requireWorkspace, requirePermission('supplier.manage'), upload.single('file'), (req, res) => {
    const { doc_type, name, effective_date, expiry_date, notes } = req.body;
    if (!name) return redirectBack(req, res);
    let storedPath = null, sha = null, size = null, filename = null;
    if (req.file) {
      const buf = fs.readFileSync(req.file.path);
      sha = crypto.createHash('sha256').update(buf).digest('hex');
      storedPath = req.file.filename; size = req.file.size; filename = req.file.originalname;
    }
    db.prepare(`INSERT INTO supplier_documents (workspace_id, supplier_id, doc_type, name, filename, stored_path, sha256, size_bytes, effective_date, expiry_date, notes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, doc_type || 'other', name,
      filename, storedPath, sha, size, effective_date || null, expiry_date || null, notes || null, req.user.id
    );
    recomputeSupplierRisk(req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'add_supplier_doc', 'supplier', req.params.id, { name, doc_type });
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=documents');
  });

  app.get('/workspaces/:wsId/vendors/:id/documents/:docId/download', requireAuth, requireWorkspace, (req, res) => {
    const d = db.prepare(`SELECT * FROM supplier_documents WHERE id=? AND supplier_id=? AND workspace_id=?`)
      .get(req.params.docId, req.params.id, req.workspace.id);
    if (!d || !d.stored_path) return res.status(404).send('Not found');
    const fp = resolveUploadPath(d.stored_path, req.workspace.firm_id);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
    res.download(fp, d.filename);
  });

  app.post('/workspaces/:wsId/vendors/:id/documents/:docId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const d = db.prepare(`SELECT * FROM supplier_documents WHERE id=? AND supplier_id=? AND workspace_id=?`).get(req.params.docId, req.params.id, req.workspace.id);
    if (d) {
      if (d.stored_path) { const fp = resolveUploadPath(d.stored_path, req.workspace.firm_id); if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); }
      db.prepare(`DELETE FROM supplier_documents WHERE id=? AND workspace_id=?`).run(d.id, req.workspace.id);
      recomputeSupplierRisk(req.params.id, req.workspace.id);
    }
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=documents');
  });

  // Sub-processors
  app.post('/workspaces/:wsId/vendors/:id/subprocessors', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const { name, service_provided, data_access, location, approved } = req.body;
    if (!name) return redirectBack(req, res);
    db.prepare(`INSERT INTO supplier_subprocessors (workspace_id, supplier_id, name, service_provided, data_access, location, approved, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, name, service_provided || null,
      data_access || null, location || null, approved ? 1 : 0, approved ? new Date().toISOString() : null
    );
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=subprocessors');
  });

  app.post('/workspaces/:wsId/vendors/:id/subprocessors/:spId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    db.prepare(`DELETE FROM supplier_subprocessors WHERE id=? AND supplier_id=? AND workspace_id=?`).run(req.params.spId, req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=subprocessors');
  });

  // Reviews
  app.post('/workspaces/:wsId/vendors/:id/reviews', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const { review_date, reviewer, outcome, findings, action_items, next_review_date } = req.body;
    const supplier = db.prepare(`SELECT inherent_risk_score, residual_risk_score FROM suppliers WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!supplier) return res.status(404).send('Supplier not found');
    db.prepare(`INSERT INTO supplier_reviews (workspace_id, supplier_id, review_date, reviewer, outcome, inherent_risk, residual_risk, findings, action_items, next_review_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, review_date || null, reviewer || null,
      outcome || 'approved', supplier?.inherent_risk_score || null, supplier?.residual_risk_score || null,
      findings || null, action_items || null, next_review_date || null
    );
    // Update supplier next_review_date and last_assessed
    if (next_review_date) {
      db.prepare(`UPDATE suppliers SET next_review_date=?, last_assessed=? WHERE id=? AND workspace_id=?`).run(next_review_date, review_date || new Date().toISOString().split('T')[0], req.params.id, req.workspace.id);
    }
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=reviews');
  });

  // Notes
  app.post('/workspaces/:wsId/vendors/:id/notes', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const { body, internal_only } = req.body;
    if (!body) return redirectBack(req, res);
    db.prepare(`INSERT INTO supplier_notes (workspace_id, supplier_id, user_name, body, internal_only)
      VALUES (?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, req.user.name,
      enc.encryptIfNeeded(body.trim(), req.workspace.id, !!req.workspace.encryption_enabled),
      internal_only ? 1 : 0
    );
    logAction(req.user.id, req.workspace.id, 'add_supplier_note', 'supplier', req.params.id, null, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=notes');
  });

  app.post('/workspaces/:wsId/vendors/:id/notes/:noteId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    db.prepare(`DELETE FROM supplier_notes WHERE id=? AND supplier_id=? AND workspace_id=?`).run(req.params.noteId, req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=notes');
  });

  // Clauses
  app.post('/workspaces/:wsId/vendors/:id/clauses/:clauseId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const { status, notes } = req.body;
    db.prepare(`UPDATE supplier_clauses SET status=?, notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND supplier_id=? AND workspace_id=?`)
      .run(status, notes || null, req.params.clauseId, req.params.id, req.workspace.id);
    recomputeSupplierRisk(req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=clauses');
  });

  // Phase B: declare which Annex A controls a supplier handles on our behalf (A.5.19-A.5.23)
  app.post('/workspaces/:wsId/vendors/:id/controls', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = db.prepare('SELECT id FROM suppliers WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!v) return res.status(404).send('Not found');
    const { iso_item_id, notes } = req.body;
    if (!iso_item_id) return redirectBack(req, res);
    try {
      db.prepare(`INSERT OR IGNORE INTO supplier_controls (supplier_id, iso_item_id, notes) VALUES (?, ?, ?)`)
        .run(v.id, iso_item_id, notes || null);
      logAction(req.user.id, req.workspace.id, 'link_supplier_control', 'supplier', v.id, { iso_item_id }, auditCtx(req));
    } catch (e) { /* ignore dup */ }
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + v.id + '?tab=controls');
  });

  app.post('/workspaces/:wsId/vendors/:id/controls/:linkId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = db.prepare('SELECT id FROM suppliers WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!v) return res.status(404).send('Not found');
    const link = db.prepare('SELECT * FROM supplier_controls WHERE id=? AND supplier_id=?').get(req.params.linkId, v.id);
    if (link) {
      db.prepare('DELETE FROM supplier_controls WHERE id=?').run(link.id);
      logAction(req.user.id, req.workspace.id, 'unlink_supplier_control', 'supplier', v.id, { iso_item_id: link.iso_item_id }, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + v.id + '?tab=controls');
  });

  // Questionnaires
  app.post('/workspaces/:wsId/vendors/:id/questionnaires', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const { template_id } = req.body;
    const tpl = db.prepare(`SELECT * FROM questionnaire_templates WHERE id=? AND (is_system=1 OR firm_id=?)`).get(template_id, req.workspace.firm_id);
    if (!tpl) return redirectBack(req, res);
    const qCount = db.prepare(`SELECT COUNT(*) c FROM questionnaire_questions WHERE template_id=?`).get(template_id).c;
    const qid = db.prepare(`INSERT INTO supplier_questionnaires (workspace_id, supplier_id, template_id, template_name, status, sent_at, total_questions)
      VALUES (?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP, ?)`).run(
      req.workspace.id, req.params.id, template_id, tpl.name, qCount
    ).lastInsertRowid;
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '/questionnaires/' + qid);
  });

  app.get('/workspaces/:wsId/vendors/:id/questionnaires/:qId', requireAuth, requireWorkspace, (req, res) => {
    const q = db.prepare(`SELECT q.*, s.name AS supplier_name, s.contact AS supplier_contact, t.description AS tpl_description
      FROM supplier_questionnaires q
      INNER JOIN suppliers s ON s.id=q.supplier_id
      LEFT JOIN questionnaire_templates t ON t.id=q.template_id
      WHERE q.id=? AND q.workspace_id=?`).get(req.params.qId, req.workspace.id);
    if (!q) return res.status(404).send('Not found');
    const questions = db.prepare(`SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order`).all(q.template_id);
    const responses = db.prepare(`SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?`).all(q.id);
    const respMap = Object.fromEntries(responses.map(r => [r.question_id, r]));
    // Per-question evidence attachments (vendor- or consultant-uploaded). Keyed by
    // question_id; files with no question_id land under 'general'.
    const attachRows = db.prepare(`SELECT * FROM questionnaire_attachments WHERE questionnaire_id=? ORDER BY uploaded_at`).all(q.id);
    const attachMap = {};
    attachRows.forEach(a => { const k = a.question_id == null ? 'general' : a.question_id; (attachMap[k] = attachMap[k] || []).push(a); });
    // Group by section
    const sections = {};
    questions.forEach(qu => { (sections[qu.section] = sections[qu.section] || []).push(qu); });
    res.render('vendor_questionnaire', { user: req.user, ws: req.workspace, q, sections, respMap, attachMap });
  });

  app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), qUploadAny, (req, res) => {
    const ws = req.workspace;
    const qid = req.params.qId;
    const dest = '/workspaces/' + ws.id + '/vendors/' + req.params.id + '/questionnaires/' + qid;
    const questionnaire = db.prepare('SELECT id FROM supplier_questionnaires WHERE id=? AND workspace_id=?').get(qid, ws.id);
    if (!questionnaire) return res.status(404).send('Questionnaire not found');

    // A multer error (oversize / too many files) aborts parsing mid-stream, so the
    // body may be partial — bail before saving and tell the consultant to retry.
    if (req._uploadError) {
      (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      const e = req._uploadError;
      const msg = e && e.code === 'LIMIT_FILE_SIZE' ? 'A file exceeded the 25 MB limit — nothing was saved. Please attach a smaller file and try again.'
        : e && e.code === 'LIMIT_FILE_COUNT' ? 'Too many files at once (limit 40) — nothing was saved. Please try again with fewer files.'
        : 'An attachment could not be processed — nothing was saved. Please try again.';
      return res.redirect(withToast(dest, msg));
    }

    // Save responses for any question_X_answer fields
    const qIds = Object.keys(req.body).filter(k => k.startsWith('answer_')).map(k => parseInt(k.replace('answer_',''),10));
    const upsert = db.prepare(`INSERT INTO supplier_questionnaire_responses (questionnaire_id, question_id, answer, comment)
      VALUES (?, ?, ?, ?) ON CONFLICT(questionnaire_id, question_id) DO UPDATE SET answer=excluded.answer, comment=excluded.comment`);
    let answered = 0, score = 0, total = 0;
    for (const qid_ of qIds) {
      const ans = req.body['answer_' + qid_];
      const cmt = req.body['comment_' + qid_] || null;
      upsert.run(qid, qid_, ans || null, cmt);
      if (ans) answered++;
    }

    // Compute score
    const allQ = db.prepare(`SELECT q.id, q.weight, q.expected_answer, r.answer FROM questionnaire_questions q
      LEFT JOIN supplier_questionnaire_responses r ON r.question_id=q.id AND r.questionnaire_id=?
      WHERE q.template_id=(SELECT template_id FROM supplier_questionnaires WHERE id=?)`).all(qid, qid);
    let totalWeight = 0, achieved = 0;
    allQ.forEach(q => {
      totalWeight += q.weight;
      if (q.answer && q.expected_answer && q.answer.toLowerCase() === q.expected_answer.toLowerCase()) achieved += q.weight;
    });
    const finalScore = totalWeight > 0 ? Math.round((achieved / totalWeight) * 100) : null;
    const rating = finalScore === null ? null : (finalScore >= 80 ? 'low' : finalScore >= 60 ? 'medium' : 'high');

    const status = req.body.action === 'submit' ? 'responded' : (req.body.action === 'review' ? 'reviewed' : 'draft');
    const reviewer = req.body.reviewer || null;
    const reviewerComments = req.body.reviewer_comments || null;
    db.prepare(`UPDATE supplier_questionnaires SET answered_questions=?, score=?, risk_rating=?, status=?,
      responded_at=COALESCE(responded_at, CASE WHEN ?='responded' OR ?='reviewed' THEN CURRENT_TIMESTAMP END),
      reviewed_at=CASE WHEN ?='reviewed' THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
      reviewer=COALESCE(?, reviewer), reviewer_comments=COALESCE(?, reviewer_comments)
      WHERE id=? AND workspace_id=?`).run(allQ.filter(q => q.answer).length, finalScore, rating, status, status, status, status, reviewer, reviewerComments, qid, req.workspace.id);
    recomputeSupplierRisk(req.params.id, req.workspace.id);

    // Persist any evidence the consultant attached during review.
    let attachSaved = 0;
    try {
      attachSaved = persistQuestionnaireFiles({
        files: req.files, questionnaireId: parseInt(qid, 10), workspaceId: ws.id, source: 'consultant', uploadedBy: req.user.id
      });
    } catch (e) { console.error('[questionnaire attach]', e && e.message); }

    logAction(req.user.id, ws.id, 'update_questionnaire', 'questionnaire', qid, { status, score: finalScore, attachments: attachSaved });

    const rejected = req._rejectedUploads || [];
    let toast = status === 'reviewed' ? 'Questionnaire marked reviewed.' : status === 'responded' ? 'Responses submitted.' : 'Draft saved.';
    if (attachSaved) toast += ` ${attachSaved} file${attachSaved === 1 ? '' : 's'} attached.`;
    if (rejected.length) toast += ` ${rejected.length} file${rejected.length === 1 ? '' : 's'} skipped (unsupported type).`;
    res.redirect(withToast(dest, toast));
  });

  app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    // Unlink attachment files first — the questionnaire_attachments rows cascade
    // via FK, but the files on disk would otherwise be orphaned.
    const files = db.prepare(`SELECT a.stored_path FROM questionnaire_attachments a
      INNER JOIN supplier_questionnaires q ON q.id=a.questionnaire_id
      WHERE a.questionnaire_id=? AND q.supplier_id=? AND q.workspace_id=?`)
      .all(req.params.qId, req.params.id, req.workspace.id);
    files.forEach(f => { if (f.stored_path) { const fp = resolveUploadPath(f.stored_path, req.workspace.firm_id); if (fp && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} } } });
    db.prepare(`DELETE FROM supplier_questionnaires WHERE id=? AND supplier_id=? AND workspace_id=?`).run(req.params.qId, req.params.id, req.workspace.id);
    recomputeSupplierRisk(req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=questionnaires');
  });

  // Download a questionnaire attachment. Scoped by joining through the parent
  // questionnaire so a token from one workspace can't pull another's files.
  app.get('/workspaces/:wsId/vendors/:id/questionnaires/:qId/attachments/:attId/download', requireAuth, requireWorkspace, (req, res) => {
    const a = db.prepare(`SELECT a.* FROM questionnaire_attachments a
      INNER JOIN supplier_questionnaires q ON q.id=a.questionnaire_id
      WHERE a.id=? AND a.questionnaire_id=? AND q.supplier_id=? AND q.workspace_id=?`)
      .get(req.params.attId, req.params.qId, req.params.id, req.workspace.id);
    if (!a || !a.stored_path) return res.status(404).send('Not found');
    const fp = resolveUploadPath(a.stored_path, req.workspace.firm_id);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
    res.download(fp, a.filename);
  });

  // Delete a questionnaire attachment (consultant only). Removes the file from
  // disk then the row; same join-scoping as download.
  app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/attachments/:attId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const a = db.prepare(`SELECT a.* FROM questionnaire_attachments a
      INNER JOIN supplier_questionnaires q ON q.id=a.questionnaire_id
      WHERE a.id=? AND a.questionnaire_id=? AND q.supplier_id=? AND q.workspace_id=?`)
      .get(req.params.attId, req.params.qId, req.params.id, req.workspace.id);
    const dest = '/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '/questionnaires/' + req.params.qId;
    if (a) {
      if (a.stored_path) { const fp = resolveUploadPath(a.stored_path, req.workspace.firm_id); if (fp && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} } }
      db.prepare(`DELETE FROM questionnaire_attachments WHERE id=?`).run(a.id);
      logAction(req.user.id, req.workspace.id, 'delete_questionnaire_attachment', 'questionnaire', req.params.qId, { filename: a.filename });
      return res.redirect(withToast(dest, 'Attachment deleted.'));
    }
    res.redirect(dest);
  });

}

module.exports = { register };
