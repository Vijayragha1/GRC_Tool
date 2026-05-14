// Authorization policy for the NIST CSF module.
//
// CSF engagements have their own role layer on top of workspace membership.
// The handoff design (Section 3) calls for policy-based checks rather than
// hardcoded role tests scattered across routes — every CSF route asks this
// module "can this user do X to this engagement?" and gets a clean yes/no.
//
// Engagement roles (stored as `role_on_engagement` on csf_engagement_assignments):
//   ENGAGEMENT_LEAD  — full control on this engagement, sign-off, publish
//   CONSULTANT       — score Subcategories, attach evidence, draft findings
//   REVIEWER         — read + comment, mark Reviewed / Needs Revision
//   ANALYST          — collect evidence, draft narratives, propose findings;
//                      explicitly cannot assign CMMI scores
//
// Workspace roles (existing app) layer on top:
//   firm owners + consultants can create engagements; everyone with workspace
//   access can list engagements they're assigned to.
//
// Prototype note: auth is currently disabled at the app level. We still wire
// these checks so when real auth lands in Stage 13 the structure is in place.
// In auth-disabled mode `req.user` is the firm-owner stub, which passes every
// gate naturally.

const ENGAGEMENT_ROLES = ['ENGAGEMENT_LEAD', 'CONSULTANT', 'REVIEWER', 'ANALYST'];

function isFirmOperator(user) {
  if (!user) return false;
  return user.user_type === 'firm' || user.role === 'firm_owner';
}

function rolesOnEngagement(db, userId, engagementId) {
  if (!userId || !engagementId) return [];
  const rows = db.prepare(`
    SELECT role_on_engagement FROM csf_engagement_assignments
    WHERE user_id = ? AND engagement_id = ?
  `).all(userId, engagementId);
  return rows.map(r => r.role_on_engagement);
}

function hasRole(db, userId, engagementId, ...wanted) {
  const roles = rolesOnEngagement(db, userId, engagementId);
  return wanted.some(w => roles.includes(w));
}

// ---- Engagement-level checks ------------------------------------------------

function canCreateEngagement(user, workspace) {
  if (!user || !workspace) return false;
  // Firm operators (firm_owner, consultants) on this workspace can create.
  // Workspace role 'reviewer' or client roles cannot.
  if (isFirmOperator(user)) return true;
  const role = workspace.role;
  return ['firm_owner', 'consultant', 'client_admin'].includes(role);
}

function canViewEngagement(db, user, engagement) {
  if (!user || !engagement) return false;
  // Firm owners can view everything in their firm (relaxed for prototype).
  if (isFirmOperator(user)) return true;
  // Assigned in any role → can view.
  return rolesOnEngagement(db, user.id, engagement.id).length > 0;
}

function canEditEngagementMeta(db, user, engagement) {
  if (!engagement || ['Closed'].includes(engagement.status)) return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD');
}

function canAssignMembers(db, user, engagement) {
  if (!engagement) return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD');
}

// ---- Subcategory-level checks (used in later stages) ------------------------

function canCollectEvidence(db, user, engagement) {
  if (!engagement || ['Approved', 'Published', 'Closed'].includes(engagement.status)) return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD', 'CONSULTANT', 'ANALYST');
}

function canDraftNarrative(db, user, engagement) {
  // Same gate as evidence collection — Analysts can draft, scoring is separate.
  return canCollectEvidence(db, user, engagement);
}

function canScoreSubcategory(db, user, engagement) {
  // Analyst is explicitly excluded per handoff Section 3.
  if (!engagement || ['Approved', 'Published', 'Closed'].includes(engagement.status)) return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD', 'CONSULTANT');
}

function canReview(db, user, engagement) {
  if (!engagement) return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD', 'REVIEWER');
}

function canApprove(db, user, engagement) {
  // Only the Engagement Lead approves.
  if (!engagement) return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD');
}

function canPublish(db, user, engagement) {
  // Only the Engagement Lead publishes.
  if (!engagement || engagement.status !== 'Approved') return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD');
}

module.exports = {
  ENGAGEMENT_ROLES,
  rolesOnEngagement,
  hasRole,
  canCreateEngagement,
  canViewEngagement,
  canEditEngagementMeta,
  canAssignMembers,
  canCollectEvidence,
  canDraftNarrative,
  canScoreSubcategory,
  canReview,
  canApprove,
  canPublish,
};
