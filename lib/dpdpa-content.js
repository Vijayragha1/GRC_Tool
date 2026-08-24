'use strict';

// Presentation content for the DPDPA gap-assessment surfaces.
//
// The governed catalog in data/dpdpa-catalog.js already carries the statutory
// condition, implementation guidance, expected evidence, severity and source
// provisions for every obligation. None of it reached the interface, so the
// workbench asked an assessor to reach a legal conclusion with a single line
// of context. This module is the read-only bridge: it indexes that corpus by
// reference, resolves each obligation's provisions to the Gazette documents
// they came from, and derives the two judgments the module presents as its
// own - commencement runway and gap priority.
//
// No database, no request state. Everything here is a pure function of the
// frozen catalog plus a date, so the same inputs always render the same page.

const catalog = require('../data/dpdpa-catalog');

const DAY_MS = 24 * 60 * 60 * 1000;

// Plain-language commencement narrative. G.S.R. 843(E) expresses phases 2 and
// 3 as relative periods; the catalog computes the calendar anniversaries and
// records that basis, which is repeated here so the interface never presents a
// computed date as if the Gazette had printed it.
const PHASE_NARRATIVE = Object.freeze({
  phase_1_institutional: {
    shortLabel: 'Institutional',
    summary: 'The Act, its definitions, the Data Protection Board and the rule-making powers. Nothing in this catalogue is assessable at this phase.',
  },
  phase_2_consent_manager: {
    shortLabel: 'Consent Managers',
    summary: 'Registration and operating conditions for statutory Consent Managers. Relevant only to organisations that intermediate consent for other Data Fiduciaries.',
  },
  phase_3_substantive: {
    shortLabel: 'Substantive duties',
    summary: 'Notice and consent, security safeguards, breach notification, retention, children, rights and transfers commence together. This is the date an implementation programme has to be sized against.',
  },
});

const SEVERITY_LABEL = Object.freeze({
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
});

const GAP_STATUSES = Object.freeze(['Not Implemented', 'Partially Implemented']);

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

