'use strict';
// Documents domain. Slice 12 of the server.js modularization, two regions
// joined: (a) documents list/detail + template library, (b) versioning,
// approvals, e-signatures, and the magic-link approval portal.

const path = require('path');
const rbac = require('../lib/rbac');
const fs = require('fs');
const crypto = require('crypto');
const MarkdownIt = require('markdown-it');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const fts = require('../lib/fts');
const enc = require('../lib/encryption');
const personalDrafts = require('../lib/form-drafts');
const collaborationNotifications = require('../lib/notification-delivery');
const email = require('../lib/email');
const docLinks = require('../lib/doc-links');
const reqOpts = require('../lib/requirement-options');
const ctlReads = require('../lib/control-reads');
const docApprovals = require('../lib/doc-approvals');
const documentHtml = require('../lib/document-html');
const outcomeScope = require('../lib/engagement-outcome-scope');
const { looksLikeMarkdown } = require('../lib/docx-gen');
const { snapshotDocVersion, listVersions, listApprovers, listSignatures, verifyVersionSignatures } = require('../lib/doc-versions');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, escapeHtml, parseFormArray } = require('../lib/http-helpers');
const aimsTemplates = require('../lib/iso42001-templates');
const templateValues = require('../lib/template-values');
const firmTemplates = require('../lib/firm-templates');
const { parseWorkspaceFrameworks, frameworkMeta } = require('../lib/frameworks');

const mdRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });

// adoptTemplateForWorkspace is bound at register() so the ISO 42001
// certification request page can start a document from a template through
// the same path the library uses.
const shared = {};

