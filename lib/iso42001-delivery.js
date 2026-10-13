'use strict';

// Framework adapter for the shared delivery engine. AIMS records never borrow
// ISMS evidence or legacy checklist completion as assurance.
const crypto = require('crypto');
const { frameworkCodes } = require('./engagement-outcome-scope');
const aimsShared = require('./aims-shared-records');
const isAims = ws => frameworkCodes(ws).includes('iso42001') && !frameworkCodes(ws).includes('iso27001');
// A client with both standards runs the ISO 27001 plan. Its ISO 42001 report
// is a separate governed deliverable in that plan (COMBINED_REPORT_MILESTONE),
// never the ISO 27001 report.
const isCombined = ws => frameworkCodes(ws).includes('iso42001') && frameworkCodes(ws).includes('iso27001');
// The plan milestone that carries the ISO 42001 assessment report.
const reportKey = ws => (isAims(ws) ? 'gap-controlled-report' : isCombined(ws) ? 'aims-controlled-report' : null);
const isReportMilestone = (ws, key) => !!key && key === reportKey(ws);
const COMBINED_REPORT_MILESTONE = Object.freeze({
  key: 'aims-controlled-report',
  title: 'Independently approve and publish the ISO 42001 assessment report',
  deliverables: 'Controlled ISO 42001 gap assessment report',
  clientTitle: 'Independently approved ISO 42001 assessment report',
  clientDescription: 'The ISO 42001 assessment report, separate from the ISO 27001 report.',
  requirementRefs: 'ISO 42001 clauses 4 to 10, Annex A',
  acceptanceCriteria: 'Submit the reviewed ISO 42001 assessment snapshot and report evidence; a different assigned approver accepts it, then explicitly publishes the report to the client. Separate from the ISO 27001 report.',
});
const gapHref = ws => `/workspaces/${ws.id}/iso42001/gap-assessment`;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const approvalHash = row => digest(JSON.stringify([row.id, row.revision_number, row.row_version, row.accepted_by, row.accepted_at, row.evidence_snapshot_json]));

