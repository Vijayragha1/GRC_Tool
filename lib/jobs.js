// Scheduled job runner. Runs every N minutes inside the app process - no cron,
// no extra services. Each run is idempotent and bounded.
//
// Jobs implemented:
//  - documentReviewReminders: when a document's next_review_date is within 30 days
//                             or has passed, raise a notification (once per doc per cycle).
//  - taskRecurrence:           when a recurring task is closed, spawn the next instance.
//  - overrideExpiry:           drop expired permission overrides + raise an audit log entry.
//  - ackCampaignReminders:     nudge unacknowledged campaign recipients.
//  - supplierReviewReminders:  raise a notification for upcoming/overdue supplier reviews.
//  - questionnaireResponseReminders: nudge the lead when a vendor hasn't returned a
//                             questionnaire that was emailed to them.
//  - controlReviewReminders:   periodic review of access-related controls (A.5.18 etc).
//  - accessReviewKickoff:      auto-open quarterly access review if last one is > 90d old.
//  - catalogSupersession:      flag assessments pinned to a retired catalogue version.

const { db, logAction } = require('../db');
const email = require('./email');
const outcomeScope = require('./engagement-outcome-scope');
const engagementDelivery = require('./engagement-delivery');
const tprmMonitoring = require('./tprm-monitoring-connectors');

// Who should an emailed notification go to? A targeted notification (userId set)
// goes to that user. A workspace-wide one (userId null) goes to the engagement's
// lead consultant, falling back to the firm's managers when no lead is assigned.
function resolveRecipients(workspaceId, userId) {
  if (userId) {
    const u = db.prepare(`SELECT id, name, email, email_notify FROM users WHERE id=? AND active=1`).get(userId);
    return u ? [u] : [];
  }
  if (!workspaceId) return [];
  const ws = db.prepare(`SELECT lead_consultant_id, firm_id FROM workspaces WHERE id=?`).get(workspaceId);
  if (!ws) return [];
  if (ws.lead_consultant_id) {
    const lead = db.prepare(`SELECT id, name, email, email_notify FROM users WHERE id=? AND active=1`).get(ws.lead_consultant_id);
    if (lead) return [lead];
  }
  return db.prepare(`SELECT id, name, email, email_notify FROM users
    WHERE firm_id=? AND user_type='firm' AND firm_role='manager' AND active=1`).all(ws.firm_id);
}

// Fire-and-forget email mirror of a freshly-created notification. The DB work
// (recipient lookup + claiming the notification_emails slot) is synchronous so
// notify() stays sync; only the actual send is async and best-effort. Claiming
// the (notification, user) slot before sending makes a job re-run idempotent.
function dispatchNotificationEmail({ notificationId, workspaceId, userId, category, title, body, link }) {
  let recipients;
  try { recipients = resolveRecipients(workspaceId, userId); }
  catch (e) { console.error('[notify->email] resolve failed:', e.message); return; }
  if (!recipients || !recipients.length) return;

  let wsName = null, firmId = null;
  if (workspaceId) {
    const ws = db.prepare(`SELECT brand_display_name, client_name, firm_id FROM workspaces WHERE id=?`).get(workspaceId);
    if (ws) { wsName = ws.brand_display_name || ws.client_name; firmId = ws.firm_id; }
  }

  for (const r of recipients) {
    const pref = r.email_notify || 'immediate';
    if (pref !== 'immediate') continue;            // 'off' = in-app only; 'daily' reserved for a future digest
    if (!r.email) continue;
    const claimed = db.prepare(`INSERT OR IGNORE INTO notification_emails (notification_id, user_id) VALUES (?, ?)`).run(notificationId, r.id);
    if (claimed.changes === 0) continue;           // already emailed this person about this item
    email.sendNotificationEmail({
      toEmail: r.email, toName: r.name, title, body, link,
      workspaceName: wsName, firmId, workspaceId, category
    }).catch(err => console.error('[notify->email] send failed:', err && err.message));
  }
}

