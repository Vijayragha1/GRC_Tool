'use strict';

// Firm methodology for assessing every NIST CSF 2.0 Subcategory on two
// independent axes. NIST owns the outcome text and Implementation Examples;
// this file owns the consulting assessment method. It is deliberately called
// "CMMI-aligned" rather than a CMMI appraisal: CMMI capability levels apply
// to practice areas through level 3, while levels 4 and 5 below adapt the
// organizational maturity concepts for evidence-led outcome assessment.

const crypto = require('crypto');
const catalog = require('./nist-csf');

const METHODOLOGY_VERSION = 'CSF-PP-2.0';
const SOURCE_URL = 'https://doi.org/10.6028/NIST.CSWP.29';

const LEVELS = [
  { level: 0, name: 'Incomplete', short: 'Absent or not performed' },
  { level: 1, name: 'Initial', short: 'Ad hoc and person-dependent' },
  { level: 2, name: 'Managed', short: 'Owned, repeatable, and evidenced' },
  { level: 3, name: 'Defined', short: 'Standardized across the agreed scope' },
  { level: 4, name: 'Quantitatively Managed', short: 'Measured and controlled against targets' },
  { level: 5, name: 'Optimizing', short: 'Continuously improved using evidence' },
];

const CATEGORY_PACKS = {
  'GV.OC': {
    focus: 'organizational context and mission dependencies',
    policy: ['mission and strategy records', 'stakeholder and dependency registers', 'legal and contractual obligations register'],
    practice: ['approved business context decisions', 'stakeholder review records', 'business impact and dependency analysis'],
    roles: ['executive sponsor', 'enterprise risk lead', 'legal or compliance owner', 'business service owner'],
    tests: ['Trace a sample of cybersecurity priorities to mission objectives and stakeholder obligations.', 'Reconcile critical services and dependencies to current business impact records.', 'Inspect how a recent organizational or regulatory change altered cyber risk decisions.'],
    metrics: ['percentage of critical services with current context records', 'overdue obligation or dependency reviews', 'context changes incorporated into risk decisions'],
    failures: ['Cybersecurity priorities cannot be traced to business objectives.', 'Stakeholder, legal, or dependency information is stale or incomplete.', 'Context records exist but do not change risk decisions.'],
  },
  'GV.RM': {
    focus: 'cybersecurity risk strategy, appetite, tolerance, and decision criteria',
    policy: ['risk management policy', 'risk appetite and tolerance statements', 'risk methodology and response criteria'],
    practice: ['risk register decisions', 'risk committee records', 'risk calculation and escalation samples'],
    roles: ['executive risk owner', 'enterprise risk lead', 'CISO or security lead', 'business risk owner'],
    tests: ['Reperform a sample of cyber risk ratings using the approved method.', 'Trace risk responses to appetite, tolerance, and escalation criteria.', 'Inspect whether positive and negative risk changes reach the correct decision makers.'],
    metrics: ['risks outside tolerance', 'risk decisions completed within SLA', 'risk method exceptions and overrides'],
    failures: ['Risk appetite is generic or cannot guide a decision.', 'Risk ratings are inconsistent across teams.', 'Risk decisions are not tracked through completion.'],
  },
  'GV.RR': {
    focus: 'accountability, authority, resources, and workforce responsibilities',
    policy: ['governance charter', 'role and authority matrix', 'workforce and resource planning standards'],
    practice: ['committee decisions', 'role acknowledgements', 'resource approvals and workforce lifecycle samples'],
    roles: ['board or executive sponsor', 'CISO', 'human resources lead', 'control or service owner'],
    tests: ['Trace selected cybersecurity decisions to a named accountable authority.', 'Sample role holders for understood duties, competence, and escalation authority.', 'Compare approved resources with risk strategy commitments and delivery evidence.'],
    metrics: ['unassigned accountable roles', 'skills or capacity gaps', 'overdue governance decisions'],
    failures: ['Responsibility is assigned without authority.', 'Key roles depend on undocumented individual knowledge.', 'Resources are not aligned with accepted cyber risk.'],
  },
  'GV.PO': {
    focus: 'cybersecurity policy lifecycle and enforceable requirements',
    policy: ['approved cybersecurity policies', 'policy architecture and ownership register', 'review, exception, and communication procedure'],
    practice: ['policy acknowledgements', 'exception decisions', 'compliance monitoring and enforcement records'],
    roles: ['policy owner', 'CISO', 'compliance lead', 'representative control operators'],
    tests: ['Verify policy approval, scope, ownership, review, and change history.', 'Sample policy requirements to operating controls and enforcement evidence.', 'Inspect how threat, legal, technology, or mission changes triggered policy updates.'],
    metrics: ['policy review timeliness', 'policy exceptions by age and risk', 'policy compliance and breach trends'],
    failures: ['Policies are generic, stale, or lack accountable owners.', 'Requirements are not translated into operating procedures.', 'Policy breaches and exceptions are not governed.'],
  },
  'GV.OV': {
    focus: 'oversight of cybersecurity performance and risk strategy',
    policy: ['oversight charter', 'performance reporting standard', 'management review and escalation criteria'],
    practice: ['board and committee packs', 'KPI and KRI decisions', 'strategy adjustment and follow-through records'],
    roles: ['board or risk committee member', 'executive sponsor', 'CISO', 'enterprise risk lead'],
    tests: ['Trace reported cybersecurity performance to source data and decisions.', 'Inspect whether adverse trends trigger strategy or resource changes.', 'Verify actions from oversight meetings are owned, tracked, and closed.'],
    metrics: ['overdue oversight actions', 'risk indicators outside threshold', 'time from material change to strategy decision'],
    failures: ['Oversight receives activity counts rather than decision-quality measures.', 'Management review does not result in action.', 'Reported information is incomplete or not traceable.'],
  },
  'GV.SC': {
    focus: 'cybersecurity supply chain risk management across the relationship lifecycle',
    policy: ['third-party risk policy', 'supplier security requirements', 'due diligence, monitoring, incident, and exit procedures'],
    practice: ['supplier inventory and tiering', 'due diligence and contract samples', 'monitoring, incident exercise, and termination evidence'],
    roles: ['procurement lead', 'third-party risk owner', 'legal counsel', 'service owner'],
    tests: ['Sample critical suppliers from onboarding through monitoring and exit obligations.', 'Trace supplier risks to contracts, responses, and accepted residual risk.', 'Inspect whether suppliers participate in relevant incident and recovery exercises.'],
    metrics: ['critical suppliers assessed on time', 'unresolved supplier risks', 'contracts meeting security requirements'],
    failures: ['Supplier criticality and services are not understood.', 'Due diligence is questionnaire-only and not risk-based.', 'Security obligations are not monitored after contract signature.'],
  },
  'ID.AM': {
    focus: 'complete, accurate, prioritized, and lifecycle-managed asset information',
    policy: ['asset management standard', 'classification and ownership rules', 'inventory reconciliation and lifecycle procedures'],
    practice: ['hardware, software, service, data, and supplier inventories', 'discovery and reconciliation output', 'asset ownership and lifecycle samples'],
    roles: ['asset management owner', 'IT operations lead', 'data owner', 'business service owner'],
    tests: ['Reconcile sampled assets between authoritative inventories and discovery sources.', 'Trace assets to owners, classification, critical services, and lifecycle status.', 'Test how unauthorized, stale, or unowned assets are detected and resolved.'],
    metrics: ['inventory reconciliation rate', 'unowned or unsupported assets', 'asset record completeness and freshness'],
    failures: ['Inventories disagree without reconciliation.', 'Assets lack business context, ownership, or classification.', 'Retired and externally managed assets remain unmanaged.'],
  },
  'ID.RA': {
    focus: 'threat, vulnerability, likelihood, impact, and risk response analysis',
    policy: ['risk assessment methodology', 'threat and vulnerability management standards', 'change, exception, and disclosure procedures'],
    practice: ['risk assessments', 'threat and vulnerability records', 'risk response and exception samples'],
    roles: ['risk assessor', 'threat intelligence lead', 'vulnerability manager', 'business risk owner'],
    tests: ['Reperform selected risk conclusions from threat, vulnerability, likelihood, and impact evidence.', 'Trace material vulnerabilities and changes into risk and response decisions.', 'Sample acquisitions or disclosures for authenticity, supplier, and response checks.'],
    metrics: ['material risks reassessed on time', 'vulnerabilities outside response SLA', 'risk responses completed or accepted'],
    failures: ['Risk analysis relies on unsupported ordinal scores.', 'Threat and vulnerability sources are disconnected from business impact.', 'Exceptions and risk responses are not tracked.'],
  },
  'ID.IM': {
    focus: 'improvement derived from assessments, exercises, operations, and incidents',
    policy: ['continual improvement procedure', 'exercise and evaluation standard', 'corrective action governance'],
    practice: ['lessons learned', 'assessment and exercise results', 'corrective action and effectiveness records'],
    roles: ['continual improvement owner', 'security operations lead', 'audit or assurance lead', 'control owner'],
    tests: ['Trace selected lessons to approved actions, implementation, and effectiveness checks.', 'Inspect improvements originating from exercises, operations, and third parties.', 'Verify plans are maintained after material operational or threat changes.'],
    metrics: ['improvement actions closed on time', 'repeat findings', 'measured benefit from completed improvements'],
    failures: ['Lessons are recorded without accountable actions.', 'Corrective actions close without effectiveness validation.', 'Plans do not change after tests or incidents.'],
  },
  'PR.AA': {
    focus: 'identity proofing, authentication, authorization, and physical or logical access',
    policy: ['identity and access management standard', 'authentication and authorization requirements', 'access review and lifecycle procedures'],
    practice: ['identity source and access records', 'authentication configurations', 'joiner, mover, leaver and access review samples'],
    roles: ['IAM owner', 'directory or platform administrator', 'HR operations', 'application or facility owner'],
    tests: ['Sample identities through proofing, credential issuance, access approval, review, and revocation.', 'Inspect authentication and assertion protection for representative systems.', 'Attempt or observe enforcement of least privilege, separation, and physical access requirements.'],
    metrics: ['orphaned or excessive access', 'access reviews completed on time', 'authentication coverage and failure trends'],
    failures: ['Access approvals are not tied to role or business need.', 'Authentication requirements are inconsistently enforced.', 'Departed or changed users retain access.'],
  },
  'PR.AT': {
    focus: 'role-appropriate cybersecurity awareness, knowledge, and skills',
    policy: ['awareness and training policy', 'role and competency framework', 'training frequency and exception rules'],
    practice: ['training assignments and completion', 'role-specific curriculum', 'exercise, simulation, and competency results'],
    roles: ['security awareness owner', 'human resources or learning lead', 'specialist role owner', 'sample employees'],
    tests: ['Sample personnel for timely, role-appropriate training and retained completion evidence.', 'Compare training content with current risks and assigned responsibilities.', 'Inspect simulations, exercises, or competency checks and resulting improvements.'],
    metrics: ['training completion and overdue rate', 'simulation and competency results', 'repeat risky behavior by population'],
    failures: ['Training is annual and generic regardless of role.', 'Completion is measured without competency or behavior.', 'Training content does not reflect current threats.'],
  },
  'PR.DS': {
    focus: 'confidentiality, integrity, availability, and recoverability of data',
    policy: ['data protection and classification standard', 'cryptographic and handling requirements', 'backup and restoration standard'],
    practice: ['data flow and storage configurations', 'encryption and key-management evidence', 'backup, restoration, and integrity test results'],
    roles: ['data owner', 'security architect', 'platform administrator', 'backup or recovery owner'],
    tests: ['Sample sensitive data at rest, in transit, and in use against approved protection requirements.', 'Inspect configuration and key-management evidence through authoritative interfaces.', 'Reperform or observe representative backup integrity and restoration tests.'],
    metrics: ['protected data coverage', 'backup and restore success against target', 'data protection exceptions and incidents'],
    failures: ['Protection scope is unknown because data is not inventoried.', 'Screenshots substitute for authoritative configuration evidence.', 'Backups exist but recovery and integrity are unproven.'],
  },
  'PR.PS': {
    focus: 'secure configuration, maintenance, logging, software control, and development',
    policy: ['platform security and configuration standard', 'maintenance and software lifecycle requirements', 'logging and secure development standards'],
    practice: ['baseline and configuration compliance results', 'maintenance and lifecycle records', 'logging, application control, and SDLC evidence'],
    roles: ['platform owner', 'configuration manager', 'software engineering lead', 'security operations lead'],
    tests: ['Compare sampled platforms with approved secure baselines and lifecycle requirements.', 'Inspect enforcement against unauthorized software and unsupported components.', 'Trace selected software changes through secure development, testing, approval, and monitoring.'],
    metrics: ['configuration compliance', 'unsupported component exposure', 'secure development and logging coverage'],
    failures: ['Baselines exist but are not enforced or measured.', 'Unsupported software and hardware lack governed treatment.', 'Logging and secure development are inconsistent across platforms.'],
  },
  'PR.IR': {
    focus: 'resilient security architecture, environment protection, and capacity',
    policy: ['security architecture principles', 'resilience and capacity requirements', 'environmental and network protection standards'],
    practice: ['architecture and network configuration', 'resilience and failover tests', 'capacity, environmental, and availability monitoring'],
    roles: ['security architect', 'network or infrastructure owner', 'business continuity lead', 'facility or cloud service owner'],
    tests: ['Inspect representative architectures for segmentation and unauthorized access resistance.', 'Observe or review failover, resilience, environmental, and capacity tests.', 'Trace resilience requirements to critical services, dependencies, and monitored thresholds.'],
    metrics: ['resilience tests meeting objectives', 'capacity threshold breaches', 'architecture exceptions and single points of failure'],
    failures: ['Architecture diagrams do not reflect implemented environments.', 'Resilience relies on untested assumptions.', 'Capacity and environmental dependencies are not monitored.'],
  },
  'DE.CM': {
    focus: 'monitoring coverage across networks, systems, people, facilities, and providers',
    policy: ['security monitoring standard', 'logging and telemetry requirements', 'monitoring coverage and retention rules'],
    practice: ['telemetry and sensor inventories', 'monitoring platform configurations', 'coverage, health, and alert records'],
    roles: ['security monitoring owner', 'SOC analyst', 'platform owner', 'external service manager'],
    tests: ['Reconcile monitoring requirements with active telemetry across representative assets and providers.', 'Generate or trace known events to confirm collection, alerting, and ownership.', 'Inspect monitoring health, time synchronization, retention, and blind-spot remediation.'],
    metrics: ['critical asset telemetry coverage', 'sensor health and data latency', 'monitoring blind spots and overdue onboarding'],
    failures: ['Monitoring coverage is assumed rather than inventoried.', 'Telemetry is collected but not usable or reviewed.', 'Provider and personnel activity are outside monitoring scope.'],
  },
  'DE.AE': {
    focus: 'correlation, enrichment, analysis, impact estimation, and incident declaration',
    policy: ['event analysis and triage procedure', 'incident declaration criteria', 'threat intelligence integration standard'],
    practice: ['alert and investigation records', 'correlation and enrichment configurations', 'impact, scope, and declaration decisions'],
    roles: ['SOC lead', 'incident commander', 'threat intelligence analyst', 'business service owner'],
    tests: ['Sample adverse events from detection through analysis, enrichment, scope, and disposition.', 'Reperform incident declaration decisions against approved criteria.', 'Inspect whether threat and business context change prioritization and response.'],
    metrics: ['time to triage and declare incidents', 'alert disposition quality', 'events with complete scope and impact analysis'],
    failures: ['Alerts are closed without sufficient analysis.', 'Incident declaration depends on individual judgement without criteria.', 'Threat and business context are not integrated.'],
  },
  'RS.MA': {
    focus: 'coordinated incident response execution, triage, prioritization, escalation, and recovery initiation',
    policy: ['incident response plan', 'triage and escalation procedure', 'recovery initiation criteria'],
    practice: ['incident tickets and timelines', 'escalation and command decisions', 'exercise and third-party coordination evidence'],
    roles: ['incident commander', 'SOC lead', 'service owner', 'relevant supplier contact'],
    tests: ['Sample incidents for validated triage, categorization, prioritization, and escalation.', 'Trace declared incidents to coordinated plan execution and third-party participation.', 'Inspect application of recovery initiation criteria in incidents or exercises.'],
    metrics: ['time to validate and escalate', 'incidents meeting response SLA', 'exercise actions and coordination failures'],
    failures: ['Plans do not match actual responders and systems.', 'Triage and escalation decisions are undocumented.', 'Suppliers and recovery teams enter too late.'],
  },
  'RS.AN': {
    focus: 'incident investigation, root cause, evidence provenance, and magnitude validation',
    policy: ['incident investigation procedure', 'forensic evidence handling standard', 'root cause and magnitude analysis requirements'],
    practice: ['investigation records', 'evidence chain-of-custody and provenance', 'root cause and magnitude conclusions'],
    roles: ['incident investigator', 'forensic lead', 'legal or privacy counsel', 'affected service owner'],
    tests: ['Sample investigations for complete timelines, actions, evidence integrity, and provenance.', 'Challenge selected root-cause and magnitude conclusions against underlying evidence.', 'Inspect preservation, access, retention, and handoff of incident data.'],
    metrics: ['investigations with validated root cause', 'evidence integrity exceptions', 'time to establish incident magnitude'],
    failures: ['Root cause is asserted without defensible analysis.', 'Investigation actions and evidence provenance are incomplete.', 'Magnitude estimates are not validated with service owners.'],
  },
  'RS.CO': {
    focus: 'lawful, timely, approved incident notification and information sharing',
    policy: ['incident communication plan', 'notification decision matrix', 'approved stakeholder and information-sharing procedures'],
    practice: ['notification decisions and messages', 'stakeholder contact and approval records', 'regulatory, customer, and partner communications'],
    roles: ['incident communications lead', 'legal or privacy counsel', 'executive approver', 'external affairs owner'],
    tests: ['Sample incidents for timely notification decisions against legal, contractual, and policy triggers.', 'Verify message approval, recipients, timing, and retained evidence.', 'Inspect exercises covering unavailable contacts, changing facts, and third-party coordination.'],
    metrics: ['notifications made within obligation', 'communication approval time', 'exercise communication issues'],
    failures: ['Notification obligations are not mapped to incidents.', 'Contact and approval paths are stale.', 'Messages are not retained or factually controlled.'],
  },
  'RS.MI': {
    focus: 'timely containment and eradication of incident effects',
    policy: ['containment and eradication playbooks', 'decision authority and safety constraints', 'validation and exception requirements'],
    practice: ['containment and eradication actions', 'technical validation results', 'decision timelines and residual-risk records'],
    roles: ['incident commander', 'technical response lead', 'system owner', 'business continuity owner'],
    tests: ['Sample incidents or exercises for timely, authorized containment and eradication.', 'Verify actions addressed scope and did not create unacceptable operational harm.', 'Inspect technical validation that threat persistence and affected assets were addressed.'],
    metrics: ['time to contain and eradicate', 'reopened incidents or persistence findings', 'playbook coverage and exercise results'],
    failures: ['Containment decisions lack authority or business context.', 'Eradication closes without technical validation.', 'Playbooks are generic or untested.'],
  },
  'RC.RP': {
    focus: 'prioritized, integrity-verified restoration and controlled return to normal operations',
    policy: ['incident recovery plan', 'restoration priority and integrity criteria', 'return-to-operation and closure procedure'],
    practice: ['recovery execution records', 'backup and restoration validation', 'business acceptance and recovery closure decisions'],
    roles: ['recovery manager', 'service owner', 'backup or infrastructure owner', 'business continuity lead'],
    tests: ['Sample incidents or exercises for risk-based recovery priorities and dependencies.', 'Observe or inspect restoration integrity testing before and after recovery.', 'Verify return-to-normal and recovery closure decisions against approved criteria.'],
    metrics: ['recovery objectives achieved', 'restoration integrity failures', 'time to business acceptance and closure'],
    failures: ['Recovery order conflicts with business priorities.', 'Restoration assets are used without integrity checks.', 'Technical restoration is confused with business recovery.'],
  },
  'RC.CO': {
    focus: 'approved communication of recovery status, capability, and public information',
    policy: ['recovery communication plan', 'status reporting and public messaging procedure', 'stakeholder approval and contact matrix'],
    practice: ['recovery status reports', 'stakeholder and public communications', 'message approval and exercise records'],
    roles: ['recovery communications lead', 'service owner', 'executive approver', 'public or customer affairs owner'],
    tests: ['Sample recovery events for accurate, timely, approved stakeholder updates.', 'Trace public messages to verified recovery facts and approval.', 'Inspect exercises for evolving recovery estimates and unavailable communication channels.'],
    metrics: ['recovery updates delivered on schedule', 'message corrections or approval delay', 'stakeholder satisfaction or escalation'],
    failures: ['Recovery status is not reconciled with technical and business owners.', 'Public messages lack approval or verified facts.', 'Stakeholder expectations and channels are not maintained.'],
  },
};

