'use strict';
// Allowed framework identifiers. Treated as a closed set so a malformed
// workspace.frameworks value can't introduce phantom nav groups.
const ALLOWED_FRAMEWORKS = ['iso27001', 'iso42001', 'csf'];

// Parse the workspace.frameworks JSON column into an Array. Falls back to
// "all three" so a workspace created before the column existed (or one
// whose value got corrupted) still renders something useful.
function parseWorkspaceFrameworks(raw) {
  if (!raw) return ALLOWED_FRAMEWORKS.slice();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return ALLOWED_FRAMEWORKS.slice();
    const cleaned = arr.filter(x => ALLOWED_FRAMEWORKS.includes(x));
    return cleaned.length ? cleaned : ALLOWED_FRAMEWORKS.slice();
  } catch (_) { return ALLOWED_FRAMEWORKS.slice(); }
}

module.exports = { ALLOWED_FRAMEWORKS, parseWorkspaceFrameworks };
