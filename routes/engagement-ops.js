'use strict';
// Engagement operations (final long-tail pass): exec brief, playbooks,
// objectives, custom controls, SoA metadata, engagement deliverables,
// document hierarchy, audit programme + sampling, incident timeline +
// runbook, supplier monitoring, task templates, asset relationships,
// member stats, access reviews, permission lookup, audit-chain verify,
// widgets API, readiness drill-down, controls kanban + bulk import/export,
// risk appetite + acceptance e-sign, search, handover export, bulk ops,
// report builder, observations + crisis comms, key rotation + backup UI,
// file preview, comment mentions.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const archiver = require('archiver');
const fts = require('../lib/fts');
const enc = require('../lib/encryption');
const rbac = require('../lib/rbac');
const email = require('../lib/email');
const jobs = require('../lib/jobs');
const backup = require('../lib/backup');
const keyrotation = require('../lib/keyrotation');
const ctlReads = require('../lib/control-reads');
const ctlWrites = require('../lib/control-writes');
const docLinks = require('../lib/doc-links');
const evReads = require('../lib/evidence-reads');
const reports = require('../lib/reports');
const restoreCheck = require('../lib/restore-check');
const { computeReadiness } = require('../lib/readiness');
const { ymdLocal, ymLocal } = require('../lib/dates');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, escapeHtml, parseFormArray, extractMentions } = require('../lib/http-helpers');
const generateDocxBuffer = require('../lib/workers').generateDocx;
const htmlToDocxPooled = require('../lib/workers').htmlToDocxPooled;

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          getActiveFirmId, isFirmUser, isFirmOwner, getOrCreateState,
          getActiveMethodology, methodologyBand, activeEntityFilter,
          resolveUploadPath, upload, csvUpload, qUploadAny, resolveQuestionnaireFirm, computeClientStage, permissionsFor, persistQuestionnaireFiles,
          verifyAuditChain, listWorkspaces, workspaceProgress } = deps;

  // ==================== EXEC BRIEF (one-page CISO/board readout) ====================
  // Single-page health summary that renders as one screen, prints to one A4
  // page. Built for the sponsor's monthly skim, not for the consultant's
  // detail work. Includes: readiness now, velocity (gap closure trend),
  // residual-risk monetary estimate, top-5 risks, top-5 NCs.

  app.get('/workspaces/:wsId/exec-brief', requireAuth, requireWorkspace, (req, res) => {
    const ws = req.workspace;
    const readiness = computeReadiness(ws);

    // Velocity = controls moved to Implemented in last 30 days vs the prior 30.
    const velNow = db.prepare(`SELECT COUNT(*) c FROM control_state_history
      WHERE workspace_id=? AND status='Implemented'
      AND snapshot_at >= datetime('now','-30 days')`).get(ws.id).c;
    const velPrior = db.prepare(`SELECT COUNT(*) c FROM control_state_history
      WHERE workspace_id=? AND status='Implemented'
      AND snapshot_at >= datetime('now','-60 days')
      AND snapshot_at < datetime('now','-30 days')`).get(ws.id).c;
    const velocityDelta = velNow - velPrior;

    // Residual-risk financial estimate. ISO doesn't mandate $ - but a board
    // wants one. Use Annual Loss Expectancy: SLE × ARO heuristic.
    // For each open risk, treat (likelihood / 5) as ARO and (impact * tier) as
    // SLE. Tier defaults to $50k * impact (1=$50k, 5=$250k) - configurable
    // via workspace setting later.
    const tierBase = 50000;
    const openRisks = db.prepare(`SELECT id, title, likelihood, impact, owner_name FROM risks
      WHERE workspace_id=? AND status NOT IN ('closed','accepted')`).all(ws.id);
    let aleSum = 0;
    for (const r of openRisks) {
      const aro = (r.likelihood || 3) / 5;
      const sle = (r.impact || 3) * tierBase;
      aleSum += aro * sle;
    }
    const residualAle = Math.round(aleSum);

    // Top 5 by inherent score
    const topRisks = openRisks
      .map(r => ({ ...r, score: (r.likelihood || 0) * (r.impact || 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Top open NCs by severity then due date
    const topNCs = db.prepare(`SELECT id, title, severity, due_date, status FROM nonconformities
      WHERE workspace_id=? AND status NOT IN ('closed','verified')
      ORDER BY CASE severity WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, due_date
      LIMIT 5`).all(ws.id);

    // Total open NC counts for the headline
    const ncTotals = db.prepare(`SELECT
      SUM(CASE WHEN severity='major' AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS major,
      SUM(CASE WHEN severity='minor' AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS minor,
      SUM(CASE WHEN due_date < date('now') AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS overdue
      FROM nonconformities WHERE workspace_id=?`).get(ws.id);

    // Engagement plan progress (if used)
    const planTotal = require('../data/engagement-plan').flatten().length;
    const planDone = db.prepare(`SELECT COUNT(*) c FROM engagement_plan_progress
      WHERE workspace_id=? AND completed_at IS NOT NULL`).get(ws.id).c;

    res.render('exec_brief', {
      user: req.user, ws,
      readiness,
      velocityNow: velNow, velocityPrior: velPrior, velocityDelta,
      residualAle, openRiskCount: openRisks.length,
      topRisks, topNCs, ncTotals,
      planTotal, planDone, planPct: planTotal ? Math.round(planDone / planTotal * 100) : 0,
      derivedStage: computeClientStage(ws),
    });
  });


  // ==================== CONSULTANT PLAYBOOKS ====================
  // Firm-level reference material - kickoff agenda, scoping workshop, risk
  // workshop facilitator script. Read-only. Lives at /playbooks (no workspace
  // context required) so a junior consultant can open it during any client call.
  const PLAYBOOKS = require('../data/playbooks');

  app.get('/playbooks', requireAuth, (req, res) => {
    res.render('playbooks_index', { user: req.user, ws: null, playbooks: PLAYBOOKS.PLAYBOOK_INDEX }); // firm-level page - firm sidebar
  });

  app.get('/playbooks/:id', requireAuth, (req, res) => {
    const pb = PLAYBOOKS.PLAYBOOKS[req.params.id];
    if (!pb) return res.status(404).render('error', { user: req.user, message: 'Playbook not found' });
    res.render('playbook_detail', { user: req.user, ws: null, playbook: pb }); // firm-level page - firm sidebar
  });

  // ==================== INFORMATION SECURITY OBJECTIVES (clause 6.2) ====================
  app.get('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, (req, res) => {
    const rows = db.prepare(`SELECT * FROM security_objectives WHERE workspace_id=? ORDER BY due_date IS NULL, due_date, id`)
      .all(req.workspace.id);
    res.render('objectives', {
      user: req.user, ws: req.workspace, title: 'Security objectives', active: 'objectives', rows
    });
  });

  app.post('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const b = req.body;
    if (!b.title || !b.title.trim()) return redirectBack(req, res, 'Objective title is required', 'error');
    db.prepare(`INSERT INTO security_objectives
      (workspace_id, title, description, measurement, target_value, current_value, owner, due_date, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, b.title.trim(), b.description || null, b.measurement || null,
           b.target_value || null, b.current_value || null, b.owner || null,
           b.due_date || null, b.status || 'on_track', b.notes || null);
    logAction(req.user.id, req.workspace.id, 'create_objective', 'objective', null, { title: b.title });
    res.redirect(`/workspaces/${req.workspace.id}/objectives`);
  });

  app.post('/workspaces/:wsId/objectives/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const b = req.body;
    db.prepare(`UPDATE security_objectives SET
      title=?, description=?, measurement=?, target_value=?, current_value=?, owner=?, due_date=?, status=?, notes=?,
      updated_at=datetime('now')
      WHERE id=? AND workspace_id=?`)
      .run(b.title, b.description || null, b.measurement || null,
           b.target_value || null, b.current_value || null, b.owner || null,
           b.due_date || null, b.status || 'on_track', b.notes || null,
           req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/objectives`);
  });

  app.post('/workspaces/:wsId/objectives/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare('DELETE FROM security_objectives WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/objectives`);
  });

  // ==================== CUSTOM (NON-ANNEX-A) CONTROLS ====================
  // 27001:2022 explicitly allows controls outside Annex A. They sit alongside
  // the 93 Annex A controls in the SoA.
  app.post('/workspaces/:wsId/soa/custom-controls', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const b = req.body;
    if (!b.code || !b.title) return redirectBack(req, res, 'Both code and title are required', 'error');
    db.prepare(`INSERT INTO soa_custom_controls
      (workspace_id, code, title, description, source_framework, applicability, inclusion_justification, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, b.code.trim(), b.title.trim(),
           b.description || null, b.source_framework || null,
           b.applicability || 'included', b.inclusion_justification || null,
           b.status || 'Not Assessed');
    logAction(req.user.id, req.workspace.id, 'create_custom_control', 'custom_control', null, { code: b.code });
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  app.post('/workspaces/:wsId/soa/custom-controls/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const b = req.body;
    db.prepare(`UPDATE soa_custom_controls SET
      code=?, title=?, description=?, source_framework=?, applicability=?, inclusion_justification=?, exclusion_justification=?, status=?, notes=?,
      updated_at=datetime('now')
      WHERE id=? AND workspace_id=?`)
      .run(b.code, b.title, b.description || null, b.source_framework || null,
           b.applicability || 'included', b.inclusion_justification || null, b.exclusion_justification || null,
           b.status || 'Not Assessed', b.notes || null,
           req.params.id, req.workspace.id);
    if (req.query.ajax === '1') return res.status(204).end();
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  app.post('/workspaces/:wsId/soa/custom-controls/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    db.prepare('DELETE FROM soa_custom_controls WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  // ==================== SOA METADATA HEADER ====================
  // Save SoA document-control metadata (version / owner / approver / approved_at).
  // Each Save captures a NEW snapshot stamped with the metadata, so audit history
  // preserves every revision - bumping v1.0 → v2.0 leaves v1.0's signoff intact
  // instead of overwriting it. Label defaults to "v{version}" if version is set.
  app.post('/workspaces/:wsId/soa/metadata', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const b = req.body;
    const label = b.version ? `v${b.version}` : 'Metadata revision';
    const snap = captureSoASnapshot(req.workspace.id, req.user.id, null, label, 'Metadata saved');
    db.prepare(`UPDATE soa_snapshots SET version=?, owner=?, approved_by=?, approved_at=? WHERE id=?`)
      .run(b.version || null, b.owner || null, b.approved_by || null, b.approved_at || null, snap.id);
    logAction(req.user.id, req.workspace.id, 'update_soa_metadata', 'soa_snapshot', snap.id, b);
    res.redirect(`/workspaces/${req.workspace.id}/soa`);
  });

  // ==================== ENGAGEMENT DELIVERABLES ====================
  // PDF/DOCX/ZIP exports the consultant produces at end-of-pass to hand to the
  // client and to bring to the certification audit.

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Resolve a workspace's brand_logo_path to a data: URI for embedding in DOCX.
  // Returns null if the path is empty, points at a remote URL (offline-first), or
  // the file cannot be read. Tries the per-tenant uploads directory first, then
  // the app-root relative path, then the literal path as absolute.
  function brandLogoDataUri(ws) {
    const raw = (ws && ws.brand_logo_path) ? String(ws.brand_logo_path).trim() : '';
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return null;
    const candidates = [];
    if (ws.firm_id) candidates.push(path.join(__dirname, 'uploads', `firm_${ws.firm_id}`, raw));
    candidates.push(path.join(__dirname, raw));
    if (path.isAbsolute(raw)) candidates.push(raw);
    for (const p of candidates) {
      try {
        const stat = fs.statSync(p);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const ext = path.extname(p).toLowerCase();
        const mime = ext === '.png'  ? 'image/png'
                   : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                   : ext === '.svg'  ? 'image/svg+xml'
                   : ext === '.webp' ? 'image/webp'
                   : ext === '.gif'  ? 'image/gif' : null;
        if (!mime) continue;
        const b64 = fs.readFileSync(p).toString('base64');
        return `data:${mime};base64,${b64}`;
      } catch (_) { /* try next candidate */ }
    }
    return null;
  }

  // Two-letter brand initials for the cover-page logo fallback.
  function brandInitials(ws) {
    const name = (ws && (ws.brand_display_name || ws.client_name)) || 'ISMS';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }

  // Validate + default the workspace brand color. Mirrors the regex used at
  // /workspaces/:wsId/update so a malformed value never leaks into HTML.
  function brandColor(ws) {
    const c = ws && ws.brand_primary_color;
    if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim())) return c.trim();
    return '#4F46E5'; // app accent (--accent)
  }

  // Shared CSS for every page of a branded deliverable. Used by the cover,
  // header, footer, and body so the document is visually one piece.
  function deliverableCss(ws) {
    const accent = brandColor(ws);
    return `
      body{font-family:Calibri,sans-serif;font-size:11pt;line-height:1.45;color:#0F0F12;margin:0;}
      h1{font-size:22pt;color:#0F0F12;margin:0 0 4pt;letter-spacing:-0.01em;}
      h2{font-size:14pt;color:${accent};margin:18pt 0 6pt;border-bottom:1pt solid #ECECEF;padding-bottom:3pt;}
      h3{font-size:12pt;color:#0F0F12;margin:12pt 0 4pt;}
      .meta{color:#71717A;font-size:9.5pt;}
      table{border-collapse:collapse;width:100%;margin:6pt 0;font-size:9.5pt;}
      th,td{border:1pt solid #D6D6DB;padding:4pt 6pt;text-align:left;vertical-align:top;}
      th{background:#F4F4F5;color:#0F0F12;font-weight:500;}
      .tag{display:inline-block;padding:1pt 5pt;border-radius:3pt;font-size:8.5pt;font-weight:500;}
      .tag-impl{background:#dcfce7;color:#15803d;}
      .tag-partial{background:#fef3c7;color:#a16207;}
      .tag-wip{background:#dbeafe;color:#1d4ed8;}
      .tag-noimpl{background:#fee2e2;color:#b91c1c;}
      .tag-na{background:#e5e7eb;color:#71717A;}
    `;
  }

  // Cover-page HTML for the first page of a branded deliverable. Built as a
  // table because html-to-docx only honours `background-color` on table cells
  // (divs are converted to plain paragraphs with no shading). The colored
  // header band is a single full-width <td> with background; the metadata row
  // below sits in a borderless table. Followed by a forced page break so the
  // running header/footer kick in from page 2.
  function deliverableCoverHtml(title, ws) {
    const accent = brandColor(ws);
    const logo = brandLogoDataUri(ws);
    const initials = brandInitials(ws);
    const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
    const sector = ws.sector ? escHtml(ws.sector) : (ws.industry ? escHtml(ws.industry) : '');
    const today = new Date().toISOString().slice(0, 10);

    // Logo line on the colored band. With a resolved local file we render an
    // <img> (html-to-docx inlines data: URIs natively). Without one, the
    // initials become a small uppercase eyebrow over the title - cleaner than
    // a nested table for the cover, and nested tables get silently dropped by
    // html-to-docx when used inside a shaded <td>.
    const logoLine = logo
      ? `<p style="margin:0 0 22pt 0;"><img src="${logo}" alt="" style="width:64pt;height:64pt;"></p>`
      : `<p style="margin:0 0 18pt 0;font-size:14pt;font-weight:700;color:#FFFFFF;letter-spacing:0.05em;">${escHtml(initials)}</p>`;

    // Metadata cells - only the ones that have content. Built as an array and
    // joined so we don't emit empty cells (would render as visible blanks).
    const metaCells = [];
    if (sector) metaCells.push(`<td style="border:none;padding:0 24pt 0 0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Sector</strong><br>${sector}</td>`);
    metaCells.push(`<td style="border:none;padding:0 24pt 0 0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Generated</strong><br>${today}</td>`);
    if (ws.target_cert_date) {
      metaCells.push(`<td style="border:none;padding:0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Target certification</strong><br>${escHtml(ws.target_cert_date)}</td>`);
    }

    return `
      <table style="width:100%;border-collapse:collapse;border:none;margin:0 0 28pt 0;">
        <tr>
          <td style="background-color:${accent};color:#FFFFFF;padding:48pt 40pt 48pt 40pt;border:none;">
            ${logoLine}
            <p style="margin:0 0 6pt 0;font-size:10pt;font-weight:500;color:#FFFFFF;letter-spacing:0.10em;">${escHtml(title.toUpperCase())}</p>
            <p style="margin:0;font-size:30pt;font-weight:700;line-height:1.15;color:#FFFFFF;">${clientName}</p>
          </td>
        </tr>
      </table>
      <table style="width:100%;border:none;border-collapse:collapse;margin:0 0 8pt 0;">
        <tr>${metaCells.join('')}</tr>
      </table>
      <div class="page-break" style="page-break-after: always;"></div>
    `;
  }

  // Running header HTML: client name on left, document title on right; a thin
  // brand-color rule renders as a single-row table whose only cell has the
  // brand color as its background (html-to-docx only honours background-color
  // on <td>).
  function deliverableHeaderHtml(title, ws) {
    const accent = brandColor(ws);
    const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${deliverableCss(ws)}</style></head><body>
      <table style="width:100%;border:none;border-collapse:collapse;font-size:9pt;color:#71717A;margin:0;">
        <tr>
          <td style="border:none;padding:0 0 3pt 0;text-align:left;"><strong style="color:#0F0F12;">${clientName}</strong></td>
          <td style="border:none;padding:0 0 3pt 0;text-align:right;">${escHtml(title)}</td>
        </tr>
      </table>
      <table style="width:100%;border:none;border-collapse:collapse;margin:0;">
        <tr><td style="background-color:${accent};border:none;padding:0;height:1.5pt;line-height:1.5pt;font-size:1pt;">&nbsp;</td></tr>
      </table>
    </body></html>`;
  }

  // Running footer HTML: workspace name on left, generated date center. Page
  // number is appended by html-to-docx via pageNumber:true on the options.
  function deliverableFooterHtml(ws) {
    const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
    const today = new Date().toISOString().slice(0, 10);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${deliverableCss(ws)}</style></head><body>
      <table style="width:100%;border:none;font-size:8.5pt;color:#9C9CA5;margin:0;">
        <tr>
          <td style="border:none;padding:0;text-align:left;">${clientName}</td>
          <td style="border:none;padding:0;text-align:center;">${today}</td>
          <td style="border:none;padding:0;text-align:right;">Page </td>
        </tr>
      </table>
    </body></html>`;
  }

  // Full-document HTML: shared CSS + cover page + body. The cover page is on
  // its own page (the forced page-break inside deliverableCoverHtml) so the
  // header / footer / page-number machinery from html-to-docx kicks in on
  // page 2 onwards (skipFirstHeaderFooter:true). This is the entry the four
  // callsites below use.
  function deliverableHtmlShell(title, ws, bodyHtml) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
      <style>${deliverableCss(ws)}</style></head><body>
      ${deliverableCoverHtml(title, ws)}
      <div style="padding:0 6pt;">
        <h1>${escHtml(title)}</h1>
        ${bodyHtml}
      </div>
      </body></html>`;
  }

  // One-call wrapper around html-to-docx that wires the cover + header + footer
  // + page-number bundle for every branded deliverable. Returns the DOCX as a
  // Buffer ready to send or to append to a ZIP.
  async function brandedDocx(ws, title, bodyHtml) {
    const html = deliverableHtmlShell(title, ws, bodyHtml);
    return await require('../lib/workers').htmlToDocxPooled(
      html,
      deliverableHeaderHtml(title, ws),
      {
        title,
        subject: `${ws.client_name || ''} · ${title}`,
        creator: 'ISMS tool',
        header: true,
        footer: true,
        pageNumber: true,
        skipFirstHeaderFooter: true,
        table: { row: { cantSplit: true } }
      },
      deliverableFooterHtml(ws)
    );
  }
  function statusTag(s) {
    if (!s) return '<span class="tag tag-na">-</span>';
    const cls = s === 'Implemented' ? 'tag-impl'
      : s === 'Partially Implemented' ? 'tag-partial'
      : s === 'Work In Progress' ? 'tag-wip'
      : s === 'Not Implemented' ? 'tag-noimpl'
      : 'tag-na';
    return `<span class="tag ${cls}">${escHtml(s)}</span>`;
  }

  // Risk Treatment Plan (clause 6.1.3.e) - formal document export pulling from
  // the live risk register.
  app.get('/workspaces/:wsId/export/rtp.docx', requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    const risks = db.prepare(`SELECT r.* FROM risks r
      WHERE r.workspace_id=? ORDER BY (r.likelihood * r.impact) DESC, r.id`).all(ws.id);
    const actionsByRisk = {};
    if (risks.length) {
      const rids = risks.map(r => r.id);
      const ph = rids.map(() => '?').join(',');
      db.prepare(`SELECT * FROM risk_treatment_actions WHERE risk_id IN (${ph}) ORDER BY due_date IS NULL, due_date`)
        .all(...rids).forEach(a => { (actionsByRisk[a.risk_id] = actionsByRisk[a.risk_id] || []).push(a); });
    }
    const ctrlByRisk = {};
    if (risks.length) {
      const rids = risks.map(r => r.id);
      const ph = rids.map(() => '?').join(',');
      db.prepare(`SELECT rc.risk_id, rc.iso_item_id, i.title FROM risk_controls rc
        INNER JOIN iso_items i ON i.id = rc.iso_item_id WHERE rc.risk_id IN (${ph})`)
        .all(...rids).forEach(c => { (ctrlByRisk[c.risk_id] = ctrlByRisk[c.risk_id] || []).push(c); });
    }

    let body = '<h2>Methodology</h2><p>This Risk Treatment Plan documents, for every risk in the register, the chosen treatment option, the controls applied, the responsible owner, and the implementation timeframe - as required by ISO/IEC 27001:2022 clause 6.1.3.e.</p>';
    body += `<p>Risks: <strong>${risks.length}</strong></p>`;
    body += '<h2>Treatment plan by risk</h2>';
    if (risks.length === 0) {
      body += '<p><em>No risks recorded yet.</em></p>';
    } else {
      body += '<table><thead><tr><th width="8%">ID</th><th>Risk</th><th width="10%">L×I</th><th width="10%">Treatment</th><th width="14%">Owner</th><th>Controls applied</th><th>Actions</th></tr></thead><tbody>';
      for (const r of risks) {
        const ctrls = (ctrlByRisk[r.id] || []).map(c => escHtml(c.iso_item_id.replace('annex-','').toUpperCase()) + ' ' + escHtml(c.title.replace(/^A\.[0-9.]+ /,''))).join('<br>') || '<em class="meta">-</em>';
        const acts = (actionsByRisk[r.id] || []).map(a => `<strong>${escHtml(a.title)}</strong><br><span class="meta">${escHtml(a.assignee_role || '')}${a.due_date ? ' · due ' + escHtml(a.due_date) : ''} · ${escHtml(a.status || '')}</span>`).join('<br><br>') || '<em class="meta">-</em>';
        body += `<tr><td>R-${r.id}</td><td><strong>${escHtml(r.title)}</strong>${r.description ? '<br><span class="meta">' + escHtml(r.description) + '</span>' : ''}</td><td>${r.likelihood || '-'}×${r.impact || '-'}</td><td>${escHtml(r.treatment || '-')}</td><td>${escHtml(r.owner_name || '-')}</td><td>${ctrls}</td><td>${acts}</td></tr>`;
      }
      body += '</tbody></table>';
    }
    const buf = await brandedDocx(ws, 'Risk Treatment Plan', body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="risk-treatment-plan-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
    res.send(buf);
  });

  // Gap Assessment Report - produced at end-of-pass for handoff.
  app.get('/workspaces/:wsId/export/gap-report.docx', requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    const passId = req.query.pass ? parseInt(req.query.pass, 10) : null;
    let pass = null;
    if (passId) {
      pass = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(passId, ws.id);
    }
    if (!pass) {
      pass = db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=?
        ORDER BY (status='in_progress') DESC, pass_number DESC LIMIT 1`).get(ws.id);
    }

    // For each control: end-of-pass status (using the same logic as the diff route).
    const items = db.prepare(`SELECT i.id, i.type, i.title, i.sort_order
      FROM iso_items i WHERE i.type IN ('clause','control') ORDER BY i.sort_order`).all();
    const stmt = db.prepare(`SELECT h.status, h.maturity, h.applicability, h.notes
      FROM control_state_history h
      INNER JOIN assessment_passes p ON p.id = h.pass_id
      WHERE h.workspace_id=? AND h.iso_item_id=? AND p.pass_number <= ?
      ORDER BY p.pass_number DESC, h.snapshot_at DESC, h.id DESC LIMIT 1`);
    const rows = pass ? items.map(it => {
      const r = stmt.get(ws.id, it.id, pass.pass_number) || { status:'Not Assessed', maturity:null, applicability:'undecided', notes:null };
      return { ...it, ...r, code: it.id.replace(/^annex-/,'').replace(/^clause-/,'').toUpperCase() };
    }) : [];

    // Group by category for the executive summary.
    const counts = { 'Implemented':0, 'Partially Implemented':0, 'Work In Progress':0, 'Not Implemented':0, 'Not Assessed':0, 'Not Applicable':0 };
    rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const total = rows.length;
    const gaps = rows.filter(r => ['Not Implemented','Partially Implemented','Work In Progress'].includes(r.status));
    const ncOpen = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified')`).get(ws.id).c;

    let body = '<h2>Executive summary</h2>';
    body += `<p>This report summarises the gap-assessment findings produced during <strong>Pass ${pass ? pass.pass_number : '-'}${pass && pass.label ? ' · ' + escHtml(pass.label) : ''}</strong>${pass && pass.completed_at ? ' (completed ' + pass.completed_at.slice(0,10) + ')' : pass && pass.status === 'in_progress' ? ' (in progress)' : ''}. The findings are based on documented evidence reviewed and consultant interviews.</p>`;
    body += '<table style="width:auto"><thead><tr><th>Status</th><th>Count</th><th>%</th></tr></thead><tbody>';
    for (const [s, c] of Object.entries(counts)) {
      body += `<tr><td>${statusTag(s)}</td><td>${c}</td><td>${total ? Math.round(c/total*100) : 0}%</td></tr>`;
    }
    body += `<tr><td><strong>Total</strong></td><td><strong>${total}</strong></td><td>100%</td></tr>`;
    body += '</tbody></table>';
    body += `<p>Open nonconformities at time of report: <strong>${ncOpen}</strong></p>`;

    body += '<h2>Identified gaps</h2>';
    if (gaps.length === 0) {
      body += '<p><em>No gaps identified at this pass.</em></p>';
    } else {
      body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th>Notes</th></tr></thead><tbody>';
      for (const g of gaps) {
        const cleanTitle = g.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
        body += `<tr><td>${escHtml(g.code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(g.status)}</td><td>${escHtml(g.notes || '')}</td></tr>`;
      }
      body += '</tbody></table>';
    }

    body += '<h2>Full assessment results</h2>';
    body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th width="8%">Maturity</th></tr></thead><tbody>';
    for (const r of rows) {
      const cleanTitle = r.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
      body += `<tr><td>${escHtml(r.code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(r.status)}</td><td>${r.maturity == null ? '-' : r.maturity}</td></tr>`;
    }
    body += '</tbody></table>';

    const title = `Gap Assessment Report - Pass ${pass ? pass.pass_number : ''}`;
    const buf = await brandedDocx(ws, title, body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="gap-assessment-report-${ws.id}-pass${pass ? pass.pass_number : 'X'}-${new Date().toISOString().slice(0,10)}.docx"`);
    res.send(buf);
  });

  // Recommendations memo - ranked, actionable handoff.
  app.get('/workspaces/:wsId/export/recommendations.docx', requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    // Pull rows where status is Not Implemented / Partially / WIP - ordered by severity.
    const items = db.prepare(`SELECT i.id, i.type, i.title, COALESCE(cs.status,'Not Assessed') AS status,
        cs.maturity, cs.notes
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control') AND COALESCE(cs.status,'Not Assessed') IN ('Not Implemented','Partially Implemented','Work In Progress')
      ORDER BY (CASE COALESCE(cs.status,'Not Assessed')
        WHEN 'Not Implemented' THEN 0
        WHEN 'Partially Implemented' THEN 1
        WHEN 'Work In Progress' THEN 2 ELSE 3 END), i.sort_order`).all(ws.id);

    let body = '<h2>How to read this memo</h2><p>This memo lists recommended remediation activity from the most recent gap assessment, ranked by current implementation status. Each row identifies the clause / control, the current status, and the consultant\'s notes from the assessment. Implementation is the client\'s responsibility; the consultant will return to verify each item once the client signals it is complete.</p>';
    body += `<p>Items requiring action: <strong>${items.length}</strong></p>`;
    body += '<h2>Recommendations</h2>';
    if (items.length === 0) {
      body += '<p><em>No outstanding recommendations - every assessed item is at "Implemented".</em></p>';
    } else {
      body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th>Recommendation / consultant notes</th></tr></thead><tbody>';
      for (const r of items) {
        const code = r.id.replace(/^annex-/,'').replace(/^clause-/,'').toUpperCase();
        const cleanTitle = r.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
        body += `<tr><td>${escHtml(code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(r.status)}</td><td>${escHtml(r.notes || '')}</td></tr>`;
      }
      body += '</tbody></table>';
    }

    const buf = await brandedDocx(ws, 'Recommendations Memo', body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="recommendations-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
    res.send(buf);
  });

  // Stage 1/2 readiness pack - single ZIP with the management-system docs +
  // linked evidence + manifest.
  app.get('/workspaces/:wsId/export/readiness-pack.zip', requireAuth, requireWorkspace, async (req, res) => {
    const ws = req.workspace;
    const stage = (req.query.stage === '2') ? 2 : 1;
    const dateLabel = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="readiness-pack-stage${stage}-${ws.id}-${dateLabel}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { try { res.status(500).send(String(err)); } catch (_) {} });
    archive.pipe(res);

    // 1. SoA CSV (reuse the existing CSV format)
    const soaRows = db.prepare(`SELECT i.id, i.title, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.inclusion_justification, cs.exclusion_justification
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' ORDER BY i.sort_order`).all(ws.id);
    const customRows = db.prepare(`SELECT * FROM soa_custom_controls WHERE workspace_id=? ORDER BY code`).all(ws.id);
    const csvLines = ['id,title,applicability,status,justification'];
    function csvEsc(v) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
    for (const r of soaRows) {
      csvLines.push([r.id.replace('annex-','').toUpperCase(), csvEsc(r.title.replace(/^A\.[0-9.]+ /,'')), r.applicability, r.status, csvEsc(r.applicability === 'excluded' ? r.exclusion_justification : r.inclusion_justification)].join(','));
    }
    for (const c of customRows) {
      csvLines.push([csvEsc(c.code), csvEsc(c.title), c.applicability, c.status, csvEsc(c.applicability === 'excluded' ? c.exclusion_justification : c.inclusion_justification)].join(','));
    }
    archive.append(csvLines.join('\n'), { name: '01_soa.csv' });

    // 2. Risk Treatment Plan DOCX (call the same generator inline by re-rendering)
    const risks = db.prepare(`SELECT r.* FROM risks r
      WHERE r.workspace_id=? ORDER BY (r.likelihood*r.impact) DESC, r.id`).all(ws.id);
    let rtpBody = `<p>Risks: ${risks.length}</p><table><thead><tr><th>ID</th><th>Risk</th><th>L×I</th><th>Treatment</th><th>Owner</th></tr></thead><tbody>`;
    for (const r of risks) {
      rtpBody += `<tr><td>R-${r.id}</td><td>${escHtml(r.title)}</td><td>${r.likelihood || ''}×${r.impact || ''}</td><td>${escHtml(r.treatment || '')}</td><td>${escHtml(r.owner_name || '')}</td></tr>`;
    }
    rtpBody += '</tbody></table>';
    const rtpDocx = await brandedDocx(ws, 'Risk Treatment Plan', rtpBody);
    archive.append(rtpDocx, { name: '02_risk_treatment_plan.docx' });

    // 3. Internal audit summary CSV
    const audits = db.prepare(`SELECT * FROM audits WHERE workspace_id=? ORDER BY audit_date DESC`).all(ws.id);
    const auditCsv = ['id,title,scope,audit_date,auditor,status,summary'];
    for (const a of audits) {
      auditCsv.push([a.id, csvEsc(a.title || ''), csvEsc(a.scope || ''), a.audit_date || '', csvEsc(a.auditor_name || ''), a.status || '', csvEsc(a.summary || '')].join(','));
    }
    archive.append(auditCsv.join('\n'), { name: '03_internal_audits.csv' });

    // 4. MRMs CSV
    const mrms = db.prepare(`SELECT * FROM mrms WHERE workspace_id=? ORDER BY meeting_date DESC`).all(ws.id);
    const mrmCsv = ['id,meeting_date,status,attendees'];
    for (const m of mrms) {
      mrmCsv.push([m.id, m.meeting_date || '', m.status || '', csvEsc(m.attendees || '')].join(','));
    }
    archive.append(mrmCsv.join('\n'), { name: '04_management_reviews.csv' });

    // 5. Interested parties CSV
    const ip = db.prepare(`SELECT * FROM interested_parties WHERE workspace_id=? ORDER BY party`).all(ws.id);
    const ipCsv = ['party,party_type,needs,how_addressed,owner,review_cadence,last_reviewed,next_review'];
    for (const r of ip) {
      ipCsv.push([csvEsc(r.party), csvEsc(r.party_type), csvEsc(r.needs), csvEsc(r.how_addressed), csvEsc(r.owner), csvEsc(r.review_cadence), r.last_reviewed || '', r.next_review || ''].join(','));
    }
    archive.append(ipCsv.join('\n'), { name: '05_interested_parties.csv' });

    // 6. Objectives CSV
    const objs = db.prepare(`SELECT * FROM security_objectives WHERE workspace_id=? ORDER BY due_date IS NULL, due_date`).all(ws.id);
    const objCsv = ['title,measurement,target_value,current_value,owner,due_date,status'];
    for (const o of objs) {
      objCsv.push([csvEsc(o.title), csvEsc(o.measurement), csvEsc(o.target_value), csvEsc(o.current_value), csvEsc(o.owner), o.due_date || '', o.status || ''].join(','));
    }
    archive.append(objCsv.join('\n'), { name: '06_objectives.csv' });

    // 7. Evidence files (active only) + manifest CSV
    const evidence = db.prepare(`SELECT e.*, u.name AS uploader,
      ${evReads.linkedControlsSubquery()} AS linked_controls
      FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id=? AND e.superseded_at IS NULL ORDER BY e.uploaded_at`).all(ws.id);
    const evCsv = ['id,filename,sha256,uploader,uploaded_at,period,valid_from,valid_until,linked_controls,description'];
    for (const e of evidence) {
      evCsv.push([e.id, csvEsc(e.filename), e.sha256 || '', csvEsc(e.uploader), e.uploaded_at ? e.uploaded_at.slice(0,19) : '', csvEsc(e.period_label), e.valid_from || '', e.valid_until || '', csvEsc(e.linked_controls), csvEsc(e.description)].join(','));
    }
    archive.append(evCsv.join('\n'), { name: '07_evidence_manifest.csv' });
    for (const e of evidence) {
      const found = resolveUploadPath(e.stored_path, ws.firm_id);
      if (found && fs.existsSync(found) && fs.statSync(found).isFile()) {
        archive.file(found, { name: `evidence/${e.id}-${e.filename}` });
      }
    }

    // README
    archive.append(
  `Stage ${stage} readiness pack - ${ws.client_name || 'Workspace ' + ws.id}
  Generated ${new Date().toISOString()}

  Contents:
    01_soa.csv                - Statement of Applicability (Annex A + custom controls)
    02_risk_treatment_plan.docx - Formal RTP (clause 6.1.3.e)
    03_internal_audits.csv    - Internal audit programme history
    04_management_reviews.csv - MRM history
    05_interested_parties.csv - Clause 4.2 register
    06_objectives.csv         - Clause 6.2 register
    07_evidence_manifest.csv  - Index of every evidence file with SHA-256 + linked controls
    evidence/                 - Actual evidence artefacts (filename: <id>-<name>)

  This is the artefact set a Stage ${stage} certification audit will request.
  SHA-256 in the manifest lets the auditor verify nothing was altered after export.
  `, { name: 'README.txt' });

    archive.finalize();
  });

  // ==================== DOCUMENT HIERARCHY ====================
  app.get('/workspaces/:wsId/documents/tree', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
    const docs = db.prepare(`SELECT id, name, category, status, parent_doc_id, doc_kind, reference_code, version
      FROM generated_docs WHERE workspace_id=? ORDER BY parent_doc_id IS NOT NULL, name`).all(req.workspace.id);
    res.render('documents_tree', { user: req.user, ws: req.workspace, docs });
  });

  app.post('/workspaces/:wsId/documents/:id/parent', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const pid = req.body.parent_doc_id ? parseInt(req.body.parent_doc_id, 10) : null;
    // Prevent self-loop
    if (pid && pid == req.params.id) return redirectBack(req, res);
    db.prepare('UPDATE generated_docs SET parent_doc_id=?, doc_kind=?, reference_code=? WHERE id=? AND workspace_id=?')
      .run(pid, req.body.doc_kind || null, req.body.reference_code || null, req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'reparent_document', 'document', req.params.id, { parent_doc_id: pid }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/documents/${req.params.id}`);
  });

  // ==================== AUDIT PROGRAMME + SAMPLING ====================
  app.get('/workspaces/:wsId/audit-programme', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    let programme = db.prepare('SELECT * FROM audit_programmes WHERE workspace_id=? AND year=?').get(req.workspace.id, year);
    if (!programme) {
      db.prepare('INSERT INTO audit_programmes (workspace_id, year) VALUES (?, ?)').run(req.workspace.id, year);
      programme = db.prepare('SELECT * FROM audit_programmes WHERE workspace_id=? AND year=?').get(req.workspace.id, year);
    }
    const audits = db.prepare(`SELECT * FROM audits WHERE workspace_id=? AND audit_date BETWEEN ? AND ? ORDER BY audit_date`)
      .all(req.workspace.id, `${year}-01-01`, `${year}-12-31`);
    res.render('audit_programme', { user: req.user, ws: req.workspace, programme, audits, year });
  });

  app.post('/workspaces/:wsId/audit-programme/:id', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const { description, approved_by } = req.body;
    const sets = [];
    const vals = [];
    if (description !== undefined) { sets.push('description=?'); vals.push(description || null); }
    if (approved_by) { sets.push('approved_by=?', 'approved_at=CURRENT_TIMESTAMP'); vals.push(approved_by); }
    if (sets.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE audit_programmes SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    }
    logAction(req.user.id, req.workspace.id, 'update_programme', 'programme', req.params.id, null, auditCtx(req));
    redirectBack(req, res);
  });

  // Sampling helper API: given population N, return suggested sample size at 95% confidence / 5% margin.
  app.get('/api/sample-size', (req, res) => {
    const N = Math.max(0, parseInt(req.query.population || 0, 10));
    // Cochran's formula at z=1.96, p=0.5, e=0.05 → n0 = 384.16
    const n0 = 384.16;
    if (N === 0) return res.json({ recommended: 0, note: 'Provide a population size.' });
    const adjusted = Math.ceil(n0 / (1 + (n0 - 1) / N));
    // Random seed indices (1-based) for the sample
    const idxs = [];
    const seen = new Set();
    while (idxs.length < Math.min(adjusted, N)) {
      const r = 1 + Math.floor(Math.random() * N);
      if (!seen.has(r)) { seen.add(r); idxs.push(r); }
    }
    idxs.sort((a, b) => a - b);
    res.json({ population: N, recommended: Math.min(adjusted, N), method: '95% CI / 5% margin (Cochran)', sample_indices: idxs });
  });

  // ==================== INCIDENT TIMELINE + RUNBOOK ====================
  app.post('/workspaces/:wsId/incidents/:id/events', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    const { phase, event_at, description, actor } = req.body;
    if (!phase || !description) return redirectBack(req, res);
    db.prepare(`INSERT INTO incident_events (workspace_id, incident_id, phase, event_at, description, actor)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, phase,
      event_at || new Date().toISOString(), description, actor || req.user.name);
    // Update phase timestamps on incident
    const phaseColumnMap = { detect: null, contain: 'contained_at', eradicate: 'eradicated_at', recover: 'recovered_at' };
    if (phaseColumnMap[phase]) {
      db.prepare(`UPDATE incidents SET ${phaseColumnMap[phase]}=COALESCE(${phaseColumnMap[phase]}, ?) WHERE id=? AND workspace_id=?`)
        .run(event_at || new Date().toISOString(), req.params.id, req.workspace.id);
    }
    logAction(req.user.id, req.workspace.id, 'add_incident_event', 'incident', req.params.id, { phase }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/incidents/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/incidents/:id/runbook', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    const rid = req.body.runbook_id ? parseInt(req.body.runbook_id, 10) : null;
    db.prepare('UPDATE incidents SET runbook_id=? WHERE id=? AND workspace_id=?').run(rid, req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'attach_runbook', 'incident', req.params.id, { runbook_id: rid }, auditCtx(req));
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/incidents/:id/regulator-clock', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    const { detected_at, regulator, hours } = req.body;
    if (!detected_at || !hours) return redirectBack(req, res);
    const due = new Date(new Date(detected_at).getTime() + parseFloat(hours) * 3600 * 1000).toISOString();
    db.prepare('UPDATE incidents SET notification_required_by=? WHERE id=? AND workspace_id=?').run(due, req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'set_regulator_clock', 'incident', req.params.id, { regulator, due }, auditCtx(req));
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/incidents/:id/notify-sent', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    db.prepare('UPDATE incidents SET notification_sent_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/incidents/:id/pir', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
    db.prepare('UPDATE incidents SET pir_completed=1, pir_summary=? WHERE id=? AND workspace_id=?').run(req.body.pir_summary || null, req.params.id, req.workspace.id);
    redirectBack(req, res);
  });

  // ==================== SUPPLIER MONITORING + TERMINATION + CONCENTRATION ====================
  app.post('/workspaces/:wsId/vendors/:id/monitoring', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const { source, score, grade, recorded_at, notes } = req.body;
    if (!source) return redirectBack(req, res);
    db.prepare(`INSERT INTO supplier_monitoring (workspace_id, supplier_id, source, score, grade, recorded_at, notes, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, req.params.id, source,
      score ? parseFloat(score) : null, grade || null,
      recorded_at || new Date().toISOString().slice(0,10),
      notes || null, req.user.id);
    res.redirect(`/workspaces/${req.workspace.id}/vendors/${req.params.id}?tab=monitoring`);
  });

  app.post('/workspaces/:wsId/vendors/:id/termination/start', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const items = [
      ['access_revoked', 'Logical access revoked'],
      ['vpn_keys_revoked', 'VPN / API keys revoked'],
      ['data_returned', 'Data returned'],
      ['data_destroyed', 'Data securely destroyed'],
      ['certificate_received', 'Certificate of destruction received'],
      ['final_audit', 'Final audit / attestation collected'],
      ['contract_closed', 'Contract formally closed'],
      ['communications_done', 'Internal stakeholders notified']
    ];
    const ins = db.prepare(`INSERT OR IGNORE INTO supplier_termination_items (workspace_id, supplier_id, item_key, label) VALUES (?, ?, ?, ?)`);
    items.forEach(([k, l]) => ins.run(req.workspace.id, req.params.id, k, l));
    db.prepare(`UPDATE suppliers SET termination_started_at=CURRENT_TIMESTAMP, termination_owner=?, lifecycle_stage='terminating' WHERE id=? AND workspace_id=?`)
      .run(req.body.termination_owner || req.user.name, req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'start_termination', 'supplier', req.params.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/vendors/${req.params.id}?tab=termination`);
  });

  app.post('/workspaces/:wsId/vendors/:id/termination/:itemId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const done = req.body.done === '1' ? 1 : 0;
    db.prepare(`UPDATE supplier_termination_items SET done=?, done_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END, evidence=?, notes=? WHERE id=? AND supplier_id=? AND workspace_id=?`)
      .run(done, done, req.body.evidence || null, req.body.notes || null, req.params.itemId, req.params.id, req.workspace.id);
    // If all items done, mark terminated
    const remaining = db.prepare('SELECT COUNT(*) c FROM supplier_termination_items WHERE supplier_id=? AND workspace_id=? AND done=0').get(req.params.id, req.workspace.id).c;
    if (remaining === 0) {
      db.prepare(`UPDATE suppliers SET lifecycle_stage='terminated', terminated_at=CURRENT_TIMESTAMP, data_return_completed=1 WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
    }
    res.redirect(`/workspaces/${req.workspace.id}/vendors/${req.params.id}?tab=termination`);
  });

  // External tokenized questionnaire link - external supplier completes without an account.
  // Mints (or re-mints) a single-use token, sets a 30-day expiry, and - when a contact
  // email is supplied - emails the vendor the /q/<token> link. The token in the URL is the
  // credential; the vendor never sees the rest of the tool. Re-running this rotates the
  // token (older links stop working) so it doubles as "resend".
  app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/share', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const toEmail = (req.body.email || '').trim() || null;
    const token = crypto.randomBytes(20).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    db.prepare(`UPDATE supplier_questionnaires
        SET external_token=?, external_email=?, external_expires_at=?, external_completed_at=NULL,
            sent_at=CURRENT_TIMESTAMP, status=CASE WHEN status='draft' THEN 'sent' ELSE status END
        WHERE id=? AND workspace_id=?`)
      .run(token, toEmail, expiresAt, req.params.qId, req.workspace.id);
    const base = `/workspaces/${req.workspace.id}/vendors/${req.params.id}/questionnaires/${req.params.qId}`;
    const link = `${req.protocol}://${req.get('host')}/q/${token}`;

    if (toEmail) {
      const meta = db.prepare(`SELECT q.template_name, q.total_questions, s.name AS supplier_name, t.description AS tpl_description
          FROM supplier_questionnaires q
          INNER JOIN suppliers s ON s.id=q.supplier_id
          LEFT JOIN questionnaire_templates t ON t.id=q.template_id
          WHERE q.id=? AND q.workspace_id=?`).get(req.params.qId, req.workspace.id);
      email.sendSupplierQuestionnaireEmail({
        toEmail,
        supplierName: meta ? meta.supplier_name : 'your organisation',
        templateName: (meta && meta.template_name) || 'Security questionnaire',
        templateDescription: meta ? meta.tpl_description : null,
        questionCount: meta ? meta.total_questions : null,
        workspaceName: req.workspace.brand_display_name || req.workspace.client_name,
        workspaceId: req.workspace.id,
        firmId: req.workspace.firm_id,
        token,
        expiresAt,
        questionnaireId: parseInt(req.params.qId, 10)
      }).catch(err => console.error('[supplier-questionnaire email] send failed:', err && err.message));
      logAction(req.user.id, req.workspace.id, 'questionnaire_shared', 'questionnaire', req.params.qId, { to: toEmail, emailed: true }, auditCtx(req));
      return res.redirect(withToast(base, `Questionnaire emailed to ${toEmail}. The link expires in 30 days.`));
    }

    logAction(req.user.id, req.workspace.id, 'questionnaire_shared', 'questionnaire', req.params.qId, { to: null, emailed: false }, auditCtx(req));
    res.redirect(withToast(base, `External link ready (expires in 30 days): ${link}`));
  });

  app.get('/q/:token', (req, res) => {
    const q = db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description,
        COALESCE(w.brand_display_name, w.client_name) AS requester_name
      FROM supplier_questionnaires q
      INNER JOIN suppliers s ON s.id=q.supplier_id
      LEFT JOIN questionnaire_templates t ON t.id=q.template_id
      LEFT JOIN workspaces w ON w.id=q.workspace_id
      WHERE q.external_token=?`).get(req.params.token);
    const blank = { sections: {}, respMap: {}, token: req.params.token };
    if (!q) return res.status(404).render('external_questionnaire', { q: null, state: 'invalid', ...blank });
    if (q.external_completed_at) return res.render('external_questionnaire', { q, state: 'done', ...blank });
    if (q.external_expires_at && new Date(q.external_expires_at) < new Date())
      return res.status(410).render('external_questionnaire', { q, state: 'expired', ...blank });
    const questions = db.prepare('SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order').all(q.template_id);
    const responses = db.prepare('SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?').all(q.id);
    const respMap = Object.fromEntries(responses.map(r => [r.question_id, r]));
    const sections = {};
    questions.forEach(qu => { (sections[qu.section] = sections[qu.section] || []).push(qu); });
    res.render('external_questionnaire', { q, sections, respMap, token: req.params.token, state: 'open' });
  });

  app.post('/q/:token', resolveQuestionnaireFirm, qUploadAny, (req, res) => {
    const q = req._questionnaire; // guaranteed open by resolveQuestionnaireFirm

    // An upload error (oversize / too many files) aborts multer mid-parse, so the
    // body may be incomplete — don't risk a partial save. Show a clear retry
    // message with the answers still on screen; the link stays open.
    if (req._uploadError) {
      const e = req._uploadError;
      const tooBig = e && e.code === 'LIMIT_FILE_SIZE';
      const tooMany = e && e.code === 'LIMIT_FILE_COUNT';
      const uploadMsg = tooBig
        ? 'One of your files is larger than 25 MB. Please attach a smaller file (or split it) and submit again — your answers were not saved yet.'
        : tooMany
          ? 'Too many files were attached at once (limit 40). Please reduce the number of attachments and submit again — your answers were not saved yet.'
          : 'We could not process one of your attachments. Please remove it and submit again — your answers were not saved yet.';
      // Clean up any partial temp files multer did manage to write.
      (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(413).render('external_questionnaire', {
        q, sections: {}, respMap: {}, token: req.params.token, state: 'uploaderror', uploadMsg
      });
    }

    const qIds = Object.keys(req.body).filter(k => k.startsWith('answer_')).map(k => parseInt(k.replace('answer_',''), 10));
    const upsert = db.prepare(`INSERT INTO supplier_questionnaire_responses (questionnaire_id, question_id, answer, comment)
      VALUES (?, ?, ?, ?) ON CONFLICT(questionnaire_id, question_id) DO UPDATE SET answer=excluded.answer, comment=excluded.comment`);
    for (const qid of qIds) {
      upsert.run(q.id, qid, req.body['answer_' + qid] || null, req.body['comment_' + qid] || null);
    }
    // Score
    const allQ = db.prepare(`SELECT q.id, q.weight, q.expected_answer, r.answer FROM questionnaire_questions q
      LEFT JOIN supplier_questionnaire_responses r ON r.question_id=q.id AND r.questionnaire_id=?
      WHERE q.template_id=?`).all(q.id, q.template_id);
    let totalWeight = 0, achieved = 0;
    allQ.forEach(qu => {
      totalWeight += qu.weight;
      if (qu.answer && qu.expected_answer && qu.answer.toLowerCase() === qu.expected_answer.toLowerCase()) achieved += qu.weight;
    });
    const score = totalWeight ? Math.round((achieved / totalWeight) * 100) : null;
    const rating = score === null ? null : (score >= 80 ? 'low' : score >= 60 ? 'medium' : 'high');
    db.prepare(`UPDATE supplier_questionnaires SET answered_questions=?, score=?, risk_rating=?, status='responded', responded_at=CURRENT_TIMESTAMP, external_completed_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(allQ.filter(qu => qu.answer).length, score, rating, q.id);
    logAction(0, q.workspace_id, 'external_questionnaire_submit', 'questionnaire', q.id, { score, rating }, { ip: (req.ip || ''), userAgent: req.get('user-agent') || '' });

    // Persist any per-question evidence the vendor attached. Field names follow
    // the file_<questionId> convention; disallowed types were already dropped by
    // the multer fileFilter (names on req._rejectedUploads, surfaced below).
    let attachSaved = 0;
    try {
      attachSaved = persistQuestionnaireFiles({
        files: req.files, questionnaireId: q.id, workspaceId: q.workspace_id, source: 'vendor', uploadedBy: null
      });
    } catch (e) { console.error('[questionnaire attach]', e && e.message); }

    // Close the loop: notify the engagement lead that the vendor responded. The
    // notify->email bridge emails them automatically (subject to their pref). The
    // title carries the supplier + template so distinct questionnaires don't dedup
    // into one another, but stays day-count-free so genuine re-fires are rare.
    const supName = q.supplier_name || 'A supplier';
    try {
      const ratingLabel = rating ? rating.charAt(0).toUpperCase() + rating.slice(1) : 'n/a';
      const attachNote = attachSaved ? ` ${attachSaved} file${attachSaved === 1 ? '' : 's'} attached.` : '';
      jobs.notify(q.workspace_id, null, 'questionnaire_responded', score !== null && score < 60 ? 'high' : 'medium',
        `${supName} returned their questionnaire: ${q.template_name}`,
        `Score ${score === null ? 'n/a' : score + '%'} · risk ${ratingLabel}.${attachNote} Review and confirm the rating.`,
        `/workspaces/${q.workspace_id}/vendors/${q.supplier_id}/questionnaires/${q.id}`);
    } catch (e) { console.error('[questionnaire notify]', e && e.message); }

    res.render('external_questionnaire', {
      q, sections: {}, respMap: {}, token: req.params.token, state: 'submitted',
      rejectedUploads: req._rejectedUploads || [], attachSaved
    });
  });

  // ==================== TASKS: TEMPLATES + TIME TRACKING ====================
  app.get('/workspaces/:wsId/task-templates', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    const templates = db.prepare(`SELECT * FROM task_templates WHERE workspace_id=? OR is_system=1 OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
    res.render('task_templates', { user: req.user, ws: req.workspace, templates });
  });

  app.post('/workspaces/:wsId/tasks/from-template/:tplId', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    const tpl = db.prepare('SELECT * FROM task_templates WHERE id=? AND (is_system=1 OR firm_id=? OR workspace_id=?)').get(req.params.tplId, req.workspace.firm_id, req.workspace.id);
    if (!tpl) return redirectBack(req, res);
    const steps = JSON.parse(tpl.steps || '[]');
    const baseDate = req.body.base_date ? new Date(req.body.base_date) : new Date();
    for (const s of steps) {
      const due = new Date(baseDate.getTime() + (s.days_offset || 0) * 86400000).toISOString().slice(0,10);
      db.prepare(`INSERT INTO tasks (workspace_id, entity_id, title, description, assignee_id, due_date, status, created_by, template_id)
        VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?)`).run(
        req.workspace.id, req.entityScopeId || null,
        s.title, tpl.name + ' - step',
        req.body.assignee_id || null, due, req.user.id, tpl.id);
    }
    logAction(req.user.id, req.workspace.id, 'spawn_template', 'task_template', tpl.id, { name: tpl.name, steps: steps.length }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/tasks`, `Created ${steps.length} tasks from "${tpl.name}"`));
  });

  // ==================== ASSET RELATIONSHIPS + BULK IMPORT ====================
  app.post('/workspaces/:wsId/assets/:id/relationships', requireAuth, requireWorkspace, requirePermission('asset.update'), (req, res) => {
    const asset = db.prepare('SELECT id FROM assets WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!asset) return res.status(404).send('Asset not found');
    const { child_asset_id, relation, notes } = req.body;
    if (!child_asset_id || !relation) return redirectBack(req, res);
    try {
      db.prepare(`INSERT INTO asset_relationships (workspace_id, parent_asset_id, child_asset_id, relation, notes)
        VALUES (?, ?, ?, ?, ?)`).run(req.workspace.id, req.params.id, child_asset_id, relation, notes || null);
    } catch (_) {}
    res.redirect(`/workspaces/${req.workspace.id}/assets/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/assets/relationships/:id/delete', requireAuth, requireWorkspace, requirePermission('asset.update'), (req, res) => {
    db.prepare('DELETE FROM asset_relationships WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
    redirectBack(req, res);
  });

  app.get('/workspaces/:wsId/assets/:id', requireAuth, requireWorkspace, requirePermission('asset.view'), (req, res) => {
    const asset = db.prepare(`SELECT a.*, e.name AS entity_name FROM assets a LEFT JOIN entities e ON e.id=a.entity_id WHERE a.id=? AND a.workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!asset) return res.status(404).send('Not found');
    const parents = db.prepare(`SELECT r.*, p.name AS asset_name FROM asset_relationships r INNER JOIN assets p ON p.id=r.parent_asset_id WHERE r.child_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
    const children = db.prepare(`SELECT r.*, c.name AS asset_name FROM asset_relationships r INNER JOIN assets c ON c.id=r.child_asset_id WHERE r.parent_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
    const allAssets = db.prepare('SELECT id, name FROM assets WHERE workspace_id=? AND id != ? ORDER BY name').all(req.workspace.id, asset.id);
    const linkedRisks = db.prepare(`SELECT r.* FROM risks r WHERE r.workspace_id=? AND r.asset_id=?`).all(req.workspace.id, asset.id);
    // Phase B: controls in scope for this asset = controls linked from any of this asset's risks
    const controlsInScope = db.prepare(`
      SELECT DISTINCT i.id, i.title, i.category,
        COALESCE(cs.applicability,'undecided') AS applicability,
        COALESCE(cs.status,'Not Assessed') AS status,
        (SELECT COUNT(*) FROM ${docLinks.docControlsExpr('iso27001')} dc INNER JOIN generated_docs d ON d.id=dc.document_id WHERE dc.iso_item_id=i.id AND d.workspace_id=?) AS doc_count
      FROM iso_items i
      INNER JOIN risk_controls rc ON rc.iso_item_id = i.id
      INNER JOIN risks r ON r.id = rc.risk_id
      LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE r.asset_id = ? AND r.workspace_id = ?
      ORDER BY i.sort_order
    `).all(req.workspace.id, req.workspace.id, asset.id, req.workspace.id);
    res.render('asset_detail', { user: req.user, ws: req.workspace, asset, parents, children, allAssets, linkedRisks, controlsInScope });
  });

  // Legacy textarea-paste CSV importer superseded by the GET/POST pipeline at
  // /assets/import (preview + per-row validation + transactional commit).
  // Surviving as a redirect for any bookmarked links.

  // ==================== MEMBERS: BULK INVITE + STATS ====================
  app.post('/workspaces/:wsId/members/bulk', requireAuth, requireWorkspace, requirePermission('members.add'), (req, res) => {
    const lines = (req.body.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let added = 0;
    for (const ln of lines) {
      const parts = ln.split(',').map(s => s.trim());
      const [name, email, role] = parts;
      if (!name || !email) continue;
      const e = email.toLowerCase();
      const r = ['client_owner','contributor','reviewer','auditor','read_only'].includes(role) ? role : 'contributor';
      let user = db.prepare('SELECT * FROM users WHERE email=?').get(e);
      if (!user) {
        const hash = bcrypt.hashSync('temporary-' + crypto.randomBytes(8).toString('hex'), 10);
        const uid = db.prepare(`INSERT INTO users (email, password_hash, name, user_type) VALUES (?, ?, ?, 'client')`).run(e, hash, name).lastInsertRowid;
        user = { id: uid };
      }
      try {
        db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(req.workspace.id, user.id, r);
        added++;
      } catch (_) { /* already a member */ }
    }
    logAction(req.user.id, req.workspace.id, 'bulk_invite', 'members', null, { added }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/members`, `Added ${added} members`));
  });

  app.get('/workspaces/:wsId/members/:userId/stats', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
    const u = db.prepare('SELECT id, name, email, last_active_at FROM users WHERE id=?').get(req.params.userId);
    if (!u) return res.status(404).send('Not found');
    const stats = {
      controls_owned: db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, req.workspace.id).cs} WHERE workspace_id=? AND owner_id=?`).get(req.workspace.id, u.id).c,
      docs_created: db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND created_by=?`).get(req.workspace.id, u.id).c,
      evidence_uploaded: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND uploaded_by=?`).get(req.workspace.id, u.id).c,
      tasks_owned: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND assignee_id=?`).get(req.workspace.id, u.id).c,
      actions_logged: db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id).c,
      signatures: db.prepare(`SELECT COUNT(*) c FROM doc_signatures WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id).c
    };
    res.render('member_stats', { user: req.user, ws: req.workspace, member: u, stats });
  });

  // ==================== ACCESS REVIEWS ====================
  app.get('/workspaces/:wsId/access-reviews', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
    const reviews = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM access_review_items WHERE review_id=r.id) AS total,
      (SELECT COUNT(*) FROM access_review_items WHERE review_id=r.id AND decision IS NOT NULL) AS decided
      FROM access_reviews r WHERE r.workspace_id=? ORDER BY r.created_at DESC`).all(req.workspace.id);
    res.render('access_reviews', { user: req.user, ws: req.workspace, reviews });
  });

  app.post('/workspaces/:wsId/access-reviews', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
    const today = new Date().toISOString().slice(0,10);
    const start = req.body.period_start || new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
    const reviewId = db.prepare(`INSERT INTO access_reviews (workspace_id, period_start, period_end, status, reviewer)
      VALUES (?, ?, ?, 'open', ?)`).run(req.workspace.id, start, today, req.body.reviewer || req.user.name).lastInsertRowid;
    // Snapshot current member list
    const members = db.prepare(`SELECT m.user_id, m.role, u.name FROM workspace_members m INNER JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?`).all(req.workspace.id);
    const ins = db.prepare('INSERT INTO access_review_items (review_id, user_id, current_role) VALUES (?, ?, ?)');
    members.forEach(m => ins.run(reviewId, m.user_id, m.role));
    logAction(req.user.id, req.workspace.id, 'open_access_review', 'access_review', reviewId, { members: members.length }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${reviewId}`);
  });

  app.get('/workspaces/:wsId/access-reviews/:id', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
    const review = db.prepare('SELECT * FROM access_reviews WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!review) return res.status(404).send('Not found');
    const items = db.prepare(`SELECT i.*, u.name, u.email FROM access_review_items i INNER JOIN users u ON u.id=i.user_id WHERE i.review_id=? ORDER BY u.name`).all(review.id);
    res.render('access_review_detail', { user: req.user, ws: req.workspace, review, items });
  });

  app.post('/workspaces/:wsId/access-reviews/:id/items/:itemId', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
    db.prepare(`UPDATE access_review_items SET decision=?, decision_reason=?, reviewer=?, decided_at=CURRENT_TIMESTAMP WHERE id=? AND review_id=?`)
      .run(req.body.decision || null, req.body.decision_reason || null, req.user.name, req.params.itemId, req.params.id);
    // If decision is "remove", actually drop the workspace_member row
    if (req.body.decision === 'remove') {
      const item = db.prepare('SELECT user_id FROM access_review_items WHERE id=?').get(req.params.itemId);
      if (item) {
        db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(req.workspace.id, item.user_id);
        logAction(req.user.id, req.workspace.id, 'access_review_remove', 'user', item.user_id, null, auditCtx(req));
      }
    }
    res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/access-reviews/:id/close', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
    db.prepare(`UPDATE access_reviews SET status='closed', closed_at=CURRENT_TIMESTAMP, outcome=? WHERE id=? AND workspace_id=?`)
      .run(req.body.outcome || null, req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'close_access_review', 'access_review', req.params.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${req.params.id}`);
  });

  // ==================== PERMISSION REVERSE LOOKUP + TEMPLATES ====================
  app.get('/workspaces/:wsId/access/who-has/:perm', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
    const perm = req.params.perm;
    // For each user with workspace access, compute effective perms.
    const users = db.prepare(`SELECT u.id, u.name, u.email, u.user_type, u.firm_role, COALESCE(m.role, '-') AS member_role
      FROM users u LEFT JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=?
      WHERE u.firm_id=? AND u.user_type='firm' AND u.active=1
      UNION
      SELECT u.id, u.name, u.email, u.user_type, NULL, m.role
      FROM users u INNER JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=?`).all(req.workspace.id, req.workspace.firm_id, req.workspace.id);
    const has = users.map(u => ({ ...u, has: rbac.hasPermission(permissionsFor(u, req.workspace), perm) }));
    res.render('permission_lookup', { user: req.user, ws: req.workspace, perm, results: has, allPerms: rbac.PERMISSIONS });
  });

  app.post('/workspaces/:wsId/access/apply-template', requireAuth, requireWorkspace, requirePermission('members.override_perms'), (req, res) => {
    const tpl = db.prepare('SELECT * FROM permission_templates WHERE id=? AND (firm_id IS NULL OR firm_id=?)').get(req.body.template_id, req.workspace.firm_id);
    if (!tpl) return redirectBack(req, res);
    const userId = parseInt(req.body.user_id, 10);
    if (!userId) return redirectBack(req, res);
    const expires = req.body.expires_at || null;
    const perms = JSON.parse(tpl.permissions);
    const ins = db.prepare(`INSERT INTO workspace_role_overrides (workspace_id, user_id, permission, granted, granted_by, reason, expires_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id, permission) DO UPDATE SET granted=1, granted_by=excluded.granted_by, reason=excluded.reason, expires_at=excluded.expires_at`);
    perms.forEach(p => ins.run(req.workspace.id, userId, p, req.user.id, `Template: ${tpl.name}` + (req.body.reason ? ' - ' + req.body.reason : ''), expires));
    logAction(req.user.id, req.workspace.id, 'apply_perm_template', 'user', userId, { template: tpl.name, expires_at: expires }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/access`);
  });

  // ==================== AUDIT LOG: HASH CHAIN VERIFY + SESSION TIMELINE + ANOMALY ====================
  app.get('/workspaces/:wsId/activity-log/verify', requireAuth, requireWorkspace, requirePermission('audit_log.view'), (req, res) => {
    const issues = verifyAuditChain(req.workspace.id);
    res.render('audit_chain_verify', { user: req.user, ws: req.workspace, issues, total: db.prepare('SELECT COUNT(*) c FROM audit_log WHERE workspace_id=?').get(req.workspace.id).c });
  });

  app.get('/workspaces/:wsId/activity-log/timeline', requireAuth, requireWorkspace, requirePermission('audit_log.view'), (req, res) => {
    const userId = parseInt(req.query.user_id || req.user.id, 10);
    const day = req.query.day || new Date().toISOString().slice(0,10);
    const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND a.user_id=? AND date(a.created_at)=date(?) ORDER BY a.created_at`)
      .all(req.workspace.id, userId, day);
    const users = db.prepare(`SELECT DISTINCT u.id, u.name FROM audit_log a INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
    res.render('audit_timeline', { user: req.user, ws: req.workspace, log, users, userId, day });
  });

  app.get('/workspaces/:wsId/activity-log/anomalies', requireAuth, requireWorkspace, requirePermission('audit_log.view'), (req, res) => {
    const flags = [];
    // After-hours actions (00:00–06:00 UTC)
    const after = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND CAST(strftime('%H', a.created_at) AS INTEGER) < 6 ORDER BY a.created_at DESC LIMIT 50`).all(req.workspace.id);
    if (after.length) flags.push({ kind: 'after_hours', label: `${after.length} after-hours actions (00:00–06:00 UTC)`, items: after });
    // Burst: same user does >20 actions in one minute
    const burst = db.prepare(`SELECT user_id, strftime('%Y-%m-%d %H:%M', created_at) AS m, COUNT(*) c
      FROM audit_log WHERE workspace_id=? GROUP BY user_id, m HAVING c > 20 ORDER BY c DESC LIMIT 10`).all(req.workspace.id);
    if (burst.length) flags.push({ kind: 'burst', label: `Bursts of >20 actions per minute`, items: burst });
    // IP changes mid-session: same user, >2 distinct IPs in one day
    const ipChange = db.prepare(`SELECT user_id, date(created_at) d, COUNT(DISTINCT ip_address) ips
      FROM audit_log WHERE workspace_id=? AND ip_address IS NOT NULL GROUP BY user_id, d HAVING ips > 2`).all(req.workspace.id);
    if (ipChange.length) flags.push({ kind: 'ip_change', label: `Same user from >2 IPs in a single day`, items: ipChange });
    // Permission denials: every denial is suspicious
    const denials = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND a.action='permission_denied' ORDER BY a.created_at DESC LIMIT 50`).all(req.workspace.id);
    if (denials.length) flags.push({ kind: 'denials', label: `${denials.length} permission denials`, items: denials });
    res.render('audit_anomalies', { user: req.user, ws: req.workspace, flags });
  });

  // ==================== OVERVIEW WIDGETS API ====================
  app.get('/api/workspaces/:wsId/burndown', requireAuth, requireWorkspace, (req, res) => {
    // Open NCs over time (90 days), and unimplemented controls trend
    const wsId = req.workspace.id;
    const days = 90;
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = d.toISOString().slice(0,10);
      const openNcs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND created_at <= ? AND (closed_at IS NULL OR closed_at > ?)`).get(wsId, k + ' 23:59:59', k + ' 23:59:59').c;
      series.push({ d: k, open_ncs: openNcs });
    }
    res.json({ series });
  });

  // ==================== READINESS DRILL-DOWN ====================
  app.get('/workspaces/:wsId/readiness/auditor', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    // Auditor checklist view: per-clause / per-Annex A, what evidence exists, what's missing
    const items = db.prepare(`SELECT i.id, i.title, i.type, i.category, i.evidence_needed, i.documentation_needed,
      cs.status, cs.applicability, cs.last_updated, cs.notes,
      (SELECT COUNT(*) FROM evidence e WHERE e.workspace_id=? AND e.iso_item_id=i.id) AS evidence_count,
      (SELECT COUNT(*) FROM risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?) AS risk_links
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id, req.workspace.id);
    res.render('readiness_auditor', { user: req.user, ws: req.workspace, items });
  });

  // ==================== CONTROLS: BULK EXPORT/IMPORT + TEMPLATES + KANBAN ====================
  app.get('/workspaces/:wsId/controls/export.csv', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const rows = db.prepare(`SELECT i.id, i.type, i.category, i.title,
      COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.maturity, cs.notes, cs.due_date,
      (SELECT name FROM users WHERE id=cs.owner_id) AS owner
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      ORDER BY i.sort_order`).all(req.workspace.id);
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
    const lines = ['id,type,category,title,status,applicability,maturity,notes,due_date,owner'];
    rows.forEach(r => lines.push([r.id, r.type, r.category, r.title, r.status, r.applicability, r.maturity || '', r.notes || '', r.due_date || '', r.owner || ''].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="controls-${req.workspace.client_name.replace(/[^\w]+/g,'_')}.csv"`);
    res.send(lines.join('\n'));
  });

  app.post('/workspaces/:wsId/controls/import', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
    const csv = req.body.csv || '';
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return redirectBack(req, res);
    const header = lines.shift().split(',').map(s => s.trim().toLowerCase());
    const ix = (k) => header.indexOf(k);
    // Cutover 4 (W5): converged-authoritative CSV import; convergeSets normalizes
    // status/applicability per row (014 mirrors each). Unmapped CSV values pass
    // through and surface fail-loud in reads, matching the doctrine.
    const wcImp = ctlWrites.converged(db, req.workspace.id);
    let updated = 0;
    for (const ln of lines) {
      // Naive CSV - values may be quoted; handle simple unquote
      const parts = ln.match(/"[^"]*"|[^,]+/g)?.map(p => p.replace(/^"|"$/g,'').replace(/""/g,'"').trim()) || [];
      const id = ix('id') >= 0 ? parts[ix('id')] : null;
      if (!id) continue;
      getOrCreateState(req.workspace.id, id);
      const set = []; const vals = [];
      if (ix('status') >= 0 && parts[ix('status')]) { set.push('status=?'); vals.push(parts[ix('status')]); }
      if (ix('applicability') >= 0 && parts[ix('applicability')]) { set.push('applicability=?'); vals.push(parts[ix('applicability')]); }
      if (ix('maturity') >= 0 && parts[ix('maturity')]) { set.push('maturity=?'); vals.push(parseInt(parts[ix('maturity')]) || 0); }
      if (ix('notes') >= 0 && parts[ix('notes')]) { set.push('notes=?'); vals.push(parts[ix('notes')]); }
      if (set.length) {
        set.push('last_updated=CURRENT_TIMESTAMP');
        const rid = wcImp ? ctlWrites.requirementId(db, 'iso27001', id) : null;
        if (wcImp && rid) {
          const c = ctlWrites.convergeSets(set, vals);
          db.prepare(`UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(...c.vals, req.workspace.id, rid);
        } else {
          vals.push(req.workspace.id, id);
          db.prepare(`UPDATE control_states SET ${set.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
        }
        updated++;
      }
    }
    logAction(req.user.id, req.workspace.id, 'import_controls', 'control', null, { updated }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/controls`, `Updated ${updated} controls`));
  });

  app.get('/workspaces/:wsId/controls/kanban', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const rows = db.prepare(`SELECT i.id, i.title, i.type, i.category,
      COALESCE(cs.status,'Not Assessed') AS status, cs.maturity,
      (SELECT name FROM users WHERE id=cs.owner_id) AS owner
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' ORDER BY i.sort_order`).all(req.workspace.id);
    res.render('controls_kanban', { user: req.user, ws: req.workspace, rows });
  });

  // ==================== RISK APPETITE + ACCEPTANCE E-SIGN ====================
  app.get('/workspaces/:wsId/risk-appetite', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    let app_ = db.prepare('SELECT * FROM risk_appetites WHERE workspace_id=?').get(req.workspace.id);
    if (!app_) {
      db.prepare(`INSERT INTO risk_appetites (workspace_id, statement, appetite_low_max, appetite_med_max) VALUES (?, ?, ?, ?)`)
        .run(req.workspace.id, '', 6, 12);
      app_ = db.prepare('SELECT * FROM risk_appetites WHERE workspace_id=?').get(req.workspace.id);
    }
    res.render('risk_appetite', { user: req.user, ws: req.workspace, appetite: app_ });
  });

  app.post('/workspaces/:wsId/risk-appetite', requireAuth, requireWorkspace, requirePermission('risk.methodology'), (req, res) => {
    const { statement, appetite_low_max, appetite_med_max, auto_accept_below, approver_role } = req.body;
    db.prepare(`UPDATE risk_appetites SET statement=?, appetite_low_max=?, appetite_med_max=?, auto_accept_below=?, approver_role=?, updated_at=CURRENT_TIMESTAMP WHERE workspace_id=?`)
      .run(statement || '', parseFloat(appetite_low_max)||0, parseFloat(appetite_med_max)||0, auto_accept_below === 'on' ? 1 : 0, approver_role || null, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'update_appetite', 'appetite', null, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risk-appetite`);
  });

  app.post('/workspaces/:wsId/risks/:id/accept', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
    const risk = db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return redirectBack(req, res);
    const { accepter_name, accepter_role, rationale, expires_at, attestation } = req.body;
    if (attestation !== '1' || !accepter_name || !rationale) {
      return res.status(400).render('error', { user: req.user, message: 'Acceptance requires accepter name, rationale, and attestation tickbox.' });
    }
    const residual = (risk.residual_likelihood || risk.likelihood) * (risk.residual_impact || risk.impact);
    const ts = new Date().toISOString();
    const payload = `accept|${risk.id}|${accepter_name}|${residual}|${ts}`;
    const sig = enc.signHmac(payload, req.workspace.id);
    const id = db.prepare(`INSERT INTO risk_acceptances (workspace_id, risk_id, accepter_name, accepter_role, accepter_user_id, rationale, residual_score, expires_at, signature, ip_address, user_agent, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, risk.id, accepter_name, accepter_role || null, req.user.id,
      rationale, residual, expires_at || null, sig,
      auditCtx(req).ip, auditCtx(req).userAgent, ts).lastInsertRowid;
    db.prepare(`UPDATE risks SET status='accepted', accepted_until=?, last_acceptance_id=? WHERE id=? AND workspace_id=?`)
      .run(expires_at || null, id, risk.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'accept_risk', 'risk', risk.id, { acceptance_id: id, expires_at }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/${risk.id}`, 'Risk acceptance recorded'));
  });

  app.get('/workspaces/:wsId/risks/:id/acceptances', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    const risk = db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Not found');
    const list = db.prepare(`SELECT * FROM risk_acceptances WHERE risk_id=? ORDER BY signed_at DESC`).all(risk.id);
    res.render('risk_acceptances', { user: req.user, ws: req.workspace, risk, list });
  });

  // Formal acceptance record - downloadable DOCX with the risk, residual,
  // rationale, expiry, and a signature block. The auditor wants this as a
  // hand-off artefact, not just a database row.
  app.get('/workspaces/:wsId/risks/:id/acceptances/:aid/record.docx', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
    const risk = db.prepare(`SELECT * FROM risks WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    const a = db.prepare(`SELECT * FROM risk_acceptances WHERE id=? AND workspace_id=? AND risk_id=?`).get(req.params.aid, req.workspace.id, risk.id);
    if (!a) return res.status(404).send('Acceptance record not found');

    const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })], ...opts });
    const heading = (text, level) => new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })], spacing: { before: 300, after: 120 } });
    const row = (label, value) => new TableRow({ children: [
      new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, shading: { fill: 'F4F4F5' },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })] }),
      new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: value || '-' })] })] })
    ]});

    const score = (risk.likelihood || 0) * (risk.impact || 0);
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Risk acceptance record' })], alignment: AlignmentType.CENTER }),
          para(`${req.workspace.client_name || 'Workspace'} - generated ${new Date().toISOString().slice(0,10)}`, { italics: true }),
          para(''),

          heading('Risk', HeadingLevel.HEADING_2),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
            row('Risk ID', `R-${risk.id}`),
            row('Title', risk.title),
            row('Description', risk.description || '-'),
            row('Likelihood × Impact', `${risk.likelihood} × ${risk.impact} = ${score}`),
            row('Treatment option chosen', 'Accept (residual risk)'),
            row('Risk owner', risk.owner_name || '-'),
          ]}),

          heading('Residual position', HeadingLevel.HEADING_2),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
            row('Residual L × I', risk.residual_likelihood && risk.residual_impact
              ? `${risk.residual_likelihood} × ${risk.residual_impact} = ${risk.residual_likelihood * risk.residual_impact}`
              : (a.residual_score != null ? String(a.residual_score) : '-')),
            row('Inherent L × I', `${risk.likelihood} × ${risk.impact} = ${score}`),
          ]}),

          heading('Acceptance rationale', HeadingLevel.HEADING_2),
          para(a.rationale || '-'),

          heading('Attestation', HeadingLevel.HEADING_2),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
            row('Accepter (full name)', a.accepter_name),
            row('Role', a.accepter_role || '-'),
            row('Signed at', a.signed_at),
            row('IP address', a.ip_address || '-'),
            row('User agent', a.user_agent || '-'),
            row('Signature hash', a.signature ? a.signature.slice(0, 32) + '…' : '-'),
            row('Expires / re-review by', a.expires_at || 'No fixed expiry - reviewed at each management review'),
            row('Status', a.revoked_at ? `REVOKED at ${a.revoked_at}` : 'Active'),
          ]}),
          para(''),

          new Paragraph({ children: [new TextRun({
            text: 'I attest under my own authority that this residual risk has been considered and is hereby formally accepted. ' +
                  'This electronic signature is bound to my identity, the recorded IP, and the timestamp above. ' +
                  'The signature hash is anchored in the workspace audit log and tamper-evident.',
            italics: true
          })] }),
          para(''),
          para('Risk owner sign-off (clause 6.1.3.f): _________________________  Date: __________', { size: 22 }),
        ]
      }]
    });

    const buf = await Packer.toBuffer(doc);
    const safeTitle = (risk.title || `risk-${risk.id}`).replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 60);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="risk-acceptance-R${risk.id}-${safeTitle}.docx"`);
    res.send(buf);
  });

  app.post('/workspaces/:wsId/risks/:id/acceptances/:aid/revoke', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
    const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!risk) return res.status(404).send('Risk not found');
    db.prepare(`UPDATE risk_acceptances SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND risk_id=?`).run(req.params.aid, risk.id);
    // Reset risk to open if no other active acceptance
    const remaining = db.prepare(`SELECT COUNT(*) c FROM risk_acceptances WHERE risk_id=? AND revoked_at IS NULL`).get(risk.id).c;
    if (remaining === 0) db.prepare(`UPDATE risks SET status='open', accepted_until=NULL WHERE id=? AND workspace_id=?`).run(risk.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'revoke_acceptance', 'risk', req.params.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/acceptances`);
  });

  // ==================== COMPLIANCE CALENDAR ====================
  // (Old list-style calendar removed - replaced by Tier B.8 month-view above.)

  // ==================== FTS5 SEARCH UI ====================
  app.get('/workspaces/:wsId/search', requireAuth, requireWorkspace, (req, res) => {
    const q = (req.query.q || '').trim();
    const results = q ? fts.search(req.workspace.id, q) : [];
    res.render('search', { user: req.user, ws: req.workspace, q, results });
  });

  app.post('/workspaces/:wsId/search/rebuild', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    const n = fts.rebuildAll(req.workspace.id);
    res.redirect(withToast(`/workspaces/${req.workspace.id}/search`, `Rebuilt ${n} entries`));
  });

  // ==================== CLIENT HANDOVER EXPORT ====================
  app.get('/workspaces/:wsId/handover', requireAuth, requireWorkspace, requirePermission('workspace.export'), async (req, res) => {
    const ws = req.workspace;
    const safeName = ws.client_name.replace(/[^\w]+/g, '_');
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="handover-${safeName}-${today}.zip"`);
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', err => { console.error(err); res.status(500).end(); });
    zip.pipe(res);

    // Dump every workspace-scoped table as JSON
    const tables = [
      'workspaces','entities','assets','risks','risk_treatments','risk_acceptances','risk_methodologies','risk_appetites',
      // control state converged to control_instances (control_states/entity_control_states
      // demolished, 019/020); history is the pass-snapshot tables (cutover 5 decision).
      'control_instances','control_state_history','iso42001_control_state_history','soa_snapshots',
      'generated_docs','doc_versions','doc_approvers','doc_signatures',
      'evidence','comments','comment_mentions',
      'audits','audit_findings','audit_observations','audit_programmes',
      'mrms','nonconformities','incidents','incident_events',
      'suppliers','supplier_documents','supplier_subprocessors','supplier_reviews','supplier_notes','supplier_clauses','supplier_controls','supplier_questionnaires','supplier_questionnaire_responses','supplier_monitoring','supplier_termination_items',
      'document_requirement_links',
      'tasks','task_templates',
      'asset_relationships',
      'workspace_members','workspace_role_overrides','access_reviews','access_review_items',
      'audit_log','audit_chain','notifications'
    ];
    for (const t of tables) {
      try {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
        const wsCol = cols.includes('workspace_id') ? 'workspace_id' : null;
        const rows = wsCol
          ? db.prepare(`SELECT * FROM ${t} WHERE ${wsCol}=?`).all(ws.id)
          : db.prepare(`SELECT * FROM ${t} WHERE id=?`).all(ws.id);
        // Decrypt encrypted fields for portability
        rows.forEach(r => {
          Object.keys(r).forEach(k => {
            if (typeof r[k] === 'string' && r[k].startsWith('enc:v1:')) {
              try { r[k] = enc.decryptIfNeeded(r[k], ws.id); } catch (_) {}
            }
          });
        });
        zip.append(JSON.stringify(rows, null, 2), { name: `data/${t}.json` });
      } catch (e) { /* table may not exist on older DB */ }
    }

    // All evidence files
    const evidence = db.prepare(`SELECT * FROM evidence WHERE workspace_id=?`).all(ws.id);
    for (const e of evidence) {
      const fp = resolveUploadPath(e.stored_path, ws.firm_id);
      if (fp && fs.existsSync(fp)) zip.file(fp, { name: `evidence/${e.id}_${e.filename}` });
    }
    // All supplier files
    const supDocs = db.prepare(`SELECT d.* FROM supplier_documents d INNER JOIN suppliers s ON s.id=d.supplier_id WHERE s.workspace_id=?`).all(ws.id);
    for (const d of supDocs) {
      if (d.stored_path) {
        const fp = resolveUploadPath(d.stored_path, ws.firm_id);
        if (fp && fs.existsSync(fp)) zip.file(fp, { name: `supplier-files/${d.id}_${d.filename}` });
      }
    }

    // README + import instructions
    const readme = `ISMS handover package - ${ws.client_name}
  ==========================================================

  Generated: ${new Date().toISOString()}
  Workspace ID: ${ws.id}
  Client: ${ws.client_name}

  Contents:
    data/*.json     - every database row scoped to this workspace, decrypted for portability
    evidence/       - every evidence file uploaded against any control
    supplier-files/ - every supplier attestation / contract

  To import this elsewhere:
    1. Stand up an ISMS instance (any version >= today's).
    2. Restore the JSON files into the corresponding tables - preserving primary keys
       where possible. \`workspaces\` first, then everything keyed off workspace_id.
    3. Place evidence/* and supplier-files/* into the new instance's uploads/ directory
       using the same filenames.
    4. Re-encrypt sensitive fields under the new instance's master key (or run the
       /workspaces/:id/handover/import migration helper if available).
    5. Verify the audit-log hash chain at /workspaces/<id>/activity-log/verify.
  `;
    zip.append(readme, { name: 'README.txt' });
    await zip.finalize();
    logAction(req.user.id, ws.id, 'handover_export', 'workspace', ws.id, null, auditCtx(req));
  });

  // ==================== BULK OPS ====================
  app.post('/workspaces/:wsId/bulk/:type', requireAuth, requireWorkspace, (req, res) => {
    const allowed = { risks: { perm: 'risk.delete' }, assets: { perm: 'asset.delete' }, tasks: { perm: 'task.manage' }, suppliers: { perm: 'supplier.manage' }, ncs: { perm: 'nc.manage' }, incidents: { perm: 'incident.manage' } };
    const cfg = allowed[req.params.type];
    if (!cfg) return res.status(400).send('unknown type');
    if (!rbac.hasPermission(permissionsFor(req.user, req.workspace), cfg.perm)) return res.status(403).render('error', { user: req.user, message: 'forbidden' });
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : [])).map(Number).filter(Boolean);
    if (!ids.length) return redirectBack(req, res);
    const op = req.body.op;
    const tableMap = { risks: 'risks', assets: 'assets', tasks: 'tasks', suppliers: 'suppliers', ncs: 'nonconformities', incidents: 'incidents' };
    const table = tableMap[req.params.type];
    if (op === 'delete') {
      const stmt = db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace_id=?`);
      const tx = db.transaction(() => { for (const id of ids) stmt.run(id, req.workspace.id); });
      tx();
    } else if (op === 'reassign' && req.body.assignee) {
      const cols = { risks: 'owner_name', assets: 'owner_name', tasks: 'assignee_id', suppliers: 'approved_by', ncs: 'responsible', incidents: 'reported_by' };
      const col = cols[req.params.type];
      const stmt = db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=? AND workspace_id=?`);
      const tx = db.transaction(() => { for (const id of ids) stmt.run(req.body.assignee, id, req.workspace.id); });
      tx();
    } else if (op === 'archive' && (req.params.type === 'tasks' || req.params.type === 'incidents' || req.params.type === 'ncs')) {
      const stmt = db.prepare(`UPDATE ${table} SET status='closed' WHERE id=? AND workspace_id=?`);
      const tx = db.transaction(() => { for (const id of ids) stmt.run(id, req.workspace.id); });
      tx();
    }
    logAction(req.user.id, req.workspace.id, 'bulk_' + op, req.params.type, null, { count: ids.length }, auditCtx(req));
    redirectBack(req, res);
  });

  // ==================== REPORT BUILDER ====================
  app.get('/workspaces/:wsId/reports', requireAuth, requireWorkspace, requirePermission('workspace.export'), (req, res) => {
    const list = db.prepare(`SELECT id, name, description, is_system FROM report_templates WHERE workspace_id IS NULL OR workspace_id=? OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
    res.render('reports', { user: req.user, ws: req.workspace, list });
  });

  app.get('/workspaces/:wsId/reports/:id', requireAuth, requireWorkspace, requirePermission('workspace.export'), (req, res) => {
    const tpl = db.prepare(`SELECT * FROM report_templates WHERE id=?`).get(req.params.id);
    if (!tpl) return res.status(404).send('Not found');
    const ctx = reports.buildContext(req.workspace.id);
    const body = reports.render(tpl.body, ctx);
    res.render('report_view', { user: req.user, ws: req.workspace, tpl, body });
  });

  app.get('/workspaces/:wsId/reports/:id/docx', requireAuth, requireWorkspace, requirePermission('workspace.export'), async (req, res) => {
    const tpl = db.prepare(`SELECT * FROM report_templates WHERE id=?`).get(req.params.id);
    if (!tpl) return res.status(404).send('Not found');
    const ctx = reports.buildContext(req.workspace.id);
    const body = reports.render(tpl.body, ctx);
    const fakeDoc = { name: tpl.name, version: 1, status: 'report', content: body };
    try {
      const buf = await generateDocxBuffer(fakeDoc, req.workspace);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${tpl.name.replace(/[^\w\- ]+/g,'_')}.docx"`);
      res.send(buf);
    } catch (e) { res.status(500).send('docx error: ' + e.message); }
  });

  app.post('/workspaces/:wsId/reports', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
    const { name, description, body } = req.body;
    if (!name || !body) return redirectBack(req, res);
    const id = db.prepare(`INSERT INTO report_templates (workspace_id, firm_id, name, description, body, is_system) VALUES (?, NULL, ?, ?, ?, 0)`)
      .run(req.workspace.id, name, description || null, body).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_report_template', 'report', id, { name }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/reports`);
  });

  // ==================== AUDIT OBSERVATIONS + CRISIS COMMS ====================
  // Audit observations (lighter than findings)
  // Audit checklist generator - populates audit_observations with starter questions for
  // every Annex A control in the chosen category. Auditor fills in findings against each.
  // SoA-driven checklist generator: only generates observations for controls the
  // workspace has marked applicable + included on the SoA, with evidence-linkage
  // counts pulled in and sample-size suggestions based on the control family.
  // Mirrors the category-based generator below but is the right choice once the
  // SoA has been worked through — auditors shouldn't be testing excluded controls.

  // Sample-size heuristics keyed to Annex A control prefixes. Each entry returns
  // guidance the auditor pastes into the observation. Numbers are auditor-norms
  // (BSI / IRCA guidance) not standards-mandated.
  const SAMPLE_SIZE_HINTS = {
    // Access control — clauses where "5 users" is the typical sample
    'annex-a.5.15': 'Sample 10 users (mix of joiner / mover / leaver).',
    'annex-a.5.16': 'Sample 10 user accounts created in the last 6 months.',
    'annex-a.5.17': 'Sample 5 authentication records (MFA enrolment, password reset).',
    'annex-a.5.18': 'Sample 10 access rights changes; verify approval evidence.',
    'annex-a.8.2': 'Sample 5 privileged-access requests; verify approval + revocation.',
    'annex-a.8.3': 'Sample 5 systems for least-privilege configuration.',
    'annex-a.8.5': 'Sample 5 admin authentications; verify phishing-resistant MFA.',
    // Logging + monitoring
    'annex-a.8.15': 'Sample 10 consecutive days of logs; verify retention.',
    'annex-a.8.16': 'Sample 3 alert investigations from the last 90 days.',
    // Backups + BCP
    'annex-a.8.13': 'Sample 3 restore tests; verify RTO/RPO met.',
    'annex-a.5.29': 'Sample 1 BCP test conducted in the last 12 months.',
    'annex-a.5.30': 'Sample evidence of ICT readiness for BC.',
    // Suppliers
    'annex-a.5.19': 'Sample 5 active suppliers; verify security clauses + review records.',
    'annex-a.5.20': 'Sample 5 supplier contracts.',
    'annex-a.5.21': 'Sample 5 ICT supply-chain risk assessments.',
    'annex-a.5.22': 'Sample 5 supplier reviews from the last 12 months.',
    // Incidents
    'annex-a.5.24': 'Verify incident response procedure exists + has been exercised.',
    'annex-a.5.25': 'Sample 5 incidents from the last 12 months.',
    'annex-a.5.26': 'Sample 5 incident responses; verify lessons-learned captured.',
    'annex-a.5.27': 'Sample 3 post-incident reviews.',
    // Risk
    'annex-a.6.3': 'Sample 5 training completion records.',
    // Default
    '_default': 'Sample 3–5 records or 1 process walkthrough.'
  };

  function sampleHintFor(controlId) {
    return SAMPLE_SIZE_HINTS[controlId] || SAMPLE_SIZE_HINTS._default;
  }

  app.post('/workspaces/:wsId/audits/:id/checklist-from-soa', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');

    // Pull every included control with its linkage counts so the auditor sees
    // immediately which controls have evidence + a policy backing them.
    const rows = db.prepare(`
      SELECT i.id, i.title, i.category,
        cs.status,
        ${docLinks.docCountSubquery('iso27001')} AS doc_count,
        ${evReads.checklistEvidenceCountSubquery()} AS evi_count
      FROM iso_items i
      INNER JOIN v_control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type='control' AND cs.applicability='included'
      ORDER BY i.sort_order
    `).all(req.workspace.id, req.workspace.id, req.workspace.id);

    if (!rows.length) {
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`,
        'No controls marked included on the SoA - decide applicability before generating an audit checklist', 'error'));
    }

    const existing = new Set(db.prepare(`SELECT iso_item_id FROM audit_observations WHERE audit_id=? AND iso_item_id IS NOT NULL`)
      .all(audit.id).map(r => r.iso_item_id));
    const toInsert = rows.filter(r => !existing.has(r.id));

    const ins = db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, status) VALUES (?, ?, ?, 'open')`);
    const tx = db.transaction(() => {
      toInsert.forEach(r => {
        const code = r.id.replace('annex-', '').toUpperCase();
        const cleanTitle = r.title.replace(/^A\.[0-9.]+ /, '');
        const linkLine = `Linked policies: ${r.doc_count} - Linked evidence: ${r.evi_count}`;
        const sampleLine = `Sample size suggestion: ${sampleHintFor(r.id)}`;
        const testLine = `Test: (1) Is there a documented procedure? (2) Is it operating in practice - sample evidence below. (3) Has it been reviewed in the last 12 months?`;
        const findingLine = `Finding template: [Conformance / Observation / Minor NC / Major NC] - [describe what was tested, what was seen, root cause if NC, evidence references]`;
        const description = `${code} - ${cleanTitle}\n\n${testLine}\n\n${linkLine}\n${sampleLine}\n\n${findingLine}`;
        ins.run(audit.id, r.id, description);
      });
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'generate_audit_checklist_from_soa', 'audit', audit.id,
      { added: toInsert.length, skipped_existing: rows.length - toInsert.length }, auditCtx(req));
    const skipped = rows.length - toInsert.length;
    const msg = skipped > 0
      ? `Added ${toInsert.length} new checklist item${toInsert.length === 1 ? '' : 's'} · ${skipped} already existed and were kept`
      : `Generated ${toInsert.length} checklist item${toInsert.length === 1 ? '' : 's'} from SoA · sample-size hints + linkage included`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`, msg));
  });

  app.post('/workspaces/:wsId/audits/:id/checklist', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');
    const category = req.body.category;
    const validCats = ['org','people','physical','tech','clauses'];
    if (!validCats.includes(category)) return redirectBack(req, res);
    const controls = category === 'clauses'
      ? db.prepare(`SELECT id, title FROM iso_items WHERE type='clause' ORDER BY sort_order`).all()
      : db.prepare(`SELECT id, title FROM iso_items WHERE type='control' AND category=? ORDER BY sort_order`).all(category);

    const existing = new Set(db.prepare(`SELECT iso_item_id FROM audit_observations WHERE audit_id=? AND iso_item_id IS NOT NULL`)
      .all(audit.id).map(r => r.iso_item_id));
    const toInsert = controls.filter(c => !existing.has(c.id));

    const ins = db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, status) VALUES (?, ?, ?, 'open')`);
    const tx = db.transaction(() => {
      toInsert.forEach(c => {
        const cleanTitle = c.title.replace(/^A\.[0-9.]+ /, '').replace(/^Clause [0-9.]+ /, '');
        const q = `${c.id.replace('annex-','').replace('clause-','').toUpperCase()} - ${cleanTitle}: Is there a documented process? Is it operating in practice (sample evidence)? Has it been reviewed in the last 12 months?`;
        ins.run(audit.id, c.id, q);
      });
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'generate_audit_checklist', 'audit', audit.id,
      { category, added: toInsert.length, skipped_existing: controls.length - toInsert.length }, auditCtx(req));
    const skipped = controls.length - toInsert.length;
    const msg = skipped > 0
      ? `Added ${toInsert.length} new checklist item${toInsert.length === 1 ? '' : 's'} from ${category} · ${skipped} already existed and were kept`
      : `Generated ${toInsert.length} checklist item${toInsert.length === 1 ? '' : 's'} - fill in findings against each`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`, msg));
  });

  app.post('/workspaces/:wsId/audits/:id/observations', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Audit not found');
    const { iso_item_id, description, recommendation } = req.body;
    if (!description) return redirectBack(req, res);
    db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, recommendation) VALUES (?, ?, ?, ?)`)
      .run(req.params.id, iso_item_id || null, description, recommendation || null);
    res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/close', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=? AND audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`).run(req.params.obsId, req.workspace.id);
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/audits/:id/checklist/clear', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!audit) return res.status(404).send('Not found');
    const result = db.prepare(`DELETE FROM audit_observations WHERE audit_id=? AND status='open'`).run(audit.id);
    logAction(req.user.id, req.workspace.id, 'clear_audit_checklist', 'audit', audit.id, { deleted: result.changes }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`,
      `Cleared ${result.changes} open checklist item${result.changes === 1 ? '' : 's'} (closed items kept)`));
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/reopen', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    db.prepare(`UPDATE audit_observations SET status='open' WHERE id=? AND audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`).run(req.params.obsId, req.workspace.id);
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/notes', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const obs = db.prepare(`SELECT o.id, o.audit_id FROM audit_observations o
      INNER JOIN audits a ON a.id = o.audit_id
      WHERE o.id=? AND a.workspace_id=?`).get(req.params.obsId, req.workspace.id);
    if (!obs) return res.status(404).send('Not found');
    db.prepare(`UPDATE audit_observations SET recommendation=? WHERE id=?`).run(req.body.recommendation || null, obs.id);
    logAction(req.user.id, req.workspace.id, 'update_audit_observation', 'audit_observation', obs.id, {}, auditCtx(req));
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/audits/observations/:obsId/promote', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
    const obs = db.prepare(`SELECT o.* FROM audit_observations o
      INNER JOIN audits a ON a.id = o.audit_id
      WHERE o.id=? AND a.workspace_id=?`).get(req.params.obsId, req.workspace.id);
    if (!obs) return res.status(404).send('Not found');
    const finding_type = ['observation','ofi','minor_nc','major_nc'].includes(req.body.finding_type) ? req.body.finding_type : 'observation';
    const severity = ['low','medium','high'].includes(req.body.severity) ? req.body.severity : 'medium';
    const description = (req.body.description || obs.recommendation || obs.description || '').trim();
    if (!description) return redirectBack(req, res);
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, severity, description, status)
                  VALUES (?, ?, ?, ?, ?, 'open')`)
        .run(obs.audit_id, obs.iso_item_id || null, finding_type, severity, description);
      db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=?`).run(obs.id);
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'promote_observation_to_finding', 'audit_observation', obs.id,
      { finding_type, severity }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${obs.audit_id}`,
      `Promoted to ${finding_type.replace('_',' ')} finding`));
  });

  // ==================== KEY ROTATION + BACKUP UI ====================
  app.get('/workspaces/:wsId/system', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).render('error', { user: req.user, message: 'Firm owner only.' });
    const backups = backup.listBackups();
    const rotations = db.prepare(`SELECT * FROM key_rotations ORDER BY id DESC LIMIT 50`).all();
    const masterFp = keyrotation.fingerprint(enc.masterKey());
    const lastDrill = require('../lib/restore-check').lastDrill();
    res.render('system', { user: req.user, ws: req.workspace, backups, rotations, masterFp, lastDrill });
  });

  app.post('/workspaces/:wsId/system/backup', requireAuth, requireWorkspace, async (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('forbidden');
    const r = await backup.runBackup();
    logAction(req.user.id, req.workspace.id, 'manual_backup', 'system', null, r, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/system`, r.ok ? 'Backup ok' : 'Backup failed: ' + r.error, r.ok ? 'success' : 'error'));
  });

  app.post('/workspaces/:wsId/system/rotate-key', requireAuth, requireWorkspace, (req, res) => {
    if (!isFirmOwner(req.user)) return res.status(403).send('forbidden');
    if (req.body.confirm !== 'rotate') return res.redirect(`/workspaces/${req.workspace.id}/system`);
    const r = keyrotation.rotate(req.user.id);
    logAction(req.user.id, null, 'rotate_master_key', 'system', null, r, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/system`, r.ok ? `Rotated. Re-encrypted ${r.rows} rows.` : 'Rotation failed: ' + r.error, r.ok ? 'success' : 'error'));
  });

  // ==================== FILE PREVIEW ====================
  app.get('/workspaces/:wsId/evidence/:id/preview', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const ev = db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
    const ext = path.extname(ev.filename).toLowerCase();
    const ct = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.svg':'image/svg+xml','.txt':'text/plain' }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `inline; filename="${ev.filename}"`);
    res.sendFile(fp);
  });

  // ==================== COMMENT MENTIONS HANDLING ====================
  // Override the existing comments POST to extract @mentions and notify

  // Keep existing POST /comments - just add a post-processor to record mentions
  // Hook into existing comment route by patching after-create. We already inserted
  // comments; add a small route that handles mentions parse separately.
  app.post('/workspaces/:wsId/comments/:id/mentions', requireAuth, requireWorkspace, (req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!c) return redirectBack(req, res);
    const decBody = enc.decryptIfNeeded(c.body, req.workspace.id);
    const handles = extractMentions(decBody);
    if (!handles.length) return redirectBack(req, res);
    const users = db.prepare(`SELECT id, name FROM users WHERE active=1`).all();
    const ins = db.prepare(`INSERT OR IGNORE INTO comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?)`);
    let mentioned = 0;
    for (const h of handles) {
      const u = users.find(u => u.name.toLowerCase().replace(/\s+/g,'') === h.toLowerCase());
      if (u) { ins.run(c.id, u.id); mentioned++;
        jobs.notify(req.workspace.id, u.id, 'mention', 'info', `@${h} you were mentioned`, decBody.slice(0,140), `/workspaces/${req.workspace.id}`); }
    }
    if (mentioned > 0) db.prepare('UPDATE comments SET has_mentions=1 WHERE id=?').run(c.id);
    redirectBack(req, res);
  });

}

module.exports = { register };
