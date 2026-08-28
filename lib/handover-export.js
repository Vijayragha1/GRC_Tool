'use strict';

// Every handover table has an explicit workspace predicate. Tables without a
// workspace_id are reached only through their workspace-owned parent; there is
// deliberately no primary-key fallback because IDs are global, not tenant IDs.
const TABLE_QUERIES = Object.freeze({
  workspaces: 'SELECT * FROM workspaces WHERE id=?',
  entities: 'SELECT * FROM entities WHERE workspace_id=?',
  assets: 'SELECT * FROM assets WHERE workspace_id=?',
  risks: 'SELECT * FROM risks WHERE workspace_id=?',
  risk_treatments: 'SELECT * FROM risk_treatments WHERE workspace_id=?',
  risk_acceptances: 'SELECT * FROM risk_acceptances WHERE workspace_id=?',
  risk_methodologies: 'SELECT * FROM risk_methodologies WHERE workspace_id=?',
  risk_appetites: 'SELECT * FROM risk_appetites WHERE workspace_id=?',
  control_instances: 'SELECT * FROM control_instances WHERE workspace_id=?',
  control_state_history: 'SELECT * FROM control_state_history WHERE workspace_id=?',
  iso42001_control_state_history: 'SELECT * FROM iso42001_control_state_history WHERE workspace_id=?',
  soa_snapshots: 'SELECT * FROM soa_snapshots WHERE workspace_id=?',
  generated_docs: 'SELECT * FROM generated_docs WHERE workspace_id=?',
  doc_versions: 'SELECT * FROM doc_versions WHERE workspace_id=?',
  doc_approvers: 'SELECT * FROM doc_approvers WHERE workspace_id=?',
  doc_signatures: 'SELECT * FROM doc_signatures WHERE workspace_id=?',
  evidence: 'SELECT * FROM evidence WHERE workspace_id=?',
  comments: 'SELECT * FROM comments WHERE workspace_id=?',
  comment_mentions: `SELECT cm.* FROM comment_mentions cm
    INNER JOIN comments c ON c.id=cm.comment_id
    WHERE c.workspace_id=?`,
  audits: 'SELECT * FROM audits WHERE workspace_id=?',
  audit_findings: `SELECT af.* FROM audit_findings af
    INNER JOIN audits a ON a.id=af.audit_id
    WHERE a.workspace_id=?`,
  audit_observations: `SELECT ao.* FROM audit_observations ao
    INNER JOIN audits a ON a.id=ao.audit_id
    WHERE a.workspace_id=?`,
  audit_programmes: 'SELECT * FROM audit_programmes WHERE workspace_id=?',
  mrms: 'SELECT * FROM mrms WHERE workspace_id=?',
  nonconformities: 'SELECT * FROM nonconformities WHERE workspace_id=?',
  incidents: 'SELECT * FROM incidents WHERE workspace_id=?',
  incident_events: 'SELECT * FROM incident_events WHERE workspace_id=?',
  suppliers: 'SELECT * FROM suppliers WHERE workspace_id=?',
  supplier_documents: 'SELECT * FROM supplier_documents WHERE workspace_id=?',
  supplier_subprocessors: 'SELECT * FROM supplier_subprocessors WHERE workspace_id=?',
  supplier_reviews: 'SELECT * FROM supplier_reviews WHERE workspace_id=?',
  supplier_notes: 'SELECT * FROM supplier_notes WHERE workspace_id=?',
  supplier_clauses: 'SELECT * FROM supplier_clauses WHERE workspace_id=?',
  supplier_controls: `SELECT sc.* FROM supplier_controls sc
    INNER JOIN suppliers s ON s.id=sc.supplier_id
    WHERE s.workspace_id=?`,
  supplier_questionnaires: 'SELECT * FROM supplier_questionnaires WHERE workspace_id=?',
  supplier_questionnaire_responses: `SELECT sqr.* FROM supplier_questionnaire_responses sqr
    INNER JOIN supplier_questionnaires sq ON sq.id=sqr.questionnaire_id
    WHERE sq.workspace_id=?`,
  supplier_monitoring: 'SELECT * FROM supplier_monitoring WHERE workspace_id=?',
  supplier_termination_items: 'SELECT * FROM supplier_termination_items WHERE workspace_id=?',
  document_requirement_links: `SELECT drl.* FROM document_requirement_links drl
    INNER JOIN generated_docs d ON d.id=drl.document_id
    WHERE d.workspace_id=?`,
  tasks: 'SELECT * FROM tasks WHERE workspace_id=?',
  task_templates: 'SELECT * FROM task_templates WHERE workspace_id=?',
  asset_relationships: 'SELECT * FROM asset_relationships WHERE workspace_id=?',
  workspace_members: 'SELECT * FROM workspace_members WHERE workspace_id=?',
  workspace_role_overrides: 'SELECT * FROM workspace_role_overrides WHERE workspace_id=?',
  access_reviews: 'SELECT * FROM access_reviews WHERE workspace_id=?',
  access_review_items: `SELECT ari.* FROM access_review_items ari
    INNER JOIN access_reviews ar ON ar.id=ari.review_id
    WHERE ar.workspace_id=?`,
  audit_log: 'SELECT * FROM audit_log WHERE workspace_id=?',
  audit_chain: `SELECT ac.* FROM audit_chain ac
    INNER JOIN audit_log al ON al.id=ac.audit_log_id
    WHERE al.workspace_id=?`,
  notifications: 'SELECT * FROM notifications WHERE workspace_id=?',
});

function handoverTableNames() {
  return Object.keys(TABLE_QUERIES);
}

function loadHandoverRows(db, tableName, workspaceId) {
  const query = TABLE_QUERIES[tableName];
  if (!query) throw new Error(`Unsupported handover table: ${tableName}`);
  return db.prepare(query).all(workspaceId);
}

module.exports = { TABLE_QUERIES, handoverTableNames, loadHandoverRows };
