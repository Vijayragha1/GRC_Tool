// Engagement routes: kickoff intake (25-question scoping questionnaire) and
// the 12-week project plan. Both are workspace-scoped read/write - they read
// from data/intake-questions.js and data/engagement-plan.js for templates,
// and persist per-workspace state in engagement_intake and
// engagement_plan_progress.

const INTAKE = require('../data/intake-questions');
const ENG_PLAN = require('../data/engagement-plan');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, withToast, logAction, auditCtx } = deps;

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
      requiredAnswered, requiredTotal, readyToConfirm,
      scopeConfirmedAt, scopeConfirmedBy
    });
  });

  // Helper - extracted so both /intake (save) and /intake/apply (legacy)
  // and the per-field autosave endpoint all run the same scope-and-parties
  // sync. Idempotent: existing parties are de-duped by name; the scope
  // statement is regenerated each time from the latest answers.
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
    return {};
  }

  app.post('/workspaces/:wsId/intake', requireAuth, requireWorkspace, (req, res) => {
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
    });
    tx();
    // Save now also applies - no more two-step UX. The "Apply to client"
    // button was non-obvious; consultants would save, leave the page, and
    // the scope field on the workspace stayed empty for weeks.
    applyIntakeToClient(req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'intake_save_apply', 'intake', null, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Saved. Scope statement updated.'));
  });

  // Per-field autosave endpoint. Called from the intake form on field blur
  // / after a short debounce. Persists one answer, no redirects, no parties
  // sync (parties only refresh when the full Save runs). 200 JSON for the
  // client-side fetch.
  app.post('/workspaces/:wsId/intake/field', requireAuth, requireWorkspace, (req, res) => {
    const id = (req.body.question_id || '').trim();
    const value = (req.body.answer || '').trim();
    const known = INTAKE.flatten().some(q => q.id === id);
    if (!known) return res.status(400).json({ ok: false, error: 'unknown question_id' });
    db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id, question_id) DO UPDATE SET
        answer=excluded.answer, answered_by=excluded.answered_by, answered_at=CURRENT_TIMESTAMP`)
      .run(req.workspace.id, id, value, req.user.id);
    res.json({ ok: true, savedAt: new Date().toISOString() });
  });

  // Legacy /apply route - keep for any old links / bookmarks; calls the
  // same helper as Save now. Redirects back to the intake page.
  app.post('/workspaces/:wsId/intake/apply', requireAuth, requireWorkspace, (req, res) => {
    applyIntakeToClient(req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'intake_apply', 'intake', null, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Scope statement applied to client.'));
  });

  // Scope confirmation: explicit sign-off that the auto-drafted scope
  // is good and the engagement is ready to start the gap assessment.
  // Sets a timestamp on workspaces, which then drives the "ready for
  // gap" gate and the "Scope confirmed on <date>" cue on the overview.
  // Idempotent - re-confirming refreshes the timestamp + user.
  app.post('/workspaces/:wsId/scope/confirm', requireAuth, requireWorkspace, (req, res) => {
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
  app.post('/workspaces/:wsId/scope/unconfirm', requireAuth, requireWorkspace, (req, res) => {
    db.prepare(`UPDATE workspaces SET scope_confirmed_at=NULL, scope_confirmed_by=NULL WHERE id=?`)
      .run(req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'unconfirm_scope', 'workspace', req.workspace.id, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Scope un-confirmed. Edit the answers and re-confirm when ready.'));
  });

  // ---------- 12-WEEK ENGAGEMENT PLAN ----------
  app.get('/workspaces/:wsId/engagement-plan', requireAuth, requireWorkspace, (req, res) => {
    const progress = db.prepare(`SELECT milestone_id, completed_at, target_date, notes FROM engagement_plan_progress WHERE workspace_id=?`)
      .all(req.workspace.id);
    const byId = {};
    for (const r of progress) byId[r.milestone_id] = r;
    const phases = ENG_PLAN.PHASES.map(ph => ({
      ...ph,
      milestones: ph.milestones.map(m => ({ ...m, ...(byId[m.id] || {}) })),
    }));
    const total = ENG_PLAN.flatten().length;
    const done = progress.filter(p => p.completed_at).length;
    res.render('engagement_plan', {
      user: req.user, ws: req.workspace, phases, total, done,
    });
  });

  app.post('/workspaces/:wsId/engagement-plan/:milestoneId/toggle', requireAuth, requireWorkspace, (req, res) => {
    const mid = req.params.milestoneId;
    // Guard: only known milestone IDs from the template can be toggled. Stops
    // arbitrary upserts from crafted POST bodies.
    const known = ENG_PLAN.flatten().some(m => m.id === mid);
    if (!known) return res.status(400).send('Unknown milestone');
    const existing = db.prepare(`SELECT completed_at FROM engagement_plan_progress WHERE workspace_id=? AND milestone_id=?`)
      .get(req.workspace.id, mid);
    if (existing && existing.completed_at) {
      db.prepare(`UPDATE engagement_plan_progress SET completed_at=NULL WHERE workspace_id=? AND milestone_id=?`)
        .run(req.workspace.id, mid);
    } else {
      db.prepare(`INSERT INTO engagement_plan_progress (workspace_id, milestone_id, completed_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(workspace_id, milestone_id) DO UPDATE SET completed_at=CURRENT_TIMESTAMP`)
        .run(req.workspace.id, mid);
    }
    res.redirect(`/workspaces/${req.workspace.id}/engagement-plan`);
  });
}

module.exports = { register };
