// ISO 27001:2022 starter templates — Organisational controls (A.5.x) and
// supporting records for clauses 6.2 and 10.2.

const STARTER = `> **Starting point.** Aligned with ISO 27001:2022 and ISO 27002:2022 implementation guidance. Replace bracketed placeholders, adjust to {{client_name}}'s practices, and have the document owner confirm intervals/thresholds before approval.\n\n---\n`;
const HEADER = (kind) => `${STARTER}
**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Effective Date:** {{date}}
**Review Period:** {{review_period}}
**Annex A reference:** ${kind}

`;

module.exports = [
  {
    name: 'Threat Intelligence Procedure',
    category: 'procedure',
    description: 'Collection, analysis, and use of threat intelligence (A.5.7).',
    content: `# Threat Intelligence Procedure

${HEADER('A.5.7')}

## 1. Purpose
To gather, evaluate, and act upon information about threats relevant to {{client_name}}'s operations, so that defences can be adapted before a threat materialises.

## 2. Scope
Threat information from external feeds, peer organisations, vendors, the security community, and {{client_name}}'s own incidents and detections.

## 3. Sources

### 3.1 Strategic
- Industry sector reports (sector ISACs / ISAOs where {{client_name}} is a member).
- National cyber agency advisories (e.g., NCSC, CISA, ENISA).
- Vendor strategic reports.

### 3.2 Tactical and operational
- Commercial threat-intel feeds (where licensed).
- Open-source feeds (curated).
- Vendor IOC publications.
- Vulnerability advisories (KEV catalog).
- Indicators from previous {{client_name}} incidents.

### 3.3 Internal
- {{client_name}}'s SIEM detections.
- Phishing reports from staff.
- Bug-bounty / responsible-disclosure submissions.

## 4. Collection cadence
- Strategic: reviewed [monthly].
- Tactical: reviewed [weekly].
- Operational / IOCs: ingested [continuously] into the SIEM and EDR.

## 5. Analysis
For each piece of intelligence, the analyst records:
- Source and confidence (HML).
- Relevance to {{client_name}} (sector / technology / customer base).
- Indicators (IOCs) — IPs, domains, file hashes, TTPs.
- Recommended actions and SLA.

## 6. Action
Possible actions include:
- Block IOCs at the firewall / DNS / email gateway.
- Update SIEM detection rules.
- Raise the priority of an open vulnerability.
- Initiate a threat hunt.
- Brief stakeholders (engineering, support, exec).
- Update awareness messaging.

Actions are tracked to closure in the ISMS task system.

## 7. Sharing
{{client_name}} contributes anonymised indicators back to peer ISACs / ISAOs where membership permits.

## 8. Roles
- **Threat Intel Lead** ([NAME] / [ROLE]) coordinates collection and analysis.
- **Detection Engineering** translates intel into rules.
- **ISMS Manager** ensures actions are tracked.

## 9. Records
- Intel briefings retained for [3 years].
- Action register retained for [3 years].
- IOC ingest history retained for [12 months].

## 10. Related documents
- Information Security Incident Management Procedure (A.5.24)
- Vulnerability Management Procedure (A.8.8)
- Logging and Monitoring Policy (A.8.15–16)
`
  },
  {
    name: 'Information Security in Project Management Procedure',
    category: 'procedure',
    description: 'Embedding security in projects of any kind (A.5.8).',
    content: `# Information Security in Project Management Procedure

${HEADER('A.5.8')}

## 1. Purpose
To make sure information security is considered and addressed in {{client_name}} projects, regardless of project type.

## 2. Scope
All projects within {{client_name}} that introduce or significantly change services, systems, processes, or third-party relationships, including transformation, IT, software, M&A, and operations projects.

## 3. Required activities

### 3.1 Project initiation
- Initial security assessment performed by the ISMS Manager (or delegate).
- Security risks added to the project risk log.
- Security stakeholders identified.

### 3.2 Planning
- Security requirements derived from data classification, applicable laws, and internal policies.
- Threat-modelling for any technology change (per Secure Development Life Cycle).
- DPIA performed if personal data processing is involved (per Privacy and PII Protection Policy).
- Supplier engagements assessed under the Supplier Information Security Policy.

### 3.3 Execution
- Security tasks tracked in the project plan with named owners.
- Security findings (vulnerabilities, misconfigurations) tracked to closure.
- Architecture / design changes go through Change Management.

### 3.4 Closure
- Security requirements verified met before go-live.
- Residual risks documented and accepted via the Risk Acceptance Procedure.
- New artefacts (assets, suppliers, data flows) added to the relevant registers.
- Lessons learned captured.

## 4. Project risk register
Every project maintains a security section in its risk register linked to the ISMS risk register. Risks scoring above the appetite threshold cannot be accepted at the project level — they go through the workspace risk acceptance flow.

## 5. Approval gates
- A pre-build / pre-launch security checkpoint is mandatory for projects:
  - Touching Restricted information,
  - Introducing a new internet-facing service,
  - Engaging a tier-1 supplier,
  - Changing the boundary of the ISMS.

## 6. Roles
- **Project Manager** owns delivery and the project risk register.
- **Project Security Liaison** (assigned by the ISMS Manager) advises on requirements and approves checkpoints.

## 7. Records
- Project security assessments and checkpoint sign-offs are retained for the project lifetime + [3 years].

## 8. Related documents
- Risk Management Process (clause 6.1)
- Secure Development Life Cycle Policy (A.8.25)
- Supplier Information Security Policy (A.5.19)
- Change Management Procedure (A.8.32)
`
  },
  {
    name: 'Information Classification and Labelling Policy',
    category: 'policy',
    description: 'Classification scheme and labelling rules for information (A.5.12, A.5.13).',
    content: `# Information Classification and Labelling Policy

${HEADER('A.5.12, A.5.13')}

## 1. Purpose
To classify {{client_name}} information by sensitivity so that appropriate protection can be applied and to mandate the labels used to communicate that classification.

## 2. Scope
All information processed by {{client_name}} in any form (electronic, printed, verbal).

## 3. Classification scheme

| Level | Definition | Examples | Default handling |
|-------|------------|----------|------------------|
| Public | Approved for general release | Marketing, published policies, status page | No handling restrictions |
| Internal | Default working information; not for external release | Most internal email, project plans, meeting notes | No external distribution; default behind SSO |
| Confidential | Disclosure would harm {{client_name}}, customers, or staff | Source code, financial information, personnel files, customer data, contracts | Need-to-know; encrypted at rest and in transit; restricted printing |
| Restricted | Disclosure would cause severe harm | Security architecture, secrets, incident details, regulated personal data, evidence | Strict need-to-know; logged access; storage and processing only on approved systems; no removable media |

## 4. Labelling

### 4.1 Electronic
- Documents (Word, Google Docs, PDF) display the classification at top of every page.
- Email is labelled in the subject prefix [Confidential] / [Restricted] for above-Internal.
- Source code repositories are themselves classified; per-file labelling is not required.
- Application UI shows classification badges where appropriate (support tools, admin consoles).

### 4.2 Physical
- Printed Confidential and Restricted documents bear the classification in headers and footers, plus copy number for Restricted.

## 5. Reclassification
- Information is reviewed for declassification at retention review (Records Control Procedure).
- Information may be upclassified during an investigation; downclassification requires the data owner's approval.

## 6. Roles
- **Data owner** is the role accountable for a category of information; they assign the classification.
- **Data custodians** apply the technical controls (storage, access, encryption).
- **All users** are responsible for handling information according to its label.

## 7. Default classification
In the absence of explicit classification, information generated or held by {{client_name}} is treated as Internal.

## 8. Awareness
Classification rules are taught at onboarding and refreshed annually as part of awareness training (A.6.3).

## 9. Related documents
- Records Control Procedure (A.5.33)
- Privacy and PII Protection Policy (A.5.34)
- Information Transfer Policy (A.5.14)
`
  },
  {
    name: 'Information Transfer Policy',
    category: 'policy',
    description: 'Rules for transferring information inside and outside {{client_name}} (A.5.14).',
    content: `# Information Transfer Policy

${HEADER('A.5.14')}

## 1. Purpose
To set the rules for transferring {{client_name}} information so that confidentiality, integrity, availability, and (where relevant) legal compliance are maintained during transfer.

## 2. Scope
All electronic, physical, and verbal transfers of {{client_name}} information, internally and to/from third parties.

## 3. General principles
- Transfer only what is needed for the purpose.
- Apply controls appropriate to the highest classification of information in the transfer.
- Maintain a record of significant transfers (Confidential or above) such that the recipient, content, purpose, and time can be reconstructed.
- Use approved channels and tooling.

## 4. Approved channels

| Classification | Approved channels |
|----------------|-------------------|
| Public | Any |
| Internal | {{client_name}} email, sanctioned messaging, sanctioned file sharing |
| Confidential | {{client_name}} email + encryption-in-transit, encrypted file sharing with access control, secure file transfer with logging |
| Restricted | Encrypted channels with mutual authentication, end-to-end encryption where supported, recipient-specific access, transfer logged |

Channels not on this list (consumer cloud storage, personal email, social media DMs) are prohibited for Internal information and above.

## 5. External transfer
External transfer of Confidential or Restricted information requires:
- Authority from the data owner.
- A contract / DPA where applicable.
- Encryption in transit and at rest at the recipient where feasible.
- A record of what was sent, to whom, when, and why.

## 6. Verbal transfer
Verbal disclosure of Confidential / Restricted information:
- Avoid public spaces and shared workplaces.
- Verify the recipient's identity for unusual / unprompted requests.
- Match the topic to the channel — do not discuss Restricted matters on speakerphone in shared rooms.

## 7. Physical transfer
- Use locked cases or sealed envelopes for Confidential / Restricted hardcopy.
- Use approved couriers with chain-of-custody for high-value transfers.
- Recipients sign for delivery.
- Removable media follows the Removable Storage Media Procedure.

## 8. Bulk transfer
Transfers above [N records] of personal data, [GB] of Confidential data, or transfers across borders where transfer mechanisms apply require ISMS Manager approval and (where personal data is involved) DPO sign-off.

## 9. Records
Significant transfers (above the thresholds in §8 or as flagged by DLP) are recorded in the Transfer Register and retained for [3 years].

## 10. Related documents
- Information Classification and Labelling Policy (A.5.12)
- Acceptable Use Policy (A.5.10)
- Privacy and PII Protection Policy (A.5.34)
- Cryptography Policy (A.8.24)
`
  },
  {
    name: 'Records Control Procedure',
    category: 'procedure',
    description: 'Lifecycle of records as distinct from documents (A.5.33).',
    content: `# Records Control Procedure

${HEADER('A.5.33')}

## 1. Purpose
To define how {{client_name}} creates, captures, retains, protects, and disposes of records — distinct from documents (which set future intent, while records evidence past activity).

## 2. Scope
All records that demonstrate the operation of the ISMS or compliance with applicable law and contracts. Documents are governed by the Documented Information Control Procedure.

## 3. Categories of record (illustrative)

| Category | Examples | Retention (default) |
|----------|----------|---------------------|
| ISMS evidence | Risk assessment results, SoA versions, MRM minutes, internal audit reports, NC/CAPA records, training records | [retain through 3 audit cycles + 3 years] |
| Operational | Incident records, change tickets, access reviews, supplier reviews | [3 years] |
| Privacy | DPIAs, ROPA snapshots, data subject requests, breach records | [statutory + 3 years] |
| Financial / contractual | Contracts, invoices, signed acceptances | [statutory minimum + 3 years] |
| Personnel | Employment files, training acknowledgements, disciplinary records | Per HR + statutory |
| Legal hold | Any record under active litigation hold | Until released |

The complete schedule is maintained as the Records Retention Schedule (controlled separately).

## 4. Capture
- Records are captured at the point they are generated, into the system of record (e.g., the ISMS tool, HRIS, ticketing system).
- Required metadata: type, owner, creation date, classification.

## 5. Protection
- Records are stored under the same classification controls as their content (per Information Classification Policy).
- Records that are evidence of compliance are stored with append-only / write-once protection where the platform supports it.
- Audit log records are protected by the hash chain in the ISMS tool.

## 6. Retention and disposition
- Each record category has a retention period in the Retention Schedule.
- Retention is enforced via the Retention Rules engine in the ISMS tool plus per-system retention configuration.
- At end of retention, records are securely deleted per the Information Deletion Procedure.
- Disposition is logged.

## 7. Legal hold
On notification of a legal hold from [LEGAL]:
- The ISMS Manager pauses retention-driven deletion for affected records.
- A hold register entry records scope, custodian list, and notice date.
- Hold is released only on written notice from Legal.

## 8. Access
- Records are accessible to those with a documented need.
- Access to high-sensitivity records (incidents, evidence, personnel) is logged.
- Access requests for retained records during/after individual departures follow the Termination Procedure.

## 9. Records of records
- Retention Schedule (controlled).
- Disposition log (records destroyed, when, by whom).
- Legal hold register.

## 10. Related documents
- Documented Information Control Procedure (A.7.5 / 5.37 / clause 7.5)
- Information Classification and Labelling Policy (A.5.12)
- Information Deletion Procedure (A.8.10)
`
  },
  {
    name: 'Privacy and PII Protection Policy',
    category: 'policy',
    description: 'Protection of personal data in line with applicable privacy law (A.5.34).',
    content: `# Privacy and PII Protection Policy

${HEADER('A.5.34')}

## 1. Purpose
To set {{client_name}}'s commitments and operating rules for handling personal data, in line with applicable privacy legislation in jurisdictions where {{client_name}} processes personal data.

## 2. Scope
All processing of personal data carried out by or on behalf of {{client_name}}, regardless of the form of the data or the systems used.

## 3. Principles
{{client_name}} processes personal data only when the following principles are satisfied:
- **Lawfulness, fairness, transparency** — there is a documented lawful basis and individuals are informed.
- **Purpose limitation** — data is collected for specified, explicit, legitimate purposes.
- **Data minimisation** — only data necessary for the purpose is collected.
- **Accuracy** — data is kept accurate and up to date; corrections are made on request.
- **Storage limitation** — data is retained only as long as necessary.
- **Integrity and confidentiality** — appropriate security controls are applied (see ISMS).
- **Accountability** — {{client_name}} can demonstrate compliance.

## 4. Roles and accountability
- **Data Protection Officer (DPO)** [or equivalent role]: oversight, advice, point of contact for individuals and supervisory authorities.
- **Data owners**: business stakeholders accountable for specific processing activities.
- **ISMS Manager**: technical and organisational security measures.
- **Engineering**: implements privacy-by-design and privacy-by-default in products.

## 5. Records of processing
{{client_name}} maintains a Records of Processing Activities (ROPA) that lists every processing activity, lawful basis, data categories, retention, recipients, and transfers. The ROPA is reviewed [annually] and updated whenever a material change occurs.

## 6. Lawful basis
Each processing activity in the ROPA has a documented lawful basis. Where consent is the basis:
- Consent is freely given, specific, informed, and unambiguous.
- Withdrawal is as easy as giving consent.

## 7. Notice
{{client_name}} provides clear privacy notices to data subjects at the point of collection and on the website, covering identity, purposes, lawful basis, recipients, transfers, retention, and rights.

## 8. Rights of individuals
Individuals can exercise the following rights, where the law provides:
- Access.
- Rectification.
- Erasure.
- Restriction.
- Portability.
- Objection.
- Not to be subject to solely automated decision-making with legal or similarly significant effects.

Requests are handled via the Data Subject Rights Procedure within statutory timelines (typically [30] days).

## 9. DPIAs
Data Protection Impact Assessments are conducted before any high-risk processing begins. The DPIA module in the ISMS tool is used. Outcomes that retain residual high risk require consultation with the supervisory authority.

## 10. Security
Personal data is protected by the controls of the ISMS, including encryption (A.8.24), access control (A.5.15), monitoring (A.8.15–16), and incident response (A.5.24).

## 11. Suppliers / processors
Suppliers processing personal data on behalf of {{client_name}} are engaged under a Data Processing Agreement (per Supplier Information Security Policy) including security requirements, sub-processor controls, breach notification, and rights to audit.

## 12. International transfers
Cross-border transfers of personal data outside the originating jurisdiction use an appropriate transfer mechanism (adequacy decision, standard contractual clauses, binding corporate rules) with a transfer impact assessment recorded.

## 13. Breach notification
Personal-data breaches follow the Information Security Incident Management Procedure (A.5.24) plus the privacy notification flow:
- Supervisory authority within statutory window (e.g., 72 hours under GDPR Article 33) where required.
- Affected individuals where the breach is likely to result in a high risk to their rights.

## 14. Training
Staff receive privacy training as part of A.6.3 awareness; role-specific training is provided to staff handling significant volumes of personal data.

## 15. Records
ROPA, DPIAs, data subject request log, breach register, transfer register — retained per the Records Retention Schedule.

## 16. Related documents
- Information Classification and Labelling Policy (A.5.12)
- Records Control Procedure (A.5.33)
- Information Security Incident Management Procedure (A.5.24)
- Supplier Information Security Policy (A.5.19)
`
  },
  {
    name: 'Documented Operating Procedure (SOP) Template',
    category: 'procedure',
    description: 'Reusable shape for any standard operating procedure (A.5.37).',
    content: `# Standard Operating Procedure — [TITLE]

${HEADER('A.5.37')}

## 1. Purpose
[Why this procedure exists. One short paragraph.]

## 2. Scope
[What activities, systems, people, and locations this procedure applies to. List exclusions if non-obvious.]

## 3. Roles and responsibilities
- **[ROLE_1]** is responsible for [duty].
- **[ROLE_2]** is consulted for [decision].
- **[ROLE_3]** is informed when [event].

## 4. Inputs
What is needed before this procedure starts:
- [Input / artefact / approval].
- [System access / privileges].
- [Tools].

## 5. Procedure

### Step 1 — [name]
[Clear, atomic action. Include who performs it.]
- Tooling: [TOOL].
- Acceptance criterion: [observable result].

### Step 2 — [name]
[…]

### Step 3 — [name]
[…]

(Add or remove steps as required.)

## 6. Exception handling
- [Common exception] → [action].
- Escalation path: [ROLE].
- Time limit on exception handling: [SLA].

## 7. Outputs
- [Artefact created] saved to [location].
- [Record updated] in [system].
- [Notification sent] to [audience].

## 8. Verification
How {{client_name}} confirms this procedure is followed:
- [Spot check / metric / audit point].
- Frequency: [interval].

## 9. Related documents
- [Policy / standard the SOP supports].
- [Forms used].
- [Other related SOPs].

## 10. Revision history

| Version | Date | Author | Summary of change |
|---------|------|--------|-------------------|
| 0.1 | {{date}} | {{document_owner}} | Initial draft |

---
*This is a reusable SOP template. Save-as for each specific procedure, replace bracketed text, and put the resulting SOP through the document approval workflow.*
`
  },

// =============== Clause 6.2 — Objectives ===============
  {
    name: 'Information Security Objectives',
    category: 'record',
    description: 'Documented information security objectives at relevant levels (Clause 6.2).',
    content: `# Information Security Objectives

${HEADER('Clause 6.2')}

## 1. Purpose
This document establishes {{client_name}}'s information security objectives, consistent with the information security policy and the results of risk assessment, in line with Clause 6.2 of ISO 27001:2022.

## 2. Principles
Objectives are:
- Consistent with the information security policy.
- Measurable (where practicable).
- Take into account applicable information security requirements and the results of risk assessment and treatment.
- Monitored.
- Communicated.
- Updated as appropriate.

## 3. Objectives — current period

> The following are starter objectives. Adjust to {{client_name}}'s context, risk treatment plan, and management priorities. Each should have a baseline, target, owner, and measurement cadence.

### 3.1 Strategic / governance
| # | Objective | Baseline | Target | Owner | Measure | Cadence |
|---|-----------|----------|--------|-------|---------|---------|
| 1 | Achieve / maintain ISO 27001:2022 certification | [Current state] | Successful surveillance audit with no major NCs | ISMS Manager | Audit outcome | Annual |
| 2 | Reduce open major nonconformities to zero within stage gates | [N] | 0 at stage 1 / 2 audits | ISMS Manager | NC register | Quarterly |

### 3.2 Risk management
| # | Objective | Baseline | Target | Owner | Measure | Cadence |
|---|-----------|----------|--------|-------|---------|---------|
| 3 | Top 10 risks have an active treatment plan | [N/10] | 10/10 | ISMS Manager | Treatment register | Monthly |
| 4 | No risk above appetite without formal acceptance | [N] | 0 | Risk Committee | Risk register | Monthly |

### 3.3 Operational
| # | Objective | Baseline | Target | Owner | Measure | Cadence |
|---|-----------|----------|--------|-------|---------|---------|
| 5 | Critical and exploited vulnerabilities remediated within SLA | [%] | ≥ 95% | IT Operations | Vulnerability dashboard | Monthly |
| 6 | Staff completing mandatory awareness training annually | [%] | ≥ 95% | ISMS Manager | Training records | Quarterly |
| 7 | Phishing simulation click-through rate | [%] | ≤ [10]% | Security | Sim platform | Quarterly |

### 3.4 Supply chain
| # | Objective | Baseline | Target | Owner | Measure | Cadence |
|---|-----------|----------|--------|-------|---------|---------|
| 8 | Critical (tier-1) suppliers with current attestation (ISO 27001 / SOC 2) | [N/N] | All current | Supplier Manager | Supplier register | Quarterly |

## 4. Planning to achieve
For each objective, the underlying actions, owners, and timescales are recorded in the Risk Treatment Plan and / or project plans linked to the objective.

## 5. Communication
This document is published to [LOCATION]. Progress is reviewed at [QUARTERLY MEETING] and reported at Management Review (Clause 9.3).

## 6. Review and update
Objectives are reviewed at least annually, and whenever the risk landscape, business context, or strategic direction changes materially.

## 7. Approval

Approved by **{{approval_authority}}** on **{{date}}**.
`
  },

// =============== Clause 10.2 — NC and corrective action ===============
  {
    name: 'Nonconformity and Corrective Action Procedure',
    category: 'procedure',
    description: 'Process for identifying, controlling, correcting, and preventing recurrence of nonconformities (Clause 10.2).',
    content: `# Nonconformity and Corrective Action Procedure

${HEADER('Clause 10.2')}

## 1. Purpose
To define how {{client_name}} reacts to nonconformities (NCs) — events where the ISMS or its requirements have not been met — and how recurrence is prevented through systematic corrective action.

## 2. Scope
NCs identified through any of the following:
- Internal audits (Clause 9.2).
- External audits (certification body, customer, regulator).
- Management Review (Clause 9.3).
- Operational events (incidents, near-misses, complaints).
- Continuous control monitoring.
- Whistleblowing / reporting from staff.

## 3. Definitions
- **Nonconformity (NC):** non-fulfilment of a requirement (e.g., a control fails, a record is missing, a procedure is not followed).
- **Major NC:** an NC where the failure is total, systemic, or where multiple minors of the same kind cluster.
- **Minor NC:** an isolated lapse.
- **Observation:** a weakness that is not yet an NC but warrants attention.
- **Correction:** action to eliminate the immediate consequence.
- **Corrective action:** action to eliminate the cause(s) so the NC does not recur.

## 4. Process

### 4.1 Capture
The person who identifies an NC raises it in the ISMS (Nonconformities module) including:
- Title, description, source, severity (proposed).
- Affected control(s) / clause(s).
- Date observed.

### 4.2 Triage and assignment
The ISMS Manager (or delegate) within [5] business days:
- Confirms the NC classification.
- Assigns a responsible owner.
- Sets a target closure date appropriate to severity.

### 4.3 Correction
The owner addresses the immediate consequence:
- Stops the failing process / restores the control.
- Notifies affected parties.
- Records evidence of correction.

### 4.4 Root cause analysis
For Major NCs, and for Minor NCs that recur or have material impact, the owner performs root-cause analysis using a structured technique (5 Whys, fishbone, fault tree). The cause and contributing factors are documented.

### 4.5 Corrective action
The owner determines and implements actions to eliminate causes:
- Process changes.
- Training.
- Tooling / configuration changes.
- Updates to documents or roles.

For each action: owner, target date, expected outcome.

### 4.6 Effectiveness verification
After implementation, the ISMS Manager verifies effectiveness — typically [60–180] days later — by sampling, evidence review, or repeat testing. The verification result is recorded.

### 4.7 Closure
The NC is closed only when:
- Correction is complete.
- Corrective actions are complete (where required).
- Effectiveness has been verified.

For Major NCs, closure requires sign-off by the {{approval_authority}} or delegate.

## 5. SLAs (default — adjust per workspace)

| Severity | Correction | Corrective action | Effectiveness verification |
|----------|-----------|-------------------|---------------------------|
| Major | [7] days | [60] days | [180] days post-closure |
| Minor | [30] days | [90] days | [90] days post-closure |
| Observation | n/a | [Optional] | n/a |

## 6. Trends
- The ISMS Manager reviews open and closed NCs at the Management Review (Clause 9.3).
- Recurring root causes drive ISMS-wide improvements.
- Themes are reported to the {{approval_authority}}.

## 7. Records
- NC register (kept in the ISMS tool).
- Root-cause analyses and corrective-action plans.
- Effectiveness verification results.

Retained for [3] years after closure (or as the relevant audit cycle requires).

## 8. Related documents
- Internal Audit Procedure (Clause 9.2)
- Management Review Procedure (Clause 9.3)
- Risk Management Process (Clause 6.1)
- Information Security Incident Management Procedure (A.5.24)
`
  }
];
