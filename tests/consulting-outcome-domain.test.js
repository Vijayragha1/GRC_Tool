'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bootApp } = require('./helpers');

test('consulting domain preserves the contracted outcome through seeding, gap materialisation and portfolio projection', () => {
  const env = bootApp();
  const db = new Database(env.dbPath);
  const consulting = require('../lib/consulting-delivery');
  const delivery = require('../lib/engagement-delivery');
  try {
    const firm = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    const actor = db.prepare("SELECT * FROM users WHERE firm_id=? AND user_type='firm' ORDER BY id LIMIT 1").get(firm.id);
    const reviewerId = Number(db.prepare(`INSERT INTO users
      (email,password_hash,name,firm_id,user_type,firm_role,active)
      VALUES (?,?,?,?,?,?,1)`).run('domain-reviewer@example.com',actor.password_hash,'Domain Reviewer',firm.id,'firm','manager').lastInsertRowid);
    const createWorkspace = db.prepare(`INSERT INTO workspaces
      (firm_id,client_name,frameworks,engagement_outcome,lead_consultant_id,target_cert_date)
      VALUES (?,?,?,?,?,?)`);
    const fullId = Number(createWorkspace.run(firm.id,'Full Domain Client',JSON.stringify(['iso27001']),'certification_support',actor.id,'2027-12-31').lastInsertRowid);
    const gapId = Number(createWorkspace.run(firm.id,'Gap Domain Client',JSON.stringify(['iso27001']),'gap_assessment_only',actor.id,'2027-12-31').lastInsertRowid);
    const csfId = Number(createWorkspace.run(firm.id,'CSF Domain Client',JSON.stringify(['csf']),'certification_support',actor.id,null).lastInsertRowid);
    const neutralId = Number(createWorkspace.run(firm.id,'Programme Neutral Domain Client',JSON.stringify([]),'certification_support',actor.id,null).lastInsertRowid);
    const workspace = id => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);

    const fullEngagement = consulting.ensureEngagement(db,workspace(fullId),actor.id);
    const gapEngagement = consulting.ensureEngagement(db,workspace(gapId),actor.id);
    const csfEngagement = consulting.ensureEngagement(db,workspace(csfId),actor.id);
    const neutralEngagement = consulting.ensureEngagement(db,workspace(neutralId),actor.id);
    assert.equal(fullEngagement.engagement_type,'implementation');
    assert.equal(fullEngagement.target_date,'2027-12-31');
    assert.equal(gapEngagement.engagement_type,'gap_assessment');
    assert.equal(gapEngagement.target_date,null);
    assert.equal(csfEngagement.engagement_type,'implementation');
    assert.equal(csfEngagement.name,'CSF Domain Client consulting engagement');
    assert.deepEqual(JSON.parse(csfEngagement.framework_scope_json),['csf']);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(csfId).c,0,
      'a non-ISO consulting engagement must not silently create an ISO delivery plan');
    assert.equal(neutralEngagement.name,'Programme Neutral Domain Client consulting engagement');
    assert.deepEqual(JSON.parse(neutralEngagement.framework_scope_json),[]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM engagement_delivery_plans WHERE workspace_id=?').get(neutralId).c,0,
      'an unassigned consulting engagement must not silently default to ISO 27001');
    const incompleteFullProjection = delivery.getProjection(db,workspace(fullId),actor.id);
    assert.equal(incompleteFullProjection.summary.completionReady,false);
    assert.ok(incompleteFullProjection.summary.completionBlockers.some(blocker=>/Stage 1 certification audit/.test(blocker)));

    const passId = Number(db.prepare(`INSERT INTO assessment_passes
      (workspace_id,pass_number,label,status,started_by)
      VALUES (?,1,?,'in_progress',?)`).run(fullId,'Initial gap assessment',actor.id).lastInsertRowid);
    const requirement = db.prepare(`SELECT r.ref FROM requirements r
      JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001'
      ORDER BY r.sort_order LIMIT 1`).get();
    db.prepare(`INSERT INTO control_state_history
      (workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,pass_id)
      VALUES (?,?,?,'Not Implemented','included',0,?,?)`)
      .run(fullId,requirement.ref,actor.id,'Domain conclusion',passId);
    consulting.materializeAssessmentPass(db,workspace(fullId),db.prepare('SELECT * FROM assessment_passes WHERE id=?').get(passId),reviewerId);
    assert.equal(db.prepare('SELECT engagement_type FROM consulting_engagements WHERE id=?').get(fullEngagement.id).engagement_type,'implementation');

    db.prepare('UPDATE workspaces SET target_cert_date=? WHERE id=?').run('2028-06-30',fullId);
    const targetSync = delivery.syncCertificationTarget(db,workspace(fullId),actor.id);
    assert.equal(targetSync.applicable,true);
    assert.equal(targetSync.targetDate,'2028-06-30');
    assert.equal(db.prepare('SELECT target_date FROM consulting_engagements WHERE id=?').get(fullEngagement.id).target_date,'2028-06-30');
    const fullPlan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(fullId);
    assert.equal(fullPlan.target_completion_date,'2028-06-30');
    assert.equal(fullPlan.forecast_completion_date,'2028-06-30');

    const portfolio = consulting.portfolio(db,firm.id);
    assert.equal(portfolio.find(row=>row.workspace_id===fullId).engagement_outcome,'certification_support');
    assert.equal(portfolio.find(row=>row.workspace_id===gapId).engagement_outcome,'gap_assessment_only');
    assert.deepEqual(JSON.parse(portfolio.find(row=>row.workspace_id===csfId).frameworks),['csf']);
  } finally {
    db.close();
  }
});
