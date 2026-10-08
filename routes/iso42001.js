'use strict';
// ISO/IEC 42001 (AI management system) cluster. Slice 13 of the server.js
// modularization: catalog, intake, gap assessment, SoA + snapshots, roadmap,
// readiness, engagement plan, exec brief.

const crypto = require('crypto');
const isoLifecycle = require('../lib/iso-lifecycle');
const rbac = require('../lib/rbac');
const enc = require('../lib/encryption');
const jobs = require('../lib/jobs');
const ctlReads = require('../lib/control-reads');
const aimsScope = require('../lib/iso42001-scope');
const ctlWrites = require('../lib/control-writes');
const personalDrafts = require('../lib/form-drafts');
const diagnostics = require('../lib/assessment-diagnostics');
const docLinks = require('../lib/doc-links');
const auditRequests = require('../lib/iso42001-audit');
const aimsCycle = require('../lib/iso42001-cycle');
const aimsSoa = require('../lib/iso42001-soa');
const reqOpts = require('../lib/requirement-options');
const outcomeScope = require('../lib/engagement-outcome-scope');
const aiRisk = require('../lib/ai-risk');
const aimsPlan = require('../lib/iso42001-plan');
const crosswalk = require('../lib/framework-crosswalk');
const { requireInternalEvidenceMutation } = require('../lib/evidence-access');
const fts = require('../lib/fts');
const aimsAssessment = require('../lib/iso42001-assessment');
const { withToast, redirectBack, auditCtx, parseFormArray, escapeHtml } = require('../lib/http-helpers');

// getOrCreate42State + computeIso42001Readiness close over deps; server.js
// re-exports them for tooling through these refs, bound at register().
const shared = {};

