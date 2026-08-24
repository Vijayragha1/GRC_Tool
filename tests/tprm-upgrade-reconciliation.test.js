'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');

const UPGRADE_MIGRATION = '054_tprm_upgrade_reconciliation.js';
const EXACT_MIGRATION = '055_tprm_exact_schema_reconciliation.js';
const FK_SCOPE_MIGRATION = '060_tprm_foreign_key_scope_reconciliation.js';
const TARGETS = [
  'tprm_legal_entities',
  'tprm_service_relationships',
  'tprm_conditions',
  'tprm_monitoring_connectors',
];

function bootClosedDatabase() {
  const { dbPath } = bootApp();
  require('../db').db.close();
  return dbPath;
}

function seedCanonicalRows(db) {
  const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const manager = db.prepare("SELECT id FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY id LIMIT 1").get(firm.id);
  const consultantId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('migration-consultant@example.invalid','!test','Migration Consultant','firm',?,'consultant',1)`)
    .run(firm.id).lastInsertRowid);
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,scope,engagement_outcome) VALUES (?,?,?,'gap_assessment_only')`)
    .run(firm.id, 'Migration Client', 'TPRM exact reconciliation').lastInsertRowid);
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,status)
    VALUES (?,?,'Hosted service','intake','active')`)
    .run(workspaceId, 'Migration Supplier').lastInsertRowid);
  const moduleId = Number(db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason,created_by,classified_by,classified_at)
    VALUES (?,'managed_lifecycle','active','Migration reconciliation fixture',?,?,datetime('now'))`)
    .run(workspaceId, manager.id, manager.id).lastInsertRowid);
  const cycleId = Number(db.prepare(`INSERT INTO tprm_assessment_cycles
    (workspace_id,supplier_id,module_id,cycle_number,cycle_type,status,trigger_reason,started_by)
    VALUES (?,?,?,1,'onboarding','active','Migration reconciliation fixture',?)`)
    .run(workspaceId, supplierId, moduleId, consultantId).lastInsertRowid);
  const recommendationId = Number(db.prepare(`INSERT INTO tprm_recommendations
    (workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,
     residual_risk_score,residual_risk_band,readiness_snapshot_json,artifact_snapshot_json,
     recommendation_hash,issued_by,issuer_name,quality_reviewed_by,quality_reviewer_name,
     quality_review_rationale)
    VALUES (?,?,?,1,'recommend_with_conditions',?,?,42,'moderate','{}','{}',?,?,?,?,?,?)`)
    .run(
      workspaceId, supplierId, cycleId,
      'Controlled migration recommendation', 'Exact fixture rationale', 'a'.repeat(64),
      consultantId, 'Migration Consultant', manager.id, 'Migration Manager',
      'Independent quality review completed for the migration fixture.',
    ).lastInsertRowid);
  const conditionId = Number(db.prepare(`INSERT INTO tprm_conditions
    (workspace_id,supplier_id,cycle_id,source_type,recommendation_id,condition_type,
     title,description,severity,owner_type,owner_user_id,owner_name,due_date,
     verification_criteria,created_by)
    VALUES (?,?,?,'recommendation',?,'control',?,?,'moderate','consultancy',?,?,
      date('now','+30 days'),?,?)`)
    .run(
      workspaceId, supplierId, cycleId, recommendationId,
      'Migration condition', 'Condition row must survive exact schema repair.',
      consultantId, 'Migration Consultant', 'Verify the controlled migration evidence.', consultantId,
    ).lastInsertRowid);
  const conditionEventId = Number(db.prepare(`INSERT INTO tprm_condition_events
    (workspace_id,supplier_id,cycle_id,condition_id,event_type,from_status,to_status,
     review_note,waiver_expires_at,actor_user_id,actor_type,actor_name,
     expected_row_version,resulting_row_version,request_fingerprint,event_hash)
    VALUES (?,?,?,?,'waived','open','waived',?,date('now','+30 days'),?,
      'consultancy_manager',?,1,2,?,?)`)
    .run(
      workspaceId, supplierId, cycleId, conditionId,
      'Controlled waiver event retained for migration child-link testing.',
      manager.id, 'Migration Manager',
      'c'.repeat(64), 'd'.repeat(64),
    ).lastInsertRowid);
  const legalEntityId = Number(db.prepare(`INSERT INTO tprm_legal_entities
    (workspace_id,supplier_id,legal_name,status,identity_source,created_by)
    VALUES (?,?,?,'active','user_maintained',?)`)
    .run(workspaceId, supplierId, 'M', consultantId).lastInsertRowid);
  const relationshipId = Number(db.prepare(`INSERT INTO tprm_service_relationships
    (workspace_id,supplier_id,legal_entity_id,relationship_key,relationship_name,
     service_description,status,criticality,data_access,source,is_primary,created_by)
    VALUES (?,?,?,'migration-service','R','S','intake','moderate','internal',
      'user_maintained',1,?)`)
    .run(workspaceId, supplierId, legalEntityId, consultantId).lastInsertRowid);
  const connectorId = Number(db.prepare(`INSERT INTO tprm_monitoring_connectors
    (workspace_id,module_id,provider_type,capability_mode,name,ingress_key,status,
     adapter_config_json,failure_mode,external_provisioning_confirmed,created_by)
    VALUES (?,?,'csv_import','csv','Migration Connector',?,'draft','{}','fail_closed',0,?)`)
    .run(workspaceId, moduleId, 'b'.repeat(32), consultantId).lastInsertRowid);
  const runId = Number(db.prepare(`INSERT INTO tprm_monitoring_connector_runs
    (workspace_id,connector_id,run_type,status,received_count,processed_count,
     duplicate_count,quarantined_count,started_at,completed_at)
    VALUES (?,?,'manual','succeeded',1,1,0,0,datetime('now'),datetime('now'))`)
    .run(workspaceId, connectorId).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_monitoring_connector_state
    (workspace_id,connector_id,last_run_id) VALUES (?,?,?)`)
    .run(workspaceId, connectorId, runId);

  return {
    firmId: firm.id,
    managerId: manager.id,
    consultantId,
    workspaceId,
    supplierId,
    moduleId,
    cycleId,
    conditionId,
    conditionEventId,
    legalEntityId,
    relationshipId,
    connectorId,
    runId,
  };
}

function snapshotTables(db) {
  const rows = {};
  const sequences = {};
  for (const table of TARGETS) {
    rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    sequences[table] = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq ?? null;
  }
  return { rows, sequences };
}

function rewriteTableSql(db, table, transform) {
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
  const after = transform(before);
  assert.notEqual(after, before, `${table} fixture rewrite must change its schema SQL`);
  const sqlLiteral = `'${after.replaceAll("'", "''")}'`;
  const tableLiteral = `'${table.replaceAll("'", "''")}'`;
  // better-sqlite3 intentionally blocks prepared UPDATEs against sqlite_master.
  // Keep this test-only legacy-shape fixture in one explicit writable_schema
  // exec block, then force SQLite to reload the altered CREATE TABLE text.
  db.unsafeMode(true);
  try {
    db.exec(`
      PRAGMA writable_schema = 1;
      UPDATE sqlite_master SET sql=${sqlLiteral}
        WHERE type='table' AND name=${tableLiteral};
      PRAGMA writable_schema = 0;
    `);
  } finally {
    db.pragma('writable_schema = OFF');
    db.unsafeMode(false);
  }
}

