'use strict';

// Proposed applicability of each Annex A control, from the organisation's
// roles for its AI systems (lib/ai-roles.js).
//
// Clause 4.1 note 1 says the organisation's roles can decide which controls
// apply and how far. Each control here is tied to the role that makes it
// apply. The proposal is one of:
//   include  - the role is held: the control applies, with a drafted reason
//   exclude  - the role is not held: the control can be excluded, with a
//              drafted reason
//   review   - the role alone cannot settle it: a question for the consultant
// A proposal never changes the Statement of Applicability by itself. The
// consultant accepts it (routes/iso42001.js), and the drafted reason fills a
// justification only where none is written. The reasons are written as the
// organisation's own justification, because they end up in the SoA the
// certification body reads.
const aiRoles = require('./ai-roles');

// "A", "A and B", "A, B and C", "A, B and 2 more".
function names(systems) {
  const list = systems.map(s => s.name);
  if (list.length <= 3) return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] || '');
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
}
const verb = (systems, one, many) => (systems.length === 1 ? one : many);

// The systems behind each kind of rule. A system ticked with a role before the
// questions existed counts by its role where the question is unanswered.
function drivers(profile) {
  const known = profile.counted.filter(s => s.roles.length);
  const asked = (s, key, role) => s.answers[key] === 'yes' || (s.answers[key] === undefined && s.roles.includes(role));
  return {
    all: known,
    builders: known.filter(s => asked(s, 'builds', 'producer')),
    trainers: known.filter(s => asked(s, 'trains', 'producer')),
    providers: known.filter(s => s.roles.includes('provider')),
    partners: known.filter(s => s.roles.includes('partner')),
    sourced: known.filter(s => s.answers.sourced === 'yes' || Number(s.supplier_count) > 0 || (s.answers.sourced === undefined && s.roles.includes('customer'))),
    users: known.filter(s => asked(s, 'uses', 'customer')),
  };
}

const ROLE = aiRoles.ROLE_INFO;

// Each rule: the role it rests on, and what to propose with and without it.
const every = {
  basis: 'Every AIMS',
  propose: () => ({ kind: 'include', reason: 'Applies to the AI management system whatever the organisation\'s role for its AI systems (clause 4.1).' }),
};
const everySystem = {
  basis: 'Every AI system',
  propose: (d) => ({ kind: 'include', reason: `Applies to every AI system in scope, whatever the organisation's role for it: ${names(d.all)}.` }),
};
const producerExclusion = (d) => `The organisation does not design, build, train or adapt any AI system in scope, so it has no ${ROLE.producer.name} role (clause 4.1).`
  + (d.sourced.length ? ` ${names(d.sourced)} ${verb(d.sourced, 'comes from a supplier, whose', 'come from suppliers, whose')} development is checked under A.10.3.` : '');
