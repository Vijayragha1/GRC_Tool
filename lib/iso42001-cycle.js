'use strict';
// The ISO 42001 certification cycle: every audit date for the client, and the
// certification body's findings against each audit.
//
// Audit dates live in iso42001_cert_cycle_events (migration 070). The Stage 1
// and Stage 2 dates shown on the programme overview and used for request
// countdowns are the current cycle's Stage 1 and Stage 2 events; writing them
// from either page writes the event, and the aims_audit_programmes columns
// are kept equal to it for older readers.
//
// A certification is a three-year cycle: Stage 1 and Stage 2 (or, from the
// second cycle, the recertification audit), then two surveillance audits.
// Each event carries its cycle number, so surveillance and recertification
// history is kept rather than overwritten.
//
// Findings are nonconformities with source 'external_audit' and source_ref
// 'iso42001_cert_cycle_event:<event id>' (the form lib/iso42001-certification.js
// counts; an earlier 'aims_cert_event:<event id>' form is still read). That
// reference is what lib/engagement-delivery.js certificationFindingLineage()
// recognises, so an ISO 42001 finding gets the same protection as an ISO 27001
// one: its source cannot be edited, it cannot be deleted, and it cannot be
// closed without a corrective action, an effectiveness conclusion and
// independent validation evidence (plus a root cause for a major or minor
// nonconformity).
//
// The rules for a single audit (supported types, real calendar dates, one
// Stage 1 and one Stage 2, Stage 1 completed before Stage 2, actual dates kept
// once recorded) are lib/iso42001-certification.js's, which the delivery plan
// also reads. Events written before event_key existed are read by their label.

const reqOpts = require('./requirement-options');
const certification = require('./iso42001-certification');

class CycleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const EVENT_TYPES = Object.freeze([
  { key: 'stage1', label: 'Stage 1 audit', desc: 'Documentation review by the certification body: AIMS scope, AI policy, SoA, risk and impact assessment methods.', audit: true },
  { key: 'stage2', label: 'Stage 2 audit', desc: 'Operational audit: the auditors test that the AIMS works in practice across the in-scope AI systems.', audit: true },
  { key: 'surv1', label: 'Surveillance audit (year 1)', desc: 'Annual surveillance by the certification body to confirm continued conformance.', audit: true },
  { key: 'surv2', label: 'Surveillance audit (year 2)', desc: 'Second annual surveillance.', audit: true },
  { key: 'recert', label: 'Recertification audit', desc: 'Full reassessment at the end of the three-year cycle; it opens the next cycle.', audit: true },
  { key: 'internal', label: 'Internal audit', desc: 'Internal audit of the AIMS (clause 9.2).', audit: false },
  { key: 'mrm', label: 'Management review', desc: 'Top-management review of the AIMS (clause 9.3).', audit: false },
]);
const TYPE = Object.fromEntries(EVENT_TYPES.map((t) => [t.key, t]));
const AUDIT_KEYS = EVENT_TYPES.filter((t) => t.audit).map((t) => t.key);
// The certification-cycle event types the ISO 27001 lineage uses, so the
// nonconformity pages name an ISO 42001 finding's audit the same way.
const LINEAGE_TYPE = Object.freeze({ stage1: 'stage_1', stage2: 'stage_2', surv1: 'surveillance_y1', surv2: 'surveillance_y2', recert: 'recertification' });

const SEVERITIES = Object.freeze([
  { key: 'major', label: 'Major nonconformity' },
  { key: 'minor', label: 'Minor nonconformity' },
  { key: 'observation', label: 'Observation' },
  { key: 'opportunity', label: 'Opportunity for improvement' },
]);

const STATUSES = Object.freeze(['planned', 'scheduled', 'in_progress', 'completed', 'cancelled']);

