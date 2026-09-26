'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const bcrypt=require('bcrypt');
const Database=require('better-sqlite3');
const { bootClient,makeClient }=require('./helpers');

let env,client,reviewerClient,db,wsId,otherWsId,managerId,reviewerId,clientId,requirementId,engagementId,workpaperId,evidenceId,findingId,reportId;

async function loginAs(http,email,password){
  const page=await http.get('/login');
  const token=(page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/)||[])[1];
  const response=await http.post('/login',{email,password,_csrf:token},{csrf:false});
  assert.ok(response.status>=300&&response.status<400);
  const home=await http.get('/dashboard');
  if(home.status===302) await http.get(home.location);
}

test.before(async()=>{
  env=await bootClient();client=env.client;db=new Database(env.dbPath);
  const app=env.app,firmId=db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  managerId=db.prepare("SELECT id FROM users WHERE email='sec-test@example.com'").get().id;
  const reviewerPassword='reviewer-password-1234';
  reviewerId=Number(db.prepare(`INSERT INTO users (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('reviewer@example.com',?,'Quality Reviewer',?,'firm','manager',1)`).run(bcrypt.hashSync(reviewerPassword,4),firmId).lastInsertRowid);
  clientId=Number(db.prepare(`INSERT INTO users (email,password_hash,name,firm_id,user_type,firm_role,active)
    VALUES ('client.validator@example.com',?,'Client Validator',?,'client',NULL,1)`).run(bcrypt.hashSync('client-password-1234',4),firmId).lastInsertRowid);
  wsId=Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,stage,frameworks,target_cert_date,lead_consultant_id,created_at)
    VALUES (?,'Consulting OS Client','gap_assessment','["iso27001"]','2027-12-31',?,'2026-01-01')`).run(firmId,managerId).lastInsertRowid);
  otherWsId=Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,stage,frameworks)
    VALUES (?,'Other Tenant Client','new','["iso27001"]')`).run(firmId).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'contributor')`).run(wsId,clientId);
  requirementId=db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' ORDER BY r.sort_order LIMIT 1`).get().id;
  reviewerClient=makeClient(app);await loginAs(reviewerClient,'reviewer@example.com',reviewerPassword);
});

test.after(async()=>{if(db)db.close();if(client)await client.close();if(reviewerClient)await reviewerClient.close();});

test('delivery cockpit stays read-only until its explicit start creates the engagement',async()=>{
  const empty=await client.get(`/workspaces/${wsId}/delivery`);assert.equal(empty.status,200);assert.match(empty.text,/Start delivery engagement/);assert.equal(db.prepare('SELECT COUNT(*) n FROM consulting_engagements WHERE workspace_id=?').get(wsId).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM engagement_delivery_plans WHERE workspace_id=?').get(wsId).n,0);
  const started=await client.post(`/workspaces/${wsId}/delivery/start`,{});assert.equal(started.status,302);
  const page=await client.get(`/workspaces/${wsId}/delivery`);
  assert.equal(page.status,200);assert.match(page.text,/Consultant delivery operating system/);assert.match(page.text,/four-layer|professional work/i);
  assert.match(page.text,/Contracted service path/);assert.match(page.text,/Full certification support/);
  const engagement=db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=?').get(wsId);assert.ok(engagement);engagementId=engagement.id;
  assert.equal(engagement.engagement_type,'implementation');
  assert.deepEqual(JSON.parse(engagement.framework_scope_json),['iso27001']);
  const method=db.prepare(`SELECT m.*,v.snapshot_hash FROM firm_methodologies m JOIN firm_methodology_versions v ON v.methodology_id=m.id WHERE m.firm_id=?`).get(db.prepare('SELECT firm_id FROM workspaces WHERE id=?').get(wsId).firm_id);
  assert.equal(method.snapshot_hash.length,64);
  assert.equal(db.prepare('SELECT consulting_engagement_id FROM engagement_delivery_plans WHERE workspace_id=?').get(wsId).consulting_engagement_id,engagementId);
});

test('certification-support engagement cannot close before the adaptive delivery plan and Stage 2 remediation are complete',async()=>{
  const engagement=db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagementId);
  const response=await client.post(`/workspaces/${wsId}/delivery/engagements/${engagementId}`,{
    row_version:String(engagement.row_version),name:engagement.name,status:'complete'
  });
  assert.equal(response.status,302);assert.match(response.location,/toastKind=error/);
  assert.match(decodeURIComponent(response.location),/certification-support delivery plan is not complete/i);
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status,'active');
});

