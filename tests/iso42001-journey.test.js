'use strict';
// The engagement as one ordered path (lib/iso42001-journey.js): the next step
// moves on by itself as records appear, a step waits on the one it needs, a
// step the organisation does not need is skipped, and every module page says
// what to do next.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, wsId, gapId;
const base = (id = wsId) => `/workspaces/${id}/iso42001`;
// The next-step line at the foot of the band.
const pathLine = (html) => {
  const at = html.indexOf('class="a42-path"');
  assert.ok(at > 0, 'the page shows the next step');
  return html.slice(at, html.indexOf('</div>', at)).replace(/\s+/g, ' ');
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name, outcome) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, '["iso42001"]', ?)`)
    .run(actor.firm_id, name, outcome).lastInsertRowid);
  wsId = add('Kestrel Lending', 'certification_support');
  gapId = add('Wren Insurance', 'gap_assessment_only');
});
test.after(async () => { db?.close(); await client?.close(); });

test('a new engagement starts at the scoping questions, and every module page says so', async () => {
  const catalog = await client.get(`${base()}/exec-brief`);
  assert.match(pathLine(catalog.text), /Next, step 1 of 24<\/span> <strong>Answer the scoping questions<\/strong>/, 'a page that is no step points to the next one');
  assert.match(pathLine(catalog.text), new RegExp(`href="${base()}/intake">Start`));
  const soa = await client.get(`${base()}/soa`);
  assert.match(pathLine(soa.text), /This page is step 11 of 24.<\/span> Step 1 comes first: <strong>Answer the scoping questions<\/strong>/);

  const intake = await client.get(`${base()}/intake`);
  assert.match(pathLine(intake.text), /Step 1 of 24<\/span> <strong>Answer the scoping questions<\/strong> is done on this page<span class="a42-path-detail"> · 0 of 5 required answers given/);

  const overview = await client.get(`${base()}/overview`);
  assert.match(overview.text, /Your path · step 1 of 24/);
  assert.doesNotMatch(overview.text, /class="a42-path"/, 'the overview leads with the next step, so the band does not repeat it');
  assert.match(overview.text, new RegExp(`href="${base()}/intake">Start step 1`));
});

test('the next step moves on as the records appear', async () => {
  for (const key of ['org-context', 'role', 'regulatory', 'system-count', 'top-concerns']) {
    db.prepare(`INSERT INTO iso42001_intake_answers (workspace_id, question_key, answer) VALUES (?, ?, 'Answered')`).run(wsId, key);
  }
  const intake = await client.get(`${base()}/intake`);
  assert.match(pathLine(intake.text), /Step 1 is done.<\/span> Next, step 2 of 24: <strong>List the AI systems in scope<\/strong>/);
  assert.match(pathLine(intake.text), new RegExp(`href="${base()}/ai-systems">Go to step 2`));

  const system = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Writing assistant', 'in_use', 1, ?)`)
    .run(wsId, actor.id).lastInsertRowid);
  const roles = await client.get(`${base()}/roles`);
  assert.match(pathLine(roles.text), /Step 3 of 24<\/span> <strong>Say what the organisation does with each AI system<\/strong> is done on this page<span class="a42-path-detail"> · 0 of 1 AI system answered/);

  const version = db.prepare('SELECT version FROM ai_systems WHERE id=?').get(system).version;
  await client.post(`${base()}/roles/${system}`, { version, role_builds: 'no', role_trains: 'no', role_sourced: 'yes', role_uses: 'yes', role_offers: 'no', role_partners: 'no' });
  const after = await client.get(`${base()}/roles`);
  assert.match(pathLine(after.text), /Next, step 4 of 24: <strong>Record the context and interested parties<\/strong>/);
});

