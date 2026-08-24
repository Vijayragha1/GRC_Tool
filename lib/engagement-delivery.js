'use strict';

const crypto = require('crypto');
const ENG_PLAN = require('../data/engagement-plan');
const { computeReadiness } = require('./readiness');
const { buildWorkspaceStatus } = require('./grc-truth');
const isoLifecycle = require('./iso-lifecycle');
const gapFieldwork = require('./gap-fieldwork');

const LEGACY_COMPLETION_CRITERIA = 'All required implementation phase gates passed or explicitly waived; readiness hard gates passed; no unresolved critical blockers; transition deliverables accepted; continuous operating cycle activated.';
const INTERIM_COMPLETION_CRITERIA = 'All required delivery phase gates through Stage 2 passed or explicitly waived; Stage 2 certification audit completed; no open major or minor Stage 2 findings; readiness hard gates passed; no unresolved critical blockers; transition deliverables accepted. Continuous surveillance is managed after engagement completion.';
const STAGE2_ONLY_COMPLETION_CRITERIA = 'All required delivery phase gates through Stage 2 passed or explicitly waived; Stage 2 certification audit completed; no open Stage 2 nonconformities or observations; readiness hard gates passed; no unresolved critical blockers; transition deliverables accepted. Continuous surveillance is managed after engagement completion.';
const DEFAULT_COMPLETION_CRITERIA = 'All required delivery phase gates through Stage 2 passed or explicitly waived; dated Stage 1 and Stage 2 certification audits completed; no open Stage 1 or Stage 2 nonconformities or observations; readiness hard gates passed; no unresolved critical blockers; transition deliverables accepted. Continuous surveillance is managed after engagement completion.';
const GAP_ONLY_COMPLETION_CRITERIA = 'Mobilisation, fieldwork and validation are formally concluded; the assessment pass is independently completed; workpapers are frozen and RFIs are closed; an independently approved report is published; and the gap-assessment engagement is formally closed. Findings remain client-owned recommendations and are not represented as remediated.';

const LEGACY_PLAN_NAME = 'ISO 27001 adaptive delivery plan';
const LEGACY_PLAN_OBJECTIVE = 'Reach defensible certification readiness, transition into continuous ISMS operation, and retain client acceptance of every material deliverable.';
const OUTCOME_PLAN_METADATA = Object.freeze({
  gap_assessment_only: Object.freeze({
    name: 'ISO 27001 gap assessment delivery plan',
    objective: 'Complete a governed ISO 27001 gap assessment, independently approve and publish the report, and close the engagement without implying remediation delivery.',
    completionCriteria: GAP_ONLY_COMPLETION_CRITERIA,
    subtitle: 'This contract ends when the independently approved gap-assessment report is published and the governed engagement is formally closed.'
  }),
  certification_support: Object.freeze({
    name: 'ISO 27001 certification support delivery plan',
    objective: 'Deliver the governed gap assessment, implementation and consultancy-owned documentation, internal audit, management review, Stage 1 and Stage 2 representation, and closure of every audit finding or observation.',
    completionCriteria: DEFAULT_COMPLETION_CRITERIA,
    subtitle: 'The journey runs from governed gap assessment through implementation, internal assurance, Stage 1 and Stage 2 support. Surveillance remains visible as the continuing operating cycle.'
  })
});

const GOVERNED_GAP_MILESTONES = new Set(['gap-fieldwork-validation', 'gap-controlled-report']);

function explicitlyExcludesIso27001(ws) {
  const raw = ws?.frameworks;
  let frameworks;
  if (Array.isArray(raw)) frameworks = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { frameworks = JSON.parse(raw); } catch (_) { return false; }
  } else return false;
  return Array.isArray(frameworks) && frameworks.length > 0 && !frameworks.includes('iso27001');
}

const PHASES = [
  { key: 'mobilisation', name: 'Mobilisation & governance', description: 'Kickoff, scope, stakeholders and delivery governance.', milestones: ['w1-kickoff','w1-intake','w1-stakeholders'] },
  { key: 'gap_assessment', name: 'Governed gap assessment & report', description: 'Complete independently reviewed fieldwork and validation, publish the controlled report, then follow the contracted endpoint.', milestones: ['gap-fieldwork-validation','gap-controlled-report'] },
  { key: 'context', name: 'Scope & organisational context', description: 'Assets, crown jewels and the operating context in scope.', milestones: ['w2-assets','w2-crown'] },
  { key: 'assessment', name: 'Risk assessment', description: 'Risk methodology and decision-grade assessment of scoped assets.', milestones: ['w3-method','w3-risks'] },
  { key: 'treatment', name: 'Risk treatment & SoA', description: 'Accountable treatment decisions and a defensible Statement of Applicability.', milestones: ['w4-treatment','w4-soa'] },
  { key: 'implementation', name: 'Control & policy implementation', description: 'Leadership, operational policy, awareness and controlled-document adoption.', milestones: ['w5-policies-a','w5-objectives','w6-policies-b','w7-policies-publish','w7-awareness'] },
  { key: 'operating_evidence', name: 'Operational evidence period', description: 'Retain sufficient, current evidence that controls operate over time.', milestones: ['w12-evidence'] },
  { key: 'internal_assurance', name: 'Internal assurance', description: 'Internal audit, management review and accountable follow-up.', milestones: ['w8-programme','w8-first-audit','w9-mrm','w9-actions'] },
  { key: 'cert_readiness', name: 'Certification readiness', description: 'Readiness pack, mock walkthrough and closure of priority issues.', milestones: ['w10-pack','w10-mock','w10-fixes'] },
  { key: 'stage_1', name: 'Stage 1 & remediation', description: 'Consultant-supported Stage 1 representation and closure of every resulting nonconformity and observation.', milestones: ['w11-stage1','w11-remediation'] },
  { key: 'stage_2', name: 'Stage 2 audit & transition', description: 'Consultant-supported Stage 2 representation, closure of every nonconformity and observation, and transition into certification operations.', milestones: ['w12-stage2-audit','w12-stage2-remediation','w12-handoff'] },
  { key: 'continuous', name: 'Continuous operation & surveillance', description: 'Recurring ISMS operation, surveillance and continual improvement.', continuous: true, milestones: ['continuous-calendar','continuous-surveillance'] }
];

