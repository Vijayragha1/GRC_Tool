// Consultant playbooks: kickoff agenda, scoping workshop kit, risk-workshop
// facilitator script. These are read-only walkthroughs the consultant runs
// during a live client meeting. Each playbook is a structured sequence of
// timed segments with prompts, example answers, and "do not skip this"
// notes drawn from real engagement experience.
//
// Editing here propagates on next page render — no migrations.

const KICKOFF_AGENDA = {
  id: 'kickoff',
  title: 'Kickoff workshop — 60 minutes',
  blurb: 'Run this on the first call with the client sponsor + ISMS coordinator. Outcome: scope confirmed, owner assigned, intake homework sent.',
  whoToInvite: ['Client sponsor (CISO/CTO/COO — has budget)', 'ISMS coordinator (will do the work)', 'One IT/security lead'],
  prework: [
    'Send the engagement intake link 3 days before. Ask them to fill at least the business-context section.',
    'Read whatever they\'ve filled. Note the cert deadline if any.',
    'Ask if they\'d like one of their customer security questionnaires shared with you on the call — it\'s the fastest way to gauge maturity.',
  ],
  segments: [
    { time: '0–5 min', title: 'Welcome & introductions',
      script: [
        'State the meeting outcome out loud: "By the end of this call you\'ll know what we\'ll do over the next 12 weeks, who owns what, and what to expect from a Stage 1 audit."',
        'Ask each attendee for their role and their personal stake in this certification.',
      ] },
    { time: '5–15 min', title: 'Why ISO 27001 — the business driver',
      script: [
        'Confirm what\'s driving the cert (customer mandate, tender, regulator). Pin the deadline.',
        'Calibrate stakes: is this a "nice to have" or a "this account leaves if we don\'t have it by Q4"?',
        'Set expectations: ISO 27001 is a ~12-week first-pass build; surveillance audits annually.',
      ],
      decisions: ['Hard deadline (recorded in workspace settings)', 'Sponsor name (recorded in interested parties)'] },
    { time: '15–30 min', title: 'Scope walk',
      script: [
        'Open the intake page on screen. Walk the scope section together.',
        'Ask: "If a customer asked tomorrow which products are certified, what would you say?" — that\'s your scope.',
        'Identify exclusions explicitly. "Internal HR" is fine. "We just don\'t want to" is not.',
        'Cloud providers: name them. AWS region matters for data residency.',
      ],
      decisions: ['Products in scope', 'Locations in scope', 'Cloud providers in scope', 'Exclusions + justifications'] },
    { time: '30–45 min', title: 'How we\'ll work — the 12-week plan',
      script: [
        'Open the engagement plan page. Walk the 12 weeks at a high level — kickoff → scope → risk → treatment → policies → audit → MRM → readiness pack.',
        'Highlight the three checkpoints: end-of-scope, end-of-policy-pack, Stage 1 readiness review.',
        'Be honest about effort: client owns ~20% of the work (evidence collection, sign-offs, awareness comms).',
      ],
      decisions: ['Cadence: weekly check-in vs biweekly', 'Working sessions or written deliverables?'] },
    { time: '45–55 min', title: 'Roles & owners',
      script: [
        'Confirm the ISMS owner (sponsor). They sign off the policy pack and chair the management review.',
        'Confirm the ISMS coordinator (day-to-day). They live in the tool.',
        'Identify the document approver if different from sponsor.',
        'Ask about an internal audit owner — usually the coordinator, or it can be us in year 1.',
      ],
      decisions: ['ISMS owner name', 'ISMS coordinator name', 'Document approver name'] },
    { time: '55–60 min', title: 'Close + homework',
      script: [
        'Recap decisions made today.',
        'Hand over homework: finish the intake (all 25 questions) by next Friday.',
        'Book the scoping workshop for week 2.',
      ] },
  ],
  artefactsProduced: [
    'Workspace settings updated: target cert date, sponsor, scope draft',
    'Interested-parties register seeded with sponsor + key customers',
    'Engagement plan: week 1 milestones marked done',
  ],
};

