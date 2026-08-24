'use strict';

/**
 * Keep application punctuation visually restrained. This runs on rendered
 * HTML as a final safeguard so legacy records cannot reintroduce em dashes.
 * Stored source data remains unchanged.
 */
function normalizeDisplayPunctuation(value) {
  if (typeof value !== 'string') return value;
  const entityPattern = new RegExp('&' + 'mdash;', 'gi');
  return value
    .replace(/\u2014/g, '-')
    .replace(entityPattern, '-');
}

// Destructive name confirmations must compare against the value the user can
// actually see. The final-render normalizer above intentionally converts old
// stored punctuation without rewriting source records. Comparing a submitted
// visible name to the unrendered database value would otherwise make those
// records impossible to confirm.
function confirmationName(value) {
  // Compare raw form/database strings, not rendered HTML. A literal entity in
  // stored data is escaped by EJS and remains visible as text; only the actual
  // code point is transformed by the final-render hook.
  return String(value == null ? '' : value)
    .replace(/\u2014/g, '-')
    .normalize('NFC')
    .trim();
}

function confirmationMatchesRenderedName(submitted, stored) {
  return confirmationName(submitted) === confirmationName(stored);
}

module.exports = {
  normalizeDisplayPunctuation,
  confirmationName,
  confirmationMatchesRenderedName,
};
