'use strict';
// The dataset register (Annex A.7, A.4.3): datasets with their acquisition,
// quality, provenance and preparation records, linked to the AI systems that
// use them, so the auditor's population of datasets is a query.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, otherWsId, scoringId, retiredScopeId;
const base = () => `/workspaces/${wsId}/iso42001`;
const workspace = (id = wsId) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const dataset = (name) => db.prepare('SELECT * FROM ai_datasets WHERE workspace_id=? AND name=?').get(wsId, name);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const ws = (name, frameworks) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`)
    .run(actor.firm_id, name, frameworks).lastInsertRowid);
  wsId = ws('Kestrel Lending', '["iso42001","dpdpa"]');
  otherWsId = ws('Other AI client', '["iso42001"]');
  scoringId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Credit scoring model', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
  retiredScopeId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, scope_note, created_by) VALUES (?, 'Marketing lookalikes', 'in_use', 0, 'Run by the parent group', ?)`).run(wsId, actor.id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

test('a dataset is added with its records, and bad input is refused', async () => {
  const nameless = await client.post(`${base()}/datasets`, { source_type: 'internal' });
  assert.match(decodeURIComponent(nameless.location), /Name the dataset/);
  const unchecked = await client.post(`${base()}/datasets`, { name: 'Loan applications 2019-2025', quality_checked_on: '2026-09-01' });
  assert.match(decodeURIComponent(unchecked.location), /what the quality check found/);

  const added = await client.post(`${base()}/datasets`, {
    name: 'Loan applications 2019-2025', source_type: 'internal', origin: 'Loan origination system', refresh: 'periodic', personal_data: 'personal',
    acquisition: 'Exported from the origination system; declined applications included to avoid survivorship bias', owner: 'Head of credit analytics',
    known_bias: 'Few applicants from the north-east',
  });
  const id = Number(added.location.match(/datasets\/(\d+)/)[1]);
  assert.equal(dataset('Loan applications 2019-2025').id, id);
  assert.equal(dataset('Loan applications 2019-2025').personal_data, 'personal');
  const dupe = await client.post(`${base()}/datasets`, { name: 'Loan applications 2019-2025' });
  assert.match(decodeURIComponent(dupe.location), /already on the register/);

  const page = await client.get(`${base()}/datasets/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /1 of 4<\/strong> recorded/);
  assert.match(page.text, /Digital Personal Data Protection Act/);
  assert.match(page.text, /Open the DPDPA assessment/, 'a client with the DPDPA programme gets the link');

  const stale = await client.post(`${base()}/datasets/${id}`, { name: 'Loan applications 2019-2025', version: 99 });
  assert.match(decodeURIComponent(stale.location), /changed in another session/);
  const kept = Object.fromEntries(Object.entries(dataset('Loan applications 2019-2025')).filter(([k, v]) => v != null && !['id', 'workspace_id', 'created_by', 'created_at', 'updated_at'].includes(k)));
  await client.post(`${base()}/datasets/${id}`, { ...kept,
    quality_requirements: 'No more than 2% missing income; each region at least 3% of rows', quality_checked_on: '2026-09-01', quality_result: 'Income missing in 1.4%; north-east 1.9%, below threshold',
    provenance: 'Export job writes a manifest with row counts and a hash to the data catalogue', preparation: 'Income imputed by median within region; categories one-hot encoded' });
  const d = dataset('Loan applications 2019-2025');
  assert.equal(require('../lib/ai-datasets').a7(d).count, 4);
});

test('datasets link to systems from either side, never across clients', async () => {
  const registry = require('../lib/ai-datasets');
  const loans = dataset('Loan applications 2019-2025');
  const bureau = registry.create(db, workspace(), actor.id, { name: 'Credit bureau scores', source_type: 'purchased', origin: 'Bureau partner' });
  const foreignSystem = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Other model', 'in_use', ?)`).run(otherWsId, actor.id).lastInsertRowid);

  await client.post(`${base()}/ai-systems/${scoringId}/datasets`, { dataset_id: loans.id, use: 'training' });
  await client.post(`${base()}/datasets/${loans.id}/systems`, { ai_system_id: scoringId, use: 'validation' });
  await client.post(`${base()}/ai-systems/${scoringId}/datasets`, { dataset_id: bureau, use: 'production' });
  await client.post(`${base()}/ai-systems/${retiredScopeId}/datasets`, { dataset_id: bureau, use: 'training' });
  const noPurpose = await client.post(`${base()}/ai-systems/${scoringId}/datasets`, { dataset_id: loans.id, use: 'decoration' });
  assert.match(decodeURIComponent(noPurpose.location), /what the system uses the dataset for/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_system_datasets WHERE workspace_id=?').get(wsId).c, 4);

  assert.throws(() => registry.link(db, workspace(), actor.id, foreignSystem, loans.id, 'training'), /of this client/);
  assert.throws(() => db.prepare(`INSERT INTO ai_system_datasets (ai_system_id, dataset_id, workspace_id, use) VALUES (?, ?, ?, 'training')`).run(foreignSystem, loans.id, otherWsId),
    /crosses workspace boundary/);
  const crossed = await client.post(`/workspaces/${otherWsId}/iso42001/ai-systems/${foreignSystem}/datasets`, { dataset_id: loans.id, use: 'training' });
  assert.match(decodeURIComponent(crossed.location), /of this client/);

  const systemPage = await client.get(`${base()}/ai-systems/${scoringId}`);
  assert.match(systemPage.text, /Loan applications 2019-2025<\/a><span class="meta">Training · 4 of 4 A.7 records · personal data/);
  await client.post(`${base()}/ai-systems/${scoringId}/datasets/${loans.id}/validation/delete`, { return_to: 'dataset' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_system_datasets WHERE dataset_id=?').get(loans.id).c, 1);
});

test('the datasets population lists what in-scope systems use, and answers the auditor\'s request', async () => {
  const systems = require('../lib/ai-systems');
  const pop = systems.population(db, workspace(), 'ai-datasets');
  assert.deepEqual(pop.rows.map(r => r[0]), ['Credit bureau scores', 'Loan applications 2019-2025']);
  assert.equal(pop.rows[0][2], 'Credit scoring model (production)', 'the out-of-scope system\'s use is left out');
  assert.equal(pop.rows[1][3], 'Yes');
  const csv = await client.get(`${base()}/populations/ai-datasets.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Datasets used to develop or run AI systems/);

  assert.equal(systems.populationForRequest({ source: 'standard', ref: 'POP-DATASETS' }), 'ai-datasets');
  assert.equal(systems.populationForRequest({ source: 'import', description: 'Provide a list of datasets used to train the AI models' }), 'ai-datasets');
  assert.equal(systems.populationForRequest({ source: 'import', description: 'List of AI systems in scope' }), 'ai-systems');

  const list = await client.get(`${base()}/datasets`);
  assert.equal(list.status, 200);
  assert.match(list.text, /Used by Credit scoring model/);
  assert.match(list.text, /<strong>2<\/strong> rows/);
});

test('readiness finds the A.7 records from the register', () => {
  const { shared } = require('../routes/iso42001');
  const checks = () => Object.fromEntries(shared.computeIso42001Readiness(wsId).records.expected.checks.map((c) => [c.clause, c]));
  let c = checks();
  assert.equal(c['A.4.3'].found, true, 'the only live in-scope system has datasets');
  assert.equal(c['A.7.5'].found, false, 'the bureau dataset has no provenance yet');
  assert.match(c['A.7.5'].basis, /1 of 2 datasets in use record their provenance/);
  db.prepare("UPDATE ai_datasets SET provenance='Bureau delivers a signed file with a manifest' WHERE workspace_id=? AND name='Credit bureau scores'").run(wsId);
  c = checks();
  assert.equal(c['A.7.5'].found, true);
  assert.equal(c['A.7.4'].found, false);
});
