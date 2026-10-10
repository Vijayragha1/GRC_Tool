'use strict';

// The organisation's role for each AI system (clause 4.1), from plain
// questions rather than role names.
//
// Clause 4.1 note 1 lists the roles, after ISO/IEC 22989: AI providers, AI
// producers (which there include developers, deployers and operators), AI
// customers (which include AI users), AI partners (integrators and data
// providers), AI subjects and relevant authorities. The note adds that the
// roles can decide which requirements and controls apply, and how far. The
// register keeps the four roles an organisation holds towards a system
// (lib/ai-systems.js ROLES); subjects and authorities are interested parties.
//
// Role names mislead: the EU AI Act calls the organisation that uses a system
// its deployer, where the standard counts deployers among producers. So the
// module asks what the organisation does with each system and derives the
// roles. The question that matters most is the second: a user that trains or
// fine-tunes a model, or connects it to its own data, has become the
// producer of that system.

// Question -> the role a "yes" gives. One place, so the mapping can be argued
// with and tested on its own.
const QUESTIONS = Object.freeze([
  { key: 'builds', role: 'producer',
    text: 'Do you design or build it?',
    hint: 'Including the prompts, workflows and integrations you build around a supplier\'s model.' },
  { key: 'trains', role: 'producer',
    text: 'Do you train or fine-tune a model for it, or connect it to your own data?',
    hint: 'For example, search over your own documents. This makes you its producer, even when the model is a supplier\'s.' },
  { key: 'sourced', role: 'customer',
    text: 'Does it, or the model inside it, come from a supplier?',
    hint: 'Bought, subscribed to, or called through an API.' },
  { key: 'uses', role: 'customer',
    text: 'Do you use it in your own work or decisions?',
    hint: 'Staff using it, or its outputs feeding your decisions.' },
  { key: 'offers', role: 'provider',
    text: 'Do people outside the organisation use it, or get its outputs, as your product or service?',
    hint: 'Customers, partners or the public.' },
  { key: 'partners', role: 'partner',
    text: 'Do you integrate it for another organisation, or supply data for another organisation\'s AI?',
    hint: 'Work done for someone else\'s AI system rather than your own.' },
]);
const KEYS = QUESTIONS.map(q => q.key);

// Whether the organisation does `key` with a system: the answer where given,
// else the role a "yes" would give, for systems whose roles were ticked
// before the questions existed.
const ROLE_OF = Object.fromEntries(QUESTIONS.map(q => [q.key, q.role]));
function does(system, key) {
  const answer = (system.answers || {})[key];
  if (answer === 'yes') return true;
  if (answer === 'no') return false;
  return (system.roles || []).includes(ROLE_OF[key]);
}

// What the register holds about a system because of what the organisation
// does with it (migration 081). A section applies when any of its questions
// is answered yes; a section that holds data is kept on show whatever the
// answers, so nothing written is hidden.
const SECTIONS = Object.freeze([
  { key: 'bought', when: ['sourced'], ref: 'A.9.4, A.10.3', title: 'Bought from a supplier',
    intro: 'What the supplier provides, and what it says about using it.',
    fields: [
      { name: 'supplied_product', label: 'Product and version', placeholder: 'e.g. Microsoft 365 Copilot, enterprise licence' },
      { name: 'supplier_terms', label: 'What the supplier\'s terms say', long: true, placeholder: 'Use of your data, who is responsible for what, notice of changes' },
      { name: 'supplier_guidance', label: 'The supplier\'s guidance on intended use', long: true, placeholder: 'What it is meant for, its known limits, and where the supplier documents them' },
    ] },
  { key: 'used', when: ['uses'], ref: 'A.9.2, A.9.4', title: 'Used by the organisation',
    intro: 'How staff are expected to use it.',
    fields: [
      { name: 'use_rules', label: 'Rules for using it', long: true, placeholder: 'What it may and may not be used for, and the checks before relying on an output' },
    ] },
  { key: 'built', when: ['builds', 'trains'], ref: 'A.4.4, A.4.5, A.6.2.4, A.6.2.5', title: 'Built or trained by the organisation',
    intro: 'The version in use, how it was checked, and what it takes to build and run.',
    fields: [
      { name: 'model_version', label: 'Version in use', placeholder: 'e.g. 2.3, released March 2026' },
      { name: 'validated_on', label: 'Last verified and validated', type: 'date' },
      { name: 'release_check', label: 'How a new version is checked before release', long: true, placeholder: 'Tests, acceptance criteria and who signs off' },
      { name: 'tooling_resources', label: 'Tooling', long: true, placeholder: 'Models, algorithms, frameworks, evaluation tools' },
      { name: 'compute_resources', label: 'System and computing', long: true, placeholder: 'Where it runs: cloud, on premises, edge; storage; hardware' },
    ] },
  { key: 'offered', when: ['offers'], ref: 'A.8.2, A.8.4, A.10.4', title: 'Offered to people outside the organisation',
    intro: 'Who gets it, what they are told, and what was agreed with them.',
    fields: [
      { name: 'offered_to', label: 'Who gets it', placeholder: 'e.g. Business customers through the claims portal' },
      { name: 'user_information', label: 'Where its users are informed', long: true, placeholder: 'The documentation and instructions for users, and where they are published' },
      { name: 'incident_route', label: 'How users hear about incidents and report problems', long: true, placeholder: 'The notice, the channel and the response time' },
      { name: 'customer_terms', label: 'Responsibilities agreed with customers', long: true, placeholder: 'What the customer must do, and what the organisation answers for' },
    ] },
  { key: 'partner', when: ['partners'], ref: 'A.10.2', title: 'Worked on for another organisation',
    intro: 'The work done for the other organisation, and who answers for what.',
    fields: [
      { name: 'partner_work', label: 'The work and the split of responsibility', long: true, placeholder: 'e.g. We integrate the model into the client\'s claims system; the client owns its use' },
    ] },
]);

