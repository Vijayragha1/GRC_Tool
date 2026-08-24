// HARD-001: make every file or directory created by this process private by
// default. This must run before loading configuration, opening SQLite, creating
// the encryption key, staging uploads, or writing backups.
process.umask(0o077);

// Load .env before anything reads process.env. Ambient environment variables
// take precedence over the file, so deploys that inject real env still win.
try { process.loadEnvFile(); } catch (_) { /* no .env present */ }

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

const { workspaceTimeZone } = require('./lib/dates');
const uploadSecurity = require('./lib/upload-security');
const { db, init, logAction, verifyAuditChain, defaultMethodology, ensureWorkspaceMethodology, getActiveMethodology, methodologyBand } = require('./db');
const enc = require('./lib/encryption');
const rbac = require('./lib/rbac');
const { paginate, pageHref } = require('./lib/paginate');
// Context-free HTTP helpers shared with routes/ modules (single home; the
// bodies used to live in this file).
const { escapeHtml, withToast, redirectBack, auditCtx, parseFormArray } = require('./lib/http-helpers');
const { computeReadiness, computeRoadmap } = require('./lib/readiness');
const { buildWorkspaceStatus } = require('./lib/grc-truth');
const { computeNextStep, computeNeedsAttention } = require('./lib/next-steps');
const { seedFirmRiskLibraryIfEmpty } = require('./lib/firm-library');
// DOCX generation binding (worker pool); the exports slice has its own copy,
// the report builder + gap report below still use this one.
const generateDocxBuffer = require('./lib/workers').generateDocx;
const jobs = require('./lib/jobs');
const fts = require('./lib/fts');
const reports = require('./lib/reports');
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
const tprmMonitoringRoutes = require('./routes/tprm-monitoring');
const { resolveRuntimeSecret } = require('./lib/runtime-secret-resolver');

// Remediate permissions on artifacts created by releases that pre-date the
// restrictive umask. New files are already private; this one-time-compatible
// pass also covers the configured database, WAL/SHM files, key, uploads and
// encrypted backups without logging their names or contents.
(function hardenRuntimePermissions() {
  const dataDir = path.join(__dirname, 'data');
  const backupDir = path.resolve(process.env.ISMS_BACKUP_DIR || path.join(dataDir, 'backups'));
  const uploadsDir = path.join(__dirname, 'uploads');
  const localSnapshotDir = path.join(__dirname, '.demo-backup');
  const configuredDb = path.resolve(process.env.DB_PATH || path.join(__dirname, 'iso27001.db'));
  const keyFile = path.resolve(process.env.ISMS_KEY_FILE || path.join(dataDir, 'master.key'));
  const directories = [dataDir, backupDir, uploadsDir, localSnapshotDir];
  const files = [path.join(__dirname, '.env'), configuredDb, `${configuredDb}-wal`, `${configuredDb}-shm`, keyFile];
  try {
    for (const dir of directories) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
    if (fs.existsSync(dataDir)) {
      for (const name of fs.readdirSync(dataDir)) {
        if (/\.(?:db|sqlite)(?:-(?:wal|shm))?$/i.test(name)) files.push(path.join(dataDir, name));
      }
    }
    for (const dir of [__dirname, localSnapshotDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (/\.(?:db|sqlite)(?:-(?:wal|shm))?$/i.test(name)) files.push(path.join(dir, name));
      }
    }
    if (fs.existsSync(backupDir)) {
      for (const name of fs.readdirSync(backupDir)) {
        if (/\.(?:enc|json)$/.test(name) || name === '.backup.lock') files.push(path.join(backupDir, name));
      }
    }
    for (const file of new Set(files)) if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  } catch (error) {
    console.warn('WARNING: could not enforce private runtime file permissions:', error.message);
  }
})();

init();