function longDate(iso) {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return iso || 'Not set';
  return new Date(parsed).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

// Short names for inline citation. The full Gazette titles are correct but
// unusable beside a provision reference; the overview's source panel carries
// the long form and the identifier.
const SOURCE_SHORT = Object.freeze({
  'dpdp-act-2023': 'DPDP Act, 2023',
  'dpdp-commencement-2025': 'Commencement notification',
  'dpdp-rules-2025': 'DPDP Rules, 2025',
  'dpdp-rules-corrigendum-2025': 'Rules corrigenda',
});

const SOURCE_BY_ID = new Map(catalog.sources.map(source => [source.id, source]));
const DOMAIN_BY_KEY = new Map(catalog.domains.map(domain => [domain.key, domain]));
const PHASE_BY_ID = new Map(catalog.phases.map(phase => [phase.id, phase]));

// A citation the reader can actually follow: the provisions this obligation
// rests on, alongside the Gazette document that published them.
function citations(obligation) {
  return (obligation.sourceRefs || []).map(ref => {
    const source = SOURCE_BY_ID.get(ref.sourceId) || {};
    const provisions = ref.provisions || [];
    return {
      sourceId: ref.sourceId,
      title: source.title || ref.sourceId,
      shortTitle: SOURCE_SHORT[ref.sourceId] || source.title || ref.sourceId,
      identifier: source.identifier || null,
      url: source.url || null,
      provisions,
      // The provision alone is what a practitioner cites; the short source
      // name sits beside it so the reference is still unambiguous.
      provisionLabel: provisions.join(', '),
      label: `${source.title || ref.sourceId}${provisions.length ? ` ${provisions.join(', ')}` : ''}`,
    };
  });
}

const CONTENT_BY_REF = new Map(catalog.obligations.map(obligation => {
  const domain = DOMAIN_BY_KEY.get(obligation.domain) || {};
  const phase = PHASE_BY_ID.get(obligation.legalStatus.commencementPhase) || {};
  const narrative = PHASE_NARRATIVE[obligation.legalStatus.commencementPhase] || {};
  return [obligation.ref, Object.freeze({
    ref: obligation.ref,
    title: obligation.title,
    domainKey: obligation.domain,
    domain: domain.label || obligation.domain,
    domainOrder: domain.order || 99,
    sortOrder: obligation.sortOrder,
    requirement: obligation.requirement,
    condition: obligation.applicability.condition,
    flags: obligation.applicability.flags || [],
    exclusions: obligation.applicability.exclusions || [],
    guidance: obligation.implementationGuidance || [],
    evidence: obligation.evidenceExpectations || [],
    severity: obligation.severity,
    severityLabel: SEVERITY_LABEL[obligation.severity] || obligation.severity,
    weight: obligation.weight,
    sourceSectionRule: obligation.sourceSectionRule,
    citations: citations(obligation),
    phaseId: obligation.legalStatus.commencementPhase,
    phaseLabel: phase.label || null,
    phaseShortLabel: narrative.shortLabel || phase.label || null,
    effectiveDate: obligation.legalStatus.effectiveDate,
    effectiveDateLong: longDate(obligation.legalStatus.effectiveDate),
    commencementBasis: obligation.legalStatus.commencementBasis,
  })];
}));

function contentFor(ref) {
  return CONTENT_BY_REF.get(ref) || null;
}

// Merge the catalog corpus onto a stored assessment item. Stored rows own the
// conclusion; the catalog owns the law. Where a snapshot was frozen against an
// older catalog version a reference may no longer resolve, so every consumer
// has to tolerate a null `content`.
function decorate(items) {
  return (Array.isArray(items) ? items : []).map(item => ({
    ...item,
    content: contentFor(item.ref || item.requirement_ref),
  }));
}

// Which commencement dates still lie ahead, and how much runway is left. This
// is the framing the module leads with: for any assessment dated before
// 13 May 2027 almost every obligation is future-effective, so a "currently
// effective readiness" percentage is structurally near zero and says nothing.
function commencementRunway(fromDate = isoToday()) {
  const counts = new Map();
  for (const content of CONTENT_BY_REF.values()) {
    counts.set(content.phaseId, (counts.get(content.phaseId) || 0) + 1);
  }
  return catalog.phases.map(phase => {
    const narrative = PHASE_NARRATIVE[phase.id] || {};
    const days = daysBetween(fromDate, phase.effectiveDate);
    return {
      id: phase.id,
      label: phase.label,
      shortLabel: narrative.shortLabel || phase.label,
      summary: narrative.summary || '',
      provisions: phase.provisions,
      effectiveDate: phase.effectiveDate,
      effectiveDateLong: longDate(phase.effectiveDate),
      dateBasis: phase.dateBasis,
      computedDate: phase.dateBasis !== 'Date of Gazette publication',
      obligationCount: counts.get(phase.id) || 0,
      daysRemaining: days,
      inForce: days !== null && days <= 0,
    };
  });
}

// Priority is a stated rule, not a black box, so a client can challenge it:
// statutory severity, scaled by how far implementation falls short, scaled
// again by how close the duty is to being enforceable.
const PRIORITY_RULE = 'Priority ranks each open gap by statutory severity, the size of the implementation shortfall, and how close the obligation is to commencement.';

function shortfallFactor(status) {
  if (status === 'Not Implemented') return 1;
  if (status === 'Partially Implemented') return 0.6;
  return 0;
}

// No clock read here on purpose. The frozen exporter ranks the same gaps as
// the screen, and it has to produce identical bytes for identical input.
function proximityFactor(content, asOfDate) {
  if (!content || !content.effectiveDate || !asOfDate) return 0.85;
  const days = daysBetween(asOfDate, content.effectiveDate);
  if (days === null) return 0.85;
  if (days <= 0) return 1.25;
  if (days <= 365) return 1;
  return 0.85;
}

function priorityOf(item, asOfDate) {
  const content = item.content || contentFor(item.ref || item.requirement_ref);
  const shortfall = shortfallFactor(item.status);
  if (!shortfall) return { score: 0, band: null, rank: 4 };
  const weight = Number(content && content.weight) || 3;
  const score = weight * shortfall * proximityFactor(content, asOfDate);
  if (score >= 5) return { score, band: 'Immediate', rank: 0 };
  if (score >= 3.5) return { score, band: 'High', rank: 1 };
  if (score >= 2) return { score, band: 'Planned', rank: 2 };
  return { score, band: 'Monitor', rank: 3 };
}

// Open gaps, worst first. Ties break on catalog order so the list is stable
// between renders and between the screen and the exported report.
function rankedGaps(items, { asOfDate = null, limit = null } = {}) {
  const ranked = decorate(items)
    .filter(item => GAP_STATUSES.includes(item.status))
    .map(item => ({ ...item, priority: priorityOf(item, asOfDate) }))
    .sort((a, b) => b.priority.score - a.priority.score
      || (a.content?.sortOrder || 0) - (b.content?.sortOrder || 0)
      || String(a.ref).localeCompare(String(b.ref)));
  return limit ? ranked.slice(0, limit) : ranked;
}

// One row per obligation domain, ordered by open gaps rather than alphabet, so
// the table answers "where is the work" instead of listing thirteen headings.
function domainMatrix(items) {
  const rows = new Map();
  for (const item of decorate(items)) {
    const key = item.content?.domain || item.domain || 'Other obligations';
    if (!rows.has(key)) {
      rows.set(key, {
        domain: key,
        order: item.content?.domainOrder || 99,
        total: 0,
        implemented: 0,
        partial: 0,
        notImplemented: 0,
        notApplicable: 0,
        notAssessed: 0,
        criticalGaps: 0,
      });
    }
    const row = rows.get(key);
    row.total++;
    if (item.status === 'Implemented') row.implemented++;
    else if (item.status === 'Partially Implemented') row.partial++;
    else if (item.status === 'Not Implemented') row.notImplemented++;
    else if (item.status === 'Not Applicable') row.notApplicable++;
    else row.notAssessed++;
    if (GAP_STATUSES.includes(item.status) && item.content?.severity === 'critical') row.criticalGaps++;
  }
  return [...rows.values()].map(row => {
    const inScope = row.total - row.notApplicable;
    const concluded = row.total - row.notAssessed;
    return {
      ...row,
      inScope,
      concluded,
      openGaps: row.notImplemented + row.partial,
      // Readiness credits full implementation and half-credits partial work,
      // measured against in-scope obligations only.
      readinessPct: inScope ? Math.round((row.implemented + row.partial * 0.5) * 100 / inScope) : 100,
      completionPct: row.total ? Math.round(concluded * 100 / row.total) : 0,
    };
  }).sort((a, b) => b.notImplemented - a.notImplemented
    || b.openGaps - a.openGaps
    || a.order - b.order);
}

// A single readiness number for the whole assessment, on the same rule as the
// domain rows so the page never shows two percentages that disagree.
function readinessOf(items) {
  const list = Array.isArray(items) ? items : [];
  const counts = {
    total: list.length,
    implemented: 0,
    partial: 0,
    notImplemented: 0,
    notApplicable: 0,
    notAssessed: 0,
  };
  for (const item of list) {
    if (item.status === 'Implemented') counts.implemented++;
    else if (item.status === 'Partially Implemented') counts.partial++;
    else if (item.status === 'Not Implemented') counts.notImplemented++;
    else if (item.status === 'Not Applicable') counts.notApplicable++;
    else counts.notAssessed++;
  }
  const inScope = counts.total - counts.notApplicable;
  return {
    ...counts,
    inScope,
    concluded: counts.total - counts.notAssessed,
    openGaps: counts.notImplemented + counts.partial,
    readinessPct: inScope ? Math.round((counts.implemented + counts.partial * 0.5) * 100 / inScope) : 100,
    completionPct: counts.total ? Math.round((counts.total - counts.notAssessed) * 100 / counts.total) : 0,
  };
}

// Submission gates the domain raised, grouped so the workbench can show eight
// blocked obligations as one actionable line per cause instead of eight
// identical sentences with nothing to click.
const BLOCKER_GROUPS = Object.freeze({
  not_assessed: { label: 'No implementation conclusion recorded', fix: 'Open each obligation and record the result the assessment record supports.' },
  assessment_note: { label: 'Conclusion note missing or too short', fix: 'State what was examined, what was demonstrated and the basis for the result.' },
  gap_description: { label: 'Gap statement missing or too short', fix: 'Describe the specific missing or ineffective implementation and the scope it affects.' },
  recommendation: { label: 'Recommendation missing or too short', fix: 'Record the action, the expected evidence and the accountable outcome.' },
  na_rationale: { label: 'Not Applicable rationale below 80 characters', fix: 'Give the factual scope basis, dependencies and approving authority.' },
  evidence: { label: 'Implementation claim without current evidence', fix: 'Link retained evidence that is valid at the assessment as-of date.' },
  na_acceptance: { label: 'Not Applicable rationale awaiting approver acceptance', fix: 'The independent approver accepts each rationale on the review screen.' },
});

function groupBlockers(blockers) {
  const groups = new Map();
  for (const blocker of Array.isArray(blockers) ? blockers : []) {
    const kind = blocker && blocker.kind ? blocker.kind : 'other';
    if (!groups.has(kind)) {
      const meta = BLOCKER_GROUPS[kind] || { label: 'Other submission gate', fix: 'Resolve the condition described on the obligation record.' };
      groups.set(kind, { kind, ...meta, items: [] });
    }
    groups.get(kind).items.push({
      id: blocker.item_id || null,
      ref: blocker.ref || null,
      title: blocker.title || null,
      message: blocker.message || null,
    });
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

module.exports = {
  PRIORITY_RULE,
  SEVERITY_LABEL,
  GAP_STATUSES,
  sources: catalog.sources,
  domains: catalog.domains,
  metadata: catalog.metadata,
  contentFor,
  decorate,
  commencementRunway,
  priorityOf,
  rankedGaps,
  domainMatrix,
  readinessOf,
  groupBlockers,
  longDate,
  daysBetween,
  isoToday,
};