function splitExamples(value) {
  return String(value || '')
    .split(/\s+Ex\d+:\s*/)
    .map(v => v.replace(/^Ex\d+:\s*/, '').trim())
    .filter(Boolean);
}

function shortOutcome(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  return text.charAt(0).toLowerCase() + text.slice(1).replace(/[.]$/, '');
}

function anchorsFor(code, description, pack) {
  const outcome = shortOutcome(description);
  const practiceCue = pack.practice[0];
  return {
    policy: {
      0: `${code}: No approved requirement, ownership, or governance basis addresses whether ${outcome}.`,
      1: `${code}: Expectations that ${outcome} are informal, draft, fragmented, or dependent on individual knowledge.`,
      2: `${code}: An approved, scoped requirement defines how ${outcome}, with an owner, review cadence, and governed exceptions.`,
      3: `${code}: Organization-wide standards, procedures, roles, training, and exception rules consistently govern how ${outcome}.`,
      4: `${code}: Compliance with requirements for how ${outcome} is measured against thresholds, trended, and reviewed by accountable management.`,
      5: `${code}: Requirements for how ${outcome} are continuously improved using quantitative performance, incidents, tests, threat change, and stakeholder needs.`,
    },
    practice: {
      0: `${code}: There is no credible evidence that ${outcome} within the agreed scope.`,
      1: `${code}: Some evidence suggests ${outcome}, but execution is partial, inconsistent, or person-dependent.`,
      2: `${code}: ${practiceCue} demonstrate that ${outcome} repeatably in the defined scope, with ownership and retained records.`,
      3: `${code}: Representative testing shows that ${outcome} consistently across the agreed scope using standardized methods.`,
      4: `${code}: Effectiveness of how ${outcome} is measured against defined targets, exceptions are controlled, and performance is predictable.`,
      5: `${code}: Quantitative results and repeated testing demonstrate that how ${outcome} is continuously adapted and measurably improved.`,
    },
  };
}

