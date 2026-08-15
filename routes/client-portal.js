'use strict';

// Client collaboration portal. This is the deliberately narrow surface for
// client contributors and the shared request workspace for consultants, client
// owners, and ISMS managers. Every object lookup is workspace-qualified; every
// mutable request operation is versioned; every lifecycle change is written to
// both an append-only request event stream and the global hash-chained audit log.

const fs = require('fs');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const enc = require('../lib/encryption');
const evWrites = require('../lib/evidence-writes');
const docApprovals = require('../lib/doc-approvals');
const delivery = require('../lib/engagement-delivery');
const clientGapAssessment = require('../lib/client-gap-assessment');
const uploadSecurity = require('../lib/upload-security');
const { withToast, auditCtx } = require('../lib/http-helpers');

const REQUEST_TYPES = new Set(['evidence', 'policy', 'control', 'action']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TERMINAL = new Set(['accepted', 'cancelled']);
const CLIENT_FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf',
  'odt', 'ods', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip', 'json', 'xml'
]);
const MAX_TITLE = 180;
const MAX_DESCRIPTION = 12000;
const MAX_NOTE = 8000;
const MAX_COMMENT = 8000;
const clientStatus = value => ({
  draft: 'in preparation', workspace_verified: 'ready for approval', submitted: 'under review',
  changes_requested: 'changes requested', accepted: 'approved', rejected: 'not approved',
  superseded: 'replaced', open: 'open', in_progress: 'in progress', cancelled: 'closed'
}[String(value || '').toLowerCase()] || String(value || '').replace(/_/g, ' '));

function sanitizePolicyHtml(content) {
  return sanitizeHtml(content || '', {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'img']),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      table: ['border', 'cellpadding', 'cellspacing'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      '*': ['class']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
    }
  });
}

