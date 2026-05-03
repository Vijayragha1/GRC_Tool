const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = require('docx');
const { db, init, logAction, verifyAuditChain, defaultMethodology, ensureWorkspaceMethodology, getActiveMethodology, methodologyBand } = require('./db');
const enc = require('./lib/encryption');
const rbac = require('./lib/rbac');
const jobs = require('./lib/jobs');
const apiAuth = require('./lib/api-auth');
const ccm = require('./lib/ccm');
const fts = require('./lib/fts');
const i18n = require('./lib/i18n');
const reports = require('./lib/reports');
const backup = require('./lib/backup');
const keyrotation = require('./lib/keyrotation');

init();
// Force master key generation eagerly so first request doesn't block.
enc.masterKey();
// Start scheduled job runner — every 60 minutes by default.
jobs.start(parseInt(process.env.ISMS_JOB_INTERVAL_MIN || '60', 10));
// Start daily backup runner.
backup.start(parseInt(process.env.ISMS_BACKUP_HOURS || '24', 10));

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production-' + crypto.randomBytes(8).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ==================== HELPERS ====================
// Auth is disabled — single-user local mode. Always returns the default firm owner.
function currentUser(req) {
  if (req.session.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId);
    if (u) return u;
  }
  return db.prepare(`SELECT * FROM users WHERE user_type='firm' AND active=1 ORDER BY id LIMIT 1`).get();
}

function requireAuth(req, res, next) {
  req.user = currentUser(req);
  if (!req.user) return res.status(500).render('error', { user: null, message: 'No default user found. Delete iso27001.db and restart.' });
  next();
}

function getWorkspace(workspaceId, user) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return null;
  if (user.user_type === 'firm' && user.firm_id === ws.firm_id) {
    return { ...ws, role: 'consultant', _userRole: user.firm_role === 'owner' ? 'owner' : 'consultant' };
  }
  const m = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, user.id);
  if (!m) return null;
  return { ...ws, role: m.role, _userRole: m.role };
}

function requireWorkspace(req, res, next) {
  const ws = getWorkspace(req.params.wsId, req.user);
  if (!ws) return res.status(403).render('error', { user: req.user, message: 'No access to this workspace.' });
  req.workspace = ws;
  // Load active entity scope from session (if any).
  const eid = parseInt(req.session['ws_entity_' + ws.id] || 0, 10);
  if (eid) {
    const ent = db.prepare('SELECT * FROM entities WHERE id=? AND workspace_id=? AND is_active=1').get(eid, ws.id);
    if (ent) {
      req.activeEntity = ent;
      req.entityScopeId = ent.id;
      res.locals.activeEntity = ent;
    } else {
      // Stale entity ref — clear it.
      delete req.session['ws_entity_' + ws.id];
    }
  }
  res.locals.entitySelectorWs = ws;
  res.locals.workspaceEntities = listWorkspaceEntities(ws.id);
  res.locals.userPerms = permissionsFor(req.user, ws);
  // Ensure default risk methodology exists.
  ensureWorkspaceMethodology(ws.id);
  // Unread notifications for the bell icon
  try {
    res.locals.unreadNotifications = db.prepare(
      `SELECT COUNT(*) c FROM notifications WHERE workspace_id=? AND read_at IS NULL AND dismissed_at IS NULL AND (user_id IS NULL OR user_id=?)`
    ).get(ws.id, req.user.id).c;
  } catch (_) { res.locals.unreadNotifications = 0; }
  next();
}

function isFirmUser(user) { return user.user_type === 'firm'; }
function isFirmOwner(user) { return user.user_type === 'firm' && user.firm_role === 'owner'; }

function listWorkspaces(user) {
  if (user.user_type === 'firm') {
    return db.prepare(`SELECT w.*,
        (SELECT name FROM users WHERE id = w.lead_consultant_id) AS lead_name
        FROM workspaces w WHERE w.firm_id = ? ORDER BY w.created_at DESC`).all(user.firm_id);
  }
  return db.prepare(`SELECT w.*,
      (SELECT name FROM users WHERE id = w.lead_consultant_id) AS lead_name,
      m.role AS my_role
      FROM workspaces w
      INNER JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? ORDER BY w.created_at DESC`).all(user.id);
}

function workspaceProgress(wsId) {
  const total = db.prepare('SELECT COUNT(*) AS c FROM iso_items').get().c;
  const assessed = db.prepare(`SELECT COUNT(*) AS c FROM control_states
    WHERE workspace_id = ? AND status != 'Not Assessed'`).get(wsId).c;
  return { total, assessed, percent: total ? Math.round((assessed / total) * 100) : 0 };
}

function getOrCreateState(wsId, isoId) {
  let s = db.prepare('SELECT * FROM control_states WHERE workspace_id = ? AND iso_item_id = ?')
    .get(wsId, isoId);
  if (!s) {
    db.prepare('INSERT INTO control_states (workspace_id, iso_item_id) VALUES (?, ?)').run(wsId, isoId);
    s = db.prepare('SELECT * FROM control_states WHERE workspace_id = ? AND iso_item_id = ?').get(wsId, isoId);
  }
  return s;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function withToast(url, msg, kind) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'toast=' + encodeURIComponent(msg) + (kind ? '&toastKind=' + kind : '');
}

app.locals.escapeHtml = escapeHtml;
app.locals.rbac = rbac;

// ==================== RBAC + AUDIT CONTEXT ====================
// Resolve a user's effective permissions in a workspace, including overrides.
function permissionsFor(user, ws) {
  if (!user || !ws) return new Set();
  // Firm owner of the firm that owns the workspace = all perms.
  if (user.user_type === 'firm' && user.firm_role === 'owner' && user.firm_id === ws.firm_id) {
    return new Set(Object.keys(rbac.PERMISSIONS).concat(['*']));
  }
  let role;
  if (user.user_type === 'firm' && user.firm_id === ws.firm_id) {
    role = ws._userRole || 'consultant';
  } else {
    const m = db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(ws.id, user.id);
    role = m?.role || 'read_only';
  }
  const overrides = db.prepare(`SELECT permission, granted FROM workspace_role_overrides WHERE workspace_id=? AND user_id=?`).all(ws.id, user.id);
  return rbac.effectivePermissions(role, overrides);
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.workspace) return res.status(500).render('error', { user: req.user, message: 'No workspace context.' });
    const perms = permissionsFor(req.user, req.workspace);
    if (!rbac.hasPermission(perms, perm)) {
      logAction(req.user.id, req.workspace.id, 'permission_denied', 'permission', perm,
                { route: req.method + ' ' + req.path }, auditCtx(req));
      return res.status(403).render('error', { user: req.user, message: `Forbidden — missing permission: ${perm}` });
    }
    req.userPerms = perms;
    next();
  };
}

// Build the audit context from a request — IP, UA, request id, current entity scope.
function auditCtx(req) {
  return {
    ip: (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '').toString().split(',')[0].trim(),
    userAgent: (req.headers['user-agent'] || '').slice(0, 255),
    requestId: req.id || null,
    entityScopeId: req.entityScopeId || null
  };
}

// Diff two flat objects (returns { before:{…changed}, after:{…changed} })
function diffObjects(before, after) {
  const b = {}, a = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const bv = before ? before[k] : undefined;
    const av = after ? after[k] : undefined;
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[k] = bv === undefined ? null : bv;
      a[k] = av === undefined ? null : av;
    }
  }
  return { before: b, after: a };
}

// Each request gets a short unique id for correlating audit log entries.
app.use((req, res, next) => {
  req.id = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
});

// ==================== MULTI-ENTITY SCOPING ====================
// The active entity scope is stored in the session and applies a filter to
// list views via SQL: `entity_id = ?` (or NULL fallthrough for workspace-wide).
function activeEntityFilter(req, sqlAlias) {
  if (!req.session) return { sql: '', params: [] };
  const eid = parseInt(req.session['ws_entity_' + (req.workspace?.id || 0)] || 0, 10);
  if (!eid) return { sql: '', params: [] };
  const col = sqlAlias ? `${sqlAlias}.entity_id` : 'entity_id';
  return { sql: ` AND (${col}=? OR ${col} IS NULL)`, params: [eid] };
}

function requireEntity(req) {
  const eid = parseInt(req.session['ws_entity_' + req.workspace.id] || 0, 10);
  if (!eid) return null;
  return db.prepare('SELECT * FROM entities WHERE id=? AND workspace_id=?').get(eid, req.workspace.id);
}

function listWorkspaceEntities(wsId) {
  return db.prepare('SELECT * FROM entities WHERE workspace_id=? AND is_active=1 ORDER BY name').all(wsId);
}
app.locals.listWorkspaceEntities = listWorkspaceEntities;

// Make the active entity available to every view via res.locals.
app.use((req, res, next) => {
  res.locals.activeEntity = null;
  res.locals.entitySelectorWs = null;
  res.locals.unreadNotifications = 0;
  next();
});

// Pre-load unread notifications for the topbar bell.
app.use((req, res, next) => {
  if (req.session && req.session.userId !== undefined) { /* placeholder */ }
  // Without auth, just count workspace-broadcast notifications (user_id IS NULL)
  // for the user's accessible workspaces in the current request scope.
  next();
});

// Auth disabled — all auth routes redirect to /dashboard.
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/login', (req, res) => res.redirect('/dashboard'));
app.post('/login', (req, res) => res.redirect('/dashboard'));
app.get('/register', (req, res) => res.redirect('/dashboard'));
app.post('/register', (req, res) => res.redirect('/dashboard'));
app.post('/logout', (req, res) => res.redirect('/dashboard'));

// ==================== DASHBOARD ====================
app.get('/dashboard', requireAuth, (req, res) => {
  const workspaces = listWorkspaces(req.user);
  const workspacesWithProgress = workspaces.map(w => {
    const progress = workspaceProgress(w.id);
    const readiness = computeReadiness(w);
    const openMajorNCs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(w.id).c;
    const overdueNCs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date < date('now')`).get(w.id).c;
    return { ...w, progress, readiness, openMajorNCs, overdueNCs };
  });

  // Portfolio aggregates
  const totals = {
    total: workspacesWithProgress.length,
    avgStage1: workspacesWithProgress.length ? Math.round(workspacesWithProgress.reduce((s, w) => s + w.readiness.stage1, 0) / workspacesWithProgress.length) : 0,
    nearCert: workspacesWithProgress.filter(w => w.readiness.daysToTarget !== null && w.readiness.daysToTarget < 90).length,
    redFlags: workspacesWithProgress.filter(w => w.openMajorNCs > 0 || w.overdueNCs > 0 || w.readiness.flags.filter(f => f.severity === 'high').length > 2).length,
    totalOpenNCs: workspacesWithProgress.reduce((s, w) => s + w.openMajorNCs + w.overdueNCs, 0)
  };

  let firmUsers = [];
  if (isFirmUser(req.user)) {
    firmUsers = db.prepare(`SELECT id, name, email, firm_role FROM users
      WHERE firm_id = ? AND user_type = 'firm' AND active = 1 ORDER BY name`).all(req.user.firm_id);
  }
  res.render('dashboard', { user: req.user, workspaces: workspacesWithProgress, firmUsers, totals });
});

// ==================== FIRM TEAM MANAGEMENT ====================
app.post('/firm/users', requireAuth, (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
  const { name, email, password, firm_role } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.redirect('/dashboard');
  }
  const e = email.toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(e)) {
    return res.redirect('/dashboard');
  }
  const role = firm_role === 'owner' ? 'owner' : 'consultant';
  const hash = bcrypt.hashSync(password, 10);
  const id = db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role)
                         VALUES (?, ?, ?, 'firm', ?, ?)`)
    .run(e, hash, name.trim(), req.user.firm_id, role).lastInsertRowid;
  logAction(req.user.id, null, 'create_consultant', 'user', id, { email: e, role });
  res.redirect('/dashboard');
});

app.post('/firm/users/:id/deactivate', requireAuth, (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND firm_id = ?').get(req.params.id, req.user.firm_id);
  if (!u || u.id === req.user.id) return res.redirect('/dashboard');
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  logAction(req.user.id, null, 'deactivate_user', 'user', req.params.id, null);
  res.redirect('/dashboard');
});

// ==================== WORKSPACE CRUD ====================
app.post('/workspaces', requireAuth, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const { client_name, industry, scope, target_cert_date } = req.body;
  if (!client_name) return res.redirect('/dashboard');
  const id = db.prepare(`INSERT INTO workspaces (firm_id, client_name, industry, scope, target_cert_date, lead_consultant_id)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.user.firm_id, client_name.trim(), industry || null,
         scope || null, target_cert_date || null, req.user.id).lastInsertRowid;
  logAction(req.user.id, id, 'create_workspace', 'workspace', id, { client_name });
  res.redirect(withToast('/workspaces/' + id, 'Workspace created'));
});

app.get('/workspaces/:wsId', requireAuth, requireWorkspace, (req, res) => {
  const ws = req.workspace;
  const progress = workspaceProgress(ws.id);

  // Status breakdown
  const STATUSES = ['Implemented','Partially Implemented','Work In Progress','Not Implemented','Not Applicable','Not Assessed'];
  const stateRows = db.prepare(`SELECT i.id, i.type, i.category, COALESCE(cs.status,'Not Assessed') AS status
                                FROM iso_items i
                                LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?`)
    .all(ws.id);

  const breakdown = { clauses: {}, annex: {} };
  STATUSES.forEach(s => { breakdown.clauses[s] = 0; breakdown.annex[s] = 0; });
  stateRows.forEach(r => {
    if (r.type === 'clause') breakdown.clauses[r.status]++;
    else breakdown.annex[r.status]++;
  });

  const riskCount = db.prepare('SELECT COUNT(*) AS c FROM risks WHERE workspace_id = ?').get(ws.id).c;
  const openRisks = db.prepare(`SELECT * FROM risks WHERE workspace_id = ? AND status = 'open'
                                ORDER BY (likelihood * impact) DESC LIMIT 5`).all(ws.id);
  const assetCount = db.prepare('SELECT COUNT(*) AS c FROM assets WHERE workspace_id = ?').get(ws.id).c;
  const evidenceCount = db.prepare('SELECT COUNT(*) AS c FROM evidence WHERE workspace_id = ?').get(ws.id).c;
  const openTasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.workspace_id = ? AND t.status NOT IN ('done') ORDER BY t.due_date ASC LIMIT 10`).all(ws.id);

  const actionItems = db.prepare(`SELECT i.id, i.title, cs.status FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id = i.id
    WHERE cs.workspace_id = ? AND cs.status IN ('Not Implemented','Partially Implemented')
    ORDER BY i.sort_order LIMIT 20`).all(ws.id);

  const docCount = db.prepare('SELECT COUNT(*) AS c FROM generated_docs WHERE workspace_id = ?').get(ws.id).c;
  const auditCount = db.prepare('SELECT COUNT(*) AS c FROM audits WHERE workspace_id = ?').get(ws.id).c;
  const mrmCount = db.prepare('SELECT COUNT(*) AS c FROM mrms WHERE workspace_id = ?').get(ws.id).c;
  const ncOpen = db.prepare(`SELECT COUNT(*) AS c FROM nonconformities
    WHERE workspace_id = ? AND status NOT IN ('closed','verified')`).get(ws.id).c;
  const recentActivity = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
    INNER JOIN users u ON u.id = a.user_id
    WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 8`).all(ws.id);

  const readiness = computeReadiness(ws);

  // 30-day activity sparkline data
  const sparkRows = db.prepare(`SELECT date(created_at) AS d, COUNT(*) AS c
    FROM audit_log WHERE workspace_id = ? AND created_at >= date('now','-29 days')
    GROUP BY date(created_at)`).all(ws.id);
  const sparkMap = Object.fromEntries(sparkRows.map(r => [r.d, r.c]));
  const sparkline = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    sparkline.push({ d: key, c: sparkMap[key] || 0 });
  }

  res.render('workspace', {
    user: req.user, ws, progress, breakdown, riskCount, openRisks,
    assetCount, evidenceCount, openTasks, actionItems,
    docCount, auditCount, mrmCount, ncOpen, recentActivity, readiness, sparkline
  });
});

app.post('/workspaces/:wsId/update', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') {
    return res.status(403).send('Forbidden');
  }
  const { client_name, industry, scope, target_cert_date, stage, lead_consultant_id } = req.body;
  db.prepare(`UPDATE workspaces SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?
              WHERE id=?`)
    .run(client_name, industry || null, scope || null, target_cert_date || null,
         stage || 'gap_assessment', lead_consultant_id || null, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'update_workspace', 'workspace', req.workspace.id, null);
  res.redirect('/workspaces/' + req.workspace.id);
});

// ==================== WORKSPACE MEMBERS ====================
app.get('/workspaces/:wsId/members', requireAuth, requireWorkspace, (req, res) => {
  const members = db.prepare(`SELECT m.*, u.name, u.email, u.user_type, u.firm_role
    FROM workspace_members m INNER JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? ORDER BY u.name`).all(req.workspace.id);
  const firmConsultants = isFirmUser(req.user) ?
    db.prepare(`SELECT id, name, email FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1`).all(req.user.firm_id) :
    [];
  res.render('members', { user: req.user, ws: req.workspace, members, firmConsultants });
});

app.post('/workspaces/:wsId/members/client', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 8) return res.redirect('/workspaces/' + req.workspace.id + '/members');
  const e = email.toLowerCase().trim();
  const allowedRoles = ['client_admin','contributor','reviewer'];
  const r = allowedRoles.includes(role) ? role : 'contributor';

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  if (!user) {
    const hash = bcrypt.hashSync(password, 10);
    const userId = db.prepare(`INSERT INTO users (email, password_hash, name, user_type)
                               VALUES (?, ?, ?, 'client')`).run(e, hash, name.trim(), ).lastInsertRowid;
    user = { id: userId };
  }
  try {
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
      .run(req.workspace.id, user.id, r);
  } catch (e) { /* already member */ }
  logAction(req.user.id, req.workspace.id, 'add_client_user', 'user', user.id, { email: e, role: r });
  res.redirect('/workspaces/' + req.workspace.id + '/members');
});

app.post('/workspaces/:wsId/members/firm', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const { user_id, role } = req.body;
  const allowedRoles = ['lead_consultant','consultant'];
  const r = allowedRoles.includes(role) ? role : 'consultant';
  try {
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
      .run(req.workspace.id, user_id, r);
  } catch (e) { /* dup */ }
  res.redirect('/workspaces/' + req.workspace.id + '/members');
});

app.post('/workspaces/:wsId/members/:memberId/remove', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?')
    .run(req.params.memberId, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/members');
});

// ==================== CONTROLS LIST + DETAIL ====================
app.get('/workspaces/:wsId/controls', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'all';
  const search = (req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
      cs.applicability, cs.maturity, cs.owner_id, cs.due_date,
      (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      ORDER BY i.sort_order`).all(req.workspace.id);

  if (filter === 'clauses') rows = rows.filter(r => r.type === 'clause');
  else if (filter === 'annex') rows = rows.filter(r => r.type === 'control');
  else if (filter === 'org') rows = rows.filter(r => r.category === 'org');
  else if (filter === 'people') rows = rows.filter(r => r.category === 'people');
  else if (filter === 'physical') rows = rows.filter(r => r.category === 'physical');
  else if (filter === 'tech') rows = rows.filter(r => r.category === 'tech');
  else if (filter === 'open') rows = rows.filter(r => ['Not Implemented','Partially Implemented','Not Assessed'].includes(r.status));
  if (search) rows = rows.filter(r => r.title.toLowerCase().includes(search) || r.id.toLowerCase().includes(search));

  res.render('controls', { user: req.user, ws: req.workspace, rows, filter, search });
});

app.get('/workspaces/:wsId/controls/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
  // Reserved literal sub-routes — let them fall through.
  if (['kanban','export.csv','import'].includes(req.params.isoId)) return nextMw();
  const item = db.prepare('SELECT * FROM iso_items WHERE id = ?').get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  item.questions = JSON.parse(item.questions || '[]');
  item.evidence_needed = JSON.parse(item.evidence_needed || '[]');
  item.documentation_needed = JSON.parse(item.documentation_needed || '[]');

  const state = getOrCreateState(req.workspace.id, item.id);
  const evidenceList = db.prepare(`SELECT e.*, u.name AS uploader FROM evidence e
    LEFT JOIN users u ON u.id = e.uploaded_by
    WHERE e.workspace_id = ? AND e.iso_item_id = ? ORDER BY e.uploaded_at DESC`)
    .all(req.workspace.id, item.id);
  const comments = db.prepare(`SELECT c.*, u.name AS author FROM comments c
    INNER JOIN users u ON u.id = c.user_id
    WHERE c.workspace_id = ? AND c.parent_type = 'control' AND c.parent_id = ?
    ORDER BY c.created_at`).all(req.workspace.id, item.id);
  const decComments = comments.map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
  const filteredComments = isFirmUser(req.user) ? decComments : decComments.filter(c => !c.internal_only);
  const linkedRisks = db.prepare(`SELECT r.* FROM risks r
    INNER JOIN risk_controls rc ON rc.risk_id = r.id
    WHERE rc.iso_item_id = ? AND r.workspace_id = ?`).all(item.id, req.workspace.id);
  const wsUsers = db.prepare(`SELECT u.id, u.name FROM users u
    INNER JOIN workspace_members m ON m.user_id = u.id
    WHERE m.workspace_id = ?
    UNION
    SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1`)
    .all(req.workspace.id, req.workspace.firm_id);

  // Prev/next nav
  const all = db.prepare('SELECT id FROM iso_items ORDER BY sort_order').all();
  const idx = all.findIndex(r => r.id === item.id);
  const prev = idx > 0 ? all[idx - 1].id : null;
  const next = idx < all.length - 1 ? all[idx + 1].id : null;

  const mappings = db.prepare(`SELECT framework, external_ref, notes FROM framework_mappings
                               WHERE iso_item_id = ?`).all(item.id);

  res.render('control_detail', {
    user: req.user, ws: req.workspace, item, state,
    evidenceList, comments: filteredComments, linkedRisks, wsUsers,
    mappings, prev, next, isFirm: isFirmUser(req.user)
  });
});

app.post('/workspaces/:wsId/controls/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
  if (['import','kanban'].includes(req.params.isoId)) return nextMw();
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const isoId = req.params.isoId;
  getOrCreateState(req.workspace.id, isoId);
  const fields = ['status','applicability','inclusion_justification','exclusion_justification',
                  'maturity','notes','owner_id','due_date'];
  if (isFirmUser(req.user)) fields.push('internal_notes');
  const update = {};
  fields.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f] || null; });
  if (update.maturity) update.maturity = parseInt(update.maturity, 10) || 0;
  if (update.owner_id === '') update.owner_id = null;

  const set = Object.keys(update).map(k => `${k} = ?`).join(', ');
  if (set) {
    db.prepare(`UPDATE control_states SET ${set}, last_updated = CURRENT_TIMESTAMP
                WHERE workspace_id = ? AND iso_item_id = ?`)
      .run(...Object.values(update), req.workspace.id, isoId);
    logAction(req.user.id, req.workspace.id, 'update_control', 'control', isoId, update);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/controls/' + isoId);
});

// ==================== COMMENTS ====================
app.post('/workspaces/:wsId/comments', requireAuth, requireWorkspace, requirePermission('comment.create'), (req, res) => {
  const { parent_type, parent_id, body, internal_only } = req.body;
  if (!body || !parent_type || !parent_id) return res.redirect('back');
  const internal = (internal_only === '1' && isFirmUser(req.user)) ? 1 : 0;
  db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, parent_type, parent_id, req.user.id,
         enc.encryptIfNeeded(body.trim(), req.workspace.id, !!req.workspace.encryption_enabled),
         internal);
  logAction(req.user.id, req.workspace.id, 'add_comment', parent_type, parent_id, { internal }, auditCtx(req));
  const back = req.headers.referer || '/workspaces/' + req.workspace.id;
  res.redirect(back);
});

// ==================== EVIDENCE ====================
app.post('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, upload.single('file'), (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  if (!req.file) return res.redirect('back');
  const { iso_item_id, description } = req.body;
  const buf = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  db.prepare(`INSERT INTO evidence (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, iso_item_id || null, req.file.originalname, req.file.filename,
         sha, req.file.size, req.user.id, description || null);
  logAction(req.user.id, req.workspace.id, 'upload_evidence', 'control', iso_item_id, { filename: req.file.originalname });
  const back = req.headers.referer || '/workspaces/' + req.workspace.id;
  res.redirect(back);
});

app.get('/workspaces/:wsId/evidence/:id/download', requireAuth, requireWorkspace, (req, res) => {
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const fp = path.join(__dirname, 'uploads', ev.stored_path);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.download(fp, ev.filename);
});

app.post('/workspaces/:wsId/evidence/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (ev) {
    const fp = path.join(__dirname, 'uploads', ev.stored_path);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    db.prepare('DELETE FROM evidence WHERE id = ?').run(ev.id);
    logAction(req.user.id, req.workspace.id, 'delete_evidence', 'evidence', ev.id, null);
  }
  res.redirect('back');
});

// ==================== ASSETS ====================
app.get('/workspaces/:wsId/assets', requireAuth, requireWorkspace, requirePermission('asset.view'), (req, res) => {
  const ef = activeEntityFilter(req);
  const assets = db.prepare(`SELECT a.*, e.name AS entity_name FROM assets a
    LEFT JOIN entities e ON e.id = a.entity_id
    WHERE a.workspace_id = ?${ef.sql.replace('entity_id', 'a.entity_id')} ORDER BY a.name`)
    .all(req.workspace.id, ...ef.params);
  res.render('assets', { user: req.user, ws: req.workspace, assets });
});

app.post('/workspaces/:wsId/assets', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
  const { name, type, classification, owner_name, cia_c, cia_i, cia_a, description, entity_id } = req.body;
  if (!name) return res.redirect('back');
  const id = db.prepare(`INSERT INTO assets (workspace_id, entity_id, name, type, classification, owner_name, cia_c, cia_i, cia_a, description)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, entity_id || req.entityScopeId || null, name.trim(), type || null, classification || null, owner_name || null,
         parseInt(cia_c) || 1, parseInt(cia_i) || 1, parseInt(cia_a) || 1, description || null).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_asset', 'asset', id, { name }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/assets', 'Asset added'));
});

