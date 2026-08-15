'use strict';

const crypto = require('crypto');

const PHASES = ['mobilisation', 'fieldwork', 'validation', 'report', 'post_report'];
const RECEIVED_REQUESTS = new Set(['submitted', 'accepted', 'cancelled']);
const CLOSED_REQUESTS = new Set(['accepted', 'cancelled']);
const CLOSED_INTERVIEWS = new Set(['completed', 'cancelled']);

function latestPass(db, workspaceId) {
  return db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=?
    ORDER BY (status='in_progress') DESC,pass_number DESC,id DESC LIMIT 1`).get(workspaceId) || null;
}

function assessmentContext(db, workspace) {
  const pass = latestPass(db, workspace.id);
  const passId = pass?.id || -1;
  const control = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN ci.status IS NOT NULL AND ci.status!='not_assessed' THEN 1 ELSE 0 END) assessed,
      SUM(CASE WHEN ci.applicability IN ('applicable','excluded') THEN 1 ELSE 0 END) scope_decided
    FROM requirements r JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001'
    LEFT JOIN control_instances ci ON ci.requirement_id=r.id AND ci.workspace_id=? AND ci.entity_id IS NULL`).get(workspace.id);
  const requests = db.prepare(`SELECT id,status,priority,due_date,title,assignee_id FROM client_requests
    WHERE workspace_id=? ORDER BY id`).all(workspace.id);
  const interviews = db.prepare(`SELECT i.*,u.name owner_name FROM gap_fieldwork_interviews i
    LEFT JOIN users u ON u.id=i.owner_id
    WHERE i.workspace_id=? AND (i.assessment_pass_id=? OR i.assessment_pass_id IS NULL)
    ORDER BY i.scheduled_at,i.id`).all(workspace.id, passId);
  const manualBlockers = db.prepare(`SELECT b.*,u.name owner_name FROM gap_fieldwork_blockers b
    LEFT JOIN users u ON u.id=b.owner_id
    WHERE b.workspace_id=? AND (b.assessment_pass_id=? OR b.assessment_pass_id IS NULL)
    ORDER BY CASE b.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,b.due_date,b.id`).all(workspace.id, passId);
  const defaults = db.prepare(`SELECT d.*,r.ref,r.title requirement_title FROM gap_declared_defaults d
    JOIN requirements r ON r.id=d.requirement_id
    WHERE d.workspace_id=? AND (d.assessment_pass_id=? OR d.assessment_pass_id IS NULL)
    ORDER BY r.sort_order,d.id`).all(workspace.id, passId);
  const snapshots = db.prepare(`SELECT * FROM gap_fieldwork_snapshots
    WHERE workspace_id=? AND (assessment_pass_id=? OR assessment_pass_id IS NULL)
    ORDER BY week_ending DESC,id DESC`).all(workspace.id, passId);
  const decisions = pass ? db.prepare(`SELECT d.*,u.name decided_by_name FROM gap_assessment_phase_decisions d
    LEFT JOIN users u ON u.id=d.decided_by WHERE d.workspace_id=? AND d.assessment_pass_id=?`).all(workspace.id, pass.id) : [];
  const findings = db.prepare(`SELECT id,status,client_visible FROM consulting_findings
    WHERE workspace_id=? AND client_visible=1 AND status NOT IN ('draft','withdrawn')`).all(workspace.id);
  const reports = db.prepare(`SELECT id,status FROM consulting_report_snapshots
    WHERE workspace_id=? AND report_type IN ('assessment','readiness')`).all(workspace.id);
  const audit = db.prepare(`SELECT id,title,sampling_justification,population_size,sample_size FROM audits
    WHERE workspace_id=? ORDER BY CASE WHEN TRIM(COALESCE(sampling_justification,''))<>'' THEN 0 ELSE 1 END,
    audit_date DESC,id DESC LIMIT 1`).get(workspace.id) || null;
  const engagement = db.prepare(`SELECT id,scope_statement FROM consulting_engagements
    WHERE workspace_id=? AND status!='cancelled' ORDER BY CASE engagement_type WHEN 'gap_assessment' THEN 0 ELSE 1 END,id DESC LIMIT 1`).get(workspace.id) || null;
  const today = new Date().toISOString().slice(0, 10);
  const requestBlockers = requests.filter(row => !CLOSED_REQUESTS.has(row.status) &&
    (row.priority === 'urgent' || (row.due_date && row.due_date < today)));
  const openManualBlockers = manualBlockers.filter(row => row.status === 'open');
  const receivedRequests = requests.filter(row => RECEIVED_REQUESTS.has(row.status)).length;
  const completedInterviews = interviews.filter(row => row.status === 'completed').length;
  const confirmedDefaults = defaults.filter(row => row.status === 'confirmed').length;
  const visibleInterviews = interviews.filter(row => row.client_visible === 1);
  const visibleManualBlockers = openManualBlockers.filter(row => row.client_visible === 1);
  const visibleDefaults = defaults.filter(row => row.status === 'confirmed' && row.client_visible === 1);
  const scope = String(engagement?.scope_statement || workspace.scope || '').trim();
  const decided = Object.fromEntries(decisions.map(row => [row.phase, row]));
  const finalDecision = phase => ['complete', 'not_required'].includes(decided[phase]?.decision);
  const publishedReports = reports.filter(row => row.status === 'published').length;
  const openRemediation = findings.filter(row => row.status !== 'closed').length;

  const gates = {
    mobilisation: {
      ready: scope.length >= 20 && Number(control.scope_decided || 0) === Number(control.total || 0) &&
        !!String(audit?.sampling_justification || '').trim(),
      checks: [
        { label: 'Scope and boundary recorded', pass: scope.length >= 20 },
        { label: 'Applicability decided for every requirement', pass: Number(control.scope_decided || 0) === Number(control.total || 0) },
        { label: 'Sampling basis documented', pass: !!String(audit?.sampling_justification || '').trim() }
      ]
    },
    fieldwork: {
      ready: !!pass && pass.status === 'completed' && Number(control.assessed || 0) === Number(control.total || 0) &&
        interviews.every(row => CLOSED_INTERVIEWS.has(row.status)) && requests.every(row => RECEIVED_REQUESTS.has(row.status)) &&
        openManualBlockers.length === 0 && requestBlockers.length === 0,
      checks: [
        { label: 'Assessment pass completed', pass: !!pass && pass.status === 'completed' },
        { label: 'All requirements concluded', pass: Number(control.assessed || 0) === Number(control.total || 0) },
        { label: 'Interview schedule concluded', pass: interviews.every(row => CLOSED_INTERVIEWS.has(row.status)) },
        { label: 'All RFIs received or closed', pass: requests.every(row => RECEIVED_REQUESTS.has(row.status)) },
        { label: 'No active blockers', pass: openManualBlockers.length === 0 && requestBlockers.length === 0 }
      ]
    },
    validation: {
      ready: finalDecision('fieldwork'),
      checks: [
        { label: 'Fieldwork formally signed off', pass: finalDecision('fieldwork') },
        { label: findings.length ? 'Confirmed findings available for factual validation' : 'No-findings conclusion requires explicit Not required decision', pass: findings.length > 0 }
      ]
    },
    report: {
      ready: finalDecision('validation'),
      complete: publishedReports > 0,
      checks: [
        { label: 'Validation complete or formally not required', pass: finalDecision('validation') },
        { label: 'Approved report published to the client portal', pass: publishedReports > 0 }
      ]
    },
    post_report: {
      ready: publishedReports > 0 && openRemediation === 0,
      checks: [
        { label: 'Client report published', pass: publishedReports > 0 },
        { label: 'All confirmed findings closed', pass: openRemediation === 0 }
      ]
    }
  };

  const completed = {
    mobilisation: finalDecision('mobilisation'),
    fieldwork: finalDecision('fieldwork'),
    validation: finalDecision('validation'),
    report: publishedReports > 0,
    post_report: finalDecision('post_report')
  };
  let currentPhase = PHASES.find(phase => !completed[phase]) || 'post_report';
  // A later phase cannot become current until its predecessor is formally complete.
  for (let index = 1; index < PHASES.length; index += 1) {
    if (currentPhase === PHASES[index] && !completed[PHASES[index - 1]]) currentPhase = PHASES[index - 1];
  }

  return {
    pass, control, requests, interviews, manualBlockers, requestBlockers, openManualBlockers,
    defaults, snapshots, decisions, decisionMap: decided, findings, reports, audit, engagement,
    gates, completed, currentPhase,
    live: {
      requirementsCovered: Number(control.assessed || 0),
      requirementsTotal: Number(control.total || 0),
      interviewsCompleted: completedInterviews,
      interviewsPlanned: interviews.length,
      requestsReceived: receivedRequests,
      requestsTotal: requests.length,
      activeBlockers: openManualBlockers.length + requestBlockers.length,
      declaredDefaults: confirmedDefaults
    },
    clientLive: {
      requirementsCovered: Number(control.assessed || 0),
      requirementsTotal: Number(control.total || 0),
      interviewsCompleted: visibleInterviews.filter(row => row.status === 'completed').length,
      interviewsPlanned: visibleInterviews.length,
      requestsReceived: receivedRequests,
      requestsTotal: requests.length,
      activeBlockers: visibleManualBlockers.length + requestBlockers.length,
      declaredDefaults: visibleDefaults.length
    }
  };
}

