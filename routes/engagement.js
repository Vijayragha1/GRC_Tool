// Engagement routes: kickoff intake and the adaptive delivery system shared
// by Plan, Timeline, Tasks and Calendar.

const INTAKE = require('../data/intake-questions');
const delivery = require('../lib/engagement-delivery');
const auditPack = require('../lib/audit-pack');
const enc = require('../lib/encryption');
const fs = require('fs');
const crypto = require('crypto');
const fts = require('../lib/fts');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, withToast, logAction, auditCtx, upload, resolveUploadPath } = deps;

  // ---------- INTAKE ----------
  app.get('/workspaces/:wsId/intake', requireAuth, requireWorkspace, (req, res) => {
    const rows = db.prepare(`SELECT question_id, answer FROM engagement_intake WHERE workspace_id=?`)
      .all(req.workspace.id);
    const answers = {};
    for (const r of rows) answers[r.question_id] = r.answer || '';
    const flat = INTAKE.flatten();
    const total = flat.length;
    const answered = flat.filter(q => (answers[q.id] || '').trim().length > 0).length;
    const requiredAnswered = flat.filter(q => q.required && (answers[q.id] || '').trim().length > 0).length;
    const requiredTotal = flat.filter(q => q.required).length;
    const draftScope = INTAKE.draftScopeStatement(answers);
    const summary = INTAKE.computeEngagementSummary(answers);
    const crownJewelQuestions = INTAKE.crownJewelQuestions(answers);
    const crownJewelAssets = {};
    for (const item of INTAKE.crownJewelAnswers(answers)) {
      const asset = db.prepare(`SELECT id,name FROM assets
        WHERE workspace_id=? AND ((source_type='engagement_intake' AND source_ref=?) OR lower(trim(name))=lower(trim(?)))
        ORDER BY CASE WHEN source_type='engagement_intake' AND source_ref=? THEN 0 ELSE 1 END,id LIMIT 1`)
        .get(req.workspace.id, item.id, item.name, item.id);
      if (asset) crownJewelAssets[item.id] = asset;
    }
    // Ready to confirm = all required answered. The consultant can
    // also confirm earlier if they explicitly want to (the route just
    // takes whatever's in the answers table) - this gates the banner
    // visibility, not the action.
    const readyToConfirm = requiredAnswered === requiredTotal && requiredTotal > 0;
    const scopeConfirmedAt = req.workspace.scope_confirmed_at || null;
    let scopeConfirmedBy = null;
    if (req.workspace.scope_confirmed_by) {
      try {
        scopeConfirmedBy = db.prepare('SELECT name FROM users WHERE id=?').get(req.workspace.scope_confirmed_by);
      } catch (_) {}
    }
    res.render('intake', {
      user: req.user, ws: req.workspace,
      sections: INTAKE.SECTIONS, answers, total, answered, draftScope, summary,
      crownJewelQuestions, crownJewelAssets, maxCrownJewels: INTAKE.MAX_CROWN_JEWELS,
      requiredAnswered, requiredTotal, readyToConfirm,
      scopeConfirmedAt, scopeConfirmedBy
    });
  });

  // Helper shared by full save, the legacy apply endpoint and scope
  // confirmation. It refreshes the scope and idempotently links crown-jewel
  // answers to asset records with durable lineage.
  function syncCrownJewelAsset(wsId, questionId, rawName) {
    const number = INTAKE.crownJewelNumber(questionId);
    const name = String(rawName || '').trim();
    if (!number || !name) return { status: 'unchanged', assetId: null };

    let asset = db.prepare(`SELECT * FROM assets
      WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref=?`).get(wsId, questionId);
    if (asset) {
      const sameName = db.prepare(`SELECT * FROM assets
        WHERE workspace_id=? AND id<>? AND lower(trim(name))=lower(trim(?)) ORDER BY id LIMIT 1`)
        .get(wsId, asset.id, name);
      if (sameName) {
        db.transaction(() => {
          db.prepare(`UPDATE assets SET source_type=NULL,source_ref=NULL WHERE id=? AND workspace_id=?`).run(asset.id, wsId);
          if (!sameName.source_type && !sameName.source_ref) {
            db.prepare(`UPDATE assets SET source_type='engagement_intake',source_ref=?,
              business_criticality='critical',classification=COALESCE(NULLIF(classification,''),'restricted')
              WHERE id=? AND workspace_id=?`).run(questionId, sameName.id, wsId);
          } else {
            db.prepare(`UPDATE assets SET business_criticality='critical' WHERE id=? AND workspace_id=?`).run(sameName.id, wsId);
          }
        })();
        fts.refresh(wsId, 'asset', sameName.id);
        return { status: 'reused', assetId: Number(sameName.id) };
      }
      if (asset.name !== name || asset.business_criticality !== 'critical') {
        db.prepare(`UPDATE assets SET name=?,business_criticality='critical' WHERE id=? AND workspace_id=?`)
          .run(name, asset.id, wsId);
        fts.refresh(wsId, 'asset', asset.id);
        return { status: 'updated', assetId: Number(asset.id) };
      }
      return { status: 'linked', assetId: Number(asset.id) };
    }

    // Adopt an existing same-name asset rather than creating a duplicate. If
    // another crown-jewel field already points to it, reuse it without moving
    // that field's lineage; changing this field later can then create its own
    // distinct asset.
    asset = db.prepare(`SELECT * FROM assets WHERE workspace_id=? AND lower(trim(name))=lower(trim(?)) ORDER BY id LIMIT 1`)
      .get(wsId, name);
    if (asset) {
      if (!asset.source_type && !asset.source_ref) {
        db.prepare(`UPDATE assets SET source_type='engagement_intake',source_ref=?,
          business_criticality='critical',classification=COALESCE(NULLIF(classification,''),'restricted')
          WHERE id=? AND workspace_id=?`).run(questionId, asset.id, wsId);
      } else {
        db.prepare(`UPDATE assets SET business_criticality='critical' WHERE id=? AND workspace_id=?`).run(asset.id, wsId);
      }
      fts.refresh(wsId, 'asset', asset.id);
      return { status: 'reused', assetId: Number(asset.id) };
    }

    const result = db.prepare(`INSERT INTO assets
      (workspace_id,name,type,classification,cia_c,cia_i,cia_a,description,business_criticality,source_type,source_ref)
      VALUES (?,?,'information','restricted',3,3,3,?,'critical','engagement_intake',?)`)
      .run(wsId, name,
        'Identified as a crown-jewel information asset during client setup. Assign an owner and complete its business-impact and recovery details in the asset register.',
        questionId);
    const assetId = Number(result.lastInsertRowid);
    fts.refresh(wsId, 'asset', assetId);
    return { status: 'created', assetId };
  }

  function detachCrownJewelAsset(wsId, questionId) {
    const asset = db.prepare(`SELECT id FROM assets
      WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref=?`).get(wsId, questionId);
    if (!asset) return { status: 'unchanged', assetId: null };
    db.prepare(`UPDATE assets SET source_type=NULL,source_ref=NULL WHERE id=? AND workspace_id=?`).run(asset.id, wsId);
    return { status: 'retained', assetId: Number(asset.id) };
  }

  function applyIntakeToClient(wsId) {
    const rows = db.prepare(`SELECT question_id, answer FROM engagement_intake WHERE workspace_id=?`).all(wsId);
    const answers = {};
    for (const r of rows) answers[r.question_id] = r.answer || '';
    const scope = INTAKE.draftScopeStatement(answers);
    db.prepare('UPDATE workspaces SET scope=? WHERE id=?').run(scope, wsId);
    // Keep target_cert_date in sync with the cert-deadline intake answer.
    // The two used to drift apart silently - the create dialog set one,
    // the intake form set the other, neither knew about the other.
    const certDeadline = (answers['cert-deadline'] || '').trim();
    if (certDeadline) {
      db.prepare('UPDATE workspaces SET target_cert_date=? WHERE id=?').run(certDeadline, wsId);
    }
    // Interested-parties auto-seed removed: parties get identified during
    // the gap assessment / implementation work on clauses 4.2 + 9.3.2.d
    // rather than as a discrete register populated from intake answers.
    // The key-customers / key-regulators / key-suppliers questions stay
    // in the intake because they're useful business context for the
    // scoping summary - they just no longer write to a separate table.
    const answeredCrownJewels = INTAKE.crownJewelAnswers(answers);
    const answeredCrownIds = new Set(answeredCrownJewels.map(item => item.id));
    const linkedCrownIds = db.prepare(`SELECT source_ref FROM assets
      WHERE workspace_id=? AND source_type='engagement_intake' AND source_ref GLOB 'crown-jewel-[0-9]*'`).all(wsId);
    let retained = 0;
    for (const linked of linkedCrownIds) {
      if (!answeredCrownIds.has(linked.source_ref)) {
        const detached = detachCrownJewelAsset(wsId, linked.source_ref);
        if (detached.status === 'retained') retained++;
      }
    }
    const assetSync = { created: 0, updated: 0, reused: 0, linked: 0, retained };
    for (const item of answeredCrownJewels) {
      const result = syncCrownJewelAsset(wsId, item.id, item.name);
      if (Object.prototype.hasOwnProperty.call(assetSync, result.status)) assetSync[result.status]++;
    }
    return { assetSync };
  }

  app.post('/workspaces/:wsId/intake', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const flat = INTAKE.flatten();
    const insert = db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id, question_id) DO UPDATE SET
        answer=excluded.answer, answered_by=excluded.answered_by, answered_at=CURRENT_TIMESTAMP`);
    const tx = db.transaction(() => {
      for (const q of flat) {
        const v = (req.body[q.id] || '').trim();
        insert.run(req.workspace.id, q.id, v, req.user.id);
      }
      for (const [id, rawValue] of Object.entries(req.body)) {
        const number = INTAKE.crownJewelNumber(id);
        if (!number || number <= 3) continue;
        const value = String(rawValue || '').trim();
        if (value) insert.run(req.workspace.id, id, value, req.user.id);
        else db.prepare(`DELETE FROM engagement_intake WHERE workspace_id=? AND question_id=?`).run(req.workspace.id, id);
      }
    });
    tx();
    // Save now also applies - no more two-step UX. The "Apply to client"
    // button was non-obvious; consultants would save, leave the page, and
    // the scope field on the workspace stayed empty for weeks.
    const applied = applyIntakeToClient(req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'intake_save_apply', 'intake', null, null, auditCtx(req));
    const changedAssets = applied.assetSync.created + applied.assetSync.updated + applied.assetSync.reused;
    const message = changedAssets
      ? `Saved. Scope updated and ${changedAssets} crown-jewel asset${changedAssets === 1 ? '' : 's'} synchronised.`
      : 'Saved. Scope statement and linked assets are up to date.';
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, message));
  });

  // Per-field autosave endpoint. Called from the intake form on field blur
  // / after a short debounce. Crown-jewel answers also write through to the
  // linked asset immediately. Returns JSON for the client-side status cue.
  app.post('/workspaces/:wsId/intake/field', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const id = (req.body.question_id || '').trim();
    const value = (req.body.answer || '').trim();
    const known = INTAKE.flatten().some(q => q.id === id) || !!INTAKE.crownJewelNumber(id);
    if (!known) return res.status(400).json({ ok: false, error: 'unknown question_id' });
    db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id, question_id) DO UPDATE SET
        answer=excluded.answer, answered_by=excluded.answered_by, answered_at=CURRENT_TIMESTAMP`)
      .run(req.workspace.id, id, value, req.user.id);
    let asset = null;
    if (INTAKE.crownJewelNumber(id)) {
      asset = value
        ? syncCrownJewelAsset(req.workspace.id, id, value)
        : detachCrownJewelAsset(req.workspace.id, id);
      if (['created', 'updated', 'reused'].includes(asset.status)) {
        logAction(req.user.id, req.workspace.id, 'sync_intake_asset', 'asset', asset.assetId,
          { question_id: id, status: asset.status }, auditCtx(req));
      }
    }
    res.json({ ok: true, savedAt: new Date().toISOString(), asset });
  });

  // Legacy /apply route - keep for any old links / bookmarks; calls the
  // same helper as Save now. Redirects back to the intake page.
  app.post('/workspaces/:wsId/intake/apply', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    applyIntakeToClient(req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'intake_apply', 'intake', null, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Scope statement applied to client.'));
  });

  // Scope confirmation: explicit sign-off that the auto-drafted scope
  // is good and the engagement is ready to start the gap assessment.
  // Sets a timestamp on workspaces, which then drives the "ready for
  // gap" gate and the "Scope confirmed on <date>" cue on the overview.
  // Idempotent - re-confirming refreshes the timestamp + user.
  app.post('/workspaces/:wsId/scope/confirm', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    // Ensure the latest answers are baked into workspaces.scope before
    // we mark confirmed - otherwise the consultant could confirm an
    // empty scope statement if they hadn't hit Save first.
    applyIntakeToClient(req.workspace.id);
    db.prepare(`UPDATE workspaces SET scope_confirmed_at=CURRENT_TIMESTAMP, scope_confirmed_by=? WHERE id=?`)
      .run(req.user.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'confirm_scope', 'workspace', req.workspace.id, null, auditCtx(req));
    // Land on the team-setup screen first so the manager can assign
    // consultants and invite client-side accounts before the gap assessment
    // begins. From there a primary CTA continues to /gap-assessment.
    res.redirect(withToast(`/workspaces/${req.workspace.id}/team`,
      'Scope confirmed. Now assign the firm consultants and invite the client-side accounts who will work on this engagement.'));
  });

  // Unconfirm - if you realise the scope was wrong and want to redo it
  // before the gap assessment. Doesn't undo any gap-assessment work
  // already done; just clears the sign-off so the banner re-appears.
  app.post('/workspaces/:wsId/scope/unconfirm', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    db.prepare(`UPDATE workspaces SET scope_confirmed_at=NULL, scope_confirmed_by=NULL WHERE id=?`)
      .run(req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'unconfirm_scope', 'workspace', req.workspace.id, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Scope un-confirmed. Edit the answers and re-confirm when ready.'));
  });

  // ---------- ADAPTIVE ENGAGEMENT DELIVERY ----------
  const planUrl = wsId => `/workspaces/${wsId}/engagement-plan`;
  const planUser = (ws, id) => !id || db.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.active=1 AND
    ((u.firm_id=? AND u.user_type='firm') OR u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id=?))`).get(id, ws.firm_id, ws.id);
  const clientPresentation = req => {
    const visible = !!req.body.client_visible;
    const clientTitle = String(req.body.client_title || '').trim();
    const clientDescription = String(req.body.client_description || '').trim();
    const frameworkCode = String(req.body.framework_code || 'iso27001').trim().toLowerCase();
    const requirementRefs = String(req.body.requirement_refs || '').trim();
    const enabled = new Set([...(Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : []), 'iso27001']);
    if (visible && !clientTitle) throw new Error('A client-facing title is required for a client-visible deliverable.');
    if (visible && !clientDescription) throw new Error('Client instructions are required for a client-visible deliverable.');
    if (!enabled.has(frameworkCode)) throw new Error('Choose a framework enabled for this engagement.');
    return { visible, clientTitle: clientTitle || null, clientDescription: clientDescription || null, frameworkCode, requirementRefs: requirementRefs || null };
  };
  const runPlanAction = (req, res, action, success) => {
    try {
      const result = action();
      return res.redirect(withToast(planUrl(req.workspace.id), success || 'Delivery plan updated.'));
    } catch (error) {
      return res.redirect(withToast(planUrl(req.workspace.id), error.message || 'Could not update the delivery plan.', 'error'));
    }
  };

  app.get('/workspaces/:wsId/engagement-plan', requireAuth, requireWorkspace, (req, res) => {
    const projection = delivery.getProjection(db, req.workspace, req.user.id);
    const view = ['plan','timeline','gates'].includes(req.query.view) ? req.query.view : 'plan';
    const users = db.prepare(`SELECT id,name FROM users WHERE active=1 AND (
      (firm_id=? AND user_type='firm') OR id IN (SELECT user_id FROM workspace_members WHERE workspace_id=?)) ORDER BY name`)
      .all(req.workspace.firm_id, req.workspace.id);
    const baselines = db.prepare(`SELECT b.id,b.version_number,b.label,b.reason,b.approved_at,u.name approved_by_name
      FROM engagement_delivery_baselines b LEFT JOIN users u ON u.id=b.approved_by WHERE b.plan_id=? ORDER BY b.version_number DESC`).all(projection.plan.id);
    const events = db.prepare(`SELECT e.*,u.name actor_name FROM engagement_delivery_events e LEFT JOIN users u ON u.id=e.actor_id
      WHERE e.plan_id=? ORDER BY e.id DESC LIMIT 25`).all(projection.plan.id);
    const evidence = db.prepare(`SELECT de.deliverable_id,e.id,e.filename,e.sha256,e.uploaded_at,u.name uploaded_by_name
      FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id LEFT JOIN users u ON u.id=e.uploaded_by
      WHERE de.workspace_id=? ORDER BY de.id DESC`).all(req.workspace.id);
    const comments = db.prepare(`SELECT c.*,u.name user_name FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.workspace_id=? AND c.parent_type='engagement_deliverable' ORDER BY c.id`).all(req.workspace.id)
      .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
    const evidenceCatalog = db.prepare(`SELECT id,filename,description,uploaded_at FROM evidence WHERE workspace_id=? AND superseded_at IS NULL ORDER BY uploaded_at DESC,id DESC LIMIT 100`).all(req.workspace.id);
    const workQueue = {
      mine: projection.deliverables.filter(d => d.owner_id === req.user.id && !['accepted','superseded'].includes(d.status)).length,
      approvals: projection.deliverables.filter(d => d.approver_id === req.user.id && ['submitted','workspace_verified'].includes(d.effective_status)).length,
      overdue: projection.deliverables.filter(d => d.due_date && d.due_date < new Date().toISOString().slice(0,10) && !['accepted','superseded'].includes(d.status)).length,
      unassigned: projection.phases.filter(p => !p.owner_id).length
        + projection.milestones.filter(m => !m.owner_id).length
        + projection.deliverables.filter(d => !d.owner_id).length
        + projection.deliverables.filter(d => !d.approver_id).length
    };
    res.render('engagement_plan', {
      user: req.user, ws: req.workspace, ...projection, users, baselines, events, evidence, evidenceCatalog, comments, workQueue, view
    });
  });

  app.post('/workspaces/:wsId/engagement-plan/settings', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      if (req.body.status === 'completed') {
        const projection = delivery.getProjection(db, req.workspace, req.user.id);
        if (!projection.summary.completionReady || projection.summary.openBlockers) {
          throw new Error('The engagement cannot be completed until every required phase gate passes and all critical blockers are closed.');
        }
      }
      const result = db.prepare(`UPDATE engagement_delivery_plans SET name=?,objective=?,status=?,target_start_date=?,
        target_completion_date=?,forecast_completion_date=?,completion_criteria=?,updated_at=datetime('now')
        WHERE id=? AND workspace_id=? AND updated_at=?`).run(
          String(req.body.name || '').trim() || 'ISO 27001 delivery plan', req.body.objective || null,
          req.body.status || 'active', req.body.target_start_date || null, req.body.target_completion_date || null,
          req.body.forecast_completion_date || null, req.body.completion_criteria || null,
          plan.id, req.workspace.id, req.body.updated_at_snapshot);
      if (!result.changes) throw new Error('The plan changed in another session. Reload and apply your update again.');
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'plan', plan.id, 'updated', null, req.body.status || 'active', null);
      logAction(req.user.id, req.workspace.id, 'update_delivery_plan', 'engagement_plan', plan.id, null, auditCtx(req));
    }, 'Plan settings updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/baselines', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    runPlanAction(req, res, () => {
      const id = delivery.createBaseline(db, req.workspace, req.user.id, req.body.label, req.body.reason);
      logAction(req.user.id, req.workspace.id, 'approve_delivery_baseline', 'engagement_baseline', id, { reason: req.body.reason }, auditCtx(req));
    }, 'A new approved baseline was frozen.');
  });

  app.post('/workspaces/:wsId/engagement-plan/phases/:phaseId', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      const result = db.prepare(`UPDATE engagement_delivery_phases SET owner_id=?,planned_start_date=?,planned_end_date=?,forecast_end_date=?,updated_at=datetime('now')
        WHERE id=? AND plan_id=?`).run(req.body.owner_id || null, req.body.planned_start_date || null,
          req.body.planned_end_date || null, req.body.forecast_end_date || null, req.params.phaseId, plan.id);
      if (!result.changes) throw new Error('Phase not found.');
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'phase', req.params.phaseId, 'schedule_updated', null, null, req.body);
      logAction(req.user.id, req.workspace.id, 'update_delivery_phase', 'engagement_phase', req.params.phaseId, null, auditCtx(req));
    }, 'Phase schedule updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/phases/:phaseId/gate', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    runPlanAction(req, res, () => {
      const id = delivery.decideGate(db, req.workspace, req.user.id, req.params.phaseId, req.body.decision, req.body.note, req.body.waiver_expires_at);
      logAction(req.user.id, req.workspace.id, 'decide_delivery_gate', 'engagement_phase', req.params.phaseId,
        { decision_id: id, decision: req.body.decision, note: req.body.note }, auditCtx(req));
    }, req.body.decision === 'reopened' ? 'Phase gate reopened.' : 'Phase-gate decision recorded.');
  });

  app.post('/workspaces/:wsId/engagement-plan/milestones', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      const phase = db.prepare('SELECT id FROM engagement_delivery_phases WHERE id=? AND plan_id=?').get(req.body.phase_id, plan.id);
      if (!phase || !String(req.body.title || '').trim()) throw new Error('A valid phase and milestone title are required.');
      const key = `custom-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
      const id = db.prepare(`INSERT INTO engagement_delivery_milestones
        (plan_id,phase_id,milestone_key,title,description,acceptance_criteria,priority,is_required,completion_mode,owner_id,planned_start_date,planned_end_date,forecast_end_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(plan.id, phase.id, key, req.body.title.trim(), req.body.description || null,
          req.body.acceptance_criteria || null, req.body.priority || 'normal', req.body.is_required ? 1 : 0,
          req.body.completion_mode || 'deliverable', req.body.owner_id || null, req.body.planned_start_date || null,
          req.body.planned_end_date || null, req.body.forecast_end_date || req.body.planned_end_date || null).lastInsertRowid;
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'milestone', id, 'created', null, 'not_started', { title: req.body.title });
      logAction(req.user.id, req.workspace.id, 'create_delivery_milestone', 'engagement_milestone', id, { title: req.body.title }, auditCtx(req));
      delivery.recalculateSchedule(db, req.workspace, req.user.id, 'milestone_created');
    }, 'Milestone added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/milestones/:milestoneId', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      const result = db.prepare(`UPDATE engagement_delivery_milestones SET title=?,description=?,acceptance_criteria=?,priority=?,is_required=?,owner_id=?,planned_start_date=?,planned_end_date=?,forecast_end_date=?,updated_at=datetime('now'),row_version=row_version+1
        WHERE id=? AND plan_id=? AND row_version=?`).run(req.body.title, req.body.description || null, req.body.acceptance_criteria || null,
          req.body.priority || 'normal', req.body.is_required ? 1 : 0, req.body.owner_id || null,
          req.body.planned_start_date || null, req.body.planned_end_date || null, req.body.forecast_end_date || null,
          req.params.milestoneId, plan.id, req.body.row_version);
      if (!result.changes) throw new Error('This milestone changed in another session. Reload before saving.');
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'milestone', req.params.milestoneId, 'updated', null, null, null);
      logAction(req.user.id, req.workspace.id, 'update_delivery_milestone', 'engagement_milestone', req.params.milestoneId, null, auditCtx(req));
      delivery.recalculateSchedule(db, req.workspace, req.user.id, 'milestone_updated');
    }, 'Milestone updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      const milestone = db.prepare('SELECT id FROM engagement_delivery_milestones WHERE id=? AND plan_id=?').get(req.body.milestone_id, plan.id);
      if (!milestone || !String(req.body.title || '').trim()) throw new Error('A milestone and deliverable title are required.');
      if (!planUser(req.workspace, req.body.owner_id) || !planUser(req.workspace, req.body.approver_id)) throw new Error('Owner and approver must belong to this engagement.');
      const presentation = clientPresentation(req);
      const id = db.prepare(`INSERT INTO engagement_delivery_deliverables
        (workspace_id,plan_id,milestone_id,title,description,acceptance_criteria,client_title,client_description,framework_code,requirement_refs,
         is_required,owner_id,approver_id,due_date,linked_record_type,linked_record_id,client_visible,requires_evidence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.workspace.id, plan.id, milestone.id, req.body.title.trim(), req.body.description || null,
          req.body.acceptance_criteria || null, presentation.clientTitle, presentation.clientDescription, presentation.frameworkCode, presentation.requirementRefs,
          req.body.is_required ? 1 : 0, req.body.owner_id || null,
          req.body.approver_id || null, req.body.due_date || null, req.body.linked_record_type || null,
          req.body.linked_record_id || null, presentation.visible ? 1 : 0, req.body.requires_evidence ? 1 : 0).lastInsertRowid;
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'deliverable', id, 'created', null, 'draft', { title: req.body.title });
      logAction(req.user.id, req.workspace.id, 'create_delivery_deliverable', 'engagement_deliverable', id, { title: req.body.title }, auditCtx(req));
    }, 'Deliverable added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      if (!planUser(req.workspace, req.body.owner_id) || !planUser(req.workspace, req.body.approver_id)) throw new Error('Owner and approver must belong to this engagement.');
      const presentation = clientPresentation(req);
      const result = db.prepare(`UPDATE engagement_delivery_deliverables SET title=?,description=?,acceptance_criteria=?,client_title=?,client_description=?,
        framework_code=?,requirement_refs=?,is_required=?,owner_id=?,approver_id=?,due_date=?,client_visible=?,requires_evidence=?,updated_at=datetime('now'),row_version=row_version+1
        WHERE id=? AND plan_id=? AND workspace_id=? AND row_version=?`).run(
        String(req.body.title || '').trim(), req.body.description || null, req.body.acceptance_criteria || null,
        presentation.clientTitle, presentation.clientDescription, presentation.frameworkCode, presentation.requirementRefs,
        req.body.is_required ? 1 : 0, req.body.owner_id || null, req.body.approver_id || null,
        req.body.due_date || null, presentation.visible ? 1 : 0, req.body.requires_evidence ? 1 : 0,
        req.params.deliverableId, plan.id, req.workspace.id, req.body.row_version);
      if (!result.changes) throw new Error('This deliverable changed in another session. Reload before saving.');
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'deliverable', req.params.deliverableId, 'updated', null, null, null);
      logAction(req.user.id, req.workspace.id, 'update_delivery_deliverable', 'engagement_deliverable', req.params.deliverableId, null, auditCtx(req));
    }, 'Deliverable updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/submit', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    runPlanAction(req, res, () => {
      delivery.transitionDeliverable(db, req.workspace, req.user.id, Number(req.params.deliverableId), 'submit', req.body.note);
      logAction(req.user.id, req.workspace.id, 'submit_delivery_deliverable', 'engagement_deliverable', req.params.deliverableId, null, auditCtx(req));
    }, 'Deliverable submitted for sign-off.');
  });

  ['accept','changes','reject'].forEach(action => {
    app.post(`/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/${action}`, requireAuth, requireWorkspace, requirePermission('document.approve'), (req, res) => {
      runPlanAction(req, res, () => {
        delivery.transitionDeliverable(db, req.workspace, req.user.id, Number(req.params.deliverableId), action, req.body.note);
        logAction(req.user.id, req.workspace.id, `${action}_delivery_deliverable`, 'engagement_deliverable', req.params.deliverableId, { note: req.body.note }, auditCtx(req));
      }, action === 'accept' ? 'Deliverable accepted and milestone progress reconciled.' : 'Deliverable decision recorded.');
    });
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/revise', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    runPlanAction(req, res, () => {
      delivery.reviseDeliverable(db, req.workspace, req.user.id, Number(req.params.deliverableId), req.body.note);
      logAction(req.user.id, req.workspace.id, 'revise_delivery_deliverable', 'engagement_deliverable', req.params.deliverableId, { note: req.body.note }, auditCtx(req));
    }, 'A new deliverable revision is open.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/comments', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    runPlanAction(req, res, () => {
      const row = db.prepare(`SELECT d.id,d.plan_id FROM engagement_delivery_deliverables d WHERE d.id=? AND d.workspace_id=?`).get(req.params.deliverableId, req.workspace.id);
      const body = String(req.body.body || '').trim();
      if (!row || !body || body.length > 8000) throw new Error('A comment under 8,000 characters is required.');
      const encrypted = enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled);
      db.prepare(`INSERT INTO comments (workspace_id,parent_type,parent_id,user_id,body,internal_only) VALUES (?,'engagement_deliverable',?,?,?,?)`)
        .run(req.workspace.id, String(row.id), req.user.id, encrypted, req.body.internal_only && req.user.user_type === 'firm' ? 1 : 0);
      delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'commented', null, null, { internal: !!req.body.internal_only });
      logAction(req.user.id, req.workspace.id, 'comment_delivery_deliverable', 'engagement_deliverable', row.id, { internal: !!req.body.internal_only }, auditCtx(req));
    }, 'Comment added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/evidence', requireAuth, requireWorkspace,
    requirePermission('evidence.upload'), upload.single('file'), (req, res) => {
      const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_) {} };
      try {
        const row = db.prepare(`SELECT d.id,d.plan_id,d.title FROM engagement_delivery_deliverables d WHERE d.id=? AND d.workspace_id=?`).get(req.params.deliverableId, req.workspace.id);
        if (!row || !req.file) throw new Error(!row ? 'Deliverable not found.' : 'Choose a file to upload.');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
        let evidenceId;
        let deduped = false;
        db.transaction(() => {
          const existing = db.prepare(`SELECT id FROM evidence WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
          if (existing) { evidenceId = existing.id; deduped = true; cleanup(); }
          else evidenceId = db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description,tags) VALUES (?,?,?,?,?,?,?,?)`)
            .run(req.workspace.id, req.file.originalname, req.file.filename, sha, req.file.size, req.user.id,
              String(req.body.description || '').trim() || row.title, `engagement-plan, deliverable-${row.id}`).lastInsertRowid;
          db.prepare(`INSERT OR IGNORE INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`)
            .run(req.workspace.id, row.id, evidenceId, req.user.id);
          delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'evidence_linked', null, null, { evidenceId, sha, deduped });
        })();
        logAction(req.user.id, req.workspace.id, deduped ? 'link_existing_delivery_evidence' : 'upload_delivery_evidence', 'engagement_deliverable', row.id, { evidence_id: evidenceId, sha256: sha }, auditCtx(req));
        return res.redirect(withToast(planUrl(req.workspace.id), deduped ? 'Existing evidence linked.' : 'Evidence uploaded and linked.'));
      } catch (error) {
        cleanup();
        return res.redirect(withToast(planUrl(req.workspace.id), error.message || 'Could not upload evidence.', 'error'));
      }
    });

  app.post('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/evidence/link', requireAuth, requireWorkspace, requirePermission('evidence.upload'), (req, res) => {
    runPlanAction(req, res, () => {
      const row = db.prepare(`SELECT id,plan_id FROM engagement_delivery_deliverables WHERE id=? AND workspace_id=?`).get(req.params.deliverableId, req.workspace.id);
      const evidenceRow = db.prepare(`SELECT id,sha256 FROM evidence WHERE id=? AND workspace_id=? AND superseded_at IS NULL`).get(req.body.evidence_id, req.workspace.id);
      if (!row || !evidenceRow) throw new Error('Choose an evidence record from this workspace.');
      db.prepare(`INSERT OR IGNORE INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`).run(req.workspace.id,row.id,evidenceRow.id,req.user.id);
      delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'existing_evidence_linked', null, null, { evidenceId: evidenceRow.id, sha: evidenceRow.sha256 });
      logAction(req.user.id, req.workspace.id, 'link_existing_delivery_evidence', 'engagement_deliverable', row.id, { evidence_id: evidenceRow.id }, auditCtx(req));
    }, 'Existing evidence linked.');
  });

  app.get('/workspaces/:wsId/engagement-plan/deliverables/:deliverableId/evidence/:evidenceId/download', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const row = db.prepare(`SELECT e.* FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id
      WHERE de.deliverable_id=? AND de.evidence_id=? AND de.workspace_id=? AND e.workspace_id=?`).get(req.params.deliverableId, req.params.evidenceId, req.workspace.id, req.workspace.id);
    if (!row) return res.status(404).send('Evidence not found');
    const filePath = resolveUploadPath(row.stored_path, req.workspace.firm_id);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Evidence file missing');
    logAction(req.user.id, req.workspace.id, 'download_delivery_evidence', 'evidence', row.id, { deliverable_id: req.params.deliverableId }, auditCtx(req));
    res.download(filePath, row.filename);
  });

  app.post('/workspaces/:wsId/engagement-plan/dependencies', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const id = delivery.addDependency(db, req.workspace, req.user.id, Number(req.body.predecessor_id), Number(req.body.successor_id), req.body.dependency_type, req.body.lag_days);
      logAction(req.user.id, req.workspace.id, 'create_delivery_dependency', 'engagement_dependency', id, null, auditCtx(req));
      delivery.recalculateSchedule(db, req.workspace, req.user.id, 'dependency_created');
    }, 'Dependency added.');
  });

  app.post('/workspaces/:wsId/engagement-plan/dependencies/:dependencyId/delete', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      const result = db.prepare('DELETE FROM engagement_delivery_dependencies WHERE id=? AND plan_id=?').run(req.params.dependencyId, plan.id);
      if (!result.changes) throw new Error('Dependency not found.');
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'dependency', req.params.dependencyId, 'deleted', 'active', null, null);
      logAction(req.user.id, req.workspace.id, 'delete_delivery_dependency', 'engagement_dependency', req.params.dependencyId, null, auditCtx(req));
    }, 'Dependency removed.');
  });

  app.post('/workspaces/:wsId/engagement-plan/recalculate', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const result = delivery.recalculateSchedule(db, req.workspace, req.user.id, 'manual');
      logAction(req.user.id, req.workspace.id, 'recalculate_delivery_schedule', 'engagement_plan', null, result, auditCtx(req));
    }, 'Dependencies applied and the forecast recalculated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/fit-target', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const result = delivery.fitScheduleToTarget(db, req.workspace, req.user.id);
      logAction(req.user.id, req.workspace.id, 'fit_delivery_schedule_to_target', 'engagement_plan', null, result, auditCtx(req));
    }, 'Initial milestone durations fitted to the target window.');
  });

  app.post('/workspaces/:wsId/engagement-plan/bulk-assign', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      const ownerId = req.body.owner_id || null;
      const deliverableOwnerId = req.body.deliverable_owner_id || null;
      const approverId = req.body.approver_id || null;
      if (!planUser(req.workspace, ownerId) || !planUser(req.workspace, deliverableOwnerId) || !planUser(req.workspace, approverId)) throw new Error('Owners and approver must belong to this engagement.');
      const onlyUnassigned = req.body.only_unassigned ? 1 : 0;
      const phases = ownerId ? db.prepare(`UPDATE engagement_delivery_phases SET owner_id=?,updated_at=datetime('now') WHERE plan_id=? ${onlyUnassigned ? 'AND owner_id IS NULL' : ''}`).run(ownerId, plan.id).changes : 0;
      const milestones = ownerId ? db.prepare(`UPDATE engagement_delivery_milestones SET owner_id=?,updated_at=datetime('now'),row_version=row_version+1 WHERE plan_id=? ${onlyUnassigned ? 'AND owner_id IS NULL' : ''}`).run(ownerId, plan.id).changes : 0;
      const deliverableOwners = deliverableOwnerId ? db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,updated_at=datetime('now'),row_version=row_version+1 WHERE plan_id=? ${onlyUnassigned ? 'AND owner_id IS NULL' : ''}`).run(deliverableOwnerId, plan.id).changes : 0;
      const deliverableApprovers = approverId ? db.prepare(`UPDATE engagement_delivery_deliverables SET approver_id=?,updated_at=datetime('now'),row_version=row_version+1 WHERE plan_id=? ${onlyUnassigned ? 'AND approver_id IS NULL' : ''}`).run(approverId, plan.id).changes : 0;
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'plan', plan.id, 'bulk_assigned', null, null, { phases, milestones, deliverableOwners, deliverableApprovers, ownerId, deliverableOwnerId, approverId, onlyUnassigned: !!onlyUnassigned });
      logAction(req.user.id, req.workspace.id, 'bulk_assign_delivery_plan', 'engagement_plan', plan.id, { phases, milestones, deliverable_owners: deliverableOwners, deliverable_approvers: deliverableApprovers, owner_id: ownerId, deliverable_owner_id: deliverableOwnerId, approver_id: approverId }, auditCtx(req));
    }, 'Plan assignments updated.');
  });

  app.post('/workspaces/:wsId/engagement-plan/create-tasks', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    runPlanAction(req, res, () => {
      const plan = delivery.ensurePlan(db, req.workspace, req.user.id);
      const milestones = db.prepare(`SELECT m.* FROM engagement_delivery_milestones m WHERE m.plan_id=? AND m.status NOT IN ('complete','waived')
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id=? AND t.engagement_milestone_id=m.id AND t.status NOT IN ('done','closed','cancelled'))`).all(plan.id, req.workspace.id);
      const insert = db.prepare(`INSERT INTO tasks (workspace_id,title,description,assignee_id,due_date,status,created_by,priority,engagement_milestone_id)
        VALUES (?,?,?,?,?,'todo',?,?,?)`);
      const tx = db.transaction(() => milestones.forEach(m => insert.run(req.workspace.id, m.title,
        m.acceptance_criteria || m.description || 'Complete the plan milestone and retain accepted deliverables.',
        m.owner_id || null, m.forecast_end_date || m.planned_end_date || null, req.user.id, m.priority || 'normal', m.id)));
      tx();
      delivery.event(db, req.workspace.id, plan.id, req.user.id, 'plan', plan.id, 'tasks_created', null, null, { count: milestones.length });
      logAction(req.user.id, req.workspace.id, 'create_delivery_plan_tasks', 'engagement_plan', plan.id, { count: milestones.length }, auditCtx(req));
    }, 'Missing milestone tasks created and linked.');
  });

  app.get('/workspaces/:wsId/engagement-plan/export.csv', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const projection = delivery.getProjection(db, req.workspace, req.user.id);
    const esc = value => value == null ? '' : `"${String(value).replace(/"/g, '""')}"`;
    const lines = ['Phase,Milestone,Milestone status,Owner,Priority,Planned start,Planned finish,Forecast finish,Baseline finish,Variance days,Critical path,Deliverable,Deliverable status,Approver,Due,Evidence files,Client visible'];
    projection.phases.forEach(phase => phase.milestones.forEach(m => m.deliverables.forEach(d => lines.push([
      phase.name,m.title,m.effective_status,m.owner_name,m.priority,m.planned_start_date,m.planned_end_date,m.forecast_end_date,
      m.baseline_end_date,m.baseline_variance_days,m.critical_path ? 'Yes' : 'No',d.title,d.effective_status,d.approver_name,d.due_date,d.evidence_count,d.client_visible ? 'Yes' : 'No'
    ].map(esc).join(',')))));
    logAction(req.user.id, req.workspace.id, 'export_delivery_plan_csv', 'engagement_plan', projection.plan.id, null, auditCtx(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="engagement-plan-${req.workspace.client_name.replace(/[^\w-]+/g,'_')}.csv"`);
    res.send(lines.join('\n'));
  });

  app.get('/workspaces/:wsId/engagement-plan/report.pdf', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    try {
      const projection = delivery.getProjection(db, req.workspace, req.user.id);
      const h = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const rows = projection.phases.map((phase, index) => `<section><h2>${index + 1}. ${h(phase.name)} <small>${h(phase.effective_status.replaceAll('_',' '))}</small></h2><p>${h(phase.description)}</p><table><thead><tr><th>Milestone</th><th>Owner</th><th>Status</th><th>Forecast</th><th>Acceptance</th></tr></thead><tbody>${phase.milestones.map(m => `<tr><td>${h(m.title)}${m.critical_path ? '<br><em>Critical path</em>' : ''}</td><td>${h(m.owner_name || 'Unassigned')}</td><td>${h(m.effective_status.replaceAll('_',' '))}</td><td>${h(m.forecast_end_date || m.planned_end_date || 'Unscheduled')}</td><td>${h(m.deliverables.map(d => `${d.title}: ${d.status}`).join('; '))}</td></tr>`).join('')}</tbody></table></section>`).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:11px Arial;color:#17252b}h1{font-size:26px}h2{font-size:16px;margin:22px 0 3px;border-bottom:1px solid #ccd5d8;padding-bottom:5px}small{float:right;text-transform:uppercase;color:#667}p{color:#58666b}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #d9e0e2;padding:6px;text-align:left;vertical-align:top}th{background:#eef2f3;font-size:9px;text-transform:uppercase}em{font-size:9px;color:#9a3412}.kpis{display:flex;gap:24px;padding:12px;background:#eef2f3}.kpis strong{font-size:18px;display:block}</style></head><body><h1>${h(projection.plan.name)}</h1><p>${h(req.workspace.brand_display_name || req.workspace.client_name)} · Generated ${new Date().toISOString().slice(0,10)} · Confidential</p><div class="kpis"><div><strong>${projection.summary.progressPct}%</strong>progress</div><div><strong>${projection.summary.phaseGatesPassed}/${projection.summary.phaseGatesTotal}</strong>gates</div><div><strong>${projection.summary.acceptedDeliverables}/${projection.summary.requiredDeliverables}</strong>accepted</div><div><strong>${projection.summary.varianceDays == null ? '—' : projection.summary.varianceDays + 'd'}</strong>variance</div></div>${rows}</body></html>`;
      const raw = await auditPack.renderPDF(html, { headerLeft: req.workspace.client_name, headerRight: 'Engagement delivery plan', footerLeft: 'Confidential · Controlled delivery record' });
      const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      logAction(req.user.id, req.workspace.id, 'export_delivery_plan_pdf', 'engagement_plan', projection.plan.id, { bytes: pdf.length }, auditCtx(req));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="engagement-plan-${req.workspace.client_name.replace(/[^\w-]+/g,'_')}.pdf"`);
      res.send(pdf);
    } catch (error) {
      res.status(500).render('error', { user: req.user, ws: req.workspace, message: 'Could not generate the delivery report: ' + error.message });
    }
  });
}

module.exports = { register };
