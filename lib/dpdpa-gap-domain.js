'use strict';

const crypto = require('crypto');
const catalogSeed = require('./catalog-seed');

const ASSESSMENT_STATUSES = Object.freeze([
  'Draft', 'In Progress', 'Under Review', 'Approved', 'Superseded',
]);
const ITEM_STATUSES = Object.freeze([
  'Not Assessed', 'Implemented', 'Partially Implemented',
  'Not Implemented', 'Not Applicable',
]);
const LEGAL_EFFECTIVE_STATUSES = Object.freeze([
  'Effective', 'Future Effective', 'Effective Date Not Set',
]);
const APPLICABILITY_HINTS = Object.freeze([
  'In Scope', 'Potentially Out of Scope', 'Requires Review',
]);
const PROFILE_VERSION = 'DPDPA-APPLICABILITY-1.0';
const SNAPSHOT_VERSION = 'DPDPA-GAP-1.0';
const ORGANISATION_ROLES = Object.freeze([
  'Data Fiduciary', 'Data Processor', 'Consent Manager', 'Other / To be confirmed',
]);
const TRI_STATES = Object.freeze(['Yes', 'No', 'Unknown']);
const SDF_STATES = Object.freeze(['Designated', 'Not Designated', 'Unknown']);
const REQUIREMENT_TYPES = new Set(['clause', 'control', 'function', 'category', 'subcategory']);

class DpdpaGapDomainError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = 'DpdpaGapDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 409, details = null) {
  throw new DpdpaGapDomainError(code, message, status, details);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : stableStringify(value))
    .digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function optionalText(value) {
  const text = cleanText(value);
  return text || null;
}

function requiredText(value, field, minimum = 1) {
  const text = cleanText(value);
  if (text.length < minimum) {
    fail('DPDPA_VALIDATION', `${field} must contain at least ${minimum} characters.`, 400);
  }
  return text;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    fail('DPDPA_VALIDATION', `${field} is invalid.`, 400);
  }
  return id;
}

function optionalId(value, field) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  return positiveId(value, field);
}

function validIsoDate(value) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function isoDate(value, field, { optional = false } = {}) {
  const text = cleanText(value);
  if (!text && optional) return null;
  if (!validIsoDate(text)) fail('DPDPA_VALIDATION', `${field} must be a valid ISO date.`, 400);
  return text;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function inputValue(input, camel, snake = camel) {
  if (Object.prototype.hasOwnProperty.call(input || {}, camel)) return input[camel];
  return input ? input[snake] : undefined;
}

function normalizeEnum(value, allowed, fallback, field) {
  const text = cleanText(value) || fallback;
  if (!allowed.includes(text)) {
    fail('DPDPA_VALIDATION', `${field} is invalid.`, 400, { allowed });
  }
  return text;
}

function workspaceRow(db, workspaceId) {
  const id = positiveId(workspaceId, 'workspaceId');
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  if (!row) fail('DPDPA_NOT_FOUND', 'Client workspace not found.', 404);
  return row;
}

function workspaceActor(db, workspaceId, actorId, field = 'actorId') {
  const wsId = positiveId(workspaceId, 'workspaceId');
  const id = positiveId(actorId, field);
  const row = db.prepare(`SELECT u.*,wm.role AS workspace_role,w.firm_id AS workspace_firm_id
    FROM workspaces w
    JOIN users u ON u.id=? AND u.active=1
    LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=u.id
    WHERE w.id=?
      AND (u.user_type='firm' AND u.firm_id=w.firm_id
          AND (u.firm_role IN ('manager','firm_owner','owner','senior_consultant','lead_consultant')
            OR wm.id IS NOT NULL))`).get(id, wsId);
  if (!row) {
    fail('DPDPA_ACTOR_REQUIRED', 'An active firm user authorized for this workspace is required.', 403);
  }
  return row;
}

function workspaceOwner(db, workspaceId, ownerId) {
  const wsId = positiveId(workspaceId, 'workspaceId');
  const id = positiveId(ownerId, 'ownerId');
  const row = db.prepare(`SELECT u.*,wm.role AS workspace_role,w.firm_id AS workspace_firm_id
    FROM workspaces w
    JOIN users u ON u.id=? AND u.active=1
    LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=u.id
    WHERE w.id=? AND (
      (u.user_type='firm' AND u.firm_id=w.firm_id
        AND (u.firm_role IN ('manager','firm_owner','owner','senior_consultant','lead_consultant')
          OR wm.id IS NOT NULL))
      OR (u.user_type='client' AND wm.id IS NOT NULL)
    )`).get(id, wsId);
  if (!row) {
    fail('DPDPA_OWNER_INVALID', 'The accountable owner must be an active user assigned or authorized for this workspace.', 400);
  }
  return row;
}

function actorWithPermission(db, workspaceId, actorId, permission, field = 'actorId') {
  const actor = workspaceActor(db, workspaceId, actorId, field);
  const rbac = require('./rbac');
  const normalizedFirmRole = rbac.normalizeRole(actor.firm_role);
  if (actor.user_type === 'firm' && rbac.isManager(normalizedFirmRole)) return actor;
  let role;
  if (actor.user_type === 'firm') {
    const memberRole = rbac.normalizeRole(actor.workspace_role);
    role = rbac.FIRM_ROLES.includes(memberRole) ? memberRole : normalizedFirmRole;
  } else {
    role = rbac.normalizeRole(actor.workspace_role) || 'contributor';
  }
  const overrides = db.prepare(`SELECT permission,granted FROM workspace_role_overrides
    WHERE workspace_id=? AND user_id=?`).all(workspaceId, actor.id);
  const permissions = rbac.effectivePermissions(role, overrides);
  if (!rbac.hasPermission(permissions, permission)) {
    fail('DPDPA_PERMISSION_DENIED', `Missing required permission: ${permission}.`, 403, { permission });
  }
  return actor;
}

function normalizeApplicabilityProfile(value) {
  const input = value && typeof value === 'object' ? value : {};
  const rawRoles = input.organisation_roles || input.organisationRoles || [];
  const roles = [...new Set((Array.isArray(rawRoles) ? rawRoles : [rawRoles])
    .map(cleanText).filter(Boolean))];
  if (!roles.length || roles.some(role => !ORGANISATION_ROLES.includes(role))) {
    fail('DPDPA_VALIDATION', 'Select at least one valid organisation role.', 400, {
      allowed: ORGANISATION_ROLES,
    });
  }
  const tri = (snake, camel) => normalizeEnum(
    input[snake] == null ? input[camel] : input[snake], TRI_STATES, 'Unknown', snake
  );
  const sdf = normalizeEnum(
    input.sdf_designation_state == null ? input.sdfDesignationState : input.sdf_designation_state,
    SDF_STATES, 'Unknown', 'sdf_designation_state'
  );
  const exemptions = requiredText(
    input.exemptions_or_public_data_assumptions == null
      ? input.exemptionsOrPublicDataAssumptions
      : input.exemptions_or_public_data_assumptions,
    'Exemptions/public-data assumptions', 20
  );
  const limitations = requiredText(
    input.scope_limitations == null ? input.scopeLimitations : input.scope_limitations,
    'Scope limitations', 20
  );
  return Object.freeze({
    version: PROFILE_VERSION,
    organisation_roles: roles.sort(),
    digital_personal_data_in_scope: tri('digital_personal_data_in_scope', 'digitalPersonalDataInScope'),
    children_or_guardian_processing: tri('children_or_guardian_processing', 'childrenOrGuardianProcessing'),
    sdf_designation_state: sdf,
    statutory_consent_manager_activity: tri('statutory_consent_manager_activity', 'statutoryConsentManagerActivity'),
    cross_border_processing_or_transfers: tri('cross_border_processing_or_transfers', 'crossBorderProcessingOrTransfers'),
    exemptions_or_public_data_assumptions: exemptions,
    legacy_consent_cohort: tri('legacy_consent_cohort', 'legacyConsentCohort'),
    scope_limitations: limitations,
  });
}

function loadDefaultCatalog() {
  try {
    // Loaded lazily so isolated schema/domain tests can inject a small catalog.
    return require('../data/dpdpa-catalog');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND'
      && String(error.message || '').includes('dpdpa-catalog')) {
      fail('DPDPA_CATALOG_EMPTY', 'The governed DPDPA catalog is not installed.', 409);
    }
    throw error;
  }
}