// Built systems bring the design and build controls. A system the
// organisation only trains, fine-tunes or connects to its own data makes it a
// producer too, but whether that work falls under a design control is a
// judgement, so it is asked rather than assumed.
const producer = (question) => ({
  basis: ROLE.producer.name,
  propose: (d) => {
    if (d.builders.length) return { kind: 'include', reason: `The organisation designs or builds ${names(d.builders)} (${ROLE.producer.name}, clause 4.1).` };
    if (d.trainers.length) {
      return { kind: 'review', reason: `${names(d.trainers)} ${verb(d.trainers, 'is', 'are')} trained, fine-tuned or connected to the organisation's own data, though not built by it. Decide whether that work falls under this control; fine-tuning a model usually does.` };
    }
    return question ? { kind: 'review', reason: question } : { kind: 'exclude', reason: producerExclusion(d) };
  },
});
const trainsExclusion = 'No AI system in scope is trained, fine-tuned or connected to the organisation\'s own data, so the organisation does not develop or prepare data for AI (clause 4.1).';
const trains = (question) => ({
  basis: ROLE.producer.name,
  propose: (d) => (d.trainers.length
    ? { kind: 'include', reason: `The organisation trains, fine-tunes or connects its own data to ${names(d.trainers)} (${ROLE.producer.name}, clause 4.1).` }
    : question && (d.users.length || d.sourced.length) ? { kind: 'review', reason: question } : { kind: 'exclude', reason: trainsExclusion }),
});
// `adapted` counts systems the organisation only trains, fine-tunes or
// connects to its own data; computing resources follow building or offering.
const developsOrOffers = (because, question, exclusion, { adapted = true } = {}) => ({
  basis: `${ROLE.producer.name} or ${ROLE.provider.name}`,
  propose: (d) => {
    const systems = [...new Map([...d.builders, ...(adapted ? d.trainers : []), ...d.providers].map(s => [s.id, s])).values()];
    if (systems.length) return { kind: 'include', reason: `The organisation ${adapted ? 'develops, adapts or offers' : 'develops or offers'} ${names(systems)} (clause 4.1), so ${because(systems.length === 1)}.` };
    return question ? { kind: 'review', reason: question } : { kind: 'exclude', reason: exclusion };
  },
});
const uses = {
  basis: ROLE.customer.name,
  propose: (d) => (d.users.length
    ? { kind: 'include', reason: `The organisation uses ${names(d.users)} in its own work or decisions (${ROLE.customer.name}, clause 4.1).` }
    : { kind: 'review', reason: 'The organisation develops or offers AI rather than using it. Decide whether staff use any AI system in their own work; if they do, this applies.' }),
};
const suppliers = {
  basis: 'Supplied AI',
  propose: (d) => (d.sourced.length
    ? { kind: 'include', reason: `${names(d.sourced)} ${verb(d.sourced, 'comes from a supplier or is built on a supplier\'s model', 'come from suppliers or are built on suppliers\' models')} (${ROLE.customer.name}, clause 4.1).` }
    : { kind: 'exclude', reason: 'No AI system in scope, or model inside one, comes from a supplier (clause 4.1).' }),
};
const customers = {
  basis: ROLE.provider.name,
  propose: (d) => (d.providers.length
    ? { kind: 'include', reason: `The organisation offers ${names(d.providers)} to people outside it (${ROLE.provider.name}, clause 4.1).` }
    : { kind: 'exclude', reason: `No AI system in scope is offered to people outside the organisation, so it has no ${ROLE.provider.name} role (clause 4.1).` }),
};
const shared = {
  basis: 'Shared responsibility',
  propose: (d) => {
    const parties = [d.sourced.length && 'suppliers', d.providers.length && 'customers', d.partners.length && 'partners'].filter(Boolean);
    const systems = [...new Map([...d.sourced, ...d.providers, ...d.partners].map(s => [s.id, s])).values()];
    if (!parties.length) return { kind: 'exclude', reason: 'Every AI system in scope is built, run and used by the organisation alone, so no responsibility is shared with another party (clause 4.1).' };
    const who = parties.length > 1 ? `${parties.slice(0, -1).join(', ')} and ${parties[parties.length - 1]}` : parties[0];
    return { kind: 'include', reason: `Responsibilities for ${names(systems)} are shared with ${who} (clause 4.1).` };
  },
};