// ---------------------------------------------------------------------------
// Process-level safety net. Express 4 does not catch throws inside async route
// handlers; without this, one throwing request kills the process for every
// logged-in user (observed: an undecryptable document aborting the audit-pack
// zip took the whole server down). The offending request may hang and time out
// client-side; that is strictly better than a full crash. Individual handlers
// should still try/catch - this is the last line, not the pattern.
// ---------------------------------------------------------------------------
const UNHANDLED_REJECTION_HANDLER = Symbol.for('complianceSphere.unhandledRejectionHandler');
if (process[UNHANDLED_REJECTION_HANDLER]) {
  process.off('unhandledRejection', process[UNHANDLED_REJECTION_HANDLER]);
}
process[UNHANDLED_REJECTION_HANDLER] = (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
};
process.on('unhandledRejection', process[UNHANDLED_REJECTION_HANDLER]);

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
// Production backups are scheduled once by the host cron installed by
// deploy/lightsail-setup.sh. Manual backups remain available in System.

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Product typography deliberately avoids em dashes. Normalise the final EJS
// output as well as authored copy so older database records follow the same
// presentation rule without rewriting the underlying evidence or audit data.
const { normalizeDisplayPunctuation } = require('./lib/typography');
const renderEjs = app.render.bind(app);
app.render = function renderWithoutEmDashes(view, options, callback) {
  return renderEjs(view, options, (err, html) => {
    callback(err, err ? html : normalizeDisplayPunctuation(html));
  });
};

if (process.env.NODE_ENV === 'production') {
  app.set('view cache', true);
  // Express must trust the terminating reverse proxy before secure cookies
  // can be issued reliably behind nginx / a load balancer.
  app.set('trust proxy', 1);
}

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

// Public continuous-monitoring ingress owns a strict 1 MiB raw parser and is
// registered before the application's larger general JSON parser. It is HMAC
// authenticated, creates no browser session and exposes no tenant information.
tprmMonitoringRoutes.registerPublic(app, { db, secretResolver: resolveRuntimeSecret });

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// Content-hash version for fingerprinted static assets. Views link them as
// /app.css?v=<%= assetVersion %>, so the 7-day static cache below can never
// serve a stale stylesheet or favicon after a change.
app.locals.assetVersion = (() => {
  const h = crypto.createHash('md5');
  for (const f of ['public/app.css', 'public/tprm.css', 'public/dpdpa.css', 'public/auditor.css', 'public/public.css', 'public/page-loader.css', 'public/page-loader.js', 'public/site-enhancements.js', 'public/favicon.svg', 'public/fonts/inter.css']) {
    try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (_) {}
  }
  return h.digest('hex').slice(0, 8);
})();

// Fingerprinted assets may be cached aggressively in production. During local
// development the process can stay alive while CSS changes, so force browser
// revalidation; otherwise the unchanged boot-time query string can leave the
// UI on a stale stylesheet until the development watcher (or a production
// restart) recomputes the asset fingerprint.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag: true,
  setHeaders(res) {
    if (process.env.NODE_ENV !== 'production') res.setHeader('Cache-Control', 'no-cache');
  }
}));
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

