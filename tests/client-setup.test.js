'use strict';
// Onboarding a client with more than one service.
//
// Guards two defects that shipped together: the create flow could only send a
// consultant to one scoping surface and fell through to the ISO 27001 intake
// for everyone else, and the workspace open-redirect used an ISO 27001-only
// table as a universal "setup started" signal.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let setupLib;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  setupLib = require('../lib/client-setup');
});

test.after(async () => { if (client) await client.close(); });

function created(location) {
  const match = String(location || '').match(/workspaces\/(\d+)/);
  assert.ok(match, `expected a workspace redirect, got ${location}`);
  return Number(match[1]);
}

function workspace(id) {
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = require('../lib/frameworks').parseWorkspaceFrameworks(row.frameworks);
  return row;
}

test('a multi-programme client lands on the setup hub, not one programme intake', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Multi Programme Client',
    frameworks: ['iso27001', 'iso42001', 'csf', 'dpdpa'],
    engagement_outcome: 'certification_support',
  });
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/workspaces\/\d+\/setup(?:\?|$)/,
    'a client with four programmes must not be sent to a single programme intake');

  const id = created(res.location);
  const setup = setupLib.clientSetup(db, workspace(id));
  assert.equal(setup.total, 4, 'every enabled programme needs its own step');
  assert.deepEqual(setup.steps.map(s => s.key), ['iso27001', 'iso42001', 'csf', 'dpdpa']);
  assert.ok(setup.steps.every(s => s.status === 'not_started'));
  assert.equal(setup.nextStep.key, 'iso27001');
});

test('a client with no ISO 27001 is never sent to the ISO 27001 intake', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'AI And Maturity Only', frameworks: ['iso42001', 'csf'],
  });
  const id = created(res.location);
  assert.doesNotMatch(res.location, /\/intake/,
    'the ISO 27001 intake is not this client\'s scoping surface');

  // The old open-redirect counted engagement_intake rows, which stay at zero
  // forever for this client, so it was bounced to /intake on every open.
  const open = await client.get(`/workspaces/${id}`);
  assert.equal(open.status, 302);
  assert.match(open.location, /\/setup$/);

  const setup = setupLib.clientSetup(db, workspace(id));
  assert.deepEqual(setup.steps.map(s => s.key), ['iso42001', 'csf']);
});

test('a single-service client goes straight to its own surface', async () => {
  for (const [frameworks, pattern] of [
    [['dpdpa'], /\/dpdpa(?:\?|$)/],
    [['csf'], /\/csf(?:\?|$)/],
    [['iso42001'], /\/iso42001\/intake(?:\?|$)/],
    [['iso27001'], /\/intake(?:\?|$)/],
  ]) {
    const res = await client.post('/workspaces', {
      client_name: `Single ${frameworks[0]} Client`,
      frameworks,
      ...(frameworks[0] === 'iso27001' ? { engagement_outcome: 'certification_support' } : {}),
    });
    assert.match(res.location, pattern,
      `a ${frameworks[0]}-only client should open its own scoping surface, not a checklist of one`);
  }
});

test('the seeded cert-deadline answer never counts as setup progress', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Seeded Deadline Client',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
    target_cert_date: '2027-06-30',
  });
  const id = created(res.location);

  // Creating with a target date seeds one engagement_intake row. The old
  // universal count read that as "setup has begun", so the client looked
  // started, never got redirected, and tripped the partial-setup banner.
  const seeded = db.prepare(`SELECT COUNT(*) c FROM engagement_intake
    WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer))>0`).get(id).c;
  assert.ok(seeded >= 1, 'this test is meaningless unless the seed still happens');

  const setup = setupLib.clientSetup(db, workspace(id));
  assert.equal(setup.steps[0].status, 'not_started',
    'an untouched client must read as not started despite the seeded answer');
  assert.equal(setupLib.needsSetup(db, workspace(id)), true);
});

test('a real scope statement is required, not placeholder prose', () => {
  const res = db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES ((SELECT id FROM firms LIMIT 1),'Placeholder Scope Client',?, 'certification_support')`)
    .run(JSON.stringify(['iso27001']));
  const id = Number(res.lastInsertRowid);

  // applyIntakeToClient writes this string when the answers are empty, and it
  // is long enough to pass every length check in the codebase.
  db.prepare(`UPDATE workspaces SET scope=?, scope_confirmed_at=datetime('now') WHERE id=?`)
    .run('The information security management system covers the operations of [org-name - not answered].', id);

  const setup = setupLib.clientSetup(db, workspace(id));
  assert.notEqual(setup.steps[0].status, 'complete',
    'placeholder scope prose must never count as a signed-off scope');
});

test('modules alone do not make a client look scoped', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Programmes Plus TPRM',
    frameworks: ['iso27001', 'csf'],
    engagement_outcome: 'certification_support',
    tprm_enabled: '1',
    tprm_service_model: 'programme_setup',
  });
  const id = created(res.location);
  const ws = workspace(id);
  const setup = setupLib.clientSetup(db, ws);

  const tprm = setup.steps.find(s => s.key === 'tprm');
  assert.ok(tprm, 'the TPRM module needs its own step');
  assert.equal(tprm.status, 'complete', 'the service model was chosen on the create form');
  assert.equal(tprm.kind, 'module');

  // One complete module must not suppress the redirect while every contracted
  // programme is still unscoped.
  assert.equal(setupLib.needsSetup(db, ws), true);
  // And a programme outranks a module when pointing at the next move.
  assert.equal(setup.nextStep.kind, 'programme');
});

test('third-party risk can be added to a client that already has a programme', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'TPRM Added Later', frameworks: ['csf'],
  });
  const id = created(res.location);
  const hub = await client.get(`/workspaces/${id}/setup`);
  assert.equal(hub.status, 200);
  // The enable form used to live only on the unassigned-client screen, which
  // renders exclusively when frameworks is empty, so this was unreachable.
  assert.match(hub.text, new RegExp(`action="/workspaces/${id}/modules/tprm"`),
    'the setup hub must host the TPRM service-model form');
});
