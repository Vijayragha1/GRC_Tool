'use strict';

// Canonical, forward-only reconciliation for databases that applied an early
// shape of the TPRM hardening migrations. Migration 054 deliberately repaired
// the immediately required capabilities in place. This successor closes the
// remaining schema-boundary differences without rewriting any business fact.
//
// The migration runner executes this file with foreign_keys=OFF *before* it
// opens the transaction. Every inbound reference is checked before commit and
// the runner restores foreign_keys afterwards.

const TARGETS = Object.freeze([
  'tprm_legal_entities',
  'tprm_service_relationships',
  'tprm_conditions',
  'tprm_monitoring_connectors',
]);

const SHADOW_SUFFIX = '__055_rebuild';

function foreignKeyViolationSignature(violation) {
  return JSON.stringify([
    String(violation.table || ''),
    violation.rowid == null ? null : Number(violation.rowid),
    String(violation.parent || ''),
    violation.fkid == null ? null : Number(violation.fkid),
  ]);
}

function isTprmForeignKeyViolation(violation) {
  return String(violation.table || '').startsWith('tprm_')
    || String(violation.parent || '').startsWith('tprm_');
}

function readForeignKeyViolations(db) {
  return db.prepare('PRAGMA foreign_key_check').all();
}

function assertNoPreExistingTprmViolations(violations) {
  const tprmViolations = violations.filter(isTprmForeignKeyViolation);
  if (tprmViolations.length) {
    throw new Error(`TPRM exact reconciliation refused ${tprmViolations.length} pre-existing TPRM foreign-key violation(s)`);
  }
}

function assertNoForeignKeyRegression(db, before) {
  const baseline = new Map();
  for (const violation of before) {
    const signature = foreignKeyViolationSignature(violation);
    baseline.set(signature, (baseline.get(signature) || 0) + 1);
  }
  const after = readForeignKeyViolations(db);
  const tprmViolations = after.filter(isTprmForeignKeyViolation);
  if (tprmViolations.length) {
    throw new Error(`TPRM exact reconciliation produced ${tprmViolations.length} TPRM foreign-key violation(s)`);
  }

  const introduced = after.filter(violation => {
    const signature = foreignKeyViolationSignature(violation);
    const remaining = baseline.get(signature) || 0;
    if (!remaining) return true;
    baseline.set(signature, remaining - 1);
    return false;
  });
  if (introduced.length) {
    throw new Error(`TPRM exact reconciliation produced ${introduced.length} new foreign-key violation(s) outside TPRM`);
  }
}

const CANONICAL_COLUMNS = Object.freeze({
  tprm_legal_entities: Object.freeze([
    'id', 'workspace_id', 'supplier_id', 'legal_name', 'trading_name',
    'entity_type', 'registration_number', 'registration_country_code', 'lei',
    'parent_entity_name', 'ultimate_parent_name', 'status', 'identity_source',
    'identity_verified_at', 'identity_verified_by', 'created_by', 'created_at',
    'updated_by', 'updated_at', 'row_version',
  ]),
  tprm_service_relationships: Object.freeze([
    'id', 'workspace_id', 'supplier_id', 'legal_entity_id', 'relationship_key',
    'relationship_name', 'service_category', 'service_description',
    'provision_model', 'status', 'criticality', 'data_access',
    'privileged_access', 'annual_spend_minor', 'currency', 'relationship_owner',
    'business_owner', 'security_owner', 'procurement_owner', 'start_date',
    'target_end_date', 'rto_hours', 'rpo_hours',
    'max_tolerable_disruption_hours', 'substitutability',
    'alternate_provider_relationship_id', 'estimated_exit_days',
    'exit_plan_status', 'last_exit_tested_at', 'exit_owner', 'exit_strategy',
    'transition_assistance', 'data_return_deletion_requirements', 'sole_source',
    'material_outsourcing', 'regulated_service', 'legacy_annual_spend_text',
    'legacy_location_text', 'legacy_hosting_locations_text',
    'legacy_data_categories_text', 'legacy_critical_processes_text', 'source',
    'is_primary', 'idempotency_key', 'request_fingerprint', 'created_by',
    'created_at', 'updated_by', 'updated_at', 'row_version',
    'offboarding_started_at', 'terminated_at',
  ]),
  tprm_conditions: Object.freeze([
    'id', 'workspace_id', 'supplier_id', 'cycle_id', 'source_type',
    'recommendation_id', 'client_decision_id', 'finding_id', 'condition_type',
    'title', 'description', 'severity', 'owner_type', 'owner_user_id',
    'owner_name', 'due_date', 'verification_criteria', 'status',
    'evidence_summary', 'completion_note', 'completed_at', 'completed_by',
    'verified_at', 'verified_by', 'waiver_rationale', 'waiver_expires_at',
    'created_by', 'created_at', 'updated_at', 'row_version',
  ]),
  tprm_monitoring_connectors: Object.freeze([
    'id', 'workspace_id', 'module_id', 'provider_type', 'capability_mode', 'name',
    'ingress_key', 'status', 'secret_reference', 'adapter_config_json',
    'failure_mode', 'external_provisioning_confirmed', 'created_by', 'created_at',
    'updated_by', 'updated_at', 'row_version',
  ]),
});

