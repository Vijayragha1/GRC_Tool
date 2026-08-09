'use strict';

// Canonical, cross-module quality verdict for a workspace. This deliberately
// contains no workflow automation: it reads existing records, explains the
// decision impact of gaps, and points a human to the authoritative fix.

const { computeReadiness } = require('./readiness');

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const PENALTIES = { critical: 8, high: 4, medium: 2, low: 1 };

function deriveVerdict(readiness) {
  if (readiness.stage2Ready) return { key: 'stage_2_ready', label: 'Stage 2 ready', tone: 'success' };
  if (readiness.stage1Ready) return { key: 'stage_1_ready', label: 'Stage 1 ready', tone: 'success' };
  if ((readiness.totalAssessed || 0) < (readiness.totalSoaItems || 0)) {
    return { key: 'assessment_in_progress', label: 'Assessment in progress', tone: 'warning' };
  }
  return { key: 'not_ready', label: 'Not ready', tone: 'danger' };
}

// Certification readiness and engagement lifecycle answer different questions.
// Readiness is a current hard-gate decision; lifecycle records what has actually
// happened. Keeping both in one projection prevents maturity percentages or an
// internal audit whose title mentions "Stage 1" from being presented as a
// completed certification audit.
function buildWorkspaceStatus(db, ws, suppliedReadiness) {
  const readiness = suppliedReadiness || computeReadiness(ws);
  const verdict = deriveVerdict(readiness);
  const audits = db.prepare(`SELECT title, scope, lifecycle_stage, status, closed_at, audit_date
    FROM audits WHERE workspace_id=? ORDER BY COALESCE(closed_at, audit_date) DESC`).all(ws.id);
  const isDone = audit => !!audit.closed_at || ['closed', 'completed'].includes(String(audit.lifecycle_stage || audit.status || '').toLowerCase());
  const text = audit => `${audit.title || ''} ${audit.scope || ''}`;
  const isInternal = audit => /\binternal\b/i.test(text(audit));
  const externalStage2 = audits.find(audit => isDone(audit) && !isInternal(audit) && /stage[\s_-]?2/i.test(text(audit)));
  const externalStage1 = audits.find(audit => isDone(audit) && !isInternal(audit) && /stage[\s_-]?1/i.test(text(audit)));
  const internal = audits.find(audit => isDone(audit) && isInternal(audit));

  let lifecycle;
  if (externalStage2) {
    const completed = externalStage2.closed_at || externalStage2.audit_date;
    const daysSince = completed ? Math.round((Date.now() - new Date(completed).getTime()) / 86400000) : 0;
    lifecycle = daysSince > 365
      ? { key: 'surveillance', label: 'Surveillance cycle' }
      : { key: 'post_stage_2', label: 'Stage 2 completed' };
  } else if (externalStage1) {
    lifecycle = { key: 'post_stage_1', label: 'Stage 1 completed' };
  } else if (readiness.stage1Ready) {
    lifecycle = { key: 'stage_1_ready', label: 'Ready to schedule Stage 1' };
  } else if (internal) {
    lifecycle = { key: 'internal_audit', label: 'Internal audit completed' };
  } else if ((readiness.totalAssessed || 0) > 0) {
    lifecycle = { key: 'implementing', label: 'Implementation in progress' };
  } else {
    const approvedDocs = db.prepare(`SELECT COUNT(*) c FROM generated_docs
      WHERE workspace_id=? AND status IN ('approved','published')`).get(ws.id).c;
    const intake = db.prepare(`SELECT COUNT(*) c FROM engagement_intake
      WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer)) > 0`).get(ws.id).c;
    lifecycle = approvedDocs >= 8
      ? { key: 'documenting', label: 'Documentation in progress' }
      : intake > 0
        ? { key: 'scoping', label: 'Scoping' }
        : { key: 'new', label: 'New engagement' };
  }

  return {
    verdict,
    lifecycle,
    maturity: { stage1: readiness.stage1 || 0, stage2: readiness.stage2 || 0 },
    gates: {
      stage1Passed: readiness.stage1GatePassed || 0,
      stage1Total: readiness.stage1GateTotal || 0,
      stage2Passed: readiness.stage2GatePassed || 0,
      stage2Total: readiness.stage2GateTotal || 0
    }
  };
}