// Deployment-readiness probe. Unlike /healthz this answers whether the
// instance is safe to receive client traffic, without returning secret values.
app.get('/readyz', (_req, res) => {
  const production = process.env.NODE_ENV === 'production';
  const checks = {
    database: true,
    session_secret: !!process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32,
    master_key: !!process.env.ISMS_MASTER_KEY || fs.existsSync(process.env.ISMS_KEY_FILE || path.join(__dirname, 'data', 'master.key')),
    public_https_url: !production || /^https:\/\//i.test(process.env.APP_BASE_URL || ''),
    transactional_email: !production || !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)),
    malware_scanning: !production || ((process.env.UPLOAD_AV_MODE || 'required') === 'required' && require('./lib/upload-security').scannerAvailable())
  };
  try { db.prepare('SELECT 1').get(); } catch (_) { checks.database = false; }
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({ ok, checks });
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
  name: 'compliance_sphere.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
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
const { csrfMiddleware, csrfAfterMultipart } = require('./lib/csrf');
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
const GENERAL_UPLOAD_EXTENSIONS = new Set([
  'pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','md','markdown','rtf',
  'odt','ods','png','jpg','jpeg','gif','webp','zip','json','xml'
]);
const rawUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, _file, cb) {
      const firmId = (req.workspace && req.workspace.firm_id) || (req.user && req.user.firm_id) || 0;
      const dir = path.join(__dirname, 'uploads', `firm_${firmId}`);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
      } catch (_) {}
      cb(null, dir);
    },
    filename: function (_req, file, cb) {
      const rand = require('crypto').randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${rand}-${file.originalname.replace(/[^\w.\-]/g, '_')}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function removeStagedFiles(files) {
  (files || []).forEach(file => {
    try { if (file && file.path) fs.unlinkSync(file.path); } catch (_) {}
  });
}

function stagedFiles(req) {
  if (!req) return [];
  const many = Array.isArray(req.files)
    ? req.files
    : (req.files && typeof req.files === 'object' ? Object.values(req.files).flat() : []);
  return [req.file, ...many].filter(Boolean);
}

function inspectedUpload(middleware, allowedExtensions = GENERAL_UPLOAD_EXTENSIONS) {
  return function inspectMultipart(req, res, next) {
    middleware(req, res, err => {
      if (err) return next(err);
      const files = stagedFiles(req);
      for (const file of files) {
        const result = uploadSecurity.validateUpload(file, allowedExtensions);
        if (!result.ok) {
          removeStagedFiles(files);
          req.file = undefined;
          req.files = Array.isArray(req.files) ? [] : {};
          return res.status(400).render('error', {
            user: req.user || null, ws: req.workspace || null,
            message: result.message || 'The uploaded file did not pass security inspection.'
          });
        }
      }
      if (process.env.DISABLE_CSRF === '1') return next();
      csrfAfterMultipart(req, res, next, () => removeStagedFiles(files));
    });
  };
}

// A single inspected facade is injected into every route module. Any new
// persistent upload route receives signature validation and malware scanning
// without relying on the route author to remember a second middleware.
const upload = {
  single: field => inspectedUpload(rawUpload.single(field)),
  array: (field, maxCount) => inspectedUpload(rawUpload.array(field, maxCount)),
  fields: fields => inspectedUpload(rawUpload.fields(fields)),
  any: () => inspectedUpload(rawUpload.any())
};

// CSV import uploader: memory-only, ~5MB cap, single file. Used by the
// asset/risk CSV import preview routes. Parsed in-process; never persisted.
const rawCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});
const CSV_UPLOAD_EXTENSIONS = new Set(['csv']);
const csvUpload = {
  single: field => inspectedUpload(rawCsvUpload.single(field),CSV_UPLOAD_EXTENSIONS)
};

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
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
      } catch (_) {}
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
    if (!err && Array.isArray(req.files)) {
      for (const file of req.files) {
        const result = uploadSecurity.validateUpload(file, QFILE_ALLOWED_EXT);
        if (!result.ok) {
          removeStagedFiles(req.files);
          req.files = [];
          req._uploadError = { code: 'UPLOAD_INSPECTION', message: result.message };
          break;
        }
      }
    }
    if (process.env.DISABLE_CSRF === '1') return next();
    csrfAfterMultipart(req, res, next, () => removeStagedFiles(stagedFiles(req)));
  });
}