// This module's keys against lib/iso42001-certification.js's.
const FROM_CERT = Object.freeze({ stage_1: 'stage1', stage_2: 'stage2', surveillance_y1: 'surv1', surveillance_y2: 'surv2', recertification: 'recert', internal: 'internal', mrm: 'mrm' });
const keyOf = (row) => (row && (row.event_key || FROM_CERT[certification.eventKey(row.event_type)])) || null;
const REF_RE = /^(?:iso42001_cert_cycle_event|aims_cert_event):(\d+)$/;
const REF_SQL = "(n.source_ref LIKE 'iso42001_cert_cycle_event:%' OR n.source_ref LIKE 'aims_cert_event:%')";

const clean = (v, max = 4000) => (v == null ? null : (String(v).trim().slice(0, max) || null));
function validDate(value, label) {
  const v = clean(value, 10);
  if (!v) return null;
  if (!certification.isValidISODate(v)) throw new CycleError(`${label} must be a real date (YYYY-MM-DD).`);
  return v;
}
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addYears = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };
const ref = (eventId) => `iso42001_cert_cycle_event:${eventId}`;
const refsFor = (eventId) => [ref(eventId), `aims_cert_event:${eventId}`];

function currentCycle(db, workspaceId) {
  const row = db.prepare('SELECT MAX(cycle_no) n FROM iso42001_cert_cycle_events WHERE workspace_id=?').get(workspaceId);
  return (row && row.n) || 1;
}

function load(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM iso42001_cert_cycle_events WHERE id=? AND workspace_id=?').get(id, workspaceId);
  if (!row) throw new CycleError('That audit is not part of this client\'s certification cycle.', 404);
  return row;
}

// Findings recorded against each event, keyed by event id.
function findingsByEvent(db, workspace) {
  const rows = reqOpts.nameRows(workspace, db.prepare(`SELECT n.*, rq.title AS iso_title, rq_fw.code AS iso_framework
    FROM nonconformities n ${reqOpts.joinSql('n.iso_item_id')}
    WHERE n.workspace_id=? AND lower(COALESCE(n.source,''))='external_audit' AND ${REF_SQL}
    ORDER BY n.created_at, n.id`).all(workspace.id));
  const out = {};
  for (const r of rows) { const id = Number(REF_RE.exec(r.source_ref)[1]); (out[id] = out[id] || []).push(r); }
  return out;
}

const isOpen = (f) => !['closed', 'verified'].includes(String(f.status || '').toLowerCase());

// Every event, by cycle and date, with its findings and open counts.
function events(db, workspace) {
  const findings = findingsByEvent(db, workspace);
  return db.prepare(`SELECT * FROM iso42001_cert_cycle_events WHERE workspace_id=?
      ORDER BY cycle_no, planned_date IS NULL, planned_date, id`).all(workspace.id)
    .map((e) => {
      const list = findings[e.id] || [];
      const key = keyOf(e);
      const type = TYPE[key] || { key: 'other', label: e.event_type, audit: false };
      return {
        ...e,
        event_key: key,
        label: type.label,
        isAudit: !!type.audit,
        findings: list,
        openMajor: list.filter((f) => isOpen(f) && f.severity === 'major').length,
        openMinor: list.filter((f) => isOpen(f) && f.severity === 'minor').length,
        openOther: list.filter((f) => isOpen(f) && !['major', 'minor'].includes(f.severity)).length,
        overdue: list.filter((f) => isOpen(f) && f.due_date && f.due_date < new Date().toISOString().slice(0, 10)).length,
      };
    });
}

// Open certification-body findings across the whole cycle, for readiness and
// the overview.
function openFindings(db, workspace) {
  return db.prepare(`SELECT n.severity, COUNT(*) c FROM nonconformities n
    WHERE n.workspace_id=? AND lower(COALESCE(n.source,''))='external_audit' AND ${REF_SQL}
      AND n.status NOT IN ('closed','verified') GROUP BY n.severity`).all(workspace.id)
    .reduce((acc, r) => { acc[r.severity || 'other'] = r.c; acc.total += r.c; return acc; }, { total: 0 });
}

