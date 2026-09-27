'use strict';
// The organisation's context for its AI management system: the internal and
// external issues that shape it (clause 4.1) and the interested parties with
// their requirements, marked where they are legal, regulatory or contractual
// obligations (clause 4.2). Both were free text in the intake and a template;
// an auditor samples them as records (migration 073).

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
const keyed = (list) => Object.fromEntries(list.map((x) => [x.key, x.label]));
const ISSUE_LABEL = keyed(ISSUE_KINDS);
const PARTY_LABEL = keyed(PARTY_TYPES);
const REQUIREMENT_LABEL = keyed(REQUIREMENT_KINDS);

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
  const today = new Date().toISOString().slice(0, 10);
  return {
    issues,
    parties,
    obligations: parties.filter((p) => ['legal', 'regulatory', 'contractual'].includes(p.requirement_kind)).length,
    overdue: [...issues, ...parties].filter((r) => r.next_review && r.next_review < today).length,
  };
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
  list, saveIssue, deleteIssue, saveParty, deleteParty,
};