// Resolve the firm (for upload partitioning) from a questionnaire's external
// token BEFORE multer parses the body - multer's destination() needs
// req.workspace.firm_id, and req.params.token is available pre-parse. Also
// short-circuits invalid / completed / expired links with the same status
// pages the GET route renders, so multer never runs for a dead link. On
// success it stashes the (open) questionnaire on req._questionnaire.
function resolveQuestionnaireFirm(req, res, next) {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const q = db.prepare(`SELECT q.*, s.name AS supplier_name, t.description AS tpl_description,
      w.firm_id AS ws_firm_id, COALESCE(w.brand_display_name, w.client_name) AS requester_name,
      et.id AS invitation_id, et.expires_at AS token_expires_at, et.completed_at AS token_completed_at
    FROM supplier_questionnaires q
    INNER JOIN suppliers s ON s.id=q.supplier_id
    LEFT JOIN questionnaire_templates t ON t.id=q.template_id
    LEFT JOIN workspaces w ON w.id=q.workspace_id
    INNER JOIN external_assessment_tokens et ON et.questionnaire_id=q.id
    WHERE et.token_hash=? AND et.revoked_at IS NULL`).get(tokenHash);
  const blank = { sections: {}, respMap: {}, token: req.params.token };
  if (!q) return res.status(404).render('external_questionnaire', { q: null, state: 'invalid', ...blank });
  if (q.external_completed_at || q.token_completed_at) return res.render('external_questionnaire', { q, state: 'done', ...blank });
  if (q.token_expires_at && new Date(q.token_expires_at) < new Date())
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
      const inspection = uploadSecurity.validateUpload(f, QFILE_ALLOWED_EXT);
      if (!inspection.ok) {
        try { fs.unlinkSync(f.path); } catch (_) {}
        continue;
      }
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
  // Firm users always operate within their own firm - session value is ignored.
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
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!u || !u.active) {
      // Do not leave a stale userId in the session. Apart from being misleading,
      // /login would otherwise see it and redirect straight back to /dashboard.
      delete req.session.userId;
      delete req.session.authEpoch;
      return null;
    }
    // SESS-001: a session is only valid while it carries the user's current
    // authorization epoch. Password reset and deactivation bump the epoch, so
    // sessions minted before that moment stop resolving here even though their
    // cookie is still well-formed and their session row still exists.
    const epoch = Number(u.auth_epoch || 0);
    const claimed = Number(req.session.authEpoch || 0);
    if (claimed !== epoch) {
      delete req.session.userId;
      delete req.session.authEpoch;
      return null;
    }
    return u;
  }
  return null;
}

// SESS-001: bump the epoch and drop persisted session rows for one user.
// Callers must run this inside their own transaction where atomicity matters.
function revokeUserSessions(userId) {
  db.prepare('UPDATE users SET auth_epoch = COALESCE(auth_epoch,0) + 1 WHERE id = ?').run(userId);
  // better-sqlite3-session-store keeps JSON in `sess`. Use JSON extraction so
  // revoking user 1 cannot accidentally delete sessions for users 10 or 100.
  try {
    db.prepare(`DELETE FROM sessions
      WHERE CAST(json_extract(sess, '$.userId') AS INTEGER) = ?`).run(Number(userId));
  } catch (_) {
    // The store may not be initialised yet, or SQLite may have been built
    // without JSON1. Fall back to exact application-side JSON parsing.
    try {
      const rows = db.prepare('SELECT sid, sess FROM sessions').all();
      const del = db.prepare('DELETE FROM sessions WHERE sid = ?');
      for (const row of rows) {
        try {
          if (Number(JSON.parse(row.sess).userId) === Number(userId)) del.run(row.sid);
        } catch (_) { /* ignore malformed/foreign session rows */ }
      }
    } catch (_) { /* store may not be initialised yet */ }
  }
  return db.prepare('SELECT auth_epoch FROM users WHERE id = ?').get(userId)?.auth_epoch ?? 0;
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
  // removed when real login was enabled - currentUser() now returns a user
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
  const ws = db.prepare(`SELECT w.*,f.timezone AS firm_timezone
    FROM workspaces w JOIN firms f ON f.id=w.firm_id WHERE w.id=?`).get(workspaceId);
  if (!ws) return null;
  if (user.user_type === 'firm' && user.firm_id === ws.firm_id) {
    const fr = rbac.normalizeRole(user.firm_role) || 'consultant';
    // Managers own the tenant and senior consultants explicitly receive the
    // cross-engagement permission. Everyone else must be assigned to the
    // workspace. Keeping the membership check here (rather than only hiding
    // links in the UI) closes direct-URL access to other clients.
    if (rbac.isManager(fr) || rbac.rolePermissions(fr).includes('firm.cross_view')) {
      return { ...ws, role: 'consultant', _userRole: fr };
    }
    const member = db.prepare(`SELECT role FROM workspace_members
      WHERE workspace_id=? AND user_id=?`).get(ws.id, user.id);
    if (!member) return null;
    const memberRole = rbac.normalizeRole(member.role);
    const effectiveRole = rbac.FIRM_ROLES.includes(memberRole) ? memberRole : fr;
    return { ...ws, role: 'consultant', _userRole: effectiveRole };
  }
  const m = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, user.id);
  if (!m) return null;
  return { ...ws, role: m.role, _userRole: m.role };
}

