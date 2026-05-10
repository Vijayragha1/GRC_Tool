const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = require('docx');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const MarkdownIt = require('markdown-it');
const htmlToDocx = require('html-to-docx');
const mdRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });

// Heuristic: a string is "markdown-ish" (not yet HTML) when it has no real HTML element tags.
// Used to lazily upgrade existing markdown documents to HTML the first time they're opened.
function looksLikeMarkdown(s) {
  if (!s) return false;
  return !/<(p|h[1-6]|ul|ol|li|table|tr|td|th|div|span|strong|em|br|hr|img|a)\b/i.test(s);
}
const { db, init, logAction, verifyAuditChain, defaultMethodology, ensureWorkspaceMethodology, getActiveMethodology, methodologyBand } = require('./db');
const enc = require('./lib/encryption');
const rbac = require('./lib/rbac');
const jobs = require('./lib/jobs');
const fts = require('./lib/fts');
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
app.use('/vendor/tinymce', express.static(path.join(__dirname, 'node_modules/tinymce')));
// Quiet the favicon 404 — no icon yet, just respond with No Content.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production-' + crypto.randomBytes(8).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// CSRF protection on every state-changing request. Token is exposed via
// res.locals.csrfToken — partials/header.ejs renders it in a <meta> tag,
// and partials/footer.ejs has a load-time form walker that injects a hidden
// _csrf input into every form. Tests can disable via DISABLE_CSRF=1.
const { csrfMiddleware } = require('./lib/csrf');
if (process.env.DISABLE_CSRF !== '1') {
  app.use(csrfMiddleware);
} else {
  // Still expose an empty token so EJS templates don't error.
  app.use((_req, res, next) => { res.locals.csrfToken = ''; next(); });
}

// Per-tenant upload partitioning: each firm gets its own subdirectory under
// uploads/. The destination function inspects req.workspace (set by
// requireWorkspace) or, for routes that operate without a workspace context,
// falls back to req.user.firm_id. The stored_path written to the DB is just
// the basename — resolveUploadPath() rebuilds the absolute path on read,
// trying the per-firm location first and falling back to legacy uploads/ for
// files written before partitioning existed.
const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, _file, cb) {
      const firmId = (req.workspace && req.workspace.firm_id) || (req.user && req.user.firm_id) || 0;
      const dir = path.join(__dirname, 'uploads', `firm_${firmId}`);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      cb(null, dir);
    },
    filename: function (_req, file, cb) {
      const rand = require('crypto').randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${rand}-${file.originalname.replace(/[^\w.\-]/g, '_')}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Resolve a stored_path back to an absolute filesystem path. Tries the
// per-firm directory first; falls back to the legacy unpartitioned uploads/
// directory for files uploaded before partitioning existed.
function resolveUploadPath(storedPath, firmId) {
  if (!storedPath) return null;
  if (firmId) {
    const partitioned = path.join(__dirname, 'uploads', `firm_${firmId}`, storedPath);
    if (fs.existsSync(partitioned)) return partitioned;
  }
  const legacy = path.join(__dirname, 'uploads', storedPath);
  return fs.existsSync(legacy) ? legacy : (firmId ? path.join(__dirname, 'uploads', `firm_${firmId}`, storedPath) : legacy);
}

// ==================== HELPERS ====================
// Auth is disabled — single-user-per-tenant local mode. The "active tenant" is
// stored in the session; currentUser returns the firm-owner of that tenant so
// every existing firm_id-based query naturally scopes to the active tenant.
function getActiveFirmId(req) {
  const sessId = parseInt((req.session && req.session.active_firm_id) || 0, 10);
  if (sessId) {
    const exists = db.prepare('SELECT id FROM firms WHERE id=?').get(sessId);
    if (exists) return sessId;
  }
  // Fall back to the lowest-id firm (the one created at first boot).
  const first = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  return first ? first.id : null;
}

function currentUser(req) {
  if (req.session && req.session.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId);
    if (u) return u;
  }
  const firmId = getActiveFirmId(req);
  if (!firmId) return null;
  return db.prepare(`SELECT * FROM users WHERE user_type='firm' AND firm_id=? AND active=1 ORDER BY id LIMIT 1`).get(firmId);
}

function listAllFirms() {
  return db.prepare(`SELECT f.id, f.name, f.created_at,
    (SELECT COUNT(*) FROM workspaces w WHERE w.firm_id=f.id) AS workspace_count
    FROM firms f ORDER BY f.id`).all();
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
  // Multi-entity scoping was removed — keep the locals as empty stubs so views that
  // still reference them degrade gracefully without re-rendering work.
  res.locals.entitySelectorWs = ws;
  res.locals.workspaceEntities = [];
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

// Coerce a form value that may be a scalar, an array, or undefined into a
// clean array of non-empty strings (deduped). Defends against trailing-`&`
// in URL-encoded bodies that produce empty entries, and against duplicate
// checkboxes posting the same value twice.
function parseFormArray(raw) {
  const arr = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = (v == null ? '' : String(v)).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function withToast(url, msg, kind) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'toast=' + encodeURIComponent(msg) + (kind ? '&toastKind=' + kind : '');
}

// Express 5 deprecated using "back" as a magic redirect target. This helper
// bounces the user back to the previous page (or /dashboard if no Referer
// header). Optional toastMsg attaches a flash-style notice to the redirect URL.
function redirectBack(req, res, toastMsg, toastKind) {
  const target = req.headers.referer || '/dashboard';
  return res.redirect(toastMsg ? withToast(target, toastMsg, toastKind) : target);
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

// Multi-entity scoping was removed. These stubs preserve call-site signatures
// so server.js can be simplified incrementally rather than in one sweeping diff.
function activeEntityFilter(_req, _sqlAlias) { return { sql: '', params: [] }; }
function requireEntity(_req) { return null; }
function listWorkspaceEntities(_wsId) { return []; }
app.locals.listWorkspaceEntities = listWorkspaceEntities;

// Make the active entity available to every view via res.locals.
app.use((req, res, next) => {
  res.locals.activeEntity = null;
  res.locals.entitySelectorWs = null;
  res.locals.unreadNotifications = 0;
  // Expose active tenant + tenant list to every view for the header switcher.
  try {
    const firmId = getActiveFirmId(req);
    res.locals.activeFirm = firmId ? db.prepare('SELECT id, name FROM firms WHERE id=?').get(firmId) : null;
    res.locals.allFirms = listAllFirms();
  } catch (_) {
    res.locals.activeFirm = null;
    res.locals.allFirms = [];
  }
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

// ==================== TENANTS + ONBOARDING ====================
// Extracted to routes/tenants.js — first slice of server.js modularization.
// The pattern: each domain module exports register(app, deps), receives all
// dependencies explicitly, knows nothing about other domains.
require('./routes/tenants').register(app, {
  db, bcrypt,
  requireAuth,
  getActiveFirmId,
  listAllFirms,
  withToast,
  projectRoot: __dirname,
});

// (tenant + onboarding routes live in routes/tenants.js — see the require
// above. Anything that needs to call them goes through HTTP, not internal
// references.)

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

  // At-risk engagements — workspaces with active passes and meaningful warning
  // signals: stale controls, overdue NCs, missed targets, no recent pass.
  const portfolioRisk = workspacesWithProgress.map(w => {
    const lastPass = db.prepare(`SELECT pass_number, status, started_at, completed_at
      FROM assessment_passes WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(w.id);
    const staleControls = db.prepare(`SELECT COUNT(*) c FROM control_states cs
      INNER JOIN iso_items i ON i.id = cs.iso_item_id
      WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
        AND (cs.last_verified_at IS NULL OR cs.last_verified_at < datetime('now','-365 days'))
        AND cs.status NOT IN ('Not Assessed','Not Applicable')`).get(w.id).c;
    const overdueNCs = w.overdueNCs || 0;
    const overdueObj = db.prepare(`SELECT COUNT(*) c FROM security_objectives
      WHERE workspace_id=? AND due_date IS NOT NULL AND due_date < date('now') AND status NOT IN ('achieved','paused')`).get(w.id).c;
    const overdueParty = db.prepare(`SELECT COUNT(*) c FROM interested_parties
      WHERE workspace_id=? AND next_review IS NOT NULL AND next_review < date('now')`).get(w.id).c;
    const noPassFor90 = lastPass && lastPass.completed_at
      && lastPass.completed_at < new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
    const reasons = [];
    let severity = 'ok';
    if (overdueNCs > 0) { reasons.push(`${overdueNCs} overdue NC`); severity = 'high'; }
    if (w.openMajorNCs > 0) { reasons.push(`${w.openMajorNCs} open major NC`); severity = 'high'; }
    if (w.readiness.daysToTarget !== null && w.readiness.daysToTarget < 30) { reasons.push('cert target < 30 days'); severity = 'high'; }
    if (overdueObj > 0) { reasons.push(`${overdueObj} overdue objective`); if (severity !== 'high') severity = 'medium'; }
    if (staleControls > 5) { reasons.push(`${staleControls} stale controls`); if (severity !== 'high') severity = 'medium'; }
    if (overdueParty > 0) { reasons.push(`${overdueParty} overdue party review`); if (severity !== 'high') severity = 'medium'; }
    if (noPassFor90 && (!lastPass || lastPass.status !== 'in_progress')) {
      reasons.push('no active pass · last completed > 90d'); if (severity !== 'high') severity = 'medium';
    }
    if (!lastPass) { reasons.push('no gap assessment ever started'); if (severity !== 'high') severity = 'medium'; }
    return { ...w, lastPass, staleControls, overdueObj, overdueParty, severity, reasons };
  });
  const atRisk = portfolioRisk.filter(r => r.severity !== 'ok')
    .sort((a, b) => (a.severity === 'high' && b.severity !== 'high' ? -1 : a.severity !== 'high' && b.severity === 'high' ? 1 : 0));

  // ---- "This week" cross-engagement view ----
  // The MSSP consultant's morning standup question is "what do I need to
  // touch this week, across all my clients?" Aggregate due-this-week and
  // overdue items across all workspaces with the client name attached.
  const today = new Date().toISOString().slice(0, 10);
  const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const wsIds = workspacesWithProgress.map(w => w.id);
  const wsNameById = {};
  for (const w of workspacesWithProgress) wsNameById[w.id] = w.brand_display_name || w.client_name;

  const thisWeek = { overdue: [], dueThisWeek: [], byClient: {} };
  if (wsIds.length) {
    const placeholders = wsIds.map(() => '?').join(',');
    // Tasks
    const tasks = db.prepare(`SELECT id, workspace_id, title, due_date, priority, status FROM tasks
      WHERE workspace_id IN (${placeholders}) AND status NOT IN ('done','closed','cancelled')
      AND due_date IS NOT NULL`).all(...wsIds);
    // NCs
    const ncs = db.prepare(`SELECT id, workspace_id, title, due_date, severity, status FROM nonconformities
      WHERE workspace_id IN (${placeholders}) AND status NOT IN ('closed','verified')
      AND due_date IS NOT NULL`).all(...wsIds);
    // Audits — table has audit_date and title (not planned_date / name).
    const audits = db.prepare(`SELECT id, workspace_id, title, audit_date AS due_date, status FROM audits
      WHERE workspace_id IN (${placeholders}) AND status NOT IN ('completed','cancelled')
      AND audit_date IS NOT NULL`).all(...wsIds);
    // MRMs — schema has meeting_date and no title column; synthesise one.
    const mrms = db.prepare(`SELECT id, workspace_id, ('MRM ' || meeting_date) AS title, meeting_date AS due_date, status FROM mrms
      WHERE workspace_id IN (${placeholders}) AND status NOT IN ('completed','cancelled')
      AND meeting_date IS NOT NULL`).all(...wsIds);

    const enrich = (items, kind) => items.map(it => ({
      kind, id: it.id, workspace_id: it.workspace_id, client: wsNameById[it.workspace_id] || '?',
      title: it.title, due_date: it.due_date, severity: it.severity || it.priority || null,
      bucket: it.due_date < today ? 'overdue' : it.due_date <= weekFromNow ? 'thisWeek' : 'later',
      href: kind === 'task' ? `/workspaces/${it.workspace_id}/tasks` :
            kind === 'nc' ? `/workspaces/${it.workspace_id}/nonconformities/${it.id}` :
            kind === 'audit' ? `/workspaces/${it.workspace_id}/audits/${it.id}` :
            kind === 'mrm' ? `/workspaces/${it.workspace_id}/mrms/${it.id}` :
            `/workspaces/${it.workspace_id}`,
    }));

    const all = [
      ...enrich(tasks, 'task'),
      ...enrich(ncs, 'nc'),
      ...enrich(audits, 'audit'),
      ...enrich(mrms, 'mrm'),
    ];
    thisWeek.overdue = all.filter(i => i.bucket === 'overdue').sort((a, b) => a.due_date.localeCompare(b.due_date));
    thisWeek.dueThisWeek = all.filter(i => i.bucket === 'thisWeek').sort((a, b) => a.due_date.localeCompare(b.due_date));
    thisWeek.totalActionable = thisWeek.overdue.length + thisWeek.dueThisWeek.length;

    // Per-client roll-up
    for (const item of all) {
      if (item.bucket === 'later') continue;
      const k = item.workspace_id;
      thisWeek.byClient[k] = thisWeek.byClient[k] || { name: item.client, ws_id: k, overdue: 0, thisWeek: 0 };
      if (item.bucket === 'overdue') thisWeek.byClient[k].overdue++;
      else thisWeek.byClient[k].thisWeek++;
    }
  }

  res.render('dashboard', { user: req.user, workspaces: workspacesWithProgress, firmUsers, totals, atRisk, thisWeek });
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

// ==================== GLOSSARY ====================
// Workspace-agnostic learning resource. Static content, no DB.
const GLOSSARY = require('./data/glossary');
// Industry overlay packs — applied at workspace risk-clone time, surfaced as
// banner/notes on the workspace overview, and consumed by the SoA emphasis
// hint. See data/sector-overlays/ for the pattern.
const SECTOR_OVERLAYS = require('./data/sector-overlays');

// Set of valid iso_items.id values, computed once at boot. Used to decide
// whether a clause/Annex-A reference in glossary text resolves to a real
// page in the tool — only resolvable refs become clickable.
const ISO_ITEM_IDS = new Set(db.prepare('SELECT id FROM iso_items').all().map(r => r.id));

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Render a clauseRef string with recognised refs as <a> links. Caller passes
// the workspace ID to use as the link target. If wsId is missing, returns
// plain escaped text — refs are not clickable without a workspace.
function renderClauseRefHtml(text, wsId) {
  const escaped = escapeHtml(text);
  if (!text || !wsId) return escaped;
  let html = escaped;
  // Annex A — match A.X or A.X.Y. Longer match attempted first.
  html = html.replace(/A\.\d+(?:\.\d+)?/g, (m) => {
    const slug = 'annex-' + m.toLowerCase();
    if (ISO_ITEM_IDS.has(slug)) {
      return `<a href="/workspaces/${wsId}/controls/${slug}" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);">${m}</a>`;
    }
    return m;
  });
  // Clause refs — match "Clause(s) N[, N, …]" where each N is a dotted number
  // optionally followed by a sub-section letter. Resolves each number to the
  // longest existing clause-id prefix and wraps it in a link.
  function linkClauseToken(token) {
    // token might be "6.1.2" or "6.1.3.d.1". The slug uses only the digit prefix.
    const digitMatch = token.match(/^\d+(?:\.\d+){0,2}/);
    if (!digitMatch) return token;
    const parts = digitMatch[0].split('.');
    while (parts.length > 0) {
      const candidate = 'clause-' + parts.join('.');
      if (ISO_ITEM_IDS.has(candidate)) {
        return `<a href="/workspaces/${wsId}/controls/${candidate}" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);">${token}</a>`;
      }
      parts.pop();
    }
    return token;
  }
  html = html.replace(/(Clauses?\s+)(\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?(?:\s*,\s*\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?)*)/g,
    (whole, prefix, list) => prefix + list.replace(/\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?/g, linkClauseToken)
  );
  return html;
}

function firstWorkspaceIdFor(user) {
  const ws = listWorkspaces(user)[0];
  return ws ? ws.id : null;
}

app.get('/glossary', requireAuth, (req, res) => {
  const q = (req.query.q || '').toString();
  const category = (req.query.category || 'all').toString();
  const letter = (req.query.letter || 'all').toString();
  const results = GLOSSARY.searchEntries(q, category, letter)
    .slice()
    .sort((a, b) => a.term.localeCompare(b.term));
  // Letter buckets — only show letters that have entries (post-filter, so the bar reflects what's available).
  const letterCounts = {};
  for (const e of GLOSSARY.ENTRIES) {
    const first = /[A-Z]/.test(e.term[0]) ? e.term[0].toUpperCase() : '#';
    letterCounts[first] = (letterCounts[first] || 0) + 1;
  }
  // Category counts (across full corpus, ignoring search filter — so users see what's available).
  const categoryCounts = {};
  for (const e of GLOSSARY.ENTRIES) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
  const starter = GLOSSARY.STARTER_TERMS
    .map(slug => GLOSSARY.ENTRIES.find(e => e.slug === slug))
    .filter(Boolean);
  const linkWsId = firstWorkspaceIdFor(req.user);
  res.render('glossary', {
    user: req.user,
    ws: null,
    title: 'Glossary',
    active: 'glossary',
    q, category, letter,
    results,
    total: GLOSSARY.ENTRIES.length,
    letterCounts,
    categoryCounts,
    categories: GLOSSARY.CATEGORIES,
    starter,
    renderClauseRef: (t) => renderClauseRefHtml(t, linkWsId)
  });
});

app.get('/glossary/:slug', requireAuth, (req, res) => {
  const idx = GLOSSARY.indexBySlug();
  const entry = idx[req.params.slug];
  if (!entry) return res.status(404).render('error', { user: req.user, message: 'Glossary entry not found.' });
  const related = (entry.related || []).map(s => idx[s]).filter(Boolean);
  const categoryLabel = (GLOSSARY.CATEGORIES.find(c => c.key === entry.category) || {}).label || entry.category;
  const linkWsId = firstWorkspaceIdFor(req.user);
  res.render('glossary_detail', {
    user: req.user,
    ws: null,
    title: entry.term,
    active: 'glossary',
    entry,
    related,
    categoryLabel,
    categories: GLOSSARY.CATEGORIES,
    renderClauseRef: (t) => renderClauseRefHtml(t, linkWsId)
  });
});

// ==================== WORKSPACE CRUD ====================
app.get('/workspaces/new', requireAuth, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).render('error', { user: req.user, message: 'Only firm users can create workspaces.' });
  res.render('workspace_new', { user: req.user, ws: null });
});

app.post('/workspaces', requireAuth, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const { client_name, industry, scope, target_cert_date } = req.body;
  if (!client_name) return res.redirect('/dashboard');
  const id = db.prepare(`INSERT INTO workspaces (firm_id, client_name, industry, scope, target_cert_date, lead_consultant_id)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.user.firm_id, client_name.trim(), industry || null,
         scope || null, target_cert_date || null, req.user.id).lastInsertRowid;
  logAction(req.user.id, id, 'create_workspace', 'workspace', id, { client_name });
  // Redirect into the intake page rather than the workspace overview. The
  // overview is meaningful only once the engagement has real context;
  // intake is the obvious next step (scope sign-off, stakeholders, crown
  // jewels) and the page already shows progress + an "Apply to workspace"
  // button that backfills the scope statement and seeds interested parties.
  res.redirect(withToast('/workspaces/' + id + '/intake', 'Workspace created — start with the engagement intake'));
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

  // Implementation roadmap — extracted to a helper so the new /roadmap page
  // can share the same source of truth as the Overview dashboard.
  const roadmap = computeRoadmap(ws, { stateRows, assetCount, riskCount, ncOpen });
  // Tier B.6 — top "needs your attention" items for the overview
  const needsAttention = computeNeedsAttention(ws.id).slice(0, 8);
  // Industry overlay pack (if the workspace's sector has one). Surfaces a
  // banner with the overlay's notes; control-emphasis is consumed by the SoA
  // page directly via the same registry.
  const sectorOverlay = SECTOR_OVERLAYS.getOverlay(ws.sector);
  res.render('workspace', {
    user: req.user, ws, progress, breakdown, riskCount, openRisks,
    assetCount, evidenceCount, openTasks, actionItems,
    docCount, auditCount, mrmCount, ncOpen, recentActivity, readiness, sparkline,
    roadmap, needsAttention, sectorOverlay,
  });
});

// Implementation roadmap + needs-attention — moved out of the Overview page
// (which is now a pure dashboard). Same data, dedicated home.
app.get('/workspaces/:wsId/roadmap', requireAuth, requireWorkspace, (req, res) => {
  const ws = req.workspace;
  // Prepare the scalars computeRoadmap needs.
  const stateRows = db.prepare(`SELECT cs.iso_item_id, cs.status, i.type
    FROM control_states cs INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=?`).all(ws.id);
  const assetCount = db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id=?').get(ws.id).c;
  const riskCount = db.prepare('SELECT COUNT(*) c FROM risks WHERE workspace_id=?').get(ws.id).c;
  const ncOpen = db.prepare(`SELECT COUNT(*) AS c FROM nonconformities
    WHERE workspace_id = ? AND status NOT IN ('closed','verified')`).get(ws.id).c;
  const roadmap = computeRoadmap(ws, { stateRows, assetCount, riskCount, ncOpen });
  const needsAttention = computeNeedsAttention(ws.id).slice(0, 8);
  res.render('roadmap', {
    user: req.user, ws, title: 'Roadmap', active: 'roadmap',
    roadmap, needsAttention
  });
});

app.post('/workspaces/:wsId/update', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') {
    return res.status(403).send('Forbidden');
  }
  const {
    client_name, industry, scope, target_cert_date, stage, lead_consultant_id,
    brand_display_name, brand_primary_color, brand_logo_path, sector,
  } = req.body;
  // Validate brand color is a hex literal — anything else gets stored as null so
  // a malformed value can't break the page CSS.
  const safeColor = (typeof brand_primary_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(brand_primary_color.trim()))
    ? brand_primary_color.trim() : null;
  db.prepare(`UPDATE workspaces
              SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?,
                  brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?
              WHERE id=?`)
    .run(
      client_name, industry || null, scope || null, target_cert_date || null,
      stage || 'gap_assessment', lead_consultant_id || null,
      (brand_display_name || '').trim() || null,
      safeColor,
      (brand_logo_path || '').trim() || null,
      (sector || '').trim() || null,
      req.workspace.id
    );
  logAction(req.user.id, req.workspace.id, 'update_workspace', 'workspace', req.workspace.id, null);
  res.redirect('/workspaces/' + req.workspace.id);
});

// Destructive: delete a workspace (= one client engagement) and everything
// inside it — controls, risks, evidence rows + files on disk, audits, MRMs,
// gap passes, registers. Requires typing the client name to confirm.
app.post('/workspaces/:wsId/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const ws = req.workspace;
  const confirm = (req.body.confirm_name || '').trim();
  if (confirm !== ws.client_name) {
    return res.redirect(withToast('/workspaces/' + ws.id + '#workspace-settings',
      'Confirmation name did not match — nothing deleted', 'error'));
  }

  // Collect evidence file paths so we can wipe them off disk after the row delete.
  const evidenceFiles = db.prepare(`SELECT stored_path FROM evidence WHERE workspace_id=? AND stored_path IS NOT NULL`).all(ws.id);

  // Most workspace-scoped tables have ON DELETE CASCADE, but the schema has
  // grown over time and a few tables don't. Use the same dynamic-cleanup
  // pattern as tenant deletion so this stays correct as the schema evolves.
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      const wsTables = db.prepare(`
        SELECT m.name FROM sqlite_master m
        WHERE m.type='table'
        AND m.name != 'workspaces'
        AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='workspace_id')
      `).all().map(r => r.name);
      for (const t of wsTables) {
        db.prepare(`DELETE FROM ${t} WHERE workspace_id=?`).run(ws.id);
      }
      db.prepare('DELETE FROM workspaces WHERE id=?').run(ws.id);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // Best-effort filesystem cleanup. Files live in uploads/firm_{id}/ shared
  // across workspaces, so we have to delete by exact path rather than wiping
  // a directory.
  for (const e of evidenceFiles) {
    try {
      const abs = resolveUploadPath(e.stored_path, ws.firm_id);
      if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (_) {}
  }

  logAction(req.user.id, null, 'delete_workspace', 'workspace', ws.id, ws.client_name);
  res.redirect(withToast('/dashboard', `Client "${ws.client_name}" deleted`, 'success'));
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

// ==================== GUIDED GAP ASSESSMENT WIZARD ====================
// Walks ISO 27001:2022 main body clauses (4–10) AND Annex A controls one at a time,
// surfacing the existing iso_items prompts so a fresher has a structured path through
// all 118 items instead of staring at a table.

// Per-item diagnostic questions — bespoke for the 25 main-body clauses and high-impact
// controls; mechanical transformation of evidence_needed for the rest. See
// data/assessment-questions.js. Answers drive the suggested-status hint.
const { getQuestions: getAssessmentQuestions } = require('./data/assessment-questions');
function suggestStatusFromAnswers(answers, totalQuestions) {
  if (!answers || !totalQuestions) return null;
  const score = { yes: 1, partial: 0.5, no: 0 };
  const vals = [];
  for (let i = 0; i < totalQuestions; i++) {
    if (answers[String(i)] != null) vals.push(answers[String(i)]);
  }
  if (vals.length < totalQuestions) return null; // need all answered
  const ratio = vals.reduce((s, v) => s + (score[v] || 0), 0) / vals.length;
  if (ratio >= 0.85) return 'Implemented';
  if (ratio >= 0.5)  return 'Partially Implemented';
  if (ratio > 0)     return 'Work In Progress';
  return 'Not Implemented';
}

function nextUnassessedItem(wsId, afterSortOrder) {
  return db.prepare(`SELECT i.id FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND (cs.status IS NULL OR cs.status='Not Assessed')
      AND i.sort_order > ?
    ORDER BY i.sort_order LIMIT 1`).get(wsId, afterSortOrder || 0);
}

// Post-assessment summary — converts a completed gap walkthrough into a worklist:
// remediation tasks, missing documents, evidence asks, untreated linked risks.
app.get('/workspaces/:wsId/controls/assess/summary', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;

  // Gaps = anything Not Implemented / Partially Implemented / Work In Progress
  // (clauses + controls). Excludes Not Applicable and Not Assessed (those are different problems).
  // max_risk_score is the worst L*I across linked risks — used to bump priority for
  // Not-Implemented controls protecting high-impact risks.
  const gaps = db.prepare(`
    SELECT i.id, i.type, i.title, i.category, cs.status, cs.maturity, cs.notes,
      EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id=? AND t.iso_item_id=i.id AND t.status NOT IN ('done')) AS has_open_task,
      (SELECT MAX(r.likelihood * r.impact) FROM risk_controls rc
       INNER JOIN risks r ON r.id = rc.risk_id
       WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS max_risk_score
    FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    ORDER BY i.sort_order`).all(wsId, wsId, wsId);

  // Items still Not Assessed
  const notAssessedCount = db.prepare(`SELECT COUNT(*) c FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') AND (cs.status IS NULL OR cs.status='Not Assessed')`).get(wsId).c;

  // Items needing a policy/procedure: status not Implemented AND no document linked
  const docGaps = db.prepare(`
    SELECT i.id, i.type, i.title, cs.status FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
      AND NOT EXISTS (SELECT 1 FROM document_controls dc INNER JOIN generated_docs d ON d.id=dc.document_id
                      WHERE dc.iso_item_id=i.id AND d.workspace_id=?)
    ORDER BY i.sort_order`).all(wsId, wsId);

  // Items marked Implemented but with NO evidence files attached — auditor will press on these
  const evidenceAsks = db.prepare(`
    SELECT i.id, i.type, i.title FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') AND cs.status='Implemented'
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
    ORDER BY i.sort_order`).all(wsId, wsId);

  // Risks linked to gap-state controls (treatment plan needs updating)
  const untreatedLinkedRisks = db.prepare(`
    SELECT r.id, r.title, r.likelihood, r.impact, r.status,
      GROUP_CONCAT(DISTINCT i.id || '|' || cs.status) AS blocking_controls
    FROM risks r INNER JOIN risk_controls rc ON rc.risk_id=r.id
    INNER JOIN iso_items i ON i.id=rc.iso_item_id
    INNER JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE r.workspace_id=? AND r.status='open'
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    GROUP BY r.id, r.title, r.likelihood, r.impact, r.status
    ORDER BY (r.likelihood * r.impact) DESC`).all(wsId, wsId);

  // Status distribution for header
  const dist = { Implemented: 0, 'Partially Implemented': 0, 'Work In Progress': 0, 'Not Implemented': 0, 'Not Applicable': 0, 'Not Assessed': 0 };
  db.prepare(`SELECT COALESCE(cs.status,'Not Assessed') AS s, COUNT(*) AS c
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') GROUP BY s`).all(wsId).forEach(r => { dist[r.s] = r.c; });

  res.render('controls_assess_summary', {
    user: req.user, ws: req.workspace, gaps, docGaps, evidenceAsks, untreatedLinkedRisks,
    notAssessedCount, dist
  });
});

