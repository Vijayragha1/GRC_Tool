'use strict';
// What ISO/IEC 42001 asks for that the records first missed: an impact
// assessment's deployment setting, jurisdictions, areas of impact and
// retention period (clause 6.1.4, A.5.3); the climate change decision
// (clause 4.1); and the risks and opportunities for the AIMS itself (6.1.1).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, otherWsId, systemId;
const base = () => `/workspaces/${wsId}/iso42001`;
const workspace = () => db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
const user = (email, role) => Number(db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active)
  VALUES (?, '!noauth', ?, ?, 'firm', ?, 1)`).run(email, email.split('@')[0], actor.firm_id, role).lastInsertRowid);
const readiness = () => require('../routes/iso42001').shared.computeIso42001Readiness(wsId);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id, name FROM users WHERE email='sec-test@example.com'").get();
  const ws = (name) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, '["iso42001"]', 'certification_support')`)
    .run(actor.firm_id, name).lastInsertRowid);
  wsId = ws('Kestrel Lending');
  otherWsId = ws('Other AI client');
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Credit scoring model', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
});
test.after(async () => { db?.close(); await client?.close(); });

test('an assessment approved before migration 075 still matches its content hash', () => {
  const registry = require('../lib/ai-systems');
  // The hash exactly as it was computed before the new fields existed.
  const oldKeys = ['trigger_reason', 'affected_parties', 'intended_benefits', 'potential_harms', 'societal_impacts', 'failure_modes', 'misuse',
    'demographic_notes', 'oversight_measures', 'mitigations', 'conditions', 'residual_level', 'decision', 'harm_severity', 'harm_likelihood', 'ai_system_id', 'version_no'];
  const row = { affected_parties: 'Applicants', potential_harms: 'Unfair refusal', societal_impacts: 'Access to credit', mitigations: 'Human review',
    residual_level: 'medium', decision: 'proceed', harm_severity: 3, harm_likelihood: 2, ai_system_id: systemId, version_no: 1 };
  const oldHash = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(oldKeys.map(k => [k, row[k] ?? null])))).digest('hex');
  const id = Number(db.prepare(`INSERT INTO ai_impact_assessments (workspace_id, ai_system_id, version_no, status, affected_parties, potential_harms, societal_impacts,
      mitigations, residual_level, decision, harm_severity, harm_likelihood, approved_at, snapshot_hash)
    VALUES (?, ?, 1, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`).run(wsId, systemId, row.affected_parties, row.potential_harms, row.societal_impacts,
    row.mitigations, row.residual_level, row.decision, row.harm_severity, row.harm_likelihood, oldHash).lastInsertRowid);
  const stored = db.prepare('SELECT * FROM ai_impact_assessments WHERE id=?').get(id);
  assert.equal(registry.contentHash(stored), oldHash);
  assert.throws(() => db.prepare("UPDATE ai_impact_assessments SET jurisdictions='added later' WHERE id=?").run(id), /frozen/);
});

test('an impact assessment records its setting, jurisdictions, areas of impact and retention period', async () => {
  const registry = require('../lib/ai-systems');
  db.prepare(`INSERT INTO template_values (workspace_id, key, value) VALUES (?, 'retention_period', 'seven years')`).run(wsId);
  const started = await client.post(`${base()}/ai-systems/${systemId}/impact-assessments`, {});
  const iaId = Number(started.location.match(/impact-assessments\/(\d+)/)[1]);
  const ia = () => db.prepare('SELECT * FROM ai_impact_assessments WHERE id=?').get(iaId);
  assert.equal(ia().version_no, 2);
  assert.equal(ia().retention_period, null, 'a reassessment keeps the approved version\'s period, which was never set');

  const fields = {
    affected_parties: 'Loan applicants', potential_harms: 'Unfair refusal', societal_impacts: 'Access to credit in rural districts',
    mitigations: 'Underwriter review of every refusal', residual_level: 'medium', decision: 'proceed', harm_severity: 3, harm_likelihood: 2,
    area_fairness: 'affected', area_fairness_note: 'Thin-file applicants score lower',
    area_accessibility: 'not_affected', area_accessibility_note: 'Branch staff complete the application',
    area_financial: 'sideways',
  };
  await client.post(`${base()}/ai-systems/${systemId}/impact-assessments/${iaId}`, { ...fields, version: ia().version });
  const areas = registry.decodeAreas(ia().impact_areas);
  assert.deepEqual(areas.fairness, { state: 'affected', note: 'Thin-file applicants score lower' });
  assert.equal(areas.financial, undefined, 'an unknown state with no note is not stored');
  assert.equal(registry.areasConsidered(ia().impact_areas), 2);

  const reviewer = user('priya@firm.example', 'manager');
  assert.throws(() => registry.approveAssessment(db, workspace(), reviewer, systemId, iaId, { version: ia().version }), /deployed, the jurisdictions/);
  await client.post(`${base()}/ai-systems/${systemId}/impact-assessments/${iaId}`, { ...fields, version: ia().version,
    deployment_context: 'Scores run in the loan origination system; underwriters see the score and the reasons',
    jurisdictions: 'India: DPDP Act 2023, RBI digital lending directions', retention_period: 'Seven years after the loan closes',
    shared_with: 'Summary given to the lending partner bank' });
  registry.approveAssessment(db, workspace(), reviewer, systemId, iaId, { version: ia().version });
  assert.equal(ia().status, 'approved');
  assert.equal(ia().snapshot_hash, registry.contentHash(ia()));
  assert.notEqual(registry.contentHash({ ...ia(), jurisdictions: 'Edited' }), ia().snapshot_hash, 'the new fields are part of the hash once recorded');
  assert.throws(() => db.prepare("UPDATE ai_impact_assessments SET impact_areas='{}' WHERE id=?").run(iaId), /frozen/);

  const page = await client.get(`${base()}/ai-systems/${systemId}/impact-assessments/${iaId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Thin-file applicants score lower/);
  assert.match(page.text, /2 of 10 considered/);
  assert.match(page.text, /Seven years after the loan closes/);
  assert.match(page.text, /matches the stored text/);
  const report = require('../lib/aims-reports').impactAssessment(db, workspace(), systemId, iaId);
  assert.match(report.body, /RBI digital lending directions/);
  assert.match(report.body, /Fairness and unwanted bias<\/td><td>Affected/);

  const otherSystem = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, created_by) VALUES (?, 'Collections chatbot', 'in_use', ?)`).run(wsId, actor.id).lastInsertRowid);
  const first = registry.startAssessment(db, workspace(), actor.id, otherSystem);
  assert.equal(db.prepare('SELECT retention_period FROM ai_impact_assessments WHERE id=?').get(first).retention_period, 'seven years',
    'a first assessment starts from the client\'s records retention period');
});

