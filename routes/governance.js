'use strict';
// Governance routes. Slice 9 of the server.js modularization: internal
// audits + findings, continual-improvement register, management reviews,
// nonconformities/CAPA.

const fts = require('../lib/fts');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, workspaceProgress } = deps;

  // ==================== INTERNAL AUDITS ====================
  app.get('/workspaces/:wsId/audits', requireAuth, requireWorkspace, (req, res) => {
    const audits = db.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id) AS finding_count,
      (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id AND status = 'open') AS open_findings
      FROM audits a WHERE a.workspace_id = ? ORDER BY a.audit_date DESC, a.created_at DESC`).all(req.workspace.id);
    res.render('audits', { user: req.user, ws: req.workspace, audits });
  });

  app.post('/workspaces/:wsId/audits', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const { title, scope, audit_date, auditor_name } = req.body;
    if (!title) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO audits (workspace_id, title, scope, audit_date, auditor_name, created_by)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, title, scope || null, audit_date || null, auditor_name || null, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_audit', 'audit', id, { title });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/audits/' + id, 'Audit created'));
  });

  app.get('/workspaces/:wsId/audits/:id', requireAuth, requireWorkspace, (req, res) => {
    const audit = db.prepare('SELECT * FROM audits WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');
    const findings = db.prepare(`SELECT f.*, i.title AS iso_title FROM audit_findings f
      LEFT JOIN iso_items i ON i.id = f.iso_item_id
      WHERE f.audit_id = ? ORDER BY f.created_at`).all(audit.id);
    const allItems = db.prepare(`SELECT id, title FROM iso_items ORDER BY sort_order`).all();
    // Tier C.9 - per-control samples taken during the audit
    const samples = db.prepare(`SELECT s.*, i.title AS iso_title FROM audit_samples s
      LEFT JOIN iso_items i ON i.id=s.iso_item_id
      WHERE s.audit_id=? ORDER BY s.sample_taken_at IS NULL, s.sample_taken_at DESC`).all(audit.id);
    const observations = db.prepare(`SELECT o.*, i.title AS iso_title FROM audit_observations o
      LEFT JOIN iso_items i ON i.id = o.iso_item_id
      WHERE o.audit_id=? ORDER BY o.status='closed', o.created_at`).all(audit.id);
    res.render('audit_detail', { user: req.user, ws: req.workspace, audit, findings, allItems, samples, observations });
  });

  app.post('/workspaces/:wsId/audits/:id', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const { title, scope, audit_date, auditor_name, status, summary } = req.body;
    db.prepare(`UPDATE audits SET title=?, scope=?, audit_date=?, auditor_name=?, status=?, summary=?
                WHERE id=? AND workspace_id=?`)
      .run(title, scope || null, audit_date || null, auditor_name || null,
           status || 'planned', summary || null, req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
  });

  // ==================== TIER C.10 - CONTINUAL IMPROVEMENT REGISTER ====================
  // Improvements driven by data (audit findings, MRM outputs, monitoring),
  // distinct from corrective actions on NCs (10.2). Required by clause 10.1.
  app.get('/workspaces/:wsId/improvements', requireAuth, requireWorkspace, (req, res) => {
    const filter = req.query.filter || 'open';
    let q = `SELECT * FROM improvements WHERE workspace_id=?`;
    if (filter === 'open') q += ` AND status NOT IN ('done','cancelled')`;
    const pgImp = paginate(db, req, {
      count: q.replace('SELECT *', 'SELECT COUNT(*) c'),
      rows: q + ` ORDER BY (CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`,
      params: [req.workspace.id], perPage: 100,
    });
    res.render('improvements', { user: req.user, ws: req.workspace, items: pgImp.rows, filter,
      pg: pgImp, pagerHref: p => pageHref(req, p) });
  });

  app.post('/workspaces/:wsId/improvements', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
    const { title, description, source, source_ref, owner_name, due_date } = req.body;
    if (!title || !title.trim()) return redirectBack(req, res);
    db.prepare(`INSERT INTO improvements (workspace_id, title, description, source, source_ref, owner_name, due_date, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, title.trim(), description || null,
      source || null, source_ref || null, owner_name || null, due_date || null, req.user.id
    );
    logAction(req.user.id, req.workspace.id, 'add_improvement', 'improvement', null, { title }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/improvements`);
  });

  app.post('/workspaces/:wsId/improvements/:id', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
    const { title, description, source, source_ref, owner_name, due_date, status, impact_notes } = req.body;
    db.prepare(`UPDATE improvements SET
      title=?, description=?, source=?, source_ref=?, owner_name=?, due_date=?, status=?, impact_notes=?,
      closed_at=CASE WHEN ? IN ('done','cancelled') AND closed_at IS NULL THEN CURRENT_TIMESTAMP
                     WHEN ? NOT IN ('done','cancelled') THEN NULL
                     ELSE closed_at END
      WHERE id=? AND workspace_id=?`).run(
      title, description || null, source || null, source_ref || null, owner_name || null,
      due_date || null, status || 'open', impact_notes || null,
      status, status, req.params.id, req.workspace.id
    );
    res.redirect(`/workspaces/${req.workspace.id}/improvements`);
  });

  app.post('/workspaces/:wsId/improvements/:id/delete', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
    db.prepare(`DELETE FROM improvements WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/improvements`);
  });

  // (Asset relationships graph removed in IA cleanup - daily-use rare. The
  // underlying asset_relationships table is still populated from the asset
  // detail page; if blast-radius visualisation is needed again, restore from
  // git history at sha 5c9ee08. See views/assets.ejs for the table view that
  // answers every real question.)

  // Tier C.9 - Per-audit sampling justification + per-control sample log.
  // Clause 9.2 expects sampling decisions to be defensible. The audit detail
  // gets two new bits: (1) a sampling-justification narrative, and (2) a
  // table of per-control samples taken with population/sample sizes and findings.
  app.post('/workspaces/:wsId/audits/:id/sampling', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const { sampling_justification, sample_size, population_size } = req.body;
    db.prepare(`UPDATE audits SET sampling_justification=?, sample_size=?, population_size=?
                WHERE id=? AND workspace_id=?`).run(
      sampling_justification || null,
      sample_size ? parseInt(sample_size, 10) : null,
      population_size ? parseInt(population_size, 10) : null,
      req.params.id, req.workspace.id
    );
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/:id/samples', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const { iso_item_id, description, sample_taken_at, population_size, sample_size, finding } = req.body;
    if (!description) return redirectBack(req, res);
    db.prepare(`INSERT INTO audit_samples
      (audit_id, iso_item_id, description, sample_taken_at, population_size, sample_size, finding)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      audit.id, iso_item_id || null, description.trim(),
      sample_taken_at || null,
      population_size ? parseInt(population_size, 10) : null,
      sample_size ? parseInt(sample_size, 10) : null,
      finding || null
    );
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/:id/samples/:sid/delete', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    db.prepare(`DELETE FROM audit_samples WHERE id=? AND audit_id=?`).run(req.params.sid, audit.id);
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  // Tier 1.4 - Audit lifecycle stage transitions (planned → fieldwork →
  // findings_review → report → follow_up → closed). Transitions auto-timestamp
  // the milestone columns so the engagement timeline is reconstructable.
  app.post('/workspaces/:wsId/audits/:id/lifecycle', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const { stage } = req.body;
    const allowed = ['planned','fieldwork','findings_review','report','follow_up','closed'];
    if (!allowed.includes(stage)) return redirectBack(req, res);
    const sets = ['lifecycle_stage=?'];
    const vals = [stage];
    if (stage === 'fieldwork') { sets.push('fieldwork_started_at=COALESCE(fieldwork_started_at, CURRENT_TIMESTAMP)'); }
    if (stage === 'report')    { sets.push('report_issued_at=COALESCE(report_issued_at, CURRENT_TIMESTAMP)'); }
    if (stage === 'closed')    { sets.push('closed_at=COALESCE(closed_at, CURRENT_TIMESTAMP)'); }
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE audits SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'audit_lifecycle', 'audit', req.params.id, { stage }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/:id/findings', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const { iso_item_id, finding_type, description, severity } = req.body;
    if (!description) return redirectBack(req, res);
    db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, description, severity)
                VALUES (?, ?, ?, ?, ?)`)
      .run(audit.id, iso_item_id || null, finding_type || 'observation',
           description, severity || 'medium');
    res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
  });

  app.post('/workspaces/:wsId/audits/:id/findings/:fId/promote', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const f = db.prepare('SELECT * FROM audit_findings WHERE id = ? AND audit_id = ?')
      .get(req.params.fId, audit.id);
    if (!f) return redirectBack(req, res);
    if (f.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + f.nonconformity_id);
    const sev = f.finding_type === 'major_nc' ? 'major' : 'minor';
    const ncId = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity, iso_item_id)
                             VALUES (?, ?, 'internal_audit', ?, ?, ?, ?)`)
      .run(req.workspace.id, f.description.substring(0, 100),
           'Audit #' + req.params.id, f.description, sev, f.iso_item_id).lastInsertRowid;
    db.prepare('UPDATE audit_findings SET nonconformity_id = ? WHERE id = ?').run(ncId, f.id);
    fts.refresh(req.workspace.id, 'nc', ncId);
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
  });

  app.post('/workspaces/:wsId/audits/:id/delete', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    db.prepare('DELETE FROM audits WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/audits');
  });

  // ==================== MANAGEMENT REVIEW ====================
  app.get('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, (req, res) => {
    const mrms = db.prepare(`SELECT * FROM mrms WHERE workspace_id = ?
                             ORDER BY meeting_date DESC, created_at DESC`).all(req.workspace.id);
    // Preview the 9.3.2 input pack so the consultant sees what will be auto-
    // filled before submitting the create form. The same compute is then re-run
    // server-side on POST — no risk of staleness.
    const pack932Preview = compute932InputPack(req.workspace.id);
    res.render('mrms', { user: req.user, ws: req.workspace, mrms, pack932Preview });
  });

  // Helper - compute the auto-fillable 9.3.2 input fields from current data.
  // Used both by MRM creation (Tier 2.5) and by the on-demand refresh action
  // (Tier A.4) so the saved values can be brought back in line with reality.
  function compute932InputPack(wsId) {
    const today = new Date().toISOString().slice(0,10);

    // ---- existing 9.3.2 a / c / e numbers ----
    const ncOpen = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified')`).get(wsId).c;
    const ncMajor = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(wsId).c;
    const ncOverdue = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date < ?`).get(wsId, today).c;
    const auditsLast12 = db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND audit_date > date('now','-12 months')`).get(wsId).c;
    const findingsLast12 = db.prepare(`SELECT COUNT(*) c FROM audit_findings af INNER JOIN audits a ON a.id=af.audit_id WHERE a.workspace_id=? AND a.audit_date > date('now','-12 months')`).get(wsId).c;
    const openRisks = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open'`).get(wsId).c;
    const highRisks = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open' AND (likelihood * impact) >= 16`).get(wsId).c;
    const treatmentOpen = db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=? AND status NOT IN ('done','cancelled')`).get(wsId).c;
    const treatmentDone = db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=? AND status='done'`).get(wsId).c;
    const lastMrm = db.prepare(`SELECT meeting_date, action_items FROM mrms WHERE workspace_id=? AND status='complete' ORDER BY meeting_date DESC LIMIT 1`).get(wsId);

    // ---- 9.3.2.b context changes ----
    // Objective signal for context changes: new suppliers since last MRM.
    // (Previously also counted new / overdue interested parties; removed
    // alongside the dedicated parties module.)
    const sinceClause = lastMrm ? '?' : "date('now','-12 months')";
    const lastMrmParams = lastMrm ? [wsId, lastMrm.meeting_date] : [wsId];
    let newSuppliers = 0;
    try {
      newSuppliers = db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND date(created_at) > ${sinceClause}`).get(...lastMrmParams).c;
    } catch (_) {}

    // Incident summary feeds both context (regulatory exposure) and performance.
    let incidents = { total: 0, open: 0, last12m: 0 };
    try {
      const row = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN created_at > datetime('now','-12 months') THEN 1 ELSE 0 END) AS last12m
        FROM incidents WHERE workspace_id=?`).get(wsId);
      if (row) incidents = { total: row.total || 0, open: row.open || 0, last12m: row.last12m || 0 };
    } catch (_) {}

    // ---- 9.3.2.f opportunities for improvement ----
    const improvementsOpen = db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=? AND status IN ('open','in_progress')`).get(wsId).c;
    const improvementsDone = db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=? AND status='done'`).get(wsId).c;
    const recentImprovements = db.prepare(`SELECT title, source FROM improvements WHERE workspace_id=? AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 5`).all(wsId);

    // ---- supplier review status (feeds performance) ----
    let supplierReview = { total: 0, overdue: 0 };
    try {
      const row = db.prepare(`SELECT
        COUNT(DISTINCT s.id) AS total,
        SUM(CASE WHEN s.next_review_date IS NULL OR s.next_review_date < date('now') THEN 1 ELSE 0 END) AS overdue
        FROM suppliers s WHERE s.workspace_id=?`).get(wsId);
      if (row) supplierReview = { total: row.total || 0, overdue: row.overdue || 0 };
    } catch (_) {}

    // ---- 9.3.2.e: risk register diff since last MRM ----
    let risksAddedSinceLast = 0, risksClosedSinceLast = 0;
    if (lastMrm) {
      risksAddedSinceLast = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND date(created_at) > ?`).get(wsId, lastMrm.meeting_date).c;
      risksClosedSinceLast = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status IN ('closed','treated')`).get(wsId).c;
    }

    return {
      // 9.3.2.a — prior MRM actions
      prior_actions_status: lastMrm
        ? `Last MRM (${lastMrm.meeting_date}) actions:\n${lastMrm.action_items || '(none recorded)'}\n\n[Review status of each above before this meeting.]`
        : 'No prior management review on record. This is the first one.',

      // 9.3.2.b — context changes
      context_changes: lastMrm
        ? `Changes since last MRM (${lastMrm.meeting_date}):\n  New suppliers onboarded: ${newSuppliers}\n\n[Add narrative on regulatory updates, organisational changes, technology shifts, threat-landscape evolution, and changes in the needs / expectations of interested parties identified during gap assessment.]`
        : `Baseline context (no prior MRM):\n  Suppliers on file: ${supplierReview.total}\n\n[Document the external + internal context relevant to the ISMS — regulations, market, technology, organisation. Note the interested parties identified during gap assessment (clause 4.2).]`,

      // 9.3.2.c — performance review (extended with incidents + suppliers)
      performance_review: `Internal audit programme (last 12 months):\n  Audits run: ${auditsLast12}\n  Findings raised: ${findingsLast12}\n\nNonconformity status:\n  Open: ${ncOpen} (Major: ${ncMajor}, Overdue: ${ncOverdue})\n\nRisk treatment plan:\n  Open actions: ${treatmentOpen}\n  Closed actions: ${treatmentDone}\n\nIncidents (last 12 months):\n  Total: ${incidents.last12m} (${incidents.open} still open)\n\nSupplier reviews:\n  ${supplierReview.total} suppliers · ${supplierReview.overdue} overdue review${supplierReview.overdue === 1 ? '' : 's'}\n\n[Add commentary on KPIs, monitoring metrics (9.1), trends, root-cause patterns.]`,

      // 9.3.2.d — interested-party feedback. Parties are now captured
      // during the gap assessment + clause 4.2 work rather than a
      // dedicated register, so the auto-pack just hands the consultant
      // a structured prompt to fill in.
      feedback_interested_parties: `[Summarise feedback received in the period from interested parties identified in clause 4.2 - customer concerns / contractual security asks, regulator queries, employee survey results, supplier feedback, board observations. Quantify where possible (NPS, audit findings against customer SoWs, complaint volumes).]`,

      // 9.3.2.e — risk-treatment status (existing + register diff)
      risk_treatment_status: `Risk register snapshot (today):\n  Total open risks: ${openRisks}\n  High-residual (L×I ≥ 16): ${highRisks}${lastMrm ? `\n\nSince last MRM (${lastMrm.meeting_date}):\n  Risks added: ${risksAddedSinceLast}\n  Risks closed/treated: ${risksClosedSinceLast}` : ''}\n\n[Add narrative on top risks, treatment progress, residual-risk acceptance.]`,

      // 9.3.2.f — improvement opportunities
      improvement_opportunities: improvementsOpen === 0 && improvementsDone === 0
        ? 'No improvement actions recorded yet. Capture observations from audits, MRMs, incidents, and monitoring under Improvements (Clause 10.1).'
        : `Improvement log:\n  Active: ${improvementsOpen}\n  Completed: ${improvementsDone}${recentImprovements.length ? '\n\nActive items:\n' + recentImprovements.map(i => `  - ${i.title}${i.source ? ' [' + i.source + ']' : ''}`).join('\n') : ''}\n\n[Identify themes from this period's data: recurring NCs, gaps surfaced by audits, technology refresh, training needs, control automation candidates.]`,

      refreshedAt: new Date().toISOString()
    };
  }

  app.post('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
    const { meeting_date, attendees } = req.body;
    const pack = compute932InputPack(req.workspace.id);
    const id = db.prepare(`INSERT INTO mrms
      (workspace_id, meeting_date, attendees,
       prior_actions_status, context_changes, performance_review, feedback_interested_parties,
       risk_treatment_status, improvement_opportunities,
       created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, meeting_date || null, attendees || null,
           pack.prior_actions_status, pack.context_changes, pack.performance_review,
           pack.feedback_interested_parties, pack.risk_treatment_status, pack.improvement_opportunities,
           req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_mrm', 'mrm', id, null);
    res.redirect('/workspaces/' + req.workspace.id + '/mrms/' + id);
  });

  // Tier A.4 - Refresh the auto-fillable inputs against current workspace data.
  // Useful when a saved MRM has gone stale (e.g., NCs closed since the meeting
  // was scheduled, new audit findings recorded). Re-saves the three auto-pack
  // fields from a fresh compute.
  app.post('/workspaces/:wsId/mrms/:id/refresh-inputs', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
    const mrm = db.prepare('SELECT id, status FROM mrms WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!mrm) return res.status(404).send('Not found');
    const pack = compute932InputPack(req.workspace.id);
    db.prepare(`UPDATE mrms SET
        prior_actions_status=?, context_changes=?, performance_review=?,
        feedback_interested_parties=?, risk_treatment_status=?, improvement_opportunities=?
      WHERE id=? AND workspace_id=?`)
      .run(pack.prior_actions_status, pack.context_changes, pack.performance_review,
           pack.feedback_interested_parties, pack.risk_treatment_status, pack.improvement_opportunities,
           mrm.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'refresh_mrm_inputs', 'mrm', mrm.id, null, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/mrms/${mrm.id}`, 'MRM inputs refreshed from current data'));
  });

  app.get('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, (req, res) => {
    const mrm = db.prepare('SELECT * FROM mrms WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
    if (!mrm) return res.status(404).send('Not found');

    // Auto-collect inputs (9.3.2)
    const audits = db.prepare(`SELECT title, status, audit_date FROM audits
                               WHERE workspace_id = ? ORDER BY audit_date DESC LIMIT 10`).all(req.workspace.id);
    const ncs = db.prepare(`SELECT title, severity, status FROM nonconformities
                            WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.workspace.id);
    const riskSummary = db.prepare(`SELECT status, COUNT(*) AS c FROM risks
                                    WHERE workspace_id = ? GROUP BY status`).all(req.workspace.id);
    const progress = workspaceProgress(req.workspace.id);

    // Phase D - extended 9.3.2 inputs
    const incidentSummary = (() => {
      try {
        return db.prepare(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN created_at > datetime('now','-12 months') THEN 1 ELSE 0 END) AS last12m
          FROM incidents WHERE workspace_id=?`).get(req.workspace.id) || {};
      } catch (e) { return {}; }
    })();
    const supplierReviewStatus = (() => {
      try {
        return db.prepare(`SELECT
          COUNT(DISTINCT s.id) AS total_suppliers,
          SUM(CASE WHEN (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) > date('now','-12 months')
                   THEN 1 ELSE 0 END) AS reviewed_last_year,
          SUM(CASE WHEN (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) IS NULL
                    OR (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) < date('now','-12 months')
                   THEN 1 ELSE 0 END) AS overdue
          FROM suppliers s WHERE s.workspace_id=?`).get(req.workspace.id) || {};
      } catch (e) { return {}; }
    })();
    // Prior MRM action items: tasks created from the most recent prior MRM
    const priorMrm = db.prepare(`SELECT id, meeting_date FROM mrms WHERE workspace_id=? AND id != ? AND status='complete' ORDER BY meeting_date DESC LIMIT 1`).get(req.workspace.id, mrm.id);
    const priorActions = priorMrm
      ? db.prepare(`SELECT title, status, due_date FROM tasks WHERE workspace_id=? AND created_at >= ? AND created_at < datetime(?, '+30 days') ORDER BY due_date`).all(req.workspace.id, priorMrm.meeting_date, priorMrm.meeting_date)
      : [];

    res.render('mrm_detail', {
      user: req.user, ws: req.workspace, mrm, audits, ncs, riskSummary, progress,
      incidentSummary, supplierReviewStatus, priorActions, priorMrm
    });
  });

  app.post('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
    const f = ['meeting_date','attendees','status','context_changes','prior_actions_status',
               'performance_review','feedback_interested_parties','risk_treatment_status',
               'improvement_opportunities','decisions','action_items'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE mrms SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'update_mrm', 'mrm', req.params.id, null);
    }
    res.redirect('/workspaces/' + req.workspace.id + '/mrms/' + req.params.id);
  });

  app.post('/workspaces/:wsId/mrms/:id/delete', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
    db.prepare('DELETE FROM mrms WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/mrms');
  });

  // ==================== NONCONFORMITIES / CAPA ====================
  app.get('/workspaces/:wsId/nonconformities', requireAuth, requireWorkspace, (req, res) => {
    const filter = req.query.filter || 'open';
    let q = `SELECT n.*, i.title AS iso_title FROM nonconformities n
             LEFT JOIN iso_items i ON i.id = n.iso_item_id
             WHERE n.workspace_id = ?`;
    if (filter === 'open') q += ` AND n.status NOT IN ('closed','verified')`;
    const pgN = paginate(db, req, {
      count: q.replace(/SELECT n\.\*.*?FROM nonconformities n/s, 'SELECT COUNT(*) c FROM nonconformities n'),
      rows: q + ` ORDER BY n.created_at DESC`,
      params: [req.workspace.id], perPage: 100,
    });
    res.render('nonconformities', { user: req.user, ws: req.workspace, ncs: pgN.rows, filter,
      pg: pgN, pagerHref: p => pageHref(req, p) });
  });

  app.post('/workspaces/:wsId/nonconformities', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
    const { title, source, description, severity, iso_item_id } = req.body;
    if (!title) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, description, severity, iso_item_id)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, title, source || 'other', description || null,
           severity || 'minor', iso_item_id || null).lastInsertRowid;
    fts.refresh(req.workspace.id, 'nc', id);
    logAction(req.user.id, req.workspace.id, 'create_nc', 'nonconformity', id, { title });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/nonconformities/' + id, 'Nonconformity created'));
  });

  app.get('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, (req, res) => {
    const nc = db.prepare('SELECT * FROM nonconformities WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!nc) return res.status(404).send('Not found');
    const allItems = db.prepare(`SELECT id, title FROM iso_items ORDER BY sort_order`).all();
    // Phase C: corrective tasks spawned from this NC
    const correctiveTasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.workspace_id=? AND t.nonconformity_id=? ORDER BY t.created_at DESC`).all(req.workspace.id, nc.id);
    res.render('nonconformity_detail', { user: req.user, ws: req.workspace, nc, allItems, correctiveTasks });
  });

  app.post('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
    const f = ['title','source','source_ref','description','severity','iso_item_id',
               'root_cause','corrective_action','responsible','due_date','effectiveness_check','status'];
    const set = []; const vals = [];
    f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
    const closing = (req.body.status === 'closed' || req.body.status === 'verified');
    if (closing) {
      set.push('closed_at=CURRENT_TIMESTAMP');
    }
    if (set.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE nonconformities SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      fts.refresh(req.workspace.id, 'nc', req.params.id);
      logAction(req.user.id, req.workspace.id, 'update_nc', 'nonconformity', req.params.id, null);

      // Phase C: closing an NC bumps the linked control's last_verified_at - feeds SoA freshness view
      if (closing) {
        const ncRow = db.prepare('SELECT iso_item_id FROM nonconformities WHERE id=?').get(req.params.id);
        if (ncRow && ncRow.iso_item_id) {
          // Cutover 4 (W5): bump last_verified_at on the converged row when flipped
          // (014 mirrors to legacy). entity_id IS NULL is not ON-CONFLICT-safe, so
          // ensure-then-update. Fail-safe to the legacy upsert otherwise.
          const ridNc = ctlWrites.converged(db, req.workspace.id) ? ctlWrites.requirementId(db, 'iso27001', ncRow.iso_item_id) : null;
          if (ridNc) {
            db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)`).run(req.workspace.id, ridNc);
            db.prepare(`UPDATE control_instances SET last_verified_at = CURRENT_TIMESTAMP WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(req.workspace.id, ridNc);
          } else {
            db.prepare(`INSERT INTO control_states (workspace_id, iso_item_id, last_verified_at)
                        VALUES (?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET last_verified_at = CURRENT_TIMESTAMP`)
              .run(req.workspace.id, ncRow.iso_item_id);
          }
        }
      }
    }
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + req.params.id);
  });

  // Phase C: spawn a corrective-action Task from a Nonconformity (closes audit -> NC -> task -> control loop)
  app.post('/workspaces/:wsId/nonconformities/:id/spawn-task', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
    const nc = db.prepare('SELECT * FROM nonconformities WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!nc) return res.status(404).send('Not found');
    const title = `Corrective action: ${nc.title}`;
    const due = req.body.due_date || nc.due_date || null;
    const description = nc.corrective_action || nc.description || '';
    const taskId = db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, due_date, status, created_by, nonconformity_id)
                                VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`)
      .run(req.workspace.id, title, description, nc.iso_item_id || null, due, req.user.id, nc.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'spawn_corrective_task', 'task', taskId, { nonconformity_id: nc.id }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + nc.id);
  });

  app.post('/workspaces/:wsId/nonconformities/:id/delete', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
    db.prepare('DELETE FROM nonconformities WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
    fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'nc', entityId: req.params.id });
    res.redirect('/workspaces/' + req.workspace.id + '/nonconformities');
  });

}

module.exports = { register };
