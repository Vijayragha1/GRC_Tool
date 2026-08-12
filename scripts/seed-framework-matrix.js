#!/usr/bin/env node
'use strict';

// Creates a complete seven-client framework matrix for product demonstrations.
// The script is idempotent: only clients with the exact DEMO_NAMES below are
// replaced. Existing client workspaces are never touched.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db, init, ensureWorkspaceMethodology, logAction } = require('../db');
const csfModel = require('../lib/csf-policy-practice');
const csfMethodology = require('../data/nist-csf-policy-practice');

init();

const day = 86400000;
const date = offset => new Date(Date.now() + offset * day).toISOString().slice(0, 10);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

const SCENARIOS = [
  {
    key: '27001', name: 'Northstar Health — ISO 27001', short: 'Northstar Health',
    frameworks: ['iso27001'], industry: 'Healthcare technology', sector: 'healthcare', color: '#315C73',
    scope: 'The patient engagement platform, supporting cloud infrastructure, corporate identity services, engineering operations, customer support and the personnel who operate them.',
  },
  {
    key: '42001', name: 'Vector AI Labs — ISO 42001', short: 'Vector AI Labs',
    frameworks: ['iso42001'], industry: 'Artificial intelligence software', sector: 'technology', color: '#665687',
    scope: 'The design, development, evaluation, deployment and monitoring of enterprise AI assistants, including training data, model providers, human oversight and production operations.',
  },
  {
    key: 'csf', name: 'Harbor Retail — NIST CSF 2.0', short: 'Harbor Retail',
    frameworks: ['csf'], industry: 'Omnichannel retail', sector: 'retail', color: '#24717A',
    scope: 'Customer-facing commerce, payment integrations, corporate technology, distribution operations and critical third parties across the United Kingdom and European Union.',
  },
  {
    key: 'csf-42001', name: 'Quantive Systems — CSF + ISO 42001', short: 'Quantive Systems',
    frameworks: ['csf', 'iso42001'], industry: 'Enterprise analytics', sector: 'technology', color: '#4F6578',
    scope: 'The enterprise analytics platform, embedded AI services, customer data processing, cybersecurity operations, cloud infrastructure and the AI governance lifecycle.',
  },
  {
    key: 'csf-27001', name: 'Meridian Payments — CSF + ISO 27001', short: 'Meridian Payments',
    frameworks: ['csf', 'iso27001'], industry: 'Financial technology', sector: 'financial', color: '#254E70',
    scope: 'Payment orchestration, customer onboarding, fraud operations, cloud production, corporate systems and the security functions supporting regulated payment services.',
  },
  {
    key: '27001-42001', name: 'Atlas Cloud Services — ISO 27001 + ISO 42001', short: 'Atlas Cloud',
    frameworks: ['iso27001', 'iso42001'], industry: 'Cloud managed services', sector: 'technology', color: '#456A5E',
    scope: 'Managed cloud operations and AI-assisted service management, including customer environments, privileged administration, service desk, AI-enabled automation and supporting suppliers.',
  },
  {
    key: 'all', name: 'Pioneer Digital Group — Integrated Assurance', short: 'Pioneer Digital',
    frameworks: ['iso27001', 'iso42001', 'csf'], industry: 'Digital services group', sector: 'technology', color: '#3D5366',
    scope: 'Group cybersecurity governance, the customer digital platform, shared cloud and identity services, enterprise AI capabilities, security operations and critical supplier dependencies.',
  },
];

const firm = db.prepare(`SELECT id,name FROM firms ORDER BY id LIMIT 1`).get();
if (!firm) throw new Error('No consulting firm exists. Start the application once before running this seeder.');
const owner = db.prepare(`SELECT id,name,email FROM users
  WHERE firm_id=? AND user_type='firm' AND active=1
  ORDER BY CASE firm_role WHEN 'manager' THEN 1 WHEN 'owner' THEN 2 ELSE 3 END,id LIMIT 1`).get(firm.id);
if (!owner) throw new Error('No active consulting manager exists for the firm.');

