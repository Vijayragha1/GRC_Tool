'use strict';

// Forward reconciliation for development/deployed databases that recorded an
// earlier shape of 046/047/048/050 before the TPRM hardening work finished.
// SQLite has no conditional ALTER TABLE ... ADD COLUMN, so this migration is
// intentionally introspective. The production runner executes up(db) and the
// schema_migrations insert in one transaction.

const crypto = require('node:crypto');

function objectSql(db, type, name) {
  return db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, name)?.sql || '';
}

function tableExists(db, name) {
  return Boolean(objectSql(db, 'table', name));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function addColumn(db, table, column, definition) {
  if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function dropTriggers(db, names) {
  for (const name of names) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

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
    throw new Error(`TPRM reconciliation refused ${tprmViolations.length} pre-existing TPRM foreign-key violation(s)`);
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
    throw new Error(`TPRM reconciliation produced ${tprmViolations.length} TPRM foreign-key violation(s)`);
  }

  const introduced = after.filter(violation => {
    const signature = foreignKeyViolationSignature(violation);
    const remaining = baseline.get(signature) || 0;
    if (!remaining) return true;
    baseline.set(signature, remaining - 1);
    return false;
  });
  if (introduced.length) {
    throw new Error(`TPRM reconciliation produced ${introduced.length} new foreign-key violation(s) outside TPRM`);
  }
}

function uniqueIngressKey(db) {
  for (;;) {
    const key = crypto.randomBytes(16).toString('hex');
    const used = db.prepare('SELECT 1 FROM tprm_monitoring_connectors WHERE ingress_key=?').get(key);
    if (!used) return key;
  }
}

function rebuildLifecycleEventsIfNeeded(db) {
  const sql = objectSql(db, 'table', 'tprm_lifecycle_events');
  if (!sql || (sql.includes("'evidence_released'") && sql.includes("'decision_authority_assigned'"))) return;

  dropTriggers(db, [
    'trg_tprm_event_no_update',
    'trg_tprm_event_no_delete',
    'trg_tprm_lifecycle_event_chain_predecessor',
    'trg_tprm_lifecycle_event_hash_required',
  ]);
  db.exec(`
    DROP TABLE IF EXISTS tprm_lifecycle_events_054;
    CREATE TABLE tprm_lifecycle_events_054 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      supplier_id INTEGER,
      module_id INTEGER NOT NULL,
      cycle_id INTEGER,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'module_enabled','module_classified','module_closed','cycle_started','cycle_cancelled',
        'artifact_linked','evidence_released','evidence_release_withdrawn','decision_authority_assigned',
        'stage_transition','recommendation_issued','client_decision_recorded','condition_completed',
        'clarification_requested','clarification_responded','clarification_resolved',
        'monitoring_signal_recorded','monitoring_signal_triaged','reassessment_scheduled','legacy_history_linked'
      )),
      from_stage TEXT CHECK(from_stage IS NULL OR from_stage IN (
        'module_setup','intake','inherent_risk','due_diligence','contract_assurance',
        'consultancy_review','quality_review','client_decision','monitoring','deferred',
        'rejected','offboarding','closed'
      )),
      to_stage TEXT CHECK(to_stage IS NULL OR to_stage IN (
        'module_setup','intake','inherent_risk','due_diligence','contract_assurance',
        'consultancy_review','quality_review','client_decision','monitoring','deferred',
        'rejected','offboarding','closed'
      )),
      actor_user_id INTEGER REFERENCES users(id),
      actor_type TEXT NOT NULL CHECK(actor_type IN ('consultant','consultancy_manager','client','external_provider','system','migration')),
      actor_name TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
      idempotency_key TEXT,
      request_fingerprint TEXT,
      previous_event_hash TEXT,
      event_hash TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_hash),
      UNIQUE(idempotency_key),
      FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
      FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
      FOREIGN KEY (workspace_id,supplier_id,cycle_id) REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
      CHECK((supplier_id IS NULL AND cycle_id IS NULL) OR supplier_id IS NOT NULL),
      CHECK(event_hash IS NULL OR (length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*')),
      CHECK(previous_event_hash IS NULL OR (length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*')),
      CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')),
      CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
    );
    INSERT INTO tprm_lifecycle_events_054 (
      id,workspace_id,supplier_id,module_id,cycle_id,event_type,from_stage,to_stage,
      actor_user_id,actor_type,actor_name,reason,payload_json,idempotency_key,
      request_fingerprint,previous_event_hash,event_hash,occurred_at
    ) SELECT
      id,workspace_id,supplier_id,module_id,cycle_id,event_type,from_stage,to_stage,
      actor_user_id,actor_type,actor_name,reason,payload_json,idempotency_key,
      request_fingerprint,previous_event_hash,event_hash,occurred_at
    FROM tprm_lifecycle_events;
    DROP TABLE tprm_lifecycle_events;
    ALTER TABLE tprm_lifecycle_events_054 RENAME TO tprm_lifecycle_events;
  `);
}

function rebuildConnectorRunsIfNeeded(db) {
  const sql = objectSql(db, 'table', 'tprm_monitoring_connector_runs');
  if (!sql || sql.includes("'rejected'")) return;
  dropTriggers(db, ['trg_tprm_connector_run_no_update', 'trg_tprm_connector_run_no_delete']);
  db.exec(`
    DROP TABLE IF EXISTS tprm_monitoring_connector_runs_054;
    CREATE TABLE tprm_monitoring_connector_runs_054 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      connector_id INTEGER NOT NULL,
      run_type TEXT NOT NULL CHECK(run_type IN ('webhook','csv','poll','healthcheck','retry','manual')),
      status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed','rate_limited','quarantined','rejected')),
      received_count INTEGER NOT NULL DEFAULT 0 CHECK(received_count>=0),
      processed_count INTEGER NOT NULL DEFAULT 0 CHECK(processed_count>=0),
      duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK(duplicate_count>=0),
      quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK(quarantined_count>=0),
      error_code TEXT,
      error_redacted TEXT,
      retry_after TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      UNIQUE(workspace_id,connector_id,id),
      FOREIGN KEY(workspace_id,connector_id) REFERENCES tprm_monitoring_connectors(workspace_id,id),
      CHECK(processed_count+duplicate_count+quarantined_count<=received_count),
      CHECK(error_redacted IS NULL OR length(error_redacted)<=1000)
    );
    INSERT INTO tprm_monitoring_connector_runs_054 (
      id,workspace_id,connector_id,run_type,status,received_count,processed_count,
      duplicate_count,quarantined_count,error_code,error_redacted,retry_after,started_at,completed_at
    ) SELECT
      id,workspace_id,connector_id,run_type,status,received_count,processed_count,
      duplicate_count,quarantined_count,error_code,error_redacted,retry_after,started_at,completed_at
    FROM tprm_monitoring_connector_runs;
    DROP TABLE tprm_monitoring_connector_runs;
    ALTER TABLE tprm_monitoring_connector_runs_054 RENAME TO tprm_monitoring_connector_runs;
  `);
}

function createReconciledTables(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_workspace_id
      ON findings(workspace_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_documents_workspace_supplier_id
      ON supplier_documents(workspace_id,supplier_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_ddq_evidence_workspace_id
      ON supplier_ddq_evidence(workspace_id,id);

    CREATE TABLE IF NOT EXISTS tprm_evidence_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      cycle_id INTEGER NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('supplier_document','ddq_evidence')),
      supplier_document_id INTEGER,
      ddq_evidence_id INTEGER,
      client_label TEXT NOT NULL,
      client_description TEXT,
      allow_download INTEGER NOT NULL DEFAULT 0 CHECK(allow_download IN (0,1)),
      expires_at TEXT,
      released_by INTEGER NOT NULL REFERENCES users(id),
      released_at TEXT NOT NULL DEFAULT (datetime('now')),
      release_hash TEXT NOT NULL,
      idempotency_key TEXT,
      UNIQUE(workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,ddq_evidence_id),
      UNIQUE(workspace_id,supplier_id,id),
      UNIQUE(release_hash),
      UNIQUE(idempotency_key),
      FOREIGN KEY (workspace_id,supplier_id,cycle_id) REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
      FOREIGN KEY (workspace_id,supplier_id,supplier_document_id) REFERENCES supplier_documents(workspace_id,supplier_id,id),
      FOREIGN KEY (workspace_id,ddq_evidence_id) REFERENCES supplier_ddq_evidence(workspace_id,id),
      CHECK(
        (source_type='supplier_document' AND supplier_document_id IS NOT NULL AND ddq_evidence_id IS NULL)
        OR (source_type='ddq_evidence' AND supplier_document_id IS NULL AND ddq_evidence_id IS NOT NULL)
      ),
      CHECK(length(release_hash)=64 AND release_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK(expires_at IS NULL OR (expires_at GLOB '????-??-??' AND strftime('%Y-%m-%d',expires_at||' 00:00:00','+0 days')=expires_at)),
      CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
    );
    CREATE INDEX IF NOT EXISTS idx_tprm_evidence_releases_cycle
      ON tprm_evidence_releases(cycle_id,released_at,id);

    CREATE TABLE IF NOT EXISTS tprm_evidence_release_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      release_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      withdrawn_by INTEGER NOT NULL REFERENCES users(id),
      withdrawn_at TEXT NOT NULL DEFAULT (datetime('now')),
      idempotency_key TEXT,
      request_fingerprint TEXT NOT NULL,
      UNIQUE(release_id),
      UNIQUE(idempotency_key),
      FOREIGN KEY (workspace_id,supplier_id,release_id) REFERENCES tprm_evidence_releases(workspace_id,supplier_id,id),
      CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key))),
      CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')
    );

    CREATE TABLE IF NOT EXISTS tprm_module_closure_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      module_id INTEGER NOT NULL,
      retention_until TEXT NOT NULL,
      legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
      retention_policy TEXT NOT NULL,
      closure_reason TEXT NOT NULL,
      closed_by INTEGER NOT NULL REFERENCES users(id),
      closed_at TEXT NOT NULL,
      closure_hash TEXT NOT NULL,
      UNIQUE(module_id),
      UNIQUE(closure_hash),
      UNIQUE(workspace_id,module_id,id),
      FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
      CHECK(retention_until GLOB '????-??-??' AND strftime('%Y-%m-%d',retention_until||' 00:00:00','+0 days')=retention_until),
      CHECK(length(trim(retention_policy))>=10),
      CHECK(length(trim(closure_reason))>=10),
      CHECK(length(closure_hash)=64 AND closure_hash NOT GLOB '*[^0-9a-f]*')
    );
    CREATE INDEX IF NOT EXISTS idx_tprm_module_closure_retention
      ON tprm_module_closure_records(workspace_id,retention_until,legal_hold);
  `);
}

function createCoreTriggers(db) {
  dropTriggers(db, [
    'trg_tprm_cycle_authority_insert','trg_tprm_cycle_authority_update',
    'trg_tprm_client_decision_actor','trg_tprm_condition_definition_immutable',
    'trg_tprm_condition_supplier_finding','trg_tprm_condition_owner_tenant',
    'trg_tprm_condition_status_transition','trg_tprm_condition_status_requires_event',
    'trg_tprm_evidence_release_actor','trg_tprm_evidence_release_ddq_scope',
    'trg_tprm_evidence_release_no_update','trg_tprm_evidence_release_no_delete',
    'trg_tprm_evidence_withdrawal_actor','trg_tprm_evidence_withdrawal_no_update',
    'trg_tprm_evidence_withdrawal_no_delete','trg_tprm_module_closure_actor',
    'trg_tprm_module_closure_no_update','trg_tprm_module_closure_no_delete',
    'trg_tprm_event_no_update','trg_tprm_event_no_delete',
    'trg_tprm_lifecycle_event_chain_predecessor','trg_tprm_lifecycle_event_hash_required',
  ]);
  db.exec(`
    CREATE TRIGGER trg_tprm_cycle_authority_insert
    BEFORE INSERT ON tprm_assessment_cycles
    WHEN NEW.client_decision_authority_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
      WHERE u.id=NEW.client_decision_authority_id AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')
    )
    BEGIN SELECT RAISE(ABORT,'TPRM decision authority must be an active client workspace member'); END;

    CREATE TRIGGER trg_tprm_cycle_authority_update
    BEFORE UPDATE OF client_decision_authority_id ON tprm_assessment_cycles
    WHEN (OLD.client_decision_authority_id IS NOT NULL AND NEW.client_decision_authority_id IS NOT OLD.client_decision_authority_id)
      OR (NEW.client_decision_authority_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
        WHERE u.id=NEW.client_decision_authority_id AND u.user_type='client' AND u.active=1
          AND wm.role IN ('client_owner','client_admin')
      ))
    BEGIN SELECT RAISE(ABORT,'TPRM decision authority is immutable once assigned and must be an active client workspace member'); END;

    CREATE TRIGGER trg_tprm_client_decision_actor
    BEFORE INSERT ON tprm_client_decisions
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
      WHERE u.id=NEW.client_actor_user_id AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')
    ) OR EXISTS (
      SELECT 1 FROM tprm_assessment_cycles c
      WHERE c.id=NEW.cycle_id AND c.client_decision_authority_id IS NOT NULL
        AND c.client_decision_authority_id<>NEW.client_actor_user_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM onboarding decision requires the assigned active client decision authority'); END;

    CREATE TRIGGER trg_tprm_condition_owner_tenant
    BEFORE INSERT ON tprm_conditions
    WHEN (
      (NEW.owner_type='client' AND (NEW.owner_user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
        WHERE u.id=NEW.owner_user_id AND u.user_type='client' AND u.active=1
          AND wm.role IN ('client_owner','client_admin')
      )))
      OR (NEW.owner_type='consultancy' AND (NEW.owner_user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
        WHERE u.id=NEW.owner_user_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
      )))
      OR (NEW.owner_type='third_party' AND NEW.owner_user_id IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT,'TPRM condition owner does not match the owner type and tenant'); END;

    CREATE TRIGGER trg_tprm_condition_supplier_finding
    BEFORE INSERT ON tprm_conditions
    WHEN NEW.finding_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM findings f JOIN supplier_finding_links l ON l.finding_id=f.id
      WHERE f.id=NEW.finding_id AND f.workspace_id=NEW.workspace_id AND l.supplier_id=NEW.supplier_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM condition finding is not linked to this third party and client workspace'); END;

    CREATE TRIGGER trg_tprm_condition_definition_immutable
    BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,source_type,recommendation_id,client_decision_id,
      finding_id,condition_type,title,description,severity,owner_type,owner_user_id,owner_name,due_date,
      verification_criteria,created_by,created_at ON tprm_conditions
    BEGIN SELECT RAISE(ABORT,'issued TPRM condition definition is immutable'); END;

    CREATE TRIGGER trg_tprm_condition_status_transition
    BEFORE UPDATE OF status ON tprm_conditions
    WHEN NOT (
      (OLD.status='open' AND NEW.status IN ('in_progress','waived'))
      OR (OLD.status='in_progress' AND NEW.status IN ('evidence_submitted','waived'))
      OR (OLD.status='evidence_submitted' AND NEW.status IN ('in_progress','verified','waived'))
    )
    BEGIN SELECT RAISE(ABORT,'invalid governed TPRM condition status transition'); END;

    CREATE TRIGGER trg_tprm_condition_status_requires_event
    BEFORE UPDATE OF status ON tprm_conditions
    WHEN NEW.status<>OLD.status AND (
      NEW.row_version<>OLD.row_version+1 OR NOT EXISTS (
        SELECT 1 FROM tprm_condition_events e
        WHERE e.workspace_id=OLD.workspace_id AND e.supplier_id=OLD.supplier_id
          AND e.cycle_id=OLD.cycle_id AND e.condition_id=OLD.id
          AND e.from_status=OLD.status AND e.to_status=NEW.status
          AND e.expected_row_version=OLD.row_version AND e.resulting_row_version=NEW.row_version
        ORDER BY e.id DESC LIMIT 1
      )
    )
    BEGIN SELECT RAISE(ABORT,'TPRM condition status requires its append-only governed event'); END;

    CREATE TRIGGER trg_tprm_evidence_release_actor
    BEFORE INSERT ON tprm_evidence_releases
    WHEN NOT EXISTS (
      SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.released_by
      WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM evidence release requires an active consultancy user'); END;

    CREATE TRIGGER trg_tprm_evidence_release_ddq_scope
    BEFORE INSERT ON tprm_evidence_releases
    WHEN NEW.source_type='ddq_evidence' AND NOT EXISTS (
      SELECT 1 FROM supplier_ddq_evidence e
      JOIN supplier_ddq_assessments a ON a.id=e.assessment_id
      JOIN tprm_assessment_cycles c ON c.id=NEW.cycle_id
      WHERE e.id=NEW.ddq_evidence_id AND e.workspace_id=NEW.workspace_id
        AND a.workspace_id=NEW.workspace_id AND a.supplier_id=NEW.supplier_id
        AND c.workspace_id=NEW.workspace_id AND c.supplier_id=NEW.supplier_id
        AND c.ddq_assessment_id=a.id
    )
    BEGIN SELECT RAISE(ABORT,'released DDQ evidence is outside this governed assessment cycle'); END;

    CREATE TRIGGER trg_tprm_evidence_release_no_update BEFORE UPDATE ON tprm_evidence_releases
    BEGIN SELECT RAISE(ABORT,'TPRM evidence releases are immutable'); END;
    CREATE TRIGGER trg_tprm_evidence_release_no_delete BEFORE DELETE ON tprm_evidence_releases
    BEGIN SELECT RAISE(ABORT,'TPRM evidence releases cannot be deleted'); END;

    CREATE TRIGGER trg_tprm_evidence_withdrawal_actor
    BEFORE INSERT ON tprm_evidence_release_withdrawals
    WHEN NOT EXISTS (
      SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.withdrawn_by
      WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM evidence withdrawal requires an active consultancy user'); END;
    CREATE TRIGGER trg_tprm_evidence_withdrawal_no_update BEFORE UPDATE ON tprm_evidence_release_withdrawals
    BEGIN SELECT RAISE(ABORT,'TPRM evidence-release withdrawals are immutable'); END;
    CREATE TRIGGER trg_tprm_evidence_withdrawal_no_delete BEFORE DELETE ON tprm_evidence_release_withdrawals
    BEGIN SELECT RAISE(ABORT,'TPRM evidence-release withdrawals cannot be deleted'); END;

    CREATE TRIGGER trg_tprm_module_closure_actor
    BEFORE INSERT ON tprm_module_closure_records
    WHEN NOT EXISTS (
      SELECT 1 FROM tprm_modules m JOIN workspaces w ON w.id=m.workspace_id JOIN users u ON u.id=NEW.closed_by
      WHERE m.id=NEW.module_id AND m.workspace_id=NEW.workspace_id AND m.status='closed'
        AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
        AND u.firm_role IN ('manager','firm_owner')
    )
    BEGIN SELECT RAISE(ABORT,'TPRM closure policy requires the manager who closed the service period'); END;
    CREATE TRIGGER trg_tprm_module_closure_no_update BEFORE UPDATE ON tprm_module_closure_records
    BEGIN SELECT RAISE(ABORT,'TPRM module closure policy is immutable'); END;
    CREATE TRIGGER trg_tprm_module_closure_no_delete BEFORE DELETE ON tprm_module_closure_records
    BEGIN SELECT RAISE(ABORT,'TPRM module closure policy cannot be deleted'); END;

    CREATE INDEX IF NOT EXISTS idx_tprm_events_supplier_time
      ON tprm_lifecycle_events(workspace_id,supplier_id,occurred_at,id);
    CREATE INDEX IF NOT EXISTS idx_tprm_events_cycle_time
      ON tprm_lifecycle_events(cycle_id,occurred_at,id);
    CREATE TRIGGER trg_tprm_event_no_update BEFORE UPDATE ON tprm_lifecycle_events
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle events are immutable'); END;
    CREATE TRIGGER trg_tprm_event_no_delete BEFORE DELETE ON tprm_lifecycle_events
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle events cannot be deleted'); END;
    CREATE TRIGGER trg_tprm_lifecycle_event_hash_required
    BEFORE INSERT ON tprm_lifecycle_events WHEN NEW.event_hash IS NULL
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle event hash is required'); END;
    CREATE TRIGGER trg_tprm_lifecycle_event_chain_predecessor
    BEFORE INSERT ON tprm_lifecycle_events
    WHEN NEW.previous_event_hash IS NOT (
      SELECT event_hash FROM tprm_lifecycle_events
      WHERE workspace_id=NEW.workspace_id AND module_id=NEW.module_id
        AND supplier_id IS NEW.supplier_id AND event_hash IS NOT NULL
      ORDER BY id DESC LIMIT 1
    )
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle event hash-chain predecessor is invalid'); END;
  `);
}

function createMonitoringTriggers(db) {
  dropTriggers(db, [
    'trg_tprm_connector_ingress_insert','trg_tprm_connector_ingress_update',
    'trg_tprm_connector_actor_update','trg_tprm_connector_identity_immutable',
    'trg_tprm_connector_version',
    'trg_tprm_connector_no_secret_config_insert','trg_tprm_connector_no_secret_config_update',
    'trg_tprm_connector_audit_actor','trg_tprm_connector_audit_chain_predecessor',
    'trg_tprm_connector_mapping_actor_retire','trg_tprm_monitoring_rule_actor_insert',
    'trg_tprm_monitoring_rule_actor_disable','trg_tprm_received_event_chain_predecessor',
    'trg_tprm_connector_run_no_update','trg_tprm_connector_run_no_delete',
  ]);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_monitoring_connector_ingress_key
      ON tprm_monitoring_connectors(ingress_key);
    CREATE TRIGGER trg_tprm_connector_ingress_insert
    BEFORE INSERT ON tprm_monitoring_connectors
    WHEN NEW.ingress_key IS NULL OR length(NEW.ingress_key)<>32 OR NEW.ingress_key GLOB '*[^0-9a-f]*'
    BEGIN SELECT RAISE(ABORT,'TPRM connector ingress key must be 32 lowercase hexadecimal characters'); END;
    CREATE TRIGGER trg_tprm_connector_ingress_update
    BEFORE UPDATE OF ingress_key ON tprm_monitoring_connectors
    WHEN NEW.ingress_key IS NULL OR length(NEW.ingress_key)<>32 OR NEW.ingress_key GLOB '*[^0-9a-f]*'
    BEGIN SELECT RAISE(ABORT,'TPRM connector ingress key must be 32 lowercase hexadecimal characters'); END;

    CREATE TRIGGER trg_tprm_connector_actor_update
    BEFORE UPDATE ON tprm_monitoring_connectors
    WHEN NEW.updated_by IS NULL OR NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.updated_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM connector updates require an active consultancy user for this workspace'); END;

    CREATE TRIGGER trg_tprm_connector_identity_immutable
    BEFORE UPDATE OF workspace_id,module_id,provider_type,capability_mode,name,ingress_key,created_by,created_at
    ON tprm_monitoring_connectors
    BEGIN SELECT RAISE(ABORT,'TPRM connector tenant identity and adapter type are immutable'); END;

    CREATE TRIGGER trg_tprm_connector_version
    BEFORE UPDATE ON tprm_monitoring_connectors
    WHEN NEW.row_version<>OLD.row_version+1
    BEGIN SELECT RAISE(ABORT,'TPRM connector update requires the next row version'); END;

    CREATE TRIGGER trg_tprm_connector_no_secret_config_insert
    BEFORE INSERT ON tprm_monitoring_connectors
    WHEN EXISTS (
      SELECT 1 FROM json_tree(NEW.adapter_config_json) j
      WHERE lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) IN (
        'secret','password','passphrase','api_key','apikey','access_token','refresh_token',
        'accesstoken','refreshtoken','authorization','credential','credentials','private_key','privatekey',
        'client_secret','clientsecret','webhook_secret','webhooksecret'
      )
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_secret'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_token'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_password'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_credential'
    )
    BEGIN SELECT RAISE(ABORT,'connector configuration cannot contain secret material; store a secret reference'); END;

    CREATE TRIGGER trg_tprm_connector_no_secret_config_update
    BEFORE UPDATE OF adapter_config_json ON tprm_monitoring_connectors
    WHEN EXISTS (
      SELECT 1 FROM json_tree(NEW.adapter_config_json) j
      WHERE lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) IN (
        'secret','password','passphrase','api_key','apikey','access_token','refresh_token',
        'accesstoken','refreshtoken','authorization','credential','credentials','private_key','privatekey',
        'client_secret','clientsecret','webhook_secret','webhooksecret'
      )
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_secret'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_token'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_password'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_credential'
    )
    BEGIN SELECT RAISE(ABORT,'connector configuration cannot contain secret material; store a secret reference'); END;

    CREATE TRIGGER trg_tprm_connector_audit_actor
    BEFORE INSERT ON tprm_monitoring_connector_audit
    WHEN (NEW.actor_type='system' AND NEW.actor_user_id IS NOT NULL)
      OR (NEW.actor_type='consultancy' AND NOT EXISTS (
        SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
        WHERE u.id=NEW.actor_user_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
      ))
    BEGIN SELECT RAISE(ABORT,'TPRM connector audit actor is outside this consultancy workspace'); END;
    CREATE TRIGGER trg_tprm_connector_audit_chain_predecessor
    BEFORE INSERT ON tprm_monitoring_connector_audit
    WHEN NEW.previous_event_hash IS NOT (
      SELECT event_hash FROM tprm_monitoring_connector_audit
      WHERE workspace_id=NEW.workspace_id AND connector_id=NEW.connector_id ORDER BY id DESC LIMIT 1
    )
    BEGIN SELECT RAISE(ABORT,'TPRM connector audit hash-chain predecessor is invalid'); END;

    CREATE TRIGGER trg_tprm_connector_mapping_actor_retire
    BEFORE UPDATE OF retired_by ON tprm_connector_supplier_mappings
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.retired_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM connector mapping retirement requires an active consultancy user'); END;

    CREATE TRIGGER trg_tprm_monitoring_rule_actor_insert
    BEFORE INSERT ON tprm_monitoring_rules
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.created_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM monitoring rule creator must be an active consultancy user'); END;
    CREATE TRIGGER trg_tprm_monitoring_rule_actor_disable
    BEFORE UPDATE OF disabled_by ON tprm_monitoring_rules
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.disabled_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM monitoring rule disablement requires an active consultancy user'); END;

    CREATE TRIGGER trg_tprm_received_event_chain_predecessor
    BEFORE INSERT ON tprm_monitoring_received_events
    WHEN NEW.previous_event_hash IS NOT (
      SELECT event_hash FROM tprm_monitoring_received_events
      WHERE workspace_id=NEW.workspace_id AND connector_id=NEW.connector_id ORDER BY id DESC LIMIT 1
    )
    BEGIN SELECT RAISE(ABORT,'TPRM received-event hash-chain predecessor is invalid'); END;

    CREATE INDEX IF NOT EXISTS idx_tprm_connector_runs_health
      ON tprm_monitoring_connector_runs(workspace_id,connector_id,completed_at DESC,id DESC);
    CREATE TRIGGER trg_tprm_connector_run_no_update BEFORE UPDATE ON tprm_monitoring_connector_runs
    BEGIN SELECT RAISE(ABORT,'TPRM connector run history is immutable'); END;
    CREATE TRIGGER trg_tprm_connector_run_no_delete BEFORE DELETE ON tprm_monitoring_connector_runs
    BEGIN SELECT RAISE(ABORT,'TPRM connector run history cannot be deleted'); END;
  `);
}

