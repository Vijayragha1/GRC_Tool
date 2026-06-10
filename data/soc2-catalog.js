// ============================================================================
// SOC 2: Trust Services Criteria (TSC) reference
// ----------------------------------------------------------------------------
// Purpose-built reference data for the SOC 2 audit-collaboration module.
// This is deliberately standalone: it does NOT reuse the ISO/CSF control
// catalogs or framework-mappings. The criteria here are the lookup targets a
// PBC request can be mapped to.
//
// Descriptions are concise paraphrases of each criterion's intent, NOT the
// verbatim AICPA TSC text (which is copyrighted). They exist to orient a
// consultant/client on what each criterion is about.
//
// Categories:
//   security             Common Criteria (CC1-CC9), required in every SOC 2
//   availability         A1
//   confidentiality      C1
//   processing_integrity PI1
//   privacy              P1-P8
// ============================================================================

const CATEGORIES = [
  {
    code: 'security',
    name: 'Security',
    short: 'Common Criteria',
    required: true,
    blurb: 'Information and systems are protected against unauthorized access, unauthorized disclosure, and damage. Always in scope for a SOC 2 report.',
  },
  {
    code: 'availability',
    name: 'Availability',
    short: 'A1',
    required: false,
    blurb: 'Information and systems are available for operation and use to meet the entity’s commitments and system requirements.',
  },
  {
    code: 'confidentiality',
    name: 'Confidentiality',
    short: 'C1',
    required: false,
    blurb: 'Information designated as confidential is protected to meet the entity’s commitments and system requirements.',
  },
  {
    code: 'processing_integrity',
    name: 'Processing Integrity',
    short: 'PI1',
    required: false,
    blurb: 'System processing is complete, valid, accurate, timely, and authorized to meet the entity’s objectives.',
  },
  {
    code: 'privacy',
    name: 'Privacy',
    short: 'P1-P8',
    required: false,
    blurb: 'Personal information is collected, used, retained, disclosed, and disposed of to meet the entity’s objectives.',
  },
];

// Group labels (the "CCx / A1 / PI1 / Px" headings within a category).
const GROUP_LABELS = {
  CC1: 'Control Environment',
  CC2: 'Communication and Information',
  CC3: 'Risk Assessment',
  CC4: 'Monitoring Activities',
  CC5: 'Control Activities',
  CC6: 'Logical and Physical Access Controls',
  CC7: 'System Operations',
  CC8: 'Change Management',
  CC9: 'Risk Mitigation',
  A1: 'Availability',
  C1: 'Confidentiality',
  PI1: 'Processing Integrity',
  P1: 'Notice and Communication of Objectives',
  P2: 'Choice and Consent',
  P3: 'Collection',
  P4: 'Use, Retention, and Disposal',
  P5: 'Access',
  P6: 'Disclosure and Notification',
  P7: 'Quality',
  P8: 'Monitoring and Enforcement',
};

