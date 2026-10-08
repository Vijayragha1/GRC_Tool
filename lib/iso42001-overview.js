'use strict';

// Read-only projection of the engagement records. An audit checklist row is
// not another client request, and a concluded assessment is not a review.
const delivery = require('./engagement-delivery');
const assessment = require('./iso42001-assessment');
const aimsDelivery = require('./iso42001-delivery');
const { frameworkCodes } = require('./engagement-outcome-scope');

const CLOSED_REQUESTS = new Set(['accepted', 'cancelled']);
const CLIENT_STATUSES = new Set(['open', 'in_progress', 'changes_requested']);
const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', submitted: 'Awaiting review',
  accepted: 'Accepted', changes_requested: 'Changes requested', cancelled: 'Cancelled' };
const REPORT_LABELS = { published: 'Published', approved: 'Approved, awaiting publication',
  assessment_reviewed: 'Assessment reviewed; report not approved', not_started: 'Report not approved' };
const isAiItem = value => /^ai-/i.test(value || '');
const isAiReference = value => /^iso(?:\/iec)?[\s_-]*42001(?:\b|_)/i.test(value || '');
function jsonArray(value) {
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
}
function instant(value) {
  if (!value) return 0;
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:/.test(value) ? value.replace(' ', 'T') + 'Z' : value) || 0;
}