app.post('/workspaces/:wsId/assets/:id/delete', requireAuth, requireWorkspace, requirePermission('asset.delete'), (req, res) => {
  const before = db.prepare('SELECT name FROM assets WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  db.prepare('DELETE FROM assets WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  if (before) logAction(req.user.id, req.workspace.id, 'delete_asset', 'asset', req.params.id, { name: before.name }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/assets');
});

// ==================== RISKS ====================
app.get('/workspaces/:wsId/risks', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const ef = activeEntityFilter(req, 'r');
  const risks = db.prepare(`SELECT r.*, a.name AS asset_name, e.name AS entity_name FROM risks r
    LEFT JOIN assets a ON a.id = r.asset_id
    LEFT JOIN entities e ON e.id = r.entity_id
    WHERE r.workspace_id = ?${ef.sql} ORDER BY (r.likelihood * r.impact) DESC`).all(req.workspace.id, ...ef.params);
  const assets = db.prepare('SELECT id, name FROM assets WHERE workspace_id = ? ORDER BY name').all(req.workspace.id);
  const methodology = getActiveMethodology(req.workspace.id);
  // Compute band per risk
  const enriched = risks.map(r => ({ ...r, band: methodologyBand(methodology, r.likelihood, r.impact) }));
  res.render('risks', { user: req.user, ws: req.workspace, risks: enriched, assets, methodology });
});

app.post('/workspaces/:wsId/risks', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const { title, description, asset_id, threat, vulnerability, likelihood, impact, treatment, owner_name, entity_id } = req.body;
  if (!title) return res.redirect('back');
  const id = db.prepare(`INSERT INTO risks (workspace_id, entity_id, title, description, asset_id, threat, vulnerability,
                         likelihood, impact, treatment, owner_name)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, entity_id || req.entityScopeId || null, title.trim(), description || null, asset_id || null,
         threat || null, vulnerability || null,
         parseInt(likelihood) || 3, parseInt(impact) || 3,
         treatment || 'modify', owner_name || null).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_risk', 'risk', id, { title }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/risks/' + id, 'Risk created'));
});

app.get('/workspaces/:wsId/risks/:id', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const risk = db.prepare(`SELECT r.*, a.name AS asset_name, e.name AS entity_name FROM risks r
    LEFT JOIN assets a ON a.id = r.asset_id
    LEFT JOIN entities e ON e.id = r.entity_id
    WHERE r.id = ? AND r.workspace_id = ?`).get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Not found');
  const linked = db.prepare(`SELECT i.* FROM risk_controls rc
    INNER JOIN iso_items i ON i.id = rc.iso_item_id
    WHERE rc.risk_id = ? ORDER BY i.sort_order`).all(risk.id);
  const allControls = db.prepare(`SELECT id, title FROM iso_items WHERE type = 'control' ORDER BY sort_order`).all();
  const assets = db.prepare('SELECT id, name FROM assets WHERE workspace_id = ?').all(req.workspace.id);
  const methodology = getActiveMethodology(req.workspace.id);
  const inherentBand = methodologyBand(methodology, risk.likelihood, risk.impact);
  const residualBand = (risk.residual_likelihood && risk.residual_impact) ? methodologyBand(methodology, risk.residual_likelihood, risk.residual_impact) : null;
  res.render('risk_detail', { user: req.user, ws: req.workspace, risk, linked, allControls, assets, methodology, inherentBand, residualBand });
});

app.post('/workspaces/:wsId/risks/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { title, description, asset_id, threat, vulnerability, likelihood, impact,
          treatment, owner_name, status, residual_likelihood, residual_impact } = req.body;
  db.prepare(`UPDATE risks SET title=?, description=?, asset_id=?, threat=?, vulnerability=?,
              likelihood=?, impact=?, treatment=?, owner_name=?, status=?,
              residual_likelihood=?, residual_impact=?
              WHERE id=? AND workspace_id=?`)
    .run(title, description || null, asset_id || null, threat || null, vulnerability || null,
         parseInt(likelihood) || 3, parseInt(impact) || 3,
         treatment || 'modify', owner_name || null, status || 'open',
         residual_likelihood ? parseInt(residual_likelihood) : null,
         residual_impact ? parseInt(residual_impact) : null,
         req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'update_risk', 'risk', req.params.id, null);
  res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
});

app.post('/workspaces/:wsId/risks/:id/link', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { iso_item_id } = req.body;
  if (iso_item_id) {
    try {
      db.prepare('INSERT INTO risk_controls (risk_id, iso_item_id) VALUES (?, ?)')
        .run(req.params.id, iso_item_id);
      // Auto-mark control as included in SoA when a risk drives it
      getOrCreateState(req.workspace.id, iso_item_id);
      db.prepare(`UPDATE control_states SET applicability = 'included'
                  WHERE workspace_id = ? AND iso_item_id = ? AND applicability = 'undecided'`)
        .run(req.workspace.id, iso_item_id);
    } catch (e) { /* dup */ }
  }
  res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
});

app.post('/workspaces/:wsId/risks/:id/unlink', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM risk_controls WHERE risk_id = ? AND iso_item_id = ?')
    .run(req.params.id, req.body.iso_item_id);
  res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
});

app.post('/workspaces/:wsId/risks/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM risks WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/risks');
});

// ==================== SOA ====================
app.get('/workspaces/:wsId/soa', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.inclusion_justification, cs.exclusion_justification,
      (SELECT COUNT(*) FROM risk_controls rc INNER JOIN risks r ON r.id = rc.risk_id
       WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS risk_count
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control'
      ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id);
  res.render('soa', { user: req.user, ws: req.workspace, rows });
});

app.post('/workspaces/:wsId/soa/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
  // Reserved literal sub-routes (snapshot, auto-justify) must fall through.
  if (['snapshot','auto-justify','snapshots'].includes(req.params.isoId)) return nextMw();
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  getOrCreateState(req.workspace.id, req.params.isoId);
  const { applicability, inclusion_justification, exclusion_justification, status } = req.body;
  db.prepare(`UPDATE control_states SET applicability=?, inclusion_justification=?, exclusion_justification=?,
              status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
              WHERE workspace_id=? AND iso_item_id=?`)
    .run(applicability || 'undecided',
         inclusion_justification || null, exclusion_justification || null,
         status || null, req.workspace.id, req.params.isoId);
  logAction(req.user.id, req.workspace.id, 'update_soa', 'control', req.params.isoId, null);
  res.redirect('/workspaces/' + req.workspace.id + '/soa');
});

// ==================== TASKS ====================
app.get('/workspaces/:wsId/tasks', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'open';
  let q = `SELECT t.*, u.name AS assignee_name, c.name AS creator_name, i.title AS iso_title
           FROM tasks t
           LEFT JOIN users u ON u.id = t.assignee_id
           LEFT JOIN users c ON c.id = t.created_by
           LEFT JOIN iso_items i ON i.id = t.iso_item_id
           WHERE t.workspace_id = ?`;
  if (filter === 'mine') q += ` AND t.assignee_id = ${req.user.id}`;
  if (filter === 'open') q += ` AND t.status NOT IN ('done')`;
  q += ` ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at DESC`;
  const tasks = db.prepare(q).all(req.workspace.id);
  const wsUsers = db.prepare(`SELECT u.id, u.name FROM users u
    INNER JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = ?
    UNION SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1`)
    .all(req.workspace.id, req.workspace.firm_id);
  res.render('tasks', { user: req.user, ws: req.workspace, tasks, filter, wsUsers });
});

app.post('/workspaces/:wsId/tasks', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { title, description, iso_item_id, assignee_id, due_date } = req.body;
  if (!title) return res.redirect('back');
  const id = db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, assignee_id, due_date, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, title.trim(), description || null, iso_item_id || null,
         assignee_id || null, due_date || null, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_task', 'task', id, { title });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/tasks', 'Task created'));
});

app.post('/workspaces/:wsId/tasks/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { status, assignee_id, due_date, title, description } = req.body;
  const sets = []; const vals = [];
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (assignee_id !== undefined) { sets.push('assignee_id = ?'); vals.push(assignee_id || null); }
  if (due_date !== undefined) { sets.push('due_date = ?'); vals.push(due_date || null); }
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description || null); }
  if (sets.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE tasks SET ${sets.join(',')} WHERE id = ? AND workspace_id = ?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_task', 'task', req.params.id, null);
  }
  res.redirect('back');
});

app.post('/workspaces/:wsId/tasks/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/tasks');
});

// ==================== ACTIVITY / AUDIT LOG ====================
app.get('/workspaces/:wsId/activity', requireAuth, requireWorkspace, (req, res) => {
  const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
    INNER JOIN users u ON u.id = a.user_id
    WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 200`).all(req.workspace.id);
  res.render('activity', { user: req.user, ws: req.workspace, log });
});

// ==================== EXPORTS ====================
app.get('/workspaces/:wsId/export/soa.csv', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
    COALESCE(cs.applicability,'undecided') AS applicability,
    COALESCE(cs.status,'Not Assessed') AS status,
    cs.inclusion_justification, cs.exclusion_justification
    FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type = 'control' ORDER BY i.sort_order`).all(req.workspace.id);

  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Control ID,Title,Category,Applicability,Status,Inclusion Justification,Exclusion Justification'];
  rows.forEach(r => {
    lines.push([r.id.replace('annex-', '').toUpperCase(), r.title, r.category, r.applicability,
                r.status, r.inclusion_justification, r.exclusion_justification].map(esc).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="SoA-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
  res.send(lines.join('\n'));
});

app.get('/workspaces/:wsId/export/risks.csv', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT r.*, a.name AS asset_name FROM risks r
    LEFT JOIN assets a ON a.id = r.asset_id
    WHERE r.workspace_id = ? ORDER BY (r.likelihood * r.impact) DESC`).all(req.workspace.id);
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['ID,Title,Asset,Threat,Vulnerability,Likelihood,Impact,Score,Treatment,Owner,Status,Residual L,Residual I'];
  rows.forEach(r => {
    lines.push([r.id, r.title, r.asset_name, r.threat, r.vulnerability,
                r.likelihood, r.impact, r.likelihood * r.impact,
                r.treatment, r.owner_name, r.status,
                r.residual_likelihood, r.residual_impact].map(esc).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="Risks-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
  res.send(lines.join('\n'));
});

app.get('/workspaces/:wsId/export/assets.csv', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare('SELECT * FROM assets WHERE workspace_id = ? ORDER BY name').all(req.workspace.id);
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Name,Type,Classification,Owner,C,I,A,Description'];
  rows.forEach(r => lines.push([r.name, r.type, r.classification, r.owner_name,
    r.cia_c, r.cia_i, r.cia_a, r.description].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="Assets-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
  res.send(lines.join('\n'));
});

// ==================== DOCUMENTS ====================
function substitutePlaceholders(content, vars) {
  return content.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] !== undefined ? vars[key] : m);
}

app.get('/workspaces/:wsId/documents', requireAuth, requireWorkspace, (req, res) => {
  const docs = db.prepare(`SELECT d.*, u.name AS creator, t.name AS template_name
    FROM generated_docs d
    LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN doc_templates t ON t.id = d.template_id
    WHERE d.workspace_id = ? ORDER BY d.updated_at DESC`).all(req.workspace.id);
  const templates = db.prepare(`SELECT * FROM doc_templates
    WHERE is_system = 1 OR firm_id = ? ORDER BY category, name`).all(req.workspace.firm_id);
  res.render('documents', { user: req.user, ws: req.workspace, docs, templates });
});

app.post('/workspaces/:wsId/documents/from-template', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const { template_id, document_owner, approval_authority, review_period } = req.body;
  const tpl = db.prepare('SELECT * FROM doc_templates WHERE id = ?').get(template_id);
  if (!tpl) return res.redirect('back');
  const today = new Date().toISOString().split('T')[0];
  const firm = db.prepare('SELECT name FROM firms WHERE id = ?').get(req.workspace.firm_id);
  const vars = {
    client_name: req.workspace.client_name,
    scope: req.workspace.scope || `${req.workspace.client_name} information assets`,
    date: today,
    firm_name: firm?.name || '',
    document_owner: document_owner || 'CISO',
    approval_authority: approval_authority || 'Top Management',
    review_period: review_period || 'Annual',
    industry: req.workspace.industry || ''
  };
  const content = substitutePlaceholders(tpl.content, vars);
  const encContent = enc.encryptIfNeeded(content, req.workspace.id, !!req.workspace.encryption_enabled);
  const id = db.prepare(`INSERT INTO generated_docs (workspace_id, entity_id, template_id, name, category, content, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, req.entityScopeId || null, tpl.id, tpl.name, tpl.category, encContent, req.user.id).lastInsertRowid;
  // Snapshot v1
  snapshotDocVersion(id, req.workspace.id, 'draft', req.user.id, 'Initial draft from template: ' + tpl.name);
  logAction(req.user.id, req.workspace.id, 'create_document', 'document', id, { from_template: tpl.name }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + id, 'Document generated'));
});

app.post('/workspaces/:wsId/documents/blank', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const { name, category } = req.body;
  if (!name) return res.redirect('back');
  const initial = '# ' + name + '\n\n';
  const id = db.prepare(`INSERT INTO generated_docs (workspace_id, entity_id, name, category, content, created_by)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, req.entityScopeId || null, name, category || 'policy',
         enc.encryptIfNeeded(initial, req.workspace.id, !!req.workspace.encryption_enabled),
         req.user.id).lastInsertRowid;
  snapshotDocVersion(id, req.workspace.id, 'draft', req.user.id, 'Blank document');
  logAction(req.user.id, req.workspace.id, 'create_document', 'document', id, { name, category }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + id);
});

app.get('/workspaces/:wsId/documents/:id', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res, next) => {
  if (req.params.id === 'tree') return next();
  const docRaw = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!docRaw) return res.status(404).send('Not found');
  // Decrypt content for display
  const doc = { ...docRaw, content: enc.decryptIfNeeded(docRaw.content, req.workspace.id) };
  const comments = db.prepare(`SELECT c.*, u.name AS author FROM comments c
    INNER JOIN users u ON u.id = c.user_id
    WHERE c.workspace_id = ? AND c.parent_type = 'document' AND c.parent_id = ?
    ORDER BY c.created_at`).all(req.workspace.id, String(doc.id));
  // Decrypt comment bodies too
  const decryptedComments = comments.map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
  const filtered = isFirmUser(req.user) ? decryptedComments : decryptedComments.filter(c => !c.internal_only);

  // Approval / signature context
  const versions = listVersions(doc.id);
  const currentVersion = doc.current_version_id ? db.prepare('SELECT * FROM doc_versions WHERE id=?').get(doc.current_version_id) : null;
  const approvers = currentVersion ? listApprovers(doc.id, currentVersion.id) : [];
  const signatures = currentVersion ? listSignatures(doc.id, currentVersion.id) : [];
  const signatureIssues = currentVersion ? verifyVersionSignatures(currentVersion, signatures, req.workspace.id) : [];
  const wsUsers = db.prepare(`SELECT DISTINCT u.id, u.name, u.email FROM users u
    LEFT JOIN workspace_members m ON m.user_id=u.id
    WHERE (m.workspace_id=? OR (u.firm_id=? AND u.user_type='firm' AND u.active=1))
    ORDER BY u.name`).all(req.workspace.id, req.workspace.firm_id);

  res.render('document_detail', {
    user: req.user, ws: req.workspace, doc, comments: filtered,
    isFirm: isFirmUser(req.user),
    versions, currentVersion, approvers, signatures, signatureIssues, wsUsers,
    perms: res.locals.userPerms
  });
});

app.post('/workspaces/:wsId/documents/:id', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const before = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!before) return res.redirect('back');
  if (before.locked) return res.status(400).render('error', { user: req.user, message: 'Document is locked. Open a new version to edit.' });

  const { name, content, status } = req.body;
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (content !== undefined) {
    sets.push('content=?');
    vals.push(enc.encryptIfNeeded(content, req.workspace.id, !!req.workspace.encryption_enabled));
  }
  // Status changes only allowed via dedicated workflow endpoints; keep this for legacy autosave.
  sets.push('updated_at=CURRENT_TIMESTAMP');
  if (sets.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE generated_docs SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    const after = db.prepare('SELECT id, name, status FROM generated_docs WHERE id=?').get(req.params.id);
    const d = diffObjects(
      { name: before.name, status: before.status },
      { name: after.name, status: after.status }
    );
    logAction(req.user.id, req.workspace.id, 'update_document', 'document', req.params.id, null,
      { ...auditCtx(req), before: d.before, after: d.after });
  }
  // For XHR autosaves return 204 to avoid wasted round trips
  if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(204).end();
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + req.params.id);
});

app.get('/workspaces/:wsId/documents/:id/print', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const docRaw = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!docRaw) return res.status(404).send('Not found');
  const doc = { ...docRaw, content: enc.decryptIfNeeded(docRaw.content, req.workspace.id) };
  res.render('document_print', { doc, ws: req.workspace });
});

app.get('/workspaces/:wsId/documents/:id/download', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!doc) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\w]+/g,'_')}.md"`);
  res.send(enc.decryptIfNeeded(doc.content, req.workspace.id));
});

app.post('/workspaces/:wsId/documents/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM generated_docs WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/documents');
});

// ==================== INTERNAL AUDITS ====================
app.get('/workspaces/:wsId/audits', requireAuth, requireWorkspace, (req, res) => {
  const audits = db.prepare(`SELECT a.*,
    (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id) AS finding_count,
    (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id AND status = 'open') AS open_findings
    FROM audits a WHERE a.workspace_id = ? ORDER BY a.audit_date DESC, a.created_at DESC`).all(req.workspace.id);
  res.render('audits', { user: req.user, ws: req.workspace, audits });
});

app.post('/workspaces/:wsId/audits', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { title, scope, audit_date, auditor_name } = req.body;
  if (!title) return res.redirect('back');
  const id = db.prepare(`INSERT INTO audits (workspace_id, title, scope, audit_date, auditor_name, created_by)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, title, scope || null, audit_date || null, auditor_name || null, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_audit', 'audit', id, { title });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/audits/' + id, 'Audit created'));
});

app.get('/workspaces/:wsId/audits/:id', requireAuth, requireWorkspace, (req, res) => {
  const audit = db.prepare('SELECT * FROM audits WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Not found');
  const findings = db.prepare(`SELECT f.*, i.title AS iso_title FROM audit_findings f
    LEFT JOIN iso_items i ON i.id = f.iso_item_id
    WHERE f.audit_id = ? ORDER BY f.created_at`).all(audit.id);
  const allItems = db.prepare(`SELECT id, title FROM iso_items ORDER BY sort_order`).all();
  res.render('audit_detail', { user: req.user, ws: req.workspace, audit, findings, allItems });
});

app.post('/workspaces/:wsId/audits/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { title, scope, audit_date, auditor_name, status, summary } = req.body;
  db.prepare(`UPDATE audits SET title=?, scope=?, audit_date=?, auditor_name=?, status=?, summary=?
              WHERE id=? AND workspace_id=?`)
    .run(title, scope || null, audit_date || null, auditor_name || null,
         status || 'planned', summary || null, req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
});

app.post('/workspaces/:wsId/audits/:id/findings', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { iso_item_id, finding_type, description, severity } = req.body;
  if (!description) return res.redirect('back');
  db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, description, severity)
              VALUES (?, ?, ?, ?, ?)`)
    .run(req.params.id, iso_item_id || null, finding_type || 'observation',
         description, severity || 'medium');
  res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
});

app.post('/workspaces/:wsId/audits/:id/findings/:fId/promote', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const f = db.prepare('SELECT * FROM audit_findings WHERE id = ? AND audit_id = ?')
    .get(req.params.fId, req.params.id);
  if (!f) return res.redirect('back');
  if (f.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + f.nonconformity_id);
  const sev = f.finding_type === 'major_nc' ? 'major' : 'minor';
  const ncId = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity, iso_item_id)
                           VALUES (?, ?, 'internal_audit', ?, ?, ?, ?)`)
    .run(req.workspace.id, f.description.substring(0, 100),
         'Audit #' + req.params.id, f.description, sev, f.iso_item_id).lastInsertRowid;
  db.prepare('UPDATE audit_findings SET nonconformity_id = ? WHERE id = ?').run(ncId, f.id);
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
});

app.post('/workspaces/:wsId/audits/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM audits WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/audits');
});

// ==================== MANAGEMENT REVIEW ====================
app.get('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, (req, res) => {
  const mrms = db.prepare(`SELECT * FROM mrms WHERE workspace_id = ?
                           ORDER BY meeting_date DESC, created_at DESC`).all(req.workspace.id);
  res.render('mrms', { user: req.user, ws: req.workspace, mrms });
});

app.post('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { meeting_date, attendees } = req.body;
  const id = db.prepare(`INSERT INTO mrms (workspace_id, meeting_date, attendees, created_by)
                         VALUES (?, ?, ?, ?)`)
    .run(req.workspace.id, meeting_date || null, attendees || null, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_mrm', 'mrm', id, null);
  res.redirect('/workspaces/' + req.workspace.id + '/mrms/' + id);
});

app.get('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, (req, res) => {
  const mrm = db.prepare('SELECT * FROM mrms WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!mrm) return res.status(404).send('Not found');

  // Auto-collect inputs
  const audits = db.prepare(`SELECT title, status, audit_date FROM audits
                             WHERE workspace_id = ? ORDER BY audit_date DESC LIMIT 10`).all(req.workspace.id);
  const ncs = db.prepare(`SELECT title, severity, status FROM nonconformities
                          WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.workspace.id);
  const riskSummary = db.prepare(`SELECT status, COUNT(*) AS c FROM risks
                                  WHERE workspace_id = ? GROUP BY status`).all(req.workspace.id);
  const progress = workspaceProgress(req.workspace.id);
  res.render('mrm_detail', { user: req.user, ws: req.workspace, mrm, audits, ncs, riskSummary, progress });
});

app.post('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const f = ['meeting_date','attendees','status','context_changes','prior_actions_status',
             'performance_review','feedback_interested_parties','risk_treatment_status',
             'improvement_opportunities','decisions','action_items'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE mrms SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_mrm', 'mrm', req.params.id, null);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/mrms/' + req.params.id);
});

app.post('/workspaces/:wsId/mrms/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM mrms WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/mrms');
});

// ==================== NONCONFORMITIES / CAPA ====================
app.get('/workspaces/:wsId/nonconformities', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'open';
  let q = `SELECT n.*, i.title AS iso_title FROM nonconformities n
           LEFT JOIN iso_items i ON i.id = n.iso_item_id
           WHERE n.workspace_id = ?`;
  if (filter === 'open') q += ` AND n.status NOT IN ('closed','verified')`;
  q += ` ORDER BY n.created_at DESC`;
  const ncs = db.prepare(q).all(req.workspace.id);
  res.render('nonconformities', { user: req.user, ws: req.workspace, ncs, filter });
});

app.post('/workspaces/:wsId/nonconformities', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { title, source, description, severity, iso_item_id } = req.body;
  if (!title) return res.redirect('back');
  const id = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, description, severity, iso_item_id)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, title, source || 'other', description || null,
         severity || 'minor', iso_item_id || null).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_nc', 'nonconformity', id, { title });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/nonconformities/' + id, 'Nonconformity created'));
});

app.get('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, (req, res) => {
  const nc = db.prepare('SELECT * FROM nonconformities WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!nc) return res.status(404).send('Not found');
  const allItems = db.prepare(`SELECT id, title FROM iso_items ORDER BY sort_order`).all();
  res.render('nonconformity_detail', { user: req.user, ws: req.workspace, nc, allItems });
});

app.post('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const f = ['title','source','source_ref','description','severity','iso_item_id',
             'root_cause','corrective_action','responsible','due_date','effectiveness_check','status'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.status === 'closed' || req.body.status === 'verified') {
    set.push('closed_at=CURRENT_TIMESTAMP');
  }
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE nonconformities SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_nc', 'nonconformity', req.params.id, null);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + req.params.id);
});

app.post('/workspaces/:wsId/nonconformities/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM nonconformities WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities');
});

// ==================== BULK CONTROL UPDATE ====================
app.post('/workspaces/:wsId/bulk-controls', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { ids, status, applicability, owner_id } = req.body;
  const idList = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  let count = 0;
  for (const id of idList) {
    getOrCreateState(req.workspace.id, id);
    const sets = []; const vals = [];
    if (status) { sets.push('status=?'); vals.push(status); }
    if (applicability) { sets.push('applicability=?'); vals.push(applicability); }
    if (owner_id !== undefined && owner_id !== '') { sets.push('owner_id=?'); vals.push(owner_id); }
    if (sets.length) {
      sets.push('last_updated=CURRENT_TIMESTAMP');
      vals.push(req.workspace.id, id);
      db.prepare(`UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
      count++;
    }
  }
  logAction(req.user.id, req.workspace.id, 'bulk_update_controls', 'control', null, { count, status, applicability });
  res.redirect('back');
});

// ==================== AUTOSAVE (control fields) ====================
app.post('/workspaces/:wsId/controls/:isoId/autosave', requireAuth, requireWorkspace, express.json(), (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).json({ ok: false });
  getOrCreateState(req.workspace.id, req.params.isoId);
  const allowed = ['status','applicability','inclusion_justification','exclusion_justification',
                   'maturity','notes','owner_id','due_date'];
  if (isFirmUser(req.user)) allowed.push('internal_notes');
  const sets = []; const vals = [];
  Object.keys(req.body).forEach(k => {
    if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(req.body[k] || null); }
  });
  if (sets.length) {
    sets.push('last_updated=CURRENT_TIMESTAMP');
    vals.push(req.workspace.id, req.params.isoId);
    db.prepare(`UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
  }
  res.json({ ok: true, saved_at: new Date().toISOString() });
});

// ==================== FRAMEWORK MAPPINGS API (lookup for control_detail) ====================
app.get('/api/mappings/:isoId', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT framework, external_ref, notes FROM framework_mappings
                           WHERE iso_item_id = ?`).all(req.params.isoId);
  res.json(rows);
});

// ==================== CROSS-MAPPING REPORT ====================
app.get('/workspaces/:wsId/cross-map', requireAuth, requireWorkspace, (req, res) => {
  const framework = req.query.f || 'soc2';
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
      COALESCE(cs.status,'Not Assessed') AS status,
      GROUP_CONCAT(fm.external_ref, ', ') AS refs
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      LEFT JOIN framework_mappings fm ON fm.iso_item_id = i.id AND fm.framework = ?
      WHERE i.type = 'control'
      GROUP BY i.id ORDER BY i.sort_order`).all(req.workspace.id, framework);
  res.render('cross_map', { user: req.user, ws: req.workspace, rows, framework });
});

// ==================== READINESS ENGINE ====================
// Mandatory documented information per ISO 27001:2022.
// `tier: 'mandatory'` → explicitly required by a clause of ISO 27001:2022.
// `tier: 'expected'`  → not explicitly required but commonly produced and expected by certification auditors,
//                       or required only if the related Annex A control is included in the SoA.
// Detection is heuristic — confirms presence of an artefact in this tool; verify completeness manually.
const MANDATORY_RECORDS = [
  // ----- Explicitly mandatory per ISO 27001:2022 -----
  { key: 'isms_scope', tier: 'mandatory', clause: '4.3', name: 'ISMS scope',
    detect: (ws, db) => !!(ws.scope && ws.scope.length > 10) },
  { key: 'isms_policy', tier: 'mandatory', clause: '5.2', name: 'Information security policy',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND lower(name) LIKE '%information security policy%' AND status IN ('approved','published') LIMIT 1`).get(ws.id) },
  { key: 'risk_assessment_process', tier: 'mandatory', clause: '6.1.2', name: 'Risk assessment process',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND lower(name) LIKE '%risk%' AND (lower(name) LIKE '%procedure%' OR lower(name) LIKE '%process%' OR lower(name) LIKE '%methodology%') LIMIT 1`).get(ws.id) },
  { key: 'risk_assessment_results', tier: 'mandatory', clause: '6.1.2 / 8.2', name: 'Risk assessment results',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(ws.id).c > 0 },
  { key: 'risk_treatment_process', tier: 'mandatory', clause: '6.1.3', name: 'Risk treatment process',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND lower(name) LIKE '%risk%' AND lower(name) LIKE '%treatment%' LIMIT 1`).get(ws.id) ||
                        !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND lower(name) LIKE '%risk management%' LIMIT 1`).get(ws.id) },
  { key: 'soa', tier: 'mandatory', clause: '6.1.3 d)', name: 'Statement of Applicability',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM control_states WHERE workspace_id=? AND applicability IN ('included','excluded')`).get(ws.id).c >= 93 },
  { key: 'risk_treatment_plan', tier: 'mandatory', clause: '6.1.3 e) / 8.3', name: 'Risk treatment plan',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND treatment IS NOT NULL`).get(ws.id).c > 0 },
  { key: 'objectives', tier: 'mandatory', clause: '6.2', name: 'Information security objectives',
    detect: (ws, db) => {
      const cs = db.prepare(`SELECT notes FROM control_states WHERE workspace_id=? AND iso_item_id='clause-6.2'`).get(ws.id);
      return !!(cs && cs.notes && cs.notes.length > 30);
    } },
  { key: 'competence', tier: 'mandatory', clause: '7.2', name: 'Records of competence',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id IN ('clause-7.2','annex-a.6.3') LIMIT 1`).get(ws.id) },
  { key: 'operational_planning', tier: 'mandatory', clause: '8.1', name: 'Evidence operational processes carried out as planned',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? LIMIT 1`).get(ws.id) },
  { key: 'monitoring_results', tier: 'mandatory', clause: '9.1', name: 'Monitoring and measurement results',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id='clause-9.1' LIMIT 1`).get(ws.id) },
  { key: 'internal_audit_programme', tier: 'mandatory', clause: '9.2', name: 'Internal audit programme',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`).get(ws.id).c > 0 },
  { key: 'internal_audit_results', tier: 'mandatory', clause: '9.2', name: 'Internal audit results',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND status='complete'`).get(ws.id).c > 0 },
  { key: 'management_review', tier: 'mandatory', clause: '9.3', name: 'Management review results',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status='complete'`).get(ws.id).c > 0 },
  { key: 'nc_records', tier: 'mandatory', clause: '10.2', name: 'Nonconformities and corrective action results',
    detect: (ws, db) => true },

  // ----- Required if the related Annex A control is included in the SoA -----
  { key: 'asset_inventory', tier: 'expected', clause: 'A.5.9', name: 'Inventory of information and associated assets',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM assets WHERE workspace_id=?`).get(ws.id).c > 0 },
  { key: 'legal_register', tier: 'expected', clause: 'A.5.31', name: 'Register of legal, regulatory, contractual requirements',
    detect: (ws, db) => {
      const cs = db.prepare(`SELECT notes FROM control_states WHERE workspace_id=? AND iso_item_id='annex-a.5.31'`).get(ws.id);
      return !!(cs && cs.notes && cs.notes.length > 30);
    } },
  { key: 'access_control', tier: 'expected', clause: 'A.5.15', name: 'Topic-specific policy on access control',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND lower(name) LIKE '%access control%' LIMIT 1`).get(ws.id) },
  { key: 'incident_plan', tier: 'expected', clause: 'A.5.24', name: 'Incident management procedure',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND lower(name) LIKE '%incident%' LIMIT 1`).get(ws.id) },
  { key: 'continuity', tier: 'expected', clause: 'A.5.29 / A.5.30', name: 'Business continuity / ICT readiness arrangements',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND (lower(name) LIKE '%continuity%' OR lower(name) LIKE '%disaster%') LIMIT 1`).get(ws.id) },
  { key: 'awareness', tier: 'expected', clause: '7.3 / A.6.3', name: 'Awareness and training records',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id IN ('annex-a.6.3','clause-7.3') LIMIT 1`).get(ws.id) },
  { key: 'cryptography_policy', tier: 'expected', clause: 'A.8.24', name: 'Cryptography topic-specific policy (if A.8.24 included)',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND lower(name) LIKE '%crypto%' LIMIT 1`).get(ws.id) }
];