const CANONICAL_MARKERS = Object.freeze({
  tprm_legal_entities: Object.freeze([
    'CHECK(length(trim(legal_name))>=1)',
  ]),
  tprm_service_relationships: Object.freeze([
    'CHECK(length(trim(relationship_name))>=1)',
    'CHECK(length(trim(service_description))>=1)',
    'CHECK(alternate_provider_relationship_id IS NULL OR alternate_provider_relationship_id<>id)',
  ]),
  tprm_conditions: Object.freeze([
    'finding_id INTEGER',
    'FOREIGN KEY (workspace_id,finding_id) REFERENCES findings(workspace_id,id)',
  ]),
  tprm_monitoring_connectors: Object.freeze([
    'ingress_key TEXT NOT NULL UNIQUE',
    "CHECK(length(ingress_key)=32 AND ingress_key NOT GLOB '*[^0-9a-f]*')",
  ]),
});

const CANONICAL_TABLE_SQL = Object.freeze({
  tprm_legal_entities: `CREATE TABLE __TABLE__ (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    supplier_id INTEGER NOT NULL,
    legal_name TEXT NOT NULL,
    trading_name TEXT,
    entity_type TEXT NOT NULL DEFAULT 'unknown'
      CHECK(entity_type IN ('corporation','partnership','government','nonprofit','sole_trader','unknown')),
    registration_number TEXT,
    registration_country_code TEXT,
    lei TEXT,
    parent_entity_name TEXT,
    ultimate_parent_name TEXT,
    status TEXT NOT NULL DEFAULT 'unknown'
      CHECK(status IN ('active','inactive','merged','dissolved','unknown')),
    identity_source TEXT NOT NULL DEFAULT 'user_maintained'
      CHECK(identity_source IN ('legacy_supplier_backfill','user_maintained','verified_document')),
    identity_verified_at TEXT,
    identity_verified_by INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
    UNIQUE(workspace_id,supplier_id),
    UNIQUE(workspace_id,id),
    UNIQUE(workspace_id,supplier_id,id),
    FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
    CHECK(length(trim(legal_name))>=1),
    CHECK(registration_country_code IS NULL OR (
      length(registration_country_code)=2
      AND registration_country_code=upper(registration_country_code)
      AND registration_country_code NOT GLOB '*[^A-Z]*'
    )),
    CHECK(lei IS NULL OR (length(lei)=20 AND lei=upper(lei) AND lei NOT GLOB '*[^A-Z0-9]*')),
    CHECK((identity_verified_at IS NULL AND identity_verified_by IS NULL)
       OR (identity_verified_at IS NOT NULL AND identity_verified_by IS NOT NULL))
  )`,

  tprm_service_relationships: `CREATE TABLE __TABLE__ (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    supplier_id INTEGER NOT NULL,
    legal_entity_id INTEGER NOT NULL,
    relationship_key TEXT NOT NULL,
    relationship_name TEXT NOT NULL,
    service_category TEXT,
    service_description TEXT NOT NULL,
    provision_model TEXT NOT NULL DEFAULT 'other'
      CHECK(provision_model IN ('saas','paas','iaas','managed_service','professional_service','data_provider','physical_service','other')),
    status TEXT NOT NULL DEFAULT 'intake'
      CHECK(status IN ('intake','active','suspended','offboarding','terminated','rejected')),
    criticality TEXT NOT NULL DEFAULT 'unknown'
      CHECK(criticality IN ('low','moderate','high','critical','unknown')),
    data_access TEXT NOT NULL DEFAULT 'unknown'
      CHECK(data_access IN ('none','internal','confidential','restricted','mixed','unknown')),
    privileged_access INTEGER NOT NULL DEFAULT 0 CHECK(privileged_access IN (0,1)),
    annual_spend_minor INTEGER CHECK(annual_spend_minor IS NULL OR annual_spend_minor>=0),
    currency TEXT,
    relationship_owner TEXT,
    business_owner TEXT,
    security_owner TEXT,
    procurement_owner TEXT,
    start_date TEXT,
    target_end_date TEXT,
    rto_hours INTEGER CHECK(rto_hours IS NULL OR rto_hours>=0),
    rpo_hours INTEGER CHECK(rpo_hours IS NULL OR rpo_hours>=0),
    max_tolerable_disruption_hours INTEGER
      CHECK(max_tolerable_disruption_hours IS NULL OR max_tolerable_disruption_hours>=0),
    substitutability TEXT NOT NULL DEFAULT 'unknown'
      CHECK(substitutability IN ('readily_substitutable','substitutable_with_effort','difficult','not_substitutable','unknown')),
    alternate_provider_relationship_id INTEGER,
    estimated_exit_days INTEGER CHECK(estimated_exit_days IS NULL OR estimated_exit_days>=0),
    exit_plan_status TEXT NOT NULL DEFAULT 'not_started'
      CHECK(exit_plan_status IN ('not_started','documented','tested','needs_update','not_applicable')),
    last_exit_tested_at TEXT,
    exit_owner TEXT,
    exit_strategy TEXT,
    transition_assistance TEXT,
    data_return_deletion_requirements TEXT,
    sole_source INTEGER NOT NULL DEFAULT 0 CHECK(sole_source IN (0,1)),
    material_outsourcing INTEGER NOT NULL DEFAULT 0 CHECK(material_outsourcing IN (0,1)),
    regulated_service INTEGER NOT NULL DEFAULT 0 CHECK(regulated_service IN (0,1)),
    legacy_annual_spend_text TEXT,
    legacy_location_text TEXT,
    legacy_hosting_locations_text TEXT,
    legacy_data_categories_text TEXT,
    legacy_critical_processes_text TEXT,
    source TEXT NOT NULL DEFAULT 'user_maintained'
      CHECK(source IN ('legacy_supplier_backfill','user_maintained','import')),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
    idempotency_key TEXT,
    request_fingerprint TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
    offboarding_started_at TEXT,
    terminated_at TEXT,
    UNIQUE(workspace_id,relationship_key),
    UNIQUE(workspace_id,id),
    UNIQUE(workspace_id,supplier_id,id),
    UNIQUE(workspace_id,idempotency_key),
    FOREIGN KEY(workspace_id,supplier_id,legal_entity_id)
      REFERENCES tprm_legal_entities(workspace_id,supplier_id,id),
    FOREIGN KEY(workspace_id,alternate_provider_relationship_id)
      REFERENCES tprm_service_relationships(workspace_id,id),
    CHECK(length(trim(relationship_key)) BETWEEN 3 AND 100),
    CHECK(length(trim(relationship_name))>=1),
    CHECK(length(trim(service_description))>=1),
    CHECK(currency IS NULL OR (
      length(currency)=3 AND currency=upper(currency) AND currency NOT GLOB '*[^A-Z]*'
    )),
    CHECK(annual_spend_minor IS NULL OR currency IS NOT NULL),
    CHECK(alternate_provider_relationship_id IS NULL OR alternate_provider_relationship_id<>id),
    CHECK(start_date IS NULL OR length(start_date)=10),
    CHECK(target_end_date IS NULL OR length(target_end_date)=10),
    CHECK(request_fingerprint IS NULL OR (
      length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    )),
    CHECK(idempotency_key IS NULL OR (
      length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
    )),
    CHECK((status='offboarding')=(offboarding_started_at IS NOT NULL) OR status='terminated'),
    CHECK((status='terminated')=(terminated_at IS NOT NULL))
  )`,

  tprm_conditions: `CREATE TABLE __TABLE__ (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    supplier_id INTEGER NOT NULL,
    cycle_id INTEGER NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('recommendation','client_decision')),
    recommendation_id INTEGER,
    client_decision_id INTEGER,
    finding_id INTEGER,
    condition_type TEXT NOT NULL CHECK(condition_type IN ('remediation','control','contract','evidence','monitoring','risk_acceptance','other')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('low','moderate','high','critical')),
    owner_type TEXT NOT NULL CHECK(owner_type IN ('client','third_party','consultancy')),
    owner_user_id INTEGER REFERENCES users(id),
    owner_name TEXT NOT NULL,
    due_date TEXT NOT NULL,
    verification_criteria TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','evidence_submitted','verified','waived','cancelled')),
    evidence_summary TEXT,
    completion_note TEXT,
    completed_at TEXT,
    completed_by INTEGER REFERENCES users(id),
    verified_at TEXT,
    verified_by INTEGER REFERENCES users(id),
    waiver_rationale TEXT,
    waiver_expires_at TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(workspace_id,supplier_id,id),
    FOREIGN KEY (workspace_id,supplier_id,cycle_id)
      REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
    FOREIGN KEY (workspace_id,supplier_id,cycle_id,recommendation_id)
      REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
    FOREIGN KEY (workspace_id,supplier_id,client_decision_id)
      REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
    FOREIGN KEY (workspace_id,finding_id) REFERENCES findings(workspace_id,id),
    CHECK(
      (source_type='recommendation' AND recommendation_id IS NOT NULL AND client_decision_id IS NULL)
      OR (source_type='client_decision' AND recommendation_id IS NULL AND client_decision_id IS NOT NULL)
    ),
    CHECK(status!='verified' OR (verified_at IS NOT NULL AND verified_by IS NOT NULL AND length(trim(COALESCE(completion_note,'')))>=5)),
    CHECK(status!='waived' OR (length(trim(COALESCE(waiver_rationale,'')))>=10 AND waiver_expires_at IS NOT NULL))
  )`,

  tprm_monitoring_connectors: `CREATE TABLE __TABLE__ (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    module_id INTEGER NOT NULL,
    provider_type TEXT NOT NULL CHECK(provider_type IN (
      'securityscorecard','bitsight','riskrecon','generic_webhook','csv_import'
    )),
    capability_mode TEXT NOT NULL CHECK(capability_mode IN ('webhook','csv','poll')),
    name TEXT NOT NULL,
    ingress_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','disabled')),
    secret_reference TEXT,
    adapter_config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(adapter_config_json)),
    failure_mode TEXT NOT NULL DEFAULT 'fail_closed' CHECK(failure_mode='fail_closed'),
    external_provisioning_confirmed INTEGER NOT NULL DEFAULT 0
      CHECK(external_provisioning_confirmed IN (0,1)),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
    UNIQUE(workspace_id,id),
    UNIQUE(workspace_id,name),
    FOREIGN KEY(workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
    CHECK(length(trim(name)) BETWEEN 3 AND 120),
    CHECK(name=trim(name)),
    CHECK(length(ingress_key)=32 AND ingress_key NOT GLOB '*[^0-9a-f]*'),
    CHECK(
      (provider_type='csv_import' AND capability_mode='csv' AND secret_reference IS NULL)
      OR (provider_type='generic_webhook' AND capability_mode='webhook' AND secret_reference IS NOT NULL)
      OR (provider_type IN ('securityscorecard','bitsight','riskrecon')
          AND capability_mode IN ('webhook','poll') AND secret_reference IS NOT NULL)
    ),
    CHECK(secret_reference IS NULL OR (
      length(secret_reference) BETWEEN 8 AND 512
      AND secret_reference=trim(secret_reference)
      AND (
        secret_reference LIKE 'vault://%'
        OR secret_reference LIKE 'aws-secretsmanager://%'
        OR secret_reference LIKE 'azure-keyvault://%'
        OR secret_reference LIKE 'gcp-secretmanager://%'
        OR secret_reference LIKE 'env://%'
        OR secret_reference LIKE 'keychain://%'
      )
    )),
    CHECK(status!='active' OR provider_type IN ('generic_webhook','csv_import')
          OR external_provisioning_confirmed=1)
  )`,
});

