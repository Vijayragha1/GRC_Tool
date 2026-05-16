// Unified findings - one shape across the four places this codebase records
// "something that needs attention":
//   - nonconformities          (clause 10.2 corrective action)
//   - audit_findings           (per-audit per-control NC sources)
//   - audit_observations       (auditor advice, not NCs)
//   - control_states           (gap-assessment statuses Not Implemented /
//                               Partially Implemented / Work In Progress)
//
// The four tables grew independently and each has its own status taxonomy,
// severity vocabulary, and join shape. Code that needs to answer "what's
// open across this engagement?" or "produce an OSCAL assessment-results
// doc" has to walk all four. This module collapses them into one rectangle
// so downstream consumers (the new findings view, the OSCAL exporter, the
// client portal) work off a single shape.
//
// The unified row:
//   { id, source, framework, item_ref, item_title,
//     title, description, severity, status, owner, due_date,
//     source_label, source_href, created_at, closed_at }
//
// Read-only. Writes still go through the per-source routes - changing the
// model further would be a much bigger churn.

const { db } = require('../db');

// Severity normalisation. Different sources speak different words for the
// same idea; the unified shape uses a 4-step ladder: high / medium / low /
// observation. The ordering matters: severity sorting elsewhere relies on
// this.
const SEVERITY_RANK = { high: 0, medium: 1, low: 2, observation: 3 };

function normaliseNcSeverity(s) {
  // nonconformities use {major, minor, observation}
  if (s === 'major') return 'high';
  if (s === 'minor') return 'medium';
  if (s === 'observation') return 'observation';
  return 'medium';
}

function normaliseAuditFindingSeverity(s) {
  // audit_findings use {high, medium, low}
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return 'medium';
}

// Gap-assessment statuses are converted to severities so they live on the
// same axis as NCs. Not Implemented is treated as a high-severity finding
// because it blocks Stage 1; the rest are medium / low.
function gapStatusSeverity(s) {
  if (s === 'Not Implemented') return 'high';
  if (s === 'Partially Implemented') return 'medium';
  if (s === 'Work In Progress') return 'low';
  return null; // anything else isn't a finding
}

// Status normalisation. The unified taxonomy is {open, closed}. NCs use
// 'verified' as a terminal closed state, which we collapse to 'closed';
// 'in_progress' stays open; 'open' stays open.
function isOpen(rawStatus) {
  return !['closed', 'verified'].includes(rawStatus);
}

