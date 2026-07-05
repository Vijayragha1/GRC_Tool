'use strict';
// NIST CSF 2.0 cluster. Slice 14 of the server.js modularization:
// engagements, assessments + scoring, versions/diffs, findings, portal,
// learn docs, catalog.

const MarkdownIt = require('markdown-it');
const email = require('../lib/email');
const { withToast, redirectBack, auditCtx, escapeHtml } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, upload } = deps;

  // ==================== NIST CSF 2.0 ====================
  // Module layout (Stage 2):
  //   GET  /workspaces/:wsId/csf                    engagement list (landing)
  //   GET  /workspaces/:wsId/csf/catalog            catalog browser (read-only)
  //   GET  /workspaces/:wsId/csf/new                new engagement form
  //   POST /workspaces/:wsId/csf                    create engagement
  //   GET  /workspaces/:wsId/csf/:id(\\d+)           engagement detail
  //   POST /workspaces/:wsId/csf/:id/assign         add assignment
  //   POST /workspaces/:wsId/csf/:id/unassign/:aid  remove assignment
  //
  // Literal sub-routes (`new`, `catalog`) must be registered before `/:id` and
  // the :id capture is digit-constrained so they can't collide (same lesson as
  // /soa/snapshots/:id vs /soa/snapshots/diff in commit 6fdb9b5).
  const csfPolicy = require('../lib/csf-policy');

  // Engagement list
  app.get('/workspaces/:wsId/csf', requireAuth, requireWorkspace, (req, res) => {
    const engagements = db.prepare(`
      SELECT e.id, e.name, e.status, e.scope_mode, e.period_start, e.period_end,
        e.target_completion_date, e.catalog_version, e.current_version, e.created_at,
        u.name AS lead_name,
        (SELECT COUNT(*) FROM csf_engagement_assignments a WHERE a.engagement_id=e.id) AS assignment_count
      FROM csf_engagements e
      LEFT JOIN users u ON u.id = e.assigned_lead_id
      WHERE e.workspace_id=? AND e.deleted_at IS NULL
      ORDER BY e.created_at DESC
    `).all(req.workspace.id);
    const canCreate = csfPolicy.canCreateEngagement(req.user, req.workspace);
    res.render('csf_engagements', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagements, canCreate,
    });
  });

  // New engagement form
  app.get('/workspaces/:wsId/csf/new', requireAuth, requireWorkspace, (req, res) => {
    if (!csfPolicy.canCreateEngagement(req.user, req.workspace)) {
      return res.status(403).render('error', { user: req.user, message: 'You do not have permission to create CSF engagements in this workspace.' });
    }
    // Assignable users = workspace members + firm operators (same pool used by tasks)
    const assignableUsers = db.prepare(`
      SELECT u.id, u.name FROM users u
      INNER JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = ?
      UNION
      SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1
    `).all(req.workspace.id, req.workspace.firm_id);
    res.render('csf_engagement_new', {
      user: req.user, ws: req.workspace, active: 'csf',
      assignableUsers,
    });
  });

  // Create engagement (seeds a default weighting profile with weight=1.0 on every subcategory)
  app.post('/workspaces/:wsId/csf', requireAuth, requireWorkspace, (req, res) => {
    if (!csfPolicy.canCreateEngagement(req.user, req.workspace)) return res.status(403).send('Forbidden');
    const b = req.body;
    if (!b.name || !b.name.trim()) return redirectBack(req, res, 'Engagement name is required', 'error');
    const catalogVersion = '2.0';
    const scopeMode = b.scope_mode === 'CURRENT_TARGET' ? 'CURRENT_TARGET' : 'CURRENT_ONLY';
    const leadId = b.assigned_lead_id ? parseInt(b.assigned_lead_id, 10) : null;

    const create = db.transaction(() => {
      const engId = db.prepare(`
        INSERT INTO csf_engagements (workspace_id, catalog_version, name, period_start, period_end,
          target_completion_date, scope_mode, status, assigned_lead_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)
      `).run(
        req.workspace.id, catalogVersion, b.name.trim(),
        b.period_start || null, b.period_end || null,
        b.target_completion_date || null,
        scopeMode, leadId, req.user.id,
      ).lastInsertRowid;

      // Seed default weighting profile: all 106 subcategories at weight 1.0
      const profileId = db.prepare(`
        INSERT INTO csf_weighting_profiles (engagement_id, workspace_id, name, is_default)
        VALUES (?, ?, 'Default (equal weighting)', 1)
      `).run(engId, req.workspace.id).lastInsertRowid;
      const subs = db.prepare(`SELECT id FROM csf_subcategories WHERE catalog_version=?`).all(catalogVersion);
      const insWPI = db.prepare(`INSERT INTO csf_weighting_profile_items (profile_id, subcategory_id, weight) VALUES (?, ?, 1.0)`);
      subs.forEach(s => insWPI.run(profileId, s.id));

      db.prepare(`UPDATE csf_engagements SET weighting_profile_id=? WHERE id=?`).run(profileId, engId);

      // Auto-assign the Lead (if specified) and the creator (as Lead too if no other Lead chosen)
      const insAssign = db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments (engagement_id, user_id, role_on_engagement, assigned_by) VALUES (?, ?, 'ENGAGEMENT_LEAD', ?)`);
      if (leadId) insAssign.run(engId, leadId, req.user.id);
      insAssign.run(engId, req.user.id, req.user.id);

      return engId;
    });
    const engId = create();
    logAction(req.user.id, req.workspace.id, 'csf_engagement_create', 'csf_engagement', engId, { name: b.name }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engId}`, 'CSF engagement created'));
  });

  // Catalog browser (moved from /csf to /csf/catalog)
  app.get('/workspaces/:wsId/csf/catalog', requireAuth, requireWorkspace, (req, res) => {
    const catalogVersion = '2.0';
    const fns = db.prepare(`SELECT id, code, name, description, display_order FROM csf_functions WHERE catalog_version=? ORDER BY display_order`).all(catalogVersion);
    const cats = db.prepare(`SELECT id, function_id, code, name, description, display_order FROM csf_categories WHERE catalog_version=? ORDER BY display_order`).all(catalogVersion);
    const subs = db.prepare(`SELECT id, category_id, code, description, implementation_examples, display_order FROM csf_subcategories WHERE catalog_version=? ORDER BY display_order`).all(catalogVersion);
    const isoRefs = db.prepare(`SELECT subcategory_id, ref_type, ref_value FROM csf_subcategory_iso_refs`).all();

    const catsByFn = {};
    cats.forEach(c => { (catsByFn[c.function_id] = catsByFn[c.function_id] || []).push(c); });
    const subsByCat = {};
    subs.forEach(s => { (subsByCat[s.category_id] = subsByCat[s.category_id] || []).push(s); });
    const refsBySub = {};
    isoRefs.forEach(r => { (refsBySub[r.subcategory_id] = refsBySub[r.subcategory_id] || []).push(r); });

    const tree = fns.map(f => ({
      ...f,
      categories: (catsByFn[f.id] || []).map(c => ({
        ...c,
        subcategories: (subsByCat[c.id] || []).map(s => ({ ...s, iso_refs: refsBySub[s.id] || [] }))
      }))
    }));

    res.render('csf_catalog', {
      user: req.user, ws: req.workspace, active: 'csf-catalog',
      catalogVersion, tree, totalFns: fns.length, totalCats: cats.length, totalSubs: subs.length,
    });
  });

  // Engagement detail (Stage 6: consultant dashboard surface)
  app.get('/workspaces/:wsId/csf/:id(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!engagement) return res.status(404).render('error', { user: req.user, message: 'CSF engagement not found, or it was deleted.' });
    if (!csfPolicy.canViewEngagement(db, req.user, engagement)) {
      return res.status(403).render('error', { user: req.user, message: 'You are not assigned to this CSF engagement.' });
    }
    const assignments = db.prepare(`
      SELECT a.id, a.role_on_engagement, a.assigned_at, u.id AS user_id, u.name AS user_name, u.email
      FROM csf_engagement_assignments a
      INNER JOIN users u ON u.id = a.user_id
      WHERE a.engagement_id = ? ORDER BY a.assigned_at
    `).all(engagement.id);
    const lead = engagement.assigned_lead_id ? db.prepare('SELECT id, name FROM users WHERE id=?').get(engagement.assigned_lead_id) : null;
    const assignableUsers = db.prepare(`
      SELECT u.id, u.name FROM users u
      INNER JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = ?
      UNION
      SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1
    `).all(req.workspace.id, req.workspace.firm_id);

    // ---- Stage 6 dashboard data ----
    csfPolicy.ensureAssessmentRows(db, engagement);
    // Status counts
    const statusCounts = db.prepare(`
      SELECT status, COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=? GROUP BY status
    `).all(engagement.id).reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});
    const totalSubs = db.prepare(`SELECT COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=?`).get(engagement.id).c;
    const inscopeSubs = db.prepare(`SELECT COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=? AND excluded_from_scope=0`).get(engagement.id).c;
    const scoredSubs = db.prepare(`SELECT COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=? AND excluded_from_scope=0 AND current_score IS NOT NULL`).get(engagement.id).c;
    const scoredPct = inscopeSubs === 0 ? 0 : Math.round((scoredSubs / inscopeSubs) * 100);

    // Score distribution
    const distRows = db.prepare(`
      SELECT current_score AS s, COUNT(*) AS c FROM csf_subcategory_assessments
      WHERE engagement_id=? AND excluded_from_scope=0 AND current_score IS NOT NULL
      GROUP BY current_score ORDER BY current_score
    `).all(engagement.id);
    const distribution = [1, 2, 3, 4, 5].map(s => ({ score: s, count: distRows.find(r => r.s === s)?.c || 0 }));

    // Days remaining (decision #16)
    let daysRemaining = null, daysOverdue = false;
    if (engagement.target_completion_date) {
      const ms = new Date(engagement.target_completion_date).getTime() - Date.now();
      daysRemaining = Math.ceil(ms / (1000 * 60 * 60 * 24));
      daysOverdue = daysRemaining < 0;
    }

    // Outstanding items
    const subsWithScoreNoEvidence = db.prepare(`
      SELECT a.id, a.subcategory_id, s.code AS sub_code
      FROM csf_subcategory_assessments a
      INNER JOIN csf_subcategories s ON s.id = a.subcategory_id
      WHERE a.engagement_id=? AND a.excluded_from_scope=0 AND a.current_score IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM csf_evidence_items e WHERE e.assessment_id=a.id AND e.deleted_at IS NULL)
      ORDER BY s.display_order LIMIT 30
    `).all(engagement.id);

    const unresolvedComments = db.prepare(`
      SELECT c.id, c.text, c.requires_revision, c.created_at, u.name AS commenter_name,
        a.subcategory_id, s.code AS sub_code, c.finding_id, f.title AS finding_title
      FROM csf_reviewer_comments c
      INNER JOIN users u ON u.id = c.commenter_id
      LEFT JOIN csf_subcategory_assessments a ON a.id = c.assessment_id
      LEFT JOIN csf_subcategories s ON s.id = a.subcategory_id
      LEFT JOIN csf_findings f ON f.id = c.finding_id
      WHERE c.engagement_id=? AND c.resolved=0 AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC LIMIT 20
    `).all(engagement.id);

    const findingsNoRecs = db.prepare(`
      SELECT f.id, f.title, f.severity,
        s.code AS sub_code, s.id AS subcategory_id
      FROM csf_findings f
      LEFT JOIN csf_subcategory_assessments a ON a.id = f.assessment_id
      LEFT JOIN csf_subcategories s ON s.id = a.subcategory_id
      WHERE f.engagement_id=? AND f.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM csf_recommendations r WHERE r.finding_id=f.id AND r.deleted_at IS NULL)
      ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
      LIMIT 20
    `).all(engagement.id);

    // Activity feed - recent csf_* audit log entries for this engagement
    const activity = db.prepare(`
      SELECT a.action, a.entity_type, a.entity_id, a.created_at, a.details, u.name AS actor
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = ? AND a.action LIKE 'csf_%'
      ORDER BY a.created_at DESC LIMIT 30
    `).all(req.workspace.id);

    // Engagement-level state transition controls
    const nextEngState = csfPolicy.nextEngagementState(engagement.status);
    const canTransitionEng = nextEngState ? csfPolicy.canTransitionEngagement(db, req.user, engagement, nextEngState) : false;
    const canPublishNow = engagement.status === 'Approved' && csfPolicy.canPublish(db, req.user, engagement);

    // Stage 11/12: unread inbox count for current user (badge on Inbox button)
    const inboxUnread = db.prepare(`
      SELECT COUNT(*) AS c FROM csf_ask_lead_messages
      WHERE engagement_id=? AND recipient_id=? AND read_at IS NULL AND deleted_at IS NULL
    `).get(engagement.id, req.user.id).c;
    // Unresolved-comment count for badge on the Findings button.
    const unresolvedCommentCount = db.prepare(`
      SELECT COUNT(*) AS c FROM csf_reviewer_comments
      WHERE engagement_id=? AND resolved=0 AND deleted_at IS NULL
    `).get(engagement.id).c;

    res.render('csf_engagement_detail', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, lead, assignments, assignableUsers,
      canAssign: csfPolicy.canAssignMembers(db, req.user, engagement),
      canEdit: csfPolicy.canEditEngagementMeta(db, req.user, engagement),
      engagementRoles: csfPolicy.ENGAGEMENT_ROLES,
      // dashboard data
      statusCounts, totalSubs, inscopeSubs, scoredSubs, scoredPct,
      distribution, daysRemaining, daysOverdue,
      subsWithScoreNoEvidence, unresolvedComments, findingsNoRecs,
      activity,
      // state transition
      nextEngState, canTransitionEng, canPublishNow,
      // Stage 11/12
      inboxUnread, unresolvedCommentCount,
    });
  });

  // Assign a member to an engagement
  app.post('/workspaces/:wsId/csf/:id(\\d+)/assign', requireAuth, requireWorkspace, (req, res) => {
    const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!engagement) return res.status(404).send('Not found');
    if (!csfPolicy.canAssignMembers(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const userId = parseInt(req.body.user_id, 10);
    const role = req.body.role_on_engagement;
    if (!userId || !csfPolicy.ENGAGEMENT_ROLES.includes(role)) return redirectBack(req, res, 'Pick a user and a role', 'error');
    db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments (engagement_id, user_id, role_on_engagement, assigned_by) VALUES (?, ?, ?, ?)`)
      .run(engagement.id, userId, role, req.user.id);
    logAction(req.user.id, req.workspace.id, 'csf_assignment_add', 'csf_engagement', engagement.id, { user_id: userId, role }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}`, 'Assignment added'));
  });

  // Engagement-level state transition (Draft -> In Progress -> Under Review -> Approved).
  // Approved -> Published goes through the publish route, not here.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/transition', requireAuth, requireWorkspace, (req, res) => {
    const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!engagement) return res.status(404).send('Not found');
    const to = req.body.to_state;
    if (!csfPolicy.canTransitionEngagement(db, req.user, engagement, to)) {
      return res.status(403).send('Forbidden: only the Engagement Lead can advance the engagement, and the transition must be the next step forward.');
    }
    db.prepare(`UPDATE csf_engagements SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(to, engagement.id);
    logAction(req.user.id, req.workspace.id, 'csf_engagement_transition', 'csf_engagement', engagement.id, { from: engagement.status, to }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}`, `Engagement moved to ${to}`));
  });

  // Unassign
  app.post('/workspaces/:wsId/csf/:id(\\d+)/unassign/:aid(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!engagement) return res.status(404).send('Not found');
    if (!csfPolicy.canAssignMembers(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const assign = db.prepare(`SELECT * FROM csf_engagement_assignments WHERE id=? AND engagement_id=?`).get(req.params.aid, engagement.id);
    if (assign) {
      db.prepare(`DELETE FROM csf_engagement_assignments WHERE id=?`).run(assign.id);
      logAction(req.user.id, req.workspace.id, 'csf_assignment_remove', 'csf_engagement', engagement.id, { user_id: assign.user_id, role: assign.role_on_engagement }, auditCtx(req));
    }
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}`);
  });

  // ---- Stage 3: Subcategory assessment lifecycle ------------------------------

  // Helper used by every assess route: load the engagement and confirm view perm.
  function loadCsfEngagement(req) {
    const eng = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!eng) return { error: { status: 404, message: 'CSF engagement not found, or it was deleted.' } };
    if (!csfPolicy.canViewEngagement(db, req.user, eng)) return { error: { status: 403, message: 'You are not assigned to this CSF engagement.' } };
    return { engagement: eng };
  }

  // Assessment list - all 106 (or filtered) for an engagement.
  app.get('/workspaces/:wsId/csf/:id(\\d+)/assess', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    csfPolicy.ensureAssessmentRows(db, engagement);  // lazy seed on first visit

    const fnFilter = req.query.fn || '';
    const statusFilter = req.query.status || '';
    const params = [engagement.id, engagement.catalog_version];
    let where = `a.engagement_id=? AND s.catalog_version=?`;
    if (fnFilter) { where += ` AND f.code=?`; params.push(fnFilter); }
    if (statusFilter) { where += ` AND a.status=?`; params.push(statusFilter); }

    const rows = db.prepare(`
      SELECT a.id AS assessment_id, a.status, a.current_score, a.target_score,
        a.excluded_from_scope, a.is_bulk_set, a.last_edited_at,
        s.id AS subcategory_id, s.code AS sub_code, s.description AS sub_description, s.display_order AS sub_order,
        c.code AS cat_code, c.name AS cat_name, c.display_order AS cat_order,
        f.code AS fn_code, f.name AS fn_name, f.display_order AS fn_order,
        (SELECT COUNT(*) FROM csf_evidence_items e WHERE e.assessment_id=a.id AND e.deleted_at IS NULL) AS evidence_count
      FROM csf_subcategory_assessments a
      INNER JOIN csf_subcategories s ON s.id = a.subcategory_id
      INNER JOIN csf_categories c ON c.id = s.category_id
      INNER JOIN csf_functions f ON f.id = c.function_id
      WHERE ${where}
      ORDER BY f.display_order, c.display_order, s.display_order
    `).all(...params);

    // Stats for the header (ignore filter when computing totals so the user sees
    // overall progress; filter only shapes the table).
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='Not Started' THEN 1 ELSE 0 END) AS not_started,
        SUM(CASE WHEN status='In Progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status='Evidence Collected' THEN 1 ELSE 0 END) AS evidence_collected,
        SUM(CASE WHEN status='Draft Complete' THEN 1 ELSE 0 END) AS draft_complete,
        SUM(CASE WHEN status='Reviewed' THEN 1 ELSE 0 END) AS reviewed,
        SUM(CASE WHEN status='Approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN current_score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
        SUM(CASE WHEN excluded_from_scope=1 THEN 1 ELSE 0 END) AS excluded
      FROM csf_subcategory_assessments WHERE engagement_id=?
    `).get(engagement.id);

    const fns = db.prepare(`SELECT code, name FROM csf_functions WHERE catalog_version=? ORDER BY display_order`).all(engagement.catalog_version);

    res.render('csf_assess', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, rows, stats, fns,
      fnFilter, statusFilter,
      states: csfPolicy.SUBCATEGORY_STATES,
      canBulkScore: csfPolicy.canScoreSubcategory(db, req.user, engagement),
      canBulkTransition: csfPolicy.canCollectEvidence(db, req.user, engagement),
    });
  });

  // Bulk action - apply same status transition or same score to many subcategories.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/bulk', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const action = req.body.action;
    const ids = Array.isArray(req.body.assessment_id) ? req.body.assessment_id : (req.body.assessment_id ? [req.body.assessment_id] : []);
    if (!ids.length) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`);

    let appliedTo = 0;
    if (action === 'set_score') {
      if (!csfPolicy.canScoreSubcategory(db, req.user, engagement)) return res.status(403).send('Forbidden');
      const score = parseInt(req.body.bulk_score, 10);
      if (!(score >= 1 && score <= 5)) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`);
      const upd = db.prepare(`UPDATE csf_subcategory_assessments
        SET current_score=?, is_bulk_set=1, scored_by=?, scored_at=CURRENT_TIMESTAMP,
            last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP
        WHERE id=? AND engagement_id=?
          AND status IN ('Evidence Collected','Draft Complete','Reviewed')`);
      const tx = db.transaction(() => { ids.forEach(id => { appliedTo += upd.run(score, req.user.id, req.user.id, id, engagement.id).changes; }); });
      tx();
      logAction(req.user.id, req.workspace.id, 'csf_bulk_score', 'csf_engagement', engagement.id, { count: appliedTo, score }, auditCtx(req));
    } else if (action === 'transition') {
      const to = req.body.to_state;
      if (!csfPolicy.SUBCATEGORY_STATES.includes(to)) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`);
      // Check permission generally; per-row transition validity is enforced inside the loop.
      const tx = db.transaction(() => {
        ids.forEach(id => {
          const a = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE id=? AND engagement_id=?`).get(id, engagement.id);
          if (!a) return;
          if (!csfPolicy.canTransitionTo(db, req.user, engagement, a, to)) return;
          db.prepare(`UPDATE csf_subcategory_assessments SET status=?, last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(to, req.user.id, id);
          appliedTo++;
        });
      });
      tx();
      logAction(req.user.id, req.workspace.id, 'csf_bulk_transition', 'csf_engagement', engagement.id, { count: appliedTo, to_state: to }, auditCtx(req));
    }
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`, `${appliedTo} subcategor${appliedTo === 1 ? 'y' : 'ies'} updated`));
  });

  // Subcategory detail (work surface for evidence + narrative + score).
  app.get('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    csfPolicy.ensureAssessmentRows(db, engagement);

    const detail = db.prepare(`
      SELECT a.*, s.code AS sub_code, s.description AS sub_description, s.implementation_examples,
        c.code AS cat_code, c.name AS cat_name, c.description AS cat_description,
        f.code AS fn_code, f.name AS fn_name
      FROM csf_subcategory_assessments a
      INNER JOIN csf_subcategories s ON s.id = a.subcategory_id
      INNER JOIN csf_categories c ON c.id = s.category_id
      INNER JOIN csf_functions f ON f.id = c.function_id
      WHERE a.engagement_id=? AND a.subcategory_id=?
    `).get(engagement.id, req.params.subId);
    if (!detail) return res.status(404).render('error', { user: req.user, message: 'Subcategory not found in this engagement.' });

    const evidence = db.prepare(`SELECT * FROM csf_evidence_items WHERE assessment_id=? AND deleted_at IS NULL ORDER BY uploaded_at DESC`).all(detail.id);
    const isoRefs = db.prepare(`SELECT ref_type, ref_value FROM csf_subcategory_iso_refs WHERE subcategory_id=?`).all(detail.subcategory_id);

    // Adjacent navigation for the workflow ("Next" button after saving)
    const adj = db.prepare(`
      SELECT a.subcategory_id, s.code, s.display_order, c.display_order AS c_order, f.display_order AS f_order
      FROM csf_subcategory_assessments a
      INNER JOIN csf_subcategories s ON s.id=a.subcategory_id
      INNER JOIN csf_categories c ON c.id=s.category_id
      INNER JOIN csf_functions f ON f.id=c.function_id
      WHERE a.engagement_id=?
      ORDER BY f.display_order, c.display_order, s.display_order
    `).all(engagement.id);
    const curIdx = adj.findIndex(r => r.subcategory_id === parseInt(req.params.subId, 10));
    const prev = curIdx > 0 ? adj[curIdx - 1] : null;
    const next = curIdx >= 0 && curIdx < adj.length - 1 ? adj[curIdx + 1] : null;

    const next_state_opts = csfPolicy.nextStateOptions(detail.status);
    const allowedNextStates = next_state_opts.filter(s => csfPolicy.canTransitionTo(db, req.user, engagement, detail, s));
    const warnings = csfPolicy.thinnessWarnings(detail, evidence.length);

    // Stage 4: findings on this subcategory + reviewer comments on this assessment
    const findings = db.prepare(`
      SELECT f.*, u.name AS creator,
        (SELECT COUNT(*) FROM csf_recommendations r WHERE r.finding_id=f.id AND r.deleted_at IS NULL) AS rec_count
      FROM csf_findings f
      LEFT JOIN users u ON u.id = f.created_by
      WHERE f.engagement_id=? AND f.assessment_id=? AND f.deleted_at IS NULL
      ORDER BY
        CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
        f.created_at DESC
    `).all(engagement.id, detail.id);
    const findingIds = findings.map(f => f.id);
    const recsByFinding = {};
    if (findingIds.length) {
      const placeholders = findingIds.map(() => '?').join(',');
      const recs = db.prepare(`SELECT * FROM csf_recommendations WHERE finding_id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at`).all(...findingIds);
      recs.forEach(r => { (recsByFinding[r.finding_id] = recsByFinding[r.finding_id] || []).push(r); });
    }
    const comments = db.prepare(`
      SELECT c.*, u.name AS commenter_name
      FROM csf_reviewer_comments c
      INNER JOIN users u ON u.id = c.commenter_id
      WHERE c.engagement_id=? AND c.assessment_id=? AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC
    `).all(engagement.id, detail.id);

    // ---- Stage 11: Analyst content for this subcategory ----
    const explainer = db.prepare(`SELECT * FROM csf_subcategory_explainers WHERE subcategory_id=?`).get(detail.subcategory_id);
    const questions = db.prepare(`SELECT * FROM csf_subcategory_questions WHERE subcategory_id=? ORDER BY display_order`).all(detail.subcategory_id);
    const prompts = db.prepare(`SELECT * FROM csf_subcategory_evidence_prompts WHERE subcategory_id=? ORDER BY display_order`).all(detail.subcategory_id);
    const selfCheckPrompts = db.prepare(`SELECT prompt FROM csf_self_check_prompts ORDER BY display_order`).all().map(r => r.prompt);
    const narrativeSections = csfPolicy.parseStructuredNarrative(detail.narrative);

    res.render('csf_assess_detail', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, detail, evidence, isoRefs,
      prev, next,
      allowedNextStates,
      warnings,
      findings, recsByFinding, comments,
      canEnterScore: csfPolicy.canEnterScore(db, req.user, engagement, detail),
      canCollect: csfPolicy.canCollectEvidence(db, req.user, engagement),
      canCreateFinding: csfPolicy.canCreateFinding(db, req.user, engagement),
      canManageRecs: csfPolicy.canManageRecommendations(db, req.user, engagement),
      canPostComment: csfPolicy.canPostReviewerComment(db, req.user, engagement),
      severities: csfPolicy.FINDING_SEVERITIES,
      efforts: csfPolicy.RECOMMENDATION_EFFORTS,
      priorities: csfPolicy.RECOMMENDATION_PRIORITIES,
      phases: csfPolicy.ROADMAP_PHASES,
      // Stage 11
      explainer, questions, prompts, selfCheckPrompts, narrativeSections,
      narrativeSectionDefs: csfPolicy.NARRATIVE_SECTIONS,
    });
  });

  // Update narrative / scores / exclusion. Score updates are gated by state.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
    if (!assess) return res.status(404).send('Not found');
    if (!csfPolicy.canCollectEvidence(db, req.user, engagement)) return res.status(403).send('Forbidden');

    const b = req.body;
    const sets = []; const vals = [];

    // Structured narrative (Stage 11): 4 sub-fields combine into the single
    // narrative TEXT column. Falls back to b.narrative for legacy callers.
    const hasStructured = ['narrative_practice_observed', 'narrative_evidence_reviewed', 'narrative_gaps_or_concerns', 'narrative_follow_up_needed']
      .some(k => b[k] !== undefined);
    if (hasStructured) {
      const combined = csfPolicy.buildStructuredNarrative({
        practice_observed: b.narrative_practice_observed || '',
        evidence_reviewed: b.narrative_evidence_reviewed || '',
        gaps_or_concerns: b.narrative_gaps_or_concerns || '',
        follow_up_needed: b.narrative_follow_up_needed || '',
      });
      sets.push('narrative=?', 'narrative_drafted_by=?', 'narrative_drafted_at=CURRENT_TIMESTAMP');
      vals.push(combined, req.user.id);
    } else if (b.narrative !== undefined) {
      sets.push('narrative=?', 'narrative_drafted_by=?', 'narrative_drafted_at=CURRENT_TIMESTAMP');
      vals.push(b.narrative.trim(), req.user.id);
    }
    if (b.excluded_from_scope !== undefined) {
      const excluded = b.excluded_from_scope === '1' || b.excluded_from_scope === 'on' ? 1 : 0;
      sets.push('excluded_from_scope=?');
      vals.push(excluded);
      if (excluded) { sets.push('exclusion_rationale=?'); vals.push((b.exclusion_rationale || '').trim() || null); }
      else { sets.push('exclusion_rationale=NULL'); }
    }
    // Score updates: gated. Allow null to clear; allow 1-5; reject everything else.
    if (b.current_score !== undefined) {
      if (!csfPolicy.canEnterScore(db, req.user, engagement, assess)) return res.status(403).send('Cannot enter score: requires Consultant/Lead role and Evidence Collected state.');
      const v = b.current_score === '' ? null : parseInt(b.current_score, 10);
      if (v !== null && !(v >= 1 && v <= 5)) return res.status(400).send('current_score must be 1-5 or empty');
      sets.push('current_score=?', 'scored_by=?', 'scored_at=CURRENT_TIMESTAMP', 'is_bulk_set=0');
      vals.push(v, req.user.id);
    }
    if (b.target_score !== undefined && engagement.scope_mode === 'CURRENT_TARGET') {
      if (!csfPolicy.canEnterScore(db, req.user, engagement, assess)) return res.status(403).send('Cannot enter score: requires Consultant/Lead role and Evidence Collected state.');
      const v = b.target_score === '' ? null : parseInt(b.target_score, 10);
      if (v !== null && !(v >= 1 && v <= 5)) return res.status(400).send('target_score must be 1-5 or empty');
      sets.push('target_score=?');
      vals.push(v);
    }

    if (sets.length) {
      sets.push('last_edited_by=?', 'last_edited_at=CURRENT_TIMESTAMP');
      vals.push(req.user.id);
      vals.push(assess.id);
      db.prepare(`UPDATE csf_subcategory_assessments SET ${sets.join(', ')} WHERE id=?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'csf_assessment_update', 'csf_subcategory_assessment', assess.id, Object.keys(b).filter(k => k !== '_csrf'), auditCtx(req));
    }
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
  });

  // State transition.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)/transition', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
    if (!assess) return res.status(404).send('Not found');
    const to = req.body.to_state;
    if (!csfPolicy.canTransitionTo(db, req.user, engagement, assess, to)) return res.status(403).send('Transition not allowed.');

    // Stamp the right "by/at" fields so the audit trail in deliverables shows
    // who moved each subcategory through each gate.
    const sets = ['status=?', 'last_edited_by=?', 'last_edited_at=CURRENT_TIMESTAMP'];
    const vals = [to, req.user.id];
    if (to === 'Evidence Collected') { sets.push('evidence_collected_by=?', 'evidence_collected_at=CURRENT_TIMESTAMP'); vals.push(req.user.id); }
    if (to === 'Reviewed') { sets.push('reviewed_by=?', 'reviewed_at=CURRENT_TIMESTAMP'); vals.push(req.user.id); }
    vals.push(assess.id);
    db.prepare(`UPDATE csf_subcategory_assessments SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'csf_assessment_transition', 'csf_subcategory_assessment', assess.id, { from: assess.status, to }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
  });

  // Add evidence (FILE | LINK | INTERVIEW). Multer mounts per-route so multipart
  // parsing only happens for this endpoint; CSRF token must be appended to the
  // URL for multipart bodies (see lib/csrf.js comment).
  app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)/evidence', requireAuth, requireWorkspace, upload.single('file'), (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
    if (!assess) return res.status(404).send('Not found');
    if (!csfPolicy.canCollectEvidence(db, req.user, engagement)) return res.status(403).send('Forbidden');

    const type = (req.body.type || 'LINK').toUpperCase();
    if (!['FILE', 'LINK', 'INTERVIEW'].includes(type)) return res.status(400).send('type must be FILE | LINK | INTERVIEW');

    const filePath = type === 'FILE' && req.file ? req.file.filename : null;
    const url = type === 'LINK' ? (req.body.url || '').trim() || null : null;
    const interviewSource = type === 'INTERVIEW' ? (req.body.interview_source || '').trim() || null : null;
    const description = (req.body.description || '').trim() || null;
    const visibleToClient = req.body.visible_to_client === '1' || req.body.visible_to_client === 'on' ? 1 : 0;

    if (type === 'FILE' && !filePath) return res.status(400).send('FILE evidence requires a file upload');
    if (type === 'LINK' && !url) return res.status(400).send('LINK evidence requires a url');
    if (type === 'INTERVIEW' && !interviewSource) return res.status(400).send('INTERVIEW evidence requires the interview source attribution');

    const evId = db.prepare(`
      INSERT INTO csf_evidence_items (assessment_id, type, file_path, url, interview_source, description, visible_to_client, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assess.id, type, filePath, url, interviewSource, description, visibleToClient, req.user.id).lastInsertRowid;

    // Auto-advance Not Started → In Progress on first evidence (gentle nudge through the state machine).
    if (assess.status === 'Not Started') {
      db.prepare(`UPDATE csf_subcategory_assessments SET status='In Progress', last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, assess.id);
    }
    logAction(req.user.id, req.workspace.id, 'csf_evidence_add', 'csf_subcategory_assessment', assess.id, { evidence_id: evId, type }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
  });

  // Soft-delete evidence (decision #21).
  app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)/evidence/:evId(\\d+)/delete', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (!csfPolicy.canCollectEvidence(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
    if (!assess) return res.status(404).send('Not found');
    db.prepare(`UPDATE csf_evidence_items SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND assessment_id=?`).run(req.params.evId, assess.id);
    logAction(req.user.id, req.workspace.id, 'csf_evidence_delete', 'csf_evidence_item', req.params.evId, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
  });

  // ---- Stage 4: Findings, Recommendations, Reviewer comments ------------------

  // Engagement-level findings list (all findings across the engagement).
  app.get('/workspaces/:wsId/csf/:id(\\d+)/findings', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    const findings = db.prepare(`
      SELECT f.*, u.name AS creator,
        s.code AS sub_code, s.id AS subcategory_id,
        (SELECT COUNT(*) FROM csf_recommendations r WHERE r.finding_id=f.id AND r.deleted_at IS NULL) AS rec_count
      FROM csf_findings f
      LEFT JOIN users u ON u.id = f.created_by
      LEFT JOIN csf_subcategory_assessments a ON a.id = f.assessment_id
      LEFT JOIN csf_subcategories s ON s.id = a.subcategory_id
      WHERE f.engagement_id=? AND f.deleted_at IS NULL
      ORDER BY
        CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
        f.created_at DESC
    `).all(engagement.id);
    res.render('csf_findings', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, findings,
      severities: csfPolicy.FINDING_SEVERITIES,
      canCreate: csfPolicy.canCreateFinding(db, req.user, engagement),
    });
  });

  // Create a finding. assessment_id from body is optional (engagement-level
  // theme when omitted).
  app.post('/workspaces/:wsId/csf/:id(\\d+)/findings', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (!csfPolicy.canCreateFinding(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const b = req.body;
    if (!b.title || !b.title.trim()) return redirectBack(req, res, 'Title is required', 'error');
    const severity = csfPolicy.FINDING_SEVERITIES.includes(b.severity) ? b.severity : 'MEDIUM';
    const assessmentId = b.assessment_id ? parseInt(b.assessment_id, 10) : null;
    const promoted = b.promoted_to_engagement_theme === '1' || !assessmentId ? 1 : 0;
    const findingId = db.prepare(`
      INSERT INTO csf_findings (engagement_id, assessment_id, title, description, severity, status, promoted_to_engagement_theme, created_by)
      VALUES (?, ?, ?, ?, ?, 'Draft', ?, ?)
    `).run(engagement.id, assessmentId, b.title.trim(), (b.description || '').trim() || null, severity, promoted, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'csf_finding_create', 'csf_finding', findingId, { title: b.title, severity }, auditCtx(req));
    // Redirect back to where the user came from: subcategory detail if attached, else findings list.
    if (assessmentId) {
      const sub = db.prepare(`SELECT subcategory_id FROM csf_subcategory_assessments WHERE id=?`).get(assessmentId);
      if (sub) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${sub.subcategory_id}`);
    }
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // Update a finding (title / description / severity / status / promote).
  app.post('/workspaces/:wsId/csf/:id(\\d+)/findings/:findingId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const finding = db.prepare(`SELECT * FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.findingId, engagement.id);
    if (!finding) return res.status(404).send('Not found');
    if (!csfPolicy.canEditFinding(db, req.user, engagement, finding)) return res.status(403).send('Forbidden');
    const b = req.body;
    const sets = []; const vals = [];
    if (b.title !== undefined) { sets.push('title=?'); vals.push(b.title.trim()); }
    if (b.description !== undefined) { sets.push('description=?'); vals.push((b.description || '').trim() || null); }
    if (b.severity !== undefined && csfPolicy.FINDING_SEVERITIES.includes(b.severity)) { sets.push('severity=?'); vals.push(b.severity); }
    if (b.status !== undefined && csfPolicy.FINDING_STATUSES.includes(b.status)) { sets.push('status=?'); vals.push(b.status); }
    if (b.promoted_to_engagement_theme !== undefined) {
      const v = b.promoted_to_engagement_theme === '1' || b.promoted_to_engagement_theme === 'on' ? 1 : 0;
      sets.push('promoted_to_engagement_theme=?'); vals.push(v);
    }
    if (sets.length) {
      sets.push('updated_at=CURRENT_TIMESTAMP');
      vals.push(finding.id);
      db.prepare(`UPDATE csf_findings SET ${sets.join(', ')} WHERE id=?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'csf_finding_update', 'csf_finding', finding.id, Object.keys(b).filter(k => k !== '_csrf'), auditCtx(req));
    }
    res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // Soft-delete a finding.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/findings/:findingId(\\d+)/delete', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const finding = db.prepare(`SELECT * FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.findingId, engagement.id);
    if (!finding) return res.status(404).send('Not found');
    if (!csfPolicy.canDeleteFinding(db, req.user, engagement, finding)) return res.status(403).send('Forbidden');
    db.prepare(`UPDATE csf_findings SET deleted_at=CURRENT_TIMESTAMP WHERE id=?`).run(finding.id);
    logAction(req.user.id, req.workspace.id, 'csf_finding_delete', 'csf_finding', finding.id, null, auditCtx(req));
    res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // Add a recommendation to a finding.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/findings/:findingId(\\d+)/recommendations', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (!csfPolicy.canManageRecommendations(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const finding = db.prepare(`SELECT * FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.findingId, engagement.id);
    if (!finding) return res.status(404).send('Not found');
    const b = req.body;
    if (!b.description || !b.description.trim()) return redirectBack(req, res, 'Recommendation text is required', 'error');
    const effort = csfPolicy.RECOMMENDATION_EFFORTS.includes(b.estimated_effort) ? b.estimated_effort : null;
    const priority = csfPolicy.RECOMMENDATION_PRIORITIES.includes(b.priority) ? b.priority : null;
    const phase = csfPolicy.ROADMAP_PHASES.includes(b.roadmap_phase) ? b.roadmap_phase : null;
    const recId = db.prepare(`
      INSERT INTO csf_recommendations (finding_id, description, estimated_effort, priority, target_completion_date, roadmap_phase, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(finding.id, b.description.trim(), effort, priority, b.target_completion_date || null, phase, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'csf_recommendation_create', 'csf_recommendation', recId, { finding_id: finding.id }, auditCtx(req));
    res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // Update a recommendation.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/recommendations/:recId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (!csfPolicy.canManageRecommendations(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const rec = db.prepare(`
      SELECT r.* FROM csf_recommendations r
      INNER JOIN csf_findings f ON f.id = r.finding_id
      WHERE r.id=? AND f.engagement_id=? AND r.deleted_at IS NULL
    `).get(req.params.recId, engagement.id);
    if (!rec) return res.status(404).send('Not found');
    const b = req.body;
    const sets = []; const vals = [];
    if (b.description !== undefined) { sets.push('description=?'); vals.push(b.description.trim()); }
    if (b.estimated_effort !== undefined) { sets.push('estimated_effort=?'); vals.push(csfPolicy.RECOMMENDATION_EFFORTS.includes(b.estimated_effort) ? b.estimated_effort : null); }
    if (b.priority !== undefined) { sets.push('priority=?'); vals.push(csfPolicy.RECOMMENDATION_PRIORITIES.includes(b.priority) ? b.priority : null); }
    if (b.target_completion_date !== undefined) { sets.push('target_completion_date=?'); vals.push(b.target_completion_date || null); }
    if (b.roadmap_phase !== undefined) { sets.push('roadmap_phase=?'); vals.push(csfPolicy.ROADMAP_PHASES.includes(b.roadmap_phase) ? b.roadmap_phase : null); }
    if (sets.length) {
      vals.push(rec.id);
      db.prepare(`UPDATE csf_recommendations SET ${sets.join(', ')} WHERE id=?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'csf_recommendation_update', 'csf_recommendation', rec.id, Object.keys(b).filter(k => k !== '_csrf'), auditCtx(req));
    }
    res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // Soft-delete a recommendation.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/recommendations/:recId(\\d+)/delete', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (!csfPolicy.canManageRecommendations(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const rec = db.prepare(`
      SELECT r.* FROM csf_recommendations r
      INNER JOIN csf_findings f ON f.id = r.finding_id
      WHERE r.id=? AND f.engagement_id=? AND r.deleted_at IS NULL
    `).get(req.params.recId, engagement.id);
    if (!rec) return res.status(404).send('Not found');
    db.prepare(`UPDATE csf_recommendations SET deleted_at=CURRENT_TIMESTAMP WHERE id=?`).run(rec.id);
    logAction(req.user.id, req.workspace.id, 'csf_recommendation_delete', 'csf_recommendation', rec.id, null, auditCtx(req));
    res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // Post a reviewer comment. Body may target an assessment OR a finding.
  // requires_revision on an assessment in Reviewed state reopens it.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/comments', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (!csfPolicy.canPostReviewerComment(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const b = req.body;
    if (!b.text || !b.text.trim()) return redirectBack(req, res, 'Comment text is required', 'error');
    const assessmentId = b.assessment_id ? parseInt(b.assessment_id, 10) : null;
    const findingId = b.finding_id ? parseInt(b.finding_id, 10) : null;
    if (!assessmentId && !findingId) return res.status(400).send('Comment must target an assessment or a finding');
    const requiresRevision = b.requires_revision === '1' || b.requires_revision === 'on' ? 1 : 0;

    const tx = db.transaction(() => {
      const commentId = db.prepare(`
        INSERT INTO csf_reviewer_comments (engagement_id, assessment_id, finding_id, commenter_id, text, requires_revision)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(engagement.id, assessmentId, findingId, req.user.id, b.text.trim(), requiresRevision).lastInsertRowid;

      // Needs Revision: reopen the assessment if it had reached Reviewed.
      if (assessmentId) {
        const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE id=?`).get(assessmentId);
        if (csfPolicy.shouldReopenAssessment({ requires_revision: requiresRevision }, assess)) {
          db.prepare(`UPDATE csf_subcategory_assessments SET status='Draft Complete', last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, assessmentId);
          logAction(req.user.id, req.workspace.id, 'csf_assessment_reopen', 'csf_subcategory_assessment', assessmentId, { from: 'Reviewed', to: 'Draft Complete', reason: 'Needs Revision', comment_id: commentId }, auditCtx(req));
        }
      }
      return commentId;
    });
    const commentId = tx();
    logAction(req.user.id, req.workspace.id, 'csf_comment_create', 'csf_reviewer_comment', commentId, { assessment_id: assessmentId, finding_id: findingId, requires_revision: requiresRevision }, auditCtx(req));

    if (assessmentId) {
      const sub = db.prepare(`SELECT subcategory_id FROM csf_subcategory_assessments WHERE id=?`).get(assessmentId);
      if (sub) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${sub.subcategory_id}`);
    }
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // ---- Stage 5: Scoring rollup ------------------------------------------------
  const csfScoring = require('../lib/csf-scoring');

  app.get('/workspaces/:wsId/csf/:id(\\d+)/scores', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    csfPolicy.ensureAssessmentRows(db, engagement);
    const rollup = csfScoring.computeEngagementRollup(db, engagement);
    res.render('csf_scores', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, rollup,
      r1: csfScoring.r1,
    });
  });

  // ---- Stage 7: Versions + snapshots ------------------------------------------
  const csfVersioning = require('../lib/csf-versioning');

  // First publish: Approved -> Published, create v1.0 snapshot.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/publish', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (!csfPolicy.canPublish(db, req.user, engagement)) return res.status(403).send('Forbidden: only the Engagement Lead can publish an Approved engagement.');

    const versionNumber = csfVersioning.nextVersionNumber(db, engagement); // 1.0 on first call
    const versionId = csfVersioning.createSnapshot(db, engagement, versionNumber, req.user.id, (req.body.change_summary || '').trim() || 'Initial publish');
    db.prepare(`UPDATE csf_engagements SET status='Published', current_version=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(versionNumber, engagement.id);
    logAction(req.user.id, req.workspace.id, 'csf_engagement_publish', 'csf_engagement', engagement.id, { version_id: versionId, version_number: versionNumber }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}`, `Engagement published as v${versionNumber}`));
  });

  // Republish: engagement stays Published, increment version, require change_summary.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/republish', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    if (engagement.status !== 'Published') return res.status(400).send('Only Published engagements can be republished.');
    if (!csfPolicy.canPublish(db, req.user, engagement)) return res.status(403).send('Forbidden: only the Engagement Lead can republish.');
    const summary = (req.body.change_summary || '').trim();
    if (!summary) return redirectBack(req, res, 'Change summary is required for a republish', 'error');

    const versionNumber = csfVersioning.nextVersionNumber(db, engagement);
    const versionId = csfVersioning.createSnapshot(db, engagement, versionNumber, req.user.id, summary);
    db.prepare(`UPDATE csf_engagements SET current_version=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(versionNumber, engagement.id);
    logAction(req.user.id, req.workspace.id, 'csf_engagement_republish', 'csf_engagement', engagement.id, { version_id: versionId, version_number: versionNumber }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}/versions/${versionId}`, `Republished as v${versionNumber}`));
  });

  // Versions list.
  app.get('/workspaces/:wsId/csf/:id(\\d+)/versions', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    const versions = db.prepare(`
      SELECT v.*, u.name AS publisher_name,
        (SELECT COUNT(*) FROM csf_subcategory_assessment_snapshots s WHERE s.version_id=v.id) AS sub_count,
        (SELECT COUNT(*) FROM csf_finding_snapshots fs WHERE fs.version_id=v.id) AS finding_count
      FROM csf_engagement_versions v
      LEFT JOIN users u ON u.id = v.published_by
      WHERE v.engagement_id=? ORDER BY v.published_at DESC
    `).all(engagement.id);
    res.render('csf_versions', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, versions,
      canPublish: csfPolicy.canPublish(db, req.user, engagement),
      canRepublish: engagement.status === 'Published' && csfPolicy.canPublish(db, req.user, { ...engagement, status: 'Approved' }),  // policy.canPublish requires status=Approved; for republish we override
    });
  });

  // Version detail - snapshot view.
  app.get('/workspaces/:wsId/csf/:id(\\d+)/versions/:vid(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    const version = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.params.vid, engagement.id);
    if (!version) return res.status(404).render('error', { user: req.user, message: 'Version not found in this engagement.' });
    const rollup = csfVersioning.loadSnapshotRollup(db, version);
    const findingSnaps = db.prepare(`
      SELECT fs.*, s.code AS sub_code
      FROM csf_finding_snapshots fs
      LEFT JOIN csf_subcategories s ON s.id = fs.subcategory_id
      WHERE fs.version_id=?
      ORDER BY CASE fs.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
    `).all(version.id);
    const otherVersions = db.prepare(`SELECT id, version_number FROM csf_engagement_versions WHERE engagement_id=? AND id != ? ORDER BY published_at DESC`).all(engagement.id, version.id);
    res.render('csf_version_detail', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, version, rollup, findingSnaps, otherVersions,
      r1: csfScoring.r1,
    });
  });

  // ---- Stage 11: Ask my Lead + Learn section ----------------------------------
  // Reuse the existing top-level MarkdownIt import (line 12) for rendering
  // Learn docs.
  const csfLearnMd = new MarkdownIt({ html: false, linkify: true, breaks: false });

  // Ask my Lead - send a question.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/ask-lead', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const body = (req.body.body || '').trim();
    if (!body) return redirectBack(req, res, 'Message body required', 'error');
    const subject = (req.body.subject || '').trim() || null;
    const subId = req.body.subcategory_id ? parseInt(req.body.subcategory_id, 10) : null;
    const recipient = engagement.assigned_lead_id;
    const msgId = db.prepare(`
      INSERT INTO csf_ask_lead_messages (engagement_id, sender_id, recipient_id, subcategory_id, subject, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(engagement.id, req.user.id, recipient, subId, subject, body).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'csf_ask_lead_send', 'csf_ask_lead_message', msgId, { recipient }, auditCtx(req));
    const back = req.body.return_to || (subId
      ? `/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${subId}`
      : `/workspaces/${req.workspace.id}/csf/${engagement.id}`);
    res.redirect(withToast(back, 'Message sent to Lead'));
  });

  // Inbox view - all ask-lead messages for this engagement.
  app.get('/workspaces/:wsId/csf/:id(\\d+)/ask-lead', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    const messages = db.prepare(`
      SELECT m.*, sender.name AS sender_name, recipient.name AS recipient_name,
        s.code AS sub_code
      FROM csf_ask_lead_messages m
      INNER JOIN users sender ON sender.id = m.sender_id
      LEFT JOIN users recipient ON recipient.id = m.recipient_id
      LEFT JOIN csf_subcategories s ON s.id = m.subcategory_id
      WHERE m.engagement_id=? AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
    `).all(engagement.id);
    // Mark messages addressed to current user as read.
    db.prepare(`UPDATE csf_ask_lead_messages SET read_at=CURRENT_TIMESTAMP WHERE engagement_id=? AND recipient_id=? AND read_at IS NULL`).run(engagement.id, req.user.id);
    res.render('csf_ask_lead', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, messages,
    });
  });

  // Reply to an ask-lead message.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/ask-lead/:msgId(\\d+)/reply', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const original = db.prepare(`SELECT * FROM csf_ask_lead_messages WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.msgId, engagement.id);
    if (!original) return res.status(404).send('Message not found');
    const body = (req.body.body || '').trim();
    if (!body) return redirectBack(req, res, 'Reply body required', 'error');
    const tx = db.transaction(() => {
      const replyId = db.prepare(`
        INSERT INTO csf_ask_lead_messages (engagement_id, sender_id, recipient_id, subcategory_id, in_reply_to, subject, body)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(engagement.id, req.user.id, original.sender_id, original.subcategory_id, original.id, original.subject ? `Re: ${original.subject}` : null, body).lastInsertRowid;
      db.prepare(`UPDATE csf_ask_lead_messages SET replied_at=CURRENT_TIMESTAMP WHERE id=?`).run(original.id);
      return replyId;
    });
    const replyId = tx();
    logAction(req.user.id, req.workspace.id, 'csf_ask_lead_reply', 'csf_ask_lead_message', replyId, { in_reply_to: original.id }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/ask-lead`);
  });

  // Learn section - workspace-scoped index + reader.
  app.get('/workspaces/:wsId/csf/learn', requireAuth, requireWorkspace, (req, res) => {
    const docs = db.prepare(`SELECT id, slug, title, summary FROM csf_learn_docs ORDER BY display_order, title`).all();
    res.render('csf_learn', { user: req.user, ws: req.workspace, active: 'csf-learn', docs });
  });

  app.get('/workspaces/:wsId/csf/learn/:slug', requireAuth, requireWorkspace, (req, res) => {
    const doc = db.prepare(`SELECT * FROM csf_learn_docs WHERE slug=?`).get(req.params.slug);
    if (!doc) return res.status(404).render('error', { user: req.user, message: 'Learn document not found.' });
    const otherDocs = db.prepare(`SELECT slug, title FROM csf_learn_docs WHERE slug != ? ORDER BY display_order`).all(req.params.slug);
    res.render('csf_learn_doc', {
      user: req.user, ws: req.workspace, active: 'csf-learn',
      doc, otherDocs, html: csfLearnMd.render(doc.body_markdown || ''),
    });
  });

  // ---- Stage 9: Client portal -------------------------------------------------
  // Read-mostly view of a Published engagement. In prototype mode (auth deferred)
  // anyone with workspace access can hit this; real client-user auth comes in
  // Stage 13. The portal shows the current Published version's data plus the
  // live remediation tracker (decision #34: snapshot-at-publish except for
  // remediation, which stays live).

  const REMEDIATION_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED'];

  app.get('/workspaces/:wsId/csf/:id(\\d+)/portal', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });

    // Pick the current published version. If never published, show the empty
    // state - the portal is a published-data surface by design.
    const currentVersion = db.prepare(`
      SELECT * FROM csf_engagement_versions WHERE engagement_id=? AND is_current=1 LIMIT 1
    `).get(engagement.id);

    if (!currentVersion) {
      return res.render('csf_portal', {
        user: req.user, ws: req.workspace, active: 'csf',
        engagement, currentVersion: null,
      });
    }

    const rollup = csfVersioning.loadSnapshotRollup(db, currentVersion);
    const allVersions = db.prepare(`SELECT id, version_number, published_at FROM csf_engagement_versions WHERE engagement_id=? ORDER BY published_at DESC`).all(engagement.id);

    // Snapshot findings + live remediation status joined onto live recommendations.
    const findingSnaps = db.prepare(`
      SELECT fs.*, s.code AS sub_code
      FROM csf_finding_snapshots fs
      LEFT JOIN csf_subcategories s ON s.id = fs.subcategory_id
      WHERE fs.version_id=?
      ORDER BY CASE fs.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
    `).all(currentVersion.id);
    const recSnaps = db.prepare(`
      SELECT rs.*, rstat.status AS rem_status, rstat.client_note AS rem_note, rstat.updated_at AS rem_updated_at,
        f.title AS finding_title, f.severity AS finding_severity
      FROM csf_recommendation_snapshots rs
      LEFT JOIN csf_remediation_status rstat ON rstat.recommendation_id = rs.recommendation_id
      LEFT JOIN csf_finding_snapshots f ON f.finding_id = rs.finding_id AND f.version_id = rs.version_id
      WHERE rs.version_id=?
    `).all(currentVersion.id);

    // Comments on findings (client side). Empty in prototype until client users exist.
    const clientComments = db.prepare(`
      SELECT cc.*, u.name AS commenter_name FROM csf_client_comments cc
      INNER JOIN users u ON u.id = cc.client_user_id
      INNER JOIN csf_findings f ON f.id = cc.finding_id
      WHERE f.engagement_id=? AND cc.deleted_at IS NULL ORDER BY cc.created_at DESC LIMIT 50
    `).all(engagement.id);

    res.render('csf_portal', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, currentVersion, allVersions, rollup,
      findingSnaps, recSnaps, clientComments,
      REMEDIATION_STATUSES,
      r1: csfScoring.r1,
    });
  });

  // Update remediation status for a recommendation.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/portal/remediation/:recId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!engagement) return res.status(404).send('Not found');
    if (engagement.status !== 'Published') return res.status(400).send('Remediation tracker is only available after publish.');

    const status = req.body.status;
    if (!REMEDIATION_STATUSES.includes(status)) return res.status(400).send('Bad status');
    const note = (req.body.client_note || '').trim() || null;
    const url = (req.body.client_evidence_url || '').trim() || null;

    // Verify recommendation belongs to this engagement.
    const rec = db.prepare(`
      SELECT r.id FROM csf_recommendations r
      INNER JOIN csf_findings f ON f.id = r.finding_id
      WHERE r.id=? AND f.engagement_id=?
    `).get(req.params.recId, engagement.id);
    if (!rec) return res.status(404).send('Recommendation not found');

    db.prepare(`
      INSERT INTO csf_remediation_status (recommendation_id, status, client_evidence_url, client_note, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(recommendation_id) DO UPDATE SET
        status=excluded.status, client_evidence_url=excluded.client_evidence_url,
        client_note=excluded.client_note, updated_by=excluded.updated_by,
        updated_at=CURRENT_TIMESTAMP
    `).run(rec.id, status, url, note, req.user.id);

    logAction(req.user.id, req.workspace.id, 'csf_remediation_update', 'csf_recommendation', rec.id, { status }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/portal#rec-${rec.id}`);
  });

  // Client comment on a finding.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/portal/comments', requireAuth, requireWorkspace, (req, res) => {
    const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!engagement) return res.status(404).send('Not found');
    if (engagement.status !== 'Published') return res.status(400).send('Comments only available after publish.');
    const findingId = parseInt(req.body.finding_id, 10);
    const text = (req.body.text || '').trim();
    if (!findingId || !text) return redirectBack(req, res, 'Comment text and finding id required', 'error');

    const f = db.prepare(`SELECT id FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(findingId, engagement.id);
    if (!f) return res.status(404).send('Finding not found');

    db.prepare(`INSERT INTO csf_client_comments (finding_id, client_user_id, text) VALUES (?, ?, ?)`).run(f.id, req.user.id, text);
    logAction(req.user.id, req.workspace.id, 'csf_client_comment', 'csf_finding', f.id, {}, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/portal#comments`);
  });

  // ---- Stage 8: Reports + CSV export ------------------------------------------
  const csfReports = require('../lib/csf-reports');

  // Word: live engagement (draft watermark) OR a specific version (vid query param).
  app.get('/workspaces/:wsId/csf/:id(\\d+)/exports/report.docx', requireAuth, requireWorkspace, async (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    csfPolicy.ensureAssessmentRows(db, engagement);

    let rollup, versionRow = null, isDraft;
    if (req.query.vid) {
      versionRow = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.query.vid, engagement.id);
      if (!versionRow) return res.status(404).send('Version not found in this engagement.');
      rollup = csfVersioning.loadSnapshotRollup(db, versionRow);
      isDraft = false;
    } else {
      rollup = csfScoring.computeEngagementRollup(db, engagement);
      isDraft = true;
    }

    const firm = db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id);
    const buf = await csfReports.buildWordReport({ db, engagement, ws: req.workspace, firm, currentRollup: rollup, isDraft, versionRow });
    const filename = `csf-report-${(engagement.name || 'engagement').replace(/[^\w.-]+/g, '_')}-${versionRow ? 'v' + versionRow.version_number : 'DRAFT'}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
    logAction(req.user.id, req.workspace.id, 'csf_report_export_docx', 'csf_engagement', engagement.id, { version_id: versionRow?.id || null }, auditCtx(req));
  });

  // CSV: one row per Subcategory. Stage 12 adds optional filters via query
  // params (?fn=GV, ?status=Approved, ?scored=1). Filters are advisory; the
  // rollup math is recomputed only against the kept rows so a filtered export
  // stays internally consistent.
  app.get('/workspaces/:wsId/csf/:id(\\d+)/exports/data.csv', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    csfPolicy.ensureAssessmentRows(db, engagement);
    const rollup = csfScoring.computeEngagementRollup(db, engagement);

    // Apply optional filters by trimming the rollup tree client-side. The CSV
    // builder iterates the supplied tree, so this is enough.
    const fnFilter = (req.query.fn || '').toUpperCase();
    const statusFilter = req.query.status || '';
    const scoredOnly = req.query.scored === '1';
    const excludedOnly = req.query.excluded === '1';

    if (fnFilter || statusFilter || scoredOnly || excludedOnly) {
      const filtered = JSON.parse(JSON.stringify(rollup));
      if (fnFilter) filtered.functions = filtered.functions.filter(f => f.code === fnFilter);
      for (const fn of filtered.functions) {
        for (const cat of fn.categories) {
          cat.subcategories = cat.subcategories.filter(s => {
            if (scoredOnly && s.current == null) return false;
            if (excludedOnly && !s.excluded) return false;
            if (statusFilter && s.status !== statusFilter) return false;
            return true;
          });
        }
        // Drop empty categories so the CSV doesn't have trailing nothing.
        fn.categories = fn.categories.filter(c => c.subcategories.length);
      }
      filtered.functions = filtered.functions.filter(f => f.categories.length);
      rollup.functions = filtered.functions;
    }

    const csv = csfReports.buildCsvExport({ db, engagement, currentRollup: rollup });
    const filterSuffix = [fnFilter, statusFilter && statusFilter.replace(/\s+/g, '_'), scoredOnly && 'scored', excludedOnly && 'excluded'].filter(Boolean).join('-');
    const filename = `csf-data-${(engagement.name || 'engagement').replace(/[^\w.-]+/g, '_')}${filterSuffix ? '-' + filterSuffix : ''}-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
    logAction(req.user.id, req.workspace.id, 'csf_report_export_csv', 'csf_engagement', engagement.id, { filters: { fn: fnFilter, status: statusFilter, scoredOnly, excludedOnly } }, auditCtx(req));
  });

  // Diff between two versions.
  app.get('/workspaces/:wsId/csf/:id(\\d+)/versions/:vid(\\d+)/diff/:against(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
    const newVer = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.params.vid, engagement.id);
    const oldVer = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.params.against, engagement.id);
    if (!newVer || !oldVer) return res.status(404).render('error', { user: req.user, message: 'One or both versions not found.' });
    const diff = csfVersioning.computeVersionDiff(db, oldVer, newVer);
    res.render('csf_version_diff', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, oldVer, newVer, diff,
      r1: csfScoring.r1,
    });
  });

  // Resolve a reviewer comment.
  app.post('/workspaces/:wsId/csf/:id(\\d+)/comments/:commentId(\\d+)/resolve', requireAuth, requireWorkspace, (req, res) => {
    const { engagement, error } = loadCsfEngagement(req);
    if (error) return res.status(error.status).send(error.message);
    const comment = db.prepare(`SELECT * FROM csf_reviewer_comments WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.commentId, engagement.id);
    if (!comment) return res.status(404).send('Not found');
    if (!csfPolicy.canResolveComment(db, req.user, engagement, comment)) return res.status(403).send('Forbidden');
    db.prepare(`UPDATE csf_reviewer_comments SET resolved=1, resolved_by=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, comment.id);
    logAction(req.user.id, req.workspace.id, 'csf_comment_resolve', 'csf_reviewer_comment', comment.id, null, auditCtx(req));
    res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
  });

  // Interested parties (clause 4.2) used to have a dedicated module here
  // (GET / POST / update / delete + views/interested_parties.ejs). Removed
  // because parties get identified naturally during the gap assessment +
  // implementation work on clauses 4.2 and 9.3.2.d - a separate "register
  // the parties" page was duplicative.
  //
  // The `interested_parties` table is kept as-is so the MRM auto-pack and
  // any existing rows continue to work; we just no longer surface a page
  // for creating new entries through the UI. If we ever need it back,
  // restore the four routes that lived here and re-list views/interested_parties.ejs.

}

module.exports = { register };
