'use strict';

const methodology = require('../data/supplier-methodology-v2026.1.json');

const TIER_ORDER = ['tier_1', 'tier_2', 'tier_3', 'tier_4'];
const MODULE_NAME_ALIASES = {
  'Trading & Critical Applications': 'Critical Applications',
};
const CONDITIONAL_CONTRACT_MODULES = {
  'Software Supply Chain': 'Software & Application Security',
  'Privileged Access': 'Privileged Access & Managed Security',
  'Transaction Integrity': 'Critical Applications',
  'Cloud Specific': 'Cloud & Hosting',
};

function canonicalModuleName(name) {
  return MODULE_NAME_ALIASES[name] || name;
}

function resolveModuleApplicability(moduleApplicability, name) {
  if (moduleApplicability[name] !== undefined) return moduleApplicability[name];
  const legacyName = Object.keys(MODULE_NAME_ALIASES).find(key => MODULE_NAME_ALIASES[key] === name);
  return legacyName ? moduleApplicability[legacyName] : undefined;
}

function clientText(value, clientName) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('{{client}}', clientName || 'the client');
}

function conditionMatches(condition, answers) {
  const score = answers[condition.questionId];
  if (!Number.isFinite(score)) return false;
  if (condition.operator === 'eq') return score === condition.score;
  if (condition.operator === 'gte') return score >= condition.score;
  return false;
}

function scoreInherent(answerInput = {}, definition = methodology) {
  const answers = {};
  const unknownQuestionIds = [];
  const unansweredQuestionIds = [];
  for (const question of definition.scoring.questions) {
    const raw = answerInput[question.id];
    if (raw === 'unknown') {
      unknownQuestionIds.push(question.id);
      continue;
    }
    const score = Number(raw);
    if (!Number.isInteger(score) || score < 0 || score > 5) {
      unansweredQuestionIds.push(question.id);
      continue;
    }
    answers[question.id] = score;
  }

  const factors = definition.scoring.factors.map(factor => {
    const scores = factor.questionIds.map(id => answers[id]).filter(Number.isFinite);
    const complete = scores.length === factor.questionIds.length;
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
    const weightedScore = average == null ? 0 : (average / 5) * factor.weight * 100;
    return { ...factor, complete, answered: scores.length, average, weightedScore };
  });
  const weightedScore = Math.round(factors.reduce((sum, factor) => sum + factor.weightedScore, 0) * 100) / 100;
  const triggeredFloors = (definition.scoring.floors || []).filter(floor => floor.anyOf.some(condition => conditionMatches(condition, answers)));
  const orderedTiers = TIER_ORDER.map(id => ({ id, minimumScore: Number(definition.tiers[id]?.minimumScore || 0) }));
  let assignedTier = orderedTiers.find(tier => weightedScore >= tier.minimumScore)?.id || 'tier_4';
  if (triggeredFloors.some(floor => floor.minimumTier === 'tier_1')) assignedTier = 'tier_1';
  else if (assignedTier !== 'tier_1' && triggeredFloors.some(floor => floor.minimumTier === 'tier_2')) assignedTier = 'tier_2';
  const finalisable = unknownQuestionIds.length === 0 && unansweredQuestionIds.length === 0;
  return { answers, factors, weightedScore, assignedTier, triggeredFloors, unknownQuestionIds, unansweredQuestionIds, finalisable };
}

function routeModules(answerInput = {}, physicalDataCentre = 'unknown', definition = methodology) {
  const answers = Object.fromEntries(Object.entries(answerInput).map(([key, value]) => [key, Number(value)]));
  return definition.modules.map(module => {
    let applicability = 'Unknown / Validation Required';
    let rationale = module.rule.guidance || '';
    if (module.rule.source === 'automatic') {
      applicability = module.rule.anyOf.some(condition => conditionMatches(condition, answers)) ? 'Yes' : 'No';
      rationale = module.rule.anyOf.map(condition => `${condition.questionId} ${condition.operator === 'gte' ? '≥' : '='} ${condition.score}`).join(' or ');
    } else if (physicalDataCentre === 'yes') applicability = 'Yes';
    else if (physicalDataCentre === 'no') applicability = 'No';
    return { name: module.name, applicability, rationale, questionCount: module.questions.length };
  });
}

function questionsForAssessment(tier, moduleApplicability = {}, clientName, definition = methodology) {
  const tierQuestions = definition.ddqQuestions
    .filter(question => question.enabled !== false && question.tiers.includes(tier))
    .map(question => ({ ...question, source: 'tier', domain: clientText(question.domain, clientName), theme: clientText(question.theme, clientName), question: clientText(question.question, clientName), guidance: clientText(question.guidance, clientName), evidenceRequired: clientText(question.evidenceRequired, clientName) }));
  const moduleQuestions = definition.modules.flatMap(module => {
    if (resolveModuleApplicability(moduleApplicability, module.name) !== 'Yes') return [];
    return module.questions.filter(question => question.enabled !== false).map((question, index) => ({ ...question, order: tierQuestions.length + index + 1, source: 'module', module: module.name, domain: module.name, question: clientText(question.question, clientName), guidance: clientText(question.guidance, clientName), evidenceRequired: clientText(question.evidenceRequired, clientName) }));
  });
  return [...tierQuestions, ...moduleQuestions];
}

