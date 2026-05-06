// Per-item current-state diagnostic questions for the gap-assessment wizard.
//
// Two layers:
//   1) BESPOKE — hand-written diagnostic questions for items where mechanical
//      transformation produces awkward English or misses nuance (e.g., abstract
//      management-system clauses, controls with subtle scope).
//   2) MECHANICAL FALLBACK — for any iso_item_id without a bespoke entry, we
//      derive questions from the existing iso_items.evidence_needed array using
//      verb-transform rules: "Establish X" → "Has X been established?", etc.
//
// All 25 main-body clauses (4–10) are covered bespoke because they are the
// "shall" requirements and most consequential. Annex A controls fall through
// to the mechanical generator unless explicitly overridden.

const BESPOKE = {
  // ===== Clause 4 — Context of the organization =====
  'clause-4.1': [
    'Has the organization documented its external context (regulatory, technological, market, cultural, climate-related)?',
    'Has it documented its internal context (culture, structure, capabilities, resources)?',
    'Are these issues reviewed when significant changes occur?',
    'Do the identified context issues feed into the risk assessment?'
  ],
  'clause-4.2': [
    'Is there a list of interested parties relevant to the ISMS (regulators, customers, employees, suppliers, etc.)?',
    'Have their requirements been identified, including legal, regulatory, and contractual?',
    'Are climate-related obligations considered where relevant?',
    'Is there a mechanism to keep this list current as obligations change?'
  ],
  'clause-4.3': [
    'Is the ISMS scope documented in writing?',
    'Does the scope explicitly state inclusions, boundaries, and any exclusions with rationale?',
    'Does the scope reference interfaces and dependencies with other organizations?',
    'Is the scope reviewed when the organization changes (acquisitions, new sites, new products)?'
  ],
  'clause-4.4': [
    'Are the ISMS processes (risk assessment, internal audit, MR, corrective action) documented or mapped?',
    'Is there evidence the ISMS is operating (records of risk assessments, audits, reviews)?',
    'Are interactions between processes shown (e.g., how a finding becomes an NC, then a corrective action)?'
  ],
  // ===== Clause 5 — Leadership =====
  'clause-5.1': [
    'Has top management demonstrated commitment via documented decisions (MR minutes, signed policy, budget approvals)?',
    'Has top management communicated the importance of the ISMS to staff?',
    'Are resources (budget, headcount, tools) allocated to the ISMS?',
    'Does top management hold ISMS-relevant roles accountable for outcomes?'
  ],
  'clause-5.2': [
    'Is there a top-management-approved Information Security Policy?',
    'Does the policy state the ISMS purpose and direction (objectives, framework)?',
    'Has the policy been communicated to all staff and made available to interested parties as appropriate?',
    'Is the policy reviewed at planned intervals (typically annual)?'
  ],
  'clause-5.3': [
    'Are information-security roles and responsibilities defined in writing?',
    'Are these responsibilities assigned to specific individuals or functions?',
    'Are these communicated to the people holding the roles?',
    'Are conflicts of duty (segregation) considered in the role design?'
  ],
  // ===== Clause 6 — Planning =====
  'clause-6.1.1': [
    'Has the organization considered which risks and opportunities its ISMS must address?',
    'Are these documented and used to plan ISMS actions?',
    'Are actions integrated into ISMS processes (not just written down and forgotten)?'
  ],
  'clause-6.1.2': [
    'Is there a documented information-security risk-assessment methodology?',
    'Does it define risk-acceptance criteria and how risks are evaluated?',
    'Are risk owners assigned for every identified risk?',
    'Does the methodology produce consistent, valid, and comparable results?',
    'Is the methodology actually applied (recent risk assessments exist)?'
  ],
  'clause-6.1.3': [
    'Is there a documented information-security risk-treatment process?',
    'For every applicable risk, has a treatment option been chosen (modify / accept / avoid / share)?',
    'Are necessary Annex A controls determined and compared against Annex A (no controls missed)?',
    'Is the Statement of Applicability produced with inclusion AND exclusion justifications for every Annex A control?',
    'Is there a documented risk-treatment plan, approved by risk owners?',
    'Have residual risks been evaluated and accepted by risk owners?'
  ],
  'clause-6.2': [
    'Are information-security objectives documented and measurable?',
    'Are they consistent with the ISMS policy?',
    'Are there plans showing what will be done, by whom, by when, and how progress is measured?',
    'Are objectives and progress reviewed at planned intervals?'
  ],
  'clause-6.3': [
    'Does the organization plan changes to the ISMS in advance (rather than reacting after the fact)?',
    'Are change records or planning documents available?'
  ],
  // ===== Clause 7 — Support =====
  'clause-7.1': [
    'Are resources required for the ISMS identified and provided (budget, people, tools, time)?',
    'Is resource adequacy reviewed (e.g., in MR)?'
  ],
  'clause-7.2': [
    'Has the competence required for ISMS roles been determined?',
    'Are people in those roles competent (training, qualification, experience)?',
    'Where gaps exist, are actions taken (training, hiring, reassignment)?',
    'Are records of competence maintained (CVs, certs, training records)?'
  ],
  'clause-7.3': [
    'Is there an awareness program covering the ISMS policy, individual contribution, and consequences of non-conformance?',
    'Have all staff been made aware (induction, refresher, attestation)?',
    'Are awareness records maintained?'
  ],
  'clause-7.4': [
    'Has the organization decided what to communicate about information security, to whom, when, and how?',
    'Are internal communication channels defined (intranet, town halls, manager cascade)?',
    'Are external communication channels defined (regulators, customers, public)?',
    'Is communication records maintained?'
  ],
  'clause-7.5': [
    'Is documented information required by ISO 27001 in place (policy, methodology, SoA, treatment plan, audit programme, MR records, NC records)?',
    'Is documented information required by the organization\'s ISMS in place (procedures, runbooks)?',
    'Is documented information controlled (version, owner, distribution, protection)?',
    'Are documents reviewed and approved before issue and after changes?',
    'Are obsolete documents prevented from unintended use?'
  ],
  // ===== Clause 8 — Operation =====
  'clause-8.1': [
    'Are ISMS processes planned, implemented, and controlled to meet requirements?',
    'Are outsourced processes determined and controlled (e.g., supplier-managed services in scope)?',
    'Are records kept to confirm processes have been carried out as planned?'
  ],
  'clause-8.2': [
    'Are information-security risk assessments performed at planned intervals?',
    'Are they performed when significant changes occur?',
    'Are results documented and risk owners informed?'
  ],
  'clause-8.3': [
    'Is the risk treatment plan implemented?',
    'Are the implemented treatments effective (verified, not just deployed)?',
    'Are records of implementation kept?'
  ],
  // ===== Clause 9 — Performance evaluation =====
  'clause-9.1': [
    'Has the organization determined what needs to be monitored and measured?',
    'Have monitoring methods, frequency, analysis, and evaluation criteria been defined?',
    'Is monitoring actually performed and recorded?',
    'Are results analyzed and used (not just collected)?'
  ],
  'clause-9.2': [
    'Are internal audits conducted at planned intervals?',
    'Do they cover both ISO 27001 conformity AND the organization\'s own ISMS requirements?',
    'Do they cover whether the ISMS is effectively implemented and maintained?',
    'Is there a documented internal-audit programme (frequency, methods, responsibilities, reporting)?',
    'Are auditors objective and impartial (not auditing their own work)?',
    'Are audit results reported to relevant management?',
    'Are audit records retained as documented information?'
  ],
  'clause-9.3': [
    'Are management reviews held at planned intervals (typically at least annually)?',
    'Is top management present and engaged?',
    'Do MR inputs cover all of 9.3.2: status of prior actions, changes in context/risks, KPIs, NC/corrective action, audit results, fulfillment of objectives, feedback from interested parties, results of risk assessment, treatment plan status, improvement opportunities?',
    'Are decisions from MR (continual improvement, ISMS changes) documented?',
    'Are MR records retained as documented information?'
  ],
  // ===== Clause 10 — Improvement =====
  'clause-10.1': [
    'Does the organization continually improve the ISMS (suitability, adequacy, effectiveness)?',
    'Is improvement evidence-based (driven by data, not just intent)?'
  ],
  'clause-10.2': [
    'When a nonconformity occurs, is it reacted to (controlled, corrected, consequences dealt with)?',
    'Is its cause determined (root-cause analysis, not just symptom)?',
    'Are similar nonconformities looked for elsewhere?',
    'Is corrective action taken and effectiveness reviewed?',
    'Are NC and corrective-action records retained?'
  ],

  // ===== Selected Annex A controls (high-impact) — bespoke =====
  'annex-a.5.1': [
    'Is there a top-management-approved Information Security Policy?',
    'Are topic-specific policies in place where needed (access control, cryptography, supplier, BCP, etc.)?',
    'Have policies been communicated to staff and acknowledged?',
    'Are policies reviewed at planned intervals?'
  ],
  'annex-a.5.7': [
    'Is threat intelligence collected from relevant sources (vendors, ISACs, regulators)?',
    'Is the intelligence analyzed for relevance to the organization?',
    'Are decisions and actions taken based on the intel (e.g., patching, blocking, hunting)?',
    'Are records of decisions and actions kept?'
  ],
  'annex-a.5.15': [
    'Is there a documented access-control policy?',
    'Are access rights granted on a need-to-know / need-to-use basis?',
    'Is least-privilege enforced (especially for privileged access)?',
    'Are access rights reviewed periodically?'
  ],
  'annex-a.5.16': [
    'Are unique identities established for every user and system entity?',
    'Are shared accounts justified and tightly controlled?',
    'Is identity lifecycle managed (joiner-mover-leaver process)?'
  ],
  'annex-a.5.17': [
    'Are authentication credentials issued via a controlled process?',
    'Are password complexity, MFA, or equivalent enforced for sensitive access?',
    'Are credentials revoked promptly on role change or termination?',
    'Are users instructed not to share or reuse credentials?'
  ],
  'annex-a.5.18': [
    'Are access rights provisioned based on documented role-permission mappings?',
    'Are access rights modified when roles change?',
    'Are access rights revoked promptly on termination?',
    'Are access reviews performed periodically and documented?'
  ],
  'annex-a.5.24': [
    'Is there an incident management plan covering classification, escalation, communication?',
    'Are roles and responsibilities for incident response defined?',
    'Has the plan been tested (tabletop or live)?'
  ],
  'annex-a.5.25': [
    'Are events assessed against criteria to determine if they are incidents?',
    'Are criteria documented and applied consistently?'
  ],
  'annex-a.5.26': [
    'Is there a documented incident response procedure?',
    'Are responders trained on the procedure?',
    'Are incidents containing, eradicating, and recovering followed in practice (recent incidents show this)?'
  ],
  'annex-a.5.29': [
    'Are business continuity requirements identified for information security?',
    'Is a BCP or equivalent plan documented?',
    'Has the plan been tested at planned intervals?'
  ],
  'annex-a.5.30': [
    'Have information security continuity requirements been determined?',
    'Have plans been established to maintain or restore information processing during disruption?',
    'Has the ICT readiness been tested (failover, restore, alt-site)?'
  ],
  'annex-a.5.31': [
    'Is a register of legal, regulatory, and contractual requirements maintained?',
    'Is it reviewed when laws or contracts change?',
    'Are responsibilities for compliance assigned?'
  ],
  'annex-a.6.3': [
    'Is there an awareness and training programme covering information security?',
    'Are all employees and relevant contractors covered?',
    'Is training refreshed at planned intervals (e.g., annually)?',
    'Are completion records maintained?'
  ],
  'annex-a.6.5': [
    'Is there a documented termination / change-of-employment process covering security responsibilities?',
    'Are access rights revoked promptly when employment ends?',
    'Are organizational assets (laptops, badges) returned and tracked?'
  ],
  'annex-a.6.6': [
    'Are confidentiality / NDAs in place for staff and relevant third parties?',
    'Are obligations clear about what is confidential and for how long?',
    'Are agreements signed before access is granted?'
  ],
  'annex-a.7.4': [
    'Are physical premises monitored to detect unauthorized access (alarms, CCTV, guard, badge logs)?',
    'Is monitoring data retained per policy?',
    'Are alerts triaged and incidents recorded?'
  ],
  'annex-a.8.2': [
    'Are privileged access rights restricted and explicitly granted?',
    'Are privileged sessions logged and monitored?',
    'Are privileged accounts reviewed periodically?',
    'Is shared admin access avoided or tightly controlled?'
  ],
  'annex-a.8.5': [
    'Is multi-factor authentication enforced for sensitive systems and privileged access?',
    'Is authentication strength matched to risk (single factor for low risk, MFA for high)?',
    'Are failed authentication attempts monitored / rate-limited?'
  ],
  'annex-a.8.7': [
    'Are anti-malware controls deployed on relevant endpoints and servers?',
    'Are signatures / detection rules updated automatically?',
    'Are detection alerts triaged and incidents recorded?'
  ],
  'annex-a.8.8': [
    'Is technical vulnerability information collected for systems in use?',
    'Are vulnerabilities triaged by severity and exploitability?',
    'Are patches applied within defined SLAs (or compensating controls in place)?',
    'Is a vulnerability scan performed at planned intervals?'
  ],
  'annex-a.8.13': [
    'Are backups of information, software, and system images taken at defined frequencies?',
    'Are backups protected (encryption, access control, off-site or immutable)?',
    'Is restore tested at planned intervals (not just take-only)?'
  ],
  'annex-a.8.16': [
    'Are network, system, and application logs collected centrally?',
    'Are logs analyzed (manually or via SIEM) for security-relevant events?',
    'Are alerts generated for defined conditions and triaged?',
    'Is log retention defined and enforced?'
  ],
  'annex-a.8.24': [
    'Is there a cryptography policy defining algorithms, key lengths, and key management?',
    'Is encryption applied at rest and in transit per policy?',
    'Are keys managed (generation, storage, rotation, destruction) per policy?'
  ],
  'annex-a.8.28': [
    'Are secure coding practices documented and followed?',
    'Are developers trained in secure coding?',
    'Is code reviewed (peer review, SAST) before production deployment?'
  ],

  // ===== Remaining Annex A.5 organizational controls =====
  'annex-a.5.2': [
    'Are information security roles and responsibilities defined in writing (policy, RACI, job descriptions)?',
    'Are these allocated to specific people or functions?',
    'Are the people in these roles aware of their responsibilities?'
  ],
  'annex-a.5.3': [
    'Have duties whose combination creates risk been identified (e.g., request and approve access; develop and deploy)?',
    'Is segregation enforced through process or system controls?',
    'Where segregation is impractical, are compensating controls (logging, peer review) in place?'
  ],
  'annex-a.5.4': [
    'Are managers expected to ensure their teams understand and apply security responsibilities?',
    'Is this expectation documented (in policy, in job descriptions)?',
    'Are channels available for staff to raise security concerns or questions?'
  ],
  'annex-a.5.5': [
    'Are relevant authorities (regulators, law enforcement, CERT) and the circumstances for contacting them identified?',
    'Are contact details and escalation paths documented and current?',
    'Have responsibilities for making contact been assigned?'
  ],
  'annex-a.5.6': [
    'Are memberships, subscriptions, or participation in special interest groups (ISACs, sector forums, vendor groups) maintained?',
    'Is intelligence from these groups acted on (feeds into risk assessment, controls)?'
  ],
  'annex-a.5.8': [
    'Are information security activities embedded in the project lifecycle (kickoff risk assessment, security requirements, design review, security testing, closure)?',
    'Are security responsibilities defined for project roles?',
    'Are project records (risk assessments, decisions) retained?'
  ],
  'annex-a.5.9': [
    'Is there an inventory of information and associated assets (systems, data sets, devices)?',
    'Does each asset have an assigned owner?',
    'Is the inventory kept current as assets are procured, transferred, or decommissioned?'
  ],
  'annex-a.5.10': [
    'Is there a documented acceptable use policy covering devices, networks, applications, removable media, and information sharing?',
    'Has it been communicated and acknowledged by users?',
    'Are violations addressed through the disciplinary process?'
  ],
  'annex-a.5.11': [
    'Is there a documented off-boarding / transfer process covering return of physical and information assets?',
    'Are access rights revoked at the same time?',
    'Are returns tracked (asset list, signatures)?'
  ],
  'annex-a.5.12': [
    'Is there a documented information classification scheme (e.g., Public / Internal / Confidential / Restricted)?',
    'Is information actually classified by owners?',
    'Is the classification reviewed when value or sensitivity changes?'
  ],
  'annex-a.5.13': [
    'Are labelling procedures defined for the formats in use (documents, emails, databases, removable media)?',
    'Are labels applied in practice (visible on documents, in email subject lines, in metadata)?',
    'Are tools used to automate labelling where possible?'
  ],
  'annex-a.5.14': [
    'Are rules for transferring information (internal and external) defined per classification level?',
    'Are appropriate protective controls used (encryption in transit, secure courier, NDAs)?',
    'Are transfers with third parties covered by agreements?'
  ],
  'annex-a.5.19': [
    'Is there a list of suppliers in scope (those processing org information or providing critical services)?',
    'Are risks assessed for each supplier relationship?',
    'Are security requirements defined and proportional to the relationship?'
  ],
  'annex-a.5.20': [
    'Do supplier agreements include security clauses (confidentiality, incident notification, sub-processor controls, audit rights, data return/destruction)?',
    'Are clauses tailored to the relationship rather than boilerplate-only?',
    'Are agreements reviewed when scope changes?'
  ],
  'annex-a.5.21': [
    'Are security requirements defined for ICT acquisition (hardware, software, services)?',
    'Are supply-chain risks (sub-suppliers, software components, dependencies) considered?',
    'Are these requirements included in procurement and contracts?'
  ],
  'annex-a.5.22': [
    'Is supplier performance and security reviewed against agreements at planned intervals?',
    'Are supplier changes (sub-processor changes, scope changes) controlled and approved?',
    'Are review records retained?'
  ],
  'annex-a.5.23': [
    'Are security requirements for cloud services defined and documented per service?',
    'Is the shared-responsibility split documented for each cloud service in use?',
    'Are exit arrangements (data return / deletion) defined?'
  ],
  'annex-a.5.27': [
    'Are post-incident reviews conducted to identify root causes and improvement opportunities?',
    'Are lessons fed back into ISMS controls, training, monitoring?',
    'Are records of lessons learned and actions retained?'
  ],
  'annex-a.5.28': [
    'Are procedures defined for collecting and preserving evidence (chain of custody, secure storage)?',
    'Are responders trained in evidence handling?',
    'Are tools/processes ready for legally admissible collection if required?'
  ],
  'annex-a.5.32': [
    'Are software licensing obligations tracked?',
    'Are users educated on IPR (no unauthorized copying, software installation)?',
    'Are technical controls in place to restrict unauthorized software installation?'
  ],
  'annex-a.5.33': [
    'Is retention defined for records (regulatory, contractual, business)?',
    'Are records protected against unauthorized access, modification, and loss per classification?',
    'Are records disposed of securely at end of retention?'
  ],
  'annex-a.5.34': [
    'Are applicable privacy laws and contractual obligations (GDPR, DPDP, CCPA, etc.) identified?',
    'Are technical and organizational measures implemented (consent, lawful basis records, DSR processes)?',
    'Are data subject rights (access, deletion, correction) supported in practice?'
  ],
  'annex-a.5.35': [
    'Are independent reviews of information security planned and conducted (internal audit, external assessor)?',
    'Are reviewers independent of the area being reviewed?',
    'Are review outputs fed into management review and improvement?'
  ],
  'annex-a.5.36': [
    'Is compliance with policies, rules, and standards reviewed (self-assessment, internal audit, technical compliance checks)?',
    'Are non-compliances tracked to remediation?',
    'Is the review evidence retained?'
  ],
  'annex-a.5.37': [
    'Are operating procedures documented for routine operations and security-relevant tasks (backup, patch, incident, access)?',
    'Are procedures kept current and accessible to those who need them?',
    'Are procedures reviewed when systems or processes change?'
  ],

  // ===== Annex A.6 — People controls =====
  'annex-a.6.1': [
    'Are background screening requirements defined per role sensitivity?',
    'Is screening completed before access is granted?',
    'Are equivalent expectations applied to contractors and third-party personnel?'
  ],
  'annex-a.6.2': [
    'Do employment and contractor agreements include information security responsibilities?',
    'Do they include post-termination obligations (confidentiality, IPR)?',
    'Are agreements signed before access is granted?'
  ],
  'annex-a.6.4': [
    'Is the disciplinary process for security violations documented?',
    'Has it been communicated to staff?',
    'Is it applied consistently and proportionately?'
  ],
  'annex-a.6.7': [
    'Are remote-working rules documented (locations, device requirements, environment)?',
    'Are technical controls in place (endpoint hardening, secure access, MFA)?',
    'Have remote workers been briefed on the rules?'
  ],
  'annex-a.6.8': [
    'Is there a clear channel for reporting information security events (email, ticket, hotline)?',
    'Have staff been trained on what to report and how?',
    'Are reports acknowledged and acted on within defined timeframes?'
  ],

  // ===== Annex A.7 — Physical controls =====
  'annex-a.7.1': [
    'Are physical security perimeters defined for areas containing information assets?',
    'Are perimeter controls (walls, doors, locks, fences) maintained and inspected?',
    'Are perimeters proportional to the sensitivity of what they protect?'
  ],
  'annex-a.7.2': [
    'Are entry controls (badges, keys, biometric, escorted entry) implemented for restricted areas?',
    'Are visitor logs maintained where appropriate?',
    'Are access rights to physical areas reviewed periodically?'
  ],
  'annex-a.7.3': [
    'Are offices, rooms, and facilities secured according to their sensitivity (locks, restricted lists)?',
    'Are environmental factors (no signage advertising sensitive areas) considered?',
    'Are sensitive rooms (server rooms, SOC) given additional protection?'
  ],
  'annex-a.7.5': [
    'Are physical and environmental threats (fire, flood, power loss, civil events) identified for each location?',
    'Are protective controls in place (suppression systems, UPS, climate control)?',
    'Are detective controls in place (smoke alarms, water sensors, monitoring)?'
  ],
  'annex-a.7.6': [
    'Are rules defined for working in secure areas (escort policy, devices allowed, observation)?',
    'Are these rules communicated to those who work in or visit these areas?',
    'Are logs maintained for entry to secure areas?'
  ],
  'annex-a.7.7': [
    'Is there a clear-desk and clear-screen policy?',
    'Are screen auto-lock timeouts enforced via configuration?',
    'Is awareness reinforced (signage, periodic checks, walk-throughs)?'
  ],
  'annex-a.7.8': [
    'Is equipment sited to reduce environmental and unauthorized-access risks?',
    'Are cabling and physical access to equipment protected?',
    'Are equipment moves controlled to maintain protections?'
  ],
  'annex-a.7.9': [
    'Are rules defined for off-premises use of organizational equipment (laptops, mobile devices)?',
    'Are protections (encryption, MDM, physical security guidance) applied?',
    'Are losses and thefts reported and tracked?'
  ],
  'annex-a.7.10': [
    'Are storage media (USB, removable drives, backup tapes) handled per classification?',
    'Is media securely sanitized or destroyed before disposal or reuse?',
    'Is destruction documented (certificates, logs)?'
  ],
  'annex-a.7.11': [
    'Are supporting utilities (power, cooling, network) provisioned with redundancy or alternatives appropriate to availability needs?',
    'Are UPS / generators tested at planned intervals?',
    'Is utility maintenance scheduled and documented?'
  ],
  'annex-a.7.12': [
    'Is cabling protected from interception and damage (conduits, segregation, secured routing)?',
    'Are cables labeled to support change without errors?',
    'Are cable rooms / risers access-controlled?'
  ],
  'annex-a.7.13': [
    'Is equipment maintained per manufacturer guidance and on schedule?',
    'Are maintenance providers vetted and access-controlled?',
    'Are security controls applied when equipment leaves site for service (data wipe, escort)?'
  ],
  'annex-a.7.14': [
    'Are storage media sanitized or destroyed before disposal or reuse, regardless of cause?',
    'Is the procedure documented and followed (certificates of destruction)?',
    'Are records of disposal retained?'
  ],

  // ===== Annex A.8 — Technological controls =====
  'annex-a.8.1': [
    'Are endpoint security requirements defined (configuration baseline, anti-malware, encryption, screen lock)?',
    'Are endpoints managed (centrally configured, patched, monitored)?',
    'Are equivalent expectations applied to BYOD where allowed?'
  ],
  'annex-a.8.3': [
    'Are technical access controls aligned with the access control policy?',
    'Are restrictions enforced at function and data levels where appropriate?',
    'Are exceptions tracked and reviewed?'
  ],
  'annex-a.8.4': [
    'Is access to source code restricted (repository ACLs, branch protection)?',
    'Are protected branches and review requirements enforced for production code?',
    'Are access rights to source code reviewed periodically?'
  ],
  'annex-a.8.6': [
    'Is system capacity (compute, storage, network) monitored?',
    'Are future capacity needs projected based on growth and business plans?',
    'Are capacity adjustments made before service degrades?'
  ],
  'annex-a.8.9': [
    'Are secure configuration baselines defined for systems in scope (servers, endpoints, network devices)?',
    'Are baselines actually applied (verified by tooling, drift detected)?',
    'Are configuration changes controlled through change management?'
  ],
  'annex-a.8.10': [
    'Is information retention defined per data type?',
    'Are deletion processes implemented (including backups and cloud storage)?',
    'Is deletion documented (logs, certificates) where required?'
  ],
  'annex-a.8.11': [
    'Are masking, anonymization, or pseudonymization techniques used where appropriate (e.g., test environments, analytics)?',
    'Is the approach documented and approved?',
    'Is the technique effective (i.e., re-identification risk considered)?'
  ],
  'annex-a.8.12': [
    'Are DLP measures in place across relevant channels (email, web, endpoint, cloud)?',
    'Are rules tuned to minimize false positives while catching real leakage?',
    'Are alerts triaged and incidents recorded?'
  ],
  'annex-a.8.14': [
    'Are redundancy needs determined from availability and RTO/RPO requirements?',
    'Is redundancy implemented for critical processing facilities?',
    'Is failover tested at planned intervals (not just designed)?'
  ],
  'annex-a.8.15': [
    'Is logging configured for systems based on risk and policy (auth, admin actions, data access)?',
    'Are logs protected from tampering (immutability, access control)?',
    'Are logs retained per defined timeframes?',
    'Are logs analyzed (SIEM, periodic review) for security-relevant events?'
  ],
  'annex-a.8.17': [
    'Are systems synchronized to authoritative time sources (NTP)?',
    'Is time-sync monitored for drift?',
    'Are time stamps consistent across systems for correlation?'
  ],
  'annex-a.8.18': [
    'Is the use of privileged utility programs (e.g., system tools that can override controls) restricted?',
    'Is their use logged and monitored?',
    'Are users of these utilities identified and approved?'
  ],
  'annex-a.8.19': [
    'Is software installation controlled through change management or technical restrictions (allowlisting, restricted permissions)?',
    'Are users prevented from installing unauthorized software on managed endpoints?',
    'Is approved software tracked?'
  ],
  'annex-a.8.20': [
    'Are network security controls (firewalls, hardening, access control) deployed appropriate to risk?',
    'Are network device configurations reviewed and hardened?',
    'Is network access logged and monitored?'
  ],
  'annex-a.8.21': [
    'Are security features identified for each network service in use?',
    'Are these requirements included in agreements when services are outsourced?',
    'Is service security monitored against agreements?'
  ],
  'annex-a.8.22': [
    'Is the network segmented based on risk (e.g., user, server, management, DMZ)?',
    'Is traffic between segments controlled and monitored?',
    'Are segmentation rules documented and reviewed?'
  ],
  'annex-a.8.23': [
    'Is web filtering deployed for users on the corporate network and on managed endpoints?',
    'Are categories blocked aligned with risk (malware, phishing, inappropriate)?',
    'Are exceptions documented and time-limited?'
  ],
  'annex-a.8.25': [
    'Is security integrated into each phase of the development lifecycle (requirements, design, code, test, release, maintain)?',
    'Are security activities documented (threat modeling, security testing)?',
    'Are gates enforced before release?'
  ],
  'annex-a.8.26': [
    'Are security requirements defined upfront for applications (auth, encryption, logging, input validation)?',
    'Are these requirements approved before build or acquisition?',
    'Are they verified before release?'
  ],
  'annex-a.8.27': [
    'Are secure architecture principles documented (defense in depth, least privilege, secure defaults, fail-secure)?',
    'Are these principles applied in design reviews?',
    'Are deviations justified and approved?'
  ],
  'annex-a.8.29': [
    'Is security testing performed throughout development (SAST, DAST, dependency scanning)?',
    'Is penetration testing performed before major releases or annually?',
    'Are findings tracked to remediation with defined SLAs?'
  ],
  'annex-a.8.30': [
    'Are security requirements included in outsourced development agreements?',
    'Are deliverables verified (code review, security testing) before acceptance?',
    'Is supplier development practice assessed (e.g., questionnaires, audits)?'
  ],
  'annex-a.8.31': [
    'Are development, test, and production environments separated technically?',
    'Is promotion between environments controlled (change management, segregation of duties)?',
    'Is production data prevented from leaking to lower environments?'
  ],
  'annex-a.8.32': [
    'Is there a documented change management process covering standard, normal, and emergency changes?',
    'Are changes risk-assessed, approved, tested, and documented?',
    'Are emergency changes reviewed retrospectively?'
  ],
  'annex-a.8.33': [
    'Is production data avoided in test environments where possible?',
    'When production data is used, is it masked, anonymized, or access-restricted?',
    'Is test data managed under the same protections as production where required?'
  ],
  'annex-a.8.34': [
    'Are scope and timing of audit testing on operational systems agreed in advance with system owners?',
    'Are protections in place to minimize disruption (read-only access, off-peak windows)?',
    'Are audit access rights logged and revoked after the audit?'
  ]
};

