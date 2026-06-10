// HTML sanitisation for document bodies. Document content is stored as raw
// HTML (from the rich-text editor or from mammoth's .docx import) and rendered
// UNESCAPED (<%- %>) to consultants, clients, magic-link approvers, and
// external auditors. Without sanitisation a crafted .docx (or a pasted payload)
// embeds a stored XSS that executes in another party's session - including an
// external auditor's - which is catastrophic in a security product.
//
// Strategy: allowlist. We permit the formatting tags a policy/procedure
// document legitimately uses (headings, lists, tables, basic inline marks,
// links, images) and strip everything else - scripts, event handlers,
// javascript:/data: script URIs, style/iframe/object/embed, etc.

const sanitizeHtml = require('sanitize-html');

const OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code',
    'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['colspan', 'rowspan', 'scope', 'align'],
    td: ['colspan', 'rowspan', 'align'],
    col: ['span', 'width'],
    '*': ['class'],
  },
  // Only safe URL schemes; this is what blocks javascript:/vbscript: in href/src.
  // data: is allowed for images only (inline logos in imported docs).
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: true,
  // Drop the contents of these entirely (don't leak script text as visible text).
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  // Force external links to be safe.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }, true),
  },
};

// Sanitise a document HTML body. null/undefined pass through unchanged so
// callers don't have to special-case empty documents.
function sanitizeDocHtml(dirty) {
  if (dirty == null) return dirty;
  return sanitizeHtml(String(dirty), OPTIONS);
}

module.exports = { sanitizeDocHtml, OPTIONS };