const INTENTIONALLY_REPLACED = Object.freeze(new Set([
  'trg_tprm_condition_definition_immutable',
  'trg_tprm_condition_supplier_finding',
  'trg_tprm_connector_ingress_insert',
  'trg_tprm_connector_ingress_update',
  'uq_tprm_monitoring_connector_ingress_key',
]));

function quoteIdentifier(value) {
  if (!/^[a-z0-9_]+$/i.test(value)) throw new Error(`unsafe migration identifier: ${value}`);
  return `"${value}"`;
}

function tableSql(db, table) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || '';
}

function tableExists(db, table) {
  return Boolean(tableSql(db, table));
}

function actualColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(row => row.name);
}

function assertExactColumns(db, table) {
  const actual = actualColumns(db, table);
  const expected = CANONICAL_COLUMNS[table];
  const missing = expected.filter(column => !actual.includes(column));
  const extra = actual.filter(column => !expected.includes(column));
  if (missing.length || extra.length) {
    throw new Error(`${table} has unsupported columns (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'})`);
  }
}

function needsRebuild(db, table) {
  const sql = tableSql(db, table);
  if (!sql) throw new Error(`required TPRM table is missing: ${table}`);
  return !CANONICAL_MARKERS[table].every(marker => sql.includes(marker));
}

