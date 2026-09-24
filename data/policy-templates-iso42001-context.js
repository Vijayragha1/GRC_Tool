'use strict';
// ISO/IEC 42001:2023 template pack: context, leadership and support (Clauses 4, 5, 6.2, 6.3, 7; Annex A.2, A.3.2, A.6.1.2, A.9.3).
const { STARTER_NOTE, CONTROL_BLOCK } = require('./policy-templates-iso42001-common');

module.exports = [
  {
    name: 'AIMS Scope Statement',
    category: 'record',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-4.1', 'ai-clause-4.2', 'ai-clause-4.3'],
    description: 'The documented boundary of the AI management system: organisation units, locations, processes, the AI systems in scope with the organisation\'s role for each, interfaces with out-of-scope AI and justified exclusions (Clauses 4.1 to 4.3). Mandatory.',
    content: `# AIMS Scope Statement

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This statement records the boundary of {{client_name}}'s AI management system (AIMS). Clause 4.3 requires the organisation to decide what the AIMS covers, using the issues identified under Clause 4.1 and the interested party requirements identified under Clause 4.2, and to keep that decision as documented information. Every other AIMS document, the AI system register and the Statement of Applicability work within the boundary set here.

The certification auditor asks for this document at Stage 1. They check that it names real AI systems, states {{client_name}}'s role for each one, gives reasons for every exclusion, and carries a version number, an approval date and the approver's signature.

## 2. Scope statement

> The AI management system of {{client_name}} covers [DESCRIBE THE ACTIVITY, e.g. THE DESIGN, DEVELOPMENT, VALIDATION, DEPLOYMENT AND OPERATION OF THE AI SYSTEMS USED IN (PRODUCT OR SERVICE), AND THE USE OF (NAMED THIRD-PARTY AI SERVICES) IN (BUSINESS PROCESSES)], carried out from [LOCATIONS], in accordance with the Statement of Applicability version [X.X] dated [DATE].

This paragraph is the wording proposed for the certificate. Keep it to one or two sentences and agree it with the certification body before Stage 2.

## 3. Organisational boundary

### 3.1 Organisation units in scope

| Unit or function | Role in the AIMS | Head of unit |
|---|---|---|
| [e.g. Data Science and ML Engineering] | [Designs, trains and validates models] | [NAME] |
| [e.g. Product and Customer Operations] | [Deploys AI features; performs human review of outputs] | [NAME] |
| [e.g. Legal, Privacy and Compliance] | [Maintains legal obligations; reviews impact assessments] | [NAME] |

Supporting functions in scope for the AI-related part of their work: [e.g. IT OPERATIONS, INFORMATION SECURITY, PROCUREMENT, HR, INTERNAL AUDIT].

### 3.2 Locations

| Location | Type | AIMS activity carried out there |
|---|---|---|
| [CITY AND ADDRESS] | [Head office] | [Governance, development, operations] |
| [CLOUD PROVIDER AND REGION] | [Hosting] | [Training and inference environments, model registry] |
| [Remote working] | [Staff homes] | [Development and review under the remote working rules] |

### 3.3 Processes in scope

- AI risk assessment and risk treatment (Clauses 6.1.2 and 6.1.3)
- AI system impact assessment (Clause 6.1.4)
- The AI system lifecycle stages [LIST THE STAGES IN SCOPE, e.g. USE CASE APPROVAL, REQUIREMENTS, DATA PREPARATION, DEVELOPMENT, VERIFICATION AND VALIDATION, DEPLOYMENT, OPERATION AND MONITORING, RETIREMENT]
- Selection and management of suppliers of AI systems, models and data
- AI incident handling and reporting of concerns
- Supporting AIMS processes: competence, awareness, communication, documented information, internal audit, management review, corrective action

## 4. AI systems in scope

Each system below appears in the AI system register under the same ID. The auditor compares the two lists, so a system is added to or removed from both at the same time.

The role column uses the ISO/IEC 22989 terms: AI provider, AI producer (developer), AI customer (user), AI partner. One system can carry more than one role.

| ID | AI system | Purpose and intended use | {{client_name}}'s role | Lifecycle stage | System owner |
|---|---|---|---|---|---|
| [AI-01] | [e.g. Claims triage model] | [Ranks incoming claims for manual review priority; does not decide claims] | [Producer and provider] | [Operation] | [NAME, JOB TITLE] |
| [AI-02] | [e.g. Support ticket summariser built on a third-party large language model] | [Drafts ticket summaries; the agent edits before use] | [Customer (user) of the model; producer of the prompt and retrieval layer] | [Deployment] | [NAME, JOB TITLE] |
| [AI-03] | [e.g. CV screening feature of the HR platform] | [Scores applications against job criteria for recruiter review] | [Customer (user)] | [Pilot] | [NAME, JOB TITLE] |

## 5. Interfaces with AI outside the scope

Clause 4.3 asks the organisation to consider interfaces and dependencies between its own activities and those carried out by others. For most organisations these are the ones below. Each needs a stated treatment, even if the treatment is "not in scope, controlled by X".

| Interface | Examples at {{client_name}} | How it is handled |
|---|---|---|
| Staff use of general-purpose AI tools | [Public chat assistants, coding assistants, meeting note-takers] | [Governed by the AI Policy section on general-purpose AI tools; approved tool list kept by [ROLE]; not listed as individual in-scope systems] |
| AI embedded in purchased software | [CRM lead scoring, email filtering, HR platform features] | [Recorded in the AI system register as "embedded, supplier controlled"; covered by supplier due diligence; brought into scope if it makes or supports decisions about people] |
| Suppliers of models and AI services | [NAMED MODEL API PROVIDER] | [Supplier assessment and contract clauses; supplier's own controls relied on through [ISO/IEC 42001 CERTIFICATE / SOC 2 REPORT / CONTRACTUAL COMMITMENTS]] |
| Group or parent company AI | [SHARED PLATFORM OPERATED BY PARENT] | [Service agreement; parent's responsibilities shown in AIMS Roles, Responsibilities and Authorities] |

A new interface found during the year is logged and assessed under the AIMS Change Planning Procedure.

## 6. Exclusions

| Excluded item | Justification | Control that stops it drifting into use unmanaged |
|---|---|---|
| [e.g. Research sandbox models] | [No production data, no customer exposure, no decisions about people] | [Promotion to pilot requires registration in the AI system register and an AI system impact assessment] |
| [e.g. Subsidiary X] | [Separate legal entity with its own management and no shared AI systems] | [Group AI Policy applies; re-checked at each scope review] |

An exclusion is acceptable only if it does not affect {{client_name}}'s ability to meet its AIMS requirements or its obligations to interested parties. Exclusions of Annex A controls are recorded in the Statement of Applicability, not here.

## 7. Basis for this scope

This scope was set using:

- the internal and external issues and the organisation's AI roles in the AIMS Context and Interested Parties Register (Clause 4.1);
- the interested party requirements the AIMS will address, from the same register (Clause 4.2);
- the AI system register as at [DATE];
- the Statement of Applicability version [X.X].

## 8. Review triggers

{{document_owner}} reviews this statement {{review_period}} and also when:

- an AI system is added or retired, or its intended use changes;
- {{client_name}}'s role for a system changes (for example from customer to provider);
- a new site, business unit or legal entity starts AI activity;
- a regulation starts to apply to an in-scope system.

Changes follow the AIMS Change Planning Procedure and are approved by {{approval_authority}}.

## 9. Records produced

- Each approved version of this statement, kept in [DOCUMENT MANAGEMENT SYSTEM] for [THE CERTIFICATION CYCLE PLUS ONE YEAR].
- An entry in the AIMS change log for every scope change.
- Management review minutes that record scope decisions.

## 10. Related documents

- AIMS Context and Interested Parties Register
- AI Policy
- AIMS Roles, Responsibilities and Authorities
- AIMS Change Planning Procedure
- AI system register
- Statement of Applicability

## 11. Version history and approval

| Version | Date | Summary of change | Prepared by | Approved by |
|---|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{document_owner}} | {{approval_authority}} |
| | | | | |

| Role | Name | Signature | Date |
|---|---|---|---|
| Document owner | {{document_owner}} | | |
| Approver (top management) | {{approval_authority}} | | |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AIMS Context and Interested Parties Register',
    category: 'record',
    tier: 'expected',
    requirement_refs: ['ai-clause-4.1', 'ai-clause-4.2'],
    description: 'Register of the internal and external issues affecting the AIMS, the organisation\'s role for each AI system, interested parties and their requirements, and the legal, regulatory and contractual obligations that apply (Clauses 4.1 and 4.2).',
    content: `# AIMS Context and Interested Parties Register

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This register records what shapes {{client_name}}'s AIMS and who has a stake in it. Clause 4.1 requires the organisation to determine the internal and external issues that affect its ability to achieve the intended results of the AIMS, and to determine its role in relation to the AI systems it works with. Clause 4.2 requires it to identify the interested parties relevant to the AIMS, their relevant requirements, and which of those requirements the AIMS will address.

The register feeds the AIMS Scope Statement, the AI risk assessment, the AI system impact assessments and the AI objectives. An auditor will pick two or three rows and follow them to a risk, an objective or a control. Rows that lead nowhere suggest the register was written for the audit.

## 2. Scope

Covers the AIMS scope defined in the AIMS Scope Statement. Rows marked "(Example)" show the level of detail expected. Replace them with {{client_name}}'s own entries.

## 3. How the register is maintained

- {{document_owner}} maintains the register and runs a context workshop with [AI GOVERNANCE COMMITTEE MEMBERS, LEGAL, PRODUCT, DATA SCIENCE, HR] {{review_period}}.
- Every row has an owner who confirms at each review that it is still current.
- The "Addressed in" column points to something specific: a risk ID, objective ID, Annex A control, impact assessment reference, or a recorded decision to take no action.
- Workshop notes and attendance are filed with the register as evidence of how the issues were determined.

## 4. Internal and external issues (Clause 4.1)

| ID | Issue | Type | Why it matters for AI | Source | Addressed in | Owner |
|---|---|---|---|---|---|---|
| EXT-01 (Example) | The EU AI Act classes [AI-03 CV screening] as a high-risk use; deployer duties apply from [DATE] | External, regulatory | Requires human oversight, use in line with the provider's instructions, logging and information to affected people | [Legal opinion dated DATE] | [Risk R-07; Objective OBJ-04; A.9.2] | [LEGAL LEAD] |
| EXT-02 (Example) | Reliance on one foundation model supplier whose model versions and terms change at short notice | External, supplier | Output quality and data handling can change with no internal change | [Supplier review, DATE] | [Risk R-03; A.10.3] | [ML LEAD] |
| INT-01 (Example) | Few staff outside data science understand model limits | Internal, competence | Operators may over-trust outputs, which weakens human oversight | [Training needs analysis] | [Objective OBJ-02; AI Competence and Awareness Plan] | [AIMS MANAGER] |
| [ID] | | | | | | |

Other issues to consider: customer procurement requirements, public and media expectations about AI, availability of representative data, compute cost and environmental footprint, AI-specific security threats (prompt injection, data poisoning, model theft), risk appetite and culture, and other management systems in place (ISO/IEC 27001, ISO 9001, privacy programme).

## 5. Organisation's role per AI system (Clause 4.1)

Roles use ISO/IEC 22989 terms. Obligations differ by role, and the role drives which Annex A controls apply.

| AI system (inventory ID) | AI provider | AI producer (developer) | AI customer (user) | AI partner | Notes |
|---|---|---|---|---|---|
| [AI-01] (Example) | Yes | Yes | No | No | [Built in-house and supplied to customers inside PRODUCT] |
| [AI-02] (Example) | No | Partly (prompt and retrieval layer) | Yes | No | [Uses SUPPLIER model through an API] |
| [AI-03] (Example) | No | No | Yes | No | [Feature of the HR platform; the platform vendor is the provider] |

AI subjects, meaning people affected by a system's outputs, are listed as interested parties in section 6.

## 6. Interested parties (Clause 4.2)

| ID | Interested party | Relevant requirements and expectations | Addressed by the AIMS? | How | Owner |
|---|---|---|---|---|---|
| IP-01 (Example) | Job applicants screened by [AI-03], who never use the system themselves | Fair treatment; told that AI is used; can ask for a human review | Yes | [Impact assessment IA-03; applicant notice; recruiter review of every rejection] | [HR DIRECTOR] |
| IP-02 (Example) | Enterprise customers of [PRODUCT] | AI governance evidence in due diligence; notice of material model changes; limits on use of their data | Yes | [AIMS Communication Plan; contract template; Statement of Applicability] | [HEAD OF CUSTOMER SUCCESS] |
| IP-03 (Example) | [DATA PROTECTION AUTHORITY] | Lawful processing of personal data in training and inference; breach notification | Yes | [DPIA linked to impact assessment; incident procedure] | [DPO] |
| IP-04 | Employees and contractors | [Clear rules for AI tools; training; a safe route to raise concerns] | [YES/NO] | | |
| IP-05 | Suppliers of models, data and AI services | [Clear requirements; consistent assessment] | | | |
| IP-06 | [Board, investors or parent company] | | | | |
| IP-07 | [Groups representing affected people, e.g. consumer or disability organisations] | | | | |

Where the AIMS does not address a requirement, record why (for example, handled by another management system or outside {{client_name}}'s control).

## 7. Legal, regulatory and contractual obligations

| ID | Obligation | Applies to | What it requires for AI | Applicable from | Where addressed | Owner |
|---|---|---|---|---|---|---|
| LEG-01 (Example) | EU AI Act (Regulation (EU) 2024/1689) | [AI-03 as deployer; AI-01 if placed on the EU market] | [Risk classification; deployer duties; transparency when people interact with AI] | [DATE PER OBLIGATION] | [A.9.2; A.8.2; impact assessment IA-03] | [LEGAL LEAD] |
| LEG-02 (Example) | [GDPR / UK GDPR / India's Digital Personal Data Protection Act 2023] | [All systems that process personal data] | [Lawful basis; notice; data principal or data subject rights, including on automated decisions; DPIA where required] | [IN FORCE] | [Privacy programme; data controls in the Statement of Applicability] | [DPO] |
| LEG-03 (Example) | [Customer master services agreement, clause X.Y] | [AI-01 for CUSTOMER] | [No training on customer data without written consent; [30] days' notice of model change] | [CONTRACT DATE] | [Data management procedure; AIMS Communication Plan] | [ACCOUNT OWNER] |
| LEG-04 | [SECTOR RULE, e.g. FINANCIAL REGULATOR MODEL RISK GUIDANCE, MEDICAL DEVICE RULES, EMPLOYMENT LAW] | | | | | |

Legal confirms applicability for each row. A row that says only "applicable AI laws" will not satisfy an auditor: name the instrument and the obligation.

## 8. Review triggers

Besides the scheduled review, update the register within [30 DAYS] when:

- a new AI system is proposed or an existing one changes its intended use or market;
- a law, regulation or regulator guidance affecting AI is published or comes into force;
- a significant AI incident, complaint or audit finding occurs;
- a major customer, supplier or ownership change happens.

## 9. Records produced

- This register with its version history, kept in [DOCUMENT MANAGEMENT SYSTEM].
- Context workshop notes and attendance lists.
- Management review minutes showing that changes in issues and interested party requirements were considered.

## 10. Related documents

- AIMS Scope Statement
- AI Policy
- AI Objectives and Measurement Plan
- AIMS Communication Plan
- AI Risk Assessment Methodology
- AI System Impact Assessment Procedure

## 11. Review and approval

| Version | Date | Summary of change | Reviewed by | Approved by |
|---|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{document_owner}} | {{approval_authority}} |
| | | | | |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AI Policy',
    category: 'policy',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-5.2', 'ai-annex-a-2-2', 'ai-annex-a-2-3', 'ai-annex-a-2-4'],
    description: 'Top-level AI policy approved by top management: purpose, commitments, principles for AI activities, prohibited uses, the risk-based approach, alignment with other policies, exceptions and review (Clause 5.2; Annex A.2.2 to A.2.4). Mandatory.',
    content: `# AI Policy

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

{{client_name}} uses AI to [STATE THE BUSINESS PURPOSE, e.g. SPEED UP CLAIMS HANDLING, IMPROVE CUSTOMER SUPPORT AND OFFER AI FEATURES IN (PRODUCT)]. This policy sets out how {{client_name}} develops, provides and uses AI systems so that this purpose is met without unacceptable harm to customers, staff, the people affected by AI outputs, or the organisation.

Clause 5.2 requires top management to set an AI policy that fits the organisation's purpose, gives a framework for AI objectives, and commits to meeting applicable requirements and to continual improvement. Annex A.2.2 asks for the policy to be documented, A.2.3 for it to be aligned with other policies, and A.2.4 for it to be reviewed at planned intervals.

## 2. Scope

This policy applies to:

- all AI systems within the AIMS scope defined in the AIMS Scope Statement, whatever {{client_name}}'s role for them (provider, producer, customer or partner);
- all employees, contractors and temporary staff who design, build, buy, deploy, operate, oversee or use AI systems for {{client_name}};
- use of general-purpose AI tools by staff for {{client_name}} work (section 7).

## 3. Commitments

Top management of {{client_name}} commits to:

- meet the legal, regulatory and contractual requirements that apply to its AI systems, as recorded in the AIMS Context and Interested Parties Register;
- set AI objectives consistent with this policy, measure them and review them in management review (see the AI Objectives and Measurement Plan);
- provide the people, budget, tools and data the AIMS needs;
- assess AI risks and the impact of AI systems on individuals, groups and society before deployment and after significant change;
- continually improve the AIMS.

## 4. Principles for AI activities

| Principle | What it means in practice at {{client_name}} |
|---|---|
| Accountability | Every in-scope AI system has a named system owner in the AI system register. Decisions to deploy, accept residual risk, suspend or retire a system are recorded with the approver's name and date. |
| Transparency | People are told when they are interacting with an AI system, or when AI contributes materially to a decision about them. System documentation states intended use, known limits and measured performance. |
| Explainability | Where a system supports decisions about people, the reviewer and, where required, the affected person can get an explanation suited to them of the main factors behind the output. |
| Fairness | Systems that make or support decisions about people are tested for unwanted bias across [RELEVANT GROUPS] before release and monitored after release against thresholds in the AI Objectives and Measurement Plan. |
| Safety and reliability | Systems meet defined acceptance criteria before release, are monitored in operation, and the system owner can suspend them without further approval. |
| Human oversight | Where a system makes or supports decisions with significant effects on people, a competent person can review, override or stop it. Override and review rates are monitored. |
| Privacy | Personal data used for training, fine-tuning, prompts or inference has a lawful basis and follows the [PRIVACY POLICY]. |
| Security | AI systems are covered by information security controls, including AI-specific threats such as prompt injection, data poisoning and model extraction. |
| [Environmental responsibility] | [Compute and energy use are considered when selecting and retraining models. KEEP, CHANGE OR DELETE.] |

## 5. Prohibited uses

{{client_name}} will not develop, provide or use AI systems for:

- [social scoring of individuals];
- [manipulating people through techniques that bypass their awareness, or exploiting vulnerabilities such as age or disability];
- [inferring emotions of staff at work, or biometric categorisation by sensitive characteristics];
- [fully automated decisions with legal or similarly significant effects on a person without a human review route];
- [ADD ANY SECTOR OR COMPANY-SPECIFIC PROHIBITIONS].

No exception can be granted to this section.

## 6. Risk-based approach

The controls applied to an AI system depend on its risk level, set in the AI risk assessment and AI system impact assessment.

| Risk level | Typical examples | Minimum before deployment | Approval |
|---|---|---|---|
| High | Systems that make or support decisions on employment, credit, insurance, health or access to essential services; safety functions | Full AI risk assessment and impact assessment; documented human oversight; fairness and performance testing; monitoring plan | [NAME OF AI GOVERNANCE COMMITTEE]; residual risk above appetite signed by top management |
| Medium | Customer-facing assistants; internal decision support with human review | Risk assessment; impact assessment screening; testing against acceptance criteria; user information | AI system owner and AIMS manager |
| Low | Internal productivity uses with no personal or confidential data | Registration in the AI system register; approved tool | AIMS manager or delegate |

## 7. Use of general-purpose AI tools

- Staff use only tools on the [APPROVED AI TOOLS LIST] for {{client_name}} work.
- Personal data, customer confidential data and source code marked [CLASSIFICATION] are not entered into tools not approved for that data.
- Staff check AI output before relying on it and remain responsible for work they submit.

## 8. Roles and responsibilities

- **Top management** approves this policy, sets AI risk appetite and reviews AIMS performance.
- **{{document_owner}}** (AIMS manager) maintains this policy, runs the AIMS and reports to top management.
- **AI system owners** apply this policy to their systems.
- **All personnel** follow this policy and report AI concerns to [REPORTING CHANNEL, e.g. ai-concerns@ MAILBOX OR SPEAK-UP LINE] without fear of retaliation.

Full roles are in AIMS Roles, Responsibilities and Authorities.

## 9. Alignment with other policies (A.2.3)

| Related policy | Where it meets this policy | Alignment action and owner |
|---|---|---|
| Information Security Policy | Security of models, data and AI infrastructure | [Add AI-specific threats to the security risk register; SECURITY LEAD] |
| Privacy / Data Protection Policy | Personal data in training and inference; automated decisions | [Link DPIA to AI system impact assessment; DPO] |
| Procurement and Supplier Policy | Buying AI systems, models and data | [Add AI clauses to contract templates; PROCUREMENT LEAD] |
| HR Code of Conduct | Staff use of AI tools; disciplinary route | [Reference section 7; HR LEAD] |
| [Quality / Product Safety Policy] | [Release criteria for AI features] | [OWNER] |

Where policies conflict, the stricter requirement applies until the owners agree a change. The same definition of "AI system" is used in all of them.

## 10. Deviations and exceptions

1. The requester submits an exception request to the AIMS manager through [TICKETING TOOL OR FORM], stating the policy section, the reason, the AI system affected, compensating controls and the end date.
2. The AIMS manager assesses the risk and records the request in the exception register.
3. [NAME OF AI GOVERNANCE COMMITTEE] approves or rejects. Exceptions affecting high-risk systems also need top management sign-off.
4. Exceptions last no longer than [12 MONTHS] and are reported at each management review.

Unapproved deviations are handled as nonconformities under the corrective action process. Breaches of this policy may also lead to action under {{client_name}}'s disciplinary process or the relevant contract.

## 11. Communication and availability

- Published on [INTRANET LOCATION] and included in onboarding for all new hires and contractors.
- Staff acknowledge it on joining and [ANNUALLY] using the AI Policy Acknowledgement Record.
- A version for customers and other interested parties is available at [WEBSITE URL OR "ON REQUEST"].

The auditor will ask for evidence that the policy was communicated: the announcement, the intranet page with its date, and acknowledgement records.

## 12. Review

{{document_owner}} reviews this policy {{review_period}} and after a significant AI incident, a relevant change in law, a change of AIMS scope, or a change in {{client_name}}'s role for an AI system. Each review takes into account management review results, audit findings, incidents and changes to the AI system register, and is recorded below even when nothing changes.

## 13. Related documents

- AIMS Scope Statement
- AIMS Context and Interested Parties Register
- AIMS Roles, Responsibilities and Authorities
- AI Objectives and Measurement Plan
- AIMS Communication Plan
- AI Competence and Awareness Plan
- AI Policy Acknowledgement Record

## 14. Review and approval record

| Version | Review date | Reviewed by | Summary of changes (or "no change") | Approved by | Approval date |
|---|---|---|---|---|---|
| [1.0] | {{date}} | {{document_owner}} | [Initial issue] | {{approval_authority}} | [DATE] |
| | | | | | |

Approved on behalf of top management:

| Name | Title | Signature | Date |
|---|---|---|---|
| {{approval_authority}} | [e.g. CHIEF EXECUTIVE OFFICER] | | |
| [NAME] | [e.g. CHAIR, NAME OF AI GOVERNANCE COMMITTEE] | | |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AIMS Roles, Responsibilities and Authorities',
    category: 'record',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-5.1', 'ai-clause-5.3', 'ai-annex-a-3-2'],
    description: 'How top management shows leadership of the AIMS, the named AIMS and AI lifecycle roles with their responsibilities and authorities, a RACI across AIMS activities, and the appointment record (Clauses 5.1 and 5.3; Annex A.3.2). Mandatory.',
    content: `# AIMS Roles, Responsibilities and Authorities

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This document records who does what in {{client_name}}'s AIMS and who can decide what. Clause 5.1 requires top management to show leadership of the AIMS. Clause 5.3 requires top management to assign and communicate responsibilities and authorities for relevant roles, including someone responsible for the AIMS meeting the standard and someone reporting its performance to top management. Annex A.3.2 asks for roles for AI across the lifecycle to be defined and allocated to fit the organisation's needs.

The auditor will test this document against real decisions: they pick a deployment approval, a risk acceptance or an incident and check it was made by the role named here.

## 2. Scope

Covers all roles that affect the AIMS and the AI systems within the AIMS scope defined in the AIMS Scope Statement, including roles held by contractors or a parent company.

## 3. Top management commitment (Clause 5.1)

| Commitment | How {{client_name}} shows it | Evidence the auditor can see |
|---|---|---|
| AI policy and objectives set and consistent with strategy | [CEO] approves the AI Policy and AI objectives | Signed AI Policy; approved objectives plan |
| AIMS built into business processes | AI risk and impact assessment are gates in [PRODUCT RELEASE / PROCUREMENT] processes | Release checklist; procurement workflow |
| Resources available | AIMS budget line and named staff | Budget record; appointment records below |
| Importance of the AIMS communicated | [CEO] message at launch and [ANNUALLY] | Dated email, intranet post or all-hands slides |
| AIMS achieves its intended results | Top management chairs management review | Signed management review minutes |
| Staff directed and supported; continual improvement promoted | Decisions on escalations, exceptions and improvement actions | Governance committee minutes; action log |

## 4. Roles, responsibilities and authorities

| Role | Held by | Responsibilities | Authorities |
|---|---|---|---|
| Top management (executive sponsor) | [NAME, TITLE] | Approves AI Policy, scope and objectives; sets AI risk appetite; provides resources; chairs management review | Accepts residual AI risk above [THRESHOLD]; refuses or suspends an AI use case; approves AIMS budget |
| AIMS manager | {{document_owner}} | Runs the AIMS day to day; maintains documented information; coordinates risk and impact assessments; tracks objectives; reports AIMS performance to top management | Requires an assessment before deployment; escalates to top management; stops an AIMS change without approval |
| [NAME OF AI GOVERNANCE COMMITTEE] | [MEMBERS BY ROLE] | Reviews high-risk use cases, impact assessments, deployment requests, incidents and exceptions | Approves or rejects deployment of high-risk systems; grants policy exceptions; requires more testing |
| AI system owner (one per system) | Named in the AI system register | Accountable for one system across its lifecycle: intended use, risk treatment, monitoring, human oversight, retirement | Approves changes to medium and low risk systems; suspends the system; accepts risk within [DELEGATED LIMIT] |
| Data owner | [NAME PER DATASET] | Data quality, provenance, lawful basis and preparation records | Approves use of a dataset for training or testing; rejects data that fails quality criteria |
| ML lead / model developer | [NAME] | Designs, builds and documents models; applies responsible development objectives | Chooses methods within approved requirements; holds a release that fails tests |
| Verification and validation lead | [NAME, independent of the developer for high-risk systems] | Tests against acceptance criteria, including fairness and reliability | Withholds validation sign-off |
| Human oversight reviewer | [ROLE PER SYSTEM] | Reviews outputs as designed; records overrides; reports anomalies | Overrides or rejects an AI output; escalates to the system owner |
| Risk owner | [NAME PER RISK] | Owns treatment of assigned AI risks | Accepts risk within delegated limit; proposes treatment |
| DPO / privacy lead | [NAME] | Privacy review; links DPIAs to impact assessments; data subject requests about AI | Requires a DPIA; blocks processing without a lawful basis |
| Information security lead | [NAME] | Security controls for AI systems; AI-specific threats; security incidents | Requires security testing; isolates a compromised system |
| Legal and compliance | [NAME] | Maintains legal obligations; reviews external AI statements | Approves regulatory notifications and public claims about AI |
| Procurement / supplier manager | [NAME] | Due diligence and contract clauses for AI suppliers | Holds contract signature until assessment is complete |
| Internal auditor | [NAME OR FIRM, independent of the area audited] | Plans and performs AIMS internal audits | Access to any AIMS record or person |
| All personnel | Everyone | Follow the AI Policy; report AI concerns and incidents | Stop using an AI output they believe is wrong and report it |

### 4.1 Annex A.3.2 areas and who is accountable

| Area | Accountable role |
|---|---|
| AI risk management; AI system impact assessment | AI system owner, coordinated by the AIMS manager |
| Resources and assets for AI | Top management; AIMS manager |
| Security; privacy; safety | Information security lead; DPO; AI system owner |
| Development; performance | ML lead; AI system owner |
| Human oversight | AI system owner, through human oversight reviewers |
| Suppliers | Procurement / supplier manager |
| Meeting legal obligations | Legal and compliance |
| Data quality | Data owner |

### 4.2 Segregation of duties

For high-risk systems the person who develops a model does not validate it or approve its deployment. Where headcount does not allow this, [DESCRIBE COMPENSATING CONTROL, e.g. INDEPENDENT REVIEW BY THE GOVERNANCE COMMITTEE].

## 5. RACI matrix

A = accountable (one per activity; where the accountable role also does the work, only A is shown), R = responsible, C = consulted, I = informed.

| Activity | Top mgmt | AIMS mgr | Gov. cttee | System owner | ML lead | V&V lead | Data owner | Oversight | Privacy | Security | Procurement | Int. audit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AI risk assessment | I | R | C | A | C | | C | | C | C | | |
| AI system impact assessment | I | R | C | A | C | | C | C | C | | | |
| Design and development | | I | | A | R | C | C | C | C | C | | |
| Verification and validation | | I | | A | C | R | C | | | C | | |
| Deployment approval (high risk) | I | C | A | R | C | C | | | C | C | | |
| Deployment approval (medium, low) | | C | I | A | R | C | | | | | | |
| Operation and monitoring | | I | | A | R | | C | R | | C | | |
| AI incident handling | I | C | I | A | R | | | R | C | R | | |
| Supplier assessment | | C | I | R | C | | | | C | C | A | |
| Data quality | | I | | C | C | C | A | | C | | | |
| Internal audit | I | C | I | C | C | | | | | | | A |
| Management review | A | R | C | C | | | | | C | C | | C |

## 6. Reporting AIMS performance

The AIMS manager reports to top management [QUARTERLY] through [NAME OF AI GOVERNANCE COMMITTEE] and in full at each management review. The report covers objectives, risks, incidents, audit results, exceptions and resource needs.

## 7. Appointment record

| Role | Name | Appointed by | Date appointed | Date role communicated to holder | Acknowledged (Y/N) |
|---|---|---|---|---|---|
| AIMS manager | {{document_owner}} | {{approval_authority}} | {{date}} | | |
| [ROLE] | | | | | |

## 8. Records produced

- This document with the appointment record, kept in [DOCUMENT MANAGEMENT SYSTEM].
- Appointment emails or letters, and the org chart published on [INTRANET].
- Governance committee and management review minutes showing decisions by the roles above.

## 9. Related documents

- AI Policy
- AIMS Scope Statement
- AI Competence and Awareness Plan
- AI Objectives and Measurement Plan
- AI system register

## 10. Review and approval

Reviewed {{review_period}} and whenever a role holder changes. A change of holder is recorded in section 7 within [10 WORKING DAYS].

| Version | Date | Summary of change | Approved by |
|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{approval_authority}} |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AI Objectives and Measurement Plan',
    category: 'plan',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-6.2', 'ai-clause-9.1', 'ai-annex-a-6-1-2', 'ai-annex-a-9-3'],
    description: 'AI objectives consistent with the AI policy, the plan to achieve each one, objectives for responsible development and responsible use of AI systems, and how results are monitored, measured and evaluated (Clauses 6.2 and 9.1; Annex A.6.1.2 and A.9.3). Mandatory.',
    content: `# AI Objectives and Measurement Plan

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This plan turns the AI Policy into targets that can be checked. Clause 6.2 requires AI objectives that are consistent with the AI policy, measurable where practicable, monitored, communicated and updated, with a plan saying what will be done, with what resources, by whom, by when and how results are evaluated. Clause 9.1 requires the organisation to decide what it monitors and measures, how, when, and when results are analysed and evaluated. Annex A.6.1.2 and A.9.3 ask for documented objectives that guide responsible development and responsible use of AI systems.

The auditor will ask for the objectives, the latest results against target, and management review minutes where they were discussed.

## 2. Scope

AIMS-level objectives (section 4) apply across the AIMS scope defined in the AIMS Scope Statement. System-level objectives (sections 5 and 6) apply to the AI systems named in each row.

## 3. Roles

- **Top management** approves the objectives and reviews results in management review.
- **{{document_owner}}** maintains this plan, collects results and reports them.
- **Objective owners** deliver their objective and report results on time.
- **AI system owners** build development and use objectives into requirements, tests and operating procedures.

## 4. AIMS objectives

| ID | Objective | Measure / KPI | Target | Owner | Resources | Due date | How results are evaluated | Reporting |
|---|---|---|---|---|---|---|---|---|
| OBJ-01 (Example) | Every in-scope AI system has a current impact assessment | % of systems in the AI system register with an impact assessment done before deployment and after each significant change | [100%] | AIMS manager | [0.2 FTE; assessment template] | [DATE] | Quarterly inventory check against the assessment register | [QUARTERLY] to governance committee |
| OBJ-02 (Example) | Staff who build, operate or oversee AI are trained for their role | % of role holders completing role training within [60] days of starting the role | [95%] | [L&D LEAD] | [LMS; course licences] | [DATE] | LMS report reconciled to HR starters list | [QUARTERLY] |
| OBJ-03 (Example) | AI incidents and concerns are dealt with promptly | Median time from report to triage | [2 WORKING DAYS] | [INCIDENT MANAGER] | [Ticket queue] | [DATE] | Ticket data reviewed by AIMS manager | [QUARTERLY] |
| [OBJ-04] | | | | | | | | |

## 5. Responsible development objectives (A.6.1.2)

These objectives become requirements and acceptance criteria for systems {{client_name}} develops or customises. Design reviews and release decisions refer to them by ID.

| ID | Objective | Applies to | Requirement or acceptance criterion | How verified | Evidence |
|---|---|---|---|---|---|
| DEV-01 (Example) | Fairness | Systems that make or support decisions about people | Selection-rate ratio between [GROUPS] not below [0.8]; error-rate gap not above [X] points on the validation set | Fairness tests in the validation suite | Validation report |
| DEV-02 (Example) | Reliability under changed input | [AI-01] | Accuracy drop no more than [X%] on the stress-test set (noisy, incomplete and out-of-distribution inputs) | Stress test before each release | Test report |
| DEV-03 (Example) | Explainability | [AI-01] | Each score shown to reviewers lists the top [3] contributing factors | Review of [20] sampled cases per release | Review record |
| DEV-04 | Documentation | All developed systems | System documentation (intended use, limits, performance) complete before release | Release checklist | Documentation in [REPOSITORY] |

## 6. Responsible use objectives (A.9.3)

| ID | Objective | Applies to | Target | How measured | Owner |
|---|---|---|---|---|---|
| USE-01 (Example) | Human review of adverse outcomes | [AI-03] | [100%] of AI-recommended rejections reviewed by a recruiter before the applicant is told | Workflow log | [HR DIRECTOR] |
| USE-02 (Example) | Oversight is real, not a rubber stamp | [AI-01] | Override rate tracked monthly; a rate outside [5% TO 30%] triggers a review | Oversight dashboard | System owner |
| USE-03 (Example) | Use stays within intended purpose | All systems | No use outside documented intended use found in [QUARTERLY] sample | Sample of [25] cases per system | AIMS manager |
| USE-04 | Users know they are dealing with AI | Customer-facing systems | [100%] of sessions show the AI disclosure | Automated check | [PRODUCT OWNER] |

## 7. Monitoring, measurement, analysis and evaluation (Clause 9.1)

| What is monitored | Method | Frequency | Measured by | Analysed and evaluated by | Reported to |
|---|---|---|---|---|---|
| AIMS objectives (section 4) | Objectives tracker | [QUARTERLY] | Objective owners | AIMS manager | Governance committee; management review |
| Development objectives (section 5) | Validation and test reports | Each release | V&V lead | AI system owner | Release approval record |
| System performance, drift and fairness in operation | Monitoring dashboard with alert thresholds | [CONTINUOUS; REVIEWED WEEKLY] | ML lead | AI system owner | Governance committee [MONTHLY] |
| Use objectives (section 6) | Workflow logs and samples | [MONTHLY] | Oversight reviewers | AI system owner | Governance committee |
| Effectiveness of AIMS controls | Internal audit; control checks | Per audit programme | Internal auditor | AIMS manager | Management review |

A missed target or threshold breach is recorded in the tracker and, where the cause is not a one-off, raised as a nonconformity for corrective action.

## 8. Communication of objectives

- Objectives are published on [INTRANET PAGE] and presented at [ALL-HANDS / TEAM MEETINGS] after approval.
- Development and use objectives are included in the requirements and operating procedures of each affected system.
- Keep the dated memo, intranet post or meeting slides as evidence.

## 9. Objectives tracker

| ID | Target | Period | Result | Status (achieved / on track / at risk / missed) | Action if not met | Reported to management review on |
|---|---|---|---|---|---|---|
| OBJ-01 | [100%] | [Q1 YEAR] | | | | |
| DEV-01 | [0.8] | [RELEASE X] | | | | |
| USE-01 | [100%] | [MONTH] | | | | |

## 10. Link to management review

The tracker is an input to every management review. Top management decides whether to keep, change or retire each objective, and the decisions are minuted.

## 11. Records produced

- This plan and the objectives tracker, kept in [LOCATION] with results for [THREE YEARS].
- Validation reports, monitoring dashboards or exports, and sample review records.
- Communication evidence and management review minutes.

## 12. Related documents

- AI Policy
- AIMS Roles, Responsibilities and Authorities
- AIMS Communication Plan
- AI Competence and Awareness Plan
- AI System Lifecycle Procedure
- AIMS Management Review Procedure

## 13. Review and approval

Reviewed {{review_period}} and after each management review.

| Version | Date | Summary of change | Approved by |
|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{approval_authority}} |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AIMS Change Planning Procedure',
    category: 'procedure',
    tier: 'expected',
    requirement_refs: ['ai-clause-6.3'],
    description: 'How changes to the AI management system itself (scope, policy, processes, roles, controls and tools) are requested, assessed, approved, carried out, communicated and logged (Clause 6.3).',
    content: `# AIMS Change Planning Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

Clause 6.3 requires that when {{client_name}} decides its AIMS needs to change, the change is carried out in a planned way. This procedure sets out how that planning happens and what record it leaves, so that a change to the management system does not break something else in it.

## 2. Scope

This procedure covers changes to the AIMS itself. Changes to individual AI systems follow a different route.

| Change | Examples | Procedure |
|---|---|---|
| AIMS change (this procedure) | Scope; AI Policy; AIMS processes and procedures; roles and committees; Annex A control selection; AIMS tools (risk register, LMS, monitoring platform); risk criteria and appetite | AIMS Change Planning Procedure |
| AI system change | Retraining, new data, new model version, prompt changes, new intended use or market, retirement | AI System Lifecycle Procedure and {{client_name}}'s change management process |

If an AI system change also changes the AIMS (for example, a new intended use brings a new regulation into scope), both routes apply and the change records cross-refer.

## 3. Roles and responsibilities

- **Requester**: anyone who identifies the need; completes the change request.
- **{{document_owner}}** (AIMS manager): assesses the change, plans it, keeps the change log.
- **Approver**: set by change class in section 5.
- **Owners of affected documents and processes**: update them and confirm completion.

## 4. Triggers

A change request is raised when any of these happens:

- management review or internal audit decides a change is needed;
- a corrective action requires a change to the AIMS;
- AIMS scope changes (new AI system, business unit, site or role);
- a new or amended law, regulation or contract obligation affects the AIMS;
- an organisational change affects AIMS roles (restructure, key leaver, acquisition);
- an AIMS tool is replaced or retired.

## 5. Change classes

| Class | Examples | Approver |
|---|---|---|
| Minor | Wording clarification; template layout; updating a named contact | AIMS manager |
| Significant | New or changed procedure; role reallocation; change to risk criteria; new AIMS tool | [NAME OF AI GOVERNANCE COMMITTEE] |
| Major | Scope change; AI Policy change; change of risk appetite; change affecting the certificate | Top management ({{approval_authority}}); certification body informed where required |

## 6. Procedure

1. **Raise.** The requester records the change in the AIMS change log with a description and the trigger. Record: change log entry.
2. **Assess.** Within [10 WORKING DAYS] the AIMS manager records, on the change request:
   - the purpose of the change and the expected result;
   - its possible consequences, including new AI risks or effects on impact assessments;
   - how the AIMS continues to work during and after the change (which processes, controls, records and objectives are affected);
   - the resources needed (people, budget, tools, time);
   - any responsibilities that move, and who takes them on.
3. **Classify and approve.** The AIMS manager sets the class (section 5). The approver approves, rejects or asks for more information. Record: approval on the change request or in minutes.
4. **Plan.** The AIMS manager agrees tasks, owners and dates with the owners of affected documents and processes. Record: plan in the change request.
5. **Implement.** Owners update documents, tools and records. Document versions are raised under the documented information rules.
6. **Communicate.** The AIMS manager tells the people affected, using the AIMS Communication Plan. Training needs go to the AI Competence and Awareness Plan. Record: communication evidence.
7. **Verify and close.** Within [30 DAYS] of implementation the AIMS manager checks the change worked as intended and nothing else broke, then closes the entry. Record: closure note in the change log.
8. **Report.** Changes completed since the last review are reported at management review.

Urgent changes (for example, to meet a regulatory deadline) can be implemented on approval from the AIMS manager and one top management member, with steps 2 and 7 completed within [10 WORKING DAYS] afterwards.

## 7. AIMS change log

| Change ID | Date raised | Requester | Description and trigger | Class | Consequences and affected parts of the AIMS | Resources | Approved by and date | Implementation owner and due date | Communicated (date, how) | Verified and closed (date) |
|---|---|---|---|---|---|---|---|---|---|---|
| CHG-001 (Example) | [DATE] | [NAME] | Add AI-03 CV screening to scope after pilot approval | Major | Scope Statement, SoA, context register, RACI; new impact assessment | [0.1 FTE for 1 month] | [NAME, DATE] | [NAME, DATE] | [Email to HR and governance committee, DATE] | [DATE] |
| CHG-002 | | | | | | | | | | |
| CHG-003 | | | | | | | | | | |

## 8. Records produced

- The AIMS change log and change requests, kept in [LOCATION] for [THREE YEARS].
- Approval records (signed requests or minutes).
- Updated document versions and communication evidence.

The auditor may pick a recent AIMS change and trace it from request through approval to communication.

## 9. Related documents

- AIMS Scope Statement
- AI Policy
- AIMS Roles, Responsibilities and Authorities
- AIMS Communication Plan
- AI Competence and Awareness Plan
- AI System Lifecycle Procedure

## 10. Review and approval

Reviewed {{review_period}}.

| Version | Date | Summary of change | Approved by |
|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{approval_authority}} |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AIMS Communication Plan',
    category: 'plan',
    tier: 'expected',
    requirement_refs: ['ai-clause-7.4'],
    description: 'Internal and external communication matrix for the AIMS (what, why, audience, when, channel, who communicates and the record kept), the approval route for external statements about AI, and evidence retention (Clause 7.4).',
    content: `# AIMS Communication Plan

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

Clause 7.4 requires {{client_name}} to decide what it communicates about the AIMS internally and externally, when, to whom and how. This plan records those decisions and who is allowed to speak for {{client_name}} on AI matters.

## 2. Scope

Covers communication about the AIMS and the AI systems within the AIMS scope defined in the AIMS Scope Statement. Crisis communication for non-AI events follows [CRISIS COMMUNICATION PLAN].

## 3. Roles and responsibilities

- **{{document_owner}}** (AIMS manager) maintains this plan and keeps communication evidence.
- **Top management** communicates the AI Policy and the importance of the AIMS.
- **Legal and compliance** approves regulator communication and public claims about AI.
- **[COMMUNICATIONS / MARKETING LEAD]** publishes approved external statements.
- **AI system owners** provide transparency information for their systems.

## 4. Internal communication

| What | Why | Audience | When | Channel | Who communicates | Record kept |
|---|---|---|---|---|---|---|
| AI Policy and changes to it | Staff must know and follow it | All staff and contractors | On approval; on onboarding; [ANNUALLY] | [Intranet, email, LMS] | Top management | Email, intranet post, acknowledgements |
| AI objectives and results | Staff know what is expected and how it is going | All staff; objective owners | After approval; [QUARTERLY] | [All-hands, team meetings] | AIMS manager | Slides, meeting notes |
| AIMS roles and changes to them | People know who decides | All staff | On change | [Org chart, intranet] | AIMS manager | Published org chart with date |
| AI incidents and lessons learned | Prevent repeats | Affected teams; governance committee | Within [5 WORKING DAYS] of closure | [Email, meeting] | AI system owner | Incident record, email |
| AIMS changes | People affected can act | Affected owners and teams | Before implementation | [Email, meeting] | AIMS manager | Change log entry |
| How to raise AI concerns | Problems surface early | All staff | Onboarding; [ANNUALLY] | [Intranet, training] | AIMS manager | Training content |
| AIMS performance | Leadership oversight | Top management | [QUARTERLY]; management review | Report and meeting | AIMS manager | Report, minutes |

## 5. External communication

| What | Why | Audience | When | Channel | Who communicates | Record kept |
|---|---|---|---|---|---|---|
| Transparency information (AI in use, intended use, limits, how to get human review) | Users and affected people can make informed choices | Users and AI subjects | Before and at the point of use | [Product UI, notices, website] | AI system owner, approved by Legal | Published notice with version and date |
| Material change to an AI system | Contract and trust | Customers | [30] days before, or as the contract says | [Email, release notes] | [ACCOUNT MANAGEMENT] | Sent notice |
| AI incident affecting customers or AI subjects | Contract and legal duties | Affected customers or individuals | [WITHIN CONTRACT OR LEGAL TIMELINE] | [Email, letter] | [NAMED ROLE], approved by Legal | Notice and send log |
| Regulator notification or response | Legal duty | [NAMED AUTHORITY] | As the law requires | Official channel | Legal and compliance | Submission and acknowledgement |
| Public AI Policy or AI principles | Interested party expectations | Public | On approval | [Website] | Communications lead | Web page with date |
| Supplier requirements | Suppliers know what is expected | AI suppliers | At contract and renewal | Contract, questionnaire | Procurement | Contract, questionnaire |
| Certification status | Customer assurance | Customers, prospects | After certification | [Website, sales material] | Communications lead | Approved copy |

## 6. Approval route for external statements about AI

1. The author drafts the statement and sends it to the AIMS manager.
2. The AIMS manager checks it against the facts (inventory, test results, SoA, certificate scope).
3. Legal and compliance approves wording for regulators, contracts and public claims.
4. [TOP MANAGEMENT MEMBER] approves statements about incidents or anything likely to attract media attention.
5. The communications lead publishes and files the approved version.

No one else speaks for {{client_name}} to media or regulators about AI. Staff pass enquiries to [CONTACT].

## 7. Evidence retention

Emails, memos, intranet posts (with a dated screenshot or page history), meeting slides and minutes, notices to customers and regulator correspondence are kept in [LOCATION] for [THREE YEARS]. The auditor will sample items from sections 4 and 5, for example the AI Policy launch message and a customer change notice.

## 8. Records produced

- This plan and its version history.
- The communication evidence described in section 7.
- Approval records for external statements.

## 9. Related documents

- AI Policy
- AIMS Roles, Responsibilities and Authorities
- AI Objectives and Measurement Plan
- AIMS Change Planning Procedure
- AI Competence and Awareness Plan
- AIMS Context and Interested Parties Register

## 10. Review and approval

Reviewed {{review_period}} and after any significant AI incident.

| Version | Date | Summary of change | Approved by |
|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{approval_authority}} |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AI Competence and Awareness Plan',
    category: 'plan',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-7.1', 'ai-clause-7.2', 'ai-clause-7.3'],
    description: 'Resources for the AIMS, competence requirements per role, the AI training programme, awareness topics for all staff, onboarding, and how completion and effectiveness are tracked (Clauses 7.1 to 7.3). Mandatory.',
    content: `# AI Competence and Awareness Plan

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

Clause 7.1 requires {{client_name}} to determine and provide the resources the AIMS needs. Clause 7.2 requires it to decide what competence people doing AIMS-related work need, make sure they have it through education, training or experience, act to close gaps, check that those actions worked, and keep evidence. Clause 7.3 requires everyone working under {{client_name}}'s control to be aware of the AI policy, their contribution to the AIMS and what happens if they do not follow it. This plan covers all three.

The auditor samples training and acknowledgement records separately for current employees and for new hires, so both must be complete.

## 2. Scope

All employees, contractors and temporary staff within the AIMS scope defined in the AIMS Scope Statement, including external parties doing AIMS work (such as an outsourced internal auditor or a contract ML engineer).

## 3. Roles and responsibilities

- **{{document_owner}}** (AIMS manager) owns this plan and the competence matrix.
- **[L&D / HR LEAD]** runs the LMS, assigns training and produces completion reports.
- **Line managers** check their team's competence against section 5 and close gaps.
- **Top management** approves resources in section 4.

## 4. Resources for the AIMS (Clause 7.1)

| Resource | What is provided | Owner | Reviewed |
|---|---|---|---|
| People | [AIMS manager (X FTE); governance committee time; oversight reviewers] | Top management | Management review |
| Budget | [AMOUNT FOR TRAINING, TOOLS, CERTIFICATION AUDIT] | [CFO] | Annual budget |
| Tools | [Model registry; monitoring and fairness testing tools; risk register; LMS] | [ML LEAD / AIMS MANAGER] | Management review |
| Data and compute | [Test datasets; training and evaluation environments] | [DATA OWNER / IT] | Per system |
| External expertise | [Legal counsel; external auditor; ethics adviser] | AIMS manager | As needed |

## 5. Competence requirements by role (Clause 7.2)

| Role | Required competence | How acquired | Evidence |
|---|---|---|---|
| AIMS manager | ISO/IEC 42001 requirements; AI risk and impact assessment; audit readiness | [Lead implementer course; experience] | Certificate; CV |
| AI system owner | System's intended use and limits; risk acceptance; oversight design | [Internal course; briefing per system] | LMS record; signed briefing |
| ML lead / model developer | ML engineering; fairness and reliability testing; documentation; secure development | [Degree or experience; responsible AI course] | CV; LMS record; code review records |
| V&V lead | Test design; statistical evaluation; bias metrics | [Experience; course] | CV; test reports |
| Human oversight reviewer | How the system works; common failure modes; when and how to override | [System-specific training before first shift] | LMS record; supervisor sign-off |
| Data owner | Data quality, provenance and privacy requirements | [Internal course] | LMS record |
| Internal auditor | ISO/IEC 42001; audit technique (ISO 19011); independence | [Internal auditor course] | Certificate |
| All staff | AI Policy; approved tools; reporting concerns | Awareness module | LMS record; acknowledgement |

Line managers review each role holder against this table on appointment and [ANNUALLY]. Gaps are recorded in the training log with the action and due date.

## 6. Training programme

| Course | Audience | Frequency | Delivery | Owner |
|---|---|---|---|---|
| AI awareness and AI Policy | All staff, contractors and new hires | On joining (within [30 DAYS]); [ANNUALLY] | [LMS e-learning, 20 minutes] | AIMS manager |
| Responsible AI development | Data science, ML and product teams | On joining the role; [ANNUALLY] | [Workshop] | ML lead |
| Human oversight for [AI SYSTEM] | Oversight reviewers | Before first use; on system change | [Hands-on session] | AI system owner |
| AI risk and impact assessment | System owners, risk owners, governance committee | On appointment; on method change | [Workshop] | AIMS manager |
| Safe use of general-purpose AI tools | All staff using approved tools | On access; [ANNUALLY] | [LMS] | [SECURITY LEAD] |

## 7. Awareness (Clause 7.3)

Everyone in scope must know:

- that the AI Policy exists, where to find it and its main rules (principles, prohibited uses, approved tools);
- how their own work affects the AIMS, for example checking AI output before sending it to a customer;
- what happens if they do not follow the policy: harm to people, legal exposure, and disciplinary action;
- how to report an AI concern or incident: [REPORTING CHANNEL].

Awareness is reinforced through [INTRANET PAGE, TEAM BRIEFINGS, LEADERSHIP MESSAGES].

## 8. New hires and contractors

HR adds the AI awareness module and the AI Policy acknowledgement to the onboarding checklist. Both are completed within [30 DAYS] of the start date and before the person gets access to any in-scope AI system. Role-specific training is completed before the person works unsupervised on AIMS tasks.

## 9. Tracking completion

| Name | Role | Employee / contractor | Course | Date assigned | Date completed | Score (if assessed) | Gap closed (Y/N) |
|---|---|---|---|---|---|---|---|
| [NAME] | [ROLE] | [EMPLOYEE] | AI awareness and AI Policy | [DATE] | [DATE] | [85%] | Y |
| | | | | | | | |

[L&D LEAD] sends overdue lists to line managers [MONTHLY] and reports completion rates to the AIMS manager [QUARTERLY].

## 10. Evaluating effectiveness

- Assessed modules have a pass mark of [80%].
- Line managers confirm new oversight reviewers apply the training correctly after [FIRST 4 WEEKS].
- The AIMS manager reviews incidents, audit findings and override data for signs of competence gaps and updates training.
- Completion rates and effectiveness results go to management review.

## 11. Records produced

- Competence matrix and training log (LMS export), kept for [DURATION OF EMPLOYMENT PLUS X YEARS].
- CVs, certificates and supervisor sign-offs for AIMS roles.
- AI Policy acknowledgements.

## 12. Related documents

- AI Policy
- AI Policy Acknowledgement Record
- AIMS Roles, Responsibilities and Authorities
- AI Objectives and Measurement Plan
- AIMS Communication Plan

## 13. Review and approval

Reviewed {{review_period}} and when roles, AI systems or the AI Policy change.

| Version | Date | Summary of change | Approved by |
|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{approval_authority}} |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },

  {
    name: 'AI Policy Acknowledgement Record',
    category: 'form',
    tier: 'expected',
    requirement_refs: ['ai-clause-7.3'],
    description: 'Acknowledgement statement signed by employees and contractors confirming they have read the AI Policy and know how to report AI concerns, with a log of acknowledgements for new hires and annual re-acknowledgement (Clause 7.3).',
    content: `# AI Policy Acknowledgement Record

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This form records that people working for {{client_name}} have read the AI Policy and know how to report AI concerns. It is one of the pieces of evidence for awareness under Clause 7.3.

## 2. When acknowledgement is needed

- New employees and contractors: within [30 DAYS] of starting and before access to any in-scope AI system.
- Existing staff: [ANNUALLY], and within [30 DAYS] of a new major version of the AI Policy.

## 3. Acknowledgement statement

> I confirm that:
>
> 1. I have read and understood the {{client_name}} AI Policy, version [X.X], dated [DATE].
> 2. I understand the principles, prohibited uses and rules for using AI tools that apply to my work.
> 3. I know how to report an AI concern or incident: [REPORTING CHANNEL].
> 4. I understand that not following the AI Policy may lead to action under {{client_name}}'s disciplinary process or my contract.

| Field | Entry |
|---|---|
| Full name | |
| Job title / role | |
| Employee or contractor (name of contracting firm) | |
| AI Policy version acknowledged | |
| Signature (or e-signature / LMS completion ID) | |
| Date | |

## 4. Acknowledgement log

| Name | Role | Employee / contractor | Policy version | Date acknowledged | Method (e-signature / LMS / paper) | Reason (new hire / annual / new version) | Start date (new hires) |
|---|---|---|---|---|---|---|---|
| [NAME] | [ROLE] | [EMPLOYEE] | [1.0] | [DATE] | [LMS] | [New hire] | [DATE] |
| [NAME] | [ROLE] | [CONTRACTOR, FIRM] | [1.0] | [DATE] | [E-signature] | [Annual] | |
| | | | | | | | |

## 5. Follow-up

[L&D / HR LEAD] compares the log with the HR starters list and headcount [MONTHLY]. Missing acknowledgements go to the line manager, and are escalated to the AIMS manager after [14 DAYS].

## 6. Records produced

The signed forms or LMS records, and this log, are kept in [LMS / HR SYSTEM] for [DURATION OF ENGAGEMENT PLUS X YEARS]. The auditor usually samples several new hires (checking the date against the start date) and several existing staff (checking the annual acknowledgement), so keep the start date and policy version with each entry.

## 7. Related documents

- AI Policy
- AI Competence and Awareness Plan
- AIMS Communication Plan

## 8. Review and approval

Reviewed {{review_period}} and when the AI Policy version changes.

| Version | Date | Summary of change | Approved by |
|---|---|---|---|
| [1.0] | {{date}} | [Initial issue] | {{approval_authority}} |

---
*This document is the property of {{client_name}}. Distribution follows {{client_name}}'s rules for controlling documented information.*
`,
  },
];
