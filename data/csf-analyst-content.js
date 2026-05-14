// Placeholder content for the beginner-friendly Analyst workflow (Stage 11).
//
// Per handoff Section 14, the real text comes from a separate content
// workstream. This file holds enough placeholder material to validate the
// structures end-to-end and demo the workflow. Replace with real content as
// it lands.
//
// EXPLAINERS: 1-line plain "what" + 1-line "why" + bullet "signs of strength"
//             and "signs of weakness" per subcategory.
// QUESTIONS:  ~5-8 questions per subcategory across types
//             (open / probing / evidence-seeking / follow-up).
// PROMPTS:    types of documents / artefacts to ask for.
//
// Real content workstream will write into the csf_subcategory_* tables. This
// data file is a starter set that lights up the UI for a few GOVERN subcats.

const EXPLAINERS = [
  {
    sub_code: 'GV.OC-01',
    plain_what: "Does the organisation know what it's actually for, and does that purpose shape how it protects information?",
    plain_why: "If cybersecurity isn't grounded in the mission, controls drift toward generic and risks toward irrelevant - auditors spot this fast.",
    signs_of_strength: "Mission statement exists. Risk register references mission-critical activities. Security objectives map back to organisational outcomes. Top management can articulate why specific controls exist.",
    signs_of_weakness: "Mission is boilerplate. Risk register reads generically. Controls justified by 'industry best practice' rather than what the organisation does.",
  },
  {
    sub_code: 'GV.OC-02',
    plain_what: "Has the organisation identified the people and groups that care about its cybersecurity, and what they want?",
    plain_why: "Customers, regulators, suppliers, employees, investors all have different expectations. Missing them means missed controls and surprise complaints.",
    signs_of_strength: "Interested-parties register exists and is reviewed. Each stakeholder has a documented expectation. Compliance obligations are traced to specific requirements.",
    signs_of_weakness: "Register doesn't exist, or lists only 'customers' generically. No traceability from stakeholder needs to controls or policies.",
  },
  {
    sub_code: 'GV.OC-03',
    plain_what: "Has the organisation listed the laws, regulations, and contracts that constrain how it manages cybersecurity and privacy?",
    plain_why: "GDPR, HIPAA, sectoral rules, customer contracts - each imposes specific requirements. Missing one becomes a finding or worse a breach notification.",
    signs_of_strength: "Legal register exists and is reviewed. Each requirement maps to a control or policy. Privacy obligations addressed alongside cybersecurity.",
    signs_of_weakness: "Register limited to 'we follow GDPR'. No traceability to actual control implementation. Privacy treated separately from security or vice versa.",
  },
];

const QUESTIONS = [
  // GV.OC-01
  { sub_code: 'GV.OC-01', type: 'open', question: 'Tell me, in your own words, what the organisation does and what success looks like.' },
  { sub_code: 'GV.OC-01', type: 'open', question: 'How does cybersecurity fit into delivering that mission?' },
  { sub_code: 'GV.OC-01', type: 'probing', question: 'Can you point me to a document where this is written down?' },
  { sub_code: 'GV.OC-01', type: 'evidence-seeking', question: 'Is there a place I can see the mission statement or charter?' },
  { sub_code: 'GV.OC-01', type: 'evidence-seeking', question: 'Where in the risk register does the mission show up - is there a risk that references it?' },
  { sub_code: 'GV.OC-01', type: 'follow-up', question: 'When did you last revisit whether the mission still describes what you actually do?' },

  // GV.OC-02
  { sub_code: 'GV.OC-02', type: 'open', question: 'Who are the people and organisations that care about how you manage cybersecurity?' },
  { sub_code: 'GV.OC-02', type: 'probing', question: 'What does each of those parties expect from you specifically?' },
  { sub_code: 'GV.OC-02', type: 'evidence-seeking', question: 'Is there an interested-parties register I can look at?' },
  { sub_code: 'GV.OC-02', type: 'evidence-seeking', question: 'How do you confirm that an expectation has been addressed? Pick one party and walk me through it.' },
  { sub_code: 'GV.OC-02', type: 'follow-up', question: 'When you onboard a new major customer, how does their expectation make it into the register?' },

  // GV.OC-03
  { sub_code: 'GV.OC-03', type: 'open', question: 'Which laws, regulations, or contracts shape how you handle information?' },
  { sub_code: 'GV.OC-03', type: 'probing', question: 'How do you keep track of new ones as they come in?' },
  { sub_code: 'GV.OC-03', type: 'evidence-seeking', question: 'Show me where this is recorded.' },
  { sub_code: 'GV.OC-03', type: 'evidence-seeking', question: 'For one obligation - pick GDPR breach notification timelines - what specific control or process satisfies it?' },
  { sub_code: 'GV.OC-03', type: 'follow-up', question: 'When did you last review whether anything new applies to you?' },
];

