'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let client;
let dbPath;
let workspaceId;
let managerId;
let template;

function replaceCsvCell(csv, from, to) {
  return csv.split(from).join(to);
}

test.before(async () => {
  const booted = await bootClient();
  ({ client, dbPath } = booted);
  const db = new Database(dbPath);
  try {
    const manager = db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
    managerId = manager.id;
    workspaceId = Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks)
      VALUES (?,'TPRM Scale Client','["csf"]')`).run(manager.firm_id).lastInsertRowid);
    db.prepare(`INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by)
      VALUES (?,'managed_lifecycle','active','Scale and bulk-intake test',?)`).run(workspaceId, managerId);
  } finally { db.close(); }
  template = require('../lib/tprm-bulk-intake').templateCsv();
});

test.after(async () => {
  if (client) await client.close();
});

test('bulk intake previews then atomically creates one legal entity with two exact services', async () => {
  const root = `/workspaces/${workspaceId}/tprm/third-parties/import`;
  const upload = await client.get(root);
  assert.equal(upload.status, 200);
  assert.match(upload.text, /All-or-nothing commit/);
  assert.match(upload.text, /matching name never merges records/);

  const preview = await client.post(`${root}/preview`, { csv: template, filename: 'controlled-intake.csv' });
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Ready to commit/);
  assert.match(preview.text, /New third parties[\s\S]*1/);
  assert.match(preview.text, /New services[\s\S]*2/);
  const digest = (preview.text.match(/name="preview_digest" value="([a-f0-9]{64})"/) || [])[1];
  assert.ok(digest);

  const committed = await client.post(`${root}/commit`, {
    csv: template,
    filename: 'controlled-intake.csv',
    preview_digest: digest,
  });
  assert.equal(committed.status, 303);

  const db = new Database(dbPath, { readonly: true });
  try {
    const supplier = db.prepare(`SELECT * FROM suppliers WHERE workspace_id=? AND name='Example Cloud Services Ltd'`).get(workspaceId);
    assert.ok(supplier);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_legal_entities WHERE workspace_id=? AND supplier_id=?').get(workspaceId, supplier.id).count, 1);
    const services = db.prepare('SELECT * FROM tprm_service_relationships WHERE workspace_id=? AND supplier_id=? ORDER BY id').all(workspaceId, supplier.id);
    assert.equal(services.length, 2);
    assert.equal(services.filter(row => row.is_primary).length, 1);
    assert.deepEqual(services.map(row => row.relationship_name), ['Production hosting', 'Backup vault']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_inherent_assessments WHERE workspace_id=? AND supplier_id=?').get(workspaceId, supplier.id).count, 0, 'bulk intake must not start assessment fieldwork');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_recommendations WHERE workspace_id=? AND supplier_id=?').get(workspaceId, supplier.id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_client_decisions WHERE workspace_id=? AND supplier_id=?').get(workspaceId, supplier.id).count, 0);
    const audit = db.prepare(`SELECT * FROM audit_log WHERE workspace_id=? AND action='commit_tprm_bulk_intake' ORDER BY id DESC LIMIT 1`).get(workspaceId);
    assert.ok(audit, 'the all-or-nothing intake must commit its audit summary in the same transaction');
    assert.match(audit.details || '', /"relationshipsCreated":2/);
  } finally { db.close(); }
});

test('unchanged repeats are idempotent and conflicting same-name intake is blocked without auto-merge', async () => {
  const root = `/workspaces/${workspaceId}/tprm/third-parties/import`;
  const replayPreview = await client.post(`${root}/preview`, { csv: template, filename: 'controlled-intake.csv' });
  assert.equal(replayPreview.status, 200);
  assert.match(replayPreview.text, /Already Imported/g);
  const replayDigest = (replayPreview.text.match(/name="preview_digest" value="([a-f0-9]{64})"/) || [])[1];
  const replayCommit = await client.post(`${root}/commit`, { csv: template, filename: 'controlled-intake.csv', preview_digest: replayDigest });
  assert.equal(replayCommit.status, 303);

  const conflicting = replaceCsvCell(template, 'PROV-001', 'PROV-NEW');
  const blocked = await client.post(`${root}/preview`, { csv: conflicting, filename: 'same-name.csv' });
  assert.equal(blocked.status, 200);
  assert.match(blocked.text, /Names are never auto-merged/);
  assert.match(blocked.text, /Commit blocked/);

  const db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM suppliers WHERE workspace_id=? AND name='Example Cloud Services Ltd'`).get(workspaceId).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tprm_service_relationships WHERE workspace_id=?').get(workspaceId).count, 2);
  } finally { db.close(); }
});

