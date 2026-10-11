'use strict';
// Where a shared action sends the consultant back to when the ISO 42001
// module started it.
//
// The module reuses some shared actions (risk treatment actions, acceptance,
// control links, the risk method) rather than duplicating their rules. Their
// forms in the module carry `return_to`; it is honoured only when it is a page
// of this client's ISO 42001 module, so it can never send anyone elsewhere.

function moduleReturn(req) {
  const raw = (req.body && req.body.return_to) || (req.query && req.query.return_to);
  if (!raw || !req.workspace) return null;
  const value = String(raw);
  const prefix = `/workspaces/${req.workspace.id}/iso42001/`;
  if (!value.startsWith(prefix) || value.length > 300) return null;
  if (!/^[A-Za-z0-9/_\-.?=&#%]+$/.test(value) || value.includes('//') || value.includes('..')) return null;
  return value;
}

module.exports = { moduleReturn };
