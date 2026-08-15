'use strict';

// Client-safe projection of the ISO 27001 gap-assessment lifecycle.
//
// This module intentionally does not return workpaper procedures, internal
// notes, raw interview notes, draft findings, assessor attribution, or
// unpublished report payloads. Keeping the projection here (rather than in an
// EJS template) gives the portal one auditable disclosure boundary.

const gapFieldwork = require('./gap-fieldwork');

const RATING_SCALE = Object.freeze([
  { key: 'not_assessed', label: 'Not assessed', definition: 'No conclusion has been recorded for this requirement.' },
  { key: 'not_implemented', label: 'Not implemented', definition: 'The required process or control is absent, or no operating evidence supports it.' },
  { key: 'work_in_progress', label: 'Work in progress', definition: 'Implementation has started but is not yet complete or operating.' },
  { key: 'partially_implemented', label: 'Partially implemented', definition: 'The requirement operates in part, but design, coverage or evidence remains incomplete.' },
  { key: 'implemented', label: 'Implemented', definition: 'The requirement is designed, operating and supported by suitable evidence.' },
  { key: 'not_applicable', label: 'Not applicable', definition: 'The requirement is outside the agreed boundary and has a recorded justification.' }
]);

const EVIDENCE_TIERS = Object.freeze([
  { code: 'E1', label: 'Documented design', definition: 'Approved policies, procedures, standards or configured designs show how the requirement should operate.' },
  { code: 'E2', label: 'Operating record', definition: 'Dated records, tickets, logs or completed reviews show the process operated during the assessment period.' },
  { code: 'E3', label: 'Tested assurance', definition: 'A sample, re-performance or independent test supports both operation and effectiveness.' }
]);

const PHASES = Object.freeze([
  { key: 'mobilisation', number: '01', label: 'Mobilisation', description: 'Agree the boundary, method, evidence expectations and fieldwork plan.' },
  { key: 'fieldwork', number: '02', label: 'Fieldwork', description: 'Track coverage, interviews, requests, blockers and declared defaults.' },
  { key: 'validation', number: '03', label: 'Validation', description: 'Check the factual accuracy of confirmed findings and provide late evidence.' },
  { key: 'report', number: '04', label: 'Report', description: 'Receive the gap register, consolidated findings and improvement roadmap.' },
  { key: 'post_report', number: '05', label: 'Post-report', description: 'Track remediation, re-test criteria and the evidence required for closure.' }
]);

const TERMINAL_REQUESTS = new Set(['accepted', 'cancelled']);

function parseFrameworks(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch (_) { return []; }
}