// Bulk-spawn remediation tasks for selected gap items.
// Priority is derived from the gap severity:
//   Not Implemented + clause           → critical (mandatory shall not met)
//   Not Implemented + control linked to high-risk → critical
//   Not Implemented (control)          → high
//   Partially Implemented              → normal
//   Work In Progress                   → low (already being worked)
app.post('/workspaces/:wsId/controls/assess/summary/spawn-tasks', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const ids = parseFormArray(req.body.iso_id);
  if (!ids.length) return redirectBack(req, res);
  const due = req.body.due_date || null;
  const ins = db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, due_date, status, priority, created_by)
                          VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`);
  let added = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const item = db.prepare(`SELECT i.id, i.type, i.title, cs.status, cs.notes,
        (SELECT MAX(r.likelihood * r.impact) FROM risk_controls rc
         INNER JOIN risks r ON r.id = rc.risk_id
         WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS max_risk_score
        FROM iso_items i
        LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
        WHERE i.id=?`).get(req.workspace.id, req.workspace.id, id);
      if (!item) continue;
      const cleanTitle = item.title.replace(/^A\.[0-9.]+ /,'').replace(/^[0-9.]+ /,'');
      const taskTitle = `Remediate ${item.id.replace('annex-','').replace('clause-','').toUpperCase()} — ${cleanTitle}`;
      let priority = 'normal';
      if (item.status === 'Not Implemented') {
        if (item.type === 'clause') priority = 'critical';
        else if ((item.max_risk_score || 0) >= 16) priority = 'critical';
        else priority = 'high';
      } else if (item.status === 'Partially Implemented') priority = 'normal';
      else if (item.status === 'Work In Progress') priority = 'low';
      ins.run(req.workspace.id, taskTitle, item.notes || `Close the gap identified in the gap assessment for ${item.title}.`, item.id, due, priority, req.user.id);
      added++;
    }
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'spawn_remediation_tasks', 'task', null, { count: added }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/controls/assess/summary`, `Spawned ${added} remediation task${added === 1 ? '' : 's'} with auto-priority`));
});

app.get('/workspaces/:wsId/controls/assess', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  // Optional ?start=clauses or ?start=controls to jump into a specific section.
  const start = req.query.start;
  if (start === 'clauses') {
    const c = db.prepare(`SELECT id FROM iso_items WHERE type='clause' ORDER BY sort_order LIMIT 1`).get();
    if (c) return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${c.id}`);
  }
  if (start === 'controls') {
    const c = db.prepare(`SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1`).get();
    if (c) return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${c.id}`);
  }
  const next = nextUnassessedItem(req.workspace.id, 0);
  if (next) return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${next.id}`);
  const first = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order LIMIT 1`).get();
  res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${first.id}?done=1`);
});

app.get('/workspaces/:wsId/controls/assess/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res, nextMw) => {
  // Reserved literal sub-routes — let them fall through to their own handlers
  // registered later in the file.
  if (['summary.docx'].includes(req.params.isoId)) return nextMw();
  const item = db.prepare(`SELECT * FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId);
  if (!item) return res.status(404).send('ISO item not found');
  item.questions = JSON.parse(item.questions || '[]');
  item.evidence_needed = JSON.parse(item.evidence_needed || '[]');
  item.documentation_needed = JSON.parse(item.documentation_needed || '[]');
  // Audit-grade content (data/iso-content.js → iso_items columns). Parsed once
  // here so the template doesn't have to know about JSON encoding.
  item.common_pitfalls = item.common_pitfalls ? JSON.parse(item.common_pitfalls) : null;
  item.evidence_to_look_for = item.evidence_to_look_for ? JSON.parse(item.evidence_to_look_for) : null;
  item.maturity_ladder = item.maturity_ladder ? JSON.parse(item.maturity_ladder) : null;
  item.related_items = item.related_items ? JSON.parse(item.related_items) : null;

  const state = getOrCreateState(req.workspace.id, item.id);

  // Two-section progress: clauses 4–10 (mandatory shalls) + Annex A controls.
  const totals = db.prepare(`SELECT
    (SELECT COUNT(*) FROM iso_items WHERE type='clause') AS clausesTotal,
    (SELECT COUNT(*) FROM iso_items WHERE type='control') AS controlsTotal,
    (SELECT COUNT(*) FROM iso_items i INNER JOIN control_states cs ON cs.iso_item_id=i.id
     WHERE i.type='clause' AND cs.workspace_id=? AND cs.status NOT IN ('Not Assessed')) AS clausesAssessed,
    (SELECT COUNT(*) FROM iso_items i INNER JOIN control_states cs ON cs.iso_item_id=i.id
     WHERE i.type='control' AND cs.workspace_id=? AND cs.status NOT IN ('Not Assessed')) AS controlsAssessed`).get(req.workspace.id, req.workspace.id);

  // Sequential nav across all clause+control items.
  const allOrder = db.prepare(`SELECT id, type FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order`).all();
  const position = allOrder.findIndex(r => r.id === item.id) + 1;
  const prevId = position > 1 ? allOrder[position - 2].id : null;
  const nextById = position < allOrder.length ? allOrder[position].id : null;

  // Position within own section (e.g., "Clause 5 of 25" or "Control 12 of 93")
  const sameType = allOrder.filter(r => r.type === item.type);
  const sectionPosition = sameType.findIndex(r => r.id === item.id) + 1;

  // Per-item diagnostic questions (bespoke or mechanically derived)
  const questions = getAssessmentQuestions(item);
  let savedAnswers = {};
  try { if (state.assessment_answers) savedAnswers = JSON.parse(state.assessment_answers) || {}; } catch (e) {}
  const suggestedStatus = suggestStatusFromAnswers(savedAnswers, questions.length);

  // Resolve related item ids → titles for cross-reference rendering
  let relatedRows = [];
  if (item.related_items && item.related_items.length) {
    const placeholders = item.related_items.map(() => '?').join(',');
    relatedRows = db.prepare(`SELECT id, type, title FROM iso_items WHERE id IN (${placeholders})`).all(...item.related_items);
  }

  // Evidence files attached to this control — displayed in a panel on the wizard
  // since the standalone control detail page was removed and there's no other home.
  // Evidence linked to this control via either the legacy primary
  // (evidence.iso_item_id) OR the new evidence_controls join. UNION + DISTINCT
  // because the primary is also seeded into the join, but a non-primary join
  // entry might exist independently.
  const evidenceList = db.prepare(`
    SELECT e.id, e.filename, e.size_bytes, e.description, e.uploaded_at,
           e.valid_from, e.valid_until, e.period_label, e.clause_section,
           u.name AS uploader,
           (SELECT COUNT(*) FROM evidence_controls ec WHERE ec.evidence_id = e.id) AS link_count
    FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
    WHERE e.workspace_id=? AND e.id IN (
      SELECT id FROM evidence WHERE workspace_id=? AND iso_item_id=?
      UNION
      SELECT evidence_id FROM evidence_controls WHERE iso_item_id=?
    )
    ORDER BY e.uploaded_at DESC`).all(req.workspace.id, req.workspace.id, item.id, item.id);

  // Linked risks, documents, and open NCs — read-only summary panels.
  const linkedRisks = db.prepare(`SELECT r.id, r.title, r.likelihood, r.impact, r.status
    FROM risks r INNER JOIN risk_controls rc ON rc.risk_id=r.id
    WHERE rc.iso_item_id=? AND r.workspace_id=?
    ORDER BY (r.likelihood * r.impact) DESC`).all(item.id, req.workspace.id);

  const linkedDocs = db.prepare(`SELECT d.id, d.name, d.category, d.status, dc.section_ref, dc.id AS link_id
    FROM document_controls dc INNER JOIN generated_docs d ON d.id=dc.document_id
    WHERE dc.iso_item_id=? AND d.workspace_id=? ORDER BY d.name`).all(item.id, req.workspace.id);
  // Workspace's documents that aren't already linked — the add-link dropdown.
  const linkableDocs = db.prepare(`SELECT id, name, category, status FROM generated_docs
    WHERE workspace_id=? AND id NOT IN (SELECT document_id FROM document_controls WHERE iso_item_id=?)
    ORDER BY name`).all(req.workspace.id, item.id);

  const openNCs = db.prepare(`SELECT id, title, severity, status, due_date FROM nonconformities
    WHERE iso_item_id=? AND workspace_id=? AND status NOT IN ('closed','verified')
    ORDER BY (CASE severity WHEN 'major' THEN 0 WHEN 'minor' THEN 1 ELSE 2 END), due_date IS NULL, due_date`).all(item.id, req.workspace.id);

  // Per-pass notes — derived from history. The current pass's textarea shows
  // ONLY notes saved within the active pass; prior-pass notes appear above as
  // read-only context blocks so the consultant can verify against earlier
  // commentary without overwriting it. This is the per-pass-notes contract:
  // each pass keeps its own free-text record, anchored to history.
  const activePass = getActivePass(req.workspace.id);
  let currentPassNotes = '';
  if (activePass) {
    const cur = db.prepare(`SELECT notes FROM control_state_history
      WHERE workspace_id=? AND iso_item_id=? AND pass_id=?
      ORDER BY snapshot_at DESC, id DESC LIMIT 1`).get(req.workspace.id, item.id, activePass.id);
    if (cur && cur.notes) currentPassNotes = cur.notes;
  }
  // Latest snapshot per prior pass (one row per pass that touched this item).
  // Excludes the active pass; ordered most recent prior pass first.
  const priorPassNotes = db.prepare(`
    SELECT p.pass_number, p.label, p.completed_at, p.status AS pass_status,
           h.notes, h.status AS item_status, h.maturity, h.snapshot_at
    FROM (
      SELECT MAX(id) AS max_id, pass_id
      FROM control_state_history
      WHERE workspace_id=? AND iso_item_id=? AND pass_id IS NOT NULL ${activePass ? 'AND pass_id != ?' : ''}
      GROUP BY pass_id
    ) latest
    INNER JOIN control_state_history h ON h.id = latest.max_id
    INNER JOIN assessment_passes p ON p.id = h.pass_id
    WHERE h.notes IS NOT NULL AND TRIM(h.notes) != ''
    ORDER BY p.pass_number DESC
  `).all(...(activePass ? [req.workspace.id, item.id, activePass.id] : [req.workspace.id, item.id]));

  res.render('controls_assess', {
    user: req.user, ws: req.workspace, item, state, totals, position, sectionPosition, relatedRows,
    prevId, nextId: nextById, doneFlag: !!req.query.done,
    questions, savedAnswers, suggestedStatus,
    evidenceList, linkedRisks, linkedDocs, openNCs, linkableDocs,
    activePass, currentPassNotes, priorPassNotes
  });
});

app.post('/workspaces/:wsId/controls/assess/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id, sort_order, type FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  getOrCreateState(req.workspace.id, item.id);

  const { applicability, status, maturity, inclusion_justification, exclusion_justification, notes, scope_pct } = req.body;
  const sets = [], vals = [];
  // Clauses are not subject to SoA applicability — every certified ISMS must satisfy them.
  if (item.type === 'control' && applicability !== undefined) { sets.push('applicability=?'); vals.push(applicability); }
  if (item.type === 'clause') { sets.push('applicability=?'); vals.push('included'); }
  if (status !== undefined) { sets.push('status=?'); vals.push(status); }
  if (maturity !== undefined && maturity !== '') { sets.push('maturity=?'); vals.push(parseInt(maturity)); }
  if (item.type === 'control' && inclusion_justification !== undefined) { sets.push('inclusion_justification=?'); vals.push(inclusion_justification || null); }
  if (item.type === 'control' && exclusion_justification !== undefined) { sets.push('exclusion_justification=?'); vals.push(exclusion_justification || null); }
  if (notes !== undefined) { sets.push('notes=?'); vals.push(notes || null); }
  if (scope_pct !== undefined) {
    const n = parseInt(scope_pct, 10);
    sets.push('scope_pct=?'); vals.push(Number.isFinite(n) && n >= 0 && n <= 100 ? n : null);
  }

  // Diagnostic answers — persist as JSON keyed by question index (questions vary per item).
  const answers = {};
  Object.keys(req.body).forEach(k => {
    const m = k.match(/^q_(\d+)$/);
    if (m && ['yes','partial','no'].includes(req.body[k])) answers[m[1]] = req.body[k];
  });
  if (Object.keys(answers).length) { sets.push('assessment_answers=?'); vals.push(JSON.stringify(answers)); }

  sets.push('last_updated=CURRENT_TIMESTAMP');
  // Stamp last_verified_at when the consultant explicitly assesses a control
  // (any save other than "Not Assessed"). This drives the staleness flagger:
  // controls that haven't been touched in 12+ months bubble up for re-assessment.
  if (status && status !== 'Not Assessed') {
    sets.push('last_verified_at=CURRENT_TIMESTAMP');
  }
  vals.push(req.workspace.id, item.id);
  db.prepare(`UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);

  // Append-only history snapshot — written after the UPDATE so it captures the new
  // values exactly. An auditor can later request the timeline for any control.
  const cur = db.prepare(`SELECT status, applicability, maturity, scope_pct,
    inclusion_justification, exclusion_justification, notes, assessment_answers
    FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
  if (cur) {
    // Tag the snapshot with the active pass (auto-creates Pass 1 lazily on
    // the very first wizard save in a fresh workspace, so passes always exist).
    const activePassId = ensureActivePassId(req.workspace.id, req.user.id);
    db.prepare(`INSERT INTO control_state_history (workspace_id, iso_item_id, changed_by,
      status, applicability, maturity, scope_pct, inclusion_justification, exclusion_justification, notes, assessment_answers, pass_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        req.workspace.id, item.id, req.user.id,
        cur.status, cur.applicability, cur.maturity, cur.scope_pct,
        cur.inclusion_justification, cur.exclusion_justification, cur.notes, cur.assessment_answers,
        activePassId
      );
  }
  logAction(req.user.id, req.workspace.id, 'gap_assess_item', item.type, item.id, { status, applicability }, auditCtx(req));

  const action = req.body.action || 'save';
  if (action === 'skip') {
    const allOrder = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order`).all();
    const idx = allOrder.findIndex(r => r.id === item.id);
    const next = idx >= 0 && idx < allOrder.length - 1 ? allOrder[idx + 1].id : null;
    return res.redirect(next
      ? `/workspaces/${req.workspace.id}/controls/assess/${next}`
      : `/workspaces/${req.workspace.id}/controls/assess?done=1`);
  }
  const nextU = nextUnassessedItem(req.workspace.id, item.sort_order);
  return res.redirect(nextU
    ? `/workspaces/${req.workspace.id}/controls/assess/${nextU.id}`
    : `/workspaces/${req.workspace.id}/controls/assess?done=1`);
});

// ==================== GAP ASSESSMENT (PASSES) ====================
// A "pass" is one round of consultant assessment. Pass 1 = initial gap
// assessment; Pass 2+ = re-assessments after the client has implemented
// some of the prior pass's recommendations. Every wizard save during an
// in-progress pass tags its history snapshot with that pass_id so we can
// diff state between any two passes.

function getActivePass(wsId) {
  return db.prepare(`SELECT * FROM assessment_passes
    WHERE workspace_id=? AND status='in_progress'
    ORDER BY pass_number DESC LIMIT 1`).get(wsId);
}

function ensureActivePassId(wsId, userId) {
  const active = getActivePass(wsId);
  if (active) return active.id;
  // Lazy auto-start Pass 1 on the very first wizard save.
  const lastNum = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n
    FROM assessment_passes WHERE workspace_id=?`).get(wsId).n;
  const nextNum = lastNum + 1;
  return db.prepare(`INSERT INTO assessment_passes
    (workspace_id, pass_number, label, status, started_by)
    VALUES (?, ?, ?, 'in_progress', ?)`)
    .run(wsId, nextNum, nextNum === 1 ? 'Initial gap assessment' : `Re-assessment ${nextNum - 1}`, userId).lastInsertRowid;
}

app.get('/workspaces/:wsId/gap-assessment', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  // All passes for this workspace, with per-pass save count derived from history.
  const passes = db.prepare(`
    SELECT p.*,
           u1.name AS started_by_name,
           u2.name AS completed_by_name,
           (SELECT COUNT(DISTINCT iso_item_id) FROM control_state_history WHERE pass_id = p.id) AS items_touched,
           (SELECT COUNT(*) FROM control_state_history WHERE pass_id = p.id) AS save_count
    FROM assessment_passes p
    LEFT JOIN users u1 ON u1.id = p.started_by
    LEFT JOIN users u2 ON u2.id = p.completed_by
    WHERE p.workspace_id = ?
    ORDER BY p.pass_number DESC
  `).all(wsId);

  const active = passes.find(p => p.status === 'in_progress') || null;

  // Total clauses + controls for progress denominator.
  const totalItems = db.prepare(`SELECT COUNT(*) c FROM iso_items WHERE type IN ('clause','control')`).get().c;
  const assessedNow = db.prepare(`SELECT COUNT(*) c FROM control_states
    WHERE workspace_id=? AND status != 'Not Assessed'`).get(wsId).c;

  // Find the next un-assessed item (continue button target).
  const nextItem = nextUnassessedItem(wsId, -1);

  // Re-engagement orientation — when a new pass is starting (or active),
  // surface what's changed since the prior pass closed: new evidence, new
  // NCs, controls touched, documents superseded, time elapsed.
  let orientation = null;
  const priorClosed = passes.find(p => p.status === 'completed');
  if (priorClosed && priorClosed.completed_at) {
    const since = priorClosed.completed_at;
    orientation = {
      priorPass: priorClosed,
      since,
      newEvidence: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND uploaded_at > ?`).get(wsId, since).c,
      newNCs: db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND created_at > ?`).get(wsId, since).c,
      newIncidents: db.prepare(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=? AND created_at > ?`).get(wsId, since).c,
      controlsTouched: db.prepare(`SELECT COUNT(DISTINCT iso_item_id) c FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id = h.pass_id
        WHERE h.workspace_id=? AND p.pass_number > ?`).get(wsId, priorClosed.pass_number).c,
      docsSuperseded: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND superseded_at IS NOT NULL AND superseded_at > ?`).get(wsId, since).c,
      docsApproved: db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') AND updated_at > ?`).get(wsId, since).c
    };
  }

  // Trend across passes — average maturity per Annex A theme per pass.
  // Theme = first segment of A.X.Y (X = 5/6/7/8 → Organizational/People/Physical/Technological).
  // For each pass, take the LATEST snapshot per item up to and including that
  // pass; group by theme; average maturity. Pass 0 = baseline (Not Assessed).
  const ANNEX_THEMES = { '5':'Organizational', '6':'People', '7':'Physical', '8':'Technological' };
  let trend = null;
  if (passes.length > 0) {
    const ascPasses = [...passes].sort((a,b) => a.pass_number - b.pass_number);
    const stmt = db.prepare(`
      SELECT h.iso_item_id, h.maturity, i.id AS code
      FROM (
        SELECT MAX(h2.id) AS max_id, h2.iso_item_id
        FROM control_state_history h2
        INNER JOIN assessment_passes p ON p.id = h2.pass_id
        WHERE h2.workspace_id = ? AND p.pass_number <= ? AND h2.maturity IS NOT NULL
        GROUP BY h2.iso_item_id
      ) latest
      INNER JOIN control_state_history h ON h.id = latest.max_id
      INNER JOIN iso_items i ON i.id = h.iso_item_id
      WHERE i.type='control'
    `);
    trend = ascPasses.map(p => {
      const rows = stmt.all(wsId, p.pass_number);
      const buckets = { '5': [], '6': [], '7': [], '8': [] };
      for (const r of rows) {
        const m = r.code.match(/^annex-a\.(\d)\./);
        if (m && buckets[m[1]]) buckets[m[1]].push(r.maturity);
      }
      const themes = {};
      for (const k of Object.keys(buckets)) {
        themes[k] = {
          name: ANNEX_THEMES[k],
          avg: buckets[k].length ? (buckets[k].reduce((a,b)=>a+b,0) / buckets[k].length) : null,
          count: buckets[k].length
        };
      }
      return { pass: p, themes };
    });
  }

  // Annex A heatmap — current coverage by theme.
  const themeRows = db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.maturity
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control'`).all(wsId);
  const heatmap = { '5':[], '6':[], '7':[], '8':[] };
  for (const r of themeRows) {
    const m = r.id.match(/^annex-a\.(\d)\./);
    if (m && heatmap[m[1]]) heatmap[m[1]].push(r);
  }

  res.render('gap_assessment', {
    user: req.user, ws: req.workspace,
    title: 'Gap assessment',
    active: 'gap-assessment',
    passes, activePass: active,
    totalItems, assessedNow,
    nextItem,
    orientation, trend, heatmap, themeNames: ANNEX_THEMES
  });
});

app.post('/workspaces/:wsId/gap-assessment/start', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;
  // If an active pass exists, complete it before starting a new one — only
  // one pass can be in_progress at a time.
  const active = getActivePass(wsId);
  if (active) {
    db.prepare(`UPDATE assessment_passes
      SET status='completed', completed_at=datetime('now'), completed_by=?
      WHERE id=?`).run(req.user.id, active.id);
  }
  const lastNum = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n
    FROM assessment_passes WHERE workspace_id=?`).get(wsId).n;
  const nextNum = lastNum + 1;
  const label = (req.body.label || '').toString().trim()
    || (nextNum === 1 ? 'Initial gap assessment' : `Re-assessment ${nextNum - 1}`);
  const notes = (req.body.notes || '').toString().trim() || null;
  const id = db.prepare(`INSERT INTO assessment_passes
    (workspace_id, pass_number, label, notes, status, started_by)
    VALUES (?, ?, ?, ?, 'in_progress', ?)`)
    .run(wsId, nextNum, label, notes, req.user.id).lastInsertRowid;
  logAction(req.user.id, wsId, 'start_assessment_pass', 'pass', id, { pass_number: nextNum, label });
  res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Started Pass ${nextNum}: ${label}`));
});

app.post('/workspaces/:wsId/gap-assessment/:passId/complete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;
  const p = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
  if (!p) return res.status(404).send('Not found');
  if (p.status === 'completed') return res.redirect(`/workspaces/${wsId}/gap-assessment`);
  db.prepare(`UPDATE assessment_passes
    SET status='completed', completed_at=datetime('now'), completed_by=?
    WHERE id=?`).run(req.user.id, p.id);
  logAction(req.user.id, wsId, 'complete_assessment_pass', 'pass', p.id, { pass_number: p.pass_number });
  res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Completed Pass ${p.pass_number}: ${p.label}`));
});

app.post('/workspaces/:wsId/gap-assessment/:passId/reopen', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;
  const p = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
  if (!p) return res.status(404).send('Not found');
  // Only one pass can be in_progress — close any other before reopening.
  const other = getActivePass(wsId);
  if (other && other.id !== p.id) {
    db.prepare(`UPDATE assessment_passes
      SET status='completed', completed_at=datetime('now'), completed_by=?
      WHERE id=?`).run(req.user.id, other.id);
  }
  db.prepare(`UPDATE assessment_passes SET status='in_progress', completed_at=NULL, completed_by=NULL WHERE id=?`).run(p.id);
  logAction(req.user.id, wsId, 'reopen_assessment_pass', 'pass', p.id, { pass_number: p.pass_number });
  res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Reopened Pass ${p.pass_number}`));
});

app.post('/workspaces/:wsId/gap-assessment/:passId/rename', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;
  const p = db.prepare(`SELECT id FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
  if (!p) return res.status(404).send('Not found');
  const label = (req.body.label || '').toString().trim() || null;
  const notes = (req.body.notes || '').toString().trim() || null;
  db.prepare(`UPDATE assessment_passes SET label=?, notes=? WHERE id=?`).run(label, notes, p.id);
  res.redirect(`/workspaces/${wsId}/gap-assessment`);
});

// Diff between two passes — for each control, show the state at the end of
// each pass and categorise the change. "End of pass N" = last history
// snapshot with pass_id=N (i.e. the value that was current when the pass
// was active). For the active pass we use the live control_states row.
app.get('/workspaces/:wsId/gap-assessment/diff', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const fromId = parseInt(req.query.from, 10);
  const toId = parseInt(req.query.to, 10);
  if (!Number.isFinite(fromId) || !Number.isFinite(toId) || fromId === toId) {
    return res.redirect(`/workspaces/${wsId}/gap-assessment`);
  }
  const passes = db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=? AND id IN (?,?)`).all(wsId, fromId, toId);
  if (passes.length !== 2) return res.redirect(`/workspaces/${wsId}/gap-assessment`);
  const passFrom = passes.find(p => p.id === fromId);
  const passTo = passes.find(p => p.id === toId);

  // Helper: end-of-pass state per item. Snapshots are written AFTER the
  // wizard UPDATE, so each row captures the new state at that save. For
  // any pass N, the "end of pass N" state for an item is the latest
  // snapshot whose pass_number is <= N (i.e. the most recent value the
  // item held by the time pass N concluded). If no snapshot exists up to
  // that point, the item was never assessed and is reported as such.
  function endOfPassState(passId) {
    const passRow = db.prepare(`SELECT pass_number FROM assessment_passes WHERE id=?`).get(passId);
    if (!passRow) return [];
    const passNumber = passRow.pass_number;
    const items = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control')`).all();
    const out = [];
    const stmt = db.prepare(`
      SELECT h.status, h.maturity, h.applicability, h.notes
      FROM control_state_history h
      INNER JOIN assessment_passes p ON p.id = h.pass_id
      WHERE h.workspace_id=? AND h.iso_item_id=? AND p.pass_number <= ?
      ORDER BY p.pass_number DESC, h.snapshot_at DESC, h.id DESC
      LIMIT 1
    `);
    for (const it of items) {
      const row = stmt.get(wsId, it.id, passNumber);
      if (row) out.push({ iso_item_id: it.id, ...row });
      else out.push({ iso_item_id: it.id, status: 'Not Assessed', maturity: null, applicability: 'undecided', notes: null });
    }
    return out;
  }

  const fromState = endOfPassState(fromId);
  const toState = endOfPassState(toId);
  const fromMap = {}; fromState.forEach(s => fromMap[s.iso_item_id] = s);
  const toMap = {};   toState.forEach(s => toMap[s.iso_item_id] = s);

  const items = db.prepare(`SELECT id, type, title FROM iso_items
    WHERE type IN ('clause','control') ORDER BY sort_order`).all();

  const STATUS_RANK = {
    'Not Assessed': 0, 'Not Implemented': 1, 'Work In Progress': 2,
    'Partially Implemented': 3, 'Implemented': 4, 'Not Applicable': 4
  };
  const rows = items.map(it => {
    const a = fromMap[it.id] || {};
    const b = toMap[it.id] || {};
    const sa = a.status || 'Not Assessed', sb = b.status || 'Not Assessed';
    const ma = a.maturity == null ? null : a.maturity;
    const mb = b.maturity == null ? null : b.maturity;
    let change = 'unchanged';
    if (sa !== sb) {
      change = (STATUS_RANK[sb] || 0) > (STATUS_RANK[sa] || 0) ? 'improved'
             : (STATUS_RANK[sb] || 0) < (STATUS_RANK[sa] || 0) ? 'regressed' : 'changed';
    } else if (ma !== mb) {
      change = (mb || 0) > (ma || 0) ? 'improved' : (mb || 0) < (ma || 0) ? 'regressed' : 'unchanged';
    }
    return { id: it.id, type: it.type, title: it.title, from: a, to: b, change };
  });

  const summary = {
    improved: rows.filter(r => r.change === 'improved').length,
    regressed: rows.filter(r => r.change === 'regressed').length,
    unchanged: rows.filter(r => r.change === 'unchanged').length,
    changed: rows.filter(r => r.change === 'changed').length
  };

  res.render('gap_assessment_diff', {
    user: req.user, ws: req.workspace,
    title: `Diff Pass ${passFrom.pass_number} → Pass ${passTo.pass_number}`,
    active: 'gap-assessment',
    passFrom, passTo, rows, summary
  });
});