// All findings across the four sources for a workspace. Each row is
// annotated with source ('nonconformity' / 'audit_finding' / etc.) so the
// UI can colour-tag them and the OSCAL exporter can include provenance.
function getUnifiedFindings(wsId, opts) {
  opts = opts || {};
  const out = [];

  // --- 1. Nonconformities (clause 10.2) -------------------------------
  const ncs = db.prepare(`
    SELECT n.id, n.title, n.description, n.severity, n.status, n.iso_item_id,
           n.responsible, n.due_date, n.created_at, n.closed_at, n.source AS nc_source,
           i.title AS iso_title
    FROM nonconformities n
    LEFT JOIN iso_items i ON i.id = n.iso_item_id
    WHERE n.workspace_id = ?
  `).all(wsId);
  for (const n of ncs) {
    out.push({
      id: `nc-${n.id}`,
      source: 'nonconformity',
      framework: 'iso27001',
      item_ref: n.iso_item_id,
      item_title: n.iso_title || null,
      title: n.title,
      description: n.description || '',
      severity: normaliseNcSeverity(n.severity),
      status: isOpen(n.status) ? 'open' : 'closed',
      raw_status: n.status,
      owner: n.responsible || null,
      due_date: n.due_date || null,
      source_label: `NC-${String(n.id).padStart(3, '0')}${n.nc_source ? ' · ' + n.nc_source : ''}`,
      source_href: `/workspaces/${wsId}/nonconformities/${n.id}`,
      created_at: n.created_at,
      closed_at: n.closed_at || null
    });
  }

  // --- 2. Audit findings (per-audit, may have promoted into NCs) ------
  // Excludes findings already promoted (nonconformity_id IS NOT NULL) so
  // we don't double-count - the promoted NC already appears above.
  const afs = db.prepare(`
    SELECT f.id, f.audit_id, f.iso_item_id, f.finding_type, f.description,
           f.severity, f.status, f.created_at,
           a.title AS audit_title, a.workspace_id,
           i.title AS iso_title
    FROM audit_findings f
    INNER JOIN audits a ON a.id = f.audit_id
    LEFT JOIN iso_items i ON i.id = f.iso_item_id
    WHERE a.workspace_id = ? AND f.nonconformity_id IS NULL
  `).all(wsId);
  for (const f of afs) {
    out.push({
      id: `af-${f.id}`,
      source: 'audit_finding',
      framework: 'iso27001',
      item_ref: f.iso_item_id,
      item_title: f.iso_title || null,
      title: f.finding_type || 'Audit finding',
      description: f.description || '',
      severity: normaliseAuditFindingSeverity(f.severity),
      status: isOpen(f.status) ? 'open' : 'closed',
      raw_status: f.status,
      owner: null,
      due_date: null,
      source_label: `Audit "${f.audit_title || 'untitled'}"`,
      source_href: `/workspaces/${wsId}/audits/${f.audit_id}`,
      created_at: f.created_at,
      closed_at: null
    });
  }

  // --- 3. Audit observations (advice, not nonconformities) ------------
  const aos = db.prepare(`
    SELECT o.id, o.audit_id, o.iso_item_id, o.description, o.recommendation,
           o.status, o.created_at, a.title AS audit_title, i.title AS iso_title
    FROM audit_observations o
    INNER JOIN audits a ON a.id = o.audit_id
    LEFT JOIN iso_items i ON i.id = o.iso_item_id
    WHERE a.workspace_id = ?
  `).all(wsId);
  for (const o of aos) {
    out.push({
      id: `ao-${o.id}`,
      source: 'audit_observation',
      framework: 'iso27001',
      item_ref: o.iso_item_id,
      item_title: o.iso_title || null,
      title: 'Observation',
      description: o.description || '',
      severity: 'observation',
      status: isOpen(o.status) ? 'open' : 'closed',
      raw_status: o.status,
      owner: null,
      due_date: null,
      source_label: `Audit "${o.audit_title || 'untitled'}" · observation`,
      source_href: `/workspaces/${wsId}/audits/${o.audit_id}`,
      created_at: o.created_at,
      closed_at: null
    });
  }

  // --- 4. Gap-assessment statuses (open by construction) --------------
  // Every ISO 27001 control whose status is one of the three gap states
  // becomes an open finding. These auto-resolve when the consultant marks
  // the control as Implemented in a later pass.
  const gaps = db.prepare(`
    SELECT cs.iso_item_id, cs.status, cs.notes, cs.owner_id, cs.due_date,
           cs.last_updated, i.title AS iso_title,
           u.name AS owner_name
    FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    LEFT JOIN users u ON u.id = cs.owner_id
    WHERE cs.workspace_id = ?
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
  `).all(wsId);
  for (const g of gaps) {
    out.push({
      id: `gap-${g.iso_item_id}`,
      source: 'gap_assessment',
      framework: 'iso27001',
      item_ref: g.iso_item_id,
      item_title: g.iso_title,
      title: g.status,
      description: g.notes || '',
      severity: gapStatusSeverity(g.status),
      status: 'open',
      raw_status: g.status,
      owner: g.owner_name || null,
      due_date: g.due_date || null,
      source_label: `Gap assessment · ${g.status}`,
      source_href: `/workspaces/${wsId}/controls/assess/${g.iso_item_id}`,
      created_at: g.last_updated,
      closed_at: null
    });
  }

  // --- 5. ISO 42001 gap-assessment statuses ---------------------------
  // Same shape, framework='iso42001'. Only run when iso42001_items exists
  // (it always does once db.init has run, but the LEFT JOIN keeps the
  // contract clear).
  try {
    const gaps42 = db.prepare(`
      SELECT cs.iso_item_id, cs.status, cs.notes, cs.due_date, cs.last_updated,
             i.title AS iso_title
      FROM iso42001_control_states cs
      INNER JOIN iso42001_items i ON i.id = cs.iso_item_id
      WHERE cs.workspace_id = ?
        AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    `).all(wsId);
    for (const g of gaps42) {
      out.push({
        id: `gap42-${g.iso_item_id}`,
        source: 'gap_assessment',
        framework: 'iso42001',
        item_ref: g.iso_item_id,
        item_title: g.iso_title,
        title: g.status,
        description: g.notes || '',
        severity: gapStatusSeverity(g.status),
        status: 'open',
        raw_status: g.status,
        owner: null,
        due_date: g.due_date || null,
        source_label: `ISO 42001 gap · ${g.status}`,
        source_href: `/workspaces/${wsId}/iso42001/controls/${g.iso_item_id}`,
        created_at: g.last_updated,
        closed_at: null
      });
    }
  } catch (_) { /* table may not yet exist on a very old DB */ }

  // Apply filters last so source-specific code stays simple.
  let filtered = out;
  if (opts.status) {
    filtered = filtered.filter(f => f.status === opts.status);
  }
  if (opts.framework) {
    filtered = filtered.filter(f => f.framework === opts.framework);
  }
  if (opts.source) {
    filtered = filtered.filter(f => f.source === opts.source);
  }
  if (opts.severity) {
    filtered = filtered.filter(f => f.severity === opts.severity);
  }

  // Default sort: open first, then by severity (high -> observation), then
  // by created_at desc. The OSCAL exporter and the findings view both
  // benefit from this ordering.
  filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    const sevDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDelta !== 0) return sevDelta;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  return filtered;
}

// Aggregate counts for the findings index header. Walks the unified list
// once and tallies by source, framework, severity, and open/closed.
function summarise(findings) {
  const sum = {
    total: findings.length,
    open: 0, closed: 0,
    bySource: {}, byFramework: {}, bySeverity: {}
  };
  for (const f of findings) {
    if (f.status === 'open') sum.open++; else sum.closed++;
    sum.bySource[f.source]       = (sum.bySource[f.source]       || 0) + 1;
    sum.byFramework[f.framework] = (sum.byFramework[f.framework] || 0) + 1;
    sum.bySeverity[f.severity]   = (sum.bySeverity[f.severity]   || 0) + 1;
  }
  return sum;
}

module.exports = { getUnifiedFindings, summarise, SEVERITY_RANK };
