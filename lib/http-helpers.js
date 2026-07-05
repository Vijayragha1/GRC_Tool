'use strict';
// Shared HTTP-layer helpers for server.js and the routes/ modules. Every
// function here is context-free (no closure over server.js state): they take
// what they need as arguments, so route slices can import them instead of
// carrying 15-key deps objects. Two escapeHtml definitions coexisted in
// server.js until the glossary slice; this module is the single home now.

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Attach a flash-style toast to a redirect URL.
function withToast(url, msg, kind) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'toast=' + encodeURIComponent(msg) + (kind ? '&toastKind=' + kind : '');
}

// Bounce to the previous page (or /dashboard without a Referer). Express 5
// deprecated the magic "back" target.
function redirectBack(req, res, toastMsg, toastKind) {
  let target = req.get('Referer') || '/dashboard';
  if (toastMsg) target = withToast(target, toastMsg, toastKind);
  return res.redirect(target);
}

// Request context recorded with every audit-log row.
function auditCtx(req) {
  return {
    ip: (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '').toString().split(',')[0].trim(),
    userAgent: (req.headers['user-agent'] || '').slice(0, 255),
    requestId: req.id || null,
    entityScopeId: req.entityScopeId || null
  };
}

// Coerce a form value that may be a scalar, an array, or undefined into a
// clean array of non-empty strings (deduped).
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

// Parse @handles out of a comment body (pure; matching against users happens
// at the call sites).
function extractMentions(body) {
  const out = new Set();
  const re = /@([a-zA-Z0-9._-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

module.exports = { escapeHtml, withToast, redirectBack, auditCtx, parseFormArray, extractMentions };