function up(db) {
  db.pragma('defer_foreign_keys = ON');

  // Legacy installations can contain unrelated historic orphans. This
  // migration must neither reinterpret nor delete those business records, but
  // it still fails closed if TPRM is already inconsistent or if reconciliation
  // introduces any new orphan anywhere in the database.
  const existingForeignKeyErrors = readForeignKeyViolations(db);
  assertNoPreExistingTprmViolations(existingForeignKeyErrors);

  addColumn(db, 'tprm_assessment_cycles', 'client_decision_authority_id', 'INTEGER REFERENCES users(id)');
  addColumn(db, 'tprm_conditions', 'finding_id', 'INTEGER REFERENCES findings(id)');

  // The old connector table is referenced by immutable monitoring history, so
  // it is upgraded in place. A named unique index plus insert/update triggers
  // provide the same non-null/lowercase/unique invariant as the fresh schema.
  dropTriggers(db, [
    'trg_tprm_connector_identity_immutable',
    'trg_tprm_connector_actor_update',
    'trg_tprm_connector_version',
  ]);
  addColumn(db, 'tprm_monitoring_connectors', 'ingress_key', 'TEXT');
  const connectors = db.prepare(`SELECT id,ingress_key FROM tprm_monitoring_connectors
    WHERE ingress_key IS NULL OR length(ingress_key)<>32 OR ingress_key GLOB '*[^0-9a-f]*'`).all();
  const setIngress = db.prepare('UPDATE tprm_monitoring_connectors SET ingress_key=? WHERE id=?');
  for (const connector of connectors) setIngress.run(uniqueIngressKey(db), connector.id);

  rebuildLifecycleEventsIfNeeded(db);
  rebuildConnectorRunsIfNeeded(db);
  createReconciledTables(db);
  createCoreTriggers(db);
  createMonitoringTriggers(db);

  assertNoForeignKeyRegression(db, existingForeignKeyErrors);
  const quickCheck = db.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`TPRM reconciliation integrity check failed: ${quickCheck}`);
}

module.exports = { up, foreignKeysOff: true };
