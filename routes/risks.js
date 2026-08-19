'use strict';
// Risks cluster. Slice 5 of the server.js modularization: register + heatmap,
// starter/firm risk libraries, the AI-guided assessment wizard, and CSV import.

const fts = require('../lib/fts');
const csvImport = require('../lib/csv-import');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, parseFormArray } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          activeEntityFilter, getActiveMethodology, methodologyBand,
          seedFirmRiskLibraryIfEmpty, csvUpload } = deps;

  app.get('/workspaces/:wsId/risks', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    const ef = activeEntityFilter(req, 'r');
    // Heatmap aggregates span the FULL register; only the table paginates.
    const heatRisks = db.prepare(`SELECT likelihood, impact FROM risks r
      WHERE r.workspace_id = ?${ef.sql}`).all(req.workspace.id, ...ef.params);
    const pgRisks = paginate(db, req, {
      count: `SELECT COUNT(*) c FROM risks r WHERE r.workspace_id = ?${ef.sql}`,
      rows: `SELECT r.*, a.name AS asset_name, e.name AS entity_name FROM risks r
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN entities e ON e.id = r.entity_id
      WHERE r.workspace_id = ?${ef.sql} ORDER BY (r.likelihood * r.impact) DESC`,
      params: [req.workspace.id, ...ef.params], perPage: 100,
    });
    const assets = db.prepare('SELECT id, name FROM assets WHERE workspace_id = ? ORDER BY name').all(req.workspace.id);
    const methodology = getActiveMethodology(req.workspace.id);
    // Compute band per risk
    const enriched = pgRisks.rows.map(r => ({ ...r, band: methodologyBand(methodology, r.likelihood, r.impact) }));
    res.render('risks', { user: req.user, ws: req.workspace, risks: enriched, heatRisks, assets, methodology,
      pg: pgRisks, pagerHref: p => pageHref(req, p) });
  });

  app.post('/workspaces/:wsId/risks', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    const { title, description, asset_id, threat, vulnerability, likelihood, impact, treatment, owner_name, entity_id } = req.body;
    if (!title) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO risks (workspace_id, entity_id, title, description, asset_id, threat, vulnerability,
                           likelihood, impact, treatment, owner_name)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, entity_id || req.entityScopeId || null, title.trim(), description || null, asset_id || null,
           threat || null, vulnerability || null,
           parseInt(likelihood) || 3, parseInt(impact) || 3,
           treatment || 'modify', owner_name || null).lastInsertRowid;
    fts.refresh(req.workspace.id, 'risk', id);
    logAction(req.user.id, req.workspace.id, 'create_risk', 'risk', id, { title }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/risks/' + id, 'Risk created'));
  });

  // ==================== STARTER RISK LIBRARY ====================
  // Pre-written common ISO 27001 risks grouped by domain so a fresher can pick relevant
  // ones rather than starting from a blank form. Selected risks are bulk-inserted with
  // their suggested control links populated automatically.
  const RISK_LIBRARY = require('../data/risk-library');

  app.get('/workspaces/:wsId/risks/library', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res, nextMw) => {
    // Group by domain
    const byDomain = {};
    RISK_LIBRARY.forEach((r, idx) => { (byDomain[r.domain] = byDomain[r.domain] || []).push({ ...r, idx }); });
    res.render('risks_library', { user: req.user, ws: req.workspace, byDomain });
  });

  app.post('/workspaces/:wsId/risks/library', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    const picked = parseFormArray(req.body.pick);
    if (!picked.length) return redirectBack(req, res, 'Select at least one risk before adding to the register.', 'error');
    const ins = db.prepare(`INSERT INTO risks (workspace_id, entity_id, title, description, threat, vulnerability,
                           likelihood, impact, treatment, status)
                           VALUES (?, ?, ?, ?, ?, ?, 3, 3, 'modify', 'open')`);
    const linkCtrl = db.prepare(`INSERT OR IGNORE INTO risk_controls (risk_id, iso_item_id) VALUES (?, ?)`);
    let added = 0;
    const insertedIds = [];
    const tx = db.transaction(() => {
      picked.forEach(idxStr => {
        const r = RISK_LIBRARY[parseInt(idxStr)];
        if (!r) return;
        const rid = ins.run(req.workspace.id, req.entityScopeId || null, r.title, r.description, r.threat || null, r.vulnerability || null).lastInsertRowid;
        (r.suggested_controls || []).forEach(c => linkCtrl.run(rid, c));
        insertedIds.push(rid);
        added++;
      });
    });
    tx();
    insertedIds.forEach(id => fts.refresh(req.workspace.id, 'risk', id));
    logAction(req.user.id, req.workspace.id, 'add_risks_from_library', 'risk', null, { count: added }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/risks', `Added ${added} risk${added === 1 ? '' : 's'} from library - review and adjust scoring`));
  });

  // ==================== GUIDED (AI-ASSISTED) RISK ASSESSMENT ====================
  // A beginner-friendly wizard: confirm client context -> Claude proposes tailored,
  // audit-grade risk scenarios -> the consultant reviews / edits / keeps -> the
  // selected risks are written into the register (with Annex A control links) in a
  // single transaction. Built so a junior can run a defensible first risk
  // assessment at a client site. Degrades to fully-manual entry when AI is off.
  const ai = require('../lib/ai');
  const INTAKE = require('../data/intake-questions');

  // Readable client-context block from the workspace record + any engagement-intake
  // answers, so the consultant (and Claude) start from what's already known.
  function buildClientContext(ws) {
    const parts = [];
    if (ws.client_name) parts.push(`Client: ${ws.client_name}`);
    const sector = ws.sector || ws.industry;
    if (sector) parts.push(`Sector / industry: ${sector}`);
    if (ws.scope) parts.push(`ISMS scope: ${ws.scope}`);
    const answers = db.prepare(
      `SELECT question_id, answer FROM engagement_intake
       WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer)) > 0`
    ).all(ws.id);
    if (answers.length) {
      const byId = new Map(answers.map(a => [a.question_id, a.answer]));
      const lines = [];
      INTAKE.flatten().forEach(q => {
        if (byId.has(q.id)) lines.push(`- ${q.text}: ${String(byId.get(q.id)).trim()}`);
      });
      const answerObject = Object.fromEntries(answers.map(row => [row.question_id, row.answer]));
      INTAKE.crownJewelAnswers(answerObject).filter(item => item.number > 3).forEach(item => {
        lines.push(`- Crown jewel #${item.number}: ${item.name}`);
      });
      if (lines.length) parts.push('From the engagement intake:\n' + lines.join('\n'));
    }
    return parts.join('\n');
  }

  function annexAControls() {
    return db.prepare(`SELECT id, title FROM iso_items WHERE type='control' ORDER BY sort_order`).all();
  }

  app.get('/workspaces/:wsId/risks/guided', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    res.render('risk_guided', {
      user: req.user, ws: req.workspace,
      methodology: getActiveMethodology(req.workspace.id),
      controls: annexAControls(),
      prefillContext: buildClientContext(req.workspace),
      aiConfigured: ai.isConfigured()
    });
  });

  // JSON endpoint: ask Claude for tailored risk scenarios. Returns
  // { ok, risks:[...] } or { ok:false, error }. Control IDs are filtered to the
  // real Annex A catalogue and L/I clamped to the active scale before returning,
  // so the client only ever sees valid data.
  app.post('/workspaces/:wsId/risks/guided/suggest', requireAuth, requireWorkspace, requirePermission('risk.create'), async (req, res) => {
    if (!ai.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'AI is not configured. Add ANTHROPIC_API_KEY to enable suggestions, or add risks manually.' });
    }
    const methodology = getActiveMethodology(req.workspace.id);
    const controls = annexAControls();
    const controlIds = new Set(controls.map(c => c.id));
    const lMax = methodology.likelihood_scale.length;
    const iMax = methodology.impact_scale.length;
    const context = String(req.body.context || '').slice(0, 8000);
    let count = parseInt(req.body.count, 10) || 12;
    count = Math.max(3, Math.min(20, count));
    const existingTitles = db.prepare(`SELECT title FROM risks WHERE workspace_id=?`).all(req.workspace.id).map(r => r.title);

    try {
      const raw = await ai.suggestRisks({ context, methodology, controlCatalog: controls, count, existingTitles });
      const clamp = (v, max) => Math.max(1, Math.min(max, parseInt(v, 10) || Math.ceil(max / 2)));
      const validTreatments = new Set(['modify', 'retain', 'avoid', 'share']);
      const risks = raw.map(r => {
        const likelihood = clamp(r.likelihood, lMax);
        const impact = clamp(r.impact, iMax);
        const suggested_controls = (Array.isArray(r.suggested_controls) ? r.suggested_controls : [])
          .map(c => String(c).trim().toLowerCase())
          .filter(c => controlIds.has(c));
        return {
          title: String(r.title || '').slice(0, 300),
          threat: String(r.threat || '').slice(0, 500),
          vulnerability: String(r.vulnerability || '').slice(0, 500),
          description: String(r.description || '').slice(0, 1000),
          likelihood, impact,
          band: methodologyBand(methodology, likelihood, impact),
          likelihood_rationale: String(r.likelihood_rationale || '').slice(0, 500),
          impact_rationale: String(r.impact_rationale || '').slice(0, 500),
          why_it_matters: String(r.why_it_matters || '').slice(0, 1000),
          cia: Array.isArray(r.cia) ? r.cia.filter(x => ['Confidentiality', 'Integrity', 'Availability'].includes(x)) : [],
          treatment: validTreatments.has(r.treatment) ? r.treatment : 'modify',
          suggested_controls
        };
      }).filter(r => r.title);
      logAction(req.user.id, req.workspace.id, 'ai_suggest_risks', 'risk', null, { count: risks.length }, auditCtx(req));
      res.json({ ok: true, risks });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'AI request failed.' });
    }
  });

  // Commit the reviewed risks. The client posts a JSON payload (hidden field) of
  // the final, possibly-edited rows. We re-validate everything server-side, then
  // insert risks + Annex A control links in one transaction - the same shape the
  // starter-library import uses, so the SoA trace lights up automatically.
  app.post('/workspaces/:wsId/risks/guided/commit', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    let rows = [];
    try { rows = JSON.parse(req.body.payload || '[]'); } catch (_) { rows = []; }
    if (!Array.isArray(rows) || !rows.length) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/guided`, 'Select at least one risk to add', 'error'));
    }
    const methodology = getActiveMethodology(req.workspace.id);
    const lMax = methodology.likelihood_scale.length;
    const iMax = methodology.impact_scale.length;
    const controlIds = new Set(annexAControls().map(c => c.id));
    const clamp = (v, max) => Math.max(1, Math.min(max, parseInt(v, 10) || Math.ceil(max / 2)));
    const validTreatments = new Set(['modify', 'retain', 'avoid', 'share']);

    const ins = db.prepare(`INSERT INTO risks
      (workspace_id, entity_id, title, description, threat, vulnerability,
       likelihood, impact, treatment, owner_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`);
    const linkCtrl = db.prepare(`INSERT OR IGNORE INTO risk_controls (risk_id, iso_item_id) VALUES (?, ?)`);
    const insertedIds = [];
    let added = 0;
    const tx = db.transaction(() => {
      rows.slice(0, 50).forEach(r => {
        const title = String(r.title || '').trim().slice(0, 300);
        if (!title) return;
        const rid = ins.run(
          req.workspace.id, req.entityScopeId || null, title,
          String(r.description || '').slice(0, 2000) || null,
          String(r.threat || '').slice(0, 500) || null,
          String(r.vulnerability || '').slice(0, 500) || null,
          clamp(r.likelihood, lMax), clamp(r.impact, iMax),
          validTreatments.has(r.treatment) ? r.treatment : 'modify',
          String(r.owner_name || '').slice(0, 200) || null
        ).lastInsertRowid;
        (Array.isArray(r.suggested_controls) ? r.suggested_controls : []).forEach(c => {
          const cid = String(c).trim().toLowerCase();
          if (controlIds.has(cid)) linkCtrl.run(rid, cid);
        });
        insertedIds.push(rid);
        added++;
      });
    });
    tx();
    insertedIds.forEach(id => fts.refresh(req.workspace.id, 'risk', id));
    logAction(req.user.id, req.workspace.id, 'add_risks_guided', 'risk', null, { count: added }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, `Added ${added} risk${added === 1 ? '' : 's'} from the guided assessment`));
  });

  // ==================== RISKS: CSV IMPORT ====================
  // Same upload → preview → commit pipeline as assets, with two extras:
  //  - likelihood/impact validated against the active risk methodology scale
  //  - the "asset" column resolves by name to an existing workspace asset; if
  //    no match, the row stays valid but a warning is recorded ("will be created
  //    without an asset link") so the importer doesn't silently swallow typos.
  function riskImportContext(wsId) {
    const methodology = getActiveMethodology(wsId);
    const assets = db.prepare('SELECT id, name FROM assets WHERE workspace_id = ?').all(wsId);
    const assetsByName = new Map();
    assets.forEach(a => assetsByName.set(a.name.toLowerCase(), a));
    return { methodology, assetsByName };
  }

  app.get('/workspaces/:wsId/risks/import', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    res.render('import', {
      user: req.user, ws: req.workspace,
      schema: csvImport.RISK_SCHEMA, kind: 'risks',
      mode: 'upload', result: null, csv: '', filename: '',
      methodology: getActiveMethodology(req.workspace.id),
      backUrl: `/workspaces/${req.workspace.id}/risks`,
      listUrl: `/workspaces/${req.workspace.id}/risks`,
      templateUrl: `/workspaces/${req.workspace.id}/risks/import/template`,
      previewUrl: `/workspaces/${req.workspace.id}/risks/import/preview`,
      commitUrl: `/workspaces/${req.workspace.id}/risks/import/commit`,
      importUrl: `/workspaces/${req.workspace.id}/risks/import`
    });
  });

  app.get('/workspaces/:wsId/risks/import/template', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="risks_template.csv"');
    res.send(csvImport.buildTemplate(csvImport.RISK_SCHEMA));
  });

  app.post('/workspaces/:wsId/risks/import/preview', requireAuth, requireWorkspace, requirePermission('risk.create'), csvUpload.single('file'), (req, res) => {
    let csv = '';
    let filename = '';
    if (req.file && req.file.buffer) {
      csv = req.file.buffer.toString('utf8');
      filename = req.file.originalname || 'upload.csv';
    } else if (req.body.csv) {
      csv = String(req.body.csv);
      filename = 'pasted.csv';
    }
    const ctx = riskImportContext(req.workspace.id);
    const result = csvImport.processFile(csv, csvImport.RISK_SCHEMA, ctx);
    res.render('import', {
      user: req.user, ws: req.workspace,
      schema: csvImport.RISK_SCHEMA, kind: 'risks',
      mode: 'preview', result, csv, filename,
      methodology: ctx.methodology,
      backUrl: `/workspaces/${req.workspace.id}/risks`,
      listUrl: `/workspaces/${req.workspace.id}/risks`,
      templateUrl: `/workspaces/${req.workspace.id}/risks/import/template`,
      previewUrl: `/workspaces/${req.workspace.id}/risks/import/preview`,
      commitUrl: `/workspaces/${req.workspace.id}/risks/import/commit`,
      importUrl: `/workspaces/${req.workspace.id}/risks/import`
    });
  });

  app.post('/workspaces/:wsId/risks/import/commit', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    const csv = String(req.body.csv || '');
    if (!csv.trim()) return res.redirect(`/workspaces/${req.workspace.id}/risks/import`);
    const ctx = riskImportContext(req.workspace.id);
    const result = csvImport.processFile(csv, csvImport.RISK_SCHEMA, ctx);
    const valid = result.rows.filter(r => r.valid);
    if (!valid.length) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/import`, 'Nothing to import - all rows had errors', 'error'));
    }
    const lMid = Math.ceil(ctx.methodology.likelihood_scale.length / 2);
    const iMid = Math.ceil(ctx.methodology.impact_scale.length / 2);
    const ins = db.prepare(`INSERT INTO risks
      (workspace_id, entity_id, title, description, asset_id, threat, vulnerability,
       likelihood, impact, treatment, owner_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const importedIds = [];
    const tx = db.transaction(() => {
      valid.forEach(r => {
        const p = r.parsed;
        const info = ins.run(
          req.workspace.id,
          req.entityScopeId || null,
          p.title,
          p.description || null,
          p.asset || null,
          p.threat || null,
          p.vulnerability || null,
          p.likelihood == null ? lMid : p.likelihood,
          p.impact == null ? iMid : p.impact,
          p.treatment || 'modify',
          p.owner_name || null
        );
        importedIds.push(info.lastInsertRowid);
      });
    });
    tx();
    importedIds.forEach(id => fts.refresh(req.workspace.id, 'risk', id));
    logAction(req.user.id, req.workspace.id, 'import_risks_csv', 'risk', null, { count: valid.length, skipped: result.summary.invalid }, auditCtx(req));
    const msg = result.summary.invalid
      ? `Imported ${valid.length} risk${valid.length === 1 ? '' : 's'} - ${result.summary.invalid} row${result.summary.invalid === 1 ? '' : 's'} skipped`
      : `Imported ${valid.length} risk${valid.length === 1 ? '' : 's'}`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, msg));
  });

  app.get('/workspaces/:wsId/risks/:id', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    const risk = db.prepare(`SELECT r.*, a.name AS asset_name, e.name AS entity_name FROM risks r
      LEFT JOIN assets a ON a.id = r.asset_id
      LEFT JOIN entities e ON e.id = r.entity_id
      WHERE r.id = ? AND r.workspace_id = ?`).get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Not found');
    const linked = db.prepare(`SELECT i.* FROM risk_controls rc
      INNER JOIN iso_items i ON i.id = rc.iso_item_id
      WHERE rc.risk_id = ? ORDER BY i.sort_order`).all(risk.id);
    const allControls = db.prepare(`SELECT id, title FROM iso_items WHERE type = 'control' ORDER BY sort_order`).all();
    const assets = db.prepare('SELECT id, name FROM assets WHERE workspace_id = ?').all(req.workspace.id);
    const methodology = getActiveMethodology(req.workspace.id);
    const inherentBand = methodologyBand(methodology, risk.likelihood, risk.impact);
    const residualBand = (risk.residual_likelihood && risk.residual_impact) ? methodologyBand(methodology, risk.residual_likelihood, risk.residual_impact) : null;
    // Tier 1.1 - treatment plan actions for this risk
    const actions = db.prepare(`SELECT * FROM risk_treatment_actions
      WHERE risk_id=? AND workspace_id=?
      ORDER BY (CASE status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`).all(risk.id, req.workspace.id);
    // Tier A.2 - risk acceptance state
    const activeAcceptance = db.prepare(`SELECT * FROM risk_acceptances
      WHERE risk_id=? AND revoked_at IS NULL ORDER BY signed_at DESC LIMIT 1`).get(risk.id);
    res.render('risk_detail', { user: req.user, ws: req.workspace, risk, linked, allControls, assets, methodology, inherentBand, residualBand, actions, activeAcceptance });
  });

  // Tier 1.1 - Risk treatment plan actions (clause 6.1.3 audit-defensible workflow)
  app.post('/workspaces/:wsId/risks/:id/actions', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    const { title, description, owner_name, due_date } = req.body;
    if (!title || !title.trim()) return redirectBack(req, res);
    db.prepare(`INSERT INTO risk_treatment_actions
      (workspace_id, risk_id, title, description, owner_name, due_date, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)`).run(
      req.workspace.id, req.params.id, title.trim(), description || null,
      owner_name || null, due_date || null, req.user.id
    );
    logAction(req.user.id, req.workspace.id, 'add_treatment_action', 'risk', req.params.id, { title }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/risks/:id/actions/:aid', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    const { title, description, owner_name, due_date, status, residual_likelihood, residual_impact } = req.body;
    const closedAt = status === 'done' ? `CURRENT_TIMESTAMP` : 'NULL';
    db.prepare(`UPDATE risk_treatment_actions SET
      title=COALESCE(?, title), description=?, owner_name=?, due_date=?, status=?,
      residual_likelihood=?, residual_impact=?,
      closed_at=CASE WHEN ?='done' AND closed_at IS NULL THEN CURRENT_TIMESTAMP ELSE closed_at END
      WHERE id=? AND risk_id=? AND workspace_id=?`).run(
      title || null, description || null, owner_name || null, due_date || null, status || 'planned',
      residual_likelihood ? parseInt(residual_likelihood) : null,
      residual_impact ? parseInt(residual_impact) : null,
      status, req.params.aid, req.params.id, req.workspace.id
    );
    // If status is 'done' and residuals are filled, propagate to the parent risk's residual fields.
    if (status === 'done' && residual_likelihood && residual_impact) {
      db.prepare(`UPDATE risks SET residual_likelihood=?, residual_impact=? WHERE id=? AND workspace_id=?`)
        .run(parseInt(residual_likelihood), parseInt(residual_impact), req.params.id, req.workspace.id);
    }
    logAction(req.user.id, req.workspace.id, 'update_treatment_action', 'risk', req.params.id, { action_id: req.params.aid, status }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/risks/:id/actions/:aid/delete', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
    db.prepare(`DELETE FROM risk_treatment_actions WHERE id=? AND risk_id=? AND workspace_id=?`)
      .run(req.params.aid, req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
  });

}

module.exports = { register };
