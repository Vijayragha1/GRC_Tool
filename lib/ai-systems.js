'use strict';
// AI system register for the ISO/IEC 42001 programme.
//
// The certification auditor samples from four populations that all hang off
// this register: newly implemented AI systems, vendors involved in the AI
// system lifecycle, changes that affect an AI system and incidents involving
// one. Keeping them on the system record means a population is a query, not
// a spreadsheet someone assembles the night before fieldwork.
//
// Each system also carries its impact assessment (clause 6.1.4, 8.4 and
// Annex A.5). A draft is edited in place. Approval freezes it with a content
// hash and needs a second person; a reassessment starts a new version.

const crypto = require('crypto');

// Organisational roles from ISO/IEC 22989, as the auditor asks for them under
// clause 4.1. An organisation can hold more than one role for one system.
const ROLES = Object.freeze({
  provider: 'AI provider',
  producer: 'AI producer (develops the system)',
  customer: 'AI customer (uses the system)',
  partner: 'AI partner (integrator or data provider)',
});
const LIFECYCLE = Object.freeze({
  planned: 'Planned', in_development: 'In development', in_use: 'In use', retired: 'Retired',
});
const AUTOMATION = Object.freeze({
  assistive: 'Suggests; a person decides',
  human_in_loop: 'Acts only after a person approves',
  human_on_loop: 'Acts; a person monitors and can step in',
  autonomous: 'Acts without routine human review',
});
const RESIDUAL = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High' });
const DECISIONS = Object.freeze({
  proceed: 'Proceed',
  proceed_with_conditions: 'Proceed with conditions',
  do_not_proceed: 'Do not proceed',
});
const IA_FIELDS = Object.freeze([
  ['trigger_reason', 'Why this assessment was done', 'A new system, a significant change, a scheduled review, or an incident.'],
  ['affected_parties', 'Who the system affects', 'Individuals, groups and communities affected by the system\'s outputs, including people who never use it.'],
  ['intended_benefits', 'Intended benefits', 'What the system is meant to achieve for those people and for the organisation.'],
  ['potential_harms', 'Potential harms', 'Negative impacts on individuals and society: fairness, privacy, safety, access to services, employment.'],
  ['failure_modes', 'Foreseeable failures', 'How the system can get it wrong, and what happens to the person on the other end when it does.'],
  ['misuse', 'Reasonably foreseeable misuse', 'Uses outside the intended purpose that the organisation can anticipate.'],
  ['demographic_notes', 'Demographic groups', 'Groups the system may treat differently, and how that was tested.'],
  ['oversight_measures', 'Human oversight', 'Who reviews outputs, when a person can override, and the tools they have to do it.'],
  ['mitigations', 'Measures taken', 'Controls that reduce the harms above, with the Annex A control or policy each one relies on.'],
  ['conditions', 'Conditions on the decision', 'What must stay true for the decision to hold. Leave blank when there are none.'],
]);

class RegisterError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

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

function pick(value, allowed, fallback = null) {
  return Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
}

function parseRoles(value) {
  const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  return [...new Set(list.map(String).filter(r => Object.prototype.hasOwnProperty.call(ROLES, r)))];
}

function decodeRoles(json) {
  try { return parseRoles(JSON.parse(json || '[]')); } catch (_) { return []; }
}