const SCOPING_WORKSHOP = {
  id: 'scoping',
  title: 'Scoping workshop — 90 minutes',
  blurb: 'Run this in week 2, after the client has filled the intake. Outcome: the clause 4.3 scope statement that goes on the certificate, and the asset register seeded with crown jewels.',
  whoToInvite: ['ISMS coordinator', 'Engineering lead (knows the architecture)', 'Product or data lead (knows what data lives where)'],
  prework: [
    'Print or share-screen the intake answers.',
    'Have the cloud architecture diagram in front of you. If they don\'t have one, draw it on the call.',
    'Read the BSI scoping guidance for their sector if you haven\'t for this sector before.',
  ],
  segments: [
    { time: '0–10 min', title: 'Re-state the scope draft',
      script: [
        'Read the auto-drafted clause 4.3 statement out loud.',
        'Ask: "If an auditor reads this, would they know exactly what to test?" — concrete, not aspirational.',
      ] },
    { time: '10–35 min', title: 'Walk the architecture',
      script: [
        'On the diagram, circle in scope. Mark exclusions with a different colour.',
        'For each system/service: what data flows through it? Who maintains it?',
        'Identify shared services (SSO, monitoring, backups) — usually in scope by default.',
      ],
      decisions: ['Final list of in-scope systems', 'Annotated diagram saved as evidence'] },
    { time: '35–55 min', title: 'Crown jewels',
      script: [
        '"What 3-5 things, if compromised, end the business?" Don\'t accept "everything." Push for specifics.',
        'For each crown jewel: where does it live, who can read it, who can write it, what\'s its retention?',
      ],
      decisions: ['3-5 crown jewels with location + owner'] },
    { time: '55–75 min', title: 'Asset register seed',
      script: [
        'From the architecture, list the supporting assets: databases, repos, SaaS apps, key admin accounts.',
        'Aim for 30-50 asset entries. More than 50 is too granular; fewer than 30 means you\'re missing stuff.',
        'For each: classification (public/internal/confidential/restricted), owner, location.',
      ],
      decisions: ['Asset register populated with 30-50 entries', 'Owner per asset'] },
    { time: '75–90 min', title: 'Confirm and close',
      script: [
        'Read the final scope statement back. Get verbal sign-off from sponsor (or coordinator if delegated).',
        'Lock the scope in workspace settings.',
        'Set up the next session: risk methodology + risk workshop in week 3.',
      ] },
  ],
  artefactsProduced: [
    'Final clause 4.3 scope statement — saved to workspace.scope',
    'Asset register populated (30-50 entries)',
    'Crown-jewel list signed off',
    'Annotated architecture diagram uploaded as evidence',
  ],
  watchOuts: [
    'Scope creep: clients want "everything in." That doubles the audit cost. Push back on anything that doesn\'t serve the business driver.',
    'Vague scope: "our SaaS platform" is not enough. List products by name.',
    'Cloud regions: AWS us-east-1 vs eu-west-1 matters for data residency. Pin the region.',
  ],
};