function computeReadiness(ws) {
  const checks = MANDATORY_RECORDS.map(m => ({
    key: m.key, name: m.name, clause: m.clause, tier: m.tier,
    found: !!m.detect(ws, db)
  }));
  const mandatoryChecks = checks.filter(c => c.tier === 'mandatory');
  const expectedChecks = checks.filter(c => c.tier === 'expected');
  const mandFound = mandatoryChecks.filter(c => c.found).length;
  const mandTotal = mandatoryChecks.length;
  const expFound = expectedChecks.filter(c => c.found).length;
  const expTotal = expectedChecks.length;
  const recordsFound = mandFound;
  const recordsTotal = mandTotal;

  // Validation flags — actionable issues, not tutorials
  const flags = [];

  const implNoEvidence = db.prepare(`
    SELECT i.id, i.title FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.status='Implemented'
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.workspace_id=? AND e.iso_item_id=cs.iso_item_id)
  `).all(ws.id, ws.id);
  if (implNoEvidence.length) flags.push({ kind: 'implemented_no_evidence', severity: 'high',
    label: `${implNoEvidence.length} controls marked Implemented without evidence`,
    items: implNoEvidence.slice(0, 10) });

  const implNoOwner = db.prepare(`
    SELECT i.id, i.title FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.status IN ('Implemented','Partially Implemented') AND cs.owner_id IS NULL
  `).all(ws.id);
  if (implNoOwner.length) flags.push({ kind: 'no_owner', severity: 'medium',
    label: `${implNoOwner.length} active controls without an owner`,
    items: implNoOwner.slice(0, 10) });

  const includedNoRisk = db.prepare(`
    SELECT i.id, i.title FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.applicability='included' AND i.type='control'
    AND NOT EXISTS (SELECT 1 FROM risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?)
    AND (cs.inclusion_justification IS NULL OR length(cs.inclusion_justification) < 10)
  `).all(ws.id, ws.id);
  if (includedNoRisk.length) flags.push({ kind: 'included_no_basis', severity: 'high',
    label: `${includedNoRisk.length} SoA-included controls have no driving risk and no justification`,
    items: includedNoRisk.slice(0, 10) });

  const excludedNoJust = db.prepare(`
    SELECT i.id, i.title FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.applicability='excluded' AND i.type='control'
    AND (cs.exclusion_justification IS NULL OR length(cs.exclusion_justification) < 10)
  `).all(ws.id);
  if (excludedNoJust.length) flags.push({ kind: 'excluded_no_basis', severity: 'high',
    label: `${excludedNoJust.length} SoA-excluded controls without justification`,
    items: excludedNoJust.slice(0, 10) });

  const undecidedSoA = db.prepare(`
    SELECT COUNT(*) c FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND COALESCE(cs.applicability,'undecided')='undecided'
  `).get(ws.id).c;
  if (undecidedSoA > 0) flags.push({ kind: 'undecided_soa', severity: 'medium',
    label: `${undecidedSoA} Annex A controls still undecided in the SoA`, items: [] });

  const openMajorNCs = db.prepare(`
    SELECT id, title FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')
  `).all(ws.id);
  if (openMajorNCs.length) flags.push({ kind: 'open_major_ncs', severity: 'high',
    label: `${openMajorNCs.length} major nonconformities open`,
    items: openMajorNCs });

  const overdueNCs = db.prepare(`
    SELECT id, title, due_date FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < date('now')
  `).all(ws.id);
  if (overdueNCs.length) flags.push({ kind: 'overdue_ncs', severity: 'high',
    label: `${overdueNCs.length} nonconformities past due`,
    items: overdueNCs });

  const orphanRisks = db.prepare(`
    SELECT id, title FROM risks WHERE workspace_id=? AND status='open'
    AND NOT EXISTS (SELECT 1 FROM risk_controls WHERE risk_id=risks.id)
  `).all(ws.id);
  if (orphanRisks.length) flags.push({ kind: 'orphan_risks', severity: 'medium',
    label: `${orphanRisks.length} open risks not linked to any control`,
    items: orphanRisks.slice(0, 10) });

  const noOwnerRisks = db.prepare(`
    SELECT id, title FROM risks WHERE workspace_id=? AND (owner_name IS NULL OR owner_name='')
  `).all(ws.id);
  if (noOwnerRisks.length) flags.push({ kind: 'no_owner_risks', severity: 'medium',
    label: `${noOwnerRisks.length} risks without an owner`,
    items: noOwnerRisks.slice(0, 10) });

  // Supplier-related flags
  const expiredSupplierDocs = db.prepare(`
    SELECT s.name AS title, s.id, d.name AS doc, d.expiry_date FROM supplier_documents d
    INNER JOIN suppliers s ON s.id=d.supplier_id
    WHERE s.workspace_id=? AND d.expiry_date < date('now')`).all(ws.id);
  if (expiredSupplierDocs.length) flags.push({ kind: 'expired_supplier_docs', severity: 'high',
    label: `${expiredSupplierDocs.length} supplier attestations / contracts expired`,
    items: expiredSupplierDocs.map(d => ({ id: d.id, title: `${d.title} — ${d.doc}` })).slice(0, 10) });

  const overdueSupplierReviews = db.prepare(`
    SELECT id, name AS title FROM suppliers
    WHERE workspace_id=? AND lifecycle_stage NOT IN ('terminated') AND next_review_date < date('now')`).all(ws.id);
  if (overdueSupplierReviews.length) flags.push({ kind: 'overdue_supplier_reviews', severity: 'medium',
    label: `${overdueSupplierReviews.length} supplier reviews overdue`,
    items: overdueSupplierReviews.slice(0, 10) });

  const tier1NoAttestation = db.prepare(`
    SELECT s.id, s.name AS title FROM suppliers s
    WHERE s.workspace_id=? AND s.lifecycle_stage NOT IN ('terminated')
    AND (s.tier='tier_1' OR s.residual_risk_score>=18)
    AND NOT EXISTS (SELECT 1 FROM supplier_documents d WHERE d.supplier_id=s.id AND d.doc_type IN ('iso_27001','soc2_type2','soc2_type1'))`).all(ws.id);
  if (tier1NoAttestation.length) flags.push({ kind: 'tier1_no_attestation', severity: 'high',
    label: `${tier1NoAttestation.length} critical-tier suppliers without ISO 27001 / SOC 2 attestation`,
    items: tier1NoAttestation.slice(0, 10) });

  const overdueAccessReview = db.prepare(`
    SELECT i.id, i.title, cs.last_updated FROM control_states cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.iso_item_id IN ('annex-a.5.15','annex-a.5.18','annex-a.8.2')
    AND cs.status='Implemented' AND cs.last_updated < datetime('now','-180 days')
  `).all(ws.id);
  if (overdueAccessReview.length) flags.push({ kind: 'stale_access_review', severity: 'medium',
    label: `Access controls reviewed > 180 days ago`,
    items: overdueAccessReview });

  // Quantitative metrics
  const totals = db.prepare(`SELECT
    SUM(CASE WHEN status='Implemented' THEN 1 ELSE 0 END) AS implemented,
    SUM(CASE WHEN status='Partially Implemented' THEN 1 ELSE 0 END) AS partial,
    SUM(CASE WHEN status='Work In Progress' THEN 1 ELSE 0 END) AS wip,
    SUM(CASE WHEN status='Not Implemented' THEN 1 ELSE 0 END) AS not_impl,
    SUM(CASE WHEN status='Not Applicable' THEN 1 ELSE 0 END) AS na,
    AVG(CASE WHEN maturity > 0 THEN maturity END) AS avg_maturity,
    COUNT(*) AS total
    FROM control_states WHERE workspace_id=?`).get(ws.id) || {};

  const totalItems = db.prepare(`SELECT COUNT(*) c FROM iso_items`).get().c;
  const assessed = db.prepare(`SELECT COUNT(*) c FROM control_states WHERE workspace_id=? AND status != 'Not Assessed'`).get(ws.id).c;

  // Stage 1 readiness: weighted score
  // 30% mandatory records found, 35% Annex A controls implemented or N/A, 15% no high-severity flags,
  // 10% MRM exists, 10% internal audit complete
  const recordsScore = recordsTotal ? recordsFound / recordsTotal : 0;
  const ctrlScore = totalItems ? ((totals.implemented || 0) + (totals.na || 0)) / totalItems : 0;
  const highFlagsCount = flags.filter(f => f.severity === 'high').length;
  const flagScore = Math.max(0, 1 - highFlagsCount / 5);
  const mrmComplete = db.prepare(`SELECT 1 FROM mrms WHERE workspace_id=? AND status='complete' LIMIT 1`).get(ws.id) ? 1 : 0;
  const auditComplete = db.prepare(`SELECT 1 FROM audits WHERE workspace_id=? AND status='complete' LIMIT 1`).get(ws.id) ? 1 : 0;
  const stage1 = Math.round((0.30 * recordsScore + 0.35 * ctrlScore + 0.15 * flagScore + 0.10 * mrmComplete + 0.10 * auditComplete) * 100);

  // Stage 2 readiness: same plus operational evidence
  const evidenceCount = db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`).get(ws.id).c;
  const evidenceCoverage = totalItems ? Math.min(1, evidenceCount / (totalItems * 0.6)) : 0;
  const stage2 = Math.round((0.20 * recordsScore + 0.30 * ctrlScore + 0.20 * flagScore + 0.10 * mrmComplete + 0.10 * auditComplete + 0.10 * evidenceCoverage) * 100);

  // Days to target cert
  let daysToTarget = null;
  if (ws.target_cert_date) {
    const diff = Math.ceil((new Date(ws.target_cert_date) - new Date()) / (1000*60*60*24));
    daysToTarget = diff;
  }

  return {
    stage1, stage2,
    daysToTarget,
    records: { found: recordsFound, total: recordsTotal, checks,
               mandatory: { found: mandFound, total: mandTotal, checks: mandatoryChecks },
               expected:  { found: expFound,  total: expTotal,  checks: expectedChecks } },
    flags,
    metrics: {
      assessed, totalItems,
      implemented: totals.implemented || 0,
      partial: totals.partial || 0,
      wip: totals.wip || 0,
      notImpl: totals.not_impl || 0,
      na: totals.na || 0,
      avgMaturity: totals.avg_maturity ? Number(totals.avg_maturity).toFixed(1) : '—',
      evidenceCount
    }
  };
}

app.get('/workspaces/:wsId/readiness', requireAuth, requireWorkspace, (req, res) => {
  const r = computeReadiness(req.workspace);
  res.render('readiness', { user: req.user, ws: req.workspace, r });
});

app.get('/api/workspaces/:wsId/readiness', requireAuth, requireWorkspace, (req, res) => {
  res.json(computeReadiness(req.workspace));
});

// ==================== COMMAND PALETTE SEARCH ====================
app.get('/api/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const wsId = req.query.wsId ? parseInt(req.query.wsId, 10) : null;
  if (!q) return res.json([]);
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const results = [];

  // Workspaces this user can access
  const wsList = listWorkspaces(req.user).filter(w => w.client_name.toLowerCase().includes(q) || (w.industry && w.industry.toLowerCase().includes(q)));
  wsList.slice(0, 5).forEach(w => results.push({
    type: 'Client', label: w.client_name, sublabel: w.industry || w.stage,
    href: '/workspaces/' + w.id, badge: w.stage.replace(/_/g, ' ')
  }));

  if (wsId) {
    const ws = getWorkspace(wsId, req.user);
    if (ws) {
      // ISO items (clauses + controls) — search across all
      const items = db.prepare(`SELECT id, title, type FROM iso_items
                                 WHERE lower(title) LIKE ? OR lower(id) LIKE ?
                                 ORDER BY sort_order LIMIT 8`).all(like, like);
      items.forEach(i => results.push({
        type: i.type === 'clause' ? 'Clause' : 'Control',
        label: i.title,
        sublabel: i.id.startsWith('clause') ? i.id.replace('clause-', 'Cl. ') : i.id.replace('annex-', '').toUpperCase(),
        href: '/workspaces/' + wsId + '/controls/' + i.id
      }));

      const risks = db.prepare(`SELECT id, title FROM risks WHERE workspace_id = ? AND lower(title) LIKE ? LIMIT 5`).all(wsId, like);
      risks.forEach(r => results.push({ type: 'Risk', label: r.title, sublabel: 'R-' + String(r.id).padStart(3,'0'), href: '/workspaces/' + wsId + '/risks/' + r.id }));

      const assets = db.prepare(`SELECT id, name, type FROM assets WHERE workspace_id = ? AND lower(name) LIKE ? LIMIT 5`).all(wsId, like);
      assets.forEach(a => results.push({ type: 'Asset', label: a.name, sublabel: a.type, href: '/workspaces/' + wsId + '/assets' }));

      const docs = db.prepare(`SELECT id, name, status FROM generated_docs WHERE workspace_id = ? AND lower(name) LIKE ? LIMIT 5`).all(wsId, like);
      docs.forEach(d => results.push({ type: 'Document', label: d.name, sublabel: d.status, href: '/workspaces/' + wsId + '/documents/' + d.id }));

      const ncs = db.prepare(`SELECT id, title FROM nonconformities WHERE workspace_id = ? AND lower(title) LIKE ? LIMIT 5`).all(wsId, like);
      ncs.forEach(n => results.push({ type: 'NC', label: n.title, sublabel: 'NC-' + String(n.id).padStart(3,'0'), href: '/workspaces/' + wsId + '/nonconformities/' + n.id }));

      // Nav shortcuts in current workspace
      const nav = [
        ['Overview', ''], ['Readiness', '/readiness'], ['Controls', '/controls'],
        ['Assets', '/assets'], ['Risks', '/risks'], ['Statement of Applicability', '/soa'],
        ['Documents', '/documents'], ['Internal audits', '/audits'], ['Management review', '/mrms'],
        ['Nonconformities', '/nonconformities'], ['Tasks', '/tasks'],
        ['Cross-mapping', '/cross-map'], ['Members', '/members'], ['Activity log', '/activity']
      ];
      nav.filter(([n]) => n.toLowerCase().includes(q)).slice(0, 5).forEach(([n, p]) => {
        results.push({ type: 'Page', label: n, sublabel: ws.client_name, href: '/workspaces/' + wsId + p });
      });
    }
  } else {
    if ('clients'.includes(q) || 'dashboard'.includes(q) || 'home'.includes(q)) {
      results.push({ type: 'Page', label: 'Clients', sublabel: 'All workspaces', href: '/dashboard' });
    }
  }

  res.json(results.slice(0, 30));
});

// ==================== DOCX EXPORT ====================
function markdownToDocxParagraphs(md) {
  const lines = md.split('\n');
  const parts = [];
  let i = 0;
  const inline = (text) => {
    const runs = [];
    let cur = '';
    let bold = false, italic = false;
    let j = 0;
    while (j < text.length) {
      if (text.substr(j, 2) === '**') {
        if (cur) { runs.push(new TextRun({ text: cur, bold, italics: italic })); cur = ''; }
        bold = !bold; j += 2;
      } else if (text[j] === '*') {
        if (cur) { runs.push(new TextRun({ text: cur, bold, italics: italic })); cur = ''; }
        italic = !italic; j += 1;
      } else if (text[j] === '`') {
        const end = text.indexOf('`', j + 1);
        if (end > 0) {
          if (cur) { runs.push(new TextRun({ text: cur, bold, italics: italic })); cur = ''; }
          runs.push(new TextRun({ text: text.substring(j + 1, end), font: 'Consolas', shading: { type: 'solid', color: 'F4F4F5' } }));
          j = end + 1;
        } else { cur += text[j++]; }
      } else { cur += text[j++]; }
    }
    if (cur) runs.push(new TextRun({ text: cur, bold, italics: italic }));
    return runs.length ? runs : [new TextRun({ text: '' })];
  };

  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.+)$/))) {
      const lvl = m[1].length;
      const headingMap = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
      parts.push(new Paragraph({ heading: headingMap[lvl - 1], children: inline(m[2]), spacing: { before: 240, after: 120 } }));
      i++; continue;
    }
    if (/^\|/.test(l) && i + 1 < lines.length && /^\|[-\s|:]+\|$/.test(lines[i + 1])) {
      const headerCells = lines[i].split('|').slice(1, -1).map(c => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim())); i++;
      }
      const docxRows = [
        new TableRow({ children: headerCells.map(h => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })], shading: { fill: 'F4F4F5' } })) }),
        ...rows.map(r => new TableRow({ children: r.map(c => new TableCell({ children: [new Paragraph({ children: inline(c) })] })) }))
      ];
      parts.push(new Table({ rows: docxRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      parts.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
      continue;
    }
    if (/^[-*]\s/.test(l)) {
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        parts.push(new Paragraph({ children: inline(lines[i].replace(/^[-*]\s/, '')), bullet: { level: 0 } }));
        i++;
      }
      continue;
    }
    if (/^>\s?/.test(l)) {
      parts.push(new Paragraph({ children: inline(l.replace(/^>\s?/, '')), indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: '4F46E5', space: 12 } } }));
      i++; continue;
    }
    if (/^---+$/.test(l)) {
      parts.push(new Paragraph({ children: [new TextRun({ text: '' })], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D6D6DB' } } }));
      i++; continue;
    }
    if (l.trim() === '') { parts.push(new Paragraph({ children: [new TextRun({ text: '' })] })); i++; continue; }
    parts.push(new Paragraph({ children: inline(l), spacing: { after: 120 } }));
    i++;
  }
  return parts;
}

async function generateDocxBuffer(doc, ws) {
  const para = markdownToDocxParagraphs(doc.content || '');
  const watermarkText = doc.watermark
    || (doc.status === 'draft' ? 'DRAFT — NOT FOR DISTRIBUTION'
       : doc.status === 'in_review' ? 'IN REVIEW'
       : doc.status === 'retired' ? 'RETIRED'
       : doc.controlled_copy ? 'CONTROLLED COPY' : null);
  const meta = new Paragraph({
    children: [new TextRun({ text: `${ws.client_name} · v${doc.version} · status: ${doc.status}` + (watermarkText ? ` · ${watermarkText}` : ''), size: 18, color: '71717A' })],
    alignment: AlignmentType.RIGHT
  });
  const headerBanner = watermarkText
    ? [new Paragraph({
        children: [new TextRun({ text: watermarkText, bold: true, color: 'B91C1C', size: 28 })],
        alignment: AlignmentType.CENTER,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'B91C1C', space: 4 } }
      })]
    : [];
  const docxDoc = new Document({
    creator: 'ISMS', title: doc.name,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      children: [meta, ...headerBanner, ...para,
        new Paragraph({
          children: [new TextRun({ text: `Document hash basis: rendered ${new Date().toISOString()}`, size: 14, color: '9C9CA5' })],
          alignment: AlignmentType.CENTER, spacing: { before: 400 }
        })]
    }]
  });
  return Packer.toBuffer(docxDoc);
}

app.get('/workspaces/:wsId/documents/:id/docx', requireAuth, requireWorkspace, requirePermission('document.view'), async (req, res) => {
  const docRaw = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!docRaw) return res.status(404).send('Not found');
  const doc = { ...docRaw, content: enc.decryptIfNeeded(docRaw.content, req.workspace.id) };
  try {
    const buf = await generateDocxBuffer(doc, req.workspace);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\w\- ]+/g,'_')}.docx"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).send('Failed to generate .docx: ' + e.message); }
});

// ==================== AUDIT PACK EXPORT ====================
app.get('/workspaces/:wsId/audit-pack', requireAuth, requireWorkspace, async (req, res) => {
  const ws = req.workspace;
  const safeName = ws.client_name.replace(/[^\w]+/g, '_');
  const today = new Date().toISOString().split('T')[0];

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="audit-pack-${safeName}-${today}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', err => { console.error(err); res.status(500).end(); });
  zip.pipe(res);

  const manifest = ['ISO 27001:2022 Audit Pack', '='.repeat(40), `Client: ${ws.client_name}`, `Generated: ${new Date().toISOString()}`, `Stage: ${ws.stage}`, ws.target_cert_date ? `Target cert: ${ws.target_cert_date}` : '', '', 'Contents:', ''];

  // SoA CSV
  const soaRows = db.prepare(`SELECT i.id, i.title, i.category,
    COALESCE(cs.applicability,'undecided') AS applicability,
    COALESCE(cs.status,'Not Assessed') AS status,
    cs.inclusion_justification, cs.exclusion_justification
    FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type = 'control' ORDER BY i.sort_order`).all(ws.id);
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  let soaCsv = 'Control ID,Title,Category,Applicability,Status,Inclusion Justification,Exclusion Justification\n';
  soaRows.forEach(r => { soaCsv += [r.id.replace('annex-','').toUpperCase(), r.title, r.category, r.applicability, r.status, r.inclusion_justification, r.exclusion_justification].map(esc).join(',') + '\n'; });
  zip.append(soaCsv, { name: '01_Statement_of_Applicability.csv' });
  manifest.push(`  01_Statement_of_Applicability.csv (${soaRows.length} controls)`);

  // Risk register CSV
  const riskRows = db.prepare(`SELECT r.*, a.name AS asset_name FROM risks r LEFT JOIN assets a ON a.id=r.asset_id WHERE r.workspace_id=? ORDER BY (r.likelihood*r.impact) DESC`).all(ws.id);
  let riskCsv = 'ID,Title,Asset,Threat,Vulnerability,L,I,Score,Treatment,Owner,Status,Residual L,Residual I\n';
  riskRows.forEach(r => { riskCsv += ['R-' + String(r.id).padStart(3,'0'), r.title, r.asset_name, r.threat, r.vulnerability, r.likelihood, r.impact, r.likelihood*r.impact, r.treatment, r.owner_name, r.status, r.residual_likelihood, r.residual_impact].map(esc).join(',') + '\n'; });
  zip.append(riskCsv, { name: '02_Risk_Register.csv' });
  manifest.push(`  02_Risk_Register.csv (${riskRows.length} risks)`);

  // Asset inventory CSV
  const assetRows = db.prepare(`SELECT * FROM assets WHERE workspace_id=? ORDER BY name`).all(ws.id);
  let assetCsv = 'Name,Type,Classification,Owner,C,I,A,Description\n';
  assetRows.forEach(r => { assetCsv += [r.name, r.type, r.classification, r.owner_name, r.cia_c, r.cia_i, r.cia_a, r.description].map(esc).join(',') + '\n'; });
  zip.append(assetCsv, { name: '03_Asset_Inventory.csv' });
  manifest.push(`  03_Asset_Inventory.csv (${assetRows.length} assets)`);

  // Approved/published documents as .docx
  const docs = db.prepare(`SELECT * FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') ORDER BY name`).all(ws.id);
  for (const dRaw of docs) {
    const d = { ...dRaw, content: enc.decryptIfNeeded(dRaw.content, ws.id) };
    try {
      const buf = await generateDocxBuffer(d, ws);
      zip.append(buf, { name: `04_Documents/${d.name.replace(/[^\w\- ]+/g,'_')}.docx` });
      manifest.push(`  04_Documents/${d.name}.docx`);
      // Include signature manifest for each approved doc (audit trail)
      if (d.current_version_id) {
        const v = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(d.current_version_id);
        const sigs = listSignatures(d.id, d.current_version_id);
        if (v && sigs.length) {
          let sigTxt = `SIGNATURES — ${d.name}\n${'='.repeat(40)}\n\nVersion: ${v.version}\nContent SHA-256: ${v.content_hash}\n\n`;
          sigs.forEach(s => {
            const ok = enc.verifyHmac(`${s.document_id}|${s.version_id}|${s.user_id}|${s.content_hash}|${s.intent}|${s.signed_at}`, ws.id, s.signature);
            sigTxt += `Signer: ${s.user_name} (${s.signature_role || 'unspecified'})\nIntent: ${s.intent}\nSigned: ${s.signed_at}\nIP: ${s.ip_address || '-'}\nUA: ${(s.user_agent || '').slice(0, 80)}\nHMAC: ${s.signature}\nVerification: ${ok ? 'OK' : 'FAILED'}\n\n`;
          });
          zip.append(sigTxt, { name: `04_Documents/${d.name.replace(/[^\w\- ]+/g,'_')}__signatures.txt` });
        }
      }
    } catch (e) { console.error('docx gen failed', d.id, e.message); }
  }
  if (docs.length === 0) manifest.push(`  04_Documents/ (no approved documents yet)`);

  // Audit reports (txt summary per audit)
  const audits = db.prepare(`SELECT * FROM audits WHERE workspace_id=? ORDER BY audit_date DESC`).all(ws.id);
  for (const a of audits) {
    const findings = db.prepare(`SELECT f.*, i.title AS iso_title FROM audit_findings f LEFT JOIN iso_items i ON i.id=f.iso_item_id WHERE f.audit_id=?`).all(a.id);
    let txt = `INTERNAL AUDIT REPORT\n${'='.repeat(40)}\n\nTitle: ${a.title}\nDate: ${a.audit_date || '-'}\nAuditor: ${a.auditor_name || '-'}\nStatus: ${a.status}\nScope: ${a.scope || '-'}\n\nSUMMARY\n${a.summary || '(none)'}\n\nFINDINGS (${findings.length})\n${'='.repeat(40)}\n`;
    findings.forEach(f => { txt += `\n[${f.finding_type.toUpperCase()}] severity=${f.severity}${f.iso_title ? '\nRelated: ' + f.iso_title : ''}\n${f.description}\n`; });
    zip.append(txt, { name: `05_Internal_Audits/${a.audit_date || 'undated'}_${a.title.replace(/[^\w]+/g,'_')}.txt` });
  }
  manifest.push(`  05_Internal_Audits/ (${audits.length} audits)`);

  // MRMs
  const mrms = db.prepare(`SELECT * FROM mrms WHERE workspace_id=? ORDER BY meeting_date DESC`).all(ws.id);
  for (const m of mrms) {
    let txt = `MANAGEMENT REVIEW\n${'='.repeat(40)}\n\nDate: ${m.meeting_date || '-'}\nAttendees: ${m.attendees || '-'}\nStatus: ${m.status}\n\nINPUTS (Clause 9.3.2)\n${'-'.repeat(40)}\n`;
    txt += `\nPrior actions: ${m.prior_actions_status || '(none)'}\nContext changes: ${m.context_changes || '(none)'}\nPerformance review: ${m.performance_review || '(none)'}\nFeedback from interested parties: ${m.feedback_interested_parties || '(none)'}\nRisk treatment status: ${m.risk_treatment_status || '(none)'}\nImprovement opportunities: ${m.improvement_opportunities || '(none)'}\n\nOUTPUTS (Clause 9.3.3)\n${'-'.repeat(40)}\n\nDecisions: ${m.decisions || '(none)'}\nAction items: ${m.action_items || '(none)'}\n`;
    zip.append(txt, { name: `06_Management_Reviews/${m.meeting_date || 'undated'}_MRM.txt` });
  }
  manifest.push(`  06_Management_Reviews/ (${mrms.length} reviews)`);

  // NCs
  const ncs = db.prepare(`SELECT * FROM nonconformities WHERE workspace_id=? ORDER BY id`).all(ws.id);
  let ncCsv = 'ID,Title,Source,Severity,Status,Root cause,Corrective action,Responsible,Due date,Effectiveness check,Closed at\n';
  ncs.forEach(n => { ncCsv += ['NC-' + String(n.id).padStart(3,'0'), n.title, n.source, n.severity, n.status, n.root_cause, n.corrective_action, n.responsible, n.due_date, n.effectiveness_check, n.closed_at].map(esc).join(',') + '\n'; });
  zip.append(ncCsv, { name: '07_Nonconformities.csv' });
  manifest.push(`  07_Nonconformities.csv (${ncs.length} NCs)`);

  // Evidence files with hash listing
  const evidence = db.prepare(`SELECT * FROM evidence WHERE workspace_id=?`).all(ws.id);
  let evIdx = 'EVIDENCE INDEX\n' + '='.repeat(40) + '\n\n';
  for (const e of evidence) {
    const fp = path.join(__dirname, 'uploads', e.stored_path);
    if (fs.existsSync(fp)) {
      zip.file(fp, { name: `08_Evidence/${e.id}_${e.filename}` });
      evIdx += `${e.id}_${e.filename}\n  Linked to: ${e.iso_item_id || '(general)'}\n  Uploaded: ${e.uploaded_at}\n  SHA-256: ${e.sha256}\n  Size: ${e.size_bytes} bytes\n  Description: ${e.description || '(none)'}\n\n`;
    }
  }
  zip.append(evIdx, { name: '08_Evidence/INDEX.txt' });
  manifest.push(`  08_Evidence/ (${evidence.length} files, integrity hashes in INDEX.txt)`);

  // Activity log
  const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.created_at`).all(ws.id);
  let logCsv = 'When,Who,Action,Entity Type,Entity ID,Details\n';
  log.forEach(l => { logCsv += [l.created_at, l.user_name, l.action, l.entity_type, l.entity_id, l.details].map(esc).join(',') + '\n'; });
  zip.append(logCsv, { name: '09_Activity_Log.csv' });
  manifest.push(`  09_Activity_Log.csv (${log.length} entries)`);

  zip.append(manifest.join('\n'), { name: '00_MANIFEST.txt' });
  await zip.finalize();
  logAction(req.user.id, ws.id, 'export_audit_pack', 'workspace', ws.id, null);
});

// ==================== INCIDENTS ====================
app.get('/workspaces/:wsId/incidents', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'open';
  let q = `SELECT * FROM incidents WHERE workspace_id = ?`;
  if (filter === 'open') q += ` AND status NOT IN ('closed')`;
  q += ` ORDER BY detected_at DESC, created_at DESC`;
  const incidents = db.prepare(q).all(req.workspace.id);
  res.render('incidents', { user: req.user, ws: req.workspace, incidents, filter });
});

app.post('/workspaces/:wsId/incidents', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { title, category, severity, detected_at, reported_by, description } = req.body;
  if (!title) return res.redirect('back');
  const id = db.prepare(`INSERT INTO incidents (workspace_id, title, category, severity, detected_at, reported_by, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.workspace.id, title, category || 'other', severity || 'medium',
    detected_at || null, reported_by || null, description || null).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_incident', 'incident', id, { title });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/incidents/' + id, 'Incident logged'));
});