test('deliberately reopening full certification support clears stale completion and reopens its plan',async()=>{
  const plan=db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(wsId);
  db.prepare(`UPDATE consulting_engagements SET status='complete',completed_at=datetime('now'),row_version=row_version+1 WHERE id=?`).run(engagementId);
  db.prepare(`UPDATE engagement_delivery_plans SET status='completed',consulting_engagement_id=? WHERE id=?`).run(engagementId,plan.id);
  const completed=db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagementId);
  const response=await client.post(`/workspaces/${wsId}/delivery/engagements/${engagementId}`,{
    row_version:String(completed.row_version),name:completed.name,status:'active'
  });
  assert.equal(response.status,302);assert.doesNotMatch(response.location,/toastKind=error/);
  const reopened=db.prepare('SELECT status,completed_at FROM consulting_engagements WHERE id=?').get(engagementId);
  assert.equal(reopened.status,'active');assert.equal(reopened.completed_at,null);
  assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(plan.id).status,'active');
  assert.ok(db.prepare(`SELECT 1 FROM engagement_delivery_events
    WHERE plan_id=? AND action='reopened_with_consulting_engagement'`).get(plan.id));
});

test('gap-only cockpit shows the report endpoint and rejects certification-only engagement types',async()=>{
  const firmId=db.prepare('SELECT firm_id FROM workspaces WHERE id=?').get(wsId).firm_id;
  const gapWorkspaceId=Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,stage,frameworks,engagement_outcome,lead_consultant_id,created_at)
    VALUES (?,'Report Only Client','gap_assessment','["iso27001"]','gap_assessment_only',?,'2026-08-20')`).run(firmId,managerId).lastInsertRowid);
  await client.post(`/workspaces/${gapWorkspaceId}/delivery/start`,{});
  const page=await client.get(`/workspaces/${gapWorkspaceId}/delivery`);
  assert.equal(page.status,200);assert.match(page.text,/Contracted service path/);assert.match(page.text,/Gap assessment only/);
  assert.match(page.text,/Contract endpoint: independently approved and published gap-assessment report/);
  assert.match(page.text,/Implementation, readiness, internal audit and surveillance engagements are locked/);
  assert.doesNotMatch(page.text,/<option value="implementation">/);
  assert.doesNotMatch(page.text,/<option value="readiness">/);
  assert.doesNotMatch(page.text,/<option value="internal_audit">/);
  assert.doesNotMatch(page.text,/<option value="surveillance">/);
  const seeded=db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=? ORDER BY id LIMIT 1').get(gapWorkspaceId);
  assert.equal(seeded.engagement_type,'gap_assessment');

  db.prepare(`UPDATE consulting_engagements SET status='complete',completed_at=datetime('now'),row_version=row_version+1 WHERE id=?`).run(seeded.id);
  const closedGap=db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(seeded.id);
  const blockedReopen=await client.post(`/workspaces/${gapWorkspaceId}/delivery/engagements/${seeded.id}`,{
    row_version:String(closedGap.row_version),name:closedGap.name,status:'active'
  });
  assert.equal(blockedReopen.status,302);assert.match(blockedReopen.location,/toastKind=error/);
  assert.match(decodeURIComponent(blockedReopen.location),/formally closed at the controlled report/i);
  const retainedGap=db.prepare('SELECT status,completed_at FROM consulting_engagements WHERE id=?').get(seeded.id);
  assert.equal(retainedGap.status,'complete');assert.ok(retainedGap.completed_at);
  const blockedClosedEdit=await client.post(`/workspaces/${gapWorkspaceId}/delivery/engagements/${seeded.id}`,{
    row_version:String(closedGap.row_version),name:'Rewritten closed engagement',scope_statement:'Rewritten closed scope',status:'complete'
  });
  assert.equal(blockedClosedEdit.status,302);assert.match(blockedClosedEdit.location,/toastKind=error/);
  const immutableGap=db.prepare('SELECT name,scope_statement,completed_at FROM consulting_engagements WHERE id=?').get(seeded.id);
  assert.equal(immutableGap.name,closedGap.name);assert.equal(immutableGap.scope_statement,closedGap.scope_statement);
  assert.equal(immutableGap.completed_at,closedGap.completed_at,'generic settings save cannot refresh the controlled closure timestamp');

  const blocked=await client.post(`/workspaces/${gapWorkspaceId}/delivery/engagements`,{
    name:'Out-of-contract implementation',engagement_type:'implementation',frameworks:'iso27001'
  });
  assert.equal(blocked.status,302);assert.match(blocked.location,/toastKind=error/);
  assert.match(decodeURIComponent(blocked.location),/Convert the service path to Full certification support/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM consulting_engagements WHERE workspace_id=? AND name='Out-of-contract implementation'").get(gapWorkspaceId).c,0);

  const advisory=await client.post(`/workspaces/${gapWorkspaceId}/delivery/engagements`,{
    name:'Report clarification advisory',engagement_type:'advisory',frameworks:'iso27001'
  });
  assert.equal(advisory.status,302);assert.doesNotMatch(advisory.location,/toastKind=error/);
  const advisoryEngagement=db.prepare("SELECT * FROM consulting_engagements WHERE workspace_id=? AND name='Report clarification advisory'").get(gapWorkspaceId);
  assert.equal(advisoryEngagement.engagement_type,'advisory');
  const advisoryComplete=await client.post(`/workspaces/${gapWorkspaceId}/delivery/engagements/${advisoryEngagement.id}`,{
    row_version:String(advisoryEngagement.row_version),name:advisoryEngagement.name,status:'complete'
  });
  assert.equal(advisoryComplete.status,302);assert.doesNotMatch(advisoryComplete.location,/toastKind=error/);
  assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(advisoryEngagement.id).status,'complete');

  const portfolio=await client.get('/delivery-portfolio');
  assert.equal(portfolio.status,200);assert.match(portfolio.text,/Service path/);
  assert.match(portfolio.text,/Gap assessment only/);assert.match(portfolio.text,/Full certification support/);
  let dashboard=await client.get('/dashboard?legacy=1');
  if(dashboard.status===302) dashboard=await client.get(dashboard.location);
  assert.equal(dashboard.status,200);assert.match(dashboard.text,/Report Only Client/);assert.match(dashboard.text,/Gap assessment only/);
});

test('workpaper separates management, design, implementation and operating conclusions',async()=>{
  const created=await client.post(`/workspaces/${wsId}/delivery/workpapers`,{ engagement_id:String(engagementId),requirement_id:String(requirementId),title:'Context control design and operation',owner_id:String(managerId),reviewer_id:String(reviewerId),management_claim:'implemented' });
  assert.equal(created.status,302);
  const row=db.prepare('SELECT * FROM consultant_workpapers WHERE engagement_id=? AND requirement_id=?').get(engagementId,requirementId);assert.ok(row);workpaperId=row.id;
  assert.equal(row.management_claim,'implemented');assert.equal(row.design_conclusion,'not_assessed');assert.equal(row.implementation_conclusion,'not_assessed');assert.equal(row.operating_effectiveness,'not_tested');
  const detail=await client.get(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}`);assert.equal(detail.status,200);assert.match(detail.text,/Management claim/);assert.match(detail.text,/Operating effectiveness/);
});

