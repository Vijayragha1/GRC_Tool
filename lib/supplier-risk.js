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
  // A question the supplier and the reviewer agree does not apply needs no
  // evidence for it.
  if (answer === 'Not Applicable') return 'Response Complete';
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

function validIsoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function agreementDetails(referenceInput, dateInput) {
  const reference = String(referenceInput || '').trim();
  const dateText = String(dateInput || '').trim();
  const dateValid = validIsoDate(dateText);
  const errors = [];
  if (!reference) errors.push('Agreement reference is required.');
  if (!dateValid) errors.push('A valid agreement date is required.');
  return {
    reference: reference || null,
    date: dateValid ? dateText : null,
    valid: errors.length === 0,
    errors,
  };
}

function decisionReadiness({ inherent, ddq, ddqStatus = null, contract, openHighFindings = 0, unresolvedModules = 0 }) {
  const blockers = [];
  if (!inherent || !inherent.approved_at) blockers.push('Inherent-risk assessment is not approved.');
  if (!ddq) blockers.push('Vendor due diligence has not been completed.');
  else if (!['submitted', 'under_review', 'complete'].includes(ddqStatus) && ddqStatus) {
    blockers.push(`${ddq.unanswered ?? ddq.open} vendor question${(ddq.unanswered ?? ddq.open) === 1 ? '' : 's'} remain unanswered; vendor submission is required.`);
  } else if (ddq.open > 0) blockers.push(`${ddq.open} due-diligence review item${ddq.open === 1 ? '' : 's'} remain unresolved.`);
  if (!contract || contract.open > 0) blockers.push(`${contract ? contract.open : 'All'} contract review item${contract && contract.open === 1 ? '' : 's'} remain unresolved.`);
  else if (!agreementDetails(contract.agreement_reference, contract.agreement_date).valid) {
    blockers.push('The completed contract review needs an agreement reference and valid agreement date.');
  }
  if (unresolvedModules > 0) blockers.push(`${unresolvedModules} conditional module${unresolvedModules === 1 ? '' : 's'} remain unresolved.`);
  if (openHighFindings > 0) blockers.push(`${openHighFindings} high or critical finding${openHighFindings === 1 ? '' : 's'} require treatment or explicit risk acceptance.`);
  return { ready: blockers.length === 0, blockers };
}

// The residual risk an assessment suggests. It is advice: the consultant sets
// the recommendation's band, and says why when it differs from this.
//
// It starts from the inherent score, lowers it for controls the due diligence
// found effective and for clauses the contract contains, raises it for open
// findings, and never suggests a band below a mandatory floor, since the
// methodology marks every floor "reducibleByControlEvidence": false. Bands use
// the tiers' own score ranges (Tier 1 · Critical from 70, Tier 2 · High from
// 45, Tier 3 · Medium from 20).
const RESIDUAL = Object.freeze({
  dueDiligenceReduction: 0.40, // share of the inherent score effective controls can remove
  contractReduction: 0.15,     // share the contract's clauses can remove
  partialCredit: 0.5,          // a partly satisfactory control counts half
  openFindingPoints: Object.freeze({ critical: 15, high: 8, moderate: 3, medium: 3, low: 1 }),
});
const TIER_BAND = Object.freeze({ tier_1: 'critical', tier_2: 'high', tier_3: 'moderate', tier_4: 'low' });
const BAND_ORDER = Object.freeze(['low', 'moderate', 'high', 'critical']);
const OPEN_FINDING = status => !['closed', 'verified', 'accepted_risk'].includes(String(status || '').toLowerCase());
const CONTRACT_GAP = new Set(['Present - Gap Identified', 'Missing', 'To be Added']);
const oneDecimal = value => Math.round(value * 10) / 10;
const bandLabel = band => band.charAt(0).toUpperCase() + band.slice(1);

function residualBand(score, definition = methodology) {
  const tier = TIER_ORDER.find(id => score >= Number(definition.tiers[id]?.minimumScore || 0)) || 'tier_4';
  return TIER_BAND[tier];
}

function bandMinimumScore(band, definition = methodology) {
  const tier = Object.keys(TIER_BAND).find(id => TIER_BAND[id] === band);
  return Math.ceil(Number(definition.tiers[tier]?.minimumScore || 0));
}

