'use strict';

// Production legal catalog for a bounded DPDP Act gap assessment.
//
// The corpus deliberately contains assessable obligations only. It does not
// implement consent operations, rights handling, incident response, or a
// statutory Consent Manager platform. Dates for phases 2 and 3 are computed
// calendar anniversaries of the 13 November 2025 Gazette publication; the
// notification itself expresses them as relative one-year / eighteen-month
// periods.

const crypto = require('node:crypto');

const SCHEMA_VERSION = '1.0.0';
const CATALOG_VERSION = '2026.08.21';
const REVIEWED_AS_OF = '2026-08-21';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const SOURCES = [
  {
    id: 'dpdp-act-2023',
    type: 'act',
    title: 'Digital Personal Data Protection Act, 2023',
    identifier: 'Act No. 22 of 2023',
    publicationDate: '2023-08-11',
    url: 'https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf'
  },
  {
    id: 'dpdp-commencement-2025',
    type: 'commencement_notification',
    title: 'DPDP Act phased commencement notification',
    identifier: 'G.S.R. 843(E)',
    publicationDate: '2025-11-13',
    url: 'https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf'
  },
  {
    id: 'dpdp-rules-2025',
    type: 'rules',
    title: 'Digital Personal Data Protection Rules, 2025',
    identifier: 'G.S.R. 846(E)',
    publicationDate: '2025-11-13',
    url: 'https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf'
  },
  {
    id: 'dpdp-rules-corrigendum-2025',
    type: 'corrigendum',
    title: 'Corrigenda to the Digital Personal Data Protection Rules, 2025',
    identifier: 'G.S.R. 892(E)',
    publicationDate: '2025-12-11',
    url: 'https://egazette.gov.in/WriteReadData/2025/268455.pdf'
  }
];

const PHASES = [
  {
    id: 'phase_1_institutional',
    label: 'Institutional commencement',
    effectiveDate: '2025-11-13',
    dateBasis: 'Date of Gazette publication',
    provisions: 'Act s. 1(2), s. 2, ss. 18-26, s. 35, ss. 38-43, s. 44(1) and s. 44(3); Rules 1, 2 and 17-21'
  },
  {
    id: 'phase_2_consent_manager',
    label: 'Statutory Consent Manager registration',
    effectiveDate: '2026-11-13',
    dateBasis: 'Computed one-year anniversary of Gazette publication',
    provisions: 'Act s. 6(9) and s. 27(1)(d); Rule 4 and First Schedule'
  },
  {
    id: 'phase_3_substantive',
    label: 'Substantive Data Fiduciary obligations',
    effectiveDate: '2027-05-13',
    dateBasis: 'Computed eighteen-month anniversary of Gazette publication',
    provisions: 'Remaining substantive Act provisions and Rules 3, 5-16, 22 and 23'
  }
];

const PHASE_BY_ID = Object.fromEntries(PHASES.map(phase => [phase.id, phase]));

const DOMAINS = [
  { key: 'applicability_scope_accountability', label: 'Applicability, scope and accountability', order: 1 },
  { key: 'processing_grounds', label: 'Processing grounds', order: 2 },
  { key: 'notice_consent', label: 'Notice and consent', order: 3 },
  { key: 'fiduciary_processor_governance', label: 'Data Fiduciary and processor governance', order: 4 },
  { key: 'accuracy_sharing', label: 'Accuracy and sharing', order: 5 },
  { key: 'security_safeguards', label: 'Security safeguards', order: 6 },
  { key: 'breach_readiness', label: 'Personal data breach readiness', order: 7 },
  { key: 'retention_erasure', label: 'Retention and erasure', order: 8 },
  { key: 'children_guardians', label: 'Children and lawful guardians', order: 9 },
  { key: 'rights_grievances', label: 'Data Principal rights and grievances', order: 10 },
  { key: 'transfers_exemptions', label: 'Transfers, exemptions and regulatory cooperation', order: 11 },
  { key: 'significant_data_fiduciary', label: 'Significant Data Fiduciary', order: 12 },
  { key: 'statutory_consent_manager', label: 'Statutory Consent Manager', order: 13 }
];

function sourceRef(sourceId, ...provisions) {
  return { sourceId, provisions };
}

function obligation(input) {
  const phase = PHASE_BY_ID[input.phase];
  if (!phase) throw new Error(`Unknown DPDPA commencement phase: ${input.phase}`);
  return {
    id: input.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    ref: input.ref,
    title: input.title,
    domain: input.domain,
    sortOrder: input.sortOrder,
    sourceSectionRule: input.sourceSectionRule,
    sourceRefs: input.sourceRefs,
    legalStatus: {
      commencementPhase: phase.id,
      effectiveDate: phase.effectiveDate,
      commencementBasis: phase.dateBasis,
      transitionMarker: input.transitionMarker || (
        phase.id === 'phase_2_consent_manager'
          ? 'statutory_consent_manager_registration_transition'
          : 'substantive_dpdp_transition'
      )
    },
    applicability: {
      flags: input.flags,
      condition: input.condition,
      exclusions: input.exclusions || []
    },
    requirement: input.requirement,
    implementationGuidance: input.guidance,
    evidenceExpectations: input.evidence,
    severity: input.severity,
    weight: input.weight
  };
}

