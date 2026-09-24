'use strict';
// The standard ISO 42001 certification checklist: the same requests for every
// client, no auditor dates, and each client's own optional audit dates.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const { VERSION, CHECKLIST } = require('../data/iso42001-audit-checklist');
const CATALOG = require('../data/iso42001-catalog');

const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('the checklist is complete, dateless and mapped to real requirements', () => {
  const ids = new Set(CATALOG.map(i => i.id));
  const keys = new Set();
  for (const e of CHECKLIST) {
    assert.ok(!keys.has(e.key), `duplicate key ${e.key}`);
    keys.add(e.key);
    assert.match(e.key, /^(S1|S2)-\d{2}$|^POP-\d$|^SMP-\d{2}$/);
    assert.ok(['stage1', 'stage2', 'fieldwork'].includes(e.stage));
    assert.ok(['evidence', 'policy', 'population', 'sample'].includes(e.kind));
    assert.equal(e.kind === 'sample', e.stage === 'fieldwork', `${e.key}: samples and only samples are fieldwork`);
    for (const ref of e.refs) assert.ok(ids.has(ref), `${e.key}: ${ref} is not in the catalogue`);
    assert.ok(e.title.length > 20 && e.checks.length > 20, `${e.key}: title and checks`);
    assert.doesNotMatch(`${e.title} ${e.checks}`, /[–—]|\b20\d\d-\d\d-\d\d\b|\d{1,2}\/\d{1,2}\/\d{2,4}/, `${e.key}: no dashes or dates`);
  }
  const by = k => CHECKLIST.filter(e => (k === 'population' ? e.kind === 'population' : e.stage === k && e.kind !== 'population')).length;
  assert.deepEqual({ s1: by('stage1'), s2: by('stage2'), pop: by('population'), smp: by('fieldwork') }, { s1: 45, s2: 29, pop: 6, smp: 12 });
  const cited = new Set(CHECKLIST.flatMap(e => e.refs));
  for (const clause of ['4.3', '5.2', '6.1.2', '6.1.3', '6.1.4', '8.4', '9.2', '9.3', '10.2']) assert.ok(cited.has(`ai-clause-${clause}`), `clause ${clause} is asked for`);
});

let env, db, client, actor, audit;
const ws = (name, frameworks = ['iso42001']) => Number(db.prepare('INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, ?)')
  .run(actor.firm_id, name, JSON.stringify(frameworks), 'certification_support').lastInsertRowid);