app.get('/workspaces/:wsId/incidents/:id', requireAuth, requireWorkspace, (req, res) => {
  const inc = db.prepare(`SELECT * FROM incidents WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!inc) return res.status(404).send('Not found');
  const events = db.prepare('SELECT * FROM incident_events WHERE incident_id=? ORDER BY event_at').all(inc.id);
  const runbooks = db.prepare(`SELECT id, name, category, trigger_severity FROM runbooks WHERE is_system=1 OR firm_id=? ORDER BY name`).all(req.workspace.firm_id);
  let runbook = null;
  if (inc.runbook_id) {
    runbook = db.prepare('SELECT * FROM runbooks WHERE id=?').get(inc.runbook_id);
    if (runbook) runbook.steps = JSON.parse(runbook.steps);
  }
  res.render('incident_detail', { user: req.user, ws: req.workspace, inc, events, runbooks, runbook });
});

app.post('/workspaces/:wsId/incidents/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const f = ['title','category','severity','detected_at','reported_by','status','description','affected_assets',
            'containment_actions','eradication_actions','recovery_actions','lessons_learned','external_notification'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.status === 'closed') set.push('closed_at=CURRENT_TIMESTAMP');
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE incidents SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_incident', 'incident', req.params.id, null);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/incidents/' + req.params.id);
});

app.post('/workspaces/:wsId/incidents/:id/promote-nc', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const inc = db.prepare(`SELECT * FROM incidents WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!inc) return res.redirect('back');
  if (inc.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + inc.nonconformity_id);
  const sev = inc.severity === 'critical' || inc.severity === 'high' ? 'major' : 'minor';
  const ncId = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity)
    VALUES (?, ?, 'incident', ?, ?, ?)`).run(req.workspace.id, inc.title, 'Incident #' + inc.id, inc.description, sev).lastInsertRowid;
  db.prepare(`UPDATE incidents SET nonconformity_id=? WHERE id=?`).run(ncId, inc.id);
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
});

app.post('/workspaces/:wsId/incidents/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM incidents WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/incidents');
});

// ==================== VENDORS / SUPPLIERS — TPRM ====================
const STANDARD_CLAUSES = [
  ['confidentiality', 'Confidentiality / non-disclosure'],
  ['data_handling', 'Data handling and classification'],
  ['security_obligations', 'Information security obligations (referencing standards)'],
  ['breach_notification', 'Breach notification (within 72 hours of awareness)'],
  ['subprocessor_approval', 'Sub-processor approval and notification'],
  ['audit_rights', 'Right to audit / receive assurance reports'],
  ['data_return_destruction', 'Data return / destruction at termination'],
  ['liability_indemnity', 'Liability and indemnity for security failures'],
  ['compliance', 'Compliance with applicable laws and regulations'],
  ['dpa', 'Data Processing Agreement (where personal data is processed)'],
  ['change_management', 'Change management / notice of material changes'],
  ['service_levels', 'Service levels and remedies']
];

// Inherent risk: 1-25 based on data access × business criticality, then add weights for volume / dependency / regulatory exposure
function computeInherentRisk(s) {
  const dataMap = { none: 1, public: 1, internal: 2, confidential: 4, restricted: 5 };
  const critMap = { low: 1, medium: 2, high: 3, critical: 4, '': 2 };
  const volMap = { none: 0, low: 0, medium: 1, high: 2, '': 0 };
  const depMap = { multi_source: 0, alternative: 1, single_source: 2, '': 0 };
  const dataScore = dataMap[s.data_access || 'none'] || 1;
  const critScore = critMap[s.business_criticality || 'medium'] || 2;
  const volBonus = volMap[s.data_volume || 'low'] || 0;
  const depBonus = depMap[s.dependency_type || 'multi_source'] || 0;
  const regBonus = s.regulatory_exposure ? Math.min(2, s.regulatory_exposure.split(',').filter(x => x.trim()).length) : 0;
  // Likelihood proxy = dependency + 2; Impact = data * crit / 5
  const impact = Math.min(5, dataScore + Math.floor(critScore / 2));
  const likelihood = Math.min(5, 2 + depBonus + Math.floor(volBonus / 2) + Math.floor(regBonus / 2));
  return Math.max(1, Math.min(25, impact * likelihood));
}

// Residual risk: inherent minus controls credit derived from documents + questionnaire score
function computeResidualRisk(supplierId, inherent) {
  let credit = 0;
  const docs = db.prepare(`SELECT doc_type, expiry_date FROM supplier_documents WHERE supplier_id=?`).all(supplierId);
  const today = new Date().toISOString().split('T')[0];
  const validDocs = docs.filter(d => !d.expiry_date || d.expiry_date >= today);
  const hasType = (t) => validDocs.some(d => d.doc_type === t);
  if (hasType('iso_27001') || hasType('soc2_type2')) credit += 4;
  else if (hasType('soc2_type1')) credit += 2;
  if (hasType('iso_27017') || hasType('iso_27018') || hasType('iso_27701')) credit += 2;
  if (hasType('pentest')) credit += 2;
  if (hasType('dpa')) credit += 2;
  if (hasType('insurance')) credit += 1;

  // Questionnaire credit (best score across questionnaires)
  const bestQ = db.prepare(`SELECT MAX(score) AS s FROM supplier_questionnaires WHERE supplier_id=? AND status IN ('reviewed','responded') AND score IS NOT NULL`).get(supplierId);
  if (bestQ.s !== null) {
    if (bestQ.s >= 90) credit += 5;
    else if (bestQ.s >= 75) credit += 3;
    else if (bestQ.s >= 60) credit += 2;
    else if (bestQ.s >= 40) credit += 1;
  }

  // Clauses credit
  const presentClauses = db.prepare(`SELECT COUNT(*) AS c FROM supplier_clauses WHERE supplier_id=? AND status='present'`).get(supplierId).c;
  if (presentClauses >= 8) credit += 2;
  else if (presentClauses >= 5) credit += 1;

  return Math.max(1, Math.min(25, inherent - credit));
}

function recomputeSupplierRisk(supplierId, wsId) {
  const s = db.prepare(`SELECT * FROM suppliers WHERE id=? AND workspace_id=?`).get(supplierId, wsId);
  if (!s) return;
  const inherent = computeInherentRisk(s);
  const residual = computeResidualRisk(supplierId, inherent);
  db.prepare(`UPDATE suppliers SET inherent_risk_score=?, residual_risk_score=? WHERE id=?`).run(inherent, residual, supplierId);
}

function tierFromRisk(score) {
  if (score >= 18) return 'tier_1';
  if (score >= 10) return 'tier_2';
  return 'tier_3';
}

app.get('/workspaces/:wsId/vendors', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const filter = req.query.filter || 'active';
  const ef = activeEntityFilter(req, 's');
  let q = `SELECT s.*,
    (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id=s.id) AS doc_count,
    (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id=s.id AND expiry_date IS NOT NULL AND expiry_date < date('now','+30 days') AND expiry_date >= date('now')) AS expiring_docs,
    (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id=s.id AND expiry_date IS NOT NULL AND expiry_date < date('now')) AS expired_docs,
    (SELECT COUNT(*) FROM supplier_subprocessors WHERE supplier_id=s.id) AS subproc_count,
    (SELECT COUNT(*) FROM supplier_questionnaires WHERE supplier_id=s.id) AS q_count,
    (SELECT MAX(score) FROM supplier_questionnaires WHERE supplier_id=s.id AND score IS NOT NULL) AS best_q_score
    FROM suppliers s WHERE s.workspace_id=?${ef.sql}`;
  if (filter === 'active') q += ` AND s.lifecycle_stage NOT IN ('terminated')`;
  else if (filter === 'review') q += ` AND s.next_review_date < date('now','+30 days')`;
  else if (filter === 'high_risk') q += ` AND s.residual_risk_score >= 15`;
  q += ` ORDER BY s.residual_risk_score DESC, s.name`;
  const vendors = db.prepare(q).all(req.workspace.id, ...ef.params);

  // TPRM dashboard summary
  const summary = {
    total: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated'`).get(req.workspace.id).c,
    tier1: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND residual_risk_score >= 18`).get(req.workspace.id).c,
    expiring: db.prepare(`SELECT COUNT(*) c FROM supplier_documents d INNER JOIN suppliers s ON s.id=d.supplier_id WHERE s.workspace_id=? AND d.expiry_date IS NOT NULL AND d.expiry_date < date('now','+30 days') AND d.expiry_date >= date('now')`).get(req.workspace.id).c,
    overdueReview: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND next_review_date IS NOT NULL AND next_review_date < date('now')`).get(req.workspace.id).c,
    questionnairesPending: db.prepare(`SELECT COUNT(*) c FROM supplier_questionnaires q INNER JOIN suppliers s ON s.id=q.supplier_id WHERE s.workspace_id=? AND q.status IN ('draft','sent')`).get(req.workspace.id).c
  };

  // Concentration: count tier_1/critical suppliers by industry / parent / region
  const concentration = {
    by_region: db.prepare(`SELECT location, COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND residual_risk_score >= 15 AND location IS NOT NULL GROUP BY location ORDER BY c DESC LIMIT 5`).all(req.workspace.id),
    by_parent: db.prepare(`SELECT parent_company, COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND parent_company IS NOT NULL GROUP BY parent_company HAVING c > 1 ORDER BY c DESC LIMIT 5`).all(req.workspace.id),
    single_source: db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND dependency_type='single_source'`).get(req.workspace.id).c
  };

  // Upcoming renewals (next 90 days)
  const renewals = db.prepare(`SELECT id, name, contract_end, renewal_notice_days, auto_renew FROM suppliers WHERE workspace_id=? AND contract_end IS NOT NULL AND contract_end >= date('now') AND contract_end <= date('now','+90 days') ORDER BY contract_end`).all(req.workspace.id);

  res.render('vendors', { user: req.user, ws: req.workspace, vendors, filter, summary, concentration, renewals });
});

app.post('/workspaces/:wsId/vendors', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { name, service_provided, business_criticality, data_access, data_volume, dependency_type, location, regulatory_exposure } = req.body;
  if (!name) return res.redirect('back');
  const id = db.prepare(`INSERT INTO suppliers (workspace_id, name, service_provided, business_criticality, data_access, data_volume, dependency_type, location, regulatory_exposure, lifecycle_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prospect')`).run(
    req.workspace.id, name, service_provided || null,
    business_criticality || 'medium', data_access || 'none', data_volume || 'low',
    dependency_type || 'multi_source', location || null, regulatory_exposure || null
  ).lastInsertRowid;

  // Seed standard contract clauses checklist
  const insClause = db.prepare(`INSERT INTO supplier_clauses (workspace_id, supplier_id, clause_key, clause_label, status) VALUES (?, ?, ?, ?, 'pending')`);
  STANDARD_CLAUSES.forEach(([k, label]) => insClause.run(req.workspace.id, id, k, label));

  recomputeSupplierRisk(id, req.workspace.id);
  // Auto-tier from inherent risk
  const cur = db.prepare(`SELECT inherent_risk_score FROM suppliers WHERE id=?`).get(id);
  db.prepare(`UPDATE suppliers SET tier=? WHERE id=?`).run(tierFromRisk(cur.inherent_risk_score), id);

  logAction(req.user.id, req.workspace.id, 'create_supplier', 'supplier', id, { name });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/vendors/' + id, 'Supplier added'));
});

app.get('/workspaces/:wsId/vendors/:id', requireAuth, requireWorkspace, (req, res) => {
  const v = db.prepare(`SELECT * FROM suppliers WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!v) return res.status(404).send('Not found');

  const tab = req.query.tab || 'overview';
  const docs = db.prepare(`SELECT * FROM supplier_documents WHERE supplier_id=? ORDER BY uploaded_at DESC`).all(v.id);
  const subprocessors = db.prepare(`SELECT * FROM supplier_subprocessors WHERE supplier_id=? ORDER BY name`).all(v.id);
  const reviews = db.prepare(`SELECT * FROM supplier_reviews WHERE supplier_id=? ORDER BY review_date DESC, created_at DESC`).all(v.id);
  const notesRaw = db.prepare(`SELECT * FROM supplier_notes WHERE supplier_id=? ORDER BY created_at DESC`).all(v.id);
  const notes = notesRaw.map(n => ({ ...n, body: enc.decryptIfNeeded(n.body, req.workspace.id) }));
  const clauses = db.prepare(`SELECT * FROM supplier_clauses WHERE supplier_id=? ORDER BY id`).all(v.id);
  const questionnaires = db.prepare(`SELECT q.*, t.category FROM supplier_questionnaires q LEFT JOIN questionnaire_templates t ON t.id=q.template_id WHERE q.supplier_id=? ORDER BY q.created_at DESC`).all(v.id);
  const templates = db.prepare(`SELECT id, name, description, category, (SELECT COUNT(*) FROM questionnaire_questions WHERE template_id=questionnaire_templates.id) AS q_count FROM questionnaire_templates WHERE is_system=1 OR firm_id=? ORDER BY name`).all(req.workspace.firm_id);
  const monitoring = db.prepare('SELECT * FROM supplier_monitoring WHERE supplier_id=? ORDER BY recorded_at DESC').all(v.id);
  const terminationItems = db.prepare('SELECT * FROM supplier_termination_items WHERE supplier_id=? ORDER BY id').all(v.id);

  res.render('vendor_detail', {
    user: req.user, ws: req.workspace, v, tab,
    docs, subprocessors, reviews, notes, clauses, questionnaires, templates,
    monitoring, terminationItems,
    inherent: v.inherent_risk_score, residual: v.residual_risk_score
  });
});

app.post('/workspaces/:wsId/vendors/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const f = ['name','service_provided','tier','data_access','data_volume','business_criticality','dependency_type',
            'lifecycle_stage','contract_start','contract_end','next_review_date','attestations','contact','website',
            'industry','location','parent_company','regulatory_exposure','annual_spend','renewal_notice_days',
            'auto_renew','approved_by','notes','status','last_assessed'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.lifecycle_stage === 'approved' && !req.body.approved_at) {
    set.push(`approved_at = CURRENT_TIMESTAMP`);
  }
  if (req.body.lifecycle_stage === 'terminated' && !req.body.terminated_at) {
    set.push(`terminated_at = CURRENT_TIMESTAMP`);
  }
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE suppliers SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    recomputeSupplierRisk(req.params.id, req.workspace.id);
    logAction(req.user.id, req.workspace.id, 'update_supplier', 'supplier', req.params.id, null);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id);
});

app.post('/workspaces/:wsId/vendors/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM suppliers WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors');
});

// Documents
app.post('/workspaces/:wsId/vendors/:id/documents', requireAuth, requireWorkspace, upload.single('file'), (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { doc_type, name, effective_date, expiry_date, notes } = req.body;
  if (!name) return res.redirect('back');
  let storedPath = null, sha = null, size = null, filename = null;
  if (req.file) {
    const buf = fs.readFileSync(req.file.path);
    sha = crypto.createHash('sha256').update(buf).digest('hex');
    storedPath = req.file.filename; size = req.file.size; filename = req.file.originalname;
  }
  db.prepare(`INSERT INTO supplier_documents (workspace_id, supplier_id, doc_type, name, filename, stored_path, sha256, size_bytes, effective_date, expiry_date, notes, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, doc_type || 'other', name,
    filename, storedPath, sha, size, effective_date || null, expiry_date || null, notes || null, req.user.id
  );
  recomputeSupplierRisk(req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'add_supplier_doc', 'supplier', req.params.id, { name, doc_type });
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=documents');
});

app.get('/workspaces/:wsId/vendors/:id/documents/:docId/download', requireAuth, requireWorkspace, (req, res) => {
  const d = db.prepare(`SELECT * FROM supplier_documents WHERE id=? AND supplier_id=? AND workspace_id=?`)
    .get(req.params.docId, req.params.id, req.workspace.id);
  if (!d || !d.stored_path) return res.status(404).send('Not found');
  const fp = path.join(__dirname, 'uploads', d.stored_path);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.download(fp, d.filename);
});

app.post('/workspaces/:wsId/vendors/:id/documents/:docId/delete', requireAuth, requireWorkspace, (req, res) => {
  const d = db.prepare(`SELECT * FROM supplier_documents WHERE id=? AND supplier_id=?`).get(req.params.docId, req.params.id);
  if (d) {
    if (d.stored_path) { const fp = path.join(__dirname, 'uploads', d.stored_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    db.prepare(`DELETE FROM supplier_documents WHERE id=?`).run(d.id);
    recomputeSupplierRisk(req.params.id, req.workspace.id);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=documents');
});

// Sub-processors
app.post('/workspaces/:wsId/vendors/:id/subprocessors', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { name, service_provided, data_access, location, approved } = req.body;
  if (!name) return res.redirect('back');
  db.prepare(`INSERT INTO supplier_subprocessors (workspace_id, supplier_id, name, service_provided, data_access, location, approved, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, name, service_provided || null,
    data_access || null, location || null, approved ? 1 : 0, approved ? new Date().toISOString() : null
  );
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=subprocessors');
});

app.post('/workspaces/:wsId/vendors/:id/subprocessors/:spId/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM supplier_subprocessors WHERE id=? AND supplier_id=?`).run(req.params.spId, req.params.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=subprocessors');
});

// Reviews
app.post('/workspaces/:wsId/vendors/:id/reviews', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { review_date, reviewer, outcome, findings, action_items, next_review_date } = req.body;
  const supplier = db.prepare(`SELECT inherent_risk_score, residual_risk_score FROM suppliers WHERE id=?`).get(req.params.id);
  db.prepare(`INSERT INTO supplier_reviews (workspace_id, supplier_id, review_date, reviewer, outcome, inherent_risk, residual_risk, findings, action_items, next_review_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, review_date || null, reviewer || null,
    outcome || 'approved', supplier?.inherent_risk_score || null, supplier?.residual_risk_score || null,
    findings || null, action_items || null, next_review_date || null
  );
  // Update supplier next_review_date and last_assessed
  if (next_review_date) {
    db.prepare(`UPDATE suppliers SET next_review_date=?, last_assessed=? WHERE id=?`).run(next_review_date, review_date || new Date().toISOString().split('T')[0], req.params.id);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=reviews');
});

// Notes
app.post('/workspaces/:wsId/vendors/:id/notes', requireAuth, requireWorkspace, (req, res) => {
  const { body, internal_only } = req.body;
  if (!body) return res.redirect('back');
  db.prepare(`INSERT INTO supplier_notes (workspace_id, supplier_id, user_name, body, internal_only)
    VALUES (?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, req.user.name,
    enc.encryptIfNeeded(body.trim(), req.workspace.id, !!req.workspace.encryption_enabled),
    internal_only ? 1 : 0
  );
  logAction(req.user.id, req.workspace.id, 'add_supplier_note', 'supplier', req.params.id, null, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=notes');
});

app.post('/workspaces/:wsId/vendors/:id/notes/:noteId/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM supplier_notes WHERE id=? AND supplier_id=?`).run(req.params.noteId, req.params.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=notes');
});

// Clauses
app.post('/workspaces/:wsId/vendors/:id/clauses/:clauseId', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { status, notes } = req.body;
  db.prepare(`UPDATE supplier_clauses SET status=?, notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND supplier_id=?`)
    .run(status, notes || null, req.params.clauseId, req.params.id);
  recomputeSupplierRisk(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=clauses');
});

// Questionnaires
app.post('/workspaces/:wsId/vendors/:id/questionnaires', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { template_id } = req.body;
  const tpl = db.prepare(`SELECT * FROM questionnaire_templates WHERE id=?`).get(template_id);
  if (!tpl) return res.redirect('back');
  const qCount = db.prepare(`SELECT COUNT(*) c FROM questionnaire_questions WHERE template_id=?`).get(template_id).c;
  const qid = db.prepare(`INSERT INTO supplier_questionnaires (workspace_id, supplier_id, template_id, template_name, status, sent_at, total_questions)
    VALUES (?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP, ?)`).run(
    req.workspace.id, req.params.id, template_id, tpl.name, qCount
  ).lastInsertRowid;
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '/questionnaires/' + qid);
});

app.get('/workspaces/:wsId/vendors/:id/questionnaires/:qId', requireAuth, requireWorkspace, (req, res) => {
  const q = db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    LEFT JOIN questionnaire_templates t ON t.id=q.template_id
    WHERE q.id=? AND q.workspace_id=?`).get(req.params.qId, req.workspace.id);
  if (!q) return res.status(404).send('Not found');
  const questions = db.prepare(`SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order`).all(q.template_id);
  const responses = db.prepare(`SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?`).all(q.id);
  const respMap = Object.fromEntries(responses.map(r => [r.question_id, r]));
  // Group by section
  const sections = {};
  questions.forEach(qu => { (sections[qu.section] = sections[qu.section] || []).push(qu); });
  res.render('vendor_questionnaire', { user: req.user, ws: req.workspace, q, sections, respMap });
});

app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const ws = req.workspace;
  const qid = req.params.qId;

  // Save responses for any question_X_answer fields
  const qIds = Object.keys(req.body).filter(k => k.startsWith('answer_')).map(k => parseInt(k.replace('answer_',''),10));
  const upsert = db.prepare(`INSERT INTO supplier_questionnaire_responses (questionnaire_id, question_id, answer, comment)
    VALUES (?, ?, ?, ?) ON CONFLICT(questionnaire_id, question_id) DO UPDATE SET answer=excluded.answer, comment=excluded.comment`);
  let answered = 0, score = 0, total = 0;
  for (const qid_ of qIds) {
    const ans = req.body['answer_' + qid_];
    const cmt = req.body['comment_' + qid_] || null;
    upsert.run(qid, qid_, ans || null, cmt);
    if (ans) answered++;
  }

  // Compute score
  const allQ = db.prepare(`SELECT q.id, q.weight, q.expected_answer, r.answer FROM questionnaire_questions q
    LEFT JOIN supplier_questionnaire_responses r ON r.question_id=q.id AND r.questionnaire_id=?
    WHERE q.template_id=(SELECT template_id FROM supplier_questionnaires WHERE id=?)`).all(qid, qid);
  let totalWeight = 0, achieved = 0;
  allQ.forEach(q => {
    totalWeight += q.weight;
    if (q.answer && q.expected_answer && q.answer.toLowerCase() === q.expected_answer.toLowerCase()) achieved += q.weight;
  });
  const finalScore = totalWeight > 0 ? Math.round((achieved / totalWeight) * 100) : null;
  const rating = finalScore === null ? null : (finalScore >= 80 ? 'low' : finalScore >= 60 ? 'medium' : 'high');

  const status = req.body.action === 'submit' ? 'responded' : (req.body.action === 'review' ? 'reviewed' : 'draft');
  const reviewer = req.body.reviewer || null;
  const reviewerComments = req.body.reviewer_comments || null;
  db.prepare(`UPDATE supplier_questionnaires SET answered_questions=?, score=?, risk_rating=?, status=?,
    responded_at=COALESCE(responded_at, CASE WHEN ?='responded' OR ?='reviewed' THEN CURRENT_TIMESTAMP END),
    reviewed_at=CASE WHEN ?='reviewed' THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
    reviewer=COALESCE(?, reviewer), reviewer_comments=COALESCE(?, reviewer_comments)
    WHERE id=?`).run(allQ.filter(q => q.answer).length, finalScore, rating, status, status, status, status, reviewer, reviewerComments, qid);
  recomputeSupplierRisk(req.params.id, req.workspace.id);
  logAction(req.user.id, ws.id, 'update_questionnaire', 'questionnaire', qid, { status, score: finalScore });
  res.redirect('/workspaces/' + ws.id + '/vendors/' + req.params.id + '/questionnaires/' + qid);
});

app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM supplier_questionnaires WHERE id=? AND supplier_id=?`).run(req.params.qId, req.params.id);
  recomputeSupplierRisk(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=questionnaires');
});

// ==================== TRAINING ====================
app.get('/workspaces/:wsId/training', requireAuth, requireWorkspace, (req, res) => {
  const records = db.prepare(`SELECT * FROM training_records WHERE workspace_id=? ORDER BY due_date IS NULL, due_date ASC`).all(req.workspace.id);
  const summary = db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='assigned' OR status='in_progress' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN due_date IS NOT NULL AND due_date < date('now') AND status != 'completed' THEN 1 ELSE 0 END) AS overdue
    FROM training_records WHERE workspace_id=?`).get(req.workspace.id);
  res.render('training', { user: req.user, ws: req.workspace, records, summary });
});

app.post('/workspaces/:wsId/training', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { user_name, user_role, training_name, assigned_date, due_date } = req.body;
  if (!user_name || !training_name) return res.redirect('back');
  db.prepare(`INSERT INTO training_records (workspace_id, user_name, user_role, training_name, assigned_date, due_date)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.workspace.id, user_name, user_role || null, training_name,
    assigned_date || null, due_date || null);
  logAction(req.user.id, req.workspace.id, 'create_training', 'training', null, { user_name, training_name });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/training', 'Training assigned'));
});

app.post('/workspaces/:wsId/training/:id', requireAuth, requireWorkspace, (req, res, nextMw) => {
  if (req.params.id === 'catalogue') return nextMw();
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const f = ['status','completed_date','score','notes','due_date'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.status === 'completed' && !req.body.completed_date) {
    set.push(`completed_date = date('now')`);
  }
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE training_records SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/training');
});

app.post('/workspaces/:wsId/training/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM training_records WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/training');
});

// ==================== TREND DATA ====================
app.get('/api/workspaces/:wsId/trends', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  // 30-day series for: risks created, controls implemented, NCs opened, NCs closed
  function dayCounts(query, ...params) {
    const rows = db.prepare(query).all(...params);
    const map = Object.fromEntries(rows.map(r => [r.d, r.c]));
    const series = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = d.toISOString().split('T')[0];
      series.push({ d: k, c: map[k] || 0 });
    }
    return series;
  }
  res.json({
    risks: dayCounts(`SELECT date(created_at) AS d, COUNT(*) AS c FROM risks WHERE workspace_id=? AND created_at >= date('now','-29 days') GROUP BY date(created_at)`, wsId),
    controls: dayCounts(`SELECT date(last_updated) AS d, COUNT(*) AS c FROM control_states WHERE workspace_id=? AND status='Implemented' AND last_updated >= date('now','-29 days') GROUP BY date(last_updated)`, wsId),
    ncs_open: dayCounts(`SELECT date(created_at) AS d, COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND created_at >= date('now','-29 days') GROUP BY date(created_at)`, wsId),
    ncs_closed: dayCounts(`SELECT date(closed_at) AS d, COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND closed_at >= date('now','-29 days') GROUP BY date(closed_at)`, wsId)
  });
});

// ==================== ENTITIES (multi-entity scoping) ====================
app.get('/workspaces/:wsId/entities', requireAuth, requireWorkspace, requirePermission('entity.view'), (req, res) => {
  const entities = db.prepare(`SELECT e.*,
    (SELECT COUNT(*) FROM assets WHERE entity_id=e.id) AS asset_count,
    (SELECT COUNT(*) FROM risks WHERE entity_id=e.id) AS risk_count,
    (SELECT COUNT(*) FROM suppliers WHERE entity_id=e.id) AS supplier_count,
    (SELECT COUNT(*) FROM incidents WHERE entity_id=e.id) AS incident_count
    FROM entities e WHERE e.workspace_id=? ORDER BY e.is_active DESC, e.name`).all(req.workspace.id);
  res.render('entities', { user: req.user, ws: req.workspace, entities });
});