function ensureClientUser(scenario) {
  const email = `client.${scenario.key}@demo.invalid`;
  const passwordHash = bcrypt.hashSync('DemoClient!2026', 10);
  const existing = db.prepare(`SELECT id FROM users WHERE email=?`).get(email);
  if (existing) {
    db.prepare(`UPDATE users SET name=?,password_hash=?,user_type='client',firm_id=NULL,firm_role=NULL,active=1 WHERE id=?`)
      .run(`${scenario.short} Client Owner`, passwordHash, existing.id);
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'client',NULL,NULL,1)`).run(email, passwordHash, `${scenario.short} Client Owner`).lastInsertRowid);
}

function removePriorDemo(scenario) {
  const prior = db.prepare(`SELECT id FROM workspaces WHERE firm_id=? AND client_name=?`).get(firm.id, scenario.name);
  if (!prior) return;
  // Audit rows intentionally sit outside the workspace cascade in some schema
  // generations. Delete only those belonging to this named demo workspace.
  db.prepare(`DELETE FROM audit_log WHERE workspace_id=?`).run(prior.id);
  db.prepare(`DELETE FROM workspaces WHERE id=?`).run(prior.id);
}

function createWorkspace(scenario, clientUserId) {
  const id = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,target_cert_date,stage,lead_consultant_id,
     scope_confirmed_at,scope_confirmed_by,brand_display_name,brand_primary_color,sector,locale,frameworks)
    VALUES (?,?,?,?,?,'implementation',?,CURRENT_TIMESTAMP,?,?,?,?,'en-GB',?)`)
    .run(firm.id, scenario.name, scenario.industry, scenario.scope, date(210), owner.id,
      owner.id, scenario.short, scenario.color, scenario.sector, JSON.stringify(scenario.frameworks)).lastInsertRowid);
  ensureWorkspaceMethodology(id);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'firm_owner')`).run(id, owner.id);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'client_owner')`).run(id, clientUserId);
  return id;
}

function seedIntake(wsId, scenario) {
  const answers = {
    'org-name': scenario.name.replace(/ — .*/, ' Ltd.'), 'trading-name': scenario.short,
    'business-summary': `${scenario.short} provides ${scenario.industry.toLowerCase()} services to regulated and security-conscious customers.`,
    'cert-driver': 'Customer assurance, board oversight and a repeatable risk-based operating model.',
    'cert-deadline': date(210), 'products-in-scope': scenario.scope, 'products-excluded': 'Public marketing content and dormant legal entities with no operational systems.',
    'infra-model': 'Cloud-dominant (mostly cloud, some on-prem)', 'physical-locations': 'London office\nRemote workforce',
    'onprem-footprint': 'Office networking and managed employee endpoints only; production workloads are cloud hosted.',
    'remote-workers': '86', 'cloud-providers': 'Microsoft Azure\nMicrosoft 365\nGitHub\nCloudflare',
    'data-types': 'Customer confidential information, personal data, operational telemetry and intellectual property.',
    'customer-geography': 'United Kingdom, European Union and North America', 'headcount-total': '184',
    'isms-owner': 'Chief Information Security Officer', 'isms-coordinator': 'Governance, Risk and Compliance Manager',
    'isac-frequency': 'Monthly, with quarterly executive reporting',
    'key-customers': 'Regulated enterprise customers requiring annual assurance and contractual security reporting.',
    'key-regulators': 'UK ICO and applicable sector supervisory authorities',
    'key-suppliers': 'Microsoft Azure\nMicrosoft 365\nGitHub\nCloudflare',
    'crown-jewel-1': 'Customer production data and tenant encryption keys',
    'crown-jewel-2': 'Production cloud subscriptions and privileged identities',
    'crown-jewel-3': 'Source code, build pipelines and signed deployment artifacts',
    'existing-frameworks': scenario.frameworks.join(', '), 'existing-policies': '18',
    'recent-incidents': 'One contained credential-phishing event with no confirmed data loss; lessons were tracked through closure.',
  };
  const insert = db.prepare(`INSERT INTO engagement_intake (workspace_id,question_id,answer,answered_by) VALUES (?,?,?,?)`);
  Object.entries(answers).forEach(([questionId, answer]) => insert.run(wsId, questionId, answer, owner.id));
}

