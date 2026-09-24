'use strict';
// ISO/IEC 42001:2023 template pack: risk, impact and SoA planning, operational control, documented information, internal audit, management review and corrective action.
const { STARTER_NOTE, CONTROL_BLOCK } = require('./policy-templates-iso42001-common');

module.exports = [
  // ---------------------------------------------------------------------
  // 1. AI Risk Assessment Methodology
  // ---------------------------------------------------------------------
  {
    name: 'AI Risk Assessment Methodology',
    category: 'procedure',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-6.1.1', 'ai-clause-6.1.2', 'ai-clause-8.2'],
    description: 'Methodology for identifying risks and opportunities for the AIMS and assessing AI risks: risk and acceptance criteria, AI risk sources, likelihood and consequence scales, assessment triggers and the risk register (Clauses 6.1.1, 6.1.2 and 8.2). Mandatory.',
    content: `# AI Risk Assessment Methodology

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This methodology describes how {{client_name}} finds the risks and opportunities that affect its AI management system (AIMS), and how it assesses the risks that come from the AI systems it develops, provides or uses. It sets the risk criteria (Clause 6.1.1), the assessment process (Clause 6.1.2) and the schedule and triggers for repeat assessments (Clause 8.2). It follows the AI Policy and supports the AI objectives. Two assessors rating the same AI system should reach comparable results; where they do not, [AIMS MANAGER] reviews the scale descriptions, not only the ratings.

## 2. Scope

Two registers use the same scales:

- **AIMS risks and opportunities:** events that could stop the AIMS achieving its intended results, cause undesired effects, or open a chance to improve. Examples: the only engineer who runs model monitoring leaves; a regulator publishes new rules for [SECTOR]; a key customer asks for ISO/IEC 42001 certification.
- **AI system risks:** risks to and from each AI system inside the AIMS scope defined in the AIMS Scope Statement, at every lifecycle stage, whether {{client_name}} built the system or procured it.

Information security risks stay in [THE ISMS RISK REGISTER] where one exists; an AI risk with a security cause (for example, prompt injection) is recorded here and cross-referenced.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| [AIMS MANAGER] | Owns this methodology, runs assessments, maintains both registers, reports to [AI GOVERNANCE COMMITTEE]. |
| AI system owner | Supplies system information, attends each assessment of their system, proposes treatment. |
| Risk owner (a named person, not a team) | Agrees the rating, owns the treatment decision, signs residual risk acceptance. |
| Specialists ([DATA SCIENCE], [SECURITY], [PRIVACY], [LEGAL]) | Identify and analyse risks in their area. |
| [AI GOVERNANCE COMMITTEE] | Reviews the registers [QUARTERLY], challenges ratings, confirms High and Critical ratings. |
| {{approval_authority}} | Approves the risk criteria and acceptance levels in Section 5. |

## 4. Identifying AIMS risks and opportunities (Clause 6.1.1)

1. [AIMS MANAGER] runs a planning workshop [ANNUALLY] and whenever the AIMS scope changes. Inputs: the internal and external issues and interested party requirements in [THE CONTEXT REGISTER], the AI Policy, the AI objectives and the last management review minutes.
2. For each issue the group asks: what could stop the AIMS delivering its intended results, what undesired effect could it cause, and what opportunity does it create? The group considers each AI system's domain, application context and intended use.
3. Each item is logged with an owner, a planned action, the AIMS process the action sits in (an objective, a control, training, budget) and how the owner will check the action worked.
4. [AI GOVERNANCE COMMITTEE] reviews progress [QUARTERLY]. The effectiveness check result is recorded against each item before it is closed.

The certification auditor will ask for evidence that management identified and addressed risks and opportunities. Committee minutes showing the register was discussed and decisions were made are the usual evidence.

## 5. Risk criteria (Clause 6.1.1)

### 5.1 Likelihood

| Score | Level | Description | Indicative frequency |
|---|---|---|---|
| 1 | Rare | Could happen only in exceptional circumstances. | [Less than once in 10 years] |
| 2 | Unlikely | Not expected, but possible. | [Once in 3 to 10 years] |
| 3 | Possible | Might happen; has happened to similar systems elsewhere. | [Once in 1 to 3 years] |
| 4 | Likely | Expected at some point; has happened here before. | [Once or more a year] |
| 5 | Almost certain | Expected often, or already happening. | [Monthly or more] |

### 5.2 Consequence

Rate every dimension that applies and use the highest score.

| Score | To {{client_name}} | To individuals or groups | To society |
|---|---|---|---|
| 1 Negligible | Loss under [AMOUNT]; no customer or regulator interest | Minor inconvenience, reversed at once | No discernible effect |
| 2 Minor | Loss [AMOUNT to AMOUNT]; a single complaint | Short-term disadvantage to a few people, fully reversible | Isolated effect, quickly corrected |
| 3 Moderate | Loss [AMOUNT to AMOUNT]; contract dispute; local media | Unfair outcome, privacy intrusion or loss of service for many people, reversible with effort | Noticeable effect on trust or on a community |
| 4 Major | Loss [AMOUNT to AMOUNT]; regulator enquiry; loss of a key customer | Significant harm to rights, finances, health or employment; hard to reverse | Wide effect on public trust, a labour market or the environment |
| 5 Severe | Loss over [AMOUNT]; enforcement action; service suspended | Serious or irreversible harm, including to safety or to vulnerable people | Lasting damage to public institutions, democratic processes or the environment |

### 5.3 Risk level

Risk score = likelihood x consequence.

| Likelihood / Consequence | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 5 Almost certain | 5 Medium | 10 High | 15 High | 20 Critical | 25 Critical |
| 4 Likely | 4 Low | 8 Medium | 12 High | 16 High | 20 Critical |
| 3 Possible | 3 Low | 6 Medium | 9 Medium | 12 High | 15 High |
| 2 Unlikely | 2 Low | 4 Low | 6 Medium | 8 Medium | 10 High |
| 1 Rare | 1 Low | 2 Low | 3 Low | 4 Low | 5 Medium |

### 5.4 Acceptance criteria

| Level | Acceptable? | Who may accept | Required action |
|---|---|---|---|
| Low [1 to 4] | Acceptable | Risk owner | Monitor; review at the next scheduled assessment. |
| Medium [5 to 9] | Acceptable if justified | Risk owner and [AIMS MANAGER] | Treat where the cost is proportionate; record the reason if not treated. |
| High [10 to 16] | Not acceptable | [AI GOVERNANCE COMMITTEE], as a time-limited exception only | Treatment plan within [30 DAYS]. |
| Critical [20 to 25] | Not acceptable | Cannot be accepted | Do not deploy, or suspend; escalate to {{approval_authority}} within [2 WORKING DAYS]. |

Two overrides apply whatever the score. A consequence of 5 to individuals, groups or society needs written acceptance by {{approval_authority}}. A known breach of a legal requirement is never acceptable.

## 6. AI risk sources checklist

Assessors work through every row for each AI system. Where a row does not apply, write "considered, not relevant" and the reason.

| Risk source | Prompt questions |
|---|---|
| Transparency and explainability | Can we explain an output to the affected person, the operator and a regulator? Do people know they are dealing with AI? |
| Level of automation | Does the system act without a human decision? Can a human override it, and do they in practice, or do they defer to it? |
| Data quality | Is training and test data representative of the people and conditions in production? Are labels accurate? Is the data out of date? |
| Drift | How fast do inputs or real-world patterns change? Is drift measured, with a threshold and an owner? |
| Bias and differential performance | Could accuracy or error rates differ by age, sex, ethnicity, disability, language or location? Has this been measured? |
| Lifecycle issues | Weak requirements, thin testing, uncontrolled retraining, missing documentation, no retirement plan? |
| Technology readiness | Is the technique new for this use? Does the supplier change model versions without notice? |
| Environmental complexity | Is the operating environment open-ended (free text from the public, the physical world, hostile users)? |
| Hardware and compute | Dependence on specific hardware, one cloud region, capacity limits, high energy use? |
| Misuse | Could users apply it outside its intended purpose, or abuse it deliberately? |
| Security threats | Data poisoning, model inversion or membership inference, model stealing, prompt injection and jailbreaks, adversarial inputs, a compromised model or library supply chain? |
| Privacy | Personal data in training, memorisation and leakage in outputs, secondary use of data? |
| Third parties | Supplier terms, model changes, outages, sub-processors, loss of audit rights? |
| Legal and contractual | Sector rules, AI-specific law and its risk classification, non-discrimination and consumer law, customer contract terms? |
| People and accountability | Is there a named owner? Are operators trained and competent to oversee the system? |

## 7. Assessment procedure

| Step | Who | What happens | Record |
|---|---|---|---|
| 1. Scope | [AIMS MANAGER], system owner | Confirm the AI system, version, lifecycle stage, intended purpose and {{client_name}}'s role (developer, provider or user). | Assessment header |
| 2. Inputs | System owner | Gather the AI system register entry, the current impact assessment, monitoring results, incidents and supplier documents. | Input list |
| 3. Identify | Workshop | Use Section 6. Include risks that help or hinder the AI objectives. Write each risk as cause, event and consequence. | Draft register entries |
| 4. Analyse | Assessor, specialists | Rate likelihood and consequence with Section 5. Use the impact assessment for consequences to individuals and society. Note the existing controls relied on. | Ratings with rationale |
| 5. Evaluate | Assessor, risk owner | Compare with Section 5.4. Rank by score; where scores tie, rank consequences to people above consequences to {{client_name}}. | Prioritised list |
| 6. Review | [AI GOVERNANCE COMMITTEE] | Confirm High and Critical ratings; check a sample of others for consistency. | Minutes |
| 7. Hand over | [AIMS MANAGER] | Send non-acceptable risks to treatment and opportunities to planning. | Treatment plan entries |

Example risk statement: "Because the claims triage model was trained only on claims written in English, claims submitted in [LANGUAGE] may be misrouted, leading to delayed payments for those customers."

## 8. When assessments run (Clause 8.2)

- **Planned:** every in-scope AI system at least [ANNUALLY]; systems with High or Critical residual risk every [6 MONTHS]; AIMS risks and opportunities [ANNUALLY].
- **Triggered:** a new AI system before go-live (or before contract signature for a procured one); retraining on new data; a new model version from a supplier; a change to intended purpose, user population, jurisdiction or level of automation; a serious incident or near miss; a new legal requirement; an audit or monitoring finding.
- **No change found:** record "reviewed, no change" with the date and the reviewer. An untouched register row is not evidence that a review took place.

Every assessment is entered in the assessment log: date, system, version, trigger, assessor and outcome.

## 9. Risk register columns

| Column | Content |
|---|---|
| Risk ID | [AIR-SYSTEM-NNN] for AI system risks, [AIMS-R-NNN] for AIMS risks |
| AI system, version, lifecycle stage | As named in [THE AI SYSTEM INVENTORY]; design, development, verification, deployment, operation or retirement |
| Risk source | Row from Section 6 |
| Description and who is affected | Cause, event, consequence; {{client_name}}, individuals or groups, society |
| Existing controls | Controls relied on at the time of rating |
| Inherent rating | Likelihood, consequence, score, level, one-line rationale |
| Evaluation | Acceptable or not acceptable |
| Treatment | Option chosen and treatment plan reference |
| Controls | Annex A references and any other controls |
| Residual rating | After treatment |
| Risk owner | Named person |
| Dates | Assessed on, assessor, next review |
| Status | Open, in treatment, accepted, closed |

The register feeds the AI Risk Treatment Procedure and Plan, and the controls chosen there feed the Statement of Applicability. A summary of ratings, changes and overdue reviews goes to [AI GOVERNANCE COMMITTEE] [QUARTERLY] and to management review.

## 10. Records produced

Kept under the AIMS Documented Information Control Procedure for [THE CERTIFICATION CYCLE PLUS 3 YEARS]: this methodology with its version and approval date; both registers, with version history or a dated snapshot per cycle; the assessment log; workshop notes and attendance; and [AI GOVERNANCE COMMITTEE] minutes where risk was reviewed.

The certification auditor will ask for this methodology with its version and approval date, minutes showing risks and opportunities were identified and acted on, and the most recent results for each in-scope AI system. Expect them to pick a recent change (for example, the last retraining) and ask for the reassessment it triggered.

## 11. Related documents

AI Policy; AIMS Scope Statement; AIMS Roles, Responsibilities and Authorities; AI Objectives and Measurement Plan; AI System Impact Assessment Procedure; AI Risk Treatment Procedure and Plan; Statement of Applicability (ISO 42001) Cover and Approval; AIMS Operational Planning Calendar; AI System Lifecycle Procedure.

## 12. Review and approval

[AIMS MANAGER] reviews this methodology {{review_period}}, after a serious AI incident, and when an audit finding concerns it. {{approval_authority}} approves changes to the scales or acceptance criteria. After such a change, existing risks are re-rated, or the register records why re-rating is not needed.
`,
  },

  // ---------------------------------------------------------------------
  // 2. AI Risk Treatment Procedure and Plan
  // ---------------------------------------------------------------------
  {
    name: 'AI Risk Treatment Procedure and Plan',
    category: 'procedure',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-6.1.3', 'ai-clause-8.3'],
    description: 'How AI risk treatment options and controls are chosen, compared with Annex A and recorded in the Statement of Applicability, with the treatment plan, residual risk acceptance and checks that treatment worked (Clauses 6.1.3 and 8.3). Mandatory.',
    content: `# AI Risk Treatment Procedure and Plan

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure sets out how {{client_name}} decides what to do about each assessed AI risk, which controls it needs, how those controls reach the Statement of Applicability, and how it checks that treatment worked. It covers the treatment process (Clause 6.1.3) and putting the plan into operation (Clause 8.3). Section 8 holds the treatment plan itself.

## 2. Scope

Every risk rated not acceptable under the AI Risk Assessment Methodology, and any acceptable risk the risk owner chooses to reduce further. It applies to AI systems {{client_name}} develops, provides or uses within the AIMS scope defined in the AIMS Scope Statement.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Risk owner | Chooses the treatment option with the system owner, approves plan entries for their risks, accepts residual risk within their authority. |
| Control owner | Implements the control and supplies evidence that it operates. |
| [AIMS MANAGER] | Runs the Annex A comparison, maintains the plan and the Statement of Applicability, tracks progress, arranges verification. |
| [AI GOVERNANCE COMMITTEE] | Approves the plan, accepts residual High risks as time-limited exceptions, receives overdue escalations. |
| {{approval_authority}} | Approves the Statement of Applicability and any acceptance of a severe consequence to people. |

## 4. Treatment options

| Option | What it means | AI examples |
|---|---|---|
| Modify | Add or change controls to lower likelihood or consequence. | Add a stratified test set; route low-confidence outputs to a person; filter generated output. |
| Avoid | Stop the activity that creates the risk. | Do not release a feature; remove a data source; withdraw the system from a use case. |
| Share | Pass part of the risk to another party by contract or insurance. | Supplier warranty and indemnity for model defects; insurance. {{client_name}} stays accountable to the people affected. |
| Retain | Accept the risk as it is, within the criteria, with a recorded decision. | A low-rated drift risk on an internal search tool. |

More than one option can apply to a risk. The option and the reason are recorded in the register.

## 5. Determining controls

1. For each risk being treated, the risk owner and [AIMS MANAGER] list the controls needed to carry out the chosen option. Controls can come from any source: internal standards, supplier features, sector guidance or other frameworks.
2. [AIMS MANAGER] compares that list with all 38 controls in Annex A (A.2 to A.10), using the implementation guidance in Annex B, to confirm that no necessary control has been missed. The comparison is kept in the Statement of Applicability working sheet, one row per Annex A control.
3. Where a risk needs a control that Annex A does not describe, it is added as an additional control with its own reference. Examples: red-team testing against prompt injection before each release; query rate limits to slow model extraction.
4. Each control is linked to the risk IDs it treats. A control with no risk, legal or contractual reason behind it is questioned before it goes into the Statement of Applicability.
5. Controls are communicated to the people who operate them through the procedures and role descriptions that implement them.

## 6. Producing the Statement of Applicability

The Statement of Applicability lists every Annex A control with:

- included or excluded;
- the justification (for inclusion: the risk IDs, legal requirement or contract term it answers; for exclusion: the specific reason it is not needed);
- implementation status (implemented, partly implemented, planned);
- the document or system that implements it.

It also lists the additional controls from Section 5. [AIMS MANAGER] updates it whenever the plan changes a control decision. It is approved with the Statement of Applicability (ISO 42001) Cover and Approval.

## 7. Approval and residual risk acceptance

1. Each risk owner reviews the plan entries for their risks and approves them in [GRC TOOL / SIGNED FORM]. A reply saying "fine" is weak evidence; use a recorded approval.
2. Residual risk is accepted at the level set in Section 5.4 of the AI Risk Assessment Methodology. Time-limited acceptances carry an expiry date, and [AIMS MANAGER] brings them back before they expire.
3. [AI GOVERNANCE COMMITTEE] approves the plan as a whole and records this in its minutes. {{approval_authority}} approves the Statement of Applicability.

## 8. Treatment plan

| Risk ID | Risk (short) | Level now | Option | Controls (Annex A / other) | Action | Owner | Resources | Due | Target residual | Status | Residual accepted by, date |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [AIR-CLAIMS-004] | Triage model misroutes claims written in [LANGUAGE] | High (12) | Modify | A.7.4, A.6.2.4, A.9.2 | Add a language-stratified test set; send low-confidence cases to a handler | [NAME, HEAD OF DATA SCIENCE] | [10 DAYS DATA SCIENCE] | [DATE] | Medium (6) | Open | [PENDING] |
| [AIR-CHAT-002] | Prompt injection makes the support chatbot reveal another customer's data | Critical (20) | Modify | A.6.2.2, A.6.2.4, A.10.3; additional: pre-release red-team test | Separate retrieval per customer; add an injection test suite to the release gate | [NAME, ENGINEERING LEAD] | [15 DAYS ENGINEERING, SUPPLIER SUPPORT] | [DATE] | Medium (5) | In progress | [PENDING] |
| [AIMS-R-003] | Only one person can run fairness monitoring | Medium (8) | Modify | A.4.6 | Train a second analyst; write the runbook | [NAME] | [TRAINING BUDGET] | [DATE] | Low (4) | Open | [PENDING] |
| | | | | | | | | | | | |

## 9. Implementation and verification (Clause 8.3)

1. Control owners complete actions by the due date. [AIMS MANAGER] reviews status [MONTHLY]. Actions more than [30 DAYS] overdue go to [AI GOVERNANCE COMMITTEE] with a revised date or a request to re-plan.
2. When an owner marks an action complete, someone other than the owner checks the evidence: a test report, configuration record, updated procedure or training record. The checker's name and the date go in the plan.
3. Each treatment has an effectiveness measure agreed when it is planned. Examples: a fairness gap below [THRESHOLD]; a pass rate of [PERCENTAGE] on the injection test suite; a human override rate within [RANGE]. The owner reports the measure [90 DAYS] after implementation.
4. If the measure shows the treatment is not working, the risk owner and [AIMS MANAGER] review the option and controls, update the plan and re-rate the risk. New risks found during treatment are assessed under the AI Risk Assessment Methodology and treated through this procedure.
5. Once verified, the risk is re-rated. If the residual level is still not acceptable, more treatment is planned or acceptance is sought at the right level.

## 10. Records produced

- The treatment plan, with version history.
- The Statement of Applicability and its approved cover.
- Risk owner approvals and residual risk acceptances, with expiry dates where time-limited.
- Verification evidence and effectiveness measure results for each action.
- [AI GOVERNANCE COMMITTEE] minutes approving the plan and reviewing overdue actions.

The certification auditor will sample risks from the register and trace each one to its treatment, controls, Statement of Applicability entry, residual acceptance and effectiveness result. At Stage 2 they expect evidence that actions were carried out, not only planned.

## 11. Related documents

AI Risk Assessment Methodology; Statement of Applicability (ISO 42001) Cover and Approval; AI System Impact Assessment Procedure; AI Policy; AIMS Roles, Responsibilities and Authorities; AIMS Nonconformity and Corrective Action Procedure; AIMS Operational Planning Calendar.

## 12. Review and approval

[AIMS MANAGER] reviews this procedure {{review_period}} and when the risk criteria change. The plan in Section 8 is a live record: it is updated as actions move and is approved by [AI GOVERNANCE COMMITTEE] [QUARTERLY].
`,
  },

  // ---------------------------------------------------------------------
  // 3. AI System Impact Assessment Procedure
  // ---------------------------------------------------------------------
  {
    name: 'AI System Impact Assessment Procedure',
    category: 'procedure',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-6.1.4', 'ai-clause-8.4', 'ai-annex-a-5-2'],
    description: 'Process for assessing the consequences of AI systems for individuals, groups and society: when assessments are required, who performs and approves them, proportionality, the assessment steps and the impact assessment log (Clauses 6.1.4 and 8.4, Annex A.5.2). Mandatory.',
    content: `# AI System Impact Assessment Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure sets out how {{client_name}} assesses the consequences its AI systems could have for individuals, groups of people and society. It meets Clause 6.1.4 (the assessment process), Clause 8.4 (running assessments at set intervals and on change) and Annex A.5.2 (a documented impact assessment process).

An impact assessment is not the AI risk assessment. The risk assessment asks what could go wrong for {{client_name}} and its objectives. The impact assessment asks what the system could do to people, including people who never use it. Its findings feed the risk assessment.

## 2. Scope

Every AI system inside the AIMS scope defined in the AIMS Scope Statement, including third-party AI that {{client_name}} uses to make or support decisions about people. Each assessment covers one system at one version, in the technical and social context where it is used and the jurisdictions it operates in.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| AI system owner | Starts the assessment, supplies system information, implements agreed measures. Never approves their own system's assessment. |
| Assessor | Leads the assessment and completes the form. Independent of the system's development team where possible (for example [RESPONSIBLE AI LEAD] or [PRIVACY TEAM]). |
| Specialists | [LEGAL], [PRIVACY / DPO], [SECURITY], [DOMAIN EXPERT] and [ACCESSIBILITY] contribute as the system requires. |
| Approver | [AIMS MANAGER] for short assessments; [AI GOVERNANCE COMMITTEE] for full assessments and for any "proceed with conditions" or "do not proceed" decision. The approver is not the assessor or the system owner. |
| [AIMS MANAGER] | Keeps the impact assessment log, tracks reviews and triggers, reports status to management review. |

Where independence is not possible (for example, a very small team), record why on the form, and the approver reviews the evidence in more depth.

## 4. When an impact assessment is required

| Trigger | Timing |
|---|---|
| New AI system built by {{client_name}} | Before development is approved; updated before deployment. |
| New AI system procured, or an AI feature switched on in an existing tool | Before contract signature or before the feature is enabled. |
| Significant change to intended purpose or context of use (new users, population, country or sector) | Before the change goes live. |
| Change in level of automation (for example, from advisory output to automatic decisions) | Before the change goes live. |
| Change in data types or sources (new personal data, new data supplier, new training set) | Before retraining or release. |
| Material model change (retraining that shifts performance, a new supplier model version) | Before release; within [10 WORKING DAYS] for supplier changes made without notice. |
| Scheduled review | Full assessments [ANNUALLY]; short assessments every [2 YEARS]. |
| Serious incident, pattern of complaints, or monitoring that shows harm | Within [20 WORKING DAYS] of the incident closing or the pattern being identified. |

## 5. Proportionality: full or short assessment

The assessor answers these screening questions first and records them in Section 4 of the AI System Impact Assessment Form. Any "yes" means a full assessment.

1. Does the system make or materially influence decisions about people (employment, credit, insurance, education, healthcare, housing, access to public or essential services)?
2. Does it process special category data or children's data, or is it aimed at vulnerable people?
3. Is it public-facing, or does it produce content the public sees?
4. Could its failure cause physical harm or significant financial loss to individuals?
5. Does it act without a person reviewing each output?

A short assessment still completes every section of the form, but may answer Sections 8 to 11 in a sentence each, stating why the topic is limited for this system.

## 6. Assessment steps

| Step | Who | What happens | Output |
|---|---|---|---|
| 1. Identify | Assessor, system owner | Describe intended purpose and foreseeable misuse. List who is affected (Section 7). Identify the sources of possible impact, the events that could occur and the outcomes for people. | Form Sections 2 to 6 |
| 2. Analyse | Assessor, specialists | Rate severity and likelihood of each impact with the scales in the AI Risk Assessment Methodology. Note reversibility and how many people could be affected. Test or review performance across relevant groups. | Form Sections 7 to 11 |
| 3. Evaluate | Assessor, approver | Compare residual impacts with the acceptance criteria in the AI Risk Assessment Methodology. A residual severity of 4 or 5 to individuals or society needs [AI GOVERNANCE COMMITTEE] approval. Decide: proceed, proceed with conditions, or do not proceed. | Form Sections 13 and 14 |
| 4. Treat | System owner | Agree measures: design changes, human oversight, notices to users, limits on use, extra testing, monitoring. Measures with a cost or due date go into the AI Risk Treatment Procedure and Plan. | Form Section 12; treatment plan entries |
| 5. Document, report and communicate | Assessor, [AIMS MANAGER] | Complete and approve the form, update the log, and decide what summary is shared with customers, affected people or regulators (Annex A.8 controls). | Approved form; log entry; communication record |

## 7. Who is considered

The intended purpose and context decide which of these apply. The assessor records any group judged not relevant, with the reason.

- Direct users and operators of the system.
- People the outputs are about (applicants, customers, patients, employees), whether or not they know AI is involved.
- People who never interact with the system but are affected by it (family members, people named in documents, people in images or recordings).
- Vulnerable people: children, older people, people with disabilities, people with low digital or language literacy, people in financial difficulty.
- Groups defined by protected characteristics under [APPLICABLE EQUALITY LAW].
- Workers whose tasks or jobs the system changes.
- Society: the environment, public trust, the information ecosystem, democratic processes and the labour market.

## 8. How results are used

- **Design:** measures become system requirements (A.6.2.2) and test criteria (A.6.2.4).
- **Approval:** no AI system goes live, and no significant change is released, without an approved impact assessment for the current version.
- **Use:** limits and conditions go into user instructions and the information given to interested parties.
- **Risk assessment:** severity ratings for individuals and society feed the consequence ratings in the AI risk register.
- **Monitoring:** impacts that depend on live behaviour (fairness, drift) get a monitoring metric and a threshold.
- **Management review:** [AIMS MANAGER] reports log status and significant findings.

## 9. Impact assessment log

| IA ID | AI system | Version | Date | Trigger | Assessor | Type | Residual impact level | Decision | Approver | Next review |
|---|---|---|---|---|---|---|---|---|---|---|
| [IA-2026-001] | [Claims triage model] | [2.3] | [DATE] | Retraining on new data | [NAME] | Full | Medium | Proceed with conditions | [AI GOVERNANCE COMMITTEE] | [DATE] |
| | | | | | | | | | | |

## 10. Records produced

- Approved AI System Impact Assessment Forms, one per system and version, with superseded versions kept.
- The impact assessment log.
- Screening answers, test results and consultation notes attached to each form.
- Approval records and [AI GOVERNANCE COMMITTEE] minutes.
- Records of what was communicated, to whom and when.

The certification auditor will ask for this procedure, the log and completed assessments for a sample of systems. They check that the assessed version matches the version in production, that the approver was not the author, and that the agreed measures were implemented.

## 11. Related documents

AI System Impact Assessment Form; AI Risk Assessment Methodology; AI Risk Treatment Procedure and Plan; AI System Lifecycle Procedure; AI Data Management Policy; AI Incident Response and Communication Plan; AI Supplier and Partner Management Procedure; AIMS Scope Statement; AI Policy.

## 12. Review and approval

[AIMS MANAGER] reviews this procedure {{review_period}} and after any serious incident that harmed people affected by an AI system. {{approval_authority}} approves changes.
`,
  },

  // ---------------------------------------------------------------------
  // 4. AI System Impact Assessment Form
  // ---------------------------------------------------------------------
  {
    name: 'AI System Impact Assessment Form',
    category: 'form',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-8.4', 'ai-annex-a-5-3', 'ai-annex-a-5-4', 'ai-annex-a-5-5'],
    description: 'Fill-in record of an impact assessment for one AI system and version, covering affected people, impacts on individuals, groups and society, differential performance, misuse, human oversight, the decision and approval (Clause 8.4, Annex A.5.3, A.5.4 and A.5.5). Mandatory.',
    content: `# AI System Impact Assessment Form

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Assessment details

Complete one form per AI system and version, following the AI System Impact Assessment Procedure. Attach evidence (test results, consultation notes) and list it in Section 15.

| Field | Entry |
|---|---|
| Impact assessment ID | [IA-YYYY-NNN] |
| AI system name | |
| System version and model version | |
| System owner | |
| Assessor | |
| Assessment type | [FULL / SHORT] |
| Date started | |
| Previous assessment ID and version | |

## 2. System identification and intended purpose

| Field | Entry |
|---|---|
| What the system does (two or three sentences) | |
| Intended purpose | |
| Uses that are out of scope or prohibited | |
| Intended users and operators | |
| Deployment context and jurisdictions | |
| {{client_name}}'s role | [DEVELOPER / PROVIDER / USER] |
| Level of automation | [ADVISORY / PERSON APPROVES EACH OUTPUT / PERSON MONITORS AND CAN INTERVENE / FULLY AUTOMATED] |
| Model type, and supplier if third-party | |
| Data used (types, sources, personal data, special category data) | |
| Outputs and how they are used in decisions | |
| People affected per [MONTH] (estimate) | |

## 3. Trigger

Tick one: [ ] New AI system; [ ] change to intended purpose or context of use; [ ] change in level of automation; [ ] change in data types or sources; [ ] material model change or new supplier model version; [ ] scheduled review; [ ] serious incident, complaints or monitoring result.

Details of the trigger:

## 4. Screening

| Question | Yes / No | Note |
|---|---|---|
| Makes or materially influences decisions about people | | |
| Processes special category or children's data, or is aimed at vulnerable people | | |
| Public-facing, or produces content the public sees | | |
| Failure could cause physical harm or significant financial loss | | |
| Acts without a person reviewing each output | | |

Any "yes" means a full assessment.

## 5. Affected individuals and groups

Include people who never use the system but are affected by it.

| Group | How they are affected | Interacts with the system? | Knows AI is involved? | Vulnerability factors | Approx. number |
|---|---|---|---|---|---|
| [Claimants] | [Routing decides how quickly they are paid] | [No] | [Yes, via privacy notice] | [Some in financial hardship] | [40,000 a year] |
| [Claims handlers] | [Work queue set by the model] | [Yes] | [Yes] | | [120] |
| [People named in claim documents who are not customers] | [Their data is processed] | [No] | [No] | | [Unknown] |
| | | | | | |

## 6. Positive impacts

| Impact | Who benefits | How it will be evidenced |
|---|---|---|
| | | |

## 7. Potential negative impacts on individuals and groups (Annex A.5.4)

Severity and likelihood use the scales in the AI Risk Assessment Methodology (1 to 5).

| Area | Potential impact for this system | Who | Severity | Likelihood | Existing measures |
|---|---|---|---|---|---|
| Fairness and non-discrimination | | | | | |
| Privacy and data protection | | | | | |
| Safety, health and wellbeing | | | | | |
| Access to services, credit, housing or education | | | | | |
| Autonomy, dignity and the ability to contest a decision | | | | | |
| Employment and working conditions | | | | | |
| Transparency (knowing AI is involved and why an outcome occurred) | | | | | |
| Financial loss | | | | | |
| Accessibility for people with disabilities | | | | | |

## 8. Potential impacts on society (Annex A.5.5)

Where societal reach is limited, say why in one or two sentences rather than leaving rows blank.

| Area | Potential impact | Severity | Likelihood | Existing measures |
|---|---|---|---|---|
| Environment (energy, water and hardware used to train and run the system) | | | | |
| Public trust in {{client_name}}, the sector or AI generally | | | | |
| Democratic processes and the information ecosystem (misinformation, manipulation) | | | | |
| Labour market and economic effects (job displacement, access to financial services) | | | | |
| Health and public services | | | | |
| Culture, norms and values | | | | |
| Effects at scale (small harms repeated across many people) | | | | |

## 9. Demographic groups and differential performance

| Group dimension | Relevant? | Data available? | Test performed | Metric | Result by group | Gap within [THRESHOLD]? |
|---|---|---|---|---|---|---|
| Age | | | | | | |
| Sex or gender | | | | | | |
| Ethnicity | | | | | | |
| Disability | | | | | | |
| Language or dialect | | | | | | |
| Geography (region, urban or rural) | | | | | | |
| [OTHER] | | | | | | |

Where group data is not held, record the method used instead (proxy analysis, targeted test sets, supplier evidence) and its limits.

## 10. Predictable failures and misuse

Type is one of: failure, foreseeable misuse, deliberate abuse.

| Scenario | Type | Effect on people | How it would be detected | Measure |
|---|---|---|---|---|
| Confident but wrong output | Failure | | | |
| Operator accepts output without checking it | Foreseeable misuse | | | |
| System used for a purpose it was not designed for | Foreseeable misuse | | | |
| Inputs manipulated (prompt injection, adversarial input) | Deliberate abuse | | | |
| Supplier changes the model without notice | Failure | | | |
| | | | | |

## 11. Human oversight

| Question | Answer |
|---|---|
| Who oversees outputs, and at what point? | |
| Can they understand an output well enough to judge it (explanation, confidence, sources)? | |
| Can they override, correct or stop the system? How? | |
| Are they trained, and do they have time to review (volume, time pressure)? | |
| What evidence shows oversight works (override rate, review sample results)? | |
| How can an affected person question or contest an outcome? | |
| How does oversight prevent or limit the harms in Sections 7 to 10? | |

## 12. Measures taken or planned

| # | Measure | Impacts addressed (section and row) | Owner | Due | Status | Treatment plan ref |
|---|---|---|---|---|---|---|
| | | | | | | |

## 13. Residual assessment

| Impact (section and row) | Residual severity | Residual likelihood | Residual level | Acceptable? |
|---|---|---|---|---|
| | | | | |

Overall residual impact level [LOW / MEDIUM / HIGH / CRITICAL] and rationale:

## 14. Decision

Tick one: [ ] Proceed; [ ] Proceed with conditions; [ ] Do not proceed.

| Condition | Owner | Must be met by | Verified by, date |
|---|---|---|---|
| | | | |

Summary to be shared (what, with whom, by whom, when):

Next review date and system-specific review triggers:

## 15. Approval

| Role | Name | Date | Approval record |
|---|---|---|---|
| Prepared by (assessor) | | | |
| Specialist review ([LEGAL / PRIVACY]) | | | |
| System owner (acknowledges measures and conditions) | | | |
| Approved by ([AIMS MANAGER] or [AI GOVERNANCE COMMITTEE]) | | | |

The approver must not be the assessor or the system owner.

Attachments:

## 16. Version history

| Version | Date | Trigger | Summary of changes | Approved by |
|---|---|---|---|---|
| | | | | |

Once approved, this version is not edited. Any change, including a correction, is made in a new version that supersedes it. The superseded version is kept and marked "Superseded by [IA ID, VERSION]". The certification auditor will compare the approved version with the system version in production.
`,
  },

  // ---------------------------------------------------------------------
  // 5. Statement of Applicability cover
  // ---------------------------------------------------------------------
  {
    name: 'Statement of Applicability (ISO 42001) Cover and Approval',
    category: 'record',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-6.1.3'],
    description: 'Controlled cover for the Statement of Applicability: version history, the risk treatment it was derived from, confirmation that all 38 Annex A controls were considered, inclusion and exclusion counts, additional controls and approval signatures (Clause 6.1.3). Mandatory.',
    content: `# Statement of Applicability (ISO 42001) Cover and Approval

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This cover is the controlled front page of {{client_name}}'s Statement of Applicability (SoA) for ISO/IEC 42001:2023, required by Clause 6.1.3. The control-by-control SoA is held at [LOCATION: GRC TOOL / SPREADSHEET PATH]. This page records which version is current, what it was derived from and who approved it. The SoA and this cover are versioned and approved together.

## 2. Document references

| Item | Reference |
|---|---|
| SoA document ID and version | [AIMS-REC-SOA, v1.0] |
| Location of the control-by-control SoA | [LOCATION] |
| AIMS Scope Statement version | [VERSION, DATE] |
| AI risk register snapshot used | [DATE] |
| AI Risk Treatment Procedure and Plan version | [VERSION, DATE] |
| Impact assessment log as at | [DATE] |
| {{client_name}}'s AI roles covered | [DEVELOPER / PROVIDER / USER, per AI system] |

## 3. Version history

| Version | Date | Reason for change | Summary of changes | Prepared by | Approved by |
|---|---|---|---|---|---|
| [0.1] | [DATE] | First draft | Initial applicability decisions | [AIMS MANAGER] | Not approved |
| [1.0] | [DATE] | Initial approval | | [AIMS MANAGER] | {{approval_authority}} |
| | | | | | |

Typical reasons for a new version: a risk reassessment, a new or retired AI system, a change of AIMS scope, an audit finding, or a change in {{client_name}}'s role for a system.

## 4. Basis of control selection

The controls in the SoA were determined through the AI Risk Treatment Procedure and Plan. For each risk needing treatment, the necessary controls were identified from any relevant source and then compared with every Annex A control so that none was overlooked. Annex B implementation guidance was used when deciding how each control applies. Legal, regulatory and contractual obligations in [THE LEGAL REGISTER] were also considered, as was {{client_name}}'s role for each AI system.

## 5. Statement of consideration

All 38 controls in Annex A of ISO/IEC 42001:2023 were considered for this version. Each has a recorded decision (included or excluded) and a justification. Each included control also has an implementation status and a reference to the document or system that implements it.

## 6. Summary of applicability

| Annex A group | Controls | Included | Excluded | Implemented | Partly implemented | Planned |
|---|---|---|---|---|---|---|
| A.2 Policies related to AI | 3 | | | | | |
| A.3 Internal organisation | 2 | | | | | |
| A.4 Resources for AI systems | 5 | | | | | |
| A.5 Assessing impacts of AI systems | 4 | | | | | |
| A.6 AI system life cycle | 9 | | | | | |
| A.7 Data for AI systems | 5 | | | | | |
| A.8 Information for interested parties | 4 | | | | | |
| A.9 Use of AI systems | 3 | | | | | |
| A.10 Third-party and customer relationships | 3 | | | | | |
| **Total** | **38** | | | | | |

Included plus excluded must equal 38. The counts must match the control-by-control SoA.

## 7. Where the justifications are held

Justifications for every inclusion and exclusion are in the [JUSTIFICATION] column of the control-by-control SoA. An inclusion justification names the risk IDs, legal requirement or contract term the control answers. An exclusion justification says specifically why the control is not needed.

| Example exclusion justification | Acceptable? |
|---|---|
| "{{client_name}} does not develop AI systems and only uses supplier systems, so [CONTROL] on development does not apply. See AIMS Scope Statement, section [X]." | Yes, if the scope and role determination support it. |
| "Not considered necessary." | No. |

### Excluded controls

| Control | Title | Justification summary | Confirmed by |
|---|---|---|---|
| | | | |

## 8. Additional controls beyond Annex A

| Ref | Control | Risk IDs treated | Source | Status |
|---|---|---|---|---|
| [ADD-01] | [Red-team testing of generative AI features before each release] | [AIR-CHAT-002] | [INTERNAL STANDARD] | [IMPLEMENTED] |
| | | | | |

## 9. Approval

| Role | Name | Decision | Date | Signature or approval record |
|---|---|---|---|---|
| Prepared by [AIMS MANAGER] | | Submitted | | |
| Reviewed for risk owners ([AI GOVERNANCE COMMITTEE] chair) | | [Recommended] | | |
| Approved by {{approval_authority}} | | [Approved] | | |

## 10. What the certification auditor will look for

At Stage 1 the auditor asks for the SoA with its version, approval date and a justification for every inclusion and exclusion. They pick included controls and trace them back to risks in the register, and pick exclusions and test the reason against the AIMS Scope Statement. At Stage 2 they test whether controls marked implemented are operating. Counts on this cover that do not match the SoA are an easy finding to avoid.

## 11. Records produced

- This cover and the control-by-control SoA, with every approved version kept.
- Approval records.
- The Annex A comparison working sheet from the AI Risk Treatment Procedure and Plan.

## 12. Related documents

AI Risk Treatment Procedure and Plan; AI Risk Assessment Methodology; AIMS Scope Statement; AI Policy; AIMS Documented Information Control Procedure.

## 13. Review and approval

[AIMS MANAGER] reviews the SoA {{review_period}} and whenever the treatment plan changes a control decision. Each change produces a new version, approved by {{approval_authority}}.
`,
  },

  // ---------------------------------------------------------------------
  // 6. AIMS Operational Planning Calendar
  // ---------------------------------------------------------------------
  {
    name: 'AIMS Operational Planning Calendar',
    category: 'plan',
    tier: 'expected',
    requirement_refs: ['ai-clause-4.4', 'ai-clause-8.1'],
    description: 'The AIMS processes and how they connect (Clause 4.4), and operational planning and control of each (Clause 8.1): criteria for each process, a 12-month calendar of AIMS activities with owners and evidence, control of external providers, and handling of planned and unintended changes.',
    content: `# AIMS Operational Planning Calendar

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This plan shows how {{client_name}} plans and controls the processes that run its AI management system (Clause 8.1). It sets the criteria each process is run against, the year's schedule of AIMS activities with owners and evidence, how external providers relevant to the AIMS are controlled, and how changes are handled.

## 2. Scope

All AIMS processes and all AI systems within the AIMS scope defined in the AIMS Scope Statement, including processes run for {{client_name}} by external providers.

## 3. Roles and responsibilities

- [AIMS MANAGER] maintains this calendar, sends reminders [2 WEEKS] before each activity, and records whether it took place.
- Activity owners carry out the activity and file the evidence where Section 6 says.
- [AI GOVERNANCE COMMITTEE] reviews missed or late activities [QUARTERLY].
- {{approval_authority}} approves the calendar at the start of each AIMS year.

## 4. Process criteria

Clause 4.4 asks for the AIMS to be set up and run as a set of processes that work together. This table is {{client_name}}'s process map: each AIMS process, the document that governs it, what "run as planned" means, and the evidence it leaves. The processes feed each other in this order: risk and impact assessment set the controls; the lifecycle, data, monitoring, incident and supplier processes operate them; audit, management review and corrective action check and improve them.

| Process | Governing document | Criteria ("run as planned" means) | Evidence |
|---|---|---|---|
| AI risk assessment | AI Risk Assessment Methodology | Every in-scope system assessed within its interval; triggers acted on | Register, assessment log |
| AI risk treatment | AI Risk Treatment Procedure and Plan | Actions on time or re-planned; effectiveness measured | Treatment plan, verification records |
| Impact assessment | AI System Impact Assessment Procedure | Approved assessment for the current version before release | Impact assessment log, forms |
| AI system lifecycle | AI System Lifecycle Procedure | Release gates passed and signed off, including verification and validation | Release records, test reports |
| Data management | AI Data Management Policy | Datasets documented, quality checked and provenance recorded before use | Datasheets, quality reports |
| Operation and monitoring | AI System Operation and Monitoring Procedure | Metrics reviewed at the set frequency; breaches escalated | Dashboards, alert tickets |
| Incident handling | AI Incident Response and Communication Plan | Incidents logged, classified and closed with lessons learned | Incident log |
| Supplier control | AI Supplier and Partner Management Procedure | AI suppliers assessed before contract and reviewed at interval | Supplier assessments |
| Competence and awareness | AI Competence and Awareness Plan | Role-based training completed by [DUE DATE] | Training records |
| Audit, review, corrective action | The respective AIMS procedures | Held as scheduled; actions tracked to closure | Reports, minutes, CAPA register |

The controls selected through risk treatment operate through these processes. [AIMS MANAGER] checks whether they work using the measures in the treatment plan, and raises corrective action where a control is not producing its intended result.

## 5. Recurring activities

| Activity | Frequency | Owner | Evidence |
|---|---|---|---|
| AI system monitoring review (performance, drift, fairness) | [MONTHLY] | AI system owners | Monitoring report; tickets for breaches |
| Treatment plan status review | [MONTHLY] | [AIMS MANAGER] | Updated plan |
| [AI GOVERNANCE COMMITTEE] meeting | [QUARTERLY] | [CHAIR] | Agenda, minutes |
| AI objectives progress report | [QUARTERLY] | Objective owners | Objectives report |
| AI system register check (new tools, AI features switched on in existing software) | [QUARTERLY] | [AIMS MANAGER], [IT] | Register change history |
| Repository access review | [QUARTERLY] | [REPOSITORY ADMIN] | User access list export |

## 6. Twelve-month calendar

| Month | Scheduled activities | Owner | Evidence produced |
|---|---|---|---|
| 1 [JAN] | Calendar approved; AI objective targets confirmed | [AIMS MANAGER], {{approval_authority}} | Approved calendar, objectives record |
| 2 [FEB] | AIMS risks and opportunities workshop | [AIMS MANAGER] | Workshop notes, register update |
| 3 [MAR] | AI risk assessment reviews (first half of systems) | [AIMS MANAGER], system owners | Assessment log |
| 4 [APR] | Impact assessment reviews due this half; annual AI awareness training launched | [RESPONSIBLE AI LEAD], [HR] | Impact assessment log, training assignments |
| 5 [MAY] | Reviews of high-criticality AI suppliers | [PROCUREMENT] | Supplier review records |
| 6 [JUN] | Policy and procedure reviews due; training completion check | Document owners, [HR] | Version histories, training records |
| 7 [JUL] | AI risk assessment reviews (second half of systems) | [AIMS MANAGER], system owners | Assessment log |
| 8 [AUG] | Internal audit fieldwork | [INTERNAL AUDITOR] | Audit plan, working papers |
| 9 [SEP] | Internal audit report; corrective actions raised | [INTERNAL AUDITOR], [AIMS MANAGER] | Audit report, CAPA register |
| 10 [OCT] | Management review, including AI Policy review | {{approval_authority}} | Agenda, minutes, action log |
| 11 [NOV] | Certification or surveillance audit; remaining supplier reviews | [AIMS MANAGER], [PROCUREMENT] | Audit report, supplier records |
| 12 [DEC] | Close audit findings; effectiveness checks on the year's corrective actions; draft next year's calendar | [AIMS MANAGER] | CAPA register, draft calendar |

Align the months with the certification cycle. Certification bodies expect a completed internal audit and management review before each Stage 2 or surveillance audit, so leave time between them to act on findings.

## 7. Externally provided processes, products and services

| External provider or service | Why it matters to the AIMS | Control applied | Checked by | How often | Evidence |
|---|---|---|---|---|---|
| Foundation model or AI API ([PROVIDER]) | Core of [SYSTEM]; model changes alter behaviour | Contract terms on data use and change notice; version pinning; regression tests on each new version | [ENGINEERING LEAD] | Each model version; contract [ANNUALLY] | Test results, supplier assessment |
| Cloud ML platform ([PROVIDER]) | Hosts training and inference | Supplier assurance report reviewed; access controls checked | [SECURITY] | [ANNUALLY] | Assurance report review record |
| Data labelling or data supply ([VENDOR]) | Label quality drives model quality | Acceptance sampling on each batch; contractual quality levels | [DATA SCIENCE LEAD] | Each batch | Sample results |
| AI features in SaaS tools ([CRM / OFFICE SUITE]) | Staff use AI on customer data | Approved before being switched on; configuration reviewed | [IT] | On enablement; [ANNUALLY] | Approval record |
| Model monitoring tool ([VENDOR]) | Detects drift and fairness breaches | Alerts tested; access reviewed | [ML OPS LEAD] | [QUARTERLY] | Alert test record |
| Outsourced AIMS support or internal audit ({{firm_name}} or other) | Performs AIMS processes | Engagement terms; competence and independence checked | [AIMS MANAGER] | Each engagement | Engagement letter, auditor CV |

The AI Supplier and Partner Management Procedure sets out how each provider is assessed. This table is the record of which AIMS-relevant external processes exist and who controls them.

## 8. Planned changes

Changes that need an AIMS check: a new AI system or AI feature; retraining or a new model version; a change to intended purpose, users or level of automation; a new data source or supplier; a change to AIMS scope, roles or key people; a new legal requirement.

1. The change owner raises the change in [CHANGE SYSTEM] and marks it as AIMS-relevant.
2. Within [5 WORKING DAYS], [AIMS MANAGER] decides which are needed: risk reassessment, impact assessment, SoA update, document updates, training, communication to interested parties.
3. [CHANGE APPROVER] approves the change only after those items are done or scheduled.
4. After release, the change owner confirms the change had the intended result.

## 9. Unintended changes

Examples: a supplier updates a model without notice; drift moves a metric past its threshold; an emergency fix or rollback; staff start using an unapproved AI tool.

Within [5 WORKING DAYS] of discovery, [AIMS MANAGER] and the system owner record what changed, its consequences, the action taken to limit any adverse effect, whether a risk or impact reassessment is triggered, and whether a nonconformity is raised under the AIMS Nonconformity and Corrective Action Procedure.

## 10. Records produced

The approved calendar with the completion status of each activity; the external provider control records; change tickets with the AIMS decision; unintended change reviews. The certification auditor will pick planned activities from this calendar and ask for the evidence. A missed activity with no recorded reason is a likely finding.

## 11. Related documents

AI Risk Assessment Methodology; AI Risk Treatment Procedure and Plan; AI System Impact Assessment Procedure; AI System Lifecycle Procedure; AI Data Management Policy; AI Supplier and Partner Management Procedure; AI Incident Response and Communication Plan; AIMS Internal Audit Procedure and Programme; AIMS Management Review Procedure.

## 12. Review and approval

[AIMS MANAGER] updates this calendar when dates move and reviews it in full {{review_period}}. {{approval_authority}} approves each year's calendar.
`,
  },

  // ---------------------------------------------------------------------
  // 7. AIMS Documented Information Control Procedure
  // ---------------------------------------------------------------------
  {
    name: 'AIMS Documented Information Control Procedure',
    category: 'procedure',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-7.5'],
    description: 'Procedure for identifying, approving, storing, protecting, changing, retaining and disposing of AIMS documents, records and AI artefacts, with access levels by role and a master document list (Clause 7.5). Mandatory.',
    content: `# AIMS Documented Information Control Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure sets out how {{client_name}} creates, approves, stores, protects, changes, keeps and disposes of the documented information its AI management system needs (Clause 7.5). AI technical artefacts, such as model cards and evaluation reports, follow the same rules as policies and procedures.

## 2. Scope

- Documents: AIMS policies, procedures, plans, forms and templates.
- Records: evidence that something happened (assessments, minutes, logs, training records).
- AI artefacts: model cards, datasheets, evaluation and test reports, data lineage and provenance records, event logs, release records.
- Documents of external origin used by the AIMS.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Document owner | Drafts and updates the document, arranges review, keeps it current. |
| Approver | Approves the document for use (Section 6). |
| [AIMS MANAGER] (document controller) | Keeps the master document list, assigns IDs, checks format, publishes, runs the access review. |
| [REPOSITORY ADMIN] | Manages repository permissions and exports the user access list. |
| All staff | Use only the published version; report errors to the owner. |

## 4. Documented information the AIMS needs

| Required by | Documented information |
|---|---|
| Clause 4.3 | AIMS scope |
| Clause 5.2 | AI policy |
| Clauses 6.1.2, 6.1.3, 6.1.4 | Risk assessment, risk treatment and impact assessment processes; Statement of Applicability |
| Clause 6.2 | AI objectives |
| Clause 7.2 | Evidence of competence |
| Clause 8.1 | Evidence that processes ran as planned |
| Clauses 8.2, 8.3, 8.4 | Results of risk assessments, risk treatment and impact assessments |
| Clauses 9.1, 9.2, 9.3 | Monitoring results; audit programme and results; management review results |
| Clause 10.2 | Nonconformities, actions taken and results of corrective action |
| Annex A controls in the SoA | For example resource documentation (A.4.2), impact assessment records (A.5.3), design and technical documentation (A.6.2.3, A.6.2.7), event logs (A.6.2.8), data records (A.7) |
| {{client_name}}'s own decision | Anything else needed to run the AIMS, such as this procedure |

## 5. Identification and format

Each controlled document shows its title, ID, version, owner, approver, effective date and review period, as in the control block at the top of each AIMS template.

| Type | ID prefix | Example |
|---|---|---|
| Policy | AIMS-POL | AIMS-POL-001 AI Policy |
| Procedure | AIMS-PRO | AIMS-PRO-004 AI System Impact Assessment Procedure |
| Plan | AIMS-PLN | AIMS-PLN-001 AIMS Operational Planning Calendar |
| Form | AIMS-FRM | AIMS-FRM-002 AI System Impact Assessment Form |
| Record | AIMS-REC | AIMS-REC-010 Management review minutes [DATE] |
| AI artefact | [SYSTEM]-[TYPE] | [CLAIMS]-MODELCARD v2.3 |

Format: documents in [WORD, PUBLISHED AS PDF]; records in [GRC TOOL / SHAREPOINT LISTS]; AI artefacts in [GIT REPOSITORY], where a tagged release is the controlled version. Language: [ENGLISH]. Versions: 0.x for drafts, 1.0 at first approval, 1.1 for a minor change, 2.0 for a major change.

## 6. Review and approval

1. The owner drafts or updates the document and writes a change summary.
2. Reviewers chosen by the owner comment within [10 WORKING DAYS]. Comments and responses are kept.
3. The approver approves in [SHAREPOINT APPROVAL WORKFLOW / GRC TOOL]. The record shows name, date and version.
4. [AIMS MANAGER] publishes the approved version, updates the master list and tells affected staff.

| Document type | Approver |
|---|---|
| AI Policy, AIMS Scope Statement, Statement of Applicability, AIMS procedures, plans and forms | {{approval_authority}} |
| Records (minutes, assessments, reports) | As set in the procedure that creates them |
| AI artefacts | AI system owner, with [TECHNICAL REVIEWER] |

## 7. Storage and access

Controlled AIMS documents and records are stored in [SHAREPOINT SITE: URL]. AI artefacts are stored in [GIT REPOSITORY: NAME]. A copy held only in a personal drive, email or chat is not a controlled copy.

| Role | Policies and procedures | Risk register, treatment plan, SoA | Impact assessments | AI technical artefacts | Audit, review and CAPA records |
|---|---|---|---|---|---|
| All staff | Read | No access | No access | No access | No access |
| AI system owners | Read | Read (own systems) | Edit (own systems) | Edit (own systems) | Read |
| Data science and engineering | Read | Read | Read | Edit | No access |
| [AIMS MANAGER] | Edit | Edit | Edit | Read | Edit |
| [AI GOVERNANCE COMMITTEE] | Read | Approve | Approve | Read | Read |
| {{approval_authority}} | Approve | Approve | Read | Read | Read |
| Internal auditor | Read | Read | Read | Read | Edit (audit records only) |
| Certification auditor | Read, time-limited via [DATA ROOM] | Read, time-limited | Read, time-limited | Read, time-limited | Read, time-limited |
| [REPOSITORY ADMIN] | Permissions only | Permissions only | Permissions only | Permissions only | Permissions only |

[REPOSITORY ADMIN] exports the user access list for the site and the repository [QUARTERLY]. [AIMS MANAGER] checks it against this table, removes leavers and excess rights, and keeps the export with the review sign-off. The certification auditor will ask where AIMS documents are stored, who has access and at what level, and will want to see this list.

## 8. Distribution, retrieval and use

Staff receive links to the published version, not attachments. Downloaded or printed copies are uncontrolled and marked as such in the footer. Any record on the master list can be retrieved within [2 WORKING DAYS] of a request.

## 9. Protection

- **Confidentiality:** documents are classified under [CLASSIFICATION SCHEME]. Impact assessments and datasets may hold personal data and are limited to the roles above.
- **Integrity:** version history is switched on; approved versions are locked or published as PDF; git release tags are protected from deletion.
- **Availability:** the repository is backed up under [BACKUP POLICY] and a restore is tested [ANNUALLY].

## 10. Change control

Changes follow Section 6. Each version records what changed and why. Superseded versions are kept, marked "Superseded" and removed from general view. Approved records (for example, an approved impact assessment) are not edited; a correction creates a new version.

## 11. Retention and disposition

| Record | Minimum retention | Disposal |
|---|---|---|
| Policies, procedures and superseded versions | [CURRENT CERTIFICATION CYCLE PLUS 3 YEARS] | Secure deletion, logged |
| Risk and impact assessments, SoA versions | [LIFE OF THE AI SYSTEM PLUS 3 YEARS] | Secure deletion, logged |
| Audit, management review and CAPA records | [CURRENT CERTIFICATION CYCLE PLUS 3 YEARS] | Secure deletion, logged |
| AI artefacts and event logs | [LIFE OF THE AI SYSTEM PLUS X YEARS, OR AS LAW REQUIRES] | Secure deletion, logged |
| Training and competence records | [EMPLOYMENT PLUS X YEARS] | Secure deletion, logged |

Nothing is deleted while under a legal hold or linked to an open audit finding. Legal requirements override these periods.

## 12. Documents of external origin

| Document | Source | Owner | How the current version is tracked |
|---|---|---|---|
| ISO/IEC 42001:2023 (licensed copy) | [ISO / NATIONAL STANDARDS BODY] | [AIMS MANAGER] | Checked [ANNUALLY] for amendments |
| AI and data protection laws in [JURISDICTIONS] | Regulators | [LEGAL] | Legal register |
| Supplier model cards, system cards and assurance reports | AI suppliers | System owner | Saved at each supplier release |
| Certification body audit reports | [CERTIFICATION BODY] | [AIMS MANAGER] | Filed on receipt |
| Customer contract AI requirements | Customers | [LEGAL] | Contract register |

## 13. Master document list

| ID | Title | Type | Version | Owner | Approver | Approved | Next review | Location | Status |
|---|---|---|---|---|---|---|---|---|---|
| AIMS-POL-001 | AI Policy | Policy | [1.0] | [NAME] | {{approval_authority}} | [DATE] | [DATE] | [LINK] | Current |
| AIMS-PRO-008 | AIMS Documented Information Control Procedure | Procedure | [1.0] | [NAME] | {{approval_authority}} | [DATE] | [DATE] | [LINK] | Current |
| | | | | | | | | | |

## 14. Records produced

The master document list, approval records, version histories, quarterly user access list exports with review sign-off, disposal logs and backup restore test records.

## 15. Related documents

AI Policy; AIMS Scope Statement; AIMS Roles, Responsibilities and Authorities; AI Data Management Policy; AI System Lifecycle Procedure; AIMS Internal Audit Procedure and Programme.

## 16. Review and approval

[AIMS MANAGER] reviews this procedure {{review_period}} and when the storage platform changes. {{approval_authority}} approves changes.
`,
  },

  // ---------------------------------------------------------------------
  // 8. AIMS Internal Audit Procedure and Programme
  // ---------------------------------------------------------------------
  {
    name: 'AIMS Internal Audit Procedure and Programme',
    category: 'procedure',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-9.2'],
    description: 'Internal audit procedure with a three-year programme covering every clause and applicable Annex A control, auditor competence and independence, audit plans, working papers, grading and reporting of findings, and follow-up (Clause 9.2). Mandatory.',
    content: `# AIMS Internal Audit Procedure and Programme

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure sets out how {{client_name}} plans, runs and reports internal audits of its AI management system (Clause 9.2), and holds the three-year audit programme. Internal audit tells management whether the AIMS meets ISO/IEC 42001:2023 and {{client_name}}'s own requirements, and whether it works in practice.

## 2. Scope

All AIMS clauses (4 to 10), all Annex A controls marked included in the Statement of Applicability, and the in-scope AI systems themselves. Audits test how systems are actually built, released, monitored and used, not only whether documents exist.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Audit programme manager ([AIMS MANAGER] or [INTERNAL AUDIT LEAD]) | Maintains the programme, appoints auditors, tracks findings to closure. |
| Lead auditor | Plans and runs each audit and writes the report. |
| Auditees | Make people, records and systems available; propose corrections and actions. |
| Process owners | Own corrective actions for findings in their area. |
| {{approval_authority}} | Approves the programme and receives reports. |

## 4. Objectives and criteria

Each audit determines whether the audited area conforms to ISO/IEC 42001:2023 and to {{client_name}}'s own AIMS requirements (AI Policy, procedures, Statement of Applicability, AI objectives, and the legal and contractual requirements in scope), and whether it is implemented and kept up to date in practice. The criteria for each audit are named in its plan.

## 5. Auditor competence and independence

- **Competence:** auditors hold [ISO/IEC 42001 INTERNAL OR LEAD AUDITOR TRAINING], know the ISO 19011 audit method, and understand AI well enough to read a model card, an evaluation report and a monitoring dashboard. New auditors shadow [1] audit first. Evidence is kept in the auditor's training record.
- **Independence:** auditors do not audit their own work. [AIMS MANAGER] does not audit the processes they run (risk assessment, document control, management review preparation). Where {{firm_name}} wrote the AIMS documentation, the audit is performed by a {{firm_name}} auditor who took no part in writing it, or by an external auditor.
- Each auditor signs an independence confirmation in the audit plan.

## 6. Three-year audit programme

Suggested frequency: clauses 4 to 10 every year; every included Annex A control in Year 1; after that, areas weighted High every year and all other included areas at least once in Years 2 and 3. An area with a nonconformity in the last audit is re-audited in the next one. Weighting considers the number and risk level of AI systems the area touches, changes since the last audit, incidents and previous results.

| Area | Weighting | Year 1 (before Stage 2) | Year 2 (surveillance 1) | Year 3 (surveillance 2) | Last result |
|---|---|---|---|---|---|
| Clause 4 Context | [MEDIUM] | Full | Full | Full | |
| Clause 5 Leadership | [MEDIUM] | Full | Full | Full | |
| Clause 6 Planning (risk, impact, objectives, changes) | [HIGH] | Full | Full | Full | |
| Clause 7 Support | [MEDIUM] | Full | Full | Full | |
| Clause 8 Operation | [HIGH] | Full | Full | Full | |
| Clause 9 Performance evaluation | [MEDIUM] | Full | Full | Full | |
| Clause 10 Improvement | [MEDIUM] | Full | Full | Full | |
| A.2 Policies related to AI | [LOW] | Full | | Sample | |
| A.3 Internal organisation | [LOW] | Full | Sample | | |
| A.4 Resources for AI systems | [MEDIUM] | Full | | Sample | |
| A.5 Assessing impacts of AI systems | [HIGH] | Full | Full | Full | |
| A.6 AI system life cycle | [HIGH] | Full | Sample | Sample | |
| A.7 Data for AI systems | [HIGH] | Full | Sample | Sample | |
| A.8 Information for interested parties | [MEDIUM] | Full | Sample | | |
| A.9 Use of AI systems | [MEDIUM] | Full | | Sample | |
| A.10 Third-party and customer relationships | [MEDIUM] | Full | Sample | | |

A blank cell means not scheduled that year. The Year 1 audit finishes at least [4 WEEKS] before the Stage 2 audit, so that findings can be corrected and management review can consider the results. {{approval_authority}} approves the programme each year; changes are recorded with the reason.

## 7. Audit plan

The lead auditor sends each audit plan to auditees at least [10 WORKING DAYS] before fieldwork.

| Plan item | Content |
|---|---|
| Audit ID and dates | [AUD-YYYY-NN], [DATES] |
| Scope | Clauses, Annex A controls, AI systems, teams and locations |
| Criteria | Standard clauses; {{client_name}} documents and their versions |
| Auditors | Names and signed independence confirmation |
| Auditees and schedule | Who, which topic, when |
| Sampling approach | See below |
| Documents requested in advance | [LIST] |

Sampling: the auditor picks the samples, not the auditee. For AI systems, include the highest-risk system plus [1] other. For records, sample [10%, AT LEAST 3 AND UP TO 25] items from the full population for the audit period (for example, all releases in the last [12 MONTHS]). Record the population and how the sample was chosen.

## 8. Fieldwork and working papers

Methods: interviews, document review, record sampling, observation and re-performance (for example, re-running a check on a monitoring dashboard, or tracing a model release back to its approved impact assessment).

Working papers record each test in enough detail for another auditor to repeat it.

| Ref | Requirement | Test performed | Population and sample | Evidence seen (name, version, date) | Result | Notes |
|---|---|---|---|---|---|---|
| [8.4-01] | Impact assessment current before release | Traced sampled releases to the impact assessment log | [14 releases; sampled R-231, R-240, R-252] | [IA-2026-004 v2, approved DATE] | Conforms | |
| | | | | | | |

Result is one of: conforms, nonconformity, observation, opportunity for improvement.

## 9. Grading findings

| Grade | Meaning |
|---|---|
| Major nonconformity | A requirement is not met at all, or the failure is systemic (for example, no impact assessments for systems in production). |
| Minor nonconformity | A single or isolated lapse against a requirement. |
| Observation | Not yet a nonconformity, but likely to become one. |
| Opportunity for improvement | A better way of working where the requirement is met. |

Each nonconformity states the requirement, the evidence found and why the evidence falls short. Example: "Clause 8.2 and Section 8 of the AI Risk Assessment Methodology require reassessment after retraining. The claims triage model was retrained on [DATE] (release R-240); the assessment log has no reassessment for it."

## 10. Reporting

The lead auditor holds a closing meeting with auditees and issues the report within [10 WORKING DAYS] to [AIMS MANAGER], the process owners and {{approval_authority}}. The report states scope, criteria, auditors, dates, the sample summary, findings by grade and a conclusion on conformity and effectiveness. Audit results go to the next management review.

## 11. Follow-up

Nonconformities are logged in the CAPA register under the AIMS Nonconformity and Corrective Action Procedure. The process owner submits the correction, root cause and action plan within [15 WORKING DAYS]. The auditor or programme manager confirms closure against evidence, and the next audit of the area checks that the action worked.

## 12. Records produced

The programme with its approval and change history; each audit plan with independence confirmations; working papers and testing notes; copies of, or references to, the evidence seen; the report; closing meeting attendance; links to CAPA entries.

The certification auditor will ask for this procedure with its version and date, the programme, a recent audit plan, the report and the testing notes behind it. A report with no working papers behind it is a common finding.

## 13. Related documents

AIMS Nonconformity and Corrective Action Procedure; AIMS Management Review Procedure; AIMS Operational Planning Calendar; Statement of Applicability (ISO 42001) Cover and Approval; AIMS Documented Information Control Procedure; AIMS Roles, Responsibilities and Authorities.

## 14. Review and approval

The audit programme manager reviews this procedure {{review_period}} and after each certification audit. {{approval_authority}} approves changes.
`,
  },

  // ---------------------------------------------------------------------
  // 9. AIMS Management Review Procedure
  // ---------------------------------------------------------------------
  {
    name: 'AIMS Management Review Procedure',
    category: 'procedure',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-9.3'],
    description: 'Procedure for top management review of the AIMS: frequency and attendees, the required and AI-specific inputs, outputs, agenda and minutes templates with an action log, and the evidence to keep (Clause 9.3). Mandatory.',
    content: `# AIMS Management Review Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure sets out how {{client_name}}'s top management reviews the AI management system, decides whether it is still suitable, adequate and effective, and decides what needs to change (Clause 9.3).

## 2. Frequency and attendees

A full management review is held at least [ANNUALLY]. [AI GOVERNANCE COMMITTEE] meetings held [QUARTERLY] may cover some inputs in between. They do not replace the full review unless they cover every input in Section 4.1 and top management attends. Before the Stage 2 audit, at least one full review is held after the internal audit report is issued.

| Attendee | Role in the meeting | Required? |
|---|---|---|
| {{approval_authority}} | Chair; makes decisions | Yes |
| [AIMS MANAGER] | Prepares inputs, presents, takes minutes | Yes |
| [CHIEF TECHNOLOGY OFFICER / HEAD OF AI] | AI systems and resources | Yes |
| [HEAD OF DATA SCIENCE] | Model performance and monitoring | [YES] |
| [LEGAL / COMPLIANCE] | Legal and regulatory change | [YES] |
| [PRIVACY / DPO], [INFORMATION SECURITY] | Privacy and security matters for AI | [AS NEEDED] |
| [HR] | Competence and awareness | [AS NEEDED] |

Top management attends. If the chair must delegate, the minutes record the reason and confirm that the delegate has authority to make the decisions on the agenda.

## 3. Roles and responsibilities

- [AIMS MANAGER] schedules the review, collects inputs, circulates the pack, writes the minutes and tracks actions.
- Input owners prepare their section with data and trends, not only narrative.
- The chair approves the minutes.

## 4. Inputs

### 4.1 Inputs required by Clause 9.3

| Input | Source | Presented by |
|---|---|---|
| Status of actions from previous management reviews | Action log | [AIMS MANAGER] |
| Changes in external and internal issues relevant to the AIMS | Context register, legal register | [AIMS MANAGER], [LEGAL] |
| Changes in the needs and expectations of interested parties relevant to the AIMS | Interested parties register, customer requests | [AIMS MANAGER] |
| Trends in nonconformities and corrective actions | CAPA register | [AIMS MANAGER] |
| Trends in monitoring and measurement results | Monitoring reports; AI Objectives and Measurement Plan | AI system owners |
| Trends in audit results (internal and certification) | Audit reports | [INTERNAL AUDITOR], [AIMS MANAGER] |
| Opportunities for continual improvement | Improvement log | [AIMS MANAGER] |

### 4.2 Additional AI inputs {{client_name}} includes

| Input | Source |
|---|---|
| AI incidents and near misses: number, severity, trends, lessons | Incident log |
| Impact assessment results and log status (overdue reviews, open conditions) | Impact assessment log |
| AI risk register and treatment plan status; residual risks for acceptance; expiring acceptances | Risk register, treatment plan |
| AI objectives against targets | AI Objectives and Measurement Plan |
| New, changed and retired AI systems | AI system register |
| Supplier performance and changes | Supplier reviews |
| Resources and competence (people, tools, budget) | [HR], [AIMS MANAGER] |
| Feedback and complaints from users and affected people; reports of concerns | Feedback channels |
| AI Policy review (Section 7) | AI Policy |

## 5. Preparation

| When | Action | Who |
|---|---|---|
| [4 WEEKS] before | Calendar invite sent; input owners told what to prepare | [AIMS MANAGER] |
| [2 WEEKS] before | Inputs submitted | Input owners |
| [1 WEEK] before | Pack and agenda circulated | [AIMS MANAGER] |
| Within [5 WORKING DAYS] after | Minutes drafted and approved by the chair; actions entered in the action log | [AIMS MANAGER], chair |

## 6. Outputs

The minutes record decisions on:

- opportunities for continual improvement to take forward;
- any changes needed to the AIMS, such as scope, AI Policy, objectives, processes, controls, risk acceptance or roles;
- resources needed.

Each decision has an owner and a due date in the action log. "No change" is a valid decision when the minutes record why.

## 7. AI Policy review

The AI Policy is a standing agenda item at each full review. The minutes record either "reviewed, no change needed" with the reason, or the change required, its owner and when it will be approved. This is also the review record for Annex A.2.4.

## 8. Agenda template

1. Opening, attendance and quorum
2. Actions from previous reviews
3. Changes in external and internal issues
4. Changes in interested party needs and expectations
5. AIMS performance: nonconformities and corrective actions; monitoring and measurement; audit results
6. AI objectives status
7. AI risk and treatment status; residual risks for acceptance
8. Impact assessment results
9. AI incidents, complaints and reports of concerns
10. Suppliers, resources and competence
11. AI Policy review
12. Opportunities for improvement
13. Summary of decisions and actions
14. Date of next review

## 9. Minutes template

| Field | Entry |
|---|---|
| Date, time, location or meeting link | |
| Chair | |
| Attendees | |
| Apologies | |
| Pack circulated on | |

For each agenda item, record what was presented (with source document and version), the discussion and the decision.

| Action ID | Action | Agenda item | Owner | Due | Status | Closed on, evidence |
|---|---|---|---|---|---|---|
| [MR-2026-01] | [Fund a second fairness analyst] | [10] | [NAME] | [DATE] | Open | |
| | | | | | | |

Minutes approved by (chair): [NAME], [DATE]

## 10. Records produced

The calendar invite, agenda, input pack, attendance record (meeting tool report or signed list), approved minutes and the action log, kept under the AIMS Documented Information Control Procedure.

The certification auditor will check that every Clause 9.3 input was covered, that decisions (not only discussion) were recorded, that top management attended, and that actions from the previous review were followed up. Minutes that only say "the AIMS was reviewed" will not pass.

## 11. Related documents

AI Policy; AI Objectives and Measurement Plan; AIMS Internal Audit Procedure and Programme; AIMS Nonconformity and Corrective Action Procedure; AI Risk Treatment Procedure and Plan; AI System Impact Assessment Procedure; AI Incident Response and Communication Plan; AIMS Operational Planning Calendar.

## 12. Review and approval

[AIMS MANAGER] reviews this procedure {{review_period}}. {{approval_authority}} approves changes.
`,
  },

  // ---------------------------------------------------------------------
  // 10. AIMS Nonconformity and Corrective Action Procedure
  // ---------------------------------------------------------------------
  {
    name: 'AIMS Nonconformity and Corrective Action Procedure',
    category: 'procedure',
    tier: 'mandatory',
    requirement_refs: ['ai-clause-10.1', 'ai-clause-10.2'],
    description: 'Procedure for handling nonconformities from audits, incidents, monitoring and complaints: correction, root cause analysis, corrective action, effectiveness review, the CAPA register and the intake of improvement opportunities (Clauses 10.1 and 10.2). Mandatory.',
    content: `# AIMS Nonconformity and Corrective Action Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure sets out how {{client_name}} deals with nonconformities in its AI management system: correcting them, finding and removing their causes, and checking that the fix worked (Clause 10.2). It also sets out how improvement ideas are collected and acted on (Clause 10.1).

## 2. Scope

Any failure to meet a requirement of ISO/IEC 42001:2023, of {{client_name}}'s AIMS documents, or of a legal or contractual requirement within the AIMS scope. This includes AI system behaviour outside its approved thresholds or intended purpose, such as a fairness metric breaching its limit, or a system used for a purpose its impact assessment did not cover.

## 3. Definitions

| Term | Meaning in this procedure |
|---|---|
| Nonconformity | A requirement is not met. |
| Correction | Immediate action to contain the problem and deal with its consequences. |
| Corrective action | Action to remove the cause so the problem does not recur. |
| Root cause | The underlying reason the nonconformity occurred, not only the visible trigger. |
| Effectiveness review | A later check, with evidence, that the corrective action stopped recurrence. |

## 4. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Anyone | Reports a suspected nonconformity to [AIMS MANAGER] or through [REPORTING CHANNEL]. |
| [AIMS MANAGER] | Logs, classifies and assigns each item; tracks it; closes it after the effectiveness review; reports trends. |
| Action owner | Carries out the correction, root cause analysis and corrective action. |
| Effectiveness reviewer | Someone other than the action owner who checks the evidence. |
| [AI GOVERNANCE COMMITTEE] | Reviews major nonconformities and overdue actions. |

## 5. Sources

| Source | Examples |
|---|---|
| Internal audit | Nonconformities and observations in audit reports |
| Certification audit | Stage 1 areas of concern; Stage 2 and surveillance nonconformities |
| AI incidents | Harmful output, personal data exposed through a model, use of an unapproved AI tool |
| Monitoring | Drift, accuracy or fairness metric outside its threshold with no response |
| Complaints and feedback | Customers, affected people, reports of concerns from staff |
| Management review | Decisions that identify a failure |
| Suppliers | Breach of AI contract terms; model changed without notice |
| Self-identified | A process owner finds their own process was not followed |

## 6. Procedure

| Step | Who | Timescale | Record |
|---|---|---|---|
| 1. Log the nonconformity with its source and evidence | [AIMS MANAGER] | Within [2 WORKING DAYS] of identification | CAPA register entry |
| 2. Grade it major or minor (grades as in the AIMS Internal Audit Procedure and Programme) and assign an owner | [AIMS MANAGER] | When logged | CAPA register |
| 3. Correct: contain the problem and deal with its consequences (for example, roll back to the previous model version, switch to full human review, tell affected customers) | Action owner | Major: [2 WORKING DAYS]; minor: [10 WORKING DAYS] | Correction note |
| 4. Find the root cause (Section 7) | Action owner | Within [15 WORKING DAYS] | Root cause analysis |
| 5. Check extent: do similar nonconformities exist, or could they occur, in other AI systems, teams or processes? | Action owner, [AIMS MANAGER] | With step 4 | Extent check note |
| 6. Plan corrective action in proportion to the effects, with owner, due date and resources | Action owner; approved by [AIMS MANAGER] | With step 4 | Action plan |
| 7. Implement | Action owner | By the due date | Completion evidence |
| 8. Review effectiveness once enough time has passed to see whether it recurs | Effectiveness reviewer | [60 TO 90 DAYS] after implementation, or at the next audit | Effectiveness review |
| 9. Update the AIMS where affected: risks, impact assessments, SoA, procedures, training | [AIMS MANAGER] | Before closure | References to updated items |
| 10. Close, or reopen if not effective | [AIMS MANAGER] | After step 8 | Closed date |

## 7. Root cause analysis

"Human error" is not accepted as a root cause on its own. Ask why the process allowed the error.

**5 whys example.** Nonconformity: the claims triage model was retrained without a risk reassessment.

1. Why? The data science team did not know retraining was a trigger.
2. Why? The trigger list is in the AI Risk Assessment Methodology, which the team does not use day to day.
3. Why? The release checklist in the AI System Lifecycle Procedure has no reassessment step.
4. Why? The checklist predates the AIMS and was never updated.
5. Root cause: release gates were not aligned with AIMS triggers. Action: add a reassessment gate to the release checklist and the deployment pipeline.

**Fishbone categories for AI nonconformities:** data (quality, provenance, drift); model (design, testing, versioning); people (training, workload, awareness); process (missing or unclear steps); tools and platform (monitoring, pipelines, access); suppliers (model changes, terms); context (new users, new uses, new regulation).

## 8. Certification audit findings

Findings raised by the certification body go into the same register, tagged [CB]. The certification body sets the response deadline; check the audit report (plans are often due within [30 DAYS], and evidence for major findings within [90 DAYS]). For each finding, the certification body will expect the correction, the root cause, the corrective action and the evidence. A major nonconformity may need evidence of implementation before certification is granted.

## 9. Continual improvement (Clause 10.1)

Improvement ideas go in the improvement log, not the CAPA register, unless a requirement is not met. Sources: audit observations and opportunities for improvement, management review decisions, lessons from incidents, monitoring trends, staff and user suggestions, and changes in good practice or regulation.

| ID | Source | Opportunity | Expected benefit | Owner | Decision (adopt, defer, reject) and date | Status |
|---|---|---|---|---|---|---|
| [IMP-2026-01] | [Internal audit OFI] | [Automate the monthly fairness report] | [Saves 2 days a month; fewer transcription errors] | [NAME] | [ADOPT, DATE] | [IN PROGRESS] |
| | | | | | | |

[AIMS MANAGER] reviews the log [QUARTERLY] and reports it to management review. Successive management review minutes should show improvements completed since the previous review.

## 10. CAPA register

| ID | Source | Description | Correction | Root cause | Corrective action | Owner | Due | Effectiveness check (date, evidence, result) | Closed date |
|---|---|---|---|---|---|---|---|---|---|
| [NC-2026-003] | [Internal audit AUD-2026-01] | [Claims triage model retrained on DATE with no risk reassessment] | [Reassessment completed DATE] | [Release gates not aligned with AIMS triggers] | [Reassessment gate added to release checklist and pipeline] | [NAME, HEAD OF DATA SCIENCE] | [DATE] | [DATE: the next 4 releases all had reassessments; effective] | [DATE] |
| | | | | | | | | | |

## 11. Records produced

The CAPA register; for each nonconformity, the correction note, root cause analysis, extent check, action plan, completion evidence and effectiveness review; the improvement log; [AI GOVERNANCE COMMITTEE] minutes reviewing major findings.

The certification auditor will ask for CAPA records, the root cause analysis for each nonconformity, the action plans and evidence that the effectiveness of actions was evaluated. Closing an item on the day the fix lands, with no later check, is a common finding.

## 12. Related documents

AIMS Internal Audit Procedure and Programme; AIMS Management Review Procedure; AI Incident Response and Communication Plan; AI Risk Assessment Methodology; AI System Impact Assessment Procedure; AI System Lifecycle Procedure; AIMS Documented Information Control Procedure.

## 13. Review and approval

[AIMS MANAGER] reviews this procedure {{review_period}} and when trends in the CAPA register show it is not working. {{approval_authority}} approves changes.
`,
  },
];
