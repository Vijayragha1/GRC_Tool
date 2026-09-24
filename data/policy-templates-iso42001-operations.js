'use strict';
// ISO/IEC 42001:2023 template pack: data, transparency, reporting, incidents, responsible use and third parties (Annex A.3.3, A.7 to A.10).
const { STARTER_NOTE, CONTROL_BLOCK } = require('./policy-templates-iso42001-common');

module.exports = [
  {
    name: 'AI Data Management Policy',
    category: 'policy',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-7-2', 'ai-annex-a-7-3', 'ai-annex-a-7-4', 'ai-annex-a-7-5', 'ai-annex-a-7-6'],
    description: 'Rules for data used to develop, enhance and operate AI systems: privacy, security, representativeness, acquisition and rights to use, quality requirements, provenance and data preparation (Annex A.7.2 to A.7.6).',
    content: `# AI Data Management Policy

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This policy sets the rules {{client_name}} follows for data used to develop, enhance and operate its AI systems. It covers how data is chosen and acquired, the quality it must meet, how its history is recorded and how it is prepared. It addresses Annex A controls A.7.2 to A.7.6 of ISO/IEC 42001:2023.

## 2. Scope

This policy applies to:

- every AI system in the AI system register that falls inside the AIMS Scope Statement;
- training, validation, test and fine-tuning data, and content indexed for retrieval (for example documents used by a retrieval-augmented assistant);
- production data: inputs the system receives in operation, and outputs or user feedback that are stored and may be reused;
- data from internal systems, suppliers, partners, customers, open sources and synthetic generators;
- employees, contractors and suppliers who handle this data for {{client_name}}.

Where {{client_name}} deploys a third-party model and cannot see its training data, this policy applies to the data {{client_name}} supplies to the model (prompts, context, fine-tuning sets, retrieval content) and to what the supplier discloses about its training data. Supplier obligations are handled under the AI Supplier and Partner Management Procedure.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| AI System Owner | Accountable for the data used by their system. Approves datasets for use and signs the data review. |
| Data Steward | Keeps the AI Data Quality and Provenance Record for each dataset. Runs or coordinates quality checks and records the results. |
| Data Scientist / ML Engineer | Prepares data using documented methods. Records each preparation step and dataset version. |
| Privacy Lead | Confirms legal basis, minimisation and data subject rights where personal data is involved. |
| Security Lead | Sets access, encryption and integrity controls for AI datasets and pipelines. |
| Legal | Confirms licence terms and rights to use for purchased, shared and open data. |
| AIMS Manager | Maintains this policy. Checks compliance by sampling records and through internal audit. |

Role holders are named in AIMS Roles, Responsibilities and Authorities.

## 4. General data management requirements (A.7.2)

Each AI system has a documented data management approach. It is recorded in the AI Data Quality and Provenance Record for each dataset and summarised in the AI System Technical Documentation (Model Card). The approach covers the topics below.

### 4.1 Privacy and security

- Personal data is used only with a documented legal basis [e.g. under GDPR or the India DPDPA, as applicable] and only to the extent the stated purpose needs.
- Personal data is removed, pseudonymised or aggregated before training unless the AI System Owner and Privacy Lead approve its use in writing.
- AI datasets are stored in approved locations. Access is limited to named roles and reviewed [QUARTERLY].
- Training and production data is encrypted at rest and in transit under [INFORMATION SECURITY POLICY / CRYPTOGRAPHY POLICY].
- AI datasets are not copied to personal devices or unapproved tools, including general-purpose AI tools.

### 4.2 Data-dependent security and safety threats

The AI System Owner considers threats that arise because the system learns from, or reacts to, data. These are recorded in the AI risk assessment. As a minimum:

- data poisoning: corrupted or planted training, retrieval or feedback data;
- leakage of personal or confidential data through outputs, including memorised training records;
- prompt injection or manipulated inputs in production;
- label errors or drift that lead to unsafe or unfair outputs;
- test data contaminated by training data, which makes performance figures look better than they are.

### 4.3 Transparency and explainability

- The source and history of each dataset is recorded well enough to explain to an auditor, customer or regulator where it came from and what was done to it.
- The team can describe in plain terms how the main characteristics of the data shape the outputs (for example, which features carry most weight, or which document collections a retrieval system draws on). This feeds the model card and the AI Transparency and User Information Notice.

### 4.4 Representativeness

Training, validation and test data is compared with the population and conditions the system will meet in use (the operational domain). The comparison covers [GEOGRAPHY, LANGUAGE, CUSTOMER SEGMENT, CHANNEL, TIME PERIOD, DEMOGRAPHIC GROUPS WHERE LAWFUL TO RECORD]. Each gap gets one of three outcomes: collect more data, narrow the intended use, or accept the gap with the AI System Owner's approval and a note in the AI system impact assessment.

### 4.5 Accuracy and integrity

- Data is checked against its quality requirements (section 6) before use.
- A dataset version is frozen (immutable snapshot or hash) once it has been used to train or evaluate a released model.
- Changes to a frozen dataset create a new version. They never overwrite the old one.

## 5. Data acquisition and selection (A.7.3)

Before new data is acquired, or an existing dataset is reused for a new purpose, the Data Steward completes the acquisition section of the AI Data Quality and Provenance Record:

| Item | What to record |
|---|---|
| Categories and quantity | Types of data (text, images, transactions, labels) and the volume needed, with the reason |
| Source | Internal, purchased, shared by a partner or customer, open or public, synthetic, or a mix |
| Source characteristics | Static extract, streamed, machine generated, human generated, user feedback |
| Data subjects | Who the data is about, and demographic coverage where known and lawful to record |
| Prior handling | How the data was collected and processed before it reached {{client_name}}, and whether that met {{client_name}}'s privacy and security requirements |
| Rights to use | Licence, contract clause, consent or other basis for the planned use, and any limits (no commercial use, no model training, region restrictions) |
| Selection criteria | Why this data and this sample suit this system |
| Known limitations | Biases, gaps or quality issues declared by the source or found on intake |

Data with unclear rights is not used for training or fine-tuning until Legal confirms the rights in writing. Web scraping needs Legal approval before collection starts. For synthetic data, the record names the generator, its settings and the source data it was built from.

## 6. Data quality requirements (A.7.4)

- The AI System Owner sets quality requirements for each dataset role: training, validation, test and production.
- Requirements are measurable. Typical dimensions are completeness, accuracy, consistency, timeliness, duplication, representativeness and label quality. Thresholds are set per system.
- Checks run at acquisition, before each training run, and on production data every [MONTH / CONTINUOUSLY] to detect drift.
- A dataset that fails a requirement is not used until it is fixed, or until the AI System Owner accepts the failure in writing with a reason. Accepted failures are recorded as risks.
- Thresholds are stricter, and checks more frequent, for systems rated higher in the AI system impact assessment.

## 7. Data provenance (A.7.5)

The Data Steward keeps a provenance log for each dataset. It records creation, update, transcription, abstraction (summarising or aggregating), validation, transfer of control to or from another party, sharing and transformation. Each entry shows the date, who did it, what changed and the resulting version or hash. Each released model version is linked to the exact dataset versions used to train and test it. At each data review the Data Steward checks that the recorded chain matches the data actually held. Where ML tooling records lineage automatically [e.g. MLFLOW, SAGEMAKER, DVC], that export is the provenance log and the record references it.

## 8. Data preparation (A.7.6)

Preparation methods are chosen for a stated reason and recorded. They include statistical exploration, cleaning, deduplication, imputation of missing values, normalisation, scaling, labelling, encoding, sampling, augmentation and anonymisation. For each step the record shows the method, parameters, who or which pipeline ran it, the date and the effect on the dataset (rows removed, distribution change). Labelling follows written guidelines. Where more than one labeller works on a dataset, agreement is measured on a sample of [5%] of items. Anonymisation is tested for re-identification risk before data is treated as non-personal. Preparation code is kept under version control.

## 9. Approvals

| Decision | Approver | Record |
|---|---|---|
| Acquire new external data | AI System Owner and Legal | Acquisition section of the record |
| Use personal data for training or fine-tuning | AI System Owner and Privacy Lead | Record, with privacy assessment reference |
| Accept a failed quality requirement | AI System Owner | Issues section of the record |
| Release a dataset version for training or evaluation | AI System Owner | Data review sign-off |
| Share an AI dataset outside {{client_name}} | AI System Owner and Legal | Provenance log entry |

## 10. Retention and disposal

AI datasets are kept for [RETENTION PERIOD, e.g. LIFE OF THE MODEL PLUS 2 YEARS] so a released model can be explained and, if needed, rebuilt. Personal data within them follows [RECORDS RETENTION SCHEDULE]. Disposal is recorded in the provenance log.

## 11. Exceptions

Exceptions are requested in writing to the AIMS Manager, approved by {{approval_authority}}, limited to [6 MONTHS] and recorded in [EXCEPTIONS REGISTER].

## 12. Records produced

- AI Data Quality and Provenance Record for each dataset version, kept in [DATA CATALOGUE / DOCUMENT REPOSITORY].
- Lineage exports from ML tooling.
- Data review sign-offs and the approvals in section 9.
- Access reviews for AI datasets.

## 13. Related documents

- AI Policy
- AI Data Quality and Provenance Record
- AI System Lifecycle Procedure
- AI System Impact Assessment Procedure
- AI System Technical Documentation (Model Card)
- AI Supplier and Partner Management Procedure
- AIMS Roles, Responsibilities and Authorities

## 14. Review and approval

This policy is reviewed every {{review_period}}, and sooner when a new type of data source, a new AI system with significant impact, or a relevant change in law is introduced. It is approved by {{approval_authority}}.
`,
  },

  {
    name: 'AI Data Quality and Provenance Record',
    category: 'form',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-7-4', 'ai-annex-a-7-5', 'ai-annex-a-7-6'],
    description: 'Per-dataset, per-version record of source, rights, quality requirements and results, provenance events, preparation steps and the data review sign-off (Annex A.7.4 to A.7.6).',
    content: `# AI Data Quality and Provenance Record

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose and how to use this form

Complete one record for each dataset version. A new extract, relabelling or new preparation step creates a new version and a new record. The completed record is the evidence that the dataset met its requirements before use and that its provenance was checked. It applies the AI Data Management Policy and supports Annex A controls A.7.4, A.7.5 and A.7.6.

Store the record in [DATA CATALOGUE / REPOSITORY PATH]. Where ML tooling already holds quality results or lineage, attach the export or give the run ID. Do not retype what the tool records.

## 2. Dataset register entry

| Field | Entry |
|---|---|
| Dataset ID | [DS-000] |
| Dataset name | [NAME] |
| Version | [v1.0] / hash [SHA-256] |
| AI system(s) | [AI SYSTEM NAME, INVENTORY ID] |
| Purpose | [TRAINING / VALIDATION / TEST / PRODUCTION / FINE-TUNING / RETRIEVAL] |
| Source | [INTERNAL / PURCHASED / SHARED / OPEN / SYNTHETIC / MIXED]: [NAME OF SOURCE] |
| Source characteristics | [STATIC / STREAMED / MACHINE GENERATED / HUMAN GENERATED] |
| Data owner | [NAME, ROLE] |
| Data Steward | [NAME] |
| Legal basis or licence | [CONTRACT CLAUSE / LICENCE NAME AND VERSION / CONSENT / OTHER BASIS] |
| Restrictions on use | [e.g. NO REDISTRIBUTION, NO TRANSFER OUTSIDE REGION, DELETE BY DATE] |
| Personal data | [YES / NO]. Categories: [CATEGORIES] |
| Date acquired | [DATE] |
| Size | [ROWS / FILES / TOKENS] |
| Storage location | [LOCATION] |
| Retention | [PERIOD] |

## 3. Acquisition and selection

| Question | Answer |
|---|---|
| Why does the system need this data? | |
| Why this source and sample rather than alternatives? | |
| Who are the data subjects, and which groups are covered? | |
| How was the data collected and handled before it reached {{client_name}}? | |
| Did that handling meet {{client_name}}'s privacy and security requirements? What is the evidence? | |
| Biases, gaps or limitations declared by the source | |
| Rights to use confirmed by Legal (name, date) | |

## 4. Quality requirements and results

| Dimension | Measure | Threshold | Result | Pass / Fail |
|---|---|---|---|---|
| Completeness | Share of required fields populated | [VALUE, e.g. 98%] | | |
| Accuracy | Share of sampled records matching the source of truth (sample of [N]) | [VALUE] | | |
| Consistency | Records failing schema or business rules | [VALUE] | | |
| Timeliness | Date range of records compared with the period the system serves | [VALUE] | | |
| Duplication | Share of exact or near duplicates | [VALUE] | | |
| Representativeness | Share of each segment compared with the operational domain | [VALUE, e.g. WITHIN 5 POINTS] | | |
| Label quality | Agreement between labellers, or error rate on an audited sample | [VALUE] | | |
| Train and test separation | Records present in both training and test sets | [VALUE, e.g. 0] | | |
| [OTHER] | | [VALUE] | | |

Checked on [DATE] by [NAME]. Tool, script or run ID: [REFERENCE].

**Representativeness notes.** Describe the operational domain (who and what the system will see in use) and how this dataset compares: [TEXT]. List under-represented segments and the decision for each (collect more data / narrow intended use / accept with approval): [TEXT].

## 5. Provenance log

| Date | Event | Performed by | Description | Version or hash |
|---|---|---|---|---|
| [DATE] | Created | [NAME / PIPELINE] | [e.g. EXTRACT FROM SOURCE SYSTEM, FILTER CRITERIA] | [v1.0 / HASH] |
| [DATE] | Transferred | [SUPPLIER] | [e.g. RETURNED BY LABELLING VENDOR UNDER CONTRACT REF] | |
| [DATE] | Transformed | | | |
| [DATE] | Validated | | | |
| [DATE] | Shared | | [RECIPIENT, PURPOSE, APPROVAL REF] | |
| [DATE] | Updated | | | |

Event types: created, updated, transcribed, abstracted, validated, transferred (control passed to or from another party), shared, transformed, disposed.

Models trained or evaluated with this version: [MODEL NAME AND VERSION, REGISTRY REFERENCE].

Provenance verified on [DATE] by [NAME]: the recorded chain was compared with the data held. Result: [MATCHES / DIFFERENCES FOUND, WITH DETAILS].

## 6. Preparation steps

| Step | Method | Parameters | Reason | Effect on dataset | Performed by | Date |
|---|---|---|---|---|---|---|
| 1 | Statistical exploration | [PROFILE REPORT REF] | Understand distributions before cleaning | None | | |
| 2 | Cleaning / deduplication | [RULES] | | [ROWS REMOVED] | | |
| 3 | Imputation | [METHOD] | | [FIELDS AND ROWS AFFECTED] | | |
| 4 | Normalisation / scaling | [METHOD] | | | | |
| 5 | Labelling | [GUIDELINE VERSION, NUMBER OF LABELLERS] | | | | |
| 6 | Encoding | [METHOD] | | | | |
| 7 | Anonymisation / pseudonymisation | [METHOD, RE-IDENTIFICATION TEST REF] | | | | |
| 8 | [SAMPLING / AUGMENTATION / OTHER] | | | | | |

Preparation code: [REPOSITORY, COMMIT ID].

## 7. Issues and remediation

| # | Issue | Requirement affected | Action (fix / narrow use / accept) | Owner | Due | Closed |
|---|---|---|---|---|---|---|
| 1 | | | | | | |

## 8. Data review sign-off

| Check | Confirmed (Y/N) | Comment |
|---|---|---|
| All quality requirements met, or failures accepted in section 7 | | |
| Provenance log complete and verified against the data held | | |
| Preparation steps recorded with a code reference | | |
| Rights to use confirmed for this purpose | | |
| Personal data use approved by the Privacy Lead (if applicable) | | |
| Representativeness gaps recorded and reflected in the impact assessment | | |

Decision: [APPROVED FOR USE / APPROVED WITH CONDITIONS / NOT APPROVED]. Conditions: [TEXT].

| Role | Name | Signature or system approval | Date |
|---|---|---|---|
| Data Steward | | | |
| AI System Owner | | | |
| Privacy Lead (if personal data) | | | |

## 9. Records and retention

The signed record, attached exports and remediation evidence are kept for [RETENTION PERIOD] after the last model trained on this version is retired.

## 10. Related documents

- AI Data Management Policy
- AI System Lifecycle Procedure
- AI System Impact Assessment Procedure
- AI System Technical Documentation (Model Card)

## 11. Review and approval

This form is reviewed every {{review_period}} by {{document_owner}} and approved by {{approval_authority}}.
`,
  },

  {
    name: 'AI Transparency and User Information Notice',
    category: 'form',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-8-2'],
    description: 'Fill-in notice telling users of an AI system what it does, its limits, how to get human review and how to report problems, with a placement guide and element checklist (Annex A.8.2).',
    content: `# AI Transparency and User Information Notice

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This template gives {{client_name}} a notice that tells users of an AI system what they need to know to use it and to judge its outputs. It also sets where the notice appears. It supports Annex A control A.8.2. Complete one notice per AI system, or per user group where audiences need different information (for example internal case handlers and external customers).

## 2. When a notice is required

Every AI system in the AIMS Scope Statement that has users needs a notice. Users may be staff, business customers or members of the public. Where a person might not realise they are dealing with AI, or that content was generated by AI, they are told at the point of interaction, not only in a document.

## 3. Roles and responsibilities

- **AI System Owner:** drafts and maintains the notice and confirms it matches the current system version.
- **Product / UX:** places the notice in the product and keeps screenshots of each placement.
- **Legal and Privacy:** check consistency with terms, privacy notices and applicable law [e.g. EU AI Act transparency obligations, if applicable].
- **AIMS Manager:** checks that notices exist and are current as part of the AIMS Communication Plan cycle.
- **Approver:** {{approval_authority}} or [DELEGATE] approves the first version and each material change.

## 4. Where the notice appears

| Channel | What is shown | Owner |
|---|---|---|
| In-product label | One-line disclosure at the point of use ("AI-generated", "You are chatting with an AI assistant") | Product |
| In-product info panel | Short notice (section 7) with a link to the full notice | Product |
| Public web page | Full notice (section 6) at [URL] | [OWNER] |
| Help centre / user documentation | Full notice plus educational material | [OWNER] |
| Contracts and order forms (business customers) | Reference to the full notice and customer documentation | Legal |
| Intranet (internal tools) | Full notice and link to training | [OWNER] |

## 5. Notice elements checklist

| # | Element | Content for this system | Where shown | Done (Y/N) |
|---|---|---|---|---|
| 1 | The user is interacting with AI, or content is AI-generated | | In-product label | |
| 2 | Purpose of the system | | | |
| 3 | How to interact with it | | | |
| 4 | How and when to override an output or ask for human review | | | |
| 5 | Technical requirements | | | |
| 6 | Limitations and known failure modes | | | |
| 7 | Accuracy and performance information | | | |
| 8 | Impact assessment findings: benefits, harms and risks for particular contexts or groups | | | |
| 9 | How claims about benefits are checked and revised | | | |
| 10 | How users hear about updates and changes | | | |
| 11 | Contact and how to report a problem | | | |
| 12 | Educational material | | | |
| 13 | Date of the notice and the system version it describes | | | |

## 6. Full notice (fill-in)

**About [AI SYSTEM NAME]**

**This service uses AI.** [AI SYSTEM NAME] is an artificial intelligence system operated by {{client_name}}. [Content marked "AI-generated" was produced by the system and [HAS / HAS NOT] been checked by a person.]

**What it is for.** [One or two sentences on the task it performs and the decisions it supports. Say what it is not for.]

**How to use it.** [Inputs it accepts, how to phrase requests, how to read the output, what any confidence indicator means.]

**When a person reviews the result.** [Which outputs a person always checks before they take effect.] You can ask for a person to review any result that affects you by [METHOD]. We aim to respond within [RESPONSE TIME]. [For staff: you may override the output when [CONDITIONS]. Record the override in [TOOL].]

**What you need.** [Supported languages, file types, devices, browsers, connection.]

**What it does not do well.** [Plain description of limits and failure modes, e.g. "It can state wrong facts confidently", "It is less accurate for [GROUP / CONDITION]", "It does not know about events after [DATE]".]

**How accurate it is.** [A plain measure with its source and date, e.g. "In testing on [DESCRIPTION OF TEST DATA] in [MONTH YEAR], reviewers rated [X] of every 100 answers correct."]

**Benefits and risks.** [Summary of relevant AI system impact assessment findings: expected benefits, and possible harms or risks in particular situations or for particular groups, with what {{client_name}} does about them.]

**How we check our claims.** We re-test the system every [FREQUENCY] and after significant changes. If results change, we update this notice and the figures above.

**Changes.** [How users are told about changes: release notes at [URL], in-product message, email to account administrators.] This notice was last updated on [DATE] and describes version [VERSION].

**Questions and problems.** Contact [CONTACT]. To report a harmful, unfair or wrong result, use [REPORTING CHANNEL].

**Learn more.** [GUIDES, TRAINING, FAQ, PUBLIC MODEL CARD SUMMARY.]

## 7. Short in-product notice (example)

> **You are using an AI assistant.** [AI SYSTEM NAME] uses AI to draft answers. Answers can be wrong, so check anything important before you rely on it. It is less reliable for [TOPICS]. A person reviews [WHICH CASES]. To speak to a person or report a problem, [ACTION, e.g. SELECT "TALK TO OUR TEAM"]. More about how this works: [URL] (updated [DATE]).

## 8. Writing guidance

- Write for the least technical user. Use short sentences and everyday words.
- Describe failure modes as the user would see them, not in model terms.
- Give every number a source and a date. Do not claim a benefit that has not been measured.
- Keep the notice consistent with the AI System Technical Documentation (Model Card), which remains the technical source.
- Provide the notice in each language the system serves.

## 9. Keeping the notice current

The AI System Owner reviews the notice when the model version changes, the intended use or user group changes, the impact assessment is updated, measured performance moves by more than [THRESHOLD], or the law changes. Otherwise it is reviewed every [12 MONTHS].

## 10. Records produced

- Approved notice with version, date and approver.
- Dated screenshots of each placement in section 4.
- Change history of the notice.

These are kept in [REPOSITORY] for [RETENTION PERIOD].

## 11. Related documents

- AI Policy
- AIMS Communication Plan
- AI System Technical Documentation (Model Card)
- AI System Impact Assessment Procedure
- AI Adverse Impact Reporting Procedure
- Responsible AI Use and Acquisition Policy

## 12. Review and approval

This template and each completed notice are reviewed every {{review_period}}. Completed notices are approved by {{approval_authority}} or [DELEGATE].
`,
  },

  {
    name: 'AI Concern Reporting Procedure',
    category: 'procedure',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-3-3'],
    description: 'Internal channel for employees and contractors to raise concerns about the organisation\'s role with respect to AI systems, with confidentiality, investigation, escalation, protection from reprisal and a concern log (Annex A.3.3).',
    content: `# AI Concern Reporting Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure gives employees and contractors a way to raise concerns about {{client_name}}'s role with respect to AI systems. It sets how concerns are received, investigated, escalated and resolved, and how the people involved are protected. It supports Annex A control A.3.3.

## 2. Scope

**Who can report:** employees, contractors, temporary staff, interns and [SUPPLIER STAFF WORKING ON {{client_name}} AI SYSTEMS]. Users, customers and other external parties use the AI Adverse Impact Reporting Procedure.

**What can be reported, for example:**

- an AI system producing unfair, unsafe or misleading outputs;
- AI used outside its approved intended use, or without approval;
- data used for AI without rights to use or without privacy approval;
- pressure to skip an impact assessment, a test or a human review step;
- inaccurate statements to customers or regulators about {{client_name}}'s AI;
- confidential data entered into unapproved AI tools;
- concerns about a supplier's AI practices.

Personal grievances follow [HR GRIEVANCE PROCEDURE]. Security incidents follow the incident procedure. If unsure, report here and the concern will be routed. This procedure extends [WHISTLEBLOWING POLICY]; it does not replace it.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Reporter | Raises the concern in good faith and gives the information they have |
| Concern Receiver ([AIMS MANAGER / ETHICS OFFICER]) | Logs, acknowledges and triages concerns; assigns an investigator; tracks to closure |
| Alternate Receiver ([HEAD OF LEGAL / AUDIT COMMITTEE CHAIR]) | Receives concerns that involve the Concern Receiver or top management |
| Investigator | Establishes the facts and recommends a resolution |
| Line managers | Pass any concern they hear to the Concern Receiver the same day. They do not investigate. |
| [AI GOVERNANCE COMMITTEE] | Receives escalations, decides resolution of high-severity concerns, reviews trends |
| HR | Handles any report of reprisal |

**Investigators** have completed [INVESTIGATION TRAINING], have no conflict of interest in the matter, and can call on an AI technical specialist. They may access AI system records, logs, datasets and supplier correspondence, and interview staff. They may recommend suspending an AI system. The [AIMS MANAGER / AI SYSTEM OWNER] may suspend a system while an investigation runs if harm may be ongoing.

## 4. Reporting channels

| Channel | Details | Anonymous option | Monitored by |
|---|---|---|---|
| Email | [EMAIL] | No (identity seen only by the Receiver) | Concern Receiver |
| Hotline | [HOTLINE], [HOURS] | [YES, IF OPERATED BY A THIRD PARTY] | [PROVIDER] |
| Online form | [FORM] | Yes | Concern Receiver |
| In person | Line manager, AIMS Manager or [ETHICS OFFICER] | No | Concern Receiver |

## 5. Confidentiality and anonymity

- The reporter's identity is known only to the Receiver and the Investigator. It is shared further only with the reporter's consent or where the law requires.
- Anonymous reports are accepted and investigated as far as the information allows. The form and hotline give a case number for anonymous two-way follow-up.
- Case files are kept in [RESTRICTED LOCATION] with access limited to [ROLES].
- Reports to management use case numbers and themes, not names.

## 6. Promoting the channel

The channel is covered in induction and in annual AI awareness training, published on the intranet at [URL], referenced in the AI Policy and the Responsible AI Use and Acquisition Policy, and reminded to all staff [TWICE A YEAR] under the AIMS Communication Plan. Line managers are briefed on how to pass concerns on.

## 7. Procedure

| Step | Who | Action | Record | Timeframe |
|---|---|---|---|---|
| 1. Receive | Concern Receiver | Log the concern and assign a case number | Concern log entry | [SAME WORKING DAY] |
| 2. Acknowledge | Concern Receiver | Confirm receipt if the reporter is contactable; explain next steps and protections | Acknowledgement | [2 WORKING DAYS] |
| 3. Triage | Concern Receiver | Rate severity (section 8), check conflicts, route (investigate here, security incident, HR, Legal) | Triage note | [5 WORKING DAYS] |
| 4. Interim action | AI System Owner at the Receiver's request | Where harm may be ongoing, pause the feature, add human review or restrict use | Action record | [24 HOURS FOR HIGH] |
| 5. Investigate | Investigator | Gather facts, review records and logs, interview, conclude | Investigation report | [30 DAYS], extended only with a recorded reason |
| 6. Resolve | AI System Owner or [AI GOVERNANCE COMMITTEE] | Agree actions. Raise a nonconformity and corrective action (Clause 10.2) where the AIMS failed. | Action plan, corrective action ref | Per action plan |
| 7. Feedback | Concern Receiver | Tell the reporter the outcome as far as confidentiality allows | Feedback message | [5 WORKING DAYS AFTER RESOLUTION] |
| 8. Close | Concern Receiver | Confirm actions are complete and close the case | Closed log entry | |

## 8. Severity and escalation to management

| Severity | Description | Escalation |
|---|---|---|
| High | Possible harm to people, possible breach of law, or alleged misconduct by senior staff | To [AI GOVERNANCE COMMITTEE CHAIR] and {{approval_authority}} within [24 HOURS] |
| Medium | Control failure with no evidence of harm yet | To the AIMS Manager within [5 WORKING DAYS]; included in the monthly summary |
| Low | Question or improvement suggestion | Handled by the Receiver; included in the periodic report |

A concern not resolved within its timeframe is escalated one level. Concerns about top management go to the Alternate Receiver.

## 9. Protection from reprisal

- No one is dismissed, demoted, disciplined, excluded or otherwise disadvantaged for raising a concern in good faith, even if it is not upheld.
- The same protection covers investigators and witnesses.
- Reprisal is a disciplinary matter under [DISCIPLINARY POLICY].
- A person who believes they face reprisal reports it to [HR LEAD / ALTERNATE RECEIVER]. It is handled as High severity.
- Reports made knowingly false and in bad faith may be handled under [DISCIPLINARY POLICY].
- [Whistleblower protection law may also apply, e.g. national laws implementing the EU Whistleblowing Directive. Confirm with counsel.]

## 10. Reporting on concerns

The Concern Receiver reports [QUARTERLY] to [AI GOVERNANCE COMMITTEE] and gives a summary as input to management review (Clause 9.3): number received, by category, severity and channel; time to acknowledge and resolve against targets; themes; actions taken. Names are never included. Counts below [3] in a category are merged so no one can be identified.

## 11. Concern log

| Case ID | Date received | Channel | Anonymous (Y/N) | Category | AI system | Severity | Investigator | Escalated to / date | Outcome | Corrective action ref | Feedback given (date) | Closed (date) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [AC-001] | | | | | | | | | | | | |

## 12. Records produced

The concern log, case files (acknowledgement, triage note, investigation report, feedback), promotion evidence (training records, intranet page, dated reminders) and the periodic reports. Kept in [RESTRICTED LOCATION] for [RETENTION PERIOD].

## 13. Related documents

- AI Policy
- AIMS Roles, Responsibilities and Authorities
- AIMS Communication Plan
- AI Adverse Impact Reporting Procedure
- AI Incident Response and Communication Plan
- Responsible AI Use and Acquisition Policy

## 14. Review and approval

This procedure is reviewed every {{review_period}} and after any case that shows a weakness in it. It is approved by {{approval_authority}}.
`,
  },

  {
    name: 'AI Adverse Impact Reporting Procedure',
    category: 'procedure',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-8-3'],
    description: 'External channel for users, customers and affected people to report adverse impacts of an AI system, with publication, contract clauses, triage, response times, feedback and a report log (Annex A.8.3).',
    content: `# AI Adverse Impact Reporting Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure lets users, customers, affected people and other external parties report adverse impacts of {{client_name}}'s AI systems. It sets how reports are received, assessed, answered and fed back into the AIMS. It supports Annex A control A.8.3. Staff concerns follow the AI Concern Reporting Procedure.

## 2. Scope

All AI systems in the AIMS Scope Statement that are used by, or affect, people outside {{client_name}}. Reporters include end users, customers and their staff, people affected by an AI-supported decision who never used the system, partners, researchers and advocacy groups. Enquiries from regulators are logged here and passed to Legal the same day.

## 3. What counts as an adverse impact

- A wrong output that someone relied on and that caused loss or inconvenience.
- Unfair treatment of a person or group.
- Harmful, offensive or unsafe content.
- Personal data revealed or used in an unexpected way.
- A decision made without a way to reach a person.
- Misleading information about whether or how AI is used.
- A way to make the system misbehave (for example a prompt that bypasses its safeguards).

## 4. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Intake Owner ([SUPPORT LEAD / AIMS MANAGER]) | Monitors the channels, logs and acknowledges reports, assigns them |
| Support agents | Recognise AI-related reports arriving through general support, tag them [AI-IMPACT] and route them to the Intake Owner |
| AI System Owner | Assesses and investigates, decides actions, approves the response |
| Privacy Lead / Security Lead | Take over aspects involving personal data or security |
| Legal | Reviews responses involving liability, regulators or contract terms |
| AIMS Manager | Analyses trends and reports to management review |

## 5. Reporting channels and where they are published

| Channel | Details | Published at |
|---|---|---|
| Web form | [URL] | Product site footer, help centre, AI Transparency and User Information Notice |
| Email | [EMAIL] | AI notice, terms of service |
| In-product flag | "Report this result" control next to AI outputs | Next to each AI output |
| Customer support portal | [PORTAL] | Customer contracts and onboarding pack |
| Phone or post (accessibility) | [NUMBER / ADDRESS] | [WHERE] |

Channels can be used without an account, accept reports in [LANGUAGES], meet [ACCESSIBILITY STANDARD] and say what happens next. The form asks for: system or product, date and time, what happened, who was affected, a screenshot or output (optional), contact details (optional) and whether a reply is wanted.

## 6. Contract and service level clauses

For business customers and partners who deploy or resell {{client_name}} AI, include clauses such as the following (Legal adapts):

> **AI impact reporting.** Each party will notify the other within [5 BUSINESS DAYS] of becoming aware of a credible report that [SERVICE] has caused or may cause an adverse impact on individuals or groups. Notices go to [CONTACT] and include the information reasonably available. {{client_name}} will acknowledge within [2 BUSINESS DAYS], share the outcome of its assessment and agree with the customer how affected people are informed.

> **End-user reporting.** [CUSTOMER] will make available to its end users either {{client_name}}'s reporting channel or its own channel that forwards AI-related reports to {{client_name}} within [5 BUSINESS DAYS].

## 7. Procedure

| Step | Who | Action | Record |
|---|---|---|---|
| 1. Receive | Intake Owner | Log the report with a reference number | Log entry |
| 2. Acknowledge | Intake Owner | Reply with reference number and expected timeline (section 8) | Acknowledgement |
| 3. Triage | Intake Owner with AI System Owner | Set severity. If it meets the AI incident definition, open an incident under the AI Incident Response and Communication Plan. Route personal data or security aspects. | Triage note |
| 4. Assess | AI System Owner | Reproduce where possible, check logs under the AI Event Logging Standard, and compare with the AI system impact assessment. If the harm or affected group was not foreseen, update the assessment under the AI System Impact Assessment Procedure. | Assessment note, impact assessment update ref |
| 5. Act | AI System Owner | Fix, narrow use, update the notice, or raise a corrective action (Clause 10.2) | Action record |
| 6. Respond | Intake Owner | Tell the reporter the outcome (section 9) | Response |
| 7. Close | Intake Owner | Confirm actions are complete and close | Closed log entry |

## 8. Response timeframes

| Severity | Examples | Acknowledge | Initial assessment | Resolution or update |
|---|---|---|---|---|
| Critical | Ongoing harm, safety risk, many people affected | [24 HOURS] | [48 HOURS] | Handled as an AI incident |
| High | Significant harm to an individual, unfair decision | [2 BUSINESS DAYS] | [5 BUSINESS DAYS] | [30 DAYS] |
| Medium | Wrong output with limited effect | [3 BUSINESS DAYS] | [10 BUSINESS DAYS] | [60 DAYS] |
| Low | Feedback, suggestion | [5 BUSINESS DAYS] | As scheduled | [NEXT RELEASE] |

## 9. Feedback to the reporter

The reply is in plain language and says what was found, what {{client_name}} changed or decided, and what the reporter can do if they disagree ([ESCALATION CONTACT], and [OMBUDSMAN / REGULATOR] where one applies). It never discloses another person's data. Where no change is made, the reply says why.

## 10. Adverse impact log

| Ref | Date received | Channel | Reporter type | AI system | Description | Severity | Incident ref | Impact assessment updated (Y/N) | Action | Acknowledged (date) | Responded (date) | Closed (date) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [AI-R-001] | | | | | | | | | | | | |

## 11. Periodic review

- The AI System Owner reviews open reports for their system every [MONTH].
- The AIMS Manager reports every [QUARTER] and as input to management review (Clause 9.3): volume by system and category, performance against timeframes, repeat issues, impact assessment updates triggered and actions taken.
- The Intake Owner sends a test report through each channel every [QUARTER] to confirm routing works, and records the result.

## 12. Records produced

The log, acknowledgements, assessment notes, responses, contract clause references, test submissions and the periodic reports. Kept in [TICKETING SYSTEM / REPOSITORY] for [RETENTION PERIOD].

## 13. Related documents

- AI Transparency and User Information Notice
- AI Incident Response and Communication Plan
- AI System Impact Assessment Procedure
- AI Event Logging Standard
- AI Concern Reporting Procedure
- AIMS Communication Plan

## 14. Review and approval

This procedure is reviewed every {{review_period}} and when a new customer-facing AI system goes live. It is approved by {{approval_authority}}.
`,
  },

  {
    name: 'AI Incident Response and Communication Plan',
    category: 'plan',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-8-4', 'ai-annex-a-8-5'],
    description: 'How AI incidents are detected, contained, investigated and resolved, who is told what and when, and what information is shared with authorities and interested parties, with an incident ticket template (Annex A.8.4 and A.8.5).',
    content: `# AI Incident Response and Communication Plan

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This plan sets how {{client_name}} detects, contains, investigates and resolves AI incidents, and who is told what, when and by whom. It covers Annex A controls A.8.4 (communicating incidents) and A.8.5 (information for interested parties, including authorities). It extends [INFORMATION SECURITY INCIDENT MANAGEMENT PROCEDURE]. When an event is both a security incident and an AI incident, one ticket is opened and both are followed.

## 2. Scope

All AI systems in the AIMS Scope Statement, including third-party models that {{client_name}} deploys.

## 3. What counts as an AI incident

| Category | Examples |
|---|---|
| Failure or performance loss | Outage; accuracy below [THRESHOLD]; confirmed drift alert |
| Unexpected behaviour | Outputs outside the intended use; agent actions nobody authorised; behaviour change after a supplier model update |
| Harmful output | Unsafe advice; offensive or defamatory content; fabricated facts someone relied on |
| Bias or fairness event | Measured disparity above [THRESHOLD]; credible report of unfair treatment |
| Data poisoning or model compromise | Tampered training or retrieval data; stolen model weights; prompt injection that exposes data |
| Privacy | Personal data appearing in outputs; training data leak |
| Misuse | Use outside the intended purpose by staff, customers or attackers |

Detection sources: monitoring alerts under the AI Event Logging Standard, the AI Adverse Impact Reporting Procedure, the AI Concern Reporting Procedure, supplier notices, customer reports and testing.

## 4. Roles

| Role | Responsibility |
|---|---|
| AI Incident Lead ([ROLE]) | Runs the response and owns the ticket |
| AI System Owner | Decides containment, rollback and re-release |
| ML Engineer on call | Investigates the technical cause |
| Security Lead / Privacy Lead | Handle security aspects and personal data breach assessment |
| Legal | Decides on regulatory and contractual notifications |
| Communications | Drafts external messages |
| Disclosure Approver ({{approval_authority}} or [DELEGATE]) | Approves all external communication and authority notifications |

## 5. Severity levels

| Level | Criteria | Response starts | Management updates |
|---|---|---|---|
| SEV1 Critical | Harm to people ongoing or likely; notification to an authority may be required; many users affected | [1 HOUR] | [EVERY 4 HOURS] |
| SEV2 High | Significant harm to individuals or a customer; material failure of a system rated high impact | [4 HOURS] | [DAILY] |
| SEV3 Medium | Limited effect; contained or workaround exists | [1 BUSINESS DAY] | [WEEKLY] |
| SEV4 Low | Near miss or no harm | [5 BUSINESS DAYS] | [MONTHLY REPORT] |

## 6. Response steps

1. **Detect and log.** Anyone who spots a possible AI incident reports it to [CHANNEL]. The AI Incident Lead opens a ticket in [TICKETING SYSTEM] with the label [AI-INCIDENT], using section 12.
2. **Triage.** Set category and severity; note the systems, model versions, and whether personal or customer data is involved.
3. **Preserve evidence.** Before changing anything, keep logs, the model version, sample inputs and outputs, and a data snapshot.
4. **Contain.** Options: switch off the feature flag; roll back to the last approved model version; send all outputs to human review; limit use to a user group; tighten filters; revoke keys or access; pause retraining pipelines; call the supplier.
5. **Investigate.** Find the cause: data, model, integration, supplier change or misuse. Check whether the AI system impact assessment foresaw this harm.
6. **Resolve.** Fix, then retest under the AI System Lifecycle Procedure before re-enabling. The AI System Owner approves re-release.
7. **Learn.** Hold a post-incident review within [10 BUSINESS DAYS] for SEV1 and SEV2. Update the risk assessment, impact assessment, model card and user notice as needed, and raise corrective actions (Clause 10.2).

## 7. Who must be told (A.8.4)

| Incident type | Audience | Timeline | Channel | Approver |
|---|---|---|---|---|
| SEV1 or SEV2 affecting a customer or its users | Affected customers | [PER CONTRACT, e.g. 48 HOURS] | Account manager and email | Disclosure Approver |
| Harm to identifiable individuals | Affected individuals | [TIMELINE] | Email / in-product | Disclosure Approver |
| Personal data breach | Data protection authority; data subjects where required | [DEADLINE, CONFIRM WITH COUNSEL] | [AUTHORITY PORTAL] | Privacy Lead and Legal |
| Serious incident with a regulated AI system | [AUTHORITY] | [DEADLINE, CONFIRM WITH COUNSEL] | [CHANNEL] | Legal |
| Caused by a supplier | Supplier | [IMMEDIATELY] | Supplier incident contact | AI Incident Lead |
| Any SEV1 or SEV2 | Top management, affected staff users | Per section 5 | [CHANNEL] | AI Incident Lead |
| Publicly visible incident | Public | [WHEN] | Status page / statement | Disclosure Approver |

Legal keeps the authority notification register below. This template does not state legal deadlines; Legal confirms each entry.

| Jurisdiction | Regime | Trigger | Authority | Deadline | Owner |
|---|---|---|---|---|---|
| [EU] | [GDPR] | [PERSONAL DATA BREACH] | [LEAD SUPERVISORY AUTHORITY] | [DEADLINE] | Privacy Lead |
| [EU] | [EU AI Act, if a provider of a high-risk system] | [SERIOUS INCIDENT] | [MARKET SURVEILLANCE AUTHORITY] | [DEADLINE] | Legal |
| [INDIA] | [DPDPA] | [PERSONAL DATA BREACH] | [DATA PROTECTION BOARD OF INDIA] | [DEADLINE] | Privacy Lead |
| [OTHER] | [SECTOR REGULATOR] | | | | |

## 8. What to communicate

What happened and when it was detected; the system and feature involved; who is affected and how; what data is involved; what {{client_name}} has done; what the recipient should do (including rechecking outputs they relied on); when the next update will come; a contact. State known facts only. Do not speculate on cause or blame.

## 9. Information for authorities and interested parties (A.8.5)

Legal records, per jurisdiction, what {{client_name}} must be able to provide to authorities and other parties with a right to it. For each system, the AI System Owner keeps an information pack ready in [LOCATION]:

- technical documentation (the AI System Technical Documentation (Model Card));
- training, validation and test datasets, or descriptions of them where the data cannot be shared;
- reasons for the choice of algorithm or model;
- verification and validation records;
- risk assessment and treatment records;
- impact assessment results;
- event logs.

For each request: log it; Legal confirms the basis and scope; the AI System Owner assembles the material; Security and Privacy check for confidential or personal data and redact or secure the transfer; the Disclosure Approver signs off; the ticket records what was sent, to whom and when.

## 10. Approval before disclosure

No external statement about an AI incident is made without Disclosure Approver sign-off. Pre-approved holding statements (customer notice, individual notice, status page text, regulator cover letter) are kept in [LOCATION] and may be sent by the AI Incident Lead once the facts are filled in.

## 11. Exercises

The plan is exercised every [12 MONTHS] with at least one AI-specific scenario (for example, a supplier model update produces harmful outputs, or a bias report reaches the press). The record shows the scenario, attendees, gaps found and actions.

## 12. AI incident ticket template

| Field | Entry |
|---|---|
| Ticket ID / date and time detected | |
| Reported by / detection source | |
| AI system and model version | |
| Category / severity (initial and final) | |
| Description | |
| People or groups affected / personal data involved | |
| Evidence preserved (location) | |
| Containment actions and time taken | |
| Root cause | |
| Resolution details: what changed, how it was tested, who approved re-release, date | |
| Communications sent: audience, date, approver | |
| Authority notifications: authority, date, reference, or reason not required | |
| Impact assessment and risk register updates | |
| Corrective action reference / lessons learned | |
| Closed by and date | |

## 13. Records produced

AI incident tickets with resolution details, preserved evidence, communications and approvals, authority notifications, information packs sent, post-incident reviews and exercise records. Kept in [TICKETING SYSTEM / REPOSITORY] for [RETENTION PERIOD] and retrievable by ticket ID for internal and certification audit sampling.

## 14. Related documents

- AI Event Logging Standard
- AI Adverse Impact Reporting Procedure
- AI Concern Reporting Procedure
- AI System Lifecycle Procedure
- AI System Impact Assessment Procedure
- AI System Technical Documentation (Model Card)
- AIMS Communication Plan
- AI Supplier and Partner Management Procedure

## 15. Review and approval

This plan is reviewed every {{review_period}}, after each SEV1 or SEV2 incident and after each exercise. It is approved by {{approval_authority}}.
`,
  },

  {
    name: 'Responsible AI Use and Acquisition Policy',
    category: 'policy',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-9-2', 'ai-annex-a-9-3', 'ai-annex-a-9-4'],
    description: 'How the organisation decides whether to use an AI system, the objectives and mechanisms for responsible use, use only as intended, rules for general-purpose AI tools, and an AI use request form (Annex A.9.2 to A.9.4).',
    content: `# Responsible AI Use and Acquisition Policy

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This policy sets how {{client_name}} decides whether to use an AI system, the objectives that govern its use, and the rule that each system is used only as intended. It also sets the rules for staff use of general-purpose AI tools. It supports Annex A controls A.9.2, A.9.3 and A.9.4.

## 2. Scope

This policy applies to all AI systems {{client_name}} builds, buys, subscribes to or receives as a feature of existing software (for example an AI assistant switched on inside a SaaS product), to pilots and proofs of concept that use real data, and to all employees and contractors.

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Requester | Business owner proposing the use. Completes the AI use request. |
| AIMS Manager | Checks the request is complete, sets the initial impact rating, updates the AI system register |
| AI System Owner | Accountable for the system once approved, including its use objectives |
| Procurement | Applies approved sourcing requirements |
| Security, Privacy, Legal | Review the request within [10 BUSINESS DAYS] |
| [AI GOVERNANCE COMMITTEE] | Approves requests rated High |
| Users | Use the system only as intended, apply human oversight, report concerns |

## 4. Deciding whether to use an AI system (A.9.2)

No AI system is used with real data until it is approved. The request (section 9) covers:

- the business need and how it fits {{client_name}}'s objectives and the AI Policy;
- the intended use and the uses that are out of scope;
- whether AI is needed at all, or a simpler non-AI option would do;
- whether a third-party product fits the intended use, or an internal build is better (data control, explainability, cost, supplier dependence, time to deliver);
- total cost: licences, compute, monitoring, human review time, retraining, maintenance and exit;
- legal and regulatory obligations [e.g. EU AI Act risk category, sector rules, data protection law];
- the data involved and its classification;
- the initial impact rating, with a full impact assessment for Medium and High;
- supplier due diligence under the AI Supplier and Partner Management Procedure.

| Impact rating | Examples | Approver | Needed before approval |
|---|---|---|---|
| Low | Internal drafting help with no personal or confidential data | AIMS Manager | Request form, approved supplier |
| Medium | Customer-facing content, internal decision support | AI System Owner, AIMS Manager, Security, Privacy | Impact assessment, supplier due diligence |
| High | Decisions affecting people's access to jobs, credit, services, health or rights; automated decisions | [AI GOVERNANCE COMMITTEE] and {{approval_authority}} | Full impact assessment, legal review, human oversight design, test plan |

**Approved sourcing.** AI products are bought only from suppliers approved under the AI Supplier and Partner Management Procedure, on business or enterprise terms. Terms must exclude training on {{client_name}} data unless Legal and the AI System Owner approve it. Free or consumer tiers are not used for {{client_name}} data.

## 5. Responsible use objectives (A.9.3)

Each approved system has use objectives recorded in the AI system register. Starting set:

| Objective | Measure | Target | Owner |
|---|---|---|---|
| A person reviews high-impact outputs before they take effect | Share of such outputs reviewed | [100%] | AI System Owner |
| Output accuracy stays at the approved level | Accuracy on a sample of [N] outputs per [MONTH] | [VALUE] | AI System Owner |
| Overrides are recorded with a reason | Share of overrides with a reason | [95%] | Team lead |
| Concerns about outputs are handled on time | Share triaged within target | [VALUE] | AIMS Manager |
| Users are trained before access | Share of users trained | [100%] | Line manager |

Results are reported every [QUARTER] and at management review (Clause 9.3).

## 6. Mechanisms for responsible use

- **Human oversight at defined stages.** Oversight applies before deployment (approval), in operation (review of outputs under the system's operating instructions) and after change (re-approval). The operating instructions say which outputs are reviewed, by whom and how.
- **Authority to override.** Reviewers are named, trained roles. They may reject or change any output without asking permission. Overrides are logged with a reason. Performance targets must not push reviewers to accept outputs.
- **Monitoring accuracy.** The AI System Owner samples outputs at the frequency above and investigates drops or drift alerts.
- **Reporting.** Users report worrying outputs or changes in performance through [CHANNEL] or the AI Concern Reporting Procedure.
- **Automated decision-making.** A fully automated decision about a person is used only where it is approved at High level, the approver has considered whether automation is appropriate for the impact on that person, and the person can ask for human review. [Legal limits, e.g. GDPR rules on automated decisions, may apply. Confirm with counsel.]

## 7. Use only as intended (A.9.4)

- The intended use of each system is stated in the AI system register, the AI System Technical Documentation (Model Card) and the AI Transparency and User Information Notice.
- Staff use a system only for its intended use and follow the supplier's documentation, usage policies and operating limits.
- A new use, user group, data type or type of decision is a new request under section 4 and may need a new impact assessment.
- The AI System Owner reviews actual use every [QUARTER]. Use outside the intended purpose is handled as an AI incident.

## 8. Staff use of general-purpose AI tools

- Use only tools on the approved list at [LOCATION], signed in with a {{client_name}} account.
- Do not enter [CONFIDENTIAL / RESTRICTED] information, personal data about customers or staff, credentials or [SOURCE CODE] unless the tool is approved for that class of data.
- Check outputs before using them. You are responsible for work you submit.
- Label AI-generated content where [CUSTOMERS / EXTERNAL PARTIES] may rely on it.
- Do not use AI tools to make or record decisions about individuals (hiring, performance, discipline) unless that use is approved under section 4.
- AI browser extensions, plugins and AI features in existing tools need approval before they are switched on.
- Report accidental disclosure of data to an AI tool to [SECURITY CONTACT] straight away.

## 9. AI use request and approval form

| Field | Entry |
|---|---|
| Request ID / date | |
| Requester and business unit | |
| System name and supplier (or internal build) | |
| Business need and link to objectives | |
| Intended use / out-of-scope uses | |
| Build or buy decision and reason | |
| Users (number, roles, internal or external) | |
| Data involved and classification | |
| Personal data (Y/N, categories) | |
| Automated decisions about people (Y/N) | |
| Estimated cost (year one / ongoing, incl. monitoring and review time) | |
| Legal and regulatory obligations identified | |
| Initial impact rating / impact assessment ref | |
| Supplier due diligence ref | |
| Human oversight arrangements | |
| Proposed use objectives | |
| Security / Privacy / Legal review (name, date, outcome) | |
| Decision (approved / approved with conditions / rejected), conditions | |
| Approver(s) and date | |

## 10. Non-compliance

Use of an AI system without approval, or outside its intended use, is reported to the AIMS Manager and may lead to action under [DISCIPLINARY POLICY].

## 11. Records produced

Completed request forms with approvals, the AI system register, use objective results, override logs, use reviews and the approved tools list. Kept in [REPOSITORY] for [RETENTION PERIOD].

## 12. Related documents

- AI Policy
- AI System Impact Assessment Procedure
- AI System Lifecycle Procedure
- AI Supplier and Partner Management Procedure
- AI Transparency and User Information Notice
- AI Concern Reporting Procedure
- AIMS Roles, Responsibilities and Authorities

## 13. Review and approval

This policy is reviewed every {{review_period}} and when a new class of AI tool comes into common use. It is approved by {{approval_authority}}.
`,
  },

  {
    name: 'AI Supplier and Partner Management Procedure',
    category: 'procedure',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-10-2', 'ai-annex-a-10-3', 'ai-annex-a-10-4'],
    description: 'Identifying, vetting, contracting and reviewing suppliers and partners in the AI system lifecycle, monitoring supplier changes, and handling customer expectations, with a supplier register and attestation review checklist (Annex A.10.2 to A.10.4).',
    content: `# AI Supplier and Partner Management Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose

This procedure sets how {{client_name}} identifies, vets, contracts with and oversees suppliers and partners involved in its AI systems, and how it meets its customers' expectations. It supports Annex A controls A.10.2, A.10.3 and A.10.4. It adds AI-specific steps to [SUPPLIER SECURITY POLICY / VENDOR MANAGEMENT PROCEDURE].

## 2. Scope

| Supplier type | Examples | What to watch |
|---|---|---|
| Model or API provider | Foundation model API, hosted ML service | Unannounced model changes, use of {{client_name}} data |
| Data provider | Purchased datasets, data brokers | Rights to use, quality, provenance |
| Labelling | Annotation vendor, crowd workers | Label quality, access to data |
| Hosting and compute | Cloud platform, GPU provider | Security, data location |
| Integrator or developer | Firm building or configuring an AI system | Handover documentation, testing |
| AI features in SaaS | CRM or helpdesk with built-in AI | Features switched on by default |
| Partner or reseller | Partner deploying {{client_name}} AI to its customers | Responsibilities to end users |

## 3. Roles and responsibilities

| Role | Responsibility |
|---|---|
| AI System Owner | Sponsors the supplier, owns the relationship, monitors changes |
| Procurement | Runs intake, keeps the supplier register, enforces contract templates |
| Security Lead / [VENDOR RISK ANALYST] | Sends questionnaires, reviews attestation reports, rates risk |
| Privacy Lead | Reviews personal data handling and data processing terms |
| Legal | Negotiates contract clauses and records deviations |
| AIMS Manager | Checks the procedure is followed and reports to management review |

## 4. Identify and tier suppliers

Procurement asks at intake whether the supplier provides or touches any part of an AI system. AI suppliers are flagged in the supplier register (section 11) and tiered.

| Tier | Criteria | Due diligence | Formal review |
|---|---|---|---|
| 1 | Supplies the model, data or labelling for a system rated High impact, or processes personal data in an AI system | Full questionnaire, attestation review, full contract clauses | Every [12 MONTHS] |
| 2 | Supplies components for a Medium impact system | Short questionnaire, attestation review | Every [24 MONTHS] |
| 3 | Low impact; no personal or confidential data | Terms review | At renewal |

## 5. Due diligence before engagement

| Step | Who | Action | Record |
|---|---|---|---|
| 1 | Requester | Get in-principle approval under the Responsible AI Use and Acquisition Policy | AI use request |
| 2 | Procurement | Assign tier | Supplier register entry |
| 3 | Security Lead | Send [AI SUPPLIER QUESTIONNAIRE] | Completed questionnaire |
| 4 | Security Lead | Collect attestations: [SOC 2 TYPE II, ISO/IEC 27001, ISO/IEC 42001 CERTIFICATE, PENETRATION TEST SUMMARY]. Check scope covers the service and the period is current. | Attestation review checklist |
| 5 | Security, Privacy, Legal | Review answers and evidence, record findings and a risk rating | Due diligence summary |
| 6 | [APPROVER PER TIER] | Approve, approve with conditions, or reject | Signed decision |

AI-specific questions:

- What data trained the model, how was it sourced, and on what rights?
- Are {{client_name}}'s inputs or outputs used for training? Can this be switched off? How long are prompts and outputs kept?
- How are model changes versioned and announced? What notice is given? Can a version be pinned?
- What accuracy, bias and safety testing has been done? Is a model card or system card available?
- Which AI incidents are notified to customers, and how fast?
- Which subprocessors are used, and where is data processed?
- What oversight features exist (content filters, logging, human review hooks)?
- Does the supplier have its own AI policy or AI management system certification?
- Can the supplier provide logs and documentation {{client_name}} may need for regulators or customers?

## 6. Contract requirements

| Clause | Minimum content |
|---|---|
| Responsibilities | Allocation per the AI Lifecycle Responsibility Matrix (Third Parties), attached or referenced |
| Data use | No training on {{client_name}} data without written consent; retention limit [DAYS]; deletion on exit |
| Change notification | [30 DAYS] notice of material model changes, deprecations and changes to data use terms |
| Incident notification | Notice of AI incidents affecting {{client_name}} within [48 HOURS], with details and cooperation |
| Assurance and audit | Annual attestation report; right to send questionnaires; audit for cause |
| Cooperation | Support with impact assessments, regulator requests and customer enquiries |
| Subcontracting | Prior notice of new subprocessors; same obligations flowed down |
| Service levels | Availability and performance measures relevant to the AI service |
| Exit | Data return and deletion, transition support for [90 DAYS] |

Legal records any clause the supplier refuses, with the risk decision, in the due diligence summary.

## 7. Formal review of attestation reports

Filing a report is not a review. For Tier 1 and 2 suppliers the Security Lead reviews each new attestation report on receipt, and at least at the frequency in section 4, with the AI System Owner. The review checks the items in section 12. Findings and follow-up actions are tracked to closure. The review is recorded as a completed checklist or as minutes of a review meeting, signed and dated.

## 8. Monitoring supplier changes

- The AI System Owner subscribes to the supplier's release notes and status page.
- Model versions are pinned where the supplier allows.
- A model version change triggers the regression test set, comparison with approved thresholds and a model card update under the AI System Lifecycle Procedure.
- Legal reviews changes to terms of service and data use terms.
- Supplier incidents that affect {{client_name}} are logged under the AI Incident Response and Communication Plan.
- A change of ownership, a lapsed certification or a qualified audit opinion triggers an early review.

## 9. Customers and the domain of validity (A.10.4)

When {{client_name}} provides AI to customers:

- Customer expectations (contracts, RFPs, security questionnaires) are recorded and checked against what the system can do before {{client_name}} commits.
- Customers are told the domain in which the system is valid: population, languages, data types and conditions it was tested on. Outside that domain performance is unknown. This appears in customer documentation and the contract schedule.
- Customers receive what they need to meet their own duties to their users (user notice text, model card summary, logs).
- Sales and marketing claims about the AI are checked against test results by the AI System Owner.
- Customer feedback is handled under the AI Adverse Impact Reporting Procedure.

## 10. Exit

On exit, data is returned or deleted with written confirmation, access is revoked, and the AI system register and responsibility matrix are updated.

## 11. Supplier register

| Supplier | Service | Type | AI system(s) | Tier | Personal data (Y/N) | Attestations held and period | Contract ref | Last formal review | Next review | Owner |
|---|---|---|---|---|---|---|---|---|---|---|
| [SUPPLIER] | | | | | | | | | | |

## 12. Attestation report review checklist

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Report type and period; is it current (gap under [3 MONTHS] or bridge letter held)? | | |
| 2 | Scope covers the services and locations {{client_name}} uses | | |
| 3 | Auditor opinion unqualified? If qualified, why | | |
| 4 | Exceptions noted and the supplier's response | | |
| 5 | Complementary user entity controls mapped to {{client_name}} controls | | |
| 6 | Subservice organisations and whether they are carved out | | |
| 7 | AI services and model operations covered, or excluded | | |
| 8 | Changes since the last review | | |
| 9 | Follow-up actions, owners and due dates | | |
| 10 | Conclusion: [ACCEPTABLE / ACCEPTABLE WITH ACTIONS / ESCALATE] | | |

Reviewed by [NAME] on [DATE]. Agreed by AI System Owner [NAME] on [DATE].

## 13. Records produced

Supplier register, completed questionnaires, due diligence summaries, signed contracts, attestation reports with review checklists or minutes, change monitoring notes and exit confirmations. Kept in [REPOSITORY] for [RETENTION PERIOD].

## 14. Related documents

- AI Lifecycle Responsibility Matrix (Third Parties)
- Responsible AI Use and Acquisition Policy
- AI Data Management Policy
- AI System Lifecycle Procedure
- AI Incident Response and Communication Plan
- AI System Technical Documentation (Model Card)

## 15. Review and approval

This procedure is reviewed every {{review_period}} and is approved by {{approval_authority}}.
`,
  },

  {
    name: 'AI Lifecycle Responsibility Matrix (Third Parties)',
    category: 'record',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-10-2', 'ai-annex-a-10-4'],
    description: 'Per-system matrix allocating AI lifecycle responsibilities among the organisation, suppliers, partners and customers, with contract references and sign-off (Annex A.10.2 and A.10.4).',
    content: `# AI Lifecycle Responsibility Matrix (Third Parties)

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose and how to use

This record allocates responsibility for each stage of an AI system's lifecycle among {{client_name}} and the third parties involved. It supports Annex A controls A.10.2 and A.10.4. Complete one matrix per AI system that involves a supplier, partner or customer.

- R: does the work. A: accountable, one per row. C: consulted. I: informed.
- The allocation must match {{client_name}}'s role for this system (provider, developer, deployer or customer) as recorded in the AIMS Scope Statement.
- Each R or A held by a third party is backed by a contract clause. Put the reference in the last column.
- The example entries in brackets assume {{client_name}} deploys a third-party model. Replace them.
- Update the matrix when a party, contract or lifecycle stage changes.

## 2. System details

| Field | Entry |
|---|---|
| AI system and inventory ID | [NAME, ID] |
| {{client_name}}'s role | [PROVIDER / DEVELOPER / DEPLOYER / CUSTOMER] |
| AI System Owner | [NAME] |
| Impact rating | [LOW / MEDIUM / HIGH] |
| Matrix version and date | [v1.0, DATE] |

## 3. Parties

| Code | Party | Type | Role in the lifecycle | Contract reference |
|---|---|---|---|---|
| ORG | {{client_name}} | Organisation | [DEPLOYER] | Not applicable |
| SUP1 | [MODEL PROVIDER] | Supplier | [PROVIDER OF BASE MODEL] | [REF] |
| SUP2 | [DATA OR LABELLING PROVIDER] | Supplier | | [REF] |
| PTR | [INTEGRATOR / PARTNER] | Partner | | [REF] |
| CUS | [CUSTOMER] | Customer | | [REF] |
| OTH | [HOSTING / OTHER] | Supplier | | [REF] |

## 4. Responsibility matrix

| Lifecycle activity | ORG | SUP1 | SUP2 | PTR | CUS | OTH | Contract clause / notes |
|---|---|---|---|---|---|---|---|
| Define intended use and requirements | [A/R] | [I] | | [C] | [C] | | |
| Data sourcing and rights to use | [A] | [R: BASE MODEL DATA] | [R] | | [C] | | |
| Data labelling | [A] | | [R] | | | | |
| Data quality checks | [A/R] | | [R] | | | | |
| Model development or selection | [A] | [R] | | [R] | | | |
| Fine-tuning or configuration | [A/R] | [C] | | [R] | | | |
| Verification and validation | [A/R] | [C] | | [R] | [C] | | |
| AI system impact assessment | [A/R] | [C] | | | [C] | | |
| Deployment | [A/R] | | | [R] | [I] | [R] | |
| Human oversight in operation | [A/R] | | | | [R] | | |
| Performance and drift monitoring | [A/R] | [R: BASE MODEL] | | | [I] | | |
| Event logging and log retention | [A/R] | [R] | | | | [R] | |
| Incident detection and response | [A/R] | [R] | | [R] | [C] | [R] | |
| Incident notification to customers and users | [A/R] | [C] | | | [R: OWN USERS] | | |
| Retraining and model updates | [A] | [R] | | [R] | [I] | | |
| Change notification | [A] | [R] | [R] | [R] | [I] | [R] | |
| User communication and transparency notice | [A/R] | [C] | | | [R: OWN USERS] | | |
| Handling adverse impact reports | [A/R] | [C] | | | [R: FORWARD] | | |
| Regulatory reporting and cooperation | [A/R] | [C] | | | [C] | | |
| Security of hosting and infrastructure | [A] | [R] | | | | [R] | |
| Decommissioning, data return and deletion | [A/R] | [R] | [R] | [R] | [I] | [R] | |

## 5. Rules for completing

- Every row has exactly one A.
- Every row has at least one R. A row with no R is a gap.
- An R or A held by a third party without a contract clause is a gap.

## 6. Gaps and actions

| # | Activity | Gap | Action (e.g. contract amendment) | Owner | Due | Closed |
|---|---|---|---|---|---|---|
| 1 | | | | | | |

## 7. Sign-off

| Party | Name and role | Confirmation | Date |
|---|---|---|---|
| {{client_name}} (AI System Owner) | | Approved | |
| {{client_name}} (Legal) | | Contract references checked | |
| [THIRD PARTY] | | [ACKNOWLEDGED / REFERENCED IN CONTRACT] | |

## 8. Related documents

- AI Supplier and Partner Management Procedure
- AIMS Roles, Responsibilities and Authorities
- AI System Lifecycle Procedure
- AI Incident Response and Communication Plan

## 9. Review and approval

The AI System Owner reviews this matrix every {{review_period}}, at contract renewal and when a party changes. {{approval_authority}} approves the template.
`,
  },
];