const OBLIGATIONS = [
  // 1. Applicability, scope and accountability
  obligation({
    ref: 'DPDPA-APP-01', domain: 'applicability_scope_accountability', sortOrder: 1,
    title: 'Determine territorial and material scope',
    sourceSectionRule: 'DPDP Act s. 3(a)-(b)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 3(a)', 's. 3(b)')], phase: 'phase_3_substantive',
    flags: ['digital_personal_data', 'processing_in_india', 'extraterritorial_offering'],
    condition: 'Applies to digital personal data processed in India, including data collected offline and digitised later, and to processing outside India connected with offering goods or services to Data Principals in India.',
    requirement: 'Maintain a defensible determination of which processing activities fall within the Act, including relevant offshore processing connected with Indian goods or services.',
    guidance: ['Inventory processing activities by collection form, digitisation point, processing location and Indian offering nexus.', 'Record the legal conclusion and owner for each included or out-of-scope activity.'],
    evidence: ['Approved applicability assessment.', 'Processing inventory showing collection form, locations and Indian offering nexus.', 'Periodic legal-scope review records.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-APP-02', domain: 'applicability_scope_accountability', sortOrder: 2,
    title: 'Substantiate statutory scope exclusions',
    sourceSectionRule: 'DPDP Act s. 3(c)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 3(c)')], phase: 'phase_3_substantive',
    flags: ['scope_exclusion', 'personal_domestic_use', 'publicly_available_data'],
    condition: 'Relevant only where processing is claimed to be personal or domestic, or the data was made public by the Data Principal or by another person under a legal obligation.',
    requirement: 'Apply the personal/domestic and publicly-available-data exclusions only when their statutory conditions are evidenced.',
    guidance: ['Require a recorded exclusion rationale rather than treating all internet-accessible data as excluded.', 'Retain the source and legal-publication basis for publicly available data.'],
    evidence: ['Exclusion register with decision owner and rationale.', 'Evidence of Data Principal publication or the publisher’s legal duty.', 'Revalidation records when the use or source changes.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-APP-03', domain: 'applicability_scope_accountability', sortOrder: 3,
    title: 'Identify processing roles and accountable Data Fiduciary',
    sourceSectionRule: 'DPDP Act s. 2(i)-(k) and s. 8(1)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 2(i)', 's. 2(j)', 's. 2(k)', 's. 8(1)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'data_processors_via_fiduciary', 'role_classification'],
    condition: 'Applies wherever a person determines purpose and means alone or jointly, or processes personal data on that person’s behalf.',
    requirement: 'Classify the Data Fiduciary, any joint decision-makers, Data Processors and Data Principals for every in-scope processing activity, and preserve Data Fiduciary accountability for processing done on its behalf.',
    guidance: ['Record role decisions at processing-activity and legal-entity level.', 'Resolve ambiguous joint decision-making before contracting or launch.'],
    evidence: ['Role and responsibility matrix.', 'Processing inventory linked to legal entities and processors.', 'Approved role analyses for complex arrangements.'],
    severity: 'critical', weight: 5
  }),

  // 2. Processing grounds
  obligation({
    ref: 'DPDPA-BAS-01', domain: 'processing_grounds', sortOrder: 4,
    title: 'Assign an authorised processing ground and lawful purpose',
    sourceSectionRule: 'DPDP Act s. 4',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 4(1)', 's. 4(2)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'consent_processing', 'certain_legitimate_use'],
    condition: 'Applies to every in-scope processing purpose.',
    requirement: 'Process personal data only for a purpose not expressly forbidden by law and on consent or a specific certain legitimate use in section 7.',
    guidance: ['Maintain a purpose-level ground register; do not reuse GDPR ground labels as DPDP grounds.', 'Block launch or continued use when no section 4 ground is approved.'],
    evidence: ['Processing register with purpose, ground, provision and approval.', 'Legal review for non-routine grounds.', 'Control showing unapproved purposes are remediated or stopped.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-BAS-02', domain: 'processing_grounds', sortOrder: 5,
    title: 'Constrain voluntarily provided data to the specified request',
    sourceSectionRule: 'DPDP Act s. 7(a)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 7(a)')], phase: 'phase_3_substantive',
    flags: ['certain_legitimate_use', 'voluntarily_provided_data'],
    condition: 'Applies when the Data Principal voluntarily provides data for a specified purpose and has not indicated non-consent to that use.',
    requirement: 'Use voluntarily provided personal data under section 7(a) only for the specified purpose requested or understood at collection and stop when the Data Principal indicates that the use is no longer wanted.',
    guidance: ['Capture the request context and stated purpose.', 'Prevent secondary marketing or analytics from inheriting this ground without a separate basis.'],
    evidence: ['Collection or request record.', 'Purpose-bound processing configuration.', 'Records of stop instructions and resulting cessation.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-BAS-03', domain: 'processing_grounds', sortOrder: 6,
    title: 'Map every other certain legitimate use to an exact statutory limb',
    sourceSectionRule: 'DPDP Act s. 7(b)-(i); Rule 5 and Second Schedule where applicable',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 7(b)', 's. 7(c)', 's. 7(d)', 's. 7(e)', 's. 7(f)', 's. 7(g)', 's. 7(h)', 's. 7(i)'), sourceRef('dpdp-rules-2025', 'Rule 5', 'Second Schedule')],
    phase: 'phase_3_substantive', flags: ['certain_legitimate_use', 'state_or_instrumentality', 'legal_mandate', 'emergency_public_interest', 'employment'],
    condition: 'Applies when relying on a State benefit/service use, State function, legal disclosure, judgment/order, medical emergency, public-health event, disaster/public-order event or employment use.',
    requirement: 'Document the exact section 7 limb, triggering facts and statutory limits for each certain legitimate use other than section 7(a).',
    guidance: ['Use a closed list of DPDP grounds and require evidence of the trigger.', 'For State processing under section 7(b), assess the Rule 5 and Second Schedule standards.'],
    evidence: ['Ground-specific decision record and supporting trigger evidence.', 'Employment-purpose or emergency-use procedure where relevant.', 'State-processing standards assessment where relevant.'],
    severity: 'critical', weight: 5
  }),

  // 3. Notice and consent
  obligation({
    ref: 'DPDPA-NTC-01', domain: 'notice_consent', sortOrder: 7,
    title: 'Give a standalone notice before or with a consent request',
    sourceSectionRule: 'DPDP Act s. 5(1); Rule 3',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 5(1)'), sourceRef('dpdp-rules-2025', 'Rule 3')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'notice_required'],
    condition: 'Applies whenever consent is requested for processing personal data.',
    requirement: 'Before or with the consent request, give an independently understandable notice that itemises personal data, specifies each purpose and describes the goods, services or uses enabled by the processing.',
    guidance: ['Generate notices from the approved purpose and data-item inventory.', 'Keep unrelated terms from obscuring the DPDP notice.'],
    evidence: ['Versioned notice rendered at the point of collection.', 'Notice-to-purpose and notice-to-data mapping.', 'Deployment and approval records.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-NTC-02', domain: 'notice_consent', sortOrder: 8,
    title: 'Include withdrawal, rights and Board-complaint routes in notices',
    sourceSectionRule: 'Rule 3(c)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 3(c)')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'notice_required', 'rights_channel'],
    condition: 'Applies to notices given by a Data Fiduciary.',
    requirement: 'State a specific website/app link and any other means through which the Data Principal may withdraw consent, exercise rights and complain to the Board.',
    guidance: ['Test every notice link and route before publication and after channel changes.', 'Keep withdrawal effort comparable to consent-giving effort.'],
    evidence: ['Notice versions containing working routes.', 'Link and journey test results.', 'Change records for rights or complaint channels.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-NTC-03', domain: 'notice_consent', sortOrder: 9,
    title: 'Notify legacy consent populations after commencement',
    sourceSectionRule: 'DPDP Act s. 5(2); Rule 3',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 5(2)'), sourceRef('dpdp-rules-2025', 'Rule 3')], phase: 'phase_3_substantive',
    flags: ['legacy_consent', 'notice_required'],
    condition: 'Applies where consent was obtained before section 5 commences and the processing continues.',
    requirement: 'As soon as reasonably practicable after commencement, give legacy consent populations the required notice and permit continued processing only until consent is withdrawn.',
    guidance: ['Identify all pre-commencement consent cohorts and schedule a provable notice campaign.', 'Track undelivered notices and alternate effective methods.'],
    evidence: ['Legacy-consent population reconciliation.', 'Campaign plan and dated delivery logs.', 'Exception and undeliverable remediation records.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-CNS-01', domain: 'notice_consent', sortOrder: 10,
    title: 'Obtain valid, affirmative and purpose-limited consent',
    sourceSectionRule: 'DPDP Act s. 6(1)-(2)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 6(1)', 's. 6(2)')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'data_minimisation'],
    condition: 'Applies whenever consent is the processing ground.',
    requirement: 'Ensure consent is free, specific, informed, unconditional, unambiguous, expressed by clear affirmative action and limited to personal data necessary for the specified purpose.',
    guidance: ['Separate purposes that are not necessary to the same service.', 'Reject pre-ticked, bundled or rights-waiving consent patterns.'],
    evidence: ['Consent design specification and approved purpose/data matrix.', 'Rendered consent journey and configuration.', 'Design review or test demonstrating affirmative action.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-CNS-02', domain: 'notice_consent', sortOrder: 11,
    title: 'Provide clear multilingual consent requests and an accountable contact',
    sourceSectionRule: 'DPDP Act s. 5(3) and s. 6(3)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 5(3)', 's. 6(3)')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'eighth_schedule_language', 'contact_information'],
    condition: 'Applies to consent requests and associated notices.',
    requirement: 'Present the consent request in clear and plain language, offer access in English or any Eighth Schedule language, and provide the DPO or authorised responder’s contact details.',
    guidance: ['Maintain controlled translations and equivalent content across supported languages.', 'Test readability, accessibility and contact routing.'],
    evidence: ['Approved multilingual content set and translation controls.', 'Accessibility/readability test results.', 'Published responder contact and routing test.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-CNS-03', domain: 'notice_consent', sortOrder: 12,
    title: 'Honour withdrawal and prove notice and consent',
    sourceSectionRule: 'DPDP Act s. 6(4)-(6) and s. 6(10)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 6(4)', 's. 6(5)', 's. 6(6)', 's. 6(10)')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'consent_withdrawal', 'burden_of_proof'],
    condition: 'Applies where processing is based on consent.',
    requirement: 'Enable withdrawal with effort comparable to giving consent, cease and cause processors to cease consent-based processing within a reasonable time unless another law or DPDP ground authorises it, and retain proof of the notice and valid consent.',
    guidance: ['Link withdrawal events to downstream systems and processors.', 'Preserve tamper-evident notice version, consent action, actor, purpose and timestamp evidence.'],
    evidence: ['Consent and withdrawal ledger.', 'Processor cessation instructions and confirmations.', 'Sample proof bundle reconstructing the notice and affirmative action.'],
    severity: 'critical', weight: 5
  }),

  // 4. Data Fiduciary and processor governance
  obligation({
    ref: 'DPDPA-GOV-01', domain: 'fiduciary_processor_governance', sortOrder: 13,
    title: 'Govern processors through valid contracts without displacing accountability',
    sourceSectionRule: 'DPDP Act s. 8(1)-(2)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(1)', 's. 8(2)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'data_processors_via_fiduciary'],
    condition: 'Applies when a Data Fiduciary engages another person to process personal data for an activity related to offering goods or services.',
    requirement: 'Use a valid processor contract and remain responsible for DPDP compliance for processing performed by the processor, irrespective of contrary agreement or a Data Principal’s failure to perform duties.',
    guidance: ['Maintain a processor register linked to signed contracts and processing activities.', 'Assign an internal owner for oversight, issues and exit.'],
    evidence: ['Processor inventory and executed contracts.', 'Accountability/RACI records.', 'Processor oversight, review and issue records.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-GOV-02', domain: 'fiduciary_processor_governance', sortOrder: 14,
    title: 'Operate technical and organisational compliance measures',
    sourceSectionRule: 'DPDP Act s. 8(4)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(4)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'governance_controls'],
    condition: 'Applies to every Data Fiduciary.',
    requirement: 'Implement technical and organisational measures that make observance of the Act and Rules effective in practice.',
    guidance: ['Map each applicable obligation to an owner, control, system and evidence source.', 'Test both design and operation rather than relying on policy statements alone.'],
    evidence: ['Approved DPDP control matrix and accountability map.', 'Operating control records and test results.', 'Management review and remediation tracking.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-GOV-03', domain: 'fiduciary_processor_governance', sortOrder: 15,
    title: 'Publish and repeat the responsible privacy contact',
    sourceSectionRule: 'DPDP Act s. 8(9); Rule 9',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(9)'), sourceRef('dpdp-rules-2025', 'Rule 9')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'contact_information'],
    condition: 'Applies to every Data Fiduciary; use DPO details where a DPO is applicable, otherwise an authorised responder.',
    requirement: 'Prominently publish the business contact information of the DPO or authorised responder on the website/app and include it in every response to a Data Principal rights communication.',
    guidance: ['Use a monitored role contact and documented escalation path.', 'Include the contact automatically in rights-response templates.'],
    evidence: ['Published website/app contact.', 'Rights-response templates and samples.', 'Mailbox monitoring and escalation records.'],
    severity: 'medium', weight: 3
  }),

  // 5. Accuracy and sharing
  obligation({
    ref: 'DPDPA-ACC-01', domain: 'accuracy_sharing', sortOrder: 16,
    title: 'Assure accuracy before decisions or disclosure',
    sourceSectionRule: 'DPDP Act s. 8(3)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(3)')], phase: 'phase_3_substantive',
    flags: ['decision_affecting_processing', 'sharing_with_data_fiduciary', 'data_quality'],
    condition: 'Applies where personal data is likely to be used for a decision affecting the Data Principal or disclosed to another Data Fiduciary.',
    requirement: 'Make reasonable arrangements to ensure the personal data is complete, accurate and consistent before the relevant decision or disclosure.',
    guidance: ['Define quality checks proportionate to decision or disclosure risk.', 'Route disputed, stale or incomplete data for correction before use.'],
    evidence: ['Data-quality standard and validation rules.', 'Pre-decision/disclosure check logs or samples.', 'Exception and correction records.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-SHR-01', domain: 'accuracy_sharing', sortOrder: 17,
    title: 'Maintain recipient and shared-data lineage',
    sourceSectionRule: 'DPDP Act s. 11(1)(b)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 11(1)(b)')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'personal_data_sharing', 'rights_response_dependency'],
    condition: 'Applies to sharing by a Data Fiduciary from which the Data Principal may request access information.',
    requirement: 'Retain sufficient lineage to identify every other Data Fiduciary and Data Processor with whom the personal data was shared and describe the personal data shared.',
    guidance: ['Record recipient legal entity, processor role, data categories, purpose and event or period.', 'Reconcile transfer logs with contracts and system integrations.'],
    evidence: ['Recipient and processor register.', 'Data-flow or sharing-event records.', 'Sample access response reconciled to source systems.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-SHR-02', domain: 'accuracy_sharing', sortOrder: 18,
    title: 'Evidence the authorised-investigation sharing exception',
    sourceSectionRule: 'DPDP Act s. 11(2)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 11(2)')], phase: 'phase_3_substantive',
    flags: ['authorised_law_enforcement_sharing', 'rights_response_exception'],
    condition: 'Applies only to sharing with a Data Fiduciary authorised by law, on its written request, for prevention, detection or investigation of offences or cyber incidents, or prosecution or punishment of offences.',
    requirement: 'Suppress recipient details from an access response under section 11(2) only when the authorised recipient, written-request and statutory-purpose conditions are all met and evidenced.',
    guidance: ['Legal-review each invocation and restrict exception visibility.', 'Do not convert the exception into a general law-enforcement or regulator exclusion.'],
    evidence: ['Written authorised request and authority verification.', 'Legal decision record citing section 11(2).', 'Access-response redaction log.'],
    severity: 'high', weight: 4
  }),

  // 6. Security safeguards
  obligation({
    ref: 'DPDPA-SEC-01', domain: 'security_safeguards', sortOrder: 19,
    title: 'Protect personal data with appropriate data-security techniques',
    sourceSectionRule: 'DPDP Act s. 8(5); Rule 6(1)(a)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(5)'), sourceRef('dpdp-rules-2025', 'Rule 6(1)(a)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'data_processors_via_fiduciary', 'security_safeguard'],
    condition: 'Applies to personal data in the Data Fiduciary’s possession or control, including processor activity.',
    requirement: 'Use appropriate measures such as encryption, obfuscation, masking or virtual tokens to protect personal data against breach.',
    guidance: ['Select techniques by data exposure, use case and threat model.', 'Control keys, token mappings and unmasking privileges separately.'],
    evidence: ['Data-protection standard and architecture.', 'Configuration or technical test evidence.', 'Key/token management and privileged-use records.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-SEC-02', domain: 'security_safeguards', sortOrder: 20,
    title: 'Control access to personal-data computer resources',
    sourceSectionRule: 'Rule 6(1)(b)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 6(1)(b)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'data_processors_via_fiduciary', 'access_control'],
    condition: 'Applies wherever the Data Fiduciary or processor uses computer resources to process personal data.',
    requirement: 'Implement appropriate access controls for computer resources used to process personal data.',
    guidance: ['Apply least privilege, strong authentication and timely lifecycle controls.', 'Include processor and service-account access in review scope.'],
    evidence: ['Access-control policy and role design.', 'Provisioning/deprovisioning samples and access reviews.', 'Authentication and privileged-access configurations.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-SEC-03', domain: 'security_safeguards', sortOrder: 21,
    title: 'Log, monitor, investigate and retain security visibility',
    sourceSectionRule: 'Rule 6(1)(c) and Rule 6(1)(e)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 6(1)(c)', 'Rule 6(1)(e)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'data_processors_via_fiduciary', 'security_logging'],
    condition: 'Applies to access and security events involving personal data.',
    requirement: 'Maintain access visibility through logs, monitoring and review sufficient to detect, investigate and remediate unauthorised access, prevent recurrence and support continued processing; retain relevant logs and personal data for one year unless another law requires otherwise.',
    guidance: ['Define log sources, review cadence, alerts and investigation ownership.', 'Protect log integrity and configure the one-year rule with documented legal exceptions.'],
    evidence: ['Logging/monitoring standard and source inventory.', 'Alert, investigation and remediation samples.', 'Retention configurations and integrity controls.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-SEC-04', domain: 'security_safeguards', sortOrder: 22,
    title: 'Maintain processing continuity and recoverability',
    sourceSectionRule: 'Rule 6(1)(d)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 6(1)(d)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'data_processors_via_fiduciary', 'resilience_backup'],
    condition: 'Applies where loss, destruction or compromise of confidentiality, integrity or availability could interrupt personal-data processing.',
    requirement: 'Take reasonable measures, including backups where appropriate, to continue or restore processing when personal data confidentiality, integrity or availability is compromised.',
    guidance: ['Set recovery requirements from processing criticality and data risk.', 'Test restoration, integrity and access control for backups.'],
    evidence: ['Continuity and backup design.', 'Restore and recovery test results.', 'Exception and remediation records.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-SEC-05', domain: 'security_safeguards', sortOrder: 23,
    title: 'Flow security safeguards to processors and assure operation',
    sourceSectionRule: 'Rule 6(1)(f)-(g)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 6(1)(f)', 'Rule 6(1)(g)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'data_processors_via_fiduciary', 'processor_contract_security'],
    condition: 'Applies where a Data Processor processes personal data for the Data Fiduciary.',
    requirement: 'Include appropriate contractual security-safeguard provisions and operate technical and organisational measures that ensure those safeguards are effectively observed.',
    guidance: ['Tailor clauses to the processing rather than relying on a generic confidentiality clause.', 'Obtain and evaluate evidence of processor control operation.'],
    evidence: ['Executed security clauses or data-processing agreement.', 'Processor assurance reviews and remediation.', 'Technical/organisational control test evidence.'],
    severity: 'critical', weight: 5
  }),

  // 7. Personal data breach readiness
  obligation({
    ref: 'DPDPA-BRH-01', domain: 'breach_readiness', sortOrder: 24,
    title: 'Detect and assess every personal data breach',
    sourceSectionRule: 'DPDP Act s. 2(u) and s. 8(6); Rule 7',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 2(u)', 's. 8(6)'), sourceRef('dpdp-rules-2025', 'Rule 7')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'personal_data_breach'],
    condition: 'Applies to unauthorised processing or accidental disclosure, acquisition, sharing, use, alteration, destruction or loss of access compromising confidentiality, integrity or availability.',
    requirement: 'Operate detection, escalation and assessment capable of identifying every personal data breach and recording the awareness time that starts notification duties.',
    guidance: ['Use the statutory breach definition without an unnotified materiality threshold.', 'Require processors and internal teams to escalate suspected events promptly.'],
    evidence: ['Breach procedure and classification criteria.', 'Processor escalation clauses and contact tree.', 'Incident register with awareness timestamps and assessment decisions.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-BRH-02', domain: 'breach_readiness', sortOrder: 25,
    title: 'Notify each affected Data Principal without delay',
    sourceSectionRule: 'DPDP Act s. 8(6); Rule 7(1)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(6)'), sourceRef('dpdp-rules-2025', 'Rule 7(1)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'personal_data_breach', 'affected_data_principal_notification'],
    condition: 'Applies on awareness of a personal data breach to each affected Data Principal.',
    requirement: 'Without delay, notify each affected Data Principal in concise, clear and plain language through the registered account or communication mode, covering nature, extent, timing, relevant consequences, mitigation, protective steps and responder contact.',
    guidance: ['Prepare channel-ready templates and an affected-person reconciliation process.', 'Record content known at send time and issue updates where needed.'],
    evidence: ['Approved notification template.', 'Affected-person roster and delivery logs.', 'Copy of notices and approval timeline.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-BRH-03', domain: 'breach_readiness', sortOrder: 26,
    title: 'Give the Board an initial breach intimation without delay',
    sourceSectionRule: 'DPDP Act s. 8(6); Rule 7(2)(a)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(6)'), sourceRef('dpdp-rules-2025', 'Rule 7(2)(a)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'personal_data_breach', 'board_notification'],
    condition: 'Applies on awareness of every personal data breach.',
    requirement: 'Without delay, intimate the Board of the breach description, nature, extent, timing, location and likely impact.',
    guidance: ['Designate submission authority and a fallback route if the digital portal is unavailable.', 'Do not wait for full root-cause analysis before the initial intimation.'],
    evidence: ['Initial Board-intimation template and approval matrix.', 'Submission receipt or equivalent proof.', 'Incident timeline showing awareness and intimation.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-BRH-04', domain: 'breach_readiness', sortOrder: 27,
    title: 'Complete the Board breach update within seventy-two hours',
    sourceSectionRule: 'Rule 7(2)(b)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 7(2)(b)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'personal_data_breach', 'board_notification', 'seventy_two_hour_deadline'],
    condition: 'Applies within seventy-two hours of awareness unless the Board allows a longer period on a written request.',
    requirement: 'Provide the Board updated details, facts and causes, mitigation, responsible-person findings if any, recurrence prevention and the affected-principal notification report within seventy-two hours, or obtain a Board-approved extension.',
    guidance: ['Run a visible statutory clock with named workstream owners.', 'Prepare a written extension request before expiry when completion is not possible.'],
    evidence: ['Detailed update and submission receipt.', 'Seventy-two-hour timeline and workstream records.', 'Extension request and Board approval where applicable.'],
    severity: 'critical', weight: 5
  }),

  // 8. Retention and erasure
  obligation({
    ref: 'DPDPA-RET-01', domain: 'retention_erasure', sortOrder: 28,
    title: 'Erase on withdrawal or purpose completion and cascade to processors',
    sourceSectionRule: 'DPDP Act s. 8(7)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(7)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'consent_withdrawal', 'purpose_completion', 'processor_erasure'],
    condition: 'Applies unless retention is necessary to comply with another law.',
    requirement: 'Erase personal data on consent withdrawal or when it is reasonable to assume the specified purpose is no longer served, whichever is earlier, and cause processors to erase data made available to them.',
    guidance: ['Tie each data set to purpose-completion and withdrawal triggers.', 'Automate downstream deletion while preserving documented legal holds.'],
    evidence: ['Purpose-based retention schedule.', 'Deletion jobs/tickets and processor confirmations.', 'Sample end-to-end erasure trace.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-RET-02', domain: 'retention_erasure', sortOrder: 29,
    title: 'Apply prescribed inactivity erasure and pre-erasure notice',
    sourceSectionRule: 'DPDP Act s. 8(8); Rule 8(1)-(2) and Third Schedule',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(8)'), sourceRef('dpdp-rules-2025', 'Rule 8(1)', 'Rule 8(2)', 'Third Schedule')], phase: 'phase_3_substantive',
    flags: ['large_platform_threshold', 'ecommerce', 'online_gaming', 'social_media'],
    condition: 'Applies to the specified purposes of e-commerce entities with at least two crore India users, online gaming intermediaries with at least fifty lakh India users, and social media intermediaries with at least two crore India users.',
    requirement: 'For applicable classes, use the prescribed three-year inactivity period, measured from the later statutory starting point, and warn the Data Principal at least forty-eight hours before erasure unless renewed contact or rights exercise interrupts the trigger.',
    guidance: ['Calculate and evidence threshold applicability and excluded account/token purposes.', 'Use a deterministic last-contact/rights-event clock and notification retry process.'],
    evidence: ['India-user threshold calculation.', 'Inactivity logic and excluded-purpose mapping.', 'Forty-eight-hour notices, delivery logs and erasure records.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-RET-03', domain: 'retention_erasure', sortOrder: 30,
    title: 'Retain processing, traffic and log records for the statutory minimum',
    sourceSectionRule: 'Rule 8(3) and Seventh Schedule',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 8(3)', 'Seventh Schedule')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'minimum_one_year_retention', 'regulatory_information_request'],
    condition: 'Applies to personal-data processing undertaken by or for a Data Fiduciary for the Seventh Schedule purposes.',
    requirement: 'Retain the personal data, associated traffic data and other processing logs for at least one year from processing, including at processors, before erasure unless another law or Government notification requires longer retention.',
    guidance: ['Model this minimum separately from business-purpose retention and security-log retention.', 'Reconcile processor retention and deletion settings.'],
    evidence: ['Retention schedule citing Rule 8(3).', 'System and processor retention configurations.', 'Deletion evidence after the applicable period.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-RET-04', domain: 'retention_erasure', sortOrder: 31,
    title: 'Govern legal-retention overrides and final deletion',
    sourceSectionRule: 'DPDP Act s. 8(7); Rule 6(1)(e) and Rule 8(3)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(7)'), sourceRef('dpdp-rules-2025', 'Rule 6(1)(e)', 'Rule 8(3)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'legal_hold', 'retention_exception'],
    condition: 'Applies where another law or Government notification requires retention beyond an ordinary erasure trigger or DPDP minimum.',
    requirement: 'Retain personal data beyond a DPDP erasure trigger only on a documented legal basis, limit the retained data and access to that basis, and erase when the overriding period ends.',
    guidance: ['Use approval, start/end dates and scope for every legal hold.', 'Review holds periodically and trigger provable release deletion.'],
    evidence: ['Legal-retention register and supporting law/notification.', 'Hold approvals and periodic reviews.', 'Hold-release and final-erasure records.'],
    severity: 'high', weight: 4
  }),

  // 9. Children and lawful guardians
  obligation({
    ref: 'DPDPA-CHD-01', domain: 'children_guardians', sortOrder: 32,
    title: 'Obtain verifiable parental consent before child-data processing',
    sourceSectionRule: 'DPDP Act s. 2(f), s. 9(1); Rule 10',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 2(f)', 's. 9(1)'), sourceRef('dpdp-rules-2025', 'Rule 10')], phase: 'phase_3_substantive',
    flags: ['child_data', 'under_eighteen', 'verifiable_parental_consent'],
    condition: 'Applies before processing personal data of an individual who has not completed eighteen years, unless a precise Fourth Schedule exception applies.',
    requirement: 'Use technical and organisational measures to obtain verifiable parental consent and check that the person identifying as parent is an identifiable adult using reliable held details or voluntarily supplied authorised-entity identity/age details or token.',
    guidance: ['Minimise age/identity data and support authorised virtual-token or DigiLocker-verified routes where used.', 'Retain the consent and adult-verification result without retaining unnecessary identity artefacts.'],
    evidence: ['Age-assurance and parent-verification design.', 'Consent and verification event records.', 'Privacy/security assessment of verification data.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-GRD-01', domain: 'children_guardians', sortOrder: 33,
    title: 'Verify lawful guardianship for relevant persons with disability',
    sourceSectionRule: 'DPDP Act s. 9(1); Rule 11',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 9(1)'), sourceRef('dpdp-rules-2025', 'Rule 11')], phase: 'phase_3_substantive',
    flags: ['person_with_disability', 'lawful_guardian', 'verifiable_guardian_consent'],
    condition: 'Applies before relying on a guardian’s consent for a person with disability who is unable to take legally binding decisions within Rule 11.',
    requirement: 'Verify that the individual claiming to be guardian was appointed by a court, designated authority or local level committee under the applicable guardianship law.',
    guidance: ['Use a trained review path and collect only necessary proof.', 'Distinguish supported decision-making from cases in which lawful guardian consent is required.'],
    evidence: ['Guardian-verification procedure.', 'Appointment proof and reviewer decision record.', 'Consent record linked to verified authority.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-CHD-02', domain: 'children_guardians', sortOrder: 34,
    title: 'Prevent processing detrimental to a child’s well-being',
    sourceSectionRule: 'DPDP Act s. 9(2)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 9(2)')], phase: 'phase_3_substantive',
    flags: ['child_data', 'child_wellbeing'],
    condition: 'Applies to all processing of child personal data; section 9(4) does not exempt section 9(2).',
    requirement: 'Do not undertake child-data processing that is likely to cause a detrimental effect on the child’s well-being.',
    guidance: ['Perform a child-specific harm assessment before launch and material change.', 'Block or redesign uses with unresolved detrimental-effect risk.'],
    evidence: ['Child-impact/harm assessment.', 'Product approval and mitigation records.', 'Monitoring, complaint and corrective-action evidence.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-CHD-03', domain: 'children_guardians', sortOrder: 35,
    title: 'Prohibit child tracking, behavioural monitoring and targeted advertising',
    sourceSectionRule: 'DPDP Act s. 9(3)-(4); Rule 12 and Fourth Schedule',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 9(3)', 's. 9(4)'), sourceRef('dpdp-rules-2025', 'Rule 12', 'Fourth Schedule'), sourceRef('dpdp-rules-corrigendum-2025', 'item (v)')], phase: 'phase_3_substantive',
    flags: ['child_data', 'tracking', 'behavioural_monitoring', 'targeted_advertising', 'conditional_exception'],
    condition: 'Applies unless the exact Data Fiduciary class/purpose and every condition in the corrected Fourth Schedule are satisfied.',
    requirement: 'Prevent tracking or behavioural monitoring of children and targeted advertising directed at children, and invoke a Fourth Schedule exception only within its narrow purpose and conditions.',
    guidance: ['Disable prohibited uses by age state across first- and third-party services.', 'Maintain an exception decision tied to the corrected Schedule text and necessity limit.'],
    evidence: ['Advertising/tracking configuration and vendor controls.', 'Technical tests using child accounts.', 'Approved Schedule exception record and condition evidence where used.'],
    severity: 'critical', weight: 5
  }),

  // 10. Data Principal rights and grievances
  obligation({
    ref: 'DPDPA-RGT-01', domain: 'rights_grievances', sortOrder: 36,
    title: 'Provide the required access information',
    sourceSectionRule: 'DPDP Act s. 11; Rule 14(1)-(2)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 11'), sourceRef('dpdp-rules-2025', 'Rule 14(1)', 'Rule 14(2)')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'data_principal_access_request'],
    condition: 'Applies to a request made to a Data Fiduciary to which the Data Principal previously gave consent, including consent within section 7(a).',
    requirement: 'On a valid request, provide a summary of personal data and processing activities, recipient Data Fiduciaries and Data Processors with descriptions of data shared, and other prescribed information, subject only to the section 11(2) exception.',
    guidance: ['Search all linked systems and reconcile sharing lineage.', 'Use a quality review before releasing the response.'],
    evidence: ['Access-request procedure and response template.', 'Completed request samples and source-system search record.', 'Recipient reconciliation and approval evidence.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-RGT-02', domain: 'rights_grievances', sortOrder: 37,
    title: 'Correct, complete, update or erase personal data on request',
    sourceSectionRule: 'DPDP Act s. 12; Rule 14(2)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 12'), sourceRef('dpdp-rules-2025', 'Rule 14(2)')], phase: 'phase_3_substantive',
    flags: ['consent_processing', 'correction_request', 'erasure_request'],
    condition: 'Applies to personal data processed on prior consent, including section 7(a), with erasure subject to specified-purpose or other-law retention.',
    requirement: 'On a valid request, correct inaccurate or misleading data, complete incomplete data, update data, or erase it unless retention is necessary for the specified purpose or another law.',
    guidance: ['Propagate approved changes or erasure to affected systems and processors.', 'Give a reasoned outcome when retention prevents erasure.'],
    evidence: ['Rights procedure and decision criteria.', 'Completed correction/erasure samples and downstream confirmations.', 'Documented retention basis for denied or limited erasure.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-RGT-03', domain: 'rights_grievances', sortOrder: 38,
    title: 'Publish usable rights-request means and identifiers',
    sourceSectionRule: 'Rule 14(1)-(2) and Rule 14(5)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 14(1)', 'Rule 14(2)', 'Rule 14(5)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'rights_channel', 'identity_verification'],
    condition: 'Applies to Data Fiduciaries and, where relevant, Consent Managers enabling rights exercise.',
    requirement: 'Prominently publish the means for making rights requests and the identifiers required under the terms of service, and accept requests through those means with only the stated identifying particulars.',
    guidance: ['Use proportionate identity verification and accessible request routes.', 'Keep published instructions aligned with actual intake validation.'],
    evidence: ['Published website/app rights instructions.', 'Configured intake fields and identity procedure.', 'Journey and accessibility test results.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-GRV-01', domain: 'rights_grievances', sortOrder: 39,
    title: 'Operate grievance redressal within a published period not exceeding ninety days',
    sourceSectionRule: 'DPDP Act s. 8(10) and s. 13; Rule 14(3)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 8(10)', 's. 13'), sourceRef('dpdp-rules-2025', 'Rule 14(3)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'grievance_redressal', 'ninety_day_cap'],
    condition: 'Applies to every Data Fiduciary and to Consent Managers for grievances about their DPDP obligations.',
    requirement: 'Provide readily available grievance means, publish a reasonable response period no longer than ninety days, and implement measures that make response within that period effective.',
    guidance: ['Set a shorter internal target with escalation before the published cap.', 'Track grievance exhaustion because Board complaints follow exhaustion of this opportunity.'],
    evidence: ['Published grievance period and procedure.', 'Grievance register, timestamps and response samples.', 'SLA monitoring and escalation records.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-NOM-01', domain: 'rights_grievances', sortOrder: 40,
    title: 'Enable nomination for post-death or incapacity rights exercise',
    sourceSectionRule: 'DPDP Act s. 14; Rule 14(4)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 14'), sourceRef('dpdp-rules-2025', 'Rule 14(4)')], phase: 'phase_3_substantive',
    flags: ['all_data_fiduciaries', 'nomination'],
    condition: 'Applies where a Data Principal chooses to nominate one or more individuals under the Data Fiduciary’s terms and applicable law.',
    requirement: 'Provide a means for the Data Principal to nominate one or more individuals to exercise her rights on death or incapacity and preserve the nomination for reliable future use.',
    guidance: ['Define nomination, change, revocation and activation checks.', 'Protect nomination data and avoid making nomination mandatory.'],
    evidence: ['Nomination terms and workflow.', 'Nomination/change records and security controls.', 'Activation and identity-verification procedure.'],
    severity: 'medium', weight: 3
  }),

  // 11. Transfers, exemptions and regulatory cooperation
  obligation({
    ref: 'DPDPA-TRX-01', domain: 'transfers_exemptions', sortOrder: 41,
    title: 'Control transfers against current Government restrictions and requirements',
    sourceSectionRule: 'DPDP Act s. 16; Rule 15',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 16'), sourceRef('dpdp-rules-2025', 'Rule 15')], phase: 'phase_3_substantive',
    flags: ['cross_border_transfer', 'government_order_dependency'],
    condition: 'Applies before and during transfer of personal data outside India; restrictions and foreign-State availability requirements depend on current Central Government notifications/orders.',
    requirement: 'Maintain transfer visibility and comply with every current country restriction and general or special requirement governing availability of personal data to a foreign State or its controlled person, entity or agency.',
    guidance: ['Do not hard-code universal localisation; maintain an updateable notification/order register.', 'Map hosting, support access, onward transfer and foreign-government exposure.'],
    evidence: ['Cross-border transfer register and data-flow map.', 'Current Government notification/order review.', 'Transfer control decisions and contractual/technical measures.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-EXM-01', domain: 'transfers_exemptions', sortOrder: 42,
    title: 'Apply case-specific statutory exemptions only to qualifying processing',
    sourceSectionRule: 'DPDP Act s. 17(1)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 17(1)')], phase: 'phase_3_substantive',
    flags: ['statutory_exemption', 'legal_claim', 'judicial_regulatory_function', 'offence_investigation', 'foreign_contract', 'corporate_transaction', 'loan_default'],
    condition: 'Applies only when the processing is necessary for one of the section 17(1) cases and only to the chapters/sections that section 17 disapplies.',
    requirement: 'Document necessity and the exact scope of any section 17(1) exemption, while continuing to meet the Data Fiduciary responsibility and security provisions that section 17 preserves.',
    guidance: ['Use matter-level legal approval, scope and expiry.', 'Do not convert a transactional exemption into an organisation-wide exemption.'],
    evidence: ['Exemption register and legal analysis.', 'Necessity evidence and processing boundary.', 'Expiry/review record and preserved-control mapping.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-EXM-02', domain: 'transfers_exemptions', sortOrder: 43,
    title: 'Meet the standards for research, archiving or statistical exemption',
    sourceSectionRule: 'DPDP Act s. 17(2)(b); Rule 16 and Second Schedule',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 17(2)(b)'), sourceRef('dpdp-rules-2025', 'Rule 16', 'Second Schedule')], phase: 'phase_3_substantive',
    flags: ['research_archiving_statistics', 'statutory_exemption'],
    condition: 'Applies only where processing is necessary for research, archiving or statistical purposes, is not used to take a decision specific to a Data Principal, and follows the Second Schedule standards.',
    requirement: 'Claim the research, archiving or statistical exemption only after confirming no individual-specific decision use and implementing the Second Schedule lawfulness, necessity, accuracy, retention, security and accountability standards.',
    guidance: ['Assess the project before processing and monitor downstream decision use.', 'Record purpose, minimum data, retention and safeguards.'],
    evidence: ['Project exemption assessment and approval.', 'Second Schedule control checklist.', 'Evidence preventing individual-specific decision use.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-REG-01', domain: 'transfers_exemptions', sortOrder: 44,
    title: 'Respond securely to authorised Government information orders',
    sourceSectionRule: 'DPDP Act s. 36; Rule 23 as corrected by G.S.R. 892(E)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 36'), sourceRef('dpdp-rules-2025', 'Rule 23', 'Seventh Schedule'), sourceRef('dpdp-rules-corrigendum-2025', 'item (iii)')], phase: 'phase_3_substantive',
    flags: ['regulatory_information_request', 'data_fiduciary', 'intermediary', 'restricted_disclosure'],
    condition: 'Applies when the corresponding authorised person calls for information for a Seventh Schedule purpose within the period specified in the order.',
    requirement: 'Authenticate, preserve and furnish information within the order’s period, and where directed for sovereignty, integrity or State-security reasons, do not disclose the furnishing without prior written permission.',
    guidance: ['Use a privileged intake, authority verification, legal review and evidence-preservation workflow.', 'Apply need-to-know controls to any non-disclosure direction.'],
    evidence: ['Order, authority verification and scope record.', 'Response package and proof of timely furnishing.', 'Non-disclosure direction, access log and permission records where applicable.'],
    severity: 'critical', weight: 5
  }),

  // 12. Significant Data Fiduciary
  obligation({
    ref: 'DPDPA-SDF-01', domain: 'significant_data_fiduciary', sortOrder: 45,
    title: 'Monitor and document Significant Data Fiduciary designation',
    sourceSectionRule: 'DPDP Act s. 10(1)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 10(1)')], phase: 'phase_3_substantive',
    flags: ['significant_data_fiduciary', 'government_notification_dependency'],
    condition: 'Applies when the Central Government notifies the Data Fiduciary or its class as a Significant Data Fiduciary.',
    requirement: 'Monitor official notifications, determine whether the legal entity or class is designated, and activate the additional Significant Data Fiduciary obligations from the applicable designation.',
    guidance: ['Track factors including data volume/sensitivity and risks, but do not self-designate as a substitute for notification.', 'Assign an owner for horizon scanning and activation.'],
    evidence: ['Official-notification register and applicability decision.', 'Designation activation plan.', 'Management acknowledgement and obligation mapping.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-SDF-02', domain: 'significant_data_fiduciary', sortOrder: 46,
    title: 'Appoint an India-based, governing-body-accountable DPO',
    sourceSectionRule: 'DPDP Act s. 10(2)(a)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 10(2)(a)')], phase: 'phase_3_substantive',
    flags: ['significant_data_fiduciary', 'data_protection_officer'],
    condition: 'Applies only to a notified Significant Data Fiduciary.',
    requirement: 'Appoint an individual DPO based in India who represents the SDF under the Act, reports to the board of directors or similar governing body, and is the grievance contact.',
    guidance: ['Document authority, resources, independence and escalation.', 'Align public contact and grievance routing to the appointee.'],
    evidence: ['DPO appointment and role description.', 'India-location and reporting-line evidence.', 'Governing-body reporting and grievance records.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-SDF-03', domain: 'significant_data_fiduciary', sortOrder: 47,
    title: 'Appoint an independent data auditor',
    sourceSectionRule: 'DPDP Act s. 10(2)(b)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 10(2)(b)')], phase: 'phase_3_substantive',
    flags: ['significant_data_fiduciary', 'independent_data_auditor'],
    condition: 'Applies only to a notified Significant Data Fiduciary.',
    requirement: 'Appoint an independent data auditor to evaluate the SDF’s compliance with the Act.',
    guidance: ['Define and assess independence, competence, scope and unrestricted evidence access.', 'Track audit issues to verified remediation.'],
    evidence: ['Appointment/engagement and independence assessment.', 'Auditor competence and scope record.', 'Audit reports and remediation closure evidence.'],
    severity: 'high', weight: 4
  }),
  obligation({
    ref: 'DPDPA-SDF-04', domain: 'significant_data_fiduciary', sortOrder: 48,
    title: 'Complete annual DPIA and audit and report significant observations',
    sourceSectionRule: 'DPDP Act s. 10(2)(c); Rule 13(1)-(2)',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 10(2)(c)'), sourceRef('dpdp-rules-2025', 'Rule 13(1)', 'Rule 13(2)')], phase: 'phase_3_substantive',
    flags: ['significant_data_fiduciary', 'annual_dpia', 'annual_audit', 'board_reporting'],
    condition: 'Applies every twelve months from the date of SDF notification or inclusion in a notified class.',
    requirement: 'Undertake a DPIA and compliance audit in each twelve-month period and cause the assessor/auditor to give the Board a report containing significant observations.',
    guidance: ['Anchor the due date to designation, not the calendar year.', 'Cover purpose, Data Principal rights, risks and mitigations and retain submission proof.'],
    evidence: ['DPIA and audit schedule tied to designation date.', 'Completed DPIA/audit and issue register.', 'Significant-observation report and Board submission evidence.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-SDF-05', domain: 'significant_data_fiduciary', sortOrder: 49,
    title: 'Assess algorithmic software risk to Data Principal rights',
    sourceSectionRule: 'Rule 13(3)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 13(3)')], phase: 'phase_3_substantive',
    flags: ['significant_data_fiduciary', 'algorithmic_software'],
    condition: 'Applies to technical measures, including algorithmic software, used by an SDF to host, display, upload, modify, publish, transmit, store, update or share personal data.',
    requirement: 'Exercise due diligence to verify that the relevant technical measures and algorithmic software are not likely to pose a risk to Data Principal rights.',
    guidance: ['Inventory affected algorithms and assess rights risk before deployment and material change.', 'Link unresolved risk to approval blocks and remediation.'],
    evidence: ['Algorithm inventory and rights-risk methodology.', 'Completed assessments and approvals.', 'Monitoring, change review and remediation records.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-SDF-06', domain: 'significant_data_fiduciary', sortOrder: 50,
    title: 'Localise Government-specified personal and traffic data',
    sourceSectionRule: 'Rule 13(4)-(5)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'Rule 13(4)', 'Rule 13(5)')], phase: 'phase_3_substantive',
    flags: ['significant_data_fiduciary', 'specified_data_localisation', 'government_specification_dependency'],
    condition: 'Applies only to personal data specified by the Central Government on committee recommendation and to traffic data pertaining to its flow.',
    requirement: 'For Government-specified data, ensure the personal data and traffic data pertaining to its flow are not transferred outside India.',
    guidance: ['Maintain an updateable specified-data register and trace data/traffic routing.', 'Apply technical residency and remote-access controls only to the notified scope.'],
    evidence: ['Government specification and applicability analysis.', 'Data/traffic flow and residency architecture.', 'Configuration, access and transfer test results.'],
    severity: 'critical', weight: 5
  }),

  // 13. Statutory Consent Manager (distinct from ordinary internal consent tooling)
  obligation({
    ref: 'DPDPA-CM-01', domain: 'statutory_consent_manager', sortOrder: 51,
    title: 'Meet registration eligibility and remain registered as a statutory Consent Manager',
    sourceSectionRule: 'DPDP Act s. 6(9); Rule 4 and First Schedule Part A',
    sourceRefs: [sourceRef('dpdp-act-2023', 's. 6(9)'), sourceRef('dpdp-rules-2025', 'Rule 4', 'First Schedule Part A')], phase: 'phase_2_consent_manager',
    flags: ['statutory_consent_manager', 'registration_required', 'india_incorporated_company'],
    condition: 'Applies only to a person seeking to act as the registered statutory Consent Manager defined by the Act, not to ordinary internal consent-management tooling.',
    requirement: 'Be an India-incorporated company, meet the technical, operational, financial, management, governance and independent-certification conditions including minimum net worth of two crore rupees, and obtain and maintain Board registration.',
    guidance: ['Treat statutory Consent Manager status as a separate regulated operating model.', 'Track Board standards and registration conditions as updateable dependencies.'],
    evidence: ['Certificate of incorporation, net-worth and management fitness evidence.', 'Independent platform certification and Board-standard assessment.', 'Registration application, decision and continuing-condition reviews.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-CM-02', domain: 'statutory_consent_manager', sortOrder: 52,
    title: 'Operate an interoperable consent platform without reading shared data',
    sourceSectionRule: 'First Schedule Part A item 9 and Part B items 1-2',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'First Schedule Part A item 9', 'First Schedule Part B item 1', 'First Schedule Part B item 2')], phase: 'phase_2_consent_manager',
    flags: ['statutory_consent_manager', 'interoperable_platform', 'data_content_blindness'],
    condition: 'Applies only to a registered statutory Consent Manager.',
    requirement: 'Enable Data Principals to give, manage, review and withdraw consent across onboarded Data Fiduciaries through the certified interoperable platform, while ensuring the Consent Manager cannot read the contents of personal data made available or shared.',
    guidance: ['Separate consent instructions and metadata from encrypted data transfer.', 'Test direct and routed-consent cases and content-blindness controls.'],
    evidence: ['Certified platform design and interoperability tests.', 'Consent-flow test records.', 'Cryptographic/technical evidence that data content is unreadable to the Consent Manager.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-CM-03', domain: 'statutory_consent_manager', sortOrder: 53,
    title: 'Keep accessible consent, notice and sharing records for seven years',
    sourceSectionRule: 'First Schedule Part B items 3-4',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'First Schedule Part B item 3', 'First Schedule Part B item 4')], phase: 'phase_2_consent_manager',
    flags: ['statutory_consent_manager', 'consent_records', 'seven_year_retention', 'machine_readable_export'],
    condition: 'Applies only to a registered statutory Consent Manager; a longer period may be agreed with the Data Principal or required by law.',
    requirement: 'Record consents given, denied or withdrawn, preceding/accompanying notices and personal-data sharing; give the Data Principal access and machine-readable export on request; retain the records for at least seven years.',
    guidance: ['Use tamper-evident event records with notice version and sharing lineage.', 'Test principal access/export and defensible deletion after the applicable period.'],
    evidence: ['Record schema and immutable event samples.', 'Principal access/export test results.', 'Seven-year retention and final-deletion configuration.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-CM-04', domain: 'statutory_consent_manager', sortOrder: 54,
    title: 'Perform Consent Manager obligations directly, securely and as fiduciary',
    sourceSectionRule: 'First Schedule Part B items 5-8',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'First Schedule Part B item 5', 'First Schedule Part B item 6', 'First Schedule Part B item 7', 'First Schedule Part B item 8')], phase: 'phase_2_consent_manager',
    flags: ['statutory_consent_manager', 'no_subcontracting', 'security_safeguards', 'fiduciary_capacity'],
    condition: 'Applies only to a registered statutory Consent Manager.',
    requirement: 'Provide services primarily through the Consent Manager website/app, do not subcontract or assign statutory obligations, take reasonable security safeguards and act in a fiduciary capacity toward the Data Principal.',
    guidance: ['Identify non-delegable obligations and constrain vendors to supporting services.', 'Apply security governance and decision criteria centred on Data Principal interests.'],
    evidence: ['Operating model and non-delegation analysis.', 'Vendor scope/contract review.', 'Security controls, incident records and fiduciary decision evidence.'],
    severity: 'critical', weight: 5
  }),
  obligation({
    ref: 'DPDPA-CM-05', domain: 'statutory_consent_manager', sortOrder: 55,
    title: 'Prevent conflicts and publish required ownership and management disclosures',
    sourceSectionRule: 'First Schedule Part B items 9-12, corrected by G.S.R. 892(E)',
    sourceRefs: [sourceRef('dpdp-rules-2025', 'First Schedule Part B item 9', 'First Schedule Part B item 10', 'First Schedule Part B item 11', 'First Schedule Part B item 12'), sourceRef('dpdp-rules-corrigendum-2025', 'item (iv)')], phase: 'phase_2_consent_manager',
    flags: ['statutory_consent_manager', 'conflict_of_interest', 'ownership_transparency', 'board_audit'],
    condition: 'Applies only to a registered statutory Consent Manager.',
    requirement: 'Avoid conflicts with Data Fiduciaries, prevent management/director financial or employment conflicts, publish the required promoter, director, management, shareholder and related-body information, and submit to Board audit and corrective directions.',
    guidance: ['Run appointment, periodic and event-driven conflict checks.', 'Keep public disclosures current and preserve Board-audit response evidence.'],
    evidence: ['Conflict policy, declarations and screening results.', 'Published ownership/management disclosures and change logs.', 'Board audit, direction and remediation records where applicable.'],
    severity: 'critical', weight: 5
  })
];

