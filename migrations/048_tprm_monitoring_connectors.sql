-- 048_tprm_monitoring_connectors.sql
-- Provider-neutral continuous-monitoring intake for the standalone TPRM module.
--
-- Deliberate security boundaries:
--   * connector credentials are references to an external secret store; secret
--     material and raw provider payloads are never persisted here;
--   * every tenant relationship is enforced by composite foreign keys;
--   * received-event facts, processing attempts, runs and configuration audit
--     records are append-only;
--   * processing uncertainty is fail-closed: events are quarantined and
--     reassessment requests remain pending/manual-review until resolved.

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_module_workspace_id
  ON tprm_modules(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_signal_workspace_supplier_id
  ON tprm_monitoring_signals(workspace_id,supplier_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_signal_workspace_supplier_module_id
  ON tprm_monitoring_signals(workspace_id,supplier_id,module_id,id);

CREATE TABLE IF NOT EXISTS tprm_monitoring_connectors (
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
);
CREATE INDEX IF NOT EXISTS idx_tprm_connectors_workspace_status
  ON tprm_monitoring_connectors(workspace_id,status,provider_type);

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_actor_insert
BEFORE INSERT ON tprm_monitoring_connectors
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.created_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector creator must be an active consultancy user for this workspace');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_actor_update
BEFORE UPDATE ON tprm_monitoring_connectors
WHEN NEW.updated_by IS NULL OR NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.updated_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector updates require an active consultancy user for this workspace');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_active_module_insert
BEFORE INSERT ON tprm_monitoring_connectors
WHEN NEW.status='active' AND NOT EXISTS (
  SELECT 1 FROM tprm_modules m
  WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.module_id AND m.status='active'
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector cannot be active unless its module is active');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_active_module_update
BEFORE UPDATE OF status ON tprm_monitoring_connectors
WHEN NEW.status='active' AND NOT EXISTS (
  SELECT 1 FROM tprm_modules m
  WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.module_id AND m.status='active'
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector cannot be active unless its module is active');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_no_secret_config_insert
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
BEGIN
  SELECT RAISE(ABORT,'connector configuration cannot contain secret material; store a secret reference');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_no_secret_config_update
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
BEGIN
  SELECT RAISE(ABORT,'connector configuration cannot contain secret material; store a secret reference');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_identity_immutable
BEFORE UPDATE OF workspace_id,module_id,provider_type,capability_mode,name,ingress_key,created_by,created_at
ON tprm_monitoring_connectors
BEGIN
  SELECT RAISE(ABORT,'TPRM connector tenant identity and adapter type are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_status_transition
BEFORE UPDATE OF status ON tprm_monitoring_connectors
WHEN NOT (
  (OLD.status='draft' AND NEW.status IN ('active','disabled'))
  OR (OLD.status='active' AND NEW.status IN ('paused','disabled'))
  OR (OLD.status='paused' AND NEW.status IN ('active','disabled'))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM connector status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_version
BEFORE UPDATE ON tprm_monitoring_connectors
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM connector update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_no_delete
BEFORE DELETE ON tprm_monitoring_connectors
BEGIN
  SELECT RAISE(ABORT,'TPRM connector history cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_monitoring_connector_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'connector_created','connector_activated','connector_paused','connector_resumed',
    'connector_disabled','secret_reference_rotated','configuration_updated',
    'mapping_created','mapping_retired','rule_created','rule_disabled'
  )),
  actor_user_id INTEGER REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('consultancy','system')),
  actor_name TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  ))
);
CREATE INDEX IF NOT EXISTS idx_tprm_connector_audit_chain
  ON tprm_monitoring_connector_audit(workspace_id,connector_id,id);
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_actor
BEFORE INSERT ON tprm_monitoring_connector_audit
WHEN (NEW.actor_type='system' AND NEW.actor_user_id IS NOT NULL)
  OR (NEW.actor_type='consultancy' AND NOT EXISTS (
    SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
    WHERE u.id=NEW.actor_user_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
  ))
BEGIN
  SELECT RAISE(ABORT,'TPRM connector audit actor is outside this consultancy workspace');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_chain_predecessor
BEFORE INSERT ON tprm_monitoring_connector_audit
WHEN NEW.previous_event_hash IS NOT (
  SELECT event_hash FROM tprm_monitoring_connector_audit
  WHERE workspace_id=NEW.workspace_id AND connector_id=NEW.connector_id
  ORDER BY id DESC LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector audit hash-chain predecessor is invalid');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_no_update
BEFORE UPDATE ON tprm_monitoring_connector_audit
BEGIN
  SELECT RAISE(ABORT,'TPRM connector audit history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_no_delete
BEFORE DELETE ON tprm_monitoring_connector_audit
BEGIN
  SELECT RAISE(ABORT,'TPRM connector audit history cannot be deleted');
END;

-- A provider entity can be retired and remapped without rewriting the historic
-- mapping used by an earlier received event.
CREATE TABLE IF NOT EXISTS tprm_connector_supplier_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  provider_entity_id TEXT NOT NULL,
  supplier_id INTEGER NOT NULL,
  mapping_note TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  retired_by INTEGER REFERENCES users(id),
  UNIQUE(workspace_id,connector_id,id),
  UNIQUE(workspace_id,connector_id,id,supplier_id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  CHECK(length(trim(provider_entity_id)) BETWEEN 1 AND 240),
  CHECK(provider_entity_id=trim(provider_entity_id)),
  CHECK((active=1 AND valid_to IS NULL AND retired_by IS NULL)
     OR (active=0 AND valid_to IS NOT NULL AND retired_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_connector_mapping_active
  ON tprm_connector_supplier_mappings(workspace_id,connector_id,provider_entity_id)
  WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_tprm_connector_mapping_supplier
  ON tprm_connector_supplier_mappings(workspace_id,supplier_id,active);
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_actor_insert
BEFORE INSERT ON tprm_connector_supplier_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.created_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector mapping creator must be an active consultancy user');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_actor_retire
BEFORE UPDATE OF retired_by ON tprm_connector_supplier_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.retired_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector mapping retirement requires an active consultancy user');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_identity_immutable
BEFORE UPDATE OF workspace_id,connector_id,provider_entity_id,supplier_id,mapping_note,valid_from,created_by
ON tprm_connector_supplier_mappings
BEGIN
  SELECT RAISE(ABORT,'TPRM connector supplier mapping history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_retire_only
BEFORE UPDATE OF active,valid_to,retired_by ON tprm_connector_supplier_mappings
WHEN NOT (OLD.active=1 AND NEW.active=0 AND NEW.valid_to IS NOT NULL AND NEW.retired_by IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector mappings can only transition from active to retired');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_no_delete
BEFORE DELETE ON tprm_connector_supplier_mappings
BEGIN
  SELECT RAISE(ABORT,'TPRM connector supplier mapping history cannot be deleted');
END;

-- Rule definitions are immutable. Replacing a rule disables the prior version
-- and inserts a successor so historical threshold decisions remain explainable.
CREATE TABLE IF NOT EXISTS tprm_monitoring_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  rule_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  metric_path TEXT NOT NULL,
  operator TEXT NOT NULL CHECK(operator IN ('gt','gte','lt','lte','eq','neq','contains','exists')),
  threshold_json TEXT NOT NULL CHECK(json_valid(threshold_json)),
  signal_type TEXT NOT NULL CHECK(signal_type IN (
    'security_incident','breach','financial','regulatory','availability',
    'control_change','contract','concentration','news','other'
  )),
  severity TEXT NOT NULL CHECK(severity IN ('info','low','moderate','high','critical')),
  requires_reassessment INTEGER NOT NULL DEFAULT 0 CHECK(requires_reassessment IN (0,1)),
  missing_behavior TEXT NOT NULL DEFAULT 'quarantine' CHECK(missing_behavior IN ('quarantine','ignore')),
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  supersedes_id INTEGER,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_by INTEGER REFERENCES users(id),
  disabled_at TEXT,
  UNIQUE(workspace_id,connector_id,rule_key,version),
  UNIQUE(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,connector_id,supersedes_id)
    REFERENCES tprm_monitoring_rules(workspace_id,connector_id,id),
  CHECK(length(trim(rule_key)) BETWEEN 2 AND 100),
  CHECK(length(trim(metric_path)) BETWEEN 1 AND 240),
  CHECK(length(trim(title)) BETWEEN 3 AND 240),
  CHECK((enabled=1 AND disabled_by IS NULL AND disabled_at IS NULL)
     OR (enabled=0 AND disabled_by IS NOT NULL AND disabled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_monitoring_rule_enabled
  ON tprm_monitoring_rules(workspace_id,connector_id,rule_key) WHERE enabled=1;
CREATE INDEX IF NOT EXISTS idx_tprm_monitoring_rules_connector
  ON tprm_monitoring_rules(workspace_id,connector_id,enabled);
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_actor_insert
BEFORE INSERT ON tprm_monitoring_rules
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.created_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule creator must be an active consultancy user');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_actor_disable
BEFORE UPDATE OF disabled_by ON tprm_monitoring_rules
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.disabled_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule disablement requires an active consultancy user');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_identity_immutable
BEFORE UPDATE OF workspace_id,connector_id,rule_key,version,metric_path,operator,threshold_json,
  signal_type,severity,requires_reassessment,missing_behavior,title,supersedes_id,created_by,created_at
ON tprm_monitoring_rules
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule definition and lineage are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_disable_only
BEFORE UPDATE OF enabled,disabled_by,disabled_at ON tprm_monitoring_rules
WHEN NOT (OLD.enabled=1 AND NEW.enabled=0 AND NEW.disabled_by IS NOT NULL AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rules can only transition from enabled to disabled');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_no_delete
BEFORE DELETE ON tprm_monitoring_rules
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule history cannot be deleted');
END;

-- Only a cryptographic digest of the exact inbound payload is retained. The
-- normalized summary is deliberately limited by the adapter implementation.
CREATE TABLE IF NOT EXISTS tprm_monitoring_received_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  mapping_id INTEGER,
  supplier_id INTEGER,
  provider_event_id TEXT NOT NULL,
  provider_entity_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  normalized_summary_json TEXT NOT NULL CHECK(json_valid(normalized_summary_json)),
  signature_timestamp INTEGER,
  signature_digest TEXT,
  observed_at TEXT,
  received_at TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  UNIQUE(workspace_id,connector_id,id),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(workspace_id,connector_id,provider_event_id),
  UNIQUE(workspace_id,connector_id,idempotency_key),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,connector_id,mapping_id,supplier_id)
    REFERENCES tprm_connector_supplier_mappings(workspace_id,connector_id,id,supplier_id),
  FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  CHECK(length(provider_event_id) BETWEEN 1 AND 240),
  CHECK(length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)),
  CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(normalized_hash)=64 AND normalized_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK((signature_timestamp IS NULL AND signature_digest IS NULL)
     OR (signature_timestamp IS NOT NULL AND length(signature_digest)=64
         AND signature_digest NOT GLOB '*[^0-9a-f]*')),
  CHECK((mapping_id IS NULL AND supplier_id IS NULL) OR (mapping_id IS NOT NULL AND supplier_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_received_signature_replay
  ON tprm_monitoring_received_events(workspace_id,connector_id,signature_digest)
  WHERE signature_digest IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tprm_received_event_supplier
  ON tprm_monitoring_received_events(workspace_id,supplier_id,received_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_tprm_received_event_chain_predecessor
BEFORE INSERT ON tprm_monitoring_received_events
WHEN NEW.previous_event_hash IS NOT (
  SELECT event_hash FROM tprm_monitoring_received_events
  WHERE workspace_id=NEW.workspace_id AND connector_id=NEW.connector_id
  ORDER BY id DESC LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT,'TPRM received-event hash-chain predecessor is invalid');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_received_event_no_update
BEFORE UPDATE ON tprm_monitoring_received_events
BEGIN
  SELECT RAISE(ABORT,'TPRM received monitoring events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_received_event_no_delete
BEFORE DELETE ON tprm_monitoring_received_events
BEGIN
  SELECT RAISE(ABORT,'TPRM received monitoring events cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_monitoring_rule_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  received_event_id INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  matched INTEGER NOT NULL CHECK(matched IN (0,1)),
  observed_value_json TEXT CHECK(observed_value_json IS NULL OR json_valid(observed_value_json)),
  observed_value_hash TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('matched','not_matched','missing_ignored','quarantined')),
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(received_event_id,rule_id),
  FOREIGN KEY(workspace_id,connector_id,received_event_id)
    REFERENCES tprm_monitoring_received_events(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,connector_id,rule_id)
    REFERENCES tprm_monitoring_rules(workspace_id,connector_id,id),
  CHECK(observed_value_hash IS NULL OR (
    length(observed_value_hash)=64 AND observed_value_hash NOT GLOB '*[^0-9a-f]*'
  ))
);
CREATE TRIGGER IF NOT EXISTS trg_tprm_rule_evaluation_no_update
BEFORE UPDATE ON tprm_monitoring_rule_evaluations
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule evaluations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_rule_evaluation_no_delete
BEFORE DELETE ON tprm_monitoring_rule_evaluations
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule evaluations cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_monitoring_processing_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  received_event_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  status TEXT NOT NULL CHECK(status IN ('processed','duplicate','quarantined','failed')),
  supplier_id INTEGER,
  signal_id INTEGER,
  error_code TEXT,
  error_redacted TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(received_event_id,attempt_number),
  FOREIGN KEY(workspace_id,connector_id,received_event_id)
    REFERENCES tprm_monitoring_received_events(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY(workspace_id,supplier_id,signal_id)
    REFERENCES tprm_monitoring_signals(workspace_id,supplier_id,id),
  CHECK((status='processed' AND supplier_id IS NOT NULL AND signal_id IS NOT NULL AND error_code IS NULL)
     OR (status IN ('duplicate','quarantined','failed') AND signal_id IS NULL)),
  CHECK(error_redacted IS NULL OR length(error_redacted)<=1000)
);
CREATE INDEX IF NOT EXISTS idx_tprm_processing_failures
  ON tprm_monitoring_processing_attempts(workspace_id,status,completed_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_tprm_processing_attempt_no_update
BEFORE UPDATE ON tprm_monitoring_processing_attempts
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring processing attempts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_processing_attempt_no_delete
BEFORE DELETE ON tprm_monitoring_processing_attempts
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring processing attempts cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_monitoring_connector_runs (
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
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  CHECK(processed_count+duplicate_count+quarantined_count<=received_count),
  CHECK(error_redacted IS NULL OR length(error_redacted)<=1000)
);
CREATE INDEX IF NOT EXISTS idx_tprm_connector_runs_health
  ON tprm_monitoring_connector_runs(workspace_id,connector_id,completed_at DESC,id DESC);
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_run_no_update
BEFORE UPDATE ON tprm_monitoring_connector_runs
BEGIN
  SELECT RAISE(ABORT,'TPRM connector run history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_run_no_delete
BEFORE DELETE ON tprm_monitoring_connector_runs
BEGIN
  SELECT RAISE(ABORT,'TPRM connector run history cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_monitoring_connector_state (
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK(circuit_state IN ('closed','open','half_open')),
  next_allowed_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_run_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  PRIMARY KEY(workspace_id,connector_id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,connector_id,last_run_id)
    REFERENCES tprm_monitoring_connector_runs(workspace_id,connector_id,id)
);
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_state_identity
BEFORE UPDATE OF workspace_id,connector_id ON tprm_monitoring_connector_state
BEGIN
  SELECT RAISE(ABORT,'TPRM connector runtime-state identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_state_version
BEFORE UPDATE ON tprm_monitoring_connector_state
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM connector runtime-state update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_state_no_delete
BEFORE DELETE ON tprm_monitoring_connector_state
BEGIN
  SELECT RAISE(ABORT,'TPRM connector runtime state cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_reassessment_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  signal_id INTEGER NOT NULL,
  received_event_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('low','moderate','high','critical')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','manual_review')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 20),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  resulting_cycle_id INTEGER,
  last_error_code TEXT,
  last_error_redacted TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,signal_id),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY(workspace_id,supplier_id,module_id,signal_id)
    REFERENCES tprm_monitoring_signals(workspace_id,supplier_id,module_id,id),
  FOREIGN KEY(workspace_id,supplier_id,resulting_cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,received_event_id)
    REFERENCES tprm_monitoring_received_events(workspace_id,supplier_id,id),
  CHECK(length(trim(reason))>=5),
  CHECK((status='pending' AND claimed_at IS NULL AND completed_at IS NULL AND resulting_cycle_id IS NULL)
     OR (status='processing' AND claimed_at IS NOT NULL AND completed_at IS NULL AND resulting_cycle_id IS NULL)
     OR (status='completed' AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND resulting_cycle_id IS NOT NULL)
     OR (status='manual_review' AND claimed_at IS NULL AND completed_at IS NULL
         AND last_error_code IS NOT NULL)),
  CHECK(last_error_redacted IS NULL OR length(last_error_redacted)<=1000)
);
CREATE INDEX IF NOT EXISTS idx_tprm_reassessment_queue_work
  ON tprm_reassessment_queue(status,next_attempt_at,priority,created_at);
CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_identity
BEFORE UPDATE OF workspace_id,supplier_id,module_id,signal_id,received_event_id,reason,priority,
  max_attempts,created_at
ON tprm_reassessment_queue
BEGIN
  SELECT RAISE(ABORT,'TPRM reassessment request identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_transition
BEFORE UPDATE OF status ON tprm_reassessment_queue
WHEN NOT (
  (OLD.status='pending' AND NEW.status='processing')
  OR (OLD.status='processing' AND NEW.status IN ('pending','completed','manual_review'))
  OR (OLD.status='manual_review' AND NEW.status='pending')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM reassessment queue transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_version
BEFORE UPDATE ON tprm_reassessment_queue
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM reassessment queue update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_no_delete
BEFORE DELETE ON tprm_reassessment_queue
BEGIN
  SELECT RAISE(ABORT,'TPRM reassessment queue history cannot be deleted');
END;
