'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');
const coverage = require('../lib/tprm-framework-coverage');

test('capability coverage maps directly to ISO supplier controls and every NIST CSF GV.SC outcome', () => {
  const facts = {};
  for (const capability of coverage.CAPABILITIES) {
    for (const requirement of capability.requirements) {
      facts[requirement] = { value: true, sources: [{ sourceType: 'test_record', sourceId: requirement, label: requirement }] };
    }
  }
  const capabilities = coverage.evaluateCapabilities(facts);
  assert.equal(capabilities.length, 10);
  assert.ok(capabilities.every(item => item.status === 'evidenced' && item.percentage === 100));
  const rollup = coverage.frameworkRollup(capabilities);
  assert.deepEqual(rollup.nistCsf.map(item => item.ref), [
    'GV.SC-01','GV.SC-02','GV.SC-03','GV.SC-04','GV.SC-05',
    'GV.SC-06','GV.SC-07','GV.SC-08','GV.SC-09','GV.SC-10',
  ]);
  assert.ok(rollup.iso27001.some(item => item.ref === 'A.5.19'));
  assert.ok(rollup.iso27001.some(item => item.ref === 'A.5.23'));
  assert.ok(rollup.nistCsf.every(item => /not a conformity or certification conclusion/.test(item.disclaimer)));
});

test('partial evidence is reported as partial and names the exact missing capability checks', () => {
  const capabilities = coverage.evaluateCapabilities({
    inventoryRecord: { value: true, sources: [{ sourceType: 'third_party', sourceId: '1', label: 'Provider' }] },
    approvedInherentRisk: { value: false, sources: [], note: 'Approve tiering.' },
  });
  const inventory = capabilities.find(item => item.key === 'inventory_and_criticality');
  assert.equal(inventory.status, 'partial');
  assert.equal(inventory.percentage, 50);
  assert.deepEqual(inventory.gaps, [{ key: 'approvedInherentRisk', note: 'Approve tiering.' }]);
  assert.deepEqual(inventory.evidence, [{ sourceType: 'third_party', sourceId: '1', label: 'Provider' }]);
});

test('database projection is tenant scoped and does not claim framework conformity', () => {
  const env = bootApp();
  const db = new Database(env.dbPath);
  try {
    const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    const managerId = Number(db.prepare(`INSERT INTO users
      (email,password_hash,name,user_type,firm_id,firm_role,active)
      VALUES ('coverage-manager@example.test','!','Coverage Manager','firm',?,'manager',1)`).run(firm.id).lastInsertRowid);
    const workspaceA = Number(db.prepare(`INSERT INTO workspaces
      (firm_id,client_name,frameworks) VALUES (?,'Coverage client A','[]')`).run(firm.id).lastInsertRowid);
    const workspaceB = Number(db.prepare(`INSERT INTO workspaces
      (firm_id,client_name,frameworks) VALUES (?,'Coverage client B','[]')`).run(firm.id).lastInsertRowid);
    const supplierId = Number(db.prepare(`INSERT INTO suppliers
      (workspace_id,name,service_provided,lifecycle_stage,tier,business_owner,relationship_owner,exit_strategy)
      VALUES (?,'Scoped Provider','Critical processing','prospect','tier_2','Client owner','Consultancy owner','Controlled migration and deletion')`).run(workspaceA).lastInsertRowid);
    require('../lib/tprm-domain').enableModule(db, {
      workspaceId: workspaceA, serviceModel: 'managed_lifecycle', actorId: managerId,
      reason: 'Enable governed third-party risk coverage.',
    });

    const result = coverage.thirdPartyCoverage(db, workspaceA, supplierId);
    assert.equal(result.thirdParty.name, 'Scoped Provider');
    assert.equal(result.capabilities.find(item => item.key === 'inventory_and_criticality').status, 'partial');
    assert.match(result.disclaimer, /not a certification or compliance opinion/);
    assert.ok(result.frameworks.nistCsf.every(item => item.evidence.every(source => !Object.hasOwn(source, 'storedPath'))));
    assert.throws(() => coverage.thirdPartyCoverage(db, workspaceB, supplierId), /third_party_not_found/);
  } finally {
    db.close();
  }
});
