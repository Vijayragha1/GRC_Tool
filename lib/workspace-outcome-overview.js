'use strict';

// A small, presentation-safe projection for the ISO workspace overview.
// The governed gap-fieldwork model remains authoritative; this module only
// translates its state into plain language for a time-poor delivery audience.

const GAP_PHASES = Object.freeze([
  { key: 'mobilisation', label: 'Mobilisation', description: 'Confirm the assessment boundary, evidence expectations and fieldwork plan.' },
  { key: 'fieldwork', label: 'Fieldwork', description: 'Complete interviews, evidence requests and requirement-by-requirement assessment work.' },
  { key: 'validation', label: 'Factual validation', description: 'Validate the confirmed gaps and resolve late evidence before reporting.' },
  { key: 'report', label: 'Controlled report', description: 'Independently approve and issue the controlled gap-assessment report.' },
]);

const CLOSED_REQUEST_STATUSES = new Set(['accepted', 'cancelled']);

function asCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function buildGapAssessmentOverview(context = {}) {
  const total = asCount(context.control?.total);
  const assessed = Math.min(total, asCount(context.control?.assessed));
  const coveragePct = total ? Math.round((assessed / total) * 100) : 0;
  const completed = context.completed || {};
  const completedPhaseCount = GAP_PHASES.filter(phase => completed[phase.key]).length;
  const currentPhase = context.currentPhase === 'complete'
    ? 'complete'
    : (GAP_PHASES.some(phase => phase.key === context.currentPhase) ? context.currentPhase : 'mobilisation');
  const definition = GAP_PHASES.find(phase => phase.key === currentPhase);
  const reportCount = asCount(context.closure?.independentlyApprovedReports);
  const contractClosed = Boolean(context.closure?.complete);
  const closureReady = Boolean(context.closure?.ready);
  const closureBlockers = Array.isArray(context.closure?.blockers) ? context.closure.blockers : [];
  const openRequests = Array.isArray(context.requests)
    ? context.requests.filter(request => !CLOSED_REQUEST_STATUSES.has(request.status)).length
    : 0;

  let reportState = 'Not issued';
  let endpointState = 'Assessment in progress';
  if (reportCount > 0) {
    reportState = reportCount === 1 ? '1 controlled report issued' : `${reportCount} controlled reports issued`;
    endpointState = closureReady ? 'Ready for governed closure' : 'Report issued; closure checks remain';
  }
  if (contractClosed) {
    reportState = reportCount > 0 ? 'Controlled report issued' : 'Engagement closed';
    endpointState = 'Contracted endpoint complete';
  }

  const currentPhaseLabel = currentPhase === 'complete'
    ? (contractClosed ? 'Gap assessment complete' : 'Ready for governed closure')
    : definition.label;
  const currentPhaseDescription = currentPhase === 'complete'
    ? (contractClosed
      ? 'The controlled report has been issued and this engagement has reached its contracted endpoint.'
      : 'The controlled report has been issued. Complete the governed engagement-closure action to record the contracted endpoint.')
    : definition.description;

  return {
    servicePath: 'Gap assessment only',
    endpoint: 'Independently reviewed gap-assessment report',
    currentPhase,
    currentPhaseLabel,
    currentPhaseDescription,
    phaseProgressPct: contractClosed ? 100 : Math.round((completedPhaseCount / GAP_PHASES.length) * 100),
    completedPhaseCount,
    phaseCount: GAP_PHASES.length,
    assessed,
    total,
    coveragePct,
    reportCount,
    reportState,
    endpointState,
    contractClosed,
    closureReady,
    closureBlockers,
    closureBlockerCount: closureBlockers.length,
    activeBlockers: asCount(context.live?.activeBlockers),
    openRequests,
    openRecommendations: asCount(context.closure?.openFindings),
    pass: context.pass ? {
      number: context.pass.pass_number,
      label: context.pass.label,
      status: context.pass.status,
    } : null,
  };
}

module.exports = { GAP_PHASES, buildGapAssessmentOverview };