function contractClauseRequired(clause, moduleApplicability = {}) {
  if (!clause || clause.requiredWhen !== 'Conditional') return true;
  const moduleName = CONDITIONAL_CONTRACT_MODULES[clause.category];
  return Boolean(moduleName && resolveModuleApplicability(moduleApplicability, moduleName) === 'Yes');
}

function allowedChoice(value, choices, fallback = null) {
  return choices.includes(value) ? value : fallback;
}

function evaluateDdqResponse(question, response = {}) {
  const answer = response.response || '';
  const detail = String(response.detail || '').trim();
  const reviewer = response.reviewer_conclusion || 'Not Reviewed';
  const evidenceComplete = !question.evidenceMandatory || Boolean(String(response.evidence_reference || '').trim());
  if (!answer) return 'Unanswered';
  if (answer === 'Unknown / Validation Required') return 'Validation Required';
  if (answer === 'Not Applicable' && !detail) return 'N/A justification required';
  if (answer === 'Not Applicable' && reviewer !== 'Not Applicable') return 'N/A - Review';
  if (!evidenceComplete) return 'Evidence Missing';
  if (reviewer === 'Not Reviewed') return 'Awaiting Review';
  const adverse = ['Partially Implemented', 'No'].includes(answer) || ['Partially Satisfactory', 'Unsatisfactory'].includes(reviewer);
  if (adverse && !response.finding_id) return 'Review / Finding';
  return 'Response Complete';
}

function ddqProgress(questions, responseMap = {}) {
  const statuses = questions.map(question => evaluateDdqResponse(question, responseMap[question.id] || {}));
  const counts = statuses.reduce((result, status) => {
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  const complete = counts['Response Complete'] || 0;
  const answered = questions.filter(question => String(responseMap[question.id]?.response || '').trim()).length;
  return { total: questions.length, answered, unanswered: questions.length - answered, complete,
    open: questions.length - complete, percentage: questions.length ? Math.round(complete / questions.length * 100) : 0, counts };
}

function contractProgress(clauses, itemMap = {}) {
  let complete = 0;
  let gaps = 0;
  let open = 0;
  for (const clause of clauses) {
    const item = itemMap[clause.id] || {};
    const status = item.status || 'Not Reviewed';
    const required = item.required !== false && item.required !== 0;
    if (!required || ['Present - Satisfactory', 'Not Required', 'Not Applicable'].includes(status)) complete += 1;
    else if (['Present - Gap Identified', 'Missing', 'To be Added'].includes(status)) {
      gaps += 1;
      if (!item.finding_id && required) open += 1;
      else complete += 1;
    } else open += 1;
  }
  return { total: clauses.length, complete, gaps, open, percentage: clauses.length ? Math.round(complete / clauses.length * 100) : 0 };
}

function decisionReadiness({ inherent, ddq, ddqStatus = null, contract, openHighFindings = 0, unresolvedModules = 0 }) {
  const blockers = [];
  if (!inherent || !inherent.approved_at) blockers.push('Inherent-risk assessment is not approved.');
  if (!ddq) blockers.push('Vendor due diligence has not been completed.');
  else if (!['submitted', 'under_review', 'complete'].includes(ddqStatus) && ddqStatus) {
    blockers.push(`${ddq.unanswered ?? ddq.open} vendor question${(ddq.unanswered ?? ddq.open) === 1 ? '' : 's'} remain unanswered; vendor submission is required.`);
  } else if (ddq.open > 0) blockers.push(`${ddq.open} due-diligence review item${ddq.open === 1 ? '' : 's'} remain unresolved.`);
  if (!contract || contract.open > 0) blockers.push(`${contract ? contract.open : 'All'} contract review item${contract && contract.open === 1 ? '' : 's'} remain unresolved.`);
  if (unresolvedModules > 0) blockers.push(`${unresolvedModules} conditional module${unresolvedModules === 1 ? '' : 's'} remain unresolved.`);
  if (openHighFindings > 0) blockers.push(`${openHighFindings} high or critical finding${openHighFindings === 1 ? '' : 's'} require treatment or explicit risk acceptance.`);
  return { ready: blockers.length === 0, blockers };
}

function tierLabel(tier, definition = methodology) {
  return definition.tiers[tier] ? definition.tiers[tier].label : 'Not assigned';
}

module.exports = {
  methodology,
  TIER_ORDER,
  canonicalModuleName,
  clientText,
  scoreInherent,
  routeModules,
  questionsForAssessment,
  contractClauseRequired,
  allowedChoice,
  evaluateDdqResponse,
  ddqProgress,
  contractProgress,
  decisionReadiness,
  tierLabel,
};
