'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {bootClient}=require('./helpers');
let env,db,client,wsId,actorId,makerId,passId,itemId;
test.before(async()=>{
  env=await bootClient();client=env.client;db=new Database(env.dbPath);
  const actor=db.prepare("SELECT id,firm_id FROM users WHERE email='sec-test@example.com'").get();actorId=actor.id;
  makerId=Number(db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES('aims-maker@example.test','unused','AIMS Preparer',?,'firm','manager',1)").run(actor.firm_id).lastInsertRowid);
  wsId=Number(db.prepare('INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES(?,?,?)').run(actor.firm_id,'AIMS review integration','["iso42001"]').lastInsertRowid);
  passId=require('../lib/iso42001-assessment').startPass(db,wsId,makerId);
  const items=db.prepare('SELECT * FROM iso42001_items ORDER BY sort_order').all();itemId=items[0].id;
  for(const item of items){
    const requirementId=require('../lib/control-writes').requirementId(db,'iso42001',item.id);
    const note=`Observed ${item.title} has not yet been established; implementation evidence remains outstanding.`;
    db.prepare("INSERT INTO control_instances(workspace_id,requirement_id,entity_id,status,applicability,maturity,notes) VALUES(?,?,NULL,'not_implemented','applicable',0,?)").run(wsId,requirementId,note);
    const current=db.prepare('SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(wsId,item.id);
    db.prepare(`INSERT INTO iso42001_control_state_history(workspace_id,iso_item_id,pass_id,changed_by,status,applicability,maturity,inclusion_justification,exclusion_justification,notes,assessment_answers) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(wsId,item.id,passId,makerId,current.status,current.applicability,current.maturity,current.inclusion_justification,current.exclusion_justification,current.notes,current.assessment_answers);
  }
});
test.after(async()=>{db?.close();await client?.close();});

test('authorized independent route sign-off renders the frozen 65-requirement report and rejects edits to the closed pass',async()=>{
  const base=`/workspaces/${wsId}/iso42001`;
  const before=await client.get(`${base}/gap-assessment`);assert.equal(before.status,200);assert.match(before.text,/Independent assessment sign-off required/);
  const form=await client.get(`${base}/gap/${itemId}`);assert.equal(form.status,200);
  const fields=Object.fromEntries(['expected_record_version','private_draft_generation','private_draft_version','assessment_context','mutation_key','diagnostic_set_id'].map(name=>[name,(form.text.match(new RegExp(`name="${name}" value="([^"]*)"`))||[])[1]]));
  const result=await client.post(`${base}/gap-assessment/${passId}/complete`,{});assert.equal(result.status,302);assert.equal(result.location,`${base}/gap-assessment/${passId}/report`);
  const report=await client.get(result.location);assert.equal(report.status,200);assert.match(report.text,/Independently reviewed by Security Tester/);assert.match(report.text,/SHA-256/);assert.match(report.text,/ai-clause-4.1/);assert.match(report.text,/not a certification decision/);
  const snapshot=db.prepare('SELECT * FROM iso42001_assessment_snapshots WHERE pass_id=?').get(passId);assert.equal(JSON.parse(snapshot.snapshot_json).items.length,65);assert.equal(snapshot.reviewed_by,actorId);
  const stale=await client.post(`${base}/gap/${itemId}`,{...fields,action:'save',status:'Implemented',notes:'An edit submitted after independent completion.'});
  assert.equal(stale.status,409);assert.match(stale.text,/Start a new pass/);
  assert.equal(db.prepare('SELECT snapshot_hash FROM iso42001_assessment_snapshots WHERE pass_id=?').get(passId).snapshot_hash,snapshot.snapshot_hash);
  const after=await client.get(`${base}/gap-assessment`);assert.match(after.text,/Independently reviewed assessment retained/);assert.match(after.text,/Reviewed report/);
});

test('SoA metadata changes invalidate the retained assessment basis and reopen delivery immediately',async()=>{
  const assessment=require('../lib/iso42001-assessment');
  assert.equal(assessment.getGapState(db,wsId).complete,true);
  const frozen=assessment.loadSnapshot(db,wsId,passId).snapshot_hash;
  const workspace=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const engagement=require('../lib/consulting-delivery').ensureEngagement(db,workspace,actorId);
  db.prepare("UPDATE engagement_delivery_plans SET status='completed' WHERE workspace_id=?").run(wsId);
  db.prepare("UPDATE consulting_engagements SET status='complete' WHERE id=?").run(engagement.id);
  const result=await client.post(`/workspaces/${wsId}/iso42001/soa/metadata`,{version:'2.0',owner:'AI governance lead',approved_by:'Sponsor',approved_at:'2026-09-27'});
  assert.equal(result.status,302);assert.equal(assessment.getGapState(db,wsId).complete,false);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE workspace_id=?').get(wsId).status,'active');
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagement.id).status,'active');
  assert.equal(assessment.loadSnapshot(db,wsId,passId).snapshot_hash,frozen);
});