// Append-only history of every wizard save for one item — what the auditor asks for.
app.get('/workspaces/:wsId/controls/:isoId/history', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const item = db.prepare(`SELECT id, type, title FROM iso_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  const rows = db.prepare(`SELECT h.*, u.name AS changed_by_name FROM control_state_history h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.workspace_id=? AND h.iso_item_id=?
    ORDER BY h.snapshot_at DESC LIMIT 200`).all(req.workspace.id, item.id);
  res.render('control_history', { user: req.user, ws: req.workspace, item, rows });
});

// The standalone control detail page was removed — the wizard now hosts
// evidence, linked risks, linked documents, NCs, and history alongside
// the audit-grade reference content and assessment form. Existing inbound
// links from SoA, risks, NCs, etc. continue to work via this redirect.
app.get('/workspaces/:wsId/controls/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
  // Reserved literal sub-routes — let them fall through.
  if (['kanban','export.csv','import','assess'].includes(req.params.isoId)) return nextMw();
  const item = db.prepare('SELECT id FROM iso_items WHERE id = ?').get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
});

// ==================== COMMENTS ====================
app.post('/workspaces/:wsId/comments', requireAuth, requireWorkspace, requirePermission('comment.create'), (req, res) => {
  const { parent_type, parent_id, body, internal_only } = req.body;
  if (!body || !parent_type || !parent_id) return redirectBack(req, res);
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
// Workspace-wide evidence library — every uploaded file with its links, owner,
// validity, and add/remove-link actions. Use this when a single artefact (e.g.
// a network diagram) evidences several controls and you don't want to walk into
// each control's wizard to attach.
app.get('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const filter = (req.query.filter || 'all').toString();
  const tag = (req.query.tag || '').toString().trim().toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const expSoon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  // Active (non-superseded) evidence only on the live view. Superseded rows
  // are still visible from the version-chain expander on each row.
  const allEvidence = db.prepare(`
    SELECT e.*,
           u.name AS uploader,
           (SELECT COUNT(*) FROM evidence_controls ec WHERE ec.evidence_id = e.id) AS link_count,
           sup.filename AS superseded_filename
    FROM evidence e
    LEFT JOIN users u ON u.id = e.uploaded_by
    LEFT JOIN evidence sup ON sup.id = e.supersedes_id
    WHERE e.workspace_id = ? AND e.superseded_at IS NULL
    ORDER BY e.uploaded_at DESC
  `).all(req.workspace.id);

  let evidenceList = allEvidence;
  if (filter === 'expired') {
    evidenceList = evidenceList.filter(e => e.valid_until && e.valid_until < today);
  } else if (filter === 'expiring') {
    evidenceList = evidenceList.filter(e => e.valid_until && e.valid_until >= today && e.valid_until < expSoon);
  } else if (filter === 'unlinked') {
    evidenceList = evidenceList.filter(e => (e.link_count || 0) === 0);
  }
  if (tag) {
    evidenceList = evidenceList.filter(e => (e.tags || '').toLowerCase().split(',').map(t => t.trim()).includes(tag));
  }
  if (q) {
    const lq = q.toLowerCase();
    evidenceList = evidenceList.filter(e =>
      (e.filename || '').toLowerCase().includes(lq) ||
      (e.description || '').toLowerCase().includes(lq) ||
      (e.period_label || '').toLowerCase().includes(lq) ||
      (e.uploader || '').toLowerCase().includes(lq) ||
      (e.tags || '').toLowerCase().includes(lq)
    );
  }

  // Linked controls for the visible rows.
  const linksByEvidence = {};
  if (evidenceList.length) {
    const ids = evidenceList.map(e => e.id);
    const placeholders = ids.map(() => '?').join(',');
    const links = db.prepare(`
      SELECT ec.id AS link_id, ec.evidence_id, ec.iso_item_id, ec.section_ref,
             i.title AS iso_title, i.type AS iso_type
      FROM evidence_controls ec
      INNER JOIN iso_items i ON i.id = ec.iso_item_id
      WHERE ec.evidence_id IN (${placeholders})
      ORDER BY i.sort_order ASC
    `).all(...ids);
    for (const l of links) {
      if (!linksByEvidence[l.evidence_id]) linksByEvidence[l.evidence_id] = [];
      linksByEvidence[l.evidence_id].push(l);
    }
  }

  // Aggregate counters across all *active* evidence (the filter pills).
  const counters = {
    total: allEvidence.length,
    expired: allEvidence.filter(e => e.valid_until && e.valid_until < today).length,
    expiring: allEvidence.filter(e => e.valid_until && e.valid_until >= today && e.valid_until < expSoon).length,
    unlinked: allEvidence.filter(e => (e.link_count || 0) === 0).length,
    superseded: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND superseded_at IS NOT NULL`).get(req.workspace.id).c
  };

  // Tag cloud — every distinct tag used in this workspace, with counts.
  const tagCounts = {};
  for (const e of allEvidence) {
    if (!e.tags) continue;
    for (const t of e.tags.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  const tagList = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const allIsoItems = db.prepare(`SELECT id, type, title FROM iso_items ORDER BY sort_order ASC`).all();

  res.render('evidence_library', {
    user: req.user, ws: req.workspace,
    title: 'Evidence library',
    active: 'evidence',
    evidenceList, linksByEvidence, counters,
    allIsoItems,
    q, filter, tag, today, expSoon,
    tagList
  });
});

// Helper: normalise comma-separated tags to lowercase, trimmed, deduped.
function normaliseTags(raw) {
  if (!raw) return '';
  return raw.split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i)
    .join(', ');
}

app.post('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, upload.single('file'), (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  if (!req.file) return redirectBack(req, res, 'Pick a file to upload', 'error');
  // Accept either a single iso_item_id (legacy: control wizard upload) OR
  // multiple iso_item_id values (new: evidence library multi-link upload).
  const isoIds = parseFormArray(req.body.iso_item_id);
  const primaryId = isoIds[0] || null;
  const { description, valid_from, valid_until, period_label, clause_section } = req.body;
  const tags = normaliseTags(req.body.tags);
  const buf = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');

  // Dedupe by SHA-256 within this workspace. If we've seen this exact bytes
  // before (and it isn't superseded), don't create a duplicate row — link the
  // existing file to the new control IDs and discard the new upload.
  const existing = db.prepare(`SELECT id, filename FROM evidence
    WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL
    ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
  if (existing) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    if (isoIds.length) {
      const ins = db.prepare(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)`);
      const tx = db.transaction(() => { for (const id of isoIds) ins.run(existing.id, id, clause_section || null); });
      try { tx(); } catch (_) {}
    }
    logAction(req.user.id, req.workspace.id, 'dedupe_evidence', 'evidence', existing.id, { sha, link_count: isoIds.length });
    const back = req.headers.referer || '/workspaces/' + req.workspace.id + '/evidence';
    return res.redirect(withToast(back, `Same file already exists (${existing.filename}) — linked instead of duplicated`));
  }

  const evId = db.prepare(`INSERT INTO evidence
    (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
     valid_from, valid_until, period_label, clause_section, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, primaryId, req.file.originalname, req.file.filename,
         sha, req.file.size, req.user.id, description || null,
         valid_from || null, valid_until || null, period_label || null, clause_section || null,
         tags || null).lastInsertRowid;
  if (isoIds.length) {
    const ins = db.prepare(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => { for (const id of isoIds) ins.run(evId, id, clause_section || null); });
    try { tx(); } catch (_) {}
  }
  logAction(req.user.id, req.workspace.id, 'upload_evidence', 'control', primaryId, { filename: req.file.originalname, link_count: isoIds.length });
  const back = req.headers.referer || '/workspaces/' + req.workspace.id;
  res.redirect(back);
});

// Bulk upload — multiple files at once with shared metadata. Each file becomes
// an independent evidence row; all share the same period / valid_from / valid_until
// and link to the same set of selected controls.
app.post('/workspaces/:wsId/evidence/bulk', requireAuth, requireWorkspace, upload.array('files', 50), (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  if (!req.files || !req.files.length) return redirectBack(req, res, 'Pick at least one file', 'error');
  const isoIds = parseFormArray(req.body.iso_item_id);
  const primaryId = isoIds[0] || null;
  const { description, valid_from, valid_until, period_label } = req.body;
  const tags = normaliseTags(req.body.tags);
  let created = 0, deduped = 0;
  for (const f of req.files) {
    const buf = fs.readFileSync(f.path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const existing = db.prepare(`SELECT id FROM evidence
      WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
    if (existing) {
      try { fs.unlinkSync(f.path); } catch (_) {}
      if (isoIds.length) {
        const ins = db.prepare(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)`);
        const tx = db.transaction(() => { for (const id of isoIds) ins.run(existing.id, id, null); });
        try { tx(); } catch (_) {}
      }
      deduped++;
      continue;
    }
    const evId = db.prepare(`INSERT INTO evidence
      (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
       valid_from, valid_until, period_label, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.workspace.id, primaryId, f.originalname, f.filename, sha, f.size, req.user.id,
           description || null, valid_from || null, valid_until || null, period_label || null,
           tags || null).lastInsertRowid;
    if (isoIds.length) {
      const ins = db.prepare(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)`);
      const tx = db.transaction(() => { for (const id of isoIds) ins.run(evId, id, null); });
      try { tx(); } catch (_) {}
    }
    created++;
  }
  logAction(req.user.id, req.workspace.id, 'bulk_upload_evidence', 'workspace', req.workspace.id, { created, deduped, link_count: isoIds.length });
  const msg = `Uploaded ${created} file${created === 1 ? '' : 's'}` + (deduped ? ` · ${deduped} re-linked (already existed)` : '');
  res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, msg));
});

// Supersede an existing evidence file with a new version. Old row is kept
// for audit trail (superseded_at + superseded_by_id), all links are copied
// to the new row, and the new row records its predecessor in supersedes_id.
app.post('/workspaces/:wsId/evidence/:id/supersede', requireAuth, requireWorkspace, upload.single('file'), (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const old = db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!old) return res.status(404).send('Not found');
  if (!req.file) return redirectBack(req, res, 'Pick the new version of the file', 'error');
  const buf = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha === old.sha256) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, 'New file is identical to the existing version — nothing to supersede', 'info'));
  }
  const { description, valid_from, valid_until, period_label } = req.body;
  const tags = normaliseTags(req.body.tags) || old.tags || null;
  const newId = db.prepare(`INSERT INTO evidence
    (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description,
     valid_from, valid_until, period_label, clause_section, supersedes_id, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, old.iso_item_id, req.file.originalname, req.file.filename, sha, req.file.size,
         req.user.id, description || old.description || null,
         valid_from || null, valid_until || null, period_label || null, old.clause_section || null,
         old.id, tags).lastInsertRowid;
  // Copy links from old to new.
  const oldLinks = db.prepare(`SELECT iso_item_id, section_ref FROM evidence_controls WHERE evidence_id=?`).all(old.id);
  if (oldLinks.length) {
    const ins = db.prepare(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => { for (const l of oldLinks) ins.run(newId, l.iso_item_id, l.section_ref); });
    try { tx(); } catch (_) {}
  }
  // Mark old as superseded — kept for audit trail but hidden from active view.
  db.prepare(`UPDATE evidence SET superseded_at=datetime('now'), superseded_by_id=? WHERE id=?`).run(newId, old.id);
  logAction(req.user.id, req.workspace.id, 'supersede_evidence', 'evidence', old.id, { new_id: newId, filename: req.file.originalname });
  res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, `Superseded ${old.filename} → ${req.file.originalname}`));
});

// Auditor evidence-pack export — single ZIP of every active (non-superseded)
// evidence file in the workspace, plus a manifest CSV describing each one.
app.get('/workspaces/:wsId/evidence/pack.zip', requireAuth, requireWorkspace, (req, res) => {
  const dateFrom = (req.query.from || '').toString();
  const dateTo = (req.query.to || '').toString();
  let where = 'e.workspace_id = ? AND e.superseded_at IS NULL';
  const params = [req.workspace.id];
  if (dateFrom) { where += ' AND date(e.uploaded_at) >= date(?)'; params.push(dateFrom); }
  if (dateTo)   { where += ' AND date(e.uploaded_at) <= date(?)'; params.push(dateTo); }
  const items = db.prepare(`SELECT e.*, u.name AS uploader,
    (SELECT GROUP_CONCAT(iso_item_id, '; ') FROM evidence_controls WHERE evidence_id=e.id) AS linked_controls
    FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
    WHERE ${where} ORDER BY e.uploaded_at ASC`).all(...params);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="evidence-pack-${req.workspace.id}-${new Date().toISOString().slice(0,10)}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { try { res.status(500).send(String(err)); } catch (_) {} });
  archive.pipe(res);

  // Manifest CSV
  const csvLines = [
    'evidence_id,filename,sha256,size_bytes,uploader,uploaded_at,period,valid_from,valid_until,linked_controls,tags,description'
  ];
  function csvEsc(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  for (const e of items) {
    csvLines.push([
      e.id, csvEsc(e.filename), e.sha256, e.size_bytes, csvEsc(e.uploader),
      e.uploaded_at ? e.uploaded_at.slice(0, 19) : '',
      csvEsc(e.period_label), e.valid_from || '', e.valid_until || '',
      csvEsc(e.linked_controls), csvEsc(e.tags), csvEsc(e.description)
    ].join(','));
  }
  archive.append(csvLines.join('\n'), { name: 'MANIFEST.csv' });

  // README
  archive.append(
`Evidence pack — workspace ${req.workspace.client_name || req.workspace.id}
Generated: ${new Date().toISOString()}
Files: ${items.length}
Date range: ${dateFrom || 'all'} → ${dateTo || 'all'}

MANIFEST.csv lists every file in this pack with its SHA-256, linked controls,
period, validity, and uploader. The /files/ directory contains the actual
artefacts. SHA-256 lets you verify nothing was tampered with after export.
`,
    { name: 'README.txt' }
  );

  // Files — resolve via the partitioned-or-legacy resolver shared with /download.
  for (const e of items) {
    const found = resolveUploadPath(e.stored_path, req.workspace.firm_id);
    if (found && fs.existsSync(found) && fs.statSync(found).isFile()) {
      archive.file(found, { name: `files/${e.id}-${e.filename}` });
    }
  }
  archive.finalize();
});

// Tier A.1 — Add/remove additional control links on an evidence file.
// section_ref may be either a single shared value (form: section_ref=...) or
// per-link via a parallel array section_ref_for_<isoId>=... — the latter wins.
app.post('/workspaces/:wsId/evidence/:id/controls', requireAuth, requireWorkspace, (req, res) => {
  const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const ids = parseFormArray(req.body.iso_item_id);
  if (!ids.length) return redirectBack(req, res);
  const sharedSectionRef = req.body.section_ref || null;
  const ins = db.prepare(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id, section_ref) VALUES (?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const id of ids) {
      const perLinkKey = 'section_ref_for_' + id.replace(/[^a-z0-9.-]/gi, '_');
      const ref = (req.body[perLinkKey] || sharedSectionRef || null);
      ins.run(ev.id, id, ref);
    }
  });
  try { tx(); } catch (_) {}
  logAction(req.user.id, req.workspace.id, 'link_evidence_control', 'evidence', ev.id, { ids, count: ids.length }, auditCtx(req));
  redirectBack(req, res);
});

// Update the section_ref on an existing link (per-link, distinct from the
// per-file clause_section). Posted from the chip on the library row.
app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/section', requireAuth, requireWorkspace, (req, res) => {
  const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const newRef = (req.body.section_ref || '').toString().trim() || null;
  db.prepare(`UPDATE evidence_controls SET section_ref=? WHERE id=? AND evidence_id=?`)
    .run(newRef, req.params.linkId, ev.id);
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/delete', requireAuth, requireWorkspace, (req, res) => {
  const ev = db.prepare(`SELECT id, iso_item_id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const link = db.prepare(`SELECT * FROM evidence_controls WHERE id=? AND evidence_id=?`).get(req.params.linkId, ev.id);
  if (link) {
    db.prepare(`DELETE FROM evidence_controls WHERE id=?`).run(link.id);
    // If the deleted link was the primary, also clear evidence.iso_item_id
    // so the legacy column doesn't drift back into existence on next render.
    if (ev.iso_item_id === link.iso_item_id) {
      db.prepare(`UPDATE evidence SET iso_item_id=NULL WHERE id=?`).run(ev.id);
    }
  }
  redirectBack(req, res);
});

app.get('/workspaces/:wsId/evidence/:id/download', requireAuth, requireWorkspace, (req, res) => {
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
  res.download(fp, ev.filename);
});

app.post('/workspaces/:wsId/evidence/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (ev) {
    const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
    if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    db.prepare('DELETE FROM evidence WHERE id = ?').run(ev.id);
    logAction(req.user.id, req.workspace.id, 'delete_evidence', 'evidence', ev.id, null);
  }
  redirectBack(req, res);
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
  const { name, type, classification, owner_name, cia_c, cia_i, cia_a, description,
          business_criticality, rto_hours, rpo_hours, bia_notes } = req.body;
  if (!name) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO assets
    (workspace_id, name, type, classification, owner_name, cia_c, cia_i, cia_a, description,
     business_criticality, rto_hours, rpo_hours, bia_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, name.trim(), type || null, classification || null, owner_name || null,
         parseInt(cia_c) || 1, parseInt(cia_i) || 1, parseInt(cia_a) || 1, description || null,
         business_criticality || null,
         rto_hours !== undefined && rto_hours !== '' ? parseInt(rto_hours, 10) : null,
         rpo_hours !== undefined && rpo_hours !== '' ? parseInt(rpo_hours, 10) : null,
         bia_notes || null).lastInsertRowid;
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
  if (!title) return redirectBack(req, res);
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

// ==================== STARTER RISK LIBRARY ====================
// Pre-written common ISO 27001 risks grouped by domain so a fresher can pick relevant
// ones rather than starting from a blank form. Selected risks are bulk-inserted with
// their suggested control links populated automatically.
const RISK_LIBRARY = require('./data/risk-library');

app.get('/workspaces/:wsId/risks/library', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res, nextMw) => {
  // Group by domain
  const byDomain = {};
  RISK_LIBRARY.forEach((r, idx) => { (byDomain[r.domain] = byDomain[r.domain] || []).push({ ...r, idx }); });
  res.render('risks_library', { user: req.user, ws: req.workspace, byDomain });
});

app.post('/workspaces/:wsId/risks/library', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const picked = parseFormArray(req.body.pick);
  if (!picked.length) return redirectBack(req, res);
  const ins = db.prepare(`INSERT INTO risks (workspace_id, entity_id, title, description, threat, vulnerability,
                         likelihood, impact, treatment, status)
                         VALUES (?, ?, ?, ?, ?, ?, 3, 3, 'modify', 'open')`);
  const linkCtrl = db.prepare(`INSERT OR IGNORE INTO risk_controls (risk_id, iso_item_id) VALUES (?, ?)`);
  let added = 0;
  const tx = db.transaction(() => {
    picked.forEach(idxStr => {
      const r = RISK_LIBRARY[parseInt(idxStr)];
      if (!r) return;
      const rid = ins.run(req.workspace.id, req.entityScopeId || null, r.title, r.description, r.threat || null, r.vulnerability || null).lastInsertRowid;
      (r.suggested_controls || []).forEach(c => linkCtrl.run(rid, c));
      added++;
    });
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'add_risks_from_library', 'risk', null, { count: added }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/risks', `Added ${added} risk${added === 1 ? '' : 's'} from library — review and adjust scoring`));
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
  // Tier 1.1 — treatment plan actions for this risk
  const actions = db.prepare(`SELECT * FROM risk_treatment_actions
    WHERE risk_id=? AND workspace_id=?
    ORDER BY (CASE status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`).all(risk.id, req.workspace.id);
  // Tier A.2 — risk acceptance state
  const activeAcceptance = db.prepare(`SELECT * FROM risk_acceptances
    WHERE risk_id=? AND revoked_at IS NULL ORDER BY signed_at DESC LIMIT 1`).get(risk.id);
  res.render('risk_detail', { user: req.user, ws: req.workspace, risk, linked, allControls, assets, methodology, inherentBand, residualBand, actions, activeAcceptance });
});

// Tier 1.1 — Risk treatment plan actions (clause 6.1.3 audit-defensible workflow)
app.post('/workspaces/:wsId/risks/:id/actions', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const { title, description, owner_name, due_date } = req.body;
  if (!title || !title.trim()) return redirectBack(req, res);
  db.prepare(`INSERT INTO risk_treatment_actions
    (workspace_id, risk_id, title, description, owner_name, due_date, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)`).run(
    req.workspace.id, req.params.id, title.trim(), description || null,
    owner_name || null, due_date || null, req.user.id
  );
  logAction(req.user.id, req.workspace.id, 'add_treatment_action', 'risk', req.params.id, { title }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
});

app.post('/workspaces/:wsId/risks/:id/actions/:aid', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const { title, description, owner_name, due_date, status, residual_likelihood, residual_impact } = req.body;
  const closedAt = status === 'done' ? `CURRENT_TIMESTAMP` : 'NULL';
  db.prepare(`UPDATE risk_treatment_actions SET
    title=COALESCE(?, title), description=?, owner_name=?, due_date=?, status=?,
    residual_likelihood=?, residual_impact=?,
    closed_at=CASE WHEN ?='done' AND closed_at IS NULL THEN CURRENT_TIMESTAMP ELSE closed_at END
    WHERE id=? AND risk_id=? AND workspace_id=?`).run(
    title || null, description || null, owner_name || null, due_date || null, status || 'planned',
    residual_likelihood ? parseInt(residual_likelihood) : null,
    residual_impact ? parseInt(residual_impact) : null,
    status, req.params.aid, req.params.id, req.workspace.id
  );
  // If status is 'done' and residuals are filled, propagate to the parent risk's residual fields.
  if (status === 'done' && residual_likelihood && residual_impact) {
    db.prepare(`UPDATE risks SET residual_likelihood=?, residual_impact=? WHERE id=? AND workspace_id=?`)
      .run(parseInt(residual_likelihood), parseInt(residual_impact), req.params.id, req.workspace.id);
  }
  logAction(req.user.id, req.workspace.id, 'update_treatment_action', 'risk', req.params.id, { action_id: req.params.aid, status }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
});

app.post('/workspaces/:wsId/risks/:id/actions/:aid/delete', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  db.prepare(`DELETE FROM risk_treatment_actions WHERE id=? AND risk_id=? AND workspace_id=?`)
    .run(req.params.aid, req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}`);
});

// ==================== TIER 1.3 — CERT CYCLE CALENDAR ====================
// Stage 1 → Stage 2 → annual surveillance → 3-year recertification.
// Most consultants miss the post-cert lifecycle; this surfaces it.
const CERT_EVENT_TYPES = [
  { key: 'stage_1', label: 'Stage 1 audit', desc: 'Documentation review' },
  { key: 'stage_2', label: 'Stage 2 audit', desc: 'Implementation audit (cert decision)' },
  { key: 'surveillance_y1', label: 'Surveillance audit (Year 1)', desc: 'First annual surveillance' },
  { key: 'surveillance_y2', label: 'Surveillance audit (Year 2)', desc: 'Second annual surveillance' },
  { key: 'recertification', label: 'Recertification audit', desc: 'Full cycle reset (Year 3)' }
];

app.get('/workspaces/:wsId/cert-cycle', requireAuth, requireWorkspace, (req, res) => {
  const events = db.prepare(`SELECT * FROM cert_cycle_events
    WHERE workspace_id=? ORDER BY planned_date IS NULL, planned_date`).all(req.workspace.id);
  // Auto-suggest a default cycle if no events exist yet — Stage 1 in 60 days,
  // Stage 2 30 days after, surveillance year 1 = 12 months from Stage 2, etc.
  const today = new Date();
  const suggestions = events.length ? [] : (() => {
    const s1 = new Date(today); s1.setDate(s1.getDate() + 60);
    const s2 = new Date(s1); s2.setDate(s2.getDate() + 30);
    const sy1 = new Date(s2); sy1.setFullYear(sy1.getFullYear() + 1);
    const sy2 = new Date(sy1); sy2.setFullYear(sy2.getFullYear() + 1);
    const recert = new Date(s2); recert.setFullYear(recert.getFullYear() + 3);
    return [
      { event_type: 'stage_1',          planned_date: s1.toISOString().slice(0,10) },
      { event_type: 'stage_2',          planned_date: s2.toISOString().slice(0,10) },
      { event_type: 'surveillance_y1',  planned_date: sy1.toISOString().slice(0,10) },
      { event_type: 'surveillance_y2',  planned_date: sy2.toISOString().slice(0,10) },
      { event_type: 'recertification',  planned_date: recert.toISOString().slice(0,10) }
    ];
  })();
  res.render('cert_cycle', { user: req.user, ws: req.workspace, events, suggestions, eventTypes: CERT_EVENT_TYPES });
});

