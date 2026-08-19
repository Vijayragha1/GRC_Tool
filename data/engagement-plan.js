// 12-week engagement plan template. Mirrors the rhythm Schellman, A-LIGN,
// Bridewell, and DataGuard publish in their "roadmap to ISO 27001" playbooks.
// Each week has 1-3 milestones; each milestone tags the clauses it advances
// and the deliverables it produces. The consultant marks milestones complete;
// the dashboard reads the % done as engagement velocity.
//
// Edits to the template here propagate on next reseed/restart. Per-workspace
// completion is stored in engagement_plan_progress (workspace_id, milestone_id,
// completed_at, notes).

const PHASES = [
  {
    week: 1,
    phase: 'Kickoff & scope',
    milestones: [
      { id: 'w1-kickoff', title: 'Kickoff workshop with sponsor + ISMS coordinator',
        deliverables: 'Meeting minutes, attendance list, role acknowledgements',
        clauses: ['5.1', '5.3'] },
      { id: 'w1-intake', title: 'Complete the engagement intake (25 questions)',
        deliverables: 'Filled intake, draft scope statement applied to workspace',
        clauses: ['4.1', '4.3'] },
      { id: 'w1-stakeholders', title: 'Sign off the interested-parties register',
        deliverables: 'interested_parties register populated, sponsor sign-off',
        clauses: ['4.2'] },
    ],
  },
  {
    week: 2,
    phase: 'Assets & context',
    milestones: [
      { id: 'w2-assets', title: 'Asset register: identify the top 30-50 assets in scope',
        deliverables: 'Asset register with classification + owner per asset',
        clauses: ['A.5.9', 'A.5.10'] },
      { id: 'w2-crown', title: 'Confirm the crown-jewel assets (3 recommended minimum)',
        deliverables: 'Crown jewel list signed off; flagged in asset register',
        clauses: ['A.5.9'] },
    ],
  },
  {
    week: 3,
    phase: 'Risk methodology + assessment',
    milestones: [
      { id: 'w3-method', title: 'Document and approve risk methodology (likelihood/impact scales, acceptance criteria)',
        deliverables: 'Risk methodology document, approved by sponsor',
        clauses: ['6.1.2'] },
      { id: 'w3-risks', title: 'Perform risk assessment against assets and threat scenarios',
        deliverables: 'Risk register populated with at least 30 risks scored',
        clauses: ['6.1.2', '8.2'] },
    ],
  },
  {
    week: 4,
    phase: 'Risk treatment & SoA',
    milestones: [
      { id: 'w4-treatment', title: 'Risk treatment plan - owner, action, due date per risk',
        deliverables: 'RTP document (clause 6.1.3.e)',
        clauses: ['6.1.3', '8.3'] },
      { id: 'w4-soa', title: 'Statement of Applicability - applicability + justification per Annex A control',
        deliverables: 'SoA with metadata header (version, owner, approver, date)',
        clauses: ['6.1.3.d'] },
    ],
  },
  {
    week: 5,
    phase: 'Policies - leadership & planning',
    milestones: [
      { id: 'w5-policies-a', title: 'Draft top-management policies (information security policy, ISMS scope, objectives)',
        deliverables: 'Policies in document module, status: draft',
        clauses: ['5.2', '6.2', '7.5.1'] },
      { id: 'w5-objectives', title: 'Information-security objectives with measurement + targets',
        deliverables: 'Objectives register populated',
        clauses: ['6.2'] },
    ],
  },
  {
    week: 6,
    phase: 'Policies - operations',
    milestones: [
      { id: 'w6-policies-b', title: 'Draft operational policies (access control, supplier security, incident response)',
        deliverables: 'Policies in document module, status: in review',
        clauses: ['A.5.15', 'A.5.19', 'A.5.24'] },
    ],
  },
  {
    week: 7,
    phase: 'Policies - sign-off + awareness',
    milestones: [
      { id: 'w7-policies-publish', title: 'Approve and publish all mandatory documents',
        deliverables: 'All ~14 mandatory documents published, version 1.0',
        clauses: ['7.5'] },
      { id: 'w7-awareness', title: 'Awareness programme: comms + acknowledgement campaign',
        deliverables: 'Comms log, acknowledgement evidence',
        clauses: ['7.3', '7.4', 'A.6.3'] },
    ],
  },
  {
    week: 8,
    phase: 'Internal audit programme',
    milestones: [
      { id: 'w8-programme', title: 'Document the internal audit programme (3-year sampling plan)',
        deliverables: 'Audit programme document approved',
        clauses: ['9.2'] },
      { id: 'w8-first-audit', title: 'Conduct first internal audit (clauses 4-10 + sample of Annex A)',
        deliverables: 'Audit report with findings + nonconformities raised',
        clauses: ['9.2'] },
    ],
  },
  {
    week: 9,
    phase: 'Management review #1',
    milestones: [
      { id: 'w9-mrm', title: 'First management review meeting',
        deliverables: 'MRM minutes covering all 9.3.2 inputs',
        clauses: ['9.3'] },
      { id: 'w9-actions', title: 'Action items from review converted to tasks with owners + due dates',
        deliverables: 'Tasks created in tracker',
        clauses: ['9.3', '10.1'] },
    ],
  },
  {
    week: 10,
    phase: 'Stage 1 readiness',
    milestones: [
      { id: 'w10-pack', title: 'Generate Stage 1 readiness pack',
        deliverables: 'ZIP: SoA + RTP + audits + MRMs + parties + objectives + evidence manifest',
        clauses: ['7.5'] },
      { id: 'w10-mock', title: 'Mock Stage 1 walkthrough with sponsor',
        deliverables: 'Punch list of pre-audit fixes',
        clauses: [] },
      { id: 'w10-fixes', title: 'Close pre-audit fixes',
        deliverables: 'All P0/P1 punch-list items resolved',
        clauses: ['10.2'] },
    ],
  },
  {
    week: 11,
    phase: 'Stage 1 audit',
    milestones: [
      { id: 'w11-stage1', title: 'Stage 1 certification audit (documentation review)',
        deliverables: 'Certifier Stage 1 report; minor NCs catalogued',
        clauses: [] },
      { id: 'w11-remediation', title: 'Remediate Stage 1 minor NCs ahead of Stage 2',
        deliverables: 'Closed NCs with evidence; 3+ months operational evidence ready',
        clauses: ['10.2'] },
    ],
  },
  {
    week: 12,
    phase: 'Stage 2 readiness',
    milestones: [
      { id: 'w12-evidence', title: 'Confirm 3 months of operational evidence per critical control',
        deliverables: 'Evidence library coverage report - green on critical controls',
        minimumDurationMonths: 3,
        clauses: ['7.5', '9.1'] },
      { id: 'w12-handoff', title: 'Hand engagement to client for Stage 2 audit',
        deliverables: 'Handover pack: residual risks, year-1 surveillance plan',
        clauses: [] },
    ],
  },
];

