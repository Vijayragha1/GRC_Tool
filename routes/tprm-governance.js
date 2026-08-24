'use strict';

// Governed TPRM follow-through routes. Client owners submit completion facts;
// consultancy users review them; only a consultancy manager can waive an
// obligation or close a service period. No route here can make the client's
// final onboarding decision.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rbac = require('../lib/rbac');
const domain = require('../lib/tprm-domain');
const serviceCapabilities = require('../lib/tprm-capabilities');
const { withToast, auditCtx } = require('../lib/http-helpers');

function safeDownloadName(value) {
  const name = path.basename(String(value || 'condition-evidence'))
    .replace(/[^\x20-\x7E]/g, '_').replace(/[\r\n\0"\\]/g, '_').slice(0, 240);
  return name || 'condition-evidence';
}

const SAFE_DOWNLOAD_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.xml': 'application/xml',
});

function safeSourceExtension(value) {
  const extension = path.extname(String(value || '')).toLowerCase();
  return Object.prototype.hasOwnProperty.call(SAFE_DOWNLOAD_TYPES, extension) ? extension : '';
}

function clientSafeReleaseName(label, sourceFilename) {
  const extension = safeSourceExtension(sourceFilename);
  let name = safeDownloadName(label || 'released-evidence');
  const labelledExtension = path.extname(name).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SAFE_DOWNLOAD_TYPES, labelledExtension)) {
    name = name.slice(0, -labelledExtension.length);
  }
  name = name.replace(/[. ]+$/g, '') || 'released-evidence';
  return `${name.slice(0, Math.max(1, 240 - extension.length))}${extension}`;
}

function digestFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function register(app, deps) {
  const {
    db, requireAuth, requireWorkspace, requirePermission, logAction,
    upload, resolveUploadPath,
  } = deps;
  if (!upload || typeof upload.single !== 'function' || typeof resolveUploadPath !== 'function') {
    throw new Error('TPRM governance routes require the inspected upload facade and protected upload-path resolver.');
  }

  function firmOnly(req, res, next) {
    if (req.user?.user_type !== 'firm') {
      return res.status(403).render('error', {
        user: req.user, ws: req.workspace,
        message: 'This condition review action belongs to the consulting team.',
      });
    }
    next();
  }

  function clientMember(req, res, next) {
    if (req.user?.user_type !== 'client') {
      return res.status(403).render('error', {
        user: req.user, ws: req.workspace,
        message: 'Use a client account to complete an assigned onboarding condition.',
      });
    }
    const member = db.prepare(`SELECT wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? AND wm.user_id=? AND u.user_type='client' AND u.active=1`).get(
        req.workspace.id, req.user.id
      );
    if (!member || !['client_owner', 'client_admin', 'isms_manager'].includes(member.role)) {
      return res.status(403).render('error', {
        user: req.user, ws: req.workspace,
        message: 'This action requires an active client sponsor or security coordinator in this workspace.',
      });
    }
    req.tprmClientRole = member.role;
    next();
  }

  function assignedClientOwner(req, res, next) {
    clientMember(req, res, () => {
      if (!['client_owner', 'client_admin'].includes(req.tprmClientRole)) {
        return res.status(403).render('error', {
          user: req.user, ws: req.workspace,
          message: 'Only the client sponsor assigned to this condition can submit its completion.',
        });
      }
      next();
    });
  }

  function managerOnly(req, res, next) {
    if (req.user?.user_type !== 'firm' || !rbac.isManager(req.user.firm_role)) {
      return res.status(403).render('error', {
        user: req.user, ws: req.workspace,
        message: 'Only a consultancy manager can approve a condition waiver or close Third-party risk.',
      });
    }
    next();
  }

  function cleanupStaged(file) {
    if (!file?.path) return;
    try { fs.unlinkSync(file.path); } catch (_) {}
  }

  function protectedUploadPath(storedPath, firmId) {
    const token = String(storedPath || '');
    if (!token || path.basename(token) !== token) return null;
    const candidate = resolveUploadPath(token, firmId);
    if (!candidate) return null;
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
      const uploadsRoot = fs.realpathSync(path.join(__dirname, '..', 'uploads'));
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate !== uploadsRoot && !realCandidate.startsWith(`${uploadsRoot}${path.sep}`)) return null;
      return realCandidate;
    } catch (_) {
      return null;
    }
  }

  function sendProtectedDownload(res, filePath, options = {}) {
    const extension = safeSourceExtension(options.sourceFilename);
    const contentType = SAFE_DOWNLOAD_TYPES[extension] || 'application/octet-stream';
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(options.downloadName)}"`);
    return res.sendFile(filePath);
  }

  function statusFor(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    return [400, 403, 404, 409].includes(status) ? status : 500;
  }

  function actionFailure(req, res, error, fallback, file = null) {
    cleanupStaged(file);
    const status = statusFor(error);
    if (status === 403 || status === 404 || status === 409 || status === 500) {
      return res.status(status).render('error', {
        user: req.user, ws: req.workspace,
        message: status === 500 ? 'The condition action could not be completed safely.' : error.message,
      });
    }
    return res.redirect(303, withToast(req.get('Referer') || fallback, error.message, 'error'));
  }

  const clientBase = [requireAuth, requireWorkspace, requirePermission('tprm.client_portal.view'),
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION), assignedClientOwner];
  const firmReview = [requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.conditions.manage'),
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.MANAGED_CONDITION_EXECUTION)];

  app.post('/workspaces/:wsId/client-portal/tprm/:supplierId/conditions/:conditionId/start',
    ...clientBase, (req, res) => {
      const fallback = `/workspaces/${req.workspace.id}/client-portal/tprm/${req.params.supplierId}#conditions`;
      try {
        const result = domain.clientStartConditionWork(db, {
          workspaceId: req.workspace.id,
          supplierId: req.params.supplierId,
          conditionId: req.params.conditionId,
          actorId: req.user.id,
          expectedStatus: req.body.expected_status,
          idempotencyKey: req.body.idempotency_key || null,
        });
        if (typeof logAction === 'function') logAction(
          req.user.id, req.workspace.id, 'start_tprm_condition_work', 'tprm_condition', result.condition.id,
          { supplier_id: result.condition.supplier_id, event_id: result.event.id, client_owned: true }, auditCtx(req)
        );
        return res.redirect(303, withToast(fallback, 'Condition marked in progress. Add a completion statement when the work is ready for review.', 'success'));
      } catch (error) {
        return actionFailure(req, res, error, fallback);
      }
    });

  app.post('/workspaces/:wsId/client-portal/tprm/:supplierId/conditions/:conditionId/submit',
    ...clientBase, upload.single('evidence_file'), async (req, res) => {
      const fallback = `/workspaces/${req.workspace.id}/client-portal/tprm/${req.params.supplierId}#conditions`;
      try {
        const evidence = req.file ? {
          originalFilename: req.file.originalname,
          storedPath: req.file.filename,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          sha256: await digestFile(req.file.path),
        } : null;
        const result = domain.clientSubmitCondition(db, {
          workspaceId: req.workspace.id,
          supplierId: req.params.supplierId,
          conditionId: req.params.conditionId,
          actorId: req.user.id,
          expectedStatus: req.body.expected_status,
          completionStatement: req.body.completion_statement,
          evidence,
          idempotencyKey: req.body.idempotency_key || null,
        });
        if (result.replayed && req.file) cleanupStaged(req.file);
        if (typeof logAction === 'function') logAction(
          req.user.id, req.workspace.id, 'submit_tprm_condition_completion', 'tprm_condition', result.condition.id,
          {
            supplier_id: result.condition.supplier_id, event_id: result.event.id,
            evidence_id: result.evidence?.id || null, evidence_sha256: result.evidence?.sha256 || null,
            client_owned: true, consultancy_verified: false,
          }, auditCtx(req)
        );
        return res.redirect(303, withToast(fallback, 'Completion submitted to the consultancy for independent review.', 'success'));
      } catch (error) {
        return actionFailure(req, res, error, fallback, req.file);
      }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:supplierId/conditions/:conditionId/request-changes',
    ...firmReview, (req, res) => {
      const fallback = `/workspaces/${req.workspace.id}/tprm/third-parties/${req.params.supplierId}#conditions`;
      try {
        const result = domain.requestConditionChanges(db, {
          workspaceId: req.workspace.id, supplierId: req.params.supplierId,
          conditionId: req.params.conditionId, actorId: req.user.id,
          expectedRowVersion: req.body.expected_row_version,
          reviewNote: req.body.review_note,
          idempotencyKey: req.body.idempotency_key || null,
        });
        if (typeof logAction === 'function') logAction(
          req.user.id, req.workspace.id, 'request_tprm_condition_changes', 'tprm_condition', result.condition.id,
          { supplier_id: result.condition.supplier_id, event_id: result.event.id }, auditCtx(req)
        );
        return res.redirect(303, withToast(fallback, 'Changes requested from the assigned client owner.', 'success'));
      } catch (error) {
        return actionFailure(req, res, error, fallback);
      }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:supplierId/conditions/:conditionId/verify',
    ...firmReview, (req, res) => {
      const fallback = `/workspaces/${req.workspace.id}/tprm/third-parties/${req.params.supplierId}#conditions`;
      try {
        const result = domain.verifyCondition(db, {
          workspaceId: req.workspace.id, supplierId: req.params.supplierId,
          conditionId: req.params.conditionId, actorId: req.user.id,
          expectedRowVersion: req.body.expected_row_version,
          reviewNote: req.body.review_note,
          idempotencyKey: req.body.idempotency_key || null,
        });
        if (typeof logAction === 'function') logAction(
          req.user.id, req.workspace.id, 'verify_tprm_condition', 'tprm_condition', result.condition.id,
          { supplier_id: result.condition.supplier_id, event_id: result.event.id, independent_review: true }, auditCtx(req)
        );
        return res.redirect(303, withToast(fallback, 'Condition independently verified and closed.', 'success'));
      } catch (error) {
        return actionFailure(req, res, error, fallback);
      }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:supplierId/conditions/:conditionId/waive',
    ...firmReview, managerOnly, (req, res) => {
      const fallback = `/workspaces/${req.workspace.id}/tprm/third-parties/${req.params.supplierId}#conditions`;
      try {
        const result = domain.waiveCondition(db, {
          workspaceId: req.workspace.id, supplierId: req.params.supplierId,
          conditionId: req.params.conditionId, actorId: req.user.id,
          expectedRowVersion: req.body.expected_row_version,
          rationale: req.body.waiver_rationale,
          expiresAt: req.body.waiver_expires_at,
          idempotencyKey: req.body.idempotency_key || null,
        });
        if (typeof logAction === 'function') logAction(
          req.user.id, req.workspace.id, 'waive_tprm_condition', 'tprm_condition', result.condition.id,
          {
            supplier_id: result.condition.supplier_id, event_id: result.event.id,
            waiver_expires_at: result.condition.waiver_expires_at, manager_approved: true,
          }, auditCtx(req)
        );
        return res.redirect(303, withToast(fallback, 'Time-limited manager waiver recorded. The original condition remains in history.', 'success'));
      } catch (error) {
        return actionFailure(req, res, error, fallback);
      }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:supplierId/cycles/:cycleId/cancel',
    requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.assessment.manage'),
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT), (req, res) => {
      const fallback = `/workspaces/${req.workspace.id}/tprm/third-parties/${req.params.supplierId}#cycle-governance`;
      try {
        const result = domain.cancelAssessmentCycle(db, {
          workspaceId: req.workspace.id, supplierId: req.params.supplierId,
          cycleId: req.params.cycleId, actorId: req.user.id,
          expectedRowVersion: req.body.expected_row_version,
          reason: req.body.cancellation_reason,
          fromStage: req.body.expected_stage,
          idempotencyKey: req.body.idempotency_key || null,
        });
        if (typeof logAction === 'function') logAction(
          req.user.id, req.workspace.id, 'cancel_tprm_assessment_cycle', 'tprm_assessment_cycle', result.cycle.id,
          {
            supplier_id: result.cycle.supplier_id, cycle_number: result.cycle.cycle_number,
            history_preserved: true, recommendation_issued: false, client_decision_recorded: false,
          }, auditCtx(req)
        );
        return res.redirect(303, withToast(fallback, 'Assessment cycle cancelled. Its history is preserved and a new cycle can now be started.', 'success'));
      } catch (error) {
        return actionFailure(req, res, error, fallback);
      }
    });

  app.post('/workspaces/:wsId/tprm/settings/close',
    requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.methodology.manage'), managerOnly, (req, res) => {
      const fallback = `/workspaces/${req.workspace.id}/tprm/settings`;
      try {
        const result = domain.closeModule(db, {
          workspaceId: req.workspace.id, actorId: req.user.id,
          expectedModuleId: req.body.expected_module_id,
          reason: req.body.closure_reason,
          retentionUntil: req.body.retention_until,
          retentionPolicy: req.body.retention_policy,
          legalHold: req.body.legal_hold,
          idempotencyKey: req.body.idempotency_key || null,
        });
        if (!result.closed) throw new domain.TprmDomainError('TPRM_MODULE_NOT_ACTIVE', 'No active Third-party risk service period was found.', 409);
        if (typeof logAction === 'function') logAction(
          req.user.id, req.workspace.id, 'close_tprm_service_period', 'tprm_module', result.module.id,
          {
            service_model: result.module.service_model, effective_to: result.module.effective_to,
            records_preserved: true, force_bypass: false,
            retention_until: result.closure.retention_until,
            legal_hold: Boolean(result.closure.legal_hold),
            closure_hash: result.closure.closure_hash,
          }, auditCtx(req)
        );
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}`, 'Third-party risk service period closed. All records remain available as read-only history.', 'success'));
      } catch (error) {
        return actionFailure(req, res, error, fallback);
      }
    });

  function protectedEvidence(req, res, options = {}) {
    const evidence = domain.conditionEvidence(db, req.workspace.id, req.params.conditionId, {
      supplierId: req.params.supplierId,
      evidenceId: req.params.evidenceId || 'latest',
    });
    if (!evidence) return res.status(404).send('Condition evidence not found');
    if (options.client) {
      const condition = db.prepare(`SELECT owner_user_id,owner_type,source_type FROM tprm_conditions
        WHERE id=? AND workspace_id=? AND supplier_id=?`).get(
          req.params.conditionId, req.workspace.id, req.params.supplierId
        );
      const clientMayInspect = condition?.source_type === 'client_decision'
        && condition?.owner_type === 'client'
        && (req.tprmClientRole === 'isms_manager'
          || Number(condition?.owner_user_id || 0) === Number(req.user.id));
      if (!clientMayInspect) return res.status(403).send('This condition evidence is restricted to its owner and the client security coordinator.');
    }
    const filePath = protectedUploadPath(evidence.stored_path, req.workspace.firm_id);
    if (!filePath) {
      return res.status(404).send('Condition evidence file is unavailable');
    }
    if (typeof logAction === 'function') logAction(
      req.user.id, req.workspace.id, 'download_tprm_condition_evidence', 'tprm_condition_evidence', evidence.id,
      { condition_id: evidence.condition_id, supplier_id: evidence.supplier_id, sha256: evidence.sha256 }, auditCtx(req)
    );
    const sourceExtension = safeSourceExtension(evidence.original_filename);
    const downloadName = options.client
      ? `condition-evidence-${evidence.id}${sourceExtension}`
      : safeDownloadName(evidence.original_filename);
    return sendProtectedDownload(res, filePath, {
      downloadName,
      sourceFilename: evidence.original_filename,
    });
  }

  function protectedReleasedEvidence(req, res) {
    const release = db.prepare(`SELECT r.id,r.source_type,r.client_label,r.release_hash,
        COALESCE(sd.stored_path,de.stored_path) AS stored_path,
        COALESCE(sd.filename,de.filename) AS source_filename,
        COALESCE(sd.sha256,de.sha256) AS sha256
      FROM tprm_evidence_releases r
      JOIN tprm_assessment_cycles cycle ON cycle.id=r.cycle_id
        AND cycle.workspace_id=r.workspace_id AND cycle.supplier_id=r.supplier_id
      LEFT JOIN supplier_documents sd ON r.source_type='supplier_document'
        AND sd.id=r.supplier_document_id AND sd.workspace_id=r.workspace_id
        AND sd.supplier_id=r.supplier_id
      LEFT JOIN supplier_ddq_evidence de ON r.source_type='ddq_evidence'
        AND de.id=r.ddq_evidence_id AND de.workspace_id=r.workspace_id
      LEFT JOIN supplier_ddq_assessments da ON da.id=de.assessment_id
        AND da.workspace_id=r.workspace_id AND da.supplier_id=r.supplier_id
      WHERE r.id=? AND r.workspace_id=? AND r.supplier_id=? AND r.allow_download=1
        AND (r.expires_at IS NULL OR date(r.expires_at)>=date('now'))
        AND NOT EXISTS (SELECT 1 FROM tprm_evidence_release_withdrawals w
          WHERE w.release_id=r.id AND w.workspace_id=r.workspace_id
            AND w.supplier_id=r.supplier_id)
        AND (
          (r.source_type='supplier_document' AND sd.id IS NOT NULL
            AND sd.stored_path IS NOT NULL
            AND (sd.expiry_date IS NULL OR date(sd.expiry_date)>=date('now')))
          OR
          (r.source_type='ddq_evidence' AND de.id IS NOT NULL
            AND de.stored_path IS NOT NULL AND da.id IS NOT NULL
            AND cycle.ddq_assessment_id=da.id)
        )`).get(req.params.releaseId, req.workspace.id, req.params.supplierId);
    if (!release) return res.status(404).send('Released evidence is unavailable');
    const filePath = protectedUploadPath(release.stored_path, req.workspace.firm_id);
    if (!filePath) return res.status(404).send('Released evidence is unavailable');
    if (typeof logAction === 'function') logAction(
      req.user.id, req.workspace.id, 'download_tprm_released_evidence', 'tprm_evidence_release', release.id,
      {
        supplier_id: Number(req.params.supplierId), source_type: release.source_type,
        release_hash: release.release_hash, sha256: release.sha256,
      }, auditCtx(req)
    );
    return sendProtectedDownload(res, filePath, {
      downloadName: clientSafeReleaseName(release.client_label, release.source_filename),
      sourceFilename: release.source_filename,
    });
  }

  app.get('/workspaces/:wsId/client-portal/tprm/:supplierId/conditions/:conditionId/evidence/:evidenceId/download',
    requireAuth, requireWorkspace, requirePermission('tprm.client_portal.view'), clientMember,
    (req, res) => protectedEvidence(req, res, { client: true }));
  app.get('/workspaces/:wsId/client-portal/tprm/:supplierId/conditions/:conditionId/evidence/latest/download',
    requireAuth, requireWorkspace, requirePermission('tprm.client_portal.view'), clientMember,
    (req, res) => protectedEvidence(req, res, { client: true }));
  app.get('/workspaces/:wsId/client-portal/tprm/:supplierId(\\d+)/evidence-releases/:releaseId(\\d+)/download',
    requireAuth, requireWorkspace, requirePermission('tprm.client_portal.view'), clientMember,
    protectedReleasedEvidence);
  app.get('/workspaces/:wsId/tprm/third-parties/:supplierId/conditions/:conditionId/evidence/:evidenceId/download',
    requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.conditions.manage'),
    (req, res) => protectedEvidence(req, res));
  app.get('/workspaces/:wsId/tprm/third-parties/:supplierId/conditions/:conditionId/evidence/latest/download',
    requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.conditions.manage'),
    (req, res) => protectedEvidence(req, res));
}

module.exports = { register, safeDownloadName, clientSafeReleaseName };
