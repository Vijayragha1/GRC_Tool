'use strict';
// Workspace lifecycle. Slice 15 of the server.js modularization: workspace
// CRUD, members, and team setup (engagement kickoff + client-side invites).
// Shares the invite token scheme with routes/auth.js.

const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rbac = require('../lib/rbac');
const ctlReads = require('../lib/control-reads');
const email = require('../lib/email');
const { hashToken, INVITE_TTL_MS } = require('./auth');
const { ALLOWED_FRAMEWORKS } = require('../lib/frameworks');
const { clientSetup, needsSetup } = require('../lib/client-setup');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');
const { buildWorkspaceTruth } = require('../lib/grc-truth');
const csfModel = require('../lib/csf-policy-practice');
const { buildIntegratedDashboard } = require('../lib/integrated-dashboard');
const { deleteWorkspace, workspaceStoredPaths } = require('../lib/workspace-deletion');
const consultingDelivery = require('../lib/consulting-delivery');
const engagementDelivery = require('../lib/engagement-delivery');
const isoLifecycle = require('../lib/iso-lifecycle');
const gapFieldwork = require('../lib/gap-fieldwork');
const { buildGapAssessmentOverview } = require('../lib/workspace-outcome-overview');
const tprmDomain = require('../lib/tprm-domain');
const vcisoService = require('../lib/vciso-service');
const { confirmationMatchesRenderedName } = require('../lib/typography');

function submittedFrameworks(value) {
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  return [...new Set(values.filter(code => ALLOWED_FRAMEWORKS.includes(code)))];
}

function firmUserCan(user, permission) {
  if (!user || user.user_type !== 'firm') return false;
  return rbac.rolePermissions(rbac.normalizeRole(user.firm_role) || 'consultant').includes(permission);
}

function renderNewWorkspace(res, user, form = {}, formError = null, status = 200) {
  return res.status(status).render('workspace_new', {
    user,
    ws: null,
    form,
    formError,
    outcomeOptions: isoLifecycle.OUTCOME_OPTIONS,
  });
}

function outcomeEngagementName(workspace, outcome) {
  return isoLifecycle.isGapOnly(outcome)
    ? `${workspace.client_name} ISO 27001 gap assessment`
    : `${workspace.client_name} ISO 27001 certification support`;
}

function hasIso27001DeliveryHistory(db, workspaceId) {
  const engagement = db.prepare(`SELECT 1 FROM consulting_engagements e
    WHERE e.workspace_id=? AND EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(e.framework_scope_json) THEN e.framework_scope_json ELSE '[]' END)
      WHERE value='iso27001'
    ) LIMIT 1`).get(workspaceId);
  const plan = db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=? LIMIT 1').get(workspaceId);
  return !!engagement || !!plan;
}

function hasFullCertificationDeliveryHistory(db, workspaceId) {
  const implementationEngagement = db.prepare(`SELECT 1 FROM consulting_engagements e
    WHERE e.workspace_id=? AND e.engagement_type IN ('implementation','readiness','advisory')
      AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(e.framework_scope_json) THEN e.framework_scope_json ELSE '[]' END)
        WHERE value='iso27001'
      )
    LIMIT 1`).get(workspaceId);
  const fullPlan = db.prepare(`SELECT 1 FROM engagement_delivery_plans p
    WHERE p.workspace_id=? AND (
      p.name='ISO 27001 certification support delivery plan'
      OR p.objective LIKE '%Stage 1 and Stage 2%'
      OR p.completion_criteria LIKE '%Stage 1%Stage 2%'
      OR EXISTS (
        SELECT 1 FROM engagement_delivery_events ev
        WHERE ev.plan_id=p.id AND ev.action='contract_outcome_expanded'
      )
    ) LIMIT 1`).get(workspaceId);
  return !!implementationEngagement || !!fullPlan;
}

function syncCertificationDeadlineAnswer(db, workspaceId, targetDate, actorId) {
  if (!targetDate) {
    db.prepare("DELETE FROM engagement_intake WHERE workspace_id=? AND question_id='cert-deadline'").run(workspaceId);
    return;
  }
  db.prepare(`INSERT INTO engagement_intake (workspace_id,question_id,answer,answered_by,answered_at)
    VALUES (?,'cert-deadline',?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id,question_id) DO UPDATE SET
      answer=excluded.answer,answered_by=excluded.answered_by,answered_at=CURRENT_TIMESTAMP`)
    .run(workspaceId, targetDate, actorId);
}

