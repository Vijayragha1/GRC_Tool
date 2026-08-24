'use strict';

// Firm-side service-relationship and concentration surfaces for the standalone
// TPRM module. Provider legal identity is deliberately separate from each
// service relationship: a matching provider name is never an identity key.

const crypto = require('crypto');
const rbac = require('../lib/rbac');
const relationships = require('../lib/tprm-relationships');
const serviceCapabilities = require('../lib/tprm-capabilities');
const { withToast, auditCtx } = require('../lib/http-helpers');

const RELATIONSHIP_TRANSITIONS = Object.freeze({
  intake: ['active', 'rejected', 'offboarding'],
  active: ['suspended', 'offboarding'],
  suspended: ['active', 'offboarding'],
  offboarding: ['active', 'terminated'],
  rejected: ['intake'],
  terminated: [],
});

const DEPENDENCY_TRANSITIONS = Object.freeze({
  disclosed: ['under_review', 'approved', 'rejected', 'ended'],
  under_review: ['approved', 'rejected', 'ended'],
  approved: ['ended'],
  rejected: ['under_review'],
  ended: [],
});

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function titleCase(value, fallback = 'Not recorded') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function nonce() {
  return crypto.randomBytes(24).toString('hex');
}

function currencyExponent(currency) {
  const code = String(currency || '').trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

function moneyToMinor(value, currency) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const code = String(currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new relationships.TprmRelationshipError('TPRM_RELATIONSHIP_VALIDATION', 'Choose a three-letter currency before entering annual spend.', 400);
  }
  const exponent = currencyExponent(code);
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2] || '').length > exponent) {
    throw new relationships.TprmRelationshipError(
      'TPRM_RELATIONSHIP_VALIDATION',
      `Annual spend must be a positive amount with no more than ${exponent} decimal place${exponent === 1 ? '' : 's'} for ${code}.`,
      400
    );
  }
  const whole = BigInt(match[1]);
  const fractional = String(match[2] || '').padEnd(exponent, '0');
  const minor = whole * (10n ** BigInt(exponent)) + BigInt(fractional || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new relationships.TprmRelationshipError('TPRM_RELATIONSHIP_VALIDATION', 'Annual spend is too large to record safely.', 400);
  }
  return Number(minor);
}

function formatMoney(minor, currency) {
  if (minor == null || !currency) return 'Not recorded';
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat('en', {
    style: 'currency', currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent,
  }).format(Number(minor) / (10 ** exponent));
}

