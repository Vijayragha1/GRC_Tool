'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ejs = require('ejs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aims-workspace-outcomes-'));
process.env.DB_PATH = path.join(tmpDir, 'engagement.db');
process.env.ISMS_KEY_FILE = path.join(tmpDir, 'master.key');
const {db, init} = require('../db');
init();
const lifecycle = require('../lib/iso-lifecycle');
const scope = require('../lib/engagement-outcome-scope');
const routes = new Map();
const middleware = (_req, _res, next) => next?.();
require('../routes/workspaces').register({
  get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
  post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
}, {db, requireAuth: middleware, requireWorkspace: middleware, requirePermission: () => middleware, logAction: () => {}});
const user = {...db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get(), user_type:'firm', firm_role:'manager'};
function response() {
  return {statusCode:200, locals:{userPerms: new Set(['workspace.update'])},
    status(code) { this.statusCode=code; return this; },
    render(view, locals) { this.view=view; this.model=locals; return this; },
    redirect(location) { this.statusCode=302; this.location=location; return this; },
    json(body) { this.body=body; return this; }, send(text) { this.text=text; return this; }};
}
function workspace(id) {
  const row=db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  return {...row,frameworks:JSON.parse(row.frameworks)};
}
function call(route, body, ws) {
  const res=response();
  routes.get(`POST ${route}`)({body, workspace:ws, user, params:{wsId:ws?.id}, headers:{}, query:{}},res);
  return res;
}
function create(name, outcome='gap_assessment_only', frameworks=['iso42001']) {
  const result=call('/workspaces',{client_name:name,scope:'AI support service',frameworks,
    engagement_outcome:outcome,target_cert_date:'2028-06-30'});
  assert.equal(result.statusCode,302,JSON.stringify(result.model));
  return workspace(db.prepare('SELECT id FROM workspaces WHERE client_name=?').get(name).id);
}
test.after(()=>{ db.close(); fs.rmSync(tmpDir,{recursive:true,force:true}); });

test('ISO outcome scope handles both management systems and preserves generic programmes',()=>{
  for(const frameworks of [['iso42001'],'["iso42001"]',['iso27001','iso42001']]) {
    const ws={frameworks,engagement_outcome:'gap_assessment_only'};
    assert.equal(scope.workspaceMode(ws),scope.MODE.GAP_ASSESSMENT);
    assert.equal(scope.isPhaseInContract(ws,'stage_1'),false);
    const res=response(); let next=false;
    scope.requirePostGapService()({workspace:ws,path:'/audits'},res,()=>{next=true;});
    assert.equal(res.statusCode,409);assert.equal(next,false);
    assert.doesNotMatch(res.model.message,/ISO 27001/);
  }
  assert.equal(scope.workspaceMode({frameworks:['csf'],engagement_outcome:'gap_assessment_only'}),scope.MODE.GENERIC);
  assert.equal(lifecycle.frameworkLabel({frameworks:'["iso42001"]'}),'ISO 42001');
});

