'use strict';
// SoA + crosswalks. Slice 6 of the server.js modularization: statement of
// applicability (single, batch, and bulk updates) and the cross-framework
// mapping view. Converged reads/writes via lib/control-reads / control-writes.

const ctlReads = require('../lib/control-reads');
const ctlWrites = require('../lib/control-writes');
const docLinks = require('../lib/doc-links');
const { withToast, redirectBack, auditCtx, parseFormArray } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState } = deps;

  app.get('/workspaces/:wsId/soa', requireAuth, requireWorkspace, (req, res) => {
    // Ensure every Annex A control has a control_states row so subsequent SoA
    // POSTs and bulk operations can UPDATE without silent no-ops. Idempotent.
    // Ensure a converged whole-org control_instances row for every Annex A control
    // so the SoA can render + bulk-update them (control_states demolished, 019).
    db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id)
                SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                WHERE f.code='iso27001' AND rq.req_type='control'`).run(req.workspace.id);

    // Cutover 3: control-state + doc-link reads come from legacy tables or the
    // converged compatibility views per the per-workspace control_reads_converged
    // flag (views de-normalize to byte-identical display values). Writes above stay legacy.
    const T = ctlReads.tables(db, req.workspace.id);
    const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.inclusion_justification, cs.exclusion_justification,
        cs.last_verified_at,
        (SELECT COUNT(*) FROM risk_controls rc INNER JOIN risks r ON r.id = rc.risk_id
         WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS risk_count,
        (SELECT COUNT(*) FROM evidence e WHERE e.iso_item_id = i.id AND e.workspace_id = ?) AS evidence_count,
        (SELECT COUNT(*) FROM nonconformities n WHERE n.iso_item_id = i.id AND n.workspace_id = ? AND n.status != 'closed') AS open_nc_count,
        (SELECT COUNT(*) FROM nonconformities n WHERE n.iso_item_id = i.id AND n.workspace_id = ?
          AND n.created_at > datetime('now','-12 months')) AS systemic_count
        FROM iso_items i
        LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        WHERE i.type = 'control'
        ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id);

    // Phase A: linked documents per control (only docs in this workspace)
    const soaDocLinks = db.prepare(`
      SELECT dc.iso_item_id, dc.section_ref, d.id AS doc_id, d.name AS doc_name, d.status AS doc_status, d.category
      FROM ${docLinks.docControlsExpr('iso27001')} dc
      INNER JOIN generated_docs d ON d.id = dc.document_id
      WHERE d.workspace_id = ?
      ORDER BY d.name
    `).all(req.workspace.id);
    const docsByControl = {};
    soaDocLinks.forEach(l => { (docsByControl[l.iso_item_id] = docsByControl[l.iso_item_id] || []).push(l); });

    // ISO 27001 6.1.3.d.1: SoA must show which risks make each control "necessary".
    // Pull the actual risks linked to each control so the auditor can see the chain
    // from risk → control → SoA inclusion without clicking through.
    const riskLinks = db.prepare(`
      SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title, r.likelihood, r.impact, r.status
      FROM risk_controls rc
      INNER JOIN risks r ON r.id = rc.risk_id
      WHERE r.workspace_id = ?
      ORDER BY (r.likelihood * r.impact) DESC
    `).all(req.workspace.id);
    const risksByControl = {};
    riskLinks.forEach(l => { (risksByControl[l.iso_item_id] = risksByControl[l.iso_item_id] || []).push(l); });

    // Custom (non-Annex-A) controls live alongside the 93 Annex A entries.
    const customControls = db.prepare(`SELECT * FROM soa_custom_controls
      WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);

    // SoA metadata - version / owner / approver / approved-on, taken from the
    // latest snapshot. If no snapshot exists, the form lets the user kick one
    // off; saving via /soa/metadata captures one automatically.
    const latestSnap = db.prepare(`SELECT id, label, version, owner, approved_by, approved_at, created_at
      FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(req.workspace.id);

    // Counts to power the preview text on the bulk-decide buttons - lets
    // the consultant see "this will flip 47 rows" before confirming,
    // instead of a generic "are you sure?" dialog.
    const soaCounts = {
      included:  rows.filter(r => r.applicability === 'included').length,
      excluded:  rows.filter(r => r.applicability === 'excluded').length,
      undecided: rows.filter(r => !r.applicability || r.applicability === 'undecided').length,
      total:     rows.length
    };

    res.render('soa', {
      user: req.user, ws: req.workspace, rows, docsByControl, risksByControl,
      customControls, soaMeta: latestSnap || {}, soaCounts
    });
  });

  app.post('/workspaces/:wsId/soa/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res, nextMw) => {
    // Reserved literal sub-routes (snapshot, auto-justify, bulk, custom-controls, metadata)
    // must fall through to their own handlers.
    if (['snapshot','auto-justify','snapshots','bulk','custom-controls','metadata'].includes(req.params.isoId)) return nextMw();
    getOrCreateState(req.workspace.id, req.params.isoId);
    const { applicability, inclusion_justification, exclusion_justification, status } = req.body;
    // Cutover 4 (W4): converged-authoritative SoA save; applicability/status normalized
    // to tokens (014 mirrors back to legacy display values).
    const wcSoa = ctlWrites.converged(db, req.workspace.id);
    const ridSoa = wcSoa ? ctlWrites.requirementId(db, 'iso27001', req.params.isoId) : null;
    if (wcSoa && ridSoa) {
      db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification=?, exclusion_justification=?,
                  status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
        .run(ctlWrites.normApplic(applicability || 'undecided'),
             inclusion_justification || null, exclusion_justification || null,
             ctlWrites.normStatus(status || null), req.workspace.id, ridSoa);
    } else {
      db.prepare(`UPDATE control_states SET applicability=?, inclusion_justification=?, exclusion_justification=?,
                  status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
                  WHERE workspace_id=? AND iso_item_id=?`)
        .run(applicability || 'undecided',
             inclusion_justification || null, exclusion_justification || null,
             status || null, req.workspace.id, req.params.isoId);
    }
    logAction(req.user.id, req.workspace.id, 'update_soa', 'control', req.params.isoId, null);
    // Autosave fetches use ?ajax=1 so they don't follow a redirect they don't need.
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect('/workspaces/' + req.workspace.id + '/soa');
  });

  // SoA batch save. Used by the "Save all changes" button on /soa to flush
  // every dirty row in one round-trip instead of one POST per row. Body shape:
  //   rows = JSON array of { iso_item_id, applicability, status,
  //                          inclusion_justification, exclusion_justification }
  // All updates run in a single transaction; the response is 200 with the count.
  app.post('/workspaces/:wsId/soa/batch', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    let rows = [];
    try { rows = JSON.parse(req.body.rows || '[]'); } catch (_) { rows = []; }
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ ok: false, message: 'No rows to save.' });
    }
    // Guard against junk: cap batch size; reject rows missing iso_item_id.
    if (rows.length > 250) return res.status(400).json({ ok: false, message: 'Batch too large.' });
    const valid = rows.filter(r => r && typeof r.iso_item_id === 'string' && r.iso_item_id);
    // Converged-only per-row batch save (control_states demolished, 019).
    const upsertCi = db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)`);
    const updateCi = db.prepare(`UPDATE control_instances SET
        applicability = ?, inclusion_justification = ?, exclusion_justification = ?,
        status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND requirement_id = ? AND entity_id IS NULL`);
    const tx = db.transaction(() => {
      valid.forEach(r => {
        const rid = ctlWrites.requirementId(db, 'iso27001', r.iso_item_id);
        if (!rid) return;
        upsertCi.run(req.workspace.id, rid);
        updateCi.run(
          ctlWrites.normApplic(r.applicability || 'undecided'),
          r.inclusion_justification || null,
          r.exclusion_justification || null,
          ctlWrites.normStatus(r.status || null),
          req.workspace.id, rid
        );
      });
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'soa_batch_save', 'soa', null, { count: valid.length }, auditCtx(req));
    res.json({ ok: true, count: valid.length });
  });

  // Bulk SoA applicability + justification. Body shape:
  //   action       = 'include_all' | 'include_undecided' | 'apply_to_selected' | 'exclude_selected'
  //   iso_id       = repeated for 'apply_to_selected' / 'exclude_selected'
  //   justification = applied to every affected row (inclusion_justification or
  //                   exclusion_justification depending on the action)
  app.post('/workspaces/:wsId/soa/bulk', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
    const { action, justification } = req.body;
    const ids = parseFormArray(req.body.iso_id);
    // Cutover 4 (W4): set-based bulk writes go converged-authoritative on a
    // write-flipped workspace. The WHERE filter maps iso_item_id -> requirement_id
    // (entity_id IS NULL whole-org rows); every applicability literal routes through
    // normApplic (never raw to the converged table). 014 fires per affected row
    // (SQLite triggers are FOR EACH ROW), so the legacy mirror stays consistent.
    const wcBulk = ctlWrites.converged(db, req.workspace.id);
    // 27001 control requirement_ids (matches iso_items WHERE type='control').
    const CTL_REQ = `SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id WHERE f.code='iso27001' AND rq.req_type='control'`;
    if (wcBulk) {
      db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id)
                  SELECT ?, rq.id, NULL FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                  WHERE f.code='iso27001' AND rq.req_type='control'`).run(req.workspace.id);
    } else {
      db.prepare(`INSERT OR IGNORE INTO control_states (workspace_id, iso_item_id)
                  SELECT ?, id FROM iso_items WHERE type='control'`).run(req.workspace.id);
    }
    let affected = 0;
    if (action === 'include_all') {
      affected = wcBulk
        ? db.prepare(`UPDATE control_instances SET applicability=?,
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND entity_id IS NULL AND requirement_id IN (${CTL_REQ})`)
            .run(ctlWrites.normApplic('included'), justification || null, req.workspace.id).changes
        : db.prepare(`UPDATE control_states SET applicability='included',
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND iso_item_id IN (SELECT id FROM iso_items WHERE type='control')`)
            .run(justification || null, req.workspace.id).changes;
    } else if (action === 'include_undecided') {
      affected = wcBulk
        ? db.prepare(`UPDATE control_instances SET applicability=?,
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND entity_id IS NULL AND applicability=? AND requirement_id IN (${CTL_REQ})`)
            .run(ctlWrites.normApplic('included'), justification || null, req.workspace.id, ctlWrites.normApplic('undecided')).changes
        : db.prepare(`UPDATE control_states SET applicability='included',
                      inclusion_justification = COALESCE(?, inclusion_justification), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND applicability IN ('undecided','')
                        AND iso_item_id IN (SELECT id FROM iso_items WHERE type='control')`)
            .run(justification || null, req.workspace.id).changes;
    } else if ((action === 'apply_to_selected' || action === 'exclude_selected') && ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const applicability = action === 'exclude_selected' ? 'excluded' : 'included';
      const justCol = applicability === 'excluded' ? 'exclusion_justification' : 'inclusion_justification';
      affected = wcBulk
        ? db.prepare(`UPDATE control_instances SET applicability=?,
                      ${justCol} = COALESCE(?, ${justCol}), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND entity_id IS NULL
                        AND requirement_id IN (SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id=rq.framework_id
                                               WHERE f.code='iso27001' AND rq.ref IN (${placeholders}))`)
            .run(ctlWrites.normApplic(applicability), justification || null, req.workspace.id, ...ids).changes
        : db.prepare(`UPDATE control_states SET applicability=?,
                      ${justCol} = COALESCE(?, ${justCol}), last_updated = CURRENT_TIMESTAMP
                      WHERE workspace_id=? AND iso_item_id IN (${placeholders})`)
            .run(applicability, justification || null, req.workspace.id, ...ids).changes;
    }
    logAction(req.user.id, req.workspace.id, 'soa_bulk', 'soa', null, { action, affected, count: ids.length }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/soa`, `${affected} control${affected === 1 ? '' : 's'} updated`));
  });

  // ==================== CROSSWALKS ====================
  // Full-matrix view of which ISO 27001 Annex A controls map to which external
  // frameworks (SOC 2, NIST CSF 2.0, GDPR). The point of a multi-framework GRC
  // tool: one piece of evidence credits controls across all frameworks the
  // engagement runs. Grouped by Annex A theme. Filterable by framework, status,
  // and search. Inclusion / status come from control_states for this workspace.
  app.get('/workspaces/:wsId/crosswalks', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const frameworkFilter = (req.query.framework || 'all').toString();
    const statusFilter = (req.query.status || 'all').toString();
    const q = (req.query.q || '').toString().trim().toLowerCase();

    // Annex A controls only. Clauses don't carry crosswalks.
    const T = ctlReads.tables(db, req.workspace.id);
    const controls = db.prepare(
      `SELECT i.id, i.title, i.category, i.sort_order,
              COALESCE(cs.applicability, 'undecided') AS applicability,
              COALESCE(cs.status, 'Not Assessed')     AS status
       FROM iso_items i
       LEFT JOIN ${T.cs} cs
         ON cs.iso_item_id = i.id AND cs.workspace_id = ?
       WHERE i.type = 'control'
       ORDER BY i.sort_order ASC`
    ).all(req.workspace.id);

    const allMappings = db.prepare(
      `SELECT iso_item_id, framework, external_ref, notes FROM framework_mappings`
    ).all();
    const byControl = {};
    for (const m of allMappings) {
      if (!byControl[m.iso_item_id]) byControl[m.iso_item_id] = {};
      if (!byControl[m.iso_item_id][m.framework]) byControl[m.iso_item_id][m.framework] = [];
      byControl[m.iso_item_id][m.framework].push(m);
    }

    // Coverage counters - how many included controls in this workspace are mapped
    // to each framework. Drives the headline KPI tiles.
    const includedIds = new Set(controls.filter(c => c.applicability === 'included').map(c => c.id));
    const frameworks = ['soc2', 'nist_csf', 'gdpr'];
    const coverage = {};
    for (const fw of frameworks) {
      const mapped = new Set(allMappings.filter(m => m.framework === fw).map(m => m.iso_item_id));
      const includedMapped = [...includedIds].filter(id => mapped.has(id)).length;
      coverage[fw] = {
        total_mapped: mapped.size,
        included_mapped: includedMapped,
        total_included: includedIds.size
      };
    }

    // Apply filters to the displayed rows.
    let rows = controls.map(c => ({
      ...c,
      mappings: byControl[c.id] || {}
    }));
    if (frameworkFilter !== 'all') {
      rows = rows.filter(r => r.mappings[frameworkFilter]);
    }
    if (statusFilter === 'included') {
      rows = rows.filter(r => r.applicability === 'included');
    } else if (statusFilter === 'unmapped') {
      rows = rows.filter(r => Object.keys(r.mappings).length === 0);
    }
    if (q) {
      rows = rows.filter(r => {
        if (r.id.toLowerCase().includes(q)) return true;
        if ((r.title || '').toLowerCase().includes(q)) return true;
        for (const fw of Object.keys(r.mappings)) {
          for (const m of r.mappings[fw]) {
            if ((m.external_ref || '').toLowerCase().includes(q)) return true;
          }
        }
        return false;
      });
    }

    // Group rendered rows by Annex A theme. DB column iso_items.category uses
    // the short codes: org / people / physical / tech.
    const themes = [
      { key: 'org',      label: 'A.5 Organizational' },
      { key: 'people',   label: 'A.6 People'         },
      { key: 'physical', label: 'A.7 Physical'       },
      { key: 'tech',     label: 'A.8 Technological'  }
    ];
    const byTheme = {};
    for (const t of themes) byTheme[t.key] = [];
    for (const r of rows) {
      if (byTheme[r.category]) byTheme[r.category].push(r);
    }

    res.render('crosswalks', {
      user: req.user, ws: req.workspace,
      title: 'Crosswalks',
      active: 'crosswalks',
      themes, byTheme, coverage,
      frameworkFilter, statusFilter, q: req.query.q || '',
      totalControls: controls.length,
      rowCount: rows.length
    });
  });

}

module.exports = { register };
