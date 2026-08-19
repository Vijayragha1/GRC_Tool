// Extract ISO 27001:2022 Annex A control IDs and main-clause IDs out of the
// free-text descriptions used by the system policy templates. Run at seed time
// so editing a template description (adding "(A.5.7)" to it) automatically
// propagates a new control mapping into doc_templates without code changes.
//
// Supported forms:
//   A.5.15                               -> annex-a.5.15
//   A.5.15, A.5.16                       -> annex-a.5.15, annex-a.5.16
//   A.5.24–A.5.28                        -> annex-a.5.24..28 (en-dash range)
//   A.5.24-A.5.28                        -> same (hyphen range)
//   A.7.4–7.6                            -> annex-a.7.4..6  (shortened second ref)
//   A.7.4–7.6, 7.9, 7.11–7.13            -> annex-a.7.4..6, 7.9, 7.11..13
//   Clause 5.2                           -> clause-5.2
//   Clauses 6.1.2, 6.1.3, 8.2, 8.3       -> clause-6.1.2, 6.1.3, 8.2, 8.3
//   Clauses 7.2/7.3                      -> clause-7.2, 7.3
//
// What we deliberately do NOT do:
//   - Don't dive into the body content. Descriptions are short and authored,
//     so the signal-to-noise is excellent. Bodies repeat clause refs inside
//     legal prose and would produce false positives.
//   - Don't try to merge or dedupe Annex A subsections (A.8.25 stays A.8.25).

'use strict';

// Iterate every Annex A reference. The hard case is partial ranges inside a
// parenthetical: "(A.7.4–7.6, 7.9, 7.11–7.13)" - only the first ref carries the
// "A." prefix and major-section number; subsequent tokens inherit that major
// from context. We solve this by scanning parentheticals as units and threading
// a "current major" through the comma-separated tokens within.
function extractAnnexRefs(text) {
  if (!text) return [];
  const refs = new Set();

  // Two passes:
  //   1. Within each parenthetical, walk tokens left-to-right with major-section
  //      context inheritance.
  //   2. In the remaining text (outside parens), match plain "A.X.Y" only.
  const parenRe = /\(([^)]+)\)/g;
  let p;
  while ((p = parenRe.exec(text)) !== null) {
    let currentMajor = null;
    // Tokens inside a parenthetical are usually comma-separated, occasionally
    // slash-separated ("A.5.9 / A.5.2"). Split on either, then trim.
    p[1].split(/[,/]/).forEach(tok => {
      tok = tok.trim();
      // "A.X.Y" or "A.X.Y–A.X.Y2" or "A.X.Y–Y2"  (absolute)
      let m = tok.match(/^A\.(\d+)\.(\d+)(?:\s*[-–-]\s*(?:A\.)?(?:(\d+)\.)?(\d+))?$/);
      if (m) {
        currentMajor = parseInt(m[1], 10);
        addRange(refs, currentMajor, parseInt(m[2], 10),
          m[3] !== undefined ? parseInt(m[3], 10) : currentMajor,
          m[4] !== undefined ? parseInt(m[4], 10) : parseInt(m[2], 10));
        return;
      }
      // Continuation: "X.Y" or "X.Y–Y2" or "X.Y–X.Y2" inheriting the current
      // major. The non-capturing "\d+\." accepts a redundant major-section
      // on the range terminator (e.g., "7.11–7.13").
      m = tok.match(/^(\d+)\.(\d+)(?:\s*[-–-]\s*(?:\d+\.)?(\d+))?$/);
      if (m && currentMajor !== null) {
        const major = parseInt(m[1], 10);
        if (major !== currentMajor) {
          // A bare "X.Y" where X != currentMajor is genuinely a new major.
          currentMajor = major;
        }
        const start = parseInt(m[2], 10);
        const end = m[3] !== undefined ? parseInt(m[3], 10) : start;
        addRange(refs, currentMajor, start, currentMajor, end);
      }
    });
  }

  // Pass 2: outside-parens absolute matches (rare; descriptions tend to put
  // refs inside parens, but body text might mention them inline).
  const stripParens = text.replace(/\([^)]*\)/g, '');
  const absRe = /A\.(\d+)\.(\d+)(?:\s*[-–-]\s*(?:A\.)?(?:(\d+)\.)?(\d+))?/g;
  let m;
  while ((m = absRe.exec(stripParens)) !== null) {
    const major = parseInt(m[1], 10);
    const startMinor = parseInt(m[2], 10);
    const endMajor = m[3] !== undefined ? parseInt(m[3], 10) : major;
    const endMinor = m[4] !== undefined ? parseInt(m[4], 10) : startMinor;
    addRange(refs, major, startMinor, endMajor, endMinor);
  }

  return [...refs].sort(compareAnnexRefs);
}

function addRange(refs, startMajor, startMinor, endMajor, endMinor) {
  if (endMajor !== startMajor) {
    // Cross-family ranges don't occur in the standard; record the endpoints
    // as-is and let a human spot the oddity.
    refs.add(`annex-a.${startMajor}.${startMinor}`);
    refs.add(`annex-a.${endMajor}.${endMinor}`);
    return;
  }
  for (let n = startMinor; n <= endMinor; n++) refs.add(`annex-a.${startMajor}.${n}`);
}

function compareAnnexRefs(a, b) {
  const pa = a.replace('annex-a.', '').split('.').map(Number);
  const pb = b.replace('annex-a.', '').split('.').map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1];
}

// Clauses are written either as "Clause X.Y" or "Clauses X.Y, X.Y.Z" / "X.Y/X.Y".
function extractClauseRefs(text) {
  if (!text) return [];
  const refs = new Set();
  // First, find Clause/Clauses blocks and grab the trailing list. The "list"
  // terminates at end of string, period followed by space (sentence boundary),
  // or a known phrase boundary like "and " etc.
  const blockRe = /Clauses?\s+([0-9.\s,/&]+(?:and\s+[0-9.]+)?)/gi;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const list = m[1];
    // Split on common separators and grab dotted numeric tokens.
    list.split(/[\s,/&]+|and/i).forEach(tok => {
      const t = tok.trim().replace(/[.,]$/, '');
      if (/^\d+(\.\d+){1,2}$/.test(t)) refs.add(`clause-${t}`);
    });
  }
  return [...refs].sort(compareClauseRefs);
}

function compareClauseRefs(a, b) {
  const pa = a.replace('clause-', '').split('.').map(Number);
  const pb = b.replace('clause-', '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Convenience wrapper: returns { controls, clauses } from a description string.
function extractRefs(description) {
  return {
    controls: extractAnnexRefs(description),
    clauses: extractClauseRefs(description)
  };
}

module.exports = { extractRefs, extractAnnexRefs, extractClauseRefs };
