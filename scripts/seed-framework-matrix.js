#!/usr/bin/env node
'use strict';

// Creates a framework matrix plus a dedicated integrated management demo.
// The script is idempotent: only clients with the exact scenario names below are
// replaced. Existing client workspaces are never touched.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { db, init, ensureWorkspaceMethodology, logAction } = require('../db');
const csfModel = require('../lib/csf-policy-practice');
const csfMethodology = require('../data/nist-csf-policy-practice');

init();

const demoPassword = process.env.DEMO_SEED_PASSWORD || 'DemoClient!2026';
if (process.env.NODE_ENV === 'production' && !process.env.DEMO_SEED_PASSWORD) {
  throw new Error('DEMO_SEED_PASSWORD is required when seeding demo data in production.');
}

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
  {
    key: 'management', name: 'Aurelis Group — Management Demo', short: 'Aurelis Group',
    frameworks: ['iso27001', 'iso42001', 'csf'], industry: 'Global digital services', sector: 'technology', color: '#243C4A',
    scope: 'Group governance, customer-facing digital services, shared cloud and identity platforms, enterprise AI capabilities, security operations, critical suppliers and the business-resilience processes supporting regulated customers.',
    managementDemo: true,
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
  const passwordHash = bcrypt.hashSync(demoPassword, 10);
  const existing = db.prepare(`SELECT id FROM users WHERE email=?`).get(email);
  if (existing) {
    db.prepare(`UPDATE users SET name=?,password_hash=?,user_type='client',firm_id=NULL,firm_role=NULL,active=1 WHERE id=?`)
      .run(`${scenario.short} Client Owner`, passwordHash, existing.id);
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'client',NULL,NULL,1)`).run(email, passwordHash, `${scenario.short} Client Owner`).lastInsertRowid);
}

function ensureManagementReviewer() {
  const email = 'reviewer.management-demo@demo.invalid';
  const passwordHash = bcrypt.hashSync(demoPassword, 10);
  const existing = db.prepare(`SELECT id FROM users WHERE email=?`).get(email);
  if (existing) {
    db.prepare(`UPDATE users SET name='Morgan Lee',password_hash=?,user_type='firm',firm_id=?,firm_role='senior_consultant',active=1 WHERE id=?`)
      .run(passwordHash, firm.id, existing.id);
    return Number(existing.id);
  }
  return Number(db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,'Morgan Lee','firm',?,'senior_consultant',1)`).run(email, passwordHash, firm.id).lastInsertRowid);
}

