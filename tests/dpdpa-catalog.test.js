'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../data/dpdpa-catalog');

const EXPECTED_DOMAIN_KEYS = [
  'applicability_scope_accountability',
  'processing_grounds',
  'notice_consent',
  'fiduciary_processor_governance',
  'accuracy_sharing',
  'security_safeguards',
  'breach_readiness',
  'retention_erasure',
  'children_guardians',
  'rights_grievances',
  'transfers_exemptions',
  'significant_data_fiduciary',
  'statutory_consent_manager'
];

const EXPECTED_HASH = 'cf8df71a0a401c97f7324e9f1680f017c4c3ee189a8ccd96901f001e72758801';

test('DPDPA catalog exposes the bounded production corpus in deterministic order', () => {
  assert.equal(catalog.metadata.code, 'dpdpa');
  assert.equal(catalog.metadata.version, '2026.08.21');
  assert.equal(catalog.metadata.schemaVersion, '1.0.0');
  assert.equal(catalog.metadata.reviewedAsOf, '2026-08-21');
  assert.equal(catalog.metadata.domainCount, 13);
  assert.equal(catalog.metadata.obligationCount, 55);
  assert.equal(catalog.domains.length, 13);
  assert.equal(catalog.obligations.length, 55);
  assert.equal(catalog.requirements.length, 55);
  assert.deepEqual(catalog.domains.map(item => item.key), EXPECTED_DOMAIN_KEYS);
  assert.deepEqual(catalog.domains.map(item => item.order), Array.from({ length: 13 }, (_, index) => index + 1));
  assert.deepEqual(catalog.obligations.map(item => item.sortOrder), Array.from({ length: 55 }, (_, index) => index + 1));
  assert.deepEqual(catalog.requirements.map(item => item.ref), catalog.obligations.map(item => item.ref));
});

