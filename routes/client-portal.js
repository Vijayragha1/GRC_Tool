'use strict';

// Client collaboration portal. This is the deliberately narrow surface for
// client contributors and the shared request workspace for consultants, client
// owners, and ISMS managers. Every object lookup is workspace-qualified; every
// mutable request operation is versioned; every lifecycle change is written to
// both an append-only request event stream and the global hash-chained audit log.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rbac = require('../lib/rbac');
const enc = require('../lib/encryption');
const documentHtml = require('../lib/document-html');
const evWrites = require('../lib/evidence-writes');
const docApprovals = require('../lib/doc-approvals');
const delivery = require('../lib/engagement-delivery');
const clientGapAssessment = require('../lib/client-gap-assessment');
const { buildIntegratedDashboard } = require('../lib/integrated-dashboard');
const uploadSecurity = require('../lib/upload-security');
const { withToast, auditCtx } = require('../lib/http-helpers');
const { todayFor } = require('../lib/dates');

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
const TPRM_CLIENT_DECISIONS = new Set(['onboard', 'onboard_with_conditions', 'do_not_onboard', 'defer_request_information']);
const TPRM_POSITIVE_DECISIONS = new Set(['onboard', 'onboard_with_conditions']);
const TPRM_NEGATIVE_RECOMMENDATIONS = new Set(['do_not_recommend', 'insufficient_information']);