app.post('/workspaces/:wsId/entities', requireAuth, requireWorkspace, requirePermission('entity.create'), (req, res) => {
  const { name, code, entity_type, region, scope_statement, contact, description } = req.body;
  if (!name) return res.redirect('back');
  const id = db.prepare(`INSERT INTO entities (workspace_id, name, code, entity_type, region, scope_statement, contact, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, name.trim(), code || null, entity_type || 'business_unit',
    region || null, scope_statement || null, contact || null, description || null
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_entity', 'entity', id, { name }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/entities', 'Entity added'));
});

// Switch the active entity scope (or clear it). MUST be defined before /:id
// otherwise Express matches "select" as the :id parameter.
app.post('/workspaces/:wsId/entities/select', requireAuth, requireWorkspace, requirePermission('entity.view'), (req, res) => {
  const eid = parseInt(req.body.entity_id || 0, 10);
  if (!eid) {
    delete req.session['ws_entity_' + req.workspace.id];
  } else {
    const ent = db.prepare('SELECT id FROM entities WHERE id=? AND workspace_id=?').get(eid, req.workspace.id);
    if (ent) req.session['ws_entity_' + req.workspace.id] = ent.id;
  }
  res.redirect(req.body.return_to || '/workspaces/' + req.workspace.id);
});

app.post('/workspaces/:wsId/entities/:id', requireAuth, requireWorkspace, requirePermission('entity.update'), (req, res) => {
  const before = db.prepare('SELECT * FROM entities WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!before) return res.redirect('back');
  const f = ['name','code','entity_type','region','scope_statement','contact','description','is_active'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(k === 'is_active' ? (req.body[k] ? 1 : 0) : (req.body[k] || null)); } });
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE entities SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    const after = db.prepare('SELECT * FROM entities WHERE id=?').get(req.params.id);
    const d = diffObjects(before, after);
    logAction(req.user.id, req.workspace.id, 'update_entity', 'entity', req.params.id, null, { ...auditCtx(req), before: d.before, after: d.after });
  }
  res.redirect('/workspaces/' + req.workspace.id + '/entities');
});

app.post('/workspaces/:wsId/entities/:id/delete', requireAuth, requireWorkspace, requirePermission('entity.delete'), (req, res) => {
  const ent = db.prepare('SELECT * FROM entities WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (ent) {
    db.prepare('DELETE FROM entities WHERE id=?').run(req.params.id);
    logAction(req.user.id, req.workspace.id, 'delete_entity', 'entity', req.params.id, { name: ent.name }, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/entities');
});

// ==================== RBAC: per-workspace permission overrides ====================
app.get('/workspaces/:wsId/access', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const members = db.prepare(`SELECT m.*, u.name, u.email, u.user_type, u.firm_role
    FROM workspace_members m INNER JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
  // Firm consultants who automatically have access
  const firmUsers = db.prepare(`SELECT id, name, email, firm_role FROM users
    WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name`).all(req.workspace.firm_id);
  const overrides = db.prepare(`SELECT o.*, u.name FROM workspace_role_overrides o
    INNER JOIN users u ON u.id=o.user_id WHERE o.workspace_id=? ORDER BY u.name, o.permission`).all(req.workspace.id);
  res.render('access', {
    user: req.user, ws: req.workspace, members, firmUsers, overrides,
    permissions: rbac.PERMISSIONS, roles: rbac.ROLE_LABELS, rolePerms: rbac.ROLE_PERMS,
    permsFor: (u) => Array.from(permissionsFor(u, req.workspace))
  });
});

app.post('/workspaces/:wsId/access/role', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
  const { user_id, role } = req.body;
  if (!user_id || !rbac.ROLE_PERMS[role]) return res.redirect('back');
  const before = db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.workspace.id, user_id);
  if (before) {
    db.prepare(`UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?`).run(role, req.workspace.id, user_id);
  } else {
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`).run(req.workspace.id, user_id, role);
  }
  logAction(req.user.id, req.workspace.id, 'assign_role', 'user', user_id,
    { role, previous: before?.role || null }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/access');
});

app.post('/workspaces/:wsId/access/override', requireAuth, requireWorkspace, requirePermission('members.override_perms'), (req, res) => {
  const { user_id, permission, granted, reason } = req.body;
  if (!user_id || !permission || !rbac.PERMISSIONS[permission]) return res.redirect('back');
  const g = granted === '1' || granted === 'on' ? 1 : 0;
  db.prepare(`INSERT INTO workspace_role_overrides (workspace_id, user_id, permission, granted, granted_by, reason)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id, permission) DO UPDATE SET granted=excluded.granted, granted_by=excluded.granted_by, reason=excluded.reason, created_at=CURRENT_TIMESTAMP`)
    .run(req.workspace.id, user_id, permission, g, req.user.id, reason || null);
  logAction(req.user.id, req.workspace.id, 'override_permission', 'user', user_id, { permission, granted: !!g, reason }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/access');
});

app.post('/workspaces/:wsId/access/override/:id/delete', requireAuth, requireWorkspace, requirePermission('members.override_perms'), (req, res) => {
  const o = db.prepare('SELECT * FROM workspace_role_overrides WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (o) {
    db.prepare('DELETE FROM workspace_role_overrides WHERE id=?').run(o.id);
    logAction(req.user.id, req.workspace.id, 'remove_override', 'user', o.user_id, { permission: o.permission }, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/access');
});

// ==================== RISK METHODOLOGY ====================
app.get('/workspaces/:wsId/risk-methodology', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const m = getActiveMethodology(req.workspace.id);
  const all = db.prepare('SELECT id, name, description, is_active, updated_at FROM risk_methodologies WHERE workspace_id=? ORDER BY is_active DESC, name').all(req.workspace.id);
  res.render('risk_methodology', { user: req.user, ws: req.workspace, methodology: m, all });
});

app.post('/workspaces/:wsId/risk-methodology', requireAuth, requireWorkspace, requirePermission('risk.methodology'), (req, res) => {
  const { name, description, likelihood_scale, impact_scale, matrix, thresholds } = req.body;
  // Validate JSON inputs
  let lScale, iScale, mat, thr;
  try {
    lScale = JSON.parse(likelihood_scale);
    iScale = JSON.parse(impact_scale);
    mat = JSON.parse(matrix);
    thr = JSON.parse(thresholds);
    if (!Array.isArray(lScale) || !Array.isArray(iScale) || !Array.isArray(mat)) throw new Error('Bad shape');
    if (mat.length !== lScale.length) throw new Error(`Matrix rows (${mat.length}) must match likelihood scale (${lScale.length})`);
    if (mat.some(r => !Array.isArray(r) || r.length !== iScale.length)) throw new Error(`Matrix columns must match impact scale (${iScale.length})`);
    for (const lev of mat.flat()) {
      if (!thr[lev]) throw new Error(`Matrix references undefined threshold "${lev}"`);
    }
  } catch (e) {
    return res.status(400).render('error', { user: req.user, message: 'Invalid methodology: ' + e.message });
  }

  const before = getActiveMethodology(req.workspace.id);
  // Deactivate old, insert new active version (audit-friendly versioning)
  db.prepare(`UPDATE risk_methodologies SET is_active=0 WHERE workspace_id=?`).run(req.workspace.id);
  const id = db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
    req.workspace.id, name || 'Custom', description || null,
    JSON.stringify(lScale), JSON.stringify(iScale), JSON.stringify(mat), JSON.stringify(thr)
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'update_risk_methodology', 'methodology', id,
    { name }, { ...auditCtx(req), before: { id: before.id, name: before.name }, after: { id, name } });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/risk-methodology', 'Methodology updated'));
});

app.post('/workspaces/:wsId/risk-methodology/reset', requireAuth, requireWorkspace, requirePermission('risk.methodology'), (req, res) => {
  db.prepare(`UPDATE risk_methodologies SET is_active=0 WHERE workspace_id=?`).run(req.workspace.id);
  const m = defaultMethodology();
  db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
    req.workspace.id, m.name, m.description,
    JSON.stringify(m.likelihood_scale), JSON.stringify(m.impact_scale),
    JSON.stringify(m.matrix), JSON.stringify(m.thresholds));
  logAction(req.user.id, req.workspace.id, 'reset_risk_methodology', 'methodology', null, null, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/risk-methodology');
});

// ==================== DOCUMENT VERSIONING + APPROVAL + E-SIG ====================
function snapshotDocVersion(docId, wsId, status, userId, summary) {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(docId, wsId);
  if (!doc) return null;
  const decryptedContent = enc.decryptIfNeeded(doc.content, wsId);
  const hash = enc.sha256(decryptedContent || '');
  const next = (db.prepare('SELECT MAX(version) AS v FROM doc_versions WHERE document_id=?').get(docId).v || 0) + 1;
  const id = db.prepare(`INSERT INTO doc_versions (workspace_id, document_id, version, name, content, content_hash, status, change_summary, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    wsId, docId, next, doc.name,
    enc.encryptIfNeeded(decryptedContent, wsId, true),
    hash, status || 'draft', summary || null, userId
  ).lastInsertRowid;
  db.prepare(`UPDATE generated_docs SET current_version_id=?, version=? WHERE id=?`).run(id, next, docId);
  return { id, version: next, hash, content: decryptedContent };
}

function listVersions(docId) {
  return db.prepare(`SELECT v.*, u.name AS author
    FROM doc_versions v LEFT JOIN users u ON u.id=v.created_by
    WHERE v.document_id=? ORDER BY v.version DESC`).all(docId);
}

function listApprovers(docId, versionId) {
  return db.prepare(`SELECT a.*, u.name AS user_name, u.email AS user_email
    FROM doc_approvers a INNER JOIN users u ON u.id=a.user_id
    WHERE a.document_id=? AND a.version_id=? ORDER BY a.sequence`).all(docId, versionId);
}

function listSignatures(docId, versionId) {
  return db.prepare(`SELECT s.* FROM doc_signatures s WHERE s.document_id=? AND s.version_id=? ORDER BY s.signed_at`).all(docId, versionId);
}

// Verify the integrity of every signature on a version. Returns a list of issues.
function verifyVersionSignatures(version, sigs, wsId) {
  const issues = [];
  for (const s of sigs) {
    if (s.content_hash !== version.content_hash) {
      issues.push(`Signature ${s.id} (${s.user_name}): content hash mismatch — version may have been altered after signing.`);
      continue;
    }
    const payload = `${s.document_id}|${s.version_id}|${s.user_id}|${s.content_hash}|${s.intent}|${s.signed_at}`;
    if (!enc.verifyHmac(payload, wsId, s.signature)) {
      issues.push(`Signature ${s.id} (${s.user_name}): HMAC verification failed — signature is not authentic.`);
    }
  }
  return issues;
}

// List version-specific document detail view (shows version chain, approvers, sigs)
app.get('/workspaces/:wsId/documents/:id/versions', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.status(404).send('Not found');
  const versions = listVersions(doc.id);
  const versionsWithDetail = versions.map(v => ({
    ...v,
    approvers: listApprovers(doc.id, v.id),
    signatures: listSignatures(doc.id, v.id),
    signatureIssues: verifyVersionSignatures(v, listSignatures(doc.id, v.id), req.workspace.id)
  }));
  res.render('document_versions', { user: req.user, ws: req.workspace, doc, versions: versionsWithDetail });
});

// Compare two versions side-by-side (line-level diff).
app.get('/workspaces/:wsId/documents/:id/diff', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.status(404).send('Not found');
  const a = parseInt(req.query.a || 0, 10);
  const b = parseInt(req.query.b || 0, 10);
  const va = a ? db.prepare('SELECT * FROM doc_versions WHERE id=? AND document_id=?').get(a, doc.id) : null;
  const vb = b ? db.prepare('SELECT * FROM doc_versions WHERE id=? AND document_id=?').get(b, doc.id) : null;
  const all = listVersions(doc.id);
  const diff = (va && vb) ? simpleLineDiff(
    enc.decryptIfNeeded(va.content, req.workspace.id),
    enc.decryptIfNeeded(vb.content, req.workspace.id)
  ) : null;
  res.render('document_diff', { user: req.user, ws: req.workspace, doc, va, vb, diff, all });
});

function simpleLineDiff(a, b) {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  // Longest-common-subsequence-driven line diff (small files, O(NM) is fine).
  const N = A.length, M = B.length;
  const dp = Array.from({ length: N + 1 }, () => new Int32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (A[i] === B[j]) { out.push({ k: 'eq', a: A[i], b: B[j] }); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { out.push({ k: 'del', a: A[i] }); i++; }
    else { out.push({ k: 'add', b: B[j] }); j++; }
  }
  while (i < N) { out.push({ k: 'del', a: A[i++] }); }
  while (j < M) { out.push({ k: 'add', b: B[j++] }); }
  return out;
}

// Submit current draft for review — snapshots a new version, sets approver chain.
app.post('/workspaces/:wsId/documents/:id/submit-review', requireAuth, requireWorkspace, requirePermission('document.submit_review'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.redirect('back');
  if (doc.locked) return res.status(400).render('error', { user: req.user, message: 'Document is locked. Create a new version first.' });
  const approverIds = (req.body.approver_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  const summary = req.body.change_summary || null;
  if (approverIds.length === 0) {
    return res.status(400).render('error', { user: req.user, message: 'Add at least one approver before submitting for review.' });
  }
  const v = snapshotDocVersion(doc.id, req.workspace.id, 'in_review', req.user.id, summary);
  db.prepare(`UPDATE generated_docs SET status='in_review', locked=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
  db.prepare(`UPDATE doc_versions SET submitted_at=CURRENT_TIMESTAMP WHERE id=?`).run(v.id);
  const insApp = db.prepare(`INSERT INTO doc_approvers (workspace_id, document_id, version_id, sequence, user_id, role_label, notified_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  approverIds.forEach((uid, idx) => {
    insApp.run(req.workspace.id, doc.id, v.id, idx + 1, uid, req.body['role_' + uid] || null);
  });
  logAction(req.user.id, req.workspace.id, 'submit_for_review', 'document', doc.id,
    { version: v.version, approvers: approverIds.length, summary }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, 'Submitted for review'));
});

// Approver makes a decision (approve / reject) on the current version.
app.post('/workspaces/:wsId/documents/:id/decide', requireAuth, requireWorkspace, requirePermission('document.review'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc || !doc.current_version_id) return res.redirect('back');
  const { decision, reason } = req.body;
  if (!['approve','reject'].includes(decision)) return res.redirect('back');

  // Find this user's pending slot for the current version (must respect sequence).
  const pending = db.prepare(`SELECT a.*, (SELECT MIN(sequence) FROM doc_approvers WHERE version_id=? AND decision IS NULL) AS next_seq
    FROM doc_approvers a WHERE a.version_id=? AND a.user_id=? AND a.decision IS NULL ORDER BY a.sequence LIMIT 1`)
    .get(doc.current_version_id, doc.current_version_id, req.user.id);
  if (!pending) return res.status(403).render('error', { user: req.user, message: 'You are not a pending approver on this version.' });
  if (pending.sequence !== pending.next_seq) {
    return res.status(400).render('error', { user: req.user, message: `Approver #${pending.next_seq} must decide first.` });
  }

  db.prepare(`UPDATE doc_approvers SET decision=?, decision_reason=?, decided_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(decision === 'approve' ? 'approved' : 'rejected', reason || null, pending.id);

  if (decision === 'reject') {
    db.prepare(`UPDATE generated_docs SET status='draft', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
    db.prepare(`UPDATE doc_versions SET status='rejected' WHERE id=?`).run(doc.current_version_id);
    logAction(req.user.id, req.workspace.id, 'reject_document', 'document', doc.id,
      { version_id: doc.current_version_id, reason }, auditCtx(req));
    return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, 'Document rejected', 'error'));
  }

  // All approved?
  const remaining = db.prepare(`SELECT COUNT(*) c FROM doc_approvers WHERE version_id=? AND decision IS NULL`).get(doc.current_version_id).c;
  if (remaining === 0) {
    db.prepare(`UPDATE generated_docs SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, locked=1 WHERE id=?`).run(req.user.id, doc.id);
    db.prepare(`UPDATE doc_versions SET status='approved', approved_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
    logAction(req.user.id, req.workspace.id, 'approve_document', 'document', doc.id, { version_id: doc.current_version_id }, auditCtx(req));
  } else {
    logAction(req.user.id, req.workspace.id, 'partial_approve_document', 'document', doc.id,
      { version_id: doc.current_version_id, remaining }, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// E-signature endpoint. Captures user's identity, hashes content, generates HMAC, stores ip/UA.
app.post('/workspaces/:wsId/documents/:id/sign', requireAuth, requireWorkspace, requirePermission('document.sign'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc || !doc.current_version_id) return res.redirect('back');
  const { intent, signature_role, attestation } = req.body;
  if (!intent || !attestation) return res.status(400).render('error', { user: req.user, message: 'Sign-off requires an intent and explicit attestation.' });
  const v = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(doc.current_version_id);
  if (!v) return res.redirect('back');
  const ts = new Date().toISOString();
  const payload = `${doc.id}|${v.id}|${req.user.id}|${v.content_hash}|${intent}|${ts}`;
  const sig = enc.signHmac(payload, req.workspace.id);
  db.prepare(`INSERT INTO doc_signatures (workspace_id, document_id, version_id, user_id, user_name, signature_role, intent, content_hash, signature, ip_address, user_agent, signed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, doc.id, v.id, req.user.id, req.user.name,
    signature_role || null, intent, v.content_hash, sig,
    auditCtx(req).ip, auditCtx(req).userAgent, ts
  );
  logAction(req.user.id, req.workspace.id, 'sign_document', 'document', doc.id,
    { version: v.version, intent, signature_role }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id + '/versions', 'Signature recorded'));
});

// Publish an approved document.
app.post('/workspaces/:wsId/documents/:id/publish', requireAuth, requireWorkspace, requirePermission('document.publish'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.redirect('back');
  if (doc.status !== 'approved') return res.status(400).render('error', { user: req.user, message: 'Only approved documents can be published.' });
  db.prepare(`UPDATE generated_docs SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
  if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
  logAction(req.user.id, req.workspace.id, 'publish_document', 'document', doc.id, { version_id: doc.current_version_id }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// Retire a published document.
app.post('/workspaces/:wsId/documents/:id/retire', requireAuth, requireWorkspace, requirePermission('document.retire'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.redirect('back');
  db.prepare(`UPDATE generated_docs SET status='retired', retired_at=CURRENT_TIMESTAMP, locked=1 WHERE id=?`).run(doc.id);
  if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='retired', retired_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
  logAction(req.user.id, req.workspace.id, 'retire_document', 'document', doc.id, { reason: req.body.reason || null }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// Reopen for editing — creates a new draft version branched off current.
app.post('/workspaces/:wsId/documents/:id/new-version', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.redirect('back');
  db.prepare(`UPDATE generated_docs SET status='draft', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
  logAction(req.user.id, req.workspace.id, 'new_version', 'document', doc.id,
    { previous_version_id: doc.current_version_id }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// ==================== ENHANCED ACTIVITY LOG ====================
// Filter activity by user/action/entity_type/date range; show before/after diffs; export CSV.
app.get('/workspaces/:wsId/activity-log', requireAuth, requireWorkspace, requirePermission('audit_log.view'), (req, res) => {
  const filters = {
    user_id: req.query.user_id || '',
    action: req.query.action || '',
    entity_type: req.query.entity_type || '',
    from: req.query.from || '',
    to: req.query.to || '',
    q: req.query.q || ''
  };
  const where = ['a.workspace_id=?']; const params = [req.workspace.id];
  if (filters.user_id) { where.push('a.user_id=?'); params.push(filters.user_id); }
  if (filters.action) { where.push('a.action=?'); params.push(filters.action); }
  if (filters.entity_type) { where.push('a.entity_type=?'); params.push(filters.entity_type); }
  if (filters.from) { where.push('a.created_at >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('a.created_at <= ?'); params.push(filters.to + ' 23:59:59'); }
  if (filters.q) { where.push('(a.action LIKE ? OR a.entity_id LIKE ? OR a.details LIKE ?)'); const lk = '%'+filters.q+'%'; params.push(lk, lk, lk); }
  const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
    INNER JOIN users u ON u.id=a.user_id
    WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 500`).all(...params);
  const users = db.prepare(`SELECT DISTINCT u.id, u.name FROM audit_log a
    INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
  const actions = db.prepare(`SELECT DISTINCT action FROM audit_log WHERE workspace_id=? ORDER BY action`).all(req.workspace.id).map(r => r.action);
  const types = db.prepare(`SELECT DISTINCT entity_type FROM audit_log WHERE workspace_id=? AND entity_type IS NOT NULL ORDER BY entity_type`).all(req.workspace.id).map(r => r.entity_type);
  res.render('activity_log', { user: req.user, ws: req.workspace, log, filters, users, actions, types });
});

// ==================== NOTIFICATIONS ====================
app.get('/workspaces/:wsId/notifications', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'unread';
  let q = `SELECT * FROM notifications WHERE workspace_id=? AND (user_id IS NULL OR user_id=?)`;
  if (filter === 'unread') q += ` AND read_at IS NULL AND dismissed_at IS NULL`;
  else if (filter === 'all') q += ` AND dismissed_at IS NULL`;
  q += ` ORDER BY created_at DESC LIMIT 200`;
  const list = db.prepare(q).all(req.workspace.id, req.user.id);
  res.render('notifications', { user: req.user, ws: req.workspace, notifications: list, filter });
});

app.post('/workspaces/:wsId/notifications/:id/read', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect('back');
});
app.post('/workspaces/:wsId/notifications/:id/dismiss', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`UPDATE notifications SET dismissed_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect('back');
});
app.post('/workspaces/:wsId/notifications/mark-all-read', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND read_at IS NULL`).run(req.workspace.id);
  res.redirect('back');
});

// Manual job-run trigger (for admins / debugging)
app.post('/admin/jobs/run', requireAuth, (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
  const out = jobs.runAllJobs();
  res.json(out);
});

app.get('/workspaces/:wsId/activity-log.csv', requireAuth, requireWorkspace, requirePermission('audit_log.export'), (req, res) => {
  const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
    INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.created_at DESC`).all(req.workspace.id);
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
  const lines = ['When,User,Action,Entity Type,Entity ID,Details,Before,After,IP,User Agent,Request ID'];
  log.forEach(l => lines.push([l.created_at, l.user_name, l.action, l.entity_type, l.entity_id, l.details, l.before_state, l.after_state, l.ip_address, l.user_agent, l.request_id].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="activity-log-${req.workspace.client_name.replace(/[^\w]/g,'_')}.csv"`);
  logAction(req.user.id, req.workspace.id, 'export_activity_log', 'workspace', req.workspace.id, null, auditCtx(req));
  res.send(lines.join('\n'));
});

// ==================== RISK TREATMENT PLANS ====================
app.get('/workspaces/:wsId/risks/:id/treatments', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const risk = db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Not found');
  const treatments = db.prepare('SELECT * FROM risk_treatments WHERE risk_id=? ORDER BY due_date IS NULL, due_date').all(risk.id);
  const allControls = db.prepare(`SELECT id, title FROM iso_items WHERE type='control' ORDER BY sort_order`).all();
  res.render('risk_treatments', { user: req.user, ws: req.workspace, risk, treatments, allControls });
});

app.post('/workspaces/:wsId/risks/:id/treatments', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const { title, description, owner_name, due_date, status, cost_estimate, expected_residual_l, expected_residual_i, iso_item_id } = req.body;
  if (!title) return res.redirect('back');
  const id = db.prepare(`INSERT INTO risk_treatments (workspace_id, risk_id, title, description, owner_name, due_date, status, cost_estimate, expected_residual_l, expected_residual_i, iso_item_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, title, description || null, owner_name || null,
    due_date || null, status || 'planned', cost_estimate || null,
    expected_residual_l ? parseInt(expected_residual_l) : null,
    expected_residual_i ? parseInt(expected_residual_i) : null,
    iso_item_id || null
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_treatment', 'treatment', id, { risk_id: req.params.id, title }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/treatments`);
});

app.post('/workspaces/:wsId/risks/:id/treatments/:tId', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const f = ['title','description','owner_name','due_date','completed_date','status','cost_estimate','expected_residual_l','expected_residual_i','iso_item_id'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.status === 'done' && !req.body.completed_date) { set.push(`completed_date=date('now')`); }
  if (set.length) {
    vals.push(req.params.tId, req.params.id);
    db.prepare(`UPDATE risk_treatments SET ${set.join(',')} WHERE id=? AND risk_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_treatment', 'treatment', req.params.tId, null, auditCtx(req));
  }
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/treatments`);
});

app.post('/workspaces/:wsId/risks/:id/treatments/:tId/delete', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  db.prepare('DELETE FROM risk_treatments WHERE id=? AND risk_id=?').run(req.params.tId, req.params.id);
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/treatments`);
});

// ==================== KEY RISK INDICATORS (KRIs) ====================
app.get('/workspaces/:wsId/kris', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const kris = db.prepare(`SELECT k.*,
    (SELECT value FROM kri_readings WHERE kri_id=k.id ORDER BY measured_at DESC LIMIT 1) AS latest,
    (SELECT measured_at FROM kri_readings WHERE kri_id=k.id ORDER BY measured_at DESC LIMIT 1) AS latest_at,
    (SELECT COUNT(*) FROM kri_readings WHERE kri_id=k.id) AS reading_count,
    r.title AS risk_title
    FROM kris k LEFT JOIN risks r ON r.id=k.risk_id
    WHERE k.workspace_id=? AND k.is_active=1 ORDER BY k.name`).all(req.workspace.id);
  const risks = db.prepare('SELECT id, title FROM risks WHERE workspace_id=? AND status=\'open\'').all(req.workspace.id);
  res.render('kris', { user: req.user, ws: req.workspace, kris, risks });
});

app.post('/workspaces/:wsId/kris', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const { name, description, unit, green_max, amber_max, red_above_amber, measurement_frequency, owner_name, risk_id } = req.body;
  if (!name) return res.redirect('back');
  const id = db.prepare(`INSERT INTO kris (workspace_id, risk_id, name, description, unit, green_max, amber_max, red_above_amber, measurement_frequency, owner_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, risk_id || null, name, description || null, unit || null,
    green_max ? parseFloat(green_max) : null,
    amber_max ? parseFloat(amber_max) : null,
    red_above_amber === 'on' ? 1 : 0,
    measurement_frequency || 'monthly', owner_name || null
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_kri', 'kri', id, { name }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/kris/${id}`);
});

app.get('/workspaces/:wsId/kris/:id', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const kri = db.prepare('SELECT * FROM kris WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!kri) return res.status(404).send('Not found');
  const readings = db.prepare('SELECT * FROM kri_readings WHERE kri_id=? ORDER BY measured_at DESC').all(kri.id);
  res.render('kri_detail', { user: req.user, ws: req.workspace, kri, readings });
});

app.post('/workspaces/:wsId/kris/:id/readings', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const { value, measured_at, notes } = req.body;
  if (value === undefined) return res.redirect('back');
  db.prepare(`INSERT INTO kri_readings (kri_id, value, measured_at, notes, recorded_by) VALUES (?, ?, ?, ?, ?)`).run(
    req.params.id, parseFloat(value), measured_at || new Date().toISOString().slice(0,10), notes || null, req.user.id);
  res.redirect(`/workspaces/${req.workspace.id}/kris/${req.params.id}`);
});

app.post('/workspaces/:wsId/kris/:id/delete', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  db.prepare('DELETE FROM kris WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/kris`);
});

// ==================== METHODOLOGY LIBRARY (PRESETS) ====================
const METHODOLOGY_PRESETS = require('./data/methodology-presets');

app.post('/workspaces/:wsId/risk-methodology/preset/:key', requireAuth, requireWorkspace, requirePermission('risk.methodology'), (req, res) => {
  const preset = METHODOLOGY_PRESETS[req.params.key];
  if (!preset) return res.redirect('back');
  db.prepare(`UPDATE risk_methodologies SET is_active=0 WHERE workspace_id=?`).run(req.workspace.id);
  db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
    req.workspace.id, preset.name, preset.description,
    JSON.stringify(preset.likelihood_scale), JSON.stringify(preset.impact_scale),
    JSON.stringify(preset.matrix), JSON.stringify(preset.thresholds));
  logAction(req.user.id, req.workspace.id, 'apply_methodology_preset', 'methodology', null, { preset: req.params.key }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/risk-methodology`);
});

// ==================== SOA SNAPSHOTS + PER-ENTITY ====================
function captureSoASnapshot(wsId, userId, entityId, label, reason) {
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
    COALESCE(cs.applicability,'undecided') AS applicability,
    COALESCE(cs.status,'Not Assessed') AS status,
    cs.inclusion_justification, cs.exclusion_justification
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' ORDER BY i.sort_order`).all(wsId);
  const payload = JSON.stringify(rows);
  const hash = enc.sha256(payload);
  const inc = rows.filter(r => r.applicability === 'included').length;
  const exc = rows.filter(r => r.applicability === 'excluded').length;
  const id = db.prepare(`INSERT INTO soa_snapshots (workspace_id, entity_id, label, reason, payload, payload_hash, control_count, included_count, excluded_count, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    wsId, entityId || null, label || null, reason || null,
    enc.encryptIfNeeded(payload, wsId, true), hash, rows.length, inc, exc, userId
  ).lastInsertRowid;
  return { id, hash, control_count: rows.length, included_count: inc, excluded_count: exc };
}

app.post('/workspaces/:wsId/soa/snapshot', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const snap = captureSoASnapshot(req.workspace.id, req.user.id, null, req.body.label, req.body.reason);
  logAction(req.user.id, req.workspace.id, 'snapshot_soa', 'soa', snap.id, snap, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/soa/snapshots`, 'Snapshot captured'));
});