test('workpaper enforces sampling and evidence classification before review',async()=>{
  evidenceId=Number(db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description)
    VALUES (?,'access-review.xlsx','access-review.xlsx','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,?,'Q2 access review')`).run(wsId,managerId).lastInsertRowid);
  let row=db.prepare('SELECT * FROM consultant_workpapers WHERE id=?').get(workpaperId);
  const update=await client.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}`,{
    row_version:String(row.row_version),title:row.title,owner_id:String(managerId),reviewer_id:String(reviewerId),client_validator_id:String(clientId),due_date:'2026-12-31',
    objective:'Determine whether the control is suitably designed, implemented, and operating throughout the review period.',
    procedure_performed:'Inspected the control design, interviewed the process owner, selected a sample, and reperformed evidence checks.',persons_interviewed:'Information Security Manager',
    testing_period_start:'2026-04-01',testing_period_end:'2026-06-30',population_description:'All quarterly privileged-access review records',population_size:'40',sample_method:'Risk-based sample across systems and reviewers',sample_size:'10',exceptions_count:'0',exception_summary:'No exceptions identified.',
    management_claim:'implemented',design_conclusion:'suitable',implementation_conclusion:'implemented',operating_effectiveness:'effective',evidence_sufficiency:'sufficient',
    conclusion_rationale:'The control was appropriately designed, deployed across the scoped population, and operated without exception in the selected sample.',
    internal_notes:'Internal quality note',client_visible_summary:'The quarterly access-review process operated as described during the assessment period.',client_visible:'1',requires_client_validation:'1'
  });
  assert.equal(update.status,302);
  const premature=await client.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/submit`,{note:'Ready'});assert.equal(premature.status,422);assert.match(premature.text,/not review-ready/);
  const linked=await client.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/evidence`,{evidence_id:String(evidenceId),purpose:'Supports operating-effectiveness conclusion',relevance:'relevant',period_covered_start:'2026-04-01',period_covered_end:'2026-06-30',reviewer_note:'Period and population align to the procedure.'});
  assert.equal(linked.status,302);
  assert.equal(db.prepare('SELECT relevance FROM consultant_workpaper_evidence WHERE workpaper_id=?').get(workpaperId).relevance,'relevant');
  const submitted=await client.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/submit`,{note:'Prepared and ready for independent review.'});assert.equal(submitted.status,302);
  assert.equal(db.prepare('SELECT status FROM consultant_workpapers WHERE id=?').get(workpaperId).status,'manager_review');
});

