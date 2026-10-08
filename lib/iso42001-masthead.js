'use strict';

// The band every ISO 42001 page opens with: where the engagement stands on its
// delivery plan, and every requirement of the standard with its conclusion.
// Read-only. The header renders it on ISO 42001 pages only, so a page that is
// not part of the module never pays for these queries.
const delivery = require('./engagement-delivery');
const outcomeScope = require('./engagement-outcome-scope');
const ctlReads = require('./control-reads');

// Delivery-plan phases grouped into the steps a client recognises. The
// overview reads the same groups so the two never disagree.
// Each step is also a page in the module (lib/iso42001-stages.js), keyed by
// `key`.
const LIFECYCLE = [
  { key: 'mobilise', name: 'Mobilise', keys: ['mobilisation'] },
  { key: 'assess', name: 'Assess', keys: ['gap_assessment', 'context', 'assessment'] },
  { key: 'implement', name: 'Implement', keys: ['treatment', 'implementation'] },
  { key: 'assure', name: 'Assure', keys: ['operating_evidence', 'internal_assurance'] },
  { key: 'readiness', name: 'Readiness', keys: ['cert_readiness'] },
  { key: 'certification', name: 'Certification', keys: ['stage_1', 'stage_2'] },
];

// The stage each module page belongs to, by the page's `active` key. The
// overview and the engagement plan span every stage, so they have none. On a
// gap-assessment-only engagement every page is part of the assessment.
const PAGE_STAGE = {
  'iso42001-intake': 'mobilise', 'iso42001-context': 'mobilise',
  'iso42001-gap': 'assess', 'iso42001-ai-systems': 'assess', 'iso42001-datasets': 'assess', 'iso42001-risks': 'assess',
  'iso42001-soa': 'implement', 'iso42001-controls': 'implement', 'iso42001-catalog': 'implement', 'iso42001-roadmap': 'implement',
  'iso42001-concerns': 'assure',
  'iso42001-readiness': 'readiness', 'iso42001-exec-brief': 'readiness',
  'iso42001-requests': 'certification', 'iso42001-cert-cycle': 'certification',
};

function stageOf(active, gapOnly) {
  const page = String(active || '');
  if (page.startsWith('iso42001-stage-')) return page.slice('iso42001-stage-'.length);
  if (!PAGE_STAGE[page]) return null;
  return gapOnly ? 'assess' : PAGE_STAGE[page];
}

const CATEGORIES = [
  ['a-policies', 'A.2', 'Policies related to AI'],
  ['b-internal-organization', 'A.3', 'Internal organization'],
  ['c-resources', 'A.4', 'Resources for AI systems'],
  ['d-impact-assessment', 'A.5', 'Impact assessment'],
  ['e-lifecycle', 'A.6', 'AI system life cycle'],
  ['f-data', 'A.7', 'Data for AI systems'],
  ['g-information', 'A.8', 'Information for interested parties'],
  ['h-use', 'A.9', 'Use of AI systems'],
  ['i-third-party', 'A.10', 'Third-party and customer relationships'],
];
const CLAUSE_NAMES = { 4: 'Context', 5: 'Leadership', 6: 'Planning', 7: 'Support', 8: 'Operation', 9: 'Evaluation', 10: 'Improvement' };

// Conclusion -> tone. The tones are the map's only colours.
const TONES = {
  'Implemented': 'done', 'Partially Implemented': 'part', 'Work In Progress': 'wip',
  'Not Implemented': 'gap', 'Not Applicable': 'na',
};
const LEGEND = [
  ['done', 'Implemented'], ['part', 'Partially implemented'], ['wip', 'In progress'],
  ['gap', 'Not implemented'], ['na', 'Not applicable'], ['open', 'Not assessed'],
];

function code(id) {
  return String(id).replace('ai-annex-a-', '').replace('ai-clause-', '').replace(/-/g, '.');
}

// A gap-assessment-only engagement has one phase, the governed gap
// assessment, and ends with its report; its runway shows that phase's two
// steps rather than certification stages it never reaches.
const GAP_ONLY_STEPS = [
  { key: 'assess', name: 'Assess', milestone: 'gap-fieldwork-validation' },
  { key: 'report', name: 'Report', milestone: 'gap-controlled-report' },
];

