'use strict';
// 073: the records an ISO 42001 auditor samples that the tool did not keep.
//
//  - context_issues: the internal and external issues that shape the
//    management system (clause 4.1), beside the interested parties register,
//    whose requirements can now be marked legal, regulatory or contractual
//    (clause 4.2).
//  - ai_impact_assessments: the impact on society as its own finding (A.5.5),
//    a severity and likelihood rating for the harms, and a next review date;
//    all frozen with the rest once approved. ai_impact_assessment_editors
//    records everyone who edited a draft, so no editor can approve it.
//  - security_objectives: the plan behind each objective (actions,
//    resources, how results are evaluated), when it was communicated, and the
//    management system it belongs to (clause 6.2).
//  - competence_records: a link to the evidence file itself (clause 7.2).
//  - generated_docs: how long a document is kept (clause 7.5).
//  - isms_metrics: the framework and AI system a measure belongs to, so AI
//    measures such as drift or override rate can be defined (clause 9.1).
//  - aims_audit_rounds: when a certification audit ends, the state of every
//    request is sealed as that audit's round before the tracker is reset for
//    the next audit, so surveillance and recertification keep their history.
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}
function addColumn(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('internal','external')),
      issue TEXT NOT NULL,
      effect TEXT,
      response TEXT,
      owner TEXT,
      next_review DATE,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_context_issues_ws ON context_issues(workspace_id);

    CREATE TABLE IF NOT EXISTS ai_impact_assessment_editors (
      assessment_id INTEGER NOT NULL REFERENCES ai_impact_assessments(id) ON DELETE CASCADE,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      last_edited_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (assessment_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS aims_audit_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      cycle_event_id INTEGER REFERENCES iso42001_cert_cycle_events(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      request_count INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL,
      payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      closed_by INTEGER NOT NULL REFERENCES users(id),
      closed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_aims_audit_rounds_ws ON aims_audit_rounds(workspace_id, closed_at);
    CREATE TRIGGER IF NOT EXISTS aims_audit_rounds_sealed
    BEFORE UPDATE ON aims_audit_rounds
    BEGIN SELECT RAISE(ABORT, 'A closed audit round cannot be changed.'); END;
  `);

  addColumn(db, 'interested_parties', 'requirement_kind', "requirement_kind TEXT");

  addColumn(db, 'ai_impact_assessments', 'societal_impacts', 'societal_impacts TEXT');
  addColumn(db, 'ai_impact_assessments', 'harm_severity', 'harm_severity INTEGER');
  addColumn(db, 'ai_impact_assessments', 'harm_likelihood', 'harm_likelihood INTEGER');
  addColumn(db, 'ai_impact_assessments', 'next_review_date', 'next_review_date DATE');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_ai_impact_assessments_frozen_073
    BEFORE UPDATE OF societal_impacts, harm_severity, harm_likelihood, next_review_date ON ai_impact_assessments
    WHEN OLD.status IN ('approved','superseded')
    BEGIN SELECT RAISE(ABORT,'an approved AI impact assessment is frozen; start a new version'); END;
  `);

  addColumn(db, 'security_objectives', 'plan_actions', 'plan_actions TEXT');
  addColumn(db, 'security_objectives', 'resources', 'resources TEXT');
  addColumn(db, 'security_objectives', 'evaluation_method', 'evaluation_method TEXT');
  addColumn(db, 'security_objectives', 'communicated_on', 'communicated_on DATE');
  addColumn(db, 'security_objectives', 'framework', 'framework TEXT');

  addColumn(db, 'competence_records', 'evidence_id', 'evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL');

  addColumn(db, 'generated_docs', 'retention_period', 'retention_period TEXT');

  addColumn(db, 'isms_metrics', 'framework', 'framework TEXT');
  addColumn(db, 'isms_metrics', 'ai_system_id', 'ai_system_id INTEGER REFERENCES ai_systems(id) ON DELETE SET NULL');
};
