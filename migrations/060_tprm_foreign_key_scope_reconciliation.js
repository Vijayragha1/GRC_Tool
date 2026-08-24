'use strict';

// Forward validation for databases that applied the earlier 054/055 bytes.
// Those migrations historically treated unrelated legacy foreign-key orphans
// as TPRM failures. The corrected migrations preserve such records but still
// fail closed on every foreign-key violation whose child or parent is TPRM.
// This successor changes no business data or schema beyond its migration-ledger
// row; it gives already-migrated databases an audited forward reconciliation.

function isTprmForeignKeyViolation(violation) {
  return String(violation.table || '').startsWith('tprm_')
    || String(violation.parent || '').startsWith('tprm_');
}

function up(db) {
  const tprmViolations = db.prepare('PRAGMA foreign_key_check').all()
    .filter(isTprmForeignKeyViolation);
  if (tprmViolations.length) {
    throw new Error(`TPRM foreign-key scope reconciliation refused ${tprmViolations.length} TPRM violation(s)`);
  }

  const quickCheck = db.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') {
    throw new Error(`TPRM foreign-key scope reconciliation integrity check failed: ${quickCheck}`);
  }
}

module.exports = { up };
