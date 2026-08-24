'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { bootApp } = require('./helpers');

test('TPRM lifecycle, relationship and recommendation draft chains reject direct forks', t => {
  const env = bootApp();
  const { db } = require('../db');
  t.after(() => {
    try { db.close(); } catch (_) {}
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  });
  const domain = require('../lib/tprm-domain');
  const relationships = require('../lib/tprm-relationships');
  const workflow = require('../lib/tprm-recommendation-workflow');
  const firm = db.prepare('SELECT * FROM firms ORDER BY id LIMIT 1').get();
  const suffix = crypto.randomBytes(4).toString('hex');
  const managerId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,'manager',1)`).run(
      `chain-manager-${suffix}@example.test`, '!test', 'Chain manager', firm.id
    ).lastInsertRowid);
  const consultantId = Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,'consultant',1)`).run(
      `chain-consultant-${suffix}@example.test`, '!test', 'Chain consultant', firm.id
    ).lastInsertRowid);
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
    VALUES (?,'Hash chain client','[]')`).run(firm.id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')")
    .run(workspaceId, consultantId);
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,lifecycle_stage,tier)
    VALUES (?,'Hash chain provider','Managed production service','prospect','tier_2')`).run(workspaceId).lastInsertRowid);
  const module = domain.enableModule(db, {
    workspaceId, serviceModel: 'managed_lifecycle', actorId: managerId,
    reason: 'Enable the governed module for chain-continuity verification.',
  }).module;
  domain.recordEvent(db, {
    workspaceId, supplierId, moduleId: module.id,
    eventType: 'legacy_history_linked', actorId: managerId,
    actorType: 'consultancy_manager', actorName: 'Chain manager',
    reason: 'Establish the first supplier-specific lifecycle chain event.',
    payload: { test: 'chain-head' },
  });

  assert.throws(() => db.prepare(`INSERT INTO tprm_lifecycle_events
    (workspace_id,supplier_id,module_id,event_type,actor_user_id,actor_type,actor_name,
     payload_json,previous_event_hash,event_hash)
    VALUES (?,?,?,'legacy_history_linked',?,'consultancy_manager','Chain manager','{}',NULL,?)`).run(
      workspaceId, supplierId, module.id, managerId, 'a'.repeat(64)
    ), /hash-chain predecessor is invalid/);
  assert.throws(() => db.prepare(`INSERT INTO tprm_lifecycle_events
    (workspace_id,module_id,event_type,actor_user_id,actor_type,actor_name,payload_json)
    VALUES (?,?,'legacy_history_linked',?,'consultancy_manager','Chain manager','{}')`).run(
      workspaceId, module.id, managerId
    ), /event hash is required|hash-chain predecessor is invalid/);

  const relationship = relationships.createRelationship(db, {
    workspaceId, supplierId, actorId: consultantId,
    relationshipName: 'Managed production service relationship',
    serviceCategory: 'Managed service',
    serviceDescription: 'Exact managed production service assessed for the client.',
    provisionModel: 'managed_service', status: 'intake', criticality: 'high',
    dataAccess: 'confidential', isPrimary: true,
    reason: 'Create an exact service relationship for chain verification.',
  }).relationship;
  assert.throws(() => db.prepare(`INSERT INTO tprm_relationship_events
    (workspace_id,relationship_id,event_type,actor_user_id,actor_type,actor_name,
     payload_json,previous_event_hash,event_hash)
    VALUES (?,?,'relationship_updated',?,'consultant','Chain consultant','{}',NULL,?)`).run(
      workspaceId, relationship.id, consultantId, 'b'.repeat(64)
    ), /hash-chain predecessor is invalid/);

  const cycle = domain.ensureCurrentCycle(db, {
    workspaceId, supplierId, actorId: consultantId, cycleType: 'onboarding',
    triggerReason: 'Create a recommendation draft chain fixture.',
  }).cycle;
  const draft = workflow.createDraft(db, {
    workspaceId, supplierId, cycleId: cycle.id, actorId: consultantId,
    idempotencyKey: crypto.createHash('sha256').update(`chain-draft-${suffix}`).digest('hex'),
  }).draft;
  assert.throws(() => db.prepare(`INSERT INTO tprm_recommendation_draft_events
    (workspace_id,supplier_id,cycle_id,draft_id,action,from_status,to_status,actor_id,
     previous_event_hash,event_hash)
    VALUES (?,?,?,?,'submitted','draft','in_review',?,NULL,?)`).run(
      workspaceId, supplierId, cycle.id, draft.id, consultantId, 'c'.repeat(64)
    ), /hash-chain predecessor is invalid/);

  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
