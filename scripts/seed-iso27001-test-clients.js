#!/usr/bin/env node
'use strict';

// Creates exactly two production-shaped, synthetic ISO 27001 clients:
//   1. a completed gap-assessment-only engagement; and
//   2. an active certification-support implementation engagement.
//
// The seeder is intentionally exact-name scoped and idempotent. Content-addressed
// evidence is materialized and verified before the one outer database transaction.
// A failed transaction removes only files created by that run; stale seed-owned
// files are removed only after commit.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

const INTAKE = require('../data/intake-questions');
const controlWrites = require('../lib/control-writes');
const docLinks = require('../lib/doc-links');
const evidenceWrites = require('../lib/evidence-writes');
const assessmentPassQuality = require('../lib/assessment-pass-quality');
const consultingDelivery = require('../lib/consulting-delivery');
const engagementDelivery = require('../lib/engagement-delivery');
const gapFieldwork = require('../lib/gap-fieldwork');
const tprmDomain = require('../lib/tprm-domain');
const tprmRelationships = require('../lib/tprm-relationships');
const { deleteWorkspace } = require('../lib/workspace-deletion');

// Load the database only after the upload root has passed a real create/read/
// delete probe. An invalid DEMO_SEED_UPLOAD_ROOT therefore cannot open, migrate
// or otherwise mutate the configured database as a side effect of this script.
let db;
let init;
let ensureWorkspaceMethodology;
let logAction;

const PROJECT_ROOT = path.join(__dirname, '..');
const UPLOAD_ROOT = process.env.DEMO_SEED_UPLOAD_ROOT
  ? path.resolve(process.env.DEMO_SEED_UPLOAD_ROOT)
  : path.join(PROJECT_ROOT, 'uploads');
const SEED_FILE_PREFIX = 'nimbus-iso27001-test-v1__';
const SEED_VERSION = 1;
const ANCHOR_DATE = '2026-08-26';
const LOCAL_PASSWORD = 'NimbusDemo!2026';

const SCENARIOS = Object.freeze([
  Object.freeze({
    key: 'gap',
    clientName: 'BluePeak Health - ISO 27001 Gap Assessment',
    displayName: 'BluePeak Health',
    legalName: 'BluePeak Health Technologies Ltd.',
    email: 'bluepeak.owner.iso27001-test@demo.invalid',
    clientOwnerName: 'Dr Maya Shah',
    editorEmail: 'bluepeak.isms-editor.iso27001-test@demo.invalid',
    editorName: 'BluePeak ISMS Manager',
    industry: 'Digital health services',
    sector: 'healthcare',
    color: '#315C73',
    outcome: 'gap_assessment_only',
    stage: 'gap_assessment',
    targetDate: null,
    intakeCount: 26,
    scope: 'The BluePeak patient engagement platform, UK cloud production environment, engineering and support operations, corporate identity services, regulated patient and customer information, and the people and suppliers operating those services.',
    assessmentStart: '2026-05-01',
    assessmentEnd: '2026-07-31',
  }),
  Object.freeze({
    key: 'implementation',
    clientName: 'Northbridge Payments - ISO 27001 Implementation',
    displayName: 'Northbridge Payments',
    legalName: 'Northbridge Payments Services Ltd.',
    email: 'northbridge.owner.iso27001-test@demo.invalid',
    clientOwnerName: 'Elena Wright',
    editorEmail: 'northbridge.isms-editor.iso27001-test@demo.invalid',
    editorName: 'Northbridge ISMS Manager',
    industry: 'Payment technology',
    sector: 'financial',
    color: '#254E70',
    outcome: 'certification_support',
    stage: 'implementation',
    targetDate: '2027-03-31',
    intakeCount: 27,
    scope: 'The Northbridge payment orchestration platform, customer onboarding and fraud operations, UK and EU cloud production, corporate technology, software engineering, security operations, and critical service suppliers supporting regulated payment services.',
    assessmentStart: '2026-02-01',
    assessmentEnd: '2026-07-31',
  }),
]);

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function addDays(dateText, days) {
  const value = new Date(`${dateText}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function sqlDateTime(dateText, hour = 12) {
  return `${dateText} ${String(hour).padStart(2, '0')}:00:00`;
}

function scalar(sql, ...params) {
  return Number(db.prepare(sql).get(...params).c || 0);
}

function normalizeFileName(value) {
  const name = path.basename(String(value || ''));
  if (!name.startsWith(SEED_FILE_PREFIX) || name !== value) {
    throw new Error(`Unsafe synthetic evidence filename: ${value}`);
  }
  return name;
}

function preflightUploadRoot() {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true, mode: 0o700 });
  const probeDir = fs.mkdtempSync(path.join(UPLOAD_ROOT, '.nimbus-iso27001-preflight-'));
  const probePath = path.join(probeDir, 'create-read-delete.probe');
  try {
    const bytes = Buffer.from('nimbus iso27001 seed upload preflight\n', 'utf8');
    fs.writeFileSync(probePath, bytes, { flag: 'wx', mode: 0o600 });
    assert.deepEqual(fs.readFileSync(probePath), bytes, 'Upload-root preflight read verification failed.');
    fs.unlinkSync(probePath);
  } finally {
    if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
    fs.rmdirSync(probeDir);
  }
}

function resolveFirmAndManager() {
  const requestedFirm = process.env.DEMO_SEED_FIRM_ID
    ? Number(process.env.DEMO_SEED_FIRM_ID)
    : null;
  if (requestedFirm != null && (!Number.isInteger(requestedFirm) || requestedFirm < 1)) {
    throw new Error('DEMO_SEED_FIRM_ID must be a positive integer.');
  }
  const eligibleFirms = db.prepare(`SELECT DISTINCT u.firm_id
    FROM users u JOIN firms f ON f.id=u.firm_id
    WHERE u.user_type='firm' AND u.active=1
      AND u.firm_role IN ('manager','firm_owner','owner')
    ORDER BY u.firm_id`).all();
  if (requestedFirm == null && eligibleFirms.length > 1) {
    throw new Error('Multiple eligible consulting firms exist; set DEMO_SEED_FIRM_ID explicitly.');
  }
  const manager = db.prepare(`SELECT u.id,u.name,u.email,u.firm_id,u.firm_role,f.name AS firm_name
    FROM users u JOIN firms f ON f.id=u.firm_id
    WHERE u.user_type='firm' AND u.active=1
      AND u.firm_role IN ('manager','firm_owner','owner')
      AND u.firm_id=?
    ORDER BY CASE u.firm_role WHEN 'manager' THEN 0 WHEN 'firm_owner' THEN 1 ELSE 2 END,u.id
    LIMIT 1`).get(requestedFirm || eligibleFirms[0]?.firm_id || null);
  if (!manager) {
    throw new Error(requestedFirm
      ? `No active firm manager exists for firm ${requestedFirm}.`
      : 'No active consulting-firm manager exists.');
  }
  return manager;
}

function ensureSeedUser({ email, name, userType, firmId, firmRole, passwordHash }) {
  const seedAccountCreatedAt = sqlDateTime(addDays(ANCHOR_DATE, -190), 0);
  const existing = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email);
  if (existing) {
    if (existing.user_type !== userType) {
      throw new Error(`Seed account ${email} already exists with user_type=${existing.user_type}.`);
    }
    if (existing.firm_id != null && Number(existing.firm_id) !== Number(firmId)) {
      throw new Error(`Seed account ${email} belongs to another firm.`);
    }
    const foreignMembership = db.prepare(`SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id=? AND NOT EXISTS (
        SELECT 1 FROM audit_log a WHERE a.workspace_id=wm.workspace_id
          AND a.action='seed_iso27001_test_client' AND a.entity_type='workspace'
      ) LIMIT 1`).get(existing.id);
    if (foreignMembership) {
      throw new Error(`Refusing to rotate reserved seed account ${email}; it belongs to non-seed workspace ${foreignMembership.workspace_id}.`);
    }
    db.prepare(`UPDATE users SET name=?,password_hash=?,firm_id=?,firm_role=?,active=1,
      auth_epoch=COALESCE(auth_epoch,0)+1,
      created_at=CASE WHEN created_at IS NULL OR julianday(created_at)>julianday(?) THEN ? ELSE created_at END
      WHERE id=?`)
      .run(name, passwordHash, firmId, firmRole || null,
        seedAccountCreatedAt, seedAccountCreatedAt, existing.id);
    assert.equal(db.prepare('SELECT auth_epoch FROM users WHERE id=?').get(existing.id).auth_epoch,
      Number(existing.auth_epoch || 0) + 1, `Auth epoch was not advanced for ${email}.`);
    try {
      db.prepare(`DELETE FROM sessions
        WHERE CAST(json_extract(sess,'$.userId') AS INTEGER)=?`).run(existing.id);
    } catch (_) {
      try {
        const sessions = db.prepare('SELECT sid,sess FROM sessions').all();
        const removeSession = db.prepare('DELETE FROM sessions WHERE sid=?');
        for (const session of sessions) {
          try {
            if (Number(JSON.parse(session.sess).userId) === Number(existing.id)) removeSession.run(session.sid);
          } catch (_) { /* leave malformed or foreign session rows untouched */ }
        }
      } catch (_) { /* the session store is optional until the web server starts */ }
    }
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='password_reset_tokens'`).get()) {
      db.prepare(`UPDATE password_reset_tokens SET used_at=datetime('now')
        WHERE user_id=? AND used_at IS NULL`).run(existing.id);
    }
    return Number(existing.id);
  }
  return Number(db.prepare(`INSERT INTO users
    (email,password_hash,name,user_type,firm_id,firm_role,active,created_at)
    VALUES (?,?,?,?,?,?,1,?)`).run(
      email, passwordHash, name, userType, firmId, firmRole || null, seedAccountCreatedAt
    ).lastInsertRowid);
}

function assertSeedOwnedCollision(workspace) {
  const scenario = SCENARIOS.find(item => item.clientName === workspace.client_name);
  assert.ok(scenario, `Unexpected exact-name seed collision for workspace ${workspace.id}.`);
  const marker = db.prepare(`SELECT 1 FROM audit_log
    WHERE workspace_id=? AND action='seed_iso27001_test_client'
      AND entity_type='workspace' AND entity_id=? LIMIT 1`).get(workspace.id, String(workspace.id));
  const owner = db.prepare(`SELECT 1 FROM workspace_members wm JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? AND wm.role='client_owner' AND lower(u.email)=lower(?) LIMIT 1`).get(
      workspace.id, scenario.email
    );
  if (!marker || !owner) {
    throw new Error(`Refusing to replace exact-name workspace ${workspace.id}; it lacks the seed ownership marker or reserved client owner.`);
  }
}

function isoRequirements() {
  const rows = db.prepare(`SELECT r.id AS requirement_id,r.ref,r.title,r.req_type,r.sort_order,i.type,i.category
    FROM requirements r
    JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001' AND f.status='active'
    JOIN iso_items i ON i.id=r.ref AND i.type IN ('clause','control')
    ORDER BY r.sort_order,r.id`).all();
  assert.equal(rows.length, 118, 'The active ISO 27001 catalog must contain 25 clauses and 93 controls.');
  assert.equal(new Set(rows.map(row => row.requirement_id)).size, 118, 'ISO requirement ids must be unique.');
  return rows;
}

function evidencePackets(scenario, requirements) {
  const packetCount = 12;
  const groups = Array.from({ length: packetCount }, () => []);
  requirements.forEach((row, index) => groups[index % packetCount].push(row));
  return groups.map((rows, index) => {
    const packet = String(index + 1).padStart(2, '0');
    const body = [
      'NIMBUS SYNTHETIC ISO 27001 TEST EVIDENCE',
      `Seed version: ${SEED_VERSION}`,
      `Scenario: ${scenario.clientName}`,
      `Evidence packet: ${packet} of ${packetCount}`,
      `Assessment period: ${scenario.assessmentStart} to ${scenario.assessmentEnd}`,
      'Purpose: deterministic test evidence for UI, authorization, export, backup and restore validation.',
      'Procedure: the synthetic consultant inspected the listed governed records and retained this packet as the reproducible assessment source.',
      'Requirements:',
      ...rows.map(row => `- ${row.ref} | ${row.title}`),
      '',
      'SYNTHETIC TEST DATA - NOT A REAL ASSURANCE CONCLUSION.',
      '',
    ].join('\n');
    const buffer = Buffer.from(body, 'utf8');
    const sha256 = sha(buffer);
    const filename = `${SEED_FILE_PREFIX}${scenario.key}__packet-${packet}__${sha256.slice(0, 16)}.txt`;
    return {
      scenarioKey: scenario.key,
      filename: normalizeFileName(filename),
      buffer,
      sha256,
      sizeBytes: buffer.length,
      requirements: rows,
    };
  });
}

