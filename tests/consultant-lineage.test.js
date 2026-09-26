'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {bootApp}=require('./helpers');

test('assessment completions retain exact pass versions without overwriting manual work or issued reports',async t=>{
  const env=bootApp(),db=new Database(env.dbPath);
  t.after(()=>db.close());
  const service=require('../lib/consulting-delivery'),drafts=require('../lib/form-drafts');
  const actor=db.prepare("SELECT * FROM users WHERE user_type='firm' ORDER BY id LIMIT 1").get();
  const makeUser=(email,role)=>Number(db.prepare(`INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES (?,?,?,?,'firm',?,1)`).run(email,actor.password_hash,email,actor.firm_id,role).lastInsertRowid);
  const reviewerId=makeUser('lineage-reviewer@example.com','manager'),juniorId=makeUser('lineage-junior@example.com','consultant');
  const reviewer=db.prepare('SELECT * FROM users WHERE id=?').get(reviewerId);
  const wsId=Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks,engagement_outcome,lead_consultant_id)
    VALUES (?,'Lineage Client','["iso27001"]','gap_assessment_only',?)`).run(actor.firm_id,actor.id).lastInsertRowid);
  const ws=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId),engagement=service.ensureEngagement(db,ws,actor.id);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')").run(wsId,juniorId);
  const requirements=db.prepare(`SELECT r.* FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code='iso27001' ORDER BY r.sort_order,r.id LIMIT 3`).all();
  const draftBody={requirement_id:String(requirements[0].id),title:'Manual interview work in progress',owner_id:String(actor.id),reviewer_id:String(reviewerId),internal_notes:'Private manual notes remain untouched'};
  const manualId=service.saveWorkpaper(db,ws,engagement,actor.id,draftBody,null);
  const manualBefore=db.prepare('SELECT * FROM consultant_workpapers WHERE id=?').get(manualId);
  const context={workspaceId:wsId,actorId:actor.id,kind:'workpaper',recordId:String(manualId),contextKey:'',recordVersion:manualBefore.row_version};
  drafts.save(db,context,{generation:0,expectedDraftVersion:0,baseVersion:manualBefore.row_version,payload:{...draftBody,title:'Unsaved personal interview draft'},clientSaveId:'personal-before-pass'});
  const personalBefore=drafts.get(db,context);
  const addPass=number=>Number(db.prepare(`INSERT INTO assessment_passes(workspace_id,pass_number,label,status,started_by)
    VALUES (?,?,?,'in_progress',?)`).run(wsId,number,`Pass ${number}`,actor.id).lastInsertRowid);
  const history=(passId,requirement,status,notes,answers='{"q_1":"retained diagnostic"}')=>Number(db.prepare(`INSERT INTO control_state_history
    (workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,assessment_answers,pass_id)
    VALUES (?,?,?,?,'included',0,?,?,?)`).run(wsId,requirement.ref,actor.id,status,notes,answers,passId).lastInsertRowid);
  const pass=id=>db.prepare('SELECT * FROM assessment_passes WHERE id=?').get(id);
  const manifest=id=>db.prepare('SELECT * FROM assessment_pass_manifests WHERE id=?').get(id);
  const report=id=>db.prepare('SELECT * FROM consulting_report_snapshots WHERE id=?').get(id);
  const items=id=>db.prepare('SELECT * FROM assessment_pass_manifest_items WHERE manifest_id=? ORDER BY requirement_id').all(id);
  const pass1Id=addPass(1),history1=history(pass1Id,requirements[0],'Not Implemented','First pass documented gap.');
  const inheritedHistory=history(pass1Id,requirements[1],'Partially Implemented','Retained initial partial conclusion.');
  const initial=service.materializeAssessmentPass(db,ws,pass(pass1Id),reviewerId);
  db.prepare("UPDATE assessment_passes SET status='completed',completed_by=? WHERE id=?").run(reviewerId,pass1Id);
  const firstItems=items(initial.manifestId),initialManifest=manifest(initial.manifestId);
  const report1Id=service.generateReport(db,ws,actor.id,engagement.id,{report_type:'assessment',pass_manifest_id:initial.manifestId});
  const report1=report(report1Id);

  await t.test('first completion links exact history and retains manual row and personal draft',()=>{
    assert.equal(initial.frozen,2);
    assert.equal(initial.created,1);
    assert.deepEqual(db.prepare('SELECT * FROM consultant_workpapers WHERE id=?').get(manualId),manualBefore);
    assert.deepEqual(drafts.get(db,context),personalBefore);
    assert.equal(firstItems[0].source_history_id,history1);
    assert.equal(firstItems[0].workpaper_id,manualId);
    const snap=service.snapshotDetail(db,ws,manualId,firstItems[0].snapshot_id);
    assert.equal(snap.snapshot.workpaper.implementation_conclusion,'not_implemented');
    assert.equal(snap.snapshot.workpaper.assessment_answers,'{"q_1":"retained diagnostic"}');
    assert.doesNotMatch(snap.snapshot_json,/Private manual notes|Unsaved personal/);
    assert.equal(snap.snapshot.reviews[0].actor_id,reviewerId);
  });

  const pass2Id=addPass(2),history2=history(pass2Id,requirements[0],'Implemented','Second pass independently reviewed improvement.');
  const second=service.materializeAssessmentPass(db,ws,pass(pass2Id),reviewerId);
  db.prepare("UPDATE assessment_passes SET status='completed',completed_by=? WHERE id=?").run(reviewerId,pass2Id);
  const secondItems=items(second.manifestId);
  const report2Id=service.generateReport(db,ws,actor.id,engagement.id,{report_type:'assessment',pass_manifest_id:second.manifestId});

  await t.test('pass 2 appends versions including previously frozen rows and labels inherited sources',()=>{
    assert.equal(second.created,0);
    assert.equal(second.frozen,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM consultant_workpapers WHERE engagement_id=?').get(engagement.id).n,2);
    assert.deepEqual(db.prepare('SELECT * FROM consultant_workpapers WHERE id=?').get(manualId),manualBefore);
    assert.deepEqual(drafts.get(db,context),personalBefore);
    assert.equal(secondItems[0].source_history_id,history2);
    assert.equal(secondItems[1].source_history_id,inheritedHistory);
    assert.equal(secondItems[1].source_pass_id,pass1Id);
    assert.equal(secondItems[1].inherited,1);
    assert.notEqual(firstItems[1].snapshot_id,secondItems[1].snapshot_id,'an existing frozen workpaper still receives a new pass snapshot');
    assert.equal(service.snapshotDetail(db,ws,manualId,secondItems[0].snapshot_id).version_number,2);
    assert.deepEqual(report(report1Id),report1,'issued report bytes and metadata remain unchanged');
    assert.equal(JSON.parse(report(report2Id).snapshot_json).workpapers[0].implementation_conclusion,'implemented');
    assert.equal(JSON.parse(report1.snapshot_json).workpapers[0].implementation_conclusion,'not_implemented');
  });

  await t.test('reports require a selected manifest and use retained scope and findings after later edits',()=>{
    assert.throws(()=>service.generateReport(db,ws,actor.id,engagement.id,{report_type:'assessment'}),/Choose the completed assessment pass/);
    assert.throws(()=>service.generateReport(db,ws,actor.id,engagement.id,{report_type:'readiness',pass_manifest_id:'invalid'}),/Choose the completed assessment pass/);
    db.prepare('UPDATE consulting_engagements SET scope_statement=? WHERE id=?').run('Later scope must not leak into prior pass report',engagement.id);
    const repeatedId=service.generateReport(db,ws,actor.id,engagement.id,{report_type:'assessment',pass_manifest_id:initial.manifestId});
    const repeated=JSON.parse(report(repeatedId).snapshot_json),original=JSON.parse(report1.snapshot_json);
    assert.deepEqual(repeated.workpapers,original.workpapers);
    assert.deepEqual(repeated.engagement,original.engagement);
    assert.deepEqual(repeated.findings,original.findings);
    assert.equal(db.prepare('SELECT manifest_id FROM consulting_report_pass_sources WHERE report_id=?').get(repeatedId).manifest_id,initial.manifestId);
  });

  await t.test('reopening a completed pass creates a linked completion generation',()=>{
    db.prepare("UPDATE assessment_passes SET status='in_progress' WHERE id=?").run(pass2Id);
    history(pass2Id,requirements[0],'Partially Implemented','Reopened pass correction.');
    const corrected=service.materializeAssessmentPass(db,ws,pass(pass2Id),reviewerId);
    const retained=manifest(corrected.manifestId);
    assert.equal(retained.completion_generation,2);
    assert.equal(retained.supersedes_manifest_id,second.manifestId);
    assert.equal(JSON.parse(report(report2Id).snapshot_json).workpapers[0].implementation_conclusion,'implemented');
    assert.deepEqual(manifest(initial.manifestId),initialManifest);
    assert.deepEqual(drafts.get(db,context),personalBefore);
  });

  await t.test('manifest identities and report sources reject mutation and cross-workspace access',()=>{
    assert.throws(()=>db.prepare('UPDATE assessment_pass_manifests SET manifest_json=? WHERE id=?').run('{}',initial.manifestId),/immutable/);
    assert.throws(()=>db.prepare('DELETE FROM assessment_pass_manifest_items WHERE manifest_id=?').run(initial.manifestId),/immutable/);
    assert.throws(()=>db.prepare('UPDATE consulting_report_pass_sources SET manifest_id=? WHERE report_id=?').run(second.manifestId,report1Id),/immutable/);
    assert.throws(()=>service.snapshotDetail(db,{...ws,id:9999},manualId,firstItems[0].snapshot_id),/not found/);
    assert.throws(()=>service.generateReport(db,{...ws,id:9999},actor.id,engagement.id,{pass_manifest_id:initial.manifestId}),error=>error.status===403);
  });

  await t.test('independent reviewer selection excludes ordinary consultants and self-review',()=>{
    const ids=service.eligibleReviewers(db,ws,[actor.id]).map(u=>u.id);
    assert.ok(ids.includes(reviewerId));assert.ok(!ids.includes(actor.id));assert.ok(!ids.includes(juniorId));
    assert.throws(()=>service.saveWorkpaper(db,ws,engagement,actor.id,{...draftBody,reviewer_id:String(juniorId),row_version:manualBefore.row_version},manualId),/eligible independent/);
    assert.throws(()=>service.materializeAssessmentPass(db,ws,pass(pass2Id),actor.id),/independent reviewer/);
    assert.throws(()=>service.transitionWorkpaper(db,ws,reviewer,manualId,'submit','Stale command',manualBefore.row_version-1),error=>error.status===409);
    assert.deepEqual(db.prepare('SELECT * FROM consultant_workpapers WHERE id=?').get(manualId),manualBefore);
  });

  await t.test('reviewer and owner choices require current workspace access and honor elevated membership roles',()=>{
    const outsider=makeUser('lineage-memberless-reviewer@example.com','consultant');
    db.prepare("INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted,granted_by) VALUES (?,?,'document.review',1,?)").run(ws.id,outsider,actor.id);
    assert.equal(service.workspaceUser(db,ws,outsider),null);assert.ok(!service.eligibleReviewers(db,ws).some(u=>u.id===outsider));assert.ok(!service.getCockpit(db,ws,actor.id,engagement.id).users.some(u=>u.id===outsider));
    db.prepare("DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=? AND permission='document.review'").run(ws.id,outsider);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'manager')").run(ws.id,outsider);
    assert.equal(service.workspaceUser(db,ws,outsider).role,'manager');assert.ok(service.eligibleReviewers(db,ws).some(u=>u.id===outsider));
    assert.equal(service.workspaceUser(db,ws,outsider).can_prepare,true);
    db.prepare("UPDATE workspace_members SET role='consultant' WHERE workspace_id=? AND user_id=?").run(ws.id,outsider);
    db.prepare("INSERT INTO workspace_role_overrides(workspace_id,user_id,permission,granted,granted_by) VALUES (?,?,'control.update',0,?)").run(ws.id,outsider,actor.id);
    assert.equal(service.workspaceUser(db,ws,outsider).can_prepare,false);
    assert.equal(service.getCockpit(db,ws,actor.id,engagement.id).users.find(u=>u.id===outsider).can_prepare,false);
    assert.throws(()=>service.saveWorkpaper(db,ws,engagement,actor.id,{...draftBody,owner_id:String(outsider),row_version:manualBefore.row_version},manualId),/assessment-edit access/);
    db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(ws.id,outsider);
    assert.equal(service.workspaceUser(db,ws,outsider),null);assert.ok(!service.eligibleReviewers(db,ws).some(u=>u.id===outsider));assert.ok(!service.getCockpit(db,ws,actor.id,engagement.id).users.some(u=>u.id===outsider));
  });

  await t.test('engagement roster follows authoritative ownership without losing unchanged planned effort',()=>{
    db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team(engagement_id,user_id,role,planned_hours,assigned_by) VALUES (?,?,'consultant',12,?)`).run(engagement.id,juniorId,actor.id);
    db.prepare(`UPDATE consulting_engagement_team SET planned_hours=8 WHERE engagement_id=? AND user_id=? AND role='quality_reviewer'`).run(engagement.id,reviewerId);
    const current=db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagement.id);
    service.syncEngagementRoster(db,ws,current,actor.id);
    assert.equal(db.prepare(`SELECT planned_hours FROM consulting_engagement_team WHERE engagement_id=? AND user_id=? AND role='quality_reviewer'`).get(engagement.id,reviewerId).planned_hours,8);
    service.syncEngagementRoster(db,ws,{...current,lead_consultant_id:juniorId},actor.id);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM consulting_engagement_team WHERE engagement_id=? AND role='engagement_lead'`).get(engagement.id).n,1);
    assert.equal(db.prepare(`SELECT user_id FROM consulting_engagement_team WHERE engagement_id=? AND role='engagement_lead'`).get(engagement.id).user_id,juniorId);
    assert.ok(db.prepare(`SELECT 1 FROM consulting_engagement_team WHERE engagement_id=? AND user_id=? AND role='consultant'`).get(engagement.id,juniorId));
  });

  await t.test('coverage counts unique in-scope requirements, not repeated pass snapshots',()=>{
    const cockpit=service.getCockpit(db,ws,actor.id,engagement.id);
    assert.equal(cockpit.metrics.coverage,Math.round(2/cockpit.requirements.length*100));
    assert.ok(cockpit.metrics.coverage<=100);
    assert.equal(cockpit.manifests.length,3);
  });
});

test('commercial forecasts require remaining cost estimates and aggregate by currency',()=>{
  const service=require('../lib/consulting-delivery');
  const unknown=service.commercialProjection({currency:'USD',contract_value_minor:100000,actual_hours:10,internal_cost_rate_minor:1000,estimated_remaining_cost_minor:null});
  assert.equal(unknown.margin_after_recorded_cost_minor,90000);
  assert.equal(unknown.forecast_margin_minor,null);
  const usd=service.commercialProjection({...unknown,estimated_remaining_cost_minor:20000});
  const inr=service.commercialProjection({...unknown,currency:'INR',estimated_remaining_cost_minor:30000});
  assert.equal(usd.forecast_margin_minor,70000);
  const totals=service.portfolioTotals([usd,inr]);
  assert.deepEqual(totals.currencies.map(c=>[c.currency,c.contract,c.margin]),[['INR',100000,60000],['USD',100000,70000]]);
  assert.equal(totals.contract,undefined,'there is no fictitious mixed-currency total');
  assert.equal(service.portfolioTotals([usd,unknown]).currencies[0].forecast_missing,1);
});