const CONTENT = {
  'w1-kickoff': ['Kickoff with the sponsor and AIMS coordinator', 'Approved kickoff minutes, responsibilities and assessment scope', ['5.1','5.3']],
  'w1-intake': ['Agree the AIMS scope and intended AI uses', 'Approved AI management system scope and organisational context', ['4.1','4.3']],
  'w1-stakeholders': ['Review affected parties and their requirements', 'Interested parties, affected groups and their documented requirements', ['4.2']],
  'w2-assets': ['Register AI systems and accountable owners', 'AI system inventory, intended uses, lifecycle roles and owners', ['A.4.2']],
  'w2-crown': ['Assess impacts on individuals and society', 'Approved system impact assessments for the scoped AI systems', ['6.1.4','8.4','A.5']],
  'w3-method': ['Approve AI risk and impact assessment methods', 'Approved risk criteria, impact criteria and assessment methods', ['6.1.2','6.1.4']],
  'w3-risks': ['Assess risks across the AI lifecycle', 'AI risk assessment results, accountable owners and impact assessment links', ['6.1.2','8.2']],
  'w4-treatment': ['Agree AI risk treatment and residual risk decisions', 'Owned treatment actions, due dates and residual risk acceptance', ['6.1.3','8.3']],
  'w4-soa': ['Approve the AI Statement of Applicability', 'Annex A applicability decisions and justified inclusions and exclusions', ['6.1.3']],
  'w5-policies-a': ['Approve AI policy, scope and governance responsibilities', 'Approved AI policy, AIMS scope and responsibility assignments', ['5.2','5.3','7.5']],
  'w5-objectives': ['Agree measurable AI objectives', 'AI objectives with owners, measures, targets and review dates', ['6.2']],
  'w6-policies-b': ['Implement AI lifecycle and data controls', 'AI development, validation, human oversight, data governance and supplier procedures', ['A.6','A.7','A.9','A.10']],
  'w7-policies-publish': ['Publish controlled AIMS documentation', 'Approved and versioned AIMS documented information', ['7.5']],
  'w7-awareness': ['Verify AI competence and awareness', 'Role-specific training, competence evaluation and communications', ['7.2','7.3','7.4']],
  'w8-programme': ['Approve an independent AIMS internal audit programme', 'Approved audit scope, criteria, competence and independence records', ['9.2']],
  'w8-first-audit': ['Conduct the AIMS internal audit', 'Completed internal audit report and findings against ISO 42001', ['9.2']],
  'w9-mrm': ['Conduct AIMS management review', 'Completed management review minutes, inputs, decisions and actions', ['9.3']],
  'w9-actions': ['Track improvement and corrective actions', 'Owned actions and verified effectiveness records', ['10.1','10.2']],
  'w10-pack': ['Prepare the ISO 42001 readiness evidence pack', 'AIMS scope, AI inventory, risks, impacts, SoA, audits, reviews and evidence manifest', ['7.5','9.1']],
  'w10-mock': ['Walk through AI governance and operating evidence', 'Recorded readiness walkthrough and outstanding issues', ['9.1']],
  'w10-fixes': ['Resolve priority AIMS readiness issues', 'Verified closure of priority readiness findings', ['10.2']],
  'w12-evidence': ['Demonstrate AI controls operating over the agreed period', 'Dated samples of monitoring, human oversight, validation, changes and incident handling', ['8.1','9.1']],
  'w12-handoff': ['Close the engagement and hand over AIMS operation', 'Certification decision, residual AI risks, owners and surveillance plan', ['9.1','10.1']],
  'continuous-calendar': ['Activate the AIMS operating calendar', 'Owned monitoring, review and audit activities', ['9.1','9.2','9.3']],
  'continuous-surveillance': ['Agree AIMS surveillance and continual improvement', 'Surveillance dates, ownership and improvement plan', ['10.1','10.2']],
};
function milestone(key, source) {
  const item = CONTENT[key];
  const result = { ...source, frameworkCode: 'iso42001' };
  if (item) Object.assign(result, { title: item[0], deliverables: item[1], clauses: item[2], clientTitle: item[1] });
  result.requirementRefs = (result.clauses || []).join(', ');
  // The engagement lead agrees an appropriate evidence period. ISO 42001 does
  // not prescribe the ISMS template's fixed three-month minimum.
  result.minimumDurationMonths = 0;
  if (key === 'gap-fieldwork-validation') result.acceptanceCriteria = 'Every ISO 42001 requirement is concluded; an independent reviewer approves and freezes the assessment and evidence snapshot.';
  if (key === 'gap-controlled-report') Object.assign(result, {
    skipDeliverable: false, completionMode: 'deliverable',
    deliverables: 'Controlled ISO 42001 gap assessment report',
    clientTitle: 'Independently approved ISO 42001 assessment report',
    acceptanceCriteria: 'Submit the reviewed assessment snapshot and report evidence; a different assigned approver accepts it, then explicitly publishes the report to the client.'
  });
  return result;
}
function phase(source) {
  const result = { ...source };
  if (source.key === 'context') Object.assign(result, { name: 'AI systems, context & impacts', description: 'Scoped AI systems, intended uses, affected parties and system impacts.' });
  if (source.key === 'assessment') result.description = 'AI risk and impact methods and lifecycle risk assessment.';
  if (source.key === 'continuous') result.description = 'Recurring AIMS operation, surveillance and continual improvement.';
  return result;
}