// Client presentation is keyed by the stable milestone identifier, never by
// the consultant-facing deliverable string. These values are persisted on the
// deliverable when a plan is created, so subsequent wording changes are
// governed engagement data rather than brittle view-layer substitutions.
const CLIENT_PRESENTATION = {
  'w1-kickoff': 'Kick-off records and role acknowledgements',
  'w1-intake': 'Completed engagement intake and draft scope statement',
  'w1-stakeholders': 'Interested parties register and sponsor approval',
  'w2-assets': 'Asset register with classification and assigned owners',
  'w2-crown': 'Critical asset register approved',
  'w3-method': 'Approved risk assessment method',
  'w3-risks': 'Risk register completed and prioritised',
  'w4-treatment': 'Risk treatment plan',
  'w4-soa': 'Statement of Applicability approved',
  'w5-policies-a': 'Draft leadership and governance policies',
  'w5-objectives': 'Information security objectives agreed',
  'w6-policies-b': 'Operational policies ready for review',
  'w7-policies-publish': 'Required management-system documents approved',
  'w7-awareness': 'Communications and acknowledgement records',
  'w8-programme': 'Internal audit programme approved',
  'w8-first-audit': 'Internal audit report and findings',
  'w9-mrm': 'Management review minutes and decisions',
  'w9-actions': 'Improvement actions assigned and tracked',
  'w10-pack': 'Certification readiness evidence pack',
  'w10-mock': 'Pre-audit improvement actions',
  'w10-fixes': 'Priority pre-audit actions completed',
  'w11-stage1': 'Stage 1 audit report and findings',
  'w11-remediation': 'Audit findings closed and operating evidence ready',
  'w12-evidence': 'Evidence coverage report for priority controls',
  'w12-handoff': 'Ongoing assurance and surveillance plan',
};

function flatten() {
  const out = [];
  for (const ph of PHASES) {
    for (const m of ph.milestones) out.push({
      ...m,
      week: ph.week,
      phase: ph.phase,
      clientTitle: CLIENT_PRESENTATION[m.id] || m.deliverables || m.title,
      clientDescription: 'Provide this item for review and approval.',
      frameworkCode: 'iso27001',
      requirementRefs: (m.clauses || []).join(', '),
    });
  }
  return out;
}

module.exports = { PHASES, CLIENT_PRESENTATION, flatten };
