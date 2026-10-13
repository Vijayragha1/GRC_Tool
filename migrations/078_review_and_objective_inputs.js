'use strict';
// 078: two inputs the management system records were missing.
//
//  - mrms.interested_party_changes: changes in what interested parties need
//    and expect, an input to management review in its own right (clause
//    9.3.2 c) in ISO/IEC 42001 and in ISO/IEC 27001:2022). Until now it could
//    only be folded into the context changes or the feedback field.
//  - security_objectives.ai_topic: the topic an AI objective serves, such as
//    fairness or robustness, from the product's list of AI objective topics
//    (data/iso42001-objective-topics.js), so a client's AI objectives can be
//    seen against the areas the standard's annex suggests.
// Columns are added only where missing.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  if (!hasColumn(db, 'mrms', 'interested_party_changes')) db.exec('ALTER TABLE mrms ADD COLUMN interested_party_changes TEXT');
  if (!hasColumn(db, 'security_objectives', 'ai_topic')) db.exec('ALTER TABLE security_objectives ADD COLUMN ai_topic TEXT');
};
