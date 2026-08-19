'use strict';

const csfModel = require('./csf-policy-practice');
const { todayFor } = require('./dates');
const { buildWorkspaceTruth } = require('./grc-truth');

const TRUTH_MODEL_VERSION = '2026.1';

const FRAMEWORK_META = {
  iso27001: {
    label: 'ISO/IEC 27001:2022', short: 'ISO 27001', code: 'ISMS',
    descriptor: 'Information security management system',
  },
  iso42001: {
    label: 'ISO/IEC 42001:2023', short: 'ISO 42001', code: 'AIMS',
    descriptor: 'Artificial intelligence management system',
  },
  csf: {
    label: 'NIST Cybersecurity Framework 2.0', short: 'NIST CSF 2.0', code: 'CSF',
    descriptor: 'Cybersecurity maturity assessment',
  },
};

function percent(part, total) {
  return total ? Math.round((Number(part || 0) / Number(total)) * 100) : 0;
}

function linkedArtifactCount(db, wsId, frameworkCode, table) {
  const join = table === 'evidence'
    ? `evidence_requirement_links l JOIN evidence a ON a.id=l.evidence_id`
    : `document_requirement_links l JOIN generated_docs a ON a.id=l.document_id`;
  return db.prepare(`SELECT COUNT(DISTINCT a.id) count FROM ${join}
    JOIN requirements r ON r.id=l.requirement_id
    JOIN frameworks f ON f.id=r.framework_id
    WHERE a.workspace_id=? AND f.code=?`).get(wsId, frameworkCode).count;
}

function isoProgramme(db, ws, frameworkCode) {
  const meta = FRAMEWORK_META[frameworkCode];
  const counts = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN ci.applicability='excluded' THEN 1 ELSE 0 END) excluded,
      SUM(CASE WHEN ci.applicability='excluded' OR (ci.status IS NOT NULL AND ci.status!='not_assessed') THEN 1 ELSE 0 END) assessed,
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND ci.status='implemented' THEN 1 ELSE 0 END) implemented,
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND ci.status='implemented' AND (
        EXISTS (SELECT 1 FROM evidence_requirement_links erl JOIN evidence e ON e.id=erl.evidence_id
          WHERE erl.requirement_id=r.id AND e.workspace_id=? AND e.superseded_at IS NULL)
        OR (?='iso27001' AND EXISTS (SELECT 1 FROM evidence e2 WHERE e2.workspace_id=?
          AND e2.iso_item_id=r.ref AND e2.superseded_at IS NULL))
      ) THEN 1 ELSE 0 END) evidence_backed_implemented,
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND ci.status='partially_implemented' THEN 1 ELSE 0 END) partial,
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND ci.status='work_in_progress' THEN 1 ELSE 0 END) work_in_progress,
      SUM(CASE WHEN ci.review_status='approved' THEN 1 ELSE 0 END) approved,
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND (ci.status IS NULL OR ci.status IN ('not_assessed','not_implemented','partially_implemented','work_in_progress')) THEN 1 ELSE 0 END) open_items
    FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    LEFT JOIN control_instances ci ON ci.requirement_id=r.id AND ci.workspace_id=? AND ci.entity_id IS NULL AND ci.end_dated_at IS NULL
    WHERE f.code=? AND f.status!='retired'`).get(ws.id, ws.id, frameworkCode, ws.id, frameworkCode);
  const total = Number(counts.total || 0);
  const excluded = Number(counts.excluded || 0);
  const applicable = Math.max(0, total - excluded);
  const assessed = Number(counts.assessed || 0);
  const implemented = Number(counts.implemented || 0);
  const evidenceBackedImplemented = Number(counts.evidence_backed_implemented || 0);
  const unsupportedImplemented = Math.max(0, implemented - evidenceBackedImplemented);
  const openItems = Number(counts.open_items || 0) + unsupportedImplemented;
  const approved = Number(counts.approved || 0);
  const completionPct = percent(assessed, total);
  const implementationPct = percent(implemented, applicable);
  const evidenceBackedPct = percent(evidenceBackedImplemented, applicable);
  const evidence = linkedArtifactCount(db, ws.id, frameworkCode, 'evidence');
  const documents = linkedArtifactCount(db, ws.id, frameworkCode, 'documents');
  const base = `/workspaces/${ws.id}`;
  const is27001 = frameworkCode === 'iso27001';
  const latestPass = is27001 ? db.prepare(`SELECT * FROM assessment_passes
    WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(ws.id) : null;
  const independentlySigned = !!(latestPass && latestPass.status === 'completed' && latestPass.completed_by &&
    Number(latestPass.completed_by) !== Number(latestPass.started_by));
  let status = 'Not started';
  if (assessed > 0 && assessed < total) status = 'Assessment in progress';
  else if (assessed === total && is27001 && (!latestPass || latestPass.status !== 'completed')) status = 'Awaiting independent quality review';
  else if (assessed === total && is27001 && !independentlySigned) status = 'Independent sign-off required';
  else if (assessed === total && unsupportedImplemented > 0) status = 'Evidence remediation required';
  else if (assessed === total && !is27001 && approved < total) status = 'Assessment concluded, review pending';
  else if (assessed === total && openItems > 0) status = 'Improvement in progress';
  else if (assessed === total && total > 0) status = 'Approved conclusion';
  let nextLabel = is27001 ? 'Open gap assessment' : 'Open AI gap assessment';
  let nextHref = is27001 ? `${base}/gap-assessment` : `${base}/iso42001/gap-assessment`;
  if (assessed === total && openItems > 0) {
    nextLabel = 'Open improvement roadmap';
    nextHref = is27001 ? `${base}/engagement-plan?view=timeline` : `${base}/iso42001/roadmap`;
  } else if (assessed === total && openItems === 0) {
    nextLabel = 'Review readiness';
    nextHref = is27001 ? `${base}/readiness` : `${base}/iso42001/readiness`;
  }
  return {
    key: frameworkCode, ...meta, status,
    completionPct, assessed, total, implemented, implementationPct,
    evidenceBackedImplemented, evidenceBackedPct, unsupportedImplemented,
    approved, approvedPct: percent(approved, total), openItems, evidence, documents,
    currentLabel: `${evidenceBackedPct}% evidence-backed`,
    currentDetail: unsupportedImplemented
      ? `${unsupportedImplemented} Implemented claim${unsupportedImplemented === 1 ? '' : 's'} still need evidence`
      : `${evidenceBackedImplemented} of ${applicable} applicable requirements supported`,
    assessmentDetail: `${assessed} of ${total} requirements assessed`,
    programmeHref: is27001 ? `${base}/readiness` : `${base}/iso42001/readiness`,
    nextLabel, nextHref,
  };
}

