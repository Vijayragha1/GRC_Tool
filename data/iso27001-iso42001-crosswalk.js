'use strict';
// The firm's crosswalk between ISO/IEC 27001:2022 and ISO/IEC 42001:2023,
// seeded into requirement_mappings by lib/crosswalk-seed.js.
//
// A client certified to ISO 27001 already holds much of what an ISO 42001
// auditor asks for. The two standards share the harmonized management-system
// structure, so clauses 4 to 10 pair by number; ISO 42001 adds the AI system
// impact assessment (6.1.4 and 8.4), which has no ISO 27001 counterpart.
// Annex A controls pair only where the subjects genuinely overlap. The four
// A.5.x impact-assessment controls are deliberately unmapped for the same
// reason. The notes are the firm's own wording, not text from either standard.
//
// Identifiers are the clause numbers of ISO/IEC 27001:2022 (incl. Amd 1:2024)
// and ISO/IEC 42001:2023, and the Annex A control numbers of the same two
// editions. Each label was assigned by reading both control statements, not
// from the control titles.
//
// COVERAGE, per pair, is how much credit the ISO 27001 record earns:
//   full       - the ISO 27001 record satisfies the ISO 42001 requirement.
//                Nothing in this crosswalk is full: ISO 42001 scopes every
//                requirement to the AIMS and the AI system lifecycle, so the
//                record always has to be extended.
//   partial    - same subject and the same artefact, scoped to the AI systems.
//                The record is genuine partial credit and the note says what
//                has to be added.
//   supporting - the ISO 27001 record is an input to the ISO 42001 work, not
//                part of it. The subjects differ, or ISO 27001 covers one
//                slice of a wider requirement. No partial credit.
//
// CLAUSES: [clause number, coverage, note].
// CONTROLS: [ISO 42001 ref, ISO 27001 ref, coverage, note].

// The clauses pair one-to-one on the harmonized structure: the requirement is
// the same sentence with "information security management system" replaced by
// "AI management system", so the ISO 27001 process is reusable but the records
// have to cover the AIMS. That is partial throughout, never full.
const CLAUSES = [
  ['4.1', 'partial', 'Add the AI-specific issues: the organisation\'s roles for its AI systems, AI regulation, and societal expectations.'],
  ['4.2', 'partial', 'Add the people affected by AI system outputs, who may never use the systems.'],
  ['4.3', 'partial', 'Name the AI systems in scope; an ISMS scope rarely lists them.'],
  ['4.4', 'partial', 'The AIMS can share the ISMS processes, but must cover the AI system lifecycle.'],
  ['5.1', 'partial', 'Top management commitment must name responsible AI, not only information security.'],
  ['5.2', 'partial', 'A separate AI policy, or an information security policy extended to AI objectives and principles.'],
  ['5.3', 'partial', 'Assign the AI roles (system owners, oversight, impact assessment) alongside the security roles.'],
  ['6.1.1', 'partial', 'Risks and opportunities must include those arising from the AI systems themselves.'],
  ['6.1.2', 'partial', 'The methodology must rate AI risks for their consequences to individuals, groups and society, not only to the organisation.'],
  ['6.1.3', 'partial', 'Treatment must reference the ISO 42001 Annex A controls and produce a separate Statement of Applicability.'],
  ['6.2', 'partial', 'Set AI objectives; security objectives do not cover them.'],
  ['6.3', 'partial', 'The same change-planning process can serve both systems.'],
  ['7.1', 'partial', 'Resources must include the data, tooling, compute and people behind each AI system.'],
  ['7.2', 'partial', 'Competence must cover AI roles: model development, data work, oversight and impact assessment.'],
  ['7.3', 'partial', 'Awareness must cover the AI policy and each person\'s part in responsible AI.'],
  ['7.4', 'partial', 'Include communication about AI systems with users and affected people.'],
  ['7.5', 'partial', 'The same document control can govern AIMS records; add the AI-specific records to it.'],
  ['8.1', 'partial', 'Operational control must cover the AI system lifecycle stages.'],
  ['8.2', 'partial', 'Run AI risk assessments at planned intervals and on significant change to an AI system.'],
  ['8.3', 'partial', 'Implement the AI risk treatment plan and keep its results.'],
  ['9.1', 'partial', 'Monitor AI system performance, drift and fairness, not only security measures.'],
  ['9.2', 'partial', 'Audit the AIMS against ISO 42001; a combined programme needs auditors competent in both.'],
  ['9.3', 'partial', 'Management review must consider the AIMS inputs, including AI system performance and impact assessment results.'],
  ['10.1', 'partial', 'The same improvement process can serve both systems.'],
  ['10.2', 'partial', 'The same corrective action process can serve both systems; record which standard each nonconformity is raised against.'],
];

