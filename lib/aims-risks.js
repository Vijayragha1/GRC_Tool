'use strict';
// The AIMS's own risk register (ISO/IEC 42001 clauses 6.1.2, 6.1.3, 8.2, 8.3).
//
// Since migration 079 the AIMS keeps its own risks, separate from the ISMS's:
// each is owned by ISO 42001, rated against the AIMS's own risk criteria, and
// treated by ISO 42001 controls only. A risk can name the AI system it comes
// from and its source, and carries its consequence for the organisation, for
// individuals or groups and for society; it is scored on the worst of the
// three (lib/ai-risk.js). Treatment actions, acceptance, control links and
// deletion reuse the shared actions, which return here.

const aiRisk = require('./ai-risk');
const riskLinks = require('./risk-control-links');
const { getActiveMethodology, methodologyBand } = require('../db');

class AimsRiskError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const TREATMENTS = Object.freeze({
  modify: 'Reduce it (modify)', retain: 'Keep it (retain)', avoid: 'Stop the activity (avoid)', share: 'Share it (transfer)',
});
const STATUSES = Object.freeze({ open: 'Open', treated: 'Treated', accepted: 'Accepted', closed: 'Closed' });
// Bands above which a risk exceeds the AIMS's risk criteria.
const ABOVE = new Set(['high', 'critical', 'very high', 'extreme']);

const criteria = (ws) => getActiveMethodology(ws.id, 'iso42001');
const clean = (v, max = 4000) => { const t = String(v == null ? '' : v).trim(); return t ? t.slice(0, max) : null; };
const rating = (v, max) => { const n = parseInt(v, 10); return Number.isInteger(n) ? Math.max(1, Math.min(max, n)) : null; };

// Band name for a likelihood and impact on the AIMS's criteria, and a tone for it.
function bandOf(method, likelihood, impact) {
  return likelihood && impact ? String(methodologyBand(method, likelihood, impact) || '') : '';
}
function tone(band, status) {
  if (status === 'closed') return 'na';
  const b = band.toLowerCase();
  if (ABOVE.has(b)) return 'gap';
  if (b === 'medium' || b === 'moderate') return 'part';
  return b ? 'done' : 'open';
}

function register(db, ws) {
  const method = criteria(ws);
  const rows = db.prepare(`SELECT r.*, s.name AS ai_system_name,
      (SELECT COUNT(*) FROM iso42001_risk_controls rc WHERE rc.risk_id=r.id) AS control_count,
      (SELECT COUNT(*) FROM risk_treatment_actions a WHERE a.risk_id=r.id AND a.status != 'done') AS open_actions
    FROM risks r LEFT JOIN ai_systems s ON s.id=r.ai_system_id AND s.workspace_id=r.workspace_id
    WHERE r.workspace_id=? AND r.management_system='iso42001'
    ORDER BY CASE r.status WHEN 'closed' THEN 1 ELSE 0 END, (r.likelihood * r.impact) DESC, r.id`).all(ws.id)
    .map((r) => {
      const band = bandOf(method, r.likelihood, r.impact);
      const residual = bandOf(method, r.residual_likelihood, r.residual_impact);
      return { ...r, band, residualBand: residual, tone: tone(residual || band, r.status), above: ABOVE.has((residual || band).toLowerCase()) };
    });
  const live = rows.filter((r) => r.status !== 'closed');
  return {
    method, rows,
    counts: {
      open: live.length,
      above: live.filter((r) => r.above && r.status !== 'accepted').length,
      untreated: live.filter((r) => r.treatment === 'modify' && !r.control_count && !r.open_actions && r.status === 'open').length,
      withoutSystem: live.filter((r) => !r.ai_system_id).length,
    },
  };
}

function input(ws, body, method) {
  const title = clean(body.title, 300);
  if (!title) throw new AimsRiskError('Name the risk.');
  const lMax = method.likelihood_scale.length;
  const iMax = method.impact_scale.length;
  const likelihood = rating(body.likelihood, lMax);
  const impact = rating(body.impact, iMax);
  if (!likelihood || !impact) throw new AimsRiskError('Rate the likelihood and the impact on the organisation.');
  return {
    title, likelihood, impact,
    description: clean(body.description),
    threat: clean(body.threat, 1000),
    vulnerability: clean(body.vulnerability, 1000),
    treatment: TREATMENTS[body.treatment] ? body.treatment : 'modify',
    owner_name: clean(body.owner_name, 200),
    status: STATUSES[body.status] ? body.status : 'open',
    residual_likelihood: rating(body.residual_likelihood, lMax),
    residual_impact: rating(body.residual_impact, iMax),
  };
}

function create(db, ws, body) {
  const method = criteria(ws);
  const v = input(ws, body, method);
  const id = Number(db.prepare(`INSERT INTO risks (workspace_id, title, description, threat, vulnerability, likelihood, impact,
      treatment, owner_name, status, residual_likelihood, residual_impact, management_system)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'iso42001')`).run(ws.id, v.title, v.description, v.threat, v.vulnerability,
    v.likelihood, v.impact, v.treatment, v.owner_name, v.residual_likelihood, v.residual_impact).lastInsertRowid);
  aiRisk.apply(db, ws, id, body, { impactMax: method.impact_scale.length, organisationImpact: v.impact });
  return id;
}

function load(db, ws, id) {
  return db.prepare(`SELECT * FROM risks WHERE id=? AND workspace_id=? AND management_system='iso42001'`).get(Number(id), ws.id) || null;
}

function update(db, ws, id, body) {
  const risk = load(db, ws, id);
  if (!risk) throw new AimsRiskError('That AI risk was not found.', 404);
  const method = criteria(ws);
  const v = input(ws, body, method);
  db.prepare(`UPDATE risks SET title=?, description=?, threat=?, vulnerability=?, likelihood=?, treatment=?, owner_name=?, status=?,
      residual_likelihood=?, residual_impact=? WHERE id=? AND workspace_id=?`).run(v.title, v.description, v.threat, v.vulnerability,
    v.likelihood, v.treatment, v.owner_name, v.status, v.residual_likelihood, v.residual_impact, risk.id, ws.id);
  aiRisk.apply(db, ws, risk.id, body, { impactMax: method.impact_scale.length, organisationImpact: v.impact });
}

function detail(db, ws, id) {
  const risk = load(db, ws, id);
  if (!risk) return null;
  const method = criteria(ws);
  const system = risk.ai_system_id ? db.prepare('SELECT id, name FROM ai_systems WHERE id=? AND workspace_id=?').get(risk.ai_system_id, ws.id) : null;
  const band = bandOf(method, risk.likelihood, risk.impact);
  const residualBand = bandOf(method, risk.residual_likelihood, risk.residual_impact);
  return {
    risk, method, system, band, residualBand, tone: tone(residualBand || band, risk.status),
    controls: riskLinks.linked(db, ws, risk.id),
    controlGroups: riskLinks.pickerGroups(db, ws, risk.id),
    actions: db.prepare(`SELECT * FROM risk_treatment_actions WHERE risk_id=? AND workspace_id=?
      ORDER BY (CASE status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`).all(risk.id, ws.id),
    acceptance: db.prepare('SELECT * FROM risk_acceptances WHERE risk_id=? AND revoked_at IS NULL ORDER BY signed_at DESC LIMIT 1').get(risk.id) || null,
  };
}

// Is a band above the AIMS's risk criteria.
const aboveCriteria = (method, r) => ABOVE.has(bandOf(method, r.likelihood, r.impact).toLowerCase());

module.exports = { AimsRiskError, TREATMENTS, STATUSES, criteria, register, create, load, update, detail, bandOf, aboveCriteria };
