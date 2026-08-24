-- 047_tprm_relationships_concentration.sql
-- Service-relationship, dependency-chain, exit-readiness and concentration
-- foundation for the standalone TPRM module.
--
-- This migration is additive and forward-only. A legacy suppliers row is a
-- compatibility anchor, not a service relationship. Each existing row is
-- therefore preserved and receives its own legal-entity record plus exactly
-- one primary service relationship. Names are never used as identity and are
-- never merged, within or across client workspaces.

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_workspace_id
  ON suppliers(workspace_id,id);

CREATE TABLE IF NOT EXISTS tprm_legal_entities (
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
);
CREATE INDEX IF NOT EXISTS idx_tprm_legal_entities_name
  ON tprm_legal_entities(workspace_id,legal_name);
CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_identity_immutable
BEFORE UPDATE OF workspace_id,supplier_id,identity_source,created_by,created_at
ON tprm_legal_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM legal entity tenant identity and provenance are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_version
BEFORE UPDATE ON tprm_legal_entities
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM legal entity update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_status_transition
BEFORE UPDATE OF status ON tprm_legal_entities
WHEN NOT (
  (OLD.status='unknown' AND NEW.status IN ('active','inactive','merged','dissolved'))
  OR (OLD.status='active' AND NEW.status IN ('inactive','merged','dissolved'))
  OR (OLD.status='inactive' AND NEW.status IN ('active','merged','dissolved'))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM legal entity status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_no_delete
BEFORE DELETE ON tprm_legal_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM legal entity history cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_service_relationships (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_relationship_primary_supplier
  ON tprm_service_relationships(workspace_id,supplier_id) WHERE is_primary=1;
CREATE INDEX IF NOT EXISTS idx_tprm_relationship_portfolio
  ON tprm_service_relationships(workspace_id,status,criticality,service_category);
CREATE INDEX IF NOT EXISTS idx_tprm_relationship_legal_entity
  ON tprm_service_relationships(workspace_id,legal_entity_id,status);
CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_identity_immutable
BEFORE UPDATE OF workspace_id,supplier_id,legal_entity_id,relationship_key,source,is_primary,
  idempotency_key,request_fingerprint,created_by,created_at
ON tprm_service_relationships
BEGIN
  SELECT RAISE(ABORT,'TPRM service relationship tenant identity and provenance are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_version
BEFORE UPDATE ON tprm_service_relationships
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM service relationship update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_status_transition
BEFORE UPDATE OF status ON tprm_service_relationships
WHEN NOT (
  (OLD.status='intake' AND NEW.status IN ('active','rejected','offboarding'))
  OR (OLD.status='active' AND NEW.status IN ('suspended','offboarding'))
  OR (OLD.status='suspended' AND NEW.status IN ('active','offboarding'))
  OR (OLD.status='offboarding' AND NEW.status IN ('active','terminated'))
  OR (OLD.status='rejected' AND NEW.status='intake')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM service relationship status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_no_delete
BEFORE DELETE ON tprm_service_relationships
BEGIN
  SELECT RAISE(ABORT,'TPRM service relationship history cannot be deleted');
END;

-- Immutable contract snapshots. Renewal, termination and correction are new
-- versions in the same family, so an earlier executed baseline never changes.
CREATE TABLE IF NOT EXISTS tprm_relationship_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  contract_family_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  supersedes_id INTEGER,
  contract_type TEXT NOT NULL
    CHECK(contract_type IN ('msa','order_form','dpa','sla','licence','statement_of_work','other')),
  status TEXT NOT NULL
    CHECK(status IN ('draft','under_review','executed','expired','terminated')),
  title TEXT NOT NULL,
  reference TEXT,
  effective_date TEXT,
  end_date TEXT,
  renewal_date TEXT,
  notice_deadline TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(auto_renew IN (0,1)),
  committed_spend_minor INTEGER CHECK(committed_spend_minor IS NULL OR committed_spend_minor>=0),
  currency TEXT,
  termination_rights TEXT,
  transition_assistance TEXT,
  data_return_deletion_terms TEXT,
  audit_rights TEXT,
  incident_notification_hours INTEGER
    CHECK(incident_notification_hours IS NULL OR incident_notification_hours>=0),
  subprocessor_controls TEXT,
  governing_law_country_code TEXT,
  document_sha256 TEXT,
  contract_hash TEXT NOT NULL,
  previous_contract_hash TEXT,
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,relationship_id,contract_family_key,version),
  UNIQUE(workspace_id,relationship_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(workspace_id,idempotency_key),
  UNIQUE(contract_hash),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,relationship_id,supersedes_id)
    REFERENCES tprm_relationship_contracts(workspace_id,relationship_id,id),
  CHECK(length(trim(contract_family_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(title))>=2),
  CHECK(status NOT IN ('executed','expired','terminated') OR (
    length(trim(COALESCE(reference,'')))>=2 AND effective_date IS NOT NULL
  )),
  CHECK(currency IS NULL OR (
    length(currency)=3 AND currency=upper(currency) AND currency NOT GLOB '*[^A-Z]*'
  )),
  CHECK(committed_spend_minor IS NULL OR currency IS NOT NULL),
  CHECK(governing_law_country_code IS NULL OR (
    length(governing_law_country_code)=2
    AND governing_law_country_code=upper(governing_law_country_code)
    AND governing_law_country_code NOT GLOB '*[^A-Z]*'
  )),
  CHECK(document_sha256 IS NULL OR (
    length(document_sha256)=64 AND document_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(contract_hash)=64 AND contract_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_contract_hash IS NULL OR (
    length(previous_contract_hash)=64 AND previous_contract_hash NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  ))
);
CREATE INDEX IF NOT EXISTS idx_tprm_contract_current
  ON tprm_relationship_contracts(workspace_id,relationship_id,contract_family_key,version DESC);
CREATE INDEX IF NOT EXISTS idx_tprm_contract_renewal
  ON tprm_relationship_contracts(workspace_id,renewal_date,notice_deadline);
CREATE TRIGGER IF NOT EXISTS trg_tprm_contract_lineage
BEFORE INSERT ON tprm_relationship_contracts
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_relationship_contracts prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.relationship_id=NEW.relationship_id
      AND prior.contract_family_key=NEW.contract_family_key
      AND NEW.version=prior.version+1
      AND NEW.previous_contract_hash=prior.contract_hash
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM contract version lineage');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_contract_no_update
BEFORE UPDATE ON tprm_relationship_contracts
BEGIN
  SELECT RAISE(ABORT,'TPRM contract snapshots are immutable; add a successor version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_contract_no_delete
BEFORE DELETE ON tprm_relationship_contracts
BEGIN
  SELECT RAISE(ABORT,'TPRM contract snapshots cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_business_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  owner_name TEXT,
  criticality TEXT NOT NULL DEFAULT 'moderate'
    CHECK(criticality IN ('low','moderate','high','critical')),
  impact_tolerance_hours INTEGER CHECK(impact_tolerance_hours IS NULL OR impact_tolerance_hours>=0),
  rto_hours INTEGER CHECK(rto_hours IS NULL OR rto_hours>=0),
  rpo_hours INTEGER CHECK(rpo_hours IS NULL OR rpo_hours>=0),
  regulatory_designations_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(regulatory_designations_json) AND json_type(regulatory_designations_json)='array'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,service_key),
  UNIQUE(workspace_id,id),
  CHECK(length(trim(service_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(name))>=2)
);
CREATE INDEX IF NOT EXISTS idx_tprm_business_service_criticality
  ON tprm_business_services(workspace_id,status,criticality);
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_identity_immutable
BEFORE UPDATE OF workspace_id,service_key,created_by,created_at ON tprm_business_services
BEGIN
  SELECT RAISE(ABORT,'TPRM business service identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_version
BEFORE UPDATE ON tprm_business_services
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM business service update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_status_transition
BEFORE UPDATE OF status ON tprm_business_services
WHEN NOT (OLD.status='active' AND NEW.status='retired')
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM business service status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_no_delete
BEFORE DELETE ON tprm_business_services
BEGIN
  SELECT RAISE(ABORT,'TPRM business service history cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_relationship_business_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  business_service_id INTEGER NOT NULL,
  dependency_type TEXT NOT NULL
    CHECK(dependency_type IN ('essential','significant','supporting')),
  criticality TEXT NOT NULL
    CHECK(criticality IN ('low','moderate','high','critical')),
  minimum_capacity_percent INTEGER
    CHECK(minimum_capacity_percent IS NULL OR minimum_capacity_percent BETWEEN 0 AND 100),
  maximum_outage_hours INTEGER CHECK(maximum_outage_hours IS NULL OR maximum_outage_hours>=0),
  manual_workaround TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,business_service_id)
    REFERENCES tprm_business_services(workspace_id,id),
  CHECK((status='ended')=(ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_business_dependency_active
  ON tprm_relationship_business_dependencies(workspace_id,relationship_id,business_service_id,dependency_type)
  WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_tprm_business_dependency_service
  ON tprm_relationship_business_dependencies(workspace_id,business_service_id,status,criticality);
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_identity_immutable
BEFORE UPDATE OF workspace_id,relationship_id,business_service_id,dependency_type,effective_from,created_by
ON tprm_relationship_business_dependencies
BEGIN
  SELECT RAISE(ABORT,'TPRM business dependency identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_version
BEFORE UPDATE ON tprm_relationship_business_dependencies
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM business dependency update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_status_transition
BEFORE UPDATE OF status ON tprm_relationship_business_dependencies
WHEN NOT (OLD.status='active' AND NEW.status='ended')
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM business dependency status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_no_delete
BEFORE DELETE ON tprm_relationship_business_dependencies
BEGIN
  SELECT RAISE(ABORT,'TPRM business dependency history cannot be deleted');
END;

-- External dependency entities are explicitly identified inventory records.
-- Reusing an entity_key is an authorised linking action; a matching name alone
-- never causes a merge.
CREATE TABLE IF NOT EXISTS tprm_dependency_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_key TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL
    CHECK(entity_type IN ('subprocessor','fourth_party','infrastructure_provider','other')),
  legal_country_code TEXT,
  registration_number TEXT,
  parent_entity_name TEXT,
  known_supplier_id INTEGER,
  source TEXT NOT NULL DEFAULT 'user_disclosed'
    CHECK(source IN ('user_disclosed','provider_disclosed','contractual','import')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,entity_key),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,known_supplier_id) REFERENCES suppliers(workspace_id,id),
  CHECK(length(trim(entity_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(name))>=2),
  CHECK(legal_country_code IS NULL OR (
    length(legal_country_code)=2 AND legal_country_code=upper(legal_country_code)
      AND legal_country_code NOT GLOB '*[^A-Z]*'
  ))
);
CREATE INDEX IF NOT EXISTS idx_tprm_dependency_entity_name
  ON tprm_dependency_entities(workspace_id,name);
CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_entity_no_update
BEFORE UPDATE ON tprm_dependency_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency entity identity is immutable; create a corrected record');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_entity_no_delete
BEFORE DELETE ON tprm_dependency_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency entity history cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_dependency_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  source_relationship_id INTEGER NOT NULL,
  edge_key TEXT NOT NULL,
  target_relationship_id INTEGER,
  dependency_entity_id INTEGER,
  dependency_type TEXT NOT NULL
    CHECK(dependency_type IN ('subprocessor','fourth_party','cloud','infrastructure','payment','identity','data','other')),
  service_description TEXT NOT NULL,
  data_access TEXT NOT NULL DEFAULT 'unknown'
    CHECK(data_access IN ('none','internal','confidential','restricted','mixed','unknown')),
  countries_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(countries_json) AND json_type(countries_json)='array'),
  criticality TEXT NOT NULL DEFAULT 'moderate'
    CHECK(criticality IN ('low','moderate','high','critical')),
  concentration_key TEXT,
  single_point_of_failure INTEGER NOT NULL DEFAULT 0 CHECK(single_point_of_failure IN (0,1)),
  substitutability TEXT NOT NULL DEFAULT 'unknown'
    CHECK(substitutability IN ('readily_substitutable','substitutable_with_effort','difficult','not_substitutable','unknown')),
  due_diligence_required INTEGER NOT NULL DEFAULT 1 CHECK(due_diligence_required IN (0,1)),
  evidence_summary TEXT,
  status TEXT NOT NULL DEFAULT 'disclosed'
    CHECK(status IN ('disclosed','under_review','approved','rejected','ended')),
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,source_relationship_id,edge_key),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,source_relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,target_relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,dependency_entity_id)
    REFERENCES tprm_dependency_entities(workspace_id,id),
  CHECK((target_relationship_id IS NOT NULL)+(dependency_entity_id IS NOT NULL)=1),
  CHECK(target_relationship_id IS NULL OR target_relationship_id<>source_relationship_id),
  CHECK(length(trim(edge_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(service_description))>=2),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  )),
  CHECK((status='ended')=(ended_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tprm_dependency_edge_target
  ON tprm_dependency_edges(workspace_id,target_relationship_id,status,criticality);
CREATE INDEX IF NOT EXISTS idx_tprm_dependency_edge_entity
  ON tprm_dependency_edges(workspace_id,dependency_entity_id,status,criticality);
CREATE INDEX IF NOT EXISTS idx_tprm_dependency_edge_concentration
  ON tprm_dependency_edges(workspace_id,concentration_key,status);
CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_identity_immutable
BEFORE UPDATE OF workspace_id,source_relationship_id,edge_key,target_relationship_id,
  dependency_entity_id,dependency_type,effective_from,idempotency_key,request_fingerprint,created_by,created_at
ON tprm_dependency_edges
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency edge identity and provenance are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_version
BEFORE UPDATE ON tprm_dependency_edges
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency edge update requires the next row version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_status_transition
BEFORE UPDATE OF status ON tprm_dependency_edges
WHEN NOT (
  (OLD.status='disclosed' AND NEW.status IN ('under_review','approved','rejected','ended'))
  OR (OLD.status='under_review' AND NEW.status IN ('approved','rejected','ended'))
  OR (OLD.status='approved' AND NEW.status='ended')
  OR (OLD.status='rejected' AND NEW.status='under_review')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM dependency edge status transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_no_delete
BEFORE DELETE ON tprm_dependency_edges
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency edge history cannot be deleted');
END;

-- Location facts are append-only versioned assertions. This makes residency
-- changes visible rather than silently replacing the former hosting footprint.
CREATE TABLE IF NOT EXISTS tprm_relationship_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  location_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  supersedes_id INTEGER,
  exposure_type TEXT NOT NULL
    CHECK(exposure_type IN ('legal_entity','service_delivery','data_processing','data_storage','backup','support','administration')),
  country_code TEXT NOT NULL,
  region TEXT,
  site_reference TEXT,
  data_categories_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(data_categories_json) AND json_type(data_categories_json)='array'),
  transfer_mechanism TEXT NOT NULL DEFAULT 'unknown'
    CHECK(transfer_mechanism IN ('adequacy','scc','bcr','derogation','local_only','not_applicable','unknown')),
  criticality TEXT NOT NULL DEFAULT 'moderate'
    CHECK(criticality IN ('low','moderate','high','critical')),
  status TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('planned','current','exited')),
  effective_from TEXT,
  effective_to TEXT,
  assertion_source TEXT NOT NULL DEFAULT 'user_maintained'
    CHECK(assertion_source IN ('user_maintained','contract','provider_disclosure','evidence','import')),
  assertion_hash TEXT NOT NULL,
  previous_assertion_hash TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,relationship_id,location_key,version),
  UNIQUE(workspace_id,relationship_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(assertion_hash),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,relationship_id,supersedes_id)
    REFERENCES tprm_relationship_locations(workspace_id,relationship_id,id),
  CHECK(length(trim(location_key)) BETWEEN 3 AND 100),
  CHECK(length(country_code)=2 AND country_code=upper(country_code) AND country_code NOT GLOB '*[^A-Z]*'),
  CHECK(status!='exited' OR effective_to IS NOT NULL),
  CHECK(length(assertion_hash)=64 AND assertion_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_assertion_hash IS NULL OR (
    length(previous_assertion_hash)=64 AND previous_assertion_hash NOT GLOB '*[^0-9a-f]*'
  ))
);
CREATE INDEX IF NOT EXISTS idx_tprm_location_country
  ON tprm_relationship_locations(workspace_id,country_code,exposure_type,status);
CREATE TRIGGER IF NOT EXISTS trg_tprm_location_lineage
BEFORE INSERT ON tprm_relationship_locations
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_relationship_locations prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.relationship_id=NEW.relationship_id
      AND prior.location_key=NEW.location_key
      AND NEW.version=prior.version+1
      AND NEW.previous_assertion_hash=prior.assertion_hash
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM location assertion lineage');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_location_no_update
BEFORE UPDATE ON tprm_relationship_locations
BEGIN
  SELECT RAISE(ABORT,'TPRM location assertions are immutable; add a successor version');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_location_no_delete
BEFORE DELETE ON tprm_relationship_locations
BEGIN
  SELECT RAISE(ABORT,'TPRM location assertions cannot be deleted');
END;

-- Assessment cycles remain supplier-governed for compatibility. This bridge
-- declares the exact service relationships in scope without rewriting a cycle.
CREATE TABLE IF NOT EXISTS tprm_cycle_relationship_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  scope_role TEXT NOT NULL DEFAULT 'in_scope'
    CHECK(scope_role IN ('primary','in_scope','supporting')),
  scope_rationale TEXT,
  linked_by INTEGER REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,cycle_id,relationship_id),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,supplier_id,id)
);
CREATE INDEX IF NOT EXISTS idx_tprm_cycle_relationship_scope
  ON tprm_cycle_relationship_scopes(workspace_id,relationship_id,cycle_id);
CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_relationship_scope_no_update
BEFORE UPDATE ON tprm_cycle_relationship_scopes
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment relationship scope is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_relationship_scope_no_delete
BEFORE DELETE ON tprm_cycle_relationship_scopes
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment relationship scope cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_relationship_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relationship_id INTEGER,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'legacy_relationship_backfilled','relationship_created','relationship_updated','relationship_status_changed',
    'contract_version_added','dependency_edge_added','dependency_status_changed',
    'business_dependency_added','business_dependency_ended','location_version_added','cycle_scope_linked'
  )),
  actor_user_id INTEGER REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('consultant','consultancy_manager','client','system','migration')),
  actor_name TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  idempotency_key TEXT,
  previous_event_hash TEXT,
  event_hash TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,idempotency_key),
  UNIQUE(event_hash),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  )),
  CHECK(event_hash IS NULL OR (length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  ))
);
CREATE INDEX IF NOT EXISTS idx_tprm_relationship_event_history
  ON tprm_relationship_events(workspace_id,relationship_id,occurred_at,id);
CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_no_update
BEFORE UPDATE ON tprm_relationship_events
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_no_delete
BEFORE DELETE ON tprm_relationship_events
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship events cannot be deleted');
END;

-- ---------- Conservative legacy backfill ----------