test('ISO 42001 creation requires outcome and seeds only the correct engagement/intake context',()=>{
  const missing=call('/workspaces',{client_name:'Missing AI contract',frameworks:'iso42001'});
  assert.equal(missing.statusCode,400);
  const gap=create('AI gap contract');
  assert.equal(gap.target_cert_date,null);
  const engagement=db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=?').get(gap.id);
  assert.equal(engagement.engagement_type,'gap_assessment');
  assert.equal(engagement.name,'AI gap contract ISO 42001 gap assessment');
  assert.deepEqual(JSON.parse(engagement.framework_scope_json),['iso42001']);
  assert.ok(db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=? AND consulting_engagement_id=?').get(gap.id,engagement.id));
  assert.equal(db.prepare('SELECT count(*) c FROM engagement_intake WHERE workspace_id=?').get(gap.id).c,0);
  const full=create('AI certification contract','certification_support');
  assert.equal(full.target_cert_date,'2028-06-30');
  assert.equal(require('../lib/client-setup').clientSetup(db,full).steps.find(step=>step.key==='iso42001').status,'not_started','a seeded target date does not count as AI scoping');
  assert.equal(db.prepare("SELECT answer FROM iso42001_intake_answers WHERE workspace_id=? AND question_key='target-cert-date'").get(full.id).answer,'2028-06-30');
  assert.equal(db.prepare('SELECT count(*) c FROM engagement_intake WHERE workspace_id=?').get(full.id).c,0);
});

test('ISO 42001 can be enabled later and completed gap history survives confirmed upgrade',()=>{
  const neutral=create('AI added later','certification_support',[]);
  assert.equal(db.prepare('SELECT count(*) c FROM consulting_engagements WHERE workspace_id=?').get(neutral.id).c,0);
  assert.equal(call('/workspaces/:wsId/frameworks',{frameworks:'iso42001'},neutral).statusCode,400);
  assert.equal(call('/workspaces/:wsId/frameworks',{frameworks:'iso42001',engagement_outcome:'gap_assessment_only'},neutral).statusCode,302);
  const gap=workspace(neutral.id);
  const prior=db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=?').get(gap.id);
  assert.equal(prior.engagement_type,'gap_assessment');
  db.prepare("UPDATE consulting_engagements SET status='complete',completed_at=datetime('now') WHERE id=?").run(prior.id);
  const form={client_name:gap.client_name,engagement_outcome:'certification_support',target_cert_date:'2028-10-15'};
  assert.equal(call('/workspaces/:wsId/update',form,gap).statusCode,400);
  assert.equal(call('/workspaces/:wsId/update',{...form,confirm_outcome_upgrade:'1'},gap).statusCode,302);
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(prior.id).status,'complete');
  const active=db.prepare("SELECT * FROM consulting_engagements WHERE workspace_id=? AND status='active'").get(gap.id);
  assert.notEqual(active.id,prior.id);assert.equal(active.engagement_type,'implementation');
  assert.equal(active.name,'AI added later ISO 42001 certification support');
  assert.equal(active.target_date,'2028-10-15');
  assert.equal(db.prepare('SELECT consulting_engagement_id FROM engagement_delivery_plans WHERE workspace_id=?').get(gap.id).consulting_engagement_id,active.id);
  const full=workspace(gap.id);
  assert.equal(call('/workspaces/:wsId/frameworks',{frameworks:'iso42001',engagement_outcome:'gap_assessment_only'},full).statusCode,409);
  assert.equal(call('/workspaces/:wsId/update',{...form,engagement_outcome:'gap_assessment_only'},full).statusCode,409);
  assert.equal(call('/workspaces/:wsId/frameworks',{frameworks:'csf'},full).statusCode,409);
  assert.equal(call('/workspaces/:wsId/frameworks',{frameworks:'iso27001',engagement_outcome:'certification_support'},full).statusCode,409,'switching ISO programmes cannot bypass contracted history');
});