function sequenceState(db, table) {
  const maxId = db.prepare(`SELECT COALESCE(MAX(id),0) AS max_id FROM ${quoteIdentifier(table)}`).get().max_id;
  const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table);
  if (!row && maxId > 0) throw new Error(`${table} has rows but no AUTOINCREMENT sequence`);
  if (row && Number(row.seq) < Number(maxId)) {
    throw new Error(`${table} AUTOINCREMENT sequence ${row.seq} is below max id ${maxId}`);
  }
  return { exists: Boolean(row), seq: row ? Number(row.seq) : null, maxId: Number(maxId) };
}

function assertNoStaleShadows(db) {
  for (const table of TARGETS) {
    const shadow = `${table}${SHADOW_SUFFIX}`;
    if (tableExists(db, shadow)) {
      throw new Error(`stale TPRM migration shadow exists: ${shadow}`);
    }
  }
}

function ensureCanonicalFindingParentIndex(db) {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_workspace_id
    ON findings(workspace_id,id)`);
  const index = db.prepare(`SELECT 1 FROM pragma_index_list('findings')
    WHERE name='uq_findings_workspace_id' AND "unique"=1`).get();
  const columns = db.prepare(`SELECT name FROM pragma_index_info('uq_findings_workspace_id')
    ORDER BY seqno`).all().map(row => row.name);
  if (!index || columns.length !== 2 || columns[0] !== 'workspace_id' || columns[1] !== 'id') {
    throw new Error('findings tenant identity index is not canonical');
  }
}

function assertTenantAndRelationshipIntegrity(db, existingForeignKeys) {
  assertNoPreExistingTprmViolations(existingForeignKeys);

  if (db.prepare(`SELECT 1 FROM tprm_service_relationships
    WHERE alternate_provider_relationship_id=id LIMIT 1`).get()) {
    throw new Error('TPRM service relationship cannot be its own alternate provider');
  }

  if (db.prepare(`SELECT 1
    FROM tprm_legal_entities le
    LEFT JOIN suppliers s ON s.workspace_id=le.workspace_id AND s.id=le.supplier_id
    WHERE s.id IS NULL LIMIT 1`).get()) {
    throw new Error('TPRM legal entity has an invalid tenant/supplier link');
  }

  if (db.prepare(`SELECT 1
    FROM tprm_service_relationships r
    LEFT JOIN tprm_legal_entities le
      ON le.workspace_id=r.workspace_id AND le.supplier_id=r.supplier_id AND le.id=r.legal_entity_id
    LEFT JOIN tprm_service_relationships alt
      ON alt.workspace_id=r.workspace_id AND alt.id=r.alternate_provider_relationship_id
    WHERE le.id IS NULL
      OR (r.alternate_provider_relationship_id IS NOT NULL AND alt.id IS NULL)
    LIMIT 1`).get()) {
    throw new Error('TPRM service relationship has an invalid tenant/entity link');
  }

  if (db.prepare(`SELECT 1
    FROM tprm_conditions c
    LEFT JOIN findings f ON f.workspace_id=c.workspace_id AND f.id=c.finding_id
    WHERE c.finding_id IS NOT NULL AND f.id IS NULL LIMIT 1`).get()) {
    throw new Error('TPRM condition finding is outside its client workspace');
  }

  if (db.prepare(`SELECT 1
    FROM tprm_monitoring_connectors c
    LEFT JOIN tprm_modules m ON m.workspace_id=c.workspace_id AND m.id=c.module_id
    WHERE m.id IS NULL LIMIT 1`).get()) {
    throw new Error('TPRM connector module is outside its client workspace');
  }

  if (db.prepare(`SELECT 1 FROM tprm_monitoring_connectors
    WHERE ingress_key IS NULL OR length(ingress_key)<>32
      OR ingress_key GLOB '*[^0-9a-f]*' LIMIT 1`).get()) {
    throw new Error('TPRM connector has an invalid ingress key');
  }
  if (db.prepare(`SELECT 1 FROM tprm_monitoring_connectors
    GROUP BY ingress_key HAVING COUNT(*)>1 LIMIT 1`).get()) {
    throw new Error('TPRM connector ingress keys are not unique');
  }
}

function captureDependentObjects(db, table) {
  const rows = db.prepare(`SELECT type,name,tbl_name,sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND type IN ('index','trigger')
      AND (tbl_name=? OR (type='trigger' AND instr(lower(sql),lower(?))>0))
    ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END,name`).all(table, table);
  const byName = new Map();
  for (const row of rows) {
    if (!INTENTIONALLY_REPLACED.has(row.name)) byName.set(`${row.type}:${row.name}`, row);
  }
  return [...byName.values()];
}

function dropCapturedTriggers(db, objects) {
  for (const object of objects) {
    if (object.type === 'trigger') db.exec(`DROP TRIGGER ${quoteIdentifier(object.name)}`);
  }
}

function restoreCapturedObjects(db, objects) {
  for (const object of objects) db.exec(object.sql);
}

function rowsDiffer(db, sourceTable, targetTable, columns) {
  const list = columns.map(quoteIdentifier).join(',');
  const sourceOnly = db.prepare(`SELECT 1 FROM (
    SELECT ${list} FROM ${quoteIdentifier(sourceTable)}
    EXCEPT SELECT ${list} FROM ${quoteIdentifier(targetTable)}
  ) LIMIT 1`).get();
  const targetOnly = db.prepare(`SELECT 1 FROM (
    SELECT ${list} FROM ${quoteIdentifier(targetTable)}
    EXCEPT SELECT ${list} FROM ${quoteIdentifier(sourceTable)}
  ) LIMIT 1`).get();
  return Boolean(sourceOnly || targetOnly);
}

function restoreSequence(db, table, shadow, state) {
  db.prepare('DELETE FROM sqlite_sequence WHERE name IN (?,?)').run(table, shadow);
  if (state.exists) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(table, state.seq);
  const restored = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table);
  if (state.exists !== Boolean(restored)
      || (state.exists && Number(restored.seq) !== state.seq)) {
    throw new Error(`${table} AUTOINCREMENT sequence was not preserved`);
  }
}

function rebuildCanonicalTable(db, table) {
  assertExactColumns(db, table);
  if (!needsRebuild(db, table)) return false;

  const shadow = `${table}${SHADOW_SUFFIX}`;
  if (tableExists(db, shadow)) throw new Error(`stale TPRM migration shadow exists: ${shadow}`);

  const sequence = sequenceState(db, table);
  const beforeCount = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
  const objects = captureDependentObjects(db, table);
  dropCapturedTriggers(db, objects);

  db.exec(CANONICAL_TABLE_SQL[table].replace('__TABLE__', quoteIdentifier(shadow)));
  const columns = CANONICAL_COLUMNS[table];
  const columnList = columns.map(quoteIdentifier).join(',');
  db.exec(`INSERT INTO ${quoteIdentifier(shadow)} (${columnList})
    SELECT ${columnList} FROM ${quoteIdentifier(table)}`);

  const shadowCount = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(shadow)}`).get().count;
  if (Number(shadowCount) !== Number(beforeCount)) {
    throw new Error(`${table} row count changed during canonical copy (${beforeCount} -> ${shadowCount})`);
  }
  if (rowsDiffer(db, table, shadow, columns)) {
    throw new Error(`${table} row values changed during canonical copy`);
  }

  db.exec(`DROP TABLE ${quoteIdentifier(table)}`);
  db.exec(`ALTER TABLE ${quoteIdentifier(shadow)} RENAME TO ${quoteIdentifier(table)}`);
  restoreSequence(db, table, shadow, sequence);
  restoreCapturedObjects(db, objects);

  const afterCount = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
  if (Number(afterCount) !== Number(beforeCount)) {
    throw new Error(`${table} row count changed after canonical replacement (${beforeCount} -> ${afterCount})`);
  }
  if (Number(db.prepare(`SELECT COALESCE(MAX(id),0) AS max_id FROM ${quoteIdentifier(table)}`).get().max_id) !== sequence.maxId) {
    throw new Error(`${table} maximum id changed during canonical replacement`);
  }
  return true;
}

