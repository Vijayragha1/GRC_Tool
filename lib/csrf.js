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
  /^\/q\//,                   // External supplier questionnaire; token in URL is the credential
  /^\/supplier-ddq\//,        // Workbook-governed supplier DDQ; token in URL is the credential
  /^\/integrations\/tprm\/monitoring\/[^/]+\/?$/, // Exact-body HMAC authenticated monitoring ingress
];

// Native multipart forms cannot add a request header, and their body is parsed
// by route-level multer middleware after this global middleware. Only these
// known upload endpoints may defer validation until multer has populated
// req.body. Any other multipart mutation is rejected by the global check.
// `csrfAfterMultipart` is called by the central upload facades in server.js.
const MULTIPART_PATHS = [
  /^\/workspaces\/[^/]+\/evidence(?:\/bulk|\/[^/]+\/supersede)?\/?$/,
  /^\/workspaces\/[^/]+\/(?:assets|risks)\/import\/preview\/?$/,
  /^\/workspaces\/[^/]+\/documents\/upload\/?$/,
  /^\/workspaces\/[^/]+\/client-portal\/(?:deliverables|requests)\/[^/]+\/evidence\/?$/,
  /^\/workspaces\/[^/]+\/csf\/[^/]+\/(?:assessment|assess)\/[^/]+\/evidence\/?$/,
  /^\/workspaces\/[^/]+\/engagement-plan\/deliverables\/[^/]+\/evidence\/?$/,
  /^\/workspaces\/[^/]+\/vendors\/[^/]+\/documents\/?$/,
  /^\/workspaces\/[^/]+\/tprm\/monitoring\/connectors\/[^/]+\/import\/?$/,
  /^\/workspaces\/[^/]+\/client-portal\/tprm\/[^/]+\/conditions\/[^/]+\/submit\/?$/,
];

function shouldSkip(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  return SKIP_PATHS.some(re => re.test(req.path));
}

function isMultipart(req) {
  return /^multipart\/form-data(?:\s*;|$)/i.test(String(req.headers && req.headers['content-type'] || ''));
}

function canDeferMultipart(req) {
  if (!isMultipart(req)) return false;
  if (SKIP_PATHS.some(re => re.test(req.path))) return true;
  return MULTIPART_PATHS.some(re => re.test(req.path));
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

  if (SAFE_METHODS.has(req.method)) {
    // SEC-003: old clients/bookmarks may still send the token in a GET URL.
    // Remove it before the request reaches a view so it cannot be retained in
    // browser history, referrers, or subsequent application redirects.
    const cleanUrl = urlWithoutCsrf(req);
    if (cleanUrl) return res.redirect(303, cleanUrl);
    return next();
  }

  if (shouldSkip(req)) return next();

  // Known multipart endpoints perform the same validation immediately after
  // multer parses the hidden field. Query-string tokens are never accepted.
  if (canDeferMultipart(req)) {
    req.csrfDeferred = true;
    return next();
  }

  if (!validRequestToken(req, token)) return rejectCsrf(req, res);
  next();
}

function csrfAfterMultipart(req, res, next, onReject) {
  // Token-authenticated external upload portals are deliberately exempt.
  if (SKIP_PATHS.some(re => re.test(req.path))) return next();
  const token = ensureToken(req);
  res.locals.csrfToken = token || '';
  if (!req.csrfDeferred || !validRequestToken(req, token)) {
    if (typeof onReject === 'function') onReject();
    return rejectCsrf(req, res);
  }
  next();
}

function validRequestToken(req, token = ensureToken(req)) {
  const provided = (req.body && req.body._csrf)
    || (req.headers && req.headers['x-csrf-token'])
    || (req.headers && req.headers['x-xsrf-token']);
  return !!token && !!provided && timingSafeEqualString(provided, token);
}

function rejectCsrf(req, res) {
  return res.status(403).render('error', {
    user: req.user || null,
    ws: req.workspace || null,
    message: 'CSRF token missing or invalid. Reload the page and try again.'
  });
}

function urlWithoutCsrf(req) {
  const original = String(req.originalUrl || req.url || req.path || '');
  const question = original.indexOf('?');
  if (question < 0) return null;
  const pathname = original.slice(0, question);
  const params = new URLSearchParams(original.slice(question + 1));
  if (!params.has('_csrf')) return null;
  params.delete('_csrf');
  const query = params.toString();
  return pathname + (query ? `?${query}` : '');
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = {
  csrfMiddleware,
  csrfAfterMultipart,
  ensureToken,
  validRequestToken,
  canDeferMultipart,
  urlWithoutCsrf,
};
