'use strict';
// Management review inputs for an AI management system.
//
// The management review pack (routes/governance.js compute932InputPack)
// pre-fills its inputs from the records every management system shares:
// audits, nonconformities, risks, incidents, improvements. For a client
// working to ISO 42001 that left out everything specific to AI: how the AI
// system register changed, whether each in-scope system has an approved
// impact assessment, incidents and changes that touched an AI system, and how
// the AIMS controls and the certification requests stand. This module reads
// those from the tables the ISO 42001 programme already keeps, so the review
// starts from the client's own AI records rather than a blank prompt.

const reqOpts = require('./requirement-options');

const count = (db, sql, ...params) => {
  try { return db.prepare(sql).get(...params).c || 0; } catch (_) { return 0; }
};

// `since` is the date of the last completed review (YYYY-MM-DD), or null for
// the first one, in which case changes are counted over the last 12 months.
function compute(db, workspace, since) {
  if (!reqOpts.enabledCodes(workspace).includes('iso42001')) return null;
  const ws = workspace.id;
  const from = since || new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

  const stages = {};
  try {
    for (const r of db.prepare(`SELECT lifecycle_stage s, COUNT(*) c FROM ai_systems WHERE workspace_id=? AND in_scope=1 GROUP BY lifecycle_stage`).all(ws)) stages[r.s] = r.c;
  } catch (_) {}
  const inScope = Object.values(stages).reduce((a, b) => a + b, 0);

  const systems = {
    inScope,
    inUse: stages.in_use || 0,
    inDevelopment: (stages.in_development || 0) + (stages.planned || 0),
    retired: stages.retired || 0,
    added: count(db, `SELECT COUNT(*) c FROM ai_systems WHERE workspace_id=? AND date(created_at) > ?`, ws, from),
  };

  const live = `s.workspace_id=? AND s.in_scope=1 AND s.lifecycle_stage != 'retired'`;
  const assessments = {
    withApproved: count(db, `SELECT COUNT(*) c FROM ai_systems s WHERE ${live}
      AND EXISTS (SELECT 1 FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id AND ia.status='approved')`, ws),
    without: count(db, `SELECT COUNT(*) c FROM ai_systems s WHERE ${live}
      AND NOT EXISTS (SELECT 1 FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id AND ia.status='approved')`, ws),
    drafts: count(db, `SELECT COUNT(*) c FROM ai_impact_assessments WHERE workspace_id=? AND status='draft'`, ws),
    approvedSince: count(db, `SELECT COUNT(*) c FROM ai_impact_assessments WHERE workspace_id=? AND status='approved' AND date(approved_at) > ?`, ws, from),
    older: count(db, `SELECT COUNT(*) c FROM ai_impact_assessments WHERE workspace_id=? AND status='approved' AND date(approved_at) < date('now','-12 months')`, ws),
  };

  const incidents = {
    since: count(db, `SELECT COUNT(DISTINCT i.id) c FROM incidents i JOIN ai_system_links l ON l.link_type='incident' AND l.target_id=i.id AND l.workspace_id=i.workspace_id
      WHERE i.workspace_id=? AND date(i.created_at) > ?`, ws, from),
    open: count(db, `SELECT COUNT(DISTINCT i.id) c FROM incidents i JOIN ai_system_links l ON l.link_type='incident' AND l.target_id=i.id AND l.workspace_id=i.workspace_id
      WHERE i.workspace_id=? AND i.status NOT IN ('closed','resolved')`, ws),
  };
  const changes = count(db, `SELECT COUNT(DISTINCT c.id) c FROM changes c JOIN ai_system_links l ON l.link_type='change' AND l.target_id=c.id AND l.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND date(c.created_at) > ?`, ws, from);

  const ncs = {
    open: count(db, `SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status NOT IN ('closed','verified')`, ws),
    major: count(db, `SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND severity='major' AND status NOT IN ('closed','verified')`, ws),
  };

  const controls = {
    included: count(db, `SELECT COUNT(*) c FROM v_iso42001_control_states WHERE workspace_id=? AND applicability='included' AND iso_item_id LIKE 'ai-annex-%'`, ws),
    implemented: count(db, `SELECT COUNT(*) c FROM v_iso42001_control_states WHERE workspace_id=? AND applicability='included' AND iso_item_id LIKE 'ai-annex-%' AND status='Implemented'`, ws),
    undecided: count(db, `SELECT COUNT(*) c FROM v_iso42001_control_states WHERE workspace_id=? AND applicability='undecided' AND iso_item_id LIKE 'ai-annex-%'`, ws),
  };

  const open = `workspace_id=? AND withdrawn_at IS NULL AND status != 'not_applicable'`;
  const requests = {
    total: count(db, `SELECT COUNT(*) c FROM aims_audit_requests WHERE ${open}`, ws),
    done: count(db, `SELECT COUNT(*) c FROM aims_audit_requests WHERE ${open} AND status IN ('ready','submitted','accepted')`, ws),
    withClient: count(db, `SELECT COUNT(*) c FROM aims_audit_requests WHERE ${open} AND status='with_client'`, ws),
    followUp: count(db, `SELECT COUNT(*) c FROM aims_audit_requests WHERE ${open} AND status='follow_up'`, ws),
  };

  const aiRisks = count(db, `SELECT COUNT(DISTINCT r.id) c FROM risks r JOIN iso42001_risk_controls rc ON rc.risk_id=r.id
    WHERE r.workspace_id=? AND r.status='open'`, ws);

  return { since, from, systems, assessments, incidents, changes, ncs, controls, requests, aiRisks };
}

