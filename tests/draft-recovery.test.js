'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {bootClient,makeClient}=require('./helpers');
let boot,db,user,ws,item,base,api,drafts,diagnostics;
const json=r=>JSON.parse(r.text);
const state=()=>db.prepare('SELECT * FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(ws,item);
const history=()=>db.prepare('SELECT COUNT(*) n FROM control_state_history WHERE workspace_id=?').get(ws).n;
test.before(async()=>{
  boot=await bootClient();db=new Database(boot.dbPath);
  user=db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  ws=Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Draft recovery fixture','["iso27001"]')`).run(user.firm_id).lastInsertRowid);
  item=db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1").get().id;
  base=`/workspaces/${ws}/controls/assess/${item}`;api=`/workspaces/${ws}/form-drafts/assessment/${item}`;
  drafts=require('../lib/form-drafts');diagnostics=require('../lib/assessment-diagnostics');
});
test.after(async()=>{db?.close();await boot?.client.close();});
test('opening an assessment and reading a missing draft do not create canonical state or a pass',async()=>{
  const before=history();const page=await boot.client.get(base);assert.equal(page.status,200,page.text.slice(-1200));
  assert.equal(state(),undefined);assert.equal(history(),before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assessment_passes WHERE workspace_id=?').get(ws).n,0);
  assert.equal(json(await boot.client.get(api)).draft,null);
});
test('private autosaves recover without changing progress; stale saves cannot resurrect discarded drafts',async()=>{
  const original=await boot.client.put(api,{payload:{notes:'Private diagnosis',q_0:'yes'},baseVersion:'0',generation:0,expectedDraftVersion:0,clientSaveId:'initial'},{json:true,csrf:true});
  assert.equal(original.status,200,original.text);const d=json(original).draft;
  assert.equal(state(),undefined);assert.equal(history(),0);
  assert.equal(json(await boot.client.get(api)).draft.payload.notes,'Private diagnosis');
  const conflict=await boot.client.put(api,{payload:{notes:'other tab'},baseVersion:'0',generation:d.generation,expectedDraftVersion:0},{json:true,csrf:true});assert.equal(conflict.status,409);
  const removed=await boot.client.deleteBody(api,{generation:d.generation,expectedDraftVersion:d.version},{json:true,csrf:true});assert.equal(removed.status,200,removed.text);
  const late=await boot.client.put(api,{payload:{notes:'delayed discarded text'},baseVersion:'0',generation:d.generation,expectedDraftVersion:d.version},{json:true,csrf:true});assert.equal(late.status,409);
  assert.equal(json(await boot.client.get(api)).draft,null);
});
test('Skip for now retains a native form draft without assessment/history/verification writes',async()=>{
  const get=json(await boot.client.get(api));
  const r=await boot.client.post(base,{action:'skip',notes:'Retain my unfinished note',status:'Implemented',maturity:'4',expected_record_version:'0',private_draft_generation:get.generation,private_draft_version:'0'});
  assert.equal(r.status,302,r.text);assert.equal(state(),undefined);assert.equal(history(),0);
  assert.equal(json(await boot.client.get(api)).draft.payload.notes,'Retain my unfinished note');
});
test('formal save applies the exact draft revision atomically, records diagnostics and replays idempotently',async()=>{
  const loaded=json(await boot.client.get(api));const existing=loaded.draft;
  const saved=json(await boot.client.put(api,{payload:{notes:'The exact selected revision',status:'Partially Implemented',maturity:'2',applicability:'included',q_0:'partial'},baseVersion:'0',generation:existing.generation,expectedDraftVersion:existing.version,clientSaveId:'selected'},{json:true,csrf:true})).draft;
  const body={action:'save',notes:'This form body must not replace the selected draft',draft_id:saved.id,draft_version:saved.version,draft_generation:saved.generation,expected_record_version:'0',mutation_key:'record-once'};
  const first=await boot.client.post(base,{...body});assert.equal(first.status,302,first.text.slice(-1500));
  assert.equal(state().notes,'The exact selected revision');assert.equal(state().status,'Partially Implemented');assert.equal(history(),1);
  const answers=JSON.parse(state().assessment_answers);assert.equal(answers.questions[0].answer,'partial');assert.ok(answers.questions[0].id);assert.ok(answers.questions[0].text);
  assert.equal(db.prepare('SELECT assessment_answers FROM control_state_history WHERE workspace_id=? ORDER BY id DESC LIMIT 1').get(ws).assessment_answers,state().assessment_answers);
  // A pass was lazily created by this first formal save, so idempotency lookup
  // must work before resolving a new active-context draft.
  const again=await boot.client.post(base,{...body});assert.equal(again.status,302,again.text.slice(-1000));assert.equal(history(),1);
  const raw=db.prepare('SELECT state,generation FROM form_drafts WHERE id=?').get(saved.id);assert.equal(raw.state,'consumed');
  assert.throws(()=>drafts.save(db,{workspaceId:ws,actorId:user.id,kind:'assessment',recordId:item,contextKey:'',recordVersion:state().record_version},{payload:{notes:'late'},baseVersion:'0',generation:saved.generation,expectedDraftVersion:saved.version}),/another tab/);
});
test('integer versions catch same-second writes and failed validation preserves both recorded and entered values',async()=>{
  const version=state().record_version;
  const reqId=db.prepare('SELECT requirement_id FROM control_instances WHERE workspace_id=?').get(ws).requirement_id;
  db.prepare("UPDATE control_instances SET notes='Another consultant recorded this' WHERE workspace_id=? AND requirement_id=?").run(ws,reqId);
  assert.ok(state().record_version>version);
  const conflict=await boot.client.post(base,{action:'save',notes:'My concurrent unsaved edits',status:'Implemented',expected_record_version:String(version)});
  assert.equal(conflict.status,409,conflict.text.slice(-1200));assert.match(conflict.text,/My concurrent unsaved edits/);assert.match(conflict.text,/Another consultant recorded this/);assert.equal(history(),1);
  const invalid=await boot.client.post(base,{action:'save',notes:'Validation must retain this',maturity:'15',expected_record_version:String(state().record_version)});
  assert.equal(invalid.status,422);assert.match(invalid.text,/Validation must retain this/);assert.equal(history(),1);
});
test('diagnostic identity survives reordering, explicit clearing and historical absence',()=>{
  const original=diagnostics.serialize('item',['First question','Second question'],{q_0:'yes',q_1:'no'});
  assert.deepEqual(diagnostics.read(original,'item',['Second question','First question']).answers,{'0':'no','1':'yes'});
  const clear=diagnostics.serialize('item',['First question','Second question'],{q_0:'',q_1:''});assert.deepEqual(diagnostics.read(clear,'item',['First question','Second question']).answers,{});
  assert.equal(diagnostics.read(null,'item',['First question']).available,false);
  assert.throws(()=>diagnostics.serialize('item',['New question'],{diagnostic_set_id:JSON.parse(original).setId,q_0:'yes'}),/questions changed/);
});
test('drafts cannot be read by another actor, client namespaces cannot expose assessments',async()=>{
  const anon=makeClient(boot.app);try{const r=await anon.get(api,{headers:{Accept:'application/json'}});assert.equal(r.status,401);}finally{await anon.close();}
  const c={workspaceId:ws,actorId:user.id,kind:'assessment',recordId:item,contextKey:'isolation',recordVersion:1};
  drafts.save(db,c,{payload:{notes:'Actor-private canary'},baseVersion:'1',generation:0,expectedDraftVersion:0});
  const other=Number(db.prepare("INSERT INTO users(email,name,password_hash,user_type,firm_id,firm_role) VALUES ('draft-other@example.test','Other','!','firm',?,'manager')").run(user.firm_id).lastInsertRowid);
  assert.equal(drafts.get(db,{...c,actorId:other}).draft,null);
});
test('failed domain mutations roll back consumption and idempotency receipts',()=>{
  const c={workspaceId:ws,actorId:user.id,kind:'assessment',recordId:item,contextKey:'atomic',recordVersion:1};
  const d=drafts.save(db,c,{payload:{notes:'Keep if mutation fails'},baseVersion:'1',generation:0,expectedDraftVersion:0});
  assert.throws(()=>drafts.commit(db,c,{draft_id:d.id,draft_version:d.version,draft_generation:d.generation,mutation_key:'fail'},()=>{throw new Error('domain rejected');}),/domain rejected/);
  assert.equal(drafts.get(db,c).draft.payload.notes,'Keep if mutation fails');assert.equal(db.prepare("SELECT COUNT(*) n FROM form_mutations WHERE mutation_key='fail'").get().n,0);
});

test('native Skip restores visible edits and native Save consumes only its displayed private revision',async()=>{
  const nativeWs=Number(db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Native recovery fixture','[\"iso27001\"]')").run(user.firm_id).lastInsertRowid);
  const path=`/workspaces/${nativeWs}/controls/assess/${item}`,draftApi=`/workspaces/${nativeWs}/form-drafts/assessment/${item}`;
  const initial=await boot.client.get(path),nativeForm=initial.text.slice(initial.text.indexOf('id="assessForm"'));
  const csrf=(nativeForm.match(/name="_csrf" value="([^"]+)"/)||[])[1];assert.ok(csrf,'Native assessment forms must contain a server-rendered CSRF input');
  let result=await boot.client.post(path,{_csrf:csrf,action:'skip',notes:'Native retained edits',status:'Partially Implemented',maturity:'2',q_0:'no',expected_record_version:'0',private_draft_generation:'0',private_draft_version:'0',assessment_context:''},{csrf:false});
  assert.equal(result.status,302,result.text);
  const draft=json(await boot.client.get(draftApi)).draft;
  const page=await boot.client.get(path);assert.equal(page.status,200,page.text.slice(-1500));assert.match(page.text,/Native retained edits/);assert.match(page.text,/<noscript><label>Answer<select name="q_0">/);assert.match(page.text,/name="q_0"[^>]*value="no"/);
  result=await boot.client.post(path,{action:'save',notes:'Native edits at submission',status:'Partially Implemented',maturity:'2',q_0:'partial',expected_record_version:'0',private_draft_generation:draft.generation,private_draft_version:draft.version,assessment_context:'',mutation_key:'native-once'});
  assert.equal(result.status,302,result.text.slice(-1500));assert.equal(db.prepare('SELECT notes FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(nativeWs,item).notes,'Native edits at submission');assert.equal(db.prepare('SELECT state FROM form_drafts WHERE id=?').get(draft.id).state,'consumed');
  const overlong='Retain overlong text '+ 'x'.repeat(40001);
  const current=db.prepare('SELECT record_version FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(nativeWs,item).record_version;
  const invalid=await boot.client.post(path,{action:'save',notes:overlong,expected_record_version:current});assert.equal(invalid.status,422);assert.ok(invalid.text.includes(overlong));
});

test('native commit rejects a newer private revision and preserves drafts after validation failure',()=>{
  const context={workspaceId:ws,actorId:user.id,kind:'assessment',recordId:item,contextKey:'native-atomic',recordVersion:1};
  const first=drafts.save(db,context,{payload:{notes:'First private revision'},baseVersion:'1',generation:0,expectedDraftVersion:0});
  const second=drafts.save(db,context,{payload:{notes:'Second private revision'},baseVersion:'1',generation:first.generation,expectedDraftVersion:first.version});
  assert.throws(()=>drafts.commit(db,context,{private_draft_generation:first.generation,private_draft_version:first.version,notes:'Native old form'},()=>assert.fail('must not write')),/private draft changed/);
  assert.throws(()=>drafts.commit(db,context,{private_draft_generation:second.generation,private_draft_version:second.version,notes:'Invalid native form'},()=>{throw new Error('validation rejected');}),/validation rejected/);
  assert.equal(drafts.get(db,context).draft.payload.notes,'Second private revision');
});

test('earlier assessment drafts are private, previewable and copied only into an empty current context',async()=>{
  const restoreWs=Number(db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Earlier draft fixture','[\"iso27001\"]')").run(user.firm_id).lastInsertRowid);
  const context={workspaceId:restoreWs,actorId:user.id,kind:'assessment',recordId:item,contextKey:'',recordVersion:0};
  const source=drafts.save(db,context,{payload:{notes:'Before-first-pass private canary'},baseVersion:'0',generation:0,expectedDraftVersion:0});
  const pass=Number(db.prepare("INSERT INTO assessment_passes(workspace_id,pass_number,label,status,started_by) VALUES (?,1,'First pass','in_progress',?)").run(restoreWs,user.id).lastInsertRowid);
  const apiPath=`/workspaces/${restoreWs}/form-drafts/assessment/${item}`;
  const current=json(await boot.client.get(apiPath));assert.equal(current.draft,null);assert.equal(current.previousDrafts.length,1);assert.equal(current.previousDrafts[0].contextKey,'');assert.ok(!JSON.stringify(current.previousDrafts).includes('private canary'));
  const preview=json(await boot.client.get(apiPath+'?contextKey='));assert.equal(preview.draft.payload.notes,'Before-first-pass private canary');
  const body={contextKey:String(pass),sourceContextKey:'',sourceDraftId:source.id,sourceGeneration:source.generation,sourceVersion:source.version,generation:0};
  const copied=await boot.client.post(apiPath+'/recover',body,{json:true,csrf:true});assert.equal(copied.status,200,copied.text);assert.equal(json(copied).draft.payload.notes,source.payload.notes);assert.equal(drafts.get(db,context).draft.id,source.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM control_instances WHERE workspace_id=?').get(restoreWs).n,0);
  const overwrite=await boot.client.post(apiPath+'/recover',{...body,generation:json(copied).draft.generation},{json:true,csrf:true});assert.equal(overwrite.status,409);assert.match(overwrite.text,/already exists/);
  const foreignPass=Number(db.prepare("INSERT INTO assessment_passes(workspace_id,pass_number,label,status,started_by) VALUES (?,77,'Foreign pass','completed',?)").run(ws,user.id).lastInsertRowid);
  assert.equal((await boot.client.get(apiPath+'?contextKey='+foreignPass)).status,403);
  assert.equal((await boot.client.post(apiPath+'/recover',{...body,sourceContextKey:String(foreignPass)},{json:true,csrf:true})).status,403);
});