function notify(workspaceId, userId, category, severity, title, body, link, expiresInDays) {
  try {
    const exists = db.prepare(`SELECT id FROM notifications WHERE workspace_id=? AND user_id IS ? AND category=? AND title=? AND read_at IS NULL AND dismissed_at IS NULL`)
      .get(workspaceId, userId || null, category, title);
    if (exists) return null;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;
    const id = db.prepare(`INSERT INTO notifications (workspace_id, user_id, category, severity, title, body, link, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, userId || null, category, severity, title, body || null, link || null, expiresAt).lastInsertRowid;
    // Mirror to email (best-effort; never blocks or breaks the in-app notification).
    try { dispatchNotificationEmail({ notificationId: id, workspaceId, userId: userId || null, category, title, body, link }); }
    catch (e) { console.error('[notify->email] dispatch failed:', e.message); }
    return id;
  } catch (e) { console.error('[notify] failed:', e.message); return null; }
}

// === Job: document review reminders ===
function jobDocumentReviewReminders() {
  const rows = db.prepare(`SELECT d.id, d.workspace_id, d.name, d.next_review_date,
       julianday(d.next_review_date) - julianday('now') AS days_to_review,
       (SELECT id FROM users WHERE id IN (SELECT lead_consultant_id FROM workspaces WHERE id=d.workspace_id)) AS owner_id
       FROM generated_docs d
       WHERE d.status IN ('approved','published') AND d.next_review_date IS NOT NULL`).all();
  let count = 0;
  for (const r of rows) {
    const days = Math.round(r.days_to_review);
    if (days < 0) {
      if (notify(r.workspace_id, null, 'doc_review_overdue', 'high',
        `Policy review overdue: ${r.name}`,
        `Last reviewed ${Math.abs(days)} days past target. Open a new version or extend the review date.`,
        `/workspaces/${r.workspace_id}/documents/${r.id}`)) count++;
    } else if (days <= 30) {
      if (notify(r.workspace_id, null, 'doc_review_due', 'medium',
        `Policy review due in ${days} days: ${r.name}`,
        `Plan a review pass before the policy goes stale.`,
        `/workspaces/${r.workspace_id}/documents/${r.id}`, 30)) count++;
    }
  }
  return count;
}

// === Job: spawn next recurring task instance when one is completed ===
function jobTaskRecurrence() {
  const rows = db.prepare(`SELECT * FROM tasks WHERE status='done' AND recurrence IS NOT NULL AND recurrence <> ''
    AND (recurrence_until IS NULL OR recurrence_until >= date('now'))`).all();
  let count = 0;
  for (const t of rows) {
    // Has a successor already been spawned?
    const next = db.prepare('SELECT 1 FROM tasks WHERE parent_task_id=? AND status NOT IN (\'done\')').get(t.id);
    if (next) continue;
    const intervalDays = { daily: 1, weekly: 7, biweekly: 14, monthly: 30, quarterly: 90, semiannual: 182, annual: 365 }[t.recurrence];
    if (!intervalDays) continue;
    const due = t.due_date ? new Date(new Date(t.due_date).getTime() + intervalDays * 86400000).toISOString().slice(0,10) : null;
    db.prepare(`INSERT INTO tasks (workspace_id, entity_id, title, description, iso_item_id, assignee_id, due_date, status, created_by, parent_task_id, recurrence, recurrence_until, estimated_minutes, template_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)`).run(
      t.workspace_id, t.entity_id || null, t.title, t.description, t.iso_item_id, t.assignee_id, due, t.created_by, t.id, t.recurrence, t.recurrence_until, t.estimated_minutes, t.template_id);
    count++;
  }
  return count;
}

// === Job: drop expired permission overrides ===
function jobOverrideExpiry() {
  const expired = db.prepare(`SELECT * FROM workspace_role_overrides WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`).all();
  let count = 0;
  for (const o of expired) {
    db.prepare('DELETE FROM workspace_role_overrides WHERE id=?').run(o.id);
    logAction(0, o.workspace_id, 'override_auto_expired', 'user', o.user_id, { permission: o.permission, was_granted: !!o.granted });
    count++;
  }
  return count;
}

// === Job: supplier review reminders ===
function jobSupplierReviewReminders() {
  const rows = db.prepare(`SELECT id, workspace_id, name, next_review_date,
    julianday(next_review_date) - julianday('now') AS d
    FROM suppliers WHERE next_review_date IS NOT NULL AND lifecycle_stage NOT IN ('terminated')`).all();
  let count = 0;
  for (const s of rows) {
    const days = Math.round(s.d);
    if (days < 0) {
      if (notify(s.workspace_id, null, 'supplier_review_overdue', 'high',
        `Supplier review overdue: ${s.name}`, `${Math.abs(days)} days past target.`,
        `/workspaces/${s.workspace_id}/vendors/${s.id}?view=support&tab=reviews`)) count++;
    } else if (days <= 30) {
      if (notify(s.workspace_id, null, 'supplier_review_due', 'medium',
        `Supplier review due in ${days}d: ${s.name}`, '',
        `/workspaces/${s.workspace_id}/vendors/${s.id}?view=support&tab=reviews`, 30)) count++;
    }
  }
  return count;
}

// === Job: nonconformity corrective-action reminders ===
// Overdue and due-soon corrective actions. The day count is kept OUT of the
// title on purpose so notify()'s (workspace, category, title) dedup holds - a
// counting-down "due in N days" title would otherwise raise a fresh
// notification (and email) every single day. The exact countdown lives in the
// body; the phase flip from due-soon to overdue intentionally re-fires once.
function jobNonconformityReminders() {
  const rows = db.prepare(`SELECT id, workspace_id, title, severity, responsible, due_date,
      julianday(due_date) - julianday('now') AS d
      FROM nonconformities
      WHERE status NOT IN ('closed','verified') AND due_date IS NOT NULL`).all();
  let count = 0;
  for (const r of rows) {
    const days = Math.round(r.d);
    const sev = r.severity ? `${r.severity} NC` : 'NC';
    const owner = r.responsible ? ` Owner: ${r.responsible}.` : '';
    if (days < 0) {
      if (notify(r.workspace_id, null, 'nc_overdue', 'high',
        `Corrective action overdue: ${r.title}`,
        `Was due ${r.due_date} - ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago. ${sev}.${owner}`,
        `/workspaces/${r.workspace_id}/nonconformities`)) count++;
    } else if (days <= 14) {
      if (notify(r.workspace_id, null, 'nc_due', 'medium',
        `Corrective action due soon: ${r.title}`,
        `Due ${r.due_date} (in ${days} day${days === 1 ? '' : 's'}). ${sev}.${owner}`,
        `/workspaces/${r.workspace_id}/nonconformities`, 21)) count++;
    }
  }
  return count;
}

// === Job: governed supplier due-diligence response nudges ===
function jobQuestionnaireResponseReminders() {
  const REMIND_AFTER_DAYS = 7;
  const rows = db.prepare(`SELECT a.id, a.workspace_id, a.issued_at, a.supplier_id,
      s.name AS supplier_name,
      julianday('now') - julianday(a.issued_at) AS age
    FROM supplier_ddq_assessments a
    INNER JOIN suppliers s ON s.id=a.supplier_id
    WHERE a.token_hash IS NOT NULL
      AND a.issued_at IS NOT NULL
      AND a.status IN ('issued','in_progress')
      AND (a.token_expires_at IS NULL OR a.token_expires_at > datetime('now'))`).all();
  let count = 0;
  for (const r of rows) {
    if (Math.round(r.age) < REMIND_AFTER_DAYS) continue;
    if (notify(r.workspace_id, null, 'questionnaire_no_response', 'medium',
      `Awaiting due-diligence response: ${r.supplier_name}`,
      `No submission has been received for the governed assessment issued on ${(r.issued_at || '').slice(0,10)}. Follow up with the supplier or reissue the secure link.`,
      `/workspaces/${r.workspace_id}/vendors/${r.supplier_id}/due-diligence`, 14)) count++;
  }
  return count;
}

// === Job: stale access controls (>180d since last update) ===
function jobControlReviewReminders() {
  const rows = db.prepare(`SELECT cs.workspace_id, cs.iso_item_id, i.title FROM v_control_states cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.iso_item_id IN ('annex-a.5.15','annex-a.5.18','annex-a.8.2')
    AND cs.status='Implemented' AND cs.last_updated < datetime('now','-180 days')`).all();
  let count = 0;
  for (const r of rows) {
    if (notify(r.workspace_id, null, 'access_control_stale', 'medium',
      `Access control needs review: ${r.title}`,
      `Last updated > 180 days ago. Re-confirm or update notes.`,
      `/workspaces/${r.workspace_id}/controls/${r.iso_item_id}`, 60)) count++;
  }
  return count;
}

// === Job: kick off quarterly access review if none in last 90 days ===
function jobAccessReviewKickoff() {
  const wsList = db.prepare('SELECT id FROM workspaces').all();
  let count = 0;
  for (const w of wsList) {
    const last = db.prepare(`SELECT MAX(created_at) AS t FROM access_reviews WHERE workspace_id=?`).get(w.id);
    if (last.t && new Date(last.t) > new Date(Date.now() - 90 * 86400000)) continue;
    if (notify(w.id, null, 'access_review_due', 'medium',
      'Quarterly access review due',
      'A.5.18 expects periodic review of user access. Open a new access review.',
      `/workspaces/${w.id}/access-reviews`, 14)) count++;
  }
  return count;
}

// Adaptive-delivery alerts are deliberately in-app only. They surface overdue
// owned work, pending sign-off and expired waivers without introducing an
// external automation or integration dependency.
function jobEngagementDeliveryAlerts() {
  const insert = (workspaceId, userId, category, severity, title, body, link) => {
    const exists = db.prepare(`SELECT 1 FROM notifications WHERE workspace_id=? AND user_id IS ? AND category=? AND title=? AND read_at IS NULL AND dismissed_at IS NULL`)
      .get(workspaceId, userId || null, category, title);
    if (exists) return 0;
    db.prepare(`INSERT INTO notifications (workspace_id,user_id,category,severity,title,body,link) VALUES (?,?,?,?,?,?,?)`)
      .run(workspaceId, userId || null, category, severity, title, body || null, link);
    return 1;
  };
  let count = 0;
  const deliverables = db.prepare(`SELECT d.id,d.workspace_id,d.title,d.status,d.due_date,d.owner_id,d.approver_id,
      ph.phase_key,w.frameworks,w.engagement_outcome
    FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    JOIN engagement_delivery_plans p ON p.id=d.plan_id
    JOIN workspaces w ON w.id=d.workspace_id
    WHERE p.status='active' AND d.status NOT IN ('accepted','superseded')`).all()
    .filter(row => outcomeScope.hasIso27001(row) && outcomeScope.isPhaseInContract(row, row.phase_key));
  for (const d of deliverables) {
    const days = d.due_date ? Math.round((Date.parse(`${d.due_date}T12:00:00`) - Date.now()) / 86400000) : null;
    if (days != null && days < 0) count += insert(d.workspace_id, d.owner_id, 'delivery_overdue', 'high',
      `Delivery overdue: ${d.title}`, `Due ${d.due_date}; ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue.`, `/workspaces/${d.workspace_id}/engagement-plan`);
    else if (days != null && days <= 7) count += insert(d.workspace_id, d.owner_id, 'delivery_due', 'medium',
      `Delivery due soon: ${d.title}`, `Due ${d.due_date}.`, `/workspaces/${d.workspace_id}/engagement-plan`);
    if (d.status === 'submitted') count += insert(d.workspace_id, d.approver_id, 'delivery_approval', 'medium',
      `Delivery awaiting approval: ${d.title}`, 'Review the linked evidence against the acceptance criteria.', `/workspaces/${d.workspace_id}/engagement-plan`);
  }
  const waivers = db.prepare(`SELECT g.*,p.workspace_id,p.id plan_id,ph.name,ph.phase_key,
      w.frameworks,w.engagement_outcome
    FROM engagement_delivery_gate_decisions g
    JOIN engagement_delivery_phases ph ON ph.id=g.phase_id JOIN engagement_delivery_plans p ON p.id=ph.plan_id
    JOIN workspaces w ON w.id=p.workspace_id
    WHERE g.decision='waived' AND g.waiver_expires_at < date('now')
      AND g.id=(SELECT MAX(g2.id) FROM engagement_delivery_gate_decisions g2 WHERE g2.phase_id=g.phase_id)`).all()
    .filter(row => outcomeScope.hasIso27001(row) && outcomeScope.isPhaseInContract(row, row.phase_key));
  for (const waiver of waivers) {
    db.transaction(() => {
      db.prepare(`INSERT INTO engagement_delivery_gate_decisions (phase_id,decision,criteria_snapshot,snapshot_hash,note,decided_by,evidence_snapshot_json)
        VALUES (?,'reopened',?,?,?, ?,?)`).run(waiver.phase_id, waiver.criteria_snapshot, waiver.snapshot_hash,
          `Waiver automatically expired on ${waiver.waiver_expires_at}.`, waiver.decided_by, waiver.evidence_snapshot_json || null);
      db.prepare(`UPDATE engagement_delivery_phases SET status='in_progress',actual_end_date=NULL,updated_at=datetime('now') WHERE id=?`).run(waiver.phase_id);
      db.prepare(`INSERT INTO engagement_delivery_events (workspace_id,plan_id,entity_type,entity_id,action,from_status,to_status,details,actor_id)
        VALUES (?,?,'phase_gate',?,'waiver_auto_expired','waived','in_progress',?,?)`).run(waiver.workspace_id, waiver.plan_id,
          waiver.phase_id, JSON.stringify({ expires_at: waiver.waiver_expires_at }), waiver.decided_by);
    })();
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(waiver.workspace_id);
    if (workspace) {
      workspace.frameworks = outcomeScope.frameworkCodes(workspace);
      engagementDelivery.reconcileCompletionState(db, workspace, waiver.decided_by, {
        action: 'reopened_after_waiver_expiry',
        reason: 'A delivery phase-gate waiver expired and the required gate is open again.',
        details: { phase_id: waiver.phase_id, waiver_expires_at: waiver.waiver_expires_at }
      });
    }
    logAction(waiver.decided_by, waiver.workspace_id, 'expire_delivery_gate_waiver', 'engagement_phase', waiver.phase_id, { expires_at: waiver.waiver_expires_at });
    count += insert(waiver.workspace_id, null, 'delivery_waiver_expired', 'high',
      `Phase-gate waiver expired: ${waiver.name}`, `Expired ${waiver.waiver_expires_at}; the gate is open again.`, `/workspaces/${waiver.workspace_id}/engagement-plan?view=gates`);
  }
  return count;
}

// === Job: process governed TPRM monitoring reassessments ===
// The intake transaction creates the immutable signal and queue item together.
// This bounded worker turns due queue items into service-scoped assessment
// cycles. Failures remain queued with exponential backoff and eventually move
// to manual review; no signal or received-event evidence is discarded.
function jobTprmReassessmentQueue() {
  const table = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='tprm_reassessment_queue'`).get();
  if (!table) return { recovered: 0, considered: 0, processed: 0, failed: 0, manualReview: 0 };

  const recovered = tprmMonitoring.recoverStaleReassessmentClaims(db, { olderThanMinutes: 15 }).recovered;
  const items = db.prepare(`SELECT q.id,q.workspace_id,q.supplier_id,s.name AS supplier_name,
      COALESCE(
        CASE WHEN lead.id IS NOT NULL AND lead.active=1 AND lead.user_type='firm' THEN lead.id END,
        (SELECT manager.id FROM users manager
          WHERE manager.firm_id=w.firm_id AND manager.user_type='firm'
            AND manager.firm_role='manager' AND manager.active=1
          ORDER BY manager.id LIMIT 1)
      ) AS actor_id
    FROM tprm_reassessment_queue q
    INNER JOIN workspaces w ON w.id=q.workspace_id
    INNER JOIN suppliers s ON s.workspace_id=q.workspace_id AND s.id=q.supplier_id
    INNER JOIN tprm_modules m ON m.workspace_id=q.workspace_id AND m.id=q.module_id AND m.status='active'
    LEFT JOIN users lead ON lead.id=w.lead_consultant_id AND lead.firm_id=w.firm_id
    LEFT JOIN tprm_monitoring_signals signal
      ON signal.workspace_id=q.workspace_id AND signal.id=q.signal_id
    WHERE q.status='pending' AND q.next_attempt_at<=datetime('now')
    ORDER BY CASE signal.severity
      WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      q.next_attempt_at,q.id
    LIMIT 50`).all();

  const summary = { recovered, considered: items.length, processed: 0, failed: 0, manualReview: 0 };
  for (const item of items) {
    if (!item.actor_id) {
      summary.failed++;
      continue;
    }
    const result = tprmMonitoring.processReassessmentQueueItem(db, {
      workspaceId: item.workspace_id,
      queueId: item.id,
      actorId: item.actor_id,
    });
    if (result.processed) {
      summary.processed++;
      notify(item.workspace_id, item.actor_id, 'tprm_reassessment_started', 'high',
        `Third-party reassessment started: ${item.supplier_name}`,
        'A verified monitoring signal opened a governed reassessment scoped to the affected active service relationship(s).',
        `/workspaces/${item.workspace_id}/tprm/third-parties/${item.supplier_id}`);
    } else {
      summary.failed++;
      if (result.queueItem && result.queueItem.status === 'manual_review') {
        summary.manualReview++;
        notify(item.workspace_id, item.actor_id, 'tprm_reassessment_manual_review', 'high',
          `Monitoring signal needs manual review: ${item.supplier_name}`,
          'Nimbus retained the signal and stopped automatic processing after repeated fail-closed attempts.',
          `/workspaces/${item.workspace_id}/tprm/monitoring/connectors`);
      }
    }
  }
  return summary;
}

// Monthly restore drill: proves the newest backup actually restores. Gated
// on the last recorded drill so the hourly tick is a no-op 719 times out of
// 720. See lib/restore-check.js.
function jobRestoreDrill(restore = require('./restore-check'), now = () => Date.now()) {
  const last = restore.lastDrill();
  const rawRanAt = last && String(last.ran_at || '');
  const normalizedRanAt = rawRanAt && !/[zZ]|[+-]\d\d:\d\d$/.test(rawRanAt)
    ? `${rawRanAt.replace(' ', 'T')}Z`
    : rawRanAt;
  const lastRanAt = Date.parse(normalizedRanAt);
  let fullGenerationVerified = false;
  try { fullGenerationVerified = JSON.parse(last && last.error || '{}').fullGenerationVerified === true; }
  catch (_) { /* old/incomplete drill records must be retried */ }
  if (last && last.status === 'ok' && fullGenerationVerified && Number.isFinite(lastRanAt) &&
      (now() - lastRanAt) < 30 * 86400000) return 'not due';
  const r = restore.runDrill();
  return r.ok ? `passed (${r.ms}ms)` : `FAILED: ${r.error}`;
}

// Hourly expired-session sweep. Replaces better-sqlite3-session-store's own
// fire-and-forget setInterval (no handle, could never be unref'd).
function jobSessionSweep() {
  try {
    const r = db.prepare(`DELETE FROM sessions WHERE datetime('now') > datetime(expire)`).run();
    return `${r.changes} expired session(s) cleared`;
  } catch (e) { return 'skipped: ' + e.message; }
}

// Catalogue supersession. Registering a new catalogue version retires the prior
// framework row and marks the prior release superseded, but nothing told anyone
// that an already-approved client assessment is still pinned to the old one.
// The pinned catalog_hash is what makes an assessment reproducible, so an
// approved deliverable citing retired law is a defensibility problem, not a
// cosmetic one. Bounded: one notification per workspace per stale pin, and
// notify() suppresses repeats while the first is unread.
function jobCatalogSupersession() {
  let count = 0;
  const current = new Map();
  for (const release of db.prepare(`SELECT framework_code, catalog_version, catalog_hash
      FROM framework_catalog_releases WHERE is_current=1`).all()) {
    current.set(release.framework_code, release);
  }
  if (!current.size) return 0;

  const dpdpa = current.get('dpdpa');
  if (dpdpa) {
    // Superseded assessments are already closed records; a live or approved one
    // pinned to an older catalogue is what needs a decision.
    const stale = db.prepare(`SELECT id, workspace_id, title, status, catalog_version, catalog_hash
        FROM dpdpa_gap_assessments
        WHERE status!='Superseded' AND catalog_hash IS NOT NULL AND catalog_hash<>?`).all(dpdpa.catalog_hash);
    for (const row of stale) {
      const approved = row.status === 'Approved';
      if (notify(row.workspace_id, null, 'catalog_superseded', approved ? 'high' : 'medium',
        `DPDPA assessment pinned to a superseded catalogue: ${row.title}`,
        `This assessment is pinned to catalogue ${row.catalog_version || 'unknown'}, but ${dpdpa.catalog_version} is now the registered version. `
        + (approved
          ? 'The approved snapshot stays valid as a record of what was assessed, and it no longer reflects the current obligations. Reassess against the new catalogue.'
          : 'Conclusions recorded here will freeze against the older catalogue. Create a reassessment on the current version before submitting.'),
        `/workspaces/${row.workspace_id}/dpdpa/assessments/${row.id}`, 30)) count++;
    }
  }
  return count;
}

const JOBS = [
  ['sessionSweep',            jobSessionSweep],
  ['restoreDrill',            jobRestoreDrill],
  ['documentReviewReminders', jobDocumentReviewReminders],
  ['taskRecurrence',           jobTaskRecurrence],
  ['overrideExpiry',           jobOverrideExpiry],
  ['supplierReviewReminders',  jobSupplierReviewReminders],
  ['questionnaireResponseReminders', jobQuestionnaireResponseReminders],
  ['nonconformityReminders',   jobNonconformityReminders],
  ['controlReviewReminders',   jobControlReviewReminders],
  ['accessReviewKickoff',      jobAccessReviewKickoff],
  ['tprmReassessmentQueue',    jobTprmReassessmentQueue],
  ['engagementDeliveryAlerts', jobEngagementDeliveryAlerts],
  ['catalogSupersession',      jobCatalogSupersession]
];

function runAllJobs() {
  const out = {};
  for (const [name, fn] of JOBS) {
    try { out[name] = fn(); }
    catch (e) { out[name] = 'error: ' + e.message; console.error(`[jobs.${name}]`, e); }
  }
  return out;
}

let timer = null;
let startupTimer = null;

function stop() {
  if (startupTimer) clearTimeout(startupTimer);
  if (timer) clearInterval(timer);
  startupTimer = null;
  timer = null;
}

function start(intervalMinutes = 60) {
  // Run once on startup, then every interval.
  // unref: background schedules must not keep an otherwise-finished process
  // alive (in-process test boots exit naturally; prod's HTTP server holds the loop).
  stop();
  const parsedMinutes = Number(intervalMinutes);
  const intervalMs = (Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : 60) * 60 * 1000;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runAllJobs();
  }, 5000);
  startupTimer.unref();
  timer = setInterval(runAllJobs, intervalMs);
  timer.unref();
}

function status() {
  return { startupScheduled: !!startupTimer, intervalScheduled: !!timer };
}

module.exports = {
  runAllJobs,
  start,
  stop,
  status,
  notify,
  jobRestoreDrill,
  jobEngagementDeliveryAlerts,
  jobTprmReassessmentQueue,
};
