// Audit-pack assembly: pulls every artefact an external auditor expects in one
// PDF deliverable, renders to HTML via the audit_pack template, and prints to
// PDF with Chromium. The PDF is what consultants currently hand-assemble in
// 8-15 hours per engagement; a single click here replaces that.
//
// Generation is per-request (no browser pooling). A cold Chromium launch is
// ~300ms and the PDF stage dominates wall-time for any non-trivial pack, so
// reuse complexity isn't worth it yet.

'use strict';

const fs = require('fs');
const path = require('path');
const ctlReads = require('./control-reads');

// Cached base64 of Source Serif 4 (variable, latin subset). Embedded as a data
// URI in audit_pack.ejs so the PDF always renders with the right display face
// regardless of puppeteer's setContent + relative-URL limitations.
let _serifDataUri = null;
function getSerifDataUri() {
  if (_serifDataUri !== null) return _serifDataUri;
  try {
    const fontPath = path.join(__dirname, '..', 'public', 'fonts', 'source-serif-4', 'SourceSerif4-VF.woff2');
    const buf = fs.readFileSync(fontPath);
    _serifDataUri = 'data:font/woff2;base64,' + buf.toString('base64');
  } catch (_) {
    _serifDataUri = '';
  }
  return _serifDataUri;
}

// ---------- helpers ----------
function fmtDate(d) {
  if (!d) return '';
  const s = String(d);
  // SQLite dates may arrive as 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'. Render
  // as YYYY-MM-DD for the audit pack since auditors want unambiguous dates.
  return s.slice(0, 10);
}

function safe(v) { return v == null ? '' : String(v); }

// ---------- data gather ----------
// All section toggles default to true. Caller can opt out per-section.
function defaultOpts() {
  return {
    sections: {
      cover: true,
      summary: true,
      soa: true,
      risks: true,
      evidence: true,
      ncs: true,
      improvements: true,
      audits: true,
      mrms: true,
      audit_trail: true
    },
    snapshotId: null,         // null = pick most recent
    brand: {},                // overrides for firm/workspace branding
    preparedBy: null,         // free-text consultant/firm name override
    preparedFor: null         // free-text client override
  };
}

