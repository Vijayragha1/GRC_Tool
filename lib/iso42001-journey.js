'use strict';

// The ISO 42001 engagement as one ordered path of steps, so someone new to
// the standard always knows what to do next. Each step says what to do, why
// it matters and where it is done, and its state is read from the records
// themselves (the readiness check, the AI roles, the SoA), never ticked by
// hand. The stage pages show the steps of their stage, the overview shows
// the whole path, and every module page shows the next step
// (partials/a42_masthead.ejs).
//
// A step can wait on an earlier one (`after`); it can still be opened, but the
// next step is the first one not done whose earlier steps are done. A step
// that does not apply to this organisation, such as the data records of a
// client that only uses bought AI, is skipped with the reason. A step marked
// `ongoing` runs for the life of the AIMS and never becomes the next step.
const { getActiveMethodology } = require('../db');
const aimsTemplates = require('./iso42001-templates');
const aimsSoa = require('./iso42001-soa');
const aimsScope = require('./iso42001-scope');
const aiRoles = require('./ai-roles');
const aimsOps = require('./aims-operations');

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the steps read, loaded once.
function inputs(db, ws, mast, readiness) {
  const r = readiness(ws.id);
  const required = aimsScope.SECTIONS.flatMap(s => s.questions).filter(q => q.required).map(q => q.id);
  const answers = new Set(db.prepare(`SELECT question_key FROM iso42001_intake_answers WHERE workspace_id=? AND TRIM(COALESCE(answer,'')) != ''`)
    .all(ws.id).map(a => a.question_key));
  const requests = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status IN ('submitted','accepted') THEN 1 ELSE 0 END) sent
    FROM aims_audit_requests WHERE workspace_id=? AND withdrawn_at IS NULL AND kind != 'population'`).get(ws.id);
  // Support (clause 7). These registers are shared by the client's
  // management systems until they are separated by standard; for a client
  // with only ISO 42001 every row is the AIMS's.
  const one = (sql) => { try { return db.prepare(sql).get(ws.id) || {}; } catch (_) { return {}; } };
  const competence = one(`SELECT COUNT(*) roles, SUM(CASE WHEN EXISTS (SELECT 1 FROM competence_records cr WHERE cr.role_id=r.id) THEN 1 ELSE 0 END) covered
    FROM competence_roles r WHERE r.workspace_id=?`);
  const training = one(`SELECT SUM(CASE WHEN completed_date IS NOT NULL THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN completed_date IS NULL AND due_date < date('now') THEN 1 ELSE 0 END) overdue FROM training_records WHERE workspace_id=?`);
  const communication = one('SELECT COUNT(*) planned FROM communication_plan WHERE workspace_id=?');
  return {
    r, mast,
    operations: { late: aimsOps.lateNotices(db, ws), open: aimsOps.openIncidents(db, ws), unassessed: aimsOps.unassessedChanges(db, ws) },
    support: {
      roles: competence.roles || 0, covered: competence.covered || 0,
      completed: training.completed || 0, overdue: training.overdue || 0,
      planned: communication.planned || 0,
    },
    base: `/workspaces/${ws.id}/iso42001`, wsBase: `/workspaces/${ws.id}`,
    intake: { total: required.length, answered: required.filter(k => answers.has(k)).length },
    profile: aiRoles.profile(db, ws),
    method: getActiveMethodology(ws.id, 'iso42001'),
    soa: aimsSoa.issues(aimsSoa.payloadFor(db, ws)),
    docs: aimsTemplates.documentationStatus(db, ws.id).mandatory,
    requests: { total: requests.total || 0, sent: requests.sent || 0 },
  };
}

// A record from the readiness check as a step state.
const record = (check) => (check ? { done: check.found, detail: check.basis } : { done: false, detail: '' });

// Every step, in order. `stage` places it on a stage page; `pages` are the
// module pages (their `active` key) where it is worked.
function definitions(x) {
  const { r, mast, base, wsBase, profile } = x;
  const mandatory = (clause) => r.records.mandatory.checks.find(c => c.clause === clause);
  const expected = (ref) => [...r.records.expected.checks, ...(r.records.expected.notExpected || [])].find(c => c.clause === ref);
  const flag = (kind) => r.flags.find(f => f.kind === kind);
  const answered = profile.counted.filter(s => s.roleState === 'answered').length;
  const m = r.metrics;
  const applicable = ['implemented', 'partial', 'wip', 'notImpl', 'unassessed'].reduce((sum, k) => sum + Number(m[k] || 0), 0);
  const soaOpen = x.soa.undecided.length + x.soa.excludedUnjustified.length + x.soa.includedUnjustified.length;
  const high = r.flags.filter(f => f.severity === 'high');
  const certStage = mast.stages.find(s => s.key === 'certification');
  const milestone = (key) => (mast.stages.flatMap(s => s.milestones || []).find(mm => mm.milestone_key === key) || null);
  const milestoneDone = (key) => ['complete', 'waived'].includes(milestone(key)?.effective_status);
  const dataRecord = expected('A.4.3');

  return [
    // Mobilise
    { key: 'scope', stage: 'mobilise', pages: ['iso42001-intake'], href: `${base}/intake`, ref: '4.3',
      title: 'Answer the scoping questions',
      why: 'They set what the AI management system covers, and become the draft scope statement.',
      done: x.intake.answered === x.intake.total, detail: `${x.intake.answered} of ${x.intake.total} required answers given` },
    { key: 'systems', stage: 'mobilise', pages: ['iso42001-ai-systems'], href: `${base}/ai-systems`, ref: 'A.4.2',
      title: 'List the AI systems in scope',
      why: 'Every later step works on these systems, and the auditor asks for the list first.',
      done: profile.counted.length > 0, detail: profile.counted.length ? `${plural(profile.counted.length, 'AI system')} in scope` : 'No AI system in scope yet' },
    { key: 'roles', stage: 'mobilise', pages: ['iso42001-roles'], href: `${base}/roles`, ref: '4.1', after: 'systems',
      title: 'Say what the organisation does with each AI system',
      why: 'Building, buying or offering AI decides which controls apply, so this comes before the assessment.',
      done: profile.counted.length > 0 && answered === profile.counted.length,
      detail: profile.counted.length ? `${answered} of ${plural(profile.counted.length, 'AI system')} answered${profile.sentence ? ` · ${profile.sentence}` : ''}` : '' },
    { key: 'context', stage: 'mobilise', pages: ['iso42001-context'], href: `${base}/context`, ref: '4.1, 4.2',
      title: 'Record the context and interested parties',
      why: 'The issues the organisation faces, who has a stake in its AI, and whether climate change matters shape everything after.',
      done: !flag('context_missing') && !flag('climate_undecided'),
      detail: flag('context_missing') ? 'Issues and interested parties not recorded' : flag('climate_undecided') ? 'The climate decision is not recorded' : 'Recorded' },
    { key: 'aims-risks', stage: 'mobilise', pages: [], href: `${base}/context#plan`, ref: '6.1.1', after: 'context',
      title: 'Plan the risks and opportunities for the AIMS itself',
      why: 'What could stop the management system working, each with an action and a way to tell whether it worked.',
      ...record(mandatory('6.1.1')) },

    // Assess
    { key: 'gap', stage: 'assess', pages: ['iso42001-gap'], href: `${base}/gap-assessment`, ref: 'Clauses 4 to 10, Annex A',
      title: 'Assess every requirement of the standard',
      why: 'Each of the 27 clauses and 38 Annex A controls gets a conclusion backed by evidence. This is the gap assessment.',
      done: mast.total > 0 && mast.assessed === mast.total, detail: `${mast.assessed} of ${mast.total} requirements concluded` },
    { key: 'impact', stage: 'assess', pages: [], href: `${base}/ai-systems`, ref: '6.1.4, 8.4', after: 'systems',
      title: 'Assess the impact of each AI system',
      why: 'How each system could affect people and society, approved before the auditor sees it.',
      ...record(mandatory('8.4')) },
    { key: 'data', stage: 'assess', pages: ['iso42001-datasets'], href: `${base}/datasets`, ref: 'A.4.3, A.7', after: 'roles',
      title: 'Record the data behind each AI system',
      why: 'Where the data comes from, how good it is and how it is prepared.',
      ...(dataRecord && dataRecord.expected === false ? { skip: dataRecord.why } : record(dataRecord)) },
    { key: 'criteria', stage: 'assess', pages: [], href: `${base}/risks/criteria`, ref: '6.1.1',
      title: 'Set the AIMS\'s risk criteria',
      why: 'The scales AI risks are rated on, and how much risk the organisation accepts.',
      done: !x.method.built_in, detail: x.method.built_in ? 'The default criteria are still in use' : x.method.name },
    { key: 'risks', stage: 'assess', pages: ['iso42001-risks'], href: `${base}/risks`, ref: '6.1.2, 8.2', after: 'criteria',
      title: 'Assess the AI risks and record the assessment',
      why: 'What could go wrong with each system, rated on the criteria and kept as a dated record.',
      ...record(mandatory('8.2')) },

    // Implement
    { key: 'soa', stage: 'implement', pages: ['iso42001-soa'], href: `${base}/soa`, ref: '6.1.3', after: 'roles',
      title: 'Decide which Annex A controls apply',
      why: 'Each control is included or excluded with a reason. The AI roles propose most of the answers.',
      done: soaOpen === 0,
      detail: soaOpen ? [x.soa.undecided.length && `${x.soa.undecided.length} undecided`, (x.soa.excludedUnjustified.length + x.soa.includedUnjustified.length) && `${x.soa.excludedUnjustified.length + x.soa.includedUnjustified.length} without a reason`].filter(Boolean).join(', ') : 'Every control decided with a reason' },
    { key: 'treat', stage: 'implement', pages: [], href: `${base}/risks`, ref: '6.1.3, 8.3', after: 'risks',
      title: 'Treat the AI risks with controls',
      why: 'Each risk that needs treating gets controls and actions, and the result is recorded.',
      ...record(mandatory('8.3')) },
    { key: 'documents', stage: 'implement', pages: [], href: `${wsBase}/templates?framework=iso42001`, shared: true, ref: '5.2, 7.5',
      title: 'Write and approve the AIMS documents',
      why: 'The AI policy and the procedures the standard requires, approved by the right people.',
      done: x.docs.total > 0 && x.docs.approved === x.docs.total, detail: `${x.docs.drafted} of ${x.docs.total} drafted, ${x.docs.approved} approved` },
    { key: 'objectives', stage: 'implement', pages: [], href: `${wsBase}/objectives`, shared: true, ref: '6.2',
      title: 'Set AI objectives',
      why: 'Measurable goals for the AIMS, with a plan to reach them and a way to judge it.',
      ...record(mandatory('6.2')) },
    { key: 'competence', stage: 'implement', pages: [], href: `${wsBase}/competence`, shared: true, ref: '7.2',
      title: 'Show the people involved are competent',
      why: 'Everyone who works on the AIMS and its AI systems has the skills their role needs, with a record that shows it.',
      done: x.support.roles > 0 && x.support.covered === x.support.roles,
      detail: x.support.roles ? `${x.support.covered} of ${plural(x.support.roles, 'role')} with a record of competence` : 'No roles described yet' },
    { key: 'awareness', stage: 'implement', pages: [], href: `${wsBase}/training`, shared: true, ref: '7.3', after: 'documents',
      title: 'Make people aware of the AI policy and their part',
      why: 'Everyone involved knows the AI policy, what they contribute to the AIMS and what happens when it is not followed.',
      done: x.support.completed > 0 && x.support.overdue === 0,
      detail: x.support.completed || x.support.overdue ? `${x.support.completed} completed${x.support.overdue ? `, ${x.support.overdue} overdue` : ''}` : 'No awareness training recorded' },
    { key: 'communication', stage: 'implement', pages: [], href: `${wsBase}/communication-plan`, shared: true, ref: '7.4',
      title: 'Plan what is communicated about the AIMS',
      why: 'What is said about the AIMS, to whom, when and by whom, inside and outside the organisation.',
      done: x.support.planned > 0, detail: x.support.planned ? `${plural(x.support.planned, 'communication')} planned` : 'Nothing planned yet' },
    { key: 'controls', stage: 'implement', pages: ['iso42001-roadmap', 'iso42001-controls', 'iso42001-catalog'], href: `${base}/roadmap`, ref: 'Annex A', after: 'soa',
      title: 'Put the controls that apply in place',
      why: 'Each included control implemented and evidenced, with an owner and a date.',
      done: applicable > 0 && m.implemented === applicable, detail: `${m.implemented} of ${applicable} implemented` },
    { key: 'soa-approval', stage: 'implement', pages: [], href: `${base}/soa`, ref: '6.1.3', after: 'soa',
      title: 'Have the Statement of Applicability approved',
      why: 'A second person approves a sealed version. That version is the one the auditor reads.',
      ...record(mandatory('6.1.3')) },

    // Assure
    { key: 'concerns', stage: 'assure', pages: ['iso42001-concerns'], href: `${base}/concerns`, ref: 'A.3.3, A.8.3', ongoing: true,
      title: 'Answer concerns and reports as they come in',
      why: 'People inside and outside the organisation can raise concerns about its AI, and each gets an answer in time.',
      done: !flag('concerns_late'), detail: flag('concerns_late') ? `${plural(flag('concerns_late').items.length, 'concern')} past the response date` : 'None overdue' },
    { key: 'incidents', stage: 'assure', pages: [], href: `${wsBase}/incidents`, shared: true, ref: 'A.8.4, A.6.2.6', ongoing: true,
      title: 'Handle AI incidents and tell those affected',
      why: 'Incidents with the AI systems are recorded and handled, and the people who must hear about them are told in time.',
      done: x.operations.late.length === 0,
      detail: x.operations.late.length ? `${plural(x.operations.late.length, 'notice')} past the deadline` : x.operations.open ? `${x.operations.open} open, no notice overdue` : 'None open' },
    { key: 'changes', stage: 'assure', pages: [], href: `${wsBase}/changes`, shared: true, ref: '8.1, 8.2, 8.4', ongoing: true,
      title: 'Assess significant changes before they take effect',
      why: 'A significant change to an AI system means its impact and its risks are assessed again.',
      done: x.operations.unassessed.length === 0,
      detail: x.operations.unassessed.length ? `${plural(x.operations.unassessed.length, 'significant change')} awaiting a new assessment` : 'None awaiting a new assessment' },
    { key: 'audit', stage: 'assure', pages: [], href: `${wsBase}/audits`, shared: true, ref: '9.2',
      title: 'Run an internal audit of the AIMS',
      why: 'Someone independent checks that the AIMS works as planned and reports what they found.',
      ...record(mandatory('9.2')) },
    { key: 'review', stage: 'assure', pages: [], href: `${wsBase}/mrms`, shared: true, ref: '9.3', after: 'audit',
      title: 'Hold a management review',
      why: 'Top management looks at how the AIMS is doing, including the audit results, and decides what changes.',
      ...record(mandatory('9.3')) },
    { key: 'corrections', stage: 'assure', pages: [], href: `${wsBase}/nonconformities`, shared: true, ref: '10.2', after: 'audit',
      title: 'Correct what the audit found',
      why: 'Each nonconformity gets a cause, a correction and a check that the correction worked.',
      done: !!mandatory('9.2')?.found && !flag('open_ncs'),
      detail: flag('open_ncs') ? `${plural(flag('open_ncs').items.length, 'nonconformity', 'nonconformities')} still open` : 'None open' },

    // Readiness
    { key: 'records', stage: 'readiness', pages: ['iso42001-readiness'], href: `${base}/readiness`, ref: 'Readiness',
      title: 'Check every record the auditor will ask for',
      why: 'The documents and records the standard requires, and those expected for the controls that apply.',
      done: r.records.found === r.records.total, detail: `${r.records.found} of ${r.records.total} records found` },
    { key: 'blockers', stage: 'readiness', pages: [], href: `${base}/readiness/blockers`, ref: 'Blockers', after: 'records',
      title: 'Clear what stands in the way of certification',
      why: 'The serious gaps an auditor would raise, closed before Stage 1.',
      done: high.length === 0, detail: high.length ? plural(high.length, 'serious gap') : 'No serious gap' },

    // Certification
    { key: 'requests', stage: 'certification', pages: ['iso42001-requests'], href: `${base}/requests`, ref: 'Stage 1, Stage 2',
      title: 'Answer the certification body\'s requests',
      why: 'The evidence the auditor asks for before and during the audits.',
      done: x.requests.total > 0 && x.requests.sent === x.requests.total,
      detail: x.requests.total ? `${x.requests.sent} of ${x.requests.total} submitted` : 'The checklist is not started' },
    { key: 'certify', stage: 'certification', pages: ['iso42001-cert-cycle'], href: `${base}/cert-cycle`, ref: 'Stage 1, Stage 2', after: 'requests',
      title: 'Pass the Stage 1 and Stage 2 audits',
      why: 'Book the audits, take part and close any findings. Surveillance audits follow each year.',
      done: !!certStage?.done, detail: certStage?.done ? 'Certified' : 'Not yet certified' },

    // A gap assessment only: its review and report.
    { key: 'review-gap', stage: 'report', gapOnly: true, pages: [], href: `${base}/gap-assessment`, ref: 'Independent review', after: 'gap',
      title: 'Have the assessment independently reviewed',
      why: 'A reviewer who did not do the fieldwork checks the conclusions before the report is written.',
      done: milestoneDone('gap-fieldwork-validation'), detail: milestone('gap-fieldwork-validation')?.title || 'No delivery plan yet' },
    { key: 'report', stage: 'report', gapOnly: true, pages: [], href: `${wsBase}/engagement-plan`, shared: true, ref: 'Report', after: 'review-gap',
      title: 'Publish the gap assessment report',
      why: 'The controlled report, approved and published to the client.',
      done: milestoneDone('gap-controlled-report'), detail: milestone('gap-controlled-report')?.title || 'No delivery plan yet' },
  ];
}