function publicStatus(value) {
  const key = String(value || 'not_assessed').toLowerCase();
  return RATING_SCALE.find(item => item.key === key)?.label || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function publicRequestStatus(value) {
  return ({
    open: 'Requested', in_progress: 'In progress', submitted: 'Received - under review',
    accepted: 'Complete', changes_requested: 'More information required', cancelled: 'Closed'
  })[String(value || '').toLowerCase()] || String(value || '').replace(/_/g, ' ');
}

function publicInterviewStatus(value) {
  return ({ scheduled: 'Scheduled', rescheduled: 'Rescheduled', completed: 'Complete', cancelled: 'Cancelled' })[String(value || '').toLowerCase()]
    || String(value || '').replace(/_/g, ' ');
}

function refLabel(row) {
  if (row.req_type === 'control') return String(row.ref).replace(/^annex-a\./i, 'A.');
  return String(row.ref).replace(/^clause-/i, '');
}

function firstNonEmpty(...values) {
  return values.find(value => String(value || '').trim()) || null;
}

function buildClientGapAssessmentProjection(db, workspace, options = {}) {
  const frameworks = parseFrameworks(workspace.frameworks);
  if (!frameworks.includes('iso27001')) return { applicable: false };
  const governance = gapFieldwork.assessmentContext(db, workspace);

  const engagement = db.prepare(`SELECT * FROM consulting_engagements
    WHERE workspace_id=? AND status NOT IN ('cancelled')
    ORDER BY CASE engagement_type WHEN 'gap_assessment' THEN 0 WHEN 'readiness' THEN 1 ELSE 2 END,
      CASE status WHEN 'active' THEN 0 WHEN 'quality_review' THEN 1 WHEN 'complete' THEN 2 ELSE 3 END,
      id DESC LIMIT 1`).get(workspace.id) || null;

  const controlRows = db.prepare(`SELECT r.id requirement_id,r.ref,r.req_type,r.title,r.sort_order,
      COALESCE(ci.status,'not_assessed') status,COALESCE(ci.applicability,'undecided') applicability,
      ci.exclusion_justification,ci.last_updated,
      (SELECT COUNT(*) FROM evidence e WHERE e.workspace_id=? AND e.iso_item_id=r.ref AND e.superseded_at IS NULL) evidence_count
    FROM requirements r JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001'
    LEFT JOIN control_instances ci ON ci.requirement_id=r.id AND ci.workspace_id=? AND ci.entity_id IS NULL
    ORDER BY r.sort_order,r.id`).all(workspace.id, workspace.id).map(row => ({
      ...row,
      code: refLabel(row),
      status_label: publicStatus(row.status),
      assessed: row.status !== 'not_assessed'
    }));

  const clauseRows = controlRows.filter(row => row.req_type === 'clause');
  const annexRows = controlRows.filter(row => row.req_type === 'control');
  const assessed = controlRows.filter(row => row.assessed).length;
  const included = controlRows.filter(row => row.applicability === 'applicable').length;
  const excluded = controlRows.filter(row => row.applicability === 'excluded' || row.status === 'not_applicable').length;
  const evidenceBacked = controlRows.filter(row => row.evidence_count > 0).length;

  const latestPass = governance.pass;

  const audit = db.prepare(`SELECT title,scope,audit_date,status,sample_size,population_size,sampling_justification
    FROM audits WHERE workspace_id=?
    ORDER BY CASE WHEN sampling_justification IS NOT NULL AND TRIM(sampling_justification)<>'' THEN 0 ELSE 1 END,
      audit_date DESC,id DESC LIMIT 1`).get(workspace.id) || null;

  const requestParams = [workspace.id];
  const requestScope = options.assigneeId ? ' AND cr.assignee_id=?' : '';
  if (options.assigneeId) requestParams.push(options.assigneeId);
  // The assessment log is deliberately independent of the portal's active /
  // closed list filter: received and completed RFIs remain part of the client
  // fieldwork record. Contributors retain their assignment boundary.
  const sourceRequests = db.prepare(`SELECT cr.*,u.name assignee_name,
      (SELECT COUNT(*) FROM client_request_evidence cre WHERE cre.request_id=cr.id) evidence_count
    FROM client_requests cr LEFT JOIN users u ON u.id=cr.assignee_id
    WHERE cr.workspace_id=?${requestScope} ORDER BY cr.created_at,cr.id`).all(...requestParams);
  const requests = sourceRequests.map(row => ({
    id: row.id,
    title: row.title,
    owner: row.assignee_name || 'Unassigned',
    requested_date: String(row.created_at || '').slice(0, 10) || null,
    received_date: String(row.submitted_at || row.closed_at || '').slice(0, 10) || null,
    due_date: row.due_date || null,
    priority: row.priority || 'normal',
    status: row.status,
    status_label: publicRequestStatus(row.status),
    control_ref: row.control_id ? String(row.control_id).replace(/^annex-a\./i, 'A.').replace(/^clause-/i, '') : null,
    evidence_count: Number(row.evidence_count || 0)
  }));

  const interviews = governance.interviews.filter(row => row.client_visible === 1).map(row => ({
    id: row.id,
    title: row.title,
    objective: row.objective,
    participant_role: row.participant_role,
    owner: row.owner_name || 'To be agreed',
    scheduled_at: row.scheduled_at,
    due_date: String(row.scheduled_at || '').slice(0, 10) || null,
    duration_minutes: row.duration_minutes,
    status: row.status,
    status_label: publicInterviewStatus(row.status),
    completion_summary: row.completion_summary
  }));

  const today = new Date().toISOString().slice(0, 10);
  const requestBlockers = requests.filter(row => !TERMINAL_REQUESTS.has(row.status) && (
    row.priority === 'urgent' || (row.due_date && row.due_date < today)
  )).map(row => ({
    source: 'request',
    title: row.title,
    owner: row.owner,
    due_date: row.due_date,
    reason: row.due_date && row.due_date < today ? 'Past the agreed due date' : 'Marked urgent'
  }));
  const manualBlockers = governance.openManualBlockers.filter(row => row.client_visible === 1).map(row => ({
    source: 'fieldwork',
    title: row.title,
    owner: row.owner_name || 'To be agreed',
    due_date: row.due_date,
    reason: row.description,
    priority: row.priority
  }));
  const blockers = [...manualBlockers, ...requestBlockers];

  const governedDefaults = governance.defaults.filter(row => row.status === 'confirmed' && row.client_visible === 1).map(row => ({
    requirement_id: row.requirement_id,
    code: String(row.ref).replace(/^annex-a\./i, 'A.').replace(/^clause-/i, ''),
    title: row.requirement_title,
    declaration: row.declaration,
    recorded_at: row.confirmed_at || row.updated_at,
    addition: true,
    source: 'declared_default'
  }));
  const governedRequirementIds = new Set(governedDefaults.map(row => row.requirement_id));
  const applicabilityDefaults = controlRows.filter(row =>
    !governedRequirementIds.has(row.requirement_id) &&
    (row.applicability === 'excluded' || row.status === 'not_applicable')).map(row => ({
    requirement_id: row.requirement_id,
    code: row.code,
    title: row.title,
    declaration: row.exclusion_justification || 'Recorded as outside the agreed assessment boundary.',
    recorded_at: row.last_updated || null,
    addition: !!(latestPass?.started_at && row.last_updated && row.last_updated >= latestPass.started_at),
    source: 'applicability'
  }));
  const defaults = [...governedDefaults, ...applicabilityDefaults];

  // Only confirmed, explicitly client-visible consulting findings cross the
  // disclosure boundary. Drafts and withdrawn findings never enter this query.
  const findings = db.prepare(`SELECT f.id,f.finding_ref,f.title,f.finding_type,f.severity,
      f.condition_text,f.criteria_text,f.effect_text,f.recommendation_text,f.status,f.due_date,
      f.remediation_plan,f.effort_estimate,f.cost_estimate,f.retest_criteria,f.closure_evidence_requirements,
      f.resolution_summary,f.validation_conclusion,
      r.ref requirement_ref,r.title requirement_title,u.name owner_name,
      GROUP_CONCAT(DISTINCT e.id) evidence_ids,
      COUNT(DISTINCT CASE WHEN fe.evidence_role IN ('remediation','validation') THEN fe.evidence_id END) closure_evidence_count
    FROM consulting_findings f
    LEFT JOIN consultant_workpapers w ON w.id=f.workpaper_id AND w.workspace_id=f.workspace_id
    LEFT JOIN requirements r ON r.id=w.requirement_id
    LEFT JOIN users u ON u.id=f.owner_id
    LEFT JOIN consulting_finding_evidence fe ON fe.finding_id=f.id
    LEFT JOIN evidence e ON e.id=fe.evidence_id AND e.workspace_id=f.workspace_id
    WHERE f.workspace_id=? AND f.client_visible=1 AND f.status NOT IN ('draft','withdrawn')
    GROUP BY f.id ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,f.id`).all(workspace.id).map(row => ({
      ...row,
      requirement_ref: row.requirement_ref ? String(row.requirement_ref).replace(/^annex-a\./i, 'A.').replace(/^clause-/i, '') : '—',
      evidence_refs: row.evidence_ids ? row.evidence_ids.split(',').map(id => `E-${String(id).padStart(3, '0')}`) : [],
      owner: row.owner_name || 'To be agreed',
      effort: row.effort_estimate || 'Not yet estimated',
      cost: row.cost_estimate || 'Not yet estimated',
      retest_criteria: row.retest_criteria || null,
      closure_requirement: row.closure_evidence_requirements || null
    }));

  const reports = db.prepare(`SELECT id,title,report_type,version_number,published_at
    FROM consulting_report_snapshots
    WHERE workspace_id=? AND status='published' AND report_type IN ('assessment','readiness')
    ORDER BY published_at DESC,id DESC`).all(workspace.id);

  const currentPhase = governance.currentPhase;
  const currentIndex = PHASES.findIndex(phase => phase.key === currentPhase);
  const phases = PHASES.map(phase => ({
    ...phase,
    decision: governance.decisionMap[phase.key]?.decision || null,
    state: governance.completed[phase.key] ? 'complete' : phase.key === currentPhase ? 'current' : 'upcoming'
  }));

  const completedInterviews = interviews.filter(row => row.status === 'completed').length;
  const coveragePct = controlRows.length ? Math.round(assessed / controlRows.length * 100) : 0;
  const scopeStatement = firstNonEmpty(engagement?.scope_statement, workspace.scope,
    'The assessment scope has not yet been recorded.');

  return {
    applicable: true,
    currentPhase,
    currentPhaseLabel: PHASES[currentIndex].label,
    phases,
    scope: {
      statement: scopeStatement,
      entities: engagement?.included_entities || 'Covered by the agreed scope statement',
      locations: engagement?.included_locations || 'Covered by the agreed scope statement',
      systems: engagement?.included_systems || 'Covered by the agreed scope statement',
      exclusions: engagement?.exclusions || 'No separate exclusions have been recorded'
    },
    coverage: {
      total: controlRows.length,
      assessed,
      pct: coveragePct,
      included,
      excluded,
      evidenceBacked,
      clauses: { total: clauseRows.length, assessed: clauseRows.filter(row => row.assessed).length, rows: clauseRows },
      annex: { total: annexRows.length, assessed: annexRows.filter(row => row.assessed).length, rows: annexRows }
    },
    methodology: {
      ratingScale: RATING_SCALE,
      evidenceTiers: EVIDENCE_TIERS,
      sampling: audit ? {
        basis: audit.sampling_justification || 'The sampling basis has not yet been documented.',
        sample_size: audit.sample_size,
        population_size: audit.population_size,
        source: audit.title
      } : { basis: 'The sampling basis has not yet been documented.', sample_size: null, population_size: null, source: null }
    },
    requests,
    interviews,
    blockers,
    defaults,
    findings,
    reports,
    weeklySnapshots: governance.snapshots.map(row => ({
      id: row.id,
      weekEnding: row.week_ending,
      requirementsCovered: row.requirements_covered,
      requirementsTotal: row.requirements_total,
      interviewsCompleted: row.interviews_completed,
      interviewsPlanned: row.interviews_planned,
      requestsReceived: row.requests_received,
      requestsTotal: row.requests_total,
      activeBlockers: row.active_blockers,
      declaredDefaults: row.declared_defaults,
      frozenAt: row.created_at
    })),
    phaseGates: governance.gates,
    tracker: {
      coveragePct,
      controlsCovered: assessed,
      controlsTotal: controlRows.length,
      interviewsDone: completedInterviews,
      interviewsPlanned: interviews.length,
      openRequests: requests.filter(row => !TERMINAL_REQUESTS.has(row.status)).length,
      requestsReceived: requests.filter(row => ['submitted', 'accepted'].includes(row.status)).length,
      blockers: blockers.length
    },
    findingSummary: ['critical', 'high', 'medium', 'low'].map(severity => ({
      severity, count: findings.filter(row => row.severity === severity).length
    })),
    lastUpdated: firstNonEmpty(latestPass?.completed_at, latestPass?.started_at, workspace.updated_at, workspace.created_at),
    pass: latestPass ? { id: latestPass.id, number: latestPass.pass_number, label: latestPass.label, status: latestPass.status } : null
  };
}

module.exports = {
  RATING_SCALE,
  EVIDENCE_TIERS,
  PHASES,
  buildClientGapAssessmentProjection
};
