'use strict';
// ISO/IEC 42001:2023 template pack: AI system resources and life cycle (resource records, lifecycle gates, requirements, V&V, release, monitoring, model card, event logs).
const { STARTER_NOTE, CONTROL_BLOCK } = require('./policy-templates-iso42001-common');

module.exports = [
  {
    name: 'AI System Resource Documentation Standard',
    category: 'procedure',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-4-2', 'ai-annex-a-4-3', 'ai-annex-a-4-4', 'ai-annex-a-4-5', 'ai-annex-a-4-6'],
    description: 'Sets what must be recorded for each AI system about its components, data, tooling, computing infrastructure and people, with a per-system resource record and update triggers (Annex A.4.2, A.4.3, A.4.4, A.4.5 and A.4.6).',
    content: `# AI System Resource Documentation Standard

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose
This standard sets out what {{client_name}} records about the resources each AI system depends on: its components, data, tooling, computing infrastructure and people. The record makes those dependencies visible, so that risk assessment, impact assessment, change control and incident response work from what the system actually uses rather than from memory (Annex A.4.2 to A.4.6).

## 2. Scope
Every AI system listed in the AIMS Scope Statement that {{client_name}} develops, provides or operates, including AI features inside a larger product. For AI systems {{client_name}} configures or integrates from a supplier (for example a hosted foundation model called through an API), record the resources {{client_name}} controls and what the supplier discloses. Where the supplier does not disclose something, say so in the field instead of leaving it blank.

Each system has one resource record, identified by its AI system register ID and kept in [MODEL REGISTRY / AI SYSTEM REGISTER / REPOSITORY PATH]. Where a tool already holds a field (the model registry holds model versions, the cloud console holds instance types), the record links to that tool instead of copying the value.

## 3. Roles and responsibilities
| Role | Responsibility |
|---|---|
| AI system owner | Accountable for the record being complete and current; confirms it at each release gate |
| Technical or ML lead | Completes the components, tooling, computing and architecture sections |
| Data owner | Completes the data section and links each dataset to its AI Data Quality and Provenance Record |
| {{document_owner}} | Maintains this standard; checks a sample of records every [QUARTER] against the running systems |
| Internal auditor | Compares records with live configuration during the internal audit programme |

## 4. What must be documented

### 4.1 System components (A.4.2)
- The parts that make up the system: models, prompts and prompt templates, retrieval indexes, feature pipelines, pre- and post-processing code, business rules, user interface and integrations.
- Which components {{client_name}} builds and which come from suppliers, with the supplier name and the contract or terms of service reference.
- {{client_name}}'s role for the system (AI provider, producer, customer or partner) at each lifecycle stage. The role decides which resources {{client_name}} can document first-hand and which it has to obtain from others.

### 4.2 Data resources (A.4.3)
For each dataset used for training, fine-tuning, validation, testing, retrieval or production inference, record:
- **Provenance:** where it came from (internal system, customer, third party, open source, scraped, synthetic) and the licence or legal basis for using it.
- **Date and version:** when it was collected or last refreshed, and the version used for each model version.
- **Categories of data:** whether it holds personal or special category data, and which populations it represents.
- **Labelling:** who labelled it (internal team, vendor, crowd workers, automated), the labelling instructions and how label quality was checked.
- **Intended use:** the lifecycle stage and system it is approved for. Approval for one purpose does not carry over to another.
- **Quality:** known gaps, imbalances, noise and biases, and the result of the latest quality check.

The detail belongs in the AI Data Quality and Provenance Record. The resource record lists each dataset and links to it.

### 4.3 Tooling resources (A.4.4)
- Algorithms and model types (for example gradient-boosted trees, convolutional network, fine-tuned transformer, hosted LLM) with the exact model version or API snapshot, not only the product name.
- Data conditioning tools for cleaning, labelling, augmentation and feature engineering, with versions.
- Optimisation and evaluation methods: hyperparameter search approach, loss function, evaluation metrics and the evaluation harness.
- Provisioning and development software: frameworks and libraries with pinned versions (link the lock file or environment export), experiment tracking [EXAMPLE: MLFLOW, WEIGHTS AND BIASES] and notebooks.
- Deployment software: model serving, container images, orchestration, feature store and CI/CD pipeline.
- **Differences between development and production:** hardware (CPU, GPU, accelerator type), numerical precision (for example float32 in training, float16 or int8 quantised in production), library builds and operating system. Record whether outputs were compared for equivalence after the change and the tolerance accepted ([EQUIVALENCE TOLERANCE]).
- Licence obligations for each commercial or open-source component and pretrained model.

### 4.4 System and computing resources (A.4.5)
- **Location:** cloud (provider and region), on-premises, or edge device, recorded separately for training and for inference.
- **Processing:** instance types, accelerator count and expected utilisation.
- **Network:** external API dependencies, bandwidth and latency needs, connectivity assumptions for edge deployments.
- **Storage:** where training data, model artefacts and logs are held, and their approximate size.
- **Constrained devices:** memory, power, compute and update limits where the model runs on a device, and how updates reach it.
- **Capacity and reliability constraints:** throughput limits, supplier rate limits and single-provider dependencies.
- **Environmental impact:** an estimate of energy use (and carbon, where available) for training runs and steady-state inference, with the method used (provider carbon reporting [TOOL] or a calculation from accelerator hours). For small models a one-line note that the footprint is negligible, and why, is enough.

### 4.5 Human resources (A.4.6)
- The roles involved at each lifecycle stage and the expertise each needs: data scientists and ML engineers, data engineers, labellers, domain experts, human oversight reviewers, security and privacy reviewers, researchers and operations staff.
- The names or teams filling each role, and the backup for any role held by one person.
- External people: labelling vendors, contractors and supplier support teams, with the country where the work is done.
- A link to the competence records kept under the AIMS competence process (clause 7.2).

Where {{client_name}} only integrates a supplier's system, record the internal roles that configure, oversee and support it.

### 4.6 Data flow and architecture
Each record includes or links to a current diagram showing data sources, pipelines, training and serving environments, external services, the points where people review or override outputs, and trust boundaries. The diagram carries a version and date: [DIAGRAM LINK].

## 5. Resource record

| Field | Entry |
|---|---|
| AI system register ID | [AI-XXX] |
| System name and version | |
| {{client_name}} role(s) | [PROVIDER / PRODUCER / CUSTOMER / PARTNER] |
| Components (built / supplied) | |
| Datasets (links to provenance records) | |
| Model type and version or API snapshot | |
| Frameworks and libraries (link to lock file) | |
| Experiment tracking and model registry location | |
| Training environment (location, hardware, precision) | |
| Production environment (location, hardware, precision) | |
| Development/production differences and equivalence result | |
| Network and external dependencies | |
| Storage locations (data, artefacts, logs) | |
| Environmental impact estimate and method | |
| People and roles (internal and external) | |
| Architecture diagram link and version | |
| Record owner | |
| Last updated and reason | |

## 6. When the record is updated
- In draft before the design gate for a new system; complete before release.
- On any change to a resource: new or refreshed dataset, retraining, model or API version change, a major library version, an infrastructure move, a new supplier or labelling vendor, or a change of key personnel.
- At retirement, noting where artefacts and data went.
- At least every [12 MONTHS], as a confirmation that the record still matches the running system.

The change ticket for a system change references the updated record version.

## 7. Records produced
Versioned resource records per AI system, linked from the AI system register; architecture diagrams; review confirmations. Kept for the life of the system plus [RETENTION PERIOD]. The auditor picks systems from the register and compares the record with the live configuration, so a record that lags the system is the usual finding.

## 8. Related documents
- AI Policy
- AI Data Management Policy
- AI Data Quality and Provenance Record
- AI Risk Assessment Methodology
- AI System Impact Assessment Procedure
- AI System Lifecycle Procedure
- AI System Requirements and Design Record
- AI System Technical Documentation (Model Card)

## 9. Review and approval
Reviewed every {{review_period}} and after any change to how {{client_name}} builds or sources AI systems. Approved by {{approval_authority}}.

| Version | Date | Author | Change | Approved by |
|---|---|---|---|---|
| [1.0] | {{date}} | {{document_owner}} | Initial issue | {{approval_authority}} |
`,
  },
  {
    name: 'AI System Lifecycle Procedure',
    category: 'procedure',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-6-1-2', 'ai-annex-a-6-1-3', 'ai-annex-a-6-2-2'],
    description: 'The stages an AI system passes through from inception to retirement, the gate and approver at each stage, how responsible development objectives become requirements and tests, and change control for new versions, retraining and prompt or configuration changes (Annex A.6.1.2, A.6.1.3 and A.6.2.2).',
    content: `# AI System Lifecycle Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose
This procedure describes how {{client_name}} takes an AI system from idea to retirement: the stages, the gate at the end of each, who approves it and what record each gate leaves behind. It covers how responsible development objectives are built into the work (Annex A.6.1.2), the development process itself (A.6.1.3) and how requirements are recorded for new systems and for changes (A.6.2.2).

## 2. Scope
All AI systems in the AIMS Scope Statement that {{client_name}} develops or provides, and all changes to them. For AI systems {{client_name}} configures or integrates from a supplier, the inception, verification and validation, deployment, operation, re-evaluation and retirement stages apply in full; the design and development stage applies to the parts {{client_name}} builds (prompts, retrieval, fine-tuning, integration code, business rules). Delivery teams follow this procedure inside their normal tooling ([TICKETING TOOL], [CI/CD PIPELINE], [MODEL REGISTRY]); it does not add a separate workflow.

## 3. Roles and responsibilities
| Role | Responsibility |
|---|---|
| AI system owner | Owns the business case and success metrics; requests each gate review |
| ML or technical lead | Runs design, development and verification; prepares gate evidence |
| Data owner | Approves data sources and each use of data |
| Human oversight lead | Defines oversight for the system and staffs it before release |
| Security and privacy reviewers | Threat model and privacy review at design; confirm at release |
| AI governance lead ({{document_owner}}) | Assigns the risk tier, runs gate reviews, keeps gate records |
| [AI GOVERNANCE COMMITTEE] | Approves gates for high-tier systems |

## 4. Risk tier
The AI governance lead assigns a tier at inception using the AI Risk Assessment Methodology and the impact screening. The tier sets who approves each gate.

| Tier | Typical example | Gate approver |
|---|---|---|
| Low | Internal productivity aid, no decisions about people | Technical lead and system owner |
| Medium | Customer-facing output, a person makes the final decision | System owner and AI governance lead |
| High | Affects individuals' access to services, employment, credit, health or safety; acts without routine human review | [AI GOVERNANCE COMMITTEE] |

## 5. Stages and gates

| Stage | Entry criteria | Records required to pass the gate | Approver |
|---|---|---|---|
| 1. Inception (G0) | Problem or customer request logged | Requirements and Design Record Part A (rationale, driver, success metrics); impact screening; risk tier; AI system register entry | Per tier |
| 2. Design and development (G1 design, G2 build) | G0 passed | Requirements and Design Record complete; resource record draft; data provenance records; threat model; experiment tracking run IDs for the candidate model | Per tier |
| 3. Verification and validation (G3) | Candidate model and code versioned in [MODEL REGISTRY] | AI Verification and Validation Plan and Report with results and decision | Per tier; independent reviewer for high tier |
| 4. Deployment (G4) | G3 passed | AI System Deployment and Release Checklist; transparency information updated; impact assessment current | Per tier |
| 5. Operation and monitoring | G4 passed | Monitoring alerts and reviews, log reviews, incident records | System owner |
| 6. Re-evaluation | Trigger: drift, incident, scheduled review [EVERY 12 MONTHS], new regulation, new use | Re-evaluation note, updated impact assessment, decision: continue, retrain, restrict or retire | Per tier |
| 7. Retirement (G6) | Retirement decision | Retirement plan, user communication, disposal or archiving of model and data, register updated | System owner and AI governance lead |

A gate is passed when the approver records the decision in [GATE RECORD LOCATION]. A gate may be passed with conditions; conditions are tracked as tickets with owners and dates.

## 6. Responsible development objectives in each stage (A.6.1.2)
The AI Policy and the AI Objectives and Measurement Plan set {{client_name}}'s objectives for AI systems, for example [FAIRNESS, TRANSPARENCY, SAFETY, SECURITY, PRIVACY, RELIABILITY, ACCOUNTABILITY, ENVIRONMENTAL IMPACT]. At G0 the team picks the objectives that apply to the system and at G1 turns each into at least one measurable requirement.
- **Requirements:** each applicable objective appears in the Requirements and Design Record with an acceptance criterion.
- **Data acquisition:** sources are checked against the approved data supplier list; licence and consent are confirmed; the team considers whether the data represents the people the system will be used on.
- **Data conditioning:** cleaning, labelling, balancing and de-identification steps are recorded. Steps that could shift outcomes for a group (for example dropping records with missing fields that are more common in one group) are reviewed by the data owner.
- **Training:** experiments are tracked with data version, code commit, hyperparameters and random seeds so a result can be reproduced. Model selection considers the objectives, not only headline accuracy.
- **Verification:** each objective has at least one test with a pass criterion in the V&V plan.

A shortfall against an objective is either fixed or accepted by the gate approver with a written reason and an entry in the AI risk register.

## 7. Development process requirements (A.6.1.3)

### 7.1 Testing
- Test data is held out, versioned and never used for training or tuning.
- Tests cover performance under each operational factor, fairness across [RELEVANT GROUPS], robustness to noisy or shifted inputs, AI-specific security (adversarial inputs, data poisoning checks, and prompt injection and jailbreak tests for LLM-based systems) and behaviour on failure.
- An automated regression suite runs in [CI PIPELINE] on every model, prompt or configuration change.

### 7.2 Human oversight
- Where outputs affect people, the design names the point where a person reviews, what they see, their authority to override and how overrides are recorded.
- The automation level is recorded in the AI system register (suggests only, acts after approval, acts under monitoring, acts without routine review). Moving to a more automated level is a significant change.
- Oversight reviewers are trained on the system before G4.

### 7.3 Impact assessments
Run under the AI System Impact Assessment Procedure: screening at G0; full assessment before G1 for medium and high tiers; refreshed before G4 if the design changed; at every re-evaluation; and for every significant change.

### 7.4 Training data
- Data comes only from internal sources approved by the data owner or from suppliers on [APPROVED DATA SUPPLIER LIST]. A new supplier is assessed under the AI Data Management Policy before its data is used.
- Production customer data is not used for training unless [CONTRACT PERMISSION / LEGAL BASIS] is confirmed and recorded.
- The dataset version used is frozen and referenced from the model version.

### 7.5 Developer expertise and training
- People who build or validate in-scope systems hold the competences listed in the resource record.
- They complete training on this procedure, responsible AI and AI-specific security threats before working on in-scope systems, refreshed every [12 MONTHS].
- For high-tier systems, verification is reviewed by someone who did not build the model.

### 7.6 Release criteria
A system or change is released only when G3 tests pass (or deviations are accepted in the V&V report), the impact assessment is current, transparency information is updated, monitoring and logging are live in production, rollback has been tested and oversight is staffed. The AI System Deployment and Release Checklist records each item.

## 8. Change control for AI systems

| Class | Examples | Path |
|---|---|---|
| Minor | Scheduled retraining on the same pipeline with data inside [DRIFT BOUNDS]; prompt wording fix; dependency patch | Change ticket, automated regression and V&V, technical lead approval |
| Significant | New model architecture or foundation model, new API snapshot, new data source, new intended use or user group, change of automation level, threshold change affecting decisions about people | Requirements and Design Record update, impact assessment review, gates G1 to G4 |
| Emergency | Rollback, switching a feature off after an incident | Act first; retrospective ticket within [2 BUSINESS DAYS] |

Before a significant change, the system owner checks contracts, service levels, published documentation and the AI Transparency and User Information Notice for commitments customers rely on. Where behaviour customers depend on will change, they are told [NOTICE PERIOD] in advance or as the agreement requires.

Every change ticket carries the register ID, change class, reason, links to the updated records and V&V results, the approver and the deployment date. The auditor samples change tickets from the audit period.

## 9. Engaging interested parties
At inception and for significant changes, the system owner identifies who uses the system and who is affected by its outputs, consults [CUSTOMERS / USER REPRESENTATIVES / DOMAIN EXPERTS] where the system affects them, and records their input and the response in the Requirements and Design Record.

## 10. Requirements documentation (A.6.2.2)
Every new system and every significant change has an AI System Requirements and Design Record, started at G0. It states why the system is being built or changed, what drives it (business case, customer request, legal requirement or internal policy), the success metrics and how they will be measured, and the functional, non-functional and responsible-AI requirements. For minor changes the change ticket records the reason and the expected effect.

## 11. Records produced
Gate decisions, Requirements and Design Records, V&V reports, deployment checklists, change tickets and retirement records, kept in [LOCATION] for the life of the system plus [RETENTION PERIOD]. For Stage 2 the auditor typically samples newly implemented systems and changes from the period and traces each from requirement to release.

## 12. Related documents
- AI Policy
- AI Objectives and Measurement Plan
- AI Risk Assessment Methodology
- AI System Impact Assessment Procedure
- AI Data Management Policy
- AI Transparency and User Information Notice
- AI System Resource Documentation Standard
- AI System Requirements and Design Record
- AI Verification and Validation Plan and Report
- AI System Deployment and Release Checklist
- AI System Operation and Monitoring Procedure

## 13. Review and approval
Reviewed every {{review_period}}, after an audit finding on the lifecycle, or when delivery tooling changes. Approved by {{approval_authority}}.

| Version | Date | Author | Change | Approved by |
|---|---|---|---|---|
| [1.0] | {{date}} | {{document_owner}} | Initial issue | {{approval_authority}} |
`,
  },
  {
    name: 'AI System Requirements and Design Record',
    category: 'form',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-6-2-2', 'ai-annex-a-6-2-3'],
    description: 'Fill-in record for each new AI system or significant change: rationale and success metrics, requirements with acceptance criteria, design choices with reasons, security threats considered, final architecture, iteration log and sign-off (Annex A.6.2.2 and A.6.2.3).',
    content: `# AI System Requirements and Design Record

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose and use
One record per new AI system and per significant change, started at inception (G0) and completed at the design gate (G1) under the AI System Lifecycle Procedure. It records why the system exists, what it must do and the design decisions taken, with the reasons (Annex A.6.2.2 and A.6.2.3). The auditor samples these records for newly implemented systems and for changes, so each one must stand on its own. Keep it with the system in [REPOSITORY / DOCUMENT LIBRARY], versioned.

## 2. Identification
| Field | Entry |
|---|---|
| AI system register ID | [AI-XXX] |
| System name | |
| New system or change | [NEW / SIGNIFICANT CHANGE TO VERSION X] |
| Change ticket | [TICKET REF] |
| System owner | |
| Technical lead | |
| Risk tier | [LOW / MEDIUM / HIGH] |
| {{client_name}} role | [PROVIDER / PRODUCER / CUSTOMER / PARTNER] |

## 3. Part A: Rationale and goals
**Why is this system being built or changed?** [DESCRIBE THE PROBLEM AND WHO HAS IT]

**What drives it?** [BUSINESS CASE / CUSTOMER REQUEST (REF) / LEGAL OR REGULATORY REQUIREMENT / INTERNAL POLICY]

**What happens today without it?** [CURRENT PROCESS]

**Who uses it and who is affected by its outputs?** [USERS; AFFECTED PEOPLE]

| Success metric | Baseline | Target | How and when measured |
|---|---|---|---|
| [E.G. MANUAL REVIEW TIME PER CASE] | [20 MIN] | [8 MIN] | [TIME TRACKING, 60 DAYS AFTER RELEASE] |
| | | | |

**Interested party input:** [WHO WAS CONSULTED, WHAT THEY SAID, WHAT CHANGED AS A RESULT]

## 4. Part B: Requirements
Every requirement has an acceptance criterion and a test reference in the AI Verification and Validation Plan and Report. Responsible-AI requirements come from the objectives selected under the AI System Lifecycle Procedure.

| ID | Category | Requirement | Acceptance criterion | Source | Test ref |
|---|---|---|---|---|---|
| R1 | Functional | [WHAT THE SYSTEM DOES] | | | |
| R2 | Performance | [E.G. RECALL ON CLASS X] | [>= VALUE ON TEST SET VERSION] | | |
| R3 | Fairness | [E.G. ERROR RATE GAP ACROSS GROUPS] | [GAP <= VALUE] | [OBJECTIVE REF] | |
| R4 | Explainability | [E.G. REVIEWER SEES TOP FACTORS FOR EACH OUTPUT] | | | |
| R5 | Safety | [E.G. REFUSES OUT-OF-SCOPE REQUESTS] | | | |
| R6 | Security | [E.G. RESISTS PROMPT INJECTION IN RETRIEVED CONTENT] | [PASS RATE ON ATTACK SUITE] | | |
| R7 | Privacy | [E.G. NO PERSONAL DATA IN OUTPUTS BEYOND THE REQUESTER'S OWN] | | | |
| R8 | Operational | [LATENCY, THROUGHPUT, AVAILABILITY] | | | |
| R9 | Human oversight | [WHO REVIEWS, WHEN, AUTHORITY TO OVERRIDE] | | | |

## 5. Part C: Design choices
Record the decision and why it was taken. Where there was a trade-off (accuracy against explainability, accuracy against fairness, latency against cost), say which way it went and who agreed.

| Topic | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| Machine learning approach | [SUPERVISED / UNSUPERVISED / REINFORCEMENT / RULES PLUS MODEL / HOSTED LLM WITH RETRIEVAL] | | |
| Algorithm and model type | [E.G. GRADIENT-BOOSTED TREES, FINE-TUNED TRANSFORMER, FOUNDATION MODEL AND SNAPSHOT] | | |
| Training approach | [FROM SCRATCH / FINE-TUNING / PROMPTING ONLY; SCHEDULE FOR RETRAINING] | | |
| Data quality needs | [VOLUME, LABEL QUALITY, REPRESENTATIVENESS, FRESHNESS] | | |
| Evaluation and refinement | [METRICS, VALIDATION SPLIT, ITERATION STOPPING RULE] | | |
| Hardware and software components | [TRAINING AND SERVING ENVIRONMENT, KEY LIBRARIES] | | |
| Output presentation | [SCORE / LABEL / TEXT; CONFIDENCE SHOWN OR NOT; WORDING] | | |
| Human interaction | [WHERE A PERSON REVIEWS, OVERRIDES OR APPEALS] | | |
| Interoperability and portability | [INTERFACES, MODEL FORMAT, DEPENDENCY ON ONE PROVIDER, EXIT OPTION] | | |

## 6. Security threats considered
| Threat | Applies? | Mitigation | Test ref |
|---|---|---|---|
| Data poisoning (tampered training, fine-tuning or retrieval data) | | [SOURCE CONTROLS, DATA VALIDATION, ANOMALY CHECKS] | |
| Model inversion and membership inference | | [OUTPUT LIMITS, CONFIDENCE ROUNDING, PRIVACY TESTING] | |
| Model stealing or extraction through the API | | [RATE LIMITS, AUTHENTICATION, QUERY PATTERN ALERTS] | |
| Adversarial or evasion inputs | | [INPUT VALIDATION, ADVERSARIAL TESTING] | |
| Prompt injection and jailbreaks (LLM-based systems) | | [INPUT AND OUTPUT FILTERING, TOOL PERMISSIONS, ISOLATION OF RETRIEVED CONTENT] | |
| Compromised pretrained model or library (supply chain) | | [TRUSTED SOURCES, HASH CHECKS, DEPENDENCY SCANNING] | |
| Leakage of sensitive data in outputs | | [OUTPUT SCANNING, TRAINING DATA MINIMISATION] | |

## 7. Part D: Final architecture
**Summary:** [TWO OR THREE PARAGRAPHS: DATA IN, PROCESSING, MODEL, OUTPUT, WHO SEES IT, WHERE IT RUNS]

**Diagram:** [INSERT OR LINK ARCHITECTURE DIAGRAM, VERSION AND DATE]

**Links:** resource record [LINK]; data provenance records [LINK]; experiment tracking run for the selected model [RUN ID]; model registry entry [LINK].

## 8. Iteration log
Record material changes to requirements or design after G1, so the auditor can see how the system arrived at its final form.

| Date | Change to requirement or design | Reason | Agreed by |
|---|---|---|---|
| | | | |
| | | | |

## 9. Sign-off
| Role | Name | Decision | Date |
|---|---|---|---|
| System owner | | [APPROVED / APPROVED WITH CONDITIONS] | |
| Technical lead | | | |
| Data owner | | | |
| Security reviewer | | | |
| Privacy reviewer | | | |
| Gate approver (per tier) | | | |

Conditions: [LIST, WITH TICKET REFS]

## 10. Records produced
This record, its revision history and the linked artefacts, kept for the life of the system plus [RETENTION PERIOD].

## 11. Related documents
- AI System Lifecycle Procedure
- AI System Resource Documentation Standard
- AI Verification and Validation Plan and Report
- AI System Impact Assessment Procedure
- AI Data Quality and Provenance Record
- AI Objectives and Measurement Plan

## 12. Review and approval
The template is reviewed every {{review_period}} by {{document_owner}} and approved by {{approval_authority}}. Each completed record is approved through the sign-off in section 9.
`,
  },
  {
    name: 'AI Verification and Validation Plan and Report',
    category: 'form',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-6-2-4'],
    description: 'Plan and report for testing an AI system or change before release: methods and tools, test data and its representativeness, targets and acceptable error rates per operational factor, impact on individuals and society, planned tests, results, deviations and the release decision (Annex A.6.2.4).',
    content: `# AI Verification and Validation Plan and Report

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose and use
Verification checks that the system meets its recorded requirements; validation checks that it does the job it was built for in the setting where it will be used (Annex A.6.2.4). Complete Part 1 (plan) before testing starts and Part 2 (report) before the G3 gate under the AI System Lifecycle Procedure. Complete a new version for every significant change and for every retraining that is not covered by the automated regression suite.

## 2. Identification
| Field | Entry |
|---|---|
| AI system register ID and name | |
| Model or system version under test | [MODEL REGISTRY REF / COMMIT] |
| Requirements and Design Record version | |
| Risk tier | |
| Test lead | |
| Independent reviewer (high tier) | |

**Part 1: Plan (sections 3 to 8).** Complete before testing starts.

## 3. Methods and tools
[DESCRIBE: OFFLINE EVALUATION ON HELD-OUT DATA, SLICE ANALYSIS BY GROUP AND OPERATIONAL FACTOR, STRESS AND PERTURBATION TESTS, ADVERSARIAL TESTING, RED-TEAMING FOR LLM-BASED SYSTEMS, SHADOW RUN ON LIVE TRAFFIC, USER ACCEPTANCE TESTING]

Tools: [EVALUATION HARNESS], [FAIRNESS TOOLKIT], [ADVERSARIAL OR PROMPT ATTACK SUITE], [EXPERIMENT TRACKING].

## 4. Test data
| Dataset | Version | Source | Size | Why it represents the intended use |
|---|---|---|---|---|
| [HELD-OUT TEST SET] | | | | [TIME PERIOD, REGIONS, USER GROUPS, INPUT TYPES COVERED] |
| [EDGE CASE SET] | | | | |
| [ATTACK OR RED-TEAM SET] | | | | |

State gaps honestly: groups, languages, devices or conditions the test data does not cover, and how that limits the conclusions. Test data must not overlap with training or tuning data; state how that was checked.

## 5. Operational factors, targets and acceptable error rates
Operational factors are conditions in the intended domain of use that change how well the system performs. Set the target and the worst acceptable result for each.

| Operational factor | Range in intended use | Metric | Target | Acceptable error rate | If performance degrades |
|---|---|---|---|---|---|
| [E.G. IMAGE RESOLUTION] | [640px to 4K] | [ACCURACY] | [VALUE] | [ACCEPTABLE ERROR RATE] | [REJECT INPUT BELOW X AND ROUTE TO A PERSON] |
| [E.G. BACKGROUND NOISE] | | [WORD ERROR RATE] | | | |
| [E.G. INPUT LANGUAGE] | [EN, ES, HI] | | | | [UNSUPPORTED LANGUAGES DECLINED] |
| [E.G. DATA FRESHNESS] | | | | | |

Where a factor pushes performance below the acceptable rate, the plan states what the system does instead: decline the input, warn the user, lower automation and send to human review, or restrict the use in the AI System Technical Documentation (Model Card).

## 6. Impact on individuals and society
Evaluate the components and the whole system for effects on people, drawing on the impact assessment:
- Performance and error rates across [RELEVANT GROUPS], including groups the training data under-represents.
- The consequence of each error type for the person affected (a false rejection may matter more than a false approval, or the reverse).
- Behaviour when combined with human review: whether reviewers can spot and correct errors in practice.
- Wider effects recorded in the impact assessment, and whether testing confirmed or changed them.

## 7. Release criteria
[E.G. ALL REQUIREMENTS IN THE REQUIREMENTS AND DESIGN RECORD MET; NO GROUP BELOW THE ACCEPTABLE ERROR RATE; NO OPEN HIGH-SEVERITY SECURITY FINDING; NO REGRESSION AGAINST THE CURRENT PRODUCTION VERSION BEYOND [TOLERANCE]]

## 8. Planned tests
| Test ID | Test | Method | Data | Pass criterion | Owner | Requirement ref |
|---|---|---|---|---|---|---|
| T1 | Overall performance | Offline evaluation | [TEST SET V] | | | R2 |
| T2 | Performance by operational factor | Slice analysis | | | | |
| T3 | Fairness across groups | Group metric comparison | | | | R3 |
| T4 | Robustness to noisy or shifted input | Perturbation tests | | | | |
| T5 | Adversarial inputs | Attack suite | | | | R6 |
| T6 | Prompt injection and jailbreak (LLM) | Red-team prompts, poisoned retrieval content | | | | R6 |
| T7 | Privacy leakage | Membership inference or output scanning | | | | R7 |
| T8 | Failure behaviour | Dependency outage, malformed input | | | | |
| T9 | Regression against production version | Side-by-side comparison | | | | |
| T10 | User acceptance | Task-based test with [USERS] | | | | R1 |

**Part 2: Report (sections 9 to 12).** Complete before the G3 gate.

## 9. Results
| Test ID | Result | Pass / fail | Evidence (run ID, report link) |
|---|---|---|---|
| T1 | | | |
| T2 | | | |
| | | | |

## 10. Deviations and justifications
| Test ID | Deviation from plan or criterion | Justification | Accepted by |
|---|---|---|---|
| | | | |

## 11. Residual issues
| Issue | Effect on users or affected people | Mitigation or restriction | Owner | Due |
|---|---|---|---|---|
| | | | | |

Residual issues that remain at release are carried into the model card limitations and the AI risk register.

## 12. Decision and sign-off
Decision: [RELEASE / RELEASE WITH CONDITIONS / DO NOT RELEASE]

| Role | Name | Date |
|---|---|---|
| Test lead | | |
| Independent reviewer (high tier) | | |
| System owner | | |
| Gate approver | | |

## 13. Records produced
The plan, the report, run IDs and raw results in [EXPERIMENT TRACKING], kept for the life of the system plus [RETENTION PERIOD]. The auditor compares the pass criteria set here with the results achieved and follows up any accepted deviation.

## 14. Related documents
- AI System Lifecycle Procedure
- AI System Requirements and Design Record
- AI System Impact Assessment Procedure
- AI System Deployment and Release Checklist
- AI System Technical Documentation (Model Card)
- AI Risk Assessment Methodology

## 15. Review and approval
The template is reviewed every {{review_period}} by {{document_owner}} and approved by {{approval_authority}}. Each completed report is approved through the sign-off in section 12.
`,
  },
  {
    name: 'AI System Deployment and Release Checklist',
    category: 'form',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-6-2-5'],
    description: 'Deployment plan and release checklist for each AI system release: environments, component deployment, rollout approach, completed V&V, impact assessment and transparency updates, monitoring, rollback, approvals and a running release record (Annex A.6.2.5).',
    content: `# AI System Deployment and Release Checklist

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose and use
This checklist is the deployment plan and the G4 release gate record for an AI system under the AI System Lifecycle Procedure (Annex A.6.2.5). Complete it for every new system and every significant change. For minor changes, the rows marked (M) are the minimum and can be completed in the change ticket. Each "Yes" needs an evidence reference someone else can open.

## 2. Release identification
| Field | Entry |
|---|---|
| AI system register ID and name | |
| Release version | [MODEL VERSION / APP VERSION / PROMPT VERSION] |
| Change ticket | |
| Release type | [NEW SYSTEM / SIGNIFICANT CHANGE / MINOR CHANGE] |
| Planned date and window | |
| Release owner | |

## 3. Deployment plan
| Item | Entry |
|---|---|
| Developed in | [ENVIRONMENT, ACCOUNT, REGION] |
| Deployed to | [PRODUCTION ENVIRONMENT, REGIONS, CUSTOMER TENANTS, EDGE DEVICES] |
| Components deployed | [MODEL ONLY / SOFTWARE ONLY / BOTH] |
| Separate deployment of model and software? | [YES: ORDER AND COMPATIBILITY CHECK / NO] |
| Rollout approach | [SHADOW / CANARY AT X% / STAGED BY REGION OR CUSTOMER / FULL] |
| Promotion criteria between stages | [METRIC AND THRESHOLD, OBSERVATION PERIOD] |
| Hardware or precision differences from test | [NONE / DESCRIBE AND EQUIVALENCE RESULT] |
| Users and customers informed | [WHO, HOW, WHEN] |
| Support and oversight staff briefed | |

## 4. Release checklist
| # | Check | Yes / No / N/A | Evidence reference | Checked by |
|---|---|---|---|---|
| 1 | (M) Verification and validation report approved, decision "release" or "release with conditions" | | | |
| 2 | (M) Performance metrics meet the release criteria, including per operational factor and per group | | | |
| 3 | (M) Automated regression suite passed on the exact artefact being deployed | | | |
| 4 | User acceptance testing completed and signed off | | | |
| 5 | Impact assessment current for this version and use | | | |
| 6 | Requirements and Design Record and resource record updated | | | |
| 7 | AI Transparency and User Information Notice and model card updated | | | |
| 8 | Customer commitments checked; required notice given | | | |
| 9 | (M) Monitoring dashboards and alerts configured for this version in production | | | |
| 10 | (M) Event logging live and recording model version | | | |
| 11 | Human oversight reviewers trained and rota in place | | | |
| 12 | Security findings closed or accepted; access to model endpoint restricted | | | |
| 13 | (M) Rollback plan written and tested in [STAGING] | | | |
| 14 | Model artefact registered and signed or hashed in [MODEL REGISTRY] | | | |
| 15 | Support team has runbook and escalation contacts | | | |

## 5. Rollback plan
- **Trigger:** [E.G. ALERT X FIRES, ERROR RATE ABOVE VALUE FOR Y MINUTES, OVERSIGHT LEAD DECISION]
- **Who can decide:** [ROLES]
- **Method:** [REDEPLOY PREVIOUS REGISTRY VERSION / FEATURE FLAG OFF / ROUTE TO FALLBACK RULES OR MANUAL PROCESS]
- **Previous version available:** [VERSION, CONFIRMED DEPLOYABLE ON DATE]
- **Data considerations:** [OUTPUTS PRODUCED BY THE NEW VERSION THAT NEED REVIEW AFTER ROLLBACK]
- **Rollback test result:** [DATE, ENVIRONMENT, TIME TAKEN]

## 6. Approvals
| Role | Name | Decision | Date |
|---|---|---|---|
| Release owner | | | |
| System owner | | | |
| Human oversight lead | | | |
| Gate approver (per tier) | | [APPROVED / APPROVED WITH CONDITIONS / REJECTED] | |

## 7. Post-deployment checks
| Check | When | Result | By |
|---|---|---|---|
| Production metrics within expected range | [24 HOURS] | | |
| No unexpected alerts or override spike | [7 DAYS] | | |
| Promotion to next rollout stage | [PER PLAN] | | |
| Success metrics first reading | [30 DAYS] | | |

## 8. Release record
Keep one line per release for the system. The auditor samples from this list.

| Date | Version | Type | Change ticket | Approved by | Rolled back? |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |

## 9. Records produced
The completed checklist, evidence references, approvals and the release record, stored with the change ticket in [TICKETING TOOL / DOCUMENT LIBRARY] and kept for the life of the system plus [RETENTION PERIOD].

## 10. Related documents
- AI System Lifecycle Procedure
- AI Verification and Validation Plan and Report
- AI System Operation and Monitoring Procedure
- AI Event Logging Standard
- AI System Technical Documentation (Model Card)
- AI Transparency and User Information Notice
- AI System Impact Assessment Procedure

## 11. Review and approval
The template is reviewed every {{review_period}} by {{document_owner}} and approved by {{approval_authority}}. Each completed checklist is approved through section 6.
`,
  },
  {
    name: 'AI System Operation and Monitoring Procedure',
    category: 'procedure',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-6-2-6', 'ai-clause-9.1'],
    description: 'How AI systems are watched and supported in production: performance, drift, fairness, override and AI-specific security metrics with thresholds and responders, repair and update, support, the response plan for failures, and reporting results to management review (Annex A.6.2.6 and clause 9.1).',
    content: `# AI System Operation and Monitoring Procedure

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose
This procedure sets how {{client_name}} runs AI systems in production: what is monitored, the thresholds that raise an alert, who responds, how the system is repaired or updated, and how the results reach management (Annex A.6.2.6 and clause 9.1). Monitoring covers whether the system keeps doing what it was designed to do on real data, not only whether it is available.

## 2. Scope
All AI systems in the AIMS Scope Statement that are in operation, whether {{client_name}} developed them or configures a supplier's system. For supplier-hosted models, {{client_name}} monitors the outputs and behaviour it can observe and relies on the supplier's status and change notices for the rest.

## 3. Roles and responsibilities
| Role | Responsibility |
|---|---|
| System owner | Accountable for monitoring being in place and acted on; decides on suspension |
| On-call engineer ([ROTA]) | First response to alerts; follows the runbook |
| ML or technical lead | Investigates performance, drift and fairness alerts; proposes fixes |
| Human oversight lead | Watches override and escalation patterns; reports concerns |
| Security operations | Handles AI-specific security alerts with the ML lead |
| AI governance lead ({{document_owner}}) | Compiles monitoring results for management review |

## 4. What is monitored
- **Performance against design goals** on production data: accuracy or a proxy where ground truth arrives late (for example later human decisions, customer disputes, complaint rates).
- **Data drift:** changes in input distributions compared with training data.
- **Output drift:** changes in the distribution of predictions, scores or response types.
- **Error rates:** failed requests, invalid outputs, timeouts, outputs outside the intended operating range.
- **Fairness metrics** across [RELEVANT GROUPS], where group data is available lawfully.
- **Human override and escalation rates:** how often reviewers change or reject outputs.
- **AI-specific security events:** unusual query volumes or patterns suggesting model extraction, inputs matching known adversarial or prompt injection patterns, unexpected changes in training or retrieval data suggesting poisoning, outputs containing sensitive data.
- **Supplier changes:** model version or API snapshot changes announced or detected.
- **Availability, latency and cost.**

## 5. Monitoring configuration
One table per system, kept with the resource record. Values are set per system from the release criteria.

| Metric | How measured | Threshold | Alert channel | Responder | Response time |
|---|---|---|---|---|---|
| [PRECISION PROXY] | [WEEKLY JOIN WITH HUMAN DECISIONS] | [VALUE] | [ALERT CHANNEL] | ML lead | [2 BUSINESS DAYS] |
| Input drift | [POPULATION STABILITY INDEX PER FEATURE] | [VALUE] | | ML lead | |
| Output distribution | [SHARE OF POSITIVE OUTPUTS] | [VALUE] | | ML lead | |
| Error rate | [FAILED OR INVALID RESPONSES] | [VALUE] | [PAGER] | On-call | [30 MIN] |
| Fairness gap | [ERROR RATE DIFFERENCE BETWEEN GROUPS] | [VALUE] | | ML lead and system owner | |
| Override rate | [OVERRIDES / REVIEWED OUTPUTS] | [VALUE] | | Oversight lead | |
| Extraction pattern | [QUERIES PER KEY PER HOUR] | [VALUE] | [SECURITY CHANNEL] | Security operations | |
| Prompt injection detections | [FILTER HITS PER DAY] | [VALUE] | | Security operations | |
| Latency | [P95] | [VALUE] | | On-call | |

Tools: [MONITORING TOOL], [MODEL MONITORING TOOL], [SIEM]. Alerts go to a channel that someone on the rota watches; alerts that nobody acts on are reviewed in section 11.

## 6. Response and repair plan for errors and failures
1. The responder acknowledges the alert and records it in [TICKETING TOOL].
2. The responder checks the runbook for the system and classifies the event: data issue, model degradation, supplier change, security event or infrastructure fault.
3. If the output could harm people or breach a customer or legal requirement, the system owner decides within [TIME] whether to suspend, restrict (for example send all outputs to human review) or roll back under the AI System Deployment and Release Checklist rollback plan.
4. Events that meet the incident criteria are handled under the AI Incident Response and Communication Plan.
5. The ML lead finds the cause and proposes a fix; the fix goes through change control in the AI System Lifecycle Procedure.
6. After the fix, the responder confirms the metric has returned within threshold and closes the ticket with the cause recorded.

Suspension criteria per system: [E.G. FAIRNESS GAP ABOVE VALUE FOR TWO CONSECUTIVE WEEKS; CONFIRMED POISONING; SUPPLIER MODEL CHANGED WITHOUT NOTICE AND FAILS REGRESSION].

## 7. Repairs and updates
Repairs, retraining and supplier model updates are changes. Scheduled retraining follows the minor change path only while the data stays within [DRIFT BOUNDS] and the regression suite passes; otherwise it is a significant change. Supplier model or API snapshot changes are tested against the regression suite before {{client_name}} switches to them where the supplier allows version pinning.

## 8. Support model
| Tier | Who | Hours | Handles |
|---|---|---|---|
| 1 | [SERVICE DESK] | [HOURS] | User questions, complaints about outputs, routing |
| 2 | [ON-CALL ENGINEER] | [HOURS] | Alerts, errors, rollback |
| 3 | [ML TEAM] | [HOURS] | Model behaviour, drift, retraining |
| Supplier | [SUPPLIER SUPPORT, CONTRACT REF] | [PER CONTRACT] | Hosted model faults |

Complaints about AI outputs are tagged [TAG] so they can be counted as a monitoring signal.

## 9. Compliance with customer and legal requirements
For each system, the system owner lists the contractual commitments (service levels, accuracy commitments, data location, notice of changes) and legal requirements that apply in operation, and how each is monitored: [REQUIREMENT / HOW CHECKED / FREQUENCY]. Breaches or near misses are raised as tickets and reported in section 10.

## 10. Reporting and management review (clause 9.1)
Every [MONTH] the ML lead reviews each system's monitoring results against its targets. Every [QUARTER] the AI governance lead summarises for management review: performance against design goals and AI objectives, alerts and responses, suspensions and rollbacks, drift and retraining, fairness results, override trends, security events and complaints. The summary states what was measured, the method, who analysed it and what it means, and management review records the decisions taken.

## 11. Review of monitoring itself
Every [QUARTER], review alerts that fired with no action, incidents that no alert caught and thresholds that no longer fit, and adjust the configuration through change control.

## 12. Evidence the auditor asks for
- System-generated screenshots or exports of the monitoring configuration and thresholds for sampled systems.
- Notification settings showing where alerts go and who receives them.
- Examples of alerts that fired in the period and the tickets showing the response.
- Monitoring summaries presented to management review and the resulting actions.

## 13. Records produced
Monitoring configuration exports, alert tickets, monthly reviews, management review summaries and suspension decisions, kept in [LOCATION] for [RETENTION PERIOD].

## 14. Related documents
- AI System Lifecycle Procedure
- AI System Deployment and Release Checklist
- AI Event Logging Standard
- AI Incident Response and Communication Plan
- AI Objectives and Measurement Plan
- AI System Resource Documentation Standard
- AI System Technical Documentation (Model Card)

## 15. Review and approval
Reviewed every {{review_period}} and after any incident that monitoring did not detect. Approved by {{approval_authority}}.

| Version | Date | Author | Change | Approved by |
|---|---|---|---|---|
| [1.0] | {{date}} | {{document_owner}} | Initial issue | {{approval_authority}} |
`,
  },
  {
    name: 'AI System Technical Documentation (Model Card)',
    category: 'form',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-6-2-7', 'ai-annex-a-8-2'],
    description: 'Model card style technical documentation for each AI system, written in layers for users, partners and supervisory authorities: purpose and limits, usage, deployment assumptions, measured performance, failure modes, human oversight and version history (Annex A.6.2.7 and A.8.2).',
    content: `# AI System Technical Documentation (Model Card)

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. How to use this card
One card per AI system, updated with every release (Annex A.6.2.7 and A.8.2). Each section is marked with the audiences it serves: **U** users and operators, **P** partners and customers who integrate or deploy the system, **R** supervisory authorities and auditors. Produce the user version by including only the U sections; the full card serves P and R. Write figures that match the latest AI Verification and Validation Plan and Report; a card that claims more than the tests showed is worse than no card.

## 2. Card identification (U, P, R)
| Field | Entry |
|---|---|
| System name and register ID | |
| Version covered | [MODEL / SYSTEM VERSION] |
| Card version and date | |
| Provider | {{client_name}} |
| {{client_name}} role | [PROVIDER / PRODUCER / CUSTOMER / PARTNER] |
| Owner of this card | |

## 3. General description and intended purpose (U, P, R)
[WHAT THE SYSTEM DOES, FOR WHOM, IN WHAT SETTING, AND WHAT DECISION OR TASK ITS OUTPUT SUPPORTS]

Type of output: [SCORE / CLASSIFICATION / GENERATED TEXT / RECOMMENDATION]. Level of automation: [SUGGESTS ONLY / ACTS AFTER APPROVAL / ACTS UNDER MONITORING / ACTS WITHOUT ROUTINE REVIEW].

## 4. Out-of-scope uses (U, P, R)
- [USE THE SYSTEM WAS NOT DESIGNED OR TESTED FOR, E.G. DECISIONS ABOUT MINORS]
- [POPULATIONS, LANGUAGES OR REGIONS NOT COVERED]
- [USE AS THE SOLE BASIS FOR A DECISION WITH LEGAL EFFECT]

## 5. Usage instructions (U, P)
- [HOW TO PROVIDE INPUT AND WHAT GOOD INPUT LOOKS LIKE]
- [HOW TO READ THE OUTPUT, INCLUDING CONFIDENCE OR EXPLANATION]
- [WHEN TO DISREGARD THE OUTPUT OR ESCALATE]
- [HOW TO REPORT A WRONG OR HARMFUL OUTPUT]

## 6. Technical assumptions about deployment and operation (P, R)
| Item | Assumption |
|---|---|
| Run-time environment | [CLOUD REGION / ON-PREMISES / DEVICE] |
| Software dependencies | [SERVING STACK, LIBRARY VERSIONS, API SNAPSHOT] |
| Hardware | [ACCELERATOR TYPE, MEMORY, PRECISION] |
| Input data assumptions | [FORMAT, FIELDS, LANGUAGE, QUALITY, FRESHNESS] |
| Integration assumptions | [CALLING SYSTEM, RATE LIMITS, AUTHENTICATION] |
| Operator assumptions | [TRAINED REVIEWER AVAILABLE, VOLUMES] |

## 7. Data summary (P, R)
[TRAINING, FINE-TUNING AND EVALUATION DATA IN BRIEF: SOURCES, TIME PERIOD, POPULATIONS COVERED, KNOWN GAPS]. Detail: AI Data Quality and Provenance Record [LINK].

## 8. Measured performance (U summary; P, R full)
| Measure | Result | Conditions measured under | Test data and date |
|---|---|---|---|
| Accuracy / [PRIMARY METRIC] | | [OPERATIONAL FACTOR RANGE] | |
| Reliability (consistency across repeated runs, availability) | | | |
| Robustness (performance under noisy or shifted input, adversarial tests) | | | |
| Performance by group | | [GROUPS] | |
| Performance by operational factor | | [E.G. LANGUAGE, IMAGE QUALITY] | |

## 9. Acceptable error rates (U, P, R)
[ACCEPTABLE ERROR RATE PER ERROR TYPE AND WHY IT WAS JUDGED ACCEPTABLE FOR THIS USE, E.G. FALSE NEGATIVE RATE <= VALUE BECAUSE A REVIEWER CHECKS ALL NEGATIVES ABOVE SCORE X]

## 10. Technical limitations (U, P, R)
- [CONDITIONS UNDER WHICH PERFORMANCE DROPS]
- [KNOWN BIASES OR UNDER-REPRESENTED GROUPS]
- [FOR LLM-BASED SYSTEMS: MAY PRODUCE CONFIDENT BUT INCORRECT TEXT; SUSCEPTIBLE TO PROMPT INJECTION IN SUPPLIED CONTENT]

## 11. Known failure modes (P, R)
| Failure mode | Symptom | Likelihood | Detection | Mitigation |
|---|---|---|---|---|
| | | | | |
| | | | | |

## 12. Human oversight (U, P, R)
[WHO REVIEWS OUTPUTS, AT WHAT POINT, WHAT INFORMATION THEY SEE, THEIR AUTHORITY TO OVERRIDE, AND HOW AFFECTED PEOPLE CAN ASK FOR A HUMAN REVIEW]

## 13. Monitoring and controls available to users and operators (U, P)
- Monitoring in place: [WHAT {{client_name}} MONITORS, E.G. DRIFT, ERROR AND OVERRIDE RATES]
- Controls users or operators have: [CONFIDENCE THRESHOLD SETTING, OPT-OUT, FEEDBACK BUTTON, FEATURE SWITCH, MANUAL FALLBACK]
- What partners must monitor on their side: [E.G. INPUT QUALITY, THEIR OWN USE CASE LIMITS]

## 14. Managing previously unknown failures and updates (P, R)
[HOW NEW FAILURE MODES ARE REPORTED AND INVESTIGATED; HOW UPDATES ARE TESTED AND RELEASED; HOW MUCH NOTICE PARTNERS GET OF CHANGES THAT AFFECT BEHAVIOUR; HOW THIS CARD IS UPDATED AFTERWARDS]

## 15. Version history (P, R)
| Card version | System version | Date | What changed | Approved by |
|---|---|---|---|---|
| [1.0] | | {{date}} | Initial card | |
| | | | | |

## 16. Contact (U, P, R)
Questions, concerns or reports about this system: [CONTACT ROLE AND ADDRESS]. Response target: [BUSINESS DAYS].

## 17. Records produced
Each card version, with the V&V report it draws its figures from, kept for the life of the system plus [RETENTION PERIOD]. The auditor compares published figures with test results and checks the card was updated with the last release.

## 18. Related documents
- AI Transparency and User Information Notice
- AI Verification and Validation Plan and Report
- AI System Resource Documentation Standard
- AI System Requirements and Design Record
- AI Data Quality and Provenance Record
- AI System Operation and Monitoring Procedure

## 19. Review and approval
The template is reviewed every {{review_period}} by {{document_owner}} and approved by {{approval_authority}}. Each card version is approved by the system owner as part of the release checklist.
`,
  },
  {
    name: 'AI Event Logging Standard',
    category: 'policy',
    tier: 'expected',
    requirement_refs: ['ai-annex-a-6-2-8'],
    description: 'Which AI systems log events automatically, what each record holds (use, inputs or references, outputs, out-of-range results, overrides, model version, errors), traceability, protection, retention and review of logs, with an example schema (Annex A.6.2.8).',
    content: `# AI Event Logging Standard

${STARTER_NOTE}
${CONTROL_BLOCK}

## 1. Purpose
This standard sets what {{client_name}}'s AI systems record automatically while in use, so that any output can be traced back to the input, model version and people involved, and so that performance outside the intended operating conditions can be spotted (Annex A.6.2.8). It supplements {{client_name}}'s general security logging; it does not replace it.

## 2. Scope
All AI systems in the AIMS Scope Statement that are in operation. Logging depth follows the risk tier:

| Tier | Logging requirement |
|---|---|
| Low | Each use with time, model version, outcome and errors |
| Medium | As low, plus input references, outputs and human decisions |
| High | As medium, plus confidence or explanation data, full override detail and tamper-evident storage |

For supplier-hosted models, {{client_name}} logs at its own integration layer; supplier-side logs are requested where the contract allows.

## 3. Roles and responsibilities
| Role | Responsibility |
|---|---|
| System owner | Approves the logging specification for the system |
| Technical lead | Implements logging and keeps the specification current |
| Privacy lead | Approves what personal data may appear in logs |
| Security operations | Protects log storage and access; forwards security events to [SIEM] |
| ML lead | Reviews logs for performance outside intended operating conditions |

## 4. Events to record
- **Each use:** date and time (UTC), request ID, calling system or user reference.
- **Inputs:** a reference to the production data processed (record ID, document hash, retrieval document IDs). Store raw inputs only where lawful, needed for the purpose and approved by the privacy lead.
- **Outputs:** the prediction, score, classification or generated text (or its hash and a pointer to where it is stored).
- **Outputs outside the intended operating range:** low confidence, out-of-distribution flag, unsupported language or input type, refused requests.
- **Human decisions:** reviewer ID, whether the output was accepted, changed or rejected, and the reason code.
- **Model and configuration version:** model registry version, prompt template version, retrieval index version, threshold settings.
- **Errors:** failures, timeouts, fallbacks used.
- **Security-relevant events:** prompt injection filter hits, rate-limit breaches, authentication failures on the model endpoint.

## 5. Traceability
Every log record carries a request ID that links the input reference, the output, the model and configuration versions and any human decision. From one log record, an investigator can identify which training data version and V&V report stand behind the model version. Clocks are synchronised to [TIME SOURCE].

## 6. Personal and sensitive data in logs
Log the minimum needed. Mask or hash identifiers where the full value is not needed for tracing. Never log secrets, authentication tokens or payment card data. The privacy lead approves the logging specification for any system that processes personal data, and data subject requests cover log data where it holds personal data.

## 7. Protection and access
- Logs are written to [LOG STORE] that application users and model developers cannot alter or delete.
- High-tier systems use tamper-evident storage [E.G. WRITE-ONCE STORAGE OR HASH CHAINING].
- Read access is limited to [ROLES] and is itself logged.
- Logs are encrypted in transit and at rest.

## 8. Retention
Logs are kept for [RETENTION PERIOD], set per system from its intended use, {{client_name}}'s data retention policy ([RECORDS RETENTION SCHEDULE]) and legal or contractual obligations, and long enough to cover the audit period and the time within which a decision can be challenged. At the end of retention, logs are deleted or anonymised under [DELETION PROCEDURE].

## 9. Review of logs
The ML lead reviews logs every [WEEK / MONTH] for:
- the share of outputs outside the intended operating range, against [VALUE];
- override patterns by reviewer, group or input type;
- errors and fallbacks;
- signs of misuse, extraction or injection attempts.
Findings go to the AI System Operation and Monitoring Procedure; incidents go to the AI Incident Response and Communication Plan. Where a metric can be computed from logs automatically, it becomes a monitoring alert instead of a manual check.

## 10. Example log schema
| Field | Type | Example | Notes |
|---|---|---|---|
| request_id | string | [UUID] | Links all records for one use |
| timestamp_utc | datetime | [2026-01-15T10:22:31Z] | |
| system_id | string | [AI-012] | AI system register ID |
| model_version | string | [CLAIMS-TRIAGE 3.2.0] | From model registry |
| config_version | string | [PROMPT V14, THRESHOLD 0.72] | |
| caller_ref | string | [SERVICE OR USER ID] | Pseudonymised where possible |
| input_ref | string | [CASE-88213 / SHA-256] | Reference, not raw data, unless approved |
| output | string / number | [0.81 / REFER] | Or hash and pointer |
| confidence | number | [0.81] | |
| out_of_range_flag | boolean | [FALSE] | Out-of-distribution or unsupported input |
| human_decision | enum | [ACCEPTED / CHANGED / REJECTED] | |
| reviewer_id | string | [REVIEWER ID] | |
| override_reason | enum | [REASON CODE] | |
| error_code | string | [NONE] | |
| security_flag | string | [INJECTION_FILTER_HIT] | |

## 11. Evidence the auditor asks for
- The logging configuration or specification for sampled systems.
- An example log extract showing AI-specific fields (model version, output, override), with personal data masked for the audit.
- Access control settings on the log store and the retention setting.
- A record of a log review and the action taken.

## 12. Records produced
Logging specifications per system, log review records and retention settings, kept in [LOCATION]. The logs themselves are kept per section 8.

## 13. Related documents
- AI Policy
- AI Data Management Policy
- AI System Operation and Monitoring Procedure
- AI System Deployment and Release Checklist
- AI Incident Response and Communication Plan
- AI System Technical Documentation (Model Card)

## 14. Review and approval
Reviewed every {{review_period}} and when a new system reaches production or a log fails to support an investigation. Approved by {{approval_authority}}.

| Version | Date | Author | Change | Approved by |
|---|---|---|---|---|
| [1.0] | {{date}} | {{document_owner}} | Initial issue | {{approval_authority}} |
`,
  },
];