const EVIDENCE_PROMPTS = [
  { sub_code: 'GV.OC-01', type: 'document', prompt: 'Mission statement / organisational charter' },
  { sub_code: 'GV.OC-01', type: 'document', prompt: 'Strategic plan or business plan (recent)' },
  { sub_code: 'GV.OC-01', type: 'register', prompt: 'Risk register entries that cite the mission explicitly' },
  { sub_code: 'GV.OC-02', type: 'register', prompt: 'Interested-parties register' },
  { sub_code: 'GV.OC-02', type: 'document', prompt: 'Customer / partner agreements showing cybersecurity requirements' },
  { sub_code: 'GV.OC-02', type: 'evidence', prompt: 'Email or meeting notes capturing a stakeholder request and how it was addressed' },
  { sub_code: 'GV.OC-03', type: 'register', prompt: 'Legal and regulatory register' },
  { sub_code: 'GV.OC-03', type: 'document', prompt: 'Privacy notices, data processing agreements' },
  { sub_code: 'GV.OC-03', type: 'evidence', prompt: 'Process or policy that demonstrates a specific obligation being met (e.g., breach notification SOP)' },
];

const SELF_CHECK_PROMPTS = [
  "Did you talk to someone with hands-on responsibility for this area, not just a manager describing it from above?",
  "Did you ask for evidence in writing rather than accepting verbal assurance?",
  "Is the narrative specific to this organisation, or could it apply to any company?",
  "Does the evidence you attached actually support the score you're proposing?",
  "If you marked any practice 'documented', did you read the document, or just confirm it exists?",
  "Did you flag anything that should be tracked as a finding before moving on?",
  "Have you noted anything that needs follow-up - something promised but not provided, or something you couldn't verify today?",
  "Would another consultant reach the same conclusion from your narrative and evidence?",
];

