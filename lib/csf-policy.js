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

// ---- Subcategory state machine (Stage 3) ------------------------------------
//
// Linear progression per handoff Section 4. Transitions can go forward only
// in v1; backward "Needs Revision" returns are wired through Reviewer comments
// in Stage 4 rather than as direct state transitions.

const SUBCATEGORY_STATES = [
  'Not Started',        // 0 - default on row creation
  'In Progress',        // 1 - work started
  'Evidence Collected', // 2 - evidence gate: scoring unlocked at this point (#18)
  'Draft Complete',     // 3 - narrative + score drafted
  'Reviewed',           // 4 - Reviewer signed off
  'Approved',           // 5 - Lead approved; ready for engagement-level publish
];

function stateIndex(state) {
  return SUBCATEGORY_STATES.indexOf(state);
}

function nextStateOptions(currentState) {
  const i = stateIndex(currentState);
  if (i === -1 || i === SUBCATEGORY_STATES.length - 1) return [];
  return [SUBCATEGORY_STATES[i + 1]];
}

// Each forward transition is gated by who initiated it. Permissions intentionally
// overlap with the score/evidence/review/approve gates above so role behaviour
// is consistent across the module.
function canTransitionTo(db, user, engagement, assessment, toState) {
  if (!engagement || !assessment) return false;
  if (['Approved', 'Published', 'Closed'].includes(engagement.status) && toState !== 'Approved') return false;

  const from = assessment.status;
  const fi = stateIndex(from), ti = stateIndex(toState);
  if (fi === -1 || ti === -1) return false;
  if (ti !== fi + 1) return false;  // forward-only, one step at a time

  switch (toState) {
    case 'In Progress':
      // Anyone working the engagement can start work.
      return canCollectEvidence(db, user, engagement);
    case 'Evidence Collected':
      // Analyst signs off that evidence is gathered.
      return canCollectEvidence(db, user, engagement);
    case 'Draft Complete':
      // Requires the scoring permission - Analyst cannot make this transition
      // because Draft Complete means a CMMI score has been entered.
      return canScoreSubcategory(db, user, engagement);
    case 'Reviewed':
      return canReview(db, user, engagement);
    case 'Approved':
      return canApprove(db, user, engagement);
    default:
      return false;
  }
}

// Score gate: per locked decision #18, current_score / target_score cannot be
// entered until status has reached Evidence Collected.
function canEnterScore(db, user, engagement, assessment) {
  if (!engagement || !assessment) return false;
  if (stateIndex(assessment.status) < stateIndex('Evidence Collected')) return false;
  return canScoreSubcategory(db, user, engagement);
}

// "Too thin" detector for the soft warning per locked decision #13. Returns an
// array of human-readable warnings (empty array = nothing to warn about). The
// route handler shows these on the UI but does NOT block submission.
function thinnessWarnings(assessment, evidenceCount) {
  const warnings = [];
  const narrative = (assessment && assessment.narrative) || '';
  if (narrative.trim().length < 80) {
    warnings.push('Narrative is short - audit-grade write-ups usually take 3-5 sentences.');
  }
  if (!evidenceCount || evidenceCount === 0) {
    warnings.push('No evidence items attached. At least one file, link, or interview attribution is expected.');
  }
  return warnings;
}

// Lazy assessment-row seeding. Inserts one row per CSF subcategory in the
// engagement's catalog version, with status='Not Started', if none exist for
// the engagement yet. Idempotent: subsequent calls do nothing once seeded.
function ensureAssessmentRows(db, engagement) {
  if (!engagement) return 0;
  const existing = db.prepare(`SELECT COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=?`).get(engagement.id).c;
  if (existing > 0) return 0;
  const subs = db.prepare(`SELECT id FROM csf_subcategories WHERE catalog_version=? ORDER BY display_order`).all(engagement.catalog_version);
  const ins = db.prepare(`INSERT INTO csf_subcategory_assessments (engagement_id, subcategory_id, status) VALUES (?, ?, 'Not Started')`);
  const seed = db.transaction(() => subs.forEach(s => ins.run(engagement.id, s.id)));
  seed();
  return subs.length;
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
  // Stage 3
  SUBCATEGORY_STATES,
  stateIndex,
  nextStateOptions,
  canTransitionTo,
  canEnterScore,
  thinnessWarnings,
  ensureAssessmentRows,
};
