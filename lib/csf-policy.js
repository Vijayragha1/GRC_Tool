// Authorization policy for the NIST CSF module.
//
// CSF engagements have their own role layer on top of workspace membership.
// The handoff design (Section 3) calls for policy-based checks rather than
// hardcoded role tests scattered across routes; every CSF route asks this
// module "can this user do X to this engagement?" and gets a clean yes/no.
//
// Engagement roles (stored as `role_on_engagement` on csf_engagement_assignments):
//   ENGAGEMENT_LEAD: full control on this engagement, sign-off, publish
//   CONSULTANT:      score Subcategories, attach evidence, draft findings
//   REVIEWER:        read + comment, mark Reviewed / Needs Revision
//   ANALYST:         collect evidence, draft narratives, propose findings;
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
  // Same gate as evidence collection. Analysts can draft, scoring is separate.
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

// ---- Stage 4: Findings, Recommendations, Reviewer comments ------------------

const FINDING_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const FINDING_STATUSES = ['Draft', 'Reviewed', 'Approved', 'Published', 'Withdrawn'];
const RECOMMENDATION_EFFORTS = ['S', 'M', 'L', 'XL'];
const RECOMMENDATION_PRIORITIES = ['HIGH', 'MED', 'LOW'];
const ROADMAP_PHASES = ['0_3M', '3_6M', '6_12M', '12M_PLUS'];

// Analysts can propose findings per Section 3, same gate as evidence/narrative
// work. Engagement Lead and Consultant can also create. Reviewers read-only.
function canCreateFinding(db, user, engagement) {
  return canCollectEvidence(db, user, engagement);
}

function canEditFinding(db, user, engagement, finding) {
  if (!finding) return false;
  if (finding.status === 'Published') return false;  // immutable after publish
  return canCollectEvidence(db, user, engagement);
}

function canDeleteFinding(db, user, engagement, finding) {
  if (!finding) return false;
  if (finding.status === 'Published') return false;
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD', 'CONSULTANT');
}

function canManageRecommendations(db, user, engagement) {
  return canCollectEvidence(db, user, engagement);
}

// Reviewer comments: Reviewer (and Lead) can post; the commenter or the
// Engagement Lead can resolve.
function canPostReviewerComment(db, user, engagement) {
  return canReview(db, user, engagement);
}

function canResolveComment(db, user, engagement, comment) {
  if (!comment) return false;
  if (isFirmOperator(user)) return true;
  if (user.id === comment.commenter_id) return true;  // own comment
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD');
}

// "Needs Revision" reopening: when a reviewer files a comment with
// requires_revision=1 on an assessment in Reviewed state, the assessment
// reverts to Draft Complete and the comment must be resolved (or withdrawn)
// before re-reaching Reviewed. The route handler calls this when the comment
// is posted.
function shouldReopenAssessment(comment, assessment) {
  if (!comment || !assessment) return false;
  if (!comment.requires_revision) return false;
  return assessment.status === 'Reviewed';
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
  // Stage 4
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  RECOMMENDATION_EFFORTS,
  RECOMMENDATION_PRIORITIES,
  ROADMAP_PHASES,
  canCreateFinding,
  canEditFinding,
  canDeleteFinding,
  canManageRecommendations,
  canPostReviewerComment,
  canResolveComment,
  shouldReopenAssessment,
};

// ---- Engagement-level state transitions (Stage 7) ---------------------------
// The engagement itself moves through a state machine: Draft -> In Progress ->
// Under Review -> Approved -> Published -> Closed. Publish is handled by
// canPublish + the publish route (creates a version snapshot). The other
// transitions just bump the status field; only the Engagement Lead can advance.
const ENGAGEMENT_STATES = ['Draft', 'In Progress', 'Under Review', 'Approved', 'Published', 'Closed'];

function nextEngagementState(current) {
  const i = ENGAGEMENT_STATES.indexOf(current);
  if (i === -1 || i >= ENGAGEMENT_STATES.length - 1) return null;
  // Approved -> Published is handled by the publish route, not the generic transition.
  if (current === 'Approved') return null;
  return ENGAGEMENT_STATES[i + 1];
}

function canTransitionEngagement(db, user, engagement, toState) {
  if (!engagement || !ENGAGEMENT_STATES.includes(toState)) return false;
  const i = ENGAGEMENT_STATES.indexOf(engagement.status);
  const j = ENGAGEMENT_STATES.indexOf(toState);
  if (j !== i + 1) return false;  // forward-only, one step
  if (toState === 'Published') return false;  // use publish route instead
  if (isFirmOperator(user)) return true;
  return hasRole(db, user.id, engagement.id, 'ENGAGEMENT_LEAD');
}

module.exports.ENGAGEMENT_STATES = ENGAGEMENT_STATES;
module.exports.nextEngagementState = nextEngagementState;
module.exports.canTransitionEngagement = canTransitionEngagement;

// ---- Stage 11: Structured narrative helpers ---------------------------------
// Narratives are stored as a single TEXT column for schema-compat with prior
// stages, but the Analyst-friendly UI breaks them into four labelled sections.
// Sections are encoded as `## Section name` markdown headers so the round-trip
// is human-readable in the DB and in downstream Word/CSV exports.
const NARRATIVE_SECTIONS = [
  { key: 'practice_observed', label: 'Practice observed' },
  { key: 'evidence_reviewed', label: 'Evidence reviewed' },
  { key: 'gaps_or_concerns', label: 'Gaps or concerns' },
  { key: 'follow_up_needed', label: 'Follow-up needed' },
];

function parseStructuredNarrative(text) {
  const sections = { practice_observed: '', evidence_reviewed: '', gaps_or_concerns: '', follow_up_needed: '' };
  if (!text) return sections;
  const parts = String(text).split(/^##\s+/m).map(p => p.trim()).filter(p => p);
  let matched = false;
  for (const part of parts) {
    const firstNewline = part.indexOf('\n');
    const header = (firstNewline === -1 ? part : part.slice(0, firstNewline)).trim().toLowerCase();
    const body = (firstNewline === -1 ? '' : part.slice(firstNewline + 1)).trim();
    if (/practice observed/.test(header)) { sections.practice_observed = body; matched = true; }
    else if (/evidence reviewed/.test(header)) { sections.evidence_reviewed = body; matched = true; }
    else if (/gaps|concerns/.test(header)) { sections.gaps_or_concerns = body; matched = true; }
    else if (/follow.?up/.test(header)) { sections.follow_up_needed = body; matched = true; }
  }
  // Legacy narratives (no section headers) drop into practice_observed so the
  // pre-Stage-11 data still surfaces somewhere readable.
  if (!matched && text.trim()) sections.practice_observed = text.trim();
  return sections;
}

function buildStructuredNarrative(s) {
  if (!s) return '';
  const out = [];
  for (const sec of NARRATIVE_SECTIONS) {
    const v = (s[sec.key] || '').trim();
    if (v) out.push(`## ${sec.label}\n${v}`);
  }
  return out.join('\n\n');
}

module.exports.NARRATIVE_SECTIONS = NARRATIVE_SECTIONS;
module.exports.parseStructuredNarrative = parseStructuredNarrative;
module.exports.buildStructuredNarrative = buildStructuredNarrative;
