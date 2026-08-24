'use strict';

// DPDPA gap-assessment exports deliberately operate on an immutable snapshot
// only. This module has no database dependency, no clock reads and no network
// access: the same frozen input always produces the same HTML and CSV bytes.

const crypto = require('crypto');
// Catalogue content and the gap ranking, shared with the on-screen module so a
// downloaded report orders the same work the same way. The module is a pure
// function of the frozen catalogue and a supplied date: no database, no clock.
const content = require('./dpdpa-content');

const ITEM_STATUSES = Object.freeze([
  'Not Assessed',
  'Implemented',
  'Partially Implemented',
  'Not Implemented',
  'Not Applicable',
]);
const LEGAL_STATUSES = Object.freeze([
  'Effective',
  'Future Effective',
  'Effective Date Not Set',
]);
const PROFILE_FIELDS = Object.freeze([
  ['organisation_roles', 'Organisation roles'],
  ['digital_personal_data_in_scope', 'Digital personal data in scope'],
  ['children_or_guardian_processing', 'Children / guardian processing'],
  ['sdf_designation_state', 'Significant Data Fiduciary designation'],
  ['statutory_consent_manager_activity', 'Statutory Consent Manager activity'],
  ['cross_border_processing_or_transfers', 'Cross-border processing / transfers'],
  ['legacy_consent_cohort', 'Legacy consent cohort'],
  ['exemptions_or_public_data_assumptions', 'Exemptions / public-data assumptions'],
  ['scope_limitations', 'Scope limitations'],
]);
const NORMALIZED_MODELS = new WeakSet();

class SnapshotExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotExportError';
    this.code = code;
    this.status = 409;
  }
}

function own(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  if (value == null) return fallback;
  return String(value);
}

function trimmed(value, fallback = '') {
  const result = text(value).trim();
  return result || fallback;
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function safeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function parseJson(value, label, fallback) {
  if (value == null || value === '') return fallback;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    throw new SnapshotExportError(
      'DPDPA_EXPORT_INVALID_JSON',
      `${label || 'Frozen snapshot'} is not valid JSON.`
    );
  }
}