// The current cycle's Stage 1 and Stage 2 dates (or, from the second cycle,
// the recertification audit as the audit that renews the certificate).
function stageDates(db, workspaceId) {
  const cycle = currentCycle(db, workspaceId);
  const rows = db.prepare('SELECT * FROM iso42001_cert_cycle_events WHERE workspace_id=? AND cycle_no=? ORDER BY id').all(workspaceId, cycle);
  const pick = (key) => {
    const row = rows.find((r) => keyOf(r) === key);
    return row ? (row.actual_date || row.planned_date || null) : undefined;
  };
  return { cycle, stage1: pick('stage1'), stage2: pick('stage2') };
}

// Keep aims_audit_programmes' Stage columns equal to the events.
function mirrorProgramme(db, workspaceId, actorId) {
  const { stage1, stage2 } = stageDates(db, workspaceId);
  const body = db.prepare(`SELECT event_key, event_type, certification_body FROM iso42001_cert_cycle_events
    WHERE workspace_id=? AND certification_body IS NOT NULL ORDER BY id DESC`).all(workspaceId).find((r) => ['stage1', 'stage2'].includes(keyOf(r)));
  db.prepare(`INSERT INTO aims_audit_programmes (workspace_id, stage1_date, stage2_date, certification_body, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id) DO UPDATE SET stage1_date=excluded.stage1_date, stage2_date=excluded.stage2_date,
      certification_body=COALESCE(excluded.certification_body, certification_body), updated_by=excluded.updated_by, updated_at=datetime('now')`)
    .run(workspaceId, stage1 || null, stage2 || null, body ? body.certification_body : null, actorId || null);
}

// Set a Stage 1 or Stage 2 date of the current cycle, creating the event when
// it does not exist. A null date clears the planned date but keeps the event
// and any findings recorded against it.
function setStageDate(db, workspace, actorId, key, date, { certificationBody } = {}) {
  if (!['stage1', 'stage2'].includes(key)) throw new CycleError('Only Stage 1 and Stage 2 dates are set here.');
  const cycle = currentCycle(db, workspace.id);
  const existing = findInCycle(db, workspace.id, cycle, key);
  if (existing) {
    db.prepare(`UPDATE iso42001_cert_cycle_events SET planned_date=?, certification_body=COALESCE(?, certification_body) WHERE id=?`)
      .run(date || null, certificationBody || null, existing.id);
  } else if (date) {
    db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, event_key, planned_date, status, certification_body, cycle_no)
      VALUES (?, ?, ?, ?, 'planned', ?, ?)`).run(workspace.id, TYPE[key].label, key, date, certificationBody || null, cycle);
  }
  mirrorProgramme(db, workspace.id, actorId);
}

// The first event of a kind in a cycle, whether it carries event_key or only
// a label written before event_key existed.
function findInCycle(db, workspaceId, cycle, key) {
  return db.prepare('SELECT * FROM iso42001_cert_cycle_events WHERE workspace_id=? AND cycle_no=? ORDER BY id').all(workspaceId, cycle)
    .find((r) => keyOf(r) === key) || null;
}

const has = (body, field) => Object.prototype.hasOwnProperty.call(body || {}, field);
function statusOf(value) {
  const s = clean(value, 20);
  if (!s) return null;
  const v = s.toLowerCase() === 'closed' ? 'completed' : s.toLowerCase();
  if (!STATUSES.includes(v)) throw new CycleError('Choose a status from the list.');
  return v;
}

// 'scheduled' (a planned audit whose date the certification body has
// confirmed) is a planned audit to lib/iso42001-certification.js.
function checked(db, workspaceId, candidate, excludeEventId) {
  const status = candidate.status === 'scheduled' ? 'planned' : candidate.status;
  const result = certification.validateCertificationEvent(db, workspaceId, { ...candidate, status }, { excludeEventId });
  if (!result.valid) throw new CycleError(result.errors.join(' '));
}

function addEvent(db, workspace, actorId, body) {
  const raw = clean(body.event_key || body.event_type, 60);
  const key = TYPE[raw] ? raw : FROM_CERT[certification.eventKey(raw)];
  if (!TYPE[key]) throw new CycleError('Choose the kind of audit or review.');
  const input = {
    planned_date: validDate(body.planned_date, 'Planned date'),
    actual_date: validDate(body.actual_date, 'Actual date'),
    status: statusOf(body.status) || 'planned',
    notes: clean(body.notes),
    certification_body: clean(body.certification_body, 200),
  };
  const cycle = Number(body.cycle_no) > 0 ? Number(body.cycle_no) : currentCycle(db, workspace.id);
  if (['stage1', 'stage2'].includes(key) && findInCycle(db, workspace.id, cycle, key)) {
    throw new CycleError(`This cycle already has a ${TYPE[key].label}. Reschedule it rather than adding another.`);
  }
  checked(db, workspace.id, { event_type: TYPE[key].label, ...input });
  const id = Number(db.prepare(`INSERT INTO iso42001_cert_cycle_events
      (workspace_id, event_type, event_key, planned_date, actual_date, status, notes, certification_body, cycle_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(workspace.id, TYPE[key].label, key, input.planned_date, input.actual_date, input.status, input.notes, input.certification_body, cycle).lastInsertRowid);
  if (['stage1', 'stage2'].includes(key)) mirrorProgramme(db, workspace.id, actorId);
  return id;
}

