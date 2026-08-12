'use strict';
// Allowed framework identifiers. Treated as a closed set so a malformed
// workspace.frameworks value can't introduce phantom nav groups.
const ALLOWED_FRAMEWORKS = ['iso27001', 'iso42001', 'csf'];

// Parse the workspace.frameworks JSON column into an Array. A stored empty
// array is intentional: clients can be created before a programme is chosen.
// Null or malformed legacy values retain the historical all-framework fallback.
function parseWorkspaceFrameworks(raw) {
  if (Array.isArray(raw)) return raw.filter(x => ALLOWED_FRAMEWORKS.includes(x));
  if (!raw) return ALLOWED_FRAMEWORKS.slice();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return ALLOWED_FRAMEWORKS.slice();
    return arr.filter(x => ALLOWED_FRAMEWORKS.includes(x));
  } catch (_) { return ALLOWED_FRAMEWORKS.slice(); }
}

module.exports = { ALLOWED_FRAMEWORKS, parseWorkspaceFrameworks };