function reopenAfterSchemaRewrite(db, dbPath) {
  const version = db.pragma('schema_version', { simple: true });
  db.pragma(`schema_version = ${version + 1}`);
  db.pragma('writable_schema = OFF');
  db.close();
  const reopened = new Database(dbPath);
  reopened.pragma('foreign_keys = ON');
  return reopened;
}

function rebuildConnectorAsPost054(db) {
  const table = 'tprm_monitoring_connectors';
  const shadow = `${table}__post054_fixture`;
  const canonicalSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
  const legacySql = canonicalSql
    .replace(`CREATE TABLE ${table}`, `CREATE TABLE ${shadow}`)
    .replace('ingress_key TEXT NOT NULL UNIQUE,', 'ingress_key TEXT,')
    .replace(/\s*CHECK\(length\(ingress_key\)=32 AND ingress_key NOT GLOB '\*\[\^0-9a-f\]\*'\),/, '');
  assert.notEqual(legacySql, canonicalSql, 'connector fixture rewrite must change its schema SQL');

  const columns = db.pragma(`table_info('${table}')`).map(column => `"${column.name}"`).join(',');
  const sequence = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq ?? null;
  const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END,name`).all(table);

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      assert.equal(
        Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(shadow)),
        false,
        'connector fixture shadow must not already exist',
      );
      db.exec(legacySql);
      db.exec(`INSERT INTO "${shadow}" (${columns}) SELECT ${columns} FROM "${table}"`);
      db.exec(`DROP TABLE "${table}"`);
      db.exec(`ALTER TABLE "${shadow}" RENAME TO "${table}"`);
      db.prepare('DELETE FROM sqlite_sequence WHERE name IN (?,?)').run(table, shadow);
      if (sequence !== null) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(table, sequence);
      for (const object of objects) db.exec(object.sql);
      db.exec(`
        CREATE UNIQUE INDEX uq_tprm_monitoring_connector_ingress_key
          ON tprm_monitoring_connectors(ingress_key);
        CREATE TRIGGER trg_tprm_connector_ingress_insert
        BEFORE INSERT ON tprm_monitoring_connectors
        WHEN NEW.ingress_key IS NULL OR length(NEW.ingress_key)<>32 OR NEW.ingress_key GLOB '*[^0-9a-f]*'
        BEGIN SELECT RAISE(ABORT,'TPRM connector ingress key must be 32 lowercase hexadecimal characters'); END;
        CREATE TRIGGER trg_tprm_connector_ingress_update
        BEFORE UPDATE OF ingress_key ON tprm_monitoring_connectors
        WHEN NEW.ingress_key IS NULL OR length(NEW.ingress_key)<>32 OR NEW.ingress_key GLOB '*[^0-9a-f]*'
        BEGIN SELECT RAISE(ABORT,'TPRM connector ingress key must be 32 lowercase hexadecimal characters'); END;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
}