function gatherAuditPackData(deps, wsId, opts) {
  const { db, enc, methodologyBand, getActiveMethodology } = deps;
  opts = Object.assign(defaultOpts(), opts || {});
  opts.sections = Object.assign(defaultOpts().sections, opts.sections || {});

  const workspace = db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(wsId);
  if (!workspace) throw new Error('workspace_not_found');
  const firm = db.prepare(`SELECT * FROM firms WHERE id = ?`).get(workspace.firm_id) || { name: '' };

  // Brand: workspace overrides firm; opts overrides everything. Logo path is
  // intentionally left to a future build (file resolution from uploads/firm_X).
  const brand = {
    displayName: opts.brand.displayName || workspace.brand_display_name || firm.name || 'ISMS Consultancy',
    primaryColor: opts.brand.primaryColor || workspace.brand_primary_color || '#5C0A0A',
    logoPath: opts.brand.logoPath || workspace.brand_logo_path || null,
    confidentialityLabel: opts.brand.confidentialityLabel || 'CONFIDENTIAL · For audit and management review purposes only'
  };

  const data = {
    workspace,
    firm,
    brand,
    generatedAt: new Date(),
    preparedFor: opts.preparedFor || workspace.client_name,
    preparedBy: opts.preparedBy || firm.name || brand.displayName,
    sections: opts.sections,
    serifDataUri: getSerifDataUri()
  };

  // -------- Statement of Applicability --------
  if (opts.sections.soa) {
    let snapshot = opts.snapshotId
      ? db.prepare(`SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?`).get(opts.snapshotId, wsId)
      : db.prepare(`SELECT * FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`).get(wsId);
    let soaRows = [];
    if (snapshot) {
      try { soaRows = JSON.parse(enc.decryptIfNeeded(snapshot.payload, wsId)); }
      catch (e) { snapshot = null; }
    }
    if (!snapshot) {
      // Fall back to live SoA state if there are no snapshots yet so a brand-new
      // workspace can still produce a coherent pack; the cover will note that
      // the SoA is the live state, not a frozen snapshot.
      soaRows = db.prepare(`SELECT i.id, i.title, i.category,
            COALESCE(cs.applicability,'undecided') AS applicability,
            COALESCE(cs.status,'Not Assessed') AS status,
            cs.inclusion_justification, cs.exclusion_justification
          FROM iso_items i
          LEFT JOIN ${ctlReads.tables(db, wsId).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
          WHERE i.type='control'
          ORDER BY i.sort_order`).all(wsId);
    }
    data.soa = {
      snapshot,
      rows: soaRows,
      counts: {
        total: soaRows.length,
        included: soaRows.filter(r => r.applicability === 'included').length,
        excluded: soaRows.filter(r => r.applicability === 'excluded').length,
        undecided: soaRows.filter(r => !['included','excluded'].includes(r.applicability)).length
      }
    };
  }

  // -------- Risk register --------
  if (opts.sections.risks) {
    const m = getActiveMethodology ? getActiveMethodology(wsId) : null;
    const risks = db.prepare(`SELECT r.*, a.name AS asset_name
      FROM risks r LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.workspace_id = ?
      ORDER BY (COALESCE(r.likelihood,0) * COALESCE(r.impact,0)) DESC, r.id`).all(wsId);
    const enriched = risks.map(r => ({
      ...r,
      band: (m && methodologyBand) ? methodologyBand(m, r.likelihood, r.impact) : '',
      residual_band: (m && methodologyBand && r.residual_likelihood && r.residual_impact)
        ? methodologyBand(m, r.residual_likelihood, r.residual_impact) : ''
    }));
    const bandCounts = {};
    enriched.forEach(r => { if (r.band) bandCounts[r.band] = (bandCounts[r.band] || 0) + 1; });
    data.risks = {
      methodology: m,
      rows: enriched,
      bandCounts,
      open: enriched.filter(r => r.status === 'open').length,
      treated: enriched.filter(r => r.status === 'treated' || r.status === 'closed').length
    };
  }

  // -------- Evidence index --------
  if (opts.sections.evidence) {
    const rows = db.prepare(`SELECT e.id, e.filename, e.sha256, e.size_bytes, e.iso_item_id,
        e.uploaded_at, e.description, u.name AS uploader
      FROM evidence e
      LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id = ?
      ORDER BY e.uploaded_at DESC`).all(wsId);
    data.evidence = {
      rows,
      count: rows.length,
      totalBytes: rows.reduce((a, r) => a + (r.size_bytes || 0), 0)
    };
  }

  // -------- Nonconformities --------
  if (opts.sections.ncs) {
    const rows = db.prepare(`SELECT * FROM nonconformities WHERE workspace_id = ?
      ORDER BY (status='open') DESC, created_at DESC`).all(wsId);
    data.ncs = {
      rows,
      open: rows.filter(r => r.status === 'open').length,
      closed: rows.filter(r => r.status === 'closed').length,
      majorOpen: rows.filter(r => r.status === 'open' && r.severity === 'major').length
    };
  }

  // -------- Improvements --------
  if (opts.sections.improvements) {
    const rows = db.prepare(`SELECT * FROM improvements WHERE workspace_id = ?
      ORDER BY (status='open' OR status='in_progress') DESC, due_date ASC`).all(wsId);
    data.improvements = {
      rows,
      open: rows.filter(r => r.status === 'open' || r.status === 'in_progress').length,
      done: rows.filter(r => r.status === 'done').length
    };
  }

  // -------- Internal audits + findings --------
  if (opts.sections.audits) {
    const audits = db.prepare(`SELECT * FROM audits WHERE workspace_id = ?
      ORDER BY audit_date DESC, id DESC`).all(wsId);
    const findingsByAudit = {};
    if (audits.length) {
      const findings = db.prepare(`SELECT f.*, a.workspace_id FROM audit_findings f
        INNER JOIN audits a ON a.id = f.audit_id
        WHERE a.workspace_id = ?
        ORDER BY f.created_at`).all(wsId);
      findings.forEach(f => { (findingsByAudit[f.audit_id] = findingsByAudit[f.audit_id] || []).push(f); });
    }
    data.audits = {
      rows: audits.map(a => ({ ...a, findings: findingsByAudit[a.id] || [] })),
      count: audits.length
    };
  }

  // -------- Management reviews --------
  if (opts.sections.mrms) {
    const rows = db.prepare(`SELECT * FROM mrms WHERE workspace_id = ?
      ORDER BY meeting_date DESC, id DESC`).all(wsId);
    data.mrms = {
      rows,
      held: rows.filter(r => r.status === 'held' || r.status === 'completed' || r.status === 'closed').length,
      lastMeetingDate: rows.find(r => r.meeting_date) ? rows.find(r => r.meeting_date).meeting_date : null
    };
  }

  // -------- Audit trail summary --------
  if (opts.sections.audit_trail) {
    const trail = db.prepare(`SELECT al.created_at, al.action, al.entity_type, al.entity_id, u.name AS actor
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.workspace_id = ?
      ORDER BY al.created_at DESC LIMIT 50`).all(wsId);
    const totalCount = db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE workspace_id = ?`).get(wsId).c;
    data.audit_trail = { recent: trail, total: totalCount };
  }

  return data;
}

// ---------- PDF generation ----------
// Lazy-require puppeteer so dev-only environments (tests, content syncing)
// don't pay the Chromium startup cost just to load this module.
let _puppeteer = null;
function getPuppeteer() {
  if (!_puppeteer) _puppeteer = require('puppeteer');
  return _puppeteer;
}

// PDF renders are serialized to one at a time: each render launches a full
// Chromium, and two concurrent packs would double the memory spike for zero
// latency win. Later requests queue behind the chain in arrival order.
let pdfChain = Promise.resolve();
function renderPDF(html, opts) {
  const next = pdfChain.then(() => renderPDFNow(html, opts));
  pdfChain = next.catch(() => {});
  return next;
}

async function renderPDFNow(html, opts) {
  opts = opts || {};
  const puppeteer = getPuppeteer();
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    // setContent waits until network-idle so any inlined fonts/styles settle
    // before the page is captured. The audit pack template ships every asset
    // inline so this finishes fast.
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');

    const headerTemplate = `
      <div style="font-size:8px;color:#999;width:100%;padding:0 16mm;">
        <span style="float:left">${escapeForHeader(opts.headerLeft || '')}</span>
        <span style="float:right">${escapeForHeader(opts.headerRight || '')}</span>
      </div>`;
    const footerTemplate = `
      <div style="font-size:8px;color:#999;width:100%;padding:0 16mm;">
        <span style="float:left">${escapeForHeader(opts.footerLeft || '')}</span>
        <span style="float:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`;

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '22mm', bottom: '20mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      preferCSSPageSize: false
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

function escapeForHeader(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

module.exports = {
  gatherAuditPackData,
  renderPDF,
  defaultOpts,
  fmtDate,
  safe
};
