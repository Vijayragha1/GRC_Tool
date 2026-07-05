// Load .env before anything reads process.env. Ambient environment variables
// take precedence over the file, so deploys that inject real env still win.
try { process.loadEnvFile(); } catch (_) { /* no .env present */ }

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
const { paginate, pageHref } = require('./lib/paginate');
// Context-free HTTP helpers shared with routes/ modules (single home; the
// bodies used to live in this file).
const { escapeHtml, withToast, redirectBack, auditCtx, parseFormArray } = require('./lib/http-helpers');
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
const ctlWrites = require('./lib/control-writes');
const docLinks = require('./lib/doc-links');
const evWrites = require('./lib/evidence-writes');

init();

// ---------------------------------------------------------------------------
// Process-level safety net. Express 4 does not catch throws inside async route
// handlers; without this, one throwing request kills the process for every
// logged-in user (observed: an undecryptable document aborting the audit-pack
// zip took the whole server down). The offending request may hang and time out
// client-side; that is strictly better than a full crash. Individual handlers
// should still try/catch - this is the last line, not the pattern.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});

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
if (process.env.NODE_ENV === 'production') app.set('view cache', true);

// Security headers + gzip. The CSP allows 'unsafe-inline' for now because the
// views still carry inline <script> blocks and style= attributes; tightening
// to nonces means sweeping those first. HSTS only when actually behind TLS.
const helmet = require('helmet');
const compression = require('compression');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      // The views still use inline onclick/onchange handlers; helmet's default
      // script-src-attr 'none' would break every one of them.
      scriptSrcAttr: ["'unsafe-inline'"],
      ...(process.env.NODE_ENV === 'production' ? {} : { upgradeInsecureRequests: null }),
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production' ? undefined : false,
}));
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// Content-hash version for fingerprinted static assets. Views link them as
// /app.css?v=<%= assetVersion %>, so the 7-day static cache below can never
// serve a stale stylesheet or favicon after a change.
app.locals.assetVersion = (() => {
  const h = crypto.createHash('md5');
  for (const f of ['public/app.css', 'public/auditor.css', 'public/favicon.svg', 'public/fonts/inter.css']) {
    try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (_) {}
  }
  return h.digest('hex').slice(0, 8);
})();

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use('/vendor/tinymce', express.static(path.join(__dirname, 'node_modules/tinymce')));
// Quiet the favicon 404 - no icon yet, just respond with No Content.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Liveness probe for uptime monitors and orchestrators. Mounted before the
// session middleware so probes never create session rows; unauthenticated
// because it leaks nothing beyond liveness.
app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, version: app.locals.assetVersion, uptime: Math.round(process.uptime()) });
  } catch (_) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});