function snapshotFieldwork(db, workspace, actorId, weekEnding) {
  const context = assessmentContext(db, workspace);
  if (!context.pass) throw new Error('Start an assessment pass before freezing a weekly snapshot.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekEnding || ''))) throw new Error('A valid week-ending date is required.');
  const payload = {
    version: 1,
    workspace_id: workspace.id,
    assessment_pass_id: context.pass.id,
    week_ending: weekEnding,
    metrics: context.clientLive,
    interview_ids: context.interviews.filter(row => row.client_visible === 1).map(row => row.id),
    request_ids: context.requests.map(row => row.id),
    manual_blocker_ids: context.manualBlockers.filter(row => row.client_visible === 1).map(row => row.id),
    request_blocker_ids: context.requestBlockers.map(row => row.id),
    declared_default_ids: context.defaults.filter(row => row.status === 'confirmed' && row.client_visible === 1).map(row => row.id),
    frozen_at: new Date().toISOString()
  };
  const json = JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const result = db.prepare(`INSERT INTO gap_fieldwork_snapshots
    (workspace_id,assessment_pass_id,week_ending,requirements_covered,requirements_total,
     interviews_completed,interviews_planned,requests_received,requests_total,active_blockers,
     declared_defaults,snapshot_json,snapshot_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      workspace.id, context.pass.id, weekEnding, context.clientLive.requirementsCovered,
      context.clientLive.requirementsTotal, context.clientLive.interviewsCompleted, context.clientLive.interviewsPlanned,
      context.clientLive.requestsReceived, context.clientLive.requestsTotal, context.clientLive.activeBlockers,
      context.clientLive.declaredDefaults, json, hash, actorId);
  return Number(result.lastInsertRowid);
}

module.exports = { PHASES, latestPass, assessmentContext, snapshotFieldwork };
