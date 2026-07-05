'use strict';
// Workspace operations, batch A (long-tail pass): comments + mentions data,
// assets + CSV import, cert-cycle calendar, gap-assessment DOCX report,
// tasks, activity log + CSV export.

const fts = require('../lib/fts');
const enc = require('../lib/encryption');
const ctlReads = require('../lib/control-reads');
const csvImport = require('../lib/csv-import');
const { ymdLocal, ymLocal } = require('../lib/dates');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, escapeHtml } = require('../lib/http-helpers');
const generateDocxBuffer = require('../lib/workers').generateDocx;
const htmlToDocxPooled = require('../lib/workers').htmlToDocxPooled;

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          csvUpload, activeEntityFilter, extractMentions, getOrCreateState, isFirmUser } = deps;

  // ==================== COMMENTS ====================
  app.post('/workspaces/:wsId/comments', requireAuth, requireWorkspace, requirePermission('comment.create'), (req, res) => {
    const { parent_type, parent_id, body, internal_only } = req.body;
    if (!body || !parent_type || !parent_id) return redirectBack(req, res);
    const internal = (internal_only === '1' && isFirmUser(req.user)) ? 1 : 0;
    const trimmedBody = body.trim();
    const insResult = db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, parent_type, parent_id, req.user.id,
           enc.encryptIfNeeded(trimmedBody, req.workspace.id, !!req.workspace.encryption_enabled),
           internal);
    const commentId = insResult.lastInsertRowid;

    // Parse @-mentions from the plaintext body, resolve handles to users in
    // the same firm, insert comment_mentions rows, fire notifications.
    // Handles match the user's full name with whitespace removed, case-
    // insensitive. Cannot mention yourself. Used to be a separate route at
    // /comments/:id/mentions that nothing ever called - hence the bug where
    // typing @priyasharma in the comment box notified no one.
    const handles = extractMentions(trimmedBody);
    if (handles.length) {
      const users = db.prepare(`SELECT id, name FROM users WHERE active=1 AND firm_id=?`).all(req.user.firm_id);
      const insMention = db.prepare(`INSERT OR IGNORE INTO comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?)`);
      let mentioned = 0;
      for (const h of handles) {
        const target = users.find(u => u.name.toLowerCase().replace(/\s+/g, '') === h.toLowerCase());
        if (target && target.id !== req.user.id) {
          insMention.run(commentId, target.id);
          mentioned++;
          try {
            jobs.notify(req.workspace.id, target.id, 'mention', 'info',
              `@${h} you were mentioned`, trimmedBody.slice(0, 140),
              `/workspaces/${req.workspace.id}`);
          } catch (_) {}
        }
      }
      if (mentioned > 0) db.prepare(`UPDATE comments SET has_mentions=1 WHERE id=?`).run(commentId);
    }

    logAction(req.user.id, req.workspace.id, 'add_comment', parent_type, parent_id, { internal }, auditCtx(req));
    const back = req.headers.referer || '/workspaces/' + req.workspace.id;
    res.redirect(back);
  });

  // ==================== EVIDENCE ====================

  // ==================== ASSETS ====================
  app.get('/workspaces/:wsId/assets', requireAuth, requireWorkspace, requirePermission('asset.view'), (req, res) => {
    const ef = activeEntityFilter(req);
    const assets = db.prepare(`SELECT a.*, e.name AS entity_name FROM assets a
      LEFT JOIN entities e ON e.id = a.entity_id
      WHERE a.workspace_id = ?${ef.sql.replace('entity_id', 'a.entity_id')} ORDER BY a.name`)
      .all(req.workspace.id, ...ef.params);
    res.render('assets', { user: req.user, ws: req.workspace, assets });
  });

  app.post('/workspaces/:wsId/assets', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
    const { name, type, classification, owner_name, cia_c, cia_i, cia_a, description,
            business_criticality, rto_hours, rpo_hours, bia_notes } = req.body;
    if (!name) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO assets
      (workspace_id, name, type, classification, owner_name, cia_c, cia_i, cia_a, description,
       business_criticality, rto_hours, rpo_hours, bia_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, name.trim(), type || null, classification || null, owner_name || null,
           parseInt(cia_c) || 1, parseInt(cia_i) || 1, parseInt(cia_a) || 1, description || null,
           business_criticality || null,
           rto_hours !== undefined && rto_hours !== '' ? parseInt(rto_hours, 10) : null,
           rpo_hours !== undefined && rpo_hours !== '' ? parseInt(rpo_hours, 10) : null,
           bia_notes || null).lastInsertRowid;
    fts.refresh(req.workspace.id, 'asset', id);
    logAction(req.user.id, req.workspace.id, 'create_asset', 'asset', id, { name }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/assets', 'Asset added'));
  });

  app.post('/workspaces/:wsId/assets/:id/delete', requireAuth, requireWorkspace, requirePermission('asset.delete'), (req, res) => {
    const before = db.prepare('SELECT name FROM assets WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    db.prepare('DELETE FROM assets WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
    fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'asset', entityId: req.params.id });
    if (before) logAction(req.user.id, req.workspace.id, 'delete_asset', 'asset', req.params.id, { name: before.name }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/assets');
  });

  // ==================== ASSETS: CSV IMPORT ====================
  // Three-step pipeline: GET shows the upload page, POST /preview parses +
  // validates without writing, POST /commit revalidates and inserts in a single
  // transaction so a partial failure leaves the register untouched.
  app.get('/workspaces/:wsId/assets/import', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
    res.render('import', {
      user: req.user, ws: req.workspace,
      schema: csvImport.ASSET_SCHEMA, kind: 'assets',
      mode: 'upload', result: null, csv: '', filename: '',
      backUrl: `/workspaces/${req.workspace.id}/assets`,
      listUrl: `/workspaces/${req.workspace.id}/assets`,
      templateUrl: `/workspaces/${req.workspace.id}/assets/import/template`,
      previewUrl: `/workspaces/${req.workspace.id}/assets/import/preview`,
      commitUrl: `/workspaces/${req.workspace.id}/assets/import/commit`,
      importUrl: `/workspaces/${req.workspace.id}/assets/import`
    });
  });

  app.get('/workspaces/:wsId/assets/import/template', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="assets_template.csv"');
    res.send(csvImport.buildTemplate(csvImport.ASSET_SCHEMA));
  });

  app.post('/workspaces/:wsId/assets/import/preview', requireAuth, requireWorkspace, requirePermission('asset.create'), csvUpload.single('file'), (req, res) => {
    let csv = '';
    let filename = '';
    if (req.file && req.file.buffer) {
      csv = req.file.buffer.toString('utf8');
      filename = req.file.originalname || 'upload.csv';
    } else if (req.body.csv) {
      csv = String(req.body.csv);
      filename = 'pasted.csv';
    }
    const result = csvImport.processFile(csv, csvImport.ASSET_SCHEMA, {});
    res.render('import', {
      user: req.user, ws: req.workspace,
      schema: csvImport.ASSET_SCHEMA, kind: 'assets',
      mode: 'preview', result, csv, filename,
      backUrl: `/workspaces/${req.workspace.id}/assets`,
      listUrl: `/workspaces/${req.workspace.id}/assets`,
      templateUrl: `/workspaces/${req.workspace.id}/assets/import/template`,
      previewUrl: `/workspaces/${req.workspace.id}/assets/import/preview`,
      commitUrl: `/workspaces/${req.workspace.id}/assets/import/commit`,
      importUrl: `/workspaces/${req.workspace.id}/assets/import`
    });
  });

  app.post('/workspaces/:wsId/assets/import/commit', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
    const csv = String(req.body.csv || '');
    if (!csv.trim()) return res.redirect(`/workspaces/${req.workspace.id}/assets/import`);
    const result = csvImport.processFile(csv, csvImport.ASSET_SCHEMA, {});
    const valid = result.rows.filter(r => r.valid);
    if (!valid.length) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/assets/import`, 'Nothing to import - all rows had errors', 'error'));
    }
    const ins = db.prepare(`INSERT INTO assets
      (workspace_id, entity_id, name, type, classification, owner_name, cia_c, cia_i, cia_a, description,
       business_criticality, rto_hours, rpo_hours, bia_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const importedAssetIds = [];
    const tx = db.transaction(() => {
      valid.forEach(r => {
        const p = r.parsed;
        const info = ins.run(
          req.workspace.id,
          req.entityScopeId || null,
          p.name,
          p.type || null,
          p.classification || null,
          p.owner_name || null,
          p.cia_c == null ? 2 : p.cia_c,
          p.cia_i == null ? 2 : p.cia_i,
          p.cia_a == null ? 2 : p.cia_a,
          p.description || null,
          p.business_criticality || null,
          p.rto_hours == null ? null : p.rto_hours,
          p.rpo_hours == null ? null : p.rpo_hours,
          p.bia_notes || null
        );
        importedAssetIds.push(info.lastInsertRowid);
      });
    });
    tx();
    importedAssetIds.forEach(id => fts.refresh(req.workspace.id, 'asset', id));
    logAction(req.user.id, req.workspace.id, 'import_assets_csv', 'asset', null, { count: valid.length, skipped: result.summary.invalid }, auditCtx(req));
    const msg = result.summary.invalid
      ? `Imported ${valid.length} asset${valid.length === 1 ? '' : 's'} - ${result.summary.invalid} row${result.summary.invalid === 1 ? '' : 's'} skipped`
      : `Imported ${valid.length} asset${valid.length === 1 ? '' : 's'}`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/assets`, msg));
  });


  // ==================== TIER 1.3 - CERT CYCLE CALENDAR ====================
  // Stage 1 → Stage 2 → annual surveillance → 3-year recertification.
  // Most consultants miss the post-cert lifecycle; this surfaces it.
  const CERT_EVENT_TYPES = [
    { key: 'stage_1', label: 'Stage 1 audit', desc: 'Documentation review' },
    { key: 'stage_2', label: 'Stage 2 audit', desc: 'Implementation audit (cert decision)' },
    { key: 'surveillance_y1', label: 'Surveillance audit (Year 1)', desc: 'First annual surveillance' },
    { key: 'surveillance_y2', label: 'Surveillance audit (Year 2)', desc: 'Second annual surveillance' },
    { key: 'recertification', label: 'Recertification audit', desc: 'Full cycle reset (Year 3)' }
  ];

  app.get('/workspaces/:wsId/cert-cycle', requireAuth, requireWorkspace, (req, res) => {
    const events = db.prepare(`SELECT * FROM cert_cycle_events
      WHERE workspace_id=? ORDER BY planned_date IS NULL, planned_date`).all(req.workspace.id);
    // Auto-suggest a default cycle if no events exist yet - Stage 1 in 60 days,
    // Stage 2 30 days after, surveillance year 1 = 12 months from Stage 2, etc.
    const today = new Date();
    const suggestions = events.length ? [] : (() => {
      const s1 = new Date(today); s1.setDate(s1.getDate() + 60);
      const s2 = new Date(s1); s2.setDate(s2.getDate() + 30);
      const sy1 = new Date(s2); sy1.setFullYear(sy1.getFullYear() + 1);
      const sy2 = new Date(sy1); sy2.setFullYear(sy2.getFullYear() + 1);
      const recert = new Date(s2); recert.setFullYear(recert.getFullYear() + 3);
      return [
        { event_type: 'stage_1',          planned_date: s1.toISOString().slice(0,10) },
        { event_type: 'stage_2',          planned_date: s2.toISOString().slice(0,10) },
        { event_type: 'surveillance_y1',  planned_date: sy1.toISOString().slice(0,10) },
        { event_type: 'surveillance_y2',  planned_date: sy2.toISOString().slice(0,10) },
        { event_type: 'recertification',  planned_date: recert.toISOString().slice(0,10) }
      ];
    })();
    res.render('cert_cycle', { user: req.user, ws: req.workspace, events, suggestions, eventTypes: CERT_EVENT_TYPES });
  });

  app.post('/workspaces/:wsId/cert-cycle', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { event_type, planned_date, certification_body, notes } = req.body;
    if (!event_type || !CERT_EVENT_TYPES.find(t => t.key === event_type)) return redirectBack(req, res);
    db.prepare(`INSERT INTO cert_cycle_events (workspace_id, event_type, planned_date, certification_body, notes)
                VALUES (?, ?, ?, ?, ?)`).run(
      req.workspace.id, event_type, planned_date || null, certification_body || null, notes || null
    );
    logAction(req.user.id, req.workspace.id, 'add_cert_event', 'cert_cycle', null, { event_type, planned_date }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
  });

  app.post('/workspaces/:wsId/cert-cycle/seed', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    // Insert all five suggested events from the no-events fallback above.
    const today = new Date();
    const s1 = new Date(today); s1.setDate(s1.getDate() + 60);
    const s2 = new Date(s1); s2.setDate(s2.getDate() + 30);
    const sy1 = new Date(s2); sy1.setFullYear(sy1.getFullYear() + 1);
    const sy2 = new Date(sy1); sy2.setFullYear(sy2.getFullYear() + 1);
    const recert = new Date(s2); recert.setFullYear(recert.getFullYear() + 3);
    const ins = db.prepare(`INSERT INTO cert_cycle_events (workspace_id, event_type, planned_date) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => {
      ins.run(req.workspace.id, 'stage_1',          s1.toISOString().slice(0,10));
      ins.run(req.workspace.id, 'stage_2',          s2.toISOString().slice(0,10));
      ins.run(req.workspace.id, 'surveillance_y1',  sy1.toISOString().slice(0,10));
      ins.run(req.workspace.id, 'surveillance_y2',  sy2.toISOString().slice(0,10));
      ins.run(req.workspace.id, 'recertification',  recert.toISOString().slice(0,10));
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'seed_cert_cycle', 'cert_cycle', null, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
  });

  app.post('/workspaces/:wsId/cert-cycle/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { planned_date, actual_date, status, certification_body, notes } = req.body;
    db.prepare(`UPDATE cert_cycle_events SET
      planned_date=?, actual_date=?, status=?, certification_body=?, notes=?
      WHERE id=? AND workspace_id=?`).run(
      planned_date || null, actual_date || null, status || 'planned',
      certification_body || null, notes || null,
      req.params.id, req.workspace.id
    );
    res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
  });

  app.post('/workspaces/:wsId/cert-cycle/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM cert_cycle_events WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
  });

  // ==================== TIER 2.7 - GAP ASSESSMENT REPORT (DOCX) ====================
  // Renders the post-assessment summary as a downloadable DOCX. Replaces the
  // 2–4 hours of manual report-writing per gap assessment.
  app.get('/workspaces/:wsId/controls/assess/summary.docx', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
    const wsId = req.workspace.id;

    const dist = { Implemented: 0, 'Partially Implemented': 0, 'Work In Progress': 0, 'Not Implemented': 0, 'Not Applicable': 0, 'Not Assessed': 0 };
    const Tg = ctlReads.tables(db, wsId);
    db.prepare(`SELECT COALESCE(cs.status,'Not Assessed') AS s, COUNT(*) AS c FROM iso_items i
      LEFT JOIN ${Tg.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control') GROUP BY s`).all(wsId).forEach(r => { dist[r.s] = r.c; });
    const total = Object.values(dist).reduce((a,b) => a+b, 0);

    const gaps = db.prepare(`SELECT i.id, i.type, i.title, cs.status, cs.maturity, cs.scope_pct, cs.notes
      FROM iso_items i INNER JOIN ${Tg.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control')
        AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
      ORDER BY i.sort_order`).all(wsId);

    const evidenceAsks = db.prepare(`SELECT i.id, i.title FROM iso_items i
      INNER JOIN ${Tg.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control') AND cs.status='Implemented'
        AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
      ORDER BY i.sort_order`).all(wsId, wsId);

    const today = new Date().toISOString().slice(0,10);
    const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const refCode = id => id.replace('annex-','').replace('clause-','').toUpperCase();

    const sevColor = (status) => status === 'Not Implemented' ? '#b91c1c' : status === 'Partially Implemented' ? '#a16207' : '#ea580c';

    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #111; }
      h1 { font-size: 22pt; margin-bottom: 4pt; }
      h2 { font-size: 14pt; margin-top: 20pt; margin-bottom: 6pt; border-bottom: 1pt solid #ccc; padding-bottom: 4pt; }
      h3 { font-size: 12pt; margin-top: 14pt; margin-bottom: 4pt; }
      table { border-collapse: collapse; width: 100%; margin-top: 8pt; font-size: 10pt; }
      th, td { border: 1pt solid #ccc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
      th { background: #f3f4f6; font-weight: bold; }
      .meta { color: #666; font-size: 10pt; }
      .tag { font-size: 9pt; font-weight: bold; padding: 1pt 6pt; color: white; }
    </style></head><body>`;

    html += `<h1>Gap Assessment Report</h1>`;
    html += `<p class="meta"><strong>${esc(req.workspace.client_name)}</strong> · Generated ${today}</p>`;

    html += `<h2>1. Executive summary</h2>`;
    html += `<p>This report summarises the current-state gap assessment of the Information Security Management System (ISMS) against ISO 27001:2022. The assessment covered ${total} items: ${dist.Implemented} fully implemented, ${dist['Partially Implemented']} partially implemented, ${dist['Work In Progress']} in progress, ${dist['Not Implemented']} not yet implemented, ${dist['Not Applicable']} not applicable, ${dist['Not Assessed']} not yet assessed.</p>`;

    html += `<h2>2. Status distribution</h2>`;
    html += `<table><tr><th>Status</th><th>Count</th><th>% of total</th></tr>`;
    ['Implemented','Partially Implemented','Work In Progress','Not Implemented','Not Applicable','Not Assessed'].forEach(s => {
      const c = dist[s] || 0;
      const pct = total ? Math.round(c / total * 100) : 0;
      html += `<tr><td>${esc(s)}</td><td>${c}</td><td>${pct}%</td></tr>`;
    });
    html += `</table>`;

    html += `<h2>3. Identified gaps (${gaps.length})</h2>`;
    if (gaps.length === 0) {
      html += `<p>No gaps in Not Implemented / Partially Implemented / Work In Progress state.</p>`;
    } else {
      html += `<table><tr><th>ID</th><th>Title</th><th>Status</th><th>Maturity</th><th>Scope %</th><th>Notes</th></tr>`;
      gaps.forEach(g => {
        const cleanTitle = g.title.replace(/^A\.[0-9.]+ /,'').replace(/^[0-9.]+ /,'');
        html += `<tr><td>${esc(refCode(g.id))}</td><td>${esc(cleanTitle)}</td><td><span class="tag" style="background:${sevColor(g.status)}">${esc(g.status)}</span></td><td>${g.maturity != null ? g.maturity : '-'}</td><td>${g.scope_pct != null ? g.scope_pct + '%' : '-'}</td><td>${esc(g.notes || '')}</td></tr>`;
      });
      html += `</table>`;
    }

    html += `<h2>4. Items marked Implemented without evidence (${evidenceAsks.length})</h2>`;
    if (evidenceAsks.length === 0) {
      html += `<p>Every Implemented item has at least one evidence file attached.</p>`;
    } else {
      html += `<p>The following items are marked as Implemented in the assessment but have no evidence file attached. Auditors will sample these first.</p>`;
      html += `<table><tr><th>ID</th><th>Title</th></tr>`;
      evidenceAsks.forEach(e => {
        const cleanTitle = e.title.replace(/^A\.[0-9.]+ /,'').replace(/^[0-9.]+ /,'');
        html += `<tr><td>${esc(refCode(e.id))}</td><td>${esc(cleanTitle)}</td></tr>`;
      });
      html += `</table>`;
    }

    html += `<h2>5. Recommended next steps</h2>`;
    html += `<ol>`;
    if (dist['Not Assessed'] > 0) html += `<li>Complete the gap assessment for the ${dist['Not Assessed']} item(s) still in Not Assessed state.</li>`;
    if (gaps.filter(g => g.status === 'Not Implemented').length > 0) html += `<li>Prioritise remediation of the ${gaps.filter(g => g.status === 'Not Implemented').length} Not Implemented gap(s); these block certification.</li>`;
    if (evidenceAsks.length > 0) html += `<li>Attach evidence to the ${evidenceAsks.length} Implemented item(s) currently lacking it.</li>`;
    html += `<li>Convert this report into remediation tasks via the post-assessment summary's Spawn-tasks action.</li>`;
    html += `<li>Schedule a follow-up gap assessment to verify remediation effectiveness before the Stage 1 audit.</li>`;
    html += `</ol>`;

    html += `</body></html>`;

    const buf = await require('../lib/workers').htmlToDocxPooled(html, null, { table: { row: { cantSplit: true } } });
    const filename = `Gap-Assessment-Report-${req.workspace.client_name.replace(/[^\w]/g,'_')}-${today}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  });

  app.post('/workspaces/:wsId/risks/:id', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
    const { title, description, asset_id, threat, vulnerability, likelihood, impact,
            treatment, owner_name, status, residual_likelihood, residual_impact } = req.body;
    db.prepare(`UPDATE risks SET title=?, description=?, asset_id=?, threat=?, vulnerability=?,
                likelihood=?, impact=?, treatment=?, owner_name=?, status=?,
                residual_likelihood=?, residual_impact=?
                WHERE id=? AND workspace_id=?`)
      .run(title, description || null, asset_id || null, threat || null, vulnerability || null,
           parseInt(likelihood) || 3, parseInt(impact) || 3,
           treatment || 'modify', owner_name || null, status || 'open',
           residual_likelihood ? parseInt(residual_likelihood) : null,
           residual_impact ? parseInt(residual_impact) : null,
           req.params.id, req.workspace.id);
    fts.refresh(req.workspace.id, 'risk', req.params.id);
    logAction(req.user.id, req.workspace.id, 'update_risk', 'risk', req.params.id, null);
    res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
  });

  app.post('/workspaces/:wsId/risks/:id/link', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
    const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    const { iso_item_id } = req.body;
    if (iso_item_id) {
      try {
        db.prepare('INSERT INTO risk_controls (risk_id, iso_item_id) VALUES (?, ?)')
          .run(req.params.id, iso_item_id);
        // Auto-mark control as included in SoA when a risk drives it.
        // Cutover 4 (W4): converged write normalizes 'included' -> token; the WHERE
        // filter compares the converged token. 014 mirrors back to legacy.
        getOrCreateState(req.workspace.id, iso_item_id);
        const wcRl = ctlWrites.converged(db, req.workspace.id);
        const ridRl = wcRl ? ctlWrites.requirementId(db, 'iso27001', iso_item_id) : null;
        if (wcRl && ridRl) {
          db.prepare(`UPDATE control_instances SET applicability=?
                      WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND applicability=?`)
            .run(ctlWrites.normApplic('included'), req.workspace.id, ridRl, ctlWrites.normApplic('undecided'));
        } else {
          db.prepare(`UPDATE control_states SET applicability = 'included'
                      WHERE workspace_id = ? AND iso_item_id = ? AND applicability = 'undecided'`)
            .run(req.workspace.id, iso_item_id);
        }
      } catch (e) { /* dup */ }
    }
    res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
  });

  app.post('/workspaces/:wsId/risks/:id/unlink', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
    const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    db.prepare('DELETE FROM risk_controls WHERE risk_id = ? AND iso_item_id = ?')
      .run(req.params.id, req.body.iso_item_id);
    res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
  });

  app.post('/workspaces/:wsId/risks/:id/delete', requireAuth, requireWorkspace, requirePermission('risk.delete'), (req, res) => {
    db.prepare('DELETE FROM risks WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
    fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'risk', entityId: req.params.id });
    res.redirect('/workspaces/' + req.workspace.id + '/risks');
  });


  // ==================== TASKS ====================
  app.get('/workspaces/:wsId/tasks', requireAuth, requireWorkspace, (req, res) => {
    const filter = req.query.filter || 'open';
    let q = `SELECT t.*, u.name AS assignee_name, c.name AS creator_name, i.title AS iso_title
             FROM tasks t
             LEFT JOIN users u ON u.id = t.assignee_id
             LEFT JOIN users c ON c.id = t.created_by
             LEFT JOIN iso_items i ON i.id = t.iso_item_id
             WHERE t.workspace_id = ?`;
    if (filter === 'mine') q += ` AND t.assignee_id = ${req.user.id}`;
    if (filter === 'open') q += ` AND t.status NOT IN ('done')`;
    const pgT = paginate(db, req, {
      count: q.replace(/SELECT t\.\*.*?FROM tasks t/s, 'SELECT COUNT(*) c FROM tasks t'),
      rows: q + ` ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at DESC`,
      params: [req.workspace.id], perPage: 100,
    });
    const tasks = pgT.rows;
    const wsUsers = db.prepare(`SELECT u.id, u.name FROM users u
      INNER JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = ?
      UNION SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1`)
      .all(req.workspace.id, req.workspace.firm_id);
    res.render('tasks', { user: req.user, ws: req.workspace, tasks, filter, wsUsers,
      pg: pgT, pagerHref: p => pageHref(req, p) });
  });

  app.post('/workspaces/:wsId/tasks', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    const { title, description, iso_item_id, assignee_id, due_date } = req.body;
    if (!title) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, assignee_id, due_date, created_by)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, title.trim(), description || null, iso_item_id || null,
           assignee_id || null, due_date || null, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_task', 'task', id, { title });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/tasks', 'Task created'));
  });

  app.post('/workspaces/:wsId/tasks/:id', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    const { status, assignee_id, due_date, title, description } = req.body;
    const sets = []; const vals = [];
    if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
    if (assignee_id !== undefined) { sets.push('assignee_id = ?'); vals.push(assignee_id || null); }
    if (due_date !== undefined) { sets.push('due_date = ?'); vals.push(due_date || null); }
    if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
    if (description !== undefined) { sets.push('description = ?'); vals.push(description || null); }
    if (sets.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE tasks SET ${sets.join(',')} WHERE id = ? AND workspace_id = ?`).run(...vals);
      logAction(req.user.id, req.workspace.id, 'update_task', 'task', req.params.id, null);
    }
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/tasks/:id/delete', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
    res.redirect('/workspaces/' + req.workspace.id + '/tasks');
  });

  // ==================== ACTIVITY / AUDIT LOG ====================
  // The standalone /activity drill-down was merged into /activity-log (which has the
  // same filters plus the Timeline / Anomalies / Verify tabs and is permission-gated).
  // Redirect, preserving any query string.
  app.get('/workspaces/:wsId/activity', requireAuth, requireWorkspace, (req, res) => {
    const i = req.originalUrl.indexOf('?');
    const qs = i >= 0 ? req.originalUrl.slice(i) : '';
    res.redirect('/workspaces/' + req.workspace.id + '/activity-log' + qs);
  });

}

module.exports = { register };
