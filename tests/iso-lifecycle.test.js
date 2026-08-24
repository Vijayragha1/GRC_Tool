'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');
const lifecycle = require('../lib/iso-lifecycle');

let env;
let client;
let db;
let firmId;
let managerId;
let gapWorkspaceId;
let certificationWorkspaceId;
let neutralWorkspaceId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId = db.prepare("SELECT id FROM users WHERE email='sec-test@example.com'").get().id;
});

test.after(async () => {
  if (db) db.close();
  if (client) await client.close();
});

test('new-client onboarding requires a plain-language contracted outcome', async () => {
  const page = await client.get('/workspaces/new');
  assert.equal(page.status, 200);
  assert.match(page.text, /Contracted ISO 27001 outcome/);
  assert.match(page.text, /Gap assessment only/);
  assert.match(page.text, /Full certification support/);
  assert.match(page.text, /issue the report, and close this engagement/);
  assert.match(page.text, /Stage 1 and Stage 2 support/);
  assert.match(page.text, /id="iso27001-outcome-fieldset"[^>]*hidden/);
  assert.match(page.text, /choice\.required = hasIso27001/);

  const before = db.prepare('SELECT COUNT(*) c FROM workspaces').get().c;
  const missing = await client.post('/workspaces', {
    client_name: 'Missing Outcome Client',
    frameworks: 'iso27001',
  });
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Choose whether this engagement ends/);
  assert.match(missing.text, /name="engagement_outcome"[^>]*required/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM workspaces').get().c, before);

  const invalid = await client.post('/workspaces', {
    client_name: 'Invalid Outcome Client',
    frameworks: 'iso27001',
    engagement_outcome: 'stage_1_only',
  });
  assert.equal(invalid.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM workspaces').get().c, before);
});

test('non-ISO and programme-neutral clients can be created without an ISO outcome or certification artefacts', async () => {
  const csfCreated = await client.post('/workspaces', {
    client_name: 'CSF Only Lifecycle Client',
    frameworks: 'csf',
    target_cert_date: '2027-11-30',
  });
  assert.equal(csfCreated.status, 302);
  const csfWorkspace = db.prepare("SELECT * FROM workspaces WHERE client_name='CSF Only Lifecycle Client'").get();
  assert.deepEqual(JSON.parse(csfWorkspace.frameworks), ['csf']);
  assert.equal(csfWorkspace.target_cert_date, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM consulting_engagements WHERE workspace_id=?').get(csfWorkspace.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(csfWorkspace.id).c, 0);

  const dashboard = await client.get('/dashboard');
  assert.equal(dashboard.status, 200);
  const csfRow = (dashboard.text.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [])
    .find(row => row.includes('CSF Only Lifecycle Client')) || '';
  assert.ok(csfRow, 'the non-ISO client should appear on the dashboard');
  assert.doesNotMatch(csfRow, /Gap assessment only|Full certification support/);

  const neutralCreated = await client.post('/workspaces', { client_name: 'Programme Neutral Lifecycle Client' });
  assert.equal(neutralCreated.status, 302);
  const neutral = db.prepare("SELECT * FROM workspaces WHERE client_name='Programme Neutral Lifecycle Client'").get();
  neutralWorkspaceId = neutral.id;
  assert.deepEqual(JSON.parse(neutral.frameworks), []);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM consulting_engagements WHERE workspace_id=?').get(neutral.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(neutral.id).c, 0);
});

test('enabling ISO 27001 later requires an explicit outcome and creates the matching engagement and plan', async () => {
  const setupPage = await client.get(`/workspaces/${neutralWorkspaceId}?skipSetupRedirect=1`);
  assert.equal(setupPage.status, 200);
  assert.match(setupPage.text, /Choose the contracted endpoint before ISO 27001 is enabled/);
  assert.match(setupPage.text, /id="enable-iso27001-outcome"[^>]*hidden/);

  const missing = await client.post(`/workspaces/${neutralWorkspaceId}/frameworks`, {
    frameworks: 'iso27001',
  });
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Choose whether the ISO 27001 engagement ends/);
  assert.deepEqual(JSON.parse(db.prepare('SELECT frameworks FROM workspaces WHERE id=?').get(neutralWorkspaceId).frameworks), []);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM consulting_engagements WHERE workspace_id=?').get(neutralWorkspaceId).c, 0);

  const enabled = await client.post(`/workspaces/${neutralWorkspaceId}/frameworks`, {
    frameworks: 'iso27001',
    engagement_outcome: 'gap_assessment_only',
    target_cert_date: '2028-04-30',
  });
  assert.equal(enabled.status, 302);
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(neutralWorkspaceId);
  assert.deepEqual(JSON.parse(workspace.frameworks), ['iso27001']);
  assert.equal(workspace.engagement_outcome, 'gap_assessment_only');
  assert.equal(workspace.target_cert_date, null);
  const engagement = db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=?').get(neutralWorkspaceId);
  assert.equal(engagement.engagement_type, 'gap_assessment');
  assert.deepEqual(JSON.parse(engagement.framework_scope_json), ['iso27001']);
  assert.equal(engagement.target_date, null);
  const plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(neutralWorkspaceId);
  assert.ok(plan);
  assert.equal(plan.consulting_engagement_id, engagement.id);
  assert.equal(plan.name, 'ISO 27001 gap assessment delivery plan');
});

test('gap-assessment-only onboarding seeds a report-only consulting engagement', async () => {
  const created = await client.post('/workspaces', {
    client_name: 'Gap Only Client',
    industry: 'Technology',
    scope: 'Corporate ISMS scope',
    target_cert_date: '2027-12-31',
    frameworks: 'iso27001',
    engagement_outcome: 'gap_assessment_only',
  });
  assert.equal(created.status, 302);
  assert.match(created.location, /\/workspaces\/\d+\/intake/);

  const workspace = db.prepare("SELECT * FROM workspaces WHERE client_name='Gap Only Client'").get();
  gapWorkspaceId = workspace.id;
  assert.equal(workspace.engagement_outcome, 'gap_assessment_only');
  assert.equal(workspace.target_cert_date, null, 'gap-only work must not inherit a certification deadline');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM engagement_intake WHERE workspace_id=? AND question_id='cert-deadline'").get(workspace.id).c, 0);

  const engagement = db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=?').get(workspace.id);
  assert.equal(engagement.engagement_type, 'gap_assessment');
  assert.equal(engagement.name, 'Gap Only Client ISO 27001 gap assessment');
  assert.equal(engagement.status, 'active');
  assert.ok(db.prepare('SELECT 1 FROM engagement_commercials WHERE engagement_id=?').get(engagement.id));
  assert.ok(db.prepare("SELECT 1 FROM consulting_engagement_team WHERE engagement_id=? AND user_id=? AND role='engagement_lead'").get(engagement.id, managerId));
});

test('certification-support onboarding retains its target and implementation engagement', async () => {
  const created = await client.post('/workspaces', {
    client_name: 'Certification Client',
    industry: 'Technology',
    scope: 'Corporate ISMS scope',
    target_cert_date: '2027-12-31',
    frameworks: 'iso27001',
    engagement_outcome: 'certification_support',
  });
  assert.equal(created.status, 302);

  const workspace = db.prepare("SELECT * FROM workspaces WHERE client_name='Certification Client'").get();
  certificationWorkspaceId = workspace.id;
  assert.equal(workspace.engagement_outcome, 'certification_support');
  assert.equal(workspace.target_cert_date, '2027-12-31');
  assert.equal(db.prepare("SELECT answer FROM engagement_intake WHERE workspace_id=? AND question_id='cert-deadline'").get(workspace.id).answer, '2027-12-31');
  const engagement = db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=?').get(workspace.id);
  assert.equal(engagement.engagement_type, 'implementation');
  assert.equal(engagement.name, 'Certification Client ISO 27001 certification support');
});

test('gap-only can continue to certification support but cannot be shortened back', async () => {
  let workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(gapWorkspaceId);
  const completedGap = db.prepare("SELECT * FROM consulting_engagements WHERE workspace_id=? AND engagement_type='gap_assessment'").get(gapWorkspaceId);
  db.prepare("UPDATE consulting_engagements SET status='complete',completed_at=datetime('now') WHERE id=?").run(completedGap.id);
  const unconfirmed = await client.post(`/workspaces/${gapWorkspaceId}/update`, {
    client_name: workspace.client_name,
    industry: workspace.industry,
    scope: workspace.scope,
    engagement_outcome: 'certification_support',
  });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.text, /confirm the one-way change/i);
  assert.equal(db.prepare('SELECT engagement_outcome FROM workspaces WHERE id=?').get(gapWorkspaceId).engagement_outcome, 'gap_assessment_only');

  const converted = await client.post(`/workspaces/${gapWorkspaceId}/update`, {
    client_name: workspace.client_name,
    industry: workspace.industry,
    scope: workspace.scope,
    target_cert_date: '2028-03-31',
    engagement_outcome: 'certification_support',
    confirm_outcome_upgrade: '1',
  });
  assert.equal(converted.status, 302);
  workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(gapWorkspaceId);
  assert.equal(workspace.engagement_outcome, 'certification_support');
  assert.equal(workspace.target_cert_date, '2028-03-31');
  const engagement = db.prepare("SELECT * FROM consulting_engagements WHERE workspace_id=? AND status NOT IN ('complete','cancelled') ORDER BY id LIMIT 1").get(gapWorkspaceId);
  assert.equal(engagement.engagement_type, 'implementation');
  assert.equal(engagement.name, 'Gap Only Client ISO 27001 certification support');
  assert.equal(engagement.target_date, '2028-03-31');
  assert.notEqual(engagement.id, completedGap.id);
  const retainedGap = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(completedGap.id);
  assert.equal(retainedGap.status, 'complete');
  assert.equal(retainedGap.engagement_type, 'gap_assessment');
  assert.ok(db.prepare("SELECT 1 FROM consulting_events WHERE workspace_id=? AND action='contracted_outcome_synchronized'").get(gapWorkspaceId));
  let plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(gapWorkspaceId);
  assert.equal(plan.status, 'active');
  assert.equal(plan.consulting_engagement_id, engagement.id);
  assert.equal(plan.target_completion_date, '2028-03-31');
  assert.equal(plan.forecast_completion_date, '2028-03-31');

  const targetChanged = await client.post(`/workspaces/${gapWorkspaceId}/update`, {
    client_name: workspace.client_name,
    industry: workspace.industry,
    scope: workspace.scope,
    target_cert_date: '2028-06-30',
    frameworks_present: '1',
    frameworks: 'iso27001',
    engagement_outcome: 'certification_support',
  });
  assert.equal(targetChanged.status, 302);
  assert.equal(db.prepare('SELECT target_date FROM consulting_engagements WHERE id=?').get(engagement.id).target_date, '2028-06-30');
  plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(gapWorkspaceId);
  assert.equal(plan.target_completion_date, '2028-06-30');
  assert.equal(plan.forecast_completion_date, '2028-06-30');
  assert.equal(db.prepare("SELECT answer FROM engagement_intake WHERE workspace_id=? AND question_id='cert-deadline'").get(gapWorkspaceId).answer, '2028-06-30');

  db.prepare(`UPDATE engagement_intake SET answer='2028-09-30',answered_by=?,answered_at=CURRENT_TIMESTAMP
    WHERE workspace_id=? AND question_id='cert-deadline'`).run(managerId, gapWorkspaceId);
  const intakeApplied = await client.post(`/workspaces/${gapWorkspaceId}/intake/apply`, {});
  assert.equal(intakeApplied.status, 302);
  assert.equal(db.prepare('SELECT target_cert_date FROM workspaces WHERE id=?').get(gapWorkspaceId).target_cert_date, '2028-09-30');
  assert.equal(db.prepare('SELECT target_date FROM consulting_engagements WHERE id=?').get(engagement.id).target_date, '2028-09-30');
  plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(gapWorkspaceId);
  assert.equal(plan.target_completion_date, '2028-09-30');
  assert.equal(plan.forecast_completion_date, '2028-09-30');

  const downgrade = await client.post(`/workspaces/${gapWorkspaceId}/update`, {
    client_name: workspace.client_name,
    industry: workspace.industry,
    scope: workspace.scope,
    engagement_outcome: 'gap_assessment_only',
  });
  assert.equal(downgrade.status, 409);
  assert.match(downgrade.text, /cannot be shortened to gap assessment only/i);
  assert.equal(db.prepare('SELECT engagement_outcome FROM workspaces WHERE id=?').get(gapWorkspaceId).engagement_outcome, 'certification_support');
  assert.equal(db.prepare("SELECT engagement_type FROM consulting_engagements WHERE workspace_id=? AND status NOT IN ('complete','cancelled') ORDER BY id LIMIT 1").get(gapWorkspaceId).engagement_type, 'implementation');
});

