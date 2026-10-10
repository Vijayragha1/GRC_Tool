'use strict';

// The ISO 42001 engagement as stages, each a page in the module: the work
// that belongs to the stage with its live state, and the delivery-plan steps
// it covers. The masthead runway and the sidebar link to these pages, and
// every module page belongs to one stage (lib/iso42001-masthead.js PAGE_STAGE).
//
// States come from the readiness calculation the readiness page shows, run
// once per page, so a stage page and the readiness page never disagree. A
// gap-assessment-only engagement has two stages: the assessment and its
// report.
const { LIFECYCLE, GAP_ONLY_STEPS } = require('./iso42001-masthead');
const { getActiveMethodology } = require('../db');
const aimsTemplates = require('./iso42001-templates');
const aimsCycle = require('./iso42001-cycle');
const aiRoles = require('./ai-roles');

const PURPOSE = {
  mobilise: 'Agree what the AI management system covers, and record the organisation\'s context, interested parties and the risks and opportunities for the AIMS itself.',
  assess: 'Conclude every requirement of the standard, register the AI systems and their data, and assess the risks they pose against the AIMS\'s own criteria.',
  implement: 'Decide which Annex A controls apply, treat the AI risks, and put the documents, objectives and controls in place.',
  assure: 'Show the AIMS working over time: concerns handled, an internal audit reported, a management review held and nonconformities corrected.',
  readiness: 'Check every record a certification auditor asks for exists, and close what stands in the way before Stage 1.',
  certification: 'Answer the certification body\'s requests, and track Stage 1, Stage 2 and the cycle that follows.',
  report: 'Review the assessment independently, and publish the controlled report to the client.',
};
const GAP_ONLY_PURPOSE = {
  assess: 'Conclude every requirement of the standard against the client\'s AI systems, data, context and risks, with the evidence behind each conclusion.',
};