function minorToMajor(minor, currency) {
  if (minor == null || !currency) return '';
  const exponent = currencyExponent(currency);
  const negative = Number(minor) < 0;
  const digits = String(Math.abs(Number(minor))).padStart(exponent + 1, '0');
  if (!exponent) return `${negative ? '-' : ''}${digits}`;
  return `${negative ? '-' : ''}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

function bool(value) {
  return value === '1' || value === 'true' || value === 'on' || value === true;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;

  function moduleBoundary(req, res, next) {
    const module = db.prepare(`SELECT * FROM tprm_modules
      WHERE workspace_id=? ORDER BY id DESC LIMIT 1`).get(req.workspace.id);
    if (!module) {
      return res.status(409).render('error', {
        user: req.user,
        ws: req.workspace,
        message: 'Activate Third-party risk for this client before opening or changing service relationships.',
      });
    }
    if (req.method !== 'GET' && module.status !== 'active') {
      return res.status(409).render('error', {
        user: req.user,
        ws: req.workspace,
        message: module.status === 'closed'
          ? 'This Third-party risk service period is closed. Its retained relationship history is read-only; start a new governed service period before making changes.'
          : 'Classify the historic Third-party risk service model before changing service relationships.',
      });
    }
    res.locals.tprmModule = module;
    res.locals.tprmPolicy = serviceCapabilities.policyForModule(module);
    res.locals.tprmReadOnly = module.status !== 'active';
    res.locals.tprmReadOnlyReason = module.status === 'closed'
      ? 'This service period is closed. Retained records are read-only.'
      : 'This historic service period must be classified before records can be changed.';
    next();
  }

  function firmOnly(req, res, next) {
    if (req.user?.user_type !== 'firm') {
      return res.status(403).render('error', {
        user: req.user,
        ws: req.workspace,
        message: 'Service relationship work is available to the consulting team. Client users use the client portal.',
      });
    }
    next();
  }

  // This new module deliberately requires its granular permission even while
  // legacy supplier.* aliases remain elsewhere for cutover compatibility. An
  // explicit TPRM override must not be re-granted indirectly by an old alias.
  function exactPermission(permission) {
    return (req, res, next) => {
      const perms = req.userPerms || rbac.rolePermissions(req.workspace?._userRole || req.user.firm_role);
      const allowed = perms === '*' || (typeof perms.has === 'function'
        ? (perms.has('*') || perms.has(permission))
        : (Array.isArray(perms) && (perms.includes('*') || perms.includes(permission))));
      if (!allowed) {
        return res.status(403).render('error', {
          user: req.user,
          ws: req.workspace,
          message: `You don't have permission to do this (missing: ${permission}).`,
        });
      }
      next();
    };
  }

  const view = [requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.third_party.view'), exactPermission('tprm.third_party.view'), moduleBoundary];
  const manage = [requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.third_party.manage'), exactPermission('tprm.third_party.manage'), moduleBoundary,
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER)];
  const monitor = [requireAuth, requireWorkspace, firmOnly, requirePermission('tprm.monitoring.manage'), exactPermission('tprm.monitoring.manage'), moduleBoundary,
    serviceCapabilities.requireCapability(db, serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE)];

  function permissions(req) {
    return req.userPerms || rbac.rolePermissions(req.workspace?._userRole || req.user.firm_role);
  }

  function locals(req, active) {
    const perms = permissions(req);
    const hasExact = permission => perms === '*' || (typeof perms.has === 'function'
      ? (perms.has('*') || perms.has(permission))
      : (Array.isArray(perms) && (perms.includes('*') || perms.includes(permission))));
    const moduleReadOnly = resModuleReadOnly(req);
    const tprmPolicy = serviceCapabilities.policyForModule(resModule(req));
    return {
      user: req.user,
      ws: req.workspace,
      active,
      canSettings: !moduleReadOnly && req.user.user_type === 'firm' && rbac.isManager(req.user.firm_role),
      canManage: !moduleReadOnly && hasExact('tprm.third_party.manage')
        && tprmPolicy.capabilities[serviceCapabilities.CAPABILITIES.INVENTORY_REGISTER].allowed,
      canMonitor: !moduleReadOnly && hasExact('tprm.monitoring.manage')
        && tprmPolicy.capabilities[serviceCapabilities.CAPABILITIES.OPERATIONAL_LIFECYCLE].allowed,
      tprmReadOnly: moduleReadOnly,
      tprmReadOnlyReason: moduleReadOnly
        ? (resModule(req).status === 'closed'
          ? 'This service period is closed. Retained records are read-only.'
          : 'This historic service period must be classified before records can be changed.')
        : null,
      tprmPolicy,
      tprmCapabilities: serviceCapabilities.CAPABILITIES,
      titleCase,
      dateOnly,
      formatMoney,
      minorToMajor,
    };
  }

  function resModule(req) {
    return db.prepare(`SELECT * FROM tprm_modules WHERE workspace_id=? ORDER BY id DESC LIMIT 1`).get(req.workspace.id);
  }

  function resModuleReadOnly(req) {
    const module = resModule(req);
    return !module || module.status !== 'active';
  }

  function scopedRelationship(workspaceId, relationshipId) {
    return db.prepare(`SELECT r.*,le.legal_name,le.registration_number,le.registration_country_code,
        s.name AS provider_record_name
      FROM tprm_service_relationships r
      JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
      JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
      WHERE r.workspace_id=? AND r.id=?`).get(workspaceId, relationshipId) || null;
  }

  function listRows(workspaceId) {
    return db.prepare(`SELECT r.*,le.legal_name,le.registration_number,le.registration_country_code,
        s.name AS provider_record_name,
        (SELECT COUNT(*) FROM tprm_relationship_contracts c
          WHERE c.workspace_id=r.workspace_id AND c.relationship_id=r.id
            AND NOT EXISTS (SELECT 1 FROM tprm_relationship_contracts n WHERE n.supersedes_id=c.id)) AS current_contract_count,
        (SELECT COUNT(*) FROM tprm_dependency_edges e
          WHERE e.workspace_id=r.workspace_id AND e.source_relationship_id=r.id
            AND e.status NOT IN ('rejected','ended')) AS active_dependency_count,
        (SELECT COUNT(*) FROM tprm_relationship_locations l
          WHERE l.workspace_id=r.workspace_id AND l.relationship_id=r.id AND l.status!='exited'
            AND NOT EXISTS (SELECT 1 FROM tprm_relationship_locations n WHERE n.supersedes_id=l.id)) AS current_location_count,
        (SELECT COUNT(*) FROM tprm_relationship_business_dependencies d
          WHERE d.workspace_id=r.workspace_id AND d.relationship_id=r.id AND d.status='active') AS business_service_count
      FROM tprm_service_relationships r
      JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
      JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
      WHERE r.workspace_id=?
      ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'intake' THEN 1 WHEN 'suspended' THEN 2 WHEN 'offboarding' THEN 3 ELSE 4 END,
        CASE r.criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        le.legal_name,r.relationship_name`).all(workspaceId);
  }

  function primaryAction(row) {
    const base = `/workspaces/${row.workspace_id}/tprm/relationships/${row.id}`;
    if (row.status === 'terminated') return { label: 'View retained history', href: `${base}#history`, owner: 'No action' };
    if (row.status === 'rejected') return { label: 'Review rejected intake', href: `${base}#service-status`, owner: 'Consultancy' };
    if (row.status === 'intake') return { label: 'Complete service intake', href: `${base}#relationship-editor`, owner: 'Consultancy' };
    if (row.criticality === 'unknown') return { label: 'Classify service criticality', href: `${base}#relationship-editor`, owner: 'Consultancy' };
    if (!row.business_owner || !row.relationship_owner) return { label: 'Assign accountable owners', href: `${base}#relationship-editor`, owner: 'Consultancy' };
    if (!row.current_location_count && row.data_access !== 'none') return { label: 'Record delivery and data locations', href: `${base}#locations`, owner: 'Consultancy' };
    if (!row.business_service_count) return { label: 'Map affected business service', href: `${base}#business-services`, owner: 'Consultancy' };
    if (!row.current_contract_count) return { label: 'Record contract baseline', href: `${base}#contracts`, owner: 'Consultancy' };
    if (['critical', 'high'].includes(row.criticality) && !['documented', 'tested'].includes(row.exit_plan_status)) {
      return { label: 'Document the exit plan', href: `${base}#exit-readiness`, owner: 'Continuity owner' };
    }
    if (row.active_dependency_count) return { label: 'Review dependency chain', href: `${base}#dependencies`, owner: 'Security reviewer' };
    return { label: 'Review service record', href: base, owner: row.relationship_owner || 'Consultancy' };
  }

  function renderDomainError(req, res, error) {
    if (error instanceof relationships.TprmRelationshipError) {
      return res.status(error.status || 409).render('error', { user: req.user, ws: req.workspace, message: error.message });
    }
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).render('error', {
        user: req.user,
        ws: req.workspace,
        message: 'That governed record conflicts with a newer or existing entry. Refresh the page and use the current identity or version.',
      });
    }
    throw error;
  }

  function audit(req, action, entityType, entityId, details) {
    if (typeof logAction === 'function') {
      logAction(req.user.id, req.workspace.id, action, entityType, entityId, details || {}, auditCtx(req));
    }
  }

  app.get('/workspaces/:wsId/tprm/relationships', ...view, (req, res) => {
    const filters = {
      q: String(req.query.q || '').trim().toLowerCase(),
      status: String(req.query.status || 'open'),
      criticality: String(req.query.criticality || ''),
    };
    let rows = listRows(req.workspace.id);
    if (filters.status === 'open') rows = rows.filter(row => !['terminated', 'rejected'].includes(row.status));
    else if (filters.status !== 'all') rows = rows.filter(row => row.status === filters.status);
    if (filters.criticality) rows = rows.filter(row => row.criticality === filters.criticality);
    if (filters.q) rows = rows.filter(row => [row.legal_name, row.provider_record_name, row.relationship_name, row.service_category, row.relationship_owner, row.business_owner]
      .some(value => String(value || '').toLowerCase().includes(filters.q)));
    rows = rows.map(row => ({ ...row, nextAction: primaryAction(row) }));
    const providers = db.prepare(`SELECT s.id,s.name AS provider_record_name,s.archived_at,
        le.legal_name,le.registration_number,le.registration_country_code,
        COUNT(r.id) AS relationship_count
      FROM suppliers s
      LEFT JOIN tprm_legal_entities le ON le.workspace_id=s.workspace_id AND le.supplier_id=s.id
      LEFT JOIN tprm_service_relationships r ON r.workspace_id=s.workspace_id AND r.supplier_id=s.id
      WHERE s.workspace_id=? AND s.archived_at IS NULL
      GROUP BY s.id,s.name,le.legal_name,le.registration_number,le.registration_country_code
      ORDER BY COALESCE(le.legal_name,s.name),s.id`).all(req.workspace.id);
    const summary = {
      total: rows.length,
      highCritical: rows.filter(row => ['high', 'critical'].includes(row.criticality)).length,
      soleSource: rows.filter(row => row.sole_source === 1).length,
      incomplete: rows.filter(row => ['unknown'].includes(row.criticality) || !row.business_owner || !row.relationship_owner).length,
    };
    res.render('tprm_relationships', {
      ...locals(req, 'tprm-relationships'), rows, providers, filters, summary, createNonce: nonce(),
      provisionModels: relationships.PROVISION_MODELS,
      criticalities: relationships.CRITICALITIES,
      dataAccessLevels: relationships.DATA_ACCESS_LEVELS,
      substitutabilityOptions: relationships.SUBSTITUTABILITY,
    });
  });

  app.get('/workspaces/:wsId/tprm/relationships/:relationshipId', ...view, (req, res) => {
    try {
      const relationship = scopedRelationship(req.workspace.id, Number(req.params.relationshipId));
      if (!relationship) {
        return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Service relationship not found for this client.' });
      }
      const bundle = relationships.relationshipBundle(db, req.workspace.id, relationship.id);
      const relationshipSummary = listRows(req.workspace.id).find(row => row.id === relationship.id) || relationship;
      bundle.relationship = { ...bundle.relationship, ...relationshipSummary, nextAction: primaryAction(relationshipSummary) };
      bundle.dependencies = bundle.dependencies.map(edge => ({
        ...edge,
        countries: parseJsonArray(edge.countries_json),
        allowedTransitions: DEPENDENCY_TRANSITIONS[edge.status] || [],
      }));
      bundle.locations = bundle.locations.map(location => ({ ...location, dataCategories: parseJsonArray(location.data_categories_json) }));
      const currentContracts = bundle.contracts.filter(contract => contract.is_current === 1);
      const currentLocations = bundle.locations.filter(location => location.is_current === 1);
      const otherRelationships = listRows(req.workspace.id).filter(row => row.id !== relationship.id && !['terminated', 'rejected'].includes(row.status));
      const dependencyEntities = db.prepare(`SELECT de.*,
          (SELECT COUNT(*) FROM tprm_dependency_edges e WHERE e.workspace_id=de.workspace_id
            AND e.dependency_entity_id=de.id AND e.status NOT IN ('rejected','ended')) AS active_edge_count
        FROM tprm_dependency_entities de WHERE de.workspace_id=? ORDER BY de.name,de.id`).all(req.workspace.id);
      const businessServices = db.prepare(`SELECT * FROM tprm_business_services
        WHERE workspace_id=? AND status='active' ORDER BY name`).all(req.workspace.id);
      const chain = relationships.criticalChainProjection(db, { workspaceId: req.workspace.id, relationshipId: relationship.id });
      const activationAuthority = relationships.relationshipActivationAuthority(db, {
        workspaceId: req.workspace.id,
        relationshipId: relationship.id,
      });
      const permittedTransitions = (RELATIONSHIP_TRANSITIONS[relationship.status] || [])
        .filter(status => status !== 'active' || activationAuthority.allowed);
      res.render('tprm_relationship_detail', {
        ...locals(req, 'tprm-relationships'), bundle, relationship: bundle.relationship,
        currentContracts, currentLocations, otherRelationships, dependencyEntities, businessServices, chain,
        allowedRelationshipTransitions: permittedTransitions,
        activationBlocker: (RELATIONSHIP_TRANSITIONS[relationship.status] || []).includes('active') && !activationAuthority.allowed
          ? activationAuthority.message : null,
        relationshipNonce: nonce(), statusNonce: nonce(), contractNonce: nonce(), locationNonce: nonce(),
        dependencyNonce: nonce(), businessDependencyNonce: nonce(),
        provisionModels: relationships.PROVISION_MODELS,
        criticalities: relationships.CRITICALITIES,
        dataAccessLevels: relationships.DATA_ACCESS_LEVELS,
        substitutabilityOptions: relationships.SUBSTITUTABILITY,
        contractTypes: relationships.CONTRACT_TYPES,
        contractStatuses: relationships.CONTRACT_STATUSES,
        dependencyTypes: relationships.DEPENDENCY_TYPES,
        locationTypes: relationships.LOCATION_TYPES,
      });
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.get('/workspaces/:wsId/tprm/concentration', ...view, (req, res) => {
    try {
      const includeConcluded = req.query.include === 'concluded';
      const projection = relationships.concentrationProjection(db, req.workspace.id, {
        includeConcluded,
      });
      const exit = relationships.exitReadinessProjection(db, { workspaceId: req.workspace.id });
      const rows = listRows(req.workspace.id);
      const byId = new Map(rows.map(row => [row.id, row]));
      const relationshipStatusClause = includeConcluded ? '' : " AND r.status NOT IN ('terminated','rejected')";
      const exact = {
        providers: projection.providers.map(item => ({ ...item, relationships: item.relationshipIds.map(id => byId.get(id)).filter(Boolean) })),
        countries: projection.countries.map(item => ({
          ...item,
          relationships: db.prepare(`SELECT DISTINCT r.id,r.relationship_name,le.legal_name
            FROM tprm_relationship_locations l
            JOIN tprm_service_relationships r ON r.workspace_id=l.workspace_id AND r.id=l.relationship_id
            JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
            WHERE l.workspace_id=? AND l.country_code=? AND l.status!='exited'
              AND NOT EXISTS (SELECT 1 FROM tprm_relationship_locations n WHERE n.supersedes_id=l.id)
              ${relationshipStatusClause}
            ORDER BY le.legal_name,r.relationship_name`).all(req.workspace.id, item.countryCode),
        })),
        fourthParties: projection.fourthParties.map(item => {
          const exactRelationships = db.prepare(`SELECT DISTINCT r.id,r.relationship_name,le.legal_name,e.criticality,e.dependency_type,e.single_point_of_failure
            FROM tprm_dependency_edges e
            JOIN tprm_service_relationships r ON r.workspace_id=e.workspace_id AND r.id=e.source_relationship_id
            JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
            WHERE e.workspace_id=? AND e.dependency_entity_id=? AND e.status NOT IN ('rejected','ended')
              ${relationshipStatusClause}
            ORDER BY le.legal_name,r.relationship_name`).all(req.workspace.id, item.dependency_entity_id);
          return {
            ...item,
            relationship_count: exactRelationships.length,
            high_critical_edge_count: exactRelationships.filter(row => ['high', 'critical'].includes(row.criticality)).length,
            single_point_of_failure: exactRelationships.some(row => row.single_point_of_failure) ? 1 : 0,
            relationshipSharePercent: projection.totals.relationships
              ? Number((exactRelationships.length * 100 / projection.totals.relationships).toFixed(2)) : null,
            relationships: exactRelationships,
          };
        }).filter(item => includeConcluded || item.relationship_count > 0),
        businessServices: projection.businessServices.map(item => {
          const exactRelationships = db.prepare(`SELECT r.id,r.relationship_name,le.legal_name,d.dependency_type,d.criticality
            FROM tprm_relationship_business_dependencies d
            JOIN tprm_service_relationships r ON r.workspace_id=d.workspace_id AND r.id=d.relationship_id
            JOIN tprm_legal_entities le ON le.workspace_id=r.workspace_id AND le.id=r.legal_entity_id
            WHERE d.workspace_id=? AND d.business_service_id=? AND d.status='active'
              ${relationshipStatusClause}
            ORDER BY le.legal_name,r.relationship_name`).all(req.workspace.id, item.business_service_id);
          return {
            ...item,
            provider_relationship_count: exactRelationships.length,
            singleProviderDependency: exactRelationships.length === 1,
            noMappedProvider: exactRelationships.length === 0,
            relationships: exactRelationships,
          };
        }),
        categories: projection.serviceCategories.map(item => ({
          ...item,
          relationships: rows.filter(row => (includeConcluded || !['terminated', 'rejected'].includes(row.status))
            && (row.service_category || 'Unclassified') === item.serviceCategory),
        })),
      };
      const concentrationFlags = {
        providersWithMultipleServices: exact.providers.filter(item => item.relationships.length > 1),
        fourthPartiesSharedAcrossServices: exact.fourthParties.filter(item => item.relationship_count > 1),
        businessServicesWithSingleProvider: exact.businessServices.filter(item => item.singleProviderDependency),
        relationshipSinglePointsOfFailure: rows
          .filter(row => (includeConcluded || !['terminated', 'rejected'].includes(row.status))
            && (row.sole_source === 1 || row.substitutability === 'not_substitutable'))
          .map(row => ({ relationshipId: row.id, relationshipName: row.relationship_name, criticality: row.criticality })),
      };
      res.render('tprm_concentration', {
        ...locals(req, 'tprm-concentration'), projection, exit, exact, concentrationFlags,
        businessServiceNonce: nonce(), includeConcluded,
      });
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships', ...manage, (req, res) => {
    try {
      const supplierId = Number(req.body.supplier_id);
      const existingCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM tprm_service_relationships
        WHERE workspace_id=? AND supplier_id=?`).get(req.workspace.id, supplierId)?.count || 0);
      const result = relationships.createRelationship(db, {
        workspaceId: req.workspace.id,
        supplierId,
        actorId: req.user.id,
        relationshipName: req.body.relationship_name,
        legalName: req.body.legal_name,
        registrationNumber: req.body.registration_number,
        registrationCountryCode: req.body.registration_country_code,
        serviceCategory: req.body.service_category,
        serviceDescription: req.body.service_description,
        provisionModel: req.body.provision_model,
        status: 'intake',
        criticality: req.body.criticality,
        dataAccess: req.body.data_access,
        privilegedAccess: bool(req.body.privileged_access),
        annualSpendMinor: moneyToMinor(req.body.annual_spend, req.body.currency),
        currency: req.body.currency,
        relationshipOwner: req.body.relationship_owner,
        businessOwner: req.body.business_owner,
        securityOwner: req.body.security_owner,
        procurementOwner: req.body.procurement_owner,
        substitutability: req.body.substitutability,
        soleSource: bool(req.body.sole_source),
        materialOutsourcing: bool(req.body.material_outsourcing),
        regulatedService: bool(req.body.regulated_service),
        isPrimary: existingCount === 0,
        reason: req.body.reason,
        idempotencyKey: req.body.idempotency_key,
      });
      audit(req, 'tprm_service_relationship_created', 'tprm_service_relationship', result.relationship.id, {
        supplierId, legalEntityId: result.legalEntity.id, status: result.relationship.status,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${result.relationship.id}`,
        'Service relationship created in intake. Complete the record before activating it.',
        'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/update', ...manage, (req, res) => {
    try {
      const result = relationships.updateRelationship(db, {
        workspaceId: req.workspace.id,
        relationshipId: req.params.relationshipId,
        actorId: req.user.id,
        expectedRowVersion: req.body.expected_row_version,
        patch: {
          relationshipName: req.body.relationship_name,
          serviceCategory: req.body.service_category,
          serviceDescription: req.body.service_description,
          provisionModel: req.body.provision_model,
          criticality: req.body.criticality,
          dataAccess: req.body.data_access,
          privilegedAccess: bool(req.body.privileged_access),
          annualSpendMinor: moneyToMinor(req.body.annual_spend, req.body.currency),
          currency: req.body.currency,
          relationshipOwner: req.body.relationship_owner,
          businessOwner: req.body.business_owner,
          securityOwner: req.body.security_owner,
          procurementOwner: req.body.procurement_owner,
          startDate: req.body.start_date,
          targetEndDate: req.body.target_end_date,
          rtoHours: req.body.rto_hours,
          rpoHours: req.body.rpo_hours,
          maxTolerableDisruptionHours: req.body.maximum_tolerable_disruption_hours,
          substitutability: req.body.substitutability,
          alternateProviderRelationshipId: req.body.alternate_provider_relationship_id,
          estimatedExitDays: req.body.estimated_exit_days,
          exitPlanStatus: req.body.exit_plan_status,
          lastExitTestedAt: req.body.last_exit_tested_at,
          exitOwner: req.body.exit_owner,
          exitStrategy: req.body.exit_strategy,
          transitionAssistance: req.body.transition_assistance,
          dataReturnDeletionRequirements: req.body.data_return_deletion_requirements,
          soleSource: bool(req.body.sole_source),
          materialOutsourcing: bool(req.body.material_outsourcing),
          regulatedService: bool(req.body.regulated_service),
        },
        reason: req.body.reason,
      });
      audit(req, 'tprm_service_relationship_updated', 'tprm_service_relationship', result.relationship.id, {
        rowVersion: result.relationship.row_version,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${result.relationship.id}#relationship-editor`,
        'Service relationship updated.', 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/status', ...monitor, (req, res) => {
    try {
      const current = scopedRelationship(req.workspace.id, Number(req.params.relationshipId));
      if (!current) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Service relationship not found for this client.' });
      const target = String(req.body.status || '');
      if (!(RELATIONSHIP_TRANSITIONS[current.status] || []).includes(target)) {
        throw new relationships.TprmRelationshipError('TPRM_RELATIONSHIP_TRANSITION_INVALID', `The service cannot move from ${titleCase(current.status)} to ${titleCase(target)}.`, 409);
      }
      const result = relationships.updateRelationship(db, {
        workspaceId: req.workspace.id,
        relationshipId: current.id,
        actorId: req.user.id,
        expectedRowVersion: req.body.expected_row_version,
        patch: { status: target },
        reason: req.body.reason,
      });
      audit(req, 'tprm_service_operating_status_changed', 'tprm_service_relationship', result.relationship.id, {
        from: current.status, to: result.relationship.status,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${result.relationship.id}#service-status`,
        `Service operating status changed to ${titleCase(result.relationship.status)}.`, 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/contracts', ...manage, (req, res) => {
    try {
      const result = relationships.addContractVersion(db, {
        workspaceId: req.workspace.id,
        relationshipId: req.params.relationshipId,
        actorId: req.user.id,
        contractFamilyKey: req.body.contract_family_key,
        contractType: req.body.contract_type,
        status: req.body.status,
        title: req.body.title,
        reference: req.body.reference,
        effectiveDate: req.body.effective_date,
        endDate: req.body.end_date,
        renewalDate: req.body.renewal_date,
        noticeDeadline: req.body.notice_deadline,
        autoRenew: bool(req.body.auto_renew),
        committedSpendMinor: moneyToMinor(req.body.committed_spend, req.body.currency),
        currency: req.body.currency,
        terminationRights: req.body.termination_rights,
        transitionAssistance: req.body.transition_assistance,
        dataReturnDeletionTerms: req.body.data_return_deletion_terms,
        auditRights: req.body.audit_rights,
        incidentNotificationHours: req.body.incident_notification_hours,
        subprocessorControls: req.body.subprocessor_controls,
        governingLawCountryCode: req.body.governing_law_country_code,
        documentSha256: req.body.document_sha256,
        expectedCurrentContractId: req.body.expected_current_contract_id,
        idempotencyKey: req.body.idempotency_key,
        reason: req.body.reason,
      });
      audit(req, 'tprm_contract_version_added', 'tprm_relationship_contract', result.contract.id, {
        relationshipId: Number(req.params.relationshipId), familyKey: result.contract.contract_family_key, version: result.contract.version,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${req.params.relationshipId}#contracts`,
        `Contract version ${result.contract.version} recorded. Earlier versions remain unchanged.`, 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/locations', ...manage, (req, res) => {
    try {
      const result = relationships.addLocationExposure(db, {
        workspaceId: req.workspace.id,
        relationshipId: req.params.relationshipId,
        actorId: req.user.id,
        locationKey: req.body.location_key,
        exposureType: req.body.exposure_type,
        countryCode: req.body.country_code,
        region: req.body.region,
        siteReference: req.body.site_reference,
        dataCategories: req.body.data_categories,
        transferMechanism: req.body.transfer_mechanism,
        criticality: req.body.criticality,
        status: req.body.status,
        effectiveFrom: req.body.effective_from,
        effectiveTo: req.body.effective_to,
        assertionSource: req.body.assertion_source,
        expectedCurrentLocationId: req.body.expected_current_location_id,
        reason: req.body.reason,
      });
      audit(req, 'tprm_location_version_added', 'tprm_relationship_location', result.location.id, {
        relationshipId: Number(req.params.relationshipId), locationKey: result.location.location_key, version: result.location.version,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${req.params.relationshipId}#locations`,
        `Location assertion version ${result.location.version} recorded.`, 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/dependencies', ...monitor, (req, res) => {
    try {
      const targetKind = String(req.body.target_kind || 'new_entity');
      const input = {
        workspaceId: req.workspace.id,
        sourceRelationshipId: req.params.relationshipId,
        actorId: req.user.id,
        dependencyType: req.body.dependency_type,
        serviceDescription: req.body.service_description,
        dataAccess: req.body.data_access,
        countries: req.body.countries,
        criticality: req.body.criticality,
        concentrationKey: req.body.concentration_key,
        singlePointOfFailure: bool(req.body.single_point_of_failure),
        substitutability: req.body.substitutability,
        dueDiligenceRequired: bool(req.body.due_diligence_required),
        evidenceSummary: req.body.evidence_summary,
        status: 'disclosed',
        reason: req.body.reason,
        idempotencyKey: req.body.idempotency_key,
      };
      if (targetKind === 'relationship') input.targetRelationshipId = req.body.target_relationship_id;
      else if (targetKind === 'existing_entity') input.dependencyEntityId = req.body.dependency_entity_id;
      else if (targetKind === 'new_entity') {
        input.dependencyEntity = {
          entityKey: req.body.dependency_entity_key,
          name: req.body.dependency_entity_name,
          entityType: req.body.dependency_entity_type,
          legalCountryCode: req.body.dependency_country_code,
          registrationNumber: req.body.dependency_registration_number,
          parentEntityName: req.body.dependency_parent_name,
          source: req.body.dependency_source,
        };
      } else {
        throw new relationships.TprmRelationshipError('TPRM_DEPENDENCY_TARGET_REQUIRED', 'Choose an existing service, an existing external identity, or a new external identity.', 400);
      }
      const result = relationships.addDependencyEdge(db, input);
      audit(req, 'tprm_dependency_disclosed', 'tprm_dependency_edge', result.edge.id, {
        relationshipId: Number(req.params.relationshipId), dependencyType: result.edge.dependency_type,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${req.params.relationshipId}#dependencies`,
        'Dependency disclosed. Review and approve or reject it before relying on the chain.', 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/dependencies/:edgeId/status', ...monitor, (req, res) => {
    try {
      const edge = db.prepare(`SELECT * FROM tprm_dependency_edges
        WHERE workspace_id=? AND source_relationship_id=? AND id=?`).get(
        req.workspace.id, Number(req.params.relationshipId), Number(req.params.edgeId)
      );
      if (!edge) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Dependency not found for this service relationship.' });
      const target = String(req.body.status || '');
      if (!(DEPENDENCY_TRANSITIONS[edge.status] || []).includes(target)) {
        throw new relationships.TprmRelationshipError('TPRM_DEPENDENCY_TRANSITION_INVALID', `The dependency cannot move from ${titleCase(edge.status)} to ${titleCase(target)}.`, 409);
      }
      const result = relationships.transitionDependencyEdge(db, {
        workspaceId: req.workspace.id,
        edgeId: edge.id,
        actorId: req.user.id,
        expectedRowVersion: req.body.expected_row_version,
        status: target,
        evidenceSummary: req.body.evidence_summary,
        reason: req.body.reason,
      });
      audit(req, 'tprm_dependency_status_changed', 'tprm_dependency_edge', result.edge.id, {
        relationshipId: Number(req.params.relationshipId), from: edge.status, to: result.edge.status,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${req.params.relationshipId}#dependencies`,
        `Dependency status changed to ${titleCase(result.edge.status)}.`, 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/business-services', ...manage, (req, res) => {
    try {
      const result = relationships.createBusinessService(db, {
        workspaceId: req.workspace.id,
        actorId: req.user.id,
        name: req.body.name,
        description: req.body.description,
        ownerName: req.body.owner_name,
        criticality: req.body.criticality,
        impactToleranceHours: req.body.impact_tolerance_hours,
        rtoHours: req.body.rto_hours,
        rpoHours: req.body.rpo_hours,
        regulatoryDesignations: req.body.regulatory_designations,
      });
      audit(req, 'tprm_business_service_created', 'tprm_business_service', result.businessService.id, {
        criticality: result.businessService.criticality,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/concentration#business-services`,
        'Business service created. Link its provider relationships to expose concentration risk.', 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/business-services', ...manage, (req, res) => {
    try {
      const result = relationships.linkBusinessService(db, {
        workspaceId: req.workspace.id,
        relationshipId: req.params.relationshipId,
        actorId: req.user.id,
        businessServiceId: req.body.business_service_id,
        dependencyType: req.body.dependency_type,
        criticality: req.body.criticality,
        minimumCapacityPercent: req.body.minimum_capacity_percent,
        maximumOutageHours: req.body.maximum_outage_hours,
        manualWorkaround: req.body.manual_workaround,
        reason: req.body.reason,
      });
      audit(req, 'tprm_business_dependency_added', 'tprm_relationship_business_dependency', result.dependency.id, {
        relationshipId: Number(req.params.relationshipId), businessServiceId: result.businessService.id,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${req.params.relationshipId}#business-services`,
        `Mapped to ${result.businessService.name}.`, 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/relationships/:relationshipId/business-services/:dependencyId/end', ...monitor, (req, res) => {
    try {
      const dependency = db.prepare(`SELECT * FROM tprm_relationship_business_dependencies
        WHERE workspace_id=? AND relationship_id=? AND id=?`).get(
        req.workspace.id, Number(req.params.relationshipId), Number(req.params.dependencyId)
      );
      if (!dependency) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'Business-service dependency not found for this relationship.' });
      const result = relationships.endBusinessDependency(db, {
        workspaceId: req.workspace.id,
        dependencyId: dependency.id,
        actorId: req.user.id,
        expectedRowVersion: req.body.expected_row_version,
        reason: req.body.reason,
      });
      audit(req, 'tprm_business_dependency_ended', 'tprm_relationship_business_dependency', result.dependency.id, {
        relationshipId: Number(req.params.relationshipId), businessServiceId: result.dependency.business_service_id,
      });
      return res.redirect(303, withToast(
        `/workspaces/${req.workspace.id}/tprm/relationships/${req.params.relationshipId}#business-services`,
        'Business-service dependency ended; its history remains retained.', 'success'
      ));
    } catch (error) {
      return renderDomainError(req, res, error);
    }
  });
}

module.exports = {
  register,
  RELATIONSHIP_TRANSITIONS,
  DEPENDENCY_TRANSITIONS,
  currencyExponent,
  moneyToMinor,
  formatMoney,
  minorToMajor,
};