test('maker-checker approval, client validation and immutable freeze retain decision lineage',async()=>{
  const selfApprove=await client.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/approve`,{note:'Self approval attempt'});assert.equal(selfApprove.status,422);assert.match(selfApprove.text,/cannot approve their own workpaper/);
  const approved=await reviewerClient.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/approve`,{note:'Procedures and evidence support the stated conclusions.'});assert.equal(approved.status,302);
  assert.equal(db.prepare('SELECT status FROM consultant_workpapers WHERE id=?').get(workpaperId).status,'client_validation');
  // Simulate the assigned client validation through the same domain service;
  // the portal route is separately rendered and permission-tested below.
  const consulting=require('../lib/consulting-delivery');
  consulting.transitionWorkpaper(db,{...db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId),frameworks:['iso27001']},{id:clientId},workpaperId,'validate','The client-visible factual summary is accurate.');
  assert.equal(db.prepare('SELECT status FROM consultant_workpapers WHERE id=?').get(workpaperId).status,'approved');
  const frozen=await reviewerClient.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/freeze`,{note:'Final workpaper locked after client validation.'});assert.equal(frozen.status,302);
  const snapshot=db.prepare('SELECT * FROM consultant_workpaper_snapshots WHERE workpaper_id=?').get(workpaperId);assert.equal(snapshot.snapshot_hash.length,64);assert.match(snapshot.snapshot_json,/access-review\.xlsx/);
  assert.throws(()=>db.prepare('UPDATE consultant_workpaper_snapshots SET snapshot_hash=? WHERE id=?').run('b'.repeat(64),snapshot.id),/immutable/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM consultant_workpaper_reviews WHERE workpaper_id=?').get(workpaperId).c,4);
});

test('findings enforce author-reviewer separation, governed remediation and independent closure',async()=>{
  const created=await client.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/findings`,{
    title:'Access review exceptions are not formally tracked',finding_type:'nonconformity',severity:'high',
    condition_text:'Two access-review exceptions did not have retained closure records.',criteria_text:'The scoped control requires identified exceptions to be assigned, resolved and evidenced.',
    cause_text:'Exception ownership was informal.',effect_text:'Unresolved privileged access could remain active beyond the approved period.',
    recommendation_text:'Record every exception, accountable owner, target date, resolution evidence and independent validation.',client_visible:'1',internal_notes:'Discuss wording with engagement lead before release.'
  });
  assert.equal(created.status,302);
  const finding=db.prepare('SELECT * FROM consulting_findings WHERE workpaper_id=? ORDER BY id DESC LIMIT 1').get(workpaperId);findingId=finding.id;
  const selfConfirm=await client.post(`/workspaces/${wsId}/delivery/findings/${findingId}/confirm`,{row_version:String(finding.row_version),note:'Author self-confirm attempt'});
  assert.equal(selfConfirm.status,302);assert.match(selfConfirm.location,/toastKind=error/);
  const confirmed=await reviewerClient.post(`/workspaces/${wsId}/delivery/findings/${findingId}/confirm`,{row_version:String(finding.row_version),note:'Evidence and criteria support confirmation.'});
  assert.equal(confirmed.status,302);assert.equal(db.prepare('SELECT status FROM consulting_findings WHERE id=?').get(findingId).status,'confirmed');
  let row=db.prepare('SELECT * FROM consulting_findings WHERE id=?').get(findingId);
  const planned=await client.post(`/workspaces/${wsId}/delivery/findings/${findingId}/plan`,{row_version:String(row.row_version),owner_id:String(clientId),due_date:'2026-10-31',remediation_plan:'Create a governed exception register, assign owners, retain closure proof, and review completion monthly.',note:'Plan agreed with management.'});
  assert.equal(planned.status,302);row=db.prepare('SELECT * FROM consulting_findings WHERE id=?').get(findingId);assert.equal(row.status,'remediation_planned');
  const submitted=await client.post(`/workspaces/${wsId}/delivery/findings/${findingId}/validate`,{row_version:String(row.row_version),resolution_summary:'The client supplied the completed exception register and approved closure records.',note:'Resolution submitted for independent validation.'});
  assert.equal(submitted.status,302);row=db.prepare('SELECT * FROM consulting_findings WHERE id=?').get(findingId);assert.equal(row.status,'ready_for_validation');
  const ownerClose=await client.post(`/workspaces/${wsId}/delivery/findings/${findingId}/close`,{row_version:String(row.row_version),validation_conclusion:'Attempted non-independent closure.',note:'Attempt'});
  assert.equal(ownerClose.status,302);assert.match(ownerClose.location,/toastKind=error/);
  const linked=await reviewerClient.post(`/workspaces/${wsId}/delivery/findings/${findingId}/evidence`,{evidence_id:String(evidenceId),evidence_role:'validation'});assert.equal(linked.status,302);
  const closed=await reviewerClient.post(`/workspaces/${wsId}/delivery/findings/${findingId}/close`,{row_version:String(row.row_version),validation_conclusion:'Inspected the completed register and reperformed the closure check; the exception is resolved.',note:'Closure independently validated.'});
  assert.equal(closed.status,302);assert.equal(db.prepare('SELECT status FROM consulting_findings WHERE id=?').get(findingId).status,'closed');
  const events=db.prepare('SELECT * FROM consulting_finding_events WHERE finding_id=? ORDER BY id').all(findingId);assert.equal(events.length,5);
  assert.throws(()=>db.prepare('UPDATE consulting_finding_events SET note=? WHERE id=?').run('tamper',events[0].id),/immutable/);
  const detail=await client.get(`/workspaces/${wsId}/delivery/findings/${findingId}`);assert.equal(detail.status,200);assert.match(detail.text,/Independent validation conclusion/);assert.match(detail.text,/append-only lifecycle events/i);
});

