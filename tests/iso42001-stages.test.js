'use strict';
// The ISO 42001 engagement's stages as pages (lib/iso42001-stages.js): each
// lists its work with a live state and the delivery-plan steps it covers; the
// masthead runway and the sidebar link to them, and every module page marks
// its stage. A gap-assessment-only engagement has the assessment and its
// report.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

let env, client, db, actor, aimsId, gapId;
const ws = (id) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const base = (id) => `/workspaces/${id}/iso42001`;
const STAGES = [['mobilise', 'Mobilise'], ['assess', 'Assess'], ['implement', 'Implement'], ['assure', 'Assure'], ['readiness', 'Readiness'], ['certification', 'Certification']];
// The runway entry marked as the open page's stage, if any.
const here = (html) => (html.match(/<li class="[^"]*is-here[^"]*"[^>]*><a href="[^"]*\/stages\/([a-z]+)" aria-current="page">/) || [])[1] || null;
// One line of a stage's work list.
const line = (html, title) => {
  const at = html.indexOf(`>${title}</a>`);
  assert.ok(at > 0, `${title} is listed`);
  return html.slice(at, html.indexOf('</li>', at));
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name, outcome) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, '["iso42001"]', ?)`)
    .run(actor.firm_id, name, outcome).lastInsertRowid);
  aimsId = add('Kestrel Lending', 'certification_support');
  gapId = add('Wren Insurance', 'gap_assessment_only');
  const delivery = require('../lib/engagement-delivery');
  delivery.getProjection(db, ws(aimsId), actor.id);
  delivery.getProjection(db, ws(gapId), actor.id);
});
test.after(async () => { db?.close(); await client?.close(); });

test('every stage of a certification engagement is a page, linked from the runway and the sidebar', async () => {
  const opened = await client.get(`${base(aimsId)}/stages`);
  assert.match(opened.location, new RegExp(`^${base(aimsId)}/stages/mobilise$`), '/stages opens the stage the engagement is in');

  for (const [key, name] of STAGES) {
    const page = await client.get(`${base(aimsId)}/stages/${key}`);
    assert.equal(page.status, 200, `${name} opens`);
    assert.match(page.text, new RegExp(`<h1 class="page-title">${name}</h1>`));
    assert.equal(here(page.text), key, `the runway marks ${name}`);
    assert.match(page.text, new RegExp(`href="${base(aimsId)}/stages/${key}" class="nav-subitem active"`), `the sidebar marks ${name}`);
    STAGES.forEach(([other], i) => assert.match(page.text, new RegExp(`>${i + 1}\\. ${STAGES[i][1]}<`), `${other} is in the sidebar`));
  }

  const assess = await client.get(`${base(aimsId)}/stages/assess`);
  for (const href of ['/gap-assessment', '/ai-systems', '/datasets', '/risks/criteria', '/risks'])
    assert.match(assess.text, new RegExp(`class="a42-list-title" href="${base(aimsId)}${href}"`), `Assess links to ${href}`);
  const assure = await client.get(`${base(aimsId)}/stages/assure`);
  assert.match(assure.text, new RegExp(`href="/workspaces/${aimsId}/audits"[\\s\\S]{0,400}opens outside the module`), 'a shared page says it leaves the module');

  const kickoff = db.prepare(`SELECT m.title FROM engagement_delivery_milestones m JOIN engagement_delivery_phases p ON p.id=m.phase_id
    JOIN engagement_delivery_plans pl ON pl.id=m.plan_id WHERE pl.workspace_id=? AND p.phase_key='mobilisation' ORDER BY m.id LIMIT 1`).get(aimsId);
  const mobilise = await client.get(`${base(aimsId)}/stages/mobilise`);
  assert.ok(mobilise.text.includes(kickoff.title.replace(/&/g, '&amp;')), 'the stage lists its plan steps');

  assert.equal((await client.get(`${base(aimsId)}/stages/report`)).status, 404, 'a certification engagement has no report-only stage');
  assert.equal((await client.get(`${base(aimsId)}/stages/elsewhere`)).status, 404);
});

test('each module page marks its stage on the runway', async () => {
  for (const [path, key] of [['/risks', 'assess'], ['/datasets', 'assess'], ['/context', 'mobilise'], ['/soa', 'implement'], ['/concerns', 'assure'], ['/readiness', 'readiness'], ['/cert-cycle', 'certification']]) {
    const page = await client.get(`${base(aimsId)}${path}`);
    assert.equal(page.status, 200, path);
    assert.equal(here(page.text), key, `${path} belongs to ${key}`);
  }
  assert.equal(here((await client.get(`${base(aimsId)}/overview`)).text), null, 'the overview spans every stage');
});

test('a stage\'s steps show their state from the records', async () => {
  const before = await client.get(`${base(aimsId)}/stages/assess`);
  assert.match(line(before.text, 'Assess the AI risks and record the assessment'), /After step \d+<\/span> · Set the AIMS&#39;s risk criteria/, 'a step waits on the one it needs');
  assert.match(line(before.text, 'Set the AIMS&#39;s risk criteria'), /The default criteria are still in use/);
  assert.match(line(before.text, 'Assess every requirement of the standard'), /0 of 65 requirements concluded/);

  await client.post(`${base(aimsId)}/risks/assessments`, { label: 'AI risk assessment, Q4', performed_on: new Date().toISOString().slice(0, 10) });
  const after = await client.get(`${base(aimsId)}/stages/assess`);
  assert.match(line(after.text, 'Assess the AI risks and record the assessment'), /Done/);
  assert.match(after.text, /Steps done<\/span><strong>1 <small>of 5<\/small>/);
});

test('a gap-assessment-only engagement has the assessment and its report', async () => {
  const assess = await client.get(`${base(gapId)}/stages/assess`);
  assert.equal(assess.status, 200);
  assert.match(assess.text, /Stage 1 of 2/);
  for (const title of ['Answer the scoping questions', 'List the AI systems in scope', 'Say what the organisation does with each AI system',
    'Record the context and interested parties', 'Assess every requirement of the standard']) line(assess.text, title);
  assert.match(assess.text, />1\. Assess</);
  assert.match(assess.text, />2\. Report</);
  assert.doesNotMatch(assess.text, />3\. /);

  const report = await client.get(`${base(gapId)}/stages/report`);
  assert.equal(report.status, 200);
  assert.match(line(report.text, 'Have the assessment independently reviewed'), /After step 5/);
  line(report.text, 'Publish the gap assessment report');
  assert.equal((await client.get(`${base(gapId)}/stages/mobilise`)).status, 404, 'no certification stages on a gap assessment');
  assert.equal(here((await client.get(`${base(gapId)}/context`)).text), 'assess', 'every module page is part of the assessment');
});
