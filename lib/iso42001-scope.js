'use strict';

// The ISO 42001 scoping intake: the questions a consultant asks at kickoff and
// the draft AIMS scope statement (clause 4.3) they compose. The route saves
// the answers; the page redraws the boundary and the statement from the same
// definitions as the consultant types, so server and browser never disagree.

// `short` names a question on the boundary map. `layer` places it: the AI
// systems at the core, the organisation around them, its obligations and
// interested parties outside that, and the data and third-party services that
// cross the boundary as dependencies (clause 4.3 asks for all four).
const SECTIONS = [
  {
    title: 'Context & roles',
    blurb: 'Set the AIMS in the right context. Clauses 4.1, 4.2.',
    questions: [
      { id: 'org-context', short: 'AI maturity', layer: 'org', text: 'How would you describe your organization\'s AI maturity (early experimentation / pilots in production / AI is core to product / AI native)?', type: 'textarea', clause: '4.1', required: true },
      { id: 'role', short: 'Role', layer: 'org', text: 'Which roles does the organization play with respect to AI systems in scope (provider / developer / deployer / customer / multiple)?', type: 'textarea', clause: '4.1', required: true, hint: 'Different roles bring different obligations - especially under EU AI Act.' },
      { id: 'regulatory', short: 'Regulation', layer: 'obligations', text: 'Which AI-specific regulations or frameworks apply (EU AI Act, NIST AI RMF, sectoral regulation, internal commitments)?', type: 'textarea', clause: '4.2', required: true },
      { id: 'interested-parties', short: 'Interested parties', layer: 'obligations', text: 'Who are the interested parties for the AIMS (regulators, customers, employees, suppliers, affected individuals, civil-society)?', type: 'textarea', clause: '4.2', hint: 'List by category. Affected individuals - non-customers the AI decides about - are often missed.' },
    ],
  },
  {
    title: 'AI footprint',
    blurb: 'What AI is actually in scope. Clauses 4.3, A.4.',
    questions: [
      { id: 'system-count', short: 'Systems', layer: 'core', text: 'How many AI systems are currently in production or pilot? Briefly describe the largest 3.', type: 'textarea', clause: '4.3', required: true },
      { id: 'ai-types', short: 'AI types', layer: 'core', text: 'What types of AI are in scope (classical ML, generative AI / LLMs, computer vision, NLP, reinforcement learning, hybrid)?', type: 'text', clause: '4.3' },
      { id: 'use-cases', short: 'High-stakes uses', layer: 'core', text: 'What are the highest-stakes AI use cases (people-affecting decisions, automated actions, safety-critical, public-facing)?', type: 'textarea', clause: '4.3' },
      { id: 'high-risk', short: 'Risk class', layer: 'core', text: 'Are any of the AI systems high-risk under the EU AI Act or equivalent classification?', type: 'text', clause: '4.2' },
      { id: 'data', short: 'Data sources', layer: 'edge', text: 'What are the major data sources powering AI systems (proprietary, customer, public datasets, scraped, synthetic, third-party brokers)?', type: 'textarea', clause: 'A.7.3' },
      { id: 'third-party', short: 'Third-party AI', layer: 'edge', text: 'Which third-party AI services are critical dependencies (foundation-model APIs, ML platforms, annotation vendors)?', type: 'textarea', clause: 'A.10.3' },
    ],
  },
  {
    title: 'Governance & risk',
    blurb: 'Current state of AI governance. Clauses 5.1, 5.3, 6.1.',
    questions: [
      { id: 'governance', short: 'Governance', layer: 'org', text: 'What AI governance structure exists today (AI ethics board, model-review committee, ad-hoc, none)?', type: 'textarea', clause: '5.3' },
      { id: 'risk-appetite', short: 'Risk appetite', layer: 'org', text: 'What is the organization\'s stated risk appetite for AI (low / moderate / high / not yet defined)?', type: 'text', clause: '6.1.2' },
      { id: 'incidents', short: 'Past incidents', layer: 'org', text: 'Have there been past AI incidents or near-misses (model failures, bias surfacing, safety events, complaints)?', type: 'textarea', clause: '10.2' },
      { id: 'ethics-published', short: 'Principles', layer: 'org', text: 'Are responsible-AI principles formally published or communicated externally?', type: 'text', clause: '5.2' },
    ],
  },
  {
    title: 'Engagement scope',
    blurb: 'What this engagement will deliver.',
    questions: [
      { id: 'top-concerns', short: 'Top concerns', layer: 'engagement', text: 'What are the top 3 concerns you want the AIMS to address?', type: 'textarea', required: true },
      { id: 'target-cert-date', short: 'Target date', layer: 'engagement', text: 'Target certification date (if any)', type: 'date' },
    ],
  },
];

const QUESTIONS = SECTIONS.flatMap(s => s.questions.map(q => ({ key: q.id, label: q.text })));

const LAYERS = [
  { key: 'obligations', name: 'Obligations and interested parties', clause: '4.2' },
  { key: 'org', name: 'The organisation', clause: '4.1, 5, 6' },
  { key: 'core', name: 'AI systems in scope', clause: '4.3' },
  { key: 'edge', name: 'Dependencies across the boundary', clause: 'A.7.3, A.10.3' },
];

// The lines of the scope statement, in the order they are written.
const STATEMENT_FIELDS = [
  { key: 'role', label: 'Organizational role(s)' },
  { key: 'org-context', label: 'AI maturity context' },
  { key: 'system-count', label: 'AI systems in scope' },
  { key: 'ai-types', label: 'AI types covered' },
  { key: 'use-cases', label: 'Highest-stakes use cases' },
  { key: 'high-risk', label: 'Regulatory classification' },
  { key: 'regulatory', label: 'Applicable AI obligations' },
  { key: 'data', label: 'Data sources' },
  { key: 'third-party', label: 'Third-party AI dependencies' },
];

function buildDraftScope(answers) {
  const ans = (k) => (answers[k] || '').trim();
  const lines = ['AIMS Scope (Clause 4.3) - draft from intake answers', ''];
  for (const f of STATEMENT_FIELDS) if (ans(f.key)) lines.push(`${f.label}: ${ans(f.key)}`);
  if (lines.length === 2) lines.push('(answer intake questions above to generate scope)');
  return lines.join('\n');
}

module.exports = { SECTIONS, QUESTIONS, LAYERS, STATEMENT_FIELDS, buildDraftScope };