function parseArray(value, label) {
  const parsed = parseJson(value, label, []);
  return Array.isArray(parsed) ? parsed : [];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  const a = text(left);
  const b = text(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function formulaSafe(value) {
  const raw = text(value);
  // Spreadsheet applications may ignore leading spaces and control characters
  // before evaluating a formula. Prefix a literal apostrophe before quoting.
  return /^[\u0000-\u0020\u00a0\ufeff]*[=+\-@]/u.test(raw) || /^[\t\r\n]/.test(raw)
    ? `'${raw}`
    : raw;
}

function escapeCsvCell(value) {
  return `"${formulaSafe(value).replace(/"/g, '""')}"`;
}

function normalizeBoolean(value, fallback = null) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function normalizeEvidence(raw, index) {
  const source = record(raw);
  const stale = normalizeBoolean(first(source.stale, source.is_stale), false)
    || ['superseded', 'expired', 'stale'].includes(trimmed(source.status).toLowerCase());
  const currentFlag = normalizeBoolean(first(source.current, source.is_current), null);
  return Object.freeze({
    id: first(source.id, source.evidence_id, source.document_id),
    reference: trimmed(first(source.reference, source.ref, source.evidence_ref)),
    filename: trimmed(first(source.filename, source.original_name, source.display_name, source.name, source.title), 'Unnamed evidence'),
    description: trimmed(source.description),
    sha256: trimmed(first(source.sha256, source.hash, source.content_hash)),
    uploaded_at: trimmed(first(source.uploaded_at, source.created_at, source.linked_at)),
    uploader: trimmed(first(source.uploader, source.uploaded_by_name, source.owner_name)),
    status: trimmed(source.status, stale ? 'Stale' : 'Current'),
    stale,
    current: currentFlag === null ? !stale : currentFlag && !stale,
    sort_index: index,
  });
}

function normalizeFinding(raw, index) {
  const source = record(raw);
  return Object.freeze({
    id: first(source.id, source.finding_id),
    reference: trimmed(first(source.reference, source.ref, source.finding_ref)),
    title: trimmed(first(source.title, source.name), 'Untitled finding'),
    severity: trimmed(first(source.severity, source.priority)),
    status: trimmed(source.status),
    sort_index: index,
  });
}

function inferredLegalStatus(raw, asOfDate) {
  const declared = trimmed(first(raw.legal_effective_status, raw.legalEffectiveStatus));
  if (LEGAL_STATUSES.includes(declared)) return declared;
  const effectiveDate = trimmed(first(raw.effective_date, raw.effectiveDate));
  if (!effectiveDate) return 'Effective Date Not Set';
  return asOfDate && effectiveDate > asOfDate ? 'Future Effective' : 'Effective';
}

function normalizeItem(raw, index, asOfDate) {
  const source = record(raw);
  const status = trimmed(first(source.status, source.result), 'Not Assessed');
  if (!ITEM_STATUSES.includes(status)) {
    throw new SnapshotExportError(
      'DPDPA_EXPORT_INVALID_STATUS',
      `Frozen obligation ${trimmed(first(source.ref, source.requirement_ref), index + 1)} has an invalid assessment status.`
    );
  }
  const evidenceSource = first(
    source.evidence_manifest,
    source.evidence,
    source.evidence_manifest_json
  );
  const findingSource = first(
    source.finding_manifest,
    source.findings,
    source.finding_manifest_json
  );
  const evidence = parseArray(evidenceSource, 'Frozen evidence manifest')
    .map(normalizeEvidence)
    .sort((a, b) => compareText(first(a.id, a.reference, a.filename), first(b.id, b.reference, b.filename)) || a.sort_index - b.sort_index);
  const findings = parseArray(findingSource, 'Frozen finding manifest')
    .map(normalizeFinding)
    .sort((a, b) => compareText(first(a.reference, a.id, a.title), first(b.reference, b.id, b.title)) || a.sort_index - b.sort_index);
  const manifestCurrent = evidence.filter(row => row.current).length;
  const manifestStale = evidence.filter(row => row.stale || !row.current).length;
  return Object.freeze({
    id: first(source.id, source.item_id),
    sort_order: safeInteger(first(source.sort_order, source.sortOrder), index + 1),
    ref: trimmed(first(source.ref, source.requirement_ref, source.requirementRef), `ITEM-${index + 1}`),
    title: trimmed(first(source.title, source.requirement_title, source.requirementTitle), 'Untitled obligation'),
    description: trimmed(first(source.description, source.requirement_description, source.summary)),
    domain: trimmed(first(source.domain, source.requirement_domain), 'General obligation'),
    source_section: trimmed(first(source.source_section, source.sourceSection)),
    source_rule: trimmed(first(source.source_rule, source.sourceRule)),
    effective_date: trimmed(first(source.effective_date, source.effectiveDate)),
    legal_effective_status: inferredLegalStatus(source, asOfDate),
    applicability_hint: trimmed(first(source.applicability_hint, source.applicabilityHint), 'Requires Review'),
    applicability_reason: trimmed(first(source.applicability_reason, source.applicabilityReason), 'Human applicability review is required.'),
    status,
    assessment_note: trimmed(first(source.assessment_note, source.conclusion, source.rationale)),
    gap_description: trimmed(first(source.gap_description, source.gap)),
    recommendation: trimmed(first(source.recommendation, source.recommended_action)),
    owner: trimmed(first(source.owner_name, source.owner, source.action_owner_name)),
    due_date: trimmed(first(source.due_date, source.target_date)),
    na_rationale: trimmed(first(source.na_rationale, source.not_applicable_rationale)),
    evidence_sufficient: normalizeBoolean(source.evidence_sufficient, null),
    evidence_current_count: safeInteger(first(source.evidence_current_count, source.current_evidence_count), manifestCurrent),
    evidence_stale_count: safeInteger(first(source.evidence_stale_count, source.stale_evidence_count), manifestStale),
    evidence,
    findings,
    finding_count: safeInteger(source.finding_count, findings.length),
    sort_index: index,
  });
}

function normalizeReview(raw, index) {
  const source = record(raw);
  return Object.freeze({
    id: first(source.id, source.review_id),
    action: trimmed(first(source.action, source.event_type, source.decision, source.to_status), 'Review'),
    actor: trimmed(first(source.actor_name, source.created_by_name, source.reviewer_name, source.actor_id, source.created_by), 'Not recorded'),
    created_at: trimmed(first(source.created_at, source.occurred_at, source.reviewed_at)),
    note: trimmed(first(source.note, source.reason, source.comment)),
    sort_index: index,
  });
}

function snapshotEnvelope(input) {
  const rootValue = parseJson(input, 'Frozen snapshot', null);
  if (!rootValue || typeof rootValue !== 'object' || Array.isArray(rootValue)) {
    throw new SnapshotExportError('DPDPA_EXPORT_INVALID_SNAPSHOT', 'A frozen DPDPA snapshot object is required.');
  }
  const root = record(rootValue);
  const nestedSnapshot = record(root.snapshot);
  const snapshotRow = own(root, 'snapshot_json') ? root
    : own(nestedSnapshot, 'snapshot_json') ? nestedSnapshot
      : nestedSnapshot;
  const frozenJson = own(snapshotRow, 'snapshot_json') ? snapshotRow.snapshot_json : null;
  const frozenPayload = frozenJson == null ? null : parseJson(frozenJson, 'Frozen snapshot payload', null);
  const suppliedPayload = own(root, 'payload') ? parseJson(root.payload, 'Frozen snapshot payload', null) : null;

  if (frozenPayload && suppliedPayload && stableStringify(frozenPayload) !== stableStringify(suppliedPayload)) {
    throw new SnapshotExportError(
      'DPDPA_EXPORT_PAYLOAD_MISMATCH',
      'The supplied payload differs from the immutable snapshot JSON.'
    );
  }
  const payload = frozenPayload || suppliedPayload || root;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SnapshotExportError('DPDPA_EXPORT_INVALID_SNAPSHOT', 'Frozen snapshot payload must be a JSON object.');
  }

  const declaredHash = trimmed(first(snapshotRow.snapshot_hash, root.snapshot_hash));
  let hashVerified = false;
  if (frozenJson != null && declaredHash) {
    const actualHash = sha256(typeof frozenJson === 'string' ? frozenJson : stableStringify(frozenJson));
    if (actualHash !== declaredHash) {
      throw new SnapshotExportError(
        'DPDPA_EXPORT_HASH_MISMATCH',
        'The frozen DPDPA snapshot payload does not match its recorded SHA-256 hash.'
      );
    }
    hashVerified = true;
  }
  return { root, snapshotRow, payload: record(payload), declaredHash, hashVerified };
}

function normalizeProfile(value) {
  const parsed = parseJson(value, 'Frozen applicability profile', {});
  const profile = record(parsed);
  const normalized = {};
  for (const key of Object.keys(profile).sort(compareText)) {
    const raw = profile[key];
    normalized[key] = Array.isArray(raw) ? raw.map(entry => text(entry)) : text(raw);
  }
  return Object.freeze(normalized);
}

function emptyCounts() {
  return {
    total: 0,
    'Not Assessed': 0,
    Implemented: 0,
    'Partially Implemented': 0,
    'Not Implemented': 0,
    'Not Applicable': 0,
  };
}

function deriveMetrics(items) {
  const overall = emptyCounts();
  const legal = Object.fromEntries(LEGAL_STATUSES.map(status => [status, emptyCounts()]));
  for (const item of items) {
    overall.total += 1;
    overall[item.status] += 1;
    const group = legal[item.legal_effective_status];
    group.total += 1;
    group[item.status] += 1;
  }
  return Object.freeze({
    overall: Object.freeze(overall),
    legal: Object.freeze(Object.fromEntries(
      Object.entries(legal).map(([key, value]) => [key, Object.freeze(value)])
    )),
  });
}

function normalizeLimitations(payload, assessment, profile) {
  const raw = [];
  const add = value => {
    if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') add(first(value.text, value.description, value.note));
    else if (trimmed(value)) raw.push(trimmed(value));
  };
  add(payload.limitations);
  add(assessment.limitations);
  add(profile.scope_limitations);
  return Object.freeze([...new Set(raw)]);
}

function normalizeSnapshot(input) {
  const envelope = snapshotEnvelope(input);
  const { root, snapshotRow, payload } = envelope;
  const assessment = record(first(payload.assessment, payload.assessment_snapshot));
  const asOfDate = trimmed(first(assessment.as_of_date, assessment.asOfDate, payload.as_of_date));
  const rawItems = first(payload.items, payload.obligations, payload.requirements);
  if (!Array.isArray(rawItems)) {
    throw new SnapshotExportError(
      'DPDPA_EXPORT_ITEMS_REQUIRED',
      'Frozen snapshot payload does not contain an obligation register.'
    );
  }
  const items = rawItems.map((item, index) => normalizeItem(item, index, asOfDate))
    .sort((a, b) => a.sort_order - b.sort_order || compareText(a.ref, b.ref) || a.sort_index - b.sort_index);
  const reviews = parseArray(first(payload.reviews, payload.review_events), 'Frozen review record')
    .map(normalizeReview)
    .sort((a, b) => compareText(a.created_at, b.created_at) || compareText(first(a.id, a.action), first(b.id, b.action)) || a.sort_index - b.sort_index);
  const profile = normalizeProfile(first(
    assessment.applicability_profile,
    assessment.applicability_profile_json,
    payload.applicability_profile,
    payload.applicability_profile_json
  ));
  const workspace = record(first(payload.workspace, payload.organisation, payload.organization));
  const firm = record(first(payload.firm, payload.preparer));
  const status = trimmed(first(
    snapshotRow.status_at_capture,
    root.status_at_capture,
    assessment.status,
    payload.status_at_capture
  ), 'Snapshot');
  const catalogHash = trimmed(first(
    snapshotRow.catalog_hash,
    root.catalog_hash,
    assessment.catalog_hash,
    payload.catalog_hash,
    record(payload.integrity).catalog_hash
  ));
  const catalogVersion = trimmed(first(
    snapshotRow.catalog_version,
    root.catalog_version,
    assessment.catalog_version,
    payload.catalog_version
  ));
  const snapshotHash = trimmed(first(
    envelope.declaredHash,
    record(payload.integrity).snapshot_hash,
    payload.snapshot_hash
  ));
  const normalized = {
    payload_version: trimmed(first(snapshotRow.payload_version, root.payload_version, payload.payload_version), 'DPDPA-GAP-1.0'),
    snapshot_id: first(snapshotRow.id, root.snapshot_id, payload.snapshot_id),
    sequence_number: safeInteger(first(snapshotRow.sequence_number, root.sequence_number, payload.sequence_number), 0),
    assessment_row_version: safeInteger(first(snapshotRow.assessment_row_version, root.assessment_row_version, assessment.row_version), 0),
    captured_at: trimmed(first(snapshotRow.created_at, root.created_at, payload.captured_at)),
    snapshot_reason: trimmed(first(snapshotRow.reason, root.reason, payload.snapshot_reason), 'Controlled reporting snapshot'),
    snapshot_hash: snapshotHash,
    hash_verified: envelope.hashVerified,
    catalog_hash: catalogHash,
    catalog_version: catalogVersion,
    status,
    approved: status === 'Approved',
    assessment: Object.freeze({
      id: first(assessment.id, assessment.assessment_id, payload.assessment_id),
      title: trimmed(first(assessment.title, payload.title), 'DPDPA gap assessment'),
      scope_statement: trimmed(first(assessment.scope_statement, assessment.scopeStatement, payload.scope_statement), 'No scope statement retained in the frozen snapshot.'),
      as_of_date: asOfDate,
      created_by_name: trimmed(first(assessment.created_by_name, assessment.creator_name)),
      submitted_by_name: trimmed(first(assessment.submitted_by_name, assessment.submitter_name)),
      approved_by_name: trimmed(first(assessment.approved_by_name, assessment.approver_name)),
      created_at: trimmed(assessment.created_at),
      submitted_at: trimmed(assessment.submitted_at),
      approved_at: trimmed(assessment.approved_at),
      baseline_assessment_id: first(assessment.baseline_assessment_id, payload.baseline_assessment_id),
      baseline_snapshot_id: first(assessment.baseline_snapshot_id, payload.baseline_snapshot_id),
      applicability_profile_hash: trimmed(first(assessment.applicability_profile_hash, payload.applicability_profile_hash)),
    }),
    prepared_for: trimmed(first(
      workspace.client_name,
      workspace.name,
      payload.prepared_for,
      assessment.client_name
    ), 'Organisation retained in the frozen assessment scope'),
    prepared_by: trimmed(first(firm.name, payload.prepared_by, assessment.firm_name), 'Not recorded in snapshot'),
    profile,
    limitations: null,
    items: Object.freeze(items),
    reviews: Object.freeze(reviews),
    metrics: deriveMetrics(items),
  };
  normalized.limitations = normalizeLimitations(payload, assessment, profile);
  Object.freeze(normalized);
  NORMALIZED_MODELS.add(normalized);
  return normalized;
}

function modelFor(input) {
  return input && typeof input === 'object' && NORMALIZED_MODELS.has(input)
    ? input
    : normalizeSnapshot(input);
}

function reportMeta(input) {
  const model = modelFor(input);
  const slug = model.assessment.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
    || 'dpdpa-gap-assessment';
  return Object.freeze({
    title: model.assessment.title,
    approved: model.approved,
    reliance_label: model.approved ? 'Approved frozen readiness snapshot' : 'Internal frozen progress snapshot - not for reliance',
    filename_base: `${slug}-snapshot-${model.sequence_number || 'export'}`,
    snapshot_hash: model.snapshot_hash,
    catalog_hash: model.catalog_hash,
    hash_verified: model.hash_verified,
  });
}

function countCells(counts) {
  return `<td>${counts.total}</td><td>${counts.Implemented}</td><td>${counts['Partially Implemented']}</td><td>${counts['Not Implemented']}</td><td>${counts['Not Applicable']}</td><td>${counts['Not Assessed']}</td>`;
}

function profileRows(profile) {
  const used = new Set(PROFILE_FIELDS.map(([key]) => key));
  const rows = PROFILE_FIELDS.map(([key, label]) => {
    const value = profile[key];
    const rendered = Array.isArray(value) ? value.join(', ') : value;
    return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(rendered || 'Not recorded')}</td></tr>`;
  });
  for (const key of Object.keys(profile).sort(compareText)) {
    if (used.has(key) || key === 'version') continue;
    const value = Array.isArray(profile[key]) ? profile[key].join(', ') : profile[key];
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
    rows.push(`<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || 'Not recorded')}</td></tr>`);
  }
  return rows.join('');
}

function evidenceTable(item) {
  if (!item.evidence.length) {
    return `<p class="empty">No evidence manifest rows were retained for this obligation. Frozen counts: ${item.evidence_current_count} current; ${item.evidence_stale_count} stale.</p>`;
  }
  return `<table class="evidence"><thead><tr><th>Evidence</th><th>Integrity</th><th>Captured status</th></tr></thead><tbody>${item.evidence.map(row => `<tr>
    <td><strong>${escapeHtml(row.filename)}</strong>${row.description ? `<small>${escapeHtml(row.description)}</small>` : ''}${row.uploader ? `<small>Uploaded by ${escapeHtml(row.uploader)}${row.uploaded_at ? ` · ${escapeHtml(row.uploaded_at)}` : ''}</small>` : row.uploaded_at ? `<small>${escapeHtml(row.uploaded_at)}</small>` : ''}</td>
    <td>${row.reference ? `<code>${escapeHtml(row.reference)}</code>` : ''}${row.sha256 ? `<code>${escapeHtml(row.sha256)}</code>` : '<span>Hash not retained</span>'}</td>
    <td><span class="pill ${row.current ? 'ok' : 'warn'}">${escapeHtml(row.current ? 'Current' : 'Stale / not current')}</span></td>
  </tr>`).join('')}</tbody></table>`;
}

// The position in words. A reader who opens a gap assessment wants the
// sentence first and the counts second.
function positionNarrative(model) {
  const r = content.readinessOf(model.items);
  const critical = content.rankedGaps(model.items, { asOfDate: model.assessment.as_of_date })
    .filter(gap => gap.content && gap.content.severity === 'critical').length;
  const parts = [
    `Of ${r.total} catalogue obligations, ${r.notApplicable} were concluded not applicable to this boundary, leaving ${r.inScope} in scope.`,
    `${r.implemented} are implemented and ${r.partial} are partially implemented, a readiness position of ${r.readinessPct}% when partial implementation is credited at half weight.`,
    `${r.notImplemented} obligation(s) have no implementation at all${critical ? `, ${critical} of which the catalogue rates critical` : ''}.`,
  ];
  if (r.notAssessed) parts.push(`${r.notAssessed} obligation(s) were not concluded in this snapshot.`);
  return `<p class="lead">${escapeHtml(parts.join(' '))}</p>`;
}

// Where the work sits, ordered by open gaps rather than by catalogue order.
function domainTable(items) {
  const rows = content.domainMatrix(items);
  if (!rows.length) return '<div class="empty">No obligation rows were retained in this snapshot.</div>';
  return `<table><thead><tr><th>Obligation domain</th><th>Readiness</th><th>Implemented</th><th>Partial</th><th>Not implemented</th><th>In scope</th></tr></thead><tbody>${
    rows.map(row => `<tr>
      <td><strong>${escapeHtml(row.domain)}</strong>${row.criticalGaps ? `<small>${row.criticalGaps} critical gap(s)</small>` : ''}</td>
      <td>${row.readinessPct}%</td>
      <td>${row.implemented}</td>
      <td>${row.partial}</td>
      <td>${row.notImplemented}</td>
      <td>${row.inScope}</td>
    </tr>`).join('')
  }</tbody></table>`;
}

// Ranked remediation. The export previously stopped at counts and a flat
// register, leaving the client to work out what to do first.
function prioritySection(model) {
  const gaps = content.rankedGaps(model.items, { asOfDate: model.assessment.as_of_date });
  if (!gaps.length) {
    return '<div class="empty">No obligation was concluded Not Implemented or Partially Implemented in this snapshot.</div>';
  }
  const immediate = gaps.filter(gap => gap.priority.band === 'Immediate').length;
  const lead = `<p class="lead">${escapeHtml(content.PRIORITY_RULE)}${
    immediate ? ` ${immediate} gap(s) rank immediate.` : ''
  }</p>`;
  const entries = gaps.map(gap => {
    const c = gap.content;
    const source = c ? c.sourceSectionRule : [gap.source_section, gap.source_rule].filter(Boolean).join(' · ');
    const band = gap.priority.band === 'Immediate' || gap.priority.band === 'High' ? 'warn' : '';
    return `<article class="obligation">
      <div class="obligation-head"><div><code>${escapeHtml(gap.ref)}</code>${source ? `<small>${escapeHtml(source)}</small>` : ''}</div><span class="pill ${band}">${escapeHtml(gap.priority.band)}</span></div>
      <h3>${escapeHtml(gap.title)}</h3>
      <table class="facts compact"><tbody>
        <tr><th>Domain</th><td>${escapeHtml(c ? c.domain : gap.domain)}</td><th>Statutory severity</th><td>${escapeHtml(c ? c.severityLabel : 'Not recorded')}</td></tr>
        <tr><th>Current result</th><td>${escapeHtml(gap.status)}</td><th>Commences</th><td>${escapeHtml(c ? c.effectiveDateLong : (gap.effective_date || 'Date not set'))}</td></tr>
        <tr><th>Accountable owner</th><td>${escapeHtml(gap.owner || 'Not assigned')}</td><th>Target date</th><td>${escapeHtml(gap.due_date || 'Not set')}</td></tr>
      </tbody></table>
      ${gap.gap_description ? `<p><strong>Gap.</strong> ${escapeHtml(gap.gap_description)}</p>` : ''}
      ${gap.recommendation ? `<p><strong>Recommended action.</strong> ${escapeHtml(gap.recommendation)}</p>` : ''}
    </article>`;
  }).join('');
  return `${lead}${entries}`;
}

// The exclusion register. Every Not Applicable conclusion in one place is the
// first thing a reviewer or a regulator asks to see.
function exclusionSection(model) {
  const excluded = model.items.filter(item => item.status === 'Not Applicable');
  if (!excluded.length) {
    return '<div class="empty">No obligation was concluded Not Applicable in this snapshot.</div>';
  }
  const entries = excluded.map(item => {
    const c = content.contentFor(item.ref);
    const source = c ? c.sourceSectionRule : [item.source_section, item.source_rule].filter(Boolean).join(' · ');
    return `<article class="obligation">
      <div class="obligation-head"><div><code>${escapeHtml(item.ref)}</code>${source ? `<small>${escapeHtml(source)}</small>` : ''}</div><span class="pill">${escapeHtml(item.domain)}</span></div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.na_rationale || 'No rationale was retained in the supplied snapshot.')}</p>
    </article>`;
  }).join('');
  return `<p class="lead">Each exclusion was recorded by a named assessor with a specific rationale and accepted by the independent approver against that exact conclusion version. No obligation was excluded by an automated applicability rule.</p>${entries}`;
}

function itemAppendix(items) {
  return items.map(item => {
    const source = [item.source_section, item.source_rule].filter(Boolean).join(' · ');
    const findingText = item.findings.length
      ? `<ul>${item.findings.map(row => `<li>${escapeHtml([row.reference, row.title, row.severity, row.status].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`
      : `<span>${item.finding_count} finding(s) retained by count; no finding manifest rows supplied.</span>`;
    return `<article class="obligation">
      <div class="obligation-head"><div><code>${escapeHtml(item.ref)}</code>${source ? `<small>${escapeHtml(source)}</small>` : ''}</div><span class="pill">${escapeHtml(item.status)}</span></div>
      <h3>${escapeHtml(item.title)}</h3>
      ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
      <table class="facts compact"><tbody>
        <tr><th>Domain</th><td>${escapeHtml(item.domain)}</td><th>Legal timing</th><td>${escapeHtml(item.legal_effective_status)}${item.effective_date ? ` · ${escapeHtml(item.effective_date)}` : ''}</td></tr>
        <tr><th>Applicability</th><td colspan="3">${escapeHtml(item.applicability_hint)} - ${escapeHtml(item.applicability_reason)}</td></tr>
        <tr><th>Conclusion</th><td colspan="3">${escapeHtml(item.assessment_note || 'No conclusion note retained.')}</td></tr>
        <tr><th>Gap</th><td colspan="3">${escapeHtml(item.gap_description || 'No separate gap description retained.')}</td></tr>
        <tr><th>Recommended action</th><td colspan="3">${escapeHtml(item.recommendation || 'No recommendation retained.')}</td></tr>
        <tr><th>Owner / due date</th><td>${escapeHtml(item.owner || 'Not assigned')} · ${escapeHtml(item.due_date || 'No due date')}</td><th>Evidence gate</th><td>${item.evidence_sufficient === null ? 'Not recorded' : item.evidence_sufficient ? 'Sufficient at capture' : 'Insufficient at capture'}</td></tr>
        ${item.status === 'Not Applicable' ? `<tr><th>N/A rationale</th><td colspan="3">${escapeHtml(item.na_rationale || 'No rationale retained in the supplied snapshot.')}</td></tr>` : ''}
      </tbody></table>
      <h4>Frozen evidence manifest</h4>${evidenceTable(item)}
      <h4>Frozen finding links</h4>${findingText}
    </article>`;
  }).join('');
}

