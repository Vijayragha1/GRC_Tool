// Starter ISO 27001:2022 policy & procedure templates.
// IMPORTANT: each template is a STARTING POINT. The standard does not prescribe
// most operational parameters (review frequencies, password lengths, score bands,
// retention periods). These are decisions for the organization to make based on
// its risk appetite, regulatory environment, and business context. Bracketed
// placeholders [LIKE THIS] indicate where the consultant or client must edit.
//
// Auto-substituted placeholders (no editing needed):
//   {{client_name}}  {{scope}}  {{date}}  {{firm_name}}
//   {{document_owner}}  {{approval_authority}}  {{review_period}}  {{industry}}

const STARTER_NOTE = `> **Starting point.** This document is a starter template aligned with ISO 27001:2022 / 27002:2022. Review every section, replace bracketed placeholders, and adjust to {{client_name}}'s actual practices and risk appetite. Where this template specifies values (review intervals, retention, thresholds), the standard does not prescribe them - confirm with stakeholders before publishing.\n\n---\n`;

module.exports = [
  {
    name: 'Information Security Policy',
    category: 'policy',
    description: 'Top-level information security policy (Clause 5.2). Mandatory.',
    content: `# Information Security Policy

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Effective Date:** {{date}}
**Review Period:** {{review_period}}

## 1. Purpose

To establish {{client_name}}'s commitment to protecting the confidentiality, integrity, and availability of information within the scope of its Information Security Management System (ISMS).

## 2. Scope

This policy applies to {{scope}} and to all employees, contractors, and other interested parties who handle {{client_name}}'s information.

## 3. Policy commitments

{{client_name}}'s top management commits to:

- An ISMS aligned with ISO/IEC 27001:2022 covering the defined scope.
- Identifying and treating information security risks per the documented risk management process.
- Satisfying applicable legal, statutory, regulatory, and contractual requirements relating to information security.
- Establishing, monitoring, and reviewing information security objectives.
- Providing the resources needed for the ISMS to operate effectively.
- Communicating the importance of information security and the requirement to conform to ISMS requirements.
- Continually improving the ISMS.

## 4. Roles and responsibilities

- **Top management** is accountable for the ISMS.
- **{{document_owner}}** has overall responsibility for the operation of the ISMS and reports on performance to top management.
- **All personnel and relevant interested parties** are responsible for following this policy and supporting topic-specific policies and procedures.

## 5. Compliance

Failure to comply with this policy may result in action under {{client_name}}'s disciplinary, contractual, or legal processes as applicable.

## 6. Review

This policy will be reviewed by {{document_owner}} at planned intervals (currently: {{review_period}}) and when significant changes occur.

## 7. Related documents

- Topic-specific policies referenced in the Statement of Applicability
- Risk management process and risk treatment plan
- Information security objectives and plan
- ISMS scope

---
*This document is the property of {{client_name}}. Distribution is governed by the document control procedure.*
`
  },

  {
    name: 'Access Control Policy',
    category: 'policy',
    description: 'Topic-specific policy for access control (A.5.15, A.5.16, A.5.17, A.5.18, A.8.2, A.8.3, A.8.5).',
    content: `# Access Control Policy

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}
**Review Period:** {{review_period}}

## 1. Purpose

To establish rules for granting, modifying, reviewing, and revoking access to {{client_name}}'s information and associated assets, in alignment with business and information security requirements.

## 2. Scope

Applies to all systems, applications, and information assets within {{scope}}.

## 3. Principles

- Access is granted on the basis of a documented business need.
- Access is provisioned at the minimum level needed for the role.
- Conflicting duties are segregated where practicable; compensating controls apply where they are not.
- Access is denied unless explicitly authorized.

## 4. Identity and authentication

- Each user is assigned a unique identifier; shared accounts are not permitted unless [APPROVED EXCEPTION PROCESS].
- Authentication is enforced for all systems holding in-scope information.
- Multi-factor authentication is required for [DEFINE: e.g., privileged access, remote access, access to systems classified as Confidential or above].
- Authentication parameters (e.g., password complexity, lockout thresholds) follow [REFERENCE: organization's authentication standard].

## 5. Access lifecycle

### 5.1 Provisioning
Access requests are submitted via [DEFINE CHANNEL], approved by the information owner and the line manager, and provisioned by [DEFINE TEAM].

### 5.2 Modification on role change
On change of role, access is re-evaluated and modified or removed as appropriate.

### 5.3 Review
Access rights are reviewed [DEFINE INTERVAL - based on risk; commonly more frequent for privileged access]. Reviewers attest to the appropriateness of access.

### 5.4 Revocation
On termination or end of access need, access is removed within [DEFINE SLA].

## 6. Privileged access

- Privileged accounts are separate from standard accounts and used only for privileged tasks.
- Privileged actions are logged and reviewed.
- Where feasible, privileged access is granted on a time-bound basis.

## 7. Compliance

Suspected unauthorized access must be reported through the security event reporting channel. Violations are subject to the disciplinary process.

## 8. Related controls
A.5.15, A.5.16, A.5.17, A.5.18, A.8.2, A.8.3, A.8.5
`
  },

  {
    name: 'Risk Management Process',
    category: 'procedure',
    description: 'Defines the information security risk assessment and treatment process (Clauses 6.1.2, 6.1.3, 8.2, 8.3).',
    content: `# Information Security Risk Management Process

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To define a consistent, documented, repeatable approach to identifying, analyzing, evaluating, and treating information security risks at {{client_name}}, in line with Clauses 6.1.2, 6.1.3, 8.2, and 8.3 of ISO 27001:2022.

## 2. Scope

Applies to information assets and related processes and systems within {{scope}}.

## 3. Risk criteria

### 3.1 Risk acceptance criteria
[DEFINE: the organization's basis for accepting residual risk - e.g., described qualitatively, by score band, by category, or by approval authority.]

### 3.2 Criteria for performing assessments
Risk assessments are performed:
- At planned intervals: [DEFINE INTERVAL].
- When significant changes occur or are proposed (new systems, mergers, regulatory changes, material incidents).
- When the risk treatment plan is materially altered.

## 4. Risk identification

For each in-scope information asset (or asset group), identify risks associated with the loss of confidentiality, integrity, and/or availability. Risks are typically derived from threat–vulnerability–asset combinations, but other valid approaches may be used.

## 5. Risk analysis

Each risk is analyzed by estimating:
- **Consequences (impact)** of the risk being realized.
- **Likelihood** of the risk occurring.

The organization may use qualitative, semi-quantitative, or quantitative methods. [DEFINE: the chosen scales - e.g., 1–5 likelihood, 1–5 impact, with documented descriptors for each level.]

## 6. Risk evaluation

The risk score is compared against the risk acceptance criteria to determine whether treatment is required.

## 7. Risk treatment

For each risk requiring treatment, one of the following options is selected:
- **Modify** the risk by applying controls.
- **Retain** the risk with management approval.
- **Avoid** the risk by eliminating the activity or the asset.
- **Share** the risk with another party (insurance, outsourcing, contractual transfer).

Selected controls are compared with Annex A to ensure no necessary controls have been overlooked.

## 8. Statement of Applicability

A Statement of Applicability is produced and maintained, listing every Annex A control with:
- Whether it is included or excluded.
- Justification for the decision.
- Implementation status.

## 9. Risk treatment plan

A risk treatment plan documents the actions, responsible parties, resources, and dates for implementing controls and reaching acceptable residual risk. The plan is approved by risk owners.

## 10. Monitoring and review

The risk register and treatment plan are monitored and reviewed in line with the criteria in Section 3 and are inputs to management review.

## 11. Records

The following are retained as records:
- Risk assessment process (this document).
- Risk register / risk assessment results.
- Risk treatment plan.
- Statement of Applicability.
- Risk owner approvals of the plan and acceptance of residual risk.
`
  },

  {
    name: 'Acceptable Use Policy',
    category: 'policy',
    description: 'Topic-specific policy for acceptable use (A.5.10).',
    content: `# Acceptable Use Policy

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To define acceptable use of {{client_name}}'s information and associated assets.

## 2. Scope

All employees, contractors, and other relevant interested parties with access to {{client_name}} resources.

## 3. Acceptable use

You may use {{client_name}} systems and information only for authorized purposes consistent with your role and any applicable agreements. [DEFINE: organization's position on limited personal use.]

## 4. Required behavior

- Protect authentication information; do not share credentials or tokens.
- Handle information in accordance with its classification.
- Use only software approved by [DEFINE].
- Connect only to networks and services approved by [DEFINE].
- Apply security updates and configurations as required by IT.
- Lock screens when unattended; comply with the clear desk and clear screen policy.

## 5. Prohibited behavior

You must not:
- Attempt to bypass or disable security controls.
- Access information you are not authorized to view.
- Disclose confidential information except as authorized.
- Use {{client_name}} resources for unlawful activity.
- Install or run unauthorized software.

## 6. Reporting

Report suspected security events, lost or stolen devices, and policy violations through the security event reporting channel.

## 7. Compliance

Violations are subject to {{client_name}}'s disciplinary or contractual processes.

## 8. Acknowledgement

Use of {{client_name}} systems constitutes acceptance of this policy.
`
  },

  {
    name: 'Information Security Incident Management Procedure',
    category: 'procedure',
    description: 'Procedure for managing information security incidents (A.5.24–A.5.28).',
    content: `# Information Security Incident Management Procedure

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To define how {{client_name}} prepares for, detects, responds to, recovers from, and learns from information security incidents.

## 2. Scope

All information security events and incidents affecting in-scope information, systems, or services.

## 3. Definitions

- **Event:** an observable occurrence in a system or network.
- **Incident:** an event (or series of events) that compromises, or could compromise, information security.

## 4. Roles

- **Incident Response Team (IRT):** coordinates response. Lead: {{document_owner}}.
- **Reporters:** any person who detects an event.
- **Top management:** authorizes major decisions, including external communications.
- **Other functions** (Legal, HR, Comms, Privacy) are engaged as appropriate.

## 5. Lifecycle

### 5.1 Preparation
- Maintain this procedure and supporting playbooks.
- Train responders.
- Test the procedure (e.g., tabletop, simulation) at intervals defined by the organization.

### 5.2 Detection and reporting
Events are reported via [DEFINE CHANNEL]. Detection sources include monitoring, user reports, supplier notifications, and external parties.

### 5.3 Triage and classification
The IRT assesses each event and decides whether it is an incident. Classification covers severity and category. [DEFINE: the organization's severity scale and criteria.]

### 5.4 Containment, eradication, recovery
The IRT contains the incident to limit damage, removes the cause, and restores affected services. Decisions and actions are recorded.

### 5.5 Communication
Internal communication is on a need-to-know basis. External communication (regulators, customers, public) is authorized only by top management or its delegate.

### 5.6 Closure
The IRT confirms the incident is resolved and records outcomes.

### 5.7 Lessons learned
A post-incident review identifies causes and improvement opportunities. Outputs feed the corrective action process.

## 6. Evidence

Where incidents may have legal, regulatory, or contractual implications, evidence is collected and preserved per the evidence handling procedure (A.5.28).

## 7. Records

Incident records, classifications, communications, and post-incident reviews are retained per [DEFINE RETENTION].

## 8. Related controls
A.5.24, A.5.25, A.5.26, A.5.27, A.5.28, A.6.8
`
  },

  {
    name: 'Information Backup Policy',
    category: 'policy',
    description: 'Topic-specific policy on backup (A.8.13).',
    content: `# Information Backup Policy

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To establish requirements for backing up information, software, and systems necessary to support {{client_name}}'s availability and integrity requirements.

## 2. Scope

Information, systems, and configurations within {{scope}} for which availability or integrity requirements apply.

## 3. Backup requirements

For each in-scope system, the system owner defines and documents:
- **What** is backed up.
- **Frequency** of backup.
- **Retention** period.
- **Storage location(s)**, including any off-site copy.
- **Protection** measures (encryption, access control).

These parameters are determined by business and information security requirements; [DEFINE: organization's standard tiers, if any].

## 4. Restoration testing

Restoration is tested at intervals appropriate to the criticality of the system. Test outcomes are recorded; failures are addressed through the corrective action process.

## 5. Access and protection

Access to backups is restricted to authorized personnel. Backup media and systems are protected at a level consistent with the original information's classification.

## 6. Records

Backup logs, restoration test results, and exceptions are retained per [DEFINE RETENTION].

## 7. Related controls
A.8.13, A.5.29, A.5.30, A.8.14
`
  },

  {
    name: 'Asset Management Procedure',
    category: 'procedure',
    description: 'Procedure for asset inventory and lifecycle (A.5.9, A.5.10, A.5.11, A.5.12, A.5.13).',
    content: `# Asset Management Procedure

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To identify and manage information and other associated assets in support of the ISMS.

## 2. Asset categories

The inventory covers categories relevant to the organization, which may include:
- Information (databases, files, documents)
- Software (applications, libraries)
- Hardware (servers, endpoints, network and storage devices)
- Services (cloud and supplier services)
- People (key roles, knowledge holders)
- Intangibles (reputation, intellectual property)

## 3. Inventory

For each in-scope asset, record at minimum:
- Identifier and description
- Type
- Owner
- Classification
- Location or hosting model
- Lifecycle status

## 4. Ownership

Each asset has a designated owner who is accountable for protection, classification, and lifecycle decisions.

## 5. Classification

Information is classified per the organization's classification scheme. Classification decisions are made by the information owner.

## 6. Acceptable use and labelling

Use of assets follows the Acceptable Use Policy. Labelling of information follows the labelling procedure where applicable.

## 7. Lifecycle events

- **Acquisition:** new assets are added to the inventory before use.
- **Change:** changes are reflected in the inventory.
- **Return:** assets held by personnel are returned on termination or change of role.
- **Disposal:** information is securely deleted or media securely destroyed; equipment is sanitized prior to disposal or reuse.

## 8. Review

The inventory is reviewed at intervals defined by the organization.

## 9. Related controls
A.5.9, A.5.10, A.5.11, A.5.12, A.5.13, A.7.10, A.7.14, A.8.10
`
  },

  {
    name: 'Cryptography Policy',
    category: 'policy',
    description: 'Topic-specific policy on use of cryptography (A.8.24). Required if A.8.24 is included in the SoA.',
    content: `# Cryptography Policy

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To establish rules for the effective use of cryptography to protect {{client_name}}'s information.

## 2. When cryptography is required

Cryptographic protection is required where the organization's risk assessment, classification scheme, or applicable legal/regulatory/contractual requirements indicate it. Examples may include [DEFINE based on the organization]:

- Information classified as [CLASSIFICATION LEVEL] or above, at rest.
- Information transmitted across untrusted networks.
- Authentication credentials in storage.
- Backup media.

## 3. Algorithms and parameters

The organization uses cryptographic algorithms and parameters considered current and appropriate for their use case. [DEFINE: the organization's approved list, taking into account references such as NIST SP 800-131A, ENISA recommendations, or sector-specific guidance.]

Deprecated algorithms and parameters are identified and migrated within timelines defined by the organization.

## 4. Key management

Cryptographic keys are managed throughout their lifecycle: generation, distribution, storage, use, rotation, revocation, archival, and destruction. Key management activities include:

- Key generation in approved cryptographic modules.
- Key storage in approved key stores (HSM, cloud KMS, equivalent).
- Defined key custodians for sensitive keys.
- Procedures for compromise response.

## 5. Records and inventory

The organization maintains an inventory of cryptographic systems and keys appropriate to the operational scale.

## 6. Roles

- **{{document_owner}}** owns this policy.
- **System owners** ensure their systems comply.

## 7. Related controls
A.8.24, A.5.17, A.8.5
`
  },

  {
    name: 'Supplier Information Security Policy',
    category: 'policy',
    description: 'Topic-specific policy for supplier relationships (A.5.19–A.5.22).',
    content: `# Supplier Information Security Policy

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To manage information security risks associated with suppliers' access to {{client_name}}'s information and assets.

## 2. Scope

All suppliers whose products or services can affect the security of in-scope information, systems, or services.

## 3. Supplier classification

Suppliers are classified based on the risk they pose. [DEFINE: criteria - e.g., access to confidential data, criticality to operations, regulatory implications.]

## 4. Pre-engagement assessment

Before granting access or onboarding a supplier, an information security assessment is performed appropriate to the classification. The assessment may include questionnaires, review of attestations (e.g., SOC 2, ISO 27001), reference checks, or independent reviews.

## 5. Contractual requirements

Supplier agreements include security requirements appropriate to the engagement, which may cover:

- Confidentiality and information handling.
- Compliance with applicable laws (including data protection).
- Incident notification timelines.
- Sub-processor / sub-supplier management.
- Right to audit or independent assurance.
- Return or destruction of information at termination.

## 6. Ongoing oversight

Supplier performance and security are reviewed at intervals appropriate to the classification. Material changes to supplier services follow change control.

## 7. Termination

On termination, access is revoked and information is returned or destroyed per the agreement.

## 8. Related controls
A.5.19, A.5.20, A.5.21, A.5.22, A.5.23
`
  },

  {
    name: 'Business Continuity Plan',
    category: 'plan',
    description: 'Continuity arrangements (A.5.29, A.5.30).',
    content: `# Business Continuity Plan

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Objective

To enable {{client_name}} to continue critical operations during disruption and recover affected services within agreed timeframes, while maintaining information security.

## 2. Scope

Critical processes and supporting systems within {{scope}}, identified through a Business Impact Analysis (BIA).

## 3. Critical processes and recovery objectives

[POPULATE FROM BIA: list each critical process with its Recovery Time Objective (RTO), Recovery Point Objective (RPO), and process owner.]

| Process | RTO | RPO | Owner |
|---|---|---|---|
| [Process 1] | [RTO] | [RPO] | [Owner] |

## 4. Roles

- **BC Coordinator:** {{document_owner}}.
- **Process owners:** execute their recovery procedures.
- **Top management:** authorize escalation and external communications.

## 5. Activation

[DEFINE: triggers and authority to activate the plan.]

## 6. Communication

[DEFINE: primary and alternative communication channels, including off-band methods.]

## 7. Information security during disruption

Information security controls applicable during normal operations also apply during disruption, with deviations documented and approved.

## 8. Testing

The plan is tested at intervals defined by the organization. Test outputs are reviewed and feed continual improvement.

## 9. Records

Test plans, test results, activation records, and post-event reviews are retained per [DEFINE RETENTION].

## 10. Related controls
A.5.29, A.5.30, A.8.14
`
  },

  {
    name: 'Awareness and Training Plan',
    category: 'plan',
    description: 'Awareness and training program (Clause 7.3, A.6.3).',
    content: `# Information Security Awareness and Training Plan

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Objectives

- Personnel are aware of the Information Security Policy and their role in the ISMS.
- Personnel can recognize and respond to common information security risks.
- Role-relevant training is provided to those whose duties materially affect information security.

## 2. Audience

| Audience | Coverage | Cadence |
|---|---|---|
| All personnel | General awareness | At onboarding, then [INTERVAL] |
| Developers | Secure development practices | At onboarding, then [INTERVAL] |
| Privileged users | Privileged access expectations | At access grant, then [INTERVAL] |
| Incident responders | IR roles and procedure | At role assignment, then [INTERVAL] |
| Top management | Governance and oversight | [INTERVAL] |

## 3. Methods

[DEFINE: e.g., e-learning modules, simulations, in-person briefings, awareness campaigns.]

## 4. Effectiveness

[DEFINE: how the organization measures effectiveness - e.g., completion rates, knowledge checks, simulation outcomes.]

## 5. Records

Training and awareness records are retained per [DEFINE RETENTION].

## 6. Related controls
Clause 7.3, A.6.3, A.5.4
`
  },

  {
    name: 'Internal Audit Procedure',
    category: 'procedure',
    description: 'Procedure for ISMS internal audits (Clause 9.2).',
    content: `# Internal Audit Procedure

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To plan, conduct, and report on internal audits that determine whether the ISMS conforms to {{client_name}}'s requirements and to ISO 27001:2022, and is effectively implemented and maintained.

## 2. Audit programme

An audit programme is established and maintained covering frequency, methods, responsibilities, planning, and reporting.

[DEFINE: programme cadence and rotation across ISMS clauses and applicable Annex A controls - proportionate to risk and prior findings.]

## 3. Auditor independence

Auditors do not audit their own work. Where an internal candidate is unavailable, an external auditor or a person from outside the audited area is used.

## 4. Conducting the audit

For each audit:
- Define audit criteria and scope.
- Notify auditees in advance of the audit.
- Collect and evaluate evidence (interviews, observations, document review).
- Classify findings (e.g., nonconformity / observation / opportunity for improvement).
- Issue an audit report.

## 5. Findings and follow-up

Nonconformities and other findings are tracked through the corrective action process to closure. Status is reported to top management.

## 6. Records

Audit programme, audit plans, audit reports, evidence, and corrective actions are retained per [DEFINE RETENTION].

## 7. Related clauses
Clause 9.2; inputs to Clause 9.3 (management review).
`
  },

  {
    name: 'Management Review Procedure',
    category: 'procedure',
    description: 'Procedure for ISMS management review (Clause 9.3).',
    content: `# Management Review Procedure

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To define how top management reviews the ISMS to confirm its continuing suitability, adequacy, and effectiveness.

## 2. Frequency

Reviews are held at planned intervals. [DEFINE INTERVAL - typically at least annually; more frequently if significant changes warrant.]

## 3. Inputs (per Clause 9.3.2)

The review covers:

- Status of actions from previous management reviews.
- Changes in external and internal issues relevant to the ISMS.
- Changes in the needs and expectations of interested parties relevant to the ISMS.
- Feedback on the ISMS performance, including trends in:
  - Nonconformities and corrective actions.
  - Monitoring and measurement results.
  - Audit results.
  - Fulfilment of information security objectives.
- Feedback from interested parties.
- Results of risk assessment and status of the risk treatment plan.
- Opportunities for continual improvement.

## 4. Outputs (per Clause 9.3.3)

The review documents decisions related to:

- Continual improvement opportunities.
- Any need for changes to the ISMS.

Where action is required, owners and target dates are recorded.

## 5. Records

Agendas, minutes (covering inputs, decisions, and actions), and follow-up records are retained per [DEFINE RETENTION].

## 6. Related clauses
Clause 9.3.
`
  },

  {
    name: 'Documented Information Control Procedure',
    category: 'procedure',
    description: 'Procedure for control of documented information (Clause 7.5).',
    content: `# Documented Information Control Procedure

${STARTER_NOTE}
**Document Owner:** {{document_owner}}
**Effective Date:** {{date}}

## 1. Purpose

To ensure that documented information required by ISO 27001:2022 and determined as necessary by the organization is created, controlled, and maintained appropriately.

## 2. Scope

All ISMS documented information.

## 3. Creation and identification

Each document includes the identification appropriate to its use, which may include: title, owner, version, approval date, effective date, classification, and review schedule.

## 4. Format and media

Documented information may be in any format (electronic, printed) appropriate to its use.

## 5. Review and approval

Documents are reviewed for adequacy before issue. Approval authority is defined per [DEFINE: matrix or per-document approver].

## 6. Distribution, access, retrieval, use

Documents are made available to those who need them, with access controls aligned with classification.

## 7. Storage and preservation

Documents are stored in protected repositories with backup and integrity protection appropriate to their classification.

## 8. Control of changes

Changes follow approval and version control. Superseded versions are retained in a controlled manner consistent with retention requirements.

## 9. Retention and disposition

Retention and disposition follow the records retention schedule and applicable legal/regulatory/contractual requirements.

## 10. External documents

Documented information of external origin (e.g., regulations, supplier documentation, standards) that the organization determines necessary for ISMS planning and operation is identified and controlled.

## 11. Related clauses
Clause 7.5.
`
  },

  {
    name: 'Statement of Applicability - cover page',
    category: 'record',
    description: 'Cover page for the SoA. The full control register is exported separately from the SoA module.',
    content: `# Statement of Applicability

${STARTER_NOTE}
**Organization:** {{client_name}}
**ISMS scope:** {{scope}}
**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Approval date:** {{date}}
**Version:** [VERSION]

## 1. Purpose

This Statement of Applicability lists the ISO/IEC 27001:2022 Annex A controls and indicates whether each control applies to the ISMS, with justification.

## 2. Methodology

Decisions on applicability are based on:
- Outcomes of the information security risk assessment and risk treatment.
- Legal, statutory, regulatory, and contractual requirements.
- Other business and operational requirements.

Each control is recorded with:
- Whether it is **included** or **excluded**.
- Justification (driving risks, regulatory basis, business need; or - for exclusions - the reason the control is not relevant).
- Implementation status.

## 3. Control register

The full register of all 93 Annex A controls - applicability, justification, and implementation status - is maintained in the ISMS tool and is exported alongside this cover page.

## 4. Maintenance

This Statement of Applicability is reviewed at intervals defined by the organization, and whenever significant changes occur to the risk landscape, business operations, or regulatory environment.
`
  }
];
