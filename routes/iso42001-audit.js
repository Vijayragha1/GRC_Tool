'use strict';
// ISO/IEC 42001 certification audit routes: the programme overview, the
// certification body's request list, and the AI system register the auditor
// samples from. Domain rules live in lib/iso42001-audit.js and
// lib/ai-systems.js; this file only adapts HTTP to them.
//
// Every page here is consultant-side. Client accounts are confined to the
// client portal by requireWorkspace and see these requests there, as client
// requests, once a consultant sends them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('../lib/iso42001-audit');
const registry = require('../lib/ai-systems');
const aimsContext = require('../lib/aims-context');
const aimsTemplates = require('../lib/iso42001-templates');
const aimsOverview = require('../lib/iso42001-overview');
const outcomeScope = require('../lib/engagement-outcome-scope');
const { parseWorkspaceFrameworks } = require('../lib/frameworks');
const { withToast, auditCtx } = require('../lib/http-helpers');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 2026-11-13 -> "13 Nov 2026". Accepts a date or a SQLite datetime.
function fmtDate(value) {
  const iso = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, upload, requestListUpload, adoptTemplate } = deps;

  function requireProgramme(req, res, next) {
    const frameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : parseWorkspaceFrameworks(req.workspace.frameworks);
    if (!frameworks.includes('iso42001')) {
      return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'ISO 42001 is not part of this client\'s programme.' });
    }
    next();
  }

  const view = [requireAuth, requireWorkspace, requireProgramme];
  const manage = [...view, requirePermission('control.update')];
  // The certification body's requests belong to certification support; a
  // gap-assessment-only engagement ends with the report, before any audit.
  const requireCertificationService = outcomeScope.requirePostGapService(
    'Certification audit requests are outside this gap-assessment-only engagement. Continue the client to full certification support to prepare for Stage 1 and Stage 2.');
  const certView = [...view, requireCertificationService];
  const certManage = [...manage, requireCertificationService];
  const base = req => `/workspaces/${req.workspace.id}/iso42001`;

  function perms(req, res) {
    const p = res.locals.userPerms;
    const has = perm => (p instanceof Set ? p.has(perm) : Array.isArray(p) ? p.includes(perm) : !!(p && p[perm]));
    return {
      manage: has('control.update'),
      send: has('client_request.manage'),
      signoff: has('assessment.signoff'),
      export: has('workspace.export'),
      upload: has('evidence.upload'),
      docCreate: has('document.create'),
    };
  }

  // Domain errors go back to the page the form came from with the message as
  // an error toast; anything else is a real fault and propagates.
  function handle(fn, fallback) {
    return (req, res, next) => {
      try {
        return fn(req, res, next);
      } catch (e) {
        if (e instanceof audit.AuditError || e instanceof registry.RegisterError) {
          const back = (typeof fallback === 'function' ? fallback(req) : fallback) || req.get('Referer') || base(req);
          if (e.status === 404) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: e.message });
          return res.redirect(withToast(back, e.message, 'error'));
        }
        return next(e);
      }
    };
  }

  function render(res, viewName, req, locals) {
    res.render(viewName, { user: req.user, ws: req.workspace, perms: perms(req, res), base: base(req), fmtDate, ...locals });
  }

  // ------------------------------------------------------------ overview

  app.get('/workspaces/:wsId/iso42001/overview', ...view, (req, res) => {
    if (outcomeScope.isGapAssessmentOnly(req.workspace)) return res.redirect(`/workspaces/${req.workspace.id}/engagement-plan`);
    const model = audit.overview(db, req.workspace, today());
    const systems = registry.list(db, req.workspace);
    const period = { start: model.programme.review_period_start, end: model.programme.review_period_end };
    const populationCounts = Object.fromEntries(Object.keys(registry.POPULATIONS)
      .map(k => [k, registry.population(db, req.workspace, k, period).rows.length]));
    render(res, 'iso42001_overview', req, {
      title: 'ISO 42001 overview', active: 'iso42001-overview', model, systems, populationCounts,
      engagementOverview: aimsOverview.buildOverview(db, req.workspace, req.user.id),
      docs: aimsTemplates.documentationStatus(db, req.workspace.id),
      checklist: audit.checklistStatus(db, req.workspace), STAGE_HINTS: audit.STAGE_HINTS,
      canUseTemplates: !outcomeScope.isGapAssessmentOnly(req.workspace),
      STAGE_LABELS: audit.STAGE_LABELS, STATUS_LABELS: audit.STATUS_LABELS, STATUS_CLASS: audit.STATUS_CLASS,
      populationFor: registry.populationForRequest, today: today(),
    });
  });

  // Gives this client its own copy of the standard certification checklist,
  // or brings an existing copy up to the latest version. Repeatable: requests
  // already worked on keep their status, owner, client hand-off and files.
  app.post('/workspaces/:wsId/iso42001/checklist', ...certManage, handle((req, res) => {
    const before = audit.checklistStatus(db, req.workspace);
    const result = audit.applyStandardChecklist(db, req.workspace, req.user.id);
    logAction(req.user.id, req.workspace.id, before.applied ? 'update_iso42001_checklist' : 'start_iso42001_checklist', 'workspace', req.workspace.id,
      { version: result.version, added: result.added, updated: result.updated, withdrawn: result.withdrawn, kept: result.kept }, auditCtx(req));
    const msg = before.applied
      ? `Checklist brought up to version ${result.version}: ${result.added} added, ${result.updated} updated, ${result.withdrawn} withdrawn`
        + (result.kept ? `, ${result.kept} kept as your own request${result.kept === 1 ? '' : 's'} because work had started on ${result.kept === 1 ? 'it' : 'them'}` : '')
      : `Certification checklist started: ${result.added} requests`;
    res.redirect(withToast(`${base(req)}/requests`, msg));
  }, req => `${base(req)}/overview`));

  app.post('/workspaces/:wsId/iso42001/programme', ...certManage, handle((req, res) => {
    audit.updateProgramme(db, req.workspace, req.user.id, req.body);
    logAction(req.user.id, req.workspace.id, 'update_iso42001_audit_programme', 'workspace', req.workspace.id,
      { stage1_date: req.body.stage1_date || null, stage2_date: req.body.stage2_date || null }, auditCtx(req));
    res.redirect(withToast(`${base(req)}/overview`, 'Audit dates saved'));
  }));

  // ------------------------------------------------------------ request list

  app.get('/workspaces/:wsId/iso42001/requests', ...certView, (req, res) => {
    const filters = {
      stage: ['stage1', 'stage2', 'fieldwork', 'population', 'all'].includes(req.query.stage) ? req.query.stage : 'all',
      status: Object.prototype.hasOwnProperty.call(audit.STATUS_LABELS, req.query.status) || req.query.status === 'open' ? req.query.status : 'all',
      q: String(req.query.q || '').slice(0, 120),
      item: /^ai-(clause|annex)-[a-z0-9.-]+$/.test(String(req.query.item || '')) ? req.query.item : null,
    };
    const all = audit.listRequests(db, req.workspace, today(), { status: 'all', includeWithdrawn: true });
    const rows = audit.listRequests(db, req.workspace, today(), filters);
    const counts = {
      all: all.filter(r => r.effective !== 'withdrawn').length,
      stage1: all.filter(r => r.stage === 'stage1' && r.kind !== 'population' && r.effective !== 'withdrawn').length,
      stage2: all.filter(r => r.stage === 'stage2' && r.kind !== 'population' && r.effective !== 'withdrawn').length,
      population: all.filter(r => r.kind === 'population' && r.effective !== 'withdrawn').length,
      fieldwork: all.filter(r => r.stage === 'fieldwork' && r.effective !== 'withdrawn').length,
      withdrawn: all.filter(r => r.effective === 'withdrawn').length,
    };
    const itemTitle = filters.item ? (db.prepare('SELECT title FROM iso42001_items WHERE id=?').get(filters.item) || {}).title : null;
    render(res, 'iso42001_requests', req, {
      title: 'Certification requests', active: 'iso42001-requests', rows, counts, filters, itemTitle,
      checklist: audit.checklistStatus(db, req.workspace), STAGE_HINTS: audit.STAGE_HINTS,
      programme: audit.programme(db, req.workspace), clientMembers: audit.clientMembers(db, req.workspace),
      STATUS_LABELS: audit.STATUS_LABELS, today: today(),
      rounds: audit.rounds(db, req.workspace),
      cycleAudits: db.prepare(`SELECT id, event_type, planned_date, actual_date, cycle_no FROM iso42001_cert_cycle_events
        WHERE workspace_id=? AND event_key IN ('stage1','stage2','surv1','surv2','recert') ORDER BY cycle_no, planned_date`).all(req.workspace.id),
    });
  });

  // Seal this audit's requests as a round and reset the tracker for the next
  // audit (lib/iso42001-audit.js closeRound).
  app.post('/workspaces/:wsId/iso42001/requests/rounds', ...certManage, handle((req, res) => {
    const id = audit.closeRound(db, req.workspace, req.user.id, req.body);
    logAction(req.user.id, req.workspace.id, 'close_iso42001_audit_round', 'workspace', req.workspace.id, { round_id: id }, auditCtx(req));
    res.redirect(withToast(`${base(req)}/requests/rounds/${id}`, 'Audit round sealed. The request list is ready for the next audit.'));
  }));

  app.get('/workspaces/:wsId/iso42001/requests/rounds/:roundId(\\d+)', ...certView, (req, res) => {
    const round = audit.loadRound(db, req.workspace, req.params.roundId);
    if (!round) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'That audit round was not found.' });
    render(res, 'iso42001_audit_round', req, { title: round.label, active: 'iso42001-requests', round, STATUS_LABELS: audit.STATUS_LABELS, STAGE_LABELS: audit.STAGE_LABELS });
  });

  app.get('/workspaces/:wsId/iso42001/requests/export.csv', ...certView, requirePermission('workspace.export'), (req, res) => {
    const csv = audit.requestsCsv(db, req.workspace, today());
    logAction(req.user.id, req.workspace.id, 'export_iso42001_request_list', 'workspace', req.workspace.id, {}, auditCtx(req));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="iso42001-certification-requests-${today()}.csv"`);
    res.send(csv);
  });

  app.get('/workspaces/:wsId/iso42001/requests/import', ...certManage, (req, res) => {
    const preview = req.query.preview ? audit.loadImport(db, req.workspace, req.query.preview) : null;
    const history = db.prepare(`SELECT i.id, i.source_filename, i.committed_at, u.name AS committed_by_name, i.summary_json
      FROM aims_request_imports i LEFT JOIN users u ON u.id=i.committed_by
      WHERE i.workspace_id=? AND i.status='committed' ORDER BY i.id DESC LIMIT 10`).all(req.workspace.id)
      .map(h => ({ ...h, summary: JSON.parse(h.summary_json) }));
    render(res, 'iso42001_request_import', req, {
      title: 'Import request list', active: 'iso42001-requests',
      preview: preview && preview.status === 'preview' ? preview : null,
      programme: audit.programme(db, req.workspace), history,
    });
  });

  app.post('/workspaces/:wsId/iso42001/requests/import/preview', ...certManage, requestListUpload.single('file'), handle((req, res) => {
    const id = audit.previewImport(db, req.workspace, req.user.id, req.file);
    res.redirect(`${base(req)}/requests/import?preview=${id}`);
  }, req => `${base(req)}/requests/import`));

  app.post('/workspaces/:wsId/iso42001/requests/import/:importId/commit', ...certManage, handle((req, res) => {
    const result = audit.commitImport(db, req.workspace, req.user.id, req.params.importId, req.body);
    logAction(req.user.id, req.workspace.id, 'import_iso42001_request_list', 'workspace', req.workspace.id,
      { import_id: Number(req.params.importId), ...result }, auditCtx(req));
    const parts = [`${result.added} added`, result.updated ? `${result.updated} updated` : null,
      result.withdrawn ? `${result.withdrawn} withdrawn` : null, result.restored ? `${result.restored} restored` : null].filter(Boolean);
    res.redirect(withToast(`${base(req)}/overview`, `Request list imported: ${parts.join(', ')}`));
  }, req => `${base(req)}/requests/import?preview=${encodeURIComponent(req.params.importId)}`));

  app.post('/workspaces/:wsId/iso42001/requests/import/:importId/discard', ...certManage, (req, res) => {
    audit.discardImport(db, req.workspace, req.params.importId);
    res.redirect(withToast(`${base(req)}/requests/import`, 'Preview discarded'));
  });

  app.post('/workspaces/:wsId/iso42001/requests/new', ...certManage, handle((req, res) => {
    const id = audit.addManualRequest(db, req.workspace, req.user.id, req.body);
    logAction(req.user.id, req.workspace.id, 'add_iso42001_audit_request', 'aims_audit_request', id, { ref: req.body.ref }, auditCtx(req));
    res.redirect(withToast(`${base(req)}/requests/${id}`, 'Request added'));
  }, req => `${base(req)}/requests`));

  app.post('/workspaces/:wsId/iso42001/requests/send', ...certManage, requirePermission('client_request.manage'), handle((req, res) => {
    const ids = [].concat(req.body.request_ids || []);
    const result = audit.sendToClient(db, req.workspace, req.user.id, ids, req.body, today());
    logAction(req.user.id, req.workspace.id, 'send_iso42001_requests_to_client', 'workspace', req.workspace.id,
      { sent: result.sent.map(s => s.ref), skipped: result.skipped, assignee_id: result.assignee.id }, auditCtx(req));
    const msg = `${result.sent.length} sent to ${result.assignee.name}${result.skipped.length ? `; ${result.skipped.length} skipped (${result.skipped.slice(0, 3).map(s => `${s.ref} is ${s.reason}`).join(', ')}${result.skipped.length > 3 ? ', ...' : ''})` : ''}`;
    res.redirect(withToast(req.get('Referer') || `${base(req)}/requests`, msg, result.sent.length ? undefined : 'error'));
  }));

  // ------------------------------------------------------------ one request

  function loadEvidenceOptions(req) {
    return db.prepare(`SELECT id, filename, description, uploaded_at FROM evidence
      WHERE workspace_id=? AND superseded_at IS NULL ORDER BY uploaded_at DESC LIMIT 300`).all(req.workspace.id);
  }

  app.get('/workspaces/:wsId/iso42001/requests/:id', ...certView, (req, res) => {
    const detail = audit.requestDetail(db, req.workspace, req.params.id, today());
    if (!detail) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found.' });
    const populationKey = detail.request.kind === 'population' ? registry.populationForRequest(detail.request) : null;
    const prog = audit.programme(db, req.workspace);
    render(res, 'iso42001_request_detail', req, {
      title: `${detail.request.ref} · Certification request`, active: 'iso42001-requests', ...detail,
      programme: prog, clientMembers: audit.clientMembers(db, req.workspace), firmMembers: audit.firmMembers(db, req.workspace),
      evidenceOptions: loadEvidenceOptions(req),
      templates: aimsTemplates.templatesForItems(db, req.workspace.id, detail.request.items)
        .filter(t => !detail.records.some(x => x.record_type === 'document' && x.record_id === t.adoptedDocId)),
      canUseTemplates: !outcomeScope.isGapAssessmentOnly(req.workspace),
      documentOptions: db.prepare(`SELECT id, name, version, status FROM generated_docs WHERE workspace_id=?
        AND status NOT IN ('retired','withdrawn') ORDER BY name`).all(req.workspace.id),
      population: populationKey ? registry.population(db, req.workspace, populationKey,
        { start: prog.review_period_start, end: prog.review_period_end }) : null,
      defaultAskBy: audit.defaultClientDueDate(detail.request, prog, today()), STAGE_HINTS: audit.STAGE_HINTS,
      STATUS_LABELS: audit.STATUS_LABELS, today: today(),
    });
  });

  const requestPage = req => `${base(req)}/requests/${encodeURIComponent(req.params.id)}`;

  app.post('/workspaces/:wsId/iso42001/requests/:id/transition', ...certManage, handle((req, res) => {
    const action = String(req.body.action || '');
    audit.transition(db, req.workspace, req.user.id, req.params.id, action, req.body, today());
    logAction(req.user.id, req.workspace.id, 'transition_iso42001_audit_request', 'aims_audit_request', Number(req.params.id), { action }, auditCtx(req));
    const done = { mark_ready: 'Marked ready to submit', return_to_client: 'Returned to the client', mark_not_applicable: 'Concluded not applicable',
      reopen: 'Reopened', record_submission: 'Submission recorded', auditor_accepted: 'Recorded as accepted', auditor_follow_up: 'Follow-up recorded' }[action] || 'Updated';
    res.redirect(withToast(requestPage(req), done));
  }, requestPage));

  app.post('/workspaces/:wsId/iso42001/requests/:id/send', ...certManage, requirePermission('client_request.manage'), handle((req, res) => {
    const result = audit.sendToClient(db, req.workspace, req.user.id, [req.params.id], req.body, today());
    if (!result.sent.length) throw new audit.AuditError(`Not sent: this request is ${result.skipped[0].reason}.`);
    logAction(req.user.id, req.workspace.id, 'send_iso42001_requests_to_client', 'aims_audit_request', Number(req.params.id),
      { client_request_id: result.sent[0].clientRequestId, assignee_id: result.assignee.id }, auditCtx(req));
    res.redirect(withToast(requestPage(req), `Sent to ${result.assignee.name}`));
  }, requestPage));

  app.post('/workspaces/:wsId/iso42001/requests/:id/owner', ...certManage, handle((req, res) => {
    audit.setOwner(db, req.workspace, req.user.id, req.params.id, req.body.owner_id || null, req.body, today());
    res.redirect(withToast(requestPage(req), 'Owner updated'));
  }, requestPage));

  app.post('/workspaces/:wsId/iso42001/requests/:id/records', ...certManage, handle((req, res) => {
    audit.linkRecord(db, req.workspace, req.user.id, req.params.id, req.body, today());
    logAction(req.user.id, req.workspace.id, 'link_iso42001_audit_record', 'aims_audit_request', Number(req.params.id),
      { record_type: req.body.record_type, record_id: Number(req.body.record_id) }, auditCtx(req));
    res.redirect(withToast(requestPage(req), 'Linked'));
  }, requestPage));

  app.post('/workspaces/:wsId/iso42001/requests/:id/records/:recordId/delete', ...certManage, handle((req, res) => {
    audit.unlinkRecord(db, req.workspace, req.user.id, req.params.id, req.params.recordId, today());
    res.redirect(withToast(requestPage(req), 'Link removed'));
  }, requestPage));

  // Starts the client's document from an ISO 42001 template and links it to
  // the request in one step. If the client already has a document from that
  // template, it is linked instead of a second draft being created.
  app.post('/workspaces/:wsId/iso42001/requests/:id/from-template', ...certManage, requirePermission('document.create'), handle((req, res) => {
    if (outcomeScope.isGapAssessmentOnly(req.workspace)) throw new audit.AuditError('Document implementation is outside this gap-assessment-only engagement.', 409);
    const request = audit.loadRequest(db, req.workspace, req.params.id, today());
    if (!request) throw new audit.AuditError('Request not found.', 404);
    const offered = aimsTemplates.templatesForItems(db, req.workspace.id, request.items).find(t => t.id === Number(req.body.template_id));
    if (!offered) throw new audit.AuditError('That template does not cover this request.');
    let docId = offered.adoptedDocId;
    let created = false;
    db.transaction(() => {
      if (!docId) {
        const tpl = db.prepare('SELECT * FROM doc_templates WHERE id=? AND is_system=1').get(offered.id);
        docId = adoptTemplate(tpl, req.workspace, req.user, null, {}).docId;
        created = true;
      }
      audit.linkRecord(db, req.workspace, req.user.id, request.id, { record_type: 'document', record_id: docId }, today());
    })();
    logAction(req.user.id, req.workspace.id, 'start_iso42001_document_from_template', 'aims_audit_request', request.id,
      { template_id: offered.id, document_id: docId, created }, auditCtx(req));
    res.redirect(withToast(requestPage(req), created
      ? `${offered.name} drafted from the template and linked. Complete and approve it before submission.`
      : `The existing ${offered.name} is linked`));
  }, requestPage));

  function storeEvidence(req, { filename, buffer, storedName, description, tags }) {
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = db.prepare('SELECT id FROM evidence WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1').get(req.workspace.id, sha);
    if (existing) return { id: existing.id, deduped: true, sha };
    const id = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, size_bytes, uploaded_by, description, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.workspace.id, filename, storedName, sha, buffer.length, req.user.id, description, tags).lastInsertRowid);
    return { id, deduped: false, sha };
  }

  app.post('/workspaces/:wsId/iso42001/requests/:id/upload', ...certManage, requirePermission('evidence.upload'), upload.single('file'), handle((req, res) => {
    const cleanup = () => { try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {} };
    const request = audit.loadRequest(db, req.workspace, req.params.id, today());
    if (!request) { cleanup(); throw new audit.AuditError('Request not found.', 404); }
    if (!req.file) throw new audit.AuditError('Choose a file to upload.');
    let stored;
    try {
      db.transaction(() => {
        stored = storeEvidence(req, {
          filename: req.file.originalname, buffer: fs.readFileSync(req.file.path), storedName: req.file.filename,
          description: String(req.body.description || '').trim().slice(0, 2000) || `${request.ref} · ${request.title}`,
          tags: `iso42001-audit, ${request.ref}`,
        });
        audit.linkRecord(db, req.workspace, req.user.id, request.id, { record_type: 'evidence', record_id: stored.id }, today());
      })();
    } catch (e) { cleanup(); throw e; }
    if (stored.deduped) cleanup();
    logAction(req.user.id, req.workspace.id, 'upload_iso42001_audit_evidence', 'aims_audit_request', request.id,
      { evidence_id: stored.id, filename: req.file.originalname, sha256: stored.sha }, auditCtx(req));
    res.redirect(withToast(requestPage(req), stored.deduped ? 'This file was already in the library; linked it' : 'File uploaded and linked'));
  }, requestPage));

  // Attaches the population as it stands today, so the file the auditor
  // received is kept even after the register moves on.
  app.post('/workspaces/:wsId/iso42001/requests/:id/population', ...certManage, requirePermission('evidence.upload'), handle((req, res) => {
    const request = audit.loadRequest(db, req.workspace, req.params.id, today());
    if (!request) throw new audit.AuditError('Request not found.', 404);
    const key = registry.populationForRequest(request);
    if (request.kind !== 'population' || !key) throw new audit.AuditError('This request is not one of the AI register populations.');
    const prog = audit.programme(db, req.workspace);
    const pop = registry.population(db, req.workspace, key, { start: prog.review_period_start, end: prog.review_period_end });
    const buffer = Buffer.from(registry.populationCsv(pop), 'utf8');
    const filename = `${request.ref}-${key}-${today()}.csv`;
    const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${filename.replace(/[^\w.-]/g, '_')}`;
    const dir = path.join(UPLOADS_ROOT, `firm_${req.workspace.firm_id}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, storedName);
    fs.writeFileSync(target, buffer, { mode: 0o600, flag: 'wx' });
    let stored;
    try {
      db.transaction(() => {
        stored = storeEvidence(req, {
          filename, buffer, storedName,
          description: `${pop.title}: ${pop.rows.length} row${pop.rows.length === 1 ? '' : 's'} exported from the AI system register`,
          tags: `iso42001-audit, ${request.ref}, population`,
        });
        audit.linkRecord(db, req.workspace, req.user.id, request.id, { record_type: 'evidence', record_id: stored.id }, today());
      })();
    } catch (e) { try { fs.unlinkSync(target); } catch (_) {} throw e; }
    if (stored.deduped) { try { fs.unlinkSync(target); } catch (_) {} }
    logAction(req.user.id, req.workspace.id, 'attach_iso42001_population', 'aims_audit_request', request.id,
      { population: key, rows: pop.rows.length, evidence_id: stored.id }, auditCtx(req));
    res.redirect(withToast(requestPage(req), stored.deduped ? 'This export was already attached' : `Population attached (${pop.rows.length} rows)`));
  }, requestPage));

  app.post('/workspaces/:wsId/iso42001/requests/:id/samples', ...certManage, handle((req, res) => {
    const added = audit.addSamples(db, req.workspace, req.user.id, req.params.id, req.body, today());
    res.redirect(withToast(requestPage(req), `${added} item${added === 1 ? '' : 's'} added to the sample`));
  }, requestPage));

  app.post('/workspaces/:wsId/iso42001/requests/:id/samples/:sampleId', ...certManage, handle((req, res) => {
    audit.updateSample(db, req.workspace, req.user.id, req.params.id, req.params.sampleId, req.body, today());
    res.redirect(withToast(`${requestPage(req)}#samples`, 'Sample item updated'));
  }, requestPage));

  // ------------------------------------------------------------ AI systems

  // ------------------------------------------------------------ context
  // Internal and external issues and interested parties (lib/aims-context.js).

  app.get('/workspaces/:wsId/iso42001/context', ...view, (req, res) => {
    render(res, 'iso42001_context', req, { title: 'Context and interested parties', active: 'iso42001-context',
      context: aimsContext.list(db, req.workspace), K: aimsContext, edit: req.query.edit || null, today: today() });
  });

  const contextAction = (fn, message) => (req, res) => {
    try {
      fn(req);
      logAction(req.user.id, req.workspace.id, 'update_iso42001_context', 'workspace', req.workspace.id, { path: req.path }, auditCtx(req));
      return res.redirect(withToast(`${base(req)}/context`, message));
    } catch (e) {
      if (e instanceof aimsContext.ContextError) return res.redirect(withToast(`${base(req)}/context`, e.message, 'error'));
      throw e;
    }
  };
  app.post('/workspaces/:wsId/iso42001/context/issues', ...manage, contextAction(req => aimsContext.saveIssue(db, req.workspace, req.user.id, null, req.body), 'Issue added'));
  app.post('/workspaces/:wsId/iso42001/context/issues/:id(\\d+)', ...manage, contextAction(req => aimsContext.saveIssue(db, req.workspace, req.user.id, Number(req.params.id), req.body), 'Issue saved'));
  app.post('/workspaces/:wsId/iso42001/context/issues/:id(\\d+)/delete', ...manage, contextAction(req => aimsContext.deleteIssue(db, req.workspace, Number(req.params.id)), 'Issue removed'));
  app.post('/workspaces/:wsId/iso42001/context/parties', ...manage, contextAction(req => aimsContext.saveParty(db, req.workspace, null, req.body), 'Interested party added'));
  app.post('/workspaces/:wsId/iso42001/context/parties/:id(\\d+)', ...manage, contextAction(req => aimsContext.saveParty(db, req.workspace, Number(req.params.id), req.body), 'Interested party saved'));
  app.post('/workspaces/:wsId/iso42001/context/parties/:id(\\d+)/delete', ...manage, contextAction(req => aimsContext.deleteParty(db, req.workspace, Number(req.params.id)), 'Interested party removed'));

  app.get('/workspaces/:wsId/iso42001/ai-systems', ...view, (req, res) => {
    const prog = audit.programme(db, req.workspace);
    const period = { start: prog.review_period_start, end: prog.review_period_end };
    render(res, 'iso42001_ai_systems', req, {
      title: 'AI system register', active: 'iso42001-ai-systems', systems: registry.list(db, req.workspace),
      populations: Object.keys(registry.POPULATIONS).map(k => registry.population(db, req.workspace, k, period)),
      programme: prog, registry,
    });
  });

  app.get('/workspaces/:wsId/iso42001/ai-systems/new', ...manage, (req, res) => {
    render(res, 'iso42001_ai_system_form', req, { title: 'Add AI system', active: 'iso42001-ai-systems', system: null, registry });
  });

  app.post('/workspaces/:wsId/iso42001/ai-systems', ...manage, handle((req, res) => {
    const id = registry.create(db, req.workspace, req.user.id, req.body);
    logAction(req.user.id, req.workspace.id, 'create_ai_system', 'ai_system', id, { name: req.body.name }, auditCtx(req));
    res.redirect(withToast(`${base(req)}/ai-systems/${id}`, 'AI system added'));
  }, req => `${base(req)}/ai-systems/new`));

  const systemPage = req => `${base(req)}/ai-systems/${encodeURIComponent(req.params.id)}`;

  app.get('/workspaces/:wsId/iso42001/ai-systems/:id', ...view, (req, res) => {
    const detail = registry.detail(db, req.workspace, req.params.id);
    if (!detail) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'AI system not found.' });
    // Risks the consultant has tied to this system (lib/ai-risk.js).
    const systemRisks = db.prepare(`SELECT id, title, likelihood, impact, status, treatment, risk_source FROM risks
      WHERE workspace_id=? AND ai_system_id=? ORDER BY (likelihood * impact) DESC, id`).all(req.workspace.id, detail.system.id);
    render(res, 'iso42001_ai_system_detail', req, { title: detail.system.name, active: 'iso42001-ai-systems', ...detail, registry, edit: req.query.edit === '1',
      systemRisks, riskSourceLabel: require('../lib/ai-risk').SOURCE_LABEL,
      reassessment: registry.reassessment(db, req.workspace, detail.system.id) });
  });

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id', ...manage, handle((req, res) => {
    registry.update(db, req.workspace, req.user.id, req.params.id, req.body);
    logAction(req.user.id, req.workspace.id, 'update_ai_system', 'ai_system', Number(req.params.id), {}, auditCtx(req));
    res.redirect(withToast(systemPage(req), 'Saved'));
  }, req => `${systemPage(req)}?edit=1`));

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/suppliers', ...manage, handle((req, res) => {
    registry.addSupplier(db, req.workspace, req.user.id, req.params.id, req.body);
    res.redirect(withToast(`${systemPage(req)}#suppliers`, 'Supplier added'));
  }, systemPage));

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/suppliers/:supplierId/delete', ...manage, handle((req, res) => {
    registry.removeSupplier(db, req.workspace, req.params.id, req.params.supplierId);
    res.redirect(withToast(`${systemPage(req)}#suppliers`, 'Supplier removed'));
  }, systemPage));

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/links', ...manage, handle((req, res) => {
    registry.link(db, req.workspace, req.user.id, req.params.id, req.body);
    res.redirect(withToast(`${systemPage(req)}#${req.body.link_type === 'incident' ? 'incidents' : 'changes'}`, 'Linked'));
  }, systemPage));

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/links/:type/:targetId/delete', ...manage, handle((req, res) => {
    registry.unlink(db, req.workspace, req.params.id, req.params.type, req.params.targetId);
    res.redirect(withToast(systemPage(req), 'Link removed'));
  }, systemPage));

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/impact-assessments', ...manage, handle((req, res) => {
    const iaId = registry.startAssessment(db, req.workspace, req.user.id, req.params.id);
    logAction(req.user.id, req.workspace.id, 'start_ai_impact_assessment', 'ai_system', Number(req.params.id), { impact_assessment_id: iaId }, auditCtx(req));
    res.redirect(`${systemPage(req)}/impact-assessments/${iaId}`);
  }, systemPage));

  const iaPage = req => `${systemPage(req)}/impact-assessments/${encodeURIComponent(req.params.iaId)}`;

  app.get('/workspaces/:wsId/iso42001/ai-systems/:id/impact-assessments/:iaId', ...view, (req, res) => {
    const system = registry.load(db, req.workspace, req.params.id);
    const ia = system && registry.loadAssessment(db, req.workspace, system.id, req.params.iaId);
    if (!ia) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Impact assessment not found.' });
    const people = db.prepare('SELECT id, name FROM users WHERE id IN (?, ?)').all(ia.prepared_by || 0, ia.approved_by || 0);
    const name = id => (people.find(p => p.id === id) || {}).name || null;
    render(res, 'iso42001_impact_assessment', req, {
      title: `Impact assessment v${ia.version_no} · ${system.name}`, active: 'iso42001-ai-systems', system, ia, registry,
      preparedBy: name(ia.prepared_by), approvedBy: name(ia.approved_by),
      hashMatches: ia.snapshot_hash ? ia.snapshot_hash === registry.contentHash(ia) : null,
      canApprove: ia.status === 'draft' && Number(ia.prepared_by) !== Number(req.user.id),
    });
  });

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/impact-assessments/:iaId', ...manage, handle((req, res) => {
    registry.saveAssessment(db, req.workspace, req.user.id, req.params.id, req.params.iaId, req.body);
    res.redirect(withToast(iaPage(req), 'Draft saved'));
  }, iaPage));

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/impact-assessments/:iaId/approve', ...manage, requirePermission('assessment.signoff'), handle((req, res) => {
    registry.approveAssessment(db, req.workspace, req.user.id, req.params.id, req.params.iaId, req.body);
    logAction(req.user.id, req.workspace.id, 'approve_ai_impact_assessment', 'ai_system', Number(req.params.id),
      { impact_assessment_id: Number(req.params.iaId) }, auditCtx(req));
    res.redirect(withToast(iaPage(req), 'Approved and frozen'));
  }, iaPage));

  app.post('/workspaces/:wsId/iso42001/ai-systems/:id/impact-assessments/:iaId/discard', ...manage, handle((req, res) => {
    registry.discardAssessment(db, req.workspace, req.params.id, req.params.iaId);
    res.redirect(withToast(systemPage(req), 'Draft discarded'));
  }, iaPage));

  app.get('/workspaces/:wsId/iso42001/populations/:key.csv', ...view, requirePermission('workspace.export'), (req, res) => {
    const prog = audit.programme(db, req.workspace);
    const pop = registry.population(db, req.workspace, req.params.key, { start: prog.review_period_start, end: prog.review_period_end });
    if (!pop) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Unknown population.' });
    logAction(req.user.id, req.workspace.id, 'export_iso42001_population', 'workspace', req.workspace.id, { population: pop.key, rows: pop.rows.length }, auditCtx(req));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${pop.key}-${today()}.csv"`);
    res.send(registry.populationCsv(pop));
  });
}

module.exports = { register };