function buildOverview(db, ws, userId) {
  const base = `/workspaces/${ws.id}`;
  const codes = frameworkCodes(ws);
  const standalone = codes.length === 1 && codes[0] === 'iso42001';
  const combined = codes.includes('iso27001') && codes.includes('iso42001');
  const projection = delivery.getProjection(db, ws, userId, { ensure: false });
  const gap = assessment.getGapState(db, ws.id);
  const reportContext = aimsDelivery.gapContext(db, ws);
  const conclusions = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN s.status IS NOT NULL AND s.status!='Not Assessed' THEN 1 ELSE 0 END) assessed
    FROM iso42001_items i LEFT JOIN v_iso42001_control_states s
      ON s.iso_item_id=i.id AND s.workspace_id=? WHERE i.type IN ('clause','control')`).get(ws.id);

  const nativeRequests = db.prepare(`SELECT r.id,r.title,r.status,r.due_date,r.released_at,r.control_id,
    r.created_at,r.updated_at,u.name assignee_name,f.code workpaper_framework,ce.framework_scope_json,
    (SELECT MIN(a.id) FROM aims_audit_requests a WHERE a.workspace_id=r.workspace_id AND a.client_request_id=r.id) audit_request_id
    FROM client_requests r LEFT JOIN users u ON u.id=r.assignee_id
    LEFT JOIN consultant_workpapers w ON w.id=r.workpaper_id AND w.workspace_id=r.workspace_id
    LEFT JOIN requirements q ON q.id=w.requirement_id LEFT JOIN frameworks f ON f.id=q.framework_id
    LEFT JOIN consulting_engagements ce ON ce.id=r.engagement_id AND ce.workspace_id=r.workspace_id
    WHERE r.workspace_id=?`).all(ws.id).filter(row => {
    const frameworks = jsonArray(row.framework_scope_json);
    if (row.audit_request_id || row.workpaper_framework === 'iso42001' || isAiItem(row.control_id)
        || (frameworks.length === 1 && frameworks[0] === 'iso42001')) return true;
    // Generic requests belong to an AIMS-only workspace. In a combined
    // programme, an explicit AIMS link is needed to attribute the request.
    return standalone && !row.control_id && !row.workpaper_framework
      && (!frameworks.length || frameworks.every(code => code === 'iso42001'));
  });
  const requestIds = new Set(nativeRequests.map(row => row.id));
  const requestMap = new Map(nativeRequests.map(row => [row.id, row]));
  const openRequests = nativeRequests.filter(row => !CLOSED_REQUESTS.has(row.status));
  const requestPriority = { submitted: 0, changes_requested: 1, in_progress: 2, open: 3 };
  const requestRows = openRequests.sort((a, b) => (requestPriority[a.status] - requestPriority[b.status])
    || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || b.id - a.id).map(row => ({
    id: row.id, title: row.title, status: row.status,
    statusLabel: !row.released_at && CLIENT_STATUSES.has(row.status) ? 'Not sent' : STATUS_LABELS[row.status],
    dueDate: row.due_date, assigneeName: row.assignee_name || null,
    href: `${base}/client-portal/requests/${row.id}`, auditRequestId: row.audit_request_id || null,
  }));

  const findingRows = db.prepare(`SELECT id,title,severity,status,due_date,source_ref,iso_item_id
    FROM nonconformities WHERE workspace_id=? AND lower(COALESCE(status,'open')) NOT IN ('closed','verified')
    ORDER BY CASE lower(severity) WHEN 'major' THEN 0 WHEN 'minor' THEN 1 ELSE 2 END,due_date,id`).all(ws.id)
    .filter(row => isAiItem(row.iso_item_id) || isAiReference(row.source_ref)
      || (standalone && !row.iso_item_id && !/^iso(?:\/iec)?[\s_-]*27001|^cert_cycle_event:/i.test(row.source_ref || '')))
    .map(row => ({ id: row.id, title: row.title, severity: row.severity, status: row.status,
      dueDate: row.due_date, href: `${base}/nonconformities/${row.id}` }));

  const evidenceRequests = new Map();
  for (const link of db.prepare(`SELECT l.evidence_id,l.request_id FROM client_request_evidence l
    JOIN client_requests r ON r.id=l.request_id WHERE r.workspace_id=?`).all(ws.id)) {
    if (requestIds.has(link.request_id)) evidenceRequests.set(link.evidence_id, link.request_id);
  }
  const evidenceRows = db.prepare(`SELECT e.id,e.filename,e.uploaded_at,e.iso_item_id,
    EXISTS (SELECT 1 FROM evidence_requirement_links l JOIN requirements r ON r.id=l.requirement_id
      JOIN frameworks f ON f.id=r.framework_id WHERE l.evidence_id=e.id AND f.code='iso42001') aims_linked,
    EXISTS (SELECT 1 FROM evidence_requirement_links l JOIN requirements r ON r.id=l.requirement_id
      JOIN frameworks f ON f.id=r.framework_id WHERE l.evidence_id=e.id AND f.code!='iso42001') other_linked
    FROM evidence e WHERE e.workspace_id=? AND e.superseded_at IS NULL
    ORDER BY e.uploaded_at DESC,e.id DESC`).all(ws.id).filter(row => isAiItem(row.iso_item_id)
      || row.aims_linked || evidenceRequests.has(row.id) || (standalone && !row.iso_item_id && !row.other_linked));

  const activity = evidenceRows.slice(0, 5).map(row => ({
    id: `evidence-${row.id}`, kind: 'evidence', title: 'Evidence uploaded', detail: row.filename,
    at: row.uploaded_at, href: evidenceRequests.has(row.id)
      ? `${base}/client-portal/requests/${evidenceRequests.get(row.id)}` : `${base}/evidence`,
  }));
  const requestEvents = requestIds.size ? db.prepare(`SELECT e.id,e.request_id,e.event_type,e.to_status,e.created_at
    FROM client_request_events e JOIN client_requests r ON r.id=e.request_id AND r.workspace_id=e.workspace_id
    WHERE e.workspace_id=? AND e.request_id IN (SELECT value FROM json_each(?))
    ORDER BY e.created_at DESC,e.id DESC LIMIT 5`).all(ws.id, JSON.stringify([...requestIds])) : [];
  for (const event of requestEvents) {
    const titles = { created: 'Request created', assigned: 'Request assigned', commented: 'Request conversation',
      evidence_linked: 'Evidence attached', status_changed: STATUS_LABELS[event.to_status] || 'Request status changed',
      response_updated: 'Client response updated', target_updated: 'Request target updated' };
    activity.push({ id: `request-event-${event.id}`, kind: event.event_type === 'commented' ? 'conversation' : 'request',
      title: titles[event.event_type] || 'Request updated',
      detail: [event.actor_name, requestMap.get(event.request_id).title].filter(Boolean).join(' · '),
      at: event.created_at, href: `${base}/client-portal/requests/${event.request_id}` });
  }
  if (projection?.plan) {
    const events = db.prepare(`SELECT e.id,e.action,e.to_status,e.created_at FROM engagement_delivery_events e
      JOIN engagement_delivery_plans p ON p.id=e.plan_id AND p.workspace_id=e.workspace_id
      WHERE e.workspace_id=? AND e.plan_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT 5`).all(ws.id, projection.plan.id);
    for (const event of events) activity.push({ id: `delivery-event-${event.id}`, kind: 'engagement',
      title: ({ created: 'Engagement plan created', recalculated: 'Engagement progress updated' })[event.action]
        || event.action.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase()),
      detail: combined ? 'Combined ISO 27001 / ISO 42001 engagement' : 'ISO 42001 engagement',
      at: event.created_at, href: `${base}/engagement-plan` });
  }
  const reportStatus = reportContext.publication ? 'published' : reportContext.report ? 'approved'
    : gap.reviewed ? 'assessment_reviewed' : 'not_started';
  return {
    plan: projection?.plan || null, projection, planHref: `${base}/engagement-plan`,
    planScope: combined ? 'combined' : 'iso42001',
    planLabel: combined ? 'Combined ISO 27001 / ISO 42001 engagement' : 'ISO 42001 engagement',
    assessment: { assessed: conclusions.assessed || 0, total: conclusions.total, reviewed: gap.reviewed,
      complete: gap.complete, href: gap.href },
    report: { status: reportStatus, label: REPORT_LABELS[reportStatus],
      href: reportContext.report ? `${base}/engagement-plan` : gap.href,
      published: !!reportContext.publication, reviewed: !!reportContext.report },
    findings: { open: findingRows.length, rows: findingRows, href: `${base}/nonconformities` },
    requests: { open: openRequests.length,
      withClient: openRequests.filter(row => row.released_at && CLIENT_STATUSES.has(row.status)).length,
      toReview: openRequests.filter(row => row.status === 'submitted').length, rows: requestRows,
      href: `${base}/client-portal?view=actions#requests` },
    evidence: { total: evidenceRows.length, href: `${base}/evidence` },
    recentActivity: activity.sort((a, b) => instant(b.at) - instant(a.at) || b.id.localeCompare(a.id)).slice(0, 5),
  };
}

module.exports = { buildOverview };
