'use strict';

const csfModel = require('./csf-policy-practice');

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
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND ci.status='partially_implemented' THEN 1 ELSE 0 END) partial,
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND ci.status='work_in_progress' THEN 1 ELSE 0 END) work_in_progress,
      SUM(CASE WHEN COALESCE(ci.applicability,'undecided')!='excluded' AND (ci.status IS NULL OR ci.status IN ('not_assessed','not_implemented','partially_implemented','work_in_progress')) THEN 1 ELSE 0 END) open_items
    FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    LEFT JOIN control_instances ci ON ci.requirement_id=r.id AND ci.workspace_id=? AND ci.entity_id IS NULL AND ci.end_dated_at IS NULL
    WHERE f.code=? AND f.status!='retired'`).get(ws.id, frameworkCode);
  const total = Number(counts.total || 0);
  const excluded = Number(counts.excluded || 0);
  const applicable = Math.max(0, total - excluded);
  const assessed = Number(counts.assessed || 0);
  const implemented = Number(counts.implemented || 0);
  const openItems = Number(counts.open_items || 0);
  const completionPct = percent(assessed, total);
  const implementationPct = percent(implemented, applicable);
  const evidence = linkedArtifactCount(db, ws.id, frameworkCode, 'evidence');
  const documents = linkedArtifactCount(db, ws.id, frameworkCode, 'documents');
  const base = `/workspaces/${ws.id}`;
  const is27001 = frameworkCode === 'iso27001';
  let status = 'Not started';
  if (assessed > 0 && assessed < total) status = 'Assessment in progress';
  else if (assessed === total && openItems > 0) status = 'Improvement in progress';
  else if (assessed === total && total > 0) status = 'Implementation complete';
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
    openItems, evidence, documents,
    currentLabel: `${implementationPct}% implemented`,
    currentDetail: `${implemented} of ${applicable} applicable requirements`,
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

function sharedSignals(db, wsId) {
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM assets WHERE workspace_id=?) assets,
    (SELECT COUNT(*) FROM risks WHERE workspace_id=? AND status='open') openRisks,
    (SELECT COUNT(*) FROM risks WHERE workspace_id=? AND status='open' AND likelihood*impact>=15) highRisks,
    (SELECT COUNT(*) FROM tasks WHERE workspace_id=? AND status NOT IN ('done','cancelled')) openTasks,
    (SELECT COUNT(*) FROM tasks WHERE workspace_id=? AND status NOT IN ('done','cancelled') AND due_date<date('now')) overdueTasks,
    (SELECT COUNT(*) FROM generated_docs WHERE workspace_id=? AND retired_at IS NULL) documents,
    (SELECT COUNT(*) FROM evidence WHERE workspace_id=?) evidence,
    (SELECT COUNT(*) FROM suppliers WHERE workspace_id=? AND status='active') suppliers,
    (SELECT COUNT(*) FROM audits WHERE workspace_id=?) audits,
    (SELECT COUNT(*) FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified')) openNcs`)
    .get(wsId,wsId,wsId,wsId,wsId,wsId,wsId,wsId,wsId,wsId);
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

function buildIntegratedDashboard(db, ws) {
  const frameworkCodes = Array.isArray(ws.frameworks) ? ws.frameworks : [];
  const programmes = frameworkCodes.map(code => code === 'csf' ? csfProgramme(db, ws) : isoProgramme(db, ws, code));
  const tasks = db.prepare(`SELECT t.id,t.title,t.due_date,t.status,t.priority,u.name assignee_name
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.workspace_id=? AND t.status NOT IN ('done','cancelled')
    ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      CASE WHEN t.due_date<date('now') THEN 0 ELSE 1 END,t.due_date LIMIT 5`).all(ws.id);
  const risks = db.prepare(`SELECT id,title,likelihood,impact,residual_likelihood,residual_impact,owner_name
    FROM risks WHERE workspace_id=? AND status='open'
    ORDER BY likelihood*impact DESC,id DESC LIMIT 5`).all(ws.id);
  return {
    programmes,
    signals: sharedSignals(db, ws.id),
    tasks,
    risks,
    mappingCount: mappingCount(db, frameworkCodes),
    totalAssessmentUnits: programmes.reduce((sum, p) => sum + p.total, 0),
    assessedUnits: programmes.reduce((sum, p) => sum + p.assessed, 0),
  };
}

module.exports = { FRAMEWORK_META, buildIntegratedDashboard };
