'use strict';
// ISO 27001 and ISO 42001 keep separate risk records (migration 079): each
// risk and each risk method belongs to one management system, links only to
// its own system's controls, and each system's register, records and
// readiness read only its own risks.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, aiOnlyId, combinedId, ismsId;
const ws = (id) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const risk = (wsId, title, extra = {}) => {
  const cols = ['workspace_id', 'title', 'likelihood', 'impact', ...Object.keys(extra)];
  const id = Number(db.prepare(`INSERT INTO risks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(wsId, title, 3, 3, ...Object.values(extra)).lastInsertRowid);
  return id;
};
const owner = (id) => db.prepare('SELECT management_system FROM risks WHERE id=?').get(id).management_system;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name, frameworks) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`)
    .run(actor.firm_id, name, frameworks).lastInsertRowid);
  aiOnlyId = add('Kestrel Lending', '["iso42001"]');
  combinedId = add('Harbour Analytics', '["iso27001","iso42001"]');
  ismsId = add('Harbour Freight', '["iso27001"]');
});
test.after(async () => { db?.close(); await client?.close(); });

test('existing risks are given to one system by the migration, and new ones by the client\'s systems', () => {
  const systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Scoring model', 'in_use', ?)`).run(combinedId, actor.id).lastInsertRowid);
  const plain = risk(aiOnlyId, 'Model drift');
  const aiMarked = risk(combinedId, 'Biased scores', { ai_system_id: systemId });
  const both = risk(combinedId, 'Shared outage', { risk_source: 'hardware' });
  const isms = risk(combinedId, 'Office flood');
  assert.equal(owner(plain), 'iso42001', 'the trigger gives an ISO 42001-only client\'s risk to the AIMS');
  assert.equal(owner(aiMarked), 'iso27001', 'on a client with both, an insert that names no owner is the ISMS\'s');

  // Re-run the backfill as it ran on deployed databases.
  db.prepare("UPDATE risks SET management_system='iso27001' WHERE workspace_id IN (?, ?)").run(aiOnlyId, combinedId);
  db.prepare("INSERT INTO risk_controls (risk_id, iso_item_id) VALUES (?, (SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1))").run(both);
  require('../migrations/079_risk_ownership').up(db);
  assert.deepEqual([owner(plain), owner(aiMarked), owner(both), owner(isms)], ['iso42001', 'iso42001', 'iso27001', 'iso27001'],
    'AI markers without an ISO 27001 control link go to the AIMS');

  const riskOwner = require('../lib/risk-owner');
  assert.equal(riskOwner.ownerFor(ws(ismsId), { ai_system_id: 5 }), 'iso27001');
  assert.equal(riskOwner.ownerFor(ws(aiOnlyId), {}), 'iso42001');
  assert.equal(riskOwner.ownerFor(ws(combinedId), { management_system: 'iso42001' }), 'iso42001');
  assert.equal(riskOwner.ownerFor(ws(combinedId), { risk_source: 'data' }), 'iso42001');
  assert.equal(riskOwner.ownerFor(ws(combinedId), {}), 'iso27001');
});

