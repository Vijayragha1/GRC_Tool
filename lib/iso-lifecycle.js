'use strict';

const DEFAULT_OUTCOME = 'certification_support';

const OUTCOME_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'gap_assessment_only',
    label: 'Gap assessment only',
    description: 'Assess the current management system, independently review the conclusions, issue the report, and close this engagement.',
    consultingEngagementType: 'gap_assessment',
  }),
  Object.freeze({
    value: 'certification_support',
    label: 'Full certification support',
    description: 'Continue after the gap report through implementation, documentation, internal audit, management review, and Stage 1 and Stage 2 support.',
    consultingEngagementType: 'implementation',
  }),
]);

const OUTCOME_BY_VALUE = new Map(OUTCOME_OPTIONS.map(option => [option.value, option]));

// Both ISO management-system programmes share the contracted delivery lifecycle.
const ISO_FRAMEWORK_CODES = Object.freeze(require('./frameworks').FRAMEWORK_LIST.filter(f => f.managementSystem).map(f => f.code));

// Accept the persisted JSON representation as well as hydrated workspace rows.
function isoFrameworkCodes(workspace) {
  let codes = Array.isArray(workspace) ? workspace : workspace && workspace.frameworks;
  if (typeof codes === 'string') { try { codes = JSON.parse(codes); } catch (_) { codes = []; } }
  if (!Array.isArray(codes)) return [];
  return ISO_FRAMEWORK_CODES.filter(code => codes.includes(code));
}

function hasIsoManagementSystem(workspace) {
  return isoFrameworkCodes(workspace).length > 0;
}

function frameworkLabel(workspace) {
  return isoFrameworkCodes(workspace).map(code => code === 'iso42001' ? 'ISO 42001' : 'ISO 27001').join(' + ') || 'ISO management system';
}

function isValidOutcome(value) {
  return typeof value === 'string' && OUTCOME_BY_VALUE.has(value.trim());
}

// Persisted workspaces created before the outcome was explicit followed the
// certification journey. Unknown legacy values therefore resolve to the same
// safe behaviour instead of silently shortening a contracted engagement.
function normalizeOutcome(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return OUTCOME_BY_VALUE.has(candidate) ? candidate : DEFAULT_OUTCOME;
}

function option(value) {
  return OUTCOME_BY_VALUE.get(normalizeOutcome(value));
}

function isGapOnly(value) {
  return normalizeOutcome(value) === 'gap_assessment_only';
}

function label(value) {
  return option(value).label;
}

function consultingEngagementType(value) {
  return option(value).consultingEngagementType;
}

module.exports = {
  ISO_FRAMEWORK_CODES,
  isoFrameworkCodes,
  hasIsoManagementSystem,
  frameworkLabel,
  DEFAULT_OUTCOME,
  OUTCOME_OPTIONS,
  isValidOutcome,
  normalizeOutcome,
  isGapOnly,
  label,
  consultingEngagementType,
};
