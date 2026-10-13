'use strict';
// 072: ISO 42001 SoA snapshots are sealed and approved by a second person.
//
// A snapshot was described as immutable but nothing stopped it being edited,
// its approval was a name typed into the form, and it did not keep the risks
// and documents behind each control. From here on (lib/iso42001-soa.js):
//  - a snapshot's content, hash, counts and author cannot be changed;
//  - approval is a recorded act by a user with sign-off permission who did
//    not capture the snapshot, allowed only when no control is undecided and
//    every inclusion and exclusion is justified; an approved snapshot is final;
//  - the approver's typed name from earlier snapshots stays in approved_by as
//    what it was: a declaration, not a recorded sign-off.
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  const add = (column, ddl) => {
    if (!hasColumn(db, 'iso42001_soa_snapshots', column)) db.exec(`ALTER TABLE iso42001_soa_snapshots ADD COLUMN ${ddl}`);
  };
  add('approval_status', "approval_status TEXT NOT NULL DEFAULT 'draft'");
  add('approved_by_user_id', 'approved_by_user_id INTEGER REFERENCES users(id)');
  add('approved_by_name', 'approved_by_name TEXT');
  add('approved_on', 'approved_on TEXT');
  add('approval_note', 'approval_note TEXT');

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS iso42001_soa_snapshot_sealed
    BEFORE UPDATE OF payload, payload_hash, control_count, included_count, excluded_count, created_by, created_at, workspace_id
    ON iso42001_soa_snapshots
    BEGIN SELECT RAISE(ABORT, 'An SoA snapshot cannot be changed once captured.'); END;

    CREATE TRIGGER IF NOT EXISTS iso42001_soa_snapshot_approval_final
    BEFORE UPDATE ON iso42001_soa_snapshots
    WHEN OLD.approval_status = 'approved'
    BEGIN SELECT RAISE(ABORT, 'An approved SoA snapshot is final.'); END;
  `);
};