function parseAsOfDate(asOfDate) {
  let value = asOfDate;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('asOfDate must be a valid Date or YYYY-MM-DD string');
    value = value.toISOString().slice(0, 10);
  }
  value = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('asOfDate must be a valid Date or YYYY-MM-DD string');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError('asOfDate must be a valid Date or YYYY-MM-DD string');
  }
  return value;
}

function effectiveStatus(item, asOfDate) {
  if (!item?.legalStatus?.effectiveDate) throw new TypeError('item must contain legalStatus.effectiveDate');
  return parseAsOfDate(asOfDate) >= item.legalStatus.effectiveDate ? 'in_force' : 'future_effective';
}

function effectiveState(item, asOfDate) {
  return {
    status: effectiveStatus(item, asOfDate),
    asOfDate: parseAsOfDate(asOfDate),
    effectiveDate: item.legalStatus.effectiveDate,
    commencementPhase: item.legalStatus.commencementPhase,
    transitionMarker: item.legalStatus.transitionMarker || null
  };
}

function corpusPayload(input) {
  const metadata = input.metadata || input;
  return {
    schemaVersion: metadata.schemaVersion,
    version: metadata.version,
    reviewedAsOf: metadata.reviewedAsOf,
    sources: input.sources,
    phases: input.phases,
    domains: input.domains,
    obligations: input.obligations
  };
}

