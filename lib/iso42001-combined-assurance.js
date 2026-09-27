'use strict';

const { frameworkCodes } = require('./engagement-outcome-scope');
const isoLifecycle = require('./iso-lifecycle');
const assessment = require('./iso42001-assessment');
const aims = require('./iso42001-delivery');
const certification = require('./iso42001-certification');

// The combined workspace still uses the ISMS report workflow. Its successful
// result cannot stand in for an AIMS assessment or certification decision.
// Keep the unsupported combined-report endpoint visible and fail closed.
function combinedAssurance(db, workspace) {
  const codes = frameworkCodes(workspace);
  if (!codes.includes('iso27001') || !codes.includes('iso42001')) {
    return { applicable: false, ready: true, blockers: [] };
  }
  const gap = assessment.getGapState(db, workspace.id);
  const blockers = [];
  if (!gap.complete) blockers.push('Complete independent review of the current ISO 42001 assessment and retain its frozen evidence snapshot.');
  const state = { applicable: true, assessmentReviewed: !!gap.complete };
  if (!isoLifecycle.isGapOnly(workspace.engagement_outcome)) {
    const readiness = aims.readiness(db, workspace);
    const stage1 = certification.certificationAuditState(db, workspace.id, 'stage_1');
    const stage2 = certification.stage2AssuranceState(db, workspace.id);
    Object.assign(state, {
      readinessReady: !!readiness.stage2Ready, stage1AuditComplete: stage1.auditComplete,
      stage2AuditComplete: stage2.auditComplete, openStage1Findings: stage1.openFindings,
      openStage2Findings: stage2.openFindings
    });
    if (!readiness.stage2Ready) blockers.push('Pass the ISO 42001 readiness requirements for the combined certification-support contract.');
    if (!stage1.auditComplete) blockers.push('Retain a unique, dated and completed ISO 42001 Stage 1 certification audit.');
    if (!stage2.auditComplete) blockers.push('Retain a unique, dated and completed ISO 42001 Stage 2 certification audit after its Stage 1 audit.');
    if (stage1.openFindings || stage2.openFindings) blockers.push('Close every ISO 42001 certification finding and observation before combined delivery completion.');
  }
  blockers.push('Publish an independently approved ISO 42001 report through a dedicated ISO 42001 engagement before closing this combined contract.');
  return { ...state, ready: false, blockers };
}

module.exports = { combinedAssurance };
