'use strict';

exports.up = function up(db) {
  db.exec(`ALTER TABLE control_instances ADD COLUMN assessment_answers TEXT;
    ALTER TABLE control_instances ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version > 0);
    CREATE TRIGGER control_record_version AFTER UPDATE ON control_instances
    WHEN NEW.record_version = OLD.record_version
    BEGIN UPDATE control_instances SET record_version = OLD.record_version + 1 WHERE id = NEW.id; END;

    CREATE TABLE form_drafts (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      context_key TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 1,
      draft_version INTEGER NOT NULL DEFAULT 1,
      base_version TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','consumed','discarded')),
      last_save_id TEXT,
      saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(workspace_id,actor_id,kind,record_id,context_key)
    );
    CREATE TABLE form_mutations (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      mutation_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(workspace_id,actor_id,kind,record_id,mutation_key)
    );`);
  // Extend the deployed compatibility view, preserving all existing mappings.
  const view = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_control_states'").get();
  if (!view || !/NULL\s+AS assessment_answers/i.test(view.sql)) throw new Error('Expected control-state compatibility view.');
  const updated = view.sql.replace(/NULL\s+AS assessment_answers/i, 'ci.assessment_answers AS assessment_answers')
    .replace(/ci\.reviewed_at\s+AS reviewed_at/i, 'ci.reviewed_at AS reviewed_at, ci.record_version AS record_version');
  db.exec('DROP VIEW v_control_states');
  db.exec(updated);
  const view42 = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_iso42001_control_states'").get();
  if (!view42 || !/ci\.reviewed_at\s+AS reviewed_at/i.test(view42.sql)) throw new Error('Expected ISO42001 compatibility view.');
  db.exec('DROP VIEW v_iso42001_control_states');
  db.exec(view42.sql.replace(/ci\.reviewed_at\s+AS reviewed_at/i,'ci.reviewed_at AS reviewed_at, ci.record_version AS record_version, ci.assessment_answers AS assessment_answers'));
};
