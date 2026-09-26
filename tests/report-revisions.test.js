'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {bootClient}=require('./helpers');
let boot,db,service,ws,engagement,generator,reviewer,consultant,foreign,manifestId;
const row=id=>db.prepare('SELECT * FROM consulting_report_snapshots WHERE id=?').get(id);
const generate=(body={})=>service.generateReport(db,ws,generator.id,engagement.id,{report_type:'assessment',pass_manifest_id:manifestId,...body});
const transition=(id,action,note='Review rationale',actor=reviewer.id)=>service.transitionReport(db,ws,actor,id,action,note,{status:row(id).status,hash:row(id).snapshot_hash});
test.before(async()=>{
  boot=await bootClient();db=new Database(boot.dbPath);service=require('../lib/consulting-delivery');reviewer=db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  const make=(email,role,firmId=reviewer.firm_id)=>{const id=Number(db.prepare("INSERT INTO users(email,name,password_hash,user_type,firm_id,firm_role,active) VALUES (?,?,?,'firm',?,?,1)").run(email,email,'!',firmId,role).lastInsertRowid);return db.prepare('SELECT * FROM users WHERE id=?').get(id);};
  generator=make('report-generator@example.test','manager');consultant=make('report-consultant@example.test','consultant');
  const foreignFirm=Number(db.prepare("INSERT INTO firms(name) VALUES ('Foreign report firm')").run().lastInsertRowid);foreign=make('report-foreign@example.test','manager',foreignFirm);
  const wsId=Number(db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Report revision fixture','[\"iso27001\"]')").run(reviewer.firm_id).lastInsertRowid);ws=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'consultant')").run(ws.id,consultant.id);
  engagement=service.ensureEngagement(db,ws,generator.id);
  const requirement=db.prepare("SELECT r.* FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' ORDER BY r.id LIMIT 1").get();
  const passId=Number(db.prepare("INSERT INTO assessment_passes(workspace_id,pass_number,label,status,started_by) VALUES (?,1,'Report basis','in_progress',?)").run(ws.id,generator.id).lastInsertRowid);
  db.prepare("INSERT INTO control_state_history(workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,pass_id) VALUES (?,?,?,'Not Implemented','included',0,'Retained report basis',?)").run(ws.id,requirement.ref,generator.id,passId);
  manifestId=service.materializeAssessmentPass(db,ws,db.prepare('SELECT * FROM assessment_passes WHERE id=?').get(passId),reviewer.id).manifestId;
});
test.after(async()=>{db?.close();await boot?.client.close();});
test('independent changes requests preserve exact report bytes and create only the generator notification',async()=>{
  const id=generate(),before=row(id),baseline=db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n;
  assert.throws(()=>transition(id,'request-changes','Self review',generator.id),error=>error.status===403);
  assert.throws(()=>transition(id,'request-changes','Unauthorized reviewer',consultant.id),error=>error.status===403);
  assert.throws(()=>transition(id,'request-changes','Foreign reviewer',foreign.id),error=>error.status===403);
  assert.throws(()=>transition(id,'request-changes',''),error=>error.status===422);
  assert.equal(transition(id,'request-changes','Explain the scope boundary and correct the retained conclusions.'),'superseded');
  assert.equal(row(id).snapshot_json,before.snapshot_json);assert.equal(row(id).snapshot_hash,before.snapshot_hash);
  assert.equal(db.prepare('SELECT manifest_id FROM consulting_report_pass_sources WHERE report_id=?').get(id).manifest_id,manifestId);
  const request=db.prepare('SELECT * FROM consulting_report_revision_requests WHERE report_id=?').get(id);assert.equal(request.requested_by,reviewer.id);assert.equal(request.replacement_report_id,null);
  const event=db.prepare("SELECT id FROM consulting_events WHERE entity_type='report' AND entity_id=? AND action='report_changes_requested'").get(id);
  assert.deepEqual(db.prepare('SELECT recipient_id FROM notification_outbox WHERE event_key=?').all(`consulting_event:${event.id}`).map(r=>r.recipient_id),[generator.id]);assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,baseline+1);
  assert.throws(()=>transition(id,'approve'),error=>error.status===409);assert.throws(()=>transition(id,'request-changes'),error=>error.status===409);
  const page=await boot.client.get(`/workspaces/${ws.id}/delivery/reports/${id}`);assert.equal(page.status,200);assert.match(page.text,/Generate linked replacement/);assert.match(page.text,/scope boundary/);
  assert.throws(()=>db.prepare('UPDATE consulting_report_revision_requests SET request_note=? WHERE id=?').run('Tamper',request.id),/immutable/);
});
test('replacement generation requires an explicit unresolved matching request and keeps the old source intact',async()=>{
  const originalId=generate(),original=row(originalId);transition(originalId,'request-changes','Clarify the title for the client.');
  const other=service.ensureEngagement(db,{...ws,id:Number(db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Other report workspace','[\"iso27001\"]')").run(ws.firm_id).lastInsertRowid)},generator.id);
  assert.throws(()=>generate({replaces_report_id:originalId,report_type:'readiness'}),/unresolved revision/);
  assert.throws(()=>service.generateReport(db,ws,generator.id,other.id,{report_type:'assessment',replaces_report_id:originalId,pass_manifest_id:manifestId}),/not found/);
  const page=await boot.client.get(`/workspaces/${ws.id}/delivery?view=reports&engagement=${engagement.id}&replacesReportId=${originalId}`);assert.equal(page.status,200);assert.match(page.text,/name="replaces_report_id"/);assert.match(page.text,/Clarify the title/);
  const replacementId=generate({replaces_report_id:originalId,title:'Clarified retained report'}),replacement=row(replacementId);
  const request=service.reportRevisionRequest(db,ws,originalId);assert.equal(request.replacement_report_id,replacementId);assert.ok(request.replaced_at);
  assert.equal(replacement.status,'generated');assert.equal(row(originalId).snapshot_json,original.snapshot_json);assert.equal(row(originalId).snapshot_hash,original.snapshot_hash);
  assert.equal(service.reportDetail(db,ws,replacementId).replacesReport.report_id,originalId);assert.equal(db.prepare('SELECT manifest_id FROM consulting_report_pass_sources WHERE report_id=?').get(replacementId).manifest_id,manifestId);
  assert.throws(()=>generate({replaces_report_id:originalId}),/unresolved revision/);
  const detail=await boot.client.get(`/workspaces/${ws.id}/delivery/reports/${replacementId}`);assert.equal(detail.status,200);assert.match(detail.text,/This version replaces/);
  assert.throws(()=>db.prepare('UPDATE consulting_report_revision_requests SET replacement_report_id=NULL,replaced_at=NULL WHERE report_id=?').run(originalId),/replacement/);
});
test('report commands retain rejected rationale and include exact immutable source tokens',async()=>{
  const id=generate();const page=await boot.client.get(`/workspaces/${ws.id}/delivery/reports/${id}`);assert.equal(page.status,200);assert.match(page.text,/Request changes/);assert.match(page.text,/name="expected_snapshot_hash"/);assert.match(page.text,/for="report-decision-note"/);
  const conflict=await boot.client.post(`/workspaces/${ws.id}/delivery/reports/${id}/request-changes`,{note:'Keep this rationale after rejection',expected_status:'approved',expected_snapshot_hash:row(id).snapshot_hash});assert.equal(conflict.status,409);assert.match(conflict.text,/Keep this rationale after rejection/);assert.equal(row(id).status,'generated');
});
test('outbox failures roll back report transitions, revision requests and replacement generations',()=>{
  const id=generate(),before=row(id),eventCount=db.prepare('SELECT COUNT(*) n FROM consulting_events').get().n;
  const fail=()=>db.exec("CREATE TEMP TRIGGER fail_report_outbox BEFORE INSERT ON notification_outbox WHEN NEW.source_type='report' BEGIN SELECT RAISE(ABORT,'Injected report outbox failure'); END");
  fail();assert.throws(()=>transition(id,'approve'),/Injected report outbox failure/);assert.deepEqual(row(id),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM consulting_events').get().n,eventCount);
  assert.throws(()=>transition(id,'request-changes'),/Injected report outbox failure/);assert.equal(service.reportRevisionRequest(db,ws,id),null);assert.deepEqual(row(id),before);db.exec('DROP TRIGGER fail_report_outbox');
  transition(id,'request-changes');const count=db.prepare('SELECT COUNT(*) n FROM consulting_report_snapshots').get().n;fail();assert.throws(()=>generate({replaces_report_id:id}),/Injected report outbox failure/);assert.equal(db.prepare('SELECT COUNT(*) n FROM consulting_report_snapshots').get().n,count);assert.equal(service.reportRevisionRequest(db,ws,id).replacement_report_id,null);db.exec('DROP TRIGGER fail_report_outbox');
});
test('approval and publication notify eligible firm actors without guessing client recipients',()=>{
  const id=generate();transition(id,'approve');const approved=db.prepare("SELECT id FROM consulting_events WHERE entity_type='report' AND entity_id=? AND action='approve'").get(id);
  assert.ok(db.prepare('SELECT 1 FROM notification_outbox WHERE event_key=? AND recipient_id=?').get(`consulting_event:${approved.id}`,generator.id));
  transition(id,'publish');assert.equal(row(id).status,'published');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox o JOIN users u ON u.id=o.recipient_id WHERE o.source_type='report' AND u.user_type!='firm'").get().n,0);
});

test('explicit workspace deletion removes revision and pass history while restoring immutable guards',async()=>{
  const request=db.prepare('SELECT * FROM consulting_report_revision_requests WHERE workspace_id=? LIMIT 1').get(ws.id);assert.ok(request);
  assert.throws(()=>db.prepare('DELETE FROM consulting_report_revision_requests WHERE id=?').run(request.id),/immutable/);
  const beforeTriggers=require('../lib/workspace-deletion').immutableMutationTriggers(db);
  const other=db.prepare('SELECT id FROM workspaces WHERE id<>? ORDER BY id LIMIT 1').get(ws.id);assert.ok(other);
  const response=await boot.client.post(`/workspaces/${ws.id}/delete`,{confirm_name:ws.client_name});assert.equal(response.status,302,response.text);assert.match(response.location,/^\/dashboard\?/);
  assert.equal(db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(ws.id),undefined);assert.ok(db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(other.id));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consulting_report_revision_requests WHERE workspace_id=?').get(ws.id).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assessment_pass_manifest_items WHERE manifest_id=?').get(manifestId).n,0);
  assert.deepEqual(require('../lib/workspace-deletion').immutableMutationTriggers(db),beforeTriggers);assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
