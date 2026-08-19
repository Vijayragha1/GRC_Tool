'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env, client, db, workspaceId, engagementId, managerId, clientSide;

test.before(async () => {
  env = await bootClient(); client = env.client; db = new Database(env.dbPath);
  const manager = db.prepare(`SELECT * FROM users WHERE email='sec-test@example.com'`).get(); managerId=manager.id;
  workspaceId = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,industry,scope,lead_consultant_id)
    VALUES (?,'CSF Policy Practice Test Client','Technology','Corporate governance and production services',?)`).run(manager.firm_id,managerId).lastInsertRowid);
  db.prepare(`UPDATE workspaces SET frameworks=? WHERE id=?`).run(JSON.stringify(['iso27001','csf','iso42001']),workspaceId);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'firm_owner')`).run(workspaceId,managerId);
  const created = await client.post(`/workspaces/${workspaceId}/csf`, {
    name:'NIST CSF 2.0 governed assessment',scope_statement:'Corporate governance and production services, supporting people, cloud technology, data, suppliers, and defined interfaces.',
    period_start:'2026-01-01',period_end:'2026-06-30',target_completion_date:'2026-09-30',assigned_lead_id:String(managerId),
  });
  assert.equal(created.status,302,created.text.slice(0,500));
  engagementId=Number((created.location.match(/\/csf\/(\d+)/)||[])[1]);assert.ok(engagementId);
});

test.after(async()=>{if(db)db.close();if(clientSide)await clientSide.close();if(client)await client.close();});

test('canonical methodology covers exactly 6 Functions, 22 Categories, and 106 uniquely anchored outcomes',()=>{
  const method=require('../data/nist-csf-policy-practice');
  const catalog=require('../data/nist-csf');
  const categories=catalog.FUNCTIONS.flatMap(f=>f.categories),outcomes=method.OUTCOMES;
  assert.equal(catalog.FUNCTIONS.length,6);assert.equal(categories.length,22);assert.equal(outcomes.length,106);
  assert.equal(new Set(outcomes.map(o=>o.code)).size,106);assert.equal(method.CATALOG_HASH.length,64);assert.equal(method.METHODOLOGY_HASH.length,64);
  const policyAnchors=outcomes.flatMap(o=>Object.values(o.policy_anchors));const practiceAnchors=outcomes.flatMap(o=>Object.values(o.practice_anchors));
  assert.equal(policyAnchors.length,636);assert.equal(practiceAnchors.length,636);
  assert.equal(new Set(policyAnchors).size,636);assert.equal(new Set(practiceAnchors).size,636);
  for(const o of outcomes){assert.equal(o.test_procedures.length,3,`${o.code} tests`);assert.ok(o.policy_evidence.length>=3,`${o.code} policy evidence`);assert.ok(o.practice_evidence.length>=3,`${o.code} practice evidence`);assert.equal(o.content_hash.length,64);}
});

test('migrated database locks the canonical catalog and seeds all engagement workpapers',()=>{
  assert.equal(db.prepare(`SELECT outcome_count FROM csf_catalog_versions WHERE catalog_version='2.0'`).get().outcome_count,106);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM csf_methodology_outcomes WHERE methodology_version='CSF-PP-2.0'`).get().c,106);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM csf_subcategory_assessments WHERE engagement_id=?`).get(engagementId).c,106);
  const row=db.prepare(`SELECT * FROM csf_methodology_outcomes ORDER BY id LIMIT 1`).get();
  assert.throws(()=>db.prepare(`UPDATE csf_methodology_outcomes SET content_hash=? WHERE id=?`).run('a'.repeat(64),row.id),/immutable/);
});