function csfProgramme(db, ws) {
  const meta = FRAMEWORK_META.csf;
  const base = `/workspaces/${ws.id}/csf`;
  const engagements = csfModel.programmeEngagements(db, ws.id);
  const engagement = engagements[0] || null;
  if (!engagement) {
    return {
      key: 'csf', ...meta, status: 'Not started', completionPct: 0,
      assessed: 0, total: 106, openItems: 106, evidence: 0,
      documents: linkedArtifactCount(db, ws.id, 'csf', 'documents'),
      currentLabel: 'No baseline', currentDetail: 'No maturity position established',
      assessmentDetail: '0 of 106 outcomes concluded', programmeHref: base,
      nextLabel: 'Create maturity programme', nextHref: `${base}/new`, functions: [],
    };
  }
  const programme = csfModel.programmeData(db, engagement);
  const summary = programme.rollup.summary;
  const assessed = Number(summary.assessed || 0);
  const total = Number(summary.inScope || 0);
  const evidence = db.prepare(`SELECT COUNT(*) count FROM csf_evidence_items ev
    JOIN csf_subcategory_assessments a ON a.id=ev.assessment_id
    WHERE a.engagement_id=? AND ev.deleted_at IS NULL`).get(engagement.id).count;
  const openFindings = db.prepare(`SELECT COUNT(*) count FROM csf_findings
    WHERE engagement_id=? AND deleted_at IS NULL AND status NOT IN ('Closed','Accepted')`).get(engagement.id).count;
  let status = 'Not started';
  let nextLabel = 'Open maturity workbench';
  let nextHref = `${base}/${engagement.id}/assessment`;
  if (assessed > 0 && assessed < total) status = 'Assessment in progress';
  if (assessed === total && total > 0) {
    status = programme.reviewed === total ? 'Quality review complete' : 'Awaiting quality review';
    nextLabel = programme.reviewed === total ? 'Open executive reporting' : 'Open quality review';
    nextHref = programme.reviewed === total ? `${base}/${engagement.id}/report` : `${base}/${engagement.id}/review`;
  }
  if (programme.published) {
    status = 'Baseline published';
    nextLabel = 'Open executive reporting';
    nextHref = `${base}/${engagement.id}/report`;
  }
  return {
    key: 'csf', ...meta, status,
    completionPct: percent(assessed, total), assessed, total,
    approved: Number(programme.approved || 0), approvedPct: percent(programme.approved || 0, total),
    openItems: Number(openFindings || 0), evidence,
    documents: linkedArtifactCount(db, ws.id, 'csf', 'documents'),
    currentLabel: programme.currentLabel,
    currentDetail: `${summary.targetPct}% of concluded outcomes meet the Target Profile`,
    assessmentDetail: `${assessed} of ${total} outcomes concluded`,
    programmeHref: base, nextLabel, nextHref,
    engagementId: engagement.id,
    functions: programme.rollup.functions.map(fn => ({
      code: fn.code, name: fn.name, achieved: fn.summary.achievedMedian,
      assessed: fn.summary.assessed, total: fn.summary.inScope,
    })),
  };
}