// An SoA row posts one justification box, `justification`, for whichever
// applicability is chosen. It is filed under that applicability and the other
// justification is left as it was, so moving a control between included and
// excluded never loses the reason recorded for the other side. The two named
// fields are still accepted from older forms. Only the keys returned here are
// written, so a field the request did not carry is never cleared.
function soaJustifications(body) {
  const clean = (v) => (v == null ? null : (String(v).trim() || null));
  const out = {};
  if (body.inclusion_justification !== undefined) out.inclusion_justification = clean(body.inclusion_justification);
  if (body.exclusion_justification !== undefined) out.exclusion_justification = clean(body.exclusion_justification);
  if (body.justification !== undefined) {
    out[body.applicability === 'excluded' ? 'exclusion_justification' : 'inclusion_justification'] = clean(body.justification);
  }
  return out;
}

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
    const today = new Date().toISOString().slice(0, 10);
    const requestCounts = auditRequests.requestCountsByItem(db, req.workspace, today);
    const canPlan = rbac.hasPermission(res.locals.userPerms, 'control.update');
    res.render('iso42001_controls', { user: req.user, ws: req.workspace, rows, filter, search, requestCounts, today, canPlan,
      people: canPlan ? aimsPlan.assignableUsers(db, req.workspace) : [] });
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
    // Owner and due date: blank leaves them as they are; "none" or the clear
    // box removes them.
    let ownerId, dueDate;
    try {
      ownerId = req.body.owner_id === 'none' ? null : req.body.owner_id ? aimsPlan.parseOwner(db, req.workspace, req.body.owner_id) : undefined;
      dueDate = req.body.clear_due ? null : req.body.due_date ? aimsPlan.parseDue(req.body.due_date) : undefined;
    } catch (e) {
      if (!(e instanceof aimsPlan.PlanError)) throw e;
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/iso42001/controls`, e.message, 'error'));
    }
    const planning = ownerId !== undefined || dueDate !== undefined;
    if (!ids.length || (!status && !applicability && !planning)) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/controls`);
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
        if (planning && rid) aimsPlan.setPlan(db, req.workspace, id, { ownerId, dueDate });
      }
    });
    tx();
    aimsAssessment.reconcileDelivery(db, req.workspace.id, req.user.id, 'ISO 42001 conclusions or applicability were bulk updated.');
    logAction(req.user.id, req.workspace.id, 'bulk_update_iso42001_controls', 'iso42001_item', null,
      { ids: ids.length, status, applicability, owner_id: ownerId, due_date: dueDate });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/controls`);
  });

  // One requirement's owner and due date, from the controls grid.
  app.post('/workspaces/:wsId/iso42001/controls/:isoId/plan', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/iso42001/controls`;
    try {
      const saved = aimsPlan.setPlan(db, req.workspace, req.params.isoId, {
        ownerId: aimsPlan.parseOwner(db, req.workspace, req.body.owner_id),
        dueDate: aimsPlan.parseDue(req.body.due_date),
      });
      logAction(req.user.id, req.workspace.id, 'plan_iso42001_control', 'iso42001_item', req.params.isoId, saved, auditCtx(req));
      if (req.query.ajax === '1') return res.status(204).end();
      res.redirect(withToast(back, 'Owner and due date saved'));
    } catch (e) {
      if (!(e instanceof aimsPlan.PlanError)) throw e;
      if (req.query.ajax === '1') return res.status(e.status).json({ error: e.message });
      res.redirect(withToast(back, e.message, 'error'));
    }
  });

  // SoA - Statement of Applicability for the 38 Annex A controls.
  app.get('/workspaces/:wsId/iso42001/soa', requireAuth, requireWorkspace, (req, res) => {
    // Read missing states as neutral defaults; opening the SoA records no work.
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
    const latestSnap = db.prepare(`SELECT id, label, version, owner, approved_by, approved_at, approval_status, created_at
        FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(req.workspace.id);

    res.render('iso42001_soa', { user: req.user, ws: req.workspace, rows, docsByControl, risksByControl,
      customControls, soaMeta: latestSnap || {}, approvedSoa: aimsSoa.latestApproved(db, req.workspace),
      soaIssues: aimsSoa.issues(aimsSoa.payloadFor(db, req.workspace)) });
  });

  // SoA snapshots (lib/iso42001-soa.js): sealed on capture, with the risks and
  // documents behind every control, and approved by someone other than the
  // person who captured them once the SoA is complete.
  app.post('/workspaces/:wsId/iso42001/soa/snapshot', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const id = aimsSoa.capture(db, req.workspace, req.user.id, { label: req.body.label || 'Manual snapshot', reason: req.body.reason, version: req.body.version, owner: req.body.owner });
    logAction(req.user.id, req.workspace.id, 'capture_iso42001_soa_snapshot', 'iso42001_soa_snapshot', id, null);
    aimsAssessment.reconcileDelivery(db, req.workspace.id, req.user.id, 'The ISO 42001 Statement of Applicability was versioned.');
    res.redirect(withToast(`/workspaces/${req.workspace.id}/iso42001/soa/snapshots/${id}`, 'Snapshot captured. Ask a second person to approve it.'));
  });

  // Version and owner are recorded on a new snapshot, so the SoA's metadata is
  // versioned with its content. Approval is a separate, recorded step.
  app.post('/workspaces/:wsId/iso42001/soa/metadata', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const id = aimsSoa.capture(db, req.workspace, req.user.id, { label: 'Metadata update', version: req.body.version, owner: req.body.owner });
    logAction(req.user.id, req.workspace.id, 'iso42001_soa_metadata', 'iso42001_soa_snapshot', id, { version: req.body.version || null, owner: req.body.owner || null });
    aimsAssessment.reconcileDelivery(db, req.workspace.id, req.user.id, 'ISO 42001 Statement of Applicability metadata changed.');
    res.redirect(withToast(`/workspaces/${req.workspace.id}/iso42001/soa/snapshots/${id}`, 'Metadata saved on a new snapshot'));
  });

  app.get('/workspaces/:wsId/iso42001/soa/snapshots/:snapId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
    const snapshot = aimsSoa.load(db, req.workspace, Number(req.params.snapId));
    if (!snapshot) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'That SoA snapshot was not found.' });
    const perms = res.locals.userPerms;
    const canSignoff = perms instanceof Set ? perms.has('assessment.signoff') : Array.isArray(perms) ? perms.includes('assessment.signoff') : !!(perms && perms['assessment.signoff']);
    res.render('iso42001_soa_snapshot', { user: req.user, ws: req.workspace, snapshot, canSignoff,
      isAuthor: Number(snapshot.created_by) === Number(req.user.id), issueCount: aimsSoa.issueCount(snapshot.issues) });
  });

  app.post('/workspaces/:wsId/iso42001/soa/snapshots/:snapId(\\d+)/approve', requireAuth, requireWorkspace, requirePermission('assessment.signoff'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/iso42001/soa/snapshots/${req.params.snapId}`;
    try {
      const id = aimsSoa.approve(db, req.workspace, req.user, Number(req.params.snapId), req.body.note);
      logAction(req.user.id, req.workspace.id, 'approve_iso42001_soa_snapshot', 'iso42001_soa_snapshot', id, null, auditCtx(req));
      return res.redirect(withToast(back, 'Statement of Applicability approved'));
    } catch (error) {
      if (error instanceof aimsSoa.SoaError) {
        if (error.status === 404) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: error.message });
        return res.redirect(withToast(back, error.message, 'error'));
      }
      throw error;
    }
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
    aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id,'ISO 42001 applicability justifications changed.');
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
    aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id,'A custom AIMS control was added.');
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  app.post('/workspaces/:wsId/iso42001/soa/custom-controls/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const { code, title, source_framework, applicability, status } = req.body;
    const just = soaJustifications(req.body);
    const justSets = Object.keys(just).map((k) => `, ${k}=?`).join('');
    db.prepare(`UPDATE iso42001_soa_custom_controls
      SET code=COALESCE(?, code), title=COALESCE(?, title), source=COALESCE(?, source),
          applicability=COALESCE(?, applicability), status=COALESCE(?, status)${justSets}
      WHERE id=? AND workspace_id=?`)
      .run(code || null, title || null, source_framework || null,
           applicability || null, status || null, ...Object.values(just),
           req.params.id, req.workspace.id);
    aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id,'A custom AIMS control changed.');
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  });

  app.post('/workspaces/:wsId/iso42001/soa/custom-controls/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare(`DELETE FROM iso42001_soa_custom_controls WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id,'A custom AIMS control was removed.');
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
  app.get('/workspaces/:wsId/iso42001/export/soa.csv', requireAuth, requireWorkspace,
    requirePermission('workspace.export'), requirePermission('control.view'), (req, res) => {
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
    const { applicability, status } = req.body;
    const just = soaJustifications(req.body);
    // Cutover 4 (W4): converged-authoritative 42001 SoA save; applicability/status
    // normalized to tokens (014 mirrors back to iso42001_control_states).
    const wcSoa42 = ctlWrites.converged(db, req.workspace.id);
    const ridSoa42 = wcSoa42 ? ctlWrites.requirementId(db, 'iso42001', req.params.isoId) : null;
    const justSets = Object.keys(just).map((k) => `${k}=?`);
    const justVals = Object.values(just);
    if (wcSoa42 && ridSoa42) {
      db.prepare(`UPDATE control_instances SET ${['applicability=?', ...justSets].join(', ')},
                  status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
        .run(ctlWrites.normApplic(applicability || 'undecided'), ...justVals,
             ctlWrites.normStatus(status || null), req.workspace.id, ridSoa42);
    } else {
      db.prepare(`UPDATE iso42001_control_states SET ${['applicability=?', ...justSets].join(', ')},
                  status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND iso_item_id=?`)
        .run(applicability || 'undecided', ...justVals,
             status || null, req.workspace.id, req.params.isoId);
    }
    logAction(req.user.id, req.workspace.id, 'update_iso42001_soa', 'iso42001_item', req.params.isoId, null);
    aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id,'ISO 42001 applicability or its rationale changed.');
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
    aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id,'ISO 42001 applicability was bulk updated.');
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

  // The scoping intake and its draft scope statement live in lib/iso42001-scope
  // so the page can compose the statement live from the same definitions.
  const ISO42001_INTAKE_SECTIONS = aimsScope.SECTIONS;
  const ISO42001_INTAKE_QUESTIONS = aimsScope.QUESTIONS;
  const buildIso42001DraftScope = aimsScope.buildDraftScope;

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
    for (let i = 0; i < total; i++) { if (['yes','partial','no'].includes(answers[String(i)])) vals.push(answers[String(i)]); }
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
    const gapState = aimsAssessment.getGapState(db, req.workspace.id);
    const reviewedPasses = db.prepare('SELECT pass_id,id,snapshot_hash,reviewed_at FROM iso42001_assessment_snapshots WHERE workspace_id=?').all(req.workspace.id);
    res.render('iso42001_gap_assessment', { user: req.user, ws: req.workspace, passes, counts, gapState,
      reviewedPasses:Object.fromEntries(reviewedPasses.map(row => [row.pass_id,row])) });
  });

  app.post('/workspaces/:wsId/iso42001/gap-assessment/start', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    let passId;
    try { passId = aimsAssessment.startPass(db,req.workspace.id,req.user.id); }
    catch (error) { if (!error.status) throw error; return res.redirect(withToast(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`,error.message,'error')); }
    logAction(req.user.id, req.workspace.id, 'start_iso42001_pass', 'iso42001_pass', passId, null);
    const first = nextUnassessed42(req.workspace.id, 0);
    if (first) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${first.id}`);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
  });

  app.post('/workspaces/:wsId/iso42001/gap-assessment/:passId/complete', requireAuth, requireWorkspace, requirePermission('assessment.signoff'), (req, res) => {
    try {
      const snapshot = aimsAssessment.completePass(db,req.workspace.id,Number(req.params.passId),req.user.id);
      logAction(req.user.id, req.workspace.id, 'complete_iso42001_pass', 'iso42001_pass', req.params.passId,
        { snapshot_id:snapshot.id,snapshot_hash:snapshot.snapshot_hash,reviewed_at:snapshot.reviewed_at },auditCtx(req));
      return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment/${req.params.passId}/report`);
    } catch (error) {
      if (!error.status) throw error;
      if ([403,404].includes(error.status)) return res.status(error.status).render('error',{user:req.user,ws:req.workspace,message:error.message});
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`,error.message.slice(0,900),'error'));
    }
  });

  app.get('/workspaces/:wsId/iso42001/gap-assessment/:passId/report',requireAuth,requireWorkspace,requirePermission('control.view'),(req,res)=>{
    const snapshot=aimsAssessment.loadSnapshot(db,req.workspace.id,Number(req.params.passId));
    if(!snapshot)return res.status(404).render('error',{user:req.user,message:'No independently reviewed snapshot exists for this assessment pass.'});
    res.render('iso42001_assessment_report',{user:req.user,ws:req.workspace,snapshot});
  });

  // Per-item gap-assessment wizard.
  app.get('/workspaces/:wsId/iso42001/gap', requireAuth, requireWorkspace, (req, res) => {
    const next = nextUnassessed42(req.workspace.id, 0);
    if (!next) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${next.id}`);
  });

  function render42001Assessment(req,res) {
    const item = db.prepare(`SELECT * FROM iso42001_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).render('error', { user: req.user, message: 'Item not found.' });
    const recordedState = db.prepare('SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(req.workspace.id,item.id) || {
      status:'Not Assessed',applicability:item.type==='clause'?'included':'undecided',maturity:0,notes:'',review_status:'none',record_version:0
    };
    const activePass=db.prepare("SELECT id,pass_number,name FROM iso42001_assessment_passes WHERE workspace_id=? AND status='open' ORDER BY pass_number DESC LIMIT 1").get(req.workspace.id);
    const assessmentReadOnly=!activePass && !!db.prepare("SELECT id FROM iso42001_assessment_passes WHERE workspace_id=? AND status='completed' LIMIT 1").get(req.workspace.id);
    const privateDraft=personalDrafts.get(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'assessment-iso42001',recordId:item.id,contextKey:String(activePass?.id||'')});
    const recovery=req.assessmentRecovery || null;
    const enteredValues=recovery?Object.fromEntries(Object.entries(recovery.body).filter(([key,value])=>(personalDrafts.fields['assessment-iso42001'].includes(key)||/^q_\d+$/.test(key))&&['string','number','boolean'].includes(typeof value)).map(([key,value])=>[key,String(value)])):privateDraft.draft?.payload;
    const state=enteredValues?{...recordedState,...enteredValues}:recordedState;
    const questions = iso42001QuestionsFor(item);
    const diagnosticState=diagnostics.read(recordedState.assessment_answers,item.id,questions);
    const diagnosticDraftChanged=!!(enteredValues?.diagnostic_set_id && enteredValues.diagnostic_set_id!==diagnosticState.current.setId);
    let savedAnswers=diagnosticState.answers;
    if(enteredValues&&!diagnosticDraftChanged)savedAnswers={...savedAnswers,...Object.fromEntries(Object.entries(enteredValues).filter(([key])=>/^q_\d+$/.test(key)).map(([key,value])=>[key.slice(2),value]))};
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

    // Evidence for this item. ISO 42001 links live in evidence_requirement_links
    // (library uploads, this page's own upload form, and files accepted for a
    // certification request); the legacy iso_item_id column is kept for rows
    // written before that.
    const evidenceList = db.prepare(`SELECT e.*, u.name AS uploader,
      (SELECT COUNT(*) FROM evidence e2 WHERE e2.sha256 = e.sha256 AND e2.workspace_id = e.workspace_id) AS link_count
      FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id=? AND e.superseded_at IS NULL AND (e.iso_item_id=? OR e.id IN (
        SELECT erl.evidence_id FROM evidence_requirement_links erl
        JOIN requirements rq ON rq.id=erl.requirement_id JOIN frameworks f ON f.id=rq.framework_id
        WHERE f.code='iso42001' AND rq.ref=?))
      ORDER BY e.uploaded_at DESC`).all(req.workspace.id, item.id, item.id);
    const certRequests = auditRequests.requestsForItem(db, req.workspace, item.id, new Date().toISOString().slice(0, 10));

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
    const reviewContext = require('../lib/control-review').context(db,req.workspace,req.user,'iso42001',item.id);
    const isReviewer = reviewContext.canReview;

    res.render('iso42001_gap_detail', { user: req.user, ws: req.workspace, item, state,
      questions, savedAnswers, suggestedStatus,recordedState,privateDraft,recovery,diagnosticState,diagnosticDraftChanged,mutationKey:crypto.randomUUID(),
      prev, next, totals, sectionPosition, doneFlag,
      relatedRows, evidenceList, openNCs, linkedRisks, linkedDocs, linkableDocs, linkableRisks,
      priorPassNotes, activePass, assessmentReadOnly, certRequests, crosswalk: crosswalk.counterparts(db, req.workspace, 'iso42001', item.id),
      comments, firmUsers, requestedByName, reviewedByName, isReviewer, reviewContext });
  }
  app.get('/workspaces/:wsId/iso42001/gap/:isoId',requireAuth,requireWorkspace,render42001Assessment);

  app.post('/workspaces/:wsId/iso42001/gap/:isoId',requireAuth,requireWorkspace,requirePermission('control.update'),(req,res,nextMw)=>{
    const item=db.prepare('SELECT * FROM iso42001_items WHERE id=?').get(req.params.isoId);
    if(!item)return res.status(404).send('Not found');
    const base=`/workspaces/${req.workspace.id}/iso42001/gap`;
    const nextItem=db.prepare('SELECT id FROM iso42001_items WHERE sort_order>? ORDER BY sort_order LIMIT 1').get(item.sort_order);
    const activePass=db.prepare("SELECT id FROM iso42001_assessment_passes WHERE workspace_id=? AND status='open' ORDER BY pass_number DESC LIMIT 1").get(req.workspace.id);
    const context={workspaceId:req.workspace.id,actorId:req.user.id,kind:'assessment-iso42001',recordId:item.id,contextKey:String(activePass?.id||''),encryptionEnabled:!!req.workspace.encryption_enabled};
    let effectiveBody=req.body;
    try{
      if(req.body.action==='skip'){
        if(req.body.assessment_context!==undefined&&String(req.body.assessment_context)!==context.contextKey)throw personalDrafts.failure('The assessment pass changed. Your entered edits remain here; review the current pass before retaining them.');
        if(req.body.private_draft_generation!==undefined&&!req.body.draft_id)personalDrafts.save(db,context,{payload:req.body,baseVersion:String(req.body.expected_record_version||0),generation:Number(req.body.private_draft_generation),expectedDraftVersion:Number(req.body.private_draft_version),clientSaveId:crypto.randomUUID()});
        return res.redirect(nextItem?`${base}/${nextItem.id}`:`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
      }
      const result=personalDrafts.commit(db,context,req.body,body=>{
        effectiveBody=body;
        if(!activePass && db.prepare("SELECT id FROM iso42001_assessment_passes WHERE workspace_id=? AND status='completed' LIMIT 1").get(req.workspace.id))throw personalDrafts.failure('The assessment pass is completed and retained. Start a new pass before recording further conclusions.');
        if(body.assessment_context!==undefined&&String(body.assessment_context)!==context.contextKey)throw personalDrafts.failure('The assessment pass changed. Compare the current pass before recording your conclusion.');
        const prior=db.prepare('SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(req.workspace.id,item.id);
        if(body.expected_record_version===undefined||!/^\d+$/.test(String(body.expected_record_version))||Number(body.expected_record_version)!==Number(prior?.record_version||0))throw personalDrafts.failure('The assessment version changed or this form predates version protection. Compare the recorded conclusion with your retained edits.');
        const validStatuses=['Not Assessed','Not Implemented','Work In Progress','Partially Implemented','Implemented','Not Applicable'];
        if(body.status!==undefined&&(!validStatuses.includes(body.status)||item.type==='clause'&&body.status==='Not Applicable'))throw personalDrafts.failure('Choose a valid conclusion. Mandatory clauses cannot be Not Applicable.',422);
        if(body.applicability!==undefined&&!['included','excluded','undecided'].includes(body.applicability))throw personalDrafts.failure('Choose Included, Excluded or Undecided.',422);
        if(item.type==='clause'&&body.applicability==='excluded')throw personalDrafts.failure('Mandatory clauses cannot be excluded.',422);
        if(body.maturity!==undefined&&body.maturity!==''&&!/^[0-4]$/.test(String(body.maturity)))throw personalDrafts.failure('Capability must be a whole number from 0 to 4.',422);
        for(const field of ['notes','inclusion_justification','exclusion_justification'])if(body[field]!==undefined&&String(body[field]).length>40000)throw personalDrafts.failure('Assessment text must be under 40,000 characters.',422);
        const sets=[],values=[],put=(field,value)=>{sets.push(field+'=?');values.push(value);};
        for(const field of ['status','applicability','notes','inclusion_justification','exclusion_justification'])if(body[field]!==undefined&&!(item.type==='clause'&&field==='applicability'))put(field,String(body[field]));
        if(item.type==='clause')put('applicability','included');
        if(body.maturity!==undefined&&body.maturity!=='')put('maturity',Number(body.maturity));
        if(body.diagnostic_set_id!==undefined||Object.keys(body).some(key=>/^q_\d+$/.test(key)))put('assessment_answers',diagnostics.serialize(item.id,iso42001QuestionsFor(item),body));
        const reviewInvalidated=!!(prior&&prior.review_status!=='none'&&sets.some((set,index)=>String(prior[set.slice(0,-2)]??'')!==String(values[index]??'')));
        if(reviewInvalidated)sets.push("review_status='none'",'review_requested_by=NULL','review_requested_at=NULL','review_reason=NULL','reviewed_by=NULL','reviewed_at=NULL');
        sets.push('last_updated=CURRENT_TIMESTAMP');
        if(body.status&&body.status!=='Not Assessed')sets.push('last_verified_at=CURRENT_TIMESTAMP');
        const requirementId=ctlWrites.requirementId(db,'iso42001',item.id);
        if(!requirementId)throw personalDrafts.failure('The requirement is unavailable. Your edits are retained.',422);
        const state=getOrCreate42State(req.workspace.id,item.id),converted=ctlWrites.convergeSets(sets,values);
        const updated=db.prepare(`UPDATE control_instances SET ${converted.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND record_version=?`).run(...converted.vals,req.workspace.id,requirementId,state.record_version);
        if(updated.changes!==1)throw personalDrafts.failure('The recorded assessment changed before your conclusion could be applied.');
        const current=db.prepare('SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(req.workspace.id,item.id);
        db.prepare(`INSERT INTO iso42001_control_state_history(workspace_id,iso_item_id,pass_id,changed_by,status,applicability,maturity,inclusion_justification,exclusion_justification,notes,assessment_answers) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(req.workspace.id,item.id,activePass?.id||null,req.user.id,current.status,current.applicability,current.maturity,current.inclusion_justification,current.exclusion_justification,current.notes,current.assessment_answers);
        logAction(req.user.id,req.workspace.id,'assess_iso42001','iso42001_item',item.id,{status:current.status,record_version:current.record_version,review_invalidated:reviewInvalidated},auditCtx(req));
        return {url:body.action==='save_next'&&nextItem?`${base}/${nextItem.id}`:`${base}/${item.id}`};
      });
      aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id);
      return res.redirect(result.url);
    }catch(error){
      if(!error.status)return nextMw(error);
      req.assessmentRecovery={body:effectiveBody,message:error.message};res.status(error.status);return render42001Assessment(req,res);
    }
  });

  // Reuse a file already on record against the paired ISO 27001 requirement
  // (lib/framework-crosswalk.js).
  app.post('/workspaces/:wsId/iso42001/gap/:isoId/reuse-evidence', requireAuth, requireWorkspace, requireInternalEvidenceMutation,
    requirePermission('evidence.upload'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/iso42001/gap/${encodeURIComponent(req.params.isoId)}`;
    try {
      const { from } = crosswalk.reuseEvidence(db, req.workspace, 'iso42001', req.params.isoId, req.body.evidence_id);
      logAction(req.user.id, req.workspace.id, 'reuse_evidence_crosswalk', 'evidence', Number(req.body.evidence_id),
        { to: req.params.isoId, from: from.ref }, auditCtx(req));
      res.redirect(withToast(back, `Evidence from ${from.code} linked`));
    } catch (e) {
      if (!(e instanceof crosswalk.CrosswalkError)) throw e;
      res.redirect(withToast(back, e.message, 'error'));
    }
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
  // Exact recorded-version review commands; independent authority is shared across programmes.
  for(const command of ['flag-for-review','review-action','clear-flag']) {
    const permission=command==='review-action'?'assessment.signoff':'control.update';
    app.post('/workspaces/:wsId/iso42001/gap/:isoId/'+command,requireAuth,requireWorkspace,requirePermission(permission),(req,res)=>{
      const item=db.prepare('SELECT id,title FROM iso42001_items WHERE id=?').get(req.params.isoId);
      if(!item)return res.status(404).send('Not found');
      const path=`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`;
      try{
        const action=command==='flag-for-review'?'request':command==='clear-flag'?'clear':String(req.body.action||'');
        require('../lib/control-review').transition(db,{workspace:req.workspace,actor:req.user,framework:'iso42001',itemId:item.id,action,
          expectedRecordVersion:req.body.expected_record_version,note:command==='flag-for-review'?req.body.reason:req.body.note},
          details=>logAction(req.user.id,req.workspace.id,'assessment_review_'+action,'iso42001_assessment',item.id,details,auditCtx(req)));
        return res.redirect(path);
      }catch(error){
        return res.status(Number(error.status)||422).render('assessment_review_error',{user:req.user,ws:req.workspace,item,path,message:error.message,
          note:String(req.body.note||req.body.reason||'').slice(0,4000)});
      }
    });
  }

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
    // The link table carries no workspace, so the risk must be this client's
    // before its link can be removed.
    const risk = db.prepare(`SELECT id FROM risks WHERE id=? AND workspace_id=?`).get(req.params.linkRiskId, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    db.prepare(`DELETE FROM iso42001_risk_controls WHERE risk_id=? AND iso_item_id=?`)
      .run(risk.id, req.params.isoId);
    logAction(req.user.id, req.workspace.id, 'unlink_iso42001_risk', 'iso42001_item', req.params.isoId, { risk_id: risk.id });
    res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
  });

  // --- Roadmap ---
  app.get('/workspaces/:wsId/iso42001/roadmap', requireAuth, requireWorkspace, (req, res) => {
    const wsId = req.workspace.id;
    const T = ctlReads.tables(db, wsId);
    // Each control's treatment phase is read from its due date (lib/iso42001-plan.js).
    const today = (new Date()).toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.maturity, cs.owner_id, cs.due_date,
        (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
        FROM iso42001_items i
        LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type='control'
        ORDER BY cs.due_date IS NULL, cs.due_date, i.sort_order`).all(wsId)
      .map(r => ({ ...r, roadmap_phase: aimsPlan.phaseFor(r.due_date, today), overdue: !!(r.due_date && r.due_date < today && r.status !== 'Implemented') }));
    const phases = aimsPlan.PHASES;
    const grouped = phases.map(p => ({ ...p, rows: rows.filter(r => r.roadmap_phase === p.key) }));

    // "Needs your attention" - live items needing action
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
    const completedAudits = db.prepare(`SELECT COUNT(*) AS c FROM audits WHERE workspace_id=? AND status IN ('complete','closed')`).get(wsId).c;

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
      milestone('check', 'Internal audit', '9.2', 'Completed internal audit with AIMS scope and a verified clause 9.2 conclusion',
        completedAudits > 0 && clauseStatus['ai-clause-9.2'] === 'Implemented',
        completedAudits > 0 && clauseStatus['ai-clause-9.2'] !== 'Implemented',
        `/workspaces/${wsId}/audits`, 'Open audits'),
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

  // Moving a control to a phase sets its due date inside that phase, or clears
  // it for Unscheduled (lib/iso42001-plan.js).
  app.post('/workspaces/:wsId/iso42001/roadmap/:isoId/phase', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/iso42001/roadmap`;
    try {
      const state = getOrCreate42State(req.workspace.id, req.params.isoId);
      if (!state) throw new aimsPlan.PlanError('That requirement is not in ISO 42001.', 404);
      const dueDate = aimsPlan.dueForPhase(String(req.body.phase ?? ''), state.due_date);
      const saved = aimsPlan.setPlan(db, req.workspace, req.params.isoId, { dueDate });
      logAction(req.user.id, req.workspace.id, 'plan_iso42001_control', 'iso42001_item', req.params.isoId, { ...saved, phase: req.body.phase || '' }, auditCtx(req));
      if (req.query.ajax === '1') return res.status(204).end();
      res.redirect(withToast(back, saved.due_date ? `Due ${saved.due_date}` : 'Moved to Unscheduled'));
    } catch (e) {
      if (!(e instanceof aimsPlan.PlanError)) throw e;
      if (req.query.ajax === '1') return res.status(e.status).json({ error: e.message });
      res.redirect(withToast(back, e.message, 'error'));
    }
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

    // Each record is found only when the record itself exists: an approved
    // document, an approved SoA, a retained risk assessment, approved impact
    // assessments, a reported internal audit, a completed management review.
    // A clause the consultant marked Implemented without that record is shown
    // as declared but not evidenced, rather than counted as found.
    const wsRow = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
    const count = (sql, ...params) => { try { return db.prepare(sql).get(...params).c || 0; } catch (_) { return 0; } };
    const approvedDocFor = (...refs) => count(`SELECT COUNT(*) c FROM document_requirement_links drl
        JOIN requirements rq ON rq.id = drl.requirement_id JOIN frameworks f ON f.id = rq.framework_id AND f.code='iso42001'
        JOIN generated_docs d ON d.id = drl.document_id
        WHERE d.workspace_id=? AND d.retired_at IS NULL AND d.status IN ('approved','published') AND rq.ref IN (${refs.map(() => '?').join(',')})`, wsId, ...refs) > 0;
    const linkedRecordFor = (ref) => approvedDocFor(ref) || count(`SELECT COUNT(*) c FROM evidence_requirement_links erl
        JOIN evidence e ON e.id = erl.evidence_id JOIN requirements rq ON rq.id = erl.requirement_id
        WHERE e.workspace_id=? AND e.superseded_at IS NULL AND rq.ref=?`, wsId, ref) > 0;
    const liveSystems = count(`SELECT COUNT(*) c FROM ai_systems WHERE workspace_id=? AND in_scope=1 AND lifecycle_stage != 'retired'`, wsId);
    const systemsAssessed = count(`SELECT COUNT(*) c FROM ai_systems s WHERE s.workspace_id=? AND s.in_scope=1 AND s.lifecycle_stage != 'retired'
        AND EXISTS (SELECT 1 FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id AND ia.status='approved')`, wsId);
    const recentRiskRecord = count(`SELECT COUNT(*) c FROM risk_assessment_records WHERE workspace_id=? AND performed_on >= date('now','-12 months')`, wsId) > 0;
    const aiRiskTreated = count(`SELECT COUNT(DISTINCT r.id) c FROM risks r JOIN iso42001_risk_controls rc ON rc.risk_id=r.id WHERE r.workspace_id=?`, wsId) > 0;
    const aimsAudit = count(`SELECT COUNT(*) c FROM audits a WHERE a.workspace_id=?
        AND (COALESCE(a.lifecycle_stage,'') IN ('report','follow_up','closed') OR a.status IN ('complete','completed','closed'))
        AND (EXISTS (SELECT 1 FROM audit_observations o WHERE o.audit_id=a.id AND o.iso_item_id LIKE 'ai-%')
          OR EXISTS (SELECT 1 FROM audit_findings f WHERE f.audit_id=a.id AND f.iso_item_id LIKE 'ai-%')
          OR EXISTS (SELECT 1 FROM audit_samples sm WHERE sm.audit_id=a.id AND sm.iso_item_id LIKE 'ai-%'))`, wsId) > 0;
    const reviewHeld = count(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status='complete' AND meeting_date >= date('now','-12 months')`, wsId) > 0;
    const aimsNcs = count(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND iso_item_id LIKE 'ai-%'`, wsId);
    // Objectives for the AIMS with the plan clause 6.2 asks for behind them.
    const objectives = count(`SELECT COUNT(*) c FROM security_objectives WHERE workspace_id=? AND COALESCE(framework,'iso42001')='iso42001'
      AND plan_actions IS NOT NULL AND evaluation_method IS NOT NULL`, wsId);
    const approvedSoa = aimsSoa.latestApproved(db, wsRow || { id: wsId });

    const record = (clauseId, name, found, basis) => ({
      name, clause: clauseId.replace('ai-clause-', ''), found: !!found, basis,
      declaredOnly: !found && clauseStatusById[clauseId] === 'Implemented',
    });
    const mandatoryChecks = [
      record('ai-clause-4.3', 'AIMS scope', approvedDocFor('ai-clause-4.3'), 'An approved scope document linked to clause 4.3'),
      record('ai-clause-5.2', 'AI policy', approvedDocFor('ai-clause-5.2', 'ai-annex-a-2-2'), 'An approved AI policy linked to clause 5.2 or A.2.2'),
      record('ai-clause-6.1.2', 'AI risk assessment process', approvedDocFor('ai-clause-6.1.2'), 'An approved risk assessment method linked to clause 6.1.2'),
      record('ai-clause-6.1.3', 'AI risk treatment process & SoA', !!approvedSoa, approvedSoa ? `SoA approved by ${approvedSoa.approved_by_name}` : 'An SoA snapshot approved by a second person'),
      record('ai-clause-6.1.4', 'AI system impact assessment process', approvedDocFor('ai-clause-6.1.4', 'ai-annex-a-5-2'), 'An approved impact assessment procedure linked to clause 6.1.4 or A.5.2'),
      record('ai-clause-6.2', 'AI objectives', objectives > 0, `${objectives} AIMS objective${objectives === 1 ? '' : 's'} with actions and an evaluation method`),
      record('ai-clause-7.5', 'Documented information control', approvedDocFor('ai-clause-7.5'), 'An approved document control procedure linked to clause 7.5'),
      record('ai-clause-8.2', 'AI risk assessment results', recentRiskRecord, 'A risk assessment recorded in the last 12 months'),
      record('ai-clause-8.3', 'AI risk treatment results', aiRiskTreated, 'Risks treated by ISO 42001 controls in the register'),
      record('ai-clause-8.4', 'AI system impact assessment results', liveSystems > 0 && systemsAssessed === liveSystems,
        liveSystems ? `${systemsAssessed} of ${liveSystems} in-scope AI systems have an approved impact assessment` : 'No in-scope AI system is registered'),
      record('ai-clause-9.2', 'Internal audit programme & results', aimsAudit, 'An internal audit covering ISO 42001 that has reached its report'),
      record('ai-clause-9.3', 'Management review results', reviewHeld, 'A completed management review in the last 12 months'),
      record('ai-clause-10.2', 'Nonconformity records', aimsNcs > 0 || aimsAudit,
        aimsNcs ? `${aimsNcs} nonconformit${aimsNcs === 1 ? 'y' : 'ies'} recorded against ISO 42001` : 'Nonconformities are recorded once the internal audit is reported'),
    ];
    const mandatoryFound = mandatoryChecks.filter(c => c.found).length;

    const expectedCheck = (ctlId, name, found, basis) => ({
      name, clause: ctlId.replace('ai-annex-','').toUpperCase().replace(/-/g,'.'),
      found: !!found, basis,
      declaredOnly: !found && !!(controlStatusById[ctlId] && controlStatusById[ctlId].status === 'Implemented'),
    });
    const expectedChecks = [
      expectedCheck('ai-annex-a-4-2', 'AI system inventory', liveSystems > 0, `${liveSystems} in-scope AI system${liveSystems === 1 ? '' : 's'} in the register`),
      expectedCheck('ai-annex-a-4-3', 'Dataset documentation (datasheets)', linkedRecordFor('ai-annex-a-4-3'), 'A document or evidence linked to A.4.3'),
      expectedCheck('ai-annex-a-5-3', 'Impact assessment reports per system', liveSystems > 0 && systemsAssessed === liveSystems, `${systemsAssessed} of ${liveSystems} approved`),
      expectedCheck('ai-annex-a-6-2-3', 'Design / model documentation', linkedRecordFor('ai-annex-a-6-2-3'), 'A document or evidence linked to A.6.2.3'),
      expectedCheck('ai-annex-a-6-2-4', 'Verification & validation reports', linkedRecordFor('ai-annex-a-6-2-4'), 'A document or evidence linked to A.6.2.4'),
      expectedCheck('ai-annex-a-6-2-7', 'AI system technical documentation / model cards', linkedRecordFor('ai-annex-a-6-2-7'), 'A document or evidence linked to A.6.2.7'),
      expectedCheck('ai-annex-a-6-2-8', 'Event logs specification', linkedRecordFor('ai-annex-a-6-2-8'), 'A document or evidence linked to A.6.2.8'),
      expectedCheck('ai-annex-a-7-5', 'Data lineage records', linkedRecordFor('ai-annex-a-7-5'), 'A document or evidence linked to A.7.5'),
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

    // Work planned against a requirement that is late, or has nobody on it.
    const todayYmd = new Date().toISOString().slice(0, 10);
    const overdueWork = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
      INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE cs.due_date < ? AND cs.status != 'Implemented' AND COALESCE(cs.applicability,'undecided') != 'excluded'
      ORDER BY cs.due_date LIMIT 20`).all(wsId, todayYmd);
    if (overdueWork.length) flags.push({ kind: 'controls_overdue', label: 'Requirements past their due date and not yet Implemented', severity: 'high', items: overdueWork });
    const unowned = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
      INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' AND cs.applicability='included' AND cs.owner_id IS NULL AND cs.status != 'Implemented'
      ORDER BY i.sort_order LIMIT 20`).all(wsId);
    if (unowned.length) flags.push({ kind: 'controls_unowned', label: 'Included Annex A controls with no owner', severity: 'medium', items: unowned });

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

    // Records an auditor asks for that do not exist yet.
    if (!approvedSoa) flags.push({ kind: 'soa_not_approved', label: 'The Statement of Applicability has no approved snapshot', severity: 'high', items: [] });
    const unassessedSystems = db.prepare(`SELECT s.id, s.name AS title FROM ai_systems s WHERE s.workspace_id=? AND s.in_scope=1 AND s.lifecycle_stage != 'retired'
      AND NOT EXISTS (SELECT 1 FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id AND ia.status='approved') ORDER BY s.name LIMIT 20`).all(wsId);
    if (unassessedSystems.length) flags.push({ kind: 'systems_without_ia', label: 'In-scope AI systems without an approved impact assessment', severity: 'high', items: unassessedSystems });
    if (!recentRiskRecord) flags.push({ kind: 'no_risk_record', label: 'No risk assessment recorded in the last 12 months', severity: 'medium', items: [] });
    const registry42 = require('../lib/ai-systems');
    const dueSystems = db.prepare(`SELECT id, name AS title FROM ai_systems WHERE workspace_id=? AND in_scope=1 AND lifecycle_stage != 'retired' ORDER BY name`).all(wsId)
      .filter(sys => registry42.reassessment(db, wsRow || { id: wsId }, sys.id).state === 'due');
    if (dueSystems.length) flags.push({ kind: 'reassessment_due', label: 'AI systems whose impact assessment is due for review or was overtaken by a change', severity: 'medium', items: dueSystems });
    const contextIssues = count('SELECT COUNT(*) c FROM context_issues WHERE workspace_id=?', wsId);
    const contextParties = count('SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=?', wsId);
    if (!contextIssues || !contextParties) flags.push({ kind: 'context_missing', label: 'Internal and external issues or interested parties are not recorded (clauses 4.1 and 4.2)', severity: 'medium', items: [] });
    const cbOpen = aimsCycle.openFindings(db, wsRow || { id: wsId });
    if (cbOpen.total) flags.push({ kind: 'open_cb_findings', label: `Open certification body findings (${cbOpen.major || 0} major, ${cbOpen.minor || 0} minor)`, severity: 'high', items: [] });

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

    if (ws.frameworks.includes('iso27001') && !isoLifecycle.isGapOnly(ws.engagement_outcome)) {
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

    // Open AI risks, rated on the client's own risk methodology: the band after
    // treatment where a residual rating is recorded, else before it, and whether
    // a high one has been formally accepted. No money figure is shown, because
    // the register does not record one.
    const { getActiveMethodology, methodologyBand } = require('../db');
    const methodology = getActiveMethodology(wsId);
    const openRisks = db.prepare(`SELECT r.id, r.title, r.likelihood, r.impact, r.residual_likelihood, r.residual_impact, r.owner_name, r.status,
        EXISTS (SELECT 1 FROM risk_acceptances ra WHERE ra.risk_id = r.id AND ra.revoked_at IS NULL) AS accepted
      FROM risks r WHERE r.workspace_id=? AND r.status != 'closed' AND ${aiRisk.isAiRiskSql('r')}
      ORDER BY (r.likelihood * r.impact) DESC, r.id`).all(wsId).map(r => {
      const residual = !!(r.residual_likelihood && r.residual_impact);
      const band = methodology ? String(methodologyBand(methodology, residual ? r.residual_likelihood : r.likelihood, residual ? r.residual_impact : r.impact) || '') : '';
      return { ...r, residual, band, severe: /high|critical|extreme|severe/i.test(band), score: (r.likelihood || 0) * (r.impact || 0) };
    });
    const topRisks = openRisks.slice(0, 5);
    const openRiskCount = openRisks.length;
    const riskSummary = {
      severe: openRisks.filter(r => r.severe).length,
      severeUnaccepted: openRisks.filter(r => r.severe && !r.accepted).length,
      unrated: openRisks.filter(r => !r.residual).length,
    };

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
      readiness, velocityNow, velocityPrior, velocityDelta, riskSummary, openRiskCount,
      planDone, planTotal, planPct, ncTotals, topRisks, topNCs });
  });

  // --- Certification cycle ---
  // Every audit date for the client, and the certification body's findings
  // against each audit (lib/iso42001-cycle). The programme overview's Stage 1
  // and Stage 2 dates are the current cycle's Stage events. A gap-assessment-
  // only engagement has no certification audits.
  const requireAimsCertification = outcomeScope.requirePostGapService(
    'Certification audits are outside this gap-assessment-only engagement. Continue the client to full certification support to plan Stage 1 and Stage 2.');
  const cycleUrl = (ws, hash) => `/workspaces/${ws.id}/iso42001/cert-cycle${hash ? `#${hash}` : ''}`;
  // A change to an audit can undo a completed delivery plan (Stage 2 is what
  // certification support is closed against), so the plan is reconciled
  // after every change, as for ISO 27001.
  function reconcileCertificationChange(req, details) {
    const delivery = require('../lib/engagement-delivery');
    delivery.reconcileCompletionState(db, req.workspace, req.user.id, {
      reason: 'An ISO 42001 certification event changed after delivery completion.', details,
    });
    if (db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=?').get(req.workspace.id)) {
      delivery.syncOutcomePlanStatus(db, req.workspace, req.user.id);
      delivery.syncCertificationEngagementCompletion(db, req.workspace, req.user.id);
    }
  }
  const cycleAction = (fn) => (req, res) => {
    let result;
    try {
      result = db.transaction(() => fn(req))();
    } catch (error) {
      if (error instanceof aimsCycle.CycleError) {
        if (error.status === 404) return res.status(404).send(error.message);
        return res.redirect(withToast(cycleUrl(req.workspace), error.message, 'error'));
      }
      throw error;
    }
    reconcileCertificationChange(req, { mutation: String(req.path || req.originalUrl || '').split('/').pop(), event_id: Number(req.params && req.params.id) || null });
    return res.redirect(withToast(cycleUrl(req.workspace, result && result.hash), (result && result.message) || 'Certification cycle updated'));
  };

  app.get('/workspaces/:wsId/iso42001/cert-cycle', requireAuth, requireWorkspace, requireAimsCertification, (req, res) => {
    const events = aimsCycle.events(db, req.workspace);
    const current = aimsCycle.currentCycle(db, req.workspace.id);
    const recert = events.find(e => e.cycle_no === current && e.event_key === 'recert');
    res.render('iso42001_cert_cycle', {
      user: req.user, ws: req.workspace, events, currentCycle: current,
      eventTypes: aimsCycle.EVENT_TYPES, severities: aimsCycle.SEVERITIES, statuses: aimsCycle.STATUSES,
      requirementGroups: reqOpts.grouped(db, req.workspace),
      canStartNextCycle: !!(recert && recert.status === 'completed' && recert.actual_date),
      openFindings: aimsCycle.openFindings(db, req.workspace),
    });
  });

  app.post('/workspaces/:wsId/iso42001/cert-cycle/seed', requireAuth, requireWorkspace, requireAimsCertification, requirePermission('control.update'), cycleAction(req => {
    const target = (db.prepare('SELECT target_cert_date FROM workspaces WHERE id=?').get(req.workspace.id) || {}).target_cert_date;
    const added = aimsCycle.seed(db, req.workspace, req.user.id, target || null);
    logAction(req.user.id, req.workspace.id, 'seed_iso42001_cert_cycle', 'iso42001_cert_event', null, { added });
    return { message: added ? `Planned ${added} audit${added === 1 ? '' : 's'} for this cycle` : 'Every audit of this cycle is already planned' };
  }));

  app.post('/workspaces/:wsId/iso42001/cert-cycle/add', requireAuth, requireWorkspace, requireAimsCertification, requirePermission('control.update'), cycleAction(req => {
    const id = aimsCycle.addEvent(db, req.workspace, req.user.id, req.body);
    logAction(req.user.id, req.workspace.id, 'add_iso42001_cert_event', 'iso42001_cert_event', id, { event_key: req.body.event_key || req.body.event_type });
    return { hash: `event-${id}`, message: 'Added to the certification cycle' };
  }));

  app.post('/workspaces/:wsId/iso42001/cert-cycle/next', requireAuth, requireWorkspace, requireAimsCertification, requirePermission('control.update'), cycleAction(req => {
    const next = aimsCycle.startNextCycle(db, req.workspace, req.user.id);
    logAction(req.user.id, req.workspace.id, 'start_iso42001_cert_cycle', 'iso42001_cert_event', null, { cycle_no: next });
    return { message: `Cycle ${next} planned: two surveillance audits and the next recertification` };
  }));

  app.post('/workspaces/:wsId/iso42001/cert-cycle/:id/update', requireAuth, requireWorkspace, requireAimsCertification, requirePermission('control.update'), cycleAction(req => {
    const id = aimsCycle.updateEvent(db, req.workspace, req.user.id, req.params.id, req.body);
    logAction(req.user.id, req.workspace.id, 'update_iso42001_cert_event', 'iso42001_cert_event', id, { status: req.body.status || null });
    return { hash: `event-${id}`, message: 'Audit updated' };
  }));

  app.post('/workspaces/:wsId/iso42001/cert-cycle/:id/delete', requireAuth, requireWorkspace, requireAimsCertification, requirePermission('control.update'), cycleAction(req => {
    aimsCycle.deleteEvent(db, req.workspace, req.user.id, req.params.id);
    logAction(req.user.id, req.workspace.id, 'delete_iso42001_cert_event', 'iso42001_cert_event', Number(req.params.id), null);
    return { message: 'Removed from the certification cycle' };
  }));

  // A finding the certification body raised at a Stage 1, Stage 2,
  // surveillance or recertification audit. It becomes a nonconformity with
  // retained lineage (see lib/iso42001-cycle.js), tracked to closure with the
  // client on the nonconformity page.
  app.post('/workspaces/:wsId/iso42001/cert-cycle/:id/findings', requireAuth, requireWorkspace, requireAimsCertification, requirePermission('nc.manage'), cycleAction(req => {
    const ncId = aimsCycle.recordFinding(db, req.workspace, req.user.id, req.params.id, req.body);
    fts.refresh(req.workspace.id, 'nc', ncId);
    logAction(req.user.id, req.workspace.id, 'record_iso42001_cb_finding', 'nonconformity', ncId,
      { event_id: Number(req.params.id), severity: req.body.severity, iso_item_id: req.body.iso_item_id || null }, auditCtx(req));
    return { hash: `event-${req.params.id}`, message: 'Finding recorded. Track its correction from the nonconformity.' };
  }));

  // --- Intake ---
  app.get('/workspaces/:wsId/iso42001/intake', requireAuth, requireWorkspace, (req, res) => {
    const rows = db.prepare(`SELECT question_key, answer FROM iso42001_intake_answers WHERE workspace_id=?`).all(req.workspace.id);
    const answers = {};
    rows.forEach(r => { answers[r.question_key] = r.answer; });
    const total = ISO42001_INTAKE_QUESTIONS.length;
    const answered = ISO42001_INTAKE_QUESTIONS.filter(q => (answers[q.key] || '').trim()).length;
    const draftScope = buildIso42001DraftScope(answers);
    res.render('iso42001_intake', { user: req.user, ws: req.workspace,
      sections: ISO42001_INTAKE_SECTIONS, answers, total, answered, draftScope,
      layers: aimsScope.LAYERS, statementFields: aimsScope.STATEMENT_FIELDS });
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
    aimsAssessment.reconcileDelivery(db,req.workspace.id,req.user.id,'The ISO 42001 scope or intake context changed.');
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
    aimsAssessment.reconcileDelivery(db,wsId,req.user.id,'The ISO 42001 intake was applied to assessment conclusions.');
    res.redirect(`/workspaces/${wsId}/iso42001/gap/ai-clause-4.3`);
  });

  // Preserve old bookmarks and checklist records, but all new decisions use
  // the common evidence-gated delivery plan. Legacy ticks are not approvals.
  app.get('/workspaces/:wsId/iso42001/engagement-plan', requireAuth, requireWorkspace, (req, res) => {
    const view = ['plan', 'timeline', 'gates'].includes(req.query.view) ? `?view=${req.query.view}` : '';
    res.redirect(`/workspaces/${req.workspace.id}/engagement-plan${view}`);
  });
  app.post('/workspaces/:wsId/iso42001/engagement-plan/:phaseKey/:action', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    res.status(409).render('error', { user: req.user, ws: req.workspace, message: 'This legacy checklist is retained as history. Use the engagement delivery plan to submit evidence and record phase-gate decisions.' });
  });


  shared.getOrCreate42State = getOrCreate42State;
  shared.computeIso42001Readiness = computeIso42001Readiness;
}

module.exports = { register, shared };
