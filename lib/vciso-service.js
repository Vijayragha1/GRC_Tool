'use strict';

const consulting = require('./consulting-delivery');

class VcisoServiceError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'VcisoServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status, details) {
  throw new VcisoServiceError(code, message, status, details);
}

function currentService(db, workspaceId) {
  return db.prepare(`SELECT v.*,e.engagement_code,e.name engagement_name,e.status engagement_status
    FROM vciso_services v
    INNER JOIN consulting_engagements e ON e.id=v.engagement_id
    WHERE v.workspace_id=? AND v.status IN ('active','on_hold')
    ORDER BY v.id DESC LIMIT 1`).get(Number(workspaceId)) || null;
}

function nextCode(db, workspaceId) {
  const base = `VCISO-${String(workspaceId).padStart(4, '0')}`;
  let code = base;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM consulting_engagements WHERE workspace_id=? AND engagement_code=?')
    .get(Number(workspaceId), code)) code = `${base}-${suffix++}`;
  return code;
}

function enableService(db, input) {
  const workspaceId = Number(input.workspaceId);
  const actorId = Number(input.actorId);
  if (!Number.isInteger(workspaceId) || workspaceId < 1) fail('VCISO_WORKSPACE_INVALID', 'Choose a valid client workspace.', 400);
  if (!Number.isInteger(actorId) || actorId < 1) fail('VCISO_ACTOR_INVALID', 'A valid service owner is required.', 400);

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  if (!workspace) fail('VCISO_WORKSPACE_NOT_FOUND', 'Client workspace not found.', 404);
  const actor = db.prepare("SELECT id FROM users WHERE id=? AND firm_id=? AND user_type='firm' AND active=1")
    .get(actorId, workspace.firm_id);
  if (!actor) fail('VCISO_ACTOR_OUT_OF_SCOPE', 'The vCISO owner must be an active user in the client firm.', 403);

  const existing = currentService(db, workspaceId);
  if (existing) return existing;

  let frameworks = [];
  try { frameworks = JSON.parse(workspace.frameworks || '[]'); } catch (_) {}
  if (!Array.isArray(frameworks)) frameworks = [];
  const reason = String(input.reason || 'Enabled during governed client onboarding.').trim();
  if (reason.length < 10 || reason.length > 1000) fail('VCISO_REASON_INVALID', 'Record a concise reason for enabling the vCISO service.', 400);

  const serviceId = db.transaction(() => {
    const engagementId = Number(db.prepare(`INSERT INTO consulting_engagements
      (workspace_id,engagement_code,name,engagement_type,framework_scope_json,scope_statement,status,
       lead_consultant_id,start_date,created_by)
      VALUES (?,?,?,'advisory',?,?,'active',?,date('now'),?)`)
      .run(workspaceId, nextCode(db, workspaceId), `${workspace.client_name} vCISO advisory`,
        JSON.stringify([...new Set(frameworks.map(String))]), workspace.scope || null, actorId, actorId).lastInsertRowid);
    db.prepare(`INSERT INTO consulting_engagement_team
      (engagement_id,user_id,role,assigned_by) VALUES (?,?,'engagement_lead',?)`)
      .run(engagementId, actorId, actorId);
    db.prepare("INSERT INTO engagement_commercials (engagement_id,billing_model,updated_by) VALUES (?,'retainer',?)")
      .run(engagementId, actorId);
    consulting.ensureMethodology(db, workspace.firm_id, actorId);
    consulting.event(db, workspaceId, engagementId, actorId, 'engagement', engagementId, 'vciso_service_activated', {
      service: 'vciso', activation_reason: reason, frameworks,
    });
    return Number(db.prepare(`INSERT INTO vciso_services
      (workspace_id,engagement_id,status,activation_reason,created_by)
      VALUES (?,?,'active',?,?)`).run(workspaceId, engagementId, reason, actorId).lastInsertRowid);
  })();
  return db.prepare(`SELECT v.*,e.engagement_code,e.name engagement_name,e.status engagement_status
    FROM vciso_services v INNER JOIN consulting_engagements e ON e.id=v.engagement_id
    WHERE v.id=?`).get(serviceId);
}

module.exports = { VcisoServiceError, currentService, enableService };
