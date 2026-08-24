'use strict';

// One HTML policy for every controlled-document write and render boundary.
// Stored content is still sanitised on output so historical signed versions can
// remain byte-for-byte immutable while never reaching a browser as active HTML.
const sanitizeHtml = require('sanitize-html');

const SAFE_STYLE_VALUE = /^(?!.*(?:url\s*\(|expression\s*\(|@import|javascript:|data:|\\)).{0,240}$/i;

const OPTIONS = Object.freeze({
  allowedTags: Array.from(new Set([
    ...sanitizeHtml.defaults.allowedTags,
    'article', 'section', 'header', 'footer', 'main',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'details', 'summary', 'mark', 'small', 'sub', 'sup'
  ])),
  disallowedTagsMode: 'discard',
  allowedAttributes: {
    '*': ['class', 'title', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'style'],
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    table: ['border', 'cellpadding', 'cellspacing', 'summary'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    ol: ['start', 'type'],
    li: ['value']
  },
  // Remote images are excluded: otherwise merely opening an approval/auditor
  // page can disclose its viewer's IP and a unique tracking identifier.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    a: ['http', 'https', 'mailto'],
    img: ['data']
  },
  allowedStyles: {
    '*': {
      color: [SAFE_STYLE_VALUE],
      'background-color': [SAFE_STYLE_VALUE],
      'text-align': [/^(?:left|right|center|justify)$/],
      'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/],
      'font-style': [/^(?:normal|italic|oblique)$/],
      'text-decoration': [SAFE_STYLE_VALUE],
      'vertical-align': [SAFE_STYLE_VALUE],
      width: [SAFE_STYLE_VALUE],
      height: [SAFE_STYLE_VALUE],
      margin: [SAFE_STYLE_VALUE],
      'margin-left': [SAFE_STYLE_VALUE],
      'margin-right': [SAFE_STYLE_VALUE],
      'margin-top': [SAFE_STYLE_VALUE],
      'margin-bottom': [SAFE_STYLE_VALUE],
      padding: [SAFE_STYLE_VALUE],
      'padding-left': [SAFE_STYLE_VALUE],
      'padding-right': [SAFE_STYLE_VALUE],
      'padding-top': [SAFE_STYLE_VALUE],
      'padding-bottom': [SAFE_STYLE_VALUE],
      border: [SAFE_STYLE_VALUE],
      'border-left': [SAFE_STYLE_VALUE],
      'border-right': [SAFE_STYLE_VALUE],
      'border-top': [SAFE_STYLE_VALUE],
      'border-bottom': [SAFE_STYLE_VALUE],
      'border-collapse': [/^(?:collapse|separate)$/],
      'page-break-before': [/^(?:auto|always|avoid|left|right)$/],
      'page-break-after': [/^(?:auto|always|avoid|left|right)$/],
      'page-break-inside': [/^(?:auto|avoid)$/]
    }
  },
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer' }
    }),
    img: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, loading: 'lazy' }
    })
  },
  exclusiveFilter(frame) {
    if (frame.tag !== 'img') return false;
    const src = String((frame.attribs && frame.attribs.src) || '');
    return !/^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(src);
  },
  // Do not preserve the text of active/non-document tags.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript']
});

function sanitizeDocumentHtml(value) {
  return sanitizeHtml(value == null ? '' : String(value), OPTIONS);
}

function renderDocumentHtml(value, { isMarkdown = false, markdownRenderer = null } = {}) {
  const raw = value == null ? '' : String(value);
  const rendered = isMarkdown && markdownRenderer ? markdownRenderer.render(raw) : raw;
  return sanitizeDocumentHtml(rendered);
}

module.exports = { OPTIONS, sanitizeDocumentHtml, renderDocumentHtml };