function reconcileCanonicalBoundaryObjects(db) {
  db.exec(`
    DROP INDEX IF EXISTS uq_tprm_monitoring_connector_ingress_key;
    DROP TRIGGER IF EXISTS trg_tprm_connector_ingress_insert;
    DROP TRIGGER IF EXISTS trg_tprm_connector_ingress_update;

    DROP TRIGGER IF EXISTS trg_tprm_condition_definition_immutable;
    CREATE TRIGGER trg_tprm_condition_definition_immutable
    BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,source_type,recommendation_id,client_decision_id,
      finding_id,condition_type,title,description,severity,owner_type,owner_user_id,owner_name,due_date,
      verification_criteria,created_by,created_at
    ON tprm_conditions
    BEGIN
      SELECT RAISE(ABORT,'issued TPRM condition definition is immutable');
    END;

    DROP TRIGGER IF EXISTS trg_tprm_condition_supplier_finding;
    CREATE TRIGGER trg_tprm_condition_supplier_finding
    BEFORE INSERT ON tprm_conditions
    WHEN NEW.finding_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM supplier_finding_links l
      WHERE l.finding_id=NEW.finding_id AND l.supplier_id=NEW.supplier_id
    )
    BEGIN
      SELECT RAISE(ABORT,'TPRM condition finding is not linked to this third party');
    END;
  `);
}

