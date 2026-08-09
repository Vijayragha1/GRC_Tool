// Role-based access control. Six named roles, ~50 permissions, per-route
// gating. Roles are stored as strings in users.firm_role (firm side) or
// workspace_members.role (client side). Per-user, per-workspace permission
// overrides live in workspace_role_overrides and are applied on top of the
// role baseline (additive grants and revokes).
//
// Manager is special — it implicitly holds every permission (no explicit
// list, gated via isManager / firm_role === 'manager'). The other five roles
// declare their permissions explicitly so a new permission added below
// doesn't silently grant access to anyone but Manager.
//
// Role naming migration (2026-05-24): the previous names — firm_owner,
// lead_consultant, client_admin, plus the unused reviewer/auditor/read_only —
// were renamed and consolidated. ROLE_ALIASES below maps old to new so any
// stale reference still resolves to the right bundle while we sweep callers.

const PERMISSIONS = {
  // ---- Firm-wide ----
  'firm.manage':              'Edit firm settings (billing, branding, email config)',
  'firm.users.manage':        'Invite, create, deactivate firm-side users',
  'firm.cross_view':          'See the cross-engagement dashboard across all clients',

  // ---- Workspace (per-engagement) ----
  'workspace.create':         'Create a new client workspace',
  'workspace.update':         'Edit workspace settings',
  'workspace.delete':         'Delete workspace',
  'workspace.export':         'Export audit pack / CSVs',
  'workspace.users.manage':   'Invite, add, remove client-side workspace members',

  // ---- Members + RBAC ----
  'members.view':             'View members and roles',
  'members.add':              'Add members',
  'members.remove':           'Remove members',
  'members.assign_role':      'Assign / change roles',
  'members.override_perms':   'Grant or revoke individual permissions per user',

  // ---- Entities (multi-entity scoping) ----
  'entity.view':              'View entities',
  'entity.create':            'Create new entity',
  'entity.update':            'Update entity',
  'entity.delete':            'Delete entity',

  // ---- Controls ----
  'control.view':             'View controls',
  'control.update':           'Update control state, applicability, evidence',
  'control.bulk_update':      'Bulk-update controls',

  // ---- Risks ----
  'risk.view':                'View risks',
  'risk.create':              'Create risks',
  'risk.update':              'Edit risks',
  'risk.delete':              'Delete risks',
  'risk.methodology':         'Edit risk methodology',

  // ---- Assets ----
  'asset.view':               'View asset inventory',
  'asset.create':             'Create assets',
  'asset.update':             'Edit assets',
  'asset.delete':             'Delete assets',

  // ---- Documents / policies ----
  'document.view':            'View documents',
  'document.create':          'Create documents',
  'document.edit':            'Edit document content',
  'document.submit_review':   'Submit document for review',
  'document.review':          'Review document (reviewer slot in approval chain)',
  'document.approve':         'Approve / reject document version (approver slot)',
  'document.publish':         'Publish approved documents',
  'document.retire':          'Retire published documents',
  'document.sign':            'Apply electronic signature',
  'document.delete':          'Delete documents',

  // ---- Audits, MRMs, NCs, incidents, suppliers ----
  'audit.manage':             'Manage internal audits',
  'mrm.manage':               'Manage management reviews',
  'nc.manage':                'Manage nonconformities',
  'incident.manage':          'Manage incidents',
  'supplier.manage':          'Manage suppliers',
  'supplier.approve':         'Approve, reject, renew, or offboard suppliers',
  'supplier.risk_accept':     'Accept supplier findings and override calculated risk',
  'supplier.export':          'Export the supplier risk register',

  // ---- Assurance reports ----
  'report.view':              'View assurance report history and frozen previews',
  'report.generate':          'Generate immutable assurance report snapshots',
  'report.review':            'Review assurance reports and request changes',
  'report.approve':           'Approve assurance reports (maker-checker)',
  'report.publish':           'Publish approved assurance reports',
  'report.export':            'Download frozen assurance report artifacts',

  // ---- Misc ----
  'task.manage':              'Manage tasks',
  'evidence.upload':          'Upload evidence',
  'evidence.delete':          'Delete evidence',
  'comment.create':           'Add comments',
  'comment.delete':           'Delete comments',
  'audit_log.view':           'View activity / audit log',
  'audit_log.export':         'Export activity log',

  // ---- Client collaboration portal ----
  'client_portal.view':       'View the client collaboration portal',
  'client_request.manage':    'Create, assign, review, and close client requests',
  'client_request.respond':   'Respond to assigned client requests and attach evidence',

  // ---- Assessment lifecycle ----
  'assessment.start_pass':    'Start a new gap-assessment pass',
  'assessment.signoff':       'Finalise / sign off a gap-assessment pass',
};

