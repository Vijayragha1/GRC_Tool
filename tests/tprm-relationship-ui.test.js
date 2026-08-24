'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'relationship-ui-password-1234';

let client;
let app;
let dbPath;
let workspaceId;
let inactiveWorkspaceId;
let otherWorkspaceId;
let managerId;
let supplierA;
let supplierB;
let supplierC;
let relationshipA;
let relationshipA2;
let otherRelationship;
let viewerClient;

async function loginAs(http, email, password = PASSWORD) {
  const page = await http.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, `login CSRF token missing for ${email}`);
  const response = await http.post('/login', { email, password, _csrf: csrf }, { csrf: false });
  assert.ok(response.status >= 300 && response.status < 400, `login failed for ${email}`);
  await http.get('/dashboard');
}

function relationshipUpdate(row, overrides = {}) {
  const { minorToMajor } = require('../routes/tprm-relationships');
  return {
    expected_row_version: String(row.row_version),
    relationship_name: row.relationship_name,
    service_category: row.service_category || '',
    service_description: row.service_description,
    provision_model: row.provision_model,
    criticality: row.criticality,
    data_access: row.data_access,
    annual_spend: minorToMajor(row.annual_spend_minor, row.currency),
    currency: row.currency || '',
    relationship_owner: row.relationship_owner || '',
    business_owner: row.business_owner || '',
    security_owner: row.security_owner || '',
    procurement_owner: row.procurement_owner || '',
    start_date: row.start_date || '',
    target_end_date: row.target_end_date || '',
    rto_hours: row.rto_hours == null ? '' : String(row.rto_hours),
    rpo_hours: row.rpo_hours == null ? '' : String(row.rpo_hours),
    maximum_tolerable_disruption_hours: row.max_tolerable_disruption_hours == null ? '' : String(row.max_tolerable_disruption_hours),
    substitutability: row.substitutability,
    alternate_provider_relationship_id: row.alternate_provider_relationship_id || '',
    estimated_exit_days: row.estimated_exit_days == null ? '' : String(row.estimated_exit_days),
    exit_plan_status: row.exit_plan_status,
    last_exit_tested_at: row.last_exit_tested_at || '',
    exit_owner: row.exit_owner || '',
    exit_strategy: row.exit_strategy || '',
    transition_assistance: row.transition_assistance || '',
    data_return_deletion_requirements: row.data_return_deletion_requirements || '',
    privileged_access: row.privileged_access ? '1' : '',
    sole_source: row.sole_source ? '1' : '',
    material_outsourcing: row.material_outsourcing ? '1' : '',
    regulated_service: row.regulated_service ? '1' : '',
    reason: 'Update the governed service facts from verified client input.',
    ...overrides,
  };
}

