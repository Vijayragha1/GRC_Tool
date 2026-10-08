'use strict';
// Which controls treat a risk, for every ISO framework the client works to.
//
// A risk treated by an ISO 27001 control is recorded in risk_controls, and one
// treated by an ISO 42001 control in iso42001_risk_controls; each table keys
// into its own catalogue. The risk page, the library and the guided wizard
// used to write only risk_controls, so an ISO 42001 client could only record
// treatment against ISO 42001 controls from the control's own page, and the
// SoA justifications built from linked risks rarely had anything to work
// from. These helpers route a link to the table its control belongs to, and
// read both back together.

const ctlWrites = require('./control-writes');
const reqOpts = require('./requirement-options');

const TABLES = Object.freeze({ iso27001: 'risk_controls', iso42001: 'iso42001_risk_controls' });
const CATALOGUES = Object.freeze({ iso27001: 'iso_items', iso42001: 'iso42001_items' });

function frameworksFor(workspace) {
  return reqOpts.enabledCodes(workspace).filter((code) => TABLES[code]);
}

// Controls a risk can be linked to, grouped by framework for a picker.
function pickerGroups(db, workspace) {
  const codes = frameworksFor(workspace);
  return reqOpts.grouped(db, workspace, { types: 'control' }).filter((g) => codes.includes(g.framework));
}

// Link a risk to a control. The control must be an ISO control of one of the
// workspace's frameworks; an undecided control becomes included on that
// framework's SoA, since a risk now depends on it. Returns the framework the
// link was recorded under, or null when the control is not one of the
// workspace's.
function link(db, workspace, riskId, itemId) {
  const framework = reqOpts.frameworkOf(db, itemId);
  if (!framework || !frameworksFor(workspace).includes(framework)) return null;
  const isControl = db.prepare(`SELECT 1 FROM ${CATALOGUES[framework]} WHERE id=? AND type='control'`).get(itemId);
  if (!isControl) return null;
  db.prepare(`INSERT OR IGNORE INTO ${TABLES[framework]} (risk_id, iso_item_id) VALUES (?, ?)`).run(riskId, itemId);
  const rid = ctlWrites.requirementId(db, framework, itemId);
  if (rid) {
    db.prepare(`INSERT OR IGNORE INTO control_instances (workspace_id, requirement_id, entity_id) VALUES (?, ?, NULL)`).run(workspace.id, rid);
    db.prepare(`UPDATE control_instances SET applicability='applicable'
      WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND applicability='undecided'`).run(workspace.id, rid);
  }
  return framework;
}

function unlink(db, riskId, itemId) {
  let removed = 0;
  for (const table of Object.values(TABLES)) {
    removed += db.prepare(`DELETE FROM ${table} WHERE risk_id=? AND iso_item_id=?`).run(riskId, itemId).changes;
  }
  return removed;
}

// Every control linked to a risk, across the ISO frameworks, in catalogue
// order, with the page each one opens on.
function linked(db, workspace, riskId) {
  const rows = [];
  for (const [framework, table] of Object.entries(TABLES)) {
    for (const r of db.prepare(`SELECT i.id, i.title, i.sort_order FROM ${table} rc
        JOIN ${CATALOGUES[framework]} i ON i.id = rc.iso_item_id WHERE rc.risk_id=? ORDER BY i.sort_order`).all(riskId)) {
      rows.push({
        ...r,
        framework,
        frameworkLabel: reqOpts.label(framework),
        href: framework === 'iso42001'
          ? `/workspaces/${workspace.id}/iso42001/gap/${r.id}`
          : `/workspaces/${workspace.id}/controls/${r.id}`,
      });
    }
  }
  return rows;
}

module.exports = { TABLES, frameworksFor, pickerGroups, link, unlink, linked };