function degradeToPost054Shape(db, dbPath) {
  rebuildConnectorAsPost054(db);
  rewriteTableSql(db, 'tprm_legal_entities', sql =>
    sql.replace('CHECK(length(trim(legal_name))>=1)', 'CHECK(length(trim(legal_name))>=2)'));
  rewriteTableSql(db, 'tprm_service_relationships', sql => sql
    .replace('CHECK(length(trim(relationship_name))>=1)', 'CHECK(length(trim(relationship_name))>=2)')
    .replace('CHECK(length(trim(service_description))>=1)', 'CHECK(length(trim(service_description))>=2)')
    .replace(/\s*CHECK\(alternate_provider_relationship_id IS NULL OR alternate_provider_relationship_id<>id\),/, ''));
  rewriteTableSql(db, 'tprm_conditions', sql => sql
    .replace('finding_id INTEGER,', 'finding_id INTEGER REFERENCES findings(id),')
    .replace(/\s*FOREIGN KEY \(workspace_id,finding_id\) REFERENCES findings\(workspace_id,id\),/, ''));
  db.exec('DROP INDEX IF EXISTS uq_findings_workspace_id');
  return reopenAfterSchemaRewrite(db, dbPath);
}

function deleteExactMigrationLedger(db) {
  db.prepare('DELETE FROM schema_migrations WHERE id=?').run(EXACT_MIGRATION);
}

function deleteForeignKeyReconciliationLedger(db) {
  db.prepare('DELETE FROM schema_migrations WHERE id IN (?,?,?)')
    .run(UPGRADE_MIGRATION, EXACT_MIGRATION, FK_SCOPE_MIGRATION);
}

