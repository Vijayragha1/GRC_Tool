'use strict';
// Evidence routes. Slice 8 of the server.js modularization: library, upload,
// linking, versions/supersede, preview/download, coverage matrix.

const fs = require('fs');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');
const fts = require('../lib/fts');
const evReads = require('../lib/evidence-reads');
const evWrites = require('../lib/evidence-writes');
const { paginate, paginateArray, pageHref } = require('../lib/paginate');
const { ALLOWED_FRAMEWORKS } = require('../lib/frameworks');
const { withToast, redirectBack, auditCtx, parseFormArray } = require('../lib/http-helpers');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          upload, resolveUploadPath } = deps;

  // ==================== EVIDENCE ====================
  // Workspace-wide evidence library - every uploaded file with its links, owner,
  // validity, and add/remove-link actions. Use this when a single artefact (e.g.
  // a network diagram) evidences several controls and you don't want to walk into
  // each control's wizard to attach.
  app.get('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const filter = (req.query.filter || 'all').toString();
    const tag = (req.query.tag || '').toString().trim().toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const expSoon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    // Active (non-superseded) evidence only on the live view. Superseded rows
    // are still visible from the version-chain expander on each row.
    const allEvidence = db.prepare(`
      SELECT e.*,
             u.name AS uploader,
             ${evReads.linkCountSubquery()} AS link_count,
             sup.filename AS superseded_filename
      FROM evidence e
      LEFT JOIN users u ON u.id = e.uploaded_by
      LEFT JOIN evidence sup ON sup.id = e.supersedes_id
      WHERE e.workspace_id = ? AND e.superseded_at IS NULL
      ORDER BY e.uploaded_at DESC
    `).all(req.workspace.id);

    let evidenceList = allEvidence;
    if (filter === 'expired') {
      evidenceList = evidenceList.filter(e => e.valid_until && e.valid_until < today);
    } else if (filter === 'expiring') {
      evidenceList = evidenceList.filter(e => e.valid_until && e.valid_until >= today && e.valid_until < expSoon);
    } else if (filter === 'unlinked') {
      evidenceList = evidenceList.filter(e => (e.link_count || 0) === 0);
    }
    if (tag) {
      evidenceList = evidenceList.filter(e => (e.tags || '').toLowerCase().split(',').map(t => t.trim()).includes(tag));
    }
    if (q) {
      const lq = q.toLowerCase();
      evidenceList = evidenceList.filter(e =>
        (e.filename || '').toLowerCase().includes(lq) ||
        (e.description || '').toLowerCase().includes(lq) ||
        (e.period_label || '').toLowerCase().includes(lq) ||
        (e.uploader || '').toLowerCase().includes(lq) ||
        (e.tags || '').toLowerCase().includes(lq)
      );
    }

    // Paginate the filtered list; counters and the tag cloud below stay
    // full-set on purpose (the filter pills describe the library, not the page).
    const pgEv = require('../lib/paginate').paginateArray(req, evidenceList, 50);
    evidenceList = pgEv.rows;

    // Linked controls (ISO 27001 chips) + cross-framework link details for the
    // visible rows. Sourced from the legacy join tables or the converged
    // evidence_requirement_links per the per-workspace cutover flag; the legacy
    // link_id handle is preserved on both paths so the still-legacy unlink /
    // section-edit writes keep working. See lib/evidence-reads.js.
    // crossLinksByEvidence[evId] = { iso27001: [...], iso42001: [...], csf: [...] }
    const { linksByEvidence, crossLinksByEvidence } = evReads.libraryLinks(
      db, evidenceList.map(e => e.id));

    // Aggregate counters across all *active* evidence (the filter pills).
    const counters = {
      total: allEvidence.length,
      expired: allEvidence.filter(e => e.valid_until && e.valid_until < today).length,
      expiring: allEvidence.filter(e => e.valid_until && e.valid_until >= today && e.valid_until < expSoon).length,
      unlinked: allEvidence.filter(e => (e.link_count || 0) === 0).length,
      superseded: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND superseded_at IS NOT NULL`).get(req.workspace.id).c
    };

    // Tag cloud - every distinct tag used in this workspace, with counts.
    const tagCounts = {};
    for (const e of allEvidence) {
      if (!e.tags) continue;
      for (const t of e.tags.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
    const tagList = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const allIsoItems = req.workspace.frameworks.includes('iso27001')
      ? db.prepare(`SELECT id, type, title FROM iso_items ORDER BY sort_order ASC`).all() : [];
    // Per-framework catalogs for the "Link to..." picker on each row. Only
    // populated when the workspace has that framework enabled.
    const allIso42001Items = req.workspace.frameworks.includes('iso42001')
      ? db.prepare(`SELECT id, type, title FROM iso42001_items ORDER BY sort_order ASC`).all() : [];
    const allCsfSubcats = req.workspace.frameworks.includes('csf')
      ? db.prepare(`SELECT code, description FROM csf_subcategories ORDER BY code ASC`).all() : [];

    res.render('evidence_library', {
      user: req.user, ws: req.workspace,
      title: 'Evidence library',
      active: 'evidence',
      evidenceList, linksByEvidence, counters,
      crossLinksByEvidence,
      allIsoItems, allIso42001Items, allCsfSubcats,
      q, filter, tag, today, expSoon,
      tagList,
      pg: pgEv, pagerHref: p => pageHref(req, p)
    });
  });

  // Helper: normalise comma-separated tags to lowercase, trimmed, deduped.
  function normaliseTags(raw) {
    if (!raw) return '';
    return raw.split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i)
      .join(', ');
  }

  // Resolve upload-form selections against the catalogs enabled for this
  // workspace. The browser is not trusted to decide which frameworks or
  // requirement references are valid.
  function selectedEvidenceRefs(workspace, body) {
    const enabled = new Set(Array.isArray(workspace.frameworks) ? workspace.frameworks : []);
    const selected = { iso27001: [], iso42001: [], csf: [] };
    const unique = values => [...new Set(parseFormArray(values).map(value => String(value).trim()).filter(Boolean))];

    if (enabled.has('iso27001')) {
      const refs = unique(body.iso_item_id);
      if (refs.length) {
        const placeholders = refs.map(() => '?').join(',');
        const valid = new Set(db.prepare(`SELECT id FROM iso_items WHERE id IN (${placeholders})`).all(...refs).map(row => row.id));
        selected.iso27001 = refs.filter(ref => valid.has(ref));
      }
    }
    if (enabled.has('iso42001')) {
      const refs = unique(body.iso42001_item_ref);
      if (refs.length) {
        const placeholders = refs.map(() => '?').join(',');
        const valid = new Set(db.prepare(`SELECT id FROM iso42001_items WHERE id IN (${placeholders})`).all(...refs).map(row => row.id));
        selected.iso42001 = refs.filter(ref => valid.has(ref));
      }
    }
    if (enabled.has('csf')) {
      const refs = unique(body.csf_item_ref);
      if (refs.length) {
        const placeholders = refs.map(() => '?').join(',');
        const valid = new Set(db.prepare(`SELECT code FROM csf_subcategories WHERE code IN (${placeholders})`).all(...refs).map(row => row.code));
        selected.csf = refs.filter(ref => valid.has(ref));
      }
    }
    return selected;
  }

  function selectedEvidenceRefCount(selected) {
    return selected.iso27001.length + selected.iso42001.length + selected.csf.length;
  }

  function attachSelectedEvidenceRefs(evidenceId, selected, sectionRef) {
    for (const ref of selected.iso27001) evWrites.attachIsoControl(db, evidenceId, ref, sectionRef || null);
    for (const ref of selected.iso42001) evWrites.attachCrossLink(db, evidenceId, 'iso42001', ref, sectionRef || null);
    for (const ref of selected.csf) evWrites.attachCrossLink(db, evidenceId, 'csf', ref, sectionRef || null);
  }

  app.post('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, requirePermission('evidence.upload'), upload.single('file'), (req, res) => {
    if (!req.file) return redirectBack(req, res, 'Pick a file to upload', 'error');
    const selected = selectedEvidenceRefs(req.workspace, req.body);
    const primaryId = selected.iso27001[0] || null;
    const linkCount = selectedEvidenceRefCount(selected);
    const { description, valid_from, valid_until, period_label, clause_section } = req.body;
    const tags = normaliseTags(req.body.tags);
    const buf = fs.readFileSync(req.file.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');

    // Dedupe by SHA-256 within this workspace. If we've seen this exact bytes
    // before (and it isn't superseded), don't create a duplicate row - link the
    // existing file to the new control IDs and discard the new upload.
    const existing = db.prepare(`SELECT id, filename FROM evidence
      WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL
      ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
    if (existing) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      if (linkCount) {
        db.transaction(() => attachSelectedEvidenceRefs(existing.id, selected, clause_section))();
      }
      logAction(req.user.id, req.workspace.id, 'dedupe_evidence', 'evidence', existing.id, {
        sha, link_count: linkCount,
        framework_counts: Object.fromEntries(Object.entries(selected).map(([framework, refs]) => [framework, refs.length]))
      });
      const back = req.headers.referer || '/workspaces/' + req.workspace.id + '/evidence';
      return res.redirect(withToast(back, `Same file already exists (${existing.filename}) - linked instead of duplicated`));
    }

    const evId = db.prepare(`INSERT INTO evidence
      (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
       valid_from, valid_until, period_label, clause_section, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, primaryId, req.file.originalname, req.file.filename,
           sha, req.file.size, req.user.id, description || null,
           valid_from || null, valid_until || null, period_label || null, clause_section || null,
           tags || null).lastInsertRowid;
    if (linkCount) {
      db.transaction(() => attachSelectedEvidenceRefs(evId, selected, clause_section))();
    }
    logAction(req.user.id, req.workspace.id, 'upload_evidence', 'evidence', evId, {
      filename: req.file.originalname, link_count: linkCount,
      framework_counts: Object.fromEntries(Object.entries(selected).map(([framework, refs]) => [framework, refs.length]))
    });
    const back = req.headers.referer || '/workspaces/' + req.workspace.id;
    res.redirect(back);
  });

  // Bulk upload - multiple files at once with shared metadata. Each file becomes
  // an independent evidence row; all share the same period / valid_from / valid_until
  // and link to the same set of selected controls.
  app.post('/workspaces/:wsId/evidence/bulk', requireAuth, requireWorkspace, requirePermission('evidence.upload'), upload.array('files', 50), (req, res) => {
    if (!req.files || !req.files.length) return redirectBack(req, res, 'Pick at least one file', 'error');
    const selected = selectedEvidenceRefs(req.workspace, req.body);
    const primaryId = selected.iso27001[0] || null;
    const linkCount = selectedEvidenceRefCount(selected);
    const { description, valid_from, valid_until, period_label } = req.body;
    const tags = normaliseTags(req.body.tags);
    let created = 0, deduped = 0;
    for (const f of req.files) {
      const buf = fs.readFileSync(f.path);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const existing = db.prepare(`SELECT id FROM evidence
        WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
      if (existing) {
        try { fs.unlinkSync(f.path); } catch (_) {}
        if (linkCount) {
          db.transaction(() => attachSelectedEvidenceRefs(existing.id, selected, null))();
        }
        deduped++;
        continue;
      }
      const evId = db.prepare(`INSERT INTO evidence
        (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
         valid_from, valid_until, period_label, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.workspace.id, primaryId, f.originalname, f.filename, sha, f.size, req.user.id,
             description || null, valid_from || null, valid_until || null, period_label || null,
             tags || null).lastInsertRowid;
      if (linkCount) {
        db.transaction(() => attachSelectedEvidenceRefs(evId, selected, null))();
      }
      created++;
    }
    logAction(req.user.id, req.workspace.id, 'bulk_upload_evidence', 'workspace', req.workspace.id, {
      created, deduped, link_count: linkCount,
      framework_counts: Object.fromEntries(Object.entries(selected).map(([framework, refs]) => [framework, refs.length]))
    });
    const msg = `Uploaded ${created} file${created === 1 ? '' : 's'}` + (deduped ? ` · ${deduped} re-linked (already existed)` : '');
    res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, msg));
  });

  // Supersede an existing evidence file with a new version. Old row is kept
  // for audit trail (superseded_at + superseded_by_id), all links are copied
  // to the new row, and the new row records its predecessor in supersedes_id.
  app.post('/workspaces/:wsId/evidence/:id/supersede', requireAuth, requireWorkspace, requirePermission('evidence.upload'), upload.single('file'), (req, res) => {
    const old = db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!old) return res.status(404).send('Not found');
    if (!req.file) return redirectBack(req, res, 'Pick the new version of the file', 'error');
    const buf = fs.readFileSync(req.file.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha === old.sha256) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, 'New file is identical to the existing version - nothing to supersede', 'info'));
    }
    const { description, valid_from, valid_until, period_label } = req.body;
    const tags = normaliseTags(req.body.tags) || old.tags || null;
    const newId = db.prepare(`INSERT INTO evidence
      (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
       valid_from, valid_until, period_label, clause_section, supersedes_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, old.iso_item_id, req.file.originalname, req.file.filename, sha, req.file.size,
           req.user.id, description || old.description || null,
           valid_from || null, valid_until || null, period_label || null, old.clause_section || null,
           old.id, tags).lastInsertRowid;
    // Copy links from old to new (evidence_requirement_links).
    const tx = db.transaction(() => { evWrites.copyControlLinks(db, old.id, newId); });
    try { tx(); } catch (_) {}
    // Mark old as superseded - kept for audit trail but hidden from active view.
    db.prepare(`UPDATE evidence SET superseded_at=datetime('now'), superseded_by_id=? WHERE id=?`).run(newId, old.id);
    logAction(req.user.id, req.workspace.id, 'supersede_evidence', 'evidence', old.id, { new_id: newId, filename: req.file.originalname });
    res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, `Superseded ${old.filename} → ${req.file.originalname}`));
  });

  // Auditor evidence-pack export - single ZIP of every active (non-superseded)
  // evidence file in the workspace, plus a manifest CSV describing each one.
  app.get('/workspaces/:wsId/evidence/pack.zip', requireAuth, requireWorkspace, (req, res) => {
    const dateFrom = (req.query.from || '').toString();
    const dateTo = (req.query.to || '').toString();
    let where = 'e.workspace_id = ? AND e.superseded_at IS NULL';
    const params = [req.workspace.id];
    if (dateFrom) { where += ' AND date(e.uploaded_at) >= date(?)'; params.push(dateFrom); }
    if (dateTo)   { where += ' AND date(e.uploaded_at) <= date(?)'; params.push(dateTo); }
    const items = db.prepare(`SELECT e.*, u.name AS uploader,
      ${evReads.linkedControlsSubquery()} AS linked_controls
      FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE ${where} ORDER BY e.uploaded_at ASC`).all(...params);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="evidence-pack-${req.workspace.id}-${new Date().toISOString().slice(0,10)}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { try { res.status(500).send(String(err)); } catch (_) {} });
    archive.pipe(res);

    // Manifest CSV
    const csvLines = [
      'evidence_id,filename,sha256,size_bytes,uploader,uploaded_at,period,valid_from,valid_until,linked_controls,tags,description'
    ];
    function csvEsc(v) {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    for (const e of items) {
      csvLines.push([
        e.id, csvEsc(e.filename), e.sha256, e.size_bytes, csvEsc(e.uploader),
        e.uploaded_at ? e.uploaded_at.slice(0, 19) : '',
        csvEsc(e.period_label), e.valid_from || '', e.valid_until || '',
        csvEsc(e.linked_controls), csvEsc(e.tags), csvEsc(e.description)
      ].join(','));
    }
    archive.append(csvLines.join('\n'), { name: 'MANIFEST.csv' });

    // README
    archive.append(
  `Evidence pack - workspace ${req.workspace.client_name || req.workspace.id}
  Generated: ${new Date().toISOString()}
  Files: ${items.length}
  Date range: ${dateFrom || 'all'} → ${dateTo || 'all'}

  MANIFEST.csv lists every file in this pack with its SHA-256, linked controls,
  period, validity, and uploader. The /files/ directory contains the actual
  artefacts. SHA-256 lets you verify nothing was tampered with after export.
  `,
      { name: 'README.txt' }
    );

    // Files - resolve via the partitioned-or-legacy resolver shared with /download.
    for (const e of items) {
      const found = resolveUploadPath(e.stored_path, req.workspace.firm_id);
      if (found && fs.existsSync(found) && fs.statSync(found).isFile()) {
        archive.file(found, { name: `files/${e.id}-${e.filename}` });
      }
    }
    archive.finalize();
  });

  // Tier A.1 - Add/remove additional control links on an evidence file.
  // section_ref may be either a single shared value (form: section_ref=...) or
  // per-link via a parallel array section_ref_for_<isoId>=... - the latter wins.
  // Cross-framework link route. Accepts framework=iso42001|csf and one or more
  // item_ref values, writing them to evidence_requirement_links. The /controls
  // endpoint is the ISO 27001 equivalent; both resolve their ref to a requirement.
  app.post('/workspaces/:wsId/evidence/:id/links', requireAuth, requireWorkspace, requirePermission('evidence.upload'), (req, res) => {
    const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const framework = (req.body.framework || '').toString();
    if (!ALLOWED_FRAMEWORKS.includes(framework) || framework === 'iso27001') {
      // ISO 27001 keeps its own legacy route so the section_ref + primary
      // bookkeeping stays consistent. Cross-framework only here.
      return res.status(400).send('Use /controls for ISO 27001 links');
    }
    if (!req.workspace.frameworks.includes(framework)) {
      return res.status(400).send('Framework is not enabled for this workspace');
    }
    const refs = parseFormArray(req.body.item_ref);
    if (!refs.length) return redirectBack(req, res);
    // Validate item_refs against the framework's source-of-truth table so a
    // typo or attacker-injected ref doesn't get stored.
    let valid;
    if (framework === 'iso42001') {
      const ph = refs.map(() => '?').join(',');
      valid = new Set(db.prepare(`SELECT id FROM iso42001_items WHERE id IN (${ph})`).all(...refs).map(r => r.id));
    } else { // csf
      const ph = refs.map(() => '?').join(',');
      valid = new Set(db.prepare(`SELECT code FROM csf_subcategories WHERE code IN (${ph})`).all(...refs).map(r => r.code));
    }
    const filtered = refs.filter(r => valid.has(r));
    if (!filtered.length) return redirectBack(req, res);
    const tx = db.transaction(() => {
      for (const ref of filtered) evWrites.attachCrossLink(db, ev.id, framework, ref, req.body.section_ref || null);
    });
    try { tx(); } catch (_) {}
    logAction(req.user.id, req.workspace.id, 'link_evidence_cross_framework', 'evidence', ev.id,
              { framework, refs: filtered, count: filtered.length }, auditCtx(req));
    redirectBack(req, res);
  });

  // Delete a single cross-framework link.
  app.post('/workspaces/:wsId/evidence/:id/links/:linkId/delete', requireAuth, requireWorkspace, requirePermission('evidence.delete'), (req, res) => {
    const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    // Don't touch iso27001 rows from this route - those belong to the legacy
    // /controls flow which has additional primary-key bookkeeping.
    const link = evWrites.unlinkCrossLink(db, ev.id, req.params.linkId);
    if (link) {
      logAction(req.user.id, req.workspace.id, 'unlink_evidence_cross_framework', 'evidence', ev.id,
                { framework: link.framework, item_ref: link.item_ref }, auditCtx(req));
    }
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/evidence/:id/controls', requireAuth, requireWorkspace, requirePermission('evidence.upload'), (req, res) => {
    const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const ids = parseFormArray(req.body.iso_item_id);
    if (!ids.length) return redirectBack(req, res);
    const sharedSectionRef = req.body.section_ref || null;
    const tx = db.transaction(() => {
      for (const id of ids) {
        const perLinkKey = 'section_ref_for_' + id.replace(/[^a-z0-9.-]/gi, '_');
        const ref = (req.body[perLinkKey] || sharedSectionRef || null);
        evWrites.attachIsoControl(db, ev.id, id, ref);
      }
    });
    try { tx(); } catch (_) {}
    logAction(req.user.id, req.workspace.id, 'link_evidence_control', 'evidence', ev.id, { ids, count: ids.length }, auditCtx(req));
    redirectBack(req, res);
  });

  // Update the section_ref on an existing link (per-link, distinct from the
  // per-file clause_section). Posted from the chip on the library row.
  app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/section', requireAuth, requireWorkspace, requirePermission('evidence.upload'), (req, res) => {
    const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const newRef = (req.body.section_ref || '').toString().trim() || null;
    evWrites.updateSection(db, ev.id, req.params.linkId, newRef);
    redirectBack(req, res);
  });

  app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/delete', requireAuth, requireWorkspace, requirePermission('evidence.delete'), (req, res) => {
    const ev = db.prepare(`SELECT id, iso_item_id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const removedIso = evWrites.unlinkIsoControl(db, ev.id, req.params.linkId);
    if (removedIso) {
      // If the deleted link was the primary, also clear evidence.iso_item_id
      // so the legacy column doesn't drift back into existence on next render.
      if (ev.iso_item_id === removedIso) {
        db.prepare(`UPDATE evidence SET iso_item_id=NULL WHERE id=?`).run(ev.id);
      }
    }
    redirectBack(req, res);
  });

  app.get('/workspaces/:wsId/evidence/:id/download', requireAuth, requireWorkspace, (req, res) => {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (!ev) return res.status(404).send('Not found');
    const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
    res.download(fp, ev.filename);
  });

  app.post('/workspaces/:wsId/evidence/:id/delete', requireAuth, requireWorkspace, requirePermission('evidence.delete'), (req, res) => {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.workspace.id);
    if (ev) {
      const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
      db.prepare('DELETE FROM evidence WHERE id = ?').run(ev.id);
      logAction(req.user.id, req.workspace.id, 'delete_evidence', 'evidence', ev.id, null);
    }
    redirectBack(req, res);
  });

}

module.exports = { register };
