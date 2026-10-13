'use strict';
// 081: the AI system register asks what each role needs to know.
//
// What the organisation does with a system (lib/ai-roles.js) decides what the
// register should hold about it. A system bought from a supplier needs the
// product, the supplier's terms and its guidance on intended use; a system
// staff use needs the rules for using it; a system the organisation builds or
// trains needs its version and how it was last checked; a system offered to
// others needs where its users are informed, how incidents reach them and
// what was agreed with customers.
//
//  - supplied_product, supplier_terms, supplier_guidance   bought (A.10.3, A.9.4)
//  - use_rules                                              used (A.9.2, A.9.4)
//  - model_version, validated_on, release_check             built or trained (A.6.2.4, A.6.2.5)
//  - offered_to, user_information, incident_route,
//    customer_terms                                         offered (A.8.2, A.8.4, A.10.4)
//  - partner_work                                           partner (A.10.2)
// Columns are added only where missing.

const COLUMNS = ['supplied_product', 'supplier_terms', 'supplier_guidance', 'use_rules', 'model_version', 'validated_on',
  'release_check', 'offered_to', 'user_information', 'incident_route', 'customer_terms', 'partner_work'];

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

exports.up = function up(db) {
  for (const column of COLUMNS) {
    if (!hasColumn(db, 'ai_systems', column)) db.exec(`ALTER TABLE ai_systems ADD COLUMN ${column} TEXT`);
  }
};