const LEARN_DOCS = [
  {
    slug: 'csf-2-primer',
    title: 'NIST CSF 2.0 primer',
    summary: 'What CSF 2.0 is, what changed from 1.1, how Functions, Categories, and Subcategories fit together.',
    display_order: 1,
    body_markdown: `# NIST CSF 2.0 Primer

NIST Cybersecurity Framework 2.0 was published February 2024 (NIST.CSWP.29). It's a taxonomy of cybersecurity outcomes - not controls, not implementation steps. The framework describes *what* good practice looks like; it leaves *how* to your team.

## The six Functions

CSF 2.0 has six Functions, in this order:

1. **GOVERN** *(new in 2.0)* - the organisation's strategy, expectations, and policy for managing cybersecurity risk
2. **IDENTIFY** - understanding the organisation's cybersecurity risks
3. **PROTECT** - safeguards to ensure delivery of services
4. **DETECT** - identifying cybersecurity events
5. **RESPOND** - taking action on a detected event
6. **RECOVER** - restoring capabilities after an event

The Functions should be addressed concurrently. They're a way of slicing the landscape, not a sequence.

## Categories and Subcategories

Each Function breaks down into Categories (22 total), and each Category breaks down into Subcategories (106 total). A Subcategory is a specific outcome - "internal and external stakeholders are understood..." - not an action.

## What changed from 1.1

- **GOVERN is new.** Most of what was scattered through 1.1's IDENTIFY (governance, risk management strategy) now lives here.
- Subcategory numbering preserves gaps where 1.1 items were relocated - this is intentional, not a typo.
- 106 Subcategories in 2.0 vs 108 in 1.1.

## How this tool uses CSF

For each engagement, every Subcategory is assessed on a CMMI 1-5 scale. Scores roll up to Category, Function, and Overall. A Tier overlay (1 Partial / 2 Risk Informed / 3 Repeatable / 4 Adaptive) is applied at Function and Overall.

The framework doesn't prescribe scoring - the CMMI overlay is this tool's choice, in line with how MSSPs typically score for clients.

## What this primer doesn't cover

How to actually conduct the assessment, how to write up findings, how to gather evidence - those are in the other Learn documents. Read them next.
`,
  },
  {
    slug: 'interview-techniques',
    title: 'Interview techniques',
    summary: 'How to ask, listen, and write up the conversation so it stands up to review.',
    display_order: 2,
    body_markdown: `# Interview techniques

> This is a placeholder Learn document. Real content lands as the content workstream completes - see Section 14 of the design.

## The shape of a good interview

Three phases: warm-up, structured questions, follow-up.

- **Warm-up** establishes who's in the room and what their day-to-day actually involves.
- **Structured questions** walk through the Subcategories in scope for this interviewee's role.
- **Follow-up** asks for the evidence to back up what was said.

## Things to avoid

- Leading questions ("you do X, right?")
- Accepting verbal assurance without evidence
- Skipping to the score in your head while still listening

## What to write down

Specific names, dates, document titles, system names, control IDs. Generic phrasing ("policy is in place") is useless on review.

*Full content forthcoming.*
`,
  },
  {
    slug: 'evidence-handling',
    title: 'Evidence handling',
    summary: 'What counts as evidence, how to attribute it, how to know when it\'s enough.',
    display_order: 3,
    body_markdown: `# Evidence handling

> This is a placeholder Learn document. Real content lands as the content workstream completes - see Section 14 of the design.

## What counts as evidence

- **Documents**: policies, procedures, records, signed approvals
- **Configuration**: system settings, tool output, screenshots with timestamps
- **Interviews**: attributed quotes with role + date

## What doesn't count

- "Someone said so" without attribution
- Documents you didn't actually open
- Screenshots without context

## How much is enough

For each Subcategory you should have at least one piece of evidence before scoring. For controls with operational test cases (logging, monitoring, access reviews), evidence should show the practice operating over time, not just existing.

*Full content forthcoming.*
`,
  },
  {
    slug: 'glossary',
    title: 'Glossary',
    summary: 'Terms used in CSF assessments. Cross-references the existing ISO 27001 glossary where overlapping.',
    display_order: 4,
    body_markdown: `# Glossary

> This is a placeholder Learn document. Real content lands as the content workstream completes - see Section 14 of the design.

## CSF-specific terms

- **Function** - top-level grouping of cybersecurity outcomes. Six in CSF 2.0.
- **Category** - subdivision of a Function. 22 in CSF 2.0.
- **Subcategory** - the most granular outcome. 106 in CSF 2.0.
- **Tier** - implementation maturity overlay (1 Partial / 2 Risk Informed / 3 Repeatable / 4 Adaptive).
- **Profile** - a specific snapshot of which Subcategories the organisation is targeting at what Tier.

## Tool-specific terms

- **Engagement** - one CSF assessment of one client over one period.
- **Version** - an immutable published snapshot. v1.0 is the first publish; republish increments the minor (v1.1, v1.2, ...).
- **Weighting profile** - per-engagement weights applied to each Subcategory in the rollup. Default = 1.0 across the board.

*Full content forthcoming. See also the existing ISO 27001 glossary at /workspaces/:wsId/glossary - many terms are shared.*
`,
  },
];

module.exports = { EXPLAINERS, QUESTIONS, EVIDENCE_PROMPTS, SELF_CHECK_PROMPTS, LEARN_DOCS };
