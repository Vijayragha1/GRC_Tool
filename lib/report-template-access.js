'use strict';

// A globally visible template must be a canonical system row. Custom rows are
// visible only when they belong to the active workspace or active firm.
const VISIBLE_SCOPE = `(
  (is_system=1 AND workspace_id IS NULL AND firm_id IS NULL)
  OR workspace_id=?
  OR firm_id=?
)`;

function workspaceScope(workspace) {
  if (!workspace || workspace.id == null || workspace.firm_id == null) {
    throw new TypeError('A workspace with id and firm_id is required');
  }
  return [workspace.id, workspace.firm_id];
}

function listVisibleReportTemplates(db, workspace) {
  return db.prepare(`SELECT id,name,description,is_system
    FROM report_templates
    WHERE ${VISIBLE_SCOPE}
    ORDER BY is_system DESC,name`).all(...workspaceScope(workspace));
}

function loadVisibleReportTemplate(db, workspace, templateId) {
  return db.prepare(`SELECT *
    FROM report_templates
    WHERE id=? AND ${VISIBLE_SCOPE}`).get(templateId, ...workspaceScope(workspace));
}

module.exports = {
  VISIBLE_SCOPE,
  listVisibleReportTemplates,
  loadVisibleReportTemplate,
};