// Every Annex A control and the rule it follows.
const RULES = Object.freeze({
  'ai-annex-a-2-2': every,
  'ai-annex-a-2-3': every,
  'ai-annex-a-2-4': every,
  'ai-annex-a-3-2': every,
  'ai-annex-a-3-3': every,
  'ai-annex-a-4-2': everySystem,
  'ai-annex-a-4-3': trains('Decide whether the organisation supplies data that the AI systems it uses rely on; if it does, record that data here.'),
  'ai-annex-a-4-4': producer(),
  'ai-annex-a-4-5': developsOrOffers((one) => `it needs the systems and computing to build or run ${one ? 'it' : 'them'}`,
    'The AI systems in use run on suppliers\' infrastructure. Decide whether the organisation runs any part of them itself; if it does, this applies.', null, { adapted: false }),
  'ai-annex-a-4-6': every,
  'ai-annex-a-5-2': everySystem,
  'ai-annex-a-5-3': everySystem,
  'ai-annex-a-5-4': everySystem,
  'ai-annex-a-5-5': everySystem,
  'ai-annex-a-6-1-2': producer(),
  'ai-annex-a-6-1-3': producer(),
  'ai-annex-a-6-2-2': producer('The organisation does not build AI. Decide whether it sets its own requirements when it procures or configures an AI system; if it does, this applies.'),
  'ai-annex-a-6-2-3': producer(),
  'ai-annex-a-6-2-4': producer('The organisation does not build AI. Decide whether it tests a bought AI system before putting it into use; if it does, this applies.'),
  'ai-annex-a-6-2-5': everySystem,
  'ai-annex-a-6-2-6': everySystem,
  'ai-annex-a-6-2-7': developsOrOffers((one) => `it owes technical documentation to ${one ? 'its' : 'their'} users and other interested parties`, null,
    'The organisation neither develops nor offers AI systems (clause 4.1); it relies on its suppliers\' technical documentation, obtained under A.10.3.'),
  'ai-annex-a-6-2-8': developsOrOffers((one) => `it decides which events ${one ? 'it records' : 'they record'}`,
    'Event logs of bought AI systems are usually kept by the supplier. Decide whether the organisation keeps logs of its own use; if it does, this applies.'),
  'ai-annex-a-7-2': trains(),
  'ai-annex-a-7-3': trains('Decide whether the organisation obtains data to feed the AI systems it uses; if it does, this applies.'),
  'ai-annex-a-7-4': trains('Decide whether the data the organisation feeds the AI systems it uses needs quality requirements; if it does, this applies.'),
  'ai-annex-a-7-5': trains('Decide whether the organisation needs to know where the data it feeds its AI systems comes from; if it does, this applies.'),
  'ai-annex-a-7-6': trains(),
  'ai-annex-a-8-2': developsOrOffers((one) => `it owes information to the people who use ${one ? 'it' : 'them'}`,
    'Decide what the organisation must tell its own staff about the AI systems they use; this may sit under A.9 instead.'),
  'ai-annex-a-8-3': every,
  'ai-annex-a-8-4': developsOrOffers((one) => `it plans how to tell ${one ? 'its' : 'their'} users about incidents`,
    'Decide whether the organisation must tell anyone about incidents with the AI systems it uses; if it must, this applies.'),
  'ai-annex-a-8-5': every,
  'ai-annex-a-9-2': uses,
  'ai-annex-a-9-3': uses,
  'ai-annex-a-9-4': uses,
  'ai-annex-a-10-2': shared,
  'ai-annex-a-10-3': suppliers,
  'ai-annex-a-10-4': customers,
});

// Proposals for every control from a role profile (aiRoles.profile).
function propose(profile) {
  const d = drivers(profile);
  const ready = d.all.length > 0;
  const byId = {};
  const counts = { include: 0, exclude: 0, review: 0 };
  if (ready) {
    for (const [id, rule] of Object.entries(RULES)) {
      byId[id] = { id, basis: rule.basis, ...rule.propose(d) };
      counts[byId[id].kind] += 1;
    }
  }
  return { ready, byId, counts, roleless: profile.missing, profile };
}

// Where a control's recorded applicability stands against its proposal.
//   pending      undecided, and the roles propose include or exclude
//   review       undecided, and the roles leave it to the consultant
//   contradicted excluded, but the roles say it applies
//   wider        included, though the roles say it could be excluded
//   agrees       anything else
function compare(proposal, applicability) {
  if (!proposal) return 'agrees';
  const decided = applicability || 'undecided';
  if (decided === 'undecided') return proposal.kind === 'review' ? 'review' : 'pending';
  if (decided === 'excluded' && proposal.kind === 'include') return 'contradicted';
  if (decided === 'included' && proposal.kind === 'exclude') return 'wider';
  return 'agrees';
}

function forWorkspace(db, ws) {
  return propose(aiRoles.profile(db, ws));
}

module.exports = { RULES, drivers, propose, compare, forWorkspace, names };