function qualityScore(issues) {
  const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + (PENALTIES[issue.severity] || 0), 0));
  return {
    score,
    label: score >= 90 ? 'Reliable' : score >= 75 ? 'Needs review' : 'Unreliable',
    tone: score >= 90 ? 'success' : score >= 75 ? 'warning' : 'danger'
  };
}

function workspaceClaimsAdvancedStage(stage) {
  return ['stage_1_ready', 'post_stage_1', 'audit_ready', 'stage_2_ready', 'post_stage_2', 'surveillance', 'certified'].includes(stage);
}

function itemLink(wsId, kind, item) {
  if (['implemented_no_evidence', 'no_owner', 'stale_access_review'].includes(kind)) return `/workspaces/${wsId}/controls/${item.id}`;
  if (['included_no_basis', 'excluded_no_basis', 'undecided_soa'].includes(kind)) return `/workspaces/${wsId}/soa`;
  if (['open_major_ncs', 'overdue_ncs'].includes(kind)) return `/workspaces/${wsId}/nonconformities/${item.id}`;
  if (['orphan_risks', 'no_owner_risks'].includes(kind)) return `/workspaces/${wsId}/risks/${item.id}`;
  if (kind.startsWith('supplier_') || kind === 'expired_supplier_docs' || kind === 'overdue_supplier_reviews' || kind === 'tier1_no_attestation') return `/workspaces/${wsId}/vendors/${item.id}`;
  return `/workspaces/${wsId}/readiness`;
}

const FLAG_META = {
  implemented_no_evidence: { domain: 'controls', impact: 'Implementation claims cannot be defended to an auditor without retained evidence.', cta: 'Review controls', href: 'controls' },
  no_owner: { domain: 'controls', impact: 'A control without accountability cannot be operated or attested consistently.', cta: 'Assign owners', href: 'controls' },
  included_no_basis: { domain: 'controls', impact: 'SoA inclusion decisions need a traceable risk or business basis.', cta: 'Complete the SoA', href: 'soa' },
  excluded_no_basis: { domain: 'controls', impact: 'Unsupported exclusions are likely to be challenged during certification.', cta: 'Complete the SoA', href: 'soa' },
  undecided_soa: { domain: 'controls', impact: 'An incomplete applicability decision prevents a defensible Stage 1 conclusion.', cta: 'Complete the SoA', href: 'soa' },
  open_major_ncs: { domain: 'assurance', impact: 'Open major nonconformities invalidate a clean readiness conclusion.', cta: 'Resolve findings', href: 'nonconformities' },
  overdue_ncs: { domain: 'assurance', impact: 'Overdue corrective actions indicate ineffective issue governance.', cta: 'Resolve findings', href: 'nonconformities' },
  orphan_risks: { domain: 'risks', impact: 'Risk treatment cannot be demonstrated when risks are not mapped to controls.', cta: 'Map controls', href: 'risks' },
  no_owner_risks: { domain: 'risks', impact: 'Unowned risks have no accountable acceptance or treatment authority.', cta: 'Assign owners', href: 'risks' },
  expired_supplier_docs: { domain: 'suppliers', impact: 'Supplier assurance cannot rely on expired attestations or contracts.', cta: 'Refresh evidence', href: 'vendors' },
  overdue_supplier_reviews: { domain: 'suppliers', impact: 'Overdue reviews make the current supplier risk decision stale.', cta: 'Complete reviews', href: 'vendors' },
  tier1_no_attestation: { domain: 'suppliers', impact: 'Critical suppliers need current independent assurance or a documented compensating review.', cta: 'Collect assurance', href: 'vendors' },
  stale_access_review: { domain: 'controls', impact: 'Stale access-control reviews weaken the evidence behind implementation claims.', cta: 'Review controls', href: 'controls' }
};