// Delivery-plan step status -> tone and words.
const STEP_STATE = {
  complete: ['done', 'Complete'], waived: ['na', 'Waived'], workspace_verified: ['part', 'Verified, awaiting acceptance'],
  in_progress: ['wip', 'In progress'], submitted: ['wip', 'Submitted'], waiting: ['open', 'Waiting on an earlier step'],
  blocked: ['gap', 'Blocked'], not_started: ['open', 'Not started'],
};
function stepState(status) {
  const [tone, text] = STEP_STATE[status] || ['open', 'Not started'];
  return { tone, text };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtDate = (value) => {
  const iso = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// A record from the readiness check, as a work state.
function fromRecord(check) {
  if (!check) return { tone: 'open', status: 'Not yet', detail: '' };
  // A record for a control that does not apply to this organisation.
  if (check.expected === false) return { tone: 'na', status: 'Not expected', detail: check.why };
  if (check.found) return { tone: 'done', status: 'In place', detail: check.basis };
  if (check.declaredOnly) return { tone: 'part', status: 'Declared, no record yet', detail: check.basis };
  return { tone: 'open', status: 'Not yet', detail: check.basis };
}

function workFor(key, ctx) {
  const { base, wsBase, r, mast } = ctx;
  const mandatory = (clause) => r.records.mandatory.checks.find(c => c.clause === clause);
  const expected = (ref) => [...r.records.expected.checks, ...(r.records.expected.notExpected || [])].find(c => c.clause === ref);
  const flag = (kind) => r.flags.find(f => f.kind === kind);

  const context = () => {
    if (flag('context_missing')) return { tone: 'open', status: 'Not yet', detail: 'Internal and external issues and interested parties' };
    if (flag('climate_undecided')) return { tone: 'part', status: 'Climate decision not recorded', detail: 'Issues and interested parties are recorded' };
    return { tone: 'done', status: 'In place', detail: 'Issues, interested parties and the climate decision are recorded' };
  };
  const gap = () => {
    const tone = mast.assessed === mast.total ? 'done' : mast.assessed ? 'wip' : 'open';
    return { tone, status: tone === 'done' ? 'Concluded' : tone === 'wip' ? 'In progress' : 'Not started',
      detail: `${mast.assessed} of ${mast.total} requirements concluded` };
  };
  const criteria = () => (ctx.method.built_in
    ? { tone: 'open', status: 'Default criteria', detail: 'Set the AIMS\'s own criteria before the first assessment' }
    : { tone: 'done', status: 'In place', detail: ctx.method.name });

  // Built only for the stage shown: each reads inputs only its stage loads.
  const items = {
    mobilise: () => [
      { title: 'Scope and intake', ref: '4.3', href: `${base}/intake`, ...fromRecord(mandatory('4.3')) },
      { title: 'AI roles', ref: '4.1', href: `${base}/roles`, ...ctx.roles },
      { title: 'Context and interested parties', ref: '4.1, 4.2', href: `${base}/context`, ...context() },
      { title: 'Risks and opportunities for the AIMS', ref: '6.1.1', href: `${base}/context#plan`, ...fromRecord(mandatory('6.1.1')) },
    ],
    assess: () => [
      { title: 'Gap assessment', ref: 'Clauses 4 to 10, Annex A', href: `${base}/gap-assessment`, ...gap() },
      { title: 'AI systems and impact assessments', ref: '6.1.4, 8.4', href: `${base}/ai-systems`, ...fromRecord(mandatory('8.4')) },
      { title: 'Datasets', ref: 'A.4.3, A.7', href: `${base}/datasets`, ...fromRecord(expected('A.4.3')) },
      { title: 'AI risk criteria', ref: '6.1.1', href: `${base}/risks/criteria`, ...criteria() },
      { title: 'AI risk register and assessment', ref: '6.1.2, 8.2', href: `${base}/risks`, ...fromRecord(mandatory('8.2')) },
    ],
    implement: () => [
      { title: 'Statement of Applicability', ref: '6.1.3', href: `${base}/soa`, ...fromRecord(mandatory('6.1.3')) },
      { title: 'AI risk treatment', ref: '6.1.3, 8.3', href: `${base}/risks`, ...fromRecord(mandatory('8.3')) },
      { title: 'Requirements and roadmap', ref: 'Annex A', href: `${base}/roadmap`, ...ctx.controls },
      { title: 'AIMS documents', ref: '7.5', href: `${wsBase}/templates?framework=iso42001`, shared: true, ...ctx.documents },
      { title: 'AI objectives', ref: '6.2', href: `${wsBase}/objectives`, shared: true, ...fromRecord(mandatory('6.2')) },
    ],
    assure: () => [
      { title: 'Concerns and reports', ref: 'A.3.3, A.8.3', href: `${base}/concerns`,
        ...(flag('concerns_late')
          ? { tone: 'gap', status: 'Responses late', detail: `${plural(flag('concerns_late').items.length, 'concern')} past the response date` }
          : { tone: 'done', status: 'Up to date', detail: 'No concern is past its response date' }) },
      { title: 'Internal audit', ref: '9.2', href: `${wsBase}/audits`, shared: true, ...fromRecord(mandatory('9.2')) },
      { title: 'Management review', ref: '9.3', href: `${wsBase}/mrms`, shared: true, ...fromRecord(mandatory('9.3')) },
      { title: 'Nonconformities and corrective action', ref: '10.2', href: `${wsBase}/nonconformities`, shared: true,
        ...(flag('open_ncs')
          ? { tone: 'wip', status: 'Open', detail: `${plural(flag('open_ncs').items.length, 'nonconformity', 'nonconformities')} on ISO 42001 not closed` }
          : fromRecord(mandatory('10.2'))) },
    ],
    readiness: () => [
      { title: 'Records an auditor asks for', ref: 'Readiness', href: `${base}/readiness`,
        tone: r.records.found === r.records.total ? 'done' : r.records.found ? 'wip' : 'open',
        status: r.records.found === r.records.total ? 'All found' : 'Some missing', detail: `${r.records.found} of ${r.records.total} records found` },
      { title: 'What stands in the way', ref: 'Blockers', href: `${base}/readiness/blockers`, ...ctx.blockers },
      { title: 'Executive brief', ref: 'Sponsor', href: `${base}/exec-brief`, tone: 'na', status: 'For the sponsor',
        detail: `Stage 1 ${r.stage1}% · Stage 2 ${r.stage2}%` },
    ],
    certification: () => [
      { title: 'Certification requests', ref: 'Stage 1, Stage 2', href: `${base}/requests`, ...ctx.requests },
      { title: 'Certification cycle', ref: 'Audits and findings', href: `${base}/cert-cycle`, ...ctx.cycle },
    ],
    report: () => [
      { title: 'Gap assessment report', ref: 'Independent review', href: `${base}/gap-assessment`, ...ctx.reportStep },
      { title: 'Publication to the client', ref: 'Engagement plan', href: `${wsBase}/engagement-plan`, shared: true, ...ctx.reportStep },
    ],
  };
  if (ctx.gapOnly && key === 'assess') {
    // Everything the assessment draws on, in the order it is worked.
    // The roles decide which controls weigh most, so they come early here too.
    const [gapItem, ...assessItems] = items.assess();
    const mobilise = items.mobilise().filter(w => ['AI roles', 'Context and interested parties'].includes(w.title));
    return [gapItem, ...mobilise, ...assessItems];
  }
  return items[key] ? items[key]() : [];
}

// Inputs that need a query of their own, for the stage being shown.
function extras(db, ws, key, r, mast) {
  const ctx = {};
  if (key === 'assess') ctx.method = getActiveMethodology(ws.id, 'iso42001');
  if (key === 'mobilise' || (key === 'assess' && mast.gapOnly)) {
    const p = aiRoles.profile(db, ws);
    const answered = p.counted.filter(s => s.roleState === 'answered').length;
    ctx.roles = !p.counted.length
      ? { tone: 'open', status: 'No AI system yet', detail: 'Register the AI systems in scope, then answer what the organisation does with each' }
      : answered === p.counted.length
        ? { tone: 'done', status: 'In place', detail: p.sentence }
        : { tone: p.byRole.length ? 'wip' : 'open', status: p.byRole.length ? 'In progress' : 'Not yet',
          detail: `${answered} of ${p.counted.length} AI systems answered${p.sentence ? ` · ${p.sentence}` : ''}` };
  }
  if (key === 'implement') {
    const m = r.metrics;
    const applicable = ['implemented', 'partial', 'wip', 'notImpl', 'unassessed'].reduce((sum, k) => sum + Number(m[k] || 0), 0);
    const overdue = r.flags.find(f => f.kind === 'controls_overdue');
    ctx.controls = overdue
      ? { tone: 'gap', status: 'Work overdue', detail: `${plural(overdue.items.length, 'requirement')} past the due date` }
      : { tone: applicable && m.implemented === applicable ? 'done' : (m.implemented + m.partial + m.wip) ? 'wip' : 'open',
        status: applicable && m.implemented === applicable ? 'Implemented' : (m.implemented + m.partial + m.wip) ? 'In progress' : 'Not started',
        detail: `${m.implemented} implemented, ${m.partial + m.wip} in progress, ${m.notImpl} not implemented` };
    const docs = aimsTemplates.documentationStatus(db, ws.id).mandatory;
    ctx.documents = { tone: docs.total && docs.approved === docs.total ? 'done' : docs.drafted ? 'wip' : 'open',
      status: docs.total && docs.approved === docs.total ? 'Approved' : docs.drafted ? 'In progress' : 'Not started',
      detail: `${docs.drafted} of ${docs.total} required documents drafted, ${docs.approved} approved` };
  }
  if (key === 'readiness') {
    const high = r.flags.filter(f => f.severity === 'high');
    ctx.blockers = high.length
      ? { tone: 'gap', status: plural(high.length, 'serious gap'), detail: high.slice(0, 2).map(f => f.label).join('; ') }
      : { tone: 'done', status: 'None serious', detail: plural(r.flags.length, 'smaller gap') + ' to review' };
  }
  if (key === 'certification') {
    const q = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status IN ('submitted','accepted') THEN 1 ELSE 0 END) sent
      FROM aims_audit_requests WHERE workspace_id=? AND withdrawn_at IS NULL AND kind != 'population'`).get(ws.id);
    ctx.requests = !q.total
      ? { tone: 'open', status: 'Not started', detail: 'Start the checklist when the auditor\'s requests are due' }
      : { tone: q.sent === q.total ? 'done' : 'wip', status: q.sent === q.total ? 'All submitted' : 'In progress',
        detail: `${q.sent || 0} of ${q.total} requests submitted to the auditor` };
    const open = aimsCycle.openFindings(db, ws);
    const dates = aimsCycle.stageDates(db, ws.id);
    ctx.cycle = open.total
      ? { tone: 'gap', status: plural(open.total, 'open finding'), detail: `${open.major || 0} major, ${open.minor || 0} minor` }
      : dates.stage1 || dates.stage2
        ? { tone: 'wip', status: 'Dates set', detail: [dates.stage1 && `Stage 1 ${fmtDate(dates.stage1)}`, dates.stage2 && `Stage 2 ${fmtDate(dates.stage2)}`].filter(Boolean).join(' · ') }
        : { tone: 'open', status: 'Not planned', detail: 'Stage 1 and Stage 2 dates are not set' };
  }
  if (key === 'report') {
    const step = (mast.stages.find(s => s.key === 'report')?.milestones || [])[0];
    const state = stepState(step && step.effective_status);
    ctx.reportStep = { tone: state.tone, status: state.text, detail: step ? step.title : 'No delivery plan yet' };
  }
  return ctx;
}

// The stages this client has, with the runway's plan state.
function list(mast) {
  const order = mast.gapOnly ? GAP_ONLY_STEPS : LIFECYCLE;
  return order.map(s => mast.stages.find(x => x.key === s.key)).filter(Boolean);
}

// One stage page. `readiness` is the module's readiness calculation; null
// when the stage is not one this client has.
function build(db, ws, mast, key, readiness) {
  const stages = list(mast);
  const index = stages.findIndex(s => s.key === key);
  if (index < 0) return null;
  const stage = stages[index];
  const r = readiness(ws.id);
  const base = `/workspaces/${ws.id}/iso42001`;
  const ctx = { base, wsBase: `/workspaces/${ws.id}`, r, mast, gapOnly: mast.gapOnly, ...extras(db, ws, key, r, mast) };
  const work = workFor(key, ctx);
  const steps = (stage.milestones || []).map(m => ({
    title: m.title, ...stepState(m.effective_status),
    due: fmtDate(m.forecast_end_date || m.planned_end_date), required: !!m.is_required,
  }));
  return {
    key, name: stage.name, number: index + 1, count: stages.length,
    purpose: (mast.gapOnly && GAP_ONLY_PURPOSE[key]) || PURPOSE[key],
    done: stage.done, current: stage.current,
    prev: stages[index - 1] || null, next: stages[index + 1] || null,
    // A view such as the executive brief (tone 'na') is not counted as work.
    work, inPlace: work.filter(w => w.tone === 'done').length, tracked: work.filter(w => w.tone !== 'na').length,
    steps, hasPlan: mast.hasPlan,
  };
}

module.exports = { build, list, PURPOSE };