test.before(async () => {
  ({ client, app, dbPath } = await bootClient());
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const relationships = require('../lib/tprm-relationships');
  const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  const manager = db.prepare(`SELECT id FROM users
    WHERE user_type='firm' AND firm_id=? AND firm_role='manager' ORDER BY id LIMIT 1`).get(firm.id);
  managerId = manager.id;

  workspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Relationship UI Client','[]')`).run(firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Exercise production relationship UI',?)`).run(workspaceId, managerId);

  const insertSupplier = db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage) VALUES (?,?,?,'prospect')`);
  supplierA = Number(insertSupplier.run(workspaceId, 'Same Name Provider Ltd', 'Cloud platform').lastInsertRowid);
  supplierB = Number(insertSupplier.run(workspaceId, 'Same Name Provider Ltd', 'Payment processing').lastInsertRowid);
  supplierC = Number(insertSupplier.run(workspaceId, 'Same Name Provider Ltd', 'Customer support').lastInsertRowid);

  relationshipA = relationships.createRelationship(db, {
    workspaceId, supplierId: supplierA, actorId: managerId,
    legalName: 'Same Name Provider Ltd', registrationCountryCode: 'US', registrationNumber: 'US-1001',
    relationshipKey: 'same-name-cloud', relationshipName: 'Production cloud platform',
    serviceDescription: 'Hosts the client production application and restricted customer data.',
    serviceCategory: 'Cloud infrastructure', provisionModel: 'iaas', status: 'active', criticality: 'critical',
    dataAccess: 'restricted', annualSpendMinor: 25000000, currency: 'USD', relationshipOwner: 'Lead consultant',
    businessOwner: 'Chief technology officer', securityOwner: 'Security director', procurementOwner: 'Sourcing lead',
    rtoHours: 4, rpoHours: 1, substitutability: 'difficult', soleSource: true,
    estimatedExitDays: 120, exitPlanStatus: 'documented', exitOwner: 'Continuity lead',
    exitStrategy: 'Move the service to the approved alternate platform.',
    transitionAssistance: 'Ninety days of supported transition.',
    dataReturnDeletionRequirements: 'Return data and provide a deletion certificate.',
    isPrimary: true, reason: 'Create the primary cloud service relationship for UI tests.',
    idempotencyKey: 'relationship-ui-cloud-primary-0000000000001',
  }).relationship;
  relationshipA2 = relationships.createRelationship(db, {
    workspaceId, supplierId: supplierA, actorId: managerId, legalEntityId: relationshipA.legal_entity_id,
    relationshipKey: 'same-name-analytics', relationshipName: 'Customer analytics platform',
    serviceDescription: 'Separate analytics contract and confidential-data processing scope.',
    serviceCategory: 'Analytics', provisionModel: 'saas', status: 'active', criticality: 'high',
    dataAccess: 'confidential', relationshipOwner: 'Lead consultant', businessOwner: 'Data director',
    substitutability: 'substitutable_with_effort', isPrimary: false,
    reason: 'Record a second distinct service for the same exact legal entity.',
    idempotencyKey: 'relationship-ui-analytics-secondary-00000001',
  }).relationship;
  relationships.createRelationship(db, {
    workspaceId, supplierId: supplierB, actorId: managerId,
    legalName: 'Same Name Provider Ltd', registrationCountryCode: 'GB', registrationNumber: 'GB-9002',
    relationshipKey: 'same-name-payments', relationshipName: 'Card payment processing',
    serviceDescription: 'Processes card payments under a separately identified UK legal entity.',
    serviceCategory: 'Payments', provisionModel: 'managed_service', status: 'active', criticality: 'critical',
    dataAccess: 'restricted', relationshipOwner: 'Payments consultant', businessOwner: 'Payments director',
    substitutability: 'difficult', isPrimary: true,
    reason: 'Preserve a distinct same-named provider identity in this workspace.',
    idempotencyKey: 'relationship-ui-payments-distinct-000000001',
  });
  relationships.addLocationExposure(db, {
    workspaceId, relationshipId: relationshipA.id, actorId: managerId,
    locationKey: 'production-us-east', exposureType: 'data_processing', countryCode: 'US', region: 'Virginia',
    dataCategories: ['Customer data'], transferMechanism: 'not_applicable', criticality: 'critical', status: 'current',
    assertionSource: 'contract', expectedCurrentLocationId: null,
    reason: 'Record the contract-confirmed production processing region.',
  });
  const business = relationships.createBusinessService(db, {
    workspaceId, actorId: managerId, name: 'Online customer service', description: 'Customer-facing digital service.',
    ownerName: 'Digital director', criticality: 'critical', impactToleranceHours: 4, rtoHours: 2, rpoHours: 1,
    regulatoryDesignations: ['Critical business service'],
  }).businessService;
  relationships.linkBusinessService(db, {
    workspaceId, relationshipId: relationshipA.id, actorId: managerId, businessServiceId: business.id,
    dependencyType: 'essential', criticality: 'critical', minimumCapacityPercent: 80, maximumOutageHours: 4,
    reason: 'Map the essential production hosting dependency.',
  });

  inactiveWorkspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Inactive Relationship Client','[]')`).run(firm.id).lastInsertRowid);

  otherWorkspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Other Relationship Client','[]')`).run(firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by)
    VALUES (?,'managed_lifecycle','active','Separate client tenant',?)`).run(otherWorkspaceId, managerId);
  const hiddenSupplier = Number(insertSupplier.run(otherWorkspaceId, 'Hidden Same Name Provider Ltd', 'Hidden service').lastInsertRowid);
  otherRelationship = relationships.createRelationship(db, {
    workspaceId: otherWorkspaceId, supplierId: hiddenSupplier, actorId: managerId,
    legalName: 'Hidden Same Name Provider Ltd', registrationCountryCode: 'IN', registrationNumber: 'IN-HIDDEN',
    relationshipKey: 'hidden-service', relationshipName: 'Never cross-client merge this service',
    serviceDescription: 'A separate client service that must never appear in another workspace.',
    serviceCategory: 'Confidential', provisionModel: 'saas', status: 'active', criticality: 'high', dataAccess: 'restricted',
    isPrimary: true, reason: 'Create a cross-client isolation sentinel.',
    idempotencyKey: 'relationship-ui-cross-client-hidden-00000001',
  }).relationship;
  const viewerHash = bcrypt.hashSync(PASSWORD, 4);
  const viewerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('relationship-viewer@example.test',?,'Relationship Viewer','firm',?,'consultant',1)`)
    .run(viewerHash, firm.id).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')`).run(workspaceId, viewerId);
  db.prepare(`INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted,granted_by)
    VALUES (?,?,'tprm.third_party.manage',0,?),(?,?,'tprm.monitoring.manage',0,?)`).run(
      workspaceId, viewerId, managerId, workspaceId, viewerId, managerId
    );
  db.close();

  viewerClient = makeClient(app);
  await loginAs(viewerClient, 'relationship-viewer@example.test');
});