app.get('/workspaces/:wsId/soa/snapshots', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const list = db.prepare(`SELECT s.*, u.name AS author, e.name AS entity_name FROM soa_snapshots s
    LEFT JOIN users u ON u.id=s.created_by LEFT JOIN entities e ON e.id=s.entity_id
    WHERE s.workspace_id=? ORDER BY s.created_at DESC`).all(req.workspace.id);
  res.render('soa_snapshots', { user: req.user, ws: req.workspace, snapshots: list });
});

app.get('/workspaces/:wsId/soa/snapshots/:id', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const s = db.prepare('SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!s) return res.status(404).send('Not found');
  const rows = JSON.parse(enc.decryptIfNeeded(s.payload, req.workspace.id));
  res.render('soa_snapshot_detail', { user: req.user, ws: req.workspace, snapshot: s, rows });
});

app.get('/workspaces/:wsId/soa/snapshots/diff', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const a = parseInt(req.query.a || 0, 10);
  const b = parseInt(req.query.b || 0, 10);
  const sa = a ? db.prepare('SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?').get(a, req.workspace.id) : null;
  const sb = b ? db.prepare('SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?').get(b, req.workspace.id) : null;
  let diff = null;
  if (sa && sb) {
    const ra = JSON.parse(enc.decryptIfNeeded(sa.payload, req.workspace.id));
    const rb = JSON.parse(enc.decryptIfNeeded(sb.payload, req.workspace.id));
    const map = (rows) => Object.fromEntries(rows.map(r => [r.id, r]));
    const ma = map(ra), mb = map(rb);
    const ids = new Set([...Object.keys(ma), ...Object.keys(mb)]);
    diff = [];
    for (const id of ids) {
      const x = ma[id], y = mb[id];
      const changes = [];
      if (!x) changes.push(`+ added`);
      else if (!y) changes.push(`− removed`);
      else {
        if (x.applicability !== y.applicability) changes.push(`applicability: ${x.applicability} → ${y.applicability}`);
        if (x.status !== y.status) changes.push(`status: ${x.status} → ${y.status}`);
        if ((x.inclusion_justification || '') !== (y.inclusion_justification || '')) changes.push(`inclusion justification changed`);
        if ((x.exclusion_justification || '') !== (y.exclusion_justification || '')) changes.push(`exclusion justification changed`);
      }
      if (changes.length) diff.push({ id, title: (y || x).title, changes });
    }
  }
  const all = db.prepare('SELECT id, label, created_at FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC').all(req.workspace.id);
  res.render('soa_snapshot_diff', { user: req.user, ws: req.workspace, sa, sb, diff, all });
});

// One-click SoA: every control linked to a risk → included with auto-justification.
app.post('/workspaces/:wsId/soa/auto-justify', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
  const linked = db.prepare(`SELECT i.id, i.title, COUNT(rc.id) AS rc, GROUP_CONCAT(DISTINCT r.title) AS risks
    FROM iso_items i
    INNER JOIN risk_controls rc ON rc.iso_item_id=i.id
    INNER JOIN risks r ON r.id=rc.risk_id
    WHERE i.type='control' AND r.workspace_id=?
    GROUP BY i.id`).all(req.workspace.id);
  let updated = 0;
  for (const c of linked) {
    getOrCreateState(req.workspace.id, c.id);
    const just = `Driven by risks: ${c.risks}`;
    db.prepare(`UPDATE control_states SET applicability='included', inclusion_justification=COALESCE(inclusion_justification, ?), last_updated=CURRENT_TIMESTAMP
      WHERE workspace_id=? AND iso_item_id=? AND applicability != 'excluded'`)
      .run(just, req.workspace.id, c.id);
    updated++;
  }
  logAction(req.user.id, req.workspace.id, 'soa_auto_justify', 'soa', null, { updated }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/soa`, `Auto-justified ${updated} controls`));
});

// ==================== PER-ENTITY SOA OVERRIDES ====================
app.get('/workspaces/:wsId/entities/:eId/soa', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const entity = db.prepare('SELECT * FROM entities WHERE id=? AND workspace_id=?').get(req.params.eId, req.workspace.id);
  if (!entity) return res.status(404).send('Not found');
  // Workspace-level state + entity overrides
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
      COALESCE(cs.applicability,'undecided') AS ws_applicability,
      COALESCE(cs.status,'Not Assessed') AS ws_status,
      cs.inclusion_justification AS ws_inc, cs.exclusion_justification AS ws_exc,
      ecs.applicability AS e_applicability, ecs.status AS e_status,
      ecs.inclusion_justification AS e_inc, ecs.exclusion_justification AS e_exc, ecs.notes AS e_notes
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      LEFT JOIN entity_control_states ecs ON ecs.iso_item_id=i.id AND ecs.entity_id=?
      WHERE i.type='control' ORDER BY i.sort_order`).all(req.workspace.id, entity.id);
  res.render('entity_soa', { user: req.user, ws: req.workspace, entity, rows });
});

app.post('/workspaces/:wsId/entities/:eId/soa/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { applicability, status, inclusion_justification, exclusion_justification, notes, clear } = req.body;
  if (clear === '1') {
    db.prepare('DELETE FROM entity_control_states WHERE entity_id=? AND iso_item_id=?').run(req.params.eId, req.params.isoId);
  } else {
    db.prepare(`INSERT INTO entity_control_states (workspace_id, entity_id, iso_item_id, applicability, status, inclusion_justification, exclusion_justification, notes, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(entity_id, iso_item_id) DO UPDATE SET applicability=excluded.applicability, status=excluded.status, inclusion_justification=excluded.inclusion_justification, exclusion_justification=excluded.exclusion_justification, notes=excluded.notes, last_updated=CURRENT_TIMESTAMP`)
      .run(req.workspace.id, req.params.eId, req.params.isoId,
           applicability || null, status || null,
           inclusion_justification || null, exclusion_justification || null, notes || null);
  }
  logAction(req.user.id, req.workspace.id, 'update_entity_soa', 'control', req.params.isoId, { entity_id: req.params.eId }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/entities/${req.params.eId}/soa`);
});

// ==================== DOCUMENT ACK CAMPAIGNS ====================
app.get('/workspaces/:wsId/campaigns', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const campaigns = db.prepare(`SELECT c.*, d.name AS doc_name,
    (SELECT COUNT(*) FROM doc_ack_recipients WHERE campaign_id=c.id) AS total,
    (SELECT COUNT(*) FROM doc_ack_recipients WHERE campaign_id=c.id AND acknowledged_at IS NOT NULL) AS done
    FROM doc_ack_campaigns c INNER JOIN generated_docs d ON d.id=c.document_id
    WHERE c.workspace_id=? ORDER BY c.created_at DESC`).all(req.workspace.id);
  res.render('campaigns', { user: req.user, ws: req.workspace, campaigns });
});

app.post('/workspaces/:wsId/documents/:id/campaign', requireAuth, requireWorkspace, requirePermission('document.publish'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc || !doc.current_version_id) return res.status(400).render('error', { user: req.user, message: 'Need an approved/published document with a current version to launch a campaign.' });
  const { name, description, due_date, recipients } = req.body;
  if (!name || !recipients) return res.redirect('back');

  const cId = db.prepare(`INSERT INTO doc_ack_campaigns (workspace_id, document_id, version_id, name, description, due_date, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(
    req.workspace.id, doc.id, doc.current_version_id, name, description || null, due_date || null, req.user.id
  ).lastInsertRowid;

  const lines = recipients.split('\n').map(l => l.trim()).filter(Boolean);
  const ins = db.prepare(`INSERT INTO doc_ack_recipients (campaign_id, recipient_name, recipient_email, recipient_role, token) VALUES (?, ?, ?, ?, ?)`);
  for (const ln of lines) {
    const parts = ln.split(',').map(s => s.trim());
    const token = crypto.randomBytes(16).toString('hex');
    ins.run(cId, parts[0], parts[1] || null, parts[2] || null, token);
  }
  logAction(req.user.id, req.workspace.id, 'create_campaign', 'campaign', cId, { name, recipients: lines.length }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/campaigns/${cId}`);
});

app.get('/workspaces/:wsId/campaigns/:id', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const c = db.prepare(`SELECT c.*, d.name AS doc_name FROM doc_ack_campaigns c
    INNER JOIN generated_docs d ON d.id=c.document_id WHERE c.id=? AND c.workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!c) return res.status(404).send('Not found');
  const recipients = db.prepare('SELECT * FROM doc_ack_recipients WHERE campaign_id=? ORDER BY recipient_name').all(c.id);
  res.render('campaign_detail', { user: req.user, ws: req.workspace, c, recipients });
});

// External (no-auth) ack page accessed via token
app.get('/ack/:token', (req, res) => {
  const r = db.prepare(`SELECT r.*, c.name AS campaign_name, c.description AS campaign_desc, c.due_date, c.workspace_id, d.name AS doc_name, d.id AS doc_id, d.content, v.content_hash, v.version
    FROM doc_ack_recipients r
    INNER JOIN doc_ack_campaigns c ON c.id=r.campaign_id
    INNER JOIN generated_docs d ON d.id=c.document_id
    INNER JOIN doc_versions v ON v.id=c.version_id
    WHERE r.token=?`).get(req.params.token);
  if (!r) return res.status(404).send('Link not valid.');
  const content = enc.decryptIfNeeded(r.content, r.workspace_id);
  res.render('ack_external', { r, content });
});

app.post('/ack/:token', (req, res) => {
  const r = db.prepare(`SELECT r.*, c.workspace_id, c.document_id, c.version_id, v.content_hash
    FROM doc_ack_recipients r
    INNER JOIN doc_ack_campaigns c ON c.id=r.campaign_id
    INNER JOIN doc_versions v ON v.id=c.version_id WHERE r.token=?`).get(req.params.token);
  if (!r) return res.status(404).send('Link not valid.');
  if (r.acknowledged_at) return res.send('Already acknowledged.');
  if (req.body.attestation !== '1') return res.redirect('back');
  const ts = new Date().toISOString();
  const ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '').toString().split(',')[0].trim();
  const ua = (req.headers['user-agent'] || '').slice(0, 255);
  const payload = `ack|${r.document_id}|${r.version_id}|${r.recipient_name}|${r.content_hash}|${ts}`;
  const sig = enc.signHmac(payload, r.workspace_id);
  // Use the external-signer sentinel user (auto-created below) so the FK is satisfied.
  let extUser = db.prepare(`SELECT id FROM users WHERE email='external@isms.local'`).get();
  if (!extUser) {
    const uid = db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active) VALUES ('external@isms.local','!external','External signer','client',0)`).run().lastInsertRowid;
    extUser = { id: uid };
  }
  const sigId = db.prepare(`INSERT INTO doc_signatures (workspace_id, document_id, version_id, user_id, user_name, signature_role, intent, content_hash, signature, ip_address, user_agent, signed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'acknowledge', ?, ?, ?, ?, ?)`).run(
    r.workspace_id, r.document_id, r.version_id, extUser.id, r.recipient_name,
    r.recipient_role || null, r.content_hash, sig, ip, ua, ts).lastInsertRowid;
  db.prepare(`UPDATE doc_ack_recipients SET acknowledged_at=?, signature_id=?, ip_address=?, user_agent=? WHERE id=?`)
    .run(ts, sigId, ip, ua, r.id);
  logAction(0, r.workspace_id, 'external_ack', 'document', r.document_id, { recipient: r.recipient_name }, { ip, userAgent: ua });
  res.send(`Acknowledged. Thank you, ${r.recipient_name}. You can close this tab.`);
});

// ==================== DOCUMENT HIERARCHY ====================
app.get('/workspaces/:wsId/documents/tree', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const docs = db.prepare(`SELECT id, name, category, status, parent_doc_id, doc_kind, reference_code, version
    FROM generated_docs WHERE workspace_id=? ORDER BY parent_doc_id IS NOT NULL, name`).all(req.workspace.id);
  res.render('documents_tree', { user: req.user, ws: req.workspace, docs });
});

app.post('/workspaces/:wsId/documents/:id/parent', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const pid = req.body.parent_doc_id ? parseInt(req.body.parent_doc_id, 10) : null;
  // Prevent self-loop
  if (pid && pid == req.params.id) return res.redirect('back');
  db.prepare('UPDATE generated_docs SET parent_doc_id=?, doc_kind=?, reference_code=? WHERE id=? AND workspace_id=?')
    .run(pid, req.body.doc_kind || null, req.body.reference_code || null, req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'reparent_document', 'document', req.params.id, { parent_doc_id: pid }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/documents/${req.params.id}`);
});

// ==================== AUDIT PROGRAMME + SAMPLING ====================
app.get('/workspaces/:wsId/audit-programme', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const year = parseInt(req.query.year || new Date().getFullYear(), 10);
  let programme = db.prepare('SELECT * FROM audit_programmes WHERE workspace_id=? AND year=?').get(req.workspace.id, year);
  if (!programme) {
    db.prepare('INSERT INTO audit_programmes (workspace_id, year) VALUES (?, ?)').run(req.workspace.id, year);
    programme = db.prepare('SELECT * FROM audit_programmes WHERE workspace_id=? AND year=?').get(req.workspace.id, year);
  }
  const audits = db.prepare(`SELECT * FROM audits WHERE workspace_id=? AND audit_date BETWEEN ? AND ? ORDER BY audit_date`)
    .all(req.workspace.id, `${year}-01-01`, `${year}-12-31`);
  res.render('audit_programme', { user: req.user, ws: req.workspace, programme, audits, year });
});

app.post('/workspaces/:wsId/audit-programme/:id', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const { description, approved_by } = req.body;
  const sets = [];
  const vals = [];
  if (description !== undefined) { sets.push('description=?'); vals.push(description || null); }
  if (approved_by) { sets.push('approved_by=?', 'approved_at=CURRENT_TIMESTAMP'); vals.push(approved_by); }
  if (sets.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE audit_programmes SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
  }
  logAction(req.user.id, req.workspace.id, 'update_programme', 'programme', req.params.id, null, auditCtx(req));
  res.redirect('back');
});

// Sampling helper API: given population N, return suggested sample size at 95% confidence / 5% margin.
app.get('/api/sample-size', (req, res) => {
  const N = Math.max(0, parseInt(req.query.population || 0, 10));
  // Cochran's formula at z=1.96, p=0.5, e=0.05 → n0 = 384.16
  const n0 = 384.16;
  if (N === 0) return res.json({ recommended: 0, note: 'Provide a population size.' });
  const adjusted = Math.ceil(n0 / (1 + (n0 - 1) / N));
  // Random seed indices (1-based) for the sample
  const idxs = [];
  const seen = new Set();
  while (idxs.length < Math.min(adjusted, N)) {
    const r = 1 + Math.floor(Math.random() * N);
    if (!seen.has(r)) { seen.add(r); idxs.push(r); }
  }
  idxs.sort((a, b) => a - b);
  res.json({ population: N, recommended: Math.min(adjusted, N), method: '95% CI / 5% margin (Cochran)', sample_indices: idxs });
});

// ==================== INCIDENT TIMELINE + RUNBOOK ====================
app.post('/workspaces/:wsId/incidents/:id/events', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const { phase, event_at, description, actor } = req.body;
  if (!phase || !description) return res.redirect('back');
  db.prepare(`INSERT INTO incident_events (workspace_id, incident_id, phase, event_at, description, actor)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, phase,
    event_at || new Date().toISOString(), description, actor || req.user.name);
  // Update phase timestamps on incident
  const phaseColumnMap = { detect: null, contain: 'contained_at', eradicate: 'eradicated_at', recover: 'recovered_at' };
  if (phaseColumnMap[phase]) {
    db.prepare(`UPDATE incidents SET ${phaseColumnMap[phase]}=COALESCE(${phaseColumnMap[phase]}, ?) WHERE id=? AND workspace_id=?`)
      .run(event_at || new Date().toISOString(), req.params.id, req.workspace.id);
  }
  logAction(req.user.id, req.workspace.id, 'add_incident_event', 'incident', req.params.id, { phase }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/incidents/${req.params.id}`);
});

app.post('/workspaces/:wsId/incidents/:id/runbook', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const rid = req.body.runbook_id ? parseInt(req.body.runbook_id, 10) : null;
  db.prepare('UPDATE incidents SET runbook_id=? WHERE id=? AND workspace_id=?').run(rid, req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'attach_runbook', 'incident', req.params.id, { runbook_id: rid }, auditCtx(req));
  res.redirect('back');
});

app.post('/workspaces/:wsId/incidents/:id/regulator-clock', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const { detected_at, regulator, hours } = req.body;
  if (!detected_at || !hours) return res.redirect('back');
  const due = new Date(new Date(detected_at).getTime() + parseFloat(hours) * 3600 * 1000).toISOString();
  db.prepare('UPDATE incidents SET notification_required_by=? WHERE id=? AND workspace_id=?').run(due, req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'set_regulator_clock', 'incident', req.params.id, { regulator, due }, auditCtx(req));
  res.redirect('back');
});

app.post('/workspaces/:wsId/incidents/:id/notify-sent', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  db.prepare('UPDATE incidents SET notification_sent_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect('back');
});

app.post('/workspaces/:wsId/incidents/:id/pir', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  db.prepare('UPDATE incidents SET pir_completed=1, pir_summary=? WHERE id=? AND workspace_id=?').run(req.body.pir_summary || null, req.params.id, req.workspace.id);
  res.redirect('back');
});

// ==================== SUPPLIER MONITORING + TERMINATION + CONCENTRATION ====================
app.post('/workspaces/:wsId/vendors/:id/monitoring', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const { source, score, grade, recorded_at, notes } = req.body;
  if (!source) return res.redirect('back');
  db.prepare(`INSERT INTO supplier_monitoring (workspace_id, supplier_id, source, score, grade, recorded_at, notes, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, source,
    score ? parseFloat(score) : null, grade || null,
    recorded_at || new Date().toISOString().slice(0,10),
    notes || null, req.user.id);
  res.redirect(`/workspaces/${req.workspace.id}/vendors/${req.params.id}?tab=monitoring`);
});

app.post('/workspaces/:wsId/vendors/:id/termination/start', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const items = [
    ['access_revoked', 'Logical access revoked'],
    ['vpn_keys_revoked', 'VPN / API keys revoked'],
    ['data_returned', 'Data returned'],
    ['data_destroyed', 'Data securely destroyed'],
    ['certificate_received', 'Certificate of destruction received'],
    ['final_audit', 'Final audit / attestation collected'],
    ['contract_closed', 'Contract formally closed'],
    ['communications_done', 'Internal stakeholders notified']
  ];
  const ins = db.prepare(`INSERT OR IGNORE INTO supplier_termination_items (workspace_id, supplier_id, item_key, label) VALUES (?, ?, ?, ?)`);
  items.forEach(([k, l]) => ins.run(req.workspace.id, req.params.id, k, l));
  db.prepare(`UPDATE suppliers SET termination_started_at=CURRENT_TIMESTAMP, termination_owner=?, lifecycle_stage='terminating' WHERE id=? AND workspace_id=?`)
    .run(req.body.termination_owner || req.user.name, req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'start_termination', 'supplier', req.params.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/vendors/${req.params.id}?tab=termination`);
});

app.post('/workspaces/:wsId/vendors/:id/termination/:itemId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const done = req.body.done === '1' ? 1 : 0;
  db.prepare(`UPDATE supplier_termination_items SET done=?, done_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END, evidence=?, notes=? WHERE id=? AND supplier_id=?`)
    .run(done, done, req.body.evidence || null, req.body.notes || null, req.params.itemId, req.params.id);
  // If all items done, mark terminated
  const remaining = db.prepare('SELECT COUNT(*) c FROM supplier_termination_items WHERE supplier_id=? AND done=0').get(req.params.id).c;
  if (remaining === 0) {
    db.prepare(`UPDATE suppliers SET lifecycle_stage='terminated', terminated_at=CURRENT_TIMESTAMP, data_return_completed=1 WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  }
  res.redirect(`/workspaces/${req.workspace.id}/vendors/${req.params.id}?tab=termination`);
});

// External tokenized questionnaire link — external supplier completes without an account.
app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/share', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  db.prepare(`UPDATE supplier_questionnaires SET external_token=?, external_email=? WHERE id=? AND workspace_id=?`)
    .run(token, req.body.email || null, req.params.qId, req.workspace.id);
  const link = `${req.protocol}://${req.get('host')}/q/${token}`;
  res.redirect(withToast(`/workspaces/${req.workspace.id}/vendors/${req.params.id}/questionnaires/${req.params.qId}`, `External link: ${link}`));
});

app.get('/q/:token', (req, res) => {
  const q = db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    LEFT JOIN questionnaire_templates t ON t.id=q.template_id
    WHERE q.external_token=?`).get(req.params.token);
  if (!q) return res.status(404).send('Link not valid.');
  if (q.external_completed_at) return res.send('This questionnaire has already been submitted. Thank you.');
  const questions = db.prepare('SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order').all(q.template_id);
  const responses = db.prepare('SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?').all(q.id);
  const respMap = Object.fromEntries(responses.map(r => [r.question_id, r]));
  const sections = {};
  questions.forEach(qu => { (sections[qu.section] = sections[qu.section] || []).push(qu); });
  res.render('external_questionnaire', { q, sections, respMap, token: req.params.token });
});

app.post('/q/:token', (req, res) => {
  const q = db.prepare('SELECT * FROM supplier_questionnaires WHERE external_token=?').get(req.params.token);
  if (!q || q.external_completed_at) return res.status(404).send('Link not valid.');
  const qIds = Object.keys(req.body).filter(k => k.startsWith('answer_')).map(k => parseInt(k.replace('answer_',''), 10));
  const upsert = db.prepare(`INSERT INTO supplier_questionnaire_responses (questionnaire_id, question_id, answer, comment)
    VALUES (?, ?, ?, ?) ON CONFLICT(questionnaire_id, question_id) DO UPDATE SET answer=excluded.answer, comment=excluded.comment`);
  for (const qid of qIds) {
    upsert.run(q.id, qid, req.body['answer_' + qid] || null, req.body['comment_' + qid] || null);
  }
  // Score
  const allQ = db.prepare(`SELECT q.id, q.weight, q.expected_answer, r.answer FROM questionnaire_questions q
    LEFT JOIN supplier_questionnaire_responses r ON r.question_id=q.id AND r.questionnaire_id=?
    WHERE q.template_id=?`).all(q.id, q.template_id);
  let totalWeight = 0, achieved = 0;
  allQ.forEach(qu => {
    totalWeight += qu.weight;
    if (qu.answer && qu.expected_answer && qu.answer.toLowerCase() === qu.expected_answer.toLowerCase()) achieved += qu.weight;
  });
  const score = totalWeight ? Math.round((achieved / totalWeight) * 100) : null;
  const rating = score === null ? null : (score >= 80 ? 'low' : score >= 60 ? 'medium' : 'high');
  db.prepare(`UPDATE supplier_questionnaires SET answered_questions=?, score=?, risk_rating=?, status='responded', responded_at=CURRENT_TIMESTAMP, external_completed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(allQ.filter(qu => qu.answer).length, score, rating, q.id);
  logAction(0, q.workspace_id, 'external_questionnaire_submit', 'questionnaire', q.id, { score, rating }, { ip: (req.ip || ''), userAgent: req.get('user-agent') || '' });
  res.send('Thank you. Your responses have been submitted.');
});

// ==================== TRAINING CATALOGUE + AUTO-ASSIGN ====================
app.get('/workspaces/:wsId/training/catalogue', requireAuth, requireWorkspace, requirePermission('training.manage'), (req, res) => {
  const courses = db.prepare(`SELECT c.*,
    (SELECT COUNT(*) FROM training_records WHERE course_id=c.id) AS assigned_count,
    (SELECT COUNT(*) FROM training_records WHERE course_id=c.id AND status='completed') AS completed_count
    FROM training_courses c WHERE c.workspace_id=? ORDER BY c.is_active DESC, c.name`).all(req.workspace.id);
  res.render('training_catalogue', { user: req.user, ws: req.workspace, courses });
});

app.post('/workspaces/:wsId/training/catalogue', requireAuth, requireWorkspace, requirePermission('training.manage'), (req, res) => {
  const { name, description, duration_minutes, validity_months, required_for_roles, content_url, has_quiz, passing_score, iso_control_ref } = req.body;
  if (!name) return res.redirect('back');
  db.prepare(`INSERT INTO training_courses (workspace_id, name, description, duration_minutes, validity_months, required_for_roles, content_url, has_quiz, passing_score, iso_control_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, name, description || null,
    duration_minutes ? parseInt(duration_minutes) : null,
    validity_months ? parseInt(validity_months) : 12,
    required_for_roles || null, content_url || null,
    has_quiz === 'on' ? 1 : 0,
    passing_score ? parseInt(passing_score) : null,
    iso_control_ref || null);
  res.redirect(`/workspaces/${req.workspace.id}/training/catalogue`);
});

app.post('/workspaces/:wsId/training/catalogue/:cId/assign', requireAuth, requireWorkspace, requirePermission('training.manage'), (req, res) => {
  const c = db.prepare('SELECT * FROM training_courses WHERE id=? AND workspace_id=?').get(req.params.cId, req.workspace.id);
  if (!c) return res.redirect('back');
  const lines = (req.body.recipients || '').split('\n').map(l => l.trim()).filter(Boolean);
  const ins = db.prepare(`INSERT INTO training_records (workspace_id, course_id, user_name, user_role, training_name, assigned_date, due_date, expiry_date, status)
    VALUES (?, ?, ?, ?, ?, date('now'), ?, ?, 'assigned')`);
  const due = req.body.due_date || new Date(Date.now() + 14 * 86400000).toISOString().slice(0,10);
  const expiry = c.validity_months ? new Date(Date.now() + c.validity_months * 30 * 86400000).toISOString().slice(0,10) : null;
  for (const ln of lines) {
    const parts = ln.split(',').map(s => s.trim());
    ins.run(req.workspace.id, c.id, parts[0], parts[1] || null, c.name, due, expiry);
  }
  logAction(req.user.id, req.workspace.id, 'assign_training', 'course', c.id, { recipients: lines.length }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/training`);
});

app.get('/workspaces/:wsId/training/matrix', requireAuth, requireWorkspace, requirePermission('training.manage'), (req, res) => {
  const courses = db.prepare('SELECT id, name FROM training_courses WHERE workspace_id=? AND is_active=1 ORDER BY name').all(req.workspace.id);
  const users = db.prepare(`SELECT DISTINCT user_name, user_role FROM training_records WHERE workspace_id=? ORDER BY user_name`).all(req.workspace.id);
  const records = db.prepare(`SELECT user_name, course_id, status, completed_date, expiry_date FROM training_records WHERE workspace_id=? AND course_id IS NOT NULL`).all(req.workspace.id);
  res.render('training_matrix', { user: req.user, ws: req.workspace, courses, users, records });
});

// Phishing simulation tracker
app.get('/workspaces/:wsId/phishing', requireAuth, requireWorkspace, requirePermission('training.manage'), (req, res) => {
  const sims = db.prepare('SELECT * FROM phishing_simulations WHERE workspace_id=? ORDER BY campaign_date DESC, created_at DESC').all(req.workspace.id);
  res.render('phishing', { user: req.user, ws: req.workspace, sims });
});

app.post('/workspaces/:wsId/phishing', requireAuth, requireWorkspace, requirePermission('training.manage'), (req, res) => {
  const { name, campaign_date, recipients_count, clicked_count, reported_count, credentials_entered_count, notes } = req.body;
  if (!name) return res.redirect('back');
  db.prepare(`INSERT INTO phishing_simulations (workspace_id, name, campaign_date, recipients_count, clicked_count, reported_count, credentials_entered_count, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, name, campaign_date || null,
    recipients_count ? parseInt(recipients_count) : null,
    clicked_count ? parseInt(clicked_count) : null,
    reported_count ? parseInt(reported_count) : null,
    credentials_entered_count ? parseInt(credentials_entered_count) : null,
    notes || null);
  res.redirect(`/workspaces/${req.workspace.id}/phishing`);
});

// ==================== TASKS: TEMPLATES + TIME TRACKING ====================
app.get('/workspaces/:wsId/task-templates', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const templates = db.prepare(`SELECT * FROM task_templates WHERE workspace_id=? OR is_system=1 OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
  res.render('task_templates', { user: req.user, ws: req.workspace, templates });
});

app.post('/workspaces/:wsId/tasks/from-template/:tplId', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM task_templates WHERE id=?').get(req.params.tplId);
  if (!tpl) return res.redirect('back');
  const steps = JSON.parse(tpl.steps || '[]');
  const baseDate = req.body.base_date ? new Date(req.body.base_date) : new Date();
  for (const s of steps) {
    const due = new Date(baseDate.getTime() + (s.days_offset || 0) * 86400000).toISOString().slice(0,10);
    db.prepare(`INSERT INTO tasks (workspace_id, entity_id, title, description, assignee_id, due_date, status, created_by, template_id)
      VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?)`).run(
      req.workspace.id, req.entityScopeId || null,
      s.title, tpl.name + ' — step',
      req.body.assignee_id || null, due, req.user.id, tpl.id);
  }
  logAction(req.user.id, req.workspace.id, 'spawn_template', 'task_template', tpl.id, { name: tpl.name, steps: steps.length }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/tasks`, `Created ${steps.length} tasks from "${tpl.name}"`));
});

app.post('/workspaces/:wsId/tasks/:id/time', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const { date, minutes, description, billable } = req.body;
  if (!minutes) return res.redirect('back');
  db.prepare(`INSERT INTO time_entries (workspace_id, user_id, task_id, date, minutes, description, billable)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.user.id, req.params.id,
    date || new Date().toISOString().slice(0,10),
    parseInt(minutes), description || null,
    billable === '0' ? 0 : 1);
  res.redirect('back');
});

app.get('/workspaces/:wsId/time', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const entries = db.prepare(`SELECT te.*, t.title AS task_title, u.name AS user_name FROM time_entries te
    LEFT JOIN tasks t ON t.id=te.task_id
    LEFT JOIN users u ON u.id=te.user_id
    WHERE te.workspace_id=? ORDER BY te.date DESC, te.id DESC LIMIT 200`).all(req.workspace.id);
  const totals = db.prepare(`SELECT SUM(minutes) AS m, SUM(CASE WHEN billable=1 THEN minutes ELSE 0 END) AS bm FROM time_entries WHERE workspace_id=?`).get(req.workspace.id);
  res.render('time_tracking', { user: req.user, ws: req.workspace, entries, totals });
});

