'use strict';
// The "minimum to pass Stage 2" floor for ISO 42001. The text is authored in
// data/iso42001-content.js; this proves the plumbing carries it the same way
// the ISO 27001 one does - into iso42001_items on boot, out through the gap
// report profile, and onto the assessment wizard - and that an item without a
// floor simply renders no floor section.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const content42 = require('../data/iso42001-content');
const report = require('../lib/gap-assessment-report');

let env, db, client, wsId, actorId, ws, itemId, floorText;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  const actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  actorId = actor.id;
  wsId = Number(db.prepare('INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES(?,?,?)')
    .run(actor.firm_id, 'AIMS certifiable floor', '["iso42001"]').lastInsertRowid);
  ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  require('../lib/iso42001-assessment').startPass(db, wsId, actorId);
  itemId = db.prepare("SELECT id FROM iso42001_items WHERE type='clause' ORDER BY sort_order").get().id;
  floorText = content42[itemId].minimum_certifiable;
});

test.after(async () => { db?.close(); await client?.close(); });

test('every ISO 42001 item carries its authored floor into the database on boot', () => {
  const authored = Object.keys(content42).filter(id => content42[id].minimum_certifiable);
  assert.equal(authored.length, 65);
  const stored = db.prepare(`SELECT COUNT(*) AS n FROM iso42001_items
    WHERE TRIM(COALESCE(minimum_certifiable,'')) <> ''`).get().n;
  assert.equal(stored, authored.length);
  for (const id of authored) {
    assert.equal(db.prepare('SELECT minimum_certifiable AS m FROM iso42001_items WHERE id=?').get(id).m,
      content42[id].minimum_certifiable);
  }
});

test('the ISO 42001 gap report reads the real floor column, as ISO 27001 does', () => {
  assert.equal(report.profileFor('iso42001').hasMinimum, true);
  assert.equal(report.profileFor('iso27001').hasMinimum, true);
  const data = report.buildGapAssessmentReportData(db, ws, null, { currentState: true, framework: 'iso42001' });
  assert.equal(data.rows.length, 65);
  assert.equal(data.rows.filter(row => row.minimum_certifiable).length, 65);
  assert.equal(data.rows.find(row => row.id === itemId).minimum_certifiable, floorText);
  // And the report still renders - the extra column is selected, not displayed.
  assert.match(report.renderGapAssessmentHtml(data), /ISO\/IEC\s*(<br>)?\s*42001:2023/);
});

test('the assessment wizard shows the floor, and shows no floor section without one', async () => {
  const page = await client.get(`/workspaces/${wsId}/iso42001/gap/${itemId}`);
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.match(page.text, /Minimum to pass Stage 2/);
  assert.match(page.text, new RegExp(floorText.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  db.prepare('UPDATE iso42001_items SET minimum_certifiable=NULL WHERE id=?').run(itemId);
  const bare = await client.get(`/workspaces/${wsId}/iso42001/gap/${itemId}`);
  assert.equal(bare.status, 200, bare.text.slice(0, 200));
  assert.doesNotMatch(bare.text, /Minimum to pass Stage 2/);
  assert.match(bare.text, /What good looks like/);
  db.prepare('UPDATE iso42001_items SET minimum_certifiable=? WHERE id=?').run(floorText, itemId);
});