function buildWorkspaceTruth(db, ws, suppliedReadiness) {
  const readiness = suppliedReadiness || computeReadiness(ws);
  const wsId = ws.id;
  const issues = [];
  const add = issue => {
    if (!issue || issues.some(existing => existing.code === issue.code)) return;
    issues.push({ items: [], count: 1, ...issue });
  };

  const status = buildWorkspaceStatus(db, ws, readiness);
  const verdict = status.verdict;
  const advancedClaim = workspaceClaimsAdvancedStage(ws.stage);
  if (advancedClaim && !readiness.stage1Ready) {
    add({
      code: 'lifecycle_readiness_conflict', domain: 'governance', severity: 'critical',
      title: 'Lifecycle stage conflicts with the readiness verdict',
      detail: `The workspace is stored as “${String(ws.stage).replaceAll('_', ' ')}”, but only ${readiness.stage1GatePassed} of ${readiness.stage1GateTotal} Stage 1 hard gates pass.`,
      impact: 'Executive dashboards and client reports must not imply audit readiness while mandatory gates fail.',
      href: `/workspaces/${wsId}/readiness`, cta: 'Review readiness gates'
    });
  }

  const gateDomain = {
    context: 'governance', interested_parties: 'governance', scope: 'governance', policy: 'documents', roles: 'governance',
    risk_method: 'risks', risk_assessment: 'risks', rtp: 'risks', soa: 'controls', objectives: 'governance',
    planning_changes: 'governance', awareness: 'governance', communication: 'governance', doc_control: 'documents',
    internal_audit: 'assurance', mgmt_review: 'assurance', mandatory_docs: 'documents'
  };
  readiness.stage1Gate.filter(g => !g.pass).forEach(gate => add({
    code: `stage1_gate_${gate.key}`, domain: gateDomain[gate.key] || 'governance', severity: advancedClaim ? 'critical' : 'high',
    title: gate.name, detail: gate.detail, impact: `ISO 27001 ${gate.clause}: this hard gate must pass before the workspace can be represented as Stage 1 ready.`,
    href: gate.href, cta: gate.action, count: 1
  }));

  readiness.flags.forEach(flag => {
    const meta = FLAG_META[flag.kind];
    if (!meta) return;
    const href = `/workspaces/${wsId}/${meta.href}`;
    const labelledCount = Number.parseInt(String(flag.label).match(/^\d+/)?.[0] || '', 10);
    const affectedCount = Number.isFinite(labelledCount) ? labelledCount : Math.max(flag.items.length, 1);
    add({
      code: `readiness_${flag.kind}`, domain: meta.domain, severity: flag.severity,
      title: flag.label, detail: 'The underlying records are present but incomplete, inconsistent, stale, or not decision-ready.',
      impact: meta.impact, href, cta: meta.cta, count: affectedCount,
      items: flag.items.slice(0, 8).map(item => ({ label: item.title || item.name || String(item.id), href: itemLink(wsId, flag.kind, item) }))
    });
  });

  const activeSupplierWhere = `s.workspace_id=? AND s.archived_at IS NULL AND COALESCE(s.lifecycle_stage,'active') NOT IN ('terminated','rejected')`;
  const supplierChecks = [
    {
      code: 'supplier_missing_owner', severity: 'high', title: 'Active suppliers without a business owner',
      detail: 'Every active third party needs an accountable business owner.', impact: 'Risk acceptance and remediation decisions have no accountable client-side authority.', cta: 'Assign supplier owners',
      sql: `SELECT s.id,s.name FROM suppliers s WHERE ${activeSupplierWhere} AND (s.business_owner IS NULL OR length(trim(s.business_owner))=0)`
    },
    {
      code: 'supplier_missing_decision', severity: 'high', title: 'Active suppliers without a current risk decision',
      detail: 'No current approved, conditional, renewed, rejected, or offboard decision is recorded.', impact: 'The register shows activity but cannot prove who accepted the residual risk and why.', cta: 'Record risk decisions',
      sql: `SELECT s.id,s.name FROM suppliers s WHERE ${activeSupplierWhere} AND NOT EXISTS (SELECT 1 FROM supplier_decisions d WHERE d.supplier_id=s.id AND d.superseded_at IS NULL)`
    },
    {
      code: 'supplier_missing_questionnaire', severity: 'high', title: 'Active suppliers without reviewed due diligence',
      detail: 'No supplier questionnaire has completed internal review.', impact: 'Residual-risk conclusions are not supported by a reviewed supplier response.', cta: 'Send due diligence',
      sql: `SELECT s.id,s.name FROM suppliers s WHERE ${activeSupplierWhere} AND NOT EXISTS (SELECT 1 FROM supplier_questionnaires q WHERE q.supplier_id=s.id AND q.status='reviewed')`
    },
    {
      code: 'supplier_missing_assurance', severity: 'medium', title: 'Active suppliers without assurance evidence',
      detail: 'No current supplier document or attestation is retained.', impact: 'Supplier assertions cannot be independently corroborated.', cta: 'Collect evidence',
      sql: `SELECT s.id,s.name FROM suppliers s WHERE ${activeSupplierWhere} AND NOT EXISTS (SELECT 1 FROM supplier_documents d WHERE d.supplier_id=s.id AND (d.expiry_date IS NULL OR d.expiry_date>=date('now')))`
    },
    {
      code: 'supplier_missing_exit', severity: 'medium', title: 'Active suppliers without an exit strategy',
      detail: 'No transition, replacement, data-return, or deletion approach is documented.', impact: 'Concentration and continuity risk cannot be managed at termination or disruption.', cta: 'Document exit plans',
      sql: `SELECT s.id,s.name FROM suppliers s WHERE ${activeSupplierWhere} AND (s.exit_strategy IS NULL OR length(trim(s.exit_strategy))=0)`
    }
  ];
  supplierChecks.forEach(check => {
    const rows = db.prepare(check.sql).all(wsId);
    if (!rows.length) return;
    add({ ...check, domain: 'suppliers', count: rows.length, href: `/workspaces/${wsId}/vendors?section=register`,
      items: rows.slice(0, 8).map(row => ({ label: row.name, href: `/workspaces/${wsId}/vendors/${row.id}` })) });
  });

  const staleDocs = db.prepare(`SELECT id,name,next_review_date FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') AND (next_review_date IS NULL OR next_review_date<date('now')) ORDER BY name`).all(wsId);
  if (staleDocs.length) add({
    code: 'documents_stale_review', domain: 'documents', severity: 'medium', title: 'Approved documents without a future review date',
    detail: 'Approved or published documents are missing a review date or are past due.', impact: 'The controlled-document set may be stale even though its status is approved.',
    href: `/workspaces/${wsId}/documents`, cta: 'Schedule document reviews', count: staleDocs.length,
    items: staleDocs.slice(0, 8).map(doc => ({ label: doc.name, href: `/workspaces/${wsId}/documents/${doc.id}` }))
  });

  issues.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));
  const quality = qualityScore(issues);
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const domains = {};
  issues.forEach(issue => {
    counts[issue.severity]++;
    domains[issue.domain] = domains[issue.domain] || { key: issue.domain, label: issue.domain[0].toUpperCase() + issue.domain.slice(1), total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    domains[issue.domain].total++;
    domains[issue.domain][issue.severity]++;
  });

  return {
    generatedAt: new Date().toISOString(), verdict, lifecycle: status.lifecycle, quality, counts, issues,
    domains: Object.values(domains).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    readiness: {
      stage1: readiness.stage1, stage2: readiness.stage2,
      stage1Ready: readiness.stage1Ready, stage2Ready: readiness.stage2Ready,
      stage1GatePassed: readiness.stage1GatePassed, stage1GateTotal: readiness.stage1GateTotal,
      stage2GatePassed: readiness.stage2GatePassed, stage2GateTotal: readiness.stage2GateTotal
    },
    nextAction: issues[0] || null
  };
}

module.exports = { buildWorkspaceTruth, buildWorkspaceStatus, deriveVerdict, qualityScore };