const EXTRA_MILESTONES = {
  'gap-fieldwork-validation': {
    id: 'gap-fieldwork-validation',
    title: 'Complete governed gap fieldwork and factual validation',
    deliverables: null,
    clauses: ['4-10', 'Annex A'],
    completionMode: 'workspace_record',
    skipDeliverable: true,
    acceptanceCriteria: 'A completed assessment pass and formal mobilisation, fieldwork and validation decisions are retained in the governed gap-assessment record.'
  },
  'gap-controlled-report': {
    id: 'gap-controlled-report',
    title: 'Independently approve and publish the gap-assessment report',
    deliverables: null,
    clauses: ['9.1'],
    completionMode: 'workspace_record',
    skipDeliverable: true,
    acceptanceCriteria: 'An assessment report generated by one user is independently approved by another and published to the client portal.'
  },
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

function addMonths(dateString, months) {
  if (!dateString) return null;
  const match = String(dateString).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const targetIndex = monthIndex + Number(months || 0);
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function laterDate(...values) {
  return values.filter(Boolean).sort().pop() || null;
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
     planned_start_date,planned_end_date,forecast_end_date,actual_end_date,completed_at,completion_note,source_rule,
     minimum_duration_months)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      const minimumDurationMonths = Number(source.minimumDurationMonths || 0);
      const minimumEnd = minimumDurationMonths ? addMonths(templateStart, minimumDurationMonths) : null;
      const milestoneEnd = laterDate(old?.target_date, templateEnd, minimumEnd);
      const criteria = source.acceptanceCriteria || `Required deliverable accepted by an authorised approver${source.clauses?.length ? `; supports ${source.clauses.join(', ')}` : ''}.`;
      const milestoneId = insertMilestone.run(planId, phaseId, milestoneKey, source.title,
        source.deliverables || null, criteria, complete ? 'complete' : 'not_started',
        source.completionMode || (['w1-kickoff','w10-mock','w12-handoff','continuous-calendar','continuous-surveillance'].includes(milestoneKey) ? 'manual' : 'deliverable'),
        templateStart, milestoneEnd, milestoneEnd, complete ? old.completed_at.slice(0,10) : null,
        old?.completed_at || null, old?.notes || null, milestoneKey, minimumDurationMonths).lastInsertRowid;
      if (!source.skipDeliverable) {
        insertDeliverable.run(ws.id, planId, milestoneId, source.deliverables || source.title,
          `Acceptance evidence for “${source.title}”.`, criteria,
          source.clientTitle || source.deliverables || source.title,
          source.clientDescription || 'Provide this item for review and approval.',
          source.frameworkCode || 'iso27001', source.requirementRefs || (source.clauses || []).join(', '),
          complete ? 'accepted' : 'draft', 1,
          milestoneEnd, complete ? userId : null, old?.completed_at || null,
          complete ? 'Migrated from the accepted legacy milestone.' : null);
      }
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

function outcomeMetadata(ws) {
  return OUTCOME_PLAN_METADATA[isoLifecycle.normalizeOutcome(ws.engagement_outcome)];
}

// Template evolution is additive: the governed gap-assessment checkpoint is
// inserted into an existing plan without replacing phase, milestone,
// deliverable, baseline or event identifiers already retained for the client.
function repairGapAssessmentJourney(db, ws, userId, plan) {
  let scheduleChanged = 0;
  let dataChanged = 0;
  const repair = db.transaction(() => {
    let phase = db.prepare(`SELECT * FROM engagement_delivery_phases
      WHERE plan_id=? AND phase_key='gap_assessment'`).get(plan.id);
    if (!phase) {
      const mobilisation = db.prepare(`SELECT * FROM engagement_delivery_phases
        WHERE plan_id=? AND phase_key='mobilisation'`).get(plan.id) || null;
      const context = db.prepare(`SELECT * FROM engagement_delivery_phases
        WHERE plan_id=? AND phase_key='context'`).get(plan.id) || null;
      db.prepare(`UPDATE engagement_delivery_phases SET sort_order=sort_order+1,updated_at=datetime('now')
        WHERE plan_id=? AND sort_order>=2`).run(plan.id);
      const phaseId = db.prepare(`INSERT INTO engagement_delivery_phases
        (plan_id,phase_key,name,description,sort_order,planned_start_date,planned_end_date,forecast_end_date,is_continuous)
        VALUES (?,'gap_assessment',?,?,2,?,?,?,0)`).run(
          plan.id,
          'Governed gap assessment & report',
          'Complete independently reviewed fieldwork and validation, publish the controlled report, then follow the contracted endpoint.',
          mobilisation?.forecast_end_date || mobilisation?.planned_end_date || null,
          context?.planned_start_date || null,
          context?.forecast_end_date || context?.planned_start_date || null
        ).lastInsertRowid;
      phase = db.prepare('SELECT * FROM engagement_delivery_phases WHERE id=?').get(phaseId);
      scheduleChanged += 1;
      dataChanged += 2;
    }

    const insertMilestone = db.prepare(`INSERT INTO engagement_delivery_milestones
      (plan_id,phase_id,milestone_key,title,description,acceptance_criteria,status,completion_mode,
       planned_start_date,planned_end_date,forecast_end_date,source_rule,minimum_duration_months)
      VALUES (?,?,?,?,?,?,'not_started','workspace_record',?,?,?,?,0)`);
    for (const key of ['gap-fieldwork-validation', 'gap-controlled-report']) {
      if (db.prepare(`SELECT 1 FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key=?`).get(plan.id, key)) continue;
      const source = EXTRA_MILESTONES[key];
      const milestoneId = insertMilestone.run(
        plan.id, phase.id, key, source.title, source.deliverables || null, source.acceptanceCriteria,
        phase.planned_start_date || null, phase.planned_end_date || null,
        phase.forecast_end_date || phase.planned_end_date || null, key
      ).lastInsertRowid;
      if (!milestoneId) throw new Error(`Could not add ${key} to the adaptive delivery plan.`);
      scheduleChanged += 1;
      dataChanged += 1;
    }

    const byKey = key => db.prepare(`SELECT id FROM engagement_delivery_milestones
      WHERE plan_id=? AND milestone_key=?`).get(plan.id, key)?.id;
    const addLink = (fromKey, toKey) => {
      const from = byKey(fromKey);
      const to = byKey(toKey);
      if (!from || !to) return;
      const inserted = db.prepare(`INSERT OR IGNORE INTO engagement_delivery_dependencies
        (plan_id,predecessor_milestone_id,successor_milestone_id,created_by) VALUES (?,?,?,?)`)
        .run(plan.id, from, to, userId).changes;
      scheduleChanged += inserted;
      dataChanged += inserted;
    };
    addLink('w1-stakeholders', 'gap-fieldwork-validation');
    addLink('gap-fieldwork-validation', 'gap-controlled-report');
    addLink('gap-controlled-report', 'w2-assets');
  });
  repair();
  return { scheduleChanged, dataChanged };
}

function repairOutcomeMetadata(db, ws, plan) {
  const metadata = outcomeMetadata(ws);
  const knownNames = new Set([
    LEGACY_PLAN_NAME,
    OUTCOME_PLAN_METADATA.gap_assessment_only.name,
    OUTCOME_PLAN_METADATA.certification_support.name
  ]);
  const knownObjectives = new Set([
    LEGACY_PLAN_OBJECTIVE,
    OUTCOME_PLAN_METADATA.gap_assessment_only.objective,
    OUTCOME_PLAN_METADATA.certification_support.objective
  ]);
  const knownCriteria = new Set([
    LEGACY_COMPLETION_CRITERIA,
    INTERIM_COMPLETION_CRITERIA,
    STAGE2_ONLY_COMPLETION_CRITERIA,
    DEFAULT_COMPLETION_CRITERIA,
    GAP_ONLY_COMPLETION_CRITERIA
  ]);
  const governedGapClosure = !!db.prepare(`SELECT 1 FROM engagement_delivery_events
      WHERE plan_id=? AND action='completed_at_controlled_report' LIMIT 1`).get(plan.id)
    || !!db.prepare(`SELECT 1 FROM consulting_events
      WHERE workspace_id=? AND action='completed_at_report' LIMIT 1`).get(ws.id);
  const convertingToFull = !isoLifecycle.isGapOnly(ws.engagement_outcome)
    && plan.status === 'completed'
    && (governedGapClosure
      || plan.name === OUTCOME_PLAN_METADATA.gap_assessment_only.name
      || plan.objective === OUTCOME_PLAN_METADATA.gap_assessment_only.objective
      || plan.completion_criteria === GAP_ONLY_COMPLETION_CRITERIA);
  const sets = [];
  const values = [];
  if (knownNames.has(plan.name) && plan.name !== metadata.name) { sets.push('name=?'); values.push(metadata.name); }
  if (knownObjectives.has(plan.objective) && plan.objective !== metadata.objective) { sets.push('objective=?'); values.push(metadata.objective); }
  if (knownCriteria.has(plan.completion_criteria) && plan.completion_criteria !== metadata.completionCriteria) {
    sets.push('completion_criteria=?');
    values.push(metadata.completionCriteria);
  }
  if (convertingToFull) { sets.push("status='active'"); }
  if (!sets.length) return { dataChanged: 0, reactivated: false };
  const changed = db.prepare(`UPDATE engagement_delivery_plans SET ${sets.join(',')},updated_at=datetime('now') WHERE id=?`)
    .run(...values, plan.id).changes;
  return { dataChanged: changed, reactivated: convertingToFull && changed > 0 };
}

// Plans are governed workspace records, so template evolution must be
// additive. This repair adds the Stage 2 audit and remediation outcomes to
// already-seeded plans without replacing their plan, accepted deliverables,
// assignments, dates, or decision history.
function repairStage2Journey(db, ws, userId, plan) {
  const phase = db.prepare(`SELECT * FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='stage_2'`).get(plan.id);
  if (!phase) return { scheduleChanged: 0, dataChanged: 0 };

  let scheduleChanged = 0;
  let dataChanged = 0;
  const stage1Phase = db.prepare(`SELECT * FROM engagement_delivery_phases
    WHERE plan_id=? AND phase_key='stage_1'`).get(plan.id);
  if (stage1Phase
      && stage1Phase.name === 'Stage 1 & remediation'
      && stage1Phase.description === 'External Stage 1 audit and closure of resulting nonconformities.') {
    dataChanged += db.prepare(`UPDATE engagement_delivery_phases SET description=?,updated_at=datetime('now')
      WHERE id=?`).run(
        'Consultant-supported Stage 1 representation and closure of every resulting nonconformity and observation.',
        stage1Phase.id
      ).changes;
  }
  const phaseUpdate = db.prepare(`UPDATE engagement_delivery_phases SET name=?,description=?,updated_at=datetime('now')
    WHERE id=? AND name=? AND COALESCE(description,'')=?`).run(
      'Stage 2 audit & transition',
      'Consultant-supported Stage 2 representation, closure of every nonconformity and observation, and transition into certification operations.',
      phase.id,
      'Stage 2 & transition',
      'Final handover and transition into certification operations.'
    );
  dataChanged += phaseUpdate.changes;
  dataChanged += db.prepare(`UPDATE engagement_delivery_phases SET description=?,updated_at=datetime('now')
    WHERE id=? AND name='Stage 2 audit & transition' AND description=?`).run(
      'Consultant-supported Stage 2 representation, closure of every nonconformity and observation, and transition into certification operations.',
      phase.id,
      'Consultant-supported Stage 2 audit, accountable closure of material findings, and transition into certification operations.'
    ).changes;

  const criteriaUpdate = db.prepare(`UPDATE engagement_delivery_plans SET completion_criteria=?,updated_at=datetime('now')
    WHERE id=? AND completion_criteria IN (?,?,?)`).run(
      DEFAULT_COMPLETION_CRITERIA, plan.id, LEGACY_COMPLETION_CRITERIA,
      INTERIM_COMPLETION_CRITERIA, STAGE2_ONLY_COMPLETION_CRITERIA);
  dataChanged += criteriaUpdate.changes;

  const templateSources = Object.fromEntries(ENG_PLAN.flatten().map(row => [row.id, row]));
  const stage1 = db.prepare(`SELECT * FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w11-stage1'`).get(plan.id);
  if (stage1 && stage1.title === 'Stage 1 certification audit (documentation review)') {
    const source = templateSources['w11-stage1'];
    dataChanged += db.prepare(`UPDATE engagement_delivery_milestones SET title=?,
      description=CASE WHEN description='Certifier Stage 1 report; minor NCs catalogued' THEN ? ELSE description END,
      updated_at=datetime('now'),row_version=row_version+1 WHERE id=?`).run(source.title, source.deliverables, stage1.id).changes;
    dataChanged += db.prepare(`UPDATE engagement_delivery_deliverables SET
      title=CASE WHEN title='Certifier Stage 1 report; minor NCs catalogued' THEN ? ELSE title END,
      description=CASE WHEN description='Acceptance evidence for “Stage 1 certification audit (documentation review)”.' THEN ? ELSE description END,
      updated_at=datetime('now'),row_version=row_version+1 WHERE milestone_id=?`).run(
        source.deliverables, `Acceptance evidence for “${source.title}”.`, stage1.id).changes;
  }
  const stage1Remediation = db.prepare(`SELECT * FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w11-remediation'`).get(plan.id);
  if (stage1Remediation && stage1Remediation.title === 'Remediate Stage 1 minor NCs ahead of Stage 2') {
    const source = templateSources['w11-remediation'];
    dataChanged += db.prepare(`UPDATE engagement_delivery_milestones SET title=?,
      description=CASE WHEN description='Closed NCs with evidence; 3+ months operational evidence ready' THEN ? ELSE description END,
      updated_at=datetime('now'),row_version=row_version+1 WHERE id=?`).run(source.title, source.deliverables, stage1Remediation.id).changes;
    dataChanged += db.prepare(`UPDATE engagement_delivery_deliverables SET
      title=CASE WHEN title='Closed NCs with evidence; 3+ months operational evidence ready' THEN ? ELSE title END,
      updated_at=datetime('now'),row_version=row_version+1 WHERE milestone_id=?`).run(
        source.deliverables, stage1Remediation.id).changes;
  }

  // Replace only the exact legacy hand-off wording. User-authored edits are
  // left untouched, while the prior "hand to client" default cannot survive.
  const handoffSource = Object.fromEntries(ENG_PLAN.flatten().map(row => [row.id, row]))['w12-handoff'];
  const handoff = db.prepare(`SELECT * FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w12-handoff'`).get(plan.id);
  if (handoff && handoff.title === 'Hand engagement to client for Stage 2 audit') {
    dataChanged += db.prepare(`UPDATE engagement_delivery_milestones SET title=?,description=?,updated_at=datetime('now'),row_version=row_version+1
      WHERE id=?`).run(handoffSource.title, handoffSource.deliverables, handoff.id).changes;
    dataChanged += db.prepare(`UPDATE engagement_delivery_deliverables SET title=?,description=?,
      client_title=CASE WHEN client_title IS NULL OR client_title='Ongoing assurance and surveillance plan' THEN ? ELSE client_title END,
      updated_at=datetime('now'),row_version=row_version+1
      WHERE milestone_id=? AND title='Handover pack: residual risks, year-1 surveillance plan'`).run(
        handoffSource.deliverables,
        `Acceptance evidence for “${handoffSource.title}”.`,
        handoffSource.clientTitle,
        handoff.id
      ).changes;
  }

  const sources = templateSources;
  const remediation = db.prepare(`SELECT * FROM engagement_delivery_milestones
    WHERE plan_id=? AND milestone_key='w12-stage2-remediation'`).get(plan.id);
  if (remediation && remediation.description === 'Finding register, corrective-action evidence, and validated closure record; no open major or minor Stage 2 findings') {
    dataChanged += db.prepare(`UPDATE engagement_delivery_milestones SET description=?,updated_at=datetime('now'),row_version=row_version+1 WHERE id=?`)
      .run(sources['w12-stage2-remediation'].deliverables, remediation.id).changes;
    dataChanged += db.prepare(`UPDATE engagement_delivery_deliverables SET title=?,updated_at=datetime('now'),row_version=row_version+1
      WHERE milestone_id=? AND title='Finding register, corrective-action evidence, and validated closure record; no open major or minor Stage 2 findings'`)
      .run(sources['w12-stage2-remediation'].deliverables, remediation.id).changes;
  }
  const anchor = handoff || phase;
  const insertMilestone = db.prepare(`INSERT INTO engagement_delivery_milestones
    (plan_id,phase_id,milestone_key,title,description,acceptance_criteria,status,completion_mode,
     planned_start_date,planned_end_date,forecast_end_date,source_rule,minimum_duration_months)
    VALUES (?,?,?,?,?,?,'not_started','deliverable',?,?,?,?,?)`);
  const insertDeliverable = db.prepare(`INSERT INTO engagement_delivery_deliverables
    (workspace_id,plan_id,milestone_id,title,description,acceptance_criteria,client_title,client_description,
     framework_code,requirement_refs,status,is_required,due_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,'draft',1,?)`);
  for (const key of ['w12-stage2-audit', 'w12-stage2-remediation']) {
    if (db.prepare(`SELECT 1 FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key=?`).get(plan.id, key)) continue;
    const source = sources[key];
    const criteria = `Required deliverable accepted by an authorised approver${source.clauses?.length ? `; supports ${source.clauses.join(', ')}` : ''}.`;
    const milestoneId = insertMilestone.run(
      plan.id, phase.id, key, source.title, source.deliverables, criteria,
      anchor.planned_start_date || phase.planned_start_date || null,
      anchor.planned_end_date || phase.planned_end_date || null,
      anchor.forecast_end_date || anchor.planned_end_date || phase.forecast_end_date || phase.planned_end_date || null,
      key, Number(source.minimumDurationMonths || 0)
    ).lastInsertRowid;
    insertDeliverable.run(
      ws.id, plan.id, milestoneId, source.deliverables, `Acceptance evidence for “${source.title}”.`, criteria,
      source.clientTitle || source.deliverables, source.clientDescription || 'Provide this item for review and approval.',
      source.frameworkCode || 'iso27001', source.requirementRefs || (source.clauses || []).join(', '),
      anchor.forecast_end_date || anchor.planned_end_date || phase.forecast_end_date || phase.planned_end_date || null
    );
    scheduleChanged += 1;
    dataChanged += 2;
  }

  const byKey = key => db.prepare(`SELECT id FROM engagement_delivery_milestones WHERE plan_id=? AND milestone_key=?`).get(plan.id, key)?.id;
  const addLink = (fromKey, toKey) => {
    const from = byKey(fromKey);
    const to = byKey(toKey);
    if (!from || !to) return;
    const inserted = db.prepare(`INSERT OR IGNORE INTO engagement_delivery_dependencies
      (plan_id,predecessor_milestone_id,successor_milestone_id,created_by) VALUES (?,?,?,?)`)
      .run(plan.id, from, to, userId).changes;
    scheduleChanged += inserted;
    dataChanged += inserted;
  };
  addLink('w11-remediation', 'w12-stage2-audit');
  addLink('w12-stage2-audit', 'w12-stage2-remediation');
  addLink('w12-stage2-remediation', 'w12-handoff');
  addLink('w12-handoff', 'continuous-calendar');

  return { scheduleChanged, dataChanged };
}

function ensurePlan(db, ws, userId, { repairSchedule = true } = {}) {
  if (explicitlyExcludesIso27001(ws)) return null;
  let plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id);
  let created = false;
  if (!plan) {
    const metadata = outcomeMetadata(ws);
    const create = db.transaction(() => {
    const planId = db.prepare(`INSERT INTO engagement_delivery_plans
      (workspace_id,name,objective,status,target_start_date,target_completion_date,forecast_completion_date,completion_criteria,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(ws.id, metadata.name,
        metadata.objective,
        'active', String(ws.created_at || new Date().toISOString()).slice(0,10), ws.target_cert_date || null,
        ws.target_cert_date || null,
        metadata.completionCriteria,
        userId).lastInsertRowid;
    seedTemplate(db, ws, userId, planId);
    event(db, ws.id, planId, userId, 'plan', planId, 'created', null, 'active', { source: 'adaptive_iso27001_template' });
    return planId;
    })();
    plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE id=?').get(create);
    created = true;
  }
  const gapRepair = repairGapAssessmentJourney(db, ws, userId, plan);
  const stage2Repair = repairStage2Journey(db, ws, userId, plan);
  const metadataRepair = repairOutcomeMetadata(db, ws, plan);
  if (gapRepair.dataChanged || stage2Repair.dataChanged || metadataRepair.dataChanged) {
    plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE id=?').get(plan.id);
  }
  if (metadataRepair.reactivated) {
    event(db, ws.id, plan.id, userId, 'plan', plan.id, 'contract_outcome_expanded', 'completed', 'active', {
      engagement_outcome: isoLifecycle.normalizeOutcome(ws.engagement_outcome)
    });
  }
  if (repairSchedule) {
    const repaired = enforceMinimumDurations(db, plan.id);
    if (created || repaired || gapRepair.scheduleChanged || stage2Repair.scheduleChanged) {
      const trigger = created ? 'template_scheduled'
        : gapRepair.scheduleChanged ? 'gap_assessment_journey_repaired'
          : stage2Repair.scheduleChanged ? 'stage2_journey_repaired'
            : 'minimum_duration_enforced';
      recalculatePlanSchedule(db, ws, userId, plan, trigger,
        repaired + gapRepair.scheduleChanged + stage2Repair.scheduleChanged);
      plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE id=?').get(plan.id);
    }
  }
  return plan;
}

function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

// Validate a proposed Stage 1/Stage 2 event without mutating retained audit
// history. This is used both by routes and by completion projection so direct
// or legacy database rows cannot satisfy the certification gate ambiguously.
function validateCertificationEvent(db, workspaceId, candidate, { excludeEventId = null } = {}) {
  const eventType = String(candidate?.event_type || '');
  if (!['stage_1', 'stage_2'].includes(eventType)) return { valid: true, errors: [] };
  const stageLabel = eventType === 'stage_1' ? 'Stage 1' : 'Stage 2';
  const plannedDate = String(candidate.planned_date || '').trim();
  const actualDate = String(candidate.actual_date || '').trim();
  const status = String(candidate.status || 'planned').toLowerCase();
  const errors = [];
  if (plannedDate && !isValidISODate(plannedDate)) errors.push(`${stageLabel} planned date must be a valid ISO date (YYYY-MM-DD).`);
  if (actualDate && !isValidISODate(actualDate)) errors.push(`${stageLabel} actual date must be a valid ISO date (YYYY-MM-DD).`);
  if (status === 'closed' && !actualDate) errors.push(`${stageLabel} requires an actual audit date before it can be closed.`);

  const sameStage = db.prepare(`SELECT id,status,actual_date FROM cert_cycle_events
    WHERE workspace_id=? AND event_type=? ORDER BY id`).all(workspaceId, eventType)
    .filter(row => Number(row.id) !== Number(excludeEventId));
  if (sameStage.length) {
    errors.push(`A ${stageLabel} event already exists. Update or reschedule the retained event instead of creating a duplicate.`);
  }

  if (status === 'closed' && actualDate && isValidISODate(actualDate)) {
    if (eventType === 'stage_2') {
      const stage1Rows = db.prepare(`SELECT id,status,actual_date FROM cert_cycle_events
        WHERE workspace_id=? AND event_type='stage_1' ORDER BY id`).all(workspaceId);
      if (stage1Rows.length !== 1) {
        errors.push('Stage 2 cannot close until exactly one retained Stage 1 event exists.');
      } else {
        const stage1 = stage1Rows[0];
        if (String(stage1.status || '').toLowerCase() !== 'closed' || !isValidISODate(String(stage1.actual_date || ''))) {
          errors.push('Stage 2 cannot close until Stage 1 is closed with a valid actual audit date.');
        } else if (actualDate < stage1.actual_date) {
          errors.push('Stage 2 actual audit date cannot be before the Stage 1 actual audit date.');
        }
      }
    } else {
      const closedStage2 = db.prepare(`SELECT id,actual_date FROM cert_cycle_events
        WHERE workspace_id=? AND event_type='stage_2' AND lower(COALESCE(status,''))='closed'`).all(workspaceId);
      if (closedStage2.some(row => isValidISODate(String(row.actual_date || '')) && row.actual_date < actualDate)) {
        errors.push('Stage 1 actual audit date cannot be after an already closed Stage 2 audit.');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function certificationAuditState(db, workspaceId, eventType) {
  if (!['stage_1','stage_2'].includes(eventType)) throw new Error('Unsupported certification audit stage.');
  const events = db.prepare(`SELECT id,status,planned_date,actual_date FROM cert_cycle_events
    WHERE workspace_id=? AND event_type=? ORDER BY id`).all(workspaceId, eventType);
  const invalidDateEvents = events.filter(row =>
    (row.planned_date && !isValidISODate(String(row.planned_date)))
    || (row.actual_date && !isValidISODate(String(row.actual_date)))).length;
  const closedEvents = events.filter(row => String(row.status || '').toLowerCase() === 'closed');
  const validClosedEvents = closedEvents.filter(row => isValidISODate(String(row.actual_date || '')));
  const completedAudits = validClosedEvents.length;
  const uniqueEvent = events.length === 1;
  const auditComplete = uniqueEvent && completedAudits === 1 && invalidDateEvents === 0;
  const totalFindings = db.prepare(`SELECT COUNT(*) c FROM nonconformities n
    WHERE n.workspace_id=? AND lower(COALESCE(n.source,''))='external_audit'
      AND n.source_ref IN (SELECT 'cert_cycle_event:' || id FROM cert_cycle_events WHERE workspace_id=? AND event_type=?)`).get(workspaceId, workspaceId, eventType).c;
  const openMaterialFindings = db.prepare(`SELECT COUNT(*) c FROM nonconformities n
    WHERE n.workspace_id=? AND lower(COALESCE(n.source,''))='external_audit'
      AND n.source_ref IN (SELECT 'cert_cycle_event:' || id FROM cert_cycle_events WHERE workspace_id=? AND event_type=?)
      AND lower(COALESCE(n.severity,'')) IN ('major','minor')
      AND lower(COALESCE(n.status,'open')) NOT IN ('closed','verified')`).get(workspaceId, workspaceId, eventType).c;
  const openObservations = db.prepare(`SELECT COUNT(*) c FROM nonconformities n
    WHERE n.workspace_id=? AND lower(COALESCE(n.source,''))='external_audit'
      AND n.source_ref IN (SELECT 'cert_cycle_event:' || id FROM cert_cycle_events WHERE workspace_id=? AND event_type=?)
      AND lower(COALESCE(n.severity,''))='observation'
      AND lower(COALESCE(n.status,'open')) NOT IN ('closed','verified')`).get(workspaceId, workspaceId, eventType).c;
  const openFindings = db.prepare(`SELECT COUNT(*) c FROM nonconformities n
    WHERE n.workspace_id=? AND lower(COALESCE(n.source,''))='external_audit'
      AND n.source_ref IN (SELECT 'cert_cycle_event:' || id FROM cert_cycle_events WHERE workspace_id=? AND event_type=?)
      AND lower(COALESCE(n.status,'open')) NOT IN ('closed','verified')`).get(workspaceId, workspaceId, eventType).c;
  return {
    eventCount: events.length,
    duplicateEvents: Math.max(0, events.length - 1),
    invalidDateEvents,
    invalidClosedDates: closedEvents.length - validClosedEvents.length,
    completedAudits,
    auditComplete,
    actualDate: auditComplete ? validClosedEvents[0].actual_date : null,
    totalFindings,
    openMaterialFindings,
    openObservations,
    openFindings,
    materialClear: openMaterialFindings === 0,
    allClear: openFindings === 0
  };
}

function stage2AssuranceState(db, workspaceId) {
  const stage1 = certificationAuditState(db, workspaceId, 'stage_1');
  const stage2 = certificationAuditState(db, workspaceId, 'stage_2');
  const rawAuditComplete = stage2.auditComplete;
  const stageSequenceValid = rawAuditComplete && stage1.auditComplete
    && stage2.actualDate >= stage1.actualDate;
  return {
    ...stage2,
    rawAuditComplete,
    stageSequenceValid,
    auditComplete: rawAuditComplete && stageSequenceValid
  };
}

function certificationCompletionState(phases, readinessReady, openBlockers, stage2, stage1 = { auditComplete: true, openFindings: 0 }) {
  const requiredPhases = phases.filter(phase => !phase.is_continuous);
  const phaseGatesReady = requiredPhases.every(phase => ['complete','waived'].includes(phase.effective_status));
  const completionReady = phaseGatesReady
    && !!readinessReady
    && Number(openBlockers || 0) === 0
    && !!stage1.auditComplete
    && Number(stage1.openFindings ?? ((stage1.openMaterialFindings || 0) + (stage1.openObservations || 0))) === 0
    && !!stage2.auditComplete
    && Number(stage2.openFindings ?? ((stage2.openMaterialFindings || 0) + (stage2.openObservations || 0))) === 0;
  return { requiredPhases, phaseGatesReady, completionReady };
}

function syncOutcomePlanStatus(db, ws, userId) {
  const plan = ensurePlan(db, ws, userId);
  if (!plan) return { planId: null, changed: false, status: null, applicable: false };
  if (plan.status === 'completed') {
    const reconciled = reconcileCompletionState(db, ws, userId, {
      reason: 'Completion status was reconciled against the current governed prerequisites.'
    });
    return {
      planId: plan.id,
      changed: reconciled.changed,
      status: reconciled.planReopened ? 'active' : 'completed',
      reconciled
    };
  }
  if (plan.status === 'cancelled') {
    return { planId: plan.id, changed: false, status: plan.status };
  }
  const gapOnly = isoLifecycle.isGapOnly(ws.engagement_outcome);
  const gap = gapOnly ? gapFieldwork.assessmentContext(db, ws) : null;
  const projection = gapOnly ? null : getProjection(db, ws, userId, { ensure: false });
  const complete = gapOnly
    ? !!gap.pass && gap.pass.status === 'completed'
      && !!gap.completed.mobilisation && !!gap.completed.fieldwork && !!gap.completed.validation
      && !!gap.completed.report && !!gap.closure.complete && gap.closure.blockers.length === 0
    : !!projection?.summary.completionReady;
  if (!complete) return { planId: plan.id, changed: false, status: plan.status };
  const changed = db.prepare(`UPDATE engagement_delivery_plans SET status='completed',updated_at=datetime('now')
    WHERE id=? AND status NOT IN ('completed','cancelled')`).run(plan.id).changes;
  if (changed) {
    event(db, ws.id, plan.id, userId, 'plan', plan.id,
      gapOnly ? 'completed_at_controlled_report' : 'completed_after_stage2_closure',
      plan.status, 'completed', {
      engagement_outcome: isoLifecycle.normalizeOutcome(ws.engagement_outcome),
      ...(gapOnly ? { independently_approved_reports: gap.closure.independentlyApprovedReports } : {
        stage_1_audit_complete: projection.summary.stage1AuditComplete,
        stage_2_audit_complete: projection.summary.stage2AuditComplete,
        open_stage_1_findings: projection.summary.openStage1Findings,
        open_stage_2_findings: projection.summary.openStage2Findings
      })
    });
  }
  return { planId: plan.id, changed: changed > 0, status: changed ? 'completed' : plan.status };
}

function syncCertificationEngagementCompletion(db, ws, userId) {
  if (isoLifecycle.isGapOnly(ws.engagement_outcome)) return { changed: false, engagementId: null };
  const projection = getProjection(db, ws, userId);
  if (!projection || !projection.summary.completionReady || projection.plan.status !== 'completed') {
    return { changed: false, engagementId: null };
  }
  const engagement = db.prepare(`SELECT * FROM consulting_engagements
    WHERE workspace_id=? AND status NOT IN ('complete','cancelled')
      AND engagement_type IN ('implementation','readiness','advisory')
    ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,
      CASE status WHEN 'active' THEN 0 WHEN 'quality_review' THEN 1 ELSE 2 END,id DESC LIMIT 1`)
    .get(ws.id, projection.plan.consulting_engagement_id || -1) || null;
  if (!engagement) return { changed: false, engagementId: null };
  const note = 'Certification-support delivery completed after governed Stage 1 and Stage 2 audit closure; all linked findings, observations, workpapers and client RFIs were closed.';
  const changed = db.prepare(`UPDATE consulting_engagements SET status='complete',completed_at=datetime('now'),
    completion_note=CASE WHEN trim(COALESCE(completion_note,''))='' THEN ? ELSE completion_note END,
    updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND workspace_id=? AND status NOT IN ('complete','cancelled')`)
    .run(note, engagement.id, ws.id).changes;
  if (changed) {
    db.prepare(`INSERT INTO consulting_events
      (workspace_id,engagement_id,entity_type,entity_id,action,details_json,actor_id)
      VALUES (?,?,'engagement',?,'completed_from_delivery_plan',?,?)`).run(
        ws.id, engagement.id, engagement.id,
        JSON.stringify({ plan_id: projection.plan.id, engagement_outcome: isoLifecycle.normalizeOutcome(ws.engagement_outcome) }),
        userId
      );
  }
  return { changed: changed > 0, engagementId: engagement.id };
}

function certificationEventForSourceRef(db, workspaceId, sourceRef) {
  const match = /^cert_cycle_event:(\d+)$/.exec(String(sourceRef || '').trim());
  if (!match) return null;
  return db.prepare(`SELECT id,event_type,status,actual_date FROM cert_cycle_events
    WHERE id=? AND workspace_id=? AND event_type IN ('stage_1','stage_2')`).get(Number(match[1]), workspaceId) || null;
}

function certificationFindingLineage(db, workspaceId, findingId) {
  const finding = db.prepare(`SELECT id,title,source,source_ref,status,severity FROM nonconformities
    WHERE id=? AND workspace_id=?`).get(findingId, workspaceId);
  if (!finding) return null;
  const certEvent = certificationEventForSourceRef(db, workspaceId, finding.source_ref);
  return certEvent ? { ...finding, cert_event_id: certEvent.id, event_type: certEvent.event_type } : null;
}

// A completed record is a statement about the current governed evidence, not
// a permanent flag. Reconcile after any mutation that can invalidate closure;
// both linked records reopen together and retain an immutable event trail.
function reconcileCompletionState(db, ws, userId, context = {}) {
  const plan = db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id) || null;
  if (!plan) return { changed: false, planReopened: false, engagementReopened: false, completionReady: null };
  const projection = getProjection(db, ws, userId, { ensure: false });
  if (!projection || projection.summary.completionReady) {
    return {
      changed: false,
      planReopened: false,
      engagementReopened: false,
      completionReady: !!projection?.summary.completionReady,
      planId: plan.id
    };
  }

  const action = String(context.action || 'reopened_after_completion_invalidated');
  const details = {
    invalidation_reason: context.reason || 'Completion prerequisites no longer pass.',
    completion_blockers: projection.summary.completionBlockers,
    ...(context.details || {})
  };
  return db.transaction(() => {
    const planChanged = db.prepare(`UPDATE engagement_delivery_plans SET status='active',updated_at=datetime('now')
      WHERE id=? AND status='completed'`).run(plan.id).changes;
    if (planChanged) {
      event(db, ws.id, plan.id, userId, 'plan', plan.id, action, 'completed', 'active', details);
    }
    const linkedEngagement = plan.consulting_engagement_id
      ? db.prepare(`SELECT * FROM consulting_engagements
          WHERE id=? AND workspace_id=? AND status='complete'`).get(plan.consulting_engagement_id, ws.id) || null
      : null;
    let engagementChanged = 0;
    if (linkedEngagement) {
      engagementChanged = db.prepare(`UPDATE consulting_engagements
        SET status='active',completed_at=NULL,updated_at=datetime('now'),row_version=row_version+1
        WHERE id=? AND workspace_id=? AND status='complete'`).run(linkedEngagement.id, ws.id).changes;
      if (engagementChanged) {
        db.prepare(`INSERT INTO consulting_events
          (workspace_id,engagement_id,entity_type,entity_id,action,details_json,actor_id)
          VALUES (?,?,'engagement',?,?,?,?)`).run(
            ws.id, linkedEngagement.id, linkedEngagement.id, action,
            JSON.stringify({ ...details, plan_id: plan.id, previous_completed_at: linkedEngagement.completed_at }), userId
          );
      }
    }
    return {
      changed: !!(planChanged || engagementChanged),
      planReopened: !!planChanged,
      engagementReopened: !!engagementChanged,
      completionReady: false,
      planId: plan.id,
      engagementId: engagementChanged ? linkedEngagement.id : null,
      blockers: projection.summary.completionBlockers
    };
  })();
}

// A finding can arrive after a certification-support plan was marked complete.
// Reopen only when the record is open and linked to its immutable Stage 1/2
// lineage; unrelated findings cannot mutate delivery state.
function reopenForCertificationFinding(db, ws, userId, findingId) {
  const finding = certificationFindingLineage(db, ws.id, findingId);
  if (!finding || String(finding.source || '').toLowerCase() !== 'external_audit'
      || ['closed', 'verified'].includes(String(finding.status || '').toLowerCase())) {
    return { changed: false, planReopened: false, engagementReopened: false };
  }
  return reconcileCompletionState(db, ws, userId, {
    action: 'reopened_for_certification_finding',
    reason: `An open ${finding.event_type === 'stage_1' ? 'Stage 1' : 'Stage 2'} certification finding was recorded.`,
    details: {
      finding_id: finding.id,
      certification_event_id: finding.cert_event_id,
      audit_stage: finding.event_type,
      severity: finding.severity
    }
  });
}

const reopenForStage2Finding = reopenForCertificationFinding;

// A deliberate reopen of the linked consulting engagement is itself a
// lifecycle decision. Keep the plan coherent even when all evidence still
// passes at that instant; the newly opened work will add its own blockers.
function reopenForConsultingEngagement(db, ws, userId, engagementId) {
  const plan = db.prepare(`SELECT * FROM engagement_delivery_plans
    WHERE workspace_id=? AND consulting_engagement_id=?`).get(ws.id, Number(engagementId));
  if (!plan) return { changed: false, planId: null };
  const changed = db.prepare(`UPDATE engagement_delivery_plans SET status='active',updated_at=datetime('now')
    WHERE id=? AND workspace_id=? AND status='completed'`).run(plan.id, ws.id).changes;
  if (changed) {
    event(db, ws.id, plan.id, userId, 'plan', plan.id,
      'reopened_with_consulting_engagement', 'completed', 'active', {
        consulting_engagement_id: Number(engagementId),
        reason: 'The linked certification-support consulting engagement was deliberately reopened.'
      });
  }
  return { changed: changed > 0, planId: plan.id };
}

function sourceVerification(db, ws, readinessInput = null, gapInput = null) {
  const wsId = ws.id;
  const result = {};
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;
  const mark = (key, pass, reason, href) => { if (pass) result[key] = { pass: true, reason, href }; };
  const readiness = readinessInput || computeReadiness(ws);
  const status = buildWorkspaceStatus(db, ws, readiness);
  const gate = key => readiness.stage1Gate.find(item => item.key === key);

  const gap = gapInput || gapFieldwork.assessmentContext(db, ws);
  const fieldworkValidated = !!gap.pass && gap.pass.status === 'completed'
    && !!gap.completed.mobilisation && !!gap.completed.fieldwork && !!gap.completed.validation;
  mark('gap-fieldwork-validation', fieldworkValidated,
    'Completed assessment pass with formal mobilisation, fieldwork and validation decisions',
    `/workspaces/${wsId}/gap-assessment/fieldwork`);
  mark('gap-controlled-report', !!gap.completed.report,
    `${gap.closure.independentlyApprovedReports} independently approved assessment report${gap.closure.independentlyApprovedReports === 1 ? '' : 's'} published`,
    `/workspaces/${wsId}/gap-assessment/fieldwork`);

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
  const stage1 = certificationAuditState(db, wsId, 'stage_1');
  mark('w11-stage1', ['post_stage_1','post_stage_2','surveillance'].includes(status.lifecycle.key) || stage1.auditComplete,
    stage1.auditComplete ? `${stage1.completedAudits} completed Stage 1 certification audit${stage1.completedAudits === 1 ? '' : 's'} recorded` : status.lifecycle.label,
    `/workspaces/${wsId}/cert-cycle`);
  mark('w11-remediation', stage1.auditComplete && stage1.allClear,
    'No open Stage 1 nonconformities or observations', `/workspaces/${wsId}/cert-cycle`);
  const stage2 = stage2AssuranceState(db, wsId);
  mark('w12-stage2-audit', stage2.auditComplete,
    `${stage2.completedAudits} completed Stage 2 certification audit${stage2.completedAudits === 1 ? '' : 's'} recorded`, `/workspaces/${wsId}/cert-cycle`);
  mark('w12-stage2-remediation', stage2.auditComplete && stage2.allClear,
    'No open Stage 2 nonconformities or observations',
    `/workspaces/${wsId}/cert-cycle`);
  const recurring = count(`SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND recurrence IS NOT NULL`, wsId);
  mark('continuous-calendar', recurring >= 3, `${recurring} recurring ISMS tasks are active`, `/workspaces/${wsId}/calendar`);
  const surveillance = count(`SELECT COUNT(*) c FROM cert_cycle_events WHERE workspace_id=? AND event_type IN ('surveillance_y1','surveillance_y2','surveillance_1','surveillance_2','recertification')`, wsId);
  mark('continuous-surveillance', surveillance > 0, `${surveillance} surveillance or recertification event${surveillance === 1 ? '' : 's'} planned`, `/workspaces/${wsId}/cert-cycle`);
  return result;
}

// Read-only contract boundary check for client-facing deliverable routes.
// Deliberately avoids ensurePlan/getProjection so a client request can never
// seed or repair governed plan records as a side effect of authorization.
function isDeliverableInOutcomeScope(db, ws, deliverableId) {
  if (explicitlyExcludesIso27001(ws)) return false;
  const id = Number(deliverableId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const row = db.prepare(`SELECT p.phase_key
    FROM engagement_delivery_deliverables d
    JOIN engagement_delivery_milestones m ON m.id=d.milestone_id AND m.plan_id=d.plan_id
    JOIN engagement_delivery_phases p ON p.id=m.phase_id AND p.plan_id=m.plan_id
    JOIN engagement_delivery_plans ep ON ep.id=d.plan_id AND ep.workspace_id=d.workspace_id
    WHERE d.id=? AND d.workspace_id=?`).get(id, ws.id);
  return !!row && (!isoLifecycle.isGapOnly(ws.engagement_outcome) || row.phase_key === 'gap_assessment');
}

function getProjection(db, ws, userId, { ensure = true } = {}) {
  if (explicitlyExcludesIso27001(ws)) return null;
  const plan = ensure ? ensurePlan(db, ws, userId) : db.prepare('SELECT * FROM engagement_delivery_plans WHERE workspace_id=?').get(ws.id);
  if (!plan) return null;
  const outcomeKey = isoLifecycle.normalizeOutcome(ws.engagement_outcome);
  const gapOnly = isoLifecycle.isGapOnly(outcomeKey);
  const metadata = outcomeMetadata(ws);
  const readiness = computeReadiness(ws);
  const gap = gapFieldwork.assessmentContext(db, ws);
  const verification = sourceVerification(db, ws, readiness, gap);
  const allPhases = db.prepare('SELECT * FROM engagement_delivery_phases WHERE plan_id=? ORDER BY sort_order,id').all(plan.id);
  const phases = gapOnly ? allPhases.filter(phase => phase.phase_key === 'gap_assessment') : allPhases;
  const visiblePhaseIds = new Set(phases.map(phase => phase.id));
  const allMilestones = db.prepare(`SELECT m.*,u.name owner_name FROM engagement_delivery_milestones m LEFT JOIN users u ON u.id=m.owner_id WHERE m.plan_id=? ORDER BY m.phase_id,m.planned_end_date IS NULL,m.planned_end_date,m.id`).all(plan.id);
  const milestones = allMilestones.filter(milestone => visiblePhaseIds.has(milestone.phase_id));
  const visibleMilestoneIds = new Set(milestones.map(milestone => milestone.id));
  const allDeliverables = db.prepare(`SELECT d.*,o.name owner_name,a.name approver_name,
    (SELECT COUNT(*) FROM engagement_delivery_evidence de WHERE de.deliverable_id=d.id) evidence_count,
    (SELECT COUNT(*) FROM comments c WHERE c.workspace_id=d.workspace_id AND c.parent_type='engagement_deliverable' AND c.parent_id=CAST(d.id AS TEXT)) comment_count
    FROM engagement_delivery_deliverables d LEFT JOIN users o ON o.id=d.owner_id LEFT JOIN users a ON a.id=d.approver_id WHERE d.plan_id=? ORDER BY d.id`).all(plan.id);
  const deliverables = allDeliverables.filter(deliverable => visibleMilestoneIds.has(deliverable.milestone_id));
  const allDependencies = db.prepare(`SELECT d.*,pre.title predecessor_title,post.title successor_title FROM engagement_delivery_dependencies d JOIN engagement_delivery_milestones pre ON pre.id=d.predecessor_milestone_id JOIN engagement_delivery_milestones post ON post.id=d.successor_milestone_id WHERE d.plan_id=? ORDER BY d.id`).all(plan.id);
  const dependencies = allDependencies.filter(dependency => visibleMilestoneIds.has(dependency.predecessor_milestone_id)
    && visibleMilestoneIds.has(dependency.successor_milestone_id));
  const allTasks = db.prepare(`SELECT id,title,status,due_date,assignee_id,engagement_milestone_id,engagement_deliverable_id FROM tasks WHERE workspace_id=? AND (engagement_milestone_id IS NOT NULL OR engagement_deliverable_id IS NOT NULL)`).all(ws.id);
  const visibleDeliverableIds = new Set(deliverables.map(deliverable => deliverable.id));
  const tasks = allTasks.filter(task => visibleMilestoneIds.has(task.engagement_milestone_id)
    || visibleDeliverableIds.has(task.engagement_deliverable_id));
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
    milestone.governed = GOVERNED_GAP_MILESTONES.has(milestone.milestone_key);
    const required = milestone.deliverables.filter(d => d.is_required && d.status !== 'superseded');
    const accepted = required.length > 0 && required.every(d => d.status === 'accepted');
    milestone.effective_status = isTerminal(milestone.status) || milestone.status === 'blocked'
      ? milestone.status
      : milestone.governed && milestone.verification ? 'complete'
      : accepted ? 'complete'
        : milestone.verification ? 'workspace_verified'
          : milestone.deliverables.some(d => ['submitted','changes_requested'].includes(d.status)) || milestone.tasks.some(t => t.status === 'in_progress')
            ? 'in_progress' : milestone.status;
  });
  // Second pass: mandatory dependency blocking.
  milestones.forEach(milestone => {
    const blockers = (predecessorMap[milestone.id] || []).filter(dep => dep.is_mandatory && !isTerminal(milestoneById[dep.predecessor_milestone_id]?.effective_status));
    milestone.blockers = blockers;
    milestone.predecessors = predecessorMap[milestone.id] || [];
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
  const governedGapComplete = !!gap.pass && gap.pass.status === 'completed'
    && !!gap.completed.mobilisation && !!gap.completed.fieldwork && !!gap.completed.validation
    && !!gap.completed.report;
  const governedGapDeliveryComplete = governedGapComplete && !!gap.closure.complete
    && gap.closure.blockers.length === 0;
  phases.forEach(phase => {
    phase.milestones = milestones.filter(m => m.phase_id === phase.id);
    phase.governed = phase.phase_key === 'gap_assessment';
    const required = phase.milestones.filter(m => m.is_required);
    phase.criteria = required.map(m => ({ id: m.id, label: m.title, status: m.effective_status, pass: isTerminal(m.effective_status) }));
    phase.gate_ready = required.length > 0 && phase.criteria.every(c => c.pass);
    phase.gate_decision = latestGate[phase.id];
    const gateStatus = latestGate[phase.id]?.decision === 'waived' ? 'waived'
      : latestGate[phase.id]?.decision === 'passed' ? 'complete' : null;
    const hasActivity = phase.milestones.some(m => m.verification || ['in_progress','workspace_verified','complete','waived'].includes(m.effective_status));
    const governedPhaseComplete = phase.governed && governedGapComplete && precedingGateComplete
      && required.every(milestone => isTerminal(milestone.effective_status))
      && (!gapOnly || governedGapDeliveryComplete);
    phase.governed_auto_complete = governedPhaseComplete;
    phase.effective_status = governedPhaseComplete ? 'complete' : gateStatus
      || (!precedingGateComplete ? 'not_started'
        : phase.milestones.some(m => m.status === 'blocked') ? 'blocked'
          : hasActivity ? 'in_progress' : 'not_started');
    phase.complete_count = phase.milestones.filter(m => isTerminal(m.effective_status)).length;
    phase.verified_count = phase.milestones.filter(m => m.verification && !isTerminal(m.effective_status)).length;
    phase.progress_pct = phase.milestones.length ? Math.round((phase.complete_count + phase.verified_count * 0.5) / phase.milestones.length * 100) : 0;
    precedingGateComplete = ['complete','waived'].includes(phase.effective_status);
  });

  const nonContinuous = phases.filter(p => !p.is_continuous);
  const currentPhase = nonContinuous.find(p => !['complete','waived'].includes(p.effective_status)) || null;
  const completionMilestoneIds = new Set(milestones.filter(m => !phases.find(p => p.id === m.phase_id)?.is_continuous).map(m => m.id));
  const completionMilestones = milestones.filter(m => completionMilestoneIds.has(m.id));
  const completionDeliverables = deliverables.filter(d => completionMilestoneIds.has(d.milestone_id));
  const completeMilestones = completionMilestones.filter(m => isTerminal(m.effective_status)).length;
  const verifiedMilestones = completionMilestones.filter(m => m.verification && !isTerminal(m.effective_status)).length;
  const acceptedDeliverables = completionDeliverables.filter(d => d.status === 'accepted').length;
  const requiredDeliverables = completionDeliverables.filter(d => d.is_required && d.status !== 'superseded').length;
  const openBlockers = milestones.filter(m => m.status === 'blocked').length;
  const stage1 = certificationAuditState(db, ws.id, 'stage_1');
  const stage2 = stage2AssuranceState(db, ws.id);
  const linkedEngagementId = plan.consulting_engagement_id || gap.engagement?.id || null;
  const openConsultingWorkpapers = linkedEngagementId ? Number(db.prepare(`SELECT COUNT(*) c FROM consultant_workpapers
    WHERE engagement_id=? AND status NOT IN ('frozen','superseded')`).get(linkedEngagementId).c || 0) : 0;
  const openConsultingRequests = linkedEngagementId ? Number(db.prepare(`SELECT COUNT(*) c FROM client_requests
    WHERE engagement_id=? AND status NOT IN ('accepted','cancelled')`).get(linkedEngagementId).c || 0) : 0;
  // Full delivery is accountable for every confirmed consulting finding on
  // the plan-linked engagement, including internal/non-client-visible and
  // post-conversion implementation findings.  The gap portal projection is
  // intentionally client-filtered, so it cannot be used as this completion
  // gate.
  const openConsultingFindings = linkedEngagementId ? Number(db.prepare(`SELECT COUNT(*) c FROM consulting_findings
    WHERE workspace_id=? AND engagement_id=? AND status NOT IN ('draft','withdrawn','closed')`)
    .get(ws.id, linkedEngagementId).c || 0) : 0;
  const completion = gapOnly
    ? { requiredPhases: nonContinuous, phaseGatesReady: governedGapDeliveryComplete, completionReady: governedGapDeliveryComplete }
    : certificationCompletionState(phases, readiness.stage2Ready, openBlockers, stage2, stage1);
  const consultingDeliveryClear = openConsultingFindings === 0
    && openConsultingWorkpapers === 0 && openConsultingRequests === 0;
  const completionReady = completion.completionReady && (gapOnly || consultingDeliveryClear);
  const stage1AuditBlockers = [
    ...(stage1.duplicateEvents ? [`Resolve ${stage1.duplicateEvents + 1} duplicate Stage 1 certification event records; exactly one retained event may satisfy the gate.`] : []),
    ...(stage1.invalidDateEvents ? ['Correct the invalid Stage 1 planned or actual audit date using YYYY-MM-DD.'] : []),
    ...(!stage1.auditComplete && !stage1.duplicateEvents && !stage1.invalidDateEvents
      ? ['Record a completed Stage 1 certification audit.'] : [])
  ];
  const stage2AuditBlockers = [
    ...(stage2.duplicateEvents ? [`Resolve ${stage2.duplicateEvents + 1} duplicate Stage 2 certification event records; exactly one retained event may satisfy the gate.`] : []),
    ...(stage2.invalidDateEvents ? ['Correct the invalid Stage 2 planned or actual audit date using YYYY-MM-DD.'] : []),
    ...(stage2.rawAuditComplete && !stage2.stageSequenceValid
      ? ['Stage 2 can only complete after the retained Stage 1 audit, with an actual date on or after Stage 1.'] : []),
    ...(!stage2.rawAuditComplete && !stage2.duplicateEvents && !stage2.invalidDateEvents
      ? ['Record a completed Stage 2 certification audit.'] : [])
  ];
  const completionBlockers = gapOnly
    ? (completionReady ? [] : gap.closure.ready
      ? ['Formally close the gap-assessment engagement at the controlled report.']
      : [...gap.closure.blockers])
    : [
        ...(!completion.phaseGatesReady ? ['Complete or formally waive every delivery phase through Stage 2.'] : []),
        ...(!readiness.stage2Ready ? ['Pass the Stage 2 readiness hard gates.'] : []),
        ...(openBlockers ? [`Resolve ${openBlockers} critical delivery blocker${openBlockers === 1 ? '' : 's'}.`] : []),
        ...(openConsultingWorkpapers ? [`Freeze or supersede ${openConsultingWorkpapers} open consultant workpaper${openConsultingWorkpapers === 1 ? '' : 's'}.`] : []),
        ...(openConsultingRequests ? [`Accept or cancel ${openConsultingRequests} open client RFI${openConsultingRequests === 1 ? '' : 's'}.`] : []),
        ...(openConsultingFindings ? [`Close or withdraw ${openConsultingFindings} open consulting finding${openConsultingFindings === 1 ? '' : 's'} on the linked engagement.`] : []),
        ...stage1AuditBlockers,
        ...(stage1.openFindings ? [`Close ${stage1.openFindings} Stage 1 finding${stage1.openFindings === 1 ? '' : 's'}, including observations.`] : []),
        ...stage2AuditBlockers,
        ...(stage2.openFindings ? [`Close ${stage2.openFindings} Stage 2 finding${stage2.openFindings === 1 ? '' : 's'}, including observations.`] : [])
      ];
  const dates = completionMilestones.map(m => m.forecast_end_date || m.planned_end_date).filter(Boolean).sort();
  const forecast = gapOnly
    ? ([dates[dates.length - 1], plan.target_completion_date].filter(Boolean).sort().pop() || null)
    : ([plan.forecast_completion_date, dates[dates.length - 1], plan.target_completion_date].filter(Boolean).sort().pop() || null);
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
    outcome: {
      key: outcomeKey,
      label: isoLifecycle.label(outcomeKey),
      gapOnly,
      subtitle: metadata.subtitle
    },
    currentPhase, baseline,
    summary: {
      totalMilestones: completionMilestones.length, completeMilestones, verifiedMilestones,
      acceptedDeliverables, requiredDeliverables, openBlockers,
      progressPct: completionMilestones.length ? Math.round((completeMilestones + verifiedMilestones * 0.5) / completionMilestones.length * 100) : 0,
      varianceDays, completionReady, completionBlockers,
      reportPublished: !!gap.completed.report,
      gapClosureReady: !!gap.closure.ready,
      gapClosureComplete: governedGapDeliveryComplete,
      gapClosureBlockers: [...gap.closure.blockers],
      openConsultingFindings,
      openConsultingWorkpapers,
      openConsultingRequests,
      readinessReady: !!readiness.stage2Ready,
      stage1AuditComplete: stage1.auditComplete,
      stage1EventCount: stage1.eventCount,
      stage1DuplicateEvents: stage1.duplicateEvents,
      stage1InvalidDateEvents: stage1.invalidDateEvents,
      stage1InvalidClosedDates: stage1.invalidClosedDates,
      openStage1Findings: stage1.openFindings,
      openStage1MaterialFindings: stage1.openMaterialFindings,
      openStage1Observations: stage1.openObservations,
      stage2AuditComplete: stage2.auditComplete,
      stage2RawAuditComplete: stage2.rawAuditComplete,
      stage2SequenceValid: stage2.stageSequenceValid,
      stage2EventCount: stage2.eventCount,
      stage2DuplicateEvents: stage2.duplicateEvents,
      stage2InvalidDateEvents: stage2.invalidDateEvents,
      stage2InvalidClosedDates: stage2.invalidClosedDates,
      openStage2Findings: stage2.openFindings,
      openStage2MaterialFindings: stage2.openMaterialFindings,
      openStage2Observations: stage2.openObservations,
      stage2FindingCount: stage2.totalFindings,
      phaseGatesPassed: nonContinuous.filter(p => ['complete','waived'].includes(p.effective_status)).length,
      phaseGatesTotal: nonContinuous.length
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
  if (action === 'changes') {
    reconcileCompletionState(db, ws, userId, {
      reason: 'An accepted delivery item was reopened for changes.',
      details: { deliverable_id: row.id, milestone_id: row.milestone_id }
    });
  }
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
  const nextId = tx();
  reconcileCompletionState(db, ws, userId, {
    reason: 'A delivery item entered a new revision cycle.',
    details: { deliverable_id: row.id, replacement_deliverable_id: nextId, milestone_id: row.milestone_id }
  });
  return nextId;
}

function decideGate(db, ws, userId, phaseId, decision, note, waiverExpiresAt) {
  const projection = getProjection(db, ws, userId);
  const phase = projection.phases.find(p => p.id === Number(phaseId));
  if (!phase) throw new Error('Phase not found.');
  if (phase.governed) {
    throw new Error('The gap-assessment gate is controlled by the assessment pass, formal phase decisions and independently published report; it cannot be manually passed or waived here.');
  }
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
  const decisionId = tx();
  if (decision === 'reopened') {
    reconcileCompletionState(db, ws, userId, {
      reason: 'A delivery phase gate was reopened.',
      details: { phase_id: phase.id, gate_decision_id: decisionId }
    });
  }
  // The last governed gate can be the final outstanding condition after the
  // Stage 2 audit and remediation have already closed. Keep the plan and its
  // linked consulting engagement synchronized immediately instead of asking
  // a manager to discover and repeat a separate completion action.
  syncOutcomePlanStatus(db, ws, userId);
  syncCertificationEngagementCompletion(db, ws, userId);
  return decisionId;
}

function addDependency(db, ws, userId, predecessorId, successorId, type, lagDays) {
  const projection = getProjection(db, ws, userId);
  const plan = projection.plan;
  const contractedIds = new Set(projection.milestones.map(milestone => Number(milestone.id)));
  const rows = db.prepare(`SELECT id FROM engagement_delivery_milestones WHERE plan_id=? AND id IN (?,?)`).all(plan.id, predecessorId, successorId)
    .filter(row => contractedIds.has(Number(row.id)));
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

function enforceMinimumDurations(db, planId) {
  const constrained = db.prepare(`SELECT id,planned_start_date,planned_end_date,forecast_end_date,minimum_duration_months
    FROM engagement_delivery_milestones
    WHERE plan_id=? AND minimum_duration_months>0 AND planned_start_date IS NOT NULL`).all(planId);
  const update = db.prepare(`UPDATE engagement_delivery_milestones
    SET planned_end_date=?,forecast_end_date=?,updated_at=datetime('now'),row_version=row_version+1
    WHERE id=? AND plan_id=?`);
  let changed = 0;
  constrained.forEach(milestone => {
    const minimumEnd = addMonths(milestone.planned_start_date, milestone.minimum_duration_months);
    const plannedEnd = laterDate(milestone.planned_end_date, minimumEnd);
    const forecastEnd = laterDate(milestone.forecast_end_date, plannedEnd);
    if (plannedEnd !== milestone.planned_end_date || forecastEnd !== milestone.forecast_end_date) {
      update.run(plannedEnd, forecastEnd, milestone.id, planId);
      changed += 1;
    }
  });
  return changed;
}

function recalculatePlanSchedule(db, ws, userId, plan, triggerType = 'manual', initialChanged = 0) {
  const minimumChanges = enforceMinimumDurations(db, plan.id);
  const milestones = db.prepare(`SELECT m.*,ph.is_continuous FROM engagement_delivery_milestones m
    JOIN engagement_delivery_phases ph ON ph.id=m.phase_id WHERE m.plan_id=? ORDER BY m.id`).all(plan.id);
  const dependencies = db.prepare(`SELECT * FROM engagement_delivery_dependencies WHERE plan_id=? ORDER BY id`).all(plan.id);
  const byId = Object.fromEntries(milestones.map(m => [m.id, m]));
  const outgoing = {};
  const indegree = Object.fromEntries(milestones.map(m => [m.id, 0]));
  dependencies.forEach(dep => {
    (outgoing[dep.predecessor_milestone_id] ||= []).push(dep);
    indegree[dep.successor_milestone_id] = (indegree[dep.successor_milestone_id] || 0) + 1;
  });
  const queue = milestones.filter(m => indegree[m.id] === 0).map(m => m.id);
  let changed = initialChanged + minimumChanges;
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
        if (!newStart || newStart < floor) {
          newStart = floor;
          newEnd = successor.is_continuous ? null : addDays(newStart, duration);
          newForecast = successor.is_continuous ? null : addDays(newStart, Math.max(duration, daysBetween(oldStart, oldForecast) || duration));
        }
      } else if (dep.dependency_type === 'finish_to_finish' && (predecessor.forecast_end_date || predecessor.planned_end_date)) {
        const floor = addDays(predecessor.forecast_end_date || predecessor.planned_end_date, lag);
        if (!newForecast || newForecast < floor) { newForecast = floor; newEnd = !newEnd || newEnd < floor ? floor : newEnd; newStart = newStart || addDays(newEnd, -duration); }
      } else if (predecessor.is_continuous && predecessor.planned_start_date) {
        const floor = addDays(predecessor.planned_start_date, lag);
        if (!newStart || newStart < floor) {
          newStart = floor;
          newEnd = successor.is_continuous ? null : addDays(newStart, duration);
          newForecast = successor.is_continuous ? null : addDays(newStart, Math.max(duration, daysBetween(oldStart, oldForecast) || duration));
        }
      } else if (predecessor.forecast_end_date || predecessor.planned_end_date) {
        const floor = addDays(predecessor.forecast_end_date || predecessor.planned_end_date, lag);
        if (!newStart || newStart < floor) {
          newStart = floor;
          newEnd = successor.is_continuous ? null : addDays(newStart, duration);
          newForecast = successor.is_continuous ? null : addDays(newStart, Math.max(duration, daysBetween(oldStart, oldForecast) || duration));
        }
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

function recalculateSchedule(db, ws, userId, triggerType = 'manual') {
  const plan = ensurePlan(db, ws, userId, { repairSchedule: false });
  return recalculatePlanSchedule(db, ws, userId, plan, triggerType);
}

function fitScheduleToTarget(db, ws, userId) {
  const plan = ensurePlan(db, ws, userId, { repairSchedule: false });
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
  const span = daysBetween(plan.target_start_date, plan.target_completion_date);
  if (span == null || span < 1) throw new Error('Target completion must be after the target start date.');
  const byId = Object.fromEntries(active.map(milestone => [milestone.id, milestone]));
  const ordered = order.map(id => byId[id]);
  const constrainedEstimate = ordered.reduce((sum, milestone) => sum + (milestone.minimum_duration_months
    ? daysBetween(plan.target_start_date, addMonths(plan.target_start_date, milestone.minimum_duration_months)) : 0), 0);
  const flexible = ordered.filter(milestone => !milestone.minimum_duration_months);
  const baseFlexible = flexible.length;
  const availableExtra = Math.max(0, span - constrainedEstimate - baseFlexible);
  const totalWeight = flexible.reduce((sum, milestone) => sum + Math.max(1, daysBetween(milestone.planned_start_date, milestone.planned_end_date) || 1), 0) || 1;
  const allocations = new Map();
  let allocatedExtra = 0;
  flexible.forEach((milestone, index) => {
    const weight = Math.max(1, daysBetween(milestone.planned_start_date, milestone.planned_end_date) || 1);
    const extra = index === flexible.length - 1 ? availableExtra - allocatedExtra : Math.floor(availableExtra * weight / totalWeight);
    allocations.set(milestone.id, 1 + Math.max(0, extra));
    allocatedExtra += Math.max(0, extra);
  });
  const buildDates = () => {
    let cursor = plan.target_start_date;
    const dates = new Map();
    ordered.forEach(milestone => {
      const start = cursor;
      const end = milestone.minimum_duration_months
        ? addMonths(start, milestone.minimum_duration_months)
        : addDays(start, allocations.get(milestone.id) || 1);
      dates.set(milestone.id, { start, end });
      cursor = end;
    });
    return { dates, finish: cursor };
  };
  let fitted = buildDates();
  // Calendar months vary in length. Absorb that small difference into flexible
  // work so a feasible target remains exact without shortening a governed
  // operating period.
  for (let attempt = 0; attempt < 4 && fitted.finish !== plan.target_completion_date && flexible.length; attempt += 1) {
    let adjustment = daysBetween(fitted.finish, plan.target_completion_date);
    for (let index = flexible.length - 1; index >= 0 && adjustment !== 0; index -= 1) {
      const id = flexible[index].id;
      const current = allocations.get(id) || 1;
      const next = Math.max(1, current + adjustment);
      adjustment -= next - current;
      allocations.set(id, next);
    }
    fitted = buildDates();
  }
  const update = db.prepare(`UPDATE engagement_delivery_milestones SET planned_start_date=?,planned_end_date=?,forecast_end_date=?,updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND plan_id=?`);
  db.transaction(() => {
    order.forEach(id => {
      const dates = fitted.dates.get(id);
      update.run(dates.start, dates.end, dates.end, id, plan.id);
    });
    milestones.filter(m => m.is_continuous).forEach(m => update.run(fitted.finish, null, null, m.id, plan.id));
  })();
  const result = recalculatePlanSchedule(db, ws, userId, plan, 'fit_to_target');
  event(db, ws.id, plan.id, userId, 'schedule', null, 'fit_to_target', plan.forecast_completion_date, result.forecastAfter,
    { milestones: active.length, minimum_duration_months: ordered.filter(m => m.minimum_duration_months).reduce((sum,m) => sum + m.minimum_duration_months,0) });
  return result;
}

// Keep the commercial engagement and the adaptive plan aligned with the
// workspace's ISO 27001 certification target. This is deliberately a narrow
// write-through boundary used by onboarding, workspace settings and intake;
// otherwise the same date can drift across three independently editable rows.
function syncCertificationTarget(db, ws, userId) {
  let frameworks = ws.frameworks || [];
  if (!Array.isArray(frameworks)) {
    try { frameworks = JSON.parse(frameworks || '[]'); } catch (_) { frameworks = []; }
  }
  if (!frameworks.includes('iso27001')) {
    return { applicable: false, engagementChanges: 0, planChanges: 0, planId: null, targetDate: null };
  }

  const targetDate = isoLifecycle.isGapOnly(ws.engagement_outcome) ? null : (ws.target_cert_date || null);
  const engagementChanges = db.prepare(`UPDATE consulting_engagements
    SET target_date=?,updated_at=datetime('now'),row_version=row_version+1
    WHERE workspace_id=? AND engagement_type IN ('implementation','readiness','advisory')
      AND status NOT IN ('complete','cancelled') AND COALESCE(target_date,'')<>COALESCE(?,'')`)
    .run(targetDate, ws.id, targetDate).changes;
  const plan = ensurePlan(db, ws, userId);
  // Workspace settings and intake are the authoritative certification target
  // boundary. At this boundary both plan dates move together; subsequent
  // schedule recalculation may produce a new delivery forecast deliberately.
  const forecastDate = targetDate;
  const planChanges = db.prepare(`UPDATE engagement_delivery_plans
    SET target_completion_date=?,forecast_completion_date=?,updated_at=datetime('now')
    WHERE id=? AND workspace_id=?
      AND (COALESCE(target_completion_date,'')<>COALESCE(?,'')
        OR COALESCE(forecast_completion_date,'')<>COALESCE(?,''))`)
    .run(targetDate, forecastDate, plan.id, ws.id, targetDate, forecastDate).changes;
  if (engagementChanges || planChanges) {
    event(db, ws.id, plan.id, userId, 'plan', plan.id, 'certification_target_synchronized',
      plan.target_completion_date, targetDate, { engagement_changes: engagementChanges });
  }
  return { applicable: true, engagementChanges, planChanges, planId: plan.id, targetDate, forecastDate };
}

module.exports = {
  PHASES, ensurePlan, getProjection, createBaseline, transitionDeliverable, reviseDeliverable,
  decideGate, addDependency, recalculateSchedule, fitScheduleToTarget, deliverableEvidenceSnapshot, event,
  daysBetween, addMonths, enforceMinimumDurations, repairGapAssessmentJourney, repairStage2Journey,
  explicitlyExcludesIso27001, isDeliverableInOutcomeScope,
  isValidISODate, validateCertificationEvent, certificationAuditState, stage2AssuranceState, certificationCompletionState,
  syncOutcomePlanStatus, syncCertificationEngagementCompletion,
  certificationEventForSourceRef, certificationFindingLineage, reconcileCompletionState,
  reopenForCertificationFinding, reopenForStage2Finding, reopenForConsultingEngagement, syncCertificationTarget
};