function seedWorkspace(
  scenario, manager, reviewerId, clientOwnerId, clientEditorId, requirements, packets, importTimestamp
) {
  const workspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,target_cert_date,stage,lead_consultant_id,
     scope_confirmed_at,scope_confirmed_by,brand_display_name,brand_primary_color,
     sector,locale,frameworks,timezone,engagement_outcome,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'["iso27001"]','Europe/London',?,?,datetime('now'))`).run(
      manager.firm_id, scenario.clientName, scenario.industry, scenario.scope,
      scenario.targetDate, scenario.stage, manager.id,
      sqlDateTime(addDays(ANCHOR_DATE, -90)), manager.id,
      scenario.displayName, scenario.color, scenario.sector, 'en-GB',
      scenario.outcome, sqlDateTime(addDays(ANCHOR_DATE, -180))
    ).lastInsertRowid);

  ensureWorkspaceMethodology(workspaceId);
  const membershipCreatedAt = sqlDateTime(addDays(ANCHOR_DATE, -179), 0);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,'firm_owner',?)`)
    .run(workspaceId, manager.id, membershipCreatedAt);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,'senior_consultant',?)`)
    .run(workspaceId, reviewerId, membershipCreatedAt);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,'client_owner',?)`)
    .run(workspaceId, clientOwnerId, membershipCreatedAt);
  db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,'isms_manager',?)`)
    .run(workspaceId, clientEditorId, membershipCreatedAt);

  seedIntake(workspaceId, scenario, manager.id);
  const registers = seedCoreRegisters(workspaceId, scenario, manager.id, importTimestamp);
  seedControlInstances(workspaceId, scenario, manager.id, requirements);
  const documents = seedDocuments(workspaceId, scenario, clientEditorId, clientOwnerId, requirements);
  const evidence = seedEvidence(workspaceId, scenario, manager.id, packets);

  let workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  workspace.frameworks = ['iso27001'];
  let engagement = consultingDelivery.ensureEngagement(db, workspace, manager.id);
  db.prepare(`UPDATE consulting_engagements SET
      name=?,engagement_type=?,scope_statement=?,included_entities=?,included_locations=?,included_systems=?,exclusions=?,
      assessment_period_start=?,assessment_period_end=?,status='active',lead_consultant_id=?,quality_reviewer_id=?,client_sponsor_id=?,
      start_date=?,target_date=?,created_at=?,updated_at=datetime('now'),row_version=row_version+1
    WHERE id=? AND workspace_id=?`).run(
      scenario.outcome === 'gap_assessment_only'
        ? `${scenario.displayName} ISO 27001 gap assessment`
        : `${scenario.displayName} ISO 27001 implementation and certification support`,
      scenario.outcome === 'gap_assessment_only' ? 'gap_assessment' : 'implementation',
      scenario.scope, scenario.legalName, 'London office; UK remote workforce; EU cloud regions',
      'Production SaaS, corporate identity, endpoint fleet, source control, CI/CD and security monitoring',
      'Dormant legal entities and public marketing sites with no production access',
      scenario.assessmentStart, scenario.assessmentEnd, manager.id, reviewerId, clientOwnerId,
      addDays(ANCHOR_DATE, -170), scenario.targetDate, sqlDateTime(addDays(ANCHOR_DATE, -175), 0),
      engagement.id, workspaceId
    );
  db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team
    (engagement_id,user_id,role,planned_hours,assigned_by) VALUES (?,?,'quality_reviewer',?,?)`)
    .run(engagement.id, reviewerId, scenario.key === 'gap' ? 72 : 180, manager.id);
  db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team
    (engagement_id,user_id,role,planned_hours,assigned_by) VALUES (?,?,'client_sponsor',?,?)`)
    .run(engagement.id, clientOwnerId, scenario.key === 'gap' ? 36 : 96, manager.id);
  db.prepare(`UPDATE consulting_engagement_team SET assigned_at=? WHERE engagement_id=?`).run(
    sqlDateTime(addDays(ANCHOR_DATE, -174), 0), engagement.id
  );
  db.prepare(`UPDATE engagement_commercials SET
      currency='GBP',contract_value_minor=?,planned_hours=?,internal_cost_rate_minor=6500,
      billing_model=?,billing_status=?,invoiced_minor=?,collected_minor=?,updated_by=?,updated_at=datetime('now'),row_version=row_version+1
    WHERE engagement_id=?`).run(
      scenario.key === 'gap' ? 4800000 : 18500000,
      scenario.key === 'gap' ? 320 : 1650,
      scenario.key === 'gap' ? 'fixed_fee' : 'milestone',
      scenario.key === 'gap' ? 'fully_billed' : 'in_progress',
      scenario.key === 'gap' ? 4800000 : 9500000,
      scenario.key === 'gap' ? 4800000 : 7800000,
      manager.id, engagement.id
    );
  seedTimeEntries(engagement.id, manager.id, reviewerId, scenario.key, importTimestamp);

  const pass = seedAssessmentPass(workspace, scenario, manager.id, reviewerId, requirements);
  // Materialising the pass adds the assessment preparer as a governed team
  // member. Align that parent assignment with the engagement before any of
  // the retained delivery time attributed to the team.
  db.prepare(`UPDATE consulting_engagement_team SET assigned_at=? WHERE engagement_id=?`).run(
    sqlDateTime(addDays(ANCHOR_DATE, -174), 0), engagement.id
  );
  engagement = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(engagement.id);

  const plan = engagementDelivery.ensurePlan(db, workspace, manager.id);
  assert.ok(plan, 'ISO 27001 workspace must have a delivery plan.');
  db.prepare(`UPDATE engagement_delivery_plans SET consulting_engagement_id=? WHERE id=?`)
    .run(engagement.id, plan.id);
  populateDeliveryPlan(workspace, plan.id, manager.id, reviewerId, evidence, scenario.key);
  passPlanGate(workspace, reviewerId, 'mobilisation');

  const gapReportId = seedGapAssessmentOperations(
    workspace, pass, engagement.id, manager.id, reviewerId, clientOwnerId, requirements, evidence
  );
  if (scenario.key === 'gap') {
    const position = gapFieldwork.assessmentContext(db, workspace);
    assert.equal(position.closure.ready, true, `Gap closure blockers: ${position.closure.blockers.join('; ')}`);
    const completionNote = 'The independently approved report was released and the gap-assessment-only contract ended at that controlled report. Confirmed findings remain client-owned recommendations and are not represented as remediated or closed.';
    db.prepare(`UPDATE consulting_engagements SET status='complete',completed_at=datetime('now'),completion_note=?,
      updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND workspace_id=?`).run(
        completionNote, engagement.id, workspaceId
      );
    consultingDelivery.event(db, workspaceId, engagement.id, manager.id, 'engagement', engagement.id,
      'completed_at_report', { report_id: gapReportId, open_findings_retained: 3, synthetic: true });
    engagementDelivery.syncOutcomePlanStatus(db, workspace, manager.id);
  } else {
    seedImplementationOperations(
      workspaceId, manager.id, reviewerId, clientOwnerId, requirements, registers, evidence
    );
    passImplementationPlanGates(workspace, reviewerId);
  }

  logAction(manager.id, workspaceId, 'seed_iso27001_test_client', 'workspace', workspaceId, {
    synthetic: true,
    seed_version: SEED_VERSION,
    scenario: scenario.key,
    engagement_outcome: scenario.outcome,
  });

  return {
    scenario,
    workspaceId,
    clientOwnerId,
    clientEditorId,
    reviewerId,
    engagementId: engagement.id,
    planId: plan.id,
    passId: pass.id,
    evidenceIds: evidence.map(row => row.id),
    documentIds: documents,
    reportId: gapReportId,
  };
}

function passPlanGate(workspace, actorId, phaseKey) {
  // The canonical gap-only projection exposes only its governed assessment
  // phase. Retain a governed decision for the raw mobilisation phase without
  // temporarily changing the stored contract outcome or its plan metadata.
  if (workspace.engagement_outcome === 'gap_assessment_only' && phaseKey === 'mobilisation') {
    const phase = db.prepare(`SELECT ph.* FROM engagement_delivery_phases ph
      JOIN engagement_delivery_plans p ON p.id=ph.plan_id
      WHERE p.workspace_id=? AND ph.phase_key='mobilisation'`).get(workspace.id);
    assert.ok(phase, 'Gap-only mobilisation phase is missing.');
    const milestones = db.prepare(`SELECT id,title,status FROM engagement_delivery_milestones
      WHERE phase_id=? AND is_required=1 ORDER BY id`).all(phase.id);
    assert.ok(milestones.length > 0 && milestones.every(item => item.status === 'complete'),
      'Gap-only mobilisation milestones must be complete before its gate passes.');
    const criteria = JSON.stringify(milestones.map(item => ({
      id: item.id, label: item.title, status: item.status, pass: item.status === 'complete',
    })));
    const evidenceSnapshot = JSON.stringify({ captured_at: new Date().toISOString(), milestones });
    db.prepare(`INSERT INTO engagement_delivery_gate_decisions
      (phase_id,decision,criteria_snapshot,snapshot_hash,note,decided_by,evidence_snapshot_json)
      VALUES (?,'passed',?,?,?,?,?)`).run(
        phase.id, criteria, sha(criteria + evidenceSnapshot),
        'Synthetic mobilisation gate passed after every required deliverable was independently accepted.',
        actorId, evidenceSnapshot
      );
    db.prepare(`UPDATE engagement_delivery_phases SET status='complete',actual_end_date=date('now'),updated_at=datetime('now')
      WHERE id=?`).run(phase.id);
    db.prepare(`INSERT INTO engagement_delivery_events
      (workspace_id,plan_id,entity_type,entity_id,action,from_status,to_status,details,actor_id)
      VALUES (?,?,'phase_gate',?,'passed','in_progress','complete',?,?)`).run(
        workspace.id, phase.plan_id, phase.id,
        JSON.stringify({ note: 'All required mobilisation deliverables accepted.', synthetic: true }), actorId
      );
    return;
  }
  const projection = engagementDelivery.getProjection(db, workspace, actorId);
  const phase = projection.phases.find(item => item.phase_key === phaseKey);
  assert.ok(phase, `Delivery phase ${phaseKey} is missing.`);
  assert.equal(phase.gate_ready, true, `Delivery phase ${phaseKey} is not ready to pass.`);
  engagementDelivery.decideGate(db, workspace, actorId, phase.id, 'passed',
    `Synthetic phase gate passed after every required ${phaseKey} deliverable was accepted with evidence.`);
}

function passImplementationPlanGates(workspace, actorId) {
  for (const phaseKey of ['context', 'assessment', 'treatment']) passPlanGate(workspace, actorId, phaseKey);
  const projection = engagementDelivery.getProjection(db, workspace, actorId);
  assert.equal(projection.currentPhase?.phase_key, 'implementation',
    'The populated certification-support journey must be actively in implementation.');
}

function seedIntake(workspaceId, scenario, actorId) {
  const answers = {
    'org-name': scenario.legalName,
    'trading-name': scenario.displayName,
    'business-summary': `${scenario.displayName} provides ${scenario.industry.toLowerCase()} to regulated and security-conscious customers through a cloud-operated service.`,
    'cert-driver': scenario.key === 'gap'
      ? 'The board commissioned an independent ISO 27001 gap assessment before approving a later implementation programme.'
      : 'Customer commitments, regulated growth and the board-approved 2027 certification objective require a governed implementation programme.',
    'cert-deadline': scenario.targetDate || 'No certification deadline is in scope for this gap-assessment-only engagement.',
    'products-in-scope': scenario.scope,
    'products-excluded': 'Public marketing content, dormant legal entities and isolated development experiments with no production data or access.',
    'infra-model': 'Cloud-dominant (mostly cloud, some on-prem)',
    'physical-locations': 'London office\nUK remote workforce\nEU cloud regions operated by approved providers',
    'onprem-footprint': 'Managed office networking, meeting-room systems and encrypted employee endpoints; production workloads are hosted in governed cloud regions.',
    'remote-workers': scenario.key === 'gap' ? '86' : '142',
    'cloud-providers': 'Microsoft Azure\nMicrosoft 365\nGitHub\nCloudflare',
    'data-types': scenario.key === 'gap'
      ? 'Personal data (PII)\nSpecial category / health (PHI)\nIntellectual property\nInternal business data'
      : 'Personal data (PII)\nCardholder data (PCI)\nIntellectual property\nInternal business data',
    'customer-geography': 'UK\nEU / EEA\nUnited States',
    'headcount-total': scenario.key === 'gap' ? '184' : '268',
    'isms-owner': 'Chief Information Security Officer',
    'isms-coordinator': 'Governance, Risk and Compliance Manager',
    'isac-frequency': 'Monthly working group with quarterly executive management review.',
    'key-customers': 'Regulated enterprise customers requiring contractual security schedules, annual assurance and prompt incident notification.',
    'key-regulators': scenario.key === 'gap' ? 'UK ICO and healthcare-sector supervisory bodies' : 'UK FCA, UK ICO and applicable EU supervisory authorities',
    'key-suppliers': 'Microsoft Azure for production hosting\nMicrosoft 365 for collaboration\nGitHub for source control and CI/CD\nCloudflare for edge protection',
    'crown-jewel-1': 'Customer production data and tenant encryption keys',
    'crown-jewel-2': 'Production cloud subscriptions and privileged identities',
    'crown-jewel-3': 'Source code, build pipelines and signed deployment artifacts',
    'existing-frameworks': scenario.key === 'gap' ? 'Cyber Essentials\nGDPR programme' : 'SOC 2\nPCI DSS\nCyber Essentials Plus\nGDPR programme',
    'existing-policies': scenario.key === 'gap' ? '14' : '24',
    'recent-incidents': 'One contained credential-phishing event with no confirmed data loss; root cause, response actions and lessons learned were retained.',
  };
  if (scenario.intakeCount === 26) delete answers['cert-deadline'];
  const known = new Set(INTAKE.flatten().map(question => question.id));
  assert.equal(Object.keys(answers).length, scenario.intakeCount);
  for (const [questionId, answer] of Object.entries(answers)) {
    assert.ok(known.has(questionId), `Unknown intake question ${questionId}`);
    assert.ok(String(answer).trim().length >= 2, `Empty intake answer ${questionId}`);
    db.prepare(`INSERT INTO engagement_intake
      (workspace_id,question_id,answer,answered_by,answered_at) VALUES (?,?,?,?,?)`)
      .run(workspaceId, questionId, answer, actorId, sqlDateTime(addDays(ANCHOR_DATE, -105)));
  }
}

function seedCoreRegisters(workspaceId, scenario, actorId, importTimestamp) {
  const assetSeeds = [
    ['Customer production platform','service','restricted','Chief Technology Officer',3,3,3,'Tier-one customer service, APIs and operational dependencies.','critical',2,1],
    ['Customer regulated data','information','restricted','Data Protection Officer',3,3,2,'Customer, account and regulated service information.','critical',4,1],
    ['Cloud production environment','service','confidential','Head of Platform',3,3,3,'Cloud subscriptions, networks, compute, storage and managed databases.','critical',2,1],
    ['Enterprise identity platform','service','confidential','IT Director',3,3,3,'Workforce SSO, privileged access and lifecycle automation.','critical',4,1],
    ['Source code and CI/CD','service','confidential','VP Engineering',3,3,2,'Repositories, build pipelines and deployment credentials.','high',8,2],
    ['Security monitoring platform','service','confidential','Security Operations Lead',2,3,3,'Central telemetry, alerting and response workflow.','high',4,1],
  ];
  const assetInsert = db.prepare(`INSERT INTO assets
    (workspace_id,name,type,classification,owner_name,cia_c,cia_i,cia_a,description,business_criticality,rto_hours,rpo_hours,bia_notes,source_type,source_ref,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'seed',?,?,?,?)`);
  const assetIds = {};
  assetSeeds.forEach((seed, index) => {
    assetIds[seed[0]] = Number(assetInsert.run(
      workspaceId, ...seed,
      'Recovery objectives are approved by the accountable service owner and exercised at least annually.',
      `iso27001-test-client:${index + 1}`, actorId, importTimestamp, importTimestamp
    ).lastInsertRowid);
  });

  const riskSeeds = [
    ['Privileged identity compromise','Stolen privileged credentials could permit unauthorised production changes.','Enterprise identity platform','Credential theft','Phishing-resistant MFA coverage is incomplete',4,5,2,4],
    ['Cloud configuration exposure','A material cloud misconfiguration could expose regulated customer data.','Cloud production environment','Misconfiguration','Preventive guardrails do not cover every inherited environment',3,5,2,3],
    ['Software supply-chain compromise','A compromised dependency or build credential could introduce malicious code.','Source code and CI/CD','Supply-chain attack','Provenance and signing coverage is uneven',3,5,2,3],
    ['Critical supplier outage','A concentration failure could interrupt customer services beyond recovery objectives.','Customer production platform','Supplier failure','Tested exit options are limited',3,4,2,3],
    ['Delayed incident escalation','A material incident may not reach decision-makers within contractual timelines.','Security monitoring platform','Complex attack','Escalation criteria are not consistently exercised',3,4,2,2],
    ['Sensitive data over-retention','Regulated records could remain beyond approved business and legal periods.','Customer regulated data','Internal misuse','Legacy deletion jobs do not cover every store',3,4,2,2],
  ];
  const riskInsert = db.prepare(`INSERT INTO risks
    (workspace_id,title,description,asset_id,threat,vulnerability,likelihood,impact,treatment,owner_name,status,residual_likelihood,residual_impact,is_systemic)
    VALUES (?,?,?,?,?,?,?,?,'modify',?,'open',?,?,?)`);
  const riskIds = [];
  riskSeeds.forEach((seed, index) => {
    riskIds.push(Number(riskInsert.run(
      workspaceId, seed[0], seed[1], assetIds[seed[2]], seed[3], seed[4], seed[5], seed[6],
      index === 0 ? 'CISO' : seed[2] === 'Customer regulated data' ? 'Data Protection Officer' : 'Head of Platform',
      seed[7], seed[8], index < 2 ? 1 : 0
    ).lastInsertRowid));
  });
  const riskControlRefs = [
    ['annex-a.5.15', 'annex-a.5.17', 'annex-a.8.2'],
    ['annex-a.8.9', 'annex-a.8.20'],
    ['annex-a.8.25', 'annex-a.8.28', 'annex-a.8.32'],
    ['annex-a.5.19', 'annex-a.5.22', 'annex-a.5.30'],
    ['annex-a.5.24', 'annex-a.5.26'],
    ['annex-a.5.33', 'annex-a.8.10'],
  ];
  const linkRiskControl = db.prepare('INSERT INTO risk_controls (risk_id,iso_item_id) VALUES (?,?)');
  riskIds.forEach((riskId, index) => riskControlRefs[index].forEach(ref => linkRiskControl.run(riskId, ref)));
  assert.equal(scalar(`SELECT COUNT(*) c FROM risks r
    WHERE r.workspace_id=? AND r.status='open'
      AND NOT EXISTS (SELECT 1 FROM risk_controls rc WHERE rc.risk_id=r.id)`, workspaceId), 0,
  'Every open risk must have at least one treatment-relevant ISO 27001 control.');

  const taskInsert = db.prepare(`INSERT INTO tasks
    (workspace_id,title,description,iso_item_id,risk_id,assignee_id,due_date,status,created_by,priority,estimated_minutes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const taskSeeds = scenario.key === 'gap' ? [
    ['Validate scope and sampling basis','Confirm legal entity, service boundary, sampling approach and material exclusions.','clause-4.3',null,-60,'done','high',180],
    ['Reconcile privileged identity population','Reconcile the administrative-account export to HR and service-owner records.','annex-a.5.18',0,-36,'done','high',300],
    ['Complete critical supplier interviews','Validate the current supplier-governance operating practice.','annex-a.5.19',3,-28,'done','medium',180],
    ['Issue factual validation pack','Share confirmed findings and retain client factual responses.','clause-9.1',null,-16,'done','high',240],
    ['Prepare controlled assessment report','Generate the report only from frozen workpapers and confirmed findings.','clause-9.1',null,-10,'done','high',360],
    ['Handover recommendations register','Explain that findings remain client-owned recommendations after report closure.','clause-10.1',null,-4,'done','medium',120],
  ] : [
    ['Complete privileged-access recertification','Validate owners and retain evidence for all production privileged roles.','annex-a.5.18',0,21,'in_progress','high',300],
    ['Close cloud guardrail exceptions','Resolve or accept ageing preventive-control exceptions.','annex-a.8.9',1,35,'in_progress','high',360],
    ['Test tier-one service recovery','Exercise application, identity, data and supplier recovery as one service.','annex-a.5.30',3,48,'todo','high',480],
    ['Refresh supplier assurance','Update due diligence and concentration-risk decisions for tier-one suppliers.','annex-a.5.22',3,28,'in_progress','medium',240],
    ['Run incident decision exercise','Test declaration, legal notification and executive decision authority.','annex-a.5.24',4,56,'todo','medium',240],
    ['Refresh retention schedule','Map every data store to approved retention and deletion controls.','annex-a.8.10',5,49,'todo','medium',210],
    ['Publish policy suite','Complete approvals and workforce communication for updated policies.','clause-7.5',null,14,'in_progress','high',420],
    ['Prepare internal audit evidence','Reconcile audit samples, findings and corrective actions.','clause-9.2',null,70,'todo','high',420],
  ];
  taskSeeds.forEach(seed => taskInsert.run(
    workspaceId, seed[0], seed[1], seed[2], seed[3] == null ? null : riskIds[seed[3]], actorId,
    addDays(ANCHOR_DATE, seed[4]), seed[5], actorId, seed[6], seed[7]
  ));

  return { assetIds, riskIds };
}

function assessmentStatus(scenario, index) {
  const conclusion = (display, maturity) => ({
    display,
    token: controlWrites.normStatus(display),
    maturity,
  });
  if (scenario.key === 'gap') {
    const slot = index % 10;
    if (slot < 3) return conclusion('Implemented', 4);
    if (slot < 7) return conclusion('Partially Implemented', 2);
    if (slot < 9) return conclusion('Not Implemented', 1);
    return conclusion('Work In Progress', 2);
  }
  const slot = index % 10;
  if (slot < 8) return conclusion('Implemented', index % 3 === 0 ? 5 : 4);
  if (slot === 8) return conclusion('Partially Implemented', 3);
  return conclusion('Work In Progress', 2);
}

