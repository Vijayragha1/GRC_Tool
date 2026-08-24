'use strict';

const DEFAULT_OUTCOME = 'certification_support';

const OUTCOME_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'gap_assessment_only',
    label: 'Gap assessment only',
    description: 'Assess the current ISMS, independently review the conclusions, issue the report, and close this engagement.',
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
  DEFAULT_OUTCOME,
  OUTCOME_OPTIONS,
  isValidOutcome,
  normalizeOutcome,
  isGapOnly,
  label,
  consultingEngagementType,
};