function suggestResidualRisk({ inherent, ddqComplete = false, ddqResponses = [], contractComplete = false, contractItems = [], findings = [], definition = methodology } = {}) {
  if (!inherent || inherent.status !== 'approved' || inherent.weighted_score == null) {
    return { available: false, reason: 'The inherent-risk tier has not been set yet.' };
  }
  const start = Number(inherent.weighted_score);
  const steps = [{ label: 'Inherent risk score', points: oneDecimal(start) }];

  const ddq = { satisfactory: 0, partial: 0, unsatisfactory: 0, notApplicable: 0, pending: 0 };
  for (const row of ddqResponses) {
    const conclusion = row.reviewer_conclusion || 'Not Reviewed';
    if (conclusion === 'Satisfactory') ddq.satisfactory += 1;
    else if (conclusion === 'Partially Satisfactory') ddq.partial += 1;
    else if (conclusion === 'Unsatisfactory') ddq.unsatisfactory += 1;
    else if (conclusion === 'Not Applicable') ddq.notApplicable += 1;
    else ddq.pending += 1;
  }
  const ddqAssessed = ddq.satisfactory + ddq.partial + ddq.unsatisfactory;
  const ddqCut = ddqAssessed
    ? oneDecimal(start * RESIDUAL.dueDiligenceReduction * (ddq.satisfactory + RESIDUAL.partialCredit * ddq.partial) / ddqAssessed) : 0;
  steps.push(ddqAssessed
    ? { label: `Due diligence: ${ddq.satisfactory} satisfactory, ${ddq.partial} partly, ${ddq.unsatisfactory} unsatisfactory of ${ddqAssessed} applicable`, points: -ddqCut }
    : { label: 'Due diligence: no applicable answer reviewed, so no reduction', points: 0 });

  const contract = { present: 0, gaps: 0, notApplicable: 0, pending: 0 };
  for (const item of contractItems) {
    const required = item.required !== 0 && item.required !== false;
    if (!required || ['Not Required', 'Not Applicable'].includes(item.status)) contract.notApplicable += 1;
    else if (item.status === 'Present - Satisfactory') contract.present += 1;
    else if (CONTRACT_GAP.has(item.status)) contract.gaps += 1;
    else contract.pending += 1;
  }
  const clausesAssessed = contract.present + contract.gaps;
  const contractCut = clausesAssessed ? oneDecimal(start * RESIDUAL.contractReduction * contract.present / clausesAssessed) : 0;
  steps.push(clausesAssessed
    ? { label: `Contract: ${contract.present} of ${clausesAssessed} applicable clauses present`, points: -contractCut }
    : { label: 'Contract: no applicable clause reviewed, so no reduction', points: 0 });

  const open = findings.filter(finding => OPEN_FINDING(finding.status));
  const findingPoints = open.reduce((sum, finding) => sum + (RESIDUAL.openFindingPoints[String(finding.severity || '').toLowerCase()] || 0), 0);
  if (open.length) {
    const bySeverity = BAND_ORDER.slice().reverse().map(severity => [severity, open.filter(f => String(f.severity || '').toLowerCase() === severity).length])
      .filter(([, count]) => count).map(([severity, count]) => `${count} ${severity}`).join(', ');
    steps.push({ label: `Open findings: ${bySeverity}`, points: findingPoints });
  }

  let score = Math.max(0, Math.min(100, Math.round(start - ddqCut - contractCut + findingPoints)));
  let band = residualBand(score, definition);
  let floors = [];
  try { floors = JSON.parse(inherent.mandatory_floors_json || '[]') || []; } catch (_) { floors = []; }
  const floorBand = floors.map(floor => TIER_BAND[floor.minimumTier]).filter(Boolean)
    .reduce((worst, next) => (BAND_ORDER.indexOf(next) > BAND_ORDER.indexOf(worst) ? next : worst), null);
  if (floorBand && BAND_ORDER.indexOf(band) < BAND_ORDER.indexOf(floorBand)) {
    const holding = floors.filter(floor => TIER_BAND[floor.minimumTier] === floorBand).map(floor => floor.id).join(', ');
    const raised = bandMinimumScore(floorBand, definition);
    steps.push({ label: `${holding} hold${holding.includes(',') ? '' : 's'} this at ${bandLabel(floorBand)} or above: control evidence cannot reduce ${holding.includes(',') ? 'them' : 'it'}`, points: raised - score });
    score = raised;
    band = floorBand;
  }
  return {
    available: true,
    provisional: !ddqComplete || !contractComplete || ddq.pending > 0 || contract.pending > 0,
    score, band, floorBand, steps,
    counts: { ddq, contract, openFindings: open.length },
  };
}

// Check a chosen residual band against the suggestion. A different band needs
// a reason of at least ten characters, kept as the rationale's first paragraph
// (replacing any earlier one); the suggested band, or Unknown, needs none.
// Returns { rationale } or { error }.
const RESIDUAL_OVERRIDE = /^Residual risk: [^\n]*\n\n/;
function residualOverride({ suggestion, band, rationale, reason }) {
  const text = String(rationale || '').replace(RESIDUAL_OVERRIDE, '');
  const chosen = String(band || 'unknown');
  if (!suggestion || !suggestion.available || chosen === 'unknown' || chosen === suggestion.band) return { rationale: text };
  const why = String(reason || '').replace(/\s+/g, ' ').trim();
  if (why.length < 10) {
    return { error: `The assessment suggests ${bandLabel(suggestion.band)} residual risk (${suggestion.score}). Say why you chose ${bandLabel(chosen)}.` };
  }
  return { rationale: `Residual risk: ${bandLabel(chosen)} chosen; the assessment suggested ${bandLabel(suggestion.band)} (${suggestion.score}). Reason: ${why.slice(0, 1000)}\n\n${text}` };
}

function tierLabel(tier, definition = methodology) {
  return definition.tiers[tier] ? definition.tiers[tier].label : 'Not assigned';
}

module.exports = {
  methodology,
  TIER_ORDER,
  RESIDUAL,
  residualBand,
  suggestResidualRisk,
  residualOverride,
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
  validIsoDate,
  agreementDetails,
  decisionReadiness,
  tierLabel,
};
