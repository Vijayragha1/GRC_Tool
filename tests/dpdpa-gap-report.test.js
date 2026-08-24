'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const reports = require('../lib/dpdpa-gap-report');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function fixturePayload(items) {
  return {
    payload_version: 'DPDPA-GAP-1.0',
    captured_at: '2026-08-21T10:00:00.000Z',
    workspace: { client_name: 'Example <Industries>' },
    firm: { name: 'Nimbus Advisory' },
    assessment: {
      id: 42,
      title: 'DPDPA readiness <script>alert(1)</script>',
      scope_statement: 'Indian consumer portal <img src=x onerror=alert(1)>',
      as_of_date: '2026-08-21',
      status: 'Under Review',
      catalog_version: '2026.08',
      catalog_hash: 'b'.repeat(64),
      applicability_profile_hash: 'c'.repeat(64),
      applicability_profile: {
        version: 'DPDPA-APPLICABILITY-1.0',
        organisation_roles: ['Data Fiduciary'],
        digital_personal_data_in_scope: 'Yes',
        children_or_guardian_processing: 'Unknown',
        sdf_designation_state: 'Not Designated',
        statutory_consent_manager_activity: 'No',
        cross_border_processing_or_transfers: 'Yes',
        legacy_consent_cohort: 'Yes',
        exemptions_or_public_data_assumptions: 'No exemption assumed',
        scope_limitations: 'Processor sub-contractors remain subject to validation.',
      },
    },
    reviews: [{ id: 2, action: 'Submit', actor_name: 'Maker & Co', created_at: '2026-08-21T09:00:00Z', note: '<b>review</b>' }],
    items: items || [
      {
        id: 2,
        sort_order: 20,
        requirement_ref: 'DPDPA-S8-02',
        requirement_title: 'Security safeguards',
        requirement_domain: 'Data Fiduciary obligations',
        source_section: 'Section 8(5)',
        effective_date: '2027-05-13',
        legal_effective_status: 'Future Effective',
        applicability_hint: 'In Scope',
        applicability_reason: 'Processing is in scope.',
        status: 'Partially Implemented',
        gap_description: '=HYPERLINK("https://evil.example")',
        recommendation: '+run formula',
        owner_name: '@owner',
        due_date: '2027-01-10',
        evidence_sufficient: 1,
        evidence_manifest: [{
          id: 9,
          filename: '-evidence.xlsx',
          description: '<svg onload=alert(1)>',
          sha256: 'd'.repeat(64),
          uploaded_at: '2026-08-20T10:00:00Z',
          uploader: 'Analyst <admin>',
          current: true,
        }],
        finding_manifest: [{ ref: 'F-2', title: 'Safeguard gap', severity: 'High', status: 'Open' }],
      },
      {
        id: 1,
        sort_order: 10,
        ref: 'DPDPA-S3-01',
        title: 'Board constitution',
        domain: 'Institutional provisions',
        source_section: 'Section 18',
        effective_date: '2025-11-13',
        legal_effective_status: 'Effective',
        status: 'Implemented',
        assessment_note: 'Constitution records inspected.',
        evidence: [{ id: 1, filename: 'gazette.pdf', status: 'Current', hash: 'e'.repeat(64) }],
      },
      {
        id: 3,
        sort_order: 30,
        ref: 'DPDPA-UNSET-01',
        title: 'Controlled legal watch',
        domain: 'Governance',
        status: 'Not Assessed',
      },
    ],
  };
}

function frozenRow(payload, overrides = {}) {
  const snapshotJson = JSON.stringify(stableValue(payload));
  return {
    id: 7,
    sequence_number: 3,
    assessment_row_version: 8,
    status_at_capture: 'Under Review',
    catalog_version: '2026.08',
    catalog_hash: 'b'.repeat(64),
    payload_version: 'DPDPA-GAP-1.0',
    snapshot_json: snapshotJson,
    snapshot_hash: crypto.createHash('sha256').update(snapshotJson).digest('hex'),
    reason: 'Controlled progress export',
    created_at: '2026-08-21T10:00:00.000Z',
    ...overrides,
  };
}

test('normalizes and verifies an immutable frozen snapshot without live dependencies', () => {
  const payload = fixturePayload();
  const model = reports.normalizeSnapshot(frozenRow(payload));
  assert.equal(model.hash_verified, true);
  assert.equal(model.items.length, 3);
  assert.deepEqual(model.items.map(row => row.ref), ['DPDPA-S3-01', 'DPDPA-S8-02', 'DPDPA-UNSET-01']);
  assert.equal(model.metrics.legal.Effective.total, 1);
  assert.equal(model.metrics.legal['Future Effective']['Partially Implemented'], 1);
  assert.equal(model.metrics.legal['Effective Date Not Set']['Not Assessed'], 1);
  assert.equal(model.metrics.overall.Implemented, 1);
  assert.equal(model.approved, false);
  assert.equal(model.prepared_for, 'Example <Industries>');
});

