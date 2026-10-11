'use strict';
// 080: the answers behind the organisation's role for each AI system.
//
// Clause 4.1 asks the organisation to determine its roles with respect to its
// AI systems, and those roles decide which controls apply and how far. The
// register recorded the roles as ticked boxes; the module now asks plain
// questions per system (lib/ai-roles.js) and derives the roles from them, so a
// user that starts training or fine-tuning a model, or connecting it to its own
// data, shows up as its producer.
//
//  - ai_systems.role_answers: JSON object of question key -> 'yes' | 'no'. A
//    question not yet answered is absent. NULL until the questions are first
//    answered; roles ticked before this migration stay in org_roles.
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  if (!hasColumn(db, 'ai_systems', 'role_answers')) {
    db.exec('ALTER TABLE ai_systems ADD COLUMN role_answers TEXT');
  }
};
