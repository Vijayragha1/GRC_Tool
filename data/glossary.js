// Exhaustive glossary for ISO 27001:2022, GRC, and information-security work.
// Each entry: slug, term, aliases, category, plain, definition, example,
// related (slugs), notToConfuseWith ([{term, why}]), clauseRef.
//
// Categories shown in the UI:
//   governance, risk, controls, documents, audit, improvement,
//   people, operations, technical, compliance, certification

const CATEGORIES = [
  { key: 'governance',    label: 'Governance & Management' },
  { key: 'risk',          label: 'Risk Management' },
  { key: 'controls',      label: 'Controls & Annex A' },
  { key: 'documents',     label: 'Documents & Records' },
  { key: 'audit',         label: 'Audit & Assurance' },
  { key: 'improvement',   label: 'Improvement' },
  { key: 'people',        label: 'People & Awareness' },
  { key: 'operations',    label: 'Operations & Resilience' },
  { key: 'technical',     label: 'Technical Security' },
  { key: 'compliance',    label: 'Compliance & Privacy' },
  { key: 'certification', label: 'Certification & Accreditation' }
];

const ENTRIES = [
  // ============================================================
  // GOVERNANCE & MANAGEMENT
  // ============================================================
  {
    slug: 'isms',
    term: 'Information Security Management System',
    aliases: ['ISMS'],
    category: 'governance',
    plain: 'A structured way of managing how an organisation protects its information.',
    definition: 'A documented framework of policies, procedures, processes, and controls used to systematically manage and continually improve information-security risks. The ISMS is what ISO 27001 certifies — not the company, not the product.',
    example: 'Acme HealthTech\'s ISMS covers their patient portal, dev pipeline, and HQ office. It includes an information-security policy, an annual risk assessment, a Statement of Applicability, an internal audit programme, and a documented management review.',
    related: ['scope', 'soa', 'risk-assessment', 'management-review', 'iso-27001'],
    notToConfuseWith: [
      { term: 'IT Service Management (ITSM)', why: 'ITSM (e.g., ITIL) is about delivering IT services well. An ISMS is about protecting information. They overlap on operational hygiene but the goal differs.' }
    ],
    clauseRef: 'Clause 4.4'
  },
  {
    slug: 'iso-27001',
    term: 'ISO/IEC 27001',
    aliases: ['ISO 27001', '27001'],
    category: 'governance',
    plain: 'The international standard that says how to build an ISMS.',
    definition: 'ISO/IEC 27001:2022 specifies requirements for establishing, implementing, maintaining, and continually improving an information-security management system. Clauses 4–10 are mandatory. Annex A lists 93 reference controls.',
    example: 'A certification audit checks whether your ISMS meets every "shall" in clauses 4–10 of ISO 27001:2022.',
    related: ['iso-27002', 'annex-a', 'isms'],
    notToConfuseWith: [
      { term: 'ISO 27002', why: '27001 is the certifiable management-system standard (the requirements). 27002 is the implementation guidance for the controls in Annex A.' }
    ],
    clauseRef: null
  },
  {
    slug: 'iso-27002',
    term: 'ISO/IEC 27002',
    aliases: ['ISO 27002', '27002'],
    category: 'governance',
    plain: 'A guidebook explaining how to implement each Annex A control.',
    definition: 'A code-of-practice companion to ISO 27001 that gives detailed implementation guidance for each of the 93 information-security controls. Not certifiable on its own.',
    example: 'When deciding how to implement A.5.15 Access Control, your team reads the corresponding ISO 27002 section for accepted practice.',
    related: ['annex-a', 'iso-27001'],
    notToConfuseWith: [
      { term: 'ISO 27001', why: 'You certify against 27001. 27002 is supporting guidance — auditors don\'t mark you against 27002.' }
    ],
    clauseRef: null
  },
  {
    slug: 'annex-a',
    term: 'Annex A',
    aliases: [],
    category: 'governance',
    plain: 'The list of 93 reference security controls in ISO 27001:2022.',
    definition: 'A normative annex of ISO 27001 listing 93 information-security controls grouped into 4 themes (Organizational, People, Physical, Technological). You must consider every Annex A control in your Statement of Applicability and justify inclusion or exclusion.',
    example: 'A.8.24 Use of cryptography is one of the 93 Annex A controls. If you exclude it, you must justify why in the SoA.',
    related: ['soa', 'control', 'iso-27002'],
    notToConfuseWith: [
      { term: 'Mandatory clauses (4–10)', why: 'Clauses 4–10 are absolute requirements. Annex A controls are reference — you must consider them, but you can exclude with justification.' }
    ],
    clauseRef: 'Annex A'
  },
  {
    slug: 'iso-27000-family',
    term: 'ISO 27000 Family',
    aliases: ['27000 series'],
    category: 'governance',
    plain: 'The family of related standards around information security.',
    definition: 'A family of standards published by ISO/IEC sharing the 27000 prefix. Includes 27001 (requirements), 27002 (controls guidance), 27005 (risk management), 27017 (cloud), 27018 (PII in cloud), 27701 (privacy extension), among others.',
    example: 'A SaaS company certified to 27001 may also adopt 27017 and 27018 for cloud-specific guidance.',
    related: ['iso-27001', 'iso-27002'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'information-security',
    term: 'Information Security',
    aliases: ['InfoSec'],
    category: 'governance',
    plain: 'Protecting information from being read, changed, or lost without permission.',
    definition: 'The preservation of confidentiality, integrity, and availability of information. Covers people, process, and technology — not just IT.',
    example: 'Locking a filing cabinet of HR records is information security, just as encrypting a database is.',
    related: ['cia-triad', 'confidentiality', 'integrity', 'availability'],
    notToConfuseWith: [
      { term: 'Cybersecurity', why: 'Cybersecurity is the digital subset of information security. A paper file leak is an information-security failure but not a cybersecurity one.' }
    ],
    clauseRef: null
  },
  {
    slug: 'cia-triad',
    term: 'CIA Triad',
    aliases: [],
    category: 'governance',
    plain: 'The three core goals of information security: Confidentiality, Integrity, Availability.',
    definition: 'A foundational model stating that information security must preserve confidentiality (only authorised people can read it), integrity (it can\'t be altered without authority), and availability (authorised users can access it when needed).',
    example: 'A ransomware attack typically violates availability (files locked) and may violate confidentiality (data exfiltrated).',
    related: ['confidentiality', 'integrity', 'availability'],
    notToConfuseWith: [
      { term: 'CIA (the agency)', why: 'In ISO 27001 contexts, CIA almost always means the triad, not the US agency.' }
    ],
    clauseRef: null
  },
  {
    slug: 'confidentiality',
    term: 'Confidentiality',
    aliases: [],
    category: 'governance',
    plain: 'Information is only seen by people allowed to see it.',
    definition: 'The property that information is not made available or disclosed to unauthorised individuals, entities, or processes.',
    example: 'Encrypting customer PII at rest protects confidentiality even if a backup tape is lost.',
    related: ['cia-triad', 'integrity', 'availability', 'access-control'],
    notToConfuseWith: [
      { term: 'Privacy', why: 'Confidentiality is about protecting data from unauthorised access. Privacy adds a legal/ethical lens about an individual\'s right to control their personal data.' }
    ],
    clauseRef: null
  },
  {
    slug: 'integrity',
    term: 'Integrity',
    aliases: [],
    category: 'governance',
    plain: 'Information is accurate and hasn\'t been tampered with.',
    definition: 'The property of safeguarding the accuracy and completeness of information and processing methods.',
    example: 'Cryptographic hashes on log files detect if anyone has modified them after the fact.',
    related: ['cia-triad', 'hashing'],
    notToConfuseWith: [
      { term: 'Authenticity', why: 'Authenticity is about who created/sent something. Integrity is about whether it has been altered. They\'re related but distinct.' }
    ],
    clauseRef: null
  },
  {
    slug: 'availability',
    term: 'Availability',
    aliases: [],
    category: 'governance',
    plain: 'Authorised users can get to information when they need it.',
    definition: 'The property of being accessible and usable on demand by an authorised entity.',
    example: 'Multi-region failover for the production database is an availability control.',
    related: ['cia-triad', 'business-continuity', 'rto', 'rpo'],
    notToConfuseWith: [
      { term: 'Reliability', why: 'Availability is about access when needed; reliability is about correct functioning over time. A reliable but offline system has 0% availability.' }
    ],
    clauseRef: null
  },
  {
    slug: 'scope',
    term: 'Scope (of the ISMS)',
    aliases: ['ISMS scope', 'scope statement'],
    category: 'governance',
    plain: 'The boundary of what your ISMS covers — what\'s in, what\'s out, why.',
    definition: 'A documented statement defining the organisational, technological, geographic, and product/service boundaries of the ISMS. Required by clause 4.3. Must consider context (4.1) and interested parties (4.2). Must explicitly address interfaces with anything excluded.',
    example: '"The ISMS covers the SaaS HR-tech platform, the engineering organisation, and the London HQ. The Tokyo office and the consulting subsidiary are excluded; their interfaces are managed via the supplier register."',
    related: ['context', 'interested-parties', 'soa', 'isms'],
    notToConfuseWith: [
      { term: 'Statement of Applicability (SoA)', why: 'Scope defines the boundary of the ISMS. SoA defines which Annex A controls apply within that boundary. Different documents.' }
    ],
    clauseRef: 'Clause 4.3'
  },
  {
    slug: 'context',
    term: 'Context of the Organization',
    aliases: ['organisational context', 'internal/external issues'],
    category: 'governance',
    plain: 'The big-picture factors — what the org does, the market it operates in, regulations, threats.',
    definition: 'The internal and external issues relevant to the organisation\'s purpose that affect its ability to achieve the intended outcomes of the ISMS. Required by clause 4.1.',
    example: 'External issues: GDPR, NIS2, threat landscape, competitor breaches. Internal issues: rapid headcount growth, distributed engineering, legacy on-prem dependency.',
    related: ['scope', 'interested-parties'],
    notToConfuseWith: [],
    clauseRef: 'Clause 4.1'
  },
  {
    slug: 'interested-parties',
    term: 'Interested Parties',
    aliases: ['stakeholders'],
    category: 'governance',
    plain: 'People and organisations who care about your information security.',
    definition: 'Persons or organisations that can affect, be affected by, or perceive themselves to be affected by the ISMS. ISO 27001 requires you to identify them and their relevant requirements (clause 4.2).',
    example: 'Customers (contractual security obligations), regulators (GDPR, sector rules), employees (privacy of HR data), investors (risk posture), suppliers, certification body.',
    related: ['context', 'scope'],
    notToConfuseWith: [],
    clauseRef: 'Clause 4.2'
  },
  {
    slug: 'top-management',
    term: 'Top Management',
    aliases: ['executive management', 'leadership'],
    category: 'governance',
    plain: 'The people who can commit the organisation — usually C-suite or equivalent.',
    definition: 'The person or group who directs and controls the organisation at the highest level within the ISMS scope. They have specific obligations under clause 5: leadership, policy approval, resourcing, communication.',
    example: 'For an SME this might be the CEO and CFO. For a multinational it might be a regional executive committee for the in-scope entity.',
    related: ['leadership', 'information-security-policy', 'management-review'],
    notToConfuseWith: [
      { term: 'CISO / Security team', why: 'The CISO leads security operationally. Top management owns the ISMS strategically — auditors will want evidence the CEO/board, not just the CISO, is committed.' }
    ],
    clauseRef: 'Clause 5.1'
  },
  {
    slug: 'leadership',
    term: 'Leadership Commitment',
    aliases: [],
    category: 'governance',
    plain: 'Visible, documented backing of the ISMS by top management.',
    definition: 'The set of obligations clause 5.1 places on top management — ensuring the policy and objectives are established, integrating ISMS requirements into business processes, providing resources, communicating importance, and supporting continual improvement.',
    example: 'Evidence: signed ISMS policy, board minutes referencing security, allocation of budget for the security function, CEO communications about security culture.',
    related: ['top-management', 'information-security-policy'],
    notToConfuseWith: [],
    clauseRef: 'Clause 5.1'
  },
  {
    slug: 'information-security-policy',
    term: 'Information Security Policy',
    aliases: ['ISP', 'top-level policy'],
    category: 'governance',
    plain: 'The boss-signed document saying the organisation takes security seriously and how.',
    definition: 'A high-level documented statement of intent and direction issued by top management. Must establish the framework for security objectives, reflect the organisation\'s context, and commit to satisfying applicable requirements and continual improvement.',
    example: 'A 2-page CEO-signed policy referencing the ISMS scope, naming the security objectives, and committing to risk-based control selection. Supporting topic-specific policies sit beneath it.',
    related: ['policy', 'top-management', 'leadership'],
    notToConfuseWith: [
      { term: 'Topic-specific policies', why: 'The ISP is the umbrella. Topic-specific policies (Access Control Policy, Acceptable Use, etc.) implement it.' }
    ],
    clauseRef: 'Clause 5.2'
  },
  {
    slug: 'policy',
    term: 'Policy',
    aliases: [],
    category: 'documents',
    plain: 'A statement of what the organisation will or won\'t do.',
    definition: 'A formal high-level statement of intent and rules that govern behaviour. Policies are mandatory within their scope and approved by management.',
    example: '"All laptops issued by the company must have full-disk encryption enabled."',
    related: ['standard', 'procedure', 'guideline'],
    notToConfuseWith: [
      { term: 'Procedure', why: 'A policy says "what" and "why". A procedure says "how" — the step-by-step.' }
    ],
    clauseRef: null
  },
  {
    slug: 'standard',
    term: 'Standard',
    aliases: [],
    category: 'documents',
    plain: 'The specific technical or operational rules that satisfy a policy.',
    definition: 'A mandatory specification of what must be done to comply with a policy. More detailed than a policy; less prescriptive than a procedure.',
    example: 'Policy: "Production access must be controlled." Standard: "Production SSH must require MFA, key length ≥ 4096 bits, and key rotation every 12 months."',
    related: ['policy', 'procedure'],
    notToConfuseWith: [
      { term: 'Standard (ISO 27001)', why: 'In governance, "standard" is an internal mandatory rule. ISO/IEC standards (the documents) are external.' }
    ],
    clauseRef: null
  },
  {
    slug: 'procedure',
    term: 'Procedure',
    aliases: ['SOP'],
    category: 'documents',
    plain: 'The step-by-step instructions for doing something.',
    definition: 'A documented sequence of actions describing how to perform an activity. Operational; can be followed by someone newly assigned to the task.',
    example: '"User Onboarding Procedure: 1. Manager raises ticket. 2. IT creates accounts in Okta + Google Workspace. 3. IT issues laptop with build profile X. 4. Manager confirms first-day access. 5. Ticket closes."',
    related: ['policy', 'standard', 'guideline'],
    notToConfuseWith: [
      { term: 'Process', why: 'A process is the broader sequence of activities (often cross-team). A procedure is a single set of steps within it.' }
    ],
    clauseRef: null
  },
  {
    slug: 'guideline',
    term: 'Guideline',
    aliases: [],
    category: 'documents',
    plain: 'Recommended (not mandatory) advice on how to do something well.',
    definition: 'Non-mandatory recommendations that provide flexible direction, often for situations where rigid rules are impractical.',
    example: '"Recommended approach for evaluating a new SaaS vendor before raising a procurement request."',
    related: ['policy', 'standard', 'procedure'],
    notToConfuseWith: [
      { term: 'Standard', why: 'Standards are mandatory. Guidelines are advisory.' }
    ],
    clauseRef: null
  },
  {
    slug: 'roles-responsibilities',
    term: 'Roles and Responsibilities',
    aliases: ['R&R'],
    category: 'governance',
    plain: 'Who does what for security.',
    definition: 'The documented assignment of information-security duties to specific roles. ISO 27001 clause 5.3 requires top management to assign and communicate these. Often shown as a RACI matrix or in role descriptions.',
    example: '"Risk Owner: VP of Engineering. Asset Owner (production database): Head of Platform. Document Owner (Access Control Policy): CISO."',
    related: ['raci', 'segregation-of-duties', 'top-management'],
    notToConfuseWith: [],
    clauseRef: 'Clause 5.3'
  },
  {
    slug: 'raci',
    term: 'RACI Matrix',
    aliases: ['RACI'],
    category: 'governance',
    plain: 'A grid showing who is Responsible, Accountable, Consulted, and Informed for each task.',
    definition: 'Responsibility-assignment matrix where each task has exactly one Accountable owner, one or more Responsible doers, plus people Consulted (two-way) and Informed (one-way).',
    example: 'Quarterly access review — Accountable: CISO. Responsible: IT Operations. Consulted: HR, Engineering managers. Informed: Internal Audit.',
    related: ['roles-responsibilities'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'segregation-of-duties',
    term: 'Segregation of Duties',
    aliases: ['SoD', 'separation of duties'],
    category: 'governance',
    plain: 'No single person can both perform and approve a sensitive action.',
    definition: 'A control principle that splits high-risk activities across roles so that fraud, error, or abuse requires collusion. Annex A control 5.3.',
    example: 'The developer who writes a payment-processing change cannot also approve and deploy it to production.',
    related: ['least-privilege', 'access-control'],
    notToConfuseWith: [],
    clauseRef: 'A.5.3'
  },
  {
    slug: 'objectives',
    term: 'Information Security Objectives',
    aliases: ['security objectives'],
    category: 'governance',
    plain: 'Measurable security goals the organisation commits to achieve.',
    definition: 'Specific, measurable, time-bound targets aligned with the information-security policy. Must be communicated, monitored, and documented (clause 6.2).',
    example: '"Reduce mean time to patch critical vulnerabilities from 14 to 7 days by 2026-Q3." Owner: VP Engineering. Measurement: monthly patching report.',
    related: ['kpi', 'measurement', 'management-review'],
    notToConfuseWith: [
      { term: 'Control objectives', why: 'Security objectives are organisation-wide goals (clause 6.2). Control objectives describe what an individual control aims to achieve.' }
    ],
    clauseRef: 'Clause 6.2'
  },
  {
    slug: 'soa',
    term: 'Statement of Applicability',
    aliases: ['SoA'],
    category: 'governance',
    plain: 'A list of all 93 Annex A controls saying which apply, why, and which are skipped — and why.',
    definition: 'A mandatory documented record of all Annex A controls, declaring inclusion or exclusion, the justification, the implementation status, and reference to risks treated. Required by clause 6.1.3.d.',
    example: 'A.8.24 Use of cryptography — Included; justification: protects confidentiality of customer PII (treats risk R-12, R-15); status: Implemented.',
    related: ['annex-a', 'risk-treatment', 'inclusion-justification', 'exclusion-justification'],
    notToConfuseWith: [
      { term: 'Risk Treatment Plan', why: 'The SoA says "which controls apply". The RTP says "what we will do, by when, owned by whom". Different deliverables but linked.' }
    ],
    clauseRef: 'Clause 6.1.3.d'
  },

  // ============================================================
  // RISK MANAGEMENT
  // ============================================================
  {
    slug: 'risk',
    term: 'Risk',
    aliases: [],
    category: 'risk',
    plain: 'The chance that something bad happens to your information.',
    definition: 'The effect of uncertainty on objectives — in security terms, the potential for a threat to exploit a vulnerability and cause harm to an asset, expressed as the combination of likelihood and impact.',
    example: '"A phishing attack succeeds against the finance team and results in a fraudulent wire transfer." Likelihood: medium; Impact: high.',
    related: ['threat', 'vulnerability', 'asset', 'likelihood', 'impact'],
    notToConfuseWith: [
      { term: 'Threat', why: 'A threat is the potential cause of harm (e.g., a phishing actor). A risk is the combination of threat + vulnerability + asset + impact.' },
      { term: 'Issue', why: 'An issue is a problem that has already occurred. A risk is something that might happen.' }
    ],
    clauseRef: 'Clause 6.1.2, 8.2'
  },
  {
    slug: 'threat',
    term: 'Threat',
    aliases: [],
    category: 'risk',
    plain: 'Anything that could cause harm — a hacker, a flood, a careless employee.',
    definition: 'The potential cause of an unwanted incident that may result in harm to a system or organisation. Threats can be natural, accidental, or deliberate.',
    example: 'Threat actors: ransomware groups, insiders, nation-states. Threat events: phishing, DDoS, fire, disk failure.',
    related: ['vulnerability', 'risk', 'threat-actor'],
    notToConfuseWith: [
      { term: 'Vulnerability', why: 'A threat is the source of harm. A vulnerability is the weakness the threat exploits. Both must be present for risk.' }
    ],
    clauseRef: null
  },
  {
    slug: 'vulnerability',
    term: 'Vulnerability',
    aliases: [],
    category: 'risk',
    plain: 'A weakness that can be exploited.',
    definition: 'A weakness in an asset, control, or process that could be exploited by a threat. Can be technical (an unpatched CVE), procedural (no leaver process), or environmental (unsecured server room).',
    example: 'CVE-2024-XXXX in your reverse proxy is a technical vulnerability. Lack of MFA on a privileged account is a control vulnerability.',
    related: ['threat', 'risk', 'patch-management', 'vulnerability-management'],
    notToConfuseWith: [
      { term: 'Risk', why: 'A vulnerability alone isn\'t a risk. It becomes a risk when paired with a threat that can exploit it and an asset of value.' }
    ],
    clauseRef: null
  },
  {
    slug: 'threat-actor',
    term: 'Threat Actor',
    aliases: ['adversary'],
    category: 'risk',
    plain: 'The person or group behind a threat.',
    definition: 'An individual, group, or entity that intends to cause harm or that does cause harm. Categorised by motivation (financial, political, ideological), capability, and access.',
    example: 'Common threat actors: cybercriminal gangs, nation-state APTs, hacktivists, malicious insiders, careless insiders.',
    related: ['threat', 'risk'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'asset',
    term: 'Asset',
    aliases: [],
    category: 'risk',
    plain: 'Something of value to the organisation that needs protection.',
    definition: 'Anything of value to the organisation: information, software, hardware, services, people, intangibles (reputation, IP). In ISO 27001, the focus is information and the systems that process it.',
    example: 'Customer database; production Kubernetes cluster; HR file share; contracts with regulators; the company brand.',
    related: ['information-asset', 'asset-owner', 'asset-inventory'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'information-asset',
    term: 'Information Asset',
    aliases: [],
    category: 'risk',
    plain: 'A specific set of information that has value.',
    definition: 'A logical grouping of information of value to the organisation, distinct from the systems that process it. Identifying information assets (rather than just systems) helps focus risk on what really matters.',
    example: 'Customer PII, source code, financial records, employee records, vendor contracts.',
    related: ['asset', 'data-classification'],
    notToConfuseWith: [
      { term: 'IT asset (CMDB asset)', why: 'IT assets are the systems and devices. Information assets are the data they hold.' }
    ],
    clauseRef: null
  },
  {
    slug: 'asset-owner',
    term: 'Asset Owner',
    aliases: [],
    category: 'risk',
    plain: 'The person accountable for a specific asset.',
    definition: 'The individual or role accountable for the appropriate classification, protection, and use of an asset throughout its lifecycle. Required by Annex A 5.9.',
    example: 'The Head of Engineering owns the production Kubernetes cluster. The Head of People owns the HRIS.',
    related: ['risk-owner', 'data-owner', 'asset-inventory'],
    notToConfuseWith: [
      { term: 'Risk Owner', why: 'Asset owners are accountable for the asset. Risk owners are accountable for treating risks. Often the same person, but conceptually distinct.' }
    ],
    clauseRef: 'A.5.9'
  },
  {
    slug: 'risk-owner',
    term: 'Risk Owner',
    aliases: [],
    category: 'risk',
    plain: 'The person accountable for managing a specific risk.',
    definition: 'A person with the authority and accountability to manage a particular risk. They approve the treatment, accept residual risk, and are answerable for the risk\'s outcome.',
    example: 'Risk: "Outage of payment provider causes revenue loss." Risk owner: VP of Operations.',
    related: ['asset-owner', 'risk-acceptance', 'risk-treatment'],
    notToConfuseWith: [
      { term: 'Asset Owner', why: 'Risk owners own the risk decision. Asset owners own the underlying asset. The risk owner often delegates implementation to the asset owner.' }
    ],
    clauseRef: 'Clause 6.1.2.c.2'
  },
  {
    slug: 'risk-assessment',
    term: 'Risk Assessment',
    aliases: [],
    category: 'risk',
    plain: 'The full activity of finding, analysing, and rating risks.',
    definition: 'The overall process of risk identification, risk analysis, and risk evaluation. Required by clause 6.1.2 and operationally executed per clause 8.2.',
    example: 'Quarterly: workshop with engineering, product, and ops to identify new risks; rate each by likelihood and impact; compare against criteria; feed prioritised list into the risk treatment plan.',
    related: ['risk-identification', 'risk-analysis', 'risk-evaluation', 'risk-criteria'],
    notToConfuseWith: [
      { term: 'Risk treatment', why: 'Risk assessment finds and rates risks. Risk treatment decides what to do about them.' }
    ],
    clauseRef: 'Clauses 6.1.2, 8.2'
  },
  {
    slug: 'risk-identification',
    term: 'Risk Identification',
    aliases: [],
    category: 'risk',
    plain: 'Finding risks — what could go wrong?',
    definition: 'The process of finding, recognising, and describing risks: identifying sources, events, causes, and potential consequences.',
    example: 'Workshop output: 47 candidate risks across "supplier failure", "phishing", "insider misuse", "DDoS", "cloud config drift", etc.',
    related: ['risk-assessment', 'risk-analysis'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'risk-analysis',
    term: 'Risk Analysis',
    aliases: [],
    category: 'risk',
    plain: 'Working out how likely a risk is and how bad it would be.',
    definition: 'The process of comprehending the nature of risk and determining its level — typically by estimating likelihood and consequence (impact) and combining them into a risk score.',
    example: 'Ransomware risk: likelihood 3/5 (industry baseline), impact 5/5 (would halt revenue for days). Score 15.',
    related: ['likelihood', 'impact', 'risk-score'],
    notToConfuseWith: [
      { term: 'Risk evaluation', why: 'Analysis produces the score. Evaluation compares it against criteria to decide what to do.' }
    ],
    clauseRef: null
  },
  {
    slug: 'risk-evaluation',
    term: 'Risk Evaluation',
    aliases: [],
    category: 'risk',
    plain: 'Comparing the risk against your tolerance to decide if action is needed.',
    definition: 'The process of comparing the results of risk analysis against risk criteria to determine whether the risk and its magnitude are acceptable or tolerable.',
    example: 'Score 15 exceeds the appetite threshold of 9. Treatment is required.',
    related: ['risk-analysis', 'risk-criteria', 'risk-appetite'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'risk-treatment',
    term: 'Risk Treatment',
    aliases: [],
    category: 'risk',
    plain: 'What you decide to do about a risk: reduce it, accept it, transfer it, or avoid it.',
    definition: 'The process of selecting and implementing options to modify risk. Four canonical options: modify (apply controls), accept, avoid (stop the activity), share (insure or transfer).',
    example: 'Ransomware risk → modify by deploying EDR, immutable backups, restore drills. Accept residual risk after treatment.',
    related: ['risk-mitigation', 'risk-acceptance', 'risk-transfer', 'risk-avoidance', 'risk-treatment-plan'],
    notToConfuseWith: [],
    clauseRef: 'Clauses 6.1.3, 8.3'
  },
  {
    slug: 'risk-mitigation',
    term: 'Risk Mitigation',
    aliases: ['risk reduction', 'risk modification'],
    category: 'risk',
    plain: 'Reducing risk by applying controls.',
    definition: 'A risk-treatment option that lowers likelihood, impact, or both, by implementing controls.',
    example: 'Deploying MFA reduces the likelihood of credential-theft-leading-to-account-takeover from high to low.',
    related: ['risk-treatment', 'control'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'risk-acceptance',
    term: 'Risk Acceptance',
    aliases: [],
    category: 'risk',
    plain: 'The risk owner consciously decides to live with the risk.',
    definition: 'A risk-treatment option in which the organisation knowingly chooses to retain a risk because the cost of treatment exceeds the benefit, the risk is below appetite, or no practical treatment exists. Must be documented and approved by the risk owner.',
    example: '"We accept the residual risk of a same-day zero-day for our reverse proxy because mitigation is impractical and impact is bounded." — approved by VP Engineering on 2026-04-12, review 2026-10-12.',
    related: ['risk-treatment', 'residual-risk', 'risk-appetite'],
    notToConfuseWith: [
      { term: 'Risk avoidance', why: 'Acceptance means you keep doing the activity and live with the risk. Avoidance means you stop the activity to remove the risk entirely.' }
    ],
    clauseRef: 'Clause 6.1.3.f'
  },
  {
    slug: 'risk-avoidance',
    term: 'Risk Avoidance',
    aliases: [],
    category: 'risk',
    plain: 'You stop doing the risky activity altogether.',
    definition: 'A risk-treatment option that eliminates the risk by not undertaking the activity that creates it.',
    example: 'Risk: "Storing payment-card data exposes us to PCI scope and breach impact." Avoidance: outsource payments to a PCI-certified processor; never touch PAN.',
    related: ['risk-treatment'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'risk-transfer',
    term: 'Risk Transfer',
    aliases: ['risk sharing'],
    category: 'risk',
    plain: 'You shift the risk to someone else (insurance, supplier).',
    definition: 'A risk-treatment option that allocates risk wholly or partly to another party. Note: regulatory and reputational risk usually cannot be fully transferred.',
    example: 'Cyber-liability insurance transfers financial exposure of a breach. The reputational hit stays with you.',
    related: ['risk-treatment'],
    notToConfuseWith: [
      { term: 'Risk avoidance', why: 'Transfer keeps the activity but pays someone else to carry the risk. Avoidance stops the activity.' }
    ],
    clauseRef: null
  },
  {
    slug: 'inherent-risk',
    term: 'Inherent Risk',
    aliases: ['gross risk'],
    category: 'risk',
    plain: 'How risky something is before any controls.',
    definition: 'The level of risk that exists in the absence of any controls or mitigation.',
    example: 'Inherent risk of "engineer accesses production database directly" — likelihood high, impact high.',
    related: ['residual-risk', 'risk-analysis'],
    notToConfuseWith: [
      { term: 'Residual risk', why: 'Inherent risk is before controls. Residual risk is what\'s left after controls.' }
    ],
    clauseRef: null
  },
  {
    slug: 'residual-risk',
    term: 'Residual Risk',
    aliases: ['net risk'],
    category: 'risk',
    plain: 'How risky something still is after applying your controls.',
    definition: 'The risk that remains after risk treatment. ISO 27001 requires the risk owner to approve residual risks (clause 6.1.3.f).',
    example: 'After deploying MFA, audit logging, and PIM, residual risk of "engineer accesses production database directly" — likelihood low, impact medium.',
    related: ['inherent-risk', 'risk-acceptance', 'risk-owner'],
    notToConfuseWith: [],
    clauseRef: 'Clause 6.1.3.f'
  },
  {
    slug: 'risk-appetite',
    term: 'Risk Appetite',
    aliases: [],
    category: 'risk',
    plain: 'How much risk top management is willing to take to pursue objectives.',
    definition: 'The amount and type of risk an organisation is willing to pursue or retain. Set by top management; informs risk criteria and escalation thresholds.',
    example: '"We have low appetite for confidentiality risks affecting customer PII, moderate appetite for availability risks affecting internal tooling, and high appetite for first-mover product risk."',
    related: ['risk-tolerance', 'risk-criteria', 'top-management'],
    notToConfuseWith: [
      { term: 'Risk tolerance', why: 'Appetite is strategic and qualitative ("low/moderate/high"). Tolerance is the operational threshold ("we won\'t accept risks scoring above 16").' }
    ],
    clauseRef: null
  },
  {
    slug: 'risk-tolerance',
    term: 'Risk Tolerance',
    aliases: [],
    category: 'risk',
    plain: 'The quantitative limit beyond which a risk must be treated.',
    definition: 'The boundaries of acceptable variation in performance / risk relative to appetite. Often expressed numerically (risk scores, $ thresholds).',
    example: 'Tolerance: any risk scoring ≥12 must be treated within 90 days; any scoring ≥16 must be escalated to the executive committee within 7 days.',
    related: ['risk-appetite', 'risk-criteria'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'risk-criteria',
    term: 'Risk Criteria',
    aliases: [],
    category: 'risk',
    plain: 'The rules used to evaluate the significance of a risk.',
    definition: 'The terms of reference against which the significance of a risk is evaluated — likelihood scales, impact scales, and acceptance thresholds. Required by clause 6.1.2.a.',
    example: 'Likelihood 1–5 (rare to almost certain), Impact 1–5 (negligible to catastrophic). Acceptance threshold: score ≤ 8.',
    related: ['risk-appetite', 'risk-tolerance', 'risk-methodology'],
    notToConfuseWith: [],
    clauseRef: 'Clause 6.1.2.a'
  },
  {
    slug: 'likelihood',
    term: 'Likelihood',
    aliases: ['probability'],
    category: 'risk',
    plain: 'How likely the risk is to happen.',
    definition: 'The chance of something happening, expressed qualitatively (rare/likely) or quantitatively (e.g., once per year).',
    example: 'Likelihood = 4/5 ("likely") for phishing, based on industry baseline and observed rates.',
    related: ['impact', 'risk-score'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'impact',
    term: 'Impact',
    aliases: ['consequence', 'severity'],
    category: 'risk',
    plain: 'How bad it would be if the risk materialised.',
    definition: 'The outcome of an event, expressed in terms that matter to the organisation: financial loss, regulatory penalty, reputation damage, operational disruption.',
    example: 'Impact = 5/5 ("catastrophic") for prolonged ransomware: revenue loss, customer churn, regulatory notification.',
    related: ['likelihood', 'risk-score', 'bia'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'risk-score',
    term: 'Risk Score',
    aliases: ['risk rating', 'risk level'],
    category: 'risk',
    plain: 'A number that combines likelihood and impact.',
    definition: 'A composite measure of risk magnitude, typically derived as Likelihood × Impact on a defined scale. Used to prioritise treatment.',
    example: 'Likelihood 4 × Impact 5 = 20. Compared against the 16-threshold, this risk requires immediate executive attention.',
    related: ['likelihood', 'impact', 'risk-criteria'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'risk-register',
    term: 'Risk Register',
    aliases: [],
    category: 'risk',
    plain: 'The master list of all known risks.',
    definition: 'A documented record of risks identified, with their description, owner, score, treatment, and current status. The artefact required by clauses 6.1.2 and 8.2.',
    example: 'Spreadsheet or tool listing 30 risks with columns: ID, title, owner, inherent score, treatment, residual score, status, review date.',
    related: ['risk-assessment', 'risk-treatment-plan'],
    notToConfuseWith: [
      { term: 'Risk Treatment Plan', why: 'The register is the inventory. The RTP is the action plan for treatment.' }
    ],
    clauseRef: null
  },
  {
    slug: 'risk-treatment-plan',
    term: 'Risk Treatment Plan',
    aliases: ['RTP'],
    category: 'risk',
    plain: 'The plan that says, for each risk, what controls go in, who does it, and by when.',
    definition: 'A documented plan that captures, for each risk requiring treatment, the chosen option, the controls to be applied, the owner, the resources, and the timeframe. Required by clause 6.1.3.',
    example: 'Risk R-12 (phishing) → controls A.6.3 (awareness), A.5.7 (threat intel feed) → owner: Head of People → due 2026-Q3 → status: in progress.',
    related: ['risk-treatment', 'soa', 'risk-register'],
    notToConfuseWith: [
      { term: 'Statement of Applicability', why: 'The RTP is your plan to treat each risk. The SoA is the catalogue of all 93 Annex A controls and their status.' }
    ],
    clauseRef: 'Clause 6.1.3.e'
  },
  {
    slug: 'risk-methodology',
    term: 'Risk Methodology',
    aliases: ['risk-management methodology'],
    category: 'risk',
    plain: 'The documented method you use to assess risk consistently.',
    definition: 'The documented approach the organisation uses to identify, analyse, evaluate, treat, monitor, and review risk — including criteria, scales, and roles. Required by clause 6.1.2.',
    example: 'Method: workshop-based identification, qualitative likelihood/impact 1–5 scoring, treatment per ISO 27001 options, quarterly review.',
    related: ['risk-criteria', 'risk-assessment'],
    notToConfuseWith: [],
    clauseRef: 'Clause 6.1.2'
  },

  // ============================================================
  // CONTROLS
  // ============================================================
  {
    slug: 'control',
    term: 'Control',
    aliases: ['safeguard', 'countermeasure'],
    category: 'controls',
    plain: 'Something you do to manage a risk — a policy, process, or technical measure.',
    definition: 'A measure that modifies risk. Includes any process, policy, device, practice, or other action that maintains or modifies risk. May be administrative (policies), physical (locks), or technical (firewalls, encryption).',
    example: 'Annex A 8.5 (Secure Authentication) — implemented as MFA on all SSO logins.',
    related: ['preventive-control', 'detective-control', 'corrective-control', 'annex-a'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'control-objective',
    term: 'Control Objective',
    aliases: [],
    category: 'controls',
    plain: 'What a control is meant to achieve.',
    definition: 'A statement of the desired outcome of applying controls. ISO 27001:2022 Annex A no longer organises controls by objectives, but the concept is still used in implementation.',
    example: '"Ensure that only authorised users can access information systems." A control objective satisfied by access provisioning, MFA, and de-provisioning controls together.',
    related: ['control'],
    notToConfuseWith: [
      { term: 'Information security objectives', why: 'Security objectives are organisation-wide goals (clause 6.2). Control objectives describe what individual controls achieve.' }
    ],
    clauseRef: null
  },
  {
    slug: 'preventive-control',
    term: 'Preventive Control',
    aliases: [],
    category: 'controls',
    plain: 'Stops a bad thing from happening in the first place.',
    definition: 'A control designed to deter or prevent the occurrence of an undesirable event.',
    example: 'MFA prevents credential-theft attacks from succeeding. Background checks prevent unsuitable hires.',
    related: ['detective-control', 'corrective-control'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'detective-control',
    term: 'Detective Control',
    aliases: [],
    category: 'controls',
    plain: 'Spots a bad thing once it has happened or is happening.',
    definition: 'A control designed to identify and detect undesirable events that have occurred.',
    example: 'SIEM alerts on impossible-travel logins. Audit logs reviewed weekly.',
    related: ['preventive-control', 'corrective-control', 'monitoring'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'corrective-control',
    term: 'Corrective Control',
    aliases: [],
    category: 'controls',
    plain: 'Fixes the situation after a bad thing has happened.',
    definition: 'A control designed to correct or restore conditions following an undesirable event, minimising its impact.',
    example: 'Backup restoration after data loss. Account lockout and password reset after credential compromise.',
    related: ['preventive-control', 'detective-control', 'incident-response'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'compensating-control',
    term: 'Compensating Control',
    aliases: [],
    category: 'controls',
    plain: 'A different control that achieves the same risk reduction when the standard one isn\'t feasible.',
    definition: 'An alternative control that meets the intent of an original control where the original cannot be implemented due to legitimate technical or business constraints.',
    example: 'Original requirement: encrypt at rest. Constraint: legacy mainframe doesn\'t support it. Compensating control: physical access tightly restricted, network segmentation, enhanced logging.',
    related: ['control'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'applicability',
    term: 'Applicability',
    aliases: [],
    category: 'controls',
    plain: 'Whether a specific Annex A control applies to your organisation.',
    definition: 'A determination, recorded in the SoA, of whether each Annex A control is included or excluded from the ISMS, with documented justification for each decision.',
    example: 'A.7.10 (Storage media) — Included; we issue laptops with USB-encrypted storage. A.5.13 (Labelling) — Excluded; we do not handle classified third-party material.',
    related: ['soa', 'inclusion-justification', 'exclusion-justification'],
    notToConfuseWith: [],
    clauseRef: 'Clause 6.1.3.d'
  },
  {
    slug: 'inclusion-justification',
    term: 'Inclusion Justification',
    aliases: [],
    category: 'controls',
    plain: 'Why an Annex A control is included in your SoA — usually a risk it treats.',
    definition: 'The documented reason a control is applicable to the ISMS. Per ISO 27001 6.1.3.d.1, every included control must be justified — typically by reference to the risk(s) it treats or the legal/contractual requirement it satisfies.',
    example: '"A.5.7 Threat intelligence — included; treats risks R-08 (phishing) and R-15 (zero-day exposure)."',
    related: ['soa', 'applicability', 'exclusion-justification'],
    notToConfuseWith: [
      { term: 'Exclusion justification', why: 'Inclusion = why this control applies. Exclusion = why this control doesn\'t. Both must be in the SoA.' }
    ],
    clauseRef: 'Clause 6.1.3.d.1'
  },
  {
    slug: 'exclusion-justification',
    term: 'Exclusion Justification',
    aliases: [],
    category: 'controls',
    plain: 'Why an Annex A control is excluded from your SoA.',
    definition: 'The documented reason a control is not applicable to the ISMS — typically because the activity it addresses isn\'t performed, or no relevant risk exists in scope.',
    example: '"A.7.11 Supporting utilities — excluded; we operate fully in cloud, with no organisation-controlled facilities to which utilities are supplied."',
    related: ['soa', 'inclusion-justification'],
    notToConfuseWith: [
      { term: 'Risk acceptance', why: 'Excluding a control means it doesn\'t apply at all. Accepting risk means the activity exists but you\'re consciously not treating the risk further.' }
    ],
    clauseRef: 'Clause 6.1.3.d.2'
  },
  {
    slug: 'control-effectiveness',
    term: 'Control Effectiveness',
    aliases: [],
    category: 'controls',
    plain: 'Whether a control actually does what it\'s meant to.',
    definition: 'The extent to which a control achieves its intended outcome. Different from "is it implemented?" — a control may be live but ineffective.',
    example: 'MFA is implemented (status: yes). Effectiveness: 95% of admin sessions used MFA last quarter; 5% bypassed it via legacy SSH key — partial effectiveness.',
    related: ['control', 'measurement', 'kpi'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'control-maturity',
    term: 'Control Maturity',
    aliases: [],
    category: 'controls',
    plain: 'How well-developed and consistent a control is.',
    definition: 'A measure of how reliably and repeatably a control operates. Common scale: ad-hoc → repeatable → defined → managed → optimised.',
    example: 'Patch management at "defined" — documented procedure followed by ops, monthly metrics, but not yet quantitatively managed against SLAs.',
    related: ['control', 'control-effectiveness'],
    notToConfuseWith: [],
    clauseRef: null
  },

  // ============================================================
  // DOCUMENTS & RECORDS
  // ============================================================
  {
    slug: 'documented-information',
    term: 'Documented Information',
    aliases: [],
    category: 'documents',
    plain: 'ISO\'s catch-all term for both documents (rules) and records (evidence).',
    definition: 'Information required to be controlled and maintained, plus the medium on which it is contained. ISO 27001:2022 uses this single term for both policies/procedures and evidence/records (clause 7.5).',
    example: 'Documented information includes: the Information Security Policy (a document), and the May 2026 access review records (records).',
    related: ['document-control', 'record', 'policy'],
    notToConfuseWith: [
      { term: 'Document vs Record', why: 'A document is a rule (policy, procedure). A record is evidence the rule was followed. ISO\'s 2013 wording. The 2022 standard merges them under "documented information".' }
    ],
    clauseRef: 'Clause 7.5'
  },
  {
    slug: 'document-control',
    term: 'Document Control',
    aliases: [],
    category: 'documents',
    plain: 'Making sure people read the right (current, approved) version.',
    definition: 'The set of practices ensuring documented information is identifiable, current, approved, accessible, protected from unauthorised change, and disposed of correctly. Required by clause 7.5.3.',
    example: 'Each policy has owner, approver, version, last-review date, location, classification. Old versions are archived but not in the user-facing index.',
    related: ['version-control', 'document-owner', 'retention'],
    notToConfuseWith: [],
    clauseRef: 'Clause 7.5.3'
  },
  {
    slug: 'record',
    term: 'Record',
    aliases: [],
    category: 'documents',
    plain: 'Evidence that something was done.',
    definition: 'Documented information that provides evidence of activities performed or results achieved. Records support audit and accountability.',
    example: 'Quarterly access-review spreadsheet with reviewer, date, decisions. Internal audit report. Incident timeline.',
    related: ['evidence', 'documented-information'],
    notToConfuseWith: [
      { term: 'Document', why: 'A document tells you what to do (a policy). A record proves you did it (the signed-off review).' }
    ],
    clauseRef: 'Clause 7.5'
  },
  {
    slug: 'version-control',
    term: 'Version Control',
    aliases: ['versioning'],
    category: 'documents',
    plain: 'Keeping track of which version of a document is which.',
    definition: 'The practice of identifying and tracking changes to documents, ensuring users access the correct version and changes are auditable.',
    example: 'Access Control Policy v1.0 (approved 2024-03-01), v1.1 (minor edit, 2024-09-15), v2.0 (major revision, 2026-02-10).',
    related: ['document-control'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'retention',
    term: 'Retention Period',
    aliases: ['retention'],
    category: 'documents',
    plain: 'How long records must be kept before deletion.',
    definition: 'The defined timeframe for which records and documents must be retained, driven by legal, contractual, regulatory, and business needs.',
    example: 'Audit reports: 6 years. Access-review records: 3 years. Incident records: 7 years (regulatory).',
    related: ['record', 'document-control'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'document-owner',
    term: 'Document Owner',
    aliases: [],
    category: 'documents',
    plain: 'The person responsible for keeping a document accurate and up-to-date.',
    definition: 'The named role accountable for maintaining a document — drafting, reviewing on schedule, recording changes, and triggering approval.',
    example: 'Document owner of the Access Control Policy: Head of IT. Approver: CISO.',
    related: ['document-control', 'roles-responsibilities'],
    notToConfuseWith: [
      { term: 'Document approver', why: 'The owner maintains the document. The approver authorises it for use. Often different roles to provide independence.' }
    ],
    clauseRef: null
  },
  {
    slug: 'evidence',
    term: 'Evidence',
    aliases: [],
    category: 'documents',
    plain: 'Proof that something happened — used by auditors.',
    definition: 'Records, statements of fact, or other information that is relevant to audit criteria and verifiable. The artefact an auditor asks for to confirm a control operates.',
    example: 'Evidence for "MFA is enforced": the Okta admin export showing MFA enrollment percentage, dated and screenshotted on audit day.',
    related: ['record', 'audit-evidence'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'acknowledgement',
    term: 'Acknowledgement',
    aliases: ['acceptance', 'attestation'],
    category: 'documents',
    plain: 'Confirmation that someone has read and accepted a policy or document.',
    definition: 'A documented confirmation by an individual that they have read, understood, and agreed to comply with a stated requirement.',
    example: 'On hire, all employees acknowledge the Acceptable Use Policy in the HR system. Annual re-acknowledgement is recorded for material changes.',
    related: ['policy', 'awareness'],
    notToConfuseWith: [],
    clauseRef: null
  },

  // ============================================================
  // AUDIT & ASSURANCE
  // ============================================================
  {
    slug: 'audit',
    term: 'Audit',
    aliases: [],
    category: 'audit',
    plain: 'A systematic check that something complies with stated requirements.',
    definition: 'A systematic, independent, and documented process for obtaining audit evidence and evaluating it objectively against audit criteria.',
    example: 'Internal audit of the Access Control process — sample of 25 leavers checked against the documented procedure.',
    related: ['internal-audit', 'external-audit', 'audit-evidence', 'audit-criteria'],
    notToConfuseWith: [
      { term: 'Inspection / review', why: 'Audits are systematic, independent, and produce a report against criteria. Reviews and inspections may be informal.' }
    ],
    clauseRef: 'Clause 9.2'
  },
  {
    slug: 'internal-audit',
    term: 'Internal Audit',
    aliases: [],
    category: 'audit',
    plain: 'The organisation auditing its own ISMS.',
    definition: 'An audit conducted by, or on behalf of, the organisation itself for management review and other internal purposes. Required by clause 9.2; auditors must be independent of the activity audited.',
    example: 'In April, the internal audit team audits the Risk Management process; in October, they audit Access Control. Both feed the management review.',
    related: ['audit', 'external-audit', 'audit-programme'],
    notToConfuseWith: [
      { term: 'External audit', why: 'Internal audits are by/for the organisation. External audits are by an independent body (typically the certification body).' }
    ],
    clauseRef: 'Clause 9.2'
  },
  {
    slug: 'external-audit',
    term: 'External Audit',
    aliases: ['third-party audit'],
    category: 'audit',
    plain: 'An auditor from outside the organisation checks the ISMS.',
    definition: 'An audit conducted by an independent external party — typically the certification body (Stage 1, Stage 2, surveillance, recertification) or a customer\'s representative.',
    example: 'BSI conducts the Stage 2 certification audit, sampling 30 controls and 4 processes over 5 days.',
    related: ['certification-body', 'stage-1', 'stage-2', 'surveillance-audit'],
    notToConfuseWith: [
      { term: 'Internal audit', why: 'External audits drive certification decisions; internal audits drive management review.' }
    ],
    clauseRef: null
  },
  {
    slug: 'auditor',
    term: 'Auditor',
    aliases: [],
    category: 'audit',
    plain: 'The person performing the audit.',
    definition: 'A person who conducts an audit. Must have demonstrated competence and be independent of the activity being audited.',
    example: 'Internal auditor: a member of the security team auditing IT operations. External auditor: a certification-body assessor.',
    related: ['lead-auditor', 'auditee', 'audit'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'auditee',
    term: 'Auditee',
    aliases: [],
    category: 'audit',
    plain: 'The team or process being audited.',
    definition: 'The organisation, function, or process being audited. Provides evidence and answers questions.',
    example: 'During an access-control audit, IT Operations is the auditee.',
    related: ['auditor', 'audit'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'lead-auditor',
    term: 'Lead Auditor',
    aliases: [],
    category: 'audit',
    plain: 'The senior auditor in charge of the audit.',
    definition: 'The auditor with overall responsibility for an audit — planning, conducting, reporting, and follow-up. For ISO 27001 certification, the lead auditor must hold an accredited qualification.',
    example: 'The certification body assigns a Lead Auditor (CB-qualified) and one supporting auditor to your Stage 2.',
    related: ['auditor', 'audit-programme'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'audit-programme',
    term: 'Audit Programme',
    aliases: ['audit plan (annual)'],
    category: 'audit',
    plain: 'The schedule of audits across the year.',
    definition: 'A set of audits planned for a defined timeframe, directed toward a specific purpose. Required by clause 9.2.2 — must consider importance of processes and prior audit results.',
    example: 'Annual programme: Q1 Risk Management, Q2 Access Control, Q3 Operations, Q4 Suppliers. Plus ad-hoc audits triggered by incidents.',
    related: ['internal-audit', 'audit-plan'],
    notToConfuseWith: [
      { term: 'Audit plan', why: 'The programme is the annual schedule of multiple audits. The plan is the document for one specific audit.' }
    ],
    clauseRef: 'Clause 9.2.2'
  },
  {
    slug: 'audit-plan',
    term: 'Audit Plan',
    aliases: [],
    category: 'audit',
    plain: 'The document for a single audit — scope, criteria, schedule, team.',
    definition: 'A document that describes the activities and arrangements for an individual audit: objectives, scope, criteria, audit team, sites, schedule.',
    example: 'Q2 Access Control Audit Plan: scope = joiner/mover/leaver process across all in-scope systems; criteria = ISO 27001 A.5.15–A.5.18, internal procedures; lead auditor: J. Smith; dates: 5–6 May.',
    related: ['audit-programme', 'audit-scope', 'audit-criteria'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'audit-scope',
    term: 'Audit Scope',
    aliases: [],
    category: 'audit',
    plain: 'What\'s in and out of a particular audit.',
    definition: 'The extent and boundaries of an audit — sites, organisational units, activities, and processes covered, and the period.',
    example: 'Scope: the access-control process for production systems in the EMEA region, calendar year 2026.',
    related: ['audit-plan', 'audit-criteria'],
    notToConfuseWith: [
      { term: 'ISMS scope', why: 'ISMS scope is the boundary of your security management system. Audit scope is the boundary of one audit (which may cover only part of the ISMS).' }
    ],
    clauseRef: null
  },
  {
    slug: 'audit-criteria',
    term: 'Audit Criteria',
    aliases: [],
    category: 'audit',
    plain: 'The yardstick used to judge what\'s being audited.',
    definition: 'The set of policies, procedures, or requirements used as a reference against which audit evidence is compared.',
    example: 'Audit criteria for an access review: ISO 27001 A.5.18, internal Access Control Policy v2.0, customer DPA section 4.',
    related: ['audit-plan', 'audit-evidence'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'audit-evidence',
    term: 'Audit Evidence',
    aliases: [],
    category: 'audit',
    plain: 'The records, documents, or observations the auditor uses to reach conclusions.',
    definition: 'Records, statements of fact, or other information relevant to the audit criteria and verifiable. Can be documents, interviews, observations, system outputs.',
    example: 'For an access-control audit: the JML procedure document, screenshots of an account being deactivated, ticket history, walked-through demo.',
    related: ['audit-criteria', 'evidence', 'sampling'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'sampling',
    term: 'Sampling',
    aliases: ['audit sampling'],
    category: 'audit',
    plain: 'Picking a manageable subset to check, instead of everything.',
    definition: 'The selection of less than 100% of a population for examination, with documented rationale, to draw a conclusion about the population. Auditors must justify the sample size and method.',
    example: 'Population: 412 leavers in the year. Sample: 25 (random + 5 high-privilege). Documented rationale: industry-typical 10–25 sample for this risk level.',
    related: ['audit-evidence', 'audit-plan'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'finding',
    term: 'Finding',
    aliases: [],
    category: 'audit',
    plain: 'Any observation made during an audit.',
    definition: 'The result of evaluating audit evidence against audit criteria. Findings can indicate conformity, nonconformity, or opportunity for improvement.',
    example: 'Finding 1 (NC, minor): 2 of 25 leavers had Slack access for >7 days post-departure, against the 24-hour standard.',
    related: ['conformity', 'nonconformity', 'observation'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'conformity',
    term: 'Conformity',
    aliases: ['compliance'],
    category: 'audit',
    plain: 'Meeting the requirements.',
    definition: 'Fulfilment of a requirement — the audited activity matches the criteria.',
    example: 'All 25 sampled access reviews were completed on time and signed off by the appropriate manager.',
    related: ['nonconformity', 'finding'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'nonconformity',
    term: 'Nonconformity',
    aliases: ['NC', 'nonconformance'],
    category: 'audit',
    plain: 'A failure to meet a requirement.',
    definition: 'A deviation from a requirement — a control, procedure, policy, or standard isn\'t being followed or doesn\'t exist where it should.',
    example: '"The Access Control Policy mandates quarterly access reviews; only 2 of the last 4 quarters have evidence of completion." — NC against A.5.18.',
    related: ['major-nc', 'minor-nc', 'corrective-action', 'finding'],
    notToConfuseWith: [
      { term: 'Observation', why: 'A nonconformity is a failure against a requirement. An observation is something noticed but not a failure (often suggesting improvement).' }
    ],
    clauseRef: 'Clause 10.2'
  },
  {
    slug: 'major-nc',
    term: 'Major Nonconformity',
    aliases: ['major NC'],
    category: 'audit',
    plain: 'A serious failure that puts certification at risk.',
    definition: 'A nonconformity that affects the capability of the ISMS to achieve its intended results — typically the absence or total breakdown of a required element. Will block or jeopardise certification.',
    example: '"No documented risk assessment process exists, and no risk register has been produced in the past 12 months."',
    related: ['nonconformity', 'minor-nc'],
    notToConfuseWith: [
      { term: 'Minor NC', why: 'Major = systemic / absence / serious failure → certification blocked. Minor = isolated lapse → certification continues with corrective action.' }
    ],
    clauseRef: null
  },
  {
    slug: 'minor-nc',
    term: 'Minor Nonconformity',
    aliases: ['minor NC'],
    category: 'audit',
    plain: 'An isolated, small failure.',
    definition: 'An isolated lapse in implementation that does not affect the overall capability of the ISMS. Requires corrective action but does not block certification.',
    example: '"Access review for Q1 missed the 30-day completion target by 4 days." — minor NC.',
    related: ['nonconformity', 'major-nc'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'observation',
    term: 'Observation',
    aliases: ['OFI', 'opportunity for improvement'],
    category: 'audit',
    plain: 'A "could-be-better" comment from an auditor — not a failure.',
    definition: 'A finding that does not constitute a nonconformity but identifies a potential weakness or improvement opportunity.',
    example: '"The risk register format is sound but would benefit from explicit mapping to Annex A controls for SoA traceability." — observation.',
    related: ['finding', 'nonconformity'],
    notToConfuseWith: [
      { term: 'Nonconformity', why: 'An observation is advisory. A nonconformity is a finding you must address.' }
    ],
    clauseRef: null
  },
  {
    slug: 'management-review',
    term: 'Management Review',
    aliases: ['MRM', 'management review meeting'],
    category: 'audit',
    plain: 'Top management formally reviewing the ISMS at planned intervals.',
    definition: 'A periodic review of the ISMS by top management, considering performance, audit results, risks, objectives, opportunities, and required changes. Inputs and outputs are prescribed in clause 9.3.',
    example: 'Quarterly MRM: agenda includes audit results, NC status, KPI trends, risk landscape, customer feedback, resource needs. Decisions documented.',
    related: ['top-management', 'objectives', 'audit', 'continual-improvement'],
    notToConfuseWith: [
      { term: 'Internal audit', why: 'Internal audit checks compliance with the ISMS. Management review evaluates whether the ISMS is suitable, adequate, and effective.' }
    ],
    clauseRef: 'Clause 9.3'
  },
  {
    slug: 'measurement',
    term: 'Monitoring, Measurement, Analysis & Evaluation',
    aliases: ['M&M', 'measurement'],
    category: 'audit',
    plain: 'Regularly checking that controls are working as intended.',
    definition: 'The clause-9.1 requirement to determine what to measure, how, when, and how to evaluate, to assess the performance and effectiveness of the ISMS.',
    example: '"Patch SLA: % of critical vulnerabilities patched within 7 days. Target ≥ 95%. Reported monthly by Head of Engineering."',
    related: ['kpi', 'objectives', 'control-effectiveness'],
    notToConfuseWith: [],
    clauseRef: 'Clause 9.1'
  },
  {
    slug: 'kpi',
    term: 'KPI / KRI',
    aliases: ['key performance indicator', 'key risk indicator'],
    category: 'audit',
    plain: 'Numbers used to track how well something is performing or how risky it\'s getting.',
    definition: 'KPI: a measure indicating how well an objective is being met. KRI: a measure indicating the level of a risk. Used in monitoring and management review.',
    example: 'KPI: % access reviews completed on time. KRI: number of unpatched critical CVEs older than 30 days.',
    related: ['measurement', 'objectives'],
    notToConfuseWith: [],
    clauseRef: null
  },

  // ============================================================
  // IMPROVEMENT
  // ============================================================
  {
    slug: 'continual-improvement',
    term: 'Continual Improvement',
    aliases: [],
    category: 'improvement',
    plain: 'Always making the ISMS a bit better.',
    definition: 'A clause-10 obligation to continually improve the suitability, adequacy, and effectiveness of the ISMS.',
    example: 'After three quarters of consistently late access reviews, the team automates reminders and adds a manager-dashboard view, raising on-time completion from 70% to 96%.',
    related: ['corrective-action', 'pdca'],
    notToConfuseWith: [],
    clauseRef: 'Clause 10.1'
  },
  {
    slug: 'corrective-action',
    term: 'Corrective Action',
    aliases: ['CAPA'],
    category: 'improvement',
    plain: 'Fixing the cause of a problem so it doesn\'t recur.',
    definition: 'Action taken to eliminate the cause of a detected nonconformity or other undesirable situation, to prevent recurrence. Required by clause 10.2.',
    example: 'NC: late access reviews. Containment: reassign reviewer for the missed quarter. Root cause: no calendar trigger. Corrective action: automate reminders + manager dashboard. Effectiveness verification: next 2 quarters show ≥95% on-time completion.',
    related: ['root-cause-analysis', 'nonconformity', 'continual-improvement'],
    notToConfuseWith: [
      { term: 'Containment / Correction', why: 'Correction fixes the immediate symptom. Corrective action addresses the root cause to prevent recurrence.' }
    ],
    clauseRef: 'Clause 10.2'
  },
  {
    slug: 'root-cause-analysis',
    term: 'Root Cause Analysis',
    aliases: ['RCA'],
    category: 'improvement',
    plain: 'Working out why something really went wrong, not just the surface symptom.',
    definition: 'A structured method for identifying the underlying cause(s) of a problem so corrective action addresses the source, not the symptom. Common techniques: 5 Whys, Fishbone, Fault Tree.',
    example: '5 Whys for late access reviews: Why late? — Reviewer forgot. Why? — No reminder. Why? — No calendar entry. Why? — Process not automated. Why? — Initially manual; volume grew.',
    related: ['corrective-action', 'five-whys'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'five-whys',
    term: '5 Whys',
    aliases: ['five whys'],
    category: 'improvement',
    plain: 'Asking "why?" five times to drill into the root cause.',
    definition: 'A simple iterative root-cause-analysis technique: state the problem, ask "why did this happen?", then ask "why?" of the answer, repeating until the root cause emerges (usually within 5 iterations).',
    example: 'See the example under Root Cause Analysis.',
    related: ['root-cause-analysis'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'pdca',
    term: 'PDCA Cycle',
    aliases: ['Plan-Do-Check-Act', 'Deming cycle'],
    category: 'improvement',
    plain: 'Plan it, do it, check it, fix it, repeat.',
    definition: 'A four-stage iterative model for continual improvement. ISO 27001 implicitly follows PDCA: Plan (clauses 4–7), Do (clause 8), Check (clause 9), Act (clause 10).',
    example: 'Plan: define security objectives. Do: implement controls. Check: audit and measure. Act: correct nonconformities and improve.',
    related: ['continual-improvement'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'effectiveness-verification',
    term: 'Effectiveness Verification',
    aliases: [],
    category: 'improvement',
    plain: 'Checking that a fix actually worked.',
    definition: 'A required step in corrective action where, after some time, you check that the action prevented recurrence and the underlying cause is gone.',
    example: 'Two quarters after automating access-review reminders, on-time completion is verified at 96% (vs 70% baseline). Effectiveness verified; CAPA closed.',
    related: ['corrective-action'],
    notToConfuseWith: [],
    clauseRef: null
  },

  // ============================================================
  // PEOPLE & AWARENESS
  // ============================================================
  {
    slug: 'competence',
    term: 'Competence',
    aliases: [],
    category: 'people',
    plain: 'Someone has the right skills, training, or experience to do their job.',
    definition: 'The ability to apply knowledge and skills to achieve intended results. Clause 7.2 requires the organisation to determine necessary competence, ensure people have it, and retain evidence.',
    example: 'A pen-tester role requires OSCP or equivalent. Evidence of competence: certificate on file, recent project portfolio, peer review.',
    related: ['awareness'],
    notToConfuseWith: [
      { term: 'Awareness', why: 'Competence is about being able to perform a specific role. Awareness is general understanding everyone has of security relevant to their role.' }
    ],
    clauseRef: 'Clause 7.2'
  },
  {
    slug: 'awareness',
    term: 'Awareness',
    aliases: [],
    category: 'people',
    plain: 'Everyone knowing the basics of security relevant to their role.',
    definition: 'The state of all persons under the organisation\'s control being aware of the information-security policy, their contribution to it, and the implications of nonconformity. Required by clause 7.3.',
    example: 'New-hire induction covers the security policy and reporting incidents. All-hands quarterly briefing on phishing trends.',
    related: ['competence', 'communication'],
    notToConfuseWith: [
      { term: 'Training', why: 'Awareness is the outcome (people understand what they need to). Training is one mechanism for achieving it.' }
    ],
    clauseRef: 'Clause 7.3'
  },
  {
    slug: 'communication',
    term: 'Communication',
    aliases: [],
    category: 'people',
    plain: 'Telling the right people the right things about security at the right time.',
    definition: 'The clause-7.4 requirement that the organisation determine what, when, with whom, how, and by whom it communicates about the ISMS — internal and external.',
    example: 'Internal: monthly security newsletter; incident notifications to affected teams. External: customer breach-notification process; regulator engagement runbook.',
    related: ['awareness', 'incident-response'],
    notToConfuseWith: [],
    clauseRef: 'Clause 7.4'
  },
  {
    slug: 'nda',
    term: 'Confidentiality / Non-Disclosure Agreement',
    aliases: ['NDA', 'CDA'],
    category: 'people',
    plain: 'A signed agreement not to share confidential information.',
    definition: 'A documented agreement between two parties (e.g., employer–employee, organisation–supplier) that obligates one or both to protect specified information from disclosure. Annex A 6.6 requires identification, regular review, and documentation of confidentiality requirements.',
    example: 'All employees sign an employment NDA at hire; suppliers sign one before any sensitive data is shared.',
    related: ['confidentiality', 'roles-responsibilities'],
    notToConfuseWith: [],
    clauseRef: 'A.6.6'
  },
  {
    slug: 'background-verification',
    term: 'Background Verification',
    aliases: ['screening', 'background check'],
    category: 'people',
    plain: 'Pre-hire checks on someone\'s identity, history, and credentials.',
    definition: 'Checks on the background of all candidates for employment, proportionate to business requirements, classification of information accessed, and perceived risks. Annex A 6.1.',
    example: 'For roles with privileged production access: identity verification, employment history, basic criminal-records check (where lawful).',
    related: ['nda', 'roles-responsibilities'],
    notToConfuseWith: [],
    clauseRef: 'A.6.1'
  },

  // ============================================================
  // OPERATIONS & RESILIENCE
  // ============================================================
  {
    slug: 'incident',
    term: 'Information Security Incident',
    aliases: ['incident'],
    category: 'operations',
    plain: 'An event that has actually compromised security or could.',
    definition: 'A single or series of unwanted or unexpected information-security events that have a significant probability of compromising business operations and threatening information security.',
    example: 'Ransomware encrypts a file share; a laptop is stolen; an attacker authenticates with stolen credentials. Each is an incident.',
    related: ['security-event', 'incident-response', 'breach'],
    notToConfuseWith: [
      { term: 'Security event', why: 'An event is any occurrence indicating a possible security issue (e.g., a single failed login). An incident is a confirmed or significant compromise.' }
    ],
    clauseRef: 'A.5.24–A.5.28'
  },
  {
    slug: 'security-event',
    term: 'Information Security Event',
    aliases: ['security event'],
    category: 'operations',
    plain: 'An observable occurrence in a system that may or may not turn out to be a security issue.',
    definition: 'An identified occurrence indicating a possible breach of policy, control failure, or previously unknown situation that may be security-relevant. Triaged to decide if it\'s an incident.',
    example: 'A single failed admin login is an event. Twenty failed admin logins from a foreign IP within a minute is a probable incident.',
    related: ['incident', 'monitoring', 'siem'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'breach',
    term: 'Data Breach',
    aliases: ['personal data breach'],
    category: 'operations',
    plain: 'A confirmed unauthorised disclosure, loss, or access to data — often legally defined.',
    definition: 'Under GDPR, a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data. Triggers regulator and data-subject notification obligations.',
    example: 'A misconfigured S3 bucket exposes 50,000 customer records publicly for 6 hours.',
    related: ['incident', 'gdpr', 'personal-data'],
    notToConfuseWith: [
      { term: 'Incident', why: 'Every breach is an incident. Not every incident is a breach (e.g., a contained ransomware attempt with no data exposure).' }
    ],
    clauseRef: null
  },
  {
    slug: 'incident-response',
    term: 'Incident Response',
    aliases: ['IR'],
    category: 'operations',
    plain: 'The process of detecting, containing, eradicating, recovering from, and learning from incidents.',
    definition: 'A structured process for handling security incidents through phases (commonly: prepare, detect, analyse, contain, eradicate, recover, lessons learned).',
    example: 'IR runbook for ransomware: isolate affected hosts, preserve evidence, notify CISO and Legal, restore from immutable backups, post-incident review within 14 days.',
    related: ['incident', 'corrective-action', 'business-continuity'],
    notToConfuseWith: [
      { term: 'Disaster recovery', why: 'IR handles security incidents (often malicious). DR handles restoring service after major disruption (often non-malicious — outage, hardware failure).' }
    ],
    clauseRef: 'A.5.24–A.5.28'
  },
  {
    slug: 'business-continuity',
    term: 'Business Continuity',
    aliases: ['BC'],
    category: 'operations',
    plain: 'Keeping the business running through a disruption.',
    definition: 'The capability of an organisation to continue delivery of products and services within acceptable timeframes at predefined capacity during a disruption.',
    example: 'BC capability: alternate site, redundant providers, documented procedures, tested annually.',
    related: ['business-continuity-plan', 'disaster-recovery', 'rto', 'rpo'],
    notToConfuseWith: [
      { term: 'Disaster recovery (DR)', why: 'BC is the broader business capability. DR is the IT/technology subset of BC focused on restoring systems.' }
    ],
    clauseRef: 'A.5.29–A.5.30'
  },
  {
    slug: 'business-continuity-plan',
    term: 'Business Continuity Plan',
    aliases: ['BCP'],
    category: 'operations',
    plain: 'The documented plan for keeping the business running during disruption.',
    definition: 'Documented procedures that guide the organisation to respond, recover, resume, and restore to a predefined level of operations following disruption.',
    example: 'BCP: roles, communication tree, alternate workspace arrangements, key supplier contacts, manual workarounds for critical processes.',
    related: ['business-continuity', 'disaster-recovery-plan'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'disaster-recovery',
    term: 'Disaster Recovery',
    aliases: ['DR'],
    category: 'operations',
    plain: 'Recovering IT systems after a major disruption.',
    definition: 'The set of policies, tools, and procedures to recover or continue technology infrastructure and systems following a disruption.',
    example: 'DR: failover to secondary cloud region within RTO; restore from snapshot to RPO.',
    related: ['disaster-recovery-plan', 'business-continuity', 'rto', 'rpo'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'disaster-recovery-plan',
    term: 'Disaster Recovery Plan',
    aliases: ['DRP'],
    category: 'operations',
    plain: 'The documented procedure for recovering IT systems.',
    definition: 'A documented procedure for recovering specific IT systems and data within defined timeframes following a disruption.',
    example: 'DRP for the production database: failover steps, runbooks, contact tree, validation checklist, expected duration ≤ 2 hours.',
    related: ['disaster-recovery', 'rto', 'rpo'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'bia',
    term: 'Business Impact Analysis',
    aliases: ['BIA'],
    category: 'operations',
    plain: 'Working out how bad it would be if a process or system stopped.',
    definition: 'A process to determine and document the criticality of business processes, the impact of disruption, and the recovery requirements (RTO, RPO, MTPD) for each.',
    example: 'BIA finds: payroll system has MTPD of 5 days, RTO 2 days, RPO 4 hours. Customer portal has MTPD 4 hours, RTO 1 hour, RPO 15 minutes.',
    related: ['rto', 'rpo', 'mtpd', 'business-continuity'],
    notToConfuseWith: [
      { term: 'Risk assessment', why: 'A risk assessment identifies and rates risks. A BIA quantifies the impact of disruption to support continuity planning.' }
    ],
    clauseRef: null
  },
  {
    slug: 'rto',
    term: 'Recovery Time Objective',
    aliases: ['RTO'],
    category: 'operations',
    plain: 'The maximum time we can be down before it really hurts.',
    definition: 'The targeted duration of time within which a business process or system must be restored after a disruption to avoid unacceptable consequences.',
    example: 'RTO for the customer-facing API: 1 hour. RTO for the internal wiki: 24 hours.',
    related: ['rpo', 'mtpd', 'bia'],
    notToConfuseWith: [
      { term: 'RPO', why: 'RTO is "how long until we\'re back up?". RPO is "how much data can we afford to lose?".' }
    ],
    clauseRef: null
  },
  {
    slug: 'rpo',
    term: 'Recovery Point Objective',
    aliases: ['RPO'],
    category: 'operations',
    plain: 'How much data we can afford to lose, expressed in time.',
    definition: 'The maximum acceptable amount of data loss measured in time. Drives backup frequency.',
    example: 'RPO 15 min for the production database means backups (or replication) must capture changes at least every 15 minutes.',
    related: ['rto', 'backup', 'bia'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'mtpd',
    term: 'Maximum Tolerable Period of Disruption',
    aliases: ['MTPD'],
    category: 'operations',
    plain: 'The longest the business can survive a disruption before it fails.',
    definition: 'The duration after which an organisation\'s viability would be irreparably damaged if a process or activity could not be resumed.',
    example: 'MTPD for payment processing: 7 days. After that, customer churn and regulatory fines threaten survival.',
    related: ['rto', 'bia'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'asset-inventory',
    term: 'Asset Inventory',
    aliases: ['asset register'],
    category: 'operations',
    plain: 'A list of everything important the organisation owns or relies on.',
    definition: 'A documented record of information assets and supporting assets within scope, including owners, classifications, and locations. Annex A 5.9.',
    example: 'Inventory: production databases, application services, employee laptops, key SaaS subscriptions, source-code repos. Each with owner, classification, location, criticality.',
    related: ['asset', 'asset-owner', 'data-classification'],
    notToConfuseWith: [
      { term: 'CMDB', why: 'A CMDB tracks IT configuration items operationally. The asset inventory may overlap but explicitly captures information assets, ownership, and classification for security purposes.' }
    ],
    clauseRef: 'A.5.9'
  },
  {
    slug: 'data-classification',
    term: 'Data Classification',
    aliases: ['information classification'],
    category: 'operations',
    plain: 'Labelling data by how sensitive it is, so handling rules can apply.',
    definition: 'The categorisation of information based on sensitivity, value, and legal/regulatory requirements. Drives handling, access, and protection rules. Annex A 5.12.',
    example: 'Public, Internal, Confidential, Restricted. Restricted data requires encryption in transit and at rest, named-user access, and audit logging.',
    related: ['data-owner', 'asset-inventory', 'confidentiality'],
    notToConfuseWith: [],
    clauseRef: 'A.5.12'
  },
  {
    slug: 'data-owner',
    term: 'Data Owner / Custodian',
    aliases: ['data steward'],
    category: 'operations',
    plain: 'Owner: who decides what happens with the data. Custodian: who safeguards it day-to-day.',
    definition: 'Data owner: the role accountable for classification, access decisions, and lifecycle. Data custodian: the role responsible for technical safeguards and operations on behalf of the owner.',
    example: 'Owner of customer PII: Head of Customer Operations. Custodian: the platform engineering team operating the database.',
    related: ['asset-owner', 'roles-responsibilities'],
    notToConfuseWith: [
      { term: 'Asset owner', why: 'Data owner is for the information itself. Asset owner is for the asset (often a system) that holds or processes it.' }
    ],
    clauseRef: null
  },
  {
    slug: 'change-management',
    term: 'Change Management',
    aliases: ['change control'],
    category: 'operations',
    plain: 'Planning, approving, and tracking changes to systems and processes.',
    definition: 'The process of evaluating, approving, implementing, and reviewing changes to information-processing facilities and systems, to minimise disruption and security impact. Annex A 8.32.',
    example: 'Production changes go through a CAB (Change Advisory Board); emergency changes have a documented post-implementation review.',
    related: ['acceptable-use'],
    notToConfuseWith: [
      { term: 'Configuration management', why: 'Change management is about controlling changes; configuration management is about knowing the current state of systems.' }
    ],
    clauseRef: 'A.8.32'
  },
  {
    slug: 'acceptable-use',
    term: 'Acceptable Use',
    aliases: ['AUP'],
    category: 'operations',
    plain: 'The rules for how staff can use company systems and data.',
    definition: 'Documented rules governing the appropriate use of organisational information, assets, and services. Annex A 5.10.',
    example: 'AUP covers email use, internet browsing, BYOD, removable media, software installation, social media. Acknowledged at hire.',
    related: ['policy', 'acknowledgement'],
    notToConfuseWith: [],
    clauseRef: 'A.5.10'
  },
  {
    slug: 'vendor',
    term: 'Vendor / Supplier',
    aliases: ['third party'],
    category: 'operations',
    plain: 'An external party providing goods or services.',
    definition: 'Any external organisation that supplies products or services. Annex A 5.19–5.23 require security in supplier relationships.',
    example: 'Cloud provider, HRIS SaaS, contractor staffing firm, payroll processor.',
    related: ['third-party-risk', 'sla', 'dpa', 'baa'],
    notToConfuseWith: [
      { term: 'Customer', why: 'Customers receive your service; suppliers provide one to you. Both have security obligations but in opposite directions.' }
    ],
    clauseRef: 'A.5.19'
  },
  {
    slug: 'third-party-risk',
    term: 'Third-Party Risk',
    aliases: ['supplier risk', 'TPRM'],
    category: 'operations',
    plain: 'The risk that a supplier\'s failure causes harm to your organisation.',
    definition: 'Risk arising from reliance on external parties — including their security posture, viability, compliance, and concentration. Managed via due diligence, contracts, monitoring, and exit strategies.',
    example: 'Concentration risk: a single cloud provider hosts 90% of services. Mitigation: documented exit plan, multi-region, contractual SLAs.',
    related: ['vendor', 'sla', 'dpa', 'risk'],
    notToConfuseWith: [],
    clauseRef: 'A.5.19–A.5.23'
  },
  {
    slug: 'sla',
    term: 'Service Level Agreement',
    aliases: ['SLA'],
    category: 'operations',
    plain: 'A contract clause defining service levels — uptime, response times, etc.',
    definition: 'A formally documented agreement between provider and customer specifying measurable service levels (availability, performance, response, resolution) and consequences for breach.',
    example: '99.9% monthly uptime; P1 incidents acknowledged within 15 minutes; service credits below threshold.',
    related: ['vendor', 'third-party-risk'],
    notToConfuseWith: [
      { term: 'OLA (Operational Level Agreement)', why: 'SLAs are between an organisation and its supplier. OLAs are internal — between teams within the same organisation.' }
    ],
    clauseRef: null
  },
  {
    slug: 'dpa',
    term: 'Data Processing Agreement',
    aliases: ['DPA'],
    category: 'operations',
    plain: 'The contract that says how a supplier handles personal data on your behalf.',
    definition: 'A contract required by GDPR Article 28 between a data controller and a data processor, setting out the subject, duration, nature, and purpose of processing, plus the processor\'s obligations.',
    example: 'When Acme onboards a new SaaS tool that processes customer PII, a DPA is signed before any data is shared.',
    related: ['gdpr', 'controller', 'processor', 'vendor'],
    notToConfuseWith: [
      { term: 'BAA (Business Associate Agreement)', why: 'A DPA is the GDPR equivalent. A BAA is the HIPAA equivalent (US healthcare). Different regulations, similar purpose.' }
    ],
    clauseRef: null
  },
  {
    slug: 'baa',
    term: 'Business Associate Agreement',
    aliases: ['BAA'],
    category: 'operations',
    plain: 'The HIPAA contract that says how a supplier handles protected health info.',
    definition: 'A US HIPAA-required contract between a covered entity and a business associate, defining permitted uses of Protected Health Information (PHI) and security obligations.',
    example: 'A US digital-health company signs a BAA with its email provider before sending appointment reminders.',
    related: ['hipaa', 'dpa'],
    notToConfuseWith: [],
    clauseRef: null
  },

  // ============================================================
  // TECHNICAL SECURITY
  // ============================================================
  {
    slug: 'cryptography',
    term: 'Cryptography',
    aliases: ['encryption (general)'],
    category: 'technical',
    plain: 'Math used to keep information secret or detect tampering.',
    definition: 'The science of using algorithms to protect confidentiality (encryption), integrity (hashing, signatures), and authenticity (signatures, MACs) of information.',
    example: 'AES-256 for symmetric encryption; RSA / ECDSA for digital signatures; SHA-256 for hashing.',
    related: ['encryption-at-rest', 'encryption-in-transit', 'hashing', 'key-management'],
    notToConfuseWith: [
      { term: 'Encoding (e.g., Base64)', why: 'Encoding transforms data for transmission/storage but isn\'t secret — anyone can reverse it. Encryption is secret-keyed.' }
    ],
    clauseRef: 'A.8.24'
  },
  {
    slug: 'encryption-at-rest',
    term: 'Encryption at Rest',
    aliases: [],
    category: 'technical',
    plain: 'Encrypting data while it\'s stored.',
    definition: 'The encryption of data when it is stored on disk, tape, or in a database, so that physical theft of media doesn\'t reveal its contents.',
    example: 'AES-256 full-disk encryption on all laptops; database encryption with managed KMS keys; S3 buckets with SSE-KMS.',
    related: ['cryptography', 'encryption-in-transit', 'key-management'],
    notToConfuseWith: [],
    clauseRef: 'A.8.24'
  },
  {
    slug: 'encryption-in-transit',
    term: 'Encryption in Transit',
    aliases: ['TLS'],
    category: 'technical',
    plain: 'Encrypting data while it moves between systems.',
    definition: 'The encryption of data when in motion across networks, typically using TLS, SSH, or VPNs.',
    example: 'All public endpoints use TLS 1.2+; internal service-to-service traffic uses mTLS within the mesh.',
    related: ['cryptography', 'encryption-at-rest'],
    notToConfuseWith: [],
    clauseRef: 'A.8.24'
  },
  {
    slug: 'key-management',
    term: 'Key Management',
    aliases: ['KMS'],
    category: 'technical',
    plain: 'Generating, storing, rotating, and destroying cryptographic keys safely.',
    definition: 'The lifecycle handling of cryptographic keys — generation, distribution, storage, rotation, revocation, destruction. Annex A 8.24 mandates documented practice.',
    example: 'Managed KMS (AWS KMS, GCP KMS) with separation of duties on key administration; annual rotation; audit logging on all key uses.',
    related: ['cryptography', 'encryption-at-rest', 'segregation-of-duties'],
    notToConfuseWith: [],
    clauseRef: 'A.8.24'
  },
  {
    slug: 'hashing',
    term: 'Hashing',
    aliases: [],
    category: 'technical',
    plain: 'A one-way mathematical function — turns input into a fixed-size fingerprint.',
    definition: 'A cryptographic function that maps data of arbitrary size to a fixed-size output, where it is computationally infeasible to derive the input or find collisions.',
    example: 'SHA-256(\'password\') always produces the same 256-bit hash. Used for storing password verifiers (with salt and KDF), checksums, and integrity verification.',
    related: ['cryptography', 'integrity'],
    notToConfuseWith: [
      { term: 'Encryption', why: 'Encryption is reversible (with the key). Hashing is one-way — there\'s no decryption.' }
    ],
    clauseRef: null
  },
  {
    slug: 'authentication',
    term: 'Authentication',
    aliases: ['AuthN'],
    category: 'technical',
    plain: 'Proving you are who you claim to be.',
    definition: 'The process of verifying the identity of a user, process, or device, often as a prerequisite to allowing access.',
    example: 'Username + password verifies a claim. Adding MFA strengthens the verification.',
    related: ['mfa', 'authorization', 'access-control'],
    notToConfuseWith: [
      { term: 'Authorization', why: 'Authentication answers "who are you?". Authorization answers "what are you allowed to do?".' }
    ],
    clauseRef: 'A.8.5'
  },
  {
    slug: 'authorization',
    term: 'Authorization',
    aliases: ['AuthZ'],
    category: 'technical',
    plain: 'Deciding what an authenticated user is allowed to do.',
    definition: 'The process of granting or denying specific permissions to an authenticated identity, based on policy.',
    example: 'After SSO authenticates Alice, the platform authorises her to read project X but not project Y.',
    related: ['authentication', 'access-control', 'rbac'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'mfa',
    term: 'Multi-Factor Authentication',
    aliases: ['MFA', '2FA', 'two-factor'],
    category: 'technical',
    plain: 'Logging in with more than one type of proof — e.g., password plus phone code.',
    definition: 'Authentication using two or more factors from different categories (something you know, something you have, something you are).',
    example: 'Password + TOTP code from authenticator app. Or password + hardware security key.',
    related: ['authentication', 'access-control'],
    notToConfuseWith: [
      { term: '2FA', why: '2FA is MFA with exactly two factors. MFA covers two or more.' }
    ],
    clauseRef: 'A.8.5'
  },
  {
    slug: 'access-control',
    term: 'Access Control',
    aliases: [],
    category: 'technical',
    plain: 'Making sure only the right people access the right things.',
    definition: 'The set of mechanisms that restrict access to information, systems, and resources to authorised users only. Implemented via authentication, authorisation, audit. Annex A 5.15–5.18, 8.2–8.5.',
    example: 'JML process, role-based permissions, MFA, privileged access management, quarterly access reviews.',
    related: ['authentication', 'authorization', 'rbac', 'least-privilege'],
    notToConfuseWith: [],
    clauseRef: 'A.5.15–A.5.18'
  },
  {
    slug: 'rbac',
    term: 'Role-Based Access Control',
    aliases: ['RBAC'],
    category: 'technical',
    plain: 'Permissions are granted by job role, not individual.',
    definition: 'An access-control model in which permissions are assigned to roles, and users are assigned to roles. Simplifies provisioning at scale.',
    example: 'Role "Engineer" has SSH to dev. Role "SRE" has SSH to prod. A new hire is assigned the role; permissions follow.',
    related: ['access-control', 'least-privilege'],
    notToConfuseWith: [
      { term: 'ABAC (Attribute-Based)', why: 'RBAC uses fixed roles. ABAC uses attributes (department, time, location) for finer-grained policy. Many systems combine both.' }
    ],
    clauseRef: null
  },
  {
    slug: 'least-privilege',
    term: 'Least Privilege',
    aliases: [],
    category: 'technical',
    plain: 'Give people only the minimum access needed for their job.',
    definition: 'A security principle requiring that subjects (users, processes, services) operate with the minimum privileges necessary to perform their assigned tasks.',
    example: 'Engineers do not have standing production-write access; access is granted just-in-time on approval, time-bounded, and audited.',
    related: ['need-to-know', 'access-control', 'privileged-access'],
    notToConfuseWith: [
      { term: 'Need-to-know', why: 'Least privilege is about minimum permissions. Need-to-know is about minimum information access. They reinforce each other.' }
    ],
    clauseRef: null
  },
  {
    slug: 'need-to-know',
    term: 'Need-to-Know',
    aliases: [],
    category: 'technical',
    plain: 'You only see information necessary for your role.',
    definition: 'A principle restricting access to information to those whose role requires it, irrespective of formal clearance.',
    example: 'Even though engineers have admin on dev, they have no read access to customer PII unless on the customer-success team.',
    related: ['least-privilege', 'access-control'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'privileged-access',
    term: 'Privileged Access',
    aliases: ['PAM'],
    category: 'technical',
    plain: 'High-power accounts (admin, root) — the keys-to-the-kingdom kind.',
    definition: 'Access rights beyond those of a standard user, usually with administrative or system-level capability. Requires extra controls — separate credentials, MFA, session monitoring, just-in-time grant, recording.',
    example: 'Production root SSH is brokered through a PAM tool requiring approved request, MFA, session recording.',
    related: ['least-privilege', 'access-control', 'mfa'],
    notToConfuseWith: [],
    clauseRef: 'A.8.2'
  },
  {
    slug: 'logging',
    term: 'Logging',
    aliases: ['audit logging'],
    category: 'technical',
    plain: 'Recording what happened in a system.',
    definition: 'The capture of events occurring in systems and applications for monitoring, troubleshooting, and forensic purposes. Annex A 8.15.',
    example: 'Authentication events, privileged actions, configuration changes, data access by sensitivity class.',
    related: ['monitoring', 'siem'],
    notToConfuseWith: [],
    clauseRef: 'A.8.15'
  },
  {
    slug: 'monitoring',
    term: 'Monitoring (Security)',
    aliases: ['security monitoring'],
    category: 'technical',
    plain: 'Watching systems and logs for signs of trouble.',
    definition: 'The continuous or periodic observation of systems, networks, and logs to detect anomalies, threats, or policy violations. Annex A 8.16.',
    example: 'SIEM rules alerting on impossible-travel logins; weekly review of privileged-action logs.',
    related: ['logging', 'siem', 'detective-control'],
    notToConfuseWith: [
      { term: 'Performance monitoring', why: 'Performance monitoring watches uptime/latency. Security monitoring watches for threats.' }
    ],
    clauseRef: 'A.8.16'
  },
  {
    slug: 'siem',
    term: 'Security Information and Event Management',
    aliases: ['SIEM'],
    category: 'technical',
    plain: 'A platform that collects logs from everywhere and alerts on suspicious patterns.',
    definition: 'A system aggregating logs and security events from multiple sources, normalising and correlating them to detect threats and provide audit data.',
    example: 'Splunk, Elastic Security, Sumo Logic, Datadog SIEM ingest logs from cloud, endpoints, identity, and applications and run detection rules.',
    related: ['logging', 'monitoring', 'security-event'],
    notToConfuseWith: [
      { term: 'SOAR', why: 'SIEM detects. SOAR (Security Orchestration, Automation, and Response) automates the response actions on top of the detection.' }
    ],
    clauseRef: null
  },
  {
    slug: 'backup',
    term: 'Backup',
    aliases: [],
    category: 'technical',
    plain: 'A copy of data kept separately, used to recover after loss.',
    definition: 'The creation and protected storage of copies of information so they can be restored after corruption, deletion, or loss. Annex A 8.13.',
    example: 'Daily database snapshots retained 30 days, plus weekly off-region immutable copies retained 1 year. Restore tested quarterly.',
    related: ['rpo', 'business-continuity', 'disaster-recovery'],
    notToConfuseWith: [
      { term: 'Replication', why: 'Replication keeps a real-time copy for availability. Backups are point-in-time copies for recovery from corruption / deletion. Replication alone is not a backup — corruption replicates.' }
    ],
    clauseRef: 'A.8.13'
  },
  {
    slug: 'patch-management',
    term: 'Patch Management',
    aliases: [],
    category: 'technical',
    plain: 'Keeping software up-to-date by applying security fixes.',
    definition: 'The process of identifying, evaluating, testing, deploying, and verifying software updates that fix vulnerabilities. Part of vulnerability management. Annex A 8.8.',
    example: 'Critical CVEs patched within 7 days; high within 30; routine within 90. Tracked monthly with target ≥95%.',
    related: ['vulnerability-management', 'change-management'],
    notToConfuseWith: [],
    clauseRef: 'A.8.8'
  },
  {
    slug: 'vulnerability-management',
    term: 'Vulnerability Management',
    aliases: ['VM'],
    category: 'technical',
    plain: 'The cycle of finding, evaluating, fixing, and verifying weaknesses.',
    definition: 'The continuous process of identifying, classifying, prioritising, remediating, and verifying technical vulnerabilities in systems and software. Annex A 8.8.',
    example: 'Weekly authenticated scans; CVSS-based prioritisation; remediation SLAs; monthly KPI reporting; integration with patch and change management.',
    related: ['patch-management', 'penetration-testing', 'vulnerability-assessment'],
    notToConfuseWith: [],
    clauseRef: 'A.8.8'
  },
  {
    slug: 'penetration-testing',
    term: 'Penetration Testing',
    aliases: ['pentest'],
    category: 'technical',
    plain: 'Hiring someone to attack your systems (with permission) to find weaknesses.',
    definition: 'An authorised, simulated attack against a system, application, or environment to identify vulnerabilities a real attacker could exploit. Conducted by qualified testers with defined scope and rules of engagement.',
    example: 'Annual external black-box pentest of the customer portal by a CREST-certified firm; findings tracked to closure.',
    related: ['vulnerability-management', 'vulnerability-assessment'],
    notToConfuseWith: [
      { term: 'Vulnerability assessment', why: 'A VA is automated scanning + analysis of known weaknesses. A pentest exploits weaknesses (with permission) to demonstrate impact and chained risks.' }
    ],
    clauseRef: null
  },
  {
    slug: 'vulnerability-assessment',
    term: 'Vulnerability Assessment',
    aliases: ['VA'],
    category: 'technical',
    plain: 'Scanning systems to find known weaknesses.',
    definition: 'A systematic examination of a system to identify and quantify vulnerabilities, typically using automated scanners and analysis.',
    example: 'Weekly authenticated Nessus scans against the production estate; findings triaged into the vulnerability register.',
    related: ['vulnerability-management', 'penetration-testing'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'network-segmentation',
    term: 'Network Segmentation',
    aliases: [],
    category: 'technical',
    plain: 'Splitting the network into separate zones so a breach in one doesn\'t spread.',
    definition: 'The division of a network into smaller, isolated zones with controlled communication between them, limiting the blast radius of an intrusion.',
    example: 'Production isolated from corporate; dev isolated from prod; payment-card environment in its own segment.',
    related: ['access-control'],
    notToConfuseWith: [],
    clauseRef: 'A.8.22'
  },
  {
    slug: 'dlp',
    term: 'Data Loss Prevention',
    aliases: ['DLP'],
    category: 'technical',
    plain: 'Tools that stop sensitive data from leaving the organisation.',
    definition: 'Technologies and processes that detect and prevent unauthorised transmission, sharing, or storage of sensitive data — at rest, in motion, or in use.',
    example: 'Email DLP blocks outgoing messages with credit-card patterns. Endpoint DLP blocks copy of classified files to USB.',
    related: ['data-classification', 'access-control'],
    notToConfuseWith: [],
    clauseRef: 'A.8.12'
  },
  {
    slug: 'endpoint-protection',
    term: 'Endpoint Protection',
    aliases: ['EPP', 'EDR'],
    category: 'technical',
    plain: 'Security software on laptops and servers (antivirus, EDR).',
    definition: 'Software on endpoint devices that prevents, detects, and responds to malware and other threats. Modern tools (EDR/XDR) add behavioural detection and response.',
    example: 'EDR agent on every laptop and server, central console, integration with SIEM, automated isolation of compromised hosts.',
    related: ['monitoring', 'siem'],
    notToConfuseWith: [],
    clauseRef: 'A.8.7'
  },
  {
    slug: 'byod',
    term: 'Bring Your Own Device',
    aliases: ['BYOD'],
    category: 'technical',
    plain: 'Letting staff use personal phones or laptops for work.',
    definition: 'A practice where employees use personally owned devices to access organisational information and services. Requires specific controls to manage the elevated risk.',
    example: 'BYOD allowed for email and chat with mandatory MDM enrolment, screen lock, encryption, and remote-wipe consent.',
    related: ['acceptable-use', 'data-classification'],
    notToConfuseWith: [],
    clauseRef: 'A.8.1'
  },

  // ============================================================
  // COMPLIANCE & PRIVACY
  // ============================================================
  {
    slug: 'gdpr',
    term: 'General Data Protection Regulation',
    aliases: ['GDPR'],
    category: 'compliance',
    plain: 'The EU/UK law that governs how personal data must be handled.',
    definition: 'EU Regulation 2016/679 (and the UK GDPR / DPA 2018 in the UK) governing the processing of personal data of individuals in the EU/UK. Establishes lawful bases, data-subject rights, breach notification, and significant fines.',
    example: 'A UK SaaS company\'s ISMS supports GDPR compliance via DPIAs, lawful-basis register, breach-notification runbook, DPA contracts with processors.',
    related: ['personal-data', 'data-subject', 'controller', 'processor', 'dpia', 'breach'],
    notToConfuseWith: [
      { term: 'ISO 27001', why: '27001 is a voluntary management-system standard. GDPR is a binding regulation. 27001 helps demonstrate good security practice but isn\'t sufficient on its own for GDPR.' }
    ],
    clauseRef: null
  },
  {
    slug: 'dpia',
    term: 'Data Protection Impact Assessment',
    aliases: ['DPIA'],
    category: 'compliance',
    plain: 'A privacy risk assessment for new processing of personal data.',
    definition: 'A GDPR Article 35 process required when processing is likely to result in a high risk to data subjects. Identifies risks and mitigations before processing begins.',
    example: 'New AI feature analysing user behaviour: DPIA covers necessity, proportionality, risks, mitigations, residual risk, DPO sign-off.',
    related: ['gdpr', 'personal-data', 'risk-assessment'],
    notToConfuseWith: [
      { term: 'Risk assessment (ISMS)', why: 'A DPIA focuses on privacy risks to data subjects. An ISMS risk assessment focuses on risks to the organisation\'s information assets. They overlap but aren\'t identical.' }
    ],
    clauseRef: null
  },
  {
    slug: 'personal-data',
    term: 'Personal Data',
    aliases: ['PII', 'personal information'],
    category: 'compliance',
    plain: 'Information that can identify a person.',
    definition: 'Any information relating to an identified or identifiable natural person. Names, emails, IP addresses, device IDs, health data — all can be personal data depending on context.',
    example: 'Customer email + order history is personal data. Aggregate "5,000 customers from London bought X" usually is not.',
    related: ['gdpr', 'data-subject', 'data-classification'],
    notToConfuseWith: [
      { term: 'PII (US sense)', why: 'In US contexts PII is often narrower (Social Security number, etc.). GDPR\'s "personal data" is much broader — including any identifier like an IP address.' }
    ],
    clauseRef: null
  },
  {
    slug: 'data-subject',
    term: 'Data Subject',
    aliases: [],
    category: 'compliance',
    plain: 'The individual the personal data is about.',
    definition: 'An identified or identifiable natural person to whom personal data relates. The person whose rights GDPR protects.',
    example: 'A customer is a data subject relative to their account information.',
    related: ['gdpr', 'personal-data'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'controller',
    term: 'Controller (Data Controller)',
    aliases: [],
    category: 'compliance',
    plain: 'The party deciding how and why personal data is processed.',
    definition: 'Under GDPR, the natural or legal person who determines the purposes and means of processing personal data.',
    example: 'A SaaS company is the controller for its own employees\' data. For its customers\' end-user data, it may be a processor.',
    related: ['processor', 'gdpr', 'dpa'],
    notToConfuseWith: [
      { term: 'Processor', why: 'Controllers decide what to do with the data. Processors carry it out on the controller\'s instruction.' }
    ],
    clauseRef: null
  },
  {
    slug: 'processor',
    term: 'Processor (Data Processor)',
    aliases: [],
    category: 'compliance',
    plain: 'The party processing personal data on behalf of the controller.',
    definition: 'Under GDPR, a natural or legal person processing personal data on behalf of the controller, on documented instructions.',
    example: 'A SaaS analytics tool used by a retailer is a processor of the retailer\'s customer data.',
    related: ['controller', 'gdpr', 'dpa'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'soc2',
    term: 'SOC 2',
    aliases: ['SOC2'],
    category: 'compliance',
    plain: 'A US attestation report on a service organisation\'s controls.',
    definition: 'A reporting framework from the AICPA evaluating a service organisation\'s controls over the Trust Services Criteria (security, availability, processing integrity, confidentiality, privacy). Reports are issued by accredited CPA firms.',
    example: 'A US SaaS company gets a SOC 2 Type II covering security and availability, audited annually, shared with prospects under NDA.',
    related: ['iso-27001'],
    notToConfuseWith: [
      { term: 'ISO 27001', why: '27001 is a global standard with certification. SOC 2 is a US-originating attestation report. Many companies do both — they overlap heavily on security controls.' }
    ],
    clauseRef: null
  },
  {
    slug: 'nist-csf',
    term: 'NIST Cybersecurity Framework',
    aliases: ['NIST CSF'],
    category: 'compliance',
    plain: 'A US framework organising cybersecurity activities into Identify, Protect, Detect, Respond, Recover, Govern.',
    definition: 'A voluntary framework published by the US National Institute of Standards and Technology to help organisations manage and reduce cybersecurity risk. CSF 2.0 (2024) added Govern as a sixth function.',
    example: 'Organisations map their controls to CSF functions to communicate posture in US-centric procurement contexts.',
    related: ['iso-27001'],
    notToConfuseWith: [
      { term: 'ISO 27001', why: 'NIST CSF is voluntary, US-originated, focused on outcomes. ISO 27001 is global, certifiable, focused on management systems.' }
    ],
    clauseRef: null
  },
  {
    slug: 'pci-dss',
    term: 'PCI DSS',
    aliases: [],
    category: 'compliance',
    plain: 'The card-payment industry security standard.',
    definition: 'The Payment Card Industry Data Security Standard, mandated by the major card brands for any organisation that stores, processes, or transmits cardholder data.',
    example: 'A merchant accepting cards must comply with PCI DSS — quarterly scans, annual assessment, reduced scope where possible by tokenisation.',
    related: ['iso-27001'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'hipaa',
    term: 'HIPAA',
    aliases: [],
    category: 'compliance',
    plain: 'The US healthcare privacy and security law.',
    definition: 'The US Health Insurance Portability and Accountability Act, including the Privacy Rule and Security Rule, governing the protection of Protected Health Information (PHI).',
    example: 'A US digital-health company complies via the Security Rule\'s administrative, physical, and technical safeguards, plus BAAs with subprocessors.',
    related: ['baa'],
    notToConfuseWith: [],
    clauseRef: null
  },

  // ============================================================
  // CERTIFICATION & ACCREDITATION
  // ============================================================
  {
    slug: 'stage-1',
    term: 'Stage 1 Audit',
    aliases: ['stage 1'],
    category: 'certification',
    plain: 'The first part of a certification audit — a documentation and readiness review.',
    definition: 'The first stage of an ISO 27001 certification audit, conducted by the certification body. Reviews ISMS documentation, scope, and overall readiness; identifies gaps that would block Stage 2.',
    example: 'Stage 1 (1–2 days): auditor reviews policies, SoA, risk register, internal audit reports, MRM minutes. Issues findings to address before Stage 2.',
    related: ['stage-2', 'certification-body', 'external-audit'],
    notToConfuseWith: [
      { term: 'Stage 2 audit', why: 'Stage 1 is documentation and readiness. Stage 2 is the deep operational test.' }
    ],
    clauseRef: null
  },
  {
    slug: 'stage-2',
    term: 'Stage 2 Audit',
    aliases: ['stage 2'],
    category: 'certification',
    plain: 'The full certification audit — auditors check that the ISMS actually operates.',
    definition: 'The second stage of an ISO 27001 certification audit. Operational evaluation of whether the ISMS is implemented and effective, through interviews, observation, and sampling. Outcome: certification recommendation.',
    example: 'Stage 2 (3–5 days for SME): auditor samples access reviews, interviews engineers and managers, observes incident-response capability, walks the office.',
    related: ['stage-1', 'certification-body', 'external-audit'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'surveillance-audit',
    term: 'Surveillance Audit',
    aliases: [],
    category: 'certification',
    plain: 'The annual check-in audit between certification and recertification.',
    definition: 'A periodic (typically annual) external audit by the certification body in years 1 and 2 of the 3-year certificate cycle. Lighter than Stage 2 but still confirms continued conformity.',
    example: 'Surveillance Year 1: auditor samples ~50% of controls and key processes; closes any standing findings.',
    related: ['recertification', 'certification-body'],
    notToConfuseWith: [
      { term: 'Recertification', why: 'Surveillance audits keep certification active in years 1–2. Recertification is the full reassessment in year 3.' }
    ],
    clauseRef: null
  },
  {
    slug: 'recertification',
    term: 'Recertification Audit',
    aliases: [],
    category: 'certification',
    plain: 'The full audit at the end of a 3-year certificate cycle to renew certification.',
    definition: 'A comprehensive external audit before the certificate expires (typically 3 years), reassessing the entire ISMS. Resembles Stage 2 in depth.',
    example: 'Recertification audit in month 33–34 of a 36-month cycle, to ensure no certification gap.',
    related: ['surveillance-audit', 'certification-body'],
    notToConfuseWith: [],
    clauseRef: null
  },
  {
    slug: 'certification-body',
    term: 'Certification Body',
    aliases: ['CB', 'registrar'],
    category: 'certification',
    plain: 'The accredited firm that issues your ISO 27001 certificate.',
    definition: 'An organisation accredited by a national accreditation body (e.g., UKAS, ANAB) to perform third-party certification audits and issue certificates against management-system standards.',
    example: 'BSI, LRQA, DNV, BV, SGS, A-LIGN, Schellman are common ISO 27001 certification bodies.',
    related: ['accreditation', 'stage-1', 'stage-2'],
    notToConfuseWith: [
      { term: 'Accreditation body', why: 'Certification bodies certify your organisation. Accreditation bodies (UKAS, ANAB) accredit the certification bodies. The CB needs accreditation for its certificates to carry weight.' }
    ],
    clauseRef: null
  },
  {
    slug: 'accreditation',
    term: 'Accreditation',
    aliases: [],
    category: 'certification',
    plain: 'A government-recognised body confirming that a certification body is competent.',
    definition: 'Formal third-party recognition of a certification body\'s competence to perform conformity assessment, granted by an accreditation body operating under ISO/IEC 17011.',
    example: 'A certificate issued by a UKAS-accredited CB carries the UKAS mark. An unaccredited certificate is generally not accepted in regulated procurement.',
    related: ['certification-body', 'ukas-anab'],
    notToConfuseWith: [
      { term: 'Certification', why: 'Certification is what you (the organisation) get. Accreditation is what the certification body has.' }
    ],
    clauseRef: null
  },
  {
    slug: 'ukas-anab',
    term: 'UKAS / ANAB',
    aliases: ['UKAS', 'ANAB'],
    category: 'certification',
    plain: 'The UK and US accreditation bodies that accredit certification bodies.',
    definition: 'UKAS (United Kingdom Accreditation Service) and ANAB (ANSI National Accreditation Board, US) are national accreditation bodies. They accredit certification bodies under ISO 17021. Look for their mark on a certificate to confirm legitimacy.',
    example: 'A certificate issued under UKAS will carry the UKAS crown mark.',
    related: ['accreditation', 'certification-body'],
    notToConfuseWith: [],
    clauseRef: null
  }
];

// Helpers --------------------------------------------------------------------
function indexBySlug() {
  const idx = Object.create(null);
  for (const e of ENTRIES) idx[e.slug] = e;
  return idx;
}

function searchEntries(query, categoryFilter, letterFilter) {
  const q = (query || '').trim().toLowerCase();
  return ENTRIES.filter(e => {
    if (categoryFilter && categoryFilter !== 'all' && e.category !== categoryFilter) return false;
    if (letterFilter && letterFilter !== 'all') {
      const first = e.term[0].toUpperCase();
      if (letterFilter === '#') {
        if (/[A-Z]/.test(first)) return false;
      } else if (first !== letterFilter) {
        return false;
      }
    }
    if (!q) return true;
    const haystack = [
      e.term,
      ...(e.aliases || []),
      e.plain || '',
      e.definition || '',
      e.example || ''
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

const STARTER_TERMS = [
  'isms', 'cia-triad', 'risk', 'control', 'soa', 'annex-a',
  'nonconformity', 'management-review', 'stage-1', 'stage-2'
];

module.exports = {
  CATEGORIES,
  ENTRIES,
  indexBySlug,
  searchEntries,
  STARTER_TERMS
};
