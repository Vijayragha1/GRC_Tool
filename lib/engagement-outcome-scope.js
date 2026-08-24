'use strict';

const isoLifecycle = require('./iso-lifecycle');

const MODE = Object.freeze({
  CERTIFICATION: 'certification',
  GAP_ASSESSMENT: 'gap_assessment',
  GENERIC: 'generic',
});
const GAP_PHASE_KEY = 'gap_assessment';

function frameworkCodes(workspace) {
  const value = workspace && workspace.frameworks;
  if (Array.isArray(value)) return value.filter(code => typeof code === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(code => typeof code === 'string') : [];
  } catch (_) {
    return [];
  }
}

function hasIso27001(workspace) {
  return frameworkCodes(workspace).includes('iso27001');
}

function workspaceMode(workspace) {
  if (!hasIso27001(workspace)) return MODE.GENERIC;
  return isoLifecycle.isGapOnly(workspace && workspace.engagement_outcome)
    ? MODE.GAP_ASSESSMENT
    : MODE.CERTIFICATION;
}

function isGapAssessmentOnly(workspace) {
  return workspaceMode(workspace) === MODE.GAP_ASSESSMENT;
}

function isCertificationSupport(workspace) {
  return workspaceMode(workspace) === MODE.CERTIFICATION;
}

// The physical adaptive plan deliberately retains future certification rows so
// a gap-only contract can later expand without destroying IDs or history. Every
// downstream reader must use this predicate before showing or acting on a row.
function isPhaseInContract(workspace, phaseKey) {
  return !isGapAssessmentOnly(workspace) || phaseKey === GAP_PHASE_KEY;
}

// For single-workspace aggregate queries, return a constant SQL predicate. The
// aliases are supplied by source code, never request data, and are constrained
// to ordinary SQL identifiers to prevent accidental query construction bugs.
function phaseSqlForWorkspace(workspace, phaseAlias = 'ph') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(phaseAlias)) {
    throw new Error('Invalid phase alias.');
  }
  return isGapAssessmentOnly(workspace)
    ? `${phaseAlias}.phase_key='${GAP_PHASE_KEY}'`
    : '1=1';
}

const DEFAULT_POST_GAP_MESSAGE = 'This service is outside this ISO 27001 gap-assessment-only engagement. Use the gap assessment, evidence, findings and controlled assessment report instead.';

// Contract boundary for authenticated workspace routes. Navigation is only a
// convenience; this middleware is the authority that prevents a copied URL or
// hand-crafted POST from turning a gap-assessment contract into implementation
// or certification support. Non-ISO programmes deliberately retain their
// existing behaviour, even if they happen to use the same outcome field.
function requirePostGapService(message = DEFAULT_POST_GAP_MESSAGE) {
  return function postGapServiceGuard(req, res, next) {
    if (!isGapAssessmentOnly(req.workspace)) return next();
    const text = String(message || DEFAULT_POST_GAP_MESSAGE);
    const requestPath = String(req.originalUrl || req.path || '');
    if (requestPath.startsWith('/api/')) return res.status(409).json({ error: text });
    return res.status(409).render('error', {
      user: req.user || null,
      ws: req.workspace,
      message: text,
    });
  };
}

module.exports = {
  MODE,
  GAP_PHASE_KEY,
  frameworkCodes,
  hasIso27001,
  workspaceMode,
  isGapAssessmentOnly,
  isCertificationSupport,
  isPhaseInContract,
  phaseSqlForWorkspace,
  requirePostGapService,
};
