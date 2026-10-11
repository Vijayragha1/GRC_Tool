'use strict';
// AI risk assessment on the shared risk register (migration 071).
//
// A risk can name the AI system it concerns and the kind of source it comes
// from, and carries three impact ratings on the workspace's impact scale: for
// the organisation, for individuals or groups, and for society. The stored
// `impact` is the highest of them, so scores, bands, heat maps and exports that
// read `impact` rank an AI risk by its worst consequence; `impact_organisation`
// keeps the organisational rating that was entered. A risk with no individual
// or societal rating behaves exactly as before.
//
// Each time the consultant performs the risk assessment, the register is
// recorded as a sealed snapshot (risk_assessment_records), which is the
// retained result the standard asks for, and the date the next one is due.
//
// Since migration 079 an AI risk is a risk the AIMS owns
// (risks.management_system='iso42001'), not one inferred from its fields. A
// record's scope 'ai' is the AIMS's register; 'all' is the client's primary
// register, which is the ISMS's on a client with both systems.

const crypto = require('crypto');
const riskOwner = require('./risk-owner');

// Where an AI risk comes from. The consultant's own categories, drawn from the
// kinds of source the standard's annexes discuss; not the standard's text.
const RISK_SOURCES = Object.freeze([
  ['data', 'Data: quality, bias, provenance or rights'],
  ['model', 'Model behaviour and machine learning'],
  ['automation', 'Level of automation and human oversight'],
  ['transparency', 'Transparency and explainability'],
  ['lifecycle', 'Design, change and retirement of the system'],
  ['environment', 'Complexity of the operating environment'],
  ['technology', 'Maturity of the technology'],
  ['hardware', 'Hardware and compute'],
  ['third_party', 'Suppliers and third-party models'],
  ['misuse', 'Misuse or use outside the intended purpose'],
  ['security', 'Attacks on the AI system'],
  ['legal', 'Laws, contracts and obligations'],
].map(([key, label]) => Object.freeze({ key, label })));
const SOURCE_LABEL = Object.fromEntries(RISK_SOURCES.map((s) => [s.key, s.label]));

const REVIEW_MONTHS = 12;

// Whether the shared risk register takes AI fields: only on a client whose
// only management system is ISO 42001. On a client with both, the shared
// register is the ISMS's and AI risks are kept in the ISO 42001 module.
function enabled(workspace) {
  return riskOwner.aimsOnly(workspace);
}

const has = (body, key) => Object.prototype.hasOwnProperty.call(body || {}, key);
function rating(value, max) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? Math.max(1, Math.min(max, n)) : null;
}
function isoDate(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
}

// The AI fields a risk form sent, validated against the workspace. Only keys
// the form carried are returned, so a form without them leaves them alone.
function fields(db, workspace, body, impactMax) {
  const out = {};
  if (has(body, 'ai_system_id')) {
    const id = parseInt(body.ai_system_id, 10);
    out.ai_system_id = id && db.prepare('SELECT 1 FROM ai_systems WHERE id=? AND workspace_id=?').get(id, workspace.id) ? id : null;
  }
  if (has(body, 'risk_source')) out.risk_source = SOURCE_LABEL[body.risk_source] ? body.risk_source : null;
  if (has(body, 'impact_individuals')) out.impact_individuals = rating(body.impact_individuals, impactMax);
  if (has(body, 'impact_society')) out.impact_society = rating(body.impact_society, impactMax);
  if (has(body, 'next_review_date')) out.next_review_date = isoDate(body.next_review_date);
  return out;
}

// Write the AI fields and the resulting impact for a risk just created or
// edited. `organisationImpact` is the impact the form entered.
function apply(db, workspace, riskId, body, { impactMax, organisationImpact }) {
  const f = fields(db, workspace, body, impactMax);
  const current = db.prepare('SELECT impact_individuals, impact_society FROM risks WHERE id=? AND workspace_id=?').get(riskId, workspace.id);
  if (!current) return;
  const individuals = has(f, 'impact_individuals') ? f.impact_individuals : current.impact_individuals;
  const society = has(f, 'impact_society') ? f.impact_society : current.impact_society;
  const org = rating(organisationImpact, impactMax);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(f)) { sets.push(`${k}=?`); vals.push(v); }
  if (org != null) {
    sets.push('impact_organisation=?', 'impact=?');
    vals.push(org, Math.max(org, individuals || 0, society || 0));
  }
  if (!sets.length) return;
  db.prepare(`UPDATE risks SET ${sets.join(', ')} WHERE id=? AND workspace_id=?`).run(...vals, riskId, workspace.id);
}

// The AI risks of a workspace: those the AIMS owns.
function isAiRiskSql(alias = 'r') {
  return riskOwner.ownedSql(alias, 'iso42001');
}

// The management system a record scope covers on this client.
const scopeSystem = (workspace, scope) => (scope === 'ai' ? 'iso42001' : riskOwner.primary(workspace));