function seedControlInstances(workspaceId, scenario, actorId, requirements) {
  const insert = db.prepare(`INSERT INTO control_instances
    (workspace_id,requirement_id,entity_id,applicability,status,maturity,scope_pct,
     inclusion_justification,notes,internal_notes,owner_id,due_date,next_review,review_status,last_verified_at,last_updated)
    VALUES (?,?,NULL,'applicable',?,?,?,?,?,?,?,?,?,'approved',?,?)`);
  requirements.forEach((row, index) => {
    const status = assessmentStatus(scenario, index);
    const gap = status.display !== 'Implemented';
    const notes = gap
      ? `${row.ref}: fieldwork found a specific implementation gap. Ownership and the next action are recorded; the status is not inferred from missing data.`
      : `${row.ref}: design and implementation were inspected against retained synthetic operating records for the stated assessment period.`;
    insert.run(
      workspaceId, row.requirement_id, status.token, status.maturity, 100,
      `${row.ref} is within the approved whole-organisation ISMS boundary and is required by the risk-based control framework.`,
      notes, 'Synthetic test record; not a real assurance conclusion.', actorId,
      gap ? addDays(ANCHOR_DATE, scenario.key === 'gap' ? 90 + index : 45 + index) : null,
      addDays(ANCHOR_DATE, 180), sqlDateTime(addDays(ANCHOR_DATE, -14)), sqlDateTime(addDays(ANCHOR_DATE, -14))
    );
  });
}

function finalizeDocumentContent(scenario, value) {
  const replacementFor = token => {
    const key = token.toLowerCase();
    if (key.includes('interval')) return 'quarterly, or sooner following material change';
    if (key.includes('retention')) return 'seven years unless a longer legal hold applies';
    if (key.includes('sla')) return 'five business days';
    if (key.includes('team') || key.includes('soc')) return 'Information Security Team';
    if (key.includes('channel')) return 'approved service desk and incident hotline';
    if (key.includes('exception')) return 'documented risk-acceptance workflow';
    if (key.includes('location')) return 'London office, approved remote locations and governed cloud regions';
    if (key.includes('quarterly meeting')) return 'Quarterly ISMS Steering Committee';
    if (key.includes('authentication standard')) return 'Access Control and Authentication Standard';
    if (key.startsWith('reference')) return `approved ${token.replace(/^reference\s*:?/i, '').trim() || 'controlled standard'}`;
    if (key.startsWith('define')) return 'documented risk-based value approved by the ISMS Steering Committee';
    if (key.includes('tier-1')) return 'tier-one production and customer services';
    if (key.includes('version')) return '1.0';
    if (key.includes('n/10')) return '8/10';
    if (key.includes('n/n')) return '8/8';
    if (key === 'n') return '8';
    if (key === '%') return scenario.key === 'gap' ? '70%' : '95%';
    if (key.includes('optional')) return 'not applicable for this approved baseline';
    if (key.includes('current state')) return scenario.key === 'gap'
      ? 'client-reported baseline retained for independent assessment'
      : 'implemented governed baseline with accountable improvement actions';
    return token.trim();
  };
  const provenance = scenario.key === 'gap'
    ? '> Provenance: Pre-existing client-authored assessment input. The consultancy did not implement or author this document.'
    : '> Governance status: Published client-authored ISMS document, independently approved by the client owner.';
  const finalized = String(value)
    .replace(/^> \*\*Starting point\.\*\*.*(?:\r?\n)?/gm, '')
    .replace(/^>\s*[^\n]*(?:\bstarter\s+(?:template|objective)s?\b|\breplace\s+bracketed\s+placeholders?\b|\badjust\s+to\s+[^\n]*\bcontext\b)[^\n]*(?:\r?\n)?/gim, '')
    .replace(/\{\{[^}\n]+\}\}/g, 'approved client-specific value')
    .replace(/\[([^\]\n]{1,240})\]/g, (_, token) => replacementFor(token))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const content = `${provenance}\n\n${finalized}\n`;
  assert.equal(/\{\{[^}]+\}\}|\[[^\]]+\]|\*\*Starting point\.\*\*/.test(content), false,
    'Published document content contains an unresolved starter marker.');
  assert.equal(/\bstarter\s+(?:template|objective)s?\b|\breplace\s+bracketed\s+placeholders?\b|\badjust\s+to\s+[^\n]*\bcontext\b/i.test(content), false,
    'Published document content contains template-authoring guidance.');
  assert.equal(/(^|[\s|])%(?=[\s|.,;:]|$)/m.test(content), false,
    'Published document content contains a bare percentage placeholder.');
  return content;
}

function seedDocuments(workspaceId, scenario, actorId, reviewerId, requirements) {
  const templates = db.prepare(`SELECT * FROM doc_templates WHERE is_system=1
    ORDER BY CASE tier WHEN 'mandatory' THEN 1 WHEN 'expected' THEN 2 WHEN 'recommended' THEN 3 ELSE 4 END,
      name,id LIMIT 12`).all();
  assert.ok(templates.length >= 8, 'At least eight system document templates are required.');
  assert.ok(templates.filter(template => template.tier === 'mandatory').length >= 8,
    'Published baseline must prioritize mandatory document templates.');
  const docIds = [];
  const linkedRecords = [];
  for (const [index, template] of templates.entries()) {
    let content = finalizeDocumentContent(scenario, String(template.content || '')
      .replace(/{{client_name}}/g, scenario.legalName)
      .replace(/{{scope}}/g, scenario.scope)
      .replace(/{{date}}/g, ANCHOR_DATE)
      .replace(/{{firm_name}}/g, 'Selected consulting firm')
      .replace(/{{document_owner}}/g, index % 2 ? 'Chief Information Security Officer' : 'Governance, Risk and Compliance Manager')
      .replace(/{{approval_authority}}/g, 'Executive ISMS Steering Committee')
      .replace(/{{review_period}}/g, 'Annual')
      .replace(/{{industry}}/g, scenario.industry));
    if (template.name === 'Statement of Applicability - cover page') {
      const applicabilityRows = db.prepare(`SELECT r.ref,r.title,ci.applicability,ci.status,
        COALESCE(ci.inclusion_justification,ci.exclusion_justification,'') justification
        FROM control_instances ci JOIN requirements r ON r.id=ci.requirement_id
        WHERE ci.workspace_id=? AND ci.entity_id IS NULL AND r.req_type='control'
        ORDER BY r.sort_order,r.id`).all(workspaceId);
      assert.equal(applicabilityRows.length, 93, 'The Statement of Applicability must enumerate all 93 Annex A controls.');
      const cell = value => String(value == null ? '' : value).replaceAll('|', '\\|').replaceAll('\n', ' ');
      content += [
        '',
        '## Annex A applicability and implementation register',
        '',
        '| Reference | Control | Applicability | Implementation status | Inclusion / exclusion justification |',
        '|---|---|---|---|---|',
        ...applicabilityRows.map(row => `| ${cell(row.ref)} | ${cell(row.title)} | ${cell(row.applicability)} | ${cell(row.status)} | ${cell(row.justification)} |`),
        '',
      ].join('\n');
    }
    const createdAt = sqlDateTime(addDays(ANCHOR_DATE, -43 - index));
    const approvedAt = sqlDateTime(addDays(ANCHOR_DATE, -41 - index));
    const publishedAt = sqlDateTime(addDays(ANCHOR_DATE, -40 - index));
    const docKind = String(template.category || 'record').trim().toLowerCase();
    assert.ok(['form','plan','policy','procedure','record'].includes(docKind),
      `Unsupported document kind derived from template ${template.name}: ${docKind}`);
    const documentId = Number(db.prepare(`INSERT INTO generated_docs
      (workspace_id,template_id,name,category,content,status,version,approved_by,approved_at,created_by,published_at,
       review_period_months,next_review_date,doc_kind,reference_code,controlled_copy,watermark,created_at,updated_at,locked)
      VALUES (?,?,?,?,?,'published',1,?,?,?, ?,12,?,?,?,1,'SYNTHETIC TEST DATA',?,?,1)`).run(
        workspaceId, template.id, template.name, template.category, content,
        reviewerId, approvedAt, actorId, publishedAt, addDays(ANCHOR_DATE, 320 - index),
        docKind, `${scenario.key.toUpperCase()}-DOC-${String(index + 1).padStart(3, '0')}`, createdAt, publishedAt
      ).lastInsertRowid);
    const contentHash = sha(Buffer.from(content, 'utf8'));
    const versionId = Number(db.prepare(`INSERT INTO doc_versions
      (workspace_id,document_id,version,name,content,content_hash,status,change_summary,created_by,created_at,submitted_at,approved_at,published_at)
      VALUES (?,?,1,?,?,?,'published','Synthetic governed baseline adopted from the system template.',?,?,?,?,?)`).run(
        workspaceId, documentId, template.name, content, contentHash, actorId,
        createdAt, sqlDateTime(addDays(ANCHOR_DATE, -42 - index)), approvedAt, publishedAt
      ).lastInsertRowid);
    db.prepare(`INSERT INTO doc_approvers
      (workspace_id,document_id,version_id,sequence,user_id,role_label,decision,decision_reason,decided_at,notified_at)
      VALUES (?,?,?,1,?,'Client owner','approved',?,?,?)`).run(
        workspaceId, documentId, versionId, reviewerId,
        'Approved after client-side review of scope, ownership, operational values and publication readiness.',
        approvedAt, sqlDateTime(addDays(ANCHOR_DATE, -42 - index))
      );
    db.prepare('UPDATE generated_docs SET current_version_id=? WHERE id=?').run(versionId, documentId);
    const parseRefs = value => {
      try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch (_) {
        throw new Error(`Document template ${template.id} has invalid declared requirement JSON.`);
      }
    };
    const declaredRefs = [...new Set([...parseRefs(template.clauses), ...parseRefs(template.controls)])];
    const refs = template.name === 'Statement of Applicability - cover page'
      ? requirements.filter(row => row.req_type === 'control').map(row => row.ref)
      : declaredRefs;
    assert.ok(refs.length > 0, `Selected document template ${template.name} declares no coverage.`);
    for (const ref of refs) {
      const result = docLinks.addLink(db, 'iso27001', documentId, ref,
        `Template-declared coverage for ${ref}`);
      assert.equal(result.changes, 1, `Document link missing for ${template.name} -> ${ref}`);
    }
    linkedRecords.push({ documentId, template, declaredRefs, refs });
    docIds.push(documentId);
  }
  for (const record of linkedRecords) {
    const actual = docLinks.linkedControlsForDoc(db, 'iso27001', record.documentId)
      .map(row => row.iso_item_id).sort();
    assert.deepEqual(actual, [...record.refs].sort(),
      `Document ${record.template.name} has false or missing requirement coverage.`);
    if (record.template.name !== 'Statement of Applicability - cover page') {
      assert.deepEqual(actual, [...record.declaredRefs].sort(),
        `Document ${record.template.name} must link only template-declared requirements.`);
    }
  }
  return docIds;
}

