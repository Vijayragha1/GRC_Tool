#!/usr/bin/env node
'use strict';

// Adds one complete, clearly synthetic supplier programme to an existing
// workspace. The script is intentionally idempotent: an existing demo record
// is reported, never silently replaced.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const supplierRisk = require('../lib/supplier-risk');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'iso27001.db');
const DEMO_NAME = 'Nimbus SecureCloud - Completed Supplier Demo';
const workspaceArg = process.argv.find(arg => arg.startsWith('--workspace='));
const workspaceId = Number(workspaceArg ? workspaceArg.split('=')[1] : process.argv[2]);

if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
  console.error('Usage: node scripts/seed-populated-supplier-demo.js --workspace=<id>');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const workspace = db.prepare('SELECT id,client_name,firm_id FROM workspaces WHERE id=?').get(workspaceId);
if (!workspace) {
  db.close();
  console.error(`Workspace ${workspaceId} was not found.`);
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM suppliers WHERE workspace_id=? AND name=?').get(workspaceId, DEMO_NAME);
if (existing) {
  const summary = {
    supplierId: existing.id,
    url: `/workspaces/${workspaceId}/vendors/${existing.id}`,
    inherent: db.prepare("SELECT status FROM supplier_inherent_assessments WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1").get(existing.id)?.status || 'missing',
    dueDiligence: db.prepare("SELECT status FROM supplier_ddq_assessments WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1").get(existing.id)?.status || 'missing',
    contractReview: db.prepare("SELECT status FROM supplier_contract_reviews WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1").get(existing.id)?.status || 'missing',
    decision: db.prepare('SELECT decision FROM supplier_decisions WHERE supplier_id=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1').get(existing.id)?.decision || 'missing',
    existing: true,
  };
  db.close();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const owner = db.prepare(`SELECT id,name FROM users WHERE firm_id=? AND active=1
  ORDER BY CASE firm_role WHEN 'manager' THEN 0 ELSE 1 END,id LIMIT 1`).get(workspace.firm_id);
const reviewer = db.prepare(`SELECT id,name FROM users WHERE firm_id=? AND active=1 AND id!=?
  ORDER BY CASE firm_role WHEN 'senior_consultant' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,id LIMIT 1`).get(workspace.firm_id, owner && owner.id);
if (!owner || !reviewer) {
  db.close();
  console.error('The workspace firm needs two active users for maker-checker demo data.');
  process.exit(1);
}

const DAY = 86400000;
const isoDate = offset => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const isoTime = offset => new Date(Date.now() + offset * DAY).toISOString().slice(0, 19).replace('T', ' ');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const uploadDir = path.join(ROOT, 'uploads', `firm_${workspace.firm_id}`);
fs.mkdirSync(uploadDir, { recursive: true });
const newlyCreatedFiles = [];

function createDemoFile(key, filename, lines) {
  const content = [
    'SYNTHETIC MANAGEMENT-DEMO EVIDENCE - NOT A REAL ASSURANCE ARTIFACT',
    `Supplier: ${DEMO_NAME}`,
    `Client workspace: ${workspace.client_name}`,
    ...lines,
    `Generated: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  const storedPath = `supplier-demo-${workspaceId}-${slug(key)}-${hash(key).slice(0, 10)}.txt`;
  const fullPath = path.join(uploadDir, storedPath);
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, content, { encoding: 'utf8', mode: 0o600 });
    newlyCreatedFiles.push(fullPath);
  }
  const body = fs.readFileSync(fullPath);
  return { filename, storedPath, sha256: hash(body), sizeBytes: body.length, mimeType: 'text/plain' };
}

let result;
try {
  result = db.transaction(() => {
    const entityId = Number(db.prepare(`INSERT INTO entities
      (workspace_id,name,code,description,entity_type,region,contact,attributes)
      VALUES (?,?,?,'Synthetic critical SaaS supplier for a complete TPRM workflow demonstration.','supplier','India and EU',?,?)`)
      .run(workspaceId, DEMO_NAME, 'SUP-DEMO-COMPLETE', 'assurance@nimbus-securecloud.demo.invalid', JSON.stringify({
        lifecycle_stage: 'active', criticality: 'critical', data_access: 'restricted', synthetic: true,
      })).lastInsertRowid);

    const supplierId = Number(db.prepare(`INSERT INTO suppliers
      (workspace_id,entity_id,name,service_provided,tier,data_access,contract_start,contract_end,next_review_date,
       attestations,contact,notes,status,last_assessed,lifecycle_stage,inherent_risk_score,residual_risk_score,
       business_criticality,data_volume,industry,location,parent_company,regulatory_exposure,dependency_type,
       annual_spend,renewal_notice_days,auto_renew,approved_by,approved_at,website,relationship_owner,
       business_owner,security_reviewer,privacy_owner,service_category,processing_purpose,data_categories,
       hosting_locations,critical_processes,system_access,rto_hours,rpo_hours,exit_strategy)
      VALUES (?,?,?,?,?,'restricted',?,?,?,?,?,?,'active',?,'active',?,?,
        'critical','high','Cloud software','India, Ireland and Germany','Nimbus SecureCloud Holdings',
        'DPDP Act, GDPR and contractual security obligations','single_source','USD 480,000',90,0,?,?,'https://demo.invalid',
        'Ananya Rao','Chief Operating Officer','Priya Sharma','Data Protection Officer','Cloud platform',
        'Managed workflow and secure document processing','Customer, employee and authentication data',
        'Mumbai, Dublin and Frankfurt','Customer portal, workflow engine and evidence repository',
        'Federated SSO, API and restricted production support',4,1,
        'Export data through the documented portability process, revoke integrations, verify deletion and transition to the approved alternate provider.')`)
      .run(workspaceId, entityId, DEMO_NAME, 'Critical workflow and secure-document SaaS platform', 'tier_1',
        isoDate(-390), isoDate(705), isoDate(320), 'ISO 27001; SOC 2 Type II; ISO 22301',
        'assurance@nimbus-securecloud.demo.invalid', 'Synthetic, fully populated supplier used only for management demonstrations.',
        isoDate(-20), 81, 9, owner.name, isoTime(-18)).lastInsertRowid);

    const answers = Object.fromEntries(supplierRisk.methodology.scoring.questions.map(question => [question.id, 4]));
    answers.Q14 = 5;
    const inherentResult = supplierRisk.scoreInherent(answers);
    const modules = supplierRisk.routeModules(inherentResult.answers, 'yes');
    const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
      (workspace_id,supplier_id,methodology_version,assessment_type,status,physical_data_centre_applicability,
       weighted_score,assigned_tier,mandatory_floors_json,module_applicability_json,unknown_count,due_date,
       submitted_at,approved_at,approved_by,approval_rationale,created_by,created_at,updated_at)
      VALUES (?,?,?,'periodic','approved','yes',?,?,?,?,0,?,?,?,?,?,?,?,?)`)
      .run(workspaceId, supplierId, supplierRisk.methodology.version, inherentResult.weightedScore,
        inherentResult.assignedTier, JSON.stringify(inherentResult.triggeredFloors), JSON.stringify(modules),
        isoDate(-52), isoTime(-58), isoTime(-56), reviewer.id,
        'All 25 owner inputs were validated. Mandatory tier floors and conditional modules were independently reviewed.',
        owner.id, isoTime(-62), isoTime(-56)).lastInsertRowid);
    const inherentInsert = db.prepare(`INSERT INTO supplier_inherent_responses
      (assessment_id,question_id,score,response_label,comment,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)`);
    for (const question of supplierRisk.methodology.scoring.questions) {
      const option = question.options.find(item => item.score === answers[question.id]);
      inherentInsert.run(inherentId, question.id, answers[question.id], option && option.label,
        'Validated with the accountable business, technology, security and privacy owners.', owner.id, isoTime(-58));
    }

    const moduleMap = Object.fromEntries(modules.map(module => [module.name, module.applicability]));
    const questions = supplierRisk.questionsForAssessment(inherentResult.assignedTier, moduleMap, workspace.client_name);
    const ddqId = Number(db.prepare(`INSERT INTO supplier_ddq_assessments
      (workspace_id,supplier_id,inherent_assessment_id,methodology_version,tier,assessment_type,status,modules_json,
       vendor_contact_name,vendor_contact_email,due_date,issued_at,opened_at,submitted_at,completed_at,completed_by,
       created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,'periodic','complete',?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(workspaceId, supplierId, inherentId, supplierRisk.methodology.version, inherentResult.assignedTier,
        JSON.stringify(modules), 'Meera Nair - Head of Assurance', 'meera.nair@nimbus-securecloud.demo.invalid',
        isoDate(-28), isoTime(-54), isoTime(-53), isoTime(-35), isoTime(-30), reviewer.id, owner.id, isoTime(-55), isoTime(-30)).lastInsertRowid);

    const domains = [...new Set(questions.map(question => question.domain))];
    const evidenceByDomain = new Map(domains.map(domain => [domain, createDemoFile(
      `ddq-${domain}`,
      `${slug(domain)}-assurance-pack.txt`,
      [`Evidence domain: ${domain}`, 'Scope: Production SaaS service supplied to the client.', 'Review conclusion: Satisfactory for the current assessment period.']
    )]));
    const responseInsert = db.prepare(`INSERT INTO supplier_ddq_responses
      (assessment_id,question_id,response,detail,evidence_reference,status,reviewer_conclusion,reviewer_comments,
       vendor_updated_at,reviewer_updated_at,reviewer_id)
      VALUES (?,?,'Yes',?,?,'Response Complete','Satisfactory',?,?,?,?)`);
    const evidenceInsert = db.prepare(`INSERT INTO supplier_ddq_evidence
      (workspace_id,assessment_id,question_id,filename,stored_path,sha256,size_bytes,mime_type,source,uploaded_by,uploaded_at)
      VALUES (?,?,?,?,?,?,?,?, 'vendor',NULL,?)`);
    for (const question of questions) {
      const file = evidenceByDomain.get(question.domain);
      responseInsert.run(ddqId, question.id,
        'Implemented for the contracted production service. The cited synthetic assurance pack demonstrates the expected governance and operating practice.',
        file.filename, 'Evidence scope, relevance and control operation were independently reviewed.', isoTime(-35), isoTime(-30), reviewer.id);
      evidenceInsert.run(workspaceId, ddqId, question.id, file.filename, file.storedPath, file.sha256, file.sizeBytes, file.mimeType, isoTime(-35));
    }

    const contractId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
      (workspace_id,supplier_id,inherent_assessment_id,methodology_version,status,agreement_reference,agreement_date,
       reviewer_id,completed_at,created_at,updated_at)
      VALUES (?,?,?,?,'complete','MSA-NSC-2025-041',?,?,?,?,?)`)
      .run(workspaceId, supplierId, inherentId, supplierRisk.methodology.version, isoDate(-390), reviewer.id,
        isoTime(-24), isoTime(-50), isoTime(-24)).lastInsertRowid);
    const contractInsert = db.prepare(`INSERT INTO supplier_contract_review_items
      (review_id,clause_id,required,status,contract_reference,reviewer_comments,reviewed_at)
      VALUES (?,?,?,?,?,?,?)`);
    supplierRisk.methodology.contractClauses.forEach((clause, index) => {
      const required = supplierRisk.contractClauseRequired(clause, moduleMap);
      contractInsert.run(contractId, clause.id, required ? 1 : 0,
        required ? 'Present - Satisfactory' : 'Not Required', required ? `MSA §${Math.floor(index / 4) + 1}.${index % 4 + 1}` : null,
        required ? 'Executed clause verified against the synthetic agreement summary.' : 'Excluded by the approved conditional-module scope.', isoTime(-24));
    });

    const highFindingId = Number(db.prepare(`INSERT INTO findings
      (workspace_id,source_type,source_id,title,description,severity,severity_scheme,status,created_by,created_at,migrated_from)
      VALUES (?,'assessment',?,'Privileged support-session recording coverage','Two legacy support paths did not retain complete session recordings. Coverage was remediated and independently re-tested.','high','operational','closed',?,?, 'supplier-complete-demo')`)
      .run(workspaceId, String(ddqId), owner.id, isoTime(-38)).lastInsertRowid);
    db.prepare(`INSERT INTO supplier_finding_links
      (finding_id,supplier_id,domain,due_date,owner_name) VALUES (?,?,?,?,?)`)
      .run(highFindingId, supplierId, 'Privileged Access & Managed Security', isoDate(-12), 'Head of Platform Security');
    const mediumFindingId = Number(db.prepare(`INSERT INTO findings
      (workspace_id,source_type,source_id,title,description,severity,severity_scheme,status,created_by,created_at,migrated_from)
      VALUES (?,'assessment',?,'Subprocessor notification register enhancement','The register is complete, but the customer-notification workflow will be consolidated into the contract management platform.','medium','operational','open',?,?, 'supplier-complete-demo')`)
      .run(workspaceId, String(ddqId), owner.id, isoTime(-29)).lastInsertRowid);
    db.prepare(`INSERT INTO supplier_finding_links
      (finding_id,supplier_id,domain,due_date,owner_name) VALUES (?,?,?,?,?)`)
      .run(mediumFindingId, supplierId, 'Fourth-Party Management', isoDate(55), 'Vendor Governance Lead');

    const readiness = { ready: true, blockers: [] };
    const decisionId = Number(db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,conditions,valid_until,residual_risk_score,methodology_version,
       decided_by,decider_name,decided_at,residual_risk_band,residual_risk_rationale,readiness_snapshot_json,
       inherent_assessment_id,ddq_assessment_id,contract_review_id)
      VALUES (?,?,'conditional',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(workspaceId, supplierId,
        'The inherent-risk assessment, evidence-backed DDQ and executed contract support continued use of the service.',
        'Complete the subprocessor-notification workflow enhancement by the recorded finding due date and report status at the next quarterly review.',
        isoDate(320), 9, 1, owner.id, owner.name, isoTime(-18), 'moderate',
        'A material single-source dependency remains; resilience evidence, contractual protections and monitoring reduce the effective exposure to moderate.',
        JSON.stringify(readiness), inherentId, ddqId, contractId).lastInsertRowid);

    const activeMethodology = db.prepare('SELECT id,version FROM supplier_risk_methodologies WHERE workspace_id=? AND is_active=1 ORDER BY version DESC LIMIT 1').get(workspaceId);
    db.prepare(`INSERT INTO supplier_risk_snapshots
      (workspace_id,supplier_id,methodology_id,methodology_version,inherent_score,control_effectiveness,
       calculated_residual_score,effective_residual_score,risk_band,components,rationale,event_type,recorded_by,recorded_at)
      VALUES (?,?,?,?,81,88,10,9,'moderate',?,?,'decision',?,?)`)
      .run(workspaceId, supplierId, activeMethodology ? activeMethodology.id : null, activeMethodology ? activeMethodology.version : 1,
        JSON.stringify({ inherent: 81, dueDiligence: 100, contract: 100, monitoring: 92 }),
        'Residual position recorded when the conditional approval was issued.', owner.id, isoTime(-18));

    const documentSpecs = [
      ['soc2', 'SOC 2 Type II assurance summary', 'SOC 2 Type II assurance summary.txt', ['Document type: Independent assurance summary', 'Period covered: 1 April 2025 to 31 March 2026', 'Result: No material exceptions in the scoped trust-services criteria.']],
      ['iso27001', 'ISO 27001 certificate scope', 'ISO 27001 certificate scope.txt', ['Document type: Certificate scope summary', 'Scope: Cloud platform engineering, operations and customer support.', 'Status: Current for the synthetic assessment period.']],
      ['resilience', 'Business continuity and recovery exercise', 'Business continuity and recovery exercise.txt', ['Exercise: Regional cloud-service disruption', 'Observed recovery: 2 hours 18 minutes', 'Contractual RTO: 4 hours; contractual RPO: 1 hour.']],
      ['penetration', 'Independent penetration-test summary', 'Independent penetration-test summary.txt', ['Test scope: Internet-facing application and API', 'High or critical findings: None open', 'Retest status: Completed.']],
    ];
    const documentInsert = db.prepare(`INSERT INTO supplier_documents
      (workspace_id,supplier_id,doc_type,name,filename,stored_path,sha256,size_bytes,effective_date,expiry_date,notes,uploaded_by,uploaded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [type, name, filename, lines] of documentSpecs) {
      const file = createDemoFile(`document-${type}`, filename, lines);
      documentInsert.run(workspaceId, supplierId, type, name, file.filename, file.storedPath, file.sha256, file.sizeBytes,
        isoDate(-120), isoDate(245), 'Synthetic downloadable evidence for the completed supplier demo.', owner.id, isoTime(-35));
    }

    const subprocessorInsert = db.prepare(`INSERT INTO supplier_subprocessors
      (workspace_id,supplier_id,name,service_provided,data_access,location,approved,approved_at,notes)
      VALUES (?,?,?,?,?,?,1,?,?)`);
    subprocessorInsert.run(workspaceId, supplierId, 'Amazon Web Services', 'Cloud infrastructure', 'Encrypted customer data', 'India and EU', isoTime(-120), 'Approved regions and services are recorded in the DPA.');
    subprocessorInsert.run(workspaceId, supplierId, 'Cloudflare', 'Content delivery and DDoS protection', 'Encrypted traffic metadata', 'Global edge network', isoTime(-115), 'Standard contractual and security terms reviewed.');

    const reviewInsert = db.prepare(`INSERT INTO supplier_reviews
      (workspace_id,supplier_id,review_date,reviewer,outcome,inherent_risk,residual_risk,findings,action_items,next_review_date)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    reviewInsert.run(workspaceId, supplierId, isoDate(-20), reviewer.name, 'Conditional approval retained', 81, 9,
      'One medium enhancement remains open; the prior high finding is closed.', 'Track subprocessor-notification enhancement to closure.', isoDate(70));
    reviewInsert.run(workspaceId, supplierId, isoDate(-110), reviewer.name, 'Monitoring satisfactory', 81, 10,
      'No new material exceptions.', 'Continue quarterly resilience and vulnerability monitoring.', isoDate(-20));

    const monitoringInsert = db.prepare(`INSERT INTO supplier_monitoring
      (workspace_id,supplier_id,source,score,grade,recorded_at,notes,recorded_by) VALUES (?,?,?,?,?,?,?,?)`);
    [[-100,89,'A-'],[-70,91,'A'],[-40,92,'A'],[-10,94,'A']].forEach(([offset, score, grade]) => {
      monitoringInsert.run(workspaceId, supplierId, 'Quarterly supplier oversight', score, grade, isoDate(offset),
        'SLA, security events, vulnerability closure and resilience metrics remained within the approved thresholds.', reviewer.id);
    });

    db.prepare(`INSERT INTO supplier_notes
      (workspace_id,supplier_id,user_name,body,internal_only,created_at) VALUES (?,?,?,?,1,?)`)
      .run(workspaceId, supplierId, reviewer.name,
        'Synthetic demo note: management should focus on the decision lineage, evidence-backed questionnaire and the remaining medium improvement action.', isoTime(-18));

    const clauses = [
      ['security_obligations','Information security obligations'],['confidentiality','Confidentiality and non-disclosure'],
      ['breach_notification','Security incident notification'],['audit_rights','Right to audit and receive assurance reports'],
      ['subprocessor_approval','Subprocessor approval and notification'],['data_return_destruction','Data return and verified deletion'],
      ['service_levels','Service levels and remedies'],['change_management','Material change notification'],
      ['dpa','Data processing agreement'],['liability_indemnity','Liability and indemnity'],
    ];
    const clauseInsert = db.prepare(`INSERT INTO supplier_clauses
      (workspace_id,supplier_id,clause_key,clause_label,status,notes,reviewed_at) VALUES (?,?,?,?,'compliant',?,?)`);
    clauses.forEach(([key, label]) => clauseInsert.run(workspaceId, supplierId, key, label, 'Verified in the executed synthetic agreement.', isoTime(-24)));

    const controlInsert = db.prepare('INSERT INTO supplier_controls (supplier_id,iso_item_id,notes) VALUES (?,?,?)');
    const controls = db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 12").all();
    controls.forEach(control => controlInsert.run(supplierId, control.id, 'Relevant supplier control supported by the completed due-diligence record.'));

    db.prepare(`INSERT INTO audit_log
      (workspace_id,user_id,action,entity_type,entity_id,details,created_at)
      VALUES (?,?, 'seed_complete_supplier_demo','supplier',?,?,?)`)
      .run(workspaceId, owner.id, String(supplierId), JSON.stringify({ synthetic: true, inherentId, ddqId, contractId, decisionId, questions: questions.length }), isoTime(-18));

    return {
      supplierId,
      url: `/workspaces/${workspaceId}/vendors/${supplierId}`,
      name: DEMO_NAME,
      inherentAssessment: { id: inherentId, status: 'approved', score: inherentResult.weightedScore, tier: inherentResult.assignedTier, responses: 25 },
      dueDiligence: { id: ddqId, status: 'complete', questions: questions.length, evidenceRecords: questions.length },
      contractReview: { id: contractId, status: 'complete', clauses: supplierRisk.methodology.contractClauses.length },
      decision: { id: decisionId, value: 'conditional', residualRisk: 'moderate' },
      findings: { closedHigh: highFindingId, openMedium: mediumFindingId },
      documents: documentSpecs.length,
      synthetic: true,
    };
  })();
} catch (error) {
  newlyCreatedFiles.forEach(file => { try { fs.unlinkSync(file); } catch (_) {} });
  db.close();
  throw error;
}

db.close();
console.log(JSON.stringify(result, null, 2));
