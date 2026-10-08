'use strict';
// Which management system a risk belongs to (migration 079).
//
// ISO 27001 and ISO 42001 keep separate risk records: a risk is the ISMS's or
// the AIMS's, never both, and each is assessed against its own system's risk
// criteria. On a client with one of the two, every risk belongs to it. On a
// client with both, the ISO 42001 module creates the AIMS's risks and the
// shared risk register the ISMS's; a path that cannot tell (an import, say)
// gives a risk that names an AI system or AI risk source to the AIMS.

const { parseWorkspaceFrameworks } = require('./frameworks');

const SYSTEMS = Object.freeze(['iso27001', 'iso42001']);

function systemsOf(workspace) {
  const codes = parseWorkspaceFrameworks(workspace && workspace.frameworks);
  return SYSTEMS.filter((s) => codes.includes(s));
}

const aimsOnly = (workspace) => { const s = systemsOf(workspace); return s.length === 1 && s[0] === 'iso42001'; };
const hasBoth = (workspace) => systemsOf(workspace).length === 2;

// The system whose register and risk criteria a page reads by default: the
// AIMS on an ISO 42001-only client, the ISMS everywhere else.
const primary = (workspace) => (aimsOnly(workspace) ? 'iso42001' : 'iso27001');

// The owner of a new risk. `hint.management_system` is honoured when the
// client has that system; otherwise AI markers decide on a client with both.
function ownerFor(workspace, hint = {}) {
  const systems = systemsOf(workspace);
  if (systems.length === 1) return systems[0];
  if (!systems.length) return 'iso27001';
  if (SYSTEMS.includes(hint.management_system)) return hint.management_system;
  return hint.ai_system_id || hint.risk_source ? 'iso42001' : 'iso27001';
}

// Give a risk just inserted its owner. One call after each insert path.
function assign(db, workspace, riskId, hint = {}) {
  const owner = ownerFor(workspace, hint);
  db.prepare('UPDATE risks SET management_system=? WHERE id=? AND workspace_id=?').run(owner, riskId, workspace.id);
  return owner;
}

// A SQL condition for risks owned by `system`, with the table alias given.
function ownedSql(alias, system) {
  if (!SYSTEMS.includes(system)) throw new Error(`Unknown management system ${system}`);
  return `${alias}.management_system='${system}'`;
}

// A management system named on a request, accepted only when the client has
// it; otherwise the client's primary system.
function requested(workspace, value) {
  return SYSTEMS.includes(value) && systemsOf(workspace).includes(value) ? value : primary(workspace);
}

module.exports = { SYSTEMS, systemsOf, aimsOnly, hasBoth, primary, ownerFor, assign, ownedSql, requested };
