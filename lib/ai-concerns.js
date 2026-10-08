'use strict';
// Log of concerns and reported adverse impacts for the ISO/IEC 42001
// programme (migration 077).
//
// Two routes in, one log. People working for the organisation raise concerns
// about its role with an AI system (A.3.3); users, affected people and other
// outsiders report adverse impacts such as an unfair outcome (A.8.3). The
// auditor asks how either can be raised and then samples what happened to
// what was raised, so each entry records who handles it, when a response is
// due, whether it went to management, and the resolution.
//
// A reporter's identity is not recorded: only the kind of reporter and
// whether they asked to stay anonymous. Whoever needs the name gets it from
// the channel the report came through, under that channel's protections.

const { RegisterError, IMPACT_AREAS } = require('./ai-systems');

const CHANNELS = Object.freeze({
  concern: 'Concern raised inside the organisation',
  adverse_impact: 'Adverse impact reported from outside',
});
const REPORTERS = Object.freeze({
  employee: 'Employee',
  contractor: 'Contractor',
  user: 'User of the system',
  affected_person: 'Person affected by an output',
  customer: 'Customer',
  regulator: 'Regulator or authority',
  public: 'Member of the public',
  other: 'Other',
});
const SEVERITY = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High' });
const STATUSES = Object.freeze({ received: 'Received', investigating: 'Investigating', resolved: 'Resolved' });
const AREA_LABEL = Object.fromEntries(IMPACT_AREAS);

function clean(value, max = 8000) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  if (text.length > max) throw new RegisterError(`Keep this to ${max.toLocaleString()} characters or fewer.`);
  return text || null;
}

function validDate(value, label) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new RegisterError(`Enter a valid ${label}.`);
  return text;
}

const pick = (value, allowed, fallback = null) => (Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback);

function ownId(db, table, ws, value, what) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || !db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(id, ws.id)) {
    throw new RegisterError(`That ${what} is not in this client workspace.`);
  }
  return id;
}

function input(db, ws, body, today) {
  const channel = pick(body.channel, CHANNELS);
  const summary = clean(body.summary, 4000);
  if (!channel || !summary) throw new RegisterError('Say how it came in and what was raised.');
  const receivedOn = validDate(body.received_on, 'date received') || today;
  if (receivedOn > today) throw new RegisterError('A report cannot be received in the future.');
  const status = pick(body.status, STATUSES, 'received');
  const resolution = clean(body.resolution);
  let resolvedOn = validDate(body.resolved_on, 'resolution date');
  if (status === 'resolved') {
    if (!resolution) throw new RegisterError('Record how it was resolved before marking it resolved.');
    resolvedOn = resolvedOn || today;
  }
  if (resolvedOn && resolvedOn < receivedOn) throw new RegisterError('It cannot be resolved before it was received.');
  const respondBy = validDate(body.respond_by, 'respond-by date');
  if (respondBy && respondBy < receivedOn) throw new RegisterError('The response cannot be due before the report was received.');
  return {
    channel, summary, received_on: receivedOn,
    reporter_type: pick(body.reporter_type, REPORTERS, 'other'),
    anonymous: String(body.anonymous) === '1' || body.anonymous === 'on' ? 1 : 0,
    ai_system_id: ownId(db, 'ai_systems', ws, body.ai_system_id, 'AI system'),
    impact_area: pick(body.impact_area, AREA_LABEL),
    severity: pick(body.severity, SEVERITY),
    status,
    handler: clean(body.handler, 160),
    respond_by: respondBy,
    escalated_on: validDate(body.escalated_on, 'date escalated'),
    incident_id: ownId(db, 'incidents', ws, body.incident_id, 'incident'),
    resolution,
    resolved_on: status === 'resolved' ? resolvedOn : null,
  };
}

const COLUMNS = ['channel', 'summary', 'received_on', 'reporter_type', 'anonymous', 'ai_system_id', 'impact_area', 'severity', 'status',
  'handler', 'respond_by', 'escalated_on', 'incident_id', 'resolution', 'resolved_on'];

function list(db, ws, today) {
  const rows = db.prepare(`SELECT r.*, s.name AS system_name, i.title AS incident_title FROM ai_concern_reports r
    LEFT JOIN ai_systems s ON s.id = r.ai_system_id LEFT JOIN incidents i ON i.id = r.incident_id
    WHERE r.workspace_id=? ORDER BY CASE r.status WHEN 'resolved' THEN 1 ELSE 0 END, r.received_on DESC, r.id DESC`).all(ws.id)
    .map((r) => ({ ...r, late: r.status !== 'resolved' && !!r.respond_by && r.respond_by < today }));
  const open = rows.filter((r) => r.status !== 'resolved');
  return {
    rows,
    counts: {
      total: rows.length,
      open: open.length,
      late: rows.filter((r) => r.late).length,
      escalated: rows.filter((r) => r.escalated_on).length,
      concerns: rows.filter((r) => r.channel === 'concern').length,
      reports: rows.filter((r) => r.channel === 'adverse_impact').length,
    },
  };
}

function create(db, ws, actorId, body, today) {
  const v = input(db, ws, body, today);
  return Number(db.prepare(`INSERT INTO ai_concern_reports (workspace_id, ${COLUMNS.join(', ')}, created_by)
    VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?)`).run(ws.id, ...COLUMNS.map((c) => v[c]), actorId).lastInsertRowid);
}

function update(db, ws, id, body, today) {
  const row = db.prepare('SELECT * FROM ai_concern_reports WHERE id=? AND workspace_id=?').get(Number(id), ws.id);
  if (!row) throw new RegisterError('Report not found.', 404);
  if (Number(body.version) !== Number(row.version)) throw new RegisterError('This report was changed in another session. Refresh and try again.', 409);
  const v = input(db, ws, body, today);
  db.prepare(`UPDATE ai_concern_reports SET ${COLUMNS.map((c) => `${c}=?`).join(', ')}, updated_at=datetime('now'), version=version+1
    WHERE id=? AND workspace_id=? AND version=?`).run(...COLUMNS.map((c) => v[c]), row.id, ws.id, row.version);
}

// Counts for a period, for the management review (lib/aims-review-inputs.js).
function since(db, ws, from, today) {
  const one = (sql, ...params) => { try { return db.prepare(sql).get(...params).c || 0; } catch (_) { return 0; } };
  return {
    concerns: one(`SELECT COUNT(*) c FROM ai_concern_reports WHERE workspace_id=? AND channel='concern' AND received_on > ?`, ws.id, from),
    reports: one(`SELECT COUNT(*) c FROM ai_concern_reports WHERE workspace_id=? AND channel='adverse_impact' AND received_on > ?`, ws.id, from),
    open: one(`SELECT COUNT(*) c FROM ai_concern_reports WHERE workspace_id=? AND status != 'resolved'`, ws.id),
    late: one(`SELECT COUNT(*) c FROM ai_concern_reports WHERE workspace_id=? AND status != 'resolved' AND respond_by < ?`, ws.id, today),
  };
}

module.exports = { CHANNELS, REPORTERS, SEVERITY, STATUSES, AREA_LABEL, list, create, update, since };
