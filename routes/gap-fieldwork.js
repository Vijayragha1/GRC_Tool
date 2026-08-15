'use strict';

const fieldwork = require('../lib/gap-fieldwork');
const { withToast, auditCtx } = require('../lib/http-helpers');

const INTERVIEW_STATUSES = new Set(['scheduled', 'completed', 'rescheduled', 'cancelled']);
const BLOCKER_STATUSES = new Set(['open', 'resolved', 'accepted_risk']);
const PHASES = new Set(['mobilisation', 'fieldwork', 'validation', 'post_report']);

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;
  const base = workspaceId => `/workspaces/${workspaceId}/gap-assessment/fieldwork`;
  const firmOnly = (req, res, next) => req.user.user_type === 'firm'
    ? next() : res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'This fieldwork workspace is restricted to the engagement team.' });
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
  const scheduledAt = value => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(value || '')) ? String(value) : null;
  const visible = value => value === '1' ? 1 : 0;
  const redirectError = (req, res, message) => res.redirect(withToast(base(req.workspace.id), message, 'error'));

  function currentPassOrError(req) {
    return fieldwork.latestPass(db, req.workspace.id);
  }

  function workspaceUser(req, id) {
    if (!id) return null;
    return db.prepare(`SELECT u.id FROM users u LEFT JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
      WHERE u.id=? AND u.active=1 AND ((u.user_type='firm' AND u.firm_id=?) OR wm.workspace_id=?)`).get(
      req.workspace.id, Number(id), req.workspace.firm_id, req.workspace.id);
  }

  app.get('/workspaces/:wsId/gap-assessment/fieldwork', requireAuth, requireWorkspace, firmOnly, (req, res) => {
    const context = fieldwork.assessmentContext(db, req.workspace);
    const users = db.prepare(`SELECT DISTINCT u.id,u.name,u.user_type FROM users u
      LEFT JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
      WHERE u.active=1 AND ((u.user_type='firm' AND u.firm_id=?) OR wm.workspace_id=?)
      ORDER BY u.user_type DESC,u.name`).all(req.workspace.id, req.workspace.firm_id, req.workspace.id);
    const requirements = db.prepare(`SELECT r.id,r.ref,r.title,r.sort_order FROM requirements r
      JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001' ORDER BY r.sort_order,r.id`).all();
    res.render('gap_fieldwork', {
      user: req.user, ws: req.workspace, active: 'gap-assessment', title: 'Gap assessment fieldwork',
      context, users, requirements
    });
  });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/interviews', requireAuth, requireWorkspace, firmOnly,
    requirePermission('control.update'), (req, res) => {
      const pass = currentPassOrError(req);
      if (!pass) return redirectError(req, res, 'Start an assessment pass before scheduling interviews.');
      const title = clean(req.body.title, 220);
      const role = clean(req.body.participant_role, 180);
      const when = scheduledAt(req.body.scheduled_at);
      const duration = req.body.duration_minutes ? Number(req.body.duration_minutes) : null;
      if (!title || !role || !when) return redirectError(req, res, 'Interview title, participant role and scheduled date are required.');
      if (duration != null && (!Number.isInteger(duration) || duration < 5 || duration > 480)) return redirectError(req, res, 'Interview duration must be between 5 and 480 minutes.');
      const owner = workspaceUser(req, req.body.owner_id);
      const result = db.prepare(`INSERT INTO gap_fieldwork_interviews
        (workspace_id,assessment_pass_id,title,objective,participant_role,owner_id,scheduled_at,duration_minutes,client_visible,created_by,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          req.workspace.id, pass.id, title, clean(req.body.objective, 5000) || null, role,
          owner?.id || null, when, duration, visible(req.body.client_visible), req.user.id, req.user.id);
      logAction(req.user.id, req.workspace.id, 'schedule_gap_interview', 'gap_fieldwork_interview', result.lastInsertRowid,
        { assessment_pass_id: pass.id, scheduled_at: when }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Interview added to the governed schedule.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/interviews/:id/status', requireAuth, requireWorkspace, firmOnly,
    requirePermission('control.update'), (req, res) => {
      const status = String(req.body.status || '');
      const version = Number(req.body.row_version);
      if (!INTERVIEW_STATUSES.has(status)) return redirectError(req, res, 'Choose a valid interview status.');
      const summary = clean(req.body.completion_summary, 5000);
      if (status === 'completed' && !summary) return redirectError(req, res, 'A client-safe completion summary is required when completing an interview.');
      const result = db.prepare(`UPDATE gap_fieldwork_interviews SET status=?,completion_summary=?,
        completed_at=CASE WHEN ?='completed' THEN datetime('now') ELSE NULL END,
        updated_by=?,updated_at=datetime('now'),row_version=row_version+1
        WHERE id=? AND workspace_id=? AND row_version=?`).run(
          status, summary || null, status, req.user.id, Number(req.params.id), req.workspace.id, version);
      if (!result.changes) return redirectError(req, res, 'The interview changed in another session. Reload before updating it.');
      logAction(req.user.id, req.workspace.id, 'update_gap_interview', 'gap_fieldwork_interview', req.params.id, { status }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Interview status updated.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/blockers', requireAuth, requireWorkspace, firmOnly,
    requirePermission('control.update'), (req, res) => {
      const pass = currentPassOrError(req);
      if (!pass) return redirectError(req, res, 'Start an assessment pass before recording blockers.');
      const title = clean(req.body.title, 220);
      const description = clean(req.body.description, 5000);
      const priority = ['normal', 'high', 'critical'].includes(req.body.priority) ? req.body.priority : 'high';
      if (!title || !description) return redirectError(req, res, 'Blocker title and client-safe impact statement are required.');
      const owner = workspaceUser(req, req.body.owner_id);
      const result = db.prepare(`INSERT INTO gap_fieldwork_blockers
        (workspace_id,assessment_pass_id,title,description,owner_id,priority,due_date,client_visible,created_by,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          req.workspace.id, pass.id, title, description, owner?.id || null, priority,
          date(req.body.due_date), visible(req.body.client_visible), req.user.id, req.user.id);
      logAction(req.user.id, req.workspace.id, 'create_gap_blocker', 'gap_fieldwork_blocker', result.lastInsertRowid,
        { priority }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Blocker recorded.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/blockers/:id/status', requireAuth, requireWorkspace, firmOnly,
    requirePermission('control.update'), (req, res) => {
      const status = String(req.body.status || '');
      const version = Number(req.body.row_version);
      const note = clean(req.body.resolution_note, 5000);
      if (!BLOCKER_STATUSES.has(status)) return redirectError(req, res, 'Choose a valid blocker status.');
      if (status !== 'open' && !note) return redirectError(req, res, 'A resolution or risk-acceptance rationale is required.');
      const result = db.prepare(`UPDATE gap_fieldwork_blockers SET status=?,resolution_note=?,
        resolved_at=CASE WHEN ?='open' THEN NULL ELSE datetime('now') END,
        updated_by=?,updated_at=datetime('now'),row_version=row_version+1
        WHERE id=? AND workspace_id=? AND row_version=?`).run(
          status, note || null, status, req.user.id, Number(req.params.id), req.workspace.id, version);
      if (!result.changes) return redirectError(req, res, 'The blocker changed in another session. Reload before updating it.');
      logAction(req.user.id, req.workspace.id, 'update_gap_blocker', 'gap_fieldwork_blocker', req.params.id, { status }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), 'Blocker status updated.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/defaults', requireAuth, requireWorkspace, firmOnly,
    requirePermission('control.update'), (req, res) => {
      const pass = currentPassOrError(req);
      if (!pass) return redirectError(req, res, 'Start an assessment pass before recording declared defaults.');
      const requirement = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id
        WHERE r.id=? AND f.code='iso27001'`).get(Number(req.body.requirement_id));
      const declaration = clean(req.body.declaration, 3000);
      const rationale = clean(req.body.rationale, 5000);
      if (!requirement || !declaration || !rationale) return redirectError(req, res, 'Requirement, declaration and rationale are required.');
      try {
        const result = db.prepare(`INSERT INTO gap_declared_defaults
          (workspace_id,assessment_pass_id,requirement_id,declaration,rationale,client_visible,recorded_by)
          VALUES (?,?,?,?,?,?,?)`).run(req.workspace.id, pass.id, requirement.id, declaration, rationale,
            visible(req.body.client_visible), req.user.id);
        logAction(req.user.id, req.workspace.id, 'propose_gap_default', 'gap_declared_default', result.lastInsertRowid,
          { requirement_id: requirement.id }, auditCtx(req));
      } catch (error) {
        if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) return redirectError(req, res, 'A declared default already exists for this requirement in the current pass.');
        throw error;
      }
      res.redirect(withToast(base(req.workspace.id), 'Declared default proposed for confirmation.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/defaults/:id/:action(confirm|withdraw)', requireAuth, requireWorkspace, firmOnly,
    requirePermission('assessment.signoff'), (req, res) => {
      const action = req.params.action;
      const version = Number(req.body.row_version);
      const result = db.prepare(`UPDATE gap_declared_defaults SET status=?,confirmed_by=?,
        confirmed_at=CASE WHEN ?='confirmed' THEN datetime('now') ELSE confirmed_at END,
        updated_at=datetime('now'),row_version=row_version+1
        WHERE id=? AND workspace_id=? AND row_version=?`).run(
          action === 'confirm' ? 'confirmed' : 'withdrawn', req.user.id,
          action === 'confirm' ? 'confirmed' : 'withdrawn', Number(req.params.id), req.workspace.id, version);
      if (!result.changes) return redirectError(req, res, 'The declared default changed in another session. Reload before deciding.');
      logAction(req.user.id, req.workspace.id, `${action}_gap_default`, 'gap_declared_default', req.params.id, null, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), `Declared default ${action === 'confirm' ? 'confirmed' : 'withdrawn'}.`));
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/snapshots', requireAuth, requireWorkspace, firmOnly,
    requirePermission('assessment.signoff'), (req, res) => {
      try {
        const id = fieldwork.snapshotFieldwork(db, req.workspace, req.user.id, date(req.body.week_ending));
        logAction(req.user.id, req.workspace.id, 'freeze_gap_weekly_snapshot', 'gap_fieldwork_snapshot', id,
          { week_ending: req.body.week_ending }, auditCtx(req));
        res.redirect(withToast(base(req.workspace.id), 'Immutable weekly fieldwork snapshot created.'));
      } catch (error) {
        return redirectError(req, res, String(error.message).includes('UNIQUE')
          ? 'A snapshot already exists for that assessment pass and week-ending date.' : error.message);
      }
    });

  app.post('/workspaces/:wsId/gap-assessment/fieldwork/phases/:phase', requireAuth, requireWorkspace, firmOnly,
    requirePermission('assessment.signoff'), (req, res) => {
      const phase = String(req.params.phase || '');
      const decision = String(req.body.decision || '');
      const rationale = clean(req.body.rationale, 5000);
      const expectedVersion = Number(req.body.row_version || 0);
      if (!PHASES.has(phase) || !['complete', 'not_required', 'reopened'].includes(decision) || !rationale) {
        return redirectError(req, res, 'A valid phase decision and rationale are required.');
      }
      const context = fieldwork.assessmentContext(db, req.workspace);
      if (!context.pass) return redirectError(req, res, 'Start an assessment pass before recording phase decisions.');
      if (decision !== 'reopened') {
        if (phase === 'validation' && decision === 'not_required') {
          if (!context.completed.fieldwork || context.findings.length) return redirectError(req, res, 'Validation can be marked not required only after fieldwork sign-off when there are no confirmed client findings.');
        } else if (phase === 'validation' && decision === 'complete' && !context.findings.length) {
          return redirectError(req, res, 'There are no confirmed client findings to validate. Record Validation as Not required instead.');
        } else if (!context.gates[phase].ready) {
          const failed = context.gates[phase].checks.filter(check => !check.pass).map(check => check.label).join('; ');
          return redirectError(req, res, `Phase sign-off is blocked: ${failed}.`);
        }
      }
      const decide = db.transaction(() => {
        const current = db.prepare(`SELECT * FROM gap_assessment_phase_decisions
          WHERE workspace_id=? AND assessment_pass_id=? AND phase=?`).get(req.workspace.id, context.pass.id, phase);
        if (current && Number(current.row_version) !== expectedVersion) throw new Error('The phase decision changed in another session. Reload before deciding.');
        let id;
        if (current) {
          const result = db.prepare(`UPDATE gap_assessment_phase_decisions SET decision=?,rationale=?,decided_by=?,
            decided_at=datetime('now'),row_version=row_version+1 WHERE id=? AND row_version=?`).run(
              decision, rationale, req.user.id, current.id, expectedVersion);
          if (!result.changes) throw new Error('The phase decision changed in another session. Reload before deciding.');
          id = current.id;
        } else {
          if (expectedVersion !== 0) throw new Error('The phase decision changed in another session. Reload before deciding.');
          id = Number(db.prepare(`INSERT INTO gap_assessment_phase_decisions
            (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by) VALUES (?,?,?,?,?,?)`).run(
              req.workspace.id, context.pass.id, phase, decision, rationale, req.user.id).lastInsertRowid);
        }
        db.prepare(`INSERT INTO gap_assessment_phase_events
          (phase_decision_id,from_decision,to_decision,rationale,actor_id) VALUES (?,?,?,?,?)`).run(
            id, current?.decision || null, decision, rationale, req.user.id);
        return id;
      });
      let id;
      try { id = decide(); } catch (error) { return redirectError(req, res, error.message); }
      logAction(req.user.id, req.workspace.id, 'decide_gap_phase', 'gap_assessment_phase_decision', id,
        { phase, decision, assessment_pass_id: context.pass.id }, auditCtx(req));
      res.redirect(withToast(base(req.workspace.id), `${phase.replace('_', ' ')} decision recorded.`));
    });
}

module.exports = { register };
