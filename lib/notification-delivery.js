'use strict';

const rbac = require('./rbac');
const crypto = require('node:crypto');
const enc = require('./encryption');
const { clientWorkPolicy, actorContext } = require('./client-work-policy');

function sourceFromLink(link) {
  const match = String(link || '').match(/^\/workspaces\/(\d+)\/client-portal\/(requests|deliverables|policies|workpapers|tprm)\/(\d+)(?:[/?#]|$)/);
  if (!match) return null;
  return { workspaceId: Number(match[1]), sourceType: ({ requests:'request',deliverables:'deliverable',policies:'policy',workpapers:'validation',tprm:'tprm' })[match[2]], sourceId: match[3] };
}

function canRead(db, actor, notification) {
  if (!actor || actor.active === 0 || (notification.user_id != null && Number(notification.user_id) !== Number(actor.id))) return false;
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(notification.workspace_id);
  if (!workspace) return false;
  const context = actorContext(db, workspace, actor);
  if (!context.active) return false;
  if (context.firm) {
    const assigned = rbac.isManager(actor.firm_role) || rbac.rolePermissions(actor.firm_role).includes('firm.cross_view') ||
      !!db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id,actor.id);
    if (!assigned) return false;
    const sourceType=notification.source_type || sourceFromLink(notification.link)?.sourceType;
    const required=({request:'client_portal.view',deliverable:'client_portal.view',policy:'document.view',validation:'control.view',assessment_review:'control.view',report:'report.view',report_revision:'report.view',tprm:'tprm.third_party.view'})[sourceType];
    return !required || rbac.hasPermission(context.permissions,required);
  }
  if (notification.user_id == null || !rbac.hasPermission(context.permissions,'client_portal.view')) return false; // Firm broadcasts are never client disclosures.
  const source = notification.source_type ? { sourceType: notification.source_type, sourceId: notification.source_id } : sourceFromLink(notification.link);
  if (!source) return false;
  const type = source.sourceType, id = source.sourceId;
  if (type === 'request') {
    const row = db.prepare('SELECT * FROM client_requests WHERE workspace_id=? AND id=?').get(workspace.id,id);
    return clientWorkPolicy({ db, workspace, actor, sourceType:type, row }).visible;
  }
  if (type === 'deliverable') {
    const row = db.prepare('SELECT * FROM engagement_delivery_deliverables WHERE workspace_id=? AND id=?').get(workspace.id,id);
    return !!row && require('./engagement-delivery').isDeliverableInOutcomeScope(db,workspace,id) && clientWorkPolicy({ db, workspace, actor, sourceType:type, row }).visible;
  }
  if (type === 'policy') {
    if (clientWorkPolicy({ db,workspace,actor,sourceType:type,row:{ id,workspace_id:workspace.id } }).visible) return true;
    return !!db.prepare(`SELECT 1 FROM client_requests WHERE workspace_id=? AND document_id=? AND released_at IS NOT NULL
      AND status!='cancelled' ${context.coordinator ? '' : 'AND assignee_id=?'} LIMIT 1`).get(workspace.id,id,...(context.coordinator ? [] : [actor.id]));
  }
  if (type === 'validation') {
    const row = db.prepare('SELECT * FROM consultant_workpapers WHERE workspace_id=? AND id=?').get(workspace.id,id);
    return clientWorkPolicy({db,workspace,actor,sourceType:type,row}).visible;
  }
  if (type === 'tprm') return rbac.hasPermission(context.permissions,'tprm.client_portal.view') &&
    !!db.prepare(`SELECT 1 FROM suppliers WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspace.id,id);
  return false;
}

// Call within the source mutation transaction. A unique event key makes retries
// harmless; recording an event never sends an email before the transaction commits.
function enqueue(db, input) {
  const { workspaceId, actorId, eventKey, sourceType, sourceId, title, body, link, severity = 'info' } = input;
  if (!eventKey || !sourceType || sourceId == null) throw new Error('Notification source and stable event key are required.');
  const ids = [...new Set(input.recipientIds || [])].map(Number).filter(id => id > 0 && id !== Number(actorId));
  return db.transaction(() => ids.map(userId => {
    const existing = db.prepare('SELECT notification_id FROM notification_outbox WHERE event_key=? AND recipient_id=?').get(eventKey,userId);
    if (existing) return existing.notification_id;
    const actor = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(userId);
    const candidate = { workspace_id:workspaceId,user_id:userId,source_type:sourceType,source_id:String(sourceId),link };
    if (!canRead(db,actor,candidate)) return null;
    const workspace = db.prepare('SELECT encryption_enabled FROM workspaces WHERE id=?').get(workspaceId);
    const notificationId = Number(db.prepare(`INSERT INTO notifications(workspace_id,user_id,category,severity,title,body,link)
      VALUES (?,?,'collaboration',?,?,?,?)`).run(workspaceId,userId,severity,title,enc.encryptIfNeeded(body || null,workspaceId,!!workspace.encryption_enabled),link).lastInsertRowid);
    db.prepare(`INSERT INTO notification_outbox(event_key,workspace_id,recipient_id,notification_id,source_type,source_id)
      VALUES (?,?,?,?,?,?)`).run(eventKey,workspaceId,userId,notificationId,sourceType,String(sourceId));
    return notificationId;
  }).filter(Boolean))();
}

function authorizedRows(db, {workspaceId, actor, unreadOnly = false}) {
  const rows = db.prepare(`SELECT n.*,o.source_type,o.source_id,
    COALESCE(r.read_at,n.read_at) actor_read_at,COALESCE(r.dismissed_at,n.dismissed_at) actor_dismissed_at
    FROM notifications n LEFT JOIN notification_receipts r ON r.notification_id=n.id AND r.user_id=?
    LEFT JOIN notification_outbox o ON o.notification_id=n.id AND o.recipient_id=?
    WHERE n.workspace_id=? AND (n.user_id=? OR n.user_id IS NULL)
      AND (n.expires_at IS NULL OR n.expires_at>CURRENT_TIMESTAMP)
    ORDER BY n.created_at DESC,n.id DESC`).all(actor.id,actor.id,workspaceId,actor.id);
  return rows.filter(row => !row.actor_dismissed_at && (!unreadOnly || !row.actor_read_at) && canRead(db,actor,row));
}

function list(db, options) {
  return authorizedRows(db,options).slice(0,Math.min(500,Math.max(1,options.limit || 100)))
    .map(row=>({...row,body:enc.decryptIfNeeded(row.body,options.workspaceId)}));
}

function countUnread(db, options) {
  return authorizedRows(db,{...options,unreadOnly:true}).length;
}

function mark(db,{workspaceId,actor,notificationId,action}) {
  if (!['read','dismiss'].includes(action)) throw new Error('Invalid update action.');
  const row = db.prepare(`SELECT n.*,o.source_type,o.source_id FROM notifications n LEFT JOIN notification_outbox o ON o.notification_id=n.id
    WHERE n.id=? AND n.workspace_id=?`).get(notificationId,workspaceId);
  if (!row || !canRead(db,actor,row)) return false;
  const column = action === 'read' ? 'read_at' : 'dismissed_at';
  db.prepare(`INSERT INTO notification_receipts(notification_id,user_id,${column}) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(notification_id,user_id) DO UPDATE SET ${column}=CURRENT_TIMESTAMP`).run(notificationId,actor.id);
  return true;
}

function markAllRead(db,options) {
  return db.transaction(()=>authorizedRows(db,{...options,unreadOnly:true})
    .reduce((count,row)=>count+Number(mark(db,{...options,notificationId:row.id,action:'read'})),0))();
}

async function dispatchPending(db, {send, limit = 25, now = new Date()} = {}) {
  const timestamp = now.toISOString();
  const stale = new Date(now.getTime()-10*60*1000).toISOString();
  const rows = db.prepare(`SELECT id FROM notification_outbox WHERE (status='pending' AND julianday(available_at)<=julianday(?))
    OR (status='sending' AND julianday(locked_at)<julianday(?)) ORDER BY id LIMIT ?`).all(timestamp,stale,limit);
  const result = {sent:0,cancelled:0,retried:0};
  for (const candidate of rows) {
    const claimed = db.prepare(`UPDATE notification_outbox SET status='sending',locked_at=?,attempts=attempts+1 WHERE id=? AND
      ((status='pending' AND julianday(available_at)<=julianday(?)) OR (status='sending' AND julianday(locked_at)<julianday(?)))`).run(timestamp,candidate.id,timestamp,stale);
    if (!claimed.changes) continue;
    const row = db.prepare(`SELECT o.*,n.user_id,n.title,n.body,n.link,n.category FROM notification_outbox o JOIN notifications n ON n.id=o.notification_id WHERE o.id=?`).get(candidate.id);
    const recipient = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(row.recipient_id);
    if (!canRead(db,recipient,row) || !recipient.email || recipient.email_notify === 'off') {
      db.prepare(`UPDATE notification_outbox SET status='cancelled',locked_at=NULL WHERE id=?`).run(row.id); result.cancelled++; continue;
    }
    try {
      const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(row.workspace_id);
      const delivery = await (send || require('./email').sendNotificationEmail)({ toEmail:recipient.email,toName:recipient.name,title:row.title,body:enc.decryptIfNeeded(row.body,row.workspace_id),link:row.link,
        workspaceId:workspace.id,workspaceName:workspace.brand_display_name || workspace.client_name,firmId:workspace.firm_id,category:row.category,idempotencyKey:'outbox:'+crypto.createHash('sha256').update(`${row.workspace_id}:${row.event_key}:${row.recipient_id}:email`).digest('hex') });
      if (delivery?.ok === false) throw new Error(delivery.error || 'The email provider did not accept this message.');
      db.prepare(`UPDATE notification_outbox SET status='sent',sent_at=?,locked_at=NULL,last_error=NULL WHERE id=? AND status='sending'`).run(timestamp,row.id);
      result.sent++;
    } catch (error) {
      const retryAt = new Date(now.getTime()+Math.min(3600000,30000*2**Math.min(row.attempts,7))).toISOString();
      db.prepare(`UPDATE notification_outbox SET status='pending',available_at=?,locked_at=NULL,last_error=? WHERE id=?`).run(retryAt,String(error.message || 'Delivery failed').slice(0,500),row.id);
      result.retried++;
    }
  }
  return result;
}

function start(db, options = {}) {
  let running = false;
  const tick = async () => { if (running) return; running=true; try { await dispatchPending(db,options); } finally { running=false; } };
  const timer = setInterval(() => tick().catch(error => console.error('[notification-delivery]',error.message)),options.intervalMs || 30000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { enqueue,canRead,list,countUnread,mark,markAllRead,dispatchPending,start,sourceFromLink };