function assertCanonicalSchema(db) {
  const legal = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tprm_legal_entities'").get().sql;
  const relationships = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tprm_service_relationships'").get().sql;
  const conditions = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tprm_conditions'").get().sql;
  const connectors = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tprm_monitoring_connectors'").get().sql;
  assert.match(legal, /CHECK\(length\(trim\(legal_name\)\)>=1\)/);
  assert.match(relationships, /CHECK\(length\(trim\(relationship_name\)\)>=1\)/);
  assert.match(relationships, /alternate_provider_relationship_id IS NULL OR alternate_provider_relationship_id<>id/);
  assert.match(conditions, /FOREIGN KEY \(workspace_id,finding_id\) REFERENCES findings\(workspace_id,id\)/);
  assert.match(connectors, /ingress_key TEXT NOT NULL UNIQUE/);
  assert.match(connectors, /length\(ingress_key\)=32/);

  const findingIndex = db.prepare(`SELECT "unique" AS is_unique
    FROM pragma_index_list('findings') WHERE name='uq_findings_workspace_id'`).get();
  assert.equal(findingIndex.is_unique, 1);
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_index_info('uq_findings_workspace_id') ORDER BY seqno").all(),
    [{ name: 'workspace_id' }, { name: 'id' }],
  );

  const ingressColumn = db.prepare(`SELECT "notnull" AS required
    FROM pragma_table_info('tprm_monitoring_connectors') WHERE name='ingress_key'`).get();
  assert.equal(ingressColumn.required, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN (
    'uq_tprm_monitoring_connector_ingress_key',
    'trg_tprm_connector_ingress_insert',
    'trg_tprm_connector_ingress_update'
  )`).get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE '%__055_rebuild'").get().count, 0);
}

test('055 canonically rebuilds post-054 tables without changing rows, ids, sequences, or child links', () => {
  const dbPath = bootClosedDatabase();
  let db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const ids = seedCanonicalRows(db);

  for (const table of TARGETS) {
    db.prepare('UPDATE sqlite_sequence SET seq=seq+100 WHERE name=?').run(table);
  }
  const before = snapshotTables(db);
  db = degradeToPost054Shape(db, dbPath);
  assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_findings_workspace_id'").get()), false);
  deleteExactMigrationLedger(db);

  const runner = require('../migrations/run');
  const first = runner.applyPending(db);
  const second = runner.applyPending(db);
  assert.equal(first.applied, 1);
  assert.equal(second.applied, 0);
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(EXACT_MIGRATION));

  const after = snapshotTables(db);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.sequences, before.sequences);
  assert.deepEqual(
    db.prepare('SELECT workspace_id,connector_id,last_run_id FROM tprm_monitoring_connector_state').get(),
    { workspace_id: ids.workspaceId, connector_id: ids.connectorId, last_run_id: ids.runId },
  );
  assert.deepEqual(
    db.prepare('SELECT workspace_id,condition_id FROM tprm_condition_events WHERE id=?').get(ids.conditionEventId),
    { workspace_id: ids.workspaceId, condition_id: ids.conditionId },
  );
  assertCanonicalSchema(db);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('055 is a schema no-op on fresh canonical tables', () => {
  const dbPath = bootClosedDatabase();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  seedCanonicalRows(db);
  const before = snapshotTables(db);
  deleteExactMigrationLedger(db);
  const first = require('../migrations/run').applyPending(db);
  assert.equal(first.applied, 1);
  assert.deepEqual(snapshotTables(db), before);
  assertCanonicalSchema(db);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});

test('055 fails closed without deleting a stale migration shadow', () => {
  const dbPath = bootClosedDatabase();
  const db = new Database(dbPath);
  db.exec('CREATE TABLE tprm_legal_entities__055_rebuild (sentinel TEXT)');
  db.prepare("INSERT INTO tprm_legal_entities__055_rebuild VALUES ('preserve me')").run();
  deleteExactMigrationLedger(db);

  assert.throws(() => require('../migrations/run').applyPending(db), /stale TPRM migration shadow exists/);
  assert.equal(db.prepare('SELECT sentinel FROM tprm_legal_entities__055_rebuild').get().sentinel, 'preserve me');
  assert.equal(Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(EXACT_MIGRATION)), false);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('055 rejects self-alternates and corrupted AUTOINCREMENT state before rebuilding', () => {
  const selfPath = bootClosedDatabase();
  const selfDb = new Database(selfPath);
  selfDb.pragma('foreign_keys = ON');
  const ids = seedCanonicalRows(selfDb);
  selfDb.pragma('ignore_check_constraints = ON');
  selfDb.prepare(`UPDATE tprm_service_relationships
    SET alternate_provider_relationship_id=id,row_version=row_version+1,updated_by=? WHERE id=?`)
    .run(ids.consultantId, ids.relationshipId);
  selfDb.pragma('ignore_check_constraints = OFF');
  deleteExactMigrationLedger(selfDb);
  assert.throws(() => require('../migrations/run').applyPending(selfDb), /cannot be its own alternate provider/);
  assert.equal(Boolean(selfDb.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(EXACT_MIGRATION)), false);
  selfDb.close();

  const sequencePath = bootClosedDatabase();
  const sequenceDb = new Database(sequencePath);
  sequenceDb.pragma('foreign_keys = ON');
  seedCanonicalRows(sequenceDb);
  sequenceDb.prepare("UPDATE sqlite_sequence SET seq=0 WHERE name='tprm_conditions'").run();
  deleteExactMigrationLedger(sequenceDb);
  assert.throws(() => require('../migrations/run').applyPending(sequenceDb), /sequence 0 is below max id/);
  assert.equal(Boolean(sequenceDb.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(EXACT_MIGRATION)), false);
  sequenceDb.close();
});

test('055 rejects a condition finding from another client workspace', () => {
  const dbPath = bootClosedDatabase();
  let db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const ids = seedCanonicalRows(db);
  const otherWorkspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,scope,engagement_outcome) VALUES (?,?,?,'gap_assessment_only')`)
    .run(ids.firmId, 'Other Client', 'Separate tenant').lastInsertRowid);
  const findingId = Number(db.prepare(`INSERT INTO findings
    (workspace_id,source_type,title,severity,created_by)
    VALUES (?,'manual','Other tenant finding','medium',?)`)
    .run(otherWorkspaceId, ids.managerId).lastInsertRowid);

  rewriteTableSql(db, 'tprm_conditions', sql => sql
    .replace('finding_id INTEGER,', 'finding_id INTEGER REFERENCES findings(id),')
    .replace(/\s*FOREIGN KEY \(workspace_id,finding_id\) REFERENCES findings\(workspace_id,id\),/, ''));
  db = reopenAfterSchemaRewrite(db, dbPath);
  db.exec('DROP TRIGGER trg_tprm_condition_definition_immutable');
  db.prepare('UPDATE tprm_conditions SET finding_id=? WHERE id=?').run(findingId, ids.conditionId);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'legacy single-column FK permits the corrupt tenant link');
  deleteExactMigrationLedger(db);

  assert.throws(() => require('../migrations/run').applyPending(db), /condition finding is outside its client workspace/);
  assert.equal(Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(EXACT_MIGRATION)), false);
  db.close();
});

