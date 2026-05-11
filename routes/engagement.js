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
    const draftScope = INTAKE.draftScopeStatement(answers);
    res.render('intake', {
      user: req.user, ws: req.workspace,
      sections: INTAKE.SECTIONS, answers, total, answered, draftScope,
    });
  });

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
    logAction(req.user.id, req.workspace.id, 'intake_save', 'intake', null, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`, 'Intake saved'));
  });

  // Apply: copy auto-drafted scope into workspaces.scope and seed interested
  // parties from the customer / regulator / supplier answers. Idempotent.
  app.post('/workspaces/:wsId/intake/apply', requireAuth, requireWorkspace, (req, res) => {
    const rows = db.prepare(`SELECT question_id, answer FROM engagement_intake WHERE workspace_id=?`)
      .all(req.workspace.id);
    const answers = {};
    for (const r of rows) answers[r.question_id] = r.answer || '';
    const scope = INTAKE.draftScopeStatement(answers);
    db.prepare('UPDATE workspaces SET scope=? WHERE id=?').run(scope, req.workspace.id);

    let parties = 0;
    const seedParty = (text, type) => {
      if (!text || !text.trim()) return;
      for (const line of text.split('\n').map(s => s.trim()).filter(Boolean)) {
        const exists = db.prepare(`SELECT 1 FROM interested_parties WHERE workspace_id=? AND party=?`)
          .get(req.workspace.id, line);
        if (exists) continue;
        db.prepare(`INSERT INTO interested_parties (workspace_id, party, party_type, needs, how_addressed)
          VALUES (?, ?, ?, '', '')`).run(req.workspace.id, line, type);
        parties++;
      }
    };
    seedParty(answers['key-customers'], 'customer');
    seedParty(answers['key-regulators'], 'regulator');
    seedParty(answers['key-suppliers'], 'supplier');

    logAction(req.user.id, req.workspace.id, 'intake_apply', 'intake', null, { parties_seeded: parties }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/intake`,
      `Scope applied; ${parties} interested part${parties === 1 ? 'y' : 'ies'} seeded`));
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
