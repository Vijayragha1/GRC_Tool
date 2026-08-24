'use strict';
// What a client still needs scoped, per programme.
//
// Creating a client can enable four programmes and two modules at once, but
// every scoping surface is per-programme and the create flow could only send
// the consultant to one of them. Everything else was left unscoped with nothing
// on screen to say so, and the workspace open-redirect then used an
// ISO 27001-only table as if it were a universal "setup started" signal.
//
// The damage is visible in production data: three clients that are not being
// assessed against ISO 27001 carry full 27-answer ISO 27001 intakes with
// confirmed scope, because POST /workspaces sent them there.
//
// Every status here is computed live from the programme's own signal. Nothing
// is cached and nothing is inferred from another programme, because a hub that
// shows green on a client that was never scoped is worse than no hub.

const { FRAMEWORK_REGISTRY } = require('./frameworks');

const NOT_STARTED = 'not_started';
const IN_PROGRESS = 'in_progress';
const COMPLETE = 'complete';

// The ISO 27001 intake auto-seeds a cert-deadline answer at client creation
// (routes/workspaces.js), so a completely untouched client already has one row.
// Counting it made the old redirect miss exactly the clients that needed it and
// simultaneously light the "partial setup" banner. Every count here excludes it.
const SEEDED_QUESTION = 'cert-deadline';

// draftScopeStatement() emits prose containing "[org-name - not answered]" when
// the answers are empty, and that placeholder is long enough to pass every
// length check in the codebase. Scope text alone never proves scoping happened.
const PLACEHOLDER_SCOPE = '%- not answered]%';

const ISO27001_REQUIRED = [
  'org-name', 'business-summary', 'cert-driver', 'products-in-scope', 'infra-model',
  'data-types', 'headcount-total', 'isms-owner', 'isms-coordinator', 'key-customers',
  'key-suppliers', 'crown-jewel-1',
];

function one(db, sql, ...params) {
  try { return db.prepare(sql).get(...params) || null; } catch (_) { return null; }
}

function count(db, sql, ...params) {
  const row = one(db, sql, ...params);
  return row ? Number(Object.values(row)[0] || 0) : 0;
}

// ---- per-programme signals -------------------------------------------------

function iso27001Step(db, ws) {
  const answered = count(db, `SELECT COUNT(*) c FROM engagement_intake
    WHERE workspace_id=? AND question_id<>? AND answer IS NOT NULL AND length(trim(answer))>0`,
    ws.id, SEEDED_QUESTION);
  const required = count(db, `SELECT COUNT(*) c FROM engagement_intake
    WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer))>0
      AND question_id IN (${ISO27001_REQUIRED.map(() => '?').join(',')})`,
    ws.id, ...ISO27001_REQUIRED);
  const confirmed = one(db, `SELECT scope_confirmed_at FROM workspaces
    WHERE id=? AND scope_confirmed_at IS NOT NULL
      AND scope IS NOT NULL AND length(trim(scope))>10 AND scope NOT LIKE ?`,
    ws.id, PLACEHOLDER_SCOPE);

  if (confirmed) {
    return { status: COMPLETE, detail: `Scope signed off ${String(confirmed.scope_confirmed_at).slice(0, 10)}.` };
  }
  if (required >= ISO27001_REQUIRED.length) {
    return {
      status: IN_PROGRESS,
      detail: 'Every required answer is captured. Confirm the scope statement to sign it off.',
      note: 'Confirming needs the workspace.update permission.',
    };
  }
  if (answered > 0) {
    return { status: IN_PROGRESS, detail: `${required} of ${ISO27001_REQUIRED.length} required answers captured.` };
  }
  return { status: NOT_STARTED, detail: `${ISO27001_REQUIRED.length} required answers, then scope sign-off.` };
}