test('054/055 preserve unchanged production-like foreign-key orphans outside TPRM', () => {
  const dbPath = bootClosedDatabase();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  const insertLegacyResponse = db.prepare(`INSERT INTO supplier_questionnaire_responses
    (questionnaire_id,question_id,answer) VALUES (?,?,?)`);
  for (let index = 0; index < 6; index++) {
    insertLegacyResponse.run(900000 + index, index + 1, `Preserved legacy response ${index + 1}`);
  }
  db.pragma('foreign_keys = ON');

  const before = db.prepare(`SELECT id,questionnaire_id,question_id,answer
    FROM supplier_questionnaire_responses WHERE questionnaire_id>=900000 ORDER BY id`).all();
  const violationsBefore = db.prepare('PRAGMA foreign_key_check').all()
    .filter(row => row.table === 'supplier_questionnaire_responses');
  assert.equal(violationsBefore.length, 6);

  deleteForeignKeyReconciliationLedger(db);
  const result = require('../migrations/run').applyPending(db);
  assert.equal(result.applied, 3);
  assert.deepEqual(
    db.prepare(`SELECT id,questionnaire_id,question_id,answer
      FROM supplier_questionnaire_responses WHERE questionnaire_id>=900000 ORDER BY id`).all(),
    before,
  );
  assert.deepEqual(
    db.prepare('PRAGMA foreign_key_check').all()
      .filter(row => row.table === 'supplier_questionnaire_responses'),
    violationsBefore,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id IN (?,?,?)`)
      .get(UPGRADE_MIGRATION, EXACT_MIGRATION, FK_SCOPE_MIGRATION).count,
    3,
  );
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('054 still fails closed on a pre-existing TPRM foreign-key violation', () => {
  const dbPath = bootClosedDatabase();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO tprm_modules
    (workspace_id,service_model,status,activation_reason)
    VALUES (987654321,NULL,'needs_classification','Intentional test-only orphan')`).run();
  db.pragma('foreign_keys = ON');
  deleteForeignKeyReconciliationLedger(db);

  assert.throws(
    () => require('../migrations/run').applyPending(db),
    /refused 1 pre-existing TPRM foreign-key violation/,
  );
  assert.equal(Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(UPGRADE_MIGRATION)), false);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().some(row => row.table === 'tprm_modules'), true);
  db.close();
});