test('reports are immutable, maker-checker approved and published to the client portal',async()=>{
  const generated=await reviewerClient.post(`/workspaces/${wsId}/delivery/reports`,{engagement_id:String(engagementId),report_type:'readiness',title:'ISO 27001 readiness assessment report'});
  assert.equal(generated.status,302);const report=db.prepare('SELECT * FROM consulting_report_snapshots WHERE engagement_id=? ORDER BY id DESC LIMIT 1').get(engagementId);reportId=report.id;
  assert.equal(report.status,'generated');assert.equal(report.snapshot_hash.length,64);assert.match(report.snapshot_json,/Access review exceptions/);
  const selfApprove=await reviewerClient.post(`/workspaces/${wsId}/delivery/reports/${reportId}/approve`,{note:'Self approval attempt'});assert.equal(selfApprove.status,403);assert.match(selfApprove.text,/cannot independently review their own report/);
  const approved=await client.post(`/workspaces/${wsId}/delivery/reports/${reportId}/approve`,{note:'Independent review confirms the report agrees to frozen workpapers and confirmed findings.'});assert.equal(approved.status,302);
  const published=await reviewerClient.post(`/workspaces/${wsId}/delivery/reports/${reportId}/publish`,{note:'Approved client deliverable released through the controlled portal.'});assert.equal(published.status,302);
  assert.equal(db.prepare('SELECT status FROM consulting_report_snapshots WHERE id=?').get(reportId).status,'published');
  assert.throws(()=>db.prepare('UPDATE consulting_report_snapshots SET snapshot_json=? WHERE id=?').run('{}',reportId),/immutable/);
  const view=await client.get(`/workspaces/${wsId}/delivery/reports/${reportId}`);assert.equal(view.status,200);assert.match(view.text,/SHA-256 snapshot/);assert.match(view.text,/Print \/ save PDF/);
});