// Built-in role bundles. Manager is special (all perms via '*').
// Senior consultant gets document.review but NOT document.approve — they
// review on the firm side and forward to the client for approval.
// ISMS manager gets document.approve so client-side operational policies can
// be approved without escalating every time to the Client owner.
// Contributor gets a scoped slice — evidence upload + comments + view; row-
// level filtering by member_scopes turns view/update into "own only."
const ROLE_PERMS = {
  // ===== Firm side =====
  manager: '*',                                 // every permission, implicitly
  senior_consultant: [
    'firm.cross_view',
    'workspace.create','workspace.update','workspace.export','workspace.users.manage',
    'members.view','members.add','members.remove','members.assign_role','members.override_perms',
    'entity.view','entity.create','entity.update','entity.delete',
    'control.view','control.update','control.bulk_update',
    'risk.view','risk.create','risk.update','risk.delete','risk.methodology',
    'asset.view','asset.create','asset.update','asset.delete',
    'document.view','document.create','document.edit','document.submit_review',
    'document.review','document.publish','document.retire','document.sign','document.delete',
    'audit.manage','mrm.manage','nc.manage','incident.manage','supplier.manage','supplier.approve','supplier.risk_accept','supplier.export',
    'report.view','report.generate','report.review','report.publish','report.export',
    'task.manage','evidence.upload','evidence.delete',
    'comment.create','comment.delete',
    'audit_log.view','audit_log.export',
    'client_portal.view','client_request.manage','client_request.respond',
    'assessment.start_pass','assessment.signoff'
  ],
  consultant: [
    'workspace.update','workspace.export',
    'members.view',
    'entity.view','entity.create','entity.update','entity.delete',
    'control.view','control.update','control.bulk_update',
    'risk.view','risk.create','risk.update','risk.delete','risk.methodology',
    'asset.view','asset.create','asset.update','asset.delete',
    'document.view','document.create','document.edit','document.submit_review',
    'audit.manage','mrm.manage','nc.manage','incident.manage','supplier.manage','supplier.export',
    'report.view','report.generate','report.export',
    'task.manage','evidence.upload','evidence.delete',
    'comment.create',
    'audit_log.view',
    'client_portal.view','client_request.manage','client_request.respond',
    'assessment.start_pass'
  ],

  // ===== Client side =====
  // Client accounts are deliberately collaboration-only. The consulting firm
  // owns the authoritative workspace and its configuration; client sponsors
  // and coordinators can manage shared requests and sign assigned decisions,
  // but cannot delete the workspace, alter RBAC, browse internal workpapers,
  // or mutate the underlying GRC registers through legacy operator routes.
  client_owner: [
    'client_portal.view','client_request.manage','client_request.respond',
    'document.review','document.approve','document.sign',
    'evidence.upload','comment.create'
  ],
  isms_manager: [
    'client_portal.view','client_request.manage','client_request.respond',
    'document.review','document.approve','document.sign',
    'evidence.upload','comment.create'
  ],
  contributor: [
    // Row-level scoping in the portal restricts contributors to explicitly
    // assigned requests, controls, policies, validations and deliverables.
    'client_portal.view','client_request.respond','evidence.upload','comment.create'
  ],
};

// Old → new role name aliases. Keep these resolving until every caller is
// migrated. DB migration rewrites stored values too, so this is just a
// safety net for in-flight requests during deploy or for forgotten string
// literals.
const ROLE_ALIASES = {
  firm_owner:       'manager',
  lead_consultant:  'senior_consultant',
  client_admin:     'client_owner',
  // Dropped roles fall back to the next narrowest equivalent so old rows
  // don't crash. Production migration should re-assign these explicitly.
  reviewer:         'contributor',
  auditor:          'contributor',
  read_only:        'contributor',
};

const ROLE_LABELS = {
  manager:            'Manager',
  senior_consultant:  'Senior consultant',
  consultant:         'Consultant',
  client_owner:       'Client sponsor',
  isms_manager:       'Client coordinator',
  contributor:        'Contributor',
};

// Roles grouped by side, for UI dropdowns that need to show "firm roles
// here, client roles there" without each view re-asserting the list.
const FIRM_ROLES   = ['manager', 'senior_consultant', 'consultant'];
const CLIENT_ROLES = ['client_owner', 'isms_manager', 'contributor'];

function normalizeRole(role) {
  if (!role) return role;
  return ROLE_ALIASES[role] || role;
}

function rolePermissions(role) {
  const r = ROLE_PERMS[normalizeRole(role)];
  if (r === '*') return Object.keys(PERMISSIONS);
  return Array.isArray(r) ? r : [];
}

// Combine baseline role perms with per-workspace overrides.
// overrides shape: [{ permission: 'document.approve', granted: 1 }, ...]
function effectivePermissions(role, overrides = []) {
  const base = new Set(rolePermissions(role));
  for (const o of overrides) {
    if (o.granted) base.add(o.permission);
    else base.delete(o.permission);
  }
  return base;
}

function hasPermission(perms, perm) {
  if (!perms) return false;
  if (perms === '*' || (perms.has && perms.has('*'))) return true;
  return perms.has ? perms.has(perm) : perms.includes(perm);
}

// Convenience: did this firm_role string map to the top-of-firm role?
// Accepts old 'owner' too via ROLE_ALIASES.
function isManager(firmRole) {
  return normalizeRole(firmRole) === 'manager';
}

module.exports = {
  PERMISSIONS, ROLE_PERMS, ROLE_LABELS, ROLE_ALIASES,
  FIRM_ROLES, CLIENT_ROLES,
  normalizeRole, rolePermissions, effectivePermissions, hasPermission, isManager
};