// Framework whitelist + parser live in lib/frameworks.js (shared with the
// workspaces and evidence modules).
const { ALLOWED_FRAMEWORKS, FRAMEWORK_LIST, parseWorkspaceFrameworks } = require('./lib/frameworks');

function requireWorkspace(req, res, next) {
  const ws = getWorkspace(req.params.wsId, req.user);
  if (!ws) return res.status(403).render('error', { user: req.user, message: 'This workspace doesn\'t exist, or it belongs to a different firm. If you recently switched tenants, the old workspace URL won\'t resolve. Use the Clients dashboard to pick a workspace in the active firm.' });
  ws.frameworks = parseWorkspaceFrameworks(ws.frameworks);
  ws.effective_timezone = workspaceTimeZone(ws);
  // Operational modules are independent of assessment frameworks. Attach the
  // authoritative TPRM service period once so navigation and every workspace
  // view use the same enablement truth. Historic rows awaiting classification
  // stay visible, but route-level mutation guards keep them read-only.
  try {
    ws.tprm_module = db.prepare(`SELECT * FROM tprm_modules
      WHERE workspace_id=? ORDER BY id DESC LIMIT 1`).get(ws.id) || null;
  } catch (_) {
    ws.tprm_module = null;
  }
  ws.tprm_enabled = ws.tprm_module ? 1 : 0;
  ws.tprm_active = ws.tprm_module && ws.tprm_module.status === 'active' ? 1 : 0;
  ws.tprm_closed = ws.tprm_module && ws.tprm_module.status === 'closed' ? 1 : 0;
  try {
    ws.vciso_service = db.prepare(`SELECT * FROM vciso_services
      WHERE workspace_id=? AND status IN ('active','on_hold') ORDER BY id DESC LIMIT 1`).get(ws.id) || null;
  } catch (_) {
    ws.vciso_service = null;
  }
  ws.vciso_enabled = ws.vciso_service ? 1 : 0;
  req.workspace = ws;
  // Every client-side account is confined to the collaboration boundary.
  // Client owners/coordinators see all client-visible work; contributors see
  // only assigned rows. None can enter the firm's delivery cockpit or legacy
  // workspace modules. The single decision endpoint below is a narrow bridge
  // for a named policy approver and performs its own pending-approver checks.
  const isScopedClient = req.user.user_type === 'client';
  const portalPrefix = `/workspaces/${ws.id}/client-portal`;
  const policyDecisionPath = new RegExp(`^/workspaces/${ws.id}/documents/\\d+/decide$`);
  const csfClientPortalPath = new RegExp(`^/workspaces/${ws.id}/csf/\\d+/portal(?:/.*)?$`);
  const csfPublishedReportPath = new RegExp(`^/workspaces/${ws.id}/csf/\\d+/exports/report\\.(?:pdf|docx)$`);
  if (isScopedClient && req.method === 'GET' && req.path === `/workspaces/${ws.id}`) {
    return res.redirect(portalPrefix);
  }
  const allowedClientPath = req.path === portalPrefix || req.path.startsWith(portalPrefix + '/') ||
    (req.method === 'POST' && policyDecisionPath.test(req.path)) || csfClientPortalPath.test(req.path) ||
    (req.method === 'GET' && csfPublishedReportPath.test(req.path));
  if (isScopedClient && !allowedClientPath) {
    logAction(req.user.id, ws.id, 'scoped_route_denied', 'route', req.path,
      { method: req.method, reason: 'contributor_portal_boundary' }, auditCtx(req));
    return res.status(403).render('error', {
      user: req.user,
      ws,
      message: 'Your account is limited to the client portal. Open your engagement to view requests, approvals, reports, policies and evidence shared with you.'
    });
  }
  // Remember the workspace they were last in, so firm-level pages (Glossary,
  // Playbooks, Firm library, Tenants) can offer a "← Back to {client}"
  // breadcrumb instead of dumping them into a different sidebar with no
  // way home.
  if (req.session) req.session.last_ws_id = ws.id;
  // Multi-entity scoping was removed - keep the locals as empty stubs so views that
  // still reference them degrade gracefully without re-rendering work.
  res.locals.entitySelectorWs = ws;
  res.locals.tprmModule = ws.tprm_module;
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
    const d = db.prepare(`SELECT COUNT(*) c FROM dpdpa_gap_assessments
      WHERE workspace_id=? AND status='Under Review'`).get(ws.id).c;
    res.locals.openReviewCount = a + b + d;
  } catch (_) { res.locals.openReviewCount = 0; }
  next();
}

