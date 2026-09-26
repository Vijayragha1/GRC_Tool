'use strict';

// Early local installations of 062 added the canonical fields but did not
// expose them through the ISO 42001 view. Preserve every underlying record.
exports.up = function up(db) {
  const canonical = new Set(db.pragma('table_info(control_instances)').map(row => row.name));
  const fields = ['record_version', 'assessment_answers'];
  if (fields.some(field => !canonical.has(field))) throw new Error('Missing canonical assessment fields.');
  const view = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_iso42001_control_states'").get();
  if (!view || !/ci\.reviewed_at\s+AS reviewed_at/i.test(view.sql)) throw new Error('Expected ISO42001 compatibility view.');
  const columns = new Set(db.pragma('table_info(v_iso42001_control_states)').map(row => row.name));
  if (fields.every(field => columns.has(field))) return;
  if (fields.some(field => columns.has(field))) throw new Error('Unexpected partial ISO42001 diagnostic view.');
  db.exec('DROP VIEW v_iso42001_control_states');
  db.exec(view.sql.replace(/ci\.reviewed_at\s+AS reviewed_at/i,
    'ci.reviewed_at AS reviewed_at, ci.record_version AS record_version, ci.assessment_answers AS assessment_answers'));
};