const RISK_WORKSHOP = {
  id: 'risk-workshop',
  title: 'Risk workshop — 90 minutes',
  blurb: 'Run this in week 3 after the methodology is approved. Outcome: 30+ scored risks in the register, top 5 risks with treatment direction, sponsor aligned on appetite.',
  whoToInvite: [
    'ISMS coordinator (mandatory — they own the register)',
    'Engineering lead (knows the technical exposures)',
    'Product/data lead (knows the business exposures)',
    'Optionally: legal/privacy if regulated data is in scope',
  ],
  prework: [
    'Walk the methodology with the coordinator beforehand. They should know the 5×5 matrix going in.',
    'Pre-load the workspace risk register with the 40-risk starter library so the workshop is editing/scoring, not creating from scratch.',
    'Print the methodology page. Have it on the table.',
  ],
  segments: [
    { time: '0–10 min', title: 'Anchor the methodology',
      script: [
        'Read the L×I scales out loud. Make sure everyone agrees what "Likelihood = 4" actually means in calendar time.',
        'Calibrate impact: "1 hour outage = 2, 1 day = 3, 1 week = 5" — make it concrete to their business.',
        'State the workshop rule: "You don\'t need to be right, you need to be defensible. Auditors read minutes — write down the reasoning."',
      ] },
    { time: '10–35 min', title: 'Identify — what could go wrong?',
      script: [
        'For each crown jewel and each top-tier asset: brainstorm threats.',
        'Use prompts: confidentiality (someone reads it who shouldn\'t), integrity (it gets changed wrongly), availability (we lose access).',
        'Don\'t score yet. Just generate.',
        'Aim for 25-30 candidate risks. The starter library is a checklist — confirm or skip each.',
      ],
      decisions: ['Candidate risk list (unsorted)'] },
    { time: '35–60 min', title: 'Score — likelihood × impact',
      script: [
        'For each risk, two questions: "How often have you seen this happen anywhere?" and "If it happened to us tomorrow, what\'s the worst day look like?"',
        'Score L (1-5), I (1-5). The product is the inherent risk score.',
        'If two people disagree by more than 1, write down both views. The disagreement IS the audit evidence.',
        'Watch for L=5 / I=5 — those are catastrophic. Stop and confirm.',
      ],
      decisions: ['Each risk scored L and I, with reasoning text'] },
    { time: '60–80 min', title: 'Treatment direction',
      script: [
        'For each risk above the appetite line: what\'s the treatment? Mitigate, transfer, accept, avoid?',
        'Don\'t solve here. Just direction. "Mitigate via additional access controls" is enough — the RTP fills the detail.',
        'For accepted risks: the sponsor MUST accept in writing. Note who accepts.',
      ],
      decisions: ['Treatment per above-appetite risk', 'Risk owner per risk', 'Acceptance log for accepted risks'] },
    { time: '80–90 min', title: 'Top 5 + close',
      script: [
        'Identify the top 5 by inherent score. Read them out.',
        'Sponsor: "Are these the things that keep you up at night?" If not, the workshop is incomplete — what\'s missing?',
        'Schedule the RTP review for next week.',
      ] },
  ],
  artefactsProduced: [
    'Risk register: 30+ risks with L, I, owner, treatment direction, reasoning',
    'Top-5 risks signed off by sponsor',
    'Acceptance log for accepted risks',
  ],
  watchOuts: [
    'Score inflation: every risk ends up 4×4. Force differentiation — at least 5 risks must be in the bottom-left quadrant.',
    'Tech-only thinking: the workshop must include business risks (key-person dependency, supplier failure, fraud, regulatory).',
    'Silent disagreement: capture it. The risk register is the audit artefact, not the consensus.',
    'Acceptance without sign-off: don\'t accept any risk verbally. Written sign-off, or it\'s not accepted.',
  ],
};

const PLAYBOOKS = {
  kickoff: KICKOFF_AGENDA,
  scoping: SCOPING_WORKSHOP,
  'risk-workshop': RISK_WORKSHOP,
};

const PLAYBOOK_INDEX = [
  { id: 'kickoff', title: KICKOFF_AGENDA.title, blurb: KICKOFF_AGENDA.blurb, when: 'Week 1' },
  { id: 'scoping', title: SCOPING_WORKSHOP.title, blurb: SCOPING_WORKSHOP.blurb, when: 'Week 2' },
  { id: 'risk-workshop', title: RISK_WORKSHOP.title, blurb: RISK_WORKSHOP.blurb, when: 'Week 3' },
];

module.exports = { PLAYBOOKS, PLAYBOOK_INDEX };