function computeContentHash(input) {
  return sha256(corpusPayload(input));
}

const CORPUS_BASIS = {
  metadata: { schemaVersion: SCHEMA_VERSION, version: CATALOG_VERSION, reviewedAsOf: REVIEWED_AS_OF },
  sources: SOURCES,
  phases: PHASES,
  domains: DOMAINS,
  obligations: OBLIGATIONS
};

const CONTENT_HASH = computeContentHash(CORPUS_BASIS);
const SOURCE_REFERENCE = 'Digital Personal Data Protection Act, 2023 (Act 22 of 2023); G.S.R. 843(E); G.S.R. 846(E), corrected by G.S.R. 892(E)';

const METADATA = {
  code: 'dpdpa',
  name: 'Digital Personal Data Protection Act, 2023 gap-assessment catalog',
  version: CATALOG_VERSION,
  schemaVersion: SCHEMA_VERSION,
  reviewedAsOf: REVIEWED_AS_OF,
  sourceReference: SOURCE_REFERENCE,
  obligationCount: OBLIGATIONS.length,
  domainCount: DOMAINS.length,
  hashAlgorithm: 'sha256',
  contentHash: CONTENT_HASH,
  effectiveDateNotice: 'Phase 2 and phase 3 calendar dates are computed anniversaries; G.S.R. 843(E) and Rule 1 state the legally controlling relative periods.',
  scopeNotice: 'Gap-assessment legal catalog only; this corpus is not a privacy-operations implementation or legal advice.'
};

