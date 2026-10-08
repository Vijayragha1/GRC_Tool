'use strict';
// The organisation's context for its AI management system: the internal and
// external issues that shape it (clause 4.1) and the interested parties with
// their requirements, marked where they are legal, regulatory or contractual
// obligations (clause 4.2). Both were free text in the intake and a template;
// an auditor samples them as records (migration 073).
//
// Planning follows from them (migration 075): the recorded decision on
// whether climate change is a relevant issue (clause 4.1), and the risks and
// opportunities for the management system itself, each with the action
// planned and how its effectiveness is judged (clause 6.1.1). These are the
// AIMS's own risks, such as losing the one person who can run an impact
// assessment, not the risks each AI system poses, which sit on the risk
// register.

class ContextError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const ISSUE_KINDS = Object.freeze([
  { key: 'external', label: 'External' },
  { key: 'internal', label: 'Internal' },
]);
const PARTY_TYPES = Object.freeze([
  { key: 'customer', label: 'Customers and users' },
  { key: 'affected', label: 'People affected by AI decisions' },
  { key: 'regulator', label: 'Regulators and authorities' },
  { key: 'employee', label: 'Employees' },
  { key: 'supplier', label: 'Suppliers and model providers' },
  { key: 'partner', label: 'Partners' },
  { key: 'owner', label: 'Owners, board and investors' },
  { key: 'other', label: 'Other' },
]);
const REQUIREMENT_KINDS = Object.freeze([
  { key: 'need', label: 'Need or expectation' },
  { key: 'legal', label: 'Legal obligation' },
  { key: 'regulatory', label: 'Regulatory obligation' },
  { key: 'contractual', label: 'Contractual obligation' },
]);
const RO_KINDS = Object.freeze([
  { key: 'risk', label: 'Risk' },
  { key: 'opportunity', label: 'Opportunity' },
]);
const RO_STATUSES = Object.freeze([
  { key: 'open', label: 'Planned' },
  { key: 'in_progress', label: 'Under way' },
  { key: 'done', label: 'Done' },
]);
const keyed = (list) => Object.fromEntries(list.map((x) => [x.key, x.label]));
const ISSUE_LABEL = keyed(ISSUE_KINDS);
const PARTY_LABEL = keyed(PARTY_TYPES);
const REQUIREMENT_LABEL = keyed(REQUIREMENT_KINDS);
const RO_KIND_LABEL = keyed(RO_KINDS);
const RO_STATUS_LABEL = keyed(RO_STATUSES);

const clean = (v, max = 4000) => (v == null ? null : (String(v).trim().slice(0, max) || null));
function date(v, label) {
  const s = clean(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ContextError(`${label} must be a date (YYYY-MM-DD).`);
  return s;
}

function list(db, workspace) {
  const issues = db.prepare(`SELECT * FROM context_issues WHERE workspace_id=? ORDER BY kind, id`).all(workspace.id);
  const parties = db.prepare(`SELECT * FROM interested_parties WHERE workspace_id=? ORDER BY party_type, party`).all(workspace.id);
  const riskOpps = db.prepare(`SELECT ro.*, c.issue AS issue_text, p.party AS party_name FROM aims_risks_opportunities ro
    LEFT JOIN context_issues c ON c.id = ro.context_issue_id LEFT JOIN interested_parties p ON p.id = ro.interested_party_id
    WHERE ro.workspace_id=? ORDER BY CASE ro.status WHEN 'done' THEN 1 ELSE 0 END, ro.kind, ro.id`).all(workspace.id);
  const climate = db.prepare(`SELECT d.*, u.name AS decided_by_name FROM aims_climate_decision d LEFT JOIN users u ON u.id = d.decided_by
    WHERE d.workspace_id=?`).get(workspace.id) || null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    issues,
    parties,
    riskOpps,
    climate,
    obligations: parties.filter((p) => ['legal', 'regulatory', 'contractual'].includes(p.requirement_kind)).length,
    overdue: [...issues, ...parties].filter((r) => r.next_review && r.next_review < today).length
      + riskOpps.filter((r) => r.status !== 'done' && r.due_date && r.due_date < today).length
      + (climate && climate.next_review && climate.next_review < today ? 1 : 0),
    planned: riskOpps.filter((r) => r.action && r.effectiveness_method).length,
  };
}

// Clause 4.1: whether climate change is a relevant issue. One decision per
// client, with the reasoning; a relevant climate issue is then recorded as an
// issue like any other.
function saveClimate(db, workspace, actorId, body) {
  const relevant = body.relevant === 'yes' || body.relevant === 'no' ? body.relevant : null;
  const rationale = clean(body.rationale, 2000);
  if (!relevant || !rationale) throw new ContextError('Say whether climate change is a relevant issue, and why.');
  db.prepare(`INSERT INTO aims_climate_decision (workspace_id, relevant, rationale, next_review, decided_by, decided_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (workspace_id) DO UPDATE SET relevant=excluded.relevant, rationale=excluded.rationale, next_review=excluded.next_review,
      decided_by=excluded.decided_by, decided_at=excluded.decided_at`)
    .run(workspace.id, relevant, rationale, date(body.next_review, 'Next review'), actorId);
}