// ==================== ASSET RELATIONSHIPS + BULK IMPORT ====================
app.post('/workspaces/:wsId/assets/:id/relationships', requireAuth, requireWorkspace, requirePermission('asset.update'), (req, res) => {
  const { child_asset_id, relation, notes } = req.body;
  if (!child_asset_id || !relation) return res.redirect('back');
  try {
    db.prepare(`INSERT INTO asset_relationships (workspace_id, parent_asset_id, child_asset_id, relation, notes)
      VALUES (?, ?, ?, ?, ?)`).run(req.workspace.id, req.params.id, child_asset_id, relation, notes || null);
  } catch (_) {}
  res.redirect(`/workspaces/${req.workspace.id}/assets/${req.params.id}`);
});

app.post('/workspaces/:wsId/assets/relationships/:id/delete', requireAuth, requireWorkspace, requirePermission('asset.update'), (req, res) => {
  db.prepare('DELETE FROM asset_relationships WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect('back');
});

app.get('/workspaces/:wsId/assets/:id', requireAuth, requireWorkspace, requirePermission('asset.view'), (req, res) => {
  const asset = db.prepare(`SELECT a.*, e.name AS entity_name FROM assets a LEFT JOIN entities e ON e.id=a.entity_id WHERE a.id=? AND a.workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!asset) return res.status(404).send('Not found');
  const parents = db.prepare(`SELECT r.*, p.name AS asset_name FROM asset_relationships r INNER JOIN assets p ON p.id=r.parent_asset_id WHERE r.child_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
  const children = db.prepare(`SELECT r.*, c.name AS asset_name FROM asset_relationships r INNER JOIN assets c ON c.id=r.child_asset_id WHERE r.parent_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
  const allAssets = db.prepare('SELECT id, name FROM assets WHERE workspace_id=? AND id != ? ORDER BY name').all(req.workspace.id, asset.id);
  const linkedRisks = db.prepare(`SELECT r.* FROM risks r WHERE r.workspace_id=? AND r.asset_id=?`).all(req.workspace.id, asset.id);
  res.render('asset_detail', { user: req.user, ws: req.workspace, asset, parents, children, allAssets, linkedRisks });
});

app.post('/workspaces/:wsId/assets/import', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
  const csv = req.body.csv || '';
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return res.redirect('back');
  const header = lines.shift().split(',').map(s => s.trim().toLowerCase());
  const ix = (k) => header.indexOf(k);
  const ins = db.prepare(`INSERT INTO assets (workspace_id, entity_id, name, type, classification, owner_name, cia_c, cia_i, cia_a, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let count = 0;
  for (const ln of lines) {
    const parts = ln.split(',').map(s => s.trim());
    if (!parts[ix('name')]) continue;
    ins.run(req.workspace.id, req.entityScopeId || null,
      parts[ix('name')],
      ix('type') >= 0 ? parts[ix('type')] : null,
      ix('classification') >= 0 ? parts[ix('classification')] : null,
      ix('owner') >= 0 ? parts[ix('owner')] : (ix('owner_name') >= 0 ? parts[ix('owner_name')] : null),
      parseInt(ix('c') >= 0 ? parts[ix('c')] : '1') || 1,
      parseInt(ix('i') >= 0 ? parts[ix('i')] : '1') || 1,
      parseInt(ix('a') >= 0 ? parts[ix('a')] : '1') || 1,
      ix('description') >= 0 ? parts[ix('description')] : null);
    count++;
  }
  logAction(req.user.id, req.workspace.id, 'import_assets', 'asset', null, { count }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/assets`, `Imported ${count} assets`));
});

// ==================== ENTITY READINESS + INHERITANCE ====================
app.get('/workspaces/:wsId/entities/:id/readiness', requireAuth, requireWorkspace, requirePermission('entity.view'), (req, res) => {
  const entity = db.prepare('SELECT * FROM entities WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!entity) return res.status(404).send('Not found');
  // Effective state per control: entity override → workspace state → undecided/Not Assessed
  const rows = db.prepare(`SELECT i.id, i.title, i.type, i.category,
      COALESCE(ecs.applicability, cs.applicability, 'undecided') AS applicability,
      COALESCE(ecs.status, cs.status, 'Not Assessed') AS status
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      LEFT JOIN entity_control_states ecs ON ecs.iso_item_id=i.id AND ecs.entity_id=?`).all(req.workspace.id, entity.id);
  const total = rows.length;
  const impl = rows.filter(r => r.status === 'Implemented').length;
  const partial = rows.filter(r => r.status === 'Partially Implemented').length;
  const na = rows.filter(r => r.status === 'Not Applicable').length;
  const score = total ? Math.round(((impl + na) / total) * 100) : 0;
  const ent_assets = db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id=? AND entity_id=?').get(req.workspace.id, entity.id).c;
  const ent_risks = db.prepare('SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND entity_id=?').get(req.workspace.id, entity.id).c;
  const ent_suppliers = db.prepare('SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND entity_id=?').get(req.workspace.id, entity.id).c;
  res.render('entity_readiness', { user: req.user, ws: req.workspace, entity, rows, total, impl, partial, na, score, ent_assets, ent_risks, ent_suppliers });
});

// ==================== MEMBERS: BULK INVITE + STATS ====================
app.post('/workspaces/:wsId/members/bulk', requireAuth, requireWorkspace, requirePermission('members.add'), (req, res) => {
  const lines = (req.body.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let added = 0;
  for (const ln of lines) {
    const parts = ln.split(',').map(s => s.trim());
    const [name, email, role] = parts;
    if (!name || !email) continue;
    const e = email.toLowerCase();
    const r = ['client_admin','contributor','reviewer','auditor','read_only'].includes(role) ? role : 'contributor';
    let user = db.prepare('SELECT * FROM users WHERE email=?').get(e);
    if (!user) {
      const hash = bcrypt.hashSync('temporary-' + crypto.randomBytes(8).toString('hex'), 10);
      const uid = db.prepare(`INSERT INTO users (email, password_hash, name, user_type) VALUES (?, ?, ?, 'client')`).run(e, hash, name).lastInsertRowid;
      user = { id: uid };
    }
    try {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(req.workspace.id, user.id, r);
      added++;
    } catch (_) { /* already a member */ }
  }
  logAction(req.user.id, req.workspace.id, 'bulk_invite', 'members', null, { added }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/members`, `Added ${added} members`));
});

app.get('/workspaces/:wsId/members/:userId/stats', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const u = db.prepare('SELECT id, name, email, last_active_at FROM users WHERE id=?').get(req.params.userId);
  if (!u) return res.status(404).send('Not found');
  const stats = {
    controls_owned: db.prepare(`SELECT COUNT(*) c FROM control_states WHERE workspace_id=? AND owner_id=?`).get(req.workspace.id, u.id).c,
    docs_created: db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND created_by=?`).get(req.workspace.id, u.id).c,
    evidence_uploaded: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND uploaded_by=?`).get(req.workspace.id, u.id).c,
    tasks_owned: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND assignee_id=?`).get(req.workspace.id, u.id).c,
    actions_logged: db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id).c,
    signatures: db.prepare(`SELECT COUNT(*) c FROM doc_signatures WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id).c,
    minutes_tracked: db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM time_entries WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id).m
  };
  res.render('member_stats', { user: req.user, ws: req.workspace, member: u, stats });
});

// ==================== ACCESS REVIEWS ====================
app.get('/workspaces/:wsId/access-reviews', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const reviews = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM access_review_items WHERE review_id=r.id) AS total,
    (SELECT COUNT(*) FROM access_review_items WHERE review_id=r.id AND decision IS NOT NULL) AS decided
    FROM access_reviews r WHERE r.workspace_id=? ORDER BY r.created_at DESC`).all(req.workspace.id);
  res.render('access_reviews', { user: req.user, ws: req.workspace, reviews });
});

app.post('/workspaces/:wsId/access-reviews', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const start = req.body.period_start || new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
  const reviewId = db.prepare(`INSERT INTO access_reviews (workspace_id, period_start, period_end, status, reviewer)
    VALUES (?, ?, ?, 'open', ?)`).run(req.workspace.id, start, today, req.body.reviewer || req.user.name).lastInsertRowid;
  // Snapshot current member list
  const members = db.prepare(`SELECT m.user_id, m.role, u.name FROM workspace_members m INNER JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?`).all(req.workspace.id);
  const ins = db.prepare('INSERT INTO access_review_items (review_id, user_id, current_role) VALUES (?, ?, ?)');
  members.forEach(m => ins.run(reviewId, m.user_id, m.role));
  logAction(req.user.id, req.workspace.id, 'open_access_review', 'access_review', reviewId, { members: members.length }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${reviewId}`);
});

app.get('/workspaces/:wsId/access-reviews/:id', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const review = db.prepare('SELECT * FROM access_reviews WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!review) return res.status(404).send('Not found');
  const items = db.prepare(`SELECT i.*, u.name, u.email FROM access_review_items i INNER JOIN users u ON u.id=i.user_id WHERE i.review_id=? ORDER BY u.name`).all(review.id);
  res.render('access_review_detail', { user: req.user, ws: req.workspace, review, items });
});

app.post('/workspaces/:wsId/access-reviews/:id/items/:itemId', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
  db.prepare(`UPDATE access_review_items SET decision=?, decision_reason=?, reviewer=?, decided_at=CURRENT_TIMESTAMP WHERE id=? AND review_id=?`)
    .run(req.body.decision || null, req.body.decision_reason || null, req.user.name, req.params.itemId, req.params.id);
  // If decision is "remove", actually drop the workspace_member row
  if (req.body.decision === 'remove') {
    const item = db.prepare('SELECT user_id FROM access_review_items WHERE id=?').get(req.params.itemId);
    if (item) {
      db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(req.workspace.id, item.user_id);
      logAction(req.user.id, req.workspace.id, 'access_review_remove', 'user', item.user_id, null, auditCtx(req));
    }
  }
  res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${req.params.id}`);
});

app.post('/workspaces/:wsId/access-reviews/:id/close', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
  db.prepare(`UPDATE access_reviews SET status='closed', closed_at=CURRENT_TIMESTAMP, outcome=? WHERE id=? AND workspace_id=?`)
    .run(req.body.outcome || null, req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'close_access_review', 'access_review', req.params.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/access-reviews/${req.params.id}`);
});

// ==================== PERMISSION REVERSE LOOKUP + TEMPLATES ====================
app.get('/workspaces/:wsId/access/who-has/:perm', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const perm = req.params.perm;
  // For each user with workspace access, compute effective perms.
  const users = db.prepare(`SELECT u.id, u.name, u.email, u.user_type, u.firm_role, COALESCE(m.role, '-') AS member_role
    FROM users u LEFT JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=?
    WHERE u.firm_id=? AND u.user_type='firm' AND u.active=1
    UNION
    SELECT u.id, u.name, u.email, u.user_type, NULL, m.role
    FROM users u INNER JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=?`).all(req.workspace.id, req.workspace.firm_id, req.workspace.id);
  const has = users.map(u => ({ ...u, has: rbac.hasPermission(permissionsFor(u, req.workspace), perm) }));
  res.render('permission_lookup', { user: req.user, ws: req.workspace, perm, results: has, allPerms: rbac.PERMISSIONS });
});

app.post('/workspaces/:wsId/access/apply-template', requireAuth, requireWorkspace, requirePermission('members.override_perms'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM permission_templates WHERE id=? AND (firm_id IS NULL OR firm_id=?)').get(req.body.template_id, req.workspace.firm_id);
  if (!tpl) return res.redirect('back');
  const userId = parseInt(req.body.user_id, 10);
  if (!userId) return res.redirect('back');
  const expires = req.body.expires_at || null;
  const perms = JSON.parse(tpl.permissions);
  const ins = db.prepare(`INSERT INTO workspace_role_overrides (workspace_id, user_id, permission, granted, granted_by, reason, expires_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id, permission) DO UPDATE SET granted=1, granted_by=excluded.granted_by, reason=excluded.reason, expires_at=excluded.expires_at`);
  perms.forEach(p => ins.run(req.workspace.id, userId, p, req.user.id, `Template: ${tpl.name}` + (req.body.reason ? ' — ' + req.body.reason : ''), expires));
  logAction(req.user.id, req.workspace.id, 'apply_perm_template', 'user', userId, { template: tpl.name, expires_at: expires }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/access`);
});

// ==================== AUDIT LOG: HASH CHAIN VERIFY + SESSION TIMELINE + ANOMALY ====================
app.get('/workspaces/:wsId/activity-log/verify', requireAuth, requireWorkspace, requirePermission('audit_log.view'), (req, res) => {
  const issues = verifyAuditChain(req.workspace.id);
  res.render('audit_chain_verify', { user: req.user, ws: req.workspace, issues, total: db.prepare('SELECT COUNT(*) c FROM audit_log WHERE workspace_id=?').get(req.workspace.id).c });
});

app.get('/workspaces/:wsId/activity-log/timeline', requireAuth, requireWorkspace, requirePermission('audit_log.view'), (req, res) => {
  const userId = parseInt(req.query.user_id || req.user.id, 10);
  const day = req.query.day || new Date().toISOString().slice(0,10);
  const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
    WHERE a.workspace_id=? AND a.user_id=? AND date(a.created_at)=date(?) ORDER BY a.created_at`)
    .all(req.workspace.id, userId, day);
  const users = db.prepare(`SELECT DISTINCT u.id, u.name FROM audit_log a INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
  res.render('audit_timeline', { user: req.user, ws: req.workspace, log, users, userId, day });
});

app.get('/workspaces/:wsId/activity-log/anomalies', requireAuth, requireWorkspace, requirePermission('audit_log.view'), (req, res) => {
  const flags = [];
  // After-hours actions (00:00–06:00 UTC)
  const after = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
    WHERE a.workspace_id=? AND CAST(strftime('%H', a.created_at) AS INTEGER) < 6 ORDER BY a.created_at DESC LIMIT 50`).all(req.workspace.id);
  if (after.length) flags.push({ kind: 'after_hours', label: `${after.length} after-hours actions (00:00–06:00 UTC)`, items: after });
  // Burst: same user does >20 actions in one minute
  const burst = db.prepare(`SELECT user_id, strftime('%Y-%m-%d %H:%M', created_at) AS m, COUNT(*) c
    FROM audit_log WHERE workspace_id=? GROUP BY user_id, m HAVING c > 20 ORDER BY c DESC LIMIT 10`).all(req.workspace.id);
  if (burst.length) flags.push({ kind: 'burst', label: `Bursts of >20 actions per minute`, items: burst });
  // IP changes mid-session: same user, >2 distinct IPs in one day
  const ipChange = db.prepare(`SELECT user_id, date(created_at) d, COUNT(DISTINCT ip_address) ips
    FROM audit_log WHERE workspace_id=? AND ip_address IS NOT NULL GROUP BY user_id, d HAVING ips > 2`).all(req.workspace.id);
  if (ipChange.length) flags.push({ kind: 'ip_change', label: `Same user from >2 IPs in a single day`, items: ipChange });
  // Permission denials: every denial is suspicious
  const denials = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a INNER JOIN users u ON u.id=a.user_id
    WHERE a.workspace_id=? AND a.action='permission_denied' ORDER BY a.created_at DESC LIMIT 50`).all(req.workspace.id);
  if (denials.length) flags.push({ kind: 'denials', label: `${denials.length} permission denials`, items: denials });
  res.render('audit_anomalies', { user: req.user, ws: req.workspace, flags });
});

// ==================== OVERVIEW WIDGETS API ====================
app.get('/api/workspaces/:wsId/burndown', requireAuth, requireWorkspace, (req, res) => {
  // Open NCs over time (90 days), and unimplemented controls trend
  const wsId = req.workspace.id;
  const days = 90;
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0,10);
    const openNcs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND created_at <= ? AND (closed_at IS NULL OR closed_at > ?)`).get(wsId, k + ' 23:59:59', k + ' 23:59:59').c;
    series.push({ d: k, open_ncs: openNcs });
  }
  res.json({ series });
});

// ==================== READINESS DRILL-DOWN ====================
app.get('/workspaces/:wsId/readiness/auditor', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  // Auditor checklist view: per-clause / per-Annex A, what evidence exists, what's missing
  const items = db.prepare(`SELECT i.id, i.title, i.type, i.category, i.evidence_needed, i.documentation_needed,
    cs.status, cs.applicability, cs.last_updated, cs.notes,
    (SELECT COUNT(*) FROM evidence e WHERE e.workspace_id=? AND e.iso_item_id=i.id) AS evidence_count,
    (SELECT COUNT(*) FROM risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?) AS risk_links
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id, req.workspace.id);
  res.render('readiness_auditor', { user: req.user, ws: req.workspace, items });
});

// ==================== CONTROLS: BULK EXPORT/IMPORT + TEMPLATES + KANBAN ====================
app.get('/workspaces/:wsId/controls/export.csv', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const rows = db.prepare(`SELECT i.id, i.type, i.category, i.title,
    COALESCE(cs.status,'Not Assessed') AS status,
    COALESCE(cs.applicability,'undecided') AS applicability,
    cs.maturity, cs.notes, cs.due_date,
    (SELECT name FROM users WHERE id=cs.owner_id) AS owner
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    ORDER BY i.sort_order`).all(req.workspace.id);
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
  const lines = ['id,type,category,title,status,applicability,maturity,notes,due_date,owner'];
  rows.forEach(r => lines.push([r.id, r.type, r.category, r.title, r.status, r.applicability, r.maturity || '', r.notes || '', r.due_date || '', r.owner || ''].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="controls-${req.workspace.client_name.replace(/[^\w]+/g,'_')}.csv"`);
  res.send(lines.join('\n'));
});

app.post('/workspaces/:wsId/controls/import', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
  const csv = req.body.csv || '';
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return res.redirect('back');
  const header = lines.shift().split(',').map(s => s.trim().toLowerCase());
  const ix = (k) => header.indexOf(k);
  let updated = 0;
  for (const ln of lines) {
    // Naive CSV — values may be quoted; handle simple unquote
    const parts = ln.match(/"[^"]*"|[^,]+/g)?.map(p => p.replace(/^"|"$/g,'').replace(/""/g,'"').trim()) || [];
    const id = ix('id') >= 0 ? parts[ix('id')] : null;
    if (!id) continue;
    getOrCreateState(req.workspace.id, id);
    const set = []; const vals = [];
    if (ix('status') >= 0 && parts[ix('status')]) { set.push('status=?'); vals.push(parts[ix('status')]); }
    if (ix('applicability') >= 0 && parts[ix('applicability')]) { set.push('applicability=?'); vals.push(parts[ix('applicability')]); }
    if (ix('maturity') >= 0 && parts[ix('maturity')]) { set.push('maturity=?'); vals.push(parseInt(parts[ix('maturity')]) || 0); }
    if (ix('notes') >= 0 && parts[ix('notes')]) { set.push('notes=?'); vals.push(parts[ix('notes')]); }
    if (set.length) {
      set.push('last_updated=CURRENT_TIMESTAMP');
      vals.push(req.workspace.id, id);
      db.prepare(`UPDATE control_states SET ${set.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
      updated++;
    }
  }
  logAction(req.user.id, req.workspace.id, 'import_controls', 'control', null, { updated }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/controls`, `Updated ${updated} controls`));
});

app.get('/workspaces/:wsId/controls/kanban', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const rows = db.prepare(`SELECT i.id, i.title, i.type, i.category,
    COALESCE(cs.status,'Not Assessed') AS status, cs.maturity,
    (SELECT name FROM users WHERE id=cs.owner_id) AS owner
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' ORDER BY i.sort_order`).all(req.workspace.id);
  res.render('controls_kanban', { user: req.user, ws: req.workspace, rows });
});

// ==================== PUBLIC API (token-authenticated, local) ====================
const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '10mb' }));

apiRouter.get('/v1/me', apiAuth.requireApiToken('read:me'), (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
    workspace: req.workspace ? { id: req.workspace.id, name: req.workspace.client_name } : null,
    scopes: req.apiToken.scopes
  });
});

apiRouter.get('/v1/risks', apiAuth.requireApiToken('read:risks'), (req, res) => {
  if (!req.workspace) return res.status(400).json({ error: 'token_not_workspace_scoped' });
  const rows = db.prepare(`SELECT id, title, likelihood, impact, treatment, status, owner_name, residual_likelihood, residual_impact FROM risks WHERE workspace_id=?`).all(req.workspace.id);
  res.json({ risks: rows });
});

apiRouter.post('/v1/risks', apiAuth.requireApiToken('write:risks'), (req, res) => {
  if (!req.workspace) return res.status(400).json({ error: 'token_not_workspace_scoped' });
  const { title, description, likelihood, impact, treatment, owner_name, asset_id } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title_required' });
  const id = db.prepare(`INSERT INTO risks (workspace_id, title, description, likelihood, impact, treatment, owner_name, asset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, title, description || null, parseInt(likelihood)||3, parseInt(impact)||3, treatment || 'modify', owner_name || null, asset_id || null).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'api_create_risk', 'risk', id, { title }, auditCtx(req));
  res.status(201).json({ id });
});

apiRouter.get('/v1/controls', apiAuth.requireApiToken('read:controls'), (req, res) => {
  if (!req.workspace) return res.status(400).json({ error: 'token_not_workspace_scoped' });
  const rows = db.prepare(`SELECT i.id, i.title, i.type, i.category,
      COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.maturity, cs.last_updated
      FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      ORDER BY i.sort_order`).all(req.workspace.id);
  res.json({ controls: rows });
});

apiRouter.patch('/v1/controls/:isoId', apiAuth.requireApiToken('write:controls'), (req, res) => {
  if (!req.workspace) return res.status(400).json({ error: 'token_not_workspace_scoped' });
  getOrCreateState(req.workspace.id, req.params.isoId);
  const allowed = ['status','applicability','maturity','notes','inclusion_justification','exclusion_justification'];
  const sets = []; const vals = [];
  Object.keys(req.body || {}).forEach(k => { if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(req.body[k]); } });
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push("last_updated=CURRENT_TIMESTAMP");
  vals.push(req.workspace.id, req.params.isoId);
  db.prepare(`UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
  logAction(req.user.id, req.workspace.id, 'api_update_control', 'control', req.params.isoId, req.body, auditCtx(req));
  res.json({ ok: true });
});

apiRouter.post('/v1/evidence', apiAuth.requireApiToken('write:evidence'), upload.single('file'), (req, res) => {
  if (!req.workspace) return res.status(400).json({ error: 'token_not_workspace_scoped' });
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const buf = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const id = db.prepare(`INSERT INTO evidence (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, req.body.iso_item_id || null, req.file.originalname, req.file.filename, sha, req.file.size, req.user.id, req.body.description || null).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'api_upload_evidence', 'evidence', id, { filename: req.file.originalname }, auditCtx(req));
  res.status(201).json({ id, sha256: sha });
});

apiRouter.get('/v1/readiness', apiAuth.requireApiToken('read:readiness'), (req, res) => {
  if (!req.workspace) return res.status(400).json({ error: 'token_not_workspace_scoped' });
  res.json(computeReadiness(req.workspace));
});

apiRouter.get('/v1/search', apiAuth.requireApiToken('read:search'), (req, res) => {
  if (!req.workspace) return res.status(400).json({ error: 'token_not_workspace_scoped' });
  res.json({ results: fts.search(req.workspace.id, req.query.q || '') });
});

apiRouter.use((err, req, res, next) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'server_error', message: err.message });
});
app.use('/api', apiRouter);

// API token management UI (stays inside the regular session-cookie auth)
app.get('/workspaces/:wsId/api-tokens', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const tokens = db.prepare(`SELECT id, name, prefix, scopes, expires_at, last_used_at, ip_lock, revoked_at, created_at
    FROM api_tokens WHERE workspace_id=? ORDER BY created_at DESC`).all(req.workspace.id);
  res.render('api_tokens', { user: req.user, ws: req.workspace, tokens, toastSecret: req.session.lastApiTokenSecret });
  delete req.session.lastApiTokenSecret;
});

app.post('/workspaces/:wsId/api-tokens', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
  const { name, scopes, expires_at, ip_lock } = req.body;
  if (!name) return res.redirect('back');
  const scopeList = (scopes || '*').split(',').map(s => s.trim()).filter(Boolean);
  const out = apiAuth.generate({ workspaceId: req.workspace.id, userId: req.user.id, name, scopes: scopeList, expiresAt: expires_at || null, ipLock: ip_lock || null });
  logAction(req.user.id, req.workspace.id, 'create_api_token', 'api_token', out.id, { name, scopes: scopeList }, auditCtx(req));
  // Render directly with the plaintext secret (one-time display) instead of
  // redirecting — avoids any session-flash flakiness for an already-rare action.
  const tokens = db.prepare(`SELECT id, name, prefix, scopes, expires_at, last_used_at, ip_lock, revoked_at, created_at
    FROM api_tokens WHERE workspace_id=? ORDER BY created_at DESC`).all(req.workspace.id);
  res.render('api_tokens', { user: req.user, ws: req.workspace, tokens, toastSecret: out.plaintext });
});

app.post('/workspaces/:wsId/api-tokens/:id/revoke', requireAuth, requireWorkspace, requirePermission('members.assign_role'), (req, res) => {
  db.prepare(`UPDATE api_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'revoke_api_token', 'api_token', req.params.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/api-tokens`);
});

// ==================== CONTINUOUS CONTROL MONITORING (CCM) UI ====================
app.get('/workspaces/:wsId/ccm', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const results = ccm.latestResults(req.workspace.id);
  const summary = { pass: 0, fail: 0, warn: 0, never: 0 };
  results.forEach(r => { summary[r.status || 'never']++; });
  res.render('ccm', { user: req.user, ws: req.workspace, results, summary });
});

app.post('/workspaces/:wsId/ccm/run', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
  const r = ccm.runAll(req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'run_ccm', 'ccm', null, r, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/ccm`, `${r.pass} pass · ${r.fail} fail · ${r.warn} warn`));
});

// ==================== RISK APPETITE + ACCEPTANCE E-SIGN ====================
app.get('/workspaces/:wsId/risk-appetite', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  let app_ = db.prepare('SELECT * FROM risk_appetites WHERE workspace_id=?').get(req.workspace.id);
  if (!app_) {
    db.prepare(`INSERT INTO risk_appetites (workspace_id, statement, appetite_low_max, appetite_med_max) VALUES (?, ?, ?, ?)`)
      .run(req.workspace.id, '', 6, 12);
    app_ = db.prepare('SELECT * FROM risk_appetites WHERE workspace_id=?').get(req.workspace.id);
  }
  res.render('risk_appetite', { user: req.user, ws: req.workspace, appetite: app_ });
});