test('database tenant guard rejects cross-workspace workpaper evidence',()=>{
  const otherEvidence=Number(db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by)
    VALUES (?,'other.pdf','other.pdf','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',50,?)`).run(otherWsId,managerId).lastInsertRowid);
  assert.throws(()=>db.prepare(`INSERT INTO consultant_workpaper_evidence (workpaper_id,evidence_id,purpose,linked_by) VALUES (?,?,?,?)`).run(workpaperId,otherEvidence,'Cross-tenant attempt',managerId),/another workspace/);
});

test('structured client requests retain purpose, examples, period and confidentiality',async()=>{
  // Reopen first because client requests are deliberately created while the
  // consultant can still amend the workpaper.
  await reviewerClient.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/reopen`,{note:'Additional evidence period requested for annual coverage.'});
  const response=await client.post(`/workspaces/${wsId}/delivery/workpapers/${workpaperId}/client-request`,{
    title:'Provide annual access review population',assignee_id:String(clientId),priority:'high',description:'Upload the complete access-review population and evidence of reviewer approval.',
    request_reason:'Required to extend the test from one quarter to the annual assessment period.',acceptable_examples:'Exported review register, dated approval, and exception follow-up records.',
    evidence_period_start:'2026-01-01',evidence_period_end:'2026-12-31',due_date:'2027-01-15',confidentiality:'restricted'
  });
  assert.equal(response.status,302);
  const request=db.prepare('SELECT * FROM client_requests WHERE workpaper_id=? ORDER BY id DESC LIMIT 1').get(workpaperId);assert.ok(request);assert.equal(request.engagement_id,engagementId);assert.equal(request.confidentiality,'restricted');assert.equal(request.evidence_period_end,'2026-12-31');assert.match(request.acceptable_examples,/review register/);
});

test('common controls map once across framework requirements with rationale',async()=>{
  const control=await client.post(`/workspaces/${wsId}/delivery/client-controls`,{engagement_id:String(engagementId),control_code:'CC-001',title:'Quarterly privileged-access review',description:'Reviews privileged access quarterly.',control_owner_id:String(clientId),frequency:'Quarterly',control_type:'detective',nature:'manual'});assert.equal(control.status,302);
  const cc=db.prepare("SELECT * FROM client_controls WHERE workspace_id=? AND control_code='CC-001'").get(wsId);
  const mapping=await client.post(`/workspaces/${wsId}/delivery/client-controls/${cc.id}/mappings`,{engagement_id:String(engagementId),requirement_id:String(requirementId),coverage:'supporting',mapping_rationale:'This client control supplies operating evidence supporting the mapped management-system requirement.'});assert.equal(mapping.status,302);
  assert.equal(db.prepare('SELECT coverage FROM client_control_requirement_links WHERE client_control_id=? AND requirement_id=?').get(cc.id,requirementId).coverage,'supporting');
});

test('commercial baseline, time and scope-change decisions feed firm QA portfolio',async()=>{
  let commercial=db.prepare('SELECT * FROM engagement_commercials WHERE engagement_id=?').get(engagementId);
  const finance=await client.post(`/workspaces/${wsId}/delivery/commercial`,{engagement_id:String(engagementId),row_version:String(commercial.row_version),currency:'USD',contract_value:'30000',planned_hours:'300',internal_cost_rate:'80',billing_model:'fixed_fee',billing_status:'in_progress',invoiced:'15000',collected:'10000'});assert.equal(finance.status,302);
  const time=await client.post(`/workspaces/${wsId}/delivery/time`,{engagement_id:String(engagementId),work_date:'2026-08-09',hours:'8',category:'workpaper',description:'Prepared and reviewed control workpapers',billable:'1'});assert.equal(time.status,302);
  const change=await client.post(`/workspaces/${wsId}/delivery/scope-changes`,{engagement_id:String(engagementId),title:'Add second location',description:'Extend assessment to the Chennai facility.',reason:'Client requested certification scope expansion.',schedule_impact_days:'10',fee_impact:'5000'});assert.equal(change.status,302);
  const scope=db.prepare('SELECT * FROM engagement_scope_changes WHERE engagement_id=?').get(engagementId);
  const decision=await client.post(`/workspaces/${wsId}/delivery/scope-changes/${scope.id}/decision`,{engagement_id:String(engagementId),decision:'approved',decision_note:'Approved through formal scope-control governance.'});assert.equal(decision.status,302);
  const portfolio=await client.get('/delivery-portfolio');assert.equal(portfolio.status,200);assert.match(portfolio.text,/30,000/);assert.match(portfolio.text,/Consulting OS Client/);
});

