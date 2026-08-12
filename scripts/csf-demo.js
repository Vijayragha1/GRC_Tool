#!/usr/bin/env node
'use strict';

// Realistic synthetic dataset for the production Policy/Practice assessment.
// It never presents demo conclusions as approved assurance and never creates
// NIST Tier conclusions or converts legacy single scores.

const { db, init } = require('../db');
const csf = require('../lib/csf-policy-practice');
const methodology = require('../data/nist-csf-policy-practice');
init();

const log = message => console.log(`[csf-demo] ${message}`);
const firm = db.prepare(`SELECT id,name FROM firms ORDER BY id LIMIT 1`).get();
if (!firm) throw new Error('Create a consulting firm before seeding the CSF demo.');
const owner = db.prepare(`SELECT id,name FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY CASE firm_role WHEN 'manager' THEN 1 WHEN 'owner' THEN 2 ELSE 3 END,id LIMIT 1`).get(firm.id);
if (!owner) throw new Error('Create an active firm user before seeding the CSF demo.');

let workspace = db.prepare(`SELECT * FROM workspaces WHERE firm_id=? AND client_name='Acme Corp (CSF demo)'`).get(firm.id);
if (!workspace) {
  const id = Number(db.prepare(`INSERT INTO workspaces (firm_id,client_name,industry,scope,lead_consultant_id,frameworks)
    VALUES (?,'Acme Corp (CSF demo)','SaaS','Corporate governance and production SaaS services',?,'["csf"]')`).run(firm.id,owner.id).lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'firm_owner')`).run(id,owner.id);
  workspace = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(id);
}
let workspaceFrameworks=[];
try{workspaceFrameworks=JSON.parse(workspace.frameworks||'[]');}catch(_){workspaceFrameworks=[];}
const isoActivity = db.prepare(`SELECT
  (SELECT COUNT(*) FROM control_states WHERE workspace_id=?) +
  (SELECT COUNT(*) FROM iso42001_control_states WHERE workspace_id=?) c`).get(workspace.id,workspace.id).c;
if(isoActivity===0 && (workspaceFrameworks.length!==1 || workspaceFrameworks[0]!=='csf')){
  workspaceFrameworks=['csf'];
  db.prepare(`UPDATE workspaces SET frameworks=? WHERE id=?`).run(JSON.stringify(workspaceFrameworks),workspace.id);
  workspace={...workspace,frameworks:JSON.stringify(workspaceFrameworks)};
}

const engagementName = 'FY27 enterprise cybersecurity maturity baseline';
let engagement = db.prepare(`SELECT * FROM csf_engagements WHERE workspace_id=? AND name=? AND deleted_at IS NULL`).get(workspace.id,engagementName);
if (engagement) {
  log(`Dataset already exists at /workspaces/${workspace.id}/csf/${engagement.id}/scope`);
  process.exit(0);
}

const today = new Date().toISOString().slice(0,10);
const prior = new Date(Date.now()-180*86400000).toISOString().slice(0,10);
const target = new Date(Date.now()+120*86400000).toISOString().slice(0,10);
const engagementId = Number(db.prepare(`INSERT INTO csf_engagements
  (workspace_id,catalog_version,name,period_start,period_end,target_completion_date,scope_mode,status,assigned_lead_id,created_by)
  VALUES (?,'2.0',?,?,?,?, 'CURRENT_TARGET','Draft',?,?)`).run(workspace.id,engagementName,prior,today,target,owner.id,owner.id).lastInsertRowid);
engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=?`).get(engagementId);
db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments (engagement_id,user_id,role_on_engagement,assigned_by) VALUES (?,?,'ENGAGEMENT_LEAD',?)`).run(engagementId,owner.id,owner.id);

const profile = {
  business_context:'Acme is a cloud software provider serving regulated mid-market customers in North America and Europe through a multi-tenant production platform.',
  mission_objectives:'Protect service availability, customer trust, contractual commitments, product delivery, and the ability to scale the platform without unmanaged cybersecurity risk.',
  critical_services:'Customer authentication, tenant processing, support operations, billing, security monitoring, incident response, and recovery of the production control plane.',
  critical_assets_data:'Production cloud accounts, source repositories, CI/CD services, identity platforms, customer data, cryptographic secrets, laptops, and critical SaaS suppliers.',
  threat_landscape:'Material scenarios include credential theft, cloud misconfiguration, software supply-chain compromise, ransomware, insider misuse, data exfiltration, and availability attacks.',
  legal_contractual_requirements:'The scope includes privacy obligations, customer security schedules, incident-notification clauses, cyber-insurance conditions, and sector-specific customer expectations.',
  stakeholder_expectations:'Leadership, customers, regulators, employees, partners, and insurers expect risk decisions, operating evidence, exceptions, incidents, and improvements to be traceable.',
  risk_appetite:'There is no tolerance for uncontrolled privileged access, unencrypted customer data, untested tier-one recovery, or unaccepted critical risk beyond agreed escalation periods.',
  scope_statement:'The assessment covers corporate governance and the production SaaS service, including supporting people, cloud technology, customer data, and critical third parties.',
  assessment_limitations:'This is an advisory maturity assessment using representative samples. It excludes penetration testing, source-code review, financial controls, and legal opinion.',
};
db.prepare(`INSERT INTO csf_profile_contexts
  (engagement_id,workspace_id,business_context,mission_objectives,critical_services,critical_assets_data,threat_landscape,
   legal_contractual_requirements,stakeholder_expectations,risk_appetite,scope_statement,assessment_limitations,community_profile_reference,
   methodology_version,status,prepared_by,submitted_by,submitted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'submitted',?,?,CURRENT_TIMESTAMP)`).run(engagementId,workspace.id,profile.business_context,profile.mission_objectives,
    profile.critical_services,profile.critical_assets_data,profile.threat_landscape,profile.legal_contractual_requirements,profile.stakeholder_expectations,
    profile.risk_appetite,profile.scope_statement,profile.assessment_limitations,'NIST CSF 2.0 Small Business Quick-Start Guide (context reference only)',
    methodology.METHODOLOGY_VERSION,owner.id,owner.id);

csf.ensureAssessmentRows(db,engagement);
const outcomes = db.prepare(`SELECT a.id assessment_id,a.subcategory_id,s.code,s.description,c.name category_name,f.name function_name
  FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id
  JOIN csf_categories c ON c.id=s.category_id JOIN csf_functions f ON f.id=c.function_id
  WHERE a.engagement_id=? ORDER BY f.display_order,c.display_order,s.display_order`).all(engagementId);

const pattern = [[3,2],[2,2],[3,3],[2,1],[4,2],[1,2],[3,2],[2,3],[4,4],[2,2],[3,3],[1,1]];
const evidenceInsert = db.prepare(`INSERT INTO csf_evidence_items
  (assessment_id,type,url,description,uploaded_by,relevance_note,confidentiality,evidence_axis,evidence_quality,source_reliability,
   evidence_period_start,evidence_period_end,scope_coverage,testing_method)
  VALUES (?,'URL',?,?,?,?, 'internal',?,?,?,?,?,?,?)`);
const testInsert = db.prepare(`INSERT INTO csf_assessment_tests
  (workspace_id,engagement_id,assessment_id,test_code,axis,procedure_text,population_description,population_size,sample_size,sample_selection,result,exception_count,conclusion,performed_by,performed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,CURRENT_TIMESTAMP)`);

db.transaction(()=>outcomes.forEach((row,index)=>{
  const [policyScore,practiceScore] = pattern[index%pattern.length];
  const meetsApprovedTarget=index%4===0;
  const targetPolicy = meetsApprovedTarget?policyScore:Math.min(5,policyScore+1);
  const targetPractice = meetsApprovedTarget?practiceScore:Math.min(5,practiceScore+1);
  const policyRationale = `For ${row.code}, the assessment identified approved governance requirements, accountable ownership, defined review expectations, and retained change records across the stated scope. The selected Policy level ${policyScore} reflects the degree to which these requirements are institutionalized, communicated, governed, and supported by current evidence. Limitations and exceptions remain visible in the workpaper and have not been offset through averaging.`;
  const practiceRationale = `For ${row.code}, the team inspected operating records for the six-month assessment period, interviewed accountable personnel, and considered the consistency of execution across representative production and corporate samples. The selected Practice level ${practiceScore} reflects demonstrated implementation and effectiveness, not the existence of a policy alone. Exceptions, sample limitations, and evidence confidence are recorded separately.`;
  db.prepare(`UPDATE csf_subcategory_assessments SET applicability_status='in_scope',profile_priority=?,current_profile_statement=?,target_profile_statement=?,business_impact=?,
    policy_score=?,practice_score=?,target_policy_score=?,target_practice_score=?,policy_rationale=?,practice_rationale=?,policy_owner='Chief Information Security Officer',practice_owner='Security Operations and Technology Owners',
    assurance_outcome=?,effectiveness_conclusion=?,evidence_confidence=?,assessment_period_start=?,assessment_period_end=?,population_description=?,population_size=48,sample_size=12,
    sample_rationale=?,review_conclusion=?,methodology_version=?,policy_scored_by=?,practice_scored_by=?,status='Fieldwork',row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(Math.min(policyScore,practiceScore)<=1?'high':'medium',
      `Acme currently addresses ${row.code} through the governance and operating practices described in the retained workpaper and evidence manifest.`,
      `Acme targets a consistently governed and demonstrably effective ${row.code} outcome with measured performance and timely exception handling.`,
      `Failure to achieve ${row.code} could affect service resilience, customer trust, regulatory duties, contractual assurance, or the treatment of material cyber risk.`,
      policyScore,practiceScore,targetPolicy,targetPractice,policyRationale,practiceRationale,
      practiceScore>=3?'effective':'partially_effective',practiceScore>=3?'Testing indicates the sampled practice is generally effective, with any exceptions captured as findings.':'The outcome operates in parts of scope but consistency or retained evidence requires improvement.',
      Math.max(policyScore,practiceScore)>=4?'high':'medium',prior,today,`Monthly, quarterly, and event-driven records relevant to ${row.code} across production and corporate scope`,
      'Twelve records were selected across the period and key systems to cover routine, changed, and elevated-risk cases.',
      `Fieldwork conclusion prepared for independent review; evidence gates were applied separately to Policy and Practice for ${row.code}.`,methodology.METHODOLOGY_VERSION,owner.id,owner.id,owner.id,row.assessment_id);

  const addEvidence=(axis,number,quality)=>evidenceInsert.run(row.assessment_id,`https://evidence.acme.example/${row.code.toLowerCase()}/${axis}-${number}`,
    `${row.code} ${axis} evidence ${number}`,owner.id,`Retained ${axis} evidence supports the outcome-specific rationale, assessment period, ownership, scope, and selected maturity anchor.`,axis,quality,'high',prior,today,
    'Corporate governance and representative production services','Inspection and corroboration');
  const policyCount=policyScore>=3?2:policyScore>=2?1:0,practiceCount=practiceScore>=3?2:practiceScore>=2?1:0;
  for(let i=1;i<=policyCount;i++)addEvidence('policy',i,policyScore>=5&&i===1?'excellent':'good');
  for(let i=1;i<=practiceCount;i++)addEvidence('practice',i,practiceScore>=5&&i===1?'excellent':'good');
  const method=methodology.forCode(row.code);
  if(policyScore>=4)testInsert.run(workspace.id,engagementId,row.assessment_id,`${row.code}-T1`,'policy',method.test_procedures[0],`Controlled population relevant to ${row.code}`,48,12,'Risk-based and representative','pass',`Policy governance criteria were met in the selected sample for ${row.code}.`,owner.id);
  if(practiceScore>=4)testInsert.run(workspace.id,engagementId,row.assessment_id,`${row.code}-T2`,'practice',method.test_procedures[1],`Operating records relevant to ${row.code}`,48,12,'Risk-based and representative','pass',`Practice effectiveness criteria were met in the selected sample for ${row.code}.`,owner.id);
}))();

