// Lightweight CSRF protection. Generates a per-session token, exposes it on
// res.locals so EJS can stamp it into a meta tag, and validates state-changing
// requests have a matching `_csrf` field (or X-CSRF-Token header for fetch
// callers). Skips safe methods (GET/HEAD/OPTIONS) and requests explicitly
// marked as exempt (e.g., file-download endpoints that shouldn't accept POST
// at all and would still get protected by the same handler).
//
// This is deliberately small (no third-party `csurf`, which is deprecated).
// The token rotates per-session, not per-request - adequate for SSR forms,
// not adequate for high-value mutation surfaces. Good enough for this tool.

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SKIP_PATHS = [
  /^\/favicon\.ico$/,
  /^\/api\/search/,           // GET-only search endpoint
  /^\/auditor\//,             // Token-authenticated portal; the token IS the credential
  /^\/approve\//,             // Magic-link approval portal; token in URL is the credential
];

function shouldSkip(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  return SKIP_PATHS.some(re => re.test(req.path));
}

function ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function csrfMiddleware(req, res, next) {
  const token = ensureToken(req);
  res.locals.csrfToken = token || '';

  if (shouldSkip(req)) return next();

  // Body, header, and query are all accepted. Query is the escape hatch for
  // multipart/form-data forms - multer is mounted per-route, so by the time
  // this middleware runs the body hasn't been parsed for those requests.
  // The form walker on the client appends ?_csrf=… to the action of every
  // multipart form so the token still gets through.
  const provided = (req.body && req.body._csrf)
    || (req.query && req.query._csrf)
    || req.headers['x-csrf-token']
    || req.headers['x-xsrf-token'];
  if (!token || !provided || !timingSafeEqualString(provided, token)) {
    return res.status(403).render('error', {
      user: null,
      message: 'CSRF token missing or invalid. Reload the page and try again.'
    });
  }
  next();
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { csrfMiddleware, ensureToken };