test('full certification support cannot be bypassed by removing and re-enabling ISO 27001', async () => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(certificationWorkspaceId);
  const removal = await client.post(`/workspaces/${certificationWorkspaceId}/update`, {
    client_name: workspace.client_name,
    industry: workspace.industry,
    scope: workspace.scope,
    frameworks_present: '1',
    frameworks: 'csf',
    engagement_outcome: 'certification_support',
  });
  assert.equal(removal.status, 409);
  assert.match(removal.text, /ISO 27001 cannot be removed/i);
  assert.deepEqual(JSON.parse(db.prepare('SELECT frameworks FROM workspaces WHERE id=?').get(certificationWorkspaceId).frameworks), ['iso27001']);

  const directRemoval = await client.post(`/workspaces/${certificationWorkspaceId}/frameworks`, {
    frameworks: 'csf',
  });
  assert.equal(directRemoval.status, 409);
  assert.match(directRemoval.text, /ISO 27001 cannot be removed/i);

  // Reproduce a row created by the former bypass: the framework flag was
  // removed while the full plan and implementation engagement remained.
  db.prepare(`UPDATE workspaces SET frameworks='["csf"]',engagement_outcome='gap_assessment_only' WHERE id=?`)
    .run(certificationWorkspaceId);
  const reenableAsGap = await client.post(`/workspaces/${certificationWorkspaceId}/frameworks`, {
    frameworks: ['csf', 'iso27001'],
    engagement_outcome: 'gap_assessment_only',
  });
  assert.equal(reenableAsGap.status, 409);
  assert.match(reenableAsGap.text, /cannot be shortened to gap assessment only/i);
  assert.equal(db.prepare('SELECT engagement_outcome FROM workspaces WHERE id=?').get(certificationWorkspaceId).engagement_outcome, 'gap_assessment_only');
  assert.equal(db.prepare('SELECT engagement_type FROM consulting_engagements WHERE workspace_id=? ORDER BY id LIMIT 1').get(certificationWorkspaceId).engagement_type, 'implementation');
  assert.ok(db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=?').get(certificationWorkspaceId));

  const recoveredAsFull = await client.post(`/workspaces/${certificationWorkspaceId}/frameworks`, {
    frameworks: ['csf', 'iso27001'],
    engagement_outcome: 'certification_support',
    target_cert_date: '2028-12-31',
  });
  assert.equal(recoveredAsFull.status, 302, recoveredAsFull.text);
  const recoveredWorkspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(certificationWorkspaceId);
  assert.equal(recoveredWorkspace.engagement_outcome, 'certification_support');
  assert.equal(recoveredWorkspace.target_cert_date, '2028-12-31');
  assert.equal(db.prepare('SELECT target_date FROM consulting_engagements WHERE workspace_id=? ORDER BY id LIMIT 1').get(certificationWorkspaceId).target_date, '2028-12-31');
  const recoveredPlan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(certificationWorkspaceId);
  assert.equal(recoveredPlan.target_completion_date, '2028-12-31');
  assert.equal(recoveredPlan.forecast_completion_date, '2028-12-31');
});

test('legacy rows and unknown values normalize to full certification support', () => {
  const id = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,lead_consultant_id)
    VALUES (?,'Legacy Lifecycle Client','["iso27001"]',?)`).run(firmId, managerId).lastInsertRowid);
  assert.equal(db.prepare('SELECT engagement_outcome FROM workspaces WHERE id=?').get(id).engagement_outcome, 'certification_support');
  assert.equal(lifecycle.normalizeOutcome(null), 'certification_support');
  assert.equal(lifecycle.normalizeOutcome('unexpected'), 'certification_support');
  assert.equal(lifecycle.isGapOnly('gap_assessment_only'), true);
  assert.equal(lifecycle.label('certification_support'), 'Full certification support');
  assert.throws(() => db.prepare("UPDATE workspaces SET engagement_outcome='invalid' WHERE id=?").run(id), /CHECK constraint failed/);
});