// The ISO 42001 report accepted for the current reviewed assessment, and its
// publication to the client. A report counts only while the evidence frozen at
// acceptance is still the evidence attached, its preparer and approver are
// different people, and it was accepted against the assessment as it now
// stands; publication counts only for that report and that approval.
function reportState(db, ws, state = require('./iso42001-assessment').getGapState(db, ws.id)) {
  const key = reportKey(ws);
  const plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id);
  const snapshotHash = state.snapshot?.snapshot_hash || state.snapshot?.hash || null;
  if (!key || !plan) return { plan: plan || null, report: null, publication: null, snapshotHash };
  const reports = db.prepare(`SELECT d.* FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    WHERE d.workspace_id=? AND d.plan_id=? AND m.milestone_key=? AND d.status='accepted' AND d.client_visible=1`).all(ws.id, plan.id, key);
  const report = reports.find(row => {
    let snapshot; try { snapshot = JSON.parse(row.evidence_snapshot_json || '{}'); } catch (_) { return false; }
    const currentEvidence = db.prepare(`SELECT e.id,e.sha256 FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id WHERE de.deliverable_id=? AND de.workspace_id=? AND e.workspace_id=? AND e.superseded_at IS NULL ORDER BY de.id`).all(row.id, ws.id, ws.id);
    const frozenEvidence = (snapshot.evidence || []).map(e => ({ id:e.id, sha256:e.sha256 }));
    return frozenEvidence.length > 0 && JSON.stringify(currentEvidence) === JSON.stringify(frozenEvidence)
      && row.accepted_by && row.submitted_by && row.accepted_by !== row.submitted_by
      && snapshot.assessment_hash === snapshotHash && snapshotHash && state.complete;
  }) || null;
  const publications = report ? db.prepare(`SELECT * FROM engagement_delivery_events WHERE plan_id=? AND action='aims_report_published' ORDER BY id DESC`).all(plan.id) : [];
  const publication = (report && publications.find(event => {
    try { const data = JSON.parse(event.details); return data.report_id === report.id && data.assessment_hash === snapshotHash && data.approval_hash === approvalHash(report); } catch (_) { return false; }
  })) || null;
  return { plan, report, publication, snapshotHash };
}

// Publish the accepted ISO 42001 report to the client. Only its approver may.
// `event` is the delivery engine's event writer, passed in to avoid a cycle.
function publishReport(db, ws, userId, plan, event) {
  const state = reportState(db, ws);
  if (!state.report) throw new Error('Independently accept the report for the current reviewed assessment first.');
  if (Number(state.report.accepted_by) !== Number(userId)) throw new Error('The independent report approver must publish the approved report.');
  if (!state.publication) {
    event(db, ws.id, plan.id, userId, 'deliverable', state.report.id, 'aims_report_published', 'accepted', 'published',
      { report_id: state.report.id, assessment_hash: state.snapshotHash, approval_hash: approvalHash(state.report) });
  }
  return reportState(db, ws);
}

function gapContext(db, ws) {
  const state = require('./iso42001-assessment').getGapState(db, ws.id);
  const { plan, report, publication, snapshotHash } = reportState(db, ws, state);
  const engagement = plan?.consulting_engagement_id ? db.prepare('SELECT * FROM consulting_engagements WHERE id=? AND workspace_id=?').get(plan.consulting_engagement_id, ws.id) : null;
  const events = plan ? db.prepare(`SELECT * FROM engagement_delivery_events WHERE plan_id=? AND action='aims_gap_closed' ORDER BY id DESC`).all(plan.id) : [];
  const openRequests = db.prepare(`SELECT COUNT(*) c FROM client_requests WHERE workspace_id=? AND status NOT IN ('accepted','cancelled')`).get(ws.id).c;
  const openWorkpapers = engagement ? db.prepare(`SELECT COUNT(*) c FROM consultant_workpapers WHERE engagement_id=? AND status NOT IN ('frozen','superseded')`).get(engagement.id).c : 0;
  const blockers = [...(state.blockers || [])];
  if (!state.complete && !blockers.length) blockers.push('Complete independent review of the ISO 42001 assessment.');
  if (!report) blockers.push('Independently accept the controlled report for the current reviewed assessment.');
  if (!publication) blockers.push('Publish the independently approved report to the client.');
  if (openRequests) blockers.push(`Accept or cancel ${openRequests} open ISO 42001 client requests.`);
  if (openWorkpapers) blockers.push(`Freeze or supersede ${openWorkpapers} open workpapers.`);
  const ready = blockers.length === 0;
  const closure = ready && events.find(event => {
    try { return event.action === 'aims_gap_closed' && JSON.parse(event.details).publication_id === publication.id; } catch (_) { return false; }
  });
  return { ...state, engagement, report, publication, snapshotHash, href: gapHref(ws),
    completed: { mobilisation: !!state.complete, fieldwork: !!state.complete, validation: !!state.complete, report: !!publication },
    closure: { ready, complete: !!closure, blockers, independentlyApprovedReports: publication ? 1 : 0 }
  };
}

