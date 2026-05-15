// Audit-grade content per ISO/IEC 42001:2023 clause / Annex A control.
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
//   related_items          - array of iso42001 item ids the auditor will
//                            check alongside this one
//
// Items not present here fall back to the legacy summary/evidence_needed
// fields from iso42001-catalog.js.

module.exports = {
  // ===================================================================
  // CLAUSE 4 - CONTEXT OF THE ORGANIZATION
  // ===================================================================
  'ai-clause-4.1': {
    purpose: "This clause forces the organization to write down why its AIMS exists and what shapes it. Without it, every other clause is making assumptions that no one has tested. It feeds risk assessment (6.1.2), impact assessment (6.1.4), scope (4.3), and AI objectives (6.2). Distinct from ISO 27001 4.1, it also forces a determination of the organization's role(s) - provider, developer, deployer, customer - because the obligations are very different for each.",
    what_good_looks_like: "A context register (or a section of the AIMS scope document) lists 8-15 substantive AI-relevant issues - not generic boilerplate like \"AI is a fast-moving field\", but specific items: \"the EU AI Act high-risk obligations apply to our HR-screening model from Aug 2026\", \"our largest customer's procurement framework now asks for ISO 42001 evidence\", \"we depend on a single foundation-model API whose terms change every 90 days\". Each issue is traceable downstream - to a risk in the AI risk register, an objective, a control in the SoA, or an item in the impact assessment. The organization's roles per AI system are listed explicitly (\"we are deployer of OpenAI GPT-4 for support summarisation; we are provider+developer of the propensity model\"). Reviewed when something material happens, not only on a calendar.",
    common_pitfalls: [
      "Generic AI-trend boilerplate (\"AI is evolving rapidly\") that could apply to any company - auditors spot this in 30 seconds",
      "Role determination missing or ambiguous - the same AI system is treated as 'we use it' without distinguishing develop / deploy / provide, which makes 4.2 and Annex A.10 impossible to evaluate",
      "Climate / environmental footprint of compute-heavy AI systems not addressed at all",
      "Context items exist but no AI risk or impact-assessment entry references them - implies they weren't actually used",
      "\"Reviewed annually\" but the only review is the one written at certification"
    ],
    evidence_to_look_for: [
      { item: "Context register or scope-document section listing AI-relevant issues", what_it_tells_you: "Whether the determination was actually done and whether it's organisation-specific" },
      { item: "Documented role determination per in-scope AI system (provider/developer/deployer/customer)", what_it_tells_you: "Whether the organization has worked out which obligations apply to which AI" },
      { item: "Workshop minutes or stakeholder-analysis records showing how the issues were determined", what_it_tells_you: "Whether the process was real or post-rationalised" },
      { item: "Three or four risks in the AI risk register that demonstrably trace to a context issue", what_it_tells_you: "Whether the context analysis fed into risk treatment" },
      { item: "Management-review minutes from the last 12 months where context was discussed", what_it_tells_you: "Whether the register is alive or fossilised" }
    ],
    scoping_notes: "Some organizations capture AI context inside the AIMS scope statement; others maintain a separate register. Both are acceptable. What is not acceptable is having no documented determination at all, or documenting once and never revisiting. The role determination is the AI-specific addition vs ISO 27001 - missing it is usually a major nonconformity because Annex A.10 cannot be applied without it.",
    maturity_ladder: {
      1: "AI context discussed verbally; nothing written, or what's written is generic AI-industry boilerplate",
      2: "Specific organisation-tailored AI context register exists; AI roles per system documented; reviewed at planned intervals",
      3: "Context items traceable to risks, impact assessments, controls, and objectives; updated on triggering events (acquisition, new AI deployment, regulatory change)",
      4: "Context maintained as a continuously-curated artefact with named owners per item; metrics on review timeliness reported to management; explicit linkage tested in internal audit"
    },
    related_items: ['ai-clause-4.2', 'ai-clause-4.3', 'ai-clause-6.1.2', 'ai-clause-6.1.4']
  },

  'ai-clause-4.2': {
    purpose: "Determines which parties have a legitimate stake in the AIMS and what they expect of it. For AI systems this extends beyond customers and regulators to affected individuals (people the AI makes decisions about), civil-society groups, and the public, because AI can produce harm to non-customers. The output is the input to the AI impact assessment (6.1.4) and to control A.8 (information for interested parties).",
    what_good_looks_like: "A stakeholder register lists 10-20 parties categorised by relationship (regulator, customer, employee, supplier, end-user, affected-but-not-user, advocacy group, certification body). For each, the AI-specific expectations are written down concretely - not \"compliance with regulations\" but \"compliance with EU AI Act Title III for the credit-scoring model by Aug 2026\". A separate column captures whether the expectation will be addressed by the AIMS or referred elsewhere. The register references the legal/regulatory register and shows traceability to controls and to the impact assessment. Affected individuals - users of the AI's output - are explicitly listed where the AI makes or supports decisions about people.",
    common_pitfalls: [
      "Affected individuals (non-customers) not listed at all - the AI affects people who never signed a contract; missing them is usually a finding",
      "Generic regulatory references (\"applicable laws\") instead of named statutes and deadlines",
      "EU AI Act / sectoral AI regulation listed only by name, with no determination of obligations or applicability",
      "Stakeholder register exists but nothing downstream references it",
      "Confused 4.1 vs 4.2 - moving customer concerns into 'context' instead of 'interested parties'"
    ],
    evidence_to_look_for: [
      { item: "Stakeholder register with AI-specific expectations per party", what_it_tells_you: "Whether the determination was made deliberately or copy-pasted from an ISO 27001 register" },
      { item: "Legal and regulatory register that calls out AI-specific obligations (EU AI Act, US sectoral, Canada AIDA, etc.)", what_it_tells_you: "Whether the organization has done the legal mapping" },
      { item: "Linkage from a stakeholder requirement to an Annex A control or impact-assessment entry", what_it_tells_you: "Whether requirements actually drive controls" },
      { item: "Records of consultation or feedback channels for affected groups", what_it_tells_you: "Whether the org has any real path to learn about adverse impacts post-deployment" }
    ],
    scoping_notes: "For deployers using third-party AI, the supplier may be both an interested party (commercial relationship) and a control point (data-processing relationship). Don't double-count - one entry, multiple roles. Where AI is embedded in a product, end-customers of the product are an interested party even if they don't know AI is involved.",
    maturity_ladder: {
      1: "No documented determination of interested parties for the AIMS, or only ISO 27001-style copy-paste",
      2: "Register exists, covers customers/regulators/employees, but missed affected individuals or societal groups",
      3: "Register covers all stakeholder categories including affected individuals; each requirement is linked to a control, risk, or impact assessment",
      4: "Stakeholder engagement runs as a managed process - structured consultation, feedback channels for affected individuals, results feed continual improvement"
    },
    related_items: ['ai-clause-4.1', 'ai-clause-6.1.4', 'ai-annex-a-8-2', 'ai-annex-a-8-3', 'ai-annex-a-8-5']
  },

  'ai-clause-4.3': {
    purpose: "Defines the boundary of the AIMS - which AI systems, products, services, lifecycle stages, organizational units, and locations are inside. Without it, you cannot tell whether a given finding is in or out of scope, and the certification body cannot certify a specific footprint. The AI-specific dimension is that scope is anchored on AI systems (the inventory), not on a single department or product, and lifecycle stages must be explicit.",
    what_good_looks_like: "A scope statement that fits on one page. It names the AI systems in scope by reference to the AI inventory, names the lifecycle stages covered (design, development, validation, deployment, operation, decommissioning - or whichever subset), names the organizational units, geographies, and supporting functions, and explicitly lists out-of-scope items with a one-line rationale (\"experimental research models pre-deployment are out of scope; subject to AIMS once promoted to pilot\"). The AI inventory has the same scope boundary - a system flagged in scope here is flagged in scope there.",
    common_pitfalls: [
      "Scope written as a paragraph that nobody can actually verify - no AI systems named, no lifecycle stages, no exclusions",
      "AI inventory and scope disagree - a system in scope by the AIMS scope statement is missing from the inventory, or vice versa",
      "Shadow AI (e.g. staff use of public LLMs) neither in scope nor explicitly excluded",
      "\"All AI used at the organization\" - over-broad and unverifiable",
      "Exclusions stated without rationale, or with rationale that doesn't hold up under questioning"
    ],
    evidence_to_look_for: [
      { item: "AIMS scope document with explicit in-scope AI systems, lifecycle stages, units, and exclusions", what_it_tells_you: "Whether scope is verifiable or only aspirational" },
      { item: "AI inventory cross-checked against scope", what_it_tells_you: "Whether the two artefacts are consistent" },
      { item: "Justifications for any excluded AI use", what_it_tells_you: "Whether the exclusions are defensible" }
    ],
    scoping_notes: "It is acceptable - and often advisable - to start narrow (one AI system, one lifecycle stage, one business unit) and expand. A narrow but real scope passes certification; a broad but undocumented scope does not. If shadow AI is excluded, say so and say what control prevents in-scope creep.",
    maturity_ladder: {
      1: "Scope is vague or copied from another framework's scope; cannot be verified",
      2: "Scope statement is documented and specific to AI systems and lifecycle stages, but inventory and scope may drift apart over time",
      3: "Scope statement is reviewed when systems are added/removed, and stays consistent with the inventory",
      4: "Scope changes are tracked via a managed change process with management approval; consistency between scope and inventory is internally audited"
    },
    related_items: ['ai-clause-4.1', 'ai-clause-4.2', 'ai-clause-6.3', 'ai-annex-a-4-2']
  },

  'ai-clause-4.4': {
    purpose: "Requires the organization to actually establish, implement, and maintain the AIMS as a system of processes that interact, rather than a binder of disconnected policies. This is the lightest of the clauses to satisfy in writing but the heaviest in practice - it means the AIMS must be a working operational reality.",
    what_good_looks_like: "A short AIMS overview document (or section of the manual) describes the processes that make up the AIMS - context review, risk assessment, impact assessment, control selection and operation, monitoring, internal audit, management review, corrective action - and how they hand off to each other. It need not be elaborate, but a reader should be able to follow how an issue identified in 4.1 ends up affecting an AI system control via 6.1 and 8.x. The AIMS is in regular operation, not paper-only - there are real artefacts from the last 6-12 months that show each process happening.",
    common_pitfalls: [
      "AIMS manual exists but reads like a brochure - no process diagrams, no handoffs, no owners",
      "Processes documented but no recent artefacts - the AIMS hasn't done anything since certification",
      "AI risk and AI impact treated as the same process, or as completely disconnected processes",
      "Continual improvement (10.1) absent because nothing has been improved"
    ],
    evidence_to_look_for: [
      { item: "AIMS process map or overview", what_it_tells_you: "Whether the AIMS is understood as a system or as a stack of unrelated documents" },
      { item: "Recent artefacts from each process (risk assessments, impact assessments, audits, review minutes, corrective actions)", what_it_tells_you: "Whether the AIMS is operational or shelfware" }
    ],
    scoping_notes: "There is no required form. A working AIMS in a 50-person company can be 10 pages plus operational records; in a 5000-person company it will be larger. What matters is that the system works.",
    maturity_ladder: {
      1: "AIMS exists as a binder of policies; processes are unclear or invisible",
      2: "AIMS processes documented; first operational cycle complete (one risk assessment, one impact assessment, one internal audit)",
      3: "Multiple operational cycles complete; handoffs between processes working; continual improvement actions tracked",
      4: "AIMS performance metrics tracked across cycles; process effectiveness measured and trended"
    },
    related_items: ['ai-clause-5.1', 'ai-clause-9.1', 'ai-clause-9.3', 'ai-clause-10.1']
  },

  // ===================================================================
  // CLAUSE 5 - LEADERSHIP
  // ===================================================================
  'ai-clause-5.1': {
    purpose: "Holds top management personally accountable for the AIMS. The AI dimension makes this material - decisions about acceptable risk, intended use, and impact thresholds are inherently leadership decisions, not technical decisions. Without visible leadership, the AIMS becomes a technical function unable to enforce decisions that affect product strategy.",
    what_good_looks_like: "An identifiable executive sponsor (CEO, CISO, CTO, Chief AI Officer, or equivalent) chairs or attends AIMS management reviews and is named in the AIMS documentation. Resources are allocated visibly - budget for AI risk staffing, model-monitoring tooling, training. Top management communicates about responsible AI in town-halls, written messages, or onboarding; communications are time-stamped and recoverable. Decisions that escalate from the AIMS - to suspend a model, refuse a use case, or accept a residual risk - are recorded with the executive sponsor's signature.",
    common_pitfalls: [
      "Executive sponsor named in the policy but absent from every management review",
      "AI risk acceptances signed by a middle manager because the executive isn't engaged",
      "No visible communication from leadership about AI principles - staff know there's a policy because they signed something",
      "Resources \"to be allocated\" but never landing in actual headcount or tooling spend"
    ],
    evidence_to_look_for: [
      { item: "Management-review minutes signed by or attended by the named executive sponsor", what_it_tells_you: "Whether leadership is engaged in practice" },
      { item: "Budget allocations / headcount records traceable to AIMS line items", what_it_tells_you: "Whether resources match the stated commitment" },
      { item: "Recent communications from leadership about responsible AI", what_it_tells_you: "Whether leadership is visible to staff" },
      { item: "Signed risk acceptances at executive level for residual AI risks above threshold", what_it_tells_you: "Whether accountability matches the policy" }
    ],
    scoping_notes: "In smaller organizations the executive sponsor may be the founder or CEO; in larger ones it is typically a C-suite role with AI-and-risk accountability. The role need not be AI-specific - a CISO who owns AI risk is fine.",
    maturity_ladder: {
      1: "Leadership commitment stated in policy; not visible in practice",
      2: "Executive sponsor identified and attends management reviews; resources allocated reactively",
      3: "Leadership demonstrates commitment through approvals, communications, and resource decisions; AIMS is integrated into business decisions",
      4: "Leadership drives the AIMS - sets objectives, reviews performance against them, accountable for outcomes"
    },
    related_items: ['ai-clause-5.2', 'ai-clause-5.3', 'ai-clause-9.3']
  },

  'ai-clause-5.2': {
    purpose: "Requires a documented AI policy approved at the top - the single artefact that says what the organization commits to in its development, provision, and use of AI. Distinct from an information-security policy because the commitments are different (fairness, transparency, human oversight, safety, sustainability, etc., in addition to security and privacy).",
    what_good_looks_like: "A 1-3 page AI policy approved by top management, dated and versioned. It states the organization's purpose for AI, the principles it commits to (typically fairness, transparency, accountability, safety, human oversight, privacy and security), prohibited uses (e.g., social-scoring, weaponisation, autonomous action above defined thresholds), and the framework for setting AI objectives. It explicitly references applicable obligations (EU AI Act, sectoral regulation, internal commitments). It is communicated to all staff who develop or use AI, and made externally available where appropriate. It is reviewed annually or on triggering events.",
    common_pitfalls: [
      "Policy is a list of principles with no prohibitions - staff cannot tell what they cannot do",
      "Policy is the public AI marketing page lightly edited - good for PR, useless for governance",
      "Approved by a middle manager, not top management",
      "Not communicated to people who build or use AI - it lives only in the AIMS folder",
      "Doesn't reference applicable regulations or doesn't address the organization's specific AI footprint"
    ],
    evidence_to_look_for: [
      { item: "AI policy, dated and approved at the documented authority level", what_it_tells_you: "Whether the policy exists in the form Clause 5.2 requires" },
      { item: "Communication and acknowledgement records (training, intranet, onboarding)", what_it_tells_you: "Whether staff have seen the policy" },
      { item: "Public-facing variant where the policy commits to external transparency", what_it_tells_you: "Whether external commitments match internal reality" },
      { item: "Review records showing the policy has been re-examined", what_it_tells_you: "Whether the policy is alive or static" }
    ],
    scoping_notes: "Some organizations bundle responsible-AI principles into a wider corporate code of conduct; ISO 42001 requires that there is an AI policy specifically. A code of conduct can suffice if it has an AI section with the required commitments. A separate AI policy is usually clearer.",
    maturity_ladder: {
      1: "No AI policy, or a generic AI-ethics statement without commitments or prohibitions",
      2: "AI policy approved and communicated; covers principles and applicable obligations",
      3: "Policy is the explicit reference point for AI development and use decisions; staff cite it; reviewed annually",
      4: "Policy is updated on regulatory and business triggers; effectiveness measured (e.g., decisions deferred or escalated as a result of policy)"
    },
    related_items: ['ai-clause-5.1', 'ai-clause-5.3', 'ai-annex-a-2-2', 'ai-annex-a-2-3', 'ai-annex-a-2-4']
  },

  'ai-clause-5.3': {
    purpose: "Top management must assign and communicate responsibilities for the AIMS. For AI specifically this is non-trivial because accountability often spans data science, engineering, legal, ethics, security, business owners, and customer-facing staff - all of whom can affect outcomes. Without explicit assignment, the AIMS has no single throat to choke.",
    what_good_looks_like: "A roles-and-responsibilities matrix (or equivalent) names: an executive sponsor; an AIMS owner; AI model owners (per AI system); a data steward; a function or person responsible for AI risk; a function or person responsible for AI impact assessment; a reviewer or approver for deployments; a human-oversight owner per deployed system. Each role has its responsibilities written in terms of decisions and approvals - not vague \"supports\" verbs. The matrix is visible to staff and referenced from policies.",
    common_pitfalls: [
      "Roles defined but no accountability for AI impact assessment - it becomes nobody's job",
      "Model owners not named per AI system - any incident has a 30-minute hunt to find an owner",
      "Human-oversight role defined but rotates frequently and nobody knows the current name",
      "Responsibilities written as \"supports / facilitates\" without decision authority - the role can't actually stop a launch"
    ],
    evidence_to_look_for: [
      { item: "RACI or roles matrix covering the AIMS", what_it_tells_you: "Whether responsibilities are formally allocated or implicit" },
      { item: "Appointment letters or onboarding records for AI-specific roles (ethics lead, model owner)", what_it_tells_you: "Whether named individuals know they hold the role" },
      { item: "Recent decisions (deployment approval, risk acceptance, suspension) traceable to a documented role", what_it_tells_you: "Whether the role structure is actually used" }
    ],
    scoping_notes: "In a small organization, several roles can be held by the same person, provided segregation requirements (e.g., not approving your own model deployment) are observed. In larger organizations the AI risk function should sit outside the AI delivery function.",
    maturity_ladder: {
      1: "Responsibilities not documented; AIMS owner exists implicitly",
      2: "Roles matrix documented and communicated; AI model owners named per system",
      3: "Decisions are traceable to documented roles; matrix reviewed on team changes",
      4: "Role effectiveness reviewed in internal audit; segregation enforced and tested"
    },
    related_items: ['ai-clause-5.1', 'ai-clause-7.2', 'ai-annex-a-3-2']
  },

  // ===================================================================
  // CLAUSE 6 - PLANNING
  // ===================================================================
  'ai-clause-6.1.1': {
    purpose: "Frames the planning approach: the organization must identify risks and opportunities to the AIMS, plan actions to address them, integrate the actions into the AIMS, and evaluate their effectiveness. This is the general planning umbrella above the more specific risk assessment (6.1.2), risk treatment (6.1.3), and impact assessment (6.1.4) clauses.",
    what_good_looks_like: "A planning approach is documented - typically a short procedure - that describes how AIMS-level risks and opportunities are identified (workshops, monitoring, regulatory horizon scanning), how they are recorded, and how actions are tracked. Outputs feed objectives (6.2) and the AI risk register. Opportunities are addressed alongside risks - the AIMS isn't only about avoiding harm but also about positioning the organization to capture value safely.",
    common_pitfalls: [
      "Process exists for risks but \"opportunities\" are never actually identified or addressed",
      "Risks at the AIMS level confused with risks at the AI-system level - they should be distinct but linked",
      "No effectiveness evaluation of the planned actions; the loop is open"
    ],
    evidence_to_look_for: [
      { item: "Planning procedure or methodology document", what_it_tells_you: "Whether the planning approach is documented and applied" },
      { item: "AIMS-level risk and opportunity register (separate from system-level AI risk register)", what_it_tells_you: "Whether AIMS-level planning is distinct from system-level risk" },
      { item: "Effectiveness review records for planned actions", what_it_tells_you: "Whether the planning cycle closes" }
    ],
    scoping_notes: "It is common to maintain both a small AIMS-level risk register (e.g., 'we lose our model-monitoring tool', 'regulator publishes new high-risk classification') and a larger AI-system risk register (one per AI system). Both are required, but they are distinct.",
    maturity_ladder: {
      1: "No planning approach documented; risks identified ad hoc",
      2: "Planning approach documented; AIMS-level risks identified and tracked",
      3: "Opportunities tracked alongside risks; actions integrated into AIMS processes; effectiveness reviewed",
      4: "Planning is a continuous process; trends in risks and opportunities feed objective-setting and budgeting"
    },
    related_items: ['ai-clause-6.1.2', 'ai-clause-6.1.3', 'ai-clause-6.1.4', 'ai-clause-6.2']
  },

  'ai-clause-6.1.2': {
    purpose: "Requires an AI risk assessment process that establishes criteria, identifies risks to and from AI systems, analyses them, and evaluates them against criteria. The critical distinction from ISO 27001 is that AI risks are not only CIA-style information security risks - they include fairness, opacity, robustness, automation bias, misuse, environmental, and societal categories drawn from Annex C.",
    what_good_looks_like: "A documented AI risk methodology with explicit risk criteria (likelihood scale, consequence scale across categories, acceptance thresholds). The categories explicitly cover Annex C topics - bias and fairness, robustness, security and privacy, transparency, oversight, environmental, and societal. Each in-scope AI system has at least one assessment, with named risk owner, analysis, evaluation, and traceability to treatment (6.1.3) or acceptance. Assessments are repeatable - two analysts using the same methodology on the same system reach comparable results.",
    common_pitfalls: [
      "Methodology silently copies the ISO 27001 risk method - AI risks are evaluated only along CIA, missing fairness, robustness, automation bias, etc.",
      "Risk criteria absent or different across assessments, so results aren't comparable",
      "Annex C risk sources never referenced; assessor relies on intuition",
      "Risk owners are roles (\"the data team\") not named individuals",
      "Risks identified but treatment unclear - the bridge to 6.1.3 is missing"
    ],
    evidence_to_look_for: [
      { item: "AI risk assessment methodology document with criteria explicit", what_it_tells_you: "Whether assessments are repeatable and AI-aware" },
      { item: "AI risk register with at least one entry per in-scope AI system", what_it_tells_you: "Whether the methodology is actually applied" },
      { item: "Two assessments performed by different analysts that converge on similar risk ratings", what_it_tells_you: "Whether the methodology produces comparable results" },
      { item: "Annex C risk-source coverage in the methodology", what_it_tells_you: "Whether the assessment is AI-aware" }
    ],
    scoping_notes: "Risk assessment frequency: at least annually per in-scope AI system, plus on significant change (re-training, intended-use change, new deployment context). Where many AI systems are similar (e.g., variants of one model in many languages), one assessment with documented system-specific deltas is acceptable.",
    maturity_ladder: {
      1: "No documented AI risk methodology; assessments are ad hoc or reuse ISO 27001 method without adaptation",
      2: "Methodology documented with AI-specific criteria; assessments performed for each in-scope AI system",
      3: "Methodology consistently applied; results comparable across analysts and systems; feeds 6.1.3 cleanly",
      4: "Methodology tested in internal audit; assessor calibration exercises run; methodology versioned and improved on lessons learned"
    },
    related_items: ['ai-clause-6.1.1', 'ai-clause-6.1.3', 'ai-clause-6.1.4', 'ai-clause-8.2']
  },

  'ai-clause-6.1.3': {
    purpose: "Defines and applies the AI risk treatment process: select treatment options for each risk (modify, accept, avoid, share), determine necessary controls, compare against Annex A reference controls, produce a Statement of Applicability with justifications, and obtain risk owners' approval of the plan and residual risks. The SoA is the certifiable artefact - every Annex A control must have an applicability decision with justification.",
    what_good_looks_like: "A treatment plan with an action per risk above acceptance threshold, an owner, a deadline, and a means of effectiveness measurement. Controls necessary to deliver the treatment are listed, then cross-checked against Annex A so that no Annex A control is missed without a reason - the SoA captures the applicability of all 38 Annex A controls with a one-line justification each. Where Annex A controls don't fit, additional controls are added. The whole plan plus residual risks is approved by the relevant risk owners and the executive sponsor.",
    common_pitfalls: [
      "SoA listed Annex A controls as applicable / not applicable without justifications - audit-blocking finding",
      "Treatment actions have no owner or deadline",
      "Residual risk acceptance is implied, not documented",
      "Annex A check is mechanical (\"all included\") without showing the org actually needed each one",
      "Custom controls (beyond Annex A) added but not justified by a risk"
    ],
    evidence_to_look_for: [
      { item: "AI risk treatment plan with owners, deadlines, controls, and effectiveness measures", what_it_tells_you: "Whether the treatment is real or aspirational" },
      { item: "Statement of Applicability covering every Annex A control with a justification", what_it_tells_you: "Whether the SoA exists in the form the certification body needs" },
      { item: "Risk acceptance records signed by risk owners and executive sponsor", what_it_tells_you: "Whether residual risk is owned" },
      { item: "Linkage from each Annex A inclusion to a specific risk it treats", what_it_tells_you: "Whether the SoA was built from risks or invented top-down" }
    ],
    scoping_notes: "The SoA is the most-examined document in an ISO 42001 audit. Excluded Annex A controls need substantive justifications (\"we do not develop AI systems; the development controls do not apply\" is fine; \"we do not consider this control necessary\" is not).",
    maturity_ladder: {
      1: "Treatment plan absent or only summarised in slides; SoA missing or incomplete",
      2: "Treatment plan documented; SoA covers all Annex A controls with justifications",
      3: "Treatments are traceable to risks; effectiveness measured per control; SoA updated on risk changes",
      4: "Treatment effectiveness reported as metrics; SoA review is a managed process with named owners and signed approvals"
    },
    related_items: ['ai-clause-6.1.2', 'ai-clause-6.1.4', 'ai-clause-8.3', 'ai-annex-a-2-2']
  },

  'ai-clause-6.1.4': {
    purpose: "The AI-specific addition to the standard MS clause structure. Requires the organization to establish a process to assess the potential consequences of developing, providing, or using AI systems on individuals, groups, and society. This is distinct from AI risk assessment (6.1.2) - risk is about the organization, impact is about the people affected by the AI.",
    what_good_looks_like: "A documented impact-assessment methodology with proportionality (low-risk systems get a lighter assessment, high-risk get the full version), trigger criteria (new system, significant change, planned interval), and a structured template covering: intended use, affected individuals and groups, vulnerable populations, potential harms (rights, autonomy, safety, privacy, fairness, dignity), societal impacts (economic, environmental, democratic), mitigations, residual impacts, oversight arrangements, and approval. Outputs feed risk treatment (6.1.3) and operational impact assessment (8.4). Affected stakeholders are consulted where the system is high-impact.",
    common_pitfalls: [
      "Treated as identical to risk assessment - same template, same author, same date - missing the impact-on-people lens",
      "Vulnerable populations not addressed - elderly, children, people with disabilities, low digital literacy",
      "Societal-level impacts not addressed (environmental footprint of large-model usage, economic displacement)",
      "Methodology exists but no system has been through it",
      "Mitigations listed but not actually implemented or tracked"
    ],
    evidence_to_look_for: [
      { item: "Impact-assessment methodology with proportionality rules and trigger criteria", what_it_tells_you: "Whether the assessment is repeatable and AI-aware" },
      { item: "Completed impact assessments for in-scope AI systems", what_it_tells_you: "Whether the methodology is used" },
      { item: "Linkage from impact assessment findings to controls or treatment actions", what_it_tells_you: "Whether findings drive change" },
      { item: "Stakeholder-consultation records for high-impact systems", what_it_tells_you: "Whether affected groups are heard" }
    ],
    scoping_notes: "Public frameworks (NIST AI RMF, EU AI Act FRIA, Canada AIDA AIA) provide useful structure - building on one of them speeds implementation and aids auditor confidence. The impact assessment must produce a documented report (see Annex A.5.3) and is referenced in 8.4 for the operational refresh cycle.",
    maturity_ladder: {
      1: "No impact-assessment process, or only an ad-hoc risk-assessment substitute",
      2: "Methodology documented with proportionality; one or more systems assessed",
      3: "All in-scope systems assessed; findings linked to controls and treatments; vulnerable populations covered",
      4: "Stakeholder consultation embedded; assessments are versioned and refreshed on change; lessons feed methodology improvement"
    },
    related_items: ['ai-clause-6.1.2', 'ai-clause-6.1.3', 'ai-clause-8.4', 'ai-annex-a-5-2', 'ai-annex-a-5-3']
  },

  'ai-clause-6.2': {
    purpose: "Sets concrete AI objectives that flow from the policy and feed planning. Objectives translate principles into measurable, time-bound targets - without them the AI policy is rhetoric.",
    what_good_looks_like: "A short set of AI objectives (typically 5-12) covering different dimensions: governance (e.g., \"100% of new AI systems undergo impact assessment before deployment\"), performance (e.g., \"<2% fairness-metric drift over rolling 90-day windows\"), competence (e.g., \"all data scientists complete responsible-AI training within 60 days of hire\"), documentation, etc. Each objective has a measurement method, a target value, a timeframe, an owner, and a way to evaluate results. Objectives are reviewed in management review.",
    common_pitfalls: [
      "Objectives are aspirational statements (\"we will be a leader in responsible AI\") - not measurable",
      "Objectives have no owner or no defined measurement",
      "Targets set once and never reviewed against actual results",
      "Performance objectives missing - only governance objectives are set"
    ],
    evidence_to_look_for: [
      { item: "Documented AI objectives with metrics, targets, owners, timeframes", what_it_tells_you: "Whether objectives meet the Clause 6.2 requirements" },
      { item: "Most recent measurement results vs targets", what_it_tells_you: "Whether objectives are monitored" },
      { item: "Management-review records discussing objectives", what_it_tells_you: "Whether objectives feed governance" }
    ],
    scoping_notes: "Objectives should differ from controls. \"Implement A.6.2.4 verification controls\" is not an objective - it's a treatment action. An objective might be \"validation suite covers fairness, robustness, and accuracy for 100% of customer-facing models\".",
    maturity_ladder: {
      1: "No documented AI objectives, or objectives are vague aspirations",
      2: "Objectives documented, measurable, with owners and timeframes; first measurement cycle complete",
      3: "Objectives reviewed against results in each management review; missed targets trigger corrective action",
      4: "Objectives evolve with maturity - early objectives retired as embedded; new objectives reflect frontier of practice"
    },
    related_items: ['ai-clause-5.2', 'ai-clause-9.1', 'ai-clause-9.3']
  },

  'ai-clause-6.3': {
    purpose: "Requires changes to the AIMS and to AI systems in scope to be planned, not improvised. AI is uniquely change-intensive (retraining, new datasets, fine-tuning, new prompts, new deployment contexts) and uncontrolled change is a leading cause of regression in performance, fairness, and safety.",
    what_good_looks_like: "A change-management procedure that covers both AIMS-level changes (new scope, new framework requirements) and AI-system-level changes (model retraining, dataset changes, intended-use changes, architectural changes). Each change includes an impact assessment (does this need a fresh 6.1.4 review?), an approval (proportional to impact), and a verification step (post-change validation). Emergency changes have an explicit fast-path that retroactively triggers the same controls.",
    common_pitfalls: [
      "AIMS change procedure exists but AI-system retraining bypasses it entirely",
      "Re-training treated as routine ML ops; no link to the impact assessment refresh",
      "Intended-use changes (\"we'll now use this model for the EU market too\") happen without re-assessment",
      "Emergency changes have no retroactive control"
    ],
    evidence_to_look_for: [
      { item: "Change-management procedure covering AIMS and AI-system changes", what_it_tells_you: "Whether the scope of change control is right" },
      { item: "Recent change records with impact assessment and approval", what_it_tells_you: "Whether the procedure is applied" },
      { item: "Re-validation results after a model retraining", what_it_tells_you: "Whether post-change verification works" }
    ],
    scoping_notes: "MLOps practices already cover much of this - tie the AIMS change requirement into the existing MLOps pipeline, don't build a parallel one. The ISO 42001 ask is that the existing process meets the AIMS criteria (impact-aware approval, documentation, verification), not that a new process is invented.",
    maturity_ladder: {
      1: "No change procedure that covers AI-system changes; retraining is informal",
      2: "Change procedure documented; covers AI-system retraining and intended-use changes",
      3: "Changes consistently routed through the procedure; impact-assessment refresh triggered automatically",
      4: "Change-management metrics (change failure rate, regression rate, time to validate) tracked and improved"
    },
    related_items: ['ai-clause-6.1.4', 'ai-clause-8.4', 'ai-annex-a-6-2-5', 'ai-annex-a-6-2-6']
  },

  // ===================================================================
  // CLAUSE 7 - SUPPORT
  // ===================================================================
  'ai-clause-7.1': {
    purpose: "Forces the organization to actually provide resources for the AIMS. AI-specific because the resources are non-obvious - it's not just headcount but also compute, model-monitoring tooling, evaluation libraries, datasets, and access to specialised skills.",
    what_good_looks_like: "Budget allocations specifically for AIMS activities are identifiable in the operating budget - not necessarily a separate cost centre, but visible. Staffing includes AI risk and/or ethics roles. Tooling spend covers monitoring (drift detection, fairness metrics), evaluation, and lifecycle (model registries). Resource adequacy is reviewed in management review and resources flex with operational needs.",
    common_pitfalls: [
      "AIMS is funded out of unspecified slack in other budgets - no record of what's spent",
      "AI-specific tooling (monitoring, fairness eval, bias detection) is absent because nobody owns the procurement decision",
      "Staffing assumes existing security/data-protection staff can absorb AI duties without adjustment"
    ],
    evidence_to_look_for: [
      { item: "Budget records identifying AIMS-related spend", what_it_tells_you: "Whether resources are real" },
      { item: "Tooling inventory covering monitoring, evaluation, registry, lineage", what_it_tells_you: "Whether the operational tools exist" },
      { item: "Management-review discussion of resource adequacy", what_it_tells_you: "Whether resources are actively reviewed" }
    ],
    scoping_notes: "Open-source tooling counts - what matters is that the capability exists, not who's paying for the tool. Document which tools are in use.",
    maturity_ladder: {
      1: "AIMS funded out of nothing in particular; resource adequacy not reviewed",
      2: "Identifiable budget and staffing; tooling for monitoring/evaluation/registry in place",
      3: "Resources adjusted in response to AIMS demand; reviewed in management review",
      4: "Resource demand modelled and forecast; investments aligned with AI footprint growth"
    },
    related_items: ['ai-clause-5.1', 'ai-clause-7.2', 'ai-clause-9.3']
  },

  'ai-clause-7.2': {
    purpose: "Persons doing work that affects AIMS performance must be competent. AI competence is layered - technical (ML engineering, data science), domain (the field the AI applies to), and ethical/legal (responsible AI literacy, regulatory awareness). Without explicit competence requirements, you cannot tell whether the team can actually deliver the AIMS.",
    what_good_looks_like: "A competence matrix maps AIMS roles to required competences across three layers (technical, domain, ethical/legal). For each person in a role, gaps are identified and closed via training, hiring, or mentoring. Records show competence (CVs, training records, certifications). Non-technical AI users (e.g., HR users of an AI-screening tool) are also covered, with appropriate AI-literacy training.",
    common_pitfalls: [
      "Competence treated as 'we hired senior people' - no documentation of what competences they have or need",
      "Non-technical AI users (\"the AI just makes my job easier\") never trained on the AI's limits",
      "Ethical/legal AI literacy missing - even experienced data scientists may not know fairness frameworks or relevant regulation",
      "Training completed once at hire and never refreshed despite a moving field"
    ],
    evidence_to_look_for: [
      { item: "Competence requirements per AIMS-relevant role", what_it_tells_you: "Whether expectations are documented" },
      { item: "Skills matrix or per-person competence records", what_it_tells_you: "Whether actual competence is tracked" },
      { item: "Training records covering responsible-AI principles", what_it_tells_you: "Whether ethical/legal layer is addressed" },
      { item: "Records of competence verification (assessment, project review, peer feedback)", what_it_tells_you: "Whether competence is verified or assumed" }
    ],
    scoping_notes: "External staff (contractors, auditors, vendors) who work on AIMS-relevant activities are in scope. Their competence may be evidenced through their employer's records.",
    maturity_ladder: {
      1: "Competence not documented; reliance on hiring decisions",
      2: "Competence matrix exists for AIMS roles; gaps closed via training or hiring",
      3: "Competence verified via assessment or project records; refresh cadence defined",
      4: "Competence demand modelled with the AI roadmap; pipeline / succession in place for key roles"
    },
    related_items: ['ai-clause-7.3', 'ai-clause-5.3', 'ai-annex-a-3-2']
  },

  'ai-clause-7.3': {
    purpose: "Personnel must be aware of the AI policy and their contribution to AIMS effectiveness. Distinct from competence (which is about being capable of doing the work) - awareness is about knowing the rules and limits.",
    what_good_looks_like: "An awareness programme covers AI policy, prohibited uses, escalation paths for ethical concerns, and AI-specific incidents. It reaches all staff (not only technical staff). It is delivered via training, intranet, onboarding, and refreshed on policy changes. Acknowledgement records exist. Awareness of acceptable use of AI tools (e.g., LLMs) is covered for non-AI staff who use AI products in their daily work.",
    common_pitfalls: [
      "Awareness only for the AI team - business users of AI products never trained",
      "Awareness covers policy but not concrete acceptable / unacceptable behaviour",
      "Refresh missing - the policy changes but awareness materials don't"
    ],
    evidence_to_look_for: [
      { item: "Awareness programme content and schedule", what_it_tells_you: "Whether the programme is real and current" },
      { item: "Acknowledgement records (% of in-scope staff)", what_it_tells_you: "Whether reach is broad enough" },
      { item: "Specific examples of prohibited / acceptable AI use", what_it_tells_you: "Whether the awareness is operationally useful" }
    ],
    scoping_notes: "In organizations using generative AI tools widely, awareness should cover data hygiene (don't paste customer data into public LLMs), output verification, and disclosure obligations.",
    maturity_ladder: {
      1: "No awareness programme, or only an annual generic compliance training",
      2: "AI-specific awareness delivered to all relevant staff; acknowledged",
      3: "Refreshed on policy changes; covers acceptable use of AI tools beyond development",
      4: "Awareness effectiveness tested (e.g., phishing-style scenarios, quizzes); content tuned to incidents and near-misses"
    },
    related_items: ['ai-clause-5.2', 'ai-clause-7.2', 'ai-clause-7.4']
  },

  'ai-clause-7.4': {
    purpose: "Communications about the AIMS must be planned - internal (status, incidents, decisions) and external (regulators, partners, affected parties, public). For AI this is consequential because incidents, model behaviour changes, and disclosure obligations all involve communication; the wrong communication or none at all can convert a manageable event into a reputational or regulatory crisis.",
    what_good_looks_like: "A communications plan or matrix lists planned internal and external communications - what, when, to whom, by whom, how. Authority to communicate externally is explicit (e.g., only the executive sponsor or designated comms team speaks on AI matters to regulators). Templates exist for high-stakes communications (incident notification, transparency disclosure). The plan is exercised periodically (drill or real event review).",
    common_pitfalls: [
      "No external-comms templates - real incident response is improvised",
      "Authority to speak externally is unclear; everyone or nobody",
      "Internal escalation paths for AI ethical concerns are not communicated"
    ],
    evidence_to_look_for: [
      { item: "Communications matrix or plan", what_it_tells_you: "Whether comms are planned or reactive" },
      { item: "Pre-approved templates for AI incident notification, customer disclosures, regulator notification", what_it_tells_you: "Whether templates support quick response" },
      { item: "Authorisation matrix for external comms", what_it_tells_you: "Whether the wrong person can speak on the wrong topic" }
    ],
    scoping_notes: "Coordinate with overall incident-response and crisis-comms plans. The AI-specific addition is identifying which AI events trigger which audiences (e.g., bias surfacing on a deployed model that affects EU users triggers EU AI Act notification timelines).",
    maturity_ladder: {
      1: "No comms plan; reactive only",
      2: "Comms plan documented; templates exist for known scenarios",
      3: "Plan exercised; templates updated post-incident or post-drill",
      4: "Comms effectiveness measured (time to issue, completeness); audience-specific paths refined"
    },
    related_items: ['ai-clause-7.3', 'ai-annex-a-8-3', 'ai-annex-a-8-4', 'ai-annex-a-8-5']
  },

  'ai-clause-7.5': {
    purpose: "Documented information required by ISO 42001 must be controlled - identified, formatted, reviewed, approved, version-controlled, distributed, retained, and disposed of. The AI-specific dimension is model cards, datasheets, evaluation reports, and lineage records, which sit alongside conventional policies and procedures and need the same controls.",
    what_good_looks_like: "A control-of-documents procedure that covers conventional documents (policies, procedures) and AI artefacts (model cards, datasheets, evaluation reports, lineage). Each document type has a defined owner, review cycle, retention period, and access controls. Externally-sourced documents (open-source model cards, third-party datasheets) are controlled when used as evidence. Versioning is enforced and history is recoverable.",
    common_pitfalls: [
      "AI artefacts (model cards, datasheets) stored only in source control with no review cycle or retention policy",
      "External documentation (e.g., a third-party model card) used as evidence but not under document control",
      "Documents proliferate in shared drives without an authoritative version",
      "Retention not defined for AI evidence - assessment artefacts deleted before the next surveillance audit"
    ],
    evidence_to_look_for: [
      { item: "Document-control procedure covering AI artefact types", what_it_tells_you: "Whether the procedure spans the AI scope" },
      { item: "Model cards, datasheets, evaluation reports under controlled storage", what_it_tells_you: "Whether AI artefacts are managed" },
      { item: "Retention schedule including AI evidence", what_it_tells_you: "Whether retention is defined" }
    ],
    scoping_notes: "Storing AI artefacts in a git repository is fine, provided the procedure recognises the repository as the controlled store, with tagged releases for the canonical versions auditors will examine.",
    maturity_ladder: {
      1: "No control of AI artefacts beyond ad-hoc storage",
      2: "AI artefacts under document control; review cycles defined",
      3: "Controls applied consistently; retention enforced; access controlled",
      4: "Control effectiveness measured (e.g., recoverability of artefacts cited in past audits)"
    },
    related_items: ['ai-clause-7.4', 'ai-annex-a-4-3', 'ai-annex-a-6-2-7']
  },

  // ===================================================================
  // CLAUSE 8 - OPERATION
  // ===================================================================
  'ai-clause-8.1': {
    purpose: "Operational planning and control of AIMS processes - the operational counterpart to Clause 6. Includes outsourced AI processes (third-party model providers, data labellers, infra).",
    what_good_looks_like: "AI processes for design, development, validation, deployment, and operation are defined and controlled - typically via an ML lifecycle that integrates with the AIMS. Outsourced AI processes (foundation-model APIs, annotation vendors) are identified, contracts capture AIMS-relevant obligations, and ongoing oversight runs. Unplanned changes are reviewed and corrective action taken where the outcome is undesired.",
    common_pitfalls: [
      "Operational planning documented but the actual pipeline doesn't follow it",
      "Outsourced AI processes excluded from oversight (\"we use OpenAI; that's their problem\")",
      "Unplanned changes (emergency retraining, hot-fix) not reviewed retroactively"
    ],
    evidence_to_look_for: [
      { item: "Documented AI lifecycle processes", what_it_tells_you: "Whether operational planning is documented" },
      { item: "Vendor/outsourcing register flagging AI dependencies with AIMS-relevant clauses", what_it_tells_you: "Whether third parties are in scope" },
      { item: "Records of unplanned-change review", what_it_tells_you: "Whether emergencies are handled" }
    ],
    scoping_notes: "If MLOps is mature, much of 8.1 is satisfied by existing tooling - the AIMS task is to recognise and document the alignment, not duplicate the process.",
    maturity_ladder: {
      1: "AI processes informal; outsourced processes outside scope",
      2: "AI lifecycle documented; outsourced processes registered; unplanned changes reviewed",
      3: "Operational planning consistently applied; outsourced oversight runs; deviations corrected",
      4: "Operational planning effectiveness measured; process improvements based on lessons learned"
    },
    related_items: ['ai-clause-6.3', 'ai-annex-a-6-1-3', 'ai-annex-a-10-3']
  },

  'ai-clause-8.2': {
    purpose: "Performs AI risk assessments operationally - at planned intervals or on significant change. Distinct from 6.1.2 (which sets up the methodology) in being about the recurring assessment cycle.",
    what_good_looks_like: "Risk assessments per in-scope AI system are scheduled and run. Trigger criteria for ad-hoc reassessment (model retraining, intended-use change, incident, regulatory change) are defined and demonstrably applied. Results are documented, fed into the risk register, and used to update treatment plans.",
    common_pitfalls: [
      "First assessment done at certification; no subsequent cycle",
      "Trigger criteria defined but never actually trip a fresh assessment (e.g., a retraining happens without reassessment)",
      "Results buried in slides; risk register not updated"
    ],
    evidence_to_look_for: [
      { item: "Schedule of AI risk assessments and trigger criteria", what_it_tells_you: "Whether the cycle is planned" },
      { item: "Most recent assessment per in-scope system", what_it_tells_you: "Whether the cycle is running" },
      { item: "Risk register updates traceable to assessments", what_it_tells_you: "Whether outputs land in the register" }
    ],
    scoping_notes: "An assessment can be a light-touch delta where nothing significant has changed (\"reviewed; no new risks; no changes to ratings\") - but the delta must be documented.",
    maturity_ladder: {
      1: "Assessments performed only at certification; no recurring cycle",
      2: "Planned-interval assessments running; trigger criteria defined",
      3: "Trigger criteria reliably applied; results consistently feed risk register and treatment plan",
      4: "Assessment cadence tuned by risk; high-risk systems re-assessed more often; effectiveness measured"
    },
    related_items: ['ai-clause-6.1.2', 'ai-clause-8.3', 'ai-clause-8.4']
  },

  'ai-clause-8.3': {
    purpose: "Implements the AI risk treatment plan operationally and tracks effectiveness. The operational counterpart to 6.1.3.",
    what_good_looks_like: "Treatment actions move from the plan to implementation with named owners. A tracker shows actions completed, pending, and overdue. Residual risks are reviewed and accepted at the right level. Control effectiveness is measured - not just \"the control exists\" but \"the control is producing the intended effect\".",
    common_pitfalls: [
      "Treatment plan exists but actions slip without escalation",
      "Implementation = a control listed in the SoA; no demonstration of effectiveness",
      "Residual risks not formally accepted"
    ],
    evidence_to_look_for: [
      { item: "Treatment action tracker with status, owner, due date", what_it_tells_you: "Whether actions are tracked" },
      { item: "Control effectiveness review records", what_it_tells_you: "Whether effectiveness is measured" },
      { item: "Residual risk acceptance records signed at the right level", what_it_tells_you: "Whether residual risk is owned" }
    ],
    scoping_notes: "Tie effectiveness to outcomes auditable from logs/data where possible (e.g., a fairness control's effectiveness = fairness metric within threshold) rather than to procedural compliance.",
    maturity_ladder: {
      1: "Treatment actions tracked informally; effectiveness not measured",
      2: "Tracker in place; control effectiveness measured for some controls",
      3: "Effectiveness measured for all key controls; residual risk acceptance is part of governance",
      4: "Effectiveness measurements trended; ineffective controls reworked or replaced"
    },
    related_items: ['ai-clause-6.1.3', 'ai-clause-8.2', 'ai-clause-9.1']
  },

  'ai-clause-8.4': {
    purpose: "Performs and refreshes AI system impact assessments operationally. The operational counterpart to 6.1.4. AI systems change - data drift, model retraining, intended-use expansion - and yesterday's impact assessment may no longer be accurate.",
    what_good_looks_like: "Each in-scope AI system has a current impact assessment, dated and approved. Refresh triggers (model retraining, intended-use change, scaling to new population, complaints surfacing harm patterns) are defined and demonstrably applied. Outputs feed risk treatment and operational controls. Where assessment surfaces new mitigations needed, they are tracked to completion.",
    common_pitfalls: [
      "Impact assessment done once at deployment; never refreshed despite material changes",
      "Refresh triggers defined but not applied",
      "Mitigations identified during assessment never tracked to closure"
    ],
    evidence_to_look_for: [
      { item: "Current impact assessment per in-scope AI system", what_it_tells_you: "Whether the assessment cycle is current" },
      { item: "Refresh triggers and recent applications", what_it_tells_you: "Whether the cycle is alive" },
      { item: "Mitigation tracker showing closure", what_it_tells_you: "Whether assessment outputs land in change" }
    ],
    scoping_notes: "For systems with low risk and stable behaviour, an annual review is typical. For high-risk or rapidly-changing systems, the cadence is shorter.",
    maturity_ladder: {
      1: "Assessments done at deployment only; no operational refresh",
      2: "Refresh triggers and cadence defined; some systems refreshed",
      3: "All in-scope systems on a current assessment; triggers reliably applied",
      4: "Assessment cadence tuned by risk; consultation with affected groups continuous for high-impact systems"
    },
    related_items: ['ai-clause-6.1.4', 'ai-clause-8.3', 'ai-annex-a-5-2', 'ai-annex-a-5-3']
  },

  // ===================================================================
  // CLAUSE 9 - PERFORMANCE EVALUATION
  // ===================================================================
  'ai-clause-9.1': {
    purpose: "Requires the organization to determine what to monitor and measure, by what methods, when, by whom - and to analyse and evaluate the results. For AI this spans AIMS performance (objectives, control effectiveness) and AI-system performance (accuracy, drift, fairness, robustness, security events).",
    what_good_looks_like: "A monitoring plan covers AIMS objectives and AI-system metrics. For each metric: definition, measurement method, frequency, threshold, owner, escalation path. Dashboards show current state and trend. Threshold breaches trigger alerts and recorded escalation. Results feed management review and corrective action.",
    common_pitfalls: [
      "AIMS objectives have no measurement; AI-system metrics monitored but not connected to AIMS",
      "Thresholds defined but no escalation when breached",
      "Dashboards exist but nobody reviews them between management reviews",
      "Fairness metrics not monitored post-deployment - assumption that pre-deployment validation is sufficient"
    ],
    evidence_to_look_for: [
      { item: "Monitoring plan covering both AIMS and AI-system metrics", what_it_tells_you: "Whether monitoring scope is right" },
      { item: "Active dashboards and alerts", what_it_tells_you: "Whether monitoring is operational" },
      { item: "Records of threshold breaches and escalations", what_it_tells_you: "Whether monitoring drives action" }
    ],
    scoping_notes: "Drift, fairness, and robustness are the AI-specific metrics that frequently fall through the cracks - traditional ops monitoring covers availability and latency only.",
    maturity_ladder: {
      1: "Monitoring is ad-hoc; AIMS objectives not measured",
      2: "Monitoring plan documented; AIMS and AI-system metrics tracked",
      3: "Thresholds and alerts in place; breaches consistently trigger response",
      4: "Monitoring continuously tuned; effectiveness of monitoring itself is reviewed"
    },
    related_items: ['ai-clause-6.2', 'ai-clause-9.3', 'ai-annex-a-6-2-6']
  },

  'ai-clause-9.2': {
    purpose: "Conducts internal audits at planned intervals to determine whether the AIMS conforms to ISO 42001 and the organization's own requirements, and is effectively implemented and maintained.",
    what_good_looks_like: "An audit programme runs annually covering all AIMS clauses and Annex A controls in scope. Auditors are competent, impartial (not auditing their own work), and follow a documented method. Findings are written as objective nonconformities or improvement opportunities. Corrective actions are tracked and effectiveness verified. Audit reports go to management review.",
    common_pitfalls: [
      "Audit done by the AIMS owner - no impartiality",
      "Audit covers only documentation; no operational testing",
      "Findings are vague; no objective evidence cited",
      "Corrective actions opened but not verified for effectiveness"
    ],
    evidence_to_look_for: [
      { item: "Audit programme and plans covering all in-scope areas", what_it_tells_you: "Whether the programme is comprehensive" },
      { item: "Audit reports with findings, owners, deadlines", what_it_tells_you: "Whether audits are productive" },
      { item: "Corrective action records with effectiveness verification", what_it_tells_you: "Whether the loop closes" }
    ],
    scoping_notes: "External or rotated internal auditors satisfy impartiality. Auditing both the AIMS and the underlying AI systems is required - it's not enough to audit only the management system.",
    maturity_ladder: {
      1: "Internal audit absent or limited to documentation review",
      2: "Annual audit covering AIMS and AI systems; impartiality maintained",
      3: "Findings drive measurable improvements; effectiveness verified",
      4: "Audit programme risk-based; high-risk areas audited more frequently; audit quality reviewed"
    },
    related_items: ['ai-clause-9.3', 'ai-clause-10.2']
  },

  'ai-clause-9.3': {
    purpose: "Top management reviews the AIMS at planned intervals, considering the required inputs (audit results, performance, incidents, risk and impact assessment results, etc.) and produces outputs (decisions on improvement and changes).",
    what_good_looks_like: "Management review runs at least annually, more often where the AIMS is young or change-intensive. The required inputs (9.3.2) are explicitly covered. Outputs are decisions, not summaries - resource changes, objective changes, scope changes, accepted residual risks. Minutes are signed and traceable to subsequent actions. The executive sponsor attends.",
    common_pitfalls: [
      "Review held but inputs are summarised in slides without supporting evidence",
      "Output is \"continue current approach\" with no decisions recorded",
      "Required inputs missing - especially impact-assessment results, which often aren't presented",
      "Executive sponsor sends a delegate"
    ],
    evidence_to_look_for: [
      { item: "Management-review schedule and agenda", what_it_tells_you: "Whether the review is planned" },
      { item: "Minutes covering all required inputs and showing decisions made", what_it_tells_you: "Whether the review meets the clause" },
      { item: "Actions arising from review traceable to subsequent records", what_it_tells_you: "Whether the review is consequential" }
    ],
    scoping_notes: "ISO 42001 9.3.2 lists specific inputs; a structured agenda covering each one is the easiest way to demonstrate coverage. Quarterly mini-reviews with an annual deep review is a common pattern.",
    maturity_ladder: {
      1: "Review is a single annual meeting; minutes are sparse",
      2: "Review covers all required inputs; outputs documented",
      3: "Review drives measurable changes; cadence proportional to AIMS maturity",
      4: "Review is the steering function of the AIMS - decisions on objectives, scope, investment originate here"
    },
    related_items: ['ai-clause-9.2', 'ai-clause-10.1', 'ai-clause-5.1']
  },

  // ===================================================================
  // CLAUSE 10 - IMPROVEMENT
  // ===================================================================
  'ai-clause-10.1': {
    purpose: "Continually improve the suitability, adequacy, and effectiveness of the AIMS. Improvement is not optional in an MS standard - it's an obligation.",
    what_good_looks_like: "An improvement initiative log captures opportunities from internal audit, management review, incidents, monitoring breaches, regulator updates, and staff feedback. Improvements are prioritised, owned, and tracked through to outcome. Continual improvement is visible in successive management reviews - each cycle shows specific improvements landed in the previous period.",
    common_pitfalls: [
      "No improvement log - improvements happen but aren't traced",
      "Improvement = doing the next clause review on the calendar; no actual change",
      "Improvements opened but not tracked to outcome"
    ],
    evidence_to_look_for: [
      { item: "Improvement initiative log", what_it_tells_you: "Whether improvements are tracked" },
      { item: "Improvements landed in the past 12 months", what_it_tells_you: "Whether the AIMS is improving" },
      { item: "Management-review records discussing improvement", what_it_tells_you: "Whether improvement is a governance topic" }
    ],
    scoping_notes: "Improvements need not be large. A series of small process improvements is more credible than annual large refactors.",
    maturity_ladder: {
      1: "Improvements untracked; AIMS stable but stagnant",
      2: "Improvement log in place; some initiatives tracked to outcome",
      3: "Continual improvement visible across management-review cycles",
      4: "Improvement metrics tracked (lead time, throughput); pipeline of improvements steady"
    },
    related_items: ['ai-clause-9.3', 'ai-clause-10.2']
  },

  'ai-clause-10.2': {
    purpose: "React to nonconformities (and AI-specific incidents - unintended bias, model failure, breach of impact thresholds, unauthorised AI use), evaluate the need for action, implement actions, and review effectiveness. The corrective-action loop.",
    what_good_looks_like: "A nonconformity log captures all NCs, with categorisation, root cause analysis, correction (immediate fix), corrective action (preventing recurrence), and effectiveness review. AI-specific incidents (bias surfacing in production, model performance crash, unauthorised use) flow through the same process. Root cause is real - not \"human error\" but the systemic gap that allowed it. Effectiveness is verified some time later, not at the moment the fix lands.",
    common_pitfalls: [
      "NCs treated as one-off fixes - no root cause, no systemic prevention",
      "AI-specific incidents not recognised as NCs (\"the model just drifted\")",
      "Effectiveness verification skipped or done same-day"
    ],
    evidence_to_look_for: [
      { item: "Nonconformity log with categorisation and root cause", what_it_tells_you: "Whether NCs are handled systematically" },
      { item: "Examples of root cause analysis going beyond \"human error\"", what_it_tells_you: "Whether root cause is real" },
      { item: "Effectiveness verifications", what_it_tells_you: "Whether the loop closes" }
    ],
    scoping_notes: "Customer complaints, regulator findings, and incidents from monitoring all flow into the NC process. The log doesn't need to be heavy; what matters is that every NC has a documented life cycle.",
    maturity_ladder: {
      1: "NCs handled informally; root cause not analysed",
      2: "NC log in place; root cause analysis done; corrective actions tracked",
      3: "Effectiveness verified; trends in NCs reviewed; AI-specific incident types covered",
      4: "NC metrics (volume, time-to-close, recurrence) trended; systemic gaps fed back into AIMS design"
    },
    related_items: ['ai-clause-9.2', 'ai-clause-10.1', 'ai-annex-a-8-4']
  },

  // ===================================================================
  // ANNEX A - REFERENCE CONTROLS
  // ===================================================================
  // A.2 Policies related to AI
  'ai-annex-a-2-2': {
    purpose: "The most-asked-about Annex A control. Forces the AI policy to exist as a written, approved artefact - not a deck, not a webpage. Without it, every other Annex A.2 control has nothing to align to.",
    what_good_looks_like: "A 1-3 page AI policy document, dated, version-controlled, approved by named top management. It commits the organization to responsible-AI principles (typically fairness, transparency, accountability, safety, oversight, privacy, security). It states what the organization will not do (prohibited uses - e.g., social scoring, mass surveillance, weapons applications, fully autonomous decisions affecting individuals' fundamental rights). It defines the scope of activities covered (develop / provide / deploy / use). It is communicated to staff and made externally available where appropriate.",
    common_pitfalls: [
      "Policy is a list of principles with no prohibited uses",
      "Approved at director level when board approval was required by internal governance",
      "Doesn't reference the organization's actual AI footprint or sector",
      "Published externally before internal alignment - PR moves ahead of governance"
    ],
    evidence_to_look_for: [
      { item: "Approved, dated AI policy with named approver(s)", what_it_tells_you: "Whether the policy exists in the required form" },
      { item: "Communication records (training, intranet, acknowledgement)", what_it_tells_you: "Whether the policy has reached staff" },
      { item: "Public-facing version (where relevant) consistent with internal", what_it_tells_you: "Whether external commitments match reality" }
    ],
    scoping_notes: "Some organizations bundle the policy into a Code of Conduct or a broader Responsible Technology policy. That's fine if the AI-specific section meets the requirements. A standalone AI policy is usually clearer.",
    maturity_ladder: {
      1: "No AI policy or only a generic statement of principles",
      2: "AI policy approved, dated, communicated; covers principles and prohibited uses",
      3: "Policy is the explicit reference for AI decisions; staff cite it; reviewed annually",
      4: "Policy reflects lessons from incidents and reviews; effectiveness measured (decisions deferred / escalated as a result)"
    },
    related_items: ['ai-clause-5.2', 'ai-annex-a-2-3', 'ai-annex-a-2-4']
  },

  'ai-annex-a-2-3': {
    purpose: "Forces the AI policy to be consistent with the wider policy landscape - information security, privacy, risk, HR, procurement, ethics. Conflicts (e.g., information-security policy says \"never share data with external processors\" but the AI policy uses a third-party LLM API) must be reconciled.",
    what_good_looks_like: "A cross-reference matrix or short alignment note shows the relationship between the AI policy and each related policy. Where conflicts exist, the related policies have been updated (e.g., procurement contract template now includes AI-specific clauses; HR code of conduct addresses use of AI tools). The same definitions (what counts as an AI system, what counts as personal data in an AI context) are used consistently.",
    common_pitfalls: [
      "AI policy and procurement contract templates not aligned - new vendors signed without AI-specific clauses",
      "HR code of conduct doesn't address acceptable use of AI tools at work",
      "Definitions of \"AI system\" differ between the AI policy and the data-protection policy"
    ],
    evidence_to_look_for: [
      { item: "Cross-reference matrix or alignment note between AI policy and related policies", what_it_tells_you: "Whether alignment was assessed" },
      { item: "Updated procurement templates with AI clauses", what_it_tells_you: "Whether the alignment changed downstream artefacts" },
      { item: "Updated HR / ethics / security policies addressing AI", what_it_tells_you: "Whether related policies have absorbed AI considerations" }
    ],
    scoping_notes: "This control is often weak in organizations that built the AIMS as an isolated initiative. The fix is administrative: a workshop with policy owners to identify and resolve overlaps.",
    maturity_ladder: {
      1: "Alignment not assessed",
      2: "Cross-reference exists; obvious conflicts resolved",
      3: "Related policies materially updated; definitions consistent",
      4: "Alignment maintained as policies evolve; review trigger built into policy-change process"
    },
    related_items: ['ai-annex-a-2-2', 'ai-annex-a-2-4', 'ai-annex-a-10-3']
  },

  'ai-annex-a-2-4': {
    purpose: "Requires the AI policy to be reviewed on a planned cycle and on triggering events. A static policy diverges from operational reality fast in AI.",
    what_good_looks_like: "Review cadence is documented (typically annual minimum) and review triggers are listed (regulatory changes, significant AI incident, scope changes, technology shifts). Each review is recorded with a date, reviewer, summary of decisions, and approval. Policy versions and change history are recoverable.",
    common_pitfalls: [
      "Review cadence documented as annual but never actually performed after certification",
      "Triggers defined but real triggering events (e.g., EU AI Act updates) don't trip a review",
      "Reviews are pro-forma - no actual changes ever come out"
    ],
    evidence_to_look_for: [
      { item: "Review cadence and trigger definitions", what_it_tells_you: "Whether the review approach is documented" },
      { item: "Records of past reviews with date, reviewer, decisions", what_it_tells_you: "Whether reviews actually run" },
      { item: "Version history of the policy", what_it_tells_you: "Whether reviews drive change" }
    ],
    scoping_notes: "Tie the review to management review (9.3) as an input - this keeps it in the governance cycle and ensures a leadership decision.",
    maturity_ladder: {
      1: "Reviews not performed",
      2: "Reviews performed at planned interval; recorded",
      3: "Triggers reliably applied; reviews produce changes when warranted",
      4: "Effectiveness of policy itself reviewed (e.g., 'have any incidents been attributable to a policy gap?')"
    },
    related_items: ['ai-annex-a-2-2', 'ai-clause-9.3', 'ai-clause-10.1']
  },

  // A.3 Internal organization
  'ai-annex-a-3-2': {
    purpose: "Roles and responsibilities for AI activities across the lifecycle must be defined and assigned. Distinct from Clause 5.3 (which is about the AIMS roles); this is about the AI-system delivery roles - who does the design, training, validation, deployment, monitoring, oversight, incident response.",
    what_good_looks_like: "A RACI or roles matrix covers the AI lifecycle. Each AI system has a named model owner. A data steward owns training-data quality and provenance. A reviewer or approver gates deployment. A human-oversight owner monitors the deployed system. Each role has clear decision authority and escalation paths. Roles are visible to staff and reviewed when teams change.",
    common_pitfalls: [
      "Roles defined but rotate frequently without update",
      "No human-oversight owner - the model is deployed but nobody is responsible for watching it",
      "Same person is model owner, validator, and approver - segregation absent",
      "Decision authority unclear - reviewer can comment but cannot block deployment"
    ],
    evidence_to_look_for: [
      { item: "RACI or roles matrix for AI activities", what_it_tells_you: "Whether roles are formally allocated" },
      { item: "Per-AI-system named model owner", what_it_tells_you: "Whether ownership is concrete" },
      { item: "Recent decisions (approval, suspension, escalation) traceable to a named role", what_it_tells_you: "Whether the role structure is used" }
    ],
    scoping_notes: "In small teams one person can hold several roles - what matters is that segregation requirements are observed (the person who approves the deployment can't be the same person who developed it for high-risk systems).",
    maturity_ladder: {
      1: "Roles informal; nobody owns AI systems explicitly",
      2: "Model ownership defined; key lifecycle roles named",
      3: "Decision authority clear; segregation enforced; reviewed on team changes",
      4: "Role effectiveness reviewed via internal audit; succession planned for key roles"
    },
    related_items: ['ai-clause-5.3', 'ai-annex-a-3-3', 'ai-annex-a-6-1-3']
  },

  'ai-annex-a-3-3': {
    purpose: "A protected channel for staff and external parties to raise concerns about AI - ethical, safety, fairness, regulatory. Without it, concerns are aired only socially and never reach decision-makers.",
    what_good_looks_like: "A documented reporting channel - existing whistleblower hotline, a dedicated mailbox, or both - covers AI concerns. Anonymity option exists. Triage and response procedures are documented. Anti-retaliation protections apply. The channel is communicated to staff and where appropriate to external parties (users, affected individuals). Reports are tracked and trended.",
    common_pitfalls: [
      "Channel exists but staff don't know it covers AI concerns",
      "No anti-retaliation language - reports are chilled",
      "No triage SLA - reports vanish into a mailbox",
      "External parties have no way to report - the channel is internal-only despite a broad AI user base"
    ],
    evidence_to_look_for: [
      { item: "Documented reporting channel with scope, triage, and anti-retaliation language", what_it_tells_you: "Whether the channel is fit for AI concerns" },
      { item: "Communications evidence (intranet, training, external page)", what_it_tells_you: "Whether the channel is known" },
      { item: "Sample of reports received and how they were handled", what_it_tells_you: "Whether reports get processed" }
    ],
    scoping_notes: "Existing whistleblower channels usually suffice with a small addition (scope explicitly includes AI ethical concerns). New channels rarely outperform extended existing ones.",
    maturity_ladder: {
      1: "No channel scoped to AI concerns",
      2: "Channel documented; anonymity and anti-retaliation in place; communicated",
      3: "Reports triaged and responded to within SLA; trends analysed; learnings fed back",
      4: "External parties have a path; channel effectiveness measured (reports received, time to resolution, satisfaction)"
    },
    related_items: ['ai-annex-a-3-2', 'ai-annex-a-8-3']
  },

  // A.4 Resources for AI systems
  'ai-annex-a-4-2': {
    purpose: "Document the resources required by each AI system. The umbrella for the more specific data / tooling / system / human resource controls. The point is to make resource dependencies visible so risks, impacts, and changes can be assessed against reality.",
    what_good_looks_like: "An AI system inventory exists - one entry per in-scope AI system, with cross-references to its data sources, frameworks, compute infrastructure, and people involved. Updated when systems are added, retired, or materially changed. Used as the spine of the AIMS - the impact assessment, risk register, and SoA all reference inventory IDs.",
    common_pitfalls: [
      "Inventory in a spreadsheet that diverges from reality - the last update was 6 months before the audit",
      "Inventory exists but contains no actual resource detail beyond the system name",
      "Different teams maintain separate inventories that don't agree"
    ],
    evidence_to_look_for: [
      { item: "AI system inventory", what_it_tells_you: "Whether resources are catalogued" },
      { item: "Cross-references from risk register / SoA to inventory IDs", what_it_tells_you: "Whether the inventory is the spine" },
      { item: "Inventory update records", what_it_tells_you: "Whether the inventory stays current" }
    ],
    scoping_notes: "Tools that already exist - model registries, MLOps platforms - can serve as the inventory if they have the right fields and are kept current. A separate spreadsheet is often the worst option.",
    maturity_ladder: {
      1: "Inventory absent or out of date",
      2: "Inventory exists with key resources per system; updated on change",
      3: "Inventory is the spine of the AIMS; referenced by risk, impact, SoA",
      4: "Inventory automated where possible (e.g., pulled from registry); freshness metrics tracked"
    },
    related_items: ['ai-clause-4.3', 'ai-annex-a-4-3', 'ai-annex-a-4-4', 'ai-annex-a-4-5', 'ai-annex-a-4-6']
  },

  'ai-annex-a-4-3': {
    purpose: "Specifically catalogues the data resources used by each AI system - training data, evaluation data, operational data. Provenance, licensing, quality, biases must be documented.",
    what_good_looks_like: "Each AI system has a datasheet (or equivalent) listing every dataset used in training and operation. For each dataset: source (internal, third-party, open-source, scraped, synthetic), licensing or consent basis, date acquired, size, schema, known limitations and biases, transformations applied. Datasheets are versioned alongside the model they support.",
    common_pitfalls: [
      "Training data documented but operational data (inputs in production) not catalogued",
      "Open-source dataset listed by name with no record of licence or content",
      "Datasheets don't acknowledge known biases (e.g., a face dataset known to under-represent certain skin tones)",
      "Synthetic data treated as risk-free - origins and generation method not documented"
    ],
    evidence_to_look_for: [
      { item: "Datasheets per AI system", what_it_tells_you: "Whether data is documented at the right grain" },
      { item: "Licensing / consent records", what_it_tells_you: "Whether data rights are clear" },
      { item: "Bias and limitation notes", what_it_tells_you: "Whether the datasheet is honest" }
    ],
    scoping_notes: "Datasheets for Datasets (Gebru et al.) and similar templates are well-established starting points. Adopt one and stick to it.",
    maturity_ladder: {
      1: "No data documentation beyond informal notes",
      2: "Datasheets exist per system; cover provenance, licensing, schema",
      3: "Biases and limitations documented; datasheets versioned with the model",
      4: "Datasheet quality reviewed in internal audit; gaps trigger remediation"
    },
    related_items: ['ai-annex-a-4-2', 'ai-annex-a-7-3', 'ai-annex-a-7-5']
  },

  'ai-annex-a-4-4': {
    purpose: "Catalogues the tooling resources (algorithms, models, frameworks, libraries) the AI system depends on, including versions. The reproducibility and SBOM equivalent for AI.",
    what_good_looks_like: "A model card or equivalent for each AI system records the algorithm/architecture, framework versions (e.g., PyTorch 2.x), key libraries with versions, model-registry references, and any commercial-tooling dependencies (foundation-model APIs, fine-tuning platforms). License obligations of each dependency are tracked.",
    common_pitfalls: [
      "Versions not pinned - the system was built with framework v2.3.1 but \"PyTorch\" is recorded",
      "Foundation-model API versions ignored (\"GPT-4\" instead of the specific snapshot)",
      "Commercial-tool licences not tracked - obligations breached without anyone noticing"
    ],
    evidence_to_look_for: [
      { item: "Model card or tooling list per AI system", what_it_tells_you: "Whether tooling is catalogued" },
      { item: "Version-pinned dependency record", what_it_tells_you: "Whether reproducibility is possible" },
      { item: "Licence-obligation tracking", what_it_tells_you: "Whether commercial obligations are managed" }
    ],
    scoping_notes: "SBOM tooling (e.g., CycloneDX-AI, AIBOM) is emerging - useful where toolchains are complex. For simple stacks a written record is fine.",
    maturity_ladder: {
      1: "Tooling not documented",
      2: "Tooling listed per system; versions pinned",
      3: "Dependency tracking is automated; licence obligations monitored",
      4: "SBOM-equivalent maintained; vulnerability and licence-change alerts wired in"
    },
    related_items: ['ai-annex-a-4-2', 'ai-annex-a-6-2-7']
  },

  'ai-annex-a-4-5': {
    purpose: "Catalogues compute, storage, and networking resources for each AI system - and the constraints they impose (capacity, latency, environmental footprint).",
    what_good_looks_like: "Per AI system, the training and inference environments are documented (cloud region, instance types, accelerators, networking topology). Capacity, performance, and reliability constraints are recorded. For compute-intensive systems, environmental footprint (energy, carbon, water) is tracked. Dependencies on specific infrastructure providers are visible.",
    common_pitfalls: [
      "Infrastructure documented at the team level but not per AI system",
      "Environmental impact ignored",
      "Single-vendor dependencies not flagged as risks"
    ],
    evidence_to_look_for: [
      { item: "Per-system infrastructure record", what_it_tells_you: "Whether infrastructure is tied to AI systems" },
      { item: "Capacity and reliability constraints documented", what_it_tells_you: "Whether limits are known" },
      { item: "Environmental footprint records for material systems", what_it_tells_you: "Whether the org has visibility into AI's environmental cost" }
    ],
    scoping_notes: "For low-compute systems (small classifiers, traditional ML) the environmental footprint is usually negligible and can be noted as such. For LLM-based systems, especially training, it can be material.",
    maturity_ladder: {
      1: "Infrastructure documented at team or org level only",
      2: "Per-system documentation; constraints recorded",
      3: "Environmental footprint tracked for material systems; dependencies flagged",
      4: "Capacity and footprint optimised; trade-offs (latency vs energy) explicitly managed"
    },
    related_items: ['ai-annex-a-4-2', 'ai-annex-a-6-2-6']
  },

  'ai-annex-a-4-6': {
    purpose: "Documents the human resources involved across the AI lifecycle - developers, reviewers, annotators, operators, users - plus external human dependencies (vendors, annotation services).",
    what_good_looks_like: "Per AI system, the people involved at each lifecycle stage are recorded - by role, often by name. Competence requirements per role are cross-referenced to 7.2. External human dependencies (data-labelling vendors, contractors) are listed with their roles and how they were assessed for fit.",
    common_pitfalls: [
      "Internal staff documented but external human dependencies (e.g., third-country data annotation) not catalogued",
      "Roles documented but not the competences expected",
      "When a key person leaves, the AI system's dependencies become invisible"
    ],
    evidence_to_look_for: [
      { item: "Per-system human-resource record", what_it_tells_you: "Whether people-dependencies are tracked" },
      { item: "External human-dependency register", what_it_tells_you: "Whether outsourced labour is in scope" },
      { item: "Cross-reference to competence records (7.2)", what_it_tells_you: "Whether competence and roles are connected" }
    ],
    scoping_notes: "Annotation vendors that process customer data are also third parties under data-protection law - coordinate documentation with privacy.",
    maturity_ladder: {
      1: "People not documented per system",
      2: "Per-system human resources catalogued; external dependencies included",
      3: "Competence and role connected; departures trigger re-documentation",
      4: "Pipeline / succession planned for key AI roles; vendor labour treated as managed dependency"
    },
    related_items: ['ai-clause-7.2', 'ai-annex-a-4-2', 'ai-annex-a-10-3']
  },

  // A.5 Assessing impacts of AI systems
  'ai-annex-a-5-2': {
    purpose: "Requires a documented process for impact assessment. The process control that anchors Clause 6.1.4 and 8.4.",
    what_good_looks_like: "A written methodology covers when assessments are triggered, who performs them, what is assessed (intended use, affected groups, harms, mitigations, residual impacts), what proportionality applies (low-risk vs high-risk systems), how outputs feed risk treatment, and how the assessment is reviewed and refreshed. The methodology is approved and version-controlled.",
    common_pitfalls: [
      "No documented methodology - assessments use whatever template the latest analyst found online",
      "Proportionality absent - low-risk systems get the same heavy assessment as high-risk, leading to perfunctory work",
      "Methodology not linked to 8.4 refresh cycle"
    ],
    evidence_to_look_for: [
      { item: "Approved impact-assessment methodology", what_it_tells_you: "Whether the process exists in writing" },
      { item: "Proportionality criteria", what_it_tells_you: "Whether the process is calibrated" },
      { item: "Linkage to 6.1.3 (treatment) and 8.4 (refresh)", what_it_tells_you: "Whether the process is integrated" }
    ],
    scoping_notes: "Public frameworks (NIST AI RMF, FRIA, AIDA AIA) are good starting points - adopt-and-adapt rather than build from scratch.",
    maturity_ladder: {
      1: "No methodology; assessments are ad-hoc",
      2: "Methodology documented; covers triggers, scope, outputs, refresh",
      3: "Proportionality applied; integrated with risk treatment and refresh cycle",
      4: "Methodology continuously improved based on assessment outcomes and incidents"
    },
    related_items: ['ai-clause-6.1.4', 'ai-clause-8.4', 'ai-annex-a-5-3']
  },

  'ai-annex-a-5-3': {
    purpose: "Requires the results of each impact assessment to be documented. Demonstrates the assessment was performed and provides auditors and stakeholders with the artefact.",
    what_good_looks_like: "Each in-scope AI system has a current, written impact assessment with intended use, affected individuals and groups (especially vulnerable populations), potential adverse effects across rights/autonomy/safety/privacy/fairness dimensions, societal impacts, mitigations identified, residual impacts, oversight arrangements, and approval signatures. The document is dated, version-controlled, and refreshed on schedule.",
    common_pitfalls: [
      "Assessment exists but is a checklist with no narrative - no insight into actual risks",
      "Approval signed by the person who wrote the assessment",
      "Mitigations listed but not tracked to implementation"
    ],
    evidence_to_look_for: [
      { item: "Impact assessment per in-scope AI system", what_it_tells_you: "Whether the artefact exists" },
      { item: "Substantive narrative, not just checklist ticks", what_it_tells_you: "Whether the assessment did real work" },
      { item: "Approval at appropriate level", what_it_tells_you: "Whether outcomes are owned" }
    ],
    scoping_notes: "Assessment narratives that reference specific affected groups (e.g., \"applicants under age 25 may be disadvantaged due to thin credit files\") rather than generic categories (\"users\") are markedly stronger.",
    maturity_ladder: {
      1: "Assessments missing or template-only",
      2: "Documented assessments per system; cover required elements; approved",
      3: "Substantive narratives; mitigations tracked; refreshed on schedule",
      4: "Assessments include stakeholder consultation evidence; quality reviewed and improved"
    },
    related_items: ['ai-annex-a-5-2', 'ai-annex-a-5-4', 'ai-annex-a-5-5']
  },

  'ai-annex-a-5-4': {
    purpose: "Specifically requires impact on individuals and groups to be assessed - fairness, accountability, privacy, autonomy, safety, vulnerable populations.",
    what_good_looks_like: "The impact assessment for each AI system explicitly addresses: how decisions affect individuals' fundamental rights, whether outcomes differ across protected groups (with disaggregated metrics where data permits), specific consideration of vulnerable populations (children, elderly, disabled, low digital literacy, marginalised), and how oversight protects individual interests. Quantitative fairness analysis is included where applicable.",
    common_pitfalls: [
      "Impact \"on users\" assessed generically; no demographic disaggregation",
      "Fairness analysis only at deployment; never refreshed despite drift",
      "Vulnerable populations not named, just implied",
      "Privacy treated as a separate analysis with no linkage"
    ],
    evidence_to_look_for: [
      { item: "Per-assessment section on individual / group impact", what_it_tells_you: "Whether this dimension is addressed" },
      { item: "Disaggregated fairness metrics where applicable", what_it_tells_you: "Whether quantitative analysis is done" },
      { item: "Explicit consideration of vulnerable populations", what_it_tells_you: "Whether the most-affected are visible" }
    ],
    scoping_notes: "Where the AI system's outputs affect individuals without their interaction (e.g., risk scoring that influences a decision), the affected individual is the data subject of the score, not just the human decision-maker who reads it.",
    maturity_ladder: {
      1: "Individual / group impact not addressed specifically",
      2: "Addressed in assessment; generic narrative",
      3: "Disaggregated metrics; vulnerable groups named; privacy linked",
      4: "Continuous monitoring of fairness metrics post-deployment; consultation with affected groups"
    },
    related_items: ['ai-annex-a-5-2', 'ai-annex-a-5-3', 'ai-annex-a-5-5']
  },

  'ai-annex-a-5-5': {
    purpose: "Specifically requires societal impacts to be assessed - environmental, economic, democratic, health, cultural, ethical. Beyond direct effects on individuals into systemic effects.",
    what_good_looks_like: "The impact assessment includes a section on societal-level effects: economic (e.g., labour displacement, market concentration), environmental (energy/carbon for compute-intensive systems), democratic (information ecosystem effects for content systems), public health, cultural, ethical (norms shift, autonomy at scale). Where impacts are material, mitigations are identified. For systems with limited societal reach, this section can briefly note why it is limited.",
    common_pitfalls: [
      "Societal impacts dismissed in one line (\"no broader societal impact\") without analysis",
      "Environmental footprint of large-model usage ignored",
      "Cumulative and second-order effects not considered (e.g., a small system × 100,000 users)"
    ],
    evidence_to_look_for: [
      { item: "Societal-impact section per assessment", what_it_tells_you: "Whether the dimension is addressed" },
      { item: "Environmental analysis for compute-intensive systems", what_it_tells_you: "Whether environmental impact is considered" },
      { item: "Foresight or scenario analysis for systems with broad reach", what_it_tells_you: "Whether second-order effects are considered" }
    ],
    scoping_notes: "Public-facing systems and high-volume systems benefit from explicit foresight techniques (futures wheels, scenario planning). Internal-only systems have limited societal reach and a short paragraph usually suffices.",
    maturity_ladder: {
      1: "Societal impact not addressed",
      2: "Addressed in assessment; narrative-level",
      3: "Quantitative where possible (environmental); foresight applied to high-reach systems",
      4: "External expert input for high-impact systems; lessons fed back to methodology"
    },
    related_items: ['ai-annex-a-5-2', 'ai-annex-a-5-3', 'ai-annex-a-5-4']
  },

  // A.6 AI system life cycle
  'ai-annex-a-6-1-2': {
    purpose: "Sets responsible-development objectives for AI systems - typically fairness, transparency, robustness, security, privacy, accountability, safety, sustainability. These objectives become design inputs.",
    what_good_looks_like: "A short responsible-development objectives document or section translates the AI policy principles into design requirements (e.g., \"all customer-affecting models meet defined fairness thresholds across protected attributes\"; \"all customer-facing AI provides a model card to users with intended use, limits, and contact for concerns\"). Objectives are referenced in design reviews and acceptance criteria. Measurable where practicable.",
    common_pitfalls: [
      "Objectives are vague principles, not requirements (\"we will build fair AI\" - what does fair mean here?)",
      "Objectives exist but design reviews don't reference them - principles don't shape design",
      "No version control - principles change but development teams keep using the old set"
    ],
    evidence_to_look_for: [
      { item: "Documented responsible-development objectives", what_it_tells_you: "Whether principles are translated to design inputs" },
      { item: "Design-review records referencing the objectives", what_it_tells_you: "Whether objectives shape design" },
      { item: "Measurement of objective achievement", what_it_tells_you: "Whether objectives are operationalised" }
    ],
    scoping_notes: "Distinct from Clause 6.2 AI objectives (which are AIMS-level). A.6.1.2 objectives are for the systems themselves, not the management system.",
    maturity_ladder: {
      1: "No objectives translated to design inputs",
      2: "Objectives documented; design reviews reference them",
      3: "Measurable; achievement tracked; failures escalate",
      4: "Objectives evolve as practice matures; lessons from incidents feed objectives"
    },
    related_items: ['ai-annex-a-2-2', 'ai-annex-a-6-1-3', 'ai-annex-a-6-2-2']
  },

  'ai-annex-a-6-1-3': {
    purpose: "Defines the development process for AI systems - the lifecycle gates, oversight, training-data rules, approvals. This is the parent process control for the more detailed A.6.2.x controls.",
    what_good_looks_like: "A documented AI development process covers the lifecycle stages (problem framing, data acquisition, training, evaluation, deployment, monitoring, decommissioning) with gates between them. Gates require approvals proportional to system risk - low-risk systems pass with peer review, high-risk require executive approval. Training-data rules (provenance, consent, quality, bias checks) are embedded. The process is integrated with MLOps tooling where present.",
    common_pitfalls: [
      "Development process documented as a Wiki but never followed - actual delivery skips gates",
      "All systems treated the same regardless of risk - high-risk under-controlled or low-risk over-controlled",
      "Training-data rules absent or only privacy-focused; bias / representativeness not addressed",
      "Approvals exist on paper but the approver doesn't have time to actually review"
    ],
    evidence_to_look_for: [
      { item: "Documented AI development process", what_it_tells_you: "Whether the process exists" },
      { item: "Gate-review records from recent deployments", what_it_tells_you: "Whether gates are real" },
      { item: "Risk-proportional approvals", what_it_tells_you: "Whether the process is calibrated" }
    ],
    scoping_notes: "Stitching the AIMS gates into the existing MLOps / SDLC pipeline is the right pattern - duplicating processes leads to drift.",
    maturity_ladder: {
      1: "No documented process; delivery is ad-hoc",
      2: "Process documented; gates and approvals in place",
      3: "Process followed in practice; risk-proportional; bias / quality embedded",
      4: "Process effectiveness measured (escapes, regressions); continuously tuned"
    },
    related_items: ['ai-annex-a-6-1-2', 'ai-annex-a-6-2-2', 'ai-annex-a-6-2-3', 'ai-annex-a-6-2-4', 'ai-annex-a-6-2-5']
  },

  'ai-annex-a-6-2-2': {
    purpose: "Captures functional and non-functional requirements for each AI system, including responsible-AI requirements. The requirements feed validation (A.6.2.4) and become traceable inputs.",
    what_good_looks_like: "Each AI system has a requirements document covering functional requirements (what the system does, accuracy targets, latency, throughput), non-functional requirements (security, privacy, observability), and responsible-AI requirements (fairness thresholds, explainability needs, oversight, deployment constraints). Requirements are traceable to test cases. Sign-off is at appropriate level.",
    common_pitfalls: [
      "Only functional requirements documented; non-functional and responsible-AI implicit",
      "Fairness thresholds set but not traceable to a test case",
      "Requirements drift through the project without updates"
    ],
    evidence_to_look_for: [
      { item: "Requirements documents per system", what_it_tells_you: "Whether requirements exist" },
      { item: "Responsible-AI requirements explicit", what_it_tells_you: "Whether responsibility is engineered in" },
      { item: "Traceability matrix to test cases", what_it_tells_you: "Whether requirements are verifiable" }
    ],
    scoping_notes: "Where the AI is part of a larger product, AI-specific requirements should be a section of the product requirements document, not a separate stream.",
    maturity_ladder: {
      1: "Requirements informal or only functional",
      2: "Documented requirements covering all dimensions",
      3: "Traceable to test cases; reviewed on change",
      4: "Requirements quality and completeness measured; defects traced to requirement gaps"
    },
    related_items: ['ai-annex-a-6-1-2', 'ai-annex-a-6-2-3', 'ai-annex-a-6-2-4']
  },

  'ai-annex-a-6-2-3': {
    purpose: "Documents AI system design and development decisions - architecture, model choice, hyperparameters, trade-offs. Supports audit, change, and maintenance.",
    what_good_looks_like: "Per AI system, a design document or model card records the architecture, modelling choices (algorithm, hyperparameters, regularisation), training procedure, key design decisions and their rationale (especially trade-offs - accuracy vs interpretability, accuracy vs fairness, latency vs accuracy). Decisions are traceable to requirements.",
    common_pitfalls: [
      "Design captured only in notebooks and chat history; no canonical document",
      "Decision rationale absent - the choice is recorded but not why",
      "Trade-offs implicit; auditor can't tell whether they were considered"
    ],
    evidence_to_look_for: [
      { item: "Design document or model card per system", what_it_tells_you: "Whether design is documented" },
      { item: "Decision rationales for material choices", what_it_tells_you: "Whether reasoning is recoverable" },
      { item: "Traceability from design choices to requirements", what_it_tells_you: "Whether design serves requirements" }
    ],
    scoping_notes: "A model card (Hugging Face / Google template) plus an architecture document together usually satisfy this for typical systems.",
    maturity_ladder: {
      1: "Design lives in notebooks; no canonical document",
      2: "Design document per system; covers architecture, modelling choices, rationale",
      3: "Trade-offs documented explicitly; decisions traceable",
      4: "Design documentation is the canonical source for the model; updates managed and reviewed"
    },
    related_items: ['ai-annex-a-4-3', 'ai-annex-a-4-4', 'ai-annex-a-6-2-2', 'ai-annex-a-6-2-7']
  },

  'ai-annex-a-6-2-4': {
    purpose: "Verification and validation - testing that the system meets requirements (verification) and that it solves the intended problem (validation). For AI this spans functional, performance, fairness, robustness, security, and edge-case testing.",
    what_good_looks_like: "Each AI system has a test plan covering functional accuracy, performance, fairness across protected attributes, robustness to data shifts and adversarial inputs, security (prompt injection for LLMs, evasion for classifiers), and known edge cases. Tests have defined acceptance thresholds. Test results are documented and approved before deployment. Re-validation is triggered on retraining or material change.",
    common_pitfalls: [
      "Validation = accuracy on a held-out set; nothing else tested",
      "Adversarial / robustness testing skipped (\"low risk\") without formal determination",
      "Fairness metrics computed but no acceptance threshold; \"low\" is whatever the result was",
      "Re-validation after retraining skipped because pipeline metrics looked fine"
    ],
    evidence_to_look_for: [
      { item: "Test plan per AI system covering required dimensions", what_it_tells_you: "Whether testing scope is right" },
      { item: "Defined acceptance thresholds", what_it_tells_you: "Whether pass/fail is objective" },
      { item: "Test reports with results and approval", what_it_tells_you: "Whether testing was done" },
      { item: "Re-validation records after retraining", what_it_tells_you: "Whether change triggers re-test" }
    ],
    scoping_notes: "For high-risk systems, independent / red-team testing materially strengthens this control. For low-risk systems, automated tests in the pipeline are usually sufficient.",
    maturity_ladder: {
      1: "Validation = held-out accuracy; nothing else tested",
      2: "Multi-dimensional test plan; acceptance thresholds defined",
      3: "Re-validation triggered on change; results approved at appropriate level",
      4: "Test coverage measured; gaps drive new tests; adversarial / red-team for high-risk systems"
    },
    related_items: ['ai-annex-a-6-2-2', 'ai-annex-a-6-2-5', 'ai-annex-a-6-2-6']
  },

  'ai-annex-a-6-2-5': {
    purpose: "Controls the deployment of AI systems - release criteria, deployment plans, rollback procedures.",
    what_good_looks_like: "Per AI system, deployment is gated by release criteria (validation passed, monitoring in place, documentation ready, support and oversight roles staffed). A deployment plan covers release approach (staged, shadow, canary), rollback procedure, communication, and post-deployment checkpoints. For high-impact systems, staged rollout is standard.",
    common_pitfalls: [
      "Deployment = code push to prod; no release criteria check",
      "Rollback procedure documented but never tested",
      "Shadow / canary considered too slow; high-risk systems deployed in one big bang"
    ],
    evidence_to_look_for: [
      { item: "Release criteria and deployment plan per system", what_it_tells_you: "Whether deployment is controlled" },
      { item: "Recent deployment record showing gates honoured", what_it_tells_you: "Whether the process is applied" },
      { item: "Tested rollback procedure", what_it_tells_you: "Whether rollback works" }
    ],
    scoping_notes: "MLOps platforms typically support staged rollout natively. Use it.",
    maturity_ladder: {
      1: "Deployment is uncontrolled",
      2: "Release criteria and plan documented; gates applied",
      3: "Staged rollout for higher-risk systems; rollback tested",
      4: "Deployment effectiveness measured (incidents, regressions, rollback frequency); process refined"
    },
    related_items: ['ai-annex-a-6-1-3', 'ai-annex-a-6-2-4', 'ai-annex-a-6-2-6']
  },

  'ai-annex-a-6-2-6': {
    purpose: "Operation and monitoring of AI systems in production. The control that bridges deployment and continuous performance management.",
    what_good_looks_like: "Per deployed AI system, monitoring covers performance (accuracy proxies), drift (data and concept), fairness metrics across protected attributes, security events (prompt injection attempts for LLMs, adversarial inputs), and availability. Alerts trip on threshold breaches. A documented runbook covers degradation, drift response, suspension criteria. Human oversight is real - a designated person watches the dashboards and makes decisions.",
    common_pitfalls: [
      "Monitoring covers availability and latency only; AI-specific metrics absent",
      "Alerts configured but firing into a channel nobody reads",
      "Fairness metrics tracked at deployment but not in production",
      "Human oversight defined but rotates without handover - the watcher doesn't know what good looks like"
    ],
    evidence_to_look_for: [
      { item: "Monitoring dashboards and alerts per AI system", what_it_tells_you: "Whether monitoring is operational" },
      { item: "Runbook for AI-specific events", what_it_tells_you: "Whether response is planned" },
      { item: "Recent records of monitoring-driven action (retraining, suspension, fix)", what_it_tells_you: "Whether monitoring drives change" }
    ],
    scoping_notes: "Monitoring stack should be in place before deployment, not after - retrofitting monitoring is expensive and gappy.",
    maturity_ladder: {
      1: "Monitoring is availability only",
      2: "AI-specific metrics monitored; alerts in place",
      3: "Runbooks tested; human oversight real and trained",
      4: "Monitoring tuned by lessons; suppressed alerts and missed alerts both reviewed and improved"
    },
    related_items: ['ai-annex-a-4-5', 'ai-annex-a-6-2-5', 'ai-annex-a-6-2-8', 'ai-clause-9.1']
  },

  'ai-annex-a-6-2-7': {
    purpose: "Provides technical documentation for AI systems tailored to the audiences that need it - developers, deployers, users, partners, auditors, regulators.",
    what_good_looks_like: "Per AI system, layered documentation exists: a model card or summary for general users (capabilities, limits, intended use, contact); a technical report for developers and partners (architecture, training data, evaluation, deployment); an audit pack for auditors and regulators (full lineage, validation, decisions). Each layer is maintained as the system evolves.",
    common_pitfalls: [
      "Single document tries to serve every audience; serves none well",
      "Model card published once; never updated as the system evolves",
      "Audit pack not built until the audit; demonstrates the artefact wasn't really maintained"
    ],
    evidence_to_look_for: [
      { item: "Layered documentation per AI system", what_it_tells_you: "Whether audiences are served" },
      { item: "Public-facing model card aligned with internal reality", what_it_tells_you: "Whether external statements are accurate" },
      { item: "Update history showing maintenance", what_it_tells_you: "Whether documentation is alive" }
    ],
    scoping_notes: "Hugging Face model card schema is well-established; useful starting point. Internal technical reports can be lighter for low-risk systems.",
    maturity_ladder: {
      1: "Documentation absent or one undifferentiated file",
      2: "Layered documentation per system; covers required audiences",
      3: "Maintained on change; aligned across layers",
      4: "Documentation completeness measured; gaps trigger remediation; user feedback used to improve clarity"
    },
    related_items: ['ai-annex-a-4-3', 'ai-annex-a-4-4', 'ai-annex-a-6-2-3', 'ai-annex-a-8-2']
  },

  'ai-annex-a-6-2-8': {
    purpose: "Recording of event logs by the AI system to support audit, incident response, drift detection, and accountability.",
    what_good_looks_like: "Per AI system, a logging specification defines what is logged (inputs at appropriate granularity, outputs, intermediate decisions, overrides, errors, performance metrics), where logs are stored, retention period, access controls, and privacy treatment (redaction, hashing of sensitive fields). Logs are tamper-evident where the system is high-stakes. Logs are usable in incident response and audit.",
    common_pitfalls: [
      "Logs cover infrastructure (latency, errors) but not AI-specific events (decisions, overrides, predictions)",
      "Raw sensitive inputs logged without redaction - privacy and security risk",
      "Logs retained for 30 days when audit cycles are 12 months",
      "Access to logs uncontrolled"
    ],
    evidence_to_look_for: [
      { item: "Logging specification per AI system", what_it_tells_you: "Whether logging is designed" },
      { item: "Sample logs showing AI-specific events captured", what_it_tells_you: "Whether logging captures the right things" },
      { item: "Retention and access controls", what_it_tells_you: "Whether logs are governed" }
    ],
    scoping_notes: "Coordinate with overall security logging - AI logs are a slice of the broader observability stack. Privacy review of what's logged is essential for systems handling personal data.",
    maturity_ladder: {
      1: "AI-specific events not logged",
      2: "Logging specification per system; covers decisions, overrides, performance",
      3: "Privacy-respecting; retention matches audit cycle; access controlled",
      4: "Tamper-evident for high-stakes; log quality reviewed; logs used in incident response and audit"
    },
    related_items: ['ai-annex-a-6-2-6', 'ai-clause-7.5']
  },

  // A.7 Data for AI systems
  'ai-annex-a-7-2': {
    purpose: "Establish data management processes for AI - privacy, security, representativeness, integrity. The umbrella for the more specific A.7.x controls.",
    what_good_looks_like: "A data-management procedure for AI covers the full lifecycle - acquisition, preparation, training use, operational use, retention, disposal. It addresses privacy (lawful basis, minimisation), security (encryption, access), representativeness (coverage of population), quality (accuracy, currency), integrity (no tampering). Responsibilities are assigned to a data steward role. Integrates with existing data governance.",
    common_pitfalls: [
      "Data management procedures for analytics exist but AI-specific concerns (representativeness, bias, drift) not addressed",
      "No data steward; data quality is everyone's responsibility (i.e. nobody's)",
      "Operational data (in-production inputs) not in scope of data management"
    ],
    evidence_to_look_for: [
      { item: "AI data management procedure", what_it_tells_you: "Whether the umbrella exists" },
      { item: "Data steward role assigned", what_it_tells_you: "Whether ownership is real" },
      { item: "Cross-reference to privacy and security controls", what_it_tells_you: "Whether integration is real" }
    ],
    scoping_notes: "Where the organization has mature data governance, the AI procedure is a focused extension - additional concerns (bias, drift, lineage at model granularity) on top of the existing structure.",
    maturity_ladder: {
      1: "No AI-specific data procedure",
      2: "Procedure in place; covers required dimensions",
      3: "Integrated with data governance; data steward role active",
      4: "Effectiveness measured (data quality metrics, incident trends); continually improved"
    },
    related_items: ['ai-annex-a-4-3', 'ai-annex-a-7-3', 'ai-annex-a-7-4', 'ai-annex-a-7-5', 'ai-annex-a-7-6']
  },

  'ai-annex-a-7-3': {
    purpose: "Specifically requires documentation of where each dataset comes from - source, selection criteria, biases, rights.",
    what_good_looks_like: "Per dataset, an acquisition record covers source (internal, third-party, open-source, scraped, synthetic, mixed), date acquired, license / consent basis, selection criteria (why this data, why this sample), known biases or limitations declared by the source, and any modifications made by the organization. For derived datasets, the upstream source is traceable.",
    common_pitfalls: [
      "Open-source datasets cited by name without record of licence terms or content",
      "Selection criteria not documented - \"we used what we had\" with no analysis of fit",
      "Scraped data without legal basis review",
      "Synthetic data treated as risk-free; generation method not recorded"
    ],
    evidence_to_look_for: [
      { item: "Per-dataset acquisition record", what_it_tells_you: "Whether acquisition is documented" },
      { item: "Licence / consent records", what_it_tells_you: "Whether rights are clear" },
      { item: "Selection criteria documented", what_it_tells_you: "Whether the choice was deliberate" }
    ],
    scoping_notes: "Foundation models trained on web-scale data are usually exempt from per-record records but the licence terms of the model itself and any fine-tuning data must be tracked.",
    maturity_ladder: {
      1: "Acquisition documented informally or not at all",
      2: "Per-dataset records covering source, licence, selection",
      3: "Biases declared; modifications tracked; rights validated",
      4: "Acquisition workflow standardised; data brought into the org only via the workflow"
    },
    related_items: ['ai-annex-a-4-3', 'ai-annex-a-7-4', 'ai-annex-a-7-5']
  },

  'ai-annex-a-7-4': {
    purpose: "Set explicit data-quality criteria and verify them. Quality for AI is multi-dimensional - accuracy, completeness, currency, representativeness, consistency.",
    what_good_looks_like: "Per dataset, quality criteria are defined and checked at acquisition and periodically (or on use). For training data, representativeness across the deployment population is analysed. For operational data, currency is monitored (data drift detection). Quality issues trigger remediation - re-collection, augmentation, or scope-limitation. Quality criteria are proportional to system risk.",
    common_pitfalls: [
      "Quality checks limited to completeness and basic schema validation; representativeness ignored",
      "Quality criteria defined once at acquisition; never re-checked despite drift",
      "Issues identified but not remediated; the model is trained anyway"
    ],
    evidence_to_look_for: [
      { item: "Documented quality criteria per dataset", what_it_tells_you: "Whether criteria exist" },
      { item: "Quality check results", what_it_tells_you: "Whether criteria are verified" },
      { item: "Remediation records for identified issues", what_it_tells_you: "Whether issues are addressed" }
    ],
    scoping_notes: "Automated data-quality tools (Great Expectations, Soda, etc.) work well for repeatable checks. Representativeness usually needs a domain-specific analysis.",
    maturity_ladder: {
      1: "No quality criteria",
      2: "Criteria defined; checks run at acquisition",
      3: "Periodic re-checks; representativeness analysed; remediation tracked",
      4: "Quality metrics dashboarded; drift detection automated; quality-driven retraining"
    },
    related_items: ['ai-annex-a-7-3', 'ai-annex-a-7-5', 'ai-annex-a-6-2-6']
  },

  'ai-annex-a-7-5': {
    purpose: "Track data provenance - where the data came from and what was done to it - across both the data and AI system lifecycles. Supports audit, reproduction, and accountability.",
    what_good_looks_like: "A lineage record connects each model version to the specific dataset version(s) it was trained on, the transformations applied, and the upstream sources. The chain is reconstructable - given a model version, you can identify exactly what data was used. Tooling (DVC, MLflow data tracking, custom) supports the chain.",
    common_pitfalls: [
      "Data versioning absent; \"the same dataset\" is used but it's actually evolved over time",
      "Lineage stops at the dataset; transformations within the training pipeline aren't recorded",
      "Reconstruction fails - the model can't be retrained from the recorded lineage"
    ],
    evidence_to_look_for: [
      { item: "Lineage records per model version", what_it_tells_you: "Whether lineage exists" },
      { item: "Reconstruction test - retrain from lineage and confirm reproducibility", what_it_tells_you: "Whether lineage is operationally complete" },
      { item: "Transformation records", what_it_tells_you: "Whether the data pipeline is auditable" }
    ],
    scoping_notes: "ML platforms (MLflow, Weights & Biases, SageMaker) usually capture lineage natively. Use it; don't build a separate registry.",
    maturity_ladder: {
      1: "No lineage tracking",
      2: "Model version to dataset version mapping recorded",
      3: "Full transformation lineage; reproducible",
      4: "Lineage tested periodically; gaps trigger pipeline improvement"
    },
    related_items: ['ai-annex-a-7-3', 'ai-annex-a-7-4', 'ai-annex-a-7-6']
  },

  'ai-annex-a-7-6': {
    purpose: "Document data-preparation techniques used (cleaning, labelling, augmentation, anonymisation) and the rationale for the methods chosen.",
    what_good_looks_like: "Per dataset, a data-preparation record covers the techniques applied, the rationale for each (e.g., \"we down-sampled class A to address imbalance; we used near-duplicate detection on text to remove leakage\"), the parameters used, and the impact on the dataset (size change, distribution shift). Labelling protocols are documented including inter-annotator agreement where applicable. Anonymisation methods are validated against re-identification risk.",
    common_pitfalls: [
      "Preparation done in notebooks with no canonical record",
      "Labelling protocol undocumented; quality and consistency unknown",
      "Anonymisation chosen without validation; re-identification risk untested",
      "Augmentation applied without impact analysis on fairness"
    ],
    evidence_to_look_for: [
      { item: "Preparation record per dataset", what_it_tells_you: "Whether preparation is documented" },
      { item: "Labelling protocol with inter-annotator agreement where applicable", what_it_tells_you: "Whether labelling quality is real" },
      { item: "Anonymisation validation results", what_it_tells_you: "Whether de-identification is verified" }
    ],
    scoping_notes: "Synthetic data generation - if used - falls under preparation and needs the same documentation: generator, parameters, validation that synthetic distribution matches intended.",
    maturity_ladder: {
      1: "Preparation undocumented",
      2: "Documented; rationale included; impact noted",
      3: "Labelling protocols and inter-annotator agreement; anonymisation validated",
      4: "Preparation effectiveness reviewed; gaps inform methodology improvement"
    },
    related_items: ['ai-annex-a-7-2', 'ai-annex-a-7-4', 'ai-annex-a-7-5']
  },

  // A.8 Information for interested parties
  'ai-annex-a-8-2': {
    purpose: "Provide system documentation and plain-language information to users covering what the system does, its limits, failure modes, and oversight options.",
    what_good_looks_like: "Per AI system, user-facing documentation exists in plain language - what the system does, its intended use, known limits, known failure modes (and what they look like), prohibited / out-of-scope uses, how to flag concerns, who to contact, how human oversight applies. Aligned to the technical model card (A.6.2.7) but written for the audience. Feedback channels are linked. Updated as the system changes.",
    common_pitfalls: [
      "Documentation = the technical model card with no user adaptation",
      "Failure modes glossed over (\"the system may occasionally make errors\")",
      "No contact for concerns; user has no path",
      "Documentation buried in a deep menu nobody finds"
    ],
    evidence_to_look_for: [
      { item: "User-facing documentation per AI system", what_it_tells_you: "Whether users are served" },
      { item: "Plain-language failure modes and limits", what_it_tells_you: "Whether honesty is operational" },
      { item: "Working feedback channel linked from documentation", what_it_tells_you: "Whether users have a path" }
    ],
    scoping_notes: "For internal-only AI tools, the user is the employee using the tool. For customer-facing AI, it's the end customer. Adapt accordingly.",
    maturity_ladder: {
      1: "No user-facing documentation",
      2: "Documentation exists; covers required elements in plain language",
      3: "Updated on change; feedback channel active and used",
      4: "Documentation usability tested with users; iterated based on feedback"
    },
    related_items: ['ai-annex-a-6-2-7', 'ai-annex-a-8-3', 'ai-annex-a-9-4']
  },

  'ai-annex-a-8-3': {
    purpose: "External reporting mechanism for affected parties to report problems with the AI system. The outward-facing counterpart to A.3.3 (internal concerns).",
    what_good_looks_like: "A public-facing channel for reporting AI-related concerns - typically a web form, an email address, or both - is discoverable (linked from product pages, terms, help centre). Submissions are triaged and acknowledged within an SLA. Common categories (bias surfacing, incorrect outputs, safety concerns, privacy concerns) are tracked. Reports feed the NC process (10.2) and the impact-assessment refresh (8.4) where they reveal systemic issues.",
    common_pitfalls: [
      "Channel exists but is buried; affected users can't find it",
      "Channel exists but submissions go unanswered",
      "Reports not connected to AIMS - they're handled by support and never reach the AI team"
    ],
    evidence_to_look_for: [
      { item: "Discoverable external reporting channel", what_it_tells_you: "Whether the channel is available" },
      { item: "Triage SLA and response records", what_it_tells_you: "Whether reports get a real response" },
      { item: "Categorised log of reports and their resolutions", what_it_tells_you: "Whether the data is mined for patterns" }
    ],
    scoping_notes: "Where the AI is embedded in a larger product, the channel can ride on the existing product feedback - what matters is that AI-relevant reports are recognised and routed.",
    maturity_ladder: {
      1: "No channel for external reporting",
      2: "Channel exists; submissions triaged",
      3: "SLA met; reports categorised and trended; feed NC and impact refresh",
      4: "Channel effectiveness measured; usability of channel improved"
    },
    related_items: ['ai-annex-a-3-3', 'ai-annex-a-8-2', 'ai-annex-a-8-4']
  },

  'ai-annex-a-8-4': {
    purpose: "Plan in advance the communication of AI incidents to interested parties, aligned with regulatory and contractual obligations.",
    what_good_looks_like: "An AI incident communication plan defines: incident types (bias surfacing, harm to a user, model performance failure, security breach, unauthorised use), notification audiences per type (affected users, regulators, customers, public), timing requirements (regulatory deadlines, contractual), pre-approved templates, and authority to release. The plan is exercised at least annually via tabletop or real-event review.",
    common_pitfalls: [
      "Incident response exists but doesn't address AI-specific incidents",
      "Templates absent - real incidents drafted under pressure",
      "Regulatory notification timelines unknown until day-of",
      "Plan never exercised"
    ],
    evidence_to_look_for: [
      { item: "AI incident communication plan with audiences, timing, templates", what_it_tells_you: "Whether comms are planned" },
      { item: "Exercise records (tabletop or real)", what_it_tells_you: "Whether the plan works" },
      { item: "Sample of pre-approved templates", what_it_tells_you: "Whether response time will be short" }
    ],
    scoping_notes: "Coordinate with overall incident response, privacy breach notification, and crisis comms - the AI section is an extension, not a parallel plan.",
    maturity_ladder: {
      1: "No AI-specific incident comms",
      2: "Plan documented; templates and authorities defined",
      3: "Plan exercised; lessons applied",
      4: "Plan exercised on multiple scenarios; effectiveness measured against real events"
    },
    related_items: ['ai-clause-7.4', 'ai-annex-a-8-3', 'ai-clause-10.2']
  },

  'ai-annex-a-8-5': {
    purpose: "Decide what information to share proactively with interested parties - regulators, customers, partners, public - about the organization's AI activities. Transparency beyond what's mandated.",
    what_good_looks_like: "A disclosure strategy distinguishes mandatory disclosures (regulatory) from proactive ones (transparency reports, public AI register, model cards). Each disclosure has an owner, schedule, and approval. Disclosures are consistent across audiences and dated. Transparency builds trust without creating security or competitive risk.",
    common_pitfalls: [
      "All disclosures pushed externally without internal alignment - statements conflict",
      "Public AI register exists but isn't updated; trust erodes",
      "Mandatory disclosures missed because nobody owns the schedule"
    ],
    evidence_to_look_for: [
      { item: "Disclosure strategy listing mandatory and proactive items", what_it_tells_you: "Whether disclosures are planned" },
      { item: "Recent disclosures (transparency report, AI register)", what_it_tells_you: "Whether the strategy is executed" },
      { item: "Approval records per disclosure", what_it_tells_you: "Whether disclosures are governed" }
    ],
    scoping_notes: "Public AI registers are increasingly required (EU AI Act high-risk obligations) or expected by sector. Setting up the register early - even before required - simplifies later compliance.",
    maturity_ladder: {
      1: "Disclosures ad hoc; no strategy",
      2: "Strategy documented; mandatory disclosures on schedule",
      3: "Proactive disclosures published; updated; approved",
      4: "Disclosure effectiveness measured (regulator feedback, partner usage); strategy iterates"
    },
    related_items: ['ai-clause-7.4', 'ai-annex-a-8-2', 'ai-annex-a-8-4']
  },

  // A.9 Use of AI systems
  'ai-annex-a-9-2': {
    purpose: "Defines processes for the responsible use of AI systems in operation - oversight, escalation, acceptable-use boundaries. The runtime counterpart to A.6.x (which is about build / deploy).",
    what_good_looks_like: "Per deployed AI system, a use procedure covers: who is authorised to use it, what they can use it for (intended use), how they exercise judgement vs defer to outputs, when they must escalate (low confidence, edge case, unexpected behaviour), and how to suspend use. The procedure is part of operational training for users. Real overrides and escalations are logged and reviewed.",
    common_pitfalls: [
      "Use is assumed to be self-explanatory; no procedure",
      "Override authority unclear - user is not sure whether they can ignore the AI output",
      "Escalation criteria absent or vague",
      "No log of overrides; no learning from how the system is used in practice"
    ],
    evidence_to_look_for: [
      { item: "Use procedure per AI system", what_it_tells_you: "Whether use is governed" },
      { item: "User training records including use procedure", what_it_tells_you: "Whether users know the rules" },
      { item: "Override and escalation log", what_it_tells_you: "Whether use is observable" }
    ],
    scoping_notes: "For high-stakes systems (medical, legal, hiring), use procedures and human oversight typically need to be specific and well-trained. For low-stakes systems, lighter guidance is fine.",
    maturity_ladder: {
      1: "No use procedure",
      2: "Procedure per system; user training in place",
      3: "Overrides logged; escalations reviewed; suspended-use criteria applied",
      4: "Use patterns analysed; lessons feed system improvement and procedure refinement"
    },
    related_items: ['ai-annex-a-6-2-6', 'ai-annex-a-9-3', 'ai-annex-a-9-4']
  },

  'ai-annex-a-9-3': {
    purpose: "Defines responsible-use objectives - operational reference points for users and operators. The operational-use counterpart to A.6.1.2 (responsible-development objectives).",
    what_good_looks_like: "Use objectives are defined per AI system or system class - e.g., \"human reviewer signs off on all high-impact decisions\", \"acceptable error rate threshold for category X is N%\", \"customer-facing AI outputs include a disclaimer\". Measurable where practicable. Communicated to users. Achievement is monitored as part of operational metrics.",
    common_pitfalls: [
      "Objectives expressed as principles, not operational targets",
      "Objectives set centrally but not communicated to operational teams",
      "Achievement not monitored - objectives are aspirational"
    ],
    evidence_to_look_for: [
      { item: "Use objectives per system or class", what_it_tells_you: "Whether objectives exist" },
      { item: "Communication and training records", what_it_tells_you: "Whether users know them" },
      { item: "Monitoring of objective achievement", what_it_tells_you: "Whether objectives drive behaviour" }
    ],
    scoping_notes: "Use objectives often map to KPIs the team is already tracking - identifying that mapping is the easiest path.",
    maturity_ladder: {
      1: "No use objectives",
      2: "Objectives documented; communicated",
      3: "Achievement monitored; missed targets trigger response",
      4: "Objectives evolve with operational learning; lessons fed back"
    },
    related_items: ['ai-annex-a-9-2', 'ai-annex-a-9-4', 'ai-clause-6.2']
  },

  'ai-annex-a-9-4': {
    purpose: "Control the use of each AI system to its intended use. Prevent scope creep and unintended repurposing.",
    what_good_looks_like: "Per AI system, the intended use is documented (in the deployment plan, user documentation, model card). Out-of-scope uses are explicit. Proposed expansions trigger a fresh impact assessment and approval. Monitoring detects use patterns that fall outside intended scope. Where misuse occurs, response is defined.",
    common_pitfalls: [
      "Intended use documented vaguely - any use falls inside the description",
      "Repurposing happens informally - \"we found it also works for X\" without re-assessment",
      "Misuse occurs but isn't recognised because monitoring isn't scoped to detect it"
    ],
    evidence_to_look_for: [
      { item: "Intended-use statement per AI system", what_it_tells_you: "Whether intent is documented" },
      { item: "Repurpose approval records", what_it_tells_you: "Whether expansions are controlled" },
      { item: "Monitoring or audit records of actual use patterns", what_it_tells_you: "Whether actual use is observable" }
    ],
    scoping_notes: "Foundation models (LLMs, etc.) are inherently general-purpose - the intended-use control is on how the organization deploys the foundation model in a specific application, not on the underlying model.",
    maturity_ladder: {
      1: "Intended use not specified",
      2: "Statement per system; expansions require approval",
      3: "Use patterns monitored; misuse identified and responded to",
      4: "Intended-use boundaries periodically reviewed against actual use; misuse trends inform redesign or restriction"
    },
    related_items: ['ai-annex-a-6-1-3', 'ai-annex-a-9-2', 'ai-clause-6.3']
  },

  // A.10 Third-party and customer relationships
  'ai-annex-a-10-2': {
    purpose: "Allocate responsibilities along the AI supply chain - providers, developers, deployers, customers. The organization must know what is its responsibility, what is somebody else's, and where the handover lines are.",
    what_good_looks_like: "Per third-party AI relationship, a responsibility matrix or contract appendix specifies what each party is responsible for - data provided, model behaviour, monitoring, incident notification, impact assessment cooperation, regulatory cooperation. Aligned with the role determination from 4.1. Reviewed when the relationship or AI changes.",
    common_pitfalls: [
      "Standard procurement contract used; AI-specific allocations missing",
      "Responsibility for incident notification undefined - in a real event, parties point at each other",
      "Customer-facing contracts don't reflect AI obligations the organization must pass through"
    ],
    evidence_to_look_for: [
      { item: "Responsibility matrix or contract appendix per AI relationship", what_it_tells_you: "Whether responsibilities are explicit" },
      { item: "Cross-reference to organizational role determination (4.1)", what_it_tells_you: "Whether allocation matches role" },
      { item: "Review records on relationship or AI changes", what_it_tells_you: "Whether allocation stays current" }
    ],
    scoping_notes: "EU AI Act introduces specific allocations between providers, deployers, and importers - contracts in scope of EU AI Act need to reflect those.",
    maturity_ladder: {
      1: "Allocation not documented",
      2: "Matrix per relationship; covers key responsibilities",
      3: "Reflected in contracts; reviewed on change",
      4: "Allocation effectiveness reviewed (e.g., were responsibilities clear in real incidents?); refined"
    },
    related_items: ['ai-clause-4.1', 'ai-annex-a-10-3', 'ai-annex-a-10-4']
  },

  'ai-annex-a-10-3': {
    purpose: "Manage suppliers of AI systems, services, components, and data against responsible-AI expectations. Includes vetting at onboarding and ongoing oversight.",
    what_good_looks_like: "AI suppliers are identified in the supplier register with AI dependencies flagged. Onboarding due diligence covers responsible-AI maturity (policies, controls, evidence). Contracts include AIMS-relevant clauses (notification, cooperation, data handling, model change). Ongoing oversight - monitoring vendor model changes, reviewing transparency reports, periodic reassessment - is in place. Risk-tiered (high-risk vendors get heavier diligence).",
    common_pitfalls: [
      "AI suppliers not flagged in supplier register; treated as generic vendors",
      "Foundation-model API providers (OpenAI, Anthropic, Google) treated as commodity; no oversight when they update models",
      "Annotation vendors not in scope; treated as IT vendors",
      "Onboarding diligence performed once; never refreshed"
    ],
    evidence_to_look_for: [
      { item: "Supplier register flagging AI dependencies", what_it_tells_you: "Whether AI suppliers are visible" },
      { item: "Onboarding diligence records (questionnaires, evidence requests)", what_it_tells_you: "Whether vetting is real" },
      { item: "Ongoing oversight records (model-change reviews, transparency report reviews)", what_it_tells_you: "Whether oversight is alive" }
    ],
    scoping_notes: "For foundation-model APIs, oversight requires monitoring the vendor's release notes and model versions - the model behind \"GPT-4\" changes more often than the name suggests.",
    maturity_ladder: {
      1: "AI suppliers not differentiated; generic vendor process applied",
      2: "AI suppliers flagged; AIMS clauses in contracts; onboarding diligence performed",
      3: "Risk-tiered oversight; ongoing monitoring of vendor model changes",
      4: "Vendor performance against AIMS expectations measured; underperformers replaced or remediated"
    },
    related_items: ['ai-clause-8.1', 'ai-annex-a-10-2', 'ai-annex-a-10-4']
  },

  'ai-annex-a-10-4': {
    purpose: "Factor customer obligations and duty of care into responsible-AI practices - transparency, support, complaint handling, protection from foreseeable misuse.",
    what_good_looks_like: "Customer-facing AI systems include adequate documentation (intended use, limits, contact for concerns), foreseeable misuses are considered and mitigated (rate limits, monitoring, prohibited-use enforcement), customer feedback is captured and used. Where the organization provides AI to other organizations (B2B), customer obligations to their own users are factored in via passthrough documentation and contract terms.",
    common_pitfalls: [
      "Documentation for customers absent or buried",
      "Foreseeable misuse not considered - the system is built for the intended use only, with no safeguards against off-label use",
      "Customer feedback collected but not used"
    ],
    evidence_to_look_for: [
      { item: "Customer-facing documentation including model cards", what_it_tells_you: "Whether customers can use the AI responsibly" },
      { item: "Misuse-mitigation controls (rate limits, content filters, monitoring)", what_it_tells_you: "Whether misuse is anticipated" },
      { item: "Customer feedback / complaint analysis", what_it_tells_you: "Whether feedback drives change" }
    ],
    scoping_notes: "For B2B AI, customer obligations cascade - the obligations the organization owes its customers, plus the obligations the customer must be able to meet to their own users.",
    maturity_ladder: {
      1: "Customer-facing obligations not addressed",
      2: "Documentation and basic mitigations in place",
      3: "Feedback captured and used; misuse controls active",
      4: "Customer obligations measured (e.g., satisfaction, complaint rates); improvements driven by customer experience"
    },
    related_items: ['ai-annex-a-8-2', 'ai-annex-a-9-4', 'ai-annex-a-10-2']
  }
};
