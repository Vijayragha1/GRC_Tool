'use strict';
// 070: the ISO 42001 certification cycle becomes one record of audit dates,
// with the certification body's findings attached to its audits.
//
// ISO 42001 audit dates were kept in two places: the Stage 1 and Stage 2 dates
// on the programme overview (aims_audit_programmes) and the events on the
// certification-cycle page (iso42001_cert_cycle_events), which stored a free
// label as its type ('Stage 1 audit' from the seed, 'stage1' from the form).
// Neither held the certification body's findings. After this migration:
//  - every event carries a normalised event_key (stage1, stage2, surv1, surv2,
//    recert, internal, mrm, other), the certification body, and the number of
//    the three-year certification cycle it belongs to, so surveillance and
//    recertification audits keep their own history;
//  - Stage 1 and Stage 2 dates recorded only on the programme overview become
//    the cycle's Stage 1 and Stage 2 events. From here on lib/iso42001-cycle.js
//    reads and writes those dates through the events, and the programme
//    columns are kept equal to them for older readers.
// Findings are nonconformities with source 'external_audit' and source_ref
// 'aims_cert_event:<id>'; they need no schema of their own.
// Columns are added only where missing, so the migration is safe on a database
// whose core schema already has them.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  const add = (column, ddl) => {
    if (!hasColumn(db, 'iso42001_cert_cycle_events', column)) db.exec(`ALTER TABLE iso42001_cert_cycle_events ADD COLUMN ${ddl}`);
  };
  add('event_key', 'event_key TEXT');
  add('certification_body', 'certification_body TEXT');
  add('cycle_no', 'cycle_no INTEGER NOT NULL DEFAULT 1');

  db.exec(`UPDATE iso42001_cert_cycle_events SET event_key = CASE
      WHEN lower(event_type) IN ('stage1','stage 1 audit') THEN 'stage1'
      WHEN lower(event_type) IN ('stage2','stage 2 audit') THEN 'stage2'
      WHEN lower(event_type) IN ('surv1','surveillance audit (year 1)') THEN 'surv1'
      WHEN lower(event_type) IN ('surv2','surveillance audit (year 2)') THEN 'surv2'
      WHEN lower(event_type) IN ('recert','recertification audit') THEN 'recert'
      WHEN lower(event_type) IN ('internal','internal audit') THEN 'internal'
      WHEN lower(event_type) IN ('mrm','management review') THEN 'mrm'
      ELSE 'other' END
    WHERE event_key IS NULL`);

  for (const [key, label, column] of [['stage1', 'Stage 1 audit', 'stage1_date'], ['stage2', 'Stage 2 audit', 'stage2_date']]) {
    db.exec(`INSERT INTO iso42001_cert_cycle_events (workspace_id, event_type, event_key, planned_date, status, certification_body, cycle_no)
      SELECT p.workspace_id, '${label}', '${key}', p.${column}, 'planned', p.certification_body, 1
      FROM aims_audit_programmes p
      WHERE p.${column} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM iso42001_cert_cycle_events e WHERE e.workspace_id = p.workspace_id AND e.event_key = '${key}')`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_iso42001_ccev_cycle ON iso42001_cert_cycle_events(workspace_id, cycle_no, event_key)`);
};