function register(app, deps) {
  // AUTHZ-005: canonical internal-approver eligibility. Mirrors the candidate
  // list the picker offers (workspace member OR active firm user of the
  // workspace's owning firm) and additionally requires document.review, so a
  // hand-crafted POST cannot insert someone the UI would never show.
  function approverEligibility(userId, ws) {
    const u = db.prepare('SELECT id, name, active, user_type, firm_id, firm_role FROM users WHERE id = ?').get(userId);
    if (!u) return { ok: false, reason: 'that user does not exist.' };
    if (!u.active) return { ok: false, reason: 'that account is deactivated.' };

    const membership = db.prepare(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(ws.id, userId);
    const isFirmOfWorkspace = u.user_type === 'firm' && Number(u.firm_id) === Number(ws.firm_id);

    if (!membership && !isFirmOfWorkspace) {
      return { ok: false, reason: 'that user is not part of this engagement.' };
    }

    // Permission comes from the exact membership for clients. Firm Managers
    // retain their firm-wide permission; other firm staff use an explicit
    // workspace membership role when present, otherwise their firm role.
    const role = u.user_type === 'client'
      ? membership.role
      : (rbac.isManager(u.firm_role) ? 'manager' : (membership ? membership.role : u.firm_role));
    const overrides = rbac.activeOverrides(db, ws.id, userId);
    const perms = rbac.effectivePermissions(role, overrides);
    if (!rbac.hasPermission(perms, 'document.review')) {
      return { ok: false, reason: 'that user cannot review documents.' };
    }
    return { ok: true };
  }

  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          upload, resolveUploadPath, isFirmUser, diffObjects } = deps;
  // ISO frameworks a document can be linked against, and their catalogues.
  const DOC_CATALOGUES = { iso27001: 'iso_items', iso42001: 'iso42001_items' };
  const isoFrameworksFor = (workspace) => {
    const codes = reqOpts.enabledCodes(workspace).filter(code => DOC_CATALOGUES[code]);
    return codes.length ? codes : ['iso27001'];
  };
  const requireDocumentImplementation = outcomeScope.requirePostGapService(
    'Policy and document implementation is outside this gap-assessment-only engagement. Existing client documents remain available as assessment inputs.');
  function rejectGapOnlyExternalApproval(res, row) {
    const workspace = row && db.prepare('SELECT * FROM workspaces WHERE id=?').get(row.workspace_id);
    if (!outcomeScope.isGapAssessmentOnly(workspace)) return false;
    res.status(409).render('approve_error', {
      title: 'Approval outside engagement scope',
      message: 'Document implementation and approval are not included in this gap-assessment-only engagement. Contact the engagement owner if the contracted service has changed.'
    });
    return true;
  }

  // ==================== DOCUMENTS ====================
  function substitutePlaceholders(content, vars) {
    return content.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] !== undefined ? vars[key] : m);
  }

  app.get('/workspaces/:wsId/documents', requireAuth, requireWorkspace, (req, res) => {
    // Optional tag filter - `?tag=annex-a.5.15` shows only docs linked to that
    // clause/control. Drives the auditor-side question "which documents cover
    // A.5.15?" without leaving the documents list.
    const tagFilter = req.query.tag || '';
    const T = ctlReads.tables(db, req.workspace.id);
    const docFilterClause = tagFilter
      ? `AND d.id IN (SELECT document_id FROM ${docLinks.docControlsExpr('iso27001')} WHERE iso_item_id = ?)`
      : '';
    const params = tagFilter ? [req.workspace.id, tagFilter] : [req.workspace.id];

    const pgDocs = paginate(db, req, {
      count: `SELECT COUNT(*) c FROM generated_docs d WHERE d.workspace_id = ? AND d.status != 'withdrawn' ${docFilterClause}`,
      rows: `SELECT d.*, u.name AS creator, t.name AS template_name,
      (SELECT COUNT(*) FROM ${docLinks.docControlsExpr('iso27001')} dc WHERE dc.document_id = d.id) AS tag_count,
      (CASE
         WHEN d.next_review_date IS NULL THEN NULL
         WHEN d.next_review_date < date('now') THEN 'overdue'
         WHEN d.next_review_date < date('now','+30 days') THEN 'due_soon'
         ELSE 'current'
       END) AS review_status
      FROM generated_docs d
      LEFT JOIN users u ON u.id = d.created_by
      LEFT JOIN doc_templates t ON t.id = d.template_id
      WHERE d.workspace_id = ? AND d.status != 'withdrawn' ${docFilterClause}
      ORDER BY d.updated_at DESC`,
      params, perPage: 50,
    });
    const docs = pgDocs.rows;

    // Pull the tag chips for each doc - keep the per-doc list small (top 4 +
    // "and N more" overflow) so the table stays compact even on heavily-tagged
    // documents.
    const tagsByDoc = {};
    if (docs.length) {
      const placeholders = docs.map(() => '?').join(',');
      const tagRows = db.prepare(`SELECT dc.document_id, dc.iso_item_id, dc.section_ref, i.type
        FROM ${docLinks.docControlsExpr('iso27001')} dc INNER JOIN iso_items i ON i.id = dc.iso_item_id
        WHERE dc.document_id IN (${placeholders}) ORDER BY i.sort_order`).all(...docs.map(d => d.id));
      tagRows.forEach(r => { (tagsByDoc[r.document_id] = tagsByDoc[r.document_id] || []).push(r); });
    }

    // Distinct tagged iso_items in this workspace - for the filter dropdown.
    const taggedItems = db.prepare(`SELECT DISTINCT i.id, i.type, i.title
      FROM ${docLinks.docControlsExpr('iso27001')} dc
      INNER JOIN generated_docs d ON d.id = dc.document_id
      INNER JOIN iso_items i ON i.id = dc.iso_item_id
      WHERE d.workspace_id = ? AND d.status != 'withdrawn' ORDER BY i.sort_order`).all(req.workspace.id);

    const templates = db.prepare(`SELECT * FROM doc_templates
      WHERE is_system = 1 OR firm_id = ? ORDER BY category, name`).all(req.workspace.firm_id);

    // Registers row used to surface "interested parties register" here;
    // removed alongside the dedicated parties module. Left as an empty
    // array so the view's <% registers.forEach %> stays harmless.
    const registers = [];

    res.render('documents', {
      user: req.user, ws: req.workspace, docs, templates,
      tagsByDoc, taggedItems, tagFilter, registers, awaitingMe: awaitingApprovalBy(req.workspace, req.user),
      pg: pgDocs, pagerHref: p => pageHref(req, p)
    });
  });

  // ==================== TEMPLATE LIBRARY (Phase 6 gallery) ====================
  // Premium discoverable surface for the 74 system policy templates. The legacy
  // dropdown on /documents stays for power users; this gallery is the path that
  // makes the library feel like a paid product. Each card shows adoption state
  // (already in this workspace?) and the Annex A controls the template auto-
  // links on adopt.

  const TIER_RANK = { mandatory: 0, expected: 1, recommended: 2 };

  // Template packs exist for ISO 27001 and ISO 42001. The library shows the
  // pack for one programme at a time, chosen from the programmes this client
  // actually runs, so a 42001 client is not offered ISO 27001 policies and the
  // mandatory counts and bulk adoption mean the right thing.
  function templateFrameworks(ws) {
    const enabled = Array.isArray(ws.frameworks) ? ws.frameworks : parseWorkspaceFrameworks(ws.frameworks);
    const withPacks = ['iso27001', aimsTemplates.FRAMEWORK].filter(f => enabled.includes(f));
    return withPacks.length ? withPacks : ['iso27001'];
  }
  function chosenFramework(req) {
    const available = templateFrameworks(req.workspace);
    const asked = String((req.query && req.query.framework) || (req.body && req.body.framework) || '');
    return available.includes(asked) ? asked : available[0];
  }

  app.get('/workspaces/:wsId/templates', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), (req, res) => {
    const framework = chosenFramework(req);
    const templates = db.prepare(`SELECT id, name, category, description, tier, controls, clauses, framework, requirement_refs
      FROM doc_templates
      WHERE (is_system=1 OR firm_id=?) AND COALESCE(framework, 'iso27001')=?
      ORDER BY name`).all(req.workspace.firm_id, framework);

    const adoptedRows = db.prepare(`SELECT template_id, MIN(id) AS doc_id, COUNT(*) AS n
      FROM generated_docs WHERE workspace_id=? AND template_id IS NOT NULL AND status!='withdrawn'
      GROUP BY template_id`).all(req.workspace.id);
    const adoptedByTpl = {};
    adoptedRows.forEach(r => { adoptedByTpl[r.template_id] = r; });

    // Parse refs and decorate. Sort: mandatory first, then alpha within tier.
    const enriched = templates.map(t => {
      let controls = []; try { controls = JSON.parse(t.controls || '[]'); } catch (_) {}
      let clauses  = []; try { clauses  = JSON.parse(t.clauses  || '[]'); } catch (_) {}
      // One chip vocabulary for both packs: controls first, then clauses.
      const refs = aimsTemplates.refsOf(t);
      const chips = aimsTemplates.frameworkOf(t) === aimsTemplates.FRAMEWORK
        ? [...refs.filter(r => r.startsWith('ai-annex-')).map(r => ({ label: aimsTemplates.code(r), kind: 'control' })),
           ...refs.filter(r => r.startsWith('ai-clause-')).map(r => ({ label: `Cl. ${aimsTemplates.code(r)}`, kind: 'clause' }))]
        : [...controls.map(c => ({ label: c.replace('annex-a.', 'A.').toUpperCase(), kind: 'control' })),
           ...clauses.map(c => ({ label: c.replace('clause-', 'Cl. '), kind: 'clause' }))];
      return { ...t, controls, clauses, chips, adopted: adoptedByTpl[t.id] || null };
    }).sort((a, b) => {
      const ta = TIER_RANK[a.tier || 'recommended'];
      const tb = TIER_RANK[b.tier || 'recommended'];
      return ta - tb || a.name.localeCompare(b.name);
    });

    const counts = {
      total: enriched.length,
      mandatory: enriched.filter(t => t.tier === 'mandatory').length,
      expected:  enriched.filter(t => t.tier === 'expected').length,
      recommended: enriched.filter(t => t.tier === 'recommended').length,
      adopted: enriched.filter(t => t.adopted).length,
      mandatoryAdopted: enriched.filter(t => t.tier === 'mandatory' && t.adopted).length
    };

    res.render('templates_library', {
      user: req.user, ws: req.workspace,
      templates: enriched, counts, framework, templateValues: templateValues.values(db, req.workspace),
      frameworkTabs: templateFrameworks(req.workspace).map(code => ({ code, label: (frameworkMeta(code) || {}).shortLabel || code }))
    });
  });

  app.get('/workspaces/:wsId/templates/:id(\\d+)', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), (req, res) => {
    const tpl = db.prepare(`SELECT * FROM doc_templates WHERE id=? AND (is_system=1 OR firm_id=?)`)
      .get(req.params.id, req.workspace.firm_id);
    if (!tpl) return res.status(404).render('error', { user: req.user, message: 'Template not found.' });
    let controls = []; try { controls = JSON.parse(tpl.controls || '[]'); } catch (_) {}
    let clauses  = []; try { clauses  = JSON.parse(tpl.clauses  || '[]'); } catch (_) {}
    const isoLookup = {};
    if (controls.length || clauses.length) {
      const refs = [...controls, ...clauses];
      const placeholders = refs.map(() => '?').join(',');
      db.prepare(`SELECT id, title FROM iso_items WHERE id IN (${placeholders})`)
        .all(...refs).forEach(r => { isoLookup[r.id] = r.title; });
    }
    const existing = db.prepare(`SELECT id FROM generated_docs
      WHERE workspace_id=? AND template_id=? AND status!='withdrawn' ORDER BY id DESC LIMIT 1`)
      .get(req.workspace.id, tpl.id);
    const aiRefs = aimsTemplates.frameworkOf(tpl) === aimsTemplates.FRAMEWORK
      ? aimsTemplates.refsOf(tpl).map(id => ({ id, code: aimsTemplates.code(id),
          title: String((db.prepare('SELECT title FROM iso42001_items WHERE id=?').get(id) || {}).title || '').replace(/^(A\.)?[\d.]+\s+/, '') }))
      : [];

    // Render the template body with workspace context substituted, then pass the
    // HTML to the view. EJS templates can't require() the markdown renderer, so
    // we do the markdown → HTML pass here and ship the result through.
    const sample = (tpl.content || '')
      .replace(/{{client_name}}/g, req.workspace.client_name)
      .replace(/{{scope}}/g, req.workspace.scope || (req.workspace.client_name + ' information assets'))
      .replace(/{{date}}/g, new Date().toISOString().slice(0,10))
      .replace(/{{firm_name}}/g, '[Firm name]')
      .replace(/{{document_owner}}/g, aimsTemplates.frameworkOf(tpl) === aimsTemplates.FRAMEWORK ? 'AIMS Manager' : 'CISO')
      .replace(/{{approval_authority}}/g, 'Top Management')
      .replace(/{{review_period}}/g, 'Annual')
      .replace(/{{industry}}/g, req.workspace.industry || '');
    const previewHtml = documentHtml.sanitizeDocumentHtml(mdRenderer.render(sample));

    res.render('template_detail', {
      user: req.user, ws: req.workspace,
      tpl, controls, clauses, isoLookup, existing, previewHtml, aiRefs
    });
  });

  app.post('/workspaces/:wsId/templates/adopt-mandatory', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), (req, res) => {
    // Bulk-adopt every mandatory template that isn't already in this workspace.
    // Stops short of expected/recommended so the consultant isn't drowned in
    // 74 documents to review.
    const adopted = db.prepare(`SELECT template_id FROM generated_docs
      WHERE workspace_id=? AND template_id IS NOT NULL AND status!='withdrawn'`).all(req.workspace.id);
    const adoptedSet = new Set(adopted.map(r => r.template_id));
    const framework = chosenFramework(req);
    const toAdopt = db.prepare(`SELECT * FROM doc_templates
      WHERE is_system=1 AND tier='mandatory' AND COALESCE(framework, 'iso27001')=? ORDER BY name`).all(framework)
      .filter(t => !adoptedSet.has(t.id));
    let totalDocs = 0, totalLinks = 0;
    const tx = db.transaction(() => {
      toAdopt.forEach(t => {
        const r = adoptTemplateForWorkspace(t, req.workspace, req.user, req.entityScopeId, req.body);
        totalDocs++;
        totalLinks += r.linkedControls;
      });
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'bulk_adopt_mandatory', 'document', null,
      { adopted: totalDocs, linked_controls: totalLinks }, auditCtx(req));
    const msg = totalDocs === 0
      ? 'All mandatory templates already adopted in this workspace.'
      : `Adopted ${totalDocs} mandatory template${totalDocs === 1 ? '' : 's'} · auto-linked ${totalLinks} control${totalLinks === 1 ? '' : 's'}`;
    res.redirect(withToast(`/workspaces/${req.workspace.id}/templates?framework=${framework}`, msg));
  });

  app.post('/workspaces/:wsId/templates/:id(\\d+)/adopt', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), (req, res) => {
    const tpl = db.prepare(`SELECT * FROM doc_templates WHERE id=? AND (is_system=1 OR firm_id=?)`)
      .get(req.params.id, req.workspace.firm_id);
    if (!tpl) return res.status(404).render('error', { user: req.user, message: 'Template not found.' });
    const r = adoptTemplateForWorkspace(tpl, req.workspace, req.user, req.entityScopeId, req.body);
    const linkSuffix = r.linkedControls > 0 ? ` · auto-linked ${r.linkedControls} control${r.linkedControls === 1 ? '' : 's'}` : '';
    res.redirect(withToast(`/workspaces/${req.workspace.id}/documents/${r.docId}`, `${tpl.name} adopted${linkSuffix}`));
  });

  app.post('/workspaces/:wsId/documents/from-template', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), (req, res) => {
    const { template_id, document_owner, approval_authority, review_period } = req.body;
    const tpl = db.prepare('SELECT * FROM doc_templates WHERE id = ? AND (is_system=1 OR firm_id=?)').get(template_id, req.workspace.firm_id);
    if (!tpl) return redirectBack(req, res);
    const result = adoptTemplateForWorkspace(tpl, req.workspace, req.user, req.entityScopeId, {
      document_owner, approval_authority, review_period
    });
    const linkedSuffix = result.linkedControls > 0
      ? ` · auto-linked ${result.linkedControls} control${result.linkedControls === 1 ? '' : 's'}`
      : '';
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + result.docId, 'Document generated' + linkedSuffix));
  });

  // Shared adoption helper - used by the single from-template POST and by the
  // bulk-adopt-mandatory wizard. Inserts the document, snapshots v1, and links
  // every control referenced in the template's description (from the controls
  // JSON column populated at seed time).
  function adoptTemplateForWorkspace(tpl, workspace, user, entityScopeId, overrides) {
    const today = new Date().toISOString().split('T')[0];
    const firm = db.prepare('SELECT name FROM firms WHERE id = ?').get(workspace.firm_id);
    const vars = {
      client_name: workspace.client_name,
      scope: workspace.scope || `${workspace.client_name} information assets`,
      date: today,
      firm_name: firm?.name || '',
      document_owner: (overrides && overrides.document_owner) || (aimsTemplates.frameworkOf(tpl) === aimsTemplates.FRAMEWORK ? 'AIMS Manager' : 'CISO'),
      approval_authority: (overrides && overrides.approval_authority) || 'Top Management',
      review_period: (overrides && overrides.review_period) || 'Annual',
      industry: workspace.industry || ''
    };
    // The values set for this client replace their bracketed placeholders
    // (lib/template-values.js); an unset one stays for the client to fill.
    const filled = templateValues.fill(substitutePlaceholders(tpl.content, vars), templateValues.values(db, workspace)).content;
    const content = documentHtml.sanitizeDocumentHtml(filled);
    const encContent = enc.encryptIfNeeded(content, workspace.id, !!workspace.encryption_enabled);
    const docId = db.prepare(`INSERT INTO generated_docs (workspace_id, entity_id, template_id, name, category, content, created_by)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(workspace.id, entityScopeId || null, tpl.id, tpl.name, tpl.category, encContent, user.id).lastInsertRowid;
    fts.refresh(workspace.id, 'document', docId);
    snapshotDocVersion(docId, workspace.id, 'draft', user.id, 'Initial draft from template: ' + tpl.name);

    // Auto-link every Annex A control referenced by the template (extracted at
    // seed time from the description). UNION with the clauses column too - main
    // clauses live in the same document_controls table via iso_item_id.
    let linkedControls = 0;
    const linkRefs = [];
    try { (JSON.parse(tpl.controls || '[]')).forEach(c => linkRefs.push(c)); } catch (_) {}
    try { (JSON.parse(tpl.clauses || '[]')).forEach(c => linkRefs.push(c)); } catch (_) {}
    if (linkRefs.length) {
      // drl-native doc-link create (document_controls demolished). addLink no-ops for
      // a ref with no requirement mapping.
      const exists = db.prepare(`SELECT 1 FROM iso_items WHERE id = ?`);
      linkRefs.forEach(ref => {
        if (exists.get(ref)) {
          const r = docLinks.addLink(db, 'iso27001', docId, ref, null);
          if (r.changes) linkedControls++;
        }
      });
    }
    // ISO 42001 templates name their requirements explicitly.
    if (aimsTemplates.frameworkOf(tpl) === aimsTemplates.FRAMEWORK) {
      aimsTemplates.refsOf(tpl).forEach(ref => {
        const r = docLinks.addLink(db, aimsTemplates.FRAMEWORK, docId, ref, null);
        if (r && r.changes) linkedControls++;
      });
    }
    logAction(user.id, workspace.id, 'create_document', 'document', docId,
      { from_template: tpl.name, auto_linked: linkedControls }, { ip: '', userAgent: '' });
    return { docId, linkedControls };
  }
  shared.adoptTemplateForWorkspace = adoptTemplateForWorkspace;

  app.post('/workspaces/:wsId/documents/blank', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), (req, res) => {
    const { name, category } = req.body;
    if (!name) return redirectBack(req, res);
    const initial = documentHtml.sanitizeDocumentHtml('# ' + name + '\n\n');
    const id = db.prepare(`INSERT INTO generated_docs (workspace_id, entity_id, name, category, content, created_by)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, req.entityScopeId || null, name, category || 'policy',
           enc.encryptIfNeeded(initial, req.workspace.id, !!req.workspace.encryption_enabled),
           req.user.id).lastInsertRowid;
    fts.refresh(req.workspace.id, 'document', id);
    snapshotDocVersion(id, req.workspace.id, 'draft', req.user.id, 'Blank document');
    logAction(req.user.id, req.workspace.id, 'create_document', 'document', id, { name, category }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + id);
  });

  // Upload an existing client policy/procedure (DOCX, PDF, MD, TXT). Converts to editable markdown
  // and preserves the original file as the approved source-of-truth attachment.
  app.post('/workspaces/:wsId/documents/upload', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), upload.single('file'), async (req, res) => {
    if (!req.file) return redirectBack(req, res);
    const { name, category } = req.body;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const allowed = ['.docx', '.pdf', '.md', '.markdown', '.txt'];
    if (!allowed.includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents', 'Unsupported file type - use .docx, .pdf, .md, or .txt'));
    }
    const buf = fs.readFileSync(req.file.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');

    let bodyHtml = '';
    let conversionNote = '';
    try {
      if (ext === '.docx') {
        const result = await mammoth.convertToHtml({ path: req.file.path });
        bodyHtml = result.value || '';
        if (result.messages && result.messages.length) {
          conversionNote = `<p><em>Conversion notes: ${result.messages.length} formatting hints from import - review and edit as needed.</em></p>`;
        }
      } else if (ext === '.pdf') {
        const parser = new PDFParse({ data: buf });
        let pdfText = '';
        try {
          const parsed = await parser.getText();
          pdfText = (parsed.text || '').replace(/\r\n/g, '\n');
        } finally {
          if (typeof parser.destroy === 'function') await parser.destroy();
        }
        const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        bodyHtml = pdfText.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
        conversionNote = pdfText.trim()
          ? `<p><em>Imported from PDF - formatting (tables, headings, lists) may need to be re-applied. The original PDF is attached as the approved source.</em></p>`
          : `<p><strong>Text extraction warning:</strong> No searchable text was found. This PDF may be scanned or image-only; run OCR and import the text before relying on automated policy coverage.</p>`;
      } else {
        // .md / .markdown / .txt - run through markdown-it (treats plain text reasonably)
        const MarkdownIt = require('markdown-it');
        const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
        bodyHtml = md.render(buf.toString('utf8'));
      }
    } catch (err) {
      fs.unlinkSync(req.file.path);
      return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents', 'Conversion failed: ' + (err.message || 'unknown')));
    }

    const docName = (name && name.trim()) || req.file.originalname.replace(/\.[^.]+$/, '');
    const cat = category || 'policy';
    const heading = `<h1>${docName.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</h1>\n<p><em>Imported from: ${req.file.originalname.replace(/&/g,'&amp;').replace(/</g,'&lt;')} (sha256 ${sha.slice(0,12)}…)</em></p>\n${conversionNote}<hr>\n`;
    const content = documentHtml.sanitizeDocumentHtml(heading + bodyHtml);
    const encContent = enc.encryptIfNeeded(content, req.workspace.id, !!req.workspace.encryption_enabled);

    const id = db.prepare(`INSERT INTO generated_docs
      (workspace_id, entity_id, name, category, content, created_by,
       source_filename, source_stored_path, source_mime, source_size_bytes, source_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, req.entityScopeId || null, docName, cat, encContent, req.user.id,
           req.file.originalname, req.file.filename, req.file.mimetype || null, req.file.size, sha).lastInsertRowid;
    fts.refresh(req.workspace.id, 'document', id);

    snapshotDocVersion(id, req.workspace.id, 'draft', req.user.id, `Imported from ${req.file.originalname}`);
    logAction(req.user.id, req.workspace.id, 'upload_document', 'document', id, { filename: req.file.originalname, size: req.file.size, sha256: sha }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + id, 'Document imported - review and edit'));
  });

  // Download the original uploaded source file for a document (preserves the as-approved binary)
  app.get('/workspaces/:wsId/documents/:id/source', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!doc || !doc.source_stored_path) return res.status(404).send('No source file attached');
    const fp = resolveUploadPath(doc.source_stored_path, req.workspace.firm_id);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('Source file missing');
    res.download(fp, doc.source_filename || 'source');
  });

  app.get('/workspaces/:wsId/documents/:id', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res, next) => {
    if (req.params.id === 'tree') return next();
    const docRaw = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!docRaw) return res.status(404).send('Not found');
    // Decrypt content for display
    let plainContent = enc.decryptIfNeeded(docRaw.content, req.workspace.id);
    // Lazy migration: legacy markdown -> HTML so the rich editor can render it natively.
    if (looksLikeMarkdown(plainContent)) {
      plainContent = documentHtml.sanitizeDocumentHtml(mdRenderer.render(plainContent));
      // Historical/locked content may already be signed. Render it safely but
      // never rewrite those governed bytes in place.
      if (!docRaw.locked) {
        const enc2 = enc.encryptIfNeeded(plainContent, req.workspace.id, !!req.workspace.encryption_enabled);
        db.prepare('UPDATE generated_docs SET content=? WHERE id=?').run(enc2, docRaw.id);
      }
    } else {
      plainContent = documentHtml.sanitizeDocumentHtml(plainContent);
    }
    const doc = { ...docRaw, content: plainContent };
    const comments = db.prepare(`SELECT c.*, u.name AS author FROM comments c
      INNER JOIN users u ON u.id = c.user_id
      WHERE c.workspace_id = ? AND c.parent_type = 'document' AND c.parent_id = ?
      ORDER BY c.created_at`).all(req.workspace.id, String(doc.id));
    // Decrypt comment bodies too
    const decryptedComments = comments.map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
    const filtered = isFirmUser(req.user) ? decryptedComments : decryptedComments.filter(c => !c.internal_only);

    // Approval / signature context. approvers is the merged chain
    // (internal + external) ordered by sequence; each row has `kind`.
    const versions = listVersions(doc.id);
    const currentVersion = doc.current_version_id ? db.prepare('SELECT * FROM doc_versions WHERE id=?').get(doc.current_version_id) : null;
    const approvers = currentVersion ? docApprovals.listChain(db, currentVersion.id) : [];
    const signatures = currentVersion ? listSignatures(doc.id, currentVersion.id) : [];
    const signatureIssues = currentVersion ? verifyVersionSignatures(currentVersion, signatures, req.workspace.id) : [];
    const wsUsers = db.prepare(`SELECT DISTINCT u.id, u.name, u.email FROM users u
      LEFT JOIN workspace_members m ON m.user_id=u.id
      WHERE (m.workspace_id=? OR (u.firm_id=? AND u.user_type='firm' AND u.active=1))
      ORDER BY u.name`).all(req.workspace.id, req.workspace.firm_id)
      .filter(u => approverEligibility(u.id, req.workspace).ok);

    // Linked Annex A controls + clauses (Phase A: doc <-> control bidirectional mapping).
    // drl-native (document_controls demolished); link_id = drl.id.
    // Every ISO framework the client works to: an ISO 42001 policy is linked to
    // ISO 42001 clauses and controls from here, not only from the control page.
    const docFrameworks = isoFrameworksFor(req.workspace);
    const multiDocFramework = docFrameworks.length > 1;
    const linkedControls = [].concat(...docFrameworks.map(fw => docLinks.linkedControlsForDoc(db, fw, doc.id)
      .map(lc => ({ ...lc, framework: fw, frameworkLabel: reqOpts.label(fw), code: reqOpts.codeOf({ id: lc.iso_item_id, title: lc.title }) }))));
    const allControls = [].concat(...docFrameworks.map(fw => db.prepare(`SELECT id, title, category, type FROM ${DOC_CATALOGUES[fw]}
      WHERE type IN ('control','clause') ORDER BY sort_order`).all()
      .map(c => ({
        ...c, framework: fw, code: reqOpts.codeOf(c), groupKey: `${fw}:${c.type}`,
        groupLabel: (multiDocFramework ? `${reqOpts.label(fw)} ` : '') + (c.type === 'clause' ? 'main body clauses (4–10)' : 'Annex A controls'),
      }))));

    res.render('document_detail', {
      user: req.user, ws: req.workspace, doc, comments: filtered,
      isFirm: isFirmUser(req.user),
      versions, currentVersion, approvers, signatures, signatureIssues, wsUsers,
      linkedControls, allControls,
      perms: res.locals.userPerms
    });
  });

  // Link an Annex A control / clause to a document
  app.post('/workspaces/:wsId/documents/:id/controls', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const doc = db.prepare('SELECT id FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    // iso_item_id can be a single value (single-pick form) or an array (bulk
    // multi-pick form). The section_ref applies to the bulk batch when used -
    // typically left blank for bulk operations and set per link on single ones.
    const ids = parseFormArray(req.body.iso_item_id);
    if (!ids.length) return redirectBack(req, res);
    const sectionRef = req.body.section_ref || null;
    // drl-native doc-link add (document_controls demolished).
    let added = 0;
    const tx = db.transaction(() => {
      for (const id of ids) {
        const fw = reqOpts.frameworkOf(db, id);
        if (!fw || !isoFrameworksFor(req.workspace).includes(fw)) continue;
        if (docLinks.addLink(db, fw, doc.id, id, sectionRef).changes > 0) added++;
      }
    });
    try { tx(); } catch (_) {}
    logAction(req.user.id, req.workspace.id, 'link_doc_control', 'document', doc.id, { ids, count: added, section_ref: sectionRef }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

  app.post('/workspaces/:wsId/documents/:id/controls/:linkId/delete', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const doc = db.prepare('SELECT id FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    // drl-native unlink (document_controls demolished); :linkId is drl.id.
    const link = docLinks.resolveLinkByDoc(db, req.params.linkId, doc.id);
    if (link) {
      docLinks.deleteLink(db, link.id);
      logAction(req.user.id, req.workspace.id, 'unlink_doc_control', 'document', doc.id, { iso_item_id: link.iso_item_id }, auditCtx(req));
    }
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

  // Bidirectional document tagging - mirror routes from the control side. The
  // document-side routes above redirect back to the document; these redirect
  // back to the wizard so the user stays in the assessment flow.
  app.post('/workspaces/:wsId/controls/:isoId/documents', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('ISO item not found');
    const { document_id, section_ref } = req.body;
    if (!document_id) return redirectBack(req, res);
    // Defend against linking a doc from a different workspace.
    const doc = db.prepare('SELECT id FROM generated_docs WHERE id=? AND workspace_id=?').get(document_id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    try {
      // drl-native doc-link (document_controls demolished).
      docLinks.addLink(db, 'iso27001', doc.id, item.id, section_ref || null);
      logAction(req.user.id, req.workspace.id, 'link_doc_control', 'control', item.id, { document_id: doc.id, section_ref: section_ref || null }, auditCtx(req));
    } catch (_) { /* ignore unique-constraint conflict */ }
    res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
  });

  app.post('/workspaces/:wsId/controls/:isoId/documents/:linkId/delete', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    // Verify the link belongs to a doc in this workspace before deleting.
    // drl-native unlink (document_controls demolished); :linkId is drl.id.
    const link = docLinks.resolveLinkByControl(db, req.params.linkId, req.params.isoId, req.workspace.id);
    if (link) {
      docLinks.deleteLink(db, link.id);
      logAction(req.user.id, req.workspace.id, 'unlink_doc_control', 'control', req.params.isoId, { document_id: link.document_id }, auditCtx(req));
    }
    res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${req.params.isoId}`);
  });

  // The values written into templates for this client, and optionally into
  // the placeholders of its documents still in draft.
  app.post('/workspaces/:wsId/templates/values', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.create'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/templates?framework=${encodeURIComponent(req.body.framework || 'iso42001')}`;
    try {
      templateValues.save(db, req.workspace, req.user.id, req.body);
      let message = 'Template values saved';
      if (req.body.apply_to_drafts) {
        if (!rbac.hasPermission(res.locals.userPerms, 'document.edit')) return res.redirect(withToast(back, 'Saved. Filling drafts needs permission to edit documents.', 'error'));
        const changed = templateValues.applyToDrafts(db, req.workspace);
        changed.forEach(d => fts.refresh(req.workspace.id, 'document', d.id));
        message += changed.length ? ` and filled into ${changed.length} draft${changed.length === 1 ? '' : 's'}` : '; no draft had those placeholders';
        logAction(req.user.id, req.workspace.id, 'fill_template_values', 'workspace', req.workspace.id,
          { documents: changed.map(d => d.id), replaced: changed.reduce((n, d) => n + d.replaced, 0) }, auditCtx(req));
      }
      logAction(req.user.id, req.workspace.id, 'save_template_values', 'workspace', req.workspace.id, null, auditCtx(req));
      res.redirect(withToast(back, message));
    } catch (e) {
      if (!(e instanceof templateValues.ValuesError)) throw e;
      res.redirect(withToast(back, e.message, 'error'));
    }
  });

  // Save a document as one of the firm's templates, with this client taken out
  // (lib/firm-templates.js). Firm staff only: the template is offered to every
  // client of the firm.
  app.post('/workspaces/:wsId/documents/:id(\\d+)/save-as-firm-template', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/documents/${req.params.id}`;
    if (!isFirmUser(req.user)) return res.status(403).render('error', { user: req.user, message: 'Only the firm\'s staff can save firm templates.' });
    try {
      const saved = firmTemplates.saveFromDocument(db, req.workspace, Number(req.params.id), req.body);
      logAction(req.user.id, req.workspace.id, 'save_firm_template', 'doc_template', saved.id, { document_id: Number(req.params.id), framework: saved.framework }, auditCtx(req));
      res.redirect(withToast(back, `Saved as the firm template "${saved.name}". Check it for anything else specific to this client.`));
    } catch (e) {
      if (!(e instanceof firmTemplates.FirmTemplateError)) throw e;
      res.redirect(withToast(back, e.message, 'error'));
    }
  });

  // Approve several documents at once. Each is checked as its own decision
  // would be (the user is the next internal approver on a version still in
  // review), and a version the user prepared is never approved in bulk; any
  // document that fails a check is skipped and named, and the rest go ahead.
  app.post('/workspaces/:wsId/documents/bulk-approve', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.review'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/documents`;
    const ids = [...new Set(parseFormArray(req.body.document_ids).map(Number).filter(Number.isInteger))].slice(0, 100);
    if (!ids.length) return res.redirect(withToast(back, 'Select the documents to approve.', 'error'));
    const approved = [];
    const skipped = [];
    const notices = [];
    for (const id of ids) {
      const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(id, req.workspace.id);
      if (!doc || !doc.current_version_id) { skipped.push(`#${id} (not found)`); continue; }
      const outcome = db.transaction(() => {
        const version = db.prepare('SELECT status, created_by FROM doc_versions WHERE id=? AND workspace_id=?').get(doc.current_version_id, req.workspace.id);
        if (!version || version.status !== 'in_review') return 'not in review';
        if (Number(version.created_by) === Number(req.user.id)) return 'you prepared this version; approve it on its own page';
        const mine = db.prepare('SELECT * FROM doc_approvers WHERE version_id=? AND user_id=? AND decision IS NULL ORDER BY sequence LIMIT 1').get(doc.current_version_id, req.user.id);
        if (!mine) return 'you are not a pending approver';
        const next = docApprovals.nextPending(db, doc.current_version_id);
        if (!next || next.kind !== 'internal' || next.row.id !== mine.id) return 'an earlier approver has not decided';
        const decided = db.prepare(`UPDATE doc_approvers SET decision='approved', decision_reason=NULL, decided_at=CURRENT_TIMESTAMP WHERE id=? AND decision IS NULL`).run(mine.id);
        if (!decided.changes) return 'already decided';
        if (docApprovals.countPending(db, doc.current_version_id) === 0) {
          if (finaliseApprovedDocument(doc.current_version_id, doc, req.workspace.id, req.user.id)) {
            logAction(req.user.id, req.workspace.id, 'approve_document', 'document', doc.id, { version_id: doc.current_version_id, bulk: true }, auditCtx(req));
            notices.push(() => notifyChainComplete(doc.current_version_id, doc, req.workspace, req.user.name));
          }
        } else {
          logAction(req.user.id, req.workspace.id, 'partial_approve_document', 'document', doc.id,
            { version_id: doc.current_version_id, remaining: docApprovals.countPending(db, doc.current_version_id), bulk: true }, auditCtx(req));
          notices.push(() => notifyChainAdvanced(doc.current_version_id, doc, req.workspace, req.user.name));
        }
        return null;
      })();
      if (outcome) skipped.push(`${doc.name} (${outcome})`); else approved.push(doc.name);
    }
    // Notify only after each decision has committed.
    for (const send of notices) { try { send(); } catch (e) { console.error('[bulk-approve] notify failed:', e.message); } }
    const message = [approved.length ? `Approved ${approved.length} document${approved.length === 1 ? '' : 's'}.` : 'Nothing was approved.',
      skipped.length ? `Skipped: ${skipped.join('; ')}.` : ''].filter(Boolean).join(' ');
    res.redirect(withToast(back, message, approved.length ? (skipped.length ? 'info' : undefined) : 'error'));
  });

  app.post('/workspaces/:wsId/documents/:id', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.edit'), (req, res) => {
    const before = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!before) return redirectBack(req, res);
    if (before.locked) return res.status(400).render('error', { user: req.user, message: 'Document is locked. Open a new version to edit.' });

    const { name, content, status } = req.body;
    const sets = []; const vals = [];
    if (name !== undefined) { sets.push('name=?'); vals.push(name); }
    if (content !== undefined) {
      sets.push('content=?');
      const safeContent = documentHtml.sanitizeDocumentHtml(content);
      vals.push(enc.encryptIfNeeded(safeContent, req.workspace.id, !!req.workspace.encryption_enabled));
    }
    // Status changes only allowed via dedicated workflow endpoints; keep this for legacy autosave.
    sets.push('updated_at=CURRENT_TIMESTAMP');
    if (sets.length) {
      vals.push(req.params.id, req.workspace.id);
      db.prepare(`UPDATE generated_docs SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
      fts.refresh(req.workspace.id, 'document', req.params.id);
      const after = db.prepare('SELECT id, name, status FROM generated_docs WHERE id=?').get(req.params.id);
      const d = diffObjects(
        { name: before.name, status: before.status },
        { name: after.name, status: after.status }
      );
      logAction(req.user.id, req.workspace.id, 'update_document', 'document', req.params.id, null,
        { ...auditCtx(req), before: d.before, after: d.after });
    }
    // For XHR autosaves return 204 to avoid wasted round trips
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(204).end();
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + req.params.id);
  });

  app.get('/workspaces/:wsId/documents/:id/print', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
    const docRaw = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!docRaw) return res.status(404).send('Not found');
    let plainContent = enc.decryptIfNeeded(docRaw.content, req.workspace.id);
    plainContent = documentHtml.renderDocumentHtml(plainContent, {
      isMarkdown: looksLikeMarkdown(plainContent), markdownRenderer: mdRenderer
    });
    const doc = { ...docRaw, content: plainContent };
    res.render('document_print', { doc, ws: req.workspace });
  });

  app.get('/workspaces/:wsId/documents/:id/download', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\w]+/g,'_')}.md"`);
    res.send(enc.decryptIfNeeded(doc.content, req.workspace.id));
  });

  app.post('/workspaces/:wsId/documents/:id/delete', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.delete'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?')
      .get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    if (doc.status === 'withdrawn') return res.redirect('/workspaces/' + req.workspace.id + '/documents');
    const reason = String(req.body.reason || '').trim();
    if (!reason) {
      return res.status(422).render('error', {
        user: req.user,
        message: 'Explain why this controlled document is being withdrawn. The reason becomes part of its audit history.'
      });
    }
    if (reason.length > 2000) {
      return res.status(422).render('error', { user: req.user, message: 'Withdrawal reason must be 2,000 characters or fewer.' });
    }
    const history = {
      versions: db.prepare('SELECT COUNT(*) c FROM doc_versions WHERE document_id=?').get(doc.id).c,
      internal_approvers: db.prepare('SELECT COUNT(*) c FROM doc_approvers WHERE document_id=?').get(doc.id).c,
      external_approvers: db.prepare('SELECT COUNT(*) c FROM external_approvers WHERE document_id=?').get(doc.id).c,
      signatures: db.prepare('SELECT COUNT(*) c FROM doc_signatures WHERE document_id=?').get(doc.id).c
    };
    db.transaction(() => {
      const updated = db.prepare(`UPDATE generated_docs
        SET status='withdrawn', locked=1, withdrawn_at=CURRENT_TIMESTAMP,
            withdrawn_by=?, withdrawal_reason=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND workspace_id=? AND status!='withdrawn'`)
        .run(req.user.id, reason, doc.id, req.workspace.id);
      if (updated.changes !== 1) throw new Error('Document was already changed; reload and try again.');
      logAction(req.user.id, req.workspace.id, 'withdraw_document', 'document', doc.id,
        { reason, previous_status: doc.status, previous_version: doc.version, history },
        { ...auditCtx(req), before: { name: doc.name, status: doc.status, version: doc.version },
          after: { name: doc.name, status: 'withdrawn', version: doc.version }, strict: true });
    })();
    fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'document', entityId: req.params.id });
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents', 'Document withdrawn; governed history and audit evidence were retained.'));
  });

  // ==================== POLICY ACKNOWLEDGEMENTS (clause 7.3) ====================
  // lib/doc-acknowledgements.js. Links are shown once, straight after they are
  // issued, and emailed where the person has an address and email is set up.
  const ackEmail = require('../lib/email');
  const acks = require('../lib/doc-acknowledgements');
  const ackUrl = (req, token) => `${req.protocol}://${req.get('host')}/ack/${token}`;
  const sendAckEmails = (req, doc, versionNumber, campaignId, links, dueDate) => {
    for (const link of links) {
      if (!link.email) continue;
      ackEmail.sendAcknowledgementEmail({
        toEmail: link.email, toName: link.name, documentName: doc.name, versionNumber,
        workspaceName: req.workspace.brand_display_name || req.workspace.client_name, workspaceId: req.workspace.id,
        firmId: req.workspace.firm_id, token: link.token, dueDate, campaignId,
      }).catch(() => {});
    }
  };

  app.get('/workspaces/:wsId/documents/:id/acknowledgements', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    const published = db.prepare(`SELECT id, version FROM doc_versions WHERE document_id=? AND workspace_id=? AND status='published' ORDER BY version DESC LIMIT 1`).get(doc.id, req.workspace.id);
    const issued = (req.session && req.session.ackLinks && Number(req.session.ackLinks.documentId) === doc.id) ? req.session.ackLinks.links : [];
    if (req.session) delete req.session.ackLinks;
    const members = db.prepare(`SELECT u.name, u.email FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.active=1 ORDER BY u.name`).all(req.workspace.id);
    res.render('document_acknowledgements', { user: req.user, ws: req.workspace, doc, published, campaigns: acks.campaigns(db, req.workspace, doc.id),
      issued: issued.map(l => ({ ...l, url: ackUrl(req, l.token) })), members });
  });

  app.post('/workspaces/:wsId/documents/:id/acknowledgements', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/documents/${req.params.id}/acknowledgements`;
    try {
      const { doc } = { doc: db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id) };
      const result = acks.create(db, req.workspace, req.user.id, Number(req.params.id), req.body);
      const version = db.prepare('SELECT v.version FROM doc_ack_campaigns c JOIN doc_versions v ON v.id=c.version_id WHERE c.id=?').get(result.id).version;
      sendAckEmails(req, doc, version, result.id, result.links, req.body.due_date || null);
      if (req.session) req.session.ackLinks = { documentId: Number(req.params.id), links: result.links };
      logAction(req.user.id, req.workspace.id, 'create_doc_ack_campaign', 'document', Number(req.params.id), { campaign_id: result.id, recipients: result.links.length }, auditCtx(req));
      return res.redirect(withToast(back, `Acknowledgement requested from ${result.links.length} ${result.links.length === 1 ? 'person' : 'people'}`));
    } catch (e) {
      if (e instanceof acks.AckError) return res.redirect(withToast(back, e.message, 'error'));
      throw e;
    }
  });

  app.post('/workspaces/:wsId/documents/:id/acknowledgements/recipients/:rid/reissue', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const back = `/workspaces/${req.workspace.id}/documents/${req.params.id}/acknowledgements`;
    try {
      const link = acks.reissue(db, req.workspace, Number(req.params.rid));
      const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
      const version = db.prepare('SELECT v.version FROM doc_ack_campaigns c JOIN doc_versions v ON v.id=c.version_id WHERE c.id=?').get(link.campaignId).version;
      sendAckEmails(req, doc, version, link.campaignId, [link], null);
      if (req.session) req.session.ackLinks = { documentId: Number(req.params.id), links: [link] };
      logAction(req.user.id, req.workspace.id, 'reissue_doc_ack_link', 'document', Number(req.params.id), { recipient_id: Number(req.params.rid) }, auditCtx(req));
      return res.redirect(withToast(back, `New link issued for ${link.name}`));
    } catch (e) {
      if (e instanceof acks.AckError) return res.redirect(withToast(back, e.message, 'error'));
      throw e;
    }
  });

  app.post('/workspaces/:wsId/documents/:id/acknowledgements/:cid/close', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    acks.close(db, req.workspace, Number(req.params.cid));
    logAction(req.user.id, req.workspace.id, 'close_doc_ack_campaign', 'document', Number(req.params.id), { campaign_id: Number(req.params.cid) }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/documents/${req.params.id}/acknowledgements`, 'Campaign closed'));
  });

  // The recipient's own page: no account; the link is the credential.
  app.get('/ack/:token', (req, res) => {
    const found = acks.byToken(db, req.params.token);
    if (!found) return res.status(404).render('public_ack', { state: 'invalid', found: null, html: '' });
    const state = found.recipient.acknowledged_at ? 'done' : (found.recipient.campaign_status !== 'active' ? 'closed' : 'open');
    const body = enc.decryptIfNeeded(found.version.content || '', found.recipient.workspace_id);
    const html = documentHtml.renderDocumentHtml(body, { isMarkdown: looksLikeMarkdown(body), markdownRenderer: mdRenderer });
    res.render('public_ack', { state, found, html, token: req.params.token });
  });

  app.post('/ack/:token', (req, res) => {
    try {
      const found = acks.acknowledge(db, req.params.token, { ip: req.ip, userAgent: req.get('user-agent') });
      logAction(0, found.recipient.workspace_id, 'acknowledge_document', 'doc_ack_recipient', found.recipient.id,
        { campaign_id: found.recipient.campaign_id, version_id: found.version.id }, { ip: req.ip || '', userAgent: (req.get('user-agent') || '').slice(0, 200) });
      return res.redirect(`/ack/${req.params.token}`);
    } catch (e) {
      if (e instanceof acks.AckError) return res.status(e.status).render('public_ack', { state: e.status === 410 ? 'closed' : 'invalid', found: null, html: '' });
      throw e;
    }
  });

  // How long a document is kept once superseded (clause 7.5).
  app.post('/workspaces/:wsId/documents/:id/retention', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const doc = db.prepare('SELECT id, retention_period FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    const period = String(req.body.retention_period || '').trim().slice(0, 200) || null;
    db.prepare('UPDATE generated_docs SET retention_period=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?').run(period, doc.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'set_doc_retention', 'document', doc.id, { from: doc.retention_period || null, to: period }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/documents/${doc.id}`, 'Retention saved'));
  });

  // Snooze a document's review date by N days. Used by the overdue/due-soon
  // banner on /documents and the per-row action on /policy-adoption. Records
  // who snoozed and why in audit log.
  app.post('/workspaces/:wsId/documents/:id/snooze-review', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.edit'), (req, res) => {
    const days = parseInt(req.body.days, 10) || 30;
    if (![14, 30, 60, 90, 180].includes(days)) return res.status(400).send('Bad snooze period');
    const doc = db.prepare(`SELECT id, next_review_date FROM generated_docs WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    // Push the review date forward from today (not from the existing date, which
    // may already be in the past). A snooze should mean "give me N days from
    // now to actually do the review."
    const newDate = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    db.prepare(`UPDATE generated_docs SET next_review_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`)
      .run(newDate, doc.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'snooze_doc_review', 'document', doc.id,
      { old_date: doc.next_review_date, new_date: newDate, days, reason: req.body.reason || null }, auditCtx(req));
    const back = req.headers.referer || `/workspaces/${req.workspace.id}/documents`;
    res.redirect(back);
  });

  // ==================== GOVERNANCE ====================

  // ==================== DOCUMENT VERSIONING + APPROVAL + E-SIG ====================
  // Race-safe: MAX(version) → INSERT → UPDATE current_version_id all run in
  // one transaction so two consultants clicking "Submit for review" at the
  // same time can't end up with two version=N rows (which the UNIQUE
  // (document_id, version) constraint would catch as an unhandled 500).
  // On a constraint collision (the other transaction beat us), retry once;
  // after the second failure surface a clean error rather than a 500.
  // Document version + signature helpers live in lib/doc-versions.js (shared
  // with routes/documents.js and the audit-pack zip below).
  const { snapshotDocVersion, listVersions, listApprovers, listSignatures, verifyVersionSignatures } = require('../lib/doc-versions');

  // List version-specific document detail view (shows version chain, approvers, sigs)
  app.get('/workspaces/:wsId/documents/:id/versions', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    const versions = listVersions(doc.id);
    const versionsWithDetail = versions.map(v => ({
      ...v,
      approvers: listApprovers(doc.id, v.id),
      signatures: listSignatures(doc.id, v.id),
      signatureIssues: verifyVersionSignatures(v, listSignatures(doc.id, v.id), req.workspace.id)
    }));
    res.render('document_versions', { user: req.user, ws: req.workspace, doc, versions: versionsWithDetail });
  });

  // Compare two versions side-by-side (line-level diff).
  app.get('/workspaces/:wsId/documents/:id/diff', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return res.status(404).send('Not found');
    const a = parseInt(req.query.a || 0, 10);
    const b = parseInt(req.query.b || 0, 10);
    const va = a ? db.prepare('SELECT * FROM doc_versions WHERE id=? AND document_id=?').get(a, doc.id) : null;
    const vb = b ? db.prepare('SELECT * FROM doc_versions WHERE id=? AND document_id=?').get(b, doc.id) : null;
    const all = listVersions(doc.id);
    const diff = (va && vb) ? simpleLineDiff(
      enc.decryptIfNeeded(va.content, req.workspace.id),
      enc.decryptIfNeeded(vb.content, req.workspace.id)
    ) : null;
    res.render('document_diff', { user: req.user, ws: req.workspace, doc, va, vb, diff, all });
  });

  function simpleLineDiff(a, b) {
    const A = (a || '').split('\n');
    const B = (b || '').split('\n');
    // Longest-common-subsequence-driven line diff (small files, O(NM) is fine).
    const N = A.length, M = B.length;
    const dp = Array.from({ length: N + 1 }, () => new Int32Array(M + 1));
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    }
    const out = [];
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (A[i] === B[j]) { out.push({ k: 'eq', a: A[i], b: B[j] }); i++; j++; }
      else if (dp[i+1][j] >= dp[i][j+1]) { out.push({ k: 'del', a: A[i] }); i++; }
      else { out.push({ k: 'add', b: B[j] }); j++; }
    }
    while (i < N) { out.push({ k: 'del', a: A[i++] }); }
    while (j < M) { out.push({ k: 'add', b: B[j++] }); }
    return out;
  }

  // Submit current draft for review - snapshots a new version, sets approver chain.
  // The chain can mix internal (user-account) approvers and external (magic-link)
  // approvers. Form sends approvers_json containing the ordered chain.
  app.post('/workspaces/:wsId/documents/:id/submit-review', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.submit_review'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    if (doc.locked) return res.status(400).render('error', { user: req.user, message: 'Document is locked. Create a new version first.' });

    let chain;
    try {
      chain = JSON.parse(req.body.approvers_json || '[]');
    } catch (_) {
      return res.status(400).render('error', { user: req.user, message: 'Could not parse approver chain. Try resubmitting from the form.' });
    }
    if (!Array.isArray(chain) || chain.length === 0) {
      return res.status(400).render('error', { user: req.user, message: 'Add at least one approver before submitting for review.' });
    }
    // Validate each row
    const seenInternal = new Set();
    for (let i = 0; i < chain.length; i++) {
      const r = chain[i];
      if (r.kind === 'internal') {
        if (!r.user_id || isNaN(parseInt(r.user_id, 10))) {
          return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: pick a user.` });
        }
        // AUTHZ-005: the only prior check was "is this a number", so any user id
        // in the system could be inserted as an internal approver of any
        // document, including a client from a different workspace or firm, who
        // was then notified and could act. Verify eligibility before any write.
        const uid = parseInt(r.user_id, 10);
        if (seenInternal.has(uid)) {
          return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: that person is already in the chain.` });
        }
        seenInternal.add(uid);
        const elig = approverEligibility(uid, req.workspace);
        if (!elig.ok) {
          return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: ${elig.reason}` });
        }
      } else if (r.kind === 'external') {
        if (!r.name || !r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
          return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: name and a valid email are required for magic-link approvers.` });
        }
      } else {
        return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: unknown kind "${r.kind}".` });
      }
    }

    const summary = req.body.change_summary || null;

    const insInternal = db.prepare(`INSERT INTO doc_approvers (workspace_id, document_id, version_id, sequence, user_id, role_label, notified_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    const insExternal = db.prepare(`INSERT INTO external_approvers
      (workspace_id, document_id, version_id, sequence, email, name, role_label, token_hash, expires_at, notified_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`);

    // Per-row token storage - we keep the raw tokens in memory just long
    // enough to send the emails after the transaction commits. They're
    // never written to the DB in raw form.
    const rawTokens = {};
    // AUTHZ-005: snapshot, lock, version stamp and approver rows must all
    // commit together. Previously the document was snapshotted and locked
    // before the approver inserts, so a failure mid-chain left a locked
    // in_review document with a partial approval chain.
    let v;
    const tx = db.transaction(() => {
      v = snapshotDocVersion(doc.id, req.workspace.id, 'in_review', req.user.id, summary);
      db.prepare(`UPDATE generated_docs SET status='in_review', locked=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
      db.prepare(`UPDATE doc_versions SET submitted_at=CURRENT_TIMESTAMP WHERE id=?`).run(v.id);
      chain.forEach((r, idx) => {
        const seq = idx + 1;
        if (r.kind === 'internal') {
          insInternal.run(req.workspace.id, doc.id, v.id, seq, parseInt(r.user_id, 10), r.role || null);
        } else {
          const token = docApprovals.generateToken();
          const hash = docApprovals.hashToken(token);
          const expires = docApprovals.expiryFromNow();
          insExternal.run(req.workspace.id, doc.id, v.id, seq, r.email.trim(), r.name.trim(), r.role || null, hash, expires, req.user.id);
          rawTokens[seq] = token;
        }
      });
      logAction(req.user.id, req.workspace.id, 'submit_for_review', 'document', doc.id,
        { version: v.version, approvers: chain.length,
          internal: chain.filter(c => c.kind === 'internal').length,
          external: chain.filter(c => c.kind === 'external').length, summary },
        { ...auditCtx(req), strict: true });
      if(docApprovals.nextPending(db,v.id)?.kind==='internal')notifyChainAdvanced(v.id,doc,req.workspace,req.user.name,true);
    });
    try {
      tx();
    } catch (e) {
      if (e && e.code === 'DOC_VERSION_CONFLICT') {
        return res.status(409).render('error', { user: req.user,
          message: 'Another consultant submitted this document for review at the same time. Open the document, review the new version, and decide whether to add another reviewer.' });
      }
      throw e;
    }

    // Notify only the first approver in sequence (the one whose turn it
    // is right now); later approvers get nudged as the chain advances in
    // the /decide and /approve routes. Internal approvers get a "view
    // document" link; external approvers get the magic-link URL.
    try {
      const merged = docApprovals.listChain(db, v.id);
      const wsName = req.workspace.client_name;
      const submitter = req.user.name;
      const docUrl = `${email.appBaseUrl()}/workspaces/${req.workspace.id}/documents/${doc.id}`;
      const total = merged.length;

      merged.forEach((row, idx) => {
        const isFirst = idx === 0;
        if (row.kind === 'internal') {
          // The first internal recipient is recorded atomically in the outbox.
          // Later approvers are notified when the chain reaches their step.
          return;
        } else {
          // External - send the magic link only on the first approver's
          // turn. Later external approvers get nudged when their turn
          // arrives so the token doesn't sit in their inbox unused.
          if (!isFirst) return;
          const expiresAt = db.prepare('SELECT expires_at FROM external_approvers WHERE id=?').get(row.id).expires_at;
          email.sendMagicLinkApprovalEmail({
            toEmail: row.person_email, toName: row.person_name,
            docName: doc.name, docVersion: v.version,
            workspaceName: wsName, workspaceId: req.workspace.id, firmId: req.workspace.firm_id,
            submitterName: submitter, token: rawTokens[row.sequence],
            sequence: row.sequence, totalApprovers: total, roleLabel: row.role_label,
            expiresAt, changeSummary: summary, relatedDocId: doc.id
          }).catch(err => console.error('[email] external-approver send failed:', err.message));
        }
      });
    } catch (e) {
      console.error('[email] approval-request batch failed:', e.message);
    }

    res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, 'Submitted for review'));
  });

  // Approver makes a decision (approve / reject) on the current version.
  // Shared post-decision helpers - called from both the internal decide
  // route (POST /workspaces/.../decide) and the external token route
  // (POST /approve/:token). Keep these here so server.js owns the
  // chain-advance + completion side-effects in one place.

  function notifyChainAdvanced(versionId, doc, workspace, decidedByDisplay, initial=false) {
    const next = docApprovals.nextPending(db, versionId);
    if (!next) return; // chain complete - completion handler runs separately
    const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
    const wsName = workspace.client_name;
    const docUrl = `${email.appBaseUrl()}/workspaces/${workspace.id}/documents/${doc.id}`;

    if (next.kind === 'internal') {
      const recipient=db.prepare('SELECT user_type FROM users WHERE id=?').get(next.row.user_id);
      collaborationNotifications.enqueue(db,{workspaceId:workspace.id,recipientIds:[next.row.user_id],eventKey:`policy:${versionId}:approver:${next.row.id}`,sourceType:'policy',sourceId:doc.id,
        title:`Policy approval required: ${doc.name}`,body:`${decidedByDisplay} ${initial?'submitted this policy for approval':'completed the previous step'}. Review version ${version.version} as approver ${next.row.sequence}.`,
        link:`/workspaces/${workspace.id}/${recipient?.user_type==='client'?'client-portal/policies':'documents'}/${doc.id}`});
    } else {
      // External next - rotate the token (the old one was either never
      // delivered or has been sitting in their inbox for days) and send
      // a fresh magic link. Old hash is overwritten so the previous URL
      // immediately becomes invalid.
      const token = docApprovals.generateToken();
      const hash = docApprovals.hashToken(token);
      const expires = docApprovals.expiryFromNow();
      db.prepare(`UPDATE external_approvers SET token_hash=?, expires_at=?, notified_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(hash, expires, next.row.id);
      const totalApprovers = docApprovals.listChain(db, versionId).length;
      email.sendMagicLinkApprovalEmail({
        toEmail: next.row.person_email, toName: next.row.person_name,
        docName: doc.name, docVersion: version.version,
        workspaceName: wsName, workspaceId: workspace.id, firmId: workspace.firm_id,
        submitterName: decidedByDisplay, token,
        sequence: next.row.sequence, totalApprovers, roleLabel: next.row.role_label,
        expiresAt: expires, changeSummary: version.change_summary, relatedDocId: doc.id
      }).catch(err => console.error('[email] next-external notify failed:', err.message));
    }
  }

  function notifyDocumentAuthor(versionId,doc,workspace,event,title,body){
    const version=db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
    if(!version)return;
    const author=db.prepare('SELECT id,user_type FROM users WHERE id=?').get(version.created_by);
    if(!author)return;
    collaborationNotifications.enqueue(db,{workspaceId:workspace.id,recipientIds:[author.id],eventKey:`policy:${versionId}:${event}`,sourceType:'policy',sourceId:doc.id,title,body,
      link:`/workspaces/${workspace.id}/${author.user_type==='client'?'client-portal/policies':'documents'}/${doc.id}`});
  }
  function notifyChainComplete(versionId,doc,workspace,decidedByDisplay){
    notifyDocumentAuthor(versionId,doc,workspace,'approved',`Policy approved: ${doc.name}`,`${decidedByDisplay} completed the approval chain. The approved version is ready for the publisher.`);
  }
  function notifyRejection(versionId,doc,workspace,rejectorDisplay,reason){
    notifyDocumentAuthor(versionId,doc,workspace,'changes',`Changes requested: ${doc.name}`,`${rejectorDisplay} requested changes. ${reason||''}`);
  }

  // Mark the version + document as approved (called from both decide
  // routes when countPending hits zero). Keep this side-effect in one
  // place so we can't drift between the internal and external paths.
  //
  // CAS on doc_versions.status: only the first call whose UPDATE matches
  // status='in_review' succeeds. Returns true if this call was the one that
  // finalised, false if another concurrent decision beat us. Callers should
  // only fire chain-complete notifications / log entries when this returns
  // true, otherwise two simultaneous final approvers double-send the emails
  // and double-log "approve_document".
  function finaliseApprovedDocument(versionId, doc, workspaceId, byUserId) {
    const r = db.prepare(`UPDATE doc_versions SET status='approved', approved_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='in_review'`).run(versionId);
    if (r.changes === 0) return false;
    db.prepare(`UPDATE generated_docs SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, locked=1 WHERE id=?`)
      .run(byUserId, doc.id);
    return true;
  }

  // Documents whose version in review is waiting on this user as the next
  // internal approver. A version the user prepared is marked, since it is
  // never approved in bulk.
  function awaitingApprovalBy(workspace, user) {
    return db.prepare(`SELECT d.id, d.name, d.category, v.id AS version_id, v.version, v.submitted_at, v.created_by, u.name AS prepared_by
      FROM generated_docs d JOIN doc_versions v ON v.id = d.current_version_id AND v.workspace_id = d.workspace_id
      LEFT JOIN users u ON u.id = v.created_by
      JOIN doc_approvers a ON a.version_id = v.id AND a.user_id = ? AND a.decision IS NULL
      WHERE d.workspace_id = ? AND v.status = 'in_review' ORDER BY v.submitted_at, d.name`).all(user.id, workspace.id)
      .filter((d) => { const next = docApprovals.nextPending(db, d.version_id); return next && next.kind === 'internal' && Number(next.row.user_id) === Number(user.id); })
      .map((d) => ({ ...d, ownWork: Number(d.created_by) === Number(user.id) }));
  }

  function finaliseRejectedDocument(versionId, doc) {
    const r = db.prepare(`UPDATE doc_versions SET status='rejected'
      WHERE id=? AND status='in_review'`).run(versionId);
    if (r.changes === 0) return false;
    db.prepare(`UPDATE generated_docs SET status='draft', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    return true;
  }

  app.post('/workspaces/:wsId/documents/:id/decide', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.review'), (req, res) => {
    const initial=db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id,req.workspace.id);
    const decisionBack=req.user.user_type==='client'?`/workspaces/${req.workspace.id}/client-portal/policies/${req.params.id}`:`/workspaces/${req.workspace.id}/documents/${req.params.id}`;
    if(!initial?.current_version_id)return res.redirect(decisionBack);
    let effectiveBody=req.body,externalAdvance=null;
    try{
      const contextKey=String(req.body.expected_version_id ?? initial.current_version_id);
      const result=personalDrafts.commit(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'policy-decision',recordId:String(initial.id),contextKey,encryptionEnabled:!!req.workspace.encryption_enabled},req.body,input=>{
        effectiveBody=input;
        const doc=db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(initial.id,req.workspace.id);
        const expected=input.expected_record_version ?? input.expected_version_id;
        if(expected!=null&&String(expected)!==String(doc.current_version_id))throw personalDrafts.failure('The policy version changed. Review the latest version before deciding. Your note is retained.');
        const myRow=db.prepare('SELECT * FROM doc_approvers WHERE version_id=? AND user_id=? AND decision IS NULL ORDER BY sequence LIMIT 1').get(doc.current_version_id,req.user.id);
        if(!myRow)throw personalDrafts.failure('You are not a pending approver on this version.',403);
        const upNext=docApprovals.nextPending(db,doc.current_version_id);
        if(!upNext||upNext.kind!=='internal'||upNext.row.id!==myRow.id)throw personalDrafts.failure(`Approver #${upNext?upNext.row.sequence:'?'} must decide first.`,400);
        const version=db.prepare('SELECT status FROM doc_versions WHERE id=? AND workspace_id=?').get(doc.current_version_id,req.workspace.id);
        if(version?.status!=='in_review')throw personalDrafts.failure('This version is no longer open for approval. Review the latest policy status.');
        const validation=docApprovals.validateDecision(input.decision,input.reason);
        if(!validation.ok)throw personalDrafts.failure(input.decision==='reject'&&!String(input.reason||'').trim()?'Explain what must change so the author can respond.':validation.error,422);
        const reason=validation.reason,decision=input.decision;
        const decResult=db.prepare(`UPDATE doc_approvers SET decision=?,decision_reason=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND decision IS NULL`)
          .run(decision==='approve'?'approved':'rejected',reason||null,myRow.id);
        if(!decResult.changes)return {url:withToast(decisionBack,'Your decision was already recorded.','info')};
        if(decision==='reject'){
          if(finaliseRejectedDocument(doc.current_version_id,doc)){
            logAction(req.user.id,req.workspace.id,'reject_document','document',doc.id,{version_id:doc.current_version_id,reason},auditCtx(req));
            notifyRejection(doc.current_version_id,doc,req.workspace,req.user.name,reason);
          }
          return {url:withToast(decisionBack,'Changes requested. The author can update and resubmit this policy.','info')};
        }
        if(docApprovals.countPending(db,doc.current_version_id)===0){
          if(finaliseApprovedDocument(doc.current_version_id,doc,req.workspace.id,req.user.id)){
            logAction(req.user.id,req.workspace.id,'approve_document','document',doc.id,{version_id:doc.current_version_id},auditCtx(req));
            notifyChainComplete(doc.current_version_id,doc,req.workspace,req.user.name);
          }
        }else{
          logAction(req.user.id,req.workspace.id,'partial_approve_document','document',doc.id,{version_id:doc.current_version_id,remaining:docApprovals.countPending(db,doc.current_version_id)},auditCtx(req));
          if(docApprovals.nextPending(db,doc.current_version_id)?.kind==='external')externalAdvance={versionId:doc.current_version_id,doc};
          else notifyChainAdvanced(doc.current_version_id,doc,req.workspace,req.user.name);
        }
        return {url:withToast(decisionBack,'Your approval has been recorded.')};
      });
      // External magic-link issuance has its own token lifecycle; never send
      // before the decision commits, or again on an idempotent replay.
      if(externalAdvance)notifyChainAdvanced(externalAdvance.versionId,externalAdvance.doc,req.workspace,req.user.name);
      return res.redirect(result.url);
    }catch(error){
      const current=db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(initial.id,req.workspace.id);
      const stillNamed=current&&db.prepare('SELECT 1 FROM doc_approvers WHERE workspace_id=? AND document_id=? AND version_id=? AND user_id=?').get(req.workspace.id,current.id,current.current_version_id,req.user.id);
      if(req.user.user_type==='client'&&stillNamed)return require('../lib/client-policy-view').render(db,req,res,current,{status:error.status||400,error:error.message,reason:effectiveBody.reason});
      return res.status(error.status||400).render('error',{user:req.user,ws:req.workspace,message:error.message});
    }
  });

  // ==================== MAGIC-LINK APPROVAL PORTAL ====================
  // External approver clicks the link in their email -> arrives here.
  // No auth; the token IS the credential. Token is in the URL, not stored
  // raw in the DB; we look up by SHA-256 hash. All decisions audit-log
  // via the external sentinel user (id=0) which resolves to
  // external@isms.local in the activity stream.

  function renderExternalApproval(req, res, row, { status = 200, decisionError = null } = {}) {
    const myTurn = docApprovals.isExternalRowMyTurn(db, row);
    const chain = docApprovals.listChain(db, row.version_id);
    let bodyRaw = row.content;
    try { bodyRaw = enc.decryptIfNeeded(bodyRaw, row.workspace_id); } catch (_) {}
    const bodyHtml = documentHtml.renderDocumentHtml(bodyRaw, {
      isMarkdown: looksLikeMarkdown(bodyRaw), markdownRenderer: mdRenderer
    });
    return res.status(status).render('approve', {
      row, chain, myTurn, decisionError,
      workspaceName: row.workspace_name,
      docName: row.doc_name,
      docVersion: row.version,
      docContent: bodyHtml,
      submitterName: row.submitter_name,
      brandColor: row.brand_primary_color || '#1a1a1a',
      token: req.params.token,
      csrfToken: '' // route is CSRF-skipped (token is the credential)
    });
  }

  app.get('/approve/:token', (req, res) => {
    const row = docApprovals.findByToken(db, req.params.token);
    if (!row) {
      return res.status(404).render('approve_error', {
        title: 'Approval link not found',
        message: 'This approval link is not valid. It may have been revoked or replaced. Ask the person who sent it to issue a new one.'
      });
    }
    if (rejectGapOnlyExternalApproval(res, row)) return;
    if (row.effective_status === 'revoked') {
      return res.status(410).render('approve_error', {
        title: 'Approval link revoked',
        message: 'This approval link has been revoked by the workspace owner. Ask them to re-issue if you still need to decide.'
      });
    }
    if (row.effective_status === 'expired') {
      return res.status(410).render('approve_error', {
        title: 'Approval link expired',
        message: 'This approval link expired on ' + new Date(row.expires_at).toLocaleDateString() + '. Ask the sender to issue a new one.'
      });
    }
    if (row.decision) {
      return res.status(410).render('approve_error', {
        title: 'Already decided',
        message: 'You already ' + row.decision + ' this document on ' + new Date(row.decided_at + 'Z').toLocaleString() + '. The decision is recorded; the link is no longer active.'
      });
    }
    return renderExternalApproval(req, res, row);
  });

  app.post('/approve/:token', (req, res) => {
    const row = docApprovals.findByToken(db, req.params.token);
    if (!row || row.effective_status !== 'pending') {
      return res.status(410).render('approve_error', {
        title: 'Link no longer active',
        message: 'This approval link is no longer valid (expired, revoked, or already decided).'
      });
    }
    if (rejectGapOnlyExternalApproval(res, row)) return;
    const { decision } = req.body;
    const validation = docApprovals.validateDecision(decision, req.body.reason);
    if (!validation.ok) {
      return renderExternalApproval(req, res, row, { status: 422, decisionError: validation.error });
    }
    const reason = validation.reason;
    if (!docApprovals.isExternalRowMyTurn(db, row)) {
      return res.status(400).render('approve_error', {
        title: 'Not your turn yet',
        message: 'An earlier approver in the chain has not decided yet. You will be able to approve once they do.'
      });
    }

    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
    const ua = (req.get('user-agent') || '').slice(0, 500) || null;
    const decisionVal = decision === 'approve' ? 'approved' : 'rejected';

    // CAS: only the first attempt that finds decision IS NULL writes. Defends
    // against double-clicks on the approve button (browser/network retries
    // re-POSTing the same token) and against the rare case where two browser
    // tabs of the same magic link decide simultaneously.
    const decResult = db.prepare(`UPDATE external_approvers
      SET decision=?, decision_reason=?, decided_at=CURRENT_TIMESTAMP, ip_address=?, user_agent=?
      WHERE id=? AND decision IS NULL`).run(decisionVal, reason, ip, ua, row.id);
    if (decResult.changes === 0) {
      return res.status(410).render('approve_error', {
        title: 'Already decided',
        message: 'This approval was already recorded. Nothing further to do.'
      });
    }

    // Capture a signature row for parity with internal approvers - same
    // table, HMAC-signed, name shows as the external approver's display
    // name. user_id has a FK to users; we resolve to the external@isms.local
    // sentinel that logAction creates on demand. Re-using the same sentinel
    // means the audit pack groups all external activity under one synthetic
    // user instead of leaving orphan rows.
    try {
      let extUser = db.prepare(`SELECT id FROM users WHERE email='external@isms.local'`).get();
      if (!extUser) {
        const uid = db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active)
                                VALUES ('external@isms.local','!external','External signer','client',0)`).run().lastInsertRowid;
        extUser = { id: uid };
      }
      const ts = new Date().toISOString();
      // Payload format must mirror verifyVersionSignatures() above, which
      // reads back ${s.document_id}|${s.version_id}|${s.user_id}|... -
      // use extUser.id (the sentinel's int) as the third slot, not the
      // external_approvers row id. Mismatch here corrupts the HMAC and
      // every doc page renders a SIGNATURE INTEGRITY WARNING for what
      // is in fact a legitimate approval.
      const payload = `${row.doc_id}|${row.version_id}|${extUser.id}|${row.content_hash}|${decisionVal}|${ts}`;
      const sig = enc.signHmac(payload, row.workspace_id);
      db.prepare(`INSERT INTO doc_signatures (workspace_id, document_id, version_id, user_id, user_name, signature_role, intent, content_hash, signature, ip_address, user_agent, signed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.workspace_id, row.doc_id, row.version_id, extUser.id,
        `${row.name} (external)`,
        row.role_label || null, decisionVal, row.content_hash, sig,
        ip, ua, ts
      );
    } catch (e) { console.error('[approve] signature insert failed:', e.message); }

    logAction(0, row.workspace_id, decisionVal === 'approved' ? 'external_approve_document' : 'external_reject_document',
      'document', row.doc_id, { version_id: row.version_id, external_approver: row.name, email: row.email, reason },
      { ip, userAgent: ua });

    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=?').get(row.doc_id);
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(row.workspace_id);
    const display = `${row.name} (external)`;

    if (decision === 'reject') {
      if (finaliseRejectedDocument(row.version_id, doc)) {
        notifyRejection(row.version_id, doc, workspace, display, reason);
      }
    } else if (docApprovals.countPending(db, row.version_id) === 0) {
      // No internal user is "responsible" - record approved_by as the
      // version's submitter so the audit trail attributes the lock-down
      // to the human who initiated review, not user 0.
      // CAS via finaliseApprovedDocument: only the first finaliser fires
      // the chain-complete notification.
      const version = db.prepare('SELECT created_by FROM doc_versions WHERE id=?').get(row.version_id);
      if (finaliseApprovedDocument(row.version_id, doc, row.workspace_id, version ? version.created_by : 0)) {
        notifyChainComplete(row.version_id, doc, workspace, display);
      }
    } else {
      notifyChainAdvanced(row.version_id, doc, workspace, display);
    }

    res.render('approve_done', {
      decision: decisionVal,
      docName: row.doc_name,
      docVersion: row.version,
      workspaceName: row.workspace_name,
      brandColor: row.brand_primary_color || '#1a1a1a',
      approverName: row.name
    });
  });

  // Resend a magic link to an external approver. Rotates the token so
  // the previous link (if it's lying in the wrong inbox or a forgotten
  // browser tab) immediately stops working. Only the submitter / firm
  // can trigger this from the doc detail page.
  app.post('/workspaces/:wsId/documents/:id/external-approvers/:eaId/resend',
    requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.submit_review'), (req, res) => {
      const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
      if (!doc) return redirectBack(req, res);
      const ea = db.prepare('SELECT * FROM external_approvers WHERE id=? AND workspace_id=? AND document_id=?').get(req.params.eaId, req.workspace.id, doc.id);
      if (!ea) return redirectBack(req, res);
      if (ea.decision) return res.status(400).render('error', { user: req.user, message: 'Approver has already decided - nothing to resend.' });
      if (ea.revoked_at) return res.status(400).render('error', { user: req.user, message: 'Approver was revoked. Unrevoke is not supported - add them again as a new approver instead.' });

      const token = docApprovals.generateToken();
      const hash = docApprovals.hashToken(token);
      const expires = docApprovals.expiryFromNow();
      db.prepare(`UPDATE external_approvers SET token_hash=?, expires_at=?, notified_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(hash, expires, ea.id);

      const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(ea.version_id);
      const totalApprovers = docApprovals.listChain(db, ea.version_id).length;
      email.sendMagicLinkApprovalEmail({
        toEmail: ea.email, toName: ea.name,
        docName: doc.name, docVersion: version.version,
        workspaceName: req.workspace.client_name, workspaceId: req.workspace.id, firmId: req.workspace.firm_id,
        submitterName: req.user.name, token,
        sequence: ea.sequence, totalApprovers, roleLabel: ea.role_label,
        expiresAt: expires, changeSummary: version.change_summary, relatedDocId: doc.id
      }).catch(err => console.error('[email] resend magic link failed:', err.message));

      logAction(req.user.id, req.workspace.id, 'resend_external_approver_link', 'document', doc.id,
        { external_approver_id: ea.id, email: ea.email }, auditCtx(req));
      res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, `Magic link resent to ${ea.email}`));
    });

  // Revoke a pending external approver. Sets revoked_at; the next /approve
  // request with that (now-irrelevant) token will see effective_status =
  // 'revoked' and render an error. Does not remove the row - audit trail
  // requires we keep the history of who was invited.
  app.post('/workspaces/:wsId/documents/:id/external-approvers/:eaId/revoke',
    requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.submit_review'), (req, res) => {
      const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
      if (!doc) return redirectBack(req, res);
      const ea = db.prepare('SELECT * FROM external_approvers WHERE id=? AND workspace_id=? AND document_id=?').get(req.params.eaId, req.workspace.id, doc.id);
      if (!ea) return redirectBack(req, res);
      if (ea.decision) return res.status(400).render('error', { user: req.user, message: 'Approver has already decided - cannot revoke.' });
      if (ea.revoked_at) return redirectBack(req, res);

      db.prepare(`UPDATE external_approvers SET revoked_at=CURRENT_TIMESTAMP WHERE id=?`).run(ea.id);
      logAction(req.user.id, req.workspace.id, 'revoke_external_approver', 'document', doc.id,
        { external_approver_id: ea.id, email: ea.email }, auditCtx(req));
      res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, `Revoked ${ea.email} - link no longer works`));
    });

  // E-signature endpoint. Captures user's identity, hashes content, generates HMAC, stores ip/UA.
  app.post('/workspaces/:wsId/documents/:id/sign', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.sign'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc || !doc.current_version_id) return redirectBack(req, res);
    const { intent, signature_role, attestation } = req.body;
    if (!intent || !attestation) return res.status(400).render('error', { user: req.user, message: 'Sign-off requires an intent and explicit attestation.' });
    const v = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(doc.current_version_id);
    if (!v) return redirectBack(req, res);
    const ts = new Date().toISOString();
    const payload = `${doc.id}|${v.id}|${req.user.id}|${v.content_hash}|${intent}|${ts}`;
    const sig = enc.signHmac(payload, req.workspace.id);
    db.prepare(`INSERT INTO doc_signatures (workspace_id, document_id, version_id, user_id, user_name, signature_role, intent, content_hash, signature, ip_address, user_agent, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.workspace.id, doc.id, v.id, req.user.id, req.user.name,
      signature_role || null, intent, v.content_hash, sig,
      auditCtx(req).ip, auditCtx(req).userAgent, ts
    );
    logAction(req.user.id, req.workspace.id, 'sign_document', 'document', doc.id,
      { version: v.version, intent, signature_role }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id + '/versions', 'Signature recorded'));
  });

  // Publish an approved document.
  app.post('/workspaces/:wsId/documents/:id/publish', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.publish'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    if (doc.status !== 'approved') return res.status(400).render('error', { user: req.user, message: 'Only approved documents can be published.' });
    db.prepare(`UPDATE generated_docs SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
    logAction(req.user.id, req.workspace.id, 'publish_document', 'document', doc.id, { version_id: doc.current_version_id }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

  // Retire a published document.
  app.post('/workspaces/:wsId/documents/:id/retire', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.retire'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    db.prepare(`UPDATE generated_docs SET status='retired', retired_at=CURRENT_TIMESTAMP, locked=1 WHERE id=?`).run(doc.id);
    if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='retired', retired_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
    logAction(req.user.id, req.workspace.id, 'retire_document', 'document', doc.id, { reason: req.body.reason || null }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

  // Reopen for editing - creates a new draft version branched off current.
  app.post('/workspaces/:wsId/documents/:id/new-version', requireAuth, requireWorkspace, requireDocumentImplementation, requirePermission('document.edit'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    db.prepare(`UPDATE generated_docs SET status='draft', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    logAction(req.user.id, req.workspace.id, 'new_version', 'document', doc.id,
      { previous_version_id: doc.current_version_id }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

}

module.exports = { register, shared };
