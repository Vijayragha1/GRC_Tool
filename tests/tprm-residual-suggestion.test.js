'use strict';
// The residual risk an assessment suggests (lib/supplier-risk.js): the
// inherent score, less what effective controls and contract clauses remove,
// plus open findings, never below a mandatory floor's band.

const test = require('node:test');
const assert = require('node:assert/strict');
const risk = require('../lib/supplier-risk');

const inherent = (score, floors = []) => ({ status: 'approved', weighted_score: score, mandatory_floors_json: JSON.stringify(floors) });
const many = (n, row) => Array.from({ length: n }, () => row);

test('no suggestion before the inherent tier is set', () => {
  assert.equal(risk.suggestResidualRisk({ inherent: null }).available, false);
  assert.equal(risk.suggestResidualRisk({ inherent: { ...inherent(40), status: 'submitted' } }).available, false);
});

test('bands follow the tiers\' own score ranges', () => {
  assert.deepEqual([70, 69, 45, 44, 20, 19, 0].map(score => risk.residualBand(score)), ['critical', 'high', 'high', 'moderate', 'moderate', 'low', 'low']);
});

test('nothing applicable assessed leaves the inherent score as it is', () => {
  const s = risk.suggestResidualRisk({ inherent: inherent(38.4), ddqComplete: true, contractComplete: true,
    ddqResponses: many(5, { reviewer_conclusion: 'Not Applicable' }), contractItems: many(3, { required: 1, status: 'Not Applicable' }) });
  assert.equal(s.score, 38);
  assert.equal(s.band, 'moderate');
  assert.equal(s.provisional, false);
  assert.match(s.steps.map(x => x.label).join(' | '), /no applicable answer reviewed, so no reduction \| Contract: no applicable clause reviewed, so no reduction/);
});

test('effective controls and contract clauses lower it; weak ones and open findings keep it up', () => {
  const strong = risk.suggestResidualRisk({ inherent: inherent(50), ddqComplete: true, contractComplete: true,
    ddqResponses: many(10, { reviewer_conclusion: 'Satisfactory' }), contractItems: many(4, { required: 1, status: 'Present - Satisfactory' }) });
  assert.equal(strong.score, 23, '50 less 20 (40%) for controls and 7.5 (15%) for the contract');
  assert.equal(strong.band, 'moderate');

  const mixed = risk.suggestResidualRisk({ inherent: inherent(50), ddqComplete: true, contractComplete: true,
    ddqResponses: [...many(2, { reviewer_conclusion: 'Satisfactory' }), ...many(2, { reviewer_conclusion: 'Partially Satisfactory' })],
    contractItems: [{ required: 1, status: 'Present - Satisfactory' }, { required: 1, status: 'Missing' }, { required: 0, status: 'Not Required' }] });
  assert.equal(mixed.score, 31, '50 less 15 (three quarters of the control reduction) and 3.8 (half the contract one)');

  const weak = risk.suggestResidualRisk({ inherent: inherent(50), ddqComplete: true, contractComplete: true,
    ddqResponses: many(3, { reviewer_conclusion: 'Unsatisfactory' }),
    findings: [{ severity: 'high', status: 'open' }, { severity: 'critical', status: 'in_progress' }, { severity: 'critical', status: 'closed' }] });
  assert.equal(weak.score, 73, '50 with no reduction, plus 8 and 15 for the two open findings');
  assert.equal(weak.band, 'critical');
  assert.match(weak.steps.at(-1).label, /Open findings: 1 critical, 1 high/);
});

test('a mandatory floor holds the band, whatever the controls', () => {
  const s = risk.suggestResidualRisk({ inherent: inherent(47.6, [{ id: 'T2-01', minimumTier: 'tier_2' }]), ddqComplete: true, contractComplete: true,
    ddqResponses: many(10, { reviewer_conclusion: 'Satisfactory' }), contractItems: many(5, { required: 1, status: 'Present - Satisfactory' }) });
  assert.equal(s.band, 'high');
  assert.equal(s.score, 45, 'raised to the bottom of the High band');
  assert.match(s.steps.at(-1).label, /T2-01 holds this at High or above: control evidence cannot reduce it/);
});

test('it is provisional until the due diligence and contract review are finished', () => {
  assert.equal(risk.suggestResidualRisk({ inherent: inherent(30), ddqComplete: false, contractComplete: true }).provisional, true);
  assert.equal(risk.suggestResidualRisk({ inherent: inherent(30), ddqComplete: true, contractComplete: true,
    ddqResponses: [{ reviewer_conclusion: 'Not Reviewed' }] }).provisional, true);
});

test('a band other than the suggestion needs a reason, kept as the rationale\'s first paragraph', () => {
  const suggestion = { available: true, band: 'high', score: 52 };
  const rationale = 'Due diligence and the contract review are complete.';
  assert.deepEqual(risk.residualOverride({ suggestion, band: 'high', rationale }), { rationale }, 'the suggested band needs no reason');
  assert.deepEqual(risk.residualOverride({ suggestion, band: 'unknown', rationale }), { rationale });
  assert.match(risk.residualOverride({ suggestion, band: 'moderate', rationale, reason: 'short' }).error,
    /The assessment suggests High residual risk \(52\)\. Say why you chose Moderate\./);

  const kept = risk.residualOverride({ suggestion, band: 'moderate', rationale, reason: '  Compensating   controls were verified on site. ' }).rationale;
  assert.equal(kept, 'Residual risk: Moderate chosen; the assessment suggested High (52). Reason: Compensating controls were verified on site.\n\nDue diligence and the contract review are complete.');
  const replaced = risk.residualOverride({ suggestion, band: 'low', rationale: kept, reason: 'The service no longer touches client data.' }).rationale;
  assert.equal(replaced.match(/^Residual risk:/gm).length, 1, 'a re-save replaces the earlier paragraph');
  assert.match(replaced, /^Residual risk: Low chosen/);
  assert.equal(risk.residualOverride({ suggestion, band: 'high', rationale: kept }).rationale, rationale, 'back on the suggested band, it is dropped');
  assert.deepEqual(risk.residualOverride({ suggestion: { available: false }, band: 'critical', rationale }), { rationale }, 'no suggestion, nothing to differ from');
});