function iso42001Step(db, ws) {
  const answered = count(db, `SELECT COUNT(*) c FROM iso42001_intake_answers
    WHERE workspace_id=? AND trim(coalesce(answer,''))<>''`, ws.id);
  // ISO 42001 has no scope-confirmation timestamp of its own, so "applied" is
  // proven by the clause 4.3 scope note the apply route writes. Calling this
  // step "confirmed" would be untrue, so it is labelled as capture.
  const applied = count(db, `SELECT COUNT(*) c FROM control_instances ci
    JOIN requirements rq ON rq.id=ci.requirement_id
    JOIN frameworks f ON f.id=rq.framework_id
    WHERE f.code='iso42001' AND rq.ref='ai-clause-4.3' AND ci.workspace_id=?
      AND ci.entity_id IS NULL AND ci.notes LIKE 'AIMS Scope (Clause 4.3)%'`, ws.id);

  if (answered >= 8 && applied > 0) {
    return { status: COMPLETE, detail: 'Management intake captured and applied to the AIMS scope.' };
  }
  if (answered >= 8) {
    return { status: IN_PROGRESS, detail: 'Intake captured. Apply it to write the clause 4.3 AIMS scope.' };
  }
  if (answered > 0) {
    return { status: IN_PROGRESS, detail: `${answered} of 16 intake answers captured.` };
  }
  return { status: NOT_STARTED, detail: 'Capture the AI management-system context and scope.' };
}

function csfStep(db, ws) {
  const profile = one(db, `SELECT p.status FROM csf_engagements e
    JOIN csf_profile_contexts p ON p.engagement_id=e.id
    WHERE e.workspace_id=? AND e.deleted_at IS NULL
    ORDER BY CASE p.status WHEN 'approved' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END, e.id DESC
    LIMIT 1`, ws.id);

  if (!profile) return { status: NOT_STARTED, detail: 'Create the assessment cycle and define the Organizational Profile.' };
  if (profile.status === 'approved') return { status: COMPLETE, detail: 'Organizational Profile approved and frozen.' };
  if (profile.status === 'submitted') {
    // Approval deliberately needs a second person, so a submitted profile is
    // finished work waiting on someone else, not an unfinished step.
    return { status: COMPLETE, detail: 'Profile submitted.', note: 'Awaiting independent approval by a second reviewer.' };
  }
  return { status: IN_PROGRESS, detail: 'Organizational Profile is still a draft.' };
}

function dpdpaStep(db, ws) {
  const assessment = one(db, `SELECT id, status, as_of_date FROM dpdpa_gap_assessments
    WHERE workspace_id=? AND status<>'Superseded'
    ORDER BY updated_at DESC, id DESC LIMIT 1`, ws.id);
  if (!assessment) {
    return { status: NOT_STARTED, detail: 'Fix the boundary, as-of date and applicability profile.' };
  }
  return {
    status: COMPLETE,
    detail: `Boundary frozen as of ${assessment.as_of_date}.`,
    href: `/workspaces/${ws.id}/dpdpa/assessments/${assessment.id}`,
  };
}

function tprmStep(db, ws) {
  const module = one(db, `SELECT service_model, status FROM tprm_modules
    WHERE workspace_id=? ORDER BY id DESC LIMIT 1`, ws.id);
  if (!module) return null;
  if (module.status === 'active' && module.service_model) {
    return { status: COMPLETE, detail: `Contracted as ${String(module.service_model).replace(/_/g, ' ')}.` };
  }
  return {
    status: module.status === 'needs_classification' ? IN_PROGRESS : NOT_STARTED,
    detail: 'Retained provider records need classifying against a contracted service model.',
  };
}

function vcisoStep(db, ws) {
  // Read the service table rather than ws.vciso_enabled: that flag is derived
  // in getWorkspace/listWorkspaces, so it is absent on a raw workspace row and
  // the step would silently disappear depending on the caller.
  const service = one(db, `SELECT engagement_id, status FROM vciso_services
    WHERE workspace_id=? AND status IN ('active','on_hold') ORDER BY id DESC LIMIT 1`, ws.id);
  if (!service) return null;
  // Enabling vCISO creates the retainer engagement outright; there is no
  // separate scoping act, so this step is informational rather than a task.
  return {
    status: COMPLETE,
    detail: 'Advisory retainer active.',
    href: `/workspaces/${ws.id}/delivery?engagement=${service.engagement_id}`,
    note: 'Scope and governance are edited on the engagement itself.',
  };
}

// ---- assembly --------------------------------------------------------------

