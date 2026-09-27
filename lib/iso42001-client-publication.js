'use strict';

const aimsDelivery = require('./iso42001-delivery');

// A controlled report is shared only by an explicit publication of the current
// independently approved revision. Assignment and client_visible are not a
// substitute. Create this predicate per request/projection, never globally:
// retaining it across requests could keep a superseded publication readable.
function createReportVisibility(db, workspace) {
  let reportIds;
  let context;
  return row => {
    if (!aimsDelivery.isAims(workspace)) return true;
    if (!reportIds) reportIds = new Set(db.prepare(`SELECT d.id FROM engagement_delivery_deliverables d
      JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
      WHERE d.workspace_id=? AND m.milestone_key='gap-controlled-report'`).all(workspace.id).map(item => Number(item.id)));
    if (!reportIds.has(Number(row.id))) return true;
    if (context === undefined) context = aimsDelivery.gapContext(db, workspace);
    return !!context.publication && Number(context.report?.id) === Number(row.id);
  };
}

module.exports = { createReportVisibility };
