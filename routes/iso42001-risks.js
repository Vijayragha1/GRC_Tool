'use strict';
// ISO 42001 module: the AIMS's own risk register and risk criteria.
//
// The register, each risk's page and the record of each risk assessment live
// here (lib/aims-risks.js). Treatment actions, acceptance, control links,
// deletion and the risk criteria editor reuse the shared actions, whose forms
// on these pages carry a return_to inside the module (lib/module-return.js).
// A client without ISO 42001 never reaches these paths: requireWorkspace
// refuses every /iso42001 page for it.

const aimsRisks = require('../lib/aims-risks');
const aiRisk = require('../lib/ai-risk');
const aiSystems = require('../lib/ai-systems');
const fts = require('../lib/fts');
const { getActiveMethodology, methodologyBand } = require('../db');
const { withToast, auditCtx } = require('../lib/http-helpers');

// 2026-11-13 -> "13 Nov 2026". Accepts a date or a SQLite datetime.
function fmtDate(value) {
  const iso = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction }) {
  const base = (req) => `/workspaces/${req.workspace.id}/iso42001/risks`;
  const riskPage = (req, id) => `${base(req)}/${encodeURIComponent(id)}`;

  function perms(res) {
    const p = res.locals.userPerms;
    const has = (perm) => (p instanceof Set ? p.has(perm) : Array.isArray(p) ? p.includes(perm) : !!(p && p[perm]));
    return { create: has('risk.create'), update: has('risk.update'), remove: has('risk.delete'), criteria: has('risk.methodology') };
  }

  function render(res, req, viewName, locals) {
    res.render(viewName, { user: req.user, ws: req.workspace, active: 'iso42001-risks', base: base(req), riskPerms: perms(res), fmtDate,
      sourceLabel: aiRisk.SOURCE_LABEL, R: aimsRisks, ...locals });
  }

  // Domain errors go back where the form came from, as an error toast.
  const handle = (fn, back) => (req, res, next) => {
    try { return fn(req, res, next); } catch (e) {
      if (e instanceof aimsRisks.AimsRiskError) {
        if (e.status === 404) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: e.message });
        return res.redirect(withToast(back(req), e.message, 'error'));
      }
      return next(e);
    }
  };

  const formLocals = (req) => ({
    systems: aiSystems.list(db, req.workspace).map((s) => ({ id: s.id, name: s.name })),
    sources: aiRisk.RISK_SOURCES,
  });

  app.get('/workspaces/:wsId/iso42001/risks', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    render(res, req, 'iso42001_risks', {
      title: 'AI risk register', register: aimsRisks.register(db, req.workspace), ...formLocals(req),
      records: aiRisk.records(db, req.workspace, 'iso42001').slice(0, 5), due: aiRisk.nextDue(db, req.workspace, 'iso42001'),
      today: new Date().toISOString().slice(0, 10),
    });
  });

  app.post('/workspaces/:wsId/iso42001/risks', requireAuth, requireWorkspace, requirePermission('risk.create'), handle((req, res) => {
    const id = aimsRisks.create(db, req.workspace, req.body);
    fts.refresh(req.workspace.id, 'risk', id);
    logAction(req.user.id, req.workspace.id, 'create_risk', 'risk', id, { title: req.body.title, management_system: 'iso42001' }, auditCtx(req));
    res.redirect(withToast(riskPage(req, id), 'AI risk added'));
  }, base));

  // Record the AIMS's risk assessment as performed: a sealed snapshot of the
  // AIMS register (clause 8.2), rated on the AIMS's risk criteria.
  app.post('/workspaces/:wsId/iso42001/risks/assessments', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
    const method = getActiveMethodology(req.workspace.id, 'iso42001');
    const id = aiRisk.record(db, req.workspace, req.user.id, { ...req.body, scope: 'ai' },
      { methodologyName: method.name, aboveAppetite: (r) => aimsRisks.aboveCriteria(method, r) });
    logAction(req.user.id, req.workspace.id, 'record_risk_assessment', 'risk_assessment_record', id, { scope: 'ai' }, auditCtx(req));
    res.redirect(withToast(`${base(req)}/assessments/${id}`, 'AI risk assessment recorded'));
  });

  app.get('/workspaces/:wsId/iso42001/risks/assessments/:recordId(\\d+)', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    const record = aiRisk.loadRecord(db, req.workspace, Number(req.params.recordId));
    if (!record) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'That risk assessment record was not found.' });
    render(res, req, 'risk_assessment_record', { title: record.label, record, inModule: true });
  });

  // The AIMS's risk criteria (clause 6.1.1): the shared method editor, on the
  // AIMS's own method, returning here.
  app.get('/workspaces/:wsId/iso42001/risks/criteria', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    const method = getActiveMethodology(req.workspace.id, 'iso42001');
    const all = db.prepare(`SELECT id, name, description, is_active, updated_at FROM risk_methodologies
      WHERE workspace_id=? AND management_system='iso42001' ORDER BY is_active DESC, name`).all(req.workspace.id);
    render(res, req, 'risk_methodology', { title: 'AI risk criteria', methodology: method, all, standard: 'iso42001',
      bothSystems: false, returnTo: `${base(req)}/criteria`, inModule: true });
  });

  app.get('/workspaces/:wsId/iso42001/risks/:id(\\d+)', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
    const detail = aimsRisks.detail(db, req.workspace, req.params.id);
    if (!detail) return res.status(404).render('error', { user: req.user, ws: req.workspace, message: 'That AI risk was not found.' });
    render(res, req, 'iso42001_risk_detail', { title: detail.risk.title, ...detail, ...formLocals(req), edit: req.query.edit === '1',
      band: detail.band, methodologyBand, today: new Date().toISOString().slice(0, 10) });
  });

  app.post('/workspaces/:wsId/iso42001/risks/:id(\\d+)', requireAuth, requireWorkspace, requirePermission('risk.update'), handle((req, res) => {
    aimsRisks.update(db, req.workspace, req.params.id, req.body);
    fts.refresh(req.workspace.id, 'risk', Number(req.params.id));
    logAction(req.user.id, req.workspace.id, 'update_risk', 'risk', Number(req.params.id), { management_system: 'iso42001' }, auditCtx(req));
    res.redirect(withToast(riskPage(req, req.params.id), 'Saved'));
  }, (req) => `${riskPage(req, req.params.id)}?edit=1`));
}

module.exports = { register };
