// Pin the whole app to India Standard Time so "today", date math, scheduled
// scans and the calendar all operate in IST regardless of the host's timezone.
// Must run before anything constructs a Date.
process.env.TZ = 'Asia/Kolkata';

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

// Local-timezone (IST, pinned above) date-only / month formatters. Use these
// instead of `.toISOString().slice(0,10|7)` for calendar logic: toISOString is
// always UTC and silently shifts the day/month in positive-offset zones like
// IST (e.g. 1 Jun 00:00 IST -> "2026-05-31" in UTC), which breaks month nav.
function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ymLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const { db, init, logAction, verifyAuditChain, defaultMethodology, ensureWorkspaceMethodology, getActiveMethodology, methodologyBand } = require('./db');
const enc = require('./lib/encryption');
const rbac = require('./lib/rbac');
const jobs = require('./lib/jobs');
const fts = require('./lib/fts');
const reports = require('./lib/reports');
const backup = require('./lib/backup');
const keyrotation = require('./lib/keyrotation');
const csvImport = require('./lib/csv-import');
const auditPack = require('./lib/audit-pack');
const changesSince = require('./lib/changes-since');
const email = require('./lib/email');
const docApprovals = require('./lib/doc-approvals');
const evReads = require('./lib/evidence-reads');
const ctlReads = require('./lib/control-reads');
const evWrites = require('./lib/evidence-writes');

init();

// ---------------------------------------------------------------------------
// Startup secret validation
// ---------------------------------------------------------------------------
(function validateSecrets() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowInsecure = process.env.ALLOW_INSECURE_DEFAULTS === '1';

  // SESSION_SECRET check
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-in-production') {
    if (isProd && !allowInsecure) {
      console.error('FATAL: SESSION_SECRET must be set to a strong random value in production.');
      console.error('       Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
      process.exit(1);
    }
    console.warn('WARNING: SESSION_SECRET is not set or is insecure. Set SESSION_SECRET env var before deploying.');
  }

  // ISMS_MASTER_KEY check – if no env var and no key file, the encryption
  // module will auto-generate one, which is fine for dev but not explicit
  // enough for production.
  if (!process.env.ISMS_MASTER_KEY) {
    const keyFile = process.env.ISMS_KEY_FILE || path.join(__dirname, 'data', 'master.key');
    const hasKeyFile = fs.existsSync(keyFile);
    if (isProd && !allowInsecure && !hasKeyFile) {
      console.error('FATAL: ISMS_MASTER_KEY env var is not set and no key file exists at ' + keyFile + '.');
      console.error('       Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      process.exit(1);
    }
    if (!hasKeyFile) {
      console.warn('WARNING: ISMS_MASTER_KEY is not set. A key file will be auto-generated at ' + keyFile + '. Set ISMS_MASTER_KEY env var before deploying.');
    }
  }
})();

// Force master key generation eagerly so first request doesn't block.
enc.masterKey();
// Start scheduled job runner - every 60 minutes by default.
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
// Quiet the favicon 404 - no icon yet, just respond with No Content.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Persistent session store. The default MemoryStore loses every session on
// every restart, which makes "Keep me signed in for 30 days" a lie - users
// get bounced back to /login the moment the container restarts (healthcheck,
// daily backup, deploy). SQLite-backed store reuses the existing db handle
// so sessions persist alongside the rest of the workspace data.
const SqliteStore = require('better-sqlite3-session-store')(session);
app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 1000 * 60 * 60 } // sweep expired rows hourly
  }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production-' + crypto.randomBytes(8).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// HTML responses must not be cached by the browser. Without this, CSRF tokens
// and dynamic content get served stale from disk cache after a server restart
// or after the user re-opens a tab - leading to silent 403s and "save isn't
// working" reports. Doesn't affect /public static assets (those don't go
// through res.render and Express sets its own ETag for them).
app.use((_req, res, next) => {
  const origRender = res.render.bind(res);
  res.render = function (...args) {
    res.set('Cache-Control', 'no-store, must-revalidate');
    return origRender(...args);
  };
  next();
});

// CSRF protection on every state-changing request. Token is exposed via
// res.locals.csrfToken - partials/header.ejs renders it in a <meta> tag,
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
// the basename - resolveUploadPath() rebuilds the absolute path on read,
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

// CSV import uploader: memory-only, ~5MB cap, single file. Used by the
// asset/risk CSV import preview routes. Parsed in-process; never persisted.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

// Questionnaire evidence uploader. Used on both the external (vendor, anonymous)
// and internal (consultant) questionnaire pages. Stricter than `upload`: a
// conservative type allowlist and a 25MB/file, 40-file cap. Disallowed types
// are dropped silently (their names collected on req._rejectedUploads) so a
// single bad file never discards the vendor's typed answers; oversize trips a
// MulterError that qUploadAny surfaces as a friendly retry message.
const QFILE_ALLOWED_EXT = new Set([
  'pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','rtf','odt','ods',
  'png','jpg','jpeg','gif','webp','zip','json','xml'
]);
const questionnaireUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, _file, cb) {
      const firmId = (req.workspace && req.workspace.firm_id) || (req.user && req.user.firm_id) || 0;
      const dir = path.join(__dirname, 'uploads', `firm_${firmId}`);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      cb(null, dir);
    },
    filename: function (_req, file, cb) {
      const rand = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${rand}-${file.originalname.replace(/[^\w.\-]/g, '_')}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 40 },
  fileFilter: function (req, file, cb) {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (QFILE_ALLOWED_EXT.has(ext)) return cb(null, true);
    if (!req._rejectedUploads) req._rejectedUploads = [];
    req._rejectedUploads.push(file.originalname);
    cb(null, false); // skip this file, keep parsing the rest of the form
  }
});

// Run questionnaireUpload.any() but never throw out of the middleware chain:
// any MulterError (e.g. LIMIT_FILE_SIZE / LIMIT_FILE_COUNT) is parked on
// req._uploadError so the route handler can decide how to respond. We use
// .any() because field names are dynamic (file_<questionId>).
function qUploadAny(req, res, next) {
  questionnaireUpload.any()(req, res, (err) => {
    if (err) req._uploadError = err;
    next();
  });
}

// Resolve the firm (for upload partitioning) from a questionnaire's external
// token BEFORE multer parses the body — multer's destination() needs
// req.workspace.firm_id, and req.params.token is available pre-parse. Also
// short-circuits invalid / completed / expired links with the same status
// pages the GET route renders, so multer never runs for a dead link. On
// success it stashes the (open) questionnaire on req._questionnaire.
function resolveQuestionnaireFirm(req, res, next) {
  const q = db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description,
      w.firm_id AS ws_firm_id, COALESCE(w.brand_display_name, w.client_name) AS requester_name
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    LEFT JOIN questionnaire_templates t ON t.id=q.template_id
    LEFT JOIN workspaces w ON w.id=q.workspace_id
    WHERE q.external_token=?`).get(req.params.token);
  const blank = { sections: {}, respMap: {}, token: req.params.token };
  if (!q) return res.status(404).render('external_questionnaire', { q: null, state: 'invalid', ...blank });
  if (q.external_completed_at) return res.render('external_questionnaire', { q, state: 'done', ...blank });
  if (q.external_expires_at && new Date(q.external_expires_at) < new Date())
    return res.status(410).render('external_questionnaire', { q, state: 'expired', ...blank });
  req._questionnaire = q;
  req.workspace = { id: q.workspace_id, firm_id: q.ws_firm_id || 0 };
  next();
}

// Persist already-uploaded multipart files (from multer .any()) as
// questionnaire_attachments rows. Field names map to a question via the
// file_<questionId> convention; anything else is treated as unattached
// (question_id NULL). Each file is hashed for integrity/dedup display. One
// failing file is logged and skipped rather than aborting the batch.
function persistQuestionnaireFiles({ files, questionnaireId, workspaceId, source, uploadedBy }) {
  if (!Array.isArray(files) || !files.length) return 0;
  const ins = db.prepare(`INSERT INTO questionnaire_attachments
    (questionnaire_id, question_id, workspace_id, filename, stored_path, mime, size_bytes, sha256, source, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let saved = 0;
  for (const f of files) {
    try {
      const m = /^file_(\d+)$/.exec(f.fieldname || '');
      const questionId = m ? parseInt(m[1], 10) : null;
      let sha = null;
      try { sha = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'); } catch (_) {}
      ins.run(questionnaireId, questionId, workspaceId, f.originalname, f.filename,
        f.mimetype || null, f.size || null, sha, source || 'vendor', uploadedBy || null);
      saved++;
    } catch (e) {
      console.error('[questionnaire attach] failed to persist', f && f.originalname, e && e.message);
      try { if (f && f.path) fs.unlinkSync(f.path); } catch (_) {}
    }
  }
  return saved;
}

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
// Auth is disabled - single-user-per-tenant local mode. The "active tenant" is
// stored in the session; currentUser returns the firm-owner of that tenant so
// every existing firm_id-based query naturally scopes to the active tenant.
function getActiveFirmId(req) {
  const user = req.user || currentUser(req);
  if (!user) {
    const first = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    return first ? first.id : null;
  }
  // Firm users always operate within their own firm — session value is ignored.
  if (user.user_type === 'firm') return user.firm_id;
  // Client users: honour session value only if they have workspace membership
  // in that firm, otherwise fall back to the first firm they belong to.
  const sessId = parseInt((req.session && req.session.active_firm_id) || 0, 10);
  if (sessId) {
    const hasMembership = db.prepare(
      `SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND w.firm_id = ?`
    ).get(user.id, sessId);
    if (hasMembership) return sessId;
  }
  const fallback = db.prepare(
    `SELECT w.firm_id FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? LIMIT 1`
  ).get(user.id);
  return fallback ? fallback.firm_id : null;
}

function currentUser(req) {
  // Session-bound user lookup. The firm-owner fallback that used to live here
  // was the no-auth stub; once email/password login was enabled, this must
  // return null for any unauthenticated request so requireAuth can challenge.
  if (req.session && req.session.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId);
    if (u) return u;
  }
  return null;
}

function listAllFirms() {
  return db.prepare(`SELECT f.id, f.name, f.created_at,
    (SELECT COUNT(*) FROM workspaces w WHERE w.firm_id=f.id) AS workspace_count
    FROM firms f ORDER BY f.id`).all();
}

function listUserFirms(user) {
  if (!user) return [];
  if (user.user_type === 'firm') {
    return db.prepare(`SELECT f.id, f.name, f.created_at,
      (SELECT COUNT(*) FROM workspaces w WHERE w.firm_id=f.id) AS workspace_count
      FROM firms f WHERE f.id = ?`).all(user.firm_id);
  }
  return db.prepare(`SELECT DISTINCT f.id, f.name, f.created_at,
    (SELECT COUNT(*) FROM workspaces w2 WHERE w2.firm_id=f.id) AS workspace_count
    FROM firms f
    INNER JOIN workspaces w ON w.firm_id = f.id
    INNER JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ? ORDER BY f.id`).all(user.id);
}

// Paths that bypass requireAuth (login form, password-reset, accept-invite).
// Magic-link approver routes are handled by their own token machinery and
// don't pass through requireAuth at all, so they don't need to be listed here.
const PUBLIC_AUTH_PATHS = [
  /^\/login(\?|$|\/)/,
  /^\/logout(\?|$)/,
  /^\/forgot(\?|$|\/)/,
  /^\/reset\//,
  /^\/invite\//,
];

function requireAuth(req, res, next) {
  // Reject unauthenticated requests. The no-auth firm-owner fallback was
  // removed when real login was enabled — currentUser() now returns a user
  // only when req.session.userId is set and that user is still active.
  req.user = currentUser(req);
  if (!req.user) {
    // Browsers visiting an HTML page get redirected to /login with a `next`
    // hint so they bounce back after authenticating. XHR / fetch callers get
    // a 401 so client-side code can detect session expiry without redirecting
    // the whole page out from under itself.
    const wantsHtml = (req.accepts(['html', 'json']) === 'html');
    if (wantsHtml && req.method === 'GET') {
      const nxt = encodeURIComponent(req.originalUrl || '/dashboard');
      return res.redirect(`/login?next=${nxt}`);
    }
    return res.status(401).json({ error: 'auth_required' });
  }
  next();
}

function getWorkspace(workspaceId, user) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return null;
  if (user.user_type === 'firm' && user.firm_id === ws.firm_id) {
    // Firm-side access: role on the workspace record mirrors the user's firm
    // role bucket. Manager / Senior consultant / Consultant all use the
    // 'consultant' bundle for non-permission UI (e.g. who you can be assigned
    // as) but _userRole keeps the precise role so RBAC can differentiate.
    const fr = rbac.normalizeRole(user.firm_role) || 'consultant';
    return { ...ws, role: 'consultant', _userRole: fr };
  }
  const m = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, user.id);
  if (!m) return null;
  return { ...ws, role: m.role, _userRole: m.role };
}

// Allowed framework identifiers. Treated as a closed set so a malformed
// workspace.frameworks value can't introduce phantom nav groups.
const ALLOWED_FRAMEWORKS = ['iso27001', 'iso42001', 'csf'];

// Parse the workspace.frameworks JSON column into an Array. Falls back to
// "all three" so a workspace created before the column existed (or one
// whose value got corrupted) still renders something useful.
function parseWorkspaceFrameworks(raw) {
  if (!raw) return ALLOWED_FRAMEWORKS.slice();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return ALLOWED_FRAMEWORKS.slice();
    const cleaned = arr.filter(x => ALLOWED_FRAMEWORKS.includes(x));
    return cleaned.length ? cleaned : ALLOWED_FRAMEWORKS.slice();
  } catch (_) { return ALLOWED_FRAMEWORKS.slice(); }
}

function requireWorkspace(req, res, next) {
  const ws = getWorkspace(req.params.wsId, req.user);
  if (!ws) return res.status(403).render('error', { user: req.user, message: 'This workspace doesn\'t exist, or it belongs to a different firm. If you recently switched tenants, the old workspace URL won\'t resolve. Use the Clients dashboard to pick a workspace in the active firm.' });
  ws.frameworks = parseWorkspaceFrameworks(ws.frameworks);
  req.workspace = ws;
  // Remember the workspace they were last in, so firm-level pages (Glossary,
  // Playbooks, Firm library, Tenants) can offer a "← Back to {client}"
  // breadcrumb instead of dumping them into a different sidebar with no
  // way home.
  if (req.session) req.session.last_ws_id = ws.id;
  // Multi-entity scoping was removed - keep the locals as empty stubs so views that
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
  // Open review-queue count for the sidebar badge.
  try {
    const T = ctlReads.tables(db, ws.id);
    const a = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} WHERE workspace_id=? AND review_status IN ('requested','needs_changes')`).get(ws.id).c;
    const b = db.prepare(`SELECT COUNT(*) c FROM ${T.cs42} WHERE workspace_id=? AND review_status IN ('requested','needs_changes')`).get(ws.id).c;
    res.locals.openReviewCount = a + b;
  } catch (_) { res.locals.openReviewCount = 0; }
  next();
}

function isFirmUser(user) { return user.user_type === 'firm'; }
// "Firm owner" was renamed to "Manager" in the role-naming pass. rbac.isManager
// normalises old aliases ('owner' → 'manager') so unmigrated rows still resolve.
function isFirmOwner(user) { return user.user_type === 'firm' && rbac.isManager(user.firm_role); }

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
  const assessed = db.prepare(`SELECT COUNT(*) AS c FROM ${ctlReads.tables(db, wsId).cs}
    WHERE workspace_id = ? AND status != 'Not Assessed'`).get(wsId).c;
  return { total, assessed, percent: total ? Math.round((assessed / total) * 100) : 0 };
}

// Derive a client's lifecycle stage from real signals rather than the
// manual `stage` column (which nobody ever updated). Each stage is the
// FIRST one for which its threshold passes, evaluated in order. This
// powers the sidebar context pill, dashboard status column, and any
// "what tools should this client see" gating we add later.
//
// Stages, latest-to-earliest:
//   surveillance      - Stage 2 audit happened > 1 year ago (annual cycle)
//   post_stage_2      - certified (Stage 2 audit completed)
//   post_stage_1      - Stage 1 audit completed, not yet Stage 2
//   stage_1_ready     - readiness >= 80% (ready to schedule Stage 1)
//   internal_audit    - >= 1 internal audit completed
//   implementing      - controls being assessed (>= 20 non-NotAssessed)
//   documenting       - >= 8 documents in approved/published status
//   scoping           - at least one intake answer recorded
//   new               - no setup yet
function computeClientStage(ws) {
  const wsId = ws.id;
  // audits has: title, scope, audit_date (planned), closed_at (when work
  // finished), lifecycle_stage. We treat closed_at as "completed" and
  // pattern-match the title/scope for which audit type it is.
  const audits = db.prepare(`SELECT title, scope, lifecycle_stage, closed_at, audit_date FROM audits WHERE workspace_id=? ORDER BY COALESCE(closed_at, audit_date) DESC`).all(wsId);
  const isDone = a => !!a.closed_at || a.lifecycle_stage === 'closed';
  const matchType = (a, re) => re.test((a.title || '') + ' ' + (a.scope || ''));
  const stage2 = audits.find(a => isDone(a) && matchType(a, /stage[\s_-]?2/i));
  const stage1 = audits.find(a => isDone(a) && matchType(a, /stage[\s_-]?1/i));
  const internal = audits.find(a => isDone(a) && matchType(a, /internal/i));

  if (stage2 && stage2.closed_at) {
    const daysSince = Math.round((Date.now() - new Date(stage2.closed_at).getTime()) / 86400000);
    if (daysSince > 365) return { key: 'surveillance', label: 'Surveillance' };
    return { key: 'post_stage_2', label: 'Certified' };
  }
  if (stage1) return { key: 'post_stage_1', label: 'Post Stage 1' };

  // No external audit yet - look at readiness + internal audit + control progress
  try {
    const r = computeReadiness(ws);
    if (r && r.stage1 >= 80) return { key: 'stage_1_ready', label: 'Stage 1 ready' };
  } catch (_) {}

  if (internal) return { key: 'internal_audit', label: 'Internal audit done' };

  const assessed = db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs} WHERE workspace_id=? AND status != 'Not Assessed'`).get(wsId).c;
  if (assessed >= 20) return { key: 'implementing', label: 'Implementing' };

  const approved = db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published')`).get(wsId).c;
  if (approved >= 8) return { key: 'documenting', label: 'Documenting' };

  const intake = db.prepare(`SELECT COUNT(*) c FROM engagement_intake WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer)) > 0`).get(wsId).c;
  if (intake > 0) return { key: 'scoping', label: 'Scoping' };

  return { key: 'new', label: 'New' };
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
// Tier marker as a crisp inline SVG (star/diamond/dot) instead of unicode
// glyphs (★ ◆ ·), which render inconsistently across fonts. Colour is inherited
// via currentColor. Safe to emit with <%- %> — no user input.
app.locals.tierIcon = (tier, size = 12) => {
  const open = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-0.125em;flex-shrink:0;">`;
  if (tier === 'mandatory') return open + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  if (tier === 'expected') return open + '<polygon points="12 2 22 12 12 22 2 12"/></svg>';
  return open + '<circle cx="12" cy="12" r="4"/></svg>';
};
app.locals.rbac = rbac;

// ==================== RBAC + AUDIT CONTEXT ====================
// Resolve a user's effective permissions in a workspace, including overrides.
function permissionsFor(user, ws) {
  if (!user || !ws) return new Set();
  // Manager (formerly "Firm owner") of the firm that owns the workspace
  // implicitly holds every permission, including new ones added after deploy.
  if (user.user_type === 'firm' && rbac.isManager(user.firm_role) && user.firm_id === ws.firm_id) {
    return new Set(Object.keys(rbac.PERMISSIONS).concat(['*']));
  }
  let role;
  if (user.user_type === 'firm' && user.firm_id === ws.firm_id) {
    role = ws._userRole || 'consultant';
  } else {
    const m = db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(ws.id, user.id);
    // A client user without a workspace_members row gets the narrowest role
    // (contributor) by default. Previously 'read_only' which has been dropped;
    // rbac.normalizeRole maps the old name to contributor too.
    role = m?.role || 'contributor';
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
      return res.status(403).render('error', { user: req.user, message: `You don't have permission to do this (missing: ${perm}). A workspace owner can grant individual permissions in workspace settings → Access & permissions, or assign you a role that includes it.` });
    }
    req.userPerms = perms;
    next();
  };
}

// Build the audit context from a request - IP, UA, request id, current entity scope.
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
    const u = req.user || currentUser(req);
    res.locals.allFirms = listUserFirms(u);
  } catch (_) {
    res.locals.activeFirm = null;
    res.locals.allFirms = [];
  }
  // Expose the last-visited workspace so the firm-level sidebar's client
  // switcher can highlight it ("last viewed"). Firm-level pages (Glossary,
  // Playbooks, Firm library, Admin email) render with the firm sidebar
  // (ws:null) and deliberately do NOT inherit this as a workspace context -
  // doing so stranded users in a stale client's chrome. requireAuth hasn't run
  // yet at this middleware tier, so resolve the current user inline first.
  res.locals.lastWs = null;
  // List of workspaces in the active firm - powers the workspace
  // switcher dropdown in the sidebar. Cheap query (small set, indexed
  // on firm_id). Exposed to every view so the switcher renders on
  // workspace pages and firm-level pages alike.
  res.locals.firmWorkspaces = [];
  try {
    const u = currentUser(req);
    if (u) {
      const firmId = getActiveFirmId(req);
      if (firmId) {
        res.locals.firmWorkspaces = db.prepare(
          `SELECT id, client_name, brand_display_name, brand_primary_color, sector, industry
           FROM workspaces WHERE firm_id=? ORDER BY created_at DESC, client_name`
        ).all(firmId);
      }
      const lastId = req.session && req.session.last_ws_id;
      if (lastId) {
        const ws = getWorkspace(lastId, u);
        // Pass the full workspace record so the workspace sidebar can render
        // brand colour, sector chip, display name etc.
        if (ws) res.locals.lastWs = ws;
      }
    }
  } catch (_) {}
  next();
});

// Pre-load unread notifications for the topbar bell.
app.use((req, res, next) => {
  if (req.session && req.session.userId !== undefined) { /* placeholder */ }
  // Without auth, just count workspace-broadcast notifications (user_id IS NULL)
  // for the user's accessible workspaces in the current request scope.
  next();
});

// ==================== AUTH ROUTES ====================
// Session-cookie login. Default session is the 7-day cookie configured on
// session(); the "remember me" path extends to 30d on success and a non-
// remember login is shortened to an 8h cookie so a shared browser doesn't
// leave the next user logged in to whatever yesterday's session was.
const SESSION_DEFAULT_MAX_AGE  = 1000 * 60 * 60 * 8;       // 8 hours
const SESSION_REMEMBER_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30 days

// Login throttle on hot misses. Uses an in-process Map keyed by lower-cased
// email; capped at 8 failures over a 15-minute window. Process-restart wipes
// it, which is acceptable for a single-server deployment and is the right
// trade-off given the user explicitly skipped brute-force protection in scope.
const LOGIN_BAD = new Map(); // email -> { count, firstAt }
const LOGIN_BAD_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BAD_LIMIT = 8;
function recordBadLogin(email) {
  const key = (email || '').toLowerCase();
  const now = Date.now();
  const rec = LOGIN_BAD.get(key);
  if (!rec || (now - rec.firstAt) > LOGIN_BAD_WINDOW_MS) {
    LOGIN_BAD.set(key, { count: 1, firstAt: now });
  } else {
    rec.count++;
  }
}
function isLockedOut(email) {
  const rec = LOGIN_BAD.get((email || '').toLowerCase());
  if (!rec) return false;
  if ((Date.now() - rec.firstAt) > LOGIN_BAD_WINDOW_MS) { LOGIN_BAD.delete((email||'').toLowerCase()); return false; }
  return rec.count >= LOGIN_BAD_LIMIT;
}
function clearBadLogin(email) { LOGIN_BAD.delete((email || '').toLowerCase()); }

app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect(typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/dashboard');
  res.render('auth/login', {
    error: null,
    notice: req.query.signed_out ? 'You have been signed out.' : (req.query.reset_ok ? 'Password updated. Sign in to continue.' : null),
    next_url: typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '',
    prefillEmail: '',
    csrfToken: res.locals.csrfToken
  });
});

app.post('/login', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const remember = !!(req.body && req.body.remember);
  const nextUrl = (typeof req.body.next === 'string' && req.body.next.startsWith('/')) ? req.body.next : '/dashboard';

  const renderFail = (msg) => res.status(401).render('auth/login', {
    error: msg, notice: null, next_url: nextUrl === '/dashboard' ? '' : nextUrl,
    prefillEmail: email, csrfToken: res.locals.csrfToken
  });

  if (!email || !password) return renderFail('Email and password are required.');
  if (isLockedOut(email)) return renderFail('Too many failed attempts. Wait 15 minutes and try again, or reset your password.');

  const user = db.prepare(`SELECT id, email, password_hash, active FROM users WHERE email = ?`).get(email);
  // Constant-ish-time response: always run a bcrypt compare even if user is
  // missing, so a probe can't distinguish "no such email" from "wrong password"
  // by timing alone.
  const hashToCheck = (user && user.password_hash && user.password_hash !== '!noauth')
    ? user.password_hash
    : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid.';
  const ok = bcrypt.compareSync(password, hashToCheck);

  if (!user || !user.active || user.password_hash === '!noauth' || !ok) {
    recordBadLogin(email);
    return renderFail('Email or password is incorrect.');
  }

  clearBadLogin(email);
  // Regenerate the session id on privilege change to defeat session fixation.
  req.session.regenerate((err) => {
    if (err) return renderFail('Could not start a session. Please try again.');
    req.session.userId = user.id;
    req.session.cookie.maxAge = remember ? SESSION_REMEMBER_MAX_AGE : SESSION_DEFAULT_MAX_AGE;
    // Touch last_active_at for the activity-feed and any "last seen" UX.
    try { db.prepare(`UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?`).run(user.id); } catch (_) {}
    res.redirect(nextUrl);
  });
});

app.post('/logout', (req, res) => {
  // Destroy the whole session, not just userId, so csrfToken + last_ws_id +
  // active_firm_id all go too. Cookie is cleared explicitly for clients that
  // don't honour session.destroy's Set-Cookie max-age=0.
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login?signed_out=1');
  });
});

// GET fallback so a bare /logout link works without a form.
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login?signed_out=1');
  });
});

// /register stays redirected — user provisioning is admin-driven (Phase 3)
// rather than self-signup. Anything posted here goes back to login.
app.get('/register', (_req, res) => res.redirect('/login'));
app.post('/register', (_req, res) => res.redirect('/login'));

// -------- User invitations (Phase 3) --------
// Owner-only management surface. Lists firm users, client-side users this
// firm has provisioned (via workspace_members), outstanding invitations, and
// hosts the two provisioning forms (invite-by-email + create-with-temp-pw).
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// "Firm owner" was renamed Manager. Keep the helper local to this section so
// other callers can adopt isFirmOwner / rbac.isManager directly.
function isFirmOwnerLocal(u) {
  return u && u.user_type === 'firm' && rbac.isManager(u.firm_role);
}

app.get('/admin/users', requireAuth, (req, res) => {
  if (!isFirmOwnerLocal(req.user)) {
    return res.status(403).render('error', { user: req.user, message: 'Only Managers can manage users.' });
  }
  const firmUsers = db.prepare(`
    SELECT id, name, email, firm_role, active, last_active_at, created_at
      FROM users WHERE firm_id = ? AND user_type = 'firm' ORDER BY active DESC, name`).all(req.user.firm_id);
  const clientUsers = db.prepare(`
    SELECT u.id, u.name, u.email, u.active, u.last_active_at, u.created_at,
           GROUP_CONCAT(w.client_name || ' (' || wm.role || ')', ' · ') AS workspaces
      FROM users u
      INNER JOIN workspace_members wm ON wm.user_id = u.id
      INNER JOIN workspaces w ON w.id = wm.workspace_id
     WHERE u.user_type = 'client' AND w.firm_id = ?
     GROUP BY u.id ORDER BY u.active DESC, u.name`).all(req.user.firm_id);
  const outstanding = db.prepare(`
    SELECT inv.id, inv.email, inv.name, inv.user_type, inv.firm_role, inv.workspace_role,
           inv.expires_at, inv.created_at, w.client_name AS workspace_name, u.name AS invited_by_name
      FROM user_invitations inv
      LEFT JOIN workspaces w ON w.id = inv.workspace_id
      LEFT JOIN users u ON u.id = inv.invited_by
     WHERE inv.firm_id = ? AND inv.accepted_at IS NULL AND inv.revoked_at IS NULL AND inv.expires_at > CURRENT_TIMESTAMP
     ORDER BY inv.created_at DESC`).all(req.user.firm_id);
  const workspaces = db.prepare(`SELECT id, client_name FROM workspaces WHERE firm_id = ? ORDER BY client_name`).all(req.user.firm_id);
  res.render('admin_users', {
    user: req.user, ws: null, active: 'admin-users',
    firmUsers, clientUsers, outstanding, workspaces,
    notice: req.query.notice || null,
    error: req.query.error || null,
    // Optional structured-error fields. When the invite route hits a
    // collision (active account exists / deactivated account exists) it sets
    // these so the view can render an inline action button rather than
    // leaving the admin at a dead-end "already exists" error.
    errorAction: req.query.error_action || null,
    errorEmail: req.query.error_email || null,
    errorUserId: req.query.error_user_id || null
  });
});

app.post('/admin/users/invite', requireAuth, async (req, res) => {
  if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = (b.name || '').trim() || null;
  const userType = b.user_type === 'client' ? 'client' : 'firm';
  // Firm role accepts the new names; everything else (including the old
  // 'owner') normalises down to 'consultant' as a safe default so a stale
  // form value can't silently elevate an invite to Manager.
  const firmRole = userType === 'firm'
    ? (rbac.FIRM_ROLES.includes(b.firm_role) ? b.firm_role : 'consultant')
    : null;
  const workspaceId = userType === 'client' ? parseInt(b.workspace_id, 10) || null : null;
  const workspaceRole = userType === 'client'
    ? (rbac.CLIENT_ROLES.includes(b.workspace_role) ? b.workspace_role : 'isms_manager')
    : null;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('A valid email is required.'));
  }

  // ---- Duplicate-account detection ----
  // Three distinct collision states get distinct flash params so the admin
  // page can render inline action buttons (reset / reactivate) instead of
  // a dead-end error. error_action is the trigger; email or user_id give
  // the action target.
  const existing = db.prepare(`SELECT id, email, active, name FROM users WHERE email = ?`).get(email);
  if (existing) {
    if (existing.active) {
      return res.redirect('/admin/users?'
        + 'error=' + encodeURIComponent(`An active account already exists for ${email}.`)
        + '&error_action=offer_reset'
        + '&error_email=' + encodeURIComponent(email));
    } else {
      return res.redirect('/admin/users?'
        + 'error=' + encodeURIComponent(`${email} previously had an account that was deactivated.`)
        + '&error_action=offer_reactivate'
        + '&error_user_id=' + existing.id
        + '&error_email=' + encodeURIComponent(email));
    }
  }

  if (userType === 'client') {
    if (!workspaceId) return res.redirect('/admin/users?error=' + encodeURIComponent('Pick a client workspace for the client-side user.'));
    const ws = db.prepare(`SELECT id FROM workspaces WHERE id = ? AND firm_id = ?`).get(workspaceId, req.user.firm_id);
    if (!ws) return res.redirect('/admin/users?error=' + encodeURIComponent('That workspace doesn\'t belong to this firm.'));
    // Already validated above via rbac.CLIENT_ROLES; defensive check kept in
    // case the constant set drifts from this list in the future.
    if (!rbac.CLIENT_ROLES.includes(workspaceRole)) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Invalid workspace role.'));
    }
  }

  // ---- Pending-invitation replacement ----
  // If an unaccepted, unrevoked, unexpired invitation already exists for this
  // email, revoke it before creating a new one. Keeps the outstanding-list
  // tidy and avoids "which link should I click?" confusion for the recipient.
  const pendingCount = db.prepare(`UPDATE user_invitations
       SET revoked_at = CURRENT_TIMESTAMP
     WHERE firm_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP`).run(req.user.firm_id, email).changes;

  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.prepare(`INSERT INTO user_invitations
      (email, name, firm_id, user_type, firm_role, workspace_id, workspace_role,
       token_hash, expires_at, invited_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(email, name, req.user.firm_id, userType, firmRole, workspaceId, workspaceRole,
         tokenHash, expiresAt, req.user.id);

  const firmRow = db.prepare(`SELECT name FROM firms WHERE id = ?`).get(req.user.firm_id);
  const roleLabel = userType === 'firm'
    ? (rbac.ROLE_LABELS[firmRole] || 'Consultant')
    : `Client-side — ${rbac.ROLE_LABELS[workspaceRole] || workspaceRole}`;

  let sendError = null;
  try {
    const emailLib = require('./lib/email');
    const r = await emailLib.sendInviteEmail({
      toEmail: email, toName: name, inviterName: req.user.name,
      firmName: firmRow && firmRow.name, role: roleLabel,
      token: raw, expiresAt, firmId: req.user.firm_id
    });
    if (!r.ok) sendError = r.error || 'Email delivery failed';
  } catch (e) { sendError = e && e.message; }

  if (sendError) {
    return res.redirect('/admin/users?error=' + encodeURIComponent(`Invitation created but email failed (${sendError}). Share the link manually: /invite/${raw}`));
  }
  const replacedNote = pendingCount > 0 ? ' (replaced an earlier pending invitation)' : '';
  res.redirect('/admin/users?notice=' + encodeURIComponent(`Invitation sent to ${email}. Link expires in 7 days.${replacedNote}`));
});

app.post('/admin/users/create', requireAuth, (req, res) => {
  if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = (b.name || '').trim();
  const password = String(b.password || '');
  const firmRole = rbac.FIRM_ROLES.includes(b.firm_role) ? b.firm_role : 'consultant';

  if (!email || !name) return res.redirect('/admin/users?error=' + encodeURIComponent('Name and email are required.'));
  if (password.length < 8) return res.redirect('/admin/users?error=' + encodeURIComponent('Temp password must be at least 8 characters.'));
  if (db.prepare(`SELECT id FROM users WHERE email = ?`).get(email)) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('A user with that email already exists.'));
  }
  const hash = bcrypt.hashSync(password, 12);
  const id = db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role)
                         VALUES (?, ?, ?, 'firm', ?, ?)`)
    .run(email, hash, name, req.user.firm_id, firmRole).lastInsertRowid;
  try { logAction(req.user.id, null, 'create_consultant', 'user', id, { email, role: firmRole }); } catch (_) {}
  res.redirect('/admin/users?notice=' + encodeURIComponent(`Created ${email}. Share the temp password with them — they should change it on first sign-in.`));
});

app.post('/admin/users/:id/deactivate', requireAuth, (req, res) => {
  if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
  const target = db.prepare(`SELECT id, firm_id, user_type FROM users WHERE id = ?`).get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  if (target.id === req.user.id) return res.redirect('/admin/users?error=' + encodeURIComponent('You cannot deactivate your own account.'));
  // Firm users: must be in same firm. Client users: must be a member of a workspace owned by this firm.
  let ok = false;
  if (target.user_type === 'firm') {
    ok = target.firm_id === req.user.firm_id;
  } else {
    ok = !!db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                       WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id);
  }
  if (!ok) return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
  db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(target.id);
  res.redirect('/admin/users?notice=' + encodeURIComponent('User deactivated.'));
});

// Admin-triggered password reset. Same machinery as /forgot but driven from
// the duplicate-detection inline action — the admin sees "account exists" on
// the invite form, clicks "send reset link", and we generate a fresh token
// and email it. Always reports success (mirrors /forgot's no-leakage stance).
app.post('/admin/users/send-reset', requireAuth, async (req, res) => {
  if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email) return res.redirect('/admin/users?error=' + encodeURIComponent('Missing email.'));

  // Only reset users this firm has a reason to touch — firm users in the same
  // firm, or client users who hold at least one workspace_member row in a
  // workspace owned by this firm. Prevents a manager from poking strangers'
  // accounts via crafted form data.
  const target = db.prepare(`SELECT id, email, name, active, user_type, firm_id FROM users WHERE email = ?`).get(email);
  if (!target) {
    return res.redirect('/admin/users?notice=' + encodeURIComponent(`If an account exists for ${email}, a reset link is on its way.`));
  }
  let allowed = false;
  if (target.user_type === 'firm') allowed = target.firm_id === req.user.firm_id;
  else allowed = !!db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                                WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id);
  if (!allowed || !target.active) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot reset that account from here.'));
  }

  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  let sendError = null;
  try {
    db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)`)
      .run(target.id, tokenHash, expiresAt, req.ip || null);
    const emailLib = require('./lib/email');
    const r = await emailLib.sendPasswordResetEmail({
      toEmail: target.email, toName: target.name, token: raw, expiresAt, firmId: req.user.firm_id
    });
    if (!r.ok) sendError = r.error || 'Email delivery failed';
  } catch (e) { sendError = e && e.message; }

  if (sendError) {
    return res.redirect('/admin/users?error=' + encodeURIComponent(`Reset token created but email failed (${sendError}). Share the link manually: /reset/${raw}`));
  }
  res.redirect('/admin/users?notice=' + encodeURIComponent(`Password-reset link sent to ${email}. Expires in 1 hour.`));
});

// Reactivate a previously-deactivated user. Mirror of /deactivate with the
// same firm-scoped permission check. Doesn't issue a reset email — admin can
// trigger that separately if the user has forgotten their password.
app.post('/admin/users/:id/reactivate', requireAuth, (req, res) => {
  if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
  const target = db.prepare(`SELECT id, firm_id, user_type, email, active FROM users WHERE id = ?`).get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  if (target.active) return res.redirect('/admin/users?error=' + encodeURIComponent('That account is already active.'));
  let ok = false;
  if (target.user_type === 'firm') ok = target.firm_id === req.user.firm_id;
  else ok = !!db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                          WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id);
  if (!ok) return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
  db.prepare(`UPDATE users SET active = 1 WHERE id = ?`).run(target.id);
  res.redirect('/admin/users?notice=' + encodeURIComponent(`Reactivated ${target.email}. They can now sign in with their existing password (or use Forgot password if they don't remember it).`));
});

app.post('/admin/invitations/:id/revoke', requireAuth, (req, res) => {
  if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
  const inv = db.prepare(`SELECT id, firm_id FROM user_invitations WHERE id = ?`).get(req.params.id);
  if (!inv || inv.firm_id !== req.user.firm_id) return res.redirect('/admin/users');
  db.prepare(`UPDATE user_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(inv.id);
  res.redirect('/admin/users?notice=' + encodeURIComponent('Invitation revoked.'));
});

// Update a firm user's role from the Users & Access page. Manager-only,
// scoped to the same firm. Guards against demoting yourself or removing the
// last manager — both would lock the firm out of user management.
app.post('/admin/users/:id/firm-role', requireAuth, (req, res) => {
  if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
  const newRole = String((req.body && req.body.firm_role) || '').trim();
  if (!rbac.FIRM_ROLES.includes(newRole)) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Invalid role.'));
  }
  const target = db.prepare(`SELECT id, firm_id, user_type, firm_role, email, name FROM users WHERE id = ?`)
    .get(req.params.id);
  if (!target) return res.redirect('/admin/users?error=' + encodeURIComponent('User not found.'));
  if (target.user_type !== 'firm' || target.firm_id !== req.user.firm_id) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
  }
  if (target.id === req.user.id) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('You cannot change your own role from here. Ask another manager.'));
  }
  // If the target is currently the last active manager, refuse the demotion.
  const currentNormalised = rbac.normalizeRole(target.firm_role);
  if (currentNormalised === 'manager' && newRole !== 'manager') {
    const otherManagers = db.prepare(`
      SELECT COUNT(*) AS n FROM users
        WHERE firm_id = ? AND user_type = 'firm' AND active = 1 AND id != ?
          AND (firm_role = 'manager' OR firm_role = 'firm_owner')`).get(target.firm_id, target.id);
    if (!otherManagers.n) {
      return res.redirect('/admin/users?error=' + encodeURIComponent(
        'Cannot demote the last active manager. Promote another firm user to manager first.'));
    }
  }
  if (currentNormalised === newRole) {
    return res.redirect('/admin/users?notice=' + encodeURIComponent('Role unchanged.'));
  }
  db.prepare(`UPDATE users SET firm_role = ? WHERE id = ?`).run(newRole, target.id);
  logAction(req.user.id, null, 'change_firm_role', 'user', target.id,
    { old_role: target.firm_role, new_role: newRole }, auditCtx(req));
  res.redirect('/admin/users?notice=' + encodeURIComponent(
    `Updated ${target.email} to ${rbac.ROLE_LABELS[newRole] || newRole}.`));
});

// -------- Accept invitation (public, token-authenticated) --------
function lookupInvitation(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== 64) return null;
  const tokenHash = hashToken(rawToken);
  const row = db.prepare(`
    SELECT inv.*, f.name AS firm_name, w.client_name AS workspace_name
      FROM user_invitations inv
      LEFT JOIN firms f ON f.id = inv.firm_id
      LEFT JOIN workspaces w ON w.id = inv.workspace_id
     WHERE inv.token_hash = ?`).get(tokenHash);
  if (!row) return null;
  if (row.accepted_at || row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (db.prepare(`SELECT id FROM users WHERE email = ?`).get(row.email)) return null;
  return row;
}

app.get('/invite/:token', (req, res) => {
  const inv = lookupInvitation(req.params.token);
  if (!inv) {
    return res.status(400).render('auth/login', {
      error: 'That invitation link is invalid, has expired, or has already been used. Ask the person who invited you for a new one.',
      notice: null, next_url: '', prefillEmail: '', csrfToken: res.locals.csrfToken
    });
  }
  res.render('auth/accept_invite', {
    token: req.params.token, invitation: inv, error: null,
    csrfToken: res.locals.csrfToken
  });
});

app.post('/invite/:token', (req, res) => {
  const inv = lookupInvitation(req.params.token);
  if (!inv) {
    return res.status(400).render('auth/login', {
      error: 'That invitation link is invalid, has expired, or has already been used.',
      notice: null, next_url: '', prefillEmail: '', csrfToken: res.locals.csrfToken
    });
  }
  const b = req.body || {};
  const name = (b.name || inv.name || '').trim();
  const pw  = String(b.password  || '');
  const pw2 = String(b.password2 || '');
  const renderFail = (msg) => res.status(400).render('auth/accept_invite', {
    token: req.params.token, invitation: inv, error: msg, csrfToken: res.locals.csrfToken
  });
  if (!name) return renderFail('Your name is required.');
  if (pw.length < 8) return renderFail('Password must be at least 8 characters.');
  if (pw !== pw2)    return renderFail('Passwords do not match.');

  const hash = bcrypt.hashSync(pw, 12);
  let newUserId = null;
  const tx = db.transaction(() => {
    const insertCols = inv.user_type === 'firm'
      ? `email, password_hash, name, user_type, firm_id, firm_role`
      : `email, password_hash, name, user_type, firm_id`;
    const insertVals = inv.user_type === 'firm'
      ? [inv.email, hash, name, 'firm', inv.firm_id, inv.firm_role || 'consultant']
      : [inv.email, hash, name, 'client', inv.firm_id];
    newUserId = db.prepare(`INSERT INTO users (${insertCols}) VALUES (${insertVals.map(() => '?').join(',')})`)
      .run(...insertVals).lastInsertRowid;
    if (inv.workspace_id && inv.workspace_role) {
      db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`)
        .run(inv.workspace_id, newUserId, inv.workspace_role);
    }
    db.prepare(`UPDATE user_invitations SET accepted_at = CURRENT_TIMESTAMP, accepted_user_id = ? WHERE id = ?`)
      .run(newUserId, inv.id);
  });
  tx();

  req.session.regenerate((err) => {
    if (err) return res.redirect('/login?invited=1');
    req.session.userId = newUserId;
    req.session.cookie.maxAge = SESSION_DEFAULT_MAX_AGE;
    res.redirect('/dashboard');
  });
});

// -------- Forgot-password (request a reset link) --------
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

app.get('/forgot', (req, res) => {
  res.render('auth/forgot', {
    error: null, notice: null, submitted: false,
    prefillEmail: '', csrfToken: res.locals.csrfToken
  });
});

app.post('/forgot', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  // Generic response — never confirm or deny whether an account exists.
  const genericNotice = 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.';
  if (!email) {
    return res.status(400).render('auth/forgot', {
      error: 'Email is required.', notice: null, submitted: false,
      prefillEmail: '', csrfToken: res.locals.csrfToken
    });
  }
  const user = db.prepare(`SELECT id, email, name, active FROM users WHERE email = ?`).get(email);
  if (user && user.active) {
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    try {
      db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)`)
        .run(user.id, tokenHash, expiresAt, req.ip || null);
      const emailLib = require('./lib/email');
      await emailLib.sendPasswordResetEmail({
        toEmail: user.email, toName: user.name, token: raw, expiresAt
      });
    } catch (e) {
      console.error('[auth] password reset issue', e && e.message);
    }
  }
  res.render('auth/forgot', {
    error: null, notice: genericNotice, submitted: true,
    prefillEmail: email, csrfToken: res.locals.csrfToken
  });
});

// -------- Reset-password (consume token, set new password) --------
function lookupResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== 64) return null;
  const tokenHash = hashToken(rawToken);
  const row = db.prepare(`
    SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.name, u.active
      FROM password_reset_tokens t
      INNER JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?`).get(tokenHash);
  if (!row) return null;
  if (row.used_at) return null;
  if (!row.active) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

app.get('/reset/:token', (req, res) => {
  const row = lookupResetToken(req.params.token);
  if (!row) {
    return res.status(400).render('auth/forgot', {
      error: 'That reset link is invalid or has expired. Request a new one below.',
      notice: null, submitted: false, prefillEmail: '', csrfToken: res.locals.csrfToken
    });
  }
  res.render('auth/reset', { token: req.params.token, error: null, csrfToken: res.locals.csrfToken });
});

app.post('/reset/:token', (req, res) => {
  const row = lookupResetToken(req.params.token);
  if (!row) {
    return res.status(400).render('auth/forgot', {
      error: 'That reset link is invalid or has expired. Request a new one below.',
      notice: null, submitted: false, prefillEmail: '', csrfToken: res.locals.csrfToken
    });
  }
  const pw  = String((req.body && req.body.password)  || '');
  const pw2 = String((req.body && req.body.password2) || '');
  const renderFail = (msg) => res.status(400).render('auth/reset', {
    token: req.params.token, error: msg, csrfToken: res.locals.csrfToken
  });
  if (pw.length < 8) return renderFail('Password must be at least 8 characters.');
  if (pw !== pw2)    return renderFail('Passwords do not match.');

  const hash = bcrypt.hashSync(pw, 12);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.user_id);
    db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    // Invalidate any other outstanding reset tokens for the same user
    db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(row.user_id);
  });
  tx();
  clearBadLogin(row.email);

  // Auto-sign-in once the password is set. Same session-fixation regenerate
  // pattern as the login route.
  req.session.regenerate((err) => {
    if (err) return res.redirect('/login?reset_ok=1');
    req.session.userId = row.user_id;
    req.session.cookie.maxAge = SESSION_DEFAULT_MAX_AGE;
    res.redirect('/dashboard');
  });
});

// ==================== TENANTS + ONBOARDING ====================
// Extracted to routes/tenants.js - first slice of server.js modularization.
// The pattern: each domain module exports register(app, deps), receives all
// dependencies explicitly, knows nothing about other domains.
require('./routes/tenants').register(app, {
  db, bcrypt,
  requireAuth,
  getActiveFirmId,
  listUserFirms,
  withToast,
  projectRoot: __dirname,
});

// (tenant + onboarding routes live in routes/tenants.js - see the require
// above. Anything that needs to call them goes through HTTP, not internal
// references.)

// ==================== AUDITOR PORTAL ====================
// Magic-link, token-authenticated read-only views for external auditors.
// Registered up here (before /workspaces/* routes) so the path namespace is
// cleanly separated. Lives in its own file to keep server.js from sprawling.
require('./routes/auditor').register(app, {
  db, enc, mdRenderer, logAction,
  getActiveMethodology, methodologyBand,
  auditPack,
  resolveUploadPath,
  fs, path,
  escapeHtml,
  requireAuth, requireWorkspace, requirePermission
});

// ==================== DASHBOARD ====================
app.get('/dashboard', requireAuth, (req, res) => {
  const workspaces = listWorkspaces(req.user);
  const workspacesWithProgress = workspaces.map(w => {
    const progress = workspaceProgress(w.id);
    const readiness = computeReadiness(w);
    const openMajorNCs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(w.id).c;
    const overdueNCs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date < date('now')`).get(w.id).c;
    const derivedStage = computeClientStage(w);
    return { ...w, progress, readiness, openMajorNCs, overdueNCs, derivedStage };
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

  // At-risk engagements - workspaces with active passes and meaningful warning
  // signals: stale controls, overdue NCs, missed targets, no recent pass.
  const portfolioRisk = workspacesWithProgress.map(w => {
    const lastPass = db.prepare(`SELECT pass_number, status, started_at, completed_at
      FROM assessment_passes WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(w.id);
    const staleControls = db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, w.id).cs} cs
      INNER JOIN iso_items i ON i.id = cs.iso_item_id
      WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
        AND (cs.last_verified_at IS NULL OR cs.last_verified_at < datetime('now','-365 days'))
        AND cs.status NOT IN ('Not Assessed','Not Applicable')`).get(w.id).c;
    const overdueNCs = w.overdueNCs || 0;
    const overdueObj = db.prepare(`SELECT COUNT(*) c FROM security_objectives
      WHERE workspace_id=? AND due_date IS NOT NULL AND due_date < date('now') AND status NOT IN ('achieved','paused')`).get(w.id).c;
    const noPassFor90 = lastPass && lastPass.completed_at
      && lastPass.completed_at < new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
    const reasons = [];
    let severity = 'ok';
    if (overdueNCs > 0) { reasons.push(`${overdueNCs} overdue NC`); severity = 'high'; }
    if (w.openMajorNCs > 0) { reasons.push(`${w.openMajorNCs} open major NC`); severity = 'high'; }
    if (w.readiness.daysToTarget !== null && w.readiness.daysToTarget < 30) { reasons.push('cert target < 30 days'); severity = 'high'; }
    if (overdueObj > 0) { reasons.push(`${overdueObj} overdue objective`); if (severity !== 'high') severity = 'medium'; }
    if (staleControls > 5) { reasons.push(`${staleControls} stale controls`); if (severity !== 'high') severity = 'medium'; }
    if (noPassFor90 && (!lastPass || lastPass.status !== 'in_progress')) {
      reasons.push('no active pass · last completed > 90d'); if (severity !== 'high') severity = 'medium';
    }
    if (!lastPass) { reasons.push('no gap assessment ever started'); if (severity !== 'high') severity = 'medium'; }
    return { ...w, lastPass, staleControls, overdueObj, severity, reasons };
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
    // Audits - table has audit_date and title (not planned_date / name).
    const audits = db.prepare(`SELECT id, workspace_id, title, audit_date AS due_date, status FROM audits
      WHERE workspace_id IN (${placeholders}) AND status NOT IN ('completed','cancelled')
      AND audit_date IS NOT NULL`).all(...wsIds);
    // MRMs - schema has meeting_date and no title column; synthesise one.
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

  // Onboarding nudge - "Resume setup" banner is for first-time firms only.
  // Suppressed once:
  //   - all steps are done,
  //   - the firm has 2+ workspaces (they're past first-engagement setup;
  //     wizard nags an established firm forever otherwise),
  //   - the wizard was explicitly skipped or completed (tenant_onboarding flags).
  // The /onboarding page itself stays reachable for those who want to find it.
  let onboarding = null;
  try {
    const tenantsModule = require('./routes/tenants');
    onboarding = tenantsModule.getOnboardingProgress(db, req.user.firm_id);
    if (onboarding) {
      const wsCount = db.prepare('SELECT COUNT(*) AS c FROM workspaces WHERE firm_id=?').get(req.user.firm_id).c;
      const onb = db.prepare('SELECT skipped, completed_at FROM tenant_onboarding WHERE firm_id=?').get(req.user.firm_id);
      const skipped = !!(onb && (onb.skipped || onb.completed_at));
      const stillFirstTime = wsCount < 2;
      if (onboarding.done >= onboarding.total) onboarding = null;
      else if (!stillFirstTime || skipped) onboarding = null;
    }
  } catch (_) {}

  res.render('dashboard', { user: req.user, workspaces: workspacesWithProgress, firmUsers, totals, atRisk, thisWeek, onboarding });
});

// Cross-client activity feed lives under Admin in the portfolio sidebar -
// pulled out of the dashboard so the landing page stays focused on the
// portfolio roll-up. Manager-only (same gate as the rest of Admin).
app.get('/admin/activity', requireAuth, (req, res) => {
  if (!rbac.isManager(req.user.firm_role)) {
    return res.status(403).render('error', { user: req.user, message: 'Only Managers can view firm-wide activity.' });
  }
  const wsIds = db.prepare(`SELECT id FROM workspaces WHERE firm_id = ?`).all(req.user.firm_id).map(r => r.id);
  let recentActivity = [];
  if (wsIds.length > 0) {
    const placeholders = wsIds.map(() => '?').join(',');
    recentActivity = db.prepare(
      `SELECT a.created_at, a.action, a.entity_type, a.entity_id, a.workspace_id,
              u.name AS user_name, w.client_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       INNER JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.workspace_id IN (${placeholders})
         AND a.created_at >= date('now','-90 days')
       ORDER BY a.created_at DESC LIMIT 200`
    ).all(...wsIds);
  }
  res.render('admin_activity', { user: req.user, ws: null, active: 'admin-activity', recentActivity });
});

// ==================== PORTFOLIO HEALTH (manager triage board) ====================
// Per-engagement health score (0-100, higher = healthier) for the firm-wide
// triage board. Reuses the same signal queries the dashboard at-risk strip
// runs so the two never disagree. The score is a transparent sum of capped
// penalties off a perfect 100, and every contributing signal is returned so
// the board can show *why* an engagement scored low, not just the number.
//
// Readiness only enters via cert pressure (urgency × unreadiness): a close
// target hurts only when you're not ready for it, and low readiness with no
// target at all is just an early engagement, not a health problem.
function computeEngagementHealth(w) {
  const readiness = computeReadiness(w);
  const progress = workspaceProgress(w.id);

  const overdueNCs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < date('now')`).get(w.id).c;
  const majorNCs = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')`).get(w.id).c;
  const staleControls = db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, w.id).cs} cs
      INNER JOIN iso_items i ON i.id = cs.iso_item_id
      WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
        AND (cs.last_verified_at IS NULL OR cs.last_verified_at < datetime('now','-365 days'))
        AND cs.status NOT IN ('Not Assessed','Not Applicable')`).get(w.id).c;
  const overdueObj = db.prepare(`SELECT COUNT(*) c FROM security_objectives WHERE workspace_id=? AND due_date IS NOT NULL AND due_date < date('now') AND status NOT IN ('achieved','paused')`).get(w.id).c;
  const overdueTasks = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND status NOT IN ('done','closed','cancelled') AND due_date IS NOT NULL AND due_date < date('now')`).get(w.id).c;
  const highRisks = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status NOT IN ('closed','accepted') AND (likelihood * impact) >= 15`).get(w.id).c;
  const lastPass = db.prepare(`SELECT pass_number, status, completed_at FROM assessment_passes WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(w.id);

  const stage1 = readiness.stage1 || 0;
  const daysToTarget = (readiness.daysToTarget === undefined) ? null : readiness.daysToTarget;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  let certPenalty = 0;
  if (daysToTarget !== null && daysToTarget < 90) {
    const urgency = clamp((90 - daysToTarget) / 90, 0, 1);
    const gap = clamp((100 - stage1) / 100, 0, 1);
    certPenalty = Math.round(urgency * gap * 35);
  }

  // "Started" = a formal pass row OR any controls already assessed. Readiness
  // can be high without a pass row (older engagements predate the passes
  // feature), so keying off the passes table alone wrongly brands a
  // well-progressed engagement as "never started."
  const started = !!lastPass || progress.assessed > 0;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  let passPenalty = 0;
  if (!started) passPenalty = 18;
  else if (lastPass && lastPass.status !== 'in_progress' && lastPass.completed_at && lastPass.completed_at < ninetyDaysAgo) passPenalty = 8;

  const contrib = [
    { label: overdueNCs === 1 ? '1 overdue NC' : `${overdueNCs} overdue NCs`, n: overdueNCs, penalty: clamp(overdueNCs * 9, 0, 27) },
    { label: majorNCs === 1 ? '1 open major NC' : `${majorNCs} open major NCs`, n: majorNCs, penalty: clamp(majorNCs * 7, 0, 21) },
    { label: daysToTarget !== null ? `cert in ${daysToTarget}d · ${stage1}% ready` : null, n: certPenalty, penalty: certPenalty },
    { label: highRisks === 1 ? '1 high risk untreated' : `${highRisks} high risks untreated`, n: highRisks, penalty: clamp(highRisks * 2.5, 0, 15) },
    { label: `${staleControls} stale controls`, n: staleControls, penalty: clamp(staleControls * 1, 0, 12) },
    { label: `${overdueTasks} overdue tasks`, n: overdueTasks, penalty: clamp(overdueTasks * 1.5, 0, 12) },
    { label: `${overdueObj} overdue objectives`, n: overdueObj, penalty: clamp(overdueObj * 3, 0, 9) },
    { label: !started ? 'no gap assessment started' : 'last pass > 90d, none active', n: passPenalty, penalty: passPenalty },
  ];

  const totalPenalty = contrib.reduce((s, c) => s + c.penalty, 0);
  const score = Math.round(clamp(100 - totalPenalty, 0, 100));
  const band = score >= 75 ? 'healthy' : score >= 50 ? 'watch' : 'at_risk';
  const reasons = contrib
    .filter(c => c.penalty > 0 && c.n > 0 && c.label)
    .sort((a, b) => b.penalty - a.penalty)
    .slice(0, 4)
    .map(c => c.label);

  return {
    id: w.id,
    name: w.brand_display_name || w.client_name,
    stage: computeClientStage(w),
    score, band, reasons, stage1, daysToTarget,
    signals: { overdueNCs, majorNCs, staleControls, overdueObj, overdueTasks, highRisks, assessedPct: progress.percent },
  };
}

// Firm-wide, ranked view of every engagement's health. The dashboard flags
// at-risk clients as a yes/no; this scores ALL of them so a manager can
// triage worst-first. Gated on firm.cross_view (manager + senior consultant);
// plain consultants don't get the cross-client lens.
app.get('/portfolio', requireAuth, (req, res) => {
  if (!isFirmUser(req.user) || !rbac.rolePermissions(req.user.firm_role).includes('firm.cross_view')) {
    return res.status(403).render('error', { user: req.user, message: 'The portfolio board is for firm managers and senior consultants.' });
  }
  const engagements = listWorkspaces(req.user)
    .map(w => computeEngagementHealth(w))
    .sort((a, b) => a.score - b.score);
  const summary = {
    total: engagements.length,
    atRisk: engagements.filter(e => e.band === 'at_risk').length,
    watch: engagements.filter(e => e.band === 'watch').length,
    healthy: engagements.filter(e => e.band === 'healthy').length,
    avgScore: engagements.length ? Math.round(engagements.reduce((s, e) => s + e.score, 0) / engagements.length) : 0,
    overdueNCs: engagements.reduce((s, e) => s + e.signals.overdueNCs, 0),
  };
  res.render('portfolio', { user: req.user, ws: null, active: 'portfolio', engagements, summary });
});

// Firm-wide schedule aggregation: every dated / assignable item across ALL of a
// firm's engagements, normalised into one list. Powers the manager calendar grid,
// the overdue strip, the KPI counts and the per-consultant workload panel — the
// cross-client sibling of the per-workspace /workspaces/:id/calendar.
//
// Each item is { kind, title, date|null, status, open, countsWorkload, wsId, wsName,
// link, ownerId|null, ownerLabel|null }. "Schedule" items (audits, reviews, cert
// milestones, vendor deadlines) show on the calendar but don't count as a person's
// workload — only items with a real per-person owner do (tasks, NCs, improvements,
// treatment actions, deliberately-assigned controls).
function collectManagerSchedule(user) {
  const wss = listWorkspaces(user);
  const wsIds = wss.map(w => w.id);
  const wsName = {};
  wss.forEach(w => { wsName[w.id] = w.brand_display_name || w.client_name; });

  // Engagement spans — drive the Outlook-style duration bars on the calendar.
  // Each project runs from kickoff (created_at) to its target certification
  // date. The manual `stage` column is unreliable, so derive the live stage.
  const projects = wss.filter(w => w.target_cert_date).map(w => {
    let stage = null;
    try { stage = computeClientStage(w).label; } catch (_) {}
    return {
      wsId: w.id,
      name: wsName[w.id],
      start: (w.created_at || '').slice(0, 10) || null,
      end: String(w.target_cert_date).slice(0, 10),
      stage,
      link: `/workspaces/${w.id}`,
    };
  });

  // The firm's people — workload rows are drawn from here, and free-text owner
  // strings (NCs, improvements) are resolved back to a person by name match.
  const people = db.prepare(
    `SELECT id, name, email, firm_role FROM users
     WHERE firm_id = ? AND user_type = 'firm' AND active = 1 ORDER BY name`
  ).all(user.firm_id);
  const byName = {};
  people.forEach(p => { if (p.name) byName[p.name.trim().toLowerCase()] = p.id; });
  const resolveName = (txt) => txt ? (byName[String(txt).trim().toLowerCase()] || null) : null;

  const items = [];
  if (!wsIds.length) return { items, people, wsName, projects, docsNeedingReviewDate: 0 };
  const ph = wsIds.map(() => '?').join(',');
  const push = (o) => items.push(o);

  // 1. Tasks (assignee_id FK) ------------------------------------------------
  db.prepare(`SELECT id, workspace_id, title, due_date, status, assignee_id
              FROM tasks WHERE workspace_id IN (${ph})`).all(...wsIds).forEach(t => {
    push({ kind:'task', title:t.title, date:t.due_date||null, status:t.status, open:t.status!=='done',
      countsWorkload:true, wsId:t.workspace_id, wsName:wsName[t.workspace_id],
      link:`/workspaces/${t.workspace_id}/tasks`, ownerId:t.assignee_id||null, ownerLabel:null });
  });

  // 2. Nonconformities (responsible TEXT) -----------------------------------
  db.prepare(`SELECT id, workspace_id, title, due_date, status, responsible
              FROM nonconformities WHERE workspace_id IN (${ph})`).all(...wsIds).forEach(n => {
    push({ kind:'nc', title:n.title, date:n.due_date||null, status:n.status, open:n.status!=='closed',
      countsWorkload:true, wsId:n.workspace_id, wsName:wsName[n.workspace_id],
      link:`/workspaces/${n.workspace_id}/nonconformities/${n.id}`,
      ownerId:resolveName(n.responsible), ownerLabel:n.responsible||null });
  });

  // 3. Improvements (owner_name TEXT) ---------------------------------------
  db.prepare(`SELECT id, workspace_id, title, due_date, status, owner_name
              FROM improvements WHERE workspace_id IN (${ph})`).all(...wsIds).forEach(i => {
    push({ kind:'improvement', title:i.title, date:i.due_date||null, status:i.status,
      open:(i.status==='open'||i.status==='in_progress'),
      countsWorkload:true, wsId:i.workspace_id, wsName:wsName[i.workspace_id],
      link:`/workspaces/${i.workspace_id}/improvements`,
      ownerId:resolveName(i.owner_name), ownerLabel:i.owner_name||null });
  });

  // 4. Risk treatment actions (owner_name TEXT) -----------------------------
  db.prepare(`SELECT id, workspace_id, title, due_date, status, owner_name, risk_id, closed_at
              FROM risk_treatment_actions WHERE workspace_id IN (${ph})`).all(...wsIds).forEach(a => {
    push({ kind:'treatment', title:a.title||'Treatment action', date:a.due_date||null, status:a.status,
      open:(!a.closed_at && a.status!=='done' && a.status!=='closed'),
      countsWorkload:true, wsId:a.workspace_id, wsName:wsName[a.workspace_id],
      link:`/workspaces/${a.workspace_id}/risks/${a.risk_id}`,
      ownerId:resolveName(a.owner_name), ownerLabel:a.owner_name||null });
  });

  // 5. Control reviews (owner_id FK; only deliberately-assigned controls) ----
  db.prepare(`SELECT workspace_id, iso_item_id, due_date, status, owner_id, applicability
              FROM control_states WHERE workspace_id IN (${ph}) AND owner_id IS NOT NULL`).all(...wsIds).forEach(c => {
    push({ kind:'control', title:`Control ${c.iso_item_id}`, date:c.due_date||null, status:c.status,
      open:(c.status!=='Implemented'&&c.applicability!=='excluded'),
      countsWorkload:true, wsId:c.workspace_id, wsName:wsName[c.workspace_id],
      link:`/workspaces/${c.workspace_id}/controls/${c.iso_item_id}`, ownerId:c.owner_id, ownerLabel:null });
  });

  // 6. Audits (schedule event) ----------------------------------------------
  db.prepare(`SELECT id, workspace_id, title, audit_date, status
              FROM audits WHERE workspace_id IN (${ph}) AND audit_date IS NOT NULL`).all(...wsIds).forEach(a => {
    push({ kind:'audit', title:a.title||'Audit', date:a.audit_date, status:a.status, open:a.status!=='closed',
      countsWorkload:false, wsId:a.workspace_id, wsName:wsName[a.workspace_id],
      link:`/workspaces/${a.workspace_id}/audits/${a.id}`, ownerId:null, ownerLabel:null });
  });

  // 7. Management reviews (schedule event) ----------------------------------
  db.prepare(`SELECT id, workspace_id, meeting_date, status
              FROM mrms WHERE workspace_id IN (${ph}) AND meeting_date IS NOT NULL`).all(...wsIds).forEach(m => {
    push({ kind:'mrm', title:'Management review', date:m.meeting_date, status:m.status,
      open:(m.status!=='completed'&&m.status!=='done'),
      countsWorkload:false, wsId:m.workspace_id, wsName:wsName[m.workspace_id],
      link:`/workspaces/${m.workspace_id}/mrms/${m.id}`, ownerId:null, ownerLabel:null });
  });

  // 8. Certification cycle milestones (schedule event) ----------------------
  db.prepare(`SELECT id, workspace_id, event_type, planned_date, status
              FROM cert_cycle_events WHERE workspace_id IN (${ph}) AND planned_date IS NOT NULL`).all(...wsIds).forEach(e => {
    push({ kind:'cert', title:String(e.event_type||'Cert event').replace(/_/g,' '), date:e.planned_date, status:e.status,
      open:(e.status!=='completed'&&e.status!=='done'),
      countsWorkload:false, wsId:e.workspace_id, wsName:wsName[e.workspace_id],
      link:`/workspaces/${e.workspace_id}/cert-cycle`, ownerId:null, ownerLabel:null });
  });

  // 9. Document reviews (next_review_date) ----------------------------------
  db.prepare(`SELECT id, workspace_id, name, next_review_date
              FROM generated_docs WHERE workspace_id IN (${ph}) AND next_review_date IS NOT NULL`).all(...wsIds).forEach(d => {
    push({ kind:'doc-review', title:`Review: ${d.name}`, date:d.next_review_date, status:null, open:true,
      countsWorkload:false, wsId:d.workspace_id, wsName:wsName[d.workspace_id],
      link:`/workspaces/${d.workspace_id}/documents/${d.id}`, ownerId:null, ownerLabel:null });
  });

  // 10. Supplier reviews due (next_review_date) -----------------------------
  try {
    db.prepare(`SELECT sr.id, sr.supplier_id, sr.next_review_date, s.workspace_id, s.name AS supplier_name
                FROM supplier_reviews sr INNER JOIN suppliers s ON s.id = sr.supplier_id
                WHERE s.workspace_id IN (${ph}) AND sr.next_review_date IS NOT NULL`).all(...wsIds).forEach(r => {
      push({ kind:'supplier', title:`Supplier review: ${(r.supplier_name||'').trim()}`.trim(), date:r.next_review_date, status:null, open:true,
        countsWorkload:false, wsId:r.workspace_id, wsName:wsName[r.workspace_id],
        link:`/workspaces/${r.workspace_id}/vendors/${r.supplier_id}`, ownerId:null, ownerLabel:null });
    });
  } catch (_) {}

  // 11. Vendor questionnaire response deadlines (link expiry) ---------------
  try {
    db.prepare(`SELECT q.id, q.workspace_id, q.supplier_id, q.template_name, q.status,
                       q.external_expires_at, q.external_completed_at, s.name AS supplier_name
                FROM supplier_questionnaires q INNER JOIN suppliers s ON s.id = q.supplier_id
                WHERE q.workspace_id IN (${ph}) AND q.external_expires_at IS NOT NULL`).all(...wsIds).forEach(qr => {
      if (qr.external_completed_at) return; // vendor already responded — no deadline pressure
      push({ kind:'questionnaire', title:`${qr.supplier_name||'Vendor'} · ${qr.template_name||'questionnaire'}`,
        date:String(qr.external_expires_at).slice(0,10), status:qr.status, open:true,
        countsWorkload:false, wsId:qr.workspace_id, wsName:wsName[qr.workspace_id],
        link:`/workspaces/${qr.workspace_id}/vendors/${qr.supplier_id}/questionnaires/${qr.id}`,
        ownerId:null, ownerLabel:null });
    });
  } catch (_) {}

  // Approved/published documents with no review date set. The app treats these
  // as a readiness gap (they can't appear on the calendar until scheduled), so
  // surface the count rather than inventing dates from the review cadence.
  let docsNeedingReviewDate = 0;
  try {
    docsNeedingReviewDate = db.prepare(
      `SELECT COUNT(*) n FROM generated_docs
       WHERE workspace_id IN (${ph}) AND status IN ('approved','published') AND next_review_date IS NULL`
    ).get(...wsIds).n;
  } catch (_) {}

  return { items, people, wsName, projects, docsNeedingReviewDate };
}

// Firm-wide calendar + team workload. A manager's cross-client view of what's due
// and who's carrying it. Gated on firm.cross_view (manager + senior consultant),
// same as /portfolio; the per-workspace calendar lives at /workspaces/:id/calendar.
app.get('/calendar', requireAuth, (req, res) => {
  if (!isFirmUser(req.user) || !rbac.rolePermissions(req.user.firm_role).includes('firm.cross_view')) {
    return res.status(403).render('error', { user: req.user, message: 'The firm calendar is for managers and senior consultants.' });
  }
  const { items, people, wsName, projects, docsNeedingReviewDate } = collectManagerSchedule(req.user);

  const today = ymdLocal(new Date());
  const weekEnd = ymdLocal(new Date(Date.now() + 7 * 86400000));

  // ----- View mode -----
  // ?month=YYYY-MM → a single-month day grid (the detail view). Otherwise the
  // default is a year-at-a-glance grid of 12 month cards, so the calendar
  // itself (not the overdue list) is the first thing on screen, and each month
  // is a click away from its day-by-day detail.
  const now = new Date();
  const thisMonth = ymLocal(now);
  const thisYear = now.getFullYear();
  const view = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? 'month' : 'year';

  // Month-detail vars (populated only in month view)
  let monthStr = null, monthLabel = '', monthCount = 0, prevMo = null, nextMo = null;
  let cells = [], weeks = [], laneCount = 0, monthProjects = [];
  // Year-overview vars (populated only in year view)
  let year = thisYear, months = [], monthRows = [], prevYear = thisYear - 1, nextYear = thisYear + 1;

  if (view === 'month') {
    monthStr = req.query.month;
    const [yr, mo] = monthStr.split('-').map(n => parseInt(n, 10));
    const monthStart = `${monthStr}-01`;
    // Local-component formatters — toISOString() is UTC and would roll the
    // 1st-of-month back a day (and a month) in IST, breaking the Prev/Next links.
    const nextMoStart = ymdLocal(new Date(yr, mo, 1));
    prevMo = ymLocal(new Date(yr, mo - 2, 1));
    nextMo = ymLocal(new Date(yr, mo, 1));
    monthLabel = new Date(yr, mo - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' });

    const byDate = {};
    items.forEach(e => {
      if (!e.date || e.date < monthStart || e.date >= nextMoStart) return;
      (byDate[e.date] = byDate[e.date] || []).push(e);
      monthCount++;
    });
    Object.values(byDate).forEach(list => list.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

    const firstDay = new Date(yr, mo - 1, 1).getDay();
    const daysInMonth = new Date(yr, mo, 0).getDate();
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${monthStr}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, date, events: byDate[date] || [] });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    // ----- Engagement span bars (Outlook-style multi-day bars over the grid) -----
    // Each engagement that overlaps the visible month gets one lane; its bar is
    // split into per-week segments positioned by grid column. Lanes are stable
    // across weeks so a project reads as one continuous horizontal bar.
    const monthEndDate = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
    monthProjects = (projects || [])
      .filter(p => p.start && p.end && p.start <= monthEndDate && p.end >= monthStart)
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.name || '').localeCompare(b.name || '')));

    for (let w = 0; w < cells.length / 7; w++) weeks.push({ days: cells.slice(w * 7, w * 7 + 7), bars: [] });

    monthProjects.forEach((p, lane) => {
      const cs = p.start < monthStart ? monthStart : p.start;
      const ce = p.end > monthEndDate ? monthEndDate : p.end;
      if (cs > ce) return;
      const gridStart = firstDay + parseInt(cs.slice(8, 10), 10) - 1;
      const gridEnd = firstDay + parseInt(ce.slice(8, 10), 10) - 1;
      const wStart = Math.floor(gridStart / 7);
      const wEnd = Math.floor(gridEnd / 7);
      const contLeft = p.start < monthStart;   // bar continues from a previous month
      const contRight = p.end > monthEndDate;   // bar continues into a later month
      const daysToCert = Math.round((Date.parse(p.end) - Date.parse(today)) / 86400000);
      for (let w = wStart; w <= wEnd; w++) {
        const segStart = Math.max(gridStart, w * 7);
        const segEnd = Math.min(gridEnd, w * 7 + 6);
        weeks[w].bars.push({
          lane,
          startCol: segStart - w * 7,
          endCol: segEnd - w * 7,
          name: p.name, link: p.link, stage: p.stage,
          start: p.start, end: p.end, daysToCert,
          capLeft: (w === wStart) && !contLeft,
          capRight: (w === wEnd) && !contRight,
          labelHere: (w === wStart) || (segStart % 7 === 0), // label at true start + each new week row
        });
      }
    });
    laneCount = monthProjects.length;
    // Per-week reserved lane rows: only as tall as the highest lane present that
    // week, so weeks with no active engagements stay compact (lanes still keep a
    // stable index across the weeks a project actually spans).
    weeks.forEach(wk => { wk.laneRows = wk.bars.length ? Math.max(...wk.bars.map(b => b.lane)) + 1 : 0; });
  } else {
    // ----- Year overview: 12 month cells, 4 per row × 3 rows (?year=YYYY) -----
    // Each cell tallies the dated items that fall in that month. Engagements are
    // drawn as continuous horizontal bars that flow across the month cells of a
    // row (Outlook-style), so a project's duration reads as one bar spanning the
    // run of months it covers, not a repeated pill in every month.
    year = (req.query.year && /^\d{4}$/.test(req.query.year)) ? parseInt(req.query.year, 10) : thisYear;
    prevYear = year - 1;
    nextYear = year + 1;
    const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
    for (let m = 0; m < 12; m++) {
      const ym = `${year}-${String(m + 1).padStart(2, '0')}`;
      months.push({
        ym,
        label: new Date(year, m, 1).toLocaleString('en', { month: 'short' }),
        start: `${ym}-01`,
        end: `${ym}-${String(new Date(year, m + 1, 0).getDate()).padStart(2, '0')}`,
        count: 0, overdue: 0, byKind: {},
        isCurrent: ym === thisMonth,
      });
    }
    items.forEach(e => {
      if (!e.date || e.date < yStart || e.date > yEnd) return;
      const b = months[parseInt(e.date.slice(5, 7), 10) - 1];
      b.count++;
      b.byKind[e.kind] = (b.byKind[e.kind] || 0) + 1;
      if (e.open && e.date < today) b.overdue++;
    });

    // Lay the 12 months out in fixed rows of 4 so bars can be positioned by
    // grid column within each row.
    const COLS = 4;
    for (let r = 0; r < 12 / COLS; r++) {
      monthRows.push({ months: months.slice(r * COLS, r * COLS + COLS), bars: [] });
    }

    // Each engagement overlapping the year gets a stable lane (= sort order).
    // Its month span is split into per-row segments; lanes stay constant across
    // rows so a project reads as one continuous bar even where it wraps.
    const yearProjects = (projects || [])
      .filter(p => p.start && p.end && p.start <= yEnd && p.end >= yStart)
      .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : (a.name || '').localeCompare(b.name || ''));
    yearProjects.forEach((p, lane) => {
      const contLeft = p.start < yStart;   // bar continues from a previous year
      const contRight = p.end > yEnd;       // bar continues into a later year
      const startIdx = contLeft ? 0 : parseInt(p.start.slice(5, 7), 10) - 1;
      const endIdx = contRight ? 11 : parseInt(p.end.slice(5, 7), 10) - 1;
      if (startIdx > endIdx) return;
      const daysToCert = Math.round((Date.parse(p.end) - Date.parse(today)) / 86400000);
      const rStart = Math.floor(startIdx / COLS);
      const rEnd = Math.floor(endIdx / COLS);
      for (let r = rStart; r <= rEnd; r++) {
        const segStart = Math.max(startIdx, r * COLS);
        const segEnd = Math.min(endIdx, r * COLS + COLS - 1);
        monthRows[r].bars.push({
          lane,
          startCol: segStart - r * COLS,
          endCol: segEnd - r * COLS,
          name: p.name, link: p.link, stage: p.stage,
          start: p.start, end: p.end, daysToCert,
          capLeft: (segStart === startIdx) && !contLeft,
          capRight: (segEnd === endIdx) && !contRight,
          labelHere: (segStart === startIdx) || (segStart % COLS === 0), // label at true start + each new row
        });
      }
    });
    // Reserve only as many lane rows per month-row as the highest lane present
    // there, so rows with no engagements stay compact.
    monthRows.forEach(row => { row.laneRows = row.bars.length ? Math.max(...row.bars.map(b => b.lane)) + 1 : 0; });
  }

  // ----- Overdue strip: every open dated item now past due (any kind) -----
  const overdue = items
    .filter(e => e.open && e.date && e.date < today)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  // ----- Per-person workload: open, assignable work items only -----
  const pmap = {};
  people.forEach(p => { pmap[p.id] = { id: p.id, name: p.name, role: p.firm_role, total: 0, overdue: 0, dueSoon: 0, byKind: {} }; });
  const unassigned = { total: 0, overdue: 0, dueSoon: 0, byKind: {} };
  let openWork = 0;
  items.forEach(e => {
    if (!e.countsWorkload || !e.open) return;
    openWork++;
    const b = (e.ownerId && pmap[e.ownerId]) ? pmap[e.ownerId] : unassigned;
    b.total++;
    b.byKind[e.kind] = (b.byKind[e.kind] || 0) + 1;
    if (e.date && e.date < today) b.overdue++;
    else if (e.date && e.date <= weekEnd) b.dueSoon++;
  });
  const workload = Object.values(pmap).sort((a, b) => b.total - a.total || (a.name || '').localeCompare(b.name || ''));
  const maxLoad = Math.max(1, unassigned.total, ...workload.map(w => w.total));

  // ----- KPIs -----
  const kpi = {
    engagements: Object.keys(wsName).length,
    openItems: openWork,
    overdue: overdue.length,
    dueSoon: items.filter(e => e.open && e.date && e.date >= today && e.date <= weekEnd).length,
    unassigned: unassigned.total,
  };

  res.render('manager_calendar', {
    user: req.user, ws: null, active: 'firm-calendar',
    view, today, thisMonth, thisYear,
    // month-detail view
    cells, weeks, laneCount, monthProjects, monthCount, monthLabel,
    prevMo, nextMo, monthStr,
    // year-overview view
    year, months, monthRows, prevYear, nextYear,
    // shared
    overdue, workload, unassigned, maxLoad, kpi,
    docsNeedingReviewDate: docsNeedingReviewDate || 0,
  });
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
  const role = rbac.FIRM_ROLES.includes(firm_role) ? firm_role : 'consultant';
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

// Set of valid iso_items.id values, computed once at boot. Used to decide
// whether a clause/Annex-A reference in glossary text resolves to a real
// page in the tool - only resolvable refs become clickable.
const ISO_ITEM_IDS = new Set(db.prepare('SELECT id FROM iso_items').all().map(r => r.id));

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Render a clauseRef string with recognised refs as <a> links. Caller passes
// the workspace ID to use as the link target. If wsId is missing, returns
// plain escaped text - refs are not clickable without a workspace.
function renderClauseRefHtml(text, wsId) {
  const escaped = escapeHtml(text);
  if (!text || !wsId) return escaped;
  let html = escaped;
  // Annex A - match A.X or A.X.Y. Longer match attempted first.
  html = html.replace(/A\.\d+(?:\.\d+)?/g, (m) => {
    const slug = 'annex-' + m.toLowerCase();
    if (ISO_ITEM_IDS.has(slug)) {
      return `<a href="/workspaces/${wsId}/controls/${slug}" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);">${m}</a>`;
    }
    return m;
  });
  // Clause refs - match "Clause(s) N[, N, …]" where each N is a dotted number
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
  // Letter buckets - only show letters that have entries (post-filter, so the bar reflects what's available).
  const letterCounts = {};
  for (const e of GLOSSARY.ENTRIES) {
    const first = /[A-Z]/.test(e.term[0]) ? e.term[0].toUpperCase() : '#';
    letterCounts[first] = (letterCounts[first] || 0) + 1;
  }
  // Category counts (across full corpus, ignoring search filter - so users see what's available).
  const categoryCounts = {};
  for (const e of GLOSSARY.ENTRIES) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
  const starter = GLOSSARY.STARTER_TERMS
    .map(slug => GLOSSARY.ENTRIES.find(e => e.slug === slug))
    .filter(Boolean);
  const linkWsId = firstWorkspaceIdFor(req.user);
  // Firm-level reference page: always render with the firm sidebar. The Glossary
  // nav link only appears in the firm-level nav, so inheriting a sticky
  // last-visited workspace would strand the user in a client's chrome - the
  // active nav item vanishes and it reads as "landing in a client page". The
  // client switcher still highlights the last-viewed workspace via
  // res.locals.lastWs, so no context is lost.
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
  if (!entry) return res.status(404).render('error', { user: req.user, message: 'No glossary entry with that slug. The 168 terms shipped with the tool are listed at /glossary - try searching there.' });
  const related = (entry.related || []).map(s => idx[s]).filter(Boolean);
  const categoryLabel = (GLOSSARY.CATEGORIES.find(c => c.key === entry.category) || {}).label || entry.category;
  const linkWsId = firstWorkspaceIdFor(req.user);
  res.render('glossary_detail', {
    user: req.user,
    ws: null, // firm-level reference page - see GET /glossary note
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
  // Framework picker. Form sends `frameworks` as either a string (one box
  // checked) or an array (two or more). An empty list falls back to all
  // three - a workspace with zero frameworks would be useless.
  const submitted = req.body.frameworks;
  let frameworks;
  if (Array.isArray(submitted))      frameworks = submitted;
  else if (typeof submitted === 'string') frameworks = [submitted];
  else                                frameworks = [];
  frameworks = frameworks.filter(f => ALLOWED_FRAMEWORKS.includes(f));
  if (!frameworks.length) frameworks = ALLOWED_FRAMEWORKS.slice();
  const id = db.prepare(`INSERT INTO workspaces (firm_id, client_name, industry, scope, target_cert_date, lead_consultant_id, frameworks)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.firm_id, client_name.trim(), industry || null,
         scope || null, target_cert_date || null, req.user.id,
         JSON.stringify(frameworks)).lastInsertRowid;
  // Seed the intake's cert-deadline answer from the create-dialog value
  // so the engagement-summary panel on /intake picks it up immediately
  // (otherwise the deadline-pressure tile stays blank until the user
  // re-enters the same date in the cert-deadline question).
  if (target_cert_date) {
    try {
      db.prepare(`INSERT INTO engagement_intake (workspace_id, question_id, answer, answered_by, answered_at)
        VALUES (?, 'cert-deadline', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(workspace_id, question_id) DO UPDATE SET answer=excluded.answer, answered_by=excluded.answered_by, answered_at=CURRENT_TIMESTAMP`)
        .run(id, target_cert_date, req.user.id);
    } catch (e) { console.error('[create-client] seed cert-deadline failed:', e.message); }
  }
  logAction(req.user.id, id, 'create_workspace', 'workspace', id, { client_name, frameworks });
  // Redirect into the intake page rather than the workspace overview. The
  // overview is meaningful only once the engagement has real context;
  // intake is the obvious next step (scope sign-off, stakeholders, crown
  // jewels) and the page already shows progress + an "Apply to workspace"
  // button that backfills the scope statement and seeds interested parties.
  res.redirect(withToast('/workspaces/' + id + '/intake', 'Workspace created - start with the engagement intake'));
});

app.get('/workspaces/:wsId', requireAuth, requireWorkspace, (req, res) => {
  const ws = req.workspace;

  // Split-brain fix: if the client setup has never been started AND the
  // scope field is empty, the overview's readiness/charts are mostly
  // zeros - send the consultant to setup instead. Once they've answered
  // even one intake question (or pasted in a scope manually), the
  // overview becomes the home and we stop redirecting.
  const intakeAnswered = db.prepare(`SELECT COUNT(*) AS c FROM engagement_intake WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer)) > 0`).get(ws.id).c;
  const hasScope = !!(ws.scope && ws.scope.trim().length > 0);
  if (intakeAnswered === 0 && !hasScope && !req.query.skipSetupRedirect) {
    return res.redirect(`/workspaces/${ws.id}/intake`);
  }
  // Partial setup signal - render overview with a banner. Threshold of
  // 8 matches "roughly the first two sections of the 25-question intake."
  // Once the scope is confirmed, the consultant has explicitly moved
  // past setup, so suppress the banner even if the answer count is low
  // (they signed off knowing what was captured).
  const setupIncomplete = intakeAnswered > 0 && intakeAnswered < 8 && !ws.scope_confirmed_at;

  const progress = workspaceProgress(ws.id);

  // Status breakdown
  const T = ctlReads.tables(db, ws.id);
  const STATUSES = ['Implemented','Partially Implemented','Work In Progress','Not Implemented','Not Applicable','Not Assessed'];
  const stateRows = db.prepare(`SELECT i.id, i.type, i.category, COALESCE(cs.status,'Not Assessed') AS status
                                FROM iso_items i
                                LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?`)
    .all(ws.id);

  const breakdown = { clauses: {}, annex: {} };
  STATUSES.forEach(s => { breakdown.clauses[s] = 0; breakdown.annex[s] = 0; });
  stateRows.forEach(r => {
    if (r.type === 'clause') breakdown.clauses[r.status]++;
    else breakdown.annex[r.status]++;
  });

  // Per-section counts (Requirements = clauses 4-10, A.5/A.6/A.7/A.8 =
  // Annex A themes). Tracks both how much has been assessed (anything not
  // "Not Assessed") and how much is Implemented. Feeds the overview's
  // gap-assessment + implementation summary panel.
  const themes = {
    requirements: { label: 'Requirements', total: 0, assessed: 0, implemented: 0 },
    org:          { label: 'A.5 Org',      total: 0, assessed: 0, implemented: 0 },
    people:       { label: 'A.6 People',   total: 0, assessed: 0, implemented: 0 },
    physical:     { label: 'A.7 Physical', total: 0, assessed: 0, implemented: 0 },
    tech:         { label: 'A.8 Tech',     total: 0, assessed: 0, implemented: 0 }
  };
  stateRows.forEach(r => {
    let key = null;
    if (r.type === 'clause') key = 'requirements';
    else if (themes[r.category]) key = r.category;
    if (!key) return;
    themes[key].total++;
    if (r.status !== 'Not Assessed') themes[key].assessed++;
    if (r.status === 'Implemented') themes[key].implemented++;
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
    INNER JOIN ${T.cs} cs ON cs.iso_item_id = i.id
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

  // Implementation roadmap - extracted to a helper so the new /roadmap page
  // can share the same source of truth as the Overview dashboard.
  const roadmap = computeRoadmap(ws, { stateRows, assetCount, riskCount, ncOpen });
  // Tier B.6 - top "needs your attention" items for the overview
  const needsAttention = computeNeedsAttention(ws.id).slice(0, 8);
  const nextStep = computeNextStep(ws);
  const derivedStage = computeClientStage(ws);
  // Active gap-assessment pass (if any) so the overview can show
  // "Pass 1 in progress · 87 of 118 assessed" without forcing the
  // consultant to click into Gap assessment to see it.
  let activePass = null;
  try {
    activePass = db.prepare(`SELECT id, pass_number, label, started_at, status
      FROM assessment_passes WHERE workspace_id=? AND status='in_progress'
      ORDER BY pass_number DESC LIMIT 1`).get(ws.id) || null;
  } catch (_) {}

  res.render('workspace', {
    user: req.user, ws, progress, breakdown, themes, riskCount, openRisks,
    assetCount, evidenceCount, openTasks, actionItems,
    docCount, auditCount, mrmCount, ncOpen, recentActivity, readiness, sparkline,
    roadmap, needsAttention, nextStep, activePass,
    setupIncomplete, intakeAnswered, derivedStage
  });
});

// Implementation roadmap + needs-attention - moved out of the Overview page
// (which is now a pure dashboard). Same data, dedicated home.
app.get('/workspaces/:wsId/roadmap', requireAuth, requireWorkspace, (req, res) => {
  const ws = req.workspace;
  // Prepare the scalars computeRoadmap needs.
  const stateRows = db.prepare(`SELECT cs.iso_item_id, cs.status, i.type
    FROM ${ctlReads.tables(db, ws.id).cs} cs INNER JOIN iso_items i ON i.id = cs.iso_item_id
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

app.post('/workspaces/:wsId/update', requireAuth, requireWorkspace, requirePermission('workspace.update'), (req, res) => {
  const {
    client_name, industry, scope, target_cert_date, stage, lead_consultant_id,
    brand_display_name, brand_primary_color, brand_logo_path, sector,
    updated_at_snapshot,
  } = req.body;
  // Validate brand color is a hex literal - anything else gets stored as null so
  // a malformed value can't break the page CSS.
  const safeColor = (typeof brand_primary_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(brand_primary_color.trim()))
    ? brand_primary_color.trim() : null;
  // Optimistic concurrency: client roundtrips workspaces.updated_at as a
  // hidden field. The UPDATE WHERE updated_at = ? guarantees only one of
  // two simultaneous edits wins; the loser is redirected to a conflict page
  // that surfaces the new state so they can re-apply their edit deliberately.
  // Forms rendered before this fix won't include the field; treat missing
  // snapshot as "skip the check" so the migration doesn't break old tabs.
  const usingCAS = !!updated_at_snapshot;
  const sql = usingCAS
    ? `UPDATE workspaces
         SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?,
             brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?,
             updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND updated_at=?`
    : `UPDATE workspaces
         SET client_name=?, industry=?, scope=?, target_cert_date=?, stage=?, lead_consultant_id=?,
             brand_display_name=?, brand_primary_color=?, brand_logo_path=?, sector=?,
             updated_at=CURRENT_TIMESTAMP
       WHERE id=?`;
  const args = [
    client_name, industry || null, scope || null, target_cert_date || null,
    stage || 'gap_assessment', lead_consultant_id || null,
    (brand_display_name || '').trim() || null,
    safeColor,
    (brand_logo_path || '').trim() || null,
    (sector || '').trim() || null,
    req.workspace.id,
  ];
  if (usingCAS) args.push(updated_at_snapshot);
  const result = db.prepare(sql).run(...args);
  if (usingCAS && result.changes === 0) {
    return res.status(409).render('error', {
      user: req.user,
      message: 'Another consultant updated this client\'s settings while you were editing. Reload the workspace settings page to see the latest values, then re-apply your changes.'
    });
  }
  logAction(req.user.id, req.workspace.id, 'update_workspace', 'workspace', req.workspace.id, null);
  res.redirect('/workspaces/' + req.workspace.id);
});

// Destructive: delete a workspace (= one client engagement) and everything
// inside it - controls, risks, evidence rows + files on disk, audits, MRMs,
// gap passes, registers. Requires typing the client name to confirm.
app.post('/workspaces/:wsId/delete', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const ws = req.workspace;
  const confirm = (req.body.confirm_name || '').trim();
  if (confirm !== ws.client_name) {
    return res.redirect(withToast('/workspaces/' + ws.id + '#workspace-settings',
      'Confirmation name did not match - nothing deleted', 'error'));
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

app.post('/workspaces/:wsId/members/client', requireAuth, requireWorkspace, requirePermission('members.add'), (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 8) return res.redirect('/workspaces/' + req.workspace.id + '/members');
  const e = email.toLowerCase().trim();
  const r = rbac.CLIENT_ROLES.includes(role) ? role : 'contributor';

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
  // Firm-side workspace members map to firm-side roles. Senior consultant is
  // the highest a firm member can hold here; Manager is firm-wide, not per-ws.
  const allowedRoles = ['senior_consultant','consultant'];
  const r = allowedRoles.includes(role) ? role : 'consultant';
  try {
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
      .run(req.workspace.id, user_id, r);
  } catch (e) { /* dup */ }
  res.redirect('/workspaces/' + req.workspace.id + '/members');
});

app.post('/workspaces/:wsId/members/:memberId/remove', requireAuth, requireWorkspace, requirePermission('members.remove'), (req, res) => {
  db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?')
    .run(req.params.memberId, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/members');
});

// ==================== TEAM SETUP (engagement kickoff) ====================
// Inserted between "scoping confirmed" and "start gap assessment." A manager
// fills the scoping questionnaire, picks the firm consultants on the
// engagement, and either invites client-side accounts (Client owner, ISMS
// manager, Contributors) or skips to do that later. The same screen also
// lives in the sidebar's Setup group so managers can revisit it after
// kickoff to add or remove people.

app.get('/workspaces/:wsId/team', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) {
    return res.status(403).render('error', { user: req.user, message: 'Only firm consultants can manage the engagement team.' });
  }
  const ws = req.workspace;
  // Firm users who could be on this engagement — all active firm members of
  // the firm that owns this workspace.
  const firmPool = db.prepare(`SELECT id, name, email, firm_role FROM users
     WHERE firm_id = ? AND user_type = 'firm' AND active = 1
     ORDER BY (firm_role = 'manager') DESC, name`).all(ws.firm_id);
  const leadConsultant = ws.lead_consultant_id
    ? db.prepare(`SELECT id, name, email, firm_role FROM users WHERE id = ?`).get(ws.lead_consultant_id)
    : null;
  // workspace_members on the firm side, excluding the lead (which is rendered
  // separately above).
  const firmMembers = db.prepare(`SELECT wm.id AS member_id, wm.role, u.id AS user_id, u.name, u.email, u.firm_role
     FROM workspace_members wm INNER JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND u.user_type = 'firm' AND u.active = 1
     ORDER BY (wm.role = 'senior_consultant') DESC, u.name`).all(ws.id);
  const clientMembers = db.prepare(`SELECT wm.id AS member_id, wm.role, u.id AS user_id, u.name, u.email, u.last_active_at
     FROM workspace_members wm INNER JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND u.user_type = 'client'
     ORDER BY CASE wm.role WHEN 'client_owner' THEN 1 WHEN 'isms_manager' THEN 2 ELSE 3 END, u.name`).all(ws.id);
  const pendingInvites = db.prepare(`SELECT id, email, name, workspace_role, expires_at, created_at
     FROM user_invitations
     WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
     ORDER BY created_at DESC`).all(ws.id);

  res.render('team_setup', {
    user: req.user, ws, active: 'team',
    firmPool, leadConsultant, firmMembers, clientMembers, pendingInvites,
    scopeConfirmed: !!ws.scope_confirmed_at,
    notice: req.query.notice || null,
    error: req.query.error || null
  });
});

app.post('/workspaces/:wsId/team/set-lead', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const leadId = parseInt(req.body.lead_consultant_id, 10) || null;
  // Validate the chosen lead is in this firm; null is allowed to clear.
  if (leadId) {
    const exists = db.prepare(`SELECT id FROM users WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`).get(leadId, req.workspace.firm_id);
    if (!exists) return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('That user is not in your firm.'));
  }
  db.prepare(`UPDATE workspaces SET lead_consultant_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(leadId, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'set_lead_consultant', 'workspace', req.workspace.id, { lead_consultant_id: leadId }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Engagement lead updated.'));
});

app.post('/workspaces/:wsId/team/add-firm-member', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const userId = parseInt(req.body.user_id, 10);
  const role = ['senior_consultant', 'consultant'].includes(req.body.role) ? req.body.role : 'consultant';
  if (!userId) return res.redirect('/workspaces/' + req.workspace.id + '/team');
  // Same-firm check; prevents adding someone from another firm via crafted form.
  const exists = db.prepare(`SELECT id FROM users WHERE id = ? AND firm_id = ? AND user_type = 'firm' AND active = 1`).get(userId, req.workspace.firm_id);
  if (!exists) return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('Pick a firm consultant.'));
  try {
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(req.workspace.id, userId, role);
  } catch (_) { /* already a member — ignore */ }
  res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant added to engagement.'));
});

app.post('/workspaces/:wsId/team/remove-firm-member/:memberId', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  db.prepare('DELETE FROM workspace_members WHERE id = ? AND workspace_id = ?').run(req.params.memberId, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Consultant removed from engagement.'));
});

app.post('/workspaces/:wsId/team/invite-client', requireAuth, requireWorkspace, async (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = (b.name || '').trim() || null;
  const role = ['client_owner', 'isms_manager', 'contributor'].includes(b.workspace_role) ? b.workspace_role : 'isms_manager';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent('A valid email is required.'));
  }
  // Reuse the duplicate-detection from /admin/users/invite. An active account
  // gets an inline reset offer on /admin/users — for the team kickoff page we
  // keep things simple and just redirect there so the manager handles it once.
  const existing = db.prepare(`SELECT id, active FROM users WHERE email = ?`).get(email);
  if (existing) {
    const which = existing.active ? 'active' : 'deactivated';
    return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' + encodeURIComponent(
      `An ${which} account already exists for ${email}. Open Admin → Users & access to reactivate, reset password, or add them to this workspace.`));
  }
  // Replace any pending invitation for the same email + workspace, same shape
  // as /admin/users/invite — keeps outstanding list tidy.
  db.prepare(`UPDATE user_invitations SET revoked_at = CURRENT_TIMESTAMP
     WHERE firm_id = ? AND workspace_id = ? AND email = ?
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`)
    .run(req.user.firm_id, req.workspace.id, email);

  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.prepare(`INSERT INTO user_invitations
      (email, name, firm_id, user_type, workspace_id, workspace_role, token_hash, expires_at, invited_by)
      VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?)`)
    .run(email, name, req.user.firm_id, req.workspace.id, role, tokenHash, expiresAt, req.user.id);

  let sendError = null;
  try {
    const emailLib = require('./lib/email');
    const firmRow = db.prepare(`SELECT name FROM firms WHERE id = ?`).get(req.user.firm_id);
    const r = await emailLib.sendInviteEmail({
      toEmail: email, toName: name, inviterName: req.user.name,
      firmName: firmRow && firmRow.name,
      role: `Client-side — ${rbac.ROLE_LABELS[role] || role}`,
      token: raw, expiresAt, firmId: req.user.firm_id
    });
    if (!r.ok) sendError = r.error || 'Email delivery failed';
  } catch (e) { sendError = e && e.message; }

  if (sendError) {
    return res.redirect('/workspaces/' + req.workspace.id + '/team?error=' +
      encodeURIComponent(`Invitation created but email failed (${sendError}). Share the link manually: /invite/${raw}`));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' +
    encodeURIComponent(`Invitation sent to ${email}. Link expires in 7 days.`));
});

app.post('/workspaces/:wsId/team/revoke-invite/:invId', requireAuth, requireWorkspace, (req, res) => {
  if (!isFirmUser(req.user)) return res.status(403).send('Forbidden');
  const inv = db.prepare(`SELECT id, workspace_id FROM user_invitations WHERE id = ?`).get(req.params.invId);
  if (!inv || inv.workspace_id !== req.workspace.id) return res.redirect('/workspaces/' + req.workspace.id + '/team');
  db.prepare(`UPDATE user_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(inv.id);
  res.redirect('/workspaces/' + req.workspace.id + '/team?notice=' + encodeURIComponent('Invitation revoked.'));
});

// ==================== CONTROLS LIST + DETAIL ====================
app.get('/workspaces/:wsId/controls', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'all';
  const search = (req.query.q || '').trim().toLowerCase();
  const T = ctlReads.tables(db, req.workspace.id);
  let rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
      cs.applicability, cs.maturity, cs.owner_id, cs.due_date,
      (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
      FROM iso_items i
      LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
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

// Per-item diagnostic questions - bespoke for the 25 main-body clauses and high-impact
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

// Post-assessment summary - converts a completed gap walkthrough into a worklist:
// remediation tasks, missing documents, evidence asks, untreated linked risks.
app.get('/workspaces/:wsId/controls/assess/summary', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;

  // Gaps = anything Not Implemented / Partially Implemented / Work In Progress
  // (clauses + controls). Excludes Not Applicable and Not Assessed (those are different problems).
  // max_risk_score is the worst L*I across linked risks - used to bump priority for
  // Not-Implemented controls protecting high-impact risks.
  const T = ctlReads.tables(db, wsId);
  const gaps = db.prepare(`
    SELECT i.id, i.type, i.title, i.category, cs.status, cs.maturity, cs.notes,
      EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id=? AND t.iso_item_id=i.id AND t.status NOT IN ('done')) AS has_open_task,
      (SELECT MAX(r.likelihood * r.impact) FROM risk_controls rc
       INNER JOIN risks r ON r.id = rc.risk_id
       WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS max_risk_score
    FROM iso_items i
    INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    ORDER BY i.sort_order`).all(wsId, wsId, wsId);

  // Items still Not Assessed
  const notAssessedCount = db.prepare(`SELECT COUNT(*) c FROM iso_items i
    LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') AND (cs.status IS NULL OR cs.status='Not Assessed')`).get(wsId).c;

  // Items needing a policy/procedure: status not Implemented AND no document linked
  const docGaps = db.prepare(`
    SELECT i.id, i.type, i.title, cs.status FROM iso_items i
    INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
      AND NOT EXISTS (SELECT 1 FROM ${T.doc} dc INNER JOIN generated_docs d ON d.id=dc.document_id
                      WHERE dc.iso_item_id=i.id AND d.workspace_id=?)
    ORDER BY i.sort_order`).all(wsId, wsId);

  // Items marked Implemented but with NO evidence files attached - auditor will press on these
  const evidenceAsks = db.prepare(`
    SELECT i.id, i.type, i.title FROM iso_items i
    INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') AND cs.status='Implemented'
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
    ORDER BY i.sort_order`).all(wsId, wsId);

  // Risks linked to gap-state controls (treatment plan needs updating)
  const untreatedLinkedRisks = db.prepare(`
    SELECT r.id, r.title, r.likelihood, r.impact, r.status,
      GROUP_CONCAT(DISTINCT i.id || '|' || cs.status) AS blocking_controls
    FROM risks r INNER JOIN risk_controls rc ON rc.risk_id=r.id
    INNER JOIN iso_items i ON i.id=rc.iso_item_id
    INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE r.workspace_id=? AND r.status='open'
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    GROUP BY r.id, r.title, r.likelihood, r.impact, r.status
    ORDER BY (r.likelihood * r.impact) DESC`).all(wsId, wsId);

  // Status distribution for header
  const dist = { Implemented: 0, 'Partially Implemented': 0, 'Work In Progress': 0, 'Not Implemented': 0, 'Not Applicable': 0, 'Not Assessed': 0 };
  db.prepare(`SELECT COALESCE(cs.status,'Not Assessed') AS s, COUNT(*) AS c
    FROM iso_items i LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') GROUP BY s`).all(wsId).forEach(r => { dist[r.s] = r.c; });

  res.render('controls_assess_summary', {
    user: req.user, ws: req.workspace, gaps, docGaps, evidenceAsks, untreatedLinkedRisks,
    notAssessedCount, dist,
    active: 'gap-assessment-summary'
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
  // Re-check open-task existence inside the transaction. The post-assessment
  // summary view filters with `has_open_task` at render time, but two
  // consultants both looking at the same list and both clicking "Spawn" would
  // each INSERT — duplicate "Remediate A.5.15…" tasks for the same control.
  // This statement is run per id at commit time, so it catches concurrent
  // spawns no matter when the render happened.
  const hasOpen = db.prepare(`SELECT 1 FROM tasks
     WHERE workspace_id = ? AND iso_item_id = ? AND status NOT IN ('done','closed','cancelled') LIMIT 1`);
  let added = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (hasOpen.get(req.workspace.id, id)) { skipped++; continue; }
      const item = db.prepare(`SELECT i.id, i.type, i.title, cs.status, cs.notes,
        (SELECT MAX(r.likelihood * r.impact) FROM risk_controls rc
         INNER JOIN risks r ON r.id = rc.risk_id
         WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS max_risk_score
        FROM iso_items i
        LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
        WHERE i.id=?`).get(req.workspace.id, req.workspace.id, id);
      if (!item) continue;
      const cleanTitle = item.title.replace(/^A\.[0-9.]+ /,'').replace(/^[0-9.]+ /,'');
      const taskTitle = `Remediate ${item.id.replace('annex-','').replace('clause-','').toUpperCase()} - ${cleanTitle}`;
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
  logAction(req.user.id, req.workspace.id, 'spawn_remediation_tasks', 'task', null, { count: added, skipped }, auditCtx(req));
  const skippedNote = skipped > 0 ? ` (skipped ${skipped} item${skipped === 1 ? '' : 's'} that already had an open task)` : '';
  res.redirect(withToast(`/workspaces/${req.workspace.id}/controls/assess/summary`, `Spawned ${added} remediation task${added === 1 ? '' : 's'} with auto-priority${skippedNote}`));
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
  // Reserved literal sub-routes - let them fall through to their own handlers
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

  // Theme-jump navigator data. A real consultant doesn't walk 118 items
  // sequentially — they bounce between themes. The nav builds an index of
  // every clause + control with its current assessment status, grouped into
  // (a) main clauses by section, (b) Annex A by category.
  const navRows = db.prepare(`SELECT i.id, i.type, i.category, i.title, i.sort_order,
      COALESCE(cs.status, 'Not Assessed') AS status
    FROM iso_items i
    LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type IN ('clause','control')
    ORDER BY i.sort_order`).all(req.workspace.id);
  const navGroups = [
    { key: 'clauses', label: 'Main clauses', items: navRows.filter(r => r.type === 'clause') },
    { key: 'org',     label: 'A.5 Organisational', items: navRows.filter(r => r.type === 'control' && r.category === 'org') },
    { key: 'people',  label: 'A.6 People',         items: navRows.filter(r => r.type === 'control' && r.category === 'people') },
    { key: 'physical',label: 'A.7 Physical',       items: navRows.filter(r => r.type === 'control' && r.category === 'physical') },
    { key: 'tech',    label: 'A.8 Technological',  items: navRows.filter(r => r.type === 'control' && r.category === 'tech') }
  ].map(g => {
    const done = g.items.filter(r => r.status !== 'Not Assessed').length;
    return { ...g, done, total: g.items.length };
  });

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

  // Evidence files attached to this control - displayed in a panel on the wizard
  // since the standalone control detail page was removed and there's no other home.
  // Evidence linked to this control via either the primary
  // (evidence.iso_item_id) OR the converged evidence_requirement_links join. UNION
  // because the primary is also represented in erl, but a non-primary join
  // entry might exist independently.
  const evidenceList = evReads.controlPanelEvidence(db, req.workspace.id, item.id);

  // Linked risks, documents, and open NCs - read-only summary panels.
  const linkedRisks = db.prepare(`SELECT r.id, r.title, r.likelihood, r.impact, r.status
    FROM risks r INNER JOIN risk_controls rc ON rc.risk_id=r.id
    WHERE rc.iso_item_id=? AND r.workspace_id=?
    ORDER BY (r.likelihood * r.impact) DESC`).all(item.id, req.workspace.id);

  const linkedDocs = db.prepare(`SELECT d.id, d.name, d.category, d.status, dc.section_ref, dc.id AS link_id
    FROM document_controls dc INNER JOIN generated_docs d ON d.id=dc.document_id
    WHERE dc.iso_item_id=? AND d.workspace_id=? ORDER BY d.name`).all(item.id, req.workspace.id);
  // Workspace's documents that aren't already linked - the add-link dropdown.
  const linkableDocs = db.prepare(`SELECT id, name, category, status FROM generated_docs
    WHERE workspace_id=? AND id NOT IN (SELECT document_id FROM document_controls WHERE iso_item_id=?)
    ORDER BY name`).all(req.workspace.id, item.id);

  const openNCs = db.prepare(`SELECT id, title, severity, status, due_date FROM nonconformities
    WHERE iso_item_id=? AND workspace_id=? AND status NOT IN ('closed','verified')
    ORDER BY (CASE severity WHEN 'major' THEN 0 WHEN 'minor' THEN 1 ELSE 2 END), due_date IS NULL, due_date`).all(item.id, req.workspace.id);

  // Crosswalks - which other frameworks this control also satisfies. Read from
  // the framework_mappings table seeded from data/framework-mappings.js. ISO
  // 27001 Annex A is the keyed side; the value is a free-text external ref
  // (e.g., "CC6.1, CC6.2") in the target framework. Clauses don't carry
  // mappings today, so the result is empty for them.
  const crosswalks = db.prepare(
    `SELECT framework, external_ref, notes FROM framework_mappings
     WHERE iso_item_id = ? ORDER BY framework`
  ).all(item.id);
  const crosswalksByFramework = {};
  for (const m of crosswalks) {
    if (!crosswalksByFramework[m.framework]) crosswalksByFramework[m.framework] = [];
    crosswalksByFramework[m.framework].push(m);
  }

  // Per-pass notes - derived from history. The current pass's textarea shows
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
  // Fallback to the live state notes when no history row exists for the
  // active pass yet. Without this, anything written via autosave (which
  // writes only to control_states.notes, not to control_state_history) is
  // invisible until someone clicks the explicit Save button. That meant
  // consultant B opened a control after consultant A had typed notes and saw
  // an empty textarea, even though the data was sitting in the live state.
  if (!currentPassNotes && state && state.notes) currentPassNotes = state.notes;
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

  // Comments thread + @-mention hints. Comments are scoped to this workspace
  // and this iso_item via parent_type/parent_id. Decryption is a no-op if the
  // workspace doesn't have encryption_enabled set.
  const commentsRaw = db.prepare(`SELECT c.id, c.body, c.internal_only, c.created_at, c.user_id, u.name AS user_name
    FROM comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.workspace_id=? AND c.parent_type='iso_item' AND c.parent_id=?
    ORDER BY c.created_at ASC`).all(req.workspace.id, item.id);
  const comments = commentsRaw.map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
  const firmUsers = db.prepare(`SELECT id, name FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name`).all(req.workspace.firm_id);

  // Review state + reviewer/requester names for the flag-for-review badge
  let requestedByName = null, reviewedByName = null;
  if (state.review_requested_by) requestedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.review_requested_by)?.name;
  if (state.reviewed_by) reviewedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.reviewed_by)?.name;
  // Can this user act on a flagged item? Reviewers = anyone with firm role of manager/senior_consultant.
  const isReviewer = req.user.user_type === 'firm' && ['manager','senior_consultant'].includes(rbac.normalizeRole(req.user.firm_role));

  res.render('controls_assess', {
    user: req.user, ws: req.workspace, item, state, totals, position, sectionPosition, relatedRows,
    prevId, nextId: nextById, doneFlag: !!req.query.done,
    questions, savedAnswers, suggestedStatus,
    evidenceList, linkedRisks, linkedDocs, openNCs, linkableDocs,
    activePass, currentPassNotes, priorPassNotes,
    crosswalksByFramework,
    navGroups,
    comments, firmUsers,
    requestedByName, reviewedByName, isReviewer
  });
});

app.post('/workspaces/:wsId/controls/assess/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id, sort_order, type FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  getOrCreateState(req.workspace.id, item.id);

  const { applicability, status, maturity, inclusion_justification, exclusion_justification, notes, scope_pct, last_updated_snapshot } = req.body;
  const sets = [], vals = [];
  // Clauses are not subject to SoA applicability - every certified ISMS must satisfy them.
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

  // Diagnostic answers - persist as JSON keyed by question index (questions vary per item).
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
  // Optimistic-concurrency: gap-assessment forms include the last_updated
  // value they were rendered with. UPDATE WHERE last_updated = ? catches the
  // case where another consultant already saved this control after the form
  // was loaded; the loser gets a friendly conflict page rather than silently
  // overwriting the new state. Pre-CAS form posts (no hidden field) fall
  // through to the old last-writer-wins behaviour for backwards compat.
  const usingCAS = !!last_updated_snapshot;
  let updateSQL = `UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`;
  vals.push(req.workspace.id, item.id);
  if (usingCAS) {
    updateSQL += ` AND last_updated = ?`;
    vals.push(last_updated_snapshot);
  }
  const result = db.prepare(updateSQL).run(...vals);
  if (usingCAS && result.changes === 0) {
    return res.status(409).render('error', {
      user: req.user,
      message: `Another consultant updated ${req.params.isoId.replace('annex-','').replace('clause-','').toUpperCase()} while you were assessing it. Refresh the page to see their changes, then re-apply yours.`
    });
  }

  // Append-only history snapshot - written after the UPDATE so it captures the new
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
  // Re-index for search now that the control's notes / state may have changed.
  fts.refresh(req.workspace.id, 'control', item.id);
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

// ==================== FLAG-FOR-REVIEW (ISO 27001) ====================
// A junior consultant flags an assessment item; the engagement lead or any
// firm member with assessment.signoff reviews. Both frameworks share a
// generic state machine: none -> requested -> reviewed | needs_changes.
function notifyReviewers(wsId, requesterUserId, item, reason, framework) {
  // Engagement lead + anyone with assessment.signoff in this workspace.
  const ws = db.prepare(`SELECT lead_consultant_id, firm_id FROM workspaces WHERE id=?`).get(wsId);
  const recipients = new Set();
  if (ws && ws.lead_consultant_id && ws.lead_consultant_id !== requesterUserId) recipients.add(ws.lead_consultant_id);
  // Firm users with manager / senior_consultant roles get notified.
  const firmReviewers = db.prepare(`SELECT id FROM users
    WHERE firm_id=? AND user_type='firm' AND active=1
      AND firm_role IN ('manager','senior_consultant')
      AND id != ?`).all(ws ? ws.firm_id : 0, requesterUserId);
  firmReviewers.forEach(u => recipients.add(u.id));
  const linkPath = framework === 'iso42001'
    ? `/workspaces/${wsId}/iso42001/gap/${item.id}`
    : `/workspaces/${wsId}/controls/assess/${item.id}`;
  const itemCode = framework === 'iso42001'
    ? item.id.replace('ai-annex-','').replace('ai-clause-','').toUpperCase().replace(/-/g,'.')
    : item.id.replace('annex-','').replace('clause-','').toUpperCase();
  recipients.forEach(uid => {
    jobs.notify(wsId, uid, 'review_request', 'warning',
      `Review requested on ${itemCode}`, (reason || '').slice(0, 140), linkPath);
  });
}

app.post('/workspaces/:wsId/controls/assess/:isoId/flag-for-review', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  db.prepare(`INSERT OR IGNORE INTO control_states (workspace_id, iso_item_id) VALUES (?, ?)`).run(req.workspace.id, item.id);
  db.prepare(`UPDATE control_states
    SET review_status='requested', review_requested_by=?, review_requested_at=CURRENT_TIMESTAMP, review_reason=?,
        reviewed_by=NULL, reviewed_at=NULL
    WHERE workspace_id=? AND iso_item_id=?`)
    .run(req.user.id, req.body.reason || null, req.workspace.id, item.id);
  logAction(req.user.id, req.workspace.id, 'flag_for_review', 'control', item.id, { reason: req.body.reason }, auditCtx(req));
  notifyReviewers(req.workspace.id, req.user.id, item, req.body.reason, 'iso27001');
  res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
});

app.post('/workspaces/:wsId/controls/assess/:isoId/review-action', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  const action = req.body.action; // 'approve' or 'send_back'
  if (!['approve', 'send_back'].includes(action)) return res.status(400).send('Bad action');
  const newStatus = action === 'approve' ? 'reviewed' : 'needs_changes';
  const cur = db.prepare(`SELECT review_requested_by FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
  db.prepare(`UPDATE control_states SET review_status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
    WHERE workspace_id=? AND iso_item_id=?`).run(newStatus, req.user.id, req.workspace.id, item.id);
  logAction(req.user.id, req.workspace.id, 'review_action', 'control', item.id, { action, note: req.body.note }, auditCtx(req));
  // Notify the requester that the review is done.
  if (cur && cur.review_requested_by && cur.review_requested_by !== req.user.id) {
    const code = item.id.replace('annex-','').replace('clause-','').toUpperCase();
    const verb = action === 'approve' ? 'approved your review on' : 'sent back your review on';
    jobs.notify(req.workspace.id, cur.review_requested_by, 'review_complete', 'info',
      `Reviewer ${verb} ${code}`, (req.body.note || '').slice(0, 140),
      `/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
  }
  res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
});

app.post('/workspaces/:wsId/controls/assess/:isoId/clear-flag', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  db.prepare(`UPDATE control_states
    SET review_status='none', review_requested_by=NULL, review_requested_at=NULL, review_reason=NULL,
        reviewed_by=NULL, reviewed_at=NULL
    WHERE workspace_id=? AND iso_item_id=?`).run(req.workspace.id, item.id);
  logAction(req.user.id, req.workspace.id, 'clear_review_flag', 'control', item.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
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
  // Race-safe lazy auto-start. Two consultants saving the first wizard answer
  // in a fresh workspace can both observe no-active-pass and both try to
  // INSERT pass_number=1; the UNIQUE INDEX idx_passes_ws_num catches the
  // second one. We catch SQLITE_CONSTRAINT_UNIQUE and re-read instead of
  // surfacing a 500. The transaction is per-call (no big lock); the only
  // contention is the brief window between MAX read and INSERT.
  const tryCreate = () => {
    const active = getActivePass(wsId);
    if (active) return active.id;
    const lastNum = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n
      FROM assessment_passes WHERE workspace_id=?`).get(wsId).n;
    const nextNum = lastNum + 1;
    return db.prepare(`INSERT INTO assessment_passes
      (workspace_id, pass_number, label, status, started_by)
      VALUES (?, ?, ?, 'in_progress', ?)`)
      .run(wsId, nextNum, nextNum === 1 ? 'Initial gap assessment' : `Re-assessment ${nextNum - 1}`, userId).lastInsertRowid;
  };
  try {
    return tryCreate();
  } catch (e) {
    // SqliteError.code is SQLITE_CONSTRAINT_UNIQUE on the duplicate
    // pass_number. Any other error rethrows. On a unique-collision the other
    // request just won; re-read and return its id.
    if (e && e.code && e.code.startsWith('SQLITE_CONSTRAINT')) {
      const active = getActivePass(wsId);
      if (active) return active.id;
    }
    throw e;
  }
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

  // Re-engagement orientation - when a new pass is starting (or active),
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

  // Trend across passes - average maturity per Annex A theme per pass.
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

  // Annex A heatmap - current coverage by theme.
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
  // If an active pass exists, complete it before starting a new one - only
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
  // Conditional UPDATE: only commit if the pass is still in_progress. Two
  // consultants clicking "Complete pass" simultaneously: the first UPDATE
  // matches and writes completed_by; the second sees changes=0 and is told
  // it was already completed. Replaces the previous LWW behaviour where both
  // writes succeeded and the audit trail recorded two different completers.
  const result = db.prepare(`UPDATE assessment_passes
    SET status='completed', completed_at=datetime('now'), completed_by=?
    WHERE id=? AND status='in_progress'`).run(req.user.id, p.id);
  if (result.changes === 0) {
    return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
      `Pass ${p.pass_number} was just completed by another consultant.`, 'info'));
  }
  logAction(req.user.id, wsId, 'complete_assessment_pass', 'pass', p.id, { pass_number: p.pass_number });
  res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Completed Pass ${p.pass_number}: ${p.label}`));
});

app.post('/workspaces/:wsId/gap-assessment/:passId/reopen', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;
  const p = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
  if (!p) return res.status(404).send('Not found');
  // Only one pass can be in_progress - close any other before reopening.
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

// Diff between two passes - for each control, show the state at the end of
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

// Append-only history of every wizard save for one item - what the auditor asks for.
app.get('/workspaces/:wsId/controls/:isoId/history', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const item = db.prepare(`SELECT id, type, title FROM iso_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  const rows = db.prepare(`SELECT h.*, u.name AS changed_by_name FROM control_state_history h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.workspace_id=? AND h.iso_item_id=?
    ORDER BY h.snapshot_at DESC LIMIT 200`).all(req.workspace.id, item.id);
  res.render('control_history', { user: req.user, ws: req.workspace, item, rows });
});

// The standalone control detail page was removed - the wizard now hosts
// evidence, linked risks, linked documents, NCs, and history alongside
// the audit-grade reference content and assessment form. Existing inbound
// links from SoA, risks, NCs, etc. continue to work via this redirect.
app.get('/workspaces/:wsId/controls/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
  // Reserved literal sub-routes - let them fall through.
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
  const trimmedBody = body.trim();
  const insResult = db.prepare(`INSERT INTO comments (workspace_id, parent_type, parent_id, user_id, body, internal_only)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, parent_type, parent_id, req.user.id,
         enc.encryptIfNeeded(trimmedBody, req.workspace.id, !!req.workspace.encryption_enabled),
         internal);
  const commentId = insResult.lastInsertRowid;

  // Parse @-mentions from the plaintext body, resolve handles to users in
  // the same firm, insert comment_mentions rows, fire notifications.
  // Handles match the user's full name with whitespace removed, case-
  // insensitive. Cannot mention yourself. Used to be a separate route at
  // /comments/:id/mentions that nothing ever called - hence the bug where
  // typing @priyasharma in the comment box notified no one.
  const handles = extractMentions(trimmedBody);
  if (handles.length) {
    const users = db.prepare(`SELECT id, name FROM users WHERE active=1 AND firm_id=?`).all(req.user.firm_id);
    const insMention = db.prepare(`INSERT OR IGNORE INTO comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?)`);
    let mentioned = 0;
    for (const h of handles) {
      const target = users.find(u => u.name.toLowerCase().replace(/\s+/g, '') === h.toLowerCase());
      if (target && target.id !== req.user.id) {
        insMention.run(commentId, target.id);
        mentioned++;
        try {
          jobs.notify(req.workspace.id, target.id, 'mention', 'info',
            `@${h} you were mentioned`, trimmedBody.slice(0, 140),
            `/workspaces/${req.workspace.id}`);
        } catch (_) {}
      }
    }
    if (mentioned > 0) db.prepare(`UPDATE comments SET has_mentions=1 WHERE id=?`).run(commentId);
  }

  logAction(req.user.id, req.workspace.id, 'add_comment', parent_type, parent_id, { internal }, auditCtx(req));
  const back = req.headers.referer || '/workspaces/' + req.workspace.id;
  res.redirect(back);
});

// ==================== EVIDENCE ====================
// Workspace-wide evidence library - every uploaded file with its links, owner,
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
           ${evReads.linkCountSubquery()} AS link_count,
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

  // Linked controls (ISO 27001 chips) + cross-framework link details for the
  // visible rows. Sourced from the legacy join tables or the converged
  // evidence_requirement_links per the per-workspace cutover flag; the legacy
  // link_id handle is preserved on both paths so the still-legacy unlink /
  // section-edit writes keep working. See lib/evidence-reads.js.
  // crossLinksByEvidence[evId] = { iso27001: [...], iso42001: [...], csf: [...] }
  const { linksByEvidence, crossLinksByEvidence } = evReads.libraryLinks(
    db, evidenceList.map(e => e.id));

  // Aggregate counters across all *active* evidence (the filter pills).
  const counters = {
    total: allEvidence.length,
    expired: allEvidence.filter(e => e.valid_until && e.valid_until < today).length,
    expiring: allEvidence.filter(e => e.valid_until && e.valid_until >= today && e.valid_until < expSoon).length,
    unlinked: allEvidence.filter(e => (e.link_count || 0) === 0).length,
    superseded: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND superseded_at IS NOT NULL`).get(req.workspace.id).c
  };

  // Tag cloud - every distinct tag used in this workspace, with counts.
  const tagCounts = {};
  for (const e of allEvidence) {
    if (!e.tags) continue;
    for (const t of e.tags.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  const tagList = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const allIsoItems = db.prepare(`SELECT id, type, title FROM iso_items ORDER BY sort_order ASC`).all();
  // Per-framework catalogs for the "Link to..." picker on each row. Only
  // populated when the workspace has that framework enabled.
  const allIso42001Items = req.workspace.frameworks.includes('iso42001')
    ? db.prepare(`SELECT id, type, title FROM iso42001_items ORDER BY sort_order ASC`).all() : [];
  const allCsfSubcats = req.workspace.frameworks.includes('csf')
    ? db.prepare(`SELECT code, description FROM csf_subcategories ORDER BY code ASC`).all() : [];

  res.render('evidence_library', {
    user: req.user, ws: req.workspace,
    title: 'Evidence library',
    active: 'evidence',
    evidenceList, linksByEvidence, counters,
    crossLinksByEvidence,
    allIsoItems, allIso42001Items, allCsfSubcats,
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

app.post('/workspaces/:wsId/evidence', requireAuth, requireWorkspace, requirePermission('evidence.upload'), upload.single('file'), (req, res) => {
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
  // before (and it isn't superseded), don't create a duplicate row - link the
  // existing file to the new control IDs and discard the new upload.
  const existing = db.prepare(`SELECT id, filename FROM evidence
    WHERE workspace_id=? AND sha256=? AND superseded_at IS NULL
    ORDER BY id DESC LIMIT 1`).get(req.workspace.id, sha);
  if (existing) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    if (isoIds.length) {
      const tx = db.transaction(() => { for (const id of isoIds) evWrites.attachIsoControl(db, existing.id, id, clause_section || null); });
      try { tx(); } catch (_) {}
    }
    logAction(req.user.id, req.workspace.id, 'dedupe_evidence', 'evidence', existing.id, { sha, link_count: isoIds.length });
    const back = req.headers.referer || '/workspaces/' + req.workspace.id + '/evidence';
    return res.redirect(withToast(back, `Same file already exists (${existing.filename}) - linked instead of duplicated`));
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
    const tx = db.transaction(() => { for (const id of isoIds) evWrites.attachIsoControl(db, evId, id, clause_section || null); });
    try { tx(); } catch (_) {}
  }
  logAction(req.user.id, req.workspace.id, 'upload_evidence', 'control', primaryId, { filename: req.file.originalname, link_count: isoIds.length });
  const back = req.headers.referer || '/workspaces/' + req.workspace.id;
  res.redirect(back);
});

// Bulk upload - multiple files at once with shared metadata. Each file becomes
// an independent evidence row; all share the same period / valid_from / valid_until
// and link to the same set of selected controls.
app.post('/workspaces/:wsId/evidence/bulk', requireAuth, requireWorkspace, requirePermission('evidence.upload'), upload.array('files', 50), (req, res) => {
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
        const tx = db.transaction(() => { for (const id of isoIds) evWrites.attachIsoControl(db, existing.id, id, null); });
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
      const tx = db.transaction(() => { for (const id of isoIds) evWrites.attachIsoControl(db, evId, id, null); });
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
app.post('/workspaces/:wsId/evidence/:id/supersede', requireAuth, requireWorkspace, requirePermission('evidence.upload'), upload.single('file'), (req, res) => {
  const old = db.prepare(`SELECT * FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!old) return res.status(404).send('Not found');
  if (!req.file) return redirectBack(req, res, 'Pick the new version of the file', 'error');
  const buf = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha === old.sha256) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, 'New file is identical to the existing version - nothing to supersede', 'info'));
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
  // Copy links from old to new (evidence_requirement_links).
  const tx = db.transaction(() => { evWrites.copyControlLinks(db, old.id, newId); });
  try { tx(); } catch (_) {}
  // Mark old as superseded - kept for audit trail but hidden from active view.
  db.prepare(`UPDATE evidence SET superseded_at=datetime('now'), superseded_by_id=? WHERE id=?`).run(newId, old.id);
  logAction(req.user.id, req.workspace.id, 'supersede_evidence', 'evidence', old.id, { new_id: newId, filename: req.file.originalname });
  res.redirect(withToast(`/workspaces/${req.workspace.id}/evidence`, `Superseded ${old.filename} → ${req.file.originalname}`));
});

// Auditor evidence-pack export - single ZIP of every active (non-superseded)
// evidence file in the workspace, plus a manifest CSV describing each one.
app.get('/workspaces/:wsId/evidence/pack.zip', requireAuth, requireWorkspace, (req, res) => {
  const dateFrom = (req.query.from || '').toString();
  const dateTo = (req.query.to || '').toString();
  let where = 'e.workspace_id = ? AND e.superseded_at IS NULL';
  const params = [req.workspace.id];
  if (dateFrom) { where += ' AND date(e.uploaded_at) >= date(?)'; params.push(dateFrom); }
  if (dateTo)   { where += ' AND date(e.uploaded_at) <= date(?)'; params.push(dateTo); }
  const items = db.prepare(`SELECT e.*, u.name AS uploader,
    ${evReads.linkedControlsSubquery()} AS linked_controls
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
`Evidence pack - workspace ${req.workspace.client_name || req.workspace.id}
Generated: ${new Date().toISOString()}
Files: ${items.length}
Date range: ${dateFrom || 'all'} → ${dateTo || 'all'}

MANIFEST.csv lists every file in this pack with its SHA-256, linked controls,
period, validity, and uploader. The /files/ directory contains the actual
artefacts. SHA-256 lets you verify nothing was tampered with after export.
`,
    { name: 'README.txt' }
  );

  // Files - resolve via the partitioned-or-legacy resolver shared with /download.
  for (const e of items) {
    const found = resolveUploadPath(e.stored_path, req.workspace.firm_id);
    if (found && fs.existsSync(found) && fs.statSync(found).isFile()) {
      archive.file(found, { name: `files/${e.id}-${e.filename}` });
    }
  }
  archive.finalize();
});

// Tier A.1 - Add/remove additional control links on an evidence file.
// section_ref may be either a single shared value (form: section_ref=...) or
// per-link via a parallel array section_ref_for_<isoId>=... - the latter wins.
// Cross-framework link route. Accepts framework=iso42001|csf and one or more
// item_ref values, writing them to evidence_requirement_links. The /controls
// endpoint is the ISO 27001 equivalent; both resolve their ref to a requirement.
app.post('/workspaces/:wsId/evidence/:id/links', requireAuth, requireWorkspace, requirePermission('evidence.upload'), (req, res) => {
  const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const framework = (req.body.framework || '').toString();
  if (!ALLOWED_FRAMEWORKS.includes(framework) || framework === 'iso27001') {
    // ISO 27001 keeps its own legacy route so the section_ref + primary
    // bookkeeping stays consistent. Cross-framework only here.
    return res.status(400).send('Use /controls for ISO 27001 links');
  }
  const refs = parseFormArray(req.body.item_ref);
  if (!refs.length) return redirectBack(req, res);
  // Validate item_refs against the framework's source-of-truth table so a
  // typo or attacker-injected ref doesn't get stored.
  let valid;
  if (framework === 'iso42001') {
    const ph = refs.map(() => '?').join(',');
    valid = new Set(db.prepare(`SELECT id FROM iso42001_items WHERE id IN (${ph})`).all(...refs).map(r => r.id));
  } else { // csf
    const ph = refs.map(() => '?').join(',');
    valid = new Set(db.prepare(`SELECT code FROM csf_subcategories WHERE code IN (${ph})`).all(...refs).map(r => r.code));
  }
  const filtered = refs.filter(r => valid.has(r));
  if (!filtered.length) return redirectBack(req, res);
  const tx = db.transaction(() => {
    for (const ref of filtered) evWrites.attachCrossLink(db, ev.id, framework, ref, req.body.section_ref || null);
  });
  try { tx(); } catch (_) {}
  logAction(req.user.id, req.workspace.id, 'link_evidence_cross_framework', 'evidence', ev.id,
            { framework, refs: filtered, count: filtered.length }, auditCtx(req));
  redirectBack(req, res);
});

// Delete a single cross-framework link.
app.post('/workspaces/:wsId/evidence/:id/links/:linkId/delete', requireAuth, requireWorkspace, requirePermission('evidence.delete'), (req, res) => {
  const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  // Don't touch iso27001 rows from this route - those belong to the legacy
  // /controls flow which has additional primary-key bookkeeping.
  const link = evWrites.unlinkCrossLink(db, ev.id, req.params.linkId);
  if (link) {
    logAction(req.user.id, req.workspace.id, 'unlink_evidence_cross_framework', 'evidence', ev.id,
              { framework: link.framework, item_ref: link.item_ref }, auditCtx(req));
  }
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/evidence/:id/controls', requireAuth, requireWorkspace, requirePermission('evidence.upload'), (req, res) => {
  const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const ids = parseFormArray(req.body.iso_item_id);
  if (!ids.length) return redirectBack(req, res);
  const sharedSectionRef = req.body.section_ref || null;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const perLinkKey = 'section_ref_for_' + id.replace(/[^a-z0-9.-]/gi, '_');
      const ref = (req.body[perLinkKey] || sharedSectionRef || null);
      evWrites.attachIsoControl(db, ev.id, id, ref);
    }
  });
  try { tx(); } catch (_) {}
  logAction(req.user.id, req.workspace.id, 'link_evidence_control', 'evidence', ev.id, { ids, count: ids.length }, auditCtx(req));
  redirectBack(req, res);
});

// Update the section_ref on an existing link (per-link, distinct from the
// per-file clause_section). Posted from the chip on the library row.
app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/section', requireAuth, requireWorkspace, requirePermission('evidence.upload'), (req, res) => {
  const ev = db.prepare(`SELECT id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const newRef = (req.body.section_ref || '').toString().trim() || null;
  evWrites.updateSection(db, ev.id, req.params.linkId, newRef);
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/evidence/:id/controls/:linkId/delete', requireAuth, requireWorkspace, requirePermission('evidence.delete'), (req, res) => {
  const ev = db.prepare(`SELECT id, iso_item_id FROM evidence WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!ev) return res.status(404).send('Not found');
  const removedIso = evWrites.unlinkIsoControl(db, ev.id, req.params.linkId);
  if (removedIso) {
    // If the deleted link was the primary, also clear evidence.iso_item_id
    // so the legacy column doesn't drift back into existence on next render.
    if (ev.iso_item_id === removedIso) {
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

app.post('/workspaces/:wsId/evidence/:id/delete', requireAuth, requireWorkspace, requirePermission('evidence.delete'), (req, res) => {
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
  fts.refresh(req.workspace.id, 'asset', id);
  logAction(req.user.id, req.workspace.id, 'create_asset', 'asset', id, { name }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/assets', 'Asset added'));
});

app.post('/workspaces/:wsId/assets/:id/delete', requireAuth, requireWorkspace, requirePermission('asset.delete'), (req, res) => {
  const before = db.prepare('SELECT name FROM assets WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  db.prepare('DELETE FROM assets WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'asset', entityId: req.params.id });
  if (before) logAction(req.user.id, req.workspace.id, 'delete_asset', 'asset', req.params.id, { name: before.name }, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/assets');
});

// ==================== ASSETS: CSV IMPORT ====================
// Three-step pipeline: GET shows the upload page, POST /preview parses +
// validates without writing, POST /commit revalidates and inserts in a single
// transaction so a partial failure leaves the register untouched.
app.get('/workspaces/:wsId/assets/import', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
  res.render('import', {
    user: req.user, ws: req.workspace,
    schema: csvImport.ASSET_SCHEMA, kind: 'assets',
    mode: 'upload', result: null, csv: '', filename: '',
    backUrl: `/workspaces/${req.workspace.id}/assets`,
    listUrl: `/workspaces/${req.workspace.id}/assets`,
    templateUrl: `/workspaces/${req.workspace.id}/assets/import/template`,
    previewUrl: `/workspaces/${req.workspace.id}/assets/import/preview`,
    commitUrl: `/workspaces/${req.workspace.id}/assets/import/commit`,
    importUrl: `/workspaces/${req.workspace.id}/assets/import`
  });
});

app.get('/workspaces/:wsId/assets/import/template', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="assets_template.csv"');
  res.send(csvImport.buildTemplate(csvImport.ASSET_SCHEMA));
});

app.post('/workspaces/:wsId/assets/import/preview', requireAuth, requireWorkspace, requirePermission('asset.create'), csvUpload.single('file'), (req, res) => {
  let csv = '';
  let filename = '';
  if (req.file && req.file.buffer) {
    csv = req.file.buffer.toString('utf8');
    filename = req.file.originalname || 'upload.csv';
  } else if (req.body.csv) {
    csv = String(req.body.csv);
    filename = 'pasted.csv';
  }
  const result = csvImport.processFile(csv, csvImport.ASSET_SCHEMA, {});
  res.render('import', {
    user: req.user, ws: req.workspace,
    schema: csvImport.ASSET_SCHEMA, kind: 'assets',
    mode: 'preview', result, csv, filename,
    backUrl: `/workspaces/${req.workspace.id}/assets`,
    listUrl: `/workspaces/${req.workspace.id}/assets`,
    templateUrl: `/workspaces/${req.workspace.id}/assets/import/template`,
    previewUrl: `/workspaces/${req.workspace.id}/assets/import/preview`,
    commitUrl: `/workspaces/${req.workspace.id}/assets/import/commit`,
    importUrl: `/workspaces/${req.workspace.id}/assets/import`
  });
});

app.post('/workspaces/:wsId/assets/import/commit', requireAuth, requireWorkspace, requirePermission('asset.create'), (req, res) => {
  const csv = String(req.body.csv || '');
  if (!csv.trim()) return res.redirect(`/workspaces/${req.workspace.id}/assets/import`);
  const result = csvImport.processFile(csv, csvImport.ASSET_SCHEMA, {});
  const valid = result.rows.filter(r => r.valid);
  if (!valid.length) {
    return res.redirect(withToast(`/workspaces/${req.workspace.id}/assets/import`, 'Nothing to import - all rows had errors', 'error'));
  }
  const ins = db.prepare(`INSERT INTO assets
    (workspace_id, entity_id, name, type, classification, owner_name, cia_c, cia_i, cia_a, description,
     business_criticality, rto_hours, rpo_hours, bia_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const importedAssetIds = [];
  const tx = db.transaction(() => {
    valid.forEach(r => {
      const p = r.parsed;
      const info = ins.run(
        req.workspace.id,
        req.entityScopeId || null,
        p.name,
        p.type || null,
        p.classification || null,
        p.owner_name || null,
        p.cia_c == null ? 2 : p.cia_c,
        p.cia_i == null ? 2 : p.cia_i,
        p.cia_a == null ? 2 : p.cia_a,
        p.description || null,
        p.business_criticality || null,
        p.rto_hours == null ? null : p.rto_hours,
        p.rpo_hours == null ? null : p.rpo_hours,
        p.bia_notes || null
      );
      importedAssetIds.push(info.lastInsertRowid);
    });
  });
  tx();
  importedAssetIds.forEach(id => fts.refresh(req.workspace.id, 'asset', id));
  logAction(req.user.id, req.workspace.id, 'import_assets_csv', 'asset', null, { count: valid.length, skipped: result.summary.invalid }, auditCtx(req));
  const msg = result.summary.invalid
    ? `Imported ${valid.length} asset${valid.length === 1 ? '' : 's'} - ${result.summary.invalid} row${result.summary.invalid === 1 ? '' : 's'} skipped`
    : `Imported ${valid.length} asset${valid.length === 1 ? '' : 's'}`;
  res.redirect(withToast(`/workspaces/${req.workspace.id}/assets`, msg));
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
  fts.refresh(req.workspace.id, 'risk', id);
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
  const insertedIds = [];
  const tx = db.transaction(() => {
    picked.forEach(idxStr => {
      const r = RISK_LIBRARY[parseInt(idxStr)];
      if (!r) return;
      const rid = ins.run(req.workspace.id, req.entityScopeId || null, r.title, r.description, r.threat || null, r.vulnerability || null).lastInsertRowid;
      (r.suggested_controls || []).forEach(c => linkCtrl.run(rid, c));
      insertedIds.push(rid);
      added++;
    });
  });
  tx();
  insertedIds.forEach(id => fts.refresh(req.workspace.id, 'risk', id));
  logAction(req.user.id, req.workspace.id, 'add_risks_from_library', 'risk', null, { count: added }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/risks', `Added ${added} risk${added === 1 ? '' : 's'} from library - review and adjust scoring`));
});

// ==================== RISKS: CSV IMPORT ====================
// Same upload → preview → commit pipeline as assets, with two extras:
//  - likelihood/impact validated against the active risk methodology scale
//  - the "asset" column resolves by name to an existing workspace asset; if
//    no match, the row stays valid but a warning is recorded ("will be created
//    without an asset link") so the importer doesn't silently swallow typos.
function riskImportContext(wsId) {
  const methodology = getActiveMethodology(wsId);
  const assets = db.prepare('SELECT id, name FROM assets WHERE workspace_id = ?').all(wsId);
  const assetsByName = new Map();
  assets.forEach(a => assetsByName.set(a.name.toLowerCase(), a));
  return { methodology, assetsByName };
}

app.get('/workspaces/:wsId/risks/import', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  res.render('import', {
    user: req.user, ws: req.workspace,
    schema: csvImport.RISK_SCHEMA, kind: 'risks',
    mode: 'upload', result: null, csv: '', filename: '',
    methodology: getActiveMethodology(req.workspace.id),
    backUrl: `/workspaces/${req.workspace.id}/risks`,
    listUrl: `/workspaces/${req.workspace.id}/risks`,
    templateUrl: `/workspaces/${req.workspace.id}/risks/import/template`,
    previewUrl: `/workspaces/${req.workspace.id}/risks/import/preview`,
    commitUrl: `/workspaces/${req.workspace.id}/risks/import/commit`,
    importUrl: `/workspaces/${req.workspace.id}/risks/import`
  });
});

app.get('/workspaces/:wsId/risks/import/template', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="risks_template.csv"');
  res.send(csvImport.buildTemplate(csvImport.RISK_SCHEMA));
});

app.post('/workspaces/:wsId/risks/import/preview', requireAuth, requireWorkspace, requirePermission('risk.create'), csvUpload.single('file'), (req, res) => {
  let csv = '';
  let filename = '';
  if (req.file && req.file.buffer) {
    csv = req.file.buffer.toString('utf8');
    filename = req.file.originalname || 'upload.csv';
  } else if (req.body.csv) {
    csv = String(req.body.csv);
    filename = 'pasted.csv';
  }
  const ctx = riskImportContext(req.workspace.id);
  const result = csvImport.processFile(csv, csvImport.RISK_SCHEMA, ctx);
  res.render('import', {
    user: req.user, ws: req.workspace,
    schema: csvImport.RISK_SCHEMA, kind: 'risks',
    mode: 'preview', result, csv, filename,
    methodology: ctx.methodology,
    backUrl: `/workspaces/${req.workspace.id}/risks`,
    listUrl: `/workspaces/${req.workspace.id}/risks`,
    templateUrl: `/workspaces/${req.workspace.id}/risks/import/template`,
    previewUrl: `/workspaces/${req.workspace.id}/risks/import/preview`,
    commitUrl: `/workspaces/${req.workspace.id}/risks/import/commit`,
    importUrl: `/workspaces/${req.workspace.id}/risks/import`
  });
});

app.post('/workspaces/:wsId/risks/import/commit', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const csv = String(req.body.csv || '');
  if (!csv.trim()) return res.redirect(`/workspaces/${req.workspace.id}/risks/import`);
  const ctx = riskImportContext(req.workspace.id);
  const result = csvImport.processFile(csv, csvImport.RISK_SCHEMA, ctx);
  const valid = result.rows.filter(r => r.valid);
  if (!valid.length) {
    return res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/import`, 'Nothing to import - all rows had errors', 'error'));
  }
  const lMid = Math.ceil(ctx.methodology.likelihood_scale.length / 2);
  const iMid = Math.ceil(ctx.methodology.impact_scale.length / 2);
  const ins = db.prepare(`INSERT INTO risks
    (workspace_id, entity_id, title, description, asset_id, threat, vulnerability,
     likelihood, impact, treatment, owner_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const importedIds = [];
  const tx = db.transaction(() => {
    valid.forEach(r => {
      const p = r.parsed;
      const info = ins.run(
        req.workspace.id,
        req.entityScopeId || null,
        p.title,
        p.description || null,
        p.asset || null,
        p.threat || null,
        p.vulnerability || null,
        p.likelihood == null ? lMid : p.likelihood,
        p.impact == null ? iMid : p.impact,
        p.treatment || 'modify',
        p.owner_name || null
      );
      importedIds.push(info.lastInsertRowid);
    });
  });
  tx();
  importedIds.forEach(id => fts.refresh(req.workspace.id, 'risk', id));
  logAction(req.user.id, req.workspace.id, 'import_risks_csv', 'risk', null, { count: valid.length, skipped: result.summary.invalid }, auditCtx(req));
  const msg = result.summary.invalid
    ? `Imported ${valid.length} risk${valid.length === 1 ? '' : 's'} - ${result.summary.invalid} row${result.summary.invalid === 1 ? '' : 's'} skipped`
    : `Imported ${valid.length} risk${valid.length === 1 ? '' : 's'}`;
  res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, msg));
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
  // Tier 1.1 - treatment plan actions for this risk
  const actions = db.prepare(`SELECT * FROM risk_treatment_actions
    WHERE risk_id=? AND workspace_id=?
    ORDER BY (CASE status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END), due_date IS NULL, due_date`).all(risk.id, req.workspace.id);
  // Tier A.2 - risk acceptance state
  const activeAcceptance = db.prepare(`SELECT * FROM risk_acceptances
    WHERE risk_id=? AND revoked_at IS NULL ORDER BY signed_at DESC LIMIT 1`).get(risk.id);
  res.render('risk_detail', { user: req.user, ws: req.workspace, risk, linked, allControls, assets, methodology, inherentBand, residualBand, actions, activeAcceptance });
});

// Tier 1.1 - Risk treatment plan actions (clause 6.1.3 audit-defensible workflow)
app.post('/workspaces/:wsId/risks/:id/actions', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
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

// ==================== TIER 1.3 - CERT CYCLE CALENDAR ====================
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
  // Auto-suggest a default cycle if no events exist yet - Stage 1 in 60 days,
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

app.post('/workspaces/:wsId/cert-cycle', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { event_type, planned_date, certification_body, notes } = req.body;
  if (!event_type || !CERT_EVENT_TYPES.find(t => t.key === event_type)) return redirectBack(req, res);
  db.prepare(`INSERT INTO cert_cycle_events (workspace_id, event_type, planned_date, certification_body, notes)
              VALUES (?, ?, ?, ?, ?)`).run(
    req.workspace.id, event_type, planned_date || null, certification_body || null, notes || null
  );
  logAction(req.user.id, req.workspace.id, 'add_cert_event', 'cert_cycle', null, { event_type, planned_date }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
});

app.post('/workspaces/:wsId/cert-cycle/seed', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
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

app.post('/workspaces/:wsId/cert-cycle/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
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

app.post('/workspaces/:wsId/cert-cycle/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM cert_cycle_events WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/cert-cycle`);
});

// ==================== TIER 2.7 - GAP ASSESSMENT REPORT (DOCX) ====================
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
      html += `<tr><td>${esc(refCode(g.id))}</td><td>${esc(cleanTitle)}</td><td><span class="tag" style="background:${sevColor(g.status)}">${esc(g.status)}</span></td><td>${g.maturity != null ? g.maturity : '-'}</td><td>${g.scope_pct != null ? g.scope_pct + '%' : '-'}</td><td>${esc(g.notes || '')}</td></tr>`;
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

app.post('/workspaces/:wsId/risks/:id', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
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
  fts.refresh(req.workspace.id, 'risk', req.params.id);
  logAction(req.user.id, req.workspace.id, 'update_risk', 'risk', req.params.id, null);
  res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
});

app.post('/workspaces/:wsId/risks/:id/link', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
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

app.post('/workspaces/:wsId/risks/:id/unlink', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
  db.prepare('DELETE FROM risk_controls WHERE risk_id = ? AND iso_item_id = ?')
    .run(req.params.id, req.body.iso_item_id);
  res.redirect('/workspaces/' + req.workspace.id + '/risks/' + req.params.id);
});

app.post('/workspaces/:wsId/risks/:id/delete', requireAuth, requireWorkspace, requirePermission('risk.delete'), (req, res) => {
  db.prepare('DELETE FROM risks WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'risk', entityId: req.params.id });
  res.redirect('/workspaces/' + req.workspace.id + '/risks');
});

// ==================== SOA ====================
app.get('/workspaces/:wsId/soa', requireAuth, requireWorkspace, (req, res) => {
  // Ensure every Annex A control has a control_states row so subsequent SoA
  // POSTs and bulk operations can UPDATE without silent no-ops. Idempotent.
  db.prepare(`INSERT OR IGNORE INTO control_states (workspace_id, iso_item_id)
              SELECT ?, id FROM iso_items WHERE type='control'`).run(req.workspace.id);

  // Cutover 3: control-state + doc-link reads come from legacy tables or the
  // converged compatibility views per the per-workspace control_reads_converged
  // flag (views de-normalize to byte-identical display values). Writes above stay legacy.
  const T = ctlReads.tables(db, req.workspace.id);
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
      LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control'
      ORDER BY i.sort_order`).all(req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id, req.workspace.id);

  // Phase A: linked documents per control (only docs in this workspace)
  const docLinks = db.prepare(`
    SELECT dc.iso_item_id, dc.section_ref, d.id AS doc_id, d.name AS doc_name, d.status AS doc_status, d.category
    FROM ${T.doc} dc
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

  // SoA metadata - version / owner / approver / approved-on, taken from the
  // latest snapshot. If no snapshot exists, the form lets the user kick one
  // off; saving via /soa/metadata captures one automatically.
  const latestSnap = db.prepare(`SELECT id, label, version, owner, approved_by, approved_at, created_at
    FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(req.workspace.id);

  // Counts to power the preview text on the bulk-decide buttons - lets
  // the consultant see "this will flip 47 rows" before confirming,
  // instead of a generic "are you sure?" dialog.
  const soaCounts = {
    included:  rows.filter(r => r.applicability === 'included').length,
    excluded:  rows.filter(r => r.applicability === 'excluded').length,
    undecided: rows.filter(r => !r.applicability || r.applicability === 'undecided').length,
    total:     rows.length
  };

  res.render('soa', {
    user: req.user, ws: req.workspace, rows, docsByControl, risksByControl,
    customControls, soaMeta: latestSnap || {}, soaCounts
  });
});

app.post('/workspaces/:wsId/soa/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res, nextMw) => {
  // Reserved literal sub-routes (snapshot, auto-justify, bulk, custom-controls, metadata)
  // must fall through to their own handlers.
  if (['snapshot','auto-justify','snapshots','bulk','custom-controls','metadata'].includes(req.params.isoId)) return nextMw();
  getOrCreateState(req.workspace.id, req.params.isoId);
  const { applicability, inclusion_justification, exclusion_justification, status } = req.body;
  db.prepare(`UPDATE control_states SET applicability=?, inclusion_justification=?, exclusion_justification=?,
              status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
              WHERE workspace_id=? AND iso_item_id=?`)
    .run(applicability || 'undecided',
         inclusion_justification || null, exclusion_justification || null,
         status || null, req.workspace.id, req.params.isoId);
  logAction(req.user.id, req.workspace.id, 'update_soa', 'control', req.params.isoId, null);
  // Autosave fetches use ?ajax=1 so they don't follow a redirect they don't need.
  if (req.query.ajax === '1') return res.status(204).end();
  res.redirect('/workspaces/' + req.workspace.id + '/soa');
});

// SoA batch save. Used by the "Save all changes" button on /soa to flush
// every dirty row in one round-trip instead of one POST per row. Body shape:
//   rows = JSON array of { iso_item_id, applicability, status,
//                          inclusion_justification, exclusion_justification }
// All updates run in a single transaction; the response is 200 with the count.
app.post('/workspaces/:wsId/soa/batch', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  let rows = [];
  try { rows = JSON.parse(req.body.rows || '[]'); } catch (_) { rows = []; }
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ ok: false, message: 'No rows to save.' });
  }
  // Guard against junk: cap batch size; reject rows missing iso_item_id.
  if (rows.length > 250) return res.status(400).json({ ok: false, message: 'Batch too large.' });
  const valid = rows.filter(r => r && typeof r.iso_item_id === 'string' && r.iso_item_id);
  const upsertState = db.prepare(`INSERT OR IGNORE INTO control_states (workspace_id, iso_item_id) VALUES (?, ?)`);
  const update = db.prepare(`UPDATE control_states SET
      applicability = ?, inclusion_justification = ?, exclusion_justification = ?,
      status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND iso_item_id = ?`);
  const tx = db.transaction(() => {
    valid.forEach(r => {
      upsertState.run(req.workspace.id, r.iso_item_id);
      update.run(
        r.applicability || 'undecided',
        r.inclusion_justification || null,
        r.exclusion_justification || null,
        r.status || null,
        req.workspace.id, r.iso_item_id
      );
    });
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'soa_batch_save', 'soa', null, { count: valid.length }, auditCtx(req));
  res.json({ ok: true, count: valid.length });
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

// ==================== CROSSWALKS ====================
// Full-matrix view of which ISO 27001 Annex A controls map to which external
// frameworks (SOC 2, NIST CSF 2.0, GDPR). The point of a multi-framework GRC
// tool: one piece of evidence credits controls across all frameworks the
// engagement runs. Grouped by Annex A theme. Filterable by framework, status,
// and search. Inclusion / status come from control_states for this workspace.
app.get('/workspaces/:wsId/crosswalks', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const frameworkFilter = (req.query.framework || 'all').toString();
  const statusFilter = (req.query.status || 'all').toString();
  const q = (req.query.q || '').toString().trim().toLowerCase();

  // Annex A controls only. Clauses don't carry crosswalks.
  const T = ctlReads.tables(db, req.workspace.id);
  const controls = db.prepare(
    `SELECT i.id, i.title, i.category, i.sort_order,
            COALESCE(cs.applicability, 'undecided') AS applicability,
            COALESCE(cs.status, 'Not Assessed')     AS status
     FROM iso_items i
     LEFT JOIN ${T.cs} cs
       ON cs.iso_item_id = i.id AND cs.workspace_id = ?
     WHERE i.type = 'control'
     ORDER BY i.sort_order ASC`
  ).all(req.workspace.id);

  const allMappings = db.prepare(
    `SELECT iso_item_id, framework, external_ref, notes FROM framework_mappings`
  ).all();
  const byControl = {};
  for (const m of allMappings) {
    if (!byControl[m.iso_item_id]) byControl[m.iso_item_id] = {};
    if (!byControl[m.iso_item_id][m.framework]) byControl[m.iso_item_id][m.framework] = [];
    byControl[m.iso_item_id][m.framework].push(m);
  }

  // Coverage counters - how many included controls in this workspace are mapped
  // to each framework. Drives the headline KPI tiles.
  const includedIds = new Set(controls.filter(c => c.applicability === 'included').map(c => c.id));
  const frameworks = ['soc2', 'nist_csf', 'gdpr'];
  const coverage = {};
  for (const fw of frameworks) {
    const mapped = new Set(allMappings.filter(m => m.framework === fw).map(m => m.iso_item_id));
    const includedMapped = [...includedIds].filter(id => mapped.has(id)).length;
    coverage[fw] = {
      total_mapped: mapped.size,
      included_mapped: includedMapped,
      total_included: includedIds.size
    };
  }

  // Apply filters to the displayed rows.
  let rows = controls.map(c => ({
    ...c,
    mappings: byControl[c.id] || {}
  }));
  if (frameworkFilter !== 'all') {
    rows = rows.filter(r => r.mappings[frameworkFilter]);
  }
  if (statusFilter === 'included') {
    rows = rows.filter(r => r.applicability === 'included');
  } else if (statusFilter === 'unmapped') {
    rows = rows.filter(r => Object.keys(r.mappings).length === 0);
  }
  if (q) {
    rows = rows.filter(r => {
      if (r.id.toLowerCase().includes(q)) return true;
      if ((r.title || '').toLowerCase().includes(q)) return true;
      for (const fw of Object.keys(r.mappings)) {
        for (const m of r.mappings[fw]) {
          if ((m.external_ref || '').toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
  }

  // Group rendered rows by Annex A theme. DB column iso_items.category uses
  // the short codes: org / people / physical / tech.
  const themes = [
    { key: 'org',      label: 'A.5 Organizational' },
    { key: 'people',   label: 'A.6 People'         },
    { key: 'physical', label: 'A.7 Physical'       },
    { key: 'tech',     label: 'A.8 Technological'  }
  ];
  const byTheme = {};
  for (const t of themes) byTheme[t.key] = [];
  for (const r of rows) {
    if (byTheme[r.category]) byTheme[r.category].push(r);
  }

  res.render('crosswalks', {
    user: req.user, ws: req.workspace,
    title: 'Crosswalks',
    active: 'crosswalks',
    themes, byTheme, coverage,
    frameworkFilter, statusFilter, q: req.query.q || '',
    totalControls: controls.length,
    rowCount: rows.length
  });
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

app.post('/workspaces/:wsId/tasks', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const { title, description, iso_item_id, assignee_id, due_date } = req.body;
  if (!title) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, assignee_id, due_date, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, title.trim(), description || null, iso_item_id || null,
         assignee_id || null, due_date || null, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_task', 'task', id, { title });
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/tasks', 'Task created'));
});

app.post('/workspaces/:wsId/tasks/:id', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/tasks/:id/delete', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/tasks');
});

// ==================== ACTIVITY / AUDIT LOG ====================
// The standalone /activity drill-down was merged into /activity-log (which has the
// same filters plus the Timeline / Anomalies / Verify tabs and is permission-gated).
// Redirect, preserving any query string.
app.get('/workspaces/:wsId/activity', requireAuth, requireWorkspace, (req, res) => {
  const i = req.originalUrl.indexOf('?');
  const qs = i >= 0 ? req.originalUrl.slice(i) : '';
  res.redirect('/workspaces/' + req.workspace.id + '/activity-log' + qs);
});

// ==================== EXPORTS ====================
app.get('/workspaces/:wsId/export/soa.csv', requireAuth, requireWorkspace, (req, res) => {
  const T = ctlReads.tables(db, req.workspace.id);
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
    COALESCE(cs.applicability,'undecided') AS applicability,
    COALESCE(cs.status,'Not Assessed') AS status,
    cs.inclusion_justification, cs.exclusion_justification,
    (SELECT GROUP_CONCAT('R-' || r.id, '; ') FROM risk_controls rc
     INNER JOIN risks r ON r.id = rc.risk_id
     WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS risks_treated
    FROM iso_items i
    LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
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
  // Optional tag filter - `?tag=annex-a.5.15` shows only docs linked to that
  // clause/control. Drives the auditor-side question "which documents cover
  // A.5.15?" without leaving the documents list.
  const tagFilter = req.query.tag || '';
  const T = ctlReads.tables(db, req.workspace.id);
  const docFilterClause = tagFilter
    ? `AND d.id IN (SELECT document_id FROM ${T.doc} WHERE iso_item_id = ?)`
    : '';
  const params = tagFilter ? [req.workspace.id, tagFilter] : [req.workspace.id];

  const docs = db.prepare(`SELECT d.*, u.name AS creator, t.name AS template_name,
    (SELECT COUNT(*) FROM ${T.doc} dc WHERE dc.document_id = d.id) AS tag_count,
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

  // Pull the tag chips for each doc - keep the per-doc list small (top 4 +
  // "and N more" overflow) so the table stays compact even on heavily-tagged
  // documents.
  const tagsByDoc = {};
  if (docs.length) {
    const placeholders = docs.map(() => '?').join(',');
    const tagRows = db.prepare(`SELECT dc.document_id, dc.iso_item_id, dc.section_ref, i.type
      FROM ${T.doc} dc INNER JOIN iso_items i ON i.id = dc.iso_item_id
      WHERE dc.document_id IN (${placeholders}) ORDER BY i.sort_order`).all(...docs.map(d => d.id));
    tagRows.forEach(r => { (tagsByDoc[r.document_id] = tagsByDoc[r.document_id] || []).push(r); });
  }

  // Distinct tagged iso_items in this workspace - for the filter dropdown.
  const taggedItems = db.prepare(`SELECT DISTINCT i.id, i.type, i.title
    FROM ${ctlReads.tables(db, req.workspace.id).doc} dc
    INNER JOIN generated_docs d ON d.id = dc.document_id
    INNER JOIN iso_items i ON i.id = dc.iso_item_id
    WHERE d.workspace_id = ? ORDER BY i.sort_order`).all(req.workspace.id);

  const templates = db.prepare(`SELECT * FROM doc_templates
    WHERE is_system = 1 OR firm_id = ? ORDER BY category, name`).all(req.workspace.firm_id);

  // Registers row used to surface "interested parties register" here;
  // removed alongside the dedicated parties module. Left as an empty
  // array so the view's <% registers.forEach %> stays harmless.
  const registers = [];

  res.render('documents', {
    user: req.user, ws: req.workspace, docs, templates,
    tagsByDoc, taggedItems, tagFilter, registers
  });
});

// ==================== TEMPLATE LIBRARY (Phase 6 gallery) ====================
// Premium discoverable surface for the 74 system policy templates. The legacy
// dropdown on /documents stays for power users; this gallery is the path that
// makes the library feel like a paid product. Each card shows adoption state
// (already in this workspace?) and the Annex A controls the template auto-
// links on adopt.

const TIER_RANK = { mandatory: 0, expected: 1, recommended: 2 };

app.get('/workspaces/:wsId/templates', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const templates = db.prepare(`SELECT id, name, category, description, tier, controls, clauses
    FROM doc_templates
    WHERE is_system=1 OR firm_id=?
    ORDER BY name`).all(req.workspace.firm_id);

  const adoptedRows = db.prepare(`SELECT template_id, MIN(id) AS doc_id, COUNT(*) AS n
    FROM generated_docs WHERE workspace_id=? AND template_id IS NOT NULL
    GROUP BY template_id`).all(req.workspace.id);
  const adoptedByTpl = {};
  adoptedRows.forEach(r => { adoptedByTpl[r.template_id] = r; });

  // Parse refs and decorate. Sort: mandatory first, then alpha within tier.
  const enriched = templates.map(t => {
    let controls = []; try { controls = JSON.parse(t.controls || '[]'); } catch (_) {}
    let clauses  = []; try { clauses  = JSON.parse(t.clauses  || '[]'); } catch (_) {}
    return { ...t, controls, clauses, adopted: adoptedByTpl[t.id] || null };
  }).sort((a, b) => {
    const ta = TIER_RANK[a.tier || 'recommended'];
    const tb = TIER_RANK[b.tier || 'recommended'];
    return ta - tb || a.name.localeCompare(b.name);
  });

  const counts = {
    total: enriched.length,
    mandatory: enriched.filter(t => t.tier === 'mandatory').length,
    expected:  enriched.filter(t => t.tier === 'expected').length,
    recommended: enriched.filter(t => t.tier === 'recommended').length,
    adopted: enriched.filter(t => t.adopted).length,
    mandatoryAdopted: enriched.filter(t => t.tier === 'mandatory' && t.adopted).length
  };

  res.render('templates_library', {
    user: req.user, ws: req.workspace,
    templates: enriched, counts
  });
});

app.get('/workspaces/:wsId/templates/:id(\\d+)', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const tpl = db.prepare(`SELECT * FROM doc_templates WHERE id=? AND (is_system=1 OR firm_id=?)`)
    .get(req.params.id, req.workspace.firm_id);
  if (!tpl) return res.status(404).render('error', { user: req.user, message: 'Template not found.' });
  let controls = []; try { controls = JSON.parse(tpl.controls || '[]'); } catch (_) {}
  let clauses  = []; try { clauses  = JSON.parse(tpl.clauses  || '[]'); } catch (_) {}
  const isoLookup = {};
  if (controls.length || clauses.length) {
    const refs = [...controls, ...clauses];
    const placeholders = refs.map(() => '?').join(',');
    db.prepare(`SELECT id, title FROM iso_items WHERE id IN (${placeholders})`)
      .all(...refs).forEach(r => { isoLookup[r.id] = r.title; });
  }
  const existing = db.prepare(`SELECT id FROM generated_docs
    WHERE workspace_id=? AND template_id=? ORDER BY id DESC LIMIT 1`)
    .get(req.workspace.id, tpl.id);

  // Render the template body with workspace context substituted, then pass the
  // HTML to the view. EJS templates can't require() the markdown renderer, so
  // we do the markdown → HTML pass here and ship the result through.
  const sample = (tpl.content || '')
    .replace(/{{client_name}}/g, req.workspace.client_name)
    .replace(/{{scope}}/g, req.workspace.scope || (req.workspace.client_name + ' information assets'))
    .replace(/{{date}}/g, new Date().toISOString().slice(0,10))
    .replace(/{{firm_name}}/g, '[Firm name]')
    .replace(/{{document_owner}}/g, 'CISO')
    .replace(/{{approval_authority}}/g, 'Top Management')
    .replace(/{{review_period}}/g, 'Annual')
    .replace(/{{industry}}/g, req.workspace.industry || '');
  const previewHtml = mdRenderer.render(sample);

  res.render('template_detail', {
    user: req.user, ws: req.workspace,
    tpl, controls, clauses, isoLookup, existing, previewHtml
  });
});

app.post('/workspaces/:wsId/templates/adopt-mandatory', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  // Bulk-adopt every mandatory template that isn't already in this workspace.
  // Stops short of expected/recommended so the consultant isn't drowned in
  // 74 documents to review.
  const adopted = db.prepare(`SELECT template_id FROM generated_docs
    WHERE workspace_id=? AND template_id IS NOT NULL`).all(req.workspace.id);
  const adoptedSet = new Set(adopted.map(r => r.template_id));
  const toAdopt = db.prepare(`SELECT * FROM doc_templates
    WHERE is_system=1 AND tier='mandatory' ORDER BY name`).all()
    .filter(t => !adoptedSet.has(t.id));
  let totalDocs = 0, totalLinks = 0;
  const tx = db.transaction(() => {
    toAdopt.forEach(t => {
      const r = adoptTemplateForWorkspace(t, req.workspace, req.user, req.entityScopeId, req.body);
      totalDocs++;
      totalLinks += r.linkedControls;
    });
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'bulk_adopt_mandatory', 'document', null,
    { adopted: totalDocs, linked_controls: totalLinks }, auditCtx(req));
  const msg = totalDocs === 0
    ? 'All mandatory templates already adopted in this workspace.'
    : `Adopted ${totalDocs} mandatory template${totalDocs === 1 ? '' : 's'} · auto-linked ${totalLinks} control${totalLinks === 1 ? '' : 's'}`;
  res.redirect(withToast(`/workspaces/${req.workspace.id}/templates`, msg));
});

app.post('/workspaces/:wsId/templates/:id(\\d+)/adopt', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const tpl = db.prepare(`SELECT * FROM doc_templates WHERE id=? AND (is_system=1 OR firm_id=?)`)
    .get(req.params.id, req.workspace.firm_id);
  if (!tpl) return res.status(404).render('error', { user: req.user, message: 'Template not found.' });
  const r = adoptTemplateForWorkspace(tpl, req.workspace, req.user, req.entityScopeId, req.body);
  const linkSuffix = r.linkedControls > 0 ? ` · auto-linked ${r.linkedControls} control${r.linkedControls === 1 ? '' : 's'}` : '';
  res.redirect(withToast(`/workspaces/${req.workspace.id}/documents/${r.docId}`, `${tpl.name} adopted${linkSuffix}`));
});

app.post('/workspaces/:wsId/documents/from-template', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const { template_id, document_owner, approval_authority, review_period } = req.body;
  const tpl = db.prepare('SELECT * FROM doc_templates WHERE id = ? AND (is_system=1 OR firm_id=?)').get(template_id, req.workspace.firm_id);
  if (!tpl) return redirectBack(req, res);
  const result = adoptTemplateForWorkspace(tpl, req.workspace, req.user, req.entityScopeId, {
    document_owner, approval_authority, review_period
  });
  const linkedSuffix = result.linkedControls > 0
    ? ` · auto-linked ${result.linkedControls} control${result.linkedControls === 1 ? '' : 's'}`
    : '';
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + result.docId, 'Document generated' + linkedSuffix));
});

// Shared adoption helper - used by the single from-template POST and by the
// bulk-adopt-mandatory wizard. Inserts the document, snapshots v1, and links
// every control referenced in the template's description (from the controls
// JSON column populated at seed time).
function adoptTemplateForWorkspace(tpl, workspace, user, entityScopeId, overrides) {
  const today = new Date().toISOString().split('T')[0];
  const firm = db.prepare('SELECT name FROM firms WHERE id = ?').get(workspace.firm_id);
  const vars = {
    client_name: workspace.client_name,
    scope: workspace.scope || `${workspace.client_name} information assets`,
    date: today,
    firm_name: firm?.name || '',
    document_owner: (overrides && overrides.document_owner) || 'CISO',
    approval_authority: (overrides && overrides.approval_authority) || 'Top Management',
    review_period: (overrides && overrides.review_period) || 'Annual',
    industry: workspace.industry || ''
  };
  const content = substitutePlaceholders(tpl.content, vars);
  const encContent = enc.encryptIfNeeded(content, workspace.id, !!workspace.encryption_enabled);
  const docId = db.prepare(`INSERT INTO generated_docs (workspace_id, entity_id, template_id, name, category, content, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(workspace.id, entityScopeId || null, tpl.id, tpl.name, tpl.category, encContent, user.id).lastInsertRowid;
  fts.refresh(workspace.id, 'document', docId);
  snapshotDocVersion(docId, workspace.id, 'draft', user.id, 'Initial draft from template: ' + tpl.name);

  // Auto-link every Annex A control referenced by the template (extracted at
  // seed time from the description). UNION with the clauses column too - main
  // clauses live in the same document_controls table via iso_item_id.
  let linkedControls = 0;
  const linkRefs = [];
  try { (JSON.parse(tpl.controls || '[]')).forEach(c => linkRefs.push(c)); } catch (_) {}
  try { (JSON.parse(tpl.clauses || '[]')).forEach(c => linkRefs.push(c)); } catch (_) {}
  if (linkRefs.length) {
    const exists = db.prepare(`SELECT 1 FROM iso_items WHERE id = ?`);
    const linkIns = db.prepare(`INSERT OR IGNORE INTO document_controls (document_id, iso_item_id) VALUES (?, ?)`);
    linkRefs.forEach(ref => {
      if (exists.get(ref)) {
        const r = linkIns.run(docId, ref);
        if (r.changes) linkedControls++;
      }
    });
  }
  logAction(user.id, workspace.id, 'create_document', 'document', docId,
    { from_template: tpl.name, auto_linked: linkedControls }, { ip: '', userAgent: '' });
  return { docId, linkedControls };
}

app.post('/workspaces/:wsId/documents/blank', requireAuth, requireWorkspace, requirePermission('document.create'), (req, res) => {
  const { name, category } = req.body;
  if (!name) return redirectBack(req, res);
  const initial = '# ' + name + '\n\n';
  const id = db.prepare(`INSERT INTO generated_docs (workspace_id, entity_id, name, category, content, created_by)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, req.entityScopeId || null, name, category || 'policy',
         enc.encryptIfNeeded(initial, req.workspace.id, !!req.workspace.encryption_enabled),
         req.user.id).lastInsertRowid;
  fts.refresh(req.workspace.id, 'document', id);
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
    return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents', 'Unsupported file type - use .docx, .pdf, .md, or .txt'));
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
        conversionNote = `<p><em>Conversion notes: ${result.messages.length} formatting hints from import - review and edit as needed.</em></p>`;
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
      conversionNote = `<p><em>Imported from PDF - formatting (tables, headings, lists) may need to be re-applied. The original PDF is attached as the approved source.</em></p>`;
    } else {
      // .md / .markdown / .txt - run through markdown-it (treats plain text reasonably)
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
  fts.refresh(req.workspace.id, 'document', id);

  snapshotDocVersion(id, req.workspace.id, 'draft', req.user.id, `Imported from ${req.file.originalname}`);
  logAction(req.user.id, req.workspace.id, 'upload_document', 'document', id, { filename: req.file.originalname, size: req.file.size, sha256: sha }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + id, 'Document imported - review and edit'));
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

  // Approval / signature context. approvers is the merged chain
  // (internal + external) ordered by sequence; each row has `kind`.
  const versions = listVersions(doc.id);
  const currentVersion = doc.current_version_id ? db.prepare('SELECT * FROM doc_versions WHERE id=?').get(doc.current_version_id) : null;
  const approvers = currentVersion ? docApprovals.listChain(db, currentVersion.id) : [];
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
  // multi-pick form). The section_ref applies to the bulk batch when used -
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

// Bidirectional document tagging - mirror routes from the control side. The
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
    fts.refresh(req.workspace.id, 'document', req.params.id);
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

app.post('/workspaces/:wsId/documents/:id/delete', requireAuth, requireWorkspace, requirePermission('document.delete'), (req, res) => {
  db.prepare('DELETE FROM generated_docs WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'document', entityId: req.params.id });
  res.redirect('/workspaces/' + req.workspace.id + '/documents');
});

// Snooze a document's review date by N days. Used by the overdue/due-soon
// banner on /documents and the per-row action on /policy-adoption. Records
// who snoozed and why in audit log.
app.post('/workspaces/:wsId/documents/:id/snooze-review', requireAuth, requireWorkspace, requirePermission('document.edit'), (req, res) => {
  const days = parseInt(req.body.days, 10) || 30;
  if (![14, 30, 60, 90, 180].includes(days)) return res.status(400).send('Bad snooze period');
  const doc = db.prepare(`SELECT id, next_review_date FROM generated_docs WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!doc) return res.status(404).send('Not found');
  // Push the review date forward from today (not from the existing date, which
  // may already be in the past). A snooze should mean "give me N days from
  // now to actually do the review."
  const newDate = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  db.prepare(`UPDATE generated_docs SET next_review_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`)
    .run(newDate, doc.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'snooze_doc_review', 'document', doc.id,
    { old_date: doc.next_review_date, new_date: newDate, days, reason: req.body.reason || null }, auditCtx(req));
  const back = req.headers.referer || `/workspaces/${req.workspace.id}/documents`;
  res.redirect(back);
});

// ==================== INTERNAL AUDITS ====================
app.get('/workspaces/:wsId/audits', requireAuth, requireWorkspace, (req, res) => {
  const audits = db.prepare(`SELECT a.*,
    (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id) AS finding_count,
    (SELECT COUNT(*) FROM audit_findings WHERE audit_id = a.id AND status = 'open') AS open_findings
    FROM audits a WHERE a.workspace_id = ? ORDER BY a.audit_date DESC, a.created_at DESC`).all(req.workspace.id);
  res.render('audits', { user: req.user, ws: req.workspace, audits });
});

app.post('/workspaces/:wsId/audits', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
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
  // Tier C.9 - per-control samples taken during the audit
  const samples = db.prepare(`SELECT s.*, i.title AS iso_title FROM audit_samples s
    LEFT JOIN iso_items i ON i.id=s.iso_item_id
    WHERE s.audit_id=? ORDER BY s.sample_taken_at IS NULL, s.sample_taken_at DESC`).all(audit.id);
  const observations = db.prepare(`SELECT o.*, i.title AS iso_title FROM audit_observations o
    LEFT JOIN iso_items i ON i.id = o.iso_item_id
    WHERE o.audit_id=? ORDER BY o.status='closed', o.created_at`).all(audit.id);
  res.render('audit_detail', { user: req.user, ws: req.workspace, audit, findings, allItems, samples, observations });
});

app.post('/workspaces/:wsId/audits/:id', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const { title, scope, audit_date, auditor_name, status, summary } = req.body;
  db.prepare(`UPDATE audits SET title=?, scope=?, audit_date=?, auditor_name=?, status=?, summary=?
              WHERE id=? AND workspace_id=?`)
    .run(title, scope || null, audit_date || null, auditor_name || null,
         status || 'planned', summary || null, req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
});

// ==================== TIER C.10 - CONTINUAL IMPROVEMENT REGISTER ====================
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

app.post('/workspaces/:wsId/improvements', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/improvements/:id', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/improvements/:id/delete', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
  db.prepare(`DELETE FROM improvements WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/improvements`);
});

// (Asset relationships graph removed in IA cleanup - daily-use rare. The
// underlying asset_relationships table is still populated from the asset
// detail page; if blast-radius visualisation is needed again, restore from
// git history at sha 5c9ee08. See views/assets.ejs for the table view that
// answers every real question.)

// Tier C.9 - Per-audit sampling justification + per-control sample log.
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
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Audit not found');
  const { iso_item_id, description, sample_taken_at, population_size, sample_size, finding } = req.body;
  if (!description) return redirectBack(req, res);
  db.prepare(`INSERT INTO audit_samples
    (audit_id, iso_item_id, description, sample_taken_at, population_size, sample_size, finding)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    audit.id, iso_item_id || null, description.trim(),
    sample_taken_at || null,
    population_size ? parseInt(population_size, 10) : null,
    sample_size ? parseInt(sample_size, 10) : null,
    finding || null
  );
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

app.post('/workspaces/:wsId/audits/:id/samples/:sid/delete', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Audit not found');
  db.prepare(`DELETE FROM audit_samples WHERE id=? AND audit_id=?`).run(req.params.sid, audit.id);
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

// Tier 1.4 - Audit lifecycle stage transitions (planned → fieldwork →
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

app.post('/workspaces/:wsId/audits/:id/findings', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Audit not found');
  const { iso_item_id, finding_type, description, severity } = req.body;
  if (!description) return redirectBack(req, res);
  db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, description, severity)
              VALUES (?, ?, ?, ?, ?)`)
    .run(audit.id, iso_item_id || null, finding_type || 'observation',
         description, severity || 'medium');
  res.redirect('/workspaces/' + req.workspace.id + '/audits/' + req.params.id);
});

app.post('/workspaces/:wsId/audits/:id/findings/:fId/promote', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Audit not found');
  const f = db.prepare('SELECT * FROM audit_findings WHERE id = ? AND audit_id = ?')
    .get(req.params.fId, audit.id);
  if (!f) return redirectBack(req, res);
  if (f.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + f.nonconformity_id);
  const sev = f.finding_type === 'major_nc' ? 'major' : 'minor';
  const ncId = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity, iso_item_id)
                           VALUES (?, ?, 'internal_audit', ?, ?, ?, ?)`)
    .run(req.workspace.id, f.description.substring(0, 100),
         'Audit #' + req.params.id, f.description, sev, f.iso_item_id).lastInsertRowid;
  db.prepare('UPDATE audit_findings SET nonconformity_id = ? WHERE id = ?').run(ncId, f.id);
  fts.refresh(req.workspace.id, 'nc', ncId);
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
});

app.post('/workspaces/:wsId/audits/:id/delete', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  db.prepare('DELETE FROM audits WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/audits');
});

// ==================== MANAGEMENT REVIEW ====================
app.get('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, (req, res) => {
  const mrms = db.prepare(`SELECT * FROM mrms WHERE workspace_id = ?
                           ORDER BY meeting_date DESC, created_at DESC`).all(req.workspace.id);
  // Preview the 9.3.2 input pack so the consultant sees what will be auto-
  // filled before submitting the create form. The same compute is then re-run
  // server-side on POST — no risk of staleness.
  const pack932Preview = compute932InputPack(req.workspace.id);
  res.render('mrms', { user: req.user, ws: req.workspace, mrms, pack932Preview });
});

// Helper - compute the auto-fillable 9.3.2 input fields from current data.
// Used both by MRM creation (Tier 2.5) and by the on-demand refresh action
// (Tier A.4) so the saved values can be brought back in line with reality.
function compute932InputPack(wsId) {
  const today = new Date().toISOString().slice(0,10);

  // ---- existing 9.3.2 a / c / e numbers ----
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

  // ---- 9.3.2.b context changes ----
  // Objective signal for context changes: new suppliers since last MRM.
  // (Previously also counted new / overdue interested parties; removed
  // alongside the dedicated parties module.)
  const sinceClause = lastMrm ? '?' : "date('now','-12 months')";
  const lastMrmParams = lastMrm ? [wsId, lastMrm.meeting_date] : [wsId];
  let newSuppliers = 0;
  try {
    newSuppliers = db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND date(created_at) > ${sinceClause}`).get(...lastMrmParams).c;
  } catch (_) {}

  // Incident summary feeds both context (regulatory exposure) and performance.
  let incidents = { total: 0, open: 0, last12m: 0 };
  try {
    const row = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN created_at > datetime('now','-12 months') THEN 1 ELSE 0 END) AS last12m
      FROM incidents WHERE workspace_id=?`).get(wsId);
    if (row) incidents = { total: row.total || 0, open: row.open || 0, last12m: row.last12m || 0 };
  } catch (_) {}

  // ---- 9.3.2.f opportunities for improvement ----
  const improvementsOpen = db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=? AND status IN ('open','in_progress')`).get(wsId).c;
  const improvementsDone = db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=? AND status='done'`).get(wsId).c;
  const recentImprovements = db.prepare(`SELECT title, source FROM improvements WHERE workspace_id=? AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 5`).all(wsId);

  // ---- supplier review status (feeds performance) ----
  let supplierReview = { total: 0, overdue: 0 };
  try {
    const row = db.prepare(`SELECT
      COUNT(DISTINCT s.id) AS total,
      SUM(CASE WHEN s.next_review_date IS NULL OR s.next_review_date < date('now') THEN 1 ELSE 0 END) AS overdue
      FROM suppliers s WHERE s.workspace_id=?`).get(wsId);
    if (row) supplierReview = { total: row.total || 0, overdue: row.overdue || 0 };
  } catch (_) {}

  // ---- 9.3.2.e: risk register diff since last MRM ----
  let risksAddedSinceLast = 0, risksClosedSinceLast = 0;
  if (lastMrm) {
    risksAddedSinceLast = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND date(created_at) > ?`).get(wsId, lastMrm.meeting_date).c;
    risksClosedSinceLast = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status IN ('closed','treated')`).get(wsId).c;
  }

  return {
    // 9.3.2.a — prior MRM actions
    prior_actions_status: lastMrm
      ? `Last MRM (${lastMrm.meeting_date}) actions:\n${lastMrm.action_items || '(none recorded)'}\n\n[Review status of each above before this meeting.]`
      : 'No prior management review on record. This is the first one.',

    // 9.3.2.b — context changes
    context_changes: lastMrm
      ? `Changes since last MRM (${lastMrm.meeting_date}):\n  New suppliers onboarded: ${newSuppliers}\n\n[Add narrative on regulatory updates, organisational changes, technology shifts, threat-landscape evolution, and changes in the needs / expectations of interested parties identified during gap assessment.]`
      : `Baseline context (no prior MRM):\n  Suppliers on file: ${supplierReview.total}\n\n[Document the external + internal context relevant to the ISMS — regulations, market, technology, organisation. Note the interested parties identified during gap assessment (clause 4.2).]`,

    // 9.3.2.c — performance review (extended with incidents + suppliers)
    performance_review: `Internal audit programme (last 12 months):\n  Audits run: ${auditsLast12}\n  Findings raised: ${findingsLast12}\n\nNonconformity status:\n  Open: ${ncOpen} (Major: ${ncMajor}, Overdue: ${ncOverdue})\n\nRisk treatment plan:\n  Open actions: ${treatmentOpen}\n  Closed actions: ${treatmentDone}\n\nIncidents (last 12 months):\n  Total: ${incidents.last12m} (${incidents.open} still open)\n\nSupplier reviews:\n  ${supplierReview.total} suppliers · ${supplierReview.overdue} overdue review${supplierReview.overdue === 1 ? '' : 's'}\n\n[Add commentary on KPIs, monitoring metrics (9.1), trends, root-cause patterns.]`,

    // 9.3.2.d — interested-party feedback. Parties are now captured
    // during the gap assessment + clause 4.2 work rather than a
    // dedicated register, so the auto-pack just hands the consultant
    // a structured prompt to fill in.
    feedback_interested_parties: `[Summarise feedback received in the period from interested parties identified in clause 4.2 - customer concerns / contractual security asks, regulator queries, employee survey results, supplier feedback, board observations. Quantify where possible (NPS, audit findings against customer SoWs, complaint volumes).]`,

    // 9.3.2.e — risk-treatment status (existing + register diff)
    risk_treatment_status: `Risk register snapshot (today):\n  Total open risks: ${openRisks}\n  High-residual (L×I ≥ 16): ${highRisks}${lastMrm ? `\n\nSince last MRM (${lastMrm.meeting_date}):\n  Risks added: ${risksAddedSinceLast}\n  Risks closed/treated: ${risksClosedSinceLast}` : ''}\n\n[Add narrative on top risks, treatment progress, residual-risk acceptance.]`,

    // 9.3.2.f — improvement opportunities
    improvement_opportunities: improvementsOpen === 0 && improvementsDone === 0
      ? 'No improvement actions recorded yet. Capture observations from audits, MRMs, incidents, and monitoring under Improvements (Clause 10.1).'
      : `Improvement log:\n  Active: ${improvementsOpen}\n  Completed: ${improvementsDone}${recentImprovements.length ? '\n\nActive items:\n' + recentImprovements.map(i => `  - ${i.title}${i.source ? ' [' + i.source + ']' : ''}`).join('\n') : ''}\n\n[Identify themes from this period's data: recurring NCs, gaps surfaced by audits, technology refresh, training needs, control automation candidates.]`,

    refreshedAt: new Date().toISOString()
  };
}

app.post('/workspaces/:wsId/mrms', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
  const { meeting_date, attendees } = req.body;
  const pack = compute932InputPack(req.workspace.id);
  const id = db.prepare(`INSERT INTO mrms
    (workspace_id, meeting_date, attendees,
     prior_actions_status, context_changes, performance_review, feedback_interested_parties,
     risk_treatment_status, improvement_opportunities,
     created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, meeting_date || null, attendees || null,
         pack.prior_actions_status, pack.context_changes, pack.performance_review,
         pack.feedback_interested_parties, pack.risk_treatment_status, pack.improvement_opportunities,
         req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_mrm', 'mrm', id, null);
  res.redirect('/workspaces/' + req.workspace.id + '/mrms/' + id);
});

// Tier A.4 - Refresh the auto-fillable inputs against current workspace data.
// Useful when a saved MRM has gone stale (e.g., NCs closed since the meeting
// was scheduled, new audit findings recorded). Re-saves the three auto-pack
// fields from a fresh compute.
app.post('/workspaces/:wsId/mrms/:id/refresh-inputs', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
  const mrm = db.prepare('SELECT id, status FROM mrms WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!mrm) return res.status(404).send('Not found');
  const pack = compute932InputPack(req.workspace.id);
  db.prepare(`UPDATE mrms SET
      prior_actions_status=?, context_changes=?, performance_review=?,
      feedback_interested_parties=?, risk_treatment_status=?, improvement_opportunities=?
    WHERE id=? AND workspace_id=?`)
    .run(pack.prior_actions_status, pack.context_changes, pack.performance_review,
         pack.feedback_interested_parties, pack.risk_treatment_status, pack.improvement_opportunities,
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

  // Phase D - extended 9.3.2 inputs
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

app.post('/workspaces/:wsId/mrms/:id', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/mrms/:id/delete', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/nonconformities', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
  const { title, source, description, severity, iso_item_id } = req.body;
  if (!title) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, description, severity, iso_item_id)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, title, source || 'other', description || null,
         severity || 'minor', iso_item_id || null).lastInsertRowid;
  fts.refresh(req.workspace.id, 'nc', id);
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

app.post('/workspaces/:wsId/nonconformities/:id', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
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
    fts.refresh(req.workspace.id, 'nc', req.params.id);
    logAction(req.user.id, req.workspace.id, 'update_nc', 'nonconformity', req.params.id, null);

    // Phase C: closing an NC bumps the linked control's last_verified_at - feeds SoA freshness view
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
app.post('/workspaces/:wsId/nonconformities/:id/spawn-task', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/nonconformities/:id/delete', requireAuth, requireWorkspace, requirePermission('nc.manage'), (req, res) => {
  db.prepare('DELETE FROM nonconformities WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspace.id);
  fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'nc', entityId: req.params.id });
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities');
});

// ==================== BULK CONTROL UPDATE ====================
app.post('/workspaces/:wsId/bulk-controls', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
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
app.post('/workspaces/:wsId/controls/:isoId/autosave', requireAuth, requireWorkspace, requirePermission('control.update'), express.json(), (req, res) => {
  getOrCreateState(req.workspace.id, req.params.isoId);
  const allowed = ['status','applicability','inclusion_justification','exclusion_justification',
                   'maturity','notes','owner_id','due_date'];
  if (isFirmUser(req.user)) allowed.push('internal_notes');
  const sets = []; const vals = [];
  Object.keys(req.body).forEach(k => {
    if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(req.body[k] || null); }
  });
  if (!sets.length) return res.json({ ok: true, saved_at: new Date().toISOString() });

  // Optimistic-concurrency: if the client passes the last_updated value it
  // last received, we refuse the write when the row has moved on (another
  // consultant's autosave or explicit save changed it). The client should
  // re-read the page state and either merge or re-fetch. Clients that don't
  // pass last_updated (legacy callers, e.g. older kanban) fall through to
  // the old last-writer-wins path so this change doesn't break them.
  const clientStamp = req.body.last_updated || null;
  sets.push('last_updated=CURRENT_TIMESTAMP');
  vals.push(req.workspace.id, req.params.isoId);
  let sql = `UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`;
  if (clientStamp) { sql += ` AND last_updated = ?`; vals.push(clientStamp); }
  const result = db.prepare(sql).run(...vals);
  if (clientStamp && result.changes === 0) {
    const current = db.prepare(`SELECT last_updated FROM control_states WHERE workspace_id=? AND iso_item_id=?`)
      .get(req.workspace.id, req.params.isoId);
    return res.status(409).json({
      ok: false, conflict: true,
      message: 'Another consultant updated this control. Reload to see their changes.',
      current_last_updated: current ? current.last_updated : null
    });
  }
  const cur = db.prepare(`SELECT last_updated FROM control_states WHERE workspace_id=? AND iso_item_id=?`)
    .get(req.workspace.id, req.params.isoId);
  res.json({ ok: true, saved_at: new Date().toISOString(), last_updated: cur ? cur.last_updated : null });
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
// Detection is heuristic - confirms presence of an artefact in this tool; verify completeness manually.
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
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, ws.id).cs} WHERE workspace_id=? AND applicability IN ('included','excluded')`).get(ws.id).c >= 93 },
  { key: 'risk_treatment_plan', tier: 'mandatory', clause: '6.1.3 e) / 8.3', name: 'Risk treatment plan',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND treatment IS NOT NULL`).get(ws.id).c > 0 },
  { key: 'objectives', tier: 'mandatory', clause: '6.2', name: 'Information security objectives',
    detect: (ws, db) => {
      const cs = db.prepare(`SELECT notes FROM ${ctlReads.tables(db, ws.id).cs} WHERE workspace_id=? AND iso_item_id='clause-6.2'`).get(ws.id);
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
      const cs = db.prepare(`SELECT notes FROM ${ctlReads.tables(db, ws.id).cs} WHERE workspace_id=? AND iso_item_id='annex-a.5.31'`).get(ws.id);
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

// Implementation roadmap - PDCA-aligned, mapped to ISO 27001:2022 clauses.
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
  const Tns = ctlReads.tables(db, ws.id);
  const soaDecided = db.prepare(`SELECT COUNT(*) c FROM ${Tns.cs} cs
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
  const rolesApproved = docSignal(['ISMS Role -%', 'ISMS Steering%', 'Roles and Responsibilities%', 'RACI%']);
  const objectivesApproved = docSignal(['Information Security Objectives%']);
  const awarenessApproved = docSignal(['Awareness and Training%', 'Awareness%', 'Communication Plan%']);
  const monitoringApproved = docSignal(['Logging and Monitoring%', 'Monitoring%', 'Measurement%', 'KPI%']);

  const methodologyActive = db.prepare(`SELECT COUNT(*) c FROM risk_methodologies
    WHERE workspace_id=? AND is_active=1`).get(ws.id).c;
  const includedControls = db.prepare(`SELECT COUNT(*) c FROM ${Tns.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'`).get(ws.id).c;
  const implementedControls = db.prepare(`SELECT COUNT(*) c FROM ${Tns.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.status='Implemented'`).get(ws.id).c;

  return [
    { phase: 'plan', key: 'scope', label: 'Define ISMS scope', clause: 'Clause 4.3',
      done: !!(ws.scope && ws.scope.length > 10),
      detail: ws.scope ? 'Scope statement set' : 'Set the scope on workspace settings or in an ISMS Scope document',
      link: `/workspaces/${ws.id}#workspace-settings`, link_label: 'Edit scope' },
    { phase: 'plan', key: 'context', label: 'Document context - internal/external issues + interested parties', clause: 'Clauses 4.1 & 4.2',
      done: contextApproved >= 1,
      detail: contextApproved >= 1
        ? 'Context register / ISMS Governance Manual approved'
        : 'Document internal & external issues and interested-party requirements (incl. climate-related per Amendment 1:2024)',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'isp', label: 'Approve Information Security Policy', clause: 'Clause 5.2',
      done: ispApproved >= 1,
      detail: ispApproved >= 1 ? 'ISP approved' : 'Approved ISP is the foundation document - generate from template and approve',
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
      detail: `${assetCount} asset${assetCount === 1 ? '' : 's'} registered${assetCount > 0 && assetCount < 5 ? ' - most ISMS scopes need at least 5–10' : ''}`,
      link: `/workspaces/${ws.id}/assets`, link_label: 'Assets' },
    { phase: 'plan', key: 'gap', label: 'Gap-assess clauses & Annex A', clause: 'Project activity (covers 4–10, A.5–A.8)',
      done: allAssessed === allTotal && allTotal > 0, partial: allAssessed > 0 && allAssessed < allTotal,
      detail: `${clausesAssessed} / ${clausesTotal} clauses · ${annexAssessed} / ${annexTotal} controls assessed`,
      link: `/workspaces/${ws.id}/gap-assessment`, link_label: 'Run gap assessment' },
    { phase: 'plan', key: 'risks', label: 'Identify, score, and treat risks', clause: 'Clauses 6.1.2 & 6.1.3',
      done: riskCount >= 5, partial: riskCount > 0 && riskCount < 5,
      detail: `${riskCount} risk${riskCount === 1 ? '' : 's'} in register${riskCount === 0 ? ' - start from the library if unsure' : ''}`,
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
        : 'Determine what to monitor, methods, frequency, who analyses - KPIs aligned with objectives (6.2)',
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
      detail: ncOpen === 0 ? 'No open NCs' : `${ncOpen} open NC${ncOpen === 1 ? '' : 's'} - RCA + corrective action + effectiveness review per NC`,
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

  // Validation flags - actionable issues, not tutorials
  const flags = [];
  const T = ctlReads.tables(db, ws.id);

  const implNoEvidence = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.status='Implemented'
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.workspace_id=? AND e.iso_item_id=cs.iso_item_id)
    ORDER BY i.sort_order
  `).all(ws.id, ws.id);
  if (implNoEvidence.length) flags.push({ kind: 'implemented_no_evidence', severity: 'high',
    label: `${implNoEvidence.length} controls marked Implemented without evidence`,
    items: implNoEvidence.slice(0, 10) });

  const implNoOwner = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.status IN ('Implemented','Partially Implemented') AND cs.owner_id IS NULL
    ORDER BY i.sort_order
  `).all(ws.id);
  if (implNoOwner.length) flags.push({ kind: 'no_owner', severity: 'medium',
    label: `${implNoOwner.length} active controls without an owner`,
    items: implNoOwner.slice(0, 10) });

  const includedNoRisk = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.applicability='included' AND i.type='control'
    AND NOT EXISTS (SELECT 1 FROM risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?)
    AND (cs.inclusion_justification IS NULL OR length(cs.inclusion_justification) < 10)
    ORDER BY i.sort_order
  `).all(ws.id, ws.id);
  if (includedNoRisk.length) flags.push({ kind: 'included_no_basis', severity: 'high',
    label: `${includedNoRisk.length} SoA-included controls have no driving risk and no justification`,
    items: includedNoRisk.slice(0, 10) });

  const excludedNoJust = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.applicability='excluded' AND i.type='control'
    AND (cs.exclusion_justification IS NULL OR length(cs.exclusion_justification) < 10)
    ORDER BY i.sort_order
  `).all(ws.id);
  if (excludedNoJust.length) flags.push({ kind: 'excluded_no_basis', severity: 'high',
    label: `${excludedNoJust.length} SoA-excluded controls without justification`,
    items: excludedNoJust.slice(0, 10) });

  const undecidedSoA = db.prepare(`
    SELECT COUNT(*) c FROM iso_items i
    LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
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
    items: expiredSupplierDocs.map(d => ({ id: d.id, title: `${d.title} - ${d.doc}` })).slice(0, 10) });

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
    SELECT i.id, i.title, cs.last_updated FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.iso_item_id IN ('annex-a.5.15','annex-a.5.18','annex-a.8.2')
    AND cs.status='Implemented' AND cs.last_updated < datetime('now','-180 days')
    ORDER BY i.sort_order
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
    FROM ${T.cs} WHERE workspace_id=?`).get(ws.id) || {};

  const totalItems = db.prepare(`SELECT COUNT(*) c FROM iso_items`).get().c;
  const assessed = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} WHERE workspace_id=? AND status != 'Not Assessed'`).get(ws.id).c;

  // =====================================================================
  // TWO-LAYER READINESS MODEL (per the ISO 27001:2022 readiness rubric,
  // anchored in ISO/IEC 17021-1 + 27006-1:2024)
  //
  // Layer 1 - Hard gate (boolean). Any single FAIL = Not Ready, no matter
  //           how high the maturity score is (mirrors 17021-1 §9.5.2).
  // Layer 2 - Maturity % (0-5 averaged across applicable Annex A controls).
  //           Forecasting only; informs but never overrides Layer 1.
  //           Stage 1 floor 60%; Stage 2 floor 75% with no control at 0/1.
  // =====================================================================
  const wsId = ws.id;
  const evidenceCount = db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`).get(wsId).c;

  const docApproved = (likeClauses) => {
    const where = likeClauses.map(() => `lower(name) LIKE ?`).join(' OR ');
    return !!db.prepare(`SELECT 1 FROM generated_docs WHERE workspace_id=? AND (${where}) AND status IN ('approved','published') LIMIT 1`).get(wsId, ...likeClauses);
  };
  const itemHasSubstance = (isoId) => {
    const cs = db.prepare(`SELECT notes, maturity FROM ${T.cs} WHERE workspace_id=? AND iso_item_id=?`).get(wsId, isoId);
    return !!(cs && ((cs.notes && cs.notes.trim().length > 30) || (cs.maturity && cs.maturity >= 2)));
  };
  const annexADecided = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability IN ('included','excluded')`).get(wsId).c;
  const soaJustGaps = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control'
      AND ((cs.applicability='included' AND (cs.inclusion_justification IS NULL OR length(trim(cs.inclusion_justification)) < 10))
        OR (cs.applicability='excluded' AND (cs.exclusion_justification IS NULL OR length(trim(cs.exclusion_justification)) < 10)))`).get(wsId).c;
  const interestedPartiesCount = db.prepare(`SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=?`).get(wsId).c;
  const objectivesOk = db.prepare(`SELECT COUNT(*) c FROM security_objectives WHERE workspace_id=?
    AND target_value IS NOT NULL AND length(trim(target_value)) > 0
    AND owner IS NOT NULL AND length(trim(owner)) > 0`).get(wsId).c >= 3;
  const trainingComplete = db.prepare(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=? AND status='complete'`).get(wsId).c;
  const commPlanCount = db.prepare(`SELECT COUNT(*) c FROM communication_plan WHERE workspace_id=?`).get(wsId).c;
  const docRegisterCount = db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published')`).get(wsId).c;
  const internalAuditClosed = db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND status IN ('complete','closed')`).get(wsId).c > 0;
  const mrmFull = db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?
    AND status IN ('complete','closed')
    AND prior_actions_status IS NOT NULL AND length(trim(prior_actions_status)) > 0
    AND context_changes IS NOT NULL AND length(trim(context_changes)) > 0
    AND performance_review IS NOT NULL AND length(trim(performance_review)) > 0
    AND feedback_interested_parties IS NOT NULL AND length(trim(feedback_interested_parties)) > 0
    AND risk_treatment_status IS NOT NULL AND length(trim(risk_treatment_status)) > 0
    AND improvement_opportunities IS NOT NULL AND length(trim(improvement_opportunities)) > 0`).get(wsId).c > 0;
  const mandRecordsAllFound = mandatoryChecks.every(c => c.found);
  const ismsPolicyDoc = docApproved(['%information security policy%']);
  const policyApprovedRecent = (() => {
    const d = db.prepare(`SELECT MAX(v.created_at) AS approved_at FROM doc_versions v
      INNER JOIN generated_docs g ON g.id=v.document_id
      WHERE g.workspace_id=? AND lower(g.name) LIKE '%information security policy%' AND v.status='approved'`).get(wsId);
    if (!d || !d.approved_at) return false;
    return (Date.now() - new Date(d.approved_at).getTime()) <= 365 * 86400000;
  })();
  const risksCount = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(wsId).c;
  const rtpPresent = docApproved(['%risk treatment plan%']) || db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=?`).get(wsId).c > 0;

  // ----- Layer 1: Stage 1 hard gate (17 items, rubric §2.2) -----
  const s1 = (key, clause, name, pass, detail, action, href) => ({ key, clause, name, pass, detail, action, href });
  const stage1Gate = [
    s1('context', '4.1', 'Context analysis documented',
      itemHasSubstance('clause-4.1'),
      itemHasSubstance('clause-4.1') ? 'Context issues recorded against clause 4.1' : 'No documented internal/external context analysis',
      'Document internal + external issues (clause 4.1)', '/workspaces/' + wsId + '/controls/assess/clause-4.1'),
    s1('interested_parties', '4.2', 'Interested parties + requirements documented',
      interestedPartiesCount >= 3 || itemHasSubstance('clause-4.2'),
      (interestedPartiesCount >= 3 ? interestedPartiesCount + ' interested parties in the register' : 'Interested-parties register thin or empty'),
      'Build the interested-parties register incl. 2022 sub-point (c)', '/workspaces/' + wsId + '/intake'),
    s1('scope', '4.3', 'ISMS scope documented + approved',
      !!(ws.scope && ws.scope.length > 10 && ws.scope_confirmed_at),
      ws.scope_confirmed_at ? ('Scope confirmed ' + String(ws.scope_confirmed_at).slice(0,10)) : (ws.scope && ws.scope.length > 10 ? 'Scope drafted, not confirmed' : 'No scope defined'),
      'Define scope + confirm boundaries', '/workspaces/' + wsId + '/intake'),
    s1('policy', '5.2', 'Information security policy approved (≤12 mo)',
      ismsPolicyDoc && policyApprovedRecent,
      ismsPolicyDoc ? (policyApprovedRecent ? 'Approved policy within 12 months' : 'Policy approved but older than 12 months') : 'No approved information security policy',
      'Adopt + approve the ISMS policy', '/workspaces/' + wsId + '/templates'),
    s1('roles', '5.3', 'Roles, responsibilities + authorities documented',
      itemHasSubstance('clause-5.3') || docApproved(['%roles%','%responsibilit%']),
      (itemHasSubstance('clause-5.3') || docApproved(['%roles%','%responsibilit%'])) ? 'Roles documented' : 'No documented ISMS roles + responsibilities',
      'Document ISMS roles + responsibilities (clause 5.3)', '/workspaces/' + wsId + '/controls/assess/clause-5.3'),
    s1('risk_method', '6.1.2', 'Risk assessment process documented',
      docApproved(['%risk%methodology%','%risk%procedure%','%risk management%']),
      docApproved(['%risk%methodology%','%risk%procedure%','%risk management%']) ? 'Approved risk methodology found' : 'No approved risk methodology',
      'Adopt the Risk Management Methodology template', '/workspaces/' + wsId + '/templates'),
    s1('risk_assessment', '8.2', 'Risk assessment completed; results retained',
      risksCount >= 10,
      risksCount + ' risks in the register',
      'Complete the first risk assessment (10+ risks)', '/workspaces/' + wsId + '/risks'),
    s1('rtp', '6.1.3 e) / 8.3', 'Risk treatment plan; owners + deadlines',
      rtpPresent,
      rtpPresent ? 'RTP present' : 'No risk treatment plan',
      'Adopt the Risk Treatment Plan + assign owners/deadlines', '/workspaces/' + wsId + '/templates'),
    s1('soa', '6.1.3 d)', 'SoA: all 93 controls + justifications',
      annexADecided >= 93 && soaJustGaps === 0,
      annexADecided >= 93 ? (soaJustGaps === 0 ? 'All 93 decided + justified' : annexADecided + '/93 decided but ' + soaJustGaps + ' missing justification') : annexADecided + '/93 controls decided',
      'Complete + justify every Annex A control', '/workspaces/' + wsId + '/soa'),
    s1('objectives', '6.2', 'Measurable security objectives + evaluation',
      objectivesOk,
      objectivesOk ? '3+ measurable objectives with owners' : 'Fewer than 3 objectives with target + owner',
      'Add 3+ measurable objectives with owners', '/workspaces/' + wsId + '/objectives'),
    s1('planning_changes', '6.3', 'Planning of ISMS changes (method documented)',
      itemHasSubstance('clause-6.3') || docApproved(['%change management%','%management of change%']),
      (itemHasSubstance('clause-6.3') || docApproved(['%change management%','%management of change%'])) ? 'ISMS-change method documented' : 'No documented method for ISMS-level changes',
      'Document an ISMS-change method (clause 6.3, distinct from A.8.32)', '/workspaces/' + wsId + '/controls/assess/clause-6.3'),
    s1('awareness', '7.3', 'Awareness programme documented',
      trainingComplete > 0 || docApproved(['%awareness%']),
      (trainingComplete > 0 || docApproved(['%awareness%'])) ? 'Awareness programme / records present' : 'No awareness programme or completed records',
      'Document the awareness programme + record completion', '/workspaces/' + wsId + '/training'),
    s1('communication', '7.4', 'Communication plan (matrix, internal + external)',
      commPlanCount >= 2,
      commPlanCount >= 2 ? commPlanCount + ' communication-plan entries' : 'No communication matrix',
      'Build the communication matrix (what/when/whom/how)', '/workspaces/' + wsId + '/communication-plan'),
    s1('doc_control', '7.5', 'Documented information control in place',
      docRegisterCount >= 3,
      docRegisterCount >= 3 ? docRegisterCount + ' version-controlled approved documents' : 'Document register thin (version control unproven)',
      'Adopt + version-control the mandatory documents', '/workspaces/' + wsId + '/documents'),
    s1('internal_audit', '9.2', 'Internal audit completed (full ISMS scope)',
      internalAuditClosed,
      internalAuditClosed ? 'At least one internal audit closed' : 'No completed internal audit',
      'Run + close one internal audit covering clauses 4-10', '/workspaces/' + wsId + '/audits'),
    s1('mgmt_review', '9.3', 'Management review (all 9.3.2 inputs + outputs)',
      mrmFull,
      mrmFull ? 'MRM closed with all six 9.3.2 inputs' : 'No MRM closed with all required inputs',
      'Hold one MRM with all 9.3.2 inputs documented', '/workspaces/' + wsId + '/mrms'),
    s1('mandatory_docs', '4–10', 'All mandatory documented information present',
      mandRecordsAllFound,
      mandRecordsAllFound ? 'All mandatory clause 4-10 records detected' : (mandTotal - mandFound) + ' of ' + mandTotal + ' mandatory records missing',
      'Produce the remaining mandatory clause 4-10 records', '/workspaces/' + wsId + '/readiness')
  ];

  // ----- Layer 2: maturity % across applicable Annex A controls -----
  const maturityRows = db.prepare(`SELECT cs.maturity FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'`).all(wsId);
  const applicableControls = maturityRows.length;
  const maturitySum = maturityRows.reduce((s, r) => s + (r.maturity || 0), 0);
  const maturityPct = applicableControls > 0 ? Math.round((maturitySum / (applicableControls * 5)) * 100) : 0;
  const controlsAtZeroOrOne = maturityRows.filter(r => (r.maturity || 0) <= 1).length;

  // ----- Stage 1 verdict -----
  const stage1GatePassed = stage1Gate.filter(g => g.pass).length;
  const stage1GateTotal = stage1Gate.length;
  const stage1GateClear = stage1GatePassed === stage1GateTotal;
  const stage1MaturityOk = maturityPct >= 60;
  const stage1Ready = stage1GateClear && stage1MaturityOk;
  const stage1 = maturityPct;
  const stage1Blocked = !stage1Ready;

  // ----- Layer 1: Stage 2 hard gate (9 items, rubric §3.2) -----
  const controlsWithOwnerAndEvidence = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.owner_id IS NOT NULL
      AND (SELECT COUNT(*) FROM evidence e WHERE e.workspace_id=cs.workspace_id AND e.iso_item_id=cs.iso_item_id) >= 2`).get(wsId).c;
  const oldestEvRow = db.prepare(`SELECT MIN(uploaded_at) AS d FROM evidence WHERE workspace_id=?`).get(wsId);
  const evidenceAgeDays = oldestEvRow && oldestEvRow.d ? Math.floor((Date.now() - new Date(oldestEvRow.d).getTime()) / 86400000) : 0;
  const auditFindingsTracked = db.prepare(`SELECT COUNT(*) c FROM audit_findings f
    INNER JOIN audits a ON a.id=f.audit_id
    WHERE a.workspace_id=? AND f.status NOT IN ('closed') AND f.finding_type IN ('major_nc','minor_nc')`).get(wsId).c === 0;
  const mrmRecent = db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status IN ('complete','closed')
    AND meeting_date >= date('now','-365 days')`).get(wsId).c > 0;
  const ncRcaOk = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?
    AND status NOT IN ('closed','verified')
    AND (root_cause IS NULL OR length(trim(root_cause)) < 10)`).get(wsId).c === 0;
  const overdueNCs2 = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?
    AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < date('now')`).get(wsId).c;
  const legalRegisterOk = itemHasSubstance('annex-a.5.31') || docApproved(['%legal%','%regulatory%','%compliance register%']);
  const bcpTestOk = itemHasSubstance('annex-a.5.30') || !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id IN ('annex-a.5.30','annex-a.5.29') LIMIT 1`).get(wsId);
  const irExerciseOk = itemHasSubstance('annex-a.5.24') || db.prepare(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=?`).get(wsId).c > 0;
  const monitoringOk = itemHasSubstance('clause-9.1') || !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id='clause-9.1' LIMIT 1`).get(wsId);

  const s2 = (key, clause, name, pass, detail, href) => ({ key, clause, name, pass, detail, href });
  const stage2Gate = [
    s2('operating', 'IAF MD 5', 'ISMS operating with normal-cycle records',
      evidenceAgeDays >= 90,
      oldestEvRow && oldestEvRow.d ? ('Oldest evidence ' + evidenceAgeDays + ' days old') : 'No evidence files',
      '/workspaces/' + wsId + '/evidence'),
    s2('control_evidence', 'SoA', 'Every applicable control: owner + ≥2 evidence samples',
      applicableControls > 0 && controlsWithOwnerAndEvidence >= applicableControls,
      controlsWithOwnerAndEvidence + ' of ' + applicableControls + ' applicable controls have owner + 2 evidence samples',
      '/workspaces/' + wsId + '/evidence-coverage'),
    s2('monitoring', '9.1', 'Monitoring / measurement outputs exist',
      monitoringOk,
      monitoringOk ? 'Monitoring outputs recorded' : 'No monitoring/measurement outputs',
      '/workspaces/' + wsId + '/metrics/adopted'),
    s2('audit_closed', '9.2', 'Internal-audit cycle complete; findings closed/tracked',
      internalAuditClosed && auditFindingsTracked,
      (internalAuditClosed ? (auditFindingsTracked ? 'Audit closed; NC findings closed' : 'Audit closed but NC findings still open') : 'No closed internal audit'),
      '/workspaces/' + wsId + '/audits'),
    s2('mrm_recent', '9.3', 'Management review within last 12 months',
      mrmRecent,
      mrmRecent ? 'MRM held in last 12 months' : 'No MRM in last 12 months',
      '/workspaces/' + wsId + '/mrms'),
    s2('nc_rca', '10.2', 'Corrective actions: root cause + effectiveness',
      ncRcaOk,
      ncRcaOk ? 'Open NCs carry root-cause analysis' : 'Open NCs missing root-cause analysis',
      '/workspaces/' + wsId + '/nonconformities'),
    s2('stage1_closed', '17021-1', 'Stage 1 findings / overdue NCs closed',
      overdueNCs2 === 0,
      overdueNCs2 === 0 ? 'No overdue nonconformities' : overdueNCs2 + ' overdue NCs',
      '/workspaces/' + wsId + '/nonconformities'),
    s2('legal_register', 'A.5.31', 'Legal / regulatory / contractual register current',
      legalRegisterOk,
      legalRegisterOk ? 'Legal register present' : 'No legal/regulatory register',
      '/workspaces/' + wsId + '/controls/assess/annex-a.5.31'),
    s2('tests', 'A.5.30 / A.5.24', 'BCP test + incident-response exercise performed',
      bcpTestOk && irExerciseOk,
      (bcpTestOk && irExerciseOk) ? 'BCP + IR tests recorded' : ((bcpTestOk ? '' : 'BCP test missing. ') + (irExerciseOk ? '' : 'IR exercise missing.')),
      '/workspaces/' + wsId + '/controls/assess/annex-a.5.30')
  ];

  const stage2GatePassed = stage2Gate.filter(g => g.pass).length;
  const stage2GateTotal = stage2Gate.length;
  const stage2GateClear = stage2GatePassed === stage2GateTotal;
  const stage2MaturityOk = maturityPct >= 75 && controlsAtZeroOrOne === 0;
  const stage2Ready = stage1Ready && stage2GateClear && stage2MaturityOk;
  const stage2 = maturityPct;
  const stage2Blocked = !stage2Ready;

  // Per-section breakdown so the readiness Stage panels can render the
  // same gap-assessment / implementation summary the workspace overview
  // shows. Requirements = clauses 4-10; org/people/physical/tech = the
  // four Annex A themes.
  const themeStateRows = db.prepare(`SELECT i.id, i.type, i.category, COALESCE(cs.status,'Not Assessed') AS status
                                     FROM iso_items i
                                     LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?`).all(ws.id);
  const themes = {
    requirements: { label: 'Requirements', total: 0, assessed: 0, implemented: 0 },
    org:          { label: 'A.5 Org',      total: 0, assessed: 0, implemented: 0 },
    people:       { label: 'A.6 People',   total: 0, assessed: 0, implemented: 0 },
    physical:     { label: 'A.7 Physical', total: 0, assessed: 0, implemented: 0 },
    tech:         { label: 'A.8 Tech',     total: 0, assessed: 0, implemented: 0 }
  };
  const statusCounts = { impl: 0, partial: 0, wip: 0, notImpl: 0, na: 0, notAss: 0 };
  themeStateRows.forEach(row => {
    let key = null;
    if (row.type === 'clause') key = 'requirements';
    else if (themes[row.category]) key = row.category;
    if (!key) return;
    themes[key].total++;
    if (row.status !== 'Not Assessed') themes[key].assessed++;
    if (row.status === 'Implemented') themes[key].implemented++;
    if (row.status === 'Implemented') statusCounts.impl++;
    else if (row.status === 'Partially Implemented') statusCounts.partial++;
    else if (row.status === 'Work In Progress') statusCounts.wip++;
    else if (row.status === 'Not Implemented') statusCounts.notImpl++;
    else if (row.status === 'Not Applicable') statusCounts.na++;
    else if (row.status === 'Not Assessed') statusCounts.notAss++;
  });
  const totalSoaItems = themeStateRows.length;
  const totalAssessed = totalSoaItems - statusCounts.notAss;

  // Days remaining to the workspace's target cert date (null if unset).
  let daysToTarget = null;
  if (ws.target_cert_date) {
    daysToTarget = Math.ceil((new Date(ws.target_cert_date) - new Date()) / 86400000);
  }

  return {
    stage1, stage2,
    daysToTarget,
    records: { found: recordsFound, total: recordsTotal, checks,
               mandatory: { found: mandFound, total: mandTotal, checks: mandatoryChecks },
               expected:  { found: expFound,  total: expTotal,  checks: expectedChecks } },
    flags,
    stage1Gate, stage1GatePassed, stage1GateTotal, stage1GateClear,
    stage1MaturityOk, stage1Ready, stage1Blocked,
    stage2Gate, stage2GatePassed, stage2GateTotal, stage2GateClear,
    stage2MaturityOk, stage2Ready, stage2Blocked,
    maturityPct, applicableControls, controlsAtZeroOrOne,
    themes,
    statusCounts,
    totalSoaItems,
    totalAssessed,
    metrics: {
      assessed, totalItems,
      implemented: totals.implemented || 0,
      partial: totals.partial || 0,
      wip: totals.wip || 0,
      notImpl: totals.not_impl || 0,
      na: totals.na || 0,
      avgMaturity: totals.avg_maturity ? Number(totals.avg_maturity).toFixed(1) : '-',
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

// Audit-readiness blockers - concrete things the auditor will catch if you ignore them.
// Distinct from /readiness which is a high-level percentage view.
app.get('/workspaces/:wsId/readiness/blockers', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const blockers = [];
  const T = ctlReads.tables(db, wsId);

  // 1. Controls marked Implemented but no evidence files attached
  const implNoEvidence = db.prepare(`
    SELECT i.id, i.title FROM iso_items i
    INNER JOIN ${T.cs} cs ON cs.iso_item_id = i.id
    WHERE i.type='control' AND cs.workspace_id=? AND cs.status='Implemented'
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
    ORDER BY i.sort_order`).all(wsId, wsId);
  if (implNoEvidence.length) {
    blockers.push({
      severity: 'high',
      title: `${implNoEvidence.length} control${implNoEvidence.length === 1 ? '' : 's'} marked "Implemented" but no evidence attached`,
      detail: 'Auditors will ask for evidence before accepting any "Implemented" claim. Either attach evidence or downgrade the status.',
      items: implNoEvidence.slice(0, 20).map(c => ({ label: c.id.replace('annex-','').toUpperCase() + ' - ' + c.title.replace(/^A\.[0-9.]+ /, ''), link: `/workspaces/${wsId}/controls/${c.id}` }))
    });
  }

  // 2. SoA controls without inclusion or exclusion justification
  const soaUnjustified = db.prepare(`
    SELECT i.id, i.title, COALESCE(cs.applicability,'undecided') AS applicability FROM iso_items i
    LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id=?
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
      items: soaUnjustified.slice(0, 20).map(c => ({ label: c.id.replace('annex-','').toUpperCase() + ' - ' + c.title.replace(/^A\.[0-9.]+ /, '') + ' (' + c.applicability + ')', link: `/workspaces/${wsId}/soa` }))
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
    FROM iso_items i LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')`).get(wsId);
  const notAssessed = (notAssessedRow.clauses || 0) + (notAssessedRow.controls || 0);
  if (notAssessed > 0) {
    blockers.push({
      severity: 'high',
      title: `${notAssessed} item${notAssessed === 1 ? '' : 's'} still "Not Assessed" (${notAssessedRow.clauses || 0} clause${(notAssessedRow.clauses||0) === 1 ? '' : 's'} · ${notAssessedRow.controls || 0} control${(notAssessedRow.controls||0) === 1 ? '' : 's'})`,
      detail: 'Every main-body clause AND every Annex A control needs a status - even Not Applicable. Clauses 4–10 are the "shall" requirements; Annex A entries also need an applicability decision. Run the gap assessment wizard to clear this in one pass.',
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
      // ISO items (clauses + controls) - search across all
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
        ['Deliverables', '/deliverables', 'deliverable export report docx zip pack'],
        ['Report templates', '/reports', 'report template markdown'],
        ['Team & access', '/team', 'team members users access permissions rbac'],
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

  // Workspace-agnostic resources - searchable from anywhere.
  if ('glossary'.includes(q) || 'terms'.includes(q) || 'dictionary'.includes(q) || 'definitions'.includes(q)) {
    results.push({ type: 'Reference', label: 'Glossary', sublabel: 'ISO 27001 & GRC terms', href: '/glossary' });
  }
  // Direct hits on individual glossary entries - searches term, aliases, plain.
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
    || (doc.status === 'draft' ? 'DRAFT - NOT FOR DISTRIBUTION'
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

// ==================== AUDIT PACK · ZIP ARCHIVE ====================
// Companion to the polished PDF audit pack (see further below). This route
// returns a raw ZIP of CSVs + DOCX + evidence files - exactly what an internal
// auditor wants to grep through, but not what you hand a certification body
// or the client. The config page at /audit-pack links to both deliverables.
app.get('/workspaces/:wsId/audit-pack/zip', requireAuth, requireWorkspace, async (req, res) => {
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
    LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
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
          let sigTxt = `SIGNATURES - ${d.name}\n${'='.repeat(40)}\n\nVersion: ${v.version}\nContent SHA-256: ${v.content_hash}\n\n`;
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

app.post('/workspaces/:wsId/incidents', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const { title, category, severity, detected_at, reported_by, description } = req.body;
  if (!title) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO incidents (workspace_id, title, category, severity, detected_at, reported_by, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.workspace.id, title, category || 'other', severity || 'medium',
    detected_at || null, reported_by || null, description || null).lastInsertRowid;
  fts.refresh(req.workspace.id, 'incident', id);
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

app.post('/workspaces/:wsId/incidents/:id', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const f = ['title','category','severity','detected_at','reported_by','status','description','affected_assets',
            'containment_actions','eradication_actions','recovery_actions','lessons_learned','external_notification'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.status === 'closed') set.push('closed_at=CURRENT_TIMESTAMP');
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE incidents SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    fts.refresh(req.workspace.id, 'incident', req.params.id);
    logAction(req.user.id, req.workspace.id, 'update_incident', 'incident', req.params.id, null);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/incidents/' + req.params.id);
});

app.post('/workspaces/:wsId/incidents/:id/promote-nc', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  const inc = db.prepare(`SELECT * FROM incidents WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!inc) return redirectBack(req, res);
  if (inc.nonconformity_id) return res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + inc.nonconformity_id);
  const sev = inc.severity === 'critical' || inc.severity === 'high' ? 'major' : 'minor';
  const ncId = db.prepare(`INSERT INTO nonconformities (workspace_id, title, source, source_ref, description, severity)
    VALUES (?, ?, 'incident', ?, ?, ?)`).run(req.workspace.id, inc.title, 'Incident #' + inc.id, inc.description, sev).lastInsertRowid;
  db.prepare(`UPDATE incidents SET nonconformity_id=? WHERE id=? AND workspace_id=?`).run(ncId, inc.id, req.workspace.id);
  fts.refresh(req.workspace.id, 'nc', ncId);
  res.redirect('/workspaces/' + req.workspace.id + '/nonconformities/' + ncId);
});

app.post('/workspaces/:wsId/incidents/:id/delete', requireAuth, requireWorkspace, requirePermission('incident.manage'), (req, res) => {
  db.prepare(`DELETE FROM incidents WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'incident', entityId: req.params.id });
  res.redirect('/workspaces/' + req.workspace.id + '/incidents');
});

// ==================== BUSINESS CONTINUITY / BIA (A.5.29, A.5.30) ====================

app.get('/workspaces/:wsId/bcp', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const processes = db.prepare(`SELECT * FROM bcp_processes WHERE workspace_id=? ORDER BY
    CASE criticality WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, name`).all(wsId);
  const plans = db.prepare(`SELECT p.*,
    (SELECT COUNT(*) FROM bcp_plan_processes pp WHERE pp.plan_id=p.id) AS linked_count,
    (SELECT MAX(t.test_date) FROM bcp_tests t WHERE t.plan_id=p.id) AS last_tested,
    (SELECT COUNT(*) FROM bcp_tests t WHERE t.plan_id=p.id AND t.pass=1) AS tests_pass,
    (SELECT COUNT(*) FROM bcp_tests t WHERE t.plan_id=p.id AND (t.pass=0 OR t.pass IS NULL)) AS tests_fail
    FROM bcp_plans p WHERE p.workspace_id=? ORDER BY p.name`).all(wsId);
  // Summary stats
  const totalProcesses = processes.length;
  const criticalProcesses = processes.filter(p => p.criticality === 'critical').length;
  // Critical processes with no linked plan
  const linkedProcessIds = new Set(db.prepare(`SELECT DISTINCT process_id FROM bcp_plan_processes pp
    JOIN bcp_plans pl ON pl.id=pp.plan_id WHERE pl.workspace_id=?`).all(wsId).map(r => r.process_id));
  const criticalUnlinked = processes.filter(p => p.criticality === 'critical' && !linkedProcessIds.has(p.id));
  const today = new Date().toISOString().split('T')[0];
  const overdueReview = plans.filter(p => p.next_review_date && p.next_review_date < today).length;
  const lastTestRow = db.prepare(`SELECT MAX(test_date) AS d FROM bcp_tests WHERE workspace_id=?`).get(wsId);
  const lastTestDate = lastTestRow ? lastTestRow.d : null;
  const summary = { totalProcesses, criticalProcesses, criticalUnlinked: criticalUnlinked.length, overdueReview, lastTestDate };
  res.render('bcp', { user: req.user, ws: req.workspace, processes, plans, summary, criticalUnlinked, today });
});

// BCP Processes CRUD
app.post('/workspaces/:wsId/bcp/processes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { name, description, owner_name, criticality, max_tolerable_downtime_hours, rto_hours, rpo_hours, dependencies, peak_periods, status } = req.body;
  if (!name) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO bcp_processes (workspace_id, name, description, owner_name, criticality,
    max_tolerable_downtime_hours, rto_hours, rpo_hours, dependencies, peak_periods, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, name, description || null, owner_name || null, criticality || 'medium',
    max_tolerable_downtime_hours || null, rto_hours || null, rpo_hours || null,
    dependencies || null, peak_periods || null, status || 'active'
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_bcp_process', 'bcp_process', id, { name }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Process added'));
});

app.post('/workspaces/:wsId/bcp/processes/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const f = ['name','description','owner_name','criticality','max_tolerable_downtime_hours','rto_hours','rpo_hours','dependencies','peak_periods','status'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE bcp_processes SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_bcp_process', 'bcp_process', req.params.id, null, auditCtx(req));
  }
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/bcp/processes/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM bcp_processes WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'delete_bcp_process', 'bcp_process', req.params.id, null, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Process deleted'));
});

// BCP Plans CRUD
app.post('/workspaces/:wsId/bcp/plans', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { name, description, plan_type, recovery_steps, key_contacts, alternate_site, status, next_review_date } = req.body;
  if (!name) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO bcp_plans (workspace_id, name, description, plan_type, recovery_steps,
    key_contacts, alternate_site, status, next_review_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, name, description || null, plan_type || 'bcp', recovery_steps || null,
    key_contacts || null, alternate_site || null, status || 'draft', next_review_date || null, req.user.id
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_bcp_plan', 'bcp_plan', id, { name }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + id, 'Plan created'));
});

app.get('/workspaces/:wsId/bcp/plans/:id', requireAuth, requireWorkspace, (req, res) => {
  const plan = db.prepare(`SELECT * FROM bcp_plans WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!plan) return res.status(404).send('Not found');
  const linkedProcesses = db.prepare(`SELECT p.*, pp.id AS link_id FROM bcp_processes p
    JOIN bcp_plan_processes pp ON pp.process_id=p.id WHERE pp.plan_id=? AND p.workspace_id=?`).all(plan.id, req.workspace.id);
  const tests = db.prepare(`SELECT * FROM bcp_tests WHERE plan_id=? AND workspace_id=? ORDER BY test_date DESC`).all(plan.id, req.workspace.id);
  const allProcesses = db.prepare(`SELECT * FROM bcp_processes WHERE workspace_id=? ORDER BY name`).all(req.workspace.id);
  const linkedIds = new Set(linkedProcesses.map(p => p.id));
  const unlinkableProcesses = allProcesses.filter(p => !linkedIds.has(p.id));
  res.render('bcp_plan', { user: req.user, ws: req.workspace, plan, linkedProcesses, tests, allProcesses, unlinkableProcesses });
});

app.post('/workspaces/:wsId/bcp/plans/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const f = ['name','description','plan_type','recovery_steps','key_contacts','alternate_site','status','next_review_date'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.mark_reviewed) {
    set.push('last_reviewed_at=CURRENT_TIMESTAMP');
  }
  if (set.length) {
    vals.push(req.params.id, req.workspace.id);
    db.prepare(`UPDATE bcp_plans SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_bcp_plan', 'bcp_plan', req.params.id, null, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + req.params.id);
});

app.post('/workspaces/:wsId/bcp/plans/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM bcp_plans WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'delete_bcp_plan', 'bcp_plan', req.params.id, null, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp', 'Plan deleted'));
});

// Link/unlink processes to a plan
app.post('/workspaces/:wsId/bcp/plans/:id/processes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const planId = req.params.id;
  const plan = db.prepare(`SELECT id FROM bcp_plans WHERE id=? AND workspace_id=?`).get(planId, req.workspace.id);
  if (!plan) return res.status(404).send('Not found');
  if (req.body.action === 'link' && req.body.process_id) {
    const proc = db.prepare(`SELECT id FROM bcp_processes WHERE id=? AND workspace_id=?`).get(req.body.process_id, req.workspace.id);
    if (proc) {
      db.prepare(`INSERT OR IGNORE INTO bcp_plan_processes (plan_id, process_id) VALUES (?, ?)`).run(planId, proc.id);
      logAction(req.user.id, req.workspace.id, 'link_bcp_process', 'bcp_plan', planId, { process_id: proc.id }, auditCtx(req));
    }
  } else if (req.body.action === 'unlink' && req.body.process_id) {
    db.prepare(`DELETE FROM bcp_plan_processes WHERE plan_id=? AND process_id=?`).run(planId, req.body.process_id);
    logAction(req.user.id, req.workspace.id, 'unlink_bcp_process', 'bcp_plan', planId, { process_id: req.body.process_id }, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + planId);
});

// BCP Tests CRUD
app.post('/workspaces/:wsId/bcp/plans/:id/tests', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const planId = req.params.id;
  const plan = db.prepare(`SELECT id FROM bcp_plans WHERE id=? AND workspace_id=?`).get(planId, req.workspace.id);
  if (!plan) return res.status(404).send('Not found');
  const { test_type, test_date, participants, scenario_description, results, lessons_learned,
    rto_achieved_hours, rpo_achieved_hours, pass, action_items, next_test_date } = req.body;
  const id = db.prepare(`INSERT INTO bcp_tests (workspace_id, plan_id, test_type, test_date, participants,
    scenario_description, results, lessons_learned, rto_achieved_hours, rpo_achieved_hours, pass,
    action_items, next_test_date, conducted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, planId, test_type || 'tabletop', test_date || null, participants || null,
    scenario_description || null, results || null, lessons_learned || null,
    rto_achieved_hours || null, rpo_achieved_hours || null,
    pass === '1' ? 1 : (pass === '0' ? 0 : null),
    action_items || null, next_test_date || null, req.user.id
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_bcp_test', 'bcp_test', id, { plan_id: planId, test_type }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + planId, 'Test recorded'));
});

app.post('/workspaces/:wsId/bcp/tests/:testId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const test = db.prepare(`SELECT * FROM bcp_tests WHERE id=? AND workspace_id=?`).get(req.params.testId, req.workspace.id);
  if (!test) return res.status(404).send('Not found');
  const f = ['test_type','test_date','participants','scenario_description','results','lessons_learned',
    'rto_achieved_hours','rpo_achieved_hours','action_items','next_test_date'];
  const set = []; const vals = [];
  f.forEach(k => { if (req.body[k] !== undefined) { set.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.pass !== undefined) { set.push('pass=?'); vals.push(req.body.pass === '1' ? 1 : (req.body.pass === '0' ? 0 : null)); }
  if (set.length) {
    vals.push(req.params.testId, req.workspace.id);
    db.prepare(`UPDATE bcp_tests SET ${set.join(',')} WHERE id=? AND workspace_id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'update_bcp_test', 'bcp_test', req.params.testId, null, auditCtx(req));
  }
  res.redirect('/workspaces/' + req.workspace.id + '/bcp/plans/' + test.plan_id);
});

app.post('/workspaces/:wsId/bcp/tests/:testId/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const test = db.prepare(`SELECT plan_id FROM bcp_tests WHERE id=? AND workspace_id=?`).get(req.params.testId, req.workspace.id);
  if (!test) return res.status(404).send('Not found');
  db.prepare(`DELETE FROM bcp_tests WHERE id=? AND workspace_id=?`).run(req.params.testId, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'delete_bcp_test', 'bcp_test', req.params.testId, null, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/bcp/plans/' + test.plan_id, 'Test deleted'));
});

// ==================== CHANGE MANAGEMENT REGISTER (A.8.32) ====================
app.get('/workspaces/:wsId/changes', requireAuth, requireWorkspace, (req, res) => {
  const { status, change_type, risk_level } = req.query;
  let q = `SELECT * FROM changes WHERE workspace_id=?`;
  const params = [req.workspace.id];
  if (status && status !== 'all') { q += ` AND status=?`; params.push(status); }
  if (change_type && change_type !== 'all') { q += ` AND change_type=?`; params.push(change_type); }
  if (risk_level && risk_level !== 'all') { q += ` AND risk_level=?`; params.push(risk_level); }
  q += ` ORDER BY created_at DESC`;
  const changes = db.prepare(q).all(...params);

  // Summary stats
  const total = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=?`).get(req.workspace.id).c;
  const openCount = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status NOT IN ('closed')`).get(req.workspace.id).c;
  const emergencyCount = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND change_type='emergency'`).get(req.workspace.id).c;
  const pendingApproval = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status='submitted'`).get(req.workspace.id).c;
  const implemented = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status IN ('implemented','closed')`).get(req.workspace.id).c;
  const closed = db.prepare(`SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status='closed'`).get(req.workspace.id).c;
  const pirPct = implemented > 0 ? Math.round((closed / implemented) * 100) : 0;

  res.render('changes', {
    user: req.user, ws: req.workspace, changes,
    filters: { status: status || 'all', change_type: change_type || 'all', risk_level: risk_level || 'all' },
    stats: { total, openCount, emergencyCount, pendingApproval, pirPct }
  });
});

app.get('/workspaces/:wsId/changes/:id', requireAuth, requireWorkspace, (req, res) => {
  const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!change) return res.status(404).render('error', { user: req.user, message: 'Change request not found.' });
  const approvals = db.prepare(`SELECT * FROM change_approvals WHERE change_id=? AND workspace_id=? ORDER BY sequence, id`).all(change.id, req.workspace.id);
  res.render('change_detail', { user: req.user, ws: req.workspace, change, approvals });
});

app.post('/workspaces/:wsId/changes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { title, description, change_type, category, risk_assessment, risk_level, impact_assessment, rollback_plan, requester_name } = req.body;
  if (!title || !title.trim()) return redirectBack(req, res);
  const id = db.prepare(`INSERT INTO changes (workspace_id, title, description, change_type, category, requester_name, requester_id, risk_assessment, risk_level, impact_assessment, rollback_plan, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, title.trim(), description || null, change_type || 'normal', category || null,
    requester_name || req.user.name || req.user.email, req.user.id,
    risk_assessment || null, risk_level || 'medium', impact_assessment || null, rollback_plan || null,
    req.user.id
  ).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'create_change', 'change', id, { title: title.trim() }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + id, 'Change request created'));
});

app.post('/workspaces/:wsId/changes/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!change) return redirectBack(req, res);
  const { title, description, change_type, category, risk_assessment, risk_level, impact_assessment, rollback_plan, requester_name, implementation_notes, test_results } = req.body;
  db.prepare(`UPDATE changes SET title=?, description=?, change_type=?, category=?, risk_assessment=?, risk_level=?, impact_assessment=?, rollback_plan=?, requester_name=?, implementation_notes=?, test_results=?
    WHERE id=? AND workspace_id=?`).run(
    title || change.title, description || null, change_type || change.change_type, category || null,
    risk_assessment || null, risk_level || change.risk_level, impact_assessment || null, rollback_plan || null,
    requester_name || change.requester_name, implementation_notes || null, test_results || null,
    req.params.id, req.workspace.id
  );
  logAction(req.user.id, req.workspace.id, 'update_change', 'change', req.params.id, null, auditCtx(req));
  res.redirect('/workspaces/' + req.workspace.id + '/changes/' + req.params.id);
});

app.post('/workspaces/:wsId/changes/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM change_approvals WHERE change_id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  db.prepare(`DELETE FROM changes WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'delete_change', 'change', req.params.id, null, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes', 'Change request deleted'));
});

app.post('/workspaces/:wsId/changes/:id/submit', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=? AND status='draft'`).get(req.params.id, req.workspace.id);
  if (!change) return redirectBack(req, res, 'Change must be in draft status to submit', 'warn');
  db.prepare(`UPDATE changes SET status='submitted', submitted_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'submit_change', 'change', req.params.id, { from: 'draft', to: 'submitted' }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + req.params.id, 'Change submitted for approval'));
});

app.post('/workspaces/:wsId/changes/:id/approve', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!change) return redirectBack(req, res);
  // Allow approval on submitted changes or retrospective approval on implemented emergency changes
  if (change.status !== 'submitted' && !(change.change_type === 'emergency' && change.status === 'implemented')) {
    return redirectBack(req, res, 'Change is not awaiting approval', 'warn');
  }
  const reason = req.body.reason || null;
  db.prepare(`INSERT INTO change_approvals (change_id, workspace_id, approver_id, approver_name, decision, reason, decided_at)
    VALUES (?, ?, ?, ?, 'approved', ?, CURRENT_TIMESTAMP)`).run(
    change.id, req.workspace.id, req.user.id, req.user.name || req.user.email, reason
  );
  // Update status to approved (for submitted changes)
  if (change.status === 'submitted') {
    db.prepare(`UPDATE changes SET status='approved', approved_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=?`).run(change.id, req.workspace.id);
  }
  logAction(req.user.id, req.workspace.id, 'approve_change', 'change', change.id, { decision: 'approved', reason }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change approved'));
});

app.post('/workspaces/:wsId/changes/:id/reject', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=? AND status='submitted'`).get(req.params.id, req.workspace.id);
  if (!change) return redirectBack(req, res, 'Change is not awaiting approval', 'warn');
  const reason = req.body.reason || null;
  db.prepare(`INSERT INTO change_approvals (change_id, workspace_id, approver_id, approver_name, decision, reason, decided_at)
    VALUES (?, ?, ?, ?, 'rejected', ?, CURRENT_TIMESTAMP)`).run(
    change.id, req.workspace.id, req.user.id, req.user.name || req.user.email, reason
  );
  db.prepare(`UPDATE changes SET status='rejected' WHERE id=? AND workspace_id=?`).run(change.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'reject_change', 'change', change.id, { decision: 'rejected', reason }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change rejected'));
});

app.post('/workspaces/:wsId/changes/:id/implement', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!change) return redirectBack(req, res);
  // Normal/standard: must be approved. Emergency: can go from draft directly.
  const allowedStatuses = change.change_type === 'emergency' ? ['draft', 'approved'] : ['approved'];
  if (!allowedStatuses.includes(change.status)) {
    return redirectBack(req, res, 'Change must be approved before implementation' + (change.change_type === 'emergency' ? ' (or draft for emergency)' : ''), 'warn');
  }
  const { implementation_notes, test_results } = req.body;
  db.prepare(`UPDATE changes SET status='implemented', implemented_at=CURRENT_TIMESTAMP, implementation_notes=?, test_results=?
    WHERE id=? AND workspace_id=?`).run(
    implementation_notes || change.implementation_notes || null,
    test_results || change.test_results || null,
    change.id, req.workspace.id
  );
  logAction(req.user.id, req.workspace.id, 'implement_change', 'change', change.id, { from: change.status, to: 'implemented' }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change marked as implemented'));
});

app.post('/workspaces/:wsId/changes/:id/close', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const change = db.prepare(`SELECT * FROM changes WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!change) return redirectBack(req, res);
  if (change.status !== 'implemented') return redirectBack(req, res, 'Change must be implemented before closing', 'warn');
  // Emergency changes need retrospective approval before closing
  if (change.change_type === 'emergency') {
    const hasApproval = db.prepare(`SELECT COUNT(*) c FROM change_approvals WHERE change_id=? AND workspace_id=? AND decision='approved'`).get(change.id, req.workspace.id).c;
    if (!hasApproval) return redirectBack(req, res, 'Emergency changes require retrospective approval before closing', 'warn');
  }
  const { post_implementation_review, success, pir_date } = req.body;
  db.prepare(`UPDATE changes SET status='closed', closed_at=CURRENT_TIMESTAMP, post_implementation_review=?, success=?, pir_date=?
    WHERE id=? AND workspace_id=?`).run(
    post_implementation_review || null,
    success === 'yes' || success === '1' ? 1 : 0,
    pir_date || new Date().toISOString().split('T')[0],
    change.id, req.workspace.id
  );
  logAction(req.user.id, req.workspace.id, 'close_change', 'change', change.id, { success: success === 'yes' || success === '1' ? 1 : 0 }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/changes/' + change.id, 'Change closed with PIR'));
});

// ==================== VENDORS / SUPPLIERS - TPRM ====================
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
  db.prepare(`UPDATE suppliers SET inherent_risk_score=?, residual_risk_score=? WHERE id=? AND workspace_id=?`).run(inherent, residual, supplierId, wsId);
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

app.post('/workspaces/:wsId/vendors', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
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
  const cur = db.prepare(`SELECT inherent_risk_score FROM suppliers WHERE id=? AND workspace_id=?`).get(id, req.workspace.id);
  db.prepare(`UPDATE suppliers SET tier=? WHERE id=? AND workspace_id=?`).run(tierFromRisk(cur.inherent_risk_score), id, req.workspace.id);
  fts.refresh(req.workspace.id, 'supplier', id);

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
  const notesRaw = db.prepare(`SELECT * FROM supplier_notes WHERE supplier_id=? ORDER BY created_at DESC, id DESC`).all(v.id);
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

app.post('/workspaces/:wsId/vendors/:id', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
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
    fts.refresh(req.workspace.id, 'supplier', req.params.id);
    logAction(req.user.id, req.workspace.id, 'update_supplier', 'supplier', req.params.id, null);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id);
});

app.post('/workspaces/:wsId/vendors/:id/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  db.prepare(`DELETE FROM suppliers WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  fts.removeEntity({ workspaceId: req.workspace.id, entityType: 'supplier', entityId: req.params.id });
  res.redirect('/workspaces/' + req.workspace.id + '/vendors');
});

// Documents
app.post('/workspaces/:wsId/vendors/:id/documents', requireAuth, requireWorkspace, requirePermission('supplier.manage'), upload.single('file'), (req, res) => {
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

app.post('/workspaces/:wsId/vendors/:id/documents/:docId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const d = db.prepare(`SELECT * FROM supplier_documents WHERE id=? AND supplier_id=? AND workspace_id=?`).get(req.params.docId, req.params.id, req.workspace.id);
  if (d) {
    if (d.stored_path) { const fp = resolveUploadPath(d.stored_path, req.workspace.firm_id); if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); }
    db.prepare(`DELETE FROM supplier_documents WHERE id=? AND workspace_id=?`).run(d.id, req.workspace.id);
    recomputeSupplierRisk(req.params.id, req.workspace.id);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=documents');
});

// Sub-processors
app.post('/workspaces/:wsId/vendors/:id/subprocessors', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const { name, service_provided, data_access, location, approved } = req.body;
  if (!name) return redirectBack(req, res);
  db.prepare(`INSERT INTO supplier_subprocessors (workspace_id, supplier_id, name, service_provided, data_access, location, approved, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, name, service_provided || null,
    data_access || null, location || null, approved ? 1 : 0, approved ? new Date().toISOString() : null
  );
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=subprocessors');
});

app.post('/workspaces/:wsId/vendors/:id/subprocessors/:spId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  db.prepare(`DELETE FROM supplier_subprocessors WHERE id=? AND supplier_id=? AND workspace_id=?`).run(req.params.spId, req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=subprocessors');
});

// Reviews
app.post('/workspaces/:wsId/vendors/:id/reviews', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const { review_date, reviewer, outcome, findings, action_items, next_review_date } = req.body;
  const supplier = db.prepare(`SELECT inherent_risk_score, residual_risk_score FROM suppliers WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!supplier) return res.status(404).send('Supplier not found');
  db.prepare(`INSERT INTO supplier_reviews (workspace_id, supplier_id, review_date, reviewer, outcome, inherent_risk, residual_risk, findings, action_items, next_review_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.workspace.id, req.params.id, review_date || null, reviewer || null,
    outcome || 'approved', supplier?.inherent_risk_score || null, supplier?.residual_risk_score || null,
    findings || null, action_items || null, next_review_date || null
  );
  // Update supplier next_review_date and last_assessed
  if (next_review_date) {
    db.prepare(`UPDATE suppliers SET next_review_date=?, last_assessed=? WHERE id=? AND workspace_id=?`).run(next_review_date, review_date || new Date().toISOString().split('T')[0], req.params.id, req.workspace.id);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=reviews');
});

// Notes
app.post('/workspaces/:wsId/vendors/:id/notes', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/vendors/:id/notes/:noteId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  db.prepare(`DELETE FROM supplier_notes WHERE id=? AND supplier_id=? AND workspace_id=?`).run(req.params.noteId, req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=notes');
});

// Clauses
app.post('/workspaces/:wsId/vendors/:id/clauses/:clauseId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const { status, notes } = req.body;
  db.prepare(`UPDATE supplier_clauses SET status=?, notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND supplier_id=? AND workspace_id=?`)
    .run(status, notes || null, req.params.clauseId, req.params.id, req.workspace.id);
  recomputeSupplierRisk(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=clauses');
});

// Phase B: declare which Annex A controls a supplier handles on our behalf (A.5.19-A.5.23)
app.post('/workspaces/:wsId/vendors/:id/controls', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
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

app.post('/workspaces/:wsId/vendors/:id/controls/:linkId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
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
app.post('/workspaces/:wsId/vendors/:id/questionnaires', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const { template_id } = req.body;
  const tpl = db.prepare(`SELECT * FROM questionnaire_templates WHERE id=? AND (is_system=1 OR firm_id=?)`).get(template_id, req.workspace.firm_id);
  if (!tpl) return redirectBack(req, res);
  const qCount = db.prepare(`SELECT COUNT(*) c FROM questionnaire_questions WHERE template_id=?`).get(template_id).c;
  const qid = db.prepare(`INSERT INTO supplier_questionnaires (workspace_id, supplier_id, template_id, template_name, status, sent_at, total_questions)
    VALUES (?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP, ?)`).run(
    req.workspace.id, req.params.id, template_id, tpl.name, qCount
  ).lastInsertRowid;
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '/questionnaires/' + qid);
});

app.get('/workspaces/:wsId/vendors/:id/questionnaires/:qId', requireAuth, requireWorkspace, (req, res) => {
  const q = db.prepare(`SELECT q.*, s.name AS supplier_name, s.contact AS supplier_contact, t.description AS tpl_description
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    LEFT JOIN questionnaire_templates t ON t.id=q.template_id
    WHERE q.id=? AND q.workspace_id=?`).get(req.params.qId, req.workspace.id);
  if (!q) return res.status(404).send('Not found');
  const questions = db.prepare(`SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order`).all(q.template_id);
  const responses = db.prepare(`SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?`).all(q.id);
  const respMap = Object.fromEntries(responses.map(r => [r.question_id, r]));
  // Per-question evidence attachments (vendor- or consultant-uploaded). Keyed by
  // question_id; files with no question_id land under 'general'.
  const attachRows = db.prepare(`SELECT * FROM questionnaire_attachments WHERE questionnaire_id=? ORDER BY uploaded_at`).all(q.id);
  const attachMap = {};
  attachRows.forEach(a => { const k = a.question_id == null ? 'general' : a.question_id; (attachMap[k] = attachMap[k] || []).push(a); });
  // Group by section
  const sections = {};
  questions.forEach(qu => { (sections[qu.section] = sections[qu.section] || []).push(qu); });
  res.render('vendor_questionnaire', { user: req.user, ws: req.workspace, q, sections, respMap, attachMap });
});

app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), qUploadAny, (req, res) => {
  const ws = req.workspace;
  const qid = req.params.qId;
  const dest = '/workspaces/' + ws.id + '/vendors/' + req.params.id + '/questionnaires/' + qid;
  const questionnaire = db.prepare('SELECT id FROM supplier_questionnaires WHERE id=? AND workspace_id=?').get(qid, ws.id);
  if (!questionnaire) return res.status(404).send('Questionnaire not found');

  // A multer error (oversize / too many files) aborts parsing mid-stream, so the
  // body may be partial — bail before saving and tell the consultant to retry.
  if (req._uploadError) {
    (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    const e = req._uploadError;
    const msg = e && e.code === 'LIMIT_FILE_SIZE' ? 'A file exceeded the 25 MB limit — nothing was saved. Please attach a smaller file and try again.'
      : e && e.code === 'LIMIT_FILE_COUNT' ? 'Too many files at once (limit 40) — nothing was saved. Please try again with fewer files.'
      : 'An attachment could not be processed — nothing was saved. Please try again.';
    return res.redirect(withToast(dest, msg));
  }

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
    WHERE id=? AND workspace_id=?`).run(allQ.filter(q => q.answer).length, finalScore, rating, status, status, status, status, reviewer, reviewerComments, qid, req.workspace.id);
  recomputeSupplierRisk(req.params.id, req.workspace.id);

  // Persist any evidence the consultant attached during review.
  let attachSaved = 0;
  try {
    attachSaved = persistQuestionnaireFiles({
      files: req.files, questionnaireId: parseInt(qid, 10), workspaceId: ws.id, source: 'consultant', uploadedBy: req.user.id
    });
  } catch (e) { console.error('[questionnaire attach]', e && e.message); }

  logAction(req.user.id, ws.id, 'update_questionnaire', 'questionnaire', qid, { status, score: finalScore, attachments: attachSaved });

  const rejected = req._rejectedUploads || [];
  let toast = status === 'reviewed' ? 'Questionnaire marked reviewed.' : status === 'responded' ? 'Responses submitted.' : 'Draft saved.';
  if (attachSaved) toast += ` ${attachSaved} file${attachSaved === 1 ? '' : 's'} attached.`;
  if (rejected.length) toast += ` ${rejected.length} file${rejected.length === 1 ? '' : 's'} skipped (unsupported type).`;
  res.redirect(withToast(dest, toast));
});

app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  // Unlink attachment files first — the questionnaire_attachments rows cascade
  // via FK, but the files on disk would otherwise be orphaned.
  const files = db.prepare(`SELECT a.stored_path FROM questionnaire_attachments a
    INNER JOIN supplier_questionnaires q ON q.id=a.questionnaire_id
    WHERE a.questionnaire_id=? AND q.supplier_id=? AND q.workspace_id=?`)
    .all(req.params.qId, req.params.id, req.workspace.id);
  files.forEach(f => { if (f.stored_path) { const fp = resolveUploadPath(f.stored_path, req.workspace.firm_id); if (fp && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} } } });
  db.prepare(`DELETE FROM supplier_questionnaires WHERE id=? AND supplier_id=? AND workspace_id=?`).run(req.params.qId, req.params.id, req.workspace.id);
  recomputeSupplierRisk(req.params.id, req.workspace.id);
  res.redirect('/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '?tab=questionnaires');
});

// Download a questionnaire attachment. Scoped by joining through the parent
// questionnaire so a token from one workspace can't pull another's files.
app.get('/workspaces/:wsId/vendors/:id/questionnaires/:qId/attachments/:attId/download', requireAuth, requireWorkspace, (req, res) => {
  const a = db.prepare(`SELECT a.* FROM questionnaire_attachments a
    INNER JOIN supplier_questionnaires q ON q.id=a.questionnaire_id
    WHERE a.id=? AND a.questionnaire_id=? AND q.supplier_id=? AND q.workspace_id=?`)
    .get(req.params.attId, req.params.qId, req.params.id, req.workspace.id);
  if (!a || !a.stored_path) return res.status(404).send('Not found');
  const fp = resolveUploadPath(a.stored_path, req.workspace.firm_id);
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('File missing');
  res.download(fp, a.filename);
});

// Delete a questionnaire attachment (consultant only). Removes the file from
// disk then the row; same join-scoping as download.
app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/attachments/:attId/delete', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const a = db.prepare(`SELECT a.* FROM questionnaire_attachments a
    INNER JOIN supplier_questionnaires q ON q.id=a.questionnaire_id
    WHERE a.id=? AND a.questionnaire_id=? AND q.supplier_id=? AND q.workspace_id=?`)
    .get(req.params.attId, req.params.qId, req.params.id, req.workspace.id);
  const dest = '/workspaces/' + req.workspace.id + '/vendors/' + req.params.id + '/questionnaires/' + req.params.qId;
  if (a) {
    if (a.stored_path) { const fp = resolveUploadPath(a.stored_path, req.workspace.firm_id); if (fp && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} } }
    db.prepare(`DELETE FROM questionnaire_attachments WHERE id=?`).run(a.id);
    logAction(req.user.id, req.workspace.id, 'delete_questionnaire_attachment', 'questionnaire', req.params.qId, { filename: a.filename });
    return res.redirect(withToast(dest, 'Attachment deleted.'));
  }
  res.redirect(dest);
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
    controls: dayCounts(`SELECT date(last_updated) AS d, COUNT(*) AS c FROM ${ctlReads.tables(db, wsId).cs} WHERE workspace_id=? AND status='Implemented' AND last_updated >= date('now','-29 days') GROUP BY date(last_updated)`, wsId),
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

// ==================== ISMS PERFORMANCE METRICS (Clause 9.1) ====================
// Auto-computed KPIs from existing tables. The auditor's complaint was that
// MRM inputs are free-text; this lets a consultant click "Feed to MRM" and
// have the numbers land in the next management-review record.
function computeIsmsMetrics(wsId) {
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const oneEightyDaysAgo = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const cnt = (sql, ...args) => { try { return db.prepare(sql).get(wsId, ...args)?.c || 0; } catch (_) { return 0; } };
  const safeAll = (sql, ...args) => { try { return db.prepare(sql).all(wsId, ...args); } catch (_) { return []; } };
  const Tm = ctlReads.tables(db, wsId);

  // 1. Control implementation %
  const controlImpl = cnt(`SELECT COUNT(*) c FROM ${Tm.cs} WHERE workspace_id=? AND status='Implemented' AND applicability='included'`);
  const controlIncluded = cnt(`SELECT COUNT(*) c FROM ${Tm.cs} WHERE workspace_id=? AND applicability='included'`);

  // 2. Training completion %
  const trainAssigned = cnt(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=?`);
  const trainComplete = cnt(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=? AND status='completed'`);

  // 3. NCs by severity (open)
  const ncOpen = safeAll(`SELECT severity, COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND status != 'closed' GROUP BY severity`);
  const ncBySev = { major: 0, minor: 0, observation: 0, other: 0 };
  ncOpen.forEach(r => { ncBySev[r.severity || 'other'] = (ncBySev[r.severity || 'other'] || 0) + r.c; });
  const ncOpenTotal = ncBySev.major + ncBySev.minor + ncBySev.observation + ncBySev.other;

  // 4. Mean Time To Close NC (last 90 days)
  const ncClosed90 = safeAll(`SELECT julianday(closed_at) - julianday(created_at) AS d FROM nonconformities
    WHERE workspace_id=? AND closed_at IS NOT NULL AND closed_at >= ?`, ninetyDaysAgo);
  const mttcDays = ncClosed90.length ? Math.round(ncClosed90.reduce((s, r) => s + (r.d || 0), 0) / ncClosed90.length) : null;

  // Prior 90 days for delta
  const ncClosedPrior = safeAll(`SELECT julianday(closed_at) - julianday(created_at) AS d FROM nonconformities
    WHERE workspace_id=? AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?`, oneEightyDaysAgo, ninetyDaysAgo);
  const mttcPrior = ncClosedPrior.length ? Math.round(ncClosedPrior.reduce((s, r) => s + (r.d || 0), 0) / ncClosedPrior.length) : null;

  // 5. Overdue tasks %
  const tasksOpen = cnt(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND status != 'closed' AND status != 'completed'`);
  const tasksOverdue = cnt(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND status != 'closed' AND status != 'completed' AND due_date IS NOT NULL AND due_date < ?`, today);

  // 6. Risks above appetite (heuristic: likelihood*impact >= 15 = high)
  const risksHigh = cnt(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status != 'closed' AND status != 'accepted' AND (likelihood * impact) >= 15`);
  const risksAccepted = cnt(`SELECT COUNT(*) c FROM risk_acceptances WHERE workspace_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`, today);

  // 7. Document review compliance %
  const docsApproved = cnt(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published')`);
  const docsOverdue = cnt(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') AND next_review_date < ?`, today);

  // 8. Evidence freshness %
  let evidenceFresh = 0, evidenceTotalCtl = 0;
  try {
    const rows = db.prepare(`SELECT i.id,
        (SELECT MAX(uploaded_at) FROM evidence WHERE workspace_id=? AND iso_item_id=i.id AND superseded_at IS NULL) AS last_ev
      FROM iso_items i
      INNER JOIN ${Tm.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' AND cs.applicability='included'`).all(wsId, wsId);
    evidenceTotalCtl = rows.length;
    evidenceFresh = rows.filter(r => r.last_ev && r.last_ev >= oneYearAgo).length;
  } catch (_) {}

  // 9. Internal audit completion (audits with audit_date in last 12 months)
  const auditsRun = cnt(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL AND audit_date >= ?`, oneYearAgo);

  // 10. Incident MTTR (last 90 days)
  let incidentMTTR = null;
  try {
    const inc = db.prepare(`SELECT julianday(COALESCE(resolved_at, closed_at)) - julianday(detected_at) AS d FROM incidents
      WHERE workspace_id=? AND COALESCE(resolved_at, closed_at) IS NOT NULL AND COALESCE(resolved_at, closed_at) >= ?`).all(wsId, ninetyDaysAgo);
    if (inc.length) incidentMTTR = Math.round(inc.reduce((s, r) => s + (r.d || 0), 0) / inc.length * 10) / 10;
  } catch (_) {}

  // 11. Open incidents
  const incidentsOpen = cnt(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=? AND status NOT IN ('closed','resolved')`);

  return {
    controlImpl, controlIncluded,
    controlImplPct: controlIncluded ? Math.round((controlImpl / controlIncluded) * 100) : 0,
    trainAssigned, trainComplete,
    trainPct: trainAssigned ? Math.round((trainComplete / trainAssigned) * 100) : 0,
    ncBySev, ncOpenTotal,
    mttcDays, mttcPrior,
    tasksOpen, tasksOverdue,
    tasksOverduePct: tasksOpen ? Math.round((tasksOverdue / tasksOpen) * 100) : 0,
    risksHigh, risksAccepted,
    docsApproved, docsOverdue,
    docsReviewPct: docsApproved ? Math.round(((docsApproved - docsOverdue) / docsApproved) * 100) : 0,
    evidenceFresh, evidenceTotalCtl,
    evidenceFreshPct: evidenceTotalCtl ? Math.round((evidenceFresh / evidenceTotalCtl) * 100) : 0,
    auditsRun,
    incidentMTTR, incidentsOpen
  };
}

// The standalone performance dashboard was merged into the adopted-metrics area;
// keep the old path working by redirecting. computeIsmsMetrics is still used by
// the feed-to-mrm route below to push live KPIs into a management review.
app.get('/workspaces/:wsId/metrics', requireAuth, requireWorkspace, (req, res) => {
  res.redirect('/workspaces/' + req.workspace.id + '/metrics/adopted');
});

// Push current metrics into the chosen MRM's performance_review field.
app.post('/workspaces/:wsId/metrics/feed-to-mrm/:mrmId', requireAuth, requireWorkspace, requirePermission('mrm.manage'), (req, res) => {
  const mrm = db.prepare(`SELECT id FROM mrms WHERE id=? AND workspace_id=?`).get(req.params.mrmId, req.workspace.id);
  if (!mrm) return res.status(404).send('MRM not found');
  const m = computeIsmsMetrics(req.workspace.id);
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let block = [
    `--- ISMS performance metrics (auto-fed ${ts}) ---`,
    `Control implementation: ${m.controlImpl}/${m.controlIncluded} included controls Implemented (${m.controlImplPct}%)`,
    `Training completion: ${m.trainComplete}/${m.trainAssigned} (${m.trainPct}%)`,
    `Open NCs: ${m.ncBySev.major} major, ${m.ncBySev.minor} minor, ${m.ncBySev.observation} observation (${m.ncOpenTotal} total)`,
    `NC mean time to close (last 90d): ${m.mttcDays == null ? 'n/a' : m.mttcDays + ' days'}${m.mttcPrior != null ? ` (prior 90d: ${m.mttcPrior} days)` : ''}`,
    `Tasks overdue: ${m.tasksOverdue}/${m.tasksOpen} (${m.tasksOverduePct}%)`,
    `High-severity open risks (L×I ≥ 15): ${m.risksHigh}`,
    `Active risk acceptances: ${m.risksAccepted}`,
    `Document review compliance: ${m.docsReviewPct}% (${m.docsOverdue} overdue of ${m.docsApproved} approved)`,
    `Evidence freshness (included controls with evidence in last 12 mo): ${m.evidenceFresh}/${m.evidenceTotalCtl} (${m.evidenceFreshPct}%)`,
    `Internal audits in last 12 mo: ${m.auditsRun}`,
    `Incident MTTR (last 90d): ${m.incidentMTTR == null ? 'n/a' : m.incidentMTTR + ' days'}`,
    `Open incidents: ${m.incidentsOpen}`
  ].join('\n');
  // Append the adopted ISO/IEC 27004 measures with their latest readings, so the
  // curated measurement programme reaches the review alongside the auto-computed KPIs.
  const adoptedFeed = db.prepare(`
    SELECT m.name, m.ref, m.unit, m.direction, m.target_value,
      (SELECT value FROM isms_metric_readings r WHERE r.metric_id=m.id ORDER BY r.measured_at DESC, r.id DESC LIMIT 1) AS latest_value,
      (SELECT measured_at FROM isms_metric_readings r WHERE r.metric_id=m.id ORDER BY r.measured_at DESC, r.id DESC LIMIT 1) AS latest_at
    FROM isms_metrics m WHERE m.workspace_id=? ORDER BY m.category, m.name`).all(req.workspace.id);
  if (adoptedFeed.length) {
    const suffix = u => u === '%' ? '%' : u === 'days' ? ' d' : '';
    const lines = adoptedFeed.map(a => {
      const rag = ismsMetricRag(a.latest_value, a.target_value, a.direction);
      const val = a.latest_value == null ? 'no reading yet' : a.latest_value + suffix(a.unit) + (a.latest_at ? ` (as of ${a.latest_at})` : '');
      const tgt = a.target_value == null ? 'no target set' : `target ${a.target_value}${suffix(a.unit)}`;
      const status = rag ? ` [${rag === 'green' ? 'on target' : rag === 'amber' ? 'near target' : 'off target'}]` : '';
      return `${a.ref} ${a.name}: ${val}; ${tgt}${status}`;
    });
    block += `\n\n--- Adopted ISO/IEC 27004 measures (${adoptedFeed.length}) ---\n` + lines.join('\n');
  }
  // Append to existing performance_review rather than overwrite (a manager
  // may have typed in their own notes already; we don't want to clobber).
  const existing = db.prepare(`SELECT performance_review FROM mrms WHERE id=?`).get(mrm.id);
  const merged = existing && existing.performance_review ? `${existing.performance_review}\n\n${block}` : block;
  db.prepare(`UPDATE mrms SET performance_review=? WHERE id=?`).run(merged, mrm.id);
  logAction(req.user.id, req.workspace.id, 'feed_metrics_to_mrm', 'mrm', mrm.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/mrms/${mrm.id}?notice=${encodeURIComponent('Metrics appended to performance review.')}`);
});

// ==================== ISMS METRICS LIBRARY (ISO/IEC 27004:2016 Annex B) ====================
// A catalog of standardized measures consultants adopt into an engagement, set a
// target on, and record readings against over time. Complements the auto-computed
// clause-9.1 dashboard above with a curated, user-maintained measurement programme.
const ISO27004_METRICS = require('./data/iso27004-metrics');
const ISO27004_BY_KEY = Object.fromEntries(ISO27004_METRICS.map(m => [m.key, m]));

// RAG status for a reading vs the adopted target, honouring the metric's direction
// (whether a higher or lower value is better). Null when no target/value is set.
function ismsMetricRag(value, target, direction) {
  if (value == null || target == null) return null;
  const lower = direction === 'lower';
  if (lower ? value <= target : value >= target) return 'green';
  if (lower ? value <= target * 1.1 : value >= target * 0.9) return 'amber';
  return 'red';
}

// Resolve iso_item ids to {id, title, type} for display + linking to controls.
function resolveControls(ids) {
  if (!ids || !ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, title, type FROM iso_items WHERE id IN (${ph})`).all(...ids);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  return ids.map(id => byId[id] || { id, title: id, type: 'control' });
}

// Browse the catalog; shows which measures are already adopted (with their id so
// the view can link/remove), and the full definition of each before adoption.
app.get('/workspaces/:wsId/metrics/library', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const adoptedById = {};
  db.prepare(`SELECT id, metric_key FROM isms_metrics WHERE workspace_id=?`).all(req.workspace.id).forEach(a => { adoptedById[a.metric_key] = a.id; });
  const byCategory = {};
  ISO27004_METRICS.forEach(m => {
    (byCategory[m.category] = byCategory[m.category] || []).push({
      ...m, adoptedId: adoptedById[m.key] || null, adopted: adoptedById[m.key] != null, controlsResolved: resolveControls(m.controls),
    });
  });
  const categories = ISO27004_METRICS.CATEGORIES.filter(c => byCategory[c]);
  res.render('metrics_library', { user: req.user, ws: req.workspace, byCategory, categories, total: ISO27004_METRICS.length, adoptedCount: Object.keys(adoptedById).length });
});

// Adopt selected catalog measures into the engagement.
app.post('/workspaces/:wsId/metrics/library', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const picked = parseFormArray(req.body.pick);
  if (!picked.length) return redirectBack(req, res, 'Select at least one metric to adopt.', 'warn');
  const ins = db.prepare(`INSERT OR IGNORE INTO isms_metrics
    (workspace_id, metric_key, ref, name, category, unit, direction, formula, target_value, target_text, frequency, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  const tx = db.transaction(() => {
    picked.forEach(key => {
      const m = ISO27004_BY_KEY[key];
      if (!m) return;
      const r = ins.run(req.workspace.id, m.key, m.ref, m.name, m.category, m.unit, m.direction,
        m.formula, m.suggestedTarget ?? null, m.targetText || null, m.frequency || null, req.user.id);
      if (r.changes) added++;
    });
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'adopt_isms_metrics', 'isms_metric', null, { count: added }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted',
    added ? `Adopted ${added} metric${added === 1 ? '' : 's'} - set targets and record readings` : 'Those metrics were already adopted'));
});

// Adopted measures with their latest reading vs target (RAG).
app.get('/workspaces/:wsId/metrics/adopted', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT value FROM isms_metric_readings r WHERE r.metric_id=m.id ORDER BY r.measured_at DESC, r.id DESC LIMIT 1) AS latest_value,
      (SELECT measured_at FROM isms_metric_readings r WHERE r.metric_id=m.id ORDER BY r.measured_at DESC, r.id DESC LIMIT 1) AS latest_at,
      (SELECT COUNT(*) FROM isms_metric_readings r WHERE r.metric_id=m.id) AS reading_count
    FROM isms_metrics m WHERE m.workspace_id=? ORDER BY m.category, m.name`).all(req.workspace.id);
  const byCategory = {};
  rows.forEach(m => {
    m.rag = ismsMetricRag(m.latest_value, m.target_value, m.direction);
    (byCategory[m.category] = byCategory[m.category] || []).push(m);
  });
  const categories = ISO27004_METRICS.CATEGORIES.filter(c => byCategory[c]);
  const ragCounts = { green: 0, amber: 0, red: 0, none: 0 };
  rows.forEach(m => ragCounts[m.rag || 'none']++);
  const upcomingMrms = db.prepare(`SELECT id, meeting_date FROM mrms WHERE workspace_id=? AND status != 'closed' ORDER BY meeting_date IS NULL, meeting_date LIMIT 5`).all(req.workspace.id);
  res.render('metrics_adopted', { user: req.user, ws: req.workspace, byCategory, categories, total: rows.length, ragCounts, upcomingMrms });
});

// Detail: one adopted measure, its readings + trend, and record/edit forms.
app.get('/workspaces/:wsId/metrics/adopted/:id', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const metric = db.prepare(`SELECT * FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
  const readings = db.prepare(`SELECT r.*, u.name AS recorder FROM isms_metric_readings r LEFT JOIN users u ON u.id=r.recorded_by WHERE r.metric_id=? ORDER BY r.measured_at ASC, r.id ASC`).all(metric.id);
  readings.forEach(r => { r.rag = ismsMetricRag(r.value, metric.target_value, metric.direction); });
  const catalog = ISO27004_BY_KEY[metric.metric_key] || {};
  const controlsResolved = resolveControls(catalog.controls || []);
  const latest = readings.length ? readings[readings.length - 1] : null;
  metric.rag = latest ? ismsMetricRag(latest.value, metric.target_value, metric.direction) : null;
  res.render('metric_detail', { user: req.user, ws: req.workspace, metric, readings, catalog, controlsResolved, latest });
});

// Record a reading against an adopted measure.
app.post('/workspaces/:wsId/metrics/adopted/:id/readings', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const metric = db.prepare(`SELECT * FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
  const value = parseFloat(req.body.value);
  if (!Number.isFinite(value)) return redirectBack(req, res, 'Enter a numeric value.', 'warn');
  const measured_at = (req.body.measured_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const status = ismsMetricRag(value, metric.target_value, metric.direction);
  db.prepare(`INSERT INTO isms_metric_readings (metric_id, value, measured_at, status, notes, recorded_by) VALUES (?,?,?,?,?,?)`)
    .run(metric.id, value, measured_at, status, (req.body.notes || '').trim() || null, req.user.id);
  logAction(req.user.id, req.workspace.id, 'record_metric_reading', 'isms_metric', metric.id, { value, measured_at }, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted/' + metric.id, 'Reading recorded'));
});

// Update target / owner / frequency / notes for an adopted measure.
app.post('/workspaces/:wsId/metrics/adopted/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const metric = db.prepare(`SELECT id FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
  const tv = req.body.target_value;
  const target_value = (tv === '' || tv == null || !Number.isFinite(parseFloat(tv))) ? null : parseFloat(tv);
  db.prepare(`UPDATE isms_metrics SET target_value=?, owner_name=?, frequency=?, notes=? WHERE id=?`)
    .run(target_value, (req.body.owner_name || '').trim() || null, (req.body.frequency || '').trim() || null, (req.body.notes || '').trim() || null, metric.id);
  logAction(req.user.id, req.workspace.id, 'update_isms_metric', 'isms_metric', metric.id, null, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted/' + metric.id, 'Metric updated'));
});

// Remove an adopted measure (cascade deletes its readings).
app.post('/workspaces/:wsId/metrics/adopted/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const metric = db.prepare(`SELECT id FROM isms_metrics WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!metric) return res.status(404).render('error', { user: req.user, message: 'Metric not found.' });
  db.prepare(`DELETE FROM isms_metrics WHERE id=?`).run(metric.id);
  logAction(req.user.id, req.workspace.id, 'remove_isms_metric', 'isms_metric', metric.id, null, auditCtx(req));
  res.redirect(withToast('/workspaces/' + req.workspace.id + '/metrics/adopted', 'Metric removed'));
});

// ==================== POLICY ADOPTION & REVIEW DASHBOARD ====================
// Closes the gap the auditor called out: "policies adopted but no dashboard
// showing what's published, what's draft, what's stale." Joins generated_docs
// with doc_templates.tier to surface mandatory-vs-recommended adoption.
app.get('/workspaces/:wsId/policy-adoption', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const wsId = req.workspace.id;
  const today = new Date().toISOString().slice(0, 10);
  const soonDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const staleCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  // All workspace docs joined with their source template tier (mandatory/expected/recommended).
  const docs = db.prepare(`SELECT d.id, d.name, d.category, d.status, d.version, d.created_at, d.updated_at,
      d.next_review_date,
      (SELECT name FROM users WHERE id = d.approved_by) AS approved_by_name,
      d.approved_at,
      COALESCE(t.tier, 'recommended') AS tier
    FROM generated_docs d
    LEFT JOIN doc_templates t ON t.id = d.template_id
    WHERE d.workspace_id = ?
    ORDER BY
      CASE COALESCE(t.tier, 'recommended')
        WHEN 'mandatory' THEN 1
        WHEN 'expected' THEN 2
        ELSE 3
      END,
      d.name`).all(wsId);

  // Decorate with review band: current / due_soon / overdue / never_reviewed
  const decorated = docs.map(d => {
    let reviewBand = 'unset';
    if (!d.next_review_date) reviewBand = 'unset';
    else if (d.next_review_date < today) reviewBand = 'overdue';
    else if (d.next_review_date < soonDate) reviewBand = 'due_soon';
    else reviewBand = 'current';
    const stale = d.updated_at && d.updated_at < staleCutoff && d.status === 'approved';
    return { ...d, reviewBand, stale };
  });

  // Mandatory coverage: for each mandatory template name pattern, do we have a workspace doc?
  // Just count templates with tier='mandatory' that have ZERO workspace docs.
  const mandatoryTemplates = db.prepare(`SELECT id, name FROM doc_templates WHERE tier='mandatory' AND is_system=1`).all();
  const adoptedTemplateIds = new Set(docs.filter(d => d.tier === 'mandatory').map(d => d.id));
  // Quicker version: per template, do we have any generated_doc?
  const templateAdoption = mandatoryTemplates.map(t => {
    const adopted = db.prepare(`SELECT id, status FROM generated_docs WHERE workspace_id=? AND template_id=? ORDER BY id LIMIT 1`).get(wsId, t.id);
    return { template_name: t.name, adopted: !!adopted, status: adopted ? adopted.status : null, doc_id: adopted ? adopted.id : null };
  });

  // KPIs
  const kpis = {
    total: decorated.length,
    mandatory: decorated.filter(d => d.tier === 'mandatory').length,
    expected: decorated.filter(d => d.tier === 'expected').length,
    recommended: decorated.filter(d => d.tier === 'recommended').length,
    draft: decorated.filter(d => d.status === 'draft').length,
    inReview: decorated.filter(d => d.status === 'in_review').length,
    approved: decorated.filter(d => d.status === 'approved').length,
    published: decorated.filter(d => d.status === 'published').length,
    retired: decorated.filter(d => d.status === 'retired').length,
    overdue: decorated.filter(d => d.reviewBand === 'overdue').length,
    dueSoon: decorated.filter(d => d.reviewBand === 'due_soon').length,
    noReviewDate: decorated.filter(d => d.reviewBand === 'unset').length,
    mandatoryAdopted: templateAdoption.filter(t => t.adopted).length,
    mandatoryTotal: templateAdoption.length,
    stale: decorated.filter(d => d.stale).length
  };
  kpis.mandatoryPct = kpis.mandatoryTotal ? Math.round((kpis.mandatoryAdopted / kpis.mandatoryTotal) * 100) : 0;

  res.render('policy_adoption', { user: req.user, ws: req.workspace, docs: decorated, kpis, templateAdoption, today });
});

// ==================== EVIDENCE COVERAGE MATRIX ====================
// For each Annex A control: what evidence types are EXPECTED (from the
// iso_items.evidence_to_look_for content) vs what's actually attached, and
// what's stale (>12 months old). This is the artefact an auditor builds in
// their head while walking your controls; here we pre-build it.
app.get('/workspaces/:wsId/evidence-coverage', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const wsId = req.workspace.id;
  const filter = req.query.filter || 'included'; // 'included' | 'all' | 'missing' | 'stale'
  const today = new Date().toISOString().slice(0, 10);
  const staleCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`SELECT i.id, i.title, i.category, i.type, i.evidence_to_look_for,
      COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability
    FROM iso_items i
    LEFT JOIN ${ctlReads.tables(db, wsId).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type='control'
    ORDER BY i.sort_order`).all(wsId);

  // For each control, count attached evidence (live, not superseded). Two link
  // paths: primary evidence.iso_item_id (core table, unchanged) + the join
  // table, which switches to evidence_requirement_links per the cutover flag.
  const evidenceByControl = evReads.coverageEvidenceByControl(db, wsId);

  // Build the matrix.
  const matrix = rows.map(r => {
    let expected = [];
    try { expected = JSON.parse(r.evidence_to_look_for || '[]') || []; } catch (_) {}
    const ev = evidenceByControl[r.id] || { attached: 0, last_uploaded_at: null };
    const expectedCount = expected.length;
    const attachedCount = ev.attached;
    const lastUp = ev.last_uploaded_at ? ev.last_uploaded_at.slice(0, 10) : null;
    const stale = lastUp && lastUp < staleCutoff;
    // Status: green (attached >= expected && not stale), amber (some attached but short or stale), red (none).
    let band = 'red';
    if (expectedCount === 0) band = attachedCount > 0 ? 'green' : 'gray';
    else if (attachedCount >= expectedCount && !stale) band = 'green';
    else if (attachedCount > 0) band = 'amber';
    return {
      id: r.id, title: r.title, category: r.category,
      status: r.status, applicability: r.applicability,
      expected, expectedCount, attachedCount, lastUp, stale, band
    };
  });

  // Apply filter
  let filtered = matrix;
  if (filter === 'included') filtered = matrix.filter(m => m.applicability === 'included');
  else if (filter === 'missing') filtered = matrix.filter(m => m.applicability === 'included' && m.attachedCount === 0);
  else if (filter === 'stale') filtered = matrix.filter(m => m.applicability === 'included' && m.stale);

  // Aggregate KPI
  const included = matrix.filter(m => m.applicability === 'included');
  const kpis = {
    included: included.length,
    fullyCovered: included.filter(m => m.band === 'green').length,
    partial: included.filter(m => m.band === 'amber').length,
    missing: included.filter(m => m.band === 'red').length,
    stale: included.filter(m => m.stale).length
  };
  kpis.coveragePct = included.length ? Math.round((kpis.fullyCovered / included.length) * 100) : 0;

  res.render('evidence_coverage', { user: req.user, ws: req.workspace, rows: filtered, kpis, filter, today });
});

// CSV export of the matrix
app.get('/workspaces/:wsId/evidence-coverage.csv', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const wsId = req.workspace.id;
  const staleCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT i.id, i.title, i.category, i.evidence_to_look_for,
      COALESCE(cs.applicability,'undecided') AS applicability
    FROM iso_items i
    LEFT JOIN ${ctlReads.tables(db, wsId).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type='control' ORDER BY i.sort_order`).all(wsId);
  const evidenceByControl = evReads.coverageEvidenceByControl(db, wsId);
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Code,Title,Category,Applicability,Expected count,Attached count,Last upload,Stale (>12mo),Status band'];
  for (const r of rows) {
    let expected = [];
    try { expected = JSON.parse(r.evidence_to_look_for || '[]') || []; } catch (_) {}
    const ev = evidenceByControl[r.id] || { attached: 0, last_uploaded_at: null };
    const lastUp = ev.last_uploaded_at ? ev.last_uploaded_at.slice(0, 10) : '';
    const stale = lastUp && lastUp < staleCutoff;
    const band = expected.length === 0 ? (ev.attached > 0 ? 'green' : 'gray')
                : (ev.attached >= expected.length && !stale) ? 'green'
                : ev.attached > 0 ? 'amber' : 'red';
    const code = r.id.replace('annex-','').toUpperCase();
    lines.push([code, r.title, r.category, r.applicability, expected.length, ev.attached, lastUp, stale ? 'yes' : '', band].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="evidence-coverage-${(new Date()).toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\n'));
});

// ==================== TRAINING TRACKER (Clause 7.3 / A.6.3) ====================
// Courses + per-person assignments. Schemas pre-existed; this just wires them.
app.get('/workspaces/:wsId/training', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const courses = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM training_records r WHERE r.workspace_id=c.workspace_id AND r.training_name=c.name) AS assigned_count,
      (SELECT COUNT(*) FROM training_records r WHERE r.workspace_id=c.workspace_id AND r.training_name=c.name AND r.status='completed') AS completed_count
    FROM training_courses c WHERE c.workspace_id=? ORDER BY c.name`).all(req.workspace.id);
  const records = db.prepare(`SELECT * FROM training_records WHERE workspace_id=? ORDER BY due_date IS NULL, due_date, user_name`).all(req.workspace.id);
  const today = (new Date()).toISOString().slice(0, 10);
  const stats = {
    total: records.length,
    completed: records.filter(r => r.status === 'completed').length,
    overdue: records.filter(r => r.status !== 'completed' && r.due_date && r.due_date < today).length,
    inflight: records.filter(r => r.status === 'assigned').length
  };
  stats.completionPct = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;
  res.render('training', { user: req.user, ws: req.workspace, courses, records, stats, today });
});

app.post('/workspaces/:wsId/training/courses', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { name, description, duration_minutes, validity_months, required_for_roles, content_url, passing_score } = req.body;
  if (!name) return res.redirect(`/workspaces/${req.workspace.id}/training`);
  db.prepare(`INSERT INTO training_courses (workspace_id, name, description, duration_minutes, validity_months,
    required_for_roles, content_url, has_quiz, passing_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, name.trim(), description || null,
         duration_minutes ? parseInt(duration_minutes, 10) : null,
         validity_months ? parseInt(validity_months, 10) : 12,
         required_for_roles || null, content_url || null,
         passing_score ? 1 : 0, passing_score ? parseInt(passing_score, 10) : null);
  logAction(req.user.id, req.workspace.id, 'add_training_course', 'training_course', null, { name }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/training`);
});

app.post('/workspaces/:wsId/training/courses/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM training_courses WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/training`);
});

app.post('/workspaces/:wsId/training/records', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { user_name, user_role, training_name, assigned_date, due_date } = req.body;
  if (!user_name || !training_name) return res.redirect(`/workspaces/${req.workspace.id}/training`);
  db.prepare(`INSERT INTO training_records (workspace_id, user_name, user_role, training_name, assigned_date, due_date, status)
    VALUES (?, ?, ?, ?, ?, ?, 'assigned')`)
    .run(req.workspace.id, user_name.trim(), user_role || null, training_name.trim(),
         assigned_date || null, due_date || null);
  logAction(req.user.id, req.workspace.id, 'assign_training', 'training_record', null, { user_name, training_name }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/training`);
});

app.post('/workspaces/:wsId/training/records/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { status, completed_date, score, notes } = req.body;
  db.prepare(`UPDATE training_records SET status=COALESCE(?,status), completed_date=COALESCE(?,completed_date),
    score=COALESCE(?,score), notes=COALESCE(?,notes) WHERE id=? AND workspace_id=?`)
    .run(status || null, completed_date || null, score || null, notes || null, req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/training`);
});

app.post('/workspaces/:wsId/training/records/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM training_records WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/training`);
});

// ==================== COMPETENCE MATRIX (Clause 7.2) ====================
app.get('/workspaces/:wsId/competence', requireAuth, requireWorkspace, requirePermission('members.view'), (req, res) => {
  const roles = db.prepare(`SELECT * FROM competence_roles WHERE workspace_id=? ORDER BY name`).all(req.workspace.id);
  const records = db.prepare(`SELECT cr.*, r.name AS role_name
    FROM competence_records cr INNER JOIN competence_roles r ON r.id=cr.role_id
    WHERE cr.workspace_id=? ORDER BY r.name, cr.person_name, cr.competence`).all(req.workspace.id);
  // Build matrix: people × competences per role
  const matrix = {};
  records.forEach(r => {
    const key = r.role_name;
    if (!matrix[key]) matrix[key] = {};
    if (!matrix[key][r.person_name]) matrix[key][r.person_name] = [];
    matrix[key][r.person_name].push(r);
  });
  const today = (new Date()).toISOString().slice(0, 10);
  const soon = (new Date(Date.now() + 90 * 86400000)).toISOString().slice(0, 10);
  const stats = {
    rolesCount: roles.length,
    recordsCount: records.length,
    expired: records.filter(r => r.expires_on && r.expires_on < today).length,
    expiringSoon: records.filter(r => r.expires_on && r.expires_on >= today && r.expires_on < soon).length
  };
  res.render('competence', { user: req.user, ws: req.workspace, roles, records, matrix, stats, today, soon });
});

app.post('/workspaces/:wsId/competence/roles', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { name, description, required_competences } = req.body;
  if (!name) return res.redirect(`/workspaces/${req.workspace.id}/competence`);
  db.prepare(`INSERT INTO competence_roles (workspace_id, name, description, required_competences) VALUES (?, ?, ?, ?)`)
    .run(req.workspace.id, name.trim(), description || null, required_competences || null);
  logAction(req.user.id, req.workspace.id, 'add_competence_role', 'competence_role', null, { name }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/competence`);
});

app.post('/workspaces/:wsId/competence/roles/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { name, description, required_competences } = req.body;
  db.prepare(`UPDATE competence_roles SET name=COALESCE(?,name), description=?, required_competences=? WHERE id=? AND workspace_id=?`)
    .run(name || null, description || null, required_competences || null, req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/competence`);
});

app.post('/workspaces/:wsId/competence/roles/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM competence_roles WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/competence`);
});

app.post('/workspaces/:wsId/competence/records', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { role_id, person_name, person_email, competence, evidence_type, evidence_ref, recorded_at, expires_on, notes } = req.body;
  if (!role_id || !person_name || !competence) return res.redirect(`/workspaces/${req.workspace.id}/competence`);
  // Sanity: the role must belong to this workspace.
  const role = db.prepare(`SELECT id FROM competence_roles WHERE id=? AND workspace_id=?`).get(role_id, req.workspace.id);
  if (!role) return res.redirect(`/workspaces/${req.workspace.id}/competence`);
  db.prepare(`INSERT INTO competence_records (workspace_id, role_id, person_name, person_email, competence, evidence_type, evidence_ref, recorded_at, expires_on, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, role_id, person_name.trim(), person_email || null, competence.trim(),
         evidence_type || null, evidence_ref || null, recorded_at || null, expires_on || null, notes || null);
  logAction(req.user.id, req.workspace.id, 'add_competence_record', 'competence_record', null, { role_id, person_name, competence }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/competence`);
});

app.post('/workspaces/:wsId/competence/records/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { evidence_type, evidence_ref, recorded_at, expires_on, notes } = req.body;
  db.prepare(`UPDATE competence_records SET evidence_type=?, evidence_ref=?, recorded_at=?, expires_on=?, notes=? WHERE id=? AND workspace_id=?`)
    .run(evidence_type || null, evidence_ref || null, recorded_at || null, expires_on || null, notes || null,
         req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/competence`);
});

app.post('/workspaces/:wsId/competence/records/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM competence_records WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/competence`);
});

// ==================== COMMUNICATION PLAN (Clause 7.4) ====================
app.get('/workspaces/:wsId/communication-plan', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const items = db.prepare(`SELECT * FROM communication_plan WHERE workspace_id=? ORDER BY next_due_date IS NULL, next_due_date, what`).all(req.workspace.id);
  const today = (new Date()).toISOString().slice(0, 10);
  const stats = {
    total: items.length,
    internal: items.filter(i => i.internal_external === 'internal').length,
    external: items.filter(i => i.internal_external === 'external').length,
    overdue: items.filter(i => i.next_due_date && i.next_due_date < today).length
  };
  res.render('communication_plan', { user: req.user, ws: req.workspace, items, stats, today });
});

app.post('/workspaces/:wsId/communication-plan', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { what, audience, channel, frequency, owner_name, internal_external, last_sent_date, next_due_date, trigger_event, notes } = req.body;
  if (!what) return res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
  db.prepare(`INSERT INTO communication_plan (workspace_id, what, audience, channel, frequency, owner_name, internal_external,
    last_sent_date, next_due_date, trigger_event, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, what.trim(), audience || null, channel || null, frequency || null,
         owner_name || null, internal_external || 'internal',
         last_sent_date || null, next_due_date || null, trigger_event || null, notes || null);
  logAction(req.user.id, req.workspace.id, 'add_communication_plan', 'communication_plan', null, { what }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
});

app.post('/workspaces/:wsId/communication-plan/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { what, audience, channel, frequency, owner_name, internal_external, last_sent_date, next_due_date, trigger_event, notes } = req.body;
  db.prepare(`UPDATE communication_plan SET what=COALESCE(?,what), audience=?, channel=?, frequency=?, owner_name=?,
    internal_external=COALESCE(?,internal_external), last_sent_date=?, next_due_date=?, trigger_event=?, notes=?
    WHERE id=? AND workspace_id=?`)
    .run(what || null, audience || null, channel || null, frequency || null, owner_name || null,
         internal_external || null, last_sent_date || null, next_due_date || null, trigger_event || null, notes || null,
         req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
});

app.post('/workspaces/:wsId/communication-plan/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM communication_plan WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/communication-plan`);
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
// Race-safe: MAX(version) → INSERT → UPDATE current_version_id all run in
// one transaction so two consultants clicking "Submit for review" at the
// same time can't end up with two version=N rows (which the UNIQUE
// (document_id, version) constraint would catch as an unhandled 500).
// On a constraint collision (the other transaction beat us), retry once;
// after the second failure surface a clean error rather than a 500.
function snapshotDocVersion(docId, wsId, status, userId, summary) {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(docId, wsId);
  if (!doc) return null;
  const decryptedContent = enc.decryptIfNeeded(doc.content, wsId);
  const hash = enc.sha256(decryptedContent || '');
  const encryptedContent = enc.encryptIfNeeded(decryptedContent, wsId, true);

  const attempt = () => {
    return db.transaction(() => {
      const next = (db.prepare('SELECT MAX(version) AS v FROM doc_versions WHERE document_id=?').get(docId).v || 0) + 1;
      const id = db.prepare(`INSERT INTO doc_versions (workspace_id, document_id, version, name, content, content_hash, status, change_summary, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        wsId, docId, next, doc.name, encryptedContent,
        hash, status || 'draft', summary || null, userId
      ).lastInsertRowid;
      db.prepare(`UPDATE generated_docs SET current_version_id=?, version=? WHERE id=?`).run(id, next, docId);
      return { id, version: next, hash, content: decryptedContent };
    })();
  };

  try { return attempt(); }
  catch (e) {
    if (e && e.code && e.code.startsWith('SQLITE_CONSTRAINT')) {
      // Concurrent snapshot won the version=N slot. Re-read MAX and retry
      // once — almost always succeeds because the colliding transaction has
      // committed by now.
      try { return attempt(); }
      catch (e2) {
        const wrapped = new Error('Could not save document version — another consultant submitted at the same time. Refresh and try again.');
        wrapped.cause = e2; wrapped.code = 'DOC_VERSION_CONFLICT';
        throw wrapped;
      }
    }
    throw e;
  }
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
      issues.push(`Signature ${s.id} (${s.user_name}): content hash mismatch - version may have been altered after signing.`);
      continue;
    }
    const payload = `${s.document_id}|${s.version_id}|${s.user_id}|${s.content_hash}|${s.intent}|${s.signed_at}`;
    if (!enc.verifyHmac(payload, wsId, s.signature)) {
      issues.push(`Signature ${s.id} (${s.user_name}): HMAC verification failed - signature is not authentic.`);
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

// Submit current draft for review - snapshots a new version, sets approver chain.
// The chain can mix internal (user-account) approvers and external (magic-link)
// approvers. Form sends approvers_json containing the ordered chain.
app.post('/workspaces/:wsId/documents/:id/submit-review', requireAuth, requireWorkspace, requirePermission('document.submit_review'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc) return redirectBack(req, res);
  if (doc.locked) return res.status(400).render('error', { user: req.user, message: 'Document is locked. Create a new version first.' });

  let chain;
  try {
    chain = JSON.parse(req.body.approvers_json || '[]');
  } catch (_) {
    return res.status(400).render('error', { user: req.user, message: 'Could not parse approver chain. Try resubmitting from the form.' });
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    return res.status(400).render('error', { user: req.user, message: 'Add at least one approver before submitting for review.' });
  }
  // Validate each row
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (r.kind === 'internal') {
      if (!r.user_id || isNaN(parseInt(r.user_id, 10))) {
        return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: pick a user.` });
      }
    } else if (r.kind === 'external') {
      if (!r.name || !r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
        return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: name and a valid email are required for magic-link approvers.` });
      }
    } else {
      return res.status(400).render('error', { user: req.user, message: `Approver #${i + 1}: unknown kind "${r.kind}".` });
    }
  }

  const summary = req.body.change_summary || null;
  let v;
  try {
    v = snapshotDocVersion(doc.id, req.workspace.id, 'in_review', req.user.id, summary);
  } catch (e) {
    if (e && e.code === 'DOC_VERSION_CONFLICT') {
      return res.status(409).render('error', { user: req.user,
        message: 'Another consultant submitted this document for review at the same time. Open the document, review the new version, and decide whether to add another reviewer.' });
    }
    throw e;
  }
  db.prepare(`UPDATE generated_docs SET status='in_review', locked=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
  db.prepare(`UPDATE doc_versions SET submitted_at=CURRENT_TIMESTAMP WHERE id=?`).run(v.id);

  const insInternal = db.prepare(`INSERT INTO doc_approvers (workspace_id, document_id, version_id, sequence, user_id, role_label, notified_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  const insExternal = db.prepare(`INSERT INTO external_approvers
    (workspace_id, document_id, version_id, sequence, email, name, role_label, token_hash, expires_at, notified_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`);

  // Per-row token storage - we keep the raw tokens in memory just long
  // enough to send the emails after the transaction commits. They're
  // never written to the DB in raw form.
  const rawTokens = {};
  const tx = db.transaction(() => {
    chain.forEach((r, idx) => {
      const seq = idx + 1;
      if (r.kind === 'internal') {
        insInternal.run(req.workspace.id, doc.id, v.id, seq, parseInt(r.user_id, 10), r.role || null);
      } else {
        const token = docApprovals.generateToken();
        const hash = docApprovals.hashToken(token);
        const expires = docApprovals.expiryFromNow();
        insExternal.run(req.workspace.id, doc.id, v.id, seq, r.email.trim(), r.name.trim(), r.role || null, hash, expires, req.user.id);
        rawTokens[seq] = token;
      }
    });
  });
  tx();

  logAction(req.user.id, req.workspace.id, 'submit_for_review', 'document', doc.id,
    { version: v.version, approvers: chain.length, internal: chain.filter(c => c.kind === 'internal').length, external: chain.filter(c => c.kind === 'external').length, summary }, auditCtx(req));

  // Notify only the first approver in sequence (the one whose turn it
  // is right now); later approvers get nudged as the chain advances in
  // the /decide and /approve routes. Internal approvers get a "view
  // document" link; external approvers get the magic-link URL.
  try {
    const merged = docApprovals.listChain(db, v.id);
    const wsName = req.workspace.client_name;
    const submitter = req.user.name;
    const docUrl = `${email.appBaseUrl()}/workspaces/${req.workspace.id}/documents/${doc.id}`;
    const total = merged.length;

    merged.forEach((row, idx) => {
      const isFirst = idx === 0;
      if (row.kind === 'internal') {
        if (!row.person_email) return;
        const intro = isFirst
          ? `${submitter} has submitted "${doc.name}" (v${v.version}) for your approval in the ${wsName} workspace.`
          : `${submitter} has submitted "${doc.name}" (v${v.version}) for approval in the ${wsName} workspace. You are approver #${idx + 1} - you'll be able to decide once the earlier approvers have signed off.`;
        const bodyHtml = `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border:1px solid #ececef;border-radius:6px;">
            <tr><td style="padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">
              <div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#9c9ca5;margin-bottom:6px;">Document</div>
              <div style="font-size:15px;font-weight:600;color:#0a0a0a;margin-bottom:10px;">${email.escapeHtml(doc.name)} <span style="color:#9c9ca5;font-weight:400;">· v${v.version}</span></div>
              ${summary ? `<div style="font-size:13px;line-height:1.5;color:#51525c;border-left:2px solid #5C0A0A;padding-left:10px;">${email.escapeHtml(summary)}</div>` : ''}
            </td></tr>
          </table>`;
        email.sendEmail({
          to: row.person_email,
          subject: `[${wsName}] Approval requested: ${doc.name} (v${v.version})`,
          html: email.renderEmailLayout({
            headline: isFirst ? 'A document needs your approval' : 'You are in the approval queue',
            intro, bodyHtml,
            ctaText: isFirst ? 'Review and approve' : 'View document',
            ctaUrl: docUrl,
            footnote: `You're receiving this because you were named as an approver on this document. Decisions are recorded with your signature and the workspace audit log.`,
            fromName: wsName
          }),
          firmId: req.workspace.firm_id, workspaceId: req.workspace.id,
          relatedType: 'doc_approval_request', relatedId: doc.id
        }).catch(err => console.error('[email] internal-approver send failed:', err.message));
      } else {
        // External - send the magic link only on the first approver's
        // turn. Later external approvers get nudged when their turn
        // arrives so the token doesn't sit in their inbox unused.
        if (!isFirst) return;
        const expiresAt = db.prepare('SELECT expires_at FROM external_approvers WHERE id=?').get(row.id).expires_at;
        email.sendMagicLinkApprovalEmail({
          toEmail: row.person_email, toName: row.person_name,
          docName: doc.name, docVersion: v.version,
          workspaceName: wsName, workspaceId: req.workspace.id, firmId: req.workspace.firm_id,
          submitterName: submitter, token: rawTokens[row.sequence],
          sequence: row.sequence, totalApprovers: total, roleLabel: row.role_label,
          expiresAt, changeSummary: summary, relatedDocId: doc.id
        }).catch(err => console.error('[email] external-approver send failed:', err.message));
      }
    });
  } catch (e) {
    console.error('[email] approval-request batch failed:', e.message);
  }

  res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, 'Submitted for review'));
});

// Approver makes a decision (approve / reject) on the current version.
// Shared post-decision helpers - called from both the internal decide
// route (POST /workspaces/.../decide) and the external token route
// (POST /approve/:token). Keep these here so server.js owns the
// chain-advance + completion side-effects in one place.

function notifyChainAdvanced(versionId, doc, workspace, decidedByDisplay) {
  const next = docApprovals.nextPending(db, versionId);
  if (!next) return; // chain complete - completion handler runs separately
  const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
  const wsName = workspace.client_name;
  const docUrl = `${email.appBaseUrl()}/workspaces/${workspace.id}/documents/${doc.id}`;

  if (next.kind === 'internal') {
    if (!next.row.person_email) return;
    const bodyHtml = `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${email.escapeHtml(decidedByDisplay)} has signed off. "${email.escapeHtml(doc.name)}" (v${version.version}) is now waiting on your decision as approver #${next.row.sequence}${next.row.role_label ? ` (${email.escapeHtml(next.row.role_label)})` : ''}.</p>`;
    email.sendEmail({
      to: next.row.person_email,
      subject: `[${wsName}] Your turn to approve: ${doc.name} (v${version.version})`,
      html: email.renderEmailLayout({
        headline: 'A document is waiting on you',
        bodyHtml, ctaText: 'Review and approve', ctaUrl: docUrl, fromName: wsName
      }),
      firmId: workspace.firm_id, workspaceId: workspace.id,
      relatedType: 'doc_approval_request', relatedId: doc.id
    }).catch(err => console.error('[email] next-internal notify failed:', err.message));
  } else {
    // External next - rotate the token (the old one was either never
    // delivered or has been sitting in their inbox for days) and send
    // a fresh magic link. Old hash is overwritten so the previous URL
    // immediately becomes invalid.
    const token = docApprovals.generateToken();
    const hash = docApprovals.hashToken(token);
    const expires = docApprovals.expiryFromNow();
    db.prepare(`UPDATE external_approvers SET token_hash=?, expires_at=?, notified_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(hash, expires, next.row.id);
    const totalApprovers = docApprovals.listChain(db, versionId).length;
    email.sendMagicLinkApprovalEmail({
      toEmail: next.row.person_email, toName: next.row.person_name,
      docName: doc.name, docVersion: version.version,
      workspaceName: wsName, workspaceId: workspace.id, firmId: workspace.firm_id,
      submitterName: decidedByDisplay, token,
      sequence: next.row.sequence, totalApprovers, roleLabel: next.row.role_label,
      expiresAt: expires, changeSummary: version.change_summary, relatedDocId: doc.id
    }).catch(err => console.error('[email] next-external notify failed:', err.message));
  }
}

function notifyChainComplete(versionId, doc, workspace, decidedByDisplay) {
  const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
  const submitter = version ? db.prepare('SELECT id, name, email FROM users WHERE id=?').get(version.created_by) : null;
  if (!submitter || !submitter.email) return;
  const wsName = workspace.client_name;
  const docUrl = `${email.appBaseUrl()}/workspaces/${workspace.id}/documents/${doc.id}`;
  const chain = docApprovals.listChain(db, versionId);
  const listRows = chain.map(a =>
    `<li style="margin-bottom:4px;">${email.escapeHtml(a.person_name)}${a.role_label ? ` <span style="color:#9c9ca5;">(${email.escapeHtml(a.role_label)})</span>` : ''}${a.kind === 'external' ? ` <span style="color:#9c9ca5;">· external</span>` : ''}</li>`
  ).join('');
  const bodyHtml = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">All approvers have signed off on v${version.version} of "${email.escapeHtml(doc.name)}". The document is now locked as <strong>approved</strong> and ready for publication.</p>
    <div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#9c9ca5;margin:16px 0 6px;">Approval chain</div>
    <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${listRows}</ul>`;
  email.sendEmail({
    to: submitter.email,
    subject: `[${wsName}] Approved: ${doc.name} (v${version.version})`,
    html: email.renderEmailLayout({
      headline: 'Your document has been approved',
      bodyHtml, ctaText: 'Publish document', ctaUrl: docUrl, fromName: wsName
    }),
    firmId: workspace.firm_id, workspaceId: workspace.id,
    relatedType: 'doc_approval_decision', relatedId: doc.id
  }).catch(err => console.error('[email] approval-complete notify failed:', err.message));
}

function notifyRejection(versionId, doc, workspace, rejectorDisplay, reason) {
  const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(versionId);
  const submitter = version ? db.prepare('SELECT id, name, email FROM users WHERE id=?').get(version.created_by) : null;
  if (!submitter || !submitter.email) return;
  const wsName = workspace.client_name;
  const docUrl = `${email.appBaseUrl()}/workspaces/${workspace.id}/documents/${doc.id}`;
  const bodyHtml = `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>${email.escapeHtml(rejectorDisplay)}</strong> rejected v${version.version} of "${email.escapeHtml(doc.name)}".</p>
    ${reason ? `<div style="margin:12px 0;padding:12px 14px;background:#fafafa;border-left:2px solid #5C0A0A;font-size:13px;line-height:1.5;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>Reason:</strong> ${email.escapeHtml(reason)}</div>` : ''}
    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">The document is back in draft so you can address the feedback and resubmit.</p>`;
  email.sendEmail({
    to: submitter.email,
    subject: `[${wsName}] Rejected: ${doc.name} (v${version.version})`,
    html: email.renderEmailLayout({
      headline: 'Your document was rejected',
      bodyHtml, ctaText: 'Open document', ctaUrl: docUrl, fromName: wsName
    }),
    firmId: workspace.firm_id, workspaceId: workspace.id,
    relatedType: 'doc_approval_decision', relatedId: doc.id
  }).catch(err => console.error('[email] reject-notify failed:', err.message));
}

// Mark the version + document as approved (called from both decide
// routes when countPending hits zero). Keep this side-effect in one
// place so we can't drift between the internal and external paths.
//
// CAS on doc_versions.status: only the first call whose UPDATE matches
// status='in_review' succeeds. Returns true if this call was the one that
// finalised, false if another concurrent decision beat us. Callers should
// only fire chain-complete notifications / log entries when this returns
// true, otherwise two simultaneous final approvers double-send the emails
// and double-log "approve_document".
function finaliseApprovedDocument(versionId, doc, workspaceId, byUserId) {
  const r = db.prepare(`UPDATE doc_versions SET status='approved', approved_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='in_review'`).run(versionId);
  if (r.changes === 0) return false;
  db.prepare(`UPDATE generated_docs SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, locked=1 WHERE id=?`)
    .run(byUserId, doc.id);
  return true;
}

function finaliseRejectedDocument(versionId, doc) {
  const r = db.prepare(`UPDATE doc_versions SET status='rejected'
    WHERE id=? AND status='in_review'`).run(versionId);
  if (r.changes === 0) return false;
  db.prepare(`UPDATE generated_docs SET status='draft', locked=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(doc.id);
  return true;
}

app.post('/workspaces/:wsId/documents/:id/decide', requireAuth, requireWorkspace, requirePermission('document.review'), (req, res) => {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!doc || !doc.current_version_id) return redirectBack(req, res);
  const { decision, reason } = req.body;
  if (!['approve','reject'].includes(decision)) return redirectBack(req, res);

  // The logged-in user must be the next pending approver (mixed-chain
  // aware - they have to be at the front of the merged queue, not just
  // the front of the internal queue).
  const myRow = db.prepare(
    `SELECT * FROM doc_approvers WHERE version_id=? AND user_id=? AND decision IS NULL ORDER BY sequence LIMIT 1`
  ).get(doc.current_version_id, req.user.id);
  if (!myRow) return res.status(403).render('error', { user: req.user, message: 'You are not a pending approver on this version.' });
  const upNext = docApprovals.nextPending(db, doc.current_version_id);
  if (!upNext || upNext.kind !== 'internal' || upNext.row.id !== myRow.id) {
    return res.status(400).render('error', { user: req.user, message: `Approver #${upNext ? upNext.row.sequence : '?'} must decide first.` });
  }

  // CAS the decision so re-submits (browser double-click, network retry)
  // and concurrent decisions can't double-write. If 0 rows changed, someone
  // else (or the user themselves) already decided on this row.
  const decResult = db.prepare(`UPDATE doc_approvers
    SET decision=?, decision_reason=?, decided_at=CURRENT_TIMESTAMP
    WHERE id=? AND decision IS NULL`)
    .run(decision === 'approve' ? 'approved' : 'rejected', reason || null, myRow.id);
  if (decResult.changes === 0) {
    return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id,
      'Your decision was already recorded.', 'info'));
  }

  if (decision === 'reject') {
    // finaliseRejectedDocument CAS-flips doc_versions.status from in_review
    // to rejected. Only the first caller succeeds; the rest get false and
    // skip the duplicate notification/log emission.
    if (finaliseRejectedDocument(doc.current_version_id, doc)) {
      logAction(req.user.id, req.workspace.id, 'reject_document', 'document', doc.id,
        { version_id: doc.current_version_id, reason }, auditCtx(req));
      notifyRejection(doc.current_version_id, doc, req.workspace, req.user.name, reason);
    }
    return res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, 'Document rejected', 'error'));
  }

  if (docApprovals.countPending(db, doc.current_version_id) === 0) {
    // Two simultaneous final approvers could both see pending=0 here. Only
    // the one whose finaliseApprovedDocument CAS succeeds fires the
    // chain-complete side effects (email, audit log). The loser silently
    // returns and the user sees a regular success page.
    if (finaliseApprovedDocument(doc.current_version_id, doc, req.workspace.id, req.user.id)) {
      logAction(req.user.id, req.workspace.id, 'approve_document', 'document', doc.id, { version_id: doc.current_version_id }, auditCtx(req));
      notifyChainComplete(doc.current_version_id, doc, req.workspace, req.user.name);
    }
  } else {
    logAction(req.user.id, req.workspace.id, 'partial_approve_document', 'document', doc.id,
      { version_id: doc.current_version_id, remaining: docApprovals.countPending(db, doc.current_version_id) }, auditCtx(req));
    notifyChainAdvanced(doc.current_version_id, doc, req.workspace, req.user.name);
  }
  res.redirect('/workspaces/' + req.workspace.id + '/documents/' + doc.id);
});

// ==================== MAGIC-LINK APPROVAL PORTAL ====================
// External approver clicks the link in their email -> arrives here.
// No auth; the token IS the credential. Token is in the URL, not stored
// raw in the DB; we look up by SHA-256 hash. All decisions audit-log
// via the external sentinel user (id=0) which resolves to
// external@isms.local in the activity stream.

app.get('/approve/:token', (req, res) => {
  const row = docApprovals.findByToken(db, req.params.token);
  if (!row) {
    return res.status(404).render('approve_error', {
      title: 'Approval link not found',
      message: 'This approval link is not valid. It may have been revoked or replaced. Ask the person who sent it to issue a new one.'
    });
  }
  if (row.effective_status === 'revoked') {
    return res.status(410).render('approve_error', {
      title: 'Approval link revoked',
      message: 'This approval link has been revoked by the workspace owner. Ask them to re-issue if you still need to decide.'
    });
  }
  if (row.effective_status === 'expired') {
    return res.status(410).render('approve_error', {
      title: 'Approval link expired',
      message: 'This approval link expired on ' + new Date(row.expires_at).toLocaleDateString() + '. Ask the sender to issue a new one.'
    });
  }
  if (row.decision) {
    return res.status(410).render('approve_error', {
      title: 'Already decided',
      message: 'You already ' + row.decision + ' this document on ' + new Date(row.decided_at + 'Z').toLocaleString() + '. The decision is recorded; the link is no longer active.'
    });
  }
  // Verify it's actually their turn before showing the approve form.
  // (If not, render a "waiting on earlier approver" state instead.)
  const myTurn = docApprovals.isExternalRowMyTurn(db, row);
  const chain = docApprovals.listChain(db, row.version_id);

  // Document body may be stored as markdown or HTML; render markdown
  // -> HTML so the view can drop it in with <%- %>. Decrypt first if
  // the workspace has encryption enabled.
  let bodyRaw = row.content;
  try { bodyRaw = enc.decryptIfNeeded(bodyRaw, row.workspace_id); } catch (_) {}
  const bodyHtml = looksLikeMarkdown(bodyRaw) ? mdRenderer.render(bodyRaw) : bodyRaw;

  res.render('approve', {
    row, chain, myTurn,
    workspaceName: row.workspace_name,
    docName: row.doc_name,
    docVersion: row.version,
    docContent: bodyHtml,
    submitterName: row.submitter_name,
    brandColor: row.brand_primary_color || '#5C0A0A',
    token: req.params.token,
    csrfToken: '' // route is CSRF-skipped (token is the credential)
  });
});

app.post('/approve/:token', (req, res) => {
  const row = docApprovals.findByToken(db, req.params.token);
  if (!row || row.effective_status !== 'pending') {
    return res.status(410).render('approve_error', {
      title: 'Link no longer active',
      message: 'This approval link is no longer valid (expired, revoked, or already decided).'
    });
  }
  const { decision, reason } = req.body;
  if (!['approve','reject'].includes(decision)) {
    return res.status(400).render('approve_error', { title: 'Bad request', message: 'Pick approve or reject.' });
  }
  if (!docApprovals.isExternalRowMyTurn(db, row)) {
    return res.status(400).render('approve_error', {
      title: 'Not your turn yet',
      message: 'An earlier approver in the chain has not decided yet. You will be able to approve once they do.'
    });
  }

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  const ua = (req.get('user-agent') || '').slice(0, 500) || null;
  const decisionVal = decision === 'approve' ? 'approved' : 'rejected';

  // CAS: only the first attempt that finds decision IS NULL writes. Defends
  // against double-clicks on the approve button (browser/network retries
  // re-POSTing the same token) and against the rare case where two browser
  // tabs of the same magic link decide simultaneously.
  const decResult = db.prepare(`UPDATE external_approvers
    SET decision=?, decision_reason=?, decided_at=CURRENT_TIMESTAMP, ip_address=?, user_agent=?
    WHERE id=? AND decision IS NULL`).run(decisionVal, reason || null, ip, ua, row.id);
  if (decResult.changes === 0) {
    return res.status(410).render('approve_error', {
      title: 'Already decided',
      message: 'This approval was already recorded. Nothing further to do.'
    });
  }

  // Capture a signature row for parity with internal approvers - same
  // table, HMAC-signed, name shows as the external approver's display
  // name. user_id has a FK to users; we resolve to the external@isms.local
  // sentinel that logAction creates on demand. Re-using the same sentinel
  // means the audit pack groups all external activity under one synthetic
  // user instead of leaving orphan rows.
  try {
    let extUser = db.prepare(`SELECT id FROM users WHERE email='external@isms.local'`).get();
    if (!extUser) {
      const uid = db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active)
                              VALUES ('external@isms.local','!external','External signer','client',0)`).run().lastInsertRowid;
      extUser = { id: uid };
    }
    const ts = new Date().toISOString();
    // Payload format must mirror verifyVersionSignatures() above, which
    // reads back ${s.document_id}|${s.version_id}|${s.user_id}|... -
    // use extUser.id (the sentinel's int) as the third slot, not the
    // external_approvers row id. Mismatch here corrupts the HMAC and
    // every doc page renders a SIGNATURE INTEGRITY WARNING for what
    // is in fact a legitimate approval.
    const payload = `${row.doc_id}|${row.version_id}|${extUser.id}|${row.content_hash}|${decisionVal}|${ts}`;
    const sig = enc.signHmac(payload, row.workspace_id);
    db.prepare(`INSERT INTO doc_signatures (workspace_id, document_id, version_id, user_id, user_name, signature_role, intent, content_hash, signature, ip_address, user_agent, signed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.workspace_id, row.doc_id, row.version_id, extUser.id,
      `${row.name} (external)`,
      row.role_label || null, decisionVal, row.content_hash, sig,
      ip, ua, ts
    );
  } catch (e) { console.error('[approve] signature insert failed:', e.message); }

  logAction(0, row.workspace_id, decisionVal === 'approved' ? 'external_approve_document' : 'external_reject_document',
    'document', row.doc_id, { version_id: row.version_id, external_approver: row.name, email: row.email, reason: reason || null },
    { ip, userAgent: ua });

  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=?').get(row.doc_id);
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(row.workspace_id);
  const display = `${row.name} (external)`;

  if (decision === 'reject') {
    if (finaliseRejectedDocument(row.version_id, doc)) {
      notifyRejection(row.version_id, doc, workspace, display, reason);
    }
  } else if (docApprovals.countPending(db, row.version_id) === 0) {
    // No internal user is "responsible" - record approved_by as the
    // version's submitter so the audit trail attributes the lock-down
    // to the human who initiated review, not user 0.
    // CAS via finaliseApprovedDocument: only the first finaliser fires
    // the chain-complete notification.
    const version = db.prepare('SELECT created_by FROM doc_versions WHERE id=?').get(row.version_id);
    if (finaliseApprovedDocument(row.version_id, doc, row.workspace_id, version ? version.created_by : 0)) {
      notifyChainComplete(row.version_id, doc, workspace, display);
    }
  } else {
    notifyChainAdvanced(row.version_id, doc, workspace, display);
  }

  res.render('approve_done', {
    decision: decisionVal,
    docName: row.doc_name,
    docVersion: row.version,
    workspaceName: row.workspace_name,
    brandColor: row.brand_primary_color || '#5C0A0A',
    approverName: row.name
  });
});

// Resend a magic link to an external approver. Rotates the token so
// the previous link (if it's lying in the wrong inbox or a forgotten
// browser tab) immediately stops working. Only the submitter / firm
// can trigger this from the doc detail page.
app.post('/workspaces/:wsId/documents/:id/external-approvers/:eaId/resend',
  requireAuth, requireWorkspace, requirePermission('document.submit_review'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    const ea = db.prepare('SELECT * FROM external_approvers WHERE id=? AND workspace_id=? AND document_id=?').get(req.params.eaId, req.workspace.id, doc.id);
    if (!ea) return redirectBack(req, res);
    if (ea.decision) return res.status(400).render('error', { user: req.user, message: 'Approver has already decided - nothing to resend.' });
    if (ea.revoked_at) return res.status(400).render('error', { user: req.user, message: 'Approver was revoked. Unrevoke is not supported - add them again as a new approver instead.' });

    const token = docApprovals.generateToken();
    const hash = docApprovals.hashToken(token);
    const expires = docApprovals.expiryFromNow();
    db.prepare(`UPDATE external_approvers SET token_hash=?, expires_at=?, notified_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(hash, expires, ea.id);

    const version = db.prepare('SELECT * FROM doc_versions WHERE id=?').get(ea.version_id);
    const totalApprovers = docApprovals.listChain(db, ea.version_id).length;
    email.sendMagicLinkApprovalEmail({
      toEmail: ea.email, toName: ea.name,
      docName: doc.name, docVersion: version.version,
      workspaceName: req.workspace.client_name, workspaceId: req.workspace.id, firmId: req.workspace.firm_id,
      submitterName: req.user.name, token,
      sequence: ea.sequence, totalApprovers, roleLabel: ea.role_label,
      expiresAt: expires, changeSummary: version.change_summary, relatedDocId: doc.id
    }).catch(err => console.error('[email] resend magic link failed:', err.message));

    logAction(req.user.id, req.workspace.id, 'resend_external_approver_link', 'document', doc.id,
      { external_approver_id: ea.id, email: ea.email }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, `Magic link resent to ${ea.email}`));
  });

// Revoke a pending external approver. Sets revoked_at; the next /approve
// request with that (now-irrelevant) token will see effective_status =
// 'revoked' and render an error. Does not remove the row - audit trail
// requires we keep the history of who was invited.
app.post('/workspaces/:wsId/documents/:id/external-approvers/:eaId/revoke',
  requireAuth, requireWorkspace, requirePermission('document.submit_review'), (req, res) => {
    const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
    if (!doc) return redirectBack(req, res);
    const ea = db.prepare('SELECT * FROM external_approvers WHERE id=? AND workspace_id=? AND document_id=?').get(req.params.eaId, req.workspace.id, doc.id);
    if (!ea) return redirectBack(req, res);
    if (ea.decision) return res.status(400).render('error', { user: req.user, message: 'Approver has already decided - cannot revoke.' });
    if (ea.revoked_at) return redirectBack(req, res);

    db.prepare(`UPDATE external_approvers SET revoked_at=CURRENT_TIMESTAMP WHERE id=?`).run(ea.id);
    logAction(req.user.id, req.workspace.id, 'revoke_external_approver', 'document', doc.id,
      { external_approver_id: ea.id, email: ea.email }, auditCtx(req));
    res.redirect(withToast('/workspaces/' + req.workspace.id + '/documents/' + doc.id, `Revoked ${ea.email} - link no longer works`));
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

// Reopen for editing - creates a new draft version branched off current.
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
// ==================== REVIEW QUEUE ====================
// Cross-framework list of assessment items flagged for senior review. Two
// tabs aren't worth it - one list with a framework column is faster to scan.
app.get('/workspaces/:wsId/review-queue', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const filter = req.query.filter || 'open'; // 'open' = requested + needs_changes; 'all' = everything non-none
  const wsId = req.workspace.id;

  const iso27 = db.prepare(`SELECT cs.iso_item_id AS item_id, i.title, cs.review_status, cs.review_requested_at,
      cs.reviewed_at, cs.review_reason,
      ru.name AS requested_by_name, rv.name AS reviewed_by_name
    FROM control_states cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    LEFT JOIN users ru ON ru.id = cs.review_requested_by
    LEFT JOIN users rv ON rv.id = cs.reviewed_by
    WHERE cs.workspace_id=? AND cs.review_status != 'none'
    ORDER BY cs.review_requested_at DESC`).all(wsId).map(r => ({ ...r, framework: 'iso27001', link: `/workspaces/${wsId}/controls/assess/${r.item_id}` }));

  const iso42 = db.prepare(`SELECT cs.iso_item_id AS item_id, i.title, cs.review_status, cs.review_requested_at,
      cs.reviewed_at, cs.review_reason,
      ru.name AS requested_by_name, rv.name AS reviewed_by_name
    FROM iso42001_control_states cs
    INNER JOIN iso42001_items i ON i.id = cs.iso_item_id
    LEFT JOIN users ru ON ru.id = cs.review_requested_by
    LEFT JOIN users rv ON rv.id = cs.reviewed_by
    WHERE cs.workspace_id=? AND cs.review_status != 'none'
    ORDER BY cs.review_requested_at DESC`).all(wsId).map(r => ({ ...r, framework: 'iso42001', link: `/workspaces/${wsId}/iso42001/gap/${r.item_id}` }));

  let all = [...iso27, ...iso42];
  if (filter === 'open') all = all.filter(r => ['requested','needs_changes'].includes(r.review_status));
  all.sort((a, b) => (b.review_requested_at || '').localeCompare(a.review_requested_at || ''));
  const counts = {
    requested: [...iso27, ...iso42].filter(r => r.review_status === 'requested').length,
    needs_changes: [...iso27, ...iso42].filter(r => r.review_status === 'needs_changes').length,
    reviewed: [...iso27, ...iso42].filter(r => r.review_status === 'reviewed').length
  };
  res.render('review_queue', { user: req.user, ws: req.workspace, rows: all, filter, counts });
});

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
// Tier B.5/B.6 - Surface actionable items derived from current workspace state.
// Used by /notifications (the inbox) and on the overview's "Needs attention"
// panel. Computed on-demand from live data - no cron required.
// "What should I do next?" engine. Reads engagement state and returns the
// single highest-leverage action - the one a junior consultant should
// click on the workspace overview right now. The order below is the order a
// real engagement should run; the first applicable item wins.
//
// Returns { title, why, cta, href, kind } or null if nothing to suggest.
function computeNextStep(ws) {
  const wsId = ws.id;
  const cnt = (sql, ...p) => db.prepare(sql).get(wsId, ...p).c;

  // 1. No intake answered yet → start there. Anchors clause 4.3.
  const intakeCount = cnt(`SELECT COUNT(*) c FROM engagement_intake WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer)) > 0`);
  if (intakeCount === 0) {
    return {
      kind: 'intake', title: 'Start the client setup',
      why: 'A 25-question scoping questionnaire that auto-drafts the clause 4.3 scope statement. Captures the business context, scope, and crown-jewel assets so the rest of the engagement has something to anchor against.',
      cta: 'Open setup', href: `/workspaces/${wsId}/intake`,
    };
  }
  if (intakeCount < 8) {
    return {
      kind: 'intake-partial', title: `Finish the client setup (${intakeCount}/25 answered)`,
      why: 'Get to at least the business-context + scope sections before the kickoff workshop.',
      cta: 'Continue setup', href: `/workspaces/${wsId}/intake`,
    };
  }

  // 2. Intake answered but scope not pushed to workspace yet.
  if (intakeCount >= 8 && (!ws.scope || ws.scope.length < 20)) {
    return {
      kind: 'apply-intake', title: 'Save the client setup to publish the scope',
      why: 'Pushes the auto-drafted clause 4.3 scope statement onto the client. Open setup, click Save & refresh summary.',
      cta: 'Open setup', href: `/workspaces/${wsId}/intake`,
    };
  }

  // 2a. Scope drafted but not confirmed yet - the explicit sign-off
  // that the engagement is ready to start. Sits between setup and gap
  // assessment so the consultant has one clear "we're starting now"
  // moment with the client.
  if (intakeCount >= 8 && !ws.scope_confirmed_at) {
    return {
      kind: 'confirm-scope', title: 'Confirm scope before gap assessment',
      why: 'Sign off on the clause 4.3 scope statement. Setup -> Confirm scope.',
      cta: 'Review & confirm', href: `/workspaces/${wsId}/intake`,
    };
  }

  // 3. Gap assessment - the diagnostic that surfaces current state vs
  // the standard. Comes BEFORE the asset + risk registers because:
  //   - You can't risk-assess what you don't understand
  //   - Gap walking the 118 items establishes which areas need depth
  //   - Findings inform what the asset and risk registers should cover
  // (Earlier ordering put assets/risks first, which is theoretically
  // closer to the standard's text but worked badly in practice - the
  // consultant ended up risk-assessing in a vacuum.)
  const activePass = db.prepare(`SELECT id, pass_number FROM assessment_passes WHERE workspace_id=? AND status='in_progress' ORDER BY pass_number DESC LIMIT 1`).get(wsId);
  const lastPass = db.prepare(`SELECT id FROM assessment_passes WHERE workspace_id=? ORDER BY pass_number DESC LIMIT 1`).get(wsId);
  if (!lastPass) {
    return {
      kind: 'pass-1', title: 'Start Pass 1 - initial gap assessment',
      why: 'Walks every clause and Annex A control. Each item gets diagnostic Y/P/N questions, a status, and a maturity score. Findings feed the asset + risk register work next.',
      cta: 'Start gap assessment', href: `/workspaces/${wsId}/gap-assessment`,
    };
  }

  // 4. Gap pass started but only partially complete (< 20 items assessed).
  const passAssessed = cnt(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs} WHERE workspace_id=? AND status != 'Not Assessed'`);
  if (passAssessed < 20) {
    return {
      kind: 'pass-1-partial', title: `Continue the gap assessment (${passAssessed}/118 assessed)`,
      why: 'Get through the rest of the clauses + Annex A so you have a complete view of current state before the risk workshop.',
      cta: 'Continue gap', href: `/workspaces/${wsId}/gap-assessment`,
    };
  }

  // 5. Asset register too thin - now that the gap pass surfaced what's
  // in scope and what controls are missing, build the inventory it'll
  // anchor against.
  const assets = cnt(`SELECT COUNT(*) c FROM assets WHERE workspace_id=?`);
  if (assets < 5) {
    return {
      kind: 'assets', title: 'Build the asset register',
      why: 'You need 30-50 entries to support the risk assessment. The gap-assessment findings give you a list of asset categories that need coverage; the scoping workshop playbook walks a structured 90-min session.',
      cta: 'Add assets', href: `/workspaces/${wsId}/assets`,
    };
  }

  // 6. Risk register thin - risk workshop hasn't happened.
  const risks = cnt(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND status NOT IN ('closed','accepted')`);
  if (risks < 10) {
    return {
      kind: 'risks', title: 'Populate the risk register',
      why: 'With the gap assessment + asset register in hand, the risk workshop can focus on the gaps that actually matter. Use "+ Firm library" to clone curated risks, or run the 90-min risk workshop playbook with the client.',
      cta: 'Open risks', href: `/workspaces/${wsId}/risks`,
    };
  }

  // 7. SoA has many Undecided controls - auditor blocker.
  const undecided = cnt(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs} cs INNER JOIN iso_items i ON i.id=cs.iso_item_id WHERE cs.workspace_id=? AND i.id LIKE 'annex-a.%' AND (cs.applicability IS NULL OR cs.applicability='undecided')`);
  if (undecided > 30) {
    return {
      kind: 'soa-bulk', title: `Decide SoA applicability for ${undecided} controls`,
      why: 'Clause 6.1.3.d requires applicability + justification per Annex A control. Use "+ Bulk decide applicability" on the SoA page to set most in one go.',
      cta: 'Open SoA', href: `/workspaces/${wsId}/soa`,
    };
  }

  // 7. No first management review yet.
  const mrmsDone = cnt(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status='complete'`);
  if (mrmsDone === 0) {
    return {
      kind: 'mrm', title: 'Run the first management review',
      why: 'Stage 1 readiness scores 0/10 on the MRM dimension until at least one is complete. Inputs auto-pull from current workspace data per clause 9.3.2.',
      cta: 'Open management reviews', href: `/workspaces/${wsId}/mrms`,
    };
  }

  // 8. No first internal audit complete.
  const auditsDone = cnt(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND status='complete'`);
  if (auditsDone === 0) {
    return {
      kind: 'audit', title: 'Conduct the first internal audit',
      why: 'Stage 1 readiness needs at least one completed internal audit. Document the programme first (clause 9.2.2), then conduct the audit.',
      cta: 'Open internal audit', href: `/workspaces/${wsId}/audits`,
    };
  }

  // 9. Pass 1 not closed - once intake / scope / risks / SoA / MRM / audit are
  //    all in, prompt to close the pass and start the readiness pack flow.
  if (activePass) {
    return {
      kind: 'close-pass', title: `Mark Pass ${activePass.pass_number} as complete`,
      why: 'You\'ve covered intake, risks, SoA decisions, first MRM, first internal audit. Close the pass to lock the snapshot and start the Stage 1 readiness pack.',
      cta: 'Open gap assessment', href: `/workspaces/${wsId}/gap-assessment`,
    };
  }

  // 10. Everything's in - point at the readiness pack.
  return {
    kind: 'pack', title: 'Generate the Stage 1 readiness pack',
    why: 'The single artefact you hand the certification body - SoA, RTP, audits, MRMs, parties, objectives, evidence manifest, every active evidence file in one ZIP.',
    cta: 'Open audit pack', href: `/workspaces/${wsId}/audit-pack`,
  };
}

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
    .all(wsId, today).forEach(a => push('high', 'risk', `Expired acceptance: R-${a.risk_id} ${a.title}`, `/workspaces/${wsId}/risks/${a.risk_id}`, `Expired ${a.expires_at} - re-accept or treat`));
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

  // Stale-control signals - controls included in SoA whose last_verified_at
  // is > 12 months ago (or never verified). Drives the re-engagement scope.
  const stale = db.prepare(`SELECT cs.iso_item_id, cs.last_verified_at, i.title
    FROM ${ctlReads.tables(db, wsId).cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.status NOT IN ('Not Assessed','Not Applicable')
      AND (cs.last_verified_at IS NULL OR cs.last_verified_at < datetime('now','-365 days'))
    ORDER BY cs.last_verified_at IS NULL DESC, cs.last_verified_at ASC
    LIMIT 6`).all(wsId);
  for (const s of stale) {
    const code = s.iso_item_id.replace('annex-','').toUpperCase();
    const detail = s.last_verified_at
      ? `Last verified ${s.last_verified_at.slice(0,10)} - re-assess`
      : 'Never verified - re-assess in this engagement';
    push(s.last_verified_at ? 'medium' : 'high', 'stale', `${code} stale: ${s.title.replace(/^A\.[0-9.]+ /,'')}`,
         `/workspaces/${wsId}/controls/assess/${s.iso_item_id}`, detail);
  }

  // Overdue objective due dates. (The matching "interested-party review
  // overdue" check that lived here is gone with the parties module.)
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

  // ISMS-stale signals - last MRM / audit older than 12 months
  const lastMrm = db.prepare(`SELECT meeting_date FROM mrms WHERE workspace_id=? AND status='complete' ORDER BY meeting_date DESC LIMIT 1`).get(wsId);
  if (!lastMrm) push('medium', 'mrm', 'No completed management review on record', `/workspaces/${wsId}/mrms`, '');
  else if (lastMrm.meeting_date < new Date(Date.now() - 365*86400000).toISOString().slice(0,10))
    push('medium', 'mrm', 'Last management review > 12 months ago', `/workspaces/${wsId}/mrms`, `Last: ${lastMrm.meeting_date}`);

  const lastAudit = db.prepare(`SELECT audit_date FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL ORDER BY audit_date DESC LIMIT 1`).get(wsId);
  if (!lastAudit) push('medium', 'audit', 'No internal audit on record', `/workspaces/${wsId}/audits`, '');
  else if (lastAudit.audit_date < new Date(Date.now() - 365*86400000).toISOString().slice(0,10))
    push('medium', 'audit', 'Last internal audit > 12 months ago', `/workspaces/${wsId}/audits`, `Last: ${lastAudit.audit_date}`);

  // Tasks overdue / due soon
  db.prepare(`SELECT id, title, due_date FROM tasks
    WHERE workspace_id=? AND status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND due_date < ?`)
    .all(wsId, today).forEach(t => push('high', 'task', `Overdue task: ${t.title}`, `/workspaces/${wsId}/tasks`, `Due ${t.due_date}`));
  db.prepare(`SELECT id, title, due_date FROM tasks
    WHERE workspace_id=? AND status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND due_date >= ? AND due_date < ?`)
    .all(wsId, today, expSoon).forEach(t => push('medium', 'task', `Task due soon: ${t.title}`, `/workspaces/${wsId}/tasks`, `Due ${t.due_date}`));

  // Upcoming scheduled internal audits / management reviews (within 30 days)
  db.prepare(`SELECT id, title, audit_date FROM audits
    WHERE workspace_id=? AND audit_date IS NOT NULL AND audit_date >= ? AND audit_date < ? AND closed_at IS NULL`)
    .all(wsId, today, expSoon).forEach(a => push('medium', 'audit', `Internal audit scheduled: ${a.title}`, `/workspaces/${wsId}/audits/${a.id}`, `On ${a.audit_date}`));
  db.prepare(`SELECT id, meeting_date FROM mrms
    WHERE workspace_id=? AND meeting_date IS NOT NULL AND meeting_date >= ? AND meeting_date < ? AND status != 'completed'`)
    .all(wsId, today, expSoon).forEach(m => push('medium', 'mrm', `Management review scheduled (clause 9.3)`, `/workspaces/${wsId}/mrms/${m.id}`, `On ${m.meeting_date}`));

  // Certification target date passed / approaching
  const wsRow = db.prepare(`SELECT target_cert_date FROM workspaces WHERE id=?`).get(wsId);
  if (wsRow && wsRow.target_cert_date) {
    if (wsRow.target_cert_date < today) push('high', 'cert', 'Certification target date has passed', `/workspaces/${wsId}`, `Target was ${wsRow.target_cert_date}`);
    else if (wsRow.target_cert_date < expSoon) push('medium', 'cert', 'Certification audit within 30 days', `/workspaces/${wsId}`, `Target ${wsRow.target_cert_date}`);
  }

  // Sort: high before medium, newer/sooner deadlines first within severity
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
  return items;
}

// The standalone notifications page was merged into the Inbox; redirect (keep ?filter).
app.get('/workspaces/:wsId/notifications', requireAuth, requireWorkspace, (req, res) => {
  const qs = req.query.filter ? ('?filter=' + encodeURIComponent(req.query.filter)) : '';
  res.redirect('/workspaces/' + req.workspace.id + '/inbox' + qs);
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

// Per-user email-notification preference (global to the account, not per-workspace).
// 'immediate' = email me when a notification is raised; 'off' = in-app only.
// Drives the notify()->email bridge in lib/jobs.js via users.email_notify.
app.post('/me/notification-pref', requireAuth, (req, res) => {
  const value = req.body.value === 'off' ? 'off' : 'immediate';
  db.prepare('UPDATE users SET email_notify=? WHERE id=?').run(value, req.user.id);
  // Only honour a same-site relative return path; never an absolute/protocol-relative URL.
  const back = (typeof req.body.return === 'string' && /^\/[^/]/.test(req.body.return)) ? req.body.return : '/dashboard';
  res.redirect(withToast(back, value === 'off' ? 'Email notifications turned off' : 'Email notifications on'));
});

// Tier B.8 - Calendar view aggregating every due-dated item across the workspace.
// Month grid; navigate prev/next via ?month=YYYY-MM. Pulls audits, MRMs,
// NCs, cert events, doc reviews, treatment actions, risk-acceptance expiries.
app.get('/workspaces/:wsId/calendar', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const monthStr = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month
                  : ymLocal(new Date());
  const [yr, mo] = monthStr.split('-').map(n => parseInt(n, 10));
  const monthStart = `${monthStr}-01`;
  // Local-component formatters — toISOString() is UTC and rolls these back a day
  // (and the prev-month label back a whole month) in IST, breaking Prev/Next nav
  // and dropping last-of-month events from the exclusive upper bound.
  const nextMo = ymdLocal(new Date(yr, mo, 1)); // first of next month (exclusive bound)
  const prevMo = ymLocal(new Date(yr, mo - 2, 1));
  const nextLabel = ymLocal(new Date(yr, mo, 1));

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

  // Newer sources: training due, comms plan, competence expiry, supplier reviews, BCP tests, ISO 42001 cert events.
  try {
    db.prepare(`SELECT id, user_name, training_name, due_date, status FROM training_records WHERE workspace_id=? AND due_date IS NOT NULL`).all(wsId)
      .forEach(t => add(t.due_date, 'training', `${t.user_name} - ${t.training_name}`, `/workspaces/${wsId}/training`, t.status === 'completed' ? 'low' : 'medium'));
  } catch (_) {}
  try {
    db.prepare(`SELECT id, what, next_due_date FROM communication_plan WHERE workspace_id=? AND next_due_date IS NOT NULL`).all(wsId)
      .forEach(c => add(c.next_due_date, 'comms', c.what, `/workspaces/${wsId}/communication-plan`, 'low'));
  } catch (_) {}
  try {
    db.prepare(`SELECT id, person_name, competence, expires_on FROM competence_records WHERE workspace_id=? AND expires_on IS NOT NULL`).all(wsId)
      .forEach(c => add(c.expires_on, 'competence', `${c.person_name} - ${c.competence} expires`, `/workspaces/${wsId}/competence`, 'medium'));
  } catch (_) {}
  try {
    db.prepare(`SELECT id, supplier_id, next_review_date FROM supplier_reviews WHERE next_review_date IS NOT NULL
      AND supplier_id IN (SELECT id FROM suppliers WHERE workspace_id=?)`).all(wsId)
      .forEach(r => add(r.next_review_date, 'supplier', `Supplier review`, `/workspaces/${wsId}/vendors/${r.supplier_id}`, 'low'));
  } catch (_) {}
  try {
    db.prepare(`SELECT id, event_type, planned_date FROM iso42001_cert_cycle_events WHERE workspace_id=? AND planned_date IS NOT NULL`).all(wsId)
      .forEach(e => add(e.planned_date, 'iso42001-cert', `[42001] ${e.event_type}`, `/workspaces/${wsId}/iso42001/cert-cycle`, 'medium'));
  } catch (_) {}

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
    INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.created_at DESC LIMIT 50000`).all(req.workspace.id);
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
  const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
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
  const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
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
  const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
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
    FROM iso_items i LEFT JOIN ${ctlReads.tables(db, wsId).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
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
    WHERE s.workspace_id=? ORDER BY s.created_at DESC, s.id DESC`).all(req.workspace.id);
  res.render('soa_snapshots', { user: req.user, ws: req.workspace, snapshots: list });
});

// /snapshots/diff MUST be registered BEFORE /snapshots/:id - Express matches
// in registration order, and a `:id` placeholder will happily capture "diff"
// otherwise. The :id route also constrains to digits via the regex pattern
// so similar collisions can't recur if more sibling routes are added.
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
  const all = db.prepare('SELECT id, label, created_at FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC').all(req.workspace.id);
  res.render('soa_snapshot_diff', { user: req.user, ws: req.workspace, sa, sb, diff, all });
});

// Snapshot detail. :id constrained to digits so this can't capture string
// sibling routes like /diff (which is registered just above).
app.get('/workspaces/:wsId/soa/snapshots/:id(\\d+)', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const s = db.prepare('SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!s) return res.status(404).render('error', { user: req.user, message: 'Snapshot not found. It may have been deleted, or the URL is wrong. Use the Snapshots tab to pick a current one.' });
  const rows = JSON.parse(enc.decryptIfNeeded(s.payload, req.workspace.id));
  res.render('soa_snapshot_detail', { user: req.user, ws: req.workspace, snapshot: s, rows });
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

// ==================== CHANGES SINCE LAST AUDIT ====================
// Surveillance + recertification handoff: "what's changed since the last
// audit?" Picks a sensible default "since" date (most recent audit, fallback
// to most recent SoA snapshot, fallback to 365 days ago) and shows SoA diff,
// new risks, new evidence, document changes, NCs, audits, MRMs, improvements.
// The auditor sees the audit pack PDF; the consultant uses this page when
// prepping the cycle.
// ==================== CLIENT INBOX (D-11 + D-13) ====================
// Per-client surface combining auto-computed "deliverables due" (NCs,
// doc reviews, audits/MRMs scheduled, tasks) with a free-text monthly
// plan notepad. The consultant's "what do I owe THIS client this
// month" view, not the firm-wide /dashboard.
// Single per-client Inbox: live "needs your attention" items (computeNeedsAttention),
// stored per-user notifications (read/dismiss), and a free-text 30-day plan notepad.
// Merged from the former /notifications page so there's one place to look.
app.get('/workspaces/:wsId/inbox', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const computed = computeNeedsAttention(wsId);
  const filter = req.query.filter === 'all' ? 'all' : 'unread';
  let q = `SELECT * FROM notifications WHERE workspace_id=? AND (user_id IS NULL OR user_id=?)`;
  if (filter === 'unread') q += ` AND read_at IS NULL AND dismissed_at IS NULL`;
  else q += ` AND dismissed_at IS NULL`;
  q += ` ORDER BY created_at DESC LIMIT 200`;
  const notifications = db.prepare(q).all(wsId, req.user.id);
  res.render('client_inbox', {
    user: req.user, ws: req.workspace,
    computed, notifications, filter,
    monthlyPlan: req.workspace.monthly_plan || ''
  });
});

app.post('/workspaces/:wsId/inbox/plan', requireAuth, requireWorkspace, (req, res) => {
  const plan = (req.body.monthly_plan || '').slice(0, 10000);
  db.prepare(`UPDATE workspaces SET monthly_plan=? WHERE id=?`).run(plan, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'update_monthly_plan', 'workspace', req.workspace.id, null);
  res.redirect(withToast(`/workspaces/${req.workspace.id}/inbox`, 'Plan saved'));
});

app.get('/workspaces/:wsId/changes-since', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const since = (req.query.since || '').toString().trim() || null;
  const data = changesSince.gather({ db, enc }, req.workspace.id, since);
  // Anchor options for the date picker: every internal audit + every SoA snapshot.
  const anchors = {
    audits: db.prepare(`SELECT id, title, audit_date, status FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL ORDER BY audit_date DESC`).all(req.workspace.id),
    snapshots: db.prepare(`SELECT id, label, created_at FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC`).all(req.workspace.id)
  };
  res.render('changes_since', { user: req.user, ws: req.workspace, data, anchors });
});

// ==================== DELIVERABLES INDEX ====================
// One canonical home for every export this workspace produces. The catalogue
// lives in views/deliverables.ejs (data-only), not here — adding a new export
// to the product means adding a row there + linking the generator route.
app.get('/workspaces/:wsId/deliverables', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  // Custom markdown report templates surface here too, so Deliverables is the
  // single home for every export (the standalone Reports page is just the editor).
  const reportTemplates = db.prepare(`SELECT id, name, description, is_system FROM report_templates WHERE workspace_id IS NULL OR workspace_id=? OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
  res.render('deliverables', { user: req.user, ws: req.workspace, reportTemplates });
});

// ==================== AUDIT PACK ====================
// One-click branded PDF bundling SoA + risks + evidence + audits + NCs + MRMs
// + improvements + audit-trail. Three routes: GET config UI, GET preview-as-
// HTML (handy for iterating on layout), POST generate (renders HTML then prints
// to PDF with Chromium). The lib lives in lib/audit-pack.js so it can be
// unit-tested without spinning up Express.
const AUDIT_PACK_SECTIONS = ['cover','summary','soa','risks','evidence','audits','ncs','mrms','improvements','audit_trail'];

function parseSectionsFromBody(body) {
  // express.urlencoded with extended:true gives us either string (one checked)
  // or array (multiple). Anything not in the list is silently dropped.
  let raw = body && body.sections;
  if (!raw) return {};
  if (!Array.isArray(raw)) raw = [raw];
  const out = {};
  AUDIT_PACK_SECTIONS.forEach(k => { out[k] = raw.includes(k); });
  return out;
}

function buildAuditPackOpts(body) {
  const opts = {
    sections: Object.keys(body || {}).some(k => k === 'sections')
      ? parseSectionsFromBody(body)
      : undefined,
    snapshotId: body && body.snapshotId ? parseInt(body.snapshotId, 10) || null : null,
    preparedFor: body && body.preparedFor ? String(body.preparedFor).trim() : null,
    preparedBy: body && body.preparedBy ? String(body.preparedBy).trim() : null,
    brand: {
      displayName: body && body.brandDisplayName ? String(body.brandDisplayName).trim() : null,
      primaryColor: body && body.brandPrimaryColor ? String(body.brandPrimaryColor).trim() : null,
      confidentialityLabel: body && body.confidentialityLabel ? String(body.confidentialityLabel).trim() : null
    }
  };
  // Strip null/empty brand fields so defaults from gatherAuditPackData take over.
  Object.keys(opts.brand).forEach(k => { if (!opts.brand[k]) delete opts.brand[k]; });
  return opts;
}

async function renderAuditPackHTML(app, wsId, opts) {
  const data = auditPack.gatherAuditPackData({ db, enc, methodologyBand, getActiveMethodology }, wsId, opts);
  return new Promise((resolve, reject) => {
    app.render('audit_pack', data, (err, html) => err ? reject(err) : resolve(html));
  });
}

app.get('/workspaces/:wsId/audit-pack', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const snapshots = db.prepare(`SELECT id, label, created_at, included_count FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC`).all(req.workspace.id);
  const firm = db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id) || {};
  const riskCount = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(req.workspace.id).c;
  const evidenceCount = db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`).get(req.workspace.id).c;
  const auditCount = db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`).get(req.workspace.id).c;
  const ncCount = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?`).get(req.workspace.id).c;
  const mrmCount = db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?`).get(req.workspace.id).c;
  const improvementCount = db.prepare(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=?`).get(req.workspace.id).c;
  res.render('audit_pack_config', {
    user: req.user, ws: req.workspace,
    snapshots, firmName: firm.name || '',
    riskCount, evidenceCount, auditCount, ncCount, mrmCount, improvementCount
  });
});

app.get('/workspaces/:wsId/audit-pack/preview', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
  try {
    const opts = buildAuditPackOpts(req.query);
    const html = await renderAuditPackHTML(app, req.workspace.id, opts);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).render('error', { user: req.user, message: 'Could not generate audit pack preview: ' + e.message });
  }
});

app.post('/workspaces/:wsId/audit-pack/pdf', requireAuth, requireWorkspace, requirePermission('control.view'), async (req, res) => {
  try {
    const opts = buildAuditPackOpts(req.body);
    const html = await renderAuditPackHTML(app, req.workspace.id, opts);
    const headerLeft = opts.brand && opts.brand.displayName ? opts.brand.displayName : (db.prepare('SELECT name FROM firms WHERE id=?').get(req.workspace.firm_id) || {}).name || '';
    const headerRight = `${req.workspace.client_name} · ISMS Audit Pack`;
    const footerLeft = (opts.brand && opts.brand.confidentialityLabel) || 'Confidential · For audit and management review purposes only';
    const pdfRaw = await auditPack.renderPDF(html, { headerLeft, headerRight, footerLeft });
    // Puppeteer v22+ returns a Uint8Array, which Express's res.send would
    // JSON-stringify. Wrap in Buffer so the raw PDF bytes hit the wire.
    const pdf = Buffer.isBuffer(pdfRaw) ? pdfRaw : Buffer.from(pdfRaw);
    logAction(req.user.id, req.workspace.id, 'generate_audit_pack', 'audit_pack', null, { bytes: pdf.length }, auditCtx(req));
    const fname = `audit-pack-${req.workspace.client_name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0,10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(pdf);
  } catch (e) {
    console.error('audit-pack generate error:', e);
    res.status(500).render('error', { user: req.user, message: 'Could not generate audit pack PDF: ' + e.message + '. The pack data is fine - this is a rendering glitch. Try again, or use Preview HTML to see the content.' });
  }
});

// ==================== FIRM CONTENT LIBRARY ====================
// The firm's own curated content - risks today, policy templates and control
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
  res.render('firm_library', { user: req.user, ws: null, counts }); // firm-level page - firm sidebar
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
  res.render('firm_library_risks', { user: req.user, ws: null, rows, sectors, domains, filterSector, filterDomain, search }); // firm-level page - firm sidebar
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

// Clone the firm library into a workspace's risk register. Existing risks
// with the same title are not duplicated.
app.post('/workspaces/:wsId/risks/clone-firm-library', requireAuth, requireWorkspace, requirePermission('risk.create'), (req, res) => {
  const firmId = req.workspace.firm_id;
  const lib = db.prepare(`SELECT * FROM firm_risk_library WHERE firm_id=? ORDER BY domain, title`).all(firmId);
  const have = new Set(db.prepare(`SELECT title FROM risks WHERE workspace_id=?`).all(req.workspace.id).map(r => r.title));
  const ins = db.prepare(`INSERT INTO risks
    (workspace_id, title, description, threat, vulnerability, likelihood, impact, owner_name, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`);
  let added = 0;
  const clonedIds = [];
  const tx = db.transaction(() => {
    for (const r of lib) {
      if (have.has(r.title)) continue;
      const info = ins.run(req.workspace.id, r.title, r.description, r.threat, r.vulnerability,
        r.suggested_likelihood || 3, r.suggested_impact || 3, '');
      clonedIds.push(info.lastInsertRowid);
      added++;
    }
  });
  tx();
  clonedIds.forEach(id => fts.refresh(req.workspace.id, 'risk', id));
  logAction(req.user.id, req.workspace.id, 'risk_clone_firm_library', 'risk', null, { added }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/risks`, `Cloned ${added} risks from firm library`));
});

// ==================== ADMIN: EMAIL SETTINGS + OUTBOX ====================
// Firm-level transactional email config. Lives at the firm scope (not the
// workspace) because every client engagement under the firm sends from the
// same branded address. Outbox shows the last 50 sends for auditing
// (deliverability triage, "did the approver get the email", etc.).

app.get('/admin/email', requireAuth, (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).render('error', { user: req.user, message: 'Only firm owners can manage email settings.' });
  const firmId = getActiveFirmId(req);
  if (!firmId) return res.redirect('/tenants');
  const settings = email.getFirmEmailSettings(firmId);
  const outbox = db.prepare(`SELECT * FROM email_outbox WHERE firm_id=? ORDER BY created_at DESC LIMIT 50`).all(firmId);
  const counts = {
    sent_7d: db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE firm_id=? AND status='sent' AND created_at >= datetime('now','-7 days')`).get(firmId).c,
    failed_7d: db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE firm_id=? AND status='failed' AND created_at >= datetime('now','-7 days')`).get(firmId).c
  };
  res.render('admin_email', {
    user: req.user,
    ws: null, // firm-level page - firm sidebar (see GET /glossary note)
    settings,
    outbox,
    counts,
    provider: email.currentProvider(),
    providerConfigured: email.currentProvider() !== 'devnull',
    envFromDefault: process.env.EMAIL_FROM_DEFAULT || null,
    appBaseUrl: email.appBaseUrl()
  });
});

app.post('/admin/email/settings', requireAuth, (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
  const firmId = getActiveFirmId(req);
  if (!firmId) return res.redirect('/tenants');
  email.getFirmEmailSettings(firmId); // ensure row exists
  const { from_name, from_email, reply_to, enabled } = req.body;
  // Light validation: from_email and reply_to should look like emails if set.
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (from_email && !emailRe.test(from_email.trim())) {
    return res.status(400).render('error', { user: req.user, message: '"From email" doesn\'t look like a valid address.' });
  }
  if (reply_to && !emailRe.test(reply_to.trim())) {
    return res.status(400).render('error', { user: req.user, message: '"Reply-to" doesn\'t look like a valid address.' });
  }
  db.prepare(`UPDATE firm_email_settings SET from_name=?, from_email=?, reply_to=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE firm_id=?`)
    .run(
      (from_name || '').trim() || null,
      (from_email || '').trim() || null,
      (reply_to || '').trim() || null,
      enabled === '1' || enabled === 'on' ? 1 : 0,
      firmId
    );
  logAction(req.user.id, null, 'update_email_settings', 'firm', firmId, null);
  res.redirect(withToast('/admin/email', 'Email settings saved'));
});

app.post('/admin/email/test', requireAuth, async (req, res) => {
  if (!isFirmOwner(req.user)) return res.status(403).send('Forbidden');
  const firmId = getActiveFirmId(req);
  if (!firmId) return res.redirect('/tenants');
  const to = (req.body.to || '').trim();
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(to)) {
    return res.status(400).render('error', { user: req.user, message: 'Enter a valid email address to send the test to.' });
  }
  const result = await email.sendTestEmail(firmId, to);
  const msg = result.ok
    ? `Test email sent to ${to}` + (result.provider === 'devnull' ? ' (dev fallback - check data/email-dev-outbox.log)' : '')
    : `Send failed: ${result.error}`;
  res.redirect(withToast('/admin/email', msg, result.ok ? 'success' : 'error'));
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

  // Residual-risk financial estimate. ISO doesn't mandate $ - but a board
  // wants one. Use Annual Loss Expectancy: SLE × ARO heuristic.
  // For each open risk, treat (likelihood / 5) as ARO and (impact * tier) as
  // SLE. Tier defaults to $50k * impact (1=$50k, 5=$250k) - configurable
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
    derivedStage: computeClientStage(ws),
  });
});


// ==================== CONSULTANT PLAYBOOKS ====================
// Firm-level reference material - kickoff agenda, scoping workshop, risk
// workshop facilitator script. Read-only. Lives at /playbooks (no workspace
// context required) so a junior consultant can open it during any client call.
const PLAYBOOKS = require('./data/playbooks');

app.get('/playbooks', requireAuth, (req, res) => {
  res.render('playbooks_index', { user: req.user, ws: null, playbooks: PLAYBOOKS.PLAYBOOK_INDEX }); // firm-level page - firm sidebar
});

app.get('/playbooks/:id', requireAuth, (req, res) => {
  const pb = PLAYBOOKS.PLAYBOOKS[req.params.id];
  if (!pb) return res.status(404).render('error', { user: req.user, message: 'Playbook not found' });
  res.render('playbook_detail', { user: req.user, ws: null, playbook: pb }); // firm-level page - firm sidebar
});

// ==================== ENGAGEMENT INTAKE + 12-WEEK PLAN ====================
// Extracted to routes/engagement.js. Same dependency-injection pattern as
// routes/tenants.js - engagement routes get db + middleware via deps.
require('./routes/engagement').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, withToast, logAction, auditCtx,
});

// ==================== NIST CSF 2.0 ====================
// Module layout (Stage 2):
//   GET  /workspaces/:wsId/csf                    engagement list (landing)
//   GET  /workspaces/:wsId/csf/catalog            catalog browser (read-only)
//   GET  /workspaces/:wsId/csf/new                new engagement form
//   POST /workspaces/:wsId/csf                    create engagement
//   GET  /workspaces/:wsId/csf/:id(\\d+)           engagement detail
//   POST /workspaces/:wsId/csf/:id/assign         add assignment
//   POST /workspaces/:wsId/csf/:id/unassign/:aid  remove assignment
//
// Literal sub-routes (`new`, `catalog`) must be registered before `/:id` and
// the :id capture is digit-constrained so they can't collide (same lesson as
// /soa/snapshots/:id vs /soa/snapshots/diff in commit 6fdb9b5).
const csfPolicy = require('./lib/csf-policy');

// Engagement list
app.get('/workspaces/:wsId/csf', requireAuth, requireWorkspace, (req, res) => {
  const engagements = db.prepare(`
    SELECT e.id, e.name, e.status, e.scope_mode, e.period_start, e.period_end,
      e.target_completion_date, e.catalog_version, e.current_version, e.created_at,
      u.name AS lead_name,
      (SELECT COUNT(*) FROM csf_engagement_assignments a WHERE a.engagement_id=e.id) AS assignment_count
    FROM csf_engagements e
    LEFT JOIN users u ON u.id = e.assigned_lead_id
    WHERE e.workspace_id=? AND e.deleted_at IS NULL
    ORDER BY e.created_at DESC
  `).all(req.workspace.id);
  const canCreate = csfPolicy.canCreateEngagement(req.user, req.workspace);
  res.render('csf_engagements', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagements, canCreate,
  });
});

// New engagement form
app.get('/workspaces/:wsId/csf/new', requireAuth, requireWorkspace, (req, res) => {
  if (!csfPolicy.canCreateEngagement(req.user, req.workspace)) {
    return res.status(403).render('error', { user: req.user, message: 'You do not have permission to create CSF engagements in this workspace.' });
  }
  // Assignable users = workspace members + firm operators (same pool used by tasks)
  const assignableUsers = db.prepare(`
    SELECT u.id, u.name FROM users u
    INNER JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = ?
    UNION
    SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1
  `).all(req.workspace.id, req.workspace.firm_id);
  res.render('csf_engagement_new', {
    user: req.user, ws: req.workspace, active: 'csf',
    assignableUsers,
  });
});

// Create engagement (seeds a default weighting profile with weight=1.0 on every subcategory)
app.post('/workspaces/:wsId/csf', requireAuth, requireWorkspace, (req, res) => {
  if (!csfPolicy.canCreateEngagement(req.user, req.workspace)) return res.status(403).send('Forbidden');
  const b = req.body;
  if (!b.name || !b.name.trim()) return redirectBack(req, res, 'Engagement name is required', 'error');
  const catalogVersion = '2.0';
  const scopeMode = b.scope_mode === 'CURRENT_TARGET' ? 'CURRENT_TARGET' : 'CURRENT_ONLY';
  const leadId = b.assigned_lead_id ? parseInt(b.assigned_lead_id, 10) : null;

  const create = db.transaction(() => {
    const engId = db.prepare(`
      INSERT INTO csf_engagements (workspace_id, catalog_version, name, period_start, period_end,
        target_completion_date, scope_mode, status, assigned_lead_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)
    `).run(
      req.workspace.id, catalogVersion, b.name.trim(),
      b.period_start || null, b.period_end || null,
      b.target_completion_date || null,
      scopeMode, leadId, req.user.id,
    ).lastInsertRowid;

    // Seed default weighting profile: all 106 subcategories at weight 1.0
    const profileId = db.prepare(`
      INSERT INTO csf_weighting_profiles (engagement_id, workspace_id, name, is_default)
      VALUES (?, ?, 'Default (equal weighting)', 1)
    `).run(engId, req.workspace.id).lastInsertRowid;
    const subs = db.prepare(`SELECT id FROM csf_subcategories WHERE catalog_version=?`).all(catalogVersion);
    const insWPI = db.prepare(`INSERT INTO csf_weighting_profile_items (profile_id, subcategory_id, weight) VALUES (?, ?, 1.0)`);
    subs.forEach(s => insWPI.run(profileId, s.id));

    db.prepare(`UPDATE csf_engagements SET weighting_profile_id=? WHERE id=?`).run(profileId, engId);

    // Auto-assign the Lead (if specified) and the creator (as Lead too if no other Lead chosen)
    const insAssign = db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments (engagement_id, user_id, role_on_engagement, assigned_by) VALUES (?, ?, 'ENGAGEMENT_LEAD', ?)`);
    if (leadId) insAssign.run(engId, leadId, req.user.id);
    insAssign.run(engId, req.user.id, req.user.id);

    return engId;
  });
  const engId = create();
  logAction(req.user.id, req.workspace.id, 'csf_engagement_create', 'csf_engagement', engId, { name: b.name }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engId}`, 'CSF engagement created'));
});

// Catalog browser (moved from /csf to /csf/catalog)
app.get('/workspaces/:wsId/csf/catalog', requireAuth, requireWorkspace, (req, res) => {
  const catalogVersion = '2.0';
  const fns = db.prepare(`SELECT id, code, name, description, display_order FROM csf_functions WHERE catalog_version=? ORDER BY display_order`).all(catalogVersion);
  const cats = db.prepare(`SELECT id, function_id, code, name, description, display_order FROM csf_categories WHERE catalog_version=? ORDER BY display_order`).all(catalogVersion);
  const subs = db.prepare(`SELECT id, category_id, code, description, implementation_examples, display_order FROM csf_subcategories WHERE catalog_version=? ORDER BY display_order`).all(catalogVersion);
  const isoRefs = db.prepare(`SELECT subcategory_id, ref_type, ref_value FROM csf_subcategory_iso_refs`).all();

  const catsByFn = {};
  cats.forEach(c => { (catsByFn[c.function_id] = catsByFn[c.function_id] || []).push(c); });
  const subsByCat = {};
  subs.forEach(s => { (subsByCat[s.category_id] = subsByCat[s.category_id] || []).push(s); });
  const refsBySub = {};
  isoRefs.forEach(r => { (refsBySub[r.subcategory_id] = refsBySub[r.subcategory_id] || []).push(r); });

  const tree = fns.map(f => ({
    ...f,
    categories: (catsByFn[f.id] || []).map(c => ({
      ...c,
      subcategories: (subsByCat[c.id] || []).map(s => ({ ...s, iso_refs: refsBySub[s.id] || [] }))
    }))
  }));

  res.render('csf_catalog', {
    user: req.user, ws: req.workspace, active: 'csf-catalog',
    catalogVersion, tree, totalFns: fns.length, totalCats: cats.length, totalSubs: subs.length,
  });
});

// Engagement detail (Stage 6: consultant dashboard surface)
app.get('/workspaces/:wsId/csf/:id(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
  if (!engagement) return res.status(404).render('error', { user: req.user, message: 'CSF engagement not found, or it was deleted.' });
  if (!csfPolicy.canViewEngagement(db, req.user, engagement)) {
    return res.status(403).render('error', { user: req.user, message: 'You are not assigned to this CSF engagement.' });
  }
  const assignments = db.prepare(`
    SELECT a.id, a.role_on_engagement, a.assigned_at, u.id AS user_id, u.name AS user_name, u.email
    FROM csf_engagement_assignments a
    INNER JOIN users u ON u.id = a.user_id
    WHERE a.engagement_id = ? ORDER BY a.assigned_at
  `).all(engagement.id);
  const lead = engagement.assigned_lead_id ? db.prepare('SELECT id, name FROM users WHERE id=?').get(engagement.assigned_lead_id) : null;
  const assignableUsers = db.prepare(`
    SELECT u.id, u.name FROM users u
    INNER JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = ?
    UNION
    SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1
  `).all(req.workspace.id, req.workspace.firm_id);

  // ---- Stage 6 dashboard data ----
  csfPolicy.ensureAssessmentRows(db, engagement);
  // Status counts
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=? GROUP BY status
  `).all(engagement.id).reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});
  const totalSubs = db.prepare(`SELECT COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=?`).get(engagement.id).c;
  const inscopeSubs = db.prepare(`SELECT COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=? AND excluded_from_scope=0`).get(engagement.id).c;
  const scoredSubs = db.prepare(`SELECT COUNT(*) AS c FROM csf_subcategory_assessments WHERE engagement_id=? AND excluded_from_scope=0 AND current_score IS NOT NULL`).get(engagement.id).c;
  const scoredPct = inscopeSubs === 0 ? 0 : Math.round((scoredSubs / inscopeSubs) * 100);

  // Score distribution
  const distRows = db.prepare(`
    SELECT current_score AS s, COUNT(*) AS c FROM csf_subcategory_assessments
    WHERE engagement_id=? AND excluded_from_scope=0 AND current_score IS NOT NULL
    GROUP BY current_score ORDER BY current_score
  `).all(engagement.id);
  const distribution = [1, 2, 3, 4, 5].map(s => ({ score: s, count: distRows.find(r => r.s === s)?.c || 0 }));

  // Days remaining (decision #16)
  let daysRemaining = null, daysOverdue = false;
  if (engagement.target_completion_date) {
    const ms = new Date(engagement.target_completion_date).getTime() - Date.now();
    daysRemaining = Math.ceil(ms / (1000 * 60 * 60 * 24));
    daysOverdue = daysRemaining < 0;
  }

  // Outstanding items
  const subsWithScoreNoEvidence = db.prepare(`
    SELECT a.id, a.subcategory_id, s.code AS sub_code
    FROM csf_subcategory_assessments a
    INNER JOIN csf_subcategories s ON s.id = a.subcategory_id
    WHERE a.engagement_id=? AND a.excluded_from_scope=0 AND a.current_score IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM csf_evidence_items e WHERE e.assessment_id=a.id AND e.deleted_at IS NULL)
    ORDER BY s.display_order LIMIT 30
  `).all(engagement.id);

  const unresolvedComments = db.prepare(`
    SELECT c.id, c.text, c.requires_revision, c.created_at, u.name AS commenter_name,
      a.subcategory_id, s.code AS sub_code, c.finding_id, f.title AS finding_title
    FROM csf_reviewer_comments c
    INNER JOIN users u ON u.id = c.commenter_id
    LEFT JOIN csf_subcategory_assessments a ON a.id = c.assessment_id
    LEFT JOIN csf_subcategories s ON s.id = a.subcategory_id
    LEFT JOIN csf_findings f ON f.id = c.finding_id
    WHERE c.engagement_id=? AND c.resolved=0 AND c.deleted_at IS NULL
    ORDER BY c.created_at DESC LIMIT 20
  `).all(engagement.id);

  const findingsNoRecs = db.prepare(`
    SELECT f.id, f.title, f.severity,
      s.code AS sub_code, s.id AS subcategory_id
    FROM csf_findings f
    LEFT JOIN csf_subcategory_assessments a ON a.id = f.assessment_id
    LEFT JOIN csf_subcategories s ON s.id = a.subcategory_id
    WHERE f.engagement_id=? AND f.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM csf_recommendations r WHERE r.finding_id=f.id AND r.deleted_at IS NULL)
    ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
    LIMIT 20
  `).all(engagement.id);

  // Activity feed - recent csf_* audit log entries for this engagement
  const activity = db.prepare(`
    SELECT a.action, a.entity_type, a.entity_id, a.created_at, a.details, u.name AS actor
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.workspace_id = ? AND a.action LIKE 'csf_%'
    ORDER BY a.created_at DESC LIMIT 30
  `).all(req.workspace.id);

  // Engagement-level state transition controls
  const nextEngState = csfPolicy.nextEngagementState(engagement.status);
  const canTransitionEng = nextEngState ? csfPolicy.canTransitionEngagement(db, req.user, engagement, nextEngState) : false;
  const canPublishNow = engagement.status === 'Approved' && csfPolicy.canPublish(db, req.user, engagement);

  // Stage 11/12: unread inbox count for current user (badge on Inbox button)
  const inboxUnread = db.prepare(`
    SELECT COUNT(*) AS c FROM csf_ask_lead_messages
    WHERE engagement_id=? AND recipient_id=? AND read_at IS NULL AND deleted_at IS NULL
  `).get(engagement.id, req.user.id).c;
  // Unresolved-comment count for badge on the Findings button.
  const unresolvedCommentCount = db.prepare(`
    SELECT COUNT(*) AS c FROM csf_reviewer_comments
    WHERE engagement_id=? AND resolved=0 AND deleted_at IS NULL
  `).get(engagement.id).c;

  res.render('csf_engagement_detail', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, lead, assignments, assignableUsers,
    canAssign: csfPolicy.canAssignMembers(db, req.user, engagement),
    canEdit: csfPolicy.canEditEngagementMeta(db, req.user, engagement),
    engagementRoles: csfPolicy.ENGAGEMENT_ROLES,
    // dashboard data
    statusCounts, totalSubs, inscopeSubs, scoredSubs, scoredPct,
    distribution, daysRemaining, daysOverdue,
    subsWithScoreNoEvidence, unresolvedComments, findingsNoRecs,
    activity,
    // state transition
    nextEngState, canTransitionEng, canPublishNow,
    // Stage 11/12
    inboxUnread, unresolvedCommentCount,
  });
});

// Assign a member to an engagement
app.post('/workspaces/:wsId/csf/:id(\\d+)/assign', requireAuth, requireWorkspace, (req, res) => {
  const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
  if (!engagement) return res.status(404).send('Not found');
  if (!csfPolicy.canAssignMembers(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const userId = parseInt(req.body.user_id, 10);
  const role = req.body.role_on_engagement;
  if (!userId || !csfPolicy.ENGAGEMENT_ROLES.includes(role)) return redirectBack(req, res, 'Pick a user and a role', 'error');
  db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments (engagement_id, user_id, role_on_engagement, assigned_by) VALUES (?, ?, ?, ?)`)
    .run(engagement.id, userId, role, req.user.id);
  logAction(req.user.id, req.workspace.id, 'csf_assignment_add', 'csf_engagement', engagement.id, { user_id: userId, role }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}`, 'Assignment added'));
});

// Engagement-level state transition (Draft -> In Progress -> Under Review -> Approved).
// Approved -> Published goes through the publish route, not here.
app.post('/workspaces/:wsId/csf/:id(\\d+)/transition', requireAuth, requireWorkspace, (req, res) => {
  const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
  if (!engagement) return res.status(404).send('Not found');
  const to = req.body.to_state;
  if (!csfPolicy.canTransitionEngagement(db, req.user, engagement, to)) {
    return res.status(403).send('Forbidden: only the Engagement Lead can advance the engagement, and the transition must be the next step forward.');
  }
  db.prepare(`UPDATE csf_engagements SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(to, engagement.id);
  logAction(req.user.id, req.workspace.id, 'csf_engagement_transition', 'csf_engagement', engagement.id, { from: engagement.status, to }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}`, `Engagement moved to ${to}`));
});

// Unassign
app.post('/workspaces/:wsId/csf/:id(\\d+)/unassign/:aid(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
  if (!engagement) return res.status(404).send('Not found');
  if (!csfPolicy.canAssignMembers(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const assign = db.prepare(`SELECT * FROM csf_engagement_assignments WHERE id=? AND engagement_id=?`).get(req.params.aid, engagement.id);
  if (assign) {
    db.prepare(`DELETE FROM csf_engagement_assignments WHERE id=?`).run(assign.id);
    logAction(req.user.id, req.workspace.id, 'csf_assignment_remove', 'csf_engagement', engagement.id, { user_id: assign.user_id, role: assign.role_on_engagement }, auditCtx(req));
  }
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}`);
});

// ---- Stage 3: Subcategory assessment lifecycle ------------------------------

// Helper used by every assess route: load the engagement and confirm view perm.
function loadCsfEngagement(req) {
  const eng = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
  if (!eng) return { error: { status: 404, message: 'CSF engagement not found, or it was deleted.' } };
  if (!csfPolicy.canViewEngagement(db, req.user, eng)) return { error: { status: 403, message: 'You are not assigned to this CSF engagement.' } };
  return { engagement: eng };
}

// Assessment list - all 106 (or filtered) for an engagement.
app.get('/workspaces/:wsId/csf/:id(\\d+)/assess', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  csfPolicy.ensureAssessmentRows(db, engagement);  // lazy seed on first visit

  const fnFilter = req.query.fn || '';
  const statusFilter = req.query.status || '';
  const params = [engagement.id, engagement.catalog_version];
  let where = `a.engagement_id=? AND s.catalog_version=?`;
  if (fnFilter) { where += ` AND f.code=?`; params.push(fnFilter); }
  if (statusFilter) { where += ` AND a.status=?`; params.push(statusFilter); }

  const rows = db.prepare(`
    SELECT a.id AS assessment_id, a.status, a.current_score, a.target_score,
      a.excluded_from_scope, a.is_bulk_set, a.last_edited_at,
      s.id AS subcategory_id, s.code AS sub_code, s.description AS sub_description, s.display_order AS sub_order,
      c.code AS cat_code, c.name AS cat_name, c.display_order AS cat_order,
      f.code AS fn_code, f.name AS fn_name, f.display_order AS fn_order,
      (SELECT COUNT(*) FROM csf_evidence_items e WHERE e.assessment_id=a.id AND e.deleted_at IS NULL) AS evidence_count
    FROM csf_subcategory_assessments a
    INNER JOIN csf_subcategories s ON s.id = a.subcategory_id
    INNER JOIN csf_categories c ON c.id = s.category_id
    INNER JOIN csf_functions f ON f.id = c.function_id
    WHERE ${where}
    ORDER BY f.display_order, c.display_order, s.display_order
  `).all(...params);

  // Stats for the header (ignore filter when computing totals so the user sees
  // overall progress; filter only shapes the table).
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='Not Started' THEN 1 ELSE 0 END) AS not_started,
      SUM(CASE WHEN status='In Progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status='Evidence Collected' THEN 1 ELSE 0 END) AS evidence_collected,
      SUM(CASE WHEN status='Draft Complete' THEN 1 ELSE 0 END) AS draft_complete,
      SUM(CASE WHEN status='Reviewed' THEN 1 ELSE 0 END) AS reviewed,
      SUM(CASE WHEN status='Approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN current_score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
      SUM(CASE WHEN excluded_from_scope=1 THEN 1 ELSE 0 END) AS excluded
    FROM csf_subcategory_assessments WHERE engagement_id=?
  `).get(engagement.id);

  const fns = db.prepare(`SELECT code, name FROM csf_functions WHERE catalog_version=? ORDER BY display_order`).all(engagement.catalog_version);

  res.render('csf_assess', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, rows, stats, fns,
    fnFilter, statusFilter,
    states: csfPolicy.SUBCATEGORY_STATES,
    canBulkScore: csfPolicy.canScoreSubcategory(db, req.user, engagement),
    canBulkTransition: csfPolicy.canCollectEvidence(db, req.user, engagement),
  });
});

// Bulk action - apply same status transition or same score to many subcategories.
app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/bulk', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const action = req.body.action;
  const ids = Array.isArray(req.body.assessment_id) ? req.body.assessment_id : (req.body.assessment_id ? [req.body.assessment_id] : []);
  if (!ids.length) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`);

  let appliedTo = 0;
  if (action === 'set_score') {
    if (!csfPolicy.canScoreSubcategory(db, req.user, engagement)) return res.status(403).send('Forbidden');
    const score = parseInt(req.body.bulk_score, 10);
    if (!(score >= 1 && score <= 5)) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`);
    const upd = db.prepare(`UPDATE csf_subcategory_assessments
      SET current_score=?, is_bulk_set=1, scored_by=?, scored_at=CURRENT_TIMESTAMP,
          last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP
      WHERE id=? AND engagement_id=?
        AND status IN ('Evidence Collected','Draft Complete','Reviewed')`);
    const tx = db.transaction(() => { ids.forEach(id => { appliedTo += upd.run(score, req.user.id, req.user.id, id, engagement.id).changes; }); });
    tx();
    logAction(req.user.id, req.workspace.id, 'csf_bulk_score', 'csf_engagement', engagement.id, { count: appliedTo, score }, auditCtx(req));
  } else if (action === 'transition') {
    const to = req.body.to_state;
    if (!csfPolicy.SUBCATEGORY_STATES.includes(to)) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`);
    // Check permission generally; per-row transition validity is enforced inside the loop.
    const tx = db.transaction(() => {
      ids.forEach(id => {
        const a = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE id=? AND engagement_id=?`).get(id, engagement.id);
        if (!a) return;
        if (!csfPolicy.canTransitionTo(db, req.user, engagement, a, to)) return;
        db.prepare(`UPDATE csf_subcategory_assessments SET status=?, last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(to, req.user.id, id);
        appliedTo++;
      });
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'csf_bulk_transition', 'csf_engagement', engagement.id, { count: appliedTo, to_state: to }, auditCtx(req));
  }
  res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess`, `${appliedTo} subcategor${appliedTo === 1 ? 'y' : 'ies'} updated`));
});

// Subcategory detail (work surface for evidence + narrative + score).
app.get('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  csfPolicy.ensureAssessmentRows(db, engagement);

  const detail = db.prepare(`
    SELECT a.*, s.code AS sub_code, s.description AS sub_description, s.implementation_examples,
      c.code AS cat_code, c.name AS cat_name, c.description AS cat_description,
      f.code AS fn_code, f.name AS fn_name
    FROM csf_subcategory_assessments a
    INNER JOIN csf_subcategories s ON s.id = a.subcategory_id
    INNER JOIN csf_categories c ON c.id = s.category_id
    INNER JOIN csf_functions f ON f.id = c.function_id
    WHERE a.engagement_id=? AND a.subcategory_id=?
  `).get(engagement.id, req.params.subId);
  if (!detail) return res.status(404).render('error', { user: req.user, message: 'Subcategory not found in this engagement.' });

  const evidence = db.prepare(`SELECT * FROM csf_evidence_items WHERE assessment_id=? AND deleted_at IS NULL ORDER BY uploaded_at DESC`).all(detail.id);
  const isoRefs = db.prepare(`SELECT ref_type, ref_value FROM csf_subcategory_iso_refs WHERE subcategory_id=?`).all(detail.subcategory_id);

  // Adjacent navigation for the workflow ("Next" button after saving)
  const adj = db.prepare(`
    SELECT a.subcategory_id, s.code, s.display_order, c.display_order AS c_order, f.display_order AS f_order
    FROM csf_subcategory_assessments a
    INNER JOIN csf_subcategories s ON s.id=a.subcategory_id
    INNER JOIN csf_categories c ON c.id=s.category_id
    INNER JOIN csf_functions f ON f.id=c.function_id
    WHERE a.engagement_id=?
    ORDER BY f.display_order, c.display_order, s.display_order
  `).all(engagement.id);
  const curIdx = adj.findIndex(r => r.subcategory_id === parseInt(req.params.subId, 10));
  const prev = curIdx > 0 ? adj[curIdx - 1] : null;
  const next = curIdx >= 0 && curIdx < adj.length - 1 ? adj[curIdx + 1] : null;

  const next_state_opts = csfPolicy.nextStateOptions(detail.status);
  const allowedNextStates = next_state_opts.filter(s => csfPolicy.canTransitionTo(db, req.user, engagement, detail, s));
  const warnings = csfPolicy.thinnessWarnings(detail, evidence.length);

  // Stage 4: findings on this subcategory + reviewer comments on this assessment
  const findings = db.prepare(`
    SELECT f.*, u.name AS creator,
      (SELECT COUNT(*) FROM csf_recommendations r WHERE r.finding_id=f.id AND r.deleted_at IS NULL) AS rec_count
    FROM csf_findings f
    LEFT JOIN users u ON u.id = f.created_by
    WHERE f.engagement_id=? AND f.assessment_id=? AND f.deleted_at IS NULL
    ORDER BY
      CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
      f.created_at DESC
  `).all(engagement.id, detail.id);
  const findingIds = findings.map(f => f.id);
  const recsByFinding = {};
  if (findingIds.length) {
    const placeholders = findingIds.map(() => '?').join(',');
    const recs = db.prepare(`SELECT * FROM csf_recommendations WHERE finding_id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at`).all(...findingIds);
    recs.forEach(r => { (recsByFinding[r.finding_id] = recsByFinding[r.finding_id] || []).push(r); });
  }
  const comments = db.prepare(`
    SELECT c.*, u.name AS commenter_name
    FROM csf_reviewer_comments c
    INNER JOIN users u ON u.id = c.commenter_id
    WHERE c.engagement_id=? AND c.assessment_id=? AND c.deleted_at IS NULL
    ORDER BY c.created_at DESC
  `).all(engagement.id, detail.id);

  // ---- Stage 11: Analyst content for this subcategory ----
  const explainer = db.prepare(`SELECT * FROM csf_subcategory_explainers WHERE subcategory_id=?`).get(detail.subcategory_id);
  const questions = db.prepare(`SELECT * FROM csf_subcategory_questions WHERE subcategory_id=? ORDER BY display_order`).all(detail.subcategory_id);
  const prompts = db.prepare(`SELECT * FROM csf_subcategory_evidence_prompts WHERE subcategory_id=? ORDER BY display_order`).all(detail.subcategory_id);
  const selfCheckPrompts = db.prepare(`SELECT prompt FROM csf_self_check_prompts ORDER BY display_order`).all().map(r => r.prompt);
  const narrativeSections = csfPolicy.parseStructuredNarrative(detail.narrative);

  res.render('csf_assess_detail', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, detail, evidence, isoRefs,
    prev, next,
    allowedNextStates,
    warnings,
    findings, recsByFinding, comments,
    canEnterScore: csfPolicy.canEnterScore(db, req.user, engagement, detail),
    canCollect: csfPolicy.canCollectEvidence(db, req.user, engagement),
    canCreateFinding: csfPolicy.canCreateFinding(db, req.user, engagement),
    canManageRecs: csfPolicy.canManageRecommendations(db, req.user, engagement),
    canPostComment: csfPolicy.canPostReviewerComment(db, req.user, engagement),
    severities: csfPolicy.FINDING_SEVERITIES,
    efforts: csfPolicy.RECOMMENDATION_EFFORTS,
    priorities: csfPolicy.RECOMMENDATION_PRIORITIES,
    phases: csfPolicy.ROADMAP_PHASES,
    // Stage 11
    explainer, questions, prompts, selfCheckPrompts, narrativeSections,
    narrativeSectionDefs: csfPolicy.NARRATIVE_SECTIONS,
  });
});

// Update narrative / scores / exclusion. Score updates are gated by state.
app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
  if (!assess) return res.status(404).send('Not found');
  if (!csfPolicy.canCollectEvidence(db, req.user, engagement)) return res.status(403).send('Forbidden');

  const b = req.body;
  const sets = []; const vals = [];

  // Structured narrative (Stage 11): 4 sub-fields combine into the single
  // narrative TEXT column. Falls back to b.narrative for legacy callers.
  const hasStructured = ['narrative_practice_observed', 'narrative_evidence_reviewed', 'narrative_gaps_or_concerns', 'narrative_follow_up_needed']
    .some(k => b[k] !== undefined);
  if (hasStructured) {
    const combined = csfPolicy.buildStructuredNarrative({
      practice_observed: b.narrative_practice_observed || '',
      evidence_reviewed: b.narrative_evidence_reviewed || '',
      gaps_or_concerns: b.narrative_gaps_or_concerns || '',
      follow_up_needed: b.narrative_follow_up_needed || '',
    });
    sets.push('narrative=?', 'narrative_drafted_by=?', 'narrative_drafted_at=CURRENT_TIMESTAMP');
    vals.push(combined, req.user.id);
  } else if (b.narrative !== undefined) {
    sets.push('narrative=?', 'narrative_drafted_by=?', 'narrative_drafted_at=CURRENT_TIMESTAMP');
    vals.push(b.narrative.trim(), req.user.id);
  }
  if (b.excluded_from_scope !== undefined) {
    const excluded = b.excluded_from_scope === '1' || b.excluded_from_scope === 'on' ? 1 : 0;
    sets.push('excluded_from_scope=?');
    vals.push(excluded);
    if (excluded) { sets.push('exclusion_rationale=?'); vals.push((b.exclusion_rationale || '').trim() || null); }
    else { sets.push('exclusion_rationale=NULL'); }
  }
  // Score updates: gated. Allow null to clear; allow 1-5; reject everything else.
  if (b.current_score !== undefined) {
    if (!csfPolicy.canEnterScore(db, req.user, engagement, assess)) return res.status(403).send('Cannot enter score: requires Consultant/Lead role and Evidence Collected state.');
    const v = b.current_score === '' ? null : parseInt(b.current_score, 10);
    if (v !== null && !(v >= 1 && v <= 5)) return res.status(400).send('current_score must be 1-5 or empty');
    sets.push('current_score=?', 'scored_by=?', 'scored_at=CURRENT_TIMESTAMP', 'is_bulk_set=0');
    vals.push(v, req.user.id);
  }
  if (b.target_score !== undefined && engagement.scope_mode === 'CURRENT_TARGET') {
    if (!csfPolicy.canEnterScore(db, req.user, engagement, assess)) return res.status(403).send('Cannot enter score: requires Consultant/Lead role and Evidence Collected state.');
    const v = b.target_score === '' ? null : parseInt(b.target_score, 10);
    if (v !== null && !(v >= 1 && v <= 5)) return res.status(400).send('target_score must be 1-5 or empty');
    sets.push('target_score=?');
    vals.push(v);
  }

  if (sets.length) {
    sets.push('last_edited_by=?', 'last_edited_at=CURRENT_TIMESTAMP');
    vals.push(req.user.id);
    vals.push(assess.id);
    db.prepare(`UPDATE csf_subcategory_assessments SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'csf_assessment_update', 'csf_subcategory_assessment', assess.id, Object.keys(b).filter(k => k !== '_csrf'), auditCtx(req));
  }
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
});

// State transition.
app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)/transition', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
  if (!assess) return res.status(404).send('Not found');
  const to = req.body.to_state;
  if (!csfPolicy.canTransitionTo(db, req.user, engagement, assess, to)) return res.status(403).send('Transition not allowed.');

  // Stamp the right "by/at" fields so the audit trail in deliverables shows
  // who moved each subcategory through each gate.
  const sets = ['status=?', 'last_edited_by=?', 'last_edited_at=CURRENT_TIMESTAMP'];
  const vals = [to, req.user.id];
  if (to === 'Evidence Collected') { sets.push('evidence_collected_by=?', 'evidence_collected_at=CURRENT_TIMESTAMP'); vals.push(req.user.id); }
  if (to === 'Reviewed') { sets.push('reviewed_by=?', 'reviewed_at=CURRENT_TIMESTAMP'); vals.push(req.user.id); }
  vals.push(assess.id);
  db.prepare(`UPDATE csf_subcategory_assessments SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  logAction(req.user.id, req.workspace.id, 'csf_assessment_transition', 'csf_subcategory_assessment', assess.id, { from: assess.status, to }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
});

// Add evidence (FILE | LINK | INTERVIEW). Multer mounts per-route so multipart
// parsing only happens for this endpoint; CSRF token must be appended to the
// URL for multipart bodies (see lib/csrf.js comment).
app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)/evidence', requireAuth, requireWorkspace, upload.single('file'), (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
  if (!assess) return res.status(404).send('Not found');
  if (!csfPolicy.canCollectEvidence(db, req.user, engagement)) return res.status(403).send('Forbidden');

  const type = (req.body.type || 'LINK').toUpperCase();
  if (!['FILE', 'LINK', 'INTERVIEW'].includes(type)) return res.status(400).send('type must be FILE | LINK | INTERVIEW');

  const filePath = type === 'FILE' && req.file ? req.file.filename : null;
  const url = type === 'LINK' ? (req.body.url || '').trim() || null : null;
  const interviewSource = type === 'INTERVIEW' ? (req.body.interview_source || '').trim() || null : null;
  const description = (req.body.description || '').trim() || null;
  const visibleToClient = req.body.visible_to_client === '1' || req.body.visible_to_client === 'on' ? 1 : 0;

  if (type === 'FILE' && !filePath) return res.status(400).send('FILE evidence requires a file upload');
  if (type === 'LINK' && !url) return res.status(400).send('LINK evidence requires a url');
  if (type === 'INTERVIEW' && !interviewSource) return res.status(400).send('INTERVIEW evidence requires the interview source attribution');

  const evId = db.prepare(`
    INSERT INTO csf_evidence_items (assessment_id, type, file_path, url, interview_source, description, visible_to_client, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(assess.id, type, filePath, url, interviewSource, description, visibleToClient, req.user.id).lastInsertRowid;

  // Auto-advance Not Started → In Progress on first evidence (gentle nudge through the state machine).
  if (assess.status === 'Not Started') {
    db.prepare(`UPDATE csf_subcategory_assessments SET status='In Progress', last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, assess.id);
  }
  logAction(req.user.id, req.workspace.id, 'csf_evidence_add', 'csf_subcategory_assessment', assess.id, { evidence_id: evId, type }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
});

// Soft-delete evidence (decision #21).
app.post('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)/evidence/:evId(\\d+)/delete', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (!csfPolicy.canCollectEvidence(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? AND subcategory_id=?`).get(engagement.id, req.params.subId);
  if (!assess) return res.status(404).send('Not found');
  db.prepare(`UPDATE csf_evidence_items SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND assessment_id=?`).run(req.params.evId, assess.id);
  logAction(req.user.id, req.workspace.id, 'csf_evidence_delete', 'csf_evidence_item', req.params.evId, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${req.params.subId}`);
});

// ---- Stage 4: Findings, Recommendations, Reviewer comments ------------------

// Engagement-level findings list (all findings across the engagement).
app.get('/workspaces/:wsId/csf/:id(\\d+)/findings', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  const findings = db.prepare(`
    SELECT f.*, u.name AS creator,
      s.code AS sub_code, s.id AS subcategory_id,
      (SELECT COUNT(*) FROM csf_recommendations r WHERE r.finding_id=f.id AND r.deleted_at IS NULL) AS rec_count
    FROM csf_findings f
    LEFT JOIN users u ON u.id = f.created_by
    LEFT JOIN csf_subcategory_assessments a ON a.id = f.assessment_id
    LEFT JOIN csf_subcategories s ON s.id = a.subcategory_id
    WHERE f.engagement_id=? AND f.deleted_at IS NULL
    ORDER BY
      CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
      f.created_at DESC
  `).all(engagement.id);
  res.render('csf_findings', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, findings,
    severities: csfPolicy.FINDING_SEVERITIES,
    canCreate: csfPolicy.canCreateFinding(db, req.user, engagement),
  });
});

// Create a finding. assessment_id from body is optional (engagement-level
// theme when omitted).
app.post('/workspaces/:wsId/csf/:id(\\d+)/findings', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (!csfPolicy.canCreateFinding(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const b = req.body;
  if (!b.title || !b.title.trim()) return redirectBack(req, res, 'Title is required', 'error');
  const severity = csfPolicy.FINDING_SEVERITIES.includes(b.severity) ? b.severity : 'MEDIUM';
  const assessmentId = b.assessment_id ? parseInt(b.assessment_id, 10) : null;
  const promoted = b.promoted_to_engagement_theme === '1' || !assessmentId ? 1 : 0;
  const findingId = db.prepare(`
    INSERT INTO csf_findings (engagement_id, assessment_id, title, description, severity, status, promoted_to_engagement_theme, created_by)
    VALUES (?, ?, ?, ?, ?, 'Draft', ?, ?)
  `).run(engagement.id, assessmentId, b.title.trim(), (b.description || '').trim() || null, severity, promoted, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'csf_finding_create', 'csf_finding', findingId, { title: b.title, severity }, auditCtx(req));
  // Redirect back to where the user came from: subcategory detail if attached, else findings list.
  if (assessmentId) {
    const sub = db.prepare(`SELECT subcategory_id FROM csf_subcategory_assessments WHERE id=?`).get(assessmentId);
    if (sub) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${sub.subcategory_id}`);
  }
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// Update a finding (title / description / severity / status / promote).
app.post('/workspaces/:wsId/csf/:id(\\d+)/findings/:findingId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const finding = db.prepare(`SELECT * FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.findingId, engagement.id);
  if (!finding) return res.status(404).send('Not found');
  if (!csfPolicy.canEditFinding(db, req.user, engagement, finding)) return res.status(403).send('Forbidden');
  const b = req.body;
  const sets = []; const vals = [];
  if (b.title !== undefined) { sets.push('title=?'); vals.push(b.title.trim()); }
  if (b.description !== undefined) { sets.push('description=?'); vals.push((b.description || '').trim() || null); }
  if (b.severity !== undefined && csfPolicy.FINDING_SEVERITIES.includes(b.severity)) { sets.push('severity=?'); vals.push(b.severity); }
  if (b.status !== undefined && csfPolicy.FINDING_STATUSES.includes(b.status)) { sets.push('status=?'); vals.push(b.status); }
  if (b.promoted_to_engagement_theme !== undefined) {
    const v = b.promoted_to_engagement_theme === '1' || b.promoted_to_engagement_theme === 'on' ? 1 : 0;
    sets.push('promoted_to_engagement_theme=?'); vals.push(v);
  }
  if (sets.length) {
    sets.push('updated_at=CURRENT_TIMESTAMP');
    vals.push(finding.id);
    db.prepare(`UPDATE csf_findings SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'csf_finding_update', 'csf_finding', finding.id, Object.keys(b).filter(k => k !== '_csrf'), auditCtx(req));
  }
  res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// Soft-delete a finding.
app.post('/workspaces/:wsId/csf/:id(\\d+)/findings/:findingId(\\d+)/delete', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const finding = db.prepare(`SELECT * FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.findingId, engagement.id);
  if (!finding) return res.status(404).send('Not found');
  if (!csfPolicy.canDeleteFinding(db, req.user, engagement, finding)) return res.status(403).send('Forbidden');
  db.prepare(`UPDATE csf_findings SET deleted_at=CURRENT_TIMESTAMP WHERE id=?`).run(finding.id);
  logAction(req.user.id, req.workspace.id, 'csf_finding_delete', 'csf_finding', finding.id, null, auditCtx(req));
  res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// Add a recommendation to a finding.
app.post('/workspaces/:wsId/csf/:id(\\d+)/findings/:findingId(\\d+)/recommendations', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (!csfPolicy.canManageRecommendations(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const finding = db.prepare(`SELECT * FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.findingId, engagement.id);
  if (!finding) return res.status(404).send('Not found');
  const b = req.body;
  if (!b.description || !b.description.trim()) return redirectBack(req, res, 'Recommendation text is required', 'error');
  const effort = csfPolicy.RECOMMENDATION_EFFORTS.includes(b.estimated_effort) ? b.estimated_effort : null;
  const priority = csfPolicy.RECOMMENDATION_PRIORITIES.includes(b.priority) ? b.priority : null;
  const phase = csfPolicy.ROADMAP_PHASES.includes(b.roadmap_phase) ? b.roadmap_phase : null;
  const recId = db.prepare(`
    INSERT INTO csf_recommendations (finding_id, description, estimated_effort, priority, target_completion_date, roadmap_phase, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(finding.id, b.description.trim(), effort, priority, b.target_completion_date || null, phase, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'csf_recommendation_create', 'csf_recommendation', recId, { finding_id: finding.id }, auditCtx(req));
  res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// Update a recommendation.
app.post('/workspaces/:wsId/csf/:id(\\d+)/recommendations/:recId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (!csfPolicy.canManageRecommendations(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const rec = db.prepare(`
    SELECT r.* FROM csf_recommendations r
    INNER JOIN csf_findings f ON f.id = r.finding_id
    WHERE r.id=? AND f.engagement_id=? AND r.deleted_at IS NULL
  `).get(req.params.recId, engagement.id);
  if (!rec) return res.status(404).send('Not found');
  const b = req.body;
  const sets = []; const vals = [];
  if (b.description !== undefined) { sets.push('description=?'); vals.push(b.description.trim()); }
  if (b.estimated_effort !== undefined) { sets.push('estimated_effort=?'); vals.push(csfPolicy.RECOMMENDATION_EFFORTS.includes(b.estimated_effort) ? b.estimated_effort : null); }
  if (b.priority !== undefined) { sets.push('priority=?'); vals.push(csfPolicy.RECOMMENDATION_PRIORITIES.includes(b.priority) ? b.priority : null); }
  if (b.target_completion_date !== undefined) { sets.push('target_completion_date=?'); vals.push(b.target_completion_date || null); }
  if (b.roadmap_phase !== undefined) { sets.push('roadmap_phase=?'); vals.push(csfPolicy.ROADMAP_PHASES.includes(b.roadmap_phase) ? b.roadmap_phase : null); }
  if (sets.length) {
    vals.push(rec.id);
    db.prepare(`UPDATE csf_recommendations SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    logAction(req.user.id, req.workspace.id, 'csf_recommendation_update', 'csf_recommendation', rec.id, Object.keys(b).filter(k => k !== '_csrf'), auditCtx(req));
  }
  res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// Soft-delete a recommendation.
app.post('/workspaces/:wsId/csf/:id(\\d+)/recommendations/:recId(\\d+)/delete', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (!csfPolicy.canManageRecommendations(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const rec = db.prepare(`
    SELECT r.* FROM csf_recommendations r
    INNER JOIN csf_findings f ON f.id = r.finding_id
    WHERE r.id=? AND f.engagement_id=? AND r.deleted_at IS NULL
  `).get(req.params.recId, engagement.id);
  if (!rec) return res.status(404).send('Not found');
  db.prepare(`UPDATE csf_recommendations SET deleted_at=CURRENT_TIMESTAMP WHERE id=?`).run(rec.id);
  logAction(req.user.id, req.workspace.id, 'csf_recommendation_delete', 'csf_recommendation', rec.id, null, auditCtx(req));
  res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// Post a reviewer comment. Body may target an assessment OR a finding.
// requires_revision on an assessment in Reviewed state reopens it.
app.post('/workspaces/:wsId/csf/:id(\\d+)/comments', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (!csfPolicy.canPostReviewerComment(db, req.user, engagement)) return res.status(403).send('Forbidden');
  const b = req.body;
  if (!b.text || !b.text.trim()) return redirectBack(req, res, 'Comment text is required', 'error');
  const assessmentId = b.assessment_id ? parseInt(b.assessment_id, 10) : null;
  const findingId = b.finding_id ? parseInt(b.finding_id, 10) : null;
  if (!assessmentId && !findingId) return res.status(400).send('Comment must target an assessment or a finding');
  const requiresRevision = b.requires_revision === '1' || b.requires_revision === 'on' ? 1 : 0;

  const tx = db.transaction(() => {
    const commentId = db.prepare(`
      INSERT INTO csf_reviewer_comments (engagement_id, assessment_id, finding_id, commenter_id, text, requires_revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(engagement.id, assessmentId, findingId, req.user.id, b.text.trim(), requiresRevision).lastInsertRowid;

    // Needs Revision: reopen the assessment if it had reached Reviewed.
    if (assessmentId) {
      const assess = db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE id=?`).get(assessmentId);
      if (csfPolicy.shouldReopenAssessment({ requires_revision: requiresRevision }, assess)) {
        db.prepare(`UPDATE csf_subcategory_assessments SET status='Draft Complete', last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, assessmentId);
        logAction(req.user.id, req.workspace.id, 'csf_assessment_reopen', 'csf_subcategory_assessment', assessmentId, { from: 'Reviewed', to: 'Draft Complete', reason: 'Needs Revision', comment_id: commentId }, auditCtx(req));
      }
    }
    return commentId;
  });
  const commentId = tx();
  logAction(req.user.id, req.workspace.id, 'csf_comment_create', 'csf_reviewer_comment', commentId, { assessment_id: assessmentId, finding_id: findingId, requires_revision: requiresRevision }, auditCtx(req));

  if (assessmentId) {
    const sub = db.prepare(`SELECT subcategory_id FROM csf_subcategory_assessments WHERE id=?`).get(assessmentId);
    if (sub) return res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${sub.subcategory_id}`);
  }
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// ---- Stage 5: Scoring rollup ------------------------------------------------
const csfScoring = require('./lib/csf-scoring');

app.get('/workspaces/:wsId/csf/:id(\\d+)/scores', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  csfPolicy.ensureAssessmentRows(db, engagement);
  const rollup = csfScoring.computeEngagementRollup(db, engagement);
  res.render('csf_scores', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, rollup,
    r1: csfScoring.r1,
  });
});

// ---- Stage 7: Versions + snapshots ------------------------------------------
const csfVersioning = require('./lib/csf-versioning');

// First publish: Approved -> Published, create v1.0 snapshot.
app.post('/workspaces/:wsId/csf/:id(\\d+)/publish', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (!csfPolicy.canPublish(db, req.user, engagement)) return res.status(403).send('Forbidden: only the Engagement Lead can publish an Approved engagement.');

  const versionNumber = csfVersioning.nextVersionNumber(db, engagement); // 1.0 on first call
  const versionId = csfVersioning.createSnapshot(db, engagement, versionNumber, req.user.id, (req.body.change_summary || '').trim() || 'Initial publish');
  db.prepare(`UPDATE csf_engagements SET status='Published', current_version=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(versionNumber, engagement.id);
  logAction(req.user.id, req.workspace.id, 'csf_engagement_publish', 'csf_engagement', engagement.id, { version_id: versionId, version_number: versionNumber }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}`, `Engagement published as v${versionNumber}`));
});

// Republish: engagement stays Published, increment version, require change_summary.
app.post('/workspaces/:wsId/csf/:id(\\d+)/republish', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  if (engagement.status !== 'Published') return res.status(400).send('Only Published engagements can be republished.');
  if (!csfPolicy.canPublish(db, req.user, engagement)) return res.status(403).send('Forbidden: only the Engagement Lead can republish.');
  const summary = (req.body.change_summary || '').trim();
  if (!summary) return redirectBack(req, res, 'Change summary is required for a republish', 'error');

  const versionNumber = csfVersioning.nextVersionNumber(db, engagement);
  const versionId = csfVersioning.createSnapshot(db, engagement, versionNumber, req.user.id, summary);
  db.prepare(`UPDATE csf_engagements SET current_version=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(versionNumber, engagement.id);
  logAction(req.user.id, req.workspace.id, 'csf_engagement_republish', 'csf_engagement', engagement.id, { version_id: versionId, version_number: versionNumber }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${engagement.id}/versions/${versionId}`, `Republished as v${versionNumber}`));
});

// Versions list.
app.get('/workspaces/:wsId/csf/:id(\\d+)/versions', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  const versions = db.prepare(`
    SELECT v.*, u.name AS publisher_name,
      (SELECT COUNT(*) FROM csf_subcategory_assessment_snapshots s WHERE s.version_id=v.id) AS sub_count,
      (SELECT COUNT(*) FROM csf_finding_snapshots fs WHERE fs.version_id=v.id) AS finding_count
    FROM csf_engagement_versions v
    LEFT JOIN users u ON u.id = v.published_by
    WHERE v.engagement_id=? ORDER BY v.published_at DESC
  `).all(engagement.id);
  res.render('csf_versions', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, versions,
    canPublish: csfPolicy.canPublish(db, req.user, engagement),
    canRepublish: engagement.status === 'Published' && csfPolicy.canPublish(db, req.user, { ...engagement, status: 'Approved' }),  // policy.canPublish requires status=Approved; for republish we override
  });
});

// Version detail - snapshot view.
app.get('/workspaces/:wsId/csf/:id(\\d+)/versions/:vid(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  const version = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.params.vid, engagement.id);
  if (!version) return res.status(404).render('error', { user: req.user, message: 'Version not found in this engagement.' });
  const rollup = csfVersioning.loadSnapshotRollup(db, version);
  const findingSnaps = db.prepare(`
    SELECT fs.*, s.code AS sub_code
    FROM csf_finding_snapshots fs
    LEFT JOIN csf_subcategories s ON s.id = fs.subcategory_id
    WHERE fs.version_id=?
    ORDER BY CASE fs.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
  `).all(version.id);
  const otherVersions = db.prepare(`SELECT id, version_number FROM csf_engagement_versions WHERE engagement_id=? AND id != ? ORDER BY published_at DESC`).all(engagement.id, version.id);
  res.render('csf_version_detail', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, version, rollup, findingSnaps, otherVersions,
    r1: csfScoring.r1,
  });
});

// ---- Stage 11: Ask my Lead + Learn section ----------------------------------
// Reuse the existing top-level MarkdownIt import (line 12) for rendering
// Learn docs.
const csfLearnMd = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Ask my Lead - send a question.
app.post('/workspaces/:wsId/csf/:id(\\d+)/ask-lead', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const body = (req.body.body || '').trim();
  if (!body) return redirectBack(req, res, 'Message body required', 'error');
  const subject = (req.body.subject || '').trim() || null;
  const subId = req.body.subcategory_id ? parseInt(req.body.subcategory_id, 10) : null;
  const recipient = engagement.assigned_lead_id;
  const msgId = db.prepare(`
    INSERT INTO csf_ask_lead_messages (engagement_id, sender_id, recipient_id, subcategory_id, subject, body)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(engagement.id, req.user.id, recipient, subId, subject, body).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'csf_ask_lead_send', 'csf_ask_lead_message', msgId, { recipient }, auditCtx(req));
  const back = req.body.return_to || (subId
    ? `/workspaces/${req.workspace.id}/csf/${engagement.id}/assess/${subId}`
    : `/workspaces/${req.workspace.id}/csf/${engagement.id}`);
  res.redirect(withToast(back, 'Message sent to Lead'));
});

// Inbox view - all ask-lead messages for this engagement.
app.get('/workspaces/:wsId/csf/:id(\\d+)/ask-lead', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  const messages = db.prepare(`
    SELECT m.*, sender.name AS sender_name, recipient.name AS recipient_name,
      s.code AS sub_code
    FROM csf_ask_lead_messages m
    INNER JOIN users sender ON sender.id = m.sender_id
    LEFT JOIN users recipient ON recipient.id = m.recipient_id
    LEFT JOIN csf_subcategories s ON s.id = m.subcategory_id
    WHERE m.engagement_id=? AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC
  `).all(engagement.id);
  // Mark messages addressed to current user as read.
  db.prepare(`UPDATE csf_ask_lead_messages SET read_at=CURRENT_TIMESTAMP WHERE engagement_id=? AND recipient_id=? AND read_at IS NULL`).run(engagement.id, req.user.id);
  res.render('csf_ask_lead', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, messages,
  });
});

// Reply to an ask-lead message.
app.post('/workspaces/:wsId/csf/:id(\\d+)/ask-lead/:msgId(\\d+)/reply', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const original = db.prepare(`SELECT * FROM csf_ask_lead_messages WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.msgId, engagement.id);
  if (!original) return res.status(404).send('Message not found');
  const body = (req.body.body || '').trim();
  if (!body) return redirectBack(req, res, 'Reply body required', 'error');
  const tx = db.transaction(() => {
    const replyId = db.prepare(`
      INSERT INTO csf_ask_lead_messages (engagement_id, sender_id, recipient_id, subcategory_id, in_reply_to, subject, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(engagement.id, req.user.id, original.sender_id, original.subcategory_id, original.id, original.subject ? `Re: ${original.subject}` : null, body).lastInsertRowid;
    db.prepare(`UPDATE csf_ask_lead_messages SET replied_at=CURRENT_TIMESTAMP WHERE id=?`).run(original.id);
    return replyId;
  });
  const replyId = tx();
  logAction(req.user.id, req.workspace.id, 'csf_ask_lead_reply', 'csf_ask_lead_message', replyId, { in_reply_to: original.id }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/ask-lead`);
});

// Learn section - workspace-scoped index + reader.
app.get('/workspaces/:wsId/csf/learn', requireAuth, requireWorkspace, (req, res) => {
  const docs = db.prepare(`SELECT id, slug, title, summary FROM csf_learn_docs ORDER BY display_order, title`).all();
  res.render('csf_learn', { user: req.user, ws: req.workspace, active: 'csf-learn', docs });
});

app.get('/workspaces/:wsId/csf/learn/:slug', requireAuth, requireWorkspace, (req, res) => {
  const doc = db.prepare(`SELECT * FROM csf_learn_docs WHERE slug=?`).get(req.params.slug);
  if (!doc) return res.status(404).render('error', { user: req.user, message: 'Learn document not found.' });
  const otherDocs = db.prepare(`SELECT slug, title FROM csf_learn_docs WHERE slug != ? ORDER BY display_order`).all(req.params.slug);
  res.render('csf_learn_doc', {
    user: req.user, ws: req.workspace, active: 'csf-learn',
    doc, otherDocs, html: csfLearnMd.render(doc.body_markdown || ''),
  });
});

// ---- Stage 9: Client portal -------------------------------------------------
// Read-mostly view of a Published engagement. In prototype mode (auth deferred)
// anyone with workspace access can hit this; real client-user auth comes in
// Stage 13. The portal shows the current Published version's data plus the
// live remediation tracker (decision #34: snapshot-at-publish except for
// remediation, which stays live).

const REMEDIATION_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED'];

app.get('/workspaces/:wsId/csf/:id(\\d+)/portal', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });

  // Pick the current published version. If never published, show the empty
  // state - the portal is a published-data surface by design.
  const currentVersion = db.prepare(`
    SELECT * FROM csf_engagement_versions WHERE engagement_id=? AND is_current=1 LIMIT 1
  `).get(engagement.id);

  if (!currentVersion) {
    return res.render('csf_portal', {
      user: req.user, ws: req.workspace, active: 'csf',
      engagement, currentVersion: null,
    });
  }

  const rollup = csfVersioning.loadSnapshotRollup(db, currentVersion);
  const allVersions = db.prepare(`SELECT id, version_number, published_at FROM csf_engagement_versions WHERE engagement_id=? ORDER BY published_at DESC`).all(engagement.id);

  // Snapshot findings + live remediation status joined onto live recommendations.
  const findingSnaps = db.prepare(`
    SELECT fs.*, s.code AS sub_code
    FROM csf_finding_snapshots fs
    LEFT JOIN csf_subcategories s ON s.id = fs.subcategory_id
    WHERE fs.version_id=?
    ORDER BY CASE fs.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
  `).all(currentVersion.id);
  const recSnaps = db.prepare(`
    SELECT rs.*, rstat.status AS rem_status, rstat.client_note AS rem_note, rstat.updated_at AS rem_updated_at,
      f.title AS finding_title, f.severity AS finding_severity
    FROM csf_recommendation_snapshots rs
    LEFT JOIN csf_remediation_status rstat ON rstat.recommendation_id = rs.recommendation_id
    LEFT JOIN csf_finding_snapshots f ON f.finding_id = rs.finding_id AND f.version_id = rs.version_id
    WHERE rs.version_id=?
  `).all(currentVersion.id);

  // Comments on findings (client side). Empty in prototype until client users exist.
  const clientComments = db.prepare(`
    SELECT cc.*, u.name AS commenter_name FROM csf_client_comments cc
    INNER JOIN users u ON u.id = cc.client_user_id
    INNER JOIN csf_findings f ON f.id = cc.finding_id
    WHERE f.engagement_id=? AND cc.deleted_at IS NULL ORDER BY cc.created_at DESC LIMIT 50
  `).all(engagement.id);

  res.render('csf_portal', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, currentVersion, allVersions, rollup,
    findingSnaps, recSnaps, clientComments,
    REMEDIATION_STATUSES,
    r1: csfScoring.r1,
  });
});

// Update remediation status for a recommendation.
app.post('/workspaces/:wsId/csf/:id(\\d+)/portal/remediation/:recId(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
  if (!engagement) return res.status(404).send('Not found');
  if (engagement.status !== 'Published') return res.status(400).send('Remediation tracker is only available after publish.');

  const status = req.body.status;
  if (!REMEDIATION_STATUSES.includes(status)) return res.status(400).send('Bad status');
  const note = (req.body.client_note || '').trim() || null;
  const url = (req.body.client_evidence_url || '').trim() || null;

  // Verify recommendation belongs to this engagement.
  const rec = db.prepare(`
    SELECT r.id FROM csf_recommendations r
    INNER JOIN csf_findings f ON f.id = r.finding_id
    WHERE r.id=? AND f.engagement_id=?
  `).get(req.params.recId, engagement.id);
  if (!rec) return res.status(404).send('Recommendation not found');

  db.prepare(`
    INSERT INTO csf_remediation_status (recommendation_id, status, client_evidence_url, client_note, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(recommendation_id) DO UPDATE SET
      status=excluded.status, client_evidence_url=excluded.client_evidence_url,
      client_note=excluded.client_note, updated_by=excluded.updated_by,
      updated_at=CURRENT_TIMESTAMP
  `).run(rec.id, status, url, note, req.user.id);

  logAction(req.user.id, req.workspace.id, 'csf_remediation_update', 'csf_recommendation', rec.id, { status }, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/portal#rec-${rec.id}`);
});

// Client comment on a finding.
app.post('/workspaces/:wsId/csf/:id(\\d+)/portal/comments', requireAuth, requireWorkspace, (req, res) => {
  const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=? AND workspace_id=? AND deleted_at IS NULL`).get(req.params.id, req.workspace.id);
  if (!engagement) return res.status(404).send('Not found');
  if (engagement.status !== 'Published') return res.status(400).send('Comments only available after publish.');
  const findingId = parseInt(req.body.finding_id, 10);
  const text = (req.body.text || '').trim();
  if (!findingId || !text) return redirectBack(req, res, 'Comment text and finding id required', 'error');

  const f = db.prepare(`SELECT id FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(findingId, engagement.id);
  if (!f) return res.status(404).send('Finding not found');

  db.prepare(`INSERT INTO csf_client_comments (finding_id, client_user_id, text) VALUES (?, ?, ?)`).run(f.id, req.user.id, text);
  logAction(req.user.id, req.workspace.id, 'csf_client_comment', 'csf_finding', f.id, {}, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/csf/${engagement.id}/portal#comments`);
});

// ---- Stage 8: Reports + CSV export ------------------------------------------
const csfReports = require('./lib/csf-reports');

// Word: live engagement (draft watermark) OR a specific version (vid query param).
app.get('/workspaces/:wsId/csf/:id(\\d+)/exports/report.docx', requireAuth, requireWorkspace, async (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  csfPolicy.ensureAssessmentRows(db, engagement);

  let rollup, versionRow = null, isDraft;
  if (req.query.vid) {
    versionRow = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.query.vid, engagement.id);
    if (!versionRow) return res.status(404).send('Version not found in this engagement.');
    rollup = csfVersioning.loadSnapshotRollup(db, versionRow);
    isDraft = false;
  } else {
    rollup = csfScoring.computeEngagementRollup(db, engagement);
    isDraft = true;
  }

  const firm = db.prepare(`SELECT name FROM firms WHERE id=?`).get(req.workspace.firm_id);
  const buf = await csfReports.buildWordReport({ db, engagement, ws: req.workspace, firm, currentRollup: rollup, isDraft, versionRow });
  const filename = `csf-report-${(engagement.name || 'engagement').replace(/[^\w.-]+/g, '_')}-${versionRow ? 'v' + versionRow.version_number : 'DRAFT'}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
  logAction(req.user.id, req.workspace.id, 'csf_report_export_docx', 'csf_engagement', engagement.id, { version_id: versionRow?.id || null }, auditCtx(req));
});

// CSV: one row per Subcategory. Stage 12 adds optional filters via query
// params (?fn=GV, ?status=Approved, ?scored=1). Filters are advisory; the
// rollup math is recomputed only against the kept rows so a filtered export
// stays internally consistent.
app.get('/workspaces/:wsId/csf/:id(\\d+)/exports/data.csv', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  csfPolicy.ensureAssessmentRows(db, engagement);
  const rollup = csfScoring.computeEngagementRollup(db, engagement);

  // Apply optional filters by trimming the rollup tree client-side. The CSV
  // builder iterates the supplied tree, so this is enough.
  const fnFilter = (req.query.fn || '').toUpperCase();
  const statusFilter = req.query.status || '';
  const scoredOnly = req.query.scored === '1';
  const excludedOnly = req.query.excluded === '1';

  if (fnFilter || statusFilter || scoredOnly || excludedOnly) {
    const filtered = JSON.parse(JSON.stringify(rollup));
    if (fnFilter) filtered.functions = filtered.functions.filter(f => f.code === fnFilter);
    for (const fn of filtered.functions) {
      for (const cat of fn.categories) {
        cat.subcategories = cat.subcategories.filter(s => {
          if (scoredOnly && s.current == null) return false;
          if (excludedOnly && !s.excluded) return false;
          if (statusFilter && s.status !== statusFilter) return false;
          return true;
        });
      }
      // Drop empty categories so the CSV doesn't have trailing nothing.
      fn.categories = fn.categories.filter(c => c.subcategories.length);
    }
    filtered.functions = filtered.functions.filter(f => f.categories.length);
    rollup.functions = filtered.functions;
  }

  const csv = csfReports.buildCsvExport({ db, engagement, currentRollup: rollup });
  const filterSuffix = [fnFilter, statusFilter && statusFilter.replace(/\s+/g, '_'), scoredOnly && 'scored', excludedOnly && 'excluded'].filter(Boolean).join('-');
  const filename = `csf-data-${(engagement.name || 'engagement').replace(/[^\w.-]+/g, '_')}${filterSuffix ? '-' + filterSuffix : ''}-${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
  logAction(req.user.id, req.workspace.id, 'csf_report_export_csv', 'csf_engagement', engagement.id, { filters: { fn: fnFilter, status: statusFilter, scoredOnly, excludedOnly } }, auditCtx(req));
});

// Diff between two versions.
app.get('/workspaces/:wsId/csf/:id(\\d+)/versions/:vid(\\d+)/diff/:against(\\d+)', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).render('error', { user: req.user, message: error.message });
  const newVer = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.params.vid, engagement.id);
  const oldVer = db.prepare(`SELECT * FROM csf_engagement_versions WHERE id=? AND engagement_id=?`).get(req.params.against, engagement.id);
  if (!newVer || !oldVer) return res.status(404).render('error', { user: req.user, message: 'One or both versions not found.' });
  const diff = csfVersioning.computeVersionDiff(db, oldVer, newVer);
  res.render('csf_version_diff', {
    user: req.user, ws: req.workspace, active: 'csf',
    engagement, oldVer, newVer, diff,
    r1: csfScoring.r1,
  });
});

// Resolve a reviewer comment.
app.post('/workspaces/:wsId/csf/:id(\\d+)/comments/:commentId(\\d+)/resolve', requireAuth, requireWorkspace, (req, res) => {
  const { engagement, error } = loadCsfEngagement(req);
  if (error) return res.status(error.status).send(error.message);
  const comment = db.prepare(`SELECT * FROM csf_reviewer_comments WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.commentId, engagement.id);
  if (!comment) return res.status(404).send('Not found');
  if (!csfPolicy.canResolveComment(db, req.user, engagement, comment)) return res.status(403).send('Forbidden');
  db.prepare(`UPDATE csf_reviewer_comments SET resolved=1, resolved_by=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, comment.id);
  logAction(req.user.id, req.workspace.id, 'csf_comment_resolve', 'csf_reviewer_comment', comment.id, null, auditCtx(req));
  res.redirect(req.body.return_to || `/workspaces/${req.workspace.id}/csf/${engagement.id}/findings`);
});

// Interested parties (clause 4.2) used to have a dedicated module here
// (GET / POST / update / delete + views/interested_parties.ejs). Removed
// because parties get identified naturally during the gap assessment +
// implementation work on clauses 4.2 and 9.3.2.d - a separate "register
// the parties" page was duplicative.
//
// The `interested_parties` table is kept as-is so the MRM auto-pack and
// any existing rows continue to work; we just no longer surface a page
// for creating new entries through the UI. If we ever need it back,
// restore the four routes that lived here and re-list views/interested_parties.ejs.

// ==================== INFORMATION SECURITY OBJECTIVES (clause 6.2) ====================
app.get('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT * FROM security_objectives WHERE workspace_id=? ORDER BY due_date IS NULL, due_date, id`)
    .all(req.workspace.id);
  res.render('objectives', {
    user: req.user, ws: req.workspace, title: 'Security objectives', active: 'objectives', rows
  });
});

app.post('/workspaces/:wsId/objectives', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
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

app.post('/workspaces/:wsId/objectives/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
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

app.post('/workspaces/:wsId/objectives/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
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
  if (req.query.ajax === '1') return res.status(204).end();
  res.redirect(`/workspaces/${req.workspace.id}/soa`);
});

app.post('/workspaces/:wsId/soa/custom-controls/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare('DELETE FROM soa_custom_controls WHERE id=? AND workspace_id=?').run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/soa`);
});

// ==================== SOA METADATA HEADER ====================
// Save SoA document-control metadata (version / owner / approver / approved_at).
// Each Save captures a NEW snapshot stamped with the metadata, so audit history
// preserves every revision - bumping v1.0 → v2.0 leaves v1.0's signoff intact
// instead of overwriting it. Label defaults to "v{version}" if version is set.
app.post('/workspaces/:wsId/soa/metadata', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const b = req.body;
  const label = b.version ? `v${b.version}` : 'Metadata revision';
  const snap = captureSoASnapshot(req.workspace.id, req.user.id, null, label, 'Metadata saved');
  db.prepare(`UPDATE soa_snapshots SET version=?, owner=?, approved_by=?, approved_at=? WHERE id=?`)
    .run(b.version || null, b.owner || null, b.approved_by || null, b.approved_at || null, snap.id);
  logAction(req.user.id, req.workspace.id, 'update_soa_metadata', 'soa_snapshot', snap.id, b);
  res.redirect(`/workspaces/${req.workspace.id}/soa`);
});

// ==================== ENGAGEMENT DELIVERABLES ====================
// PDF/DOCX/ZIP exports the consultant produces at end-of-pass to hand to the
// client and to bring to the certification audit.

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Resolve a workspace's brand_logo_path to a data: URI for embedding in DOCX.
// Returns null if the path is empty, points at a remote URL (offline-first), or
// the file cannot be read. Tries the per-tenant uploads directory first, then
// the app-root relative path, then the literal path as absolute.
function brandLogoDataUri(ws) {
  const raw = (ws && ws.brand_logo_path) ? String(ws.brand_logo_path).trim() : '';
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return null;
  const candidates = [];
  if (ws.firm_id) candidates.push(path.join(__dirname, 'uploads', `firm_${ws.firm_id}`, raw));
  candidates.push(path.join(__dirname, raw));
  if (path.isAbsolute(raw)) candidates.push(raw);
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.png'  ? 'image/png'
                 : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                 : ext === '.svg'  ? 'image/svg+xml'
                 : ext === '.webp' ? 'image/webp'
                 : ext === '.gif'  ? 'image/gif' : null;
      if (!mime) continue;
      const b64 = fs.readFileSync(p).toString('base64');
      return `data:${mime};base64,${b64}`;
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

// Two-letter brand initials for the cover-page logo fallback.
function brandInitials(ws) {
  const name = (ws && (ws.brand_display_name || ws.client_name)) || 'ISMS';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

// Validate + default the workspace brand color. Mirrors the regex used at
// /workspaces/:wsId/update so a malformed value never leaks into HTML.
function brandColor(ws) {
  const c = ws && ws.brand_primary_color;
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim())) return c.trim();
  return '#4F46E5'; // app accent (--accent)
}

// Shared CSS for every page of a branded deliverable. Used by the cover,
// header, footer, and body so the document is visually one piece.
function deliverableCss(ws) {
  const accent = brandColor(ws);
  return `
    body{font-family:Calibri,sans-serif;font-size:11pt;line-height:1.45;color:#0F0F12;margin:0;}
    h1{font-size:22pt;color:#0F0F12;margin:0 0 4pt;letter-spacing:-0.01em;}
    h2{font-size:14pt;color:${accent};margin:18pt 0 6pt;border-bottom:1pt solid #ECECEF;padding-bottom:3pt;}
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
  `;
}

// Cover-page HTML for the first page of a branded deliverable. Built as a
// table because html-to-docx only honours `background-color` on table cells
// (divs are converted to plain paragraphs with no shading). The colored
// header band is a single full-width <td> with background; the metadata row
// below sits in a borderless table. Followed by a forced page break so the
// running header/footer kick in from page 2.
function deliverableCoverHtml(title, ws) {
  const accent = brandColor(ws);
  const logo = brandLogoDataUri(ws);
  const initials = brandInitials(ws);
  const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
  const sector = ws.sector ? escHtml(ws.sector) : (ws.industry ? escHtml(ws.industry) : '');
  const today = new Date().toISOString().slice(0, 10);

  // Logo line on the colored band. With a resolved local file we render an
  // <img> (html-to-docx inlines data: URIs natively). Without one, the
  // initials become a small uppercase eyebrow over the title - cleaner than
  // a nested table for the cover, and nested tables get silently dropped by
  // html-to-docx when used inside a shaded <td>.
  const logoLine = logo
    ? `<p style="margin:0 0 22pt 0;"><img src="${logo}" alt="" style="width:64pt;height:64pt;"></p>`
    : `<p style="margin:0 0 18pt 0;font-size:14pt;font-weight:700;color:#FFFFFF;letter-spacing:0.05em;">${escHtml(initials)}</p>`;

  // Metadata cells - only the ones that have content. Built as an array and
  // joined so we don't emit empty cells (would render as visible blanks).
  const metaCells = [];
  if (sector) metaCells.push(`<td style="border:none;padding:0 24pt 0 0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Sector</strong><br>${sector}</td>`);
  metaCells.push(`<td style="border:none;padding:0 24pt 0 0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Generated</strong><br>${today}</td>`);
  if (ws.target_cert_date) {
    metaCells.push(`<td style="border:none;padding:0;color:#51525C;font-size:10pt;"><strong style="color:#0F0F12;">Target certification</strong><br>${escHtml(ws.target_cert_date)}</td>`);
  }

  return `
    <table style="width:100%;border-collapse:collapse;border:none;margin:0 0 28pt 0;">
      <tr>
        <td style="background-color:${accent};color:#FFFFFF;padding:48pt 40pt 48pt 40pt;border:none;">
          ${logoLine}
          <p style="margin:0 0 6pt 0;font-size:10pt;font-weight:600;color:#FFFFFF;letter-spacing:0.10em;">${escHtml(title.toUpperCase())}</p>
          <p style="margin:0;font-size:30pt;font-weight:700;line-height:1.15;color:#FFFFFF;">${clientName}</p>
        </td>
      </tr>
    </table>
    <table style="width:100%;border:none;border-collapse:collapse;margin:0 0 8pt 0;">
      <tr>${metaCells.join('')}</tr>
    </table>
    <div class="page-break" style="page-break-after: always;"></div>
  `;
}

// Running header HTML: client name on left, document title on right; a thin
// brand-color rule renders as a single-row table whose only cell has the
// brand color as its background (html-to-docx only honours background-color
// on <td>).
function deliverableHeaderHtml(title, ws) {
  const accent = brandColor(ws);
  const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${deliverableCss(ws)}</style></head><body>
    <table style="width:100%;border:none;border-collapse:collapse;font-size:9pt;color:#71717A;margin:0;">
      <tr>
        <td style="border:none;padding:0 0 3pt 0;text-align:left;"><strong style="color:#0F0F12;">${clientName}</strong></td>
        <td style="border:none;padding:0 0 3pt 0;text-align:right;">${escHtml(title)}</td>
      </tr>
    </table>
    <table style="width:100%;border:none;border-collapse:collapse;margin:0;">
      <tr><td style="background-color:${accent};border:none;padding:0;height:1.5pt;line-height:1.5pt;font-size:1pt;">&nbsp;</td></tr>
    </table>
  </body></html>`;
}

// Running footer HTML: workspace name on left, generated date center. Page
// number is appended by html-to-docx via pageNumber:true on the options.
function deliverableFooterHtml(ws) {
  const clientName = escHtml(ws.brand_display_name || ws.client_name || '');
  const today = new Date().toISOString().slice(0, 10);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${deliverableCss(ws)}</style></head><body>
    <table style="width:100%;border:none;font-size:8.5pt;color:#9C9CA5;margin:0;">
      <tr>
        <td style="border:none;padding:0;text-align:left;">${clientName}</td>
        <td style="border:none;padding:0;text-align:center;">${today}</td>
        <td style="border:none;padding:0;text-align:right;">Page </td>
      </tr>
    </table>
  </body></html>`;
}

// Full-document HTML: shared CSS + cover page + body. The cover page is on
// its own page (the forced page-break inside deliverableCoverHtml) so the
// header / footer / page-number machinery from html-to-docx kicks in on
// page 2 onwards (skipFirstHeaderFooter:true). This is the entry the four
// callsites below use.
function deliverableHtmlShell(title, ws, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
    <style>${deliverableCss(ws)}</style></head><body>
    ${deliverableCoverHtml(title, ws)}
    <div style="padding:0 6pt;">
      <h1>${escHtml(title)}</h1>
      ${bodyHtml}
    </div>
    </body></html>`;
}

// One-call wrapper around html-to-docx that wires the cover + header + footer
// + page-number bundle for every branded deliverable. Returns the DOCX as a
// Buffer ready to send or to append to a ZIP.
async function brandedDocx(ws, title, bodyHtml) {
  const html = deliverableHtmlShell(title, ws, bodyHtml);
  return await htmlToDocx(
    html,
    deliverableHeaderHtml(title, ws),
    {
      title,
      subject: `${ws.client_name || ''} · ${title}`,
      creator: 'ISMS tool',
      header: true,
      footer: true,
      pageNumber: true,
      skipFirstHeaderFooter: true,
      table: { row: { cantSplit: true } }
    },
    deliverableFooterHtml(ws)
  );
}
function statusTag(s) {
  if (!s) return '<span class="tag tag-na">-</span>';
  const cls = s === 'Implemented' ? 'tag-impl'
    : s === 'Partially Implemented' ? 'tag-partial'
    : s === 'Work In Progress' ? 'tag-wip'
    : s === 'Not Implemented' ? 'tag-noimpl'
    : 'tag-na';
  return `<span class="tag ${cls}">${escHtml(s)}</span>`;
}

// Risk Treatment Plan (clause 6.1.3.e) - formal document export pulling from
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

  let body = '<h2>Methodology</h2><p>This Risk Treatment Plan documents, for every risk in the register, the chosen treatment option, the controls applied, the responsible owner, and the implementation timeframe - as required by ISO/IEC 27001:2022 clause 6.1.3.e.</p>';
  body += `<p>Risks: <strong>${risks.length}</strong></p>`;
  body += '<h2>Treatment plan by risk</h2>';
  if (risks.length === 0) {
    body += '<p><em>No risks recorded yet.</em></p>';
  } else {
    body += '<table><thead><tr><th width="8%">ID</th><th>Risk</th><th width="10%">L×I</th><th width="10%">Treatment</th><th width="14%">Owner</th><th>Controls applied</th><th>Actions</th></tr></thead><tbody>';
    for (const r of risks) {
      const ctrls = (ctrlByRisk[r.id] || []).map(c => escHtml(c.iso_item_id.replace('annex-','').toUpperCase()) + ' ' + escHtml(c.title.replace(/^A\.[0-9.]+ /,''))).join('<br>') || '<em class="meta">-</em>';
      const acts = (actionsByRisk[r.id] || []).map(a => `<strong>${escHtml(a.title)}</strong><br><span class="meta">${escHtml(a.assignee_role || '')}${a.due_date ? ' · due ' + escHtml(a.due_date) : ''} · ${escHtml(a.status || '')}</span>`).join('<br><br>') || '<em class="meta">-</em>';
      body += `<tr><td>R-${r.id}</td><td><strong>${escHtml(r.title)}</strong>${r.description ? '<br><span class="meta">' + escHtml(r.description) + '</span>' : ''}</td><td>${r.likelihood || '-'}×${r.impact || '-'}</td><td>${escHtml(r.treatment || '-')}</td><td>${escHtml(r.owner_name || '-')}</td><td>${ctrls}</td><td>${acts}</td></tr>`;
    }
    body += '</tbody></table>';
  }
  const buf = await brandedDocx(ws, 'Risk Treatment Plan', body);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="risk-treatment-plan-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
  res.send(buf);
});

// Gap Assessment Report - produced at end-of-pass for handoff.
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
  body += `<p>This report summarises the gap-assessment findings produced during <strong>Pass ${pass ? pass.pass_number : '-'}${pass && pass.label ? ' · ' + escHtml(pass.label) : ''}</strong>${pass && pass.completed_at ? ' (completed ' + pass.completed_at.slice(0,10) + ')' : pass && pass.status === 'in_progress' ? ' (in progress)' : ''}. The findings are based on documented evidence reviewed and consultant interviews.</p>`;
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
    body += `<tr><td>${escHtml(r.code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(r.status)}</td><td>${r.maturity == null ? '-' : r.maturity}</td></tr>`;
  }
  body += '</tbody></table>';

  const title = `Gap Assessment Report - Pass ${pass ? pass.pass_number : ''}`;
  const buf = await brandedDocx(ws, title, body);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="gap-assessment-report-${ws.id}-pass${pass ? pass.pass_number : 'X'}-${new Date().toISOString().slice(0,10)}.docx"`);
  res.send(buf);
});

// Recommendations memo - ranked, actionable handoff.
app.get('/workspaces/:wsId/export/recommendations.docx', requireAuth, requireWorkspace, async (req, res) => {
  const ws = req.workspace;
  // Pull rows where status is Not Implemented / Partially / WIP - ordered by severity.
  const items = db.prepare(`SELECT i.id, i.type, i.title, COALESCE(cs.status,'Not Assessed') AS status,
      cs.maturity, cs.notes
    FROM iso_items i LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') AND COALESCE(cs.status,'Not Assessed') IN ('Not Implemented','Partially Implemented','Work In Progress')
    ORDER BY (CASE COALESCE(cs.status,'Not Assessed')
      WHEN 'Not Implemented' THEN 0
      WHEN 'Partially Implemented' THEN 1
      WHEN 'Work In Progress' THEN 2 ELSE 3 END), i.sort_order`).all(ws.id);

  let body = '<h2>How to read this memo</h2><p>This memo lists recommended remediation activity from the most recent gap assessment, ranked by current implementation status. Each row identifies the clause / control, the current status, and the consultant\'s notes from the assessment. Implementation is the client\'s responsibility; the consultant will return to verify each item once the client signals it is complete.</p>';
  body += `<p>Items requiring action: <strong>${items.length}</strong></p>`;
  body += '<h2>Recommendations</h2>';
  if (items.length === 0) {
    body += '<p><em>No outstanding recommendations - every assessed item is at "Implemented".</em></p>';
  } else {
    body += '<table><thead><tr><th width="9%">ID</th><th>Item</th><th width="18%">Status</th><th>Recommendation / consultant notes</th></tr></thead><tbody>';
    for (const r of items) {
      const code = r.id.replace(/^annex-/,'').replace(/^clause-/,'').toUpperCase();
      const cleanTitle = r.title.replace(/^A\.[0-9.]+ /,'').replace(/^[\d.]+\s+/,'');
      body += `<tr><td>${escHtml(code)}</td><td>${escHtml(cleanTitle)}</td><td>${statusTag(r.status)}</td><td>${escHtml(r.notes || '')}</td></tr>`;
    }
    body += '</tbody></table>';
  }

  const buf = await brandedDocx(ws, 'Recommendations Memo', body);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="recommendations-${ws.id}-${new Date().toISOString().slice(0,10)}.docx"`);
  res.send(buf);
});

// Stage 1/2 readiness pack - single ZIP with the management-system docs +
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
    FROM iso_items i LEFT JOIN ${ctlReads.tables(db, ws.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
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
  const rtpDocx = await brandedDocx(ws, 'Risk Treatment Plan', rtpBody);
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
    ${evReads.linkedControlsSubquery()} AS linked_controls
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
`Stage ${stage} readiness pack - ${ws.client_name || 'Workspace ' + ws.id}
Generated ${new Date().toISOString()}

Contents:
  01_soa.csv                - Statement of Applicability (Annex A + custom controls)
  02_risk_treatment_plan.docx - Formal RTP (clause 6.1.3.e)
  03_internal_audits.csv    - Internal audit programme history
  04_management_reviews.csv - MRM history
  05_interested_parties.csv - Clause 4.2 register
  06_objectives.csv         - Clause 6.2 register
  07_evidence_manifest.csv  - Index of every evidence file with SHA-256 + linked controls
  evidence/                 - Actual evidence artefacts (filename: <id>-<name>)

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
  db.prepare(`UPDATE supplier_termination_items SET done=?, done_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END, evidence=?, notes=? WHERE id=? AND supplier_id=? AND workspace_id=?`)
    .run(done, done, req.body.evidence || null, req.body.notes || null, req.params.itemId, req.params.id, req.workspace.id);
  // If all items done, mark terminated
  const remaining = db.prepare('SELECT COUNT(*) c FROM supplier_termination_items WHERE supplier_id=? AND workspace_id=? AND done=0').get(req.params.id, req.workspace.id).c;
  if (remaining === 0) {
    db.prepare(`UPDATE suppliers SET lifecycle_stage='terminated', terminated_at=CURRENT_TIMESTAMP, data_return_completed=1 WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  }
  res.redirect(`/workspaces/${req.workspace.id}/vendors/${req.params.id}?tab=termination`);
});

// External tokenized questionnaire link - external supplier completes without an account.
// Mints (or re-mints) a single-use token, sets a 30-day expiry, and - when a contact
// email is supplied - emails the vendor the /q/<token> link. The token in the URL is the
// credential; the vendor never sees the rest of the tool. Re-running this rotates the
// token (older links stop working) so it doubles as "resend".
app.post('/workspaces/:wsId/vendors/:id/questionnaires/:qId/share', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
  const toEmail = (req.body.email || '').trim() || null;
  const token = crypto.randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  db.prepare(`UPDATE supplier_questionnaires
      SET external_token=?, external_email=?, external_expires_at=?, external_completed_at=NULL,
          sent_at=CURRENT_TIMESTAMP, status=CASE WHEN status='draft' THEN 'sent' ELSE status END
      WHERE id=? AND workspace_id=?`)
    .run(token, toEmail, expiresAt, req.params.qId, req.workspace.id);
  const base = `/workspaces/${req.workspace.id}/vendors/${req.params.id}/questionnaires/${req.params.qId}`;
  const link = `${req.protocol}://${req.get('host')}/q/${token}`;

  if (toEmail) {
    const meta = db.prepare(`SELECT q.template_name, q.total_questions, s.name AS supplier_name, t.description AS tpl_description
        FROM supplier_questionnaires q
        INNER JOIN suppliers s ON s.id=q.supplier_id
        LEFT JOIN questionnaire_templates t ON t.id=q.template_id
        WHERE q.id=? AND q.workspace_id=?`).get(req.params.qId, req.workspace.id);
    email.sendSupplierQuestionnaireEmail({
      toEmail,
      supplierName: meta ? meta.supplier_name : 'your organisation',
      templateName: (meta && meta.template_name) || 'Security questionnaire',
      templateDescription: meta ? meta.tpl_description : null,
      questionCount: meta ? meta.total_questions : null,
      workspaceName: req.workspace.brand_display_name || req.workspace.client_name,
      workspaceId: req.workspace.id,
      firmId: req.workspace.firm_id,
      token,
      expiresAt,
      questionnaireId: parseInt(req.params.qId, 10)
    }).catch(err => console.error('[supplier-questionnaire email] send failed:', err && err.message));
    logAction(req.user.id, req.workspace.id, 'questionnaire_shared', 'questionnaire', req.params.qId, { to: toEmail, emailed: true }, auditCtx(req));
    return res.redirect(withToast(base, `Questionnaire emailed to ${toEmail}. The link expires in 30 days.`));
  }

  logAction(req.user.id, req.workspace.id, 'questionnaire_shared', 'questionnaire', req.params.qId, { to: null, emailed: false }, auditCtx(req));
  res.redirect(withToast(base, `External link ready (expires in 30 days): ${link}`));
});

app.get('/q/:token', (req, res) => {
  const q = db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description,
      COALESCE(w.brand_display_name, w.client_name) AS requester_name
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    LEFT JOIN questionnaire_templates t ON t.id=q.template_id
    LEFT JOIN workspaces w ON w.id=q.workspace_id
    WHERE q.external_token=?`).get(req.params.token);
  const blank = { sections: {}, respMap: {}, token: req.params.token };
  if (!q) return res.status(404).render('external_questionnaire', { q: null, state: 'invalid', ...blank });
  if (q.external_completed_at) return res.render('external_questionnaire', { q, state: 'done', ...blank });
  if (q.external_expires_at && new Date(q.external_expires_at) < new Date())
    return res.status(410).render('external_questionnaire', { q, state: 'expired', ...blank });
  const questions = db.prepare('SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order').all(q.template_id);
  const responses = db.prepare('SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?').all(q.id);
  const respMap = Object.fromEntries(responses.map(r => [r.question_id, r]));
  const sections = {};
  questions.forEach(qu => { (sections[qu.section] = sections[qu.section] || []).push(qu); });
  res.render('external_questionnaire', { q, sections, respMap, token: req.params.token, state: 'open' });
});

app.post('/q/:token', resolveQuestionnaireFirm, qUploadAny, (req, res) => {
  const q = req._questionnaire; // guaranteed open by resolveQuestionnaireFirm

  // An upload error (oversize / too many files) aborts multer mid-parse, so the
  // body may be incomplete — don't risk a partial save. Show a clear retry
  // message with the answers still on screen; the link stays open.
  if (req._uploadError) {
    const e = req._uploadError;
    const tooBig = e && e.code === 'LIMIT_FILE_SIZE';
    const tooMany = e && e.code === 'LIMIT_FILE_COUNT';
    const uploadMsg = tooBig
      ? 'One of your files is larger than 25 MB. Please attach a smaller file (or split it) and submit again — your answers were not saved yet.'
      : tooMany
        ? 'Too many files were attached at once (limit 40). Please reduce the number of attachments and submit again — your answers were not saved yet.'
        : 'We could not process one of your attachments. Please remove it and submit again — your answers were not saved yet.';
    // Clean up any partial temp files multer did manage to write.
    (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    return res.status(413).render('external_questionnaire', {
      q, sections: {}, respMap: {}, token: req.params.token, state: 'uploaderror', uploadMsg
    });
  }

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

  // Persist any per-question evidence the vendor attached. Field names follow
  // the file_<questionId> convention; disallowed types were already dropped by
  // the multer fileFilter (names on req._rejectedUploads, surfaced below).
  let attachSaved = 0;
  try {
    attachSaved = persistQuestionnaireFiles({
      files: req.files, questionnaireId: q.id, workspaceId: q.workspace_id, source: 'vendor', uploadedBy: null
    });
  } catch (e) { console.error('[questionnaire attach]', e && e.message); }

  // Close the loop: notify the engagement lead that the vendor responded. The
  // notify->email bridge emails them automatically (subject to their pref). The
  // title carries the supplier + template so distinct questionnaires don't dedup
  // into one another, but stays day-count-free so genuine re-fires are rare.
  const supName = q.supplier_name || 'A supplier';
  try {
    const ratingLabel = rating ? rating.charAt(0).toUpperCase() + rating.slice(1) : 'n/a';
    const attachNote = attachSaved ? ` ${attachSaved} file${attachSaved === 1 ? '' : 's'} attached.` : '';
    jobs.notify(q.workspace_id, null, 'questionnaire_responded', score !== null && score < 60 ? 'high' : 'medium',
      `${supName} returned their questionnaire: ${q.template_name}`,
      `Score ${score === null ? 'n/a' : score + '%'} · risk ${ratingLabel}.${attachNote} Review and confirm the rating.`,
      `/workspaces/${q.workspace_id}/vendors/${q.supplier_id}/questionnaires/${q.id}`);
  } catch (e) { console.error('[questionnaire notify]', e && e.message); }

  res.render('external_questionnaire', {
    q, sections: {}, respMap: {}, token: req.params.token, state: 'submitted',
    rejectedUploads: req._rejectedUploads || [], attachSaved
  });
});

// ==================== TASKS: TEMPLATES + TIME TRACKING ====================
app.get('/workspaces/:wsId/task-templates', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const templates = db.prepare(`SELECT * FROM task_templates WHERE workspace_id=? OR is_system=1 OR firm_id=? ORDER BY is_system DESC, name`).all(req.workspace.id, req.workspace.firm_id);
  res.render('task_templates', { user: req.user, ws: req.workspace, templates });
});

app.post('/workspaces/:wsId/tasks/from-template/:tplId', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM task_templates WHERE id=? AND (is_system=1 OR firm_id=? OR workspace_id=?)').get(req.params.tplId, req.workspace.firm_id, req.workspace.id);
  if (!tpl) return redirectBack(req, res);
  const steps = JSON.parse(tpl.steps || '[]');
  const baseDate = req.body.base_date ? new Date(req.body.base_date) : new Date();
  for (const s of steps) {
    const due = new Date(baseDate.getTime() + (s.days_offset || 0) * 86400000).toISOString().slice(0,10);
    db.prepare(`INSERT INTO tasks (workspace_id, entity_id, title, description, assignee_id, due_date, status, created_by, template_id)
      VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?)`).run(
      req.workspace.id, req.entityScopeId || null,
      s.title, tpl.name + ' - step',
      req.body.assignee_id || null, due, req.user.id, tpl.id);
  }
  logAction(req.user.id, req.workspace.id, 'spawn_template', 'task_template', tpl.id, { name: tpl.name, steps: steps.length }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/tasks`, `Created ${steps.length} tasks from "${tpl.name}"`));
});

// ==================== ASSET RELATIONSHIPS + BULK IMPORT ====================
app.post('/workspaces/:wsId/assets/:id/relationships', requireAuth, requireWorkspace, requirePermission('asset.update'), (req, res) => {
  const asset = db.prepare('SELECT id FROM assets WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!asset) return res.status(404).send('Asset not found');
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
      (SELECT COUNT(*) FROM ${ctlReads.tables(db, req.workspace.id).doc} dc INNER JOIN generated_docs d ON d.id=dc.document_id WHERE dc.iso_item_id=i.id AND d.workspace_id=?) AS doc_count
    FROM iso_items i
    INNER JOIN risk_controls rc ON rc.iso_item_id = i.id
    INNER JOIN risks r ON r.id = rc.risk_id
    LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE r.asset_id = ? AND r.workspace_id = ?
    ORDER BY i.sort_order
  `).all(req.workspace.id, req.workspace.id, asset.id, req.workspace.id);
  res.render('asset_detail', { user: req.user, ws: req.workspace, asset, parents, children, allAssets, linkedRisks, controlsInScope });
});

// Legacy textarea-paste CSV importer superseded by the GET/POST pipeline at
// /assets/import (preview + per-row validation + transactional commit).
// Surviving as a redirect for any bookmarked links.

// ==================== MEMBERS: BULK INVITE + STATS ====================
app.post('/workspaces/:wsId/members/bulk', requireAuth, requireWorkspace, requirePermission('members.add'), (req, res) => {
  const lines = (req.body.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let added = 0;
  for (const ln of lines) {
    const parts = ln.split(',').map(s => s.trim());
    const [name, email, role] = parts;
    if (!name || !email) continue;
    const e = email.toLowerCase();
    const r = ['client_owner','contributor','reviewer','auditor','read_only'].includes(role) ? role : 'contributor';
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
    controls_owned: db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, req.workspace.id).cs} WHERE workspace_id=? AND owner_id=?`).get(req.workspace.id, u.id).c,
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
  perms.forEach(p => ins.run(req.workspace.id, userId, p, req.user.id, `Template: ${tpl.name}` + (req.body.reason ? ' - ' + req.body.reason : ''), expires));
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
    FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
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
    FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
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
    // Naive CSV - values may be quoted; handle simple unquote
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
    FROM iso_items i LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
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
  db.prepare(`UPDATE risks SET status='accepted', accepted_until=?, last_acceptance_id=? WHERE id=? AND workspace_id=?`)
    .run(expires_at || null, id, risk.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'accept_risk', 'risk', risk.id, { acceptance_id: id, expires_at }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/risks/${risk.id}`, 'Risk acceptance recorded'));
});

app.get('/workspaces/:wsId/risks/:id/acceptances', requireAuth, requireWorkspace, requirePermission('risk.view'), (req, res) => {
  const risk = db.prepare('SELECT * FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Not found');
  const list = db.prepare(`SELECT * FROM risk_acceptances WHERE risk_id=? ORDER BY signed_at DESC`).all(risk.id);
  res.render('risk_acceptances', { user: req.user, ws: req.workspace, risk, list });
});

// Formal acceptance record - downloadable DOCX with the risk, residual,
// rationale, expiry, and a signature block. The auditor wants this as a
// hand-off artefact, not just a database row.
app.get('/workspaces/:wsId/risks/:id/acceptances/:aid/record.docx', requireAuth, requireWorkspace, requirePermission('risk.view'), async (req, res) => {
  const risk = db.prepare(`SELECT * FROM risks WHERE id=? AND workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
  const a = db.prepare(`SELECT * FROM risk_acceptances WHERE id=? AND workspace_id=? AND risk_id=?`).get(req.params.aid, req.workspace.id, risk.id);
  if (!a) return res.status(404).send('Acceptance record not found');

  const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })], ...opts });
  const heading = (text, level) => new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })], spacing: { before: 300, after: 120 } });
  const row = (label, value) => new TableRow({ children: [
    new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, shading: { fill: 'F4F4F5' },
      children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })] }),
    new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: [new TextRun({ text: value || '-' })] })] })
  ]});

  const score = (risk.likelihood || 0) * (risk.impact || 0);
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Risk acceptance record' })], alignment: AlignmentType.CENTER }),
        para(`${req.workspace.client_name || 'Workspace'} - generated ${new Date().toISOString().slice(0,10)}`, { italics: true }),
        para(''),

        heading('Risk', HeadingLevel.HEADING_2),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
          row('Risk ID', `R-${risk.id}`),
          row('Title', risk.title),
          row('Description', risk.description || '-'),
          row('Likelihood × Impact', `${risk.likelihood} × ${risk.impact} = ${score}`),
          row('Treatment option chosen', 'Accept (residual risk)'),
          row('Risk owner', risk.owner_name || '-'),
        ]}),

        heading('Residual position', HeadingLevel.HEADING_2),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
          row('Residual L × I', risk.residual_likelihood && risk.residual_impact
            ? `${risk.residual_likelihood} × ${risk.residual_impact} = ${risk.residual_likelihood * risk.residual_impact}`
            : (a.residual_score != null ? String(a.residual_score) : '-')),
          row('Inherent L × I', `${risk.likelihood} × ${risk.impact} = ${score}`),
        ]}),

        heading('Acceptance rationale', HeadingLevel.HEADING_2),
        para(a.rationale || '-'),

        heading('Attestation', HeadingLevel.HEADING_2),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
          row('Accepter (full name)', a.accepter_name),
          row('Role', a.accepter_role || '-'),
          row('Signed at', a.signed_at),
          row('IP address', a.ip_address || '-'),
          row('User agent', a.user_agent || '-'),
          row('Signature hash', a.signature ? a.signature.slice(0, 32) + '…' : '-'),
          row('Expires / re-review by', a.expires_at || 'No fixed expiry - reviewed at each management review'),
          row('Status', a.revoked_at ? `REVOKED at ${a.revoked_at}` : 'Active'),
        ]}),
        para(''),

        new Paragraph({ children: [new TextRun({
          text: 'I attest under my own authority that this residual risk has been considered and is hereby formally accepted. ' +
                'This electronic signature is bound to my identity, the recorded IP, and the timestamp above. ' +
                'The signature hash is anchored in the workspace audit log and tamper-evident.',
          italics: true
        })] }),
        para(''),
        para('Risk owner sign-off (clause 6.1.3.f): _________________________  Date: __________', { size: 22 }),
      ]
    }]
  });

  const buf = await Packer.toBuffer(doc);
  const safeTitle = (risk.title || `risk-${risk.id}`).replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 60);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="risk-acceptance-R${risk.id}-${safeTitle}.docx"`);
  res.send(buf);
});

app.post('/workspaces/:wsId/risks/:id/acceptances/:aid/revoke', requireAuth, requireWorkspace, requirePermission('risk.update'), (req, res) => {
  const risk = db.prepare('SELECT id FROM risks WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
  db.prepare(`UPDATE risk_acceptances SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND risk_id=?`).run(req.params.aid, risk.id);
  // Reset risk to open if no other active acceptance
  const remaining = db.prepare(`SELECT COUNT(*) c FROM risk_acceptances WHERE risk_id=? AND revoked_at IS NULL`).get(risk.id).c;
  if (remaining === 0) db.prepare(`UPDATE risks SET status='open', accepted_until=NULL WHERE id=? AND workspace_id=?`).run(risk.id, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'revoke_acceptance', 'risk', req.params.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/risks/${req.params.id}/acceptances`);
});

// ==================== COMPLIANCE CALENDAR ====================
// (Old list-style calendar removed - replaced by Tier B.8 month-view above.)

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
  const readme = `ISMS handover package - ${ws.client_name}
==========================================================

Generated: ${new Date().toISOString()}
Workspace ID: ${ws.id}
Client: ${ws.client_name}

Contents:
  data/*.json     - every database row scoped to this workspace, decrypted for portability
  evidence/       - every evidence file uploaded against any control
  supplier-files/ - every supplier attestation / contract

To import this elsewhere:
  1. Stand up an ISMS instance (any version >= today's).
  2. Restore the JSON files into the corresponding tables - preserving primary keys
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
// Audit checklist generator - populates audit_observations with starter questions for
// every Annex A control in the chosen category. Auditor fills in findings against each.
// SoA-driven checklist generator: only generates observations for controls the
// workspace has marked applicable + included on the SoA, with evidence-linkage
// counts pulled in and sample-size suggestions based on the control family.
// Mirrors the category-based generator below but is the right choice once the
// SoA has been worked through — auditors shouldn't be testing excluded controls.

// Sample-size heuristics keyed to Annex A control prefixes. Each entry returns
// guidance the auditor pastes into the observation. Numbers are auditor-norms
// (BSI / IRCA guidance) not standards-mandated.
const SAMPLE_SIZE_HINTS = {
  // Access control — clauses where "5 users" is the typical sample
  'annex-a.5.15': 'Sample 10 users (mix of joiner / mover / leaver).',
  'annex-a.5.16': 'Sample 10 user accounts created in the last 6 months.',
  'annex-a.5.17': 'Sample 5 authentication records (MFA enrolment, password reset).',
  'annex-a.5.18': 'Sample 10 access rights changes; verify approval evidence.',
  'annex-a.8.2': 'Sample 5 privileged-access requests; verify approval + revocation.',
  'annex-a.8.3': 'Sample 5 systems for least-privilege configuration.',
  'annex-a.8.5': 'Sample 5 admin authentications; verify phishing-resistant MFA.',
  // Logging + monitoring
  'annex-a.8.15': 'Sample 10 consecutive days of logs; verify retention.',
  'annex-a.8.16': 'Sample 3 alert investigations from the last 90 days.',
  // Backups + BCP
  'annex-a.8.13': 'Sample 3 restore tests; verify RTO/RPO met.',
  'annex-a.5.29': 'Sample 1 BCP test conducted in the last 12 months.',
  'annex-a.5.30': 'Sample evidence of ICT readiness for BC.',
  // Suppliers
  'annex-a.5.19': 'Sample 5 active suppliers; verify security clauses + review records.',
  'annex-a.5.20': 'Sample 5 supplier contracts.',
  'annex-a.5.21': 'Sample 5 ICT supply-chain risk assessments.',
  'annex-a.5.22': 'Sample 5 supplier reviews from the last 12 months.',
  // Incidents
  'annex-a.5.24': 'Verify incident response procedure exists + has been exercised.',
  'annex-a.5.25': 'Sample 5 incidents from the last 12 months.',
  'annex-a.5.26': 'Sample 5 incident responses; verify lessons-learned captured.',
  'annex-a.5.27': 'Sample 3 post-incident reviews.',
  // Risk
  'annex-a.6.3': 'Sample 5 training completion records.',
  // Default
  '_default': 'Sample 3–5 records or 1 process walkthrough.'
};

function sampleHintFor(controlId) {
  return SAMPLE_SIZE_HINTS[controlId] || SAMPLE_SIZE_HINTS._default;
}

app.post('/workspaces/:wsId/audits/:id/checklist-from-soa', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Not found');

  // Pull every included control with its linkage counts so the auditor sees
  // immediately which controls have evidence + a policy backing them.
  const rows = db.prepare(`
    SELECT i.id, i.title, i.category,
      cs.status,
      (SELECT COUNT(*) FROM document_controls dc INNER JOIN generated_docs gd
        ON gd.id = dc.document_id WHERE dc.iso_item_id = i.id AND gd.workspace_id = ?
        AND gd.retired_at IS NULL) AS doc_count,
      ${evReads.checklistEvidenceCountSubquery()} AS evi_count
    FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type='control' AND cs.applicability='included'
    ORDER BY i.sort_order
  `).all(req.workspace.id, req.workspace.id, req.workspace.id);

  if (!rows.length) {
    return res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`,
      'No controls marked included on the SoA - decide applicability before generating an audit checklist', 'error'));
  }

  const existing = new Set(db.prepare(`SELECT iso_item_id FROM audit_observations WHERE audit_id=? AND iso_item_id IS NOT NULL`)
    .all(audit.id).map(r => r.iso_item_id));
  const toInsert = rows.filter(r => !existing.has(r.id));

  const ins = db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, status) VALUES (?, ?, ?, 'open')`);
  const tx = db.transaction(() => {
    toInsert.forEach(r => {
      const code = r.id.replace('annex-', '').toUpperCase();
      const cleanTitle = r.title.replace(/^A\.[0-9.]+ /, '');
      const linkLine = `Linked policies: ${r.doc_count} - Linked evidence: ${r.evi_count}`;
      const sampleLine = `Sample size suggestion: ${sampleHintFor(r.id)}`;
      const testLine = `Test: (1) Is there a documented procedure? (2) Is it operating in practice - sample evidence below. (3) Has it been reviewed in the last 12 months?`;
      const findingLine = `Finding template: [Conformance / Observation / Minor NC / Major NC] - [describe what was tested, what was seen, root cause if NC, evidence references]`;
      const description = `${code} - ${cleanTitle}\n\n${testLine}\n\n${linkLine}\n${sampleLine}\n\n${findingLine}`;
      ins.run(audit.id, r.id, description);
    });
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'generate_audit_checklist_from_soa', 'audit', audit.id,
    { added: toInsert.length, skipped_existing: rows.length - toInsert.length }, auditCtx(req));
  const skipped = rows.length - toInsert.length;
  const msg = skipped > 0
    ? `Added ${toInsert.length} new checklist item${toInsert.length === 1 ? '' : 's'} · ${skipped} already existed and were kept`
    : `Generated ${toInsert.length} checklist item${toInsert.length === 1 ? '' : 's'} from SoA · sample-size hints + linkage included`;
  res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`, msg));
});

app.post('/workspaces/:wsId/audits/:id/checklist', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Not found');
  const category = req.body.category;
  const validCats = ['org','people','physical','tech','clauses'];
  if (!validCats.includes(category)) return redirectBack(req, res);
  const controls = category === 'clauses'
    ? db.prepare(`SELECT id, title FROM iso_items WHERE type='clause' ORDER BY sort_order`).all()
    : db.prepare(`SELECT id, title FROM iso_items WHERE type='control' AND category=? ORDER BY sort_order`).all(category);

  const existing = new Set(db.prepare(`SELECT iso_item_id FROM audit_observations WHERE audit_id=? AND iso_item_id IS NOT NULL`)
    .all(audit.id).map(r => r.iso_item_id));
  const toInsert = controls.filter(c => !existing.has(c.id));

  const ins = db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, status) VALUES (?, ?, ?, 'open')`);
  const tx = db.transaction(() => {
    toInsert.forEach(c => {
      const cleanTitle = c.title.replace(/^A\.[0-9.]+ /, '').replace(/^Clause [0-9.]+ /, '');
      const q = `${c.id.replace('annex-','').replace('clause-','').toUpperCase()} - ${cleanTitle}: Is there a documented process? Is it operating in practice (sample evidence)? Has it been reviewed in the last 12 months?`;
      ins.run(audit.id, c.id, q);
    });
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'generate_audit_checklist', 'audit', audit.id,
    { category, added: toInsert.length, skipped_existing: controls.length - toInsert.length }, auditCtx(req));
  const skipped = controls.length - toInsert.length;
  const msg = skipped > 0
    ? `Added ${toInsert.length} new checklist item${toInsert.length === 1 ? '' : 's'} from ${category} · ${skipped} already existed and were kept`
    : `Generated ${toInsert.length} checklist item${toInsert.length === 1 ? '' : 's'} - fill in findings against each`;
  res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`, msg));
});

app.post('/workspaces/:wsId/audits/:id/observations', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Audit not found');
  const { iso_item_id, description, recommendation } = req.body;
  if (!description) return redirectBack(req, res);
  db.prepare(`INSERT INTO audit_observations (audit_id, iso_item_id, description, recommendation) VALUES (?, ?, ?, ?)`)
    .run(req.params.id, iso_item_id || null, description, recommendation || null);
  res.redirect(`/workspaces/${req.workspace.id}/audits/${req.params.id}`);
});

app.post('/workspaces/:wsId/audits/observations/:obsId/close', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=? AND audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`).run(req.params.obsId, req.workspace.id);
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/audits/:id/checklist/clear', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const audit = db.prepare('SELECT id FROM audits WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!audit) return res.status(404).send('Not found');
  const result = db.prepare(`DELETE FROM audit_observations WHERE audit_id=? AND status='open'`).run(audit.id);
  logAction(req.user.id, req.workspace.id, 'clear_audit_checklist', 'audit', audit.id, { deleted: result.changes }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${audit.id}`,
    `Cleared ${result.changes} open checklist item${result.changes === 1 ? '' : 's'} (closed items kept)`));
});

app.post('/workspaces/:wsId/audits/observations/:obsId/reopen', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  db.prepare(`UPDATE audit_observations SET status='open' WHERE id=? AND audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`).run(req.params.obsId, req.workspace.id);
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/audits/observations/:obsId/notes', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const obs = db.prepare(`SELECT o.id, o.audit_id FROM audit_observations o
    INNER JOIN audits a ON a.id = o.audit_id
    WHERE o.id=? AND a.workspace_id=?`).get(req.params.obsId, req.workspace.id);
  if (!obs) return res.status(404).send('Not found');
  db.prepare(`UPDATE audit_observations SET recommendation=? WHERE id=?`).run(req.body.recommendation || null, obs.id);
  logAction(req.user.id, req.workspace.id, 'update_audit_observation', 'audit_observation', obs.id, {}, auditCtx(req));
  redirectBack(req, res);
});

app.post('/workspaces/:wsId/audits/observations/:obsId/promote', requireAuth, requireWorkspace, requirePermission('audit.manage'), (req, res) => {
  const obs = db.prepare(`SELECT o.* FROM audit_observations o
    INNER JOIN audits a ON a.id = o.audit_id
    WHERE o.id=? AND a.workspace_id=?`).get(req.params.obsId, req.workspace.id);
  if (!obs) return res.status(404).send('Not found');
  const finding_type = ['observation','ofi','minor_nc','major_nc'].includes(req.body.finding_type) ? req.body.finding_type : 'observation';
  const severity = ['low','medium','high'].includes(req.body.severity) ? req.body.severity : 'medium';
  const description = (req.body.description || obs.recommendation || obs.description || '').trim();
  if (!description) return redirectBack(req, res);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO audit_findings (audit_id, iso_item_id, finding_type, severity, description, status)
                VALUES (?, ?, ?, ?, ?, 'open')`)
      .run(obs.audit_id, obs.iso_item_id || null, finding_type, severity, description);
    db.prepare(`UPDATE audit_observations SET status='closed' WHERE id=?`).run(obs.id);
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'promote_observation_to_finding', 'audit_observation', obs.id,
    { finding_type, severity }, auditCtx(req));
  res.redirect(withToast(`/workspaces/${req.workspace.id}/audits/${obs.audit_id}`,
    `Promoted to ${finding_type.replace('_',' ')} finding`));
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

// Keep existing POST /comments - just add a post-processor to record mentions
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

// ==================== ISO/IEC 42001:2023 (AI MS) ====================
// Parallels the ISO 27001 routes but lives under /iso42001 and uses iso42001_items
// + iso42001_control_states. Same schema shape so views can mirror the ISO 27001
// pattern (controls, SoA, control detail). Built incrementally - catalog browser
// and controls/SoA assessment ship first; gap/roadmap/cert-cycle/readiness/intake/
// engagement-plan/exec-brief will follow.

function getOrCreate42State(wsId, isoId) {
  db.prepare(`INSERT OR IGNORE INTO iso42001_control_states (workspace_id, iso_item_id) VALUES (?, ?)`).run(wsId, isoId);
  return db.prepare(`SELECT * FROM iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(wsId, isoId);
}

// Catalog browser - read-only reference page showing all 27 clauses + 38 Annex A controls.
app.get('/workspaces/:wsId/iso42001', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'all';
  const search = (req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`SELECT * FROM iso42001_items ORDER BY sort_order`).all();
  if (filter === 'clauses') rows = rows.filter(r => r.type === 'clause');
  else if (filter === 'annex') rows = rows.filter(r => r.type === 'control');
  else if (filter && filter.startsWith('a-')) rows = rows.filter(r => r.category === filter);
  else if (filter && filter.startsWith('c-')) rows = rows.filter(r => r.category === filter);
  if (search) rows = rows.filter(r => r.title.toLowerCase().includes(search) || (r.summary||'').toLowerCase().includes(search));
  res.render('iso42001_catalog', { user: req.user, ws: req.workspace, rows, filter, search });
});

// Controls assessment grid - status, maturity, owner, due. Bulk-editable.
app.get('/workspaces/:wsId/iso42001/controls', requireAuth, requireWorkspace, (req, res) => {
  const filter = req.query.filter || 'all';
  const search = (req.query.q || '').trim().toLowerCase();
  const T = ctlReads.tables(db, req.workspace.id);
  let rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
      cs.applicability, cs.maturity, cs.owner_id, cs.due_date,
      (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
      FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      ORDER BY i.sort_order`).all(req.workspace.id);
  if (filter === 'clauses') rows = rows.filter(r => r.type === 'clause');
  else if (filter === 'annex') rows = rows.filter(r => r.type === 'control');
  else if (filter && filter.startsWith('a-')) rows = rows.filter(r => r.category === filter);
  else if (filter === 'open') rows = rows.filter(r => ['Not Implemented','Partially Implemented','Not Assessed'].includes(r.status));
  if (search) rows = rows.filter(r => r.title.toLowerCase().includes(search) || r.id.toLowerCase().includes(search));
  res.render('iso42001_controls', { user: req.user, ws: req.workspace, rows, filter, search });
});

// Single-control "detail" page - merged into the gap wizard like ISO 27001 did.
// This route is a permanent redirect so existing links keep working.
app.get('/workspaces/:wsId/iso42001/controls/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
  // Reserved literal sub-routes (kanban, export.csv, bulk-controls, etc.) - let them fall through.
  if (['kanban', 'export.csv'].includes(req.params.isoId)) return nextMw();
  const item = db.prepare('SELECT id FROM iso42001_items WHERE id=?').get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
});

// Bulk update controls. Mirrors /workspaces/:wsId/bulk-controls but for ISO 42001.
app.post('/workspaces/:wsId/iso42001/bulk-controls', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
  const ids = parseFormArray(req.body.ids);
  const { status, applicability } = req.body;
  if (!ids.length || (!status && !applicability)) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/controls`);
  const tx = db.transaction(() => {
    for (const id of ids) {
      getOrCreate42State(req.workspace.id, id);
      if (status) db.prepare(`UPDATE iso42001_control_states SET status=?, last_updated=CURRENT_TIMESTAMP WHERE workspace_id=? AND iso_item_id=?`).run(status, req.workspace.id, id);
      if (applicability) db.prepare(`UPDATE iso42001_control_states SET applicability=?, last_updated=CURRENT_TIMESTAMP WHERE workspace_id=? AND iso_item_id=?`).run(applicability, req.workspace.id, id);
    }
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'bulk_update_iso42001_controls', 'iso42001_item', null, { ids: ids.length, status, applicability });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/controls`);
});

// SoA - Statement of Applicability for the 38 Annex A controls.
app.get('/workspaces/:wsId/iso42001/soa', requireAuth, requireWorkspace, (req, res) => {
  db.prepare(`INSERT OR IGNORE INTO iso42001_control_states (workspace_id, iso_item_id)
              SELECT ?, id FROM iso42001_items WHERE type='control'`).run(req.workspace.id);
  const T = ctlReads.tables(db, req.workspace.id);
  const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.inclusion_justification, cs.exclusion_justification,
      cs.last_updated
      FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control'
      ORDER BY i.sort_order`).all(req.workspace.id);

  // Risks linked to each control via iso42001_risk_controls
  const riskLinks = db.prepare(`SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title, r.likelihood, r.impact
      FROM iso42001_risk_controls rc
      INNER JOIN risks r ON r.id = rc.risk_id
      WHERE r.workspace_id = ?
      ORDER BY (r.likelihood * r.impact) DESC`).all(req.workspace.id);
  const risksByControl = {};
  riskLinks.forEach(l => { (risksByControl[l.iso_item_id] = risksByControl[l.iso_item_id] || []).push(l); });

  // Documents linked to each control via iso42001_document_controls
  const docLinks = db.prepare(`SELECT dc.iso_item_id, dc.section_ref, d.id AS doc_id, d.name AS doc_name, d.status AS doc_status, d.category
      FROM ${T.doc42} dc
      INNER JOIN generated_docs d ON d.id = dc.document_id
      WHERE d.workspace_id = ?
      ORDER BY d.name`).all(req.workspace.id);
  const docsByControl = {};
  docLinks.forEach(l => { (docsByControl[l.iso_item_id] = docsByControl[l.iso_item_id] || []).push(l); });

  // Custom (non-Annex-A) controls
  const customControls = db.prepare(`SELECT * FROM iso42001_soa_custom_controls
      WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);

  // SoA metadata from latest snapshot
  const latestSnap = db.prepare(`SELECT id, label, version, owner, approved_by, approved_at, created_at
      FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(req.workspace.id);

  res.render('iso42001_soa', { user: req.user, ws: req.workspace, rows, docsByControl, risksByControl,
    customControls, soaMeta: latestSnap || {} });
});

// SoA snapshot capture - immutable, hashed payload.
app.post('/workspaces/:wsId/iso42001/soa/snapshot', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const T = ctlReads.tables(db, req.workspace.id);
  const rows = db.prepare(`SELECT i.id, i.title, i.category, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.inclusion_justification, cs.exclusion_justification
      FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control'
      ORDER BY i.sort_order`).all(req.workspace.id);
  const customs = db.prepare(`SELECT * FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);
  const payload = JSON.stringify({ rows, customs });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const included = rows.filter(r => r.applicability === 'included').length + customs.filter(c => c.applicability === 'included').length;
  const excluded = rows.filter(r => r.applicability === 'excluded').length + customs.filter(c => c.applicability === 'excluded').length;
  const total = rows.length + customs.length;
  const id = db.prepare(`INSERT INTO iso42001_soa_snapshots
    (workspace_id, label, reason, version, owner, approved_by, approved_at,
     payload, payload_hash, control_count, included_count, excluded_count, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id,
         req.body.label || 'Manual snapshot',
         req.body.reason || null,
         req.body.version || null,
         req.body.owner || null,
         req.body.approved_by || null,
         req.body.approved_at || null,
         payload, hash, total, included, excluded, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'capture_iso42001_soa_snapshot', 'iso42001_soa_snapshot', id, { hash });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

// SoA metadata - captures version/owner/approver and auto-snapshots if none exists yet.
app.post('/workspaces/:wsId/iso42001/soa/metadata', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  // Always create a new snapshot with the metadata - that way metadata is versioned.
  const rows = db.prepare(`SELECT i.id, i.title, i.category, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.inclusion_justification, cs.exclusion_justification
      FROM iso42001_items i
      LEFT JOIN ${ctlReads.tables(db, req.workspace.id).cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type = 'control' ORDER BY i.sort_order`).all(req.workspace.id);
  const customs = db.prepare(`SELECT * FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);
  const payload = JSON.stringify({ rows, customs });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const included = rows.filter(r => r.applicability === 'included').length + customs.filter(c => c.applicability === 'included').length;
  const excluded = rows.filter(r => r.applicability === 'excluded').length + customs.filter(c => c.applicability === 'excluded').length;
  const total = rows.length + customs.length;
  db.prepare(`INSERT INTO iso42001_soa_snapshots
    (workspace_id, label, reason, version, owner, approved_by, approved_at,
     payload, payload_hash, control_count, included_count, excluded_count, created_by)
    VALUES (?, 'Metadata update', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id,
         req.body.version || null, req.body.owner || null,
         req.body.approved_by || null, req.body.approved_at || null,
         payload, hash, total, included, excluded, req.user.id);
  logAction(req.user.id, req.workspace.id, 'iso42001_soa_metadata', 'iso42001_soa_snapshot', null, req.body);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

// Auto-justify SoA: for every Annex A control that any open risk treats, mark it
// Included and pre-fill an inclusion justification of the form "Treats {risk titles}".
app.post('/workspaces/:wsId/iso42001/soa/auto-justify', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`INSERT OR IGNORE INTO iso42001_control_states (workspace_id, iso_item_id)
              SELECT ?, id FROM iso42001_items WHERE type='control'`).run(req.workspace.id);
  // For each control with at least one open risk link, build "Treats R-1, R-2..." text and mark included.
  const links = db.prepare(`SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title
      FROM iso42001_risk_controls rc
      INNER JOIN risks r ON r.id = rc.risk_id
      WHERE r.workspace_id=? AND r.status != 'closed'
      ORDER BY rc.iso_item_id, r.id`).all(req.workspace.id);
  const byCtl = {};
  links.forEach(l => { (byCtl[l.iso_item_id] = byCtl[l.iso_item_id] || []).push(l); });
  const upd = db.prepare(`UPDATE iso42001_control_states
    SET applicability='included',
        inclusion_justification = COALESCE(NULLIF(inclusion_justification, ''), ?),
        last_updated = CURRENT_TIMESTAMP
    WHERE workspace_id=? AND iso_item_id=?`);
  let affected = 0;
  const tx = db.transaction(() => {
    for (const [ctlId, risks] of Object.entries(byCtl)) {
      const titles = risks.map(r => `R-${r.risk_id}`).join(', ');
      const just = `Treats ${titles}`;
      const r = upd.run(just, req.workspace.id, ctlId);
      if (r.changes > 0) affected++;
    }
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'iso42001_soa_auto_justify', 'iso42001_item', null, { affected });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

// Custom (non-Annex-A) controls
app.post('/workspaces/:wsId/iso42001/soa/custom-controls', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { code, title, source_framework, applicability, description, inclusion_justification } = req.body;
  if (!code || !title) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
  db.prepare(`INSERT INTO iso42001_soa_custom_controls
    (workspace_id, code, title, source, summary, applicability, inclusion_justification)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, code.trim(), title.trim(), source_framework || null,
         description || null, applicability || 'included', inclusion_justification || null);
  logAction(req.user.id, req.workspace.id, 'add_iso42001_custom_control', 'iso42001_soa_custom_control', null, { code });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

app.post('/workspaces/:wsId/iso42001/soa/custom-controls/:id', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { code, title, source_framework, applicability, status, inclusion_justification, exclusion_justification } = req.body;
  db.prepare(`UPDATE iso42001_soa_custom_controls
    SET code=COALESCE(?, code), title=COALESCE(?, title), source=COALESCE(?, source),
        applicability=COALESCE(?, applicability), status=COALESCE(?, status),
        inclusion_justification=?, exclusion_justification=?
    WHERE id=? AND workspace_id=?`)
    .run(code || null, title || null, source_framework || null,
         applicability || null, status || null,
         inclusion_justification || null, exclusion_justification || null,
         req.params.id, req.workspace.id);
  if (req.query.ajax === '1') return res.status(204).end();
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

app.post('/workspaces/:wsId/iso42001/soa/custom-controls/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM iso42001_soa_custom_controls WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

// Snapshots list
app.get('/workspaces/:wsId/iso42001/soa/snapshots', requireAuth, requireWorkspace, (req, res) => {
  const snapshots = db.prepare(`SELECT s.*, u.name AS created_by_name
    FROM iso42001_soa_snapshots s LEFT JOIN users u ON u.id = s.created_by
    WHERE s.workspace_id=? ORDER BY s.created_at DESC, s.id DESC`).all(req.workspace.id);
  res.render('iso42001_soa_snapshots', { user: req.user, ws: req.workspace, snapshots });
});

// Snapshot diff - compare two snapshots row-by-row, surface applicability/status/justification changes.
app.get('/workspaces/:wsId/iso42001/soa/snapshots/diff', requireAuth, requireWorkspace, (req, res) => {
  const snapshots = db.prepare(`SELECT id, label, version, created_at FROM iso42001_soa_snapshots
    WHERE workspace_id=? ORDER BY created_at DESC, id DESC`).all(req.workspace.id);
  const aId = req.query.a ? parseInt(req.query.a, 10) : (snapshots[1] ? snapshots[1].id : null);
  const bId = req.query.b ? parseInt(req.query.b, 10) : (snapshots[0] ? snapshots[0].id : null);
  let diff = null;
  if (aId && bId && aId !== bId) {
    const a = db.prepare(`SELECT * FROM iso42001_soa_snapshots WHERE id=? AND workspace_id=?`).get(aId, req.workspace.id);
    const b = db.prepare(`SELECT * FROM iso42001_soa_snapshots WHERE id=? AND workspace_id=?`).get(bId, req.workspace.id);
    if (a && b) {
      const ap = JSON.parse(a.payload);
      const bp = JSON.parse(b.payload);
      const byIdA = {}, byIdB = {};
      (ap.rows || []).forEach(r => { byIdA[r.id] = r; });
      (bp.rows || []).forEach(r => { byIdB[r.id] = r; });
      const allIds = Array.from(new Set([...Object.keys(byIdA), ...Object.keys(byIdB)]));
      const changes = [];
      for (const id of allIds) {
        const ra = byIdA[id], rb = byIdB[id];
        const fields = ['applicability', 'status', 'inclusion_justification', 'exclusion_justification'];
        const changed = fields.some(f => (ra && ra[f]) !== (rb && rb[f]));
        if (changed) {
          changes.push({ id, title: (rb && rb.title) || (ra && ra.title) || id,
            before: ra ? fields.reduce((o, f) => (o[f] = ra[f] || '', o), {}) : null,
            after:  rb ? fields.reduce((o, f) => (o[f] = rb[f] || '', o), {}) : null });
        }
      }
      diff = { a, b, changes };
    }
  }
  res.render('iso42001_soa_snapshot_diff', { user: req.user, ws: req.workspace, snapshots, aId, bId, diff });
});

// SoA CSV export
app.get('/workspaces/:wsId/iso42001/export/soa.csv', requireAuth, requireWorkspace, (req, res) => {
  const T = ctlReads.tables(db, req.workspace.id);
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
      COALESCE(cs.applicability,'undecided') AS applicability,
      COALESCE(cs.status,'Not Assessed') AS status,
      cs.inclusion_justification, cs.exclusion_justification
      FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type='control'
      ORDER BY i.sort_order`).all(req.workspace.id);
  const customs = db.prepare(`SELECT code, title, source, applicability, status, inclusion_justification, exclusion_justification
      FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY code, id`).all(req.workspace.id);
  const escape = (s) => s == null ? '' : `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['Code,Title,Category,Applicability,Status,Inclusion justification,Exclusion justification,Source'];
  rows.forEach(r => {
    const code = r.id.replace('ai-annex-', '').toUpperCase().replace(/-/g, '.');
    lines.push([code, r.title, r.category || '', r.applicability, r.status,
      r.inclusion_justification || '', r.exclusion_justification || '', 'ISO 42001 Annex A'].map(escape).join(','));
  });
  customs.forEach(c => {
    lines.push([c.code, c.title, '', c.applicability, c.status,
      c.inclusion_justification || '', c.exclusion_justification || '', c.source || 'Custom'].map(escape).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="iso42001-soa-${(new Date()).toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\n'));
});

// Per-row SoA update.
app.post('/workspaces/:wsId/iso42001/soa/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res, nextMw) => {
  if (['bulk'].includes(req.params.isoId)) return nextMw();
  getOrCreate42State(req.workspace.id, req.params.isoId);
  const { applicability, inclusion_justification, exclusion_justification, status } = req.body;
  db.prepare(`UPDATE iso42001_control_states SET applicability=?, inclusion_justification=?, exclusion_justification=?,
              status = COALESCE(?, status), last_updated = CURRENT_TIMESTAMP
              WHERE workspace_id=? AND iso_item_id=?`)
    .run(applicability || 'undecided',
         inclusion_justification || null, exclusion_justification || null,
         status || null, req.workspace.id, req.params.isoId);
  logAction(req.user.id, req.workspace.id, 'update_iso42001_soa', 'iso42001_item', req.params.isoId, null);
  if (req.query.ajax === '1') return res.status(204).end();
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

// Bulk SoA actions: include_all | include_undecided | apply_to_selected | exclude_selected.
app.post('/workspaces/:wsId/iso42001/soa/bulk', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
  const { action, justification } = req.body;
  const ids = parseFormArray(req.body.iso_id);
  db.prepare(`INSERT OR IGNORE INTO iso42001_control_states (workspace_id, iso_item_id)
              SELECT ?, id FROM iso42001_items WHERE type='control'`).run(req.workspace.id);
  let affected = 0;
  if (action === 'include_all') {
    affected = db.prepare(`UPDATE iso42001_control_states SET applicability='included',
                           inclusion_justification = COALESCE(?, inclusion_justification),
                           last_updated = CURRENT_TIMESTAMP
                           WHERE workspace_id=? AND iso_item_id IN (SELECT id FROM iso42001_items WHERE type='control')`)
      .run(justification || null, req.workspace.id).changes;
  } else if (action === 'include_undecided') {
    affected = db.prepare(`UPDATE iso42001_control_states SET applicability='included',
                           inclusion_justification = COALESCE(?, inclusion_justification),
                           last_updated = CURRENT_TIMESTAMP
                           WHERE workspace_id=? AND applicability='undecided'
                           AND iso_item_id IN (SELECT id FROM iso42001_items WHERE type='control')`)
      .run(justification || null, req.workspace.id).changes;
  } else if (action === 'apply_to_selected' && ids.length) {
    const upd = db.prepare(`UPDATE iso42001_control_states SET applicability='included',
                           inclusion_justification = ?,
                           last_updated = CURRENT_TIMESTAMP
                           WHERE workspace_id=? AND iso_item_id=?`);
    const tx = db.transaction(() => ids.forEach(id => { affected += upd.run(justification || null, req.workspace.id, id).changes; }));
    tx();
  } else if (action === 'exclude_selected' && ids.length) {
    const upd = db.prepare(`UPDATE iso42001_control_states SET applicability='excluded',
                           exclusion_justification = ?,
                           last_updated = CURRENT_TIMESTAMP
                           WHERE workspace_id=? AND iso_item_id=?`);
    const tx = db.transaction(() => ids.forEach(id => { affected += upd.run(justification || null, req.workspace.id, id).changes; }));
    tx();
  }
  logAction(req.user.id, req.workspace.id, 'bulk_iso42001_soa', 'iso42001_item', null, { action, affected });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/soa`);
});

// ==================== ISO 42001 - REMAINING PAGES ====================

// Engagement-plan phases and intake questions for ISO 42001. Kept inline so the
// data colocates with the views that consume it.
const ISO42001_PLAN_PHASES = [
  { key: 'kickoff', title: 'Kickoff & discovery', summary: 'Stakeholder alignment, project charter, governance scope, success criteria.' },
  { key: 'inventory', title: 'AI system inventory & scoping', summary: 'Catalogue AI systems, classify them by lifecycle stage and impact, define AIMS scope (4.3).' },
  { key: 'context', title: 'Context & interested parties (4.1, 4.2)', summary: 'External and internal issues, role determination (provider/developer/deployer), interested-party requirements register.' },
  { key: 'policy', title: 'AI policy & governance setup (5.1, 5.2, 5.3, A.2)', summary: 'Draft and approve AI policy. Assign roles. Establish concerns-reporting channel.' },
  { key: 'risk-impact', title: 'AI risk assessment + impact assessment (6.1.2-6.1.4)', summary: 'Methodology, criteria, first AI risk assessment and AI system impact assessment per scoped AI system.' },
  { key: 'gap', title: 'Annex A gap assessment (6.1.3, A.3-A.10)', summary: 'Walk through the 38 Annex A reference controls, decide applicability, score current state.' },
  { key: 'roadmap', title: 'Roadmap & treatment plan (6.1.3, 6.2)', summary: 'Treatment plan with phased actions and AI objectives.' },
  { key: 'implementation', title: 'Control implementation (Annex A controls)', summary: 'Execute selected Annex A controls and update SoA evidence.' },
  { key: 'monitoring', title: 'Monitoring & measurement setup (9.1)', summary: 'Define metrics (performance, drift, fairness), monitoring tooling, escalation thresholds.' },
  { key: 'internal-audit', title: 'Internal audit (9.2)', summary: 'Plan and run the first internal audit. Track findings and corrective actions.' },
  { key: 'management-review', title: 'Management review (9.3)', summary: 'Conduct the management review, capture inputs/outputs.' },
  { key: 'pre-cert', title: 'Pre-certification readiness review', summary: 'Final readiness check against ISO 42001 conformance criteria; close any open gaps.' }
];

const ISO42001_INTAKE_SECTIONS = [
  {
    title: 'Context & roles',
    blurb: 'Set the AIMS in the right context. Clauses 4.1, 4.2.',
    questions: [
      { id: 'org-context', text: 'How would you describe your organization\'s AI maturity (early experimentation / pilots in production / AI is core to product / AI native)?', type: 'textarea', clause: '4.1', required: true },
      { id: 'role', text: 'Which roles does the organization play with respect to AI systems in scope (provider / developer / deployer / customer / multiple)?', type: 'textarea', clause: '4.1', required: true, hint: 'Different roles bring different obligations - especially under EU AI Act.' },
      { id: 'regulatory', text: 'Which AI-specific regulations or frameworks apply (EU AI Act, NIST AI RMF, sectoral regulation, internal commitments)?', type: 'textarea', clause: '4.2', required: true },
      { id: 'interested-parties', text: 'Who are the interested parties for the AIMS (regulators, customers, employees, suppliers, affected individuals, civil-society)?', type: 'textarea', clause: '4.2', hint: 'List by category. Affected individuals - non-customers the AI decides about - are often missed.' },
    ]
  },
  {
    title: 'AI footprint',
    blurb: 'What AI is actually in scope. Clauses 4.3, A.4.',
    questions: [
      { id: 'system-count', text: 'How many AI systems are currently in production or pilot? Briefly describe the largest 3.', type: 'textarea', clause: '4.3', required: true },
      { id: 'ai-types', text: 'What types of AI are in scope (classical ML, generative AI / LLMs, computer vision, NLP, reinforcement learning, hybrid)?', type: 'text', clause: '4.3' },
      { id: 'use-cases', text: 'What are the highest-stakes AI use cases (people-affecting decisions, automated actions, safety-critical, public-facing)?', type: 'textarea', clause: '4.3' },
      { id: 'high-risk', text: 'Are any of the AI systems high-risk under the EU AI Act or equivalent classification?', type: 'text', clause: '4.2' },
      { id: 'data', text: 'What are the major data sources powering AI systems (proprietary, customer, public datasets, scraped, synthetic, third-party brokers)?', type: 'textarea', clause: 'A.7.3' },
      { id: 'third-party', text: 'Which third-party AI services are critical dependencies (foundation-model APIs, ML platforms, annotation vendors)?', type: 'textarea', clause: 'A.10.3' },
    ]
  },
  {
    title: 'Governance & risk',
    blurb: 'Current state of AI governance. Clauses 5.1, 5.3, 6.1.',
    questions: [
      { id: 'governance', text: 'What AI governance structure exists today (AI ethics board, model-review committee, ad-hoc, none)?', type: 'textarea', clause: '5.3' },
      { id: 'risk-appetite', text: 'What is the organization\'s stated risk appetite for AI (low / moderate / high / not yet defined)?', type: 'text', clause: '6.1.2' },
      { id: 'incidents', text: 'Have there been past AI incidents or near-misses (model failures, bias surfacing, safety events, complaints)?', type: 'textarea', clause: '10.2' },
      { id: 'ethics-published', text: 'Are responsible-AI principles formally published or communicated externally?', type: 'text', clause: '5.2' },
    ]
  },
  {
    title: 'Engagement scope',
    blurb: 'What this engagement will deliver.',
    questions: [
      { id: 'top-concerns', text: 'What are the top 3 concerns you want the AIMS to address?', type: 'textarea', required: true },
      { id: 'target-cert-date', text: 'Target certification date (if any)', type: 'date' },
    ]
  }
];
// Flat list for easy lookup
const ISO42001_INTAKE_QUESTIONS = ISO42001_INTAKE_SECTIONS.flatMap(s => s.questions.map(q => ({ key: q.id, label: q.text })));

// Build a draft AIMS scope statement from intake answers.
function buildIso42001DraftScope(answers) {
  const ans = (k) => (answers[k] || '').trim();
  const lines = [];
  lines.push('AIMS Scope (Clause 4.3) - draft from intake answers');
  lines.push('');
  if (ans('role')) lines.push(`Organizational role(s): ${ans('role')}`);
  if (ans('org-context')) lines.push(`AI maturity context: ${ans('org-context')}`);
  if (ans('system-count')) lines.push(`AI systems in scope: ${ans('system-count')}`);
  if (ans('ai-types')) lines.push(`AI types covered: ${ans('ai-types')}`);
  if (ans('use-cases')) lines.push(`Highest-stakes use cases: ${ans('use-cases')}`);
  if (ans('high-risk')) lines.push(`Regulatory classification: ${ans('high-risk')}`);
  if (ans('regulatory')) lines.push(`Applicable AI obligations: ${ans('regulatory')}`);
  if (ans('data')) lines.push(`Data sources: ${ans('data')}`);
  if (ans('third-party')) lines.push(`Third-party AI dependencies: ${ans('third-party')}`);
  if (lines.length === 2) lines.push('(answer intake questions above to generate scope)');
  return lines.join('\n');
}

// Mechanical question generator: turn the catalog's "applicability questions"
// into yes/partial/no prompts. Mirrors data/assessment-questions.js for ISO 27001.
function iso42001QuestionsFor(item) {
  let qs = [];
  try { qs = JSON.parse(item.questions || '[]'); } catch (_) {}
  return qs;
}

function suggestStatus42(answers, total) {
  if (!answers || !total) return null;
  const score = { yes: 1, partial: 0.5, no: 0 };
  const vals = [];
  for (let i = 0; i < total; i++) { if (answers[String(i)] != null) vals.push(answers[String(i)]); }
  if (vals.length < total) return null;
  const ratio = vals.reduce((s, v) => s + (score[v] || 0), 0) / vals.length;
  if (ratio >= 0.85) return 'Implemented';
  if (ratio >= 0.5)  return 'Partially Implemented';
  if (ratio > 0)     return 'Work In Progress';
  return 'Not Implemented';
}

function nextUnassessed42(wsId, afterSortOrder) {
  return db.prepare(`SELECT i.id FROM iso42001_items i
    LEFT JOIN iso42001_control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND (cs.status IS NULL OR cs.status='Not Assessed')
      AND i.sort_order > ?
    ORDER BY i.sort_order LIMIT 1`).get(wsId, afterSortOrder || 0);
}

// --- Gap assessment ---
app.get('/workspaces/:wsId/iso42001/gap-assessment', requireAuth, requireWorkspace, (req, res) => {
  const passes = db.prepare(`SELECT p.*, (SELECT name FROM users WHERE id = p.started_by) AS started_by_name
    FROM iso42001_assessment_passes p WHERE workspace_id=? ORDER BY pass_number DESC`).all(req.workspace.id);
  const counts = db.prepare(`SELECT
      SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS implemented,
      SUM(CASE WHEN cs.status='Partially Implemented' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN cs.status='Work In Progress' THEN 1 ELSE 0 END) AS wip,
      SUM(CASE WHEN cs.status='Not Implemented' THEN 1 ELSE 0 END) AS notimpl,
      SUM(CASE WHEN cs.status='Not Applicable' THEN 1 ELSE 0 END) AS na,
      SUM(CASE WHEN cs.status IS NULL OR cs.status='Not Assessed' THEN 1 ELSE 0 END) AS unassessed,
      COUNT(i.id) AS total
    FROM iso42001_items i LEFT JOIN iso42001_control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).get(req.workspace.id);
  res.render('iso42001_gap_assessment', { user: req.user, ws: req.workspace, passes, counts });
});

app.post('/workspaces/:wsId/iso42001/gap-assessment/start', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const maxPass = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n FROM iso42001_assessment_passes WHERE workspace_id=?`).get(req.workspace.id).n;
  const passId = db.prepare(`INSERT INTO iso42001_assessment_passes (workspace_id, pass_number, name, started_by)
    VALUES (?, ?, ?, ?)`).run(req.workspace.id, maxPass + 1, `Pass ${maxPass + 1}`, req.user.id).lastInsertRowid;
  logAction(req.user.id, req.workspace.id, 'start_iso42001_pass', 'iso42001_pass', passId, null);
  const first = nextUnassessed42(req.workspace.id, 0);
  if (first) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${first.id}`);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
});

app.post('/workspaces/:wsId/iso42001/gap-assessment/:passId/complete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`UPDATE iso42001_assessment_passes SET status='completed', completed_at=CURRENT_TIMESTAMP
              WHERE id=? AND workspace_id=?`).run(req.params.passId, req.workspace.id);
  logAction(req.user.id, req.workspace.id, 'complete_iso42001_pass', 'iso42001_pass', req.params.passId, null);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
});

// Per-item gap-assessment wizard.
app.get('/workspaces/:wsId/iso42001/gap', requireAuth, requireWorkspace, (req, res) => {
  const next = nextUnassessed42(req.workspace.id, 0);
  if (!next) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${next.id}`);
});

app.get('/workspaces/:wsId/iso42001/gap/:isoId', requireAuth, requireWorkspace, (req, res) => {
  const item = db.prepare(`SELECT * FROM iso42001_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).render('error', { user: req.user, message: 'Item not found.' });
  const state = getOrCreate42State(req.workspace.id, item.id);
  let savedAnswers = {};
  try { if (state.assessment_answers) savedAnswers = JSON.parse(state.assessment_answers) || {}; } catch (_) {}
  const questions = iso42001QuestionsFor(item);
  item.evidence_needed_arr = JSON.parse(item.evidence_needed || '[]');
  item.documentation_needed_arr = JSON.parse(item.documentation_needed || '[]');
  item.common_pitfalls = item.common_pitfalls ? JSON.parse(item.common_pitfalls) : null;
  item.evidence_to_look_for = item.evidence_to_look_for ? JSON.parse(item.evidence_to_look_for) : null;
  item.maturity_ladder = item.maturity_ladder ? JSON.parse(item.maturity_ladder) : null;
  item.related_items = item.related_items ? JSON.parse(item.related_items) : null;

  // Resolve related items to their titles for the chip list.
  let relatedRows = [];
  if (item.related_items && item.related_items.length) {
    const placeholders = item.related_items.map(() => '?').join(',');
    relatedRows = db.prepare(`SELECT id, title FROM iso42001_items WHERE id IN (${placeholders}) ORDER BY sort_order`).all(...item.related_items);
  }

  // Prev/next by sort_order
  const prev = db.prepare(`SELECT id, title FROM iso42001_items WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1`).get(item.sort_order);
  const next = db.prepare(`SELECT id, title FROM iso42001_items WHERE sort_order > ? ORDER BY sort_order LIMIT 1`).get(item.sort_order);

  // Two-section progress totals + position within section
  const totals = db.prepare(`SELECT
      SUM(CASE WHEN i.type='clause' THEN 1 ELSE 0 END) AS clausesTotal,
      SUM(CASE WHEN i.type='control' THEN 1 ELSE 0 END) AS controlsTotal,
      SUM(CASE WHEN i.type='clause' AND cs.status IS NOT NULL AND cs.status!='Not Assessed' THEN 1 ELSE 0 END) AS clausesAssessed,
      SUM(CASE WHEN i.type='control' AND cs.status IS NOT NULL AND cs.status!='Not Assessed' THEN 1 ELSE 0 END) AS controlsAssessed
    FROM iso42001_items i
    LEFT JOIN iso42001_control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).get(req.workspace.id);
  const sectionPosition = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_items WHERE type=? AND sort_order <= ?`).get(item.type, item.sort_order).c;

  // Evidence files attached to this item (reuses the existing evidence table -
  // iso_item_id is TEXT so ai-* ids coexist with ISO 27001 ids).
  const evidenceList = db.prepare(`SELECT e.*, u.name AS uploader,
    (SELECT COUNT(*) FROM evidence e2 WHERE e2.sha256 = e.sha256 AND e2.workspace_id = e.workspace_id) AS link_count
    FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
    WHERE e.workspace_id=? AND e.iso_item_id=? AND e.superseded_at IS NULL
    ORDER BY e.uploaded_at DESC`).all(req.workspace.id, item.id);

  // Open NCs linked to this control (reuses nonconformities table; its
  // iso_item_id is TEXT and FK isn't strictly enforced).
  const openNCs = db.prepare(`SELECT id, title, severity, status, due_date
    FROM nonconformities
    WHERE workspace_id=? AND iso_item_id=? AND status != 'closed'
    ORDER BY created_at DESC, id DESC`).all(req.workspace.id, item.id);

  // Linked risks - workspace risks that have been mapped to this control via
  // the parallel iso42001_risk_controls table.
  const linkedRisks = db.prepare(`SELECT r.id, r.title, r.likelihood, r.impact, r.status
    FROM iso42001_risk_controls rc
    INNER JOIN risks r ON r.id = rc.risk_id
    WHERE r.workspace_id=? AND rc.iso_item_id=?
    ORDER BY (r.likelihood * r.impact) DESC`).all(req.workspace.id, item.id);

  // Linked documents via parallel iso42001_document_controls table.
  const linkedDocs = db.prepare(`SELECT d.id, d.name, d.category, d.status,
      dc.id AS link_id, dc.section_ref
    FROM iso42001_document_controls dc
    INNER JOIN generated_docs d ON d.id = dc.document_id
    WHERE d.workspace_id=? AND dc.iso_item_id=?
    ORDER BY d.name`).all(req.workspace.id, item.id);

  // Documents this workspace has that aren't yet linked - candidates for the link dropdown.
  const linkableDocs = db.prepare(`SELECT id, name, status FROM generated_docs
    WHERE workspace_id=? AND id NOT IN (
      SELECT document_id FROM iso42001_document_controls WHERE iso_item_id=?
    ) ORDER BY name`).all(req.workspace.id, item.id);

  // Risks not yet linked to this control - candidates for the link dropdown.
  const linkableRisks = db.prepare(`SELECT id, title, likelihood, impact FROM risks
    WHERE workspace_id=? AND id NOT IN (
      SELECT risk_id FROM iso42001_risk_controls WHERE iso_item_id=?
    ) ORDER BY (likelihood * impact) DESC, title`).all(req.workspace.id, item.id);

  // Prior-pass notes: most-recent snapshot per past pass for this item.
  const priorPassNotes = db.prepare(`SELECT h.pass_id, h.notes, h.status AS item_status, h.snapshot_at,
      p.pass_number, p.name AS label, p.status AS pass_status, p.completed_at
    FROM iso42001_control_state_history h
    INNER JOIN iso42001_assessment_passes p ON p.id = h.pass_id
    WHERE h.workspace_id=? AND h.iso_item_id=? AND h.pass_id IS NOT NULL AND h.notes IS NOT NULL AND h.notes != ''
      AND h.id = (SELECT MAX(h2.id) FROM iso42001_control_state_history h2
                  WHERE h2.workspace_id=h.workspace_id AND h2.iso_item_id=h.iso_item_id AND h2.pass_id=h.pass_id)
    ORDER BY p.pass_number DESC`).all(req.workspace.id, item.id);

  // Active pass = most recent open pass (or null).
  const activePass = db.prepare(`SELECT id, pass_number, name FROM iso42001_assessment_passes
    WHERE workspace_id=? AND status='open' ORDER BY pass_number DESC LIMIT 1`).get(req.workspace.id);

  // Completion + suggested status
  const doneFlag = totals.clausesAssessed === totals.clausesTotal && totals.controlsAssessed === totals.controlsTotal;
  let suggestedStatus = null;
  try { suggestedStatus = suggestStatus42(savedAnswers, questions.length); } catch (_) {}

  // Comments + review state (parallels the ISO 27001 wizard)
  const commentsRaw42 = db.prepare(`SELECT c.id, c.body, c.internal_only, c.created_at, c.user_id, u.name AS user_name
    FROM comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.workspace_id=? AND c.parent_type='iso42001_item' AND c.parent_id=?
    ORDER BY c.created_at ASC`).all(req.workspace.id, item.id);
  const comments = commentsRaw42.map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
  const firmUsers = db.prepare(`SELECT id, name FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name`).all(req.workspace.firm_id);
  let requestedByName = null, reviewedByName = null;
  if (state.review_requested_by) requestedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.review_requested_by)?.name;
  if (state.reviewed_by) reviewedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.reviewed_by)?.name;
  const isReviewer = req.user.user_type === 'firm' && ['manager','senior_consultant'].includes(rbac.normalizeRole(req.user.firm_role));

  res.render('iso42001_gap_detail', { user: req.user, ws: req.workspace, item, state,
    questions, savedAnswers, suggestedStatus,
    prev, next, totals, sectionPosition, doneFlag,
    relatedRows, evidenceList, openNCs, linkedRisks, linkedDocs, linkableDocs, linkableRisks,
    priorPassNotes, activePass,
    comments, firmUsers, requestedByName, reviewedByName, isReviewer });
});

app.post('/workspaces/:wsId/iso42001/gap/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT * FROM iso42001_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  getOrCreate42State(req.workspace.id, item.id);

  const action = req.body.action || 'save';
  const nextItem = db.prepare(`SELECT id FROM iso42001_items WHERE sort_order > ? ORDER BY sort_order LIMIT 1`).get(item.sort_order);
  // Skip without saving - just navigate forward
  if (action === 'skip') {
    if (nextItem) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${nextItem.id}`);
    return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap-assessment`);
  }

  // Collect answers from body (keys like q_0, q_1, ...)
  const answers = {};
  for (const k of Object.keys(req.body)) {
    if (k.startsWith('q_')) answers[k.slice(2)] = req.body[k];
  }
  const questions = iso42001QuestionsFor(item);
  const suggested = suggestStatus42(answers, questions.length);
  const { status, notes, maturity, applicability, inclusion_justification, exclusion_justification } = req.body;

  db.prepare(`UPDATE iso42001_control_states
              SET assessment_answers=?,
                  status = COALESCE(?, ?, status),
                  notes = COALESCE(?, notes),
                  maturity = COALESCE(?, maturity),
                  applicability = COALESCE(?, applicability),
                  inclusion_justification = COALESCE(?, inclusion_justification),
                  exclusion_justification = COALESCE(?, exclusion_justification),
                  last_updated = CURRENT_TIMESTAMP
              WHERE workspace_id=? AND iso_item_id=?`)
    .run(JSON.stringify(answers),
         status || null, suggested,
         notes || null,
         maturity != null && maturity !== '' ? parseInt(maturity, 10) : null,
         applicability || null,
         inclusion_justification || null,
         exclusion_justification || null,
         req.workspace.id, item.id);
  logAction(req.user.id, req.workspace.id, 'assess_iso42001', 'iso42001_item', item.id, { suggested });

  // Snapshot to history. pass_id ties the snapshot to the active pass if any.
  const cur = db.prepare(`SELECT * FROM iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
  const activePass = db.prepare(`SELECT id FROM iso42001_assessment_passes
    WHERE workspace_id=? AND status='open' ORDER BY pass_number DESC LIMIT 1`).get(req.workspace.id);
  db.prepare(`INSERT INTO iso42001_control_state_history
    (workspace_id, iso_item_id, pass_id, changed_by, status, applicability, maturity,
     inclusion_justification, exclusion_justification, notes, assessment_answers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.workspace.id, item.id, activePass ? activePass.id : null, req.user.id,
         cur.status, cur.applicability, cur.maturity,
         cur.inclusion_justification, cur.exclusion_justification,
         cur.notes, cur.assessment_answers);

  if (action === 'save' && nextItem) {
    return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${nextItem.id}`);
  }
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
});

// --- Linkage POST routes: connect risks/docs to ISO 42001 controls ---
app.post('/workspaces/:wsId/iso42001/controls/:isoId/documents', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { document_id, section_ref } = req.body;
  if (!document_id) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
  // Sanity check the doc belongs to this workspace.
  const doc = db.prepare(`SELECT id FROM generated_docs WHERE id=? AND workspace_id=?`).get(document_id, req.workspace.id);
  if (!doc) return res.status(404).send('Document not found');
  db.prepare(`INSERT OR IGNORE INTO iso42001_document_controls (document_id, iso_item_id, section_ref) VALUES (?, ?, ?)`)
    .run(document_id, req.params.isoId, section_ref || null);
  logAction(req.user.id, req.workspace.id, 'link_iso42001_doc', 'iso42001_item', req.params.isoId, { document_id });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
});

// ---- ISO 42001 flag-for-review (parallels the ISO 27001 routes above) ----
app.post('/workspaces/:wsId/iso42001/gap/:isoId/flag-for-review', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id FROM iso42001_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  db.prepare(`INSERT OR IGNORE INTO iso42001_control_states (workspace_id, iso_item_id) VALUES (?, ?)`).run(req.workspace.id, item.id);
  db.prepare(`UPDATE iso42001_control_states
    SET review_status='requested', review_requested_by=?, review_requested_at=CURRENT_TIMESTAMP, review_reason=?,
        reviewed_by=NULL, reviewed_at=NULL
    WHERE workspace_id=? AND iso_item_id=?`)
    .run(req.user.id, req.body.reason || null, req.workspace.id, item.id);
  logAction(req.user.id, req.workspace.id, 'flag_for_review', 'iso42001_item', item.id, { reason: req.body.reason }, auditCtx(req));
  notifyReviewers(req.workspace.id, req.user.id, item, req.body.reason, 'iso42001');
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
});

app.post('/workspaces/:wsId/iso42001/gap/:isoId/review-action', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id FROM iso42001_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  const action = req.body.action;
  if (!['approve', 'send_back'].includes(action)) return res.status(400).send('Bad action');
  const newStatus = action === 'approve' ? 'reviewed' : 'needs_changes';
  const cur = db.prepare(`SELECT review_requested_by FROM iso42001_control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
  db.prepare(`UPDATE iso42001_control_states SET review_status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
    WHERE workspace_id=? AND iso_item_id=?`).run(newStatus, req.user.id, req.workspace.id, item.id);
  logAction(req.user.id, req.workspace.id, 'review_action', 'iso42001_item', item.id, { action, note: req.body.note }, auditCtx(req));
  if (cur && cur.review_requested_by && cur.review_requested_by !== req.user.id) {
    const code = item.id.replace('ai-annex-','').replace('ai-clause-','').toUpperCase().replace(/-/g,'.');
    const verb = action === 'approve' ? 'approved your review on' : 'sent back your review on';
    jobs.notify(req.workspace.id, cur.review_requested_by, 'review_complete', 'info',
      `Reviewer ${verb} ${code}`, (req.body.note || '').slice(0, 140),
      `/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
  }
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
});

app.post('/workspaces/:wsId/iso42001/gap/:isoId/clear-flag', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const item = db.prepare(`SELECT id FROM iso42001_items WHERE id=?`).get(req.params.isoId);
  if (!item) return res.status(404).send('Not found');
  db.prepare(`UPDATE iso42001_control_states
    SET review_status='none', review_requested_by=NULL, review_requested_at=NULL, review_reason=NULL,
        reviewed_by=NULL, reviewed_at=NULL
    WHERE workspace_id=? AND iso_item_id=?`).run(req.workspace.id, item.id);
  logAction(req.user.id, req.workspace.id, 'clear_review_flag', 'iso42001_item', item.id, null, auditCtx(req));
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${item.id}`);
});

app.post('/workspaces/:wsId/iso42001/controls/:isoId/documents/:linkId/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  // Verify the link belongs to a doc in this workspace before deleting.
  const link = db.prepare(`SELECT dc.* FROM iso42001_document_controls dc
    INNER JOIN generated_docs d ON d.id = dc.document_id
    WHERE dc.id=? AND dc.iso_item_id=? AND d.workspace_id=?`).get(req.params.linkId, req.params.isoId, req.workspace.id);
  if (link) {
    db.prepare(`DELETE FROM iso42001_document_controls WHERE id=?`).run(link.id);
  }
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
});

app.post('/workspaces/:wsId/iso42001/controls/:isoId/risks', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { risk_id } = req.body;
  if (!risk_id) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
  // Sanity check the risk belongs to this workspace.
  const risk = db.prepare(`SELECT id FROM risks WHERE id=? AND workspace_id=?`).get(risk_id, req.workspace.id);
  if (!risk) return res.status(404).send('Risk not found');
  db.prepare(`INSERT OR IGNORE INTO iso42001_risk_controls (risk_id, iso_item_id) VALUES (?, ?)`)
    .run(risk_id, req.params.isoId);
  logAction(req.user.id, req.workspace.id, 'link_iso42001_risk', 'iso42001_item', req.params.isoId, { risk_id });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
});

app.post('/workspaces/:wsId/iso42001/controls/:isoId/risks/:linkRiskId/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM iso42001_risk_controls WHERE risk_id=? AND iso_item_id=?`)
    .run(req.params.linkRiskId, req.params.isoId);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/gap/${req.params.isoId}`);
});

// --- Roadmap ---
app.get('/workspaces/:wsId/iso42001/roadmap', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const T = ctlReads.tables(db, wsId);
  const rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
      COALESCE(cs.applicability,'undecided') AS applicability,
      cs.maturity, cs.owner_id, cs.due_date, cs.roadmap_phase,
      (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
      FROM iso42001_items i
      LEFT JOIN ${T.cs42} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type='control'
      ORDER BY i.sort_order`).all(wsId);
  const phases = [
    { key: '0_3M', label: '0-3 months (now)' },
    { key: '3_6M', label: '3-6 months' },
    { key: '6_12M', label: '6-12 months' },
    { key: '12M_plus', label: '12+ months' },
    { key: '', label: 'Unscheduled' }
  ];
  const grouped = phases.map(p => ({ ...p, rows: rows.filter(r => (r.roadmap_phase || '') === p.key) }));

  // "Needs your attention" - live items needing action
  const today = (new Date()).toISOString().slice(0, 10);
  const soon = (new Date(Date.now() + 30 * 86400000)).toISOString().slice(0, 10);
  const needsAttention = [];

  // Overdue
  db.prepare(`SELECT i.id, i.title, cs.due_date FROM iso42001_items i
    INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND cs.due_date < ? AND cs.status != 'Implemented'
    ORDER BY cs.due_date LIMIT 5`).all(wsId, today).forEach(r => {
      needsAttention.push({ severity: 'high', category: 'Overdue',
        title: r.title, detail: `Due ${r.due_date} - past due`,
        link: `/workspaces/${wsId}/iso42001/gap/${r.id}` });
  });

  // Due soon
  db.prepare(`SELECT i.id, i.title, cs.due_date FROM iso42001_items i
    INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND cs.due_date >= ? AND cs.due_date < ? AND cs.status != 'Implemented'
    ORDER BY cs.due_date LIMIT 5`).all(wsId, today, soon).forEach(r => {
      needsAttention.push({ severity: 'medium', category: 'Due soon',
        title: r.title, detail: `Due ${r.due_date}`,
        link: `/workspaces/${wsId}/iso42001/gap/${r.id}` });
  });

  // Mandatory clauses not implemented
  db.prepare(`SELECT i.id, i.title FROM iso42001_items i
    LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='clause' AND (cs.status IS NULL OR cs.status != 'Implemented')
    ORDER BY i.sort_order LIMIT 5`).all(wsId).forEach(r => {
      needsAttention.push({ severity: 'high', category: 'Clause',
        title: r.title, detail: 'Mandatory MS clause not yet at Implemented',
        link: `/workspaces/${wsId}/iso42001/gap/${r.id}` });
  });

  // Open NCs on ISO 42001 items
  db.prepare(`SELECT id, title, severity FROM nonconformities
    WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'
    ORDER BY created_at DESC LIMIT 5`).all(wsId).forEach(r => {
      needsAttention.push({ severity: r.severity === 'major' ? 'high' : 'medium', category: 'NC',
        title: r.title, detail: 'Open nonconformity',
        link: `/workspaces/${wsId}/nonconformities/${r.id}` });
  });

  // Implementation roadmap milestones - data-driven PDCA
  const clauseStatus = {};
  db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS s FROM iso42001_items i
    LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).all(wsId)
    .forEach(r => { clauseStatus[r.id] = r.s; });
  const ctlStats = db.prepare(`SELECT
      SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS impl,
      SUM(CASE WHEN COALESCE(cs.applicability,'undecided')='included' THEN 1 ELSE 0 END) AS included,
      COUNT(*) AS total
    FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control'`).get(wsId);
  const ncOpen = db.prepare(`SELECT COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'`).get(wsId).c;
  const ncTotal = db.prepare(`SELECT COUNT(*) AS c FROM nonconformities WHERE workspace_id=? AND iso_item_id LIKE 'ai-%'`).get(wsId).c;
  const intakeDone = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_intake_answers WHERE workspace_id=? AND answer IS NOT NULL AND answer != ''`).get(wsId).c >= 8;
  const planDone = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_engagement_plan_progress WHERE workspace_id=? AND completed_at IS NOT NULL`).get(wsId).c;
  const passOpen = db.prepare(`SELECT COUNT(*) AS c FROM iso42001_assessment_passes WHERE workspace_id=? AND status='completed'`).get(wsId).c;

  const milestone = (phase, label, clause, detail, done, partial, link, link_label) => ({ phase, label, clause, detail, done, partial, link, link_label });
  const roadmap = [
    // PLAN
    milestone('plan', 'Engagement intake', '4.1, 4.2', 'Capture AI context, role determination, regulatory obligations',
      intakeDone, !intakeDone && planDone > 0, `/workspaces/${wsId}/iso42001/intake`, 'Open intake'),
    milestone('plan', 'AIMS scope defined', '4.3', 'Document in-scope AI systems and exclusions',
      clauseStatus['ai-clause-4.3'] === 'Implemented', ['Partially Implemented','Work In Progress'].includes(clauseStatus['ai-clause-4.3']),
      `/workspaces/${wsId}/iso42001/gap/ai-clause-4.3`, 'Open clause 4.3'),
    milestone('plan', 'AI policy approved', '5.2', 'Top-management approved AI policy with prohibited uses',
      clauseStatus['ai-clause-5.2'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-5.2`, 'Open clause 5.2'),
    milestone('plan', 'AI risk assessment methodology', '6.1.2', 'Documented methodology with AI risk criteria',
      clauseStatus['ai-clause-6.1.2'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-6.1.2`, 'Open clause 6.1.2'),
    milestone('plan', 'AI risk treatment + SoA', '6.1.3', 'Treatment plan + Statement of Applicability',
      clauseStatus['ai-clause-6.1.3'] === 'Implemented' && ctlStats.included > 0,
      ctlStats.included > 0 && clauseStatus['ai-clause-6.1.3'] !== 'Implemented',
      `/workspaces/${wsId}/iso42001/soa`, 'Open SoA'),
    milestone('plan', 'Impact assessment methodology', '6.1.4', 'AI system impact assessment process',
      clauseStatus['ai-clause-6.1.4'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-6.1.4`, 'Open clause 6.1.4'),
    milestone('plan', 'AI objectives set', '6.2', 'Measurable AI objectives with targets and owners',
      clauseStatus['ai-clause-6.2'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-6.2`, 'Open clause 6.2'),

    // DO
    milestone('do', 'Roles assigned', '5.3, A.3.2', 'AI roles defined and named',
      clauseStatus['ai-clause-5.3'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-5.3`, 'Open clause 5.3'),
    milestone('do', 'Competence + awareness', '7.2, 7.3', 'Training delivered; competence records exist',
      clauseStatus['ai-clause-7.2'] === 'Implemented' && clauseStatus['ai-clause-7.3'] === 'Implemented',
      [clauseStatus['ai-clause-7.2'], clauseStatus['ai-clause-7.3']].some(s => s !== 'Not Assessed'),
      `/workspaces/${wsId}/iso42001/gap/ai-clause-7.2`, 'Open clause 7.2'),
    milestone('do', 'Annex A controls implemented', 'Annex A', `${ctlStats.impl}/${ctlStats.included} included controls at Implemented`,
      ctlStats.included > 0 && ctlStats.impl === ctlStats.included,
      ctlStats.impl > 0 && ctlStats.impl < ctlStats.included,
      `/workspaces/${wsId}/iso42001/controls`, 'Open controls'),
    milestone('do', 'Monitoring & operation', '9.1, A.6.2.6', 'Monitoring of AI systems (drift, fairness, performance)',
      clauseStatus['ai-clause-9.1'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-9.1`, 'Open clause 9.1'),

    // CHECK
    milestone('check', 'Internal audit', '9.2', `First internal audit pass complete${passOpen > 0 ? ` (${passOpen} passes done)` : ''}`,
      passOpen > 0 && clauseStatus['ai-clause-9.2'] === 'Implemented',
      passOpen > 0 && clauseStatus['ai-clause-9.2'] !== 'Implemented',
      `/workspaces/${wsId}/iso42001/gap-assessment`, 'Open passes'),
    milestone('check', 'Management review', '9.3', 'Top management review with all required inputs',
      clauseStatus['ai-clause-9.3'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-9.3`, 'Open clause 9.3'),

    // ACT
    milestone('act', 'Nonconformities closed', '10.2', `${ncTotal - ncOpen}/${ncTotal} NCs closed`,
      ncTotal > 0 && ncOpen === 0,
      ncOpen > 0,
      `/workspaces/${wsId}/nonconformities`, 'Open NCs'),
    milestone('act', 'Continual improvement', '10.1', 'Improvement initiatives tracked and acted on',
      clauseStatus['ai-clause-10.1'] === 'Implemented', false,
      `/workspaces/${wsId}/iso42001/gap/ai-clause-10.1`, 'Open clause 10.1'),
  ];

  res.render('iso42001_roadmap', { user: req.user, ws: req.workspace, grouped, phases, needsAttention, roadmap });
});

app.post('/workspaces/:wsId/iso42001/roadmap/:isoId/phase', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  getOrCreate42State(req.workspace.id, req.params.isoId);
  db.prepare(`UPDATE iso42001_control_states SET roadmap_phase = ?, last_updated = CURRENT_TIMESTAMP
              WHERE workspace_id=? AND iso_item_id=?`)
    .run(req.body.phase || null, req.workspace.id, req.params.isoId);
  if (req.query.ajax === '1') return res.status(204).end();
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/roadmap`);
});

// --- Readiness (computed scorecard) ---
function computeIso42001Readiness(wsId) {
  const T = ctlReads.tables(db, wsId);
  // Aggregate control-state numbers
  const m = db.prepare(`SELECT
      SUM(CASE WHEN i.type='clause' AND cs.status='Implemented' THEN 1 ELSE 0 END) AS clauseImpl,
      SUM(CASE WHEN i.type='clause' THEN 1 ELSE 0 END) AS clauseTotal,
      SUM(CASE WHEN i.type='control' AND cs.status='Implemented' THEN 1 ELSE 0 END) AS implemented,
      SUM(CASE WHEN i.type='control' AND cs.status='Partially Implemented' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN i.type='control' AND cs.status='Work In Progress' THEN 1 ELSE 0 END) AS wip,
      SUM(CASE WHEN i.type='control' AND cs.status='Not Implemented' THEN 1 ELSE 0 END) AS notImpl,
      SUM(CASE WHEN i.type='control' AND cs.status='Not Applicable' THEN 1 ELSE 0 END) AS na,
      SUM(CASE WHEN i.type='control' AND COALESCE(cs.status,'Not Assessed')='Not Assessed' THEN 1 ELSE 0 END) AS unassessed,
      SUM(CASE WHEN i.type='control' THEN 1 ELSE 0 END) AS ctlTotal,
      AVG(CASE WHEN i.type='control' AND cs.maturity > 0 THEN cs.maturity END) AS avgMaturity
    FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?`).get(wsId);

  // Stage 1 = documentation / framework. Heuristic: clauses (4-10) + policy / governance controls (A.2, A.3, A.5).
  const stage1 = db.prepare(`SELECT
      SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS impl,
      COUNT(*) AS total
    FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='clause' OR i.category IN ('a-policies','b-internal-organization','d-impact-assessment')`).get(wsId);
  const stage1Pct = stage1.total ? Math.round((stage1.impl / stage1.total) * 100) : 0;

  // Stage 2 = operational effectiveness. Annex A controls outside the Stage 1 set.
  const stage2 = db.prepare(`SELECT
      SUM(CASE WHEN cs.status='Implemented' THEN 1 ELSE 0 END) AS impl,
      COUNT(*) AS total
    FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control'
      AND i.category NOT IN ('a-policies','b-internal-organization','d-impact-assessment')
      AND COALESCE(cs.applicability,'undecided') != 'excluded'`).get(wsId);
  const stage2Pct = stage2.total ? Math.round((stage2.impl / stage2.total) * 100) : 0;

  // Documented information: heuristic detection via clause status (Implemented = doc exists).
  const clauseStatusById = {};
  db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS status
    FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='clause'`).all(wsId).forEach(r => { clauseStatusById[r.id] = r.status; });
  const controlStatusById = {};
  db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS status, COALESCE(cs.applicability,'undecided') AS applicability
    FROM iso42001_items i LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control'`).all(wsId).forEach(r => { controlStatusById[r.id] = r; });

  const docCheck = (clauseId, name) => ({ name, clause: clauseId.replace('ai-clause-',''), found: clauseStatusById[clauseId] === 'Implemented' });
  const mandatoryChecks = [
    docCheck('ai-clause-4.3', 'AIMS scope'),
    docCheck('ai-clause-5.2', 'AI policy'),
    docCheck('ai-clause-6.1.2', 'AI risk assessment process'),
    docCheck('ai-clause-6.1.3', 'AI risk treatment process & SoA'),
    docCheck('ai-clause-6.1.4', 'AI system impact assessment process'),
    docCheck('ai-clause-6.2', 'AI objectives'),
    docCheck('ai-clause-7.5', 'Documented information control'),
    docCheck('ai-clause-8.2', 'AI risk assessment results'),
    docCheck('ai-clause-8.3', 'AI risk treatment results'),
    docCheck('ai-clause-8.4', 'AI system impact assessment results'),
    docCheck('ai-clause-9.2', 'Internal audit programme & results'),
    docCheck('ai-clause-9.3', 'Management review results'),
    docCheck('ai-clause-10.2', 'Nonconformity records'),
  ];
  const mandatoryFound = mandatoryChecks.filter(c => c.found).length;

  const expectedCheck = (ctlId, name) => ({
    name, clause: ctlId.replace('ai-annex-','').toUpperCase().replace(/-/g,'.'),
    found: controlStatusById[ctlId] && controlStatusById[ctlId].status === 'Implemented'
  });
  const expectedChecks = [
    expectedCheck('ai-annex-a-4-2', 'AI system inventory'),
    expectedCheck('ai-annex-a-4-3', 'Dataset documentation (datasheets)'),
    expectedCheck('ai-annex-a-5-3', 'Impact assessment reports per system'),
    expectedCheck('ai-annex-a-6-2-3', 'Design / model documentation'),
    expectedCheck('ai-annex-a-6-2-4', 'Verification & validation reports'),
    expectedCheck('ai-annex-a-6-2-7', 'AI system technical documentation / model cards'),
    expectedCheck('ai-annex-a-6-2-8', 'Event logs specification'),
    expectedCheck('ai-annex-a-7-5', 'Data lineage records'),
  ];
  const expectedFound = expectedChecks.filter(c => c.found).length;

  // Detected gaps - flags by category, severity
  const flags = [];
  // Included controls with no risk linkage (weak 6.1.3 traceability)
  const unjustified = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
    INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND cs.applicability='included'
      AND NOT EXISTS (SELECT 1 FROM iso42001_risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?)
    ORDER BY i.sort_order LIMIT 20`).all(wsId, wsId);
  if (unjustified.length) flags.push({ kind: 'unjustified_inclusions', label: 'Included Annex A controls with no linked risk', severity: 'medium', items: unjustified });

  // Annex A controls Included but Not Implemented / Partial
  const notReady = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
    INNER JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND cs.applicability='included'
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    ORDER BY i.sort_order LIMIT 20`).all(wsId);
  if (notReady.length) flags.push({ kind: 'controls_not_ready', label: 'Included Annex A controls not yet Implemented', severity: 'high', items: notReady });

  // Unassessed clauses (mandatory)
  const unassessedClauses = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
    LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='clause' AND (cs.status IS NULL OR cs.status='Not Assessed')
    ORDER BY i.sort_order`).all(wsId);
  if (unassessedClauses.length) flags.push({ kind: 'unassessed_clauses', label: 'Mandatory clauses not yet assessed', severity: 'high', items: unassessedClauses });

  // Undecided applicability
  const undecided = db.prepare(`SELECT i.id, i.title FROM iso42001_items i
    LEFT JOIN ${T.cs42} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND COALESCE(cs.applicability,'undecided')='undecided'
    ORDER BY i.sort_order LIMIT 10`).all(wsId);
  if (undecided.length) flags.push({ kind: 'undecided_soa', label: 'Annex A controls with undecided applicability', severity: 'medium', items: undecided });

  // Open NCs on ISO 42001 items
  const openNCs = db.prepare(`SELECT id, title FROM nonconformities
    WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'
    ORDER BY created_at DESC LIMIT 20`).all(wsId);
  if (openNCs.length) flags.push({ kind: 'open_ncs', label: 'Open nonconformities on ISO 42001 items', severity: 'high', items: openNCs });

  // Days to target cert
  let daysToTarget = null;
  const ws = db.prepare('SELECT target_cert_date FROM workspaces WHERE id=?').get(wsId);
  if (ws && ws.target_cert_date) {
    const t = new Date(ws.target_cert_date).getTime();
    daysToTarget = Math.round((t - Date.now()) / 86400000);
  }

  const evidenceCount = db.prepare(`SELECT COUNT(*) AS c FROM evidence
    WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND superseded_at IS NULL`).get(wsId).c;

  return {
    stage1: stage1Pct, stage2: stage2Pct, daysToTarget,
    records: {
      total: mandatoryChecks.length + expectedChecks.length,
      found: mandatoryFound + expectedFound,
      mandatory: { total: mandatoryChecks.length, found: mandatoryFound, checks: mandatoryChecks },
      expected: { total: expectedChecks.length, found: expectedFound, checks: expectedChecks }
    },
    metrics: {
      implemented: m.implemented || 0, partial: m.partial || 0, wip: m.wip || 0,
      notImpl: m.notImpl || 0, na: m.na || 0, unassessed: m.unassessed || 0,
      avgMaturity: m.avgMaturity ? m.avgMaturity.toFixed(1) : '0.0',
      evidenceCount
    },
    flags
  };
}

app.get('/workspaces/:wsId/iso42001/readiness', requireAuth, requireWorkspace, (req, res) => {
  const r = computeIso42001Readiness(req.workspace.id);
  res.render('iso42001_readiness', { user: req.user, ws: req.workspace, r });
});

// Unified readiness view - the "executive brief" moment. Shows a headline
// score per enabled framework side-by-side so a sponsor sees engagement
// health at a glance. Each tile deep-links into the per-framework
// readiness page for detail.
app.get('/workspaces/:wsId/readiness/overview', requireAuth, requireWorkspace, (req, res) => {
  const ws = req.workspace;
  const tiles = [];

  if (ws.frameworks.includes('iso27001')) {
    const r = computeReadiness(ws);
    tiles.push({
      key: 'iso27001',
      label: 'ISO 27001:2022',
      sub: 'Information security management',
      score: r.stage1,
      stage2: r.stage2,
      detail: `${r.metrics.implemented} / ${r.metrics.totalItems} implemented · ${r.metrics.partial} partial · ${r.metrics.notImpl} not implemented`,
      flagsHigh: r.flags.filter(f => f.severity === 'high').length,
      href: `/workspaces/${ws.id}/readiness`,
      color: '#4F46E5'
    });
  }

  if (ws.frameworks.includes('iso42001')) {
    const r = computeIso42001Readiness(ws.id);
    tiles.push({
      key: 'iso42001',
      label: 'ISO 42001:2023',
      sub: 'AI management system',
      score: r.stage1,
      stage2: r.stage2,
      detail: `${r.metrics.implemented} implemented · ${r.metrics.partial} partial · ${r.metrics.notImpl} not implemented`,
      flagsHigh: r.flags ? r.flags.filter(f => f.severity === 'high').length : 0,
      href: `/workspaces/${ws.id}/iso42001/readiness`,
      color: '#0891B2'
    });
  }

  if (ws.frameworks.includes('csf')) {
    // Most-recently-touched non-deleted engagement, if any. A workspace may
    // have multiple CSF engagements; the most-recent is the right "current"
    // for an executive overview. If none exists we still render a tile so
    // the consultant can click through and create one.
    const eng = db.prepare(`SELECT * FROM csf_engagements
      WHERE workspace_id=? AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC LIMIT 1`).get(ws.id);
    let score = 0, detail = 'No engagement started yet';
    let href = `/workspaces/${ws.id}/csf`;
    if (eng) {
      const counts = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='Approved' THEN 1 ELSE 0 END) AS approved
        FROM csf_subcategory_assessments WHERE engagement_id=?`).get(eng.id);
      const approved = counts.approved || 0;
      const total = counts.total || 0;
      score = total ? Math.round(approved / total * 100) : 0;
      detail = `${approved} / ${total} subcategories approved · "${eng.name}" · ${eng.status}`;
      href = `/workspaces/${ws.id}/csf/${eng.id}/scores`;
    }
    tiles.push({
      key: 'csf',
      label: 'NIST CSF 2.0',
      sub: 'Cybersecurity Framework',
      score, detail, href,
      flagsHigh: 0,
      color: '#7C3AED'
    });
  }

  // Days to target cert for the page subhead (same field powers all three).
  let daysToTarget = null;
  if (ws.target_cert_date) {
    daysToTarget = Math.round((new Date(ws.target_cert_date).getTime() - Date.now()) / 86400000);
  }

  res.render('readiness_overview', {
    user: req.user, ws, tiles, daysToTarget,
    title: 'Readiness overview'
  });
});

// Pre-cert blocker check - the long-form list of items that must be cleared
// before a Stage 2 audit.
app.get('/workspaces/:wsId/iso42001/readiness/blockers', requireAuth, requireWorkspace, (req, res) => {
  const r = computeIso42001Readiness(req.workspace.id);
  const blockers = r.flags.filter(f => f.severity === 'high');
  res.render('iso42001_readiness_blockers', { user: req.user, ws: req.workspace, blockers });
});

// --- Exec brief ---
app.get('/workspaces/:wsId/iso42001/exec-brief', requireAuth, requireWorkspace, (req, res) => {
  const wsId = req.workspace.id;
  const readiness = computeIso42001Readiness(wsId);

  // Velocity: controls moved to Implemented in last 30 vs prior 30 days, from history.
  const now = Date.now();
  const t30 = new Date(now - 30 * 86400000).toISOString();
  const t60 = new Date(now - 60 * 86400000).toISOString();
  const velocityNow = db.prepare(`SELECT COUNT(DISTINCT iso_item_id) AS c FROM iso42001_control_state_history
    WHERE workspace_id=? AND status='Implemented' AND snapshot_at > ?`).get(wsId, t30).c;
  const velocityPrior = db.prepare(`SELECT COUNT(DISTINCT iso_item_id) AS c FROM iso42001_control_state_history
    WHERE workspace_id=? AND status='Implemented' AND snapshot_at > ? AND snapshot_at <= ?`).get(wsId, t60, t30).c;
  const velocityDelta = velocityNow - velocityPrior;

  // Residual ALE heuristic: Σ (likelihood/5 × impact × $50k) for open AI-linked risks.
  // We use risks linked to any iso42001 item; if none linked, fall back to all open workspace risks.
  const openRisks = db.prepare(`SELECT DISTINCT r.id, r.title, r.likelihood, r.impact, r.owner_name, r.status
    FROM risks r WHERE r.workspace_id=? AND r.status != 'closed'
      AND (r.id IN (SELECT risk_id FROM iso42001_risk_controls)
           OR NOT EXISTS (SELECT 1 FROM iso42001_risk_controls))
    ORDER BY (r.likelihood * r.impact) DESC`).all(wsId);
  const residualAle = openRisks.reduce((s, r) => s + Math.round((r.likelihood / 5) * (r.impact || 0) * 50000), 0);
  const topRisks = openRisks.slice(0, 5).map(r => ({ ...r, score: (r.likelihood||0) * (r.impact||0) }));
  const openRiskCount = openRisks.length;

  // Engagement plan progress
  const phases = ISO42001_PLAN_PHASES;
  const progressRows = db.prepare(`SELECT phase_key, completed_at FROM iso42001_engagement_plan_progress WHERE workspace_id=?`).all(wsId);
  const planTotal = phases.length;
  const planDone = progressRows.filter(p => p.completed_at).length;
  const planPct = planTotal ? Math.round((planDone / planTotal) * 100) : 0;

  // Open NCs on ISO 42001 items, with severity tally + overdue count
  const ncs = db.prepare(`SELECT * FROM nonconformities
    WHERE workspace_id=? AND iso_item_id LIKE 'ai-%' AND status != 'closed'
    ORDER BY due_date IS NULL, due_date`).all(wsId);
  const today = (new Date()).toISOString().slice(0, 10);
  const ncTotals = {
    major: ncs.filter(n => n.severity === 'major').length,
    minor: ncs.filter(n => n.severity === 'minor').length,
    other: ncs.filter(n => n.severity && !['major','minor'].includes(n.severity)).length,
    overdue: ncs.filter(n => n.due_date && n.due_date < today).length
  };
  const topNCs = ncs.slice(0, 5);

  res.render('iso42001_exec_brief', { user: req.user, ws: req.workspace,
    readiness, velocityNow, velocityPrior, velocityDelta, residualAle, openRiskCount,
    planDone, planTotal, planPct, ncTotals, topRisks, topNCs });
});

// --- Cert cycle ---
const ISO42001_EVENT_TYPES = [
  { key: 'stage1', label: 'Stage 1 audit', desc: 'Documentation review by the cert body. AIMS scope, AI policy, SoA, methodology docs.' },
  { key: 'stage2', label: 'Stage 2 audit', desc: 'Operational audit. Auditors test that the AIMS works in practice across in-scope AI systems.' },
  { key: 'surv1',  label: 'Surveillance audit (year 1)', desc: 'Annual surveillance by the cert body to confirm continued conformance.' },
  { key: 'surv2',  label: 'Surveillance audit (year 2)', desc: 'Second annual surveillance.' },
  { key: 'recert', label: 'Recertification audit', desc: 'Three-year recertification - full reassessment.' },
  { key: 'internal', label: 'Internal audit', desc: 'Internal audit pass (clause 9.2).' },
  { key: 'mrm', label: 'Management review', desc: 'Top-management review of the AIMS (clause 9.3).' },
];

app.get('/workspaces/:wsId/iso42001/cert-cycle', requireAuth, requireWorkspace, (req, res) => {
  const events = db.prepare(`SELECT * FROM iso42001_cert_cycle_events WHERE workspace_id=? ORDER BY planned_date, id`).all(req.workspace.id);
  res.render('iso42001_cert_cycle', { user: req.user, ws: req.workspace, events, eventTypes: ISO42001_EVENT_TYPES });
});

// Seed default cycle - 5 standard events based on the target cert date or today + 60 days.
app.post('/workspaces/:wsId/iso42001/cert-cycle/seed', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const ws = db.prepare(`SELECT target_cert_date FROM workspaces WHERE id=?`).get(req.workspace.id);
  const stage1 = ws && ws.target_cert_date ? new Date(ws.target_cert_date) : new Date(Date.now() + 60 * 86400000);
  // Cert target -> Stage 2 date. Stage 1 = -30 days, surveillance +12mo, +24mo, recert +36mo.
  const stage2 = new Date(stage1.getTime());
  const stage1Date = new Date(stage1.getTime() - 30 * 86400000);
  const surv1 = new Date(stage1.getTime() + 365 * 86400000);
  const surv2 = new Date(stage1.getTime() + 365 * 2 * 86400000);
  const recert = new Date(stage1.getTime() + 365 * 3 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const ins = db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, planned_date, status) VALUES (?, ?, ?, 'planned')`);
  const tx = db.transaction(() => {
    ins.run(req.workspace.id, 'Stage 1 audit', iso(stage1Date));
    ins.run(req.workspace.id, 'Stage 2 audit', iso(stage2));
    ins.run(req.workspace.id, 'Surveillance audit (year 1)', iso(surv1));
    ins.run(req.workspace.id, 'Surveillance audit (year 2)', iso(surv2));
    ins.run(req.workspace.id, 'Recertification audit', iso(recert));
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'seed_iso42001_cert_cycle', 'iso42001_cert_event', null, null);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
});

app.post('/workspaces/:wsId/iso42001/cert-cycle/add', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { event_type, planned_date, notes } = req.body;
  if (!event_type) return res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
  db.prepare(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, planned_date, notes) VALUES (?, ?, ?, ?)`)
    .run(req.workspace.id, event_type, planned_date || null, notes || null);
  logAction(req.user.id, req.workspace.id, 'add_iso42001_cert_event', 'iso42001_cert_event', null, { event_type });
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
});

app.post('/workspaces/:wsId/iso42001/cert-cycle/:id/update', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const { planned_date, actual_date, status, notes } = req.body;
  db.prepare(`UPDATE iso42001_cert_cycle_events
              SET planned_date=COALESCE(?,planned_date), actual_date=COALESCE(?,actual_date),
                  status=COALESCE(?,status), notes=COALESCE(?,notes)
              WHERE id=? AND workspace_id=?`)
    .run(planned_date || null, actual_date || null, status || null, notes || null, req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
});

app.post('/workspaces/:wsId/iso42001/cert-cycle/:id/delete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  db.prepare(`DELETE FROM iso42001_cert_cycle_events WHERE id=? AND workspace_id=?`).run(req.params.id, req.workspace.id);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/cert-cycle`);
});

// --- Intake ---
app.get('/workspaces/:wsId/iso42001/intake', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT question_key, answer FROM iso42001_intake_answers WHERE workspace_id=?`).all(req.workspace.id);
  const answers = {};
  rows.forEach(r => { answers[r.question_key] = r.answer; });
  const total = ISO42001_INTAKE_QUESTIONS.length;
  const answered = ISO42001_INTAKE_QUESTIONS.filter(q => (answers[q.key] || '').trim()).length;
  const draftScope = buildIso42001DraftScope(answers);
  res.render('iso42001_intake', { user: req.user, ws: req.workspace,
    sections: ISO42001_INTAKE_SECTIONS, answers, total, answered, draftScope });
});

app.post('/workspaces/:wsId/iso42001/intake', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const upsert = db.prepare(`INSERT INTO iso42001_intake_answers (workspace_id, question_key, answer, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id, question_key) DO UPDATE SET answer=excluded.answer, updated_at=CURRENT_TIMESTAMP`);
  const tx = db.transaction(() => {
    for (const q of ISO42001_INTAKE_QUESTIONS) {
      const v = req.body[q.key];
      if (v != null) upsert.run(req.workspace.id, q.key, v);
    }
  });
  tx();
  logAction(req.user.id, req.workspace.id, 'save_iso42001_intake', 'iso42001_intake', null, null);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/intake`);
});

// Apply intake to workspace - push draft scope into clause 4.3 notes and update target_cert_date.
app.post('/workspaces/:wsId/iso42001/intake/apply', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const wsId = req.workspace.id;
  const rows = db.prepare(`SELECT question_key, answer FROM iso42001_intake_answers WHERE workspace_id=?`).all(wsId);
  const answers = {};
  rows.forEach(r => { answers[r.question_key] = r.answer; });
  const draftScope = buildIso42001DraftScope(answers);

  // Seed clause 4.3 (AIMS scope) - update notes and bump status to Partially Implemented if Not Assessed.
  getOrCreate42State(wsId, 'ai-clause-4.3');
  db.prepare(`UPDATE iso42001_control_states
    SET notes = CASE WHEN COALESCE(notes,'') = '' THEN ? ELSE notes END,
        status = CASE WHEN COALESCE(status,'Not Assessed')='Not Assessed' THEN 'Partially Implemented' ELSE status END,
        last_updated = CURRENT_TIMESTAMP
    WHERE workspace_id=? AND iso_item_id='ai-clause-4.3'`).run(draftScope, wsId);

  // Seed clause 4.2 (interested parties) notes if blank
  if ((answers['interested-parties'] || '').trim()) {
    getOrCreate42State(wsId, 'ai-clause-4.2');
    db.prepare(`UPDATE iso42001_control_states
      SET notes = CASE WHEN COALESCE(notes,'') = '' THEN ? ELSE notes END,
          status = CASE WHEN COALESCE(status,'Not Assessed')='Not Assessed' THEN 'Partially Implemented' ELSE status END,
          last_updated = CURRENT_TIMESTAMP
      WHERE workspace_id=? AND iso_item_id='ai-clause-4.2'`).run(answers['interested-parties'], wsId);
  }

  // Seed clause 4.1 (context) notes if blank
  const contextNote = [
    answers['org-context'] && `Context: ${answers['org-context']}`,
    answers['role'] && `Role: ${answers['role']}`,
    answers['regulatory'] && `Regulatory: ${answers['regulatory']}`,
  ].filter(Boolean).join('\n');
  if (contextNote) {
    getOrCreate42State(wsId, 'ai-clause-4.1');
    db.prepare(`UPDATE iso42001_control_states
      SET notes = CASE WHEN COALESCE(notes,'') = '' THEN ? ELSE notes END,
          status = CASE WHEN COALESCE(status,'Not Assessed')='Not Assessed' THEN 'Partially Implemented' ELSE status END,
          last_updated = CURRENT_TIMESTAMP
      WHERE workspace_id=? AND iso_item_id='ai-clause-4.1'`).run(contextNote, wsId);
  }

  // Target cert date - push to workspaces.target_cert_date if not already set
  if (answers['target-cert-date']) {
    db.prepare(`UPDATE workspaces SET target_cert_date = COALESCE(target_cert_date, ?) WHERE id=?`)
      .run(answers['target-cert-date'], wsId);
  }

  logAction(req.user.id, wsId, 'apply_iso42001_intake', 'iso42001_intake', null, { questionsAnswered: Object.keys(answers).length });
  res.redirect(`/workspaces/${wsId}/iso42001/gap/ai-clause-4.3`);
});

// --- Engagement plan ---
app.get('/workspaces/:wsId/iso42001/engagement-plan', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(`SELECT p.phase_key, p.completed_at, p.notes, (SELECT name FROM users WHERE id = p.completed_by) AS completed_by_name
    FROM iso42001_engagement_plan_progress p WHERE workspace_id=?`).all(req.workspace.id);
  const progress = {};
  rows.forEach(r => { progress[r.phase_key] = r; });
  res.render('iso42001_engagement_plan', { user: req.user, ws: req.workspace, phases: ISO42001_PLAN_PHASES, progress });
});

app.post('/workspaces/:wsId/iso42001/engagement-plan/:phaseKey/toggle', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const phaseKey = req.params.phaseKey;
  if (!ISO42001_PLAN_PHASES.find(p => p.key === phaseKey)) return res.status(400).send('Bad phase');
  const existing = db.prepare(`SELECT completed_at FROM iso42001_engagement_plan_progress WHERE workspace_id=? AND phase_key=?`).get(req.workspace.id, phaseKey);
  if (existing && existing.completed_at) {
    db.prepare(`UPDATE iso42001_engagement_plan_progress SET completed_at=NULL, completed_by=NULL WHERE workspace_id=? AND phase_key=?`).run(req.workspace.id, phaseKey);
  } else {
    db.prepare(`INSERT INTO iso42001_engagement_plan_progress (workspace_id, phase_key, completed_at, completed_by)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(workspace_id, phase_key) DO UPDATE SET completed_at=CURRENT_TIMESTAMP, completed_by=excluded.completed_by`).run(req.workspace.id, phaseKey, req.user.id);
  }
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/engagement-plan`);
});

app.post('/workspaces/:wsId/iso42001/engagement-plan/:phaseKey/notes', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
  const phaseKey = req.params.phaseKey;
  if (!ISO42001_PLAN_PHASES.find(p => p.key === phaseKey)) return res.status(400).send('Bad phase');
  db.prepare(`INSERT INTO iso42001_engagement_plan_progress (workspace_id, phase_key, notes)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, phase_key) DO UPDATE SET notes=excluded.notes`).run(req.workspace.id, phaseKey, req.body.notes || null);
  res.redirect(`/workspaces/${req.workspace.id}/iso42001/engagement-plan`);
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
module.exports = { app, db, computeReadiness, computeIso42001Readiness };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nCompliance Sphere running at http://localhost:${PORT}`);
    console.log(`First time? Visit /register to create your firm account.\n`);
  });
}
