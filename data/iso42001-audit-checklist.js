'use strict';
// Standard ISO/IEC 42001 certification evidence checklist.
//
// Built from the standard's own structure: one entry for the certification
// application, one for each clause from 4.1 to 10.2, one for each of the 38
// Annex A controls, then the populations an auditor samples from and the
// samples themselves. Each entry says, in this product's words, what evidence
// shows the requirement is met; the wording follows the guidance the gap
// assessment gives for the same requirement (data/iso42001-content.js). No
// certification body's request list is its skeleton, and it carries no dates:
// a client's audit dates are the client's own.
//
// Stage rule, applied to every entry: Stage 1 holds the documents the auditor
// reads before fieldwork (scope, policy, methods, the SoA, objectives,
// procedures); Stage 2 holds the records that show the AI management system
// running (results, minutes, logs, completed assessments). Samples are taken
// during fieldwork. Most certification bodies expect one internal audit and one
// management review to be complete before Stage 2.
//
// Keys are stable and name the requirement: PRE- (before the audit), CL- (a
// clause), A- (an Annex A control), POP- (a population), SMP- (a sample). A
// later version updates a client's copy by key; see applyStandardChecklist in
// lib/iso42001-audit.js for what happens to entries a version drops.
//
//   key         stable reference shown to the consultant
//   stage       stage1 | stage2 | fieldwork
//   kind        evidence | policy | population | sample
//   refs        ISO 42001 catalogue ids the entry tests
//   title       what the auditor asks to see
//   checks      what the auditor looks for in it
//   population  for population entries backed by the AI system register: which
//               register listing answers it (lib/ai-systems.js POPULATIONS)

const VERSION = '2026.2';

const c = (n) => `ai-clause-${n}`;
const a = (n) => `ai-annex-a-${n.replace(/\./g, '-')}`;
const r = (key, stage, kind, refs, title, checks, extra = {}) => ({ key, stage, kind, refs, title, checks, ...extra });

