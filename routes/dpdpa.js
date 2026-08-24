'use strict';

// DPDPA gap-assessment web surface. The domain service owns all lifecycle,
// evidence-gate, maker-checker and optimistic-concurrency decisions; this file
// only validates HTTP input, enforces route capabilities and renders results.

const rbac = require('../lib/rbac');
const domain = require('../lib/dpdpa-gap-domain');
const content = require('../lib/dpdpa-content');
const reports = require('../lib/dpdpa-gap-report');
const auditPack = require('../lib/audit-pack');
const { htmlToDocxPooled } = require('../lib/workers');
const { withToast, auditCtx } = require('../lib/http-helpers');

const ITEM_STATUSES = Object.freeze([
  'Not Assessed',
  'Implemented',
  'Partially Implemented',
  'Not Implemented',
  'Not Applicable',
]);

const EDITABLE_ASSESSMENT_STATES = new Set(['Draft', 'In Progress']);
const YES_NO_UNKNOWN = new Set(['Yes', 'No', 'Unknown']);
const SDF_STATES = new Set(['Designated', 'Not Designated', 'Unknown']);
const ORGANISATION_ROLES = new Set(['Data Fiduciary', 'Data Processor', 'Consent Manager', 'Other / To be confirmed']);

function clean(value, max = 12000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function dateOnly(value) {
  const text = clean(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function formArray(value) {
  const values = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return [...new Set(values.map(entry => clean(entry, 120)).filter(Boolean))];
}

function domainStatus(error) {
  const explicit = Number(error?.status || error?.statusCode);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  const code = String(error?.code || '');
  if (code === 'DPDPA_NOT_FOUND') return 404;
  if (code === 'DPDPA_VALIDATION') return 400;
  if (['DPDPA_SUBMISSION_BLOCKED', 'DPDPA_EVIDENCE_INSUFFICIENT'].includes(code)) return 422;
  if (/CONFLICT|INVALID_TRANSITION|MAKER_CHECKER|CATALOG_EMPTY/.test(code)) return 409;
  return 500;
}

function detailMessages(details) {
  if (!details) return [];
  const values = Array.isArray(details)
    ? details
    : (typeof details === 'object' ? Object.values(details) : [details]);
  return values.flatMap(value => {
    if (value == null) return [];
    if (Array.isArray(value)) return detailMessages(value);
    if (typeof value === 'object') {
      const message = value.message || value.reason || value.label || value.ref;
      return message ? [clean(message, 1000)] : [];
    }
    return [clean(value, 1000)];
  }).filter(Boolean).slice(0, 25);
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;
  // Deliberately fail server registration if the controlled catalogue cannot
  // be established. Evidence and dashboard routes may read DPDPA requirements
  // before a user opens this module, so lazy first-page seeding is unsafe.
  const registeredCatalog = domain.ensureFrameworkSeeded(db);

  const baseUrl = workspaceId => `/workspaces/${workspaceId}/dpdpa`;
  const assessmentUrl = (workspaceId, assessmentId) => `${baseUrl(workspaceId)}/assessments/${assessmentId}`;

  function capabilities(req) {
    const permissions = req.userPerms || resPermissions(req) || new Set();
    const has = permission => rbac.hasPermission(permissions, permission);
    return {
      view: has('dpdpa.view'),
      assess: has('dpdpa.assess'),
      review: has('dpdpa.review'),
      approve: has('dpdpa.approve'),
      export: has('dpdpa.export'),
    };
  }

  function resPermissions(req) {
    return req.res?.locals?.userPerms || new Set();
  }

  function renderError(req, res, status, message) {
    return res.status(status).render('error', {
      user: req.user,
      ws: req.workspace,
      message,
    });
  }

  function renderIssue(req, res, error, options = {}) {
    const status = domainStatus(error);
    if (status >= 500) {
      console.error('DPDPA gap-assessment route error:', error);
      return renderError(req, res, status, 'The DPDPA assessment could not be completed. No change was recorded.');
    }
    if (status === 404) {
      return renderError(req, res, 404, 'The DPDPA assessment was not found in this client workspace.');
    }
    if (status === 403) {
      return renderError(req, res, 403, clean(error.message, 1000) || 'You do not have permission to perform this DPDPA assessment action.');
    }
    const isConflict = status === 409;
    return res.status(status).render('dpdpa_conflict', {
      user: req.user,
      ws: req.workspace,
      active: 'dpdpa',
      statusCode: status,
      title: options.title || (isConflict ? 'This assessment changed before your action completed' : 'This assessment is not ready for that action'),
      message: clean(error.message, 2000) || (isConflict
        ? 'Reload the current record, review the latest version, and apply your decision again.'
        : 'Resolve the readiness checks and try again.'),
      details: detailMessages(error.details),
      backUrl: options.backUrl || baseUrl(req.workspace.id),
      backLabel: options.backLabel || 'Return to DPDPA overview',
      conflict: isConflict,
    });
  }

  function firmOnly(req, res, next) {
    if (req.user?.user_type !== 'firm') {
      return renderError(req, res, 403, 'The DPDPA delivery workbench is restricted to the assigned consultancy team.');
    }
    next();
  }

  // The framework must be explicitly selected in the stored workspace record.
  // This avoids treating the legacy null/malformed-framework fallback as an
  // implicit DPDPA activation and protects guessed direct URLs.
  function requireDpdpaEnabled(req, res, next) {
    let selected = false;
    try {
      const row = db.prepare('SELECT frameworks FROM workspaces WHERE id=?').get(req.workspace.id);
      const parsed = row?.frameworks ? JSON.parse(row.frameworks) : [];
      selected = Array.isArray(parsed) && parsed.includes('dpdpa');
    } catch (_) {
      selected = false;
    }
    if (!selected) {
      return renderError(req, res, 404, 'DPDPA is not enabled for this client. Enable the framework in client setup before opening an assessment.');
    }
    res.locals.dpdpaCatalog = registeredCatalog;
    next();
  }

  const guarded = permission => [
    requireAuth,
    requireWorkspace,
    firmOnly,
    requireDpdpaEnabled,
    requirePermission(permission),
  ];

  function loadAssessment(req, res) {
    const assessmentId = positiveInteger(req.params.assessmentId);
    if (!assessmentId) {
      renderError(req, res, 404, 'The DPDPA assessment URL is not valid.');
      return null;
    }
    const assessment = domain.getAssessment(db, req.workspace.id, assessmentId);
    if (!assessment) {
      renderError(req, res, 404, 'The DPDPA assessment was not found in this client workspace.');
      return null;
    }
    return assessment;
  }

  function selectSnapshot(assessment, requestedId) {
    const snapshots = Array.isArray(assessment?.snapshots) ? assessment.snapshots : [];
    if (requestedId) return snapshots.find(row => Number(row.id) === Number(requestedId)) || null;
    return assessment?.latest_snapshot || snapshots[0] || null;
  }

  function requestedSnapshotId(req) {
    if (req.query.snapshot == null || req.query.snapshot === '') return null;
    const id = positiveInteger(req.query.snapshot);
    if (!id) {
      const error = new Error('The frozen snapshot identifier is invalid.');
      error.status = 400;
      throw error;
    }
    return id;
  }

  function frozenSnapshotRequired(req, res, assessment, requestedId) {
    const snapshot = selectSnapshot(assessment, requestedId);
    if (snapshot) return snapshot;
    const error = new Error(requestedId
      ? 'The requested frozen snapshot was not found in this assessment.'
      : 'No frozen snapshot exists for this assessment. Complete review or create an authorised progress snapshot first.');
    error.status = requestedId ? 404 : 409;
    renderIssue(req, res, error, {
      backUrl: `${assessmentUrl(req.workspace.id, assessment.id)}/review`,
      backLabel: 'Return to assessment review',
    });
    return null;
  }

  function assignableUsers(req) {
    return db.prepare(`SELECT DISTINCT u.id,u.name,u.user_type
      FROM users u
      LEFT JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
      WHERE u.active=1 AND (
        wm.workspace_id=?
        OR (u.user_type='firm' AND u.firm_id=?
          AND u.firm_role IN ('manager','firm_owner','senior_consultant','lead_consultant'))
      )
      ORDER BY CASE u.user_type WHEN 'firm' THEN 0 ELSE 1 END,u.name,u.id`).all(
        req.workspace.id, req.workspace.id, req.workspace.firm_id);
  }

  function mutationContext(req, assessmentId) {
    return {
      workspaceId: req.workspace.id,
      assessmentId,
      actorId: req.user.id,
      logAction,
      auditContext: auditCtx(req),
    };
  }

  function latestCurrentAssessment(workspaceId) {
    const rows = domain.listAssessments(db, workspaceId, { limit: 100, offset: 0 });
    return rows.find(row => row.status !== 'Superseded') || null;
  }

  // View model shared by the overview, workbench and review screens. The
  // domain owns the stored conclusions; lib/dpdpa-content re-attaches the
  // statutory text, ranks the open gaps and groups the submission gates so
  // each template renders a decision rather than assembling one inline.
  function position(items, assessment) {
    const decorated = content.decorate(items);
    return {
      items: decorated,
      readiness: content.readinessOf(decorated),
      matrix: content.domainMatrix(decorated),
      gaps: content.rankedGaps(decorated, { asOfDate: assessment ? assessment.as_of_date : null }),
      priorityRule: content.PRIORITY_RULE,
    };
  }

  // Obligation records grouped by catalogue domain. Fifty-five sibling rows in
  // one list gave the assessor no sense of place; thirteen named groups with
  // their own progress do.
  function groupByDomain(decorated) {
    const groups = new Map();
    for (const item of decorated) {
      const key = item.content ? item.content.domain : (item.domain || 'Other obligations');
      if (!groups.has(key)) {
        groups.set(key, { domain: key, order: item.content ? item.content.domainOrder : 99, items: [] });
      }
      groups.get(key).items.push(item);
    }
    return [...groups.values()]
      .map(group => ({ ...group, readiness: content.readinessOf(group.items) }))
      .sort((a, b) => a.order - b.order);
  }

  app.get('/workspaces/:wsId/dpdpa/current/assessment', ...guarded('dpdpa.view'), (req, res) => {
    try {
      const assessment = latestCurrentAssessment(req.workspace.id);
      return res.redirect(assessment ? assessmentUrl(req.workspace.id, assessment.id) : baseUrl(req.workspace.id));
    } catch (error) {
      return renderIssue(req, res, error);
    }
  });

  app.get('/workspaces/:wsId/dpdpa/current/review', ...guarded('dpdpa.review'), (req, res) => {
    try {
      const assessment = latestCurrentAssessment(req.workspace.id);
      return res.redirect(assessment ? `${assessmentUrl(req.workspace.id, assessment.id)}/review` : baseUrl(req.workspace.id));
    } catch (error) {
      return renderIssue(req, res, error);
    }
  });

  app.get('/workspaces/:wsId/dpdpa/current/report', ...guarded('dpdpa.export'), (req, res) => {
    try {
      const assessment = latestCurrentAssessment(req.workspace.id);
      return res.redirect(assessment ? `${assessmentUrl(req.workspace.id, assessment.id)}/report` : baseUrl(req.workspace.id));
    } catch (error) {
      return renderIssue(req, res, error);
    }
  });

  app.get('/workspaces/:wsId/dpdpa', ...guarded('dpdpa.view'), (req, res) => {
    try {
      const dashboard = domain.getDashboard(db, req.workspace.id);
      const assessments = Array.isArray(dashboard?.recent_assessments)
        ? dashboard.recent_assessments
        : domain.listAssessments(db, req.workspace.id, { limit: 50, offset: 0 });
      const current = dashboard?.assessment || null;
      const items = current ? domain.getAssessmentItems(db, req.workspace.id, current.id) : [];
      return res.render('dpdpa_overview', {
        user: req.user,
        ws: req.workspace,
        active: 'dpdpa',
        catalog: res.locals.dpdpaCatalog,
        dashboard: dashboard || {},
        assessments,
        current,
        position: position(items, current),
        gates: content.groupBlockers(dashboard?.blockers),
        runway: content.commencementRunway(),
        sources: content.sources,
        caps: capabilities(req),
        today: new Date().toISOString().slice(0, 10),
      });
    } catch (error) {
      return renderIssue(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/dpdpa/assessments', ...guarded('dpdpa.assess'), (req, res) => {
    const title = clean(req.body.title, 240);
    const scopeStatement = clean(req.body.scope_statement, 12000);
    const asOfDate = dateOnly(req.body.as_of_date);
    const organisationRoles = formArray(req.body.organisation_roles).filter(value => ORGANISATION_ROLES.has(value));
    const yesNoUnknown = field => YES_NO_UNKNOWN.has(req.body[field]) ? req.body[field] : null;
    const applicabilityProfile = {
      organisation_roles: organisationRoles,
      digital_personal_data_in_scope: yesNoUnknown('digital_personal_data_in_scope'),
      children_or_guardian_processing: yesNoUnknown('children_or_guardian_processing'),
      sdf_designation_state: SDF_STATES.has(req.body.sdf_designation_state) ? req.body.sdf_designation_state : null,
      statutory_consent_manager_activity: yesNoUnknown('statutory_consent_manager_activity'),
      cross_border_processing_or_transfers: yesNoUnknown('cross_border_processing_or_transfers'),
      exemptions_or_public_data_assumptions: clean(req.body.exemptions_or_public_data_assumptions, 12000),
      legacy_consent_cohort: yesNoUnknown('legacy_consent_cohort'),
      scope_limitations: clean(req.body.scope_limitations, 12000),
    };
    const completeProfile = organisationRoles.length && applicabilityProfile.digital_personal_data_in_scope
      && applicabilityProfile.children_or_guardian_processing && applicabilityProfile.sdf_designation_state
      && applicabilityProfile.statutory_consent_manager_activity && applicabilityProfile.cross_border_processing_or_transfers
      && applicabilityProfile.exemptions_or_public_data_assumptions.length >= 20
      && applicabilityProfile.legacy_consent_cohort && applicabilityProfile.scope_limitations.length >= 20;
    if (title.length < 5 || scopeStatement.length < 20 || !asOfDate || !completeProfile) {
      const error = new Error('Complete the title, as-of date, scope statement, and every applicability-profile decision. Assumptions and limitations must each be at least 20 characters.');
      error.status = 400;
      return renderIssue(req, res, error, { backUrl: baseUrl(req.workspace.id) });
    }
    try {
      const assessment = domain.createAssessment(db, {
        workspaceId: req.workspace.id,
        title,
        scopeStatement,
        asOfDate,
        applicabilityProfile,
        createdBy: req.user.id,
        logAction,
        auditContext: auditCtx(req),
      });
      return res.redirect(withToast(assessmentUrl(req.workspace.id, assessment.id), 'DPDPA gap assessment created'));
    } catch (error) {
      return renderIssue(req, res, error, { backUrl: baseUrl(req.workspace.id) });
    }
  });

  app.get('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)', ...guarded('dpdpa.view'), (req, res) => {
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      const filters = {
        q: clean(req.query.q, 160),
        domain: clean(req.query.domain, 160),
        status: ITEM_STATUSES.includes(req.query.status) ? req.query.status : '',
      };
      const filtered = Object.values(filters).some(Boolean);
      const items = domain.getAssessmentItems(db, req.workspace.id, assessment.id, filters);
      // The visible list is filtered; the headline position must always
      // describe the whole assessment, so an active filter costs a second
      // unfiltered read rather than a misleading percentage.
      const all = filtered ? domain.getAssessmentItems(db, req.workspace.id, assessment.id) : items;
      const dashboard = domain.getDashboard(db, req.workspace.id, assessment.id) || {};
      return res.render('dpdpa_assessment', {
        user: req.user,
        ws: req.workspace,
        active: 'dpdpa-assessment',
        assessment,
        groups: groupByDomain(content.decorate(items)),
        visibleCount: items.length,
        position: position(all, assessment),
        gates: content.groupBlockers(dashboard.blockers),
        runway: content.commencementRunway(assessment.as_of_date),
        dashboard,
        filters,
        filtered,
        statusOptions: ITEM_STATUSES,
        users: assignableUsers(req),
        caps: capabilities(req),
        editable: EDITABLE_ASSESSMENT_STATES.has(assessment.status),
      });
    } catch (error) {
      return renderIssue(req, res, error, { backUrl: baseUrl(req.workspace.id) });
    }
  });

  app.post('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/items/:itemId(\\d+)', ...guarded('dpdpa.assess'), (req, res) => {
    const assessmentId = positiveInteger(req.params.assessmentId);
    const itemId = positiveInteger(req.params.itemId);
    const rowVersion = positiveInteger(req.body.row_version);
    const status = ITEM_STATUSES.includes(req.body.status) ? req.body.status : null;
    const backUrl = assessmentId ? `${assessmentUrl(req.workspace.id, assessmentId)}#item-${itemId || ''}` : baseUrl(req.workspace.id);
    if (!assessmentId || !itemId || !rowVersion || !status) {
      const error = new Error('The item status or record version is invalid. Reload the assessment and try again.');
      error.status = 400;
      return renderIssue(req, res, error, { backUrl, backLabel: 'Reload assessment' });
    }
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      domain.updateAssessmentItem(db, {
        ...mutationContext(req, assessment.id),
        itemId,
        rowVersion,
        status,
        applicability: status === 'Not Applicable' ? 'not_applicable' : 'applicable',
        assessmentNote: clean(req.body.assessment_note, 12000) || null,
        gapDescription: clean(req.body.gap_description, 12000) || null,
        recommendation: clean(req.body.recommendation, 12000) || null,
        naRationale: clean(req.body.na_rationale, 12000) || null,
        ownerId: positiveInteger(req.body.owner_id),
        dueDate: dateOnly(req.body.due_date),
      });
      return res.redirect(withToast(backUrl, `Assessment result saved for ${clean(req.body.requirement_ref, 80) || 'the obligation'}`));
    } catch (error) {
      return renderIssue(req, res, error, { backUrl, backLabel: 'Reload current assessment' });
    }
  });

  app.post('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/items/:itemId(\\d+)/accept-na', ...guarded('dpdpa.approve'), (req, res) => {
    const assessmentId = positiveInteger(req.params.assessmentId);
    const itemId = positiveInteger(req.params.itemId);
    const reviewUrl = assessmentId
      ? `${assessmentUrl(req.workspace.id, assessmentId)}/review#review-item-${itemId || ''}`
      : baseUrl(req.workspace.id);
    const rowVersion = positiveInteger(req.body.row_version);
    if (!assessmentId || !itemId || !rowVersion) {
      const error = new Error('The Not Applicable conclusion version is invalid. Reload review before accepting it.');
      error.status = 400;
      return renderIssue(req, res, error, { backUrl: reviewUrl, backLabel: 'Reload review queue' });
    }
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      domain.acceptNotApplicable(db, {
        ...mutationContext(req, assessment.id),
        itemId,
        rowVersion,
        note: clean(req.body.note, 4000) || null,
      });
      return res.redirect(withToast(reviewUrl, 'Not Applicable rationale accepted for this frozen item version'));
    } catch (error) {
      return renderIssue(req, res, error, { backUrl: reviewUrl, backLabel: 'Reload review queue' });
    }
  });

  app.post('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/submit', ...guarded('dpdpa.assess'), (req, res) => {
    const assessmentId = positiveInteger(req.params.assessmentId);
    const backUrl = assessmentId ? assessmentUrl(req.workspace.id, assessmentId) : baseUrl(req.workspace.id);
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      domain.submitAssessment(db, {
        ...mutationContext(req, assessment.id),
        rowVersion: positiveInteger(req.body.row_version),
        note: clean(req.body.note, 4000) || null,
      });
      return res.redirect(withToast(backUrl, 'Assessment submitted for independent review'));
    } catch (error) {
      return renderIssue(req, res, error, { backUrl, backLabel: 'Return to assessment' });
    }
  });

  app.get('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/review', ...guarded('dpdpa.review'), (req, res) => {
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      const items = domain.getAssessmentItems(db, req.workspace.id, assessment.id);
      const dashboard = domain.getDashboard(db, req.workspace.id, assessment.id) || {};
      const focus = ['gaps', 'evidence', 'applicability', 'movement'].includes(req.query.focus)
        ? req.query.focus
        : '';
      return res.render('dpdpa_review', {
        user: req.user,
        ws: req.workspace,
        active: 'dpdpa-review',
        assessment,
        position: position(items, assessment),
        gates: content.groupBlockers(dashboard.blockers),
        focus,
        dashboard,
        caps: capabilities(req),
      });
    } catch (error) {
      return renderIssue(req, res, error, { backUrl: baseUrl(req.workspace.id) });
    }
  });

  app.post('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/return', ...guarded('dpdpa.review'), (req, res) => {
    const assessmentId = positiveInteger(req.params.assessmentId);
    const backUrl = assessmentId ? `${assessmentUrl(req.workspace.id, assessmentId)}/review` : baseUrl(req.workspace.id);
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      domain.returnAssessment(db, {
        ...mutationContext(req, assessment.id),
        rowVersion: positiveInteger(req.body.row_version),
        note: clean(req.body.note, 4000),
      });
      return res.redirect(withToast(backUrl, 'Assessment returned for changes'));
    } catch (error) {
      return renderIssue(req, res, error, { backUrl, backLabel: 'Reload review queue' });
    }
  });

  app.post('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/approve', ...guarded('dpdpa.approve'), (req, res) => {
    const assessmentId = positiveInteger(req.params.assessmentId);
    const reviewUrl = assessmentId ? `${assessmentUrl(req.workspace.id, assessmentId)}/review` : baseUrl(req.workspace.id);
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      const result = domain.approveAssessment(db, {
        ...mutationContext(req, assessment.id),
        rowVersion: positiveInteger(req.body.row_version),
        note: clean(req.body.note, 4000) || null,
      });
      const snapshot = result?.snapshot;
      const destination = capabilities(req).export && snapshot?.id
        ? `${assessmentUrl(req.workspace.id, assessment.id)}/report?snapshot=${snapshot.id}`
        : reviewUrl;
      return res.redirect(withToast(destination, 'Assessment independently approved and frozen'));
    } catch (error) {
      return renderIssue(req, res, error, { backUrl: reviewUrl, backLabel: 'Reload review queue' });
    }
  });

  app.post('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/snapshots', ...guarded('dpdpa.export'), (req, res) => {
    const assessmentId = positiveInteger(req.params.assessmentId);
    const backUrl = assessmentId ? `${assessmentUrl(req.workspace.id, assessmentId)}/review` : baseUrl(req.workspace.id);
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      const snapshot = domain.createSnapshot(db, {
        ...mutationContext(req, assessment.id),
        reason: clean(req.body.reason, 4000) || null,
      });
      return res.redirect(withToast(`${assessmentUrl(req.workspace.id, assessment.id)}/report?snapshot=${snapshot.id}`, 'Frozen readiness snapshot created'));
    } catch (error) {
      return renderIssue(req, res, error, { backUrl, backLabel: 'Return to review' });
    }
  });

  app.get('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/report', ...guarded('dpdpa.export'), (req, res) => {
    try {
      const assessment = loadAssessment(req, res);
      if (!assessment) return;
      const requestedId = requestedSnapshotId(req);
      const snapshots = Array.isArray(assessment.snapshots) ? assessment.snapshots : [];
      const snapshot = frozenSnapshotRequired(req, res, assessment, requestedId);
      if (!snapshot) return;
      reports.normalizeSnapshot(snapshot);
      let payload = snapshot.snapshot_json || {};
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
      }
      // The report is rendered from the frozen payload alone. Catalogue
      // content is re-attached for the statutory text and the gap ranking,
      // never for a conclusion: an obligation whose reference has since left
      // the catalogue simply renders without it.
      const frozenItems = content.decorate(Array.isArray(payload.items) ? payload.items : []);
      return res.render('dpdpa_report', {
        user: req.user,
        ws: req.workspace,
        active: 'dpdpa-report',
        assessment,
        snapshot,
        payload,
        snapshots,
        frozenItems,
        readiness: content.readinessOf(frozenItems),
        matrix: content.domainMatrix(frozenItems),
        gaps: content.rankedGaps(frozenItems, { asOfDate: payload.assessment?.as_of_date || assessment.as_of_date }),
        priorityRule: content.PRIORITY_RULE,
        caps: capabilities(req),
      });
    } catch (error) {
      return renderIssue(req, res, error, { backUrl: baseUrl(req.workspace.id) });
    }
  });

  async function exportFrozenSnapshot(req, res, kind) {
    let assessment = null;
    let snapshot = null;
    try {
      assessment = loadAssessment(req, res);
      if (!assessment) return;
      const requestedId = requestedSnapshotId(req);
      snapshot = frozenSnapshotRequired(req, res, assessment, requestedId);
      if (!snapshot) return;
      // Normalisation verifies snapshot_json against snapshot_hash. The
      // renderer receives no database handle and therefore cannot drift to
      // live workpapers after approval.
      const model = reports.normalizeSnapshot(snapshot);
      const meta = reports.reportMeta(model);
      const extension = kind === 'pdf' ? 'pdf' : kind === 'docx' ? 'docx' : 'csv';
      const filename = `${meta.filename_base}.${extension}`;
      let body;
      let contentType;
      if (kind === 'csv') {
        body = Buffer.from(`\ufeff${reports.csv(model)}`, 'utf8');
        contentType = 'text/csv; charset=utf-8';
      } else {
        const html = reports.reportHtml(model);
        if (kind === 'pdf') {
          body = reports.asBuffer(await auditPack.renderPDF(html, {
            headerLeft: meta.title,
            headerRight: meta.reliance_label,
            footerLeft: `Frozen snapshot ${String(meta.snapshot_hash || '').slice(0, 16)}`,
          }));
          contentType = 'application/pdf';
        } else {
          body = reports.asBuffer(await htmlToDocxPooled(html, null, {
            title: meta.title,
            creator: 'Compliance Sphere',
            pageNumber: true,
            table: { row: { cantSplit: true } },
          }));
          contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }
      }
      logAction(req.user.id, req.workspace.id, `dpdpa_gap_snapshot_export_${kind}`,
        'dpdpa_gap_assessment_snapshot', snapshot.id, {
          assessment_id: assessment.id,
          snapshot_sequence: snapshot.sequence_number,
          snapshot_hash: snapshot.snapshot_hash,
          catalog_hash: snapshot.catalog_hash,
          bytes: body.length,
          approved: model.approved,
        }, auditCtx(req));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', body.length);
      return res.send(body);
    } catch (error) {
      return renderIssue(req, res, error, {
        backUrl: assessment
          ? `${assessmentUrl(req.workspace.id, assessment.id)}/report${snapshot?.id ? `?snapshot=${snapshot.id}` : ''}`
          : baseUrl(req.workspace.id),
        backLabel: 'Return to frozen report',
        title: 'The controlled export could not be generated',
      });
    }
  }

  app.get('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/exports/report.pdf', ...guarded('dpdpa.export'),
    (req, res) => exportFrozenSnapshot(req, res, 'pdf'));
  app.get('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/exports/report.docx', ...guarded('dpdpa.export'),
    (req, res) => exportFrozenSnapshot(req, res, 'docx'));
  app.get('/workspaces/:wsId/dpdpa/assessments/:assessmentId(\\d+)/exports/data.csv', ...guarded('dpdpa.export'),
    (req, res) => exportFrozenSnapshot(req, res, 'csv'));
}

module.exports = { register };
