'use strict';

const crypto = require('crypto');
const ENG_PLAN = require('../data/engagement-plan');
const { computeReadiness } = require('./readiness');
const { buildWorkspaceStatus } = require('./grc-truth');

const PHASES = [
  { key: 'mobilisation', name: 'Mobilisation & governance', description: 'Kickoff, scope, stakeholders and delivery governance.', milestones: ['w1-kickoff','w1-intake','w1-stakeholders'] },
  { key: 'context', name: 'Scope & organisational context', description: 'Assets, crown jewels and the operating context in scope.', milestones: ['w2-assets','w2-crown'] },
  { key: 'assessment', name: 'Risk assessment', description: 'Risk methodology and decision-grade assessment of scoped assets.', milestones: ['w3-method','w3-risks'] },
  { key: 'treatment', name: 'Risk treatment & SoA', description: 'Accountable treatment decisions and a defensible Statement of Applicability.', milestones: ['w4-treatment','w4-soa'] },
  { key: 'implementation', name: 'Control & policy implementation', description: 'Leadership, operational policy, awareness and controlled-document adoption.', milestones: ['w5-policies-a','w5-objectives','w6-policies-b','w7-policies-publish','w7-awareness'] },
  { key: 'operating_evidence', name: 'Operational evidence period', description: 'Retain sufficient, current evidence that controls operate over time.', milestones: ['w12-evidence'] },
  { key: 'internal_assurance', name: 'Internal assurance', description: 'Internal audit, management review and accountable follow-up.', milestones: ['w8-programme','w8-first-audit','w9-mrm','w9-actions'] },
  { key: 'cert_readiness', name: 'Certification readiness', description: 'Readiness pack, mock walkthrough and closure of priority issues.', milestones: ['w10-pack','w10-mock','w10-fixes'] },
  { key: 'stage_1', name: 'Stage 1 & remediation', description: 'External Stage 1 audit and closure of resulting nonconformities.', milestones: ['w11-stage1','w11-remediation'] },
  { key: 'stage_2', name: 'Stage 2 & transition', description: 'Final handover and transition into certification operations.', milestones: ['w12-handoff'] },
  { key: 'continuous', name: 'Continuous operation & surveillance', description: 'Recurring ISMS operation, surveillance and continual improvement.', continuous: true, milestones: ['continuous-calendar','continuous-surveillance'] }
];

const EXTRA_MILESTONES = {
  'continuous-calendar': {
    id: 'continuous-calendar', title: 'Activate the recurring ISMS operating calendar',
    deliverables: 'Approved monthly, quarterly and annual operating calendar', clauses: ['9.1','9.2','9.3','10.1'],
    clientTitle: 'Information security operating calendar approved',
    clientDescription: 'Provide this item for review and approval.', frameworkCode: 'iso27001', requirementRefs: '9.1, 9.2, 9.3, 10.1'
  },
  'continuous-surveillance': {
    id: 'continuous-surveillance', title: 'Approve the surveillance and continual-improvement plan',
    deliverables: 'Surveillance plan, ownership model and improvement cadence', clauses: ['10.1','10.2'],
    clientTitle: 'Surveillance and continual-improvement plan approved',
    clientDescription: 'Provide this item for review and approval.', frameworkCode: 'iso27001', requirementRefs: '10.1, 10.2'
  }
};

function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function addDays(dateString, days) {
  if (!dateString) return null;
  const date = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86400000);
}