function sharedSignals(db, wsId, today) {
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM assets WHERE workspace_id=?) assets,
    (SELECT COUNT(*) FROM risks WHERE workspace_id=? AND status='open') openRisks,
    (SELECT COUNT(*) FROM risks WHERE workspace_id=? AND status='open' AND likelihood*impact>=15) highRisks,
    (SELECT COUNT(*) FROM tasks WHERE workspace_id=? AND status NOT IN ('done','cancelled')) openTasks,
    (SELECT COUNT(*) FROM tasks WHERE workspace_id=? AND status NOT IN ('done','cancelled') AND due_date<?) overdueTasks,
    (SELECT COUNT(*) FROM generated_docs WHERE workspace_id=? AND retired_at IS NULL) documents,
    (SELECT COUNT(*) FROM evidence WHERE workspace_id=?) evidence,
    (SELECT COUNT(*) FROM suppliers WHERE workspace_id=? AND status='active') suppliers,
    (SELECT COUNT(*) FROM audits WHERE workspace_id=?) audits,
    (SELECT COUNT(*) FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified')) openNcs`)
    .get(wsId,wsId,wsId,wsId,wsId,today,wsId,wsId,wsId,wsId,wsId);
}

function clientDecisionTruth(db, ws, today, actorId, clientFacing = false) {
  const actorFilter = actorId ? ' AND cr.assignee_id=?' : (clientFacing ? " AND assignee.user_type='client'" : '');
  const actorParams = actorId ? [actorId] : [];
  const requests = db.prepare(`SELECT cr.id,cr.title,cr.status,cr.priority,cr.due_date,cr.assignee_id,
      assignee.user_type assignee_user_type
    FROM client_requests cr LEFT JOIN users assignee ON assignee.id=cr.assignee_id
    WHERE cr.workspace_id=? AND cr.status NOT IN ('accepted','closed','cancelled')${actorFilter}`)
    .all(ws.id, ...actorParams);
  const deliverables = db.prepare(`SELECT d.id,d.client_title,d.title,d.status,d.due_date,d.owner_id,d.approver_id,
      owner.user_type owner_user_type,approver.user_type approver_user_type
    FROM engagement_delivery_deliverables d
    LEFT JOIN users owner ON owner.id=d.owner_id
    LEFT JOIN users approver ON approver.id=d.approver_id
    WHERE d.workspace_id=? AND d.client_visible=1 AND d.status NOT IN ('accepted','superseded')
      ${actorId ? 'AND (d.owner_id=? OR d.approver_id=?)' : 'AND (d.owner_id IS NOT NULL OR d.approver_id IS NOT NULL)'}`)
    .all(ws.id, ...(actorId ? [actorId, actorId] : []));
  const requestActions = requests.filter(item => ['open','in_progress','changes_requested'].includes(item.status));
  const deliverableIsClientAction = item => {
    if (actorId) {
      return (item.owner_id === actorId && ['draft','changes_requested'].includes(item.status)) ||
        (item.approver_id === actorId && ['submitted','workspace_verified'].includes(item.status));
    }
    if (clientFacing) {
      return (item.owner_user_type === 'client' && ['draft','changes_requested'].includes(item.status)) ||
        (item.approver_user_type === 'client' && ['submitted','workspace_verified'].includes(item.status));
    }
    return ['draft','changes_requested','submitted','workspace_verified'].includes(item.status);
  };
  const deliverableActions = deliverables.filter(deliverableIsClientAction);
  const overdueRequests = requestActions.filter(item => item.due_date && item.due_date < today);
  const overdueDeliverables = deliverableActions.filter(item => item.due_date && item.due_date < today);
  const urgentRequests = requestActions.filter(item => item.priority === 'urgent' &&
    !(item.due_date && item.due_date < today));
  const actions = [
    ...requestActions.map(item => ({ type:'request', ...item })),
    ...deliverableActions.map(item => ({ type:'deliverable', ...item }))
  ];
  const awaitingReviewCount = requests.filter(item => item.status === 'submitted').length +
    deliverables.filter(item => ['submitted','workspace_verified'].includes(item.status) &&
      (!clientFacing || (item.owner_user_type === 'client' && item.approver_user_type !== 'client')) &&
      (!actorId || item.owner_id === actorId)).length;
  const publishedReports = db.prepare(`SELECT COUNT(*) c FROM consulting_report_snapshots
    WHERE workspace_id=? AND status='published'`).get(ws.id).c +
    db.prepare(`SELECT COUNT(*) c FROM csf_assessment_versions_v2
      WHERE workspace_id=? AND status='published' AND is_current=1`).get(ws.id).c;
  const blockers = [
    ...overdueRequests.map(item => ({ type:'overdue_request', id:item.id, title:item.title })),
    ...overdueDeliverables.map(item => ({ type:'overdue_deliverable', id:item.id, title:item.client_title || item.title })),
    ...urgentRequests.map(item => ({ type:'urgent_request', id:item.id, title:item.title }))
  ];
  return {
    actions, actionCount: actions.length,
    blockers, blockerCount: blockers.length,
    overdueCount: overdueRequests.length + overdueDeliverables.length,
    awaitingReviewCount,
    publishedReports,
    status: blockers.length ? 'Needs attention' : actions.length ? 'In progress' : 'On track'
  };
}

