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

const { db, logAction } = require('../db');
const email = require('./email');

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
        `/workspaces/${s.workspace_id}/vendors/${s.id}?tab=reviews`)) count++;
    } else if (days <= 30) {
      if (notify(s.workspace_id, null, 'supplier_review_due', 'medium',
        `Supplier review due in ${days}d: ${s.name}`, '',
        `/workspaces/${s.workspace_id}/vendors/${s.id}?tab=reviews`, 30)) count++;
    }
  }
  return count;
}

// === Job: nonconformity corrective-action reminders ===
// Overdue and due-soon corrective actions. The day count is kept OUT of the
// title on purpose so notify()'s (workspace, category, title) dedup holds — a
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
        `Was due ${r.due_date} — ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago. ${sev}.${owner}`,
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

// === Job: vendor questionnaire non-response nudges ===
// A questionnaire was emailed to a vendor (external_token set, sent_at known) but
// no response has come back after REMIND_AFTER_DAYS, and it hasn't expired or been
// resolved internally. Nudge the engagement lead once. The title is stable (no day
// count) so notify()'s dedup holds — the nudge fires a single time per share until
// it's read or dismissed; the body anchors to the send date rather than a relative
// count that would otherwise freeze at first-fire.
function jobQuestionnaireResponseReminders() {
  const REMIND_AFTER_DAYS = 7;
  const rows = db.prepare(`SELECT q.id, q.workspace_id, q.template_name, q.sent_at, q.supplier_id,
      s.name AS supplier_name,
      julianday('now') - julianday(q.sent_at) AS age
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    WHERE q.external_token IS NOT NULL
      AND q.external_completed_at IS NULL
      AND q.sent_at IS NOT NULL
      AND q.status NOT IN ('responded','reviewed')
      AND (q.external_expires_at IS NULL OR q.external_expires_at > datetime('now'))`).all();
  let count = 0;
  for (const r of rows) {
    if (Math.round(r.age) < REMIND_AFTER_DAYS) continue;
    if (notify(r.workspace_id, null, 'questionnaire_no_response', 'medium',
      `Awaiting questionnaire response: ${r.supplier_name}`,
      `No reply yet to the ${r.template_name} sent on ${(r.sent_at || '').slice(0,10)}. Consider a nudge or resend.`,
      `/workspaces/${r.workspace_id}/vendors/${r.supplier_id}/questionnaires/${r.id}`, 14)) count++;
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

// Monthly restore drill: proves the newest backup actually restores. Gated
// on the last recorded drill so the hourly tick is a no-op 719 times out of
// 720. See lib/restore-check.js.
function jobRestoreDrill() {
  const restore = require('./restore-check');
  const last = restore.lastDrill();
  if (last && (Date.now() - new Date(last.ran_at + 'Z').getTime()) < 30 * 86400000) return 'not due';
  const r = restore.runDrill();
  return r.ok ? `passed (${r.ms}ms)` : `FAILED: ${r.error}`;
}

const JOBS = [
  ['restoreDrill',            jobRestoreDrill],
  ['documentReviewReminders', jobDocumentReviewReminders],
  ['taskRecurrence',           jobTaskRecurrence],
  ['overrideExpiry',           jobOverrideExpiry],
  ['supplierReviewReminders',  jobSupplierReviewReminders],
  ['questionnaireResponseReminders', jobQuestionnaireResponseReminders],
  ['nonconformityReminders',   jobNonconformityReminders],
  ['controlReviewReminders',   jobControlReviewReminders],
  ['accessReviewKickoff',      jobAccessReviewKickoff]
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
function start(intervalMinutes = 60) {
  // Run once on startup, then every interval.
  setTimeout(() => { runAllJobs(); }, 5000);
  if (timer) clearInterval(timer);
  timer = setInterval(runAllJobs, intervalMinutes * 60 * 1000);
}

module.exports = { runAllJobs, start, notify };