test('every atomic obligation has stable identity, assessable content and resolvable legal references', () => {
  const sourceIds = new Set(catalog.sources.map(item => item.id));
  const phaseById = new Map(catalog.phases.map(item => [item.id, item]));
  const domainKeys = new Set(EXPECTED_DOMAIN_KEYS);
  const ids = new Set();
  const refs = new Set();
  const allowedSeverities = new Set(['low', 'medium', 'high', 'critical']);

  for (const item of catalog.obligations) {
    assert.equal(item.id, item.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    assert.equal(ids.has(item.id), false, `duplicate id ${item.id}`);
    assert.equal(refs.has(item.ref), false, `duplicate ref ${item.ref}`);
    ids.add(item.id);
    refs.add(item.ref);

    assert.equal(domainKeys.has(item.domain), true, item.ref);
    assert.equal(typeof item.title, 'string', item.ref);
    assert.ok(item.title.length > 5, item.ref);
    assert.ok(item.sourceSectionRule.length > 0, item.ref);
    assert.ok(item.sourceRefs.length > 0, item.ref);
    for (const citation of item.sourceRefs) {
      assert.equal(sourceIds.has(citation.sourceId), true, `${item.ref}: ${citation.sourceId}`);
      assert.ok(citation.provisions.length > 0, item.ref);
    }

    const phase = phaseById.get(item.legalStatus.commencementPhase);
    assert.ok(phase, item.ref);
    assert.equal(item.legalStatus.effectiveDate, phase.effectiveDate, item.ref);
    assert.match(item.legalStatus.effectiveDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(item.legalStatus.commencementBasis.length > 0, item.ref);
    assert.ok(item.legalStatus.transitionMarker.length > 0, item.ref);

    assert.ok(item.applicability.flags.length > 0, item.ref);
    assert.ok(item.applicability.condition.length > 0, item.ref);
    assert.ok(Array.isArray(item.applicability.exclusions), item.ref);
    assert.ok(item.requirement.length > 0, item.ref);
    assert.ok(item.implementationGuidance.length > 0, item.ref);
    assert.ok(item.evidenceExpectations.length > 0, item.ref);
    assert.equal(allowedSeverities.has(item.severity), true, item.ref);
    assert.ok(Number.isInteger(item.weight) && item.weight >= 1 && item.weight <= 5, item.ref);
  }

  for (const key of EXPECTED_DOMAIN_KEYS) {
    assert.ok(catalog.obligations.some(item => item.domain === key), key);
  }
});

test('commencement status is calculated at the assessment date, including exact boundaries', () => {
  const consentManager = catalog.obligations.find(item => item.ref === 'DPDPA-CM-01');
  const ordinaryConsent = catalog.obligations.find(item => item.ref === 'DPDPA-CNS-01');

  assert.equal(consentManager.legalStatus.commencementPhase, 'phase_2_consent_manager');
  assert.equal(consentManager.legalStatus.effectiveDate, '2026-11-13');
  assert.equal(ordinaryConsent.legalStatus.commencementPhase, 'phase_3_substantive');
  assert.equal(ordinaryConsent.legalStatus.effectiveDate, '2027-05-13');

  assert.equal(catalog.effectiveStatus(consentManager, '2026-08-21'), 'future_effective');
  assert.equal(catalog.effectiveStatus(consentManager, '2026-11-12'), 'future_effective');
  assert.equal(catalog.effectiveStatus(consentManager, '2026-11-13'), 'in_force');
  assert.equal(catalog.effectiveStatus(ordinaryConsent, '2027-05-12'), 'future_effective');
  assert.equal(catalog.effectiveStatus(ordinaryConsent, '2027-05-13'), 'in_force');
  assert.equal(catalog.effectiveStatus(ordinaryConsent, new Date('2027-05-13T23:59:59Z')), 'in_force');

  assert.deepEqual(
    new Set(catalog.obligations.filter(item => item.legalStatus.commencementPhase === 'phase_2_consent_manager').map(item => item.domain)),
    new Set(['statutory_consent_manager'])
  );
  assert.equal(catalog.obligations.filter(item => catalog.effectiveStatus(item, '2026-08-21') === 'in_force').length, 0);
  assert.equal(catalog.obligations.filter(item => catalog.effectiveStatus(item, '2026-11-13') === 'in_force').length, 5);
  assert.equal(catalog.obligations.filter(item => catalog.effectiveStatus(item, '2027-05-13') === 'in_force').length, 55);

  assert.throws(() => catalog.effectiveStatus(ordinaryConsent, '2027-02-29'), /valid Date/);
  assert.throws(() => catalog.effectiveStatus({}, '2027-05-13'), /legalStatus\.effectiveDate/);
});

test('content hash is canonical, self-validating and detects corpus tampering', () => {
  assert.equal(catalog.contentHash, EXPECTED_HASH);
  assert.equal(catalog.metadata.contentHash, EXPECTED_HASH);
  assert.equal(catalog.computeContentHash(catalog), EXPECTED_HASH);
  assert.deepEqual(catalog.validateCatalog(catalog), {
    valid: true,
    expectedHash: EXPECTED_HASH,
    actualHash: EXPECTED_HASH,
    errors: []
  });

  const tampered = JSON.parse(JSON.stringify(catalog));
  tampered.obligations[0].requirement = 'Drifted legal requirement';
  const validation = catalog.validateCatalog(tampered);
  assert.equal(validation.valid, false);
  assert.notEqual(validation.actualHash, EXPECTED_HASH);
  assert.match(validation.errors.join('; '), /contentHash does not match/);
  assert.throws(() => catalog.assertValidCatalog(tampered), /Invalid DPDPA catalog/);
});

test('exported corpus data is immutable', () => {
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.metadata), true);
  assert.equal(Object.isFrozen(catalog.obligations), true);
  assert.equal(Object.isFrozen(catalog.obligations[0]), true);
  assert.equal(Object.isFrozen(catalog.obligations[0].applicability.flags), true);
  assert.throws(() => catalog.obligations.push({}), TypeError);
});