function removePriorDemo(scenario) {
  const prior = db.prepare(`SELECT id FROM workspaces WHERE firm_id=? AND client_name=?`).get(firm.id, scenario.name);
  if (!prior) return;
  if (scenario.managementDemo) {
    const uploadDir = path.join(__dirname,'..','uploads',`firm_${firm.id}`);
    const storedPaths = [
      ...db.prepare(`SELECT stored_path FROM evidence WHERE workspace_id=? AND stored_path IS NOT NULL`).all(prior.id),
      ...db.prepare(`SELECT stored_path FROM supplier_documents WHERE workspace_id=? AND stored_path IS NOT NULL`).all(prior.id),
    ];
    storedPaths.forEach(row => {
      const filename = path.basename(row.stored_path || '');
      if (!filename.startsWith('management-demo-')) return;
      try { fs.unlinkSync(path.join(uploadDir,filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
  }
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
    (workspace_id,name,category,content,status,version,approved_by,approved_at,created_by,published_at,next_review_date,doc_kind,reference_code,controlled_copy,locked)
    VALUES (?,?,?,?,'approved',1,?,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP,?,'policy',?,1,1)`);
  const versionInsert = db.prepare(`INSERT INTO doc_versions
    (workspace_id,document_id,version,name,content,content_hash,status,change_summary,created_by,submitted_at,approved_at,published_at)
    VALUES (?,?,1,?,?,?,'approved','Initial controlled demo version',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  const linkDoc = db.prepare(`INSERT INTO document_requirement_links (document_id,requirement_id,section_ref) VALUES (?,?,?)`);
  const setCurrentVersion = db.prepare(`UPDATE generated_docs SET current_version_id=? WHERE id=?`);
  labels.forEach((label, docIndex) => {
    const content = `# ${label}\n\nOwner: Chief Information Security Officer\nApproved by: Executive Committee\nReview cycle: Annual\n\n## Purpose\nThis controlled document defines the governance, responsibilities, minimum requirements, records and exception process used by ${scenario.short}.\n\n## Scope\n${scenario.scope}\n\n## Requirements\nAccountable owners implement the requirements, retain proportionate evidence, monitor exceptions and report material matters through the approved governance route.\n\n## Assurance\nCompliance is assessed through management review, control testing, internal audit and tracked corrective action.`;
    const docId = Number(docInsert.run(wsId,label,frameworkCode,content,owner.id,owner.id,date(330),`${frameworkCode.toUpperCase()}-DOC-${docIndex+1}`).lastInsertRowid);
    const versionId = Number(versionInsert.run(wsId,docId,label,content,hash(`${wsId}:${frameworkCode}:${label}:${content}`),owner.id).lastInsertRowid);
    setCurrentVersion.run(versionId,docId);
    requirements.slice(docIndex * 5, docIndex * 5 + 8).forEach((req, idx) => linkDoc.run(docId,req.id,`Section ${idx+1}`));
  });

  const evidenceInsert = db.prepare(`INSERT INTO evidence
    (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description,valid_from,valid_until,period_label,tags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const linkEvidence = db.prepare(`INSERT INTO evidence_requirement_links (evidence_id,requirement_id,relevance_note,section_ref) VALUES (?,?,?,?)`);
  requirements.filter((_, index) => index % 4 === 0).slice(0,24).forEach((req, index) => {
    const filename = `${frameworkCode}-${String(index+1).padStart(2,'0')}-${req.ref.replace(/[^a-z0-9]+/gi,'-')}.${scenario.managementDemo ? 'txt' : 'pdf'}`;
    let storedPath = `seed/framework-matrix/${scenario.key}/${filename}`;
    let sizeBytes = 42000+index*713;
    if (scenario.managementDemo) {
      const uploadDir = path.join(__dirname,'..','uploads',`firm_${firm.id}`);
      fs.mkdirSync(uploadDir,{recursive:true});
      storedPath = `management-demo-${frameworkCode}-${String(index+1).padStart(2,'0')}-${hash(`${wsId}:${req.ref}`).slice(0,10)}.txt`;
      const body = `${scenario.short} — synthetic management demonstration evidence\nFramework: ${frameworkCode}\nRequirement: ${req.ref} ${req.title}\nPeriod: FY26 operating period\nOwner: Chief Information Security Officer\nPurpose: Demonstrates operation, ownership and review within the assessment period.\n\nThis record is synthetic test data and is not a real assurance conclusion.\n`;
      fs.writeFileSync(path.join(uploadDir,storedPath),body,'utf8');
      sizeBytes = Buffer.byteLength(body);
    }
    const evidenceId = Number(evidenceInsert.run(wsId,filename,storedPath,hash(`${filename}:${storedPath}`),sizeBytes,owner.id,
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

function seedManagementExtensions(wsId, scenario) {
  const reviewerId = ensureManagementReviewer();
  db.prepare(`INSERT OR REPLACE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'senior_consultant')`).run(wsId,reviewerId);
  const reviewer = db.prepare(`SELECT id,name,email FROM users WHERE id=?`).get(reviewerId);

  const createDemoFile = (name, body) => {
    const uploadDir = path.join(__dirname,'..','uploads',`firm_${firm.id}`);
    fs.mkdirSync(uploadDir,{recursive:true});
    const storedPath = `management-demo-${hash(`${wsId}:${name}`).slice(0,12)}-${name.replace(/[^a-z0-9._-]+/gi,'-').toLowerCase()}`;
    fs.writeFileSync(path.join(uploadDir,storedPath),body,'utf8');
    return { storedPath, sizeBytes: Buffer.byteLength(body), sha256: hash(body) };
  };

  // Policy lifecycle: keep a published baseline, one revision in review and
  // one working draft so the lifecycle is visible without mutating records.
  const publishedDoc = db.prepare(`SELECT * FROM generated_docs WHERE workspace_id=? AND name='Information Security Policy'`).get(wsId);
  if (publishedDoc) {
    db.prepare(`UPDATE generated_docs SET status='published',locked=1,published_at=datetime('now','-120 days') WHERE id=?`).run(publishedDoc.id);
    db.prepare(`UPDATE doc_versions SET status='published',published_at=datetime('now','-120 days') WHERE id=?`).run(publishedDoc.current_version_id);
  }
  const reviewDoc = db.prepare(`SELECT * FROM generated_docs WHERE workspace_id=? AND name='Access Control Standard'`).get(wsId);
  if (reviewDoc) {
    const revisedContent = `${reviewDoc.content}\n\n## Revision 2\nAdds phishing-resistant MFA, quarterly privileged-access recertification and retained exception decisions.`;
    const versionId = Number(db.prepare(`INSERT INTO doc_versions
      (workspace_id,document_id,version,name,content,content_hash,status,change_summary,created_by,submitted_at)
      VALUES (?,?,2,?,?,?,'in_review','Strengthen privileged-access governance',?,datetime('now','-2 days'))`)
      .run(wsId,reviewDoc.id,reviewDoc.name,revisedContent,hash(revisedContent),owner.id).lastInsertRowid);
    db.prepare(`UPDATE generated_docs SET content=?,version=2,status='in_review',current_version_id=?,locked=1,approved_by=NULL,approved_at=NULL,published_at=NULL WHERE id=?`)
      .run(revisedContent,versionId,reviewDoc.id);
    db.prepare(`INSERT INTO doc_approvers (workspace_id,document_id,version_id,sequence,user_id,role_label,notified_at)
      VALUES (?,?,?,?,?,'Independent policy reviewer',datetime('now','-2 days'))`).run(wsId,reviewDoc.id,versionId,1,reviewerId);
  }
  const draftDoc = db.prepare(`SELECT * FROM generated_docs WHERE workspace_id=? AND name='AI Risk Assessment Procedure'`).get(wsId);
  if (draftDoc) {
    const revisedContent = `${draftDoc.content}\n\n## Revision 2 — draft\nProposed materiality thresholds, human-oversight triggers and post-deployment monitoring requirements.`;
    const versionId = Number(db.prepare(`INSERT INTO doc_versions
      (workspace_id,document_id,version,name,content,content_hash,status,change_summary,created_by)
      VALUES (?,?,2,?,?,?,'draft','Add AI materiality and monitoring criteria',?)`)
      .run(wsId,draftDoc.id,draftDoc.name,revisedContent,hash(revisedContent),owner.id).lastInsertRowid);
    db.prepare(`UPDATE generated_docs SET content=?,version=2,status='draft',current_version_id=?,locked=0,approved_by=NULL,approved_at=NULL,published_at=NULL WHERE id=?`)
      .run(revisedContent,versionId,draftDoc.id);
  }

  // Audit programme, populated fieldwork records and a planned follow-up.
  db.prepare(`INSERT INTO audit_programmes (workspace_id,year,description,approved_by,approved_at)
    VALUES (?,?,?,?,datetime('now','-90 days'))`).run(wsId,new Date().getFullYear(),'Risk-based assurance programme covering management-system governance, privileged access, supplier resilience and AI oversight.','Audit & Risk Committee');
  const closedAudit = db.prepare(`SELECT id FROM audits WHERE workspace_id=? ORDER BY id LIMIT 1`).get(wsId);
  if (closedAudit) {
    const obs = db.prepare(`INSERT INTO audit_observations (audit_id,iso_item_id,description,recommendation,status) VALUES (?,?,?,?,?)`);
    obs.run(closedAudit.id,'annex-a.5.15','Access-control responsibilities and approval paths were defined and sampled.','Retain system-generated evidence for every privileged recertification.','complete');
    obs.run(closedAudit.id,'annex-a.5.19','Tier-one suppliers were assessed, but recovery dependencies were not exercised end to end.','Include critical suppliers in the next service-recovery exercise.','open');
    obs.run(closedAudit.id,'clause-9.2','Audit scope, independence, sampling and reporting records were retained.','Track closure evidence against every nonconformity.','complete');
    const sample = db.prepare(`INSERT INTO audit_samples (audit_id,iso_item_id,description,sample_taken_at,population_size,sample_size,finding)
      VALUES (?,?,?,date('now','-46 days'),?,?,?)`);
    sample.run(closedAudit.id,'annex-a.5.15','Privileged role owner recertifications across the assessment period.',64,12,'Two records lacked a durable approval artifact.');
    sample.run(closedAudit.id,'annex-a.5.19','Tier-one supplier assurance and recovery records.',8,4,'One supplier dependency had not been exercised.');
    db.prepare(`UPDATE audit_findings SET iso_item_id='annex-a.5.15' WHERE audit_id=? AND finding_type='minor_nc'`).run(closedAudit.id);
    db.prepare(`UPDATE audit_findings SET iso_item_id='annex-a.5.19' WHERE audit_id=? AND finding_type='observation'`).run(closedAudit.id);
  }
  db.prepare(`INSERT INTO audits
    (workspace_id,title,scope,audit_date,auditor_name,status,summary,created_by,auditor_competence,auditor_independence,sample_size,population_size,lifecycle_stage,sampling_justification)
    VALUES (?,?,?,?,?,'planned',?,?,?, ?,8,36,'planned',?)`)
    .run(wsId,'AI governance and model-operations audit','ISO 42001 governance, AI risk assessment, lifecycle controls, monitoring, suppliers and incident readiness.',date(75),reviewer.name,
      'Planned independent review of governance design and a representative production sample.',owner.id,
      'Senior consultant experienced in AI governance, model risk and management-system assurance.','Reviewer is independent of the sampled AI product and operational decisions.',
      'Risk-based sample across high-impact use cases, material suppliers and production monitoring periods.');

  // TPRM: methodology, reviewed and outstanding questionnaires, assurance,
  // decisions, findings and monitoring across three supplier tiers.
  const methodologyId = Number(db.prepare(`INSERT INTO supplier_risk_methodologies
    (workspace_id,version,name,domain_weights,control_weights,thresholds,review_cadence,is_active,created_by)
    VALUES (?,?,?, ?,?,?,?,1,?)`).run(wsId,1,'Aurelis five-domain supplier risk methodology',
      JSON.stringify({security:20,privacy:20,operational:25,resilience:20,concentration:15}),
      JSON.stringify({assessment:40,assurance:25,contract:20,review:10,subprocessor:5}),
      JSON.stringify({low:6,moderate:11,high:17,critical:25}),JSON.stringify({tier_1:6,tier_2:12,tier_3:24}),owner.id).lastInsertRowid);
  const suppliers = db.prepare(`SELECT * FROM suppliers WHERE workspace_id=? ORDER BY id`).all(wsId);
  const supplierScores = [[23,8,'moderate'],[19,11,'moderate'],[12,5,'low']];
  suppliers.forEach((supplier,index) => {
    const [inherent,residual,band] = supplierScores[index] || [12,5,'low'];
    db.prepare(`UPDATE suppliers SET inherent_risk_score=?,residual_risk_score=?,last_assessed=?,next_review_date=? WHERE id=?`)
      .run(inherent,residual,date(-40-index*15),date(80+index*60),supplier.id);
    db.prepare(`INSERT INTO supplier_risk_snapshots
      (workspace_id,supplier_id,methodology_id,methodology_version,inherent_score,control_effectiveness,calculated_residual_score,effective_residual_score,risk_band,components,rationale,event_type,recorded_by,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now',?))`)
      .run(wsId,supplier.id,methodologyId,1,inherent,Math.round((1-residual/inherent)*100),residual,residual,band,
        JSON.stringify({security:index===0?4:3,privacy:index===2?4:3,operational:index===0?5:3,resilience:index===0?5:3,concentration:index===0?5:2}),
        'Residual position reflects questionnaire responses, independent assurance, contractual protections, review results and dependency context.','periodic_review',owner.id,`-${40+index*15} days`);
    db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,conditions,valid_until,residual_risk_score,methodology_version,decided_by,decider_name,decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now',?))`)
      .run(wsId,supplier.id,index===1?'conditional':'approved',
        'The residual risk is within the approved tolerance for the service, subject to the retained assurance and monitoring conditions.',
        index===1?'Complete the outstanding recovery-evidence request before renewal.':'Maintain current assurance and notify material service or control changes.',
        date(180+index*60),residual,1,reviewerId,reviewer.name,`-${35+index*12} days`);
    db.prepare(`INSERT INTO supplier_reviews
      (workspace_id,supplier_id,review_date,reviewer,outcome,inherent_risk,residual_risk,findings,action_items,next_review_date)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(wsId,supplier.id,date(-40-index*15),reviewer.name,index===1?'conditional':'approved',inherent,residual,
        index===1?'Recovery evidence is incomplete for one material dependency.':'No material exception identified in the reviewed evidence.',
        index===1?'Provide the latest recovery exercise and close the evidence request.':'Continue monitoring and reassess at the approved cadence.',date(80+index*60));
    ['confidentiality','security_obligations','breach_notification','audit_rights','data_return_destruction'].forEach((key,clauseIndex) => {
      db.prepare(`INSERT INTO supplier_clauses (workspace_id,supplier_id,clause_key,clause_label,status,notes,reviewed_at)
        VALUES (?,?,?,?,?,?,datetime('now','-45 days'))`).run(wsId,supplier.id,key,key.replace(/_/g,' '),clauseIndex===4&&index===1?'pending':'present',
          clauseIndex===4&&index===1?'Updated exit wording is with Legal for agreement.':'Clause verified in the current agreement.');
    });
    db.prepare(`INSERT INTO supplier_monitoring (workspace_id,supplier_id,source,score,grade,recorded_at,notes,recorded_by)
      VALUES (?,?,?,?,?,date('now','-14 days'),?,?)`).run(wsId,supplier.id,'Quarterly supplier assurance review',100-residual*3,index===1?'B':'A',
        'No new material incident; contract, assurance and recovery actions reviewed.',owner.id);
    const file = createDemoFile(`${supplier.name}-assurance-summary.txt`,`${supplier.name} synthetic assurance summary\nAssessment period: FY26\nDecision: ${index===1?'Conditional approval':'Approved'}\nResidual risk: ${residual}\nThis is synthetic management-demo evidence.\n`);
    db.prepare(`INSERT INTO supplier_documents
      (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,effective_date,expiry_date,notes,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(wsId,supplier.id,'iso_27001','Supplier assurance summary',`${supplier.name}-assurance-summary.txt`,file.storedPath,file.sha256,file.sizeBytes,date(-120),date(245),'Synthetic downloadable management-demo evidence.',owner.id);
  });

  const template = db.prepare(`SELECT * FROM questionnaire_templates WHERE is_system=1 ORDER BY id LIMIT 1`).get();
  if (template && suppliers.length >= 2) {
    const questions = db.prepare(`SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order`).all(template.id);
    const reviewedQuestionnaireId = Number(db.prepare(`INSERT INTO supplier_questionnaires
      (workspace_id,supplier_id,template_id,template_name,status,sent_at,responded_at,reviewed_at,reviewer,total_questions,answered_questions,score,risk_rating,reviewer_comments,
       external_email,external_contact_name,external_completed_at,external_expires_at,invitation_status,due_date)
      VALUES (?,?,?,?,'reviewed',datetime('now','-55 days'),datetime('now','-43 days'),datetime('now','-39 days'),?,?,?,?,?,?,?, ?,datetime('now','-43 days'),datetime('now','20 days'),'completed',?)`)
      .run(wsId,suppliers[0].id,template.id,template.name,reviewer.name,questions.length,questions.length,88,'low',
        'Responses and evidence were reviewed; two improvement actions remain under routine monitoring.','security@azure.example','Azure Assurance Team',date(-30)).lastInsertRowid);
    const responseInsert = db.prepare(`INSERT INTO supplier_questionnaire_responses (questionnaire_id,question_id,answer,comment,evidence_ref) VALUES (?,?,?,?,?)`);
    questions.forEach((question,index) => responseInsert.run(reviewedQuestionnaireId,question.id,index%9===0?'partial':(question.expected_answer||'yes'),
      index%9===0?'Implemented with a documented improvement action.':'Implemented and supported by the current assurance pack.',`Assurance pack section ${index+1}`));
    db.prepare(`INSERT INTO external_assessment_tokens
      (workspace_id,assessment_id,entity_id,questionnaire_id,email,name,token_hash,issued_at,expires_at,completed_at,created_by,migrated_from)
      VALUES (?,NULL,?,?,?,?,?,datetime('now','-55 days'),datetime('now','20 days'),datetime('now','-43 days'),?,'management-demo')`)
      .run(wsId,suppliers[0].entity_id||null,reviewedQuestionnaireId,'security@azure.example','Azure Assurance Team',hash(`completed:${wsId}:${reviewedQuestionnaireId}`),owner.id);

    const sentQuestionnaireId = Number(db.prepare(`INSERT INTO supplier_questionnaires
      (workspace_id,supplier_id,template_id,template_name,status,sent_at,total_questions,answered_questions,external_email,external_contact_name,external_expires_at,invitation_status,due_date)
      VALUES (?,?,?,?,'sent',datetime('now','-6 days'),?,0,?,?,datetime('now','24 days'),'sent',?)`)
      .run(wsId,suppliers[1].id,template.id,template.name,questions.length,'security@github.example','GitHub Assurance Team',date(18)).lastInsertRowid);
    db.prepare(`INSERT INTO external_assessment_tokens
      (workspace_id,assessment_id,entity_id,questionnaire_id,email,name,token_hash,issued_at,expires_at,created_by,migrated_from)
      VALUES (?,NULL,?,?,?,?,?,datetime('now','-6 days'),datetime('now','24 days'),?,'management-demo')`)
      .run(wsId,suppliers[1].entity_id||null,sentQuestionnaireId,'security@github.example','GitHub Assurance Team',hash(`open:${wsId}:${sentQuestionnaireId}`),owner.id);
    const findingId = Number(db.prepare(`INSERT INTO findings
      (workspace_id,source_type,source_id,title,description,severity,severity_scheme,status,created_by,migrated_from)
      VALUES (?,'assessment',?,'Recovery assurance evidence outstanding','The current questionnaire has not yet provided evidence of the latest material service-recovery exercise.','high','operational','open',?,'management-demo')`)
      .run(wsId,String(sentQuestionnaireId),owner.id).lastInsertRowid);
    db.prepare(`INSERT INTO supplier_finding_links
      (finding_id,supplier_id,questionnaire_id,domain,due_date,owner_name)
      VALUES (?,?,?,?,?,?)`).run(findingId,suppliers[1].id,sentQuestionnaireId,'resilience',date(25),'Head of Platform');
  }

  // Incident register with one closed record and one active material scenario.
  const closedIncident = db.prepare(`SELECT * FROM incidents WHERE workspace_id=? ORDER BY id LIMIT 1`).get(wsId);
  const phishingRunbook = db.prepare(`SELECT id FROM runbooks WHERE is_system=1 AND category='phishing' ORDER BY id LIMIT 1`).get();
  if (closedIncident) {
    db.prepare(`UPDATE incidents SET pir_completed=1,pir_summary=?,runbook_id=?,contained_at=datetime('now','-95 days','+18 minutes'),eradicated_at=datetime('now','-95 days','+2 hours'),recovered_at=datetime('now','-94 days') WHERE id=?`)
      .run('Conditional access prevented production access. Phishing-resistant MFA rollout and decision-timestamp retention were approved.',phishingRunbook?phishingRunbook.id:null,closedIncident.id);
  }
  const breachRunbook = db.prepare(`SELECT id FROM runbooks WHERE is_system=1 AND category IN ('breach','malware') ORDER BY CASE category WHEN 'breach' THEN 1 ELSE 2 END,id LIMIT 1`).get();
  const activeIncidentId = Number(db.prepare(`INSERT INTO incidents
    (workspace_id,title,category,severity,detected_at,reported_by,status,description,affected_assets,containment_actions,external_notification,notification_required_by,runbook_id,contained_at)
    VALUES (?,?,'breach','high',datetime('now','-7 hours'),'Security Operations','contained',?,?,?,?,datetime('now','65 hours'),?,datetime('now','-6 hours'))`)
    .run(wsId,'Suspected customer-data exposure through support integration','A third-party support integration returned records outside the expected tenant boundary; investigation is active and the confirmed scope remains limited.',
      'Customer and account data; customer production platform','Integration token revoked, connector isolated, affected logs preserved and enhanced monitoring enabled.','Legal and Privacy are assessing notification thresholds; no external notification decision has been made.',breachRunbook?breachRunbook.id:null).lastInsertRowid);
  const eventInsert = db.prepare(`INSERT INTO incident_events (workspace_id,incident_id,phase,event_at,description,actor) VALUES (?,?,?,datetime('now',?),?,?)`);
  if (closedIncident) {
    eventInsert.run(wsId,closedIncident.id,'detect','-95 days','Identity alert correlated with a reported phishing prompt.','Security Operations');
    eventInsert.run(wsId,closedIncident.id,'contain','-95 days','Session revoked and conditional-access controls reinforced.','Identity Team');
    eventInsert.run(wsId,closedIncident.id,'lessons','-93 days','PIR approved phishing-resistant MFA acceleration.','CISO');
  }
  eventInsert.run(wsId,activeIncidentId,'detect','-7 hours','Anomalous cross-tenant record access was identified in application telemetry.','Security Operations');
  eventInsert.run(wsId,activeIncidentId,'contain','-6 hours','Connector token revoked and integration isolated.','Incident Commander');
  eventInsert.run(wsId,activeIncidentId,'communicate','-4 hours','Legal, Privacy, service leadership and the customer-response lead were briefed.','Incident Commander');

  // Change register with records at every meaningful lifecycle point.
  const assets = db.prepare(`SELECT id,name FROM assets WHERE workspace_id=? ORDER BY id`).all(wsId);
  const changeInsert = db.prepare(`INSERT INTO changes
    (workspace_id,title,description,change_type,category,requester_name,requester_id,risk_assessment,risk_level,impact_assessment,rollback_plan,status,
     submitted_at,approved_at,implemented_at,closed_at,implementation_notes,test_results,post_implementation_review,pir_date,success,linked_asset_ids,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now',?))`);
  const closedChangeId = Number(changeInsert.run(wsId,'Enforce phishing-resistant MFA for privileged administrators','Move production administrative roles to hardware-backed authentication.','normal','Security',owner.name,owner.id,
    'Medium delivery risk; staged enrolment and break-glass validation reduce lockout risk.','high','Administrative sign-in and emergency access procedures are affected.','Re-enable the prior authentication policy and validate break-glass accounts.','closed',
    date(-70),date(-66),date(-60),date(-52),'Policy deployed in three waves with service-owner validation.','All enrolled administrators passed sign-in and break-glass tests.','Successful change; one support playbook clarification was completed.',date(-52),1,JSON.stringify(assets.slice(0,2).map(a=>a.id)),owner.id,'-75 days').lastInsertRowid);
  db.prepare(`INSERT INTO change_approvals (change_id,workspace_id,approver_id,approver_name,sequence,decision,reason,decided_at)
    VALUES (?,?,?,?,1,'approved','Risk, rollback, testing and segregation requirements were adequate.',datetime('now','-66 days'))`)
    .run(closedChangeId,wsId,reviewerId,reviewer.name);
  changeInsert.run(wsId,'Emergency rotate support-integration credentials','Rotate and scope credentials following the suspected exposure.','emergency','Security',owner.name,owner.id,
    'Urgent containment action; service interruption is acceptable while scope is verified.','critical','Customer support integration may be unavailable during rotation.','Issue an isolated read-only credential only after incident-command approval.','implemented',
    null,null,date(-1),null,'Credentials rotated and permissions reduced to the minimum required scope.','Authentication and tenant-boundary checks passed; retrospective approval remains outstanding.',null,null,null,JSON.stringify(assets.slice(0,1).map(a=>a.id)),owner.id,'-1 days');
  changeInsert.run(wsId,'Upgrade production database encryption policy','Apply the current encryption policy and rotate affected keys.','normal','Infrastructure',owner.name,owner.id,
    'Moderate operational risk with tested rollback and maintenance window.','medium','Short maintenance window; no planned customer data loss.','Restore the prior policy and keys from the controlled recovery record.','submitted',
    date(-3),null,null,null,null,null,null,null,null,JSON.stringify(assets.slice(1,3).map(a=>a.id)),owner.id,'-5 days');
  changeInsert.run(wsId,'Adopt AI model-release approval gate','Require materiality review, human-oversight confirmation and monitoring acceptance before release.','standard','Policy / procedure',owner.name,owner.id,
    'Low implementation risk; workflow change affects release lead time.','low','AI product and engineering release processes are affected.','Disable the new gate and restore the prior release checklist.','draft',
    null,null,null,null,null,null,null,null,null,JSON.stringify(assets.slice(2,4).map(a=>a.id)),owner.id,'-2 days');

  // BIA, continuity plans and exercised recovery objectives.
  const processInsert = db.prepare(`INSERT INTO bcp_processes
    (workspace_id,name,description,owner_name,criticality,max_tolerable_downtime_hours,rto_hours,rpo_hours,dependencies,peak_periods,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'active')`);
  const processIds = {};
  [
    ['Customer transaction processing','Receives, validates and processes customer service transactions.','Chief Operating Officer','critical',8,4,1,'Cloud production, enterprise identity, customer data, Azure and security monitoring','Month end and customer campaign periods'],
    ['Customer authentication','Authenticates customer and workforce access to critical services.','Chief Technology Officer','critical',4,2,0.5,'Enterprise identity, cloud networking and privileged operations','Continuous'],
    ['Security monitoring and incident response','Detects, investigates and coordinates material security events.','CISO','high',12,4,1,'Security telemetry, identity, cloud logging, communications and legal support','Continuous'],
    ['AI-assisted customer support','Provides governed customer support using approved AI capabilities.','Chief Customer Officer','medium',48,24,8,'Customer data, model provider, support integration and human escalation','Business hours and major launches'],
  ].forEach(row => { processIds[row[0]] = Number(processInsert.run(wsId,...row).lastInsertRowid); });
  const planInsert = db.prepare(`INSERT INTO bcp_plans
    (workspace_id,name,description,plan_type,recovery_steps,key_contacts,alternate_site,status,last_reviewed_at,next_review_date,created_by)
    VALUES (?,?,?,?,?,?,?,?,datetime('now',?),?,?)`);
  const servicePlanId = Number(planInsert.run(wsId,'Tier-one digital service continuity plan','Business-led continuity plan for customer processing, identity, communications and critical supplier coordination.','bcp',
    '1. Confirm incident command and business priorities.\n2. Validate customer-processing and identity impact.\n3. Invoke regional recovery and supplier escalation.\n4. Reconcile data and obtain business acceptance.\n5. Communicate recovery status and capture decisions.',
    'Incident Commander — COO\nTechnology Recovery Lead — CTO\nSecurity Lead — CISO\nCustomer Communications — Chief Customer Officer','Remote operations plus secondary cloud region','active','-45 days',date(320),owner.id).lastInsertRowid);
  const drPlanId = Number(planInsert.run(wsId,'Cloud platform disaster-recovery plan','Technical recovery plan for cloud production, data, identity and security telemetry.','dr',
    '1. Declare technical recovery.\n2. Protect evidence and freeze unsafe changes.\n3. Restore identity and core data services.\n4. Recover applications in dependency order.\n5. Validate RTO/RPO and hand back to business operations.',
    'Technology Recovery Lead — CTO\nDatabase Recovery Lead — Head of Platform\nSecurity Validation — Security Operations','Secondary cloud region','active','-30 days',date(335),owner.id).lastInsertRowid);
  const crisisPlanId = Number(planInsert.run(wsId,'Executive cyber-crisis management plan','Executive decisions, legal assessment, customer communications and board escalation for a material cyber event.','crisis',
    '1. Establish decision authority.\n2. Confirm known facts, uncertainty and immediate harms.\n3. Assess notification and communication duties.\n4. Approve strategic response and customer commitments.\n5. Maintain decision log and commission the post-incident review.',
    'Executive Sponsor — CEO\nIncident Commander — COO\nLegal — General Counsel\nSecurity — CISO\nCommunications — Corporate Affairs','Secure virtual crisis room','under_review','-120 days',date(20),owner.id).lastInsertRowid);
  const linkProcess = db.prepare(`INSERT INTO bcp_plan_processes (plan_id,process_id) VALUES (?,?)`);
  [processIds['Customer transaction processing'],processIds['Customer authentication'],processIds['Security monitoring and incident response']].forEach(id=>linkProcess.run(servicePlanId,id));
  [processIds['Customer transaction processing'],processIds['Customer authentication'],processIds['Security monitoring and incident response']].forEach(id=>linkProcess.run(drPlanId,id));
  [processIds['Security monitoring and incident response'],processIds['AI-assisted customer support']].forEach(id=>linkProcess.run(crisisPlanId,id));
  const testInsert = db.prepare(`INSERT INTO bcp_tests
    (workspace_id,plan_id,test_type,test_date,participants,scenario_description,results,lessons_learned,rto_achieved_hours,rpo_achieved_hours,pass,action_items,next_test_date,conducted_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  testInsert.run(wsId,drPlanId,'technical',date(-70),'Platform Engineering, Database Operations, Security Operations and service owners',
    'Loss of the primary cloud region during peak processing.','Core services recovered in 3.5 hours with 42 minutes of data exposure; business acceptance completed.','Identity dependency order should be made explicit in the recovery checklist.',3.5,0.7,1,'Update the dependency diagram and retain automated recovery-test evidence.',date(295),reviewerId);
  testInsert.run(wsId,servicePlanId,'tabletop',date(-35),'COO, CTO, CISO, Customer Operations, Legal, Communications and Azure service owner',
    'Ransomware disrupts production while the primary cloud supplier reports a concurrent regional incident.','Decision authority and technical recovery were effective, but supplier escalation and customer-message approval exceeded the exercise objective.','Pre-authorise escalation contacts and customer-message decision thresholds.',5.5,1.2,0,'Owner: COO — update supplier escalation by '+date(30)+'; Owner: Corporate Affairs — approve message templates by '+date(45)+'.',date(90),reviewerId);
  testInsert.run(wsId,crisisPlanId,'simulation',date(-18),'CEO, COO, CISO, General Counsel, Privacy Officer and Corporate Affairs',
    'Suspected cross-tenant exposure requiring notification assessment and customer communications.','The team reached declaration, legal assessment and executive decisions within the exercise objectives.','Record alternative hypotheses and evidence-confidence changes more explicitly.',null,null,1,'Add an evidence-confidence field to the next exercise decision log.',date(165),reviewerId);
}

function managementSummary(wsId) {
  const scalar = sql => db.prepare(sql).get(wsId).c;
  return {
    assets: scalar(`SELECT COUNT(*) c FROM assets WHERE workspace_id=?`),
    risks: scalar(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`),
    requirements: scalar(`SELECT COUNT(*) c FROM control_instances WHERE workspace_id=?`),
    documents: scalar(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=?`),
    evidence: scalar(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`),
    audits: scalar(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`),
    suppliers: scalar(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=?`),
    questionnaires: scalar(`SELECT COUNT(*) c FROM supplier_questionnaires WHERE workspace_id=?`),
    incidents: scalar(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=?`),
    changes: scalar(`SELECT COUNT(*) c FROM changes WHERE workspace_id=?`),
    continuityProcesses: scalar(`SELECT COUNT(*) c FROM bcp_processes WHERE workspace_id=?`),
    continuityPlans: scalar(`SELECT COUNT(*) c FROM bcp_plans WHERE workspace_id=?`),
    continuityExercises: scalar(`SELECT COUNT(*) c FROM bcp_tests WHERE workspace_id=?`),
    csfOutcomes: db.prepare(`SELECT COUNT(*) c FROM csf_subcategory_assessments a JOIN csf_engagements e ON e.id=a.engagement_id WHERE e.workspace_id=?`).get(wsId).c,
  };
}

function assertManagementSummary(summary) {
  const minimums = { assets:6,risks:6,requirements:183,documents:12,evidence:60,audits:2,suppliers:3,questionnaires:2,incidents:2,changes:4,continuityProcesses:4,continuityPlans:3,continuityExercises:3,csfOutcomes:106 };
  const failures = Object.entries(minimums).filter(([key,value]) => summary[key] < value);
  if (failures.length) throw new Error(`Management demo is incomplete: ${failures.map(([key,value])=>`${key} ${summary[key]}/${value}`).join(', ')}`);
}

const scenarioFlagIndex = process.argv.indexOf('--scenario');
const requestedScenario = scenarioFlagIndex >= 0 ? process.argv[scenarioFlagIndex+1] : ((process.argv.find(arg=>arg.startsWith('--scenario='))||'').split('=')[1]||null);
const selectedScenarios = requestedScenario ? SCENARIOS.filter(s=>s.key===requestedScenario) : SCENARIOS;
if (!selectedScenarios.length) throw new Error(`Unknown scenario "${requestedScenario}". Available: ${SCENARIOS.map(s=>s.key).join(', ')}`);

const created = db.transaction(() => {
  const results = [];
  selectedScenarios.forEach((scenario) => {
    const scenarioIndex = SCENARIOS.findIndex(item=>item.key===scenario.key);
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
    if (scenario.managementDemo) seedManagementExtensions(wsId,scenario);
    const summary = scenario.managementDemo ? managementSummary(wsId) : null;
    if (summary) assertManagementSummary(summary);
    results.push({ id: wsId, name: scenario.name, frameworks: scenario.frameworks, clientEmail: `client.${scenario.key}@demo.invalid`, summary });
  });
  return results;
})();

created.forEach(result => logAction(owner.id,result.id,'seed_framework_matrix','workspace',result.id,{frameworks:result.frameworks,synthetic:true}));

console.log('\nFramework matrix created:');
created.forEach(result => console.log(`  #${result.id}  ${result.name}  [${result.frameworks.join(', ')}]`));
created.filter(result=>result.summary).forEach(result=>console.log(`     ${Object.entries(result.summary).map(([key,value])=>`${key}=${value}`).join(' · ')}`));
console.log(`\nClient portal demo password: ${process.env.DEMO_SEED_PASSWORD ? 'set from DEMO_SEED_PASSWORD' : 'local development default in use'}`);
console.log('These records are synthetic test data and must not be represented as real assurance conclusions.');
