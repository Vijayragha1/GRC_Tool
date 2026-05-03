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