test('a step waits on the one it needs, and a step the organisation does not need is skipped', async () => {
  const path = await client.get(`${base()}/path`);
  assert.equal(path.status, 200);
  assert.match(path.text, /<h1 class="page-title">Your path<\/h1>/);
  for (const stage of ['Mobilise', 'Assess', 'Implement', 'Assure', 'Readiness', 'Certification']) {
    assert.match(path.text, new RegExp(`<h3 class="a42-list-group"><a href="${base()}/stages/[a-z]+">${stage}</a>`));
  }
  const step = (html, title) => {
    const at = html.indexOf(`${title}</a>`);
    assert.ok(at > 0, `${title} is on the path`);
    return html.slice(html.lastIndexOf('<li', at), html.indexOf('</li>', at));
  };
  assert.match(step(path.text, 'Assess the AI risks and record the assessment'), /After step 9<\/span> · Set the AIMS&#39;s risk criteria/);
  assert.match(step(path.text, 'Record the context and interested parties'), /class="is-next"[\s\S]*btn btn-primary/);
  assert.match(step(path.text, 'Answer the scoping questions'), /class="is-done"/);

  await client.post(`${base()}/soa/ai-annex-a-4-3`, { applicability: 'excluded', justification: 'No data of ours goes into the assistant' });
  const skipped = await client.get(`${base()}/path`);
  assert.match(step(skipped.text, 'Record the data behind each AI system'), /class="is-skip"[\s\S]*Not needed<\/span> · A\.4\.3 is excluded/);
  assert.match(pathLine((await client.get(`${base()}/soa`)).text), / of 23\./, 'a skipped step leaves the count');
});

test('a gap assessment opens on its short path, which ends with the report', async () => {
  assert.equal((await client.get(`/workspaces/${gapId}`)).location, `${base(gapId)}/overview`);
  assert.equal((await client.get(`${base(gapId)}/overview`)).location, `${base(gapId)}/path`, 'opening the client lands on the path');
  const page = await client.get(`${base(gapId)}/path`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /class="a42-path"/, 'the path page leads with the next step itself');
  assert.match(pathLine((await client.get(`${base(gapId)}/context`)).text), /This page is step 4 of 7.<\/span> Step 1 comes first: <strong>Answer the scoping questions<\/strong>/);
  assert.match(page.text, />Assess<\/a>[\s\S]*>Report<\/a>/);
  assert.match(page.text, /Publish the gap assessment report/);
  assert.doesNotMatch(page.text, /Pass the Stage 1 and Stage 2 audits/);
  const nav = await client.get(`${base()}/soa`);
  assert.match(nav.text, new RegExp(`href="${base()}/path" class="nav-subitem\\s*"[^>]*><span>Your path</span>`), 'the path is in the menu');
});

test('the menu holds the overview, the path and the stages, and an open page marks its stage', async () => {
  const group = (html) => {
    const at = html.indexOf('aria-label="ISO 42001"');
    return html.slice(at, html.indexOf('</details>', at));
  };
  const soa = await client.get(`${base()}/soa`);
  const labels = [...group(soa.text).matchAll(/class="nav-subitem[^"]*"[^>]*><span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Programme overview', 'Your path', '1. Mobilise', '2. Assess', '3. Implement', '4. Assure', '5. Readiness', '6. Certification']);
  assert.match(group(soa.text), new RegExp(`href="${base()}/stages/implement" class="nav-subitem active"`), 'the SoA marks Implement');
  assert.match(group((await client.get(`${base()}/ai-systems`)).text), new RegExp(`href="${base()}/stages/assess" class="nav-subitem active"`));

  const gapLabels = [...group((await client.get(`${base(gapId)}/context`)).text).matchAll(/class="nav-subitem[^"]*"[^>]*><span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(gapLabels, ['Your path', '1. Assess', '2. Report']);

  const path = await client.get(`${base()}/path`);
  assert.match(path.text, /<summary>Every page in the module<\/summary>/);
  assert.match(path.text, new RegExp(`<h3 class="a42-list-group">Implement</h3>[\\s\\S]*?href="${base()}/soa">Statement of Applicability`));
  assert.doesNotMatch((await client.get(`${base(gapId)}/path`)).text, />Certification cycle</, 'a gap assessment has no certification pages');
});