const CHECKLIST = [
  // ------------------------------------------------------------ Before the audit
  r('PRE-APPLICATION', 'stage1', 'evidence', [c('4.3')], 'Signed certification application and audit agreement',
    'Signed by someone authorised to commit the organisation, naming the scope, the sites and the AI systems the audit will cover.'),

  // ------------------------------------------------------------ Clause 4: context
  r('CL-4.1', 'stage1', 'evidence', [c('4.1')], 'Internal and external issues that shape the AI management system, and the organisation\'s role for each AI system',
    'Issues specific to this organisation rather than generic ones, a role recorded for each AI system in scope, and a visible link from the issues to the risks that follow from them.'),
  r('CL-4.2', 'stage1', 'evidence', [c('4.2')], 'Interested parties, what they require of the AI management system, and which requirements are obligations',
    'People affected by AI outputs are listed alongside customers and regulators, legal and contractual obligations are marked, and each requirement is traced to a risk, objective or control.'),
  r('CL-4.3', 'stage1', 'policy', [c('4.3'), a('4.2')], 'AI management system scope statement, with version and approval',
    'Boundaries, units and locations, the AI systems in scope and the stages of their life cycle covered, AI use left outside with a reason, and agreement with the AI system inventory.'),
  r('CL-4.4', 'stage1', 'evidence', [c('4.4')], 'Overview of the processes that make up the AI management system and how they connect',
    'Each process has an owner and produces records the auditor can later sample, such as risk assessments, impact assessments, audits and reviews.'),

  // ------------------------------------------------------------ Clause 5: leadership
  r('CL-5.1', 'stage2', 'evidence', [c('5.1')], 'Records of top management directing and supporting the AI management system',
    'Attendance at management review, decisions on resources, acceptance of residual AI risks at the right level, and messages from leadership about responsible AI.'),
  r('CL-5.2', 'stage1', 'policy', [c('5.2'), a('2.2')], 'AI policy, dated and approved by top management',
    'Commitments suited to the organisation\'s AI activities, a framework for AI objectives, a commitment to improve, and approval at the level the organisation says it needs.'),
  r('CL-5.3', 'stage1', 'evidence', [c('5.3'), a('3.2')], 'Roles, responsibilities and authorities for the AI management system',
    'A roles matrix covering the management system and each AI system, with named people in post and who reports on the system\'s performance to top management.'),

  // ------------------------------------------------------------ Clause 6: planning
  r('CL-6.1.1', 'stage1', 'policy', [c('6.1.1')], 'How risks and opportunities for the AI management system itself are planned for',
    'A planning approach and a register of risks and opportunities for the management system, kept apart from the risks of individual AI systems, with actions planned against them.'),
  r('CL-6.1.2', 'stage1', 'policy', [c('6.1.2')], 'AI risk assessment method, with the criteria for judging and accepting risk',
    'Criteria written down before the assessments were done, consequences for individuals, groups and society as well as the organisation, and a method that gives consistent results when repeated.'),
  r('CL-6.1.3', 'stage1', 'policy', [c('6.1.3')], 'AI risk treatment plan and the Statement of Applicability',
    'Every Annex A control decided with a reason for inclusion or exclusion, each included control traced to a risk it treats, treatment owners and dates, and approval of the SoA.'),
  r('CL-6.1.4', 'stage1', 'policy', [c('6.1.4'), a('5.2')], 'AI system impact assessment method, and when an assessment is triggered',
    'Who assesses, what is considered, how the depth of assessment is set by the system\'s potential for harm, and the events that require an assessment to be redone.'),
  r('CL-6.2', 'stage1', 'evidence', [c('6.2')], 'AI objectives, each with a measure, a target, an owner and a plan',
    'Objectives consistent with the AI policy, measurable where practical, with the actions, resources and dates needed to reach them and how results will be judged.'),
  r('CL-6.3', 'stage1', 'policy', [c('6.3')], 'How changes to the AI management system are planned',
    'Changes are considered for their purpose and consequences before they are made, with resources and responsibilities assigned.'),

  // ------------------------------------------------------------ Clause 7: support
  r('CL-7.1', 'stage2', 'evidence', [c('7.1')], 'Records that the resources the AI management system needs have been provided',
    'Budget, people and tooling traced to the needs identified in planning, and management review judging whether they are enough.'),
  r('CL-7.2', 'stage2', 'evidence', [c('7.2'), a('4.6')], 'Competence required for each AI role, and records that people meet it',
    'Requirements per role, per person evidence of education, training or experience, and action taken where someone falls short.'),
  r('CL-7.3', 'stage2', 'evidence', [c('7.3')], 'Records that people know the AI policy and their part in the AI management system',
    'Awareness material, who has completed it, and staff able to explain what happens if they do not follow the AI policy.'),
  r('CL-7.4', 'stage2', 'evidence', [c('7.4')], 'What is communicated about the AI management system, to whom, when and by whom, and records it happened',
    'A communication plan covering internal and external audiences, including people affected by AI systems, and examples of communications that went out.'),
  r('CL-7.5', 'stage1', 'policy', [c('7.5')], 'How documented information is created, approved, stored and kept, including AI system records',
    'Version and approval control, access and retention rules that cover model documentation, datasets and evaluation reports as well as policies.'),

  // ------------------------------------------------------------ Clause 8: operation
  r('CL-8.1', 'stage2', 'evidence', [c('8.1')], 'Records that AI work is carried out as planned, including work done by others',
    'Life cycle processes being followed, criteria applied, unplanned changes reviewed, and outsourced AI work controlled through contracts and oversight.'),
  r('CL-8.2', 'stage2', 'evidence', [c('8.2')], 'Results of AI risk assessments, done on schedule and after significant change',
    'An assessment for each AI system in scope, dated, using the documented method, and repeated when a trigger occurred.'),
  r('CL-8.3', 'stage2', 'evidence', [c('8.3')], 'Results of AI risk treatment',
    'Treatment actions completed or tracked to a date, controls checked for effect, and residual risk accepted by the right person.'),
  r('CL-8.4', 'stage2', 'evidence', [c('8.4'), a('5.3')], 'Completed AI system impact assessments',
    'A current, approved assessment for each AI system in scope, refreshed when its trigger criteria were met, with findings carried into treatment.'),

  // ------------------------------------------------------------ Clause 9: performance evaluation
  r('CL-9.1', 'stage2', 'evidence', [c('9.1')], 'Monitoring and measurement results for the AI management system and its AI systems',
    'What is measured, how and how often, results against targets, and the analysis and action that followed when a threshold was crossed.'),
  r('CL-9.2', 'stage2', 'evidence', [c('9.2')], 'Internal audit programme and the results of internal audits',
    'A programme covering the whole scope over the cycle, auditors who did not audit their own work, reports with findings, and actions tracked to closure.'),
  r('CL-9.3', 'stage2', 'evidence', [c('9.3')], 'Management review minutes',
    'Every input the standard requires was considered, decisions on improvement and changes were made, and resulting actions can be traced to later records.'),

  // ------------------------------------------------------------ Clause 10: improvement
  r('CL-10.1', 'stage2', 'evidence', [c('10.1')], 'Records of continual improvement of the AI management system',
    'Improvements made in the last year, where they came from, and management review discussing whether the system remains suitable and effective.'),
  r('CL-10.2', 'stage2', 'evidence', [c('10.2')], 'Nonconformities, their causes and the corrective actions taken',
    'A log with root causes that go beyond human error, corrective actions with owners and dates, and a check that each action worked.'),

  // ------------------------------------------------------------ Annex A.2: policies related to AI
  r('A-2.2', 'stage2', 'evidence', [a('2.2'), c('5.2')], 'Records that the AI policy has reached the people it applies to',
    'Publication, training or acknowledgement records, and any public version saying the same as the internal one.'),
  r('A-2.3', 'stage1', 'policy', [a('2.3')], 'How the AI policy fits with the organisation\'s other policies',
    'A note or matrix showing where security, privacy, procurement, HR and quality policies were changed or cross-referenced to address AI.'),
  r('A-2.4', 'stage2', 'evidence', [a('2.4')], 'Reviews of the AI policy',
    'A review interval and triggers, records of reviews with the reviewer and the decisions taken, and the policy\'s version history.'),

  // ------------------------------------------------------------ Annex A.3: internal organisation
  r('A-3.2', 'stage2', 'evidence', [a('3.2'), c('5.3')], 'Decisions about AI systems taken by the people assigned to take them',
    'A named owner for each AI system, and recent approvals, suspensions or escalations that can be traced to the role responsible.'),
  r('A-3.3', 'stage2', 'evidence', [a('3.3')], 'How concerns about AI systems can be raised, and how raised concerns were handled',
    'A channel people know about, protection for those who use it, and a record of concerns received, looked into and closed.'),

  // ------------------------------------------------------------ Annex A.4: resources for AI systems
  r('A-4.2', 'stage2', 'evidence', [a('4.2')], 'Inventory of the resources behind each AI system',
    'Each AI system in scope listed with its data, tooling, computing and people, kept up to date and referred to by the risk register and the SoA.'),
  r('A-4.3', 'stage2', 'evidence', [a('4.3'), a('7.3')], 'Records of the data resources each AI system uses',
    'Dataset descriptions covering source, rights to use, known limitations and bias, for development and for operation.'),
  r('A-4.4', 'stage2', 'evidence', [a('4.4')], 'Records of the tools used to build and run each AI system',
    'Frameworks, libraries and platforms with versions, and any licence obligations that come with them.'),
  r('A-4.5', 'stage2', 'evidence', [a('4.5')], 'Records of the computing resources each AI system relies on',
    'Where each system runs, the capacity and reliability it needs, and the environmental footprint of the larger ones.'),
  r('A-4.6', 'stage2', 'evidence', [a('4.6'), c('7.2')], 'Records of the people and skills each AI system depends on',
    'Roles and competences needed across the system\'s life cycle, including people outside the organisation, linked to competence records.'),

  // ------------------------------------------------------------ Annex A.5: assessing impacts of AI systems
  r('A-5.2', 'stage1', 'policy', [a('5.2'), c('6.1.4')], 'The organisation\'s process for assessing the impact of AI systems',
    'An approved process with rules for when an assessment is needed and how deep it goes, linked to risk treatment and to reassessment.'),
  r('A-5.3', 'stage2', 'evidence', [a('5.3'), c('8.4')], 'Impact assessments recorded and kept for each AI system',
    'A substantive assessment for each system in scope, approved at the right level, kept for the period the organisation set.'),
  r('A-5.4', 'stage2', 'evidence', [a('5.4')], 'How each assessment considers the effect on individuals and groups',
    'Effects on the people who use the system and the people its outputs affect, fairness across groups where it applies, and attention to vulnerable people.'),
  r('A-5.5', 'stage2', 'evidence', [a('5.5')], 'How each assessment considers the effect on society',
    'Wider effects on communities, public services, the environment and trust, and a reasoned conclusion where none are expected.'),

  // ------------------------------------------------------------ Annex A.6: AI system life cycle
  r('A-6.1.2', 'stage1', 'policy', [a('6.1.2')], 'Objectives for developing AI systems responsibly',
    'Documented objectives that design reviews refer to, and a way of telling whether they are being met.'),
  r('A-6.1.3', 'stage1', 'policy', [a('6.1.3')], 'The process for designing and developing AI systems responsibly',
    'Defined stages and gates, the approvals needed at each, and checks that grow with the risk of the system.'),
  r('A-6.2.2', 'stage2', 'evidence', [a('6.2.2')], 'Requirements and specifications for each AI system',
    'Functional and responsible use requirements written down, and traced to the tests that show they are met.'),
  r('A-6.2.3', 'stage2', 'evidence', [a('6.2.3')], 'Design and development records for each AI system',
    'Design documents or model documentation, the reasons for significant choices, and the link from choices back to requirements.'),
  r('A-6.2.4', 'stage2', 'evidence', [a('6.2.4')], 'Verification and validation results for each AI system',
    'A test plan with acceptance thresholds set in advance, results against them, an approval decision, and retesting after retraining.'),
  r('A-6.2.5', 'stage2', 'evidence', [a('6.2.5')], 'Deployment records for each AI system',
    'Release criteria, a deployment plan, evidence the criteria were met before go live, and a way back if the release fails.'),
  r('A-6.2.6', 'stage2', 'evidence', [a('6.2.6')], 'Records of operating and monitoring each AI system',
    'Monitoring of performance and drift, what happens when an alert fires, and examples of action taken because of monitoring.'),
  r('A-6.2.7', 'stage2', 'evidence', [a('6.2.7')], 'Technical documentation for each AI system',
    'Documentation suited to each audience, kept in step with the system, and consistent with anything published about it.'),
  r('A-6.2.8', 'stage2', 'evidence', [a('6.2.8')], 'Event logging for each AI system',
    'What the system records and why, sample logs showing those events, and how long logs are kept and who can see them.'),

  // ------------------------------------------------------------ Annex A.7: data for AI systems
  r('A-7.2', 'stage1', 'policy', [a('7.2')], 'How data used to develop and improve AI systems is managed',
    'A data management process for AI, a named steward, and links to the privacy and security controls that also apply.'),
  r('A-7.3', 'stage2', 'evidence', [a('7.3')], 'Records of how each dataset was obtained',
    'Where each dataset came from, the rights or consent to use it, and why it was chosen.'),
  r('A-7.4', 'stage2', 'evidence', [a('7.4')], 'Data quality criteria and the results of checking them',
    'Quality criteria for each dataset, the checks run, and what was done about the problems found.'),
  r('A-7.5', 'stage2', 'evidence', [a('7.5')], 'Provenance records linking each model version to its data',
    'Enough lineage to say which data and transformations produced a given model version.'),
  r('A-7.6', 'stage2', 'evidence', [a('7.6')], 'Records of how data was prepared',
    'Cleaning, labelling and transformation steps for each dataset, labelling instructions, and checks that anonymisation worked.'),

  // ------------------------------------------------------------ Annex A.8: information for interested parties
  r('A-8.2', 'stage2', 'evidence', [a('8.2')], 'Information given to the users of each AI system',
    'Plain explanations of what the system does, where it can go wrong and its limits, with a way for users to give feedback.'),
  r('A-8.3', 'stage2', 'evidence', [a('8.3')], 'How outside parties can report adverse effects, and what happened to their reports',
    'A channel people outside the organisation can find, response times, and a record of reports and how they were resolved.'),
  r('A-8.4', 'stage1', 'policy', [a('8.4')], 'Plan for telling people about incidents involving AI systems',
    'Who is told, how quickly and by whom, with prepared wording, and evidence the plan has been exercised.'),
  r('A-8.5', 'stage2', 'evidence', [a('8.5')], 'Information about AI systems given to interested parties, and the decisions behind it',
    'What must be disclosed and what the organisation chooses to disclose, recent disclosures, and who approved them.'),

  // ------------------------------------------------------------ Annex A.9: use of AI systems
  r('A-9.2', 'stage1', 'policy', [a('9.2')], 'Processes for using AI systems responsibly',
    'How each AI system should be used, who may override it and how, and training for the people who use it.'),
  r('A-9.3', 'stage1', 'evidence', [a('9.3')], 'Objectives for using AI systems responsibly',
    'Objectives for use set for each system or class of systems, communicated to users, and checked for achievement.'),
  r('A-9.4', 'stage2', 'evidence', [a('9.4')], 'Records that AI systems are used as intended',
    'A statement of intended use for each system, approval before any new use, and monitoring of how the system is actually used.'),

  // ------------------------------------------------------------ Annex A.10: third party and customer relationships
  r('A-10.2', 'stage1', 'evidence', [a('10.2')], 'How responsibilities are shared with partners, suppliers and customers',
    'A responsibility split for each AI relationship, in a contract or appendix, consistent with the role recorded for each system.'),
  r('A-10.3', 'stage2', 'evidence', [a('10.3')], 'Selection and oversight of suppliers of AI models, data and services',
    'Suppliers with AI dependencies identified, checks before they were taken on, and ongoing reviews of changes they make.'),
  r('A-10.4', 'stage2', 'evidence', [a('10.4')], 'How customers\' needs and expectations are addressed',
    'Documentation given to customers, measures against misuse, and analysis of customer feedback and complaints.'),

  // ------------------------------------------------------------ Populations the auditor samples from
  r('POP-SYSTEMS', 'stage2', 'population', [a('4.2'), a('6.2.5')], 'List of the AI systems in scope, showing those put into use during the review period',
    'Complete against the scope statement, with each system\'s purpose, owner, life cycle stage and go live date.', { population: 'ai-systems' }),
  r('POP-SUPPLIERS', 'stage2', 'population', [a('10.3')], 'List of suppliers and partners involved in the life cycle of the AI systems in scope',
    'Every supplier of models, data, platforms or services to an AI system in scope, with the system each one serves.', { population: 'ai-vendors' }),
  r('POP-CHANGES', 'stage2', 'population', [c('6.3'), a('6.2.5')], 'List of changes made to AI systems during the review period',
    'Every change that touched an AI system in scope, including retraining and new versions, with its status and date.', { population: 'ai-changes' }),
  r('POP-INCIDENTS', 'stage2', 'population', [a('8.4'), c('10.2')], 'List of incidents involving AI systems during the review period',
    'Every incident an AI system caused or contributed to, with severity, status and the system concerned.', { population: 'ai-incidents' }),
  r('POP-PEOPLE', 'stage2', 'population', [c('7.2'), a('4.6')], 'List of people in AI roles, showing those who joined during the review period',
    'Everyone who builds, runs, oversees or assesses AI systems in scope, with their role and start date.'),
  r('POP-DATASETS', 'stage2', 'population', [a('7.3'), a('7.5')], 'List of the datasets used to develop or run the AI systems in scope',
    'Each dataset with its source, the systems that use it and when it was last changed.'),

  // ------------------------------------------------------------ Samples taken during fieldwork
  r('SMP-SYSTEMS', 'fieldwork', 'sample', [a('5.3'), a('6.2.4'), a('6.2.6')], 'For each sampled AI system: its impact assessment, risk assessment, test results and monitoring records',
    'Records for the sampled systems that agree with one another and with the register, current at the time of the audit.'),
  r('SMP-SUPPLIERS', 'fieldwork', 'sample', [a('10.2'), a('10.3')], 'For each sampled supplier: the agreement terms on AI responsibilities and the latest review',
    'Responsibilities written into the agreement, and a review carried out when it was due.'),
  r('SMP-CHANGES', 'fieldwork', 'sample', [c('6.3'), a('6.2.4'), a('6.2.5')], 'For each sampled change: the assessment of its effect, the testing and the approval to release',
    'Impact on the AI system considered before release, testing proportionate to the change, and approval by the right person.'),
  r('SMP-INCIDENTS', 'fieldwork', 'sample', [a('8.4'), c('10.2')], 'For each sampled incident: the record, who was told, and the corrective action',
    'Communication to affected people as the plan requires, a cause identified, and corrective action checked for effect.'),
  r('SMP-PEOPLE', 'fieldwork', 'sample', [c('7.2'), c('7.3')], 'For each sampled person: evidence of competence for the role and completed awareness training',
    'Competence evidence matching the role requirements, and awareness completed before or soon after starting.'),
  r('SMP-DATASETS', 'fieldwork', 'sample', [a('7.3'), a('7.4'), a('7.6')], 'For each sampled dataset: its acquisition record, quality checks and preparation steps',
    'Rights to use confirmed, quality criteria checked, and preparation steps recorded well enough to repeat.'),
];

module.exports = { VERSION, CHECKLIST };