app.post('/workspaces/:wsId/cert-cycle', requireAuth, requireWorkspace, (req, res) => {
  const { event_type, planned_date, certification_body, notes } = req.body;
  if (!event_type || !CERT_EVENT_TYPES.find(t => t.key === event_type)) return redirectBack(req, res);
  db.prepare(`INSERT INTO cert_cycle_events (workspace_id, event_type, planned_date, certification_body, notes)
              VALUES (?, ?, ?, ?, ?)`).run(
    req.workspace.id, event_type, planned_date || null, certification_body || null, notes || null
  );
  logAction(req.user.id, req.workspace.id, 'add_cert_event', 'cert_cycle', null, { event_type, planned_date }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
});

app.post('/workspaces/:wsId/cert-cycle/seed', requireAuth, requireWorkspace, (req, res) => {
  // Insert all five suggested events from the no-events fallback above.
  const today = new Date();
  const s1 = new Date(today); s1.setDate(s1.getDate() + 60);
  const s2 = new Date(s1); s2.setDate(s2.getDate() + 30);
  const sy1 = new Date(s2); sy1.setFullYear(sy1.getFullYear() + 1);
  const sy2 = new Date(sy1); sy2.setFullYear(sy2.getFullYear() + 1);
  const recert = new Date(s2); recert.setFullYear(recert.getFullYear() + 3);
  const ins = db.prepare(`INSERT INTO cert_cycle_events (workspace_id, event_type, planned_date) VALUES (?, ?, ?)`);
  const tx = db.transaction(() => {
    ins.run(req.workspace.id, 'stage_1',          s1.toISOString().slice(0,10));
    ins.run(req.workspace.id, 'stage_2',          s2.toISOString().slice(0,10));
    ins.run(req.workspace.id, 'surveillance_y1',  sy1.toISOString().slice(0,10));
    ins.run(req.workspace.id, 'surveillance_y2',  sy2.toISOString().slice(0,10));
    ins.run(req.workspace.id, 'recertification',  recert.toISOString().slice(0,10));
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'seed_cert_cycle', 'cert_cycle', null, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
});

app.post('/workspaces/:wsId/cert-cycle/:id', requireAuth, requireWorkspace, (req, res) => {
  const { planned_date, actual_date, status, certification_body, notes } = req.body;
  db.prepare(`UPDATE cert_cycle_events SET
    planned_date=?, actual_date=?, status=?, certification_body=?, notes=?
    WHERE id=? AND workspace_id=?`).run(
    planned_date || null, actual_date || null, status || 'planned',
    certification_body || null, notes || null,
    req.params.id, req.workspace.id
  );
  res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
});

app.post('/workspaces/:wsId/cert-cycle/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM cert_cycle_events WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
});

// ==================== TIER 2.7 — GAP ASSESSMENT REPORT (DOCX) ====================
// Renders the post-assessment summary as a downloadable DOCX. Replaces the
// 2–4 hours of manual report-writing per gap assessment.
app.get('/workspaces/:wsId/controls/assess/summary.docx', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
  const wsId = req.workspace.id;

  const dist = { Implemented: 0, 'Partially Implemented': 0, 'Work In Progress': 0, 'Not Implemented': 0, 'Not Applicable': 0, 'Not Assessed': 0 };
  db.prepare(`SELECT COALESCE(cs.status,'Not Assessed') AS s, COUNT(*) AS c FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') GROUP BY s`).all(wsId).forEach(r => { dist[r.s] = r.c; });
  const total = Object.values(dist).reduce((a,b) => a+b, 0);

  const gaps = db.prepare(`SELECT i.id, i.type, i.title, cs.status, cs.maturity, cs.scope_pct, cs.notes
    FROM iso_items i INNER JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    ORDER BY i.sort_order`).all(wsId);

  const evidenceAsks = db.prepare(`SELECT i.id, i.title FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') AND cs.status='Implemented'
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
    ORDER BY i.sort_order`).all(wsId, wsId);

  const today = new Date().toISOString().slice(0,10);
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const refCode = id => id.replace('annex-','').replace('clause-','').toUpperCase();

  const sevColor = (status) => status === 'Not Implemented' ? '#b91c1c' : status === 'Partially Implemented' ? '#a16207' : '#ea580c';

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #111; }
    h1 { font-size: 22pt; margin-bottom: 4pt; }
    h2 { font-size: 14pt; margin-top: 20pt; margin-bottom: 6pt; border-bottom: 1pt solid #ccc; padding-bottom: 4pt; }
    h3 { font-size: 12pt; margin-top: 14pt; margin-bottom: 4pt; }
    table { border-collapse: collapse; width: 100%; margin-top: 8pt; font-size: 10pt; }
    th, td { border: 1pt solid #ccc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-weight: bold; }
    .meta { color: #666; font-size: 10pt; }
    .tag { font-size: 9pt; font-weight: bold; padding: 1pt 6pt; color: white; }
  </style></head><body>`;

  html += `<h1>Gap Assessment Report</h1>`;
  html += `<p class="meta"><strong>${esc(req.workspace.client_name)}</strong> · Generated ${today}</p>`;

  html += `<h2>1. Executive summary</h2>`;
  html += `<p>This report summarises the current-state gap assessment of the Information Security Management System (ISMS) against ISO 27001:2022. The assessment covered ${total} items: ${dist.Implemented} fully implemented, ${dist['Partially Implemented']} partially implemented, ${dist['Work In Progress']} in progress, ${dist['Not Implemented']} not yet implemented, ${dist['Not Applicable']} not applicable, ${dist['Not Assessed']} not yet assessed.</p>`;

  html += `<h2>2. Status distribution</h2>`;
  html += `<table><tr><th>Status</th><th>Count</th><th>% of total</th></tr>`;
  ['Implemented','Partially Implemented','Work In Progress','Not Implemented','Not Applicable','Not Assessed'].forEach(s => {
    const c = dist[s] || 0;
    const pct = total ? Math.round(c / total * 100) : 0;
    html += `<tr><td>${esc(s)}</td><td>${c}</td><td>${pct}%</td></tr>`;
  });
  html += `</table>`;

  html += `<h2>3. Identified gaps (${gaps.length})</h2>`;
  if (gaps.length === 0) {
    html += `<p>No gaps in Not Implemented / Partially Implemented / Work In Progress state.</p>`;
  } else {
    html += `<table><tr><th>ID</th><th>Title</th><th>Status</th><th>Maturity</th><th>Scope %</th><th>Notes</th></tr>`;
    gaps.forEach(g => {
      const cleanTitle = g.title.replace(/^A\.[0-9.]+ /,'').replace(/^[0-9.]+ /,'');
      html += `<tr><td>${esc(refCode(g.id))}</td><td>${esc(cleanTitle)}</td><td><span class="tag" style="background:${sevColor(g.status)}">${esc(g.status)}</span></td><td>${g.maturity != null ? g.maturity : '—'}</td><td>${g.scope_pct != null ? g.scope_pct + '%' : '—'}</td><td>${esc(g.notes || '')}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `<h2>4. Items marked Implemented without evidence (${evidenceAsks.length})</h2>`;
  if (evidenceAsks.length === 0) {
    html += `<p>Every Implemented item has at least one evidence file attached.</p>`;
  } else {
    html += `<p>The following items are marked as Implemented in the assessment but have no evidence file attached. Auditors will sample these first.</p>`;
    html += `<table><tr><th>ID</th><th>Title</th></tr>`;
    evidenceAsks.forEach(e => {
      const cleanTitle = e.title.replace(/^A\.[0-9.]+ /,'').replace(/^[0-9.]+ /,'');
      html += `<tr><td>${esc(refCode(e.id))}</td><td>${esc(cleanTitle)}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `<h2>5. Recommended next steps</h2>`;
  html += `<ol>`;
  if (dist['Not Assessed'] > 0) html += `<li>Complete the gap assessment for the ${dist['Not Assessed']} item(s) still in Not Assessed state.</li>`;
  if (gaps.filter(g => g.status === 'Not Implemented').length > 0) html += `<li>Prioritise remediation of the ${gaps.filter(g => g.status === 'Not Implemented').length} Not Implemented gap(s); these block certification.</li>`;
  if (evidenceAsks.length > 0) html += `<li>Attach evidence to the ${evidenceAsks.length} Implemented item(s) currently lacking it.</li>`;
  html += `<li>Convert this report into remediation tasks via the post-assessment summary's Spawn-tasks action.</li>`;
  html += `<li>Schedule a follow-up gap assessment to verify remediation effectiveness before the Stage 1 audit.</li>`;
  html += `</ol>`;

  html += `</body></html>`;

  const buf = await htmlToDocx(html, null, { table: { row: { cantSplit: true } } });
  const filename = `Gap-Assessment-Report-${req.workspace.client_name.replace(/[^\w]/g,'_')}-${today}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
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
  // Ensure every Annex A control has a control_states row so subsequent SoA
  // POSTs and bulk operations can UPDATE without silent no-ops. Idempotent.
  db.prepare(`INSERT OR IGNORE INTO control_states (workspace_id, iso_item_id)
              SELECT ?, id FROM iso_items WHERE type='control'`).run(req.workspace.id);

  const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.inclusion_justification, cs.exclusion_justification,
      cs.last_verified_at,
      (SELECT COUNT(*) FROM risk_controls rc INNER JOIN risks r ON r.id = rc.risk_id
       WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS risk_count,
      (SELECT COUNT(*) FROM evidence e WHERE e.iso_item_id = i.id AND e.workspace_id = ?) AS evidence_count,
      (SELECT COUNT(*) FROM nonconformities n WHERE n.iso_item_id = i.id AND n.workspace_id = ? AND n.status != 'closed') AS open_nc_count,
      (SELECT COUNT(*) FROM nonconformities n WHERE n.iso_item_id = i.id AND n.workspace_id = ?
        AND n.created_at > datetime('now','-12 months')) AS systemic_count
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control'
      ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id);

  // Phase A: linked documents per control (only docs in this workspace)
  const docLinks = db.prepare(`
    SELECT dc.iso_item_id, dc.section_ref, d.id AS doc_id, d.name AS doc_name, d.status AS doc_status, d.category
    FROM document_controls dc
    INNER JOIN generated_docs d ON d.id = dc.document_id
    WHERE d.workspace_id = ?
    ORDER BY d.name
  `).all(req.workspace.id);
  const docsByControl = {};
  docLinks.forEach(l => { (docsByControl[l.iso_item_id] = docsByControl[l.iso_item_id] || []).push(l); });

  // ISO 27001 6.1.3.d.1: SoA must show which risks make each control "necessary".
  // Pull the actual risks linked to each control so the auditor can see the chain
  // from risk → control → SoA inclusion without clicking through.
  const riskLinks = db.prepare(`
    SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title, r.likelihood, r.impact, r.status
    FROM risk_controls rc
    INNER JOIN risks r ON r.id = rc.risk_id
    WHERE r.workspace_id = ?
    ORDER BY (r.likelihood * r.impact) DESC
  `).all(req.workspace.id);
  const risksByControl = {};
  riskLinks.forEach(l => { (risksByControl[l.iso_item_id] = risksByControl[l.iso_item_id] || []).push(l); });

  // Custom (non-Annex-A) controls live alongside the 93 Annex A entries.
  const customControls = db.prepare(`SELECT * FROM soa_custom_controls
    WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);

  // SoA metadata — version / owner / approver / approved-on, taken from the
  // latest snapshot. If no snapshot exists, the form lets the user kick one
  // off; saving via /soa/metadata captures one automatically.
  const latestSnap = db.prepare(`SELECT id, label, version, owner, approved_by, approved_at, created_at
    FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`).get(req.workspace.id);

  res.render('soa', {
    user: req.user, ws: req.workspace, rows, docsByControl, risksByControl,
    customControls, soaMeta: latestSnap || {}
  });
});

app.post('/workspaces/:wsId/soa/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
  // Reserved literal sub-routes (snapshot, auto-justify, bulk, custom-controls, metadata)
  // must fall through to their own handlers.
  if (['snapshot','auto-justify','snapshots','bulk','custom-controls','metadata'].includes(req.params.isoId)) return nextMw();
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

// Bulk SoA applicability + justification. Body shape:
//   action       = 'include_all' | 'include_undecided' | 'apply_to_selected' | 'exclude_selected'
//   iso_id       = repeated for 'apply_to_selected' / 'exclude_selected'
//   justification = applied to every affected row (inclusion_justification or
//                   exclusion_justification depending on the action)
app.post('/workspaces/:wsId/soa/bulk', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
  const { action, justification } = req.body;
  const ids = parseFormArray(req.body.iso_id);
  // Make sure every Annex A control has a control_states row to update.
  db.prepare(`INSERT OR IGNORE INTO control_states (workspace_id, iso_item_id)
              SELECT ?, id FROM iso_items WHERE type='control'`).run(req.workspace.id);
  let affected = 0;
  if (action === 'include_all') {
    affected = db.prepare(`UPDATE control_states SET applicability='included',
                           inclusion_justification = COALESCE(?, inclusion_justification),
                           last_updated = CURRENT_TIMESTAMP
                           WHERE workspace_id=? AND iso_item_id IN (SELECT id FROM iso_items WHERE type='control')`)
      .run(justification || null, req.workspace.id).changes;
  } else if (action === 'include_undecided') {
    affected = db.prepare(`UPDATE control_states SET applicability='included',
                           inclusion_justification = COALESCE(?, inclusion_justification),
                           last_updated = CURRENT_TIMESTAMP
                           WHERE workspace_id=? AND applicability IN ('undecided','')
                             AND iso_item_id IN (SELECT id FROM iso_items WHERE type='control')`)
      .run(justification || null, req.workspace.id).changes;
  } else if ((action === 'apply_to_selected' || action === 'exclude_selected') && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const applicability = action === 'exclude_selected' ? 'excluded' : 'included';
    const justCol = applicability === 'excluded' ? 'exclusion_justification' : 'inclusion_justification';
    affected = db.prepare(`UPDATE control_states SET applicability=?,
                           ${justCol} = COALESCE(?, ${justCol}),
                           last_updated = CURRENT_TIMESTAMP
                           WHERE workspace_id=? AND iso_item_id IN (${placeholders})`)
      .run(applicability, justification || null, req.workspace.id, ...ids).changes;
  }
  logAction(req.user.id, req.workspace.id, 'soa_bulk', 'soa', null, { action, affected, count: ids.length }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/soa`, `${affected} control${affected === 1 ? '' : 's'} updated`));
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
  if (!title) return redirectBack(req, res);
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
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/tasks/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user) && req.workspace.role !== 'client_admin') return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/tasks');
});

// ==================== ACTIVITY / AUDIT LOG ====================
app.get('/workspaces/:wsId/activity', requireAuth, requireWorkspace, (req, res) => {
  // Tier 2.6 — Audit-log drill-down with filters: user, action, entity_type,
  // free-text search, date range. Pagination by 100. The audit_log table is
  // appended to throughout the app; this is the read interface.
  const { user_id, action, entity_type, q, since, until } = req.query;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = 100;

  const where = ['a.workspace_id=?'];
  const params = [req.workspace.id];
  if (user_id)     { where.push('a.user_id=?');     params.push(parseInt(user_id, 10)); }
  if (action)      { where.push('a.action=?');      params.push(action); }
  if (entity_type) { where.push('a.entity_type=?'); params.push(entity_type); }
  if (since)       { where.push('a.created_at >= ?'); params.push(since + ' 00:00:00'); }
  if (until)       { where.push('a.created_at <= ?'); params.push(until + ' 23:59:59'); }
  if (q)           { where.push('(a.action LIKE ? OR a.entity_type LIKE ? OR a.entity_id LIKE ? OR u.name LIKE ?)');
                     const like = `%${q}%`; params.push(like, like, like, like); }

  const whereSql = where.join(' AND ');
  const totalRow = db.prepare(`SELECT COUNT(*) c FROM audit_log a INNER JOIN users u ON u.id=a.user_id WHERE ${whereSql}`).get(...params);
  const total = totalRow.c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const log = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a
    INNER JOIN users u ON u.id=a.user_id WHERE ${whereSql}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);

  // Distinct values for filter dropdowns (workspace-scoped).
  const distinctActions      = db.prepare(`SELECT DISTINCT action      FROM audit_log WHERE workspace_id=? AND action      IS NOT NULL ORDER BY action`).all(req.workspace.id).map(r => r.action);
  const distinctEntityTypes  = db.prepare(`SELECT DISTINCT entity_type FROM audit_log WHERE workspace_id=? AND entity_type IS NOT NULL ORDER BY entity_type`).all(req.workspace.id).map(r => r.entity_type);
  const distinctUsers        = db.prepare(`SELECT DISTINCT u.id, u.name FROM audit_log a INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY u.name`).all(req.workspace.id);

  res.render('activity', {
    user: req.user, ws: req.workspace, log,
    filters: { user_id, action, entity_type, q, since, until },
    distinctActions, distinctEntityTypes, distinctUsers,
    page, totalPages, total
  });
});

// ==================== EXPORTS ====================
app.get('/workspaces/:wsId/export/soa.csv', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
    COALESCE(cs.applicability,'undecided') AS applicability,
    COALESCE(cs.status,'Not Assessed') AS status,
    cs.inclusion_justification, cs.exclusion_justification,
    (SELECT GROUP_CONCAT('R-' || r.id, '; ') FROM risk_controls rc
     INNER JOIN risks r ON r.id = rc.risk_id
     WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS risks_treated
    FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type = 'control' ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id);

  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Control ID,Title,Category,Applicability,Status,Risks Treated (6.1.3.d.1),Inclusion Justification,Exclusion Justification'];
  rows.forEach(r => {
    lines.push([r.id.replace('annex-', '').toUpperCase(), r.title, r.category, r.applicability,
                r.status, r.risks_treated || '', r.inclusion_justification, r.exclusion_justification].map(esc).join(','));
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
  // Optional tag filter — `?tag=annex-a.5.15` shows only docs linked to that
  // clause/control. Drives the auditor-side question "which documents cover
  // A.5.15?" without leaving the documents list.
  const tagFilter = req.query.tag || '';
  const docFilterClause = tagFilter
    ? `AND d.id IN (SELECT document_id FROM document_controls WHERE iso_item_id = ?)`
    : '';
  const params = tagFilter ? [req.workspace.id, tagFilter] : [req.workspace.id];

  const docs = db.prepare(`SELECT d.*, u.name AS creator, t.name AS template_name,
    (SELECT COUNT(*) FROM document_controls dc WHERE dc.document_id = d.id) AS tag_count,
    (CASE
       WHEN d.next_review_date IS NULL THEN NULL
       WHEN d.next_review_date < date('now') THEN 'overdue'
       WHEN d.next_review_date < date('now','+30 days') THEN 'due_soon'
       ELSE 'current'
     END) AS review_status
    FROM generated_docs d
    LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN doc_templates t ON t.id = d.template_id
    WHERE d.workspace_id = ? ${docFilterClause}
    ORDER BY d.updated_at DESC`).all(...params);

  // Pull the tag chips for each doc — keep the per-doc list small (top 4 +
  // "and N more" overflow) so the table stays compact even on heavily-tagged
  // documents.
  const tagsByDoc = {};
  if (docs.length) {
    const placeholders = docs.map(() => '?').join(',');
    const tagRows = db.prepare(`SELECT dc.document_id, dc.iso_item_id, dc.section_ref, i.type
      FROM document_controls dc INNER JOIN iso_items i ON i.id = dc.iso_item_id
      WHERE dc.document_id IN (${placeholders}) ORDER BY i.sort_order`).all(...docs.map(d => d.id));
    tagRows.forEach(r => { (tagsByDoc[r.document_id] = tagsByDoc[r.document_id] || []).push(r); });
  }

  // Distinct tagged iso_items in this workspace — for the filter dropdown.
  const taggedItems = db.prepare(`SELECT DISTINCT i.id, i.type, i.title
    FROM document_controls dc
    INNER JOIN generated_docs d ON d.id = dc.document_id
    INNER JOIN iso_items i ON i.id = dc.iso_item_id
    WHERE d.workspace_id = ? ORDER BY i.sort_order`).all(req.workspace.id);

  const templates = db.prepare(`SELECT * FROM doc_templates
    WHERE is_system = 1 OR firm_id = ? ORDER BY category, name`).all(req.workspace.firm_id);

  res.render('documents', {
    user: req.user, ws: req.workspace, docs, templates,
    tagsByDoc, taggedItems, tagFilter
  });
});

app.post('/workspaces/:wsId/documents/from-template', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const { template_id, document_owner, approval_authority, review_period } = req.body;
  const tpl = db.prepare('SELECT * FROM doc_templates WHERE id = ?').get(template_id);
  if (!tpl) return redirectBack(req, res);
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
  if (!name) return redirectBack(req, res);
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

// Upload an existing client policy/procedure (DOCX, PDF, MD, TXT). Converts to editable markdown
// and preserves the original file as the approved source-of-truth attachment.
app.post('/workspaces/:wsId/documents/upload', requireAuth, requireWorkspace, requirePermission('document.create'), upload.single('file'), async (req, res) => {
  if (!req.file) return redirectBack(req, res);
  const { name, category } = req.body;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const allowed = ['.docx', '.pdf', '.md', '.markdown', '.txt'];
  if (!allowed.includes(ext)) {
    fs.unlinkSync(req.file.path);
    return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents', 'Unsupported file type — use .docx, .pdf, .md, or .txt'));
  }
  const buf = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');

  let bodyHtml = '';
  let conversionNote = '';
  try {
    if (ext === '.docx') {
      const result = await mammoth.convertToHtml({ path: req.file.path });
      bodyHtml = result.value || '';
      if (result.messages && result.messages.length) {
        conversionNote = `<p><em>Conversion notes: ${result.messages.length} formatting hints from import — review and edit as needed.</em></p>`;
      }
    } else if (ext === '.pdf') {
      const parser = new PDFParse({ data: buf });
      let pdfText = '';
      try {
        const parsed = await parser.getText();
        pdfText = (parsed.text || '').replace(/\r\n/g, '\n');
      } finally {
        if (typeof parser.destroy === 'function') await parser.destroy();
      }
      const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      bodyHtml = pdfText.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
      conversionNote = `<p><em>Imported from PDF — formatting (tables, headings, lists) may need to be re-applied. The original PDF is attached as the approved source.</em></p>`;
    } else {
      // .md / .markdown / .txt — run through markdown-it (treats plain text reasonably)
      const MarkdownIt = require('markdown-it');
      const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
      bodyHtml = md.render(buf.toString('utf8'));
    }
  } catch (err) {
    fs.unlinkSync(req.file.path);
    return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents', 'Conversion failed: ' + (err.message || 'unknown')));
  }

  const docName = (name && name.trim()) || req.file.originalname.replace(/\.[^.]+$/, '');
  const cat = category || 'policy';
  const heading = `<h1>${docName.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</h1>\n<p><em>Imported from: ${req.file.originalname.replace(/&/g,'&amp;').replace(/</g,'&lt;')} (sha256 ${sha.slice(0,12)}…)</em></p>\n${conversionNote}<hr>\n`;
  const content = heading + bodyHtml;
  const encContent = enc.encryptIfNeeded(content, req.workspace.id, !!req.workspace.encryption_enabled);

  const id = db.prepare(`INSERT INTO generated_docs
    (workspace_id, entity_id, name, category, content, created_by,
     source_filename, source_stored_path, source_mime, source_size_bytes, source_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, req.entityScopeId || null, docName, cat, encContent, req.user.id,
         req.file.originalname, req.file.filename, req.file.mimetype || null, req.file.size, sha).lastInsertRowid;

  snapshotDocVersion(id, req.workspace.id, 'draft', req.user.id, `Imported from ${req.file.originalname}`);
  logAction(req.user.id, req.workspace.id, 'upload_document', 'document', id, { filename: req.file.originalname, size: req.file.size, sha256: sha }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + id, 'Document imported — review and edit'));
});

// Download the original uploaded source file for a document (preserves the as-approved binary)
app.get('/workspaces/:wsId/documents/:id/source', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!doc || !doc.source_stored_path) return res.status(404).send('No source file attached');
  const fp = resolveUploadPath(doc.source_stored_path, req.workspace.firm_id);
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('Source file missing');
  res.download(fp, doc.source_filename || 'source');
});

app.get('/workspaces/:wsId/documents/:id', requireAuth, requireWorkspace, requirePermission('document.view'), (req, res, next) => {
  if (req.params.id === 'tree') return next();
  const docRaw = db.prepare('SELECT * FROM generated_docs WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!docRaw) return res.status(404).send('Not found');
  // Decrypt content for display
  let plainContent = enc.decryptIfNeeded(docRaw.content, req.workspace.id);
  // Lazy migration: legacy markdown -> HTML so the rich editor can render it natively.
  if (looksLikeMarkdown(plainContent)) {
    plainContent = mdRenderer.render(plainContent);
    const enc2 = enc.encryptIfNeeded(plainContent, req.workspace.id, !!req.workspace.encryption_enabled);
    db.prepare('UPDATE generated_docs SET content=? WHERE id=?').run(enc2, docRaw.id);
  }
  const doc = { ...docRaw, content: plainContent };
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

  // Linked Annex A controls + clauses (Phase A: doc <-> control bidirectional mapping)
  const linkedControls = db.prepare(`
    SELECT dc.id AS link_id, dc.iso_item_id, dc.section_ref, i.title, i.category, i.type
    FROM document_controls dc
    INNER JOIN iso_items i ON i.id = dc.iso_item_id
    WHERE dc.document_id = ?
    ORDER BY i.sort_order
  `).all(doc.id);
  const allControls = db.prepare(`SELECT id, title, category, type FROM iso_items
    WHERE type IN ('control','clause') ORDER BY sort_order`).all();

  res.render('document_detail', {
    user: req.user, ws: req.workspace, doc, comments: filtered,
    isFirm: isFirmUser(req.user),
    versions, currentVersion, approvers, signatures, signatureIssues, wsUsers,
    linkedControls, allControls,
    perms: res.locals.userPerms
  });
});

// Link an Annex A control / clause to a document
app.post('/workspaces/:wsId/documents/:id/controls', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const doc = db.prepare('SELECT id FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.status(404).send('Not found');
  // iso_item_id can be a single value (single-pick form) or an array (bulk
  // multi-pick form). The section_ref applies to the bulk batch when used —
  // typically left blank for bulk operations and set per link on single ones.
  const ids = parseFormArray(req.body.iso_item_id);
  if (!ids.length) return redirectBack(req, res);
  const sectionRef = req.body.section_ref || null;
  const ins = db.prepare(`INSERT OR IGNORE INTO document_controls (document_id, iso_item_id, section_ref) VALUES (?, ?, ?)`);
  let added = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = ins.run(doc.id, id, sectionRef);
      if (r.changes > 0) added++;
    }
  });
  try { tx(); } catch (_) {}
  logAction(req.user.id, req.workspace.id, 'link_doc_control', 'document', doc.id, { ids, count: added, section_ref: sectionRef }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

app.post('/workspaces/:wsId/documents/:id/controls/:linkId/delete', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const doc = db.prepare('SELECT id FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return res.status(404).send('Not found');
  const link = db.prepare('SELECT * FROM document_controls WHERE id=? AND document_id=?').get(req.params.linkId, doc.id);
  if (link) {
    db.prepare('DELETE FROM document_controls WHERE id=?').run(link.id);
    logAction(req.user.id, req.workspace.id, 'unlink_doc_control', 'document', doc.id, { iso_item_id: link.iso_item_id }, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// Bidirectional document tagging — mirror routes from the control side. The
// document-side routes above redirect back to the document; these redirect
// back to the wizard so the user stays in the assessment flow.
app.post('/workspaces/:wsId/controls/:isoId/documents', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('ISO item not found');
  const { document_id, section_ref } = req.body;
  if (!document_id) return redirectBack(req, res);
  // Defend against linking a doc from a different workspace.
  const doc = db.prepare('SELECT id FROM generated_docs WHERE id=? AND workspace_id=?').get(document_id, req.workspace.id);
  if (!doc) return redirectBack(req, res);
  try {
    db.prepare(`INSERT OR IGNORE INTO document_controls (document_id, iso_item_id, section_ref) VALUES (?, ?, ?)`)
      .run(doc.id, item.id, section_ref || null);
    logAction(req.user.id, req.workspace.id, 'link_doc_control', 'control', item.id, { document_id: doc.id, section_ref: section_ref || null }, auditCtx(req));
  } catch (_) { /* ignore unique-constraint conflict */ }
  res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
});

app.post('/workspaces/:wsId/controls/:isoId/documents/:linkId/delete', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  // Verify the link belongs to a doc in this workspace before deleting.
  const link = db.prepare(`SELECT dc.* FROM document_controls dc
    INNER JOIN generated_docs d ON d.id = dc.document_id
    WHERE dc.id=? AND dc.iso_item_id=? AND d.workspace_id=?`).get(req.params.linkId, req.params.isoId, req.workspace.id);
  if (link) {
    db.prepare('DELETE FROM document_controls WHERE id=?').run(link.id);
    logAction(req.user.id, req.workspace.id, 'unlink_doc_control', 'control', req.params.isoId, { document_id: link.document_id }, auditCtx(req));
  }
  res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${req.params.isoId}`);
});

app.post('/workspaces/:wsId/documents/:id', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const before = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!before) return redirectBack(req, res);
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
  let plainContent = enc.decryptIfNeeded(docRaw.content, req.workspace.id);
  if (looksLikeMarkdown(plainContent)) plainContent = mdRenderer.render(plainContent);
  const doc = { ...docRaw, content: plainContent };
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
  if (!title) return redirectBack(req, res);
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
  // Tier C.9 — per-control samples taken during the audit
  const samples = db.prepare(`SELECT s.*, i.title AS iso_title FROM audit_samples s
    LEFT JOIN iso_items i ON i.id=s.iso_item_id
    WHERE s.audit_id=? ORDER BY s.sample_taken_at IS NULL, s.sample_taken_at DESC`).all(audit.id);
  res.render('audit_detail', { user: req.user, ws: req.workspace, audit, findings, allItems, samples });
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

// ==================== TIER C.10 — CONTINUAL IMPROVEMENT REGISTER ====================
// Improvements driven by data (audit findings, MRM outputs, monitoring),
// distinct from corrective actions on NCs (10.2). Required by clause 10.1.
app.get('/workspaces/:wsId/improvements', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'open';
  let q = `SELECT * FROM improvements WHERE workspace_id=?`;
  if (filter === 'open') q += ` AND status NOT IN ('done','cancelled')`;
  q += ` ORDER BY (CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`;
  const items = db.prepare(q).all(req.workspace.id);
  res.render('improvements', { user: req.user, ws: req.workspace, items, filter });
});

app.post('/workspaces/:wsId/improvements', requireAuth, requireWorkspace, (req, res) => {
  const { title, description, source, source_ref, owner_name, due_date } = req.body;
  if (!title || !title.trim()) return redirectBack(req, res);
  db.prepare(`INSERT INTO improvements (workspace_id, title, description, source, source_ref, owner_name, due_date, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, title.trim(), description || null,
    source || null, source_ref || null, owner_name || null, due_date || null, req.user.id
  );
  logAction(req.user.id, req.workspace.id, 'add_improvement', 'improvement', null, { title }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/improvements`);
});

app.post('/workspaces/:wsId/improvements/:id', requireAuth, requireWorkspace, (req, res) => {
  const { title, description, source, source_ref, owner_name, due_date, status, impact_notes } = req.body;
  db.prepare(`UPDATE improvements SET
    title=?, description=?, source=?, source_ref=?, owner_name=?, due_date=?, status=?, impact_notes=?,
    closed_at=CASE WHEN ? IN ('done','cancelled') AND closed_at IS NULL THEN CURRENT_TIMESTAMP
                   WHEN ? NOT IN ('done','cancelled') THEN NULL
                   ELSE closed_at END
    WHERE id=? AND workspace_id=?`).run(
    title, description || null, source || null, source_ref || null, owner_name || null,
    due_date || null, status || 'open', impact_notes || null,
    status, status, req.params.id, req.workspace.id
  );
  res.redirect(`/workspaces/${req.workspace.id}/improvements`);
});

app.post('/workspaces/:wsId/improvements/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`DELETE FROM improvements WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/improvements`);
});

// ==================== TIER C.11 — ASSET RELATIONSHIPS GRAPH ====================
// SVG graph of how assets depend on each other. Useful for blast-radius
// reasoning: "if this database is compromised / unavailable, what else is
// affected?". The asset_relationships table already exists and is populated
// from the asset detail page.
app.get('/workspaces/:wsId/assets/graph', requireAuth, requireWorkspace, requirePermission('asset.view'), (req, res) => {
  const assets = db.prepare(`SELECT id, name, type, classification, business_criticality
    FROM assets WHERE workspace_id=? ORDER BY name`).all(req.workspace.id);
  const rels = db.prepare(`SELECT parent_asset_id, child_asset_id, relation
    FROM asset_relationships WHERE workspace_id=?`).all(req.workspace.id);
  res.render('assets_graph', { user: req.user, ws: req.workspace, assets, rels });
});

// Tier C.9 — Per-audit sampling justification + per-control sample log.
// Clause 9.2 expects sampling decisions to be defensible. The audit detail
// gets two new bits: (1) a sampling-justification narrative, and (2) a
// table of per-control samples taken with population/sample sizes and findings.
app.post('/workspaces/:wsId/audits/:id/sampling', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const { sampling_justification, sample_size, population_size } = req.body;
  db.prepare(`UPDATE audits SET sampling_justification=?, sample_size=?, population_size=?
              WHERE id=? AND workspace_id=?`).run(
    sampling_justification || null,
    sample_size ? parseInt(sample_size, 10) : null,
    population_size ? parseInt(population_size, 10) : null,
    req.params.id, req.workspace.id
  );
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

app.post('/workspaces/:wsId/audits/:id/samples', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const { iso_item_id, description, sample_taken_at, population_size, sample_size, finding } = req.body;
  if (!description) return redirectBack(req, res);
  db.prepare(`INSERT INTO audit_samples
    (audit_id, iso_item_id, description, sample_taken_at, population_size, sample_size, finding)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    req.params.id, iso_item_id || null, description.trim(),
    sample_taken_at || null,
    population_size ? parseInt(population_size, 10) : null,
    sample_size ? parseInt(sample_size, 10) : null,
    finding || null
  );
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

app.post('/workspaces/:wsId/audits/:id/samples/:sid/delete', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  db.prepare(`DELETE FROM audit_samples WHERE id=? AND audit_id=?`).run(req.params.sid, req.params.id);
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

// Tier 1.4 — Audit lifecycle stage transitions (planned → fieldwork →
// findings_review → report → follow_up → closed). Transitions auto-timestamp
// the milestone columns so the engagement timeline is reconstructable.
app.post('/workspaces/:wsId/audits/:id/lifecycle', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const { stage } = req.body;
  const allowed = ['planned','fieldwork','findings_review','report','follow_up','closed'];
  if (!allowed.includes(stage)) return redirectBack(req, res);
  const sets = ['lifecycle_stage=?'];
  const vals = [stage];
  if (stage === 'fieldwork') { sets.push('fieldwork_started_at=COALESCE(fieldwork_started_at, CURRENT_TIMESTAMP)'); }
  if (stage === 'report')    { sets.push('report_issued_at=COALESCE(report_issued_at, CURRENT_TIMESTAMP)'); }
  if (stage === 'closed')    { sets.push('closed_at=COALESCE(closed_at, CURRENT_TIMESTAMP)'); }
  vals.push(req.params.id, req.workspace.id);
  db.prepare(`UPDATE audits SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
  logAction(req.user.id, req.workspace.id, 'audit_lifecycle', 'audit', req.params.id, { stage }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

app.post('/workspaces/:wsId/audits/:id/findings', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { iso_item_id, finding_type, description, severity } = req.body;
  if (!description) return redirectBack(req, res);
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
  if (!f) return redirectBack(req, res);
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

// Helper — compute the auto-fillable 9.3.2 input fields from current data.
// Used both by MRM creation (Tier 2.5) and by the on-demand refresh action
// (Tier A.4) so the saved values can be brought back in line with reality.
function compute932InputPack(wsId) {
  const today = new Date().toISOString().slice(0,10);
  const ncOpen = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified')`).get(wsId).c;
  const ncMajor = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(wsId).c;
  const ncOverdue = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date < ?`).get(wsId, today).c;
  const auditsLast12 = db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND audit_date > date('now','-12 months')`).get(wsId).c;
  const findingsLast12 = db.prepare(`SELECT COUNT(*) c FROM audit_findings af INNER JOIN audits a ON a.id=af.audit_id WHERE a.workspace_id=? AND a.audit_date > date('now','-12 months')`).get(wsId).c;
  const openRisks = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open'`).get(wsId).c;
  const highRisks = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status='open' AND (likelihood * impact) >= 16`).get(wsId).c;
  const treatmentOpen = db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=? AND status NOT IN ('done','cancelled')`).get(wsId).c;
  const treatmentDone = db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=? AND status='done'`).get(wsId).c;
  const lastMrm = db.prepare(`SELECT meeting_date, action_items FROM mrms WHERE workspace_id=? AND status='complete' ORDER BY meeting_date DESC LIMIT 1`).get(wsId);
  return {
    prior_actions_status: lastMrm
      ? `Last MRM (${lastMrm.meeting_date}) actions:\n${lastMrm.action_items || '(none recorded)'}\n\n[Review status of each above before this meeting.]`
      : 'No prior management review on record. This is the first one.',
    performance_review: `Internal audit programme (last 12 months):\n  Audits run: ${auditsLast12}\n  Findings raised: ${findingsLast12}\n\nNonconformity status:\n  Open: ${ncOpen} (Major: ${ncMajor}, Overdue: ${ncOverdue})\n\nRisk treatment plan:\n  Open actions: ${treatmentOpen}\n  Closed actions: ${treatmentDone}\n\n[Add commentary on KPIs, monitoring metrics (9.1), and trends.]`,
    risk_treatment_status: `Risk register snapshot (today):\n  Total open risks: ${openRisks}\n  High-residual (L×I ≥ 16): ${highRisks}\n\n[Add narrative on top risks, treatment progress, residual-risk acceptance.]`,
    refreshedAt: new Date().toISOString()
  };
}

app.post('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { meeting_date, attendees } = req.body;
  const pack = compute932InputPack(req.workspace.id);
  const id = db.prepare(`INSERT INTO mrms
    (workspace_id, meeting_date, attendees, prior_actions_status, performance_review,
     risk_treatment_status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, meeting_date || null, attendees || null,
         pack.prior_actions_status, pack.performance_review, pack.risk_treatment_status,
         req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_mrm', 'mrm', id, null);
  res.redirect('/workspaces/' + req.workspace.id + '/mrms/' + id);
});

// Tier A.4 — Refresh the auto-fillable inputs against current workspace data.
// Useful when a saved MRM has gone stale (e.g., NCs closed since the meeting
// was scheduled, new audit findings recorded). Re-saves the three auto-pack
// fields from a fresh compute.
app.post('/workspaces/:wsId/mrms/:id/refresh-inputs', requireAuth, requireWorkspace, (req, res) => {
  const mrm = db.prepare('SELECT id, status FROM mrms WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!mrm) return res.status(404).send('Not found');
  const pack = compute932InputPack(req.workspace.id);
  db.prepare(`UPDATE mrms SET prior_actions_status=?, performance_review=?, risk_treatment_status=?
              WHERE id=? AND workspace_id=?`)
    .run(pack.prior_actions_status, pack.performance_review, pack.risk_treatment_status,
         mrm.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'refresh_mrm_inputs', 'mrm', mrm.id, null, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/mrms/${mrm.id}`, 'MRM inputs refreshed from current data'));
});

app.get('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, (req, res) => {
  const mrm = db.prepare('SELECT * FROM mrms WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!mrm) return res.status(404).send('Not found');

  // Auto-collect inputs (9.3.2)
  const audits = db.prepare(`SELECT title, status, audit_date FROM audits
                             WHERE workspace_id = ? ORDER BY audit_date DESC LIMIT 10`).all(req.workspace.id);
  const ncs = db.prepare(`SELECT title, severity, status FROM nonconformities
                          WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.workspace.id);
  const riskSummary = db.prepare(`SELECT status, COUNT(*) AS c FROM risks
                                  WHERE workspace_id = ? GROUP BY status`).all(req.workspace.id);
  const progress = workspaceProgress(req.workspace.id);

  // Phase D — extended 9.3.2 inputs
  const incidentSummary = (() => {
    try {
      return db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN created_at > datetime('now','-12 months') THEN 1 ELSE 0 END) AS last12m
        FROM incidents WHERE workspace_id=?`).get(req.workspace.id) || {};
    } catch (e) { return {}; }
  })();
  const supplierReviewStatus = (() => {
    try {
      return db.prepare(`SELECT
        COUNT(DISTINCT s.id) AS total_suppliers,
        SUM(CASE WHEN (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) > date('now','-12 months')
                 THEN 1 ELSE 0 END) AS reviewed_last_year,
        SUM(CASE WHEN (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) IS NULL
                  OR (SELECT MAX(review_date) FROM supplier_reviews sr WHERE sr.supplier_id=s.id) < date('now','-12 months')
                 THEN 1 ELSE 0 END) AS overdue
        FROM suppliers s WHERE s.workspace_id=?`).get(req.workspace.id) || {};
    } catch (e) { return {}; }
  })();
  // Prior MRM action items: tasks created from the most recent prior MRM
  const priorMrm = db.prepare(`SELECT id, meeting_date FROM mrms WHERE workspace_id=? AND id != ? AND status='complete' ORDER BY meeting_date DESC LIMIT 1`).get(req.workspace.id, mrm.id);
  const priorActions = priorMrm
    ? db.prepare(`SELECT title, status, due_date FROM tasks WHERE workspace_id=? AND created_at >= ? AND created_at < datetime(?, '+30 days') ORDER BY due_date`).all(req.workspace.id, priorMrm.meeting_date, priorMrm.meeting_date)
    : [];

  res.render('mrm_detail', {
    user: req.user, ws: req.workspace, mrm, audits, ncs, riskSummary, progress,
    incidentSummary, supplierReviewStatus, priorActions, priorMrm
  });
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
  if (!title) return redirectBack(req, res);
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
  // Phase C: corrective tasks spawned from this NC
  const correctiveTasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.workspace_id=? AND t.nonconformity_id=? ORDER BY t.created_at DESC`).all(req.workspace.id, nc.id);
  res.render('nonconformity_detail', { user: req.user, ws: req.workspace, nc, allItems, correctiveTasks });
});

app.post('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const f = ['title','source','source_ref','description','severity','iso_item_id',
             'root_cause','corrective_action','responsible','due_date','effectiveness_check','status'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  const closing = (req.body.status === 'closed' || req.body.status === 'verified');
  if (closing) {
    set.push('closed_at=CURRENT_TIMESTAMP');
  }
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE nonconformities SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_nc', 'nonconformity', req.params.id, null);

    // Phase C: closing an NC bumps the linked control's last_verified_at — feeds SoA freshness view
    if (closing) {
      const ncRow = db.prepare('SELECT iso_item_id FROM nonconformities WHERE id=?').get(req.params.id);
      if (ncRow && ncRow.iso_item_id) {
        db.prepare(`INSERT INTO control_states (workspace_id, iso_item_id, last_verified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(workspace_id, iso_item_id) DO UPDATE SET last_verified_at = CURRENT_TIMESTAMP`)
          .run(req.workspace.id, ncRow.iso_item_id);
      }
    }
  }
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + req.params.id);
});

// Phase C: spawn a corrective-action Task from a Nonconformity (closes audit -> NC -> task -> control loop)
app.post('/workspaces/:wsId/nonconformities/:id/spawn-task', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const nc = db.prepare('SELECT * FROM nonconformities WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!nc) return res.status(404).send('Not found');
  const title = `Corrective action: ${nc.title}`;
  const due = req.body.due_date || nc.due_date || null;
  const description = nc.corrective_action || nc.description || '';
  const taskId = db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, due_date, status, created_by, nonconformity_id)
                              VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`)
    .run(req.workspace.id, title, description, nc.iso_item_id || null, due, req.user.id, nc.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'spawn_corrective_task', 'task', taskId, { nonconformity_id: nc.id }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + nc.id);
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
  redirectBack(req, res);
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

// Implementation roadmap — PDCA-aligned, mapped to ISO 27001:2022 clauses.
// Each step is "complete" when a sensible signal exists; otherwise "pending".
// Shared between the Overview dashboard and the dedicated /roadmap page so
// they always reflect the same source of truth. Caller passes the scalars
// already prepared in the workspace overview route to avoid duplicate
// queries; the /roadmap route prepares them itself.
function computeRoadmap(ws, scalars) {
  const { stateRows, assetCount, riskCount, ncOpen } = scalars;
  const annexAssessed = stateRows.filter(r => r.type === 'control' && r.status !== 'Not Assessed').length;
  const annexTotal = stateRows.filter(r => r.type === 'control').length;
  const clausesAssessed = stateRows.filter(r => r.type === 'clause' && r.status !== 'Not Assessed').length;
  const clausesTotal = stateRows.filter(r => r.type === 'clause').length;
  const allAssessed = annexAssessed + clausesAssessed;
  const allTotal = annexTotal + clausesTotal;
  const soaDecided = db.prepare(`SELECT COUNT(*) c FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability IN ('included','excluded')`).get(ws.id).c;
  const approvedDocs = db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published')`).get(ws.id).c;
  const auditsScheduled = db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL`).get(ws.id).c;
  const mrmsHeld = db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status='complete'`).get(ws.id).c;
  const supplierCount = db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=?`).get(ws.id).c;

  const docSignal = (patterns) => {
    const ors = patterns.map(() => `name LIKE ?`).join(' OR ');
    return db.prepare(`SELECT COUNT(*) c FROM generated_docs
      WHERE workspace_id=? AND status IN ('approved','published') AND (${ors})`).get(ws.id, ...patterns).c;
  };

  const ispApproved = docSignal(['Information Security Policy%']);
  const contextApproved = docSignal(['ISMS Governance Manual%', 'ISMS Manual%', 'Context%', 'Interested Parties%']);
  const rolesApproved = docSignal(['ISMS Role —%', 'ISMS Steering%', 'Roles and Responsibilities%', 'RACI%']);
  const objectivesApproved = docSignal(['Information Security Objectives%']);
  const awarenessApproved = docSignal(['Awareness and Training%', 'Awareness%', 'Communication Plan%']);
  const monitoringApproved = docSignal(['Logging and Monitoring%', 'Monitoring%', 'Measurement%', 'KPI%']);

  const methodologyActive = db.prepare(`SELECT COUNT(*) c FROM risk_methodologies
    WHERE workspace_id=? AND is_active=1`).get(ws.id).c;
  const includedControls = db.prepare(`SELECT COUNT(*) c FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'`).get(ws.id).c;
  const implementedControls = db.prepare(`SELECT COUNT(*) c FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.status='Implemented'`).get(ws.id).c;

  return [
    { phase: 'plan', key: 'scope', label: 'Define ISMS scope', clause: 'Clause 4.3',
      done: !!(ws.scope && ws.scope.length > 10),
      detail: ws.scope ? 'Scope statement set' : 'Set the scope on workspace settings or in an ISMS Scope document',
      link: `/workspaces/${ws.id}#workspace-settings`, link_label: 'Edit scope' },
    { phase: 'plan', key: 'context', label: 'Document context — internal/external issues + interested parties', clause: 'Clauses 4.1 & 4.2',
      done: contextApproved >= 1,
      detail: contextApproved >= 1
        ? 'Context register / ISMS Governance Manual approved'
        : 'Document internal & external issues and interested-party requirements (incl. climate-related per Amendment 1:2024)',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'isp', label: 'Approve Information Security Policy', clause: 'Clause 5.2',
      done: ispApproved >= 1,
      detail: ispApproved >= 1 ? 'ISP approved' : 'Approved ISP is the foundation document — generate from template and approve',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'roles', label: 'Define ISMS roles & responsibilities', clause: 'Clause 5.3',
      done: rolesApproved >= 1,
      detail: rolesApproved >= 1
        ? 'Roles & responsibilities documented'
        : 'Assign CISO, asset owners, risk owners, internal auditor; document responsibilities and authority',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'objectives', label: 'Set information security objectives', clause: 'Clause 6.2',
      done: objectivesApproved >= 1,
      detail: objectivesApproved >= 1
        ? 'Information Security Objectives approved'
        : 'Set measurable, time-bound objectives consistent with the policy (3–7 typically)',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'methodology', label: 'Document risk-assessment methodology', clause: 'Clause 6.1.2',
      done: methodologyActive >= 1,
      detail: methodologyActive >= 1 ? 'Active methodology defined (scales, criteria)' : 'Likelihood/impact scales and risk-acceptance criteria must be set before scoring risks',
      link: `/workspaces/${ws.id}/risk-methodology`, link_label: 'Methodology' },
    { phase: 'plan', key: 'assets', label: 'Build asset register', clause: 'A.5.9 (input to 6.1.2)',
      done: assetCount >= 5, partial: assetCount > 0 && assetCount < 5,
      detail: `${assetCount} asset${assetCount === 1 ? '' : 's'} registered${assetCount > 0 && assetCount < 5 ? ' — most ISMS scopes need at least 5–10' : ''}`,
      link: `/workspaces/${ws.id}/assets`, link_label: 'Assets' },
    { phase: 'plan', key: 'gap', label: 'Gap-assess clauses & Annex A', clause: 'Project activity (covers 4–10, A.5–A.8)',
      done: allAssessed === allTotal && allTotal > 0, partial: allAssessed > 0 && allAssessed < allTotal,
      detail: `${clausesAssessed} / ${clausesTotal} clauses · ${annexAssessed} / ${annexTotal} controls assessed`,
      link: `/workspaces/${ws.id}/gap-assessment`, link_label: 'Run gap assessment' },
    { phase: 'plan', key: 'risks', label: 'Identify, score, and treat risks', clause: 'Clauses 6.1.2 & 6.1.3',
      done: riskCount >= 5, partial: riskCount > 0 && riskCount < 5,
      detail: `${riskCount} risk${riskCount === 1 ? '' : 's'} in register${riskCount === 0 ? ' — start from the library if unsure' : ''}`,
      link: `/workspaces/${ws.id}/risks`, link_label: 'Risks' },
    { phase: 'plan', key: 'soa', label: 'Finalize Statement of Applicability', clause: 'Clause 6.1.3 d',
      done: soaDecided === annexTotal && annexTotal > 0, partial: soaDecided > 0 && soaDecided < annexTotal,
      detail: `${soaDecided} / ${annexTotal} controls have inclusion/exclusion decision with justification`,
      link: `/workspaces/${ws.id}/soa`, link_label: 'SoA' },
    { phase: 'plan', key: 'awareness', label: 'Establish competence, awareness & communication', clause: 'Clauses 7.2, 7.3, 7.4',
      done: awarenessApproved >= 1,
      detail: awarenessApproved >= 1
        ? 'Awareness & Training Plan approved'
        : 'Plan competence requirements, awareness programme (induction + annual refresh), and communication channels',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'docs', label: 'Approve mandatory documented information', clause: 'Clause 7.5',
      done: approvedDocs >= 8, partial: approvedDocs > 0 && approvedDocs < 8,
      detail: `${approvedDocs} document${approvedDocs === 1 ? '' : 's'} approved (target: at least the 8 mandatory artefacts)`,
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'do', key: 'controls', label: 'Implement applicable Annex A controls', clause: 'Clause 8.3 + A.5–A.8',
      done: includedControls > 0 && implementedControls === includedControls,
      partial: implementedControls > 0 && implementedControls < includedControls,
      detail: includedControls === 0
        ? 'Decide applicability in the SoA first, then implement included controls'
        : `${implementedControls} / ${includedControls} included controls marked Implemented`,
      link: `/workspaces/${ws.id}/controls`, link_label: 'Controls' },
    { phase: 'do', key: 'suppliers', label: 'Manage supplier security operationally', clause: 'Clause 8.1 + A.5.19–A.5.22',
      done: supplierCount >= 1,
      detail: supplierCount === 0 ? 'Identify in-scope suppliers; assess and review per supplier risk tier' : `${supplierCount} supplier${supplierCount === 1 ? '' : 's'} registered`,
      link: `/workspaces/${ws.id}/vendors`, link_label: 'Suppliers' },
    { phase: 'check', key: 'monitoring', label: 'Define monitoring, measurement & evaluation', clause: 'Clause 9.1',
      done: monitoringApproved >= 1,
      detail: monitoringApproved >= 1
        ? 'Monitoring approach documented'
        : 'Determine what to monitor, methods, frequency, who analyses — KPIs aligned with objectives (6.2)',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'check', key: 'audit', label: 'Run an internal audit', clause: 'Clause 9.2',
      done: auditsScheduled >= 1,
      detail: auditsScheduled === 0 ? 'Plan the audit programme; first audit must precede Stage 1 cert audit' : `${auditsScheduled} audit${auditsScheduled === 1 ? '' : 's'} scheduled or run`,
      link: `/workspaces/${ws.id}/audits`, link_label: 'Internal audits' },
    { phase: 'check', key: 'mrm', label: 'Hold a management review', clause: 'Clause 9.3',
      done: mrmsHeld >= 1,
      detail: mrmsHeld === 0 ? 'Top management must review the ISMS at planned intervals; cover all 9.3.2 inputs' : `${mrmsHeld} MRM${mrmsHeld === 1 ? '' : 's'} completed`,
      link: `/workspaces/${ws.id}/mrms`, link_label: 'Management review' },
    { phase: 'act', key: 'ncs', label: 'Track nonconformities to closure with root-cause', clause: 'Clause 10.2',
      done: ncOpen === 0,
      detail: ncOpen === 0 ? 'No open NCs' : `${ncOpen} open NC${ncOpen === 1 ? '' : 's'} — RCA + corrective action + effectiveness review per NC`,
      link: `/workspaces/${ws.id}/nonconformities`, link_label: 'Nonconformities' }
  ];
}

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

// Audit-readiness blockers — concrete things the auditor will catch if you ignore them.
// Distinct from /readiness which is a high-level percentage view.
app.get('/workspaces/:wsId/readiness/blockers', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const blockers = [];

  // 1. Controls marked Implemented but no evidence files attached
  const implNoEvidence = db.prepare(`
    SELECT i.id, i.title FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id = i.id
    WHERE i.type='control' AND cs.workspace_id=? AND cs.status='Implemented'
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
    ORDER BY i.sort_order`).all(wsId, wsId);
  if (implNoEvidence.length) {
    blockers.push({
      severity: 'high',
      title: `${implNoEvidence.length} control${implNoEvidence.length === 1 ? '' : 's'} marked "Implemented" but no evidence attached`,
      detail: 'Auditors will ask for evidence before accepting any "Implemented" claim. Either attach evidence or downgrade the status.',
      items: implNoEvidence.slice(0, 20).map(c => ({ label: c.id.replace('annex-','').toUpperCase() + ' — ' + c.title.replace(/^A\.[0-9.]+ /, ''), link: `/workspaces/${wsId}/controls/${c.id}` }))
    });
  }

  // 2. SoA controls without inclusion or exclusion justification
  const soaUnjustified = db.prepare(`
    SELECT i.id, i.title, COALESCE(cs.applicability,'undecided') AS applicability FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id=?
    WHERE i.type='control' AND (
      (cs.applicability='included' AND (cs.inclusion_justification IS NULL OR cs.inclusion_justification=''))
      OR (cs.applicability='excluded' AND (cs.exclusion_justification IS NULL OR cs.exclusion_justification=''))
      OR cs.applicability IS NULL OR cs.applicability='undecided'
    )
    ORDER BY i.sort_order`).all(wsId);
  if (soaUnjustified.length) {
    blockers.push({
      severity: 'high',
      title: `${soaUnjustified.length} SoA entr${soaUnjustified.length === 1 ? 'y' : 'ies'} without applicability decision or justification`,
      detail: 'Clause 6.1.3 d requires the SoA to state inclusion/exclusion AND justify each. Empty justifications fail at Stage 1.',
      items: soaUnjustified.slice(0, 20).map(c => ({ label: c.id.replace('annex-','').toUpperCase() + ' — ' + c.title.replace(/^A\.[0-9.]+ /, '') + ' (' + c.applicability + ')', link: `/workspaces/${wsId}/soa` }))
    });
  }

  // 3. Approved documents without next_review_date set or overdue
  const docReviewIssues = db.prepare(`
    SELECT id, name, next_review_date FROM generated_docs
    WHERE workspace_id=? AND status IN ('approved','published')
      AND (next_review_date IS NULL OR next_review_date < date('now'))
    ORDER BY next_review_date IS NULL, next_review_date`).all(wsId);
  if (docReviewIssues.length) {
    blockers.push({
      severity: 'medium',
      title: `${docReviewIssues.length} approved document${docReviewIssues.length === 1 ? '' : 's'} without a future review date`,
      detail: 'Clause 7.5.3 expects documented information to be reviewed at planned intervals. Missing or past-due review dates suggest stale documentation.',
      items: docReviewIssues.slice(0, 20).map(d => ({ label: d.name + (d.next_review_date ? ` · review was due ${d.next_review_date}` : ' · no review date set'), link: `/workspaces/${wsId}/documents/${d.id}` }))
    });
  }

  // 4. Open / overdue NCs
  const overdueNcs = db.prepare(`
    SELECT id, title, due_date, severity FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified')
      AND due_date IS NOT NULL AND due_date < date('now')
    ORDER BY due_date`).all(wsId);
  if (overdueNcs.length) {
    blockers.push({
      severity: 'high',
      title: `${overdueNcs.length} nonconformity${overdueNcs.length === 1 ? '' : 'ies'} overdue`,
      detail: 'Clause 10.1 requires corrective action without undue delay. Overdue NCs at cert audit get raised as new findings.',
      items: overdueNcs.map(n => ({ label: `${n.title} · due ${n.due_date} · ${n.severity}`, link: `/workspaces/${wsId}/nonconformities/${n.id}` }))
    });
  }

  // 5. No internal audit run in the last 12 months
  const recentAudit = db.prepare(`SELECT COUNT(*) c FROM audits
    WHERE workspace_id=? AND audit_date >= date('now','-12 months') AND status='complete'`).get(wsId).c;
  if (recentAudit === 0) {
    blockers.push({
      severity: 'high',
      title: 'No completed internal audit in the last 12 months',
      detail: 'Clause 9.2 mandates internal audit at planned intervals. A first-year ISMS needs at least one full internal audit before stage 2.',
      items: [{ label: 'Schedule and complete an internal audit', link: `/workspaces/${wsId}/audits` }]
    });
  }

  // 6. No completed MRM in the last 12 months
  const recentMrm = db.prepare(`SELECT COUNT(*) c FROM mrms
    WHERE workspace_id=? AND meeting_date >= date('now','-12 months') AND status='complete'`).get(wsId).c;
  if (recentMrm === 0) {
    blockers.push({
      severity: 'high',
      title: 'No completed management review in the last 12 months',
      detail: 'Clause 9.3 requires top management to review the ISMS at planned intervals. Missing this is a stage-2 fail.',
      items: [{ label: 'Schedule and complete an MRM', link: `/workspaces/${wsId}/mrms` }]
    });
  }

  // 7. Risks at "Open" status with no treatment recorded
  const openUntreated = db.prepare(`SELECT id, title FROM risks
    WHERE workspace_id=? AND status='open' AND (treatment IS NULL OR treatment='' OR treatment='untreated')
    ORDER BY (likelihood * impact) DESC LIMIT 30`).all(wsId);
  if (openUntreated.length) {
    blockers.push({
      severity: 'medium',
      title: `${openUntreated.length} open risk${openUntreated.length === 1 ? '' : 's'} with no treatment selected`,
      detail: 'Clause 6.1.3 requires a risk treatment option (modify / accept / avoid / transfer) for each risk above appetite.',
      items: openUntreated.slice(0, 20).map(r => ({ label: r.title, link: `/workspaces/${wsId}/risks/${r.id}` }))
    });
  }

  // 8. Suppliers with no review in the last 12 months
  const overdueSuppliers = db.prepare(`SELECT s.id, s.name FROM suppliers s
    WHERE s.workspace_id=? AND s.lifecycle_stage NOT IN ('terminated')
      AND NOT EXISTS (SELECT 1 FROM supplier_reviews sr WHERE sr.supplier_id=s.id AND sr.review_date >= date('now','-12 months'))
    ORDER BY s.name`).all(wsId);
  if (overdueSuppliers.length) {
    blockers.push({
      severity: 'medium',
      title: `${overdueSuppliers.length} supplier${overdueSuppliers.length === 1 ? '' : 's'} not reviewed in the last 12 months`,
      detail: 'A.5.19 / A.5.22 expects periodic supplier risk review. Long gaps suggest supplier management is on paper only.',
      items: overdueSuppliers.slice(0, 20).map(s => ({ label: s.name, link: `/workspaces/${wsId}/vendors/${s.id}` }))
    });
  }

  // 9. Clauses or Annex A controls Not Assessed at all
  const notAssessedRow = db.prepare(`SELECT
    SUM(CASE WHEN i.type='clause' AND (cs.status IS NULL OR cs.status='Not Assessed') THEN 1 ELSE 0 END) AS clauses,
    SUM(CASE WHEN i.type='control' AND (cs.status IS NULL OR cs.status='Not Assessed') THEN 1 ELSE 0 END) AS controls
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')`).get(wsId);
  const notAssessed = (notAssessedRow.clauses || 0) + (notAssessedRow.controls || 0);
  if (notAssessed > 0) {
    blockers.push({
      severity: 'high',
      title: `${notAssessed} item${notAssessed === 1 ? '' : 's'} still "Not Assessed" (${notAssessedRow.clauses || 0} clause${(notAssessedRow.clauses||0) === 1 ? '' : 's'} · ${notAssessedRow.controls || 0} control${(notAssessedRow.controls||0) === 1 ? '' : 's'})`,
      detail: 'Every main-body clause AND every Annex A control needs a status — even Not Applicable. Clauses 4–10 are the "shall" requirements; Annex A entries also need an applicability decision. Run the gap assessment wizard to clear this in one pass.',
      items: [{ label: '→ Run gap assessment', link: `/workspaces/${wsId}/gap-assessment` }]
    });
  }

  // 10. No risks at all
  const riskTotal = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(wsId).c;
  if (riskTotal === 0) {
    blockers.push({
      severity: 'high',
      title: 'No risks in the register',
      detail: 'Clause 6.1.2 requires a risk assessment process to identify, analyze, and evaluate risks. An empty register is a hard fail.',
      items: [{ label: '→ Add starter risks from library', link: `/workspaces/${wsId}/risks/library` }]
    });
  }

  const high = blockers.filter(b => b.severity === 'high').length;
  const med = blockers.filter(b => b.severity === 'medium').length;
  res.render('readiness_blockers', { user: req.user, ws: req.workspace, blockers, high, med });
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

      // Nav shortcuts in current workspace. Each entry: [label, path-suffix,
      // optional aliases for matching]. Keep in sync with views/partials/header.ejs.
      const nav = [
        ['Overview', '', 'dashboard home'],
        ['Readiness', '/readiness', 'stage 1 stage 2 cert ready'],
        ['Gap assessment', '/gap-assessment', 'pass passes re-assessment reassess diff'],
        ['Roadmap', '/roadmap', 'pdca implementation plan needs attention'],
        ['Controls', '/controls', 'annex a clauses wizard'],
        ['Assets', '/assets', 'inventory asset register'],
        ['Risks', '/risks', 'risk register'],
        ['Interested parties', '/interested-parties', 'clause 4.2 stakeholders parties'],
        ['Objectives', '/objectives', 'clause 6.2 information security objectives kpi'],
        ['Risk methodology', '/risk-methodology', 'risk criteria scales'],
        ['Risk acceptances', '/risk-acceptances', 'accepted risks'],
        ['Statement of Applicability', '/soa', 'soa annex a inclusion exclusion'],
        ['SoA snapshots', '/soa/snapshots', 'soa version history'],
        ['Documents', '/documents', 'policies procedures'],
        ['Evidence library', '/evidence', 'audit evidence files'],
        ['Internal audits', '/audits', 'audit'],
        ['Audit programme', '/audit-programme', 'audit schedule annual'],
        ['Management review', '/mrms', 'mrm top management review'],
        ['Cert cycle', '/cert-cycle', 'certification stage 1 stage 2 surveillance recert'],
        ['Nonconformities', '/nonconformities', 'nc finding'],
        ['Incidents', '/incidents', 'security incident'],
        ['Improvements', '/improvements', 'continual improvement opportunity'],
        ['Suppliers', '/vendors', 'vendor third party tprm'],
        ['Tasks', '/tasks', 'task remediation'],
        ['Task templates', '/task-templates', 'task template'],
        ['Compliance calendar', '/calendar', 'calendar dates schedule'],
        ['Reports', '/reports', 'report export'],
        ['Members', '/members', 'team users'],
        ['Access & permissions', '/access', 'permissions rbac'],
        ['Activity log', '/activity-log', 'audit trail history']
      ];
      nav.filter(([n, , aliases]) => n.toLowerCase().includes(q) || (aliases && aliases.toLowerCase().includes(q)))
        .slice(0, 8)
        .forEach(([n, p]) => {
          results.push({ type: 'Page', label: n, sublabel: ws.client_name, href: '/workspaces/' + wsId + p });
        });
    }
  } else {
    if ('clients'.includes(q) || 'dashboard'.includes(q) || 'home'.includes(q)) {
      results.push({ type: 'Page', label: 'Clients', sublabel: 'All workspaces', href: '/dashboard' });
    }
  }

  // Workspace-agnostic resources — searchable from anywhere.
  if ('glossary'.includes(q) || 'terms'.includes(q) || 'dictionary'.includes(q) || 'definitions'.includes(q)) {
    results.push({ type: 'Reference', label: 'Glossary', sublabel: 'ISO 27001 & GRC terms', href: '/glossary' });
  }
  // Direct hits on individual glossary entries — searches term, aliases, plain.
  try {
    const GLOSSARY = require('./data/glossary');
    const matches = GLOSSARY.searchEntries(q, 'all', 'all').slice(0, 5);
    for (const m of matches) {
      results.push({
        type: 'Glossary',
        label: m.term,
        sublabel: m.plain ? (m.plain.length > 70 ? m.plain.slice(0, 70) + '…' : m.plain) : '',
        href: '/glossary/' + m.slug
      });
    }
  } catch (_) { /* glossary data not loadable, skip */ }

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
  const watermarkText = doc.watermark
    || (doc.status === 'draft' ? 'DRAFT — NOT FOR DISTRIBUTION'
       : doc.status === 'in_review' ? 'IN REVIEW'
       : doc.status === 'retired' ? 'RETIRED'
       : doc.controlled_copy ? 'CONTROLLED COPY' : null);

  // Document body is now HTML (rich-text editor); legacy markdown is upgraded on first read.
  // For belt-and-braces, run a markdown render pass if the content somehow still looks like markdown.
  let bodyHtml = doc.content || '';
  if (looksLikeMarkdown(bodyHtml)) bodyHtml = mdRenderer.render(bodyHtml);

  const metaLine = `${ws.client_name} · v${doc.version} · status: ${doc.status}` + (watermarkText ? ` · ${watermarkText}` : '');
  const banner = watermarkText
    ? `<p style="text-align:center;color:#B91C1C;font-size:18pt;font-weight:bold;border-bottom:2pt solid #B91C1C;padding-bottom:6pt;">${watermarkText}</p>`
    : '';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${(doc.name || 'Document').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</title>
    <style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;}
    h1{font-size:18pt;}h2{font-size:14pt;}h3{font-size:12pt;}
    table{border-collapse:collapse;}table td,table th{border:1px solid #999;padding:4pt 8pt;}
    .meta{color:#71717A;font-size:9pt;text-align:right;margin-bottom:8pt;}
    .footer{color:#9C9CA5;font-size:8pt;text-align:center;margin-top:24pt;}</style>
  </head><body>
    <p class="meta">${metaLine}</p>
    ${banner}
    ${bodyHtml}
    <p class="footer">Document hash basis: rendered ${new Date().toISOString()}</p>
  </body></html>`;

  return await htmlToDocx(html, null, {
    table: { row: { cantSplit: true } },
    footer: false,
    pageNumber: false,
    margins: { top: 720, right: 720, bottom: 720, left: 720 }
  });
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
    const fp = resolveUploadPath(e.stored_path, ws.firm_id);
    if (fp && fs.existsSync(fp)) {
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
  if (!title) return redirectBack(req, res);
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
  if (!inc) return redirectBack(req, res);
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
  if (!name) return redirectBack(req, res);
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
  const supplierControls = db.prepare(`
    SELECT sc.id AS link_id, sc.iso_item_id, sc.notes, i.title, i.category
    FROM supplier_controls sc
    INNER JOIN iso_items i ON i.id = sc.iso_item_id
    WHERE sc.supplier_id = ? ORDER BY i.sort_order
  `).all(v.id);
  const allControlsForVendor = db.prepare(`SELECT id, title FROM iso_items WHERE type='control' ORDER BY sort_order`).all();
  const questionnaires = db.prepare(`SELECT q.*, t.category FROM supplier_questionnaires q LEFT JOIN questionnaire_templates t ON t.id=q.template_id WHERE q.supplier_id=? ORDER BY q.created_at DESC`).all(v.id);
  const templates = db.prepare(`SELECT id, name, description, category, (SELECT COUNT(*) FROM questionnaire_questions WHERE template_id=questionnaire_templates.id) AS q_count FROM questionnaire_templates WHERE is_system=1 OR firm_id=? ORDER BY name`).all(req.workspace.firm_id);
  const monitoring = db.prepare('SELECT * FROM supplier_monitoring WHERE supplier_id=? ORDER BY recorded_at DESC').all(v.id);
  const terminationItems = db.prepare('SELECT * FROM supplier_termination_items WHERE supplier_id=? ORDER BY id').all(v.id);

  res.render('vendor_detail', {
    user: req.user, ws: req.workspace, v, tab,
    docs, subprocessors, reviews, notes, clauses, questionnaires, templates,
    monitoring, terminationItems, supplierControls, allControlsForVendor,
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
  if (!name) return redirectBack(req, res);
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
  const fp = resolveUploadPath(d.stored_path, req.workspace.firm_id);
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
  res.download(fp, d.filename);
});

app.post('/workspaces/:wsId/vendors/:id/documents/:docId/delete', requireAuth, requireWorkspace, (req, res) => {
  const d = db.prepare(`SELECT * FROM supplier_documents WHERE id=? AND supplier_id=?`).get(req.params.docId, req.params.id);
  if (d) {
    if (d.stored_path) { const fp = resolveUploadPath(d.stored_path, req.workspace.firm_id); if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); }
    db.prepare(`DELETE FROM supplier_documents WHERE id=?`).run(d.id);
    recomputeSupplierRisk(req.params.id, req.workspace.id);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=documents');
});

// Sub-processors
app.post('/workspaces/:wsId/vendors/:id/subprocessors', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { name, service_provided, data_access, location, approved } = req.body;
  if (!name) return redirectBack(req, res);
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
  if (!body) return redirectBack(req, res);
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

// Phase B: declare which Annex A controls a supplier handles on our behalf (A.5.19-A.5.23)
app.post('/workspaces/:wsId/vendors/:id/controls', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const v = db.prepare('SELECT id FROM suppliers WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!v) return res.status(404).send('Not found');
  const { iso_item_id, notes } = req.body;
  if (!iso_item_id) return redirectBack(req, res);
  try {
    db.prepare(`INSERT OR IGNORE INTO supplier_controls (supplier_id, iso_item_id, notes) VALUES (?, ?, ?)`)
      .run(v.id, iso_item_id, notes || null);
    logAction(req.user.id, req.workspace.id, 'link_supplier_control', 'supplier', v.id, { iso_item_id }, auditCtx(req));
  } catch (e) { /* ignore dup */ }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + v.id + '?tab=controls');
});

app.post('/workspaces/:wsId/vendors/:id/controls/:linkId/delete', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const v = db.prepare('SELECT id FROM suppliers WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!v) return res.status(404).send('Not found');
  const link = db.prepare('SELECT * FROM supplier_controls WHERE id=? AND supplier_id=?').get(req.params.linkId, v.id);
  if (link) {
    db.prepare('DELETE FROM supplier_controls WHERE id=?').run(link.id);
    logAction(req.user.id, req.workspace.id, 'unlink_supplier_control', 'supplier', v.id, { iso_item_id: link.iso_item_id }, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + v.id + '?tab=controls');
});

// Questionnaires
app.post('/workspaces/:wsId/vendors/:id/questionnaires', requireAuth, requireWorkspace, (req, res) => {
  if (req.workspace.role === 'reviewer') return res.status(403).send('Forbidden');
  const { template_id } = req.body;
  const tpl = db.prepare(`SELECT * FROM questionnaire_templates WHERE id=?`).get(template_id);
  if (!tpl) return redirectBack(req, res);
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
  if (!user_id || !rbac.ROLE_PERMS[role]) return redirectBack(req, res);
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
  if (!user_id || !permission || !rbac.PERMISSIONS[permission]) return redirectBack(req, res);
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
  if (!doc) return redirectBack(req, res);
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
  if (!doc || !doc.current_version_id) return redirectBack(req, res);
  const { decision, reason } = req.body;
  if (!['approve','reject'].includes(decision)) return redirectBack(req, res);

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
  if (!doc || !doc.current_version_id) return redirectBack(req, res);
  const { intent, signature_role, attestation } = req.body;
  if (!intent || !attestation) return res.status(400).render('error', { user: req.user, message: 'Sign-off requires an intent and explicit attestation.' });
  const v = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(doc.current_version_id);
  if (!v) return redirectBack(req, res);
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
  if (!doc) return redirectBack(req, res);
  if (doc.status !== 'approved') return res.status(400).render('error', { user: req.user, message: 'Only approved documents can be published.' });
  db.prepare(`UPDATE generated_docs SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
  if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
  logAction(req.user.id, req.workspace.id, 'publish_document', 'document', doc.id, { version_id: doc.current_version_id }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// Retire a published document.
app.post('/workspaces/:wsId/documents/:id/retire', requireAuth, requireWorkspace, requirePermission('document.retire'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return redirectBack(req, res);
  db.prepare(`UPDATE generated_docs SET status='retired', retired_at=CURRENT_TIMESTAMP, locked=1 WHERE id=?`).run(doc.id);
  if (doc.current_version_id) db.prepare(`UPDATE doc_versions SET status='retired', retired_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.current_version_id);
  logAction(req.user.id, req.workspace.id, 'retire_document', 'document', doc.id, { reason: req.body.reason || null }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// Reopen for editing — creates a new draft version branched off current.
app.post('/workspaces/:wsId/documents/:id/new-version', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return redirectBack(req, res);
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
// Tier B.5/B.6 — Surface actionable items derived from current workspace state.
// Used by /notifications (the inbox) and on the overview's "Needs attention"
// panel. Computed on-demand from live data — no cron required.
function computeNeedsAttention(wsId) {
  const today = new Date().toISOString().slice(0,10);
  const expSoon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10);

  const items = [];
  const push = (severity, category, title, link, detail) =>
    items.push({ severity, category, title, link, detail });

  // Overdue / soon-due nonconformities
  db.prepare(`SELECT id, title, due_date FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < ?`)
    .all(wsId, today).forEach(n => push('high', 'nc', `Overdue NC: ${n.title}`, `/workspaces/${wsId}/nonconformities/${n.id}`, `Due ${n.due_date}`));
  db.prepare(`SELECT id, title, due_date FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date >= ? AND due_date < ?`)
    .all(wsId, today, expSoon).forEach(n => push('medium', 'nc', `NC due soon: ${n.title}`, `/workspaces/${wsId}/nonconformities/${n.id}`, `Due ${n.due_date}`));

  // Expired / expiring evidence
  db.prepare(`SELECT id, filename, valid_until, iso_item_id FROM evidence
    WHERE workspace_id=? AND valid_until IS NOT NULL AND valid_until < ?`)
    .all(wsId, today).forEach(e => push('high', 'evidence', `Expired evidence: ${e.filename}`, `/workspaces/${wsId}/controls/assess/${e.iso_item_id || 'summary'}`, `Valid until ${e.valid_until}`));
  db.prepare(`SELECT id, filename, valid_until, iso_item_id FROM evidence
    WHERE workspace_id=? AND valid_until IS NOT NULL AND valid_until >= ? AND valid_until < ?`)
    .all(wsId, today, expSoon).forEach(e => push('medium', 'evidence', `Evidence expires soon: ${e.filename}`, `/workspaces/${wsId}/controls/assess/${e.iso_item_id || 'summary'}`, `Valid until ${e.valid_until}`));

  // Documents overdue / due for review
  db.prepare(`SELECT id, name, next_review_date FROM generated_docs
    WHERE workspace_id=? AND next_review_date IS NOT NULL AND next_review_date < ?`)
    .all(wsId, today).forEach(d => push('high', 'document', `Document overdue for review: ${d.name}`, `/workspaces/${wsId}/documents/${d.id}`, `Review by ${d.next_review_date}`));
  db.prepare(`SELECT id, name, next_review_date FROM generated_docs
    WHERE workspace_id=? AND next_review_date IS NOT NULL AND next_review_date >= ? AND next_review_date < ?`)
    .all(wsId, today, expSoon).forEach(d => push('medium', 'document', `Document due for review: ${d.name}`, `/workspaces/${wsId}/documents/${d.id}`, `Review by ${d.next_review_date}`));

  // Risk acceptances expired / expiring
  db.prepare(`SELECT a.id, a.risk_id, a.expires_at, r.title FROM risk_acceptances a
    INNER JOIN risks r ON r.id=a.risk_id
    WHERE a.workspace_id=? AND a.revoked_at IS NULL AND a.expires_at IS NOT NULL AND a.expires_at < ?`)
    .all(wsId, today).forEach(a => push('high', 'risk', `Expired acceptance: R-${a.risk_id} ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Expired ${a.expires_at} — re-accept or treat`));
  db.prepare(`SELECT a.id, a.risk_id, a.expires_at, r.title FROM risk_acceptances a
    INNER JOIN risks r ON r.id=a.risk_id
    WHERE a.workspace_id=? AND a.revoked_at IS NULL AND a.expires_at IS NOT NULL AND a.expires_at >= ? AND a.expires_at < ?`)
    .all(wsId, today, expSoon).forEach(a => push('medium', 'risk', `Acceptance expires soon: R-${a.risk_id} ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Expires ${a.expires_at}`));

  // Treatment actions overdue / due
  db.prepare(`SELECT rta.id, rta.title, rta.due_date, rta.risk_id FROM risk_treatment_actions rta
    WHERE rta.workspace_id=? AND rta.status NOT IN ('done','cancelled') AND rta.due_date IS NOT NULL AND rta.due_date < ?`)
    .all(wsId, today).forEach(a => push('high', 'treatment', `Overdue treatment action: ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Due ${a.due_date}`));
  db.prepare(`SELECT rta.id, rta.title, rta.due_date, rta.risk_id FROM risk_treatment_actions rta
    WHERE rta.workspace_id=? AND rta.status NOT IN ('done','cancelled') AND rta.due_date IS NOT NULL AND rta.due_date >= ? AND rta.due_date < ?`)
    .all(wsId, today, expSoon).forEach(a => push('medium', 'treatment', `Treatment action due soon: ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Due ${a.due_date}`));

  // Cert events upcoming
  db.prepare(`SELECT id, event_type, planned_date FROM cert_cycle_events
    WHERE workspace_id=? AND status NOT IN ('closed') AND planned_date IS NOT NULL AND planned_date >= ? AND planned_date < ?`)
    .all(wsId, today, expSoon).forEach(e => push('medium', 'cert', `Upcoming: ${e.event_type.replace('_',' ')}`, `/workspaces/${wsId}/cert-cycle`, `Planned ${e.planned_date}`));

  // Stale-control signals — controls included in SoA whose last_verified_at
  // is > 12 months ago (or never verified). Drives the re-engagement scope.
  const stale = db.prepare(`SELECT cs.iso_item_id, cs.last_verified_at, i.title
    FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.status NOT IN ('Not Assessed','Not Applicable')
      AND (cs.last_verified_at IS NULL OR cs.last_verified_at < datetime('now','-365 days'))
    ORDER BY cs.last_verified_at IS NULL DESC, cs.last_verified_at ASC
    LIMIT 6`).all(wsId);
  for (const s of stale) {
    const code = s.iso_item_id.replace('annex-','').toUpperCase();
    const detail = s.last_verified_at
      ? `Last verified ${s.last_verified_at.slice(0,10)} — re-assess`
      : 'Never verified — re-assess in this engagement';
    push(s.last_verified_at ? 'medium' : 'high', 'stale', `${code} stale: ${s.title.replace(/^A\.[0-9.]+ /,'')}`,
         `/workspaces/${wsId}/controls/assess/${s.iso_item_id}`, detail);
  }

  // Overdue interested-party reviews + objective due dates.
  db.prepare(`SELECT id, party, next_review FROM interested_parties
    WHERE workspace_id=? AND next_review IS NOT NULL AND next_review < ?`)
    .all(wsId, today).forEach(p => push('medium', 'party',
      `Interested party review overdue: ${p.party}`,
      `/workspaces/${wsId}/interested-parties`,
      `Review was due ${p.next_review}`));
  db.prepare(`SELECT id, title, due_date, status FROM security_objectives
    WHERE workspace_id=? AND due_date IS NOT NULL AND due_date < ? AND status NOT IN ('achieved','paused')`)
    .all(wsId, today).forEach(o => push('high', 'objective',
      `Objective overdue: ${o.title}`,
      `/workspaces/${wsId}/objectives`,
      `Due ${o.due_date}`));
  db.prepare(`SELECT id, title, status FROM security_objectives
    WHERE workspace_id=? AND status='off_track'`)
    .all(wsId).forEach(o => push('high', 'objective',
      `Objective off-track: ${o.title}`,
      `/workspaces/${wsId}/objectives`, ''));

  // ISMS-stale signals — last MRM / audit older than 12 months
  const lastMrm = db.prepare(`SELECT meeting_date FROM mrms WHERE workspace_id=? AND status='complete' ORDER BY meeting_date DESC LIMIT 1`).get(wsId);
  if (!lastMrm) push('medium', 'mrm', 'No completed management review on record', `/workspaces/${wsId}/mrms`, '');
  else if (lastMrm.meeting_date < new Date(Date.now() - 365*86400000).toISOString().slice(0,10))
    push('medium', 'mrm', 'Last management review > 12 months ago', `/workspaces/${wsId}/mrms`, `Last: ${lastMrm.meeting_date}`);

  const lastAudit = db.prepare(`SELECT audit_date FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL ORDER BY audit_date DESC LIMIT 1`).get(wsId);
  if (!lastAudit) push('medium', 'audit', 'No internal audit on record', `/workspaces/${wsId}/audits`, '');
  else if (lastAudit.audit_date < new Date(Date.now() - 365*86400000).toISOString().slice(0,10))
    push('medium', 'audit', 'Last internal audit > 12 months ago', `/workspaces/${wsId}/audits`, `Last: ${lastAudit.audit_date}`);

  // Sort: high before medium, newer/sooner deadlines first within severity
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
  return items;
}

app.get('/workspaces/:wsId/notifications', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'unread';
  let q = `SELECT * FROM notifications WHERE workspace_id=? AND (user_id IS NULL OR user_id=?)`;
  if (filter === 'unread') q += ` AND read_at IS NULL AND dismissed_at IS NULL`;
  else if (filter === 'all') q += ` AND dismissed_at IS NULL`;
  q += ` ORDER BY created_at DESC LIMIT 200`;
  const list = db.prepare(q).all(req.workspace.id, req.user.id);
  // Augment with computed items so the inbox always shows live actionable
  // signals, even before any notifications have been written by background jobs.
  const computed = computeNeedsAttention(req.workspace.id);
  res.render('notifications', { user: req.user, ws: req.workspace, notifications: list, filter, computed });
});

app.post('/workspaces/:wsId/notifications/:id/read', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  redirectBack(req, res);
});
app.post('/workspaces/:wsId/notifications/:id/dismiss', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`UPDATE notifications SET dismissed_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  redirectBack(req, res);
});
app.post('/workspaces/:wsId/notifications/mark-all-read', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND read_at IS NULL`).run(req.workspace.id);
  redirectBack(req, res);
});

// Tier B.8 — Calendar view aggregating every due-dated item across the workspace.
// Month grid; navigate prev/next via ?month=YYYY-MM. Pulls audits, MRMs,
// NCs, cert events, doc reviews, treatment actions, risk-acceptance expiries.
app.get('/workspaces/:wsId/calendar', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const today = new Date();
  const monthStr = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month
                  : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2,'0')}`;
  const [yr, mo] = monthStr.split('-').map(n => parseInt(n, 10));
  const monthStart = `${monthStr}-01`;
  const nextMo = new Date(yr, mo, 1).toISOString().slice(0, 10); // first of next month
  const prevMo = new Date(yr, mo - 2, 1).toISOString().slice(0, 7);
  const nextLabel = new Date(yr, mo, 1).toISOString().slice(0, 7);

  // Aggregate every dated item that falls inside the visible window
  // (first to last of selected month).
  const events = [];
  const add = (date, kind, title, link, severity) => {
    if (!date) return;
    if (date < monthStart || date >= nextMo) return;
    events.push({ date, kind, title, link, severity });
  };

  db.prepare(`SELECT id, title, audit_date FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL`).all(wsId)
    .forEach(a => add(a.audit_date, 'audit', a.title, `/workspaces/${wsId}/audits/${a.id}`, 'low'));
  db.prepare(`SELECT id, meeting_date FROM mrms WHERE workspace_id=? AND meeting_date IS NOT NULL`).all(wsId)
    .forEach(m => add(m.meeting_date, 'mrm', `MRM`, `/workspaces/${wsId}/mrms/${m.id}`, 'low'));
  db.prepare(`SELECT id, title, due_date, status FROM nonconformities WHERE workspace_id=? AND due_date IS NOT NULL`).all(wsId)
    .forEach(n => add(n.due_date, 'nc', n.title, `/workspaces/${wsId}/nonconformities/${n.id}`, n.status === 'closed' ? 'low' : 'high'));
  db.prepare(`SELECT id, event_type, planned_date, status FROM cert_cycle_events WHERE workspace_id=? AND planned_date IS NOT NULL`).all(wsId)
    .forEach(e => add(e.planned_date, 'cert', e.event_type.replace(/_/g, ' '), `/workspaces/${wsId}/cert-cycle`, 'medium'));
  db.prepare(`SELECT id, name, next_review_date FROM generated_docs WHERE workspace_id=? AND next_review_date IS NOT NULL`).all(wsId)
    .forEach(d => add(d.next_review_date, 'doc-review', `Review: ${d.name}`, `/workspaces/${wsId}/documents/${d.id}`, 'medium'));
  db.prepare(`SELECT rta.id, rta.title, rta.due_date, rta.status, rta.risk_id FROM risk_treatment_actions rta WHERE rta.workspace_id=? AND rta.due_date IS NOT NULL`).all(wsId)
    .forEach(a => add(a.due_date, 'treatment', a.title, `/workspaces/${wsId}/risks/${a.risk_id}`, a.status === 'done' ? 'low' : 'medium'));
  db.prepare(`SELECT a.id, a.expires_at, a.risk_id, r.title FROM risk_acceptances a INNER JOIN risks r ON r.id=a.risk_id WHERE a.workspace_id=? AND a.revoked_at IS NULL AND a.expires_at IS NOT NULL`).all(wsId)
    .forEach(a => add(a.expires_at, 'risk-accept', `R-${a.risk_id} acceptance expires`, `/workspaces/${wsId}/risks/${a.risk_id}`, 'medium'));

  // Group by date for the grid
  const byDate = {};
  events.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });

  // Build month grid (with Sun-Sat layout, padded)
  const firstDay = new Date(yr, mo - 1, 1).getDay(); // 0..6
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${monthStr}-${String(d).padStart(2,'0')}`;
    cells.push({ day: d, date, events: byDate[date] || [] });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  res.render('calendar', {
    user: req.user, ws: req.workspace, monthStr, prevMo, nextMo: nextLabel,
    cells, totalEvents: events.length,
    monthLabel: new Date(yr, mo - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' })
  });
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
  if (!title) return redirectBack(req, res);
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

// ==================== METHODOLOGY LIBRARY (PRESETS) ====================
const METHODOLOGY_PRESETS = require('./data/methodology-presets');

app.post('/workspaces/:wsId/risk-methodology/preset/:key', requireAuth, requireWorkspace, requirePermission('risk.methodology'), (req, res) => {
  const preset = METHODOLOGY_PRESETS[req.params.key];
  if (!preset) return redirectBack(req, res);
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

// ==================== FIRM CONTENT LIBRARY ====================
// The firm's own curated content — risks today, policy templates and control
// narratives later. Clone into a workspace with one click so junior consultants
// don't reinvent the wheel each engagement.

function seedFirmRiskLibraryIfEmpty(firmId) {
  const c = db.prepare('SELECT COUNT(*) c FROM firm_risk_library WHERE firm_id=?').get(firmId).c;
  if (c > 0) return 0;
  const SHIPPED = require('./data/risk-library');
  const ins = db.prepare(`INSERT INTO firm_risk_library
    (firm_id, title, description, threat, vulnerability, suggested_likelihood, suggested_impact, suggested_controls, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const r of SHIPPED) {
      ins.run(firmId, r.title, r.description || null, r.threat || null, r.vulnerability || null,
        3, 3, (r.suggested_controls || []).join(','), r.domain || null);
    }
  });
  tx();
  return SHIPPED.length;
}

app.get('/firm/library', requireAuth, (req, res) => {
  const firmId = getActiveFirmId(req);
  if (!firmId) return res.redirect('/tenants');
  seedFirmRiskLibraryIfEmpty(firmId);
  const counts = {
    risks: db.prepare('SELECT COUNT(*) c FROM firm_risk_library WHERE firm_id=?').get(firmId).c,
  };
  res.render('firm_library', { user: req.user, ws: null, counts });
});

app.get('/firm/library/risks', requireAuth, (req, res) => {
  const firmId = getActiveFirmId(req);
  if (!firmId) return res.redirect('/tenants');
  seedFirmRiskLibraryIfEmpty(firmId);
  const filterSector = (req.query.sector || '').trim();
  const filterDomain = (req.query.domain || '').trim();
  const search = (req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`SELECT * FROM firm_risk_library WHERE firm_id=? ORDER BY domain, title`).all(firmId);
  if (filterSector) rows = rows.filter(r => (r.sector || '').toLowerCase() === filterSector.toLowerCase());
  if (filterDomain) rows = rows.filter(r => (r.domain || '').toLowerCase() === filterDomain.toLowerCase());
  if (search) rows = rows.filter(r =>
    (r.title || '').toLowerCase().includes(search) ||
    (r.description || '').toLowerCase().includes(search) ||
    (r.tags || '').toLowerCase().includes(search));
  // Distinct values for the filter dropdowns.
  const sectors = [...new Set(db.prepare('SELECT DISTINCT sector FROM firm_risk_library WHERE firm_id=? AND sector IS NOT NULL').all(firmId).map(r => r.sector))];
  const domains = [...new Set(db.prepare('SELECT DISTINCT domain FROM firm_risk_library WHERE firm_id=? AND domain IS NOT NULL').all(firmId).map(r => r.domain))];
  res.render('firm_library_risks', { user: req.user, ws: null, rows, sectors, domains, filterSector, filterDomain, search });
});

app.post('/firm/library/risks', requireAuth, (req, res) => {
  const firmId = getActiveFirmId(req);
  if (!firmId) return res.redirect('/tenants');
  const { title, description, threat, vulnerability, domain, sector, tags,
    suggested_likelihood, suggested_impact, suggested_treatment, suggested_controls, notes } = req.body;
  if (!(title || '').trim()) return redirectBack(req, res, 'Title is required', 'error');
  db.prepare(`INSERT INTO firm_risk_library
    (firm_id, title, description, threat, vulnerability, domain, sector, tags,
     suggested_likelihood, suggested_impact, suggested_treatment, suggested_controls, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(firmId, title.trim(), description || null, threat || null, vulnerability || null,
      domain || null, sector || null, tags || null,
      parseInt(suggested_likelihood, 10) || null, parseInt(suggested_impact, 10) || null,
      suggested_treatment || null, suggested_controls || null, notes || null);
  res.redirect('/firm/library/risks');
});

app.post('/firm/library/risks/:id/update', requireAuth, (req, res) => {
  const firmId = getActiveFirmId(req);
  const id = parseInt(req.params.id, 10);
  const { title, description, threat, vulnerability, domain, sector, tags,
    suggested_likelihood, suggested_impact, suggested_treatment, suggested_controls, notes } = req.body;
  db.prepare(`UPDATE firm_risk_library SET title=?, description=?, threat=?, vulnerability=?,
    domain=?, sector=?, tags=?, suggested_likelihood=?, suggested_impact=?,
    suggested_treatment=?, suggested_controls=?, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND firm_id=?`)
    .run(title || '', description || null, threat || null, vulnerability || null,
      domain || null, sector || null, tags || null,
      parseInt(suggested_likelihood, 10) || null, parseInt(suggested_impact, 10) || null,
      suggested_treatment || null, suggested_controls || null, notes || null, id, firmId);
  res.redirect('/firm/library/risks');
});

app.post('/firm/library/risks/:id/delete', requireAuth, (req, res) => {
  const firmId = getActiveFirmId(req);
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM firm_risk_library WHERE id=? AND firm_id=?').run(id, firmId);
  res.redirect('/firm/library/risks');
});

// Re-seed the shipped starter library on top of the existing firm content.
// Skips entries the firm already has by title (idempotent for the starter set).
app.post('/firm/library/risks/reseed', requireAuth, (req, res) => {
  const firmId = getActiveFirmId(req);
  if (!firmId) return res.redirect('/tenants');
  const SHIPPED = require('./data/risk-library');
  const have = new Set(db.prepare('SELECT title FROM firm_risk_library WHERE firm_id=?').all(firmId).map(r => r.title));
  const ins = db.prepare(`INSERT INTO firm_risk_library
    (firm_id, title, description, threat, vulnerability, suggested_likelihood, suggested_impact, suggested_controls, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  const tx = db.transaction(() => {
    for (const r of SHIPPED) {
      if (have.has(r.title)) continue;
      ins.run(firmId, r.title, r.description || null, r.threat || null, r.vulnerability || null,
        3, 3, (r.suggested_controls || []).join(','), r.domain || null);
      added++;
    }
  });
  tx();
  res.redirect(withToast('/firm/library/risks', `Added ${added} starter risks`));
});

// Clone the firm library into a workspace's risk register. Existing risks with
// the same title are not duplicated. If the workspace has a sector set, the
// matching overlay's risks are merged into the firm library *first* so the
// clone picks them up — this is the "industry overlay pack" effect.
function applySectorOverlayToFirmLibrary(firmId, sector) {
  if (!sector) return 0;
  const overlay = SECTOR_OVERLAYS.getOverlay(sector);
  if (!overlay) return 0;
  const have = new Set(db.prepare('SELECT title FROM firm_risk_library WHERE firm_id=?').all(firmId).map(r => r.title));
  const ins = db.prepare(`INSERT INTO firm_risk_library
    (firm_id, title, description, threat, vulnerability, suggested_likelihood, suggested_impact,
     suggested_treatment, suggested_controls, domain, sector, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  const tx = db.transaction(() => {
    for (const r of overlay.extraRisks) {
      if (have.has(r.title)) continue;
      ins.run(firmId, r.title, r.description || null, r.threat || null, r.vulnerability || null,
        r.suggested_likelihood || null, r.suggested_impact || null,
        r.suggested_treatment || null, r.suggested_controls || null,
        r.domain || null, r.sector || null, r.tags || null);
      added++;
    }
  });
  tx();
  return added;
}

app.post('/workspaces/:wsId/risks/clone-firm-library', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const firmId = req.workspace.firm_id;
  // Make sure the firm library is up-to-date with the workspace's sector
  // overlay before cloning. Idempotent.
  const overlayAdded = applySectorOverlayToFirmLibrary(firmId, req.workspace.sector);
  const lib = db.prepare(`SELECT * FROM firm_risk_library WHERE firm_id=? ORDER BY domain, title`).all(firmId);
  const have = new Set(db.prepare(`SELECT title FROM risks WHERE workspace_id=?`).all(req.workspace.id).map(r => r.title));
  const ins = db.prepare(`INSERT INTO risks
    (workspace_id, title, description, threat, vulnerability, likelihood, impact, owner_name, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`);
  let added = 0;
  const tx = db.transaction(() => {
    for (const r of lib) {
      if (have.has(r.title)) continue;
      ins.run(req.workspace.id, r.title, r.description, r.threat, r.vulnerability,
        r.suggested_likelihood || 3, r.suggested_impact || 3, '');
      added++;
    }
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'risk_clone_firm_library', 'risk', null, { added, overlay_added: overlayAdded }, auditCtx(req));
  const msg = overlayAdded > 0
    ? `Cloned ${added} risks from firm library (incl. ${overlayAdded} from ${req.workspace.sector} overlay)`
    : `Cloned ${added} risks from firm library`;
  res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, msg));
});

// ==================== EXEC BRIEF (one-page CISO/board readout) ====================
// Single-page health summary that renders as one screen, prints to one A4
// page. Built for the sponsor's monthly skim, not for the consultant's
// detail work. Includes: readiness now, velocity (gap closure trend),
// residual-risk monetary estimate, top-5 risks, top-5 NCs.

app.get('/workspaces/:wsId/exec-brief', requireAuth, requireWorkspace, (req, res) => {
  const ws = req.workspace;
  const readiness = computeReadiness(ws);

  // Velocity = controls moved to Implemented in last 30 days vs the prior 30.
  const velNow = db.prepare(`SELECT COUNT(*) c FROM control_state_history
    WHERE workspace_id=? AND status='Implemented'
    AND snapshot_at >= datetime('now','-30 days')`).get(ws.id).c;
  const velPrior = db.prepare(`SELECT COUNT(*) c FROM control_state_history
    WHERE workspace_id=? AND status='Implemented'
    AND snapshot_at >= datetime('now','-60 days')
    AND snapshot_at < datetime('now','-30 days')`).get(ws.id).c;
  const velocityDelta = velNow - velPrior;

  // Residual-risk financial estimate. ISO doesn't mandate $ — but a board
  // wants one. Use Annual Loss Expectancy: SLE × ARO heuristic.
  // For each open risk, treat (likelihood / 5) as ARO and (impact * tier) as
  // SLE. Tier defaults to $50k * impact (1=$50k, 5=$250k) — configurable
  // via workspace setting later.
  const tierBase = 50000;
  const openRisks = db.prepare(`SELECT id, title, likelihood, impact, owner_name FROM risks
    WHERE workspace_id=? AND status NOT IN ('closed','accepted')`).all(ws.id);
  let aleSum = 0;
  for (const r of openRisks) {
    const aro = (r.likelihood || 3) / 5;
    const sle = (r.impact || 3) * tierBase;
    aleSum += aro * sle;
  }
  const residualAle = Math.round(aleSum);

  // Top 5 by inherent score
  const topRisks = openRisks
    .map(r => ({ ...r, score: (r.likelihood || 0) * (r.impact || 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Top open NCs by severity then due date
  const topNCs = db.prepare(`SELECT id, title, severity, due_date, status FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified')
    ORDER BY CASE severity WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, due_date
    LIMIT 5`).all(ws.id);

  // Total open NC counts for the headline
  const ncTotals = db.prepare(`SELECT
    SUM(CASE WHEN severity='major' AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS major,
    SUM(CASE WHEN severity='minor' AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS minor,
    SUM(CASE WHEN due_date < date('now') AND status NOT IN ('closed','verified') THEN 1 ELSE 0 END) AS overdue
    FROM nonconformities WHERE workspace_id=?`).get(ws.id);

  // Engagement plan progress (if used)
  const planTotal = require('./data/engagement-plan').flatten().length;
  const planDone = db.prepare(`SELECT COUNT(*) c FROM engagement_plan_progress
    WHERE workspace_id=? AND completed_at IS NOT NULL`).get(ws.id).c;

  res.render('exec_brief', {
    user: req.user, ws,
    readiness,
    velocityNow: velNow, velocityPrior: velPrior, velocityDelta,
    residualAle, openRiskCount: openRisks.length,
    topRisks, topNCs, ncTotals,
    planTotal, planDone, planPct: planTotal ? Math.round(planDone / planTotal * 100) : 0,
  });
});

// ==================== PRIORITIZED ACTIONS (readiness-lift scoring) ====================
// "If you fix these 5 in this order, readiness goes from X% to Y%."
// Pulls fixable items from across the workspace (NCs, missing docs, not-
// implemented controls, key flags), assigns each a readiness-lift estimate
// (derived from the same Stage 1 formula computeReadiness uses) and an
// effort tag (S/M/L), sorts by lift/effort. The top of the list is the
// consultant's recommended fix order for the next sprint.

app.get('/workspaces/:wsId/prioritized-actions', requireAuth, requireWorkspace, (req, res) => {
  const ws = req.workspace;
  const readiness = computeReadiness(ws);

  // Stage 1 weights (must match computeReadiness)
  const W = { records: 0.30, controls: 0.35, flags: 0.15, mrm: 0.10, audit: 0.10 };
  const totalItems = db.prepare('SELECT COUNT(*) c FROM iso_items').get().c;
  const recordsTotal = readiness.records.total || 1;

  const liftPerControl = W.controls * (1 / totalItems) * 100; // ~0.30% per control
  const liftPerDoc = W.records * (1 / recordsTotal) * 100;
  const liftPerHighFlag = W.flags * 0.20 * 100; // ~3% per high-severity flag closed (1/5 cap)
  const liftPerMrm = W.mrm * 100;               // 10% if no MRM yet
  const liftPerAudit = W.audit * 100;           // 10% if no audit yet

  const actions = [];

  // Open NCs — each closure removes an audit finding and is high-priority.
  const openNCs = db.prepare(`SELECT id, title, severity, due_date, iso_item_id FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified')`).all(ws.id);
  for (const nc of openNCs) {
    const sev = nc.severity || 'minor';
    actions.push({
      kind: 'nc', id: nc.id, title: nc.title,
      lift: sev === 'major' ? liftPerHighFlag : liftPerHighFlag * 0.5,
      effort: sev === 'major' ? 3 : 2,
      effortLabel: sev === 'major' ? 'L' : 'M',
      reason: `Close ${sev} NC (closure removes a high-impact flag from readiness)`,
      href: `/workspaces/${ws.id}/nonconformities/${nc.id}`,
    });
  }

  // Not-Implemented + Partially-Implemented controls flagged as in-scope.
  // Sort by maturity asc — "0" maturity controls are the cheapest single-step
  // wins, "Partial" -> "Implemented" usually means closing one specific gap.
  const gapControls = db.prepare(`SELECT cs.iso_item_id, cs.status, cs.maturity, i.title
    FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.applicability='included'
      AND i.type='control'
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')`).all(ws.id);
  for (const c of gapControls) {
    // Partial closures don't move ctrlScore (still not Implemented), but they
    // signal momentum. Score them lower so Not-Implemented sorts above.
    const lift = c.status === 'Not Implemented' ? liftPerControl : liftPerControl * 0.4;
    const effort = c.status === 'Partially Implemented' ? 1 : 2;
    actions.push({
      kind: 'control', id: c.iso_item_id, title: c.title,
      lift, effort,
      effortLabel: effort === 1 ? 'S' : 'M',
      reason: `${c.iso_item_id.toUpperCase()} → Implemented (status now: ${c.status})`,
      href: `/workspaces/${ws.id}/controls/assess/${c.iso_item_id}`,
    });
  }

  // Missing mandatory documents — each found-row is a recordsScore step.
  // readiness.records.checks has { id, label, found } per check.
  const missingChecks = (readiness.records.checks || []).filter(c => !c.found);
  for (const m of missingChecks) {
    actions.push({
      kind: 'doc', id: m.id, title: `Document: ${m.label}`,
      lift: liftPerDoc,
      effort: 1,
      effortLabel: 'S',
      reason: 'Mandatory documented information missing — write, approve, publish',
      href: `/workspaces/${ws.id}/documents`,
    });
  }

  // First MRM and first audit — large one-shot lifts.
  if (!db.prepare(`SELECT 1 FROM mrms WHERE workspace_id=? AND status='complete' LIMIT 1`).get(ws.id)) {
    actions.push({
      kind: 'mrm', id: 'first-mrm', title: 'Run first management review',
      lift: liftPerMrm, effort: 2, effortLabel: 'M',
      reason: 'Stage 1 readiness scores 0/10 here until at least one MRM is complete',
      href: `/workspaces/${ws.id}/mrms`,
    });
  }
  if (!db.prepare(`SELECT 1 FROM audits WHERE workspace_id=? AND status='complete' LIMIT 1`).get(ws.id)) {
    actions.push({
      kind: 'audit', id: 'first-audit', title: 'Conduct first internal audit',
      lift: liftPerAudit, effort: 3, effortLabel: 'L',
      reason: 'Stage 1 readiness scores 0/10 here until at least one internal audit is complete',
      href: `/workspaces/${ws.id}/audits`,
    });
  }

  // Score each action by lift / effort. Tied scores break by lift desc.
  for (const a of actions) a.score = a.lift / a.effort;
  actions.sort((a, b) => b.score - a.score || b.lift - a.lift);

  // Cumulative-lift preview for the first N items
  const top = actions.slice(0, 10);
  let running = readiness.stage1;
  for (const a of top) { running += a.lift; a.runningStage1 = Math.round(Math.min(100, running)); }
  const projected5 = top.slice(0, 5).reduce((s, a) => s + a.lift, 0);
  const projected10 = top.reduce((s, a) => s + a.lift, 0);

  res.render('prioritized_actions', {
    user: req.user, ws,
    actions: top, allCount: actions.length,
    currentStage1: readiness.stage1,
    projected5: Math.min(100, Math.round(readiness.stage1 + projected5)),
    projected10: Math.min(100, Math.round(readiness.stage1 + projected10)),
  });
});

// ==================== CONSULTANT PLAYBOOKS ====================
// Firm-level reference material — kickoff agenda, scoping workshop, risk
// workshop facilitator script. Read-only. Lives at /playbooks (no workspace
// context required) so a junior consultant can open it during any client call.
const PLAYBOOKS = require('./data/playbooks');

app.get('/playbooks', requireAuth, (req, res) => {
  res.render('playbooks_index', { user: req.user, ws: null, playbooks: PLAYBOOKS.PLAYBOOK_INDEX });
});

app.get('/playbooks/:id', requireAuth, (req, res) => {
  const pb = PLAYBOOKS.PLAYBOOKS[req.params.id];
  if (!pb) return res.status(404).render('error', { user: req.user, message: 'Playbook not found' });
  res.render('playbook_detail', { user: req.user, ws: null, playbook: pb });
});

// ==================== ENGAGEMENT INTAKE + 12-WEEK PLAN ====================
// Extracted to routes/engagement.js. Same dependency-injection pattern as
// routes/tenants.js — engagement routes get db + middleware via deps.
require('./routes/engagement').register(app, {
  db, requireAuth, requireWorkspace, withToast, logAction, auditCtx,
});

// ==================== INTERESTED PARTIES (clause 4.2) ====================
app.get('/workspaces/:wsId/interested-parties', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT * FROM interested_parties WHERE workspace_id=? ORDER BY party_type, party`)
    .all(req.workspace.id);
  res.render('interested_parties', {
    user: req.user, ws: req.workspace, title: 'Interested parties', active: 'interested-parties', rows
  });
});

app.post('/workspaces/:wsId/interested-parties', requireAuth, requireWorkspace, (req, res) => {
  const b = req.body;
  if (!b.party || !b.party.trim()) return redirectBack(req, res, 'Party name is required', 'error');
  db.prepare(`INSERT INTO interested_parties
    (workspace_id, party, party_type, needs, how_addressed, owner, review_cadence, last_reviewed, next_review, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, b.party.trim(), b.party_type || null,
         b.needs || null, b.how_addressed || null, b.owner || null,
         b.review_cadence || null, b.last_reviewed || null, b.next_review || null, b.notes || null);
  logAction(req.user.id, req.workspace.id, 'create_interested_party', 'interested_party', null, { party: b.party });
  res.redirect(`/workspaces/${req.workspace.id}/interested-parties`);
});

app.post('/workspaces/:wsId/interested-parties/:id', requireAuth, requireWorkspace, (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE interested_parties SET
    party=?, party_type=?, needs=?, how_addressed=?, owner=?, review_cadence=?, last_reviewed=?, next_review=?, notes=?,
    updated_at=datetime('now')
    WHERE id=? AND workspace_id=?`)
    .run(b.party, b.party_type || null, b.needs || null, b.how_addressed || null, b.owner || null,
         b.review_cadence || null, b.last_reviewed || null, b.next_review || null, b.notes || null,
         req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/interested-parties`);
});

app.post('/workspaces/:wsId/interested-parties/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare('DELETE FROM interested_parties WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/interested-parties`);
});

// ==================== INFORMATION SECURITY OBJECTIVES (clause 6.2) ====================
app.get('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT * FROM security_objectives WHERE workspace_id=? ORDER BY due_date IS NULL, due_date, id`)
    .all(req.workspace.id);
  res.render('objectives', {
    user: req.user, ws: req.workspace, title: 'Security objectives', active: 'objectives', rows
  });
});

app.post('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, (req, res) => {
  const b = req.body;
  if (!b.title || !b.title.trim()) return redirectBack(req, res, 'Objective title is required', 'error');
  db.prepare(`INSERT INTO security_objectives
    (workspace_id, title, description, measurement, target_value, current_value, owner, due_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, b.title.trim(), b.description || null, b.measurement || null,
         b.target_value || null, b.current_value || null, b.owner || null,
         b.due_date || null, b.status || 'on_track', b.notes || null);
  logAction(req.user.id, req.workspace.id, 'create_objective', 'objective', null, { title: b.title });
  res.redirect(`/workspaces/${req.workspace.id}/objectives`);
});

app.post('/workspaces/:wsId/objectives/:id', requireAuth, requireWorkspace, (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE security_objectives SET
    title=?, description=?, measurement=?, target_value=?, current_value=?, owner=?, due_date=?, status=?, notes=?,
    updated_at=datetime('now')
    WHERE id=? AND workspace_id=?`)
    .run(b.title, b.description || null, b.measurement || null,
         b.target_value || null, b.current_value || null, b.owner || null,
         b.due_date || null, b.status || 'on_track', b.notes || null,
         req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/objectives`);
});

app.post('/workspaces/:wsId/objectives/:id/delete', requireAuth, requireWorkspace, (req, res) => {
  db.prepare('DELETE FROM security_objectives WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/objectives`);
});

// ==================== CUSTOM (NON-ANNEX-A) CONTROLS ====================
// 27001:2022 explicitly allows controls outside Annex A. They sit alongside
// the 93 Annex A controls in the SoA.
app.post('/workspaces/:wsId/soa/custom-controls', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const b = req.body;
  if (!b.code || !b.title) return redirectBack(req, res, 'Both code and title are required', 'error');
  db.prepare(`INSERT INTO soa_custom_controls
    (workspace_id, code, title, description, source_framework, applicability, inclusion_justification, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, b.code.trim(), b.title.trim(),
         b.description || null, b.source_framework || null,
         b.applicability || 'included', b.inclusion_justification || null,
         b.status || 'Not Assessed');
  logAction(req.user.id, req.workspace.id, 'create_custom_control', 'custom_control', null, { code: b.code });
  res.redirect(`/workspaces/${req.workspace.id}/soa`);
});

app.post('/workspaces/:wsId/soa/custom-controls/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE soa_custom_controls SET
    code=?, title=?, description=?, source_framework=?, applicability=?, inclusion_justification=?, exclusion_justification=?, status=?, notes=?,
    updated_at=datetime('now')
    WHERE id=? AND workspace_id=?`)
    .run(b.code, b.title, b.description || null, b.source_framework || null,
         b.applicability || 'included', b.inclusion_justification || null, b.exclusion_justification || null,
         b.status || 'Not Assessed', b.notes || null,
         req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/soa`);
});

app.post('/workspaces/:wsId/soa/custom-controls/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare('DELETE FROM soa_custom_controls WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/soa`);
});

// ==================== SOA METADATA HEADER ====================
// Update the latest snapshot's metadata (version / owner / approver / approved_at).
// If no snapshot exists, capture one first.
app.post('/workspaces/:wsId/soa/metadata', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const b = req.body;
  let latest = db.prepare(`SELECT id FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`)
    .get(req.workspace.id);
  if (!latest) {
    const snap = captureSoASnapshot(req.workspace.id, req.user.id, null, 'Initial', 'Metadata-driven snapshot');
    latest = { id: snap.id };
  }
  db.prepare(`UPDATE soa_snapshots SET version=?, owner=?, approved_by=?, approved_at=? WHERE id=?`)
    .run(b.version || null, b.owner || null, b.approved_by || null, b.approved_at || null, latest.id);
  logAction(req.user.id, req.workspace.id, 'update_soa_metadata', 'soa_snapshot', latest.id, b);
  res.redirect(`/workspaces/${req.workspace.id}/soa`);
});

// ==================== ENGAGEMENT DELIVERABLES ====================
// PDF/DOCX/ZIP exports the consultant produces at end-of-pass to hand to the
// client and to bring to the certification audit.

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function deliverableHtmlShell(title, ws, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
    <style>
      body{font-family:Calibri,sans-serif;font-size:11pt;line-height:1.45;color:#0F0F12;}
      h1{font-size:22pt;color:#0F0F12;margin:0 0 4pt;letter-spacing:-0.01em;}
      h2{font-size:14pt;color:#3730A3;margin:18pt 0 6pt;border-bottom:1pt solid #ECECEF;padding-bottom:3pt;}
      h3{font-size:12pt;color:#0F0F12;margin:12pt 0 4pt;}
      .meta{color:#71717A;font-size:9.5pt;}
      table{border-collapse:collapse;width:100%;margin:6pt 0;font-size:9.5pt;}
      th,td{border:1pt solid #D6D6DB;padding:4pt 6pt;text-align:left;vertical-align:top;}
      th{background:#F4F4F5;color:#0F0F12;font-weight:600;}
      .tag{display:inline-block;padding:1pt 5pt;border-radius:3pt;font-size:8.5pt;font-weight:600;}
      .tag-impl{background:#dcfce7;color:#15803d;}
      .tag-partial{background:#fef3c7;color:#a16207;}
      .tag-wip{background:#dbeafe;color:#1d4ed8;}
      .tag-noimpl{background:#fee2e2;color:#b91c1c;}
      .tag-na{background:#e5e7eb;color:#71717A;}
      .footer{color:#9C9CA5;font-size:8.5pt;text-align:center;margin-top:24pt;border-top:1pt solid #ECECEF;padding-top:6pt;}
    </style></head><body>
    <h1>${escHtml(title)}</h1>
    <p class="meta">${escHtml(ws.client_name || '')}${ws.industry ? ' · ' + escHtml(ws.industry) : ''} · Generated ${new Date().toISOString().slice(0,10)}</p>
    ${bodyHtml}
    <p class="footer">Generated by ISMS tool on ${new Date().toISOString()}</p>
    </body></html>`;
}
function statusTag(s) {
  if (!s) return '<span class="tag tag-na">—</span>';
  const cls = s === 'Implemented' ? 'tag-impl'
    : s === 'Partially Implemented' ? 'tag-partial'
    : s === 'Work In Progress' ? 'tag-wip'
    : s === 'Not Implemented' ? 'tag-noimpl'
    : 'tag-na';
  return `<span class="tag ${cls}">${escHtml(s)}</span>`;
}

// Risk Treatment Plan (clause 6.1.3.e) — formal document export pulling from
// the live risk register.
app.get('/workspaces/:wsId/export/rtp.docx', requireAuth, requireWorkspace, async (req, res) => {
  const ws = req.workspace;
  const risks = db.prepare(`SELECT r.* FROM risks r
    WHERE r.workspace_id=? ORDER BY (r.likelihood * r.impact) DESC, r.id`).all(ws.id);
  const actionsByRisk = {};
  if (risks.length) {
    const rids = risks.map(r => r.id);
    const ph = rids.map(() => '?').join(',');
    db.prepare(`SELECT * FROM risk_treatment_actions WHERE risk_id IN (${ph}) ORDER BY due_date IS NULL, due_date`)
      .all(...rids).forEach(a => { (actionsByRisk[a.risk_id] = actionsByRisk[a.risk_id] || []).push(a); });
  }
  const ctrlByRisk = {};
  if (risks.length) {
    const rids = risks.map(r => r.id);
    const ph = rids.map(() => '?').join(',');
    db.prepare(`SELECT rc.risk_id, rc.iso_item_id, i.title FROM risk_controls rc
      INNER JOIN iso_items i ON i.id = rc.iso_item_id WHERE rc.risk_id IN (${ph})`)
      .all(...rids).forEach(c => { (ctrlByRisk[c.risk_id] = ctrlByRisk[c.risk_id] || []).push(c); });
  }

  let body = '<h2>Methodology</h2><p>This Risk Treatment Plan documents, for every risk in the register, the chosen treatment option, the controls applied, the responsible owner, and the implementation timeframe — as required by ISO/IEC 27001:2022 clause 6.1.3.e.</p>';
  body += `<p>Risks: <strong>${risks.length}</strong></p>`;
  body += '<h2>Treatment plan by risk</h2>';
  if (risks.length === 0) {
    body += '<p><em>No risks recorded yet.</em></p>';
  } else {
    body += '<table><thead><tr><th width="8%">ID</th><th>Risk</th><th width="10%">L×I</th><th width="10%">Treatment</th><th width="14%">Owner</th><th>Controls applied</th><th>Actions</th></tr></thead><tbody>';
    for (const r of risks) {
      const ctrls = (ctrlByRisk[r.id] || []).map(c => escHtml(c.iso_item_id.replace('annex-','').toUpperCase()) + ' ' + escHtml(c.title.replace(/^A\.[0-9.]+ /,''))).join('<br>') || '<em class="meta">—</em>';
      const acts = (actionsByRisk[r.id] || []).map(a => `<strong>${escHtml(a.title)}</strong><br><span class="meta">${escHtml(a.assignee_role || '')}${a.due_date ? ' · due ' + escHtml(a.due_date) : ''} · ${escHtml(a.status || '')}</span>`).join('<br><br>') || '<em class="meta">—</em>';
      body += `<tr><td>R-${r.id}</td><td><strong>${escHtml(r.title)}</strong>${r.description ? '<br><span class="meta">' + escHtml(r.description) + '</span>' : ''}</td><td>${r.likelihood || '—'}×${r.impact || '—'}</td><td>${escHtml(r.treatment || '—')}</td><td>${escHtml(r.owner_name || '—')}</td><td>${ctrls}</td><td>${acts}</td></tr>`;
    }
    body += '</tbody></table>';
  }
  const html = deliverableHtmlShell('Risk Treatment Plan', ws, body);
  const buf = await htmlToDocx(html, null, { table: { row: { cantSplit: true } } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="risk-treatment-plan-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
  res.send(buf);
});

// Gap Assessment Report — produced at end-of-pass for handoff.
app.get('/workspaces/:wsId/export/gap-report.docx', requireAuth, requireWorkspace, async (req, res) => {
  const ws = req.workspace;
  const passId = req.query.pass ? parseInt(req.query.pass, 10) : null;
  let pass = null;
  if (passId) {
    pass = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(passId, ws.id);
  }
  if (!pass) {
    pass = db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=?
      ORDER BY (status='in_progress') DESC, pass_number DESC LIMIT 1`).get(ws.id);
  }

  // For each control: end-of-pass status (using the same logic as the diff route).
  const items = db.prepare(`SELECT i.id, i.type, i.title, i.sort_order
    FROM iso_items i WHERE i.type IN ('clause','control') ORDER BY i.sort_order`).all();
  const stmt = db.prepare(`SELECT h.status, h.maturity, h.applicability, h.notes
    FROM control_state_history h
    INNER JOIN assessment_passes p ON p.id = h.pass_id
    WHERE h.workspace_id=? AND h.iso_item_id=? AND p.pass_number <= ?
    ORDER BY p.pass_number DESC, h.snapshot_at DESC, h.id DESC LIMIT 1`);
  const rows = pass ? items.map(it => {
    const r = stmt.get(ws.id, it.id, pass.pass_number) || { status:'Not Assessed', maturity:null, applicability:'undecided', notes:null };
    return { ...it, ...r, code: it.id.replace(/^annex-/,'').replace(/^clause-/,'').toUpperCase() };
  }) : [];

  // Group by category for the executive summary.
  const counts = { 'Implemented':0, 'Partially Implemented':0, 'Work In Progress':0, 'Not Implemented':0, 'Not Assessed':0, 'Not Applicable':0 };
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const total = rows.length;
  const gaps = rows.filter(r => ['Not Implemented','Partially Implemented','Work In Progress'].includes(r.status));
  const ncOpen = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified')`).get(ws.id).c;

  let body = '<h2>Executive summary</h2>';
  body += `<p>This report summarises the gap-assessment findings produced during <strong>Pass ${pass ? pass.pass_number : '—'}${pass && pass.label ? ' · ' + escHtml(pass.label) : ''}</strong>${pass && pass.completed_at ? ' (completed ' + pass.completed_at.slice(0,10) + ')' : pass && pass.status === 'in_progress' ? ' (in progress)' : ''}. The findings are based on documented evidence reviewed and consultant interviews.</p>`;
  body += '<table style="width:auto"><thead><tr><th>Status</th><th>Count</th><th>%</th></tr></thead><tbody>';
  for (const [s, c] of Object.entries(counts)) {
    body += `<tr><td>${statusTag(s)}</td><td>${c}</td><td>${total ? Math.round(c/total*100) : 0}%</td></tr>`;
  }
  body += `<tr><td><strong>Total</strong></td><td><strong>${total}</strong></td><td>100%</td></tr>`;
  body += '</tbody></table>';
  body += `<p>Open nonconformities at time of report: <strong>${ncOpen}</strong></p>`;

  body += '<h2>Identified gaps</h2>';
  if (gaps.length === 0) {
    body += '<p><em>No gaps identified at this pass.</em></p>';
  } else {
    body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th>Notes</th></tr></thead><tbody>';
    for (const g of gaps) {
      const cleanTitle = g.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
      body += `<tr><td>${escHtml(g.code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(g.status)}</td><td>${escHtml(g.notes || '')}</td></tr>`;
    }
    body += '</tbody></table>';
  }

  body += '<h2>Full assessment results</h2>';
  body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th width="8%">Maturity</th></tr></thead><tbody>';
  for (const r of rows) {
    const cleanTitle = r.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
    body += `<tr><td>${escHtml(r.code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(r.status)}</td><td>${r.maturity == null ? '—' : r.maturity}</td></tr>`;
  }
  body += '</tbody></table>';

  const title = `Gap Assessment Report — Pass ${pass ? pass.pass_number : ''}`;
  const html = deliverableHtmlShell(title, ws, body);
  const buf = await htmlToDocx(html, null, { table: { row: { cantSplit: true } } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="gap-assessment-report-${ws.id}-pass${pass ? pass.pass_number : 'X'}-${new Date().toISOString().slice(0,10)}.docx"`);
  res.send(buf);
});

// Recommendations memo — ranked, actionable handoff.
app.get('/workspaces/:wsId/export/recommendations.docx', requireAuth, requireWorkspace, async (req, res) => {
  const ws = req.workspace;
  // Pull rows where status is Not Implemented / Partially / WIP — ordered by severity.
  const items = db.prepare(`SELECT i.id, i.type, i.title, COALESCE(cs.status,'Not Assessed') AS status,
      cs.maturity, cs.notes
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') AND COALESCE(cs.status,'Not Assessed') IN ('Not Implemented','Partially Implemented','Work In Progress')
    ORDER BY (CASE COALESCE(cs.status,'Not Assessed')
      WHEN 'Not Implemented' THEN 0
      WHEN 'Partially Implemented' THEN 1
      WHEN 'Work In Progress' THEN 2 ELSE 3 END), i.sort_order`).all(ws.id);

  let body = '<h2>How to read this memo</h2><p>This memo lists recommended remediation activity from the most recent gap assessment, ranked by current implementation status. Each row identifies the clause / control, the current status, and the consultant\'s notes from the assessment. Implementation is the client\'s responsibility; the consultant will return to verify each item once the client signals it is complete.</p>';
  body += `<p>Items requiring action: <strong>${items.length}</strong></p>`;
  body += '<h2>Recommendations</h2>';
  if (items.length === 0) {
    body += '<p><em>No outstanding recommendations — every assessed item is at "Implemented".</em></p>';
  } else {
    body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th>Recommendation / consultant notes</th></tr></thead><tbody>';
    for (const r of items) {
      const code = r.id.replace(/^annex-/,'').replace(/^clause-/,'').toUpperCase();
      const cleanTitle = r.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
      body += `<tr><td>${escHtml(code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(r.status)}</td><td>${escHtml(r.notes || '')}</td></tr>`;
    }
    body += '</tbody></table>';
  }

  const html = deliverableHtmlShell('Recommendations Memo', ws, body);
  const buf = await htmlToDocx(html, null, { table: { row: { cantSplit: true } } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="recommendations-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
  res.send(buf);
});

// Stage 1/2 readiness pack — single ZIP with the management-system docs +
// linked evidence + manifest.
app.get('/workspaces/:wsId/export/readiness-pack.zip', requireAuth, requireWorkspace, async (req, res) => {
  const ws = req.workspace;
  const stage = (req.query.stage === '2') ? 2 : 1;
  const dateLabel = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="readiness-pack-stage${stage}-${ws.id}-${dateLabel}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { try { res.status(500).send(String(err)); } catch (_) {} });
  archive.pipe(res);

  // 1. SoA CSV (reuse the existing CSV format)
  const soaRows = db.prepare(`SELECT i.id, i.title, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.inclusion_justification, cs.exclusion_justification
    FROM iso_items i LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' ORDER BY i.sort_order`).all(ws.id);
  const customRows = db.prepare(`SELECT * FROM soa_custom_controls WHERE workspace_id=? ORDER BY code`).all(ws.id);
  const csvLines = ['id,title,applicability,status,justification'];
  function csvEsc(v) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
  for (const r of soaRows) {
    csvLines.push([r.id.replace('annex-','').toUpperCase(), csvEsc(r.title.replace(/^A\.[0-9.]+ /,'')), r.applicability, r.status, csvEsc(r.applicability === 'excluded' ? r.exclusion_justification : r.inclusion_justification)].join(','));
  }
  for (const c of customRows) {
    csvLines.push([csvEsc(c.code), csvEsc(c.title), c.applicability, c.status, csvEsc(c.applicability === 'excluded' ? c.exclusion_justification : c.inclusion_justification)].join(','));
  }
  archive.append(csvLines.join('\n'), { name: '01_soa.csv' });

  // 2. Risk Treatment Plan DOCX (call the same generator inline by re-rendering)
  const risks = db.prepare(`SELECT r.* FROM risks r
    WHERE r.workspace_id=? ORDER BY (r.likelihood*r.impact) DESC, r.id`).all(ws.id);
  let rtpBody = `<p>Risks: ${risks.length}</p><table><thead><tr><th>ID</th><th>Risk</th><th>L×I</th><th>Treatment</th><th>Owner</th></tr></thead><tbody>`;
  for (const r of risks) {
    rtpBody += `<tr><td>R-${r.id}</td><td>${escHtml(r.title)}</td><td>${r.likelihood || ''}×${r.impact || ''}</td><td>${escHtml(r.treatment || '')}</td><td>${escHtml(r.owner_name || '')}</td></tr>`;
  }
  rtpBody += '</tbody></table>';
  const rtpDocx = await htmlToDocx(deliverableHtmlShell('Risk Treatment Plan', ws, rtpBody), null, { table: { row: { cantSplit: true } } });
  archive.append(rtpDocx, { name: '02_risk_treatment_plan.docx' });

  // 3. Internal audit summary CSV
  const audits = db.prepare(`SELECT * FROM audits WHERE workspace_id=? ORDER BY audit_date DESC`).all(ws.id);
  const auditCsv = ['id,title,scope,audit_date,auditor,status,summary'];
  for (const a of audits) {
    auditCsv.push([a.id, csvEsc(a.title || ''), csvEsc(a.scope || ''), a.audit_date || '', csvEsc(a.auditor_name || ''), a.status || '', csvEsc(a.summary || '')].join(','));
  }
  archive.append(auditCsv.join('\n'), { name: '03_internal_audits.csv' });

  // 4. MRMs CSV
  const mrms = db.prepare(`SELECT * FROM mrms WHERE workspace_id=? ORDER BY meeting_date DESC`).all(ws.id);
  const mrmCsv = ['id,meeting_date,status,attendees'];
  for (const m of mrms) {
    mrmCsv.push([m.id, m.meeting_date || '', m.status || '', csvEsc(m.attendees || '')].join(','));
  }
  archive.append(mrmCsv.join('\n'), { name: '04_management_reviews.csv' });

  // 5. Interested parties CSV
  const ip = db.prepare(`SELECT * FROM interested_parties WHERE workspace_id=? ORDER BY party`).all(ws.id);
  const ipCsv = ['party,party_type,needs,how_addressed,owner,review_cadence,last_reviewed,next_review'];
  for (const r of ip) {
    ipCsv.push([csvEsc(r.party), csvEsc(r.party_type), csvEsc(r.needs), csvEsc(r.how_addressed), csvEsc(r.owner), csvEsc(r.review_cadence), r.last_reviewed || '', r.next_review || ''].join(','));
  }
  archive.append(ipCsv.join('\n'), { name: '05_interested_parties.csv' });

  // 6. Objectives CSV
  const objs = db.prepare(`SELECT * FROM security_objectives WHERE workspace_id=? ORDER BY due_date IS NULL, due_date`).all(ws.id);
  const objCsv = ['title,measurement,target_value,current_value,owner,due_date,status'];
  for (const o of objs) {
    objCsv.push([csvEsc(o.title), csvEsc(o.measurement), csvEsc(o.target_value), csvEsc(o.current_value), csvEsc(o.owner), o.due_date || '', o.status || ''].join(','));
  }
  archive.append(objCsv.join('\n'), { name: '06_objectives.csv' });

  // 7. Evidence files (active only) + manifest CSV
  const evidence = db.prepare(`SELECT e.*, u.name AS uploader,
    (SELECT GROUP_CONCAT(iso_item_id, '; ') FROM evidence_controls WHERE evidence_id=e.id) AS linked_controls
    FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
    WHERE e.workspace_id=? AND e.superseded_at IS NULL ORDER BY e.uploaded_at`).all(ws.id);
  const evCsv = ['id,filename,sha256,uploader,uploaded_at,period,valid_from,valid_until,linked_controls,description'];
  for (const e of evidence) {
    evCsv.push([e.id, csvEsc(e.filename), e.sha256 || '', csvEsc(e.uploader), e.uploaded_at ? e.uploaded_at.slice(0,19) : '', csvEsc(e.period_label), e.valid_from || '', e.valid_until || '', csvEsc(e.linked_controls), csvEsc(e.description)].join(','));
  }
  archive.append(evCsv.join('\n'), { name: '07_evidence_manifest.csv' });
  for (const e of evidence) {
    const found = resolveUploadPath(e.stored_path, ws.firm_id);
    if (found && fs.existsSync(found) && fs.statSync(found).isFile()) {
      archive.file(found, { name: `evidence/${e.id}-${e.filename}` });
    }
  }

  // README
  archive.append(
`Stage ${stage} readiness pack — ${ws.client_name || 'Workspace ' + ws.id}
Generated ${new Date().toISOString()}

Contents:
  01_soa.csv                — Statement of Applicability (Annex A + custom controls)
  02_risk_treatment_plan.docx — Formal RTP (clause 6.1.3.e)
  03_internal_audits.csv    — Internal audit programme history
  04_management_reviews.csv — MRM history
  05_interested_parties.csv — Clause 4.2 register
  06_objectives.csv         — Clause 6.2 register
  07_evidence_manifest.csv  — Index of every evidence file with SHA-256 + linked controls
  evidence/                 — Actual evidence artefacts (filename: <id>-<name>)

This is the artefact set a Stage ${stage} certification audit will request.
SHA-256 in the manifest lets the auditor verify nothing was altered after export.
`, { name: 'README.txt' });

  archive.finalize();
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
  if (pid && pid == req.params.id) return redirectBack(req, res);
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
  redirectBack(req, res);
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
  if (!phase || !description) return redirectBack(req, res);
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
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/incidents/:id/regulator-clock', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const { detected_at, regulator, hours } = req.body;
  if (!detected_at || !hours) return redirectBack(req, res);
  const due = new Date(new Date(detected_at).getTime() + parseFloat(hours) * 3600 * 1000).toISOString();
  db.prepare('UPDATE incidents SET notification_required_by=? WHERE id=? AND workspace_id=?').run(due, req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'set_regulator_clock', 'incident', req.params.id, { regulator, due }, auditCtx(req));
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/incidents/:id/notify-sent', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  db.prepare('UPDATE incidents SET notification_sent_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/incidents/:id/pir', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  db.prepare('UPDATE incidents SET pir_completed=1, pir_summary=? WHERE id=? AND workspace_id=?').run(req.body.pir_summary || null, req.params.id, req.workspace.id);
  redirectBack(req, res);
});

// ==================== SUPPLIER MONITORING + TERMINATION + CONCENTRATION ====================
app.post('/workspaces/:wsId/vendors/:id/monitoring', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const { source, score, grade, recorded_at, notes } = req.body;
  if (!source) return redirectBack(req, res);
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

// ==================== TASKS: TEMPLATES + TIME TRACKING ====================
app.get('/workspaces/:wsId/task-templates', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const templates = db.prepare(`SELECT * FROM task_templates WHERE workspace_id=? OR is_system=1 OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
  res.render('task_templates', { user: req.user, ws: req.workspace, templates });
});

app.post('/workspaces/:wsId/tasks/from-template/:tplId', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM task_templates WHERE id=?').get(req.params.tplId);
  if (!tpl) return redirectBack(req, res);
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

// ==================== ASSET RELATIONSHIPS + BULK IMPORT ====================
app.post('/workspaces/:wsId/assets/:id/relationships', requireAuth, requireWorkspace, requirePermission('asset.update'), (req, res) => {
  const { child_asset_id, relation, notes } = req.body;
  if (!child_asset_id || !relation) return redirectBack(req, res);
  try {
    db.prepare(`INSERT INTO asset_relationships (workspace_id, parent_asset_id, child_asset_id, relation, notes)
      VALUES (?, ?, ?, ?, ?)`).run(req.workspace.id, req.params.id, child_asset_id, relation, notes || null);
  } catch (_) {}
  res.redirect(`/workspaces/${req.workspace.id}/assets/${req.params.id}`);
});

app.post('/workspaces/:wsId/assets/relationships/:id/delete', requireAuth, requireWorkspace, requirePermission('asset.update'), (req, res) => {
  db.prepare('DELETE FROM asset_relationships WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  redirectBack(req, res);
});

app.get('/workspaces/:wsId/assets/:id', requireAuth, requireWorkspace, requirePermission('asset.view'), (req, res) => {
  const asset = db.prepare(`SELECT a.*, e.name AS entity_name FROM assets a LEFT JOIN entities e ON e.id=a.entity_id WHERE a.id=? AND a.workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!asset) return res.status(404).send('Not found');
  const parents = db.prepare(`SELECT r.*, p.name AS asset_name FROM asset_relationships r INNER JOIN assets p ON p.id=r.parent_asset_id WHERE r.child_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
  const children = db.prepare(`SELECT r.*, c.name AS asset_name FROM asset_relationships r INNER JOIN assets c ON c.id=r.child_asset_id WHERE r.parent_asset_id=? AND r.workspace_id=?`).all(asset.id, req.workspace.id);
  const allAssets = db.prepare('SELECT id, name FROM assets WHERE workspace_id=? AND id != ? ORDER BY name').all(req.workspace.id, asset.id);
  const linkedRisks = db.prepare(`SELECT r.* FROM risks r WHERE r.workspace_id=? AND r.asset_id=?`).all(req.workspace.id, asset.id);
  // Phase B: controls in scope for this asset = controls linked from any of this asset's risks
  const controlsInScope = db.prepare(`
    SELECT DISTINCT i.id, i.title, i.category,
      COALESCE(cs.applicability,'undecided') AS applicability,
      COALESCE(cs.status,'Not Assessed') AS status,
      (SELECT COUNT(*) FROM document_controls dc INNER JOIN generated_docs d ON d.id=dc.document_id WHERE dc.iso_item_id=i.id AND d.workspace_id=?) AS doc_count
    FROM iso_items i
    INNER JOIN risk_controls rc ON rc.iso_item_id = i.id
    INNER JOIN risks r ON r.id = rc.risk_id
    LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE r.asset_id = ? AND r.workspace_id = ?
    ORDER BY i.sort_order
  `).all(req.workspace.id, req.workspace.id, asset.id, req.workspace.id);
  res.render('asset_detail', { user: req.user, ws: req.workspace, asset, parents, children, allAssets, linkedRisks, controlsInScope });
});

app.post('/workspaces/:wsId/assets/import', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
  const csv = req.body.csv || '';
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return redirectBack(req, res);
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
    signatures: db.prepare(`SELECT COUNT(*) c FROM doc_signatures WHERE workspace_id=? AND user_id=?`).get(req.workspace.id, u.id).c
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
  if (!tpl) return redirectBack(req, res);
  const userId = parseInt(req.body.user_id, 10);
  if (!userId) return redirectBack(req, res);
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
  if (!lines.length) return redirectBack(req, res);
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
  if (!risk) return redirectBack(req, res);
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

// ==================== COMPLIANCE CALENDAR ====================
// (Old list-style calendar removed — replaced by Tier B.8 month-view above.)

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
    'workspaces','entities','assets','risks','risk_treatments','risk_acceptances','risk_methodologies','risk_appetites',
    'control_states','entity_control_states','soa_snapshots',
    'generated_docs','doc_versions','doc_approvers','doc_signatures',
    'evidence','comments','comment_mentions',
    'audits','audit_findings','audit_observations','audit_programmes',
    'mrms','nonconformities','incidents','incident_events',
    'suppliers','supplier_documents','supplier_subprocessors','supplier_reviews','supplier_notes','supplier_clauses','supplier_controls','supplier_questionnaires','supplier_questionnaire_responses','supplier_monitoring','supplier_termination_items',
    'document_controls',
    'tasks','task_templates',
    'asset_relationships',
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
    const fp = resolveUploadPath(e.stored_path, ws.firm_id);
    if (fp && fs.existsSync(fp)) zip.file(fp, { name: `evidence/${e.id}_${e.filename}` });
  }
  // All supplier files
  const supDocs = db.prepare(`SELECT d.* FROM supplier_documents d INNER JOIN suppliers s ON s.id=d.supplier_id WHERE s.workspace_id=?`).all(ws.id);
  for (const d of supDocs) {
    if (d.stored_path) {
      const fp = resolveUploadPath(d.stored_path, ws.firm_id);
      if (fp && fs.existsSync(fp)) zip.file(fp, { name: `supplier-files/${d.id}_${d.filename}` });
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
  if (!ids.length) return redirectBack(req, res);
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
  redirectBack(req, res);
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
  if (!name || !body) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO report_templates (workspace_id, firm_id, name, description, body, is_system) VALUES (?, NULL, ?, ?, ?, 0)`)
    .run(req.workspace.id, name, description || null, body).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_report_template', 'report', id, { name }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/reports`);
});

// ==================== AUDIT OBSERVATIONS + CRISIS COMMS ====================
// Audit observations (lighter than findings)
// Audit checklist generator — populates audit_observations with starter questions for
// every Annex A control in the chosen category. Auditor fills in findings against each.
app.post('/workspaces/:wsId/audits/:id/checklist', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Not found');
  const category = req.body.category;
  const validCats = ['org','people','physical','tech','clauses'];
  if (!validCats.includes(category)) return redirectBack(req, res);
  const controls = category === 'clauses'
    ? db.prepare(`SELECT id, title FROM iso_items WHERE type='clause' ORDER BY sort_order`).all()
    : db.prepare(`SELECT id, title FROM iso_items WHERE type='control' AND category=? ORDER BY sort_order`).all(category);
  const ins = db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, status) VALUES (?, ?, ?, 'open')`);
  const tx = db.transaction(() => {
    controls.forEach(c => {
      const cleanTitle = c.title.replace(/^A\.[0-9.]+ /, '').replace(/^Clause [0-9.]+ /, '');
      const q = `${c.id.replace('annex-','').replace('clause-','').toUpperCase()} — ${cleanTitle}: Is there a documented process? Is it operating in practice (sample evidence)? Has it been reviewed in the last 12 months?`;
      ins.run(audit.id, c.id, q);
    });
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'generate_audit_checklist', 'audit', audit.id, { category, count: controls.length }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`, `Generated ${controls.length} checklist item${controls.length === 1 ? '' : 's'} — fill in findings against each`));
});

app.post('/workspaces/:wsId/audits/:id/observations', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const { iso_item_id, description, recommendation } = req.body;
  if (!description) return redirectBack(req, res);
  db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, recommendation) VALUES (?, ?, ?, ?)`)
    .run(req.params.id, iso_item_id || null, description, recommendation || null);
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

app.post('/workspaces/:wsId/audits/observations/:obsId/close', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=?`).run(req.params.obsId);
  redirectBack(req, res);
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

// ==================== FILE PREVIEW ====================
app.get('/workspaces/:wsId/evidence/:id/preview', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const ev = db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const fp = resolveUploadPath(ev.stored_path, req.workspace.firm_id);
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
  const ext = path.extname(ev.filename).toLowerCase();
  const ct = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.svg':'image/svg+xml','.txt':'text/plain' }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', `inline; filename="${ev.filename}"`);
  res.sendFile(fp);
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
  if (!c) return redirectBack(req, res);
  const decBody = enc.decryptIfNeeded(c.body, req.workspace.id);
  const handles = extractMentions(decBody);
  if (!handles.length) return redirectBack(req, res);
  const users = db.prepare(`SELECT id, name FROM users WHERE active=1`).all();
  const ins = db.prepare(`INSERT OR IGNORE INTO comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?)`);
  let mentioned = 0;
  for (const h of handles) {
    const u = users.find(u => u.name.toLowerCase().replace(/\s+/g,'') === h.toLowerCase());
    if (u) { ins.run(c.id, u.id); mentioned++;
      jobs.notify(req.workspace.id, u.id, 'mention', 'info', `@${h} you were mentioned`, decBody.slice(0,140), `/workspaces/${req.workspace.id}`); }
  }
  if (mentioned > 0) db.prepare('UPDATE comments SET has_mentions=1 WHERE id=?').run(c.id);
  redirectBack(req, res);
});

// ==================== ERROR HANDLERS ====================
app.use((req, res) => {
  res.status(404).render('error', { user: currentUser(req), message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).render('error', { user: currentUser(req), message: 'Server error: ' + err.message });
});

// Export the configured app so tests can mount it without calling listen().
// When run directly (node server.js), bind a port and start serving.
module.exports = { app, db };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nISO 27001 Tool running at http://localhost:${PORT}`);
    console.log(`First time? Visit /register to create your firm account.\n`);
  });
}
