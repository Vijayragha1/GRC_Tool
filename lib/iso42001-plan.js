'use strict';
// Who owns each ISO 42001 requirement and when it is due, on the client's
// control record (control_instances.owner_id and due_date). The roadmap's
// treatment phase is read from the due date rather than stored separately, so
// moving a control between phases and changing its due date are the same act
// and cannot disagree.

const ctlWrites = require('./control-writes');

class PlanError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Upper bound of each phase, in months from today. The last phase has none.
const PHASES = Object.freeze([
  { key: '0_3M', label: '0-3 months (now)', months: 3 },
  { key: '3_6M', label: '3-6 months', months: 6 },
  { key: '6_12M', label: '6-12 months', months: 12 },
  { key: '12M_plus', label: '12+ months', months: null },
  { key: '', label: 'Unscheduled', months: null },
]);

const ymd = (d) => d.toISOString().slice(0, 10);
function addMonths(today, months) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return ymd(d);
}

// Overdue work belongs to "now".
function phaseFor(dueDate, today = ymd(new Date())) {
  if (!dueDate) return '';
  for (const p of PHASES) if (p.months && dueDate <= addMonths(today, p.months)) return p.key;
  return '12M_plus';
}

// The due date for a control moved to a phase: its current date if that
// already falls in the phase, else the end of the phase (18 months out for
// the open-ended one). Unscheduled clears it.
function dueForPhase(phaseKey, currentDue, today = ymd(new Date())) {
  const phase = PHASES.find((p) => p.key === phaseKey);
  if (!phase) throw new PlanError('Choose a phase from the list.');
  if (!phase.key) return null;
  if (currentDue && phaseFor(currentDue, today) === phase.key) return currentDue;
  return addMonths(today, phase.months || 18);
}

// People who can own a requirement: the client's members and the firm's staff.
function assignableUsers(db, workspace) {
  return db.prepare(`SELECT DISTINCT u.id, u.name, u.user_type FROM users u
    LEFT JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
    WHERE u.active = 1 AND (wm.workspace_id = ? OR (u.user_type = 'firm' AND u.firm_id = ?))
    ORDER BY CASE u.user_type WHEN 'firm' THEN 0 ELSE 1 END, u.name, u.id`).all(workspace.id, workspace.id, workspace.firm_id);
}

function parseOwner(db, workspace, raw) {
  if (raw === undefined) return undefined;
  if (raw === '' || raw === null) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || !assignableUsers(db, workspace).some((u) => u.id === id)) {
    throw new PlanError('The owner must be a member of this client or of the firm.');
  }
  return id;
}

function parseDue(raw) {
  if (raw === undefined) return undefined;
  if (raw === '' || raw === null) return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new PlanError('The due date must be a date (YYYY-MM-DD).');
  return s;
}

// Sets the owner and/or due date of one requirement. A field left undefined is
// unchanged; an empty value clears it. Returns the requirement's new values.
function setPlan(db, workspace, isoItemId, { ownerId, dueDate }) {
  const requirementId = ctlWrites.requirementId(db, 'iso42001', isoItemId);
  if (!requirementId) throw new PlanError('That requirement is not in ISO 42001.', 404);
  const sets = [];
  const vals = [];
  if (ownerId !== undefined) { sets.push('owner_id=?'); vals.push(ownerId); }
  if (dueDate !== undefined) { sets.push('due_date=?'); vals.push(dueDate); }
  db.prepare('INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)').run(workspace.id, requirementId);
  if (sets.length) {
    db.prepare(`UPDATE control_instances SET ${sets.join(', ')}, last_updated=CURRENT_TIMESTAMP
      WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(...vals, workspace.id, requirementId);
  }
  return db.prepare('SELECT owner_id, due_date FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL').get(workspace.id, requirementId);
}

module.exports = { PlanError, PHASES, phaseFor, dueForPhase, assignableUsers, parseOwner, parseDue, setPlan };