const row = (wsId, ref) => db.prepare('SELECT * FROM aims_audit_requests WHERE workspace_id=? AND ref=?').get(wsId, ref);
const clientOf = wsId => {
  const id = Number(db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active) VALUES (?, '!noauth', ?, 'client', 1)`)
    .run(`owner-${wsId}@client.example`, `Owner ${wsId}`).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'client_owner')").run(wsId, id);
  return id;
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  audit = require('../lib/iso42001-audit');
});
test.after(async () => { db?.close(); await client?.close(); });

test('one click gives a client its own dateless copy of the checklist', async () => {
  const id = ws('Checklist client A');
  const empty = await client.get(`/workspaces/${id}/iso42001/requests`);
  assert.match(empty.text, /The certification checklist has not been started/);
  assert.match(empty.text, /Start the checklist/);

  const started = await client.post(`/workspaces/${id}/iso42001/checklist`, {});
  assert.equal(started.status, 302);
  assert.match(decodeURIComponent(started.location), new RegExp(`Certification checklist started: ${CHECKLIST.length} requests`));
  const rows = db.prepare("SELECT * FROM aims_audit_requests WHERE workspace_id=? AND source='standard'").all(id);
  assert.equal(rows.length, CHECKLIST.length);
  assert.ok(rows.every(r => r.due_date === null), 'no request carries an auditor date');
  assert.equal(row(id, 'S1-05').stage, 'stage1');
  assert.equal(row(id, 'SMP-01').stage, 'fieldwork');
  const mapped = db.prepare('SELECT item_id FROM aims_request_requirements WHERE request_id=?').all(row(id, 'S1-11').id).map(r => r.item_id);
  assert.deepEqual(mapped, ['ai-clause-6.1.3']);
  const prog = db.prepare('SELECT * FROM aims_audit_programmes WHERE workspace_id=?').get(id);
  assert.equal(prog.checklist_version, VERSION);
  assert.equal(prog.stage1_date, null, 'starting the checklist sets no dates');

  const overview = await client.get(`/workspaces/${id}/iso42001/overview`);
  assert.match(overview.text, /45 Stage 1 requests have not been started/);
  assert.doesNotMatch(overview.text, /Stage 1 is in \d+ days/, 'no countdown without a date');
  assert.match(overview.text, /Add audit dates \(optional\)/);
  assert.match(overview.text, /Documents the auditor reviews at Stage 1/);

  const detail = await client.get(`/workspaces/${id}/iso42001/requests/${row(id, 'S1-06').id}`);
  assert.match(detail.text, /Checklist reference S1-06/);
  assert.match(detail.text, /What the auditor checks/);
  assert.match(detail.text, /Standard certification checklist/);
  assert.doesNotMatch(detail.text, /Auditor&#39;s date|Auditor's date/);
});

test('clients on different audit dates each get dates from their own programme, or none', () => {
  const early = ws('Checklist client early');
  const late = ws('Checklist client late');
  const undated = ws('Checklist client undated');
  const dates = { [early]: addDays(TODAY, 40), [late]: addDays(TODAY, 150) };
  for (const id of [early, late, undated]) {
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    audit.applyStandardChecklist(db, w, actor.id);
    if (dates[id]) audit.updateProgramme(db, w, actor.id, { stage1_date: dates[id], stage2_date: addDays(dates[id], 60) });
    audit.sendToClient(db, w, actor.id, [row(id, 'S1-05').id], { assignee_id: clientOf(id) }, TODAY);
  }
  const askedBy = id => db.prepare('SELECT due_date FROM client_requests WHERE id=?').get(row(id, 'S1-05').client_request_id).due_date;
  assert.equal(askedBy(early), addDays(dates[early], -14));
  assert.equal(askedBy(late), addDays(dates[late], -14));
  assert.equal(askedBy(undated), null, 'no audit date recorded: the client is not given one');
  const reason = db.prepare('SELECT request_reason FROM client_requests WHERE id=?').get(row(undated, 'S1-05').client_request_id).request_reason;
  assert.match(reason, /will ask for this when it reviews the AI management system documents at Stage 1/);
  assert.match(reason, /Checklist reference S1-05/);
  assert.doesNotMatch(reason, /\d{4}-\d{2}-\d{2}/);
});

test('re-applying keeps consultant work, a certification body list sits alongside, and a newer version is offered', async () => {
  const id = ws('Checklist client B');
  const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  audit.applyStandardChecklist(db, w, actor.id);
  const target = row(id, 'S1-06');
  audit.transition(db, w, actor.id, target.id, 'mark_not_applicable', { version: target.version, note: 'Covered by the group AI policy.' }, TODAY);
  const again = audit.applyStandardChecklist(db, w, actor.id);
  assert.deepEqual({ added: again.added, updated: again.updated, withdrawn: again.withdrawn }, { added: 0, updated: 0, withdrawn: 0 });
  assert.equal(row(id, 'S1-06').status, 'not_applicable', 're-applying never resets a status');

  // A certification body's own list is kept separately: neither source withdraws the other.
  const ids = CATALOG.map(i => i.id);
  const csv = 'Req ID,Description,Requirement,Due\r\nCB-1,Provide the AI policy,ISO 42001 Clause 5.2,\r\n';
  const importId = audit.previewImport(db, w, actor.id, { buffer: Buffer.from(csv), originalname: 'cb.csv' });
  audit.commitImport(db, w, actor.id, importId, {});
  assert.ok(row(id, 'CB-1'));
  assert.equal(row(id, 'S1-05').withdrawn_at, null);
  audit.applyStandardChecklist(db, w, actor.id);
  assert.equal(row(id, 'CB-1').withdrawn_at, null);
  assert.equal(db.prepare('SELECT stage1_date FROM aims_audit_programmes WHERE workspace_id=?').get(id).stage1_date, null, 'an import without dates leaves the client undated');
  assert.ok(ids.length);

  db.prepare("UPDATE aims_audit_programmes SET checklist_version='2025.1' WHERE workspace_id=?").run(id);
  const overview = await client.get(`/workspaces/${id}/iso42001/overview`);
  assert.match(overview.text, new RegExp(`Update checklist to ${VERSION.replace('.', '\\.')}`));
  const updated = await client.post(`/workspaces/${id}/iso42001/checklist`, {});
  assert.match(decodeURIComponent(updated.location), new RegExp(`Checklist brought up to version ${VERSION.replace('.', '\\.')}`));
});