function createCertificationFollowOn(db, workspace, actorId) {
  const baseCode = `ENG-${String(workspace.id).padStart(4, '0')}-CERT`;
  let engagementCode = baseCode;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM consulting_engagements WHERE workspace_id=? AND engagement_code=?').get(workspace.id, engagementCode)) {
    engagementCode = `${baseCode}-${suffix++}`;
  }
  const frameworks = Array.isArray(workspace.frameworks) && workspace.frameworks.length
    ? workspace.frameworks
    : ['iso27001'];
  const id = Number(db.prepare(`INSERT INTO consulting_engagements
    (workspace_id,engagement_code,name,engagement_type,framework_scope_json,scope_statement,status,
     lead_consultant_id,start_date,target_date,created_by)
    VALUES (?,?,?,?,?,?,'active',?,date('now'),?,?)`)
    .run(workspace.id, engagementCode, outcomeEngagementName(workspace, 'certification_support'),
      'implementation', JSON.stringify(frameworks), workspace.scope || null,
      workspace.lead_consultant_id || actorId, workspace.target_cert_date || null, actorId).lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team
    (engagement_id,user_id,role,assigned_by) VALUES (?,?,'engagement_lead',?)`)
    .run(id, workspace.lead_consultant_id || actorId, actorId);
  db.prepare('INSERT INTO engagement_commercials (engagement_id,updated_by) VALUES (?,?)').run(id, actorId);
  consultingDelivery.ensureMethodology(db, workspace.firm_id, actorId);
  consultingDelivery.event(db, workspace.id, id, actorId, 'engagement', id, 'created', {
    frameworks,
    follow_on_from_gap_assessment: true,
    engagement_outcome: 'certification_support',
  });
  consultingDelivery.event(db, workspace.id, id, actorId, 'engagement', id, 'contracted_outcome_synchronized', {
    engagement_outcome: 'certification_support',
    from_engagement_type: 'gap_assessment',
    to_engagement_type: 'implementation',
    completed_gap_engagement_retained: true,
  });
  // The workspace has one adaptive plan. Point its consulting lineage to the
  // active follow-on while retaining the completed gap engagement and report.
  db.prepare('UPDATE engagement_delivery_plans SET consulting_engagement_id=? WHERE workspace_id=?')
    .run(id, workspace.id);
  return db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(id);
}

// Keep the workspace-level contract aligned with the engagement that the
// consulting cockpit opens first. A completed gap assessment remains a
// historical engagement: ensureEngagement creates the follow-on implementation
// engagement when the client elects to continue to certification support.
function synchronizeOutcomeEngagement(db, workspace, actorId, outcome, { forceName = false } = {}) {
  const desiredType = isoLifecycle.consultingEngagementType(outcome);
  let engagement = db.prepare(`SELECT * FROM consulting_engagements WHERE workspace_id=?
    AND status NOT IN ('complete','cancelled')
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,id LIMIT 1`).get(workspace.id);
  if (!engagement) {
    const priorEngagement = db.prepare('SELECT 1 FROM consulting_engagements WHERE workspace_id=? LIMIT 1').get(workspace.id);
    engagement = priorEngagement && desiredType === 'implementation'
      ? createCertificationFollowOn(db, workspace, actorId)
      : consultingDelivery.ensureEngagement(db, workspace, actorId);
  }
  if (!['gap_assessment', 'implementation'].includes(engagement.engagement_type)) return engagement;
  const desiredName = outcomeEngagementName(workspace, outcome);
  const desiredFrameworks = Array.isArray(workspace.frameworks) && workspace.frameworks.length
    ? [...new Set(workspace.frameworks.map(String))]
    : ['iso27001'];
  let currentFrameworks = [];
  try { currentFrameworks = JSON.parse(engagement.framework_scope_json || '[]'); } catch (_) {}
  const typeChanged = engagement.engagement_type !== desiredType;
  const nameChanged = forceName && engagement.name !== desiredName;
  const scopeChanged = JSON.stringify(currentFrameworks) !== JSON.stringify(desiredFrameworks);
  const desiredTarget = desiredType === 'implementation' ? (workspace.target_cert_date || null) : null;
  const targetChanged = (engagement.target_date || null) !== desiredTarget;
  if (!typeChanged && !nameChanged && !scopeChanged && !targetChanged) return engagement;

  db.prepare(`UPDATE consulting_engagements
    SET engagement_type=?,name=?,framework_scope_json=?,target_date=?,updated_at=datetime('now'),row_version=row_version+1
    WHERE id=? AND workspace_id=?`)
    .run(desiredType, desiredName, JSON.stringify(desiredFrameworks), desiredTarget, engagement.id, workspace.id);
  consultingDelivery.event(db, workspace.id, engagement.id, actorId,
    'engagement', engagement.id, 'contracted_outcome_synchronized', {
      engagement_outcome: isoLifecycle.normalizeOutcome(outcome),
      from_engagement_type: engagement.engagement_type,
      to_engagement_type: desiredType,
      framework_scope: desiredFrameworks,
      target_date: desiredTarget,
    });
  return db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagement.id);
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          isFirmUser, computeReadiness, workspaceProgress, computeNextStep,
          computeRoadmap, computeClientStage, computeNeedsAttention, resolveUploadPath } = deps;

  // ==================== WORKSPACE CRUD ====================
  app.get('/workspaces/new', requireAuth, (req, res) => {
    if (!firmUserCan(req.user, 'workspace.create')) return res.status(403).render('error', { user: req.user, message: 'You do not have permission to create client workspaces.' });
    return renderNewWorkspace(res, req.user);
  });

  app.post('/workspaces', requireAuth, (req, res) => {
    if (!firmUserCan(req.user, 'workspace.create')) return res.status(403).send('Forbidden');
    const { client_name, industry, scope, target_cert_date, engagement_outcome } = req.body;
    if (!client_name) return res.redirect('/dashboard');
    // The contracted endpoint applies only to ISO 27001. NIST CSF, ISO 42001
    // and programme-neutral clients must not be forced into an ISO lifecycle
    // or labelled as certification-support work because of the legacy default.
    const frameworks = submittedFrameworks(req.body.frameworks);
    const vcisoRequested = String(req.body.vciso_enabled || '') === '1';
    const tprmRequested = String(req.body.tprm_enabled || '') === '1';
    const tprmServiceModel = String(req.body.tprm_service_model || '').trim();
    if (tprmRequested && !tprmDomain.SERVICE_MODELS.includes(tprmServiceModel)) {
      return renderNewWorkspace(res, req.user, req.body,
        'Choose how the Third-party risk service will be delivered.', 400);
    }
    const hasIso27001 = frameworks.includes('iso27001');
    if (hasIso27001 && !isoLifecycle.isValidOutcome(engagement_outcome)) {
      return renderNewWorkspace(res, req.user, req.body,
        'Choose whether this engagement ends after the gap-assessment report or continues through certification support.', 400);
    }
    const outcome = hasIso27001
      ? isoLifecycle.normalizeOutcome(engagement_outcome)
      : 'certification_support'; // storage compatibility; not presented as an ISO contract
    const storedTargetDate = !hasIso27001 || isoLifecycle.isGapOnly(outcome) ? null : (target_cert_date || null);
    // Every programme is optional at client creation. An empty array is a
    // governed planning state, not a signal to silently enable every framework.
    const id = db.transaction(() => {
      const workspaceId = Number(db.prepare(`INSERT INTO workspaces
        (firm_id,client_name,industry,scope,target_cert_date,lead_consultant_id,frameworks,engagement_outcome)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(req.user.firm_id, client_name.trim(), industry || null,
          scope || null, storedTargetDate, req.user.id,
          JSON.stringify(frameworks), outcome).lastInsertRowid);
      // Seed the intake's cert-deadline answer only for a certification-support
      // contract. A report-only engagement must not inherit certification
      // pressure or a Stage 1/2 deadline from a stale form value.
      if (storedTargetDate) {
        db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
          VALUES (?, 'cert-deadline', ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(workspace_id, question_id) DO UPDATE SET answer=excluded.answer, answered_by=excluded.answered_by, answered_at=CURRENT_TIMESTAMP`)
          .run(workspaceId, storedTargetDate, req.user.id);
      }
      if (frameworks.includes('iso27001')) {
        const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
        workspace.frameworks = frameworks;
        synchronizeOutcomeEngagement(db, workspace, req.user.id, outcome, { forceName: true });
      }
      if (tprmRequested) {
        tprmDomain.enableModule(db, {
          workspaceId,
          serviceModel: tprmServiceModel,
          actorId: req.user.id,
          reason: 'Enabled during governed client onboarding.',
        });
      }
      if (vcisoRequested) {
        vcisoService.enableService(db, {
          workspaceId,
          actorId: req.user.id,
          reason: 'Enabled during governed client onboarding.',
        });
      }
      return workspaceId;
    })();
    logAction(req.user.id, id, 'create_workspace', 'workspace', id,
      {
        client_name,
        frameworks,
        engagement_outcome: hasIso27001 ? outcome : null,
        tprm_enabled: tprmRequested,
        tprm_service_model: tprmRequested ? tprmServiceModel : null,
        vciso_enabled: vcisoRequested,
      });
    // Redirect into the intake page rather than the workspace overview. The
    // overview is meaningful only once the engagement has real context;
    // intake is the obvious next step (scope sign-off, stakeholders, crown
    // jewels) and the page already shows progress + an "Apply to workspace"
    // button that backfills the scope statement and links crown-jewel assets.
    // One service goes straight to its own scoping surface: a checklist of one
    // is ceremony. More than one goes to the setup hub, because the old code
    // special-cased three single-service clients and sent everyone else to the
    // ISO 27001 intake - so a client bought as ISO 42001 + CSF + DPDPA was
    // walked through a questionnaire for a standard it is not assessed
    // against, and the three programmes it did buy were never scoped. Live
    // data still carries three clients damaged that way.
    const enabled = [
      ...frameworks,
      ...(tprmRequested ? ['tprm'] : []),
      ...(vcisoRequested ? ['vciso'] : []),
    ];
    if (enabled.length === 1) {
      const direct = {
        iso27001: `/workspaces/${id}/intake`,
        iso42001: `/workspaces/${id}/iso42001/intake`,
        csf: `/workspaces/${id}/csf`,
        dpdpa: `/workspaces/${id}/dpdpa`,
        tprm: `/workspaces/${id}/tprm`,
        vciso: `/workspaces/${id}/delivery`,
      }[enabled[0]];
      if (direct) return res.redirect(withToast(direct, 'Client created - start the scoping'));
    }
    res.redirect(withToast(`/workspaces/${id}/setup`, enabled.length
      ? `Client created - ${enabled.length} services to scope`
      : 'Client created - assign a programme to begin'));
  });

  // The client setup hub. Every programme and module this client was sold,
  // each with its own scoping step and a live status. Reachable at any time,
  // and where both the create flow and the unscoped-client redirect land.
  app.get('/workspaces/:wsId/setup', requireAuth, requireWorkspace, (req, res) => {
    const ws = req.workspace;
    const tprmModule = tprmDomain.moduleForWorkspace(db, ws.id);
    res.render('client_setup', {
      user: req.user,
      ws,
      active: 'setup',
      setup: clientSetup(db, ws),
      hasTprm: !!tprmModule,
      // res.locals.userPerms, not req.userPerms: the latter is only populated
      // by requirePermission middleware, which this route does not use.
      canEnableTprm: rbac.hasPermission(res.locals.userPerms || [], 'tprm.methodology.manage'),
    });
  });

  app.get('/workspaces/:wsId', requireAuth, requireWorkspace, (req, res) => {
    const ws = req.workspace;
    const frameworkCodes = Array.isArray(ws.frameworks) ? ws.frameworks : [];
    const tprmModule = tprmDomain.moduleForWorkspace(db, ws.id);

    // A programme-neutral client can legitimately run TPRM as its only
    // service. Do not send that client through an unrelated framework intake.
    if (frameworkCodes.length === 0 && tprmModule && tprmModule.status === 'active') {
      return res.redirect(`/workspaces/${ws.id}/tprm`);
    }
    if (frameworkCodes.length === 0 && Number(ws.vciso_enabled || 0) === 1) {
      return res.redirect(`/workspaces/${ws.id}/delivery`);
    }

    // A CSF-only workspace has one authoritative home: the cybersecurity
    // maturity programme. Keeping a separate generic overview creates two
    // navigation entries for the same decision surface.
    if (frameworkCodes.length === 1 && frameworkCodes[0] === 'csf') {
      return res.redirect(`/workspaces/${ws.id}/csf`);
    }
    if (frameworkCodes.length === 1 && frameworkCodes[0] === 'iso42001') {
      return res.redirect(`/workspaces/${ws.id}/iso42001`);
    }
    if (frameworkCodes.length === 1 && frameworkCodes[0] === 'dpdpa') {
      return res.redirect(`/workspaces/${ws.id}/dpdpa`);
    }

    // Split-brain fix: if the client setup has never been started AND the
    // scope field is empty, the overview's readiness/charts are mostly
    // zeros - send the consultant to setup instead. Once they've answered
    // even one intake question (or pasted in a scope manually), the
    // overview becomes the home and we stop redirecting.
    // Setup state comes from each programme's own signal, not from a count of
    // ISO 27001 intake rows. That count was wrong twice over: it credited the
    // cert-deadline answer this route auto-seeds at creation, so a genuinely
    // untouched client looked started and never got redirected; and it stayed
    // at zero forever for a client with no ISO 27001, so that client was
    // bounced to the ISO 27001 intake on every single open.
    if (!req.query.skipSetupRedirect && needsSetup(db, ws)) {
      return res.redirect(`/workspaces/${ws.id}/setup`);
    }
    const intakeAnswered = db.prepare(`SELECT COUNT(*) AS c FROM engagement_intake
      WHERE workspace_id=? AND question_id<>'cert-deadline'
        AND answer IS NOT NULL AND length(trim(answer)) > 0`).get(ws.id).c;
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
        outcomeOptions:isoLifecycle.OUTCOME_OPTIONS,
        canEnableTprm:rbac.hasPermission(res.locals.userPerms || [], 'tprm.methodology.manage'),
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

    const engagementOutcome = isoLifecycle.normalizeOutcome(ws.engagement_outcome);
    const gapAssessmentOverview = isoLifecycle.isGapOnly(engagementOutcome)
      ? buildGapAssessmentOverview(gapFieldwork.assessmentContext(db, ws))
      : null;

    res.render('workspace', {
      user: req.user, ws, progress, breakdown, themes, riskCount, openRisks,
      assetCount, evidenceCount, openTasks, actionItems,
      docCount, auditCount, mrmCount, ncOpen, recentActivity, readiness, sparkline,
      roadmap, needsAttention, nextStep, activePass,
      setupIncomplete, intakeAnswered, derivedStage, truth,
      engagementOutcome,
      engagementOutcomeLabel: isoLifecycle.label(ws.engagement_outcome),
      lifecycleOutcomes: isoLifecycle.OUTCOME_OPTIONS,
      gapAssessmentOverview,
    });
  });

  // Roadmap is a projection of the authoritative adaptive delivery plan.
  // Keep the legacy URL for bookmarks, but never maintain a second plan.
  app.get('/workspaces/:wsId/roadmap', requireAuth, requireWorkspace, (req, res) => {
    res.redirect(`/workspaces/${req.workspace.id}/engagement-plan?view=timeline`);
  });

  app.post('/workspaces/:wsId/frameworks', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req,res) => {
    const frameworks = submittedFrameworks(req.body.frameworks);
    const currentFrameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    const currentHasIso27001 = currentFrameworks.includes('iso27001');
    const requestedHasIso27001 = frameworks.includes('iso27001');
    const deliveryHistory = hasIso27001DeliveryHistory(db, req.workspace.id);
    const fullDeliveryHistory = hasFullCertificationDeliveryHistory(db, req.workspace.id);
    const storedOutcome = isoLifecycle.normalizeOutcome(req.workspace.engagement_outcome);
    if (currentHasIso27001 && !requestedHasIso27001 && deliveryHistory) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'ISO 27001 cannot be removed after its contracted delivery engagement has been created. Use the governed engagement cancellation process instead.'
      });
    }
    if (requestedHasIso27001 && !isoLifecycle.isValidOutcome(req.body.engagement_outcome)) {
      return res.status(400).render('error', {
        user: req.user,
        message: 'Choose whether the ISO 27001 engagement ends at the gap-assessment report or continues through full certification support.'
      });
    }
    const requestedOutcome = requestedHasIso27001
      ? isoLifecycle.normalizeOutcome(req.body.engagement_outcome)
      : storedOutcome;
    if (deliveryHistory && (fullDeliveryHistory || !isoLifecycle.isGapOnly(storedOutcome)) && isoLifecycle.isGapOnly(requestedOutcome)) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'Full certification support cannot be shortened to gap assessment only, including by disabling and re-enabling ISO 27001.'
      });
    }
    if (deliveryHistory && !fullDeliveryHistory && isoLifecycle.isGapOnly(storedOutcome) && !isoLifecycle.isGapOnly(requestedOutcome)
      && req.body.confirm_outcome_upgrade !== '1') {
      return res.status(400).render('error', {
        user: req.user,
        message: 'Confirm the one-way change to full certification support before expanding this engagement.'
      });
    }
    const storedTargetDate = requestedHasIso27001 && !isoLifecycle.isGapOnly(requestedOutcome)
      ? (req.body.target_cert_date || null)
      : null;
    db.transaction(() => {
      db.prepare(`UPDATE workspaces SET frameworks=?,engagement_outcome=?,target_cert_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(JSON.stringify(frameworks), requestedOutcome, storedTargetDate, req.workspace.id);
      if (requestedHasIso27001) {
        const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.workspace.id);
        workspace.frameworks = frameworks;
        synchronizeOutcomeEngagement(db, workspace, req.user.id, requestedOutcome, { forceName: true });
        engagementDelivery.syncCertificationTarget(db, workspace, req.user.id);
        syncCertificationDeadlineAnswer(db, workspace.id, storedTargetDate, req.user.id);
      }
    })();
    logAction(req.user.id,req.workspace.id,'update_workspace_frameworks','workspace',req.workspace.id,{
      frameworks,
      engagement_outcome: requestedHasIso27001 ? requestedOutcome : null,
    },auditCtx(req));
    const message = frameworks.length ? 'Assessment programmes updated' : 'Client left without an assigned assessment programme';
    res.redirect(withToast(`/workspaces/${req.workspace.id}`,message));
  });

  app.post('/workspaces/:wsId/modules/tprm', requireAuth, requireWorkspace,
    requirePermission('tprm.methodology.manage'), (req, res) => {
      const serviceModel = String(req.body.service_model || '').trim();
      if (!tprmDomain.SERVICE_MODELS.includes(serviceModel)) {
        return res.status(400).render('error', {
          user:req.user, ws:req.workspace,
          message:'Choose a valid Third-party risk service model before enabling the module.'
        });
      }
      try {
        const result = tprmDomain.enableModule(db, {
          workspaceId:req.workspace.id,
          serviceModel,
          actorId:req.user.id,
          reason:String(req.body.reason || 'Enabled from governed client programme setup.').trim(),
          idempotencyKey:req.body.idempotency_key || null,
        });
        logAction(req.user.id, req.workspace.id,
          result.classified ? 'classify_tprm_module' : 'enable_tprm_module',
          'tprm_module', result.module.id, {
            service_model:result.module.service_model,
            created:Boolean(result.created),
            classified:Boolean(result.classified),
          }, auditCtx(req));
        const message = result.classified
          ? 'Historic Third-party risk records classified and activated'
          : result.created ? 'Third-party risk enabled' : 'Third-party risk is already active';
        return res.redirect(withToast(`/workspaces/${req.workspace.id}/tprm`, message));
      } catch (error) {
        const status = [400,403,404,409].includes(Number(error.status)) ? Number(error.status) : 409;
        return res.status(status).render('error', {
          user:req.user, ws:req.workspace,
          message:error.message || 'Third-party risk could not be enabled.'
        });
      }
    });

  app.post('/workspaces/:wsId/update', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    const {
      client_name, industry, scope, target_cert_date, stage, lead_consultant_id,
      brand_display_name, brand_primary_color, brand_logo_path, sector,
      updated_at_snapshot,
    } = req.body;
    const currentLeadId = parseInt(req.workspace.lead_consultant_id, 10) || null;
    const leadWasSubmitted = Object.prototype.hasOwnProperty.call(req.body || {}, 'lead_consultant_id');
    const requestedLeadId = leadWasSubmitted ? (parseInt(lead_consultant_id, 10) || null) : currentLeadId;
    if (requestedLeadId !== currentLeadId) {
      if (!rbac.hasPermission(req.userPerms, 'members.assign_role')) {
        return res.status(403).render('error', {
          user: req.user,
          message: 'Changing the engagement lead requires member role-assignment permission.'
        });
      }
      if (requestedLeadId) {
        const lead = db.prepare(`SELECT id FROM users
          WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`)
          .get(requestedLeadId, req.workspace.firm_id);
        if (!lead) {
          return res.status(400).render('error', {
            user: req.user,
            message: 'The selected engagement lead is not an active consultant in this firm.'
          });
        }
      }
    }
    // Validate brand color is a hex literal - anything else gets stored as null so
    // a malformed value can't break the page CSS.
    const safeColor = (typeof brand_primary_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(brand_primary_color.trim()))
      ? brand_primary_color.trim() : null;
    const frameworks = req.body.frameworks_present === '1'
      ? submittedFrameworks(req.body.frameworks)
      : (Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : []);
    const currentFrameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    const currentHasIso27001 = currentFrameworks.includes('iso27001');
    const requestedHasIso27001 = frameworks.includes('iso27001');
    const deliveryHistory = hasIso27001DeliveryHistory(db, req.workspace.id);
    const fullDeliveryHistory = hasFullCertificationDeliveryHistory(db, req.workspace.id);
    const storedOutcome = isoLifecycle.normalizeOutcome(req.workspace.engagement_outcome);
    const currentOutcome = currentHasIso27001
      ? storedOutcome
      : null;
    const outcomeWasSubmitted = Object.prototype.hasOwnProperty.call(req.body || {}, 'engagement_outcome');
    if (requestedHasIso27001 && (!outcomeWasSubmitted || !isoLifecycle.isValidOutcome(req.body.engagement_outcome))) {
      return res.status(400).render('error', {
        user: req.user,
        message: 'Choose whether the ISO 27001 engagement ends at the gap-assessment report or continues through full certification support.'
      });
    }
    const requestedOutcome = requestedHasIso27001
      ? isoLifecycle.normalizeOutcome(req.body.engagement_outcome)
      : storedOutcome; // retain contract history while ISO 27001 is not enabled
    if (currentHasIso27001 && !requestedHasIso27001 && deliveryHistory) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'ISO 27001 cannot be removed after its contracted delivery engagement has been created. Use the governed engagement cancellation process instead.'
      });
    }
    if (deliveryHistory && (fullDeliveryHistory || !isoLifecycle.isGapOnly(storedOutcome)) && isoLifecycle.isGapOnly(requestedOutcome)) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'Full certification support cannot be shortened to gap assessment only, including by disabling and re-enabling ISO 27001. Create a separately scoped gap-assessment engagement if that is the new requirement.'
      });
    }
    if (deliveryHistory && !fullDeliveryHistory && isoLifecycle.isGapOnly(storedOutcome)
      && !isoLifecycle.isGapOnly(requestedOutcome)
      && req.body.confirm_outcome_upgrade !== '1') {
      return res.status(400).render('error', {
        user: req.user,
        message: 'Confirm the one-way change to full certification support before expanding this engagement.'
      });
    }
    const outcomeChanged = requestedHasIso27001 && (!currentHasIso27001 || requestedOutcome !== storedOutcome);
    const storedTargetDate = !requestedHasIso27001 || isoLifecycle.isGapOnly(requestedOutcome)
      ? null
      : (target_cert_date || null);
    // Optimistic concurrency: client roundtrips workspaces.updated_at as a
    // hidden field. The UPDATE WHERE updated_at = ? guarantees only one of
    // two simultaneous edits wins; the loser is redirected to a conflict page
    // that surfaces the new state so they can re-apply their edit deliberately.
    // Forms rendered before this fix won't include the field; treat missing
    // snapshot as "skip the check" so the migration doesn't break old tabs.
    const usingCAS = !!updated_at_snapshot;
    const sql = usingCAS
      ? `UPDATE workspaces
           SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?, engagement_outcome=?,
               brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?, frameworks=?,
               updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND updated_at=?`
      : `UPDATE workspaces
           SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?, engagement_outcome=?,
               brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?, frameworks=?,
               updated_at=CURRENT_TIMESTAMP
         WHERE id=?`;
    const args = [
      client_name, industry || null, scope || null, storedTargetDate,
      stage || 'gap_assessment', requestedLeadId, requestedOutcome,
      (brand_display_name || '').trim() || null,
      safeColor,
      (brand_logo_path || '').trim() || null,
      (sector || '').trim() || null,
      JSON.stringify(frameworks),
      req.workspace.id,
    ];
    if (usingCAS) args.push(updated_at_snapshot);
    const result = db.transaction(() => {
      const update = db.prepare(sql).run(...args);
      if (update.changes && requestedHasIso27001) {
        const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.workspace.id);
        workspace.frameworks = frameworks;
        if (outcomeChanged) synchronizeOutcomeEngagement(db, workspace, req.user.id, requestedOutcome, { forceName: true });
        engagementDelivery.syncCertificationTarget(db, workspace, req.user.id);
        syncCertificationDeadlineAnswer(db, workspace.id, storedTargetDate, req.user.id);
      }
      return update;
    })();
    if (usingCAS && result.changes === 0) {
      return res.status(409).render('error', {
        user: req.user,
        message: 'Another consultant updated this client\'s settings while you were editing. Reload the workspace settings page to see the latest values, then re-apply your changes.'
      });
    }
    logAction(req.user.id, req.workspace.id, 'update_workspace', 'workspace', req.workspace.id, {
      frameworks,
      engagement_outcome: requestedHasIso27001 ? requestedOutcome : null,
      previous_engagement_outcome: currentOutcome,
    });
    res.redirect('/workspaces/' + req.workspace.id);
  });

  // Destructive: delete a workspace (= one client engagement) and everything
  // inside it - controls, risks, evidence rows + files on disk, audits, MRMs,
  // gap passes, registers. Requires typing the client name to confirm.
  app.post('/workspaces/:wsId/delete', requireAuth, requireWorkspace, requirePermission('workspace.delete'), (req, res) => {
    const ws = req.workspace;
    const confirm = (req.body.confirm_name || '').trim();
    if (!confirmationMatchesRenderedName(confirm, ws.client_name)) {
      return res.redirect(withToast('/workspaces/' + ws.id + '#workspace-settings',
        'Confirmation name did not match - nothing deleted', 'error'));
    }

    // Collect retained upload paths before their owning rows are removed.
    const storedPaths = workspaceStoredPaths(db, ws);

    // A populated workspace contains immutable workpaper, assessment and
    // reporting history. Normal row-level deletes must remain blocked, while
    // this explicit client-lifecycle operation must remove the whole tenant.
    // The governed helper performs the purge with foreign keys enabled and
    // restores every immutable-history trigger before committing.
    try {
      deleteWorkspace(db, ws.id);
    } catch (error) {
      console.error(`[delete-workspace] workspace ${ws.id} could not be deleted:`, error.message);
      logAction(req.user.id, ws.id, 'delete_workspace_failed', 'workspace', ws.id,
        { client_name: ws.client_name, error: error.message });
      return res.redirect(withToast(`/workspaces/${ws.id}#workspace-settings`,
        'Client could not be deleted. No data was removed.', 'error'));
    }

    // Best-effort filesystem cleanup. Files live in uploads/firm_{id}/ shared
    // across workspaces, so we have to delete by exact path rather than wiping
    // a directory.
    for (const storedPath of storedPaths) {
      try {
        const abs = resolveUploadPath(storedPath, ws.firm_id);
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
    if (r !== 'contributor' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a privileged client role requires member role-assignment permission.'
      });
    }

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

  app.post('/workspaces/:wsId/members/firm', requireAuth, requireWorkspace, requirePermission('members.add'), (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const { user_id, role } = req.body;
    // Firm-side workspace members map to firm-side roles. Senior consultant is
    // the highest a firm member can hold here; Manager is firm-wide, not per-ws.
    const allowedRoles = ['senior_consultant','consultant'];
    const r = allowedRoles.includes(role) ? role : 'consultant';
    if (r !== 'consultant' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a senior consultant requires member role-assignment permission.'
      });
    }
    const candidate = db.prepare(`SELECT id FROM users
      WHERE id=? AND firm_id=? AND user_type='firm' AND active=1`).get(user_id, req.workspace.firm_id);
    if (!candidate) return res.status(400).render('error', {
      user: req.user, message: 'The selected consultant is not an active user in this firm.'
    });
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

  app.post('/workspaces/:wsId/team/set-lead', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
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

  app.post('/workspaces/:wsId/team/add-firm-member', requireAuth, requireWorkspace, requirePermission('members.add'), (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const userId = parseInt(req.body.user_id, 10);
    const role = ['senior_consultant', 'consultant'].includes(req.body.role) ? req.body.role : 'consultant';
    if (role !== 'consultant' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a senior consultant requires member role-assignment permission.'
      });
    }
    if (!userId) return res.redirect('/workspaces/' + req.workspace.id + '/team');
    // Same-firm check; prevents adding someone from another firm via crafted form.
    const exists = db.prepare(`SELECT id FROM users WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`).get(userId, req.workspace.firm_id);
    if (!exists) return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('Pick a firm consultant.'));
    try {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(req.workspace.id, userId, role);
    } catch (_) { /* already a member - ignore */ }
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant added to engagement.'));
  });

  app.post('/workspaces/:wsId/team/remove-firm-member/:memberId', requireAuth, requireWorkspace, requirePermission('members.remove'), (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?').run(req.params.memberId, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant removed from engagement.'));
  });

  app.post('/workspaces/:wsId/team/invite-client', requireAuth, requireWorkspace, requirePermission('members.add'), async (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = (b.name || '').trim() || null;
    const role = ['client_owner', 'isms_manager', 'contributor'].includes(b.workspace_role) ? b.workspace_role : 'contributor';
    if (role !== 'contributor' && !rbac.hasPermission(req.userPerms, 'members.assign_role')) {
      return res.status(403).render('error', {
        user: req.user, message: 'Assigning a privileged client role requires member role-assignment permission.'
      });
    }
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

  app.post('/workspaces/:wsId/team/revoke-invite/:invId', requireAuth, requireWorkspace, requirePermission('members.remove'), (req, res) => {
    if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
    const inv = db.prepare(`SELECT id, workspace_id FROM user_invitations WHERE id = ?`).get(req.params.invId);
    if (!inv || inv.workspace_id !== req.workspace.id) return res.redirect('/workspaces/' + req.workspace.id + '/team');
    db.prepare(`UPDATE user_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(inv.id);
    res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Invitation revoked.'));
  });

}

module.exports = { register };
