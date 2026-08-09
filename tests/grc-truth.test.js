'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkspaceStatus, deriveVerdict, qualityScore } = require('../lib/grc-truth');

function auditDb(audits) {
  return {
    prepare(sql) {
      if (/FROM audits/.test(sql)) return { all: () => audits };
      throw new Error(`Unexpected query in test: ${sql}`);
    }
  };
}

test('readiness hard gates remain authoritative over maturity', () => {
  const verdict = deriveVerdict({
    stage1Ready: false,
    stage2Ready: false,
    totalAssessed: 118,
    totalSoaItems: 118,
    stage1: 96
  });
  assert.deepEqual(verdict, { key: 'not_ready', label: 'Not ready', tone: 'danger' });
});

test('partially assessed workspaces are described as in progress', () => {
  const verdict = deriveVerdict({
    stage1Ready: false,
    stage2Ready: false,
    totalAssessed: 60,
    totalSoaItems: 118
  });
  assert.equal(verdict.key, 'assessment_in_progress');
});

test('Stage 2 verdict takes precedence when both certification gates pass', () => {
  const verdict = deriveVerdict({ stage1Ready: true, stage2Ready: true, totalAssessed: 118, totalSoaItems: 118 });
  assert.equal(verdict.key, 'stage_2_ready');
});

test('quality score is severity weighted and bounded', () => {
  assert.deepEqual(qualityScore([]), { score: 100, label: 'Reliable', tone: 'success' });
  assert.deepEqual(qualityScore([{ severity: 'critical' }, { severity: 'high' }, { severity: 'medium' }]), {
    score: 86, label: 'Needs review', tone: 'warning'
  });
  assert.equal(qualityScore(Array.from({ length: 20 }, () => ({ severity: 'critical' }))).score, 0);
});

test('an internal audit mentioning Stage 1 is not classified as a certification audit', () => {
  const status = buildWorkspaceStatus(auditDb([{
    title: 'Internal audit 2025-Q3 - pre-Stage-1', scope: 'ISMS internal audit',
    status: 'completed', lifecycle_stage: 'closed', closed_at: '2026-01-01'
  }]), { id: 1 }, {
    stage1Ready: false, stage2Ready: false, totalAssessed: 118, totalSoaItems: 118,
    stage1: 87, stage2: 62, stage1GatePassed: 13, stage1GateTotal: 17,
    stage2GatePassed: 7, stage2GateTotal: 9
  });
  assert.equal(status.verdict.key, 'not_ready');
  assert.equal(status.lifecycle.key, 'internal_audit');
});

test('only a completed external Stage 1 audit advances certification lifecycle', () => {
  const status = buildWorkspaceStatus(auditDb([{
    title: 'Certification audit - Stage 1', scope: 'External certification body',
    status: 'completed', lifecycle_stage: 'closed', closed_at: '2026-01-01'
  }]), { id: 1 }, {
    stage1Ready: false, stage2Ready: false, totalAssessed: 118, totalSoaItems: 118,
    stage1: 87, stage2: 62, stage1GatePassed: 13, stage1GateTotal: 17,
    stage2GatePassed: 7, stage2GateTotal: 9
  });
  assert.equal(status.lifecycle.key, 'post_stage_1');
  assert.equal(status.verdict.key, 'not_ready');
});