const themes=[
  ['GV.OC-01','Mission and material cyber-risk decisions are not consistently connected','Governance records identify compliance activities, but sampled strategy and investment decisions do not consistently show how mission objectives, risk appetite, customer impact, and cyber-risk trade-offs informed the decision.','HIGH','Add an explicit cyber-risk and mission-impact decision record to quarterly strategy, investment, and material-change governance.','M','HIGH','0_3M'],
  ['GV.SC-07','Critical supplier assurance is not driven by service dependency','Supplier reviews are performed, but the assessment depth and reassessment cadence are not consistently tied to service criticality, concentration, data access, and recovery dependency.','HIGH','Introduce dependency-led supplier tiers with minimum due-diligence, monitoring, resilience, and exit requirements for each tier.','L','HIGH','0_3M'],
  ['PR.AA-05','Privileged access evidence does not demonstrate consistent recertification','Access standards are defined, but sampled privileged accounts did not consistently retain evidence of business ownership, periodic recertification, and timely removal across the full production scope.','HIGH','Establish a single privileged-access recertification standard, evidence pack, exception route, and quarterly management attestation.','M','HIGH','0_3M'],
  ['DE.CM-01','Detection coverage is not traceable to material threat scenarios','Monitoring is active across core platforms, but detection use cases are not consistently mapped to the approved threat landscape, critical services, ownership, test results, and residual blind spots.','MEDIUM','Create a threat-led detection coverage model and quarterly control-room review of use-case testing, blind spots, and improvement decisions.','L','MED','3_6M'],
  ['RS.MA-02','Incident decision authority is not consistently exercised in simulations','The incident plan defines escalation roles, but exercises do not consistently demonstrate declaration thresholds, executive decisions, third-party coordination, and evidence preservation under realistic pressure.','MEDIUM','Run scenario-based exercises for the most material incidents and retain timed decisions, communications, exceptions, and lessons through closure.','M','MED','3_6M'],
  ['RC.RP-03','Recovery assurance is stronger for infrastructure than end-to-end services','Backup and platform recovery tests are performed, but the evidence does not consistently demonstrate application, identity, data, supplier, and business-process recovery as one service.','HIGH','Establish tier-one service recovery tests with integrity checks, business acceptance criteria, supplier participation, and governed remediation of failed objectives.','L','HIGH','6_12M'],
];
const insertFinding=db.prepare(`INSERT INTO csf_findings
  (engagement_id,assessment_id,title,description,severity,status,created_by) VALUES (?,?,?,?,?,'Draft',?)`);
const insertRecommendation=db.prepare(`INSERT INTO csf_recommendations
  (finding_id,description,estimated_effort,priority,roadmap_phase,created_by) VALUES (?,?,?,?,?,?)`);
db.transaction(()=>themes.forEach((theme,index)=>{
  const [code,title,description,severity,recommendation,effort,priority,phase]=theme;
  const outcome=outcomes.find(o=>o.code===code)||outcomes[index];
  const findingId=Number(insertFinding.run(engagementId,outcome.assessment_id,title,description,severity,owner.id).lastInsertRowid);
  insertRecommendation.run(findingId,recommendation,effort,priority,phase,owner.id);
}))();

log(`Created 6 Functions, 22 Categories, and ${outcomes.length} dual-axis outcome workpapers.`);
log(`Evidence quality, sampling, direct tests, target gaps, and ${themes.length} investment themes are populated; conclusions intentionally remain in Fieldwork.`);
log(`Open: /workspaces/${workspace.id}/csf`);