function snapshotRows(db, workspace, scope) {
  const risks = db.prepare(`SELECT r.*, s.name AS ai_system_name FROM risks r
    LEFT JOIN ai_systems s ON s.id = r.ai_system_id AND s.workspace_id = r.workspace_id
    WHERE r.workspace_id=? AND ${riskOwner.ownedSql('r', scopeSystem(workspace, scope))}
    ORDER BY (r.likelihood * r.impact) DESC, r.id`).all(workspace.id);
  const controls = (table, catalogue, riskId) => db.prepare(`SELECT i.id, i.title FROM ${table} rc JOIN ${catalogue} i ON i.id = rc.iso_item_id WHERE rc.risk_id=? ORDER BY i.sort_order`).all(riskId);
  return risks.map((r) => ({
    id: r.id, title: r.title, description: r.description || null, ai_system: r.ai_system_name || null, risk_source: r.risk_source || null,
    likelihood: r.likelihood, impact: r.impact, impact_organisation: r.impact_organisation,
    impact_individuals: r.impact_individuals, impact_society: r.impact_society,
    treatment: r.treatment, owner: r.owner_name, status: r.status,
    residual_likelihood: r.residual_likelihood, residual_impact: r.residual_impact,
    controls: [...controls('risk_controls', 'iso_items', r.id), ...controls('iso42001_risk_controls', 'iso42001_items', r.id)].map((c) => c.title),
  }));
}

const hash = (payload) => crypto.createHash('sha256').update(payload).digest('hex');

// Record the risk assessment as performed today (or on `performed_on`).
// `aboveAppetite(risk)` decides which risks exceed the methodology's appetite.
function record(db, workspace, actorId, input, { methodologyName, aboveAppetite }) {
  const scope = input.scope === 'ai' ? 'ai' : 'all';
  const performedOn = isoDate(input.performed_on) || new Date().toISOString().slice(0, 10);
  const rows = snapshotRows(db, workspace, scope);
  const payload = JSON.stringify(rows);
  const label = String(input.label || '').trim().slice(0, 200)
    || `${scope === 'ai' ? 'AI risk assessment' : 'Risk assessment'} ${performedOn}`;
  const above = rows.filter((r) => (aboveAppetite ? aboveAppetite(r) : r.likelihood * r.impact >= 15)).length;
  return Number(db.prepare(`INSERT INTO risk_assessment_records
      (workspace_id, scope, label, performed_on, methodology_name, notes, risk_count, above_appetite, payload, payload_hash, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(workspace.id, scope, label, performedOn, methodologyName || null, String(input.notes || '').trim().slice(0, 4000) || null,
      rows.length, above, payload, hash(payload), actorId).lastInsertRowid);
}

// Records of one system's risk assessments, or all when none is named. On a
// client with one system every record is that system's, whatever its scope.
function systemRecordSql(workspace, system) {
  if (!system || !riskOwner.hasBoth(workspace)) return '';
  return system === 'iso42001' ? ` AND r.scope='ai'` : ` AND r.scope='all'`;
}

function records(db, workspace, system = null) {
  return db.prepare(`SELECT r.id, r.scope, r.label, r.performed_on, r.methodology_name, r.risk_count, r.above_appetite, r.created_at, u.name AS recorded_by_name
    FROM risk_assessment_records r LEFT JOIN users u ON u.id = r.recorded_by
    WHERE r.workspace_id=?${systemRecordSql(workspace, system)} ORDER BY r.performed_on DESC, r.id DESC`).all(workspace.id);
}

// One record, or null. Naming a system refuses the other system's records on
// a client with both.
function loadRecord(db, workspace, id, system = null) {
  const row = db.prepare(`SELECT r.*, u.name AS recorded_by_name FROM risk_assessment_records r LEFT JOIN users u ON u.id = r.recorded_by
    WHERE r.id=? AND r.workspace_id=?${systemRecordSql(workspace, system)}`).get(id, workspace.id);
  if (!row) return null;
  return { ...row, rows: JSON.parse(row.payload), intact: hash(row.payload) === row.payload_hash };
}

function addMonths(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// When a system's next assessment is due: twelve months after its last one,
// or now if none has been recorded.
function nextDue(db, workspace, system = null) {
  const last = db.prepare(`SELECT MAX(performed_on) d FROM risk_assessment_records r WHERE r.workspace_id=?${systemRecordSql(workspace, system)}`).get(workspace.id).d;
  const due = last ? addMonths(last, REVIEW_MONTHS) : null;
  if (!last || system !== 'iso42001') return { last: last || null, due };
  // Clause 8.2: a significant change to an AI system since the last
  // assessment, or one not yet judged, brings the next one forward
  // (lib/aims-operations.js).
  const change = db.prepare(`SELECT c.title, date(c.created_at) AS d FROM changes c
    WHERE c.workspace_id=? AND COALESCE(c.significant, 1) <> 0 AND date(c.created_at) > ?
      AND EXISTS (SELECT 1 FROM ai_system_links l WHERE l.workspace_id=c.workspace_id AND l.link_type='change' AND l.target_id=c.id)
    ORDER BY c.created_at LIMIT 1`).get(workspace.id, last);
  if (change && change.d < due) return { last, due: change.d, reason: `Significant change "${change.title}" since the last assessment` };
  return { last, due };
}

module.exports = { RISK_SOURCES, SOURCE_LABEL, REVIEW_MONTHS, enabled, fields, apply, isAiRiskSql, scopeSystem, record, records, loadRecord, nextDue, snapshotRows };
