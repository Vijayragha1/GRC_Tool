'use strict';
// Measures for an AI management system (ISO 42001 clause 9.1), in the same
// shape as data/iso27004-metrics.js so they can be adopted, given a target and
// tracked with readings the same way. The firm's own set: what an auditor
// expects an AIMS to watch (how AI systems perform in operation, whether they
// treat groups of people differently, how often people override them, and
// whether the assessments and records the AIMS depends on are kept current).
// `controls` are the ISO 42001 requirement ids each measure evidences.

const CATEGORIES = [
  'AI system performance',
  'Fairness and impact',
  'Human oversight',
  'AI governance records',
  'People and suppliers',
];

const METRICS = [
  {
    key: 'aims-drift', ref: 'AI-1', name: 'Model performance drift', category: 'AI system performance',
    informationNeed: 'Is each AI system still performing as it did when it was validated?',
    measure: 'Change in the system\'s main performance measure against its validated baseline.',
    formula: '(baseline value - current value) / baseline value x 100', targetText: 'No more than 5% below baseline',
    unit: '%', direction: 'lower', suggestedTarget: 5, frequency: 'Monthly', controls: ['ai-annex-a-6-2-6', 'ai-annex-a-6-2-4'],
  },
  {
    key: 'aims-fairness-gap', ref: 'AI-2', name: 'Outcome gap between groups', category: 'Fairness and impact',
    informationNeed: 'Does an AI system give some groups of people worse outcomes than others?',
    measure: 'Largest difference in the rate of favourable outcomes between the groups the system is monitored for.',
    formula: 'highest group rate - lowest group rate (percentage points)', targetText: 'No more than 5 percentage points',
    unit: 'points', direction: 'lower', suggestedTarget: 5, frequency: 'Quarterly', controls: ['ai-annex-a-5-4', 'ai-annex-a-7-4'],
  },
  {
    key: 'aims-override-rate', ref: 'AI-3', name: 'Human override rate', category: 'Human oversight',
    informationNeed: 'Are the people reviewing AI outputs using their oversight, and is the system behaving as expected?',
    measure: 'Share of AI outputs that the reviewing person changed or rejected.',
    formula: 'overridden outputs / reviewed outputs x 100', targetText: 'Within the band agreed at deployment; investigate sudden changes',
    unit: '%', direction: 'lower', suggestedTarget: null, frequency: 'Monthly', controls: ['ai-annex-a-9-2', 'ai-annex-a-6-2-6'],
  },
  {
    key: 'aims-incidents', ref: 'AI-4', name: 'Incidents involving an AI system', category: 'AI system performance',
    informationNeed: 'How often do AI systems cause or contribute to an incident?',
    measure: 'Number of incidents in the period linked to an AI system.',
    formula: 'count of incidents linked to an AI system', targetText: 'No major incidents; a falling trend',
    unit: 'count', direction: 'lower', suggestedTarget: 0, frequency: 'Monthly', controls: ['ai-annex-a-8-4'],
  },
  {
    key: 'aims-ia-current', ref: 'AI-5', name: 'Impact assessments current', category: 'AI governance records',
    informationNeed: 'Does every AI system in scope have an approved impact assessment that is not overdue for review?',
    measure: 'Share of in-scope AI systems with an approved impact assessment inside its review date.',
    formula: 'systems with a current approved assessment / in-scope systems x 100', targetText: '100%',
    unit: '%', direction: 'higher', suggestedTarget: 100, frequency: 'Quarterly', controls: ['ai-annex-a-5-2', 'ai-annex-a-5-3'],
  },
  {
    key: 'aims-validation', ref: 'AI-6', name: 'Releases with recorded validation', category: 'AI governance records',
    informationNeed: 'Is every change to an AI system validated and accepted before it goes live?',
    measure: 'Share of releases in the period with verification and validation results and an acceptance decision on record.',
    formula: 'releases with results and acceptance / releases x 100', targetText: '100%',
    unit: '%', direction: 'higher', suggestedTarget: 100, frequency: 'Quarterly', controls: ['ai-annex-a-6-2-4', 'ai-annex-a-6-2-5'],
  },
  {
    key: 'aims-provenance', ref: 'AI-7', name: 'Datasets with recorded provenance', category: 'AI governance records',
    informationNeed: 'Do we know where the data behind each AI system came from and on what terms?',
    measure: 'Share of datasets in use with their source, right to use and quality checks recorded.',
    formula: 'datasets with provenance recorded / datasets in use x 100', targetText: '100%',
    unit: '%', direction: 'higher', suggestedTarget: 100, frequency: 'Quarterly', controls: ['ai-annex-a-7-3', 'ai-annex-a-7-5'],
  },
  {
    key: 'aims-training', ref: 'AI-8', name: 'AI awareness training completed', category: 'People and suppliers',
    informationNeed: 'Do the people who build, run or use AI systems know the AI policy and their part in it?',
    measure: 'Share of people in AI roles who completed the current AI awareness training.',
    formula: 'people trained / people in AI roles x 100', targetText: 'At least 95%',
    unit: '%', direction: 'higher', suggestedTarget: 95, frequency: 'Quarterly', controls: ['ai-annex-a-4-6', 'ai-clause-7.3'],
  },
  {
    key: 'aims-concerns', ref: 'AI-9', name: 'Concerns resolved on time', category: 'Human oversight',
    informationNeed: 'Are concerns raised about AI systems looked into and resolved?',
    measure: 'Share of concerns about AI systems resolved within the agreed time.',
    formula: 'concerns resolved on time / concerns closed x 100', targetText: 'At least 90%',
    unit: '%', direction: 'higher', suggestedTarget: 90, frequency: 'Quarterly', controls: ['ai-annex-a-3-3'],
  },
  {
    key: 'aims-suppliers', ref: 'AI-10', name: 'AI suppliers reviewed on schedule', category: 'People and suppliers',
    informationNeed: 'Are model, data and platform suppliers reviewed as planned?',
    measure: 'Share of AI suppliers whose scheduled review was completed.',
    formula: 'suppliers reviewed on time / suppliers due for review x 100', targetText: '100%',
    unit: '%', direction: 'higher', suggestedTarget: 100, frequency: 'Annually', controls: ['ai-annex-a-10-3'],
  },
];

module.exports = METRICS;
module.exports.CATEGORIES = CATEGORIES;
module.exports.METRICS = METRICS;