// Persistent session store. The default MemoryStore loses every session on
// every restart, which makes "Keep me signed in for 30 days" a lie - users
// get bounced back to /login the moment the container restarts (healthcheck,
// daily backup, deploy). SQLite-backed store reuses the existing db handle
// so sessions persist alongside the rest of the workspace data.
const SqliteStore = require('better-sqlite3-session-store')(session);
app.use(session({
  store: new SqliteStore({
    client: db,
    // The store's own sweeper is a fire-and-forget setInterval with no handle,
    // which held finished processes open (in-process test boots). The hourly
    // sweep lives in lib/jobs.js instead (sessionSweep), on an unref'd timer.
    expired: { clear: false, intervalMs: 0 }
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
  // Post control-state demolition (migration 019): control_states is gone. Ensure
  // the converged whole-org control_instances row, then return the legacy-shaped
  // row from v_control_states (the view exposes every column callers read;
  // assessment_answers is NULL, which is dead data).
  const reqId = ctlWrites.requirementId(db, 'iso27001', isoId);
  if (reqId) {
    db.prepare('INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)')
      .run(wsId, reqId);
  }
  return db.prepare('SELECT * FROM v_control_states WHERE workspace_id = ? AND iso_item_id = ?').get(wsId, isoId);
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
// Lives in routes/auth.js (slice 3): login/logout, forgot/reset, invite
// accept, /admin/users. Its hashToken/INVITE_TTL_MS are reused by the
// team-setup invite flow below.
const authRoutes = require('./routes/auth');
authRoutes.register(app, { db, requireAuth, logAction });

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

// Firm-level admin routes live in routes/admin.js (slice 4): activity feed,
// email settings + outbox, manual job trigger.
require('./routes/admin').register(app, { db, requireAuth, logAction, isFirmOwner, getActiveFirmId });

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
              FROM v_control_states WHERE workspace_id IN (${ph}) AND owner_id IS NOT NULL`).all(...wsIds).forEach(c => {
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
// Lives in routes/glossary.js - register(app, deps) pattern, second slice of
// the modularization after routes/tenants.js.
require('./routes/glossary').register(app, { db, requireAuth, listWorkspaces });


// ==================== WORKSPACE LIFECYCLE ====================
// Lives in routes/workspaces.js (slice 15): CRUD, members, team setup.
require('./routes/workspaces').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, isFirmUser, computeReadiness });

// ==================== CONTROLS + GAP ASSESSMENT ====================
// Lives in routes/controls.js (slice 7): controls list + detail, guided gap
// wizard, flag-for-review, assessment passes. controlsRoutes.notifyReviewers
// is shared with the ISO 42001 flag flow below.
const controlsRoutes = require('./routes/controls');
controlsRoutes.register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState });

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
// Lives in routes/evidence.js (slice 8): library, upload, linking, versions,
// preview/download, coverage matrix.
require('./routes/evidence').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath });

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
// Lives in routes/risks.js (slice 5): register + heatmap, risk libraries,
// AI-guided assessment wizard, CSV import.
require('./routes/risks').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, activeEntityFilter, getActiveMethodology, methodologyBand, seedFirmRiskLibraryIfEmpty, csvUpload });

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
  const Tg = ctlReads.tables(db, wsId);
  db.prepare(`SELECT COALESCE(cs.status,'Not Assessed') AS s, COUNT(*) AS c FROM iso_items i
    LEFT JOIN ${Tg.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control') GROUP BY s`).all(wsId).forEach(r => { dist[r.s] = r.c; });
  const total = Object.values(dist).reduce((a,b) => a+b, 0);

  const gaps = db.prepare(`SELECT i.id, i.type, i.title, cs.status, cs.maturity, cs.scope_pct, cs.notes
    FROM iso_items i INNER JOIN ${Tg.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type IN ('clause','control')
      AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
    ORDER BY i.sort_order`).all(wsId);

  const evidenceAsks = db.prepare(`SELECT i.id, i.title FROM iso_items i
    INNER JOIN ${Tg.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
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

  const buf = await require('./lib/workers').htmlToDocxPooled(html, null, { table: { row: { cantSplit: true } } });
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
      // Auto-mark control as included in SoA when a risk drives it.
      // Cutover 4 (W4): converged write normalizes 'included' -> token; the WHERE
      // filter compares the converged token. 014 mirrors back to legacy.
      getOrCreateState(req.workspace.id, iso_item_id);
      const wcRl = ctlWrites.converged(db, req.workspace.id);
      const ridRl = wcRl ? ctlWrites.requirementId(db, 'iso27001', iso_item_id) : null;
      if (wcRl && ridRl) {
        db.prepare(`UPDATE control_instances SET applicability=?
                    WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND applicability=?`)
          .run(ctlWrites.normApplic('included'), req.workspace.id, ridRl, ctlWrites.normApplic('undecided'));
      } else {
        db.prepare(`UPDATE control_states SET applicability = 'included'
                    WHERE workspace_id = ? AND iso_item_id = ? AND applicability = 'undecided'`)
          .run(req.workspace.id, iso_item_id);
      }
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

// ==================== SOA + CROSSWALKS ====================
// Lives in routes/soa.js (slice 6): SoA single/batch/bulk updates and the
// cross-framework mapping view.
require('./routes/soa').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction });

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
  const pgT = paginate(db, req, {
    count: q.replace(/SELECT t\.\*.*?FROM tasks t/s, 'SELECT COUNT(*) c FROM tasks t'),
    rows: q + ` ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at DESC`,
    params: [req.workspace.id], perPage: 100,
  });
  const tasks = pgT.rows;
  const wsUsers = db.prepare(`SELECT u.id, u.name FROM users u
    INNER JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = ?
    UNION SELECT id, name FROM users WHERE firm_id = ? AND user_type = 'firm' AND active = 1`)
    .all(req.workspace.id, req.workspace.firm_id);
  res.render('tasks', { user: req.user, ws: req.workspace, tasks, filter, wsUsers,
    pg: pgT, pagerHref: p => pageHref(req, p) });
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
// Lives in routes/documents.js (slice 12): list/detail, template library,
// versioning + approvals + e-signatures, magic-link approval portal.
require('./routes/documents').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath });

// Lives in routes/governance.js (slice 9): internal audits + findings,
// improvements, management reviews, nonconformities/CAPA.
require('./routes/governance').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction });

// ==================== BULK CONTROL UPDATE ====================
app.post('/workspaces/:wsId/bulk-controls', requireAuth, requireWorkspace, requirePermission('control.bulk_update'), (req, res) => {
  const { ids, status, applicability, owner_id } = req.body;
  const idList = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  // Cutover 4 (W5): converged-authoritative bulk-controls; convergeSets normalizes
  // status/applicability per row (014 mirrors each).
  const wcBulkCtl = ctlWrites.converged(db, req.workspace.id);
  let count = 0;
  for (const id of idList) {
    getOrCreateState(req.workspace.id, id);
    const sets = []; const vals = [];
    if (status) { sets.push('status=?'); vals.push(status); }
    if (applicability) { sets.push('applicability=?'); vals.push(applicability); }
    if (owner_id !== undefined && owner_id !== '') { sets.push('owner_id=?'); vals.push(owner_id); }
    if (sets.length) {
      sets.push('last_updated=CURRENT_TIMESTAMP');
      const rid = wcBulkCtl ? ctlWrites.requirementId(db, 'iso27001', id) : null;
      if (wcBulkCtl && rid) {
        const c = ctlWrites.convergeSets(sets, vals);
        db.prepare(`UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(...c.vals, req.workspace.id, rid);
      } else {
        vals.push(req.workspace.id, id);
        db.prepare(`UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
      }
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
  // Cutover 4 (W5): autosave is a W2-class write WITH optimistic-concurrency. On a
  // write-flipped workspace it writes the converged control_instances (convergeSets
  // normalizes status/applicability) and the CAS runs against
  // control_instances.last_updated; 014 mirrors to legacy. Fail-safe otherwise.
  const wcAuto = ctlWrites.converged(db, req.workspace.id);
  const ridAuto = wcAuto ? ctlWrites.requirementId(db, 'iso27001', req.params.isoId) : null;
  let result;
  const curStamp = (wcAuto && ridAuto)
    ? () => db.prepare(`SELECT last_updated FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(req.workspace.id, ridAuto)
    : () => db.prepare(`SELECT last_updated FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, req.params.isoId);
  if (wcAuto && ridAuto) {
    const c = ctlWrites.convergeSets(sets, vals);
    const cVals = c.vals.slice();
    let sql = `UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`;
    cVals.push(req.workspace.id, ridAuto);
    if (clientStamp) { sql += ` AND last_updated = ?`; cVals.push(clientStamp); }
    result = db.prepare(sql).run(...cVals);
  } else {
    vals.push(req.workspace.id, req.params.isoId);
    let sql = `UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`;
    if (clientStamp) { sql += ` AND last_updated = ?`; vals.push(clientStamp); }
    result = db.prepare(sql).run(...vals);
  }
  if (clientStamp && result.changes === 0) {
    const current = curStamp();
    return res.status(409).json({
      ok: false, conflict: true,
      message: 'Another consultant updated this control. Reload to see their changes.',
      current_last_updated: current ? current.last_updated : null
    });
  }
  const cur = curStamp();
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

// DOCX generation moved to lib/docx-gen.js and runs on a worker-thread pool
// (lib/workers.js): html-to-docx is pure CPU, and on the single-threaded main
// loop a pack build used to stall every other request.
const generateDocxBuffer = require('./lib/workers').generateDocx;

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
    try {
      // decrypt inside the try: a single undecryptable document (e.g. after a
      // key mishap) must skip that doc, not abort the pack or crash the process.
      const d = { ...dRaw, content: enc.decryptIfNeeded(dRaw.content, ws.id) };
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
    } catch (e) { console.error('docx gen failed', dRaw.id, e.message); }
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

// ==================== OPERATIONAL REGISTERS ====================
// Lives in routes/registers.js (slice 10): incidents, BCP/BIA, change
// management, vendors (TPRM) + questionnaires + external vendor links.
require('./routes/registers').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath, activeEntityFilter, qUploadAny });

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

// ==================== PERFORMANCE + PEOPLE ====================
// Lives in routes/performance.js (slice 11): ISMS metrics + 27004 library,
// policy adoption, evidence coverage matrix, training, competence, comms plan.
require('./routes/performance').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, upload });

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

// ==================== ENHANCED ACTIVITY LOG ====================
// Filter activity by user/action/entity_type/date range; show before/after diffs; export CSV.
// ==================== REVIEW QUEUE ====================
// Cross-framework list of assessment items flagged for senior review. Two
// tabs aren't worth it - one list with a framework column is faster to scan.
app.get('/workspaces/:wsId/review-queue', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
  const filter = req.query.filter || 'open'; // 'open' = requested + needs_changes; 'all' = everything non-none
  const wsId = req.workspace.id;
  // Review-convergence: review reads come from the converged compat views when
  // control_reads_converged (the views now expose the review_* columns).
  const T = ctlReads.tables(db, wsId);

  const iso27 = db.prepare(`SELECT cs.iso_item_id AS item_id, i.title, cs.review_status, cs.review_requested_at,
      cs.reviewed_at, cs.review_reason,
      ru.name AS requested_by_name, rv.name AS reviewed_by_name
    FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    LEFT JOIN users ru ON ru.id = cs.review_requested_by
    LEFT JOIN users rv ON rv.id = cs.reviewed_by
    WHERE cs.workspace_id=? AND cs.review_status != 'none'
    ORDER BY cs.review_requested_at DESC`).all(wsId).map(r => ({ ...r, framework: 'iso27001', link: `/workspaces/${wsId}/controls/assess/${r.item_id}` }));

  const iso42 = db.prepare(`SELECT cs.iso_item_id AS item_id, i.title, cs.review_status, cs.review_requested_at,
      cs.reviewed_at, cs.review_reason,
      ru.name AS requested_by_name, rv.name AS reviewed_by_name
    FROM ${T.cs42} cs
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
  // Paginated (was a silent LIMIT 500 that dropped older history).
  const pg = paginate(db, req, {
    count: `SELECT COUNT(*) c FROM audit_log a INNER JOIN users u ON u.id=a.user_id WHERE ${where.join(' AND ')}`,
    rows: `SELECT a.*, u.name AS user_name FROM audit_log a
      INNER JOIN users u ON u.id=a.user_id
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC`,
    params, perPage: 100,
  });
  const users = db.prepare(`SELECT DISTINCT u.id, u.name FROM audit_log a
    INNER JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY u.name`).all(req.workspace.id);
  const actions = db.prepare(`SELECT DISTINCT action FROM audit_log WHERE workspace_id=? ORDER BY action`).all(req.workspace.id).map(r => r.action);
  const types = db.prepare(`SELECT DISTINCT entity_type FROM audit_log WHERE workspace_id=? AND entity_type IS NOT NULL ORDER BY entity_type`).all(req.workspace.id).map(r => r.entity_type);
  res.render('activity_log', { user: req.user, ws: req.workspace, log: pg.rows, pg, pagerHref: p => pageHref(req, p), filters, users, actions, types });
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
  // Cutover 4 (W4): converged-authoritative auto-justify; 'included'/'excluded'
  // literals route through normApplic; 014 mirrors each row to legacy.
  const wcAj = ctlWrites.converged(db, req.workspace.id);
  let updated = 0;
  for (const c of linked) {
    getOrCreateState(req.workspace.id, c.id);
    const just = `Driven by risks: ${c.risks}`;
    const ridAj = wcAj ? ctlWrites.requirementId(db, 'iso27001', c.id) : null;
    if (wcAj && ridAj) {
      db.prepare(`UPDATE control_instances SET applicability=?, inclusion_justification=COALESCE(inclusion_justification, ?), last_updated=CURRENT_TIMESTAMP
        WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND applicability != ?`)
        .run(ctlWrites.normApplic('included'), just, req.workspace.id, ridAj, ctlWrites.normApplic('excluded'));
    } else {
      db.prepare(`UPDATE control_states SET applicability='included', inclusion_justification=COALESCE(inclusion_justification, ?), last_updated=CURRENT_TIMESTAMP
        WHERE workspace_id=? AND iso_item_id=? AND applicability != 'excluded'`)
        .run(just, req.workspace.id, c.id);
    }
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
// Lives in routes/csf.js (slice 14): engagements, assessments + scoring,
// versions/diffs, findings, portal, learn docs, catalog.
require('./routes/csf').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, upload });

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
    th{background:#F4F4F5;color:#0F0F12;font-weight:500;}
    .tag{display:inline-block;padding:1pt 5pt;border-radius:3pt;font-size:8.5pt;font-weight:500;}
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
          <p style="margin:0 0 6pt 0;font-size:10pt;font-weight:500;color:#FFFFFF;letter-spacing:0.10em;">${escHtml(title.toUpperCase())}</p>
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
  return await require('./lib/workers').htmlToDocxPooled(
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
      (SELECT COUNT(*) FROM ${docLinks.docControlsExpr('iso27001')} dc INNER JOIN generated_docs d ON d.id=dc.document_id WHERE dc.iso_item_id=i.id AND d.workspace_id=?) AS doc_count
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
  // Cutover 4 (W5): converged-authoritative CSV import; convergeSets normalizes
  // status/applicability per row (014 mirrors each). Unmapped CSV values pass
  // through and surface fail-loud in reads, matching the doctrine.
  const wcImp = ctlWrites.converged(db, req.workspace.id);
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
      const rid = wcImp ? ctlWrites.requirementId(db, 'iso27001', id) : null;
      if (wcImp && rid) {
        const c = ctlWrites.convergeSets(set, vals);
        db.prepare(`UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(...c.vals, req.workspace.id, rid);
      } else {
        vals.push(req.workspace.id, id);
        db.prepare(`UPDATE control_states SET ${set.join(',')} WHERE workspace_id=? AND iso_item_id=?`).run(...vals);
      }
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
    // control state converged to control_instances (control_states/entity_control_states
    // demolished, 019/020); history is the pass-snapshot tables (cutover 5 decision).
    'control_instances','control_state_history','iso42001_control_state_history','soa_snapshots',
    'generated_docs','doc_versions','doc_approvers','doc_signatures',
    'evidence','comments','comment_mentions',
    'audits','audit_findings','audit_observations','audit_programmes',
    'mrms','nonconformities','incidents','incident_events',
    'suppliers','supplier_documents','supplier_subprocessors','supplier_reviews','supplier_notes','supplier_clauses','supplier_controls','supplier_questionnaires','supplier_questionnaire_responses','supplier_monitoring','supplier_termination_items',
    'document_requirement_links',
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
      ${docLinks.docCountSubquery('iso27001')} AS doc_count,
      ${evReads.checklistEvidenceCountSubquery()} AS evi_count
    FROM iso_items i
    INNER JOIN v_control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
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
  const lastDrill = require('./lib/restore-check').lastDrill();
  res.render('system', { user: req.user, ws: req.workspace, backups, rotations, masterFp, lastDrill });
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
// Lives in routes/iso42001.js (slice 13): catalog, intake, gap assessment,
// SoA + snapshots, roadmap, readiness, engagement plan, exec brief.
const iso42001Routes = require('./routes/iso42001');
iso42001Routes.register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, computeReadiness, notifyReviewers: controlsRoutes.notifyReviewers });

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
module.exports = { app, db, computeReadiness, getOrCreateState,
  // bound at register time in routes/iso42001.js
  get computeIso42001Readiness() { return iso42001Routes.shared.computeIso42001Readiness; },
  get getOrCreate42State() { return iso42001Routes.shared.getOrCreate42State; } };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nCompliance Sphere running at http://localhost:${PORT}`);
    console.log(`First time? Visit /register to create your firm account.\n`);
  });
}