test('legacy completed pass has no review report and cannot be retrospectively completed',async()=>{
  const legacy=Number(db.prepare("INSERT INTO iso42001_assessment_passes(workspace_id,pass_number,name,started_by,status) VALUES(?,2,'Legacy',?,'completed')").run(wsId,makerId).lastInsertRowid);
  const base=`/workspaces/${wsId}/iso42001/gap-assessment`;
  assert.equal((await client.get(`${base}/${legacy}/report`)).status,404);
  const complete=await client.post(`${base}/${legacy}/complete`,{});assert.equal(complete.status,302);assert.match(decodeURIComponent(complete.location),/historical completions cannot be retrospectively signed off/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM iso42001_assessment_snapshots WHERE pass_id=?').get(legacy).n,0);
  const page=await client.get(base);assert.match(page.text,/Legacy completion[\s\S]{1,20}not independently reviewed/);
});

test('assessment completion requires sign-off permission at the HTTP boundary',async()=>{
  db.prepare("INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES(?,?,'assessment.signoff',0)").run(wsId,actorId);
  const response=await client.post(`/workspaces/${wsId}/iso42001/gap-assessment/${passId}/complete`,{});
  assert.equal(response.status,403);
});

test('starting a pass and bulk assessment changes immediately reopen persisted delivery completion',async()=>{
  const workspace=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const engagement=require('../lib/consulting-delivery').ensureEngagement(db,workspace,actorId);
  const plan=db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(wsId);
  function markHistoricalCompletion(){
    db.prepare("UPDATE engagement_delivery_plans SET status='completed' WHERE id=?").run(plan.id);
    db.prepare("UPDATE consulting_engagements SET status='complete',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(engagement.id);
  }
  function assertReopened(){
    assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id).status,'active');
    assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagement.id).status,'active');
  }
  markHistoricalCompletion();
  const started=await client.post(`/workspaces/${wsId}/iso42001/gap-assessment/start`,{});assert.equal(started.status,302);assertReopened();
  markHistoricalCompletion();
  const changed=await client.post(`/workspaces/${wsId}/iso42001/bulk-controls`,{ids:[itemId],status:'Work In Progress'});assert.equal(changed.status,302);assertReopened();
  markHistoricalCompletion();
  const evidence=Number(db.prepare("INSERT INTO evidence(workspace_id,filename,stored_path,sha256,uploaded_by) VALUES(?,'review.txt','unused-test-path',?,?)").run(wsId,'a'.repeat(64),actorId).lastInsertRowid);
  const linked=await client.post(`/workspaces/${wsId}/evidence/${evidence}/links`,{framework:'iso42001',item_ref:[itemId],section_ref:'Reviewed section'});
  assert.equal(linked.status,302);assertReopened();
  const links=db.prepare('SELECT id FROM evidence_requirement_links WHERE evidence_id=?').all(evidence);assert.equal(links.length,1);
});