function systemInput(body) {
  const name = clean(body.name, 160);
  if (!name) throw new RegisterError('Name the AI system.');
  const stage = pick(body.lifecycle_stage, LIFECYCLE, 'in_use');
  const values = {
    name,
    purpose: clean(body.purpose, 4000),
    intended_users: clean(body.intended_users, 2000),
    org_roles: JSON.stringify(parseRoles(body.org_roles)),
    lifecycle_stage: stage,
    go_live_date: validDate(body.go_live_date, 'go-live date'),
    retired_date: validDate(body.retired_date, 'retirement date'),
    in_scope: String(body.in_scope) === '0' ? 0 : 1,
    scope_note: clean(body.scope_note, 2000),
    system_owner: clean(body.system_owner, 160),
    automation_level: pick(body.automation_level, AUTOMATION, null),
    human_oversight: clean(body.human_oversight, 4000),
    data_resources: clean(body.data_resources, 8000),
    tooling_resources: clean(body.tooling_resources, 8000),
    compute_resources: clean(body.compute_resources, 8000),
    human_resources: clean(body.human_resources, 8000),
  };
  if (values.in_scope === 0 && !values.scope_note) throw new RegisterError('Record why this system is outside the AIMS scope. The auditor checks exclusions.');
  if (values.retired_date && values.go_live_date && values.retired_date < values.go_live_date) throw new RegisterError('A system cannot be retired before it went live.');
  return values;
}

function list(db, ws) {
  return db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM ai_system_suppliers v WHERE v.ai_system_id=s.id) AS supplier_count,
      (SELECT COUNT(*) FROM ai_system_links l WHERE l.ai_system_id=s.id AND l.link_type='change') AS change_count,
      (SELECT COUNT(*) FROM ai_system_links l WHERE l.ai_system_id=s.id AND l.link_type='incident') AS incident_count,
      (SELECT ia.status FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id ORDER BY ia.version_no DESC LIMIT 1) AS ia_status,
      (SELECT ia.approved_at FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id AND ia.status='approved' ORDER BY ia.version_no DESC LIMIT 1) AS ia_approved_at,
      (SELECT ia.residual_level FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id AND ia.status='approved' ORDER BY ia.version_no DESC LIMIT 1) AS ia_residual
    FROM ai_systems s WHERE s.workspace_id=? ORDER BY s.in_scope DESC,
      CASE s.lifecycle_stage WHEN 'in_use' THEN 0 WHEN 'in_development' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END, s.name`).all(ws.id)
    .map(s => ({ ...s, roles: decodeRoles(s.org_roles) }));
}

function load(db, ws, id) {
  const s = db.prepare('SELECT * FROM ai_systems WHERE id=? AND workspace_id=?').get(Number(id), ws.id);
  return s ? { ...s, roles: decodeRoles(s.org_roles) } : null;
}

function detail(db, ws, id) {
  const system = load(db, ws, id);
  if (!system) return null;
  const suppliers = db.prepare('SELECT * FROM ai_system_suppliers WHERE ai_system_id=? AND workspace_id=? ORDER BY supplier_name').all(system.id, ws.id);
  const changes = db.prepare(`SELECT c.id, c.title, c.status, c.implemented_at, c.created_at, l.linked_at
    FROM ai_system_links l JOIN changes c ON c.id=l.target_id AND c.workspace_id=l.workspace_id
    WHERE l.ai_system_id=? AND l.link_type='change' ORDER BY COALESCE(c.implemented_at, c.created_at) DESC`).all(system.id);
  const incidents = db.prepare(`SELECT i.id, i.title, i.severity, i.status, i.detected_at, i.created_at, l.linked_at
    FROM ai_system_links l JOIN incidents i ON i.id=l.target_id AND i.workspace_id=l.workspace_id
    WHERE l.ai_system_id=? AND l.link_type='incident' ORDER BY COALESCE(i.detected_at, i.created_at) DESC`).all(system.id);
  const assessments = db.prepare(`SELECT ia.*, p.name AS prepared_by_name, a.name AS approved_by_name
    FROM ai_impact_assessments ia LEFT JOIN users p ON p.id=ia.prepared_by LEFT JOIN users a ON a.id=ia.approved_by
    WHERE ia.ai_system_id=? AND ia.workspace_id=? ORDER BY ia.version_no DESC`).all(system.id, ws.id);
  const linkable = {
    changes: db.prepare(`SELECT id, title, status FROM changes WHERE workspace_id=? AND id NOT IN (
      SELECT target_id FROM ai_system_links WHERE ai_system_id=? AND link_type='change') ORDER BY id DESC LIMIT 200`).all(ws.id, system.id),
    incidents: db.prepare(`SELECT id, title, status FROM incidents WHERE workspace_id=? AND COALESCE(is_tabletop,0)=0 AND id NOT IN (
      SELECT target_id FROM ai_system_links WHERE ai_system_id=? AND link_type='incident') ORDER BY id DESC LIMIT 200`).all(ws.id, system.id),
  };
  return { system, suppliers, changes, incidents, assessments, linkable };
}

function create(db, ws, actorId, body) {
  const v = systemInput(body);
  if (db.prepare('SELECT 1 FROM ai_systems WHERE workspace_id=? AND name=?').get(ws.id, v.name)) {
    throw new RegisterError(`${v.name} is already on the register.`);
  }
  return Number(db.prepare(`INSERT INTO ai_systems
    (workspace_id, name, purpose, intended_users, org_roles, lifecycle_stage, go_live_date, retired_date, in_scope, scope_note,
     system_owner, automation_level, human_oversight, data_resources, tooling_resources, compute_resources, human_resources, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ws.id, v.name, v.purpose, v.intended_users, v.org_roles,
    v.lifecycle_stage, v.go_live_date, v.retired_date, v.in_scope, v.scope_note, v.system_owner, v.automation_level,
    v.human_oversight, v.data_resources, v.tooling_resources, v.compute_resources, v.human_resources, actorId).lastInsertRowid);
}

