// Tenant + onboarding routes. First slice of the server.js modularization -
// proves a pattern the rest of server.js can follow:
//
//   1. The route module exports a single register(app, deps) function.
//   2. `deps` is the explicit dependency contract - no module-level closures
//      reaching back into server.js, no globals.
//   3. The module knows nothing about other route groups; if anything here
//      needs cross-domain state it goes through deps.
//
// Routes:
//   GET  /tenants                  list firms
//   POST /tenants                  create new firm + placeholder owner
//   POST /tenants/:id/switch       set active firm in session
//   POST /tenants/:id/rename
//   POST /tenants/:id/delete       destructive, type-the-name confirm
//   GET  /onboarding               6-step setup wizard
//   POST /onboarding/skip
//   POST /onboarding/complete

const path = require('path');
const fs = require('fs');

function buildOnboardingSteps(db) {
  return [
    { num: 1, title: 'Create your first workspace',
      desc: 'A workspace is one client engagement. You\'ll do most of your work inside one.',
      cta: 'Create workspace',
      isDone: (firmId) => db.prepare(`SELECT COUNT(*) c FROM workspaces WHERE firm_id=?`).get(firmId).c > 0,
      href: '/workspaces/new'
    },
    { num: 2, title: 'Define ISMS scope',
      desc: 'What products, locations, and systems are in scope of the ISMS? This decision drives everything else (clause 4.3).',
      cta: 'Set scope',
      isDone: (firmId) => db.prepare(`SELECT COUNT(*) c FROM workspaces WHERE firm_id=? AND scope IS NOT NULL AND length(scope) > 10`).get(firmId).c > 0,
      href: 'first-ws'
    },
    { num: 3, title: 'Build the asset register',
      desc: 'Identify the information and supporting assets in scope. Five to ten entries is enough to start.',
      cta: 'Add assets',
      isDone: (firmId) => db.prepare(`SELECT COUNT(*) c FROM assets a INNER JOIN workspaces w ON w.id=a.workspace_id WHERE w.firm_id=?`).get(firmId).c >= 3,
      href: 'first-ws-assets'
    },
    { num: 4, title: 'Document the risk-assessment methodology',
      desc: 'Define your likelihood and impact scales, and your risk-acceptance criteria. Required by clause 6.1.2.',
      cta: 'Configure methodology',
      isDone: (firmId) => db.prepare(`SELECT COUNT(*) c FROM risk_methodologies m INNER JOIN workspaces w ON w.id=m.workspace_id WHERE w.firm_id=? AND m.is_active=1`).get(firmId).c > 0,
      href: 'first-ws-methodology'
    },
    { num: 5, title: 'Run the gap assessment',
      desc: 'Walk every clause and Annex A control, scoring current state. The wizard takes you through all 118 items.',
      cta: 'Open wizard',
      isDone: (firmId) => db.prepare(`SELECT COUNT(*) c FROM v_control_states cs INNER JOIN workspaces w ON w.id=cs.workspace_id WHERE w.firm_id=? AND cs.status != 'Not Assessed'`).get(firmId).c >= 20,
      href: 'first-ws-assess'
    },
    { num: 6, title: 'Plan the certification cycle',
      desc: 'Lay out Stage 1 → Stage 2 → annual surveillance → recertification dates so you\'re working backwards from a real target.',
      cta: 'Plan cycle',
      isDone: (firmId) => db.prepare(`SELECT COUNT(*) c FROM cert_cycle_events e INNER JOIN workspaces w ON w.id=e.workspace_id WHERE w.firm_id=?`).get(firmId).c > 0,
      href: 'first-ws-cert-cycle'
    }
  ];
}

function resolveOnboardingHref(db, href, firmId) {
  if (!href.startsWith('first-ws')) return href;
  const ws = db.prepare(`SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1`).get(firmId);
  if (!ws) return '/dashboard';
  const subpath = href.replace('first-ws', '').replace(/^-/, '/');
  if (!subpath || subpath === '') return `/workspaces/${ws.id}#workspace-settings`;
  return `/workspaces/${ws.id}/${subpath.replace(/^\//, '')}`.replace(/\/$/, '');
}