test('client portal exposes assigned factual validation but never firm delivery cockpit',async(t)=>{
  // Return workpaper to validation state for the discovery test.
  db.prepare("UPDATE consultant_workpapers SET status='client_validation',client_visible=1,requires_client_validation=1,client_validator_id=? WHERE id=?").run(clientId,workpaperId);
  const clientHttp=makeClient(env.app);t.after(()=>clientHttp.close());await loginAs(clientHttp,'client.validator@example.com','client-password-1234');
  const portal=await clientHttp.get(`/workspaces/${wsId}/client-portal`);assert.equal(portal.status,200);assert.match(portal.text,new RegExp(`/client-portal/workpapers/${workpaperId}/validate`));
  assert.match(portal.text,/Reports and completed work/);assert.match(portal.text,/ISO 27001 readiness assessment report/);
  assert.doesNotMatch(portal.text,/factual validation|client-visible|internal consultant|append-only|version-controlled/i);
  const publishedReport=await clientHttp.get(`/workspaces/${wsId}/client-portal/reports/${reportId}`);assert.equal(publishedReport.status,200);assert.match(publishedReport.text,/assessment report/);assert.doesNotMatch(publishedReport.text,/Internal quality note|controlled client deliverable|SHA-256 snapshot|immutable source workpaper/i);
  const validation=await clientHttp.get(`/workspaces/${wsId}/client-portal/workpapers/${workpaperId}/validate`);assert.equal(validation.status,200);assert.match(validation.text,/Please confirm that the information below accurately reflects your organisation/);assert.match(validation.text,/Confirm information/);assert.doesNotMatch(validation.text,/Internal quality note|client-visible|internal consultant|factual validation/i);
  const denied=await clientHttp.get(`/workspaces/${wsId}/delivery`);assert.equal(denied.status,403);
});


test('workpaper keeps recovery fields and finds evidence beyond the newest 200 files',async()=>{
  const requirement=db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' AND r.id!=? ORDER BY r.sort_order LIMIT 1`).get(requirementId);
  const created=await client.post(`/workspaces/${wsId}/delivery/workpapers`,{engagement_id:String(engagementId),requirement_id:String(requirement.id),title:'Recovery and evidence coverage',owner_id:String(managerId),reviewer_id:String(reviewerId)});
  assert.equal(created.status,302);
  const row=db.prepare('SELECT * FROM consultant_workpapers WHERE engagement_id=? AND requirement_id=?').get(engagementId,requirement.id);
  const insert=db.prepare(`INSERT INTO evidence(workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description) VALUES (?,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,?,?)`);
  db.transaction(()=>{for(let i=0;i<205;i++)insert.run(wsId,`newer-${i}.pdf`,`newer-${i}.pdf`,managerId,`Evidence description ${i}`);})();
  const detail=await client.get(`/workspaces/${wsId}/delivery/workpapers/${row.id}`);
  assert.equal(detail.status,200);
  assert.match(detail.text,/Search all available evidence/);
  assert.match(detail.text,/access-review.xlsx/,'the oldest evidence remains selectable');
  assert.match(detail.text,/data-form-draft="workpaper"/);
  const failed=await client.post(`/workspaces/${wsId}/delivery/workpapers/${row.id}`,{row_version:String(row.row_version),title:'Retained despite validation',owner_id:String(managerId),reviewer_id:String(reviewerId),population_size:'1',sample_size:'9'});
  assert.equal(failed.status,422);assert.match(failed.text,/Sample size cannot exceed/);assert.match(failed.text,/value="Retained despite validation"/);assert.match(failed.text,/data-draft-recovery=true/);
  assert.equal(db.prepare('SELECT title FROM consultant_workpapers WHERE id=?').get(row.id).title,row.title);
  const stale=await client.post(`/workspaces/${wsId}/delivery/workpapers/${row.id}`,{row_version:String(row.row_version-1),title:'Retained stale edits',owner_id:String(managerId),reviewer_id:String(reviewerId)});
  assert.equal(stale.status,409);assert.match(stale.text,/Retained stale edits/);
  assert.match(stale.text,new RegExp(`data-draft-version="${row.row_version}"`));
});

test('save and submit uses the durable draft atomically and retains it when review validation fails',async()=>{
  const row=db.prepare("SELECT * FROM consultant_workpapers WHERE engagement_id=? AND title='Recovery and evidence coverage'").get(engagementId);
  const drafts=require('../lib/form-drafts');
  const context={workspaceId:wsId,actorId:managerId,kind:'workpaper',recordId:String(row.id),contextKey:'',recordVersion:row.row_version};
  const draft=drafts.save(db,context,{generation:0,expectedDraftVersion:0,baseVersion:row.row_version,clientSaveId:'failed-review-draft',payload:{title:'Recovered durable title',objective:'Incomplete',owner_id:String(managerId),reviewer_id:String(reviewerId),internal_notes:'Private retained draft notes'}});
  const response=await client.post(`/workspaces/${wsId}/delivery/workpapers/${row.id}`,{row_version:String(row.row_version),title:'Stale browser value',owner_id:String(managerId),reviewer_id:String(reviewerId),intent:'submit',draft_id:draft.id,draft_version:String(draft.version),draft_generation:String(draft.generation)});
  assert.equal(response.status,422);assert.match(response.text,/value="Recovered durable title"/);assert.match(response.text,/not review-ready/);
  assert.deepEqual(db.prepare('SELECT * FROM consultant_workpapers WHERE id=?').get(row.id),row,'the failed submission also rolls back its formal save');
  assert.equal(drafts.get(db,context).draft.state,'active');
  assert.equal(drafts.get(db,context).draft.payload.title,'Recovered durable title');
});