INSERT INTO tprm_legal_entities(
  workspace_id,supplier_id,legal_name,trading_name,parent_entity_name,status,
  identity_source,created_at,updated_at
)
SELECT s.workspace_id,s.id,s.name,NULL,NULLIF(trim(s.parent_company),''),
       CASE WHEN s.archived_at IS NOT NULL OR s.terminated_at IS NOT NULL THEN 'inactive' ELSE 'unknown' END,
       'legacy_supplier_backfill',COALESCE(s.created_at,datetime('now')),COALESCE(s.created_at,datetime('now'))
FROM suppliers s
WHERE NOT EXISTS (
  SELECT 1 FROM tprm_legal_entities le
  WHERE le.workspace_id=s.workspace_id AND le.supplier_id=s.id
);

INSERT INTO tprm_service_relationships(
  workspace_id,supplier_id,legal_entity_id,relationship_key,relationship_name,
  service_category,service_description,status,criticality,data_access,
  relationship_owner,business_owner,security_owner,start_date,target_end_date,
  rto_hours,rpo_hours,substitutability,exit_strategy,sole_source,
  legacy_annual_spend_text,legacy_location_text,legacy_hosting_locations_text,
  legacy_data_categories_text,legacy_critical_processes_text,source,is_primary,
  created_at,updated_at,offboarding_started_at,terminated_at
)
SELECT s.workspace_id,s.id,le.id,'legacy-supplier-'||s.id,
       CASE WHEN trim(COALESCE(s.service_provided,''))<>'' THEN s.name||' - '||s.service_provided ELSE s.name END,
       NULLIF(trim(s.service_category),''),
       COALESCE(NULLIF(trim(s.service_provided),''),'Legacy service relationship; description requires review.'),
       CASE
         WHEN s.archived_at IS NOT NULL OR s.terminated_at IS NOT NULL THEN 'terminated'
         WHEN lower(trim(COALESCE(s.lifecycle_stage,'')))='offboarding' THEN 'offboarding'
         WHEN lower(trim(COALESCE(s.lifecycle_stage,'')))='rejected' THEN 'rejected'
         WHEN lower(trim(COALESCE(s.lifecycle_stage,''))) IN ('prospect','intake','onboarding') THEN 'intake'
         WHEN lower(trim(COALESCE(s.lifecycle_stage,'')))='suspended' THEN 'suspended'
         ELSE 'active'
       END,
       CASE lower(trim(COALESCE(s.business_criticality,'')))
         WHEN 'low' THEN 'low' WHEN 'medium' THEN 'moderate' WHEN 'moderate' THEN 'moderate'
         WHEN 'high' THEN 'high' WHEN 'critical' THEN 'critical' ELSE 'unknown' END,
       CASE lower(trim(COALESCE(s.data_access,'')))
         WHEN 'none' THEN 'none' WHEN 'internal' THEN 'internal' WHEN 'confidential' THEN 'confidential'
         WHEN 'restricted' THEN 'restricted' WHEN 'mixed' THEN 'mixed' ELSE 'unknown' END,
       NULLIF(trim(s.relationship_owner),''),NULLIF(trim(s.business_owner),''),NULLIF(trim(s.security_reviewer),''),
       CASE WHEN length(trim(COALESCE(s.contract_start,'')))=10 THEN s.contract_start END,
       CASE WHEN length(trim(COALESCE(s.contract_end,'')))=10 THEN s.contract_end END,
       CASE WHEN s.rto_hours>=0 THEN s.rto_hours END,
       CASE WHEN s.rpo_hours>=0 THEN s.rpo_hours END,
       CASE WHEN lower(trim(COALESCE(s.dependency_type,'')))='sole_source' THEN 'not_substitutable' ELSE 'unknown' END,
       NULLIF(trim(s.exit_strategy),''),
       CASE WHEN lower(trim(COALESCE(s.dependency_type,'')))='sole_source' THEN 1 ELSE 0 END,
       NULLIF(trim(s.annual_spend),''),NULLIF(trim(s.location),''),NULLIF(trim(s.hosting_locations),''),
       NULLIF(trim(s.data_categories),''),NULLIF(trim(s.critical_processes),''),
       'legacy_supplier_backfill',1,COALESCE(s.created_at,datetime('now')),COALESCE(s.created_at,datetime('now')),
       CASE WHEN lower(trim(COALESCE(s.lifecycle_stage,'')))='offboarding' THEN datetime('now') END,
       CASE WHEN s.archived_at IS NOT NULL OR s.terminated_at IS NOT NULL
            THEN COALESCE(s.terminated_at,s.archived_at,datetime('now')) END
