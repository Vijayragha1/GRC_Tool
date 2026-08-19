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

module.exports = { normalizeDisplayPunctuation };
