'use strict';
// ISO/IEC 42001 (AI management system) cluster. Slice 13 of the server.js
// modularization: catalog, intake, gap assessment, SoA + snapshots, roadmap,
// readiness, engagement plan, exec brief.

const rbac = require('../lib/rbac');
const enc = require('../lib/encryption');
const jobs = require('../lib/jobs');
const ctlReads = require('../lib/control-reads');
const ctlWrites = require('../lib/control-writes');
const docLinks = require('../lib/doc-links');
const { withToast, redirectBack, auditCtx, parseFormArray, escapeHtml } = require('../lib/http-helpers');

// getOrCreate42State + computeIso42001Readiness close over deps; server.js
// re-exports them for tooling through these refs, bound at register().
const shared = {};

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, computeReadiness } = deps;

  // ==================== ISO/IEC 42001:2023 (AI MS) ====================
  // Parallels the ISO 27001 routes but lives under /iso42001 and uses iso42001_items
  // + iso42001_control_states. Same schema shape so views can mirror the ISO 27001
  // pattern (controls, SoA, control detail). Built incrementally - catalog browser
  // and controls/SoA assessment ship first; gap/roadmap/cert-cycle/readiness/intake/
  // engagement-plan/exec-brief will follow.

  function getOrCreate42State(wsId, isoId) {
    // Post control-state demolition (migration 019): iso42001_control_states is gone.
    // Ensure the converged whole-org control_instances row, return the legacy-shaped
    // row from v_iso42001_control_states (assessment_answers / roadmap_phase are not
    // exposed; callers guard for them).
    const reqId = ctlWrites.requirementId(db, 'iso42001', isoId);
    if (reqId) {
      db.prepare('INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)')
        .run(wsId, reqId);
    }
    return db.prepare(`SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(wsId, isoId);
  }

  // Catalog browser - read-only reference page showing all 27 clauses + 38 Annex A controls.
  app.get('/workspaces/:wsId/iso42001', requireAuth, requireWorkspace, (req, res) => {
    const filter = req.query.filter || 'all';
    const search = (req.query.q || '').trim().toLowerCase();
    let rows = db.prepare(`SELECT * FROM iso42001_items ORDER BY sort_order`).all();
    if (filter === 'clauses') rows = rows.filter(r => r.type === 'clause');
    else if (filter === 'annex') rows = rows.filter(r => r.type === 'control');
    else if (filter && filter.startsWith('a-')) rows = rows.filter(r => r.category === filter);
    else if (filter && filter.startsWith('c-')) rows = rows.filter(r => r.category === filter);
    if (search) rows = rows.filter(r => r.title.toLowerCase().includes(search) || (r.summary||'').toLowerCase().includes(search));
    res.render('iso42001_catalog', { user: req.user, ws: req.workspace, rows, filter, search });
  });

  // Controls assessment grid - status, maturity, owner, due. Bulk-editable.
  app.get('/workspaces/:wsId/iso42001/controls', requireAuth, requireWorkspace, (req, res) => {
    const filter = req.query.filter || 'all';
    const search = (req.query.q || '').trim().toLowerCase();
    const T = ctlReads.tables(db, req.workspace.id);
    let rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
        cs.applicability, cs.maturity, cs.owner_id, cs.due_date,
        (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
        FROM iso42001_items i
        LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        ORDER BY i.sort_order`).all(req.workspace.id);
    if (filter === 'clauses') rows = rows.filter(r => r.type === 'clause');
    else if (filter === 'annex') rows = rows.filter(r => r.type === 'control');
    else if (filter && filter.startsWith('a-')) rows = rows.filter(r => r.category === filter);
    else if (filter === 'open') rows = rows.filter(r => ['Not Implemented','Partially Implemented','Not Assessed'].includes(r.status));
    if (search) rows = rows.filter(r => r.title.toLowerCase().includes(search) || r.id.toLowerCase().includes(search));
    res.render('iso42001_controls', { user: req.user, ws: req.workspace, rows, filter, search });
  });

  // Single-control "detail" page - merged into the gap wizard like ISO 27001 did.
  // This route is a permanent redirect so existing links keep working.
  app.get('/workspaces/:wsId/iso42001/controls/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
    // Reserved literal sub-routes (kanban, export.csv, bulk-controls, etc.) - let them fall through.
    if (['kanban', 'export.csv'].includes(req.params.isoId)) return nextMw();
    const item = db.prepare('SELECT id FROM iso42001_items WHERE id=?').get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
  });

  // Bulk update controls. Mirrors /workspaces/:wsId/bulk-controls but for ISO 42001.
  app.post('/workspaces/:wsId/iso42001/bulk-controls', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
    const ids = parseFormArray(req.body.ids);
    const { status, applicability } = req.body;
    if (!ids.length || (!status && !applicability)) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/controls`);
    // Cutover 4 (W5): converged-authoritative 42001 bulk toggle; status/applicability
    // normalized (014 mirrors each). Fail-safe to legacy when unmapped.
    const wcB42 = ctlWrites.converged(db, req.workspace.id);
    const tx = db.transaction(() => {
      for (const id of ids) {
        getOrCreate42State(req.workspace.id, id);
        const rid = wcB42 ? ctlWrites.requirementId(db, 'iso42001', id) : null;
        if (wcB42 && rid) {
          if (status) db.prepare(`UPDATE control_instances SET status=?, last_updated=CURRENT_TIMESTAMP WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(ctlWrites.normStatus(status), req.workspace.id, rid);
          if (applicability) db.prepare(`UPDATE control_instances SET applicability=?, last_updated=CURRENT_TIMESTAMP WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(ctlWrites.normApplic(applicability), req.workspace.id, rid);
        } else {
          if (status) db.prepare(`UPDATE iso42001_control_states SET status=?, last_updated=CURRENT_TIMESTAMP WHERE workspace_id=? AND iso_item_id=?`).run(status, req.workspace.id, id);
          if (applicability) db.prepare(`UPDATE iso42001_control_states SET applicability=?, last_updated=CURRENT_TIMESTAMP WHERE workspace_id=? AND iso_item_id=?`).run(applicability, req.workspace.id, id);
        }
      }
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'bulk_update_iso42001_controls', 'iso42001_item', null, { ids: ids.length, status, applicability });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/controls`);
  });

  // SoA - Statement of Applicability for the 38 Annex A controls.
  app.get('/workspaces/:wsId/iso42001/soa', requireAuth, requireWorkspace, (req, res) => {
    // Ensure converged whole-org rows for every 42001 Annex A control (iso42001_control_states
    // demolished, 019).
    db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id)
                SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                JOIN iso42001_items ii ON ii.id=rq.ref WHERE f.code='iso42001' AND ii.type='control'`).run(req.workspace.id);
    const T = ctlReads.tables(db, req.workspace.id);
    const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.inclusion_justification, cs.exclusion_justification,
        cs.last_updated
        FROM iso42001_items i
        LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type = 'control'
        ORDER BY i.sort_order`).all(req.workspace.id);

    // Risks linked to each control via iso42001_risk_controls
    const riskLinks = db.prepare(`SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title, r.likelihood, r.impact
        FROM iso42001_risk_controls rc
        INNER JOIN risks r ON r.id = rc.risk_id
        WHERE r.workspace_id = ?
        ORDER BY (r.likelihood * r.impact) DESC`).all(req.workspace.id);
    const risksByControl = {};
    riskLinks.forEach(l => { (risksByControl[l.iso_item_id] = risksByControl[l.iso_item_id] || []).push(l); });

    // Documents linked to each control (drl-native; iso42001_document_controls demolished)
    const soaDocLinks42 = db.prepare(`SELECT dc.iso_item_id, dc.section_ref, d.id AS doc_id, d.name AS doc_name, d.status AS doc_status, d.category
        FROM ${docLinks.docControlsExpr('iso42001')} dc
        INNER JOIN generated_docs d ON d.id = dc.document_id
        WHERE d.workspace_id = ?
        ORDER BY d.name`).all(req.workspace.id);
    const docsByControl = {};
    soaDocLinks42.forEach(l => { (docsByControl[l.iso_item_id] = docsByControl[l.iso_item_id] || []).push(l); });

    // Custom (non-Annex-A) controls
    const customControls = db.prepare(`SELECT * FROM iso42001_soa_custom_controls
        WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);

    // SoA metadata from latest snapshot
    const latestSnap = db.prepare(`SELECT id, label, version, owner, approved_by, approved_at, created_at
        FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(req.workspace.id);

    res.render('iso42001_soa', { user: req.user, ws: req.workspace, rows, docsByControl, risksByControl,
      customControls, soaMeta: latestSnap || {} });
  });

  // SoA snapshot capture - immutable, hashed payload.
  app.post('/workspaces/:wsId/iso42001/soa/snapshot', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const T = ctlReads.tables(db, req.workspace.id);
    const rows = db.prepare(`SELECT i.id, i.title, i.category, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.inclusion_justification, cs.exclusion_justification
        FROM iso42001_items i
        LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type = 'control'
        ORDER BY i.sort_order`).all(req.workspace.id);
    const customs = db.prepare(`SELECT * FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);
    const payload = JSON.stringify({ rows, customs });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const included = rows.filter(r => r.applicability === 'included').length + customs.filter(c => c.applicability === 'included').length;
    const excluded = rows.filter(r => r.applicability === 'excluded').length + customs.filter(c => c.applicability === 'excluded').length;
    const total = rows.length + customs.length;
    const id = db.prepare(`INSERT INTO iso42001_soa_snapshots
      (workspace_id, label, reason, version, owner, approved_by, approved_at,
       payload, payload_hash, control_count, included_count, excluded_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id,
           req.body.label || 'Manual snapshot',
           req.body.reason || null,
           req.body.version || null,
           req.body.owner || null,
           req.body.approved_by || null,
           req.body.approved_at || null,
           payload, hash, total, included, excluded, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'capture_iso42001_soa_snapshot', 'iso42001_soa_snapshot', id, { hash });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  // SoA metadata - captures version/owner/approver and auto-snapshots if none exists yet.
  app.post('/workspaces/:wsId/iso42001/soa/metadata', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    // Always create a new snapshot with the metadata - that way metadata is versioned.
    const rows = db.prepare(`SELECT i.id, i.title, i.category, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.inclusion_justification, cs.exclusion_justification
        FROM iso42001_items i
        LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type = 'control' ORDER BY i.sort_order`).all(req.workspace.id);
    const customs = db.prepare(`SELECT * FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);
    const payload = JSON.stringify({ rows, customs });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const included = rows.filter(r => r.applicability === 'included').length + customs.filter(c => c.applicability === 'included').length;
    const excluded = rows.filter(r => r.applicability === 'excluded').length + customs.filter(c => c.applicability === 'excluded').length;
    const total = rows.length + customs.length;
    db.prepare(`INSERT INTO iso42001_soa_snapshots
      (workspace_id, label, reason, version, owner, approved_by, approved_at,
       payload, payload_hash, control_count, included_count, excluded_count, created_by)
      VALUES (?, 'Metadata update', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id,
           req.body.version || null, req.body.owner || null,
           req.body.approved_by || null, req.body.approved_at || null,
           payload, hash, total, included, excluded, req.user.id);
    logAction(req.user.id, req.workspace.id, 'iso42001_soa_metadata', 'iso42001_soa_snapshot', null, req.body);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  // Auto-justify SoA: for every Annex A control that any open risk treats, mark it
  // Included and pre-fill an inclusion justification of the form "Treats {risk titles}".
  app.post('/workspaces/:wsId/iso42001/soa/auto-justify', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    // Cutover 4 (W4): converged-authoritative on a write-flipped workspace. 'included'
    // routes through normApplic; per-row 014 mirror keeps iso42001_control_states fresh.
    const wcAj42 = ctlWrites.converged(db, req.workspace.id);
    if (wcAj42) {
      db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id)
                  SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                  JOIN iso42001_items ii ON ii.id=rq.ref
                  WHERE f.code='iso42001' AND ii.type='control'`).run(req.workspace.id);
    } else {
      db.prepare(`INSERT OR IGNORE INTO iso42001_control_states (workspace_id, iso_item_id)
                  SELECT ?, id FROM iso42001_items WHERE type='control'`).run(req.workspace.id);
    }
    // For each control with at least one open risk link, build "Treats R-1, R-2..." text and mark included.
    const links = db.prepare(`SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title
        FROM iso42001_risk_controls rc
        INNER JOIN risks r ON r.id = rc.risk_id
        WHERE r.workspace_id=? AND r.status != 'closed'
        ORDER BY rc.iso_item_id, r.id`).all(req.workspace.id);
    const byCtl = {};
    links.forEach(l => { (byCtl[l.iso_item_id] = byCtl[l.iso_item_id] || []).push(l); });
    // Converged-only (iso42001_control_states demolished, 019).
    const updCi = db.prepare(`UPDATE control_instances
      SET applicability=?,
          inclusion_justification = COALESCE(NULLIF(inclusion_justification, ''), ?),
          last_updated = CURRENT_TIMESTAMP
      WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`);
    let affected = 0;
    const tx = db.transaction(() => {
      for (const [ctlId, risks] of Object.entries(byCtl)) {
        const titles = risks.map(r => `R-${r.risk_id}`).join(', ');
        const just = `Treats ${titles}`;
        const rid = ctlWrites.requirementId(db, 'iso42001', ctlId);
        if (!rid) continue;
        if (updCi.run(ctlWrites.normApplic('included'), just, req.workspace.id, rid).changes > 0) affected++;
      }
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'iso42001_soa_auto_justify', 'iso42001_item', null, { affected });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  // Custom (non-Annex-A) controls
  app.post('/workspaces/:wsId/iso42001/soa/custom-controls', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { code, title, source_framework, applicability, description, inclusion_justification } = req.body;
    if (!code || !title) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
    db.prepare(`INSERT INTO iso42001_soa_custom_controls
      (workspace_id, code, title, source, summary, applicability, inclusion_justification)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, code.trim(), title.trim(), source_framework || null,
           description || null, applicability || 'included', inclusion_justification || null);
    logAction(req.user.id, req.workspace.id, 'add_iso42001_custom_control', 'iso42001_soa_custom_control', null, { code });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  app.post('/workspaces/:wsId/iso42001/soa/custom-controls/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { code, title, source_framework, applicability, status, inclusion_justification, exclusion_justification } = req.body;
    db.prepare(`UPDATE iso42001_soa_custom_controls
      SET code=COALESCE(?, code), title=COALESCE(?, title), source=COALESCE(?, source),
          applicability=COALESCE(?, applicability), status=COALESCE(?, status),
          inclusion_justification=?, exclusion_justification=?
      WHERE id=? AND workspace_id=?`)
      .run(code || null, title || null, source_framework || null,
           applicability || null, status || null,
           inclusion_justification || null, exclusion_justification || null,
           req.params.id, req.workspace.id);
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  app.post('/workspaces/:wsId/iso42001/soa/custom-controls/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM iso42001_soa_custom_controls WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  // Snapshots list
  app.get('/workspaces/:wsId/iso42001/soa/snapshots', requireAuth, requireWorkspace, (req, res) => {
    const snapshots = db.prepare(`SELECT s.*, u.name AS created_by_name
      FROM iso42001_soa_snapshots s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.workspace_id=? ORDER BY s.created_at DESC, s.id DESC`).all(req.workspace.id);
    res.render('iso42001_soa_snapshots', { user: req.user, ws: req.workspace, snapshots });
  });

  // Snapshot diff - compare two snapshots row-by-row, surface applicability/status/justification changes.
  app.get('/workspaces/:wsId/iso42001/soa/snapshots/diff', requireAuth, requireWorkspace, (req, res) => {
    const snapshots = db.prepare(`SELECT id, label, version, created_at FROM iso42001_soa_snapshots
      WHERE workspace_id=? ORDER BY created_at DESC, id DESC`).all(req.workspace.id);
    const aId = req.query.a ? parseInt(req.query.a, 10) : (snapshots[1] ? snapshots[1].id : null);
    const bId = req.query.b ? parseInt(req.query.b, 10) : (snapshots[0] ? snapshots[0].id : null);
    let diff = null;
    if (aId && bId && aId !== bId) {
      const a = db.prepare(`SELECT * FROM iso42001_soa_snapshots WHERE id=? AND workspace_id=?`).get(aId, req.workspace.id);
      const b = db.prepare(`SELECT * FROM iso42001_soa_snapshots WHERE id=? AND workspace_id=?`).get(bId, req.workspace.id);
      if (a && b) {
        const ap = JSON.parse(a.payload);
        const bp = JSON.parse(b.payload);
        const byIdA = {}, byIdB = {};
        (ap.rows || []).forEach(r => { byIdA[r.id] = r; });
        (bp.rows || []).forEach(r => { byIdB[r.id] = r; });
        const allIds = Array.from(new Set([...Object.keys(byIdA), ...Object.keys(byIdB)]));
        const changes = [];
        for (const id of allIds) {
          const ra = byIdA[id], rb = byIdB[id];
          const fields = ['applicability', 'status', 'inclusion_justification', 'exclusion_justification'];
          const changed = fields.some(f => (ra && ra[f]) !== (rb && rb[f]));
          if (changed) {
            changes.push({ id, title: (rb && rb.title) || (ra && ra.title) || id,
              before: ra ? fields.reduce((o, f) => (o[f] = ra[f] || '', o), {}) : null,
              after:  rb ? fields.reduce((o, f) => (o[f] = rb[f] || '', o), {}) : null });
          }
        }
        diff = { a, b, changes };
      }
    }
    res.render('iso42001_soa_snapshot_diff', { user: req.user, ws: req.workspace, snapshots, aId, bId, diff });
  });

  // SoA CSV export
  app.get('/workspaces/:wsId/iso42001/export/soa.csv', requireAuth, requireWorkspace, (req, res) => {
    const T = ctlReads.tables(db, req.workspace.id);
    const rows = db.prepare(`SELECT i.id, i.title, i.category,
        COALESCE(cs.applicability,'undecided') AS applicability,
        COALESCE(cs.status,'Not Assessed') AS status,
        cs.inclusion_justification, cs.exclusion_justification
        FROM iso42001_items i
        LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type='control'
        ORDER BY i.sort_order`).all(req.workspace.id);
    const customs = db.prepare(`SELECT code, title, source, applicability, status, inclusion_justification, exclusion_justification
        FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);
    const escape = (s) => s == null ? '' : `"${String(s).replace(/"/g, '""')}"`;
    const lines = ['Code,Title,Category,Applicability,Status,Inclusion justification,Exclusion justification,Source'];
    rows.forEach(r => {
      const code = r.id.replace('ai-annex-', '').toUpperCase().replace(/-/g, '.');
      lines.push([code, r.title, r.category || '', r.applicability, r.status,
        r.inclusion_justification || '', r.exclusion_justification || '', 'ISO 42001 Annex A'].map(escape).join(','));
    });
    customs.forEach(c => {
      lines.push([c.code, c.title, '', c.applicability, c.status,
        c.inclusion_justification || '', c.exclusion_justification || '', c.source || 'Custom'].map(escape).join(','));
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="iso42001-soa-${(new Date()).toISOString().slice(0,10)}.csv"`);
    res.send(lines.join('\n'));
  });

  // Per-row SoA update.
  app.post('/workspaces/:wsId/iso42001/soa/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res, nextMw) => {
    if (['bulk'].includes(req.params.isoId)) return nextMw();
    getOrCreate42State(req.workspace.id, req.params.isoId);
    const { applicability, inclusion_justification, exclusion_justification, status } = req.body;
    // Cutover 4 (W4): converged-authoritative 42001 SoA save; applicability/status
    // normalized to tokens (014 mirrors back to iso42001_control_states).
    const wcSoa42 = ctlWrites.converged(db, req.workspace.id);
    const ridSoa42 = wcSoa42 ? ctlWrites.requirementId(db, 'iso42001', req.params.isoId) : null;
    if (wcSoa42 && ridSoa42) {
      db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification=?, exclusion_justification=?,
                  status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
        .run(ctlWrites.normApplic(applicability || 'undecided'),
             inclusion_justification || null, exclusion_justification || null,
             ctlWrites.normStatus(status || null), req.workspace.id, ridSoa42);
    } else {
      db.prepare(`UPDATE iso42001_control_states SET applicability=?, inclusion_justification=?, exclusion_justification=?,
                  status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND iso_item_id=?`)
        .run(applicability || 'undecided',
             inclusion_justification || null, exclusion_justification || null,
             status || null, req.workspace.id, req.params.isoId);
    }
    logAction(req.user.id, req.workspace.id, 'update_iso42001_soa', 'iso42001_item', req.params.isoId, null);
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  // Bulk SoA actions: include_all | include_undecided | apply_to_selected | exclude_selected.
  app.post('/workspaces/:wsId/iso42001/soa/bulk', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
    const { action, justification } = req.body;
    const ids = parseFormArray(req.body.iso_id);
    // Cutover 4 (W4): converged-authoritative 42001 bulk SoA. WHERE maps iso_item_id ->
    // requirement_id (entity_id IS NULL); applicability literals via normApplic; 014
    // fires per affected row to keep iso42001_control_states consistent.
    const wcBulk42 = ctlWrites.converged(db, req.workspace.id);
    const CTL_REQ42 = `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id JOIN iso42001_items ii ON ii.id=rq.ref WHERE f.code='iso42001' AND ii.type='control'`;
    if (wcBulk42) {
      db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id)
                  SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                  JOIN iso42001_items ii ON ii.id=rq.ref WHERE f.code='iso42001' AND ii.type='control'`).run(req.workspace.id);
    } else {
      db.prepare(`INSERT OR IGNORE INTO iso42001_control_states (workspace_id, iso_item_id)
                  SELECT ?, id FROM iso42001_items WHERE type='control'`).run(req.workspace.id);
    }
    let affected = 0;
    if (action === 'include_all') {
      affected = wcBulk42
        ? db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND entity_id IS NULL AND requirement_id IN (${CTL_REQ42})`)
            .run(ctlWrites.normApplic('included'), justification || null, req.workspace.id).changes
        : db.prepare(`UPDATE iso42001_control_states SET applicability='included', inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND iso_item_id IN (SELECT id FROM iso42001_items WHERE type='control')`)
            .run(justification || null, req.workspace.id).changes;
    } else if (action === 'include_undecided') {
      affected = wcBulk42
        ? db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND entity_id IS NULL AND applicability=? AND requirement_id IN (${CTL_REQ42})`)
            .run(ctlWrites.normApplic('included'), justification || null, req.workspace.id, ctlWrites.normApplic('undecided')).changes
        : db.prepare(`UPDATE iso42001_control_states SET applicability='included', inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND applicability='undecided' AND iso_item_id IN (SELECT id FROM iso42001_items WHERE type='control')`)
            .run(justification || null, req.workspace.id).changes;
    } else if (action === 'apply_to_selected' && ids.length) {
      const updC = db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification = ?, last_updated = CURRENT_TIMESTAMP WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`);
      const tx = db.transaction(() => ids.forEach(id => {
        const rid = ctlWrites.requirementId(db, 'iso42001', id);
        if (rid) affected += updC.run(ctlWrites.normApplic('included'), justification || null, req.workspace.id, rid).changes;
      }));
      tx();
    } else if (action === 'exclude_selected' && ids.length) {
      const updC = db.prepare(`UPDATE control_instances SET applicability=?, exclusion_justification = ?, last_updated = CURRENT_TIMESTAMP WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`);
      const tx = db.transaction(() => ids.forEach(id => {
        const rid = ctlWrites.requirementId(db, 'iso42001', id);
        if (rid) affected += updC.run(ctlWrites.normApplic('excluded'), justification || null, req.workspace.id, rid).changes;
      }));
      tx();
    }
    logAction(req.user.id, req.workspace.id, 'bulk_iso42001_soa', 'iso42001_item', null, { action, affected });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  // ==================== ISO 42001 - REMAINING PAGES ====================

  // Engagement-plan phases and intake questions for ISO 42001. Kept inline so the
  // data colocates with the views that consume it.
  const ISO42001_PLAN_PHASES = [
    { key: 'kickoff', title: 'Kickoff & discovery', summary: 'Stakeholder alignment, project charter, governance scope, success criteria.' },
    { key: 'inventory', title: 'AI system inventory & scoping', summary: 'Catalogue AI systems, classify them by lifecycle stage and impact, define AIMS scope (4.3).' },
    { key: 'context', title: 'Context & interested parties (4.1, 4.2)', summary: 'External and internal issues, role determination (provider/developer/deployer), interested-party requirements register.' },
    { key: 'policy', title: 'AI policy & governance setup (5.1, 5.2, 5.3, A.2)', summary: 'Draft and approve AI policy. Assign roles. Establish concerns-reporting channel.' },
    { key: 'risk-impact', title: 'AI risk assessment + impact assessment (6.1.2-6.1.4)', summary: 'Methodology, criteria, first AI risk assessment and AI system impact assessment per scoped AI system.' },
    { key: 'gap', title: 'Annex A gap assessment (6.1.3, A.3-A.10)', summary: 'Walk through the 38 Annex A reference controls, decide applicability, score current state.' },
    { key: 'roadmap', title: 'Roadmap & treatment plan (6.1.3, 6.2)', summary: 'Treatment plan with phased actions and AI objectives.' },
    { key: 'implementation', title: 'Control implementation (Annex A controls)', summary: 'Execute selected Annex A controls and update SoA evidence.' },
    { key: 'monitoring', title: 'Monitoring & measurement setup (9.1)', summary: 'Define metrics (performance, drift, fairness), monitoring tooling, escalation thresholds.' },
    { key: 'internal-audit', title: 'Internal audit (9.2)', summary: 'Plan and run the first internal audit. Track findings and corrective actions.' },
    { key: 'management-review', title: 'Management review (9.3)', summary: 'Conduct the management review, capture inputs/outputs.' },
    { key: 'pre-cert', title: 'Pre-certification readiness review', summary: 'Final readiness check against ISO 42001 conformance criteria; close any open gaps.' }
  ];

  const ISO42001_INTAKE_SECTIONS = [
    {
      title: 'Context & roles',
      blurb: 'Set the AIMS in the right context. Clauses 4.1, 4.2.',
      questions: [
        { id: 'org-context', text: 'How would you describe your organization\'s AI maturity (early experimentation / pilots in production / AI is core to product / AI native)?', type: 'textarea', clause: '4.1', required: true },
        { id: 'role', text: 'Which roles does the organization play with respect to AI systems in scope (provider / developer / deployer / customer / multiple)?', type: 'textarea', clause: '4.1', required: true, hint: 'Different roles bring different obligations - especially under EU AI Act.' },
        { id: 'regulatory', text: 'Which AI-specific regulations or frameworks apply (EU AI Act, NIST AI RMF, sectoral regulation, internal commitments)?', type: 'textarea', clause: '4.2', required: true },
        { id: 'interested-parties', text: 'Who are the interested parties for the AIMS (regulators, customers, employees, suppliers, affected individuals, civil-society)?', type: 'textarea', clause: '4.2', hint: 'List by category. Affected individuals - non-customers the AI decides about - are often missed.' },
      ]
    },
    {
      title: 'AI footprint',
      blurb: 'What AI is actually in scope. Clauses 4.3, A.4.',
      questions: [
        { id: 'system-count', text: 'How many AI systems are currently in production or pilot? Briefly describe the largest 3.', type: 'textarea', clause: '4.3', required: true },
        { id: 'ai-types', text: 'What types of AI are in scope (classical ML, generative AI / LLMs, computer vision, NLP, reinforcement learning, hybrid)?', type: 'text', clause: '4.3' },
        { id: 'use-cases', text: 'What are the highest-stakes AI use cases (people-affecting decisions, automated actions, safety-critical, public-facing)?', type: 'textarea', clause: '4.3' },
        { id: 'high-risk', text: 'Are any of the AI systems high-risk under the EU AI Act or equivalent classification?', type: 'text', clause: '4.2' },
        { id: 'data', text: 'What are the major data sources powering AI systems (proprietary, customer, public datasets, scraped, synthetic, third-party brokers)?', type: 'textarea', clause: 'A.7.3' },
        { id: 'third-party', text: 'Which third-party AI services are critical dependencies (foundation-model APIs, ML platforms, annotation vendors)?', type: 'textarea', clause: 'A.10.3' },
      ]
    },
    {
      title: 'Governance & risk',
      blurb: 'Current state of AI governance. Clauses 5.1, 5.3, 6.1.',
      questions: [
        { id: 'governance', text: 'What AI governance structure exists today (AI ethics board, model-review committee, ad-hoc, none)?', type: 'textarea', clause: '5.3' },
        { id: 'risk-appetite', text: 'What is the organization\'s stated risk appetite for AI (low / moderate / high / not yet defined)?', type: 'text', clause: '6.1.2' },
        { id: 'incidents', text: 'Have there been past AI incidents or near-misses (model failures, bias surfacing, safety events, complaints)?', type: 'textarea', clause: '10.2' },
        { id: 'ethics-published', text: 'Are responsible-AI principles formally published or communicated externally?', type: 'text', clause: '5.2' },
      ]
    },
    {
      title: 'Engagement scope',
      blurb: 'What this engagement will deliver.',
      questions: [
        { id: 'top-concerns', text: 'What are the top 3 concerns you want the AIMS to address?', type: 'textarea', required: true },
        { id: 'target-cert-date', text: 'Target certification date (if any)', type: 'date' },
      ]
    }
  ];
  // Flat list for easy lookup
  const ISO42001_INTAKE_QUESTIONS = ISO42001_INTAKE_SECTIONS.flatMap(s => s.questions.map(q => ({ key: q.id, label: q.text })));

  // Build a draft AIMS scope statement from intake answers.
  function buildIso42001DraftScope(answers) {
    const ans = (k) => (answers[k] || '').trim();
    const lines = [];
    lines.push('AIMS Scope (Clause 4.3) - draft from intake answers');
    lines.push('');
    if (ans('role')) lines.push(`Organizational role(s): ${ans('role')}`);
    if (ans('org-context')) lines.push(`AI maturity context: ${ans('org-context')}`);
    if (ans('system-count')) lines.push(`AI systems in scope: ${ans('system-count')}`);
    if (ans('ai-types')) lines.push(`AI types covered: ${ans('ai-types')}`);
    if (ans('use-cases')) lines.push(`Highest-stakes use cases: ${ans('use-cases')}`);
    if (ans('high-risk')) lines.push(`Regulatory classification: ${ans('high-risk')}`);
    if (ans('regulatory')) lines.push(`Applicable AI obligations: ${ans('regulatory')}`);
    if (ans('data')) lines.push(`Data sources: ${ans('data')}`);
    if (ans('third-party')) lines.push(`Third-party AI dependencies: ${ans('third-party')}`);
    if (lines.length === 2) lines.push('(answer intake questions above to generate scope)');
    return lines.join('\n');
  }

  // Mechanical question generator: turn the catalog's "applicability questions"
  // into yes/partial/no prompts. Mirrors data/assessment-questions.js for ISO 27001.
  function iso42001QuestionsFor(item) {
    let qs = [];
    try { qs = JSON.parse(item.questions || '[]'); } catch (_) {}
    return qs;
  }

  function suggestStatus42(answers, total) {
    if (!answers || !total) return null;
    const score = { yes: 1, partial: 0.5, no: 0 };
    const vals = [];
    for (let i = 0; i < total; i++) { if (answers[String(i)] != null) vals.push(answers[String(i)]); }
    if (vals.length < total) return null;
    const ratio = vals.reduce((s, v) => s + (score[v] || 0), 0) / vals.length;
    if (ratio >= 0.85) return 'Implemented';
    if (ratio >= 0.5)  return 'Partially Implemented';
    if (ratio > 0)     return 'Work In Progress';
    return 'Not Implemented';
  }

  function nextUnassessed42(wsId, afterSortOrder) {
    return db.prepare(`SELECT i.id FROM iso42001_items i
      LEFT JOIN v_iso42001_control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control')
        AND (cs.status IS NULL OR cs.status='Not Assessed')
        AND i.sort_order > ?
      ORDER BY i.sort_order LIMIT 1`).get(wsId, afterSortOrder || 0);
  }

  // --- Gap assessment ---
  app.get('/workspaces/:wsId/iso42001/gap-assessment', requireAuth, requireWorkspace, (req, res) => {
    const passes = db.prepare(`SELECT p.*, (SELECT name FROM users WHERE id = p.started_by) AS started_by_name
      FROM iso42001_assessment_passes p WHERE workspace_id=? ORDER BY pass_number DESC`).all(req.workspace.id);
    const counts = db.prepare(`SELECT
        SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS implemented,
        SUM(CASE WHEN cs.status='Partially Implemented' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN cs.status='Work In Progress' THEN 1 ELSE 0 END) AS wip,
        SUM(CASE WHEN cs.status='Not Implemented' THEN 1 ELSE 0 END) AS notimpl,
        SUM(CASE WHEN cs.status='Not Applicable' THEN 1 ELSE 0 END) AS na,
        SUM(CASE WHEN cs.status IS NULL OR cs.status='Not Assessed' THEN 1 ELSE 0 END) AS unassessed,
        COUNT(i.id) AS total
      FROM iso42001_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).get(req.workspace.id);
    res.render('iso42001_gap_assessment', { user: req.user, ws: req.workspace, passes, counts });
  });

  app.post('/workspaces/:wsId/iso42001/gap-assessment/start', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const maxPass = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n FROM iso42001_assessment_passes WHERE workspace_id=?`).get(req.workspace.id).n;
    const passId = db.prepare(`INSERT INTO iso42001_assessment_passes (workspace_id, pass_number, name, started_by)
      VALUES (?, ?, ?, ?)`).run(req.workspace.id, maxPass + 1, `Pass ${maxPass + 1}`, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'start_iso42001_pass', 'iso42001_pass', passId, null);
    const first = nextUnassessed42(req.workspace.id, 0);
    if (first) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${first.id}`);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
  });

  app.post('/workspaces/:wsId/iso42001/gap-assessment/:passId/complete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`UPDATE iso42001_assessment_passes SET status='completed', completed_at=CURRENT_TIMESTAMP
                WHERE id=? AND workspace_id=?`).run(req.params.passId, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'complete_iso42001_pass', 'iso42001_pass', req.params.passId, null);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
  });

  // Per-item gap-assessment wizard.
  app.get('/workspaces/:wsId/iso42001/gap', requireAuth, requireWorkspace, (req, res) => {
    const next = nextUnassessed42(req.workspace.id, 0);
    if (!next) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${next.id}`);
  });

  app.get('/workspaces/:wsId/iso42001/gap/:isoId', requireAuth, requireWorkspace, (req, res) => {
    const item = db.prepare(`SELECT * FROM iso42001_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).render('error', { user: req.user, message: 'Item not found.' });
    const state = getOrCreate42State(req.workspace.id, item.id);
    let savedAnswers = {};
    try { if (state.assessment_answers) savedAnswers = JSON.parse(state.assessment_answers) || {}; } catch (_) {}
    const questions = iso42001QuestionsFor(item);
    item.evidence_needed_arr = JSON.parse(item.evidence_needed || '[]');
    item.documentation_needed_arr = JSON.parse(item.documentation_needed || '[]');
    item.common_pitfalls = item.common_pitfalls ? JSON.parse(item.common_pitfalls) : null;
    item.evidence_to_look_for = item.evidence_to_look_for ? JSON.parse(item.evidence_to_look_for) : null;
    item.maturity_ladder = item.maturity_ladder ? JSON.parse(item.maturity_ladder) : null;
    item.related_items = item.related_items ? JSON.parse(item.related_items) : null;

    // Resolve related items to their titles for the chip list.
    let relatedRows = [];
    if (item.related_items && item.related_items.length) {
      const placeholders = item.related_items.map(() => '?').join(',');
      relatedRows = db.prepare(`SELECT id, title FROM iso42001_items WHERE id IN (${placeholders}) ORDER BY sort_order`).all(...item.related_items);
    }

    // Prev/next by sort_order
    const prev = db.prepare(`SELECT id, title FROM iso42001_items WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1`).get(item.sort_order);
    const next = db.prepare(`SELECT id, title FROM iso42001_items WHERE sort_order > ? ORDER BY sort_order LIMIT 1`).get(item.sort_order);

    // Two-section progress totals + position within section
    const totals = db.prepare(`SELECT
        SUM(CASE WHEN i.type='clause' THEN 1 ELSE 0 END) AS clausesTotal,
        SUM(CASE WHEN i.type='control' THEN 1 ELSE 0 END) AS controlsTotal,
        SUM(CASE WHEN i.type='clause' AND cs.status IS NOT NULL AND cs.status!='Not Assessed' THEN 1 ELSE 0 END) AS clausesAssessed,
        SUM(CASE WHEN i.type='control' AND cs.status IS NOT NULL AND cs.status!='Not Assessed' THEN 1 ELSE 0 END) AS controlsAssessed
      FROM iso42001_items i
      LEFT JOIN v_iso42001_control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).get(req.workspace.id);
    const sectionPosition = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_items WHERE type=? AND sort_order <= ?`).get(item.type, item.sort_order).c;

    // Evidence files attached to this item (reuses the existing evidence table -
    // iso_item_id is TEXT so ai-* ids coexist with ISO 27001 ids).
    const evidenceList = db.prepare(`SELECT e.*, u.name AS uploader,
      (SELECT COUNT(*) FROM evidence e2 WHERE e2.sha256 = e.sha256 AND e2.workspace_id = e.workspace_id) AS link_count
      FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id=? AND e.iso_item_id=? AND e.superseded_at IS NULL
      ORDER BY e.uploaded_at DESC`).all(req.workspace.id, item.id);

    // Open NCs linked to this control (reuses nonconformities table; its
    // iso_item_id is TEXT and FK isn't strictly enforced).
    const openNCs = db.prepare(`SELECT id, title, severity, status, due_date
      FROM nonconformities
      WHERE workspace_id=? AND iso_item_id=? AND status != 'closed'
      ORDER BY created_at DESC, id DESC`).all(req.workspace.id, item.id);

    // Linked risks - workspace risks that have been mapped to this control via
    // the parallel iso42001_risk_controls table.
    const linkedRisks = db.prepare(`SELECT r.id, r.title, r.likelihood, r.impact, r.status
      FROM iso42001_risk_controls rc
      INNER JOIN risks r ON r.id = rc.risk_id
      WHERE r.workspace_id=? AND rc.iso_item_id=?
      ORDER BY (r.likelihood * r.impact) DESC`).all(req.workspace.id, item.id);

    // Linked documents, drl-native (iso42001_document_controls demolished);
    // link_id = drl.id.
    const linkedDocs = docLinks.linkedDocsForControl(db, 'iso42001', item.id, req.workspace.id);

    // Documents this workspace has that aren't yet linked - candidates for the link dropdown.
    const linkableDocs = db.prepare(`SELECT id, name, status FROM generated_docs
      WHERE workspace_id=? AND id NOT IN (${docLinks.linkedDocIdsSubquery()})
      ORDER BY name`).all(req.workspace.id, 'iso42001', item.id);

    // Risks not yet linked to this control - candidates for the link dropdown.
    const linkableRisks = db.prepare(`SELECT id, title, likelihood, impact FROM risks
      WHERE workspace_id=? AND id NOT IN (
        SELECT risk_id FROM iso42001_risk_controls WHERE iso_item_id=?
      ) ORDER BY (likelihood * impact) DESC, title`).all(req.workspace.id, item.id);

    // Prior-pass notes: most-recent snapshot per past pass for this item.
    const priorPassNotes = db.prepare(`SELECT h.pass_id, h.notes, h.status AS item_status, h.snapshot_at,
        p.pass_number, p.name AS label, p.status AS pass_status, p.completed_at
      FROM iso42001_control_state_history h
      INNER JOIN iso42001_assessment_passes p ON p.id = h.pass_id
      WHERE h.workspace_id=? AND h.iso_item_id=? AND h.pass_id IS NOT NULL AND h.notes IS NOT NULL AND h.notes != ''
        AND h.id = (SELECT MAX(h2.id) FROM iso42001_control_state_history h2
                    WHERE h2.workspace_id=h.workspace_id AND h2.iso_item_id=h.iso_item_id AND h2.pass_id=h.pass_id)
      ORDER BY p.pass_number DESC`).all(req.workspace.id, item.id);

    // Active pass = most recent open pass (or null).
    const activePass = db.prepare(`SELECT id, pass_number, name FROM iso42001_assessment_passes
      WHERE workspace_id=? AND status='open' ORDER BY pass_number DESC LIMIT 1`).get(req.workspace.id);

    // Completion + suggested status
    const doneFlag = totals.clausesAssessed === totals.clausesTotal && totals.controlsAssessed === totals.controlsTotal;
    let suggestedStatus = null;
    try { suggestedStatus = suggestStatus42(savedAnswers, questions.length); } catch (_) {}

    // Comments + review state (parallels the ISO 27001 wizard)
    const commentsRaw42 = db.prepare(`SELECT c.id, c.body, c.internal_only, c.created_at, c.user_id, u.name AS user_name
      FROM comments c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.workspace_id=? AND c.parent_type='iso42001_item' AND c.parent_id=?
      ORDER BY c.created_at ASC`).all(req.workspace.id, item.id);
    const comments = commentsRaw42.map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
    const firmUsers = db.prepare(`SELECT id, name FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name`).all(req.workspace.firm_id);
    let requestedByName = null, reviewedByName = null;
    if (state.review_requested_by) requestedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.review_requested_by)?.name;
    if (state.reviewed_by) reviewedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.reviewed_by)?.name;
    const isReviewer = req.user.user_type === 'firm' && ['manager','senior_consultant'].includes(rbac.normalizeRole(req.user.firm_role));

    res.render('iso42001_gap_detail', { user: req.user, ws: req.workspace, item, state,
      questions, savedAnswers, suggestedStatus,
      prev, next, totals, sectionPosition, doneFlag,
      relatedRows, evidenceList, openNCs, linkedRisks, linkedDocs, linkableDocs, linkableRisks,
      priorPassNotes, activePass,
      comments, firmUsers, requestedByName, reviewedByName, isReviewer });
  });

  app.post('/workspaces/:wsId/iso42001/gap/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT * FROM iso42001_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    getOrCreate42State(req.workspace.id, item.id);

    const action = req.body.action || 'save';
    const nextItem = db.prepare(`SELECT id FROM iso42001_items WHERE sort_order > ? ORDER BY sort_order LIMIT 1`).get(item.sort_order);
    // Skip without saving - just navigate forward
    if (action === 'skip') {
      if (nextItem) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${nextItem.id}`);
      return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
    }

    // Collect answers from body (keys like q_0, q_1, ...)
    const answers = {};
    for (const k of Object.keys(req.body)) {
      if (k.startsWith('q_')) answers[k.slice(2)] = req.body[k];
    }
    const questions = iso42001QuestionsFor(item);
    const suggested = suggestStatus42(answers, questions.length);
    const { status, notes, maturity, applicability, inclusion_justification, exclusion_justification } = req.body;

    // Cutover 4 (W2, ISO 42001): on a write-flipped workspace the authoritative state
    // write goes to the converged control_instances (status/applicability normalized
    // to tokens; same COALESCE partial-update semantics, the keep-current fallback now
    // references control_instances); 014 mirrors it to iso42001_control_states.
    // assessment_answers has no converged column (deferred), so it is persisted to the
    // legacy table directly. The history INSERT below stays legacy with pass_id per the
    // Phase 4 manifest (reads `cur` from iso42001_control_states, kept fresh by 014).
    const wConverged42 = ctlWrites.converged(db, req.workspace.id);
    const wReqId42 = wConverged42 ? ctlWrites.requirementId(db, 'iso42001', item.id) : null;
    if (wConverged42 && wReqId42) {
      db.prepare(`UPDATE control_instances
                  SET status = COALESCE(?, ?, status),
                      notes = COALESCE(?, notes),
                      maturity = COALESCE(?, maturity),
                      applicability = COALESCE(?, applicability),
                      inclusion_justification = COALESCE(?, inclusion_justification),
                      exclusion_justification = COALESCE(?, exclusion_justification),
                      last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
        .run(ctlWrites.normStatus(status || null), ctlWrites.normStatus(suggested),
             notes || null,
             maturity != null && maturity !== '' ? parseInt(maturity, 10) : null,
             ctlWrites.normApplic(applicability || null),
             inclusion_justification || null,
             exclusion_justification || null,
             req.workspace.id, wReqId42);
      // assessment_answers is dead (deferred-drop, demolition 019): persistence removed.
    } else {
      db.prepare(`UPDATE iso42001_control_states
                  SET assessment_answers=?,
                      status = COALESCE(?, ?, status),
                      notes = COALESCE(?, notes),
                      maturity = COALESCE(?, maturity),
                      applicability = COALESCE(?, applicability),
                      inclusion_justification = COALESCE(?, inclusion_justification),
                      exclusion_justification = COALESCE(?, exclusion_justification),
                      last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND iso_item_id=?`)
        .run(JSON.stringify(answers),
             status || null, suggested,
             notes || null,
             maturity != null && maturity !== '' ? parseInt(maturity, 10) : null,
             applicability || null,
             inclusion_justification || null,
             exclusion_justification || null,
             req.workspace.id, item.id);
    }
    logAction(req.user.id, req.workspace.id, 'assess_iso42001', 'iso42001_item', item.id, { suggested });

    // Snapshot to history. pass_id ties the snapshot to the active pass if any.
    // Post control-state demolition (019): cur sources from the converged view
    // (iso42001_control_states is gone). The view does not expose assessment_answers
    // (dead), so the snapshot records NULL for it. History table + pass_id untouched.
    const cur = db.prepare(`SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
    const activePass = db.prepare(`SELECT id FROM iso42001_assessment_passes
      WHERE workspace_id=? AND status='open' ORDER BY pass_number DESC LIMIT 1`).get(req.workspace.id);
    db.prepare(`INSERT INTO iso42001_control_state_history
      (workspace_id, iso_item_id, pass_id, changed_by, status, applicability, maturity,
       inclusion_justification, exclusion_justification, notes, assessment_answers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, item.id, activePass ? activePass.id : null, req.user.id,
           cur.status, cur.applicability, cur.maturity,
           cur.inclusion_justification, cur.exclusion_justification,
           cur.notes, null);

    if (action === 'save' && nextItem) {
      return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${nextItem.id}`);
    }
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
  });

  // --- Linkage POST routes: connect risks/docs to ISO 42001 controls ---
  app.post('/workspaces/:wsId/iso42001/controls/:isoId/documents', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { document_id, section_ref } = req.body;
    if (!document_id) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
    // Sanity check the doc belongs to this workspace.
    const doc = db.prepare(`SELECT id FROM generated_docs WHERE id=? AND workspace_id=?`).get(document_id, req.workspace.id);
    if (!doc) return res.status(404).send('Document not found');
    // drl-native 42001 doc-link (iso42001_document_controls demolished).
    docLinks.addLink(db, 'iso42001', document_id, req.params.isoId, section_ref || null);
    logAction(req.user.id, req.workspace.id, 'link_iso42001_doc', 'iso42001_item', req.params.isoId, { document_id });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
  });

  // ---- ISO 42001 flag-for-review (parallels the ISO 27001 routes above) ----
  app.post('/workspaces/:wsId/iso42001/gap/:isoId/flag-for-review', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT id FROM iso42001_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    // Review-convergence: converged write when control_writes_converged (014 mirrors).
    getOrCreate42State(req.workspace.id, item.id);
    const wcFr42 = ctlWrites.converged(db, req.workspace.id);
    const ridFr42 = wcFr42 ? ctlWrites.requirementId(db, 'iso42001', item.id) : null;
    if (wcFr42 && ridFr42) {
      db.prepare(`UPDATE control_instances
        SET review_status='requested', review_requested_by=?, review_requested_at=CURRENT_TIMESTAMP, review_reason=?,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
        .run(req.user.id, req.body.reason || null, req.workspace.id, ridFr42);
    } else {
      db.prepare(`UPDATE iso42001_control_states
        SET review_status='requested', review_requested_by=?, review_requested_at=CURRENT_TIMESTAMP, review_reason=?,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND iso_item_id=?`)
        .run(req.user.id, req.body.reason || null, req.workspace.id, item.id);
    }
    logAction(req.user.id, req.workspace.id, 'flag_for_review', 'iso42001_item', item.id, { reason: req.body.reason }, auditCtx(req));
    deps.notifyReviewers(req.workspace.id, req.user.id, item, req.body.reason, 'iso42001');
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
  });

  app.post('/workspaces/:wsId/iso42001/gap/:isoId/review-action', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT id FROM iso42001_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    const action = req.body.action;
    if (!['approve', 'send_back'].includes(action)) return res.status(400).send('Bad action');
    const newStatus = action === 'approve' ? 'reviewed' : 'needs_changes';
    // Review-convergence: converged write + read when control_writes_converged.
    const wcRa42 = ctlWrites.converged(db, req.workspace.id);
    const ridRa42 = wcRa42 ? ctlWrites.requirementId(db, 'iso42001', item.id) : null;
    let cur;
    if (wcRa42 && ridRa42) {
      cur = db.prepare(`SELECT review_requested_by FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(req.workspace.id, ridRa42);
      db.prepare(`UPDATE control_instances SET review_status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
        WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(newStatus, req.user.id, req.workspace.id, ridRa42);
    } else {
      cur = db.prepare(`SELECT review_requested_by FROM iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
      db.prepare(`UPDATE iso42001_control_states SET review_status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
        WHERE workspace_id=? AND iso_item_id=?`).run(newStatus, req.user.id, req.workspace.id, item.id);
    }
    logAction(req.user.id, req.workspace.id, 'review_action', 'iso42001_item', item.id, { action, note: req.body.note }, auditCtx(req));
    if (cur && cur.review_requested_by && cur.review_requested_by !== req.user.id) {
      const code = item.id.replace('ai-annex-','').replace('ai-clause-','').toUpperCase().replace(/-/g,'.');
      const verb = action === 'approve' ? 'approved your review on' : 'sent back your review on';
      jobs.notify(req.workspace.id, cur.review_requested_by, 'review_complete', 'info',
        `Reviewer ${verb} ${code}`, (req.body.note || '').slice(0, 140),
        `/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
    }
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
  });

  app.post('/workspaces/:wsId/iso42001/gap/:isoId/clear-flag', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT id FROM iso42001_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    // Review-convergence: clear converged review state when control_writes_converged.
    const wcCf42 = ctlWrites.converged(db, req.workspace.id);
    const ridCf42 = wcCf42 ? ctlWrites.requirementId(db, 'iso42001', item.id) : null;
    if (wcCf42 && ridCf42) {
      db.prepare(`UPDATE control_instances
        SET review_status='none', review_requested_by=NULL, review_requested_at=NULL, review_reason=NULL,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(req.workspace.id, ridCf42);
    } else {
      db.prepare(`UPDATE iso42001_control_states
        SET review_status='none', review_requested_by=NULL, review_requested_at=NULL, review_reason=NULL,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND iso_item_id=?`).run(req.workspace.id, item.id);
    }
    logAction(req.user.id, req.workspace.id, 'clear_review_flag', 'iso42001_item', item.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
  });

  app.post('/workspaces/:wsId/iso42001/controls/:isoId/documents/:linkId/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    // Verify the link belongs to a doc in this workspace before deleting.
    // drl-native unlink (iso42001_document_controls demolished); :linkId is drl.id.
    const link = docLinks.resolveLinkByControl(db, req.params.linkId, req.params.isoId, req.workspace.id);
    if (link) docLinks.deleteLink(db, link.id);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
  });

  app.post('/workspaces/:wsId/iso42001/controls/:isoId/risks', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { risk_id } = req.body;
    if (!risk_id) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
    // Sanity check the risk belongs to this workspace.
    const risk = db.prepare(`SELECT id FROM risks WHERE id=? AND workspace_id=?`).get(risk_id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    db.prepare(`INSERT OR IGNORE INTO iso42001_risk_controls (risk_id, iso_item_id) VALUES (?, ?)`)
      .run(risk_id, req.params.isoId);
    logAction(req.user.id, req.workspace.id, 'link_iso42001_risk', 'iso42001_item', req.params.isoId, { risk_id });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
  });

  app.post('/workspaces/:wsId/iso42001/controls/:isoId/risks/:linkRiskId/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM iso42001_risk_controls WHERE risk_id=? AND iso_item_id=?`)
      .run(req.params.linkRiskId, req.params.isoId);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
  });

  // --- Roadmap ---
  app.get('/workspaces/:wsId/iso42001/roadmap', requireAuth, requireWorkspace, (req, res) => {
    const wsId = req.workspace.id;
    const T = ctlReads.tables(db, wsId);
    // roadmap_phase was demolished with iso42001_control_states (019, deferred-drop):
    // no converged home, so it is no longer selected; all controls group as
    // Unscheduled until/unless the roadmap feature is rebuilt converged.
    const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.maturity, cs.owner_id, cs.due_date, NULL AS roadmap_phase,
        (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
        FROM iso42001_items i
        LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type='control'
        ORDER BY i.sort_order`).all(wsId);
    const phases = [
      { key: '0_3M', label: '0-3 months (now)' },
      { key: '3_6M', label: '3-6 months' },
      { key: '6_12M', label: '6-12 months' },
      { key: '12M_plus', label: '12+ months' },
      { key: '', label: 'Unscheduled' }
    ];
    const grouped = phases.map(p => ({ ...p, rows: rows.filter(r => (r.roadmap_phase || '') === p.key) }));

    // "Needs your attention" - live items needing action
    const today = (new Date()).toISOString().slice(0, 10);
    const soon = (new Date(Date.now() + 30 * 86400000)).toISOString().slice(0, 10);
    const needsAttention = [];

    // Overdue
    db.prepare(`SELECT i.id, i.title, cs.due_date FROM iso42001_items i
      INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' AND cs.due_date < ? AND cs.status != 'Implemented'
      ORDER BY cs.due_date LIMIT 5`).all(wsId, today).forEach(r => {
        needsAttention.push({ severity: 'high', category: 'Overdue',
          title: r.title, detail: `Due ${r.due_date} - past due`,
          link: `/workspaces/${wsId}/iso42001/gap/${r.id}` });
    });

    // Due soon
    db.prepare(`SELECT i.id, i.title, cs.due_date FROM iso42001_items i
      INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' AND cs.due_date >= ? AND cs.due_date < ? AND cs.status != 'Implemented'
      ORDER BY cs.due_date LIMIT 5`).all(wsId, today, soon).forEach(r => {
        needsAttention.push({ severity: 'medium', category: 'Due soon',
          title: r.title, detail: `Due ${r.due_date}`,
          link: `/workspaces/${wsId}/iso42001/gap/${r.id}` });
    });

    // Mandatory clauses not implemented
    db.prepare(`SELECT i.id, i.title FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='clause' AND (cs.status IS NULL OR cs.status != 'Implemented')
      ORDER BY i.sort_order LIMIT 5`).all(wsId).forEach(r => {
        needsAttention.push({ severity: 'high', category: 'Clause',
          title: r.title, detail: 'Mandatory MS clause not yet at Implemented',
          link: `/workspaces/${wsId}/iso42001/gap/${r.id}` });
    });

    // Open NCs on ISO 42001 items
    db.prepare(`SELECT id, title, severity FROM nonconformities
      WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'
      ORDER BY created_at DESC LIMIT 5`).all(wsId).forEach(r => {
        needsAttention.push({ severity: r.severity === 'major' ? 'high' : 'medium', category: 'NC',
          title: r.title, detail: 'Open nonconformity',
          link: `/workspaces/${wsId}/nonconformities/${r.id}` });
    });

    // Implementation roadmap milestones - data-driven PDCA
    const clauseStatus = {};
    db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS s FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).all(wsId)
      .forEach(r => { clauseStatus[r.id] = r.s; });
    const ctlStats = db.prepare(`SELECT
        SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS impl,
        SUM(CASE WHEN COALESCE(cs.applicability,'undecided')='included' THEN 1 ELSE 0 END) AS included,
        COUNT(*) AS total
      FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control'`).get(wsId);
    const ncOpen = db.prepare(`SELECT COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'`).get(wsId).c;
    const ncTotal = db.prepare(`SELECT COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND iso_item_id LIKE 'ai-%'`).get(wsId).c;
    const intakeDone = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_intake_answers WHERE workspace_id=? AND answer IS NOT NULL AND answer != ''`).get(wsId).c >= 8;
    const planDone = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_engagement_plan_progress WHERE workspace_id=? AND completed_at IS NOT NULL`).get(wsId).c;
    const passOpen = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_assessment_passes WHERE workspace_id=? AND status='completed'`).get(wsId).c;

    const milestone = (phase, label, clause, detail, done, partial, link, link_label) => ({ phase, label, clause, detail, done, partial, link, link_label });
    const roadmap = [
      // PLAN
      milestone('plan', 'Engagement intake', '4.1, 4.2', 'Capture AI context, role determination, regulatory obligations',
        intakeDone, !intakeDone && planDone > 0, `/workspaces/${wsId}/iso42001/intake`, 'Open intake'),
      milestone('plan', 'AIMS scope defined', '4.3', 'Document in-scope AI systems and exclusions',
        clauseStatus['ai-clause-4.3'] === 'Implemented', ['Partially Implemented','Work In Progress'].includes(clauseStatus['ai-clause-4.3']),
        `/workspaces/${wsId}/iso42001/gap/ai-clause-4.3`, 'Open clause 4.3'),
      milestone('plan', 'AI policy approved', '5.2', 'Top-management approved AI policy with prohibited uses',
        clauseStatus['ai-clause-5.2'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-5.2`, 'Open clause 5.2'),
      milestone('plan', 'AI risk assessment methodology', '6.1.2', 'Documented methodology with AI risk criteria',
        clauseStatus['ai-clause-6.1.2'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-6.1.2`, 'Open clause 6.1.2'),
      milestone('plan', 'AI risk treatment + SoA', '6.1.3', 'Treatment plan + Statement of Applicability',
        clauseStatus['ai-clause-6.1.3'] === 'Implemented' && ctlStats.included > 0,
        ctlStats.included > 0 && clauseStatus['ai-clause-6.1.3'] !== 'Implemented',
        `/workspaces/${wsId}/iso42001/soa`, 'Open SoA'),
      milestone('plan', 'Impact assessment methodology', '6.1.4', 'AI system impact assessment process',
        clauseStatus['ai-clause-6.1.4'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-6.1.4`, 'Open clause 6.1.4'),
      milestone('plan', 'AI objectives set', '6.2', 'Measurable AI objectives with targets and owners',
        clauseStatus['ai-clause-6.2'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-6.2`, 'Open clause 6.2'),

      // DO
      milestone('do', 'Roles assigned', '5.3, A.3.2', 'AI roles defined and named',
        clauseStatus['ai-clause-5.3'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-5.3`, 'Open clause 5.3'),
      milestone('do', 'Competence + awareness', '7.2, 7.3', 'Training delivered; competence records exist',
        clauseStatus['ai-clause-7.2'] === 'Implemented' && clauseStatus['ai-clause-7.3'] === 'Implemented',
        [clauseStatus['ai-clause-7.2'], clauseStatus['ai-clause-7.3']].some(s => s !== 'Not Assessed'),
        `/workspaces/${wsId}/iso42001/gap/ai-clause-7.2`, 'Open clause 7.2'),
      milestone('do', 'Annex A controls implemented', 'Annex A', `${ctlStats.impl}/${ctlStats.included} included controls at Implemented`,
        ctlStats.included > 0 && ctlStats.impl === ctlStats.included,
        ctlStats.impl > 0 && ctlStats.impl < ctlStats.included,
        `/workspaces/${wsId}/iso42001/controls`, 'Open controls'),
      milestone('do', 'Monitoring & operation', '9.1, A.6.2.6', 'Monitoring of AI systems (drift, fairness, performance)',
        clauseStatus['ai-clause-9.1'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-9.1`, 'Open clause 9.1'),

      // CHECK
      milestone('check', 'Internal audit', '9.2', `First internal audit pass complete${passOpen > 0 ? ` (${passOpen} passes done)` : ''}`,
        passOpen > 0 && clauseStatus['ai-clause-9.2'] === 'Implemented',
        passOpen > 0 && clauseStatus['ai-clause-9.2'] !== 'Implemented',
        `/workspaces/${wsId}/iso42001/gap-assessment`, 'Open passes'),
      milestone('check', 'Management review', '9.3', 'Top management review with all required inputs',
        clauseStatus['ai-clause-9.3'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-9.3`, 'Open clause 9.3'),

      // ACT
      milestone('act', 'Nonconformities closed', '10.2', `${ncTotal - ncOpen}/${ncTotal} NCs closed`,
        ncTotal > 0 && ncOpen === 0,
        ncOpen > 0,
        `/workspaces/${wsId}/nonconformities`, 'Open NCs'),
      milestone('act', 'Continual improvement', '10.1', 'Improvement initiatives tracked and acted on',
        clauseStatus['ai-clause-10.1'] === 'Implemented', false,
        `/workspaces/${wsId}/iso42001/gap/ai-clause-10.1`, 'Open clause 10.1'),
    ];

    res.render('iso42001_roadmap', { user: req.user, ws: req.workspace, grouped, phases, needsAttention, roadmap });
  });

  app.post('/workspaces/:wsId/iso42001/roadmap/:isoId/phase', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    // roadmap_phase was demolished with iso42001_control_states (019, deferred-drop):
    // no converged home, so phase assignment is no longer persisted. Route kept as a
    // no-op so the UI does not 404; rebuild converged if the roadmap feature is wanted.
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/roadmap`);
  });

  // --- Readiness (computed scorecard) ---
  function computeIso42001Readiness(wsId) {
    const T = ctlReads.tables(db, wsId);
    // Aggregate control-state numbers
    const m = db.prepare(`SELECT
        SUM(CASE WHEN i.type='clause' AND cs.status='Implemented' THEN 1 ELSE 0 END) AS clauseImpl,
        SUM(CASE WHEN i.type='clause' THEN 1 ELSE 0 END) AS clauseTotal,
        SUM(CASE WHEN i.type='control' AND cs.status='Implemented' THEN 1 ELSE 0 END) AS implemented,
        SUM(CASE WHEN i.type='control' AND cs.status='Partially Implemented' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN i.type='control' AND cs.status='Work In Progress' THEN 1 ELSE 0 END) AS wip,
        SUM(CASE WHEN i.type='control' AND cs.status='Not Implemented' THEN 1 ELSE 0 END) AS notImpl,
        SUM(CASE WHEN i.type='control' AND cs.status='Not Applicable' THEN 1 ELSE 0 END) AS na,
        SUM(CASE WHEN i.type='control' AND COALESCE(cs.status,'Not Assessed')='Not Assessed' THEN 1 ELSE 0 END) AS unassessed,
        SUM(CASE WHEN i.type='control' THEN 1 ELSE 0 END) AS ctlTotal,
        AVG(CASE WHEN i.type='control' AND cs.maturity > 0 THEN cs.maturity END) AS avgMaturity
      FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).get(wsId);

    // Stage 1 = documentation / framework. Heuristic: clauses (4-10) + policy / governance controls (A.2, A.3, A.5).
    const stage1 = db.prepare(`SELECT
        SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS impl,
        COUNT(*) AS total
      FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='clause' OR i.category IN ('a-policies','b-internal-organization','d-impact-assessment')`).get(wsId);
    const stage1Pct = stage1.total ? Math.round((stage1.impl / stage1.total) * 100) : 0;

    // Stage 2 = operational effectiveness. Annex A controls outside the Stage 1 set.
    const stage2 = db.prepare(`SELECT
        SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS impl,
        COUNT(*) AS total
      FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control'
        AND i.category NOT IN ('a-policies','b-internal-organization','d-impact-assessment')
        AND COALESCE(cs.applicability,'undecided') != 'excluded'`).get(wsId);
    const stage2Pct = stage2.total ? Math.round((stage2.impl / stage2.total) * 100) : 0;

    // Documented information: heuristic detection via clause status (Implemented = doc exists).
    const clauseStatusById = {};
    db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS status
      FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='clause'`).all(wsId).forEach(r => { clauseStatusById[r.id] = r.status; });
    const controlStatusById = {};
    db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS status, COALESCE(cs.applicability,'undecided') AS applicability
      FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control'`).all(wsId).forEach(r => { controlStatusById[r.id] = r; });

    const docCheck = (clauseId, name) => ({ name, clause: clauseId.replace('ai-clause-',''), found: clauseStatusById[clauseId] === 'Implemented' });
    const mandatoryChecks = [
      docCheck('ai-clause-4.3', 'AIMS scope'),
      docCheck('ai-clause-5.2', 'AI policy'),
      docCheck('ai-clause-6.1.2', 'AI risk assessment process'),
      docCheck('ai-clause-6.1.3', 'AI risk treatment process & SoA'),
      docCheck('ai-clause-6.1.4', 'AI system impact assessment process'),
      docCheck('ai-clause-6.2', 'AI objectives'),
      docCheck('ai-clause-7.5', 'Documented information control'),
      docCheck('ai-clause-8.2', 'AI risk assessment results'),
      docCheck('ai-clause-8.3', 'AI risk treatment results'),
      docCheck('ai-clause-8.4', 'AI system impact assessment results'),
      docCheck('ai-clause-9.2', 'Internal audit programme & results'),
      docCheck('ai-clause-9.3', 'Management review results'),
      docCheck('ai-clause-10.2', 'Nonconformity records'),
    ];
    const mandatoryFound = mandatoryChecks.filter(c => c.found).length;

    const expectedCheck = (ctlId, name) => ({
      name, clause: ctlId.replace('ai-annex-','').toUpperCase().replace(/-/g,'.'),
      found: controlStatusById[ctlId] && controlStatusById[ctlId].status === 'Implemented'
    });
    const expectedChecks = [
      expectedCheck('ai-annex-a-4-2', 'AI system inventory'),
      expectedCheck('ai-annex-a-4-3', 'Dataset documentation (datasheets)'),
      expectedCheck('ai-annex-a-5-3', 'Impact assessment reports per system'),
      expectedCheck('ai-annex-a-6-2-3', 'Design / model documentation'),
      expectedCheck('ai-annex-a-6-2-4', 'Verification & validation reports'),
      expectedCheck('ai-annex-a-6-2-7', 'AI system technical documentation / model cards'),
      expectedCheck('ai-annex-a-6-2-8', 'Event logs specification'),
      expectedCheck('ai-annex-a-7-5', 'Data lineage records'),
    ];
    const expectedFound = expectedChecks.filter(c => c.found).length;

    // Detected gaps - flags by category, severity
    const flags = [];
    // Included controls with no risk linkage (weak 6.1.3 traceability)
    const unjustified = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
      INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' AND cs.applicability='included'
        AND NOT EXISTS (SELECT 1 FROM iso42001_risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?)
      ORDER BY i.sort_order LIMIT 20`).all(wsId, wsId);
    if (unjustified.length) flags.push({ kind: 'unjustified_inclusions', label: 'Included Annex A controls with no linked risk', severity: 'medium', items: unjustified });

    // Annex A controls Included but Not Implemented / Partial
    const notReady = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
      INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' AND cs.applicability='included'
        AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
      ORDER BY i.sort_order LIMIT 20`).all(wsId);
    if (notReady.length) flags.push({ kind: 'controls_not_ready', label: 'Included Annex A controls not yet Implemented', severity: 'high', items: notReady });

    // Unassessed clauses (mandatory)
    const unassessedClauses = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='clause' AND (cs.status IS NULL OR cs.status='Not Assessed')
      ORDER BY i.sort_order`).all(wsId);
    if (unassessedClauses.length) flags.push({ kind: 'unassessed_clauses', label: 'Mandatory clauses not yet assessed', severity: 'high', items: unassessedClauses });

    // Undecided applicability
    const undecided = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' AND COALESCE(cs.applicability,'undecided')='undecided'
      ORDER BY i.sort_order LIMIT 10`).all(wsId);
    if (undecided.length) flags.push({ kind: 'undecided_soa', label: 'Annex A controls with undecided applicability', severity: 'medium', items: undecided });

    // Open NCs on ISO 42001 items
    const openNCs = db.prepare(`SELECT id, title FROM nonconformities
      WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'
      ORDER BY created_at DESC LIMIT 20`).all(wsId);
    if (openNCs.length) flags.push({ kind: 'open_ncs', label: 'Open nonconformities on ISO 42001 items', severity: 'high', items: openNCs });

    // Days to target cert
    let daysToTarget = null;
    const ws = db.prepare('SELECT target_cert_date FROM workspaces WHERE id=?').get(wsId);
    if (ws && ws.target_cert_date) {
      const t = new Date(ws.target_cert_date).getTime();
      daysToTarget = Math.round((t - Date.now()) / 86400000);
    }

    const evidenceCount = db.prepare(`SELECT COUNT(*) AS c FROM evidence
      WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND superseded_at IS NULL`).get(wsId).c;

    return {
      stage1: stage1Pct, stage2: stage2Pct, daysToTarget,
      records: {
        total: mandatoryChecks.length + expectedChecks.length,
        found: mandatoryFound + expectedFound,
        mandatory: { total: mandatoryChecks.length, found: mandatoryFound, checks: mandatoryChecks },
        expected: { total: expectedChecks.length, found: expectedFound, checks: expectedChecks }
      },
      metrics: {
        implemented: m.implemented || 0, partial: m.partial || 0, wip: m.wip || 0,
        notImpl: m.notImpl || 0, na: m.na || 0, unassessed: m.unassessed || 0,
        avgMaturity: m.avgMaturity ? m.avgMaturity.toFixed(1) : '0.0',
        evidenceCount
      },
      flags
    };
  }

  app.get('/workspaces/:wsId/iso42001/readiness', requireAuth, requireWorkspace, (req, res) => {
    const r = computeIso42001Readiness(req.workspace.id);
    res.render('iso42001_readiness', { user: req.user, ws: req.workspace, r });
  });

  // Unified readiness view - the "executive brief" moment. Shows a headline
  // score per enabled framework side-by-side so a sponsor sees engagement
  // health at a glance. Each tile deep-links into the per-framework
  // readiness page for detail.
  app.get('/workspaces/:wsId/readiness/overview', requireAuth, requireWorkspace, (req, res) => {
    const ws = req.workspace;
    const tiles = [];

    if (ws.frameworks.includes('iso27001')) {
      const r = computeReadiness(ws);
      tiles.push({
        key: 'iso27001',
        label: 'ISO 27001:2022',
        sub: 'Information security management',
        score: r.stage1,
        stage2: r.stage2,
        detail: `${r.metrics.implemented} / ${r.metrics.totalItems} implemented · ${r.metrics.partial} partial · ${r.metrics.notImpl} not implemented`,
        flagsHigh: r.flags.filter(f => f.severity === 'high').length,
        href: `/workspaces/${ws.id}/readiness`,
        color: '#4F46E5'
      });
    }

    if (ws.frameworks.includes('iso42001')) {
      const r = computeIso42001Readiness(ws.id);
      tiles.push({
        key: 'iso42001',
        label: 'ISO 42001:2023',
        sub: 'AI management system',
        score: r.stage1,
        stage2: r.stage2,
        detail: `${r.metrics.implemented} implemented · ${r.metrics.partial} partial · ${r.metrics.notImpl} not implemented`,
        flagsHigh: r.flags ? r.flags.filter(f => f.severity === 'high').length : 0,
        href: `/workspaces/${ws.id}/iso42001/readiness`,
        color: '#0891B2'
      });
    }

    if (ws.frameworks.includes('csf')) {
      // Most-recently-touched non-deleted engagement, if any. A workspace may
      // have multiple CSF engagements; the most-recent is the right "current"
      // for an executive overview. If none exists we still render a tile so
      // the consultant can click through and create one.
      const eng = db.prepare(`SELECT * FROM csf_engagements
        WHERE workspace_id=? AND deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 1`).get(ws.id);
      let score = 0, detail = 'No engagement started yet';
      let href = `/workspaces/${ws.id}/csf`;
      if (eng) {
        const counts = db.prepare(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='Approved' THEN 1 ELSE 0 END) AS approved
          FROM csf_subcategory_assessments WHERE engagement_id=?`).get(eng.id);
        const approved = counts.approved || 0;
        const total = counts.total || 0;
        score = total ? Math.round(approved / total * 100) : 0;
        detail = `${approved} / ${total} subcategories approved · "${eng.name}" · ${eng.status}`;
        href = `/workspaces/${ws.id}/csf/${eng.id}/scores`;
      }
      tiles.push({
        key: 'csf',
        label: 'NIST CSF 2.0',
        sub: 'Cybersecurity Framework',
        score, detail, href,
        flagsHigh: 0,
        color: '#7C3AED'
      });
    }

    // Days to target cert for the page subhead (same field powers all three).
    let daysToTarget = null;
    if (ws.target_cert_date) {
      daysToTarget = Math.round((new Date(ws.target_cert_date).getTime() - Date.now()) / 86400000);
    }

    res.render('readiness_overview', {
      user: req.user, ws, tiles, daysToTarget,
      title: 'Readiness overview'
    });
  });

  // Pre-cert blocker check - the long-form list of items that must be cleared
  // before a Stage 2 audit.
  app.get('/workspaces/:wsId/iso42001/readiness/blockers', requireAuth, requireWorkspace, (req, res) => {
    const r = computeIso42001Readiness(req.workspace.id);
    const blockers = r.flags.filter(f => f.severity === 'high');
    res.render('iso42001_readiness_blockers', { user: req.user, ws: req.workspace, blockers });
  });

  // --- Exec brief ---
  app.get('/workspaces/:wsId/iso42001/exec-brief', requireAuth, requireWorkspace, (req, res) => {
    const wsId = req.workspace.id;
    const readiness = computeIso42001Readiness(wsId);

    // Velocity: controls moved to Implemented in last 30 vs prior 30 days, from history.
    const now = Date.now();
    const t30 = new Date(now - 30 * 86400000).toISOString();
    const t60 = new Date(now - 60 * 86400000).toISOString();
    const velocityNow = db.prepare(`SELECT COUNT(DISTINCT iso_item_id) AS c FROM iso42001_control_state_history
      WHERE workspace_id=? AND status='Implemented' AND snapshot_at > ?`).get(wsId, t30).c;
    const velocityPrior = db.prepare(`SELECT COUNT(DISTINCT iso_item_id) AS c FROM iso42001_control_state_history
      WHERE workspace_id=? AND status='Implemented' AND snapshot_at > ? AND snapshot_at <= ?`).get(wsId, t60, t30).c;
    const velocityDelta = velocityNow - velocityPrior;

    // Residual ALE heuristic: Σ (likelihood/5 × impact × $50k) for open AI-linked risks.
    // We use risks linked to any iso42001 item; if none linked, fall back to all open workspace risks.
    const openRisks = db.prepare(`SELECT DISTINCT r.id, r.title, r.likelihood, r.impact, r.owner_name, r.status
      FROM risks r WHERE r.workspace_id=? AND r.status != 'closed'
        AND (r.id IN (SELECT risk_id FROM iso42001_risk_controls)
             OR NOT EXISTS (SELECT 1 FROM iso42001_risk_controls))
      ORDER BY (r.likelihood * r.impact) DESC`).all(wsId);
    const residualAle = openRisks.reduce((s, r) => s + Math.round((r.likelihood / 5) * (r.impact || 0) * 50000), 0);
    const topRisks = openRisks.slice(0, 5).map(r => ({ ...r, score: (r.likelihood||0) * (r.impact||0) }));
    const openRiskCount = openRisks.length;

    // Engagement plan progress
    const phases = ISO42001_PLAN_PHASES;
    const progressRows = db.prepare(`SELECT phase_key, completed_at FROM iso42001_engagement_plan_progress WHERE workspace_id=?`).all(wsId);
    const planTotal = phases.length;
    const planDone = progressRows.filter(p => p.completed_at).length;
    const planPct = planTotal ? Math.round((planDone / planTotal) * 100) : 0;

    // Open NCs on ISO 42001 items, with severity tally + overdue count
    const ncs = db.prepare(`SELECT * FROM nonconformities
      WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'
      ORDER BY due_date IS NULL, due_date`).all(wsId);
    const today = (new Date()).toISOString().slice(0, 10);
    const ncTotals = {
      major: ncs.filter(n => n.severity === 'major').length,
      minor: ncs.filter(n => n.severity === 'minor').length,
      other: ncs.filter(n => n.severity && !['major','minor'].includes(n.severity)).length,
      overdue: ncs.filter(n => n.due_date && n.due_date < today).length
    };
    const topNCs = ncs.slice(0, 5);

    res.render('iso42001_exec_brief', { user: req.user, ws: req.workspace,
      readiness, velocityNow, velocityPrior, velocityDelta, residualAle, openRiskCount,
      planDone, planTotal, planPct, ncTotals, topRisks, topNCs });
  });

  // --- Cert cycle ---
  const ISO42001_EVENT_TYPES = [
    { key: 'stage1', label: 'Stage 1 audit', desc: 'Documentation review by the cert body. AIMS scope, AI policy, SoA, methodology docs.' },
    { key: 'stage2', label: 'Stage 2 audit', desc: 'Operational audit. Auditors test that the AIMS works in practice across in-scope AI systems.' },
    { key: 'surv1',  label: 'Surveillance audit (year 1)', desc: 'Annual surveillance by the cert body to confirm continued conformance.' },
    { key: 'surv2',  label: 'Surveillance audit (year 2)', desc: 'Second annual surveillance.' },
    { key: 'recert', label: 'Recertification audit', desc: 'Three-year recertification - full reassessment.' },
    { key: 'internal', label: 'Internal audit', desc: 'Internal audit pass (clause 9.2).' },
    { key: 'mrm', label: 'Management review', desc: 'Top-management review of the AIMS (clause 9.3).' },
  ];

  app.get('/workspaces/:wsId/iso42001/cert-cycle', requireAuth, requireWorkspace, (req, res) => {
    const events = db.prepare(`SELECT * FROM iso42001_cert_cycle_events WHERE workspace_id=? ORDER BY planned_date, id`).all(req.workspace.id);
    res.render('iso42001_cert_cycle', { user: req.user, ws: req.workspace, events, eventTypes: ISO42001_EVENT_TYPES });
  });

  // Seed default cycle - 5 standard events based on the target cert date or today + 60 days.
  app.post('/workspaces/:wsId/iso42001/cert-cycle/seed', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const ws = db.prepare(`SELECT target_cert_date FROM workspaces WHERE id=?`).get(req.workspace.id);
    const stage1 = ws && ws.target_cert_date ? new Date(ws.target_cert_date) : new Date(Date.now() + 60 * 86400000);
    // Cert target -> Stage 2 date. Stage 1 = -30 days, surveillance +12mo, +24mo, recert +36mo.
    const stage2 = new Date(stage1.getTime());
    const stage1Date = new Date(stage1.getTime() - 30 * 86400000);
    const surv1 = new Date(stage1.getTime() + 365 * 86400000);
    const surv2 = new Date(stage1.getTime() + 365 * 2 * 86400000);
    const recert = new Date(stage1.getTime() + 365 * 3 * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const ins = db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, planned_date, status) VALUES (?, ?, ?, 'planned')`);
    const tx = db.transaction(() => {
      ins.run(req.workspace.id, 'Stage 1 audit', iso(stage1Date));
      ins.run(req.workspace.id, 'Stage 2 audit', iso(stage2));
      ins.run(req.workspace.id, 'Surveillance audit (year 1)', iso(surv1));
      ins.run(req.workspace.id, 'Surveillance audit (year 2)', iso(surv2));
      ins.run(req.workspace.id, 'Recertification audit', iso(recert));
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'seed_iso42001_cert_cycle', 'iso42001_cert_event', null, null);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
  });

  app.post('/workspaces/:wsId/iso42001/cert-cycle/add', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { event_type, planned_date, notes } = req.body;
    if (!event_type) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
    db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, planned_date, notes) VALUES (?, ?, ?, ?)`)
      .run(req.workspace.id, event_type, planned_date || null, notes || null);
    logAction(req.user.id, req.workspace.id, 'add_iso42001_cert_event', 'iso42001_cert_event', null, { event_type });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
  });

  app.post('/workspaces/:wsId/iso42001/cert-cycle/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { planned_date, actual_date, status, notes } = req.body;
    db.prepare(`UPDATE iso42001_cert_cycle_events
                SET planned_date=COALESCE(?,planned_date), actual_date=COALESCE(?,actual_date),
                    status=COALESCE(?,status), notes=COALESCE(?,notes)
                WHERE id=? AND workspace_id=?`)
      .run(planned_date || null, actual_date || null, status || null, notes || null, req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
  });

  app.post('/workspaces/:wsId/iso42001/cert-cycle/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM iso42001_cert_cycle_events WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
  });

  // --- Intake ---
  app.get('/workspaces/:wsId/iso42001/intake', requireAuth, requireWorkspace, (req, res) => {
    const rows = db.prepare(`SELECT question_key, answer FROM iso42001_intake_answers WHERE workspace_id=?`).all(req.workspace.id);
    const answers = {};
    rows.forEach(r => { answers[r.question_key] = r.answer; });
    const total = ISO42001_INTAKE_QUESTIONS.length;
    const answered = ISO42001_INTAKE_QUESTIONS.filter(q => (answers[q.key] || '').trim()).length;
    const draftScope = buildIso42001DraftScope(answers);
    res.render('iso42001_intake', { user: req.user, ws: req.workspace,
      sections: ISO42001_INTAKE_SECTIONS, answers, total, answered, draftScope });
  });

  app.post('/workspaces/:wsId/iso42001/intake', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const upsert = db.prepare(`INSERT INTO iso42001_intake_answers (workspace_id, question_key, answer, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id, question_key) DO UPDATE SET answer=excluded.answer, updated_at=CURRENT_TIMESTAMP`);
    const tx = db.transaction(() => {
      for (const q of ISO42001_INTAKE_QUESTIONS) {
        const v = req.body[q.key];
        if (v != null) upsert.run(req.workspace.id, q.key, v);
      }
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'save_iso42001_intake', 'iso42001_intake', null, null);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/intake`);
  });

  // Apply intake to workspace - push draft scope into clause 4.3 notes and update target_cert_date.
  app.post('/workspaces/:wsId/iso42001/intake/apply', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const wsId = req.workspace.id;
    const rows = db.prepare(`SELECT question_key, answer FROM iso42001_intake_answers WHERE workspace_id=?`).all(wsId);
    const answers = {};
    rows.forEach(r => { answers[r.question_key] = r.answer; });
    const draftScope = buildIso42001DraftScope(answers);

    // Seed clause 4.3 (AIMS scope) - update notes and bump status to Partially Implemented if Not Assessed.
    getOrCreate42State(wsId, 'ai-clause-4.3');
    db.prepare(`UPDATE control_instances
      SET notes = CASE WHEN COALESCE(notes,'') = '' THEN ? ELSE notes END,
          status = CASE WHEN status='not_assessed' THEN 'partially_implemented' ELSE status END,
          last_updated = CURRENT_TIMESTAMP
      WHERE workspace_id=? AND entity_id IS NULL
        AND requirement_id=(SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref='ai-clause-4.3')`).run(draftScope, wsId);

    // Seed clause 4.2 (interested parties) notes if blank
    if ((answers['interested-parties'] || '').trim()) {
      getOrCreate42State(wsId, 'ai-clause-4.2');
      db.prepare(`UPDATE control_instances
        SET notes = CASE WHEN COALESCE(notes,'') = '' THEN ? ELSE notes END,
            status = CASE WHEN status='not_assessed' THEN 'partially_implemented' ELSE status END,
            last_updated = CURRENT_TIMESTAMP
        WHERE workspace_id=? AND entity_id IS NULL
          AND requirement_id=(SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref='ai-clause-4.2')`).run(answers['interested-parties'], wsId);
    }

    // Seed clause 4.1 (context) notes if blank
    const contextNote = [
      answers['org-context'] && `Context: ${answers['org-context']}`,
      answers['role'] && `Role: ${answers['role']}`,
      answers['regulatory'] && `Regulatory: ${answers['regulatory']}`,
    ].filter(Boolean).join('\n');
    if (contextNote) {
      getOrCreate42State(wsId, 'ai-clause-4.1');
      db.prepare(`UPDATE control_instances
        SET notes = CASE WHEN COALESCE(notes,'') = '' THEN ? ELSE notes END,
            status = CASE WHEN status='not_assessed' THEN 'partially_implemented' ELSE status END,
            last_updated = CURRENT_TIMESTAMP
        WHERE workspace_id=? AND entity_id IS NULL
          AND requirement_id=(SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso42001' AND rq.ref='ai-clause-4.1')`).run(contextNote, wsId);
    }

    // Target cert date - push to workspaces.target_cert_date if not already set
    if (answers['target-cert-date']) {
      db.prepare(`UPDATE workspaces SET target_cert_date = COALESCE(target_cert_date, ?) WHERE id=?`)
        .run(answers['target-cert-date'], wsId);
    }

    logAction(req.user.id, wsId, 'apply_iso42001_intake', 'iso42001_intake', null, { questionsAnswered: Object.keys(answers).length });
    res.redirect(`/workspaces/${wsId}/iso42001/gap/ai-clause-4.3`);
  });

  // --- Engagement plan ---
  app.get('/workspaces/:wsId/iso42001/engagement-plan', requireAuth, requireWorkspace, (req, res) => {
    const rows = db.prepare(`SELECT p.phase_key, p.completed_at, p.notes, (SELECT name FROM users WHERE id = p.completed_by) AS completed_by_name
      FROM iso42001_engagement_plan_progress p WHERE workspace_id=?`).all(req.workspace.id);
    const progress = {};
    rows.forEach(r => { progress[r.phase_key] = r; });
    res.render('iso42001_engagement_plan', { user: req.user, ws: req.workspace, phases: ISO42001_PLAN_PHASES, progress });
  });

  app.post('/workspaces/:wsId/iso42001/engagement-plan/:phaseKey/toggle', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const phaseKey = req.params.phaseKey;
    if (!ISO42001_PLAN_PHASES.find(p => p.key === phaseKey)) return res.status(400).send('Bad phase');
    const existing = db.prepare(`SELECT completed_at FROM iso42001_engagement_plan_progress WHERE workspace_id=? AND phase_key=?`).get(req.workspace.id, phaseKey);
    if (existing && existing.completed_at) {
      db.prepare(`UPDATE iso42001_engagement_plan_progress SET completed_at=NULL, completed_by=NULL WHERE workspace_id=? AND phase_key=?`).run(req.workspace.id, phaseKey);
    } else {
      db.prepare(`INSERT INTO iso42001_engagement_plan_progress (workspace_id, phase_key, completed_at, completed_by)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(workspace_id, phase_key) DO UPDATE SET completed_at=CURRENT_TIMESTAMP, completed_by=excluded.completed_by`).run(req.workspace.id, phaseKey, req.user.id);
    }
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/engagement-plan`);
  });

  app.post('/workspaces/:wsId/iso42001/engagement-plan/:phaseKey/notes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const phaseKey = req.params.phaseKey;
    if (!ISO42001_PLAN_PHASES.find(p => p.key === phaseKey)) return res.status(400).send('Bad phase');
    db.prepare(`INSERT INTO iso42001_engagement_plan_progress (workspace_id, phase_key, notes)
      VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, phase_key) DO UPDATE SET notes=excluded.notes`).run(req.workspace.id, phaseKey, req.body.notes || null);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/engagement-plan`);
  });


  shared.getOrCreate42State = getOrCreate42State;
  shared.computeIso42001Readiness = computeIso42001Readiness;
}

module.exports = { register, shared };
