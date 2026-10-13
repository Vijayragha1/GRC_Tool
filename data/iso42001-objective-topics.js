'use strict';
// Topics an AI objective can serve (clause 6.2), following the areas the
// standard's informative annex on organisational objectives suggests. The
// list and the wording are the product's own. Keys are stored on
// security_objectives.ai_topic (migration 078); do not rename a key.

const TOPICS = Object.freeze([
  { key: 'accountability', label: 'Accountability', hint: 'Someone answers for each AI-assisted decision, even when a model made the call.' },
  { key: 'ai_expertise', label: 'AI expertise', hint: 'The organisation has the mix of skills to build, assess and run its AI systems.' },
  { key: 'data_quality', label: 'Training and test data', hint: 'Enough data of the right quality to train the systems and check they behave as intended.' },
  { key: 'environment', label: 'Environmental impact', hint: 'The energy, water and hardware the systems use, and any good they do for the environment.' },
  { key: 'fairness', label: 'Fairness', hint: 'Automated decisions do not treat people or groups unfairly.' },
  { key: 'maintainability', label: 'Maintainability', hint: 'Systems can be corrected and adapted to new requirements without breaking.' },
  { key: 'privacy', label: 'Privacy', hint: 'Personal and sensitive data used by the systems is protected from misuse and disclosure.' },
  { key: 'robustness', label: 'Robustness', hint: 'Systems perform as well on new data as on the data they were built with.' },
  { key: 'safety', label: 'Safety', hint: 'Systems do not put people, property or the environment in danger.' },
  { key: 'security', label: 'Security', hint: 'Systems resist attacks peculiar to AI, such as poisoned data or stolen models, as well as the usual ones.' },
  { key: 'transparency', label: 'Transparency and explainability', hint: 'People can find out how the organisation uses AI and understand what drove a result.' },
]);

const LABEL = Object.freeze(Object.fromEntries(TOPICS.map((t) => [t.key, t.label])));

module.exports = { TOPICS, LABEL };
