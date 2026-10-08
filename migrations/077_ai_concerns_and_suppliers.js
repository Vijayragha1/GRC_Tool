'use strict';
// 077: records an ISO 42001 auditor samples at Stage 2 that had nowhere to live.
//
//  - ai_concern_reports: concerns raised about the organisation's role with
//    an AI system (A.3.3) and adverse impacts reported by people outside it
//    (A.8.3), each with who handles it, when a response is due, whether it
//    went to management, and how it was resolved. A reporter's identity is
//    never stored: only the kind of reporter, and whether they asked to stay
//    anonymous.
//  - ai_system_suppliers.supplier_id: a supplier in an AI system's life
//    cycle can now be the client's supplier register entry, so its due
//    diligence, contract and reviews are one click away (8.1, A.10.3).
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_concern_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('concern','adverse_impact')),
      received_on DATE NOT NULL,
      reporter_type TEXT NOT NULL DEFAULT 'other' CHECK(reporter_type IN ('employee','contractor','user','affected_person','customer','regulator','public','other')),
      anonymous INTEGER NOT NULL DEFAULT 0 CHECK(anonymous IN (0,1)),
      ai_system_id INTEGER REFERENCES ai_systems(id) ON DELETE SET NULL,
      summary TEXT NOT NULL,
      impact_area TEXT,
      severity TEXT CHECK(severity IS NULL OR severity IN ('low','medium','high')),
      status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','investigating','resolved')),
      handler TEXT,
      respond_by DATE,
      escalated_on DATE,
      incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
      resolution TEXT,
      resolved_on DATE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_ai_concern_reports_ws ON ai_concern_reports(workspace_id, status);

    CREATE TRIGGER IF NOT EXISTS trg_ai_concern_reports_tenant
    BEFORE INSERT ON ai_concern_reports
    WHEN (NEW.ai_system_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ai_systems s WHERE s.id=NEW.ai_system_id AND s.workspace_id=NEW.workspace_id))
      OR (NEW.incident_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.id=NEW.incident_id AND i.workspace_id=NEW.workspace_id))
    BEGIN SELECT RAISE(ABORT,'AI concern report crosses workspace boundary'); END;

    CREATE TRIGGER IF NOT EXISTS trg_ai_concern_reports_tenant_update
    BEFORE UPDATE OF ai_system_id, incident_id ON ai_concern_reports
    WHEN (NEW.ai_system_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ai_systems s WHERE s.id=NEW.ai_system_id AND s.workspace_id=NEW.workspace_id))
      OR (NEW.incident_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.id=NEW.incident_id AND i.workspace_id=NEW.workspace_id))
    BEGIN SELECT RAISE(ABORT,'AI concern report crosses workspace boundary'); END;
  `);

  if (!hasColumn(db, 'ai_system_suppliers', 'supplier_id')) {
    db.exec('ALTER TABLE ai_system_suppliers ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL');
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_ai_system_suppliers_register_tenant
    BEFORE INSERT ON ai_system_suppliers
    WHEN NEW.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers v WHERE v.id=NEW.supplier_id AND v.workspace_id=NEW.workspace_id)
    BEGIN SELECT RAISE(ABORT,'AI system supplier crosses workspace boundary'); END;
  `);
};
