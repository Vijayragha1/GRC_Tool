'use strict';
// The ISO 27001 <-> ISO 42001 crosswalk: a client on both standards sees, on
// each ISO 42001 requirement, what its ISO 27001 records already hold, and can
// reuse that evidence with one click instead of uploading it again.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, bothId, aimsOnlyId, policyEvidence, loggingEvidence;

const pairs = (aiRef) => db.prepare(`SELECT a.ref, m.coverage, m.residual_gap_note FROM requirement_mappings m
  JOIN requirements a ON a.id = m.canonical_requirement_id JOIN requirements b ON b.id = m.mapped_requirement_id
  JOIN frameworks fb ON fb.id = b.framework_id AND fb.code = 'iso42001' WHERE b.ref = ? ORDER BY a.ref`).all(aiRef);

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  bothId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Northwind Health', '["iso27001","iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  aimsOnlyId = Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, 'Aurora Diagnostics', '["iso42001"]', 'certification_support')`).run(actor.firm_id).lastInsertRowid);
  const evidence = (ws, name, ref) => Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, uploaded_by, iso_item_id) VALUES (?, ?, ?, ?, ?)`)
    .run(ws, name, `test/${name}`, actor.id, ref).lastInsertRowid);
  policyEvidence = evidence(bothId, 'information-security-policy-v3.pdf', 'annex-a.5.1');
  loggingEvidence = evidence(bothId, 'siem-retention-config.png', 'annex-a.8.15');
});
test.after(async () => { db?.close(); await client?.close(); });

test('the crosswalk pairs the shared clauses by number and the overlapping controls, all as partial', () => {
  assert.deepEqual(pairs('ai-clause-4.1').map((p) => p.ref), ['clause-4.1']);
  assert.deepEqual(pairs('ai-clause-6.1.4'), [], 'the AI system impact assessment has no ISO 27001 counterpart');
  assert.deepEqual(pairs('ai-annex-a-10-3').map((p) => p.ref), ['annex-a.5.19', 'annex-a.5.21']);
  const policy = pairs('ai-annex-a-2-2');
  assert.equal(policy[0].ref, 'annex-a.5.1');
  assert.ok(db.prepare(`SELECT COUNT(*) c FROM requirement_mappings m JOIN requirements b ON b.id = m.mapped_requirement_id
    JOIN frameworks f ON f.id = b.framework_id AND f.code = 'iso42001' WHERE m.coverage != 'partial'`).get().c === 0);
  assert.match(policy[0].residual_gap_note, /AI principles/);
});

test('an ISO 42001 requirement shows the ISO 27001 record and reuses its evidence', async () => {
  const page = await client.get(`/workspaces/${bothId}/iso42001/gap/ai-annex-a-2-2`);
  assert.equal(page.status, 200, page.text.slice(0, 300));
  assert.match(page.text, /Already on record for ISO 27001/);
  assert.match(page.text, />A\.5\.1<\/span>/);
  assert.match(page.text, /information-security-policy-v3\.pdf/);
  assert.match(page.text, /ISO 42001 adds: The AI policy can sit in the policy framework/);
  assert.doesNotMatch(page.text, /siem-retention-config\.png/, 'only evidence on the paired requirement is offered');

  const res = await client.post(`/workspaces/${bothId}/iso42001/gap/ai-annex-a-2-2/reuse-evidence`, { evidence_id: String(policyEvidence) });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.location), /Evidence from A\.5\.1 linked/);
  const linked = db.prepare(`SELECT COUNT(*) c FROM evidence_requirement_links erl JOIN requirements rq ON rq.id = erl.requirement_id
    WHERE erl.evidence_id = ? AND rq.ref = 'ai-annex-a-2-2'`).get(policyEvidence).c;
  assert.equal(linked, 1);
  const after = await client.get(`/workspaces/${bothId}/iso42001/gap/ai-annex-a-2-2`);
  assert.match(after.text, /Evidence files \(1\)/);
  assert.match(after.text, /linked here/);

  const refused = await client.post(`/workspaces/${bothId}/iso42001/gap/ai-annex-a-2-2/reuse-evidence`, { evidence_id: String(loggingEvidence) });
  assert.match(decodeURIComponent(refused.location), /not on record against a paired requirement/);
});

test('a client on ISO 42001 alone sees no ISO 27001 panel', async () => {
  const page = await client.get(`/workspaces/${aimsOnlyId}/iso42001/gap/ai-annex-a-2-2`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Already on record for ISO 27001/);
});
