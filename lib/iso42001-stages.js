'use strict';

// The ISO 42001 engagement as stages, each a page in the module: the work
// that belongs to the stage with its live state, and the delivery-plan steps
// it covers. The masthead runway and the sidebar link to these pages, and
// every module page belongs to one stage (lib/iso42001-masthead.js PAGE_STAGE).
//
// A stage's work is its steps on the engagement's path, so a stage page, the
// path and the next step on every page never disagree. A
// gap-assessment-only engagement has two stages: the assessment and its
// report.
const { LIFECYCLE, GAP_ONLY_STEPS } = require('./iso42001-masthead');

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

const fmtDate = (value) => {
  const iso = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// The stages this client has, with the runway's plan state.
function list(mast) {
  const order = mast.gapOnly ? GAP_ONLY_STEPS : LIFECYCLE;
  return order.map(s => mast.stages.find(x => x.key === s.key)).filter(Boolean);
}

// One stage page: its steps on the engagement's path (lib/iso42001-journey.js)
// and its delivery-plan steps. Null when the stage is not one this client has.
function build(db, ws, mast, key, journey) {
  const stages = list(mast);
  const index = stages.findIndex(s => s.key === key);
  if (index < 0) return null;
  const stage = stages[index];
  const work = journey.forStage(key);
  const steps = (stage.milestones || []).map(m => ({
    title: m.title, ...stepState(m.effective_status),
    due: fmtDate(m.forecast_end_date || m.planned_end_date), required: !!m.is_required,
  }));
  return {
    key, name: stage.name, number: index + 1, count: stages.length,
    purpose: (mast.gapOnly && GAP_ONLY_PURPOSE[key]) || PURPOSE[key],
    done: stage.done, current: stage.current,
    prev: stages[index - 1] || null, next: stages[index + 1] || null,
    // A step this organisation does not need is shown but not counted.
    work, inPlace: work.filter(w => w.status === 'done').length, tracked: work.filter(w => w.status !== 'skip').length,
    steps, hasPlan: mast.hasPlan,
  };
}

module.exports = { build, list, PURPOSE };