const REQUIREMENTS = OBLIGATIONS.map(item => ({
  ref: item.ref,
  parentRef: item.domain,
  reqType: 'control',
  title: item.title,
  summary: item.requirement,
  guidance: item.implementationGuidance.join(' '),
  sortOrder: item.sortOrder,
  domain: item.domain,
  severity: item.severity,
  weight: item.weight,
  sourceSectionRule: item.sourceSectionRule,
  effectiveDate: item.legalStatus.effectiveDate,
  commencementPhase: item.legalStatus.commencementPhase
}));

function validateCatalog(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, expectedHash: null, actualHash: null, errors: ['catalog must be an object'] };
  }
  const expectedHash = candidate.contentHash || candidate.metadata?.contentHash || null;
  let actualHash = null;
  try {
    actualHash = computeContentHash(candidate);
  } catch (error) {
    errors.push(`content hash could not be computed: ${error.message}`);
  }
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) errors.push('catalog contentHash must be a lowercase SHA-256 digest');
  else if (actualHash !== expectedHash) errors.push('catalog contentHash does not match the canonical corpus');

  const domains = Array.isArray(candidate.domains) ? candidate.domains : [];
  const obligations = Array.isArray(candidate.obligations) ? candidate.obligations : [];
  if (candidate.metadata?.domainCount !== domains.length) errors.push('metadata.domainCount does not match domains');
  if (candidate.metadata?.obligationCount !== obligations.length) errors.push('metadata.obligationCount does not match obligations');

  const domainKeys = new Set(domains.map(domain => domain.key));
  const ids = new Set();
  const refs = new Set();
  for (const item of obligations) {
    if (!item.id || ids.has(item.id)) errors.push(`duplicate or missing obligation id: ${item.id || '<missing>'}`);
    if (!item.ref || refs.has(item.ref)) errors.push(`duplicate or missing obligation ref: ${item.ref || '<missing>'}`);
    if (!domainKeys.has(item.domain)) errors.push(`unknown obligation domain for ${item.ref || '<missing>'}`);
    if (!PHASE_BY_ID[item.legalStatus?.commencementPhase]) errors.push(`unknown commencement phase for ${item.ref || '<missing>'}`);
    ids.add(item.id);
    refs.add(item.ref);
  }
  return { valid: errors.length === 0, expectedHash, actualHash, errors };
}

function assertValidCatalog(candidate) {
  const result = validateCatalog(candidate);
  if (!result.valid) throw new Error(`Invalid DPDPA catalog: ${result.errors.join('; ')}`);
  return result;
}

const CATALOG = {
  metadata: METADATA,
  sources: SOURCES,
  phases: PHASES,
  domains: DOMAINS,
  obligations: OBLIGATIONS,
  requirements: REQUIREMENTS,
  contentHash: CONTENT_HASH,
  effectiveStatus,
  effectiveState,
  computeContentHash,
  validateCatalog,
  assertValidCatalog,
  stableStringify
};

assertValidCatalog(CATALOG);

module.exports = deepFreeze(CATALOG);
