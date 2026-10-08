'use strict';
// The firm's crosswalk between ISO/IEC 27001:2022 and ISO/IEC 42001:2023,
// seeded into requirement_mappings by lib/crosswalk-seed.js.
//
// A client certified to ISO 27001 already holds much of what an ISO 42001
// auditor asks for. The two standards share the harmonized management-system
// structure, so clauses 4 to 10 pair by number; ISO 42001 adds the AI system
// impact assessment (6.1.4 and 8.4), which has no ISO 27001 counterpart.
// Annex A controls pair only where the subjects genuinely overlap. Every pair
// is partial: the ISO 27001 record is a starting point that has to be
// extended to the AI systems, and the note says how. The notes are the firm's
// own wording, not text from either standard.
//
// CLAUSES: [clause number, note]. CONTROLS: [ISO 42001 ref, ISO 27001 ref, note].

const CLAUSES = [
  ['4.1', 'Add the AI-specific issues: the organisation\'s roles for its AI systems, AI regulation, and societal expectations.'],
  ['4.2', 'Add the people affected by AI system outputs, who may never use the systems.'],
  ['4.3', 'Name the AI systems in scope; an ISMS scope rarely lists them.'],
  ['4.4', 'The AIMS can share the ISMS processes, but must cover the AI system lifecycle.'],
  ['5.1', 'Top management commitment must name responsible AI, not only information security.'],
  ['5.2', 'A separate AI policy, or an information security policy extended to AI objectives and principles.'],
  ['5.3', 'Assign the AI roles (system owners, oversight, impact assessment) alongside the security roles.'],
  ['6.1.1', 'Risks and opportunities must include those arising from the AI systems themselves.'],
  ['6.1.2', 'The methodology must rate AI risks for their consequences to individuals, groups and society, not only to the organisation.'],
  ['6.1.3', 'Treatment must reference the ISO 42001 Annex A controls and produce a separate Statement of Applicability.'],
  ['6.2', 'Set AI objectives; security objectives do not cover them.'],
  ['6.3', 'The same change-planning process can serve both systems.'],
  ['7.1', 'Resources must include the data, tooling, compute and people behind each AI system.'],
  ['7.2', 'Competence must cover AI roles: model development, data work, oversight and impact assessment.'],
  ['7.3', 'Awareness must cover the AI policy and each person\'s part in responsible AI.'],
  ['7.4', 'Include communication about AI systems with users and affected people.'],
  ['7.5', 'The same document control can govern AIMS records; add the AI-specific records to it.'],
  ['8.1', 'Operational control must cover the AI system lifecycle stages.'],
  ['8.2', 'Run AI risk assessments at planned intervals and on significant change to an AI system.'],
  ['8.3', 'Implement the AI risk treatment plan and keep its results.'],
  ['9.1', 'Monitor AI system performance, drift and fairness, not only security measures.'],
  ['9.2', 'Audit the AIMS against ISO 42001; a combined programme needs auditors competent in both.'],
  ['9.3', 'Management review must consider the AIMS inputs, including AI system performance and impact assessment results.'],
  ['10.1', 'The same improvement process can serve both systems.'],
  ['10.2', 'The same corrective action process can serve both systems; record which standard each nonconformity is raised against.'],
];

const CONTROLS = [
  ['ai-annex-a-2-2', 'annex-a.5.1', 'The AI policy can sit in the policy framework, but must state the AI principles and objectives.'],
  ['ai-annex-a-2-3', 'annex-a.5.1', 'Show how the AI policy aligns with the security, privacy and quality policies.'],
  ['ai-annex-a-2-4', 'annex-a.5.1', 'The policy review cycle can cover the AI policy; record its own review.'],
  ['ai-annex-a-3-2', 'annex-a.5.2', 'Extend the roles register to the AI roles.'],
  ['ai-annex-a-3-3', 'annex-a.6.8', 'The event reporting channel can take AI concerns, which include concerns about harm to people, not only security events.'],
  ['ai-annex-a-4-2', 'annex-a.5.9', 'The asset inventory can hold the AI system resources; record each against its AI system.'],
  ['ai-annex-a-4-3', 'annex-a.5.9', 'List the datasets each AI system relies on, with their provenance.'],
  ['ai-annex-a-4-4', 'annex-a.5.9', 'List the tools and frameworks used to build and run each AI system.'],
  ['ai-annex-a-4-5', 'annex-a.8.6', 'Capacity management covers compute; record the compute behind each AI system.'],
  ['ai-annex-a-4-6', 'annex-a.6.3', 'Training records help; the AIMS needs the competences each AI system depends on.'],
  ['ai-annex-a-6-2-2', 'annex-a.8.26', 'Requirements must include the AI system\'s intended use, performance and fairness criteria.'],
  ['ai-annex-a-6-2-3', 'annex-a.8.25', 'The development lifecycle can carry AI design records: model choice, data and training decisions.'],
  ['ai-annex-a-6-2-4', 'annex-a.8.29', 'Acceptance testing must include AI verification and validation against the stated criteria.'],
  ['ai-annex-a-6-2-5', 'annex-a.8.32', 'Change management can govern AI releases; record the deployment plan and its acceptance.'],
  ['ai-annex-a-6-2-6', 'annex-a.8.16', 'Monitoring must watch model performance and drift, not only system health.'],
  ['ai-annex-a-6-2-7', 'annex-a.5.37', 'Operating procedures help; technical documentation must describe the AI system for its users and auditors.'],
  ['ai-annex-a-6-2-8', 'annex-a.8.15', 'Logging can capture AI system events; decide which events matter for the system\'s outputs.'],
  ['ai-annex-a-7-3', 'annex-a.5.32', 'Rights to use acquired data are part of it; record how and where each dataset was obtained.'],
  ['ai-annex-a-8-4', 'annex-a.5.24', 'The incident plan can cover AI incidents; add how affected people are told.'],
  ['ai-annex-a-8-4', 'annex-a.5.26', 'Incident response can serve AI incidents; record what was communicated and to whom.'],
  ['ai-annex-a-10-2', 'annex-a.5.19', 'Supplier security covers part of it; allocate AI lifecycle responsibilities with each party.'],
  ['ai-annex-a-10-3', 'annex-a.5.19', 'Supplier reviews can cover AI suppliers; check that what they supply fits responsible AI use.'],
  ['ai-annex-a-10-3', 'annex-a.5.21', 'The ICT supply chain controls apply to model, data and platform suppliers.'],
];

module.exports = { CLAUSES, CONTROLS };
