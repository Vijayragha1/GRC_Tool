'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {bootClient}=require('./helpers');
let env,db,client,wsId,actorId,item,requirementId,drafts;
const getState=()=>db.prepare('SELECT * FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL').get(wsId,requirementId);
const field=(html,name)=>{const form=html.slice(html.indexOf('id="assessForm"'));return (form.match(new RegExp(`name="${name}" value="([^"]*)"`))||[])[1];};
async function form(){const page=await client.get(`/workspaces/${wsId}/iso42001/gap/${item.id}`);assert.equal(page.status,200,page.text.slice(0,200));return {page,body:Object.fromEntries(['expected_record_version','private_draft_generation','private_draft_version','assessment_context','mutation_key','diagnostic_set_id'].map(name=>[name,field(page.text,name)]))};}
test.before(async()=>{
  env=await bootClient();client=env.client;db=new Database(env.dbPath);drafts=require('../lib/form-drafts');
  const actor=db.prepare("SELECT id,firm_id FROM users WHERE email='sec-test@example.com'").get();actorId=actor.id;
  wsId=Number(db.prepare('INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,?,?)').run(actor.firm_id,'AI assessment draft experience','["iso42001"]').lastInsertRowid);
  item=db.prepare("SELECT * FROM iso42001_items WHERE type='clause' ORDER BY sort_order LIMIT 1").get();
  requirementId=require('../lib/control-writes').requirementId(db,'iso42001',item.id);
});
test.after(async()=>{db?.close();await client?.close();});
test('opening and skipping an unassessed AI control never creates canonical state or history',async()=>{
  for(const path of ['gap-assessment','controls','soa'])assert.equal((await client.get(`/workspaces/${wsId}/iso42001/${path}`)).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM control_instances WHERE workspace_id=?').get(wsId).c,0,'read-only programme pages must not seed control states');
  assert.equal(getState(),undefined);const {page}=await form();assert.equal(getState(),undefined);assert.match(page.text,/No diagnostic responses have been recorded/);
  assert.match(page.text,/data-form-draft="assessment-iso42001"/);assert.match(page.text,/Save conclusion/);
  assert.equal((await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{action:'skip'})).status,302);
  assert.equal(getState(),undefined);assert.equal(db.prepare('SELECT COUNT(*) c FROM iso42001_control_state_history WHERE workspace_id=?').get(wsId).c,0);
});
test('native Skip retains a private draft and Save records entered diagnostics exactly once without auto-scoring',async()=>{
  let {body}=await form();
  assert.equal((await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{...body,action:'skip',notes:'Draft AI context before navigation',status:'Not Assessed',maturity:'2',q_0:'yes'})).status,302);
  assert.equal(getState(),undefined);
  let restored=await form();assert.match(restored.page.text,/Draft AI context before navigation/);assert.match(restored.page.text,/Your private draft is restored/);
  const submit={...restored.body,action:'save',notes:'Edited native form conclusion',status:'Not Assessed',maturity:'2',q_0:'yes'};
  const saved=await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,submit);assert.equal(saved.status,302);assert.equal(saved.location,`/workspaces/${wsId}/iso42001/gap/${item.id}`);
  assert.equal((await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,submit)).status,302);
  const state=getState();assert.equal(state.status,'not_assessed','diagnostic yes must never become a conclusion automatically');assert.equal(state.notes,'Edited native form conclusion');assert.equal(state.applicability,'applicable','mandatory clauses are included on every recorded save');
  const answers=JSON.parse(state.assessment_answers);assert.equal(answers.version,1);assert.equal(answers.questions[0].answer,'yes');assert.ok(answers.questions[0].id);
  assert.equal(drafts.get(db,{workspaceId:wsId,actorId,kind:'assessment-iso42001',recordId:item.id,contextKey:''}).draft,null);
  const history=db.prepare('SELECT * FROM iso42001_control_state_history WHERE workspace_id=? AND iso_item_id=?').all(wsId,item.id);assert.equal(history.length,1);assert.equal(history[0].assessment_answers,state.assessment_answers);
});
test('stale and invalid AI saves retain typed values and do not alter the recorded conclusion',async()=>{
  const {body}=await form();db.prepare('UPDATE control_instances SET notes=? WHERE id=?').run('Another consultant changed the conclusion.',getState().id);
  const response=await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{...body,action:'save',status:'Implemented',notes:'My retained draft text',q_0:'partial'});
  assert.equal(response.status,409);assert.match(response.text,/My retained draft text/);assert.match(response.text,/Another consultant changed the conclusion/);assert.equal(getState().status,'not_assessed');
  const next=await form();const invalid=await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{...next.body,action:'save',status:'Not Applicable',notes:'A mandatory clause cannot be excluded.'});
  assert.equal(invalid.status,422);assert.match(invalid.text,/mandatory clause cannot be excluded/i);assert.equal(getState().status,'not_assessed');
});
test('blank AI text clears explicitly, changed question sets reject, and native pass contexts cannot drift',async()=>{
  let current=await form();
  const changed=await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{...current.body,diagnostic_set_id:'obsolete-question-set',notes:'Retain this on question change',action:'save'});
  assert.equal(changed.status,409);assert.match(changed.text,/Retain this on question change/);
  const first=Number(db.prepare("INSERT INTO iso42001_assessment_passes(workspace_id,pass_number,name,started_by) VALUES (?,1,'Native pass',?)").run(wsId,actorId).lastInsertRowid);
  current=await form();assert.equal(current.body.assessment_context,String(first));
  db.prepare("UPDATE iso42001_assessment_passes SET status='completed' WHERE id=?").run(first);
  db.prepare("INSERT INTO iso42001_assessment_passes(workspace_id,pass_number,name,started_by) VALUES (?,2,'Next pass',?)").run(wsId,actorId);
  const drift=await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{...current.body,action:'save',notes:'Written for the original pass'});assert.equal(drift.status,409);assert.match(drift.text,/Written for the original pass/);
  const latest=await form();const clear=await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{...latest.body,action:'save',notes:'',status:'Not Implemented'});assert.equal(clear.status,302);assert.equal(getState().notes,'');
  const history=db.prepare('SELECT pass_id FROM iso42001_control_state_history WHERE workspace_id=? ORDER BY id DESC LIMIT 1').get(wsId);assert.notEqual(history.pass_id,first);assert.ok(history.pass_id);
});


test('AI diagnostic responses can be explicitly returned to unanswered without changing the chosen conclusion',async()=>{
  const current=await form();assert.match(current.page.text,/Unanswered/);
  const response=await client.post(`/workspaces/${wsId}/iso42001/gap/${item.id}`,{...current.body,action:'save',status:'Not Implemented',q_0:''});
  assert.equal(response.status,302);const state=getState();assert.equal(state.status,'not_implemented');assert.equal(JSON.parse(state.assessment_answers).questions[0].answer,null);
});