test('the runner accepts only audited 054/055 hashes through the 060 successor', () => {
  const dbPath = bootClosedDatabase();
  const db = new Database(dbPath);
  const runner = require('../migrations/run');
  const historicUpgradeHashes = [
    '9ce929a79ea0d25ef9732ee3077199d3588ecaa09cc99e037be66f278e7229d5',
    '40a05fbce451be761aaadd65d8a57513938d5113eaba179cec373a1daecc051a',
  ];
  const historicExactHash = '636205b23b077ee9e0899c5ab3b78853e38491b9649a4f1d14e9f188582f5ff6';

  db.prepare('UPDATE schema_migrations SET checksum=? WHERE id=?')
    .run(historicExactHash, EXACT_MIGRATION);
  for (const historicUpgradeHash of historicUpgradeHashes) {
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE id=?')
      .run(historicUpgradeHash, UPGRADE_MIGRATION);
    db.prepare('DELETE FROM schema_migrations WHERE id=?').run(FK_SCOPE_MIGRATION);
    assert.equal(runner.applyPending(db).applied, 1);
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(FK_SCOPE_MIGRATION));
  }

  db.prepare('UPDATE schema_migrations SET checksum=? WHERE id=?')
    .run('f'.repeat(64), UPGRADE_MIGRATION);
  db.prepare('DELETE FROM schema_migrations WHERE id=?').run(FK_SCOPE_MIGRATION);
  assert.throws(() => runner.applyPending(db), /Migration checksum drift: 054_tprm_upgrade_reconciliation\.js/);
  assert.equal(Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(FK_SCOPE_MIGRATION)), false);
  db.close();
});

test('the runner records only exact audited pre-release checksum pairs as reconciled', () => {
  const { RECONCILED_DRIFTS } = require('../migrations/run');
  assert.deepEqual(Object.keys(RECONCILED_DRIFTS).sort(), [
    '046_tprm_domain_foundation.sql',
    '047_tprm_relationships_concentration.sql',
    '048_tprm_monitoring_connectors.sql',
    '050_tprm_condition_governance.sql',
    '054_tprm_upgrade_reconciliation.js',
    '055_tprm_exact_schema_reconciliation.js',
  ]);
  for (const [migration, entry] of Object.entries(RECONCILED_DRIFTS)) {
    const appliedChecksums = Array.isArray(entry.applied) ? entry.applied : [entry.applied];
    assert.ok(appliedChecksums.length >= 1);
    for (const appliedChecksum of appliedChecksums) assert.match(appliedChecksum, /^[a-f0-9]{64}$/);
    assert.match(entry.current, /^[a-f0-9]{64}$/);
    assert.equal(
      entry.reconciledBy,
      ['054_tprm_upgrade_reconciliation.js', '055_tprm_exact_schema_reconciliation.js'].includes(migration)
        ? '060_tprm_foreign_key_scope_reconciliation.js'
        : '054_tprm_upgrade_reconciliation.js',
    );
  }
});