// Changes only the fields the form sends. An actual date, once recorded, is
// kept (it can be corrected, not removed), and a completed audit needs one.
function updateEvent(db, workspace, actorId, id, body) {
  const event = load(db, workspace.id, id);
  const next = { ...event, status: String(event.status || 'planned').toLowerCase() === 'closed' ? 'completed' : event.status };
  if (has(body, 'planned_date')) next.planned_date = validDate(body.planned_date, 'Planned date');
  if (has(body, 'actual_date')) next.actual_date = validDate(body.actual_date, 'Actual date');
  if (has(body, 'status')) next.status = statusOf(body.status) || next.status;
  if (has(body, 'notes')) next.notes = clean(body.notes);
  if (has(body, 'certification_body')) next.certification_body = clean(body.certification_body, 200) || event.certification_body;
  if ((event.actual_date || certification.isClosed(event.status)) && !next.actual_date) {
    throw new CycleError('Keep the date the audit took place; correct it if it is wrong.');
  }
  if (next.status === 'completed' && !next.actual_date) throw new CycleError('Record the date the audit took place before marking it completed.');
  checked(db, workspace.id, next, event.id);
  db.prepare(`UPDATE iso42001_cert_cycle_events SET planned_date=?, actual_date=?, status=?, notes=?, certification_body=?, event_key=COALESCE(event_key, ?)
      WHERE id=? AND workspace_id=?`)
    .run(next.planned_date, next.actual_date, next.status, next.notes, next.certification_body, keyOf(event), event.id, workspace.id);
  if (['stage1', 'stage2'].includes(keyOf(event))) mirrorProgramme(db, workspace.id, actorId);
  return event.id;
}

// An audit that took place, was completed or has findings is part of the
// certification record and is kept.
function deleteEvent(db, workspace, actorId, id) {
  const event = load(db, workspace.id, id);
  const findings = db.prepare('SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND source_ref IN (?, ?)').get(workspace.id, ...refsFor(event.id)).c;
  if (findings) throw new CycleError('This audit has findings recorded against it, so it is kept as part of the certification record.', 409);
  if (event.actual_date || certification.isClosed(event.status)) {
    throw new CycleError('This audit has taken place, so it is kept as part of the certification record. Correct its dates instead.', 409);
  }
  db.prepare('DELETE FROM iso42001_cert_cycle_events WHERE id=? AND workspace_id=?').run(event.id, workspace.id);
  if (['stage1', 'stage2'].includes(keyOf(event))) mirrorProgramme(db, workspace.id, actorId);
}