function normalizeGuidance(value) {
  const parsed = parseJson(value, value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? stableValue(parsed) : {};
}

function normalizeSourceSectionRule(requirement, guidance) {
  const combined = requirement.sourceSectionRule || requirement.source_section_rule
    || guidance.sourceSectionRule || guidance.source_section_rule;
  const sourceSection = optionalText(requirement.sourceSection || requirement.source_section
    || guidance.sourceSection || guidance.source_section
    || (combined && typeof combined === 'object' ? combined.section : null)
    || (typeof combined === 'string' ? combined : null));
  const sourceRule = optionalText(requirement.sourceRule || requirement.source_rule
    || guidance.sourceRule || guidance.source_rule
    || (combined && typeof combined === 'object' ? combined.rule : null));
  return { sourceSection, sourceRule };
}

function normalizeCatalog(rawCatalog) {
  const raw = rawCatalog || loadDefaultCatalog();
  if (!raw || typeof raw !== 'object') {
    fail('DPDPA_CATALOG_EMPTY', 'The governed DPDPA catalog is unavailable.', 409);
  }
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : raw;
  const code = cleanText(metadata.code || raw.code || 'dpdpa').toLowerCase();
  if (code !== 'dpdpa') fail('DPDPA_CATALOG_INVALID', 'Catalog code must be dpdpa.', 409);
  const name = requiredText(metadata.name || raw.name || 'Digital Personal Data Protection Act, 2023', 'Catalog name');
  const version = requiredText(metadata.version || raw.version, 'Catalog version');
  const sourceReference = requiredText(
    metadata.sourceReference || metadata.source_reference || raw.sourceReference
      || raw.source_reference || 'Governed DPDPA catalog',
    'Catalog source reference'
  );
  const sourceRequirements = raw.requirements || raw.REQUIREMENTS || raw.items || raw.catalog || [];
  if (!Array.isArray(sourceRequirements) || !sourceRequirements.length) {
    fail('DPDPA_CATALOG_EMPTY', 'The governed DPDPA catalog has no assessment requirements.', 409);
  }
  const obligationsByRef = new Map((Array.isArray(raw.obligations) ? raw.obligations : [])
    .map(obligation => [obligation.ref, obligation]));
  const domainLabels = new Map((Array.isArray(raw.domains) ? raw.domains : [])
    .map(domain => [cleanText(domain.key || domain.id), cleanText(domain.label || domain.name)]));
  const refs = new Set();
  const requirements = sourceRequirements.map((source, index) => {
    const ref = requiredText(source.ref || source.id || source.code, `Requirement ${index + 1} reference`);
    if (refs.has(ref)) fail('DPDPA_CATALOG_INVALID', `Duplicate DPDPA requirement reference: ${ref}.`, 409);
    refs.add(ref);
    const obligation = obligationsByRef.get(ref) || {};
    const rawGuidance = normalizeGuidance(source.guidance);
    const guidance = stableValue({
      ...rawGuidance,
      implementationGuidance: typeof source.guidance === 'string' ? source.guidance
        : (obligation.implementationGuidance || rawGuidance.implementationGuidance || null),
      evidenceExpectations: obligation.evidenceExpectations || rawGuidance.evidenceExpectations || null,
      applicability: source.applicability || obligation.applicability || rawGuidance.applicability || null,
    });
    const reqType = cleanText(source.reqType || source.req_type || source.type || 'control').toLowerCase();
    if (!REQUIREMENT_TYPES.has(reqType)) {
      fail('DPDPA_CATALOG_INVALID', `Unsupported requirement type for ${ref}.`, 409);
    }
    const domainKey = requiredText(source.domain || guidance.domain || guidance.category || 'General', `${ref} domain`);
    const domain = domainLabels.get(domainKey) || domainKey;
    const effectiveDate = isoDate(
      source.effectiveDate || source.effective_date || guidance.effectiveDate || guidance.effective_date,
      `${ref} effective date`, { optional: true }
    );
    const { sourceSection, sourceRule } = normalizeSourceSectionRule(source, guidance);
    const normalizedGuidance = stableValue({
      ...guidance,
      domain,
      domainKey,
      effectiveDate,
      sourceSection,
      sourceRule,
      severity: source.severity || guidance.severity || null,
      weight: source.weight == null ? (guidance.weight == null ? null : guidance.weight) : source.weight,
      commencementPhase: source.commencementPhase || source.commencement_phase
        || guidance.commencementPhase || guidance.commencement_phase || null,
      applicability: source.applicability || obligation.applicability || guidance.applicability || null,
      appliesWhen: source.appliesWhen || source.applies_when
        || guidance.appliesWhen || guidance.applies_when || null,
    });
    return Object.freeze({
      ref,
      parent_ref: optionalText(source.parentRef || source.parent_ref),
      req_type: reqType,
      title: requiredText(source.title, `${ref} title`),
      summary: optionalText(source.summary || source.description),
      guidance: normalizedGuidance,
      sort_order: Number.isFinite(Number(source.sortOrder == null ? source.sort_order : source.sortOrder))
        ? Number(source.sortOrder == null ? source.sort_order : source.sortOrder)
        : index + 1,
      domain,
      effective_date: effectiveDate,
      source_section: sourceSection,
      source_rule: sourceRule,
    });
  }).sort((a, b) => a.sort_order - b.sort_order || a.ref.localeCompare(b.ref));

  const seedManifest = { code, name, version, source_reference: sourceReference, requirements: requirements.map(r => ({
    ref: r.ref,
    parent_ref: r.parent_ref,
    req_type: r.req_type,
    title: r.title,
    summary: r.summary,
    guidance: r.guidance,
    sort_order: r.sort_order,
  })) };
  const seedHash = sha256(seedManifest);
  const claimedHash = cleanText(metadata.contentHash || metadata.content_hash
    || raw.contentHash || raw.content_hash);
  let catalogHash = claimedHash || seedHash;

  if (typeof raw.validateCatalog === 'function') {
    let validation;
    try { validation = raw.validateCatalog(raw); } catch (error) {
      fail('DPDPA_CATALOG_HASH_MISMATCH', `DPDPA catalog validation failed: ${error.message}`, 409);
    }
    if (validation === false || (validation && validation.valid === false)) {
      fail('DPDPA_CATALOG_HASH_MISMATCH', 'The governed DPDPA catalog hash does not validate.', 409);
    }
    const computed = typeof raw.computeContentHash === 'function' ? cleanText(raw.computeContentHash(raw)) : '';
    if (claimedHash && computed && claimedHash !== computed) {
      fail('DPDPA_CATALOG_HASH_MISMATCH', 'The governed DPDPA catalog content hash differs from its declared hash.', 409);
    }
    if (computed) catalogHash = computed;
  } else if (claimedHash && claimedHash !== seedHash) {
    fail('DPDPA_CATALOG_HASH_MISMATCH', 'The supplied DPDPA catalog hash differs from its normalized content.', 409);
  }
  if (!/^[0-9a-f]{64}$/.test(catalogHash)) {
    fail('DPDPA_CATALOG_HASH_MISMATCH', 'The DPDPA catalog hash must be a lowercase SHA-256 value.', 409);
  }

  const catalogManifest = stableValue({
    metadata: raw.metadata || { code, name, version, sourceReference },
    sources: raw.sources || null,
    phases: raw.phases || null,
    domains: raw.domains || null,
    obligations: raw.obligations || null,
    requirements: seedManifest.requirements,
  });
  return Object.freeze({
    raw,
    code,
    name,
    version,
    sourceReference,
    catalogHash,
    seedHash,
    requirements,
    seedManifest,
    catalogManifest,
  });
}

// Seeding, drift refusal and the release lock now live in lib/catalog-seed.js
// so SOC 2 and anything after it ride the same path instead of copying it. The
// error codes and messages are passed through unchanged, because callers and
// routes/dpdpa.js map DPDPA_CATALOG_DRIFT to a 409.
//
// The module's own dpdpa_gap_catalog_versions lock is still written here:
// dpdpa_gap_assessments carries a foreign key into it, and approved client
// assessments reference those rows. The shared table is the registry of what
// is current; this one stays the module's own immutable history.
function ensureFrameworkSeeded(db, catalog = null) {
  const normalized = normalizeCatalog(catalog || undefined);
  return db.transaction(() => {
    const seeded = catalogSeed.seedFrameworkCatalog(db, normalized, {
      label: 'DPDPA',
      normalizeGuidance,
      onFail: fail,
      codes: { invalid: 'DPDPA_CATALOG_INVALID', drift: 'DPDPA_CATALOG_DRIFT' },
    });

    db.prepare(`INSERT OR IGNORE INTO dpdpa_gap_catalog_versions
      (framework_id,catalog_version,catalog_hash,requirement_count,source_reference,catalog_manifest_json)
      VALUES (?,?,?,?,?,?)`).run(
      seeded.framework.id, normalized.version, normalized.catalogHash, normalized.requirements.length,
      normalized.sourceReference, stableStringify(normalized.catalogManifest)
    );
    const lock = db.prepare(`SELECT * FROM dpdpa_gap_catalog_versions
      WHERE framework_id=? AND catalog_version=? AND catalog_hash=?`).get(
      seeded.framework.id, normalized.version, normalized.catalogHash
    );
    if (!lock || lock.requirement_count !== normalized.requirements.length
      || lock.source_reference !== normalized.sourceReference
      || stableStringify(parseJson(lock.catalog_manifest_json, {})) !== stableStringify(normalized.catalogManifest)) {
      fail('DPDPA_CATALOG_DRIFT', 'The registered DPDPA catalog lock differs from the supplied catalog.', 409);
    }
    return {
      framework: seeded.framework,
      catalog_version: normalized.version,
      catalog_hash: normalized.catalogHash,
      requirement_count: normalized.requirements.length,
      requirements: normalized.requirements,
      source_reference: normalized.sourceReference,
    };
  })();
}

function legalEffectiveStatus(effectiveDate, asOfDate) {
  if (!effectiveDate) return 'Effective Date Not Set';
  return effectiveDate <= asOfDate ? 'Effective' : 'Future Effective';
}

function profileValue(profile, key) {
  if (key === 'organisation_roles' || key === 'organisationRoles') return profile.organisation_roles;
  const snake = String(key).replace(/[A-Z]/g, match => `_${match.toLowerCase()}`);
  return profile[snake];
}

function evaluateCondition(condition, profile) {
  if (!condition || typeof condition !== 'object') return { matched: true, unknown: false };
  if (Array.isArray(condition)) {
    const results = condition.map(entry => evaluateCondition(entry, profile));
    return {
      matched: results.every(result => result.matched),
      unknown: results.some(result => result.unknown),
    };
  }
  if (condition.field) {
    const actual = profileValue(profile, condition.field);
    const expected = condition.in || condition.oneOf || condition.values
      || (condition.equals == null ? condition.value : condition.equals);
    const expectedValues = (Array.isArray(expected) ? expected : [expected]).map(cleanText);
    const actualValues = (Array.isArray(actual) ? actual : [actual]).map(cleanText);
    const unknown = actualValues.some(value => value === 'Unknown' || value === 'Other / To be confirmed');
    return { matched: actualValues.some(value => expectedValues.includes(value)), unknown };
  }
  const entries = Object.entries(condition).filter(([, value]) => value != null);
  const results = entries.map(([key, expected]) => {
    const actual = profileValue(profile, key);
    const expectedValues = (Array.isArray(expected) ? expected : [expected]).map(cleanText);
    const actualValues = (Array.isArray(actual) ? actual : [actual]).map(cleanText);
    return {
      matched: actualValues.some(value => expectedValues.includes(value)),
      unknown: actualValues.some(value => value === 'Unknown' || value === 'Other / To be confirmed'),
    };
  });
  return {
    matched: results.every(result => result.matched),
    unknown: results.some(result => result.unknown),
  };
}

function applicabilityHint(requirement, profile) {
  const guidance = requirement.guidance || {};
  const applicability = guidance.applicability;
  const flags = new Set(applicability && Array.isArray(applicability.flags) ? applicability.flags : []);
  const derivedConditions = [];
  if ([...flags].some(flag => ['child_data','child_wellbeing','lawful_guardian','person_with_disability',
    'under_eighteen','verifiable_guardian_consent','verifiable_parental_consent'].includes(flag))) {
    derivedConditions.push({ field: 'children_or_guardian_processing', equals: 'Yes' });
  }
  if (flags.has('significant_data_fiduciary')) {
    derivedConditions.push({ field: 'sdf_designation_state', equals: 'Designated' });
  }
  if (flags.has('statutory_consent_manager')) {
    derivedConditions.push({ field: 'statutory_consent_manager_activity', equals: 'Yes' });
  }
  if ([...flags].some(flag => ['cross_border_transfer','foreign_contract','specified_data_localisation'].includes(flag))) {
    derivedConditions.push({ field: 'cross_border_processing_or_transfers', equals: 'Yes' });
  }
  if (flags.has('legacy_consent')) {
    derivedConditions.push({ field: 'legacy_consent_cohort', equals: 'Yes' });
  }
  if (flags.has('data_fiduciary') && !flags.has('all_data_fiduciaries')) {
    derivedConditions.push({ field: 'organisation_roles', values: ['Data Fiduciary'] });
  }
  const condition = guidance.appliesWhen
    || (applicability && typeof applicability === 'object'
      ? (applicability.appliesWhen || applicability.applies_when || applicability.when)
      : null)
    || (derivedConditions.length ? derivedConditions : null);
  const reason = optionalText(
    guidance.applicabilityReason || guidance.applicability_reason
    || (applicability && typeof applicability === 'object'
      ? applicability.reason || applicability.note
      : null)
  );
  if (!condition) {
    if ([...flags].some(flag => ['scope_exclusion','personal_domestic_use','publicly_available_data',
      'statutory_exemption','conditional_exception'].includes(flag))) {
      return {
        hint: 'Requires Review',
        reason: reason || (applicability && applicability.condition)
          || 'A claimed statutory exclusion or exemption requires an evidence-based human determination.',
      };
    }
    return { hint: 'In Scope', reason: reason || 'No conditional applicability rule is declared in the pinned catalog.' };
  }
  const result = evaluateCondition(condition, profile);
  if (result.unknown) {
    return { hint: 'Requires Review', reason: reason || 'The applicability profile contains an unknown value for this conditional requirement.' };
  }
  if (!result.matched) {
    return {
      hint: 'Potentially Out of Scope',
      reason: reason || 'The pinned applicability condition is not currently met; a reviewer must document any Not Applicable decision.',
    };
  }
  return { hint: 'In Scope', reason: reason || 'The pinned applicability condition is met.' };
}

function resolveLogAction(db, input) {
  if (input && typeof input.logAction === 'function') return input.logAction;
  try {
    const core = require('../db');
    if (core.db === db && typeof core.logAction === 'function') return core.logAction;
  } catch (_) {}
  fail('DPDPA_AUDIT_REQUIRED', 'A strict audit writer is required for DPDPA mutations.', 500);
}

function writeAudit(db, input, action, entityType, entityId, details, before = null, after = null) {
  const logAction = resolveLogAction(db, input);
  const context = input && input.auditContext && typeof input.auditContext === 'object'
    ? input.auditContext : {};
  logAction(
    positiveId(input.actorId || input.createdBy || input.created_by, 'actorId'),
    positiveId(input.workspaceId || input.workspace_id, 'workspaceId'),
    action,
    entityType,
    entityId,
    details,
    { ...context, before, after, strict: true }
  );
}

function assessmentRow(db, workspaceId, assessmentId) {
  const wsId = positiveId(workspaceId, 'workspaceId');
  const id = positiveId(assessmentId, 'assessmentId');
  return db.prepare(`SELECT a.*,f.code AS framework_code,f.name AS framework_name,
      creator.name AS created_by_name,submitter.name AS submitted_by_name,
      approver.name AS approved_by_name
    FROM dpdpa_gap_assessments a
    JOIN frameworks f ON f.id=a.framework_id
    LEFT JOIN users creator ON creator.id=a.created_by
    LEFT JOIN users submitter ON submitter.id=a.submitted_by
    LEFT JOIN users approver ON approver.id=a.approved_by
    WHERE a.workspace_id=? AND a.id=?`).get(wsId, id) || null;
}

function requireAssessment(db, workspaceId, assessmentId) {
  const row = assessmentRow(db, workspaceId, assessmentId);
  if (!row) fail('DPDPA_NOT_FOUND', 'DPDPA gap assessment not found in this workspace.', 404);
  return row;
}

function baselineForNewAssessment(db, workspaceId) {
  return db.prepare(`SELECT a.id AS assessment_id,s.id AS snapshot_id
    FROM dpdpa_gap_assessments a
    JOIN dpdpa_gap_assessment_snapshots s
      ON s.workspace_id=a.workspace_id AND s.assessment_id=a.id
    WHERE a.workspace_id=? AND a.status='Approved'
    ORDER BY s.sequence_number DESC,s.id DESC LIMIT 1`).get(workspaceId) || null;
}

function createAssessment(db, input = {}) {
  const workspaceId = positiveId(input.workspaceId || input.workspace_id, 'workspaceId');
  workspaceRow(db, workspaceId);
  const createdBy = positiveId(input.createdBy || input.created_by, 'createdBy');
  actorWithPermission(db, workspaceId, createdBy, 'dpdpa.assess', 'createdBy');
  const title = requiredText(input.title, 'Assessment title', 5);
  const scopeStatement = requiredText(input.scopeStatement || input.scope_statement, 'Scope statement', 20);
  const asOfDate = isoDate(input.asOfDate || input.as_of_date || today(), 'As-of date');
  const profile = normalizeApplicabilityProfile(input.applicabilityProfile || input.applicability_profile);
  const profileJson = stableStringify(profile);
  const profileHash = sha256(profileJson);
  const catalog = ensureFrameworkSeeded(db, input.catalog || null);

  const create = db.transaction(() => {
    const baseline = baselineForNewAssessment(db, workspaceId);
    const result = db.prepare(`INSERT INTO dpdpa_gap_assessments
      (workspace_id,framework_id,title,scope_statement,as_of_date,status,
       catalog_version,catalog_hash,catalog_requirement_count,
       applicability_profile_version,applicability_profile_json,applicability_profile_hash,
       baseline_assessment_id,baseline_snapshot_id,created_by)
      VALUES (?,?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, catalog.framework.id, title, scopeStatement, asOfDate,
        catalog.catalog_version, catalog.catalog_hash, catalog.requirement_count,
        PROFILE_VERSION, profileJson, profileHash,
        baseline ? baseline.assessment_id : null, baseline ? baseline.snapshot_id : null,
        createdBy
      );
    const assessmentId = Number(result.lastInsertRowid);
    const requirementRows = db.prepare(`SELECT * FROM requirements
      WHERE framework_id=? ORDER BY sort_order,ref`).all(catalog.framework.id);
    const insertControl = db.prepare(`INSERT OR IGNORE INTO control_instances
      (workspace_id,requirement_id,entity_id,applicability,status,migrated_from)
      VALUES (?,?,NULL,'undecided','not_assessed','dpdpa_gap_assessment')`);
    const getControl = db.prepare(`SELECT * FROM control_instances
      WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`);
    const insertItem = db.prepare(`INSERT INTO dpdpa_gap_assessment_items
      (workspace_id,assessment_id,framework_id,requirement_id,control_instance_id,
       requirement_ref,requirement_title,requirement_description,requirement_domain,
       source_section,source_rule,effective_date,legal_effective_status,
       applicability_hint,applicability_reason,status,evidence_sufficient)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Not Assessed',1)`);
    for (const requirementRow of requirementRows) {
      insertControl.run(workspaceId, requirementRow.id);
      const control = getControl.get(workspaceId, requirementRow.id);
      if (!control) fail('DPDPA_CONFLICT', `Unable to create control instance for ${requirementRow.ref}.`, 409);
      const normalizedRequirement = catalog.requirements.find(row => row.ref === requirementRow.ref);
      if (!normalizedRequirement) {
        fail('DPDPA_CATALOG_DRIFT', `Pinned requirement ${requirementRow.ref} is absent from the governed catalog.`, 409);
      }
      const hint = applicabilityHint(normalizedRequirement, profile);
      insertItem.run(
        workspaceId, assessmentId, catalog.framework.id, requirementRow.id, control.id,
        requirementRow.ref, requirementRow.title, requirementRow.summary,
        normalizedRequirement.domain, normalizedRequirement.source_section,
        normalizedRequirement.source_rule, normalizedRequirement.effective_date,
        legalEffectiveStatus(normalizedRequirement.effective_date, asOfDate),
        hint.hint, hint.reason
      );
    }
    const created = assessmentRow(db, workspaceId, assessmentId);
    writeAudit(db, { ...input, actorId: createdBy, workspaceId },
      'dpdpa_gap_assessment.created', 'dpdpa_gap_assessment', assessmentId,
      {
        title,
        as_of_date: asOfDate,
        catalog_version: catalog.catalog_version,
        catalog_hash: catalog.catalog_hash,
        requirement_count: catalog.requirement_count,
        applicability_profile_hash: profileHash,
        baseline_assessment_id: baseline ? baseline.assessment_id : null,
      }, null, created);
    return assessmentId;
  });
  const assessmentId = create();
  return getAssessment(db, workspaceId, assessmentId);
}

function evidenceManifestForRequirement(db, workspaceId, requirementId, asOfDate) {
  const rows = db.prepare(`SELECT e.id,e.filename,e.sha256,e.size_bytes,e.description,e.uploaded_at,
      e.valid_from,e.valid_until,e.supersedes_id,e.superseded_at,e.tags,
      erl.relevance_note,erl.section_ref,erl.created_at AS linked_at
    FROM evidence_requirement_links erl
    JOIN evidence e ON e.id=erl.evidence_id
    WHERE e.workspace_id=? AND erl.requirement_id=?
    ORDER BY e.uploaded_at DESC,e.id DESC`).all(workspaceId, requirementId);
  return rows.map(row => {
    const uploadedDate = cleanText(row.uploaded_at).slice(0, 10);
    const staleReasons = [];
    if (row.superseded_at) staleReasons.push('superseded');
    if (uploadedDate && uploadedDate > asOfDate) staleReasons.push('uploaded_after_as_of_date');
    if (row.valid_from && row.valid_from > asOfDate) staleReasons.push('not_yet_valid');
    if (row.valid_until && row.valid_until < asOfDate) staleReasons.push('expired');
    return {
      ...row,
      current: staleReasons.length === 0,
      stale: staleReasons.length > 0,
      stale_reasons: staleReasons,
    };
  });
}

function findingManifestForItem(db, item) {
  const findings = db.prepare(`SELECT DISTINCT f.*
    FROM finding_controls fc
    JOIN findings f ON f.id=fc.finding_id
    WHERE f.workspace_id=? AND fc.instance_id=?
      AND (f.source_type!='assessment' OR f.source_id=?)
    ORDER BY f.id`).all(item.workspace_id, item.control_instance_id,
      `dpdpa:${item.assessment_id}:${item.id}`);
  const recommendationQuery = db.prepare(`SELECT * FROM recommendations
    WHERE workspace_id=? AND finding_id=? ORDER BY id`);
  const remediationQuery = db.prepare(`SELECT * FROM remediation_actions
    WHERE workspace_id=? AND finding_id=? ORDER BY id`);
  return findings.map(finding => ({
    ...finding,
    recommendations: recommendationQuery.all(item.workspace_id, finding.id),
    remediation_actions: remediationQuery.all(item.workspace_id, finding.id),
  }));
}

function itemProjection(db, assessment, row, { includeManifests = false } = {}) {
  const evidence = evidenceManifestForRequirement(
    db, assessment.workspace_id, row.requirement_id, assessment.as_of_date
  );
  const current = evidence.filter(entry => entry.current);
  const stale = evidence.filter(entry => entry.stale);
  const evidenceRequired = ['Implemented', 'Partially Implemented'].includes(row.status);
  const findings = findingManifestForItem(db, row);
  return {
    ...row,
    ref: row.requirement_ref,
    title: row.requirement_title,
    description: row.requirement_description,
    domain: row.requirement_domain,
    stored_evidence_sufficient: row.evidence_sufficient,
    evidence_required: evidenceRequired,
    evidence_sufficient: evidenceRequired ? current.length > 0 : true,
    evidence_total_count: evidence.length,
    evidence_current_count: current.length,
    evidence_stale_count: stale.length,
    finding_count: findings.length,
    ...(includeManifests ? { evidence, findings } : {}),
  };
}

function getAssessmentItemsInternal(db, assessment, options = {}, projectionOptions = {}) {
  const clauses = ['i.workspace_id=?', 'i.assessment_id=?'];
  const params = [assessment.workspace_id, assessment.id];
  const q = cleanText(options.q);
  const domain = cleanText(options.domain);
  const status = cleanText(options.status);
  if (q) {
    clauses.push(`(i.requirement_ref LIKE ? OR i.requirement_title LIKE ?
      OR COALESCE(i.requirement_description,'') LIKE ? OR COALESCE(i.assessment_note,'') LIKE ?)`);
    const term = `%${q}%`;
    params.push(term, term, term, term);
  }
  if (domain) {
    clauses.push('i.requirement_domain=?');
    params.push(domain);
  }
  if (status) {
    if (!ITEM_STATUSES.includes(status)) fail('DPDPA_VALIDATION', 'Item status filter is invalid.', 400);
    clauses.push('i.status=?');
    params.push(status);
  }
  const rows = db.prepare(`SELECT i.*,owner.name AS owner_name,assessor.name AS assessed_by_name
    FROM dpdpa_gap_assessment_items i
    LEFT JOIN users owner ON owner.id=i.owner_id
    LEFT JOIN users assessor ON assessor.id=i.assessed_by
    WHERE ${clauses.join(' AND ')}
    ORDER BY i.requirement_domain,i.requirement_ref,i.id`).all(...params);
  return rows.map(row => itemProjection(db, assessment, row, projectionOptions));
}

function getAssessmentItems(db, workspaceId, assessmentId, options = {}) {
  const assessment = requireAssessment(db, workspaceId, assessmentId);
  return getAssessmentItemsInternal(db, assessment, options);
}

function emptySummary() {
  return {
    total: 0,
    not_assessed: 0,
    implemented: 0,
    partially_implemented: 0,
    not_implemented: 0,
    not_applicable: 0,
    concluded: 0,
    progress_pct: 0,
    evidence_current: 0,
    evidence_stale: 0,
    evidence_sufficient_items: 0,
    evidence_insufficient_items: 0,
    open_findings: 0,
  };
}

function summarizeItems(items) {
  const summary = emptySummary();
  summary.total = items.length;
  for (const item of items) {
    if (item.status === 'Not Assessed') summary.not_assessed++;
    else if (item.status === 'Implemented') summary.implemented++;
    else if (item.status === 'Partially Implemented') summary.partially_implemented++;
    else if (item.status === 'Not Implemented') summary.not_implemented++;
    else if (item.status === 'Not Applicable') summary.not_applicable++;
    if (item.status !== 'Not Assessed') summary.concluded++;
    summary.evidence_current += Number(item.evidence_current_count || 0);
    summary.evidence_stale += Number(item.evidence_stale_count || 0);
    if (item.evidence_required) {
      if (item.evidence_sufficient) summary.evidence_sufficient_items++;
      else summary.evidence_insufficient_items++;
    }
    summary.open_findings += Array.isArray(item.findings)
      ? item.findings.filter(finding => !['closed', 'verified'].includes(finding.status)).length
      : Number(item.finding_count || 0);
  }
  summary.progress_pct = summary.total ? Math.round(summary.concluded * 100 / summary.total) : 0;
  return summary;
}

function reviewsForAssessment(db, assessment) {
  return db.prepare(`SELECT r.*,u.name AS actor_name
    FROM dpdpa_gap_assessment_reviews r
    JOIN users u ON u.id=r.actor_id
    WHERE r.workspace_id=? AND r.assessment_id=?
    ORDER BY r.created_at,r.id`).all(assessment.workspace_id, assessment.id);
}

function snapshotsForAssessment(db, assessment) {
  return db.prepare(`SELECT s.*,u.name AS created_by_name
    FROM dpdpa_gap_assessment_snapshots s
    JOIN users u ON u.id=s.created_by
    WHERE s.workspace_id=? AND s.assessment_id=?
    ORDER BY s.sequence_number DESC,s.id DESC`).all(assessment.workspace_id, assessment.id)
    .map(snapshot => ({
      ...snapshot,
      snapshot_json: parseJson(snapshot.snapshot_json, {}),
    }));
}

function baselineComparison(db, assessment, currentItems) {
  const empty = {
    baseline_assessment_id: assessment.baseline_assessment_id || null,
    baseline_snapshot_id: assessment.baseline_snapshot_id || null,
    summary: { improved: 0, regressed: 0, unchanged: 0, newly_na: 0, new: 0 },
    items: [],
  };
  if (!assessment.baseline_snapshot_id) return empty;
  const snapshot = db.prepare(`SELECT snapshot_json FROM dpdpa_gap_assessment_snapshots
    WHERE workspace_id=? AND assessment_id=? AND id=?`).get(
      assessment.workspace_id, assessment.baseline_assessment_id, assessment.baseline_snapshot_id
    );
  if (!snapshot) return empty;
  const payload = parseJson(snapshot.snapshot_json, {});
  const priorItems = new Map((Array.isArray(payload.items) ? payload.items : [])
    .map(item => [item.ref || item.requirement_ref, item]));
  const ranks = {
    'Not Assessed': -1,
    'Not Implemented': 0,
    'Partially Implemented': 1,
    Implemented: 2,
  };
  for (const item of currentItems) {
    const prior = priorItems.get(item.ref);
    const before = prior ? prior.status : null;
    const after = item.status;
    let change;
    if (!prior) change = 'new';
    else if (after === 'Not Applicable' && before !== 'Not Applicable') change = 'newly_na';
    else if (before === after) change = 'unchanged';
    else if (before === 'Not Applicable' && after !== 'Not Applicable') change = 'regressed';
    else if ((ranks[after] ?? -1) > (ranks[before] ?? -1)) change = 'improved';
    else change = 'regressed';
    empty.summary[change]++;
    empty.items.push({
      ref: item.ref,
      title: item.title,
      domain: item.domain,
      before_status: before,
      after_status: after,
      change,
    });
  }
  return empty;
}

function hydrateAssessment(db, row, { includeArtifacts = true } = {}) {
  if (!row) return null;
  const assessment = {
    ...row,
    applicability_profile: parseJson(row.applicability_profile_json, {}),
  };
  const items = getAssessmentItemsInternal(db, assessment);
  assessment.summary = summarizeItems(items);
  assessment.baseline_comparison = baselineComparison(db, assessment, items);
  if (includeArtifacts) {
    assessment.reviews = reviewsForAssessment(db, assessment);
    assessment.snapshots = snapshotsForAssessment(db, assessment);
    assessment.latest_snapshot = assessment.snapshots[0] || null;
  }
  return assessment;
}

function getAssessment(db, workspaceId, assessmentId) {
  return hydrateAssessment(db, assessmentRow(db, workspaceId, assessmentId));
}

function listAssessments(db, workspaceId, options = {}) {
  const wsId = positiveId(workspaceId, 'workspaceId');
  workspaceRow(db, wsId);
  const clauses = ['a.workspace_id=?'];
  const params = [wsId];
  if (options.status) {
    const status = normalizeEnum(options.status, ASSESSMENT_STATUSES, null, 'Assessment status');
    clauses.push('a.status=?');
    params.push(status);
  }
  const limit = Math.min(200, Math.max(1, Number.parseInt(options.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
  params.push(limit, offset);
  const rows = db.prepare(`SELECT a.*,f.code AS framework_code,f.name AS framework_name,
      creator.name AS created_by_name,submitter.name AS submitted_by_name,
      approver.name AS approved_by_name
    FROM dpdpa_gap_assessments a
    JOIN frameworks f ON f.id=a.framework_id
    LEFT JOIN users creator ON creator.id=a.created_by
    LEFT JOIN users submitter ON submitter.id=a.submitted_by
    LEFT JOIN users approver ON approver.id=a.approved_by
    WHERE ${clauses.join(' AND ')}
    ORDER BY CASE WHEN a.status='Superseded' THEN 1 ELSE 0 END,a.updated_at DESC,a.id DESC
    LIMIT ? OFFSET ?`).all(...params);
  return rows.map(row => hydrateAssessment(db, row, { includeArtifacts: false }));
}

function itemRow(db, workspaceId, assessmentId, itemId) {
  return db.prepare(`SELECT i.*,owner.name AS owner_name,assessor.name AS assessed_by_name
    FROM dpdpa_gap_assessment_items i
    LEFT JOIN users owner ON owner.id=i.owner_id
    LEFT JOIN users assessor ON assessor.id=i.assessed_by
    WHERE i.workspace_id=? AND i.assessment_id=? AND i.id=?`).get(
      positiveId(workspaceId, 'workspaceId'),
      positiveId(assessmentId, 'assessmentId'),
      positiveId(itemId, 'itemId')
    ) || null;
}

function requireItem(db, workspaceId, assessmentId, itemId) {
  const row = itemRow(db, workspaceId, assessmentId, itemId);
  if (!row) fail('DPDPA_NOT_FOUND', 'DPDPA assessment item not found in this workspace.', 404);
  return row;
}

function controlStatusForItem(status) {
  return {
    'Not Assessed': { applicability: 'undecided', status: 'not_assessed' },
    Implemented: { applicability: 'applicable', status: 'implemented' },
    'Partially Implemented': { applicability: 'applicable', status: 'partially_implemented' },
    'Not Implemented': { applicability: 'applicable', status: 'not_implemented' },
    'Not Applicable': { applicability: 'excluded', status: 'not_applicable' },
  }[status];
}

function updateAssessmentItem(db, input = {}) {
  const workspaceId = positiveId(input.workspaceId || input.workspace_id, 'workspaceId');
  const assessmentId = positiveId(input.assessmentId || input.assessment_id, 'assessmentId');
  const itemId = positiveId(input.itemId || input.item_id, 'itemId');
  const actorId = positiveId(input.actorId || input.actor_id, 'actorId');
  actorWithPermission(db, workspaceId, actorId, 'dpdpa.assess');
  const expectedVersion = positiveId(input.rowVersion || input.row_version, 'rowVersion');
  const assessment = requireAssessment(db, workspaceId, assessmentId);
  if (!['Draft', 'In Progress'].includes(assessment.status)) {
    fail('DPDPA_INVALID_TRANSITION', 'Assessment workpapers are locked during and after review.', 409);
  }
  const before = requireItem(db, workspaceId, assessmentId, itemId);
  if (before.row_version !== expectedVersion) {
    fail('DPDPA_CONFLICT', 'This assessment item was updated by someone else.', 409, {
      expected_row_version: expectedVersion,
      actual_row_version: before.row_version,
    });
  }
  const status = normalizeEnum(input.status, ITEM_STATUSES, before.status, 'Implementation status');
  const assessmentNote = optionalText(inputValue(input, 'assessmentNote', 'assessment_note'));
  const gapDescription = optionalText(inputValue(input, 'gapDescription', 'gap_description'));
  const recommendation = optionalText(input.recommendation);
  const naRationale = status === 'Not Applicable'
    ? requiredText(inputValue(input, 'naRationale', 'na_rationale'), 'Not Applicable rationale', 80)
    : null;
  const ownerId = optionalId(inputValue(input, 'ownerId', 'owner_id'), 'ownerId');
  if (ownerId) workspaceOwner(db, workspaceId, ownerId);
  const dueDate = isoDate(inputValue(input, 'dueDate', 'due_date'), 'Due date', { optional: true });
  const evidence = evidenceManifestForRequirement(db, workspaceId, before.requirement_id, assessment.as_of_date);
  const evidenceRequired = ['Implemented', 'Partially Implemented'].includes(status);
  const evidenceSufficient = evidenceRequired ? evidence.some(entry => entry.current) : true;
  const assessedAt = nowIso();

  const update = db.transaction(() => {
    const changed = db.prepare(`UPDATE dpdpa_gap_assessment_items SET
        status=?,assessment_note=?,gap_description=?,recommendation=?,na_rationale=?,
        owner_id=?,due_date=?,evidence_sufficient=?,assessed_by=?,assessed_at=?,
        row_version=row_version+1,updated_at=?
      WHERE workspace_id=? AND assessment_id=? AND id=? AND row_version=?`).run(
        status, assessmentNote, gapDescription, recommendation, naRationale,
        ownerId, dueDate, evidenceSufficient ? 1 : 0, actorId, assessedAt, assessedAt,
        workspaceId, assessmentId, itemId, expectedVersion
      );
    if (changed.changes !== 1) {
      fail('DPDPA_CONFLICT', 'This assessment item was updated by someone else.', 409);
    }

    const control = db.prepare(`SELECT * FROM control_instances
      WHERE workspace_id=? AND requirement_id=? AND id=?`).get(
        workspaceId, before.requirement_id, before.control_instance_id
      );
    if (!control) fail('DPDPA_CONFLICT', 'The canonical control instance is missing.', 409);
    const projected = controlStatusForItem(status);
    db.prepare(`UPDATE control_instances SET applicability=?,status=?,notes=?,internal_notes=?,
        inclusion_justification=?,exclusion_justification=?,owner_id=?,due_date=?,last_updated=?
      WHERE workspace_id=? AND requirement_id=? AND id=?`).run(
        projected.applicability, projected.status, assessmentNote, gapDescription,
        status === 'Not Applicable' ? null : assessmentNote,
        status === 'Not Applicable' ? naRationale : null,
        ownerId, dueDate, assessedAt, workspaceId, before.requirement_id, before.control_instance_id
      );
    // The old control_instance_history bet was deliberately removed by
    // migration 020. Preserve source attribution in the retained canonical
    // arbitration ledger as an already-accepted assessment proposal.
    db.prepare(`INSERT INTO proposed_changes
      (workspace_id,instance_id,proposed_status,source,source_ref,rationale,
       created_at,decided_by,decision,decided_at)
      VALUES (?,? ,?,'assessment',?,?,? ,?,'accepted',?)`).run(
        workspaceId, control.id, projected.status,
        `dpdpa:${assessmentId}:${itemId}`,
        assessmentNote || gapDescription || `DPDPA item set to ${status}`,
        assessedAt, actorId, assessedAt
      );

    db.prepare(`UPDATE dpdpa_gap_assessments
      SET status=CASE WHEN status='Draft' THEN 'In Progress' ELSE status END,
          row_version=row_version+1,updated_at=?
      WHERE workspace_id=? AND id=? AND status IN ('Draft','In Progress')`).run(
        assessedAt, workspaceId, assessmentId
      );
    const after = requireItem(db, workspaceId, assessmentId, itemId);
    writeAudit(db, { ...input, workspaceId, actorId },
      'dpdpa_gap_assessment.item_updated', 'dpdpa_gap_assessment_item', itemId,
      {
        assessment_id: assessmentId,
        requirement_ref: after.requirement_ref,
        evidence_current_count: evidence.filter(entry => entry.current).length,
        evidence_stale_count: evidence.filter(entry => entry.stale).length,
      }, before, after);
    return after;
  });
  const updated = update();
  const refreshedAssessment = requireAssessment(db, workspaceId, assessmentId);
  return {
    ...itemProjection(db, refreshedAssessment, updated),
    assessment_row_version: refreshedAssessment.row_version,
  };
}

function refreshEvidenceFlags(db, assessment) {
  const rows = db.prepare(`SELECT id,requirement_id,status,evidence_sufficient
    FROM dpdpa_gap_assessment_items WHERE workspace_id=? AND assessment_id=?`).all(
      assessment.workspace_id, assessment.id
    );
  const update = db.prepare(`UPDATE dpdpa_gap_assessment_items
    SET evidence_sufficient=?,row_version=row_version+1,updated_at=?
    WHERE workspace_id=? AND assessment_id=? AND id=?`);
  const changedAt = nowIso();
  for (const row of rows) {
    const required = ['Implemented', 'Partially Implemented'].includes(row.status);
    const sufficient = !required || evidenceManifestForRequirement(
      db, assessment.workspace_id, row.requirement_id, assessment.as_of_date
    ).some(entry => entry.current);
    if (Boolean(row.evidence_sufficient) !== sufficient) {
      update.run(sufficient ? 1 : 0, changedAt, assessment.workspace_id, assessment.id, row.id);
    }
  }
}

function assessmentBlockers(items) {
  const blockers = [];
  for (const item of items) {
    const add = (kind, message) => blockers.push({
      kind,
      item_id: item.id,
      ref: item.ref,
      title: item.title,
      message,
    });
    if (item.status === 'Not Assessed') {
      add('not_assessed', 'Record an implementation status.');
      continue;
    }
    if (item.status === 'Not Applicable') {
      if (cleanText(item.na_rationale).length < 80) {
        add('na_rationale', 'Not Applicable requires an evidence-based rationale of at least 80 characters.');
      }
      continue;
    }
    if (cleanText(item.assessment_note).length < 20) {
      add('assessment_note', 'Record an assessment note of at least 20 characters.');
    }
    if (['Partially Implemented', 'Not Implemented'].includes(item.status)) {
      if (cleanText(item.gap_description).length < 20) {
        add('gap_description', 'Describe the implementation gap in at least 20 characters.');
      }
      if (cleanText(item.recommendation).length < 20) {
        add('recommendation', 'Record a recommendation of at least 20 characters.');
      }
    }
    if (item.evidence_required && !item.evidence_sufficient) {
      add('evidence', 'Implemented and Partially Implemented conclusions require current linked evidence at the assessment as-of date.');
    }
  }
  return blockers;
}

function insertReview(db, {
  workspaceId, assessmentId, itemId = null, itemRowVersion = null,
  action, fromStatus, toStatus, note = null, actorId, createdAt = nowIso(),
}) {
  const result = db.prepare(`INSERT INTO dpdpa_gap_assessment_reviews
    (workspace_id,assessment_id,assessment_item_id,item_row_version,
     action,from_status,to_status,note,actor_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      workspaceId, assessmentId, itemId, itemRowVersion,
      action, fromStatus, toStatus, note, actorId, createdAt
    );
  return db.prepare(`SELECT r.*,u.name AS actor_name
    FROM dpdpa_gap_assessment_reviews r JOIN users u ON u.id=r.actor_id
    WHERE r.workspace_id=? AND r.assessment_id=? AND r.id=?`).get(
      workspaceId, assessmentId, Number(result.lastInsertRowid)
    );
}

function transitionFailure(db, workspaceId, assessmentId, expectedVersion, expectedStatus) {
  const current = requireAssessment(db, workspaceId, assessmentId);
  if (current.status !== expectedStatus) {
    fail('DPDPA_INVALID_TRANSITION', `Assessment must be ${expectedStatus} for this action.`, 409, {
      actual_status: current.status,
    });
  }
  fail('DPDPA_CONFLICT', 'This assessment was updated by someone else.', 409, {
    expected_row_version: expectedVersion,
    actual_row_version: current.row_version,
  });
}

function throwBlockers(items) {
  const blockers = assessmentBlockers(items);
  if (!blockers.length) return;
  const evidenceBlocked = blockers.some(blocker => blocker.kind === 'evidence');
  fail(
    evidenceBlocked ? 'DPDPA_EVIDENCE_INSUFFICIENT' : 'DPDPA_SUBMISSION_BLOCKED',
    evidenceBlocked
      ? 'Current evidence is insufficient for one or more implementation conclusions.'
      : 'Complete all assessment workpapers before submission.',
    422,
    { blockers }
  );
}

function submitAssessment(db, input = {}) {
  const workspaceId = positiveId(input.workspaceId || input.workspace_id, 'workspaceId');
  const assessmentId = positiveId(input.assessmentId || input.assessment_id, 'assessmentId');
  const actorId = positiveId(input.actorId || input.actor_id, 'actorId');
  actorWithPermission(db, workspaceId, actorId, 'dpdpa.assess');
  const expectedVersion = positiveId(input.rowVersion || input.row_version, 'rowVersion');
  const note = optionalText(input.note);
  const before = requireAssessment(db, workspaceId, assessmentId);
  if (!['Draft', 'In Progress'].includes(before.status)) {
    fail('DPDPA_INVALID_TRANSITION', 'Only a Draft or In Progress assessment can be submitted.', 409);
  }
  if (before.row_version !== expectedVersion) {
    fail('DPDPA_CONFLICT', 'This assessment was updated by someone else.', 409, {
      expected_row_version: expectedVersion,
      actual_row_version: before.row_version,
    });
  }

  return db.transaction(() => {
    refreshEvidenceFlags(db, before);
    const items = getAssessmentItemsInternal(db, before);
    throwBlockers(items);
    const submittedAt = nowIso();
    const changed = db.prepare(`UPDATE dpdpa_gap_assessments SET
        status='Under Review',submitted_by=?,submitted_at=?,row_version=row_version+1,updated_at=?
      WHERE workspace_id=? AND id=? AND status IN ('Draft','In Progress') AND row_version=?`).run(
        actorId, submittedAt, submittedAt, workspaceId, assessmentId, expectedVersion
      );
    if (changed.changes !== 1) {
      const current = requireAssessment(db, workspaceId, assessmentId);
      if (!['Draft', 'In Progress'].includes(current.status)) {
        fail('DPDPA_INVALID_TRANSITION', 'Only a Draft or In Progress assessment can be submitted.', 409);
      }
      fail('DPDPA_CONFLICT', 'This assessment was updated by someone else.', 409);
    }
    insertReview(db, {
      workspaceId, assessmentId, action: 'Submitted', fromStatus: before.status,
      toStatus: 'Under Review', note, actorId, createdAt: submittedAt,
    });
    const after = requireAssessment(db, workspaceId, assessmentId);
    writeAudit(db, { ...input, workspaceId, actorId },
      'dpdpa_gap_assessment.submitted', 'dpdpa_gap_assessment', assessmentId,
      { note, blocker_count: 0 }, before, after);
    return getAssessment(db, workspaceId, assessmentId);
  })();
}

function returnAssessment(db, input = {}) {
  const workspaceId = positiveId(input.workspaceId || input.workspace_id, 'workspaceId');
  const assessmentId = positiveId(input.assessmentId || input.assessment_id, 'assessmentId');
  const actorId = positiveId(input.actorId || input.actor_id, 'actorId');
  actorWithPermission(db, workspaceId, actorId, 'dpdpa.review');
  const expectedVersion = positiveId(input.rowVersion || input.row_version, 'rowVersion');
  const note = requiredText(input.note, 'Return note', 20);
  const before = requireAssessment(db, workspaceId, assessmentId);
  if (before.status !== 'Under Review') {
    fail('DPDPA_INVALID_TRANSITION', 'Only an Under Review assessment can be returned.', 409);
  }
  if (before.row_version !== expectedVersion) {
    fail('DPDPA_CONFLICT', 'This assessment was updated by someone else.', 409, {
      expected_row_version: expectedVersion,
      actual_row_version: before.row_version,
    });
  }
  if (actorId === before.created_by || actorId === before.submitted_by) {
    fail('DPDPA_MAKER_CHECKER_REQUIRED', 'The assessment maker cannot perform independent review.', 409);
  }
  return db.transaction(() => {
    const returnedAt = nowIso();
    const changed = db.prepare(`UPDATE dpdpa_gap_assessments SET
        status='In Progress',submitted_by=NULL,submitted_at=NULL,
        row_version=row_version+1,updated_at=?
      WHERE workspace_id=? AND id=? AND status='Under Review' AND row_version=?`).run(
        returnedAt, workspaceId, assessmentId, expectedVersion
      );
    if (changed.changes !== 1) {
      transitionFailure(db, workspaceId, assessmentId, expectedVersion, 'Under Review');
    }
    insertReview(db, {
      workspaceId, assessmentId, action: 'Returned', fromStatus: 'Under Review',
      toStatus: 'In Progress', note, actorId, createdAt: returnedAt,
    });
    const after = requireAssessment(db, workspaceId, assessmentId);
    writeAudit(db, { ...input, workspaceId, actorId },
      'dpdpa_gap_assessment.returned', 'dpdpa_gap_assessment', assessmentId,
      { note }, before, after);
    return getAssessment(db, workspaceId, assessmentId);
  })();
}

function acceptNotApplicable(db, input = {}) {
  const workspaceId = positiveId(input.workspaceId || input.workspace_id, 'workspaceId');
  const assessmentId = positiveId(input.assessmentId || input.assessment_id, 'assessmentId');
  const itemId = positiveId(input.itemId || input.item_id, 'itemId');
  const actorId = positiveId(input.actorId || input.actor_id, 'actorId');
  actorWithPermission(db, workspaceId, actorId, 'dpdpa.approve');
  const expectedItemVersion = positiveId(input.rowVersion || input.row_version, 'rowVersion');
  const assessment = requireAssessment(db, workspaceId, assessmentId);
  if (assessment.status !== 'Under Review') {
    fail('DPDPA_INVALID_TRANSITION', 'Not Applicable rationales can be accepted only during review.', 409);
  }
  if (actorId === assessment.created_by || actorId === assessment.submitted_by) {
    fail('DPDPA_MAKER_CHECKER_REQUIRED', 'The assessment maker cannot accept a Not Applicable rationale.', 409);
  }
  const item = requireItem(db, workspaceId, assessmentId, itemId);
  if (item.status !== 'Not Applicable' || cleanText(item.na_rationale).length < 80) {
    fail('DPDPA_VALIDATION', 'Only a Not Applicable item with an 80-character rationale can be accepted.', 400);
  }
  if (item.row_version !== expectedItemVersion) {
    fail('DPDPA_CONFLICT', 'The Not Applicable rationale changed before it was accepted.', 409, {
      expected_row_version: expectedItemVersion,
      actual_row_version: item.row_version,
    });
  }
  const note = requiredText(input.note, 'Not Applicable acceptance note', 20);
  return db.transaction(() => {
    let review;
    try {
      review = insertReview(db, {
        workspaceId, assessmentId, itemId, itemRowVersion: item.row_version,
        action: 'N/A Accepted', fromStatus: 'Under Review', toStatus: 'Under Review',
        note, actorId,
      });
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE constraint failed')) {
        review = db.prepare(`SELECT r.*,u.name AS actor_name
          FROM dpdpa_gap_assessment_reviews r JOIN users u ON u.id=r.actor_id
          WHERE r.workspace_id=? AND r.assessment_id=? AND r.assessment_item_id=?
            AND r.actor_id=? AND r.item_row_version=? AND r.action='N/A Accepted'`).get(
              workspaceId, assessmentId, itemId, actorId, item.row_version
            );
      } else throw error;
    }
    writeAudit(db, { ...input, workspaceId, actorId },
      'dpdpa_gap_assessment.na_accepted', 'dpdpa_gap_assessment_item', itemId,
      { assessment_id: assessmentId, item_row_version: item.row_version, note }, null, review);
    return review;
  })();
}

function domainSummaries(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.domain)) groups.set(item.domain, []);
    groups.get(item.domain).push(item);
  }
  return [...groups.entries()].map(([domain, rows]) => ({
    domain,
    ...summarizeItems(rows),
  })).sort((a, b) => a.domain.localeCompare(b.domain));
}

function projectGapFindings(db, assessment, items, actorId) {
  const projected = [];
  const findFinding = db.prepare(`SELECT * FROM findings
    WHERE workspace_id=? AND source_type='assessment' AND source_id=?`);
  const insertFinding = db.prepare(`INSERT INTO findings
    (workspace_id,source_type,source_id,title,description,severity,severity_scheme,status,created_by)
    VALUES (?,'assessment',?,?,? ,?,'hml','open',?)`);
  const findRecommendation = db.prepare(`SELECT * FROM recommendations
    WHERE workspace_id=? AND finding_id=? ORDER BY id LIMIT 1`);
  const findRemediation = db.prepare(`SELECT * FROM remediation_actions
    WHERE workspace_id=? AND finding_id=? ORDER BY id LIMIT 1`);
  for (const item of items.filter(row =>
    ['Not Implemented', 'Partially Implemented'].includes(row.status))) {
    const sourceId = `dpdpa:${assessment.id}:${item.id}`;
    const title = `DPDPA implementation gap - ${item.ref}: ${item.title}`;
    const description = item.gap_description || item.assessment_note
      || `Implementation gap recorded for ${item.ref}.`;
    const requirement = db.prepare('SELECT guidance FROM requirements WHERE id=? AND framework_id=?')
      .get(item.requirement_id, assessment.framework_id);
    const guidance = normalizeGuidance(requirement && requirement.guidance);
    const severity = ['low', 'medium', 'high', 'critical'].includes(cleanText(guidance.severity).toLowerCase())
      ? cleanText(guidance.severity).toLowerCase() : 'medium';
    let finding = findFinding.get(assessment.workspace_id, sourceId);
    if (!finding) {
      const result = insertFinding.run(
        assessment.workspace_id, sourceId, title, description, severity, assessment.created_by
      );
      finding = db.prepare('SELECT * FROM findings WHERE id=? AND workspace_id=?')
        .get(Number(result.lastInsertRowid), assessment.workspace_id);
    } else {
      db.prepare(`UPDATE findings SET title=?,description=?,severity=?,
        status=CASE WHEN status='draft' THEN 'open' ELSE status END
        WHERE workspace_id=? AND id=?`).run(
          title, description, severity, assessment.workspace_id, finding.id
        );
      finding = db.prepare('SELECT * FROM findings WHERE id=? AND workspace_id=?')
        .get(finding.id, assessment.workspace_id);
    }
    db.prepare('INSERT OR IGNORE INTO finding_controls(finding_id,instance_id) VALUES (?,?)')
      .run(finding.id, item.control_instance_id);

    const recommendationText = item.recommendation
      || `Define and implement a controlled remediation plan for ${item.ref}.`;
    let recommendation = findRecommendation.get(assessment.workspace_id, finding.id);
    if (!recommendation) {
      const result = db.prepare(`INSERT INTO recommendations
        (workspace_id,finding_id,text,priority,effort_estimate)
        VALUES (?,?,?,?,'to_be_estimated')`).run(
          assessment.workspace_id, finding.id, recommendationText,
          item.status === 'Not Implemented' ? 'high' : 'medium'
        );
      recommendation = db.prepare('SELECT * FROM recommendations WHERE id=? AND workspace_id=?')
        .get(Number(result.lastInsertRowid), assessment.workspace_id);
    } else {
      db.prepare('UPDATE recommendations SET text=?,priority=? WHERE workspace_id=? AND id=?').run(
        recommendationText, item.status === 'Not Implemented' ? 'high' : 'medium',
        assessment.workspace_id, recommendation.id
      );
      recommendation = db.prepare('SELECT * FROM recommendations WHERE id=? AND workspace_id=?')
        .get(recommendation.id, assessment.workspace_id);
    }

    const owner = item.owner_id
      ? db.prepare('SELECT user_type FROM users WHERE id=?').get(item.owner_id) : null;
    const ownerKind = owner ? (owner.user_type === 'client' ? 'client' : 'consultant') : null;
    let remediation = findRemediation.get(assessment.workspace_id, finding.id);
    if (!remediation) {
      const result = db.prepare(`INSERT INTO remediation_actions
        (workspace_id,finding_id,recommendation_id,title,description,owner_kind,
         owner_user_id,due_date,status)
        VALUES (?,?,?,?,?,?,?,?,'planned')`).run(
          assessment.workspace_id, finding.id, recommendation.id,
          `Remediate ${item.ref}: ${item.title}`, recommendationText,
          ownerKind, item.owner_id, item.due_date
        );
      remediation = db.prepare('SELECT * FROM remediation_actions WHERE id=? AND workspace_id=?')
        .get(Number(result.lastInsertRowid), assessment.workspace_id);
    } else {
      db.prepare(`UPDATE remediation_actions SET recommendation_id=?,title=?,description=?,
        owner_kind=?,owner_user_id=?,due_date=? WHERE workspace_id=? AND id=?`).run(
          recommendation.id, `Remediate ${item.ref}: ${item.title}`, recommendationText,
          ownerKind, item.owner_id, item.due_date,
          assessment.workspace_id, remediation.id
        );
      remediation = db.prepare('SELECT * FROM remediation_actions WHERE id=? AND workspace_id=?')
        .get(remediation.id, assessment.workspace_id);
    }
    projected.push({
      item_id: item.id,
      requirement_ref: item.ref,
      finding_id: finding.id,
      recommendation_id: recommendation.id,
      remediation_action_id: remediation.id,
      projected_by: actorId,
    });
  }
  return projected;
}

function snapshotPayload(db, assessment, sequenceNumber, capturedAt) {
  const items = getAssessmentItemsInternal(db, assessment, {}, { includeManifests: true });
  const identity = db.prepare(`SELECT w.id AS workspace_id,w.client_name,
      f.id AS firm_id,f.name AS firm_name
    FROM workspaces w JOIN firms f ON f.id=w.firm_id WHERE w.id=?`).get(assessment.workspace_id);
  if (!identity) fail('DPDPA_NOT_FOUND', 'Snapshot workspace identity is unavailable.', 404);
  const summary = summarizeItems(items);
  const current = items.filter(item => item.legal_effective_status === 'Effective');
  const future = items.filter(item => item.legal_effective_status === 'Future Effective');
  const undated = items.filter(item => item.legal_effective_status === 'Effective Date Not Set');
  return stableValue({
    payload_version: SNAPSHOT_VERSION,
    sequence_number: sequenceNumber,
    captured_at: capturedAt,
    workspace: { id: identity.workspace_id, client_name: identity.client_name },
    firm: { id: identity.firm_id, name: identity.firm_name },
    assessment: {
      id: assessment.id,
      workspace_id: assessment.workspace_id,
      framework_code: assessment.framework_code || 'dpdpa',
      title: assessment.title,
      scope_statement: assessment.scope_statement,
      as_of_date: assessment.as_of_date,
      status: assessment.status,
      row_version: assessment.row_version,
      catalog_version: assessment.catalog_version,
      catalog_hash: assessment.catalog_hash,
      catalog_requirement_count: assessment.catalog_requirement_count,
      applicability_profile_version: assessment.applicability_profile_version,
      applicability_profile_hash: assessment.applicability_profile_hash,
      applicability_profile: parseJson(assessment.applicability_profile_json, {}),
      baseline_assessment_id: assessment.baseline_assessment_id,
      baseline_snapshot_id: assessment.baseline_snapshot_id,
      created_by: assessment.created_by,
      created_by_name: assessment.created_by_name,
      submitted_by: assessment.submitted_by,
      submitted_by_name: assessment.submitted_by_name,
      submitted_at: assessment.submitted_at,
      approved_by: assessment.approved_by,
      approved_by_name: assessment.approved_by_name,
      approved_at: assessment.approved_at,
    },
    summary,
    effective_readiness: {
      currently_effective: summarizeItems(current),
      future_effective: summarizeItems(future),
      effective_date_not_set: summarizeItems(undated),
    },
    by_domain: domainSummaries(items),
    baseline_comparison: baselineComparison(db, assessment, items),
    items: items.map(item => ({
      id: item.id,
      requirement_id: item.requirement_id,
      control_instance_id: item.control_instance_id,
      ref: item.ref,
      title: item.title,
      description: item.description,
      domain: item.domain,
      source_section: item.source_section,
      source_rule: item.source_rule,
      effective_date: item.effective_date,
      legal_effective_status: item.legal_effective_status,
      applicability_hint: item.applicability_hint,
      applicability_reason: item.applicability_reason,
      status: item.status,
      assessment_note: item.assessment_note,
      gap_description: item.gap_description,
      recommendation: item.recommendation,
      na_rationale: item.na_rationale,
      owner_id: item.owner_id,
      owner_name: item.owner_name,
      due_date: item.due_date,
      evidence_sufficient: item.evidence_sufficient,
      evidence_total_count: item.evidence_total_count,
      evidence_current_count: item.evidence_current_count,
      evidence_stale_count: item.evidence_stale_count,
      evidence: item.evidence,
      findings: item.findings,
      row_version: item.row_version,
    })),
    reviews: reviewsForAssessment(db, assessment),
    integrity: {
      catalog_version: assessment.catalog_version,
      catalog_hash: assessment.catalog_hash,
      applicability_profile_hash: assessment.applicability_profile_hash,
      hash_algorithm: 'sha256',
    },
  });
}

function createSnapshotInternal(db, assessment, input) {
  if (!['Under Review', 'Approved', 'Superseded'].includes(assessment.status)) {
    fail('DPDPA_INVALID_TRANSITION', 'Snapshots can be created only during review or from an approved baseline.', 409);
  }
  const actorId = positiveId(input.actorId || input.actor_id, 'actorId');
  const reason = requiredText(input.reason || 'Controlled assessment snapshot', 'Snapshot reason', 5);
  const next = db.prepare(`SELECT COALESCE(MAX(sequence_number),0)+1 AS n
    FROM dpdpa_gap_assessment_snapshots WHERE workspace_id=? AND assessment_id=?`).get(
      assessment.workspace_id, assessment.id
    ).n;
  const capturedAt = nowIso();
  const payload = snapshotPayload(db, assessment, next, capturedAt);
  const json = stableStringify(payload);
  const hash = sha256(json);
  const result = db.prepare(`INSERT INTO dpdpa_gap_assessment_snapshots
    (workspace_id,assessment_id,sequence_number,assessment_row_version,status_at_capture,
     catalog_version,catalog_hash,payload_version,snapshot_json,snapshot_hash,reason,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      assessment.workspace_id, assessment.id, next, assessment.row_version, assessment.status,
      assessment.catalog_version, assessment.catalog_hash, SNAPSHOT_VERSION,
      json, hash, reason, actorId, capturedAt
    );
  const snapshot = db.prepare(`SELECT s.*,u.name AS created_by_name
    FROM dpdpa_gap_assessment_snapshots s JOIN users u ON u.id=s.created_by
    WHERE s.workspace_id=? AND s.assessment_id=? AND s.id=?`).get(
      assessment.workspace_id, assessment.id, Number(result.lastInsertRowid)
    );
  snapshot.snapshot_json = parseJson(snapshot.snapshot_json, {});
  writeAudit(db, { ...input, workspaceId: assessment.workspace_id, actorId },
    'dpdpa_gap_assessment.snapshot_created', 'dpdpa_gap_assessment_snapshot', snapshot.id,
    {
      assessment_id: assessment.id,
      sequence_number: next,
      assessment_row_version: assessment.row_version,
      snapshot_hash: hash,
      reason,
    }, null, { snapshot_hash: hash, sequence_number: next });
  return snapshot;
}

function createSnapshot(db, input = {}) {
  const workspaceId = positiveId(input.workspaceId || input.workspace_id, 'workspaceId');
  const assessmentId = positiveId(input.assessmentId || input.assessment_id, 'assessmentId');
  const actorId = positiveId(input.actorId || input.actor_id, 'actorId');
  actorWithPermission(db, workspaceId, actorId, 'dpdpa.export');
  const assessment = requireAssessment(db, workspaceId, assessmentId);
  return db.transaction(() => createSnapshotInternal(db, assessment, {
    ...input, workspaceId, assessmentId, actorId,
  }))();
}

function approveAssessment(db, input = {}) {
  const workspaceId = positiveId(input.workspaceId || input.workspace_id, 'workspaceId');
  const assessmentId = positiveId(input.assessmentId || input.assessment_id, 'assessmentId');
  const actorId = positiveId(input.actorId || input.actor_id, 'actorId');
  actorWithPermission(db, workspaceId, actorId, 'dpdpa.approve');
  const expectedVersion = positiveId(input.rowVersion || input.row_version, 'rowVersion');
  const note = requiredText(input.note, 'Approval note', 20);
  const before = requireAssessment(db, workspaceId, assessmentId);
  if (before.status !== 'Under Review') {
    fail('DPDPA_INVALID_TRANSITION', 'Only an Under Review assessment can be approved.', 409);
  }
  if (before.row_version !== expectedVersion) {
    fail('DPDPA_CONFLICT', 'This assessment was updated by someone else.', 409, {
      expected_row_version: expectedVersion,
      actual_row_version: before.row_version,
    });
  }
  if (actorId === before.created_by || actorId === before.submitted_by) {
    fail('DPDPA_MAKER_CHECKER_REQUIRED', 'Assessment approval requires a reviewer other than its creator and submitter.', 409);
  }
  const items = getAssessmentItemsInternal(db, before);
  throwBlockers(items);
  const missingAcceptance = items.filter(item => item.status === 'Not Applicable').filter(item =>
    !db.prepare(`SELECT 1 FROM dpdpa_gap_assessment_reviews
      WHERE workspace_id=? AND assessment_id=? AND assessment_item_id=?
        AND action='N/A Accepted' AND actor_id=? AND item_row_version=?`).get(
          workspaceId, assessmentId, item.id, actorId, item.row_version
        ));
  if (missingAcceptance.length) {
    fail('DPDPA_NA_ACCEPTANCE_REQUIRED', 'The approver must explicitly accept every current Not Applicable rationale.', 422, {
      items: missingAcceptance.map(item => ({ id: item.id, ref: item.ref, row_version: item.row_version })),
    });
  }

  return db.transaction(() => {
    const approvedAt = nowIso();
    const projected = projectGapFindings(db, before, items, actorId);
    const priorApproved = db.prepare(`SELECT * FROM dpdpa_gap_assessments
      WHERE workspace_id=? AND status='Approved' AND id<>? ORDER BY id`).all(workspaceId, assessmentId);
    for (const prior of priorApproved) {
      db.prepare(`UPDATE dpdpa_gap_assessments SET status='Superseded',
        superseded_by_assessment_id=?,row_version=row_version+1,updated_at=?
        WHERE workspace_id=? AND id=? AND status='Approved'`).run(
          assessmentId, approvedAt, workspaceId, prior.id
        );
      const superseded = requireAssessment(db, workspaceId, prior.id);
      writeAudit(db, { ...input, workspaceId, actorId },
        'dpdpa_gap_assessment.superseded', 'dpdpa_gap_assessment', prior.id,
        { superseded_by_assessment_id: assessmentId }, prior, superseded);
    }
    const changed = db.prepare(`UPDATE dpdpa_gap_assessments SET
        status='Approved',approved_by=?,approved_at=?,row_version=row_version+1,updated_at=?
      WHERE workspace_id=? AND id=? AND status='Under Review' AND row_version=?`).run(
        actorId, approvedAt, approvedAt, workspaceId, assessmentId, expectedVersion
      );
    if (changed.changes !== 1) {
      transitionFailure(db, workspaceId, assessmentId, expectedVersion, 'Under Review');
    }
    insertReview(db, {
      workspaceId, assessmentId, action: 'Approved', fromStatus: 'Under Review',
      toStatus: 'Approved', note, actorId, createdAt: approvedAt,
    });
    const approved = requireAssessment(db, workspaceId, assessmentId);
    const snapshot = createSnapshotInternal(db, approved, {
      ...input,
      workspaceId,
      assessmentId,
      actorId,
      reason: input.reason || 'Approved DPDPA gap-assessment baseline',
    });
    writeAudit(db, { ...input, workspaceId, actorId },
      'dpdpa_gap_assessment.approved', 'dpdpa_gap_assessment', assessmentId,
      {
        note,
        snapshot_id: snapshot.id,
        snapshot_hash: snapshot.snapshot_hash,
        projected_findings: projected,
        superseded_assessment_ids: priorApproved.map(row => row.id),
      }, before, approved);
    return {
      assessment: getAssessment(db, workspaceId, assessmentId),
      snapshot,
      projected_findings: projected,
    };
  })();
}

function getDashboard(db, workspaceId, assessmentId = null) {
  const wsId = positiveId(workspaceId, 'workspaceId');
  workspaceRow(db, wsId);
  let assessment;
  if (assessmentId != null && assessmentId !== '') {
    assessment = requireAssessment(db, wsId, assessmentId);
  } else {
    assessment = db.prepare(`SELECT a.*,f.code AS framework_code,f.name AS framework_name,
        creator.name AS created_by_name,submitter.name AS submitted_by_name,
        approver.name AS approved_by_name
      FROM dpdpa_gap_assessments a
      JOIN frameworks f ON f.id=a.framework_id
      LEFT JOIN users creator ON creator.id=a.created_by
      LEFT JOIN users submitter ON submitter.id=a.submitted_by
      LEFT JOIN users approver ON approver.id=a.approved_by
      WHERE a.workspace_id=? AND a.status!='Superseded'
      ORDER BY a.updated_at DESC,a.id DESC LIMIT 1`).get(wsId) || null;
  }
  const recentAssessments = listAssessments(db, wsId, { limit: 10 });
  if (!assessment) {
    return {
      assessment: null,
      summary: emptySummary(),
      currently_effective: emptySummary(),
      future_effective: emptySummary(),
      effective_date_not_set: emptySummary(),
      by_domain: [],
      blockers: [],
      baseline_comparison: {
        baseline_assessment_id: null,
        baseline_snapshot_id: null,
        summary: { improved: 0, regressed: 0, unchanged: 0, newly_na: 0, new: 0 },
        items: [],
      },
      recent_assessments: recentAssessments,
    };
  }
  assessment = hydrateAssessment(db, assessment);
  const items = getAssessmentItemsInternal(db, assessment);
  const current = items.filter(item => item.legal_effective_status === 'Effective');
  const future = items.filter(item => item.legal_effective_status === 'Future Effective');
  const undated = items.filter(item => item.legal_effective_status === 'Effective Date Not Set');
  const blockers = assessmentBlockers(items);
  if (assessment.status === 'Under Review') {
    for (const item of items.filter(row => row.status === 'Not Applicable')) {
      const accepted = db.prepare(`SELECT 1 FROM dpdpa_gap_assessment_reviews
        WHERE workspace_id=? AND assessment_id=? AND assessment_item_id=?
          AND action='N/A Accepted' AND item_row_version=?`).get(
            wsId, assessment.id, item.id, item.row_version
          );
      if (!accepted) blockers.push({
        kind: 'na_acceptance', item_id: item.id, ref: item.ref, title: item.title,
        message: 'The current Not Applicable rationale awaits explicit approver acceptance.',
      });
    }
  }
  return {
    assessment,
    summary: summarizeItems(items),
    currently_effective: summarizeItems(current),
    future_effective: summarizeItems(future),
    effective_date_not_set: summarizeItems(undated),
    by_domain: domainSummaries(items),
    blockers,
    baseline_comparison: assessment.baseline_comparison,
    recent_assessments: recentAssessments,
  };
}

module.exports = {
  DpdpaGapDomainError,
  ASSESSMENT_STATUSES,
  ITEM_STATUSES,
  LEGAL_EFFECTIVE_STATUSES,
  APPLICABILITY_HINTS,
  PROFILE_VERSION,
  SNAPSHOT_VERSION,
  ensureFrameworkSeeded,
  createAssessment,
  getAssessment,
  listAssessments,
  getAssessmentItems,
  updateAssessmentItem,
  submitAssessment,
  returnAssessment,
  acceptNotApplicable,
  approveAssessment,
  createSnapshot,
  getDashboard,
};
