'use strict';
// Documents domain. Slice 12 of the server.js modularization, two regions
// joined: (a) documents list/detail + template library, (b) versioning,
// approvals, e-signatures, and the magic-link approval portal.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const MarkdownIt = require('markdown-it');
const fts = require('../lib/fts');
const enc = require('../lib/encryption');
const email = require('../lib/email');
const docLinks = require('../lib/doc-links');
const ctlReads = require('../lib/control-reads');
const docApprovals = require('../lib/doc-approvals');
const { looksLikeMarkdown } = require('../lib/docx-gen');
const { snapshotDocVersion, listVersions, listApprovers, listSignatures, verifyVersionSignatures } = require('../lib/doc-versions');
const { paginate, pageHref } = require('../lib/paginate');
const { withToast, redirectBack, auditCtx, escapeHtml, parseFormArray } = require('../lib/http-helpers');

const mdRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          upload, resolveUploadPath, isFirmUser, diffObjects } = deps;

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
      count: `SELECT COUNT(*) c FROM generated_docs d WHERE d.workspace_id = ? ${docFilterClause}`,
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
      WHERE d.workspace_id = ? ${docFilterClause}
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
      WHERE d.workspace_id = ? ORDER BY i.sort_order`).all(req.workspace.id);

    const templates = db.prepare(`SELECT * FROM doc_templates
      WHERE is_system = 1 OR firm_id = ? ORDER BY category, name`).all(req.workspace.firm_id);

    // Registers row used to surface "interested parties register" here;
    // removed alongside the dedicated parties module. Left as an empty
    // array so the view's <% registers.forEach %> stays harmless.
    const registers = [];

    res.render('documents', {
      user: req.user, ws: req.workspace, docs, templates,
      tagsByDoc, taggedItems, tagFilter, registers,
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

  app.get('/workspaces/:wsId/templates', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
    const templates = db.prepare(`SELECT id, name, category, description, tier, controls, clauses
      FROM doc_templates
      WHERE is_system=1 OR firm_id=?
      ORDER BY name`).all(req.workspace.firm_id);

    const adoptedRows = db.prepare(`SELECT template_id, MIN(id) AS doc_id, COUNT(*) AS n
      FROM generated_docs WHERE workspace_id=? AND template_id IS NOT NULL
      GROUP BY template_id`).all(req.workspace.id);
    const adoptedByTpl = {};
    adoptedRows.forEach(r => { adoptedByTpl[r.template_id] = r; });

    // Parse refs and decorate. Sort: mandatory first, then alpha within tier.
    const enriched = templates.map(t => {
      let controls = []; try { controls = JSON.parse(t.controls || '[]'); } catch (_) {}
      let clauses  = []; try { clauses  = JSON.parse(t.clauses  || '[]'); } catch (_) {}
      return { ...t, controls, clauses, adopted: adoptedByTpl[t.id] || null };
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
      templates: enriched, counts
    });
  });

  app.get('/workspaces/:wsId/templates/:id(\\d+)', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
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
      WHERE workspace_id=? AND template_id=? ORDER BY id DESC LIMIT 1`)
      .get(req.workspace.id, tpl.id);

    // Render the template body with workspace context substituted, then pass the
    // HTML to the view. EJS templates can't require() the markdown renderer, so
    // we do the markdown → HTML pass here and ship the result through.
    const sample = (tpl.content || '')
      .replace(/{{client_name}}/g, req.workspace.client_name)
      .replace(/{{scope}}/g, req.workspace.scope || (req.workspace.client_name + ' information assets'))
      .replace(/{{date}}/g, new Date().toISOString().slice(0,10))
      .replace(/{{firm_name}}/g, '[Firm name]')
      .replace(/{{document_owner}}/g, 'CISO')
      .replace(/{{approval_authority}}/g, 'Top Management')
      .replace(/{{review_period}}/g, 'Annual')
      .replace(/{{industry}}/g, req.workspace.industry || '');
    const previewHtml = mdRenderer.render(sample);

    res.render('template_detail', {
      user: req.user, ws: req.workspace,
      tpl, controls, clauses, isoLookup, existing, previewHtml
    });
  });

  app.post('/workspaces/:wsId/templates/adopt-mandatory', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
    // Bulk-adopt every mandatory template that isn't already in this workspace.
    // Stops short of expected/recommended so the consultant isn't drowned in
    // 74 documents to review.
    const adopted = db.prepare(`SELECT template_id FROM generated_docs
      WHERE workspace_id=? AND template_id IS NOT NULL`).all(req.workspace.id);
    const adoptedSet = new Set(adopted.map(r => r.template_id));
    const toAdopt = db.prepare(`SELECT * FROM doc_templates
      WHERE is_system=1 AND tier='mandatory' ORDER BY name`).all()
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
    res.redirect(withToast(`/workspaces/${req.workspace.id}/templates`, msg));
  });

  app.post('/workspaces/:wsId/templates/:id(\\d+)/adopt', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
    const tpl = db.prepare(`SELECT * FROM doc_templates WHERE id=? AND (is_system=1 OR firm_id=?)`)
      .get(req.params.id, req.workspace.firm_id);
    if (!tpl) return res.status(404).render('error', { user: req.user, message: 'Template not found.' });
    const r = adoptTemplateForWorkspace(tpl, req.workspace, req.user, req.entityScopeId, req.body);
    const linkSuffix = r.linkedControls > 0 ? ` · auto-linked ${r.linkedControls} control${r.linkedControls === 1 ? '' : 's'}` : '';
    res.redirect(withToast(`/workspaces/${req.workspace.id}/documents/${r.docId}`, `${tpl.name} adopted${linkSuffix}`));
  });

  app.post('/workspaces/:wsId/documents/from-template', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
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
      document_owner: (overrides && overrides.document_owner) || 'CISO',
      approval_authority: (overrides && overrides.approval_authority) || 'Top Management',
      review_period: (overrides && overrides.review_period) || 'Annual',
      industry: workspace.industry || ''
    };
    const content = substitutePlaceholders(tpl.content, vars);
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
    logAction(user.id, workspace.id, 'create_document', 'document', docId,
      { from_template: tpl.name, auto_linked: linkedControls }, { ip: '', userAgent: '' });
    return { docId, linkedControls };
  }

  app.post('/workspaces/:wsId/documents/blank', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
    const { name, category } = req.body;
    if (!name) return redirectBack(req, res);
    const initial = '# ' + name + '\n\n';
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
  app.post('/workspaces/:wsId/documents/upload', requireAuth, requireWorkspace, requirePermission('document.create'), upload.single('file'), async (req, res) => {
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
        conversionNote = `<p><em>Imported from PDF - formatting (tables, headings, lists) may need to be re-applied. The original PDF is attached as the approved source.</em></p>`;
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
    const content = heading + bodyHtml;
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
      plainContent = mdRenderer.render(plainContent);
      const enc2 = enc.encryptIfNeeded(plainContent, req.workspace.id, !!req.workspace.encryption_enabled);
      db.prepare('UPDATE generated_docs SET content=? WHERE id=?').run(enc2, docRaw.id);
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
      ORDER BY u.name`).all(req.workspace.id, req.workspace.firm_id);

    // Linked Annex A controls + clauses (Phase A: doc <-> control bidirectional mapping).
    // drl-native (document_controls demolished); link_id = drl.id.
    const linkedControls = docLinks.linkedControlsForDoc(db, 'iso27001', doc.id);
    const allControls = db.prepare(`SELECT id, title, category, type FROM iso_items
      WHERE type IN ('control','clause') ORDER BY sort_order`).all();

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
        if (docLinks.addLink(db, 'iso27001', doc.id, id, sectionRef).changes > 0) added++;
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

  app.post('/workspaces/:wsId/documents/:id', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const before = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!before) return redirectBack(req, res);
    if (before.locked) return res.status(400).render('error', { user: req.user, message: 'Document is locked. Open a new version to edit.' });

    const { name, content, status } = req.body;
    const sets = []; const vals = [];
    if (name !== undefined) { sets.push('name=?'); vals.push(name); }
    if (content !== undefined) {
      sets.push('content=?');
      vals.push(enc.encryptIfNeeded(content, req.workspace.id, !!req.workspace.encryption_enabled));
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
    if (looksLikeMarkdown(plainContent)) plainContent = mdRenderer.render(plainContent);
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

  app.post('/workspaces/:wsId/documents/:id/delete', requireAuth, requireWorkspace, requirePermission('document.delete'), (req, res) => {
    db.prepare('DELETE FROM generated_docs WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
    fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'document', entityId: req.params.id });
    res.redirect('/workspaces/' + req.workspace.id + '/documents');
  });

  // Snooze a document's review date by N days. Used by the overdue/due-soon
  // banner on /documents and the per-row action on /policy-adoption. Records
  // who snoozed and why in audit log.
  app.post('/workspaces/:wsId/documents/:id/snooze-review', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
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
  app.post('/workspaces/:wsId/documents/:id/submit-review', requireAuth, requireWorkspace, requirePermission('document.submit_review'), (req, res) => {
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
    for (let i = 0; i < chain.length; i++) {
      const r = chain[i];
      if (r.kind === 'internal') {
        if (!r.user_id || isNaN(parseInt(r.user_id, 10))) {
          return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: pick a user.` });
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
    let v;
    try {
      v = snapshotDocVersion(doc.id, req.workspace.id, 'in_review', req.user.id, summary);
    } catch (e) {
      if (e && e.code === 'DOC_VERSION_CONFLICT') {
        return res.status(409).render('error', { user: req.user,
          message: 'Another consultant submitted this document for review at the same time. Open the document, review the new version, and decide whether to add another reviewer.' });
      }
      throw e;
    }
    db.prepare(`UPDATE generated_docs SET status='in_review', locked=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    db.prepare(`UPDATE doc_versions SET submitted_at=CURRENT_TIMESTAMP WHERE id=?`).run(v.id);

    const insInternal = db.prepare(`INSERT INTO doc_approvers (workspace_id, document_id, version_id, sequence, user_id, role_label, notified_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    const insExternal = db.prepare(`INSERT INTO external_approvers
      (workspace_id, document_id, version_id, sequence, email, name, role_label, token_hash, expires_at, notified_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`);

    // Per-row token storage - we keep the raw tokens in memory just long
    // enough to send the emails after the transaction commits. They're
    // never written to the DB in raw form.
    const rawTokens = {};
    const tx = db.transaction(() => {
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
    });
    tx();

    logAction(req.user.id, req.workspace.id, 'submit_for_review', 'document', doc.id,
      { version: v.version, approvers: chain.length, internal: chain.filter(c => c.kind === 'internal').length, external: chain.filter(c => c.kind === 'external').length, summary }, auditCtx(req));

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
          if (!row.person_email) return;
          const intro = isFirst
            ? `${submitter} has submitted "${doc.name}" (v${v.version}) for your approval in the ${wsName} workspace.`
            : `${submitter} has submitted "${doc.name}" (v${v.version}) for approval in the ${wsName} workspace. You are approver #${idx + 1} - you'll be able to decide once the earlier approvers have signed off.`;
          const bodyHtml = `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border:1px solid #ececef;border-radius:6px;">
              <tr><td style="padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">
                <div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#9c9ca5;margin-bottom:6px;">Document</div>
                <div style="font-size:15px;font-weight:500;color:#0a0a0a;margin-bottom:10px;">${email.escapeHtml(doc.name)} <span style="color:#9c9ca5;font-weight:400;">· v${v.version}</span></div>
                ${summary ? `<div style="font-size:13px;line-height:1.5;color:#51525c;border-left:2px solid #1a1a1a;padding-left:10px;">${email.escapeHtml(summary)}</div>` : ''}
              </td></tr>
            </table>`;
          email.sendEmail({
            to: row.person_email,
            subject: `[${wsName}] Approval requested: ${doc.name} (v${v.version})`,
            html: email.renderEmailLayout({
              headline: isFirst ? 'A document needs your approval' : 'You are in the approval queue',
              intro, bodyHtml,
              ctaText: isFirst ? 'Review and approve' : 'View document',
              ctaUrl: docUrl,
              footnote: `You're receiving this because you were named as an approver on this document. Decisions are recorded with your signature and the workspace audit log.`,
              fromName: wsName
            }),
            firmId: req.workspace.firm_id, workspaceId: req.workspace.id,
            relatedType: 'doc_approval_request', relatedId: doc.id
          }).catch(err => console.error('[email] internal-approver send failed:', err.message));
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

  function notifyChainAdvanced(versionId, doc, workspace, decidedByDisplay) {
    const next = docApprovals.nextPending(db, versionId);
    if (!next) return; // chain complete - completion handler runs separately
    const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
    const wsName = workspace.client_name;
    const docUrl = `${email.appBaseUrl()}/workspaces/${workspace.id}/documents/${doc.id}`;

    if (next.kind === 'internal') {
      if (!next.row.person_email) return;
      const bodyHtml = `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${email.escapeHtml(decidedByDisplay)} has signed off. "${email.escapeHtml(doc.name)}" (v${version.version}) is now waiting on your decision as approver #${next.row.sequence}${next.row.role_label ? ` (${email.escapeHtml(next.row.role_label)})` : ''}.</p>`;
      email.sendEmail({
        to: next.row.person_email,
        subject: `[${wsName}] Your turn to approve: ${doc.name} (v${version.version})`,
        html: email.renderEmailLayout({
          headline: 'A document is waiting on you',
          bodyHtml, ctaText: 'Review and approve', ctaUrl: docUrl, fromName: wsName
        }),
        firmId: workspace.firm_id, workspaceId: workspace.id,
        relatedType: 'doc_approval_request', relatedId: doc.id
      }).catch(err => console.error('[email] next-internal notify failed:', err.message));
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

  function notifyChainComplete(versionId, doc, workspace, decidedByDisplay) {
    const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
    const submitter = version ? db.prepare('SELECT id, name, email FROM users WHERE id=?').get(version.created_by) : null;
    if (!submitter || !submitter.email) return;
    const wsName = workspace.client_name;
    const docUrl = `${email.appBaseUrl()}/workspaces/${workspace.id}/documents/${doc.id}`;
    const chain = docApprovals.listChain(db, versionId);
    const listRows = chain.map(a =>
      `<li style="margin-bottom:4px;">${email.escapeHtml(a.person_name)}${a.role_label ? ` <span style="color:#9c9ca5;">(${email.escapeHtml(a.role_label)})</span>` : ''}${a.kind === 'external' ? ` <span style="color:#9c9ca5;">· external</span>` : ''}</li>`
    ).join('');
    const bodyHtml = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">All approvers have signed off on v${version.version} of "${email.escapeHtml(doc.name)}". The document is now locked as <strong>approved</strong> and ready for publication.</p>
      <div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#9c9ca5;margin:16px 0 6px;">Approval chain</div>
      <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${listRows}</ul>`;
    email.sendEmail({
      to: submitter.email,
      subject: `[${wsName}] Approved: ${doc.name} (v${version.version})`,
      html: email.renderEmailLayout({
        headline: 'Your document has been approved',
        bodyHtml, ctaText: 'Publish document', ctaUrl: docUrl, fromName: wsName
      }),
      firmId: workspace.firm_id, workspaceId: workspace.id,
      relatedType: 'doc_approval_decision', relatedId: doc.id
    }).catch(err => console.error('[email] approval-complete notify failed:', err.message));
  }

  function notifyRejection(versionId, doc, workspace, rejectorDisplay, reason) {
    const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
    const submitter = version ? db.prepare('SELECT id, name, email FROM users WHERE id=?').get(version.created_by) : null;
    if (!submitter || !submitter.email) return;
    const wsName = workspace.client_name;
    const docUrl = `${email.appBaseUrl()}/workspaces/${workspace.id}/documents/${doc.id}`;
    const bodyHtml = `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>${email.escapeHtml(rejectorDisplay)}</strong> rejected v${version.version} of "${email.escapeHtml(doc.name)}".</p>
      ${reason ? `<div style="margin:12px 0;padding:12px 14px;background:#fafafa;border-left:2px solid #1a1a1a;font-size:13px;line-height:1.5;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>Reason:</strong> ${email.escapeHtml(reason)}</div>` : ''}
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">The document is back in draft so you can address the feedback and resubmit.</p>`;
    email.sendEmail({
      to: submitter.email,
      subject: `[${wsName}] Rejected: ${doc.name} (v${version.version})`,
      html: email.renderEmailLayout({
        headline: 'Your document was rejected',
        bodyHtml, ctaText: 'Open document', ctaUrl: docUrl, fromName: wsName
      }),
      firmId: workspace.firm_id, workspaceId: workspace.id,
      relatedType: 'doc_approval_decision', relatedId: doc.id
    }).catch(err => console.error('[email] reject-notify failed:', err.message));
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

  function finaliseRejectedDocument(versionId, doc) {
    const r = db.prepare(`UPDATE doc_versions SET status='rejected'
      WHERE id=? AND status='in_review'`).run(versionId);
    if (r.changes === 0) return false;
    db.prepare(`UPDATE generated_docs SET status='draft', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    return true;
  }

  app.post('/workspaces/:wsId/documents/:id/decide', requireAuth, requireWorkspace, requirePermission('document.review'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    const decisionBack = req.user.user_type === 'client'
      ? `/workspaces/${req.workspace.id}/client-portal/policies/${req.params.id}`
      : `/workspaces/${req.workspace.id}/documents/${req.params.id}`;
    if (!doc || !doc.current_version_id) return res.redirect(decisionBack);
    const { decision, reason } = req.body;
    if (!['approve','reject'].includes(decision)) return redirectBack(req, res);

    // The logged-in user must be the next pending approver (mixed-chain
    // aware - they have to be at the front of the merged queue, not just
    // the front of the internal queue).
    const myRow = db.prepare(
      `SELECT * FROM doc_approvers WHERE version_id=? AND user_id=? AND decision IS NULL ORDER BY sequence LIMIT 1`
    ).get(doc.current_version_id, req.user.id);
    if (!myRow) return res.status(403).render('error', { user: req.user, message: 'You are not a pending approver on this version.' });
    const upNext = docApprovals.nextPending(db, doc.current_version_id);
    if (!upNext || upNext.kind !== 'internal' || upNext.row.id !== myRow.id) {
      return res.status(400).render('error', { user: req.user, message: `Approver #${upNext ? upNext.row.sequence : '?'} must decide first.` });
    }

    // CAS the decision so re-submits (browser double-click, network retry)
    // and concurrent decisions can't double-write. If 0 rows changed, someone
    // else (or the user themselves) already decided on this row.
    const decResult = db.prepare(`UPDATE doc_approvers
      SET decision=?, decision_reason=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=? AND decision IS NULL`)
      .run(decision === 'approve' ? 'approved' : 'rejected', reason || null, myRow.id);
    if (decResult.changes === 0) {
      return res.redirect(withToast(decisionBack,
        'Your decision was already recorded.', 'info'));
    }

    if (decision === 'reject') {
      // finaliseRejectedDocument CAS-flips doc_versions.status from in_review
      // to rejected. Only the first caller succeeds; the rest get false and
      // skip the duplicate notification/log emission.
      if (finaliseRejectedDocument(doc.current_version_id, doc)) {
        logAction(req.user.id, req.workspace.id, 'reject_document', 'document', doc.id,
          { version_id: doc.current_version_id, reason }, auditCtx(req));
        notifyRejection(doc.current_version_id, doc, req.workspace, req.user.name, reason);
      }
      return res.redirect(withToast(decisionBack, 'Document rejected', 'error'));
    }

    if (docApprovals.countPending(db, doc.current_version_id) === 0) {
      // Two simultaneous final approvers could both see pending=0 here. Only
      // the one whose finaliseApprovedDocument CAS succeeds fires the
      // chain-complete side effects (email, audit log). The loser silently
      // returns and the user sees a regular success page.
      if (finaliseApprovedDocument(doc.current_version_id, doc, req.workspace.id, req.user.id)) {
        logAction(req.user.id, req.workspace.id, 'approve_document', 'document', doc.id, { version_id: doc.current_version_id }, auditCtx(req));
        notifyChainComplete(doc.current_version_id, doc, req.workspace, req.user.name);
      }
    } else {
      logAction(req.user.id, req.workspace.id, 'partial_approve_document', 'document', doc.id,
        { version_id: doc.current_version_id, remaining: docApprovals.countPending(db, doc.current_version_id) }, auditCtx(req));
      notifyChainAdvanced(doc.current_version_id, doc, req.workspace, req.user.name);
    }
    res.redirect(decisionBack);
  });

  // ==================== MAGIC-LINK APPROVAL PORTAL ====================
  // External approver clicks the link in their email -> arrives here.
  // No auth; the token IS the credential. Token is in the URL, not stored
  // raw in the DB; we look up by SHA-256 hash. All decisions audit-log
  // via the external sentinel user (id=0) which resolves to
  // external@isms.local in the activity stream.

  app.get('/approve/:token', (req, res) => {
    const row = docApprovals.findByToken(db, req.params.token);
    if (!row) {
      return res.status(404).render('approve_error', {
        title: 'Approval link not found',
        message: 'This approval link is not valid. It may have been revoked or replaced. Ask the person who sent it to issue a new one.'
      });
    }
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
    // Verify it's actually their turn before showing the approve form.
    // (If not, render a "waiting on earlier approver" state instead.)
    const myTurn = docApprovals.isExternalRowMyTurn(db, row);
    const chain = docApprovals.listChain(db, row.version_id);

    // Document body may be stored as markdown or HTML; render markdown
    // -> HTML so the view can drop it in with <%- %>. Decrypt first if
    // the workspace has encryption enabled.
    let bodyRaw = row.content;
    try { bodyRaw = enc.decryptIfNeeded(bodyRaw, row.workspace_id); } catch (_) {}
    const bodyHtml = looksLikeMarkdown(bodyRaw) ? mdRenderer.render(bodyRaw) : bodyRaw;

    res.render('approve', {
      row, chain, myTurn,
      workspaceName: row.workspace_name,
      docName: row.doc_name,
      docVersion: row.version,
      docContent: bodyHtml,
      submitterName: row.submitter_name,
      brandColor: row.brand_primary_color || '#1a1a1a',
      token: req.params.token,
      csrfToken: '' // route is CSRF-skipped (token is the credential)
    });
  });

  app.post('/approve/:token', (req, res) => {
    const row = docApprovals.findByToken(db, req.params.token);
    if (!row || row.effective_status !== 'pending') {
      return res.status(410).render('approve_error', {
        title: 'Link no longer active',
        message: 'This approval link is no longer valid (expired, revoked, or already decided).'
      });
    }
    const { decision, reason } = req.body;
    if (!['approve','reject'].includes(decision)) {
      return res.status(400).render('approve_error', { title: 'Bad request', message: 'Pick approve or reject.' });
    }
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
      WHERE id=? AND decision IS NULL`).run(decisionVal, reason || null, ip, ua, row.id);
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
      'document', row.doc_id, { version_id: row.version_id, external_approver: row.name, email: row.email, reason: reason || null },
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
    requireAuth, requireWorkspace, requirePermission('document.submit_review'), (req, res) => {
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
    requireAuth, requireWorkspace, requirePermission('document.submit_review'), (req, res) => {
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
  app.post('/workspaces/:wsId/documents/:id/sign', requireAuth, requireWorkspace, requirePermission('document.sign'), (req, res) => {
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
  app.post('/workspaces/:wsId/documents/:id/publish', requireAuth, requireWorkspace, requirePermission('document.publish'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    if (doc.status !== 'approved') return res.status(400).render('error', { user: req.user, message: 'Only approved documents can be published.' });
    db.prepare(`UPDATE generated_docs SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
    logAction(req.user.id, req.workspace.id, 'publish_document', 'document', doc.id, { version_id: doc.current_version_id }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

  // Retire a published document.
  app.post('/workspaces/:wsId/documents/:id/retire', requireAuth, requireWorkspace, requirePermission('document.retire'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    db.prepare(`UPDATE generated_docs SET status='retired', retired_at=CURRENT_TIMESTAMP, locked=1 WHERE id=?`).run(doc.id);
    if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='retired', retired_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
    logAction(req.user.id, req.workspace.id, 'retire_document', 'document', doc.id, { reason: req.body.reason || null }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

  // Reopen for editing - creates a new draft version branched off current.
  app.post('/workspaces/:wsId/documents/:id/new-version', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    db.prepare(`UPDATE generated_docs SET status='draft', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    logAction(req.user.id, req.workspace.id, 'new_version', 'document', doc.id,
      { previous_version_id: doc.current_version_id }, auditCtx(req));
    res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
  });

}

module.exports = { register };