test('rejects corrupt snapshot JSON, a hash mismatch and an envelope payload mismatch', () => {
  assert.throws(
    () => reports.normalizeSnapshot({ snapshot_json: '{bad', snapshot_hash: 'a'.repeat(64) }),
    error => error.code === 'DPDPA_EXPORT_INVALID_JSON'
  );
  assert.throws(
    () => reports.normalizeSnapshot(frozenRow(fixturePayload(), { snapshot_hash: '0'.repeat(64) })),
    error => error.code === 'DPDPA_EXPORT_HASH_MISMATCH'
  );
  const row = frozenRow(fixturePayload());
  assert.throws(
    () => reports.normalizeSnapshot({ snapshot: row, payload: { assessment: {}, items: [] } }),
    error => error.code === 'DPDPA_EXPORT_PAYLOAD_MISMATCH'
  );
});

test('standalone HTML is deterministic, escaped and clearly non-certifying', () => {
  const row = frozenRow(fixturePayload());
  const first = reports.reportHtml(row);
  const second = reports.reportHtml(row);
  assert.equal(first, second);
  assert.match(first, /^<!doctype html>/);
  assert.match(first, /Content-Security-Policy/);
  assert.match(first, /Currently effective/);
  assert.match(first, /Future effective/);
  assert.match(first, /Effective date not set/);
  assert.match(first, /implementation readiness assessment, not legal certification or legal advice/i);
  assert.match(first, /INTERNAL FROZEN PROGRESS SNAPSHOT/);
  assert.match(first, /Example &lt;Industries&gt;/);
  assert.match(first, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(first, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(first, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(first, new RegExp(row.snapshot_hash));
  assert.match(first, new RegExp('b'.repeat(64)));
  assert.doesNotMatch(first, /<script|<img src=x|<svg onload/i);
});

test('approved snapshot removes draft watermark but retains legal qualification', () => {
  const payload = fixturePayload();
  payload.assessment.status = 'Approved';
  const html = reports.reportHtml(frozenRow(payload, { status_at_capture: 'Approved' }));
  assert.doesNotMatch(html, /<div class="watermark">/);
  assert.match(html, /Approved frozen readiness snapshot/);
  assert.match(html, /not legal certification or legal advice/i);
});

test('CSV emits deterministic obligation and evidence rows with formula-injection protection', () => {
  const row = frozenRow(fixturePayload());
  const first = reports.csv(row);
  const second = reports.csv(row);
  assert.equal(first, second);
  assert.ok(first.endsWith('\r\n'));
  assert.equal(first.split('\r\n').filter(Boolean).length, 6, 'header + 3 obligations + 2 evidence rows');
  assert.match(first, /"OBLIGATION"/);
  assert.match(first, /"EVIDENCE"/);
  assert.match(first, /"'=HYPERLINK\(""https:\/\/evil\.example""\)"/);
  assert.match(first, /"'\+run formula"/);
  assert.match(first, /"'@owner"/);
  assert.match(first, /"'-evidence\.xlsx"/);
  assert.match(first, /"Future Effective"/);
  assert.match(first, new RegExp(row.snapshot_hash));
});

test('normalizer accepts a parsed payload envelope and robust legacy field aliases', () => {
  const payload = fixturePayload([{
    requirementRef: 'LEGACY-1',
    requirementTitle: 'Legacy alias row',
    sortOrder: 1,
    effectiveDate: '2027-05-13',
    result: 'Not Applicable',
    not_applicable_rationale: 'Condition does not apply to the recorded role.',
    evidence_manifest_json: JSON.stringify([{ evidence_id: 5, original_name: 'record.pdf', is_current: 1 }]),
  }]);
  const model = reports.normalizeSnapshot({
    snapshot: { sequence_number: 1, status_at_capture: 'Approved', snapshot_hash: 'a'.repeat(64) },
    payload,
  });
  assert.equal(model.hash_verified, false);
  assert.equal(model.items[0].ref, 'LEGACY-1');
  assert.equal(model.items[0].legal_effective_status, 'Future Effective');
  assert.equal(model.items[0].evidence[0].filename, 'record.pdf');
  assert.equal(model.items[0].status, 'Not Applicable');
});

test('invalid frozen assessment status is rejected instead of being silently reclassified', () => {
  const payload = fixturePayload([{ ref: 'BAD-1', title: 'Bad status', status: 'Compliant' }]);
  assert.throws(
    () => reports.normalizeSnapshot({ payload }),
    error => error.code === 'DPDPA_EXPORT_INVALID_STATUS'
  );
});

test('report metadata and buffer helpers are stable for route integrations', () => {
  const model = reports.normalizeSnapshot(frozenRow(fixturePayload()));
  const meta = reports.reportMeta(model);
  assert.equal(meta.filename_base, 'dpdpa-readiness-script-alert-1-script-snapshot-3');
  assert.equal(meta.hash_verified, true);
  const buffer = reports.asBuffer(reports.csv(model));
  assert.ok(Buffer.isBuffer(buffer));
  assert.match(buffer.toString('utf8'), /Snapshot SHA-256/);
  assert.strictEqual(reports.asBuffer(buffer), buffer);
  assert.equal(reports.asBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46])).toString('ascii'), '%PDF');
});
