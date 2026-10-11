'use strict';
// 082: what an AI management system needs from the shared incident and
// change registers (lib/aims-operations.js).
//
//  - incidents.notify_who: who must be told about the incident (A.8.4): the
//    users of the AI system, customers, authorities. The deadline and the
//    time they were told use the existing notification_required_by and
//    notification_sent_at columns.
//  - changes.significant: 1 when a change to an AI system is significant,
//    0 when it is judged not to be, NULL until judged. A significant change,
//    or one not yet judged, means the system's impact assessment and the AI
//    risk assessment are done again (clauses 8.2, 8.4).
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  if (!hasColumn(db, 'incidents', 'notify_who')) db.exec('ALTER TABLE incidents ADD COLUMN notify_who TEXT');
  if (!hasColumn(db, 'changes', 'significant')) {
    db.exec('ALTER TABLE changes ADD COLUMN significant INTEGER CHECK (significant IN (0, 1))');
  }
};
