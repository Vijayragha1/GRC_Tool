// Audit-grade content per ISO 27001:2022 clause / Annex A control.
//
// Voice: junior consultant doing a gap assessment, writing for another
// junior who will run the next assessment. Specific over generic. Avoid
// LLM-shaped checklist bullets. Avoid "robust", "leverage", "ensure".
//
// Each entry has the same shape:
//   purpose                - one short paragraph: what is this clause/control
//                            actually trying to achieve, in plain English
//   what_good_looks_like   - one paragraph painting a credible mid-size-org
//                            implementation
//   common_pitfalls        - array of strings, 4-6 specific failure modes
//                            (real audit findings, not hypotheticals)
//   evidence_to_look_for   - array of {item, what_it_tells_you}
//   scoping_notes          - short paragraph on common carve-outs and
//                            structure decisions
//   maturity_ladder        - {1,2,3,4} concrete description per CMMI level
//   related_items          - array of iso_item_ids the auditor will check
//                            alongside this one
//
// Items not present here fall back to the legacy summary/evidence_needed
// fields. Goal is to fill all 118 entries, prioritised:
//   Pass 1: 25 main-body clauses (4-10)
//   Pass 2: 30 highest-impact Annex A controls
//   Pass 3: remaining 63 controls

module.exports = {
  // ===================================================================
  // CLAUSE 4 - CONTEXT OF THE ORGANIZATION
  // ===================================================================
  'clause-4.1': {
    purpose: "This clause forces the organization to write down why its ISMS exists and what shapes it. Without it, every other clause is making assumptions that no one has tested. It's the input to risk assessment (6.1), scope (4.3), and objectives (6.2).",
    what_good_looks_like: "A context register (or a section of the ISMS scope document) lists 5-15 substantive issues - not generic boilerplate like \"we operate in a regulated industry\", but specific items like \"GDPR Art. 33 breach-notification deadline of 72h\", \"our biggest customer requires SOC 2 Type II by 2026\", \"our primary data centre is in a flood zone\". Each issue is traceable somewhere downstream - a risk in the register, a control in the SoA, an objective. Climate change is explicitly listed as determined-relevant or determined-not-relevant, with a one-line rationale (Amendment 1:2024). The register is reviewed when something material happens (acquisition, new product, regulatory change), not just on a calendar.",
    common_pitfalls: [
      "Generic PESTLE/SWOT boilerplate that could apply to any company - auditors spot this in 30 seconds",
      "Climate change not addressed at all (Amendment 1:2024 is new; orgs certified pre-2024 often haven't added it)",
      "Register exists but no risk in the risk register references it - implies it wasn't actually used",
      "\"Reviewed annually\" with the only review being the one written at certification",
      "Confusing context (4.1) with interested parties (4.2) - auditors test you can articulate the difference"
    ],
    evidence_to_look_for: [
      { item: "Context register or scope-document section listing the issues", what_it_tells_you: "Whether the determination was actually done and whether it's organisation-specific" },
      { item: "Workshop minutes or stakeholder-analysis records showing how the issues were determined", what_it_tells_you: "Whether the process was real or post-rationalised" },
      { item: "Two or three risks in the register that demonstrably trace back to a context issue", what_it_tells_you: "Whether the context analysis fed into risk treatment" },
      { item: "Management review minutes from the last 12 months where context was a discussion item", what_it_tells_you: "Whether the register is alive or fossilised" }
    ],
    scoping_notes: "Some organizations capture context inside the ISMS scope statement; others maintain a separate register. Both are acceptable. What's not acceptable is having no documented determination at all, or documenting it once and never revisiting. Climate-change consideration is mandatory post-Amendment 1:2024 - if your last cert was before that date, expect to add it before the next surveillance.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a one-page context register listing 5-10 organisation-specific issues (not boilerplate), with climate change explicitly flagged as relevant or not-relevant with a one-line rationale per Amendment 1:2024. At least two of those issues visibly feed into the risk register so an auditor can trace the chain. Dated review within the last 12 months.",
    maturity_ladder: {
      1: "Context discussed verbally; nothing written, or what's written is generic boilerplate",
      2: "Specific organisation-tailored register exists; reviewed at planned intervals",
      3: "Register feeds risk assessment, scope, and objectives; updates triggered by material events, not just calendar",
      4: "Context monitoring is proactive (regulatory horizon scanning, market intelligence); volatility tracked as a metric"
    },
    related_items: ["clause-4.2", "clause-4.3", "clause-6.1.1", "clause-9.3"]
  },

  // ===================================================================
  // ANNEX A - ORGANIZATIONAL CONTROLS - A.5.x
  // ===================================================================
  'clause-4.2': {
    purpose: "4.1 is about the issues that surround the organization. 4.2 is about the people and entities that care what the organization does - regulators, customers, employees, suppliers, certification bodies - and what they specifically require. The output of this clause feeds 4.3 (scope), 6.1.1 (risks), 7.4 (communication), and 9.3 (MR).",
    what_good_looks_like: "A register of interested parties and their requirements: who they are, what they require (legal, regulatory, contractual, commercial), and where in the ISMS that requirement is addressed. A real register has 10-25 entries - regulator names with the specific articles that bind you, key customers with the contractual security clauses they impose, employees with what they're entitled to expect (whistleblower channel, privacy at work). Updated when contracts are signed, regulations change, or major customers come/go. Climate-related obligations (Amendment 1:2024) are captured where they apply.",
    common_pitfalls: [
      "Conflating 4.1 (issues) with 4.2 (parties) - auditors test whether you can articulate the difference",
      "Generic list of \"customers, employees, regulators\" without specifying which ones and what they require",
      "Contract requirements not extracted into the register (\"we have an MSA with Customer X\" isn't enough - auditors want the security clauses themselves)",
      "Not updated when a major contract or regulation changes",
      "Climate-related obligations missed (Amendment 1:2024)"
    ],
    evidence_to_look_for: [
      { item: "The register of interested parties with their specific requirements", what_it_tells_you: "Whether the determination is real or boilerplate" },
      { item: "Two contract excerpts that have been mapped into the register", what_it_tells_you: "Whether contractual requirements are actively tracked" },
      { item: "A regulator-mapping showing which articles of which laws are applicable", what_it_tells_you: "Whether the legal team has done the work or it's been hand-waved" },
      { item: "Evidence the register was updated in the last 12 months", what_it_tells_you: "Whether it's living or fossilised" }
    ],
    scoping_notes: "Most organizations maintain a separate register; some embed it in the scope statement. Either is acceptable. What's not acceptable is a list of names without their requirements, or a list of requirements without naming the parties.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a register of 10-15 interested parties with their specific requirements - named regulators with cited articles, named key customers with the security clauses they impose, employees with what they're entitled to expect. Each requirement points to where in the ISMS it is addressed. Updated at least once in the past 12 months.",
    maturity_ladder: {
      1: "Awareness of who the parties are; nothing documented",
      2: "Register exists with parties + requirements; reviewed at intervals",
      3: "Register integrated with risk assessment, communication plan, MR; updated on contract / regulatory triggers",
      4: "Continuous monitoring of regulatory horizon; customer-requirement intake automated; obligations tied to control coverage"
    },
    related_items: ["clause-4.1", "clause-4.3", "clause-6.1.1", "clause-7.4", "clause-9.3"]
  },

  'clause-4.3': {
    purpose: "Defines what the ISMS covers and - equally important - what it doesn't. Every other clause depends on this answer. Scope decisions trade audit cost against business coverage; getting it wrong costs the organization either money (over-scoped) or credibility (under-scoped vs. customer expectations).",
    what_good_looks_like: "A 1-3 page scope statement covering: products and services in scope, locations, organizational units, technology, exclusions with rationale. Considers context (4.1) and interested-party requirements (4.2). Names interfaces and dependencies with other organizations (parent company, sister BUs, key suppliers). Clear and unambiguous - a reader can put any system / location / process in or out of scope based on the statement alone.",
    common_pitfalls: [
      "Scope written so broadly (\"all of organisation\") that the SoA can't possibly be true",
      "Scope written so narrowly that customers reject the certificate as not covering what they care about",
      "Exclusions stated without rationale (\"R&D is excluded\" without why)",
      "Interfaces and dependencies not addressed - required by 4.3 but routinely skipped",
      "Scope written once at certification and not revisited despite acquisitions, divestments, new products"
    ],
    evidence_to_look_for: [
      { item: "The scope statement document", what_it_tells_you: "Whether scope is precise enough to act on" },
      { item: "Org chart marking in-scope vs out-of-scope entities and BUs", what_it_tells_you: "Whether the scope is operationally clear" },
      { item: "Site list with in-scope flag", what_it_tells_you: "Physical scope is unambiguous" },
      { item: "Exclusion rationales - for each exclusion, why it's out", what_it_tells_you: "Whether exclusions are defensible or arbitrary" },
      { item: "Evidence of scope review in the last 12 months (or at the last material event)", what_it_tells_you: "Whether scope is alive" }
    ],
    scoping_notes: "Scope can be by product, by location, by organizational unit, by system, or any combination. Cert audits will sample across scope boundaries to verify they are sustainable. A \"Boston-only\" scope when 80% of staff are remote is fragile - auditors will probe.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a signed 1-3 page scope statement naming products/services, locations, organisational units, and technology in scope, with any exclusions justified. Interfaces with out-of-scope parties (parent, sister BUs, key suppliers) are described. No ambiguity about whether a given system, location, or process is in or out.",
    maturity_ladder: {
      1: "Scope discussed but not documented, or generic",
      2: "Documented scope statement; reviewed at intervals; exclusions justified",
      3: "Scope tied to context and interested parties; interfaces named; reviewed on material events",
      4: "Scope under change-control; scope-impact assessment for any major business change (M&A, new product)"
    },
    related_items: ["clause-4.1", "clause-4.2", "clause-4.4", "clause-6.1.3", "clause-8.1"]
  },

  'clause-4.4': {
    purpose: "The umbrella clause. Says the ISMS itself must be established, implemented, maintained, and continually improved - and the processes within it must interact. It's the clause that holds 6 (planning), 8 (operation), 9 (eval), and 10 (improvement) together as one system rather than disconnected modules.",
    what_good_looks_like: "A documented ISMS structure - often called an \"ISMS manual\" or operations document - that maps the major processes (risk assessment, internal audit, management review, NC management, corrective action) and shows how they interact (e.g., audit findings flow to NCs, NCs flow to corrective actions, corrective actions get verified at the next audit cycle). Records demonstrate the ISMS is operating: recent risk assessments, audit reports, MR minutes, NC closures, improvement actions.",
    common_pitfalls: [
      "Treating 4.4 as just \"have a policy and SoA\" without showing process interaction",
      "No process map or systems-view of the ISMS - each process operates in silo",
      "ISMS manual exists but doesn't reflect actual practice",
      "No records of recent ISMS operation (audits, MR, NC) - looks like a paper system"
    ],
    evidence_to_look_for: [
      { item: "ISMS manual or process map showing how processes interact", what_it_tells_you: "Whether the org thinks of the ISMS as a system" },
      { item: "Audit programme covering ISMS processes over a multi-year cycle", what_it_tells_you: "ISMS is being checked end-to-end" },
      { item: "Recent risk assessment + linked NCs + linked corrective actions", what_it_tells_you: "Process linkage is actually working" },
      { item: "MR minutes that reference outputs from each ISMS process", what_it_tells_you: "Top management sees the ISMS as one thing" }
    ],
    scoping_notes: "Many orgs use a single ISMS manual; others distribute the description across SOPs and reference them from a top-level policy. Both are acceptable. What matters is that the auditor can trace the system - not just inspect each part.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: clauses 4-10 are all addressed in the ISMS, with documented evidence the processes interact - risk outputs feed treatment plans, monitoring feeds management review, MR drives improvements. No clause is conspicuously empty. The ISMS is recognisably one connected system rather than a folder of disconnected documents.",
    maturity_ladder: {
      1: "ISMS components exist but no integration",
      2: "ISMS manual or process map documented; processes named",
      3: "Process interaction visible in records; outputs of one process feed inputs of another",
      4: "End-to-end metrics across ISMS processes (e.g., NC-to-closure time, audit-to-improvement time) tracked and reviewed"
    },
    related_items: ["clause-6.1", "clause-8.1", "clause-9.1", "clause-9.2", "clause-9.3", "clause-10.1"]
  },

  'clause-5.1': {
    purpose: "Forces top management to be visibly accountable for the ISMS. The most common reason ISMSs fail audits - and fail to deliver real security - is that they're treated as IT's project rather than a business obligation. This clause is the antidote.",
    what_good_looks_like: "Top management has approved the policy with a signature and date. Resources (budget, headcount, tools) are allocated and the allocation is visible. ISMS roles are held accountable by top management - not just appointed. Top management attends MR and the minutes show real engagement (questions, decisions, challenges). The importance of the ISMS has been communicated to staff in a way that connects to business priorities, not as a compliance ritual.",
    common_pitfalls: [
      "Policy signed by the IT Director or CISO instead of top management",
      "MR minutes show top-management invited but absent for half the meeting",
      "ISMS treated as compliance theatre - no resource allocation visible, no accountability for outcomes",
      "No record of top-management communication about the ISMS to staff",
      "\"Top management\" defined as the CISO - that's not top management"
    ],
    evidence_to_look_for: [
      { item: "Information Security Policy with top-management sign-off and date", what_it_tells_you: "Whether top management has formally committed" },
      { item: "MR minutes from the last 12 months showing top-management attendance and engagement", what_it_tells_you: "Whether commitment is sustained" },
      { item: "Budget records showing ISMS allocation distinct from general IT", what_it_tells_you: "Whether resources are real" },
      { item: "Communication record where top management addressed the ISMS to staff (all-hands, town hall, written)", what_it_tells_you: "Whether importance is conveyed beyond the policy doc" },
      { item: "Performance objectives or scorecards holding ISMS-role holders accountable", what_it_tells_you: "Whether accountability is operational" }
    ],
    scoping_notes: "Top management means the highest level of decision-making for the entity in scope - not the CISO unless they sit on the executive team. For a subsidiary in scope, the subsidiary's top management is the relevant party (with corporate engagement evident through other channels).",
    minimum_certifiable: "Smallest version that will still pass Stage 2: top management can name the ISMS owner, the security policy, and the most recent management-review outcomes without prompting. Evidence of at least one leadership-level security decision in the last 12 months (resource allocation, scope change, risk acceptance). The ISMS is not delegated wholesale to IT.",
    maturity_ladder: {
      1: "Top management aware of ISMS; engagement informal",
      2: "Policy signed; MR attended; resources allocated",
      3: "Top management visibly drives ISMS priorities; accountability flows from MR to operations",
      4: "ISMS performance is on the executive scorecard; top management challenges and changes ISMS direction based on data"
    },
    related_items: ["clause-5.2", "clause-5.3", "clause-6.2", "clause-7.1", "clause-9.3"]
  },

  'clause-5.2': {
    purpose: "Requires a published Information Security Policy approved by top management - the document that articulates the ISMS's purpose and direction in language the whole organization can understand. It's both a governance artifact and a communication tool.",
    what_good_looks_like: "A 2-5 page policy stating ISMS purpose, the framework for setting objectives, commitment to satisfy applicable requirements, and commitment to continual improvement. Approved by top management with a date. Published where staff can find it (intranet, induction pack). Communicated proactively - staff know it exists and roughly what it says. Reviewed at least annually and after material change. Made available to relevant interested parties as appropriate.",
    common_pitfalls: [
      "Policy is 30 pages because it tries to cover topic-specific rules - those belong in topic-specific policies (A.5.1)",
      "No top-management signature or no date",
      "Not communicated - staff have never heard of it",
      "No review cycle, or last review was at certification",
      "Doesn't reference applicable requirements or continual improvement (the two specific commitments 5.2 calls for)"
    ],
    evidence_to_look_for: [
      { item: "The policy document itself with sign-off page", what_it_tells_you: "Whether the formal approval exists" },
      { item: "Communication evidence (intranet posting, induction materials, all-hands slides)", what_it_tells_you: "Whether staff have been told" },
      { item: "Policy review record (typically annual review minutes)", what_it_tells_you: "Whether the policy is maintained" },
      { item: "Sample staff awareness check - ask three staff what the policy commits to", what_it_tells_you: "Whether communication worked" }
    ],
    scoping_notes: "Most organizations have one master Information Security Policy under 5.2, plus topic-specific policies under A.5.1 (access control, cryptography, supplier, etc.). The 5.2 deliverable is the master.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a signed information-security policy issued by top management, dated within the last 12-24 months, communicated to staff (intranet posting plus onboarding inclusion is enough), and referenced as the umbrella in the policy framework. Includes explicit commitments to continual improvement and to legal/regulatory compliance.",
    maturity_ladder: {
      1: "Policy drafted; not approved or not communicated",
      2: "Approved, published, communicated; annual review",
      3: "Reviewed on schedule and on material change; staff awareness measurable; policy traceable to objectives",
      4: "Policy continuously improved; effectiveness measured (e.g., staff understanding surveys)"
    },
    related_items: ["clause-5.1", "clause-5.3", "clause-7.4", "clause-7.5", "clause-9.3", "annex-a.5.1"]
  },

  'clause-5.3': {
    purpose: "Without clear assignment of ISMS roles, things fall through the cracks at audit time. This clause forces the organization to name who owns the ISMS, who owns each control, who owns each asset, who owns each risk - and ensure those people know.",
    what_good_looks_like: "Documented roles for the ISMS: a CISO or equivalent, an ISM (operational lead), control owners for major control families, asset owners, risk owners. Responsibilities, authorities, and reporting lines are specified. People in those roles have been told (in writing, e.g., job description, appointment letter, or kickoff email). Conflicts of duty are considered - segregation between request-and-approve, develop-and-deploy, audit-and-be-audited.",
    common_pitfalls: [
      "Roles defined in policy but never assigned to actual humans",
      "Outdated as people leave - leaver process doesn't update ISMS role assignments",
      "Segregation of duties not addressed (one person both owns and audits the same control)",
      "\"ISMS Manager\" exists but no clarity on what they decide vs. what's escalated",
      "Risk owners assigned in the risk register but those people don't know they're risk owners"
    ],
    evidence_to_look_for: [
      { item: "RACI chart or role-responsibility matrix for ISMS", what_it_tells_you: "Whether roles are mapped to people" },
      { item: "Org chart showing ISMS reporting lines", what_it_tells_you: "Whether escalation paths are clear" },
      { item: "Sample job description or appointment letter for an ISMS role", what_it_tells_you: "Whether the role-holder was formally told" },
      { item: "Communication record confirming risk owners have been notified", what_it_tells_you: "Whether risk-owner accountability is real" },
      { item: "Segregation analysis - list of role conflicts and how they're addressed", what_it_tells_you: "Whether SoD is taken seriously" }
    ],
    scoping_notes: "Small organizations often have one person wearing multiple hats. That's acceptable - but conflicts must be addressed through compensating controls (peer review, automated logging, periodic external check). Document the basis.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented allocation of ISMS roles - at minimum a named ISMS owner, a risk-acceptance authority, and a person responsible for reporting ISMS performance to top management. Communicated via job descriptions or a roles-and-responsibilities document. Top management can name the ISMS owner without prompting when asked by the auditor.",
    maturity_ladder: {
      1: "Roles informal; some people know who owns what",
      2: "RACI or matrix exists; roles communicated to holders",
      3: "Updated on JML; SoD analysis maintained; role-holders accountable in performance terms",
      4: "Roles automated against HR systems (changes propagate); conflict detection automated"
    },
    related_items: ["clause-5.1", "clause-7.2", "clause-7.3", "annex-a.5.2", "annex-a.5.3"]
  },

  'clause-6.1.1': {
    purpose: "Requires the organization to determine the risks and opportunities the ISMS must address - not the same as the information-security risk assessment in 6.1.2. 6.1.1 is the strategic/system-level question: what could prevent the ISMS itself from achieving its outcomes? What opportunities should it pursue?",
    what_good_looks_like: "A documented identification of ISMS-level risks (\"key auditor leaves\", \"insufficient budget post-restructure\", \"new regulation invalidates current methodology\") and opportunities (\"adopting framework X would simplify supplier audits\", \"automating evidence collection would close monitoring gaps\"). Actions to address are planned, integrated into ISMS processes, and reviewed.",
    common_pitfalls: [
      "Confused with 6.1.2 - the team writes a risk assessment and calls it 6.1.1",
      "No opportunities identified at all - the clause requires both",
      "Actions written down and never executed",
      "Not integrated - the risks/opportunities sit on a register that nothing references"
    ],
    evidence_to_look_for: [
      { item: "Documented ISMS-level risks and opportunities", what_it_tells_you: "Whether the broader question has been considered" },
      { item: "Action plan derived from the risks and opportunities", what_it_tells_you: "Whether the determination drove planning" },
      { item: "MR minutes referencing 6.1.1 risks and opportunities", what_it_tells_you: "Whether this is alive in governance" }
    ],
    scoping_notes: "Many organizations combine 6.1.1 outputs with their information-security risk register. That's pragmatic - but be ready to point at the ISMS-level entries when an auditor asks specifically about 6.1.1 vs. 6.1.2.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: documented planning that addresses the risks and opportunities identified from context (4.1) and interested parties (4.2), with actions integrated into the ISMS via risk treatment, objectives, or communication. Effectiveness of those actions is evaluated at least once per cycle.",
    maturity_ladder: {
      1: "Implicit; not documented",
      2: "Documented risks and opportunities; actions planned",
      3: "Integrated into ISMS processes; reviewed in MR",
      4: "Continuous identification driven by horizon scanning; opportunities tracked as a portfolio"
    },
    related_items: ["clause-4.1", "clause-4.2", "clause-6.1.2", "clause-6.1.3", "clause-8.2", "clause-9.3"]
  },

  'clause-6.1.2': {
    purpose: "Requires a documented risk-assessment methodology that produces consistent, valid, and comparable results - and that the methodology is actually applied. The methodology is the thing audited; the assessment is the proof it's been applied.",
    what_good_looks_like: "A 5-15 page methodology covering: scales (likelihood, impact) with explicit definitions, risk-acceptance criteria, asset / threat / vulnerability identification approach, risk-owner assignment rules. Methodology referenced in actual risk assessments. Two assessments by different teams or different time periods produce comparable outputs (same format, same scales, same evaluation logic). Risk owners are real people who know they're owners.",
    common_pitfalls: [
      "Methodology written but never applied - the risk register doesn't follow it",
      "Methodology applied inconsistently - different teams use different scales or skip steps",
      "Risk acceptance criteria vague (\"acceptable when low\") rather than specific (\"score ≤ 4 with documented owner sign-off\")",
      "Risk owners assigned without their knowledge",
      "Likelihood and impact scales not justified - auditors will ask why \"3\" means what it means"
    ],
    evidence_to_look_for: [
      { item: "The methodology document", what_it_tells_you: "Whether the rules exist" },
      { item: "Recent risk assessment(s) using the methodology - at least one within the last 12 months", what_it_tells_you: "Whether the rules are followed" },
      { item: "Sample risk traced from asset → threat → vulnerability → likelihood × impact → owner", what_it_tells_you: "Whether the methodology produces traceable outputs" },
      { item: "Risk-owner confirmation (e.g., signed acknowledgement or email trail)", what_it_tells_you: "Whether risk owners know they own" }
    ],
    scoping_notes: "ISO 27005 is a common reference but not mandatory. Qualitative scales (1-5 or H/M/L) are fine for most organizations; quantitative is rarely worth the cost. Whatever you choose, the test is: does it produce consistent, comparable results?",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented risk-assessment methodology defining impact and likelihood scales, risk-acceptance criteria, who owns each risk, and how risks are identified. Applied to produce a current risk register (refreshed in the past 12 months) with at least 10-20 risks at varying levels. Repeatable - two assessors applying the methodology to the same input would land in roughly the same place.",
    maturity_ladder: {
      1: "Risk discussion ad-hoc; no documented methodology",
      2: "Methodology documented; applied at least once",
      3: "Methodology applied consistently across assessments; risk owners formally accept",
      4: "Methodology calibrated against actual loss data; quantitative refinement where data supports"
    },
    related_items: ["clause-6.1.3", "clause-8.2", "clause-9.3", "annex-a.5.7"]
  },

  'clause-6.1.3': {
    purpose: "Requires the organization to (a) decide what to do about each identified risk, (b) determine what controls are necessary, (c) compare against Annex A to make sure none are missed, (d) produce the SoA, and (e) get risk owners to sign off on the treatment plan and accept residual risks. This clause produces the most-sampled artifact in any ISO 27001 audit: the SoA.",
    what_good_looks_like: "Every identified risk has a documented treatment (modify / accept / avoid / share). \"Necessary controls\" are derived from the risks - not from \"let's apply all of Annex A\". The SoA covers all 93 Annex A controls with applicability and justification (inclusion or exclusion); justifications cite specific risks for inclusions. A risk treatment plan exists with owners and dates, approved by risk owners. Residual risks are documented and formally accepted.",
    common_pitfalls: [
      "SoA exclusions stated without proper justification - \"not applicable\" with no reasoning",
      "\"Necessary controls\" not derived from risks; the org just picks all of Annex A by default",
      "Inclusion justifications generic (\"required for security\") rather than risk-specific (\"treats R-12, R-19\")",
      "Risk treatment plan exists but not approved by risk owners",
      "Residual risks not formally accepted - auditor asks \"who accepted this residual risk?\" and silence follows"
    ],
    evidence_to_look_for: [
      { item: "The Statement of Applicability covering all 93 Annex A controls", what_it_tells_you: "The mandatory output of this clause exists" },
      { item: "Risk treatment plan with owners, actions, and target dates", what_it_tells_you: "Treatment is operationalised, not just declared" },
      { item: "Risk-owner approval records on the treatment plan", what_it_tells_you: "Risk owners have accepted accountability" },
      { item: "Sample risk showing chain: risk → treatment decision → control(s) selected → residual evaluation → acceptance", what_it_tells_you: "The end-to-end logic works" },
      { item: "Cross-check: every \"included\" control in the SoA traceable to at least one risk", what_it_tells_you: "Whether 6.1.3.d.1 (necessary controls from risks) is satisfied" }
    ],
    scoping_notes: "Don't conflate the SoA with the risk register. SoA is control-by-control across all of Annex A; register is risk-by-risk. They cross-reference but answer different questions. SoA also includes implementation status and (best practice) reference to where each control is documented.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a risk-treatment plan covering every risk above the acceptance threshold, with named owners, target dates, and a status. An SoA listing all 93 Annex A controls with applicability decisions and justifications - none left as 'TBD'. Excluded controls have a one-line rationale beyond 'not applicable'. Residual risks have been formally accepted by a named risk owner.",
    maturity_ladder: {
      1: "SoA drafted but with weak justifications; treatment plan informal",
      2: "SoA + treatment plan documented; all Annex A controls addressed",
      3: "Inclusions traceable to specific risks; risk owners approve treatments and accept residuals",
      4: "SoA continuously updated as risks evolve; residual-risk acceptance has cadence and re-acceptance triggers"
    },
    related_items: ["clause-6.1.2", "clause-8.3"]
  },

  'clause-6.2': {
    purpose: "Requires measurable information-security objectives consistent with the policy. Without objectives, there's nothing to monitor (9.1) and nothing to improve (10.1). The objectives are how the ISMS proves it's actually doing something.",
    what_good_looks_like: "3-7 documented objectives at the ISMS level - concrete, measurable, time-bound (e.g., \"Reduce mean time to detect security events from 12h to <4h by end-2026\", \"Close 90% of high-severity vulnerabilities within 30 days SLA quarter-on-quarter\"). Plans showing what will be done, by whom, by when, and how progress is measured. Reviewed at planned intervals - typically quarterly progress, annual reset.",
    common_pitfalls: [
      "Objectives = \"comply with ISO 27001\" - that's not an objective",
      "Not measurable (\"improve security posture\")",
      "Not reviewed; written at certification and never revisited",
      "No plan beyond stating the objective - no who, when, how-measured",
      "Objectives don't connect to the policy's stated direction"
    ],
    evidence_to_look_for: [
      { item: "Documented objectives - typically a 1-page document or scorecard", what_it_tells_you: "Whether they exist and are measurable" },
      { item: "KPI tracking - dashboards, monthly reports, or scorecards", what_it_tells_you: "Whether they're actually measured" },
      { item: "Planning record showing actions to achieve each objective", what_it_tells_you: "Whether the objective drives work" },
      { item: "MR minutes reviewing objective progress", what_it_tells_you: "Whether objectives are governance-level concerns" }
    ],
    scoping_notes: "Objectives can cascade - ISMS-level → department-level → individual KPIs. ISO requires the ISMS-level ones to be documented; the cascade is a maturity indicator.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: 3-7 information-security objectives, each measurable (e.g., '95% phishing-simulation pass rate by Q4'), with a named owner, a target date, and a baseline. Reviewed at the most recent management review with status updates. Objectives connect back to either a policy commitment or a specific risk - not invented in isolation.",
    maturity_ladder: {
      1: "Stated aspirations; not measurable",
      2: "Measurable objectives documented; tracked",
      3: "Objectives reviewed in MR; tied to plans and resources; cascade evident",
      4: "Objectives drive resource allocation; effectiveness of the ISMS measured against them"
    },
    related_items: ["clause-5.2", "clause-9.1", "clause-9.3", "clause-10.1"]
  },

  'clause-6.3': {
    purpose: "Added in the 2022 revision. Requires planned, controlled change to the ISMS itself - new scope, new objectives, structural changes - rather than ad-hoc modifications. Distinct from operational change management (A.8.32), which is about IT changes.",
    what_good_looks_like: "A documented process for ISMS-level changes (scope changes, methodology updates, structural changes), an impact assessment for each change, and records showing the process is followed when triggered. Change records exist - even if infrequent.",
    common_pitfalls: [
      "Ignored entirely - pre-2022 ISMSs sometimes haven't added it",
      "Confused with A.8.32 - the IT change-management process is presented as 6.3",
      "Process exists but no records - looks dormant",
      "Informal scope changes (e.g., adding a new product to scope) without going through 6.3"
    ],
    evidence_to_look_for: [
      { item: "Documented ISMS-change process", what_it_tells_you: "The process exists" },
      { item: "Change records - typically one or two per year", what_it_tells_you: "The process is used when triggered" },
      { item: "Impact assessment for a recent ISMS change", what_it_tells_you: "Changes are deliberate" },
      { item: "MR inputs showing planned ISMS changes considered", what_it_tells_you: "Top management is involved in change-planning" }
    ],
    scoping_notes: "ISMS-level changes are infrequent - annual or less. The clause is satisfied by showing the process exists and is followed when triggered, plus showing planning is done rather than reactive.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented process for ISMS-level changes (scope, methodology, structural changes) requiring an impact assessment before approval. At least one change record exists for the last 12 months - or an explicit 'no changes this cycle' note in MR minutes.",
    maturity_ladder: {
      1: "No process; changes are ad-hoc",
      2: "Process documented; followed for major changes",
      3: "Impact assessed; reviewed in MR; planned ahead",
      4: "Change pipeline maintained; ISMS evolution tracked over years"
    },
    related_items: ["clause-4.4", "clause-8.1", "annex-a.8.32"]
  },

  'clause-7.1': {
    purpose: "Requires the organization to determine and provide the resources needed to establish, implement, maintain, and continually improve the ISMS. \"Resources\" means budget, headcount, tools, time. ISMSs starve when this clause isn't taken seriously.",
    what_good_looks_like: "A documented determination of what resources the ISMS needs (typically annual, tied to the planning cycle). Budget and headcount allocated and visible. Tools provisioned. Resource adequacy reviewed in MR - if the ISMS isn't keeping up, the org notices.",
    common_pitfalls: [
      "Resources mentioned in policy but never actually allocated",
      "ISMS is under-resourced and the team can't sustain operation - visible at Stage 2 because audit prep ate everything",
      "No review of adequacy - never adjusted as scope or risks grow",
      "Tools procured without understanding ongoing costs (licences, training, support)"
    ],
    evidence_to_look_for: [
      { item: "Budget records distinguishing ISMS allocation from general IT", what_it_tells_you: "Whether the org puts money behind the system" },
      { item: "Resource plan or capacity-vs-demand analysis", what_it_tells_you: "Whether resourcing is intentional" },
      { item: "MR inputs showing resource decisions", what_it_tells_you: "Whether resourcing is governance-level" }
    ],
    scoping_notes: "ISO doesn't prescribe resourcing levels - that's a judgement call. The test is whether the org can demonstrably operate the ISMS as planned. If MR keeps surfacing missed deadlines, that's an under-resourcing finding.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: documented determination of the people, tooling, budget, and infrastructure the ISMS needs, with evidence those resources have been provided. The most recent management review discusses resource adequacy. No critical resource gap is open without a closure plan.",
    maturity_ladder: {
      1: "Resourcing implicit; no documented determination",
      2: "Resources allocated; reviewed annually",
      3: "Capacity-vs-demand modelled; adjustments made as scope changes",
      4: "Resourcing optimised; ROI per ISMS investment tracked"
    },
    related_items: ["clause-5.1", "clause-5.3", "clause-7.2", "clause-9.3"]
  },

  'clause-7.2': {
    purpose: "Requires that people in ISMS roles are competent - by training, qualification, or experience - and that gaps are addressed.",
    what_good_looks_like: "Documented competence requirements per ISMS role. Evidence that role-holders meet them: certifications (CISSP, CISM, CISA, ISO LA), formal training, demonstrable experience. Gaps identified and addressed (training plan, hiring, reassignment). Records maintained - CVs, certificate copies, training transcripts.",
    common_pitfalls: [
      "Competence requirements not documented per role - \"the CISO needs to be competent\" is not a requirement",
      "Internal-IT-promoted CISO with no security qualifications and no training plan",
      "No competence records (CVs, certs)",
      "Gaps identified but no action taken",
      "Treating awareness training (7.3) as competence training (7.2) - they're different"
    ],
    evidence_to_look_for: [
      { item: "Role-competence matrix listing each ISMS role and required competence", what_it_tells_you: "Whether requirements are explicit" },
      { item: "CVs / certificates / training records for current role-holders", what_it_tells_you: "Whether requirements are met" },
      { item: "Training plan addressing identified gaps", what_it_tells_you: "Whether gaps are being closed" },
      { item: "Evidence of how competence was determined adequate (typically a written rationale)", what_it_tells_you: "Whether the org has actually thought about this" }
    ],
    scoping_notes: "Competence isn't only certifications - experience and demonstrated capability count. What's required is documenting the basis for the determination. \"Joe has 12 years of network security and demonstrated incident-response capability in two prior roles\" is a valid basis.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: defined competence requirements for the critical ISMS roles (ISMS owner, internal auditor, risk-acceptance authority at minimum), with evidence each role-holder meets them - CV, certification, or training record. Where requirements are not yet met, a documented gap-closure plan exists. Updated on hire or role change.",
    maturity_ladder: {
      1: "Implicit; based on job titles",
      2: "Requirements documented per role; records of role-holder competence",
      3: "Gap analysis and training plan; refreshers tracked",
      4: "Competence linked to objectives; succession planning for key roles"
    },
    related_items: ["clause-5.3", "clause-7.3", "annex-a.6.3"]
  },

  'clause-7.3': {
    purpose: "Requires every person doing work under the organization's control to be aware of the ISMS policy, their contribution to it, and consequences of non-conformance. Awareness is broader than competence - it's everyone, including contractors.",
    what_good_looks_like: "An awareness programme covering all staff: induction at hire, refresher at least annually, attestation of completion. Content includes policy summary, individual contribution (\"what does this mean for me\"), and consequences (\"what happens if I violate this\"). Tailored for high-risk roles (e.g., developers get secure-coding awareness, finance gets BEC awareness). Records prove coverage.",
    common_pitfalls: [
      "Training delivered but no attestation records (\"we ran it\" isn't enough)",
      "Not refreshed - induction only; people who joined three years ago haven't seen it since",
      "Consequences of non-conformance not communicated - the disciplinary part is uncomfortable but required",
      "Contractors and third-party personnel excluded - required by 7.3 \"persons doing work under its control\"",
      "Phishing simulations counted as awareness with no other content"
    ],
    evidence_to_look_for: [
      { item: "Awareness programme document", what_it_tells_you: "What's planned" },
      { item: "Sample induction materials and refresher content", what_it_tells_you: "Whether the content is current and relevant" },
      { item: "LMS or attestation records for the last 12 months", what_it_tells_you: "Coverage and completion rates" },
      { item: "Schedule showing refresh cadence", what_it_tells_you: "Whether ongoing or one-shot" },
      { item: "Contractor-coverage evidence", what_it_tells_you: "Whether scope is correctly broad" }
    ],
    scoping_notes: "Format isn't prescribed - micro-learning, video, in-person, simulations all valid. Combination is best practice. Auditors will ask for the % of staff completed in the last cycle and what happens to non-completers.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: documented awareness covering the security policy, each person's role-relevant obligations, and the consequences of non-compliance. Delivery evidence (training records, attendance logs, completion certificates) for at least the last 12 months covering ~95% of in-scope staff and contractors. Onboarding includes security awareness. Non-completers have follow-up evidence.",
    maturity_ladder: {
      1: "Ad-hoc; new joiners get induction; no refreshers",
      2: "Programme documented; annual refresher; attestation tracked",
      3: "Tailored to roles; effectiveness measured (e.g., phishing-fail rate, awareness-survey scores)",
      4: "Continuous nudges, just-in-time training, simulation-driven"
    },
    related_items: ["clause-5.2", "clause-7.2", "annex-a.6.3"]
  },

  'clause-7.4': {
    purpose: "Requires planned communication about information security - both internal and external. Without a plan, communication happens reactively and inconsistently, and the organization can't show how it informs interested parties about ISMS matters.",
    what_good_looks_like: "A documented communication plan: what is communicated, to whom, when, by whom, how. Internal channels (intranet, all-hands, manager cascade, security newsletter). External channels (regulator notifications, customer security communications, public statements). Records of communication kept. Crisis-comms (incident communications) addressed but typically governed by A.5.5 and A.5.24.",
    common_pitfalls: [
      "Ad-hoc communication without a plan",
      "External comms not addressed - only internal",
      "No channel for crisis comms or unclear ownership",
      "Records of communication not kept"
    ],
    evidence_to_look_for: [
      { item: "Communication plan document", what_it_tells_you: "Plan exists" },
      { item: "Sample internal comms (intranet posts, all-hands slides)", what_it_tells_you: "Plan is executed" },
      { item: "External comms templates (regulator notification, breach disclosure, customer assurance)", what_it_tells_you: "External readiness" },
      { item: "Records of recent ISMS-related communication", what_it_tells_you: "Plan is alive" }
    ],
    scoping_notes: "A.5.5 (contact with authorities) and A.5.24 (incident communications) overlap with 7.4. The 7.4 plan is the umbrella; A.5.5 / A.5.24 are operational specifics.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented communication plan covering what gets communicated, to whom, when, by whom, and through which channel - both internal and external. Includes how the organisation communicates with regulators and major customers on security matters. Records of recent communications exist.",
    maturity_ladder: {
      1: "Reactive; no plan",
      2: "Plan documented; channels named; records kept",
      3: "Plan reviewed; effectiveness measured (open rates, attendance, feedback)",
      4: "Communication strategy aligned with ISMS objectives; targeted by audience"
    },
    related_items: ["clause-5.1", "clause-5.2", "annex-a.5.5", "annex-a.5.24", "annex-a.6.8"]
  },

  'clause-7.5': {
    purpose: "Requires documented information mandated by ISO and by the organization's ISMS to be created, controlled, and protected. The control covers version, owner, distribution, and prevention of unintended use of obsolete documents.",
    what_good_looks_like: "A document register listing all ISMS documents with owner, version, last review date, and next review date. Documents themselves have version blocks (version, date, approver). Document control procedure covers approval before issue, review on change, distribution control, and obsolete-document handling. Obsolete documents are marked or removed from circulation. Sample doc - pulled at random - has clear owner, recent version, and review trail.",
    common_pitfalls: [
      "Documents exist but no version control - multiple drafts in circulation, owner unclear",
      "Obsolete documents still on the intranet alongside current ones",
      "No review cycle, or all documents share one date - implies bulk-stamp without review",
      "Document control procedure exists but not followed",
      "External-origin documents (regulations, customer requirements) not controlled at all"
    ],
    evidence_to_look_for: [
      { item: "Document register (master list)", what_it_tells_you: "Whether the catalog exists and is current" },
      { item: "Sample document with version history, owner, approver, dates", what_it_tells_you: "Control is real per document" },
      { item: "Document-control procedure", what_it_tells_you: "Rules exist" },
      { item: "Example of obsolete-document handling", what_it_tells_you: "Lifecycle is managed" },
      { item: "Distribution-control evidence (access permissions, intranet visibility)", what_it_tells_you: "Right people see right docs" }
    ],
    scoping_notes: "Applies to internal ISMS documents (policies, procedures, records). External documents (regulations, supplier docs, customer security questionnaires) need control too - typically a separate \"external documents\" register.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a controlled-document register listing every mandatory document (policies, procedures, risk register, SoA, scope, MR minutes, internal-audit reports) with owner, version, approval date, and next review date. Documents are version-controlled and superseded copies are marked or removed. No mandatory document is more than one approval cycle out of date.",
    maturity_ladder: {
      1: "Documents exist; control informal",
      2: "Register, versioning, owners; periodic review",
      3: "Document workflow tooling; obsolete-doc detection automated",
      4: "Continuous integration of documentation; effectiveness measured (e.g., \"are documents being read\")"
    },
    related_items: ["clause-4.4", "clause-5.2", "clause-8.1", "clause-9.2", "clause-9.3", "annex-a.5.37"]
  },

  'clause-8.1': {
    purpose: "Requires the organization to plan, implement, and control the ISMS processes needed to meet requirements - including outsourced processes - and to keep records that the processes have been carried out.",
    what_good_looks_like: "A process inventory (ISMS-relevant operational processes) with criteria, control measures, and records. Outsourced processes (e.g., SOC, MSP, cloud providers running components in-scope) are explicitly identified and managed via supplier controls. Records show processes operate as planned.",
    common_pitfalls: [
      "Outsourced processes not addressed - cloud, MSPs, SOC providers ignored",
      "No process records - auditors can't verify operation",
      "No criteria defined - processes operate to nobody's standard",
      "Planning is reactive - fire-fighting masquerading as operation"
    ],
    evidence_to_look_for: [
      { item: "Process map or inventory of operational ISMS processes", what_it_tells_you: "Org has thought systemically" },
      { item: "SOPs for security processes (vulnerability mgmt, access review, incident response)", what_it_tells_you: "Processes are documented" },
      { item: "Outsourcing agreements with security clauses", what_it_tells_you: "Outsourced processes managed" },
      { item: "Records of process operation - ticket systems, review logs, run records", what_it_tells_you: "Processes execute" }
    ],
    scoping_notes: "Outsourced processes within scope must be controlled - supplier reviews (A.5.22), contract clauses (A.5.20), monitoring of supplier performance. The 8.1 record is that you've identified them and have control measures.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: evidence the ISMS plans from clause 6 are actually executed - risk treatments progressing per plan, controls operating as designed, changes that affect security routed through change management. Outsourced processes in scope have documented oversight. Operational records exist (tickets, logs, reviews) that an auditor can sample for the past 6-12 months.",
    maturity_ladder: {
      1: "Processes informal; records partial",
      2: "Processes documented; SOPs in place; records exist",
      3: "Outsourced processes managed; criteria measured; processes reviewed",
      4: "Process performance instrumented; continuous improvement of operations"
    },
    related_items: ["clause-4.4", "clause-6.1", "clause-9.1", "annex-a.5.19", "annex-a.5.20", "annex-a.5.22"]
  },

  'clause-8.2': {
    purpose: "Operational counterpart to 6.1.2. Requires risk assessments to be performed at planned intervals AND when significant changes occur - and the results documented and communicated to risk owners.",
    what_good_looks_like: "Risk-assessment cadence is defined (typically annual full cycle + ad-hoc on triggers). Triggers for ad-hoc reassessment are written down (\"new product, new system, M&A, regulatory change, major incident\"). Recent assessments exist. Risk owners have been notified of relevant results.",
    common_pitfalls: [
      "Only annual; never on change - even after major events",
      "\"Significant change\" not defined - vague trigger",
      "Results documented but not communicated to risk owners",
      "Assessments performed but not retained as documented information"
    ],
    evidence_to_look_for: [
      { item: "Methodology cadence specification", what_it_tells_you: "Trigger rules are explicit" },
      { item: "Most recent risk assessment", what_it_tells_you: "Cadence is current" },
      { item: "Evidence of an ad-hoc reassessment after a recent material event", what_it_tells_you: "Trigger rules are followed, not just written" },
      { item: "Communication to risk owners (email, ticket, signed acknowledgement)", what_it_tells_you: "Owners are informed" }
    ],
    scoping_notes: "8.2 is the operation of 6.1.2 - same methodology, just doing it. The deliverables of 8.2 are the actual assessments and their communication.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: risk assessments are performed at planned intervals (typically annual) and on defined triggers (new product/system, M&A, regulatory change, significant incident). Results are documented and communicated to risk owners. At least one assessment in the last 12 months.",
    maturity_ladder: {
      1: "Annual only; no triggers",
      2: "Cadence defined; triggers documented; recent assessments",
      3: "Triggers actively monitored; ad-hoc assessments routinely happen",
      4: "Continuous risk assessment with event-driven re-evaluation"
    },
    related_items: ["clause-6.1.2", "clause-8.3", "clause-9.3", "annex-a.8.32"]
  },

  'clause-8.3': {
    purpose: "Operational counterpart to 6.1.3. Requires the risk-treatment plan to be implemented and the implemented treatments to be effective - not just deployed.",
    what_good_looks_like: "Treatment plan tracked to completion (each action has status, owner, date). Implementation evidence per action (the deployed control with proof). Effectiveness verified - sample evidence the control is doing what it should (e.g., for an access-review control: the actual review output shows revoked access). Records retained. Residual risk re-evaluated post-implementation.",
    common_pitfalls: [
      "Treatments deployed but never verified for effectiveness",
      "Plan tracked but actions \"closed\" without evidence",
      "No effectiveness review - closing rests on implementation, not outcome",
      "Residual-risk re-evaluation skipped"
    ],
    evidence_to_look_for: [
      { item: "Treatment plan with status (open / in-progress / closed)", what_it_tells_you: "Plan is alive" },
      { item: "Implementation evidence per recent action", what_it_tells_you: "Actions did what they said" },
      { item: "Effectiveness verification - test result or sample data showing the control works", what_it_tells_you: "It's not just deployed; it's working" },
      { item: "Residual-risk re-evaluation after a treatment", what_it_tells_you: "The risk picture is updated" }
    ],
    scoping_notes: "Effectiveness verification is part of the monitoring (9.1) function - but 8.3 is where you record the per-action verification. They link.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: the risk treatment plan from 6.1.3 is being implemented - each treatment has a status, an owner, and a closure trail when complete. Overdue treatments have a documented reason. The plan is reviewed at management review.",
    maturity_ladder: {
      1: "Plan exists; status not maintained",
      2: "Plan tracked; implementation evidence kept",
      3: "Effectiveness verified; residual re-evaluated; closure rigorous",
      4: "Continuous monitoring of treatment effectiveness; deviations trigger re-treatment"
    },
    related_items: ["clause-6.1.3", "clause-9.1", "clause-9.2"]
  },

  'clause-9.1': {
    purpose: "Requires the organization to determine WHAT to monitor and measure, HOW, WHEN, by WHOM analysed, and WHAT the analysis says about ISMS performance and effectiveness. Turns the ISMS from a paper system into a measurable one.",
    what_good_looks_like: "Documented metrics - typically 8-15 - derived from objectives (6.2) and key risks. For each: definition, source, frequency, who analyses, threshold for action. Records of measurement. Analysis turns numbers into insight (e.g., \"vulnerability backlog growing 5% MoM despite SLA compliance - driven by surge in dependency CVEs; recommend tooling investment\"). Used in MR (9.3) and continual improvement (10.1).",
    common_pitfalls: [
      "Metrics defined but not measured",
      "Measured but not analysed - dashboards exist but no one looks",
      "Analysed but no decisions follow",
      "No documented basis for what to monitor - just generic IT metrics like uptime",
      "Metrics not tied to objectives or risks"
    ],
    evidence_to_look_for: [
      { item: "KPI definitions document", what_it_tells_you: "Metrics are deliberate" },
      { item: "Monitoring records - dashboard exports, monthly reports", what_it_tells_you: "Measurement is happening" },
      { item: "Analysis output - narrative reports interpreting the numbers", what_it_tells_you: "Beyond raw numbers, insight is generated" },
      { item: "Decision trail - actions taken based on analysis", what_it_tells_you: "Monitoring drives the ISMS" }
    ],
    scoping_notes: "ISO doesn't prescribe metrics. They should derive from objectives (6.2) and key risks. Avoid generic operational metrics like uptime unless they're directly tied to a security objective.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a monitoring and measurement plan naming what gets measured (selected from objectives plus a handful of key controls), by whom, on what frequency, and how results are analysed. At least one full cycle of measurement has been performed and results recorded. Results feed the most recent management review - not just collected and shelved.",
    maturity_ladder: {
      1: "Few metrics; measured ad-hoc",
      2: "Documented metrics; regular measurement; basic analysis",
      3: "Metrics drive decisions; trends analysed; thresholds trigger action",
      4: "Predictive analytics; metrics tested for relevance and replaced when stale"
    },
    related_items: ["clause-6.2", "clause-8.3", "clause-9.3"]
  },

  'clause-9.2': {
    purpose: "Requires internal audits of the ISMS at planned intervals - to determine whether (a) it conforms to ISO 27001 requirements and the organization's own ISMS requirements, and (b) it's effectively implemented and maintained. This is the ISMS auditing itself.",
    what_good_looks_like: "Documented internal audit programme over a 3-year cycle covering all ISMS scope (every clause and every applicable Annex A control sampled at least once over the cycle). Audit plan per audit specifies scope, criteria, methods. Auditors are independent of the area being audited. Audit reports document findings (NCs, observations, opportunities) with evidence. Findings tracked to closure. Reports go to relevant management.",
    common_pitfalls: [
      "Audit programme exists but not aligned with risk - high-risk areas audited as often as low-risk",
      "Auditor independence violated - CISO auditing themselves, or IT auditing IT",
      "Findings not closed; the same finding recurs in the next audit cycle",
      "Only conformity audited, not effectiveness - checking documents exist rather than whether the ISMS is working",
      "Programme doesn't cover the full ISMS over a 3-year cycle"
    ],
    evidence_to_look_for: [
      { item: "3-year audit programme showing coverage", what_it_tells_you: "Programme is real and risk-based" },
      { item: "Sample audit plan and report", what_it_tells_you: "Audits are properly conducted" },
      { item: "Auditor-independence record (declaration or org chart)", what_it_tells_you: "Independence requirement met" },
      { item: "Findings register with closure status, including how effectiveness was checked", what_it_tells_you: "Audits drive change" },
      { item: "Distribution evidence - audit reports go to relevant management", what_it_tells_you: "Audits are governance-level" }
    ],
    scoping_notes: "Internal auditors don't have to be external. Internal staff trained as auditors (CISA, IRCA ISO 27001 Lead Auditor, internal training) are common. What matters is independence from the audited area.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: an internal-audit programme covering the full ISMS over a defined cycle (1-3 years), with at least one completed audit in the last 12 months covering both Clauses 4-10 and a sample of Annex A. Auditors are competent and demonstrably independent of the area they audit. Findings have owners, due dates, and a closure trail - none orphaned.",
    maturity_ladder: {
      1: "Single annual audit; coverage incomplete",
      2: "3-year programme covering ISMS; reports produced",
      3: "Risk-based programme; effectiveness audited; findings closed",
      4: "Continuous internal auditing; correlations between findings tracked; auditing approach itself periodically reviewed"
    },
    related_items: ["clause-9.3", "clause-10.2", "annex-a.5.35", "annex-a.5.36"]
  },

  'clause-9.3': {
    purpose: "The single most-sampled clause in real audits. Requires top management to review the ISMS at planned intervals to confirm it remains suitable, adequate, and effective. This is where the ISMS proves it has executive ownership.",
    what_good_looks_like: "Management review held at least annually (often quarterly for active ISMSs). Top management present and engaged. Agenda covers all 9.3.2 inputs: status of actions from prior MR, changes in external/internal issues, changes in interested-party requirements, KPI performance against objectives, NC and corrective-action status, audit results, fulfilment of objectives, feedback from interested parties, results of risk assessment, status of treatment plan, opportunities for continual improvement. Decisions documented (continual improvement opportunities pursued, ISMS changes made). Outputs feed 10.1 and 6.3.",
    common_pitfalls: [
      "MR is just a status meeting, not a review - no decisions, no challenges",
      "One or more 9.3.2 inputs missing - auditors check item by item",
      "Top management absent or only present for 15 minutes",
      "Not held at the planned interval (e.g., \"annual\" is now 18 months overdue)",
      "MR happens but minutes are sparse - \"reviewed and approved\" with no detail"
    ],
    evidence_to_look_for: [
      { item: "MR minutes/records covering all 9.3.2 inputs in the last 12 months", what_it_tells_you: "Comprehensive coverage" },
      { item: "Attendance record showing top-management presence for the full session", what_it_tells_you: "Engagement is real" },
      { item: "Action register from MR with owners and dates", what_it_tells_you: "Decisions are followed up" },
      { item: "Inputs deck or pre-read showing each 9.3.2 input addressed", what_it_tells_you: "Inputs were prepared properly" },
      { item: "Trace from prior MR action → status update at next MR", what_it_tells_you: "MR is a closed loop" }
    ],
    scoping_notes: "The 9.3.2 input checklist is what auditors literally tick off. Build your MR template against the list. Missing one input is a finding; missing two is a major.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: management-review minutes from the last 12 months covering every required input in clause 9.3.2 and producing dated decisions on improvements, changes, and resource needs per 9.3.3. Top management is present and named in attendance - not just security. Minutes are signed or approved, and actions from prior MRs are tracked to closure.",
    maturity_ladder: {
      1: "Annual meeting; coverage incomplete",
      2: "All 9.3.2 inputs covered; minutes record decisions",
      3: "MR is decision-making forum; actions tracked; outputs drive ISMS change",
      4: "MR cadence matches ISMS dynamics (quarterly or monthly); outcomes measurable"
    },
    related_items: ["clause-5.1", "clause-6.2", "clause-9.1", "clause-9.2", "clause-10.1"]
  },

  'clause-10.1': {
    purpose: "Requires the organization to continually improve the suitability, adequacy, and effectiveness of the ISMS. The improvement is evidence-based - driven by audit findings, NC trends, monitoring data, MR decisions - not just intent.",
    what_good_looks_like: "An improvement register or log capturing improvement actions with their drivers (audit finding X, NC trend Y, monitoring insight Z). Each action has owner, date, expected impact. Impact verified post-implementation - before/after evidence. Reviewed in MR. The ISMS visibly evolves over time.",
    common_pitfalls: [
      "\"Continual improvement\" claimed but no actions visible",
      "Improvements made but not tied to ISMS performance data - gut-feel changes",
      "No impact verification - actions closed without evidence of improvement",
      "Improvement equated to corrective action (10.2) - they overlap but improvement is broader"
    ],
    evidence_to_look_for: [
      { item: "Improvement register/log", what_it_tells_you: "Improvement is tracked" },
      { item: "Sample improvement traced from data → action → outcome", what_it_tells_you: "Improvement is evidence-driven" },
      { item: "Before/after evidence for a recent improvement", what_it_tells_you: "Impact is real" },
      { item: "MR inputs/outputs showing improvement is governance-level", what_it_tells_you: "Improvement is sustained" }
    ],
    scoping_notes: "If the ISMS hasn't visibly changed in 12 months, that's a finding. Improvement need not be major - small refinements count, as long as they're documented.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: evidence of at least 3-5 closed improvements over the last 12 months, each traceable to a source - audit finding, MR action, metric trend, or incident. Improvements have been recorded, not just done. Trend over time shows the ISMS evolving rather than standing still.",
    maturity_ladder: {
      1: "Improvements informal",
      2: "Improvement log; actions traced to drivers; outcomes verified",
      3: "Improvement integrated with audit / NC / monitoring loops",
      4: "Improvement is the ISMS's heartbeat; measurable maturity progression year over year"
    },
    related_items: ["clause-9.3", "clause-10.2"]
  },

  'clause-10.2': {
    purpose: "Defines what to do when a nonconformity occurs - react to it, control it, deal with consequences, find the root cause, look for similar issues elsewhere, take corrective action, review effectiveness, and keep records. This is the closed-loop cleanup mechanism of the ISMS.",
    what_good_looks_like: "An NC log with workflow (identification → react → root-cause analysis → similar-NC search → corrective action → effectiveness review → close). RCA goes beyond symptom - typical depth is 5-Whys or fishbone, with documented reasoning. Similar-NC search documented. Corrective action closes the underlying cause. Effectiveness review confirms the cause is gone (sample data, repeat audit, time elapsed without recurrence). Records retained - every NC traceable from open to close.",
    common_pitfalls: [
      "\"Corrective action\" is just the immediate fix without root-cause work - the most common 10.2 finding",
      "Effectiveness review skipped or rubber-stamped (\"we did the action, closing\")",
      "Similar-NC search not done - only the originally-reported NC is closed",
      "Minor NCs not tracked - only majors get the full workflow",
      "NCs without owners or due dates"
    ],
    evidence_to_look_for: [
      { item: "NC register with status and workflow", what_it_tells_you: "NCs are tracked end-to-end" },
      { item: "Sample NC with full workflow - RCA, similar-search, corrective action, effectiveness review, close", what_it_tells_you: "10.2 is operational" },
      { item: "Trend analysis on NC root causes", what_it_tells_you: "Patterns are recognised" },
      { item: "Integration with internal audit findings - audit findings open NCs", what_it_tells_you: "Audit drives improvement" }
    ],
    scoping_notes: "10.2 is heavily sampled. Major NCs in your own audits should show 10.2 working - NCs without clear closure are a Stage 2 finding. Minor NCs (or \"opportunities for improvement\") should still be tracked, even if not subject to formal RCA.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: an NC and corrective-action process with at least 3-5 NCs raised in the last 12 months (from internal audit, incidents, or external feedback), each with root-cause analysis, immediate correction, corrective action, effectiveness check, and closure. NCs are not closed by just fixing the symptom - the closure note shows the cause is gone.",
    maturity_ladder: {
      1: "NCs tracked; root cause sometimes done",
      2: "Workflow consistent; RCA documented; corrective actions closed",
      3: "Similar-NC search standard; effectiveness reviewed; trends analysed",
      4: "RCA depth differs by NC severity; predictive analytics on NC patterns; recurrence-rate tracked"
    },
    related_items: ["clause-9.2", "clause-10.1", "annex-a.5.27", "annex-a.6.4"]
  },

  // ===================================================================
  // ANNEX A - ORGANIZATIONAL CONTROLS - A.5.x
  // ===================================================================
  'annex-a.5.15': {
    purpose: "This is the umbrella access-control clause. It says the organization must have rules - not just AD groups deployed by IT - that articulate principles (least privilege, need-to-know, segregation of duties) and connect to the operational controls in A.5.16-5.18 and A.8.2-8.5 that implement those principles.",
    what_good_looks_like: "A documented Access Control Policy of 3-8 pages covering: principles, scope (logical and physical), resource classification (production vs corporate, sensitive vs public), and pointers to topic-specific procedures for provisioning, review, revocation, and privileged access. Different rules for different resource classes - a privileged production database is not governed by the same clause as a marketing SaaS tool. Critically, the policy is applied: a randomly chosen recent joiner's access ticket and a recent leaver's revocation ticket both follow what the policy says.",
    common_pitfalls: [
      "The \"policy gap\" - beautifully written policy, completely disconnected from operational reality. Stage 2 auditors live for this finding",
      "Privileged access folded into the same rules as standard access (it shouldn't be)",
      "Physical access not addressed in or referenced by the policy",
      "Leaver process either undocumented or executed inconsistently - the most common access-control finding in real audits",
      "\"We do quarterly access reviews\" with no evidence of what was reviewed or what was found"
    ],
    evidence_to_look_for: [
      { item: "The Access Control Policy itself, with a revision date inside the last 12 months", what_it_tells_you: "Whether the rules exist and have been actively maintained" },
      { item: "One recent joiner's full provisioning trail - request → approval → grant timestamps", what_it_tells_you: "Whether the documented joiner process is what actually happens" },
      { item: "One recent leaver's revocation trail showing same-day or next-business-day removal across all systems", what_it_tells_you: "Whether the leaver SLA is real (this is the most-sampled access-control evidence)" },
      { item: "Output of a recent access review for one specific sensitive system", what_it_tells_you: "Whether reviews produce decisions, not just sign-offs" },
      { item: "The privileged-access list for a sensitive system, with sign-off from the system owner", what_it_tells_you: "Whether privileged access is governed differently from standard access" }
    ],
    scoping_notes: "Most organizations split this into a parent Access Control Policy plus topic-specific procedures (joiner-mover-leaver, privileged access, physical access). Auditors look at both - don't claim policy-level statements cover operational detail. Physical access is sometimes governed under a separate Physical Security Policy; fine, as long as the Access Control Policy explicitly references it.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented Access Control Policy covering both logical and physical access, the principles applied (need-to-know, least privilege, segregation of duties), and the joiner-mover-leaver lifecycle. Implemented on the in-scope systems with auditor-sampleable evidence - a current user list, leaver tickets closed within SLA, and at least one access review in the past 12 months.",
    maturity_ladder: {
      1: "Access decisions made case-by-case; no documented rules",
      2: "Access Control Policy exists; some procedures aligned; reviews happen but informally",
      3: "Policy + procedures + scheduled reviews; metrics tracked (e.g., leaver-revocation SLA, dormant-account count); deviations remediated",
      4: "Real-time access governance; automated detection of policy violations (toxic combinations, dormant privileged accounts); risk-based decisions per system"
    },
    related_items: ["annex-a.5.16", "annex-a.5.17", "annex-a.5.18", "annex-a.8.2", "annex-a.8.3", "clause-7.5"]
  },

  // ===================================================================
  // ANNEX A.5 - ORGANIZATIONAL CONTROLS (continued)
  // ===================================================================

  'annex-a.5.1': {
    purpose: "Clause 5.2 produces the master Information Security Policy. A.5.1 is the family of topic-specific policies that sit underneath it (access control, cryptography, supplier, BCP, secure development, comms, etc.). Together they tell the organization what is required at the principle level for every important security topic. Without topic-specific policies, the master ISP becomes a wall of generic statements that nobody can actually act on.",
    what_good_looks_like: "A documented policy hierarchy with the master ISP at the top and a small, deliberate set of topic-specific policies underneath - typically 6-12 for a mid-size org (access control, cryptography, supplier security, BCP, secure development, acceptable use, data classification, incident response, physical security, communications, third-party access). Each policy has a named owner, an approval record (top management or appropriately delegated), a review cycle (annual minimum), and a version block. Coverage maps to risk and to Annex A - there's a topic policy for every area where the organization has meaningful exposure. Policies are communicated, accessible, and actually referenced by procedures and operational documentation.",
    common_pitfalls: [
      "Copy-paste templates from the internet that don't fit how the organization actually works - auditors detect this in seconds when they ask follow-up questions",
      "Policies exist but are never reviewed; same content for 4+ years",
      "Owner is \"Information Security\" or \"IT\" - no named individual accountable",
      "Topic policies missing for areas where the org has real exposure (e.g., no Cryptography Policy at a fintech)",
      "Policy bloat - 30 topic policies, each contradicting another; staff can't navigate them",
      "Policies say one thing, procedures say another, practice does a third"
    ],
    evidence_to_look_for: [
      { item: "Policy register listing every topic-specific policy with owner, version, approval date, next review", what_it_tells_you: "Whether the organization knows what it has and is maintaining it" },
      { item: "Two or three sample policies pulled at random - read them and check the version block, owner, approver", what_it_tells_you: "Whether control is real or just claimed" },
      { item: "Acknowledgement records showing staff have been told policies exist", what_it_tells_you: "Whether communication happened" },
      { item: "Mapping showing which Annex A control families each policy covers", what_it_tells_you: "Whether the policy set is comprehensive vs. ad-hoc" },
      { item: "Evidence of a policy change in the last 12 months (any policy)", what_it_tells_you: "Whether the policy set is alive" }
    ],
    scoping_notes: "Smaller organizations often combine multiple topics into fewer policies (e.g., one Operations Security Policy covering logging, monitoring, capacity, malware). That's acceptable as long as the content is covered. The test is not the count of policies but whether every meaningful topic has a policy-level statement that someone has signed off on.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: an information-security policy plus topic-specific policies for the high-leverage areas (acceptable use, access control, cryptography, backup, supplier security, incident management at minimum) approved by management, dated within the last 24 months, and accessible to all staff. Each policy has an owner and a next-review date that hasn't expired.",
    maturity_ladder: {
      1: "Master ISP exists; few or no topic policies; no review cycle",
      2: "Documented hierarchy; topic policies for major areas; annual review",
      3: "Policies tied to risk; mapping to Annex A maintained; policies traceable to procedures",
      4: "Policy effectiveness measured (policy-violation incidents tracked); staff comprehension surveyed; policies updated based on data"
    },
    related_items: ["clause-5.2", "annex-a.5.15", "annex-a.5.19", "annex-a.5.31", "annex-a.8.24", "annex-a.5.10"]
  },

  'annex-a.5.2': {
    purpose: "Operational implementation of clause 5.3. Where 5.3 says \"roles, responsibilities, and authorities shall be defined and allocated,\" A.5.2 is the actual allocation - specific roles assigned to specific people, with their responsibilities written into job descriptions, contracts, and operational documentation. This is the control auditors test when they ask \"who owns control X?\" and expect a name, not a function.",
    what_good_looks_like: "Every ISMS role exists in writing with a named individual: CISO, Information Security Manager, control owners (typically by control family), asset owners, risk owners, system owners, data owners. Their responsibilities are explicit (RACI or equivalent) and authorities are clear - what each role can decide unilaterally vs. what requires escalation. Responsibilities flow into job descriptions and employment agreements. Reporting lines are documented. The CISO has a direct line to top management (not buried four levels deep in IT).",
    common_pitfalls: [
      "Roles in the policy but not in actual job descriptions - when a control owner leaves, no one knows they were a control owner",
      "RACI without authority - people listed as \"R\" but with no actual decision-making power",
      "CISO reports to the CIO who reports to the CFO - no real line to top management",
      "Risk owners assigned in the risk register without their knowledge or consent",
      "No update to role assignments when people leave or change role"
    ],
    evidence_to_look_for: [
      { item: "RACI matrix or role-responsibility register", what_it_tells_you: "Whether roles map to specific people, not just functions" },
      { item: "Two or three job descriptions for ISMS-relevant roles, with security responsibilities visible", what_it_tells_you: "Whether responsibilities flow into HR" },
      { item: "Appointment letter or formal communication for at least one role-holder", what_it_tells_you: "Whether the role-holder was formally told" },
      { item: "Org chart showing CISO reporting line to top management", what_it_tells_you: "Whether the role has actual authority" }
    ],
    scoping_notes: "In smaller organizations one person legitimately wears multiple hats. That's fine - but conflicts must be addressed (see A.5.3). Document who owns what; document the conflicts; document the compensating control.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: each information-security responsibility (overall ISMS, risk acceptance, incident response, supplier security, asset ownership) has a named role assigned to a named person. Documented in job descriptions, a RACI, or a roles document, and updated on joiners/movers/leavers. No critical role is unassigned or 'TBD'.",
    maturity_ladder: {
      1: "Roles informal; some people know who owns what",
      2: "RACI documented; responsibilities in JDs; communicated to holders",
      3: "Updated on JML; integrated with HR systems; role-holders accountable in performance terms",
      4: "Role assignments automated against HR; succession documented; effectiveness of role allocation measured"
    },
    related_items: ["clause-5.3", "annex-a.5.3", "annex-a.6.2", "annex-a.5.4"]
  },

  'annex-a.5.3': {
    purpose: "Forces the organization to identify combinations of duties that - if held by one person - create unacceptable risk (a.k.a. \"toxic combinations\"). The classic example: the developer who can also push to production. Or the user-access requestor who is also the approver. Or the system administrator who audits their own activity. A.5.3 requires either real segregation or a documented compensating control.",
    what_good_looks_like: "A documented Segregation-of-Duties analysis lists the toxic combinations relevant to the organization (typically 10-30 entries) and how each is managed - either through technical separation (different roles in different systems), process separation (different people in the workflow), or compensating controls (peer review, immutable logging, periodic external check). The analysis is updated when the org structure changes or systems change. Sample testing (e.g., pull a recent prod deploy and check the developer didn't approve their own change) confirms the controls work.",
    common_pitfalls: [
      "\"We're too small to segregate\" used as blanket excuse without any compensating control documented",
      "SoD analysis exists but is years out of date; no review when team grows or shrinks",
      "Toxic combinations identified in the analysis but no actual control prevents them - analysis without action",
      "Privileged users (sysadmins, DBAs) given roles that combine duties because \"it's easier\"",
      "Compensating controls (peer review, log review) claimed but no evidence they actually happen"
    ],
    evidence_to_look_for: [
      { item: "Segregation-of-Duties register listing toxic combinations and their controls", what_it_tells_you: "Whether the analysis exists" },
      { item: "For one toxic combination, evidence the control works - e.g., recent prod deploys showing developer ≠ approver", what_it_tells_you: "Whether segregation is real" },
      { item: "Compensating control evidence - e.g., the last quarterly peer review of a sysadmin's privileged actions", what_it_tells_you: "Whether compensation is operational, not theoretical" },
      { item: "Update record showing the SoD analysis was reviewed in the last 12 months", what_it_tells_you: "Whether it's alive" }
    ],
    scoping_notes: "Small organizations rely heavily on compensating controls - that's expected and acceptable. What's not acceptable is claiming \"too small\" without documenting which combinations are problematic and what alternative controls are in place. Be specific: \"Sysadmin role conflicts with audit role; compensated by quarterly peer review of audit logs by external accountant.\"",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented segregation-of-duties analysis listing the toxic combinations relevant to the organisation (e.g., dev pushing to prod, requestor approving their own access). Each combination is managed through technical separation, process separation, or a documented compensating control. At least one sampled control test confirms the segregation works in practice.",
    maturity_ladder: {
      1: "SoD discussed informally; no documented analysis",
      2: "Toxic combinations identified; controls or compensating controls in place",
      3: "Analysis maintained; sample testing confirms controls work; reviewed on org change",
      4: "Automated detection of SoD violations (e.g., toxic-role detection in IAM); continuous monitoring"
    },
    related_items: ["annex-a.5.2", "annex-a.5.18", "annex-a.8.2", "annex-a.8.31"]
  },

  'annex-a.5.4': {
    purpose: "Pushes information security accountability into line management. Without this control, security is \"the security team's problem\" - line managers don't see it as part of their job, so their teams don't either. This is the control that turns security from a function into a behavior expectation.",
    what_good_looks_like: "Every line manager has documented expectations for how they ensure their team applies information security: confirming staff completed training, reinforcing acceptable use, addressing security violations through normal performance management, supporting incident reporting, and not creating exceptions for their team. Manager-specific guidance exists (a 2-3 page \"manager's guide to ISMS expectations\"). Managers receive training on their security responsibilities. The expectation appears in their performance objectives, not just in policy.",
    common_pitfalls: [
      "Managers receive the same generic security awareness as staff - no manager-specific content",
      "No manager-level activity expected; security training delivered, end of story",
      "Managers create local exceptions for their team (\"we don't do screen lock here\") that erode policy",
      "Managers unaware that they're accountable for their team's security behavior",
      "No channel for staff to escalate security concerns past their manager when the manager is the problem"
    ],
    evidence_to_look_for: [
      { item: "Manager-specific guidance document (a manager's playbook or briefing)", what_it_tells_you: "Whether the role is defined" },
      { item: "Manager training records - separate from general staff awareness", what_it_tells_you: "Whether managers were specifically prepared" },
      { item: "Performance objectives or scorecard items for managers covering security", what_it_tells_you: "Whether there's accountability" },
      { item: "Channel for staff to escalate concerns past their manager (whistleblower, ethics line)", what_it_tells_you: "Whether the org accounts for the manager-as-problem case" }
    ],
    scoping_notes: "This control is usually under-evidenced because organizations conflate it with awareness training (7.3). They're different: 7.3 is everyone, A.5.4 is managers specifically. Even small orgs need a manager briefing - even if there are only three managers.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: management responsibilities for information security are documented and communicated - at minimum, that managers ensure their staff comply with policies, follow procedures, and report incidents. Reflected in line-management practice (e.g., a manager has actioned a security concern in the last 12 months) or in performance objectives where applicable.",
    maturity_ladder: {
      1: "Manager responsibilities not differentiated from general staff awareness",
      2: "Manager-specific guidance and training exist",
      3: "Performance objectives include security; managers actively reinforce expectations",
      4: "Manager effectiveness measured (team-level security KPIs roll up to manager scorecards)"
    },
    related_items: ["clause-5.3", "clause-7.2", "clause-7.3", "annex-a.6.3", "annex-a.6.4"]
  },

  'annex-a.5.5': {
    purpose: "Ensures the organization knows who to call when something goes wrong - and has the contacts and trigger conditions documented before the crisis, not during it. \"Authorities\" means regulators, law enforcement, sector CERTs, supervisory bodies. The 72-hour GDPR notification deadline is the canonical reason this control matters.",
    what_good_looks_like: "A maintained contact list with named contacts at relevant authorities - data protection regulators, sector regulator (FCA, PRA, OFCOM, etc.), local law enforcement cyber unit, national CERT, sector CERT or ISAC. Contacts include phone, email, and out-of-hours channel where applicable. The list is verified at least annually (test calls or update emails). Trigger conditions are explicit: which incidents require which authority to be notified, within what timeline, by whom. The breach-notification playbook covers GDPR 72h, sector-specific timelines (e.g., DORA 4-hour initial), and contractual customer-notification timelines.",
    common_pitfalls: [
      "Contact list contains a generic email address (\"info@regulator.gov\") rather than a named contact in the relevant team",
      "List is years old; first contact during an actual breach reveals the contact has left",
      "GDPR 72h deadline mentioned but no operational trigger - staff don't know how to start the clock",
      "Sector-specific notification timelines missed because nobody mapped them",
      "Communication channel (regulator's portal, encrypted email) not pre-tested - first use is during an incident"
    ],
    evidence_to_look_for: [
      { item: "Authority contact list with last-verified dates", what_it_tells_you: "Whether the list is alive" },
      { item: "Breach-notification playbook with regulator timelines and the trigger conditions", what_it_tells_you: "Whether the org is operationally ready" },
      { item: "Evidence of a contact verification in the last 12 months (test email, list-update)", what_it_tells_you: "Whether the list is maintained" },
      { item: "Pre-registered communication channels (regulator portals, encrypted email keys)", what_it_tells_you: "Whether channels work before the incident" }
    ],
    scoping_notes: "Jurisdictional. A multinational organization needs contacts per jurisdiction. A UK-only org needs ICO + sector regulator + local police cyber unit. The trigger conditions are specific to the incident type (data breach vs. operational disruption vs. fraud) and to the regulatory regime.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented list of authorities (data-protection regulators, sector regulators, law-enforcement contacts, national CERTs) the organisation must notify or engage with on security matters, with named contacts and notification thresholds. Updated in the last 12 months. Engagement records exist where any contact occurred.",
    maturity_ladder: {
      1: "Contacts known informally; no documented list",
      2: "Documented list with triggers; reviewed annually",
      3: "Channels pre-tested; playbook integrated with IR; staff trained on triggers",
      4: "Notification rehearsed in IR exercises; regulator relationships proactive (regular check-ins)"
    },
    related_items: ["annex-a.5.24", "annex-a.5.31", "annex-a.5.34", "annex-a.6.8"]
  },

  'annex-a.5.6': {
    purpose: "Connects the organization to peer networks where threat intelligence, advisories, and operational know-how flow - sector ISACs, vendor security groups, government-led forums, professional bodies. Without these, the security team is reading public news for threats that the rest of the sector saw 48 hours earlier through ISAC channels.",
    what_good_looks_like: "Documented memberships and subscriptions appropriate to the organization's sector and size: sector ISAC (FS-ISAC, H-ISAC, Auto-ISAC, etc.), national CERT advisory feed, vendor-specific PSIRT subscriptions for major products, industry forums. Someone is responsible for monitoring each channel. Intel coming through these channels is triaged and feeds the threat intelligence function (A.5.7). Membership is reviewed periodically - useful subscriptions kept, unused ones cancelled.",
    common_pitfalls: [
      "Subscriptions paid annually but no one consumes them - \"we have access\" without a reading process",
      "Intel arrives in someone's personal email and dies there",
      "No triage - every advisory treated as urgent, alert fatigue sets in",
      "Membership in the wrong groups for the org's sector (or the right groups but no relevant participation)"
    ],
    evidence_to_look_for: [
      { item: "List of memberships and subscriptions with the responsible team or person", what_it_tells_you: "Whether someone owns each channel" },
      { item: "Sample advisory from one channel that was triaged and led to action (control change, patching, hunting)", what_it_tells_you: "Whether the channels feed real outputs" },
      { item: "Annual review of membership relevance", what_it_tells_you: "Whether the portfolio is curated" }
    ],
    scoping_notes: "Relevance varies by sector. Financial services should be in FS-ISAC; healthcare in H-ISAC; critical infrastructure in the relevant sector ISAC. For a small org without an ISAC budget, a national CERT subscription plus a free advisory feed (CISA, NCSC) is a reasonable floor.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: documented membership of, or engagement with, relevant security communities - ISACs, vendor user groups, professional bodies, regional CERT distribution lists. Evidence the engagement produces actionable inputs (a control change, a hunt, a risk added) at least once per cycle.",
    maturity_ladder: {
      1: "Ad-hoc participation; no documented memberships",
      2: "Memberships documented; channels monitored",
      3: "Intel triaged and feeds threat intelligence and detection",
      4: "Active contribution back to the community; reciprocal sharing; intel drives proactive control changes"
    },
    related_items: ["annex-a.5.7", "annex-a.5.5"]
  },

  'annex-a.5.7': {
    purpose: "New in ISO 27001:2022. Requires the organization to actually do threat intelligence - collect from relevant sources, analyse for relevance, and act. Pre-2022 ISMSs treated threat intel as a vendor product; the 2022 standard makes it an explicit control with collect / analyse / act stages.",
    what_good_looks_like: "Documented threat intelligence sources covering the three layers: strategic (sector trends, regulatory shifts), operational (TTPs, campaigns), and tactical (IOCs, signatures). Sources are mixed: at least one paid feed, OSS feeds (MISP, CISA, NCSC, vendor advisories), sector ISAC, internal telemetry. A documented analysis approach - relevance filter (what matches our tech stack and sector?), severity assessment, action triage. Outputs feed three places: risk assessment (does this threat change our risk picture?), control decisions (do we need new detections, new patches, new policy?), incident detection (do these IOCs go into the SIEM?). Cases where intel led to action are recorded.",
    common_pitfalls: [
      "Feeds bought but never consumed - \"we have access to ThreatVendor X\" with no integration",
      "Fire-hose approach - no relevance filter, analyst burns out, no action follows",
      "Strategic intel reaches the CISO but tactical IOCs never reach the SOC, or vice versa",
      "No record of intel leading to action; nothing to point at when an auditor asks for evidence",
      "Treating threat intel as just \"reading vendor reports\" without analysis or action"
    ],
    evidence_to_look_for: [
      { item: "List of threat intelligence sources with their type (strategic / operational / tactical) and frequency", what_it_tells_you: "Whether the sourcing is deliberate" },
      { item: "Sample intel report with relevance assessment, severity, and recommended action", what_it_tells_you: "Whether analysis happens" },
      { item: "One concrete example of intel that led to a control change, hunt, patch, or detection rule in the last 6 months", what_it_tells_you: "Whether the act stage is real" },
      { item: "Integration evidence - IOCs flowing into SIEM/EDR; advisories flowing into vulnerability management", what_it_tells_you: "Whether outputs reach the operational tools" }
    ],
    scoping_notes: "Sophistication varies enormously. A small org may rely on free OSS feeds plus their MSSP's threat intel. A large org has a dedicated threat intel team. Both can satisfy A.5.7 if they show collect / analyse / act. What can't satisfy it: claiming you do threat intel because you read security news.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented threat-intelligence process - even if it is just subscribing to a defined set of free feeds (CISA / NCSC / sector ISAC / key vendor advisories) and reviewing them on a stated cadence. Evidence the intel has been used at least once in the past 6 months - a risk added, a control tightened, a patch prioritised, a detection rule tuned. No paid feed required for a small org, but a documented routine is.",
    maturity_ladder: {
      1: "Ad-hoc reading of vendor reports; no documented sources or process",
      2: "Documented sources; some analysis; occasional action",
      3: "Tiered sources; relevance filtering; routine integration with detection and patching",
      4: "Threat intel drives proactive hunting and control evolution; intel program metrics tracked"
    },
    related_items: ["annex-a.5.6", "annex-a.5.25", "annex-a.8.16", "annex-a.8.8"]
  },

  'annex-a.5.8': {
    purpose: "New in 2022. Forces information security activities into the standard project lifecycle so security is designed in, not bolted on. Pre-2022 it was implicit; the 2022 standard makes it an explicit control because too many organizations treated security as a Stage Gate 4 box-tick.",
    what_good_looks_like: "The organization's project methodology (PRINCE2, Agile, hybrid - doesn't matter which) has security activities embedded throughout: kickoff risk assessment, security requirements specified in design, threat modelling at architecture, security testing before release, security closure check. Project managers are trained on the security activities they need to lead. Security gates are real - projects can be held at a gate if security requirements aren't met. Applies to all projects affecting information security, not just \"security projects.\"",
    common_pitfalls: [
      "Security activities tacked on at the end of projects - pen test the week before release, find issues, ship anyway",
      "Project managers untrained on security - no idea what \"security requirements\" means",
      "Security gates exist on paper but get waived under deadline pressure",
      "Only \"security projects\" considered in scope; business projects with major security implications (new product, new integration, new supplier) skip the process",
      "Agile teams claim \"continuous security\" without showing the touchpoints"
    ],
    evidence_to_look_for: [
      { item: "Project methodology document showing security activities at each stage", what_it_tells_you: "Whether security is integrated" },
      { item: "Sample project with security artifacts at each gate (risk assessment, requirements, threat model, test results, closure check)", what_it_tells_you: "Whether the methodology is followed" },
      { item: "Evidence of a project being held at a security gate (rare but valuable - shows gates have teeth)", what_it_tells_you: "Whether gates are real" },
      { item: "Project manager training records covering security activities", what_it_tells_you: "Whether PMs are equipped" }
    ],
    scoping_notes: "Applies across project types - IT projects, business projects with information security impact, M&A integration, regulatory programmes. Small orgs with informal project management still need to show security touchpoints exist; the formality scales but the activity does not become optional.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: the organisation's project methodology has security activities embedded throughout - security risk assessment at kickoff, security requirements in design, security testing before release, and a security closure check. Applies to all projects affecting information security, not just security projects. Sampled project shows the activities were performed.",
    maturity_ladder: {
      1: "Security tacked on at end of some projects",
      2: "Security activities defined in methodology; PMs trained",
      3: "Security gates with teeth; followed across project types; activities adapted to project size",
      4: "Security integrated into product development metrics; security debt tracked at portfolio level"
    },
    related_items: ["annex-a.5.19", "annex-a.8.25", "annex-a.8.26", "annex-a.8.27", "annex-a.8.32"]
  },

  'annex-a.5.9': {
    purpose: "The asset register. Without knowing what information assets and supporting assets exist, you can't classify them, can't protect them, can't recover them, can't decommission them safely. This is the spine of the entire ISMS - almost every other control assumes A.5.9 is solved.",
    what_good_looks_like: "Two registers (or one combined register clearly distinguishing them): information assets (data sets, document repositories, key databases) and supporting assets (servers, endpoints, network devices, mobile devices, software). Each asset has an owner, a classification (per A.5.12), a location, and a lifecycle state. The registers are kept current through procurement integration (new system → new entry), JML (joiner gets device → entry; leaver returns device → state change), and decommissioning. Periodic reconciliation against discovery tooling (CMDB, network scans, cloud inventory) catches drift.",
    common_pitfalls: [
      "Asset register is just the IT CMDB - supporting assets only, no information assets",
      "Information assets register lists \"customer data\" as one item - too coarse to be useful",
      "Stale by 6+ months; new systems missing, decommissioned ones still listed",
      "No asset owner per asset, or owner is \"IT\"",
      "Shadow IT not captured - SaaS bought on a credit card by Marketing isn't in the register",
      "Cloud resources (S3 buckets, RDS instances) not inventoried"
    ],
    evidence_to_look_for: [
      { item: "Information asset register with owner, classification, location for each entry", what_it_tells_you: "Whether information assets are inventoried distinctly" },
      { item: "Supporting asset register / CMDB with owner and classification", what_it_tells_you: "Whether supporting infrastructure is inventoried" },
      { item: "Sample asset showing recent updates - last review date, recent state changes", what_it_tells_you: "Whether the register is alive" },
      { item: "Reconciliation evidence - last comparison of register against discovery tooling, with drift remediated", what_it_tells_you: "Whether accuracy is maintained" },
      { item: "Procurement integration - sample new asset that entered the register on procurement", what_it_tells_you: "Whether new assets get captured" }
    ],
    scoping_notes: "Information assets and supporting assets are distinct - a CRM database is an information asset; the server hosting it is a supporting asset. Both should be inventoried but the management treatment differs (you classify information assets; you control supporting assets). Cloud creates a third category that's effectively both - handle deliberately.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a current inventory of information assets (data, systems, services) and associated assets (hardware, software, suppliers) within scope, with named owners. Reviewed in the last 12 months. The inventory is the source the SoA and risk register reference, not a separate parallel list.",
    maturity_ladder: {
      1: "Partial register; mostly IT inventory; gaps in information assets",
      2: "Both registers exist; owners assigned; reviewed periodically",
      3: "Reconciled against discovery tooling; updated on procurement and JML; covers cloud and shadow IT",
      4: "Real-time asset visibility; automated discovery feeds register; unauthorised assets detected and remediated"
    },
    related_items: ["clause-4.3", "annex-a.5.10", "annex-a.5.11", "annex-a.5.12", "annex-a.7.10", "annex-a.7.14"]
  },

  'annex-a.5.10': {
    purpose: "The Acceptable Use Policy - the rules that tell users what they can and cannot do with the organization's information and assets. This is the document that turns abstract security principles into operational rules a regular employee can understand and follow.",
    what_good_looks_like: "A 2-4 page Acceptable Use Policy covering: devices (organization-issued and BYOD), networks (corporate, guest, VPN, public Wi-Fi), applications (approved vs. unapproved, shadow IT), removable media, information sharing (internal, external, cloud sync), password and authentication hygiene, reporting suspicious activity. Written in plain English, not legalese. Communicated at hire (induction), on every material change, and acknowledged by signature or LMS attestation. Enforcement is real - repeat violations go through the disciplinary process (A.6.4). Coverage extends to contractors and third parties under organizational control.",
    common_pitfalls: [
      "AUP exists but is vague (\"use assets responsibly\") with no concrete rules",
      "No acknowledgement records - claim is \"everyone has read it\" but no proof",
      "Doesn't cover BYOD or remote work despite organization having both",
      "Not enforced - known violations result in nothing happening, eroding the rule",
      "30 pages long - staff don't read it; just click acknowledge",
      "Contractors and consultants on-site without AUP acknowledgement"
    ],
    evidence_to_look_for: [
      { item: "The AUP itself, with version block, owner, last review date", what_it_tells_you: "Whether the document is maintained" },
      { item: "Acknowledgement records covering current staff (LMS report, HR system flag, signed forms)", what_it_tells_you: "Whether communication and acceptance happened" },
      { item: "Contractor / third-party acknowledgement evidence", what_it_tells_you: "Whether scope is broad enough" },
      { item: "Recent enforcement example - a known violation that went through the disciplinary process", what_it_tells_you: "Whether the policy has teeth" },
      { item: "Re-acknowledgement on policy change", what_it_tells_you: "Whether updates are communicated" }
    ],
    scoping_notes: "AUP is one document, kept short, kept current. The detail goes into supporting procedures (e.g., remote-work guide, BYOD setup guide). The AUP states the rules; the procedures explain how to follow them. Don't try to fit everything into the AUP.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: an acceptable-use and asset-handling policy covering classification, handling, transmission, storage, and disposal of information. Staff have acknowledged it (signed AUP or e-learning completion record) on hire and on material change. The asset register includes a classification field that is actually populated for in-scope assets.",
    maturity_ladder: {
      1: "Vague AUP; no acknowledgement; not enforced",
      2: "Specific rules; acknowledgement on hire; periodic re-acknowledgement",
      3: "Updated on material change; enforcement consistent; covers all categories of users",
      4: "Effectiveness measured (violation rates, comprehension surveys); rules updated based on data"
    },
    related_items: ["annex-a.5.15", "annex-a.6.4", "annex-a.6.7", "annex-a.7.7", "annex-a.8.1"]
  },

  'annex-a.5.11': {
    purpose: "Closes the loop on people leaving or changing role: organizational assets must come back, and access must come off. The single biggest source of avoidable security exposure in any organization is the leaver who walked away with their laptop, their credentials still active, and their VPN token in their bag.",
    what_good_looks_like: "An off-boarding (or transfer) process triggered by HR notification - not by the leaver telling IT. A checklist covers physical assets (laptop, phone, badges, tokens, smart cards, peripherals), digital assets (organizational data on personal devices, accounts on SaaS not in SSO, software licences), and access revocation across all systems (handled under A.5.18). Each item is tracked with status; final sign-off only happens when everything is accounted for. BYOD has an explicit data-removal step (selective wipe via MDM, manual confirmation, or both). For role changes (movers), the equivalent - rights from the old role come off, rights for the new role go on, and there's no \"accumulate forever\" pattern.",
    common_pitfalls: [
      "Process triggered by IT noticing rather than HR notifying - leavers can disappear from the building before IT knows",
      "Physical assets recovered but no check on data-on-personal-device for BYOD users",
      "Cloud/SaaS access not in SSO not revoked - leaver retains access to design tools, marketing platforms, dev environments",
      "No tracking - claim is \"we always recover assets\" with no records to show",
      "Movers process missing - joiner and leaver covered, but role-changers accumulate access indefinitely",
      "Intellectual property created on personal devices not addressed at off-boarding"
    ],
    evidence_to_look_for: [
      { item: "Off-boarding process document with the asset-return checklist", what_it_tells_you: "Whether the process is defined" },
      { item: "Sample leaver case from the last 90 days showing the full trail - HR trigger, asset return log, access revocation evidence, sign-off", what_it_tells_you: "Whether the process actually executes" },
      { item: "Asset-recovery rate metric (% of leavers with all assets accounted for within SLA)", what_it_tells_you: "Whether outcomes are measured" },
      { item: "BYOD-specific evidence - selective wipe records, attestations of data removal", what_it_tells_you: "Whether BYOD off-boarding is real" },
      { item: "HR-IT integration - automated trigger or formal notification mechanism", what_it_tells_you: "Whether the trigger is reliable" }
    ],
    scoping_notes: "BYOD complicates this control significantly. Decide your approach: contain organizational data inside an MDM container so it can be wiped without touching personal data, or have a formal data-removal attestation as part of off-boarding. Either is acceptable - undocumented is not.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented off-boarding (and transfer) process triggered by HR notification - not by IT noticing. A checklist covers physical assets, digital assets (including BYOD data removal), and access revocation across all systems within an SLA. Leaver tickets in the last 12 months show the SLA was met.",
    maturity_ladder: {
      1: "Process informal; gaps in BYOD and SaaS",
      2: "Documented checklist; HR-triggered; recovery tracked",
      3: "Movers process equal to leavers; metrics tracked; BYOD addressed",
      4: "Automated off-boarding orchestration across all systems; recovery rate measured; outliers investigated"
    },
    related_items: ["annex-a.5.18", "annex-a.6.5", "annex-a.7.10", "annex-a.8.1"]
  },

  'annex-a.5.12': {
    purpose: "The classification scheme. Tells the organization which information is sensitive enough to warrant which level of protection. Without it, every dataset gets the same treatment, which means either over-protecting public data (cost) or under-protecting confidential data (risk). The classification scheme is the foundation that A.5.13 (labelling), A.5.14 (transfer), A.5.33 (records), and most data-handling controls depend on.",
    what_good_looks_like: "A simple 3-5 level scheme - typically Public / Internal / Confidential / Restricted - with crisp definitions: who can see it, what happens if it leaks, examples per level. Each level has handling rules (storage, transmission, disposal). A default classification for unclassified data (usually Internal). Information owners apply classification at creation; classifications are reviewed when value or sensitivity changes (e.g., a strategy doc reclassified after public announcement). Distinct from PII categorization - privacy and classification are related but separate.",
    common_pitfalls: [
      "Scheme too complex - 8 levels with subtle distinctions that nobody remembers, so nobody applies it",
      "Scheme exists but data not actually classified - the labels live only in the policy",
      "No default classification - unclassified data sits in limbo",
      "Reviews don't happen; classifications set at creation never revisited",
      "PII handling conflated with classification - \"Confidential\" treated as a synonym for \"contains personal data\"",
      "No examples per level - staff can't tell whether a doc is Internal or Confidential"
    ],
    evidence_to_look_for: [
      { item: "Classification scheme document with definitions, examples, and handling rules per level", what_it_tells_you: "Whether the scheme is operational" },
      { item: "Sample of three to five datasets showing applied classification and the rationale", what_it_tells_you: "Whether classification happens in practice" },
      { item: "Default classification policy", what_it_tells_you: "Whether unclassified data is covered" },
      { item: "Reclassification record - at least one example of a classification changing", what_it_tells_you: "Whether reviews happen" }
    ],
    scoping_notes: "Keep it simple - 3-5 levels max. The temptation is to capture every nuance with more levels; it backfires because staff stop applying anything. If you need more granularity, do it through handling rules, not more levels. Classification applies to information assets; supporting assets (servers, devices) inherit the highest classification of data they hold.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented information-classification scheme (typically 3-4 levels: Public, Internal, Confidential, Restricted) with criteria for each level. Applied to at least the high-impact information assets in the inventory. Staff have been told what the levels mean and how to apply them.",
    maturity_ladder: {
      1: "Scheme exists; not applied",
      2: "Scheme applied to most data; handling rules documented",
      3: "Classification reviewed on triggers; tooling helps detect misclassification",
      4: "Automated classification for major data stores; classification metrics tracked"
    },
    related_items: ["annex-a.5.9", "annex-a.5.13", "annex-a.5.14", "annex-a.5.33", "annex-a.5.34"]
  },

  'annex-a.5.13': {
    purpose: "Translates the classification scheme (A.5.12) into operational reality by labelling information so people can see its sensitivity at a glance. Without labelling, classification is theoretical - staff have no way to tell that this email contains Confidential information without reading and judging.",
    what_good_looks_like: "Labelling procedures cover every format the organization uses meaningfully - documents (header/footer), emails (subject prefix or sensitivity label), spreadsheets and presentations, removable media (physical labels), system records (database flags or column metadata), and chat/collaboration tools (e.g., Teams or Slack channel naming or sensitivity tagging). Automated labelling is used where the toolset supports it (Microsoft Purview / MIP, Google Workspace classifications, DLP integrations). Labels are visible - a recipient can tell at a glance. Labels link to handling rules so the label drives behavior (e.g., Restricted-labelled email triggers an external-recipient warning).",
    common_pitfalls: [
      "Classification scheme exists but no labelling in practice - auditors pull a sample and find nothing labelled",
      "Manual labelling required but not done by busy staff",
      "Labelling tool deployed but not enforced - users dismiss the prompt",
      "Some formats addressed (documents, email) but not others (chat, code, databases)",
      "Labels exist but don't drive behavior - Confidential email goes through the same channel as Public",
      "Inconsistent labelling - some teams use sensitivity labels, others use file-name prefixes, others don't bother"
    ],
    evidence_to_look_for: [
      { item: "Labelling procedures per format", what_it_tells_you: "Whether the rules exist" },
      { item: "Sample of recently-created documents and emails showing labels applied", what_it_tells_you: "Whether labelling is happening" },
      { item: "Labelling tool configuration (Purview, MIP, equivalent) showing enforced labels and policies", what_it_tells_you: "Whether automation backs the procedures" },
      { item: "Linkage between label and handling - e.g., DLP rule that triggers on Confidential label", what_it_tells_you: "Whether labels drive behavior" }
    ],
    scoping_notes: "Don't try to label every format perfectly on day one. Pick the highest-impact formats first (documents, email, removable media), get labelling working there, then expand. Modern stacks (M365, Google Workspace) make automated labelling much easier than manual procedures.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a labelling procedure aligned with the classification scheme covering at minimum digital documents and email containing Confidential/Restricted information. Applied in practice for at least the high-impact information assets. Tooling support (DLP / IRM / template) where the volume warrants it.",
    maturity_ladder: {
      1: "Scheme exists; manual labelling sporadic",
      2: "Procedures documented per format; labels applied to most output",
      3: "Automated labelling for major formats; labels drive handling rules",
      4: "ML-assisted classification and labelling; coverage approaches 100%; metrics on label accuracy"
    },
    related_items: ["annex-a.5.12", "annex-a.5.14", "annex-a.5.33"]
  },

  'annex-a.5.14': {
    purpose: "Defines the rules for moving information between people, systems, and organizations - internal transfers, external transfers, and transfers to third parties. Information in motion is when most data leakage happens: emailed to the wrong recipient, uploaded to a personal cloud, shared via an unsanctioned channel.",
    what_good_looks_like: "Transfer rules differentiated by classification - Public can go anywhere; Internal stays inside org boundaries unless explicitly approved; Confidential requires encryption in transit and verified recipient; Restricted requires named-recipient approval, encryption, and often out-of-band channel exchange (e.g., SFTP with separately-shared key). Approved channels are listed; forbidden channels (personal email, public file-sharing without org approval) are explicit. NDAs or data-transfer agreements with external parties cover what they can do with the information after transfer. Staff training reinforces the rules.",
    common_pitfalls: [
      "One-size-fits-all rule - \"use encryption\" without distinguishing classifications",
      "Confidential information emailed externally without encryption because the user thought TLS was enough",
      "Staff use unauthorized tools (WeTransfer, personal Dropbox, SFTP set up by IT under the radar) because approved channels are clunky",
      "External transfers to third parties without an NDA or DTA covering what they can do with the data afterward",
      "No rules for emerging channels - chat-app file sharing, AI tool inputs, collaboration platforms",
      "Approved channels list out of date; tools that the org hasn't blocked are still in active use"
    ],
    evidence_to_look_for: [
      { item: "Information transfer rules document with classification-based differentiation", what_it_tells_you: "Whether rules are calibrated to risk" },
      { item: "Approved channels list and forbidden channels list", what_it_tells_you: "Whether staff know what to use" },
      { item: "Sample of a recent high-classification transfer following the rules - encrypted, approved channel, recipient verified", what_it_tells_you: "Whether rules are followed in practice" },
      { item: "NDA or DTA template; sample executed agreement with a current third party", what_it_tells_you: "Whether external transfers are governed" },
      { item: "DLP or monitoring evidence catching policy violations", what_it_tells_you: "Whether enforcement happens" }
    ],
    scoping_notes: "Covers internal AND external transfers; internal is often forgotten. \"Confidential\" data emailed to a colleague in another department still requires the appropriate channel. Modern collaboration platforms (Teams, Slack, SharePoint) need explicit consideration - they're transfer channels even if they feel like \"internal storage.\"",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented information-transfer policy covering channels (email, file-sharing, removable media, physical mail, courier) and the controls applied per classification level (encryption, recipient verification, transit logging). Sampled transfer of Confidential or higher shows the controls were applied.",
    maturity_ladder: {
      1: "Generic rules; staff unclear",
      2: "Classification-based rules; approved channels listed; staff trained",
      3: "DLP enforces rules; violations investigated; external transfers covered by agreements",
      4: "Continuous monitoring of transfer patterns; automated blocking for high-risk; DLP tuned to false-positive rate"
    },
    related_items: ["annex-a.5.10", "annex-a.5.12", "annex-a.5.13", "annex-a.8.12", "annex-a.8.24"]
  },

  'annex-a.5.16': {
    purpose: "Manages the lifecycle of identity itself - the digital representation of every user, device, and service in the organization's systems. A.5.15 says \"have rules\"; A.5.18 manages access rights; A.5.16 is specifically about who you are. Get this wrong and the rest of access control is built on sand.",
    what_good_looks_like: "Every identity is unique and traceable to either a person (via HR) or an owning system (for service accounts). Identities are sourced from authoritative systems: staff identities from HRIS, contractor identities from a contractor register or supplier system, customer identities from CRM. Joiner-Mover-Leaver triggers from those authoritative systems propagate to all downstream identity systems via SSO/SCIM/automation. Service and shared accounts are explicitly justified, named-owned, secrets-vaulted, rotation-tracked, and reviewed periodically. Periodic reconciliation between identity systems and HR catches drift (active accounts for ex-employees, missing accounts for new joiners).",
    common_pitfalls: [
      "Shared service accounts everywhere - generic \"app1_svc\" accounts with no owner, the password hasn't changed in years",
      "Ex-employees still have active accounts because off-boarding fired in HR but didn't propagate to all systems",
      "Contractor identities created ad-hoc with no authoritative source - when the contractor leaves, nothing knows to revoke",
      "No reconciliation - drift between HR and identity systems accumulates",
      "SSO covers some systems but legacy/SaaS/cloud accounts are managed separately and out of view",
      "Shared logins for \"convenience\" (a team uses one login to a tool) - no SoD, no traceability"
    ],
    evidence_to_look_for: [
      { item: "Identity directory tied to authoritative source (HRIS for staff)", what_it_tells_you: "Whether identities are sourced, not invented" },
      { item: "Service-account register with owner, purpose, secret-rotation date, and last review", what_it_tells_you: "Whether shared accounts are governed" },
      { item: "Reconciliation record - recent comparison of identity systems against HR with discrepancies remediated", what_it_tells_you: "Whether drift is caught" },
      { item: "Sample joiner showing identity flowing from HR to all downstream systems", what_it_tells_you: "Whether JML propagation works" },
      { item: "Sample leaver showing identity disabled across all systems within SLA", what_it_tells_you: "Whether off-boarding is comprehensive" }
    ],
    scoping_notes: "Identity sprawl is the modern enterprise's biggest hidden risk. Even with SSO, there are usually 20-50% of systems where identities are managed locally. Scope this control deliberately: list every system that has its own user database, decide how identity is governed there, and document the exceptions.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented identity-management process covering issuance, change, suspension, and revocation of identities across in-scope systems. Tied to the HR joiner-mover-leaver workflow. Service-account and machine-identity lifecycle is also covered. Periodic recertification of high-risk identities.",
    maturity_ladder: {
      1: "Identity managed per-system; gaps in JML",
      2: "SSO for major systems; service accounts inventoried",
      3: "JML automated end-to-end; reconciliation regular; service accounts vaulted and rotated",
      4: "Identity governance platform; continuous attestation; zero-trust identity foundations"
    },
    related_items: ["annex-a.5.15", "annex-a.5.17", "annex-a.5.18", "annex-a.6.5", "annex-a.5.11"]
  },

  'annex-a.5.17': {
    purpose: "Governs the lifecycle of authentication information itself - passwords, MFA factors, certificates, API keys, SSH keys. A.5.16 manages identity; A.5.17 manages how identity is proved. Everything from \"how do new users get their first credential\" to \"how are credentials stored\" to \"what happens on compromise\" lives here.",
    what_good_looks_like: "Documented rules for issuing credentials (out-of-band for sensitive systems - never email a password and the user ID together), storage (passwords hashed with bcrypt/argon2/scrypt - never reversibly encrypted, never plaintext), strength (length-led modern policy - 12+ characters, no forced rotation absent compromise), MFA enforcement on all sensitive systems and all privileged access. Users have a clear reset / recovery path that doesn't compromise security (no \"call IT and tell them your DOB\"). Credentials are revoked promptly on compromise, role change, or termination. Default credentials in deployed systems are changed before go-live. API keys and machine credentials are vaulted, rotated, and scoped.",
    common_pitfalls: [
      "Passwords stored reversibly or hashed with weak algorithms (MD5, SHA1) - disclosed in a breach and the entire user base is exposed",
      "MFA optional even for sensitive systems; SOC and admin accounts use single-factor",
      "Default credentials in deployed systems (\"admin/admin\" still active a year after install)",
      "Shared credentials across team members; no traceability to individual",
      "API keys checked into code repositories or hardcoded in config files",
      "Reset path is the weak link - phish the helpdesk and you're in",
      "Forced rotation policies (90-day password change) without compromise driver - leads to weaker passwords"
    ],
    evidence_to_look_for: [
      { item: "Authentication policy covering all credential types", what_it_tells_you: "Whether rules are explicit" },
      { item: "Password storage analysis - what hashing algorithm, what salt, where stored", what_it_tells_you: "Whether storage is sound" },
      { item: "MFA coverage report - which systems require MFA, which users have it enabled", what_it_tells_you: "Whether MFA is real" },
      { item: "Sample credential issuance for a recent joiner - out-of-band evidence", what_it_tells_you: "Whether the issuance process is followed" },
      { item: "Secrets management evidence - vault config, rotation records for service-account credentials", what_it_tells_you: "Whether machine credentials are governed" },
      { item: "Helpdesk reset procedure with verification steps", what_it_tells_you: "Whether the recovery path is hardened" }
    ],
    scoping_notes: "Modern guidance (NIST 800-63B, NCSC) has moved away from forced password rotation toward length, MFA, and breach-monitoring. Don't justify weak-but-rotated as \"following policy\" - auditors increasingly know what current good practice looks like.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented authentication-information management policy covering passwords, MFA factors, certificates, and API keys - issuance, distribution, storage, change, and revocation. Default credentials are changed before deployment. Secrets are not stored in source control.",
    maturity_ladder: {
      1: "Basic password policy; MFA partial",
      2: "Modern password policy; MFA on sensitive systems; secrets in vault",
      3: "Risk-based authentication; phish-resistant MFA for privileged; full vault adoption",
      4: "Passwordless or near-passwordless; continuous credential-compromise monitoring; breach-driven credential refresh"
    },
    related_items: ["annex-a.5.15", "annex-a.5.16", "annex-a.5.18", "annex-a.8.5"]
  },

  'annex-a.5.18': {
    purpose: "The operational engine of access control. A.5.15 sets the rules; A.5.16 manages the identities; A.5.18 grants, modifies, revokes, and reviews the actual access rights. This is the control auditors sample most heavily - a recent joiner, a recent leaver, a recent access review - because it's where the gap between policy and practice is most visible.",
    what_good_looks_like: "Access provisioning is request-and-approval based: documented request, manager and (for sensitive systems) data-owner approval, ticket-trail through grant. Modifications on role change happen through the same process - old role's access removed, new role's access granted, no accumulation. Revocation on termination has an SLA (same-day for sensitive, next-business-day at most) and is comprehensive across all systems. Periodic access reviews are conducted per system, with frequency calibrated to risk: privileged access at least quarterly, high-sensitivity systems at least semi-annually, general access annually. Reviews produce documented decisions - keep, modify, revoke - not just sign-offs.",
    common_pitfalls: [
      "Leaver SLA missed regularly - auditors sample two leavers, find one with active accounts a week later",
      "Access reviews happen but are rubber-stamped - reviewer signs off without inspecting actual permissions",
      "Risk-based review frequency missing - privileged access reviewed at the same cadence as general access",
      "Modifications not addressed - role-changers accumulate access from every prior role",
      "Access reviews don't capture decisions - \"reviewed\" is the only output, no list of revocations or modifications",
      "Privileged access not differentiated - same review process for read-only access and DBA"
    ],
    evidence_to_look_for: [
      { item: "Provisioning trail for one recent joiner - request, approvals, grant timestamps across systems", what_it_tells_you: "Whether provisioning follows the process" },
      { item: "Revocation trail for one recent leaver - termination notification through revocation across all systems with timestamps", what_it_tells_you: "Whether the leaver SLA is real" },
      { item: "Most recent access review for a sensitive system - list of users, decisions made, revocations executed", what_it_tells_you: "Whether reviews produce action" },
      { item: "Privileged-access review (separate from general access)", what_it_tells_you: "Whether privileged access has stronger oversight" },
      { item: "SLA metric - % of leavers fully revoked within SLA over the last 12 months", what_it_tells_you: "Whether outcomes are tracked" }
    ],
    scoping_notes: "Privileged access deserves its own sub-process. So does access for systems handling PII or regulated data. The general-access cadence (e.g., annual) doesn't fit privileged access (should be quarterly minimum) or super-sensitive access (continuous monitoring). Document the tiering.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: access rights are granted based on documented role/business requirement, reviewed at defined intervals (typically annual full review, more frequent for privileged), and revoked promptly on leaver/transfer. Recent access-review evidence covers at least the high-risk systems.",
    maturity_ladder: {
      1: "Access requests informal; reviews sporadic",
      2: "Documented process; reviews on cadence; SLAs defined",
      3: "Risk-tiered review frequency; privileged-access governance; SLA metrics tracked",
      4: "Continuous access governance - automated detection of dormant access, toxic combinations, unused privileges; just-in-time access for sensitive operations"
    },
    related_items: ["annex-a.5.15", "annex-a.5.16", "annex-a.5.17", "annex-a.5.11", "annex-a.8.2"]
  },

  'annex-a.5.19': {
    purpose: "The supplier-relationship foundation. Identifies which suppliers are in scope (those with access to the organization's information or providing services that touch the ISMS), assesses the risk each represents, and defines the security requirements that flow from that risk. Without this control, every supplier gets the same treatment regardless of what they actually do.",
    what_good_looks_like: "A maintained supplier register listing every supplier with information-security relevance - anyone with access to organizational data, anyone running infrastructure that processes it, anyone providing services in scope of the ISMS. Each supplier has a documented risk assessment looking at criticality (what depends on them), data sensitivity (what they handle), and threat exposure (their security posture). Suppliers are tiered (e.g., Tier 1 critical / Tier 2 important / Tier 3 routine), with security requirements scaled to tier. The register is reviewed when the supplier portfolio changes (new contracts, terminations, scope changes).",
    common_pitfalls: [
      "Same security questionnaire to every supplier regardless of risk - Tier 3 SaaS for office snacks and Tier 1 cloud provider get identical 200-question forms",
      "\"In scope\" criteria undocumented - different teams have different views of who counts as a supplier",
      "Sub-suppliers (4th parties) ignored - focus only on direct contracts",
      "Supplier register lives in procurement and security never sees it",
      "New SaaS purchased on a credit card by individual teams never enters the register",
      "Risk assessment done at onboarding only, never refreshed even after the supplier has a major breach"
    ],
    evidence_to_look_for: [
      { item: "Supplier register with tiering / risk ratings", what_it_tells_you: "Whether the org knows its supplier landscape" },
      { item: "Documented criteria for \"in scope\"", what_it_tells_you: "Whether the register's boundary is defined" },
      { item: "Risk assessments for two suppliers at different tiers showing different depth", what_it_tells_you: "Whether risk-proportionate assessment happens" },
      { item: "Procurement integration evidence - new suppliers entering the register on contract signature", what_it_tells_you: "Whether new suppliers are caught" },
      { item: "Periodic refresh - sample supplier whose risk assessment was updated in the last 12 months", what_it_tells_you: "Whether the register is alive" }
    ],
    scoping_notes: "The hardest part is defining scope. Be inclusive: anyone with access to organizational systems, anyone holding data on their infrastructure, anyone whose service is in the ISMS scope. Don't forget OSS and cloud: open-source dependencies are technically a supply-chain consideration (covered more in A.5.21) but cloud providers are absolutely suppliers.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a supplier-security policy and process covering identification of supplier-related risks, classification of suppliers by risk, security clauses in contracts, and a review/oversight cadence proportional to risk. A current supplier register exists with risk-tiering.",
    maturity_ladder: {
      1: "Supplier list incomplete; no risk tiering",
      2: "Register exists with tiering; assessments per tier",
      3: "Procurement integrated; refresh on schedule and triggers; sub-suppliers visible",
      4: "Continuous supplier risk monitoring (third-party risk platform); proactive on supplier-side incidents"
    },
    related_items: ["annex-a.5.20", "annex-a.5.21", "annex-a.5.22", "annex-a.5.23"]
  },

  'annex-a.5.20': {
    purpose: "Embeds security into the contract itself. A.5.19 identifies and assesses suppliers; A.5.20 makes sure the legal agreement reflects what security needs them to do. Without contractual clauses, every security requirement from the supplier is a request, not an obligation.",
    what_good_looks_like: "A contract template (or supplier-security exhibit) maintained by legal in partnership with information security. Standard clauses cover confidentiality, security obligations, incident notification (with explicit timeline - e.g., \"within 24 hours of becoming aware\"), sub-processor controls (notification, list maintenance, equivalent obligations), audit rights, security testing rights, data return or destruction at termination, and breach liability. The template is tailored at contract negotiation based on supplier tier - Tier 1 suppliers get the full set with negotiation room; Tier 3 may get a lighter version. Existing contracts are reviewed at renewal with security-input. Legal-IS partnership is a real working relationship, not an exception process.",
    common_pitfalls: [
      "Boilerplate clauses untailored - same incident notification timeline for a Tier 1 cloud provider and a Tier 3 office supplies SaaS",
      "Incident notification clause vague (\"as soon as reasonably practicable\") - meaningless under regulator scrutiny",
      "No audit rights - when a supplier is suspected of a breach, the org has no contractual mechanism to investigate",
      "Sub-processor clauses missing - supplier can shift work to a sub without notification",
      "Data return / destruction at termination not addressed - leaver supplier holds your data indefinitely",
      "Existing contracts grandfather in indefinitely - renewals not used as opportunity to update"
    ],
    evidence_to_look_for: [
      { item: "Contract template / security exhibit with the standard clauses", what_it_tells_you: "Whether the template exists" },
      { item: "Two sample executed contracts at different supplier tiers showing tailored clauses", what_it_tells_you: "Whether the template is applied with judgement" },
      { item: "Recent contract renewal where security clauses were updated", what_it_tells_you: "Whether renewals are used to upgrade" },
      { item: "Legal-IS interaction evidence - correspondence on a recent negotiation", what_it_tells_you: "Whether the partnership is real" }
    ],
    scoping_notes: "Existing contracts are usually grandfathered - that's pragmatic. But every renewal should be an opportunity to update. For new contracts, the security exhibit is non-negotiable for Tier 1 and Tier 2; Tier 3 may get a streamlined version. If the supplier flatly refuses to accept incident notification clauses, that's a risk decision to escalate, not to ignore.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: contracts with suppliers handling in-scope information contain security clauses addressing confidentiality, access, return/destruction on termination, incident notification, audit/assurance rights, and personnel screening where applicable. Recent contract sample shows the clauses are present and appropriate to the risk tier.",
    maturity_ladder: {
      1: "Contracts have generic confidentiality only; security clauses absent or weak",
      2: "Standard security exhibit; applied to new contracts and renewals",
      3: "Tiered application; sub-processors covered; audit rights real",
      4: "Continuous contract review; clauses updated as threat landscape changes; metrics on coverage"
    },
    related_items: ["annex-a.5.19", "annex-a.5.21", "annex-a.5.22", "annex-a.5.23"]
  },

  'annex-a.5.21': {
    purpose: "Extends supplier security thinking down the supply chain - beyond direct suppliers to sub-processors, software components, and infrastructure dependencies. SolarWinds, Log4j, MOVEit, Kaseya: every major supply-chain compromise of recent years targeted the chain rather than direct attack. A.5.21 forces the organization to think past the contract.",
    what_good_looks_like: "ICT procurement requirements include security: for every material ICT purchase (software, services, devices), there's a security review before contract signature covering vendor maturity, sub-processor model, software composition (where applicable), update / patching commitments, end-of-support timelines. Sub-processor lists are maintained for critical suppliers and reviewed when changes occur. For software, there's an expectation of SBOM (Software Bill of Materials) for critical applications - what's inside, what versions, what licences. Open-source dependencies are inventoried (typically through SCA tooling). End-of-life and unsupported components are tracked and remediated.",
    common_pitfalls: [
      "Only direct suppliers considered; sub-processors and 4th-parties not visible",
      "Software supply chain (dependencies, OSS components, container base images) entirely unaddressed",
      "SBOM concept entirely unknown to the org - couldn't list what's in their critical applications",
      "End-of-life software still in production (Windows Server 2012, unsupported framework versions) without a tracked remediation plan",
      "Procurement makes ICT purchases without security review - \"it's a small SaaS, doesn't need it\"",
      "Vendor lock-in to suppliers with poor security maturity because switching cost is high"
    ],
    evidence_to_look_for: [
      { item: "ICT procurement security requirements / checklist", what_it_tells_you: "Whether security is in the procurement gate" },
      { item: "Sample ICT procurement showing security review before contract signature", what_it_tells_you: "Whether the gate is followed" },
      { item: "Sub-processor list for one critical supplier", what_it_tells_you: "Whether the org knows the chain depth" },
      { item: "SBOM or dependency inventory for one critical application (or evidence of SCA tooling output)", what_it_tells_you: "Whether software supply chain is visible" },
      { item: "End-of-life inventory with remediation status", what_it_tells_you: "Whether unsupported components are tracked" }
    ],
    scoping_notes: "This control was de-emphasized pre-2022 and is now critical. Auditors increasingly probe it post-SolarWinds. Realistic scope: cover the top 20 suppliers by risk for sub-processor visibility, and apply SBOM / dependency tracking to critical applications and customer-facing software. Don't try to boil the ocean - but don't ignore software supply chain entirely.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: ICT supply-chain risks are identified for in-scope products/services (cloud, SaaS, managed services, hardware vendors, software libraries), with controls or compensating controls in place. Sub-supplier (4th-party) exposure is considered for critical suppliers.",
    maturity_ladder: {
      1: "Direct suppliers only; software supply chain unaddressed",
      2: "Procurement gate; sub-processors tracked for critical suppliers; basic SCA",
      3: "SBOM for critical applications; EOL inventory; supply-chain risks in risk assessment",
      4: "Continuous supply-chain risk monitoring; SBOM-driven vulnerability management; supplier-of-supplier visibility"
    },
    related_items: ["annex-a.5.19", "annex-a.5.20", "annex-a.5.22", "annex-a.5.23", "annex-a.8.30"]
  },

  'annex-a.5.22': {
    purpose: "Where A.5.19 sets up the supplier relationship and A.5.20 codifies it in contract, A.5.22 is the ongoing operational discipline - checking that the supplier is actually doing what they said, and controlling what changes when their service evolves. Without this control, the supplier relationship is a one-time gate followed by silence, and risk drifts unsupervised.",
    what_good_looks_like: "A documented supplier-review cadence calibrated to tier - Tier 1 quarterly, Tier 2 semi-annual, Tier 3 annual or trigger-based. Each review covers SLA performance, security incidents at the supplier (whether they affected the org or not), sub-processor changes, scope or service changes, audit findings (theirs and the org's), and emerging risks. Supplier-side changes (new sub-processor, change of hosting region, change of service scope) trigger a defined process - review, risk-reassess, update agreements as needed. Records of reviews are kept; actions from reviews are tracked.",
    common_pitfalls: [
      "Supplier-issued SLA reports arrive monthly and pile up unread",
      "Supplier swaps a sub-processor without notification (sometimes contractually allowed, often not) and the org finds out months later",
      "Tier-1 supplier has a public security incident and the org doesn't proactively contact them or reassess",
      "No review records - claim is \"we have regular check-ins\" but nothing documented",
      "\"We trust them\" stance for major suppliers - no operational oversight",
      "Reviews happen but only on commercial terms, not security"
    ],
    evidence_to_look_for: [
      { item: "Supplier review schedule and cadence document", what_it_tells_you: "Whether reviews are planned" },
      { item: "Sample review minutes for a Tier 1 and Tier 2 supplier from the last 12 months", what_it_tells_you: "Whether reviews actually cover security" },
      { item: "Record of a recent supplier-side change (sub-processor, scope, region) and how it was handled", what_it_tells_you: "Whether change control extends to suppliers" },
      { item: "Action register from supplier reviews with closure tracking", what_it_tells_you: "Whether reviews drive action" },
      { item: "Evidence of post-incident contact when a supplier had a public incident", what_it_tells_you: "Whether the org responds to external signals" }
    ],
    scoping_notes: "Tier-based cadence is the practical answer - quarterly across all suppliers is unrealistic at scale. The risk is in calibrating tiering correctly: if a supplier provides a service the business depends on, they're Tier 1 even if the contract is small.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented supplier-review cadence proportional to risk (annual minimum for high-risk, longer for low). Reviews cover SLA performance, security incidents, changes to the supplier's posture (SOC 2/ISO certs, breach disclosures), and contract compliance. At least one review per high-risk supplier in the last 12 months.",
    maturity_ladder: {
      1: "Reviews ad-hoc; no records",
      2: "Tier-based cadence; reviews documented; actions tracked",
      3: "Supplier changes trigger defined response; external signals (incidents, news) actively monitored",
      4: "Continuous third-party risk monitoring; supplier security posture tracked over time; predictive risk indicators"
    },
    related_items: ["annex-a.5.19", "annex-a.5.20", "annex-a.5.21", "annex-a.5.23"]
  },

  'annex-a.5.23': {
    purpose: "New in ISO 27001:2022. Calls out cloud services as a distinct supplier category requiring distinct treatment. Cloud is no longer just \"another supplier\" - the shared responsibility model, configuration responsibility, and exit complexity create risks that don't fit the generic supplier framework. The 2022 standard makes that explicit.",
    what_good_looks_like: "A documented cloud-services position covering: which cloud services are sanctioned, who owns each, the shared responsibility model per service type (IaaS / PaaS / SaaS each handled differently), security requirements at acquisition (selection criteria), configuration baseline (CIS Benchmarks or equivalent applied via IaC and CSPM), monitoring and logging coverage in cloud, and exit plan including data return / deletion. A cloud register lists every account, subscription, tenant, and project across providers. CSPM tooling is in place to detect drift from baseline. Exit is more than \"we'll figure it out\" - there's a documented sequence (data export, validation, deletion attestation).",
    common_pitfalls: [
      "Shared responsibility model not documented per service - when an incident happens, no one knows who's accountable",
      "Cloud sprawl - undocumented accounts and subscriptions accumulating across teams",
      "Default cloud configurations accepted; CIS or equivalent baseline never applied",
      "No CSPM - drift from intended config is invisible",
      "SaaS purchased on credit cards by individual teams (shadow cloud)",
      "No exit plan - vendor lock-in plus no documented sequence to extract data and verify deletion",
      "Compliance assumed because \"it's AWS\" without evidence of organization's own configuration responsibility"
    ],
    evidence_to_look_for: [
      { item: "Cloud register with accounts, subscriptions, tenants, projects across providers", what_it_tells_you: "Whether cloud footprint is visible" },
      { item: "Shared responsibility documentation per cloud service in use", what_it_tells_you: "Whether responsibility split is understood" },
      { item: "Baseline / CSPM configuration with current compliance status", what_it_tells_you: "Whether configuration is governed" },
      { item: "Sample cloud onboarding showing security review and baseline application", what_it_tells_you: "Whether onboarding is controlled" },
      { item: "Exit plan for a critical cloud service", what_it_tells_you: "Whether exit is more than aspirational" },
      { item: "Recent CSPM / configuration drift findings with remediation", what_it_tells_you: "Whether monitoring drives action" }
    ],
    scoping_notes: "IaaS, PaaS, and SaaS have very different responsibility splits and risk profiles - handle them deliberately. SaaS is often the area where cloud sprawl bites; IaaS is where misconfiguration bites; PaaS sits in between. CSPM and SSPM tools help; their absence is not automatically a finding but their presence makes evidence much easier.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented cloud-services security policy covering provider selection, configuration baselines, identity federation, data residency/sovereignty, encryption requirements, exit strategy, and ongoing monitoring. Applied to each cloud provider in scope. Configuration baselines are documented and audited.",
    maturity_ladder: {
      1: "Cloud usage informal; configuration ad-hoc",
      2: "Cloud register; shared responsibility documented; baseline applied",
      3: "CSPM/SSPM operational; exit plans documented; cloud sprawl minimised",
      4: "Cloud security posture continuously measured; multi-cloud governance; automated remediation of drift"
    },
    related_items: ["annex-a.5.19", "annex-a.5.20", "annex-a.5.21", "annex-a.5.22", "annex-a.8.9"]
  },

  'annex-a.5.24': {
    purpose: "The incident-management foundation. Forces the organization to think through incidents before one happens - plan, roles, preparedness, exercise - rather than improvising under pressure. The cost of unprepared incident response shows up most acutely in the first hour, when decisions made fast and wrong have weeks-long consequences.",
    what_good_looks_like: "A documented Incident Management Plan covering: severity classification (with concrete criteria, not just \"high / medium / low\"), roles (incident commander, technical lead, communications lead, legal liaison, executive liaison) with named primary and backup, 24/7 contact paths, escalation thresholds, decision rights (who can approve customer notification, who can approve a service shutdown), pre-defined comms templates (regulator notification, customer notification, internal). Out-of-band comms exist for when primary channels (email, Teams) are compromised - Signal group, phone tree, alternative platform. The plan is tested at least annually through a tabletop exercise; ideally a live exercise every 18-24 months. Tests produce findings that are tracked.",
    common_pitfalls: [
      "Plan exists but is theoretical - never tested under any conditions",
      "Roles defined but unclear under pressure (\"who is the incident commander when both primaries are unavailable?\")",
      "No out-of-band comms - if Teams or email is compromised, no fallback",
      "No pre-defined regulator notification templates - first attempt at GDPR notification is drafted at 02:00 during the incident",
      "Severity criteria so vague they don't drive different responses",
      "Tabletop exercises are read-throughs, not stress tests"
    ],
    evidence_to_look_for: [
      { item: "Incident Management Plan", what_it_tells_you: "Whether the plan exists and is documented" },
      { item: "Severity matrix with concrete criteria", what_it_tells_you: "Whether classification is operational" },
      { item: "Roles register with primary and backup", what_it_tells_you: "Whether the org survives a sick day" },
      { item: "Recent tabletop or live exercise report", what_it_tells_you: "Whether the plan has been tested" },
      { item: "Out-of-band comms evidence - Signal group exists, phone tree maintained, alternative platform set up", what_it_tells_you: "Whether the plan accounts for compromised primary channels" },
      { item: "Pre-defined notification templates for regulators and major customers", what_it_tells_you: "Whether the org is ready to communicate" }
    ],
    scoping_notes: "The hardest part of this control is the realistic test. A 90-minute tabletop exercise around a sanitized scenario isn't proof of preparedness; a stress-test that involves real escalation paths and real decision rights is. Aim for the latter even if the former is more comfortable.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented incident-management plan covering definitions, severity classification, roles (with backups), escalation paths, internal and external communication, evidence preservation, and post-incident review. Tested at least once in the last 12 months (tabletop is acceptable for Stage 2). At least one real or simulated incident has been run through the process end-to-end with a written debrief.",
    maturity_ladder: {
      1: "Plan drafted; not tested",
      2: "Plan with roles, severity, comms; annual tabletop",
      3: "Plan stress-tested; out-of-band comms; templates pre-positioned; lessons applied",
      4: "Continuous IR improvement; metrics on response performance; live exercises with surprise scenarios"
    },
    related_items: ["clause-7.4", "annex-a.5.5", "annex-a.5.25", "annex-a.5.26", "annex-a.5.27", "annex-a.5.30"]
  },

  'annex-a.5.25': {
    purpose: "Triage. Distinguishes events (something happened) from incidents (something happened that requires response). Without disciplined triage, two failure modes appear: alert fatigue (everything looks the same so nothing gets attention) or under-triage (real incidents get marked benign). Both are real audit findings.",
    what_good_looks_like: "Documented triage criteria - what characteristics elevate an event to incident, what severity it gets, and what response that severity triggers. The criteria are concrete: specific log signatures, asset criticality, data sensitivity, threat indicators. SOC or IR analysts have playbooks for common scenarios (suspicious authentication, malware detection, phishing report, abnormal data egress). Triage SLAs are defined and tracked. Criteria are reviewed when alert volume changes meaningfully or the threat landscape shifts.",
    common_pitfalls: [
      "Triage based on analyst judgement with no documented criteria - different analysts treat the same event differently",
      "Alert fatigue - analysts can't keep up so they batch-dismiss",
      "Missed incidents - events marked benign that turned out to matter (visible only retrospectively when something escalates)",
      "No linkage from event triage to incident response - high-severity events don't trigger the IR plan",
      "Criteria static - never updated as the org's tech stack or threat picture changes"
    ],
    evidence_to_look_for: [
      { item: "Triage criteria document", what_it_tells_you: "Whether criteria are explicit" },
      { item: "Severity matrix with what triggers what severity", what_it_tells_you: "Whether triage drives response" },
      { item: "Sample of recent triage decisions (with rationale) - pull a week of events and check the categorization", what_it_tells_you: "Whether criteria are applied consistently" },
      { item: "SLA tracking - % of events triaged within SLA over the last 90 days", what_it_tells_you: "Whether timeliness is measured" },
      { item: "Recent criteria update reflecting changed threat or tech", what_it_tells_you: "Whether criteria are alive" }
    ],
    scoping_notes: "Triage criteria don't have to be perfect - they have to be consistent and reviewable. \"Analyst judgement based on these factors\" is acceptable; \"analyst judgement\" alone is not. The factors should be enumerated in writing.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: documented triage criteria distinguishing security events from incidents, with severity tiers and playbooks for common scenarios. Triage SLAs are defined and tracked. Recent triage records show the criteria are applied consistently.",
    maturity_ladder: {
      1: "Triage by analyst judgement; no documented criteria",
      2: "Criteria documented; severity matrix; SLA tracked",
      3: "Playbooks per scenario; criteria reviewed on change; quality-checked sample of triage decisions",
      4: "Triage automation for common cases; ML-assisted prioritisation; continuous tuning of criteria"
    },
    related_items: ["annex-a.5.7", "annex-a.5.24", "annex-a.5.26", "annex-a.8.16"]
  },

  'annex-a.5.26': {
    purpose: "The active response. A.5.24 plans, A.5.25 triages; A.5.26 is what happens during the incident - containment, eradication, recovery, and the communication that runs through all three. The most common Stage 2 finding here is \"response procedure exists but the recent incident wasn't handled per the procedure.\"",
    what_good_looks_like: "A documented response procedure with defined stages - initial containment, investigation, eradication, recovery, post-incident - and clear gating between them. Playbooks for the top 5-10 incident types likely to affect the organization (BEC, ransomware, account compromise, data exfiltration, insider misuse, DDoS, supplier breach). Responders are trained on the playbooks. Coordination with regulators, affected customers, and law enforcement is defined per scenario, including who decides when to engage. Recent incidents demonstrate the procedure is followed: traceable response from detection through closure with decisions captured.",
    common_pitfalls: [
      "Ad-hoc response - every incident handled by improvisation",
      "Communication gaps - legal not looped in early, customer notification delayed past SLA",
      "No playbooks - analysts re-figure-out from scratch each time",
      "Recovery without root-cause work - system back online but the vulnerability that allowed the incident remains",
      "Decisions made under pressure without documented authority - \"can we shut down production?\" is a question with no pre-defined answer",
      "Lessons learned omitted because the response succeeded - success is the worst time to skip review"
    ],
    evidence_to_look_for: [
      { item: "Response procedure document with stages and gating", what_it_tells_you: "Whether the procedure exists" },
      { item: "Playbooks for top incident types relevant to the org", what_it_tells_you: "Whether common scenarios are pre-prepared" },
      { item: "Sample recent incident with full response trail - detection through closure", what_it_tells_you: "Whether the procedure is followed" },
      { item: "Responder training records", what_it_tells_you: "Whether responders are equipped" },
      { item: "Coordination evidence - legal involved early, regulator-notification timeline observed, customer comms sent within agreed SLA", what_it_tells_you: "Whether multi-party coordination works" }
    ],
    scoping_notes: "Playbooks are the highest-leverage investment - under pressure people rely on muscle memory, and muscle memory comes from playbooks plus practice. Don't try to write playbooks for every possible scenario; cover the top 5-10 likely types.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: incident-response procedures aligned with the plan (A.5.24) and run by trained responders. At least one incident in the last 12 months (real or exercised) has a complete response record - timeline, decisions, evidence captured, communications, closure. Post-incident review fed back into the plan.",
    maturity_ladder: {
      1: "Response ad-hoc; no procedure or playbooks",
      2: "Procedure documented; playbooks for major types; responders trained",
      3: "Recent incidents traceable through procedure; coordination evidence; metrics on response performance",
      4: "Continuous IR improvement; SOAR/automation for common patterns; mean response times tracked and improving"
    },
    related_items: ["annex-a.5.24", "annex-a.5.25", "annex-a.5.27", "annex-a.5.28"]
  },

  'annex-a.5.27': {
    purpose: "Closes the loop after every significant incident. Without structured post-incident review, organizations fix the symptom and miss the underlying issue, then repeat. With it, each incident becomes input to ISMS improvement (10.1) and to the controls that should have prevented or detected the issue earlier.",
    what_good_looks_like: "A defined post-incident review (PIR) process triggered after every significant incident - and ideally after near-misses too. Reviews are structured: incident timeline, root cause analysis (5-Whys, fishbone, Bowtie, or similar), contributing factors (technical, process, human), response effectiveness assessment, and lessons. Lessons are converted into specific actions with owners and dates. Actions are tracked through the ISMS improvement register. Pattern analysis across multiple incidents over time identifies systemic issues. The culture supports honest review - no-blame, root-cause focus.",
    common_pitfalls: [
      "PIRs only for major incidents; minor incidents and near-misses go un-reviewed and the patterns hide",
      "Lessons captured in the PIR document but never converted into trackable actions",
      "Blame culture suppresses honest review - analysts protect themselves and root cause stays superficial",
      "No pattern analysis across multiple incidents - three similar ransomware incidents over 18 months and no one noticed the trend",
      "PIRs done but lessons don't reach the controls that should have prevented the issue",
      "Same lessons appear in PIR after PIR with no evidence the prior actions closed"
    ],
    evidence_to_look_for: [
      { item: "PIR template or process document", what_it_tells_you: "Whether the structure exists" },
      { item: "Sample PIRs from the last 12 months - should show structure, root cause, lessons", what_it_tells_you: "Whether reviews happen consistently" },
      { item: "Lessons-action register with status - open lessons should be tracked through to closure", what_it_tells_you: "Whether lessons drive change" },
      { item: "Pattern analysis output - periodic look across multiple incidents", what_it_tells_you: "Whether systemic issues are caught" },
      { item: "Trace from a PIR lesson to a control change in the ISMS", what_it_tells_you: "Whether the loop closes" }
    ],
    scoping_notes: "The structure matters less than the discipline. Whether you use 5-Whys, fishbone, or another technique, what counts is that root cause is reached and lessons are converted into actions tracked to closure. Near-misses deserve PIRs too - they're the cheapest data the organization will ever get on what could have gone wrong.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented process for capturing lessons from incidents and using them to update controls, training, or detection. At least one closed incident in the last 12 months has a lesson-learned record with an action assigned and tracked to closure.",
    maturity_ladder: {
      1: "PIRs informal; lessons rarely captured",
      2: "PIRs after major incidents; lessons converted to actions; tracked",
      3: "PIRs cover near-misses; pattern analysis across incidents; no-blame culture supports honesty",
      4: "Lessons drive measurable control improvement; recurrence rates tracked; organizational learning visible over time"
    },
    related_items: ["clause-10.2", "annex-a.5.24", "annex-a.5.26"]
  },

  'annex-a.5.28': {
    purpose: "Forensic readiness. Ensures that when an incident requires evidence - for legal, regulatory, law enforcement, or internal disciplinary purposes - that evidence is collectable in a defensible way. The most common failure here is not lack of forensics capability but accidental destruction of evidence during incident response.",
    what_good_looks_like: "Documented forensic procedures for incidents likely to require evidence preservation (suspected criminal activity, regulator-notifiable breaches, insider misuse, IP theft). Chain-of-custody templates exist. Pre-positioned tooling for forensic imaging and memory capture. IR responders are trained to recognise evidence-preservation requirements early in an incident and to handle artefacts accordingly. Decisions on engaging external forensics are pre-defined (when to call in, who decides, who's the retained provider). For organizations without in-house forensics, a retainer or MoU with an external provider is established before any incident.",
    common_pitfalls: [
      "Forensic readiness not addressed at all - assumption is that external forensics will handle it if needed, with no contract in place",
      "IR team destroys evidence accidentally during response (rebuilds the compromised host before imaging it; clears logs to restart services)",
      "Chain-of-custody not maintained for collected artefacts - defensibility lost",
      "First contact with a forensic provider during a live incident - engagement takes 48 hours while the trail goes cold",
      "Cloud forensics ignored - assumption that traditional disk imaging applies, when most evidence lives in cloud APIs"
    ],
    evidence_to_look_for: [
      { item: "Forensic readiness procedure", what_it_tells_you: "Whether the org has thought through this" },
      { item: "Chain-of-custody template", what_it_tells_you: "Whether handling is defensible" },
      { item: "Tooling inventory - what's available for imaging, memory capture, log preservation", what_it_tells_you: "Whether the org is technically ready" },
      { item: "Retainer / MoU with an external forensic provider (if relying on external)", what_it_tells_you: "Whether engagement is fast" },
      { item: "Trained-responder list - who on the IR team has forensic training", what_it_tells_you: "Whether skills exist" }
    ],
    scoping_notes: "Depth scales with risk profile. A small org without in-house forensics is acceptable provided an external provider is on retainer and IR responders know when to invoke them. What's not acceptable is having nothing - no procedure, no provider, no awareness. Cloud evidence collection is its own discipline; if the org is cloud-heavy, address it explicitly.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented evidence-handling procedure for incidents that may have legal, regulatory, or disciplinary follow-through - chain of custody, hash records, restricted access, retention. Procedure is known to responders. Where invoked in the last 12 months, the procedure was followed.",
    maturity_ladder: {
      1: "Forensic readiness not addressed",
      2: "Procedure exists; external provider on retainer or in-house basics; chain-of-custody defined",
      3: "Pre-positioned tooling; trained responders; cloud forensics covered; tested in exercises",
      4: "Mature forensics function or strong external partnership; evidence-handling integrated into routine IR; defensibility tested"
    },
    related_items: ["annex-a.5.5", "annex-a.5.26", "annex-a.5.27"]
  },

  'annex-a.5.29': {
    purpose: "Ensures that when business continuity plans are invoked, information security doesn't degrade at the alternate site or during the degraded mode. The classic failure: BCP focuses on getting systems back up, and access controls / logging / segmentation at the recovery site are an afterthought.",
    what_good_looks_like: "BCP documents explicitly address security at every recovery scenario. The recovery site (or alternate processing arrangement) provides equivalent security controls - access control, logging, monitoring, segmentation, encryption - to the primary. Where degraded modes are necessary (e.g., \"during disaster, we accept reduced segmentation for X hours\"), they are documented, time-bounded, and have compensating controls. BCP exercises explicitly test security: do the access controls work at the alternate site, are the logs flowing, is the perimeter intact?",
    common_pitfalls: [
      "BCP focuses on \"get systems back online\" with security treated as recovery effort rather than recovery requirement",
      "Alternate site lacks the same security architecture as primary - inherited from a separate procurement that didn't reference security requirements",
      "Degraded modes loosen security controls without time-bound or compensating controls - \"under disaster, all VPN restrictions are lifted\"",
      "BCP test scenarios omit security entirely - recovery is declared successful when systems are reachable, regardless of whether they're securely reachable",
      "Recovery procedures bypass change control, leading to security drift between primary and recovered state"
    ],
    evidence_to_look_for: [
      { item: "BCP document showing security integration", what_it_tells_you: "Whether security is part of the plan" },
      { item: "Recovery site security architecture comparison with primary", what_it_tells_you: "Whether security parity is maintained" },
      { item: "Degraded-mode procedures with time bounds and compensating controls", what_it_tells_you: "Whether degradation is governed" },
      { item: "BCP test report covering security-specific tests (access controls, logging, monitoring at alt-site)", what_it_tells_you: "Whether security is tested under recovery conditions" }
    ],
    scoping_notes: "Recovery doesn't mean reduced security. If the architecture or budget genuinely can't support equivalent controls at the recovery site, document the gap, the time-bound under which it's accepted, and the compensating controls. Don't pretend parity exists when it doesn't.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: information-security continuity is addressed within the wider business-continuity programme, not as a separate stream. RTOs/RPOs are defined for in-scope services. At least one continuity test (tabletop or live) in the last 12 months covered a security-relevant scenario. Recovery procedures include the security controls that protect the recovered state.",
    maturity_ladder: {
      1: "BCP doesn't address security",
      2: "Security integrated into BCP; recovery-site parity claimed",
      3: "Recovery site tested for security parity; degraded modes documented and time-bounded",
      4: "Recovery security continuously validated; metrics on security-during-recovery; security-aware BCP exercises"
    },
    related_items: ["annex-a.5.30", "annex-a.5.24", "clause-8.1"]
  },

  'annex-a.5.30': {
    purpose: "New in 2022. Calls out ICT continuity as a specific control distinct from generic business continuity. Where A.5.29 ensures security during disruption, A.5.30 ensures the ICT systems themselves can withstand and recover from disruption - backup, redundancy, failover, restore - to the targets the business needs.",
    what_good_looks_like: "ICT continuity requirements derived from a Business Impact Analysis: per critical service, an RTO (how long it can be down) and RPO (how much data loss is acceptable). Architecture supports those targets - high availability where RTO is low, redundancy where availability matters, failover capability where geographic concentration is a risk. Plans for failover, restoration, and degraded operation are documented. Tests happen at planned intervals: failover drills (real or simulated), restore-from-backup tests (actual restore, not just confirmation that backups complete), regional failover for critical workloads. Test records are kept. Cloud and SaaS continuity assumptions are explicitly tested rather than trusted.",
    common_pitfalls: [
      "RTO and RPO theoretical - declared values that the architecture couldn't actually deliver",
      "Backups complete successfully but restore is never actually tested",
      "Failover drills are tabletop only; real failover under production load has never been performed",
      "Cloud / SaaS continuity assumed because \"it's the cloud\" - no test of region failover, vendor outage, or data export",
      "Continuity scope incomplete - covers servers and networks but not endpoints, identity systems, key SaaS",
      "Tests pass but findings aren't acted on (e.g., restore took 3x the RTO and the gap goes unaddressed)"
    ],
    evidence_to_look_for: [
      { item: "BIA outputs with RTO and RPO per critical service", what_it_tells_you: "Whether continuity targets are derived from business need" },
      { item: "Architecture documentation showing how RTO/RPO are met (HA, replication, backup strategy)", what_it_tells_you: "Whether the architecture supports the targets" },
      { item: "Recent failover test report", what_it_tells_you: "Whether failover actually works" },
      { item: "Recent restore-from-backup test - real data restored, not just backup-completion confirmation", what_it_tells_you: "Whether backups are usable" },
      { item: "Cloud / SaaS continuity test evidence - region failover, vendor outage simulation, data export validation", what_it_tells_you: "Whether cloud assumptions hold" }
    ],
    scoping_notes: "RTO/RPO without architecture to back them is fiction. Honest target-setting may mean accepting higher RTO/RPO than business preference because the architecture and budget can't justify lower. Document the business-accepted targets and design to them; don't pretend.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: ICT readiness for business continuity is documented and tested - the technical capabilities (backup restoration, failover, alternate-site capacity, recovery procedures) required to meet the RTOs/RPOs from A.5.29 actually work. At least one technical recovery test in the last 12 months with a documented outcome.",
    maturity_ladder: {
      1: "Backups happen; restore untested; RTO/RPO informal",
      2: "RTO/RPO documented per service; failover and restore tested annually",
      3: "Tests cover real conditions (production-like load, cloud-region failover); test findings drive architecture changes",
      4: "Continuous resilience testing (chaos engineering or equivalent); RTO/RPO measured against actual incidents and adjusted"
    },
    related_items: ["annex-a.5.29", "annex-a.8.13", "annex-a.8.14"]
  },

  'annex-a.5.31': {
    purpose: "The legal-and-regulatory register. Identifies the laws, regulations, and contractual obligations that bind the organization with information-security implications, and assigns owners. Without this control, the organization can't credibly claim it knows what it's required to do - and that gap shows up immediately under a regulator inquiry or breach investigation.",
    what_good_looks_like: "A maintained register listing every applicable law, regulation, and material contractual obligation with security implications: data protection per relevant jurisdiction (GDPR, UK GDPR, DPDP, CCPA, sector-specific privacy), sector-specific (DORA, NIS2, PCI DSS, HIPAA, SOX where applicable), employment law with security touchpoints, IP law, export control where relevant. Each entry has an owner (typically legal partnered with the relevant business function), a brief summary of obligations, and a reference to where in the ISMS the obligation is addressed. Reviewed periodically and on regulatory change - horizon-scanning is operational, not aspirational. New regulations (DORA, NIS2, AI Act, EU Data Act) have been triaged and added where applicable.",
    common_pitfalls: [
      "Register stale - major regs (DORA, NIS2) not reflected even after their applicability is settled",
      "Only data protection considered, ignoring sector-specific obligations",
      "No owner per requirement, or owner is \"Compliance\" with no specific named accountability",
      "No horizon-scanning process - register only updates after the fact",
      "Contractual obligations not in the register at all - only law and regulation tracked",
      "Listed but not addressed - the register notes \"GDPR Art. 32\" but the SoA doesn't reflect the technical and organizational measures it requires"
    ],
    evidence_to_look_for: [
      { item: "Legal / regulatory / contractual register", what_it_tells_you: "Whether the determination is documented" },
      { item: "Sample requirement showing owner and how it's addressed in the ISMS", what_it_tells_you: "Whether requirements are operationalised" },
      { item: "Horizon-scanning evidence - recent regulatory updates triaged and added or rejected", what_it_tells_you: "Whether the register is alive" },
      { item: "MR review of regulatory changes in the last 12 months", what_it_tells_you: "Whether changes reach governance" },
      { item: "Contractual security obligations extracted from key customer agreements and tracked", what_it_tells_you: "Whether contractual obligations are tracked" }
    ],
    scoping_notes: "Legal usually owns the register; security consumes it for ISMS implications. The boundary between legal-as-owner and security-as-consumer should be explicit, not negotiated incident by incident. Many organizations find a quarterly legal-IS sync is the practical mechanism.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a register of legal, statutory, regulatory, and contractual requirements applicable to the organisation, with owners and how each requirement is met. Updated when material change occurs (new law, new contract). Legal or compliance has signed off on the register's accuracy.",
    maturity_ladder: {
      1: "Informal awareness; no register",
      2: "Register exists; owners assigned; reviewed annually",
      3: "Horizon scanning operational; register integrated with ISMS controls and risk; updated on triggers",
      4: "Continuous regulatory intelligence; obligations mapped to controls; compliance evidence linked to obligations"
    },
    related_items: ["clause-4.2", "annex-a.5.5", "annex-a.5.34", "annex-a.5.32"]
  },

  'annex-a.5.32': {
    purpose: "Covers the organization's IPR obligations on two sides: respecting other people's IP (software licensing, copyrighted material, patents), and protecting its own IP (source code, designs, trade secrets). Software licensing is the most-sampled aspect - auditors check whether installed software matches purchased licences.",
    what_good_looks_like: "A software asset register tied to licences with current compliance status. For organizations using OSS (i.e., almost all of them), Software Composition Analysis tooling identifies dependencies and their licences, with attention to copyleft licences (GPL, AGPL) that may impose obligations on derivative work. User education on IPR - what they can and can't install, what they can and can't reuse from internet sources, what they can and can't take when they leave. Technical controls for software installation (managed endpoints, allowlisting, restricted admin rights). For organizations that create IP, source-code access controls (A.8.4), trade-secret handling (A.5.12 + A.5.14), and IPR clauses in employment and contractor agreements (A.6.2).",
    common_pitfalls: [
      "Software piracy through unmanaged installs - users installing licenced software they don't have a seat for, or installing GPL software in a commercial product",
      "OSS licence compliance ignored - copyleft obligations not tracked, leading to breach when product is shipped",
      "Contractor-produced IP ownership unclear - no work-for-hire clause, contractor retains rights",
      "No user education on IPR - staff routinely paste internet content into customer deliverables",
      "Source-code access not controlled - departing developers walk away with the codebase",
      "No software licence audit - actual usage exceeds purchased licences"
    ],
    evidence_to_look_for: [
      { item: "Software asset register with licence status", what_it_tells_you: "Whether licensing is tracked" },
      { item: "OSS / Software Composition Analysis output for material applications, with licence breakdown", what_it_tells_you: "Whether OSS obligations are visible" },
      { item: "User training on IPR and acceptable use of third-party content", what_it_tells_you: "Whether the org has educated its people" },
      { item: "IPR clauses in employment and contractor agreements", what_it_tells_you: "Whether IP ownership is contractually clear" },
      { item: "Technical controls preventing unauthorised software installation", what_it_tells_you: "Whether the org backs its policy with technical enforcement" }
    ],
    scoping_notes: "OSS licence compliance is the modern lever here. Most organizations carry hundreds of OSS dependencies; without SCA tooling and a defined licence-allowlist, they have no idea whether they're compliant. Auditors increasingly probe this for organizations that produce or distribute software.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: intellectual property rights (third-party software licences, open-source compliance, copyrighted materials, trade secrets) are inventoried, with controls preventing infringement (licence tracking, OSS scanning, NDAs, watermarking where relevant). At least one recent licence review.",
    maturity_ladder: {
      1: "Software licences tracked informally; OSS unaddressed; IPR education ad-hoc",
      2: "Asset register; OSS scanning; user education; IPR clauses in contracts",
      3: "Licence audits regular; OSS-licence policy enforced in CI; IP creation governed end-to-end",
      4: "Automated licence compliance; OSS posture continuously monitored; IPR risks proactively managed"
    },
    related_items: ["annex-a.5.10", "annex-a.5.31", "annex-a.8.4", "annex-a.8.19"]
  },

  'annex-a.5.33': {
    purpose: "Defines retention, integrity, and disposal of records - both records of operations (logs, transactions) and records that the ISMS itself produces (audits, reviews, NCs). Records that should exist but don't are unprovable claims; records kept indefinitely without justification are storage cost and liability.",
    what_good_looks_like: "A retention schedule listing record types (financial, audit, security, customer, employee, legal-hold) with retention periods derived from legal, regulatory, and contractual requirements. Integrity controls: write-once-read-many storage where required, cryptographic hashing for tamper-evidence, access controls aligned with classification, distinct from operational storage where regulator pressure justifies. Defensible disposal at end of retention - documented, approved, executed, recorded. A legal-hold mechanism overrides retention when litigation, investigation, or regulatory inquiry is anticipated, without manual error. Backups and cloud storage are within scope of retention thinking, not exempt.",
    common_pitfalls: [
      "Retention schedule absent or generic (\"keep records 7 years\")",
      "Indefinite retention to be \"safe\" - accumulates liability and breaches regulatory minimum-required-deletion in some regimes",
      "No integrity controls on records that need them - audit logs writable by admins",
      "Disposal not documented - claim is \"we delete after retention\" with no records of disposal",
      "Legal-hold not implemented - records get deleted on schedule even when litigation should freeze them",
      "Backups and cloud storage exempted from retention thinking - records survive in backup long after the primary copy was destroyed"
    ],
    evidence_to_look_for: [
      { item: "Retention schedule mapping record types to retention periods and legal/regulatory basis", what_it_tells_you: "Whether retention is derived from requirements" },
      { item: "Storage architecture showing integrity controls for records requiring them (immutability, WORM, hashing)", what_it_tells_you: "Whether integrity is technically enforced" },
      { item: "Sample disposal record - what was disposed, by whom, when, with what verification", what_it_tells_you: "Whether disposal is defensible" },
      { item: "Legal-hold process and at least one example of it being applied", what_it_tells_you: "Whether the override mechanism works" },
      { item: "Coverage of backups in retention treatment", what_it_tells_you: "Whether the long-tail is governed" }
    ],
    scoping_notes: "Retention is one of the few areas where \"keep less\" is genuinely better - both for storage cost and regulator risk. Organizations regulated under GDPR have an active deletion obligation, not just a retention right. Don't conflate them.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: records (logs, evidence, regulatory submissions, contracts, audit trails) are identified, classified, retained for the required period, and protected from loss or falsification. Retention schedule exists and is followed. Records can be retrieved on request.",
    maturity_ladder: {
      1: "Retention informal; storage indefinite",
      2: "Schedule documented; major record types covered; disposal happens",
      3: "Integrity controls; legal-hold operational; disposal defensible; backup coverage",
      4: "Automated retention enforcement; continuous compliance with deletion obligations; metrics on records-overdue-disposal"
    },
    related_items: ["annex-a.5.12", "annex-a.5.31", "annex-a.5.34"]
  },

  'annex-a.5.34': {
    purpose: "The privacy umbrella. Identifies applicable privacy obligations and ensures the organization implements appropriate technical and organizational measures (TOMs). Privacy and information security overlap heavily but aren't identical - privacy adds purpose limitation, lawful basis, data subject rights, and territoriality questions that pure security doesn't.",
    what_good_looks_like: "Privacy obligations identified per jurisdiction the organization touches (GDPR / UK GDPR / DPDP / CCPA / sector-specific). A current Record of Processing Activities (ROPA, GDPR Art. 30) describing each processing activity, lawful basis, data categories, recipients, retention, transfers. A maintained privacy notice. A PII inventory (overlapping with A.5.9 but with privacy-specific attributes). Data Subject Request processes are tested - actual response within statutory timelines (one month for GDPR, with exceptions). DPIAs are conducted for high-risk processing; templates exist and are used. A DPO is appointed where required. Breach notification process aligned with regulatory timelines (GDPR 72h to regulator, undue delay to affected individuals).",
    common_pitfalls: [
      "GDPR-only thinking when the org operates multi-jurisdictionally - DPDP, CCPA, sector-specific obligations get missed",
      "ROPA created at certification and never updated - new processing activities don't enter it",
      "DSR processes manual and untested - first real access request takes 28 days because the org has to invent the process",
      "No DPIA template or process - high-risk processing rolls out without privacy review",
      "PII inventory absent - \"we have personal data somewhere\" is the org's best answer",
      "Breach notification timeline misjudged - 72-hour clock missed because triage took 96 hours"
    ],
    evidence_to_look_for: [
      { item: "Record of Processing Activities (ROPA) covering current activities", what_it_tells_you: "Whether processing is mapped" },
      { item: "Current privacy notice", what_it_tells_you: "Whether external disclosure is current" },
      { item: "DPIA template and a sample completed DPIA from the last 12 months", what_it_tells_you: "Whether high-risk processing is reviewed" },
      { item: "DSR fulfilment record - actual request handled within timeline", what_it_tells_you: "Whether subject rights work in practice" },
      { item: "PII inventory with location, processing purpose, retention", what_it_tells_you: "Whether the org knows where its PII is" },
      { item: "Breach notification playbook with 72-hour timeline operationalised", what_it_tells_you: "Whether the regulator clock is understood" },
      { item: "DPO appointment record (where applicable) and DPO-to-management reporting line", what_it_tells_you: "Whether privacy has executive standing" }
    ],
    scoping_notes: "Privacy obligations are jurisdiction-specific - what's required differs materially across GDPR, DPDP, CCPA, LGPD, sector-specific. Multi-jurisdiction organizations need a matrix, not a single global approach. The DPO requirement is conditional in GDPR (public authority, large-scale monitoring, large-scale special category) - verify whether the org is in scope before claiming a DPO is or isn't needed.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: privacy and protection of PII is covered through a privacy policy/notice, lawful-basis records (GDPR Art. 30 / equivalent), DPIA process for high-risk processing, data-subject-rights procedure, and breach-notification procedure aligned with applicable law (GDPR Art. 33, DPDP, etc.). Recent DPIA or data-subject-rights record exists.",
    maturity_ladder: {
      1: "Privacy partly addressed; ROPA absent or outdated",
      2: "ROPA, privacy notice, DPIA template, DSR process all in place",
      3: "Multi-jurisdiction obligations mapped; DSR tested; breach timeline operational; DPIA done for major projects",
      4: "Privacy by design embedded in product / process; continuous PII inventory; DSR automation; privacy metrics tracked"
    },
    related_items: ["annex-a.5.12", "annex-a.5.31", "annex-a.5.33", "annex-a.8.10", "annex-a.8.11"]
  },

  'annex-a.5.35': {
    purpose: "Requires reviews of information security by parties independent of the area being reviewed - to surface blind spots, validate self-assessment, and provide assurance to top management and external stakeholders. Distinct from internal audit (clause 9.2) in scope and breadth: 9.2 audits the ISMS as a whole; A.5.35 is broader, covering specific information security practice areas and may include external reviewers.",
    what_good_looks_like: "An independent-review programme covering the ISMS over a multi-year cycle (typically 3 years). Reviews are mixed - internal audit (9.2 fulfilment), external assessment (e.g., consultancy review of cryptography or cloud architecture), regulator inspection where applicable, customer audit where contracted, certification surveillance audit. Reviewers are independent of the area reviewed (a sysadmin doesn't review their own work; the IT team doesn't audit IT). Outputs feed management review (9.3), the improvement register (10.1), and the risk picture. Findings are tracked through the ISMS improvement / NC processes.",
    common_pitfalls: [
      "Scope incomplete - only the technical controls reviewed; governance and risk-management practice never independently checked",
      "Reviewer independence violated - \"independent\" reviewer is from the same team or reports to the same manager as the area reviewed",
      "Outputs not actioned - reviews produce reports that get filed and never trigger change",
      "Internal-only - never any external review, so blind spots never get surfaced",
      "Reviews driven by certification cycle alone - no internal scheduling beyond what the certification body requires"
    ],
    evidence_to_look_for: [
      { item: "Independent-review programme covering a multi-year cycle", what_it_tells_you: "Whether reviews are planned across scope" },
      { item: "Sample review report (internal or external) from the last 18 months", what_it_tells_you: "Whether reviews actually happen and produce useful output" },
      { item: "Reviewer-independence record for at least one recent review", what_it_tells_you: "Whether independence requirement is taken seriously" },
      { item: "Action register tracking review findings to closure", what_it_tells_you: "Whether reviews drive change" },
      { item: "Mix of internal and external reviews over the cycle", what_it_tells_you: "Whether the org gets outside perspective" }
    ],
    scoping_notes: "Internal reviewers are acceptable, but they need genuine independence from what they're reviewing. Outsourcing the review is more visibly independent and brings outside perspective; cost trade-off is real. A pragmatic mix: internal audit covers ISMS; external review covers specialised areas (cryptography, cloud security architecture, secure development) where outside expertise adds value.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: an independent review of information security is performed at planned intervals - internal audit (clause 9.2) suffices if independence is real. Sampling covers policies, controls, and operations. Findings tracked to closure.",
    maturity_ladder: {
      1: "Reviews limited to certification-driven; gaps in scope",
      2: "Programme exists; mix of internal and external; findings tracked",
      3: "Coverage across ISMS over multi-year cycle; reviewers verifiably independent; findings drive change",
      4: "Continuous independent review through ongoing assurance partners; reviews timed to risk and change events; effectiveness of review programme itself reviewed"
    },
    related_items: ["clause-9.2", "annex-a.5.36"]
  },

  'annex-a.5.36': {
    purpose: "Periodic compliance review against policies, rules, and standards - narrower and more frequent than internal audit. The check that what's documented is what's happening, run often enough to catch drift. Where 9.2 internal audit is the deep periodic review, A.5.36 is the routine compliance pulse-check that surfaces issues before the next audit cycle.",
    what_good_looks_like: "Documented compliance review activity calibrated to risk and control type. For low-risk policy areas: annual self-assessment or attestation by control owner. For high-risk technical controls: technical compliance check via tooling - config baseline scans (CIS Benchmarks via CSPM, hardening scans via Qualys / Tenable, code-quality scans via SAST). Reviews produce findings; findings convert to NCs (10.2) and remediation actions. Review approach is scaled - not every control gets the same depth, and the basis for that scaling is documented.",
    common_pitfalls: [
      "Only self-attestation for everything - no technical compliance check even where tooling is available and cheap",
      "Reviews don't drive remediation - findings logged but no closure tracking",
      "Same depth applied to all controls - over-engineered for low-risk, under-engineered for high-risk",
      "Confused with internal audit and either skipped (\"audit covers it\") or duplicated (running both reviews on the same scope)",
      "Tooling deployed (CSPM, SAST) but findings reviewed once and then ignored at scale"
    ],
    evidence_to_look_for: [
      { item: "Compliance review schedule with cadence per control area", what_it_tells_you: "Whether reviews are planned" },
      { item: "Sample technical compliance scan output (CSPM, hardening, SAST) with review evidence", what_it_tells_you: "Whether technical compliance is checked, not just attested" },
      { item: "Self-assessment forms or attestations from control owners", what_it_tells_you: "Whether self-assessment is structured" },
      { item: "Non-compliance register with closure status", what_it_tells_you: "Whether findings drive action" },
      { item: "Differentiation showing risk-based review depth", what_it_tells_you: "Whether effort is calibrated" }
    ],
    scoping_notes: "Position A.5.36 as the routine pulse-check between internal audits. Tooling is the practical way to scale: CSPM for cloud, SAST/DAST for code, configuration scanning for endpoints and servers. Without tooling, A.5.36 collapses into self-attestation, which is weak evidence.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: regular compliance reviews confirm policies, procedures, and technical controls are being followed in practice. Sample reviews cover at least the high-leverage controls (access, change, incident, supplier). Findings closed in the last 12 months.",
    maturity_ladder: {
      1: "Self-attestation only; no technical compliance check",
      2: "Schedule with self-assessment + targeted technical scans",
      3: "Risk-based depth; tooling integrated; findings drive remediation",
      4: "Continuous compliance monitoring; deviations alerted in real time; metrics on time-to-remediate"
    },
    related_items: ["annex-a.5.35", "clause-9.1", "clause-9.2"]
  },

  'annex-a.5.37': {
    purpose: "The standard operating procedures (SOPs) that operate the ISMS day-to-day - backup procedures, patching procedures, access provisioning, monitoring response, change deployment, incident response runbooks. Without documented procedures, operations rely on tribal knowledge that walks out the door when key people leave.",
    what_good_looks_like: "An SOP register listing every routine and security-relevant procedure with owner, version, review cycle. Procedures themselves are concrete and actionable - a new operator could follow them. Kept current - typically annual review minimum, plus on material change. Easy to find - a centralized location operators actually use, not buried in a SharePoint nobody opens. Tied to training (A.6.3, clause 7.2): operators are trained on the SOPs they're expected to follow. Sample evidence shows operations actually following the SOP - backup logs cite the SOP, change records reference the change-deployment SOP.",
    common_pitfalls: [
      "SOPs out of date - referencing systems or tools no longer in use",
      "Not findable when needed - operators ask each other rather than consult the SOP",
      "Tribal knowledge over written SOP - \"Bob knows how\" is the actual process",
      "SOPs exist but not followed - operations diverge from the documented procedure with no review",
      "SOP register absent - no one knows the canonical list of procedures",
      "SOPs too abstract to follow (\"perform backup according to policy\") - not procedures, just policy restated"
    ],
    evidence_to_look_for: [
      { item: "SOP register with owners and review dates", what_it_tells_you: "Whether the catalog exists" },
      { item: "Three sample SOPs pulled at random - backup, patching, access provisioning", what_it_tells_you: "Whether procedures are concrete and current" },
      { item: "Recent SOP review record showing material updates", what_it_tells_you: "Whether SOPs are alive" },
      { item: "Operation log referencing the SOP - e.g., a recent backup record citing the SOP version", what_it_tells_you: "Whether SOPs are followed in practice" },
      { item: "Operator training records linked to SOPs", what_it_tells_you: "Whether operators know what to follow" }
    ],
    scoping_notes: "Operational SOPs and ISMS SOPs both fall under this control. Don't try to document everything - focus on routine operations and security-relevant tasks. A useful test: if this person was hit by a bus, would the operation continue? If not, that's where SOP investment pays off.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: operating procedures exist for the security-relevant tasks staff perform (joiner/mover/leaver, backup, patching, incident response at minimum), with named owners and review dates. Procedures are accessible to the staff who execute them and have been updated in the last 24 months.",
    maturity_ladder: {
      1: "SOPs partial; tribal knowledge dominant",
      2: "SOP register; major procedures documented; annual review",
      3: "SOPs concrete; followed in practice; training tied; reviewed on change",
      4: "SOPs version-controlled with change tracking; operators contribute updates; effectiveness measured"
    },
    related_items: ["clause-7.5", "annex-a.5.4", "clause-7.2"]
  },

  // ===================================================================
  // ANNEX A.6 - PEOPLE CONTROLS
  // ===================================================================

  'annex-a.6.1': {
    purpose: "Background screening before access. The first line of defence against insider threat is selection - knowing who you're handing the keys to before you hand them over. The control is risk-proportionate: a finance contractor handling payments needs more than a graduate intern shadowing a developer.",
    what_good_looks_like: "Documented screening requirements per role sensitivity tier. A general role might require employment verification, identity verification, and basic criminal background; a sensitive role (privileged access, finance, regulated function) adds enhanced criminal check, credit history (where lawful and relevant), professional reference verification, and qualification verification. Screening is conducted before access is granted - not post-hire \"as soon as possible.\" Equivalent screening expectations apply to contractors and third-party personnel under organizational control. For sensitive roles, screening is refreshed periodically (typically every 3-5 years). All within applicable employment law - screening must be lawful, proportionate, and consented.",
    common_pitfalls: [
      "Only employees screened; contractors and consultants get desk and access on day one with no checks",
      "Same screening for all roles - graduate hire and DBA get identical background check",
      "Screening completed but access granted before it concludes - \"we'll catch up later\"",
      "Sensitive-role screening never refreshed - someone screened 15 years ago is still in a privileged role",
      "Records poor - claim is \"we screen everyone\" with patchy evidence",
      "Screening compliance with employment law (e.g., GDPR Art. 10 for criminal data) not thought through"
    ],
    evidence_to_look_for: [
      { item: "Screening policy with tier definitions and per-tier requirements", what_it_tells_you: "Whether screening is risk-tiered" },
      { item: "Screening records sample - three recent hires across different tiers showing the appropriate checks", what_it_tells_you: "Whether the policy is applied" },
      { item: "Contractor screening evidence equivalent to employee screening for similar role sensitivity", what_it_tells_you: "Whether scope is correctly broad" },
      { item: "Pre-access verification - screening completed before access granted", what_it_tells_you: "Whether the timing is right" },
      { item: "Re-screening evidence for sensitive roles", what_it_tells_you: "Whether refresh happens" }
    ],
    scoping_notes: "Screening must comply with employment law in the jurisdictions where hiring happens - GDPR Art. 10 in EU/UK constrains criminal data, US states differ on credit checks, India and other jurisdictions have specific requirements. A multi-jurisdiction org needs a per-jurisdiction approach, not a global \"screen everyone the same way.\"",
    minimum_certifiable: "Smallest version that will still pass Stage 2: pre-employment screening proportional to role risk - at minimum identity verification, right-to-work, reference checks for all hires; criminal-record and credit checks for higher-risk roles where lawful. Screening completed before access is granted. Records retained in line with privacy law.",
    maturity_ladder: {
      1: "Screening informal or partial; gaps for contractors",
      2: "Tiered policy; pre-access screening; contractor coverage",
      3: "Re-screening for sensitive roles; jurisdictional compliance; integration with HR",
      4: "Continuous monitoring for sensitive roles (where lawful); risk-adjusted screening based on role evolution"
    },
    related_items: ["annex-a.6.2", "annex-a.5.19"]
  },

  'annex-a.6.2': {
    purpose: "Embeds information security responsibilities into the employment relationship - into the contract itself, the offer letter, the joiner pack. Without these clauses, security obligations are policy expectations the employee can claim ignorance of; with them, they're contractual obligations.",
    what_good_looks_like: "Employment agreements include explicit information security clauses: confidentiality obligations (during and post-employment), responsibility to follow ISMS policies, IPR ownership (work-for-hire), handling of confidential information, return of organizational assets at termination, post-termination restrictions where lawful and necessary, disciplinary consequences for security violations. Equivalent clauses appear in contractor agreements - sometimes stronger because the relationship is shorter and the post-engagement risk is higher. Agreements are signed before access is granted. Clauses are reviewed periodically - particularly when employment law or ISMS policy changes.",
    common_pitfalls: [
      "Only confidentiality clause; broader security responsibilities not addressed",
      "Post-termination obligations not explicit - confidentiality stops at termination, IPR claims become disputed",
      "Contractor agreements weaker than employment agreements despite often higher risk profile",
      "Agreements signed after access already granted - \"we'll get the paperwork sorted\"",
      "Contracts not refreshed when policy materially changes - staff bound to a 2018 ISMS that no longer exists"
    ],
    evidence_to_look_for: [
      { item: "Employment contract template with the security clauses visible", what_it_tells_you: "Whether security is contractually embedded" },
      { item: "Contractor agreement template", what_it_tells_you: "Whether contractor coverage is equivalent" },
      { item: "Sample executed employment and contractor agreement", what_it_tells_you: "Whether the templates are actually applied" },
      { item: "Pre-access verification - agreement signed before access granted, with evidence of the order of events", what_it_tells_you: "Whether the timing is right" }
    ],
    scoping_notes: "Existing employment contracts often pre-date the current ISMS. Practical answer: when policy materially changes, issue an addendum or include the new obligations in awareness training with attestation. Don't try to re-paper every employment contract; do for material changes.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: employment contracts (and contractor agreements) include information-security responsibilities and confidentiality obligations that survive termination. Sampled contracts show the clauses are present. Updates to obligations on role change are reflected in writing.",
    maturity_ladder: {
      1: "Generic confidentiality only",
      2: "Standard security clauses in employment and contractor agreements",
      3: "Pre-access signing; post-termination obligations; addenda on material change",
      4: "Continuous coverage of policy changes via attestation; legal-IS partnership on contract evolution"
    },
    related_items: ["annex-a.6.1", "annex-a.5.10", "annex-a.6.5", "annex-a.6.6"]
  },

  'annex-a.6.3': {
    purpose: "Operationalises clause 7.3 (awareness) at scale and depth - covering all staff and contractors with the right content at the right cadence. This is the control auditors test most heavily for breadth: pick five employees at random, can they show recent training completion?",
    what_good_looks_like: "A documented awareness, education, and training programme covering: induction at hire (before or within first week of access), annual refresher minimum, role-relevant tailoring (developers get secure coding awareness, finance gets BEC and payment fraud awareness, executives get exec-targeted threats including deepfake and CEO fraud, customer-facing staff get social engineering), policy-change updates when material policies change, emerging-risk modules as new threats become relevant. Completion is tracked through an LMS. Effectiveness is measured through phishing simulation rates, knowledge assessments, awareness surveys. Contractors are in scope. Programme content is reviewed annually for relevance.",
    common_pitfalls: [
      "Tick-box training - annual 30-minute click-through that nobody remembers",
      "No role tailoring - developers, finance, executives all receive the same general awareness",
      "Same content year over year - stale to the point staff skip through it",
      "No effectiveness measurement - completion tracked, but whether training changed behavior is unmeasured",
      "Contractors excluded - \"they're not staff\" excuse, despite contractor often having same access",
      "Phishing simulation only, no other content - phishing tests aren't an awareness programme",
      "Training delivered but no attestation records reaching the auditor"
    ],
    evidence_to_look_for: [
      { item: "Programme document covering content, cadence, audience tailoring, measurement", what_it_tells_you: "Whether the programme is structured" },
      { item: "LMS completion records - % completion across staff and contractors over the last 12 months", what_it_tells_you: "Coverage and completion" },
      { item: "Sample role-tailored content - developer secure coding, finance BEC, exec fraud", what_it_tells_you: "Whether tailoring is real" },
      { item: "Effectiveness metrics - phishing-fail rates over time, knowledge-survey scores", what_it_tells_you: "Whether the programme works" },
      { item: "Contractor coverage evidence", what_it_tells_you: "Whether scope is correct" },
      { item: "Recent content update reflecting an emerging threat", what_it_tells_you: "Whether content is current" }
    ],
    scoping_notes: "The shift from \"awareness training\" to \"continuous awareness\" is the modern direction - micro-learning, just-in-time prompts, simulation-driven, gamification. The annual 30-minute click-through is increasingly seen as floor, not ceiling. Auditors at Stage 2 increasingly want to see effectiveness, not just completion.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: security awareness covering all staff at onboarding and at least annually thereafter, with role-specific top-up for higher-risk roles (developers, admins, finance/payments). At least one phishing simulation or equivalent practical test in the past 12 months. ~95% completion across in-scope staff and contractors, with non-completion tracked to closure.",
    maturity_ladder: {
      1: "Annual generic training; no measurement",
      2: "Tailored programme; tracked completion; phishing simulation",
      3: "Effectiveness measured; content refreshed; contractor coverage; emerging threats addressed",
      4: "Continuous awareness; behavioral metrics; training drives measurable behavior change"
    },
    related_items: ["clause-7.3", "clause-7.2", "annex-a.6.4"]
  },

  'annex-a.6.4': {
    purpose: "The disciplinary backstop. Without consequences for security violations, awareness and policy are aspirational - staff learn quickly that violation has no cost. This control requires a defined, communicated, fairly-applied disciplinary process for security violations.",
    what_good_looks_like: "A documented disciplinary process for security violations, integrated with the broader HR disciplinary framework but with security-specific triggers (e.g., AUP breach, deliberate policy violation, negligence causing incident, repeated minor violations). Severity scaling - minor violation gets verbal warning and re-training; serious violation gets formal warning; severe violation (deliberate harm, repeated serious) gets termination plus referral to law enforcement where applicable. Communicated - staff know the process exists and what triggers it. Applied consistently and proportionately - same violation by junior and senior staff results in proportionate response, not selective enforcement. Recent applications evidence the process works.",
    common_pitfalls: [
      "No security-specific disciplinary process - generic HR process applied case-by-case with no security-specific triggers",
      "Fear of using it - process exists but never applied even when warranted, eroding deterrent",
      "Applied inconsistently - \"depends on who's involved\"; senior staff escape consequences junior staff face",
      "Not communicated - staff don't know the disciplinary consequences and the deterrent effect is lost",
      "Disconnect between awareness training (which mentions consequences) and reality (where consequences don't materialize)",
      "Records inadequate - auditor asks for evidence of recent applications and there's nothing to show"
    ],
    evidence_to_look_for: [
      { item: "Disciplinary process document with security-specific triggers and scaling", what_it_tells_you: "Whether the process exists" },
      { item: "Communication evidence - staff briefed on the process; included in awareness training", what_it_tells_you: "Whether deterrence is real" },
      { item: "Sample applications from the last 12-24 months (anonymised if needed) showing the process in action", what_it_tells_you: "Whether the process has teeth" },
      { item: "Consistency check - same violation, different staff levels, proportionate response", what_it_tells_you: "Whether application is fair" }
    ],
    scoping_notes: "Disciplinary processes are HR territory but security needs to partner. The trigger conditions, severity scaling, and what constitutes a security violation are decisions security needs to drive. Cultural sensitivity matters - in some jurisdictions and industries, formal discipline is uncommon and the process needs to align with local practice while still having consequences.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented disciplinary process applicable to security violations, communicated to staff, with examples of consequences proportional to severity. At least one recent violation (where one occurred) has been handled through the process. The process is fairly and consistently applied.",
    maturity_ladder: {
      1: "No security-specific process; ad-hoc",
      2: "Process documented; communicated; occasional application",
      3: "Consistent application; integrated with awareness; deterrent effect measurable",
      4: "Process refined based on data; near-real-time response; cultural shift evidenced"
    },
    related_items: ["annex-a.6.2", "annex-a.5.10", "annex-a.6.3"]
  },

  'annex-a.6.5': {
    purpose: "Closes the security loop on people leaving or changing role, on the obligations side rather than the asset-recovery side (A.5.11). Confidentiality, IPR ownership, and other security obligations don't end at termination - A.6.5 makes those ongoing obligations explicit, communicated, and remembered.",
    what_good_looks_like: "Post-termination obligations are written into the employment contract or a separate end-of-employment document - confidentiality (with explicit duration where lawful), IPR ownership for work created during employment, return of all organizational information including from personal devices, restrictions on use of know-how (within legal limits), continuing notification obligations if the leaver becomes aware of confidentiality breaches. At exit, these obligations are reinforced - typically through an exit interview that includes a security checklist and a signed acknowledgement that the leaver understands what they continue to owe. For role changes (movers), security obligations are similarly reset - the new role's responsibilities start, the old role's privileged knowledge handling continues.",
    common_pitfalls: [
      "Post-termination obligations not in the contract - confidentiality stops at the termination date by default",
      "Contract has the obligations but exit doesn't reinforce them - leaver doesn't realise they still apply",
      "No exit interview covering security topics - only HR and benefits get covered",
      "Obligations vague - \"keep confidential\" without duration or scope",
      "Contractor agreements weaker than employee agreements despite often higher risk profile (ex-contractors take know-how to competitors)",
      "Movers process missing - privileged-role knowledge from a prior position never gets a security treatment when the person changes role"
    ],
    evidence_to_look_for: [
      { item: "Contract template or exit pack with post-termination security obligations", what_it_tells_you: "Whether obligations are documented" },
      { item: "Exit interview checklist showing security topics covered", what_it_tells_you: "Whether obligations are reinforced at exit" },
      { item: "Sample exit acknowledgement signed by a recent leaver", what_it_tells_you: "Whether reinforcement is operational" },
      { item: "Movers process - sample where role-change resulted in formal security touchpoints", what_it_tells_you: "Whether internal moves are covered" }
    ],
    scoping_notes: "Post-termination restrictions (non-compete, non-solicit) vary enormously by jurisdiction in lawfulness and enforceability. Don't write contract clauses that won't hold up in court. Confidentiality obligations are nearly universal, IPR ownership is usually clear with work-for-hire language, broader restrictions need legal review per jurisdiction.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a leaver/role-change process covering revocation of access, return of assets, restatement of post-employment obligations (confidentiality, IP), and reminder of any continuing responsibilities. Sampled leavers in the last 12 months show the process was followed.",
    maturity_ladder: {
      1: "Obligations not addressed post-termination",
      2: "Contract clauses; exit interview includes security",
      3: "Movers process; signed acknowledgements; cross-jurisdictional handling",
      4: "Post-termination compliance monitoring (where lawful); obligations refreshed at material policy change"
    },
    related_items: ["annex-a.5.11", "annex-a.5.18", "annex-a.6.2", "annex-a.6.6"]
  },

  'annex-a.6.6': {
    purpose: "The NDA / confidentiality agreement specifically - distinct from broader employment terms (A.6.2). NDAs are deployed across many relationships beyond employment: contractors, suppliers, prospective customers, M&A counter-parties, professional services. Without a maintained NDA program, confidential information leaks through the gap between the people who have access and the contractual obligations on them.",
    what_good_looks_like: "An NDA template (or a small set of templates for different relationship types - mutual, one-way, supplier-specific, M&A) maintained by legal in partnership with information security. Aligned with the classification scheme (A.5.12) - NDAs cover what counts as confidential, with examples. Signed before access to confidential information, not after. Cover the post-termination or post-relationship period explicitly with duration. Reviewed periodically for legal and operational relevance. Tracked - a register of NDAs in force with parties, scope, and expiry where applicable.",
    common_pitfalls: [
      "NDA template stale - copied from a 2010 boilerplate, missing modern data-handling terms",
      "Signed after access already granted - \"we'll get the NDA done this week\" while the contractor is already in the building",
      "Post-termination period not addressed - NDA expires at end of relationship by default",
      "Same NDA for all relationships regardless of risk - startup-style mutual NDA used for a Tier 1 supplier with deep access",
      "No register - \"we definitely have NDAs with everyone\" with no list to confirm",
      "Confidential information not defined or scoped - just \"all information shared\" which is unenforceable in some jurisdictions"
    ],
    evidence_to_look_for: [
      { item: "NDA template(s) with version block, last review date, owner", what_it_tells_you: "Whether the template is maintained" },
      { item: "Sample executed NDAs across different relationship types", what_it_tells_you: "Whether tailoring is real" },
      { item: "NDA register listing in-force agreements", what_it_tells_you: "Whether the org tracks its agreements" },
      { item: "Pre-access verification - NDA signed before confidential information shared", what_it_tells_you: "Whether timing is right" }
    ],
    scoping_notes: "NDA enforceability varies by jurisdiction. Some jurisdictions limit duration of confidentiality obligations; some require specificity of what's confidential; some restrict post-employment scope. Multi-jurisdiction organizations need legal review of NDA templates per jurisdiction.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: confidentiality/non-disclosure agreements with employees, contractors, and third parties handling in-scope information. Reviewed at planned intervals or on material change. Sampled NDAs include the appropriate scope, duration, and post-termination obligations.",
    maturity_ladder: {
      1: "Single boilerplate NDA; ad-hoc execution",
      2: "Template set; pre-access execution; register",
      3: "Tiered templates; periodic review; jurisdictional handling; tracking",
      4: "Continuous NDA management; effectiveness measured (incidents traceable to NDA gaps); proactive review"
    },
    related_items: ["annex-a.5.10", "annex-a.5.14", "annex-a.5.20", "annex-a.6.2"]
  },

  'annex-a.6.7': {
    purpose: "Remote working - no longer the exception, but still a control area where many organizations apply pre-pandemic thinking. Rules and technical measures for work outside the controlled office environment, where physical security, network security, and observation risks all change.",
    what_good_looks_like: "A remote-work policy reflecting the organization's actual remote-work patterns - not a 2018 policy assuming office-default. Rules cover: locations allowed (country list aligned with data residency and tax considerations, public-WiFi rules, restrictions on highly sensitive work in public spaces), device requirements (managed endpoints with MDM and EDR, encryption, screen lock), home network expectations (router default password changed, separate guest network for personal devices, no organizational data on personal cloud), physical environment (no shoulder surfing, lock screen when away, secure storage for printouts), data-handling rules (no organizational data on personal devices unless explicitly approved). Technical controls: VPN or ZTNA for access, MFA enforced, MDM for endpoints, conditional access. BYOD addressed explicitly if allowed - typically with a containerised approach. Training tailored to remote-work risks.",
    common_pitfalls: [
      "Policy reflects an office-default world; real workforce is 80% remote and policy hasn't caught up",
      "BYOD ambiguous - neither prohibited nor governed",
      "Home office security ignored - \"work from home\" without any guidance on home network or environment",
      "Coffee-shop and public-WiFi work happens routinely without rules or technical mitigations",
      "Country-list issues: staff working from countries with data-residency constraints or sanctions",
      "MDM deployed for company-issued devices but not for BYOD that holds organizational data"
    ],
    evidence_to_look_for: [
      { item: "Remote-work policy reflecting actual work patterns", what_it_tells_you: "Whether the rules are realistic" },
      { item: "Technical controls - MDM coverage, VPN/ZTNA configuration, MFA enforcement", what_it_tells_you: "Whether enforcement is real" },
      { item: "BYOD position - explicit approach, whether prohibited or containerised", what_it_tells_you: "Whether BYOD is governed" },
      { item: "Country/location restrictions and how they're monitored", what_it_tells_you: "Whether territoriality is handled" },
      { item: "Remote-work training material", what_it_tells_you: "Whether staff are equipped" }
    ],
    scoping_notes: "Remote-work risk is highly contextual - a fully office-based organization has different exposure than a remote-first one. The control needs to address the organization's actual model, not a generic remote-work template. \"Work from anywhere\" without geographic constraints creates tax, employment law, and data residency issues that go beyond information security but should still be considered.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented remote-working policy covering eligible roles, equipment (corporate vs. BYOD), connectivity (VPN/ZTNA, MFA), physical environment expectations, data-handling rules, and incident reporting. Acknowledged by remote workers. Endpoints meet the policy's technical controls (encryption, EDR, patching).",
    maturity_ladder: {
      1: "Policy generic or outdated; technical controls partial",
      2: "Policy reflects current model; MDM/VPN/MFA on managed devices; rules communicated",
      3: "BYOD addressed; country list governed; training tailored; physical environment guidance",
      4: "Continuous remote-work risk monitoring; conditional access driven by risk signals; behavioural metrics"
    },
    related_items: ["annex-a.5.10", "annex-a.7.9", "annex-a.8.1", "annex-a.8.5"]
  },

  'annex-a.6.8': {
    purpose: "The reporting channel for security events - the mechanism by which the next breach gets caught early because someone speaks up. Without a clear, trusted, easy-to-use channel, events go unreported until they become incidents and incidents until they become disasters. This is one of the highest-leverage controls in the entire ISMS.",
    what_good_looks_like: "Multiple clear channels for reporting: a single dedicated email (security@), a phishing-report button in email clients, a ticketing form, a hotline for after-hours, anonymous reporting where culturally appropriate. The channels are communicated repeatedly through awareness, displayed in physical and digital spaces (intranet, posters, induction). Reports are acknowledged within a defined timeline (typically same business day for non-anonymous), triaged through the security event management process (A.5.25), and the reporter is informed of the outcome where appropriate. A non-retaliation principle is explicit and enforced - staff who report in good faith are protected, including for false alarms. Reporting volume is itself a metric - too low suggests channel isn't trusted; appropriate volume suggests health.",
    common_pitfalls: [
      "No clear channel - staff guess between IT helpdesk, manager, security inbox; reports get lost",
      "Multiple channels with no coordination - report goes to one, doesn't reach security",
      "Fear of reporting - blame culture means staff hide events that might reflect on them",
      "No phishing-report button - staff have to forward emails as attachments, which is friction-ful",
      "Reports submitted but never acknowledged - staff stop bothering",
      "Reporting volume implausibly low (e.g., 3 reports a year for a 500-person org) - strong signal channel isn't trusted",
      "Reports from contractors and third parties not considered"
    ],
    evidence_to_look_for: [
      { item: "Reporting channel(s) documented with how they connect to event management", what_it_tells_you: "Whether the channels exist and connect" },
      { item: "Communication evidence - channels visible in awareness, on intranet, in induction", what_it_tells_you: "Whether staff know" },
      { item: "Sample reports from the last 90 days with acknowledgement timestamps and triage outcomes", what_it_tells_you: "Whether the channel works" },
      { item: "Reporting volume metric - reports per month or quarter", what_it_tells_you: "Whether the channel is trusted" },
      { item: "Non-retaliation policy and evidence it's been applied (or at least communicated)", what_it_tells_you: "Whether psychological safety supports reporting" },
      { item: "Phishing-report mechanism in email client (Outlook button, Gmail equivalent)", what_it_tells_you: "Whether the friction is minimised" }
    ],
    scoping_notes: "Reporting volume is a useful health metric. A 500-person organization should see double-digit reports per month from awareness-trained staff who have a phishing-report button. Implausibly low volume is a stronger signal of trust failure than implausibly high volume - staff feeling safe to report is the precondition for everything else in incident response.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a channel for reporting security events (and concerns) is documented, well-known to staff, and reachable 24/7 or escalated when out of hours. Confidential and anonymous options exist. Reports in the last 12 months have been logged and triaged.",
    maturity_ladder: {
      1: "Reporting informal; staff unclear where to go",
      2: "Channels documented; communicated; reports acknowledged",
      3: "Multi-channel; phishing-report button; non-retaliation enforced; metrics tracked",
      4: "Active culture of reporting; near-real-time acknowledgement; reports drive security improvements; continuous channel improvement"
    },
    related_items: ["annex-a.5.24", "annex-a.5.25", "annex-a.5.26", "clause-7.4"]
  },

  // ===================================================================
  // ANNEX A.7 - PHYSICAL CONTROLS
  // ===================================================================

  'annex-a.7.1': {
    purpose: "The outermost layer of physical security. Defines the perimeters around what the organization needs to protect physically - data centres, server rooms, sensitive offices, R&D labs - and ensures those perimeters are real, maintained, and proportionate to the risk inside.",
    what_good_looks_like: "Perimeters are defined for areas that warrant them - not every office has a perimeter, but data centres, server rooms, R&D labs, and executive offices typically do. Physical controls (walls, doors, locks, fences, glass-break sensors) are appropriate to what's behind them - a data centre's perimeter is qualitatively different from a marketing department's. Perimeter integrity is inspected on a regular cycle (monthly walk-through, quarterly formal inspection); weak points are identified and remediated. Shared building or multi-tenant scenarios are handled deliberately - what does it mean that other tenants share the building's lifts, lobbies, and HVAC?",
    common_pitfalls: [
      "Shared-building vulnerabilities ignored - other tenants' staff can access shared lifts that reach the org's floor",
      "Tailgating accepted as cultural norm - \"we don't want to seem rude\"",
      "Perimeter degradation - fire doors propped open for ventilation; door closers fail and aren't replaced",
      "No inspection regime - perimeter quality drifts undetected",
      "Visitor management at perimeter is weak - first sign-in is at reception inside the perimeter, not at the perimeter itself",
      "Same level of perimeter for general office and sensitive areas - over-investment one place, under-investment another"
    ],
    evidence_to_look_for: [
      { item: "Perimeter map showing protected areas and their boundaries", what_it_tells_you: "Whether perimeters are defined" },
      { item: "Inspection records - recent walk-throughs and formal inspections", what_it_tells_you: "Whether perimeter integrity is maintained" },
      { item: "Risk-tiered perimeter design - different controls for different sensitivity areas", what_it_tells_you: "Whether the org calibrates investment" },
      { item: "Shared-building risk treatment - how the org handles multi-tenant exposures", what_it_tells_you: "Whether contextual risks are addressed" }
    ],
    scoping_notes: "Most modern organizations have less physical perimeter to worry about than 10 years ago - fewer on-premises data centres, more cloud, more remote work. But where perimeters do matter (data centres, sensitive labs, secure rooms, vault-style records storage), they matter a lot. Scope this control to the actual physical estate; don't write generic perimeter language for an organization with no physical estate of consequence.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: physical security perimeters are defined for sites/areas in scope (offices, data centres, equipment rooms). Where the organisation has no physical premises in scope (full remote, cloud-hosted), the SoA records the applicability decision and references the dependent supplier controls (data-centre certifications). Sampled perimeter shows the controls operate as documented.",
    maturity_ladder: {
      1: "Perimeters informal; degradation undetected",
      2: "Perimeters defined; inspected; controls proportionate",
      3: "Risk-tiered design; shared-building risks addressed; integrated with monitoring (A.7.4)",
      4: "Perimeter posture continuously monitored; physical security metrics; design reviewed against evolving risk"
    },
    related_items: ["annex-a.7.2", "annex-a.7.3", "annex-a.7.4", "annex-a.7.5"]
  },

  'annex-a.7.2': {
    purpose: "Entry control - who gets through the perimeter, how, and how the organization knows. Distinct from access control to information (A.5.15-18) which is logical; this is about physical entry to spaces.",
    what_good_looks_like: "Badge or key-card access for staff with role-appropriate levels - general office, sensitive areas, secure areas. Visitor management is structured: pre-registration where possible, sign-in with photo ID verification, badging visibly different from staff badging, escort policy for sensitive areas, sign-out tracked. Visitor logs maintained with arrival and departure times, and reviewed periodically (typically monthly) for anomalies. Tailgating is addressed - through tailgate-detection turnstiles where the risk justifies, or through cultural reinforcement and signage where it doesn't. Contractors with extended on-site access have time-bounded credentials, not permanent badges.",
    common_pitfalls: [
      "Visitor logs maintained sporadically - not all visitors actually sign in",
      "Tailgating accepted - staff hold doors open for unbadged people \"because they look fine\"",
      "Contractors issued permanent badges that outlast their engagement",
      "\"Everyone who needs it\" access to sensitive areas - no segmentation between general and sensitive",
      "Visitor logs maintained but never reviewed - anomalies invisible",
      "After-hours access granted to many but reviewed for none"
    ],
    evidence_to_look_for: [
      { item: "Badge access matrix showing role-based access to areas", what_it_tells_you: "Whether physical access is tiered" },
      { item: "Visitor management process and recent logs", what_it_tells_you: "Whether visitors are tracked" },
      { item: "Sample visitor sign-in covering pre-registration, ID verification, badge issued, escort, sign-out", what_it_tells_you: "Whether the process is followed" },
      { item: "Contractor credential lifecycle - time-bounded, expiry tracked", what_it_tells_you: "Whether contractor access has end-dates" },
      { item: "Anomaly review of access logs - periodic review with findings", what_it_tells_you: "Whether logs are used" }
    ],
    scoping_notes: "The visitor process is the most-sampled element here. Auditors physically sign in and observe how the process works. If they walk past reception without challenge, that's a finding. If they sign in but no one verifies the photo ID, that's a finding. The process is what gets tested.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: physical entry controls to secure areas use authentication appropriate to risk (badge, biometric, PIN+badge). Access lists are maintained and reviewed; visitor management is documented; tailgating is addressed. For cloud-only / no-premises orgs, the SoA records the applicability decision with reference to the supplier.",
    maturity_ladder: {
      1: "Entry informal; visitor logs partial",
      2: "Badge access; structured visitor process; logs maintained",
      3: "Tiered access; tailgating addressed; logs reviewed; contractor lifecycle managed",
      4: "Real-time anomaly detection on entry; visitor self-service kiosks with backend verification; metrics tracked"
    },
    related_items: ["annex-a.7.1", "annex-a.7.3", "annex-a.7.4", "annex-a.7.6"]
  },

  'annex-a.7.3': {
    purpose: "Room-level protection. Where A.7.1 is the building perimeter and A.7.2 is the entry, A.7.3 is the security of specific offices, rooms, and facilities - particularly those holding sensitive information or supporting equipment (server rooms, comms closets, data archives, executive offices, HR records).",
    what_good_looks_like: "Server rooms and data closets are locked with controlled access - typically a separate ACL from general office access. Sensitive areas (HR, Finance, Legal, R&D) are restricted to function staff with controlled exception process. Rooms with sensitive information have privacy considerations addressed - lock when unattended, no whiteboards visible through windows, no over-the-shoulder visibility from public spaces. Environmental marking is considered - sensitive areas are not advertised by signage (\"Financial Records Room\" is a navigation aid for an attacker). Cleaning and maintenance access is governed - escorted into sensitive areas, not given free run after-hours.",
    common_pitfalls: [
      "Server room key in an unlocked desk drawer or under a doormat",
      "Sensitive areas unmarked AND poorly controlled - relying on obscurity that doesn't survive a determined adversary",
      "Sensitive areas marked AND poorly controlled - \"Financial Records\" sign on a door with a £20 lock",
      "Whiteboards with sensitive information visible through windows or via online meeting backgrounds",
      "Cleaning crew has after-hours access to all areas including server rooms",
      "Executive offices have sensitive printouts left out on desks at end of day"
    ],
    evidence_to_look_for: [
      { item: "Sensitive-area inventory and access controls per area", what_it_tells_you: "Whether room-level protection is differentiated" },
      { item: "Server room access logs", what_it_tells_you: "Whether physical access to critical infrastructure is controlled and tracked" },
      { item: "Cleaning and maintenance escort/access policy", what_it_tells_you: "Whether after-hours access is governed" },
      { item: "Walk-through evidence - randomly inspect sensitive rooms for clear-desk compliance, visible whiteboards, locked-when-unattended", what_it_tells_you: "Whether practice matches policy" }
    ],
    scoping_notes: "Privacy-of-information controls are increasingly important in open-plan and hot-desking environments - even \"general office\" space may need privacy controls if sensitive work happens there. Online-meeting backgrounds have created a new attack surface; whiteboards visible behind staff on video calls have leaked sensitive info publicly.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: offices, rooms, and facilities are protected proportional to the sensitivity of what they contain - server rooms locked, executive offices secured, secure-area access restricted. For cloud-only / no-premises orgs, the SoA records the applicability decision.",
    maturity_ladder: {
      1: "Room-level controls informal",
      2: "Server room and sensitive areas locked; access controlled",
      3: "Cleaning/maintenance governed; privacy considerations addressed; walk-through inspection regime",
      4: "Continuous monitoring of room-level compliance; environmental controls integrated"
    },
    related_items: ["annex-a.7.1", "annex-a.7.2", "annex-a.7.4", "annex-a.7.7"]
  },

  'annex-a.7.4': {
    purpose: "Physical security monitoring - CCTV, alarms, guards, badge logs. The detection layer of physical security: when something does breach a perimeter or attempt unauthorized entry, the organization knows about it and can respond. Monitoring is what turns physical controls from preventive-only into preventive-plus-detective.",
    what_good_looks_like: "Monitoring is proportionate to facility risk. Data centres get the full set: CCTV at perimeter and inside, alarms on doors, badge-log analysis. Sensitive areas get CCTV and badge logs. General office may have CCTV at entry only. Retention for monitoring data is defined and aligned with use - typically 30-90 days for general CCTV, longer for incident-relevant footage. Alerts (door alarms, after-hours badge use, tailgating detection) are triaged and integrated with the IR process - a SOC sees physical alerts alongside digital. Blind spots are identified and either remediated or documented as accepted risk. Privacy obligations on monitoring (GDPR Art. 6, Art. 13, employee monitoring laws) are addressed.",
    common_pitfalls: [
      "CCTV deployed but recordings retained for 7 days when investigations typically need 30+",
      "Alarms not monitored - \"the system rings, no one is on the other end\"",
      "Badge logs collected but never analysed - anomalies invisible",
      "Blind spots known but not remediated; not even documented as accepted",
      "Recordings inaccessible when needed - no clear retrieval process; first request after an incident takes days",
      "Privacy obligations on monitoring not addressed - staff monitored without lawful basis or notice"
    ],
    evidence_to_look_for: [
      { item: "Monitoring inventory - CCTV cameras, alarms, badge readers, with location and coverage", what_it_tells_you: "Whether the monitoring estate is documented" },
      { item: "Retention configuration aligned with use", what_it_tells_you: "Whether retention supports investigations" },
      { item: "Alert triage evidence - recent alerts with disposition", what_it_tells_you: "Whether alerts drive response" },
      { item: "Sample retrieval - recent footage retrieval request handled within reasonable timeline", what_it_tells_you: "Whether monitoring is operationally accessible" },
      { item: "Privacy notice / lawful basis for monitoring", what_it_tells_you: "Whether monitoring is lawful" }
    ],
    scoping_notes: "Physical security monitoring increasingly integrates with digital security operations - modern SOCs see physical alerts (after-hours data-centre access) alongside digital ones (anomalous logins). That integration is best-practice but not mandated. What is essential: monitoring without analysis is theatre, and analysis without retention is forgetfulness.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: physical monitoring (CCTV, alarms, guards, motion sensors) is applied to secure areas proportional to risk, with retention and review aligned to incident-response needs. For cloud-only / no-premises orgs, the SoA records the applicability decision.",
    maturity_ladder: {
      1: "Monitoring partial; analysis ad-hoc",
      2: "Coverage proportionate to risk; retention aligned with use; alerts triaged",
      3: "Integrated with IR/SOC; blind spots managed; privacy compliance",
      4: "Continuous monitoring with anomaly detection; physical-digital correlation; metrics tracked"
    },
    related_items: ["annex-a.7.1", "annex-a.7.2", "annex-a.7.3", "annex-a.5.24"]
  },

  'annex-a.7.5': {
    purpose: "Physical and environmental threats - fire, flood, power loss, climate events, civil unrest. This control forces the organization to identify what could physically destroy or impair its facilities and to put protective and detective controls in place proportionate to the risk.",
    what_good_looks_like: "A physical and environmental risk assessment per location identifies the threats that matter - fire is everywhere; flood is location-dependent; earthquake, wildfire, hurricane, civil unrest are jurisdiction-dependent. Protective controls are deployed proportionately: fire suppression in server rooms (typically gas-based to avoid water damage), leak detection where water risk is real, UPS and generator for power resilience, climate control for equipment areas. Detective controls (smoke alarms, water sensors, environmental monitoring) feed alerts. Critical equipment locations are evaluated against threats - putting the only data centre in a flood plain is a finding, putting it on the ground floor of a flood plain is a more serious finding. Insurance is considered as residual-risk treatment but not as substitute for controls.",
    common_pitfalls: [
      "No risk assessment per location - same controls applied regardless of geography",
      "Suppression deployed but never tested - gas system that hasn't been activated in 7 years has no proof it works",
      "Environmental sensors absent in critical areas (server room without smoke detector, water sensor, or temperature monitoring)",
      "Flood / earthquake / wildfire risk ignored where applicable - facility built before risk was known and never reassessed",
      "UPS in place but capacity inadequate for actual load; or generator never tested under real load",
      "Civil-unrest scenarios ignored - pandemic, riots, regional conflict left out of physical risk picture"
    ],
    evidence_to_look_for: [
      { item: "Per-location physical and environmental risk assessment", what_it_tells_you: "Whether threats are identified contextually" },
      { item: "Protective control inventory - suppression, leak detection, UPS, climate control", what_it_tells_you: "Whether protective controls match risks" },
      { item: "Detective control inventory - sensors and their integration with alerting", what_it_tells_you: "Whether detection works" },
      { item: "Test records - recent suppression test, generator load test, sensor verification", what_it_tells_you: "Whether protective controls actually work" },
      { item: "Risk acceptance for residual physical risks - explicit acceptance of insurance-only treatment", what_it_tells_you: "Whether residual risks are formally accepted" }
    ],
    scoping_notes: "Climate change is increasingly relevant - locations historically not at flood or wildfire risk increasingly are. Amendment 1:2024 to ISO 27001 makes climate consideration explicit (mostly via clause 4.1, but with operational implications here). Cloud and outsourcing reduce direct physical exposure but transfer it to the supplier - A.5.21 picks that up.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: protection against physical and environmental threats (fire, flood, power loss, earthquake, civil unrest) is covered through site selection, environmental controls (fire suppression, UPS, HVAC), and continuity provisions. For cloud-only / no-premises orgs, the SoA records the applicability decision.",
    maturity_ladder: {
      1: "Physical/environmental risks informal",
      2: "Per-location assessment; protective and detective controls; basic testing",
      3: "Threat-specific designs; integrated alerting; tested under realistic conditions",
      4: "Continuous environmental monitoring; threat scenarios drive control evolution; climate-change adaptation"
    },
    related_items: ["annex-a.5.30", "annex-a.7.1", "annex-a.7.11"]
  },

  'annex-a.7.6': {
    purpose: "Specific rules for working in secure areas - beyond general office, where additional discipline is required because of what's in the area. Server rooms, secure-research labs, classified-data rooms, vault-style records storage. Without explicit rules, secure areas are governed by inference and improvisation, both of which fail under pressure.",
    what_good_looks_like: "Documented rules for each category of secure area: who can enter (named individuals or roles), escort policy for non-staff (always escorted, by whom), devices allowed (no personal phones, no cameras, no recording devices), observation and photography restrictions, working-hours limits, log requirements (entry/exit recorded, periodically reviewed), clean-area protocols (clear desk leaving the area, no taking material out without authorisation). Rules are communicated to all who use the area and posted at entry. Logs are maintained and reviewed periodically. Visitor escort is enforced - including for cleaning, maintenance, audit visits.",
    common_pitfalls: [
      "No rules documented - secure areas governed by tradition",
      "Escort policy exists on paper but not enforced - visitors find their way around alone",
      "Personal devices allowed in areas where they shouldn't be - phones with cameras in secure labs, recording devices in classified-data rooms",
      "Sensitive areas accessible to anyone with general office access - no segmentation",
      "Logs maintained but not reviewed - entries that shouldn't be there go unnoticed",
      "Working-hours limits not enforced - after-hours access uncontrolled in areas where it should be flagged",
      "Cleaning and maintenance unescorted in secure areas"
    ],
    evidence_to_look_for: [
      { item: "Rules document(s) for each secure area category", what_it_tells_you: "Whether rules are explicit" },
      { item: "Communication evidence - staff working in the area know the rules", what_it_tells_you: "Whether rules are operationalised" },
      { item: "Entry/exit logs for a sensitive area", what_it_tells_you: "Whether tracking happens" },
      { item: "Periodic log review evidence", what_it_tells_you: "Whether logs are used" },
      { item: "Visitor and contractor escort records for the area", what_it_tells_you: "Whether escort is enforced" }
    ],
    scoping_notes: "Not every organization has secure areas in the strict sense - a typical mid-size SaaS company may have only a server-room equivalent or none if fully cloud-hosted. Scope this control to the actual secure areas the org has; don't manufacture them. Where the org genuinely has none, document the determination explicitly rather than leaving the control unaddressed.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a working-in-secure-areas procedure covers authorisation, supervision of visitors/contractors, photography/recording restrictions, and notification on exit. For cloud-only / no-premises orgs, the SoA records the applicability decision.",
    maturity_ladder: {
      1: "Rules informal; escort patchy",
      2: "Rules documented; logs maintained; escort enforced",
      3: "Periodic log review; device controls (personal device prohibition where warranted); after-hours governance",
      4: "Real-time monitoring of secure-area access; behavioural anomaly detection; rules continuously refined"
    },
    related_items: ["annex-a.7.1", "annex-a.7.2", "annex-a.7.3", "annex-a.7.4"]
  },

  'annex-a.7.7': {
    purpose: "Clear desk, clear screen - the daily discipline that keeps sensitive information from being visible to passersby, cleaners, visitors, and overnight intruders. The control is small in scope but high in audit visibility because the auditor literally walks around at lunchtime and sees what's on desks and screens.",
    what_good_looks_like: "A documented clear-desk and clear-screen policy stating that sensitive information is not left visible when desks are unattended, that screens auto-lock after a defined timeout (typically 5-15 minutes), and that printouts containing sensitive information are removed from printers promptly and stored in locked containers when not in immediate use. Auto-lock is technically enforced via group policy or MDM - not relying on user discipline. Lockable storage (drawers, cabinets) is provided where staff handle sensitive material. End-of-day sweeps or periodic walk-throughs check compliance. Hot-desking and shared-workspace areas have specific rules accommodating the model.",
    common_pitfalls: [
      "Enforcement absent - policy exists, but a Tuesday-lunchtime walk-around finds dozens of unlocked screens and sensitive printouts",
      "Hot-desking breaks the model because no one owns end-of-day cleanup of a shared desk",
      "Auto-lock timeout disabled or extended by users (\"it's annoying\") with IT not enforcing",
      "Printers in shared areas accumulate uncollected printouts; sensitive material left for hours",
      "Sticky notes with passwords on monitors - a classic finding that still appears regularly",
      "Whiteboards with sensitive notes left up for days, visible through office windows or in video-call backgrounds"
    ],
    evidence_to_look_for: [
      { item: "Clear-desk / clear-screen policy", what_it_tells_you: "Whether the rules are documented" },
      { item: "Group policy / MDM evidence enforcing auto-lock timeout", what_it_tells_you: "Whether technical enforcement backs the policy" },
      { item: "Walk-through inspection records - periodic checks with findings and follow-up", what_it_tells_you: "Whether compliance is verified" },
      { item: "Lockable storage availability - drawers/cabinets provided where needed", what_it_tells_you: "Whether the org enables compliance" },
      { item: "Hot-desking rules where applicable", what_it_tells_you: "Whether modern work patterns are addressed" }
    ],
    scoping_notes: "Auditors test this empirically - they walk through office areas at typical break times and observe. \"We have a policy\" is not the test; \"the desks are clear\" is. Periodic internal walk-throughs catch issues before the auditor does.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a clear-desk and clear-screen policy is documented, communicated, and reasonably enforced - screen locking on idle, papers and portable media locked when unattended. Sampled walk-through (or remote-equivalent reminder cadence) shows the policy works.",
    maturity_ladder: {
      1: "Policy exists; enforcement informal",
      2: "Policy + auto-lock enforcement; lockable storage available",
      3: "Walk-through inspections; hot-desking rules; printer-area discipline",
      4: "Continuous compliance monitoring; metrics on observed violations; cultural reinforcement"
    },
    related_items: ["annex-a.5.10", "annex-a.7.3", "annex-a.7.6", "annex-a.8.1"]
  },

  'annex-a.7.8': {
    purpose: "Site equipment so it reduces - rather than amplifies - environmental and unauthorised-access risk. Servers near windows on the ground floor, laptops left visible in parked cars, sensitive equipment in rooms with overhead pipes: each is a preventable risk created by where the kit sits.",
    what_good_looks_like: "Equipment placement decisions take security and environment into account at the time of deployment, not as an afterthought. Servers and network equipment are sited in restricted rooms with appropriate environmental controls (cooling, no overhead water, away from heat sources). Public-facing reception or meeting-room equipment is sited so screens aren't visible to outsiders. Cabling is protected (A.7.12 territory but linked here) - cable trays, conduits, no exposed runs in public spaces. Equipment in less-secure environments (public-facing kiosks, retail-floor terminals) has additional anti-tampering or physical-attachment controls.",
    common_pitfalls: [
      "Servers in unsuitable rooms - over-the-radiator-in-a-broom-closet syndrome",
      "Laptops left visible in cars during off-site work, leading to break-in theft",
      "Cabling exposed in public corridors or unsecured risers",
      "Equipment near windows or water sources without justification",
      "Reception or shared-area equipment displays sensitive information on its screen",
      "Sensitive equipment moved without environmental review - moves create new exposures"
    ],
    evidence_to_look_for: [
      { item: "Equipment siting policy or design guidance", what_it_tells_you: "Whether siting decisions are governed" },
      { item: "Walk-through evidence of representative equipment placements with siting rationale", what_it_tells_you: "Whether siting is deliberate" },
      { item: "Off-premises equipment guidance - vehicle, hotel, café usage rules", what_it_tells_you: "Whether off-site siting risks are managed" },
      { item: "Move/change procedure including environmental and security review", what_it_tells_you: "Whether moves don't introduce new risks" }
    ],
    scoping_notes: "This control overlaps with A.7.5 (environmental threats), A.7.9 (off-premises), A.7.12 (cabling). The narrow scope of A.7.8 is the placement decision itself - where physical assets are positioned. Modern cloud-heavy organizations have less on-premises equipment to site, which simplifies the control but doesn't eliminate it (offices still have endpoints, network gear, peripherals).",
    minimum_certifiable: "Smallest version that will still pass Stage 2: equipment siting and protection is considered for in-scope sites - environmental risk, theft risk, side-channel risk. For cloud-only / no-premises orgs, the SoA records the applicability decision with reference to the cloud provider's controls.",
    maturity_ladder: {
      1: "Siting decisions ad-hoc; evident exposures",
      2: "Siting guidance documented; representative placements reviewed",
      3: "Moves trigger security review; off-premises siting governed; environmental considerations explicit",
      4: "Continuous physical-asset visibility; siting decisions integrated with risk and environmental data"
    },
    related_items: ["annex-a.7.5", "annex-a.7.9", "annex-a.7.12"]
  },

  'annex-a.7.9': {
    purpose: "Equipment outside the controlled office environment - laptops on planes, phones in hotels, USB drives in pockets, devices at home offices. Off-premises equipment is where the most everyday physical-security exposure lives, and where incidents (loss, theft, opportunistic compromise) are most common.",
    what_good_looks_like: "Documented rules for off-premises equipment use - what is allowed, what is required, what is prohibited. Technical protections: full-disk encryption mandatory, MDM enrolment, EDR active, remote-wipe capability tested, tracking enabled where lawful. Physical-security guidance for staff: don't leave laptops visible in cars, use cable locks in hotels, screen-privacy filters in transit, no unattended use in public spaces. Loss and theft reporting process is clear and used - staff know to report immediately, response includes remote-wipe and credential rotation. Asset tracking is current - when a device is reported lost, the org knows what was on it and what to act on.",
    common_pitfalls: [
      "No rules for off-site equipment - assumption is that managed = governed",
      "Encryption optional or not verified; lost laptop turns into a potential breach",
      "Remote-wipe capability untested; first attempt during an actual loss fails",
      "Loss / theft not consistently reported; staff embarrassed or delayed",
      "Asset tracking incomplete - when a device is lost, the org can't tell what was on it",
      "Insurance considerations conflated with security controls - \"it's insured\" doesn't mean the data is safe"
    ],
    evidence_to_look_for: [
      { item: "Off-premises equipment policy", what_it_tells_you: "Whether rules exist" },
      { item: "MDM coverage and encryption enforcement evidence", what_it_tells_you: "Whether technical controls back the rules" },
      { item: "Remote-wipe test record - verified the capability works", what_it_tells_you: "Whether the safety net is real" },
      { item: "Loss / theft register from the last 12 months with response trail", what_it_tells_you: "Whether incidents are tracked and acted on" },
      { item: "Asset-state evidence - for lost devices, what was on them at the time", what_it_tells_you: "Whether data-loss assessment is possible" }
    ],
    scoping_notes: "Encryption + remote-wipe + MDM is the modern foundation; without those three working together, off-premises security depends on user discipline that doesn't survive contact with reality. For BYOD that holds organizational data, the same controls need to apply or organizational data must be containerised.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: assets used off-premises (laptops, phones, removable media, work-at-home equipment) are protected via encryption, MDM, theft-reporting procedures, and acceptable-use rules. Sampled mobile worker has the configured controls in place.",
    maturity_ladder: {
      1: "Off-site rules informal; loss-tracking patchy",
      2: "Encryption + MDM mandatory; loss/theft reporting; remote-wipe tested",
      3: "Asset state visibility; physical-security guidance; insurance and security distinguished",
      4: "Real-time device posture; automated response to loss signals; predictive risk for off-site usage"
    },
    related_items: ["annex-a.6.7", "annex-a.7.10", "annex-a.8.1"]
  },

  'annex-a.7.10': {
    purpose: "Removable and portable storage - USB drives, external disks, backup tapes, SD cards, optical media. The carrier of choice for both legitimate data movement and exfiltration. A.7.10 governs handling per classification, encryption, sanitisation on disposal or reuse, and the technical controls that limit what can be copied to removable media in the first place.",
    what_good_looks_like: "A documented position on removable media: which media types are sanctioned, which are prohibited, when encryption is required (typically: any classification above Public on portable media, always for media leaving premises). Technical enforcement via DLP and endpoint controls - only authorised media types accepted, automatic encryption applied, unauthorized USBs blocked. Sanitisation procedure for media before disposal or reuse, aligned with NIST 800-88 (Clear / Purge / Destroy depending on media and classification). Tracking for sensitive media - particularly backup tapes and any media leaving premises. Records of destruction with certificates from disposal vendors where used.",
    common_pitfalls: [
      "USB use entirely unrestricted - any device, any port, any time",
      "Encryption optional even for sensitive data on portable media",
      "No sanitisation on disposal - old USBs end up in drawers or skip bins with data still on them",
      "Backup tapes leave premises for off-site storage without encryption verified",
      "Records of destruction absent - claim is \"we destroy them\" with nothing to show",
      "Personal USB drives bringing data in (and potentially malware) without governance"
    ],
    evidence_to_look_for: [
      { item: "Removable media policy with classification handling", what_it_tells_you: "Whether the rules exist and align with classification" },
      { item: "DLP / endpoint policy preventing unauthorized USB use; encryption enforcement evidence", what_it_tells_you: "Whether technical enforcement is real" },
      { item: "Sanitisation procedure aligned with a recognised standard (NIST 800-88 typical)", what_it_tells_you: "Whether disposal is defensible" },
      { item: "Destruction certificate from a recent batch", what_it_tells_you: "Whether disposal is documented" },
      { item: "Tape / backup-media handling for off-site storage with encryption confirmation", what_it_tells_you: "Whether long-tail media risk is managed" }
    ],
    scoping_notes: "USB-port lockdown and BitLocker-To-Go (or equivalent encryption-on-removable-media) are the practical floor. Cloud-collaboration tools have largely replaced USB for legitimate data sharing in many organizations; if the org is in that camp, the policy can be more restrictive (\"removable media not authorised except by exception\") which is easier to enforce than fine-grained allowlists.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: storage media (drives, tapes, USB, optical) is managed across its lifecycle - issuance, classification labelling, handling, disposal. Encryption applied where the media leaves controlled premises. Disposal evidence (certificates of destruction, secure-wipe records) exists for the last 12 months.",
    maturity_ladder: {
      1: "USB unrestricted; sanitisation informal",
      2: "Policy + DLP enforcement; encryption mandated; sanitisation procedure",
      3: "Tracking for sensitive media; certificates of destruction; tape encryption verified",
      4: "Removable media largely eliminated through cloud alternatives; remaining use tightly governed and monitored"
    },
    related_items: ["annex-a.5.14", "annex-a.7.14", "annex-a.8.12"]
  },

  'annex-a.7.11': {
    purpose: "Power, cooling, network, water - the utilities that keep equipment running. Without them, the most carefully designed information-security architecture is offline. A.7.11 ensures redundancy and resilience are deliberate, proportionate to availability needs, and tested.",
    what_good_looks_like: "Utility resilience is calibrated to availability requirements derived from BIA: UPS for short outages, generator for sustained outages, dual feeds for critical infrastructure where the budget supports it, redundant cooling for server rooms, redundant network connectivity for sites with availability needs. Maintenance is scheduled - UPS battery replacement, generator service, cooling-system service. Testing is real and recurring: generators run under load (not just started), UPS failover tested with real systems, not just simulated. Environmental monitoring (power, temperature, humidity) feeds alerting. Utility provider SLAs are tracked where applicable.",
    common_pitfalls: [
      "UPS in place but never tested under real load - first failure reveals it can hold for 4 minutes when claimed 30",
      "Generator hasn't been started in months; doesn't kick over when power fails",
      "Cooling redundancy absent in server room; one A/C unit fails and equipment thermal-throttles or shuts down",
      "Maintenance schedule lapses - battery beyond service life is itself a fire risk",
      "Environmental sensors absent - first signal of a thermal event is equipment failure",
      "Single network feed to a site with stated high-availability requirements"
    ],
    evidence_to_look_for: [
      { item: "Utility resilience design - what redundancy at what level for what facilities", what_it_tells_you: "Whether resilience is intentional" },
      { item: "Recent test records: generator load test, UPS failover test, cooling redundancy test", what_it_tells_you: "Whether resilience is verified" },
      { item: "Maintenance schedule and recent maintenance records", what_it_tells_you: "Whether equipment stays operational" },
      { item: "Environmental monitoring and alert evidence", what_it_tells_you: "Whether problems are detected early" }
    ],
    scoping_notes: "Cloud-hosted organizations transfer most of this to the cloud provider - a finding for an own-DC organization is not a finding for an org with no on-premises servers. Where the organization does run physical infrastructure, the test is real testing, not paper claims. Generators are the canonical failure point: claimed-functional, not actually-tested.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: supporting utilities (power, telecoms, water/cooling) are reliable enough to meet availability requirements - UPS for IT, generator or cloud-equivalent for critical workloads, redundant telecoms for sites that need it. Tested at least annually.",
    maturity_ladder: {
      1: "Redundancy partial; testing informal",
      2: "Redundancy proportionate; maintenance scheduled; basic testing",
      3: "Real-world testing; environmental monitoring; SLA tracking; redundancy aligned with BIA",
      4: "Continuous resilience monitoring; predictive maintenance; chaos-style testing for utilities"
    },
    related_items: ["annex-a.5.30", "annex-a.7.5", "annex-a.7.13", "annex-a.8.14"]
  },

  'annex-a.7.12': {
    purpose: "Cabling - power and data - protected from interception, damage, and accidental impairment. Often overlooked because cabling is invisible until it fails, but a poorly-protected cable run is both a reliability risk and a network-tap opportunity.",
    what_good_looks_like: "Cabling routed through protective infrastructure - conduits, ducts, cable trays, raised-floor systems - appropriate to environment. Power and data cabling segregated to prevent EMI. Public-network and private-network cabling segregated and labelled. Risers and cable rooms physically secured with controlled access. Cables labelled to support change management - every cable identifiable so a change in one place doesn't accidentally disconnect a critical service. For sensitive data, fibre-optic where the risk justifies (resistant to electromagnetic interception). Inspection on a periodic cycle catches degradation or unauthorized changes (rogue cable patches, unexpected splices).",
    common_pitfalls: [
      "Cables exposed in public corridors - accessible to anyone with wire-strippers",
      "Power and data co-mingled in trays - EMI causes intermittent issues hard to diagnose",
      "Risers unlocked or shared with maintenance access uncontrolled",
      "No labelling - patch panel becomes a guessing game; change errors cascade",
      "Patch panels in unsecured areas - anyone with brief access can patch a sensitive port to a rogue endpoint",
      "Cabling adds and changes done by unvetted contractors with no audit"
    ],
    evidence_to_look_for: [
      { item: "Cabling design / standards document", what_it_tells_you: "Whether cabling is governed by design rather than improvised" },
      { item: "Riser and patch-panel access controls", what_it_tells_you: "Whether the physical layer is secured" },
      { item: "Cable labelling sample", what_it_tells_you: "Whether change management is supported" },
      { item: "Inspection or maintenance records", what_it_tells_you: "Whether degradation is caught" }
    ],
    scoping_notes: "Cloud and managed-network organizations have minimal on-premises cabling exposure beyond office infrastructure. For organizations with their own data centres, sensitive labs, or campuses, this control matters significantly. Modern alternative: structured cabling standards (TIA-568, ISO/IEC 11801) provide off-the-shelf good design.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: cabling is protected against interception and damage in in-scope premises - conduit, locked patching, separation of power and data, where the site has its own infrastructure. For cloud-only / no-premises orgs, the SoA records the applicability decision.",
    maturity_ladder: {
      1: "Cabling ad-hoc; documentation partial",
      2: "Standards-based design; risers controlled; labelling adequate",
      3: "Physical-layer access controls; inspection regime; change management integrated",
      4: "Continuous physical-layer visibility; tamper detection; design reviewed against evolving threats"
    },
    related_items: ["annex-a.7.8", "annex-a.7.11", "annex-a.8.20"]
  },

  'annex-a.7.13': {
    purpose: "Equipment maintenance - keeping kit running per manufacturer guidance, controlling who can maintain it, and protecting data when equipment leaves the site for service. Without governance, maintenance becomes a back-door access path: maintenance providers walk in with admin access and walk out with whatever they want.",
    what_good_looks_like: "A maintenance schedule per equipment type / criticality - vendor-managed for critical infrastructure, scheduled internal for general kit. Maintenance providers (for vendor-managed maintenance) are vetted, contractually bound to security obligations, and escorted in sensitive areas. Security controls activate when equipment leaves the site for service: data wipe before removal where possible, maintenance under organizational supervision where wipe isn't possible, audit trail of what left and when, certificate of receipt-back. Records of maintenance kept - what was done, when, by whom.",
    common_pitfalls: [
      "No maintenance schedule - equipment runs to failure",
      "Equipment shipped for service with sensitive data still on it",
      "Maintenance providers issued permanent badges without time-bounded access",
      "Maintenance providers unvetted - no due diligence on the company that has hands-on access to your kit",
      "No records of maintenance activity - \"the vendor did it\" with no detail",
      "After-hours maintenance unsupervised in sensitive areas"
    ],
    evidence_to_look_for: [
      { item: "Maintenance schedule for major equipment categories", what_it_tells_you: "Whether maintenance is planned" },
      { item: "Maintenance-provider due diligence - security questionnaires, contractual security clauses", what_it_tells_you: "Whether external maintainers are governed" },
      { item: "Off-site maintenance procedure - wipe before removal, escort, records", what_it_tells_you: "Whether equipment-leaves-site risk is managed" },
      { item: "Recent maintenance records with what was done and by whom", what_it_tells_you: "Whether activity is tracked" }
    ],
    scoping_notes: "Cloud-heavy organizations have most equipment maintenance handled by cloud providers - falls into A.5.19-22 supplier territory. For on-premises infrastructure, this control matters; the most-overlooked dimension is data protection when equipment leaves the site temporarily for service.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: equipment is maintained on schedule (warranty plus manufacturer guidance), maintenance is authorised and supervised, and decommissioned equipment is sanitised before disposal/reuse. Maintenance records exist.",
    maturity_ladder: {
      1: "Maintenance reactive; provider governance partial",
      2: "Schedule documented; providers vetted; records kept",
      3: "Off-site service procedures; escort and supervision; audit trail",
      4: "Predictive maintenance; provider performance monitored; integrated with asset and access management"
    },
    related_items: ["annex-a.5.19", "annex-a.7.11", "annex-a.7.14"]
  },

  'annex-a.7.14': {
    purpose: "End-of-life for equipment - the moment when data on the equipment is most likely to escape. Every drive, phone, photocopier, and printer holds data that can be recovered if disposal isn't done deliberately. A.7.14 requires sanitisation or destruction before disposal or reuse, with records.",
    what_good_looks_like: "A documented disposal procedure aligned with NIST 800-88 (Clear / Purge / Destroy by media type and classification). Storage is sanitised before disposal or reuse - by the org or by a vetted disposal vendor with chain-of-custody. For data above a defined classification, physical destruction is required (shredding, degaussing for magnetic media). Certificates of destruction from disposal vendors are kept. The disposal inventory tracks what was disposed, when, by what method, with what verification. Lesser-considered media - multifunction printers with hard drives, photocopier hard drives, network gear with persistent storage - are in scope.",
    common_pitfalls: [
      "No documented procedure - \"we just give old laptops to staff\" or \"IT figures it out\"",
      "No verification - disposal claimed, no evidence",
      "No certificates of destruction from third-party disposal vendors",
      "Photocopier and multifunction printer drives forgotten - leased equipment returned with data on it",
      "Sanitisation method inadequate for classification - quick-format used where degauss is required",
      "Disposed equipment recoverable in months from disposal-firm records",
      "Resold equipment goes out with data still on it; emerges in someone's possession with org data"
    ],
    evidence_to_look_for: [
      { item: "Disposal procedure aligned with a recognised standard", what_it_tells_you: "Whether the method is defensible" },
      { item: "Disposal inventory - what was disposed, when, method, verification", what_it_tells_you: "Whether disposal is tracked" },
      { item: "Recent certificates of destruction (from internal sanitisation or vendor)", what_it_tells_you: "Whether disposal is documented" },
      { item: "Multifunction printer and network-equipment disposal evidence", what_it_tells_you: "Whether less-obvious media are addressed" },
      { item: "Vendor due diligence for disposal partners", what_it_tells_you: "Whether the chain is trustworthy" }
    ],
    scoping_notes: "NIST 800-88 is the industry reference. The Clear / Purge / Destroy distinction matters - Clear (single overwrite) is acceptable for low-classification reuse; Purge (cryptographic erase or multi-pass) for higher; Destroy (physical destruction) for highest. Pick a vendor with proven chain-of-custody and recoverable certificates; auditors will ask for one.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented secure disposal/reuse procedure for equipment containing data - wipe to a defined standard (NIST SP 800-88 or equivalent) or physical destruction with certificate. Records show the procedure was followed for in-scope disposals in the last 12 months.",
    maturity_ladder: {
      1: "Disposal informal; verification partial",
      2: "Procedure documented; certificates kept; inventory tracked",
      3: "Risk-tiered disposal methods; vendor due diligence; less-obvious media addressed",
      4: "Continuous disposal-state visibility; reuse decisions risk-driven; metrics on disposal-cycle compliance"
    },
    related_items: ["annex-a.5.11", "annex-a.5.33", "annex-a.7.10", "annex-a.7.13"]
  },

  // ===================================================================
  // ANNEX A.8 - TECHNOLOGICAL CONTROLS
  // ===================================================================

  'annex-a.8.1': {
    purpose: "User endpoint devices - laptops, desktops, tablets, mobile devices. The most exposed surface in any organization because endpoints are what users touch, what gets carried around, what gets compromised first. A.8.1 sets the requirements for endpoint security and ensures the estate meets them.",
    what_good_looks_like: "Documented endpoint requirements covering: configuration baseline (typically CIS Benchmarks or vendor hardening guides), anti-malware / EDR active and reporting, full-disk encryption, screen-lock timeout enforced, MDM enrolment with policies pushed, patching cadence (OS and major applications), supported-OS-only (no end-of-life Windows or unsupported macOS), allowed software (allowlist or known-bad blocklist). Endpoint visibility - the org knows how many endpoints exist and whether each is compliant. Non-compliant endpoints have a remediation path. BYOD addressed explicitly: either prohibited from accessing organizational data, or governed via a containerised approach with the same controls applied. Loss-and-theft response automated where possible (remote wipe, session revocation, credential rotation).",
    common_pitfalls: [
      "BYOD without controls - personal devices accessing organizational email and SaaS without MDM or containerisation",
      "MDM coverage incomplete - some endpoints unenrolled, often the technical staff's own devices",
      "Legacy unsupported OS in active use (Windows 7, end-of-life macOS) with no remediation plan",
      "Encryption not enforced - claimed but the policy doesn't actually verify enrolment",
      "Visibility incomplete - \"approximately 800 endpoints\" with no live inventory",
      "EDR deployed but not monitored - alerts go nowhere",
      "Patching cadence stated but actual patch lag exceeds it materially"
    ],
    evidence_to_look_for: [
      { item: "Endpoint security baseline document", what_it_tells_you: "Whether requirements are explicit" },
      { item: "MDM coverage report - % of endpoints enrolled and compliant", what_it_tells_you: "Whether the estate is governed" },
      { item: "EDR coverage and recent alert handling", what_it_tells_you: "Whether the detection layer works" },
      { item: "Encryption enforcement evidence - config policy + actual compliance status", what_it_tells_you: "Whether encryption is real" },
      { item: "Patching cadence vs. actual patch state", what_it_tells_you: "Whether the patching policy is followed" },
      { item: "BYOD position with technical evidence (containerisation, MDM, blocking)", what_it_tells_you: "Whether BYOD is governed" },
      { item: "Loss / theft response evidence - recent remote wipe", what_it_tells_you: "Whether the safety net works" }
    ],
    scoping_notes: "Endpoint security is the area where the gap between policy and reality shows up most visibly in audits. A 95%-MDM-coverage claim is one query away from being verified or refuted. Most-overlooked: the long tail of executive/technical-staff devices that escape standard policy through informal exception.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: user endpoints have a baseline security configuration applied via MDM/management tooling - disk encryption, screen lock, EDR/anti-malware, OS patching enforced, USB and remote-access policy applied. Sampled endpoints in the inventory show the baseline is current.",
    maturity_ladder: {
      1: "Endpoint policy partial; MDM coverage incomplete",
      2: "Baseline + MDM + EDR + encryption mandated; coverage tracked",
      3: "BYOD addressed; patching cadence enforced; loss/theft response operational; supported-OS-only",
      4: "Continuous endpoint posture management; risk-based access decisions per device; metrics on compliance and exposure"
    },
    related_items: ["annex-a.5.10", "annex-a.6.7", "annex-a.7.9", "annex-a.8.5", "annex-a.8.7", "annex-a.8.8"]
  },

  'annex-a.8.2': {
    purpose: "Privileged access - admin, root, sudo, super-user, DBA, domain admin, cloud-account-owner - is the access that, if abused or compromised, causes the worst outcomes. A.8.2 requires privileged access to be tightly restricted, separately governed, logged, and reviewed on a faster cadence than standard access. This is one of the most-tested controls in any audit because privileged access is where breaches go from minor to catastrophic.",
    what_good_looks_like: "Privileged access is restricted to documented business need, with explicit approval. Privileged accounts are separate from daily-use accounts - admins have a standard account for email and meetings, and a privileged account for elevated work. Just-in-time elevation is used where the toolset supports it (privileged access only available during defined windows or via approved elevation requests). A Privileged Access Management (PAM) tool vaults privileged credentials, enforces session recording, and provides break-glass procedures for emergency access. MFA is required for privileged login (phish-resistant where possible). Privileged access is reviewed at least quarterly - far more frequently than standard access. Shared admin accounts are minimised and where unavoidable are vaulted with checkout/checkin tracking.",
    common_pitfalls: [
      "Privileged access widely held - way more domain admins than the org actually needs",
      "Users routinely log into privileged accounts for daily work (email, browsing) - violates separation",
      "PAM absent - privileged credentials are passwords stored in spreadsheets or memory",
      "Privileged sessions not recorded; what privileged users actually did is invisible",
      "Standing privilege never reviewed - \"once a domain admin, always a domain admin\"",
      "Shared admin accounts (\"admin\" with shared password) defeat traceability",
      "MFA optional or weaker on privileged accounts - opposite of risk-aligned",
      "Cloud-account-owners unmonitored - root in AWS, owner in GCP, global admin in Azure, all standing"
    ],
    evidence_to_look_for: [
      { item: "Privileged access policy with separation-of-account principle", what_it_tells_you: "Whether the rules exist" },
      { item: "Privileged account inventory - who has which level of privilege in which system", what_it_tells_you: "Whether the privilege landscape is visible" },
      { item: "PAM or vault evidence - tooling in place, sessions recorded, credentials managed", what_it_tells_you: "Whether technical controls back the policy" },
      { item: "Privileged access review - most recent review showing decisions made", what_it_tells_you: "Whether reviews drive action on faster cadence" },
      { item: "MFA coverage on privileged accounts", what_it_tells_you: "Whether the strongest auth is on the riskiest accounts" },
      { item: "Sample privileged session - recorded session, available for review", what_it_tells_you: "Whether monitoring is operational" },
      { item: "Cloud-account-root governance - who has root, how it's used, MFA, alerts on use", what_it_tells_you: "Whether cloud privilege is treated as sensitive" }
    ],
    scoping_notes: "PAM tooling materially raises the maturity floor - without it, privileged access governance relies on discipline and procedure that doesn't scale. JIT elevation is the modern best practice (privileged access exists only when needed, expires automatically); standing privilege is increasingly seen as the anti-pattern. Cloud account ownership (AWS root, Azure global admin) deserves its own focus - these credentials, if compromised, take the whole estate down.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: privileged accounts are inventoried, granted on least-privilege/just-in-time basis where feasible, separated from standard accounts, protected with MFA (preferably phish-resistant), and monitored. Recent privileged-access review exists.",
    maturity_ladder: {
      1: "Privileged access widely held; standing; reviews infrequent",
      2: "Separated accounts; MFA; quarterly reviews; basic vaulting",
      3: "PAM operational; session recording; JIT elevation in critical systems; cloud-root governed",
      4: "Zero-standing-privilege model; continuous privilege review; behavioural anomaly detection on privileged sessions"
    },
    related_items: ["annex-a.5.15", "annex-a.5.17", "annex-a.5.18", "annex-a.8.5", "annex-a.8.18"]
  },

  'annex-a.8.3': {
    purpose: "Technical enforcement of access rules at function and data level. Where A.5.15 sets the rules and A.5.18 manages who has which rights, A.8.3 is about how those rules are enforced inside applications and at the data layer - function-level access (can the user invoke this action?) and data-level access (which records can the user see?).",
    what_good_looks_like: "Access enforcement happens at multiple layers: at the application boundary (authentication and authorization), at the function level (RBAC checks within the application - role membership controls which actions are available), and at the data level where appropriate (row-level security, attribute-based access for multi-tenant or sensitive datasets). Least-privilege is the default - users see only what their role requires, and only the records relevant to them. Explicit deny rather than implicit deny is the access model - \"if not granted, denied\" rather than \"if not denied, granted.\" Exceptions are time-bounded and logged. Critical functions have additional checks (re-authentication, approval workflows).",
    common_pitfalls: [
      "Access enforced at app entry only - once you're in, you can do anything the app supports",
      "Over-broad permissions assigned by role - \"Manager\" role grants read-everything",
      "No row-level security on multi-tenant data - Tenant A users can craft requests that return Tenant B data",
      "Default-allow rather than default-deny - new features inherit broad access until someone notices",
      "Function-level checks done in UI but not enforced at the API or database - bypassed by anyone who calls the API directly",
      "Critical actions (delete, export, escalate) lack additional checks (re-auth, approval, second pair of eyes)"
    ],
    evidence_to_look_for: [
      { item: "Authorization design document - how access decisions are made at function and data level", what_it_tells_you: "Whether enforcement is designed deliberately" },
      { item: "Sample application showing RBAC implementation (role-permission mapping)", what_it_tells_you: "Whether function-level enforcement is real" },
      { item: "Row-level or attribute-based access controls on sensitive datasets", what_it_tells_you: "Whether data-level enforcement is in place where it should be" },
      { item: "Sample test of authorization bypass (e.g., direct API access bypassing UI controls)", what_it_tells_you: "Whether the enforcement layer is correct" },
      { item: "Critical-action workflows - delete, export, privilege-escalation", what_it_tells_you: "Whether dangerous functions have additional checks" }
    ],
    scoping_notes: "This control is most-tested for SaaS organizations and any org with custom-built applications. For organizations using only off-the-shelf software, the control becomes more about configuring vendor-provided access controls correctly rather than designing them. Multi-tenant data is the highest-risk area - row-level security or equivalent is essentially mandatory for SaaS handling customer data.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: access to information is restricted per the access-control policy, with technical controls enforcing the restrictions (file shares, app permissions, database role-based access). Sampled access for a sensitive dataset shows only authorised users have it.",
    maturity_ladder: {
      1: "Function-level access partial; data-level absent",
      2: "RBAC consistently applied; row-level security on sensitive data; default-deny",
      3: "Layered enforcement; critical actions hardened; periodic authorization review",
      4: "Attribute-based access; runtime authorization decisions on context; continuous testing for bypass"
    },
    related_items: ["annex-a.5.15", "annex-a.5.18", "annex-a.8.2", "annex-a.8.4"]
  },

  'annex-a.8.4': {
    purpose: "Source code is one of the highest-value assets in any organization that develops software - it's the IP, it's the attack-surface map, and it often contains secrets that should never be there. A.8.4 restricts access to code repositories and supporting tools, applies branch and review protections, and ensures source code doesn't walk away.",
    what_good_looks_like: "Source code lives in restricted repositories with role-based access - developers see code for projects they work on, with broader access reserved for maintainers and infrastructure roles. Repositories default to private; public repos exist only by explicit decision. Protected branches require pull requests and code review before merge; the review requirement is technically enforced, not policy-only. Signed commits or signed tags are used for sensitive repositories. Secrets scanning runs on commit and rejects pushes containing credentials or keys. Audit trails capture who accessed what and when. Cloning to personal devices is governed (managed devices only, or restricted by IP / device posture). Off-boarding revokes repository access promptly across all repository platforms in use.",
    common_pitfalls: [
      "Repositories default to public on platforms like GitHub - accidental public exposure",
      "No branch protection - direct push to main is permitted, bypassing review",
      "Secrets committed to repositories and not detected - keys, tokens, credentials in commit history",
      "Departing developers retain access to repositories for days or weeks after termination",
      "Forking to personal accounts permitted with no governance - codebase walks out via personal forks",
      "Build pipelines and CI/CD tools have repository access that outlives the projects they were created for",
      "No review on dependency updates - developers approve their own dependency-bump PRs"
    ],
    evidence_to_look_for: [
      { item: "Repository access matrix - who has which level of access to which repositories", what_it_tells_you: "Whether access is governed" },
      { item: "Branch protection configuration on critical repositories", what_it_tells_you: "Whether review is enforced technically" },
      { item: "Secrets-scanning configuration with recent rejections or findings", what_it_tells_you: "Whether secrets-in-code is caught" },
      { item: "Off-boarding evidence showing repository access revoked for a recent leaver", what_it_tells_you: "Whether repository off-boarding works" },
      { item: "Audit log sample from the source-control platform", what_it_tells_you: "Whether access activity is traceable" },
      { item: "Personal-device cloning policy and enforcement (if applicable)", what_it_tells_you: "Whether code stays on managed devices" }
    ],
    scoping_notes: "GitHub, GitLab, Bitbucket, Azure DevOps each have their own model for branch protection, signed commits, and access management. The control is platform-agnostic but the evidence is platform-specific. For organizations with no in-house development, this control may not apply or may apply narrowly to scripts and infrastructure-as-code repositories.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: access to source code is restricted to authorised developers, with version control (Git or equivalent), code-review requirements before merge, branch-protection on production branches, and audit logging of changes. Sampled code change shows the controls were applied.",
    maturity_ladder: {
      1: "Repository access partly governed; branch protection partial",
      2: "Access matrix; protected branches; secrets scanning; off-boarding works",
      3: "Signed commits on critical repos; cloning controlled; audit logs reviewed",
      4: "Continuous code-access posture; behavioural anomaly detection (mass-clone alerts); supply-chain integrity"
    },
    related_items: ["annex-a.5.32", "annex-a.8.3", "annex-a.8.25", "annex-a.8.28"]
  },

  'annex-a.8.5': {
    purpose: "Authentication strength matched to risk. The strongest authentication for the riskiest access; lighter-weight where the risk doesn't justify friction. Implements the practical detail of authentication: MFA, factor selection, risk-based decisions, session management.",
    what_good_looks_like: "Authentication strength is calibrated to risk. Sensitive systems and privileged access require MFA - and increasingly phish-resistant MFA (FIDO2/WebAuthn, hardware keys, platform authenticators) for the highest-risk roles. SMS-based MFA is recognised as legacy and being phased out where alternatives exist. Risk-based authentication is in use where the toolset supports it: anomalous-location, anomalous-device, impossible-travel signals trigger step-up authentication or block. Failed-login monitoring catches credential-stuffing and brute-force patterns; rate limiting and account lockout policies are tuned to balance security and availability. Session management is robust - appropriate session timeouts, secure cookies, server-side session invalidation on logout, re-auth required for sensitive actions.",
    common_pitfalls: [
      "SMS-only MFA across the board including for privileged users - vulnerable to SIM-swap and SS7 attacks",
      "MFA enforced for VPN but not for SaaS apps - attackers go around the strongest control",
      "No risk-based signals - every login looks the same regardless of context",
      "Failed-login attempts not monitored; credential-stuffing campaigns succeed undetected",
      "Long-lived sessions with no re-auth for sensitive actions - session hijack is catastrophic",
      "Account-lockout thresholds either too tight (creating denial-of-service) or too loose (allowing brute force)"
    ],
    evidence_to_look_for: [
      { item: "Authentication policy with strength tiering by risk", what_it_tells_you: "Whether the rules are calibrated" },
      { item: "MFA coverage report - which systems require MFA, with what factor, for which users", what_it_tells_you: "Whether enforcement matches policy" },
      { item: "Phish-resistant MFA evidence for highest-risk roles", what_it_tells_you: "Whether modern auth is in use where it matters" },
      { item: "Risk-based authentication configuration and recent triggers", what_it_tells_you: "Whether contextual signals drive decisions" },
      { item: "Failed-login monitoring evidence - recent triage of suspicious patterns", what_it_tells_you: "Whether attacks are detected" },
      { item: "Session-management configuration - timeouts, re-auth requirements", what_it_tells_you: "Whether sessions are properly limited" }
    ],
    scoping_notes: "The shift away from SMS MFA toward phish-resistant factors (FIDO2, hardware keys, platform authenticators like Touch ID / Face ID with WebAuthn) is the modern direction. Auditors are increasingly aware. SMS as fallback is acceptable; SMS as primary for high-risk roles is increasingly seen as a finding.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: MFA enforced on all admin and privileged accounts, and on remote access for normal users. Password policy aligned to current NIST SP 800-63B guidance (length over complexity, breach-list check). Authentication failures are monitored with alerting on brute-force or impossible-travel patterns. Service accounts are inventoried with credential-rotation evidence.",
    maturity_ladder: {
      1: "MFA partial; SMS-dominant; risk signals absent",
      2: "MFA on sensitive systems; failed-login monitoring; reasonable session limits",
      3: "Phish-resistant MFA for privileged; risk-based auth in use; rate limiting tuned",
      4: "Passwordless or near-passwordless; continuous risk evaluation; behavioural anomaly drives auth decisions"
    },
    related_items: ["annex-a.5.17", "annex-a.8.2", "annex-a.8.16"]
  },

  'annex-a.8.6': {
    purpose: "Capacity management - making sure systems have the resources to do what they're meant to do, before demand outstrips supply. Often dismissed as an availability concern rather than a security one, but the connection runs both ways: insufficient capacity creates outages, and outages drive operational shortcuts that create security exposure.",
    what_good_looks_like: "Capacity is monitored across the dimensions that matter for the organization's stack - compute, storage, network, licence seats, database connections, queue depth, message throughput. Future demand is projected based on growth, planned changes, and seasonality; projections inform capacity decisions before they become crises. Alerts fire on thresholds that allow time to act, not at the point of failure. Capacity adjustments happen before service degrades - auto-scaling for cloud, planned procurement for hardware, licence reviews before annual renewal. Integration with availability requirements: capacity targets derive from RTO/RPO and operational SLAs, not from arbitrary headroom rules.",
    common_pitfalls: [
      "Capacity reactive - capacity issues addressed only when alarms fire or users complain",
      "No projection - capacity decisions made on current state with no view of where the curve is going",
      "Storage and network capacity unmonitored - focus only on compute",
      "Licence capacity ignored - software audits surprise the organization",
      "Cloud over-provisioning treated as capacity management - \"we just scale up\" without cost control or right-sizing",
      "Database connection pools and message-queue depth not monitored despite being common bottleneck points"
    ],
    evidence_to_look_for: [
      { item: "Capacity monitoring inventory - what's tracked across compute, storage, network, application layers", what_it_tells_you: "Whether monitoring is comprehensive" },
      { item: "Capacity projections for the next 6-12 months for critical systems", what_it_tells_you: "Whether the future is planned for" },
      { item: "Threshold and alert configuration with reaction-time built in", what_it_tells_you: "Whether alerts allow time to act" },
      { item: "Sample capacity decision - recent expansion or right-sizing driven by data", what_it_tells_you: "Whether capacity management is operational" },
      { item: "Licence capacity tracking with renewal alignment", what_it_tells_you: "Whether software-licensing capacity is included" }
    ],
    scoping_notes: "Cloud-native organizations have different capacity dynamics - auto-scaling handles compute capacity, but storage costs and database limits still need explicit management. The control isn't about \"do you scale\" but \"do you know your capacity posture and is it intentional.\" Cost-runaway is the cloud-era cousin of capacity exhaustion.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: capacity is monitored across the dimensions that matter (compute, storage, network, licences, queue depth) for in-scope systems, with alerts on thresholds and a capacity-planning cadence tied to growth/seasonality. Auto-scaling configured where applicable.",
    maturity_ladder: {
      1: "Capacity reactive; projection ad-hoc",
      2: "Monitoring across major dimensions; projection annual; threshold alerts",
      3: "Capacity decisions data-driven; integrated with change planning; cost-aware in cloud",
      4: "Predictive capacity management; auto-scaling with cost guardrails; capacity tied to availability targets"
    },
    related_items: ["annex-a.5.30", "annex-a.8.14", "annex-a.8.16"]
  },

  'annex-a.8.7': {
    purpose: "Anti-malware. The control that's been around longest and that organizations most often treat as solved. It isn't - modern malware (fileless, ransomware, supply-chain, living-off-the-land) requires modern defences (EDR, behavioural detection, application allowlisting) that go well beyond signature-based AV.",
    what_good_looks_like: "Anti-malware / EDR is deployed across all relevant platforms - endpoints, servers (including Linux), email gateway, web proxy, mobile devices. Coverage is verified through MDM and EDR consoles, not just policy. Detection updates automatically. Alerts feed the SOC or IR process and are triaged within defined SLAs. User-reported malware (suspicious email, file, behavior) reaches IR through the reporting channel (A.6.8) and gets actioned. Web filtering and email filtering provide upstream defence. Macro and script controls reduce the attack surface - Office macros disabled by default, signed-only macros for exceptions, PowerShell logging and constrained mode where applicable. Ransomware-specific defences in place: behavioural detection, immutable backups, segregated backup credentials.",
    common_pitfalls: [
      "Legacy signature-based AV only - modern threats walk past",
      "EDR deployed but not centrally monitored - alerts go nowhere",
      "Coverage gaps - Linux servers, macOS endpoints, mobile devices, container workloads, cloud workloads all missed",
      "Alerts triaged inconsistently - some get attention, others auto-dismissed",
      "User reports of suspicious activity not actioned within useful timeframes",
      "Office macros enabled by default with only awareness as defence - a 1990s threat with 2020s consequences",
      "No specific ransomware preparedness - backups not tested for ransomware-recovery scenarios"
    ],
    evidence_to_look_for: [
      { item: "Anti-malware / EDR coverage report across all platforms", what_it_tells_you: "Whether coverage is real" },
      { item: "Recent alert triage record - what was detected and how it was handled", what_it_tells_you: "Whether alerts drive action" },
      { item: "Email and web filtering configuration with recent block-rate metrics", what_it_tells_you: "Whether upstream defences work" },
      { item: "Macro and script policy configuration", what_it_tells_you: "Whether attack surface is reduced" },
      { item: "Ransomware-recovery test evidence - backup restore from tested-immutable copy", what_it_tells_you: "Whether ransomware-specific resilience is real" }
    ],
    scoping_notes: "EDR with central monitoring is the modern floor. Legacy AV alone is increasingly seen as insufficient - auditors aware of EDR will probe for it. For organizations using cloud workloads heavily, cloud-workload protection (CWP) tooling becomes part of the picture and pure endpoint thinking misses the cloud attack surface.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: anti-malware controls deployed on endpoints and servers (EDR/EPP), with central reporting, automatic signature/engine updates, and an alert triage routine. Email gateways have anti-malware controls. Recent detection or test event shows the pipeline works.",
    maturity_ladder: {
      1: "Signature AV; partial coverage; alerts ad-hoc",
      2: "EDR deployed; central monitoring; alerts triaged; email/web filtering",
      3: "Coverage across platforms; ransomware-specific defence; macro and script controls",
      4: "Behavioural detection mature; threat-hunting active; integrated with broader SOC; metrics on dwell time"
    },
    related_items: ["annex-a.5.7", "annex-a.5.25", "annex-a.5.26", "annex-a.8.1", "annex-a.8.16"]
  },

  'annex-a.8.8': {
    purpose: "Vulnerability management - identify, evaluate, remediate. The discipline that closes the gaps before attackers find them. The control most likely to fail at scale because vulnerability volume always exceeds remediation capacity - what matters is the prioritisation, the SLA, and the closure tracking.",
    what_good_looks_like: "Vulnerability identification spans multiple layers: external attack surface (perimeter scanning), internal network and host (authenticated scanning), web application (DAST), code (SAST), dependencies (SCA), containers (image scanning), cloud configuration (CSPM). Threat-intel-informed prioritisation - CVSS plus exploitability plus presence-in-the-wild plus business context, not just CVSS. Documented remediation SLAs by severity (e.g., critical 7 days, high 30, medium 90). Tracking through closure with metrics: median time-to-remediate, % overdue, backlog age. Patch management cadence operational - OS, application, firmware. Cloud and container vulnerabilities included, not deferred. SBOM-driven dependency management for organizations producing software.",
    common_pitfalls: [
      "Scanning incomplete - only on-prem network, missing web apps, code, dependencies, cloud, containers",
      "SLAs unrealistic - \"critical in 24 hours\" with no operational capacity to meet it, so they're routinely missed",
      "Remediation queue grows indefinitely - vulnerabilities accumulate faster than they close, and the ratio is invisible",
      "No dependency scanning - Log4j-class supply-chain risk invisible",
      "Cloud / container coverage missing - these are where the volume actually is in modern stacks",
      "CVSS-only prioritisation - high-CVSS vulns with no exploit get patched before low-CVSS ones being actively exploited",
      "Patches deployed but not verified - patch installed doesn't mean vulnerability remediated (e.g., service didn't restart)"
    ],
    evidence_to_look_for: [
      { item: "Vulnerability scanning coverage across layers", what_it_tells_you: "Whether visibility is comprehensive" },
      { item: "SLA policy by severity with rationale", what_it_tells_you: "Whether prioritisation is calibrated" },
      { item: "Vulnerability backlog with age distribution and trend over time", what_it_tells_you: "Whether the queue is in control" },
      { item: "Median time-to-remediate metric", what_it_tells_you: "Whether SLAs are met in practice" },
      { item: "Sample vulnerability traced through identification, prioritisation, remediation, verification", what_it_tells_you: "Whether the lifecycle works" },
      { item: "Threat-intel integration - vulnerabilities re-prioritised based on emerging exploit information", what_it_tells_you: "Whether intel feeds prioritisation" }
    ],
    scoping_notes: "Cloud and container vulnerability management is increasingly the largest volume in modern stacks. Tools and processes designed for traditional infrastructure don't transfer cleanly. SBOM and SCA for software-producing organizations is now expected; without them, dependency risk is invisible. The metrics matter - \"we have a programme\" without time-to-remediate or backlog-age is unprovable.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: technical vulnerabilities are identified through scanning (authenticated where possible) plus monitoring of vendor advisories. A documented patching/remediation SLA by severity, with metrics on adherence. At least one cycle of scan → prioritise → remediate → verify completed in the last 90 days.",
    maturity_ladder: {
      1: "Scanning partial; remediation ad-hoc",
      2: "Multi-layer scanning; SLAs by severity; tracked closure",
      3: "Threat-intel-informed prioritisation; cloud/container/code coverage; SLA metrics",
      4: "Continuous vulnerability management with risk-based prioritisation; dwell-time minimised; integrated with threat hunting"
    },
    related_items: ["annex-a.5.7", "annex-a.5.21", "annex-a.8.9", "annex-a.8.32"]
  },

  'annex-a.8.9': {
    purpose: "Configuration management - defining secure baselines and ensuring systems actually run them. Without configuration discipline, security depends on individual operator judgement at deployment time and on never changing afterward. Both fail.",
    what_good_looks_like: "Documented secure-configuration baselines per system type - CIS Benchmarks, vendor hardening guides, or organization-derived equivalents - for the systems in scope (Windows, Linux, network devices, cloud accounts, containers, databases, key SaaS). Baselines applied via automation: Infrastructure as Code (Terraform, CloudFormation, ARM), configuration management (Ansible, Chef, Puppet, SCCM), policy-as-code (OPA, Sentinel). Drift detection runs continuously: CSPM for cloud, configuration scanning for on-prem, attestation reports. Drift triggers either automated remediation or a remediation ticket. Baseline changes themselves go through change control - the baseline is a controlled artefact. Periodic review of baselines against evolving threat picture and platform updates.",
    common_pitfalls: [
      "Baselines not documented - \"hardened by best practice\" with no specific reference",
      "Baselines manually applied - drift inevitable, undetectable",
      "No drift detection - initial deployment compliant, post-deployment state unknown",
      "Baselines never reviewed - CIS benchmark from 2021 still applied in 2026 despite material updates",
      "Cloud baseline absent - CIS for Windows servers but no equivalent for AWS / Azure / GCP accounts",
      "Container and Kubernetes baselines ignored - significant portion of modern stack with no hardening discipline"
    ],
    evidence_to_look_for: [
      { item: "Baseline inventory - which baselines for which system types", what_it_tells_you: "Whether baselines are defined" },
      { item: "Automation evidence - IaC, configuration management, policy-as-code", what_it_tells_you: "Whether application is automated" },
      { item: "Drift detection output (CSPM dashboard, config scan results) with current compliance status", what_it_tells_you: "Whether drift is visible" },
      { item: "Recent drift remediation - drift detected, remediated, verified", what_it_tells_you: "Whether drift drives action" },
      { item: "Baseline change record - baseline updated through controlled process", what_it_tells_you: "Whether baselines themselves are governed" },
      { item: "Cloud and container baseline coverage", what_it_tells_you: "Whether modern platforms are addressed" }
    ],
    scoping_notes: "CSPM (Cloud Security Posture Management) tooling is increasingly the practical answer for cloud configuration. Without it, cloud configuration governance is manual and unreliable. Container security tooling (Trivy, Falco, equivalent) provides similar coverage for container workloads. The control isn't about specific tools but about whether the org has continuous configuration visibility.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: configuration baselines exist for in-scope systems (servers, endpoints, network devices, cloud) referencing a recognised standard (CIS, vendor hardening guide). Configuration drift is detected. Sampled system shows the baseline is applied.",
    maturity_ladder: {
      1: "Baselines partial; drift undetected",
      2: "Baselines documented; automation for major systems; basic drift detection",
      3: "CSPM/SSPM operational; cloud and container coverage; drift remediation tracked",
      4: "Continuous configuration governance; automated remediation; baseline evolution driven by threat intel"
    },
    related_items: ["annex-a.5.23", "annex-a.8.7", "annex-a.8.8", "annex-a.8.32"]
  },

  'annex-a.8.10': {
    purpose: "Information deletion - actually deleting data, not just hiding it. The control that closes the lifecycle from creation through use to disposal. Particularly important under privacy regimes (GDPR Art. 17 right to erasure, CCPA equivalent) where deletion is a regulatory obligation, not just a hygiene concern.",
    what_good_looks_like: "Documented deletion processes per data type aligned with retention (A.5.33). Deletion happens in primary storage AND backups AND replicas AND cloud copies - the long tail. Verification that deletion completed (not just initiated). For privacy obligations, Data Subject erasure requests handled through a defined process with timelines met. Hard delete vs soft delete decisions are explicit - soft delete is acceptable as a step, but eventual hard delete is required. Tooling for deletion at scale where volume justifies (cloud lifecycle policies, database TTL, archival-and-purge tooling). Records of deletion for high-sensitivity data, with destruction certificates where third parties involved.",
    common_pitfalls: [
      "Primary copy deleted but backups retain indefinitely - recovery from any backup brings the data back",
      "Cloud copies missed - data deleted from S3 but versioned bucket retains copies",
      "Privacy deletion (GDPR Art. 17) handled manually with errors - first attempt misses replicas, audit trail later reveals incomplete deletion",
      "Soft-delete-only - \"delete\" sets a flag but data persists indefinitely",
      "No verification - deletion claimed without confirmation it completed",
      "Third-party copies (analytics tools, backup providers) not addressed in deletion",
      "Deletion timelines unmeasured - privacy regulator asks \"how long does it take you to fulfil an erasure request\" and the org can't answer"
    ],
    evidence_to_look_for: [
      { item: "Deletion procedures per data type", what_it_tells_you: "Whether deletion is defined" },
      { item: "Coverage of backups and replicas in deletion", what_it_tells_you: "Whether the long tail is addressed" },
      { item: "Privacy erasure request handling - sample DSR with timeline and verification", what_it_tells_you: "Whether DSR fulfilment works" },
      { item: "Deletion verification evidence", what_it_tells_you: "Whether deletion is confirmed" },
      { item: "Cloud lifecycle / TTL configuration for major data stores", what_it_tells_you: "Whether automation is in use" },
      { item: "Records of deletion for high-sensitivity data with destruction certificates", what_it_tells_you: "Whether disposal is documented for sensitive data" }
    ],
    scoping_notes: "GDPR Art. 17 erasure obligations have specific timelines (one month with possible extension). Operationalising privacy deletion is the hardest part of A.8.10 for most organizations - it requires propagation across primary storage, backups, replicas, analytics, third-party processors. Crypto-erasure (deleting the encryption key for encrypted data) is an increasingly accepted approach for backup deletion at scale.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented information-deletion procedure covering both routine (retention-expiry deletion) and on-request (data-subject erasure, contract end) deletion. Applied across in-scope storage including backups and SaaS. Sample shows deletion was completed and recorded.",
    maturity_ladder: {
      1: "Deletion partial; backups exempt; verification absent",
      2: "Procedures documented; primary deletion verified; DSR process exists",
      3: "Backup and replica deletion covered; DSR timelines met; sensitive deletion documented",
      4: "Automated deletion at scale; crypto-erasure for backups; continuous verification; metrics on DSR fulfilment"
    },
    related_items: ["annex-a.5.33", "annex-a.5.34", "annex-a.7.14"]
  },

  'annex-a.8.11': {
    purpose: "Data masking - masking, anonymisation, pseudonymisation. The techniques that let the organization use data for purposes (testing, analytics, reporting) without exposing it as production data. Particularly important when production data flows to lower environments or to analytics platforms.",
    what_good_looks_like: "Documented position on when masking, anonymisation, or pseudonymisation applies - typically: production data does not flow to test environments without one of these treatments; analytics and BI use pseudonymised or aggregated data where individual identification isn't needed; data shared with third parties for analytical purposes is treated. Technique selected per use case: masking (replacing with realistic but fake values), anonymisation (irreversible, no re-identification), pseudonymisation (reversible only with separately-held key). Re-identification risk assessed honestly - much \"anonymised\" data is actually pseudonymised because re-identification is technically possible. Tooling deployed where volume justifies. Masked / anonymised data tested for utility (the masked test data still supports realistic testing).",
    common_pitfalls: [
      "Masking not used at all - production data flows freely to test environments",
      "Production data in test environments \"because it's the only realistic data we have\"",
      "Weak anonymisation that's actually pseudonymisation - quasi-identifiers leak the identity",
      "Re-identification risk not assessed - claim is \"anonymised\" without analysis",
      "Masking applied at first export but not when data refreshed - gradual leakage as test data is replaced",
      "Third parties given pseudonymised data without contractual restriction on re-identification attempts"
    ],
    evidence_to_look_for: [
      { item: "Masking / anonymisation policy", what_it_tells_you: "Whether the position is documented" },
      { item: "Sample test environment showing masked or synthetic data", what_it_tells_you: "Whether the production-to-test pipeline is governed" },
      { item: "Re-identification risk assessment for one anonymisation use case", what_it_tells_you: "Whether the technique's strength is honestly assessed" },
      { item: "Tooling - masking platform configuration or scripts", what_it_tells_you: "Whether automation is in use at scale" },
      { item: "Third-party data-sharing agreement with re-identification restriction", what_it_tells_you: "Whether downstream re-identification is contractually prohibited" }
    ],
    scoping_notes: "True anonymisation (irreversible) is much harder than commonly claimed - for most realistic datasets, k-anonymity, l-diversity, differential privacy considerations apply, and naive masking leaves reidentification possible. For most organizations, pseudonymisation with strong key separation is more honest than claimed-anonymisation that wouldn't survive a re-identification attack.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: data masking/pseudonymisation is applied where high-classification data flows into lower-trust environments (test/dev, analytics, vendor support). Documented technique appropriate to the use case (tokenisation, format-preserving encryption, masking). Sampled non-prod environment shows masked data.",
    maturity_ladder: {
      1: "Production data flows to test/analytics largely unmasked",
      2: "Policy in place; masking applied to test environments; basic technique selection",
      3: "Risk assessment per use case; tooling at scale; pseudonymisation with key separation",
      4: "Differential privacy or equivalent for analytics; continuous re-identification testing; synthetic data where needed"
    },
    related_items: ["annex-a.5.12", "annex-a.5.34", "annex-a.8.31", "annex-a.8.33"]
  },

  'annex-a.8.12': {
    purpose: "Data Leakage Prevention - detecting and blocking unauthorised movement of sensitive data out of organizational control. The technical implementation of the rules from A.5.14 (information transfer). DLP is the detection-and-enforcement layer that catches what policy and training miss.",
    what_good_looks_like: "DLP coverage across the channels through which data leaves: email, web, endpoint (USB, printing, screen capture, chat-app file uploads), cloud-storage sync, SaaS API. Rules tuned to detect actual sensitive-data patterns - credit-card numbers, government IDs, customer-data signatures, intellectual property markers, classification labels. Aligned with the labelling system (A.5.13) so labelled data drives DLP decisions. Tuning balances protection and operations - alert fatigue and operational disruption are both real failure modes. Alerts triaged by a defined process; high-severity events escalate to incident response. Periodic tuning based on actual data: which rules fired most, which had highest false-positive rate, which were most actionable.",
    common_pitfalls: [
      "DLP deployed but not configured for actual sensitive-data patterns - generic rules catch nothing",
      "Coverage gaps - DLP on email but not on cloud sync, or on endpoint but not on SaaS API",
      "Alert fatigue - analysts dismiss DLP alerts en masse because of high false-positive rate",
      "No triage process - alerts sit in a queue indefinitely",
      "Cloud-native data flows (S3, OneDrive, Dropbox sync) outside DLP coverage",
      "DLP alert volume rising over time without remediation - signal that controls aren't working but no one acts on it",
      "Endpoint DLP deployed but encrypted egress (HTTPS, SSH, encrypted chat) undecrypted and invisible"
    ],
    evidence_to_look_for: [
      { item: "DLP coverage map across channels", what_it_tells_you: "Whether coverage is comprehensive" },
      { item: "DLP rule configuration showing patterns aligned with classification scheme", what_it_tells_you: "Whether rules detect actual sensitive data" },
      { item: "Recent alert triage - how alerts have been handled in the last 30 days", what_it_tells_you: "Whether alerts drive action" },
      { item: "Tuning record - periodic rule review with adjustments based on data", what_it_tells_you: "Whether DLP is calibrated over time" },
      { item: "Integration with classification (A.5.13) - labelled documents drive DLP behavior", what_it_tells_you: "Whether DLP and classification work together" },
      { item: "Cloud and SaaS DLP coverage (CASB, CSPM-DLP)", what_it_tells_you: "Whether modern data flows are addressed" }
    ],
    scoping_notes: "DLP is one of the technologies most prone to over-promising and under-delivering. Realistic expectations: DLP catches inadvertent and opportunistic leakage; determined exfiltration by an insider with technical knowledge typically gets around it. Layered defence (DLP + classification + access control + monitoring) is the only credible approach; DLP alone is theatre.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: data-leakage controls are deployed proportional to risk - email DLP, endpoint DLP, cloud DLP, USB control, restricted upload to unsanctioned services. Detection rules tuned to the organisation's data classifications. Sampled DLP alert was triaged in the last 90 days.",
    maturity_ladder: {
      1: "DLP deployed; configuration generic; alerts ad-hoc",
      2: "Patterns aligned with classification; multi-channel coverage; triage process",
      3: "Cloud and SaaS DLP; tuning based on data; integration with IR; alert fatigue managed",
      4: "DLP integrated with broader data protection (classification, encryption, access); behavioural anomaly; metrics on outcomes"
    },
    related_items: ["annex-a.5.13", "annex-a.5.14", "annex-a.7.10", "annex-a.8.16"]
  },

  'annex-a.8.13': {
    purpose: "The single most important availability and recovery control. Backup is the last line of defence - against hardware failure, human error, malicious deletion, and increasingly ransomware. The control is well understood; the failure modes are well understood; the gap between \"we have backups\" and \"we can recover\" is consistently wider than organizations admit.",
    what_good_looks_like: "A backup policy stating scope (every system that holds in-scope data, including cloud and SaaS), frequency aligned with RPO per system, retention aligned with regulatory and operational needs, protection (encryption at rest, encryption in transit to backup target, access controls). At least one immutable copy - write-once or air-gapped - to defend against ransomware that targets backup systems. Backup credentials and infrastructure separated from production credentials so that compromise of one doesn't compromise the other. Restore tested at planned intervals with real data, not just \"backup completed\" verification - typically a quarterly representative restore plus an annual full DR test. SaaS backup considered explicitly: M365, Google Workspace, Salesforce, GitHub all need backup beyond what the vendor provides natively. Cloud backup considered: snapshots aren't backups; cross-region replication isn't backup.",
    common_pitfalls: [
      "Backup completes successfully every night; restore is never actually tested",
      "Backup credentials co-resident with production - ransomware encrypts the backup tier alongside production",
      "No immutable copy - modern ransomware targets backups first",
      "SaaS data assumed backed up by vendor - Microsoft and Google explicitly state customers are responsible for backup",
      "Cloud snapshots treated as backups - they live in the same account that ransomware compromises",
      "Retention misaligned with regulatory needs - backups deleted before regulator-required retention expires",
      "Recovery procedure exists but ranks low in IR exercises - first ransomware-recovery attempt is in production"
    ],
    evidence_to_look_for: [
      { item: "Backup policy with scope, frequency, retention, protection per system class", what_it_tells_you: "Whether the rules are explicit" },
      { item: "Backup coverage report - every in-scope system and what's backed up", what_it_tells_you: "Whether scope is comprehensive" },
      { item: "Immutable / air-gapped copy evidence", what_it_tells_you: "Whether ransomware-specific defence exists" },
      { item: "Recent restore-test record - actual data restored end-to-end with verification", what_it_tells_you: "Whether backups are usable" },
      { item: "SaaS backup evidence (M365, Google Workspace, GitHub, etc.)", what_it_tells_you: "Whether SaaS data is protected" },
      { item: "Backup credential and infrastructure separation from production", what_it_tells_you: "Whether the blast radius is limited" }
    ],
    scoping_notes: "Modern ransomware specifically targets backup infrastructure. The 3-2-1 rule (three copies, two media, one off-site) has evolved into 3-2-1-1-0 (add one immutable, zero errors verified). Cloud and SaaS data needs explicit treatment - vendor uptime is not vendor backup. Restore-testing cadence and depth is the differentiator between a real backup capability and a paper one.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented backup policy covering scope, frequency, retention, encryption, off-site/immutable copy, and restore-testing cadence. At least one successful restore test in the last 12 months, preferably involving a critical system not just a trivial file.",
    maturity_ladder: {
      1: "Backups happen; restore untested; SaaS unaddressed",
      2: "Policy with scope; restore tested annually; encryption in place",
      3: "Immutable copies; SaaS backup; quarterly representative restores; credential separation",
      4: "Continuous backup verification; DR drills with realistic scenarios; recovery-time metrics improving"
    },
    related_items: ["annex-a.5.30", "annex-a.8.7", "annex-a.8.14"]
  },

  'annex-a.8.14': {
    purpose: "Redundancy of information processing facilities - eliminating single points of failure in the architecture itself, not just relying on backup-and-restore. Where A.8.13 lets you recover from a disaster, A.8.14 lets you avoid the disaster being visible at all. The depth of redundancy is dictated by availability requirements, not by aspiration.",
    what_good_looks_like: "Redundancy design derived from BIA-driven availability requirements. Critical components (load balancers, databases, identity, network egress) have no single point of failure. Geographic distribution where the target RTO and the threat picture justify (regional outage, civil unrest, natural disaster). Cloud workloads use multi-AZ and, where critical, multi-region. Failover is tested under realistic conditions - production-like load, not just \"can it switch.\" Recovery-time and recovery-point measurements during tests vs. design targets. Single points of failure that exist by deliberate design (cost-justified) are documented and accepted.",
    common_pitfalls: [
      "Redundancy claimed in architecture diagrams but never tested under load",
      "Single points of failure exist but aren't identified - first discovery is during an outage",
      "Cloud assumed redundant by default - single-AZ deployments treated as multi-AZ in capacity planning",
      "Region failure scenarios untested - \"what if AWS us-east-1 goes down\" has no operational answer",
      "Redundant components but co-located dependencies (both DBs in the same rack, both DNS resolvers via same upstream)",
      "Identity systems are single points of failure - if AD or Azure AD is down, nothing works"
    ],
    evidence_to_look_for: [
      { item: "Redundancy design tied to availability requirements (RTO/RPO per service)", what_it_tells_you: "Whether redundancy is intentional and calibrated" },
      { item: "Single-point-of-failure analysis with current state", what_it_tells_you: "Whether SPOFs are identified" },
      { item: "Recent failover test under production-like conditions", what_it_tells_you: "Whether redundancy actually works" },
      { item: "Multi-AZ / multi-region configuration for critical cloud workloads", what_it_tells_you: "Whether cloud redundancy is real" },
      { item: "Documented and accepted SPOFs with rationale", what_it_tells_you: "Whether residual risk is explicit" }
    ],
    scoping_notes: "Cloud-native organizations have different redundancy levers - multi-AZ is cheap and standard, multi-region is expensive but increasingly justified for tier-1 services. The control isn't \"have redundancy everywhere\" but \"have redundancy where availability requirements justify it.\" Identity and DNS are commonly under-redundant despite being foundational.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: redundancy is implemented where availability requirements demand it - HA pairs, multi-AZ deployments, load balancers, redundant network paths. Sufficient to meet the documented RTO. Recent failover or HA test in the last 12 months.",
    maturity_ladder: {
      1: "Redundancy partial; SPOFs unknown",
      2: "Critical components redundant; SPOF analysis done; basic failover tested",
      3: "Multi-AZ for critical cloud workloads; failover tested under load; cross-dependency analysis",
      4: "Continuous resilience testing; chaos engineering; multi-region for tier-1; predictive failure modeling"
    },
    related_items: ["annex-a.5.30", "annex-a.7.11", "annex-a.8.6"]
  },

  'annex-a.8.15': {
    purpose: "Logging - the foundation of detection, investigation, and accountability. Without logs, security incidents are unprovable; with bad logs, they're misleading. A.8.15 covers what to log, how to protect logs, how long to keep them, and how to make them useful for analysis.",
    what_good_looks_like: "A logging policy defines what gets logged per system class - at minimum: authentication events, admin and privileged actions, access to sensitive data, configuration changes, security-relevant events (firewall blocks, EDR detections, DLP triggers). Centralised collection - logs aren't useful where they're generated; they need to be aggregated for correlation. Tamper-evident storage - admins can't quietly edit logs to cover their tracks; immutable storage or write-once design. Retention aligned with regulatory and IR needs (typically 12 months minimum for security events, often longer for regulated environments). Time synchronisation (A.8.17) enables correlation. Privacy-aware: not over-collecting PII, with retention limits and access controls aligned with classification (A.5.12). Log access itself is logged.",
    common_pitfalls: [
      "Logs collected but not centralised - stored locally on each system, useful only for that system",
      "Logs writable by admins - admin can edit logs to remove evidence of their own actions",
      "Retention too short for regulatory needs - 30 days when 12 months is required",
      "Logs collected but not analysed - sit in storage; only consulted reactively after an incident",
      "Over-logging creating cost and privacy issues - every keystroke logged, none of it useful",
      "Critical event types missing from collection - admin password resets, role changes, configuration tampering",
      "Cloud and SaaS logs not collected - major blind spot in modern stacks"
    ],
    evidence_to_look_for: [
      { item: "Logging policy defining required events per system class", what_it_tells_you: "Whether the rules are explicit" },
      { item: "Centralised log platform (SIEM, log aggregator) with sources inventory", what_it_tells_you: "Whether collection is centralised and complete" },
      { item: "Tamper-evidence configuration (write-once, immutable storage, separate admin domain)", what_it_tells_you: "Whether logs survive an admin compromise" },
      { item: "Retention configuration matching regulatory and IR requirements", what_it_tells_you: "Whether retention is correct" },
      { item: "Sample log search for an investigation - analyst pulled relevant events end-to-end", what_it_tells_you: "Whether logs are operationally usable" },
      { item: "Cloud and SaaS log coverage (CloudTrail, Azure Activity, M365 Unified Audit, etc.)", what_it_tells_you: "Whether modern surfaces are covered" }
    ],
    scoping_notes: "SIEM is increasingly the practical answer at any meaningful scale. Without one, log analysis is essentially manual and reactive. Cloud-native logging (CloudTrail, Azure Monitor, GCP Audit Logs) needs collection too - these aren't auto-enabled for all event types and aren't retained indefinitely without configuration.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: logs are produced from in-scope systems (identity, endpoints, key apps, network edge, cloud control plane) covering authentication, privileged actions, changes, and security events. Logs are protected from tampering and retained at least 90 days. Log gaps are noticed and investigated.",
    maturity_ladder: {
      1: "Logging partial; centralisation incomplete",
      2: "Policy in place; SIEM or aggregator; required events collected; retention adequate",
      3: "Tamper-evident; cloud and SaaS coverage; access logged; correlation enabled",
      4: "Continuous log integrity verification; advanced analytics; logs feed threat hunting; storage cost optimised"
    },
    related_items: ["annex-a.5.7", "annex-a.8.16", "annex-a.8.17", "annex-a.8.18"]
  },

  'annex-a.8.16': {
    purpose: "Monitoring activities - turning logs into detection. Where A.8.15 collects the data, A.8.16 watches it for things that matter. Without monitoring, logs are forensic-only - useful after an incident, useless during one.",
    what_good_looks_like: "A monitoring strategy aligned with the threat picture and the organization's risk profile. SIEM or equivalent platform correlating logs across sources and producing alerts. Detection use cases mapped to relevant threats - MITRE ATT&CK is the common reference, with detections covering the techniques most likely against the org. Coverage spans on-prem, cloud, SaaS, identity, endpoint. SOC operating model proportionate to risk - full 24/7 SOC for high-risk organizations, business-hours-plus-on-call for medium, MSSP for organizations without in-house capability. Alerts triaged via documented process aligned with A.5.25 (event triage) and A.5.26 (response). Mean time to detect, mean time to respond, false-positive rate measured and improving over time.",
    common_pitfalls: [
      "SIEM deployed with no detection use cases - collecting logs but not generating actionable alerts",
      "Alerts fire but no triage - \"the SOC dashboard is full of alerts; none get worked\"",
      "Coverage gaps - cloud, SaaS, identity logs not in scope despite being where most modern attacks land",
      "Detection only for known signatures; no behavioural detection",
      "No integration with IR - alerts and incidents are separate processes that don't talk to each other",
      "\"Monitoring\" is just dashboards no one watches",
      "MSSP arrangement with poor signal-to-noise ratio; high cost, low value"
    ],
    evidence_to_look_for: [
      { item: "Monitoring strategy aligned with threats and risk", what_it_tells_you: "Whether monitoring is intentional" },
      { item: "Detection use case inventory mapped to MITRE ATT&CK or equivalent", what_it_tells_you: "Whether detection is comprehensive" },
      { item: "Coverage map across on-prem, cloud, SaaS, identity, endpoint", what_it_tells_you: "Whether visibility is broad" },
      { item: "Sample alert from triage to closure", what_it_tells_you: "Whether the operational pipeline works" },
      { item: "MTTD / MTTR / FPR metrics over time", what_it_tells_you: "Whether monitoring is improving" },
      { item: "Integration with IR - alerts trigger IR process when appropriate", what_it_tells_you: "Whether monitoring connects to response" }
    ],
    scoping_notes: "Modern detection is increasingly about identity (anomalous logins, MFA fatigue, OAuth-grant abuse) and cloud (configuration changes, IAM changes, data egress) rather than only network/endpoint. Detection portfolios that focus on traditional surfaces miss most of where modern compromise happens. MSSP value-for-money is highly variable; \"we have an MSSP\" is not the same as \"we have effective monitoring.\"",
    minimum_certifiable: "Smallest version that will still pass Stage 2: centralised logging across in-scope systems (identity, endpoints, key applications, network edge, and the cloud control plane where applicable) with at least 90 days online retention. Alerts configured on a defined set of high-value events (privilege escalation, after-hours admin, mass data export, MFA reset). A triage routine exists and at least one alert per month has been triaged with a written outcome record.",
    maturity_ladder: {
      1: "Monitoring partial; alerts ad-hoc",
      2: "SIEM with use cases; coverage of major surfaces; triage process",
      3: "MITRE-mapped detections; cloud/SaaS/identity coverage; metrics tracked",
      4: "Threat-hunting active; behavioural detection; continuous use-case improvement; outcomes measured"
    },
    related_items: ["annex-a.5.7", "annex-a.5.24", "annex-a.5.25", "annex-a.5.26", "annex-a.8.15"]
  },

  'annex-a.8.17': {
    purpose: "Clock synchronization - keeping system clocks aligned to authoritative time sources. The control most commonly underestimated. Without consistent time, log correlation fails, certificate validation fails, authentication tokens fail, and forensic timelines become unreconstructable. Small problem to solve, large problem when it isn't solved.",
    what_good_looks_like: "Systems synchronised to authoritative time sources via NTP or equivalent, with internal stratum-2 sources synchronised upstream to GPS, atomic, or trusted public stratum-1. Drift monitored - alerts when systems fall outside acceptable tolerance. Configuration consistent across systems for log correlation purposes. Where legal-time matters (regulated activity, audit-trail integrity), traceability to a recognised time source is documented. Internal NTP infrastructure is itself redundant. Cloud workloads use cloud-provider NTP services where available.",
    common_pitfalls: [
      "NTP not deployed consistently - some systems sync, others don't",
      "Clocks drift and no one notices until log correlation fails during an investigation",
      "Public NTP servers used directly with no internal stratum - single-point-of-failure for time",
      "Container and VM workloads inherit time-sync issues from host but aren't checked independently",
      "Legal-time requirements (financial trading, regulated transactions) ignored",
      "Time-zone inconsistencies across regions creating correlation confusion in logs"
    ],
    evidence_to_look_for: [
      { item: "Time-synchronisation architecture - sources, hierarchy, redundancy", what_it_tells_you: "Whether time is governed" },
      { item: "Drift monitoring evidence - recent drift events, alerting", what_it_tells_you: "Whether problems are detected" },
      { item: "Consistency check - sample of systems showing aligned clocks", what_it_tells_you: "Whether sync actually works" },
      { item: "Legal-time traceability where applicable", what_it_tells_you: "Whether regulatory time requirements are met" }
    ],
    scoping_notes: "Five minutes of clock skew on a server is a security incident waiting to happen - Kerberos breaks, certificate validation breaks, tokens reject. Modern clouds and orchestrators handle most time-sync automatically; the remaining gaps are usually legacy systems, niche network devices, and out-of-band management interfaces. The control is small effort, large impact when it fails.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: in-scope systems synchronise time to a documented authoritative source (NTP server, cloud-provider time service). Drift is monitored. Log timestamps across systems are consistent enough to enable correlation.",
    maturity_ladder: {
      1: "NTP partial; drift undetected",
      2: "Consistent NTP across systems; basic monitoring",
      3: "Hierarchical NTP with redundancy; drift alerting; consistency verified",
      4: "Continuous time integrity monitoring; legal-time traceability; multi-source authoritative"
    },
    related_items: ["annex-a.8.15", "annex-a.8.16"]
  },

  'annex-a.8.18': {
    purpose: "Privileged utility programs - system tools that, by design, override or bypass normal controls. Sysinternals, debuggers, packet capture, dump tools, lateral-movement utilities. These are essential for legitimate admin work and are exactly what attackers use after compromise (\"living off the land\"). A.8.18 governs them.",
    what_good_looks_like: "An inventory of privileged utilities permitted on systems, with restrictions on installation and use. Use is logged through endpoint detection or audit policies; PowerShell logging (script block, transcription) is enabled where applicable. Application allowlisting (A.8.19 territory) restricts what can run, including utilities. Where utilities are needed for admin work, they're invoked through controlled paths (PAM session, jump host, time-bounded elevation) rather than installed broadly. Detection use cases cover suspicious utility use - Sysinternals on a non-admin endpoint, packet capture from an unexpected source, mass-scan tools on internal network. EDR rules flag anomalous use.",
    common_pitfalls: [
      "Privileged utilities widely available - Sysinternals on every endpoint, no restrictions",
      "PowerShell unrestricted - running unsigned scripts, no transcription, no logging",
      "Admins use privileged utilities as daily tools, blending legitimate use with potentially malicious in logs",
      "No detection use cases for suspicious utility use - Mimikatz on a workstation goes unflagged",
      "Living-off-the-land techniques (PsExec, WMI for lateral movement) not addressed in detection portfolio"
    ],
    evidence_to_look_for: [
      { item: "Privileged utility policy and inventory", what_it_tells_you: "Whether the org has thought about which tools belong where" },
      { item: "PowerShell logging configuration (script block, transcription, constrained mode where applicable)", what_it_tells_you: "Whether the most-abused utility category is logged" },
      { item: "Detection use cases for suspicious utility use", what_it_tells_you: "Whether abuse is detected" },
      { item: "Sample PAM-mediated utility use", what_it_tells_you: "Whether privileged tools route through controlled paths" }
    ],
    scoping_notes: "Living-off-the-land is now the dominant technique for post-compromise lateral movement and privilege escalation. Detection of privileged utility abuse (PsExec from unusual sources, Mimikatz signatures, BloodHound enumeration patterns, living-off-the-land binaries) is a distinct detection portfolio that complements traditional malware detection.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: use of privileged utility programs (system tools, debuggers, sniffers, admin scripts) is restricted to authorised personnel, controlled by access management, and logged. Inventory exists for the in-scope environment.",
    maturity_ladder: {
      1: "Utilities widely available; use unmonitored",
      2: "Inventory; PowerShell logging; basic restrictions",
      3: "PAM-mediated use; LotL detection use cases; allowlisting",
      4: "Continuous behavioural detection of utility abuse; just-in-time tool elevation; metrics on detected abuse"
    },
    related_items: ["annex-a.8.2", "annex-a.8.16", "annex-a.8.19"]
  },

  'annex-a.8.19': {
    purpose: "Software installation governance - making sure only sanctioned software runs on operational systems. Without controls here, the endpoint security baseline (A.8.1) erodes constantly as users install whatever they want, malware finds easy paths, and the supported-software inventory is fictional.",
    what_good_looks_like: "Software installation controlled through change management (servers, infrastructure) or technical restrictions (endpoints) - typically application allowlisting (Windows AppLocker, WDAC, macOS Gatekeeper, equivalent) or restricted user permissions (no local admin for general users). An approved-software list maintained and reflected in technical enforcement. Self-service software portal where staff can request and install approved software without local admin. Detection of unauthorised software installation through endpoint inventory tools. Legacy applications governed - deprecated software with explicit business justification, time-bounded support, and a removal plan rather than open-ended toleration.",
    common_pitfalls: [
      "Local admin granted to most users - installation is whatever they want",
      "Allowlist deployed but exceptions accumulate - over years the allowlist becomes effectively a small denylist",
      "Approved-software list out of date; stuff that's needed isn't on it; stuff on it isn't needed anymore",
      "Legacy applications with vulnerabilities tolerated indefinitely with no removal plan",
      "Server installations bypass change management - admins install software directly when convenient",
      "Detection of unauthorised installations runs but findings aren't acted on"
    ],
    evidence_to_look_for: [
      { item: "Software installation policy and approved-software list", what_it_tells_you: "Whether the position is documented" },
      { item: "Technical enforcement evidence (allowlisting, restricted local admin, change management for servers)", what_it_tells_you: "Whether enforcement is real" },
      { item: "Recent endpoint inventory comparison - installed software vs. approved", what_it_tells_you: "Whether deviations are detected" },
      { item: "Self-service portal or approval workflow", what_it_tells_you: "Whether legitimate needs have an easy path" },
      { item: "Legacy software register with removal plans", what_it_tells_you: "Whether technical debt is managed" }
    ],
    scoping_notes: "Application allowlisting (especially WDAC on Windows) is the most effective control but operationally demanding to maintain. Restricted local admin is a lower-effort floor that catches most accidental installation. Modern endpoint approaches combine the two with self-service portals to reduce friction.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: installation of software on production systems is controlled via change management, with only approved software installed. Endpoint software installation is restricted (allow-listing, MDM control, admin-only install). Sampled production change shows the control was applied.",
    maturity_ladder: {
      1: "Local admin widely granted; installation uncontrolled",
      2: "Restricted local admin; approved-software list; basic detection",
      3: "Allowlisting on critical roles; self-service portal; legacy register; change management for servers",
      4: "Allowlisting comprehensive; continuous enforcement; legacy debt minimised"
    },
    related_items: ["annex-a.5.32", "annex-a.8.1", "annex-a.8.18"]
  },

  'annex-a.8.20': {
    purpose: "Network security controls - the firewalls, ACLs, IPS/IDS, network device hardening, and network architecture decisions that constitute the perimeter and internal defences. Even in cloud-and-zero-trust era, network controls remain a meaningful layer of defence - and a heavily-sampled control area in audits.",
    what_good_looks_like: "Documented network architecture showing zones, trust boundaries, traffic flows. Firewalls at perimeter and internal segmentation boundaries (links to A.8.22), with rule sets reviewed periodically and exceptions tracked. Network devices hardened to documented baseline (router/switch/firewall configurations); admin access via dedicated management network, MFA-required, logged. ACLs reviewed at least annually with rule-by-rule justification. IPS/IDS where applicable, with detections tuned and integrated with monitoring (A.8.16). Network device configurations under change control with backup. East-west traffic visibility - modern threats are mostly internal pivoting, not perimeter penetration.",
    common_pitfalls: [
      "Flat network - perimeter firewall is the only control; once inside, broad access",
      "Firewall rules accumulate without review; \"any-any\" rules persist from troubleshooting",
      "Network device admin access poorly controlled - telnet, default passwords, shared admin accounts",
      "No review of allowed traffic - old rules for systems decommissioned years ago still active",
      "East-west visibility absent - lateral movement after initial compromise invisible",
      "Cloud network controls (Security Groups, NSGs) treated as separate from on-prem network controls; inconsistent governance"
    ],
    evidence_to_look_for: [
      { item: "Network architecture documentation", what_it_tells_you: "Whether the design is documented" },
      { item: "Firewall rule review record - recent rule-by-rule review with decisions", what_it_tells_you: "Whether rule hygiene is maintained" },
      { item: "Network device hardening configuration aligned with baseline", what_it_tells_you: "Whether infrastructure itself is hardened" },
      { item: "Network device admin access controls - dedicated management, MFA, logging", what_it_tells_you: "Whether admin paths are controlled" },
      { item: "IPS/IDS deployment and recent detection evidence", what_it_tells_you: "Whether network-layer detection works" },
      { item: "Cloud network controls (SGs, NSGs) governance evidence", what_it_tells_you: "Whether cloud network is managed" }
    ],
    scoping_notes: "Cloud-heavy organizations have less traditional network estate but more cloud network configuration (VPCs, subnets, Security Groups, NACLs, peering, transit gateways). The control applies to both - and increasingly the cloud configuration is the bigger surface. Zero Trust architectures shift emphasis from network controls to identity and workload controls but don't eliminate the need for network discipline.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: in-scope networks are managed with documented architecture, segmentation between trust zones (corporate vs. production, guest vs. internal, OT vs. IT where relevant), and change management on network configuration. Network diagrams are current.",
    maturity_ladder: {
      1: "Network controls partial; rule hygiene poor",
      2: "Architecture documented; rules reviewed; device hardening; management access controlled",
      3: "East-west visibility; IPS/IDS integrated with monitoring; cloud network governance",
      4: "Continuous network posture; automated rule lifecycle; micro-segmentation for critical workloads"
    },
    related_items: ["annex-a.8.21", "annex-a.8.22", "annex-a.8.23"]
  },

  'annex-a.8.21': {
    purpose: "Security of network services - applying security thinking to each network service the organization uses (DNS, DHCP, VPN, internet egress, email transport). Often overlooked because these services are infrastructure-by-default, but each is a meaningful attack surface and many are operated by external parties.",
    what_good_looks_like: "Security requirements identified per network service in use. For DNS: protective DNS filtering for outbound resolution, DNSSEC for outbound resolution where supported, monitoring for DNS-tunnelling and beaconing. For VPN: MFA required, modern protocols only (no PPTP, no L2TP/IPsec without modern config), session management. For internet egress: web filtering, TLS inspection where lawful and proportionate, DLP-aware. For email: SPF, DKIM, DMARC published; inbound mail authentication; encryption (TLS in transit, optional message encryption for sensitive). When services are outsourced, security obligations are in agreements (links to A.5.20). Service security is monitored, not just service performance.",
    common_pitfalls: [
      "Assumed secure because vendor-managed - \"we use Cloudflare for DNS, that's secure\" without verifying configuration",
      "VPN deployed but with weak factors and no MFA, or split-tunnel without governance",
      "Email security partial - SPF without DKIM, or DMARC at p=none indefinitely",
      "Protective DNS not deployed - clients resolve directly with no filtering for malicious domains",
      "Service performance monitored but security not - vendor SLA covers uptime, not security",
      "Internet egress unfiltered or unmonitored - outbound is the dominant exfil channel"
    ],
    evidence_to_look_for: [
      { item: "Security requirements per network service in use", what_it_tells_you: "Whether each service has been thought about" },
      { item: "DNS, VPN, email, web-filtering configurations against documented requirements", what_it_tells_you: "Whether configuration matches requirements" },
      { item: "Email-authentication posture (SPF, DKIM, DMARC at enforcement) for sending domains", what_it_tells_you: "Whether email security is real" },
      { item: "Protective DNS or web filtering with recent block/allow data", what_it_tells_you: "Whether outbound is filtered" },
      { item: "Outsourced-service agreements with security obligations", what_it_tells_you: "Whether external services are contractually governed" }
    ],
    scoping_notes: "DMARC at p=quarantine or p=reject is now the expected posture for organizations of consequence; p=none indefinitely is increasingly seen as a finding. Protective DNS (Cloudflare Gateway, Cisco Umbrella, Quad9, etc.) is a high-value, low-cost control increasingly expected. The control is broad - pick the network services in scope and apply security requirements deliberately.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: network services (DNS, NTP, email relay, VPN gateways, web proxies, etc.) have documented security configuration aligned to vendor hardening guidance, with monitoring of their security-relevant events. Sampled service config matches the baseline.",
    maturity_ladder: {
      1: "Network services partly secured; configuration ad-hoc",
      2: "Requirements per service; basic configurations correct; email authentication in place",
      3: "DMARC enforced; protective DNS; VPN modern; service security monitored",
      4: "Continuous service-security posture; vendor performance against security SLAs measured"
    },
    related_items: ["annex-a.5.20", "annex-a.8.20", "annex-a.8.22", "annex-a.8.23"]
  },

  'annex-a.8.22': {
    purpose: "Network segmentation - isolating different risk levels and trust zones from each other so a compromise in one doesn't immediately reach everywhere. Modern attacks succeed in part because flat networks let an initial foothold pivot freely; segmentation breaks that pattern.",
    what_good_looks_like: "Network segmentation reflects risk and data sensitivity: distinct zones for general user, server / production, management, DMZ for internet-facing, OT / IoT for non-IT systems where applicable, payment / cardholder data for PCI scope, guest / BYOD, third-party / vendor access. Inter-zone traffic is explicitly controlled - default-deny with allow rules per documented requirement, with logging. Segmentation documented in architecture diagrams; reviewed periodically. Cloud workloads segmented through VPC / subnet / security group design, not flat. For high-risk workloads (e.g., payment, healthcare data), micro-segmentation increasingly common - host-level enforcement rather than network-level zones.",
    common_pitfalls: [
      "Flat network - claimed segmentation that allows broad inter-segment access in practice",
      "Segmentation designed at deployment but eroded over time as exception rules accumulate",
      "OT / IoT not segregated from corporate network - significant risk in industrial and increasingly in IoT-heavy organizations",
      "Guest networks bridge to internal - \"guest WiFi\" accidentally has internal route",
      "Cloud network design replicates flat-network patterns - single VPC with everything in it",
      "PCI scope not segmented - entire network in scope for PCI assessment, hugely expanding cost"
    ],
    evidence_to_look_for: [
      { item: "Network architecture diagrams showing zones and inter-zone controls", what_it_tells_you: "Whether segmentation is designed" },
      { item: "Inter-zone traffic policy with default-deny and allow rules", what_it_tells_you: "Whether enforcement is real" },
      { item: "Sample inter-zone traffic test - verifying segmentation actually blocks what it should", what_it_tells_you: "Whether segmentation works in practice" },
      { item: "OT / IoT segregation evidence where applicable", what_it_tells_you: "Whether non-IT systems are isolated" },
      { item: "Cloud network segmentation (VPC / subnet / SG design) for major cloud workloads", what_it_tells_you: "Whether cloud follows the same discipline" },
      { item: "Periodic segmentation review", what_it_tells_you: "Whether segmentation is maintained" }
    ],
    scoping_notes: "Segmentation strategy varies - traditional VLAN/firewall zones, modern micro-segmentation (Illumio, Guardicore, NSX), zero-trust network access (ZTNA). The right approach depends on risk and tooling; what matters is that segmentation exists, reflects risk, is enforced, and is maintained. PCI compliance is the canonical case where segmentation is non-negotiable for cost reasons.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: network segregation is implemented between trust zones with explicit allow-rules (deny-by-default), monitored boundary controls (firewalls, NSGs, security groups), and access between zones logged. Sampled rule-base shows least-permissive policy.",
    maturity_ladder: {
      1: "Flat network or claimed segmentation that doesn't enforce",
      2: "Zone-based segmentation; default-deny inter-zone; documented",
      3: "Risk-aligned design; cloud follows same discipline; OT/IoT segregated; periodic verification",
      4: "Micro-segmentation for high-risk workloads; continuous segmentation testing; ZTNA for user access"
    },
    related_items: ["annex-a.8.20", "annex-a.8.21", "annex-a.8.23"]
  },

  'annex-a.8.23': {
    purpose: "Web filtering - blocking outbound connections to malicious or inappropriate destinations. The cheapest and highest-leverage detective and preventive control against opportunistic threats: phishing landing pages, malware downloads, command-and-control beacons, data-exfiltration via cloud-storage abuse.",
    what_good_looks_like: "Web filtering deployed for users on the corporate network AND on managed endpoints when off-network (cloud-based protective DNS or secure web gateway, not just on-premises proxy). Categories blocked by risk: known malware and phishing always; command-and-control and crypto-mining always; high-risk categories (anonymisers, hacking, gambling) tuned to org's risk appetite; productivity-only categories tuned to org's culture. Exceptions documented and time-limited. TLS inspection for traffic into less-trusted categories where lawful and proportionate (privacy and works-council considerations matter). Integration with threat intelligence - newly-discovered malicious domains blocked rapidly. Block events feed monitoring for anomaly patterns.",
    common_pitfalls: [
      "Web filtering only on the corporate-network proxy - roaming endpoints unprotected when not on VPN",
      "Categories blocked too narrowly - only \"adult\" and \"gambling\" while leaving phishing and C2 unblocked",
      "Exceptions accumulate without time-bounding - one team needed access in 2022; the exception is permanent",
      "TLS inspection disabled for \"performance\" - bypasses most modern detection",
      "Block events not analysed for patterns - repeated blocks to the same destination ignored as just noise"
    ],
    evidence_to_look_for: [
      { item: "Web filtering coverage - corporate network and roaming endpoints", what_it_tells_you: "Whether coverage is complete" },
      { item: "Category-blocking policy aligned with risk", what_it_tells_you: "Whether tuning is intentional" },
      { item: "Exception register with time bounds and approvals", what_it_tells_you: "Whether exceptions are governed" },
      { item: "Recent block-event analysis - patterns identified, threats responded to", what_it_tells_you: "Whether the data drives detection" },
      { item: "TLS inspection scope and lawful-basis review", what_it_tells_you: "Whether deep inspection is governed" }
    ],
    scoping_notes: "Modern protective DNS (Cloudflare Gateway, Cisco Umbrella, Quad9) is the cheapest and broadest entry point - works for roaming endpoints, doesn't require certificates, blocks at resolution. Secure web gateways and cloud-based proxies provide deeper inspection at higher cost. The control isn't about specific tools but about whether outbound risk is filtered.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: web filtering is applied to corporate-network and managed-endpoint web traffic to block known-malicious categories and exfiltration patterns. Bypass requires justification. Recent block events triaged.",
    maturity_ladder: {
      1: "Filtering on corporate network only; categories generic",
      2: "Roaming-endpoint coverage; risk-tuned categories; exception register",
      3: "Threat-intel integration; TLS inspection where appropriate; block-event analysis",
      4: "Continuous threat-intel-driven blocking; outcomes measured (blocks correlated to incidents prevented)"
    },
    related_items: ["annex-a.5.7", "annex-a.8.7", "annex-a.8.20", "annex-a.8.21"]
  },

  'annex-a.8.24': {
    purpose: "Cryptography - the policies and practice that determine which algorithms, key lengths, and key-management approaches the organization uses, and how that holds up over time as standards evolve. Cryptography is one of the few areas where today's good is tomorrow's bad; the control needs evolution baked in.",
    what_good_looks_like: "A documented cryptography policy covering: approved algorithms and minimum key lengths (current standards - AES-256-GCM for symmetric, RSA-3072 / ECDSA P-256 minimum for asymmetric, SHA-256 minimum for hashing, bcrypt / argon2 for password hashing), use cases (data at rest, in transit, signing, hashing, MAC), and explicitly deprecated algorithms (SHA-1, RSA-1024, MD5, DES, 3DES). Key management lifecycle - generation in approved sources (HSM, cloud KMS), storage protected (HSM, KMS, vault - never in code or config), distribution governed, rotation cadence per use case, destruction procedure. Encryption applied per classification: data at rest for sensitive classifications, in transit for everything internal-or-external, end-to-end where the threat picture justifies. The policy is reviewed against evolving standards - post-quantum readiness is now a topic for any organization with long-lived secrets.",
    common_pitfalls: [
      "Weak or deprecated algorithms in active use - SHA-1 in legacy systems, RSA-1024, weak TLS ciphers",
      "Keys in code or configuration files - committed to repositories, copied to CI variables, hardcoded",
      "No rotation - long-lived keys with no end-of-life",
      "HSM or KMS not used - cryptographic keys stored as files with filesystem permissions only",
      "Cryptographic agility absent - no plan for migration when an algorithm becomes weak (post-quantum is the looming case)",
      "Encryption configured but not verified - TLS \"in use\" but accepting weak ciphers and old protocols"
    ],
    evidence_to_look_for: [
      { item: "Cryptography policy with approved and deprecated algorithms", what_it_tells_you: "Whether the rules are explicit" },
      { item: "Key-management implementation evidence (HSM, KMS, vault) for sensitive keys", what_it_tells_you: "Whether keys are protected" },
      { item: "Rotation evidence - recent rotations per documented cadence", what_it_tells_you: "Whether lifecycle works" },
      { item: "TLS configuration audit - current ciphers and protocols accepted", what_it_tells_you: "Whether transit encryption is strong" },
      { item: "Inventory of cryptographic uses across the organization", what_it_tells_you: "Whether the org knows where crypto lives" },
      { item: "Post-quantum or crypto-agility position", what_it_tells_you: "Whether evolution is planned" }
    ],
    scoping_notes: "NIST SP 800-131A and similar references provide current and projected algorithm-strength guidance. Post-quantum cryptography is moving from research to standardisation (NIST PQC standards finalised 2024). For organizations with long-lived secrets (records expected to remain confidential beyond 2030), beginning crypto-agility planning is increasingly expected. For most organizations, the practical gap is key management, not algorithm choice - keys in vaults or HSMs, rotated, governed.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: cryptography is governed by a policy covering algorithms, key lengths, key lifecycle (generation, distribution, rotation, revocation, destruction), and approved use cases. Implementation aligned to current industry guidance (no MD5, no SHA-1 for signatures, TLS 1.2 minimum). Sampled key has a rotation record.",
    maturity_ladder: {
      1: "Cryptography ad-hoc; deprecated algorithms in use",
      2: "Policy with approved algorithms; major use cases addressed; basic key management",
      3: "HSM/KMS for sensitive keys; rotation operational; TLS hardened; inventory maintained",
      4: "Crypto-agility plan; post-quantum readiness; continuous validation against standards"
    },
    related_items: ["annex-a.5.10", "annex-a.5.14", "annex-a.5.17", "annex-a.8.5"]
  },

  'annex-a.8.25': {
    purpose: "Secure development lifecycle - embedding security into the development process from requirements through release rather than treating it as a pre-release pen-test. The umbrella control for software-producing organizations; it's where A.8.26-8.30 fit together. The audit test isn't \"do you have a document\" - it's \"sample one feature shipped in the last 90 days and trace the security activities at every phase.\" If any link in the chain (threat model, design review, SAST run, security gate sign-off) is missing for that one feature, you have a finding, regardless of how nice the SDL document is.",
    what_good_looks_like: "A documented Secure Development Lifecycle (Microsoft SDL, OWASP SAMM, NIST SSDF, BSIMM, or organization-specific) of 5-15 pages with security activities embedded at each phase: requirements (security requirements, threat modelling), design (secure design review, architecture review against principles A.8.27), implementation (secure coding standards A.8.28, peer review with security checklist), verification (SAST in CI, SCA for dependencies, DAST in staging, security testing A.8.29), release (security gate, deployment validation), maintenance (post-release monitoring, vulnerability response). Developer security training at hire and annually with role-tailored content - frontend devs get XSS / CSRF / supply-chain, backend devs get authn / authz / injection, platform devs get IaC / secrets / IAM. Tooling for static, dynamic, and dependency analysis integrated into CI/CD with break-build thresholds on critical findings. Two metrics tracked at minimum: time from security finding to fix by severity, and percentage of releases that passed the security gate without an override. Backed by clear ownership - typically a security champions network (1 per ~10 devs) plus a dedicated AppSec function once the org exceeds 30-40 developers.",
    common_pitfalls: [
      "Ad-hoc security - varies by team, by project, by individual. The classic Stage 2 finding: two engineers describe the SDL differently",
      "\"Shift left\" claimed but no actual phase integration - security is still pre-release-only and the threat-model column on the design doc template is always empty",
      "Security gates that don't gate - failures override-able by anyone with a Jira comment saying \"will fix after launch\"",
      "No measurement - \"we have an SDL\" with no metrics on whether it's followed or working. Auditor asks for the override report; there isn't one",
      "Security tooling deployed but findings not actioned - SAST backlog has 4000 items, oldest from 18 months ago; nothing happens",
      "Developer training one-time at hire, never refreshed, and not role-tailored. The frontend devs got the same training as the platform team",
      "Threat modelling claimed but not done in practice - the auditor asks for the threat model for last quarter's biggest feature and it doesn't exist"
    ],
    evidence_to_look_for: [
      { item: "Documented SDL or SSDF aligned framework", what_it_tells_you: "Whether the lifecycle is defined" },
      { item: "Phase-by-phase activity evidence - sample project showing security activities at each stage", what_it_tells_you: "Whether the SDL is followed" },
      { item: "Tooling integration in CI/CD (SAST, SCA, DAST, IaC scanning)", what_it_tells_you: "Whether automation backs the process" },
      { item: "Developer security training records and tailoring", what_it_tells_you: "Whether developers are equipped" },
      { item: "Metrics on SDL adherence and outcomes", what_it_tells_you: "Whether the process is measured" },
      { item: "Security champions network or dedicated AppSec resourcing", what_it_tells_you: "Whether ownership exists" }
    ],
    scoping_notes: "OWASP SAMM and NIST SSDF are the two practical reference frameworks. SSDF (NIST 800-218) is increasingly expected for organizations developing software for US federal customers and is becoming the industry baseline. The control is heavy on documentation but the audit test is whether the documented process actually drove what happened on a recent release.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented secure development lifecycle covering security activities at each stage - requirements, design (threat modelling), implementation (secure coding standards, code review), testing (SAST/SCA/DAST at minimum), and release (security sign-off). Applied to at least the in-scope applications. Sampled recent release shows the activities were performed and findings closed. Where development is not done in-house, the SoA records the applicability decision with reference to supplier controls.",
    maturity_ladder: {
      1: "Security tacked on at end of release",
      2: "SDL documented; activities defined per phase; tooling in CI",
      3: "Activities measured; developer training; security champions; gates enforced",
      4: "Continuous security-in-development; metrics drive program; security debt actively reduced"
    },
    related_items: ["annex-a.5.8", "annex-a.8.26", "annex-a.8.27", "annex-a.8.28", "annex-a.8.29", "annex-a.8.30"]
  },

  'annex-a.8.26': {
    purpose: "Application security requirements - defining upfront, before build, what security each application must provide. Without explicit requirements, security shows up at the end as findings rather than at the start as design constraints. Cost of fixing security issues at design is orders of magnitude lower than at release.",
    what_good_looks_like: "Security requirements are defined as part of every project's requirements gathering - covering authentication, authorization, session management, encryption (at rest, in transit), input validation, output encoding, error handling, logging, secrets management, abuse-case prevention. Requirements derived from data classification (A.5.12), threat model (A.8.25), regulatory obligations (A.5.31), and architectural principles (A.8.27). Approved before build by both project leadership and security function. Verified before release through testing (A.8.29). Updated on material change to scope or threat picture.",
    common_pitfalls: [
      "Requirements vague - \"must be secure\" rather than concrete (e.g., \"authentication must support SSO via SAML 2.0 and require MFA for admin actions\")",
      "Security requirements only added at end when pen test or AppSec review surfaces gaps",
      "Not approved formally - \"discussed\" rather than signed off",
      "Not verified before release - assumption that requirements were met without testing",
      "Not updated on material change - requirements set at v1.0 don't reflect v3.0's threat model"
    ],
    evidence_to_look_for: [
      { item: "Security requirements template or checklist", what_it_tells_you: "Whether requirements are structured" },
      { item: "Sample project security requirements approved before build", what_it_tells_you: "Whether timing is right" },
      { item: "Verification evidence - pre-release confirmation that requirements are met", what_it_tells_you: "Whether requirements actually gate release" },
      { item: "Update record showing requirements evolved during the project lifecycle", what_it_tells_you: "Whether requirements are alive" }
    ],
    scoping_notes: "OWASP ASVS (Application Security Verification Standard) is the practical reference for what application security requirements look like at three maturity levels. Using ASVS as the requirements framework provides immediate structure and credibility. The control is most effective when paired with threat modelling - generic requirements miss application-specific risks.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: application security requirements (authentication, authorisation, input validation, output encoding, logging, error handling) are documented as part of design/requirements for in-scope applications. Sampled in-scope application has the requirements traceable to design or backlog.",
    maturity_ladder: {
      1: "Requirements implicit; security at end",
      2: "Requirements documented per project; approved before build; verified before release",
      3: "ASVS or equivalent applied; threat-model-driven; updated on change",
      4: "Continuous requirement evolution; metrics on requirement coverage; integrated with risk and threat intel"
    },
    related_items: ["annex-a.5.12", "annex-a.5.31", "annex-a.8.25", "annex-a.8.27", "annex-a.8.29"]
  },

  'annex-a.8.27': {
    purpose: "Secure architecture and engineering principles - the set of principles that should govern how systems are designed and built. Defense in depth, least privilege, secure defaults, fail-secure, separation of duties, complete mediation. Without explicit principles, architecture decisions are made case-by-case and the cumulative effect is inconsistent and often weak.",
    what_good_looks_like: "Documented architectural principles drawn from established sources (Saltzer & Schroeder, OWASP, cloud-provider well-architected frameworks). Principles applied during design reviews - the design review explicitly checks against the principle list. Deviations from principles are formally approved with rationale and time-bounding. Principles updated as the threat picture and technology base evolves - cloud-native principles (IAM-first, infrastructure-as-code, immutable infrastructure) are part of the modern set. Architecture review is a real gate for projects of meaningful size or risk.",
    common_pitfalls: [
      "Principles in policy but not in design reviews - the principles document exists but no one references it during architecture decisions",
      "Deviations granted without approval - \"we'll come back to it\" with no record",
      "Cloud architecture treated as an exception - traditional principles applied to traditional infra, modern decisions made without principles",
      "Architecture review absent or rubber-stamp - no design challenge",
      "Principles never updated - list reflects 2010 thinking, ignores cloud, microservices, serverless considerations"
    ],
    evidence_to_look_for: [
      { item: "Documented architectural principles", what_it_tells_you: "Whether principles are articulated" },
      { item: "Sample architecture review showing principles applied", what_it_tells_you: "Whether principles drive decisions" },
      { item: "Deviation register with approvals and time-bounding", what_it_tells_you: "Whether exceptions are governed" },
      { item: "Recent principles update reflecting cloud / modern architecture considerations", what_it_tells_you: "Whether principles are alive" }
    ],
    scoping_notes: "Cloud-provider well-architected frameworks (AWS, Azure, GCP) provide ready-made architectural principle sets that map to ISO 27001 thinking. For organizations using these clouds, adopting the framework as the principle reference is pragmatic. The control isn't about inventing principles but about applying a credible set deliberately.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: secure-architecture and engineering principles (defence in depth, least privilege, secure defaults, fail-safe, separation of duties) are documented and applied to system design. Architecture-review or threat-modelling evidence exists for at least one in-scope system.",
    maturity_ladder: {
      1: "Principles informal",
      2: "Documented principles; applied in design reviews",
      3: "Deviation governance; cloud-native principles; periodic update",
      4: "Continuous architecture review; principles drive automated guardrails (IaC checks, policy-as-code)"
    },
    related_items: ["annex-a.5.8", "annex-a.8.25", "annex-a.8.26"]
  },

  'annex-a.8.28': {
    purpose: "Secure coding - the discipline of writing code that doesn't introduce common vulnerabilities (injection, broken auth, broken access control, XSS, deserialization, server-side request forgery). Most application vulnerabilities originate in coding decisions; this control ensures developers know how to avoid them.",
    what_good_looks_like: "Secure coding standards documented per language and framework in significant use - typically based on OWASP guidance, language-specific best practices, and organization-specific patterns. Developers trained at hire and at least annually, with role-specific content (web developers learn web app security; backend developers learn API security; mobile developers learn mobile-specific). Code review by peers includes a security checklist or guided review prompts. SAST integrated into CI runs on every commit; SCA scans dependencies on every build; both produce findings into the developer's workflow rather than separate dashboards. Findings tracked to remediation. Secure-coding metrics inform training updates - recurring vulnerability classes drive training emphasis.",
    common_pitfalls: [
      "Standards exist but not enforced - code that violates standards passes review",
      "Training delivered once at hire, never refreshed",
      "SAST deployed but findings ignored - backlog grows; integration with developer workflow absent",
      "Coverage gaps - SAST runs on main app but not on internal tools, helper services, infrastructure code",
      "Code review focused on style and correctness, security as an afterthought",
      "Recurring vulnerability classes not analysed - same SQL injection appears across projects with no broader response"
    ],
    evidence_to_look_for: [
      { item: "Secure coding standards per language", what_it_tells_you: "Whether standards exist" },
      { item: "Developer training record with role tailoring", what_it_tells_you: "Whether developers are equipped" },
      { item: "Code review checklist with security items", what_it_tells_you: "Whether review covers security" },
      { item: "SAST integration in CI with findings reaching developer workflow", what_it_tells_you: "Whether tooling is operational" },
      { item: "Vulnerability-class analysis - recurring patterns drive training updates", what_it_tells_you: "Whether the loop closes" }
    ],
    scoping_notes: "OWASP Top 10 and CWE Top 25 are the practical reference for what to focus on. Modern AppSec increasingly emphasises developer experience - findings in the IDE / pull request / IM are far more actionable than findings in a separate dashboard.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: secure-coding standards are documented (referencing OWASP ASVS or language-specific guides), developers are trained, code is reviewed before merge, and SAST/DAST tooling runs on the pipeline. Recent code-review and SAST findings closure evidence.",
    maturity_ladder: {
      1: "Secure coding informal",
      2: "Standards documented; training annual; SAST in CI; review covers security",
      3: "Findings reach developer workflow; remediation tracked; vulnerability classes analysed",
      4: "Continuous secure-coding feedback; metrics drive training and tooling; security debt actively reduced"
    },
    related_items: ["annex-a.5.32", "annex-a.8.4", "annex-a.8.25", "annex-a.8.29"]
  },

  'annex-a.8.29': {
    purpose: "Security testing in development and acceptance - the layered testing program that finds vulnerabilities before release. SAST, DAST, SCA, IaC scanning, manual penetration testing, bug bounty for mature programs. Each layer catches different things; the combination is the control.",
    what_good_looks_like: "A documented testing strategy with layers calibrated to risk: SAST on every commit; SCA for dependencies on every build with build-failure on critical findings; DAST on staging environments before release; IaC scanning before infrastructure changes apply; penetration testing periodically (annual minimum, before major release, on material change) with scope reflecting current architecture; bug bounty for mature programs with public attack surface. Findings tracked to remediation with SLAs by severity. Pen test findings drive code fixes, not just compensating controls. Critical findings block release; lesser findings track to backlog with risk-acceptance decisions documented. Testing scope evolves with architecture - cloud and container testing addressed, not just traditional web app pen testing.",
    common_pitfalls: [
      "Penetration testing once a year, findings filed and forgotten",
      "SAST results never reviewed - \"it runs but no one looks\"",
      "DAST disabled or run rarely - \"it's flaky\"",
      "No remediation SLA - findings sit indefinitely",
      "Testing scope mismatched with architecture - pen test of monolith for an organization that's now mostly microservices and cloud",
      "Findings compensating-controlled rather than fixed - \"we'll add a WAF rule\" instead of fixing the underlying issue",
      "No testing of cloud configuration, IaC, or container images"
    ],
    evidence_to_look_for: [
      { item: "Testing strategy with layered approach", what_it_tells_you: "Whether testing is intentional" },
      { item: "SAST / SCA / DAST integration evidence", what_it_tells_you: "Whether automation is real" },
      { item: "Recent penetration test report with scope, findings, remediation status", what_it_tells_you: "Whether pen testing is operational" },
      { item: "Findings register with SLAs and remediation evidence", what_it_tells_you: "Whether findings drive fixes" },
      { item: "Cloud and container testing coverage", what_it_tells_you: "Whether modern surfaces are addressed" }
    ],
    scoping_notes: "Pen testing once a year is the floor for any meaningful product. For organizations with continuous deployment, pen testing should align with material changes rather than calendar dates alone. Bug bounty is high-leverage for organizations with public attack surface but operationally demanding; not appropriate for early-stage programs.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: security testing is performed during the development lifecycle - at minimum SAST, dependency/SCA scanning, and a pre-release security review. Penetration testing on internet-facing or high-impact applications at least annually. Findings tracked to closure.",
    maturity_ladder: {
      1: "Pen test annual; SAST partial",
      2: "Layered testing; findings tracked; SLAs by severity",
      3: "Cloud/container testing; pen test aligned with releases; bug bounty for mature programs; pen findings drive code",
      4: "Continuous security testing; outcomes-driven; findings prevention measured"
    },
    related_items: ["annex-a.8.8", "annex-a.8.25", "annex-a.8.26", "annex-a.8.28"]
  },

  'annex-a.8.30': {
    purpose: "Outsourced development - when the organization contracts development work to external parties. Code from a third party that runs in your stack carries the third party's security practices into your environment; without governance, you inherit their gaps.",
    what_good_looks_like: "Contracts require security practices equivalent to the organization's SDLC: secure coding standards, security testing, vulnerability remediation SLAs, incident notification, IP and confidentiality obligations. Deliverables verified by the organization before acceptance - code review, security testing, sometimes independent assessment. Supplier development practice assessed periodically (questionnaire, audit, evidence requests). Access to organizational systems and repositories governed - supplier developers have time-bounded credentials, scoped access, MFA, audit trail. Security findings on outsourced code drive supplier improvement, not just point-fixes. For organizations using outsourced development heavily, supplier-development risk is a tracked risk in the register.",
    common_pitfalls: [
      "Outsourcer trusted blindly - \"they're a known firm, they know what they're doing\" without verification",
      "No verification of supplier security practices - questionnaire-only at contract signing, never reviewed",
      "Deliverables shipped to production with minimal review",
      "Supplier developers given broad standing access to repositories and infrastructure",
      "IP and confidentiality protected on paper but breached operationally - supplier devs use personal devices, store code on personal cloud",
      "Findings on outsourced code patched once but no feedback to supplier; same issues recur on next deliverable"
    ],
    evidence_to_look_for: [
      { item: "Contract template with security clauses for outsourced development", what_it_tells_you: "Whether the legal foundation exists" },
      { item: "Verification process - sample deliverable acceptance with security review evidence", what_it_tells_you: "Whether verification is real" },
      { item: "Supplier development assessment evidence", what_it_tells_you: "Whether supplier practices are checked" },
      { item: "Supplier developer access governance - time-bounded credentials, scoped access, MFA", what_it_tells_you: "Whether access is controlled" },
      { item: "Findings feedback to supplier with remediation tracking", what_it_tells_you: "Whether the loop closes back to the supplier" }
    ],
    scoping_notes: "Outsourced development is where many supply-chain risks sit - code that became part of your product carrying vulnerabilities from a third party's practices. The control connects to A.5.19-22 (supplier relationships) and A.8.25 (your SDLC). For organizations with significant outsourced-development exposure, treating supplier practices with the same rigor as internal SDLC is essential.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: outsourced development arrangements have security clauses (secure-coding standards, vulnerability disclosure, source-code escrow if applicable, right-to-test, incident notification), and the supplier's output is tested before deployment as if internally developed. SoA records applicability where this control does not apply.",
    maturity_ladder: {
      1: "Outsourcer trusted; verification ad-hoc",
      2: "Contract clauses; deliverable review; basic access controls",
      3: "Supplier assessment; findings feedback loop; access governance equivalent to internal devs",
      4: "Continuous supplier development monitoring; supplier security posture tracked over time"
    },
    related_items: ["annex-a.5.19", "annex-a.5.20", "annex-a.5.21", "annex-a.8.25"]
  },

  'annex-a.8.31': {
    purpose: "Separation of development, test, and production environments. Without separation, changes can reach production untested, production data leaks into less-controlled environments, and credentials cross trust boundaries. The control is foundational and surprisingly often weak in practice.",
    what_good_looks_like: "Development, test, staging, and production environments are logically separated and ideally on separate infrastructure or at minimum in separate cloud accounts/projects/subscriptions. Promotion between environments goes through controlled CI/CD with appropriate approvals. Access differs by environment - developers have broad access in dev, restricted in test, narrow read-only or none in prod. Credentials are environment-specific and don't cross boundaries. Production data is not used in lower environments unmasked (links to A.8.11 data masking). Network paths between environments are controlled and minimal. Each environment has its own secrets, its own keys, its own monitoring.",
    common_pitfalls: [
      "Shared accounts across environments - same AWS account hosts dev, test, and prod with weak boundaries",
      "Production data routinely copied to test for \"realistic testing\" with no masking",
      "Promotion bypasses change management - direct deployment from dev workstation to prod",
      "Developer accidentally has production write access - least-privilege failure",
      "Credentials shared across environments - same database password works in dev and prod",
      "Lower environments less hardened - patching, logging, monitoring weaker, but networked to production"
    ],
    evidence_to_look_for: [
      { item: "Environment architecture documentation showing separation", what_it_tells_you: "Whether separation is designed" },
      { item: "Promotion / deployment process through CI/CD with approvals", what_it_tells_you: "Whether changes flow through controlled paths" },
      { item: "Access matrix per environment - different access levels", what_it_tells_you: "Whether access is segregated" },
      { item: "Production-data-in-test policy and masking evidence", what_it_tells_you: "Whether data leakage is prevented" },
      { item: "Credential separation - environment-specific secrets", what_it_tells_you: "Whether trust boundaries are real" }
    ],
    scoping_notes: "Cloud account / subscription / project separation is the modern strong form - entirely different blast radius per environment. Within-account separation via VPCs, security groups, and IAM is weaker but workable for organizations starting from a single account. Production data in test is one of the most common audit findings - mask, anonymise, or use synthetic data, but production-data-in-test without controls is increasingly unacceptable.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: development, test, and production environments are separated with controlled promotion between them, separate credentials, and no production data in lower environments without masking. Sampled change shows the separation held.",
    maturity_ladder: {
      1: "Separation partial; production data flows freely",
      2: "Separate environments; CI/CD promotion; basic access differentiation",
      3: "Separate cloud accounts/projects; production data masked; credentials per-env",
      4: "Continuous environment-isolation testing; ephemeral environments; chaos-style separation validation"
    },
    related_items: ["annex-a.8.3", "annex-a.8.11", "annex-a.8.32", "annex-a.8.33"]
  },

  'annex-a.8.32': {
    purpose: "Change management - the process that controls how changes are introduced to production systems. Distinct from clause 6.3 (planning ISMS-level changes); A.8.32 is operational change management for IT and security-relevant changes. Bad change management is one of the most common causes of self-inflicted incidents.",
    what_good_looks_like: "A documented change-management process with categories - standard (pre-approved, low-risk, repeatable), normal (assessed and approved per change), emergency (expedited path with retrospective review). Per change: risk assessment, testing requirements, approval per category, deployment window, rollback plan, post-implementation verification. Standard changes pre-approved through documented templates; normal changes go through CAB or equivalent for higher-risk; emergency changes expedited but reviewed retrospectively to confirm they were legitimately emergencies. Change records kept. Integration with vulnerability management (patches as changes), incident management (changes triggered by incident response), and supplier management (supplier-driven changes). Failed changes analysed for pattern.",
    common_pitfalls: [
      "Change management for IT but not for security - security changes (firewall rules, access changes, configuration baselines) follow a separate weaker process or no process",
      "Emergency changes never reviewed retrospectively - emergency becomes routine",
      "Testing skipped under deadline pressure - production is the test environment",
      "No rollback plan - changes that fail can't be reversed cleanly",
      "Standard-change list out of date - pre-approved templates for things that have changed materially",
      "Change records superficial - hard to reconstruct what was actually done after the fact",
      "Cloud / IaC changes treated as outside change management - \"it's just terraform\""
    ],
    evidence_to_look_for: [
      { item: "Change-management process document with categories", what_it_tells_you: "Whether the process is defined" },
      { item: "Sample changes from each category showing risk assessment, approvals, testing, rollback", what_it_tells_you: "Whether the process is followed" },
      { item: "Emergency-change retrospective review records", what_it_tells_you: "Whether emergency abuse is caught" },
      { item: "Failed-change analysis", what_it_tells_you: "Whether learning happens" },
      { item: "Cloud / IaC changes integrated into change management", what_it_tells_you: "Whether modern paths are governed" }
    ],
    scoping_notes: "ITIL provides the canonical change-management framework but is heavyweight. Modern DevOps shifts emphasis from approval-gates to automated testing and rapid rollback - both are valid as long as the controls match the risk. The audit test is whether changes are deliberate, traceable, reversible, and reviewed after the fact. Whatever framework you use, those four properties are non-negotiable.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented change-management process for IT/security changes - impact assessment, approval, testing, rollback plan, scheduling, post-change verification. Sampled production change in the last 90 days has the full trail.",
    maturity_ladder: {
      1: "Change management partial; emergency abuse common",
      2: "Process documented with categories; CAB for higher-risk; rollback plans",
      3: "Cloud/IaC integrated; emergency retrospective; failed-change analysis",
      4: "Continuous change validation; automated guardrails; metrics on change-driven incidents declining"
    },
    related_items: ["clause-6.3", "annex-a.5.22", "annex-a.8.8", "annex-a.8.9", "annex-a.8.31"]
  },

  'annex-a.8.33': {
    purpose: "Test information - the data used in test environments. The control limits the use of production data in test, requires masking or restriction when production data is unavoidable, and ensures test environments don't become a backdoor to sensitive data through weaker controls. This is one of the most-found and least-fixed Annex A issues - the auditor will pull the test database directly, sample 5 rows, and ask whether each row corresponds to a real customer. If the answer is yes and the data isn't masked, it's an instant finding. Pairs with A.8.11 (data masking) and A.8.31 (environment separation).",
    what_good_looks_like: "A documented position - 1-2 pages, signed off at CISO or equivalent: production data is not used in test environments unless masked or anonymised (links to A.8.11), with limited and approved exceptions. When production data is genuinely unavoidable (e.g., debugging a production-specific issue), access to the test environment for that specific use is restricted to the same group authorised for production access for the relevant data, time-bounded to no more than 14 days, and the data is removed when the work concludes (with evidence of removal logged). Test environments hold data classified per the highest-classification data they hold - if test contains anything derived from Confidential production data, the test environment is governed at Confidential level for access, encryption, monitoring. Test data lifecycle managed: refreshed periodically (typically quarterly), anonymised before persistent storage, disposed when no longer needed. A tracking record of which test environments hold which production-derived data and when it expires, reviewed monthly.",
    common_pitfalls: [
      "Production data routinely copied to test for \"realistic testing\" with no masking, no access restriction, no time-bounding. This is the #1 cited finding in this control across real audits",
      "\"Anonymisation\" that's actually pseudonymisation - names removed but quasi-identifiers leak the identity. DOB + postcode + gender re-identifies ~87% of the US population (Sweeney 2000); this still trips orgs in 2026",
      "Test data accumulates indefinitely - original copy from 2019 still in the test database in 2026. The auditor will run a query for oldest record timestamp; if the year is two-plus before today, it's a finding",
      "Test environments less hardened than production despite holding similar-classification data - patching slower, monitoring weaker, access broader. Test gets breached more often than prod for this exact reason",
      "Developers query production directly from local machines for debugging, then results sit on the local machine indefinitely with no controls",
      "Synthetic data generators (Mockaroo, Faker, Gretel, AI-generated) not used despite being available and good enough for ~80% of test purposes - the org never tried because \"production data is faster\"",
      "Recovery snapshots of production restored into test environments for performance testing - all the data, none of the access controls. The recovery use case is the most-overlooked path"
    ],
    evidence_to_look_for: [
      { item: "Position on production data in test (policy or design document)", what_it_tells_you: "Whether the org has thought about this" },
      { item: "Sample test environment showing masked, anonymised, or synthetic data", what_it_tells_you: "Whether the position is followed" },
      { item: "Approval and time-bounding for any current production-data-in-test exception", what_it_tells_you: "Whether exceptions are governed" },
      { item: "Test environment access controls aligned with the data classification it holds", what_it_tells_you: "Whether test environments inherit appropriate protection" },
      { item: "Test data lifecycle evidence - refresh and disposal", what_it_tells_you: "Whether data doesn't persist indefinitely" }
    ],
    scoping_notes: "Synthetic data generators (Mockaroo, Faker, AI-generated synthetic) handle most testing needs without using production data at all. Where realistic data is genuinely needed, masking is the practical answer. The control connects tightly to A.8.11 (the masking technique itself) and A.8.31 (environment separation that makes the control meaningful). Production data in test is one of the most-cited findings in real audits.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented position on the use of production data in test environments - either prohibited (synthetic/masked data only) or permitted with documented controls (approval, masking, time-bounding, equivalent protection). Sampled non-production environment shows the position is followed. Where production data is used, the masking technique is documented.",
    maturity_ladder: {
      1: "Production data flows to test unmasked",
      2: "Position documented; masking applied; exceptions tracked",
      3: "Synthetic data preferred where suitable; test environments governed at the data's classification level",
      4: "Continuous test-data governance; minimal production-data-in-test; metrics on test-data lifecycle"
    },
    related_items: ["annex-a.5.12", "annex-a.8.11", "annex-a.8.31"]
  },

  'annex-a.8.34': {
    purpose: "Protection of information systems during audit testing - making sure that audits, security testing, and similar inspection activities don't themselves compromise the systems being audited. The control covers scope agreement, timing, scope creep prevention, and clean-up after the audit concludes. Often missed because audits are seen as low-risk; in practice, audit credentials and audit traffic are routine sources of real incidents - pen-test queries have crashed production databases, audit data extraction has triggered DLP alerts that fed back into customer comms, and audit credentials that nobody revoked have been the entry point for follow-on attacks 6-12 months later.",
    what_good_looks_like: "Scope and timing of any audit testing on operational systems is agreed in advance with system owners via a rules-of-engagement document - what will be tested, how, when, by whom, with what access, what stop conditions apply, escalation paths if something breaks. Activities likely to disrupt are scheduled for off-peak windows or run against representative test environments where feasible. Audit credentials are time-bounded - issued for the audit period only, with an automatic expiry that doesn't require manual revocation. Audit access is logged in a way that's distinguishable from real user activity (separate user-ID convention, IP allowlist, tagged session) so monitoring teams can filter audit traffic from genuine alerts during the engagement. After the engagement: credentials revoked within 24 hours of close, access logs reviewed against the agreed scope (any out-of-scope queries get flagged back to the auditor), testing tools left no residue (no agents running, no cached credentials, no orphan accounts). The same template applies to internal-audit, external-assessor, regulator, customer-audit, and pen-test activities - the differences are in the rules-of-engagement detail, not the framework.",
    common_pitfalls: [
      "Auditors given broad standing access \"to make their work easier\" - credentials persist long after the audit ends. The audit account becomes the lateral-movement target for the next attacker",
      "Audit testing causes production incidents - pen test sends a million test connections and exhausts the connection pool; data extraction script overwhelms a database. Cited in real post-mortems",
      "No agreement on scope and timing - auditors decide what to test once they're in. Stage 2 finding: the pen-test report shows testing against systems that the engagement letter never named",
      "Audit credentials don't get revoked - six months later, the auditor's account still has access. Auditor finds this themselves on the next engagement and writes a finding against the org",
      "Audit traffic untracked - when something suspicious happens during the audit window, the SOC can't distinguish audit activity from real attack, so they either ignore it (and miss the real one) or chase the audit and burn out",
      "Audit findings provided to auditors directly - sensitive vulnerability information leaves the organization without going through review. The pen-test report includes screenshots of exposed customer data",
      "Pen-test scoping creep - engagement starts at \"the customer-facing API\", expands during the test to \"the internal admin panel because it was easier\", scope of compromise is now wider than authorised",
      "Customer audits (right-to-audit clauses) treated as one-off goodwill events with no protections applied - the customer's auditor wanders the network because the contract said they could"
    ],
    evidence_to_look_for: [
      { item: "Audit / pen-test engagement template covering scope, timing, access, credentials", what_it_tells_you: "Whether engagements are governed" },
      { item: "Sample recent audit or pen test showing the engagement governance applied", what_it_tells_you: "Whether the template is followed" },
      { item: "Audit credential lifecycle evidence - time-bounded, revoked at conclusion", what_it_tells_you: "Whether access is controlled" },
      { item: "Audit access logs reviewed after engagement", what_it_tells_you: "Whether activity is traceable" },
      { item: "Pen-test scoping document with rules of engagement", what_it_tells_you: "Whether testing has guardrails" }
    ],
    scoping_notes: "Pen-test engagements are the most common A.8.34 application - every external pen test should have a rules-of-engagement document covering scope, timing, allowed techniques, escalation paths if something breaks, credential management. Internal-audit access on operational systems is similarly scoped - auditors don't need write access to most things, time-bounding is straightforward, log review afterwards is cheap. Customer audits (where customers exercise audit rights from contracts) follow the same model - scope, timing, access, conclusion.",
    minimum_certifiable: "Smallest version that will still pass Stage 2: a documented rules-of-engagement template for audit and pen-test activities on operational systems covering scope, timing, access, time-bounded credentials, and stop conditions. Applied to the most recent external pen test or internal audit touching production. Audit credentials are revoked within the documented SLA after engagement close.",
    maturity_ladder: {
      1: "Audit access ad-hoc; credentials persist",
      2: "Engagement template; scope and timing agreed; credentials time-bounded",
      3: "Logs reviewed; rules of engagement for testing; coverage across audit types",
      4: "Continuous governance of audit activities; metrics on audit-related incidents declining; audit experience reviewed and improved"
    },
    related_items: ["annex-a.5.18", "annex-a.5.35", "annex-a.8.29"]
  },
};