function update(db, ws, actorId, id, body) {
  const system = load(db, ws, id);
  if (!system) throw new RegisterError('AI system not found.', 404);
  if (Number(body.version) !== Number(system.version)) throw new RegisterError('This system was changed in another session. Refresh and try again.', 409);
  const v = systemInput(body);
  if (v.name !== system.name && db.prepare('SELECT 1 FROM ai_systems WHERE workspace_id=? AND name=? AND id!=?').get(ws.id, v.name, system.id)) {
    throw new RegisterError(`${v.name} is already on the register.`);
  }
  db.prepare(`UPDATE ai_systems SET name=?, purpose=?, intended_users=?, org_roles=?, lifecycle_stage=?, go_live_date=?, retired_date=?,
      in_scope=?, scope_note=?, system_owner=?, automation_level=?, human_oversight=?, data_resources=?, tooling_resources=?,
      compute_resources=?, human_resources=?, updated_at=datetime('now'), version=version+1
    WHERE id=? AND workspace_id=? AND version=?`).run(v.name, v.purpose, v.intended_users, v.org_roles, v.lifecycle_stage,
    v.go_live_date, v.retired_date, v.in_scope, v.scope_note, v.system_owner, v.automation_level, v.human_oversight,
    v.data_resources, v.tooling_resources, v.compute_resources, v.human_resources, system.id, ws.id, system.version);
}