app.post('/workspaces/:wsId/risk-appetite', requireAuth, requireWorkspace, requirePermission('risk.methodology'), (req, res) => {
  const { statement, appetite_low_max, appetite_med_max, auto_accept_below, approver_role } = req.body;
  db.prepare(`UPDATE risk_appetites SET statement=?, appetite_low_max=?, appetite_med_max=?, auto_accept_below=?, approver_role=?, updated_at=CURRENT_TIMESTAMP WHERE workspace_id=?`)
    .run(statement || '', parseFloat(appetite_low_max)||0, parseFloat(appetite_med_max)||0, auto_accept_below === 'on' ? 1 : 0, approver_role || null, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'update_appetite', 'appetite', null, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/risk-appetite`);
});

app.post('/workspaces/:wsId/risks/:id/accept', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const risk = db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.redirect('back');
  const { accepter_name, accepter_role, rationale, expires_at, attestation } = req.body;
  if (attestation !== '1' || !accepter_name || !rationale) {
    return res.status(400).render('error', { user: req.user, message: 'Acceptance requires accepter name, rationale, and attestation tickbox.' });
  }
  const residual = (risk.residual_likelihood || risk.likelihood) * (risk.residual_impact || risk.impact);
  const ts = new Date().toISOString();
  const payload = `accept|${risk.id}|${accepter_name}|${residual}|${ts}`;
  const sig = enc.signHmac(payload, req.workspace.id);
  const id = db.prepare(`INSERT INTO risk_acceptances (workspace_id, risk_id, accepter_name, accepter_role, accepter_user_id, rationale, residual_score, expires_at, signature, ip_address, user_agent, signed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, risk.id, accepter_name, accepter_role || null, req.user.id,
    rationale, residual, expires_at || null, sig,
    auditCtx(req).ip, auditCtx(req).userAgent, ts).lastInsertRowid;
  db.prepare(`UPDATE risks SET status='accepted', accepted_until=?, last_acceptance_id=? WHERE id=?`)
    .run(expires_at || null, id, risk.id);
  logAction(req.user.id, req.workspace.id, 'accept_risk', 'risk', risk.id, { acceptance_id: id, expires_at }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/${risk.id}`, 'Risk acceptance recorded'));
});

app.get('/workspaces/:wsId/risks/:id/acceptances', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const risk = db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Not found');
  const list = db.prepare(`SELECT * FROM risk_acceptances WHERE risk_id=? ORDER BY signed_at DESC`).all(risk.id);
  res.render('risk_acceptances', { user: req.user, ws: req.workspace, risk, list });
});

app.post('/workspaces/:wsId/risks/:id/acceptances/:aid/revoke', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  db.prepare(`UPDATE risk_acceptances SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND risk_id=?`).run(req.params.aid, req.params.id);
  // Reset risk to open if no other active acceptance
  const remaining = db.prepare(`SELECT COUNT(*) c FROM risk_acceptances WHERE risk_id=? AND revoked_at IS NULL`).get(req.params.id).c;
  if (remaining === 0) db.prepare(`UPDATE risks SET status='open', accepted_until=NULL WHERE id=?`).run(req.params.id);
  logAction(req.user.id, req.workspace.id, 'revoke_acceptance', 'risk', req.params.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/acceptances`);
});

// ==================== CUSTOM FIELDS ====================
app.get('/workspaces/:wsId/custom-fields', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  const fields = db.prepare(`SELECT * FROM custom_field_defs WHERE workspace_id=? ORDER BY entity_type, sort_order, label`).all(req.workspace.id);
  res.render('custom_fields', { user: req.user, ws: req.workspace, fields });
});

app.post('/workspaces/:wsId/custom-fields', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  const { entity_type, field_key, label, field_type, options, required } = req.body;
  if (!entity_type || !field_key || !label || !field_type) return res.redirect('back');
  try {
    db.prepare(`INSERT INTO custom_field_defs (workspace_id, entity_type, field_key, label, field_type, options, required) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, entity_type, field_key, label, field_type, options || null, required === 'on' ? 1 : 0);
    logAction(req.user.id, req.workspace.id, 'create_custom_field', 'custom_field', null, { entity_type, field_key }, auditCtx(req));
  } catch (e) { /* duplicate */ }
  res.redirect(`/workspaces/${req.workspace.id}/custom-fields`);
});

app.post('/workspaces/:wsId/custom-fields/:id/delete', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  db.prepare('DELETE FROM custom_field_defs WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect('back');
});

// Set values on any entity
app.post('/workspaces/:wsId/custom-fields/:type/:entityId', requireAuth, requireWorkspace, (req, res) => {
  const defs = db.prepare(`SELECT * FROM custom_field_defs WHERE workspace_id=? AND entity_type=?`).all(req.workspace.id, req.params.type);
  const upsert = db.prepare(`INSERT INTO custom_field_values (workspace_id, entity_type, entity_id, field_def_id, value)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_type, entity_id, field_def_id) DO UPDATE SET value=excluded.value`);
  for (const d of defs) {
    const v = req.body['cf_' + d.id];
    if (v !== undefined) upsert.run(req.workspace.id, req.params.type, String(req.params.entityId), d.id, v);
  }
  res.redirect('back');
});

function loadCustomFields(wsId, entityType, entityId) {
  return db.prepare(`SELECT d.*, v.value FROM custom_field_defs d
    LEFT JOIN custom_field_values v ON v.field_def_id=d.id AND v.entity_type=? AND v.entity_id=?
    WHERE d.workspace_id=? AND d.entity_type=? ORDER BY d.sort_order, d.label`).all(entityType, String(entityId), wsId, entityType);
}
app.locals.loadCustomFields = loadCustomFields;

// ==================== DPIA WORKFLOW ====================
app.get('/workspaces/:wsId/dpias', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const list = db.prepare(`SELECT id, title, status, residual_risk_level, outcome, approver, approved_at, created_at FROM dpias WHERE workspace_id=? ORDER BY created_at DESC`).all(req.workspace.id);
  res.render('dpias', { user: req.user, ws: req.workspace, list });
});

app.post('/workspaces/:wsId/dpias', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const { title } = req.body;
  if (!title) return res.redirect('back');
  const id = db.prepare(`INSERT INTO dpias (workspace_id, title, created_by) VALUES (?, ?, ?)`).run(req.workspace.id, title, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_dpia', 'dpia', id, { title }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/dpias/${id}`);
});

app.get('/workspaces/:wsId/dpias/:id', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const dpia = db.prepare(`SELECT * FROM dpias WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!dpia) return res.status(404).send('Not found');
  res.render('dpia_detail', { user: req.user, ws: req.workspace, dpia });
});

app.post('/workspaces/:wsId/dpias/:id', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const fields = ['title','processing_description','data_categories','data_subjects','lawful_basis','necessity_test','proportionality_test','data_flows','retention_period','international_transfers','consultations','identified_risks','mitigations','residual_risk_level','outcome','status'];
  const sets = []; const vals = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); vals.push(req.body[f] || null); } });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  vals.push(req.params.id, req.workspace.id);
  db.prepare(`UPDATE dpias SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
  logAction(req.user.id, req.workspace.id, 'update_dpia', 'dpia', req.params.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/dpias/${req.params.id}`);
});

app.post('/workspaces/:wsId/dpias/:id/approve', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const { approver, attestation } = req.body;
  if (attestation !== '1' || !approver) return res.redirect('back');
  const dpia = db.prepare(`SELECT * FROM dpias WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!dpia) return res.redirect('back');
  const ts = new Date().toISOString();
  const payload = `dpia|${dpia.id}|${approver}|${dpia.outcome || ''}|${ts}`;
  const sig = enc.signHmac(payload, req.workspace.id);
  db.prepare(`UPDATE dpias SET status='approved', approver=?, approver_signature=?, approved_at=? WHERE id=?`)
    .run(approver, sig, ts, dpia.id);
  logAction(req.user.id, req.workspace.id, 'approve_dpia', 'dpia', dpia.id, { approver }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/dpias/${dpia.id}`);
});

app.post('/workspaces/:wsId/dpias/:id/delete', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  db.prepare('DELETE FROM dpias WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/dpias`);
});

// ==================== COMPLIANCE CALENDAR ====================
app.get('/workspaces/:wsId/calendar', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const wsId = req.workspace.id;
  const horizon = parseInt(req.query.days || '90', 10);
  const events = [];
  db.prepare(`SELECT 'doc_review' AS k, id, name AS title, next_review_date AS d FROM generated_docs WHERE workspace_id=? AND next_review_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/documents/${r.id}` }));
  db.prepare(`SELECT 'supplier_review' AS k, id, name AS title, next_review_date AS d FROM suppliers WHERE workspace_id=? AND lifecycle_stage != 'terminated' AND next_review_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/vendors/${r.id}` }));
  db.prepare(`SELECT 'nc_due' AS k, id, title, due_date AS d FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/nonconformities/${r.id}` }));
  db.prepare(`SELECT 'task_due' AS k, id, title, due_date AS d FROM tasks WHERE workspace_id=? AND status != 'done' AND due_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/tasks` }));
  db.prepare(`SELECT 'training_expiry' AS k, id, training_name AS title, expiry_date AS d FROM training_records WHERE workspace_id=? AND expiry_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/training` }));
  db.prepare(`SELECT 'attestation_expiry' AS k, d.id, (s.name || ' — ' || d.name) AS title, d.expiry_date AS d FROM supplier_documents d INNER JOIN suppliers s ON s.id=d.supplier_id WHERE s.workspace_id=? AND d.expiry_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/vendors/${r.id}?tab=documents` }));
  db.prepare(`SELECT 'audit' AS k, id, title, audit_date AS d, status FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, k: r.status === 'complete' ? 'audit_complete' : r.status === 'in_progress' ? 'audit_in_progress' : 'audit_planned', link: `/workspaces/${wsId}/audits/${r.id}` }));
  db.prepare(`SELECT 'mrm' AS k, id, ('MRM ' || meeting_date) AS title, meeting_date AS d FROM mrms WHERE workspace_id=? AND meeting_date IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/mrms/${r.id}` }));
  db.prepare(`SELECT 'risk_acceptance_expiry' AS k, id, ('Risk #' || id || ' acceptance') AS title, accepted_until AS d FROM risks WHERE workspace_id=? AND accepted_until IS NOT NULL`).all(wsId).forEach(r => events.push({ ...r, link: `/workspaces/${wsId}/risks/${r.id}` }));
  events.sort((a, b) => (a.d || '').localeCompare(b.d || ''));

  // Filter to horizon (past 7 days through future N days)
  const today = new Date();
  const past = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0,10);
  const future = new Date(today.getTime() + horizon * 86400000).toISOString().slice(0,10);
  const filtered = events.filter(e => e.d >= past && e.d <= future);

  res.render('calendar', { user: req.user, ws: req.workspace, events: filtered, horizon });
});

// ==================== FTS5 SEARCH UI ====================
app.get('/workspaces/:wsId/search', requireAuth, requireWorkspace, (req, res) => {
  const q = (req.query.q || '').trim();
  const results = q ? fts.search(req.workspace.id, q) : [];
  res.render('search', { user: req.user, ws: req.workspace, q, results });
});

app.post('/workspaces/:wsId/search/rebuild', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  const n = fts.rebuildAll(req.workspace.id);
  res.redirect(withToast(`/workspaces/${req.workspace.id}/search`, `Rebuilt ${n} entries`));
});

// ==================== CLIENT HANDOVER EXPORT ====================
app.get('/workspaces/:wsId/handover', requireAuth, requireWorkspace, requirePermission('workspace.export'), async (req, res) => {
  const ws = req.workspace;
  const safeName = ws.client_name.replace(/[^\w]+/g, '_');
  const today = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="handover-${safeName}-${today}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', err => { console.error(err); res.status(500).end(); });
  zip.pipe(res);

  // Dump every workspace-scoped table as JSON
  const tables = [
    'workspaces','entities','assets','risks','risk_treatments','risk_acceptances','risk_methodologies','risk_appetites','kris','kri_readings',
    'control_states','entity_control_states','soa_snapshots','dpias',
    'generated_docs','doc_versions','doc_approvers','doc_signatures','doc_ack_campaigns','doc_ack_recipients',
    'evidence','comments','comment_mentions',
    'audits','audit_findings','audit_observations','audit_programmes',
    'mrms','nonconformities','incidents','incident_events',
    'suppliers','supplier_documents','supplier_subprocessors','supplier_reviews','supplier_notes','supplier_clauses','supplier_questionnaires','supplier_questionnaire_responses','supplier_monitoring','supplier_termination_items',
    'training_courses','training_records','phishing_simulations',
    'tasks','task_templates','time_entries',
    'asset_relationships','retention_rules','custom_field_defs','custom_field_values',
    'workspace_members','workspace_role_overrides','access_reviews','access_review_items',
    'audit_log','audit_chain','notifications'
  ];
  for (const t of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      const wsCol = cols.includes('workspace_id') ? 'workspace_id' : null;
      const rows = wsCol
        ? db.prepare(`SELECT * FROM ${t} WHERE ${wsCol}=?`).all(ws.id)
        : db.prepare(`SELECT * FROM ${t} WHERE id=?`).all(ws.id);
      // Decrypt encrypted fields for portability
      rows.forEach(r => {
        Object.keys(r).forEach(k => {
          if (typeof r[k] === 'string' && r[k].startsWith('enc:v1:')) {
            try { r[k] = enc.decryptIfNeeded(r[k], ws.id); } catch (_) {}
          }
        });
      });
      zip.append(JSON.stringify(rows, null, 2), { name: `data/${t}.json` });
    } catch (e) { /* table may not exist on older DB */ }
  }

  // All evidence files
  const evidence = db.prepare(`SELECT * FROM evidence WHERE workspace_id=?`).all(ws.id);
  for (const e of evidence) {
    const fp = path.join(__dirname, 'uploads', e.stored_path);
    if (fs.existsSync(fp)) zip.file(fp, { name: `evidence/${e.id}_${e.filename}` });
  }
  // All supplier files
  const supDocs = db.prepare(`SELECT d.* FROM supplier_documents d INNER JOIN suppliers s ON s.id=d.supplier_id WHERE s.workspace_id=?`).all(ws.id);
  for (const d of supDocs) {
    if (d.stored_path) {
      const fp = path.join(__dirname, 'uploads', d.stored_path);
      if (fs.existsSync(fp)) zip.file(fp, { name: `supplier-files/${d.id}_${d.filename}` });
    }
  }

  // README + import instructions
  const readme = `ISMS handover package — ${ws.client_name}
==========================================================

Generated: ${new Date().toISOString()}
Workspace ID: ${ws.id}
Client: ${ws.client_name}

Contents:
  data/*.json     — every database row scoped to this workspace, decrypted for portability
  evidence/       — every evidence file uploaded against any control
  supplier-files/ — every supplier attestation / contract

To import this elsewhere:
  1. Stand up an ISMS instance (any version >= today's).
  2. Restore the JSON files into the corresponding tables — preserving primary keys
     where possible. \`workspaces\` first, then everything keyed off workspace_id.
  3. Place evidence/* and supplier-files/* into the new instance's uploads/ directory
     using the same filenames.
  4. Re-encrypt sensitive fields under the new instance's master key (or run the
     /workspaces/:id/handover/import migration helper if available).
  5. Verify the audit-log hash chain at /workspaces/<id>/activity-log/verify.
`;
  zip.append(readme, { name: 'README.txt' });
  await zip.finalize();
  logAction(req.user.id, ws.id, 'handover_export', 'workspace', ws.id, null, auditCtx(req));
});

// ==================== BULK OPS ====================
app.post('/workspaces/:wsId/bulk/:type', requireAuth, requireWorkspace, (req, res) => {
  const allowed = { risks: { perm: 'risk.delete' }, assets: { perm: 'asset.delete' }, tasks: { perm: 'task.manage' }, suppliers: { perm: 'supplier.manage' }, ncs: { perm: 'nc.manage' }, incidents: { perm: 'incident.manage' } };
  const cfg = allowed[req.params.type];
  if (!cfg) return res.status(400).send('unknown type');
  if (!rbac.hasPermission(permissionsFor(req.user, req.workspace), cfg.perm)) return res.status(403).render('error', { user: req.user, message: 'forbidden' });
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : [])).map(Number).filter(Boolean);
  if (!ids.length) return res.redirect('back');
  const op = req.body.op;
  const tableMap = { risks: 'risks', assets: 'assets', tasks: 'tasks', suppliers: 'suppliers', ncs: 'nonconformities', incidents: 'incidents' };
  const table = tableMap[req.params.type];
  if (op === 'delete') {
    const stmt = db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace_id=?`);
    const tx = db.transaction(() => { for (const id of ids) stmt.run(id, req.workspace.id); });
    tx();
  } else if (op === 'reassign' && req.body.assignee) {
    const cols = { risks: 'owner_name', assets: 'owner_name', tasks: 'assignee_id', suppliers: 'approved_by', ncs: 'responsible', incidents: 'reported_by' };
    const col = cols[req.params.type];
    const stmt = db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=? AND workspace_id=?`);
    const tx = db.transaction(() => { for (const id of ids) stmt.run(req.body.assignee, id, req.workspace.id); });
    tx();
  } else if (op === 'archive' && (req.params.type === 'tasks' || req.params.type === 'incidents' || req.params.type === 'ncs')) {
    const stmt = db.prepare(`UPDATE ${table} SET status='closed' WHERE id=? AND workspace_id=?`);
    const tx = db.transaction(() => { for (const id of ids) stmt.run(id, req.workspace.id); });
    tx();
  }
  logAction(req.user.id, req.workspace.id, 'bulk_' + op, req.params.type, null, { count: ids.length }, auditCtx(req));
  res.redirect('back');
});

// ==================== REPORT BUILDER ====================
app.get('/workspaces/:wsId/reports', requireAuth, requireWorkspace, requirePermission('workspace.export'), (req, res) => {
  const list = db.prepare(`SELECT id, name, description, is_system FROM report_templates WHERE workspace_id IS NULL OR workspace_id=? OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
  res.render('reports', { user: req.user, ws: req.workspace, list });
});

app.get('/workspaces/:wsId/reports/:id', requireAuth, requireWorkspace, requirePermission('workspace.export'), (req, res) => {
  const tpl = db.prepare(`SELECT * FROM report_templates WHERE id=?`).get(req.params.id);
  if (!tpl) return res.status(404).send('Not found');
  const ctx = reports.buildContext(req.workspace.id);
  const body = reports.render(tpl.body, ctx);
  res.render('report_view', { user: req.user, ws: req.workspace, tpl, body });
});

app.get('/workspaces/:wsId/reports/:id/docx', requireAuth, requireWorkspace, requirePermission('workspace.export'), async (req, res) => {
  const tpl = db.prepare(`SELECT * FROM report_templates WHERE id=?`).get(req.params.id);
  if (!tpl) return res.status(404).send('Not found');
  const ctx = reports.buildContext(req.workspace.id);
  const body = reports.render(tpl.body, ctx);
  const fakeDoc = { name: tpl.name, version: 1, status: 'report', content: body };
  try {
    const buf = await generateDocxBuffer(fakeDoc, req.workspace);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${tpl.name.replace(/[^\w\- ]+/g,'_')}.docx"`);
    res.send(buf);
  } catch (e) { res.status(500).send('docx error: ' + e.message); }
});

app.post('/workspaces/:wsId/reports', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  const { name, description, body } = req.body;
  if (!name || !body) return res.redirect('back');
  const id = db.prepare(`INSERT INTO report_templates (workspace_id, firm_id, name, description, body, is_system) VALUES (?, NULL, ?, ?, ?, 0)`)
    .run(req.workspace.id, name, description || null, body).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_report_template', 'report', id, { name }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/reports`);
});

// ==================== ONBOARDING WIZARD ====================
app.get('/workspaces/:wsId/onboarding', requireAuth, requireWorkspace, (req, res) => {
  let prog = db.prepare(`SELECT * FROM onboarding_progress WHERE workspace_id=?`).get(req.workspace.id);
  if (!prog) {
    db.prepare(`INSERT INTO onboarding_progress (workspace_id) VALUES (?)`).run(req.workspace.id);
    prog = db.prepare(`SELECT * FROM onboarding_progress WHERE workspace_id=?`).get(req.workspace.id);
  }
  // Auto-detect completion of each step
  const ws = req.workspace;
  const real = {
    step_workspace: !!ws.client_name,
    step_scope: !!(ws.scope && ws.scope.length > 10),
    step_assets: db.prepare(`SELECT 1 FROM assets WHERE workspace_id=? LIMIT 1`).get(ws.id) ? 1 : 0,
    step_risk: db.prepare(`SELECT 1 FROM risks WHERE workspace_id=? LIMIT 1`).get(ws.id) ? 1 : 0,
    step_methodology: db.prepare(`SELECT 1 FROM risk_methodologies WHERE workspace_id=? AND is_active=1 LIMIT 1`).get(ws.id) ? 1 : 0,
    step_policies: db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') LIMIT 1`).get(ws.id) ? 1 : 0,
    step_team: db.prepare(`SELECT 1 FROM workspace_members WHERE workspace_id=? LIMIT 1`).get(ws.id) ? 1 : 0,
    step_supplier: db.prepare(`SELECT 1 FROM suppliers WHERE workspace_id=? LIMIT 1`).get(ws.id) ? 1 : 0
  };
  res.render('onboarding', { user: req.user, ws: req.workspace, prog, real });
});

app.post('/workspaces/:wsId/onboarding/dismiss', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`INSERT INTO onboarding_progress (workspace_id, dismissed) VALUES (?, 1)
    ON CONFLICT(workspace_id) DO UPDATE SET dismissed=1`).run(req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}`);
});

// ==================== RETENTION + OBSERVATIONS + CRISIS COMMS ====================
app.get('/workspaces/:wsId/retention', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  const rules = db.prepare(`SELECT * FROM retention_rules WHERE workspace_id=? ORDER BY id DESC`).all(req.workspace.id);
  res.render('retention', { user: req.user, ws: req.workspace, rules });
});

app.post('/workspaces/:wsId/retention', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  const { applies_to, pattern, retain_years, reason } = req.body;
  if (!applies_to || !retain_years) return res.redirect('back');
  db.prepare(`INSERT INTO retention_rules (workspace_id, applies_to, pattern, retain_years, reason) VALUES (?, ?, ?, ?, ?)`)
    .run(req.workspace.id, applies_to, pattern || null, parseInt(retain_years), reason || null);
  // Apply to existing evidence
  if (applies_to === 'evidence') {
    const all = db.prepare(`SELECT id, filename, iso_item_id FROM evidence WHERE workspace_id=?`).all(req.workspace.id);
    const re = pattern ? new RegExp(pattern, 'i') : null;
    const upd = db.prepare(`UPDATE evidence SET retention_until=date(uploaded_at, '+' || ? || ' years') WHERE id=?`);
    for (const e of all) {
      if (!re || re.test(e.filename) || re.test(e.iso_item_id || '')) upd.run(retain_years, e.id);
    }
  }
  res.redirect('back');
});

app.post('/workspaces/:wsId/retention/:id/delete', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  db.prepare(`DELETE FROM retention_rules WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect('back');
});

// Audit observations (lighter than findings)
app.post('/workspaces/:wsId/audits/:id/observations', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const { iso_item_id, description, recommendation } = req.body;
  if (!description) return res.redirect('back');
  db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, recommendation) VALUES (?, ?, ?, ?)`)
    .run(req.params.id, iso_item_id || null, description, recommendation || null);
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

app.post('/workspaces/:wsId/audits/observations/:obsId/close', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=?`).run(req.params.obsId);
  res.redirect('back');
});

// Crisis comms templates listing
app.get('/workspaces/:wsId/crisis-comms', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const list = db.prepare(`SELECT * FROM crisis_comms_templates WHERE is_system=1 OR firm_id=? ORDER BY audience, name`).all(req.workspace.firm_id);
  res.render('crisis_comms', { user: req.user, ws: req.workspace, list });
});

// ==================== KEY ROTATION + BACKUP UI ====================
app.get('/workspaces/:wsId/system', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).render('error', { user: req.user, message: 'Firm owner only.' });
  const backups = backup.listBackups();
  const rotations = db.prepare(`SELECT * FROM key_rotations ORDER BY id DESC LIMIT 50`).all();
  const masterFp = keyrotation.fingerprint(enc.masterKey());
  res.render('system', { user: req.user, ws: req.workspace, backups, rotations, masterFp });
});

app.post('/workspaces/:wsId/system/backup', requireAuth, requireWorkspace, async (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).send('forbidden');
  const r = await backup.runBackup();
  logAction(req.user.id, req.workspace.id, 'manual_backup', 'system', null, r, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/system`, r.ok ? 'Backup ok' : 'Backup failed: ' + r.error, r.ok ? 'success' : 'error'));
});

app.post('/workspaces/:wsId/system/rotate-key', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).send('forbidden');
  if (req.body.confirm !== 'rotate') return res.redirect(`/workspaces/${req.workspace.id}/system`);
  const r = keyrotation.rotate(req.user.id);
  logAction(req.user.id, null, 'rotate_master_key', 'system', null, r, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/system`, r.ok ? `Rotated. Re-encrypted ${r.rows} rows.` : 'Rotation failed: ' + r.error, r.ok ? 'success' : 'error'));
});

// ==================== DASHBOARD WIDGETS (per-user) ====================
const WIDGET_KEYS = ['readiness','top_risks','open_ncs','upcoming','ccm','sparkline'];

app.get('/workspaces/:wsId/widgets', requireAuth, requireWorkspace, (req, res) => {
  const widgets = db.prepare(`SELECT widget_key, position FROM dashboard_widgets WHERE workspace_id=? AND user_id=? ORDER BY position`).all(req.workspace.id, req.user.id);
  const enabled = new Set(widgets.map(w => w.widget_key));
  res.render('widgets', { user: req.user, ws: req.workspace, allWidgets: WIDGET_KEYS, enabled });
});

app.post('/workspaces/:wsId/widgets', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM dashboard_widgets WHERE workspace_id=? AND user_id=?`).run(req.workspace.id, req.user.id);
  const ins = db.prepare(`INSERT INTO dashboard_widgets (workspace_id, user_id, widget_key, position) VALUES (?, ?, ?, ?)`);
  const list = Array.isArray(req.body.widgets) ? req.body.widgets : (req.body.widgets ? [req.body.widgets] : []);
  list.forEach((k, i) => { if (WIDGET_KEYS.includes(k)) ins.run(req.workspace.id, req.user.id, k, i); });
  res.redirect(`/workspaces/${req.workspace.id}/widgets`);
});

// ==================== FILE PREVIEW ====================
app.get('/workspaces/:wsId/evidence/:id/preview', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const ev = db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const fp = path.join(__dirname, 'uploads', ev.stored_path);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  const ext = path.extname(ev.filename).toLowerCase();
  const ct = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.svg':'image/svg+xml','.txt':'text/plain' }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', `inline; filename="${ev.filename}"`);
  res.sendFile(fp);
});

// ==================== I18N STRINGS API (for client side) ====================
app.get('/api/i18n/:locale', (req, res) => {
  res.json(i18n.load(req.params.locale));
});

// Locale switching for the user
app.post('/i18n/switch', requireAuth, (req, res) => {
  const code = (req.body.locale || 'en').slice(0, 8);
  if (i18n.listAvailable().includes(code)) {
    db.prepare('UPDATE users SET locale=? WHERE id=?').run(code, req.user.id);
  }
  res.redirect(req.headers.referer || '/dashboard');
});

// ==================== COMMENT MENTIONS HANDLING ====================
// Override the existing comments POST to extract @mentions and notify
function extractMentions(body) {
  const out = new Set();
  const re = /@([a-zA-Z0-9._-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

// Keep existing POST /comments — just add a post-processor to record mentions
// Hook into existing comment route by patching after-create. We already inserted
// comments; add a small route that handles mentions parse separately.
app.post('/workspaces/:wsId/comments/:id/mentions', requireAuth, requireWorkspace, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!c) return res.redirect('back');
  const decBody = enc.decryptIfNeeded(c.body, req.workspace.id);
  const handles = extractMentions(decBody);
  if (!handles.length) return res.redirect('back');
  const users = db.prepare(`SELECT id, name FROM users WHERE active=1`).all();
  const ins = db.prepare(`INSERT OR IGNORE INTO comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?)`);
  let mentioned = 0;
  for (const h of handles) {
    const u = users.find(u => u.name.toLowerCase().replace(/\s+/g,'') === h.toLowerCase());
    if (u) { ins.run(c.id, u.id); mentioned++;
      jobs.notify(req.workspace.id, u.id, 'mention', 'info', `@${h} you were mentioned`, decBody.slice(0,140), `/workspaces/${req.workspace.id}`); }
  }
  if (mentioned > 0) db.prepare('UPDATE comments SET has_mentions=1 WHERE id=?').run(c.id);
  res.redirect('back');
});

// ==================== ERROR HANDLERS ====================
app.use((req, res) => {
  res.status(404).render('error', { user: currentUser(req), message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).render('error', { user: currentUser(req), message: 'Server error: ' + err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nISO 27001 Tool running at http://localhost:${PORT}`);
  console.log(`First time? Visit /register to create your firm account.\n`);
});
