'use strict';
// 076: the dataset register an ISO 42001 auditor samples from (Annex A.7 and
// A.4.3). Datasets were free text on each AI system, so the auditor's list of
// datasets had nothing behind it and each dataset's acquisition, quality,
// provenance and preparation lived in whatever document held them.
//
//  - ai_datasets: one row per dataset the client's AI systems are built or
//    run on, with where it came from, what it holds (including whether it
//    holds personal data), the rights to use it, how it was obtained and
//    selected, the quality it must meet and the last check, how its
//    provenance is recorded, how it is prepared and labelled, known bias,
//    retention and when it last changed.
//  - ai_system_datasets: which systems use a dataset, and for what
//    (training, validation, testing, production input or reference). A
//    dataset and a system are linked only within one client.

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      source_type TEXT CHECK(source_type IS NULL OR source_type IN ('internal','customer','purchased','partner','open','synthetic')),
      origin TEXT,
      refresh TEXT CHECK(refresh IS NULL OR refresh IN ('fixed','periodic','streamed','generated')),
      data_categories TEXT,
      personal_data TEXT NOT NULL DEFAULT 'unknown' CHECK(personal_data IN ('unknown','none','personal','sensitive')),
      data_rights TEXT,
      acquisition TEXT,
      quality_requirements TEXT,
      quality_checked_on DATE,
      quality_result TEXT,
      provenance TEXT,
      preparation TEXT,
      labelling TEXT,
      known_bias TEXT,
      retention TEXT,
      last_changed DATE,
      owner TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(workspace_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_datasets_ws ON ai_datasets(workspace_id);

    CREATE TABLE IF NOT EXISTS ai_system_datasets (
      ai_system_id INTEGER NOT NULL REFERENCES ai_systems(id) ON DELETE CASCADE,
      dataset_id INTEGER NOT NULL REFERENCES ai_datasets(id) ON DELETE CASCADE,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      use TEXT NOT NULL CHECK(use IN ('training','validation','testing','production','reference')),
      linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (ai_system_id, dataset_id, use)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_system_datasets_dataset ON ai_system_datasets(dataset_id);

    CREATE TRIGGER IF NOT EXISTS trg_ai_system_datasets_tenant
    BEFORE INSERT ON ai_system_datasets
    WHEN NOT EXISTS (SELECT 1 FROM ai_systems s WHERE s.id=NEW.ai_system_id AND s.workspace_id=NEW.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM ai_datasets d WHERE d.id=NEW.dataset_id AND d.workspace_id=NEW.workspace_id)
    BEGIN SELECT RAISE(ABORT,'AI dataset link crosses workspace boundary'); END;
  `);
};
