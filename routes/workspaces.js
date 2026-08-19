'use strict';
// Workspace lifecycle. Slice 15 of the server.js modularization: workspace
// CRUD, members, and team setup (engagement kickoff + client-side invites).
// Shares the invite token scheme with routes/auth.js.

const fs = require('fs');
const crypto = require('crypto');
const rbac = require('../lib/rbac');
const ctlReads = require('../lib/control-reads');
const email = require('../lib/email');
const { hashToken, INVITE_TTL_MS } = require('./auth');
const { ALLOWED_FRAMEWORKS } = require('../lib/frameworks');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');
const { buildWorkspaceTruth } = require('../lib/grc-truth');
const csfModel = require('../lib/csf-policy-practice');
const { buildIntegratedDashboard } = require('../lib/integrated-dashboard');

function submittedFrameworks(value) {
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  return [...new Set(values.filter(code => ALLOWED_FRAMEWORKS.includes(code)))];
}

function firmUserCan(user, permission) {
  if (!user || user.user_type !== 'firm') return false;
  return rbac.rolePermissions(rbac.normalizeRole(user.firm_role) || 'consultant').includes(permission);
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          isFirmUser, computeReadiness, workspaceProgress, computeNextStep,
          computeRoadmap, computeClientStage, computeNeedsAttention, resolveUploadPath } = deps;

  // ==================== WORKSPACE CRUD ====================
  app.get('/workspaces/new', requireAuth, (req, res) => {
    if (!firmUserCan(req.user, 'workspace.create')) return res.status(403).render('error', { user: req.user, message: 'You do not have permission to create client workspaces.' });
    res.render('workspace_new', { user: req.user, ws: null });
  });

  app.post('/workspaces', requireAuth, (req, res) => {
    if (!firmUserCan(req.user, 'workspace.create')) return res.status(403).send('Forbidden');
    const { client_name, industry, scope, target_cert_date } = req.body;
    if (!client_name) return res.redirect('/dashboard');
    // Every programme is optional at client creation. An empty array is a
    // governed planning state, not a signal to silently enable every framework.
    const frameworks = submittedFrameworks(req.body.frameworks);
    const id = db.prepare(`INSERT INTO workspaces (firm_id, client_name, industry, scope, target_cert_date, lead_consultant_id, frameworks)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.firm_id, client_name.trim(), industry || null,
           scope || null, target_cert_date || null, req.user.id,
           JSON.stringify(frameworks)).lastInsertRowid;
    // Seed the intake's cert-deadline answer from the create-dialog value
    // so the engagement-summary panel on /intake picks it up immediately
    // (otherwise the deadline-pressure tile stays blank until the user
    // re-enters the same date in the cert-deadline question).
    if (target_cert_date) {
      try {
        db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
          VALUES (?, 'cert-deadline', ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(workspace_id, question_id) DO UPDATE SET answer=excluded.answer, answered_by=excluded.answered_by, answered_at=CURRENT_TIMESTAMP`)
          .run(id, target_cert_date, req.user.id);
      } catch (e) { console.error('[create-client] seed cert-deadline failed:', e.message); }
    }
    logAction(req.user.id, id, 'create_workspace', 'workspace', id, { client_name, frameworks });
    // Redirect into the intake page rather than the workspace overview. The
    // overview is meaningful only once the engagement has real context;
    // intake is the obvious next step (scope sign-off, stakeholders, crown
    // jewels) and the page already shows progress + an "Apply to workspace"
    // button that backfills the scope statement and links crown-jewel assets.
    res.redirect(withToast('/workspaces/' + id + '/intake', 'Workspace created - start with the engagement intake'));
  });

  app.get('/workspaces/:wsId', requireAuth, requireWorkspace, (req, res) => {
    const ws = req.workspace;
    const frameworkCodes = Array.isArray(ws.frameworks) ? ws.frameworks : [];

    // A CSF-only workspace has one authoritative home: the cybersecurity
    // maturity programme. Keeping a separate generic overview creates two
    // navigation entries for the same decision surface.
    if (frameworkCodes.length === 1 && frameworkCodes[0] === 'csf') {
      return res.redirect(`/workspaces/${ws.id}/csf`);
    }

    // Split-brain fix: if the client setup has never been started AND the
    // scope field is empty, the overview's readiness/charts are mostly
    // zeros - send the consultant to setup instead. Once they've answered
    // even one intake question (or pasted in a scope manually), the
    // overview becomes the home and we stop redirecting.
    const intakeAnswered = db.prepare(`SELECT COUNT(*) AS c FROM engagement_intake WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer)) > 0`).get(ws.id).c;
    const hasScope = !!(ws.scope && ws.scope.trim().length > 0);
    if (intakeAnswered === 0 && !hasScope && !req.query.skipSetupRedirect) {
      return res.redirect(`/workspaces/${ws.id}/intake`);
    }
    // Partial setup signal - render overview with a banner. Threshold of
    // 8 matches "roughly the first two sections of the 25-question intake."
    // Once the scope is confirmed, the consultant has explicitly moved
    // past setup, so suppress the banner even if the answer count is low
    // (they signed off knowing what was captured).
    const setupIncomplete = intakeAnswered > 0 && intakeAnswered < 8 && !ws.scope_confirmed_at;

    // The workspace home follows the programme that is actually being
    // delivered. A CSF-only client (or a client whose only assessment
    // activity is CSF) must never land on ISO 27001 certification metrics.
    if (frameworkCodes.length === 0) {
      return res.render('workspace_unassigned', {
        user:req.user, ws, setupIncomplete, intakeAnswered,
        frameworkOptions:ALLOWED_FRAMEWORKS,
      });
    }
    if (frameworkCodes.length > 1) {
      return res.render('workspace_integrated', {
        user:req.user, ws, active:'overview', setupIncomplete, intakeAnswered,
        dashboard:buildIntegratedDashboard(db,ws),
      });
    }
    const csfEngagements = frameworkCodes.includes('csf') ? csfModel.programmeEngagements(db,ws.id) : [];
    const currentCsfEngagement = csfEngagements[0] || null;
    let isoActivity = 0;
    if (currentCsfEngagement) {
      const activityTables = ctlReads.tables(db, ws.id);
      isoActivity += db.prepare(`SELECT COUNT(*) c FROM ${activityTables.cs} WHERE workspace_id=?`).get(ws.id).c;
      isoActivity += db.prepare(`SELECT COUNT(*) c FROM ${activityTables.cs42} WHERE workspace_id=?`).get(ws.id).c;
    }
    if (currentCsfEngagement && isoActivity === 0) {
      return res.render('csf2_engagements', {
        user:req.user, ws, active:'overview', homeMode:true,
        engagements:csfEngagements, currentEngagement:currentCsfEngagement,
        programme:currentCsfEngagement ? csfModel.programmeData(db,currentCsfEngagement) : null,
        canCreate:csfModel.canCreate(req.user,ws),
      });
    }

    const progress = workspaceProgress(ws.id);

    // Status breakdown
    const T = ctlReads.tables(db, ws.id);
    const STATUSES = ['Implemented','Partially Implemented','Work In Progress','Not Implemented','Not Applicable','Not Assessed'];
    const stateRows = db.prepare(`SELECT i.id, i.type, i.category, COALESCE(cs.status,'Not Assessed') AS status
                                  FROM iso_items i
                                  LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?`)
      .all(ws.id);

    const breakdown = { clauses: {}, annex: {} };
    STATUSES.forEach(s => { breakdown.clauses[s] = 0; breakdown.annex[s] = 0; });
    stateRows.forEach(r => {
      if (r.type === 'clause') breakdown.clauses[r.status]++;
      else breakdown.annex[r.status]++;
    });

    // Per-section counts (Requirements = clauses 4-10, A.5/A.6/A.7/A.8 =
    // Annex A themes). Tracks both how much has been assessed (anything not
    // "Not Assessed") and how much is Implemented. Feeds the overview's
    // gap-assessment + implementation summary panel.
    const themes = {
      requirements: { label: 'Requirements', total: 0, assessed: 0, implemented: 0 },
      org:          { label: 'A.5 Org',      total: 0, assessed: 0, implemented: 0 },
      people:       { label: 'A.6 People',   total: 0, assessed: 0, implemented: 0 },
      physical:     { label: 'A.7 Physical', total: 0, assessed: 0, implemented: 0 },
      tech:         { label: 'A.8 Tech',     total: 0, assessed: 0, implemented: 0 }
    };
    stateRows.forEach(r => {
      let key = null;
      if (r.type === 'clause') key = 'requirements';
      else if (themes[r.category]) key = r.category;
      if (!key) return;
      themes[key].total++;
      if (r.status !== 'Not Assessed') themes[key].assessed++;
      if (r.status === 'Implemented') themes[key].implemented++;
    });

    const riskCount = db.prepare('SELECT COUNT(*) AS c FROM risks WHERE workspace_id = ?').get(ws.id).c;
    const openRisks = db.prepare(`SELECT * FROM risks WHERE workspace_id = ? AND status = 'open'
                                  ORDER BY (likelihood * impact) DESC LIMIT 5`).all(ws.id);
    const assetCount = db.prepare('SELECT COUNT(*) AS c FROM assets WHERE workspace_id = ?').get(ws.id).c;
    const evidenceCount = db.prepare('SELECT COUNT(*) AS c FROM evidence WHERE workspace_id = ?').get(ws.id).c;
    const openTasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t
      LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.workspace_id = ? AND t.status NOT IN ('done') ORDER BY t.due_date ASC LIMIT 10`).all(ws.id);

    const actionItems = db.prepare(`SELECT i.id, i.title, cs.status FROM iso_items i
      INNER JOIN ${T.cs} cs ON cs.iso_item_id = i.id
      WHERE cs.workspace_id = ? AND cs.status IN ('Not Implemented','Partially Implemented')
      ORDER BY i.sort_order LIMIT 20`).all(ws.id);

    const docCount = db.prepare('SELECT COUNT(*) AS c FROM generated_docs WHERE workspace_id = ?').get(ws.id).c;
    const auditCount = db.prepare('SELECT COUNT(*) AS c FROM audits WHERE workspace_id = ?').get(ws.id).c;
    const mrmCount = db.prepare('SELECT COUNT(*) AS c FROM mrms WHERE workspace_id = ?').get(ws.id).c;
    const ncOpen = db.prepare(`SELECT COUNT(*) AS c FROM nonconformities
      WHERE workspace_id = ? AND status NOT IN ('closed','verified')`).get(ws.id).c;
    const recentActivity = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
      INNER JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 8`).all(ws.id);

    const readiness = computeReadiness(ws);

    // 30-day activity sparkline data
    const sparkRows = db.prepare(`SELECT date(created_at) AS d, COUNT(*) AS c
      FROM audit_log WHERE workspace_id = ? AND created_at >= date('now','-29 days')
      GROUP BY date(created_at)`).all(ws.id);
    const sparkMap = Object.fromEntries(sparkRows.map(r => [r.d, r.c]));
    const sparkline = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      sparkline.push({ d: key, c: sparkMap[key] || 0 });
    }

    // Implementation roadmap - extracted to a helper so the new /roadmap page
    // can share the same source of truth as the Overview dashboard.
    const roadmap = computeRoadmap(ws, { stateRows, assetCount, riskCount, ncOpen });
    // Tier B.6 - top "needs your attention" items for the overview
    const needsAttention = computeNeedsAttention(ws.id).slice(0, 8);
    const truth = buildWorkspaceTruth(db, ws, readiness);
    const computedNextStep = computeNextStep(ws);
    const nextStep = truth.nextAction ? {
      title: truth.nextAction.title,
      why: truth.nextAction.impact,
      href: truth.nextAction.href,
      cta: truth.nextAction.cta
    } : computedNextStep;
    const derivedStage = { key: truth.verdict.key, label: truth.verdict.label };
    // Active gap-assessment pass (if any) so the overview can show
    // "Pass 1 in progress · 87 of 118 assessed" without forcing the
    // consultant to click into Gap assessment to see it.
    let activePass = null;
    try {
      activePass = db.prepare(`SELECT id, pass_number, label, started_at, status
        FROM assessment_passes WHERE workspace_id=? AND status='in_progress'
        ORDER BY pass_number DESC LIMIT 1`).get(ws.id) || null;
    } catch (_) {}

    res.render('workspace', {
      user: req.user, ws, progress, breakdown, themes, riskCount, openRisks,
      assetCount, evidenceCount, openTasks, actionItems,
      docCount, auditCount, mrmCount, ncOpen, recentActivity, readiness, sparkline,
      roadmap, needsAttention, nextStep, activePass,
      setupIncomplete, intakeAnswered, derivedStage, truth
    });
  });

  // Roadmap is a projection of the authoritative adaptive delivery plan.
  // Keep the legacy URL for bookmarks, but never maintain a second plan.
  app.get('/workspaces/:wsId/roadmap', requireAuth, requireWorkspace, (req, res) => {
    res.redirect(`/workspaces/${req.workspace.id}/engagement-plan?view=timeline`);
  });

  app.post('/workspaces/:wsId/frameworks', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req,res) => {
    const frameworks = submittedFrameworks(req.body.frameworks);
    db.prepare(`UPDATE workspaces SET frameworks=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(frameworks),req.workspace.id);
    logAction(req.user.id,req.workspace.id,'update_workspace_frameworks','workspace',req.workspace.id,{frameworks},auditCtx(req));
    const message = frameworks.length ? 'Assessment programmes updated' : 'Client left without an assigned assessment programme';
    res.redirect(withToast(`/workspaces/${req.workspace.id}`,message));
  });

  app.post('/workspaces/:wsId/update', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    const {
      client_name, industry, scope, target_cert_date, stage, lead_consultant_id,
      brand_display_name, brand_primary_color, brand_logo_path, sector,
      updated_at_snapshot,
    } = req.body;
    // Validate brand color is a hex literal - anything else gets stored as null so
    // a malformed value can't break the page CSS.
    const safeColor = (typeof brand_primary_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(brand_primary_color.trim()))
      ? brand_primary_color.trim() : null;
    const frameworks = req.body.frameworks_present === '1'
      ? submittedFrameworks(req.body.frameworks)
      : (Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : []);
    // Optimistic concurrency: client roundtrips workspaces.updated_at as a
    // hidden field. The UPDATE WHERE updated_at = ? guarantees only one of
    // two simultaneous edits wins; the loser is redirected to a conflict page
    // that surfaces the new state so they can re-apply their edit deliberately.
    // Forms rendered before this fix won't include the field; treat missing
    // snapshot as "skip the check" so the migration doesn't break old tabs.
    const usingCAS = !!updated_at_snapshot;
    const sql = usingCAS
      ? `UPDATE workspaces
           SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?,
               brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?, frameworks=?,
               updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND updated_at=?`
      : `UPDATE workspaces
           SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?,
               brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?, frameworks=?,
               updated_at=CURRENT_TIMESTAMP
         WHERE id=?`;
    const args = [
      client_name, industry || null, scope || null, target_cert_date || null,
      stage || 'gap_assessment', lead_consultant_id || null,
      (brand_display_name || '').trim() || null,
      safeColor,
      (brand_logo_path || '').trim() || null,
      (sector || '').trim() || null,
      JSON.stringify(frameworks),
      req.workspace.id,
    ];
    if (usingCAS) args.push(updated_at_snapshot);
    const result = db.prepare(sql).run(...args);
    if (usingCAS && result.changes === 0) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'Another consultant updated this client\'s settings while you were editing. Reload the workspace settings page to see the latest values, then re-apply your changes.'
      });
    }
    logAction(req.user.id, req.workspace.id, 'update_workspace', 'workspace', req.workspace.id, { frameworks });
    res.redirect('/workspaces/' + req.workspace.id);
  });

  // Destructive: delete a workspace (= one client engagement) and everything
  // inside it - controls, risks, evidence rows + files on disk, audits, MRMs,
  // gap passes, registers. Requires typing the client name to confirm.
  app.post('/workspaces/:wsId/delete', requireAuth, requireWorkspace, requirePermission('workspace.delete'), (req, res) => {
    const ws = req.workspace;
    const confirm = (req.body.confirm_name || '').trim();
    if (confirm !== ws.client_name) {
      return res.redirect(withToast('/workspaces/' + ws.id + '#workspace-settings',
        'Confirmation name did not match - nothing deleted', 'error'));
    }

    // Collect evidence file paths so we can wipe them off disk after the row delete.
    const evidenceFiles = db.prepare(`SELECT stored_path FROM evidence WHERE workspace_id=? AND stored_path IS NOT NULL`).all(ws.id);

    // Most workspace-scoped tables have ON DELETE CASCADE, but the schema has
    // grown over time and a few tables don't. Use the same dynamic-cleanup
    // pattern as tenant deletion so this stays correct as the schema evolves.
    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        const wsTables = db.prepare(`
          SELECT m.name FROM sqlite_master m
          WHERE m.type='table'
          AND m.name != 'workspaces'
          AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='workspace_id')
        `).all().map(r => r.name);
        for (const t of wsTables) {
          db.prepare(`DELETE FROM ${t} WHERE workspace_id=?`).run(ws.id);
        }
        db.prepare('DELETE FROM workspaces WHERE id=?').run(ws.id);
      });
      tx();
    } finally {
      db.pragma('foreign_keys = ON');
    }

    // Best-effort filesystem cleanup. Files live in uploads/firm_{id}/ shared
    // across workspaces, so we have to delete by exact path rather than wiping
    // a directory.
    for (const e of evidenceFiles) {
      try {
        const abs = resolveUploadPath(e.stored_path, ws.firm_id);
        if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (_) {}
    }

    logAction(req.user.id, null, 'delete_workspace', 'workspace', ws.id, ws.client_name);
    res.redirect(withToast('/dashboard', `Client "${ws.client_name}" deleted`, 'success'));
  });

  // ==================== WORKSPACE MEMBERS ====================
  app.get('/workspaces/:wsId/members', requireAuth, requireWorkspace, (req, res) => {
    const members = db.prepare(`SELECT m.*, u.name, u.email, u.user_type, u.firm_role
      FROM workspace_members m INNER JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? ORDER BY u.name`).all(req.workspace.id);
    const firmConsultants = isFirmUser(req.user) ?
      db.prepare(`SELECT id, name, email FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1`).all(req.user.firm_id) :
      [];
    res.render('members', { user: req.user, ws: req.workspace, members, firmConsultants });
  });

  app.post('/workspaces/:wsId/members/client', requireAuth, requireWorkspace, requirePermission('members.add'), (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || password.length < 8) return res.redirect('/workspaces/' + req.workspace.id + '/members');
    const e = email.toLowerCase().trim();
    const r = rbac.CLIENT_ROLES.includes(role) ? role : 'contributor';

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
    if (!user) {
      const hash = bcrypt.hashSync(password, 10);
      const userId = db.prepare(`INSERT INTO users (email, password_hash, name, user_type)
                                 VALUES (?, ?, ?, 'client')`).run(e, hash, name.trim(), ).lastInsertRowid;
      user = { id: userId };
    }
    try {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
        .run(req.workspace.id, user.id, r);
    } catch (e) { /* already member */ }
    logAction(req.user.id, req.workspace.id, 'add_client_user', 'user', user.id, { email: e, role: r });
    res.redirect('/workspaces/' + req.workspace.id + '/members');
  });

  app.post('/workspaces/:wsId/members/firm', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const { user_id, role } = req.body;
    // Firm-side workspace members map to firm-side roles. Senior consultant is
    // the highest a firm member can hold here; Manager is firm-wide, not per-ws.
    const allowedRoles = ['senior_consultant','consultant'];
    const r = allowedRoles.includes(role) ? role : 'consultant';
    try {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
        .run(req.workspace.id, user_id, r);
    } catch (e) { /* dup */ }
    res.redirect('/workspaces/' + req.workspace.id + '/members');
  });

  app.post('/workspaces/:wsId/members/:memberId/remove', requireAuth, requireWorkspace, requirePermission('members.remove'), (req, res) => {
    db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?')
      .run(req.params.memberId, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/members');
  });

  // ==================== TEAM SETUP (engagement kickoff) ====================
  // Inserted between "scoping confirmed" and "start gap assessment." A manager
  // fills the scoping questionnaire, picks the firm consultants on the
  // engagement, and either invites client-side accounts (Client sponsor,
  // coordinator, contributors) or skips to do that later. The same screen also
  // lives in the sidebar's Setup group so managers can revisit it after
  // kickoff to add or remove people.

  app.get('/workspaces/:wsId/team', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'Only firm consultants can manage the engagement team.' });
    }
    const ws = req.workspace;
    // Firm users who could be on this engagement - all active firm members of
    // the firm that owns this workspace.
    const firmPool = db.prepare(`SELECT id, name, email, firm_role FROM users
       WHERE firm_id = ? AND user_type = 'firm' AND active = 1
       ORDER BY (firm_role = 'manager') DESC, name`).all(ws.firm_id);
    const leadConsultant = ws.lead_consultant_id
      ? db.prepare(`SELECT id, name, email, firm_role FROM users WHERE id = ?`).get(ws.lead_consultant_id)
      : null;
    // workspace_members on the firm side, excluding the lead (which is rendered
    // separately above).
    const firmMembers = db.prepare(`SELECT wm.id AS member_id, wm.role, u.id AS user_id, u.name, u.email, u.firm_role
       FROM workspace_members wm INNER JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND u.user_type = 'firm' AND u.active = 1
       ORDER BY (wm.role = 'senior_consultant') DESC, u.name`).all(ws.id);
    const clientMembers = db.prepare(`SELECT wm.id AS member_id, wm.role, u.id AS user_id, u.name, u.email, u.last_active_at
       FROM workspace_members wm INNER JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND u.user_type = 'client'
       ORDER BY CASE wm.role WHEN 'client_owner' THEN 1 WHEN 'isms_manager' THEN 2 ELSE 3 END, u.name`).all(ws.id);
    const pendingInvites = db.prepare(`SELECT id, email, name, workspace_role, expires_at, created_at
       FROM user_invitations
       WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
       ORDER BY created_at DESC`).all(ws.id);

    res.render('team_setup', {
      user: req.user, ws, active: 'team',
      firmPool, leadConsultant, firmMembers, clientMembers, pendingInvites,
      scopeConfirmed: !!ws.scope_confirmed_at,
      notice: req.query.notice || null,
      error: req.query.error || null
    });
  });

  app.post('/workspaces/:wsId/team/set-lead', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const leadId = parseInt(req.body.lead_consultant_id, 10) || null;
    // Validate the chosen lead is in this firm; null is allowed to clear.
    if (leadId) {
      const exists = db.prepare(`SELECT id FROM users WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`).get(leadId, req.workspace.firm_id);
      if (!exists) return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('That user is not in your firm.'));
    }
    db.prepare(`UPDATE workspaces SET lead_consultant_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(leadId, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'set_lead_consultant', 'workspace', req.workspace.id, { lead_consultant_id: leadId }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Engagement lead updated.'));
  });

  app.post('/workspaces/:wsId/team/add-firm-member', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const userId = parseInt(req.body.user_id, 10);
    const role = ['senior_consultant', 'consultant'].includes(req.body.role) ? req.body.role : 'consultant';
    if (!userId) return res.redirect('/workspaces/' + req.workspace.id + '/team');
    // Same-firm check; prevents adding someone from another firm via crafted form.
    const exists = db.prepare(`SELECT id FROM users WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`).get(userId, req.workspace.firm_id);
    if (!exists) return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('Pick a firm consultant.'));
    try {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(req.workspace.id, userId, role);
    } catch (_) { /* already a member - ignore */ }
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant added to engagement.'));
  });

  app.post('/workspaces/:wsId/team/remove-firm-member/:memberId', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?').run(req.params.memberId, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant removed from engagement.'));
  });

  app.post('/workspaces/:wsId/team/invite-client', requireAuth, requireWorkspace, async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = (b.name || '').trim() || null;
    const role = ['client_owner', 'isms_manager', 'contributor'].includes(b.workspace_role) ? b.workspace_role : 'contributor';
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('A valid email is required.'));
    }
    // Reuse the duplicate-detection from /admin/users/invite. An active account
    // gets an inline reset offer on /admin/users - for the team kickoff page we
    // keep things simple and just redirect there so the manager handles it once.
    const existing = db.prepare(`SELECT id, active FROM users WHERE email = ?`).get(email);
    if (existing) {
      const which = existing.active ? 'active' : 'deactivated';
      return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent(
        `An ${which} account already exists for ${email}. Open Admin → Users & access to reactivate, reset password, or add them to this workspace.`));
    }
    // Replace any pending invitation for the same email + workspace, same shape
    // as /admin/users/invite - keeps outstanding list tidy.
    db.prepare(`UPDATE user_invitations SET revoked_at = CURRENT_TIMESTAMP
       WHERE firm_id = ? AND workspace_id = ? AND email = ?
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`)
      .run(req.user.firm_id, req.workspace.id, email);

    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    db.prepare(`INSERT INTO user_invitations
        (email, name, firm_id, user_type, workspace_id, workspace_role, token_hash, expires_at, invited_by)
        VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?)`)
      .run(email, name, req.user.firm_id, req.workspace.id, role, tokenHash, expiresAt, req.user.id);

    let sendError = null;
    try {
      const emailLib = require('../lib/email');
      const firmRow = db.prepare(`SELECT name FROM firms WHERE id = ?`).get(req.user.firm_id);
      const r = await emailLib.sendInviteEmail({
        toEmail: email, toName: name, inviterName: req.user.name,
        firmName: firmRow && firmRow.name,
        role: `Client-side - ${rbac.ROLE_LABELS[role] || role}`,
        token: raw, expiresAt, firmId: req.user.firm_id
      });
      if (!r.ok) sendError = r.error || 'Email delivery failed';
    } catch (e) { sendError = e && e.message; }

    if (sendError) {
      return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' +
        encodeURIComponent(`Invitation created but email failed (${sendError}). Share the link manually: /invite/${raw}`));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' +
      encodeURIComponent(`Invitation sent to ${email}. Link expires in 7 days.`));
  });

  app.post('/workspaces/:wsId/team/revoke-invite/:invId', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const inv = db.prepare(`SELECT id, workspace_id FROM user_invitations WHERE id = ?`).get(req.params.invId);
    if (!inv || inv.workspace_id !== req.workspace.id) return res.redirect('/workspaces/' + req.workspace.id + '/team');
    db.prepare(`UPDATE user_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(inv.id);
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Invitation revoked.'));
  });

}

module.exports = { register };