function isFirmUser(user) { return user.user_type === 'firm'; }
// "Firm owner" was renamed to "Manager" in the role-naming pass. rbac.isManager
// normalises old aliases ('owner' → 'manager') so unmigrated rows still resolve.
function isFirmOwner(user) { return user.user_type === 'firm' && rbac.isManager(user.firm_role); }

function listWorkspaces(user) {
  if (user.user_type === 'firm') {
    const role = rbac.normalizeRole(user.firm_role) || 'consultant';
    if (!rbac.isManager(role) && !rbac.rolePermissions(role).includes('firm.cross_view')) {
      return db.prepare(`SELECT w.*,m.role AS my_role,
          EXISTS(SELECT 1 FROM vciso_services v WHERE v.workspace_id=w.id AND v.status IN ('active','on_hold')) AS vciso_enabled,
          (SELECT name FROM users WHERE id = w.lead_consultant_id) AS lead_name
          FROM workspaces w
          INNER JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=?
          WHERE w.firm_id=? ORDER BY w.created_at DESC`).all(user.id,user.firm_id);
    }
    return db.prepare(`SELECT w.*,
        EXISTS(SELECT 1 FROM vciso_services v WHERE v.workspace_id=w.id AND v.status IN ('active','on_hold')) AS vciso_enabled,
        (SELECT name FROM users WHERE id = w.lead_consultant_id) AS lead_name
        FROM workspaces w WHERE w.firm_id = ? ORDER BY w.created_at DESC`).all(user.firm_id);
  }
  return db.prepare(`SELECT w.*,
      EXISTS(SELECT 1 FROM vciso_services v WHERE v.workspace_id=w.id AND v.status IN ('active','on_hold')) AS vciso_enabled,
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
//   stage_1_ready     - every Stage 1 hard gate passes
//   internal_audit    - >= 1 internal audit completed
//   implementing      - controls being assessed (>= 20 non-NotAssessed)
//   documenting       - >= 8 documents in approved/published status
//   scoping           - at least one intake answer recorded
//   new               - no setup yet
function computeClientStage(ws) {
  try {
    return buildWorkspaceStatus(db, ws).lifecycle;
  } catch (_) {
    return { key: 'new', label: 'New engagement' };
  }
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
// via currentColor. Safe to emit with <%- %> - no user input.
app.locals.tierIcon = (tier, size = 12) => {
  const open = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-0.125em;flex-shrink:0;">`;
  if (tier === 'mandatory') return open + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  if (tier === 'expected') return open + '<polygon points="12 2 22 12 12 22 2 12"/></svg>';
  return open + '<circle cx="12" cy="12" r="4"/></svg>';
};
app.locals.rbac = rbac;
// Programme pickers render from the registry so adding a framework never means
// hand-editing a checkbox list in a view.
app.locals.frameworkList = FRAMEWORK_LIST;

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
        // The client switcher is a navigation surface, not an authorization
        // bypass. It must use the same scoped workspace list as /dashboard.
        res.locals.firmWorkspaces = listWorkspaces(u);
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
authRoutes.register(app, { db, requireAuth, logAction, revokeUserSessions });

// ==================== TENANTS + ONBOARDING ====================
// Extracted to routes/tenants.js - first slice of server.js modularization.
// The pattern: each domain module exports register(app, deps), receives all
// dependencies explicitly, knows nothing about other domains.
require('./routes/tenants').register(app, {
  db, bcrypt,
  requireAuth,
  isFirmUser,
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

// ==================== FIRM HOME ====================
// Lives in routes/dashboard.js: dashboard, portfolio health, firm team.
require('./routes/dashboard').register(app, { db, requireAuth, logAction, isFirmUser, isFirmOwner,
  getActiveFirmId, listWorkspaces, workspaceProgress, computeClientStage });

// Firm-level admin routes live in routes/admin.js (slice 4): activity feed,
// email settings + outbox, manual job trigger.
require('./routes/admin').register(app, { db, requireAuth, logAction, isFirmOwner, getActiveFirmId });

// ==================== GLOSSARY ====================
// Lives in routes/glossary.js - register(app, deps) pattern, second slice of
// the modularization after routes/tenants.js.
require('./routes/glossary').register(app, { db, requireAuth, isFirmUser, listWorkspaces });


// ==================== WORKSPACE LIFECYCLE ====================
// Lives in routes/workspaces.js (slice 15): CRUD, members, team setup.
require('./routes/workspaces').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, isFirmUser, computeReadiness, workspaceProgress, computeNextStep,
  computeRoadmap, computeClientStage, computeNeedsAttention, resolveUploadPath });

// ==================== CONTROLS + GAP ASSESSMENT ====================
// Lives in routes/controls.js (slice 7): controls list + detail, guided gap
// wizard, flag-for-review, assessment passes. controlsRoutes.notifyReviewers
// is shared with the ISO 42001 flag flow below.
const controlsRoutes = require('./routes/controls');
controlsRoutes.register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState });
require('./routes/gap-fieldwork').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction
});