function seedEvidence(workspaceId, scenario, actorId, packets) {
  const rows = [];
  for (const [index, packet] of packets.entries()) {
    const evidenceId = Number(db.prepare(`INSERT INTO evidence
      (workspace_id,iso_item_id,filename,stored_path,sha256,size_bytes,uploaded_by,description,uploaded_at,
       retention_until,valid_from,valid_until,period_label,tags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, packet.requirements[0].ref, packet.filename, packet.filename,
        packet.sha256, packet.sizeBytes, actorId,
        `Deterministic synthetic evidence packet ${index + 1}; covers ${packet.requirements.length} ISO 27001 requirements with explicit converged links.`,
        sqlDateTime(addDays(ANCHOR_DATE, -35 - index)), '2033-08-26',
        scenario.assessmentStart, scenario.assessmentEnd, 'Governed synthetic assessment period',
        `synthetic-test-data, iso27001, ${scenario.key}, packet-${index + 1}`
      ).lastInsertRowid);
    packet.requirements.forEach(requirement => {
      assert.equal(evidenceWrites.attachIsoControl(db, evidenceId, requirement.ref), true,
        `Evidence requirement link missing for ${requirement.ref}`);
    });
    rows.push({ id: evidenceId, packet });
  }
  return rows;
}

function seedTimeEntries(engagementId, managerId, reviewerId, scenarioKey, importTimestamp) {
  const insert = db.prepare(`INSERT INTO engagement_time_entries
    (engagement_id,user_id,work_date,hours,category,description,billable,approved_by,approved_at,created_at)
    VALUES (?,?,?,?,?,?,1,?,?,?)`);
  const entries = scenarioKey === 'gap'
    ? [['planning',8],['client_meeting',7],['assessment',8],['workpaper',8],['review',6],['reporting',7]]
    : [['planning',8],['assessment',8],['workpaper',8],['client_meeting',6],['review',7],['remediation',8],['reporting',6],['administration',4]];
  entries.forEach(([category, hours], index) => insert.run(
    engagementId, index % 2 ? reviewerId : managerId, addDays(ANCHOR_DATE, -80 + index * 8), hours,
    category,
    `${category.replaceAll('_', ' ')} work completed for the synthetic ${scenarioKey} engagement.`,
    managerId, importTimestamp, importTimestamp
  ));
}

function seedAssessmentPass(workspace, scenario, managerId, reviewerId, requirements) {
  const passId = Number(db.prepare(`INSERT INTO assessment_passes
    (workspace_id,pass_number,label,notes,status,started_at,started_by)
    VALUES (?,1,?,?,'in_progress',?,?)`).run(
      workspace.id,
      scenario.key === 'gap' ? 'Independent ISO 27001 gap assessment' : 'Implementation baseline assessment',
      'Every ISO 27001 clause and Annex A control was concluded in the governed pass. Synthetic test data only.',
      sqlDateTime(addDays(ANCHOR_DATE, -60), 0), managerId
    ).lastInsertRowid);
  const history = db.prepare(`INSERT INTO control_state_history
    (workspace_id,iso_item_id,snapshot_at,changed_by,status,applicability,maturity,scope_pct,
     inclusion_justification,exclusion_justification,notes,assessment_answers,pass_id)
    VALUES (?,?,?,?,?,'included',?,100,?,NULL,?,?,?)`);
  requirements.forEach((row, index) => {
    const status = assessmentStatus(scenario, index);
    const notes = status.display === 'Implemented'
      ? `${row.ref}: implemented conclusion based on the linked deterministic evidence packet and recorded consultant verification.`
      : `${row.ref}: ${status.display.toLowerCase()} because the observed design or operating record does not yet meet the stated requirement; a specific next action is retained.`;
    history.run(
      workspace.id, row.ref, sqlDateTime(addDays(ANCHOR_DATE, -24 + (index % 8))), managerId,
      status.display, status.maturity,
      `${row.ref} is included in the approved whole-organisation assessment scope.`, notes,
      JSON.stringify({ version: 1, conclusion: status.display, observation: notes, synthetic: true }), passId
    );
  });
  const pass = db.prepare('SELECT * FROM assessment_passes WHERE id=?').get(passId);
  const quality = assessmentPassQuality.qualityForPass(db, workspace.id, pass);
  assert.equal(quality.ready, true, `Assessment pass is not ready: ${quality.defects.join(' ')}`);
  const materialized = consultingDelivery.materializeAssessmentPass(db, workspace, pass, reviewerId);
  assert.equal(materialized.frozen, 118, 'All 118 assessment conclusions must materialize as frozen workpapers.');
  db.prepare(`UPDATE assessment_passes SET status='completed',completed_by=?,completed_at=datetime('now')
    WHERE id=? AND workspace_id=? AND status='in_progress'`).run(
      reviewerId, passId, workspace.id
    );
  db.prepare(`UPDATE control_instances SET review_status='approved',review_requested_by=?,review_requested_at=datetime('now'),
    review_reason='Independent review completed against the retained synthetic evidence.',reviewed_by=?,reviewed_at=datetime('now'),last_verified_at=datetime('now')
    WHERE workspace_id=? AND entity_id IS NULL`).run(
      managerId, reviewerId, workspace.id
    );
  return db.prepare('SELECT * FROM assessment_passes WHERE id=?').get(passId);
}

function populateDeliveryPlan(workspace, planId, managerId, reviewerId, evidence, scenarioKey) {
  const allowedPhases = scenarioKey === 'gap'
    ? ['mobilisation', 'gap_assessment']
    : ['mobilisation', 'gap_assessment', 'context', 'assessment', 'treatment', 'implementation'];
  const placeholders = allowedPhases.map(() => '?').join(',');
  const deliverables = db.prepare(`SELECT d.*,ph.phase_key FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
    WHERE d.plan_id=? AND ph.phase_key IN (${placeholders}) ORDER BY ph.sort_order,m.id,d.id`).all(
      planId, ...allowedPhases
    );
  let implementationPosition = 0;
  deliverables.forEach((deliverable, index) => {
    let targetStatus = 'accepted';
    if (scenarioKey === 'implementation' && deliverable.phase_key === 'implementation') {
      targetStatus = implementationPosition === 0 ? 'accepted'
        : implementationPosition === 1 ? 'submitted' : 'draft';
      implementationPosition += 1;
    }
    db.prepare(`UPDATE engagement_delivery_deliverables SET owner_id=?,approver_id=?,due_date=?,updated_at=datetime('now')
      WHERE id=? AND workspace_id=?`).run(
        managerId, reviewerId, addDays(ANCHOR_DATE, targetStatus === 'draft' ? 45 + index : 20 + index),
        deliverable.id, workspace.id
      );
    if (targetStatus === 'draft') return;
    db.prepare(`INSERT OR IGNORE INTO engagement_delivery_evidence
      (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`).run(
        workspace.id, deliverable.id, evidence[index % evidence.length].id, managerId
      );
    engagementDelivery.transitionDeliverable(db, workspace, managerId, deliverable.id, 'submit',
      'Submitted with linked deterministic evidence for independent review.');
    if (targetStatus === 'accepted') {
      engagementDelivery.transitionDeliverable(db, workspace, reviewerId, deliverable.id, 'accept',
        'Accepted after independent review of the criteria and retained evidence snapshot.');
    }
  });
}

function seedGapAssessmentOperations(workspace, pass, engagementId, managerId, reviewerId, clientOwnerId, requirements, evidence) {
  const governedActionAt = db.prepare("SELECT datetime('now') value").get().value;
  const gapAuditId = Number(db.prepare(`INSERT INTO audits
    (workspace_id,title,scope,audit_date,auditor_name,status,summary,created_by,lifecycle_stage,
     auditor_competence,auditor_independence,population_size,sample_size,fieldwork_started_at,report_issued_at,closed_at,
     sampling_justification,created_at)
    VALUES (?,?,?,?,?,'complete',?,?,'closed',?,?,118,30,?,?,?,?,?)`).run(
      workspace.id, 'ISO 27001 independent gap assessment fieldwork', workspace.scope,
      addDays(ANCHOR_DATE, -45), 'Independent Nimbus Test Assessment Team',
      'All 118 requirements were concluded; judgmental and risk-based samples were used where operating effectiveness evidence was relevant.',
      managerId, 'ISO 27001 lead-auditor competence and sector experience retained in the engagement record.',
      'The quality reviewer did not prepare the assessment conclusions or source evidence.',
      sqlDateTime(addDays(ANCHOR_DATE, -55)), governedActionAt, governedActionAt,
      'The team assessed the full 118-requirement population. Operating records were sampled by risk, data sensitivity, service criticality, time period and control frequency; high-risk populations received expanded samples.',
      sqlDateTime(addDays(ANCHOR_DATE, -60))
    ).lastInsertRowid);
  db.prepare(`INSERT INTO audit_samples
    (audit_id,iso_item_id,description,sample_taken_at,population_size,sample_size,finding,created_at)
    VALUES (?,?,?,date('now'),118,30,?,datetime('now'))`).run(
      gapAuditId, 'clause-9.2',
      'Risk-based sample spanning governance, people, physical, technology and supplier operating records.',
      'Sample results were projected into the frozen requirement workpapers and confirmed finding register.'
    );

  const interviewInsert = db.prepare(`INSERT INTO gap_fieldwork_interviews
    (workspace_id,assessment_pass_id,title,objective,participant_role,owner_id,scheduled_at,duration_minutes,status,
     completion_summary,completed_at,client_visible,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,60,'completed',?,?,1,?,?,?,?)`);
  [
    ['Executive ISMS governance interview','Confirm scope, context, risk appetite and management commitment.','Chief Information Security Officer'],
    ['Technology and identity controls interview','Validate cloud configuration, privileged access and change operations.','Chief Technology Officer and IT Director'],
    ['People and competence interview','Validate joiner-mover-leaver, awareness and competence records.','People Director'],
    ['Supplier and incident governance interview','Validate supplier assurance, incident decisions and evidence retention.','General Counsel and Security Operations Lead'],
  ].forEach((seed, index) => interviewInsert.run(
    workspace.id, pass.id, seed[0], seed[1], seed[2], managerId,
    `${addDays(ANCHOR_DATE, -52 + index * 6)} 10:00:00`,
    `${seed[0]} completed; corroborating records and material limitations were captured in the linked workpapers.`,
    `${addDays(ANCHOR_DATE, -52 + index * 6)} 11:00:00`, managerId, reviewerId,
    `${addDays(ANCHOR_DATE, -60)} 09:00:00`, `${addDays(ANCHOR_DATE, -52 + index * 6)} 11:00:00`
  ));

  const findingRefs = ['annex-a.5.14', 'annex-a.5.24', 'annex-a.5.35'];
  const workpapers = db.prepare(`SELECT w.id,w.workpaper_ref,r.ref FROM consultant_workpapers w
    JOIN requirements r ON r.id=w.requirement_id WHERE w.workspace_id=? AND w.engagement_id=?
      AND r.ref IN (?,?,?)
    ORDER BY CASE r.ref WHEN ? THEN 1 WHEN ? THEN 2 WHEN ? THEN 3 END`).all(
      workspace.id, engagementId, ...findingRefs, ...findingRefs
    );
  assert.deepEqual(workpapers.map(row => row.ref), findingRefs,
    'Gap findings require exact matching Annex A workpapers.');
  const findingConclusions = db.prepare(`SELECT iso_item_id,status FROM control_state_history
    WHERE workspace_id=? AND pass_id=? AND iso_item_id IN (?,?,?) ORDER BY iso_item_id`).all(
      workspace.id, pass.id, ...findingRefs
    );
  assert.equal(findingConclusions.length, 3);
  assert.ok(findingConclusions.every(row => row.status !== 'Implemented'),
    'Every confirmed finding must be attached to a non-implemented assessment conclusion.');
  workpapers.forEach(workpaper => {
    const matched = evidence.find(item => item.packet.requirements.some(requirement => requirement.ref === workpaper.ref));
    assert.ok(matched, `No deterministic evidence packet covers ${workpaper.ref}.`);
    assert.equal(scalar(`SELECT COUNT(*) c FROM consultant_workpaper_evidence we
      JOIN evidence e ON e.id=we.evidence_id
      JOIN evidence_requirement_links erl ON erl.evidence_id=e.id
      JOIN requirements r ON r.id=erl.requirement_id
      WHERE we.workpaper_id=? AND e.id=? AND e.workspace_id=? AND r.ref=?`,
      workpaper.id, matched.id, workspace.id, workpaper.ref), 1,
    `The source evidence for ${workpaper.ref} is not canonically linked to its workpaper and requirement.`);
    workpaper.evidence = matched;
  });
  const transitionRequest = (requestId, actorId, fromStatus, toStatus, note, evidenceQuality = 'not_reviewed') => {
    const result = db.prepare(`UPDATE client_requests SET status=?,response_note=?,
      reviewed_by=CASE WHEN ?='accepted' THEN ? ELSE reviewed_by END,evidence_quality=?,
      submitted_at=CASE WHEN ?='submitted' THEN datetime('now') ELSE submitted_at END,
      closed_at=CASE WHEN ?='accepted' THEN datetime('now') ELSE closed_at END,
      updated_at=datetime('now'),version=version+1 WHERE id=? AND workspace_id=? AND status=?`).run(
        toStatus, note, toStatus, actorId, evidenceQuality, toStatus, toStatus,
        requestId, workspace.id, fromStatus
      );
    assert.equal(result.changes, 1, `RFI ${requestId} could not move ${fromStatus} -> ${toStatus}.`);
    db.prepare(`INSERT INTO client_request_events
      (request_id,workspace_id,actor_id,event_type,from_status,to_status,note,metadata)
      VALUES (?,?,?,'status_changed',?,?,?,?)`).run(
        requestId, workspace.id, actorId, fromStatus, toStatus, note,
        JSON.stringify({ evidence_quality: evidenceQuality, synthetic: true })
      );
  };
  workpapers.forEach((workpaper, index) => {
    const requestId = consultingDelivery.createClientRequest(db, workspace, managerId, workpaper.id, {
      title: `Resolved evidence request - ${workpaper.ref}`,
      description: `Provide a complete, dated and attributable operating record supporting ${workpaper.ref}.`,
      priority: 'high',
      assignee_id: clientOwnerId,
      due_date: addDays(ANCHOR_DATE, 20 + index * 3),
      request_reason: 'The assessment conclusion required a complete operating record for the stated period.',
      acceptable_examples: 'Approved export, review record, ticket history or equivalent dated system evidence.',
      evidence_period_start: '2026-05-01',
      evidence_period_end: '2026-07-31',
      confidentiality: 'client_confidential',
    });
    transitionRequest(requestId, clientOwnerId, 'open', 'in_progress',
      'The client owner began assembling the requested operating record.');
    db.prepare(`INSERT INTO client_request_evidence (request_id,evidence_id,linked_by) VALUES (?,?,?)`)
      .run(requestId, workpaper.evidence.id, clientOwnerId);
    db.prepare(`INSERT INTO client_request_events
      (request_id,workspace_id,actor_id,event_type,note,metadata)
      VALUES (?,?,?,'evidence_linked',?,?)`).run(
        requestId, workspace.id, clientOwnerId, 'The requested evidence packet was linked before submission.',
        JSON.stringify({ evidence_id: workpaper.evidence.id, synthetic: true })
      );
    transitionRequest(requestId, clientOwnerId, 'in_progress', 'submitted',
      'The client owner submitted the linked record for independent review.');
    transitionRequest(requestId, reviewerId, 'submitted', 'accepted',
      'Independent review found the submitted evidence sufficient for the stated purpose.', 'sufficient');

    // The route/domain helpers intentionally timestamp real actions at the
    // time they occur. This deterministic historical fixture subsequently
    // aligns that complete five-event chain to a governed fieldwork day so a
    // later weekly snapshot never claims an RFI that did not yet exist.
    const rfiDay = addDays(ANCHOR_DATE, -16);
    const eventTimes = [9, 10, 11, 12, 13].map(hour => sqlDateTime(rfiDay, hour));
    const requestEvents = db.prepare(`SELECT id,event_type,from_status,to_status
      FROM client_request_events WHERE request_id=? ORDER BY id`).all(requestId);
    assert.deepEqual(requestEvents.map(event => event.event_type),
      ['created','status_changed','evidence_linked','status_changed','status_changed']);
    const updateRequestEventTime = db.prepare(`UPDATE client_request_events SET created_at=? WHERE id=?`);
    requestEvents.forEach((event, eventIndex) => updateRequestEventTime.run(eventTimes[eventIndex], event.id));
    db.prepare(`UPDATE client_request_evidence SET linked_at=? WHERE request_id=? AND evidence_id=?`).run(
      eventTimes[2], requestId, workpaper.evidence.id
    );
    db.prepare(`UPDATE client_requests SET created_at=?,submitted_at=?,closed_at=?,updated_at=?
      WHERE id=? AND workspace_id=?`).run(
        eventTimes[0], eventTimes[3], eventTimes[4], eventTimes[4], requestId, workspace.id
      );
  });

  const defaultRequirement = db.prepare(`SELECT r.* FROM control_state_history h
    JOIN requirements r ON r.ref=h.iso_item_id
    WHERE h.workspace_id=? AND h.pass_id=? AND h.status='Partially Implemented'
    ORDER BY r.sort_order,r.id LIMIT 1`).get(workspace.id, pass.id);
  assert.ok(defaultRequirement, 'The declared default must reference an actually partially implemented conclusion.');
  db.prepare(`INSERT INTO gap_declared_defaults
    (workspace_id,assessment_pass_id,requirement_id,declaration,rationale,status,client_visible,row_version,
     recorded_by,confirmed_by,confirmed_at,updated_at)
    VALUES (?,?,?,?,?,'confirmed',1,2,?,?,?,?)`).run(
      workspace.id, pass.id, defaultRequirement.id,
      `${defaultRequirement.ref} was assessed as partially implemented where the client assertion was not corroborated across the full operating period.`,
      'The declared default prevents unsupported management assertions from being upgraded to implemented and was independently confirmed during fieldwork.',
      managerId, reviewerId, sqlDateTime(addDays(ANCHOR_DATE, -15), 14), sqlDateTime(addDays(ANCHOR_DATE, -15), 14)
    );
  db.prepare(`INSERT INTO gap_fieldwork_blockers
    (workspace_id,assessment_pass_id,title,description,owner_id,priority,due_date,status,resolution_note,resolved_at,
     client_visible,row_version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,'high',?,'resolved',?,?,1,2,?,?,?,?)`).run(
      workspace.id, pass.id, 'Privileged-access population was incomplete',
      'The initial export omitted dormant administrative identities and could not support the planned assessment sample.',
      clientOwnerId, addDays(ANCHOR_DATE, -33),
      'A complete population was re-exported, reconciled to HR and service-owner records, and used for the final sample.',
      sqlDateTime(addDays(ANCHOR_DATE, -29)), managerId, reviewerId,
      sqlDateTime(addDays(ANCHOR_DATE, -38)), sqlDateTime(addDays(ANCHOR_DATE, -29))
    );

  const findingDefinitions = [
    ['Critical supplier information-transfer evidence terms are inconsistent','gap','high',
      'Two sampled critical-supplier transfer procedures state notification timing but do not require retention of the facts, decisions and communications supporting a material transfer event.',
      'ISO 27001 Annex A.5.14 requires rules, procedures or agreements for information transfer to protect information in transit and retain accountable handling expectations.',
      'The client may lack enough retained information to make timely legal, customer and recovery decisions after a transfer event.',
      'Update the standard information-transfer schedule and remediate the affected agreements through governed supplier review.'],
    ['Incident exercises omit some executive decision timestamps','observation','medium',
      'One of two sampled exercise records did not preserve timestamps for legal assessment and customer-message approval.',
      'ISO 27001 Annex A.5.24 requires incident-management processes, roles and responsibilities to be planned and prepared.',
      'Management may be unable to demonstrate that material decisions were reached within required periods.',
      'Add decision time, authority, known facts and evidence confidence to the controlled exercise record.'],
    ['Independent control-review sampling is incomplete','improvement','medium',
      'The independent review covered all functions at summary level, but closure-evidence sampling was performed only for technology and operations.',
      'ISO 27001 Annex A.5.35 requires the information-security management approach and its implementation to be reviewed independently at planned intervals or after significant change.',
      'Reported closure rates may overstate consistent corrective action outside the independently sampled functions.',
      'Approve a risk-based cross-function independent-review method and apply it to the next review cycle.'],
  ];
  findingDefinitions.forEach((definition, index) => {
    const findingId = consultingDelivery.createFinding(db, workspace, managerId, workpapers[index].id, {
      title: definition[0], finding_type: definition[1], severity: definition[2],
      condition_text: definition[3], criteria_text: definition[4], effect_text: definition[5],
      recommendation_text: definition[6], cause_text: 'The prior operating method did not define the required evidence or sampling detail.',
      client_visible: '1', owner_id: clientOwnerId, due_date: addDays(ANCHOR_DATE, 75 + index * 20),
    });
    consultingDelivery.linkFindingEvidence(db, workspace, managerId, findingId, {
      evidence_id: workpapers[index].evidence.id, evidence_role: 'source',
    });
    const finding = consultingDelivery.findingDetail(db, workspace, findingId);
    consultingDelivery.transitionFinding(db, workspace, reviewerId, findingId, 'confirm', {
      row_version: finding.row_version,
      note: 'Independent factual and evidence review confirmed the condition, criteria, effect and client-safe wording.',
    });
  });

  // Freeze only the state that now exists. Earlier versions of this fixture
  // backdated progressive metrics ahead of the immutable conclusions, RFI
  // events and client confirmation that supported them. These three retained
  // reporting-window snapshots are generated after every claimed fact and
  // therefore contain the same truthful, complete fieldwork projection.
  [-14, -7, 0].forEach(day => gapFieldwork.snapshotFieldwork(
    db, workspace, reviewerId, addDays(ANCHOR_DATE, day)
  ));
  const frozenFieldwork = gapFieldwork.assessmentContext(db, workspace).clientLive;
  const frozenSnapshots = db.prepare(`SELECT * FROM gap_fieldwork_snapshots
    WHERE workspace_id=? AND assessment_pass_id=? ORDER BY week_ending`).all(workspace.id, pass.id);
  assert.equal(frozenSnapshots.length, 3);
  frozenSnapshots.forEach(snapshot => {
    assert.equal(snapshot.requirements_covered, frozenFieldwork.requirementsCovered);
    assert.equal(snapshot.interviews_completed, frozenFieldwork.interviewsCompleted);
    assert.equal(snapshot.requests_received, frozenFieldwork.requestsReceived);
    assert.equal(snapshot.active_blockers, frozenFieldwork.activeBlockers);
    assert.equal(snapshot.declared_defaults, frozenFieldwork.declaredDefaults);
  });

  const decide = (phase, rationale) => {
    const context = gapFieldwork.assessmentContext(db, workspace);
    assert.equal(context.gates[phase].ready, true,
      `${phase} is not ready: ${context.gates[phase].checks.filter(check => !check.pass).map(check => check.label).join('; ')}`);
    const decisionId = Number(db.prepare(`INSERT INTO gap_assessment_phase_decisions
      (workspace_id,assessment_pass_id,phase,decision,rationale,decided_by)
      VALUES (?,?,?,'complete',?,?)`).run(
        workspace.id, pass.id, phase, rationale, reviewerId
      ).lastInsertRowid);
    db.prepare(`INSERT INTO gap_assessment_phase_events
      (phase_decision_id,from_decision,to_decision,rationale,actor_id)
      VALUES (?,NULL,'complete',?,?)`).run(
        decisionId, rationale, reviewerId
      );
  };
  decide('mobilisation', 'Scope, sampling basis, applicability, evidence expectations and the fieldwork plan were independently reviewed.');
  decide('fieldwork', 'The assessment pass, interviews, RFIs, blocker resolution and evidence were independently reviewed and fieldwork is complete.');
  decide('validation', 'Client-visible findings were factually validated and the independent reviewer confirmed their report wording.');

  const reportId = consultingDelivery.generateReport(db, workspace, managerId, engagementId, {
    report_type: 'assessment',
    title: `${workspace.client_name} - controlled ISO 27001 gap assessment report`,
  });
  consultingDelivery.transitionReport(db, workspace, reviewerId, reportId, 'approve',
    'Independent quality review confirmed all 118 frozen workpapers, evidence links and assessment conclusions.');
  consultingDelivery.transitionReport(db, workspace, managerId, reportId, 'publish',
    'Approved for controlled client release as the contracted gap-assessment deliverable.');
  consultingDelivery.event(db, workspace.id, engagementId, managerId, 'assessment_pass', pass.id,
    'published_report_linked', { report_id: reportId, synthetic: true });
  return reportId;
}

function seedImplementationOperations(workspaceId, managerId, reviewerId, clientOwnerId, requirements, registers, evidence) {
  const treatmentInsert = db.prepare(`INSERT INTO risk_treatment_actions
    (workspace_id,risk_id,title,description,owner_name,due_date,status,residual_likelihood,residual_impact,closed_at,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  registers.riskIds.slice(0, 5).forEach((riskId, index) => treatmentInsert.run(
    workspaceId, riskId,
    ['Deploy phishing-resistant privileged MFA','Expand cloud policy guardrails','Enforce artifact provenance','Exercise supplier exit','Automate incident escalation'][index],
    'Accountable implementation action with a measured residual-risk target and retained completion evidence.',
    index === 0 ? 'CISO' : 'Head of Platform', addDays(ANCHOR_DATE, 30 + index * 12),
    index < 2 ? 'in_progress' : 'planned', 2, index < 3 ? 2 : 3, null, managerId
  ));

  const programmeId = Number(db.prepare(`INSERT INTO audit_programmes
    (workspace_id,year,description,approved_by,approved_at,created_at) VALUES (?,?,?,?,?,?)`).run(
      workspaceId, 2026,
      'Risk-based ISO 27001 internal audit programme covering governance, technology operations and critical suppliers.',
      'Executive ISMS Steering Committee', sqlDateTime(addDays(ANCHOR_DATE, -75)),
      sqlDateTime(addDays(ANCHOR_DATE, -85))
    ).lastInsertRowid);
  const auditInsert = db.prepare(`INSERT INTO audits
    (workspace_id,title,scope,audit_date,auditor_name,status,summary,created_by,programme_id,auditor_competence,
     auditor_independence,sample_size,population_size,lifecycle_stage,fieldwork_started_at,report_issued_at,closed_at,
     sampling_justification,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const auditIds = [
    auditInsert.run(workspaceId, 'Identity and access management internal audit',
      'Privileged and workforce identity lifecycle across production and corporate systems.', addDays(ANCHOR_DATE, -65),
      'Morgan Reed, independent internal auditor', 'complete',
      'Controls were generally effective; one minor nonconformity and one improvement were raised.', managerId, programmeId,
      'ISO 27001 internal-auditor training and five years of identity assurance experience.',
      'The auditor has no operational responsibility for identity administration.', 25, 214, 'closed',
      sqlDateTime(addDays(ANCHOR_DATE, -70)), sqlDateTime(addDays(ANCHOR_DATE, -61)), sqlDateTime(addDays(ANCHOR_DATE, -58)),
      'Risk-based sample covering privileged roles, joiners, movers, leavers, service accounts and access recertification.',
      sqlDateTime(addDays(ANCHOR_DATE, -75))).lastInsertRowid,
    auditInsert.run(workspaceId, 'Cloud operations and supplier assurance internal audit',
      'Cloud change controls, security monitoring, backup, incident response and critical supplier governance.', addDays(ANCHOR_DATE, -20),
      'Avery Cole, independent technology auditor', 'in_progress',
      'Fieldwork is active with preliminary observations tracked to accountable owners.', managerId, programmeId,
      'Cloud assurance, supplier-risk and ISO 27001 audit competence retained.',
      'The auditor is outside the platform and supplier-management reporting lines.', 18, 96, 'fieldwork',
      sqlDateTime(addDays(ANCHOR_DATE, -25)), null, null,
      'Judgmental sample weighted to production changes, high-severity alerts, backup restores and tier-one suppliers.',
      sqlDateTime(addDays(ANCHOR_DATE, -30))).lastInsertRowid,
  ].map(Number);
  const auditSampleInsert = db.prepare(`INSERT INTO audit_samples
    (audit_id,iso_item_id,description,sample_taken_at,population_size,sample_size,finding,created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  auditSampleInsert.run(auditIds[0], 'annex-a.5.18',
    'Privileged roles, joiners, movers, leavers, service accounts and access recertification records.',
    addDays(ANCHOR_DATE, -63), 214, 25,
    'Two service accounts lacked current accountable-owner recertification.',
    sqlDateTime(addDays(ANCHOR_DATE, -63)));
  auditSampleInsert.run(auditIds[1], 'annex-a.8.9',
    'Production changes, high-severity alerts, backup restores and tier-one supplier assurance records.',
    addDays(ANCHOR_DATE, -18), 96, 18,
    'Ageing guardrail exceptions remain in inherited cloud environments.',
    sqlDateTime(addDays(ANCHOR_DATE, -18)));
  const findingInsert = db.prepare(`INSERT INTO audit_findings
    (audit_id,iso_item_id,finding_type,description,severity,status,created_at) VALUES (?,?,?,?,?,?,?)`);
  const auditFindingIds = [
    Number(findingInsert.run(auditIds[0], 'annex-a.5.18', 'minor_nc',
      'Two privileged service accounts lacked current accountable-owner recertification.', 'medium', 'open',
      sqlDateTime(addDays(ANCHOR_DATE, -62))).lastInsertRowid),
    Number(findingInsert.run(auditIds[0], 'annex-a.6.3', 'observation',
      'Role-specific awareness completion is reported, but late completion escalation is manual.', 'low', 'open',
      sqlDateTime(addDays(ANCHOR_DATE, -62))).lastInsertRowid),
    Number(findingInsert.run(auditIds[1], 'annex-a.8.9', 'observation',
      'Inherited cloud environments contain ageing guardrail exceptions awaiting risk decisions.', 'medium', 'open',
      sqlDateTime(addDays(ANCHOR_DATE, -18))).lastInsertRowid),
  ];

  const ncInsert = db.prepare(`INSERT INTO nonconformities
    (workspace_id,title,source,source_ref,description,severity,iso_item_id,root_cause,corrective_action,
     responsible,due_date,effectiveness_check,status,closed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ncIds = [
    Number(ncInsert.run(workspaceId, 'Privileged service-account recertification gap', 'internal_audit', `audit_finding:${auditFindingIds[0]}`,
      'Two accounts did not have current accountable-owner approval.', 'minor', 'annex-a.5.18',
      'The quarterly review excluded non-human accounts created through the infrastructure pipeline.',
      'Expand the authoritative population, assign owners and complete independent recertification.',
      'Identity Governance Lead', addDays(ANCHOR_DATE, 25),
      'Reperform the complete population reconciliation and inspect approvals.', 'in_progress', null,
      sqlDateTime(addDays(ANCHOR_DATE, -60))).lastInsertRowid),
    Number(ncInsert.run(workspaceId, 'Backup restore evidence was fragmented', 'management_review', 'MRM-2026-Q2',
      'Application and database restore evidence was retained in separate records without service-owner acceptance.', 'minor', 'annex-a.8.13',
      'The technical test procedure did not require business acceptance.',
      'Adopt an integrated restore record and repeat the tier-one service restore.',
      'Head of Platform', addDays(ANCHOR_DATE, 42),
      'Inspect the integrated record and service-owner sign-off.', 'open', null,
      sqlDateTime(addDays(ANCHOR_DATE, -80))).lastInsertRowid),
    Number(ncInsert.run(workspaceId, 'Leaver evidence retention inconsistency', 'internal_audit', 'IA-2026-01',
      'A prior leaver sample lacked one system-generated completion timestamp.', 'minor', 'annex-a.6.5',
      'A legacy application was not integrated with the central workflow.',
      'Integrate the application and validate a new sample.',
      'IT Operations Manager', addDays(ANCHOR_DATE, -12),
      'A ten-record sample confirmed timestamped completion.', 'closed', sqlDateTime(addDays(ANCHOR_DATE, -8)),
      sqlDateTime(addDays(ANCHOR_DATE, -35))).lastInsertRowid),
  ];
  db.prepare('UPDATE audit_findings SET nonconformity_id=? WHERE id=?').run(ncIds[0], auditFindingIds[0]);

  const mrmInsert = db.prepare(`INSERT INTO mrms
    (workspace_id,meeting_date,attendees,status,context_changes,prior_actions_status,performance_review,
     feedback_interested_parties,risk_treatment_status,improvement_opportunities,decisions,action_items,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  mrmInsert.run(workspaceId, addDays(ANCHOR_DATE, -80),
    'CEO, COO, CTO, CISO, General Counsel, DPO, GRC Manager', 'complete',
    'Regulated customer growth and a new EU processing region were accepted into the ISMS context.',
    'Eight of nine prior actions closed; the integrated restore record remains active.',
    'Security objectives, audit results, incidents, supplier assurance, training and evidence coverage were reviewed.',
    'Customers requested stronger evidence of supplier incident notification and recovery testing.',
    'Residual risk declined, with privileged identity and supplier concentration remaining above target.',
    'Automate privileged-access certification and consolidate recovery evidence.',
    'Approve the certification target, policy publication sequence and additional identity investment.',
    'CISO to close identity actions; CTO to repeat restore test; Legal to update supplier schedule.', managerId,
    sqlDateTime(addDays(ANCHOR_DATE, -90)));
  mrmInsert.run(workspaceId, addDays(ANCHOR_DATE, 18),
    'CEO, COO, CTO, CISO, General Counsel, DPO, GRC Manager', 'planned',
    'Review material context changes since the prior quarter.',
    'Confirm closure and effectiveness of open actions.',
    'Review current objectives, risks, audit progress, incidents and certification readiness.',
    'Review customer and regulator feedback.', 'Review residual risk and treatment progress.',
    'Identify continual-improvement decisions.', 'To be recorded at the meeting.',
    'Pre-read owners to submit current evidence five working days before the meeting.', managerId,
    sqlDateTime(ANCHOR_DATE, 0));

  const objectiveInsert = db.prepare(`INSERT INTO security_objectives
    (workspace_id,title,description,measurement,target_value,current_value,owner,due_date,status,notes,status_mode)
    VALUES (?,?,?,?,?,?,?,?,?,?,'manual')`);
  [
    ['Privileged access recertification','Maintain complete quarterly owner approval.','Percent of privileged roles recertified on time.','100%','94%','CISO',60,'at_risk'],
    ['Critical vulnerability remediation','Close critical vulnerabilities within the approved SLA.','Percent closed within 14 days.','>= 95%','97%','VP Engineering',90,'on_track'],
    ['Security awareness completion','Maintain timely workforce and role-specific learning.','Percent completed before due date.','>= 98%','96%','People Director',45,'at_risk'],
    ['Tier-one recovery assurance','Exercise recovery for every tier-one service.','Percent of tier-one services tested annually.','100%','75%','COO',120,'on_track'],
  ].forEach(seed => objectiveInsert.run(
    workspaceId, seed[0], seed[1], seed[2], seed[3], seed[4], seed[5], addDays(ANCHOR_DATE, seed[6]), seed[7],
    'Board-approved synthetic ISO 27001 implementation objective.'
  ));

  const tprmModule = tprmDomain.enableModule(db, {
    workspaceId,
    actorId: managerId,
    serviceModel: 'programme_setup',
    reason: 'Synthetic programme setup covers governed inventory, methodology and draft intake only; assessment and approval are explicitly out of scope.',
    idempotencyKey: sha(`iso27001-seed:${workspaceId}:tprm-programme-setup`),
  }).module;
  assert.equal(tprmModule.status, 'active');
  assert.equal(tprmModule.service_model, 'programme_setup');

  const standardSupplierClauses = [
    ['confidentiality', 'Confidentiality / non-disclosure'],
    ['data_handling', 'Data handling and classification'],
    ['security_obligations', 'Information security obligations (referencing standards)'],
    ['breach_notification', 'Breach notification (within 72 hours of awareness)'],
    ['subprocessor_approval', 'Sub-processor approval and notification'],
    ['audit_rights', 'Right to audit / receive assurance reports'],
    ['data_return_destruction', 'Data return / destruction at termination'],
    ['liability_indemnity', 'Liability and indemnity for security failures'],
    ['compliance', 'Compliance with applicable laws and regulations'],
    ['dpa', 'Data Processing Agreement (where personal data is processed)'],
    ['change_management', 'Change management / notice of material changes'],
    ['service_levels', 'Service levels and remedies'],
  ];
  const entityInsert = db.prepare(`INSERT INTO entities
    (workspace_id,name,description,entity_type,region,contact,attributes,created_at)
    VALUES (?,?,?,'supplier',?,?,?,datetime('now'))`);
  const supplierInsert = db.prepare(`INSERT INTO suppliers
    (workspace_id,entity_id,name,service_provided,tier,data_access,contract_start,contract_end,next_review_date,attestations,contact,notes,
     status,last_assessed,lifecycle_stage,inherent_risk_score,residual_risk_score,business_criticality,data_volume,industry,location,
     regulatory_exposure,dependency_type,annual_spend,renewal_notice_days,auto_renew,approved_by,approved_at,website,
     relationship_owner,business_owner,security_reviewer,service_category,processing_purpose,data_categories,hosting_locations,
     critical_processes,system_access,rto_hours,rpo_hours,exit_strategy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const clauseInsert = db.prepare(`INSERT INTO supplier_clauses
    (workspace_id,supplier_id,clause_key,clause_label,status) VALUES (?,?,?,?,'pending')`);
  const supplierSeeds = [
    { name:'Microsoft Azure', service:'Production cloud hosting', tier:'tier_1', dataAccess:'sensitive', rto:2, rpo:1,
      criticality:'critical', volume:'high', industry:'Cloud services', location:'Ireland and Netherlands',
      regulatory:'GDPR; regulated customer terms', dependency:'single_source', spend:'GBP 520,000',
      website:'https://azure.microsoft.com', owner:'Head of Platform', provisionModel:'iaas', relationshipDataAccess:'restricted' },
    { name:'GitHub', service:'Source control and CI/CD', tier:'tier_1', dataAccess:'confidential', rto:8, rpo:2,
      criticality:'high', volume:'medium', industry:'Software services', location:'United States and EU',
      regulatory:'Customer security schedules', dependency:'multi_source', spend:'GBP 96,000',
      website:'https://github.com', owner:'VP Engineering', provisionModel:'saas', relationshipDataAccess:'confidential' },
    { name:'Cloudflare', service:'Edge protection and DNS', tier:'tier_1', dataAccess:'confidential', rto:4, rpo:2,
      criticality:'high', volume:'medium', industry:'Cloud security', location:'European Union',
      regulatory:'Operational resilience', dependency:'single_source', spend:'GBP 74,000',
      website:'https://cloudflare.com', owner:'Head of Platform', provisionModel:'managed_service', relationshipDataAccess:'confidential' },
    { name:'PeopleCore', service:'HR information system', tier:'tier_2', dataAccess:'personal', rto:24, rpo:8,
      criticality:'medium', volume:'medium', industry:'Business software', location:'European Union',
      regulatory:'GDPR', dependency:'multi_source', spend:'GBP 31,000', website:'https://example.invalid',
      owner:'People Director', provisionModel:'saas', relationshipDataAccess:'confidential' },
  ];
  supplierSeeds.forEach((seed, index) => {
    const contact = `assurance@${seed.name.toLowerCase().replace(/[^a-z]+/g, '')}.example`;
    const entityId = Number(entityInsert.run(
      workspaceId, seed.name, seed.service, seed.location, contact,
      JSON.stringify({ lifecycle_stage: 'prospect', criticality: seed.criticality, data_access: seed.dataAccess, synthetic: true })
    ).lastInsertRowid);
    const supplierId = Number(supplierInsert.run(
      workspaceId, entityId, seed.name, seed.service, seed.tier, seed.dataAccess,
      addDays(ANCHOR_DATE, -600), addDays(ANCHOR_DATE, 220 + index * 50), addDays(ANCHOR_DATE, 60 + index * 20),
      null, contact,
      'Synthetic programme-setup intake with accountable owners and a governed primary service boundary. No due-diligence, recommendation or client approval conclusion has been made.',
      'active', null, 'prospect', null, null, seed.criticality, seed.volume, seed.industry, seed.location,
      seed.regulatory, seed.dependency, seed.spend, 90, 1, null, null, seed.website,
      seed.owner, seed.owner, 'Independent ISO 27001 Test Reviewer', 'Technology service',
      'Delivery of contracted technology services', 'Customer and corporate information', seed.location,
      'Payment processing and customer operations', seed.dataAccess, seed.rto, seed.rpo,
      'Documented portability, alternate-provider assessment and annual exit review.'
    ).lastInsertRowid);
    standardSupplierClauses.forEach(([key, label]) => clauseInsert.run(
      workspaceId, supplierId, key, label
    ));
    const relationship = tprmRelationships.createRelationship(db, {
      workspaceId,
      supplierId,
      actorId: managerId,
      legalName: seed.name,
      entityType: 'corporation',
      entityStatus: 'active',
      relationshipName: seed.service,
      serviceCategory: 'Technology service',
      serviceDescription: `Governed primary service boundary for ${seed.service.toLowerCase()}, including accountable owners, data access and recovery dependencies.`,
      provisionModel: seed.provisionModel,
      status: 'intake',
      criticality: seed.criticality === 'medium' ? 'moderate' : seed.criticality,
      dataAccess: seed.relationshipDataAccess,
      relationshipOwner: seed.owner,
      businessOwner: seed.owner,
      securityOwner: 'Independent ISO 27001 Test Reviewer',
      startDate: addDays(ANCHOR_DATE, -600),
      targetEndDate: addDays(ANCHOR_DATE, 220 + index * 50),
      rtoHours: seed.rto,
      rpoHours: seed.rpo,
      maxTolerableDisruptionHours: seed.rto * 2,
      substitutability: seed.dependency === 'single_source' ? 'not_substitutable' : 'substitutable_with_effort',
      estimatedExitDays: seed.dependency === 'single_source' ? 120 : 60,
      exitPlanStatus: 'documented',
      exitOwner: seed.owner,
      exitStrategy: 'Documented portability, alternate-provider assessment and annual exit review.',
      transitionAssistance: 'Contracted knowledge transfer and orderly service migration support.',
      dataReturnDeletionRequirements: 'Return or verified deletion of client information at exit.',
      soleSource: seed.dependency === 'single_source',
      materialOutsourcing: index === 0,
      regulatedService: index !== 3,
      isPrimary: true,
      reason: 'Primary service relationship created from the governed synthetic programme-setup intake.',
      idempotencyKey: sha(`iso27001-seed:${workspaceId}:supplier:${supplierId}:primary-relationship`),
    }).relationship;
    assert.equal(relationship.status, 'intake');
    assert.equal(relationship.is_primary, 1);
  });

  const incidentInsert = db.prepare(`INSERT INTO incidents
    (workspace_id,title,category,severity,detected_at,reported_by,status,description,affected_assets,containment_actions,
     eradication_actions,recovery_actions,lessons_learned,external_notification,closed_at,pir_completed,pir_summary,is_tabletop,
     contained_at,eradicated_at,recovered_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const phishingIncidentId = Number(incidentInsert.run(workspaceId, 'Contained credential-phishing event', 'phishing', 'medium',
    sqlDateTime(addDays(ANCHOR_DATE, -140), 9), 'Security Operations', 'closed',
    'A user entered credentials into a phishing site; conditional-access controls prevented production access.',
    'One workforce account; no confirmed customer data access.', 'Sessions revoked, account disabled and indicators blocked.',
    'Mailbox rules removed and endpoint inspected.', 'Identity restored after enhanced verification.',
    'Expand phishing-resistant MFA and retain decision timestamps.', 'No regulatory or customer notification threshold was met.',
    sqlDateTime(addDays(ANCHOR_DATE, -137)), 1, 'Post-incident review actions were accepted by the CISO.', 0,
    sqlDateTime(addDays(ANCHOR_DATE, -140), 10), sqlDateTime(addDays(ANCHOR_DATE, -140), 13), sqlDateTime(addDays(ANCHOR_DATE, -139), 10),
    sqlDateTime(addDays(ANCHOR_DATE, -140), 9)).lastInsertRowid);
  const exerciseIncidentId = Number(incidentInsert.run(workspaceId, 'Payment service cyber-crisis exercise', 'other', 'high',
    sqlDateTime(addDays(ANCHOR_DATE, -35), 9), 'CISO', 'closed',
    'Tabletop exercise tested a supplier outage concurrent with a suspected cross-tenant exposure.',
    'Payment orchestration, identity and customer communications.', 'Incident command and alternate communications were activated.',
    'Simulation only; no eradication required.', 'Recovery decisions and customer communications were rehearsed.',
    'Pre-authorise supplier escalation and add evidence-confidence fields.', 'Notification decisions were simulated and recorded.',
    sqlDateTime(addDays(ANCHOR_DATE, -35), 16), 1, 'Exercise objectives were substantially met; two improvements were assigned.', 1,
    sqlDateTime(addDays(ANCHOR_DATE, -35), 10), sqlDateTime(addDays(ANCHOR_DATE, -35), 12), sqlDateTime(addDays(ANCHOR_DATE, -35), 15),
    sqlDateTime(addDays(ANCHOR_DATE, -35), 9)).lastInsertRowid);
  const incidentEventInsert = db.prepare(`INSERT INTO incident_events
    (workspace_id,incident_id,phase,event_at,description,actor,created_at) VALUES (?,?,?,?,?,?,?)`);
  [
    [phishingIncidentId, 'detect', -140, 9, 'Security monitoring validated the credential-phishing alert.', 'Security Operations'],
    [phishingIncidentId, 'contain', -140, 10, 'Sessions were revoked, the account disabled and indicators blocked.', 'Incident Commander'],
    [phishingIncidentId, 'eradicate', -140, 13, 'Malicious mailbox rules were removed and the endpoint inspected.', 'Identity Response Lead'],
    [phishingIncidentId, 'recover', -139, 10, 'Identity access was restored after enhanced verification.', 'Identity Response Lead'],
    [phishingIncidentId, 'lessons', -137, 12, 'The CISO accepted the post-incident review and improvement actions.', 'CISO'],
    [exerciseIncidentId, 'detect', -35, 9, 'The exercise facilitator injected the supplier outage and suspected exposure.', 'Exercise Facilitator'],
    [exerciseIncidentId, 'contain', -35, 10, 'Incident command and alternate communications were activated.', 'Incident Commander'],
    [exerciseIncidentId, 'communicate', -35, 12, 'Legal and customer notification decisions were rehearsed.', 'General Counsel'],
    [exerciseIncidentId, 'recover', -35, 15, 'Recovery priorities and evidence-confidence decisions were validated.', 'COO'],
    [exerciseIncidentId, 'lessons', -35, 16, 'Exercise findings were accepted and assigned to accountable owners.', 'CISO'],
  ].forEach(seed => {
    const at = sqlDateTime(addDays(ANCHOR_DATE, seed[2]), seed[3]);
    incidentEventInsert.run(workspaceId, seed[0], seed[1], at, seed[4], seed[5], at);
  });

  const courseInsert = db.prepare(`INSERT INTO training_courses
    (workspace_id,name,description,duration_minutes,validity_months,required_for_roles,has_quiz,passing_score,iso_control_ref,is_active,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,?)`);
  const trainingParentCreatedAt = sqlDateTime(addDays(ANCHOR_DATE, -110), 0);
  const courseIds = [
    Number(courseInsert.run(workspaceId, 'Annual information security awareness',
      'Core responsibilities, reporting, phishing, data handling and secure remote work.', 45, 12, 'All personnel', 1, 80, 'annex-a.6.3',
      trainingParentCreatedAt).lastInsertRowid),
    Number(courseInsert.run(workspaceId, 'Secure engineering and cloud operations',
      'Secure development, change control, secrets, vulnerability and cloud configuration.', 90, 12, 'Engineering; Platform; Security', 1, 85, 'annex-a.8.25',
      trainingParentCreatedAt).lastInsertRowid),
  ];
  const trainingInsert = db.prepare(`INSERT INTO training_records
    (workspace_id,user_name,user_role,training_name,assigned_date,due_date,completed_date,score,status,notes,
     course_id,attestation_signed_at,quiz_score,expiry_date,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ['Aisha Khan','Daniel Cho','Luca Rossi','Sara Mensah','Tom Becker','Nina Patel'].forEach((name, index) => {
    const courseId = courseIds[index % courseIds.length];
    const trainingName = index % 2 ? 'Secure engineering and cloud operations' : 'Annual information security awareness';
    trainingInsert.run(workspaceId, name, index % 2 ? 'Engineer' : 'Business operator', trainingName,
      addDays(ANCHOR_DATE, -90), addDays(ANCHOR_DATE, -60), addDays(ANCHOR_DATE, -65 + index),
      `${88 + index}%`, 'completed', 'Completion and attestation retained as synthetic competence evidence.',
      courseId, sqlDateTime(addDays(ANCHOR_DATE, -65 + index)), 88 + index, addDays(ANCHOR_DATE, 300 + index),
      sqlDateTime(addDays(ANCHOR_DATE, -90)));
  });

  const roleInsert = db.prepare(`INSERT INTO competence_roles
    (workspace_id,name,description,required_competences,created_at) VALUES (?,?,?,?,?)`);
  const competenceParentCreatedAt = sqlDateTime(addDays(ANCHOR_DATE, -110), 0);
  const roleIds = [
    Number(roleInsert.run(workspaceId, 'ISMS Manager', 'Coordinates the governed management system.',
      'ISO 27001 implementation; risk management; internal audit; evidence governance', competenceParentCreatedAt).lastInsertRowid),
    Number(roleInsert.run(workspaceId, 'Cloud Security Engineer', 'Operates preventive and detective cloud controls.',
      'Cloud architecture; secure configuration; incident response; change control', competenceParentCreatedAt).lastInsertRowid),
  ];
  const competenceInsert = db.prepare(`INSERT INTO competence_records
    (workspace_id,role_id,person_name,person_email,competence,evidence_type,evidence_ref,recorded_at,expires_on,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  competenceInsert.run(workspaceId, roleIds[0], 'Elena Wright', 'elena.wright@northbridge.demo',
    'ISO 27001 lead implementation and risk governance', 'Qualification', 'COMP-ISMS-001',
    addDays(ANCHOR_DATE, -100), addDays(ANCHOR_DATE, 630), 'Competence approved by the executive sponsor.');
  competenceInsert.run(workspaceId, roleIds[1], 'Daniel Cho', 'daniel.cho@northbridge.demo',
    'Azure security engineering and incident response', 'Certification', 'COMP-CLOUD-002',
    addDays(ANCHOR_DATE, -80), addDays(ANCHOR_DATE, 285), 'Observed performance and current certification retained.');
  competenceInsert.run(workspaceId, roleIds[1], 'Luca Rossi', 'luca.rossi@northbridge.demo',
    'Secure CI/CD, artifact integrity and cloud change control', 'Experience', 'COMP-CLOUD-003',
    addDays(ANCHOR_DATE, -70), addDays(ANCHOR_DATE, 295), 'Development objective approved for the next review cycle.');

  const commInsert = db.prepare(`INSERT INTO communication_plan
    (workspace_id,what,audience,channel,frequency,owner_name,internal_external,last_sent_date,next_due_date,trigger_event,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  [
    ['ISMS performance and risk decisions','Executive ISMS Steering Committee','Management review pack','Quarterly','CISO','internal',-80,18,'Quarter end'],
    ['Security responsibilities and policy changes','All workforce','Learning platform and town hall','At onboarding and annually','People Director','internal',-65,300,'Policy publication'],
    ['Material security incident notice','Affected customers and regulators','Approved incident communication channel','Event driven','General Counsel','external',null,null,'Notification threshold met'],
    ['Supplier assurance expectations','Critical suppliers','Contract schedule and assurance review','At onboarding and annually','Supplier Risk Lead','external',-55,75,'Supplier tier or service changes'],
  ].forEach(seed => commInsert.run(
    workspaceId, seed[0], seed[1], seed[2], seed[3], seed[4], seed[5],
    seed[6] == null ? null : addDays(ANCHOR_DATE, seed[6]), seed[7] == null ? null : addDays(ANCHOR_DATE, seed[7]),
    seed[8], 'Communication content, approval and evidence expectations are defined.'
  ));

  const improvementInsert = db.prepare(`INSERT INTO improvements
    (workspace_id,title,description,source,source_ref,owner_name,due_date,status,closed_at,impact_notes,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  [
    ['Automate privileged-access evidence','Generate a reconciled quarterly population and owner-attestation pack.','audit',`audit:${auditIds[0]}`,'Identity Governance Lead',45,'in_progress',null,'Reduces manual reconciliation and missed service accounts.'],
    ['Consolidate recovery evidence','Create one service-level record covering technical results and business acceptance.','mrm','MRM-2026-Q2','Head of Platform',60,'in_progress',null,'Improves defensibility of recovery objectives and decisions.'],
    ['Add incident decision timestamps','Update the controlled incident and exercise record.','incident','Payment service cyber-crisis exercise','Security Operations Lead',-10,'done',-8,'Improves contractual and regulatory timing evidence.'],
  ].forEach(seed => improvementInsert.run(
    workspaceId, seed[0], seed[1], seed[2], seed[3], seed[4], addDays(ANCHOR_DATE, seed[5]), seed[6],
    seed[7] == null ? null : sqlDateTime(addDays(ANCHOR_DATE, seed[7])), seed[8], managerId,
    sqlDateTime(addDays(ANCHOR_DATE, -30))
  ));

  // Tie the active implementation plan to actual evidence without pretending
  // that later certification phases have already been completed.
  const openDeliverables = db.prepare(`SELECT id FROM engagement_delivery_deliverables
    WHERE workspace_id=? AND status IN ('draft','submitted') ORDER BY id LIMIT 4`).all(workspaceId);
  openDeliverables.forEach((deliverable, index) => db.prepare(`INSERT OR IGNORE INTO engagement_delivery_evidence
    (workspace_id,deliverable_id,evidence_id,linked_by) VALUES (?,?,?,?)`).run(
      workspaceId, deliverable.id, evidence[(index + 4) % evidence.length].id, clientOwnerId
    ));

  // Assert the requirement ids used above still resolve in the active catalog.
  assert.equal(requirements.length, 118);
  assert.notEqual(managerId, reviewerId);
}

function assertLifecycleChronology(result) {
  const { scenario, workspaceId, engagementId, passId, planId } = result;
  const noViolations = (sql, message, ...params) => assert.equal(scalar(sql, ...params), 0, message);

  noViolations(`SELECT COUNT(*) c FROM workspaces WHERE id=? AND (
    julianday(created_at)>julianday(updated_at) OR julianday(updated_at)>julianday('now'))`,
  'Workspace timestamps are out of sequence or in the future.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM assets WHERE workspace_id=? AND (
    created_at IS NULL OR updated_at IS NULL
    OR julianday(created_at)>julianday(updated_at)
    OR julianday(updated_at)>julianday('now'))`,
  'Asset creation/update timestamps are out of sequence or in the future.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM consulting_engagements e WHERE e.id=? AND (
    julianday(e.created_at)>julianday(e.start_date)
    OR EXISTS (SELECT 1 FROM engagement_time_entries t WHERE t.engagement_id=e.id
      AND julianday(e.created_at)>julianday(t.created_at)))`,
  'Engagement creation does not precede its delivery records.', engagementId);
  noViolations(`SELECT COUNT(*) c FROM consulting_engagement_team team
    JOIN engagement_time_entries t ON t.engagement_id=team.engagement_id AND t.user_id=team.user_id
    WHERE team.engagement_id=? AND julianday(team.assigned_at)>julianday(t.created_at)`,
  'Engagement-team assignment postdates attributed delivery time.', engagementId);
  noViolations(`SELECT COUNT(*) c FROM engagement_time_entries t JOIN users u ON u.id=t.user_id
    WHERE t.engagement_id=? AND t.user_id=? AND julianday(u.created_at)>julianday(t.created_at)`,
  'Reserved reviewer account postdates attributed delivery time.', engagementId, result.reviewerId);
  noViolations(`SELECT COUNT(*) c FROM engagement_time_entries t
    JOIN users worker ON worker.id=t.user_id
    LEFT JOIN users approver ON approver.id=t.approved_by
    JOIN consulting_engagements e ON e.id=t.engagement_id
    LEFT JOIN consulting_engagement_team team
      ON team.engagement_id=t.engagement_id AND team.user_id=t.user_id
    WHERE t.engagement_id=? AND (
      t.approved_at IS NULL OR approver.id IS NULL OR team.user_id IS NULL
      OR worker.created_at IS NULL OR approver.created_at IS NULL
      OR e.created_at IS NULL OR team.assigned_at IS NULL
      OR julianday(t.created_at)>julianday(t.approved_at)
      OR julianday(worker.created_at)>julianday(t.created_at)
      OR julianday(worker.created_at)>julianday(t.approved_at)
      OR julianday(approver.created_at)>julianday(t.created_at)
      OR julianday(approver.created_at)>julianday(t.approved_at)
      OR julianday(e.created_at)>julianday(t.created_at)
      OR julianday(e.created_at)>julianday(t.approved_at)
      OR julianday(team.assigned_at)>julianday(t.created_at)
      OR julianday(team.assigned_at)>julianday(t.approved_at))`,
  'Time-entry actor, approval and engagement-team authority chronology is invalid.', engagementId);
  noViolations(`SELECT COUNT(*) c FROM workspaces w
    JOIN consulting_engagements e ON e.workspace_id=w.id
    JOIN assessment_passes p ON p.workspace_id=w.id AND p.id=?
    WHERE w.id=? AND (
      julianday(w.created_at)>julianday(e.start_date)
      OR julianday(e.start_date)>julianday((SELECT MIN(i.answered_at) FROM engagement_intake i WHERE i.workspace_id=w.id))
      OR julianday((SELECT MAX(i.answered_at) FROM engagement_intake i WHERE i.workspace_id=w.id))>julianday(p.started_at)
      OR julianday(w.scope_confirmed_at)>julianday(p.started_at)
      OR julianday(p.started_at)>julianday((SELECT MAX(h.snapshot_at) FROM control_state_history h WHERE h.pass_id=p.id))
      OR julianday(p.completed_at)>julianday((SELECT MIN(r.generated_at) FROM consulting_report_snapshots r WHERE r.workspace_id=w.id))
    )`,
  'Workspace, engagement, intake, scope, pass and report chronology is invalid.', passId, workspaceId);
  noViolations(`SELECT COUNT(*) c FROM assessment_passes p WHERE p.id=? AND (
    julianday(p.started_at)>julianday(p.completed_at) OR EXISTS (
      SELECT 1 FROM control_state_history h WHERE h.pass_id=p.id
        AND julianday(h.snapshot_at)>julianday(p.completed_at)))`,
  'Assessment pass completed before one of its retained conclusions.', passId);
  noViolations(`SELECT COUNT(*) c FROM consultant_workpapers WHERE workspace_id=? AND (
    julianday(created_at)>julianday(prepared_at) OR julianday(prepared_at)>julianday(approved_at)
    OR julianday(approved_at)>julianday(frozen_at) OR julianday(frozen_at)>julianday(updated_at))`,
  'Frozen workpaper chronology is invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM generated_docs d WHERE d.workspace_id=? AND (
    d.status<>'published' OR d.locked<>1 OR d.created_by=d.approved_by
    OR julianday(d.created_at)>julianday(d.approved_at)
    OR julianday(d.approved_at)>julianday(d.published_at)
    OR julianday(d.published_at)>julianday(d.updated_at)
    OR instr(d.content,'{{')>0 OR instr(d.content,'[')>0 OR instr(d.content,'**Starting point.**')>0
    OR instr(lower(d.content),'starter template')>0 OR instr(lower(d.content),'starter objective')>0
    OR instr(lower(d.content),'replace bracketed placeholder')>0
    OR instr(lower(d.content),'adjust to ')>0
    OR d.doc_kind<>d.category OR d.doc_kind NOT IN ('form','plan','policy','procedure','record')
    OR NOT EXISTS (SELECT 1 FROM doc_versions dv WHERE dv.id=d.current_version_id
      AND dv.document_id=d.id AND dv.status='published')
    OR NOT EXISTS (SELECT 1 FROM doc_approvers da WHERE da.document_id=d.id
      AND da.version_id=d.current_version_id AND da.user_id=d.approved_by
      AND da.decision='approved' AND julianday(da.decided_at)<=julianday(d.published_at)))`,
  'Published document lifecycle, maker-checker, locking or finalization is invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM doc_versions dv JOIN generated_docs d ON d.id=dv.document_id
    WHERE d.workspace_id=? AND (julianday(dv.created_at)>julianday(dv.submitted_at)
      OR julianday(dv.submitted_at)>julianday(dv.approved_at)
      OR julianday(dv.approved_at)>julianday(dv.published_at))`,
  'Document version chronology is invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM generated_docs d
    JOIN users maker ON maker.id=d.created_by
    JOIN users checker ON checker.id=d.approved_by
    JOIN workspace_members maker_membership ON maker_membership.workspace_id=d.workspace_id AND maker_membership.user_id=maker.id
    JOIN workspace_members checker_membership ON checker_membership.workspace_id=d.workspace_id AND checker_membership.user_id=checker.id
    WHERE d.workspace_id=? AND (
      julianday(maker.created_at)>julianday(d.created_at)
      OR julianday(checker.created_at)>julianday(d.approved_at)
      OR julianday(maker_membership.created_at)>julianday(d.created_at)
      OR julianday(checker_membership.created_at)>julianday(d.approved_at))`,
  'Document actors or workspace authority postdate their governed actions.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM client_requests WHERE workspace_id=? AND status='accepted' AND (
    version<>4 OR evidence_quality<>'sufficient' OR submitted_at IS NULL OR closed_at IS NULL
    OR julianday(created_at)>julianday(submitted_at)
    OR julianday(submitted_at)>julianday(closed_at)
    OR julianday(closed_at)>julianday(updated_at))`,
  'Accepted RFI chronology or version progression is invalid.', workspaceId);

  const requests = db.prepare(`SELECT id FROM client_requests WHERE workspace_id=? AND status='accepted' ORDER BY id`).all(workspaceId);
  assert.equal(requests.length, 3, 'Each governed assessment must retain three accepted RFIs.');
  for (const request of requests) {
    const chain = db.prepare(`SELECT from_status,to_status FROM client_request_events
      WHERE request_id=? AND event_type='status_changed' ORDER BY id`).all(request.id)
      .map(row => `${row.from_status}->${row.to_status}`);
    assert.deepEqual(chain, ['open->in_progress', 'in_progress->submitted', 'submitted->accepted'],
      `RFI ${request.id} does not retain the complete responder/reviewer transition chain.`);
  }

  noViolations(`SELECT COUNT(*) c FROM consulting_findings WHERE workspace_id=? AND status='confirmed' AND (
    confirmed_at IS NULL OR julianday(created_at)>julianday(confirmed_at)
    OR julianday(confirmed_at)>julianday(updated_at))`,
  'Confirmed finding chronology is invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM consulting_findings f
    JOIN consultant_workpapers wp ON wp.id=f.workpaper_id
    JOIN requirements r ON r.id=wp.requirement_id
    JOIN control_state_history h ON h.workspace_id=f.workspace_id AND h.pass_id=? AND h.iso_item_id=r.ref
    WHERE f.workspace_id=? AND (r.ref NOT IN ('annex-a.5.14','annex-a.5.24','annex-a.5.35')
      OR h.status='Implemented')`,
  'Confirmed finding does not match its exact non-implemented assessment conclusion.', passId, workspaceId);
  noViolations(`SELECT COUNT(*) c FROM gap_assessment_phase_decisions d
    JOIN assessment_passes p ON p.id=d.assessment_pass_id
    WHERE d.workspace_id=? AND julianday(d.decided_at)<julianday(p.completed_at)`,
  'A governed phase decision predates pass completion.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM consulting_report_snapshots r WHERE r.workspace_id=? AND (
    r.status<>'published' OR r.generated_by=r.approved_by
    OR julianday(r.generated_at)>julianday(r.approved_at)
    OR julianday(r.approved_at)>julianday(r.published_at))`,
  'Published report chronology or maker-checker is invalid.', workspaceId);
  if (scenario.key === 'gap') {
    noViolations(`SELECT COUNT(*) c FROM gap_fieldwork_snapshots s
      WHERE s.workspace_id=? AND (
        julianday(s.created_at)<julianday(s.week_ending)
        OR date(s.week_ending)<date((SELECT MAX(h.snapshot_at) FROM control_state_history h
          WHERE h.workspace_id=s.workspace_id AND h.pass_id=s.assessment_pass_id))
        OR date(s.week_ending)<date((SELECT MAX(i.completed_at) FROM gap_fieldwork_interviews i
          WHERE i.workspace_id=s.workspace_id AND i.assessment_pass_id=s.assessment_pass_id AND i.status='completed'))
        OR date(s.week_ending)<date((SELECT MAX(r.closed_at) FROM client_requests r
          WHERE r.workspace_id=s.workspace_id AND r.status='accepted'))
        OR date(s.week_ending)<date((SELECT MAX(b.resolved_at) FROM gap_fieldwork_blockers b
          WHERE b.workspace_id=s.workspace_id AND b.assessment_pass_id=s.assessment_pass_id))
        OR date(s.week_ending)<date((SELECT MAX(d.confirmed_at) FROM gap_declared_defaults d
          WHERE d.workspace_id=s.workspace_id AND d.assessment_pass_id=s.assessment_pass_id AND d.status='confirmed'))
        OR
        julianday(s.created_at)<julianday((SELECT MAX(h.snapshot_at) FROM control_state_history h
          WHERE h.workspace_id=s.workspace_id AND h.pass_id=s.assessment_pass_id))
        OR julianday(s.created_at)<julianday((SELECT MAX(i.completed_at) FROM gap_fieldwork_interviews i
          WHERE i.workspace_id=s.workspace_id AND i.assessment_pass_id=s.assessment_pass_id AND i.status='completed'))
        OR julianday(s.created_at)<julianday((SELECT MAX(r.closed_at) FROM client_requests r
          WHERE r.workspace_id=s.workspace_id AND r.status='accepted'))
        OR julianday(s.created_at)<julianday((SELECT MAX(b.resolved_at) FROM gap_fieldwork_blockers b
          WHERE b.workspace_id=s.workspace_id AND b.assessment_pass_id=s.assessment_pass_id))
        OR julianday(s.created_at)<julianday((SELECT MAX(d.confirmed_at) FROM gap_declared_defaults d
          WHERE d.workspace_id=s.workspace_id AND d.assessment_pass_id=s.assessment_pass_id AND d.status='confirmed'))
        OR julianday(s.created_at)>julianday((SELECT MIN(r.generated_at) FROM consulting_report_snapshots r
          WHERE r.workspace_id=s.workspace_id)))`,
    'A frozen fieldwork snapshot or reporting date predates a claimed source fact or postdates its report.', workspaceId);
    noViolations(`SELECT COUNT(*) c FROM consulting_report_snapshots r
      JOIN consulting_engagements e ON e.id=r.engagement_id
      WHERE r.workspace_id=? AND julianday(r.published_at)>julianday(e.completed_at)`,
    'Gap engagement completed before its controlled report was published.', workspaceId);
  }

  noViolations(`SELECT COUNT(*) c FROM engagement_delivery_deliverables d WHERE d.workspace_id=? AND (
    (d.status IN ('submitted','accepted') AND (d.submitted_at IS NULL
      OR julianday(d.created_at)>julianday(d.submitted_at)))
    OR (d.status='accepted' AND (d.accepted_at IS NULL
      OR julianday(d.submitted_at)>julianday(d.accepted_at)))
    OR (COALESCE(d.accepted_at,d.submitted_at) IS NOT NULL
      AND julianday(COALESCE(d.accepted_at,d.submitted_at))>julianday(d.updated_at)))`,
  'Delivery item lifecycle timestamps are invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
    WHERE d.workspace_id=? AND d.status IN ('submitted','accepted') AND m.status='not_started'`,
  'Active or accepted delivery items have an unstarted milestone.', workspaceId);
  const governedDeliverables = db.prepare(`SELECT id,status FROM engagement_delivery_deliverables
    WHERE workspace_id=? AND status IN ('submitted','accepted')`).all(workspaceId);
  for (const deliverable of governedDeliverables) {
    const actions = db.prepare(`SELECT action FROM engagement_delivery_events
      WHERE workspace_id=? AND entity_type='deliverable' AND entity_id=? ORDER BY id`).all(
        workspaceId, deliverable.id
      ).map(row => row.action);
    assert.ok(actions.includes('submit'), `Deliverable ${deliverable.id} lacks a submit event.`);
    if (deliverable.status === 'accepted') {
      assert.ok(actions.includes('accept'), `Deliverable ${deliverable.id} lacks an accept event.`);
    }
  }

  noViolations(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND (
    julianday(created_at)>julianday(fieldwork_started_at)
    OR (report_issued_at IS NOT NULL AND julianday(fieldwork_started_at)>julianday(report_issued_at))
    OR (closed_at IS NOT NULL AND julianday(report_issued_at)>julianday(closed_at))
    OR (status='complete' AND lifecycle_stage<>'closed')
    OR (status='in_progress' AND lifecycle_stage<>'fieldwork')
    OR (sample_size IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audit_samples s
      WHERE s.audit_id=audits.id AND s.sample_size=audits.sample_size
        AND s.population_size=audits.population_size)))`,
  'Audit lifecycle vocabulary, chronology or sample traceability is invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM audit_findings af
    JOIN audits a ON a.id=af.audit_id
    LEFT JOIN nonconformities nc ON nc.id=af.nonconformity_id
    WHERE a.workspace_id=? AND (
      (a.report_issued_at IS NOT NULL AND julianday(af.created_at)>julianday(a.report_issued_at))
      OR (a.closed_at IS NOT NULL AND julianday(af.created_at)>julianday(a.closed_at))
      OR (nc.id IS NOT NULL AND julianday(af.created_at)>julianday(nc.created_at)))`,
  'Audit finding chronology is inconsistent with its report, closure or linked nonconformity.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=? AND (
    category NOT IN ('malware','phishing','breach','dos','physical','insider','supplier','other')
    OR (status='closed' AND (julianday(created_at)>julianday(closed_at)
      OR NOT EXISTS (SELECT 1 FROM incident_events ie WHERE ie.incident_id=incidents.id))))`,
  'Incident category, chronology or timeline is invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=? AND completed_date IS NOT NULL
    AND julianday(created_at)>julianday(completed_date)`,
  'Training record was created after its completion.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM training_records t JOIN training_courses c ON c.id=t.course_id
    WHERE t.workspace_id=? AND (julianday(c.created_at)>julianday(t.created_at)
      OR julianday(c.created_at)>julianday(t.assigned_date))`,
  'Training course was created after a linked assignment or completion record.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM competence_records r JOIN competence_roles role ON role.id=r.role_id
    WHERE r.workspace_id=? AND (r.evidence_type NOT IN ('Certification','Training','Experience','Qualification','Other')
      OR julianday(role.created_at)>julianday(r.created_at)
      OR julianday(role.created_at)>julianday(r.recorded_at))`,
  'Competence evidence vocabulary or role chronology is invalid.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND closed_at IS NOT NULL
    AND julianday(created_at)>julianday(closed_at)`,
  'Nonconformity was created after closure.', workspaceId);
  noViolations(`SELECT COUNT(*) c FROM engagement_time_entries WHERE engagement_id=? AND approved_at IS NOT NULL
    AND julianday(created_at)>julianday(approved_at)`,
  'Time entry was approved before creation.', engagementId);
  noViolations(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=? AND (
    data_access NOT IN ('none','metadata','confidential','personal','sensitive')
    OR dependency_type NOT IN ('multi_source','single_source')
    OR lifecycle_stage<>'prospect' OR approved_at IS NOT NULL OR approved_by IS NOT NULL
    OR last_assessed IS NOT NULL OR inherent_risk_score IS NOT NULL
    OR residual_risk_score IS NOT NULL OR attestations IS NOT NULL)`,
  'Supplier intake record uses unsupported UI/domain vocabulary.', workspaceId);
  if (scenario.key === 'implementation') {
    assert.equal(scalar(`SELECT COUNT(*) c FROM tprm_modules
      WHERE workspace_id=? AND service_model='programme_setup' AND status='active'`, workspaceId), 1,
    'Implementation client must have one active programme-setup TPRM service period.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM suppliers s JOIN entities e ON e.id=s.entity_id
      WHERE s.workspace_id=? AND e.workspace_id=s.workspace_id AND e.entity_type='supplier'`, workspaceId), 4,
    'Every supplier must retain its canonical generic entity projection.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM tprm_legal_entities le
      JOIN suppliers s ON s.id=le.supplier_id AND s.workspace_id=le.workspace_id
      WHERE le.workspace_id=?`, workspaceId), 4,
    'Every supplier must retain one governed legal-entity identity.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM tprm_service_relationships r
      JOIN suppliers s ON s.id=r.supplier_id AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=? AND r.is_primary=1 AND r.status='intake'
        AND r.legal_entity_id IN (SELECT id FROM tprm_legal_entities le
          WHERE le.workspace_id=r.workspace_id AND le.supplier_id=r.supplier_id)`, workspaceId), 4,
    'Every supplier must have one canonical primary intake relationship.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM tprm_relationship_events event
      JOIN tprm_service_relationships r ON r.id=event.relationship_id AND r.workspace_id=event.workspace_id
      WHERE event.workspace_id=? AND event.event_type='relationship_created'
        AND event.event_hash IS NOT NULL`, workspaceId), 4,
    'Every primary relationship must retain its hashed creation event.');
    noViolations(`SELECT COUNT(*) c FROM tprm_service_relationships r
      JOIN suppliers s ON s.id=r.supplier_id AND s.workspace_id=r.workspace_id
      JOIN entities e ON e.id=s.entity_id AND e.workspace_id=s.workspace_id
      JOIN tprm_legal_entities le ON le.id=r.legal_entity_id AND le.workspace_id=r.workspace_id
      JOIN tprm_relationship_events event ON event.relationship_id=r.id
        AND event.workspace_id=r.workspace_id AND event.event_type='relationship_created'
      WHERE r.workspace_id=? AND (
        julianday(e.created_at)>julianday(s.created_at)
        OR julianday(s.created_at)>julianday(le.created_at)
        OR julianday(le.created_at)>julianday(r.created_at)
        OR julianday(r.created_at)>julianday(event.occurred_at))`,
    'Supplier entity, legal identity, relationship or event chronology is invalid.', workspaceId);
    assert.equal(scalar(`SELECT COUNT(*) c FROM tprm_lifecycle_events event
      JOIN tprm_modules module ON module.id=event.module_id AND module.workspace_id=event.workspace_id
      WHERE event.workspace_id=? AND event.event_type='module_enabled'
        AND event.event_hash IS NOT NULL AND julianday(event.occurred_at)>=julianday(module.created_at)`, workspaceId), 1,
    'TPRM programme setup must retain its hashed activation lineage.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM supplier_clauses c
      JOIN suppliers s ON s.id=c.supplier_id AND s.workspace_id=c.workspace_id
      WHERE c.workspace_id=? AND c.status='pending'`, workspaceId), 48,
    'Programme setup must retain all pending supplier contract-clause prompts.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM tprm_assessment_cycles WHERE workspace_id=?`, workspaceId), 0,
    'Programme setup must not fabricate governed assessment cycles.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM supplier_inherent_assessments WHERE workspace_id=?`, workspaceId), 0,
    'Programme setup must not fabricate inherent-risk answers or approvals.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM supplier_ddq_assessments WHERE workspace_id=?`, workspaceId), 0,
    'Programme setup must not fabricate due-diligence responses.');
    assert.equal(scalar(`SELECT COUNT(*) c FROM tprm_client_decisions WHERE workspace_id=?`, workspaceId), 0,
    'Programme setup must not fabricate client approvals.');
  }
  noViolations(`SELECT COUNT(*) c FROM risks r WHERE r.workspace_id=? AND r.status='open'
    AND NOT EXISTS (SELECT 1 FROM risk_controls rc WHERE rc.risk_id=r.id)`,
  'An open risk is orphaned from ISO 27001 controls.', workspaceId);

  const lifecycleWorkspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  lifecycleWorkspace.frameworks = JSON.parse(lifecycleWorkspace.frameworks || '[]');
  const projection = engagementDelivery.getProjection(db, lifecycleWorkspace, result.reviewerId);
  if (scenario.key === 'gap') {
    assert.equal(projection.phases.find(phase => phase.phase_key === 'gap_assessment')?.effective_status, 'complete');
    assert.equal(db.prepare(`SELECT status FROM engagement_delivery_phases
      WHERE plan_id=? AND phase_key='mobilisation'`).get(planId).status, 'complete');
  } else {
    assert.equal(projection.currentPhase?.phase_key, 'implementation');
    for (const key of ['mobilisation','gap_assessment','context','assessment','treatment']) {
      assert.equal(projection.phases.find(phase => phase.phase_key === key)?.effective_status, 'complete',
        `Implementation journey phase ${key} must be complete.`);
    }
    assert.equal(projection.phases.find(phase => phase.phase_key === 'implementation')?.effective_status, 'in_progress');
    for (const phase of projection.phases.slice(projection.phases.findIndex(item => item.phase_key === 'operating_evidence'))) {
      assert.equal(phase.effective_status, 'not_started', `Future phase ${phase.phase_key} must remain not started.`);
    }
  }
}

function assertSeededWorkspace(result) {
  const { scenario, workspaceId, engagementId, planId, passId } = result;
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  assert.ok(workspace);
  assert.equal(workspace.engagement_outcome, scenario.outcome);
  assert.equal(workspace.stage, scenario.stage);
  assert.equal(workspace.target_cert_date, scenario.targetDate);
  assert.equal(workspace.frameworks, '["iso27001"]');
  assert.equal(scalar(`SELECT COUNT(*) c FROM engagement_intake WHERE workspace_id=?
    AND length(trim(COALESCE(answer,'')))>0`, workspaceId), scenario.intakeCount);
  assert.equal(scalar(`SELECT COUNT(*) c FROM control_instances WHERE workspace_id=? AND entity_id IS NULL`, workspaceId), 118);
  assert.equal(scalar(`SELECT COUNT(*) c FROM control_instances WHERE workspace_id=? AND entity_id IS NOT NULL`, workspaceId), 0);
  assert.equal(scalar(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND pass_id=?`, workspaceId, passId), 118);
  assert.equal(scalar(`SELECT COUNT(*) c FROM consultant_workpapers WHERE workspace_id=? AND status='frozen'`, workspaceId), 118);
  assert.equal(scalar(`SELECT COUNT(*) c FROM consultant_workpaper_snapshots s
    JOIN consultant_workpapers w ON w.id=s.workpaper_id WHERE w.workspace_id=?`, workspaceId), 118);
  assert.ok(scalar(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=?`, workspaceId) >= 8);
  assert.equal(scalar(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`, workspaceId), 12);
  assert.equal(scalar(`SELECT COUNT(*) c FROM evidence_requirement_links erl
    JOIN evidence e ON e.id=erl.evidence_id WHERE e.workspace_id=?`, workspaceId), 118);
  assert.ok(scalar(`SELECT COUNT(*) c FROM document_requirement_links drl
    JOIN generated_docs d ON d.id=drl.document_id WHERE d.workspace_id=?`, workspaceId) >= 93);
  assert.equal(scalar(`SELECT COUNT(*) c FROM document_requirement_links drl
    JOIN generated_docs d ON d.id=drl.document_id
    JOIN requirements r ON r.id=drl.requirement_id
    WHERE d.workspace_id=? AND d.name='Statement of Applicability - cover page'
      AND r.req_type='control'`, workspaceId), 93);
  assert.equal(scalar(`SELECT COUNT(*) c FROM workspace_members wm JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? AND wm.role='client_owner' AND u.user_type='client' AND u.active=1`, workspaceId), 1);
  assert.equal(scalar(`SELECT COUNT(*) c FROM workspace_members wm JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? AND wm.role='isms_manager' AND wm.user_id=?
      AND u.user_type='client' AND u.active=1`, workspaceId, result.clientEditorId), 1);
  assert.equal(scalar(`SELECT COUNT(*) c FROM consulting_engagement_team
    WHERE engagement_id=? AND role='quality_reviewer' AND user_id=?`, engagementId, result.reviewerId), 1);
  assert.equal(scalar(`SELECT COUNT(*) c FROM engagement_delivery_plans
    WHERE id=? AND workspace_id=? AND consulting_engagement_id=?`, planId, workspaceId, engagementId), 1);
  assert.equal(scalar(`SELECT COUNT(*) c FROM assessment_passes
    WHERE id=? AND workspace_id=? AND status='completed' AND started_by<>completed_by`, passId, workspaceId), 1);

  const implemented = scalar(`SELECT COUNT(*) c FROM control_instances
    WHERE workspace_id=? AND status='implemented'`, workspaceId);
  const gaps = scalar(`SELECT COUNT(*) c FROM control_instances
    WHERE workspace_id=? AND status IN ('partially_implemented','work_in_progress','not_implemented')`, workspaceId);
  if (scenario.key === 'gap') {
    assert.ok(implemented >= 30 && implemented < 50);
    assert.ok(gaps >= 70);
    assert.equal(scalar(`SELECT COUNT(*) c FROM gap_fieldwork_interviews
      WHERE workspace_id=? AND status='completed'`, workspaceId), 4);
    assert.equal(scalar(`SELECT COUNT(*) c FROM client_requests
      WHERE workspace_id=? AND status='accepted' AND evidence_quality='sufficient'`, workspaceId), 3);
    assert.equal(scalar(`SELECT COUNT(*) c FROM gap_fieldwork_blockers
      WHERE workspace_id=? AND status='resolved'`, workspaceId), 1);
    assert.equal(scalar(`SELECT COUNT(*) c FROM gap_declared_defaults
      WHERE workspace_id=? AND status='confirmed'`, workspaceId), 1);
    assert.equal(scalar(`SELECT COUNT(*) c FROM gap_fieldwork_snapshots WHERE workspace_id=?`, workspaceId), 3);
    assert.equal(scalar(`SELECT COUNT(*) c FROM gap_assessment_phase_decisions
      WHERE workspace_id=? AND phase IN ('mobilisation','fieldwork','validation') AND decision='complete'`, workspaceId), 3);
    assert.equal(scalar(`SELECT COUNT(*) c FROM consulting_findings
      WHERE workspace_id=? AND status='confirmed' AND client_visible=1`, workspaceId), 3);
    assert.equal(scalar(`SELECT COUNT(*) c FROM consulting_report_snapshots
      WHERE workspace_id=? AND status='published' AND approved_by IS NOT NULL
        AND approved_by<>generated_by AND published_at IS NOT NULL`, workspaceId), 1);
    assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'complete');
    assert.equal(db.prepare(`SELECT billing_status FROM engagement_commercials
      WHERE engagement_id=?`).get(engagementId).billing_status, 'fully_billed');
    assert.equal(scalar(`SELECT COUNT(*) c FROM cert_cycle_events WHERE workspace_id=?`, workspaceId), 0);
    assert.equal(scalar(`SELECT COUNT(*) c FROM gap_assessment_phase_decisions
      WHERE workspace_id=? AND phase='post_report'`, workspaceId), 0);
    assert.equal(scalar(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?`, workspaceId), 0);
  } else {
    assert.ok(implemented >= 90, 'Implementation client must be mostly implemented.');
    assert.ok(gaps >= 10, 'Implementation client must retain visible implementation work.');
    assert.ok(scalar(`SELECT COUNT(*) c FROM assets WHERE workspace_id=?`, workspaceId) >= 6);
    assert.ok(scalar(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`, workspaceId) >= 6);
    assert.ok(scalar(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=?`, workspaceId) >= 8);
    assert.ok(scalar(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`, workspaceId) >= 2);
    assert.ok(scalar(`SELECT COUNT(*) c FROM audit_findings af JOIN audits a ON a.id=af.audit_id WHERE a.workspace_id=?`, workspaceId) >= 3);
    assert.ok(scalar(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?`, workspaceId) >= 3);
    assert.ok(scalar(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?`, workspaceId) >= 2);
    assert.ok(scalar(`SELECT COUNT(*) c FROM security_objectives WHERE workspace_id=?`, workspaceId) >= 4);
    assert.ok(scalar(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=?`, workspaceId) >= 4);
    assert.ok(scalar(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=?`, workspaceId) >= 2);
    assert.ok(scalar(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=?`, workspaceId) >= 6);
    assert.ok(scalar(`SELECT COUNT(*) c FROM competence_records WHERE workspace_id=?`, workspaceId) >= 3);
    assert.ok(scalar(`SELECT COUNT(*) c FROM communication_plan WHERE workspace_id=?`, workspaceId) >= 4);
    assert.ok(scalar(`SELECT COUNT(*) c FROM improvements WHERE workspace_id=?`, workspaceId) >= 3);
    assert.equal(db.prepare('SELECT status FROM consulting_engagements WHERE id=?').get(engagementId).status, 'active');
    assert.equal(db.prepare('SELECT status FROM engagement_delivery_plans WHERE id=?').get(planId).status, 'active');
  }
  assertLifecycleChronology(result);
}

function verifyPhysicalEvidence(filePath, file, label = 'Evidence') {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.length, file.sizeBytes, `${label} size mismatch for ${file.filename}`);
  assert.equal(sha(bytes), file.sha256, `${label} hash mismatch for ${file.filename}`);
}

function removeNewlyCreatedEvidence(materialization) {
  if (!materialization) return;
  for (const created of [...materialization.newlyCreated].reverse()) {
    try {
      const stat = fs.lstatSync(created.path);
      if (stat.isFile() && stat.dev === created.dev && stat.ino === created.ino) {
        fs.unlinkSync(created.path);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function materializeEvidenceFiles(manager, stagedFiles) {
  const firmDir = path.join(UPLOAD_ROOT, `firm_${manager.firm_id}`);
  fs.mkdirSync(firmDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(firmDir, 0o700); } catch (_) {}
  const stageDir = fs.mkdtempSync(path.join(firmDir, '.nimbus-iso27001-test-stage-'));
  const materialization = {
    firmDir,
    desiredNames: new Set(stagedFiles.map(file => file.filename)),
    newlyCreated: [],
  };
  const clearStageDir = () => {
    if (!fs.existsSync(stageDir)) return;
    for (const entry of fs.readdirSync(stageDir, { withFileTypes: true })) {
      if (entry.isFile()) fs.unlinkSync(path.join(stageDir, entry.name));
    }
    fs.rmdirSync(stageDir);
  };

  // Existing content-addressed names are read-only. New files are staged on the
  // same filesystem, verified, then hard-linked into place create-only.
  try {
    for (const file of stagedFiles) {
      const destination = path.join(firmDir, normalizeFileName(file.filename));
      if (fs.existsSync(destination)) {
        verifyPhysicalEvidence(destination, file, 'Existing evidence');
        continue;
      }
      const stagedPath = path.join(stageDir, normalizeFileName(file.filename));
      fs.writeFileSync(stagedPath, file.buffer, { flag: 'wx', mode: 0o600 });
      verifyPhysicalEvidence(stagedPath, file, 'Staged evidence');
      try {
        fs.linkSync(stagedPath, destination);
        const stat = fs.lstatSync(destination);
        materialization.newlyCreated.push({ path: destination, dev: stat.dev, ino: stat.ino });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        verifyPhysicalEvidence(destination, file, 'Concurrent evidence');
      }
      fs.unlinkSync(stagedPath);
    }
    clearStageDir();
    stagedFiles.forEach(file => verifyPhysicalEvidence(
      path.join(firmDir, normalizeFileName(file.filename)), file
    ));
    return materialization;
  } catch (error) {
    clearStageDir();
    removeNewlyCreatedEvidence(materialization);
    throw error;
  }
}

function removeStaleEvidenceAfterCommit(materialization) {
  for (const entry of fs.readdirSync(materialization.firmDir, { withFileTypes: true })) {
    if (!entry.isFile()
        || !entry.name.startsWith(SEED_FILE_PREFIX)
        || materialization.desiredNames.has(entry.name)) continue;
    fs.unlinkSync(path.join(materialization.firmDir, entry.name));
  }
}

function verifyEvidenceFiles(stagedFiles, results, materialization) {
  const stagedByName = new Map(stagedFiles.map(file => [file.filename, file]));
  const workspaceIds = results.map(result => result.workspaceId);
  const rows = db.prepare(`SELECT workspace_id,filename,stored_path,sha256,size_bytes FROM evidence
    WHERE workspace_id IN (${workspaceIds.map(() => '?').join(',')}) ORDER BY workspace_id,id`).all(...workspaceIds);
  assert.equal(rows.length, stagedFiles.length, 'Every staged file must have exactly one evidence row.');
  for (const row of rows) {
    assert.equal(row.filename, row.stored_path, 'Synthetic evidence stored_path must be its safe basename.');
    const expected = stagedByName.get(row.stored_path);
    assert.ok(expected, `Unexpected synthetic evidence path ${row.stored_path}`);
    assert.equal(row.size_bytes, expected.sizeBytes);
    assert.equal(row.sha256, expected.sha256);
    verifyPhysicalEvidence(path.join(materialization.firmDir, normalizeFileName(row.stored_path)), expected);
  }
  const diskNames = fs.readdirSync(materialization.firmDir)
    .filter(name => name.startsWith(SEED_FILE_PREFIX))
    .sort();
  assert.deepEqual(diskNames, [...stagedByName.keys()].sort(), 'Seed-owned upload prefix contains stale or missing files.');
}

function main() {
  const password = process.env.DEMO_SEED_PASSWORD || LOCAL_PASSWORD;
  if (process.env.NODE_ENV === 'production' && !process.env.DEMO_SEED_PASSWORD) {
    throw new Error('DEMO_SEED_PASSWORD is required when seeding test clients in production.');
  }
  if (password.length < 12) throw new Error('DEMO_SEED_PASSWORD must contain at least 12 characters.');
  preflightUploadRoot();
  ({ db, init, ensureWorkspaceMethodology, logAction } = require('../db'));
  init();

  const manager = resolveFirmAndManager();
  const requirements = isoRequirements();
  const stagedFiles = SCENARIOS.flatMap(scenario => evidencePackets(scenario, requirements));
  const stagedByScenario = Object.fromEntries(SCENARIOS.map(scenario => [
    scenario.key, stagedFiles.filter(file => file.scenarioKey === scenario.key),
  ]));
  const passwordHash = bcrypt.hashSync(password, 12);
  const materialization = materializeEvidenceFiles(manager, stagedFiles);

  const preservedBefore = db.prepare(`SELECT id,firm_id,client_name,stage,engagement_outcome,updated_at
    FROM workspaces
    WHERE NOT (firm_id=? AND client_name IN (?,?))
    ORDER BY id`).all(manager.firm_id, ...SCENARIOS.map(scenario => scenario.clientName));
  const hasTenantOnboarding = !!db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='tenant_onboarding'`).get();
  const onboardingBefore = hasTenantOnboarding
    ? db.prepare('SELECT * FROM tenant_onboarding WHERE firm_id=?').get(manager.firm_id) || null
    : null;

  let results;
  try {
    results = db.transaction(() => {
    const existing = db.prepare(`SELECT id,client_name FROM workspaces
      WHERE firm_id=? AND client_name IN (?,?) ORDER BY id`).all(
        manager.firm_id, ...SCENARIOS.map(scenario => scenario.clientName)
      );
    for (const row of existing) {
      assertSeedOwnedCollision(row);
      deleteWorkspace(db, row.id);
    }
    // One controlled import timestamp is shared by records imported in this
    // transaction. Historical service/work dates remain historical, while the
    // database record and approval cannot predate their real actors or parents.
    const importTimestamp = db.prepare("SELECT datetime('now') AS value").get().value;

    const reviewerId = ensureSeedUser({
      email: 'iso27001.test.reviewer@demo.invalid',
      name: 'Independent ISO 27001 Test Reviewer',
      userType: 'firm',
      firmId: manager.firm_id,
      firmRole: 'senior_consultant',
      passwordHash,
    });
    assert.notEqual(reviewerId, manager.id, 'The seed reviewer must be independent of the active manager.');

    const seeded = SCENARIOS.map(scenario => {
      const clientOwnerId = ensureSeedUser({
        email: scenario.email,
        name: scenario.clientOwnerName,
        userType: 'client',
        firmId: manager.firm_id,
        firmRole: null,
        passwordHash,
      });
      const clientEditorId = ensureSeedUser({
        email: scenario.editorEmail,
        name: scenario.editorName,
        userType: 'client',
        firmId: manager.firm_id,
        firmRole: null,
        passwordHash,
      });
      assert.notEqual(clientEditorId, clientOwnerId, 'Document maker and client approver must be distinct users.');
      return seedWorkspace(
        scenario, manager, reviewerId, clientOwnerId, clientEditorId, requirements,
        stagedByScenario[scenario.key], importTimestamp
      );
    });

    if (process.env.NODE_ENV === 'test'
        && process.env.DEMO_SEED_FAIL_DURING_DB_TRANSACTION === '1') {
      throw new Error('Injected ISO 27001 seed database transaction failure.');
    }
    seeded.forEach(assertSeededWorkspace);
    if (onboardingBefore) {
      db.prepare(`UPDATE tenant_onboarding SET started_at=?,completed_at=?,current_step=?,skipped=?
        WHERE firm_id=?`).run(
          onboardingBefore.started_at, onboardingBefore.completed_at,
          onboardingBefore.current_step, onboardingBefore.skipped, manager.firm_id
        );
      assert.deepEqual(db.prepare('SELECT * FROM tenant_onboarding WHERE firm_id=?').get(manager.firm_id),
        onboardingBefore, 'Firm onboarding state changed during exact-name replacement.');
    }
    const preservedAfter = db.prepare(`SELECT id,firm_id,client_name,stage,engagement_outcome,updated_at
      FROM workspaces
      WHERE NOT (firm_id=? AND client_name IN (?,?))
      ORDER BY id`).all(manager.firm_id, ...SCENARIOS.map(scenario => scenario.clientName));
    assert.deepEqual(preservedAfter, preservedBefore, 'A non-seed workspace changed during exact-name replacement.');
    assert.deepEqual(db.pragma('foreign_key_check'), [], 'Foreign-key violations remain after seeding.');
    const integrity = db.pragma('integrity_check');
    assert.deepEqual(integrity, [{ integrity_check: 'ok' }], 'SQLite integrity check failed.');
      return seeded;
    })();
  } catch (error) {
    removeNewlyCreatedEvidence(materialization);
    throw error;
  }

  removeStaleEvidenceAfterCommit(materialization);
  verifyEvidenceFiles(stagedFiles, results, materialization);
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'Foreign-key violations remain after evidence materialization.');
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }], 'Post-seed SQLite integrity check failed.');

  console.log(`\nCreated two synthetic ISO 27001 test clients for ${manager.firm_name}:`);
  for (const result of results) {
    console.log(`  #${result.workspaceId} ${result.scenario.clientName}`);
    console.log(`     outcome=${result.scenario.outcome} stage=${result.scenario.stage} controls=118 evidence=12 documents=${result.documentIds.length}`);
    console.log(`     client_owner=${result.scenario.email}`);
  }
  console.log(`  reviewer=iso27001.test.reviewer@demo.invalid`);
  console.log(`  password=${process.env.DEMO_SEED_PASSWORD ? 'set from DEMO_SEED_PASSWORD' : 'local development default in use'}`);
  console.log(`  evidence=${path.join(UPLOAD_ROOT, `firm_${manager.firm_id}`)} (${SEED_FILE_PREFIX}*)`);
  console.log('Synthetic test data only; do not represent these records as real assurance conclusions.');
}

try {
  main();
} finally {
  if (db && db.open) db.close();
}
