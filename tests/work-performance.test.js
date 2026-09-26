'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const Database=require('better-sqlite3');
const {bootClient,makeClient,authenticate}=require('./helpers');

test('50-client portfolio keeps at least 10000 work items and 50000 evidence records below the local 2s p95 budget',async t=>{
  const boot=await bootClient(),db=new Database(boot.dbPath);
  let renderClient;
  try{
    const actor=db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
    const reqs=db.prepare('SELECT id FROM requirements ORDER BY id LIMIT 50').all();
    const workspaceIds=[];
    const workspaceInsert=db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,?,'[\"iso27001\"]')");
    const taskInsert=db.prepare("INSERT INTO tasks(workspace_id,title,status,assignee_id,due_date,created_by,estimated_minutes) VALUES (?,?,'todo',?,'2026-09-15',?,30)");
    const requestInsert=db.prepare("INSERT INTO client_requests(workspace_id,title,request_type,status,created_by,released_at,due_date,description) VALUES (?,?,'evidence','open',?,'2026-09-01','2026-09-15',?)");
    const evidenceInsert=db.prepare("INSERT INTO evidence(workspace_id,filename,stored_path,uploaded_by,size_bytes) VALUES (?,?,'test-fixture-only',?,1024)");
    const workpaperInsert=db.prepare("INSERT INTO consultant_workpapers(workspace_id,engagement_id,requirement_id,workpaper_ref,title,owner_id,created_by,internal_notes) VALUES (?,?,?,?,?,?,?,?)");
    const historicalNotes='Historical private delivery notes. '.repeat(256);
    db.transaction(()=>{
      for(let w=0;w<50;w++){
        const wsId=Number(workspaceInsert.run(actor.firm_id,`Performance client ${String(w).padStart(2,'0')}`).lastInsertRowid);workspaceIds.push(wsId);
        const ws=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
        const engagement=require('../lib/consulting-delivery').ensureEngagement(db,ws,actor.id);
        for(let i=0;i<100;i++)taskInsert.run(wsId,`Task ${i}`,actor.id,actor.id);
        for(let i=0;i<50;i++)requestInsert.run(wsId,`Evidence request ${i}`,actor.id,historicalNotes);
        for(let i=0;i<50;i++)workpaperInsert.run(wsId,engagement.id,reqs[i].id,`WP-${i}`,`Review workpaper ${i}`,actor.id,actor.id,historicalNotes);
        for(let i=0;i<1000;i++)evidenceInsert.run(wsId,`Evidence ${i}.pdf`,actor.id);
      }
    })();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM evidence').get().n,50000);
    const {listWork}=require('../lib/work-projection');
    const expected=listWork({db,actor,workspaces:workspaceIds,scope:'all',today:'2026-09-05',limit:50}).counts;
    assert.equal(expected.byType.task,5000);assert.equal(expected.byType.client_request,2500);assert.equal(expected.byType.workpaper,2500);
    assert.ok(expected.total>=10000,'native seeded deliverables and gates remain included');
    const sample=[];
    const before=db.prepare('SELECT total_changes() n').get().n;
    for(let i=0;i<20;i++){
      const start=performance.now();
      const result=listWork({db,actor,workspaces:workspaceIds,scope:'all',today:'2026-09-05',limit:50});
      sample.push(performance.now()-start);
      assert.equal(result.counts.total,expected.total);assert.equal(result.items.length,50);
      assert.equal(result.workload.reduce((sum,row)=>sum+row.total,0),expected.total);
    }
    assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
    // Fixture creation and synchronous samples can exceed the warm client's
    // keepalive timeout. A fresh client measures HTTP without a stale socket.
    renderClient=makeClient(boot.app);await authenticate(renderClient,boot.dbPath);
    const render=[];
    for(let i=0;i<20;i++){
      const start=performance.now();const response=await renderClient.get('/work/overview');render.push(performance.now()-start);
      assert.equal(response.status,200);assert.match(response.text,new RegExp(`View all ${expected.total}`));
    }
    const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];
    t.diagnostic(JSON.stringify({fixture:{workspaces:50,workItems:expected.total,evidenceMetadata:50000,task:5000,request:2500,workpaper:2500,privateSourceTextBytes:Buffer.byteLength(historicalNotes)*5000,otherNativeWork:expected.total-10000},samples:20,projectionP95Ms:Math.round(p95(sample)),httpOverviewP95Ms:Math.round(p95(render)),scope:'Local disposable SQLite fixture with populated source notes; no file transfer, large report history or browser paint'}));
    assert.ok(p95(sample)<2000,`projection p95 ${p95(sample).toFixed(1)}ms`);
    assert.ok(p95(render)<2000,`overview HTTP p95 ${p95(render).toFixed(1)}ms`);
  }finally{db.close();await renderClient?.close();await boot.client.close();}
});
