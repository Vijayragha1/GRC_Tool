// ISO/IEC 42001:2023 catalog: Clauses 4-10 + Annex A (38 AI-management controls).
// Content grounded in publicly available descriptions of ISO/IEC 42001:2023 (AI Management
// System requirements) and Annex A (reference controls), supplemented by Annex B
// implementation guidance and Annex C (objectives & risk sources) where relevant.
//
// Annex A controls use the standard's structure, populated with:
//   questions          -> Applicability (where the control is relevant)
//   evidence_needed    -> Implementation considerations (per Annex B guidance)
//   documentation_needed -> Audit evidence (records and artefacts an auditor would examine)
//
// Specifics (frequencies, thresholds, percentages) are deliberately omitted unless
// mandated by the standard. Where the organization needs to define a value (review
// frequency, retention, drift thresholds), content uses "as defined by the organization"
// to be customized per AIMS context.

function ctrl(code, category, sort, title, summary, applicability, considerations, evidence) {
  return {
    id: 'ai-annex-' + code.toLowerCase().replace(/\./g, '-'),
    type: 'control', category, sort_order: sort,
    title: code + ' ' + title,
    summary,
    questions: applicability,
    evidence_needed: considerations,
    documentation_needed: evidence
  };
}

module.exports = [
  // ==================== CLAUSES 4-10 ====================
  { id: 'ai-clause-4.1', type: 'clause', category: 'context', sort_order: 1,
    title: '4.1 Understanding the organization and its context',
    summary: "Determine external and internal issues relevant to the organization's purpose that affect its ability to achieve the intended outcomes of its AI management system (AIMS). The role of the organization with respect to AI systems shall be determined (e.g., provider, developer, deployer, user).",
    questions: ["What internal issues (governance, structure, capabilities, AI maturity, culture, contracts) are relevant to the AIMS?", "What external issues (regulatory, technological, market, threat landscape, AI ethics expectations) are relevant?", "What role(s) does the organization play with respect to each AI system (provider, developer, deployer, customer, partner, etc.)?", "How are these issues and roles reviewed and updated?"],
    evidence_needed: ["Records of analysis (workshops, PESTLE, SWOT, or equivalent).", "Documented determination of organizational roles per AI system.", "Inputs to risk assessment that reflect identified issues.", "Management review minutes where context is reviewed."],
    documentation_needed: ["The organization determines what documented information is necessary; this analysis is commonly part of the AIMS scope or a context register, with AI roles recorded explicitly."]
  },
  { id: 'ai-clause-4.2', type: 'clause', category: 'context', sort_order: 2,
    title: '4.2 Understanding the needs and expectations of interested parties',
    summary: "Determine interested parties relevant to the AIMS and their requirements (including legal, regulatory, contractual). Interested parties for AI typically include affected individuals or groups, regulators, customers, employees, and society at large.",
    questions: ["Who are the interested parties relevant to the AIMS (users, affected individuals, regulators, suppliers, employees, civil-society groups)?", "What are their requirements relevant to the AI systems in scope (privacy, fairness, transparency, safety, performance)?", "Which of these requirements will be addressed by the AIMS?", "Are obligations such as the EU AI Act, sectoral AI regulation, or contractual AI clauses identified?"],
    evidence_needed: ["List of interested parties and their requirements.", "Register of legal, regulatory, and contractual obligations covering AI.", "Linkage from requirements to controls, risks, or AI impact assessments."],
    documentation_needed: ["Documented information determined as necessary by the organization (typically a stakeholder register and a legal/regulatory register)."]
  },
  { id: 'ai-clause-4.3', type: 'clause', category: 'context', sort_order: 3,
    title: '4.3 Determining the scope of the AI management system',
    summary: "Determine the boundaries and applicability of the AIMS, considering the issues from 4.1, requirements from 4.2, and the AI systems, products, and services for which the organization is responsible. The scope shall be available as documented information.",
    questions: ["Which AI systems, products, services, and lifecycle stages are within scope?", "Which organizational units, locations, and processes are within scope?", "What interfaces and dependencies exist with out-of-scope AI activities (e.g., AI used informally by staff, third-party AI in business tools)?", "Are exclusions justified?"],
    evidence_needed: ["A documented scope statement listing in-scope AI systems and any exclusions with rationale.", "An AI system inventory with criticality classification.", "Supporting context: organizational charts, network/architecture diagrams."],
    documentation_needed: ["AIMS Scope (mandatory documented information per Clause 4.3).", "AI system inventory (recommended by Annex B)."]
  },
  { id: 'ai-clause-4.4', type: 'clause', category: 'context', sort_order: 4,
    title: '4.4 AI management system',
    summary: "Establish, implement, maintain, and continually improve an AIMS, including the processes needed and their interactions, in accordance with the requirements of this document.",
    questions: ["Are the processes of the AIMS identified and their interactions described?", "Is the AIMS being maintained and improved through the operation of those processes?"],
    evidence_needed: ["AIMS process descriptions or maps.", "Evidence of AIMS operation: AI risk assessments, impact assessments, internal audits, management reviews, corrective actions."],
    documentation_needed: ["The organization determines the level of documented information needed; an AIMS manual or process model is common but not mandated."]
  },
  { id: 'ai-clause-5.1', type: 'clause', category: 'leadership', sort_order: 5,
    title: '5.1 Leadership and commitment',
    summary: "Top management shall demonstrate leadership and commitment with respect to the AIMS, including ensuring the AI policy and objectives are established and aligned with strategy, integrating AIMS requirements into business processes, providing resources, and promoting continual improvement.",
    questions: ["How does top management ensure the AI policy and objectives are established and aligned with strategy?", "How does top management ensure resources are available and AIMS requirements are integrated into business processes?", "How does top management direct and support persons to contribute to AIMS effectiveness?"],
    evidence_needed: ["Management review minutes showing AI governance decision-making.", "Resource allocation records (budgets, headcount for AI risk, AI ethics, data quality).", "Communications from top management on responsible AI principles."],
    documentation_needed: ["Approved AI Policy.", "Records of management review."]
  },
  { id: 'ai-clause-5.2', type: 'clause', category: 'leadership', sort_order: 6,
    title: '5.2 AI policy',
    summary: "Top management shall establish an AI policy that is appropriate to the organization's purpose and AI activities, provides a framework for AI objectives, includes commitments to satisfy applicable requirements and to continual improvement, and reflects organizational values for responsible AI.",
    questions: ["Is the AI policy appropriate to the organization's purpose and AI footprint?", "Does it include or provide a framework for AI objectives?", "Does it include commitments to applicable requirements (legal, regulatory, ethical) and to continual improvement?", "Is it communicated internally and available to interested parties as appropriate?"],
    evidence_needed: ["Approved policy text containing the required commitments and statements on responsible AI principles (fairness, transparency, accountability, human oversight, safety, privacy, security).", "Evidence of communication (intranet, training, acknowledgements) and external availability where appropriate."],
    documentation_needed: ["AI Policy (mandatory documented information per Clause 5.2)."]
  },
  { id: 'ai-clause-5.3', type: 'clause', category: 'leadership', sort_order: 7,
    title: '5.3 Roles, responsibilities and authorities',
    summary: "Top management shall ensure that responsibilities and authorities for roles relevant to the AIMS are assigned and communicated, including for ensuring conformity and reporting on AIMS performance.",
    questions: ["Who is responsible for ensuring the AIMS conforms to the requirements?", "Who reports on AIMS performance to top management?", "Are AI-specific roles (e.g., AI ethics lead, model owner, data steward, AI risk officer) defined?", "How are these responsibilities communicated?"],
    evidence_needed: ["Documented roles and responsibilities matrix covering AI lifecycle activities.", "Job descriptions or appointment records.", "Evidence of communication."],
    documentation_needed: ["Documented information defining roles and responsibilities (form determined by the organization)."]
  },
  { id: 'ai-clause-6.1.1', type: 'clause', category: 'planning', sort_order: 8,
    title: '6.1.1 Actions to address risks and opportunities - General',
    summary: "When planning the AIMS, consider the issues (4.1) and requirements (4.2) and determine the risks and opportunities to be addressed to give assurance the AIMS can achieve its outcomes, prevent or reduce undesired effects, and achieve continual improvement.",
    questions: ["How are risks and opportunities to the AIMS determined?", "How does the organization plan actions to address them, integrate them into the AIMS, and evaluate their effectiveness?"],
    evidence_needed: ["A defined approach for identifying AIMS-level risks and opportunities.", "Linkage from identified risks/opportunities to plans, controls, or objectives."],
    documentation_needed: ["The organization determines documented information needed; commonly part of the risk-management process."]
  },
  { id: 'ai-clause-6.1.2', type: 'clause', category: 'planning', sort_order: 9,
    title: '6.1.2 AI risk assessment',
    summary: "Define and apply an AI risk assessment process that establishes criteria, ensures comparable results, identifies risks related to AI systems and the AIMS, analyzes them, and evaluates them against criteria. AI risk sources from Annex C (e.g., bias, opacity, performance degradation, misuse, automation bias, security threats) should be considered.",
    questions: ["Does the AI risk assessment process establish criteria for performing assessments and for risk acceptance?", "Are AI-specific risk sources considered (bias, fairness, opacity, robustness, automation complacency, misuse, environmental impact, security threats)?", "Are risk owners identified?", "Are risks analyzed (likelihood and consequences) and evaluated against criteria?"],
    evidence_needed: ["Documented AI risk assessment methodology.", "Defined risk criteria including acceptance criteria.", "AI risk register / assessment results with identified risks, owners, analysis, and evaluation."],
    documentation_needed: ["Information about the AI risk assessment process (mandatory).", "Results of the AI risk assessment (mandatory)."]
  },
  { id: 'ai-clause-6.1.3', type: 'clause', category: 'planning', sort_order: 10,
    title: '6.1.3 AI risk treatment',
    summary: "Define and apply an AI risk treatment process: select treatment options, determine necessary controls, compare with Annex A reference controls, produce a Statement of Applicability with justifications, formulate a risk treatment plan, and obtain risk owners' approval of the plan and residual risks.",
    questions: ["How are AI risk treatment options selected?", "How are controls determined and compared with Annex A?", "Does the SoA include all Annex A controls with applicability decisions and justifications?", "Is the treatment plan approved by risk owners along with acceptance of residual AI risks?"],
    evidence_needed: ["AI risk treatment process description.", "AI risk treatment plan with actions, responsibilities, and deadlines.", "Statement of Applicability listing all Annex A controls with applicability and justification.", "Records of risk owner approval."],
    documentation_needed: ["Information about the AI risk treatment process (mandatory).", "Statement of Applicability (mandatory).", "AI risk treatment plan (mandatory)."]
  },
  { id: 'ai-clause-6.1.4', type: 'clause', category: 'planning', sort_order: 11,
    title: '6.1.4 AI system impact assessment',
    summary: "Establish a process to assess the potential consequences for individuals, groups of individuals, and society that can result from the development, provision, or use of AI systems. This is the distinctive AI-specific addition to the management-system structure.",
    questions: ["Has an AI system impact assessment process been defined?", "Does it cover effects on individuals (rights, autonomy, safety, privacy), groups (especially vulnerable populations), and society (economic, environmental, democratic, cultural)?", "Are impact assessments triggered for new AI systems, significant changes, and at planned intervals?", "Are mitigations identified and tracked for negative impacts?"],
    evidence_needed: ["Documented impact assessment methodology covering individual, group, and societal dimensions.", "Trigger criteria for performing or refreshing assessments.", "Linkage from impact assessment outputs to risk treatment and AI system controls."],
    documentation_needed: ["AI system impact assessment process (mandatory).", "Impact assessment results for in-scope AI systems (referenced by Clause 8.4 and Annex A.5)."]
  },
  { id: 'ai-clause-6.2', type: 'clause', category: 'planning', sort_order: 12,
    title: '6.2 AI objectives and planning to achieve them',
    summary: "Establish AI objectives at relevant functions and levels. Objectives shall be consistent with the policy, measurable (where practicable), monitored, communicated, updated, and supported by plans.",
    questions: ["Are AI objectives consistent with the policy and applicable requirements?", "Are they measurable where practicable (e.g., fairness metrics, drift thresholds, training coverage, model documentation completeness)?", "Are they monitored and communicated?", "Is there a plan for each objective: what will be done, with what resources, by whom, by when, how results will be evaluated?"],
    evidence_needed: ["Documented AI objectives.", "Plans linking actions, resources, owners, deadlines, and evaluation methods to each objective."],
    documentation_needed: ["AI objectives (mandatory)."]
  },
  { id: 'ai-clause-6.3', type: 'clause', category: 'planning', sort_order: 13,
    title: '6.3 Planning of changes',
    summary: "When the organization determines the need for changes to the AIMS or to AI systems in scope, the changes shall be carried out in a planned manner. AI changes include model updates, retraining, dataset changes, change of intended use, and architectural changes.",
    questions: ["How are changes to the AIMS and to AI systems planned and controlled?", "How are consequences of changes assessed, including impact on people, performance, and compliance?", "Are change triggers for re-assessment (re-training data, drift, regulator guidance) defined?"],
    evidence_needed: ["Records of planned changes with impact assessment, approvals, and outcomes.", "Change-management procedure addressing model versioning and data lineage."],
    documentation_needed: ["Determined by the organization; commonly part of the change-management process or MLOps tooling."]
  },
  { id: 'ai-clause-7.1', type: 'clause', category: 'support', sort_order: 14,
    title: '7.1 Resources',
    summary: "Determine and provide resources needed for the establishment, implementation, maintenance, and continual improvement of the AIMS, including people, compute, data, tooling, and budget.",
    questions: ["What resources (people, AI/ML expertise, compute, storage, tooling, financial) are needed?", "Are they being provided?"],
    evidence_needed: ["Budget allocations.", "Staffing and tooling for the AIMS (e.g., ML platform, monitoring stack, bias-evaluation libraries).", "Management review consideration of resource adequacy."],
    documentation_needed: ["Determined by the organization."]
  },
  { id: 'ai-clause-7.2', type: 'clause', category: 'support', sort_order: 15,
    title: '7.2 Competence',
    summary: "Determine necessary competence of persons doing work that affects AI management system performance, ensure they are competent on the basis of education, training, or experience, and take action where competence gaps exist. AI competences span technical (data science, ML engineering, security), domain (the field the AI applies to), and ethical/legal (responsible-AI literacy).",
    questions: ["What competences are required for AIMS-relevant roles (data scientists, model owners, reviewers, AI ethics roles, deployers, users)?", "How is competence ensured (training, hiring, mentoring, certification)?", "How is competence verified?"],
    evidence_needed: ["Competence requirements in job descriptions or skills matrices.", "Training records, qualifications, certifications.", "Records of role-specific AI literacy training (especially for non-technical roles using AI)."],
    documentation_needed: ["Evidence of competence as documented information."]
  },
  { id: 'ai-clause-7.3', type: 'clause', category: 'support', sort_order: 16,
    title: '7.3 Awareness',
    summary: "Persons doing work under the organization's control shall be aware of the AI policy, their contribution to AIMS effectiveness, and the implications of not conforming, including specific AI-related implications (harm to individuals, reputational damage, regulatory consequences).",
    questions: ["Are personnel aware of the AI policy?", "Are they aware of their contribution to the AIMS and of the implications of non-conformance?", "Do AI users (including non-technical users of AI tools) know the limits and intended use of the AI systems they operate?"],
    evidence_needed: ["Awareness campaigns covering responsible AI use, prohibited uses, escalation paths.", "Acknowledgement records.", "Onboarding content covering AI policy."],
    documentation_needed: ["Determined by the organization."]
  },
  { id: 'ai-clause-7.4', type: 'clause', category: 'support', sort_order: 17,
    title: '7.4 Communication',
    summary: "Determine internal and external communications relevant to the AIMS, including what, when, with whom, and how to communicate. This includes communication of AI-related incidents, model behaviour changes, and stakeholder engagement.",
    questions: ["What internal communications about the AIMS are planned (status updates, incident notification, training)?", "What external communications (regulator notifications, public statements on AI use, customer-facing AI disclosures)?", "Who is authorized to communicate on behalf of the organization regarding AI matters?"],
    evidence_needed: ["Communication plan or matrix.", "Templates for AI-related external communications (incident notification, transparency disclosures)."],
    documentation_needed: ["Determined by the organization."]
  },
  { id: 'ai-clause-7.5', type: 'clause', category: 'support', sort_order: 18,
    title: '7.5 Documented information',
    summary: "Determine documented information required by ISO 42001 and that necessary for AIMS effectiveness. Create, update, and control documented information, including version control, access, distribution, retention, and disposal. AI artefacts include model cards, datasheets, evaluation reports, and lineage records.",
    questions: ["What documented information is required by ISO 42001 and for AIMS effectiveness?", "How is documented information identified, formatted, reviewed, approved, version-controlled, distributed, retained, and disposed of?", "How is documented information of external origin (e.g., open-source model documentation, dataset documentation) controlled?"],
    evidence_needed: ["A control-of-documents procedure that handles model cards, datasheets, evaluation reports, and lineage records alongside standard documents."],
    documentation_needed: ["Approved control-of-documents procedure (typical)."]
  },
  { id: 'ai-clause-8.1', type: 'clause', category: 'operation', sort_order: 19,
    title: '8.1 Operational planning and control',
    summary: "Plan, implement, and control the processes needed to meet AIMS requirements and to implement the actions determined in Clause 6, including outsourced AI processes (e.g., third-party model providers, data labelling vendors).",
    questions: ["Are processes for AI development, deployment, and operation planned and controlled?", "Are outsourced AI processes (third-party APIs, foundation models, contractors) identified and controlled?", "Are unplanned changes reviewed and corrective action taken?"],
    evidence_needed: ["Process descriptions for AI lifecycle stages.", "Vendor management and outsourcing controls.", "Records of unplanned-change reviews."],
    documentation_needed: ["Documented information needed to have confidence the processes have been carried out as planned."]
  },
  { id: 'ai-clause-8.2', type: 'clause', category: 'operation', sort_order: 20,
    title: '8.2 AI risk assessment',
    summary: "Perform AI risk assessments at planned intervals or when significant changes occur. Retain documented results.",
    questions: ["At what intervals is the AI risk assessment performed?", "What triggers a fresh assessment (new system, significant change, incident, regulator change)?", "Are results documented and acted upon?"],
    evidence_needed: ["Scheduled and ad-hoc risk assessment records.", "Trigger criteria documented in the methodology."],
    documentation_needed: ["Results of AI risk assessments (mandatory)."]
  },
  { id: 'ai-clause-8.3', type: 'clause', category: 'operation', sort_order: 21,
    title: '8.3 AI risk treatment',
    summary: "Implement the AI risk treatment plan and retain documented results.",
    questions: ["Are treatment actions being implemented as planned?", "Are residual AI risks being tracked?", "Are treatment effectiveness measures in place?"],
    evidence_needed: ["Treatment action tracker.", "Effectiveness reviews of selected AI controls."],
    documentation_needed: ["Results of AI risk treatment (mandatory)."]
  },
  { id: 'ai-clause-8.4', type: 'clause', category: 'operation', sort_order: 22,
    title: '8.4 AI system impact assessment',
    summary: "Perform AI system impact assessments at planned intervals and when significant changes occur. Retain documented results. This operationalises the impact-assessment process defined under 6.1.4.",
    questions: ["Are AI system impact assessments performed and refreshed?", "Are they triggered by significant changes (model retraining, intended-use changes, new deployment context)?", "Are outputs reviewed and used to update controls and the risk treatment plan?"],
    evidence_needed: ["Impact assessment records per AI system.", "Linkage from impact assessment to corrective actions or control updates."],
    documentation_needed: ["Results of AI system impact assessments (mandatory)."]
  },
  { id: 'ai-clause-9.1', type: 'clause', category: 'performance', sort_order: 23,
    title: '9.1 Monitoring, measurement, analysis and evaluation',
    summary: "Determine what needs to be monitored and measured, by what methods, when, and by whom. Analyse and evaluate AIMS performance and effectiveness, including AI system performance, fairness, drift, and security metrics.",
    questions: ["What AIMS- and AI-system-level metrics are monitored (accuracy, fairness, drift, robustness, availability, complaint rates)?", "How and how often are they measured?", "Who analyses results and what triggers escalation?"],
    evidence_needed: ["Monitoring plan with metrics, methods, frequencies, owners.", "Analysis outputs (dashboards, reports).", "Threshold-based alerts and escalation records."],
    documentation_needed: ["Evidence of monitoring and measurement results (mandatory)."]
  },
  { id: 'ai-clause-9.2', type: 'clause', category: 'performance', sort_order: 24,
    title: '9.2 Internal audit',
    summary: "Conduct internal audits at planned intervals to determine whether the AIMS conforms to ISO 42001 and the organization's requirements and is effectively implemented and maintained.",
    questions: ["Is there an audit programme covering the AIMS?", "Are auditors competent and impartial?", "Are findings reported, corrective actions taken, and effectiveness verified?"],
    evidence_needed: ["Audit programme and plans.", "Audit reports with findings.", "Corrective action records."],
    documentation_needed: ["Audit programme and audit results (mandatory)."]
  },
  { id: 'ai-clause-9.3', type: 'clause', category: 'performance', sort_order: 25,
    title: '9.3 Management review',
    summary: "Top management shall review the AIMS at planned intervals, considering status of previous actions, changes in context, AIMS performance, audit results, incidents, risk and impact assessment results, and opportunities for improvement.",
    questions: ["Is management review conducted at planned intervals?", "Are required inputs considered (per 9.3)?", "Are outputs (decisions on improvement and changes) recorded and actioned?"],
    evidence_needed: ["Management review schedule and agenda.", "Minutes covering required inputs and outputs."],
    documentation_needed: ["Management review results (mandatory)."]
  },
  { id: 'ai-clause-10.1', type: 'clause', category: 'improvement', sort_order: 26,
    title: '10.1 Continual improvement',
    summary: "Continually improve the suitability, adequacy, and effectiveness of the AIMS.",
    questions: ["How are improvement opportunities identified?", "How are improvements prioritized and tracked?"],
    evidence_needed: ["Improvement initiative log.", "Tracked improvements with status and outcomes."],
    documentation_needed: ["Determined by the organization."]
  },
  { id: 'ai-clause-10.2', type: 'clause', category: 'improvement', sort_order: 27,
    title: '10.2 Nonconformity and corrective action',
    summary: "React to nonconformities, evaluate the need for action to eliminate causes, implement actions, review effectiveness, and update the AIMS as needed. AI-specific nonconformities include unintended bias, model failures, breach of impact thresholds, or unauthorised AI use.",
    questions: ["How are nonconformities (including AI-specific incidents) recognised and acted on?", "Is root-cause analysis performed?", "Is effectiveness of corrective actions reviewed?"],
    evidence_needed: ["Nonconformity log.", "Root-cause analyses.", "Corrective action records with effectiveness reviews."],
    documentation_needed: ["Nature of nonconformities and actions taken (mandatory).", "Results of any corrective action (mandatory)."]
  },

  // ==================== ANNEX A: 38 REFERENCE CONTROLS ====================

  // A.2 Policies related to AI (3)
  ctrl('A.2.2', 'a-policies', 28, 'AI policy',
    'Maintain a written AI policy approved at the appropriate management level setting out how the organization develops, provides, or uses AI systems and reflecting commitments to responsible-AI principles.',
    ['Has an AI policy been approved by appropriate management?', 'Does it cover the organization\'s AI activities (develop, provide, use)?', 'Does it reference responsible-AI principles the organization commits to (fairness, transparency, accountability, human oversight, safety, privacy, security)?'],
    ['Align the policy with the AI strategy, broader risk appetite, and any sector or jurisdictional obligations (e.g., EU AI Act).', 'State boundaries on intended use, prohibited use, and acceptable risk.', 'Make the policy understandable to non-specialist staff who use AI.'],
    ['Approved AI policy document.', 'Communication and acknowledgement records.', 'Mapping from the policy to controls and procedures.']
  ),
  ctrl('A.2.3', 'a-policies', 29, 'Alignment with other organizational policies',
    'Ensure the AI policy is consistent with the organization\'s existing policies (information security, privacy, risk management, HR, procurement, third-party, ethics) and update them where conflicts arise.',
    ['Have related policies been reviewed for conflicts with the AI policy?', 'Have inconsistencies been resolved or escalated?', 'Are AI-specific clauses incorporated into related policies (e.g., AI in HR, AI in procurement)?'],
    ['Cross-reference the AI policy with ISO 27001 information-security policies, privacy notices, HR codes of conduct, and procurement contract templates.', 'Identify shared definitions (e.g., what counts as an AI system) to avoid inconsistency.'],
    ['Cross-reference matrix between AI policy and other policies.', 'Update logs on related policies citing AI alignment.']
  ),
  ctrl('A.2.4', 'a-policies', 30, 'Review of the AI policy',
    'Review the AI policy at planned intervals or when significant changes occur (regulatory, technological, business model) to ensure continuing suitability, adequacy, and effectiveness.',
    ['Is the AI policy reviewed at planned intervals?', 'Is it reviewed in response to significant changes (new AI systems, regulatory updates, incidents)?', 'Are review outcomes documented and approved?'],
    ['Tie review cycle to the management review cadence.', 'Trigger ad-hoc reviews for incidents or regulatory developments.'],
    ['Policy review records with date, reviewer, decisions, and approval.', 'Updated policy versions with change history.']
  ),

  // A.3 Internal organization (2)
  ctrl('A.3.2', 'b-internal-organization', 31, 'AI roles and responsibilities',
    'Define and assign roles and responsibilities for AI across the lifecycle, including for development, deployment, operation, monitoring, oversight, and incident handling.',
    ['Are AI-specific roles defined (e.g., AI ethics lead, model owner, data steward, AI risk officer, deployment approver)?', 'Is accountability assigned for each AI system across its lifecycle?', 'Are decision authorities (e.g., go/no-go on deployment) explicit?'],
    ['Use a RACI matrix per AI system or per AI lifecycle stage.', 'Designate escalation paths for AI incidents and ethical concerns.', 'Avoid concentration of accountability in a single role; consider segregation between development and oversight.'],
    ['RACI matrix or role descriptions for AI activities.', 'Appointment letters for AI-related roles.', 'Records of decision authority being exercised.']
  ),
  ctrl('A.3.3', 'b-internal-organization', 32, 'Reporting of concerns',
    'Establish a process for staff and external parties to raise concerns regarding the development, provision, or use of AI systems, including a means to do so anonymously.',
    ['Is there a documented channel for raising AI-related concerns?', 'Does it protect against retaliation?', 'Are external parties (users, affected individuals) able to raise concerns?'],
    ['Integrate with existing whistleblower or grievance channels.', 'Define triage and feedback mechanisms.', 'Track and analyse concerns to identify systemic issues.'],
    ['Documented concern-reporting procedure.', 'Records of concerns received, triaged, and resolved.', 'Anti-retaliation policy referenced or attached.']
  ),

  // A.4 Resources for AI systems (5)
  ctrl('A.4.2', 'c-resources', 33, 'Resource documentation',
    'Document the resources required for and used by AI systems across their lifecycle, providing the input needed for risk assessment, impact assessment, and operational management.',
    ['Is an inventory maintained of resources (data, tools, compute, people) used by each AI system?', 'Does it cover all lifecycle stages?', 'Is it updated when systems change?'],
    ['Use an AI system inventory linked to data, model, and infrastructure inventories.', 'Capture both internal and third-party resources.'],
    ['AI resource inventory.', 'Linkage to risk assessments and impact assessments.']
  ),
  ctrl('A.4.3', 'c-resources', 34, 'Data resources',
    'Document data resources used by each AI system, including provenance, intended use, quality, known limitations, and how the data was prepared.',
    ['Are datasets used in training, testing, and operating each AI system documented?', 'Are data provenance, licensing, and rights captured?', 'Are known limitations and biases recorded?'],
    ['Use datasheets or dataset cards.', 'Capture both training datasets and any data used for ongoing operation.', 'Differentiate internally-curated data from third-party / open-source / synthetic.'],
    ['Datasheets or dataset cards.', 'Data lineage records.', 'Licence / consent records where relevant.']
  ),
  ctrl('A.4.4', 'c-resources', 35, 'Tooling resources',
    'Document the algorithms, models, frameworks, libraries, and provisioning tools the AI system depends on, including versions and known limitations.',
    ['Are the algorithms and frameworks used in each AI system documented?', 'Are versions tracked?', 'Are dependencies and licences recorded?'],
    ['Capture model architectures, frameworks (e.g., PyTorch), libraries, and ML tooling.', 'Record open-source dependencies and any commercial tooling licences.'],
    ['Software bill of materials (SBOM) for AI systems.', 'Tooling inventory and versioning.']
  ),
  ctrl('A.4.5', 'c-resources', 36, 'System and computing resources',
    'Document the computing, storage, and networking resources used by each AI system and the constraints they impose (capacity, latency, environmental footprint).',
    ['Are compute, storage, and hosting environments documented per AI system?', 'Are capacity constraints, performance characteristics, and environmental impact captured?'],
    ['Capture both training and inference environments.', 'Consider environmental footprint metrics (energy, carbon) for systems with significant compute usage.'],
    ['Compute/storage/network inventory linked to AI systems.', 'Environmental footprint records where relevant.']
  ),
  ctrl('A.4.6', 'c-resources', 37, 'Human resources',
    'Document the people involved across the AI lifecycle, their competences, and the dependencies on external human resources (vendors, data annotators).',
    ['Are people involved across the AI lifecycle identified (developers, reviewers, data annotators, operators, users)?', 'Are their competences and authorities documented?', 'Are external human dependencies (vendors, annotation services) captured?'],
    ['Cross-reference with the competence requirements from 7.2.', 'Capture both staff and outsourced human resources (annotators, reviewers).'],
    ['Skills matrices or role records.', 'Vendor records covering human-resource dependencies.']
  ),

  // A.5 Assessing impacts of AI systems (4)
  ctrl('A.5.2', 'd-impact-assessment', 38, 'AI system impact assessment process',
    'Establish a documented process for assessing potential impacts on individuals, groups, and society arising from the development, provision, or use of AI systems.',
    ['Has an impact assessment process been defined?', 'Does it cover individual, group, and societal impacts?', 'Are triggers defined (new system, change, periodic refresh)?'],
    ['Anchor in published frameworks (e.g., NIST AI RMF, EU AI Act FRIA, AIDA AIA).', 'Define proportionality so low-risk systems get a lighter-touch assessment.', 'Tie outputs to risk treatment.'],
    ['Documented impact assessment methodology.', 'Trigger criteria and proportionality rules.']
  ),
  ctrl('A.5.3', 'd-impact-assessment', 39, 'Documentation of AI system impact assessments',
    'Document the results of AI system impact assessments, including intended use, affected parties, potential adverse effects, mitigations, residual impacts, and approvals.',
    ['Are impact assessment results documented per AI system?', 'Do they cover intended use, potential adverse effects, mitigations, and residual impacts?', 'Are approvals recorded?'],
    ['Use a standard template to support comparability.', 'Capture explicit consideration of vulnerable groups.'],
    ['Impact assessment records per AI system.', 'Approval records.']
  ),
  ctrl('A.5.4', 'd-impact-assessment', 40, 'Assessing AI system impact on individuals or groups',
    'Assess the potential impacts on individuals or groups, including fairness, accountability, transparency, autonomy, safety, privacy, and effects on vulnerable populations.',
    ['Are impacts on individuals assessed (rights, autonomy, safety, privacy)?', 'Are impacts on groups assessed (fairness, discrimination, disproportionate harm)?', 'Are vulnerable groups explicitly considered?'],
    ['Use disaggregated evaluation across protected attributes where relevant.', 'Engage affected groups where practical.'],
    ['Documented analysis of effects on individuals and groups.', 'Records of stakeholder engagement where applicable.']
  ),
  ctrl('A.5.5', 'd-impact-assessment', 41, 'Assessing societal impacts of AI systems',
    'Assess the potential societal impacts of AI systems, including environmental, economic, democratic, health, cultural, and ethical consequences.',
    ['Are broader societal impacts considered (economic, environmental, democratic, cultural, ethical)?', 'Are negative externalities and second-order effects identified?', 'Are mitigations proposed where impacts are material?'],
    ['Use foresight techniques to surface second-order and longer-term impacts.', 'Engage external experts where the system has wide reach.'],
    ['Documented analysis of societal-level impacts.', 'Mitigation records where applicable.']
  ),

  // A.6 AI system life cycle (9)
  ctrl('A.6.1.2', 'e-lifecycle', 42, 'Objectives for responsible development of AI systems',
    'Define objectives for the responsible development of AI systems that articulate organizational commitments such as fairness, transparency, robustness, security, privacy, accountability, and safety.',
    ['Are responsible-development objectives defined?', 'Are they measurable where practicable?', 'Are they communicated to development teams?'],
    ['Translate principles into measurable requirements (e.g., fairness thresholds, documentation completeness).', 'Embed objectives into design reviews and acceptance criteria.'],
    ['Documented responsible-development objectives.', 'Linkage to design reviews and acceptance criteria.']
  ),
  ctrl('A.6.1.3', 'e-lifecycle', 43, 'Processes for responsible design and development of AI systems',
    'Define processes for the responsible design and development of AI systems covering lifecycle stages, testing, oversight, training-data rules, and approvals.',
    ['Are processes defined for AI design and development?', 'Do they include oversight, testing, and approval gates?', 'Are training-data rules embedded (provenance, consent, quality, bias checks)?'],
    ['Tie process gates to the impact assessment severity.', 'Require human review for high-impact systems before deployment.'],
    ['Documented AI development process.', 'Records of gate reviews and approvals.']
  ),
  ctrl('A.6.2.2', 'e-lifecycle', 44, 'AI system requirements and specification',
    'Capture functional and non-functional requirements for each AI system, including responsible-AI requirements (fairness, transparency, safety, privacy, security).',
    ['Are functional and non-functional requirements captured for each AI system?', 'Are responsible-AI requirements included?', 'Are requirements traceable to the impact assessment?'],
    ['Require explicit non-functional requirements for fairness, explainability, robustness, security, and privacy.', 'Tie requirements to test cases.'],
    ['Requirements documents per AI system.', 'Traceability matrix between requirements and tests.']
  ),
  ctrl('A.6.2.3', 'e-lifecycle', 45, 'Documentation of AI system design and development',
    'Document AI system design and development decisions to support audit, change management, and continued maintenance.',
    ['Are design decisions documented (architecture, model choice, hyperparameters)?', 'Are deviations from requirements documented and approved?', 'Are decisions traceable across the lifecycle?'],
    ['Use model cards alongside design documents.', 'Record rationale for trade-offs (e.g., accuracy vs interpretability).'],
    ['Design documents and model cards.', 'Decision logs.']
  ),
  ctrl('A.6.2.4', 'e-lifecycle', 46, 'AI system verification and validation',
    'Define and apply verification (built right) and validation (built the right thing) approaches, including testing methodologies, datasets, and acceptance thresholds.',
    ['Are verification and validation methods defined per AI system?', 'Do tests cover functional, performance, fairness, robustness, and security?', 'Are acceptance thresholds defined and approved?'],
    ['Maintain hold-out and adversarial test sets.', 'Re-validate after significant changes (retraining, dataset changes).', 'Cover edge cases and known failure modes.'],
    ['Test plans and results.', 'Acceptance criteria and sign-off records.']
  ),
  ctrl('A.6.2.5', 'e-lifecycle', 47, 'AI system deployment',
    'Define release criteria, deployment plans, and rollback procedures for each AI system.',
    ['Are release criteria defined and applied before deployment?', 'Do plans cover rollback and contingencies?', 'Are approvals recorded?'],
    ['Use staged rollouts (e.g., shadow, canary) for high-impact systems.', 'Record the deployment context (model version, dataset version, infrastructure).'],
    ['Deployment plans, release notes, and approval records.', 'Rollback procedure and tests.']
  ),
  ctrl('A.6.2.6', 'e-lifecycle', 48, 'AI system operation and monitoring',
    'Define and apply operation and monitoring controls covering performance, drift, fairness, security events, and human oversight.',
    ['Are performance, drift, and fairness monitored continuously?', 'Are alert thresholds defined?', 'Is human oversight in place where appropriate?'],
    ['Monitor for data drift, concept drift, and fairness metric drift.', 'Define when alerts trigger retraining, suspension, or human review.', 'Periodically validate human oversight remains effective.'],
    ['Monitoring dashboards and alerts.', 'Operations runbook for AI systems.', 'Records of human-oversight decisions.']
  ),
  ctrl('A.6.2.7', 'e-lifecycle', 49, 'AI system technical documentation',
    'Provide technical documentation suitable for the audiences that need it (developers, deployers, users, partners, auditors, regulators).',
    ['Is technical documentation produced for each AI system?', 'Is it tailored to the audience (developer, deployer, user, auditor)?', 'Is it maintained over the system\'s life?'],
    ['Use layered documentation (model card for high-level users, technical report for auditors).', 'Update on each material change.'],
    ['Model cards, technical reports, deployment guides.', 'Records of document maintenance.']
  ),
  ctrl('A.6.2.8', 'e-lifecycle', 50, 'AI system recording of event logs',
    'Determine which events the AI system records to support audit, incident response, drift detection, and accountability.',
    ['Are event types to log defined per AI system (inputs, outputs, decisions, overrides, errors)?', 'Are retention and protection requirements defined?', 'Is access to logs controlled?'],
    ['Balance auditability with privacy (avoid logging sensitive inputs unnecessarily).', 'Use append-only or tamper-evident logging for high-impact systems.', 'Coordinate with the organization\'s broader logging and SIEM controls.'],
    ['Event logging specification per AI system.', 'Examples of retained logs (suitably redacted).']
  ),

  // A.7 Data for AI systems (5)
  ctrl('A.7.2', 'f-data', 51, 'Data for development and enhancement of AI system',
    'Define data-management processes that address privacy, security, representativeness, accuracy, and integrity of data used in AI systems.',
    ['Are data-management processes defined for AI development and enhancement?', 'Do they cover privacy, security, representativeness, and quality?', 'Are responsibilities for data activities assigned?'],
    ['Integrate with existing data governance (where present).', 'Cover both training and operational data.'],
    ['Data management procedure for AI.', 'Records of process execution per AI system.']
  ),
  ctrl('A.7.3', 'f-data', 52, 'Acquisition of data',
    'Document where each dataset comes from, how it was selected, and any consent, licensing, biases, or rights affecting its use.',
    ['Is the provenance of each dataset documented?', 'Are licensing, consent, and rights captured?', 'Are biases and limitations recorded?'],
    ['Distinguish first-party, third-party, open-source, scraped, and synthetic data.', 'Verify legal basis for use (e.g., consent, contract, public interest).'],
    ['Dataset acquisition records.', 'Licence / consent records.']
  ),
  ctrl('A.7.4', 'f-data', 53, 'Quality of data for AI systems',
    'Set explicit data-quality criteria (accuracy, completeness, currency, representativeness, consistency) and verify them.',
    ['Are quality criteria defined for AI datasets?', 'Are they checked at acquisition and periodically thereafter?', 'Are remediation actions taken for quality issues?'],
    ['Define criteria proportional to the impact of the AI system.', 'Use automated checks where possible.'],
    ['Data quality criteria.', 'Quality check results and remediation records.']
  ),
  ctrl('A.7.5', 'f-data', 54, 'Data provenance',
    'Track dataset origins and transformations across both data and AI system lifecycles to support audit, reproduction, and accountability.',
    ['Are dataset origins and transformations tracked?', 'Can the lineage of an AI system\'s training data be reconstructed?', 'Are transformations (cleaning, labelling, augmentation) documented?'],
    ['Use lineage tooling where the volume of data justifies it.', 'Record dataset versions used by each model version.'],
    ['Data lineage records.', 'Linkage between dataset versions and model versions.']
  ),
  ctrl('A.7.6', 'f-data', 55, 'Data preparation',
    'Define acceptable data-preparation techniques (cleaning, labelling, augmentation, anonymisation) and the rationale for methods selected.',
    ['Are data-preparation techniques defined and approved?', 'Are method choices justified (e.g., why a particular augmentation, anonymisation method, or labelling protocol)?', 'Is the impact of preparation on representativeness and fairness considered?'],
    ['Document labelling protocols and inter-annotator agreement.', 'Validate anonymisation against re-identification risks.', 'Track the effect of preparation steps on fairness metrics.'],
    ['Data preparation procedures.', 'Records of preparation choices per dataset.']
  ),

  // A.8 Information for interested parties (4)
  ctrl('A.8.2', 'g-information', 56, 'System documentation and information for users',
    'Provide plain-language information to users covering capabilities, limits, failure modes, and oversight options of the AI system.',
    ['Is user-facing documentation produced for each AI system?', 'Does it cover capabilities, limits, failure modes, and oversight options?', 'Is it written in plain language?'],
    ['Tailor to the user audience (technical vs general).', 'Cover prohibited or out-of-scope uses.', 'Provide channels for user feedback.'],
    ['User-facing documentation per AI system.', 'Records of feedback received.']
  ),
  ctrl('A.8.3', 'g-information', 57, 'External reporting',
    'Establish a mechanism for affected parties to report problems with AI systems and provide a route for resolution.',
    ['Is there a documented channel for affected parties to report problems?', 'Are timelines and ownership for resolution defined?', 'Are reports analysed for systemic issues?'],
    ['Make the channel discoverable (linked from products that use AI, public web).', 'Track reports as a feedback loop into the AIMS.'],
    ['Reporting channel documentation.', 'Records of reports received, triaged, and resolved.']
  ),
  ctrl('A.8.4', 'g-information', 58, 'Communication of incidents',
    'Plan in advance the communication of AI-related incidents to interested parties, aligned with regulatory and contractual obligations.',
    ['Are AI-incident communication procedures defined?', 'Are notification thresholds and timelines aligned with regulator and contract obligations?', 'Are templates pre-approved?'],
    ['Coordinate with overall incident management (ISO 27001 / business continuity).', 'Identify which incidents must be reported externally.'],
    ['Incident communication plan.', 'Notification templates.', 'Records of past incident communications.']
  ),
  ctrl('A.8.5', 'g-information', 59, 'Information for interested parties',
    'Decide what information to share proactively with interested parties (customers, regulators, partners, the public) about the organization\'s AI activities.',
    ['What proactive information is provided to interested parties (transparency reports, AI registers, model cards)?', 'Is the level of disclosure appropriate to the audience and risk?', 'Is provided information kept current?'],
    ['Use transparency to build trust without disclosing security-sensitive details.', 'Differentiate disclosures by audience (regulators, customers, public).'],
    ['Published information (e.g., public AI register, transparency reports).', 'Records of disclosures to regulators or partners.']
  ),

  // A.9 Use of AI systems (3)
  ctrl('A.9.2', 'h-use', 60, 'Processes for responsible use of AI systems',
    'Define processes for the responsible use of AI systems in operation, including oversight, escalation, and acceptable-use boundaries.',
    ['Are responsible-use processes defined for each AI system in operation?', 'Do they include oversight and escalation paths?', 'Are acceptable-use boundaries documented?'],
    ['Define when users may override or must defer to AI outputs.', 'Identify circumstances where the AI must be turned off (degraded performance, safety, ethical concerns).'],
    ['Responsible-use procedures per AI system.', 'Records of overrides and escalations.']
  ),
  ctrl('A.9.3', 'h-use', 61, 'Objectives for responsible use of AI systems',
    'Define operational objectives for responsible use, providing reference points users and operators can apply.',
    ['Are responsible-use objectives defined?', 'Are they measurable where practicable?', 'Are they communicated to users and operators?'],
    ['Translate principles into operational targets (e.g., minimum review rate, acceptable error rate).'],
    ['Documented responsible-use objectives.', 'Communication and acknowledgement records.']
  ),
  ctrl('A.9.4', 'h-use', 62, 'Intended use of the AI system',
    'Control the use of each AI system to its intended use, prevent scope creep, and review when repurposing is proposed.',
    ['Is the intended use of each AI system documented?', 'Are uses outside intent prohibited?', 'Are proposed expansions of use subject to fresh impact assessment?'],
    ['Capture intended use in deployment plans and user-facing documentation.', 'Treat any new use case as a change subject to 6.3 and re-assessment.'],
    ['Intended-use statements per AI system.', 'Records of any reuse / repurpose approvals.']
  ),

  // A.10 Third-party and customer relationships (3)
  ctrl('A.10.2', 'i-third-party', 63, 'Allocation of responsibilities',
    'Allocate responsibilities along the AI supply chain (providers, developers, deployers, customers) and make these explicit in agreements.',
    ['Are responsibilities allocated across the AI supply chain?', 'Are they documented in contracts or agreements?', 'Are they reviewed when the relationship changes?'],
    ['Use the role definitions from Clause 4.1 to drive allocations.', 'Cover liability, monitoring obligations, incident reporting, and impact-assessment cooperation.'],
    ['Contracts and agreements with AI-specific clauses.', 'Responsibility matrices spanning organizations.']
  ),
  ctrl('A.10.3', 'i-third-party', 64, 'Suppliers',
    'Manage suppliers of AI systems, services, components, and data against responsible-AI expectations, including due diligence and ongoing oversight.',
    ['Are suppliers of AI services, models, and data identified?', 'Are responsible-AI requirements built into selection and contracting?', 'Is ongoing oversight performed?'],
    ['Tier suppliers by risk to set proportional diligence.', 'Require evidence (model cards, datasheets, evaluation reports) at onboarding.', 'Monitor changes communicated by suppliers (e.g., model updates).'],
    ['Supplier register including AI dependencies.', 'Due-diligence and assurance records.', 'Ongoing monitoring records.']
  ),
  ctrl('A.10.4', 'i-third-party', 65, 'Customers',
    'Factor obligations to and duty of care toward customers into responsible-AI practices, including transparency, support, and protection from foreseeable misuse.',
    ['Are customer-facing obligations identified (transparency, support, complaints handling, duty of care)?', 'Are foreseeable misuses considered and mitigated?', 'Is customer feedback used to improve AI systems?'],
    ['Provide customers with the documentation they need to use AI responsibly (model cards, intended use, prohibited use).', 'Track and respond to customer feedback on AI behaviour.'],
    ['Customer-facing AI documentation.', 'Customer feedback / complaint records.', 'Action records from customer feedback.']
  ),
];