function reportHtml(input) {
  const model = modelFor(input);
  const meta = reportMeta(model);
  const overall = model.metrics.overall;
  const current = model.metrics.legal.Effective;
  const future = model.metrics.legal['Future Effective'];
  const unset = model.metrics.legal['Effective Date Not Set'];
  const watermark = model.approved ? '' : '<div class="watermark">INTERNAL FROZEN PROGRESS SNAPSHOT - NOT FOR RELIANCE</div>';
  const limitationRows = model.limitations.length
    ? model.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')
    : '<li>No additional scope limitation was retained in the supplied frozen snapshot.</li>';
  const reviewRows = model.reviews.length
    ? model.reviews.map(row => `<tr><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.actor)}</td><td>${escapeHtml(row.created_at || 'Not recorded')}</td><td>${escapeHtml(row.note || '-')}</td></tr>`).join('')
    : '<tr><td colspan="4">No separate review-event rows were retained in the supplied snapshot.</td></tr>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(model.assessment.title)} - frozen DPDPA readiness report</title>
<style>
@page{size:A4;margin:16mm 14mm 18mm}*{box-sizing:border-box}html{--ink:#17242a;--muted:#607078;--line:#d9e1e4;--pale:#f3f6f7;--accent:#6d1d2a;--ok:#21664f;--warn:#9a5b12}body{margin:0;background:#fff;color:var(--ink);font:9.2px/1.48 Arial,Helvetica,sans-serif}h1,h2{font-family:Georgia,'Times New Roman',serif}h1{font-size:34px;line-height:1.08;margin:0 0 14px}h2{font-size:21px;margin:0 0 10px}h3{font-size:13px;margin:10px 0 7px}h4{font-size:9px;text-transform:uppercase;letter-spacing:.08em;margin:13px 0 5px}p{margin:0 0 8px}.page{page-break-before:always;position:relative;z-index:1}.cover{min-height:250mm;padding:24mm 18mm 16mm;background:#17323a;color:#fff;border-left:7px solid var(--accent);display:flex;flex-direction:column;position:relative;z-index:1}.eyebrow{text-transform:uppercase;letter-spacing:.17em;font-size:7.5px;color:#b9cdd1}.cover-main{margin-top:42mm;max-width:610px}.cover-main p{font-size:13px;color:#c8d8db}.cover-client{margin-top:auto;border-top:1px solid rgba(255,255,255,.28);padding-top:18px}.cover-client span,.cover-facts span{display:block;text-transform:uppercase;letter-spacing:.12em;font-size:7px;color:#a7bec3}.cover-client strong{display:block;font:24px Georgia,serif;margin:4px 0}.cover-facts{width:100%;border-collapse:collapse;margin-top:18px}.cover-facts td{width:50%;border:1px solid rgba(255,255,255,.19);padding:9px}.page{padding-top:2mm}.section-label{text-transform:uppercase;letter-spacing:.16em;font-size:7.5px;font-weight:bold;color:var(--accent);margin-bottom:8px}.lead{font-size:11px;line-height:1.55;color:#455a62;max-width:670px}.notice{border-left:4px solid var(--accent);background:var(--pale);padding:11px 13px;margin:13px 0;page-break-inside:avoid}.notice.warn{border-color:var(--warn);background:#fff8e9}.notice strong{font-size:10px}.notice p{margin:3px 0 0;color:#4f6067}.kpis{display:table;width:100%;table-layout:fixed;margin:14px 0}.kpis>div{display:table-cell;border:1px solid var(--line);padding:10px}.kpis strong{display:block;font:22px Georgia,serif;color:var(--accent)}.kpis span{display:block;font-size:7px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:6px 7px;text-align:left;vertical-align:top}thead th{background:var(--pale);text-transform:uppercase;letter-spacing:.07em;font-size:7px;color:#506068}.facts th{width:19%;background:var(--pale);text-transform:uppercase;font-size:7px;color:var(--muted)}.facts td{width:31%}.facts.compact th,.facts.compact td{padding:5px 6px}.profile th{width:29%;background:var(--pale);font-size:7px;text-transform:uppercase;color:var(--muted)}code{display:block;font:7.2px/1.35 'Courier New',monospace;color:#1a5b68;word-break:break-all}.integrity code{font-size:6.7px}.watermark{position:fixed;top:47%;left:4%;transform:rotate(-29deg);z-index:0;color:rgba(135,53,43,.085);font-size:24px;font-weight:bold;letter-spacing:.08em;white-space:nowrap}.obligation{page-break-inside:avoid;border:1px solid var(--line);border-top:4px solid var(--accent);padding:11px;margin:0 0 12px}.obligation-head{display:table;width:100%}.obligation-head>div,.obligation-head>span{display:table-cell;vertical-align:top}.obligation-head>span{text-align:right}.obligation-head small,.evidence small{display:block;color:var(--muted);font-size:7px}.pill{display:inline-block;padding:3px 6px;background:#e9eef0;border-radius:2px;font-size:7px;font-weight:bold}.pill.ok{background:#e6f3ed;color:var(--ok)}.pill.warn{background:#fff1dc;color:var(--warn)}.evidence td:first-child{width:48%}.evidence td:nth-child(2){width:34%}.empty{border:1px dashed #b8c3c7;padding:8px;color:var(--muted)}ul{margin:6px 0;padding-left:18px}.footer-note{margin-top:18px;padding-top:8px;border-top:1px solid var(--line);color:var(--muted);font-size:7px}thead{display:table-header-group}tr{page-break-inside:avoid}
</style></head><body>${watermark}
<section class="cover"><div class="eyebrow">Digital Personal Data Protection Act, 2023 readiness</div><div class="cover-main"><h1>${escapeHtml(model.assessment.title)}</h1><p>Evidence-backed implementation gap assessment, frozen for controlled reporting as of ${escapeHtml(model.assessment.as_of_date || 'the recorded assessment date')}.</p></div><div class="cover-client"><span>Prepared for</span><strong>${escapeHtml(model.prepared_for)}</strong><small>${escapeHtml(meta.reliance_label)}</small></div><table class="cover-facts"><tbody><tr><td><span>Snapshot</span>Sequence ${model.sequence_number || 'not recorded'} · ${escapeHtml(model.captured_at || 'capture time not recorded')}</td><td><span>Catalogue</span>${escapeHtml(model.catalog_version || 'Version not recorded')}</td></tr><tr><td><span>Prepared by</span>${escapeHtml(model.prepared_by)}</td><td><span>As-of date</span>${escapeHtml(model.assessment.as_of_date || 'Not recorded')}</td></tr></tbody></table></section>
<section class="page"><div class="section-label">01 - Document control and intended use</div><h2>Controlled readiness record</h2><div class="notice ${model.approved ? '' : 'warn'}"><strong>${escapeHtml(meta.reliance_label)}</strong><p>This is a DPDPA implementation readiness assessment, not legal certification or legal advice. It does not issue an automated compliance conclusion or replace qualified legal review. Read every conclusion with the stated scope, applicability assumptions, legal effective date, evidence record and limitations.${model.approved ? '' : ' This snapshot was captured before independent approval and is not for external reliance.'}</p></div>
<table class="facts"><tbody><tr><th>Assessment status</th><td>${escapeHtml(model.status)}</td><th>Payload version</th><td>${escapeHtml(model.payload_version)}</td></tr><tr><th>As-of date</th><td>${escapeHtml(model.assessment.as_of_date || 'Not recorded')}</td><th>Captured</th><td>${escapeHtml(model.captured_at || 'Not recorded')}</td></tr><tr><th>Snapshot reason</th><td>${escapeHtml(model.snapshot_reason)}</td><th>Assessment row version</th><td>${model.assessment_row_version || 'Not recorded'}</td></tr><tr><th>Baseline assessment</th><td>${escapeHtml(first(model.assessment.baseline_assessment_id, 'None recorded'))}</td><th>Baseline snapshot</th><td>${escapeHtml(first(model.assessment.baseline_snapshot_id, 'None recorded'))}</td></tr></tbody></table>
<h3>Integrity and lineage</h3><table class="facts integrity"><tbody><tr><th>Snapshot SHA-256</th><td colspan="3"><code>${escapeHtml(model.snapshot_hash || 'Not supplied in frozen export input')}</code>${model.hash_verified ? '<small>Verified against the supplied immutable snapshot JSON.</small>' : '<small>Not recomputed because raw immutable snapshot JSON was not supplied to the exporter.</small>'}</td></tr><tr><th>Catalogue SHA-256</th><td colspan="3"><code>${escapeHtml(model.catalog_hash || 'Not recorded')}</code></td></tr><tr><th>Catalogue version</th><td>${escapeHtml(model.catalog_version || 'Not recorded')}</td><th>Applicability profile SHA-256</th><td><code>${escapeHtml(model.assessment.applicability_profile_hash || 'Not recorded')}</code></td></tr></tbody></table>
<h3>Scope and limitations</h3><p class="lead">${escapeHtml(model.assessment.scope_statement)}</p><ul>${limitationRows}</ul></section>
<section class="page"><div class="section-label">02 - Readiness position</div><h2>Implementation status without a compliance score</h2>${positionNarrative(model)}<p class="lead">Counts report the frozen implementation conclusions only. Currently effective duties and future-effective duties are separated so forward-readiness work does not inflate the present position.</p><div class="kpis"><div><strong>${overall.total}</strong><span>Total obligations</span></div><div><strong>${overall.Implemented}</strong><span>Implemented</span></div><div><strong>${overall['Partially Implemented']}</strong><span>Partially implemented</span></div><div><strong>${overall['Not Implemented']}</strong><span>Not implemented</span></div><div><strong>${overall['Not Assessed']}</strong><span>Not assessed</span></div></div>
<table><thead><tr><th>Legal timing</th><th>Total</th><th>Implemented</th><th>Partially implemented</th><th>Not implemented</th><th>Not applicable</th><th>Not assessed</th></tr></thead><tbody><tr><th>Currently effective</th>${countCells(current)}</tr><tr><th>Future effective</th>${countCells(future)}</tr><tr><th>Effective date not set</th>${countCells(unset)}</tr></tbody></table><div class="notice"><strong>Interpretation safeguard</strong><p>“Implemented” is an evidence-gated readiness conclusion within this assessment boundary. It is not a legal determination that every statutory duty has been satisfied.</p></div>
<h3>Position by obligation domain</h3><p class="lead">Ordered by open implementation gaps, so the table answers where the remaining work sits rather than listing the catalogue in order.</p>${domainTable(model.items)}</section>
<section class="page"><div class="section-label">03 - Remediation priorities</div><h2>Open gaps, worst first</h2>${prioritySection(model)}</section>
<section class="page"><div class="section-label">04 - Assessment boundary and applicability</div><h2>Frozen applicability profile</h2><p class="lead">Applicability rules provide review hints. They do not silently remove legal obligations, and every Not Applicable conclusion requires a retained human rationale.</p><table class="profile"><tbody>${profileRows(model.profile)}</tbody></table></section>
<section class="page"><div class="section-label">05 - Applicability exclusions</div><h2>Obligations concluded not applicable</h2>${exclusionSection(model)}</section>
<section class="page"><div class="section-label">06 - Obligation and evidence appendix</div><h2>Frozen obligation register</h2><p class="lead">The appendix reports only data retained in this snapshot. Evidence subsequently added, replaced, expired or superseded is intentionally excluded.</p>${itemAppendix(model.items)}</section>
<section class="page"><div class="section-label">07 - Review and integrity record</div><h2>Governed review history</h2><table><thead><tr><th>Action</th><th>Actor</th><th>Time</th><th>Note</th></tr></thead><tbody>${reviewRows}</tbody></table><div class="footer-note">This standalone report was rendered only from the supplied frozen snapshot. It contains no live-table lookups. This is a DPDPA implementation readiness assessment, not legal certification or legal advice.</div></section>
</body></html>`;
}

function csv(input) {
  const model = modelFor(input);
  const headers = [
    'Record type', 'Requirement ref', 'Requirement title', 'Domain', 'Source section', 'Source rule',
    'Effective date', 'Legal effective status', 'Applicability hint', 'Applicability reason',
    'Assessment status', 'Assessment note', 'Gap description', 'Recommendation', 'Owner', 'Due date',
    'Not applicable rationale', 'Evidence sufficient', 'Current evidence count', 'Stale evidence count',
    'Finding count', 'Finding references', 'Evidence id', 'Evidence reference', 'Evidence filename',
    'Evidence description', 'Evidence SHA-256', 'Evidence captured at', 'Evidence uploader', 'Evidence status',
    'Assessment as-of date', 'Assessment scope', 'Catalogue version', 'Catalogue SHA-256',
    'Snapshot sequence', 'Snapshot SHA-256', 'Snapshot status', 'Snapshot captured at', 'Payload version',
  ];
  const lines = [headers.map(escapeCsvCell).join(',')];
  const common = item => [
    item.ref, item.title, item.domain, item.source_section, item.source_rule, item.effective_date,
    item.legal_effective_status, item.applicability_hint, item.applicability_reason, item.status,
    item.assessment_note, item.gap_description, item.recommendation, item.owner, item.due_date,
    item.na_rationale, item.evidence_sufficient === null ? '' : item.evidence_sufficient ? 'Yes' : 'No',
    item.evidence_current_count, item.evidence_stale_count, item.finding_count,
    item.findings.map(row => [row.reference, row.title].filter(Boolean).join(' - ')).join(' | '),
  ];
  const lineage = [
    model.assessment.as_of_date, model.assessment.scope_statement, model.catalog_version, model.catalog_hash,
    model.sequence_number, model.snapshot_hash, model.status, model.captured_at, model.payload_version,
  ];
  for (const item of model.items) {
    lines.push(['OBLIGATION', ...common(item), '', '', '', '', '', '', '', '', ...lineage]
      .map(escapeCsvCell).join(','));
    for (const evidence of item.evidence) {
      lines.push(['EVIDENCE', ...common(item), evidence.id, evidence.reference, evidence.filename,
        evidence.description, evidence.sha256, evidence.uploaded_at, evidence.uploader,
        evidence.current ? 'Current' : 'Stale / not current', ...lineage]
        .map(escapeCsvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(text(value), 'utf8');
}

module.exports = {
  SnapshotExportError,
  normalizeSnapshot,
  reportMeta,
  reportHtml,
  csv,
  asBuffer,
  escapeHtml,
  escapeCsvCell,
};