// A source picked on the form must be this client's own issue or party.
function ownId(db, table, workspace, value) {
  const id = Number(value);
  if (!value || !Number.isInteger(id)) return null;
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?`).get(id, workspace.id)) {
    throw new ContextError('That source is not in this client\'s context.');
  }
  return id;
}

// Clause 6.1.1: a risk or opportunity for the AIMS, the action planned, how
// the action is built into the AIMS and how its effectiveness is evaluated.
function saveRiskOpp(db, workspace, actorId, id, body) {
  const kind = RO_KIND_LABEL[body.kind] ? body.kind : null;
  const description = clean(body.description, 1000);
  if (!kind || !description) throw new ContextError('Say whether it is a risk or an opportunity, and describe it.');
  const status = RO_STATUS_LABEL[body.status] ? body.status : 'open';
  const effectivenessResult = clean(body.effectiveness_result);
  if (status === 'done' && !effectivenessResult) throw new ContextError('Record how effective the action was before marking it done.');
  const values = [
    kind, description, ownId(db, 'context_issues', workspace, body.context_issue_id), ownId(db, 'interested_parties', workspace, body.interested_party_id),
    clean(body.action), clean(body.integration), clean(body.owner, 200), date(body.due_date, 'Due date'),
    clean(body.effectiveness_method, 1000), effectivenessResult, status,
  ];
  if (id) {
    const r = db.prepare(`UPDATE aims_risks_opportunities SET kind=?, description=?, context_issue_id=?, interested_party_id=?, action=?, integration=?,
      owner=?, due_date=?, effectiveness_method=?, effectiveness_result=?, status=?, updated_at=datetime('now') WHERE id=? AND workspace_id=?`)
      .run(...values, id, workspace.id);
    if (!r.changes) throw new ContextError('That risk or opportunity was not found.', 404);
    return Number(id);
  }
  return Number(db.prepare(`INSERT INTO aims_risks_opportunities (workspace_id, kind, description, context_issue_id, interested_party_id, action, integration,
    owner, due_date, effectiveness_method, effectiveness_result, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(workspace.id, ...values, actorId).lastInsertRowid);
}

function deleteRiskOpp(db, workspace, id) {
  db.prepare('DELETE FROM aims_risks_opportunities WHERE id=? AND workspace_id=?').run(id, workspace.id);
}

function saveIssue(db, workspace, actorId, id, body) {
  const kind = ISSUE_LABEL[body.kind] ? body.kind : null;
  const issue = clean(body.issue, 1000);
  if (!kind || !issue) throw new ContextError('Say whether the issue is internal or external, and describe it.');
  const values = [kind, issue, clean(body.effect), clean(body.response), clean(body.owner, 200), date(body.next_review, 'Next review')];
  if (id) {
    const r = db.prepare(`UPDATE context_issues SET kind=?, issue=?, effect=?, response=?, owner=?, next_review=?, updated_at=datetime('now')
      WHERE id=? AND workspace_id=?`).run(...values, id, workspace.id);
    if (!r.changes) throw new ContextError('That issue was not found.', 404);
    return Number(id);
  }
  return Number(db.prepare(`INSERT INTO context_issues (workspace_id, kind, issue, effect, response, owner, next_review, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(workspace.id, ...values, actorId).lastInsertRowid);
}

function deleteIssue(db, workspace, id) {
  db.prepare('DELETE FROM context_issues WHERE id=? AND workspace_id=?').run(id, workspace.id);
}

function saveParty(db, workspace, id, body) {
  const party = clean(body.party, 300);
  if (!party) throw new ContextError('Name the interested party.');
  const values = [
    party, PARTY_LABEL[body.party_type] ? body.party_type : 'other', clean(body.needs),
    REQUIREMENT_LABEL[body.requirement_kind] ? body.requirement_kind : 'need',
    clean(body.how_addressed), clean(body.owner, 200), date(body.next_review, 'Next review'),
  ];
  if (id) {
    const r = db.prepare(`UPDATE interested_parties SET party=?, party_type=?, needs=?, requirement_kind=?, how_addressed=?, owner=?, next_review=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(...values, id, workspace.id);
    if (!r.changes) throw new ContextError('That interested party was not found.', 404);
    return Number(id);
  }
  return Number(db.prepare(`INSERT INTO interested_parties (workspace_id, party, party_type, needs, requirement_kind, how_addressed, owner, next_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(workspace.id, ...values).lastInsertRowid);
}

function deleteParty(db, workspace, id) {
  db.prepare('DELETE FROM interested_parties WHERE id=? AND workspace_id=?').run(id, workspace.id);
}

module.exports = {
  ContextError, ISSUE_KINDS, PARTY_TYPES, REQUIREMENT_KINDS, ISSUE_LABEL, PARTY_LABEL, REQUIREMENT_LABEL,
  RO_KINDS, RO_STATUSES, RO_KIND_LABEL, RO_STATUS_LABEL,
  list, saveIssue, deleteIssue, saveParty, deleteParty, saveClimate, saveRiskOpp, deleteRiskOpp,
};