// Verb-transform rules for the mechanical fallback. Order matters — first match wins.
const VERB_RULES = [
  { re: /^Establish\s+(.+?)([.;]|$)/i,    fn: m => `Has ${lc(m[1])} been established?` },
  { re: /^Define\s+(.+?)([.;]|$)/i,        fn: m => `Has ${lc(m[1])} been defined?` },
  { re: /^Implement\s+(.+?)([.;]|$)/i,     fn: m => `Has ${lc(m[1])} been implemented?` },
  { re: /^Document\s+(.+?)([.;]|$)/i,      fn: m => `Has ${lc(m[1])} been documented?` },
  { re: /^Maintain\s+(.+?)([.;]|$)/i,      fn: m => `Is ${lc(m[1])} maintained?` },
  { re: /^Review\s+(.+?)([.;]|$)/i,        fn: m => `Is ${lc(m[1])} reviewed at planned intervals?` },
  { re: /^Communicate\s+(.+?)([.;]|$)/i,   fn: m => `Has ${lc(m[1])} been communicated?` },
  { re: /^Identify\s+(.+?)([.;]|$)/i,      fn: m => `Has ${lc(m[1])} been identified?` },
  { re: /^Apply\s+(.+?)([.;]|$)/i,         fn: m => `Is ${lc(m[1])} applied?` },
  { re: /^Monitor\s+(.+?)([.;]|$)/i,       fn: m => `Is ${lc(m[1])} monitored?` },
  { re: /^Maintain\s+(.+?)([.;]|$)/i,      fn: m => `Is ${lc(m[1])} maintained?` },
  { re: /^Allocate\s+(.+?)([.;]|$)/i,      fn: m => `Has ${lc(m[1])} been allocated?` },
  { re: /^Assign\s+(.+?)([.;]|$)/i,        fn: m => `Has ${lc(m[1])} been assigned?` },
  { re: /^Manage\s+(.+?)([.;]|$)/i,        fn: m => `Is ${lc(m[1])} managed?` },
  { re: /^Restrict\s+(.+?)([.;]|$)/i,      fn: m => `Is ${lc(m[1])} restricted?` },
  { re: /^Protect\s+(.+?)([.;]|$)/i,       fn: m => `Is ${lc(m[1])} protected?` },
  { re: /^Ensure\s+(.+?)([.;]|$)/i,        fn: m => `Is it ensured that ${lc(m[1])}?` },
  { re: /^Determine\s+(.+?)([.;]|$)/i,     fn: m => `Has ${lc(m[1])} been determined?` },
  { re: /^Provide\s+(.+?)([.;]|$)/i,       fn: m => `Is ${lc(m[1])} provided?` },
  { re: /^Test\s+(.+?)([.;]|$)/i,          fn: m => `Is ${lc(m[1])} tested at planned intervals?` },
  { re: /^Train\s+(.+?)([.;]|$)/i,         fn: m => `Is training in ${lc(m[1])} delivered?` },
  { re: /^Use\s+(.+?)([.;]|$)/i,           fn: m => `Is ${lc(m[1])} used?` }
];
function lc(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

function deriveFromEvidenceNeeded(item) {
  let arr = [];
  try { arr = JSON.parse(item.evidence_needed || '[]'); } catch (e) { return []; }
  return arr.map(line => {
    const trimmed = (line || '').trim();
    if (!trimmed) return null;
    for (const r of VERB_RULES) {
      const m = trimmed.match(r.re);
      if (m) return r.fn(m).replace(/\?\?$/, '?');
    }
    // Fallback: prepend "Are you doing this:"
    return 'Are you doing this: ' + trimmed.replace(/\.$/, '') + '?';
  }).filter(Boolean);
}

// Public API: returns an array of question strings for the given iso_items row.
function getQuestions(item) {
  if (!item || !item.id) return [];
  if (BESPOKE[item.id]) return BESPOKE[item.id];
  return deriveFromEvidenceNeeded(item);
}

module.exports = { getQuestions, BESPOKE };
