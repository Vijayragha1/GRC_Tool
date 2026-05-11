// Role-based access control: 6 distinct roles, ~40 permissions, per-route gating.
// Roles also exist outside of authentication (auth is currently disabled in the
// app), so the role for a request is whatever the workspace_members row (or
// firm_role) says.
//
// Permissions are flat strings; a role grants a set of them. Workspace owners
// (firm owner role) implicitly hold all permissions. A workspace_role_overrides
// table can grant or revoke individual permissions per (workspace, user, perm).

const PERMISSIONS = {
  // Workspace
  'workspace.update':         'Edit workspace settings',
  'workspace.delete':         'Delete workspace',
  'workspace.export':         'Export audit pack / CSVs',

  // Members + RBAC
  'members.view':             'View members and roles',
  'members.add':              'Add members',
  'members.remove':           'Remove members',
  'members.assign_role':      'Assign / change roles',
  'members.override_perms':   'Grant or revoke individual permissions',

  // Entities (multi-entity scoping)
  'entity.view':              'View entities',
  'entity.create':            'Create new entity',
  'entity.update':            'Update entity',
  'entity.delete':            'Delete entity',

  // Controls
  'control.view':             'View controls',
  'control.update':           'Update control state, applicability, evidence',
  'control.bulk_update':      'Bulk-update controls',

  // Risks
  'risk.view':                'View risks',
  'risk.create':              'Create risks',
  'risk.update':              'Edit risks',
  'risk.delete':              'Delete risks',
  'risk.methodology':         'Edit risk methodology',

  // Assets
  'asset.view':               'View asset inventory',
  'asset.create':             'Create assets',
  'asset.update':             'Edit assets',
  'asset.delete':             'Delete assets',

  // Documents / policies
  'document.view':            'View documents',
  'document.create':          'Create documents',
  'document.edit':            'Edit document content',
  'document.submit_review':   'Submit document for review',
  'document.review':          'Review document (approver role)',
  'document.approve':         'Approve / reject document version',
  'document.publish':         'Publish approved documents',
  'document.retire':          'Retire published documents',
  'document.sign':            'Apply electronic signature',
  'document.delete':          'Delete documents',

  // Audits, MRMs, NCs, incidents, suppliers
  'audit.manage':             'Manage internal audits',
  'mrm.manage':               'Manage management reviews',
  'nc.manage':                'Manage nonconformities',
  'incident.manage':          'Manage incidents',
  'supplier.manage':          'Manage suppliers',

  // Misc
  'task.manage':              'Manage tasks',
  'evidence.upload':          'Upload evidence',
  'evidence.delete':          'Delete evidence',
  'comment.create':           'Add comments',
  'comment.delete':           'Delete comments',
  'audit_log.view':           'View activity / audit log',
  'audit_log.export':         'Export activity log',
};

// Built-in role bundles. Owner is special (all perms).
const ROLE_PERMS = {
  // Firm-side
  firm_owner: '*', // implicit - no explicit list, gated via isFirmOwner
  consultant: [    // consultants in firm context
    'workspace.update','workspace.export','members.view','members.add',
    'entity.view','entity.create','entity.update','entity.delete',
    'control.view','control.update','control.bulk_update',
    'risk.view','risk.create','risk.update','risk.delete','risk.methodology',
    'asset.view','asset.create','asset.update','asset.delete',
    'document.view','document.create','document.edit','document.submit_review',
    'document.review','document.approve','document.publish','document.retire',
    'document.sign','document.delete',
    'audit.manage','mrm.manage','nc.manage','incident.manage',
    'supplier.manage','task.manage',
    'evidence.upload','evidence.delete','comment.create','comment.delete',
    'audit_log.view','audit_log.export'
  ],
  lead_consultant: '*',  // workspace lead = workspace owner
  // Client-side roles
  client_admin: [
    'workspace.update','workspace.export','members.view','members.add','members.remove',
    'entity.view','entity.create','entity.update',
    'control.view','control.update','control.bulk_update',
    'risk.view','risk.create','risk.update','risk.delete',
    'asset.view','asset.create','asset.update','asset.delete',
    'document.view','document.create','document.edit','document.submit_review',
    'document.approve','document.publish','document.retire','document.sign',
    'audit.manage','mrm.manage','nc.manage','incident.manage',
    'supplier.manage','task.manage',
    'evidence.upload','evidence.delete','comment.create','audit_log.view'
  ],
  contributor: [
    'entity.view','control.view','control.update',
    'risk.view','risk.create','risk.update',
    'asset.view','asset.create','asset.update',
    'document.view','document.create','document.edit','document.submit_review',
    'audit.manage','nc.manage','incident.manage','supplier.manage',
    'task.manage','evidence.upload','comment.create'
  ],
  reviewer: [
    'entity.view','control.view','risk.view','asset.view','document.view',
    'document.review','document.sign','comment.create','audit_log.view'
  ],
  auditor: [  // read-only auditor (e.g., external)
    'entity.view','control.view','risk.view','asset.view','document.view',
    'audit_log.view','audit_log.export','workspace.export'
  ],
  read_only: [
    'entity.view','control.view','risk.view','asset.view','document.view'
  ]
};

const ROLE_LABELS = {
  firm_owner: 'Firm owner',
  consultant: 'Consultant',
  lead_consultant: 'Lead consultant',
  client_admin: 'Client admin',
  contributor: 'Contributor',
  reviewer: 'Reviewer',
  auditor: 'Auditor (read-only)',
  read_only: 'Read-only'
};

function rolePermissions(role) {
  const r = ROLE_PERMS[role];
  if (r === '*') return Object.keys(PERMISSIONS);
  return Array.isArray(r) ? r : [];
}

// Combine baseline role perms with per-workspace overrides.
// overrides shape: [{ permission: 'document.approve', granted: 1 } ...]
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

module.exports = {
  PERMISSIONS, ROLE_PERMS, ROLE_LABELS,
  rolePermissions, effectivePermissions, hasPermission
};