function event(db, workspaceId, planId, actorId, entityType, entityId, action, fromStatus, toStatus, details) {
  db.prepare(`INSERT INTO engagement_delivery_events
    (workspace_id,plan_id,entity_type,entity_id,action,from_status,to_status,details,actor_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(workspaceId, planId, entityType, entityId || null, action,
      fromStatus || null, toStatus || null, details ? JSON.stringify(details) : null, actorId);
}

function seedTemplate(db, ws, userId, planId) {
  const legacy = Object.fromEntries(ENG_PLAN.flatten().map(m => [m.id, m]));
  const progress = Object.fromEntries(db.prepare(`SELECT milestone_id,completed_at,target_date,notes
    FROM engagement_plan_progress WHERE workspace_id=?`).all(ws.id).map(row => [row.milestone_id, row]));
  const start = String(ws.created_at || new Date().toISOString()).slice(0, 10);
  const target = ws.target_cert_date || null;
  const implementationPhases = PHASES.filter(p => !p.continuous).length;
  const duration = target ? Math.max(daysBetween(start, target), implementationPhases) : null;
  const implementationMilestones = PHASES.filter(p => !p.continuous).reduce((sum, p) => sum + p.milestones.length, 0);
  let implementationMilestoneIndex = 0;
  const insertPhase = db.prepare(`INSERT INTO engagement_delivery_phases
    (plan_id,phase_key,name,description,sort_order,planned_start_date,planned_end_date,forecast_end_date,is_continuous)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertMilestone = db.prepare(`INSERT INTO engagement_delivery_milestones
    (plan_id,phase_id,milestone_key,title,description,acceptance_criteria,status,completion_mode,
     planned_start_date,planned_end_date,forecast_end_date,actual_end_date,completed_at,completion_note,source_rule)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertDeliverable = db.prepare(`INSERT INTO engagement_delivery_deliverables
    (workspace_id,plan_id,milestone_id,title,description,acceptance_criteria,client_title,client_description,
     framework_code,requirement_refs,status,is_required,due_date,accepted_by,accepted_at,decision_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  PHASES.forEach((phase, phaseIndex) => {
    const plannedStart = phase.continuous ? target : duration ? addDays(start, Math.floor(duration * phaseIndex / implementationPhases)) : null;
    const plannedEnd = phase.continuous ? null : duration ? addDays(start, Math.floor(duration * (phaseIndex + 1) / implementationPhases)) : null;
    const phaseId = insertPhase.run(planId, phase.key, phase.name, phase.description, phaseIndex + 1,
      plannedStart, plannedEnd, plannedEnd, phase.continuous ? 1 : 0).lastInsertRowid;
    phase.milestones.forEach((milestoneKey, milestoneIndex) => {
      const source = legacy[milestoneKey] || EXTRA_MILESTONES[milestoneKey];
      const old = progress[milestoneKey];
      const complete = !!old?.completed_at;
      const templateStart = phase.continuous ? target : duration ? addDays(start, Math.floor(duration * implementationMilestoneIndex / implementationMilestones)) : plannedStart;
      const templateEnd = phase.continuous ? null : duration ? addDays(start, Math.floor(duration * (implementationMilestoneIndex + 1) / implementationMilestones)) : plannedEnd;
      const milestoneEnd = old?.target_date || templateEnd;
      const criteria = `Required deliverable accepted by an authorised approver${source.clauses?.length ? `; supports ${source.clauses.join(', ')}` : ''}.`;
      const milestoneId = insertMilestone.run(planId, phaseId, milestoneKey, source.title,
        source.deliverables || null, criteria, complete ? 'complete' : 'not_started',
        ['w1-kickoff','w10-mock','w12-handoff','continuous-calendar','continuous-surveillance'].includes(milestoneKey) ? 'manual' : 'deliverable',
        templateStart, milestoneEnd, milestoneEnd, complete ? old.completed_at.slice(0,10) : null,
        old?.completed_at || null, old?.notes || null, milestoneKey).lastInsertRowid;
      insertDeliverable.run(ws.id, planId, milestoneId, source.deliverables || source.title,
        `Acceptance evidence for “${source.title}”.`, criteria,
        source.clientTitle || source.deliverables || source.title,
        source.clientDescription || 'Provide this item for review and approval.',
        source.frameworkCode || 'iso27001', source.requirementRefs || (source.clauses || []).join(', '),
        complete ? 'accepted' : 'draft', 1,
        milestoneEnd, complete ? userId : null, old?.completed_at || null,
        complete ? 'Migrated from the accepted legacy milestone.' : null);
      if (milestoneIndex > 0) {
        const previousKey = phase.milestones[milestoneIndex - 1];
        const previous = db.prepare(`SELECT id FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key=?`).get(planId, previousKey);
        if (previous) db.prepare(`INSERT OR IGNORE INTO engagement_delivery_dependencies
          (plan_id,predecessor_milestone_id,successor_milestone_id,created_by) VALUES (?,?,?,?)`)
          .run(planId, previous.id, milestoneId, userId);
      }
      if (!phase.continuous) implementationMilestoneIndex += 1;
    });
  });

  // Connect each phase to the next without forcing a duration.
  for (let i = 1; i < PHASES.length; i++) {
    const predecessor = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
      JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE m.plan_id=? AND p.phase_key=? ORDER BY m.id DESC LIMIT 1`)
      .get(planId, PHASES[i - 1].key);
    const successor = db.prepare(`SELECT m.id FROM engagement_delivery_milestones m
      JOIN engagement_delivery_phases p ON p.id=m.phase_id WHERE m.plan_id=? AND p.phase_key=? ORDER BY m.id LIMIT 1`)
      .get(planId, PHASES[i].key);
    if (predecessor && successor) db.prepare(`INSERT OR IGNORE INTO engagement_delivery_dependencies
      (plan_id,predecessor_milestone_id,successor_milestone_id,created_by) VALUES (?,?,?,?)`)
      .run(planId, predecessor.id, successor.id, userId);
  }
}

function ensurePlan(db, ws, userId) {
  let plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id);
  if (plan) return plan;
  const create = db.transaction(() => {
    const planId = db.prepare(`INSERT INTO engagement_delivery_plans
      (workspace_id,name,objective,status,target_start_date,target_completion_date,forecast_completion_date,completion_criteria,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(ws.id, 'ISO 27001 adaptive delivery plan',
        'Reach defensible certification readiness, transition into continuous ISMS operation, and retain client acceptance of every material deliverable.',
        'active', String(ws.created_at || new Date().toISOString()).slice(0,10), ws.target_cert_date || null,
        ws.target_cert_date || null,
        'All required implementation phase gates passed or explicitly waived; readiness hard gates passed; no unresolved critical blockers; transition deliverables accepted; continuous operating cycle activated.',
        userId).lastInsertRowid;
    seedTemplate(db, ws, userId, planId);
    event(db, ws.id, planId, userId, 'plan', planId, 'created', null, 'active', { source: 'adaptive_iso27001_template' });
    return planId;
  })();
  plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE id=?').get(create);
  return plan;
}

function sourceVerification(db, ws, readinessInput = null) {
  const wsId = ws.id;
  const result = {};
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;
  const mark = (key, pass, reason, href) => { if (pass) result[key] = { pass: true, reason, href }; };
  const readiness = readinessInput || computeReadiness(ws);
  const status = buildWorkspaceStatus(db, ws, readiness);
  const gate = key => readiness.stage1Gate.find(item => item.key === key);

  const parties = count(`SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=? AND length(trim(COALESCE(party,'')))>0 AND length(trim(COALESCE(needs,'')))>0`, wsId);
  mark('w1-stakeholders', parties >= 3, `${parties} interested parties have documented needs`, `/workspaces/${wsId}/intake`);
  const assets = count(`SELECT COUNT(*) c FROM assets WHERE workspace_id=? AND length(trim(COALESCE(owner_name,'')))>0`, wsId);
  mark('w2-assets', assets >= 30, `${assets} owned assets are registered`, `/workspaces/${wsId}/assets`);
  const crown = count(`SELECT COUNT(*) c FROM assets WHERE workspace_id=? AND lower(COALESCE(business_criticality,''))='critical'`, wsId);
  mark('w2-crown', crown >= 3, `${crown} crown-jewel assets are classified critical`, `/workspaces/${wsId}/assets`);
  const methodDocs = count(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') AND lower(name) LIKE '%risk%' AND (lower(name) LIKE '%method%' OR lower(name) LIKE '%criteria%')`, wsId);
  mark('w3-method', methodDocs > 0 || !!gate('risk_method')?.pass, 'Risk-methodology hard gate passes', `/workspaces/${wsId}/risk-methodology`);
  const risks = count(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND asset_id IS NOT NULL AND length(trim(COALESCE(owner_name,'')))>0`, wsId);
  mark('w3-risks', risks >= 30, `${risks} owned, asset-linked risks are scored`, `/workspaces/${wsId}/risks`);
  const treated = count(`SELECT COUNT(DISTINCT r.id) c FROM risks r WHERE r.workspace_id=? AND (r.status IN ('closed','accepted') OR EXISTS (SELECT 1 FROM risk_treatment_actions a WHERE a.risk_id=r.id AND a.owner_name IS NOT NULL AND a.due_date IS NOT NULL))`, wsId);
  mark('w4-treatment', risks >= 10 && treated >= risks, `${treated} risks have accountable treatment records`, `/workspaces/${wsId}/risks`);
  mark('w4-soa', !!gate('soa')?.pass, gate('soa')?.detail || 'SoA gate passes', `/workspaces/${wsId}/soa`);
  const leadershipDocs = count(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') AND (lower(name) LIKE '%information security policy%' OR lower(name) LIKE '%scope%' OR lower(name) LIKE '%objective%')`, wsId);
  mark('w5-policies-a', leadershipDocs >= 3, `${leadershipDocs} approved leadership documents are retained`, `/workspaces/${wsId}/documents`);
  const objectives = count(`SELECT COUNT(*) c FROM security_objectives WHERE workspace_id=? AND length(trim(COALESCE(owner,'')))>0 AND length(trim(COALESCE(measurement,'')))>0 AND length(trim(COALESCE(target_value,'')))>0`, wsId);
  mark('w5-objectives', objectives >= 3, `${objectives} measurable objectives have owners and targets`, `/workspaces/${wsId}/objectives`);
  const opsDocs = count(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('in_review','approved','published') AND (lower(name) LIKE '%access control%' OR lower(name) LIKE '%supplier%' OR lower(name) LIKE '%incident response%')`, wsId);
  mark('w6-policies-b', opsDocs >= 3, `${opsDocs} operational policy families are retained`, `/workspaces/${wsId}/documents`);
  mark('w7-policies-publish', !!gate('mandatory_docs')?.pass, gate('mandatory_docs')?.detail || 'Mandatory document gate passes', `/workspaces/${wsId}/documents`);
  const training = count(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=? AND (completed_date IS NOT NULL OR lower(status) IN ('completed','passed'))`, wsId);
  const comms = count(`SELECT COUNT(*) c FROM communication_plan WHERE workspace_id=? AND last_sent_date IS NOT NULL`, wsId);
  mark('w7-awareness', training >= 3 && comms > 0, `${training} training records and ${comms} sent communications retained`, `/workspaces/${wsId}/training`);
  const programmes = count(`SELECT COUNT(*) c FROM audit_programmes WHERE workspace_id=? AND approved_at IS NOT NULL`, wsId);
  mark('w8-programme', programmes > 0, `${programmes} approved audit programme${programmes === 1 ? '' : 's'} retained`, `/workspaces/${wsId}/audit-programme`);
  mark('w8-first-audit', ['internal_audit','stage_1_ready','post_stage_1','post_stage_2','surveillance'].includes(status.lifecycle.key), status.lifecycle.label, `/workspaces/${wsId}/audits`);
  const reviews = count(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND lower(status) IN ('completed','done')`, wsId);
  mark('w9-mrm', reviews > 0, `${reviews} completed management review${reviews === 1 ? '' : 's'} retained`, `/workspaces/${wsId}/mrms`);
  mark('w11-stage1', ['post_stage_1','post_stage_2','surveillance'].includes(status.lifecycle.key), status.lifecycle.label, `/workspaces/${wsId}/cert-cycle`);
  const recurring = count(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND recurrence IS NOT NULL`, wsId);
  mark('continuous-calendar', recurring >= 3, `${recurring} recurring ISMS tasks are active`, `/workspaces/${wsId}/calendar`);
  const surveillance = count(`SELECT COUNT(*) c FROM cert_cycle_events WHERE workspace_id=? AND event_type IN ('surveillance_1','surveillance_2','recertification')`, wsId);
  mark('continuous-surveillance', surveillance > 0, `${surveillance} surveillance or recertification event${surveillance === 1 ? '' : 's'} planned`, `/workspaces/${wsId}/cert-cycle`);
  return result;
}

function getProjection(db, ws, userId, { ensure = true } = {}) {
  const plan = ensure ? ensurePlan(db, ws, userId) : db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id);
  if (!plan) return null;
  const readiness = computeReadiness(ws);
  const verification = sourceVerification(db, ws, readiness);
  const phases = db.prepare('SELECT * FROM engagement_delivery_phases WHERE plan_id=? ORDER BY sort_order,id').all(plan.id);
  const milestones = db.prepare(`SELECT m.*,u.name owner_name FROM engagement_delivery_milestones m LEFT JOIN users u ON u.id=m.owner_id WHERE m.plan_id=? ORDER BY m.phase_id,m.planned_end_date IS NULL,m.planned_end_date,m.id`).all(plan.id);
  const deliverables = db.prepare(`SELECT d.*,o.name owner_name,a.name approver_name,
    (SELECT COUNT(*) FROM engagement_delivery_evidence de WHERE de.deliverable_id=d.id) evidence_count,
    (SELECT COUNT(*) FROM comments c WHERE c.workspace_id=d.workspace_id AND c.parent_type='engagement_deliverable' AND c.parent_id=CAST(d.id AS TEXT)) comment_count
    FROM engagement_delivery_deliverables d LEFT JOIN users o ON o.id=d.owner_id LEFT JOIN users a ON a.id=d.approver_id WHERE d.plan_id=? ORDER BY d.id`).all(plan.id);
  const dependencies = db.prepare(`SELECT d.*,pre.title predecessor_title,post.title successor_title FROM engagement_delivery_dependencies d JOIN engagement_delivery_milestones pre ON pre.id=d.predecessor_milestone_id JOIN engagement_delivery_milestones post ON post.id=d.successor_milestone_id WHERE d.plan_id=? ORDER BY d.id`).all(plan.id);
  const tasks = db.prepare(`SELECT id,title,status,due_date,assignee_id,engagement_milestone_id,engagement_deliverable_id FROM tasks WHERE workspace_id=? AND (engagement_milestone_id IS NOT NULL OR engagement_deliverable_id IS NOT NULL)`).all(ws.id);
  const latestGate = Object.fromEntries(phases.map(phase => {
    const decision = db.prepare(`SELECT * FROM engagement_delivery_gate_decisions WHERE phase_id=? ORDER BY id DESC LIMIT 1`).get(phase.id) || null;
    if (decision?.decision === 'waived' && decision.waiver_expires_at && decision.waiver_expires_at < new Date().toISOString().slice(0, 10)) {
      decision.expired = true;
      decision.decision = 'expired';
    }
    return [phase.id, decision];
  }));
  const predecessorMap = {};
  dependencies.forEach(dep => { (predecessorMap[dep.successor_milestone_id] ||= []).push(dep); });

  const milestoneById = {};
  milestones.forEach(milestone => { milestoneById[milestone.id] = milestone; });
  const isTerminal = status => ['complete','waived'].includes(status);
  // First pass: accepted deliverables and workspace verification.
  milestones.forEach(milestone => {
    milestone.deliverables = deliverables.filter(d => d.milestone_id === milestone.id).map(deliverable => ({
      ...deliverable,
      effective_status: deliverable.status === 'draft' && verification[milestone.milestone_key] ? 'workspace_verified' : deliverable.status
    }));
    milestone.tasks = tasks.filter(task => task.engagement_milestone_id === milestone.id || milestone.deliverables.some(d => d.id === task.engagement_deliverable_id));
    milestone.verification = verification[milestone.milestone_key] || null;
    const required = milestone.deliverables.filter(d => d.is_required && d.status !== 'superseded');
    const accepted = required.length > 0 && required.every(d => d.status === 'accepted');
    milestone.effective_status = isTerminal(milestone.status) || milestone.status === 'blocked'
      ? milestone.status
      : accepted ? 'complete'
        : milestone.verification ? 'workspace_verified'
          : milestone.deliverables.some(d => ['submitted','changes_requested'].includes(d.status)) || milestone.tasks.some(t => t.status === 'in_progress')
            ? 'in_progress' : milestone.status;
  });
  // Second pass: mandatory dependency blocking.
  milestones.forEach(milestone => {
    const blockers = (predecessorMap[milestone.id] || []).filter(dep => dep.is_mandatory && !isTerminal(milestoneById[dep.predecessor_milestone_id]?.effective_status));
    milestone.blockers = blockers;
    // A normal dependency is a sequencing condition, not an exception. Keep
    // it as "waiting"; reserve "blocked" for an explicitly raised impediment.
    // Accepted work can exist early, but still cannot satisfy the gate until
    // mandatory predecessors finish.
    if (blockers.length && milestone.effective_status !== 'waived') milestone.effective_status = 'waiting';
    milestone.task_done = milestone.tasks.filter(task => task.status === 'done').length;
    milestone.task_total = milestone.tasks.length;
  });

  // Identify the longest dependency path so the timeline can expose the work
  // that actually governs the forecast. Dependencies are cycle-checked when
  // they are created, but Kahn's algorithm also fails safely if legacy data is
  // malformed.
  const criticalIds = new Set();
  if (dependencies.length) {
    const outgoing = {};
    const incomingCount = Object.fromEntries(milestones.map(m => [m.id, 0]));
    const distance = {};
    const previous = {};
    const duration = milestone => Math.max(1, (daysBetween(milestone.planned_start_date, milestone.forecast_end_date || milestone.planned_end_date) || 0) + 1);
    milestones.forEach(m => { distance[m.id] = duration(m); });
    dependencies.forEach(dep => {
      (outgoing[dep.predecessor_milestone_id] ||= []).push(dep);
      incomingCount[dep.successor_milestone_id] = (incomingCount[dep.successor_milestone_id] || 0) + 1;
    });
    const queue = milestones.filter(m => incomingCount[m.id] === 0).map(m => m.id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift();
      visited += 1;
      for (const dep of outgoing[id] || []) {
        const successor = milestoneById[dep.successor_milestone_id];
        const candidate = distance[id] + (Number(dep.lag_days) || 0) + duration(successor);
        if (candidate > distance[successor.id]) {
          distance[successor.id] = candidate;
          previous[successor.id] = id;
        }
        incomingCount[successor.id] -= 1;
        if (incomingCount[successor.id] === 0) queue.push(successor.id);
      }
    }
    if (visited === milestones.length) {
      let cursor = milestones.reduce((best, m) => distance[m.id] > distance[best.id] ? m : best, milestones[0])?.id;
      while (cursor) { criticalIds.add(cursor); cursor = previous[cursor]; }
    }
  }
  milestones.forEach(m => { m.critical_path = criticalIds.has(m.id); });

  let precedingGateComplete = true;
  phases.forEach(phase => {
    phase.milestones = milestones.filter(m => m.phase_id === phase.id);
    const required = phase.milestones.filter(m => m.is_required);
    phase.criteria = required.map(m => ({ id: m.id, label: m.title, status: m.effective_status, pass: isTerminal(m.effective_status) }));
    phase.gate_ready = required.length > 0 && phase.criteria.every(c => c.pass);
    phase.gate_decision = latestGate[phase.id];
    const gateStatus = latestGate[phase.id]?.decision === 'waived' ? 'waived'
      : latestGate[phase.id]?.decision === 'passed' ? 'complete' : null;
    const hasActivity = phase.milestones.some(m => m.verification || ['in_progress','workspace_verified','complete','waived'].includes(m.effective_status));
    phase.effective_status = gateStatus
      || (!precedingGateComplete ? 'not_started'
        : phase.milestones.some(m => m.status === 'blocked') ? 'blocked'
          : hasActivity ? 'in_progress' : 'not_started');
    phase.complete_count = phase.milestones.filter(m => isTerminal(m.effective_status)).length;
    phase.verified_count = phase.milestones.filter(m => m.verification && !isTerminal(m.effective_status)).length;
    phase.progress_pct = phase.milestones.length ? Math.round((phase.complete_count + phase.verified_count * 0.5) / phase.milestones.length * 100) : 0;
    precedingGateComplete = ['complete','waived'].includes(phase.effective_status);
  });

  const currentPhase = phases.find(p => !['complete','waived'].includes(p.effective_status)) || phases[phases.length - 1] || null;
  const requiredMilestones = milestones.filter(m => m.is_required && !phases.find(p => p.id === m.phase_id)?.is_continuous);
  const completeMilestones = milestones.filter(m => isTerminal(m.effective_status)).length;
  const verifiedMilestones = milestones.filter(m => m.verification && !isTerminal(m.effective_status)).length;
  const acceptedDeliverables = deliverables.filter(d => d.status === 'accepted').length;
  const requiredDeliverables = deliverables.filter(d => d.is_required && d.status !== 'superseded').length;
  const openBlockers = milestones.filter(m => m.status === 'blocked').length;
  const nonContinuous = phases.filter(p => !p.is_continuous);
  const completionReady = phases.every(p => ['complete','waived'].includes(p.effective_status))
    && !!readiness.stage2Ready && openBlockers === 0;
  const dates = milestones.map(m => m.forecast_end_date || m.planned_end_date).filter(Boolean).sort();
  const forecast = [plan.forecast_completion_date, dates[dates.length - 1], plan.target_completion_date].filter(Boolean).sort().pop() || null;
  const varianceDays = daysBetween(plan.target_completion_date, forecast);
  const baselineRow = db.prepare(`SELECT id,version_number,label,reason,approved_at,snapshot_json FROM engagement_delivery_baselines WHERE plan_id=? ORDER BY version_number DESC LIMIT 1`).get(plan.id) || null;
  let baseline = baselineRow;
  if (baselineRow) {
    try {
      const snapshot = JSON.parse(baselineRow.snapshot_json);
      const byId = Object.fromEntries((snapshot.milestones || []).map(m => [m.id, m]));
      milestones.forEach(m => {
        const original = byId[m.id];
        m.baseline_end_date = original?.forecast || original?.end || null;
        m.baseline_variance_days = daysBetween(m.baseline_end_date, m.forecast_end_date || m.planned_end_date);
      });
    } catch (_) { /* A corrupt historical snapshot must not break the plan. */ }
    const { snapshot_json, ...safeBaseline } = baselineRow;
    baseline = safeBaseline;
  }

  return {
    plan: { ...plan, forecast_completion_date: forecast }, phases, milestones, deliverables, dependencies,
    currentPhase, baseline,
    summary: {
      totalMilestones: milestones.length, completeMilestones, verifiedMilestones,
      acceptedDeliverables, requiredDeliverables, openBlockers,
      progressPct: milestones.length ? Math.round((completeMilestones + verifiedMilestones * 0.5) / milestones.length * 100) : 0,
      varianceDays, completionReady,
      readinessReady: !!readiness.stage2Ready,
      phaseGatesPassed: phases.filter(p => ['complete','waived'].includes(p.effective_status)).length,
      phaseGatesTotal: phases.length
    }
  };
}

function createBaseline(db, ws, userId, label, reason) {
  if (!reason || !String(reason).trim()) throw new Error('A baseline reason is required.');
  const projection = getProjection(db, ws, userId);
  const snapshot = {
    plan: projection.plan,
    phases: projection.phases.map(p => ({ id:p.id,key:p.phase_key,name:p.name,start:p.planned_start_date,end:p.planned_end_date,forecast:p.forecast_end_date })),
    milestones: projection.milestones.map(m => ({ id:m.id,key:m.milestone_key,title:m.title,status:m.effective_status,start:m.planned_start_date,end:m.planned_end_date,forecast:m.forecast_end_date,required:!!m.is_required })),
    deliverables: projection.deliverables.map(d => ({ id:d.id,milestone_id:d.milestone_id,title:d.title,status:d.status,due:d.due_date,required:!!d.is_required }))
  };
  const json = JSON.stringify(snapshot);
  const next = projection.plan.baseline_version + 1;
  const tx = db.transaction(() => {
    const id = db.prepare(`INSERT INTO engagement_delivery_baselines
      (plan_id,version_number,label,reason,snapshot_json,snapshot_hash,approved_by) VALUES (?,?,?,?,?,?,?)`)
      .run(projection.plan.id, next, label || `Baseline ${next}`, String(reason).trim(), json, hash(json), userId).lastInsertRowid;
    db.prepare(`UPDATE engagement_delivery_plans SET baseline_version=?,updated_at=datetime('now') WHERE id=?`).run(next, projection.plan.id);
    event(db, ws.id, projection.plan.id, userId, 'baseline', id, 'approved', null, 'approved', { version: next, reason: String(reason).trim() });
    return id;
  });
  return tx();
}

function deliverableEvidenceSnapshot(db, ws, row) {
  const evidence = db.prepare(`SELECT e.id,e.filename,e.sha256,e.uploaded_at,de.linked_at
    FROM engagement_delivery_evidence de JOIN evidence e ON e.id=de.evidence_id
    WHERE de.deliverable_id=? AND de.workspace_id=? AND e.workspace_id=? ORDER BY de.id`).all(row.id, ws.id, ws.id);
  const verification = sourceVerification(db, ws)[row.source_rule] || null;
  return { evidence, workspace_verification: verification, captured_at: new Date().toISOString() };
}

function transitionDeliverable(db, ws, userId, deliverableId, action, note) {
  const row = db.prepare(`SELECT d.*,m.plan_id,m.source_rule FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id WHERE d.id=? AND d.workspace_id=?`).get(deliverableId, ws.id);
  if (!row) throw new Error('Deliverable not found.');
  const transitions = {
    submit: { from: ['draft','workspace_verified','changes_requested'], to: 'submitted' },
    accept: { from: ['submitted','workspace_verified'], to: 'accepted' },
    changes: { from: ['submitted','accepted'], to: 'changes_requested' },
    reject: { from: ['submitted'], to: 'rejected' }
  };
  const transition = transitions[action];
  const verified = row.status === 'draft' && !!sourceVerification(db, ws)[row.source_rule];
  const current = verified ? 'workspace_verified' : row.status;
  if (!transition || !transition.from.includes(current)) throw new Error(`Cannot ${action} a deliverable in ${row.status} status.`);
  if (['changes','reject'].includes(action) && !String(note || '').trim()) throw new Error('A decision note is required.');
  let evidenceSnapshot = null;
  if (action === 'submit' && row.requires_evidence) {
    evidenceSnapshot = deliverableEvidenceSnapshot(db, ws, row);
    if (!evidenceSnapshot.evidence.length && !evidenceSnapshot.workspace_verification) {
      throw new Error('Link evidence or a verified workspace record before submitting this deliverable.');
    }
  }
  if (action === 'accept') {
    if (!row.approver_id) throw new Error('Assign an approver before accepting this deliverable.');
    if (Number(row.approver_id) !== Number(userId)) throw new Error('Only the assigned approver can accept this deliverable.');
    evidenceSnapshot = deliverableEvidenceSnapshot(db, ws, row);
    if (row.requires_evidence && !evidenceSnapshot.evidence.length && !evidenceSnapshot.workspace_verification) {
      throw new Error('Link evidence or a verified workspace record before accepting this deliverable.');
    }
  }
  const sets = ['status=?','decision_note=?','reviewed_by=?','reviewed_at=datetime(\'now\')','updated_at=datetime(\'now\')','row_version=row_version+1'];
  const values = [transition.to, note || null, userId];
  if (action === 'submit') { sets.push('submitted_by=?','submitted_at=datetime(\'now\')'); values.push(userId); }
  if (action === 'accept') { sets.push('accepted_by=?','accepted_at=datetime(\'now\')','evidence_snapshot_json=?'); values.push(userId, JSON.stringify(evidenceSnapshot)); }
  db.prepare(`UPDATE engagement_delivery_deliverables SET ${sets.join(',')} WHERE id=? AND workspace_id=?`).run(...values, row.id, ws.id);
  const required = db.prepare(`SELECT status FROM engagement_delivery_deliverables WHERE milestone_id=? AND is_required=1 AND status<>'superseded'`).all(row.milestone_id);
  const allAccepted = required.length > 0 && required.every(d => d.status === 'accepted');
  db.prepare(`UPDATE engagement_delivery_milestones SET status=?,completed_by=?,completed_at=?,actual_end_date=?,updated_at=datetime('now'),row_version=row_version+1 WHERE id=?`)
    .run(allAccepted ? 'complete' : transition.to === 'changes_requested' ? 'in_progress' : 'in_progress',
      allAccepted ? userId : null, allAccepted ? new Date().toISOString() : null,
      allAccepted ? new Date().toISOString().slice(0,10) : null, row.milestone_id);
  event(db, ws.id, row.plan_id, userId, 'deliverable', row.id, action, row.status, transition.to,
    { note: note || null, evidence_count: evidenceSnapshot?.evidence.length || 0, workspace_verified: !!evidenceSnapshot?.workspace_verification });
  return transition.to;
}

function reviseDeliverable(db, ws, userId, deliverableId, note) {
  const row = db.prepare(`SELECT d.*,m.plan_id FROM engagement_delivery_deliverables d JOIN engagement_delivery_milestones m ON m.id=d.milestone_id WHERE d.id=? AND d.workspace_id=?`).get(deliverableId, ws.id);
  if (!row || !['rejected','changes_requested'].includes(row.status)) throw new Error('Only rejected or changes-requested deliverables can be revised.');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE engagement_delivery_deliverables SET status='superseded',decision_note=?,updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND workspace_id=?`)
      .run(note || 'Superseded by a new revision', row.id, ws.id);
    const nextId = db.prepare(`INSERT INTO engagement_delivery_deliverables
      (workspace_id,plan_id,milestone_id,title,description,acceptance_criteria,client_title,client_description,framework_code,requirement_refs,
       status,is_required,owner_id,approver_id,due_date,linked_record_type,linked_record_id,client_visible,requires_evidence,
       revision_number,supersedes_deliverable_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`).run(row.workspace_id,row.plan_id,row.milestone_id,row.title,row.description,
        row.acceptance_criteria,row.client_title,row.client_description,row.framework_code,row.requirement_refs,
        row.is_required,row.owner_id,row.approver_id,row.due_date,row.linked_record_type,row.linked_record_id,
        row.client_visible,row.requires_evidence,row.revision_number + 1,row.id).lastInsertRowid;
    db.prepare(`UPDATE engagement_delivery_milestones SET status='in_progress',completed_by=NULL,completed_at=NULL,actual_end_date=NULL,updated_at=datetime('now'),row_version=row_version+1 WHERE id=?`).run(row.milestone_id);
    event(db, ws.id, row.plan_id, userId, 'deliverable', row.id, 'superseded', row.status, 'superseded', { note: note || null, replacementId: nextId });
    event(db, ws.id, row.plan_id, userId, 'deliverable', nextId, 'revision_created', null, 'draft', { supersedes: row.id, revision: row.revision_number + 1 });
    return nextId;
  });
  return tx();
}

function decideGate(db, ws, userId, phaseId, decision, note, waiverExpiresAt) {
  const projection = getProjection(db, ws, userId);
  const phase = projection.phases.find(p => p.id === Number(phaseId));
  if (!phase) throw new Error('Phase not found.');
  const phaseIndex = projection.phases.findIndex(p => p.id === phase.id);
  if (decision !== 'reopened' && projection.phases.slice(0, phaseIndex).some(p => !['complete','waived'].includes(p.effective_status))) {
    throw new Error('Earlier phase gates must be passed or formally waived before this gate can be decided.');
  }
  if (decision === 'passed' && !phase.gate_ready) throw new Error('This phase gate cannot pass until every required milestone and deliverable is accepted.');
  if (decision === 'waived' && (!String(note || '').trim() || !waiverExpiresAt)) throw new Error('A waiver requires a reason and expiry date.');
  if (!['passed','waived','reopened'].includes(decision)) throw new Error('Invalid gate decision.');
  const criteria = JSON.stringify(phase.criteria);
  const evidenceSnapshot = JSON.stringify({
    captured_at: new Date().toISOString(),
    milestones: phase.milestones.map(m => ({ id: m.id, title: m.title, status: m.effective_status,
      deliverables: m.deliverables.map(d => ({ id: d.id, title: d.title, status: d.status, evidence_count: d.evidence_count || 0, evidence_snapshot_json: d.evidence_snapshot_json || null })) }))
  });
  const tx = db.transaction(() => {
    const id = db.prepare(`INSERT INTO engagement_delivery_gate_decisions
      (phase_id,decision,criteria_snapshot,snapshot_hash,note,waiver_expires_at,decided_by,evidence_snapshot_json) VALUES (?,?,?,?,?,?,?,?)`)
      .run(phase.id, decision, criteria, hash(criteria + evidenceSnapshot), note || null, waiverExpiresAt || null, userId, evidenceSnapshot).lastInsertRowid;
    const phaseStatus = decision === 'passed' ? 'complete' : decision === 'waived' ? 'waived' : 'in_progress';
    db.prepare(`UPDATE engagement_delivery_phases SET status=?,actual_end_date=?,updated_at=datetime('now') WHERE id=? AND plan_id=?`)
      .run(phaseStatus, ['passed','waived'].includes(decision) ? new Date().toISOString().slice(0,10) : null, phase.id, projection.plan.id);
    event(db, ws.id, projection.plan.id, userId, 'phase_gate', phase.id, decision, phase.effective_status, phaseStatus, { note, waiverExpiresAt });
    return id;
  });
  return tx();
}

function addDependency(db, ws, userId, predecessorId, successorId, type, lagDays) {
  const plan = ensurePlan(db, ws, userId);
  const rows = db.prepare(`SELECT id FROM engagement_delivery_milestones WHERE plan_id=? AND id IN (?,?)`).all(plan.id, predecessorId, successorId);
  if (rows.length !== 2 || Number(predecessorId) === Number(successorId)) throw new Error('Choose two different milestones from this plan.');
  const edges = db.prepare(`SELECT predecessor_milestone_id pre,successor_milestone_id post FROM engagement_delivery_dependencies WHERE plan_id=?`).all(plan.id);
  const graph = {};
  edges.forEach(edge => { (graph[edge.pre] ||= []).push(edge.post); });
  (graph[Number(predecessorId)] ||= []).push(Number(successorId));
  const visit = (node, target, seen = new Set()) => {
    if (node === target) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    return (graph[node] || []).some(next => visit(next, target, seen));
  };
  if (visit(Number(successorId), Number(predecessorId))) throw new Error('That dependency would create a cycle.');
  const id = db.prepare(`INSERT INTO engagement_delivery_dependencies
    (plan_id,predecessor_milestone_id,successor_milestone_id,dependency_type,lag_days,created_by)
    VALUES (?,?,?,?,?,?)`).run(plan.id, predecessorId, successorId, type || 'finish_to_start', Number(lagDays) || 0, userId).lastInsertRowid;
  event(db, ws.id, plan.id, userId, 'dependency', id, 'created', null, 'active', { predecessorId, successorId, type, lagDays });
  return id;
}

function recalculateSchedule(db, ws, userId, triggerType = 'manual') {
  const plan = ensurePlan(db, ws, userId);
  const milestones = db.prepare(`SELECT * FROM engagement_delivery_milestones WHERE plan_id=? ORDER BY id`).all(plan.id);
  const dependencies = db.prepare(`SELECT * FROM engagement_delivery_dependencies WHERE plan_id=? ORDER BY id`).all(plan.id);
  const byId = Object.fromEntries(milestones.map(m => [m.id, m]));
  const outgoing = {};
  const indegree = Object.fromEntries(milestones.map(m => [m.id, 0]));
  dependencies.forEach(dep => {
    (outgoing[dep.predecessor_milestone_id] ||= []).push(dep);
    indegree[dep.successor_milestone_id] = (indegree[dep.successor_milestone_id] || 0) + 1;
  });
  const queue = milestones.filter(m => indegree[m.id] === 0).map(m => m.id);
  let changed = 0;
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    const predecessor = byId[id];
    for (const dep of outgoing[id] || []) {
      const successor = byId[dep.successor_milestone_id];
      const oldStart = successor.planned_start_date;
      const oldEnd = successor.planned_end_date;
      const oldForecast = successor.forecast_end_date || oldEnd;
      const duration = Math.max(0, daysBetween(oldStart, oldEnd) || 0);
      const lag = Number(dep.lag_days) || 0;
      let newStart = oldStart;
      let newEnd = oldEnd;
      let newForecast = oldForecast;
      if (dep.dependency_type === 'start_to_start' && predecessor.planned_start_date) {
        const floor = addDays(predecessor.planned_start_date, lag);
        if (!newStart || newStart < floor) { newStart = floor; newEnd = addDays(newStart, duration); newForecast = addDays(newStart, Math.max(duration, daysBetween(oldStart, oldForecast) || duration)); }
      } else if (dep.dependency_type === 'finish_to_finish' && (predecessor.forecast_end_date || predecessor.planned_end_date)) {
        const floor = addDays(predecessor.forecast_end_date || predecessor.planned_end_date, lag);
        if (!newForecast || newForecast < floor) { newForecast = floor; newEnd = !newEnd || newEnd < floor ? floor : newEnd; newStart = newStart || addDays(newEnd, -duration); }
      } else if (predecessor.forecast_end_date || predecessor.planned_end_date) {
        const floor = addDays(predecessor.forecast_end_date || predecessor.planned_end_date, lag);
        if (!newStart || newStart < floor) { newStart = floor; newEnd = addDays(newStart, duration); newForecast = addDays(newStart, Math.max(duration, daysBetween(oldStart, oldForecast) || duration)); }
      }
      if (newStart !== oldStart || newEnd !== oldEnd || newForecast !== oldForecast) {
        db.prepare(`UPDATE engagement_delivery_milestones SET planned_start_date=?,planned_end_date=?,forecast_end_date=?,updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND plan_id=?`)
          .run(newStart, newEnd, newForecast, successor.id, plan.id);
        Object.assign(successor, { planned_start_date: newStart, planned_end_date: newEnd, forecast_end_date: newForecast });
        changed += 1;
      }
      indegree[successor.id] -= 1;
      if (indegree[successor.id] === 0) queue.push(successor.id);
    }
  }
  if (visited !== milestones.length) throw new Error('Schedule cannot be recalculated because the dependency graph contains a cycle.');
  const phases = db.prepare(`SELECT id FROM engagement_delivery_phases WHERE plan_id=?`).all(plan.id);
  phases.forEach(phase => db.prepare(`UPDATE engagement_delivery_phases SET
    planned_start_date=(SELECT MIN(planned_start_date) FROM engagement_delivery_milestones WHERE phase_id=?),
    planned_end_date=(SELECT MAX(planned_end_date) FROM engagement_delivery_milestones WHERE phase_id=?),
    forecast_end_date=(SELECT MAX(COALESCE(forecast_end_date,planned_end_date)) FROM engagement_delivery_milestones WHERE phase_id=?),
    updated_at=datetime('now') WHERE id=?`).run(phase.id, phase.id, phase.id, phase.id));
  db.prepare(`UPDATE engagement_delivery_deliverables SET due_date=(SELECT COALESCE(m.forecast_end_date,m.planned_end_date) FROM engagement_delivery_milestones m WHERE m.id=engagement_delivery_deliverables.milestone_id),updated_at=datetime('now')
    WHERE plan_id=? AND status NOT IN ('accepted','superseded')`).run(plan.id);
  db.prepare(`UPDATE tasks SET due_date=(SELECT COALESCE(m.forecast_end_date,m.planned_end_date) FROM engagement_delivery_milestones m WHERE m.id=tasks.engagement_milestone_id)
    WHERE workspace_id=? AND engagement_milestone_id IN (SELECT id FROM engagement_delivery_milestones WHERE plan_id=?) AND status NOT IN ('done','closed','cancelled')`).run(ws.id, plan.id);
  const forecastAfter = db.prepare(`SELECT MAX(COALESCE(m.forecast_end_date,m.planned_end_date)) value FROM engagement_delivery_milestones m JOIN engagement_delivery_phases ph ON ph.id=m.phase_id WHERE m.plan_id=? AND ph.is_continuous=0`).get(plan.id).value;
  db.prepare(`UPDATE engagement_delivery_plans SET forecast_completion_date=?,updated_at=datetime('now') WHERE id=?`).run(forecastAfter, plan.id);
  const runId = db.prepare(`INSERT INTO engagement_delivery_schedule_runs (plan_id,trigger_type,changed_milestones,forecast_before,forecast_after,details_json,run_by) VALUES (?,?,?,?,?,?,?)`)
    .run(plan.id, triggerType, changed, plan.forecast_completion_date, forecastAfter, JSON.stringify({ dependency_count: dependencies.length }), userId).lastInsertRowid;
  event(db, ws.id, plan.id, userId, 'schedule', runId, 'recalculated', plan.forecast_completion_date, forecastAfter, { changed });
  return { changed, forecastBefore: plan.forecast_completion_date, forecastAfter };
}

function fitScheduleToTarget(db, ws, userId) {
  const plan = ensurePlan(db, ws, userId);
  if (!plan.target_start_date || !plan.target_completion_date) throw new Error('Set both the target start and target completion dates first.');
  const milestones = db.prepare(`SELECT m.*,ph.is_continuous FROM engagement_delivery_milestones m JOIN engagement_delivery_phases ph ON ph.id=m.phase_id WHERE m.plan_id=? ORDER BY ph.sort_order,m.id`).all(plan.id);
  const dependencies = db.prepare(`SELECT * FROM engagement_delivery_dependencies WHERE plan_id=?`).all(plan.id);
  const active = milestones.filter(m => !m.is_continuous);
  const activeIds = new Set(active.map(m => m.id));
  const outgoing = {};
  const indegree = Object.fromEntries(active.map(m => [m.id, 0]));
  dependencies.filter(d => activeIds.has(d.predecessor_milestone_id) && activeIds.has(d.successor_milestone_id)).forEach(dep => {
    (outgoing[dep.predecessor_milestone_id] ||= []).push(dep.successor_milestone_id);
    indegree[dep.successor_milestone_id] += 1;
  });
  const queue = active.filter(m => indegree[m.id] === 0).map(m => m.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift(); order.push(id);
    for (const next of outgoing[id] || []) { indegree[next] -= 1; if (indegree[next] === 0) queue.push(next); }
  }
  if (order.length !== active.length) throw new Error('The plan contains a dependency cycle.');
  const span = Math.max(active.length, daysBetween(plan.target_start_date, plan.target_completion_date));
  const update = db.prepare(`UPDATE engagement_delivery_milestones SET planned_start_date=?,planned_end_date=?,forecast_end_date=?,updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND plan_id=?`);
  db.transaction(() => {
    order.forEach((id, index) => {
      const start = addDays(plan.target_start_date, Math.floor(span * index / order.length));
      const end = addDays(plan.target_start_date, Math.floor(span * (index + 1) / order.length));
      update.run(start, end, end, id, plan.id);
    });
    milestones.filter(m => m.is_continuous).forEach(m => update.run(plan.target_completion_date, null, null, m.id, plan.id));
  })();
  const result = recalculateSchedule(db, ws, userId, 'fit_to_target');
  event(db, ws.id, plan.id, userId, 'schedule', null, 'fit_to_target', plan.forecast_completion_date, result.forecastAfter, { milestones: active.length });
  return result;
}

module.exports = {
  PHASES, ensurePlan, getProjection, createBaseline, transitionDeliverable, reviseDeliverable,
  decideGate, addDependency, recalculateSchedule, fitScheduleToTarget, deliverableEvidenceSnapshot, event, daysBetween
};