function addSupplier(db, ws, actorId, id, body) {
  const system = load(db, ws, id);
  if (!system) throw new RegisterError('AI system not found.', 404);
  const name = clean(body.supplier_name, 160);
  const role = clean(body.lifecycle_role, 120);
  if (!name || !role) throw new RegisterError('Name the supplier and the part it plays in the system\'s lifecycle.');
  db.prepare(`INSERT INTO ai_system_suppliers (ai_system_id, workspace_id, supplier_name, lifecycle_role, service, assurance, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(system.id, ws.id, name, role, clean(body.service, 500), clean(body.assurance, 500), actorId);
}

function removeSupplier(db, ws, id, supplierId) {
  const r = db.prepare('DELETE FROM ai_system_suppliers WHERE id=? AND ai_system_id=? AND workspace_id=?').run(Number(supplierId), Number(id), ws.id);
  if (!r.changes) throw new RegisterError('Supplier not found on this system.', 404);
}

function link(db, ws, actorId, id, body) {
  const system = load(db, ws, id);
  if (!system) throw new RegisterError('AI system not found.', 404);
  const type = body.link_type === 'incident' ? 'incident' : body.link_type === 'change' ? 'change' : null;
  const targetId = Number(body.target_id);
  if (!type || !Number.isInteger(targetId)) throw new RegisterError('Choose a change or incident to link.');
  const table = type === 'change' ? 'changes' : 'incidents';
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(targetId, ws.id)) {
    throw new RegisterError(`That ${type} is not in this client workspace.`);
  }
  db.prepare(`INSERT OR IGNORE INTO ai_system_links (ai_system_id, workspace_id, link_type, target_id, linked_by)
    VALUES (?, ?, ?, ?, ?)`).run(system.id, ws.id, type, targetId, actorId);
}

function unlink(db, ws, id, type, targetId) {
  db.prepare('DELETE FROM ai_system_links WHERE ai_system_id=? AND workspace_id=? AND link_type=? AND target_id=?')
    .run(Number(id), ws.id, type === 'incident' ? 'incident' : 'change', Number(targetId));
}

// ---------------------------------------------------------------- impact assessments

function loadAssessment(db, ws, systemId, iaId) {
  return db.prepare('SELECT * FROM ai_impact_assessments WHERE id=? AND ai_system_id=? AND workspace_id=?').get(Number(iaId), Number(systemId), ws.id) || null;
}

function startAssessment(db, ws, actorId, systemId) {
  const system = load(db, ws, systemId);
  if (!system) throw new RegisterError('AI system not found.', 404);
  if (db.prepare("SELECT 1 FROM ai_impact_assessments WHERE ai_system_id=? AND status='draft'").get(system.id)) {
    throw new RegisterError('A draft assessment is already open for this system.', 409);
  }
  const prev = db.prepare("SELECT * FROM ai_impact_assessments WHERE ai_system_id=? AND status='approved' ORDER BY version_no DESC LIMIT 1").get(system.id);
  const next = (db.prepare('SELECT COALESCE(MAX(version_no), 0) n FROM ai_impact_assessments WHERE ai_system_id=?').get(system.id).n) + 1;
  // A reassessment starts from the approved position, so the preparer edits
  // what changed instead of retyping what did not.
  const carry = prev ? IA_FIELDS.map(([k]) => (k === 'trigger_reason' ? null : prev[k])) : IA_FIELDS.map(() => null);
  const cols = IA_FIELDS.map(([k]) => k);
  return Number(db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, ${cols.join(', ')},
      residual_level, decision, prepared_by)
    VALUES (?, ?, ?, 'draft', ${cols.map(() => '?').join(', ')}, ?, ?, ?)`).run(ws.id, system.id, next, ...carry,
    prev ? prev.residual_level : null, null, actorId).lastInsertRowid);
}

function assessmentInput(body) {
  const values = {};
  for (const [key] of IA_FIELDS) values[key] = clean(body[key], 8000);
  values.residual_level = pick(body.residual_level, RESIDUAL, null);
  values.decision = pick(body.decision, DECISIONS, null);
  return values;
}

function saveAssessment(db, ws, actorId, systemId, iaId, body) {
  const ia = loadAssessment(db, ws, systemId, iaId);
  if (!ia) throw new RegisterError('Impact assessment not found.', 404);
  if (ia.status !== 'draft') throw new RegisterError('This assessment is approved and frozen. Start a new version to reassess.', 409);
  if (Number(body.version) !== Number(ia.version)) throw new RegisterError('This assessment was changed in another session. Refresh and try again.', 409);
  const v = assessmentInput(body);
  const cols = [...IA_FIELDS.map(([k]) => k), 'residual_level', 'decision'];
  db.prepare(`UPDATE ai_impact_assessments SET ${cols.map(c => `${c}=?`).join(', ')}, prepared_by=?,
      updated_at=datetime('now'), version=version+1 WHERE id=? AND version=?`).run(...cols.map(c => v[c]), actorId, ia.id, ia.version);
}