// The standard three-year cycle from a Stage 2 (or target certification)
// date: Stage 1 a month before, surveillance at one and two years, and the
// recertification audit at three. Existing events of the cycle are kept.
function seed(db, workspace, actorId, anchorDate) {
  if (anchorDate && !certification.isValidISODate(String(anchorDate))) {
    throw new CycleError('Correct the target certification date to a real date (YYYY-MM-DD) before planning the cycle.');
  }
  const cycle = currentCycle(db, workspace.id);
  const stage2 = anchorDate || addDays(new Date().toISOString().slice(0, 10), 90);
  const plan = [['stage1', addDays(stage2, -30)], ['stage2', stage2], ['surv1', addYears(stage2, 1)], ['surv2', addYears(stage2, 2)], ['recert', addYears(stage2, 3)]];
  const has = (key) => findInCycle(db, workspace.id, cycle, key);
  const ins = db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, event_key, planned_date, status, cycle_no) VALUES (?, ?, ?, ?, 'planned', ?)`);
  let added = 0;
  for (const [key, date] of plan) {
    if (has(key)) continue;
    ins.run(workspace.id, TYPE[key].label, key, date, cycle);
    added++;
  }
  mirrorProgramme(db, workspace.id, actorId);
  return added;
}

// Open the next three-year cycle once the current one's recertification
// audit is completed: its surveillance audits and the next recertification.
function startNextCycle(db, workspace, actorId) {
  const cycle = currentCycle(db, workspace.id);
  const recert = findInCycle(db, workspace.id, cycle, 'recert');
  if (!recert || recert.status !== 'completed' || !recert.actual_date) {
    throw new CycleError('Complete this cycle\'s recertification audit, with its date, before starting the next cycle.', 409);
  }
  const next = cycle + 1;
  const ins = db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, event_key, planned_date, status, certification_body, cycle_no) VALUES (?, ?, ?, ?, 'planned', ?, ?)`);
  for (const [key, years] of [['surv1', 1], ['surv2', 2], ['recert', 3]]) {
    ins.run(workspace.id, TYPE[key].label, key, addYears(recert.actual_date, years), recert.certification_body || null, next);
  }
  return next;
}

// Record a finding the certification body raised at one of its audits.
function recordFinding(db, workspace, actorId, eventId, body) {
  const event = load(db, workspace.id, eventId);
  if (!AUDIT_KEYS.includes(keyOf(event))) throw new CycleError('Findings are recorded against the certification body\'s audits.');
  const severity = SEVERITIES.some((s) => s.key === body.severity) ? body.severity : null;
  if (!severity) throw new CycleError('Choose whether this is a major or minor nonconformity, an observation, or an opportunity for improvement.');
  const description = clean(body.description, 8000);
  if (!description) throw new CycleError('Describe the finding as the auditor wrote it.');
  const title = clean(body.title, 200) || description.slice(0, 100);
  const requirement = body.iso_item_id && reqOpts.belongs(db, workspace, body.iso_item_id) ? body.iso_item_id : null;
  const dueDate = validDate(body.due_date, 'Closure deadline');
  const id = Number(db.prepare(`INSERT INTO nonconformities
      (workspace_id, title, source, source_ref, description, severity, iso_item_id, due_date, status)
      VALUES (?, ?, 'external_audit', ?, ?, ?, ?, ?, 'open')`)
    .run(workspace.id, title, ref(event.id), description, severity, requirement, dueDate).lastInsertRowid);
  return id;
}

// The lineage of a source reference, for lib/engagement-delivery.js.
function eventForSourceRef(db, workspaceId, sourceRef) {
  const m = REF_RE.exec(String(sourceRef || '').trim());
  if (!m) return null;
  let row;
  try {
    row = db.prepare('SELECT * FROM iso42001_cert_cycle_events WHERE id=? AND workspace_id=?').get(Number(m[1]), workspaceId);
  } catch (_) { return null; }
  const key = keyOf(row);
  return row && AUDIT_KEYS.includes(key)
    ? { id: row.id, event_type: LINEAGE_TYPE[key], status: row.status, actual_date: row.actual_date, framework: 'iso42001', framework_code: 'iso42001' }
    : null;
}

module.exports = {
  CycleError, EVENT_TYPES, SEVERITIES, STATUSES, AUDIT_KEYS, keyOf,
  currentCycle, events, openFindings, stageDates, setStageDate, mirrorProgramme,
  addEvent, updateEvent, deleteEvent, seed, startNextCycle, recordFinding, eventForSourceRef,
};