// The steps a gap-assessment-only engagement has, in order.
const GAP_ONLY = ['scope', 'systems', 'roles', 'context', 'gap', 'review-gap', 'report'];
const GAP_ONLY_STAGE = { scope: 'assess', systems: 'assess', roles: 'assess', context: 'assess', gap: 'assess' };

function build(db, ws, mast, readiness) {
  const x = inputs(db, ws, mast, readiness);
  let steps = definitions(x);
  if (mast.gapOnly) {
    steps = GAP_ONLY.map(key => steps.find(s => s.key === key)).map(s => ({ ...s, stage: GAP_ONLY_STAGE[s.key] || s.stage }));
  } else {
    steps = steps.filter(s => !s.gapOnly);
  }
  const byKey = new Map(steps.map(s => [s.key, s]));
  let n = 0;
  steps = steps.map(s => {
    if (s.skip) return { ...s, status: 'skip', number: null };
    n += 1;
    const waiting = s.after && byKey.get(s.after) && !byKey.get(s.after).done && !byKey.get(s.after).skip;
    return { ...s, number: n, status: s.done ? 'done' : waiting ? 'waiting' : 'todo', afterTitle: waiting ? byKey.get(s.after).title : null };
  });
  const numbered = new Map(steps.map(s => [s.key, s.number]));
  steps.forEach(s => { if (s.afterTitle) s.afterNumber = numbered.get(s.after); });
  const counted = steps.filter(s => s.status !== 'skip');
  // The next step: the first one not done whose earlier steps are done.
  const next = counted.find(s => s.status === 'todo' && !s.ongoing) || counted.find(s => s.status !== 'done' && !s.ongoing) || null;
  if (next) next.status = 'next';
  return {
    steps, next,
    total: counted.length, done: counted.filter(s => s.status === 'done').length,
    // The step a module page belongs to: the first not done among the steps
    // worked there, else the last of them.
    forPage(active) {
      const here = counted.filter(s => s.pages.includes(active));
      return here.find(s => s.status !== 'done') || here[here.length - 1] || null;
    },
    forStage(key) { return steps.filter(s => s.stage === key); },
  };
}

module.exports = { build, definitions, GAP_ONLY };