// ==================== WORKSPACE OPS (BATCH A) ====================
// Lives in routes/workspace-ops.js: comments, assets + CSV import,
// cert-cycle calendar, gap-assessment DOCX report, tasks, activity log.
require('./routes/workspace-ops').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, csvUpload, activeEntityFilter, getOrCreateState, isFirmUser });

// Lives in routes/evidence.js (slice 8): library, upload, linking, versions,
// preview/download, coverage matrix.
require('./routes/evidence').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath });

// ==================== RISKS ====================
// Lives in routes/risks.js (slice 5): register + heatmap, risk libraries,
// AI-guided assessment wizard, CSV import.
require('./routes/risks').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, activeEntityFilter, getActiveMethodology, methodologyBand, seedFirmRiskLibraryIfEmpty, csvUpload });

// ==================== SOA + CROSSWALKS ====================
// Lives in routes/soa.js (slice 6): SoA single/batch/bulk updates and the
// cross-framework mapping view.
require('./routes/soa').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState });

// ==================== EXPORTS + AUDIT PACK ====================
// Lives in routes/exports.js (slice 17): CSV/DOCX exports, audit-pack zip,
// preview, PDF, config.
require('./routes/exports').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, resolveUploadPath });

// Production assurance reporting: immutable snapshots, exact stored artifacts,
// source lineage, and maker-checker review / approval.
require('./routes/assurance').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction });

// ==================== DOCUMENTS ====================
// Lives in routes/documents.js (slice 12): list/detail, template library,
// versioning + approvals + e-signatures, magic-link approval portal.
require('./routes/documents').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath, isFirmUser, diffObjects });

// Production client collaboration portal: durable requests, scoped control
// discussions, policy review links, evidence submissions, and event history.
require('./routes/client-portal').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath, permissionsFor });

// Lives in routes/governance.js (slice 9): internal audits + findings,
// improvements, management reviews, nonconformities/CAPA.
require('./routes/governance').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, workspaceProgress });

// ==================== WORKSPACE OPS (BATCH B) ====================
// Lives in routes/workspace-ops-b.js: bulk control update, autosave,
// command palette, trend data, RBAC overrides, risk methodology, review
// queue, treatment plans, SoA snapshots, changes-since, inbox, deliverables,
// firm library.
require('./routes/workspace-ops-b').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, getActiveFirmId, isFirmUser, isFirmOwner, getOrCreateState, getActiveMethodology,
  methodologyBand, ensureWorkspaceMethodology, activeEntityFilter, computeNeedsAttention,
  getWorkspace, listWorkspaces, permissionsFor });