function readiness(db, ws) {
  const rows = db.prepare(`SELECT i.id,i.type,cs.status,cs.applicability,cs.exclusion_justification
    FROM iso42001_items i LEFT JOIN v_iso42001_control_states cs ON cs.workspace_id=? AND cs.iso_item_id=i.id`).all(ws.id);
  const controlsReady = rows.length > 0 && rows.every(r => (r.status === 'Implemented' && (r.type === 'clause' || r.applicability === 'included'))
    || (r.type === 'control' && r.applicability === 'excluded' && String(r.exclusion_justification || '').trim()));
  // Audits, reviews and findings that belong to the AIMS, read the same way
  // the ISO 42001 readiness page reads them (lib/aims-shared-records.js).
  const audit = aimsShared.reportedAudits(db, ws);
  const review = aimsShared.heldReviews(db, ws);
  const gap = require('./iso42001-assessment').getGapState(db, ws.id);
  const openFindings = aimsShared.openNonconformities(db, ws);
  return { stage1Gate: [], stage2Ready: !!gap.complete && controlsReady && audit > 0 && review > 0 && openFindings === 0 };
}
function verification(db, ws, gap) {
  const result = {};
  if (gap.complete) result['gap-fieldwork-validation'] = { pass: true, reason: 'Independent assessment sign-off with frozen requirement and evidence snapshot', href: gap.href, assessment_hash: gap.snapshotHash };
  if (gap.completed.report) result['gap-controlled-report'] = { pass: true, reason: 'Independently approved report published to the client', href: gap.href, assessment_hash: gap.snapshotHash };
  // Other milestones must retain and accept their framework-specific evidence.
  return result;
}
// Binds the ISO 42001 report to the reviewed, frozen assessment when it is
// submitted and accepted. Applies to the report milestone of an ISO 42001-only
// plan and of a combined plan alike; every other deliverable passes through.
function reportDecision(db, ws, userId, row, action, snapshot) {
  if (!isReportMilestone(ws, row.source_rule)) return snapshot;
  const state = require('./iso42001-assessment').getGapState(db, ws.id);
  const snapshotHash = state.snapshot?.snapshot_hash || state.snapshot?.hash || null;
  if (!state.complete || !snapshotHash) throw new Error('Independently review and freeze the ISO 42001 assessment before submitting its report.');
  if (action === 'accept' && (!row.submitted_by || Number(row.submitted_by) === Number(userId) || Number(row.owner_id) === Number(userId))) throw new Error('A different assigned reviewer must approve the report.');
  if (!snapshot?.evidence?.length) throw new Error('Attach the controlled report before submitting or accepting it.');
  return { ...snapshot, assessment_hash: snapshotHash, assessment_pass_id: state.pass.id };
}
module.exports = { isAims, isCombined, reportKey, isReportMilestone, COMBINED_REPORT_MILESTONE, gapHref, milestone, phase,
  gapContext, reportState, publishReport, readiness, verification, reportDecision, digest, approvalHash };
