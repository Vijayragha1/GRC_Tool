'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const risk = require('../lib/supplier-risk');

const answersAt = score => Object.fromEntries(risk.methodology.scoring.questions.map(question => [question.id, score]));

test('methodology contains the workbook-governed catalog', () => {
  assert.equal(risk.methodology.scoring.questions.length, 25);
  assert.equal(risk.methodology.scoring.factors.length, 10);
  assert.equal(risk.methodology.scoring.floors.length, 9);
  assert.equal(risk.methodology.ddqQuestions.length, 139);
  assert.equal(risk.methodology.modules.reduce((sum, module) => sum + module.questions.length, 0), 61);
  assert.equal(risk.methodology.contractClauses.length, 47);
});

test('weighted model reproduces the 0 to 100 tier bands', () => {
  const low = risk.scoreInherent(answersAt(0));
  assert.equal(low.weightedScore, 0);
  assert.equal(low.assignedTier, 'tier_4');
  assert.equal(low.finalisable, true);
  const high = risk.scoreInherent(answersAt(5));
  assert.equal(high.weightedScore, 100);
  assert.equal(high.assignedTier, 'tier_1');
});

test('mandatory floors override a low weighted score', () => {
  const t1 = answersAt(0);
  t1.Q14 = 5;
  const t1Result = risk.scoreInherent(t1);
  assert.equal(t1Result.assignedTier, 'tier_1');
  assert.ok(t1Result.triggeredFloors.some(floor => floor.id === 'T1-01'));
  const t2 = answersAt(0);
  t2.Q04 = 4;
  const t2Result = risk.scoreInherent(t2);
  assert.equal(t2Result.assignedTier, 'tier_2');
  assert.ok(t2Result.triggeredFloors.some(floor => floor.id === 'T2-01'));
});

test('unknown and unanswered inherent inputs block finalisation', () => {
  const answers = answersAt(2);
  answers.Q01 = 'unknown';
  delete answers.Q02;
  const result = risk.scoreInherent(answers);
  assert.equal(result.finalisable, false);
  assert.deepEqual(result.unknownQuestionIds, ['Q01']);
  assert.deepEqual(result.unansweredQuestionIds, ['Q02']);
});

test('tier question sets and conditional modules match workbook scope', () => {
  assert.equal(risk.questionsForAssessment('tier_1').length, 139);
  assert.equal(risk.questionsForAssessment('tier_2').length, 112);
  assert.equal(risk.questionsForAssessment('tier_3').length, 53);
  assert.equal(risk.questionsForAssessment('tier_4').length, 22);
  const routes = risk.routeModules({ ...answersAt(0), Q12: 2, Q04: 4 }, 'no');
  assert.equal(routes.find(module => module.name === 'Cloud & Hosting').applicability, 'Yes');
  assert.equal(routes.find(module => module.name === 'Personal Data & Privacy').applicability, 'Yes');
  const scope = Object.fromEntries(routes.map(module => [module.name, module.applicability]));
  assert.equal(risk.questionsForAssessment('tier_4', scope).length, 22 + 12 + 9);
  assert.equal(routes.some(module => module.name === 'Critical Applications'), true);
  assert.equal(risk.questionsForAssessment('tier_4', { 'Trading & Critical Applications': 'Yes' }).length, 22 + 12);
});

test('DDQ row status enforces N/A, evidence, review and finding gates', () => {
  const question = { evidenceMandatory: true };
  assert.equal(risk.evaluateDdqResponse(question, {}), 'Unanswered');
  assert.equal(risk.evaluateDdqResponse(question, { response: 'Not Applicable' }), 'N/A justification required');
  assert.equal(risk.evaluateDdqResponse(question, { response: 'Not Applicable', detail: 'Service does not process client data.' }), 'N/A - Review');
  assert.equal(risk.evaluateDdqResponse(question, { response: 'Yes' }), 'Evidence Missing');
  const evidence = { response: 'Yes', evidence_reference: 'SOC2-CC6.1' };
  assert.equal(risk.evaluateDdqResponse(question, evidence), 'Awaiting Review');
  assert.equal(risk.evaluateDdqResponse(question, { ...evidence, response: 'No', reviewer_conclusion: 'Unsatisfactory' }), 'Review / Finding');
  assert.equal(risk.evaluateDdqResponse(question, { ...evidence, response: 'No', reviewer_conclusion: 'Unsatisfactory', finding_id: 42 }), 'Response Complete');
});

test('DDQ progress separates vendor completion from internal review completion', () => {
  const questions = [
    { id: 'A', evidenceMandatory: false },
    { id: 'B', evidenceMandatory: false }
  ];
  const progress = risk.ddqProgress(questions, {
    A: { response: 'Yes', reviewer_conclusion: 'Not Reviewed' }
  });
  assert.equal(progress.answered, 1);
  assert.equal(progress.unanswered, 1);
  assert.equal(progress.complete, 0);
  assert.equal(progress.open, 2);
});

test('conditional contract clauses follow the approved module scope', () => {
  const cloudClause = risk.methodology.contractClauses.find(clause => clause.id === 'CT-39');
  const universalClause = risk.methodology.contractClauses.find(clause => clause.id === 'CT-01');
  assert.equal(risk.contractClauseRequired(cloudClause, { 'Cloud & Hosting': 'No' }), false);
  assert.equal(risk.contractClauseRequired(cloudClause, { 'Cloud & Hosting': 'Yes' }), true);
  assert.equal(risk.contractClauseRequired(universalClause, {}), true);
  const progress = risk.contractProgress([cloudClause], { 'CT-39': { required: 0, status: 'Not Required' } });
  assert.deepEqual(progress, { total: 1, complete: 1, gaps: 0, open: 0, percentage: 100 });
});

test('positive supplier decision remains blocked until every governed gate passes', () => {
  const blocked = risk.decisionReadiness({ inherent: null, ddq: null, contract: null, openHighFindings: 1, unresolvedModules: 1 });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.length, 5);
  const ready = risk.decisionReadiness({ inherent: { approved_at: '2026-08-16' }, ddq: { open: 0 }, contract: { open: 0 }, openHighFindings: 0, unresolvedModules: 0 });
  assert.equal(ready.ready, true);
});
