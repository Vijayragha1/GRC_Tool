'use strict';
// Readiness routes. Slice 16 of the server.js modularization: readiness
// page, JSON API, and the pre-cert blocker check. The engine lives in
// lib/readiness.js.

const ctlReads = require('../lib/control-reads');
const { computeReadiness } = require('../lib/readiness');
const { buildWorkspaceTruth } = require('../lib/grc-truth');
const outcomeScope = require('../lib/engagement-outcome-scope');

function register(app, deps) {
  const { db, requireAuth, requireWorkspace } = deps;
  const requireCertificationSupport = outcomeScope.requirePostGapService(
    'Certification readiness is outside this gap-assessment-only engagement. Use Gap assessment and the controlled assessment report instead.');

  app.get('/workspaces/:wsId/readiness', requireAuth, requireWorkspace, requireCertificationSupport, (req, res) => {
    const r = computeReadiness(req.workspace);
    res.render('readiness', { user: req.user, ws: req.workspace, r });
  });

  app.get('/api/workspaces/:wsId/readiness', requireAuth, requireWorkspace, requireCertificationSupport, (req, res) => {
    res.json(computeReadiness(req.workspace));
  });

  app.get('/workspaces/:wsId/data-quality', requireAuth, requireWorkspace, (req, res) => {
    const truth = buildWorkspaceTruth(db, req.workspace);
    const allowedDomains = new Set(truth.domains.map(domain => domain.key));
    const allowedSeverities = new Set(['critical', 'high', 'medium', 'low']);
    const domain = allowedDomains.has(req.query.domain) ? req.query.domain : 'all';
    const severity = allowedSeverities.has(req.query.severity) ? req.query.severity : 'all';
    const issues = truth.issues.filter(issue =>
      (domain === 'all' || issue.domain === domain) &&
      (severity === 'all' || issue.severity === severity));
    res.render('data_quality', { user: req.user, ws: req.workspace, truth, issues, domain, severity });
  });

  app.get('/api/workspaces/:wsId/data-quality', requireAuth, requireWorkspace, (req, res) => {
    res.json(buildWorkspaceTruth(db, req.workspace));
  });

  // Audit-readiness blockers - concrete things the auditor will catch if you ignore them.
  // Distinct from /readiness which is a high-level percentage view.
  app.get('/workspaces/:wsId/readiness/blockers', requireAuth, requireWorkspace, requireCertificationSupport, (req, res) => {
    const wsId = req.workspace.id;
    const blockers = [];
    const T = ctlReads.tables(db, wsId);

    // 1. Controls marked Implemented but no evidence files attached
    const implNoEvidence = db.prepare(`
      SELECT i.id, i.title FROM iso_items i
      INNER JOIN ${T.cs} cs ON cs.iso_item_id = i.id
      WHERE i.type='control' AND cs.workspace_id=? AND cs.status='Implemented'
        AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
      ORDER BY i.sort_order`).all(wsId, wsId);
    if (implNoEvidence.length) {
      blockers.push({
        severity: 'high',
        title: `${implNoEvidence.length} control${implNoEvidence.length === 1 ? '' : 's'} marked "Implemented" but no evidence attached`,
        detail: 'Auditors will ask for evidence before accepting any "Implemented" claim. Either attach evidence or downgrade the status.',
        items: implNoEvidence.slice(0, 20).map(c => ({ label: c.id.replace('annex-','').toUpperCase() + ' - ' + c.title.replace(/^A\.[0-9.]+ /, ''), link: `/workspaces/${wsId}/controls/${c.id}` }))
      });
    }

    // 2. SoA controls without inclusion or exclusion justification
    const soaUnjustified = db.prepare(`
      SELECT i.id, i.title, COALESCE(cs.applicability,'undecided') AS applicability FROM iso_items i
      LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id=?
      WHERE i.type='control' AND (
        (cs.applicability='included' AND (cs.inclusion_justification IS NULL OR cs.inclusion_justification=''))
        OR (cs.applicability='excluded' AND (cs.exclusion_justification IS NULL OR cs.exclusion_justification=''))
        OR cs.applicability IS NULL OR cs.applicability='undecided'
      )
      ORDER BY i.sort_order`).all(wsId);
    if (soaUnjustified.length) {
      blockers.push({
        severity: 'high',
        title: `${soaUnjustified.length} SoA entr${soaUnjustified.length === 1 ? 'y' : 'ies'} without applicability decision or justification`,
        detail: 'Clause 6.1.3 d requires the SoA to state inclusion/exclusion AND justify each. Empty justifications fail at Stage 1.',
        items: soaUnjustified.slice(0, 20).map(c => ({ label: c.id.replace('annex-','').toUpperCase() + ' - ' + c.title.replace(/^A\.[0-9.]+ /, '') + ' (' + c.applicability + ')', link: `/workspaces/${wsId}/soa` }))
      });
    }

    // 3. Approved documents without next_review_date set or overdue
    const docReviewIssues = db.prepare(`
      SELECT id, name, next_review_date FROM generated_docs
      WHERE workspace_id=? AND status IN ('approved','published')
        AND (next_review_date IS NULL OR next_review_date < date('now'))
      ORDER BY next_review_date IS NULL, next_review_date`).all(wsId);
    if (docReviewIssues.length) {
      blockers.push({
        severity: 'medium',
        title: `${docReviewIssues.length} approved document${docReviewIssues.length === 1 ? '' : 's'} without a future review date`,
        detail: 'Clause 7.5.3 expects documented information to be reviewed at planned intervals. Missing or past-due review dates suggest stale documentation.',
        items: docReviewIssues.slice(0, 20).map(d => ({ label: d.name + (d.next_review_date ? ` · review was due ${d.next_review_date}` : ' · no review date set'), link: `/workspaces/${wsId}/documents/${d.id}` }))
      });
    }

    // 4. Open / overdue NCs
    const overdueNcs = db.prepare(`
      SELECT id, title, due_date, severity FROM nonconformities
      WHERE workspace_id=? AND status NOT IN ('closed','verified')
        AND due_date IS NOT NULL AND due_date < date('now')
      ORDER BY due_date`).all(wsId);
    if (overdueNcs.length) {
      blockers.push({
        severity: 'high',
        title: `${overdueNcs.length} nonconformity${overdueNcs.length === 1 ? '' : 'ies'} overdue`,
        detail: 'Clause 10.1 requires corrective action without undue delay. Overdue NCs at cert audit get raised as new findings.',
        items: overdueNcs.map(n => ({ label: `${n.title} · due ${n.due_date} · ${n.severity}`, link: `/workspaces/${wsId}/nonconformities/${n.id}` }))
      });
    }

    // 5. No internal audit run in the last 12 months
    const recentAudit = db.prepare(`SELECT COUNT(*) c FROM audits
      WHERE workspace_id=? AND audit_date >= date('now','-12 months') AND status='complete'`).get(wsId).c;
    if (recentAudit === 0) {
      blockers.push({
        severity: 'high',
        title: 'No completed internal audit in the last 12 months',
        detail: 'Clause 9.2 mandates internal audit at planned intervals. A first-year ISMS needs at least one full internal audit before stage 2.',
        items: [{ label: 'Schedule and complete an internal audit', link: `/workspaces/${wsId}/audits` }]
      });
    }

    // 6. No completed MRM in the last 12 months
    const recentMrm = db.prepare(`SELECT COUNT(*) c FROM mrms
      WHERE workspace_id=? AND meeting_date >= date('now','-12 months') AND status='complete'`).get(wsId).c;
    if (recentMrm === 0) {
      blockers.push({
        severity: 'high',
        title: 'No completed management review in the last 12 months',
        detail: 'Clause 9.3 requires top management to review the ISMS at planned intervals. Missing this is a stage-2 fail.',
        items: [{ label: 'Schedule and complete an MRM', link: `/workspaces/${wsId}/mrms` }]
      });
    }

    // 7. Risks at "Open" status with no treatment recorded
    const openUntreated = db.prepare(`SELECT id, title FROM risks
      WHERE workspace_id=? AND status='open' AND (treatment IS NULL OR treatment='' OR treatment='untreated')
      ORDER BY (likelihood * impact) DESC LIMIT 30`).all(wsId);
    if (openUntreated.length) {
      blockers.push({
        severity: 'medium',
        title: `${openUntreated.length} open risk${openUntreated.length === 1 ? '' : 's'} with no treatment selected`,
        detail: 'Clause 6.1.3 requires a risk treatment option (modify / accept / avoid / transfer) for each risk above appetite.',
        items: openUntreated.slice(0, 20).map(r => ({ label: r.title, link: `/workspaces/${wsId}/risks/${r.id}` }))
      });
    }

    // 8. Suppliers with no review in the last 12 months
    const overdueSuppliers = db.prepare(`SELECT s.id, s.name FROM suppliers s
      WHERE s.workspace_id=? AND s.lifecycle_stage NOT IN ('terminated')
        AND NOT EXISTS (SELECT 1 FROM supplier_reviews sr WHERE sr.supplier_id=s.id AND sr.review_date >= date('now','-12 months'))
      ORDER BY s.name`).all(wsId);
    if (overdueSuppliers.length) {
      blockers.push({
        severity: 'medium',
        title: `${overdueSuppliers.length} supplier${overdueSuppliers.length === 1 ? '' : 's'} not reviewed in the last 12 months`,
        detail: 'A.5.19 / A.5.22 expects periodic supplier risk review. Long gaps suggest supplier management is on paper only.',
        items: overdueSuppliers.slice(0, 20).map(s => ({ label: s.name, link: `/workspaces/${wsId}/vendors/${s.id}` }))
      });
    }

    // 9. Clauses or Annex A controls Not Assessed at all
    const notAssessedRow = db.prepare(`SELECT
      SUM(CASE WHEN i.type='clause' AND (cs.status IS NULL OR cs.status='Not Assessed') THEN 1 ELSE 0 END) AS clauses,
      SUM(CASE WHEN i.type='control' AND (cs.status IS NULL OR cs.status='Not Assessed') THEN 1 ELSE 0 END) AS controls
      FROM iso_items i LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control')`).get(wsId);
    const notAssessed = (notAssessedRow.clauses || 0) + (notAssessedRow.controls || 0);
    if (notAssessed > 0) {
      blockers.push({
        severity: 'high',
        title: `${notAssessed} item${notAssessed === 1 ? '' : 's'} still "Not Assessed" (${notAssessedRow.clauses || 0} clause${(notAssessedRow.clauses||0) === 1 ? '' : 's'} · ${notAssessedRow.controls || 0} control${(notAssessedRow.controls||0) === 1 ? '' : 's'})`,
        detail: 'Every main-body clause AND every Annex A control needs a status - even Not Applicable. Clauses 4–10 are the "shall" requirements; Annex A entries also need an applicability decision. Run the gap assessment wizard to clear this in one pass.',
        items: [{ label: '→ Run gap assessment', link: `/workspaces/${wsId}/gap-assessment` }]
      });
    }

    // 10. No risks at all
    const riskTotal = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(wsId).c;
    if (riskTotal === 0) {
      blockers.push({
        severity: 'high',
        title: 'No risks in the register',
        detail: 'Clause 6.1.2 requires a risk assessment process to identify, analyze, and evaluate risks. An empty register is a hard fail.',
        items: [{ label: '→ Add starter risks from library', link: `/workspaces/${wsId}/risks/library` }]
      });
    }

    const high = blockers.filter(b => b.severity === 'high').length;
    const med = blockers.filter(b => b.severity === 'medium').length;
    res.render('readiness_blockers', { user: req.user, ws: req.workspace, blockers, high, med });
  });

}

module.exports = { register };