function contentHash(ia) {
  const content = Object.fromEntries([...IA_FIELDS.map(([k]) => k), 'residual_level', 'decision', 'ai_system_id', 'version_no'].map(k => [k, ia[k] ?? null]));
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function approveAssessment(db, ws, actorId, systemId, iaId, body) {
  const ia = loadAssessment(db, ws, systemId, iaId);
  if (!ia) throw new RegisterError('Impact assessment not found.', 404);
  if (ia.status !== 'draft') throw new RegisterError('Only a draft can be approved.', 409);
  if (Number(body.version) !== Number(ia.version)) throw new RegisterError('This assessment was changed in another session. Refresh and try again.', 409);
  if (ia.prepared_by && Number(ia.prepared_by) === Number(actorId)) {
    throw new RegisterError('The person who prepared an impact assessment cannot approve it. Ask another reviewer.', 403);
  }
  const missing = ['affected_parties', 'potential_harms', 'mitigations'].filter(k => !ia[k]);
  if (missing.length || !ia.residual_level || !ia.decision) {
    throw new RegisterError('Record who is affected, the potential harms, the measures taken, the residual level and a decision before approval.');
  }
  if (ia.decision === 'proceed_with_conditions' && !ia.conditions) throw new RegisterError('Record the conditions the decision depends on.');
  db.transaction(() => {
    db.prepare("UPDATE ai_impact_assessments SET status='superseded', updated_at=datetime('now') WHERE ai_system_id=? AND status='approved'").run(ia.ai_system_id);
    db.prepare(`UPDATE ai_impact_assessments SET status='approved', approved_by=?, approved_at=datetime('now'), snapshot_hash=?,
      updated_at=datetime('now'), version=version+1 WHERE id=? AND version=?`).run(actorId, contentHash(ia), ia.id, ia.version);
  })();
}

function discardAssessment(db, ws, systemId, iaId) {
  const ia = loadAssessment(db, ws, systemId, iaId);
  if (!ia) throw new RegisterError('Impact assessment not found.', 404);
  if (ia.status !== 'draft') throw new RegisterError('An approved assessment cannot be discarded.', 409);
  db.prepare('DELETE FROM ai_impact_assessments WHERE id=?').run(ia.id);
}

// ---------------------------------------------------------------- populations

// The auditor asks for each population "during the review period". Without a
// recorded period the full register is returned and the export says so.
const POPULATIONS = Object.freeze({
  'ai-systems': { title: 'Newly implemented AI systems', ask: 'population of newly implemented AI systems' },
  'ai-vendors': { title: 'Vendors involved in the AI system lifecycle', ask: 'listing of vendors involved in the AI system lifecycle' },
  'ai-changes': { title: 'Changes that affect an AI system', ask: 'listing of changes that impact the AI system' },
  'ai-incidents': { title: 'Incidents involving an AI system', ask: 'population of incidents for AI systems' },
});

function inPeriod(date, period) {
  if (!date) return !period.start && !period.end;
  const d = String(date).slice(0, 10);
  return (!period.start || d >= period.start) && (!period.end || d <= period.end);
}

function population(db, ws, key, period = {}) {
  const def = POPULATIONS[key];
  if (!def) return null;
  const systems = db.prepare('SELECT * FROM ai_systems WHERE workspace_id=? AND in_scope=1 ORDER BY name').all(ws.id);
  const scoped = !!(period.start || period.end);
  let columns;
  let rows;
  if (key === 'ai-systems') {
    columns = ['AI system', 'Purpose', 'Organisation role', 'Lifecycle stage', 'Go-live date', 'System owner'];
    rows = systems.filter(s => (scoped ? inPeriod(s.go_live_date, period) : true))
      .map(s => [s.name, s.purpose, decodeRoles(s.org_roles).map(r => ROLES[r]).join('; '), LIFECYCLE[s.lifecycle_stage], s.go_live_date, s.system_owner]);
  } else if (key === 'ai-vendors') {
    columns = ['Vendor', 'AI system', 'Lifecycle role', 'Service', 'Assurance held'];
    rows = db.prepare(`SELECT v.*, s.name AS system_name FROM ai_system_suppliers v JOIN ai_systems s ON s.id=v.ai_system_id
      WHERE v.workspace_id=? AND s.in_scope=1 ORDER BY v.supplier_name, s.name`).all(ws.id)
      .map(v => [v.supplier_name, v.system_name, v.lifecycle_role, v.service, v.assurance]);
  } else if (key === 'ai-changes') {
    columns = ['Change', 'Title', 'AI system', 'Status', 'Implemented'];
    rows = db.prepare(`SELECT c.id, c.title, c.status, c.implemented_at, c.created_at, s.name AS system_name
      FROM ai_system_links l JOIN changes c ON c.id=l.target_id AND c.workspace_id=l.workspace_id
      JOIN ai_systems s ON s.id=l.ai_system_id WHERE l.workspace_id=? AND l.link_type='change' AND s.in_scope=1
      ORDER BY COALESCE(c.implemented_at, c.created_at)`).all(ws.id)
      .filter(c => (scoped ? inPeriod(c.implemented_at || c.created_at, period) : true))
      .map(c => [`CHG-${c.id}`, c.title, c.system_name, c.status, c.implemented_at ? String(c.implemented_at).slice(0, 10) : '']);
  } else {
    columns = ['Incident', 'Title', 'AI system', 'Severity', 'Status', 'Detected'];
    rows = db.prepare(`SELECT i.id, i.title, i.severity, i.status, i.detected_at, i.created_at, s.name AS system_name
      FROM ai_system_links l JOIN incidents i ON i.id=l.target_id AND i.workspace_id=l.workspace_id
      JOIN ai_systems s ON s.id=l.ai_system_id WHERE l.workspace_id=? AND l.link_type='incident' AND s.in_scope=1
      ORDER BY COALESCE(i.detected_at, i.created_at)`).all(ws.id)
      .filter(i => (scoped ? inPeriod(i.detected_at || i.created_at, period) : true))
      .map(i => [`INC-${i.id}`, i.title, i.system_name, i.severity, i.status, String(i.detected_at || i.created_at || '').slice(0, 10)]);
  }
  return { key, ...def, columns, rows: rows.map(r => r.map(v => (v == null ? '' : String(v)))), scoped, period };
}

function populationCsv(pop) {
  const esc = v => {
    const s = String(v == null ? '' : v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const scope = pop.scoped
    ? `Review period ${pop.period.start || 'start of records'} to ${pop.period.end || 'today'}`
    : 'No review period recorded; the full register is listed';
  return [[pop.title], [scope], [], pop.columns, ...pop.rows].map(r => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

// Which request on the certification body's list each population answers,
// matched on the auditor's own wording so a renumbered list still lines up.
function populationForRequest(description) {
  const text = String(description || '').toLowerCase();
  if (/\bvendors?\b/.test(text) && /\bai\b/.test(text)) return 'ai-vendors';
  if (/\bchanges?\b/.test(text) && /\bai systems?\b/.test(text)) return 'ai-changes';
  if (/\bincidents?\b/.test(text) && /\bai\b/.test(text)) return 'ai-incidents';
  if (/\bai systems?\b/.test(text) && /(newly implemented|population of)/.test(text)) return 'ai-systems';
  return null;
}

module.exports = {
  RegisterError, ROLES, LIFECYCLE, AUTOMATION, RESIDUAL, DECISIONS, IA_FIELDS, POPULATIONS,
  list, load, detail, create, update, addSupplier, removeSupplier, link, unlink,
  startAssessment, saveAssessment, approveAssessment, discardAssessment, loadAssessment, contentHash,
  population, populationCsv, populationForRequest,
};
