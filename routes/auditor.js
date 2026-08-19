// Auditor portal routes - magic-link, no auth required.
//
// Pattern mirrors the supplier questionnaire (/q/:token): the token IS the
// credential. We don't introduce external user accounts; the consultant mints
// a time-bound share, hands the URL to the auditor, and revokes when done.
// Every access is logged so the consultant can prove who saw what.
//
// All routes under /auditor/* are token-validated by requireAuditorToken,
// which loads req.workspace, req.share, and writes an entry to audit_log.
//
// Reads are GET-only on this surface; the only "write" surface is the
// audit-pack PDF, which is a token-authorised GET that regenerates the same
// PDF the consultant produces.

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const ctlReads = require('../lib/control-reads');
const docLinks = require('../lib/doc-links');

function register(app, deps) {
  const {
    db, enc, mdRenderer, logAction,
    getActiveMethodology, methodologyBand,
    auditPack, escapeHtml,
    resolveUploadPath,
    fs, path
  } = deps;

  // ---- token middleware ----
  // Validates :token, enforces expiry + revocation, loads workspace, logs the
  // access. Anything past this is guaranteed a valid req.share and req.workspace.
  function requireAuditorToken(req, res, next) {
    const token = req.params.token;
    if (!token) return res.status(404).render('error', { user: null, message: 'Auditor link missing token.' });
    const share = db.prepare(`SELECT * FROM auditor_shares WHERE token=?`).get(token);
    if (!share) {
      return res.status(404).render('error', { user: null, message: 'This auditor link is not valid. It may have been revoked or the URL is wrong.' });
    }
    if (share.revoked_at) {
      return res.status(403).render('error', { user: null, message: 'This auditor link has been revoked by the consultant. Contact them for a new one.' });
    }
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(403).render('error', { user: null, message: 'This auditor link has expired. Contact the consultant for a new one.' });
    }
    const workspace = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(share.workspace_id);
    if (!workspace) return res.status(404).render('error', { user: null, message: 'Workspace not found.' });

    // Log + count. One audit-log row per HTTP request gives the consultant a
    // forensic trail when the auditor reports "I looked at A.5.15 evidence".
    try {
      db.prepare(`UPDATE auditor_shares SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id=?`).run(share.id);
      // logAction resolves user_id=0 to the codebase-wide external sentinel
      // user, satisfying audit_log's FK without inventing a fake row here.
      logAction(0, workspace.id, 'auditor_access', 'auditor_share', share.id,
        { path: req.path, share_id: share.id },
        { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    } catch (_) { /* logging is best-effort */ }

    req.share = share;
    req.workspace = workspace;
    next();
  }

  // ---- helpers ----
  function fmtDate(d) { return d ? String(d).slice(0, 10) : '-'; }
  function bytes(n) {
    if (!n && n !== 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function renderAuditorView(res, view, locals) {
    res.render(view, Object.assign({ token: locals.share.token, share: locals.share, ws: locals.workspace, fmtDate, bytes }, locals));
  }

  // ---- LANDING ----
  app.get('/auditor/:token', requireAuditorToken, (req, res) => {
    // Roll-up counts for the section tiles so the auditor sees scope at a
    // glance before clicking through.
    const counts = {
      soa_total: db.prepare(`SELECT COUNT(*) c FROM v_control_states WHERE workspace_id=?`).get(req.workspace.id).c,
      soa_snapshots: db.prepare(`SELECT COUNT(*) c FROM soa_snapshots WHERE workspace_id=?`).get(req.workspace.id).c,
      risks: db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(req.workspace.id).c,
      risks_open: db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open'`).get(req.workspace.id).c,
      evidence: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`).get(req.workspace.id).c,
      documents: db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND retired_at IS NULL`).get(req.workspace.id).c,
      ncs_open: db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status='open'`).get(req.workspace.id).c,
      ncs_total: db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?`).get(req.workspace.id).c,
      audits: db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`).get(req.workspace.id).c,
      mrms: db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?`).get(req.workspace.id).c
    };
    const firm = db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id) || {};
    renderAuditorView(res, 'auditor_landing', { share: req.share, workspace: req.workspace, counts, firm });
  });

  // ---- SoA ----
  app.get('/auditor/:token/soa', requireAuditorToken, (req, res) => {
    // Prefer the most recent snapshot if there is one - that's the version
    // the auditor should see. Live state is a fallback for never-snapshotted
    // workspaces, clearly flagged.
    const snapshot = db.prepare(`SELECT * FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`).get(req.workspace.id);
    let rows = [], from = 'live';
    if (snapshot) {
      try { rows = JSON.parse(enc.decryptIfNeeded(snapshot.payload, req.workspace.id)); from = 'snapshot'; } catch (_) {}
    }
    if (from === 'live') {
      const T = ctlReads.tables(db, req.workspace.id);
      rows = db.prepare(`SELECT i.id, i.title, i.category,
            COALESCE(cs.applicability,'undecided') AS applicability,
            COALESCE(cs.status,'Not Assessed') AS status,
            cs.inclusion_justification, cs.exclusion_justification
          FROM iso_items i
          LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
          WHERE i.type='control'
          ORDER BY i.sort_order`).all(req.workspace.id);
    }
    const counts = {
      total: rows.length,
      included: rows.filter(r => r.applicability === 'included').length,
      excluded: rows.filter(r => r.applicability === 'excluded').length,
      undecided: rows.filter(r => !['included','excluded'].includes(r.applicability)).length
    };
    const allSnaps = db.prepare(`SELECT id, label, created_at, payload_hash, included_count FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_soa', { share: req.share, workspace: req.workspace, rows, from, snapshot, counts, allSnaps });
  });

  app.get('/auditor/:token/soa/snapshots/:id(\\d+)', requireAuditorToken, (req, res) => {
    const snapshot = db.prepare(`SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!snapshot) return res.status(404).render('error', { user: null, message: 'Snapshot not found.' });
    let rows = [];
    try { rows = JSON.parse(enc.decryptIfNeeded(snapshot.payload, req.workspace.id)); } catch (_) {}
    const allSnaps = db.prepare(`SELECT id, label, created_at, payload_hash, included_count FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC`).all(req.workspace.id);
    const counts = {
      total: rows.length,
      included: rows.filter(r => r.applicability === 'included').length,
      excluded: rows.filter(r => r.applicability === 'excluded').length,
      undecided: rows.filter(r => !['included','excluded'].includes(r.applicability)).length
    };
    renderAuditorView(res, 'auditor_soa', { share: req.share, workspace: req.workspace, rows, from: 'snapshot', snapshot, counts, allSnaps });
  });

  // ---- RISKS ----
  app.get('/auditor/:token/risks', requireAuditorToken, (req, res) => {
    const methodology = getActiveMethodology(req.workspace.id);
    const risks = db.prepare(`SELECT r.*, a.name AS asset_name FROM risks r
      LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.workspace_id = ?
      ORDER BY (COALESCE(r.likelihood,0) * COALESCE(r.impact,0)) DESC, r.id`).all(req.workspace.id);
    const enriched = risks.map(r => ({ ...r, band: methodologyBand(methodology, r.likelihood, r.impact) }));
    renderAuditorView(res, 'auditor_risks', { share: req.share, workspace: req.workspace, risks: enriched, methodology });
  });

  // ---- EVIDENCE ----
  app.get('/auditor/:token/evidence', requireAuditorToken, (req, res) => {
    const evidence = db.prepare(`SELECT e.id, e.filename, e.sha256, e.size_bytes, e.iso_item_id,
        e.uploaded_at, e.description, u.name AS uploader
      FROM evidence e
      LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id = ?
      ORDER BY e.uploaded_at DESC`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_evidence', { share: req.share, workspace: req.workspace, evidence });
  });

  app.get('/auditor/:token/evidence/:id(\\d+)/download', requireAuditorToken, (req, res) => {
    const ev = db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).render('error', { user: null, message: 'Evidence file not found.' });
    const filepath = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
    if (!filepath || !fs.existsSync(filepath)) return res.status(404).render('error', { user: null, message: 'Evidence file is no longer on disk. The consultant has been notified.' });
    logAction(0, req.workspace.id, 'auditor_download_evidence', 'evidence', ev.id,
      { share_id: req.share.id, filename: ev.filename },
      { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    res.download(filepath, ev.filename);
  });

  // ---- DOCUMENTS (policies + procedures) ----
  app.get('/auditor/:token/documents', requireAuditorToken, (req, res) => {
    const docs = db.prepare(`SELECT d.id, d.name, d.category, d.status, d.version, d.next_review_date,
        d.published_at, d.approved_at, u.name AS approver,
        (SELECT COUNT(*) FROM ${docLinks.docControlsExpr('iso27001')} dc WHERE dc.document_id = d.id) AS control_count
      FROM generated_docs d
      LEFT JOIN users u ON u.id = d.approved_by
      WHERE d.workspace_id = ? AND d.retired_at IS NULL
      ORDER BY d.category, d.name`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_documents', { share: req.share, workspace: req.workspace, docs });
  });

  app.get('/auditor/:token/documents/:id(\\d+)', requireAuditorToken, (req, res) => {
    const doc = db.prepare(`SELECT d.*, u.name AS approver FROM generated_docs d
      LEFT JOIN users u ON u.id = d.approved_by
      WHERE d.id = ? AND d.workspace_id = ?`).get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).render('error', { user: null, message: 'Document not found.' });
    const body = enc.decryptIfNeeded(doc.content || '', req.workspace.id);
    const html = body && /^<[a-z]/i.test(body.trim()) ? body : mdRenderer.render(body || '');
    const links = db.prepare(`SELECT dc.iso_item_id, i.title FROM ${docLinks.docControlsExpr('iso27001')} dc
      INNER JOIN iso_items i ON i.id = dc.iso_item_id WHERE dc.document_id=?
      ORDER BY i.sort_order`).all(doc.id);
    renderAuditorView(res, 'auditor_document_detail', { share: req.share, workspace: req.workspace, doc, html, links });
  });

  // ---- AUDITS + FINDINGS + NCS ----
  app.get('/auditor/:token/audits', requireAuditorToken, (req, res) => {
    const audits = db.prepare(`SELECT * FROM audits WHERE workspace_id=? ORDER BY audit_date DESC, id DESC`).all(req.workspace.id);
    const findingsByAudit = {};
    if (audits.length) {
      const findings = db.prepare(`SELECT f.*, i.title AS iso_title FROM audit_findings f
        LEFT JOIN iso_items i ON i.id = f.iso_item_id
        INNER JOIN audits a ON a.id = f.audit_id
        WHERE a.workspace_id = ? ORDER BY f.created_at`).all(req.workspace.id);
      findings.forEach(f => { (findingsByAudit[f.audit_id] = findingsByAudit[f.audit_id] || []).push(f); });
    }
    const ncs = db.prepare(`SELECT * FROM nonconformities WHERE workspace_id=? ORDER BY (status='open') DESC, created_at DESC`).all(req.workspace.id);
    renderAuditorView(res, 'auditor_audits', {
      share: req.share, workspace: req.workspace,
      audits: audits.map(a => ({ ...a, findings: findingsByAudit[a.id] || [] })),
      ncs
    });
  });

  // ---- AUDIT-PACK PDF (regenerated on demand for the auditor) ----
  app.get('/auditor/:token/audit-pack', requireAuditorToken, async (req, res) => {
    try {
      const data = auditPack.gatherAuditPackData(
        { db, enc, methodologyBand, getActiveMethodology },
        req.workspace.id,
        {}
      );
      const html = await new Promise((resolve, reject) => {
        app.render('audit_pack', data, (err, h) => err ? reject(err) : resolve(h));
      });
      const firm = db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id) || {};
      const pdfRaw = await auditPack.renderPDF(html, {
        headerLeft: firm.name || '',
        headerRight: `${req.workspace.client_name} · ISMS Audit Pack`,
        footerLeft: 'Confidential · For audit and management review purposes only'
      });
      const pdf = Buffer.isBuffer(pdfRaw) ? pdfRaw : Buffer.from(pdfRaw);
      logAction(0, req.workspace.id, 'auditor_download_pack', 'audit_pack', null,
        { share_id: req.share.id, bytes: pdf.length },
        { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
      const fname = `audit-pack-${req.workspace.client_name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0,10)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(pdf);
    } catch (e) {
      console.error('auditor audit-pack error:', e);
      res.status(500).render('error', { user: null, message: 'Could not generate the audit pack PDF. Refresh and try again - if it persists, contact the consultant.' });
    }
  });

  // ==================== CONSOLE (consultant-facing) ====================
  // Lives under /workspaces/:wsId so it inherits the standard auth path. The
  // public token routes above are separate and unauthenticated.
  const { requireAuth, requireWorkspace, requirePermission } = deps;

  app.get('/workspaces/:wsId/auditor-access', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const shares = db.prepare(`SELECT s.*, u.name AS creator FROM auditor_shares s
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.workspace_id = ? ORDER BY (s.revoked_at IS NULL) DESC, s.created_at DESC`).all(req.workspace.id);
    // Recent access log for the right-hand pane: every auditor hit across all
    // (active + revoked) shares in this workspace, newest first.
    const recentLog = db.prepare(`SELECT al.created_at, al.action, al.entity_type, al.entity_id, al.details
      FROM audit_log al
      WHERE al.workspace_id = ? AND al.action LIKE 'auditor_%'
      ORDER BY al.created_at DESC LIMIT 50`).all(req.workspace.id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const newShareId = req.query.new ? parseInt(req.query.new, 10) || null : null;
    res.render('auditor_access', { user: req.user, ws: req.workspace, shares, recentLog, baseUrl, newShareId });
  });

  app.post('/workspaces/:wsId/auditor-access', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const label = (req.body.label || '').toString().trim() || 'Auditor share';
    const days = Math.max(1, Math.min(365, parseInt(req.body.expires_days || '30', 10)));
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const id = db.prepare(`INSERT INTO auditor_shares (workspace_id, token, label, expires_at, created_by) VALUES (?, ?, ?, ?, ?)`)
      .run(req.workspace.id, token, label, expiresAt, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'create_auditor_share', 'auditor_share', id,
      { label, expires_at: expiresAt, days },
      { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    res.redirect(`/workspaces/${req.workspace.id}/auditor-access?new=${id}`);
  });

  app.post('/workspaces/:wsId/auditor-access/:id(\\d+)/revoke', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const share = db.prepare(`SELECT * FROM auditor_shares WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!share) return res.redirect(`/workspaces/${req.workspace.id}/auditor-access`);
    db.prepare(`UPDATE auditor_shares SET revoked_at = CURRENT_TIMESTAMP WHERE id=?`).run(share.id);
    logAction(req.user.id, req.workspace.id, 'revoke_auditor_share', 'auditor_share', share.id,
      { label: share.label },
      { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
    res.redirect(`/workspaces/${req.workspace.id}/auditor-access`);
  });
}

module.exports = { register };