test('cybersecurity maturity programme renders decision, workbench, assurance, roadmap, and reporting areas',async()=>{
  const programme=await client.get(`/workspaces/${workspaceId}/csf`);assert.equal(programme.status,200,programme.text.slice(0,500));
  assert.match(programme.text,/NIST Cybersecurity Framework 2\.0/);assert.match(programme.text,/Cybersecurity maturity programme/);
  assert.match(programme.text,/Assessment status/);assert.match(programme.text,/Function-level maturity/);
  assert.match(programme.text,/ISO 27001 programme/);assert.match(programme.text,/Cybersecurity maturity/);assert.match(programme.text,/AI management system/);
  assert.doesNotMatch(programme.text,/nav-subitem-text">NIST CSF 2\.0/,'NIST must not be buried inside the ISO assessment menu');
  for(const path of ['scope','assessment','review','findings','report']){
    const page=await client.get(`/workspaces/${workspaceId}/csf/${engagementId}/${path}`);assert.equal(page.status,200,`${path}: ${page.text.slice(0,500)}`);
    assert.doesNotMatch(page.text,/Implementation Tier assessment|weighted capability score/i);
  }
  const assessment=await client.get(`/workspaces/${workspaceId}/csf/${engagementId}/assessment`);
  assert.match(assessment.text,/Capability workbenches/);assert.match(assessment.text,/Outcome workpapers/);assert.match(assessment.text,/lower level is the conservative achieved level/i);
  for(const code of ['gv','id','pr','de','rs','rc']){assert.match(assessment.text,new RegExp(`cm-function-${code}`));assert.match(programme.text,new RegExp(`cm-function-${code}`));}
  assert.doesNotMatch(assessment.text,/class="csf2-outcome-row"/,'the 106-row register must not be the primary workbench');
  const categoryCode=db.prepare(`SELECT c.code FROM csf_categories c JOIN csf_functions f ON f.id=c.function_id WHERE f.catalog_version='2.0' ORDER BY f.display_order,c.display_order LIMIT 1`).get().code;
  const category=await client.get(`/workspaces/${workspaceId}/csf/${engagementId}/assessment/category/${categoryCode}`);assert.equal(category.status,200,category.text.slice(0,500));assert.match(category.text,/focused capability review/i);assert.match(category.text,/Outcome workpapers/);assert.match(category.text,/cm-category-hero cm-function-gv/);
  const register=await client.get(`/workspaces/${workspaceId}/csf/${engagementId}/assessment?view=outcomes`);assert.equal(register.status,200);assert.match(register.text,/Governed workpapers/);assert.equal((register.text.match(/class="csf2-outcome-row"/g)||[]).length,106);
  assert.doesNotMatch(assessment.text,/NIST CSF learning/);
  for(const old of ['profile','assess','scores','tiers','versions']){
    const page=await client.get(`/workspaces/${workspaceId}/csf/${engagementId}/${old}`);assert.equal(page.status,302,old);assert.doesNotMatch(page.location,/\/(tiers|scores)$/);
  }
  assert.equal((await client.get(`/workspaces/${workspaceId}/csf/learn`)).status,302);
});

test('a CSF-only client root resolves to its programme with no duplicate overview navigation',async()=>{
  db.prepare(`UPDATE workspaces SET frameworks=? WHERE id=?`).run(JSON.stringify(['csf']),workspaceId);
  const root=await client.get(`/workspaces/${workspaceId}`);
  assert.equal(root.status,302,root.text.slice(0,500));
  assert.equal(root.location,`/workspaces/${workspaceId}/csf`);
  const programme=await client.get(root.location);
  assert.equal(programme.status,200,programme.text.slice(0,500));
  assert.match(programme.text,/Cybersecurity maturity programme/);
  assert.match(programme.text,/NIST CSF 2\.0 governed assessment/);
  assert.doesNotMatch(programme.text,/Stage 1 maturity|ISO 27001 programme|ISO controls &amp; SoA/);
  const sidebarNav=(programme.text.match(/<nav class="sidebar-nav">[\s\S]*?<\/nav>/)||[])[0];assert.ok(sidebarNav);
  assert.equal((sidebarNav.match(/class="nav-domain-summary"/g)||[]).length,3);
  for(const label of ['Delivery','Cybersecurity maturity','Settings']) assert.match(sidebarNav,new RegExp(label));
  for(const label of ['Business profile','Maturity workbench','Quality review','Priorities &amp; roadmap','Executive reporting']) assert.match(sidebarNav,new RegExp(label));
  assert.doesNotMatch(sidebarNav,/nav-item-text">Overview|Review queue|Plan &amp; roadmap|Compliance calendar|Risks &amp; context|Suppliers|Incidents|Business continuity|Evidence coverage|Policy templates|Management reviews|Reports &amp; assurance|Assurance &amp; certification|Internal audits|Auditor access|Client setup/);
  const evidenceCoverage=await client.get(`/workspaces/${workspaceId}/evidence-coverage`);
  assert.equal(evidenceCoverage.status,302);
  assert.equal(evidenceCoverage.location,`/workspaces/${workspaceId}/csf/current/assessment?view=outcomes&gap=evidence`);
  const currentEvidence=await client.get(evidenceCoverage.location);
  assert.equal(currentEvidence.status,302);
  assert.equal(currentEvidence.location,`/workspaces/${workspaceId}/csf/${engagementId}/assessment?view=outcomes&gap=evidence`);
  for(const section of ['scope','assessment','review','findings','report']){
    const current=await client.get(`/workspaces/${workspaceId}/csf/current/${section}`);
    assert.equal(current.status,302,section);
    assert.equal(current.location,`/workspaces/${workspaceId}/csf/${engagementId}/${section}`);
  }
  db.prepare(`UPDATE workspaces SET frameworks=? WHERE id=?`).run(JSON.stringify(['iso27001','csf','iso42001']),workspaceId);
  const mixedRoot=await client.get(`/workspaces/${workspaceId}`);
  assert.equal(mixedRoot.status,200,mixedRoot.text.slice(0,500));
  assert.match(mixedRoot.text,/Integrated assurance portfolio/);
  assert.match(mixedRoot.text,/Framework scores are not combined/);
  assert.match(mixedRoot.text,/ISO\/IEC 27001:2022/);
  assert.match(mixedRoot.text,/ISO\/IEC 42001:2023/);
  assert.match(mixedRoot.text,/NIST Cybersecurity Framework 2\.0/);
  const mixedSidebar=(mixedRoot.text.match(/<nav class="sidebar-nav">[\s\S]*?<\/nav>/)||[])[0];assert.ok(mixedSidebar);
  assert.match(mixedSidebar,/nav-item-text">Integrated overview/,'mixed-framework clients use the integrated overview');
});

test('Profile requires complete context, optimistic concurrency, and independent approval',async()=>{
  let p=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagementId);
  const text=label=>`${label} is defined for the assessed corporate and production scope with accountable owners, material dependencies, decision criteria, and traceable evidence.`;
  const submitted=await client.post(`/workspaces/${workspaceId}/csf/${engagementId}/scope`,{
    row_version:String(p.row_version),action:'submit',business_context:text('Business context'),mission_objectives:text('Mission objectives'),critical_services:text('Critical services'),critical_assets_data:text('Critical assets and data'),
    threat_landscape:text('Threat landscape'),legal_contractual_requirements:text('Legal and contractual requirements'),stakeholder_expectations:text('Stakeholder expectations'),risk_appetite:text('Risk appetite'),
    scope_statement:text('Assessment boundary'),assessment_limitations:text('Assessment limitations'),community_profile_reference:'No Community Profile was used.',
  });
  assert.equal(submitted.status,302,submitted.text);p=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagementId);assert.equal(p.status,'submitted');
  const stale=await client.post(`/workspaces/${workspaceId}/csf/${engagementId}/scope`,{row_version:'1',action:'save'});assert.equal(stale.status,409);
  const selfApprove=await client.post(`/workspaces/${workspaceId}/csf/${engagementId}/scope`,{row_version:String(p.row_version),action:'approve'});assert.equal(selfApprove.status,409);assert.match(selfApprove.text,/Independent approval/i);
});

test('Policy evidence cannot prove Practice and evidence gates scale with the claimed level',()=>{
  const model=require('../lib/csf-policy-practice');
  const row=db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? ORDER BY id LIMIT 1`).get(engagementId);
  db.prepare(`UPDATE csf_subcategory_assessments SET policy_score=3,practice_score=3,target_policy_score=4,target_practice_score=4,
    policy_rationale=?,practice_rationale=?,policy_owner='CISO',practice_owner='Operations',evidence_confidence='medium',assurance_outcome='partially_effective',
    assessment_period_start='2026-01-01',assessment_period_end='2026-06-30',population_description='Monthly records',population_size=30,sample_size=8,sample_rationale=? WHERE id=?`)
    .run('Policy rationale '.repeat(14),'Practice rationale '.repeat(14),'Representative records across the assessment period and material systems were selected.',row.id);
  for(let i=1;i<=2;i++)db.prepare(`INSERT INTO csf_evidence_items (assessment_id,type,url,description,uploaded_by,relevance_note,evidence_axis,evidence_quality,source_reliability)
    VALUES (?,'URL',?,?,?,?, 'policy','good','high')`).run(row.id,`https://evidence.test/policy-${i}`,`Policy evidence ${i}`,managerId,'Supports approved policy and governance requirements.');
  const current=db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE id=?`).get(row.id);
  assert.equal(model.scoreGateDefects(db,current,'policy',3).length,0);
  assert.ok(model.scoreGateDefects(db,current,'practice',3).some(d=>/two relevant items/i.test(d)),model.scoreGateDefects(db,current,'practice',3));
  assert.ok(model.scoreGateDefects(db,current,'practice',4).some(d=>/passed effectiveness test/i.test(d)));
});

test('rollups use separate medians, distributions, and conservative achieved levels - never averages',()=>{
  const model=require('../lib/csf-policy-practice');const e=db.prepare(`SELECT * FROM csf_engagements WHERE id=?`).get(engagementId);
  const rows=db.prepare(`SELECT id FROM csf_subcategory_assessments WHERE engagement_id=? ORDER BY id LIMIT 2`).all(engagementId);
  db.prepare(`UPDATE csf_subcategory_assessments SET policy_score=5,practice_score=1,target_policy_score=5,target_practice_score=2 WHERE id=?`).run(rows[0].id);
  db.prepare(`UPDATE csf_subcategory_assessments SET policy_score=1,practice_score=5,target_policy_score=2,target_practice_score=5 WHERE id=?`).run(rows[1].id);
  const rollup=model.computeRollup(db,e);assert.equal(rollup.rows.find(r=>r.id===rows[0].id).achieved_level,1);assert.equal(rollup.rows.find(r=>r.id===rows[1].id).achieved_level,1);
  assert.ok(Array.isArray(rollup.summary.policyDistribution));assert.ok(Array.isArray(rollup.summary.practiceDistribution));assert.equal('average' in rollup.summary,false);assert.equal('score' in rollup.summary,false);
});

test('maker-checker blocks a scorer from reviewing their own conclusion',async()=>{
  const assessment=db.prepare(`SELECT a.*,s.code FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id WHERE a.engagement_id=? ORDER BY a.id LIMIT 1`).get(engagementId);
  db.prepare(`UPDATE csf_subcategory_assessments SET status='Assessor Complete',policy_scored_by=?,practice_scored_by=? WHERE id=?`).run(managerId,managerId,assessment.id);
  const response=await client.post(`/workspaces/${workspaceId}/csf/${engagementId}/review/${assessment.subcategory_id}`,{action:'review',note:'Independent review considered the evidence, testing, sampling, rationale, target, and stated limitations in full.'});
  assert.equal(response.status,409);assert.match(response.text,/scorer cannot review/i);
});

test('immutable report versions freeze 106 decisions and preserve SHA-256 lineage',()=>{
  const model=require('../lib/csf-policy-practice');const e=db.prepare(`SELECT * FROM csf_engagements WHERE id=?`).get(engagementId),u=db.prepare(`SELECT * FROM users WHERE id=?`).get(managerId);
  const versionId=model.createVersion(db,e,u,'Initial controlled dual-axis assessment snapshot for regression assurance.');
  const version=db.prepare(`SELECT * FROM csf_assessment_versions_v2 WHERE id=?`).get(versionId);assert.equal(version.snapshot_hash.length,64);assert.equal(version.catalog_hash.length,64);assert.equal(version.methodology_hash.length,64);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM csf_assessment_version_outcomes_v2 WHERE version_id=?`).get(versionId).c,106);
  assert.throws(()=>db.prepare(`UPDATE csf_assessment_versions_v2 SET snapshot_hash=? WHERE id=?`).run('b'.repeat(64),versionId),/immutable/);
  const decision=db.prepare(`SELECT * FROM csf_score_decisions ORDER BY id LIMIT 1`).get();
  if(decision)assert.throws(()=>db.prepare(`DELETE FROM csf_score_decisions WHERE id=?`).run(decision.id),/immutable/);
});