function mappingCount(db, frameworkCodes) {
  if (frameworkCodes.length < 2) return 0;
  const placeholders = frameworkCodes.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(*) count FROM requirement_mappings m
    JOIN requirements r1 ON r1.id=m.canonical_requirement_id JOIN frameworks f1 ON f1.id=r1.framework_id
    JOIN requirements r2 ON r2.id=m.mapped_requirement_id JOIN frameworks f2 ON f2.id=r2.framework_id
    WHERE f1.code IN (${placeholders}) AND f2.code IN (${placeholders}) AND f1.code!=f2.code`)
    .get(...frameworkCodes,...frameworkCodes).count;
}

function buildIntegratedDashboard(db, ws, options = {}) {
  const frameworkCodes = Array.isArray(ws.frameworks) ? ws.frameworks : [];
  const today = options.today || todayFor(ws);
  const programmes = frameworkCodes.map(code => code === 'csf' ? csfProgramme(db, ws) : isoProgramme(db, ws, code));
  const tasks = db.prepare(`SELECT t.id,t.title,t.due_date,t.status,t.priority,u.name assignee_name
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.workspace_id=? AND t.status NOT IN ('done','cancelled')
    ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      CASE WHEN t.due_date<? THEN 0 ELSE 1 END,t.due_date LIMIT 5`).all(ws.id, today);
  const risks = db.prepare(`SELECT id,title,likelihood,impact,residual_likelihood,residual_impact,owner_name
    FROM risks WHERE workspace_id=? AND status='open'
    ORDER BY likelihood*impact DESC,id DESC LIMIT 5`).all(ws.id);
  return {
    truthModelVersion: TRUTH_MODEL_VERSION,
    asOfDate: today,
    timezone: ws.effective_timezone || ws.timezone || ws.firm_timezone || 'UTC',
    programmes,
    governance: buildWorkspaceTruth(db, ws),
    signals: sharedSignals(db, ws.id, today),
    client: clientDecisionTruth(db, ws, today, options.actorId || null, options.clientFacing === true),
    tasks,
    risks,
    mappingCount: mappingCount(db, frameworkCodes),
    totalAssessmentUnits: programmes.reduce((sum, p) => sum + p.total, 0),
    assessedUnits: programmes.reduce((sum, p) => sum + p.assessed, 0),
  };
}

module.exports = {
  FRAMEWORK_META, TRUTH_MODEL_VERSION,
  buildCanonicalWorkspaceTruth: buildIntegratedDashboard,
  buildWorkspaceProgrammeTruth: buildIntegratedDashboard,
  buildIntegratedDashboard
};