test('exact pass snapshot view excludes later working fields and exposes the retained report basis',async()=>{
  const service=require('../lib/consulting-delivery');
  const ws=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const row=db.prepare("SELECT w.*,r.ref FROM consultant_workpapers w JOIN requirements r ON r.id=w.requirement_id WHERE w.engagement_id=? AND w.title='Recovery and evidence coverage'").get(engagementId);
  db.prepare('UPDATE consultant_workpapers SET persons_interviewed=?,internal_notes=? WHERE id=?').run('Later manual interviews must stay in the working record','Later manual notes must stay in the working record',row.id);
  const passId=Number(db.prepare(`INSERT INTO assessment_passes(workspace_id,pass_number,label,status,started_by) VALUES (?,1,'HTTP snapshot pass','in_progress',?)`).run(wsId,managerId).lastInsertRowid);
  db.prepare(`INSERT INTO control_state_history(workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,pass_id) VALUES (?,?,?,'Not Implemented','included',0,'Retained assessment gap.',?)`).run(wsId,row.ref,managerId,passId);
  const pass=db.prepare('SELECT * FROM assessment_passes WHERE id=?').get(passId);
  const materialized=service.materializeAssessmentPass(db,ws,pass,reviewerId);
  const item=db.prepare('SELECT * FROM assessment_pass_manifest_items WHERE manifest_id=?').get(materialized.manifestId);
  const snapshot=await client.get(`/workspaces/${wsId}/delivery/workpapers/${row.id}?snapshot=${item.snapshot_id}`);
  assert.equal(snapshot.status,200);assert.match(snapshot.text,/Retained assessment gap/);assert.match(snapshot.text,/Assessment pass 1/);
  assert.doesNotMatch(snapshot.text,/Later manual interviews|Later manual notes|data-form-draft="workpaper"/);
  const reports=await client.get(`/workspaces/${wsId}/delivery?view=reports&engagement=${engagementId}`);
  assert.equal(reports.status,200);assert.match(reports.text,/Source assessment/);assert.match(reports.text,new RegExp(`option value="${materialized.manifestId}" selected`));
  const generated=await client.post(`/workspaces/${wsId}/delivery/reports`,{engagement_id:String(engagementId),report_type:'assessment',pass_manifest_id:String(materialized.manifestId)});
  assert.equal(generated.status,302);assert.doesNotMatch(generated.location,/toastKind=error/);
  const report=await client.get(generated.location);assert.equal(report.status,200);assert.match(report.text,new RegExp(`workpapers/${row.id}\\?snapshot=${item.snapshot_id}`));
  const retained=await client.get(`/workspaces/${wsId}/delivery/pass-manifests/${materialized.manifestId}`);
  assert.equal(retained.status,200);assert.match(retained.text,/Retained conclusions/);assert.match(retained.text,new RegExp(`workpapers/${row.id}\\?snapshot=${item.snapshot_id}`));
  const second=service.materializeAssessmentPass(db,ws,pass,reviewerId);
  const history=await client.get(`/workspaces/${wsId}/gap-assessment`);
  assert.equal(history.status,200);assert.match(history.text,new RegExp(`delivery/pass-manifests/${materialized.manifestId}`));assert.match(history.text,new RegExp(`delivery/pass-manifests/${second.manifestId}`));
  assert.match(history.text,/Operational exports/);assert.match(history.text,/issued client report/);
  const older=await client.get(`/workspaces/${wsId}/delivery?view=reports&engagement=${engagementId}&manifestId=${materialized.manifestId}`);
  assert.equal(older.status,200);assert.match(older.text,new RegExp(`option value="${materialized.manifestId}" selected`));
  const wrongWorkspace=await client.get(`/workspaces/${otherWsId}/delivery/pass-manifests/${materialized.manifestId}`);assert.equal(wrongWorkspace.status,404);
  const invalidSource=await client.get(`/workspaces/${wsId}/delivery?view=reports&engagement=${engagementId}&manifestId=99999999`);assert.equal(invalidSource.status,404);

});