test('the climate change decision is recorded with its reasoning', async () => {
  const flagged = () => readiness().flags.some((f) => f.kind === 'climate_undecided');
  assert.equal(flagged(), true);
  const missing = await client.post(`${base()}/context/climate`, { relevant: 'no' });
  assert.match(decodeURIComponent(missing.location), /and why/);
  assert.match(missing.location, /#climate$/);
  await client.post(`${base()}/context/climate`, { relevant: 'no', rationale: 'Scoring runs on shared cloud capacity; no customer sets climate terms', next_review: '2027-10-01' });
  await client.post(`${base()}/context/climate`, { relevant: 'yes', rationale: 'The partner bank now reports financed emissions', next_review: '2027-10-01' });
  const rows = db.prepare('SELECT * FROM aims_climate_decision WHERE workspace_id=?').all(wsId);
  assert.equal(rows.length, 1, 'one decision per client, revisited in place');
  assert.equal(rows[0].relevant, 'yes');
  assert.equal(flagged(), false);
  const page = await client.get(`${base()}/context`);
  assert.match(page.text, /Yes, climate change is a relevant issue/);
  assert.match(page.text, /financed emissions/);
});

test('risks and opportunities for the AIMS carry an action and a way to judge it', async () => {
  const check = () => readiness().records.mandatory.checks.find((c) => c.clause === '6.1.1');
  assert.equal(check().found, false);
  const issue = Number(db.prepare(`INSERT INTO context_issues (workspace_id, kind, issue) VALUES (?, 'internal', 'One analyst runs every impact assessment')`).run(wsId).lastInsertRowid);
  const foreign = Number(db.prepare(`INSERT INTO context_issues (workspace_id, kind, issue) VALUES (?, 'internal', 'Someone else')`).run(otherWsId).lastInsertRowid);

  const crossed = await client.post(`${base()}/context/risks-opportunities`, { kind: 'risk', description: 'Borrowed issue', context_issue_id: foreign });
  assert.match(decodeURIComponent(crossed.location), /not in this client/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM aims_risks_opportunities').get().c, 0);
  assert.throws(() => db.prepare(`INSERT INTO aims_risks_opportunities (workspace_id, kind, description, context_issue_id) VALUES (?, 'risk', 'x', ?)`).run(wsId, foreign),
    /crosses workspace boundary/);

  await client.post(`${base()}/context/risks-opportunities`, { kind: 'risk', description: 'Impact assessments stop if the analyst leaves', context_issue_id: issue,
    action: 'Train a second assessor', integration: 'Added to the competence plan', owner: 'Head of risk', due_date: '2027-03-31' });
  const ro = () => db.prepare('SELECT * FROM aims_risks_opportunities WHERE workspace_id=?').get(wsId);
  assert.equal(ro().context_issue_id, issue);
  assert.equal(check().found, false, 'an action without a way to judge it does not count');

  const early = await client.post(`${base()}/context/risks-opportunities/${ro().id}`, { kind: 'risk', description: ro().description, action: ro().action,
    effectiveness_method: 'A second assessor completes one unaided', status: 'done' });
  assert.match(decodeURIComponent(early.location), /how effective/);
  await client.post(`${base()}/context/risks-opportunities/${ro().id}`, { kind: 'risk', description: ro().description, context_issue_id: issue, action: ro().action,
    integration: ro().integration, owner: ro().owner, due_date: ro().due_date, effectiveness_method: 'A second assessor completes one unaided' });
  assert.equal(check().found, true);
  assert.match(check().basis, /^1 risk or opportunity/);

  const page = await client.get(`${base()}/context`);
  assert.match(page.text, /Impact assessments stop if the analyst leaves/);
  assert.match(page.text, /from the issue “One analyst runs every impact assessment”/);
  const other = await client.post(`/workspaces/${otherWsId}/iso42001/context/risks-opportunities/${ro().id}/delete`, {});
  assert.ok(other.status < 500);
  assert.ok(ro(), 'another client\'s page cannot remove it');
});