function seedOperatingRegisters(wsId, scenario) {
  const assets = [
    ['Customer production platform','service','restricted','Chief Technology Officer',3,3,3,'Tier-one customer service and supporting APIs.','critical',2,1],
    ['Customer and account data','information','restricted','Data Protection Officer',3,3,2,'Customer records, account data and contractual metadata.','critical',4,1],
    ['Cloud production environment','service','confidential','Head of Platform',3,3,3,'Cloud subscriptions, networks, compute, storage and managed databases.','critical',2,1],
    ['Enterprise identity platform','service','confidential','IT Director',3,3,3,'Workforce SSO, privileged access and lifecycle automation.','critical',4,1],
    ['Source code and CI/CD','service','confidential','VP Engineering',3,3,2,'Source repositories, build pipelines and deployment credentials.','high',8,2],
    ['Security monitoring platform','service','confidential','Security Operations Lead',2,3,3,'Central security telemetry, alerting and response workflow.','high',4,1],
  ];
  const assetInsert = db.prepare(`INSERT INTO assets
    (workspace_id,name,type,classification,owner_name,cia_c,cia_i,cia_a,description,business_criticality,rto_hours,rpo_hours,bia_notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const assetIds = {};
  assets.forEach(a => { assetIds[a[0]] = Number(assetInsert.run(wsId, ...a, 'Recovery objectives approved by the service owner and exercised annually.').lastInsertRowid); });

  const risks = [
    ['Privileged identity compromise','Stolen privileged credentials could permit unauthorised production changes.','Enterprise identity platform','Credential theft','Inconsistent phishing-resistant MFA coverage',4,5,'modify','CISO','open',2,4],
    ['Cloud configuration exposure','A material cloud misconfiguration could expose customer data.','Cloud production environment','Misconfiguration','Preventive guardrails do not cover every inherited environment',3,5,'modify','Head of Platform','open',2,3],
    ['Software supply-chain compromise','A compromised dependency or build credential could introduce malicious code.','Source code and CI/CD','Supply-chain attack','Uneven provenance and signing coverage',3,5,'modify','VP Engineering','open',2,3],
    ['Critical supplier outage','A concentration failure could interrupt customer services beyond agreed objectives.','Customer production platform','Supplier service failure','Limited tested exit options for tier-one services',3,4,'modify','COO','open',2,3],
    ['Delayed incident escalation','Material incidents may not reach decision-makers within contractual timelines.','Security monitoring platform','Complex attack','Escalation criteria are not consistently exercised',3,4,'modify','Security Operations Lead','open',2,2],
    ['Sensitive data over-retention','Customer records may be retained beyond approved business and legal periods.','Customer and account data','Internal misuse','Legacy deletion jobs do not cover every store',3,4,'modify','Data Protection Officer','open',2,2],
  ];
  const riskInsert = db.prepare(`INSERT INTO risks
    (workspace_id,title,description,asset_id,threat,vulnerability,likelihood,impact,treatment,owner_name,status,residual_likelihood,residual_impact,is_systemic)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const riskIds = [];
  risks.forEach((r, i) => riskIds.push(Number(riskInsert.run(wsId,r[0],r[1],assetIds[r[2]],...r.slice(3),i<3?1:0).lastInsertRowid)));

  const taskInsert = db.prepare(`INSERT INTO tasks
    (workspace_id,title,description,risk_id,assignee_id,due_date,status,created_by,priority,estimated_minutes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  [
    ['Complete privileged-access recertification','Validate owners and retain evidence for all production privileged roles.',0,21,'in_progress','high',240],
    ['Approve the assessment boundary','Confirm services, legal entities, locations and material exclusions.',null,-3,'done','high',90],
    ['Test tier-one service recovery','Exercise application, identity, data and supplier recovery as one service.',3,42,'todo','high',480],
    ['Review critical supplier assurance','Update due diligence and concentration-risk decisions for tier-one suppliers.',3,28,'in_progress','medium',180],
    ['Close cloud guardrail exceptions','Resolve or accept ageing preventive-control exceptions.',1,35,'todo','high',300],
    ['Run incident decision exercise','Test declaration, legal notification and executive decision authority.',4,56,'todo','medium',240],
    ['Refresh retention schedule','Map data stores to approved retention and deletion controls.',5,49,'todo','medium',210],
    ['Prepare steering committee pack','Summarise progress, overdue risks, evidence gaps and decisions required.',null,14,'done','medium',120],
  ].forEach(t => taskInsert.run(wsId,t[0],t[1],t[2]===null?null:riskIds[t[2]],owner.id,date(t[3]),t[4],owner.id,t[5],t[6]));

  const supplierInsert = db.prepare(`INSERT INTO suppliers
    (workspace_id,name,service_provided,tier,data_access,contract_start,contract_end,next_review_date,attestations,contact,notes,status,last_assessed,
     lifecycle_stage,inherent_risk_score,residual_risk_score,business_criticality,data_volume,industry,location,regulatory_exposure,dependency_type,annual_spend,
     renewal_notice_days,auto_renew,approved_by,approved_at,website,relationship_owner,business_owner,security_reviewer,service_category,processing_purpose,
     data_categories,hosting_locations,critical_processes,system_access,rto_hours,rpo_hours,exit_strategy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  [
    ['Microsoft Azure','Production cloud hosting','tier_1','restricted',87,28,'critical','high','Cloud services','Ireland / Netherlands','GDPR; customer security schedules','technology','£420,000','https://azure.microsoft.com','Head of Platform',2,1,'Cross-region recovery and an annually reviewed portability plan.'],
    ['GitHub','Source code and CI/CD','tier_1','confidential',76,24,'high','medium','Software services','United States / EU','Customer contractual requirements','technology','£84,000','https://github.com','VP Engineering',8,2,'Repository mirrors and documented export procedures.'],
    ['PeopleCore','HR information system','tier_2','confidential',61,19,'medium','medium','Business software','European Union','GDPR','saas','£26,000','https://example.invalid','People Director',24,8,'Structured export with replacement options reviewed before renewal.'],
  ].forEach((s, index) => supplierInsert.run(wsId,s[0],s[1],s[2],s[3],date(-500),date(230+index*40),date(75+index*25),'ISO 27001; SOC 2 Type II',`assurance@${s[0].toLowerCase().replace(/[^a-z]+/g,'')}.example`,
    'Synthetic supplier record for product demonstration.','active',date(-55-index*20),'monitoring',s[4],s[5],s[6],s[7],s[8],s[9],s[10],s[11],s[12],90,1,owner.name,new Date().toISOString().slice(0,19).replace('T',' '),s[13],s[14],s[14],owner.name,'Technology service','Delivery of contracted business and technology services','Customer and corporate information',s[9],'Production operations',s[3],s[15],s[16],s[17]));

  const partyInsert = db.prepare(`INSERT INTO interested_parties
    (workspace_id,party,party_type,needs,how_addressed,owner,review_cadence,last_reviewed,next_review,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  [
    ['Board and executive committee','internal','Reliable risk position, material exceptions and investment decisions','Quarterly cyber-risk reporting and approval gates','CISO','Quarterly'],
    ['Enterprise customers','customer','Contractual controls, service resilience and timely incident notification','Assurance pack, security schedules and incident playbooks','Chief Customer Officer','Quarterly'],
    ['Supervisory authorities','regulator','Compliance with privacy and applicable sector obligations','Legal register, control mapping and breach assessment process','General Counsel','Semi-annual'],
    ['Employees and contractors','workforce','Clear responsibilities, secure tools and fair monitoring','Policy communication, role training and reporting channels','People Director','Annual'],
  ].forEach(p => partyInsert.run(wsId,...p,date(-45),date(45),'Needs and response reviewed during the latest governance cycle.'));

  const objectiveInsert = db.prepare(`INSERT INTO security_objectives
    (workspace_id,title,description,measurement,target_value,current_value,owner,due_date,status,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  [
    ['Close critical control gaps','Resolve critical evidence and implementation gaps within the approved treatment period.','Percentage closed within SLA','≥ 95%','82%','CISO',date(120),'at_risk'],
    ['Exercise tier-one recovery','Demonstrate service recovery within approved business objectives.','Tier-one services exercised','100%','67%','COO',date(150),'on_track'],
    ['Improve privileged-access assurance','Complete quarterly ownership and necessity recertification.','Privileged roles recertified','100%','91%','IT Director',date(60),'on_track'],
  ].forEach(o => objectiveInsert.run(wsId,...o,'Tracked through monthly governance and quarterly executive review.'));

  const auditId = Number(db.prepare(`INSERT INTO audits
    (workspace_id,title,scope,audit_date,auditor_name,status,summary,created_by,auditor_competence,auditor_independence,sample_size,population_size,lifecycle_stage,
     fieldwork_started_at,report_issued_at,closed_at,sampling_justification)
    VALUES (?,?,?,?,?,'completed',?,?,?, ?,12,64,'closed',datetime('now','-48 days'),datetime('now','-28 days'),datetime('now','-20 days'),?)`)
    .run(wsId,'Internal assurance review — governance and operations',scenario.scope,date(-50),'Independent Internal Auditor',
      'The control environment is operating, with improvement required in privileged access evidence and supplier dependency assurance.',owner.id,
      'ISO management-system lead auditor and experienced technology assurance practitioner.','The auditor had no operational responsibility for the sampled controls.',
      'Risk-based sample across the period, critical services and accountable owners.').lastInsertRowid);
  const findingInsert = db.prepare(`INSERT INTO audit_findings (audit_id,finding_type,description,severity,status) VALUES (?,?,?,?,?)`);
  findingInsert.run(auditId,'minor_nc','Two privileged roles lacked retained evidence of timely owner recertification.','medium','open');
  findingInsert.run(auditId,'observation','Supplier recovery dependencies were documented but not exercised end to end.','medium','open');

  const ncInsert = db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,description,severity,root_cause,corrective_action,responsible,due_date,effectiveness_check,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ncInsert.run(wsId,'Privileged-access recertification evidence incomplete','Internal audit',`AUD-${auditId}`,'Two sampled privileged roles lacked retained approval evidence.','minor',
    'The recertification workflow did not require a durable approval artifact.','Update the workflow, recertify the affected roles and sample the next cycle.','IT Director',date(35),'Independent resample of the next completed cycle.','in_progress');
  ncInsert.run(wsId,'Supplier recovery dependency not exercised','Management review','MRM-Q2','Tier-one recovery testing did not include a material upstream dependency.','minor',
    'The service test plan focused on internal technical components.','Add supplier participation and business acceptance criteria to the next exercise.','COO',date(80),'Observe the exercise and confirm objectives were met.','open');

  db.prepare(`INSERT INTO incidents
    (workspace_id,title,category,severity,detected_at,reported_by,status,description,affected_assets,containment_actions,eradication_actions,recovery_actions,lessons_learned,external_notification,closed_at)
    VALUES (?,?,?,'medium',datetime('now','-95 days'),?,'closed',?,?,?,?,?,?,'Not required after legal and privacy assessment.',datetime('now','-93 days'))`)
    .run(wsId,'Contained workforce credential-phishing event','phishing','Security Operations','A workforce account accepted a phishing prompt; conditional access prevented production access.',
      'Enterprise identity platform','Session revoked, account reset and elevated monitoring applied.','Malicious inbox rules removed and indicators blocked.','User access restored after verification.','Expand phishing-resistant MFA and retain decision timestamps in the incident record.');

  db.prepare(`INSERT INTO mrms
    (workspace_id,meeting_date,attendees,status,context_changes,prior_actions_status,performance_review,feedback_interested_parties,risk_treatment_status,
     improvement_opportunities,decisions,action_items,created_by)
    VALUES (?,?,?,'completed',?,?,?,?,?,?,?,?,?)`).run(wsId,date(-32),'CEO, COO, CISO, CTO, General Counsel, GRC Manager',
      'Customer assurance requirements increased; no material scope change was approved.','Five of seven prior actions closed; two remain within the approved period.',
      'Control implementation is improving, with evidence quality uneven in privileged access and supplier resilience.','Customers requested clearer recovery assurance and notification decision records.',
      'No critical risks are outside appetite; three high risks remain under active treatment.','Automate evidence collection and align service recovery tests to supplier dependencies.',
      'Maintain the current scope and approve the next-quarter remediation priorities.','Complete privileged-access recertification, supplier assurance and the tier-one recovery exercise.',owner.id);
}

function frameworkRequirements(code) {
  return db.prepare(`SELECT r.* FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code=? ORDER BY r.sort_order,r.id`).all(code);
}

function seedFrameworkControls(wsId, code, scenarioIndex) {
  const requirements = frameworkRequirements(code);
  const insert = db.prepare(`INSERT INTO control_instances
    (workspace_id,requirement_id,entity_id,applicability,status,maturity,scope_pct,inclusion_justification,exclusion_justification,notes,internal_notes,owner_id,due_date,next_review,review_status,last_verified_at,migrated_from)
    VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  requirements.forEach((req, index) => {
    const excluded = req.req_type === 'control' && (index + scenarioIndex) % 29 === 0;
    const cycle = (index + scenarioIndex * 3) % 10;
    const status = excluded ? 'not_applicable' : cycle < 6 ? 'implemented' : cycle < 8 ? 'partially_implemented' : cycle === 8 ? 'work_in_progress' : 'not_assessed';
    const maturity = excluded ? 0 : status === 'implemented' ? (index % 4 === 0 ? 4 : 3) : status === 'partially_implemented' ? 2 : status === 'work_in_progress' ? 1 : 0;
    insert.run(wsId,req.id,excluded?'excluded':'applicable',status,maturity,excluded?0:100,
      excluded?null:`Applicable to the defined ${code === 'iso27001' ? 'information security' : 'AI management'} scope and linked risk treatment decisions.`,
      excluded?'The control is not relevant to the scoped technology or operating model; the exclusion is reviewed annually.':null,
      status === 'implemented'?'Implemented across the defined scope with retained operating evidence.':'Improvement activity and evidence requirements remain tracked in the delivery plan.',
      'Synthetic consultant workpaper note for demonstration.',owner.id,date(45 + index % 90),date(120 + index % 120),index % 9 === 0?'approved':'none',date(-(index % 120)),'framework-matrix-demo');
  });
  return requirements;
}

function seedDocumentsAndEvidence(wsId, scenario, frameworkCode, requirements) {
  const labels = frameworkCode === 'iso27001'
    ? ['Information Security Policy','Risk Assessment and Treatment Methodology','Access Control Standard','Incident Response Plan']
    : frameworkCode === 'iso42001'
      ? ['AI Management System Policy','AI Risk Assessment Procedure','Responsible AI Development Standard','AI Incident Management Plan']
      : ['Cybersecurity Governance Charter','Cyber Risk Assessment Standard','Incident Response Standard','Service Recovery Test Procedure'];
  const docInsert = db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,version,approved_by,approved_at,created_by,published_at,next_review_date,doc_kind,reference_code,controlled_copy)
    VALUES (?,?,?,?,'approved',1,?,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP,?,'policy',?,1)`);
  const versionInsert = db.prepare(`INSERT INTO doc_versions
    (workspace_id,document_id,version,name,content,content_hash,status,change_summary,created_by,submitted_at,approved_at,published_at)
    VALUES (?,?,1,?,?,?,'approved','Initial controlled demo version',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  const linkDoc = db.prepare(`INSERT INTO document_requirement_links (document_id,requirement_id,section_ref) VALUES (?,?,?)`);
  labels.forEach((label, docIndex) => {
    const content = `# ${label}\n\nOwner: Chief Information Security Officer\nApproved by: Executive Committee\nReview cycle: Annual\n\n## Purpose\nThis controlled document defines the governance, responsibilities, minimum requirements, records and exception process used by ${scenario.short}.\n\n## Scope\n${scenario.scope}\n\n## Requirements\nAccountable owners implement the requirements, retain proportionate evidence, monitor exceptions and report material matters through the approved governance route.\n\n## Assurance\nCompliance is assessed through management review, control testing, internal audit and tracked corrective action.`;
    const docId = Number(docInsert.run(wsId,label,frameworkCode,content,owner.id,owner.id,date(330),`${frameworkCode.toUpperCase()}-DOC-${docIndex+1}`).lastInsertRowid);
    versionInsert.run(wsId,docId,label,content,hash(`${wsId}:${frameworkCode}:${label}:${content}`),owner.id);
    requirements.slice(docIndex * 5, docIndex * 5 + 8).forEach((req, idx) => linkDoc.run(docId,req.id,`Section ${idx+1}`));
  });

  const evidenceInsert = db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description,valid_from,valid_until,period_label,tags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const linkEvidence = db.prepare(`INSERT INTO evidence_requirement_links (evidence_id,requirement_id,relevance_note,section_ref) VALUES (?,?,?,?)`);
  requirements.filter((_, index) => index % 4 === 0).slice(0,24).forEach((req, index) => {
    const filename = `${frameworkCode}-${String(index+1).padStart(2,'0')}-${req.ref.replace(/[^a-z0-9]+/gi,'-')}.pdf`;
    const evidenceId = Number(evidenceInsert.run(wsId,filename,`seed/framework-matrix/${scenario.key}/${filename}`,hash(filename),42000+index*713,owner.id,
      `Synthetic retained evidence supporting ${req.ref} ${req.title}.`,date(-180),date(185),'FY26 operating period',JSON.stringify([frameworkCode,'demo','controlled'])).lastInsertRowid);
    linkEvidence.run(evidenceId,req.id,'Demonstrates operation, ownership and review within the assessment period.',`Evidence item ${index+1}`);
  });
}

function seedCsf(wsId, scenario, scenarioIndex) {
  const engagementId = Number(db.prepare(`INSERT INTO csf_engagements
    (workspace_id,catalog_version,name,period_start,period_end,target_completion_date,scope_mode,status,assigned_lead_id,created_by)
    VALUES (?,'2.0',?,?,?,?, 'CURRENT_TARGET','In Progress',?,?)`)
    .run(wsId,`${scenario.short} cybersecurity maturity baseline`,date(-180),date(-1),date(120),owner.id,owner.id).lastInsertRowid);
  db.prepare(`INSERT INTO csf_engagement_assignments (engagement_id,user_id,role_on_engagement,assigned_by) VALUES (?,?,'ENGAGEMENT_LEAD',?)`)
    .run(engagementId,owner.id,owner.id);
  const engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=?`).get(engagementId);
  db.prepare(`INSERT INTO csf_profile_contexts
    (engagement_id,workspace_id,business_context,mission_objectives,critical_services,critical_assets_data,threat_landscape,legal_contractual_requirements,
     stakeholder_expectations,risk_appetite,scope_statement,assessment_limitations,community_profile_reference,methodology_version,status,prepared_by,submitted_by,submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'submitted',?,?,CURRENT_TIMESTAMP)`)
    .run(engagementId,wsId,
      `${scenario.short} is a ${scenario.industry.toLowerCase()} organisation serving regulated and security-conscious customers.`,
      'Protect customer trust, service availability, contractual commitments and the ability to make risk-informed technology investments.',
      'Customer authentication, production processing, security monitoring, incident response and recovery of tier-one services.',
      'Customer information, production cloud, identity services, source code, deployment pipelines and security telemetry.',
      'Material scenarios include identity compromise, cloud exposure, supply-chain attacks, ransomware, supplier failure and data exfiltration.',
      'Privacy requirements, customer security schedules, notification clauses and applicable sector obligations.',
      'Leadership, customers, regulators, employees and insurers expect traceable risk decisions, effective practices and timely improvement.',
      'No tolerance for uncontrolled privileged access, unencrypted customer data or untested tier-one recovery beyond approved escalation periods.',
      scenario.scope,
      'Advisory maturity assessment using representative samples; excludes penetration testing, source-code review, legal opinion and financial controls.',
      'NIST CSF 2.0 Organizational Profile',csfMethodology.METHODOLOGY_VERSION,owner.id,owner.id);

  csfModel.ensureAssessmentRows(db,engagement);
  const outcomes = db.prepare(`SELECT a.id assessment_id,s.code,s.description
    FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id
    JOIN csf_categories c ON c.id=s.category_id JOIN csf_functions f ON f.id=c.function_id
    WHERE a.engagement_id=? ORDER BY f.display_order,c.display_order,s.display_order`).all(engagementId);
  const patterns = [[3,2],[2,2],[3,3],[2,1],[4,3],[1,2],[3,2],[2,3]];
  const update = db.prepare(`UPDATE csf_subcategory_assessments SET
    applicability_status='in_scope',profile_priority=?,current_profile_statement=?,target_profile_statement=?,business_impact=?,policy_score=?,practice_score=?,
    target_policy_score=?,target_practice_score=?,policy_rationale=?,practice_rationale=?,policy_owner='Chief Information Security Officer',
    practice_owner='Technology and Security Operations',assurance_outcome=?,effectiveness_conclusion=?,evidence_confidence=?,assessment_period_start=?,
    assessment_period_end=?,population_description=?,population_size=48,sample_size=12,sample_rationale=?,review_conclusion=?,methodology_version=?,
    policy_scored_by=?,practice_scored_by=?,status='Assessor Complete',row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP WHERE id=?`);
  const evidenceInsert = db.prepare(`INSERT INTO csf_evidence_items
    (assessment_id,type,url,description,uploaded_by,relevance_note,confidentiality,evidence_axis,evidence_quality,source_reliability,
     evidence_period_start,evidence_period_end,scope_coverage,testing_method)
    VALUES (?,'URL',?,?,?,?, 'internal',?,?,?,?,?,?,?)`);
  const testInsert = db.prepare(`INSERT INTO csf_assessment_tests
    (workspace_id,engagement_id,assessment_id,test_code,axis,procedure_text,population_description,population_size,sample_size,sample_selection,result,
     exception_count,conclusion,performed_by,performed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,CURRENT_TIMESTAMP)`);
  outcomes.forEach((outcome, index) => {
    const [policyScore,practiceScore] = patterns[(index + scenarioIndex) % patterns.length];
    const targetPolicy = Math.min(5, Math.max(3, policyScore + (index % 4 ? 1 : 0)));
    const targetPractice = Math.min(5, Math.max(3, practiceScore + (index % 3 ? 1 : 0)));
    const policyRationale = `For ${outcome.code}, the assessment inspected approved governance requirements, accountable ownership, review expectations, exceptions and retained change records across the defined scope. The selected Policy level ${policyScore} reflects the extent to which requirements are documented, communicated and governed. Limitations remain explicit and have not been offset through averaging or unsupported assumptions.`;
    const practiceRationale = `For ${outcome.code}, the team inspected operating records from the six-month assessment period, interviewed accountable personnel and considered execution across representative production and corporate samples. The selected Practice level ${practiceScore} reflects demonstrated implementation and effectiveness rather than policy existence alone. Exceptions, sampling limits and confidence are recorded separately.`;
    update.run(Math.min(policyScore,practiceScore)<=1?'high':'medium',
      `${scenario.short} currently addresses ${outcome.code} through the retained governance and operating records described in this workpaper.`,
      `${scenario.short} targets a consistently governed and demonstrably effective ${outcome.code} outcome with measured performance and timely exception handling.`,
      `Failure to achieve ${outcome.code} could affect service resilience, customer trust, regulatory duties, contractual assurance or material cyber-risk treatment.`,
      policyScore,practiceScore,targetPolicy,targetPractice,policyRationale,practiceRationale,
      practiceScore>=3?'effective':'partially_effective',practiceScore>=3?'The representative sample indicates the practice is generally effective, with exceptions tracked separately.':'The practice operates in part of the scope but consistency or retained evidence requires improvement.',
      policyScore>=4||practiceScore>=4?'high':'medium',date(-180),date(-1),`Monthly, quarterly and event-driven records relevant to ${outcome.code} across production and corporate scope`,
      'Twelve records were selected across the assessment period and material systems to cover routine, changed and elevated-risk cases.',
      `Assessor conclusion prepared for independent review; Policy and Practice evidence gates were applied separately for ${outcome.code}.`,
      csfMethodology.METHODOLOGY_VERSION,owner.id,owner.id,owner.id,outcome.assessment_id);
    const addEvidence = (axis, number, quality) => evidenceInsert.run(outcome.assessment_id,
      `https://evidence.demo.invalid/${scenario.key}/${outcome.code.toLowerCase()}/${axis}-${number}`,
      `${outcome.code} ${axis} evidence ${number}`,owner.id,
      `Retained ${axis} evidence supports the outcome rationale, assessment period, ownership, scope and selected maturity anchor.`,
      axis,quality,'high',date(-180),date(-1),scenario.scope,'Inspection and corroboration');
    const policyCount = policyScore >= 3 ? 2 : 1;
    const practiceCount = practiceScore >= 3 ? 2 : 1;
    for (let i=1; i<=policyCount; i++) addEvidence('policy',i,policyScore>=4&&i===1?'excellent':'good');
    for (let i=1; i<=practiceCount; i++) addEvidence('practice',i,practiceScore>=4&&i===1?'excellent':'good');
    if (policyScore >= 4 || practiceScore >= 4) {
      const method = csfMethodology.forCode(outcome.code);
      const axis = policyScore >= 4 ? 'policy' : 'practice';
      testInsert.run(wsId,engagementId,outcome.assessment_id,`${outcome.code}-T1`,axis,method.test_procedures[0],
        `Controlled population relevant to ${outcome.code}`,48,12,'Risk-based representative sample','pass',
        `The selected sample met the defined ${axis} criteria for ${outcome.code}.`,owner.id);
    }
  });

  const findings = [
    ['GV.SC-07','Supplier assurance does not fully reflect service dependency','Critical supplier assessment depth and reassessment cadence are not consistently tied to service dependency, concentration, data access and recovery reliance.','HIGH','Introduce dependency-led supplier tiers and minimum assurance requirements.','0_3M'],
    ['PR.AA-05','Privileged-access evidence is incomplete','Sampled privileged roles did not consistently retain evidence of ownership, periodic recertification and timely removal.','HIGH','Establish one recertification standard and a quarterly management attestation.','0_3M'],
    ['DE.CM-01','Detection coverage is not traceable to material threats','Monitoring use cases are not consistently mapped to the approved threat landscape, test results and residual blind spots.','MEDIUM','Create a threat-led detection coverage model and quarterly review.','3_6M'],
    ['RS.MA-02','Incident decision authority needs further exercise','Exercises did not consistently demonstrate declaration thresholds, executive decisions and third-party coordination under realistic pressure.','MEDIUM','Run scenario-based exercises and retain timed decisions through closure.','3_6M'],
    ['RC.RP-03','Recovery assurance is not end-to-end','Technical recovery tests do not yet demonstrate application, identity, data, supplier and business-process recovery as one service.','HIGH','Establish tier-one service recovery tests with business acceptance criteria.','6_12M'],
  ];
  const findingInsert = db.prepare(`INSERT INTO csf_findings (engagement_id,assessment_id,title,description,severity,status,created_by)
    VALUES (?,?,?,?,?,'Draft',?)`);
  const recInsert = db.prepare(`INSERT INTO csf_recommendations (finding_id,description,estimated_effort,priority,target_completion_date,roadmap_phase,created_by)
    VALUES (?,?,?,'HIGH',?,?,?)`);
  findings.forEach((f, index) => {
    const assessment = outcomes.find(o => o.code === f[0]) || outcomes[index];
    const findingId = Number(findingInsert.run(engagementId,assessment.assessment_id,f[1],f[2],f[3],owner.id).lastInsertRowid);
    recInsert.run(findingId,f[4],index % 2 ? 'M' : 'L',date(60 + index*45),f[5],owner.id);
  });
}

const created = db.transaction(() => {
  const results = [];
  SCENARIOS.forEach((scenario, scenarioIndex) => {
    removePriorDemo(scenario);
    const clientUserId = ensureClientUser(scenario);
    const wsId = createWorkspace(scenario, clientUserId);
    seedIntake(wsId, scenario);
    seedOperatingRegisters(wsId, scenario);
    for (const framework of scenario.frameworks) {
      if (framework === 'iso27001' || framework === 'iso42001') {
        const requirements = seedFrameworkControls(wsId, framework, scenarioIndex);
        seedDocumentsAndEvidence(wsId, scenario, framework, requirements);
      } else if (framework === 'csf') {
        const csfRequirements = frameworkRequirements('csf');
        seedDocumentsAndEvidence(wsId, scenario, 'csf', csfRequirements);
        seedCsf(wsId, scenario, scenarioIndex);
      }
    }
    results.push({ id: wsId, name: scenario.name, frameworks: scenario.frameworks, clientEmail: `client.${scenario.key}@demo.invalid` });
  });
  return results;
})();

created.forEach(result => logAction(owner.id,result.id,'seed_framework_matrix','workspace',result.id,{frameworks:result.frameworks,synthetic:true}));

console.log('\nFramework matrix created:');
created.forEach(result => console.log(`  #${result.id}  ${result.name}  [${result.frameworks.join(', ')}]`));
console.log('\nClient portal demo password: DemoClient!2026');
console.log('These records are synthetic test data and must not be represented as real assurance conclusions.');
