'use strict';
// Notifications + inbox + compliance calendar routes (long-tail pass).

const jobs = require('../lib/jobs');
const { todayFor, shiftMonth } = require('../lib/dates');
const email = require('../lib/email');
const { computeNeedsAttention } = require('../lib/next-steps');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');
const delivery = require('../lib/engagement-delivery');
const outcomeScope = require('../lib/engagement-outcome-scope');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;

  app.get('/workspaces/:wsId/notifications', requireAuth, requireWorkspace, (req, res) => {
    const qs = req.query.filter ? ('?filter=' + encodeURIComponent(req.query.filter)) : '';
    res.redirect('/workspaces/' + req.workspace.id + '/inbox' + qs);
  });

  app.post('/workspaces/:wsId/notifications/:id/read', requireAuth, requireWorkspace, (req, res) => {
    db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    redirectBack(req, res);
  });
  app.post('/workspaces/:wsId/notifications/:id/dismiss', requireAuth, requireWorkspace, (req, res) => {
    db.prepare(`UPDATE notifications SET dismissed_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    redirectBack(req, res);
  });
  app.post('/workspaces/:wsId/notifications/mark-all-read', requireAuth, requireWorkspace, (req, res) => {
    db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND read_at IS NULL`).run(req.workspace.id);
    redirectBack(req, res);
  });

  // Per-user email-notification preference (global to the account, not per-workspace).
  // 'immediate' = email me when a notification is raised; 'off' = in-app only.
  // Drives the notify()->email bridge in lib/jobs.js via users.email_notify.
  app.post('/me/notification-pref', requireAuth, (req, res) => {
    const value = req.body.value === 'off' ? 'off' : 'immediate';
    db.prepare('UPDATE users SET email_notify=? WHERE id=?').run(value, req.user.id);
    // Only honour a same-site relative return path; never an absolute/protocol-relative URL.
    const back = (typeof req.body.return === 'string' && /^\/[^/]/.test(req.body.return)) ? req.body.return : '/dashboard';
    res.redirect(withToast(back, value === 'off' ? 'Email notifications turned off' : 'Email notifications on'));
  });

  // Tier B.8 - Calendar view aggregating every due-dated item across the workspace.
  // Month grid; navigate prev/next via ?month=YYYY-MM. Pulls audits, MRMs,
  // NCs, cert events, doc reviews, treatment actions, risk-acceptance expiries.
  app.get('/workspaces/:wsId/calendar', requireAuth, requireWorkspace, (req, res) => {
    const wsId = req.workspace.id;
    const deliveryPlan = outcomeScope.hasIso27001(req.workspace)
      ? delivery.ensurePlan(db, req.workspace, req.user.id)
      : null;
    const monthStr = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month
                    : todayFor(req.workspace).slice(0,7);
    const [yr, mo] = monthStr.split('-').map(n => parseInt(n, 10));
    const monthStart = `${monthStr}-01`;
    const nextLabel = shiftMonth(monthStr,1);
    const nextMo = `${nextLabel}-01`;
    const prevMo = shiftMonth(monthStr,-1);

    // Aggregate every dated item that falls inside the visible window
    // (first to last of selected month).
    const events = [];
    const add = (date, kind, title, link, severity) => {
      if (!date) return;
      if (date < monthStart || date >= nextMo) return;
      events.push({ date, kind, title, link, severity });
    };

    db.prepare(`SELECT id, title, audit_date FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL`).all(wsId)
      .forEach(a => add(a.audit_date, 'audit', a.title, `/workspaces/${wsId}/audits/${a.id}`, 'low'));
    db.prepare(`SELECT id, meeting_date FROM mrms WHERE workspace_id=? AND meeting_date IS NOT NULL`).all(wsId)
      .forEach(m => add(m.meeting_date, 'mrm', `MRM`, `/workspaces/${wsId}/mrms/${m.id}`, 'low'));
    db.prepare(`SELECT id, title, due_date, status FROM nonconformities WHERE workspace_id=? AND due_date IS NOT NULL`).all(wsId)
      .forEach(n => add(n.due_date, 'nc', n.title, `/workspaces/${wsId}/nonconformities/${n.id}`, n.status === 'closed' ? 'low' : 'high'));
    if (outcomeScope.isCertificationSupport(req.workspace)) {
      db.prepare(`SELECT id, event_type, planned_date, status FROM cert_cycle_events WHERE workspace_id=? AND planned_date IS NOT NULL`).all(wsId)
        .forEach(e => add(e.planned_date, 'cert', e.event_type.replace(/_/g, ' '), `/workspaces/${wsId}/cert-cycle`, 'medium'));
    }
    db.prepare(`SELECT id, name, next_review_date FROM generated_docs WHERE workspace_id=? AND next_review_date IS NOT NULL`).all(wsId)
      .forEach(d => add(d.next_review_date, 'doc-review', `Review: ${d.name}`, `/workspaces/${wsId}/documents/${d.id}`, 'medium'));
    db.prepare(`SELECT rta.id, rta.title, rta.due_date, rta.status, rta.risk_id FROM risk_treatment_actions rta WHERE rta.workspace_id=? AND rta.due_date IS NOT NULL`).all(wsId)
      .forEach(a => add(a.due_date, 'treatment', a.title, `/workspaces/${wsId}/risks/${a.risk_id}`, a.status === 'done' ? 'low' : 'medium'));
    db.prepare(`SELECT a.id, a.expires_at, a.risk_id, r.title FROM risk_acceptances a INNER JOIN risks r ON r.id=a.risk_id WHERE a.workspace_id=? AND a.revoked_at IS NULL AND a.expires_at IS NOT NULL`).all(wsId)
      .forEach(a => add(a.expires_at, 'risk-accept', `R-${a.risk_id} acceptance expires`, `/workspaces/${wsId}/risks/${a.risk_id}`, 'medium'));
    if (deliveryPlan) {
      const phaseScope = outcomeScope.phaseSqlForWorkspace(req.workspace, 'ph');
      db.prepare(`SELECT m.id,m.title,COALESCE(m.forecast_end_date,m.planned_end_date) due,m.status
        FROM engagement_delivery_milestones m
        JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
        WHERE m.plan_id=? AND ${phaseScope}
          AND COALESCE(m.forecast_end_date,m.planned_end_date) IS NOT NULL`).all(deliveryPlan.id)
        .forEach(m => add(m.due, 'plan-milestone', m.title, `/workspaces/${wsId}/engagement-plan?view=timeline`, m.status === 'blocked' ? 'high' : 'medium'));
      db.prepare(`SELECT d.id,d.title,d.due_date,d.status
        FROM engagement_delivery_deliverables d
        JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
        JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
        WHERE d.plan_id=? AND ${phaseScope}
          AND d.due_date IS NOT NULL AND d.status NOT IN ('superseded')`).all(deliveryPlan.id)
        .forEach(d => add(d.due_date, 'deliverable', d.title, `/workspaces/${wsId}/engagement-plan`, ['changes_requested','rejected'].includes(d.status) ? 'high' : 'medium'));
    }
    db.prepare(`SELECT id,title,due_date,status FROM tasks WHERE workspace_id=? AND due_date IS NOT NULL`).all(wsId)
      .forEach(t => add(t.due_date, 'task', t.title, `/workspaces/${wsId}/tasks`, t.status === 'blocked' ? 'high' : 'low'));

    // Newer sources: training due, comms plan, competence expiry, supplier reviews, BCP tests, ISO 42001 cert events.
    try {
      db.prepare(`SELECT id, user_name, training_name, due_date, status FROM training_records WHERE workspace_id=? AND due_date IS NOT NULL`).all(wsId)
        .forEach(t => add(t.due_date, 'training', `${t.user_name} - ${t.training_name}`, `/workspaces/${wsId}/training`, t.status === 'completed' ? 'low' : 'medium'));
    } catch (_) {}
    try {
      db.prepare(`SELECT id, what, next_due_date FROM communication_plan WHERE workspace_id=? AND next_due_date IS NOT NULL`).all(wsId)
        .forEach(c => add(c.next_due_date, 'comms', c.what, `/workspaces/${wsId}/communication-plan`, 'low'));
    } catch (_) {}
    try {
      db.prepare(`SELECT id, person_name, competence, expires_on FROM competence_records WHERE workspace_id=? AND expires_on IS NOT NULL`).all(wsId)
        .forEach(c => add(c.expires_on, 'competence', `${c.person_name} - ${c.competence} expires`, `/workspaces/${wsId}/competence`, 'medium'));
    } catch (_) {}
    try {
      db.prepare(`SELECT id, supplier_id, next_review_date FROM supplier_reviews WHERE next_review_date IS NOT NULL
        AND supplier_id IN (SELECT id FROM suppliers WHERE workspace_id=?)`).all(wsId)
        .forEach(r => add(r.next_review_date, 'supplier', `Supplier review`, `/workspaces/${wsId}/vendors/${r.supplier_id}`, 'low'));
    } catch (_) {}
    try {
      db.prepare(`SELECT id, event_type, planned_date FROM iso42001_cert_cycle_events WHERE workspace_id=? AND planned_date IS NOT NULL`).all(wsId)
        .forEach(e => add(e.planned_date, 'iso42001-cert', `[42001] ${e.event_type}`, `/workspaces/${wsId}/iso42001/cert-cycle`, 'medium'));
    } catch (_) {}

    // Group by date for the grid
    const byDate = {};
    events.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });

    // Build month grid (with Sun-Sat layout, padded)
    const firstDay = new Date(yr, mo - 1, 1).getDay(); // 0..6
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${monthStr}-${String(d).padStart(2,'0')}`;
      cells.push({ day: d, date, events: byDate[date] || [] });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    res.render('calendar', {
      user: req.user, ws: req.workspace, monthStr, prevMo, nextMo: nextLabel,
      cells, totalEvents: events.length,
      monthLabel: new Date(yr, mo - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' })
    });
  });


  app.get('/workspaces/:wsId/activity-log.csv', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('audit_log.view'),
    requirePermission('audit_log.export'), (req, res) => {
    const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
      INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.created_at DESC LIMIT 50000`).all(req.workspace.id);
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
    const lines = ['When,User,Action,Entity Type,Entity ID,Details,Before,After,IP,User Agent,Request ID'];
    log.forEach(l => lines.push([l.created_at, l.user_name, l.action, l.entity_type, l.entity_id, l.details, l.before_state, l.after_state, l.ip_address, l.user_agent, l.request_id].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="activity-log-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
    logAction(req.user.id, req.workspace.id, 'export_activity_log', 'workspace', req.workspace.id, null, auditCtx(req));
    res.send(lines.join('\n'));
  });

}

module.exports = { register };
