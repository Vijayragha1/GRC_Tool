'use strict';

const reports = require('../lib/assurance-reports');
const rbac = require('../lib/rbac');
const { withToast, parseFormArray } = require('../lib/http-helpers');
const { buildWorkspaceTruth } = require('../lib/grc-truth');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;

  function capabilities(req) {
    const perms = req.userPerms || new Set();
    const has = p => rbac.hasPermission(perms, p);
    return { view:has('report.view'), generate:has('report.generate'), review:has('report.review'), approve:has('report.approve'), publish:has('report.publish'), export:has('report.export') };
  }

  function supplierOptions(workspaceId) {
    return db.prepare(`SELECT s.id,s.name,s.business_owner,
        (SELECT ia.assigned_tier FROM supplier_inherent_assessments ia
          WHERE ia.supplier_id=s.id AND ia.workspace_id=s.workspace_id AND ia.status='approved'
          ORDER BY ia.approved_at DESC,ia.id DESC LIMIT 1) tier,
        (SELECT d.residual_risk_score FROM supplier_decisions d
          WHERE d.supplier_id=s.id AND d.workspace_id=s.workspace_id AND d.superseded_at IS NULL
          ORDER BY d.id DESC LIMIT 1) residual_risk_score,
        (SELECT d.residual_risk_band FROM supplier_decisions d
          WHERE d.supplier_id=s.id AND d.workspace_id=s.workspace_id AND d.superseded_at IS NULL
          ORDER BY d.id DESC LIMIT 1) residual_risk_band
      FROM suppliers s WHERE s.workspace_id=? AND s.archived_at IS NULL ORDER BY s.name`).all(workspaceId);
  }

  function loadRun(req, res) {
    const run = reports.getRun(db, req.workspace.id, Number(req.params.id));
    if (!run) { res.status(404).render('error', { user:req.user, ws:req.workspace, message:'Assurance report not found.' }); return null; }
    return run;
  }

  app.get('/workspaces/:wsId/assurance', requireAuth, requireWorkspace, requirePermission('report.view'), (req, res) => {
    const runs = db.prepare(`SELECT r.id,r.version_number,r.title,r.status,r.snapshot_hash,r.generated_at,r.approved_at,r.published_at,
        d.report_key,d.name AS definition_name,u.name AS creator_name,
        (SELECT COUNT(*) FROM assurance_report_artifacts a WHERE a.run_id=r.id) AS artifact_count,
        (SELECT COUNT(*) FROM json_each(r.data_quality_json) WHERE json_extract(value,'$.severity')='critical') AS critical_count
      FROM assurance_report_runs r JOIN assurance_report_definitions d ON d.id=r.definition_id
      LEFT JOIN users u ON u.id=r.created_by WHERE r.workspace_id=? ORDER BY r.created_at DESC,r.id DESC`).all(req.workspace.id);
    const legacyTemplates = db.prepare(`SELECT id,name,description,is_system FROM report_templates WHERE workspace_id IS NULL OR workspace_id=? OR firm_id=? ORDER BY is_system DESC,name`).all(req.workspace.id, req.workspace.firm_id);
    const statusCounts = runs.reduce((a,r) => { a[r.status]=(a[r.status]||0)+1; return a; }, {});
    const truth = buildWorkspaceTruth(db, req.workspace);
    res.render('assurance_center', { user:req.user, ws:req.workspace, definitions:Object.values(reports.REPORTS), runs, legacyTemplates, statusCounts, caps:capabilities(req), truth });
  });

  app.get('/workspaces/:wsId/assurance/new', requireAuth, requireWorkspace, requirePermission('report.generate'), (req, res) => {
    const key = reports.REPORTS[req.query.type] ? req.query.type : 'executive_posture';
    const suppliers = supplierOptions(req.workspace.id);
    res.render('assurance_new', { user:req.user, ws:req.workspace, definitions:Object.values(reports.REPORTS), definition:reports.REPORTS[key], suppliers, preview:null, form:{}, caps:capabilities(req) });
  });

  // A quality-gate response is rendered at the POST URL. Keep a refresh or
  // copied preflight URL safe by sending it back to the matching builder.
  app.get('/workspaces/:wsId/assurance/runs', requireAuth, requireWorkspace, requirePermission('report.generate'), (req, res) => {
    const key = reports.REPORTS[req.query.type] ? req.query.type : 'executive_posture';
    res.redirect(`/workspaces/${req.workspace.id}/assurance/new?type=${encodeURIComponent(key)}`);
  });

  app.post('/workspaces/:wsId/assurance/runs', requireAuth, requireWorkspace, requirePermission('report.generate'), (req, res) => {
    const key = req.body.report_key;
    const definition = reports.REPORTS[key];
    if (!definition) return res.status(400).render('error', { user:req.user, ws:req.workspace, message:'Unknown assurance report type.' });
    const allowedSections = new Set(definition.sections);
    const selectedSections = parseFormArray(req.body.sections).filter(s => allowedSections.has(s));
    const form = {
      ...req.body,
      selected_sections: selectedSections.length ? selectedSections : definition.sections,
      supplier_id: req.body.supplier_id ? Number(req.body.supplier_id) : null
    };
    try {
      const preview = reports.buildSnapshot(db, req.workspace.id, key, form);
      const hasCritical = preview.quality.some(q => q.severity === 'critical');
      if (hasCritical && req.body.ack_quality !== '1') {
        const suppliers = supplierOptions(req.workspace.id);
        return res.status(422).render('assurance_new', { user:req.user, ws:req.workspace, definitions:Object.values(reports.REPORTS), definition, suppliers, preview, form, caps:capabilities(req) });
      }
      const run = reports.createRun(db, req.workspace.id, req.user.id, key, form);
      logAction(req.user.id, req.workspace.id, 'assurance_report_generated', 'assurance_report', run.id, { report_key:key, version:run.version_number, snapshot_hash:run.snapshot_hash, critical_quality_items:preview.quality.filter(q=>q.severity==='critical').length });
      res.redirect(withToast(`/workspaces/${req.workspace.id}/assurance/runs/${run.id}`, 'Frozen report snapshot generated'));
    } catch (err) {
      console.error('assurance generation error:', err);
      const suppliers = supplierOptions(req.workspace.id);
      res.status(400).render('assurance_new', { user:req.user, ws:req.workspace, definitions:Object.values(reports.REPORTS), definition, suppliers, preview:{ error:err.message, quality:[] }, form, caps:capabilities(req) });
    }
  });

  app.get('/workspaces/:wsId/assurance/runs/:id', requireAuth, requireWorkspace, requirePermission('report.view'), (req, res) => {
    const run = loadRun(req, res); if (!run) return;
    const events = db.prepare(`SELECT ev.*,u.name AS actor_name FROM assurance_report_events ev LEFT JOIN users u ON u.id=ev.actor_id WHERE ev.run_id=? ORDER BY ev.created_at,ev.id`).all(run.id);
    const artifacts = db.prepare(`SELECT id,format,filename,content_hash,size_bytes,generated_at FROM assurance_report_artifacts WHERE run_id=? ORDER BY generated_at`).all(run.id);
    res.render('assurance_run', { user:req.user, ws:req.workspace, run, events, artifacts, caps:capabilities(req), reportHtml:reports.renderHtml(run, run.snapshot, run.quality, run.manifest) });
  });

  app.get('/workspaces/:wsId/assurance/runs/:id/preview', requireAuth, requireWorkspace, requirePermission('report.view'), (req, res) => {
    const run = loadRun(req, res); if (!run) return;
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
    res.type('html').send(reports.renderHtml(run, run.snapshot, run.quality, run.manifest));
  });

  app.post('/workspaces/:wsId/assurance/runs/:id/submit', requireAuth, requireWorkspace, requirePermission('report.generate'), (req, res) => {
    const run = loadRun(req, res); if (!run) return;
    if (run.status !== 'generated') return res.status(409).render('error', { user:req.user, ws:req.workspace, message:'Only a newly generated frozen version can enter review. Requested changes require a replacement version.' });
    const note = String(req.body.note || '').slice(0, 2000) || 'Submitted for independent review';
    const tx = db.transaction(() => {
      db.prepare(`UPDATE assurance_report_runs SET status='in_review',submitted_by=?,submitted_at=datetime('now') WHERE id=? AND workspace_id=?`).run(req.user.id, run.id, req.workspace.id);
      db.prepare(`INSERT INTO assurance_report_events (run_id,action,from_status,to_status,note,actor_id,snapshot_hash) VALUES (?,'submitted',?,'in_review',?,?,?)`).run(run.id,run.status,note,req.user.id,run.snapshot_hash);
    }); tx();
    logAction(req.user.id, req.workspace.id, 'assurance_report_submitted', 'assurance_report', run.id, { snapshot_hash:run.snapshot_hash });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/assurance/runs/${run.id}`, 'Report submitted for review'));
  });

  app.post('/workspaces/:wsId/assurance/runs/:id/request-changes', requireAuth, requireWorkspace, requirePermission('report.review'), (req, res) => {
    const run = loadRun(req, res); if (!run) return;
    if (run.status !== 'in_review') return res.status(409).render('error', { user:req.user, ws:req.workspace, message:'Only reports in review can have changes requested.' });
    const note = String(req.body.note || '').trim().slice(0, 4000);
    if (!note) return res.status(400).render('error', { user:req.user, ws:req.workspace, message:'A change request must explain what needs to change.' });
    const tx = db.transaction(() => {
      db.prepare(`UPDATE assurance_report_runs SET status='changes_requested',reviewed_by=?,reviewed_at=datetime('now') WHERE id=? AND workspace_id=?`).run(req.user.id,run.id,req.workspace.id);
      db.prepare(`INSERT INTO assurance_report_events (run_id,action,from_status,to_status,note,actor_id,snapshot_hash) VALUES (?,'changes_requested','in_review','changes_requested',?,?,?)`).run(run.id,note,req.user.id,run.snapshot_hash);
    }); tx();
    logAction(req.user.id, req.workspace.id, 'assurance_report_changes_requested', 'assurance_report', run.id, { note, snapshot_hash:run.snapshot_hash });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/assurance/runs/${run.id}`, 'Changes requested'));
  });

  app.post('/workspaces/:wsId/assurance/runs/:id/approve', requireAuth, requireWorkspace, requirePermission('report.approve'), (req, res) => {
    const run = loadRun(req, res); if (!run) return;
    if (run.status !== 'in_review') return res.status(409).render('error', { user:req.user, ws:req.workspace, message:'Only reports in review can be approved.' });
    if (Number(run.created_by) === Number(req.user.id)) return res.status(409).render('error', { user:req.user, ws:req.workspace, message:'Maker-checker control: the report creator cannot approve the same report.' });
    const note = String(req.body.note || '').trim().slice(0, 4000) || 'Report approved against the frozen snapshot';
    const tx = db.transaction(() => {
      db.prepare(`UPDATE assurance_report_runs SET status='approved',reviewed_by=?,reviewed_at=datetime('now'),approved_by=?,approved_at=datetime('now'),approval_note=? WHERE id=? AND workspace_id=?`).run(req.user.id,req.user.id,note,run.id,req.workspace.id);
      db.prepare(`INSERT INTO assurance_report_events (run_id,action,from_status,to_status,note,actor_id,snapshot_hash) VALUES (?,'approved','in_review','approved',?,?,?)`).run(run.id,note,req.user.id,run.snapshot_hash);
    }); tx();
    logAction(req.user.id, req.workspace.id, 'assurance_report_approved', 'assurance_report', run.id, { snapshot_hash:run.snapshot_hash });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/assurance/runs/${run.id}`, 'Report approved'));
  });

  app.post('/workspaces/:wsId/assurance/runs/:id/publish', requireAuth, requireWorkspace, requirePermission('report.publish'), (req, res) => {
    const run = loadRun(req, res); if (!run) return;
    if (run.status !== 'approved') return res.status(409).render('error', { user:req.user, ws:req.workspace, message:'Only approved reports can be published.' });
    const note = String(req.body.note || '').trim().slice(0, 2000) || 'Approved report published';
    const tx = db.transaction(() => {
      const older = db.prepare(`SELECT id,status,snapshot_hash FROM assurance_report_runs WHERE workspace_id=? AND definition_id=? AND id<>? AND status='published' AND COALESCE(supplier_id,0)=COALESCE(?,0)`).all(req.workspace.id,run.definition_id,run.id,run.supplier_id);
      for (const previous of older) {
        db.prepare(`UPDATE assurance_report_runs SET status='superseded',superseded_at=datetime('now') WHERE id=?`).run(previous.id);
        db.prepare(`INSERT INTO assurance_report_events (run_id,action,from_status,to_status,note,actor_id,snapshot_hash) VALUES (?,'superseded','published','superseded',?,?,?)`).run(previous.id,`Superseded by report version ${run.version_number}`,req.user.id,previous.snapshot_hash);
      }
      db.prepare(`UPDATE assurance_report_runs SET status='published',published_by=?,published_at=datetime('now') WHERE id=? AND workspace_id=?`).run(req.user.id,run.id,req.workspace.id);
      db.prepare(`INSERT INTO assurance_report_events (run_id,action,from_status,to_status,note,actor_id,snapshot_hash) VALUES (?,'published','approved','published',?,?,?)`).run(run.id,note,req.user.id,run.snapshot_hash);
    }); tx();
    logAction(req.user.id, req.workspace.id, 'assurance_report_published', 'assurance_report', run.id, { snapshot_hash:run.snapshot_hash });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/assurance/runs/${run.id}`, 'Report published'));
  });

  for (const format of ['pdf','docx','json']) {
    app.get(`/workspaces/:wsId/assurance/runs/:id/${format}`, requireAuth, requireWorkspace, requirePermission('report.export'), async (req, res) => {
      const run = loadRun(req, res); if (!run) return;
      try {
        const artifact = await reports.getOrCreateArtifact(db, run, format, req.user.id);
        logAction(req.user.id, req.workspace.id, 'assurance_report_exported', 'assurance_report', run.id, { format, artifact_hash:artifact.content_hash, snapshot_hash:run.snapshot_hash });
        res.setHeader('Content-Type', artifact.mime_type);
        res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
        res.setHeader('ETag', `"${artifact.content_hash}"`);
        res.send(artifact.content_blob);
      } catch (err) {
        console.error(`assurance ${format} error:`, err);
        res.status(500).render('error', { user:req.user, ws:req.workspace, message:`Could not generate the ${format.toUpperCase()} artifact.` });
      }
    });
  }
}

module.exports = { register };