function assertCanonicalResult(db, existingForeignKeys) {
  for (const table of TARGETS) {
    assertExactColumns(db, table);
    if (needsRebuild(db, table)) throw new Error(`${table} did not reach its canonical schema`);
  }

  const ingress = db.prepare(`SELECT "notnull" AS required
    FROM pragma_table_info('tprm_monitoring_connectors') WHERE name='ingress_key'`).get();
  if (!ingress || Number(ingress.required) !== 1) throw new Error('TPRM connector ingress key is not NOT NULL');

  const conditionFks = db.prepare(`PRAGMA foreign_key_list(tprm_conditions)`).all()
    .filter(row => row.table === 'findings');
  const compositeFindingFk = conditionFks.length === 2
    && conditionFks.some(row => row.from === 'workspace_id' && row.to === 'workspace_id')
    && conditionFks.some(row => row.from === 'finding_id' && row.to === 'id')
    && new Set(conditionFks.map(row => row.id)).size === 1;
  if (!compositeFindingFk) throw new Error('TPRM condition finding tenant foreign key is not canonical');

  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE name IN (
    'uq_tprm_monitoring_connector_ingress_key',
    'trg_tprm_connector_ingress_insert',
    'trg_tprm_connector_ingress_update'
  ) LIMIT 1`).get()) {
    throw new Error('legacy connector ingress boundary objects remain after reconciliation');
  }

  assertNoForeignKeyRegression(db, existingForeignKeys);
  const quickCheck = db.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`TPRM exact reconciliation integrity check failed: ${quickCheck}`);
}

function up(db) {
  if (db.pragma('foreign_keys', { simple: true }) !== 0) {
    throw new Error('055 exact TPRM reconciliation requires runner-controlled foreign_keys=OFF');
  }

  // Preserve unrelated legacy orphans byte-for-byte while proving that this
  // rebuild neither accepts a broken TPRM boundary nor creates a new orphan.
  const existingForeignKeys = readForeignKeyViolations(db);

  assertNoStaleShadows(db);
  for (const table of TARGETS) {
    if (!tableExists(db, table)) throw new Error(`required TPRM table is missing: ${table}`);
    assertExactColumns(db, table);
    sequenceState(db, table);
  }
  ensureCanonicalFindingParentIndex(db);
  assertTenantAndRelationshipIntegrity(db, existingForeignKeys);

  for (const table of TARGETS) rebuildCanonicalTable(db, table);
  reconcileCanonicalBoundaryObjects(db);
  assertCanonicalResult(db, existingForeignKeys);
}

module.exports = { up, foreignKeysOff: true };