const RESPONDER_TRANSITIONS = {
  open: new Set(['in_progress', 'submitted']),
  in_progress: new Set(['submitted']),
  changes_requested: new Set(['in_progress', 'submitted'])
};
const MANAGER_TRANSITIONS = {
  open: new Set(['in_progress', 'cancelled']),
  in_progress: new Set(['submitted', 'cancelled']),
  submitted: new Set(['accepted', 'changes_requested', 'cancelled']),
  changes_requested: new Set(['in_progress', 'cancelled']),
  accepted: new Set(['in_progress']),
  cancelled: new Set(['open'])
};

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction,
          upload, resolveUploadPath, permissionsFor } = deps;

  function isContributor(req) {
    return req.user.user_type === 'client' &&
      require('../lib/rbac').normalizeRole(req.workspace._userRole || req.workspace.role) === 'contributor';
  }

  function can(req, permission) {
    return require('../lib/rbac').hasPermission(permissionsFor(req.user, req.workspace), permission);
  }

  function clean(value, max) {
    const v = value == null ? '' : String(value).trim();
    return v.length > max ? null : v;
  }

  function validDate(value) {
    if (!value) return null;
    const v = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(v + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : false;
  }

  function badRequest(req, res, message) {
    return res.status(400).render('error', { user: req.user, ws: req.workspace, message });
  }

  function decryptRequest(row, wsId) {
    if (!row) return row;
    return {
      ...row,
      description: enc.decryptIfNeeded(row.description, wsId),
      response_note: enc.decryptIfNeeded(row.response_note, wsId)
    };
  }

  function loadRequest(req, id) {
    const row = db.prepare(`SELECT cr.*, assignee.name AS assignee_name, assignee.email AS assignee_email,
        creator.name AS creator_name, reviewer.name AS reviewer_name,
        i.title AS control_title, i.type AS control_type, d.name AS document_name,
        (SELECT COUNT(*) FROM client_request_evidence cre WHERE cre.request_id=cr.id) AS evidence_count,
        (SELECT COUNT(*) FROM comments c WHERE c.workspace_id=cr.workspace_id AND c.parent_type='client_request' AND c.parent_id=CAST(cr.id AS TEXT)) AS comment_count
      FROM client_requests cr
      LEFT JOIN users assignee ON assignee.id=cr.assignee_id
      LEFT JOIN users creator ON creator.id=cr.created_by
      LEFT JOIN users reviewer ON reviewer.id=cr.reviewed_by
      LEFT JOIN iso_items i ON i.id=cr.control_id
      LEFT JOIN generated_docs d ON d.id=cr.document_id AND d.workspace_id=cr.workspace_id
      WHERE cr.id=? AND cr.workspace_id=?`).get(id, req.workspace.id);
    if (!row) return null;
    if (isContributor(req) && row.assignee_id !== req.user.id) return null;
    return decryptRequest(row, req.workspace.id);
  }

  function insertEvent(req, requestId, eventType, fields = {}) {
    const note = fields.note == null ? null : enc.encryptIfNeeded(
      String(fields.note).slice(0, MAX_NOTE), req.workspace.id, !!req.workspace.encryption_enabled);
    db.prepare(`INSERT INTO client_request_events
      (request_id, workspace_id, actor_id, event_type, from_status, to_status, note, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      requestId, req.workspace.id, req.user.id, eventType,
      fields.fromStatus || null, fields.toStatus || null, note,
      fields.metadata ? JSON.stringify(fields.metadata) : null
    );
  }

  function notify(userId, req, title, body, link, severity = 'info') {
    if (!userId || userId === req.user.id) return;
    db.prepare(`INSERT INTO notifications (workspace_id, user_id, category, severity, title, body, link)
      VALUES (?, ?, 'client_request', ?, ?, ?, ?)`).run(
      req.workspace.id, userId, severity, title, body || null, link
    );
  }

  function grantTargetScope(req, assigneeId, controlId, documentId) {
    if (!assigneeId) return;
    const member = db.prepare(`SELECT wm.role, u.user_type FROM workspace_members wm
      INNER JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? AND wm.user_id=? AND u.active=1`).get(req.workspace.id, assigneeId);
    if (!member || require('../lib/rbac').normalizeRole(member.role) !== 'contributor') return;
    const ins = db.prepare(`INSERT OR IGNORE INTO member_scopes
      (workspace_id, user_id, scope_type, scope_id, granted_by) VALUES (?, ?, ?, ?, ?)`);
    if (controlId) ins.run(req.workspace.id, assigneeId, 'control', controlId, req.user.id);
    if (documentId) ins.run(req.workspace.id, assigneeId, 'document', String(documentId), req.user.id);
  }

  function targetAccessible(req, scopeType, scopeId) {
    if (!isContributor(req)) return true;
    const scoped = db.prepare(`SELECT 1 FROM member_scopes
      WHERE workspace_id=? AND user_id=? AND scope_type=? AND scope_id=?`).get(
      req.workspace.id, req.user.id, scopeType, String(scopeId));
    if (scoped) return true;
    const column = scopeType === 'control' ? 'control_id' : 'document_id';
    return !!db.prepare(`SELECT 1 FROM client_requests
      WHERE workspace_id=? AND assignee_id=? AND ${column}=? AND status!='cancelled'`).get(
      req.workspace.id, req.user.id, scopeId);
  }

  function clientMembers(req) {
    return db.prepare(`SELECT u.id, u.name, u.email, wm.role
      FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? AND u.active=1 AND u.user_type='client'
      ORDER BY CASE wm.role WHEN 'client_owner' THEN 1 WHEN 'isms_manager' THEN 2 ELSE 3 END, u.name`).all(req.workspace.id);
  }

  function controlCatalog() {
    return db.prepare(`SELECT id, type, title FROM iso_items
      WHERE type IN ('clause','control') ORDER BY sort_order`).all();
  }

  function documentCatalog(req) {
    return db.prepare(`SELECT id, name, status, version FROM generated_docs
      WHERE workspace_id=? AND status!='retired' ORDER BY name`).all(req.workspace.id);
  }

  app.get('/workspaces/:wsId/client-portal', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => {
      const clientPreview = req.user.user_type === 'firm' && req.query.preview === 'client';
      const members = clientMembers(req);
      const clientPreviewUser = clientPreview
        ? (members.find(member => member.role === 'client_owner') || members[0] || null)
        : null;
      const portalActorId = clientPreviewUser?.id || req.user.id;
      const filters = [];
      const params = [req.workspace.id];
      if (isContributor(req)) {
        filters.push('cr.assignee_id=?');
        params.push(req.user.id);
      }
      const status = String(req.query.status || 'active');
      if (status === 'active') filters.push("cr.status NOT IN ('accepted','cancelled')");
      else if (status === 'closed') filters.push("cr.status IN ('accepted','cancelled')");
      else if (['open','in_progress','submitted','changes_requested'].includes(status)) {
        filters.push('cr.status=?'); params.push(status);
      }
      const where = filters.length ? ' AND ' + filters.join(' AND ') : '';
      const requests = db.prepare(`SELECT cr.*, a.name AS assignee_name, c.name AS creator_name,
          i.title AS control_title, d.name AS document_name,
          (SELECT COUNT(*) FROM client_request_evidence cre WHERE cre.request_id=cr.id) AS evidence_count,
          (SELECT COUNT(*) FROM comments cm WHERE cm.workspace_id=cr.workspace_id AND cm.parent_type='client_request' AND cm.parent_id=CAST(cr.id AS TEXT)) AS comment_count
        FROM client_requests cr
        LEFT JOIN users a ON a.id=cr.assignee_id
        LEFT JOIN users c ON c.id=cr.created_by
        LEFT JOIN iso_items i ON i.id=cr.control_id
        LEFT JOIN generated_docs d ON d.id=cr.document_id AND d.workspace_id=cr.workspace_id
        WHERE cr.workspace_id=?${where}
        ORDER BY CASE cr.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                 CASE WHEN cr.due_date IS NULL THEN 1 ELSE 0 END, cr.due_date, cr.created_at DESC`).all(...params)
        .map(r => decryptRequest(r, req.workspace.id));

      const allVisible = db.prepare(`SELECT status, due_date FROM client_requests cr
        WHERE cr.workspace_id=?${isContributor(req) ? ' AND cr.assignee_id=?' : ''}`).all(
        ...(isContributor(req) ? [req.workspace.id, req.user.id] : [req.workspace.id]));
      const today = new Date().toISOString().slice(0, 10);
      const requestMetrics = {
        active: allVisible.filter(r => !TERMINAL.has(r.status)).length,
        overdue: allVisible.filter(r => !TERMINAL.has(r.status) && r.due_date && r.due_date < today).length,
        awaitingReview: allVisible.filter(r => r.status === 'submitted').length,
        completed: allVisible.filter(r => r.status === 'accepted').length
      };

      const pendingApprovals = db.prepare(`SELECT d.id AS document_id, d.name, d.status, dv.version,
          da.sequence, da.role_label, da.notified_at
        FROM doc_approvers da
        INNER JOIN generated_docs d ON d.id=da.document_id AND d.workspace_id=da.workspace_id
        INNER JOIN doc_versions dv ON dv.id=da.version_id
        WHERE da.workspace_id=? AND da.user_id=? AND da.decision IS NULL
          AND d.current_version_id=da.version_id
        ORDER BY da.sequence, d.name`).all(req.workspace.id, portalActorId);

      const visibleRequestIds = requests.map(r => r.id);
      let recentEvents = [];
      if (visibleRequestIds.length) {
        const marks = visibleRequestIds.map(() => '?').join(',');
        recentEvents = db.prepare(`SELECT e.*, u.name AS actor_name, cr.title AS request_title
          FROM client_request_events e INNER JOIN users u ON u.id=e.actor_id
          INNER JOIN client_requests cr ON cr.id=e.request_id
          WHERE e.request_id IN (${marks}) ORDER BY e.created_at DESC, e.id DESC LIMIT 12`).all(...visibleRequestIds)
          .map(e => ({ ...e, note: enc.decryptIfNeeded(e.note, req.workspace.id) }));
      }

      const deliveryProjection = delivery.getProjection(db, req.workspace, portalActorId, { ensure: false });
      let deliveryWork = [];
      if (deliveryProjection) {
        deliveryWork = deliveryProjection.deliverables.filter(d => d.client_visible &&
          (!isContributor(req) || !d.owner_id || d.owner_id === req.user.id || d.approver_id === req.user.id));
      }
      const deliveryEvidence = deliveryWork.length ? db.prepare(`SELECT de.deliverable_id,e.id,e.filename,e.uploaded_at
        FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id
        WHERE de.workspace_id=? AND de.deliverable_id IN (${deliveryWork.map(() => '?').join(',')}) ORDER BY de.id DESC`)
        .all(req.workspace.id, ...deliveryWork.map(d => d.id)) : [];
      const deliveryComments = db.prepare(`SELECT c.*,u.name user_name FROM comments c JOIN users u ON u.id=c.user_id
        WHERE c.workspace_id=? AND c.parent_type='engagement_deliverable' AND c.internal_only=0 ORDER BY c.id`).all(req.workspace.id)
        .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));

      // Workpaper validation exposes only the consultant-approved client
      // summary. Procedures, sampling detail, evidence judgments and internal
      // notes remain on the firm-only delivery surface.
      const clientValidations = (req.user.user_type === 'client' || clientPreview) && portalActorId ? db.prepare(`SELECT w.id,w.workpaper_ref,w.title,w.client_visible_summary,
          r.ref requirement_ref,r.title requirement_title,f.code framework_code
        FROM consultant_workpapers w JOIN requirements r ON r.id=w.requirement_id JOIN frameworks f ON f.id=r.framework_id
        WHERE w.workspace_id=? AND w.client_validator_id=? AND w.client_visible=1 AND w.requires_client_validation=1 AND w.status='client_validation'
        ORDER BY w.due_date,w.id`).all(req.workspace.id,portalActorId) : [];
      const publishedReports = db.prepare(`SELECT r.id,r.title,r.report_type,r.version_number,r.published_at,p.name published_by_name
        FROM consulting_report_snapshots r LEFT JOIN users p ON p.id=r.published_by
        WHERE r.workspace_id=? AND r.status='published' ORDER BY r.published_at DESC,r.id DESC`).all(req.workspace.id);
      const csfValidations = db.prepare(`SELECT a.id,a.engagement_id,s.code,s.description,e.name engagement_name,cr.assignee_id
        FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id
        JOIN csf_engagements e ON e.id=a.engagement_id
        LEFT JOIN csf_action_links l ON l.assessment_id=a.id AND l.client_request_id IS NOT NULL
        LEFT JOIN client_requests cr ON cr.id=l.client_request_id
        WHERE e.workspace_id=? AND a.status='Reviewed' AND a.client_validation_status='requested'
          ${isContributor(req) ? 'AND cr.assignee_id=?' : ''}
        GROUP BY a.id ORDER BY s.code`).all(req.workspace.id, ...(isContributor(req) ? [req.user.id] : []));
      const csfPublishedReports = db.prepare(`SELECT e.id,e.name,v.id version_id,v.version_number,v.published_at
        FROM csf_engagements e JOIN csf_assessment_versions_v2 v ON v.engagement_id=e.id AND v.is_current=1 AND v.status='published'
        WHERE e.workspace_id=? AND e.status='Published' AND e.visible_in_portal=1 ORDER BY v.published_at DESC`).all(req.workspace.id);

      const consultantContactRaw = db.prepare(`SELECT u.id,u.name,u.email
        FROM users u
        WHERE u.id=? AND u.user_type='firm' AND u.active=1`).get(req.workspace.lead_consultant_id) ||
        db.prepare(`SELECT u.id,u.name,u.email
          FROM workspace_members wm JOIN users u ON u.id=wm.user_id
          WHERE wm.workspace_id=? AND u.user_type='firm' AND u.active=1
          ORDER BY CASE wm.role WHEN 'firm_owner' THEN 1 WHEN 'senior_consultant' THEN 2 ELSE 3 END,u.id LIMIT 1`).get(req.workspace.id) || null;
      const consultantContact = consultantContactRaw ? {
        ...consultantContactRaw,
        display_name: /^(admin|administrator)$/i.test(String(consultantContactRaw.name || '').trim())
          ? 'Engagement team' : consultantContactRaw.name,
        display_email: /@example\.(com|org|net)$/i.test(String(consultantContactRaw.email || ''))
          ? null : consultantContactRaw.email
      } : null;
      const acceptedDelivery = deliveryWork.filter(d => d.status === 'accepted').length;
      const pendingDelivery = deliveryWork
        .filter(d => !['accepted','superseded'].includes(d.status))
        .sort((a,b) => String(a.due_date || '9999-12-31').localeCompare(String(b.due_date || '9999-12-31')))[0] || null;
      const deliverySummary = {
        total: deliveryWork.length,
        accepted: acceptedDelivery,
        progressPct: deliveryWork.length ? Math.round(acceptedDelivery / deliveryWork.length * 100) : 0,
        currentPhase: deliveryProjection?.currentPhase?.name || 'Engagement planning',
        targetDate: deliveryProjection?.plan?.target_completion_date || req.workspace.target_cert_date || null,
        nextTitle: pendingDelivery?.client_title || null,
        nextDue: pendingDelivery?.due_date || null
      };
      const clientDeliveryActions = deliveryWork.filter(d =>
        ((!d.owner_id || d.owner_id === portalActorId) && ['draft','changes_requested'].includes(d.status)) ||
        (d.approver_id === portalActorId && ['submitted','workspace_verified'].includes(d.effective_status))
      );
      const overdueDeliverables = deliveryWork.filter(d =>
        d.due_date && d.due_date < today && !['accepted','superseded'].includes(d.status)).length;
      const awaitingReviewDeliverables = deliveryWork.filter(d =>
        ['submitted','workspace_verified'].includes(d.effective_status)).length;
      const metrics = {
        activeRequests: requestMetrics.active,
        deliverablesToProvide: clientDeliveryActions.filter(d =>
          (!d.owner_id || d.owner_id === req.user.id) && ['draft','changes_requested'].includes(d.status)).length,
        overdue: requestMetrics.overdue + overdueDeliverables,
        awaitingReview: requestMetrics.awaitingReview + awaitingReviewDeliverables,
        overdueRequests: requestMetrics.overdue,
        overdueDeliverables,
        awaitingReviewRequests: requestMetrics.awaitingReview,
        awaitingReviewDeliverables
      };
      metrics.allZero = metrics.activeRequests === 0 && metrics.deliverablesToProvide === 0 &&
        metrics.overdue === 0 && metrics.awaitingReview === 0;
      const gapAssessment = clientGapAssessment.buildClientGapAssessmentProjection(db, req.workspace, {
        assigneeId: isContributor(req) ? req.user.id : null
      });

      res.render('client_portal', {
        user: req.user, ws: req.workspace, active: 'client-portal', title: 'Client portal',
        requests, metrics, pendingApprovals, recentEvents, status,
        canManage: clientPreview ? false : can(req, 'client_request.manage'), members,
        clientPreview, clientPreviewUser,
        controls: can(req, 'client_request.manage') ? controlCatalog() : [],
        documents: can(req, 'client_request.manage') ? documentCatalog(req) : [],
        deliveryPlan: deliveryProjection?.plan || null, deliveryWork, deliveryEvidence, deliveryComments, clientValidations, publishedReports,
        csfValidations, csfPublishedReports, consultantContact, deliverySummary, gapAssessment
      });
    });

  function loadVisibleDelivery(req, id) {
    const row = db.prepare(`SELECT d.*,m.title milestone_title,p.name phase_name,m.source_rule
      FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
      JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE d.id=? AND d.workspace_id=? AND d.client_visible=1`).get(id, req.workspace.id);
    if (!row) return null;
    if (isContributor(req) && row.owner_id && row.owner_id !== req.user.id && row.approver_id !== req.user.id) return null;
    return row;
  }

  app.post('/workspaces/:wsId/client-portal/deliverables/:id/submit', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const row = loadVisibleDelivery(req, req.params.id);
      if (!row) return badRequest(req, res, 'This item is unavailable or is not assigned to you.');
      if (row.owner_id && row.owner_id !== req.user.id && !can(req, 'client_request.manage')) return badRequest(req, res, 'Only the assigned owner can submit this deliverable.');
      if (row.requires_evidence && !db.prepare(`SELECT 1 FROM engagement_delivery_evidence
          WHERE workspace_id=? AND deliverable_id=? LIMIT 1`).get(req.workspace.id, row.id)) {
        return badRequest(req, res, 'Upload and link at least one evidence file before submitting this deliverable.');
      }
      try {
        delivery.transitionDeliverable(db, req.workspace, req.user.id, row.id, 'submit', req.body.note);
        logAction(req.user.id, req.workspace.id, 'client_submit_delivery_deliverable', 'engagement_deliverable', row.id, null, auditCtx(req));
        notify(row.approver_id, req, 'Deliverable awaiting approval: ' + row.title, row.milestone_title, `/workspaces/${req.workspace.id}/client-portal`);
        res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal`, 'Sent for approval.'));
      } catch (error) { res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal`, error.message, 'error')); }
    });

  ['accept','changes','reject'].forEach(action => app.post(`/workspaces/:wsId/client-portal/deliverables/:id/${action}`, requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const row = loadVisibleDelivery(req, req.params.id);
      if (!row) return badRequest(req, res, 'This item is unavailable or is not assigned to you.');
      try {
        delivery.transitionDeliverable(db, req.workspace, req.user.id, row.id, action, req.body.note);
        logAction(req.user.id, req.workspace.id, `client_${action}_delivery_deliverable`, 'engagement_deliverable', row.id, { note: req.body.note }, auditCtx(req));
        notify(row.owner_id, req, `Deliverable ${action}: ${row.title}`, req.body.note, `/workspaces/${req.workspace.id}/client-portal`, action === 'changes' ? 'warning' : 'info');
        res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal`, 'Your response has been saved.'));
      } catch (error) { res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal`, error.message, 'error')); }
    }));

  app.post('/workspaces/:wsId/client-portal/deliverables/:id/comments', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const row = loadVisibleDelivery(req, req.params.id);
      const body = clean(req.body.body, MAX_COMMENT);
      if (!row || !body) return badRequest(req, res, 'A visible delivery item and comment are required.');
      const encrypted = enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled);
      db.prepare(`INSERT INTO comments (workspace_id,parent_type,parent_id,user_id,body,internal_only) VALUES (?,'engagement_deliverable',?,?,?,0)`)
        .run(req.workspace.id, String(row.id), req.user.id, encrypted);
      delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'client_commented', null, null, null);
      logAction(req.user.id, req.workspace.id, 'client_comment_delivery_deliverable', 'engagement_deliverable', row.id, null, auditCtx(req));
      notify(row.owner_id === req.user.id ? row.approver_id : row.owner_id, req, 'Delivery comment: ' + row.title, body.slice(0,180), `/workspaces/${req.workspace.id}/client-portal`);
      res.redirect(`/workspaces/${req.workspace.id}/client-portal#engagement`);
    });

  app.post('/workspaces/:wsId/client-portal/deliverables/:id/evidence', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), upload.single('file'), (req, res) => {
      const cleanup = () => { try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_) {} };
      const row = loadVisibleDelivery(req, req.params.id);
      if (!row || !req.file) { cleanup(); return badRequest(req, res, !row ? 'This item is unavailable or is not assigned to you.' : 'Choose a file to upload.'); }
      if (row.owner_id && row.owner_id !== req.user.id && !can(req, 'client_request.manage')) { cleanup(); return badRequest(req, res, 'Only the assigned owner can add evidence.'); }
      const inspection = uploadSecurity.validateUpload(req.file, CLIENT_FILE_EXTENSIONS);
      if (!inspection.ok) { cleanup(); logAction(req.user.id, req.workspace.id, 'reject_client_upload', 'engagement_deliverable', row.id, { filename: req.file.originalname, reason: inspection.message }, auditCtx(req)); return badRequest(req, res, inspection.message); }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
      let evidenceId;
      db.transaction(() => {
        const existing = db.prepare(`SELECT id FROM evidence WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
        if (existing) { evidenceId = existing.id; cleanup(); }
        else evidenceId = db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description,tags) VALUES (?,?,?,?,?,?,?,?)`)
          .run(req.workspace.id, req.file.originalname, req.file.filename, sha, req.file.size, req.user.id, row.title, `client-portal, engagement-deliverable-${row.id}`).lastInsertRowid;
        db.prepare(`INSERT OR IGNORE INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`).run(req.workspace.id, row.id, evidenceId, req.user.id);
        delivery.event(db, req.workspace.id, row.plan_id, req.user.id, 'deliverable', row.id, 'client_evidence_linked', null, null, { evidenceId, sha });
      })();
      logAction(req.user.id, req.workspace.id, 'client_upload_delivery_evidence', 'engagement_deliverable', row.id, { evidence_id: evidenceId }, auditCtx(req));
      notify(row.approver_id, req, 'Evidence added: ' + row.title, req.file.originalname, `/workspaces/${req.workspace.id}/client-portal`);
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal#engagement`, 'File added.'));
    });

  app.get('/workspaces/:wsId/client-portal/deliverables/:id/evidence/:evidenceId/download', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => {
      const deliverable = loadVisibleDelivery(req, req.params.id);
      if (!deliverable) return res.status(404).send('Not found');
      const row = db.prepare(`SELECT e.* FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id
        WHERE de.deliverable_id=? AND de.evidence_id=? AND de.workspace_id=? AND e.workspace_id=?`).get(deliverable.id, req.params.evidenceId, req.workspace.id, req.workspace.id);
      if (!row) return res.status(404).send('Not found');
      const filePath = resolveUploadPath(row.stored_path, req.workspace.firm_id);
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File missing');
      logAction(req.user.id, req.workspace.id, 'client_download_delivery_evidence', 'evidence', row.id, { deliverable_id: deliverable.id }, auditCtx(req));
      res.download(filePath, row.filename);
    });

  app.post('/workspaces/:wsId/client-portal/requests', requireAuth, requireWorkspace,
    requirePermission('client_request.manage'), (req, res) => {
      const type = String(req.body.request_type || '');
      const priority = String(req.body.priority || 'normal');
      const title = clean(req.body.title, MAX_TITLE);
      const description = clean(req.body.description, MAX_DESCRIPTION);
      const dueDate = validDate(req.body.due_date);
      const assigneeId = req.body.assignee_id ? parseInt(req.body.assignee_id, 10) : null;
      const controlId = req.body.control_id ? String(req.body.control_id) : null;
      const documentId = req.body.document_id ? parseInt(req.body.document_id, 10) : null;
      if (!REQUEST_TYPES.has(type)) return badRequest(req, res, 'Choose a valid request type.');
      if (!PRIORITIES.has(priority)) return badRequest(req, res, 'Choose a valid priority.');
      if (!title || title === null) return badRequest(req, res, `Title is required and must be under ${MAX_TITLE} characters.`);
      if (description === null) return badRequest(req, res, `Description must be under ${MAX_DESCRIPTION} characters.`);
      if (dueDate === false) return badRequest(req, res, 'Due date is invalid.');
      if (type === 'control' && !controlId) return badRequest(req, res, 'A control request must reference a control or clause.');
      if (type === 'policy' && !documentId) return badRequest(req, res, 'A policy request must reference a document.');
      if (assigneeId && !db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
          WHERE wm.workspace_id=? AND wm.user_id=? AND u.active=1 AND u.user_type='client'`).get(req.workspace.id, assigneeId)) {
        return badRequest(req, res, 'The assignee is not an active client member of this workspace.');
      }
      if (controlId && !db.prepare(`SELECT 1 FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(controlId)) {
        return badRequest(req, res, 'The selected control does not exist.');
      }
      if (documentId && !db.prepare('SELECT 1 FROM generated_docs WHERE id=? AND workspace_id=?').get(documentId, req.workspace.id)) {
        return badRequest(req, res, 'The selected document does not belong to this workspace.');
      }

      let id;
      db.transaction(() => {
        id = db.prepare(`INSERT INTO client_requests
          (workspace_id, request_type, title, description, priority, assignee_id, control_id, document_id, due_date, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          req.workspace.id, type, title,
          enc.encryptIfNeeded(description || null, req.workspace.id, !!req.workspace.encryption_enabled),
          priority, assigneeId, controlId, documentId, dueDate || null, req.user.id
        ).lastInsertRowid;
        insertEvent(req, id, 'created', { metadata: { type, priority, assignee_id: assigneeId, control_id: controlId, document_id: documentId, due_date: dueDate || null } });
        grantTargetScope(req, assigneeId, controlId, documentId);
      })();
      logAction(req.user.id, req.workspace.id, 'create_client_request', 'client_request', id,
        { type, priority, assignee_id: assigneeId, control_id: controlId, document_id: documentId, due_date: dueDate || null }, auditCtx(req));
      notify(assigneeId, req, 'New client request: ' + title, description,
        `/workspaces/${req.workspace.id}/client-portal/requests/${id}`, priority === 'urgent' ? 'urgent' : 'info');
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${id}`, 'Client request created'));
    });

  app.get('/workspaces/:wsId/client-portal/requests/:id', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => {
      const request = loadRequest(req, req.params.id);
      if (!request) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found or not assigned to you.' });
      const evidence = db.prepare(`SELECT e.*, u.name AS uploader, cre.linked_at
        FROM client_request_evidence cre INNER JOIN evidence e ON e.id=cre.evidence_id
        LEFT JOIN users u ON u.id=e.uploaded_by
        WHERE cre.request_id=? AND e.workspace_id=? ORDER BY cre.linked_at DESC`).all(request.id, req.workspace.id);
      const comments = db.prepare(`SELECT c.*, u.name AS user_name FROM comments c
        INNER JOIN users u ON u.id=c.user_id
        WHERE c.workspace_id=? AND c.parent_type='client_request' AND c.parent_id=?
          ${req.user.user_type === 'client' ? 'AND c.internal_only=0' : ''}
        ORDER BY c.created_at, c.id`).all(req.workspace.id, String(request.id))
        .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
      const events = db.prepare(`SELECT e.*, u.name AS actor_name FROM client_request_events e
        INNER JOIN users u ON u.id=e.actor_id WHERE e.request_id=? AND e.workspace_id=?
        ORDER BY e.created_at, e.id`).all(request.id, req.workspace.id)
        .map(e => ({ ...e, note: enc.decryptIfNeeded(e.note, req.workspace.id) }));
      const allowedTransitions = can(req, 'client_request.manage')
        ? [...(MANAGER_TRANSITIONS[request.status] || [])]
        : (request.assignee_id === req.user.id ? [...(RESPONDER_TRANSITIONS[request.status] || [])] : []);
      res.render('client_request_detail', {
        user: req.user, ws: req.workspace, active: 'client-portal', title: request.title,
        request, evidence, comments, events, allowedTransitions,
        canManage: can(req, 'client_request.manage'),
        canRespond: can(req, 'client_request.respond') && (request.assignee_id === req.user.id || can(req, 'client_request.manage')),
        members: clientMembers(req)
      });
    });

  app.post('/workspaces/:wsId/client-portal/requests/:id/transition', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const request = loadRequest(req, req.params.id);
      if (!request) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found or not assigned to you.' });
      const managing = can(req, 'client_request.manage');
      if (!managing && request.assignee_id !== req.user.id) return res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'Only the assigned client user can respond to this request.' });
      const target = String(req.body.status || '');
      const allowed = managing ? MANAGER_TRANSITIONS[request.status] : RESPONDER_TRANSITIONS[request.status];
      if (!allowed || !allowed.has(target)) return badRequest(req, res, `This request cannot move from ${clientStatus(request.status)} to ${target ? clientStatus(target) : 'that status'}.`);
      const note = clean(req.body.response_note, MAX_NOTE);
      if (note === null) return badRequest(req, res, `Response notes must be under ${MAX_NOTE} characters.`);
      if (target === 'changes_requested' && !note) return badRequest(req, res, 'Explain the changes required before sending the request back.');
      const evidenceQuality = String(req.body.evidence_quality || request.evidence_quality || 'not_reviewed');
      if (!['not_reviewed','insufficient','partially_sufficient','sufficient'].includes(evidenceQuality)) {
        return badRequest(req, res, 'Choose a valid evidence-quality conclusion.');
      }
      if (managing && target === 'accepted' && request.workpaper_id && evidenceQuality !== 'sufficient') {
        return badRequest(req, res, 'Structured workpaper requests can only be accepted when the submitted evidence is concluded sufficient. Request changes when evidence remains incomplete.');
      }
      const version = parseInt(req.body.version, 10);
      if (!Number.isInteger(version)) return badRequest(req, res, 'Refresh the page before updating this request.');
      const encryptedNote = enc.encryptIfNeeded(note || request.response_note || null,
        req.workspace.id, !!req.workspace.encryption_enabled);
      const result = db.prepare(`UPDATE client_requests SET status=?, response_note=?, reviewed_by=?, evidence_quality=?,
          submitted_at=CASE WHEN ?='submitted' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
          closed_at=CASE WHEN ? IN ('accepted','cancelled') THEN CURRENT_TIMESTAMP ELSE NULL END,
          updated_at=CURRENT_TIMESTAMP, version=version+1
        WHERE id=? AND workspace_id=? AND version=?`).run(
        target, encryptedNote || null, managing && ['accepted','changes_requested'].includes(target) ? req.user.id : request.reviewed_by, evidenceQuality,
        target, target, request.id, req.workspace.id, version
      );
      if (!result.changes) return res.status(409).render('error', { user: req.user, ws: req.workspace, message: 'This request changed in another session. Refresh it before applying your decision.' });
      insertEvent(req, request.id, 'status_changed', { fromStatus: request.status, toStatus: target, note: note || null });
      logAction(req.user.id, req.workspace.id, 'transition_client_request', 'client_request', request.id,
        { from: request.status, to: target }, auditCtx(req));
      const notifyUser = target === 'submitted' ? request.created_by : request.assignee_id;
      notify(notifyUser, req, `Request ${target.replace('_', ' ')}: ${request.title}`, note,
        `/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`,
        target === 'changes_requested' ? 'warning' : 'info');
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`, `Request is now ${clientStatus(target)}`));
    });

  app.post('/workspaces/:wsId/client-portal/requests/:id/assign', requireAuth, requireWorkspace,
    requirePermission('client_request.manage'), (req, res) => {
      const request = loadRequest(req, req.params.id);
      if (!request) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found.' });
      const assigneeId = req.body.assignee_id ? parseInt(req.body.assignee_id, 10) : null;
      if (assigneeId && !db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
        WHERE wm.workspace_id=? AND wm.user_id=? AND u.active=1 AND u.user_type='client'`).get(req.workspace.id, assigneeId)) {
        return badRequest(req, res, 'The assignee is not an active client member of this workspace.');
      }
      const version = parseInt(req.body.version, 10);
      const result = db.prepare(`UPDATE client_requests SET assignee_id=?, updated_at=CURRENT_TIMESTAMP, version=version+1
        WHERE id=? AND workspace_id=? AND version=?`).run(assigneeId, request.id, req.workspace.id, version);
      if (!result.changes) return res.status(409).render('error', { user: req.user, ws: req.workspace, message: 'This request changed in another session. Refresh it before reassigning.' });
      grantTargetScope(req, assigneeId, request.control_id, request.document_id);
      insertEvent(req, request.id, 'assigned', { metadata: { from: request.assignee_id, to: assigneeId } });
      logAction(req.user.id, req.workspace.id, 'assign_client_request', 'client_request', request.id,
        { from: request.assignee_id, to: assigneeId }, auditCtx(req));
      notify(assigneeId, req, 'Client request assigned: ' + request.title, request.description,
        `/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`);
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`, 'Assignee updated'));
    });

  app.post('/workspaces/:wsId/client-portal/requests/:id/comments', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const request = loadRequest(req, req.params.id);
      if (!request) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found or not assigned to you.' });
      const body = clean(req.body.body, MAX_COMMENT);
      if (!body || body === null) return badRequest(req, res, `Comment is required and must be under ${MAX_COMMENT} characters.`);
      const internal = req.body.internal_only === '1' && req.user.user_type === 'firm' ? 1 : 0;
      const encrypted = enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled);
      db.transaction(() => {
        db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
          VALUES (?, 'client_request', ?, ?, ?, ?)`).run(req.workspace.id, String(request.id), req.user.id, encrypted, internal);
        insertEvent(req, request.id, 'commented', { note: internal ? 'Internal comment added' : body.slice(0, 500), metadata: { internal: !!internal } });
      })();
      logAction(req.user.id, req.workspace.id, 'comment_client_request', 'client_request', request.id, { internal: !!internal }, auditCtx(req));
      notify(request.assignee_id === req.user.id ? request.created_by : request.assignee_id, req,
        'New comment: ' + request.title, internal ? null : body.slice(0, 180),
        `/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`);
      res.redirect(`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}#discussion`);
    });

  app.post('/workspaces/:wsId/client-portal/requests/:id/evidence', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), upload.single('file'), (req, res) => {
      const cleanup = () => { try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {} };
      const request = loadRequest(req, req.params.id);
      if (!request) { cleanup(); return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Request not found or not assigned to you.' }); }
      if (!req.file) return badRequest(req, res, 'Choose a file to upload.');
      if (TERMINAL.has(request.status)) { cleanup(); return badRequest(req, res, 'Closed requests cannot receive new evidence. Reopen the request first.'); }
      const managing = can(req, 'client_request.manage');
      if (!managing && request.assignee_id !== req.user.id) { cleanup(); return res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'Only the assignee can upload evidence to this request.' }); }
      const inspection = uploadSecurity.validateUpload(req.file, CLIENT_FILE_EXTENSIONS);
      if (!inspection.ok) { cleanup(); logAction(req.user.id, req.workspace.id, 'reject_client_upload', 'client_request', request.id, { filename: req.file.originalname, reason: inspection.message }, auditCtx(req)); return badRequest(req, res, inspection.message); }
      const description = clean(req.body.description, 2000);
      if (description === null) { cleanup(); return badRequest(req, res, 'Evidence description must be under 2,000 characters.'); }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
      let evidenceId;
      let deduped = false;
      db.transaction(() => {
        const existing = db.prepare(`SELECT id FROM evidence WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL
          ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
        if (existing) {
          evidenceId = existing.id;
          deduped = true;
          cleanup();
        } else {
          evidenceId = db.prepare(`INSERT INTO evidence
            (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            req.workspace.id, request.control_id || null, req.file.originalname, req.file.filename,
            sha, req.file.size, req.user.id, description || request.title,
            `client-portal, request-${request.id}`
          ).lastInsertRowid;
        }
        db.prepare(`INSERT OR IGNORE INTO client_request_evidence (request_id, evidence_id, linked_by)
          VALUES (?, ?, ?)`).run(request.id, evidenceId, req.user.id);
        if (request.control_id) evWrites.attachIsoControl(db, evidenceId, request.control_id, null);
        db.prepare(`UPDATE client_requests SET updated_at=CURRENT_TIMESTAMP, version=version+1 WHERE id=?`).run(request.id);
        insertEvent(req, request.id, 'evidence_linked', { metadata: { evidence_id: evidenceId, filename: req.file.originalname, sha256: sha, deduped } });
      })();
      logAction(req.user.id, req.workspace.id, deduped ? 'link_existing_evidence_to_client_request' : 'upload_client_request_evidence',
        'client_request', request.id, { evidence_id: evidenceId, filename: req.file.originalname, sha256: sha }, auditCtx(req));
      notify(request.created_by, req, 'Evidence added: ' + request.title, req.file.originalname,
        `/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`);
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/requests/${request.id}`, deduped ? 'Existing evidence linked' : 'Evidence uploaded'));
    });

  app.get('/workspaces/:wsId/client-portal/requests/:id/evidence/:evidenceId/download', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => {
      const request = loadRequest(req, req.params.id);
      if (!request) return res.status(404).send('Not found');
      const evidence = db.prepare(`SELECT e.* FROM client_request_evidence cre
        INNER JOIN evidence e ON e.id=cre.evidence_id
        WHERE cre.request_id=? AND cre.evidence_id=? AND e.workspace_id=?`).get(request.id, req.params.evidenceId, req.workspace.id);
      if (!evidence) return res.status(404).send('Not found');
      const fp = resolveUploadPath(evidence.stored_path, req.workspace.firm_id);
      if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
      logAction(req.user.id, req.workspace.id, 'download_client_request_evidence', 'evidence', evidence.id,
        { request_id: request.id }, auditCtx(req));
      res.download(fp, evidence.filename);
    });

  app.get('/workspaces/:wsId/client-portal/controls/:isoId', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => {
      const isoId = String(req.params.isoId);
      if (!targetAccessible(req, 'control', isoId)) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Control not found or not assigned to you.' });
      const item = db.prepare(`SELECT * FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(isoId);
      if (!item) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Control not found.' });
      const state = db.prepare(`SELECT * FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, isoId) || {};
      const comments = db.prepare(`SELECT c.*, u.name AS user_name FROM comments c INNER JOIN users u ON u.id=c.user_id
        WHERE c.workspace_id=? AND c.parent_type='iso_item' AND c.parent_id=?
          ${req.user.user_type === 'client' ? 'AND c.internal_only=0' : ''}
        ORDER BY c.created_at, c.id`).all(req.workspace.id, isoId)
        .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
      const evidence = db.prepare(`SELECT DISTINCT e.id, e.filename, e.description, e.uploaded_at, e.sha256, u.name AS uploader
        FROM evidence e INNER JOIN evidence_requirement_links erl ON erl.evidence_id=e.id
        INNER JOIN requirements rq ON rq.id=erl.requirement_id INNER JOIN frameworks f ON f.id=rq.framework_id
        LEFT JOIN users u ON u.id=e.uploaded_by
        WHERE e.workspace_id=? AND f.code='iso27001' AND rq.ref=? AND e.superseded_at IS NULL
        ORDER BY e.uploaded_at DESC`).all(req.workspace.id, isoId);
      res.render('client_portal_control', { user: req.user, ws: req.workspace, active: 'client-portal', title: item.title, item, state, comments, evidence });
    });

  app.post('/workspaces/:wsId/client-portal/controls/:isoId/comments', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const isoId = String(req.params.isoId);
      if (!targetAccessible(req, 'control', isoId)) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Control not found or not assigned to you.' });
      if (!db.prepare(`SELECT 1 FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(isoId)) return res.status(404).send('Not found');
      const body = clean(req.body.body, MAX_COMMENT);
      if (!body || body === null) return badRequest(req, res, `Comment is required and must be under ${MAX_COMMENT} characters.`);
      const internal = req.body.internal_only === '1' && req.user.user_type === 'firm' ? 1 : 0;
      db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
        VALUES (?, 'iso_item', ?, ?, ?, ?)`).run(req.workspace.id, isoId, req.user.id,
        enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled), internal);
      logAction(req.user.id, req.workspace.id, 'client_portal_control_comment', 'control', isoId, { internal: !!internal }, auditCtx(req));
      res.redirect(`/workspaces/${req.workspace.id}/client-portal/controls/${encodeURIComponent(isoId)}#discussion`);
    });

  app.get('/workspaces/:wsId/client-portal/policies/:id', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => {
      const documentId = parseInt(req.params.id, 10);
      if (!targetAccessible(req, 'document', documentId)) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Policy not found or not assigned to you.' });
      const raw = db.prepare(`SELECT d.*, u.name AS creator_name FROM generated_docs d LEFT JOIN users u ON u.id=d.created_by
        WHERE d.id=? AND d.workspace_id=?`).get(documentId, req.workspace.id);
      if (!raw) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Policy not found.' });
      const doc = { ...raw, content: sanitizePolicyHtml(enc.decryptIfNeeded(raw.content, req.workspace.id)) };
      const currentVersion = doc.current_version_id ? db.prepare('SELECT * FROM doc_versions WHERE id=? AND workspace_id=?').get(doc.current_version_id, req.workspace.id) : null;
      const approvers = currentVersion ? docApprovals.listChain(db, currentVersion.id) : [];
      const comments = db.prepare(`SELECT c.*, u.name AS user_name FROM comments c INNER JOIN users u ON u.id=c.user_id
        WHERE c.workspace_id=? AND c.parent_type='document' AND c.parent_id=?
          ${req.user.user_type === 'client' ? 'AND c.internal_only=0' : ''}
        ORDER BY c.created_at, c.id`).all(req.workspace.id, String(documentId))
        .map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
      const myApproval = approvers.find(a => a.kind === 'internal' && a.user_id === req.user.id && !a.decision);
      const next = currentVersion ? docApprovals.nextPending(db, currentVersion.id) : null;
      const isMyTurn = !!(myApproval && next && next.kind === 'internal' && next.row.id === myApproval.id);
      res.render('client_portal_policy', { user: req.user, ws: req.workspace, active: 'client-portal', title: doc.name, doc, currentVersion, approvers, comments, myApproval, isMyTurn });
    });

  app.post('/workspaces/:wsId/client-portal/policies/:id/comments', requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const documentId = parseInt(req.params.id, 10);
      if (!targetAccessible(req, 'document', documentId)) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Policy not found or not assigned to you.' });
      if (!db.prepare('SELECT 1 FROM generated_docs WHERE id=? AND workspace_id=?').get(documentId, req.workspace.id)) return res.status(404).send('Not found');
      const body = clean(req.body.body, MAX_COMMENT);
      if (!body || body === null) return badRequest(req, res, `Comment is required and must be under ${MAX_COMMENT} characters.`);
      const internal = req.body.internal_only === '1' && req.user.user_type === 'firm' ? 1 : 0;
      db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
        VALUES (?, 'document', ?, ?, ?, ?)`).run(req.workspace.id, String(documentId), req.user.id,
        enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled), internal);
      logAction(req.user.id, req.workspace.id, 'client_portal_policy_comment', 'document', documentId, { internal: !!internal }, auditCtx(req));
      res.redirect(`/workspaces/${req.workspace.id}/client-portal/policies/${documentId}#discussion`);
    });
}

module.exports = { register, REQUEST_TYPES, PRIORITIES, RESPONDER_TRANSITIONS, MANAGER_TRANSITIONS };
