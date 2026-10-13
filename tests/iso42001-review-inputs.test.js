'use strict';
// Management review input 9.3.2 c), changes in interested parties' needs and
// expectations, as its own field; the AI management system's new records in
// the review pack; and AI objectives tied to a topic.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, ismsWsId;
const today = new Date().toISOString().slice(0, 10);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const ws = (name, frameworks) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`)
    .run(actor.firm_id, name, frameworks).lastInsertRowid);
  wsId = ws('Kestrel Lending', '["iso42001"]');
  ismsWsId = ws('Harbour Freight', '["iso27001"]');
});
test.after(async () => { db?.close(); await client?.close(); });

test('a management review takes changes in interested parties as its own input', async () => {
  db.prepare(`INSERT INTO interested_parties (workspace_id, party, party_type, needs, requirement_kind) VALUES (?, 'Partner bank', 'customer', 'Quarterly fairness report on refusals', 'contractual')`).run(wsId);
  db.prepare(`INSERT INTO aims_climate_decision (workspace_id, relevant, rationale) VALUES (?, 'no', 'No customer sets climate terms')`).run(wsId);
  db.prepare(`INSERT INTO ai_concern_reports (workspace_id, channel, received_on, summary) VALUES (?, 'adverse_impact', ?, 'Refused without a reason')`).run(wsId, today);
  db.prepare(`INSERT INTO aims_risks_opportunities (workspace_id, kind, description, action, effectiveness_method) VALUES (?, 'risk', 'One assessor', 'Train a second', 'Unaided assessment')`).run(wsId);

  const created = await client.post(`/workspaces/${wsId}/mrms`, { meeting_date: today, attendees: 'CEO, CRO' });
  assert.equal(created.status, 302);
  const mrmId = Number(created.location.match(/mrms\/(\d+)/)[1]);
  const mrm = () => db.prepare('SELECT * FROM mrms WHERE id=?').get(mrmId);
  assert.match(mrm().interested_party_changes, /Interested parties on record: 1 \(1 with a legal, regulatory or contractual obligation\)/);
  assert.match(mrm().interested_party_changes, /Partner bank: Quarterly fairness report on refusals/);
  assert.match(mrm().context_changes, /Climate change decided not relevant/);
  assert.match(mrm().feedback_interested_parties, /Adverse impacts reported from outside in the last 12 months: 1/);
  assert.match(mrm().risk_treatment_status, /Risks and opportunities for the AIMS \(6\.1\.1\): 1 recorded, 1 still open/);

  await client.post(`/workspaces/${wsId}/mrms/${mrmId}`, { interested_party_changes: 'The partner bank now wants refusal reasons in Hindi as well as English' });
  assert.equal(mrm().interested_party_changes, 'The partner bank now wants refusal reasons in Hindi as well as English');
  const page = await client.get(`/workspaces/${wsId}/mrms/${mrmId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Changes in interested parties' needs and expectations/);
  assert.match(page.text, /refusal reasons in Hindi/);
  const report = require('../lib/aims-reports').managementReview(db, { id: wsId }, mrmId);
  assert.match(report.body, /Changes in the needs and expectations of interested parties<\/h3><p>The partner bank now wants/);

  const list = await client.get(`/workspaces/${wsId}/mrms`);
  assert.match(list.text, /Interested-party changes<span class="clause">9\.3\.2 c\)<\/span>/);

  const refreshed = await client.post(`/workspaces/${wsId}/mrms/${mrmId}/refresh-inputs`, {});
  assert.equal(refreshed.status, 302);
  assert.match(mrm().interested_party_changes, /Interested parties on record: 1/, 'refreshing re-pulls the input from live data');
});

test('an AI objective records the topic it serves', async () => {
  const add = (ws, body) => client.post(`/workspaces/${ws}/objectives`, { title: 'Objective', plan_actions: 'Do it', evaluation_method: 'Reviewed', ...body });
  await add(wsId, { title: 'Halve the refusal-rate gap between regions', ai_topic: 'fairness' });
  await add(wsId, { title: 'Made-up topic', ai_topic: 'vibes' });
  await add(ismsWsId, { title: 'Patch within 14 days', ai_topic: 'fairness' });
  const topic = (title) => db.prepare('SELECT ai_topic, framework FROM security_objectives WHERE title=?').get(title);
  assert.deepEqual(topic('Halve the refusal-rate gap between regions'), { ai_topic: 'fairness', framework: 'iso42001' });
  assert.equal(topic('Made-up topic').ai_topic, null);
  assert.equal(topic('Patch within 14 days').ai_topic, null, 'a client without ISO 42001 has no AI objectives');

  const page = await client.get(`/workspaces/${wsId}/objectives`);
  assert.equal(page.status, 200);
  assert.match(page.text, /AI objective &middot; Fairness/);
  assert.match(page.text, /<option value="robustness"/);
  const isms = await client.get(`/workspaces/${ismsWsId}/objectives`);
  assert.doesNotMatch(isms.text, /AI objective topic/);
});
