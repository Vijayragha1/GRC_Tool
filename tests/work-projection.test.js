'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {bootClient}=require('./helpers');
let boot,db,manager,consultant,coordinator,contributor,workspace,other;
const TODAY='2026-09-05';
const project=input=>require('../lib/work-projection').listWork({db,actor:manager,workspaces:[workspace],today:TODAY,...input});

test.before(async()=>{
  boot=await bootClient();db=new Database(boot.dbPath);
  manager=db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  const addUser=(email,type,role)=>{
    const id=Number(db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES (?,'!test',?,?,?,?,1)").run(email,email,manager.firm_id,type,role).lastInsertRowid);
    return db.prepare('SELECT * FROM users WHERE id=?').get(id);
  };
  consultant=addUser('projection-consultant@example.test','firm','consultant');
  coordinator=addUser('projection-coordinator@example.test','client',null);
  contributor=addUser('projection-contributor@example.test','client',null);
  const wsId=Number(db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Projection client','[]')").run(manager.firm_id).lastInsertRowid);
  workspace=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  for(const [user,role]of [[consultant,'consultant'],[coordinator,'client_owner'],[contributor,'contributor']])db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)').run(wsId,user.id,role);
  const firm=Number(db.prepare("INSERT INTO firms(name) VALUES ('Projection other firm')").run().lastInsertRowid);
  other=Number(db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Forbidden client','[]')").run(firm).lastInsertRowid);
});
test.after(async()=>{db?.close();await boot?.client.close();});

test('workspace authorization comes from current database membership, not caller scope or role claims',()=>{
  const {authorizedWorkspaces}=require('../lib/work-projection');
  assert.equal(authorizedWorkspaces(db,manager,[other]).length,0);
  assert.equal(authorizedWorkspaces(db,{...consultant,firm_role:'manager'},[other]).length,0);
  assert.equal(authorizedWorkspaces(db,consultant,[workspace]).length,1);
});

test('programme metadata follows rollout order and does not guess across multiple contracted services',()=>{
  const {PROGRAMMES,programmeFor}=require('../lib/programme-experience');
  assert.deepEqual(Object.keys(PROGRAMMES).filter(key=>key!=='shared'),['iso27001','csf','iso42001','dpdpa','tprm','vciso']);
  assert.equal(programmeFor({frameworks:'[]',tprm_enabled:1}),'tprm');
  assert.equal(programmeFor({frameworks:'[]',vciso_enabled:1}),'vciso');
  assert.equal(programmeFor({frameworks:'[]',tprm_enabled:1,vciso_enabled:1}),'shared');
});

test('client release visibility, assignment, review waiting state and counts share one projection',()=>{
  const request=(title,assignee,released,status='open')=>Number(db.prepare(`INSERT INTO client_requests(workspace_id,request_type,title,created_by,assignee_id,released_at,status,due_date) VALUES (?,'evidence',?,?,?,?,?,'2026-09-01')`).run(workspace.id,title,manager.id,assignee,released,status).lastInsertRowid);
  request('Internal draft',null,null);
  request('Released team request',null,'2026-09-01');
  const assigned=request('Assigned evidence request',contributor.id,'2026-09-01');
  request('Response awaiting firm',contributor.id,'2026-09-01','submitted');
  const c=project({actor:contributor,scope:'client'});
  assert.equal(c.counts.total,2);
  assert.deepEqual(c.items.map(i=>i.title).sort(),['Assigned evidence request','Response awaiting firm']);
  assert.equal(c.counts.waiting,1);assert.equal(c.counts.overdue,2);
  const sponsor=project({actor:coordinator,scope:'client'});
  assert.equal(sponsor.counts.total,3);assert.ok(!sponsor.items.some(i=>i.title==='Internal draft'));
  assert.ok(c.items.find(i=>i.sourceId===assigned).allowedCommands.includes('submitted'));
  assert.ok(c.items.every(i=>!('description'in i)&&!('internal_notes'in i)&&!('snapshot_json'in i)));
  const mine=project({actor:contributor,scope:'mine'});
  assert.equal(mine.counts.total,2,'submitted work remains in the contributor view after ownership moves to the consultant');
  const submitted=mine.items.find(item=>item.title==='Response awaiting firm');
  assert.equal(submitted.ownerId,manager.id);assert.equal(submitted.assignedToActor,false);assert.equal(submitted.participantToActor,true);
});

test('large queues retain all records across pages and aggregate complete workload',()=>{
  const insert=db.prepare("INSERT INTO tasks(workspace_id,title,status,assignee_id,due_date,created_by,estimated_minutes) VALUES (?,?,'todo',?,'2026-09-03',?,30)");
  db.transaction(()=>{for(let i=0;i<205;i++)insert.run(workspace.id,`Pagination task ${String(i).padStart(3,'0')}`,consultant.id,manager.id);})();
  const first=project({filters:{type:'task'},limit:50});
  assert.equal(first.counts.total,205);assert.equal(first.items.length,50);assert.equal(first.nextCursor,'50');
  assert.equal(first.workload[0].total,205);assert.equal(first.workload[0].estimatedMinutes,6150);
  const ids=new Set();let cursor=null;
  do{const page=project({filters:{type:'task'},cursor,limit:50});page.items.forEach(i=>ids.add(i.id));cursor=page.nextCursor;}while(cursor);
  assert.equal(ids.size,205);
  const mine=project({actor:consultant,scope:'mine',filters:{type:'task'}});
  assert.equal(mine.counts.total,205);
  assert.equal(project({scope:'mine',filters:{type:'task'}}).counts.total,0);
});

test('projection and presentation flags perform no source or default-row writes',()=>{
  const before=db.prepare('SELECT total_changes() count').get().count;
  project({scope:'all'});
  require('../lib/experience-flags').experienceFor(db,{actor:manager,workspace});
  assert.equal(db.prepare('SELECT total_changes() count').get().count,before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM experience_rollouts WHERE firm_id=?').get(manager.firm_id).n,0);
});

test('production defaults off, nonproduction defaults on, explicit switch and cohort retain source data',()=>{
  const {experienceFor}=require('../lib/experience-flags');
  const nodeEnv=process.env.NODE_ENV,enabled=process.env.EXPERIENCE_ENABLED;
  try{
    delete process.env.EXPERIENCE_ENABLED;process.env.NODE_ENV='production';
    assert.equal(experienceFor(db,{actor:manager,workspace}).enabled,false);
    process.env.NODE_ENV='test';assert.equal(experienceFor(db,{actor:manager,workspace}).enabled,true);
    process.env.EXPERIENCE_ENABLED='0';assert.equal(experienceFor(db,{actor:manager,workspace}).enabled,false);
    process.env.EXPERIENCE_ENABLED='1';assert.equal(experienceFor(db,{actor:manager,workspace}).enabled,true);
    delete process.env.EXPERIENCE_ENABLED;
    db.prepare("INSERT INTO experience_rollouts(firm_id,enabled,wave,cohort) VALUES (?,1,1,'iso-pilot')").run(manager.firm_id);
    assert.equal(experienceFor(db,{actor:manager,workspace,programme:'iso27001'}).enabled,true);
    assert.equal(experienceFor(db,{actor:manager,workspace,programme:'csf'}).enabled,false);
    db.prepare('INSERT INTO experience_workspace_overrides(workspace_id,enabled) VALUES (?,0)').run(workspace.id);
    assert.equal(experienceFor(db,{actor:manager,workspace}).enabled,false);
  }finally{if(nodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=nodeEnv;if(enabled===undefined)delete process.env.EXPERIENCE_ENABLED;else process.env.EXPERIENCE_ENABLED=enabled;}
});

test('runtime workspace presentation derives programme waves while shared queues retain every obligation',()=>{
  const {experienceFor,presentationProgramme}=require('../lib/experience-flags');
  const savedRollout=db.prepare('SELECT * FROM experience_rollouts WHERE firm_id=?').get(manager.firm_id),savedEnv=process.env.EXPERIENCE_ENABLED;
  const fixtures={};
  for(const code of ['iso27001','csf','iso42001','dpdpa','tprm','vciso','mixed']){
    const frameworks=code==='mixed'?['csf','iso42001']:['tprm','vciso'].includes(code)?[]:[code];
    const id=Number(db.prepare('INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,?,?)').run(manager.firm_id,`Wave fixture ${code}`,JSON.stringify(frameworks)).lastInsertRowid);
    fixtures[code]=db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    if(code==='tprm')db.prepare("INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by) VALUES (?,'managed_lifecycle','active','Contracted wave fixture',?)").run(id,manager.id);
    if(code==='vciso')require('../lib/vciso-service').enableService(db,{workspaceId:id,actorId:manager.id,reason:'Contracted vCISO wave fixture.'});
  }
  db.prepare("INSERT INTO tasks(workspace_id,title,status,created_by) VALUES (?,'Later-wave obligation remains visible','todo',?)").run(fixtures.csf.id,manager.id);
  const handlers=new Map();require('../routes/work').register({get(path,...fns){handlers.set(path,fns.at(-1));}},{db,requireAuth:(_req,_res,next)=>next()});
  const runtimeEnabled=ws=>{const res={locals:{},render(){}};handlers.get('/workspaces/:wsId/work')({user:manager,params:{wsId:ws.id},path:`/workspaces/${ws.id}/work`,query:{}},res);return res.locals.experienceEnabled;};
  try{
    process.env.EXPERIENCE_ENABLED='1';
    for(const [code,wave]of [['iso27001',1],['csf',2],['iso42001',3],['dpdpa',4],['tprm',5],['vciso',6]]){
      assert.equal(presentationProgramme(db,fixtures[code]),code);
      db.prepare('UPDATE experience_rollouts SET enabled=1,wave=? WHERE firm_id=?').run(Math.max(1,wave-1),manager.firm_id);
      assert.equal(runtimeEnabled(fixtures[code]),wave===1,`${code} default runtime must respect its configured cohort wave even with env=1`);
      db.prepare('UPDATE experience_rollouts SET wave=? WHERE firm_id=?').run(wave,manager.firm_id);
      assert.equal(runtimeEnabled(fixtures[code]),true);
    }
    db.prepare('UPDATE experience_rollouts SET wave=1 WHERE firm_id=?').run(manager.firm_id);
    assert.equal(presentationProgramme(db,fixtures.mixed),'shared');assert.equal(runtimeEnabled(fixtures.mixed),true,'mixed programmes use the shared shell without hiding later-wave commitments');
    assert.equal(experienceFor(db,{actor:manager}).enabled,true,'firm shared shell remains available');
    const before=db.prepare('SELECT total_changes() n').get().n;
    assert.equal(runtimeEnabled(fixtures.csf),false);
    assert.equal(project({workspaces:[fixtures.csf],filters:{type:'task'}}).counts.total,1,'presentation flags do not remove authorised commitments');
    assert.equal(db.prepare('SELECT total_changes() n').get().n,before,'default runtime programme detection is read-only');
    db.prepare('DELETE FROM experience_rollouts WHERE firm_id=?').run(manager.firm_id);
    assert.equal(experienceFor(db,{actor:manager,workspace:fixtures.vciso}).enabled,true,'env=1 without a configured cohort enables every wave');
  }finally{
    db.prepare('DELETE FROM experience_rollouts WHERE firm_id=?').run(manager.firm_id);
    if(savedRollout)db.prepare('INSERT INTO experience_rollouts(firm_id,enabled,wave,cohort,updated_at) VALUES (?,?,?,?,?)').run(savedRollout.firm_id,savedRollout.enabled,savedRollout.wave,savedRollout.cohort,savedRollout.updated_at);
    if(savedEnv===undefined)delete process.env.EXPERIENCE_ENABLED;else process.env.EXPERIENCE_ENABLED=savedEnv;
  }
});

test('work pages render queue, full agenda, workload and reports without hidden more labels',async()=>{
  for(const page of ['','/overview','/calendar','/workload','/reports']){
    const response=await boot.client.get(`/workspaces/${workspace.id}/work${page}`);
    assert.equal(response.status,200,`${page}: ${response.text.slice(0,300)}`);
    assert.match(response.text,/work-experience.css/);
    assert.doesNotMatch(response.text,/\+ \d+ more overdue/);
  }
  const foreign=await boot.client.get(`/workspaces/${other}/work`);assert.equal(foreign.status,404);
});

test('deadline, priority, owner and waiting-party filters preserve the queue used by workload drilldowns',()=>{
  db.prepare("INSERT INTO tasks(workspace_id,title,status,assignee_id,due_date,created_by,priority) VALUES (?,'Today critical','todo',?,?,?,'high')").run(workspace.id,consultant.id,TODAY,manager.id);
  const today=project({filters:{type:'task',deadline:'today',priority:'high',owner:String(consultant.id)}});
  assert.equal(today.counts.total,1);assert.equal(today.items[0].title,'Today critical');
  const waiting=project({filters:{waiting:'client'}});
  assert.ok(waiting.counts.total>0);assert.equal(waiting.counts.total,waiting.counts.waiting);
  assert.ok(waiting.items.every(item=>item.waitingOn==='client'));
  const clientWaiting=project({actor:contributor,filters:{waiting:'firm'}});
  assert.equal(clientWaiting.items[0].actionLabel,'View status');
});

test('workpaper reviewer authority, frozen status and independent CSF decisions stay native',async()=>{
  const engagement=require('../lib/consulting-delivery').ensureEngagement(db,workspace,manager.id);
  const requirements=db.prepare('SELECT id FROM requirements ORDER BY id LIMIT 3').all();
  const insert=db.prepare(`INSERT INTO consultant_workpapers(workspace_id,engagement_id,requirement_id,workpaper_ref,title,owner_id,reviewer_id,prepared_by,status,created_by,due_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,'2026-08-01')`);
  insert.run(workspace.id,engagement.id,requirements[0].id,'WP-1','Independent review',consultant.id,manager.id,consultant.id,'manager_review',manager.id);
  insert.run(workspace.id,engagement.id,requirements[1].id,'WP-2','Maker review excluded',manager.id,manager.id,manager.id,'manager_review',manager.id);
  insert.run(workspace.id,engagement.id,requirements[2].id,'WP-3','Frozen archive',consultant.id,manager.id,consultant.id,'frozen',manager.id);
  const review=project({filters:{type:'review',reviewer:'me'}});
  assert.ok(review.items.some(item=>item.title==='Independent review'));
  assert.ok(!review.items.some(item=>item.title==='Maker review excluded'));
  assert.ok(!project({filters:{status:'overdue'}}).items.some(item=>item.title==='Frozen archive'));

  db.prepare('UPDATE workspaces SET frameworks=? WHERE id=?').run('["iso27001","iso42001","csf"]',workspace.id);
  const created=await boot.client.post(`/workspaces/${workspace.id}/csf`,{name:'Projection governed CSF',scope_statement:'Corporate governance and production services with defined boundaries and accountable owners.',period_start:'2026-01-01',period_end:'2026-06-30',target_completion_date:'2026-09-30',assigned_lead_id:String(manager.id)});
  assert.equal(created.status,302,created.text.slice(0,300));
  const csfId=Number(created.location.match(/\/csf\/(\d+)/)[1]);
  const csfRows=db.prepare('SELECT id FROM csf_subcategory_assessments WHERE engagement_id=? ORDER BY id LIMIT 2').all(csfId);
  db.prepare("UPDATE csf_subcategory_assessments SET status='Assessor Complete',policy_scored_by=?,practice_scored_by=? WHERE id=?").run(consultant.id,consultant.id,csfRows[0].id);
  db.prepare("UPDATE csf_subcategory_assessments SET status='Reviewed',policy_scored_by=?,practice_scored_by=?,reviewed_by=? WHERE id=?").run(consultant.id,consultant.id,manager.id,csfRows[1].id);
  const model=require('../lib/csf-policy-practice'),csfEngagement=db.prepare('SELECT * FROM csf_engagements WHERE id=?').get(csfId);
  model.createVersion(db,csfEngagement,manager,'Creator exclusion fixture');
  const report=model.createVersion(db,csfEngagement,consultant,'Independent reviewer fixture');
  const csfWork=project({filters:{programme:'csf',type:'review',reviewer:'me'}});
  assert.ok(csfWork.items.some(item=>item.id===`csf_review:${csfRows[0].id}`));
  assert.ok(!csfWork.items.some(item=>item.id===`csf_review:${csfRows[1].id}`),'the reviewer cannot approve their own conclusion');
  assert.equal(csfWork.items.filter(item=>item.sourceType==='csf_report').length,1,'creator cannot review their own report version');
  db.prepare("INSERT INTO iso42001_assessment_passes(workspace_id,pass_number,name,status,started_by) VALUES (?,1,'Completed fieldwork','completed',?)").run(workspace.id,consultant.id);
  assert.equal(project({filters:{programme:'iso42001',type:'assessment_pass'}}).counts.total,0,'completed fieldwork is not relabeled pending independent approval');
  const before=db.prepare('SELECT total_changes() n').get().n;
  project({scope:'all'});assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});

test('TPRM projection keeps client risk authority separate from firm recommendation and condition ownership',()=>{
  const moduleId=Number(db.prepare("INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by) VALUES (?,'managed_lifecycle','active','Contracted managed TPRM service',?)").run(workspace.id,manager.id).lastInsertRowid);
  const supplierId=Number(db.prepare("INSERT INTO suppliers(workspace_id,name,service_provided,tier,lifecycle_stage) VALUES (?,'Projection provider','Managed hosting','tier_2','active')").run(workspace.id).lastInsertRowid);
  const cycleId=Number(db.prepare("INSERT INTO tprm_assessment_cycles(workspace_id,supplier_id,module_id,cycle_number,cycle_type,status,client_decision_authority_id,started_by) VALUES (?,?,?,1,'onboarding','active',?,?)").run(workspace.id,supplierId,moduleId,coordinator.id,consultant.id).lastInsertRowid);
  const recommendation=Number(db.prepare(`INSERT INTO tprm_recommendations(workspace_id,supplier_id,cycle_id,version,outcome,executive_summary,rationale,residual_risk_score,residual_risk_band,readiness_snapshot_json,artifact_snapshot_json,recommendation_hash,issued_by,issuer_name,quality_reviewed_by,quality_reviewer_name,quality_review_rationale)
    VALUES (?,?,?,1,'recommend_with_conditions','Defined service recommendation','Defined service rationale',38,'moderate','{}','{}',?,?,'Consultant',?,'Manager','Independent quality review completed against the issued evidence set.')`).run(workspace.id,supplierId,cycleId,'a'.repeat(64),consultant.id,manager.id).lastInsertRowid);
  db.prepare(`INSERT INTO tprm_conditions(workspace_id,supplier_id,cycle_id,source_type,recommendation_id,condition_type,title,description,severity,owner_type,owner_user_id,owner_name,due_date,verification_criteria,created_by)
    VALUES (?,?,?,'recommendation',?,'control','Provide MFA evidence','Provide the scoped privileged access configuration evidence','high','client',?,'Client owner','2026-09-30','Approved standard and sampled configuration evidence required',?)`).run(workspace.id,supplierId,cycleId,recommendation,coordinator.id,consultant.id);
  const client=project({actor:coordinator,scope:'client',filters:{programme:'tprm'}});
  assert.equal(client.counts.total,2);
  const decision=client.items.find(item=>item.sourceType==='tprm_decision');
  assert.deepEqual(decision.allowedCommands,['client_decide']);
  assert.equal(decision.href,`/workspaces/${workspace.id}/client-portal/tprm/${supplierId}`);
  const condition=client.items.find(item=>item.sourceType==='tprm_condition');
  assert.equal(condition.actionState,'action_required');assert.deepEqual(condition.allowedCommands,['submit_condition_evidence']);
  const firm=project({filters:{programme:'tprm'}});
  assert.ok(!firm.items.some(item=>item.allowedCommands.includes('client_decide')));
  assert.equal(firm.items.find(item=>item.sourceType==='tprm_cycle').waitingOn,'client');
  assert.equal(project({actor:contributor,scope:'client',filters:{programme:'tprm'}}).counts.total,0);
});

test('blocked prerequisites are distinct from waiting and completion, and client queue routes retain their portal namespace',()=>{
  const engagement=db.prepare('SELECT id FROM consulting_engagements WHERE workspace_id=? ORDER BY id LIMIT 1').get(workspace.id);
  const requirement=db.prepare('SELECT id FROM requirements ORDER BY id LIMIT 1 OFFSET 4').get();
  db.prepare("INSERT INTO consultant_workpapers(workspace_id,engagement_id,requirement_id,workpaper_ref,title,owner_id,status,created_by) VALUES (?,?,?,'WP-BLOCKED','Missing independent reviewer',?,'manager_review',?)").run(workspace.id,engagement.id,requirement.id,consultant.id,manager.id);
  const result=project({filters:{status:'blocked'}});
  assert.ok(result.items.some(item=>item.title==='Missing independent reviewer'));
  assert.equal(result.counts.blocked,result.counts.total);assert.equal(result.counts.complete,0);assert.equal(result.counts.waiting,0);assert.equal(result.nextAction,null);
  const all=project({filters:{status:'all'}}).counts;
  assert.equal(all.total,all.actionRequired+all.waiting+all.blocked+all.complete);
  const handlers=new Map();require('../routes/work').register({get(path,...fns){handlers.set(path,fns.at(-1));}},{db,requireAuth:(_req,_res,next)=>next()});
  for(const [suffix,view]of [['','actions'],['/overview','home'],['/reports','reports']]){
    let location;handlers.get(`/workspaces/:wsId/work${suffix}`)({user:contributor,params:{wsId:workspace.id},query:{}},{redirect(url){location=url;}});
    assert.equal(location,`/workspaces/${workspace.id}/client-portal?view=${view}`);
  }
  let status;handlers.get('/workspaces/:wsId/work')({user:contributor,params:{wsId:other},query:{}},{status(value){status=value;return this;},render(){}});assert.equal(status,404);
});

test('inactive and removed owners remain identifiable exceptions without changing historical completion',()=>{
  const insertUser=db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES (?,'!test',?,?,'firm','consultant',?)");
  const inactive=Number(insertUser.run('inactive-work@example.test','Inactive owner',manager.firm_id,0).lastInsertRowid);
  const removed=Number(insertUser.run('removed-work@example.test','Removed owner',manager.firm_id,1).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')").run(workspace.id,inactive);
  const task=db.prepare('INSERT INTO tasks(workspace_id,title,status,assignee_id,created_by) VALUES (?,?,?,?,?)');
  task.run(workspace.id,'Assignment fixture inactive','todo',inactive,manager.id);task.run(workspace.id,'Assignment fixture removed','todo',removed,manager.id);task.run(workspace.id,'Assignment fixture complete','done',inactive,manager.id);
  const before=db.prepare('SELECT total_changes() n').get().n;
  const result=project({filters:{q:'Assignment fixture',owner:'unassigned'}});
  assert.equal(result.counts.total,2);assert.equal(result.counts.unassigned,2);assert.equal(result.counts.blocked,2);
  assert.ok(result.items.every(item=>item.ownerUnavailable&&[inactive,removed].includes(item.ownerId)));
  assert.equal(result.workload[0].ownerId,null);assert.equal(result.workload[0].total,2);
  const history=project({filters:{q:'Assignment fixture complete',status:'all'}}).items[0];assert.equal(history.actionState,'complete');assert.equal(history.ownerId,inactive);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});

test('workspace role elevation and overrides use the same permission scope as native routes',()=>{
  const {authorizedWorkspaces,workspacePermissions}=require('../lib/work-projection'),rbac=require('../lib/rbac');
  db.prepare("UPDATE workspace_members SET role='senior_consultant' WHERE workspace_id=? AND user_id=?").run(workspace.id,consultant.id);
  try{
    const ws=authorizedWorkspaces(db,consultant,[workspace])[0];
    assert.equal(rbac.hasPermission(workspacePermissions(db,ws,consultant),'document.review'),true);
    db.prepare("INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted) VALUES (?,?,'document.review',0)").run(workspace.id,consultant.id);
    assert.equal(rbac.hasPermission(workspacePermissions(db,ws,consultant),'document.review'),false);
  }finally{
    db.prepare("DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=? AND permission='document.review'").run(workspace.id,consultant.id);
    db.prepare("UPDATE workspace_members SET role='consultant' WHERE workspace_id=? AND user_id=?").run(workspace.id,consultant.id);
  }
});

test('report changes create generator work until a replacement is linked, without exposing review notes or changing snapshots',()=>{
  const engagement=db.prepare('SELECT id FROM consulting_engagements WHERE workspace_id=? ORDER BY id LIMIT 1').get(workspace.id);
  const add=db.prepare("INSERT INTO consulting_report_snapshots(workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,generated_by) VALUES (?,?,'assessment','Revision projection fixture',?,?,?, ?,?)");
  const originalHash=require('node:crypto').createHash('sha256').update('{"immutable":"original"}').digest('hex');
  const original=Number(add.run(workspace.id,engagement.id,1,'superseded','{"immutable":"original"}',originalHash,consultant.id).lastInsertRowid);
  const revision=Number(db.prepare('INSERT INTO consulting_report_revision_requests(workspace_id,report_id,requested_by,request_note) VALUES (?,?,?,?)').run(workspace.id,original,manager.id,'Private detailed reviewer feedback').lastInsertRowid);
  const before=db.prepare('SELECT total_changes() n').get().n;
  const result=project({actor:consultant,scope:'mine',filters:{type:'report_revision'}});
  assert.equal(result.counts.total,1);assert.equal(result.counts.actionRequired,1);
  const item=result.items[0];assert.equal(item.sourceId,revision);assert.equal(item.ownerId,consultant.id);
  assert.equal(item.href,`/workspaces/${workspace.id}/delivery/reports/${original}`);
  assert.deepEqual(item.allowedCommands,['generate_replacement']);assert.equal(item.review,false);
  assert.ok(!JSON.stringify(result).includes('Private detailed reviewer feedback'));
  assert.equal(project({actor:contributor,scope:'client',filters:{type:'report_revision'}}).counts.total,0);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before,'projection cannot rewrite the immutable source or review request');
  const replacement=Number(add.run(workspace.id,engagement.id,2,'generated','{"immutable":"replacement"}','b'.repeat(64),consultant.id).lastInsertRowid);
  db.prepare('UPDATE consulting_report_revision_requests SET replacement_report_id=?,replaced_at=CURRENT_TIMESTAMP WHERE id=?').run(replacement,revision);
  assert.equal(project({actor:consultant,scope:'mine',filters:{type:'report_revision'}}).counts.total,0);
  assert.deepEqual(db.prepare('SELECT snapshot_json,snapshot_hash,status FROM consulting_report_snapshots WHERE id=?').get(original),{snapshot_json:'{"immutable":"original"}',snapshot_hash:originalHash,status:'superseded'});
});
