'use strict';

// Standalone Third-party risk module. The existing /vendors routes remain the
// write-compatible workflow during the product cutover; this module is the
// canonical portfolio, navigation and assurance surface.

const rbac = require('../lib/rbac');
const crypto = require('crypto');
const frameworkCoverage = require('../lib/tprm-framework-coverage');
const tprmRelationships = require('../lib/tprm-relationships');
const tprmBulkIntake = require('../lib/tprm-bulk-intake');
const serviceCapabilities = require('../lib/tprm-capabilities');
const fts = require('../lib/fts');
const { pageHref } = require('../lib/paginate');
const { withToast, auditCtx } = require('../lib/http-helpers');
const recommendationWorkflowService = require('../lib/tprm-recommendation-workflow');

let domainCache;
function tprmDomain() {
  if (domainCache !== undefined) return domainCache;
  try { domainCache = require('../lib/tprm-domain'); }
  catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    domainCache = null;
  }
  return domainCache;
}

const POSITIVE_DECISIONS = new Set(['approved', 'conditional', 'renewed', 'onboard', 'onboarded', 'onboard_with_conditions']);

function titleCase(value, fallback = 'Not started') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function dateOnly(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function waitingLabel(value, fallback = 'Consultancy') {
  const labels = {
    consultancy: 'Consultancy', consultancy_manager: 'Senior consultant',
    third_party: 'Provider contact', provider: 'Provider contact',
    client: 'Client', system: 'System', monitoring: 'Monitoring',
  };
  return labels[String(value || '').toLowerCase()] || value || fallback;
}

function formRows(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map(key => value[key]);
  return [];
}

function isPast(value, today) {
  const date = dateOnly(value);
  return Boolean(date && date < today);
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;

  const tableExists = table => Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table));

  function supplierCount(workspaceId) {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM suppliers WHERE workspace_id=?').get(workspaceId)?.c || 0);
  }

  // The latest service-period row is authoritative, including a closed row.
  // Historic data remains readable after closure, but every mutation requires
  // an exact active period. Supplier-count fallback applies only when there is
  // genuinely no module history and is always read-only pending classification.
  function moduleState(workspaceId) {
    const domain = tprmDomain();
    if (!domain) {
      if (tableExists('tprm_modules')) {
        const row = db.prepare('SELECT * FROM tprm_modules WHERE workspace_id=? ORDER BY id DESC LIMIT 1').get(workspaceId);
        if (row?.status === 'needs_classification') return { enabled: true, readOnly: true, activationRequired: true, source: 'module-table', row };
        if (row?.status === 'active') return { enabled: true, readOnly: false, activationRequired: false, source: 'module-table', row };
        if (row?.status === 'closed') return { enabled: true, readOnly: true, closed: true, activationRequired: false, source: 'module-table', row };
        if (row) return { enabled: false, readOnly: true, activationRequired: false, source: 'module-table', row };
        if (supplierCount(workspaceId) > 0) return { enabled: true, readOnly: true, activationRequired: true, source: 'unclassified-history' };
        return { enabled: false, readOnly: true, activationRequired: false, source: 'not-enabled' };
      }
      return { enabled: true, readOnly: false, source: 'legacy-compatible' };
    }
    let row = null;
    if (typeof domain.moduleForWorkspace === 'function') {
      try { row = domain.moduleForWorkspace(db, workspaceId, { includeClosed: true }); } catch (_) { row = null; }
    }
    if (row) {
      const status = String(row.status || '').toLowerCase();
      // Legacy workspaces are inspectable while a manager classifies their
      // pre-module records. They are deliberately not actionable yet.
      if (status === 'needs_classification') {
        return { enabled: true, readOnly: true, activationRequired: true, source: 'module', row };
      }
      if (status === 'active') return { enabled: true, readOnly: false, activationRequired: false, source: 'module', row };
      if (status === 'closed') return { enabled: true, readOnly: true, closed: true, activationRequired: false, source: 'module', row };
      return { enabled: false, readOnly: true, activationRequired: false, source: 'module', row };
    }
    if (supplierCount(workspaceId) > 0) {
      return { enabled: true, readOnly: true, activationRequired: true, source: 'unclassified-history' };
    }
    if (typeof domain.isEnabled === 'function') {
      try { return { enabled: Boolean(domain.isEnabled(db, workspaceId)), source: 'domain' }; } catch (_) { /* compatibility fallback */ }
    }
    return { enabled: false, source: 'not-enabled' };
  }

  function requireTprm(req, res, next) {
    const module = moduleState(req.workspace.id);
    if (!module.enabled) {
      return res.status(404).render('error', {
        user: req.user,
        ws: req.workspace,
        message: 'Third-party risk is not enabled for this client. Enable the module from client setup before opening its records.'
      });
    }
    res.locals.tprmModule = module;
    res.locals.tprmPolicy = serviceCapabilities.policyForModule(module.row || null);
    next();
  }

  function thirdPartyQuery(workspaceIds, options = {}) {
    const ids = [...new Set((Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).map(Number).filter(Number.isInteger))];
    if (!ids.length && !options.workspaceScopeSql) return null;
    const workspaceScope = options.workspaceScopeSql || ids.map(() => '?').join(',');
    const params = options.workspaceScopeSql ? [...(options.workspaceScopeParams || [])] : ids;
    const governedColumns = tableExists('tprm_recommendations') && tableExists('tprm_client_decisions')
      ? `(SELECT r.outcome FROM tprm_recommendations r WHERE r.workspace_id=s.workspace_id AND r.supplier_id=s.id ORDER BY r.version DESC,r.id DESC LIMIT 1) AS current_recommendation,
      (SELECT r.residual_risk_band FROM tprm_recommendations r WHERE r.workspace_id=s.workspace_id AND r.supplier_id=s.id ORDER BY r.version DESC,r.id DESC LIMIT 1) AS residual_risk_band,
      (SELECT d.decision FROM tprm_client_decisions d WHERE d.workspace_id=s.workspace_id AND d.supplier_id=s.id ORDER BY d.version DESC,d.id DESC LIMIT 1) AS current_client_decision,
      (SELECT d.diverges_from_recommendation FROM tprm_client_decisions d WHERE d.workspace_id=s.workspace_id AND d.supplier_id=s.id ORDER BY d.version DESC,d.id DESC LIMIT 1) AS decision_diverges,
      (SELECT c.id FROM tprm_assessment_cycles c WHERE c.workspace_id=s.workspace_id AND c.supplier_id=s.id ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END,c.cycle_number DESC LIMIT 1) AS current_cycle_id,
      (SELECT e.to_stage FROM tprm_lifecycle_events e WHERE e.workspace_id=s.workspace_id AND e.supplier_id=s.id AND e.to_stage IS NOT NULL ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) AS governed_stage,`
      : `NULL AS current_recommendation,NULL AS residual_risk_band,NULL AS current_client_decision,NULL AS decision_diverges,NULL AS current_cycle_id,NULL AS governed_stage,`;
    let sql = `SELECT s.*,w.client_name,w.lead_consultant_id,u.name AS lead_consultant_name,
      ${governedColumns}
      (SELECT ia.id FROM supplier_inherent_assessments ia WHERE ia.supplier_id=s.id AND ia.status!='superseded' ORDER BY ia.id DESC LIMIT 1) AS inherent_id,
      (SELECT ia.status FROM supplier_inherent_assessments ia WHERE ia.supplier_id=s.id AND ia.status!='superseded' ORDER BY ia.id DESC LIMIT 1) AS inherent_status,
      (SELECT ia.assigned_tier FROM supplier_inherent_assessments ia WHERE ia.supplier_id=s.id AND ia.status!='superseded' ORDER BY ia.id DESC LIMIT 1) AS governed_tier,
      (SELECT ia.weighted_score FROM supplier_inherent_assessments ia WHERE ia.supplier_id=s.id AND ia.status!='superseded' ORDER BY ia.id DESC LIMIT 1) AS governed_inherent_score,
      (SELECT da.id FROM supplier_ddq_assessments da WHERE da.supplier_id=s.id AND da.status!='superseded' ORDER BY da.id DESC LIMIT 1) AS ddq_id,
      (SELECT da.status FROM supplier_ddq_assessments da WHERE da.supplier_id=s.id AND da.status!='superseded' ORDER BY da.id DESC LIMIT 1) AS ddq_status,
      (SELECT da.due_date FROM supplier_ddq_assessments da WHERE da.supplier_id=s.id AND da.status!='superseded' ORDER BY da.id DESC LIMIT 1) AS ddq_due_date,
      (SELECT da.vendor_contact_name FROM supplier_ddq_assessments da WHERE da.supplier_id=s.id AND da.status!='superseded' ORDER BY da.id DESC LIMIT 1) AS provider_contact_name,
      (SELECT cr.id FROM supplier_contract_reviews cr WHERE cr.supplier_id=s.id AND cr.status!='superseded' ORDER BY cr.id DESC LIMIT 1) AS contract_review_id,
      (SELECT cr.status FROM supplier_contract_reviews cr WHERE cr.supplier_id=s.id AND cr.status!='superseded' ORDER BY cr.id DESC LIMIT 1) AS contract_status,
      (SELECT d.id FROM supplier_decisions d WHERE d.supplier_id=s.id AND d.superseded_at IS NULL ORDER BY d.id DESC LIMIT 1) AS legacy_decision_id,
      (SELECT d.decision FROM supplier_decisions d WHERE d.supplier_id=s.id AND d.superseded_at IS NULL ORDER BY d.id DESC LIMIT 1) AS legacy_decision,
      (SELECT d.residual_risk_band FROM supplier_decisions d WHERE d.supplier_id=s.id AND d.superseded_at IS NULL ORDER BY d.id DESC LIMIT 1) AS legacy_residual_risk_band,
      (SELECT COUNT(*) FROM supplier_finding_links l INNER JOIN findings f ON f.id=l.finding_id WHERE l.supplier_id=s.id AND f.workspace_id=s.workspace_id AND f.status NOT IN ('closed','verified')) AS open_finding_count,
      (SELECT COUNT(*) FROM supplier_finding_links l INNER JOIN findings f ON f.id=l.finding_id WHERE l.supplier_id=s.id AND f.workspace_id=s.workspace_id AND f.status NOT IN ('closed','verified','accepted_risk') AND f.severity IN ('critical','high')) AS blocking_finding_count,
      (SELECT COUNT(*) FROM supplier_documents sd WHERE sd.supplier_id=s.id AND sd.expiry_date IS NOT NULL AND sd.expiry_date < date('now','+30 days')) AS expiring_document_count
      FROM suppliers s
      INNER JOIN workspaces w ON w.id=s.workspace_id
      LEFT JOIN users u ON u.id=w.lead_consultant_id
      WHERE s.workspace_id IN (${workspaceScope})`;
    if (Array.isArray(options.supplierIds)) {
      const supplierIds = [...new Set(options.supplierIds.map(Number).filter(Number.isInteger))];
      if (!supplierIds.length) return null;
      sql += ` AND s.id IN (${supplierIds.map(() => '?').join(',')})`;
      params.push(...supplierIds);
    }
    return { sql, params };
  }

  function thirdPartyRows(workspaceIds, options = {}) {
    const query = thirdPartyQuery(workspaceIds, options);
    if (!query) return [];
    return db.prepare(`${query.sql} ORDER BY w.client_name,s.name,s.id`).all(...query.params);
  }

  function normalizedRegisterFilters(query) {
    const status = ['active', 'closed', 'all'].includes(String(query.status || 'active')) ? String(query.status || 'active') : 'active';
    const acceptedRisk = new Set(['', 'high_critical', 'critical', 'high', 'moderate', 'low']);
    const requestedRisk = String(query.risk || '').toLowerCase();
    return {
      q: String(query.q || '').trim().slice(0, 200),
      status,
      risk: acceptedRisk.has(requestedRisk) ? requestedRisk : '',
    };
  }

  function thirdPartyPage(workspaceIds, requestQuery, options = {}) {
    const filters = normalizedRegisterFilters(requestQuery || {});
    const pageSizes = new Set([25, 30, 50, 100]);
    const requestedPageSize = Number(requestQuery && requestQuery.per_page);
    const perPage = pageSizes.has(requestedPageSize) ? requestedPageSize : 25;
    const query = thirdPartyQuery(workspaceIds, options);
    if (!query) return { rows: [], page: 1, pages: 1, total: 0, perPage, filters };
    const clauses = [];
    const filterParams = [];
    if (filters.q) {
      clauses.push(`(lower(base.name) LIKE ? ESCAPE '\\' OR lower(COALESCE(base.service_provided,'')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(base.business_owner,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(base.relationship_owner,'')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(base.client_name,'')) LIKE ? ESCAPE '\\')`);
      const escaped = filters.q.toLowerCase().replace(/[\\%_]/g, value => `\\${value}`);
      filterParams.push(...Array(5).fill(`%${escaped}%`));
    }
    if (filters.status === 'active') clauses.push(`base.archived_at IS NULL AND COALESCE(base.lifecycle_stage,'')!='terminated'`);
    if (filters.status === 'closed') clauses.push(`(base.archived_at IS NOT NULL OR base.lifecycle_stage='terminated')`);
    if (filters.risk === 'high_critical') clauses.push(`lower(COALESCE(base.residual_risk_band,'')) IN ('high','critical')`);
    else if (filters.risk) { clauses.push(`lower(COALESCE(base.residual_risk_band,''))=?`); filterParams.push(filters.risk); }
    const filteredSql = `SELECT * FROM (${query.sql}) base${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`;
    const allParams = [...query.params, ...filterParams];
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM (${filteredSql})`).get(...allParams).count || 0);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const requestedPage = Number.parseInt(String(requestQuery && requestQuery.page || '1'), 10);
    const page = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1), pages);
    const priorityOrder = options.priorityOrder ? `CASE
      WHEN base.archived_at IS NOT NULL OR base.lifecycle_stage='terminated' THEN 99
      WHEN base.ddq_status IN ('issued','in_progress') AND base.ddq_due_date<date('now') THEN 1
      WHEN base.ddq_status IN ('submitted','under_review') THEN 2
      WHEN base.blocking_finding_count>0 THEN 3
      WHEN base.next_review_date IS NOT NULL AND base.next_review_date<date('now') THEN 4
      WHEN base.inherent_id IS NULL OR COALESCE(base.inherent_status,'')!='approved' THEN 10
      WHEN base.ddq_id IS NULL OR COALESCE(base.ddq_status,'') NOT IN ('issued','in_progress','complete') THEN 20
      WHEN base.contract_review_id IS NULL OR COALESCE(base.contract_status,'')!='complete' THEN 30
      WHEN base.current_recommendation IS NULL THEN 35
      WHEN base.current_client_decision IS NULL THEN 50
      ELSE 80 END,
      CASE WHEN base.ddq_due_date IS NULL AND base.next_review_date IS NULL THEN 1 ELSE 0 END,
      COALESCE(base.ddq_due_date,base.next_review_date,'9999-12-31'),client_name,name,id`
      : 'client_name,name,id';
    const rows = db.prepare(`${filteredSql} ORDER BY ${priorityOrder} LIMIT ? OFFSET ?`)
      .all(...allParams, perPage, (page - 1) * perPage);
    return { rows, page, pages, total, perPage, filters };
  }

  function normalizeDomainProjection(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const recommendation = raw.consultancyRecommendation || raw.recommendation || raw.currentRecommendation || null;
    const clientDecision = raw.clientDecision || raw.currentClientDecision || null;
    const next = raw.nextAction || raw.next_action || null;
    return {
      raw,
      stage: raw.stage || raw.lifecycleStage || raw.lifecycle_stage || null,
      recommendation,
      clientDecision,
      nextAction: next && typeof next === 'object' ? next : (next ? { label: String(next) } : null),
      cycle: raw.currentCycle || raw.cycle || null,
      waitingOn: raw.waitingOn || raw.waiting_on || null,
      blockers: Array.isArray(raw.blockers) ? raw.blockers : [],
    };
  }

  function domainProjection(row) {
    const domain = tprmDomain();
    let projection = null;
    if (domain && typeof domain.lifecycleProjection === 'function') {
      try { projection = normalizeDomainProjection(domain.lifecycleProjection(db, row.workspace_id, row.id)); }
      catch (_) { projection = null; }
    }
    if (!projection && (row.current_recommendation || row.current_client_decision || row.governed_stage || row.current_cycle_id)) projection = { raw: {}, stage: null, recommendation: null, clientDecision: null, nextAction: null, cycle: null };
    if (!projection) return null;
    projection.stage ||= row.governed_stage || null;
    projection.recommendation ||= row.current_recommendation || null;
    projection.clientDecision ||= row.current_client_decision || null;
    projection.cycle ||= row.current_cycle_id ? { id: row.current_cycle_id } : null;
    return projection;
  }

  function recommendationState(projection) {
    const recommendation = projection?.recommendation;
    if (!recommendation) return null;
    if (typeof recommendation === 'string') return recommendation;
    return recommendation.outcome || recommendation.recommendation || recommendation.status || null;
  }

  function clientDecisionState(projection, row) {
    const decision = projection?.clientDecision;
    if (typeof decision === 'string') return decision;
    if (decision) return decision.decision || decision.outcome || decision.status || null;
    // supplier_decisions pre-dates the client-only decision boundary and may
    // have been authored by the consultancy. It is never promoted to a client
    // decision; the detail view retains it only as quarantined history.
    return null;
  }

  function fallbackNextAction(row, projection, today) {
    const root = `/workspaces/${row.workspace_id}`;
    if (row.archived_at || row.lifecycle_stage === 'terminated') {
      return { label: 'View retained record', href: `${root}/tprm/third-parties/${row.id}`, owner: 'Record owner', waitingOn: 'No action', priority: 'closed', rank: 99 };
    }
    if (!row.inherent_id || row.inherent_status === 'draft') {
      return { label: 'Complete inherent-risk assessment', href: `${root}/vendors/${row.id}/inherent-risk`, owner: row.relationship_owner || 'Consultancy', waitingOn: 'Consultancy', priority: 'high', rank: 10 };
    }
    if (row.inherent_status === 'submitted') {
      return { label: 'Approve inherent-risk tier', href: `${root}/vendors/${row.id}/inherent-risk`, owner: row.security_reviewer || 'Senior consultant', waitingOn: 'Quality review', priority: 'high', rank: 12 };
    }
    if (row.inherent_status !== 'approved') {
      return { label: 'Resolve inherent-risk assessment', href: `${root}/vendors/${row.id}/inherent-risk`, owner: row.relationship_owner || 'Consultancy', waitingOn: 'Consultancy', priority: 'high', rank: 11 };
    }
    if (!row.ddq_id) {
      return { label: 'Issue due-diligence questionnaire', href: `${root}/vendors/${row.id}/due-diligence`, owner: row.relationship_owner || 'Consultancy', waitingOn: 'Consultancy', priority: 'high', rank: 20 };
    }
    if (row.ddq_status === 'draft') {
      return { label: 'Send questionnaire to Provider contact', href: `${root}/vendors/${row.id}/due-diligence`, owner: row.relationship_owner || 'Consultancy', waitingOn: 'Consultancy', priority: 'high', rank: 21, dueDate: row.ddq_due_date };
    }
    if (['issued', 'in_progress'].includes(row.ddq_status)) {
      const overdue = isPast(row.ddq_due_date, today);
      return { label: overdue ? 'Follow up overdue questionnaire' : 'Waiting for Provider contact', href: `${root}/vendors/${row.id}/due-diligence`, owner: row.provider_contact_name || 'Provider contact', waitingOn: 'Provider contact', priority: overdue ? 'critical' : 'waiting', rank: overdue ? 1 : 60, dueDate: row.ddq_due_date };
    }
    if (['submitted', 'under_review'].includes(row.ddq_status)) {
      return { label: 'Review questionnaire and evidence', href: `${root}/vendors/${row.id}/due-diligence`, owner: row.security_reviewer || 'Consultancy', waitingOn: 'Consultancy', priority: 'critical', rank: 2, dueDate: row.ddq_due_date };
    }
    if (row.ddq_status !== 'complete') {
      return { label: 'Resolve due-diligence status', href: `${root}/vendors/${row.id}/due-diligence`, owner: row.relationship_owner || 'Consultancy', waitingOn: 'Consultancy', priority: 'high', rank: 22 };
    }
    if (!row.contract_review_id || row.contract_status !== 'complete') {
      return { label: row.contract_review_id ? 'Complete contract assurance' : 'Start contract assurance', href: `${root}/vendors/${row.id}/contract-review`, owner: row.security_reviewer || 'Consultancy', waitingOn: 'Consultancy', priority: 'high', rank: 30 };
    }
    if (row.blocking_finding_count > 0) {
      return { label: 'Resolve critical findings or obtain acceptance', href: `${root}/tprm/findings?third_party=${row.id}`, owner: row.business_owner || 'Client owner', waitingOn: 'Client and consultancy', priority: 'critical', rank: 3 };
    }
    const recommendation = recommendationState(projection);
    if (!recommendation) {
      return { label: 'Prepare consultancy recommendation', href: `${root}/tprm/third-parties/${row.id}#recommendation`, owner: row.security_reviewer || 'Consultancy', waitingOn: 'Consultancy', priority: 'high', rank: 35 };
    }
    const decision = clientDecisionState(projection, row);
    if (!decision) {
      return { label: 'Waiting for client onboarding decision', href: `${root}/client-portal/tprm/${row.id}`, owner: row.business_owner || 'Client decision authority', waitingOn: 'Client', priority: 'waiting', rank: 50 };
    }
    if (isPast(row.next_review_date, today)) {
      return { label: 'Start overdue reassessment', href: `${root}/vendors/${row.id}/inherent-risk`, owner: row.relationship_owner || 'Consultancy', waitingOn: 'Consultancy', priority: 'critical', rank: 4, dueDate: row.next_review_date };
    }
    if (String(decision).includes('conditional') || row.open_finding_count > 0) {
      return { label: 'Track onboarding conditions', href: `${root}/tprm/findings?third_party=${row.id}`, owner: row.business_owner || 'Client owner', waitingOn: 'Client and consultancy', priority: 'high', rank: 40, dueDate: row.next_review_date };
    }
    return { label: 'Review monitoring record', href: `${root}/tprm/third-parties/${row.id}#monitoring`, owner: row.relationship_owner || 'Consultancy', waitingOn: 'Monitoring', priority: 'normal', rank: 80, dueDate: row.next_review_date };
  }

  function normalizeNextAction(action, row, fallback) {
    if (!action) return fallback;
    const root = `/workspaces/${row.workspace_id}`;
    const canonicalHrefs = {
      classify_module: `${root}/tprm/settings`, enable_module: `${root}/tprm/settings`,
      start_assessment: `${root}/tprm/third-parties/${row.id}#cycle-governance`,
      start_reassessment: `${root}/tprm/third-parties/${row.id}#cycle-governance`,
      issue_recommendation: `${root}/tprm/third-parties/${row.id}#recommendation`,
      record_client_decision: `${root}/client-portal/tprm/${row.id}`,
      monitor: `${root}/tprm/third-parties/${row.id}#monitoring`,
      triage_monitoring: `${root}/tprm/monitoring`,
    };
    return {
      key: action.key || null,
      label: action.label || action.title || action.action || fallback.label,
      href: action.href || action.url || canonicalHrefs[action.key] || fallback.href,
      owner: action.owner || action.ownerName || fallback.owner,
      waitingOn: waitingLabel(action.waitingOn || action.waiting_on || fallback.waitingOn),
      priority: String(action.priority || action.severity || fallback.priority || 'normal').toLowerCase(),
      rank: Number.isFinite(Number(action.rank ?? action.priorityRank)) ? Number(action.rank ?? action.priorityRank) : fallback.rank,
      dueDate: action.dueDate || action.due_date || fallback.dueDate || null,
    };
  }

  function stageFor(row, projection) {
    if (projection?.stage) return titleCase(projection.stage);
    if (row.archived_at || row.lifecycle_stage === 'terminated') return 'Closed';
    if (row.inherent_status !== 'approved') return 'Triage and tiering';
    if (row.ddq_status !== 'complete') return 'Due diligence';
    if (row.contract_status !== 'complete') return 'Contract assurance';
    if (!recommendationState(projection)) return 'Consultancy recommendation';
    if (!clientDecisionState(projection, row)) return 'Client decision';
    return POSITIVE_DECISIONS.has(String(clientDecisionState(projection, row)).toLowerCase()) ? 'Monitoring' : 'Decision recorded';
  }

  function lifecycleRail(row, projection) {
    const recommendation = Boolean(recommendationState(projection));
    const decision = Boolean(clientDecisionState(projection, row));
    const states = [
      ['Request', true],
      ['Triage and tier', row.inherent_status === 'approved'],
      ['Due diligence', row.ddq_status === 'complete'],
      ['Contract assurance', row.contract_status === 'complete'],
      ['Consultancy recommendation', recommendation],
      ['Client decision', decision],
      ['Monitor', decision && POSITIVE_DECISIONS.has(String(clientDecisionState(projection, row)).toLowerCase())],
    ];
    const firstOpen = states.findIndex(([, done]) => !done);
    return states.map(([label, done], index) => ({ label, state: done ? 'done' : (index === firstOpen ? 'current' : 'upcoming') }));
  }

  function enrich(rows, today) {
    return rows.map(row => {
      const projection = domainProjection(row);
      const fallback = fallbackNextAction(row, projection, today);
      const module = moduleState(row.workspace_id);
      const projectedAction = projection?.nextAction
        ? { ...projection.nextAction, waitingOn: projection.waitingOn || projection.nextAction.waitingOn }
        : null;
      const nextAction = module.activationRequired
        ? { label: 'Classify legacy module records', href: `/workspaces/${row.workspace_id}/tprm`, owner: 'Firm manager', waitingOn: 'Module setup', priority: 'high', rank: 5, dueDate: null }
        : normalizeNextAction(projectedAction, row, fallback);
      return {
        ...row,
        projection,
        recommendation: recommendationState(projection),
        client_decision: clientDecisionState(projection, row),
        stage_label: stageFor(row, projection),
        nextAction,
        lifecycleRail: lifecycleRail(row, projection),
        module,
      };
    });
  }

  function buildPortfolio(workspaceIds) {
    const today = new Date().toISOString().slice(0, 10);
    const thirdParties = enrich(thirdPartyRows(workspaceIds), today);
    const active = thirdParties.filter(row => !row.archived_at && row.lifecycle_stage !== 'terminated');
    const queue = active
      .filter(row => row.nextAction.priority !== 'closed')
      .sort((a, b) => a.nextAction.rank - b.nextAction.rank || String(a.nextAction.dueDate || '9999').localeCompare(String(b.nextAction.dueDate || '9999')) || a.name.localeCompare(b.name));
    const metrics = {
      actionRequired: queue.filter(row => ['critical', 'high'].includes(row.nextAction.priority) && row.nextAction.waitingOn !== 'Provider contact').length,
      waitingProvider: active.filter(row => ['issued', 'in_progress'].includes(row.ddq_status)).length,
      highResidual: active.filter(row => ['high', 'critical'].includes(String(row.residual_risk_band || '').toLowerCase())).length,
      overdueExpiring: active.filter(row => isPast(row.next_review_date, today) || Number(row.expiring_document_count) > 0 || (row.contract_end && row.contract_end <= new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10))).length,
    };
    return { today, thirdParties, active, queue, metrics };
  }

  function aggregateThirdPartyPortfolio(workspaceIds, options = {}) {
    const query = thirdPartyQuery(workspaceIds, options);
    const empty = { thirdPartyCount: 0, actionCount: 0, highResidual: 0, waitingProvider: 0, overdueExpiring: 0, overdueReviews: 0 };
    if (!query) return options.groupByWorkspace ? new Map() : empty;
    const active = `base.archived_at IS NULL AND COALESCE(base.lifecycle_stage,'')!='terminated'`;
    const actionRule = `(${active}) AND (
      base.inherent_status IS NULL OR base.inherent_status!='approved'
      OR (base.inherent_status='approved' AND COALESCE(base.ddq_status,'') NOT IN ('issued','in_progress','complete'))
      OR (base.ddq_status='complete' AND COALESCE(base.contract_status,'')!='complete')
      OR base.blocking_finding_count>0
      OR (base.contract_status='complete' AND base.current_recommendation IS NULL)
      OR (base.current_client_decision IS NOT NULL AND (lower(base.current_client_decision) LIKE '%conditional%' OR base.open_finding_count>0))
      OR (base.next_review_date IS NOT NULL AND base.next_review_date<date('now'))
    )`;
    const grouped = options.groupByWorkspace ? 'base.workspace_id,' : '';
    const groupClause = options.groupByWorkspace ? ' GROUP BY base.workspace_id' : '';
    const rows = db.prepare(`SELECT ${grouped}
      SUM(CASE WHEN ${active} THEN 1 ELSE 0 END) AS thirdPartyCount,
      SUM(CASE WHEN ${actionRule} THEN 1 ELSE 0 END) AS actionCount,
      SUM(CASE WHEN ${active} AND lower(COALESCE(base.residual_risk_band,'')) IN ('high','critical') THEN 1 ELSE 0 END) AS highResidual,
      SUM(CASE WHEN ${active} AND base.ddq_status IN ('issued','in_progress') THEN 1 ELSE 0 END) AS waitingProvider,
      SUM(CASE WHEN ${active} AND (base.next_review_date<date('now') OR base.expiring_document_count>0 OR (base.contract_end IS NOT NULL AND base.contract_end<=date('now','+90 days'))) THEN 1 ELSE 0 END) AS overdueExpiring,
      SUM(CASE WHEN ${active} AND base.next_review_date<date('now') THEN 1 ELSE 0 END) AS overdueReviews
      FROM (${query.sql}) base${groupClause}`).all(...query.params);
    if (options.groupByWorkspace) return new Map(rows.map(row => [Number(row.workspace_id), Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === 'workspace_id' ? Number(value) : Number(value || 0)]))]));
    const row = rows[0] || empty;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
  }

  function queryPageHref(req, pageParam, targetPage) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query || {})) {
      if (key === pageParam || value == null || value === '') continue;
      if (Array.isArray(value)) value.forEach(item => query.append(key, item));
      else query.append(key, value);
    }
    if (targetPage > 1) query.set(pageParam, String(targetPage));
    const encoded = query.toString();
    return encoded ? `?${encoded}` : '?';
  }

  function workspaceLocals(req, portfolio, section) {
    const perms = resPermissions(req);
    const state = moduleState(req.workspace.id);
    const tprmPolicy = serviceCapabilities.policyForModule(state.row || null);
    const visiblePortfolio = state.closed ? {
      ...portfolio,
      active: [],
      queue: [],
      metrics: { actionRequired: 0, waitingProvider: 0, highResidual: 0, overdueExpiring: 0 },
    } : portfolio;
    return {
      user: req.user,
      ws: req.workspace,
      active: section,
      portfolio: visiblePortfolio,
      canManage: rbac.hasPermission(perms, 'tprm.third_party.manage') && !state.readOnly
        && tprmPolicy.capabilities[serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER].allowed,
      canApprove: rbac.hasPermission(perms, 'tprm.recommendation.issue') && !state.readOnly
        && tprmPolicy.capabilities[serviceCapabilities.CAPABILITIES.RECOMMENDATION].allowed,
      canExport: rbac.hasPermission(perms, 'tprm.assurance.export'),
      canGenerateReport: rbac.hasPermission(perms, 'report.generate') && !state.readOnly
        && tprmPolicy.capabilities[serviceCapabilities.CAPABILITIES.CLIENT_DECISION_REPORT].allowed,
      canViewReports: rbac.hasPermission(perms, 'report.view'),
      canSettings: req.user.user_type === 'firm' && rbac.isManager(req.user.firm_role),
      moduleReadOnly: Boolean(state.readOnly),
      moduleClosed: Boolean(state.closed),
      tprmPolicy,
      tprmCapabilities: serviceCapabilities.CAPABILITIES,
      titleCase,
      dateOnly,
    };
  }

  function resPermissions(req) {
    return req.userPerms || rbac.rolePermissions(req.workspace?._userRole || req.user.firm_role);
  }

  function workspaceBase(req, res, next) {
    requirePermission('tprm.third_party.view')(req, res, error => {
      if (error) return next(error);
      requireTprm(req, res, next);
    });
  }

  function requireFirmUser(req, res, next) {
    if (req.user?.user_type !== 'firm') return res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'Only the consulting team can perform this action.' });
    next();
  }

  function requireActiveTprm(req, res, next) {
    const module = moduleState(req.workspace.id);
    if (!module.enabled || module.readOnly || module.row?.status !== 'active') {
      return res.status(409).render('error', { user: req.user, ws: req.workspace, message: 'Classify and activate this Third-party risk module before changing governed records.' });
    }
    next();
  }

  const requireServiceCapability = capability => serviceCapabilities.requireCapability(db, capability);

  function requireRecommendationWorkflowActor(req, res, next) {
    const permissions = resPermissions(req);
    if (!rbac.hasPermission(permissions, 'tprm.recommendation.draft')
        && !rbac.hasPermission(permissions, 'tprm.recommendation.issue')) {
      return res.status(403).render('error', {
        user: req.user, ws: req.workspace,
        message: 'Recommendation drafting or independent-review permission is required.',
      });
    }
    next();
  }

  function scopedThirdParty(workspaceId, supplierId) {
    return db.prepare('SELECT * FROM suppliers WHERE workspace_id=? AND id=?').get(workspaceId, supplierId) || null;
  }

  function currentArtifactIds(workspaceId, supplierId, includeHistoric = true) {
    if (!includeHistoric) return { inherentAssessmentId: null, ddqAssessmentId: null, contractReviewId: null };
    const inherent = db.prepare(`SELECT id FROM supplier_inherent_assessments WHERE workspace_id=? AND supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(workspaceId, supplierId);
    const ddq = inherent ? db.prepare(`SELECT id FROM supplier_ddq_assessments WHERE workspace_id=? AND supplier_id=? AND inherent_assessment_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(workspaceId, supplierId, inherent.id) : null;
    const contract = inherent ? db.prepare(`SELECT id FROM supplier_contract_reviews WHERE workspace_id=? AND supplier_id=? AND inherent_assessment_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(workspaceId, supplierId, inherent.id) : null;
    return { inherentAssessmentId: inherent?.id || null, ddqAssessmentId: ddq?.id || null, contractReviewId: contract?.id || null };
  }

  // Disclosure records deliberately omit stored_path and internal notes. A
  // client sees evidence metadata only after an explicit immutable release;
  // withdrawal is retained as a second append-only fact.
  function evidenceReleaseHistory(workspaceId, supplierId = null) {
    if (!tableExists('tprm_evidence_releases')) return [];
    const supplierClause = supplierId ? ' AND r.supplier_id=?' : '';
    const params = supplierId ? [workspaceId, supplierId] : [workspaceId];
    return db.prepare(`SELECT r.id AS release_id,r.workspace_id,r.supplier_id,r.cycle_id,r.source_type,
      r.supplier_document_id,r.ddq_evidence_id,r.client_label,r.client_description,r.allow_download,r.expires_at AS release_expires_at,
      r.released_at,r.release_hash,releaser.name AS released_by_name,
      w.id AS withdrawal_id,w.reason AS withdrawal_reason,w.withdrawn_at,withdrawer.name AS withdrawn_by_name,
      s.name AS third_party_name,
      CASE WHEN r.source_type='supplier_document' THEN sd.filename ELSE de.filename END AS source_filename,
      CASE WHEN r.source_type='supplier_document' THEN COALESCE(sd.doc_type,'relationship_document') ELSE 'due_diligence_evidence' END AS source_category,
      CASE WHEN r.source_type='supplier_document' THEN sd.expiry_date ELSE NULL END AS source_expiry_date,
      CASE WHEN r.source_type='ddq_evidence' THEN de.question_id ELSE NULL END AS question_id
      FROM tprm_evidence_releases r
      INNER JOIN suppliers s ON s.id=r.supplier_id AND s.workspace_id=r.workspace_id
      LEFT JOIN tprm_evidence_release_withdrawals w ON w.release_id=r.id
      LEFT JOIN users releaser ON releaser.id=r.released_by
      LEFT JOIN users withdrawer ON withdrawer.id=w.withdrawn_by
      LEFT JOIN supplier_documents sd ON sd.id=r.supplier_document_id
        AND sd.workspace_id=r.workspace_id AND sd.supplier_id=r.supplier_id
      LEFT JOIN supplier_ddq_evidence de ON de.id=r.ddq_evidence_id AND de.workspace_id=r.workspace_id
      WHERE r.workspace_id=?${supplierClause}
      ORDER BY r.released_at DESC,r.id DESC`).all(...params);
  }

  function releasableEvidence(workspaceId, supplierId, cycle) {
    if (!cycle || !tableExists('tprm_evidence_releases')) return [];
    const documents = db.prepare(`SELECT 'supplier_document' AS source_type,sd.id,sd.name AS source_name,
      sd.filename,COALESCE(sd.doc_type,'relationship_document') AS source_category,
      sd.effective_date,sd.expiry_date,sd.size_bytes,sd.sha256
      FROM supplier_documents sd
      WHERE sd.workspace_id=? AND sd.supplier_id=?
        AND NOT EXISTS (SELECT 1 FROM tprm_evidence_releases r
          WHERE r.workspace_id=sd.workspace_id AND r.supplier_id=sd.supplier_id
            AND r.cycle_id=? AND r.source_type='supplier_document' AND r.supplier_document_id=sd.id)
      ORDER BY sd.name,sd.id`).all(workspaceId, supplierId, cycle.id);
    const ddq = cycle.ddq_assessment_id ? db.prepare(`SELECT 'ddq_evidence' AS source_type,e.id,
      COALESCE(e.filename,'Due-diligence evidence') AS source_name,e.filename,
      'due_diligence_evidence' AS source_category,e.uploaded_at AS effective_date,
      NULL AS expiry_date,e.size_bytes,e.sha256,e.question_id
      FROM supplier_ddq_evidence e
      WHERE e.workspace_id=? AND e.assessment_id=?
        AND NOT EXISTS (SELECT 1 FROM tprm_evidence_releases r
          WHERE r.workspace_id=e.workspace_id AND r.supplier_id=? AND r.cycle_id=?
            AND r.source_type='ddq_evidence' AND r.ddq_evidence_id=e.id)
      ORDER BY e.question_id,e.filename,e.id`).all(workspaceId, cycle.ddq_assessment_id, supplierId, cycle.id) : [];
    return [...documents, ...ddq];
  }

  function clientDecisionAuthorities(workspaceId) {
    return db.prepare(`SELECT u.id,u.name,u.email,wm.role FROM users u INNER JOIN workspace_members wm ON wm.user_id=u.id
      WHERE wm.workspace_id=? AND u.user_type='client' AND u.active=1 AND wm.role IN ('client_owner','client_admin')
      ORDER BY u.name,u.id`).all(workspaceId);
  }

  function recommendationReviewers(req) {
    const candidates = db.prepare(`SELECT id,name,email,firm_role FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name,id`).all(req.workspace.firm_id);
    return candidates.filter(candidate => {
      const overrides = db.prepare(`SELECT permission,granted FROM workspace_role_overrides
        WHERE workspace_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>=datetime('now'))`).all(req.workspace.id, candidate.id);
      const permissions = rbac.effectivePermissions(candidate.firm_role, overrides);
      if (candidate.id === req.user.id || !rbac.hasPermission(permissions, 'tprm.recommendation.issue')) return false;
      const role = rbac.normalizeRole(candidate.firm_role);
      if (rbac.isManager(role) || rbac.hasPermission(permissions, 'firm.cross_view')) return true;
      return Boolean(db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.workspace.id, candidate.id));
    });
  }

  function recommendationConditions(body) {
    return formRows(body.conditions)
      .filter(condition => condition && String(condition.title || '').trim())
      .map(condition => ({
        findingId: condition.finding_id || undefined,
        conditionType: condition.condition_type,
        title: condition.title,
        description: condition.description,
        severity: condition.severity,
        ownerType: condition.owner_type,
        ownerName: condition.owner_name,
        dueDate: condition.due_date,
        verificationCriteria: condition.verification_criteria,
      }));
  }

  function recommendationRevisionInput(body) {
    return {
      outcome: body.outcome,
      executiveSummary: body.executive_summary,
      rationale: body.rationale,
      residualRiskScore: body.residual_risk_score === '' ? null : body.residual_risk_score,
      residualRiskBand: body.residual_risk_band,
      validUntil: body.valid_until || null,
      conditions: recommendationConditions(body),
    };
  }

  function redirectDomainError(req, res, supplierId, anchor, error) {
    const known = error && (error.name === 'TprmDomainError' || String(error.code || '').startsWith('TPRM_'));
    if (!known) console.error('[tprm orchestration]', error && error.stack ? error.stack : error);
    const message = known ? error.message : 'The governed action could not be completed. No record was changed.';
    return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplierId}${anchor || ''}`, message, 'error'));
  }

  app.get('/workspaces/:wsId/tprm', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    const portfolio = buildPortfolio(req.workspace.id);
    res.render('tprm_overview', workspaceLocals(req, portfolio, 'tprm-overview'));
  });

  app.get('/workspaces/:wsId/tprm/third-parties', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    const pg = thirdPartyPage(req.workspace.id, req.query);
    const today = new Date().toISOString().slice(0, 10);
    const rows = enrich(pg.rows, today);
    const portfolio = { today, thirdParties: rows, active: rows.filter(row => !row.archived_at && row.lifecycle_stage !== 'terminated'), queue: [], metrics: {} };
    res.render('tprm_third_parties', {
      ...workspaceLocals(req, portfolio, 'tprm-third-parties'), rows, filters: pg.filters, pg,
      pagerHref: page => pageHref(req, page),
    });
  });

  app.get('/workspaces/:wsId/tprm/third-parties/new', requireAuth, requireWorkspace, workspaceBase, requirePermission('tprm.third_party.manage'), (req, res) => {
    if (moduleState(req.workspace.id).readOnly) return res.status(409).render('error', { user: req.user, ws: req.workspace, message: 'Classify and activate this legacy Third-party risk module before creating or changing records.' });
    const portfolio = buildPortfolio(req.workspace.id);
    res.render('tprm_new_third_party', workspaceLocals(req, portfolio, 'tprm-third-parties'));
  });

  function bulkIntakeLocals(req, mode, extras = {}) {
    const portfolio = { today: new Date().toISOString().slice(0, 10), thirdParties: [], active: [], queue: [], metrics: {} };
    return {
      ...workspaceLocals(req, portfolio, 'tprm-third-parties'),
      mode,
      fields: tprmBulkIntake.FIELDS,
      limits: { maxRows: tprmBulkIntake.MAX_ROWS, maxBytes: tprmBulkIntake.MAX_BYTES },
      importUrl: `/workspaces/${req.workspace.id}/tprm/third-parties/import`,
      previewUrl: `/workspaces/${req.workspace.id}/tprm/third-parties/import/preview`,
      commitUrl: `/workspaces/${req.workspace.id}/tprm/third-parties/import/commit`,
      errorsUrl: `/workspaces/${req.workspace.id}/tprm/third-parties/import/errors.csv`,
      templateUrl: `/workspaces/${req.workspace.id}/tprm/third-parties/import/template.csv`,
      result: null,
      csv: '',
      filename: '',
      message: null,
      ...extras,
    };
  }

  const bulkIntakeGuards = [requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.third_party.manage'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.DRAFT_INTAKE)];

  app.get('/workspaces/:wsId/tprm/third-parties/import', ...bulkIntakeGuards, (req, res) => {
    res.render('tprm_bulk_import', bulkIntakeLocals(req, 'upload'));
  });

  app.get('/workspaces/:wsId/tprm/third-parties/import/template.csv', ...bulkIntakeGuards, (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="third-party-service-intake-${req.workspace.id}.csv"`);
    res.send(tprmBulkIntake.templateCsv());
  });

  app.post('/workspaces/:wsId/tprm/third-parties/import/preview', ...bulkIntakeGuards, (req, res) => {
    const csv = String(req.body.csv || '');
    const filename = String(req.body.filename || 'third-party-intake.csv').replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 160) || 'third-party-intake.csv';
    try {
      const result = tprmBulkIntake.preview(db, { workspaceId: req.workspace.id, csvText: csv });
      return res.render('tprm_bulk_import', bulkIntakeLocals(req, 'preview', { result, csv, filename }));
    } catch (error) {
      if (!(error instanceof tprmBulkIntake.TprmBulkIntakeError)) throw error;
      return res.status(error.status || 400).render('tprm_bulk_import', bulkIntakeLocals(req, 'upload', { csv, filename, message: error.message }));
    }
  });

  app.post('/workspaces/:wsId/tprm/third-parties/import/errors.csv', ...bulkIntakeGuards, (req, res) => {
    try {
      const result = tprmBulkIntake.preview(db, { workspaceId: req.workspace.id, csvText: String(req.body.csv || '') });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="third-party-intake-validation-${req.workspace.id}.csv"`);
      return res.send(tprmBulkIntake.errorCsv(result));
    } catch (error) {
      if (!(error instanceof tprmBulkIntake.TprmBulkIntakeError)) throw error;
      return res.status(error.status || 400).render('tprm_bulk_import', bulkIntakeLocals(req, 'upload', { message: error.message }));
    }
  });

  app.post('/workspaces/:wsId/tprm/third-parties/import/commit', ...bulkIntakeGuards, (req, res) => {
    const csv = String(req.body.csv || '');
    const filename = String(req.body.filename || 'third-party-intake.csv').replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 160) || 'third-party-intake.csv';
    try {
      const committed = tprmBulkIntake.commit(db, {
        workspaceId: req.workspace.id,
        actorId: req.user.id,
        csvText: csv,
        previewDigest: String(req.body.preview_digest || ''),
        onBeforeCommit: result => {
          if (typeof logAction !== 'function') return;
          logAction(
            req.user.id, req.workspace.id, 'commit_tprm_bulk_intake', 'tprm_bulk_intake', null,
            {
              filename,
              digest: result.preview.digest,
              totalRows: result.preview.summary.total,
              thirdPartiesCreated: result.counts.thirdPartiesCreated,
              relationshipsCreated: result.counts.relationshipsCreated,
              alreadyImported: result.counts.alreadyImported,
              allOrNothing: true,
              decisionBoundary: 'intake_only_no_consultancy_recommendation_or_client_decision',
            },
            { ...auditCtx(req), strict: true }
          );
        },
      });
      committed.createdSupplierIds.forEach(id => {
        try { fts.refresh(req.workspace.id, 'supplier', id); }
        catch (error) { console.error('[tprm bulk intake search refresh]', error && error.message ? error.message : error); }
      });
      const message = `Bulk intake committed: ${committed.counts.thirdPartiesCreated} third part${committed.counts.thirdPartiesCreated === 1 ? 'y' : 'ies'} and ${committed.counts.relationshipsCreated} service relationship${committed.counts.relationshipsCreated === 1 ? '' : 's'} created${committed.counts.alreadyImported ? `; ${committed.counts.alreadyImported} already imported` : ''}.`;
      return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties`, message, 'success'));
    } catch (error) {
      if (!(error instanceof tprmBulkIntake.TprmBulkIntakeError)) throw error;
      const result = error.result || (() => { try { return tprmBulkIntake.preview(db, { workspaceId: req.workspace.id, csvText: csv }); } catch (_) { return null; } })();
      return res.status(error.status || 409).render('tprm_bulk_import', bulkIntakeLocals(req, result ? 'preview' : 'upload', { result, csv, filename, message: error.message }));
    }
  });

  app.get('/workspaces/:wsId/tprm/third-parties/:id', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    const portfolio = buildPortfolio(req.workspace.id);
    const thirdParty = portfolio.thirdParties.find(row => row.id === Number(req.params.id));
    if (!thirdParty) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
    const findings = db.prepare(`SELECT f.*,l.domain,l.due_date,l.owner_name,l.risk_acceptance_reason,l.risk_acceptance_expires_at,l.accepted_at
      FROM findings f INNER JOIN supplier_finding_links l ON l.finding_id=f.id
      WHERE f.workspace_id=? AND l.supplier_id=?
      ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,f.created_at DESC`).all(req.workspace.id, thirdParty.id);
    const documents = db.prepare('SELECT * FROM supplier_documents WHERE workspace_id=? AND supplier_id=? ORDER BY expiry_date,uploaded_at DESC').all(req.workspace.id, thirdParty.id);
    const reviews = db.prepare('SELECT * FROM supplier_reviews WHERE workspace_id=? AND supplier_id=? ORDER BY review_date DESC,id DESC').all(req.workspace.id, thirdParty.id);
    const monitoring = db.prepare('SELECT * FROM supplier_monitoring WHERE workspace_id=? AND supplier_id=? ORDER BY recorded_at DESC,id DESC').all(req.workspace.id, thirdParty.id);
    const decisions = db.prepare(`SELECT d.*,u.name AS decided_by_name FROM supplier_decisions d LEFT JOIN users u ON u.id=d.decided_by
      WHERE d.workspace_id=? AND d.supplier_id=? ORDER BY d.id DESC`).all(req.workspace.id, thirdParty.id);
    const governedRecommendations = tableExists('tprm_recommendations') ? db.prepare(`SELECT r.*,author.name AS author_name,reviewer.name AS reviewer_name
      FROM tprm_recommendations r LEFT JOIN users author ON author.id=r.issued_by LEFT JOIN users reviewer ON reviewer.id=r.quality_reviewed_by
      WHERE r.workspace_id=? AND r.supplier_id=? ORDER BY r.version DESC,r.id DESC`).all(req.workspace.id, thirdParty.id) : [];
    const clientDecisions = tableExists('tprm_client_decisions') ? db.prepare(`SELECT d.*,u.name AS client_actor_display_name
      FROM tprm_client_decisions d LEFT JOIN users u ON u.id=d.client_actor_user_id
      WHERE d.workspace_id=? AND d.supplier_id=? ORDER BY d.version DESC,d.id DESC`).all(req.workspace.id, thirdParty.id) : [];
    const domain = tprmDomain();
    const governedConditions = tableExists('tprm_conditions')
      ? (domain && typeof domain.listConditions === 'function'
          ? domain.listConditions(db, req.workspace.id, thirdParty.id)
          : db.prepare(`SELECT *,status AS effective_status,0 AS waiver_expired FROM tprm_conditions
              WHERE workspace_id=? AND supplier_id=? ORDER BY due_date,id`).all(req.workspace.id, thirdParty.id))
      : [];
    const activity = db.prepare(`SELECT a.*,u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND ((a.entity_type='supplier' AND a.entity_id=?) OR a.entity_id IN (SELECT CAST(id AS TEXT) FROM supplier_inherent_assessments WHERE supplier_id=?) OR a.entity_id IN (SELECT CAST(id AS TEXT) FROM supplier_ddq_assessments WHERE supplier_id=?))
      ORDER BY a.id DESC LIMIT 40`).all(req.workspace.id, String(thirdParty.id), thirdParty.id, thirdParty.id);
    const cycle = domain && typeof domain.currentCycle === 'function' ? domain.currentCycle(db, req.workspace.id, thirdParty.id) : null;
    const serviceRelationships = tableExists('tprm_service_relationships') ? db.prepare(`SELECT id,relationship_name,service_category,status,criticality,is_primary
      FROM tprm_service_relationships WHERE workspace_id=? AND supplier_id=? AND status NOT IN ('terminated','rejected')
      ORDER BY is_primary DESC,relationship_name,id`).all(req.workspace.id, thirdParty.id) : [];
    const cycleRelationshipScopes = cycle && tableExists('tprm_cycle_relationship_scopes') ? db.prepare(`SELECT s.*,r.relationship_name
      FROM tprm_cycle_relationship_scopes s JOIN tprm_service_relationships r
        ON r.workspace_id=s.workspace_id AND r.id=s.relationship_id
      WHERE s.workspace_id=? AND s.cycle_id=? ORDER BY CASE s.scope_role WHEN 'primary' THEN 0 ELSE 1 END,r.relationship_name`).all(req.workspace.id, cycle.id) : [];
    const currentRecommendation = cycle && domain && typeof domain.currentRecommendation === 'function'
      ? domain.currentRecommendation(db, req.workspace.id, thirdParty.id, cycle.id) : null;
    const currentClientDecision = domain && typeof domain.currentClientDecision === 'function'
      ? domain.currentClientDecision(db, req.workspace.id, thirdParty.id) : null;
    const recommendationReadiness = cycle && domain && typeof domain.recommendationReadiness === 'function'
      ? domain.recommendationReadiness(db, req.workspace.id, thirdParty.id, cycle.id) : null;
    const clientOwners = clientDecisionAuthorities(req.workspace.id);
    const authority = cycle?.client_decision_authority_id ? clientOwners.find(owner => owner.id === cycle.client_decision_authority_id) || db.prepare('SELECT id,name,email FROM users WHERE id=?').get(cycle.client_decision_authority_id) : null;
    const perms = resPermissions(req);
    const policy = serviceCapabilities.policyForModule(moduleState(req.workspace.id).row || null);
    const moduleActive = policy.active;
    const canStartCycle = moduleActive && policy.capabilities[serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT].allowed
      && req.user.user_type === 'firm' && rbac.hasPermission(perms, 'tprm.intake.manage');
    const canAssignAuthority = moduleActive && policy.capabilities[serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT].allowed
      && req.user.user_type === 'firm' && rbac.hasPermission(perms, 'tprm.assessment.manage');
    const canDraftRecommendation = moduleActive && policy.capabilities[serviceCapabilities.CAPABILITIES.RECOMMENDATION].allowed
      && req.user.user_type === 'firm' && rbac.hasPermission(perms, 'tprm.recommendation.draft');
    const canIssueRecommendation = moduleActive && policy.capabilities[serviceCapabilities.CAPABILITIES.RECOMMENDATION].allowed
      && req.user.user_type === 'firm' && rbac.hasPermission(perms, 'tprm.recommendation.issue');
    let recommendationWorkflow = null;
    if (cycle && (canDraftRecommendation || canIssueRecommendation)) {
      try {
        recommendationWorkflow = recommendationWorkflowService.currentDraft(db, {
          workspaceId: req.workspace.id, supplierId: thirdParty.id, cycleId: cycle.id, actorId: req.user.id,
        });
      } catch (error) {
        if (!error || !String(error.code || '').startsWith('TPRM_')) throw error;
      }
    }
    const canViewEvidenceReleases = rbac.hasPermission(perms, 'tprm.assurance.view');
    const canManageEvidenceReleases = moduleActive
      && policy.capabilities[serviceCapabilities.CAPABILITIES.EVIDENCE_DISCLOSURE].allowed
      && req.user.user_type === 'firm'
      && rbac.hasPermission(perms, 'tprm.assurance.export');
    const canReleaseEvidence = canManageEvidenceReleases && Boolean(cycle);
    const releasedEvidenceHistory = canViewEvidenceReleases ? evidenceReleaseHistory(req.workspace.id, thirdParty.id)
      .map(record => ({ ...record, withdrawalNonce: crypto.randomBytes(24).toString('hex') })) : [];
    res.render('tprm_third_party', {
      ...workspaceLocals(req, portfolio, 'tprm-third-parties'), thirdParty, findings, documents, reviews, monitoring, decisions, activity,
      governedRecommendations, clientDecisions, governedConditions, cycle, currentRecommendation, currentClientDecision,
      serviceRelationships, cycleRelationshipScopes,
      clientOwners, authority, recommendationReviewers: recommendationReviewers(req),
      recommendationWorkflow, canStartCycle, canAssignAuthority, canDraftRecommendation,
      canIssueRecommendation, canViewEvidenceReleases,
      canManageEvidenceReleases, canReleaseEvidence,
      releasableEvidence: canReleaseEvidence ? releasableEvidence(req.workspace.id, thirdParty.id, cycle) : [],
      releasedEvidenceHistory,
      recommendationReadiness,
      projectionBlockers: thirdParty.projection?.blockers || [],
      cycleNonce: crypto.randomBytes(24).toString('hex'),
      authorityNonce: crypto.randomBytes(24).toString('hex'),
      recommendationNonces: {
        create: crypto.randomBytes(24).toString('hex'),
        save: crypto.randomBytes(24).toString('hex'),
        submit: crypto.randomBytes(24).toString('hex'),
        changes: crypto.randomBytes(24).toString('hex'),
        issue: crypto.randomBytes(24).toString('hex'),
        withdraw: crypto.randomBytes(24).toString('hex'),
      },
      evidenceReleaseNonce: crypto.randomBytes(24).toString('hex'),
    });
  });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/cycles', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.intake.manage'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      const domain = tprmDomain();
      if (!domain) return res.status(503).render('error', { user: req.user, ws: req.workspace, message: 'The governed Third-party risk service is unavailable.' });
      try {
        const existing = domain.currentCycle(db, req.workspace.id, supplier.id);
        const expected = Number(req.body.expected_current_cycle_id || 0);
        if (existing) {
          if (expected && expected !== existing.id) throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'The active assessment cycle changed; reload before continuing.', 409);
          return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#cycle-governance`, 'The current assessment cycle is already active.', 'info'));
        }
        if (expected) throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'The expected assessment cycle is no longer active; reload before starting another.', 409);
        const cycleType = String(req.body.cycle_type || 'onboarding');
        const dueAt = String(req.body.due_at || '').trim() || null;
        if (dueAt && !domain.validIsoDate(dueAt)) throw new domain.TprmDomainError('TPRM_CYCLE_DATE_INVALID', 'Assessment due date must be a valid date.', 400);
        const baseline = domain.approvedBaseline(db, req.workspace.id, supplier.id);
        const artifacts = currentArtifactIds(req.workspace.id, supplier.id, !baseline);
        const relationshipIds = [...new Set((Array.isArray(req.body.relationship_ids) ? req.body.relationship_ids : [req.body.relationship_ids])
          .map(Number).filter(id => Number.isInteger(id) && id > 0))];
        if (!relationshipIds.length) throw new domain.TprmDomainError('TPRM_RELATIONSHIP_SCOPE_REQUIRED', 'Select at least one service relationship for this assessment cycle.', 400);
        const scopedRelationships = db.prepare(`SELECT * FROM tprm_service_relationships
          WHERE workspace_id=? AND supplier_id=? AND status NOT IN ('terminated','rejected')
            AND id IN (${relationshipIds.map(() => '?').join(',')})`).all(req.workspace.id, supplier.id, ...relationshipIds);
        if (scopedRelationships.length !== relationshipIds.length) throw new domain.TprmDomainError('TPRM_RELATIONSHIP_SCOPE_INVALID', 'One or more selected services no longer belong to this third party or cannot be assessed.', 409);
        const triggerReason = String(req.body.trigger_reason || '').trim() || `${titleCase(cycleType)} assessment of selected service relationships.`;
        const result = db.transaction(() => {
          const created = domain.ensureCurrentCycle(db, {
            workspaceId: req.workspace.id, supplierId: supplier.id, actorId: req.user.id,
            cycleType, triggerReason,
            dueAt, clientDecisionAuthorityId: req.body.client_decision_authority_id || undefined,
            ...artifacts, idempotencyKey: req.body.idempotency_key,
          });
          for (const relationship of scopedRelationships) {
            tprmRelationships.linkAssessmentCycle(db, {
              workspaceId:req.workspace.id, relationshipId:relationship.id, cycleId:created.cycle.id,
              scopeRole:relationship.is_primary ? 'primary' : 'in_scope', actorId:req.user.id,
              scopeRationale:`Included in ${titleCase(cycleType).toLowerCase()} assessment: ${triggerReason}`,
            });
          }
          return created;
        }).immediate();
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'start_tprm_assessment_cycle', 'tprm_assessment_cycle', result.cycle.id, { supplierId: supplier.id, cycleType, relationshipIds }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#cycle-governance`, `${titleCase(cycleType)} assessment cycle ${result.created ? 'started' : 'opened'}.`, 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#cycle-governance', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/cycles/:cycleId/authority', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.assessment.manage'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.BOUNDED_ASSESSMENT), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      const domain = tprmDomain();
      try {
        const cycle = domain.currentCycle(db, req.workspace.id, supplier.id);
        if (!cycle || cycle.id !== Number(req.params.cycleId)) throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'The active assessment cycle changed; reload before assigning authority.', 409);
        if (Number(req.body.expected_cycle_row_version) !== cycle.row_version) throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'The assessment cycle changed; reload before assigning authority.', 409);
        const result = domain.assignClientDecisionAuthority(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, cycleId: cycle.id,
          actorId: req.user.id, clientDecisionAuthorityId: req.body.client_decision_authority_id,
          reason: String(req.body.reason || '').trim() || undefined, idempotencyKey: req.body.idempotency_key,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'assign_tprm_client_decision_authority', 'tprm_assessment_cycle', cycle.id, { supplierId: supplier.id, authorityId: result.authority.id }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#cycle-governance`, `${result.authority.name} is the client decision authority for this cycle.`, 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#cycle-governance', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/recommendation-drafts', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.recommendation.draft'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.RECOMMENDATION), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      const domain = tprmDomain();
      try {
        const cycle = domain.currentCycle(db, req.workspace.id, supplier.id);
        if (!cycle || cycle.id !== Number(req.body.cycle_id)) throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'The active assessment cycle changed; reload before drafting the recommendation.', 409);
        if (Number(req.body.expected_cycle_row_version) !== cycle.row_version) throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'Assessment artifacts or decision authority changed; reload before drafting.', 409);
        const baseKey = String(req.body.idempotency_key || '');
        if (baseKey.length < 32 || baseKey.length > 128 || baseKey !== baseKey.trim()) {
          throw new domain.TprmDomainError('TPRM_IDEMPOTENCY_KEY_INVALID', 'The recommendation form token is invalid. Reload and try again.', 400);
        }
        const result = db.transaction(() => {
          const created = recommendationWorkflowService.createDraft(db, {
            workspaceId: req.workspace.id, supplierId: supplier.id, cycleId: cycle.id,
            actorId: req.user.id, idempotencyKey: crypto.createHash('sha256').update(`create:${baseKey}`).digest('hex'),
          });
          return recommendationWorkflowService.saveRevision(db, {
            workspaceId: req.workspace.id, supplierId: supplier.id, draftId: created.draft.id,
            actorId: req.user.id, expectedRowVersion: 1, expectedRevisionNumber: 0,
            ...recommendationRevisionInput(req.body),
            idempotencyKey: crypto.createHash('sha256').update(`revision:${baseKey}`).digest('hex'),
          });
        }).immediate();
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'create_tprm_recommendation_draft', 'tprm_recommendation_draft', result.draft.id, { supplierId: supplier.id, cycleId: cycle.id, revision: result.currentRevision.revision_number }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#recommendation`, 'Recommendation draft saved. Submit the exact revision when it is ready for independent review.', 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#recommendation', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/recommendation-drafts/:draftId(\\d+)/revisions', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.recommendation.draft'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.RECOMMENDATION), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      try {
        const result = recommendationWorkflowService.saveRevision(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, draftId: req.params.draftId,
          actorId: req.user.id, expectedRowVersion: req.body.expected_row_version,
          expectedRevisionNumber: req.body.expected_revision_number,
          ...recommendationRevisionInput(req.body), idempotencyKey: req.body.idempotency_key,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'save_tprm_recommendation_revision', 'tprm_recommendation_draft', result.draft.id, { supplierId: supplier.id, revision: result.currentRevision.revision_number }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#recommendation`, `Immutable draft revision ${result.currentRevision.revision_number} saved.`, 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#recommendation', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/recommendation-drafts/:draftId(\\d+)/submit', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.recommendation.draft'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.RECOMMENDATION), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      try {
        const result = recommendationWorkflowService.submitForReview(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, draftId: req.params.draftId,
          actorId: req.user.id, reviewerId: req.body.reviewer_id,
          expectedRowVersion: req.body.expected_row_version,
          expectedRevisionNumber: req.body.expected_revision_number,
          idempotencyKey: req.body.idempotency_key,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'submit_tprm_recommendation_review', 'tprm_recommendation_draft', result.draft.id, { supplierId: supplier.id, revision: result.draft.submitted_revision_number, reviewerId: result.draft.reviewer_id }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#recommendation`, `Revision ${result.draft.submitted_revision_number} submitted to ${result.draft.reviewer_name} for independent review.`, 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#recommendation', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/recommendation-drafts/:draftId(\\d+)/request-changes', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.recommendation.issue'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.RECOMMENDATION), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      try {
        const result = recommendationWorkflowService.requestChanges(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, draftId: req.params.draftId,
          actorId: req.user.id, expectedRowVersion: req.body.expected_row_version,
          expectedRevisionNumber: req.body.expected_revision_number,
          note: req.body.note, idempotencyKey: req.body.idempotency_key,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'request_tprm_recommendation_changes', 'tprm_recommendation_draft', result.draft.id, { supplierId: supplier.id, revision: result.draft.submitted_revision_number }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#recommendation`, 'Recommendation returned to its author with the recorded rationale.', 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#recommendation', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/recommendation-drafts/:draftId(\\d+)/issue', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.recommendation.issue'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.RECOMMENDATION), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      try {
        const domain = tprmDomain();
        if (req.body.quality_review_confirmed !== '1') throw new domain.TprmDomainError('TPRM_QA_CONFIRMATION_REQUIRED', 'Confirm that you independently reviewed the exact submitted revision and governed evidence.', 400);
        const result = recommendationWorkflowService.issue(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, draftId: req.params.draftId,
          actorId: req.user.id, expectedRowVersion: req.body.expected_row_version,
          expectedRevisionNumber: req.body.expected_revision_number,
          expectedCurrentRecommendationId: Number(req.body.expected_current_recommendation_id || 0) || null,
          qualityReviewRationale: req.body.quality_review_rationale,
          idempotencyKey: req.body.idempotency_key,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'issue_tprm_consultancy_recommendation', 'tprm_recommendation', result.recommendation.id, { supplierId: supplier.id, draftId: result.draft.id, draftRevision: result.draft.submitted_revision_number, version: result.recommendation.version, outcome: result.recommendation.outcome }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#recommendation`, `Consultancy recommendation v${result.recommendation.version} issued from reviewed draft revision ${result.draft.submitted_revision_number}.`, 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#recommendation', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/recommendation-drafts/:draftId(\\d+)/withdraw', requireAuth, requireWorkspace, workspaceBase,
    requireRecommendationWorkflowActor, requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.RECOMMENDATION), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      try {
        const result = recommendationWorkflowService.withdraw(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, draftId: req.params.draftId,
          actorId: req.user.id, expectedRowVersion: req.body.expected_row_version,
          reason: req.body.reason, idempotencyKey: req.body.idempotency_key,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'withdraw_tprm_recommendation_draft', 'tprm_recommendation_draft', result.draft.id, { supplierId: supplier.id, reason: req.body.reason }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#recommendation`, 'Recommendation draft withdrawn; its revision and review history remain retained.', 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#recommendation', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/evidence-releases', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.assurance.export'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.EVIDENCE_DISCLOSURE), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      const domain = tprmDomain();
      try {
        if (!domain || typeof domain.releaseEvidence !== 'function') throw new Error('Evidence disclosure service is unavailable.');
        const cycle = domain.currentCycle(db, req.workspace.id, supplier.id);
        if (!cycle || cycle.id !== Number(req.body.cycle_id)) {
          throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'The active assessment cycle changed; reload before releasing evidence.', 409);
        }
        if (Number(req.body.expected_cycle_row_version) !== cycle.row_version) {
          throw new domain.TprmDomainError('TPRM_STALE_CYCLE', 'Assessment scope changed; reload before releasing evidence.', 409);
        }
        if (req.body.release_confirmed !== '1') {
          throw new domain.TprmDomainError('TPRM_EVIDENCE_RELEASE_CONFIRMATION_REQUIRED', 'Confirm that the client-safe metadata is approved for disclosure.', 400);
        }
        const reference = String(req.body.evidence_reference || '');
        const match = reference.match(/^(supplier_document|ddq_evidence):(\d+)$/);
        if (!match) throw new domain.TprmDomainError('TPRM_EVIDENCE_SOURCE_INVALID', 'Select evidence from the governed cycle.', 400);
        const clientDescription = String(req.body.client_description || '').trim();
        if (clientDescription.length < 10) {
          throw new domain.TprmDomainError('TPRM_EVIDENCE_PURPOSE_REQUIRED', 'Explain the client-facing purpose in at least 10 characters.', 400);
        }
        const result = domain.releaseEvidence(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, cycleId: cycle.id,
          sourceType: match[1], sourceId: Number(match[2]), actorId: req.user.id,
          clientLabel: req.body.client_label, clientDescription,
          allowDownload: req.body.allow_download === '1',
          expiresAt: String(req.body.expires_at || '').trim() || null,
          reason: `Approved client disclosure: ${clientDescription}`,
          idempotencyKey: req.body.idempotency_key,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'release_tprm_evidence_metadata', 'tprm_evidence_release', result.release.id, {
          supplierId: supplier.id, cycleId: cycle.id, sourceType: match[1], allowDownload: Boolean(result.release.allow_download),
        }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#client-evidence`, result.replayed ? 'This evidence metadata was already released to the client.' : 'Evidence metadata released to the client.', 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#client-evidence', error); }
    });

  app.post('/workspaces/:wsId/tprm/third-parties/:id/evidence-releases/:releaseId/withdraw', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.assurance.export'), requireFirmUser, requireActiveTprm,
    requireServiceCapability(serviceCapabilities.CAPABILITIES.EVIDENCE_DISCLOSURE), (req, res) => {
      const supplier = scopedThirdParty(req.workspace.id, Number(req.params.id));
      if (!supplier) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Third party not found for this client.' });
      const domain = tprmDomain();
      try {
        if (!domain || typeof domain.withdrawEvidenceRelease !== 'function') throw new Error('Evidence disclosure service is unavailable.');
        const releaseId = Number(req.params.releaseId);
        const idempotencyKey = String(req.body.idempotency_key || '');
        const replay = idempotencyKey ? db.prepare('SELECT event_type,payload_json FROM tprm_lifecycle_events WHERE idempotency_key=?').get(idempotencyKey) : null;
        if (replay) {
          let payload = {};
          try { payload = JSON.parse(replay.payload_json || '{}'); } catch (_) { payload = {}; }
          if (replay.event_type !== 'evidence_release_withdrawn' || Number(payload.releaseId) !== releaseId) {
            throw new domain.TprmDomainError('TPRM_IDEMPOTENCY_CONFLICT', 'This request token was already used for another governed action.', 409);
          }
          return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#client-evidence`, 'This client evidence release was already withdrawn.', 'info'));
        }
        const release = db.prepare(`SELECT r.id,r.cycle_id,r.release_hash,w.id AS withdrawal_id
          FROM tprm_evidence_releases r LEFT JOIN tprm_evidence_release_withdrawals w ON w.release_id=r.id
          WHERE r.id=? AND r.workspace_id=? AND r.supplier_id=?`).get(releaseId, req.workspace.id, supplier.id);
        if (!release) throw new domain.TprmDomainError('TPRM_EVIDENCE_RELEASE_NOT_FOUND', 'Evidence release not found for this third party.', 404);
        if (String(req.body.expected_release_hash || '') !== release.release_hash) {
          throw new domain.TprmDomainError('TPRM_STALE_EVIDENCE_RELEASE', 'The evidence release changed; reload before withdrawing it.', 409);
        }
        if (release.withdrawal_id || Number(req.body.expected_withdrawal_id || 0) !== 0) {
          throw new domain.TprmDomainError('TPRM_STALE_EVIDENCE_RELEASE', 'This evidence release is no longer active.', 409);
        }
        const result = domain.withdrawEvidenceRelease(db, {
          workspaceId: req.workspace.id, supplierId: supplier.id, releaseId,
          actorId: req.user.id, reason: req.body.reason,
          idempotencyKey,
        });
        if (typeof logAction === 'function') logAction(req.user.id, req.workspace.id, 'withdraw_tprm_evidence_metadata', 'tprm_evidence_release', releaseId, {
          supplierId: supplier.id, cycleId: release.cycle_id, withdrawalId: result.withdrawal.id,
        }, auditCtx(req));
        return res.redirect(303, withToast(`/workspaces/${req.workspace.id}/tprm/third-parties/${supplier.id}#client-evidence`, 'Client evidence release withdrawn. The historical authorization remains auditable.', 'success'));
      } catch (error) { return redirectDomainError(req, res, supplier.id, '#client-evidence', error); }
    });

  app.get('/workspaces/:wsId/tprm/assessments', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    const portfolio = buildPortfolio(req.workspace.id);
    let rows = portfolio.active.filter(row => row.inherent_id || row.ddq_id || row.contract_review_id);
    if (req.query.attention === '1') rows = rows.filter(row => ['critical', 'high'].includes(row.nextAction.priority) && row.nextAction.waitingOn !== 'Provider contact');
    if (req.query.waiting === 'provider') rows = rows.filter(row => row.nextAction.waitingOn === 'Provider contact');
    rows.sort((a, b) => a.nextAction.rank - b.nextAction.rank || a.name.localeCompare(b.name));
    res.render('tprm_assessments', { ...workspaceLocals(req, portfolio, 'tprm-assessments'), rows });
  });

  app.get('/workspaces/:wsId/tprm/findings', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    const portfolio = buildPortfolio(req.workspace.id);
    const thirdPartyId = Number(req.query.third_party || 0);
    const status = String(req.query.status || 'open');
    let sql = `SELECT f.*,l.domain,l.due_date,l.owner_name,l.risk_acceptance_reason,l.risk_acceptance_expires_at,l.accepted_at,s.id AS supplier_id,s.name AS supplier_name
      FROM findings f INNER JOIN supplier_finding_links l ON l.finding_id=f.id INNER JOIN suppliers s ON s.id=l.supplier_id
      WHERE f.workspace_id=?`;
    const params = [req.workspace.id];
    if (thirdPartyId) { sql += ' AND s.id=?'; params.push(thirdPartyId); }
    if (status === 'open') sql += ` AND f.status NOT IN ('closed','verified')`;
    if (status === 'accepted') sql += ` AND f.status='accepted_risk'`;
    if (status === 'closed') sql += ` AND f.status IN ('closed','verified')`;
    sql += ` ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,CASE WHEN l.due_date IS NULL THEN 1 ELSE 0 END,l.due_date,f.created_at DESC`;
    const findings = db.prepare(sql).all(...params);
    res.render('tprm_findings', { ...workspaceLocals(req, portfolio, 'tprm-findings'), findings, filters: { thirdPartyId, status } });
  });

  app.get('/workspaces/:wsId/tprm/monitoring', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    const portfolio = buildPortfolio(req.workspace.id);
    let renewals = portfolio.active.filter(row => row.contract_end || row.next_review_date || row.expiring_document_count);
    if (req.query.attention === '1') renewals = renewals.filter(row => isPast(row.next_review_date, portfolio.today) || Number(row.expiring_document_count) > 0 || (row.contract_end && row.contract_end <= new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)));
    renewals.sort((a, b) => String(a.next_review_date || a.contract_end || '9999').localeCompare(String(b.next_review_date || b.contract_end || '9999')));
    const events = db.prepare(`SELECT m.*,s.name AS supplier_name FROM supplier_monitoring m INNER JOIN suppliers s ON s.id=m.supplier_id
      WHERE m.workspace_id=? ORDER BY m.recorded_at DESC,m.id DESC LIMIT 100`).all(req.workspace.id);
    res.render('tprm_monitoring', { ...workspaceLocals(req, portfolio, 'tprm-monitoring'), renewals, events });
  });

  app.get('/workspaces/:wsId/tprm/reports', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    const portfolio = buildPortfolio(req.workspace.id);
    const decided = portfolio.active.filter(row => row.client_decision).length;
    const completeRecords = portfolio.active.filter(row => row.business_owner && row.relationship_owner && row.service_provided && row.next_review_date).length;
    res.render('tprm_reports', {
      ...workspaceLocals(req, portfolio, 'tprm-reports'),
      reportQuality: {
        decisionCoverage: portfolio.active.length ? Math.round(decided * 100 / portfolio.active.length) : 100,
        registerCompleteness: portfolio.active.length ? Math.round(completeRecords * 100 / portfolio.active.length) : 100,
      }
    });
  });

  app.get('/workspaces/:wsId/tprm/assurance', requireAuth, requireWorkspace, workspaceBase,
    requirePermission('tprm.assurance.view'), (req, res) => {
    const portfolio = buildPortfolio(req.workspace.id);
    const methodology = tableExists('supplier_risk_methodologies') ? db.prepare(`SELECT * FROM supplier_risk_methodologies WHERE workspace_id=? AND is_active=1 ORDER BY version DESC LIMIT 1`).get(req.workspace.id) : null;
    const auditEvents = db.prepare(`SELECT a.*,u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.workspace_id=? AND (a.entity_type LIKE 'supplier%' OR a.entity_type LIKE 'tprm_%') ORDER BY a.id DESC LIMIT 50`).all(req.workspace.id);
    const evidenceDisclosures = evidenceReleaseHistory(req.workspace.id);
    const frameworkEvidence = frameworkCoverage.workspaceCoverage(db, req.workspace.id);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.render('tprm_assurance', { ...workspaceLocals(req, portfolio, 'tprm-reports'), methodology, auditEvents, evidenceDisclosures, frameworkEvidence });
  });

  app.get('/workspaces/:wsId/tprm/settings', requireAuth, requireWorkspace, workspaceBase, (req, res) => {
    if (req.user.user_type !== 'firm' || !rbac.isManager(req.user.firm_role)) {
      return res.status(403).render('error', { user: req.user, ws: req.workspace, message: 'Methodology and module settings are restricted to firm managers.' });
    }
    const portfolio = buildPortfolio(req.workspace.id);
    const methodologies = tableExists('supplier_risk_methodologies') ? db.prepare(`SELECT m.*,u.name AS published_by_name FROM supplier_risk_methodologies m LEFT JOIN users u ON u.id=m.published_by WHERE m.workspace_id=? ORDER BY m.version DESC,m.id DESC`).all(req.workspace.id) : [];
    res.render('tprm_settings', { ...workspaceLocals(req, portfolio, 'tprm-settings'), methodologies });
  });

  // Firm portfolio: managers and senior consultants see the firm; consultants
  // see only assigned workspaces. Workspace IDs remain part of every row, so
  // same-named providers are never merged across clients.
  app.get('/tprm', requireAuth, (req, res) => {
    if (!req.user || req.user.user_type !== 'firm') return res.status(403).render('error', { user: req.user, message: 'The firm Third-party risk portfolio is available to consulting-team accounts.' });
    const role = rbac.normalizeRole(req.user.firm_role) || 'consultant';
    if (!rbac.hasPermission(rbac.rolePermissions(role), 'tprm.portfolio.view')) return res.status(403).render('error', { user: req.user, message: 'Your role does not include access to the firm Third-party risk portfolio.' });
    const crossView = rbac.isManager(role) || rbac.rolePermissions(role).includes('firm.cross_view');
    const membershipClause = crossView ? '' : ` AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.user_id=?)`;
    const scopeSql = `SELECT w.id FROM workspaces w WHERE w.firm_id=?${membershipClause}
      AND (
        EXISTS (SELECT 1 FROM tprm_modules tm WHERE tm.workspace_id=w.id AND tm.status IN ('active','needs_classification'))
        OR (NOT EXISTS (SELECT 1 FROM tprm_modules tm WHERE tm.workspace_id=w.id)
            AND EXISTS (SELECT 1 FROM suppliers s0 WHERE s0.workspace_id=w.id))
      )`;
    const scopeParams = crossView ? [req.user.firm_id] : [req.user.firm_id, req.user.id];

    const clientTotal = Number(db.prepare(`SELECT COUNT(*) AS count FROM workspaces scoped WHERE scoped.id IN (${scopeSql})`).get(...scopeParams).count || 0);
    const clientPerPage = 20;
    const clientPages = Math.max(1, Math.ceil(clientTotal / clientPerPage));
    const requestedClientPage = Number.parseInt(String(req.query.page || '1'), 10);
    const clientPage = Math.min(Math.max(Number.isFinite(requestedClientPage) ? requestedClientPage : 1, 1), clientPages);
    const enabledWorkspaces = db.prepare(`SELECT scoped.*,u.name AS lead_consultant_name
      FROM workspaces scoped LEFT JOIN users u ON u.id=scoped.lead_consultant_id
      WHERE scoped.id IN (${scopeSql}) ORDER BY scoped.client_name,scoped.id LIMIT ? OFFSET ?`)
      .all(...scopeParams, clientPerPage, (clientPage - 1) * clientPerPage);
    const clientPg = { page: clientPage, pages: clientPages, total: clientTotal, perPage: clientPerPage };

    const queueRequestQuery = { ...req.query, page: req.query.queue_page || '1', per_page: '30' };
    const queuePgRaw = thirdPartyPage([], queueRequestQuery, {
      workspaceScopeSql: scopeSql,
      workspaceScopeParams: scopeParams,
      priorityOrder: true,
    });
    const today = new Date().toISOString().slice(0, 10);
    const queue = enrich(queuePgRaw.rows, today)
      .sort((a, b) => a.nextAction.rank - b.nextAction.rank || String(a.nextAction.dueDate || '9999').localeCompare(String(b.nextAction.dueDate || '9999')) || a.name.localeCompare(b.name));
    const aggregate = aggregateThirdPartyPortfolio([], { workspaceScopeSql: scopeSql, workspaceScopeParams: scopeParams });
    const pageWorkspaceIds = enabledWorkspaces.map(workspace => workspace.id);
    const perWorkspace = aggregateThirdPartyPortfolio(pageWorkspaceIds, { groupByWorkspace: true });
    const perClient = enabledWorkspaces.map(workspace => {
      const metrics = perWorkspace.get(Number(workspace.id)) || {};
      return {
        ...workspace,
        thirdPartyCount: metrics.thirdPartyCount || 0,
        actionCount: metrics.actionCount || 0,
        criticalExposure: metrics.highResidual || 0,
        overdueReviews: metrics.overdueReviews || 0,
      };
    });
    const portfolio = {
      today,
      thirdParties: queue,
      active: queue.filter(row => !row.archived_at && row.lifecycle_stage !== 'terminated'),
      queue,
      metrics: {
        actionRequired: aggregate.actionCount || 0,
        waitingProvider: aggregate.waitingProvider || 0,
        highResidual: aggregate.highResidual || 0,
        overdueExpiring: aggregate.overdueExpiring || 0,
      },
    };
    const queuePg = { ...queuePgRaw, rows: queue };
    res.render('tprm_firm_portfolio', {
      user: req.user, active: 'tprm-portfolio', portfolio, perClient, titleCase, dateOnly, crossView,
      filters: queuePg.filters,
      queuePg,
      queuePagerHref: page => queryPageHref(req, 'queue_page', page),
      clientPg,
      clientPagerHref: page => queryPageHref(req, 'page', page),
    });
  });
}

module.exports = { register };