test.after(async () => {
  if (viewerClient) await viewerClient.close();
  if (client) await client.close();
});

test('service inventory keeps legal identity separate, exposes one primary action per row and excludes other clients', async () => {
  const response = await client.get(`/workspaces/${workspaceId}/tprm/relationships`);
  assert.equal(response.status, 200);
  assert.match(response.text, /Service relationships/);
  assert.match(response.text, /Two providers with the same name are never combined/);
  assert.match(response.text, /Production cloud platform/);
  assert.match(response.text, /Customer analytics platform/);
  assert.match(response.text, /US-1001/);
  assert.match(response.text, /GB-9002/);
  assert.doesNotMatch(response.text, /Never cross-client merge this service/);
  const rows = [...response.text.matchAll(/data-relationship-record="true"/g)].length;
  const actions = [...response.text.matchAll(/data-primary-action="true"/g)].length;
  assert.equal(actions, rows, 'each relationship row must expose exactly one primary next action');
});

test('detail and concentration pages provide exact drilldowns, evidence limits and exit-readiness actions', async () => {
  const detail = await client.get(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}`);
  assert.equal(detail.status, 200);
  for (const label of ['Exact provider identity', 'Primary next action', 'Immutable version history', 'Fourth parties and service chain', 'Exit readiness']) {
    assert.match(detail.text, new RegExp(label));
  }
  assert.match(detail.text, /US-1001/);
  assert.match(detail.text, /Service status; separate from assessment stage|does not replace assessment stages/i);
  assert.doesNotMatch(detail.text, /Relationship ID|Legal entity ID|Supplier ID/);

  const concentration = await client.get(`/workspaces/${workspaceId}/tprm/concentration`);
  assert.equal(concentration.status, 200);
  assert.match(concentration.text, /External intelligence applied:\s*<strong>No<\/strong>/);
  assert.match(concentration.text, /One provider, multiple services/);
  assert.match(concentration.text, new RegExp(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}`));
  assert.match(concentration.text, new RegExp(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA2.id}`));
  assert.match(concentration.text, /Online customer service/);
  assert.match(concentration.text, /No current locations recorded|Location concentration/);
  assert.doesNotMatch(concentration.text, /Never cross-client merge this service/);
});

test('creating another same-named provider service preserves a distinct legal identity and begins in intake', async () => {
  const response = await client.post(`/workspaces/${workspaceId}/tprm/relationships`, {
    supplier_id: String(supplierC),
    legal_name: 'Same Name Provider Ltd',
    registration_country_code: 'SG',
    registration_number: 'SG-3003',
    relationship_name: 'Customer support service',
    service_category: 'Customer operations',
    service_description: 'Provides follow-the-sun customer support with internal-data access.',
    provision_model: 'managed_service',
    criticality: 'moderate',
    data_access: 'internal',
    substitutability: 'substitutable_with_effort',
    relationship_owner: 'Support consultant',
    business_owner: 'Customer operations director',
    reason: 'Create the separately identified support service relationship.',
    idempotency_key: 'relationship-ui-http-create-000000000000001',
  });
  assert.equal(response.status, 303);
  const db = new Database(dbPath, { readonly: true });
  const created = db.prepare(`SELECT r.*,le.registration_country_code,le.registration_number
    FROM tprm_service_relationships r JOIN tprm_legal_entities le ON le.id=r.legal_entity_id
    WHERE r.workspace_id=? AND r.supplier_id=?`).get(workspaceId, supplierC);
  const identities = db.prepare(`SELECT COUNT(DISTINCT legal_entity_id) AS count
    FROM tprm_service_relationships WHERE workspace_id=? AND supplier_id IN (?,?,?)`).get(workspaceId, supplierA, supplierB, supplierC);
  db.close();
  assert.equal(created.status, 'intake');
  assert.equal(created.registration_country_code, 'SG');
  assert.equal(created.registration_number, 'SG-3003');
  assert.equal(identities.count, 3, 'same-named provider records must remain distinct identities');
});

test('relationship update and operating-status changes reject stale versions instead of overwriting', async () => {
  let db = new Database(dbPath, { readonly: true });
  const opened = db.prepare('SELECT * FROM tprm_service_relationships WHERE id=?').get(relationshipA.id);
  db.close();
  const first = await client.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/update`, relationshipUpdate(opened, {
    procurement_owner: 'Enterprise sourcing director',
  }));
  assert.equal(first.status, 303);
  const stale = await client.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/update`, relationshipUpdate(opened, {
    procurement_owner: 'Stale overwrite attempt',
  }));
  assert.equal(stale.status, 409);
  assert.match(stale.text, /changed after it was opened|Refresh and try again/i);
  db = new Database(dbPath, { readonly: true });
  const current = db.prepare('SELECT * FROM tprm_service_relationships WHERE id=?').get(relationshipA.id);
  db.close();
  assert.equal(current.procurement_owner, 'Enterprise sourcing director');

  const status = await client.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/status`, {
    expected_row_version: String(current.row_version), status: 'rejected',
    reason: 'Reject the intake service after the scoped assessment did not support onboarding.',
  });
  assert.equal(status.status, 303);
  const staleStatus = await client.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/status`, {
    expected_row_version: String(current.row_version), status: 'offboarding',
    reason: 'This stale transition must not overwrite the newer operating state.',
  });
  assert.equal(staleStatus.status, 409);
});

test('contract successors are immutable, hash-linked and stale family versions are refused', async () => {
  const endpoint = `/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/contracts`;
  const first = await client.post(endpoint, {
    expected_current_contract_id: '', idempotency_key: 'relationship-ui-contract-v1-0000000000000001',
    contract_family_key: 'production-cloud-msa', contract_type: 'msa', status: 'executed',
    title: 'Production cloud master services agreement', reference: 'MSA-2026-100', effective_date: '2026-01-01',
    end_date: '2027-12-31', notice_deadline: '2027-09-30', auto_renew: '1', committed_spend: '250000.00', currency: 'USD',
    termination_rights: 'Terminate for material security or availability breach.',
    transition_assistance: 'Ninety days of supported migration.', data_return_deletion_terms: 'Return and verified deletion within thirty days.',
    audit_rights: 'Annual evidence review and audit for cause.', incident_notification_hours: '24',
    subprocessor_controls: 'Prior notice and objection rights.', governing_law_country_code: 'US', document_sha256: 'a'.repeat(64),
    reason: 'Record the executed contract baseline and resilience terms.',
  });
  assert.equal(first.status, 303);
  let db = new Database(dbPath, { readonly: true });
  const v1 = db.prepare(`SELECT * FROM tprm_relationship_contracts
    WHERE workspace_id=? AND relationship_id=? AND contract_family_key='production-cloud-msa'`).get(workspaceId, relationshipA.id);
  db.close();
  assert.ok(v1);
  const successorBody = {
    expected_current_contract_id: String(v1.id), idempotency_key: 'relationship-ui-contract-v2-0000000000000002',
    contract_family_key: 'production-cloud-msa', contract_type: 'msa', status: 'executed',
    title: 'Production cloud agreement renewal', reference: 'MSA-2028-101', effective_date: '2028-01-01',
    end_date: '2029-12-31', notice_deadline: '2029-09-30', committed_spend: '275000.00', currency: 'USD',
    termination_rights: 'Terminate for material breach.', transition_assistance: 'One hundred twenty days of migration support.',
    data_return_deletion_terms: 'Verified deletion within thirty days.', audit_rights: 'Annual evidence review.',
    incident_notification_hours: '24', subprocessor_controls: 'Prior notice.', governing_law_country_code: 'US',
    document_sha256: 'b'.repeat(64), reason: 'Record the signed renewal without modifying the executed baseline.',
  };
  const second = await client.post(endpoint, successorBody);
  assert.equal(second.status, 303);
  const stale = await client.post(endpoint, { ...successorBody, idempotency_key: 'relationship-ui-contract-stale-000000000001', title: 'Stale successor attempt' });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /Contract family changed|Refresh and try again/i);
  db = new Database(dbPath, { readonly: true });
  const versions = db.prepare(`SELECT * FROM tprm_relationship_contracts
    WHERE workspace_id=? AND relationship_id=? AND contract_family_key='production-cloud-msa' ORDER BY version`).all(workspaceId, relationshipA.id);
  db.close();
  assert.equal(versions.length, 2);
  assert.equal(versions[0].title, 'Production cloud master services agreement');
  assert.equal(versions[1].supersedes_id, versions[0].id);
  assert.equal(versions[1].previous_contract_hash, versions[0].contract_hash);
});

test('location changes create immutable successor assertions and reject a stale location family', async () => {
  let db = new Database(dbPath, { readonly: true });
  const current = db.prepare(`SELECT * FROM tprm_relationship_locations
    WHERE workspace_id=? AND relationship_id=? AND location_key='production-us-east'
      AND NOT EXISTS (SELECT 1 FROM tprm_relationship_locations n WHERE n.supersedes_id=tprm_relationship_locations.id)`)
    .get(workspaceId, relationshipA.id);
  db.close();
  assert.ok(current);
  const endpoint = `/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/locations`;
  const successor = {
    expected_current_location_id: String(current.id), location_key: 'production-us-east',
    exposure_type: 'data_processing', country_code: 'US', region: 'Oregon', site_reference: 'Contract region us-west',
    data_categories: 'Customer data, Authentication data', transfer_mechanism: 'not_applicable', criticality: 'critical',
    status: 'current', effective_from: '2026-10-01', effective_to: '', assertion_source: 'contract',
    reason: 'Record the executed relocation amendment as a successor assertion.',
  };
  const saved = await client.post(endpoint, successor);
  assert.equal(saved.status, 303);
  const stale = await client.post(endpoint, { ...successor, region: 'Stale region', reason: 'Attempt a stale location successor.' });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /Location assertion changed|Refresh and try again/i);
  db = new Database(dbPath, { readonly: true });
  const versions = db.prepare(`SELECT * FROM tprm_relationship_locations
    WHERE workspace_id=? AND relationship_id=? AND location_key='production-us-east' ORDER BY version`).all(workspaceId, relationshipA.id);
  db.close();
  assert.equal(versions.length, 2);
  assert.equal(versions[0].region, 'Virginia');
  assert.equal(versions[1].region, 'Oregon');
  assert.equal(versions[1].supersedes_id, versions[0].id);
  assert.equal(versions[1].previous_assertion_hash, versions[0].assertion_hash);
});

test('business-service creation, exact relationship mapping and governed ending work end to end', async () => {
  const created = await client.post(`/workspaces/${workspaceId}/tprm/business-services`, {
    name: 'Resilience testing service', owner_name: 'Continuity director', criticality: 'high',
    impact_tolerance_hours: '8', rto_hours: '4', rpo_hours: '2',
    regulatory_designations: 'Important business service, Material service',
    description: 'Client service used to test alternate-provider and continuity capability.',
  });
  assert.equal(created.status, 303);
  let db = new Database(dbPath, { readonly: true });
  const business = db.prepare(`SELECT * FROM tprm_business_services
    WHERE workspace_id=? AND name='Resilience testing service'`).get(workspaceId);
  db.close();
  assert.ok(business);

  const linkEndpoint = `/workspaces/${workspaceId}/tprm/relationships/${relationshipA2.id}/business-services`;
  const linked = await client.post(linkEndpoint, {
    business_service_id: String(business.id), dependency_type: 'significant', criticality: 'high',
    minimum_capacity_percent: '60', maximum_outage_hours: '8', manual_workaround: 'Use a controlled manual reporting extract.',
    reason: 'Map the analytics relationship to the resilience testing service.',
  });
  assert.equal(linked.status, 303);
  db = new Database(dbPath, { readonly: true });
  const dependency = db.prepare(`SELECT * FROM tprm_relationship_business_dependencies
    WHERE workspace_id=? AND relationship_id=? AND business_service_id=? AND status='active'`).get(
      workspaceId, relationshipA2.id, business.id
    );
  db.close();
  assert.ok(dependency);

  const endEndpoint = `${linkEndpoint}/${dependency.id}/end`;
  const ended = await client.post(endEndpoint, {
    expected_row_version: String(dependency.row_version), reason: 'The client confirmed this business dependency has ended.',
  });
  assert.equal(ended.status, 303);
  const stale = await client.post(endEndpoint, {
    expected_row_version: String(dependency.row_version), reason: 'A stale request cannot end the same mapping twice.',
  });
  assert.equal(stale.status, 409);
});

test('dependency disclosure and review enforce CSRF, tenant scope and optimistic concurrency', async () => {
  const endpoint = `/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/dependencies`;
  const disclosed = await client.post(endpoint, {
    target_kind: 'new_entity', dependency_entity_key: 'relationship-ui-external-identity-0001',
    dependency_entity_name: 'Shared Compute Backbone Ltd', dependency_entity_type: 'infrastructure_provider',
    dependency_country_code: 'US', dependency_registration_number: 'US-BACKBONE-1', dependency_source: 'provider_disclosed',
    dependency_type: 'infrastructure', service_description: 'Underlying compute and network infrastructure.',
    data_access: 'restricted', countries: 'US, IE', criticality: 'critical', concentration_key: 'shared-compute-backbone',
    single_point_of_failure: '1', substitutability: 'difficult', due_diligence_required: '1',
    evidence_summary: 'Provider architecture disclosure dated 2026-08-20.',
    reason: 'Record the disclosed critical fourth-party infrastructure dependency.',
    idempotency_key: 'relationship-ui-dependency-create-0000000001',
  });
  assert.equal(disclosed.status, 303);
  let db = new Database(dbPath, { readonly: true });
  const edge = db.prepare(`SELECT * FROM tprm_dependency_edges
    WHERE workspace_id=? AND source_relationship_id=? ORDER BY id DESC LIMIT 1`).get(workspaceId, relationshipA.id);
  db.close();
  assert.ok(edge);

  const reused = await client.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA2.id}/dependencies`, {
    target_kind: 'existing_entity', dependency_entity_id: String(edge.dependency_entity_id),
    dependency_type: 'infrastructure', service_description: 'The same confirmed infrastructure identity supports analytics.',
    data_access: 'confidential', countries: 'US, IE', criticality: 'high', concentration_key: 'shared-compute-backbone',
    substitutability: 'difficult', due_diligence_required: '1', evidence_summary: 'Same registration and contract identity confirmed.',
    reason: 'Reuse the confirmed exact external identity across a second service.',
    idempotency_key: 'relationship-ui-dependency-reuse-00000000001',
  });
  assert.equal(reused.status, 303);
  const relatedService = await client.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA2.id}/dependencies`, {
    target_kind: 'relationship', target_relationship_id: String(relationshipA.id), dependency_type: 'data',
    service_description: 'Analytics depends on the production platform data feed.', data_access: 'confidential', countries: 'US',
    criticality: 'high', substitutability: 'substitutable_with_effort', due_diligence_required: '1',
    evidence_summary: 'Architecture data-flow record.', reason: 'Link the exact upstream portfolio service relationship.',
    idempotency_key: 'relationship-ui-dependency-service-0000000001',
  });
  assert.equal(relatedService.status, 303);
  db = new Database(dbPath, { readonly: true });
  const sharedLinks = db.prepare(`SELECT COUNT(*) AS count FROM tprm_dependency_edges
    WHERE workspace_id=? AND dependency_entity_id=?`).get(workspaceId, edge.dependency_entity_id).count;
  const identityCount = db.prepare(`SELECT COUNT(*) AS count FROM tprm_dependency_entities
    WHERE workspace_id=? AND name='Shared Compute Backbone Ltd'`).get(workspaceId).count;
  const serviceLink = db.prepare(`SELECT * FROM tprm_dependency_edges
    WHERE workspace_id=? AND source_relationship_id=? AND target_relationship_id=?`).get(
      workspaceId, relationshipA2.id, relationshipA.id
    );
  db.close();
  assert.equal(sharedLinks, 2, 'confirmed external identity should be reused explicitly rather than name-merged');
  assert.equal(identityCount, 1);
  assert.ok(serviceLink);

  const statusEndpoint = `${endpoint}/${edge.id}/status`;
  const noCsrf = await client.post(statusEndpoint, {
    expected_row_version: String(edge.row_version), status: 'under_review', reason: 'Review this disclosed dependency.',
  }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.match(noCsrf.text, /CSRF token missing or invalid/);

  const reviewed = await client.post(statusEndpoint, {
    expected_row_version: String(edge.row_version), status: 'under_review',
    evidence_summary: 'Security architecture and contract disclosure are under review.',
    reason: 'Begin independent consultancy review of the disclosed dependency.',
  });
  assert.equal(reviewed.status, 303);
  const stale = await client.post(statusEndpoint, {
    expected_row_version: String(edge.row_version), status: 'approved',
    evidence_summary: 'A stale reviewer must not approve this edge.', reason: 'Attempt stale dependency approval.',
  });
  assert.equal(stale.status, 409);

  const wrongTenant = await client.get(`/workspaces/${workspaceId}/tprm/relationships/${otherRelationship.id}`);
  assert.equal(wrongTenant.status, 404);
  assert.doesNotMatch(wrongTenant.text, /Never cross-client merge this service/);
});

test('view-only consultancy role can inspect but cannot manage relationship or monitoring records', async () => {
  const page = await viewerClient.get(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Production cloud platform/);
  assert.doesNotMatch(page.text, />Save relationship</);
  const update = await viewerClient.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/update`, {
    expected_row_version: '1', reason: 'Unauthorized update must fail.',
  });
  assert.equal(update.status, 403);
  assert.match(update.text, /tprm\.third_party\.manage/);
  const status = await viewerClient.post(`/workspaces/${workspaceId}/tprm/relationships/${relationshipA.id}/status`, {
    expected_row_version: '1', status: 'offboarding', reason: 'Unauthorized transition must fail.',
  });
  assert.equal(status.status, 403);
  assert.match(status.text, /tprm\.monitoring\.manage/);
});