const rbac = require('../lib/rbac');
const { auditCtx } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, bcrypt, requireAuth, isFirmUser, getActiveFirmId, listUserFirms, withToast, projectRoot } = deps;

  // ---------- TENANTS ----------
  app.get('/tenants', requireAuth, (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const firms = listUserFirms(req.user);
    const activeFirmId = getActiveFirmId(req);
    res.render('tenants', { user: req.user, firms, activeFirmId });
  });

  // AUTHZ-001: tenant creation provisions a firm, an owner account and an
  // upload root. It was previously reachable by ANY authenticated principal,
  // including client and prospect portal users. Require a firm user holding
  // firm.manage, and provision inside a transaction so a failure cannot leave
  // a partial firm / owner / onboarding row behind.
  app.post('/tenants', requireAuth, (req, res) => {
    if (!isFirmUser(req.user) || !rbac.rolePermissions(req.user.firm_role).includes('firm.manage')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Creating a tenant requires a firm manager.' });
    }
    const name = (req.body.name || '').trim();
    if (!name) return res.redirect('/tenants');

    let fid = null;
    try {
      fid = db.transaction(() => {
        const id = db.prepare('INSERT INTO firms (name) VALUES (?)').run(name).lastInsertRowid;
        const placeholderEmail = `owner+firm${id}@local`;
        const placeholderHash = bcrypt.hashSync('disabled-' + Date.now(), 10);
        db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role, active)
                    VALUES (?, ?, ?, 'firm', ?, 'manager', 1)`).run(placeholderEmail, placeholderHash, `${name} owner`, id);
        db.prepare(`INSERT INTO tenant_onboarding (firm_id, current_step) VALUES (?, 1)`).run(id);
        return id;
      })();
    } catch (err) {
      return res.status(500).render('error', {
        user: req.user, message: 'Could not create the tenant. No changes were saved.' });
    }

    // Directory creation is outside the transaction because it is not
    // transactional; if it fails the firm still exists and uploads will be
    // created lazily, so surface it rather than rolling back governed rows.
    try { fs.mkdirSync(path.join(projectRoot, 'uploads', `firm_${fid}`), { recursive: true }); }
    catch (err) { console.error('[tenants] upload dir for firm', fid, err.message); }

    if (typeof deps.logAction === 'function') {
      try { deps.logAction(req.user.id, null, 'create_firm', 'firm', fid, { name }, auditCtx(req)); } catch (_) {}
    }
    req.session.active_firm_id = fid;
    res.redirect('/onboarding');
  });

  app.post('/tenants/:id/switch', requireAuth, (req, res) => {
    const fid = parseInt(req.params.id, 10);
    // Tenant isolation: firm users can only switch to their own firm;
    // client users can only switch to firms where they have workspace membership.
    if (req.user.user_type === 'firm') {
      if (req.user.firm_id !== fid) return res.status(403).send('Forbidden');
    } else {
      const hasMembership = db.prepare(
        `SELECT 1 FROM workspace_members wm
         INNER JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.user_id = ? AND w.firm_id = ?`
      ).get(req.user.id, fid);
      if (!hasMembership) return res.status(403).send('Forbidden');
    }
    req.session.active_firm_id = fid;
    res.redirect('/dashboard');
  });

  app.post('/tenants/:id/rename', requireAuth, (req, res) => {
    const fid = parseInt(req.params.id, 10);
    // Tenant isolation: only firm-type managers of this specific firm can rename it.
    if (req.user.user_type !== 'firm' || req.user.firm_id !== fid) {
      return res.status(403).send('Forbidden');
    }
    if (req.user.firm_role !== 'manager' && req.user.firm_role !== 'owner') {
      return res.status(403).send('Forbidden');
    }
    const name = (req.body.name || '').trim();
    if (!name) return res.redirect('/tenants');
    db.prepare('UPDATE firms SET name=? WHERE id=?').run(name, fid);
    res.redirect('/tenants');
  });

  // Destructive. Type-the-name confirm + last-tenant guard. Same dynamic-cleanup
  // pattern as workspace delete: enumerate firm_id-bearing tables and clear them.
  app.post('/tenants/:id/delete', requireAuth, (req, res) => {
    const fid = parseInt(req.params.id, 10);
    // Tenant isolation: only firm-type managers of this specific firm can delete it.
    if (req.user.user_type !== 'firm' || req.user.firm_id !== fid) {
      return res.status(403).send('Forbidden');
    }
    if (req.user.firm_role !== 'manager' && req.user.firm_role !== 'owner') {
      return res.status(403).send('Forbidden');
    }
    const firm = db.prepare('SELECT id, name FROM firms WHERE id=?').get(fid);
    if (!firm) return res.redirect(withToast('/tenants', 'Tenant not found', 'error'));

    const confirm = (req.body.confirm_name || '').trim();
    if (confirm !== firm.name) {
      return res.redirect(withToast('/tenants', 'Confirmation name did not match - nothing deleted', 'error'));
    }

    const totalFirms = db.prepare('SELECT COUNT(*) c FROM firms').get().c;
    if (totalFirms <= 1) {
      return res.redirect(withToast('/tenants', 'Cannot delete the only remaining tenant', 'error'));
    }

    const wsIds = db.prepare('SELECT id FROM workspaces WHERE firm_id=?').all(fid).map(r => r.id);
    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        if (wsIds.length) {
          const wsTables = db.prepare(`
            SELECT m.name FROM sqlite_master m
            WHERE m.type='table'
            AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='workspace_id')
          `).all().map(r => r.name);
          const placeholders = wsIds.map(() => '?').join(',');
          for (const t of wsTables) {
            db.prepare(`DELETE FROM ${t} WHERE workspace_id IN (${placeholders})`).run(...wsIds);
          }
          db.prepare(`DELETE FROM workspaces WHERE firm_id=?`).run(fid);
        }
        const firmTables = db.prepare(`
          SELECT m.name FROM sqlite_master m
          WHERE m.type='table'
          AND m.name != 'firms'
          AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='firm_id')
        `).all().map(r => r.name);
        for (const t of firmTables) {
          db.prepare(`DELETE FROM ${t} WHERE firm_id=?`).run(fid);
        }
        db.prepare('DELETE FROM firms WHERE id=?').run(fid);
      });
      tx();
    } finally {
      db.pragma('foreign_keys = ON');
    }

    try {
      const tenantDir = path.join(projectRoot, 'uploads', `firm_${fid}`);
      if (fs.existsSync(tenantDir)) fs.rmSync(tenantDir, { recursive: true, force: true });
    } catch (_) {}

    if (req.session.active_firm_id === fid) {
      const fallback = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
      req.session.active_firm_id = fallback ? fallback.id : null;
    }

    res.redirect(withToast('/tenants', `Tenant "${firm.name}" deleted`, 'success'));
  });

  // ---------- ONBOARDING ----------
  const ONBOARDING_STEPS = buildOnboardingSteps(db);

  app.get('/onboarding', requireAuth, (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const firmId = getActiveFirmId(req);
    if (!firmId) return res.redirect('/tenants');
    let onb = db.prepare(`SELECT * FROM tenant_onboarding WHERE firm_id=?`).get(firmId);
    if (!onb) {
      db.prepare(`INSERT INTO tenant_onboarding (firm_id) VALUES (?)`).run(firmId);
      onb = db.prepare(`SELECT * FROM tenant_onboarding WHERE firm_id=?`).get(firmId);
    }
    const stepStates = ONBOARDING_STEPS.map(s => ({
      ...s,
      done: !!s.isDone(firmId),
      href: resolveOnboardingHref(db, s.href, firmId)
    }));
    const completedCount = stepStates.filter(s => s.done).length;
    res.render('onboarding', {
      user: req.user, ws: null, steps: stepStates, completedCount,
      totalSteps: ONBOARDING_STEPS.length, onb
    });
  });

  app.post('/onboarding/skip', requireAuth, (req, res) => {
    const firmId = getActiveFirmId(req);
    if (firmId) db.prepare(`UPDATE tenant_onboarding SET skipped=1, completed_at=CURRENT_TIMESTAMP WHERE firm_id=?`).run(firmId);
    res.redirect('/dashboard');
  });

  app.post('/onboarding/complete', requireAuth, (req, res) => {
    const firmId = getActiveFirmId(req);
    if (firmId) db.prepare(`UPDATE tenant_onboarding SET completed_at=CURRENT_TIMESTAMP WHERE firm_id=?`).run(firmId);
    res.redirect('/dashboard');
  });
}

// Lightweight onboarding-progress reader for places outside this module
// (currently the dashboard) that want to surface "resume setup" cues
// without re-implementing the step definitions. Returns null when there's
// nothing useful to show.
function getOnboardingProgress(db, firmId) {
  if (!firmId) return null;
  const onb = db.prepare(`SELECT * FROM tenant_onboarding WHERE firm_id=?`).get(firmId);
  const steps = buildOnboardingSteps(db);
  const stepStates = steps.map(s => ({ num: s.num, title: s.title, done: !!s.isDone(firmId) }));
  const done = stepStates.filter(s => s.done).length;
  const total = stepStates.length;
  return {
    done, total,
    pct: total ? Math.round(done / total * 100) : 0,
    skipped: !!(onb && onb.skipped),
    completed: !!(onb && onb.completed_at && done === total),
    nextStep: stepStates.find(s => !s.done) || null,
  };
}

module.exports = { register, getOnboardingProgress };