function buildMethodology() {
  const rows = [];
  for (const fn of catalog.FUNCTIONS) {
    for (const category of fn.categories) {
      const pack = CATEGORY_PACKS[category.code];
      if (!pack) throw new Error(`Missing category methodology for ${category.code}`);
      for (const sub of category.subcategories) {
        const anchors = anchorsFor(sub.code, sub.description, pack);
        const examples = splitExamples(sub.implementation_examples);
        const outcome = shortOutcome(sub.description);
        const row = {
          methodology_version: METHODOLOGY_VERSION,
          function_code: fn.code,
          function_name: fn.name,
          category_code: category.code,
          category_name: category.name,
          code: sub.code,
          outcome: sub.description,
          focus: pack.focus,
          implementation_examples: examples,
          policy_anchors: anchors.policy,
          practice_anchors: anchors.practice,
          policy_evidence: [...pack.policy, `approved requirements specifically governing ${sub.code}`],
          practice_evidence: [...pack.practice, `time-bounded operating records demonstrating that ${outcome}`],
          interview_roles: [...pack.roles],
          test_procedures: pack.tests.map((t, i) => `${sub.code}-T${i + 1}: ${t}`),
          measures: pack.metrics.map(m => `${sub.code}: ${m}`),
          failure_indicators: [...pack.failures, `Assertions about ${sub.code} are not supported by relevant, reliable, sufficient, and period-appropriate evidence.`],
          policy_questions: [
            `What approved requirements, ownership, scope, and review arrangements govern ${sub.code}?`,
            `How are exceptions and changes affecting ${sub.code} approved and monitored?`,
            `What measures tell management whether policy requirements for ${sub.code} remain adequate?`,
          ],
          practice_questions: [
            `Show how ${sub.description.toLowerCase()} during the assessment period.`,
            `Which populations, systems, services, locations, or suppliers are inside and outside the implementation scope?`,
            `How has testing or performance information changed the operation of ${sub.code}?`,
          ],
          evidence_gates: {
            0: 'A zero requires affirmative evidence of absence or non-performance; otherwise use Not assessed or No visibility.',
            1: 'Interviews, drafts, or isolated examples may support Initial, but confidence must be recorded.',
            2: 'Requires approved ownership for Policy and retained operating records for Practice; interview-only evidence is insufficient.',
            3: 'Requires current approved standards plus a representative sample demonstrating consistent operation across the agreed scope.',
            4: 'Requires defined measures, targets, trends, exceptions, and management review of effectiveness.',
            5: 'Requires repeated evidence that measured learning and improvement changed the practice and improved results.',
          },
        };
        row.content_hash = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
        rows.push(row);
      }
    }
  }
  return rows;
}

const OUTCOMES = buildMethodology();
const BY_CODE = new Map(OUTCOMES.map(row => [row.code, row]));
const CATALOG_HASH = crypto.createHash('sha256').update(JSON.stringify(catalog.FUNCTIONS)).digest('hex');
const METHODOLOGY_HASH = crypto.createHash('sha256').update(JSON.stringify(OUTCOMES)).digest('hex');

function forCode(code) {
  return BY_CODE.get(code) || null;
}

module.exports = {
  METHODOLOGY_VERSION,
  SOURCE_URL,
  LEVELS,
  CATEGORY_PACKS,
  OUTCOMES,
  CATALOG_HASH,
  METHODOLOGY_HASH,
  forCode,
};
