'use strict';
// 075: what ISO/IEC 42001 requires at Stage 1 that the AI management system
// records did not yet hold.
//
//  - ai_impact_assessments: the setting the system is deployed in, both
//    technical and social, and the jurisdictions whose law applies (clause
//    6.1.4); the areas of impact considered, one by one; the groups that need
//    particular protection; how long the result is kept (A.5.3); and who the
//    result was shared with. All frozen with the rest once approved.
//  - aims_climate_decision: whether climate change is a relevant issue for
//    the management system, and why (clause 4.1, as amended in 2024).
//  - aims_risks_opportunities: the risks and opportunities for the management
//    system itself, as distinct from the risks of each AI system, with the
//    action planned, how it is built into the AIMS and how its effectiveness
//    is judged (clause 6.1.1).
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}
function addColumn(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

exports.up = function up(db) {
  addColumn(db, 'ai_impact_assessments', 'deployment_context', 'deployment_context TEXT');
  addColumn(db, 'ai_impact_assessments', 'jurisdictions', 'jurisdictions TEXT');
  addColumn(db, 'ai_impact_assessments', 'impact_areas', 'impact_areas TEXT');
  addColumn(db, 'ai_impact_assessments', 'vulnerable_groups', 'vulnerable_groups TEXT');
  addColumn(db, 'ai_impact_assessments', 'retention_period', 'retention_period TEXT');
  addColumn(db, 'ai_impact_assessments', 'shared_with', 'shared_with TEXT');

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_ai_impact_assessments_frozen_075
    BEFORE UPDATE OF deployment_context, jurisdictions, impact_areas, vulnerable_groups, retention_period, shared_with ON ai_impact_assessments
    WHEN OLD.status IN ('approved','superseded')
    BEGIN SELECT RAISE(ABORT,'an approved AI impact assessment is frozen; start a new version'); END;

    CREATE TABLE IF NOT EXISTS aims_climate_decision (
      workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      relevant TEXT NOT NULL CHECK(relevant IN ('yes','no')),
      rationale TEXT NOT NULL,
      next_review DATE,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS aims_risks_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('risk','opportunity')),
      description TEXT NOT NULL,
      context_issue_id INTEGER REFERENCES context_issues(id) ON DELETE SET NULL,
      interested_party_id INTEGER REFERENCES interested_parties(id) ON DELETE SET NULL,
      action TEXT,
      integration TEXT,
      owner TEXT,
      due_date DATE,
      effectiveness_method TEXT,
      effectiveness_result TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_aims_risks_opportunities_ws ON aims_risks_opportunities(workspace_id);

    CREATE TRIGGER IF NOT EXISTS trg_aims_risks_opportunities_tenant
    BEFORE INSERT ON aims_risks_opportunities
    WHEN (NEW.context_issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM context_issues c WHERE c.id=NEW.context_issue_id AND c.workspace_id=NEW.workspace_id))
      OR (NEW.interested_party_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM interested_parties p WHERE p.id=NEW.interested_party_id AND p.workspace_id=NEW.workspace_id))
    BEGIN SELECT RAISE(ABORT,'AIMS risk or opportunity crosses workspace boundary'); END;

    CREATE TRIGGER IF NOT EXISTS trg_aims_risks_opportunities_tenant_update
    BEFORE UPDATE OF context_issue_id, interested_party_id ON aims_risks_opportunities
    WHEN (NEW.context_issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM context_issues c WHERE c.id=NEW.context_issue_id AND c.workspace_id=NEW.workspace_id))
      OR (NEW.interested_party_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM interested_parties p WHERE p.id=NEW.interested_party_id AND p.workspace_id=NEW.workspace_id))
    BEGIN SELECT RAISE(ABORT,'AIMS risk or opportunity crosses workspace boundary'); END;
  `);
};
