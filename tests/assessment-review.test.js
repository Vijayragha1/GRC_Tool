'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const bcrypt=require('bcrypt');
const {bootClient,makeClient}=require('./helpers');

test('ISO review decisions are independent, version-bound and atomically notified',async t=>{
  const env=await bootClient(),db=new Database(env.dbPath),manager=env.client;
  const service=require('../lib/control-review');
  const author=db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  const password='Independent-review-password-123';
  const makeUser=(email,role)=>Number(db.prepare(`INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES (?,?,?,?,'firm',?,1)`).run(email,bcrypt.hashSync(password,4),email,author.firm_id,role).lastInsertRowid);
  const reviewerId=makeUser('assessment-reviewer@example.com','senior_consultant'),juniorId=makeUser('assessment-preparer@example.com','consultant');
  const wsId=Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks,lead_consultant_id) VALUES (?,'Review isolation','["iso27001","iso42001"]',?)`).run(author.firm_id,author.id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')").run(wsId,juniorId);
  const ws=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId),reviewer=makeClient(env.app),junior=makeClient(env.app);
  t.after(async()=>{db.close();await manager.close();await reviewer.close();await junior.close();});
  async function login(http,email){const p=await http.get('/login'),csrf=p.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/)[1];await http.post('/login',{email,password,_csrf:csrf},{csrf:false});await http.get(`/workspaces/${wsId}/client-portal`);}
  await login(reviewer,'assessment-reviewer@example.com');await login(junior,'assessment-preparer@example.com');
  await manager.get(`/workspaces/${wsId}/client-portal`);
  for(const framework of ['iso27001','iso42001']){
    await t.test(`${framework} rejects missing, stale, self and unrequested decisions`,async()=>{
      const item=db.prepare(`SELECT r.id,r.ref FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code=? ORDER BY r.sort_order LIMIT 1`).get(framework);
      db.prepare(`INSERT INTO control_instances(workspace_id,requirement_id,entity_id,status,notes) VALUES (?,?,NULL,'partially_implemented','Recorded source conclusion')`).run(wsId,item.id);
      const table=framework==='iso27001'?'control_state_history':'iso42001_control_state_history';
      db.prepare(`INSERT INTO ${table}(workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes) VALUES (?,?,?,'Partially Implemented','included',1,'Recorded source conclusion')`).run(wsId,item.ref,author.id);
      const path=`/workspaces/${wsId}/${framework==='iso27001'?'controls/assess':'iso42001/gap'}/${item.ref}`;
      const state=()=>db.prepare('SELECT * FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL').get(wsId,item.id);
      let row=state();
      const missing=await junior.post(path+'/flag-for-review',{reason:'Second opinion'});assert.equal(missing.status,422);assert.equal(state().review_status,'none');
      const noRequest=await reviewer.post(path+'/review-action',{expected_record_version:String(row.record_version),action:'approve',note:'No request exists'});assert.equal(noRequest.status,409);
      const requested=await junior.post(path+'/flag-for-review',{expected_record_version:String(row.record_version),reason:'Inspect recorded evidence'});
      assert.equal(requested.status,302);row=state();assert.equal(row.review_status,'requested');
      const requestEvent=db.prepare("SELECT * FROM assessment_review_events WHERE workspace_id=? AND requirement_id=? AND action='request'").get(wsId,item.id);
      assert.equal(requestEvent.source_record_version,row.record_version-1);assert.equal(requestEvent.result_record_version,row.record_version);
      const recipients=db.prepare('SELECT recipient_id FROM notification_outbox WHERE event_key=?').all(`assessment_review_event:${requestEvent.id}`).map(row=>row.recipient_id);
      assert.ok(recipients.includes(reviewerId));assert.ok(!recipients.includes(author.id));assert.ok(!recipients.includes(juniorId),'the requester and latest preparer are not notified as reviewers');
      const self=await manager.post(path+'/review-action',{expected_record_version:String(row.record_version),action:'approve',note:'I wrote this conclusion'});assert.equal(self.status,403);assert.match(self.text,/latest preparer cannot review their own/);
      const denied=await junior.post(path+'/review-action',{expected_record_version:String(row.record_version),action:'approve',note:'Consultant lacks signoff'});assert.equal(denied.status,403);
      const stale=await reviewer.post(path+'/review-action',{expected_record_version:String(row.record_version-1),action:'approve',note:'Retained stale note'});assert.equal(stale.status,409);assert.match(stale.text,/Retained stale note/);
      const missingNote=await reviewer.post(path+'/review-action',{expected_record_version:String(row.record_version),action:'approve'});assert.equal(missingNote.status,422);
      const page=await reviewer.get(path);assert.equal(page.status,200);assert.match(page.text,/Independent assessment review/);assert.match(page.text,new RegExp(`name="expected_record_version" value="${row.record_version}"`));
      const approved=await reviewer.post(path+'/review-action',{expected_record_version:String(row.record_version),action:'approve',note:'Recorded conclusion agrees with the retained evidence.'});assert.equal(approved.status,302);assert.equal(state().review_status,'reviewed');
      const replay=await reviewer.post(path+'/review-action',{expected_record_version:String(row.record_version),action:'approve',note:'Replay'});assert.equal(replay.status,409);
      const obsoleteClear=await junior.post(path+'/clear-flag',{expected_record_version:String(row.record_version)});assert.equal(obsoleteClear.status,409);assert.equal(state().review_status,'reviewed');
      assert.throws(()=>db.prepare('UPDATE assessment_review_events SET note=? WHERE id=?').run('rewritten',requestEvent.id),/immutable/);
      // A fresh review must be requested after further assessment edits, even if the reviewer reloads.
      row=state();await junior.post(path+'/clear-flag',{expected_record_version:String(row.record_version)});
      row=state();await junior.post(path+'/flag-for-review',{expected_record_version:String(row.record_version),reason:'Next review'});
      db.prepare("UPDATE control_instances SET notes='Changed after request' WHERE id=?").run(row.id);
      row=state();const changed=await reviewer.post(path+'/review-action',{expected_record_version:String(row.record_version),action:'approve',note:'Reloaded but source changed'});
      assert.equal(changed.status,409);assert.match(changed.text,/changed after review was requested/);assert.equal(state().review_status,'requested');
      const reflag=await junior.post(path+'/flag-for-review',{expected_record_version:String(row.record_version),reason:'Review updated conclusion'});assert.equal(reflag.status,302);
      const fresh=state();const sentBack=await reviewer.post(path+'/review-action',{expected_record_version:String(fresh.record_version),action:'send_back',note:'Please address the evidence gap.'});assert.equal(sentBack.status,302);assert.equal(state().review_status,'needs_changes');
    });
  }
  await t.test('outbox failure rolls back the state, immutable event and audit callback',()=>{
    const item=db.prepare(`SELECT r.id,r.ref FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' ORDER BY r.sort_order LIMIT 1 OFFSET 1`).get();
    db.prepare("INSERT INTO control_instances(workspace_id,requirement_id,entity_id,status) VALUES (?,?,NULL,'not_implemented')").run(wsId,item.id);
    const before=db.prepare('SELECT * FROM control_instances WHERE workspace_id=? AND requirement_id=?').get(wsId,item.id);
    db.exec("CREATE TEMP TRIGGER test_fail_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'simulated outbox failure'); END;");
    assert.throws(()=>service.transition(db,{workspace:ws,actor:author,framework:'iso27001',itemId:item.ref,action:'request',expectedRecordVersion:before.record_version,note:'Atomic request'},()=>db.prepare("INSERT INTO consulting_events(workspace_id,entity_type,actor_id,action) VALUES (?,'review_test',?,'audit')").run(wsId,author.id)),/simulated outbox failure/);
    db.exec('DROP TRIGGER test_fail_outbox');
    assert.deepEqual(db.prepare('SELECT * FROM control_instances WHERE id=?').get(before.id),before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM assessment_review_events WHERE workspace_id=? AND requirement_id=?').get(wsId,item.id).n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM consulting_events WHERE workspace_id=? AND entity_type='review_test'").get(wsId).n,0);
  });
  await t.test('review authority follows current workspace membership and workspace role',()=>{
    const item=db.prepare(`SELECT r.id,r.ref FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' ORDER BY r.sort_order LIMIT 1`).get();
    const actor=db.prepare('SELECT * FROM users WHERE id=?').get(juniorId);
    db.prepare("UPDATE workspace_members SET role='senior_consultant' WHERE workspace_id=? AND user_id=?").run(wsId,juniorId);
    assert.equal(service.context(db,ws,actor,'iso27001',item.ref).hasAuthority,true,'workspace delivery role supplies native signoff authority');
    db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(wsId,juniorId);
    assert.equal(service.context(db,ws,{...actor,firm_role:'manager'},'iso27001',item.ref).hasAuthority,false,'a stale or invented role cannot restore removed membership');
    const version=db.prepare('SELECT record_version FROM control_instances WHERE workspace_id=? AND requirement_id=?').get(wsId,item.id).record_version;
    assert.throws(()=>service.transition(db,{workspace:ws,actor,framework:'iso27001',itemId:item.ref,action:'clear',expectedRecordVersion:version}),error=>error.status===403);
  });
});