// The same figures as text for the review's input fields. Each block is
// appended to the field every management system shares, under its own
// heading, so a client working to both standards sees both.
function text(inputs) {
  if (!inputs) return null;
  const { systems, assessments, incidents, changes, ncs, controls, requests, aiRisks } = inputs;
  const period = inputs.since ? `since the last review (${inputs.since})` : 'in the last 12 months';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return {
    context_changes: `AI management system:\n  AI systems in scope: ${systems.inScope} (${systems.inUse} in use, ${systems.inDevelopment} planned or in development, ${systems.retired} retired)\n  Added to the register ${period}: ${systems.added}\n  Changes affecting an AI system ${period}: ${changes}\n\n[Note changes in the organisation's AI roles, intended uses, AI suppliers, and laws or contracts that bear on AI.]`,
    performance_review: `AI management system:\n  Impact assessments: ${assessments.withApproved} in-scope ${assessments.withApproved === 1 ? 'system has' : 'systems have'} an approved assessment, ${assessments.without} ${assessments.without === 1 ? 'does' : 'do'} not\n  Assessments approved ${period}: ${assessments.approvedSince} · awaiting approval: ${assessments.drafts} · approved over 12 months ago: ${assessments.older}\n  Incidents involving an AI system ${period}: ${incidents.since} (${incidents.open} still open)\n  Nonconformities against ISO 42001 requirements: ${ncs.open} open (${ncs.major} major)\n  Annex A controls included: ${controls.included}, implemented: ${controls.implemented}, applicability undecided: ${controls.undecided}\n  Certification requests: ${requests.done} of ${requests.total} ready or with the auditor · ${requests.withClient} with the client · ${plural(requests.followUp, 'auditor follow-up', 'auditor follow-ups')}\n\n[Add commentary on AI system monitoring results, drift or performance against thresholds, and progress on AI objectives.]`,
    risk_treatment_status: `AI management system:\n  Open risks treated by ISO 42001 controls: ${aiRisks}\n\n[Note the highest AI risks, their treatment, and any residual AI risk accepted by its owner.]`,
  };
}

// Merge the AI blocks into a shared input pack in place.
function mergeInto(pack, inputs) {
  const blocks = text(inputs);
  if (!blocks) return pack;
  for (const [field, block] of Object.entries(blocks)) {
    pack[field] = pack[field] ? `${pack[field]}\n\n${block}` : block;
  }
  pack.aims = inputs;
  return pack;
}

module.exports = { compute, text, mergeInto };
