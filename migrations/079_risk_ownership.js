'use strict';
// 079: each risk, and each risk method, belongs to one management system.
//
// Until now ISO 27001 and ISO 42001 shared one risk register and one risk
// method per client, and "an AI risk" was inferred from its AI system, risk
// source or ISO 42001 control links. ISO 42001 now keeps its own records: a
// risk is the AIMS's or the ISMS's, never both, and the AIMS assesses against
// its own risk criteria (clause 6.1.1). Treatments, treatment actions,
// acceptances and control links follow the risk they belong to.
//
//  - risks.management_system: 'iso27001' or 'iso42001'. Existing risks go to
//    ISO 42001 on a client whose only management system is ISO 42001, or
//    when they carry an AI marker (an AI system, a risk source or an ISO 42001
//    control link) and no ISO 27001 control link; otherwise to ISO 27001.
//  - risk_methodologies.management_system: one active method per client and
//    system. A client with only ISO 42001 keeps its method as the AIMS's.
//  - A trigger gives a risk inserted for a client with only ISO 42001 to the
//    AIMS. Every application path sets the owner itself (lib/risk-owner.js);
//    the trigger is the backstop for seeds and imports that do not.
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

// A workspace whose frameworks name ISO 42001 and not ISO 27001. A missing
// value means the legacy default, which includes both.
const AIMS_ONLY = (wsExpr) => `EXISTS (SELECT 1 FROM workspaces w WHERE w.id=${wsExpr} AND json_valid(w.frameworks)
  AND EXISTS (SELECT 1 FROM json_each(w.frameworks) j WHERE j.value='iso42001')
  AND NOT EXISTS (SELECT 1 FROM json_each(w.frameworks) j WHERE j.value='iso27001'))`;

exports.up = function up(db) {
  if (!hasColumn(db, 'risks', 'management_system')) {
    db.exec(`ALTER TABLE risks ADD COLUMN management_system TEXT NOT NULL DEFAULT 'iso27001'
      CHECK(management_system IN ('iso27001','iso42001'))`);
  }
  if (!hasColumn(db, 'risk_methodologies', 'management_system')) {
    db.exec(`ALTER TABLE risk_methodologies ADD COLUMN management_system TEXT NOT NULL DEFAULT 'iso27001'
      CHECK(management_system IN ('iso27001','iso42001'))`);
  }

  db.exec(`
    UPDATE risks SET management_system='iso42001'
    WHERE ${AIMS_ONLY('risks.workspace_id')}
       OR ((ai_system_id IS NOT NULL OR risk_source IS NOT NULL
            OR EXISTS (SELECT 1 FROM iso42001_risk_controls rc42 WHERE rc42.risk_id=risks.id))
           AND NOT EXISTS (SELECT 1 FROM risk_controls rc WHERE rc.risk_id=risks.id));

    UPDATE risk_methodologies SET management_system='iso42001' WHERE ${AIMS_ONLY('risk_methodologies.workspace_id')};

    CREATE INDEX IF NOT EXISTS idx_risks_ws_system ON risks(workspace_id, management_system);
    CREATE INDEX IF NOT EXISTS idx_risk_methodologies_active ON risk_methodologies(workspace_id, management_system, is_active);

    CREATE TRIGGER IF NOT EXISTS trg_risks_aims_only_owner
    AFTER INSERT ON risks
    WHEN NEW.management_system='iso27001' AND ${AIMS_ONLY('NEW.workspace_id')}
    BEGIN UPDATE risks SET management_system='iso42001' WHERE id=NEW.id; END;
  `);
};
