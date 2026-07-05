'use strict';
// DOCX generation for exported documents. Pure transform (doc + ws in, Buffer
// out; no DB access), which is what lets lib/workers.js run it on a worker
// thread without a second database connection. Extracted from server.js.

const MarkdownIt = require('markdown-it');
const htmlToDocx = require('html-to-docx');

const mdRenderer = new MarkdownIt({ html: false, linkify: true, typographer: true });

// Heuristic: a string is "markdown-ish" (not yet HTML) when it has no real
// HTML element tags. Legacy markdown documents get a render pass.
function looksLikeMarkdown(s) {
  if (!s) return false;
  return !/<(p|h[1-6]|ul|ol|li|table|tr|td|th|div|span|strong|em|br|hr|img|a)\b/i.test(s);
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

module.exports = { generateDocxBuffer, looksLikeMarkdown };