function gapOnlyLifecycle(projection) {
  const milestones = projection?.milestones || [];
  let currentTaken = false;
  return GAP_ONLY_STEPS.map(step => {
    const m = milestones.find(x => x.milestone_key === step.milestone);
    const done = !!m && ['complete', 'waived'].includes(m.effective_status || m.status);
    const current = !!m && !done && !currentTaken;
    if (current) currentTaken = true;
    return { key: step.key, name: step.name, total: m ? 1 : 0, passed: done ? 1 : 0, done, current, milestones: m ? [m] : [] };
  });
}

function lifecycle(projection) {
  const phase = projection?.currentPhase;
  return LIFECYCLE.map(group => {
    const phases = (projection?.phases || []).filter(p => group.keys.includes(p.phase_key));
    const passed = phases.filter(p => ['complete', 'waived'].includes(p.effective_status)).length;
    const phaseIds = new Set(phases.map(p => p.id));
    return { key: group.key, name: group.name, total: phases.length, passed, done: phases.length > 0 && passed === phases.length,
      current: group.keys.includes(phase?.phase_key),
      milestones: (projection?.milestones || []).filter(m => phaseIds.has(m.phase_id)) };
  });
}

function requirements(db, workspaceId) {
  const cs = ctlReads.tables(db, workspaceId).cs42;
  return db.prepare(`SELECT i.id,i.type,i.category,i.title,s.status,s.applicability
    FROM iso42001_items i LEFT JOIN ${cs} s ON s.iso_item_id=i.id AND s.workspace_id=?
    WHERE i.type IN ('clause','control') ORDER BY i.sort_order,i.id`).all(workspaceId)
    .map(row => {
      const status = row.status && row.status !== 'Not Assessed' ? row.status : null;
      return { id: row.id, type: row.type, category: row.category, code: code(row.id),
        ref: row.type === 'control' ? `A.${code(row.id)}` : code(row.id),
        title: String(row.title || '').replace(/^A\.[0-9.]+ /, '').replace(/^[0-9.]+ /, ''),
        status: status || 'Not assessed', tone: TONES[status] || 'open' };
    });
}

function build(db, ws, userId) {
  const items = requirements(db, ws.id);
  const clauses = items.filter(i => i.type === 'clause');
  const controls = items.filter(i => i.type === 'control');
  const counts = Object.fromEntries(LEGEND.map(([tone]) => [tone, items.filter(i => i.tone === tone).length]));
  const assessed = items.length - counts.open;
  let projection = null;
  try { projection = delivery.getProjection(db, ws, userId, { ensure: false }); } catch (_) { projection = null; }
  const gapOnly = outcomeScope.isGapAssessmentOnly(ws);
  const stages = gapOnly ? gapOnlyLifecycle(projection) : lifecycle(projection);
  const next = items.find(i => i.tone === 'open') || null;
  return {
    base: `/workspaces/${ws.id}/iso42001`,
    clauses, controls, items, counts, assessed, total: items.length,
    pct: items.length ? Math.round(100 * assessed / items.length) : 0,
    next, gapOnly, stages, stageOf: (active) => stageOf(active, gapOnly),
    hasPlan: !!projection?.plan,
    phaseName: projection?.currentPhase?.name || null,
    clauseGroups: Object.keys(CLAUSE_NAMES).map(n => ({ number: n, name: CLAUSE_NAMES[n],
      items: clauses.filter(c => c.code.split('.')[0] === n) })),
    controlGroups: CATEGORIES.map(([key, ref, name]) => ({ key, ref, name, items: controls.filter(c => c.category === key) })),
    legend: LEGEND.map(([tone, label]) => ({ tone, label, count: counts[tone] })),
  };
}

module.exports = { build, lifecycle, gapOnlyLifecycle, stageOf, LIFECYCLE, GAP_ONLY_STEPS, PAGE_STAGE, CATEGORIES };
