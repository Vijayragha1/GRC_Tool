'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { buildGapAssessmentOverview } = require('../lib/workspace-outcome-overview');

test('gap overview projection describes the governed report endpoint, not certification readiness', () => {
  const overview = buildGapAssessmentOverview({
    control: { total: 118, assessed: 71 },
    currentPhase: 'validation',
    completed: { mobilisation: true, fieldwork: true, validation: false, report: false },
    closure: {
      independentlyApprovedReports: 0,
      ready: false,
      complete: false,
      blockers: ['Record validation sign-off.', 'Publish an independently approved assessment report.'],
      openFindings: 7,
    },
    live: { activeBlockers: 2 },
    requests: [{ status: 'submitted' }, { status: 'accepted' }, { status: 'open' }],
    pass: { pass_number: 2, label: 'Evidence follow-up', status: 'in_progress' },
  });

  assert.equal(overview.servicePath, 'Gap assessment only');
  assert.equal(overview.endpoint, 'Independently reviewed gap-assessment report');
  assert.equal(overview.currentPhaseLabel, 'Factual validation');
  assert.equal(overview.coveragePct, 60);
  assert.equal(overview.reportState, 'Not issued');
  assert.equal(overview.closureBlockerCount, 2);
  assert.equal(overview.openRequests, 2);
  assert.equal(overview.openRecommendations, 7);
  assert.equal(overview.contractClosed, false);
});

test('closed gap overview states that the contracted endpoint is complete', () => {
  const overview = buildGapAssessmentOverview({
    control: { total: 118, assessed: 118 },
    currentPhase: 'complete',
    completed: { mobilisation: true, fieldwork: true, validation: true, report: true },
    closure: { independentlyApprovedReports: 1, ready: false, complete: true, blockers: [], openFindings: 3 },
  });

  assert.equal(overview.currentPhaseLabel, 'Gap assessment complete');
  assert.equal(overview.endpointState, 'Contracted endpoint complete');
  assert.equal(overview.reportState, 'Controlled report issued');
  assert.equal(overview.phaseProgressPct, 100);
  assert.equal(overview.openRecommendations, 3, 'recommendations can remain after a report-only engagement closes');
});

test('issued report is not described as contract closure until the governed close action is recorded', () => {
  const overview = buildGapAssessmentOverview({
    control: { total: 118, assessed: 118 },
    currentPhase: 'complete',
    completed: { mobilisation: true, fieldwork: true, validation: true, report: true },
    closure: { independentlyApprovedReports: 1, ready: true, complete: false, blockers: [], openFindings: 4 },
  });

  assert.equal(overview.currentPhaseLabel, 'Ready for governed closure');
  assert.equal(overview.endpointState, 'Ready for governed closure');
  assert.equal(overview.contractClosed, false);
  assert.match(overview.currentPhaseDescription, /Complete the governed engagement-closure action/);
});

test('workspace template keeps report-only and certification surfaces explicitly separated', () => {
  const filename = path.join(__dirname, '..', 'views', 'workspace.ejs');
  const source = fs.readFileSync(filename, 'utf8');

  assert.doesNotThrow(() => ejs.compile(source, { filename }), 'workspace EJS must compile');
  assert.match(source, /if \(isGapAssessmentOnly\)/);
  assert.match(source, /Gap assessment position/);
  assert.match(source, /Certification position/);
  assert.match(source, /certification-readiness percentages elsewhere in the workspace are diagnostic indicators only/i);
  assert.match(source, /gap-assessment\/fieldwork/);
  assert.doesNotMatch(source, /\/gap-fieldwork/);
  assert.match(source, /name="target_cert_date"[^\n]*isGapAssessmentOnly \|\| !hasIso27001[^\n]*disabled aria-disabled="true"/);
});