// ==================== READINESS ====================
// Engine in lib/readiness.js (required at the top of this file); routes in
// routes/readiness.js (slice 16).
require('./routes/readiness').register(app, { db, requireAuth, requireWorkspace });

// ==================== OPERATIONAL REGISTERS ====================
// Lives in routes/registers.js (slice 10): incidents, BCP/BIA, change
// management, vendors (TPRM) + questionnaires + external vendor links.
require('./routes/registers').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, upload, resolveUploadPath, activeEntityFilter, qUploadAny, persistQuestionnaireFiles });
require('./routes/supplier-programme').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction, qUploadAny,
  resolveUploadPath, questionnaireFileExtensions: QFILE_ALLOWED_EXT
});
require('./routes/tprm').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction
});
require('./routes/tprm-relationships').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction
});
require('./routes/tprm-governance').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction,
  upload, resolveUploadPath
});
tprmMonitoringRoutes.register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction,
  csvUpload, secretResolver: resolveRuntimeSecret
});

// ==================== PERFORMANCE + PEOPLE ====================
// Lives in routes/performance.js (slice 11): ISMS metrics + 27004 library,
// policy adoption, evidence coverage matrix, training, competence, comms plan.
require('./routes/performance').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, upload });

// ==================== NOTIFICATIONS + CALENDAR ====================
// Engines in lib/next-steps.js (required at the top of this file, TDZ);
// routes in routes/notifications.js.
require('./routes/notifications').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction });


// ==================== ADMIN: EMAIL SETTINGS + OUTBOX ====================
// Firm-level transactional email config. Lives at the firm scope (not the
// workspace) because every client engagement under the firm sends from the
// same branded address. Outbox shows the last 50 sends for auditing
// (deliverability triage, "did the approver get the email", etc.).




// ==================== ENGAGEMENT OPS ====================
// Lives in routes/engagement-ops.js (final long-tail pass): exec brief,
// playbooks, objectives, deliverables, audit programme, supplier monitoring,
// access reviews, kanban, risk appetite, search, handover, report builder,
// observations, key rotation UI, file preview, mentions, and more.
require('./routes/engagement-ops').register(app, { db, requireAuth, requireWorkspace, requirePermission,
  logAction, getActiveFirmId, isFirmUser, isFirmOwner, getOrCreateState, getActiveMethodology,
  methodologyBand, activeEntityFilter, resolveUploadPath, upload, csvUpload, qUploadAny,
  resolveQuestionnaireFirm, computeClientStage, permissionsFor, persistQuestionnaireFiles, verifyAuditChain, listWorkspaces, workspaceProgress });

// ==================== ENGAGEMENT INTAKE + ADAPTIVE DELIVERY ====================
// Extracted to routes/engagement.js. Same dependency-injection pattern as
// routes/tenants.js - engagement routes get db + middleware via deps.
require('./routes/engagement').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, withToast, logAction, auditCtx,
  upload, resolveUploadPath,
});

// ==================== CONSULTING DELIVERY OPERATING SYSTEM ====================
// Firm-internal engagements, workpapers, maker-checker review, common controls,
// governed methodology, client validation hand-offs and engagement economics.
require('./routes/consulting-delivery').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, withToast, logAction, auditCtx, listWorkspaces
});

// ==================== NIST CSF 2.0 ====================
// Production NIST CSF 2.0 workflow: official 106-outcome catalog, separately
// evidenced Policy and Practice maturity, governed review, and frozen reports.
// The legacy single-score/Tier route cluster is intentionally not registered.
require('./routes/csf-policy-practice').register(app, { db, requireAuth, requireWorkspace, requirePermission, logAction, upload });


// ==================== INDIA DPDPA GAP ASSESSMENT ====================
// Controlled, evidence-gated readiness assessments against the versioned
// DPDPA obligation catalogue. This intentionally excludes privacy operations.
require('./routes/dpdpa').register(app, {
  db, requireAuth, requireWorkspace, requirePermission, logAction
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
    console.log(`Need access? Visit /register for the controlled evaluation path.\n`);
  });
}