let tprmDomainCache;
function tprmDomain() {
  if (tprmDomainCache !== undefined) return tprmDomainCache;
  try { tprmDomainCache = require('../lib/tprm-domain'); }
  catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    tprmDomainCache = null;
  }
  return tprmDomainCache;
}
const clientStatus = value => ({
  draft: 'in preparation', workspace_verified: 'ready for approval', submitted: 'under review',
  changes_requested: 'changes requested', accepted: 'approved', rejected: 'not approved',
  superseded: 'replaced', open: 'open', in_progress: 'in progress', cancelled: 'cancelled'
}[String(value || '').toLowerCase()] || String(value || '').replace(/_/g, ' '));

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

  function workspaceRole(req) {
    return rbac.normalizeRole(req.workspace._userRole || req.workspace.role);
  }

  function allowFirmPermission(req, res, permission) {
    if (req.user.user_type === 'firm' && !can(req, permission)) {
      res.status(403).send('Forbidden');
      return false;
    }
    return true;
  }

  // Keep direct request loads aligned with the portal list: contributors see
  // their own assignments, client coordinators see released team work, and
  // firm actors retain workspace-scoped operating access.
  function requestVisibility(req, alias = 'cr', clientPreview = false) {
    if (isContributor(req)) return { clause: `${alias}.assignee_id=?`, params: [req.user.id] };
    if (req.user.user_type === 'client' || clientPreview) {
      return { clause: `${alias}.assignee_id IS NOT NULL`, params: [] };
    }
    return { clause: '', params: [] };
  }

  function deliveryVisibleToActor(req, row, clientPreview = false) {
    const assignedToClient = row.owner_id != null || row.approver_id != null;
    if (req.user.user_type === 'firm') return clientPreview ? assignedToClient : true;
    if (isContributor(req)) {
      return row.owner_id === req.user.id || row.approver_id === req.user.id;
    }
    return assignedToClient;
  }

  function tableExists(name) {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  }

  function clientDownloadSourceAvailable(storedPath, firmId) {
    const token = String(storedPath || '');
    if (!token || path.basename(token) !== token) return false;
    try {
      const filePath = resolveUploadPath(token, firmId);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
      const uploadsRoot = fs.realpathSync(path.join(__dirname, '..', 'uploads'));
      const realFile = fs.realpathSync(filePath);
      return realFile !== uploadsRoot && realFile.startsWith(`${uploadsRoot}${path.sep}`);
    } catch (_) {
      return false;
    }
  }

  function activeClientMember(req) {
    if (req.user.user_type !== 'client') return null;
    const member = db.prepare(`SELECT wm.user_id,wm.role,u.name,u.email
      FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
      WHERE wm.workspace_id=? AND wm.user_id=? AND u.user_type='client' AND u.active=1`).get(
      req.workspace.id, req.user.id);
    return member ? { ...member, role: rbac.normalizeRole(member.role) } : null;
  }

  function clientTprmModule(workspaceId) {
    const domain = tprmDomain();
    if (domain) {
      if (typeof domain.moduleForWorkspace === 'function') {
        return domain.moduleForWorkspace(db, workspaceId, { includeClosed: true });
      }
      return null;
    }
    return tableExists('tprm_modules')
      ? db.prepare(`SELECT * FROM tprm_modules WHERE workspace_id=? ORDER BY id DESC LIMIT 1`).get(workspaceId) || null
      : null;
  }

  function tprmModuleReadable(workspaceId) {
    const module = clientTprmModule(workspaceId);
    return Boolean(module && ['active', 'closed'].includes(module.status));
  }

  function tprmModuleEnabled(workspaceId) {
    return clientTprmModule(workspaceId)?.status === 'active';
  }

  function requireClientTprmActor(req, res, next) {
    if (req.user.user_type === 'client' && !activeClientMember(req)) {
      return res.status(403).render('error', {
        user: req.user, ws: req.workspace,
        message: 'Your active client membership is required to use third-party risk.'
      });
    }
    const module = clientTprmModule(req.workspace.id);
    if (!module || !['active', 'closed'].includes(module.status)) {
      return res.status(404).render('error', {
        user: req.user, ws: req.workspace,
        message: 'Third-party risk assurance is not available for this client.'
      });
    }
    req.clientTprmModule = module;
    next();
  }

  function requireActiveClientTprm(req, res, next) {
    const module = req.clientTprmModule || clientTprmModule(req.workspace.id);
    if (!module || module.status !== 'active') {
      return res.status(409).render('error', {
        user: req.user, ws: req.workspace,
        message: 'This TPRM service period is closed and retained read-only. No new client action was recorded.'
      });
    }
    next();
  }

  const first = (...values) => values.find(value => value !== undefined && value !== null);
  const safeText = (value, max = 12000) => value == null ? null : String(value).slice(0, max);
  const safeArray = value => Array.isArray(value) ? value : [];
  function parsedConditions(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [{ description: safeText(value) }];
    } catch (_) {
      return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        .map(description => ({ description }));
    }
  }

  function clientSafeRecommendation(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') return { outcome: raw, status: 'issued' };
    return {
      id: first(raw.id, raw.recommendation_id),
      cycleId: first(raw.cycle_id, raw.assessment_cycle_id),
      version: first(raw.version, raw.version_number, raw.recommendation_version),
      status: safeText(first(raw.status, raw.state, 'issued'), 40),
      outcome: safeText(first(raw.outcome, raw.recommendation, raw.decision), 80),
      summary: safeText(first(raw.client_summary, raw.executive_summary, raw.summary, raw.rationale, raw.recommendation_rationale)),
      residualRiskBand: safeText(first(raw.residual_risk_band, raw.residualRiskBand), 40),
      conditions: parsedConditions(first(raw.conditions, raw.conditions_json)),
      issuedByName: safeText(first(raw.issued_by_name, raw.issuer_name, raw.quality_reviewer_name, raw.reviewer_name, raw.decider_name), 180),
      issuedAt: safeText(first(raw.issued_at, raw.published_at, raw.decided_at), 40),
      validUntil: safeText(first(raw.valid_until, raw.expires_at), 40)
    };
  }

  function clientSafeDecision(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') return { decision: raw };
    return {
      id: first(raw.id, raw.decision_id),
      cycleId: first(raw.cycle_id, raw.assessment_cycle_id),
      recommendationId: first(raw.recommendation_id, raw.consultancy_recommendation_id),
      recommendationVersion: first(raw.recommendation_version, raw.consultancy_recommendation_version),
      decision: safeText(first(raw.decision, raw.outcome), 80),
      rationale: safeText(first(raw.rationale, raw.business_rationale)),
      conditions: parsedConditions(first(raw.conditions, raw.conditions_json)),
      decidedByName: safeText(first(raw.decided_by_name, raw.client_actor_name, raw.decision_authority_name, raw.actor_name), 180),
      decidedAt: safeText(first(raw.decided_at, raw.created_at), 40),
      validUntil: safeText(first(raw.valid_until, raw.expires_at, raw.review_date), 40),
      differsFromRecommendation: !!first(raw.differs_from_recommendation, raw.diverges_from_recommendation, raw.is_override, false),
      riskAccepted: !!first(raw.risk_accepted, raw.accepted_residual_risk, raw.risk_acceptance_statement, false),
      riskAcceptanceRationale: safeText(first(raw.risk_acceptance_rationale, raw.risk_acceptance_statement, raw.acceptance_rationale)),
      riskAcceptanceExpiresAt: safeText(first(raw.risk_acceptance_expires_at, raw.acceptance_expires_at), 40)
    };
  }

  function clientSafeCondition(raw, index) {
    if (typeof raw === 'string') raw = { description: raw };
    raw = raw || {};
    return {
      id: first(raw.id, `condition-${index + 1}`),
      title: safeText(first(raw.title, raw.name), 180),
      description: safeText(first(raw.description, raw.condition, raw.text), 4000),
      status: safeText(first(raw.effective_status, raw.status, 'open'), 40),
      storedStatus: safeText(first(raw.stored_status, raw.status, 'open'), 40),
      waiverExpired: raw.waiver_expired === true || raw.waiver_expired === 1,
      waiverExpiresAt: safeText(first(raw.waiver_expires_at, raw.waiverExpiresAt), 40),
      ownerName: safeText(first(raw.owner_name, raw.ownerName), 180),
      ownerUserId: first(raw.owner_user_id, raw.ownerUserId),
      dueDate: safeText(first(raw.due_date, raw.dueDate), 40),
      verifiedAt: safeText(first(raw.verified_at, raw.closed_at), 40),
      sourceType: safeText(first(raw.source_type, raw.sourceType), 40),
      conditionType: safeText(first(raw.condition_type, raw.conditionType, 'other'), 40),
      severity: safeText(first(raw.severity, 'moderate'), 40),
      ownerType: safeText(first(raw.owner_type, raw.ownerType, 'client'), 40),
      verificationCriteria: safeText(first(raw.verification_criteria, raw.verificationCriteria,
        'The client owner confirms completion and the consultancy verifies suitable evidence.'), 4000),
      findingId: first(raw.finding_id, raw.findingId)
    };
  }

  function clientSafeServiceRelationship(raw, index) {
    raw = raw || {};
    return {
      id: Number(first(raw.relationship_id, raw.id, index + 1)),
      name: safeText(first(raw.relationship_name, raw.name), 300),
      legalName: safeText(first(raw.legal_name, raw.legalName), 300),
      scopeRole: safeText(first(raw.scope_role, raw.role, 'in_scope'), 40),
      scopeRationale: safeText(first(raw.scope_rationale, raw.scopeRationale), 2000),
      serviceCategory: safeText(first(raw.service_category, raw.category), 200),
      serviceDescription: safeText(first(raw.service_description, raw.description), 4000),
      criticality: safeText(first(raw.criticality, 'unknown'), 40),
      dataAccess: safeText(first(raw.data_access, raw.dataAccess, 'unknown'), 40),
      status: safeText(first(raw.status, raw.relationship_status), 40),
      linkedAt: safeText(first(raw.linked_at, raw.linkedAt), 40),
    };
  }

  function clientSafeThirdParty(raw) {
    const supplier = raw?.thirdParty || raw?.third_party || raw?.supplier || raw || {};
    const cycle = raw?.cycle || raw?.currentCycle || raw?.current_cycle || null;
    const recommendation = clientSafeRecommendation(raw?.recommendation || raw?.consultancyRecommendation || raw?.current_recommendation);
    const decision = clientSafeDecision(raw?.clientDecision || raw?.client_decision || raw?.current_client_decision);
    const governedTier = first(
      supplier.governed_tier, raw?.governed_tier, raw?.approved_tier,
      raw?.approved_inherent_tier
    );
    return {
      id: Number(first(supplier.id, raw?.supplier_id, 0)),
      workspaceId: Number(first(supplier.workspace_id, raw?.workspace_id, 0)),
      name: safeText(first(supplier.name, raw?.supplier_name), 240),
      service: safeText(first(supplier.service_provided, supplier.service, supplier.service_name), 1000),
      businessOwner: safeText(first(supplier.business_owner, supplier.businessOwner), 240),
      relationshipOwner: safeText(first(supplier.relationship_owner, supplier.relationshipOwner), 240),
      tier: safeText(governedTier, 40) || 'not_assessed',
      lifecycleStage: safeText(first(raw?.stage, raw?.lifecycle?.stage, raw?.lifecycle_stage, supplier.lifecycle_stage, 'assessment'), 80),
      residualRiskBand: safeText(first(
        raw?.residual_risk_band, raw?.residualRiskBand, recommendation?.residualRiskBand
      ), 40),
      nextReviewDate: safeText(first(raw?.next_review_date, raw?.nextReviewDate, raw?.lifecycle?.nextReviewDate, supplier.next_review_date), 40),
      cycle: cycle ? {
        id: first(cycle.id, cycle.cycle_id),
        reference: safeText(first(cycle.reference, cycle.cycle_reference), 120),
        type: safeText(first(cycle.cycle_type, cycle.assessment_type, cycle.type), 60),
        status: safeText(first(cycle.status, cycle.stage), 60),
        decisionAuthorityId: first(cycle.client_decision_authority_id, cycle.decision_authority_id),
        startedAt: safeText(first(cycle.started_at, cycle.created_at), 40)
      } : null,
      recommendation,
      clientDecision: decision,
      openConditionCount: Number(first(raw?.open_condition_count, raw?.openConditionCount, 0)),
      nextAction: safeText(first(raw?.next_action_label, raw?.nextAction?.label, raw?.lifecycle?.nextAction?.label,
        raw?.next_action?.label, raw?.next_action), 240)
    };
  }

  function legacyClientTprmPortfolio(req) {
    const rows = db.prepare(`SELECT s.id,s.name,s.service_provided,s.business_owner,s.relationship_owner,
        s.tier,s.lifecycle_stage,s.next_review_date,
        d.id AS recommendation_id,d.decision AS recommendation_outcome,d.rationale AS recommendation_summary,
        d.conditions AS recommendation_conditions,d.residual_risk_band,d.decider_name AS recommendation_issued_by,
        d.decided_at AS recommendation_issued_at,d.valid_until AS recommendation_valid_until
      FROM suppliers s LEFT JOIN supplier_decisions d ON d.id=(SELECT d2.id FROM supplier_decisions d2
        WHERE d2.workspace_id=s.workspace_id AND d2.supplier_id=s.id AND d2.superseded_at IS NULL ORDER BY d2.id DESC LIMIT 1)
      WHERE s.workspace_id=? AND s.archived_at IS NULL ORDER BY s.name`).all(req.workspace.id);
    const thirdParties = rows.map(row => clientSafeThirdParty({
      supplier: row,
      recommendation: row.recommendation_id ? {
        id: row.recommendation_id,
        outcome: 'historical_assessment_outcome',
        summary: 'A historical supplier outcome exists, but it is quarantined from the governed consultancy-recommendation and client-decision workflow.',
        conditions: [],
        residual_risk_band: row.residual_risk_band,
        issued_by_name: row.recommendation_issued_by,
        issued_at: row.recommendation_issued_at,
        valid_until: row.recommendation_valid_until,
        status: 'historical'
      } : null
    }));
    return { thirdParties, actions: [], source: 'legacy-read-only' };
  }

  function clientTprmPortfolio(req) {
    const domain = tprmDomain();
    let raw = null;
    if (domain) {
      const fn = domain.clientPortfolioProjection || domain.clientPortalPortfolio || domain.clientPortfolio;
      if (typeof fn === 'function') raw = fn(db, req.workspace.id, req.user.id);
    }
    if (!raw) return legacyClientTprmPortfolio(req);
    const rows = safeArray(raw.thirdParties || raw.third_parties || raw.records || raw.items);
    const thirdParties = rows.map(clientSafeThirdParty).filter(row => row.id);
    const actions = safeArray(raw.actions || raw.assignedActions || raw.assigned_actions).map((action, index) => ({
      id: first(action.id, index + 1),
      supplierId: Number(first(action.supplier_id, action.third_party_id, action.supplierId, 0)),
      thirdPartyName: safeText(first(action.supplier_name, action.third_party_name, action.thirdPartyName), 240),
      title: safeText(first(action.title, action.label, action.action?.label, action.action), 240),
      dueDate: safeText(first(action.due_date, action.dueDate), 40),
      status: safeText(first(action.status, 'open'), 40),
      priority: safeText(first(action.priority, action.severity, 'normal'), 40)
    }));
    return {
      thirdParties,
      actions,
      source: 'governed',
      metrics: raw.metrics || {},
      retainedReadOnly: raw.retainedReadOnly === true || raw.retained_read_only === true,
    };
  }

  function clientTprmMetrics(portfolio) {
    const records = portfolio.thirdParties;
    const workspaceId = records[0]?.workspaceId || null;
    const openConditions = tableExists('tprm_conditions') && workspaceId
      ? Number(db.prepare(`SELECT COUNT(*) AS c FROM tprm_conditions
          WHERE workspace_id=?
            AND (status IN ('open','in_progress','evidence_submitted')
              OR (status='waived' AND waiver_expires_at < date('now')))`).get(workspaceId)?.c || 0)
      : records.reduce((sum, row) => sum + Number(row.openConditionCount || 0), 0);
    return {
      total: records.length,
      awaitingDecision: records.filter(row => row.recommendation &&
        ['issued', 'published', 'final', 'approved'].includes(String(row.recommendation.status || '').toLowerCase()) && !row.clientDecision).length,
      conditional: openConditions,
      highRisk: records.filter(row => ['high', 'critical'].includes(String(row.residualRiskBand || '').toLowerCase())).length,
      assignedActions: portfolio.actions.filter(action => !['closed', 'complete', 'verified'].includes(String(action.status).toLowerCase())).length
    };
  }

  function legacyClientTprmDetail(req, supplierId) {
    const supplier = db.prepare(`SELECT id,name,service_provided,business_owner,relationship_owner,tier,lifecycle_stage,next_review_date
      FROM suppliers WHERE id=? AND workspace_id=? AND archived_at IS NULL`).get(supplierId, req.workspace.id);
    if (!supplier) return null;
    const recommendation = db.prepare(`SELECT d.id,d.decision,d.rationale,d.conditions,d.residual_risk_band,
        d.decider_name,d.decided_at,d.valid_until
      FROM supplier_decisions d WHERE d.workspace_id=? AND d.supplier_id=? AND d.superseded_at IS NULL
      ORDER BY d.id DESC LIMIT 1`).get(req.workspace.id, supplierId);
    const ddq = db.prepare(`SELECT id,assessment_type,status,created_at FROM supplier_ddq_assessments
      WHERE workspace_id=? AND supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(req.workspace.id, supplierId);
    const inherent = db.prepare(`SELECT id,assessment_type,status,created_at FROM supplier_inherent_assessments
      WHERE workspace_id=? AND supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(req.workspace.id, supplierId);
    const evidenceCount = ddq ? Number(db.prepare(`SELECT COUNT(*) AS c FROM supplier_ddq_evidence
      WHERE workspace_id=? AND assessment_id=?`).get(req.workspace.id, ddq.id)?.c || 0) : 0;
    const comments = db.prepare(`SELECT c.id,c.body,c.created_at,u.name AS actor_name
      FROM comments c INNER JOIN users u ON u.id=c.user_id
      WHERE c.workspace_id=? AND c.parent_type='tprm_third_party' AND c.parent_id=? AND c.internal_only=0
      ORDER BY c.id`).all(req.workspace.id, String(supplierId)).map(comment => ({
        ...comment, body: enc.decryptIfNeeded(comment.body, req.workspace.id)
      }));
    const mappedRecommendation = recommendation ? {
      id: recommendation.id,
      outcome: 'historical_assessment_outcome',
      summary: 'A historical supplier outcome exists, but it is quarantined from the governed consultancy-recommendation and client-decision workflow.',
      conditions: [],
      residual_risk_band: recommendation.residual_risk_band,
      issued_by_name: recommendation.decider_name,
      issued_at: recommendation.decided_at,
      valid_until: recommendation.valid_until,
      status: 'historical'
    } : null;
    const thirdParty = clientSafeThirdParty({
      supplier,
      cycle: ddq || inherent ? {
        id: `legacy-${ddq?.id || inherent.id}`,
        assessment_type: ddq?.assessment_type || inherent?.assessment_type,
        status: ddq?.status || inherent?.status,
        created_at: ddq?.created_at || inherent?.created_at
      } : null,
      recommendation: mappedRecommendation
    });
    return {
      thirdParty,
      recommendation: thirdParty.recommendation,
      clientDecision: null,
      serviceRelationships: [],
      conditions: (thirdParty.recommendation?.conditions || []).map(clientSafeCondition),
      evidence: [],
      evidenceSummary: { reviewedItems: evidenceCount, disclosure: 'summary_only' },
      decisionHistory: [],
      events: [],
      comments,
      clientDecisionAuthorityId: null,
      source: 'legacy-read-only'
    };
  }

  function clientTprmDetail(req, supplierId) {
    const domain = tprmDomain();
    let raw = null;
    if (domain) {
      const fn = domain.clientThirdPartyProjection || domain.clientPortalDetail || domain.clientThirdParty;
      if (typeof fn === 'function') {
        try { raw = fn(db, req.workspace.id, supplierId, req.user.id); }
        catch (error) {
          if (Number(error.status || error.statusCode) === 404) return null;
          throw error;
        }
      }
    }
    if (!raw) return legacyClientTprmDetail(req, supplierId);
    const thirdParty = clientSafeThirdParty(raw);
    if (!thirdParty.id || thirdParty.id !== Number(supplierId)) return null;
    const recommendation = thirdParty.recommendation;
    const clientDecision = thirdParty.clientDecision;
    const serviceRelationships = safeArray(raw.serviceRelationships || raw.service_relationships || raw.relationshipScopes)
      .map(clientSafeServiceRelationship).filter(relationship => relationship.id && relationship.name);
    const conditionsRaw = safeArray(raw.conditions || raw.currentConditions || raw.current_conditions);
    const conditions = (conditionsRaw.length ? conditionsRaw : [
      ...(recommendation?.conditions || []), ...(clientDecision?.conditions || [])
    ]).map(clientSafeCondition);
    const evidenceRoot = raw.evidence || raw.clientEvidence || raw.client_evidence || [];
    const evidenceRows = Array.isArray(evidenceRoot) ? evidenceRoot
      : [...safeArray(evidenceRoot.supplierDocuments || evidenceRoot.supplier_documents),
        ...safeArray(evidenceRoot.ddqEvidence || evidenceRoot.ddq_evidence)];
    // Evidence metadata is itself sensitive. Only explicitly released rows are
    // named in the client portal; the aggregate reviewed count can still be
    // shown without exposing filenames from internal workpapers.
    const cycleId = thirdParty.cycle?.id;
    const releasedEvidenceRows = tableExists('tprm_evidence_releases') && cycleId
      ? db.prepare(`SELECT r.id,r.id AS release_id,r.client_label AS filename,
          r.client_description,r.source_type AS category,
          r.allow_download,r.released_at,r.expires_at AS access_expires_at,
          sd.effective_date AS source_issued_at,sd.expiry_date AS source_expiry,
          COALESCE(sd.sha256,de.sha256) AS sha256,
          COALESCE(sd.stored_path,de.stored_path) AS source_stored_path,
          CASE
            WHEN r.source_type='supplier_document' AND sd.id IS NOT NULL
              AND sd.stored_path IS NOT NULL
              AND (sd.expiry_date IS NULL OR date(sd.expiry_date)>=date('now')) THEN 1
            WHEN r.source_type='ddq_evidence' AND de.id IS NOT NULL
              AND de.stored_path IS NOT NULL AND da.supplier_id=r.supplier_id
              AND release_cycle.ddq_assessment_id=da.id THEN 1
            ELSE 0
          END AS source_download_eligible
        FROM tprm_evidence_releases r
        LEFT JOIN tprm_evidence_release_withdrawals w ON w.release_id=r.id
          AND w.workspace_id=r.workspace_id AND w.supplier_id=r.supplier_id
        LEFT JOIN supplier_documents sd ON r.source_type='supplier_document' AND sd.id=r.supplier_document_id
          AND sd.workspace_id=r.workspace_id AND sd.supplier_id=r.supplier_id
        LEFT JOIN supplier_ddq_evidence de ON r.source_type='ddq_evidence' AND de.id=r.ddq_evidence_id
          AND de.workspace_id=r.workspace_id
        LEFT JOIN supplier_ddq_assessments da ON da.id=de.assessment_id
          AND da.workspace_id=r.workspace_id
        LEFT JOIN tprm_assessment_cycles release_cycle ON release_cycle.id=r.cycle_id
          AND release_cycle.workspace_id=r.workspace_id
          AND release_cycle.supplier_id=r.supplier_id
        WHERE r.workspace_id=? AND r.supplier_id=? AND r.cycle_id=? AND w.id IS NULL
          AND (r.expires_at IS NULL OR r.expires_at>=date('now'))
        ORDER BY r.released_at DESC,r.id DESC`).all(req.workspace.id, supplierId, cycleId)
      : evidenceRows.filter(item => item.client_visible === 1 || item.client_visible === true
        || item.released_at || item.client_released_at);
    const evidence = releasedEvidenceRows.map(item => {
      let sourceFileAvailable = false;
      if (item.source_download_eligible === 1 && item.source_stored_path) {
        sourceFileAvailable = clientDownloadSourceAvailable(
          item.source_stored_path, req.workspace.firm_id
        );
      }
      const allowDownload = item.allow_download === 1 || item.allow_download === true;
      return {
        id: first(item.release_id, item.id, item.evidence_id),
        releaseId: first(item.release_id, item.id),
        filename: safeText(first(item.client_label, item.filename, item.name), 260),
        description: safeText(first(item.client_description, item.description), 1000),
        category: safeText(first(item.category, item.doc_type, item.evidence_type), 120),
        status: safeText(first(item.status, item.review_status, 'released'), 80),
        releasedAt: safeText(first(item.released_at, item.releasedAt), 40),
        issuedAt: safeText(first(item.source_issued_at, item.issued_at, item.issuedAt,
          item.released_at, item.releasedAt, item.uploaded_at, item.created_at), 40),
        sourceExpiry: safeText(first(item.source_expiry, item.sourceExpiry), 40),
        accessExpiresAt: safeText(first(item.access_expires_at, item.accessExpiresAt,
          item.release_expires_at), 40),
        allowDownload,
        downloadAvailable: allowDownload && sourceFileAvailable && Boolean(item.release_id || item.id),
        sha256: safeText(item.sha256, 64)
      };
    });
    const clientMember = activeClientMember(req);
    if (clientMember && tableExists('tprm_condition_evidence_links')) {
      const conditionEvidence = db.prepare(`SELECT id,condition_id,mime_type,size_bytes,uploaded_at,stored_path
        FROM tprm_condition_evidence_links
        WHERE workspace_id=? AND supplier_id=? ORDER BY condition_id,uploaded_at DESC,id DESC`)
        .all(req.workspace.id, supplierId);
      const evidenceByCondition = new Map();
      for (const item of conditionEvidence) {
        const rows = evidenceByCondition.get(Number(item.condition_id)) || [];
        if (clientDownloadSourceAvailable(item.stored_path, req.workspace.firm_id)) {
          rows.push({
            id: Number(item.id),
            uploadedAt: safeText(item.uploaded_at, 40),
            sizeBytes: Number(item.size_bytes || 0),
            mediaType: safeText(item.mime_type, 120),
          });
        }
        evidenceByCondition.set(Number(item.condition_id), rows);
      }
      for (const condition of conditions) {
        const mayInspect = condition.sourceType === 'client_decision'
          && condition.ownerType === 'client'
          && (clientMember.role === 'isms_manager'
            || Number(condition.ownerUserId || 0) === Number(req.user.id));
        condition.evidenceDownloads = mayInspect
          ? (evidenceByCondition.get(Number(condition.id)) || []) : [];
      }
    } else {
      for (const condition of conditions) condition.evidenceDownloads = [];
    }
    const decisionHistory = safeArray(raw.decisionHistory || raw.decision_history)
      .map(clientSafeDecision).filter(Boolean);
    const events = safeArray(raw.events || raw.history || raw.lifecycleEvents || raw.lifecycle_events).map(event => ({
      id: first(event.id, event.event_id),
      type: safeText(first(event.client_label, event.event_type, event.type), 120),
      summary: safeText(first(event.client_summary, event.summary), 1000),
      actorName: safeText(first(event.actor_name, event.created_by_name), 180),
      createdAt: safeText(first(event.created_at, event.recorded_at), 40)
    }));
    // Collaboration comments are reloaded from the workspace-qualified source
    // of truth on every request. This avoids stale projection caches and keeps
    // encrypted-at-rest bodies out of generic domain serialization.
    const comments = db.prepare(`SELECT c.id,c.body,c.created_at,u.name AS actor_name
      FROM comments c INNER JOIN users u ON u.id=c.user_id
      WHERE c.workspace_id=? AND c.parent_type='tprm_third_party' AND c.parent_id=? AND c.internal_only=0
      ORDER BY c.id`).all(req.workspace.id, String(supplierId)).map(comment => ({
        id:comment.id,
        body:enc.decryptIfNeeded(comment.body, req.workspace.id),
        actorName:comment.actor_name,
        createdAt:comment.created_at,
      }));
    return {
      thirdParty, recommendation, clientDecision, serviceRelationships, conditions, evidence,
      evidenceSummary: raw.evidenceSummary || raw.evidence_summary || {
        reviewedItems: evidenceRows.length, releasedItems: evidence.length
      },
      decisionHistory, events, comments,
      clientDecisionAuthorityId: first(thirdParty.cycle?.decisionAuthorityId,
        raw.clientDecisionAuthorityId, raw.client_decision_authority_id),
      latestClientDecisionId: first(raw.latestClientDecisionId, raw.latest_client_decision_id,
        safeArray(raw.decisionHistory || raw.decision_history)[0]?.id),
      recommendationDecisionBlocker: safeText(first(raw.recommendationDecisionBlocker,
        raw.recommendation_decision_blocker), 500),
      domainCanRecordClientDecision: raw.canRecordClientDecision === true,
      retainedReadOnly: raw.retainedReadOnly === true || raw.retained_read_only === true
        || raw.lifecycle?.module?.status === 'closed',
      source: 'governed'
    };
  }

  function clientDecisionContradicts(recommendationOutcome, decision) {
    const recommendation = String(recommendationOutcome || '').toLowerCase();
    if (!TPRM_POSITIVE_DECISIONS.has(decision)) return false;
    if (TPRM_NEGATIVE_RECOMMENDATIONS.has(recommendation)) return true;
    return recommendation === 'recommend_with_conditions' && decision === 'onboard';
  }

  function tprmDecisionAuthority(req, detail) {
    const member = activeClientMember(req);
    if (!member || member.role !== 'client_owner') return false;
    const assignedId = Number(detail.clientDecisionAuthorityId || 0);
    return !assignedId || assignedId === req.user.id;
  }

  function renderClientTprmPortfolio(req, res) {
    const portfolio = clientTprmPortfolio(req);
    const retainedReadOnly = req.clientTprmModule?.status === 'closed' || portfolio.retainedReadOnly === true;
    return res.render('client_tprm_portfolio', {
      user: req.user, ws: req.workspace, active: 'client-portal', title: 'Third-party risk',
      portalView: 'tprm', tprmPortalEnabled: true,
      clientPreview: req.user.user_type === 'firm', clientPreviewUser: null,
      portfolio, metrics: clientTprmMetrics(portfolio), tprmRetainedReadOnly: retainedReadOnly,
    });
  }

  function renderClientTprmDetail(req, res, detail, form = { values: {}, errors: {} }) {
    const isPreview = req.user.user_type === 'firm';
    const retainedReadOnly = req.clientTprmModule?.status === 'closed' || detail.retainedReadOnly === true;
    const deferredAwaitingSuccessorDecision = detail.clientDecision?.decision === 'defer_request_information'
      && Number(detail.recommendation?.id || 0) !== Number(detail.clientDecision?.recommendationId || 0);
    const cycleDecisionSlotOpen = !detail.clientDecision || deferredAwaitingSuccessorDecision;
    return res.render('client_tprm_detail', {
      user: req.user, ws: req.workspace, active: 'client-portal',
      title: detail.thirdParty.name || 'Third-party assurance', portalView: 'tprm',
      tprmPortalEnabled: true, clientPreview: isPreview, clientPreviewUser: null,
      detail, canDecide: !retainedReadOnly && !isPreview && cycleDecisionSlotOpen
        && Array.isArray(detail.serviceRelationships) && detail.serviceRelationships.length > 0
        && !detail.recommendationDecisionBlocker
        && detail.domainCanRecordClientDecision
        && tprmDecisionAuthority(req, detail),
      decisionBlocker: detail.recommendationDecisionBlocker,
      canComment: !retainedReadOnly && !isPreview && req.user.user_type === 'client' && can(req, 'tprm.client_comment'),
      tprmRetainedReadOnly: retainedReadOnly,
      clientParticipants: clientMembers(req).filter(member =>
        ['client_owner', 'client_admin'].includes(String(member.role || '').toLowerCase())),
      requiresRiskAcceptance: clientDecisionContradicts(detail.recommendation?.outcome, String(form.values.decision || '')),
      decisionNonce: crypto.randomBytes(24).toString('hex'), form
    });
  }

  function reconcileDeliveryCompletion(req, context = {}) {
    const frameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    if (!frameworks.includes('iso27001')) return;
    if (!db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=?').get(req.workspace.id)) return;
    delivery.reconcileCompletionState(db, req.workspace, req.user.id, context);
    delivery.syncOutcomePlanStatus(db, req.workspace, req.user.id);
    delivery.syncCertificationEngagementCompletion(db, req.workspace, req.user.id);
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

  function requestFormFailure(req, res, errors) {
    // Render the complete portal view model in place with HTTP 422. Keep only
    // fields this form owns and cap every reflected value. Users retain their
    // work, the browser stays in context, and no sensitive draft is persisted
    // in the session merely because validation failed.
    const raw = req.body || {};
    return renderClientPortal(req, res.status(422), {
      values: {
        request_type: String(raw.request_type || '').slice(0, 24),
        priority: String(raw.priority || '').slice(0, 24),
        assignee_id: String(raw.assignee_id || '').slice(0, 24),
        due_date: String(raw.due_date || '').slice(0, 32),
        control_id: String(raw.control_id || '').slice(0, 120),
        document_id: String(raw.document_id || '').slice(0, 24),
        title: String(raw.title || '').slice(0, MAX_TITLE),
        description: String(raw.description || '').slice(0, MAX_DESCRIPTION)
      },
      errors,
      hasErrors: true
    });
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
    const visibility = requestVisibility(req);
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
      WHERE cr.id=? AND cr.workspace_id=?${visibility.clause ? ` AND ${visibility.clause}` : ''}`)
      .get(id, req.workspace.id, ...visibility.params);
    if (!row) return null;
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

  function clientPolicyAccessible(req, document) {
    if (req.user.user_type === 'firm') return true;
    if (isContributor(req)) return targetAccessible(req, 'document', document.id);
    if (!['client_owner', 'isms_manager'].includes(workspaceRole(req))) return false;

    const sharedRequest = db.prepare(`SELECT 1 FROM client_requests
      WHERE workspace_id=? AND document_id=? AND assignee_id IS NOT NULL AND status!='cancelled'
      LIMIT 1`).get(req.workspace.id, document.id);
    if (sharedRequest) return true;
    if (!document.current_version_id) return false;
    return !!db.prepare(`SELECT 1 FROM doc_approvers
      WHERE workspace_id=? AND document_id=? AND version_id=? AND user_id=?
      LIMIT 1`).get(req.workspace.id, document.id, document.current_version_id, req.user.id);
  }

  function loadVisiblePolicy(req, documentId) {
    const document = db.prepare(`SELECT d.*, u.name AS creator_name
      FROM generated_docs d LEFT JOIN users u ON u.id=d.created_by
      WHERE d.id=? AND d.workspace_id=?`).get(documentId, req.workspace.id);
    return document && clientPolicyAccessible(req, document) ? document : null;
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
      WHERE workspace_id=? AND status NOT IN ('retired','withdrawn') ORDER BY name`).all(req.workspace.id);
  }

  function renderClientPortal(req, res, suppliedRequestForm = null) {
      const allowedPortalViews = new Set(['home', 'actions', 'progress', 'findings', 'reports']);
      const portalView = suppliedRequestForm
        ? 'actions'
        : (allowedPortalViews.has(String(req.query.view || '')) ? String(req.query.view) : 'home');
      const requestForm = suppliedRequestForm || { values: {}, errors: {}, hasErrors: false };
      const clientPreview = req.user.user_type === 'firm' && req.query.preview === 'client';
      const members = clientMembers(req);
      const clientPreviewUser = clientPreview
        ? (members.find(member => member.role === 'client_owner') || members[0] || null)
        : null;
      const portalActorId = clientPreviewUser?.id || req.user.id;
      const clientAudience = req.user.user_type === 'client' || clientPreview;
      const filters = [];
      const params = [req.workspace.id];
      const visibility = requestVisibility(req, 'cr', clientPreview);
      if (visibility.clause) filters.push(visibility.clause);
      params.push(...visibility.params);
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
        WHERE cr.workspace_id=?${visibility.clause ? ` AND ${visibility.clause}` : ''}`)
        .all(req.workspace.id, ...visibility.params);
      const today = todayFor(req.workspace);
      const requestMetrics = {
        active: allVisible.filter(r => !TERMINAL.has(r.status)).length,
        overdue: allVisible.filter(r => ['open','in_progress','changes_requested'].includes(r.status) &&
          r.due_date && r.due_date < today).length,
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

      const workspaceFrameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
      const deliveryProjection = workspaceFrameworks.includes('iso27001')
        ? delivery.getProjection(db, req.workspace, portalActorId, { ensure: false })
        : null;
      let deliveryWork = [];
      if (deliveryProjection) {
        deliveryWork = deliveryProjection.deliverables.filter(d => d.client_visible &&
          deliveryVisibleToActor(req, d, clientPreview));
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
      const mayViewPublishedReports = req.user.user_type === 'client' || can(req, 'report.view');
      const publishedReports = mayViewPublishedReports
        ? db.prepare(`SELECT r.id,r.title,r.report_type,r.version_number,r.published_at,p.name published_by_name
          FROM consulting_report_snapshots r LEFT JOIN users p ON p.id=r.published_by
          WHERE r.workspace_id=? AND r.status='published' ORDER BY r.published_at DESC,r.id DESC`).all(req.workspace.id)
        : [];
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
      const clientMemberIds = new Set(members.map(member => member.id));
      const isClientDeliveryAction = d => {
        const effectiveStatus = d.effective_status || d.status;
        if (isContributor(req)) {
          return (d.owner_id === portalActorId && ['draft','changes_requested'].includes(d.status)) ||
            (d.approver_id === portalActorId && ['submitted','workspace_verified'].includes(effectiveStatus));
        }
        if (clientAudience) {
          return (clientMemberIds.has(d.owner_id) && ['draft','changes_requested'].includes(d.status)) ||
            (clientMemberIds.has(d.approver_id) && ['submitted','workspace_verified'].includes(effectiveStatus));
        }
        return (d.owner_id === portalActorId && ['draft','changes_requested'].includes(d.status)) ||
          (d.approver_id === portalActorId && ['submitted','workspace_verified'].includes(effectiveStatus));
      };
      const clientDeliveryActions = deliveryWork.filter(d =>
        isClientDeliveryAction(d));
      const overdueDeliverables = clientDeliveryActions.filter(d =>
        d.due_date && d.due_date < today && !['accepted','superseded'].includes(d.status)).length;
      const awaitingReviewDeliverables = deliveryWork.filter(d => {
        const effectiveStatus = d.effective_status || d.status;
        if (!['submitted','workspace_verified'].includes(effectiveStatus)) return false;
        if (isContributor(req)) return d.owner_id === portalActorId && !clientMemberIds.has(d.approver_id);
        if (clientAudience) return clientMemberIds.has(d.owner_id) && !clientMemberIds.has(d.approver_id);
        return d.owner_id === portalActorId;
      }).length;
      const metrics = {
        activeRequests: allVisible.filter(r => ['open', 'in_progress', 'changes_requested'].includes(r.status)).length,
        deliverablesToProvide: clientDeliveryActions.filter(d =>
          clientMemberIds.has(d.owner_id) && ['draft','changes_requested'].includes(d.status)).length,
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
        assigneeId: isContributor(req) ? req.user.id : null,
        releasedOnly: clientAudience && !isContributor(req)
      });
      // The gap-assessment projection carries its own released-report list for
      // the progress rail. Keep it under the same contextual report.view rule
      // as the dedicated Reports tab so a firm-side revoke cannot be bypassed
      // through the secondary projection; client actors retain published access.
      if (!mayViewPublishedReports) gapAssessment.reports = [];
      let frameworkWorkspace = req.workspace;
      if (!Array.isArray(frameworkWorkspace.frameworks)) {
        let parsed = [];
        try { parsed = JSON.parse(frameworkWorkspace.frameworks || '[]'); } catch (_) {}
        frameworkWorkspace = { ...frameworkWorkspace, frameworks: parsed };
      }
      const programmeTruth = buildIntegratedDashboard(db, frameworkWorkspace, {
        actorId: isContributor(req) ? portalActorId : null,
        clientFacing: clientAudience,
        today
      });
      metrics.overdue = programmeTruth.client.overdueCount;
      metrics.awaitingReview = programmeTruth.client.awaitingReviewCount;
      metrics.allZero = metrics.activeRequests === 0 && metrics.deliverablesToProvide === 0 &&
        metrics.overdue === 0 && metrics.awaitingReview === 0;
      const clientProgrammes = programmeTruth.programmes.map(programme => ({
        key: programme.key,
        label: programme.label,
        short: programme.short,
        descriptor: programme.descriptor,
        status: programme.status,
        completionPct: programme.completionPct,
        assessmentDetail: programme.assessmentDetail,
        currentLabel: programme.currentLabel,
        currentDetail: programme.currentDetail,
        openItems: programme.openItems,
        unassessedOutcomes: programme.unassessedOutcomes,
        openConfirmedFindings: programme.openConfirmedFindings,
        unsupportedImplemented: programme.unsupportedImplemented || 0
      }));
      const actionCount = programmeTruth.client.actionCount + pendingApprovals.length +
        (clientValidations || []).length + (csfValidations || []).length;
      const blockerCount = programmeTruth.client.blockerCount +
        (gapAssessment.applicable ? gapAssessment.blockers.filter(blocker => blocker.source === 'fieldwork').length : 0);
      const statusTone = blockerCount ? 'risk' : actionCount ? 'attention' : 'good';
      const clientStatusSummary = {
        tone: statusTone,
        label: statusTone === 'risk' ? 'Needs attention' : statusTone === 'attention' ? 'In progress' : 'On track',
        actionCount,
        blockerCount,
        message: statusTone === 'risk'
          ? `${blockerCount} blocker${blockerCount === 1 ? ' needs' : 's need'} attention.`
          : actionCount
            ? `${actionCount} item${actionCount === 1 ? ' needs' : 's need'} action from your team.`
            : 'There is nothing your team needs to do right now.'
      };

      return res.render('client_portal', {
        user: req.user, ws: req.workspace, active: 'client-portal', title: 'Client portal',
        requests, metrics, pendingApprovals, recentEvents, status,
        canManage: clientPreview ? false : can(req, 'client_request.manage'), members,
        clientPreview, clientPreviewUser,
        controls: can(req, 'client_request.manage') ? controlCatalog() : [],
        documents: can(req, 'client_request.manage') ? documentCatalog(req) : [],
        deliveryPlan: deliveryProjection?.plan || null, deliveryWork, deliveryEvidence, deliveryComments, clientValidations, publishedReports,
        csfValidations, csfPublishedReports, consultantContact, deliverySummary, clientDeliveryActions, gapAssessment,
        portalView, clientProgrammes, clientStatusSummary, requestForm,
        tprmPortalEnabled: tprmModuleReadable(req.workspace.id) && can(req, 'tprm.client_portal.view')
      });
  }

  app.get('/workspaces/:wsId/client-portal', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => renderClientPortal(req, res));

  app.get('/workspaces/:wsId/client-portal/tprm', requireAuth, requireWorkspace,
    requirePermission('tprm.client_portal.view'), requireClientTprmActor,
    (req, res) => renderClientTprmPortfolio(req, res));

  app.get('/workspaces/:wsId/client-portal/tprm/:supplierId(\\d+)', requireAuth, requireWorkspace,
    requirePermission('tprm.client_portal.view'), requireClientTprmActor, (req, res) => {
      const detail = clientTprmDetail(req, Number(req.params.supplierId));
      if (!detail) return res.status(404).render('error', {
        user: req.user, ws: req.workspace,
        message: 'This third party is unavailable or does not belong to this client.'
      });
      return renderClientTprmDetail(req, res, detail);
    });

  app.post('/workspaces/:wsId/client-portal/tprm/:supplierId(\\d+)/decision', requireAuth, requireWorkspace,
    requirePermission('tprm.client_decide'), requireClientTprmActor, requireActiveClientTprm, (req, res) => {
      const supplierId = Number(req.params.supplierId);
      const detail = clientTprmDetail(req, supplierId);
      if (!detail) return res.status(404).render('error', {
        user: req.user, ws: req.workspace,
        message: 'This third party is unavailable or does not belong to this client.'
      });
      // Permission overrides and the firm-manager wildcard can never convert a
      // consultancy user into the client's decision authority.
      if (req.user.user_type !== 'client' || !tprmDecisionAuthority(req, detail)) {
        return res.status(403).render('error', {
          user: req.user, ws: req.workspace,
          message: 'Only the assigned client decision authority can record the final onboarding decision.'
        });
      }
      if (!detail.recommendation || !['issued', 'published', 'final', 'approved'].includes(String(detail.recommendation.status || '').toLowerCase())) {
        return res.status(409).render('error', {
          user: req.user, ws: req.workspace,
          message: 'The consultancy recommendation must be issued before the client decision can be recorded.'
        });
      }
      const deferredAwaitingSuccessorDecision = detail.clientDecision?.decision === 'defer_request_information'
        && Number(detail.recommendation?.id || 0) !== Number(detail.clientDecision?.recommendationId || 0);
      if (detail.clientDecision && !deferredAwaitingSuccessorDecision) {
        return res.status(409).render('error', {
          user: req.user, ws: req.workspace,
          message: 'The client decision is immutable. Start a governed reassessment cycle to record a new decision.'
        });
      }
      if (detail.recommendationDecisionBlocker) {
        return res.status(409).render('error', {
          user: req.user, ws: req.workspace,
          message: detail.recommendationDecisionBlocker
        });
      }

      const values = {
        decision: clean(req.body.decision, 80),
        rationale: clean(req.body.rationale, MAX_NOTE),
        valid_until: clean(req.body.valid_until, 40),
        condition_title: clean(req.body.condition_title, 240),
        condition_owner_id: clean(req.body.condition_owner_id, 40),
        condition_due_date: clean(req.body.condition_due_date, 40),
        risk_acceptance_rationale: clean(req.body.risk_acceptance_rationale, MAX_NOTE),
        risk_acceptance_expires_at: clean(req.body.risk_acceptance_expires_at, 40)
      };
      const errors = {};
      if (!TPRM_CLIENT_DECISIONS.has(values.decision)) errors.decision = 'Choose a valid onboarding decision.';
      if (!values.rationale || values.rationale.length < 20) errors.rationale = 'Explain the business decision in at least 20 characters.';
      const today = todayFor(req.workspace);
      const validUntil = validDate(values.valid_until);
      if (values.valid_until && !validUntil) errors.valid_until = 'Enter a valid decision review date.';
      else if (validUntil && validUntil <= today) errors.valid_until = 'Decision review date must be in the future.';
      if (req.body.acknowledge_authority !== '1') errors.acknowledge_authority = 'Confirm that you are authorised to make this decision for the client.';

      const expectedRecommendationId = Number(req.body.expected_recommendation_id || 0);
      if (!expectedRecommendationId || expectedRecommendationId !== Number(detail.recommendation.id)) {
        return res.status(409).render('error', {
          user: req.user, ws: req.workspace,
          message: 'The consultancy recommendation changed while this page was open. Review the latest issued recommendation before deciding.'
        });
      }
      const idempotencyNonce = String(req.body.idempotency_nonce || '').trim();
      if (!/^[a-f0-9]{48}$/.test(idempotencyNonce)) errors.form = 'The decision form expired. Reload the page and submit again.';

      const conditions = [];
      if (values.condition_title) {
        if (values.condition_title.length < 10) errors.condition_title = 'Describe the condition in at least 10 characters.';
        const dueDate = validDate(values.condition_due_date);
        if (!dueDate) errors.condition_due_date = 'A valid due date is required for every new condition.';
        const ownerId = Number(values.condition_owner_id || 0);
        const owner = ownerId ? db.prepare(`SELECT u.id,u.name FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
          WHERE wm.workspace_id=? AND wm.user_id=? AND u.user_type='client' AND u.active=1
            AND wm.role IN ('client_owner','client_admin')`).get(req.workspace.id, ownerId) : null;
        if (!owner) errors.condition_owner_id = 'Assign the condition to an active client sponsor or administrator.';
        if (dueDate && owner) conditions.push({
          conditionType: 'other', title: values.condition_title, description: values.condition_title,
          severity: 'moderate', ownerType: 'client', ownerUserId: owner.id, ownerName: owner.name,
          dueDate, verificationCriteria: 'The client owner confirms completion and the consultancy verifies suitable evidence.'
        });
      }
      const issuedConditions = detail.conditions.filter(condition => condition.sourceType === 'recommendation').map(condition => ({
        findingId: condition.findingId || null,
        conditionType: condition.conditionType || 'other', title: condition.title || condition.description,
        description: condition.description || condition.title,
        severity: condition.severity || 'moderate', ownerType: condition.ownerType || 'client',
        ownerUserId: condition.ownerUserId || null, ownerName: condition.ownerName || 'Client owner',
        dueDate: condition.dueDate,
        verificationCriteria: condition.verificationCriteria || 'The client owner confirms completion and the consultancy verifies suitable evidence.'
      }));
      if (values.decision === 'onboard_with_conditions' && !conditions.length && !issuedConditions.length) {
        errors.condition_title = 'Add an owned, dated condition or ask the consultancy to issue conditions first.';
      }

      const highResidualRisk = ['high', 'critical'].includes(String(detail.thirdParty.residualRiskBand || '').toLowerCase());
      const riskAcceptanceRequired = TPRM_POSITIVE_DECISIONS.has(values.decision) &&
        (highResidualRisk || clientDecisionContradicts(detail.recommendation.outcome, values.decision));
      const riskAcceptanceExpiresAt = validDate(values.risk_acceptance_expires_at);
      if (riskAcceptanceRequired) {
        if (req.body.accept_residual_risk !== '1') errors.accept_residual_risk = 'Explicit residual-risk acceptance is required for this decision.';
        if (!values.risk_acceptance_rationale || values.risk_acceptance_rationale.length < 20) {
          errors.risk_acceptance_rationale = 'Explain why the residual risk is being accepted.';
        }
        if (!riskAcceptanceExpiresAt) errors.risk_acceptance_expires_at = 'Set a valid expiry date for the risk acceptance.';
        else if (riskAcceptanceExpiresAt <= today) errors.risk_acceptance_expires_at = 'Risk acceptance must expire on a future date.';
      } else if (values.risk_acceptance_expires_at && !riskAcceptanceExpiresAt) {
        errors.risk_acceptance_expires_at = 'Enter a valid risk-acceptance expiry date.';
      } else if (riskAcceptanceExpiresAt && riskAcceptanceExpiresAt <= today) {
        errors.risk_acceptance_expires_at = 'Risk acceptance must expire on a future date.';
      }

      if (Object.keys(errors).length) {
        return renderClientTprmDetail(req, res.status(422), detail, { values, errors });
      }

      const domain = tprmDomain();
      const recordDecision = domain && (domain.recordClientDecision || domain.captureClientDecision);
      if (typeof recordDecision !== 'function') {
        return res.status(503).render('error', {
          user: req.user, ws: req.workspace,
          message: 'The governed client-decision service is temporarily unavailable. No decision was recorded.'
        });
      }
      const submittedExpectedDecisionId = Number(req.body.expected_current_decision_id || 0) || null;
      const latestDecisionId = Number(detail.latestClientDecisionId || 0) || null;
      if (submittedExpectedDecisionId !== latestDecisionId) {
        return res.status(409).render('error', {
          user: req.user, ws: req.workspace,
          message: 'The client decision history changed while this page was open. Review the latest record before deciding.'
        });
      }
      let result;
      try {
        result = recordDecision(db, {
          workspaceId: req.workspace.id,
          supplierId,
          cycleId: detail.thirdParty.cycle?.id,
          recommendationId: detail.recommendation.id,
          actorId: req.user.id,
          decision: values.decision,
          rationale: values.rationale,
          validUntil,
          conditions: values.decision === 'onboard_with_conditions' ? [...issuedConditions, ...conditions] : [],
          riskAcceptance: {
            accepted: riskAcceptanceRequired || req.body.accept_residual_risk === '1',
            rationale: values.risk_acceptance_rationale || null,
            expiresAt: riskAcceptanceExpiresAt || null
          },
          idempotencyNonce,
          expectedCurrentDecisionId: latestDecisionId,
          recommendationOutcome: detail.recommendation.outcome
        });
      } catch (error) {
        const status = Number(error.status || error.statusCode || (error.code === 'CONFLICT' ? 409 : 422));
        return res.status([400, 403, 404, 409, 422].includes(status) ? status : 422).render('error', {
          user: req.user, ws: req.workspace,
          message: safeText(error.message, 500) || 'The governed client decision could not be recorded.'
        });
      }
      if (result && result.ok === false) {
        const status = Number(result.status || 422);
        return res.status([400, 403, 404, 409, 422].includes(status) ? status : 422).render('error', {
          user: req.user, ws: req.workspace,
          message: safeText(result.message, 500) || 'The governed client decision could not be recorded.'
        });
      }
      const decisionRecord = result?.decision || result?.record || result;
      logAction(req.user.id, req.workspace.id, 'tprm_client_decision_recorded', 'tprm_client_decision',
        decisionRecord?.id || supplierId, {
          supplier_id: supplierId, assessment_cycle_id: detail.thirdParty.cycle?.id || null,
          recommendation_id: detail.recommendation.id, decision: values.decision,
          differs_from_recommendation: clientDecisionContradicts(detail.recommendation.outcome, values.decision),
          risk_accepted: riskAcceptanceRequired || req.body.accept_residual_risk === '1'
        }, auditCtx(req));
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal/tprm/${supplierId}`, 'Client onboarding decision recorded.'));
    });

  app.post('/workspaces/:wsId/client-portal/tprm/:supplierId(\\d+)/comments', requireAuth, requireWorkspace,
    requirePermission('tprm.client_comment'), requireClientTprmActor, requireActiveClientTprm, (req, res) => {
      const supplierId = Number(req.params.supplierId);
      const detail = clientTprmDetail(req, supplierId);
      if (!detail) return res.status(404).render('error', {
        user: req.user, ws: req.workspace,
        message: 'This third party is unavailable or does not belong to this client.'
      });
      const member = activeClientMember(req);
      if (!member || !['client_owner', 'isms_manager'].includes(member.role)) {
        return res.status(403).render('error', {
          user: req.user, ws: req.workspace,
          message: 'Only the client decision authority or security reviewer can comment here.'
        });
      }
      const body = clean(req.body.body, MAX_COMMENT);
      if (!body || body === null) return badRequest(req, res, `Comment is required and must be under ${MAX_COMMENT} characters.`);
      const domain = tprmDomain();
      const addComment = domain && (domain.addClientComment || domain.recordClientComment);
      if (typeof addComment === 'function') {
        addComment(db, {
          workspaceId: req.workspace.id, supplierId,
          cycleId: detail.thirdParty.cycle?.id || null,
          actorId: req.user.id, body
        });
      } else {
        const storedBody = enc.encryptIfNeeded(body, req.workspace.id, !!req.workspace.encryption_enabled);
        db.prepare(`INSERT INTO comments (workspace_id,parent_type,parent_id,user_id,body,internal_only)
          VALUES (?,'tprm_third_party',?,?,?,0)`).run(
          req.workspace.id, String(supplierId), req.user.id,
          storedBody);
      }
      logAction(req.user.id, req.workspace.id, 'tprm_client_comment', 'supplier', supplierId,
        { assessment_cycle_id: detail.thirdParty.cycle?.id || null }, auditCtx(req));
      return res.redirect(`/workspaces/${req.workspace.id}/client-portal/tprm/${supplierId}#discussion`);
    });

  function loadVisibleDelivery(req, id) {
    const frameworks = Array.isArray(req.workspace.frameworks) ? req.workspace.frameworks : [];
    if (!frameworks.includes('iso27001')) return null;
    // `client_visible` is only the authoring flag.  The contracted lifecycle
    // projection is the authoritative boundary: a gap-assessment-only client
    // must not be able to act on retained implementation/certification rows by
    // guessing a deliverable id or replaying an old link.
    if (!delivery.isDeliverableInOutcomeScope(db, req.workspace, id)) return null;
    const row = db.prepare(`SELECT d.*,m.title milestone_title,p.name phase_name,m.source_rule
      FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
      JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE d.id=? AND d.workspace_id=? AND d.client_visible=1`).get(id, req.workspace.id);
    if (!row) return null;
    return deliveryVisibleToActor(req, row) ? row : null;
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
        res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal?view=actions`, 'Sent for approval.'));
      } catch (error) { res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal?view=actions`, error.message, 'error')); }
    });

  ['accept','changes','reject'].forEach(action => app.post(`/workspaces/:wsId/client-portal/deliverables/:id/${action}`, requireAuth, requireWorkspace,
    requirePermission('client_request.respond'), (req, res) => {
      const row = loadVisibleDelivery(req, req.params.id);
      if (!row) return badRequest(req, res, 'This item is unavailable or is not assigned to you.');
      try {
        delivery.transitionDeliverable(db, req.workspace, req.user.id, row.id, action, req.body.note);
        logAction(req.user.id, req.workspace.id, `client_${action}_delivery_deliverable`, 'engagement_deliverable', row.id, { note: req.body.note }, auditCtx(req));
        notify(row.owner_id, req, `Deliverable ${action}: ${row.title}`, req.body.note, `/workspaces/${req.workspace.id}/client-portal`, action === 'changes' ? 'warning' : 'info');
        res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal?view=actions`, 'Your response has been saved.'));
      } catch (error) { res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal?view=actions`, error.message, 'error')); }
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
      res.redirect(`/workspaces/${req.workspace.id}/client-portal?view=actions`);
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
      res.redirect(withToast(`/workspaces/${req.workspace.id}/client-portal?view=actions`, 'File added.'));
    });

  app.get('/workspaces/:wsId/client-portal/deliverables/:id/evidence/:evidenceId/download', requireAuth, requireWorkspace,
    requirePermission('client_portal.view'), (req, res) => {
      if (!allowFirmPermission(req, res, 'evidence.download')) return;
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
      const errors = {};
      if (!REQUEST_TYPES.has(type)) errors.request_type = 'Choose a valid request type.';
      if (!PRIORITIES.has(priority)) errors.priority = 'Choose a valid priority.';
      if (!title || title === null) errors.title = `Enter a title of ${MAX_TITLE} characters or fewer.`;
      if (description === null) errors.description = `Keep the context to ${MAX_DESCRIPTION} characters or fewer.`;
      if (dueDate === false) errors.due_date = 'Enter a valid calendar date.';
      if (req.body.assignee_id && (!Number.isInteger(assigneeId) || assigneeId <= 0)) {
        errors.assignee_id = 'Choose an assignee from this workspace.';
      }
      if (req.body.document_id && (!Number.isInteger(documentId) || documentId <= 0)) {
        errors.document_id = 'Choose a policy from this workspace.';
      }
      if (type === 'control' && !controlId) errors.control_id = 'Choose the control or clause this request concerns.';
      if (type === 'policy' && !documentId) errors.document_id = 'Choose the policy this request concerns.';
      if (!errors.assignee_id && assigneeId && !db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
          WHERE wm.workspace_id=? AND wm.user_id=? AND u.active=1 AND u.user_type='client'`).get(req.workspace.id, assigneeId)) {
        errors.assignee_id = 'Choose an active client member of this workspace.';
      }
      if (controlId && !db.prepare(`SELECT 1 FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(controlId)) {
        errors.control_id = 'Choose a control or clause from the list.';
      }
      if (!errors.document_id && documentId && !db.prepare(`SELECT 1 FROM generated_docs
          WHERE id=? AND workspace_id=? AND status NOT IN ('retired','withdrawn')`).get(documentId, req.workspace.id)) {
        errors.document_id = 'Choose an active policy from this workspace.';
      }
      if (Object.keys(errors).length) return requestFormFailure(req, res, errors);

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
      const version = parseInt(req.body.version, 10);
      if (!Number.isInteger(version)) return badRequest(req, res, 'Refresh the page before updating this request.');
      if (version !== Number(request.version)) {
        return res.status(409).render('error', { user: req.user, ws: req.workspace, message: 'This request changed in another session. Refresh it before applying your decision.' });
      }
      const target = String(req.body.status || '');
      const allowed = managing ? MANAGER_TRANSITIONS[request.status] : RESPONDER_TRANSITIONS[request.status];
      if (!allowed || !allowed.has(target)) return badRequest(req, res, `This request cannot move from ${clientStatus(request.status)} to ${target ? clientStatus(target) : 'that status'}.`);
      const note = clean(req.body.response_note, MAX_NOTE);
      if (note === null) return badRequest(req, res, `Response notes must be under ${MAX_NOTE} characters.`);
      if (target === 'changes_requested' && !note) return badRequest(req, res, 'Explain the changes required before sending the request back.');
      const evidenceRequired = !!request.workpaper_id || ['evidence','control'].includes(request.request_type);
      if (target === 'submitted' && evidenceRequired && Number(request.evidence_count || 0) === 0) {
        return badRequest(req, res, 'Attach at least one supporting file before submitting this request for review.');
      }
      const evidenceQuality = String(req.body.evidence_quality || request.evidence_quality || 'not_reviewed');
      if (!['not_reviewed','insufficient','partially_sufficient','sufficient'].includes(evidenceQuality)) {
        return badRequest(req, res, 'Choose a valid evidence-quality conclusion.');
      }
      if (managing && target === 'accepted' && request.workpaper_id && evidenceQuality !== 'sufficient') {
        return badRequest(req, res, 'Structured workpaper requests can only be accepted when the submitted evidence is concluded sufficient. Request changes when evidence remains incomplete.');
      }
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
      if (request.engagement_id) {
        reconcileDeliveryCompletion(req, {
          reason: `A linked client RFI moved from ${request.status} to ${target}.`,
          details: { request_id: request.id, engagement_id: request.engagement_id }
        });
      }
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
      if (!allowFirmPermission(req, res, 'evidence.download')) return;
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
      if (!allowFirmPermission(req, res, 'document.view')) return;
      const documentId = parseInt(req.params.id, 10);
      const raw = loadVisiblePolicy(req, documentId);
      if (!raw) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Policy not found.' });
      const doc = { ...raw, content: documentHtml.sanitizeDocumentHtml(enc.decryptIfNeeded(raw.content, req.workspace.id)) };
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
      if (!allowFirmPermission(req, res, 'document.view')) return;
      const documentId = parseInt(req.params.id, 10);
      if (!loadVisiblePolicy(req, documentId)) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Policy not found or not assigned to you.' });
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
