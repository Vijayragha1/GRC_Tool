'use strict';
// Markup the pinned html-to-docx (1.1.2) can render, from the HTML the
// reports write. That converter drops headings (h1 to h6), header cells (th),
// whole header rows (thead), and <em> and <b> text without an error, and it
// crashes on an <i> or <strong> that holds a <span>. Run in the worker before every
// conversion (lib/docx-worker.js), so a report keeps its headings and its
// tables' column labels in Word.
//
// Font sizes are not honoured by the converter, so a heading becomes a bold
// paragraph and a header cell a shaded, bold cell.

const HEADER_SHADE = '#F4F4F5';
const text = (inner) => String(inner).replace(/<[^>]*>/g, '').trim();

function normalise(html) {
  if (!html) return html;
  return String(html)
    // Header rows become the first rows of the body.
    .replace(/<\/thead>\s*<tbody[^>]*>/gi, '')
    .replace(/<thead[^>]*>/gi, '<tbody>')
    .replace(/<\/thead>/gi, '</tbody>')
    .replace(/<th(\s[^>]*)?>([\s\S]*?)<\/th>/gi, (_, attrs = '', inner) => {
      const shaded = /\bstyle\s*=/i.test(attrs) ? attrs : `${attrs} style="background-color:${HEADER_SHADE};"`;
      return `<td${shaded}>${/</.test(inner) || !inner.trim() ? inner : `<strong>${inner}</strong>`}</td>`;
    })
    .replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_, level, attrs, inner) => (text(inner) ? `<p><strong>${text(inner)}</strong></p>` : ''))
    // <i> and <strong> crash the converter around markup, so emphasis that
    // holds any is unwrapped and its text kept.
    .replace(/<em(\s[^>]*)?>([\s\S]*?)<\/em>/gi, (_, attrs, inner) => (/</.test(inner) ? inner : `<i>${inner}</i>`))
    .replace(/<b(\s[^>]*)?>([\s\S]*?)<\/b>/gi, (_, attrs, inner) => (/</.test(inner) ? inner : `<strong>${inner}</strong>`));
}

module.exports = { normalise };
