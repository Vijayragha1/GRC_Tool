'use strict';
// 071: AI risk assessment.
//
// ISO 42001 asks for AI risks to be assessed against the consequences for the
// organisation, for individuals and groups, and for society, and for the
// assessment to be repeated at planned intervals with its results kept. The
// risk register held one impact score and no record of each assessment run,
// and a risk could not name the AI system it concerned. This migration adds:
//  - on risks: the AI system (ai_system_id), a risk-source category
//    (risk_source), the impact on the organisation, on individuals or groups
//    and on society (impact_organisation, impact_individuals, impact_society),
//    and a next review date. When the individual or societal impact is rated,
//    the risk's `impact` is the highest of the three, so every score, band and
//    heat map already reading `impact` ranks an AI risk by its worst
//    consequence (lib/ai-risk.js);
//  - risk_assessment_records: a sealed snapshot of the register each time an
//    assessment is performed, with who performed it and when. A record cannot
//    be changed once written; it is removed only when the client is.
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  const add = (column, ddl) => { if (!hasColumn(db, 'risks', column)) db.exec(`ALTER TABLE risks ADD COLUMN ${ddl}`); };
  add('ai_system_id', 'ai_system_id INTEGER REFERENCES ai_systems(id) ON DELETE SET NULL');
  add('risk_source', 'risk_source TEXT');
  add('impact_organisation', 'impact_organisation INTEGER');
  add('impact_individuals', 'impact_individuals INTEGER');
  add('impact_society', 'impact_society INTEGER');
  add('next_review_date', 'next_review_date DATE');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_risks_ai_system ON risks(ai_system_id);

    CREATE TABLE IF NOT EXISTS risk_assessment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('all','ai')),
      label TEXT NOT NULL,
      performed_on DATE NOT NULL,
      methodology_name TEXT,
      notes TEXT,
      risk_count INTEGER NOT NULL,
      above_appetite INTEGER NOT NULL,
      payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_risk_assessment_records_ws ON risk_assessment_records(workspace_id, performed_on);

    CREATE TRIGGER IF NOT EXISTS risk_assessment_records_sealed_update
    BEFORE UPDATE ON risk_assessment_records
    BEGIN SELECT RAISE(ABORT, 'A recorded risk assessment cannot be changed.'); END;
  `);
};