test('every relationship surface requires an active standalone TPRM module', async () => {
  for (const route of ['relationships', 'concentration']) {
    const response = await client.get(`/workspaces/${inactiveWorkspaceId}/tprm/${route}`);
    assert.equal(response.status, 409);
    assert.match(response.text, /Activate Third-party risk/);
  }
  const write = await client.post(`/workspaces/${inactiveWorkspaceId}/tprm/relationships`, {
    supplier_id: '1', relationship_name: 'Must not create', service_description: 'Blocked inactive module.',
    provision_model: 'other', criticality: 'unknown', data_access: 'unknown', substitutability: 'unknown',
    reason: 'This inactive module request must be refused.', idempotency_key: 'inactive-module-write-must-be-blocked-000001',
  });
  assert.equal(write.status, 409);
  assert.match(write.text, /Activate Third-party risk/);
});

test('route source declares granular permissions and no provider-name identity lookup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tprm-relationships.js'), 'utf8');
  assert.match(source, /requirePermission\('tprm\.third_party\.view'\)/);
  assert.match(source, /requirePermission\('tprm\.third_party\.manage'\)/);
  assert.match(source, /requirePermission\('tprm\.monitoring\.manage'\)/);
  assert.doesNotMatch(source, /WHERE\s+(?:lower\()?name(?:\)|\s)*=/i, 'provider names must never be used as identity keys');
});

test('money conversion respects standard zero, two and three-decimal currency precision without rounding', () => {
  const { moneyToMinor, minorToMajor } = require('../routes/tprm-relationships');
  assert.equal(moneyToMinor('1250', 'JPY'), 1250);
  assert.equal(moneyToMinor('1250.25', 'USD'), 125025);
  assert.equal(moneyToMinor('1250.125', 'KWD'), 1250125);
  assert.equal(minorToMajor(1250125, 'KWD'), '1250.125');
  assert.throws(() => moneyToMinor('12.345', 'USD'), /no more than 2 decimal places/);
  assert.throws(() => moneyToMinor('12.1', 'JPY'), /no more than 0 decimal places/);
});