const PROGRAMME_STEPS = {
  iso27001: { label: 'Engagement intake and scope sign-off', href: ws => `/workspaces/${ws.id}/intake`, build: iso27001Step },
  iso42001: { label: 'AI management-system intake', href: ws => `/workspaces/${ws.id}/iso42001/intake`, build: iso42001Step },
  csf: { label: 'Organizational Profile', href: ws => `/workspaces/${ws.id}/csf`, build: csfStep },
  dpdpa: { label: 'Assessment boundary and applicability', href: ws => `/workspaces/${ws.id}/dpdpa`, build: dpdpaStep },
};

/**
 * Every setup step this client actually needs, with a live status for each.
 * Programmes come from workspaces.frameworks; modules from their own flags.
 */
function clientSetup(db, ws) {
  const codes = Array.isArray(ws.frameworks) ? ws.frameworks : [];
  const steps = [];

  for (const code of codes) {
    const spec = PROGRAMME_STEPS[code];
    const meta = FRAMEWORK_REGISTRY[code];
    if (!spec || !meta) continue;
    const built = spec.build(db, ws) || {};
    steps.push({
      key: code,
      kind: 'programme',
      programme: meta.shortLabel,
      label: spec.label,
      href: built.href || spec.href(ws),
      status: built.status || NOT_STARTED,
      detail: built.detail || '',
      note: built.note || null,
      order: meta.order,
    });
  }

  const tprm = tprmStep(db, ws);
  if (tprm) {
    steps.push({
      key: 'tprm',
      kind: 'module',
      programme: 'Third-party risk',
      label: 'Confirm the contracted service model',
      href: `/workspaces/${ws.id}/tprm`,
      status: tprm.status,
      detail: tprm.detail,
      note: tprm.note || null,
      order: 90,
    });
  }

  const vciso = vcisoStep(db, ws);
  if (vciso) {
    steps.push({
      key: 'vciso',
      kind: 'module',
      programme: 'vCISO advisory',
      label: 'Advisory retainer',
      href: vciso.href || `/workspaces/${ws.id}/delivery`,
      status: vciso.status,
      detail: vciso.detail,
      note: vciso.note || null,
      order: 91,
    });
  }

  steps.sort((a, b) => a.order - b.order);
  const complete = steps.filter(s => s.status === COMPLETE).length;
  return {
    steps,
    total: steps.length,
    complete,
    outstanding: steps.length - complete,
    pct: steps.length ? Math.round(complete * 100 / steps.length) : 100,
    // Where "start here" points. A contracted programme outranks an
    // operational module: a client whose ISO 42001 scope is untouched should
    // not be told its next move is classifying third-party records. Within
    // each, resume in-progress work before starting untouched work.
    nextStep: [
      s => s.kind === 'programme' && s.status === IN_PROGRESS,
      s => s.kind === 'programme' && s.status === NOT_STARTED,
      s => s.status === IN_PROGRESS,
      s => s.status === NOT_STARTED,
    ].reduce((found, match) => found || steps.find(match) || null, null),
    done: steps.length > 0 && complete === steps.length,
  };
}

// Whether opening this client should land on the setup hub instead of its
// programme home. Replaces the old engagement_intake row count, which was an
// ISO 27001 signal applied to every client regardless of programme.
// Whether opening this client should land on the setup hub instead of its
// programme home. This is narrowly about a brand-new, empty client whose
// overview would otherwise be a page of zeros - it is NOT "anything unscoped".
//
// Adding a fifth programme to a client that is deep into delivery on the other
// four must not yank its overview to a checklist, so any sign of work stops the
// redirect: a completed step, a step in progress, or a scope statement on the
// client. Only the contracted programmes are considered, because a TPRM service
// model chosen on the create form is not evidence the engagement was scoped.
function needsSetup(db, ws) {
  if (ws.scope && String(ws.scope).trim().length > 0) return false;
  const programmes = clientSetup(db, ws).steps.filter(step => step.kind === 'programme');
  if (!programmes.length) return false;
  return programmes.every(step => step.status === NOT_STARTED);
}

module.exports = {
  clientSetup,
  needsSetup,
  NOT_STARTED,
  IN_PROGRESS,
  COMPLETE,
  ISO27001_REQUIRED,
  SEEDED_QUESTION,
};