test('each register lists only its own risks, and a risk links only to its own system\'s controls', async () => {
  const aiRisk = Number(db.prepare(`SELECT id FROM risks WHERE workspace_id=? AND title='Biased scores'`).get(combinedId).id);
  const ismsRisk = Number(db.prepare(`SELECT id FROM risks WHERE workspace_id=? AND title='Office flood'`).get(combinedId).id);
  const page = await client.get(`/workspaces/${combinedId}/risks`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Office flood/);
  assert.doesNotMatch(page.text, /Biased scores/, 'the shared register on a client with both is the ISMS\'s');
  assert.doesNotMatch(page.text, /name="ai_system_id"/, 'and takes no AI fields');

  const isoControl = db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1 OFFSET 3").get().id;
  await client.post(`/workspaces/${combinedId}/risks/${aiRisk}/link`, { iso_item_id: isoControl });
  await client.post(`/workspaces/${combinedId}/risks/${ismsRisk}/link`, { iso_item_id: 'ai-annex-a-6-2-4' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM risk_controls WHERE risk_id=?').get(aiRisk).c, 0, 'an AIMS risk takes no ISO 27001 control');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_risk_controls WHERE risk_id=?').get(ismsRisk).c, 0, 'an ISMS risk takes no ISO 42001 control');
  await client.post(`/workspaces/${combinedId}/risks/${aiRisk}/link`, { iso_item_id: 'ai-annex-a-6-2-4' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_risk_controls WHERE risk_id=?').get(aiRisk).c, 1);

  const fromControl = await client.post(`/workspaces/${combinedId}/iso42001/controls/ai-annex-a-6-2-6/risks`, { risk_id: ismsRisk });
  assert.equal(fromControl.status, 404, 'the ISO 42001 control page cannot link an ISMS risk');
  const gap = await client.get(`/workspaces/${combinedId}/iso42001/gap/ai-annex-a-6-2-6`);
  assert.doesNotMatch(gap.text, /Office flood/, 'nor offer one');

  const isms = await client.get(`/workspaces/${combinedId}/risks/${ismsRisk}`);
  assert.doesNotMatch(isms.text, /value="ai-annex-a-/, 'the ISMS risk page offers ISO 27001 controls only');
});

test('each system has its own risk method, and the module\'s return address cannot leave it', async () => {
  const { getActiveMethodology } = require('../db');
  const preset = Object.keys(require('../data/methodology-presets'))[0];
  const moduleReturn = `/workspaces/${combinedId}/iso42001/risks/criteria`;
  const applied = await client.post(`/workspaces/${combinedId}/risk-methodology/preset/${preset}`, { standard: 'iso42001', return_to: moduleReturn });
  assert.equal(applied.location, moduleReturn);
  assert.equal(getActiveMethodology(combinedId, 'iso42001').name, require('../data/methodology-presets')[preset].name);
  assert.equal(getActiveMethodology(combinedId, 'iso27001').built_in, true, 'the ISMS method is untouched');
  assert.equal(getActiveMethodology(combinedId).built_in, true, 'with no system named, a client with both reads the ISMS method');

  for (const bad of ['https://evil.example/', `/workspaces/${ismsId}/iso42001/risks`, `/workspaces/${combinedId}/iso42001/../risks`, `/workspaces/${combinedId}/risks`]) {
    const reset = await client.post(`/workspaces/${combinedId}/risk-methodology/reset`, { standard: 'iso42001', return_to: bad });
    assert.match(reset.location, new RegExp(`^/workspaces/${combinedId}/risk-methodology\\?standard=iso42001`), `refused ${bad}`);
  }
  const notMine = await client.post(`/workspaces/${ismsId}/risk-methodology/reset`, { standard: 'iso42001' });
  assert.ok(notMine.status < 400);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM risk_methodologies WHERE workspace_id=? AND management_system='iso42001'").get(ismsId).c, 0,
    'a client without ISO 42001 cannot hold an AIMS method');

  const methodPage = await client.get(`/workspaces/${combinedId}/risk-methodology?standard=iso42001`);
  assert.match(methodPage.text, /ISO 42001 AI risk criteria/);
});

test('the AIMS risk assessment record holds only AIMS risks and is what readiness counts', async () => {
  const { shared } = require('../routes/iso42001');
  const check = () => shared.computeIso42001Readiness(combinedId).records.mandatory.checks.find((c) => c.clause === '8.2');
  await client.post(`/workspaces/${combinedId}/risks/assessments`, { scope: 'all' });
  assert.equal(check().found, false, 'a record of the ISMS register is not the AIMS\'s');
  await client.post(`/workspaces/${combinedId}/risks/assessments`, { scope: 'ai' });
  assert.equal(check().found, true);
  const record = db.prepare("SELECT payload FROM risk_assessment_records WHERE workspace_id=? AND scope='ai' ORDER BY id DESC").get(combinedId);
  assert.deepEqual(JSON.parse(record.payload).map((r) => r.title), ['Biased scores']);
  const ismsRecord = db.prepare("SELECT payload FROM risk_assessment_records WHERE workspace_id=? AND scope='all' ORDER BY id DESC").get(combinedId);
  assert.ok(!JSON.parse(ismsRecord.payload).some((r) => r.title === 'Biased scores'), 'the ISMS record leaves AIMS risks out');
});
