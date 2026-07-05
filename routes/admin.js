'use strict';
// Firm-level admin routes. Slice 4 of the server.js modularization
// (register(app, deps) pattern; auth + /admin/users live in routes/auth.js).
//
// Routes: GET /admin/activity, GET /admin/email, POST /admin/email/settings,
// POST /admin/email/test, POST /admin/jobs/run.

const rbac = require('../lib/rbac');
const email = require('../lib/email');
const jobs = require('../lib/jobs');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, logAction, isFirmOwner, getActiveFirmId } = deps;


  // Cross-client activity feed lives under Admin in the portfolio sidebar -
  // pulled out of the dashboard so the landing page stays focused on the
  // portfolio roll-up. Manager-only (same gate as the rest of Admin).
  app.get('/admin/activity', requireAuth, (req, res) => {
    if (!rbac.isManager(req.user.firm_role)) {
      return res.status(403).render('error', { user: req.user, message: 'Only Managers can view firm-wide activity.' });
    }
    const wsIds = db.prepare(`SELECT id FROM workspaces WHERE firm_id = ?`).all(req.user.firm_id).map(r => r.id);
    let recentActivity = [];
    let pg = null;
    if (wsIds.length > 0) {
      const placeholders = wsIds.map(() => '?').join(',');
      const whereSql = `FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         INNER JOIN workspaces w ON w.id = a.workspace_id
         WHERE a.workspace_id IN (${placeholders})
           AND a.created_at >= date('now','-90 days')`;
      pg = paginate(db, req, {
        count: `SELECT COUNT(*) c ${whereSql}`,
        rows: `SELECT a.created_at, a.action, a.entity_type, a.entity_id, a.workspace_id,
                u.name AS user_name, w.client_name ${whereSql} ORDER BY a.created_at DESC`,
        params: wsIds, perPage: 100,
      });
      recentActivity = pg.rows;
    }
    res.render('admin_activity', { user: req.user, ws: null, active: 'admin-activity', recentActivity, pg, pagerHref: p => pageHref(req, p) });
  });

  app.get('/admin/email', requireAuth, (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).render('error', { user: req.user, message: 'Only firm owners can manage email settings.' });
    const firmId = getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const settings = email.getFirmEmailSettings(firmId);
    const outbox = db.prepare(`SELECT * FROM email_outbox WHERE firm_id=? ORDER BY created_at DESC LIMIT 50`).all(firmId);
    const counts = {
      sent_7d: db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE firm_id=? AND status='sent' AND created_at >= datetime('now','-7 days')`).get(firmId).c,
      failed_7d: db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE firm_id=? AND status='failed' AND created_at >= datetime('now','-7 days')`).get(firmId).c
    };
    res.render('admin_email', {
      user: req.user,
      ws: null, // firm-level page - firm sidebar (see GET /glossary note)
      settings,
      outbox,
      counts,
      provider: email.currentProvider(),
      providerConfigured: email.currentProvider() !== 'devnull',
      envFromDefault: process.env.EMAIL_FROM_DEFAULT || null,
      appBaseUrl: email.appBaseUrl()
    });
  });

  app.post('/admin/email/settings', requireAuth, (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
    const firmId = getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    email.getFirmEmailSettings(firmId); // ensure row exists
    const { from_name, from_email, reply_to, enabled } = req.body;
    // Light validation: from_email and reply_to should look like emails if set.
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (from_email && !emailRe.test(from_email.trim())) {
      return res.status(400).render('error', { user: req.user, message: '"From email" doesn\'t look like a valid address.' });
    }
    if (reply_to && !emailRe.test(reply_to.trim())) {
      return res.status(400).render('error', { user: req.user, message: '"Reply-to" doesn\'t look like a valid address.' });
    }
    db.prepare(`UPDATE firm_email_settings SET from_name=?, from_email=?, reply_to=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE firm_id=?`)
      .run(
        (from_name || '').trim() || null,
        (from_email || '').trim() || null,
        (reply_to || '').trim() || null,
        enabled === '1' || enabled === 'on' ? 1 : 0,
        firmId
      );
    logAction(req.user.id, null, 'update_email_settings', 'firm', firmId, null);
    res.redirect(withToast('/admin/email', 'Email settings saved'));
  });

  app.post('/admin/email/test', requireAuth, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
    const firmId = getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    const to = (req.body.to || '').trim();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(to)) {
      return res.status(400).render('error', { user: req.user, message: 'Enter a valid email address to send the test to.' });
    }
    const result = await email.sendTestEmail(firmId, to);
    const msg = result.ok
      ? `Test email sent to ${to}` + (result.provider === 'devnull' ? ' (dev fallback - check data/email-dev-outbox.log)' : '')
      : `Send failed: ${result.error}`;
    res.redirect(withToast('/admin/email', msg, result.ok ? 'success' : 'error'));
  });

  // Manual job-run trigger (for admins / debugging)
  app.post('/admin/jobs/run', requireAuth, (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
    const out = jobs.runAllJobs();
    res.json(out);
  });
}

module.exports = { register };
