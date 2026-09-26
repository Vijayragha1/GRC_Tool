'use strict';

const rbac = require('./rbac');

function actorContext(db, workspace, actor) {
  if (!actor || !workspace) return { active: false, permissions: new Set() };
  // Callers may hold a prior session or queue snapshot. Authorization always
  // uses the current account and owning firm, never cached role/activity fields.
  actor=db.prepare('SELECT id,user_type,firm_id,firm_role,active FROM users WHERE id=?').get(actor.id);
  workspace=db.prepare('SELECT id,firm_id FROM workspaces WHERE id=?').get(workspace.id);
  if(!actor || !workspace || !actor.active)return {active:false,permissions:new Set()};
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id, actor.id);
  const firm = actor.user_type === 'firm';
  const firmRole = rbac.normalizeRole(actor.firm_role);
  const memberRole = rbac.normalizeRole(member?.role);
  const crossView = firm && (rbac.isManager(firmRole) || rbac.rolePermissions(firmRole).includes('firm.cross_view'));
  const role = firm ? (!crossView && rbac.FIRM_ROLES.includes(memberRole) ? memberRole : firmRole) : memberRole;
  const active = firm ? Number(actor.firm_id) === Number(workspace.firm_id) && (crossView || !!member) : !!member;
  const permissions = rbac.effectivePermissions(role, rbac.activeOverrides(db, workspace.id, actor.id));
  return { active, firm, role, permissions, coordinator: !firm && ['client_owner','isms_manager'].includes(role) };
}

// Shared by the queue, detail pages and commands. Visibility is never decision authority.
function clientWorkPolicy({ db, workspace, actor, sourceType, row }) {
  const context = actorContext(db, workspace, actor);
  const has = permission => rbac.hasPermission(context.permissions, permission);
  const no = { visible: false, commands: [], allowedCommands: [], canCoordinate: false, canRespond: false };
  if (!context.active || !row || (row.workspace_id != null && Number(row.workspace_id) !== Number(workspace.id))) return no;
  let visible = false, commands = [], canCoordinate = false, canRespond = false;
  if (['request','client_request'].includes(sourceType)) {
    const released = !!row.released_at;
    visible = has('client_portal.view') && (context.firm || (released && (context.coordinator || Number(row.assignee_id) === Number(actor.id))));
    canCoordinate = visible && has('client_request.coordinate') && (context.firm || context.coordinator);
    canRespond = visible && has('client_request.respond') && (context.firm || canCoordinate || Number(row.assignee_id) === Number(actor.id));
    if (canRespond && ['open','changes_requested'].includes(row.status)) commands.push('in_progress');
    if (canRespond && ['open','in_progress','changes_requested'].includes(row.status)) commands.push('submitted');
    // Legacy manage grants never promote a client account to consultant reviewer.
    if (context.firm && has('client_request.review')) {
      if (row.status === 'submitted') commands.push('accepted','changes_requested');
      if (row.status === 'accepted') commands.push('in_progress');
    }
    if (visible && context.firm && has('client_request.cancel')) {
      if (!['accepted','cancelled'].includes(row.status)) commands.push('cancelled');
      if (row.status === 'cancelled') commands.push('open');
    }
  } else if (['deliverable','engagement_deliverable'].includes(sourceType)) {
    visible = has('client_portal.view') && !!row.client_visible && (context.firm ||
      ((row.owner_id != null || row.approver_id != null) && (context.coordinator || [row.owner_id,row.approver_id].some(id => Number(id) === Number(actor.id)))));
    const status = row.effective_status || row.status;
    canRespond = visible && has('client_request.respond') && (context.firm || (context.coordinator && has('client_request.coordinate')) || Number(row.owner_id) === Number(actor.id));
    if (canRespond && ['draft','changes_requested','workspace_verified'].includes(status)) commands.push('submit');
    if (visible && has('client_request.respond') && Number(row.approver_id) === Number(actor.id) && ['submitted','workspace_verified'].includes(status)) commands.push('accept','changes');
  } else if (['policy','document_approval'].includes(sourceType)) {
    const documentId = row.document_id || row.id;
    const approval = db.prepare(`SELECT da.* FROM doc_approvers da JOIN generated_docs d ON d.id=da.document_id AND d.workspace_id=da.workspace_id
      JOIN doc_versions v ON v.id=da.version_id AND v.workspace_id=da.workspace_id AND v.status='in_review'
      WHERE da.workspace_id=? AND da.document_id=? AND da.user_id=? AND d.current_version_id=da.version_id AND da.decision IS NULL ORDER BY da.sequence LIMIT 1`).get(workspace.id,documentId,actor.id);
    visible = has('client_portal.view') && (context.firm || !!approval);
    const next = approval && require('./doc-approvals').nextPending(db, approval.version_id);
    if (visible && has('document.review') && next?.kind === 'internal' && Number(next.row.id) === Number(approval.id)) commands.push('approve','changes');
  } else if (['validation','workpaper_validation','client_validation'].includes(sourceType)) {
    visible = has('client_portal.view') && !!row.client_visible && Number(row.client_validator_id) === Number(actor.id);
    if (visible && row.status === 'client_validation' && has('client_request.respond')) commands.push('validate','changes');
  } else if (sourceType === 'csf_validation') {
    visible = has('client_portal.view') && (context.coordinator || Number(row.assignee_id) === Number(actor.id));
    if (visible && row.status === 'Reviewed' && row.client_validation_status === 'requested' && has('client_request.respond')) commands.push('validate','changes');
  } else if (sourceType === 'tprm_decision') {
    visible = !context.firm && has('tprm.client_portal.view');
    if (visible && has('tprm.client_decide') && (!row.client_decision_authority_id || Number(row.client_decision_authority_id) === Number(actor.id))) commands.push('client_decide');
  } else if (sourceType === 'tprm_condition') {
    visible = !context.firm && has('tprm.client_portal.view') && row.owner_type === 'client';
    if (visible && Number(row.owner_user_id) === Number(actor.id) && ['open','in_progress'].includes(row.status)) commands.push('submit_condition_evidence');
  }
  return { visible, commands, allowedCommands: commands, canCoordinate, canRespond, context };
}

module.exports = { actorContext, clientWorkPolicy, policyFor: clientWorkPolicy };
