'use strict';

const aimsDelivery = require('./iso42001-delivery');

// A controlled report is shared only by an explicit publication of the current
// independently approved revision. Assignment and client_visible are not a
// substitute. Create this predicate per request/projection, never globally:
// retaining it across requests could keep a superseded publication readable.
// Covers the ISO 42001 report of an ISO 42001-only plan and the separate ISO
// 42001 report of a plan for a client with both standards.
function createReportVisibility(db, workspace) {
  let reportIds;
  let context;
  return row => {
    const key = aimsDelivery.reportKey(workspace);
    if (!key) return true;
    if (!reportIds) reportIds = new Set(db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
      JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
      WHERE d.workspace_id=? AND m.milestone_key=?`).all(workspace.id, key).map(item => Number(item.id)));
    if (!reportIds.has(Number(row.id))) return true;
    if (context === undefined) context = aimsDelivery.isAims(workspace) ? aimsDelivery.gapContext(db, workspace) : aimsDelivery.reportState(db, workspace);
    return !!context.publication && Number(context.report?.id) === Number(row.id);
  };
}

module.exports = { createReportVisibility };