test('a single invalid row blocks the whole file and a changed post-preview file is rejected', async () => {
  const root = `/workspaces/${workspaceId}/tprm/third-parties/import`;
  let fresh = replaceCsvCell(template, 'PROV-001', 'PROV-ATOMIC');
  fresh = replaceCsvCell(fresh, 'Example Cloud Services Ltd', 'Atomic Intake Services Ltd');
  const invalid = replaceCsvCell(fresh, 'security@example.invalid', 'not-an-email');
  const preview = await client.post(`${root}/preview`, { csv: invalid, filename: 'invalid.csv' });
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Commit blocked/);
  assert.match(preview.text, /Provider contact email is not valid/);
  const invalidCommit = await client.post(`${root}/commit`, { csv: invalid, filename: 'invalid.csv', preview_digest: '0'.repeat(64) });
  assert.equal(invalidCommit.status, 409);

  const validPreview = await client.post(`${root}/preview`, { csv: fresh, filename: 'valid.csv' });
  const digest = (validPreview.text.match(/name="preview_digest" value="([a-f0-9]{64})"/) || [])[1];
  assert.ok(digest);
  const changed = replaceCsvCell(fresh, 'Production hosting', 'Changed after preview');
  const changedCommit = await client.post(`${root}/commit`, { csv: changed, filename: 'changed.csv', preview_digest: digest });
  assert.equal(changedCommit.status, 409);
  assert.match(changedCommit.text, /changed after preview/i);

  const db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM suppliers WHERE workspace_id=? AND name='Atomic Intake Services Ltd'`).get(workspaceId).count, 0);
  } finally { db.close(); }
});

test('workspace register and firm delivery queue are bounded and preserve filters across pages', async () => {
  const db = new Database(dbPath);
  try {
    const insert = db.prepare(`INSERT INTO suppliers
      (workspace_id,name,service_provided,lifecycle_stage,business_owner,relationship_owner)
      VALUES (?,?,'Scale test service','prospect','Scale Client Owner','Scale Consultant')`);
    const tx = db.transaction(() => {
      for (let index = 1; index <= 54; index += 1) insert.run(workspaceId, `Scale Provider ${String(index).padStart(3, '0')}`);
    });
    tx();
  } finally { db.close(); }

  const first = await client.get(`/workspaces/${workspaceId}/tprm/third-parties?q=Scale%20Provider&status=all&per_page=25`);
  assert.equal(first.status, 200);
  assert.match(first.text, /Showing 1–25 of 54 matching third parties/);
  const firstLinks = [...first.text.matchAll(new RegExp(`/workspaces/${workspaceId}/tprm/third-parties/(\\d+)`, 'g'))].map(match => match[1]);
  assert.equal(new Set(firstLinks).size, 25);
  assert.match(first.text, /q=Scale(?:\+|%20)Provider/);
  assert.match(first.text, /status=all/);
  assert.match(first.text, /per_page=25/);

  const second = await client.get(`/workspaces/${workspaceId}/tprm/third-parties?q=Scale%20Provider&status=all&per_page=25&page=2`);
  assert.equal(second.status, 200);
  assert.match(second.text, /Showing 26–50 of 54 matching third parties/);
  assert.doesNotMatch(second.text, /Scale Provider 001/);
  assert.match(second.text, /Scale Provider 026/);

  const firm = await client.get('/tprm?q=Scale%20Provider&status=all&queue_page=2');
  assert.equal(firm.status, 200);
  assert.match(firm.text, /of 54 matching records/);
  assert.match(firm.text, /Page 2 of 2/);
  assert.match(firm.text, /q=Scale(?:\+|%20)Provider/);
  assert.doesNotMatch(firm.text, /Unauthorized Client|Hidden Provider/);
});