// The sections of the register for one system, each with whether it applies
// (`applies`) and whether it holds data (`filled`).
function sectionsFor(system) {
  return SECTIONS.map(section => ({
    ...section,
    applies: section.when.some(key => does(system, key)),
    filled: section.fields.some(f => String(system[f.name] || '').trim() !== ''),
  }));
}

// Display order, short names, and what each role brings to the AIMS. The
// controls named are where the role weighs most; which controls apply is
// still decided control by control in the Statement of Applicability.
const ROLE_ORDER = ['customer', 'producer', 'provider', 'partner'];
const ROLE_INFO = Object.freeze({
  customer: { name: 'AI customer or user', short: 'customer',
    brings: 'Responsible and intended use, and checking the suppliers the AI comes from (A.9, A.10.3).' },
  producer: { name: 'AI producer', short: 'producer',
    brings: 'The development life cycle and the data behind each model: requirements, design, testing, release, data quality and provenance (A.6, A.7).' },
  provider: { name: 'AI provider', short: 'provider',
    brings: 'Information for the people who use it, ways to report concerns and incidents, and responsibilities agreed with customers (A.8, A.10.4).' },
  partner: { name: 'AI partner', short: 'partner',
    brings: 'Agreeing with the other organisations who is responsible for what (A.10.2).' },
});

// The systems a profile counts: in the AIMS scope and not retired, the same
// systems the readiness check counts.
const COUNTED_SQL = "in_scope=1 AND lifecycle_stage != 'retired'";

function decodeAnswers(json) {
  let raw = {};
  try { raw = JSON.parse(json || '{}') || {}; } catch (_) { raw = {}; }
  return Object.fromEntries(KEYS.filter(k => raw[k] === 'yes' || raw[k] === 'no').map(k => [k, raw[k]]));
}

// Answers posted as role_<key> = 'yes' | 'no'. Anything else is unanswered.
function parseAnswers(body = {}) {
  return Object.fromEntries(KEYS.map(k => [k, body[`role_${k}`]]).filter(([, v]) => v === 'yes' || v === 'no'));
}

// The roles the answers give, in display order.
function derive(answers) {
  const held = new Set(QUESTIONS.filter(q => answers[q.key] === 'yes').map(q => q.role));
  return ROLE_ORDER.filter(r => held.has(r));
}

// "customer and producer", "customer, producer and provider".
function joinRoles(roles) {
  const names = roles.map(r => ROLE_INFO[r].short);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] || '');
}

// Where a system's role stands: every question answered, some, none, or
// roles ticked before the questions existed.
function stateOf(answers, roles) {
  const n = Object.keys(answers).length;
  if (n === KEYS.length) return 'answered';
  if (n) return 'partial';
  return roles.length ? 'ticked' : 'missing';
}

function decorate(row, decodeRoles) {
  const answers = decodeAnswers(row.role_answers);
  const roles = decodeRoles(row.org_roles);
  return { ...row, answers, roles, roleState: stateOf(answers, roles) };
}

// The organisation's profile: the union of its roles across the systems it
// counts, grouped by the same set of roles ("Customer of 5 AI systems ·
// producer and provider of 1").
function profile(db, ws) {
  const { decodeRoles } = require('./ai-systems');
  const systems = db.prepare(`SELECT id, name, purpose, org_roles, role_answers, in_scope, lifecycle_stage, version,
      (${COUNTED_SQL}) AS counted,
      (SELECT COUNT(*) FROM ai_system_suppliers v WHERE v.ai_system_id=ai_systems.id) AS supplier_count
    FROM ai_systems WHERE workspace_id=? ORDER BY counted DESC, name`).all(ws.id).map(row => decorate(row, decodeRoles));
  const counted = systems.filter(s => s.counted);
  const groups = new Map();
  counted.filter(s => s.roles.length).forEach(s => {
    const key = s.roles.join('+');
    groups.set(key, { roles: s.roles, count: (groups.get(key)?.count || 0) + 1 });
  });
  const parts = [...groups.values()].sort((a, b) => b.count - a.count)
    .map((g, i) => `${joinRoles(g.roles)} of ${g.count}${i === 0 ? ` AI system${g.count === 1 ? '' : 's'}` : ''}`);
  const sentence = parts.length ? parts.join(' · ').replace(/^./, c => c.toUpperCase()) : '';
  const byRole = ROLE_ORDER.map(role => ({ role, ...ROLE_INFO[role],
    systems: counted.filter(s => s.roles.includes(role)) })).filter(r => r.systems.length);
  return {
    systems, counted, sentence, byRole,
    held: byRole.map(r => r.role),
    missing: counted.filter(s => !s.roles.length),
    toConfirm: counted.filter(s => s.roleState !== 'answered'),
  };
}

module.exports = { QUESTIONS, KEYS, ROLE_ORDER, ROLE_INFO, COUNTED_SQL, SECTIONS, decodeAnswers, parseAnswers, derive, does, sectionsFor, joinRoles, stateOf, profile };