// Three pairs are supporting, not partial, because the two control statements
// ask for different artefacts:
//   A.4.6 is the register of people and competences an AI system depends on;
//     ISO 27001 A.6.3 is the delivery of awareness and training.
//   A.6.2.7 is technical documentation written for users, auditors and
//     regulators; ISO 27001 A.5.37 is internal operating procedures.
//   A.7.3 is dataset provenance, selection and the consent or licence basis;
//     ISO 27001 A.5.32 covers only the rights slice of that.
const CONTROLS = [
  ['ai-annex-a-2-2', 'annex-a.5.1', 'partial', 'The AI policy can sit in the policy framework, but must state the AI principles and objectives.'],
  ['ai-annex-a-2-3', 'annex-a.5.1', 'partial', 'Show how the AI policy aligns with the security, privacy and quality policies.'],
  ['ai-annex-a-2-4', 'annex-a.5.1', 'partial', 'The policy review cycle can cover the AI policy; record its own review.'],
  ['ai-annex-a-3-2', 'annex-a.5.2', 'partial', 'Extend the roles register to the AI roles.'],
  ['ai-annex-a-3-3', 'annex-a.6.8', 'partial', 'The event reporting channel can take AI concerns, which include concerns about harm to people, not only security events.'],
  ['ai-annex-a-4-2', 'annex-a.5.9', 'partial', 'The asset inventory can hold the AI system resources; record each against its AI system.'],
  ['ai-annex-a-4-3', 'annex-a.5.9', 'partial', 'List the datasets each AI system relies on, with their provenance.'],
  ['ai-annex-a-4-4', 'annex-a.5.9', 'partial', 'List the tools and frameworks used to build and run each AI system.'],
  ['ai-annex-a-4-5', 'annex-a.8.6', 'partial', 'Capacity management covers compute; record the compute behind each AI system.'],
  ['ai-annex-a-4-6', 'annex-a.6.3', 'supporting', 'Training records help; the AIMS needs the competences each AI system depends on.'],
  ['ai-annex-a-6-1-3', 'annex-a.8.25', 'partial', 'The secure development rules are the frame; the AI process must add the responsible-AI gates: oversight, training-data rules and who approves a release.'],
  ['ai-annex-a-6-2-2', 'annex-a.8.26', 'partial', 'Requirements must include the AI system\'s intended use, performance and fairness criteria.'],
  ['ai-annex-a-6-2-3', 'annex-a.8.25', 'partial', 'The development lifecycle can carry AI design records: model choice, data and training decisions.'],
  ['ai-annex-a-6-2-4', 'annex-a.8.29', 'partial', 'Acceptance testing must include AI verification and validation against the stated criteria.'],
  ['ai-annex-a-6-2-5', 'annex-a.8.32', 'partial', 'Change management can govern AI releases; record the deployment plan and its acceptance.'],
  ['ai-annex-a-6-2-6', 'annex-a.8.16', 'partial', 'Monitoring must watch model performance and drift, not only system health.'],
  ['ai-annex-a-6-2-7', 'annex-a.5.37', 'supporting', 'Operating procedures help; technical documentation must describe the AI system for its users and auditors.'],
  ['ai-annex-a-6-2-8', 'annex-a.8.15', 'partial', 'Logging can capture AI system events; decide which events matter for the system\'s outputs.'],
  ['ai-annex-a-7-3', 'annex-a.5.32', 'supporting', 'Rights to use acquired data are part of it; record how and where each dataset was obtained.'],
  ['ai-annex-a-8-4', 'annex-a.5.24', 'partial', 'The incident plan can cover AI incidents; add how affected people are told.'],
  ['ai-annex-a-8-4', 'annex-a.5.26', 'partial', 'Incident response can serve AI incidents; record what was communicated and to whom.'],
  ['ai-annex-a-9-4', 'annex-a.5.10', 'partial', 'The acceptable use rules are the frame; state each AI system\'s intended use and send any new use case back through impact assessment.'],
  ['ai-annex-a-10-2', 'annex-a.5.19', 'partial', 'Supplier security covers part of it; allocate AI lifecycle responsibilities with each party.'],
  ['ai-annex-a-10-3', 'annex-a.5.19', 'partial', 'Supplier reviews can cover AI suppliers; check that what they supply fits responsible AI use.'],
  ['ai-annex-a-10-3', 'annex-a.5.21', 'partial', 'The ICT supply chain controls apply to model, data and platform suppliers.'],
];

module.exports = { CLAUSES, CONTROLS };