test('workspace settings synchronize framework scope and the visible ISO contract is editable in setup',()=>{
  const ws=create('AI settings contract','certification_support');
  const changed=call('/workspaces/:wsId/update',{client_name:'Renamed AI contract',frameworks_present:'1',frameworks:['iso42001','csf'],engagement_outcome:'certification_support',target_cert_date:'2029-01-31'},ws);
  assert.equal(changed.statusCode,302);
  const engagement=db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=?').get(ws.id);
  assert.equal(engagement.name,'Renamed AI contract ISO 42001 certification support');
  assert.equal(db.prepare('SELECT target_completion_date FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id).target_completion_date, '2029-01-31');
  assert.deepEqual(JSON.parse(engagement.framework_scope_json),['iso42001','csf']);
  const res=response();
  routes.get('GET /workspaces/:wsId/setup')({workspace:workspace(ws.id),user},res);
  assert.equal(res.model.isoContract.label,'ISO 42001');
  assert.equal(res.model.isoContract.outcome,'certification_support');
  assert.equal(res.model.canUpdateWorkspace,true);
});

test('ISO 42001 navigation uses one shared plan and respects the gap-only service boundary',async()=>{
  const render=(outcome,experienceEnabled=false)=>ejs.renderFile(path.join(__dirname,'../views/partials/client_navigation.ejs'),{
    ws:{id:42,frameworks:['iso42001'],engagement_outcome:outcome},user,rbac:{isManager:()=>true},active:'engagement-plan',experienceEnabled});
  for(const experienceEnabled of [false,true]) {
    const gap=await render('gap_assessment_only',experienceEnabled);
    assert.equal((gap.match(/href="\/workspaces\/42\/engagement-plan"/g)||[]).length,1);
    assert.match(gap,/href="\/workspaces\/42\/iso42001\/intake"/);
    assert.match(gap,/href="\/workspaces\/42\/iso42001\/gap-assessment"/);
    assert.doesNotMatch(gap,/href="\/workspaces\/42\/(?:audits|mrms|iso42001\/cert-cycle|iso42001\/requests)"/);
    assert.doesNotMatch(gap,/ISO 27001/);
    const full=await render('certification_support',experienceEnabled);
    assert.match(full,/href="\/workspaces\/42\/iso42001\/cert-cycle"/);
    assert.match(full,/href="\/workspaces\/42\/audits"/);
  }
  const portal=await ejs.renderFile(path.join(__dirname,'../views/partials/client_portal_navigation.ejs'),{ws:{id:42,frameworks:['iso42001'],engagement_outcome:'gap_assessment_only'}});
  assert.match(portal,/Findings &amp; recommendations/);
});

test('ISO 42001 client deliverables remain accessible only within the contracted phase',()=>{
  const ws=create('AI portal outcome contract');
  const clientId=Number(db.prepare(`INSERT INTO users (email,password_hash,name,firm_id,user_type,active)
    VALUES ('aims-outcome-client@example.com','unused','AI client',?,'client',1)`).run(user.firm_id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(ws.id,clientId);
  const rows=db.prepare(`SELECT d.id,p.phase_key FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE d.workspace_id=? ORDER BY d.id`).all(ws.id);
  // A client may still prepare ordinary gap-phase evidence; the controlled
  // report has a distinct publication boundary tested separately below.
  const milestone=db.prepare("SELECT m.id,m.plan_id FROM engagement_delivery_milestones m JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE m.plan_id=(SELECT id FROM engagement_delivery_plans WHERE workspace_id=?) AND p.phase_key='gap_assessment' AND m.milestone_key!='gap-controlled-report' ORDER BY m.id LIMIT 1").get(ws.id);
  const gap={id:Number(db.prepare(`INSERT INTO engagement_delivery_deliverables (workspace_id,plan_id,milestone_id,title)
    VALUES (?,?,?,'Client scoping evidence')`).run(ws.id,milestone.plan_id,milestone.id).lastInsertRowid)};
  const hidden=rows.find(row=>row.phase_key==='stage_1');
  assert.ok(hidden);
  db.prepare('UPDATE engagement_delivery_deliverables SET client_visible=1,owner_id=? WHERE id IN (?,?)').run(clientId,gap.id,hidden.id);
  const portalRoutes=new Map();
  require('../routes/client-portal').register({
    get(route,...handlers){portalRoutes.set(`GET ${route}`,handlers.at(-1));},
    post(route,...handlers){portalRoutes.set(`POST ${route}`,handlers.at(-1));},
  },{db,requireAuth:middleware,requireWorkspace:middleware,requirePermission:()=>middleware,
    logAction:()=>{},upload:{single:()=>middleware},permissionsFor:()=>new Set(['client_portal.view','client_request.respond'])});
  const handler=portalRoutes.get('GET /workspaces/:wsId/client-portal/deliverables/:id(\\d+)');
  const read=id=>{const res=response();handler({workspace:{...ws,role:'client_owner'},user:{id:clientId,user_type:'client'},params:{id},headers:{},query:{}},res);return res;};
  assert.equal(read(gap.id).statusCode,200);
  assert.equal(read(gap.id).view,'client_deliverable_detail');
  assert.equal(read(hidden.id).statusCode,404);
});

test('create and setup forms expose ISO 42001 contract choices without forcing them on non-ISO clients',async()=>{
  const renderCreate=frameworks=>ejs.renderFile(path.join(__dirname,'../views/workspace_new.ejs'),{
    user,ws:null,include:()=>'',form:{frameworks,engagement_outcome:'gap_assessment_only'},
    outcomeOptions:lifecycle.OUTCOME_OPTIONS,frameworkList:require('../lib/frameworks').FRAMEWORK_LIST,
  });
  const ai=await renderCreate(['iso42001']);
  assert.match(ai, /<fieldset id="iso27001-outcome-fieldset" class="col-full"\s+style=/);
  assert.match(ai,/name="engagement_outcome" value="gap_assessment_only" required checked/);
  assert.match(ai,/id="target-cert-date"[^>]*disabled/);
  const nonIso=await renderCreate(['csf']);
  assert.match(nonIso,/<fieldset id="iso27001-outcome-fieldset"[^>]*hidden/);
  assert.doesNotMatch(nonIso,/name="engagement_outcome"[^>]*required/);
  const setup=await ejs.renderFile(path.join(__dirname,'../views/client_setup.ejs'),{
    user,include:()=>'',ws:{id:81,frameworks:['iso42001'],engagement_outcome:'gap_assessment_only'},
    setup:{done:false,total:1,complete:0,outstanding:1,pct:0,steps:[],nextStep:null},
    isoContract:{label:'ISO 42001',outcome:'gap_assessment_only',options:lifecycle.OUTCOME_OPTIONS},
    canUpdateWorkspace:true,canEnableTprm:false,hasTprm:false,
  });
  assert.match(setup,/Contracted ISO 42001 outcome/);
  assert.match(setup,/name="frameworks" value="iso42001"/);
  assert.match(setup,/name="confirm_outcome_upgrade" value="1"/);
  assert.match(setup,/href="\/workspaces\/81\/engagement-plan"/);
  assert.doesNotMatch(setup,/ISO 27001/);
});

test('controlled AIMS reports stay private on detail, download and client policy until current publication',()=>{
  const ws=create('AI unpublished report');
  const clientId=Number(db.prepare(`INSERT INTO users (email,password_hash,name,firm_id,user_type,active)
    VALUES ('aims-report-client@example.com','unused','Report client',?,'client',1)`).run(user.firm_id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(ws.id,clientId);
  const report=db.prepare(`SELECT d.* FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    WHERE d.workspace_id=? AND m.milestone_key='gap-controlled-report'`).get(ws.id);
  assert.ok(report);
  db.prepare('UPDATE engagement_delivery_deliverables SET client_visible=1,owner_id=? WHERE id=?').run(clientId,report.id);
  const file=path.join(tmpDir,'unpublished-report.txt'); fs.writeFileSync(file,'Private draft report');
  const evidenceId=Number(db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,uploaded_by)
    VALUES (?,'Private report.txt','private-report.txt','test-hash',?)`).run(ws.id,user.id).lastInsertRowid);
  db.prepare('INSERT INTO engagement_delivery_evidence (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)').run(ws.id,report.id,evidenceId,user.id);
  const portalRoutes=new Map();
  require('../routes/client-portal').register({
    get(route,...handlers){portalRoutes.set(`GET ${route}`,handlers.at(-1));},
    post(route,...handlers){portalRoutes.set(`POST ${route}`,handlers.at(-1));},
  },{db,requireAuth:middleware,requireWorkspace:middleware,requirePermission:()=>middleware,
    logAction:()=>{},upload:{single:()=>middleware},resolveUploadPath:()=>file,
    permissionsFor:()=>new Set(['client_portal.view','client_request.respond'])});
  const actor={id:clientId,user_type:'client'};
  const request=()=>({workspace:{...ws,role:'client_owner'},user:actor,params:{id:report.id,evidenceId},headers:{},query:{}});
  const detail=()=>{const res=response();portalRoutes.get('GET /workspaces/:wsId/client-portal/deliverables/:id(\\d+)')(request(),res);return res;};
  const download=()=>{const res=response();res.download=(...args)=>{res.downloaded=args;};portalRoutes.get('GET /workspaces/:wsId/client-portal/deliverables/:id/evidence/:evidenceId/download')(request(),res);return res;};
  const policy=()=>require('../lib/client-work-policy').clientWorkPolicy({db,workspace:ws,actor,sourceType:'deliverable',row:{...report,owner_id:clientId,client_visible:1}});
  assert.equal(detail().statusCode,404);assert.equal(download().statusCode,404);assert.equal(policy().visible,false);
  const aims=require('../lib/iso42001-delivery');
  const original=aims.gapContext;
  const baseline=original(db,ws);
  // The adapter owns approval/hash/revision validation. Exercise each consumer
  // against its publication conclusion without inventing a reviewed assessment.
  let reads=0;
  try {
    aims.gapContext=()=>{reads++;return {...baseline,publication:{id:1},report:{id:report.id}};};
    const visible=require('../lib/iso42001-client-publication').createReportVisibility(db,ws);
    assert.equal(visible(report),true);assert.equal(visible(report),true);assert.equal(reads,1,'one context per projection');
    assert.equal(detail().statusCode,200);assert.equal(download().downloaded[0],file);assert.equal(policy().visible,true);
    aims.gapContext=()=>({...baseline,publication:{id:1},report:{id:report.id+1}});
    assert.equal(detail().statusCode,404);assert.equal(download().statusCode,404);assert.equal(policy().visible,false);
    aims.gapContext=()=>({...baseline,publication:null,report:{id:report.id}});
    assert.equal(detail().statusCode,404);assert.equal(download().statusCode,404);assert.equal(policy().visible,false);
  } finally { aims.gapContext=original; }
});
