'use strict';
// The firm's ISO 42001 clients on one board: where each certification stands,
// what the certification body is waiting for, and what is late. Read-only; it
// reads the records each client's ISO 42001 screens already keep.

const reqOpts = require('./requirement-options');
const outcomeScope = require('./engagement-outcome-scope');
const aimsCycle = require('./iso42001-cycle');
const aimsSoa = require('./iso42001-soa');
const auditRequests = require('./iso42001-audit');

const STAGE_ORDER = { stage1: 1, stage2: 2, surv1: 3, surv2: 4, recert: 5 };

// The next certification body audit that has not happened, or the last one
// that did.
function nextAudit(events, today) {
  const cycle = Math.max(0, ...events.map((x) => x.cycle_no || 1));
  const audits = events.filter((e) => e.isAudit && (e.cycle_no || 1) === cycle && e.status !== 'cancelled');
  const upcoming = audits.filter((e) => !e.actual_date && e.status !== 'completed' && e.planned_date)
    .sort((a, b) => a.planned_date.localeCompare(b.planned_date))[0];
  if (upcoming) return { label: upcoming.label, date: upcoming.planned_date, days: Math.round((Date.parse(upcoming.planned_date) - Date.parse(today)) / 86400000), done: false };
  const last = audits.filter((e) => e.actual_date || e.status === 'completed')
    .sort((a, b) => (STAGE_ORDER[b.event_key] || 0) - (STAGE_ORDER[a.event_key] || 0))[0];
  return last ? { label: last.label, date: last.actual_date || last.planned_date, done: true } : null;
}

function row(db, workspace, today, readinessFor) {
  const gapOnly = outcomeScope.isGapAssessmentOnly(workspace);
  const readiness = readinessFor ? readinessFor(workspace.id) : null;
  const requests = gapOnly ? [] : auditRequests.listRequests(db, workspace, today);
  const openRequests = requests.filter((r) => !['submitted', 'accepted', 'not_applicable', 'withdrawn'].includes(r.effective));
  const findings = aimsCycle.openFindings(db, workspace);
  const approvedSoa = aimsSoa.latestApproved(db, workspace);
  const systems = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM ai_impact_assessments ia WHERE ia.ai_system_id = s.id AND ia.status = 'approved') THEN 1 ELSE 0 END) unassessed
    FROM ai_systems s WHERE s.workspace_id=? AND s.in_scope=1 AND s.lifecycle_stage != 'retired'`).get(workspace.id);
  const lateWork = db.prepare(`SELECT COUNT(*) c FROM v_iso42001_control_states
    WHERE workspace_id=? AND due_date < ? AND status != 'Implemented' AND COALESCE(applicability,'undecided') != 'excluded'`).get(workspace.id, today).c;
  const attention = [];
  if (findings.major) attention.push(`${findings.major} major finding${findings.major === 1 ? '' : 's'} open`);
  if (openRequests.some((r) => r.overdue)) attention.push(`${openRequests.filter((r) => r.overdue).length} overdue request${openRequests.filter((r) => r.overdue).length === 1 ? '' : 's'}`);
  if (systems.unassessed) attention.push(`${systems.unassessed} AI system${systems.unassessed === 1 ? '' : 's'} without an impact assessment`);
  if (!approvedSoa) attention.push('SoA not approved');
  if (lateWork) attention.push(`${lateWork} requirement${lateWork === 1 ? '' : 's'} past due`);
  return {
    workspace,
    name: workspace.brand_display_name || workspace.client_name,
    gapOnly,
    readiness: readiness ? { stage1: readiness.stage1, stage2: readiness.stage2 } : null,
    next: gapOnly ? null : nextAudit(aimsCycle.events(db, workspace), today),
    requests: { open: openRequests.length, overdue: openRequests.filter((r) => r.overdue).length, total: requests.length },
    findings,
    soaApproved: approvedSoa ? approvedSoa.approved_on : null,
    systems: { total: systems.total || 0, unassessed: systems.unassessed || 0 },
    lateWork,
    attention,
  };
}

// Rows for the workspaces the user can see that work to ISO 42001, the most
// pressing first: open major findings, then the nearest audit.
function board(db, workspaces, { today = new Date().toISOString().slice(0, 10), readinessFor } = {}) {
  const rows = workspaces.filter((w) => reqOpts.enabledCodes(w).includes('iso42001')).map((w) => row(db, w, today, readinessFor));
  rows.sort((a, b) => (b.findings.major || 0) - (a.findings.major || 0)
    || ((a.next && !a.next.done ? a.next.days : 1e6) - (b.next && !b.next.done ? b.next.days : 1e6))
    || a.name.localeCompare(b.name));
  return {
    rows,
    summary: {
      clients: rows.length,
      auditsIn30Days: rows.filter((r) => r.next && !r.next.done && r.next.days >= 0 && r.next.days <= 30).length,
      overdueRequests: rows.reduce((s, r) => s + r.requests.overdue, 0),
      majorFindings: rows.reduce((s, r) => s + (r.findings.major || 0), 0),
    },
  };
}

module.exports = { board, nextAudit };