FROM suppliers s
JOIN tprm_legal_entities le ON le.workspace_id=s.workspace_id AND le.supplier_id=s.id
WHERE NOT EXISTS (
  SELECT 1 FROM tprm_service_relationships r
  WHERE r.workspace_id=s.workspace_id AND r.supplier_id=s.id AND r.is_primary=1
);

INSERT INTO tprm_cycle_relationship_scopes(
  workspace_id,supplier_id,cycle_id,relationship_id,scope_role,scope_rationale,linked_at
)
SELECT c.workspace_id,c.supplier_id,c.id,r.id,'primary',
       'Conservative migration link to the single backfilled primary service relationship.',
       datetime('now')
FROM tprm_assessment_cycles c
JOIN tprm_service_relationships r
  ON r.workspace_id=c.workspace_id AND r.supplier_id=c.supplier_id AND r.is_primary=1
WHERE NOT EXISTS (
  SELECT 1 FROM tprm_cycle_relationship_scopes x
  WHERE x.workspace_id=c.workspace_id AND x.cycle_id=c.id AND x.relationship_id=r.id
);

INSERT INTO tprm_relationship_events(
  workspace_id,relationship_id,event_type,actor_type,actor_name,reason,payload_json,occurred_at
)
SELECT r.workspace_id,r.id,'legacy_relationship_backfilled','migration','Migration 047',
       'Existing supplier inventory preserved as a distinct legal entity and primary service relationship.',
       json_object('supplier_id',r.supplier_id,'legal_entity_id',r.legal_entity_id,'relationship_key',r.relationship_key),
       r.created_at
FROM tprm_service_relationships r
WHERE r.source='legacy_supplier_backfill'
  AND NOT EXISTS (
    SELECT 1 FROM tprm_relationship_events e
    WHERE e.workspace_id=r.workspace_id AND e.relationship_id=r.id
      AND e.event_type='legacy_relationship_backfilled'
  );