test('incomplete snapshots generate an internal completeness report instead of a fake assessment',()=>{
  const reports=require('../lib/csf-policy-practice-report');
  const version=db.prepare(`SELECT id FROM csf_assessment_versions_v2 WHERE engagement_id=? ORDER BY id DESC LIMIT 1`).get(engagementId);
  const frozen=reports.loadVersionModel(db,workspaceId,engagementId,version.id);const html=reports.reportHtml(frozen);const meta=reports.reportMeta(frozen);
  assert.equal(meta.complete,false);assert.equal(meta.relianceReady,false);
  assert.match(html,/Assessment progress and completeness report/);assert.match(html,/INTERNAL DRAFT - NOT FOR RELIANCE/);assert.match(html,/No maturity opinion has been issued/);
  assert.doesNotMatch(html,/Policy rationale:/);assert.ok((html.match(/Not concluded/g)||[]).length<12,'blank conclusions must not be repeated 106 times');
  assert.equal(reports.asBuffer(new Uint8Array([37,80,68,70])).toString('ascii'),'%PDF');
});

test('complete published snapshots produce an executive report, heatmap, findings, roadmap, and compact appendix',()=>{
  const reports=require('../lib/csf-policy-practice-report');
  const version=db.prepare(`SELECT id FROM csf_assessment_versions_v2 WHERE engagement_id=? ORDER BY id DESC LIMIT 1`).get(engagementId);
  const base=reports.loadVersionModel(db,workspaceId,engagementId,version.id);const complete=JSON.parse(JSON.stringify(base));
  complete.version.status='published';complete.version.published_by_name='Independent Partner';complete.version.published_at='2026-08-11 10:00:00';
  complete.outcomes=complete.outcomes.map((o,index)=>({...o,policy_score:index%5===0?4:3,practice_score:index%7===0?2:3,target_policy_score:4,target_practice_score:3,
    evidence_confidence:index%9===0?'low':'high',assurance_outcome:index%7===0?'partially_effective':'effective',business_impact:`${o.outcome_code} affects reliable delivery of critical services and risk decisions.`,
    evidence_manifest_json:JSON.stringify([{id:index+1,axis:'both',quality:'good'}]),tests_snapshot_json:JSON.stringify([{test_code:`T${index+1}`,result:index%7===0?'partial':'pass'}]),
    findings_snapshot_json:index===0?JSON.stringify([{id:1,title:'Governance decisions are not consistently evidenced',description:'The assessed process does not consistently retain evidence of approved cybersecurity risk decisions across the defined scope.',severity:'HIGH',status:'Approved',recommendations:JSON.stringify([{id:1,title:'Establish a governed quarterly decision and evidence review',priority:'HIGH',roadmap_phase:'0_3M'}])}]):'[]'}));
  complete.rollup.summary={...complete.rollup.summary,assessed:106,inScope:106,policyMedian:3,practiceMedian:3,achievedMedian:3,atTarget:78,targetPct:74,divergence:16,noVisibility:0};
  const html=reports.reportHtml(complete);const meta=reports.reportMeta(complete);
  assert.equal(meta.complete,true);assert.equal(meta.relianceReady,true);assert.doesNotMatch(html,/INTERNAL DRAFT - NOT FOR RELIANCE/);
  for(const heading of ['Executive assessment opinion','Function maturity profile','Outcome heatmap','Governed assessment findings','Improvement roadmap','Material outcome register'])assert.match(html,new RegExp(heading));
  assert.match(html,/Governance decisions are not consistently evidenced/);assert.match(html,/Establish a governed quarterly decision and evidence review/);
  assert.equal((html.match(/class="heat s[0-5]" title=/g)||[]).length,106);assert.doesNotMatch(html,/Policy rationale:/);
});