const CRITERIA = [
  // ---- CC1 Control Environment --------------------------------------------
  { code: 'CC1.1', category: 'security', group: 'CC1', title: 'Commitment to integrity and ethical values', description: 'The entity demonstrates a commitment to integrity and ethical values.' },
  { code: 'CC1.2', category: 'security', group: 'CC1', title: 'Board independence and oversight', description: 'The board of directors operates independently of management and oversees the development and performance of internal control.' },
  { code: 'CC1.3', category: 'security', group: 'CC1', title: 'Structure, authority, and responsibility', description: 'Management establishes structures, reporting lines, and appropriate authorities and responsibilities in pursuit of objectives.' },
  { code: 'CC1.4', category: 'security', group: 'CC1', title: 'Commitment to competence', description: 'The entity demonstrates a commitment to attract, develop, and retain competent individuals in alignment with objectives.' },
  { code: 'CC1.5', category: 'security', group: 'CC1', title: 'Accountability', description: 'The entity holds individuals accountable for their internal control responsibilities in the pursuit of objectives.' },

  // ---- CC2 Communication and Information ----------------------------------
  { code: 'CC2.1', category: 'security', group: 'CC2', title: 'Quality information for internal control', description: 'The entity obtains or generates and uses relevant, quality information to support the functioning of internal control.' },
  { code: 'CC2.2', category: 'security', group: 'CC2', title: 'Internal communication', description: 'The entity internally communicates information, including objectives and responsibilities for internal control, necessary to support its functioning.' },
  { code: 'CC2.3', category: 'security', group: 'CC2', title: 'External communication', description: 'The entity communicates with external parties about matters affecting the functioning of internal control.' },

  // ---- CC3 Risk Assessment ------------------------------------------------
  { code: 'CC3.1', category: 'security', group: 'CC3', title: 'Objectives specified clearly', description: 'The entity specifies objectives with sufficient clarity to enable the identification and assessment of risks relating to them.' },
  { code: 'CC3.2', category: 'security', group: 'CC3', title: 'Risk identification and analysis', description: 'The entity identifies risks to the achievement of its objectives and analyzes them as a basis for determining how they should be managed.' },
  { code: 'CC3.3', category: 'security', group: 'CC3', title: 'Fraud risk', description: 'The entity considers the potential for fraud in assessing risks to the achievement of objectives.' },
  { code: 'CC3.4', category: 'security', group: 'CC3', title: 'Assessing change', description: 'The entity identifies and assesses changes that could significantly impact the system of internal control.' },

  // ---- CC4 Monitoring Activities ------------------------------------------
  { code: 'CC4.1', category: 'security', group: 'CC4', title: 'Ongoing and separate evaluations', description: 'The entity selects, develops, and performs ongoing and/or separate evaluations to ascertain whether the components of internal control are present and functioning.' },
  { code: 'CC4.2', category: 'security', group: 'CC4', title: 'Communicating deficiencies', description: 'The entity evaluates and communicates internal control deficiencies in a timely manner to those responsible for taking corrective action.' },

  // ---- CC5 Control Activities ---------------------------------------------
  { code: 'CC5.1', category: 'security', group: 'CC5', title: 'Selecting control activities', description: 'The entity selects and develops control activities that contribute to the mitigation of risks to the achievement of objectives to acceptable levels.' },
  { code: 'CC5.2', category: 'security', group: 'CC5', title: 'Technology general controls', description: 'The entity selects and develops general control activities over technology to support the achievement of objectives.' },
  { code: 'CC5.3', category: 'security', group: 'CC5', title: 'Deployment through policies', description: 'The entity deploys control activities through policies that establish what is expected and procedures that put policies into action.' },

  // ---- CC6 Logical and Physical Access Controls ---------------------------
  { code: 'CC6.1', category: 'security', group: 'CC6', title: 'Logical access security', description: 'The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events.' },
  { code: 'CC6.2', category: 'security', group: 'CC6', title: 'User registration and authorization', description: 'Prior to issuing system credentials, the entity registers and authorizes new internal and external users; credentials are removed when access is no longer required.' },
  { code: 'CC6.3', category: 'security', group: 'CC6', title: 'Access based on roles and least privilege', description: 'The entity authorizes, modifies, or removes access to data, software, functions, and other protected assets based on roles, responsibilities, least privilege, and segregation of duties.' },
  { code: 'CC6.4', category: 'security', group: 'CC6', title: 'Physical access', description: 'The entity restricts physical access to facilities and protected information assets to authorized personnel.' },
  { code: 'CC6.5', category: 'security', group: 'CC6', title: 'Secure disposal of physical assets', description: 'The entity discontinues logical and physical protections over physical assets only after the ability to read or recover data has been diminished and is no longer required.' },
  { code: 'CC6.6', category: 'security', group: 'CC6', title: 'Boundary protection', description: 'The entity implements logical access security measures to protect against threats from sources outside its system boundaries.' },
  { code: 'CC6.7', category: 'security', group: 'CC6', title: 'Information in transit and on removable media', description: 'The entity restricts the transmission, movement, and removal of information to authorized users and processes, and protects it during transmission, movement, or removal.' },
  { code: 'CC6.8', category: 'security', group: 'CC6', title: 'Malicious software', description: 'The entity implements controls to prevent or detect and act upon the introduction of unauthorized or malicious software.' },

  // ---- CC7 System Operations ----------------------------------------------
  { code: 'CC7.1', category: 'security', group: 'CC7', title: 'Vulnerability detection', description: 'The entity uses detection and monitoring procedures to identify changes to configurations that introduce new vulnerabilities and susceptibilities to newly discovered vulnerabilities.' },
  { code: 'CC7.2', category: 'security', group: 'CC7', title: 'Monitoring for anomalies', description: 'The entity monitors system components and the operation of those components for anomalies indicative of malicious acts, natural disasters, and errors affecting its ability to meet objectives.' },
  { code: 'CC7.3', category: 'security', group: 'CC7', title: 'Evaluating security events', description: 'The entity evaluates security events to determine whether they could or have resulted in a failure to meet objectives (security incidents) and, if so, takes action.' },
  { code: 'CC7.4', category: 'security', group: 'CC7', title: 'Incident response', description: 'The entity responds to identified security incidents by executing a defined incident-response program to understand, contain, remediate, and communicate them.' },
  { code: 'CC7.5', category: 'security', group: 'CC7', title: 'Recovery from incidents', description: 'The entity identifies, develops, and implements activities to recover from identified security incidents.' },

  // ---- CC8 Change Management ----------------------------------------------
  { code: 'CC8.1', category: 'security', group: 'CC8', title: 'Change management', description: 'The entity authorizes, designs, develops or acquires, configures, documents, tests, approves, and implements changes to infrastructure, data, software, and procedures to meet its objectives.' },

  // ---- CC9 Risk Mitigation ------------------------------------------------
  { code: 'CC9.1', category: 'security', group: 'CC9', title: 'Business disruption risk', description: 'The entity identifies, selects, and develops risk mitigation activities for risks arising from potential business disruptions.' },
  { code: 'CC9.2', category: 'security', group: 'CC9', title: 'Vendor and partner risk', description: 'The entity assesses and manages risks associated with vendors and business partners.' },

  // ---- A1 Availability ----------------------------------------------------
  { code: 'A1.1', category: 'availability', group: 'A1', title: 'Capacity management', description: 'The entity maintains, monitors, and evaluates current processing capacity and use of system components to manage capacity demand and to enable the implementation of additional capacity.' },
  { code: 'A1.2', category: 'availability', group: 'A1', title: 'Environmental protection and backup', description: 'The entity authorizes, designs, develops or acquires, implements, operates, approves, maintains, and monitors environmental protections, software, data backup processes, and recovery infrastructure to meet its availability objectives.' },
  { code: 'A1.3', category: 'availability', group: 'A1', title: 'Recovery testing', description: 'The entity tests recovery plan procedures supporting system recovery to meet its availability objectives.' },

  // ---- C1 Confidentiality -------------------------------------------------
  { code: 'C1.1', category: 'confidentiality', group: 'C1', title: 'Identifying confidential information', description: 'The entity identifies and maintains confidential information to meet its objectives related to confidentiality.' },
  { code: 'C1.2', category: 'confidentiality', group: 'C1', title: 'Disposing of confidential information', description: 'The entity disposes of confidential information to meet its objectives related to confidentiality.' },

  // ---- PI1 Processing Integrity -------------------------------------------
  { code: 'PI1.1', category: 'processing_integrity', group: 'PI1', title: 'Quality information about processing', description: 'The entity obtains or generates, uses, and communicates relevant, quality information regarding the objectives related to processing to support the use of products and services.' },
  { code: 'PI1.2', category: 'processing_integrity', group: 'PI1', title: 'Inputs are complete and accurate', description: 'The entity implements policies and procedures over system inputs, including controls over completeness and accuracy, to result in products, services, and reporting that meet the entity’s objectives.' },
  { code: 'PI1.3', category: 'processing_integrity', group: 'PI1', title: 'Processing meets specifications', description: 'The entity implements policies and procedures over system processing to result in products, services, and reporting that meet the entity’s objectives.' },
  { code: 'PI1.4', category: 'processing_integrity', group: 'PI1', title: 'Outputs are complete and accurate', description: 'The entity implements policies and procedures to make available or deliver output completely, accurately, and timely in accordance with specifications.' },
  { code: 'PI1.5', category: 'processing_integrity', group: 'PI1', title: 'Storage of inputs and outputs', description: 'The entity implements policies and procedures to store inputs, items in processing, and outputs completely, accurately, and timely in accordance with specifications.' },

  // ---- P1 Notice ----------------------------------------------------------
  { code: 'P1.1', category: 'privacy', group: 'P1', title: 'Privacy notice', description: 'The entity provides notice to data subjects about its privacy practices to meet its objectives related to privacy.' },

  // ---- P2 Choice and Consent ----------------------------------------------
  { code: 'P2.1', category: 'privacy', group: 'P2', title: 'Choice and consent', description: 'The entity communicates choices available regarding the collection, use, retention, disclosure, and disposal of personal information and obtains consent, to meet its objectives related to privacy.' },

  // ---- P3 Collection ------------------------------------------------------
  { code: 'P3.1', category: 'privacy', group: 'P3', title: 'Consistent collection', description: 'Personal information is collected consistent with the entity’s objectives related to privacy.' },
  { code: 'P3.2', category: 'privacy', group: 'P3', title: 'Explicit consent for collection', description: 'For information requiring explicit consent, the entity communicates the need for such consent and obtains it prior to the collection of the information.' },

  // ---- P4 Use, Retention, and Disposal ------------------------------------
  { code: 'P4.1', category: 'privacy', group: 'P4', title: 'Limited use', description: 'The entity limits the use of personal information to the purposes identified in the notice and for which the data subject has provided consent.' },
  { code: 'P4.2', category: 'privacy', group: 'P4', title: 'Retention', description: 'The entity retains personal information consistent with its objectives related to privacy.' },
  { code: 'P4.3', category: 'privacy', group: 'P4', title: 'Disposal', description: 'The entity securely disposes of personal information to meet its objectives related to privacy.' },

  // ---- P5 Access ----------------------------------------------------------
  { code: 'P5.1', category: 'privacy', group: 'P5', title: 'Access to personal information', description: 'The entity grants identified and authenticated data subjects the ability to access their stored personal information for review and, upon request, provides them with such information.' },
  { code: 'P5.2', category: 'privacy', group: 'P5', title: 'Correction of personal information', description: 'The entity corrects, amends, or appends personal information based on information provided by data subjects and communicates such information to third parties as committed or required.' },

  // ---- P6 Disclosure and Notification -------------------------------------
  { code: 'P6.1', category: 'privacy', group: 'P6', title: 'Authorized disclosure', description: 'The entity discloses personal information to third parties only for the purposes identified in the notice and with the consent of the data subject.' },
  { code: 'P6.2', category: 'privacy', group: 'P6', title: 'Record of disclosures', description: 'The entity creates and retains a complete, accurate, and timely record of authorized disclosures of personal information.' },
  { code: 'P6.3', category: 'privacy', group: 'P6', title: 'Record of unauthorized disclosures', description: 'The entity creates and retains a complete, accurate, and timely record of detected or reported unauthorized disclosures of personal information.' },
  { code: 'P6.4', category: 'privacy', group: 'P6', title: 'Third-party privacy commitments', description: 'The entity obtains privacy commitments from vendors and other third parties who have access to personal information.' },
  { code: 'P6.5', category: 'privacy', group: 'P6', title: 'Third-party breach notification', description: 'The entity obtains commitments from vendors and other third parties to notify it of actual or suspected unauthorized disclosures of personal information.' },
  { code: 'P6.6', category: 'privacy', group: 'P6', title: 'Breach notification to data subjects', description: 'The entity provides notification of breaches and incidents to affected data subjects, regulators, and others to meet its objectives related to privacy.' },
  { code: 'P6.7', category: 'privacy', group: 'P6', title: 'Accounting of information held', description: 'The entity provides data subjects with an accounting of the personal information held and disclosure of the data subjects’ personal information, upon request.' },

  // ---- P7 Quality ---------------------------------------------------------
  { code: 'P7.1', category: 'privacy', group: 'P7', title: 'Accurate and relevant data', description: 'The entity collects and maintains accurate, up-to-date, complete, and relevant personal information to meet its objectives related to privacy.' },

  // ---- P8 Monitoring and Enforcement --------------------------------------
  { code: 'P8.1', category: 'privacy', group: 'P8', title: 'Complaint handling', description: 'The entity implements a process for receiving, addressing, resolving, and communicating the resolution of inquiries, complaints, and disputes from data subjects and others.' },
];

// ---- Derived lookups --------------------------------------------------------
const byCode = {};
for (const c of CRITERIA) byCode[c.code] = c;

const categoryByCode = {};
for (const c of CATEGORIES) categoryByCode[c.code] = c;

/** All criteria for a category, in catalog order. */
function criteriaFor(categoryCode) {
  return CRITERIA.filter((c) => c.category === categoryCode);
}

/** Ordered list of group codes present in a category (e.g. ['CC1',...,'CC9']). */
function groupsFor(categoryCode) {
  const seen = [];
  for (const c of CRITERIA) {
    if (c.category === categoryCode && !seen.includes(c.group)) seen.push(c.group);
  }
  return seen;
}

/** Resolve a criterion code to its title (or the code itself if unknown). */
function titleFor(code) {
  return byCode[code] ? byCode[code].title : code;
}

/** Validate/normalize a list of criterion codes against the catalog. */
function validCodes(codes) {
  if (!Array.isArray(codes)) return [];
  return codes.filter((c) => byCode[c]);
}

module.exports = {
  CATEGORIES,
  CRITERIA,
  GROUP_LABELS,
  byCode,
  categoryByCode,
  criteriaFor,
  groupsFor,
  titleFor,
  validCodes,
};