test('PDF and Word routes return real binary files rather than JSON-serialized byte maps',async()=>{
  const version=db.prepare(`SELECT id FROM csf_assessment_versions_v2 WHERE engagement_id=? ORDER BY id DESC LIMIT 1`).get(engagementId);
  const pdf=await client.get(`/workspaces/${workspaceId}/csf/${engagementId}/exports/report.pdf?version=${version.id}`);
  assert.equal(pdf.status,200,pdf.text.slice(0,300));assert.match(String(pdf.headers['content-type']),/^application\/pdf/);assert.match(pdf.text,/^%PDF-/);assert.doesNotMatch(pdf.text,/^\{"0":37/);
  const word=await client.get(`/workspaces/${workspaceId}/csf/${engagementId}/exports/report.docx?version=${version.id}`);
  assert.equal(word.status,200,word.text.slice(0,300));assert.match(String(word.headers['content-type']),/wordprocessingml/);assert.match(word.text,/^PK/);assert.doesNotMatch(word.text,/^\{"0":80/);
});

test('tenant triggers reject cross-workspace evidence and assessment testing',()=>{
  const firmId=db.prepare(`SELECT firm_id FROM workspaces WHERE id=?`).get(workspaceId).firm_id;
  const other=Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name) VALUES (?,'Other CSF Tenant')`).run(firmId).lastInsertRowid);
  const evidenceId=Number(db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,uploaded_by) VALUES (?,'other.pdf','other.pdf',?)`).run(other,managerId).lastInsertRowid);
  const assessment=db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE engagement_id=? ORDER BY id LIMIT 1`).get(engagementId);
  assert.throws(()=>db.prepare(`INSERT INTO csf_evidence_items (assessment_id,type,file_path,uploaded_by,evidence_id,relevance_note) VALUES (?,'FILE','other.pdf',?,?, 'relevant')`).run(assessment.id,managerId,evidenceId),/another workspace/);
  assert.throws(()=>db.prepare(`INSERT INTO csf_assessment_tests (workspace_id,engagement_id,assessment_id,test_code,axis,procedure_text,result) VALUES (?,?,?,?, 'both','test','not_run')`).run(other,engagementId,assessment.id,'X-T1'),/crosses workspace/);
});

test('client contributor sees only assigned factual validation and published deliverables',async()=>{
  const firmId=db.prepare(`SELECT firm_id FROM workspaces WHERE id=?`).get(workspaceId).firm_id,password='client-validation-password';
  const clientId=Number(db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,active) VALUES ('csf-client@test.local',?,'CSF Client Validator','client',?,1)`).run(bcrypt.hashSync(password,4),firmId).lastInsertRowid);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'contributor')`).run(workspaceId,clientId);
  const assessment=db.prepare(`SELECT a.*,s.code FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id WHERE a.engagement_id=? ORDER BY a.id LIMIT 1 OFFSET 4`).get(engagementId);
  db.prepare(`UPDATE csf_subcategory_assessments SET status='Reviewed',client_validation_status='requested',policy_score=2,practice_score=2,target_policy_score=3,target_practice_score=3,
    current_profile_statement='The client performs this outcome through the documented process in the stated scope.',business_impact='Incorrect facts could distort improvement priorities.',evidence_confidence='medium' WHERE id=?`).run(assessment.id);
  const requestId=Number(db.prepare(`INSERT INTO client_requests (workspace_id,request_type,title,description,assignee_id,created_by) VALUES (?,'action',?,'Confirm factual accuracy of this outcome.',?,?)`).run(workspaceId,`Validate ${assessment.code}`,clientId,managerId).lastInsertRowid);
  db.prepare(`INSERT INTO csf_action_links (workspace_id,engagement_id,assessment_id,client_request_id,linked_by) VALUES (?,?,?,?,?)`).run(workspaceId,engagementId,assessment.id,requestId,managerId);
  clientSide=makeClient(env.app);const login=await clientSide.get('/login');const token=(login.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/)||[])[1];
  assert.equal((await clientSide.post('/login',{email:'csf-client@test.local',password,_csrf:token},{csrf:false})).status,302);await clientSide.get('/dashboard');
  assert.equal((await clientSide.get(`/workspaces/${workspaceId}/csf/${engagementId}/assessment`)).status,403);
  const portal=await clientSide.get(`/workspaces/${workspaceId}/csf/${engagementId}/portal`);assert.equal(portal.status,200,portal.text.slice(0,500));assert.match(portal.text,new RegExp(assessment.code.replace('.','\\.')));assert.match(portal.text,/Confirm information/i);assert.doesNotMatch(portal.text,/factual validation|controlled deliverable|internal consultant|immutable deliverable/i);
  const decision=await clientSide.post(`/workspaces/${workspaceId}/csf/${engagementId}/portal/validate/${assessment.subcategory_id}`,{decision:'validated',note:'The stated scope and factual description are accurate.'});assert.equal(decision.status,302,decision.text);
  assert.deepEqual(db.prepare(`SELECT status,client_validation_status,client_validated_by FROM csf_subcategory_assessments WHERE id=?`).get(assessment.id),{status:'Client Validated',client_validation_status:'validated',client_validated_by:clientId});
});
