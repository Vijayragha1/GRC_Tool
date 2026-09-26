'use strict';

const crypto = require('crypto');
const delivery = require('./engagement-delivery');
const enc = require('./encryption');
const isoLifecycle = require('./iso-lifecycle');
const rbac = require('./rbac');
const notificationDelivery = require('./notification-delivery');

const WORKPAPER_STATUSES = new Set(['draft','manager_review','changes_requested','client_validation','approved','frozen','superseded']);
const MANAGEMENT_CLAIMS = new Set(['not_provided','implemented','partially_implemented','not_implemented','not_applicable']);
const DESIGN_CONCLUSIONS = new Set(['not_assessed','suitable','partially_suitable','unsuitable','not_applicable']);
const IMPLEMENTATION_CONCLUSIONS = new Set(['not_assessed','implemented','partially_implemented','not_implemented','not_applicable']);
const EFFECTIVENESS_CONCLUSIONS = new Set(['not_tested','effective','partially_effective','ineffective','not_applicable']);
const EVIDENCE_SUFFICIENCY = new Set(['not_assessed','insufficient','partially_sufficient','sufficient']);

function sha(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function clean(value, max = 20000) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max) throw new Error(`Text exceeds the ${max.toLocaleString()} character limit.`);
  return text || null;
}

function validDate(value) {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new Error('Enter a valid date.');
  return text;
}

function event(db, wsId, engagementId, actorId, entityType, entityId, action, details) {
  return Number(db.prepare(`INSERT INTO consulting_events
    (workspace_id,engagement_id,entity_type,entity_id,action,details_json,actor_id)
    VALUES (?,?,?,?,?,?,?)`).run(wsId, engagementId || null, entityType, entityId || null, action,
      details ? JSON.stringify(details) : null, actorId).lastInsertRowid);
}

function frameworkScope(ws) {
  let codes = ws.frameworks || [];
  if (!Array.isArray(codes)) { try { codes = JSON.parse(codes || '[]'); } catch (_) { codes = []; } }
  return [...new Set(codes.map(String))];
}

function ensureMethodology(db, firmId, userId) {
  let row = db.prepare(`SELECT * FROM firm_methodologies WHERE firm_id=? AND code='consulting-assurance'`).get(firmId);
  if (row) return row;
  const content = {
    name: 'Consulting assurance methodology',
    workpaper_required_fields: ['objective','procedure_performed','conclusion_rationale'],
    conclusions: ['management_claim','design','implementation','operating_effectiveness'],
    review_sequence: ['consultant_submission','manager_review','client_validation_if_required','approval','freeze'],
    evidence_rules: ['relevance','period','sufficiency','reviewer_conclusion'],
    segregation_of_duties: true
  };
  const tx = db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO firm_methodologies
      (firm_id,code,name,framework_code,status,current_version,created_by)
      VALUES (?,'consulting-assurance','Consulting assurance methodology',NULL,'active',1,?)`).run(firmId,userId).lastInsertRowid);
    const json = JSON.stringify(content);
    db.prepare(`INSERT INTO firm_methodology_versions
      (methodology_id,version_number,content_json,change_summary,snapshot_hash,approved_by)
      VALUES (?,1,?,'Initial governed methodology',?,?)`).run(id,json,sha(json),userId);
    return id;
  });
  row = db.prepare('SELECT * FROM firm_methodologies WHERE id=?').get(tx());
  return row;
}

function ensureEngagement(db, ws, userId) {
  let engagement = db.prepare(`SELECT * FROM consulting_engagements WHERE workspace_id=?
    AND status NOT IN ('complete','cancelled') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,id LIMIT 1`).get(ws.id);
  if (engagement) return engagement;
  const prefix = `ENG-${String(ws.id).padStart(4,'0')}`;
  const frameworks = frameworkScope(ws);
  const hasIso27001 = frameworks.includes('iso27001');
  const engagementType = hasIso27001
    ? isoLifecycle.consultingEngagementType(ws.engagement_outcome)
    : 'implementation';
  const gapOnly = hasIso27001 && isoLifecycle.isGapOnly(ws.engagement_outcome);
  const engagementName = hasIso27001
    ? gapOnly
      ? `${ws.client_name} ISO 27001 gap assessment`
      : `${ws.client_name} ISO 27001 certification support`
    : `${ws.client_name} consulting engagement`;
  const tx = db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO consulting_engagements
      (workspace_id,engagement_code,name,engagement_type,framework_scope_json,scope_statement,status,
       lead_consultant_id,start_date,target_date,created_by)
      VALUES (?,?,?,?,?,?,'active',?,?,?,?)`).run(ws.id,prefix,
        engagementName,engagementType,JSON.stringify(frameworks),ws.scope || null,
        ws.lead_consultant_id || userId,String(ws.created_at || new Date().toISOString()).slice(0,10),gapOnly ? null : (ws.target_cert_date || null),userId).lastInsertRowid);
    db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team
      (engagement_id,user_id,role,assigned_by) VALUES (?,?,'engagement_lead',?)`).run(id,ws.lead_consultant_id || userId,userId);
    db.prepare(`INSERT INTO engagement_commercials (engagement_id,updated_by) VALUES (?,?)`).run(id,userId);
    event(db,ws.id,id,userId,'engagement',id,'created',{
      frameworks,
      seeded: true,
      engagement_outcome: hasIso27001 ? isoLifecycle.normalizeOutcome(ws.engagement_outcome) : null
    });
    return id;
  });
  engagement = db.prepare('SELECT * FROM consulting_engagements WHERE id=?').get(tx());
  ensureMethodology(db,ws.firm_id,userId);
  if (hasIso27001) {
    const plan = delivery.ensurePlan(db,ws,userId);
    if (!plan.consulting_engagement_id) db.prepare(`UPDATE engagement_delivery_plans SET consulting_engagement_id=? WHERE id=?`).run(engagement.id,plan.id);
  }
  return engagement;
}

function engagementFor(db, ws, userId, id) {
  if (!id) return ensureEngagement(db,ws,userId);
  const row = db.prepare('SELECT * FROM consulting_engagements WHERE id=? AND workspace_id=?').get(Number(id),ws.id);
  if (!row) throw new Error('Engagement not found.');
  return row;
}

function workspaceUser(db, ws, userId) {
  if(!userId)return null;
  const user=db.prepare('SELECT id,name,email,user_type,firm_role FROM users WHERE id=? AND active=1').get(Number(userId));
  if(!user)return null;
  const context=require('./client-work-policy').actorContext(db,ws,user);
  return context.active?{...user,role:context.role,can_prepare:context.firm&&rbac.hasPermission(context.permissions,'control.update')}:null;
}

function eligibleReviewers(db, ws, excluded = []) {
  const excludedIds=new Set(excluded.map(Number));
  return db.prepare("SELECT id,name,email,user_type,firm_role FROM users WHERE active=1 AND user_type='firm' AND firm_id=? ORDER BY name").all(ws.firm_id)
    .filter(user=>{
      const context=require('./client-work-policy').actorContext(db,ws,user);
      return !excludedIds.has(user.id)&&context.active&&context.firm&&rbac.hasPermission(context.permissions,'document.review');
    });
}

function syncEngagementRoster(db, ws, engagement, actorId) {
  const lead = engagement.lead_consultant_id && workspaceUser(db,ws,Number(engagement.lead_consultant_id));
  const reviewer = engagement.quality_reviewer_id && eligibleReviewers(db,ws,[engagement.lead_consultant_id]).find(u=>u.id===Number(engagement.quality_reviewer_id));
  if (engagement.lead_consultant_id && (!lead || lead.user_type!=='firm')) throw new Error('Choose an active firm consultant as engagement lead.');
  if (engagement.quality_reviewer_id && !reviewer) throw new Error('Choose an eligible quality reviewer independent of the engagement lead.');
  db.transaction(()=>{
    const existing=db.prepare(`SELECT * FROM consulting_engagement_team WHERE engagement_id=? AND role IN ('engagement_lead','quality_reviewer')`).all(engagement.id);
    db.prepare(`DELETE FROM consulting_engagement_team WHERE engagement_id=? AND role IN ('engagement_lead','quality_reviewer')`).run(engagement.id);
    for (const [role,userId] of [['engagement_lead',engagement.lead_consultant_id],['quality_reviewer',engagement.quality_reviewer_id]]) {
      const previous=existing.find(row=>row.role===role&&Number(row.user_id)===Number(userId));
      if (userId) db.prepare(`INSERT INTO consulting_engagement_team (engagement_id,user_id,role,planned_hours,assigned_by) VALUES (?,?,?,?,?)`).run(engagement.id,userId,role,previous?.planned_hours||0,actorId);
    }
  })();
}

function requirementCatalog(db, engagement) {
  const codes = JSON.parse(engagement.framework_scope_json || '[]');
  if (!codes.length) return [];
  return db.prepare(`SELECT r.id,r.ref,r.title,r.req_type,f.code framework_code,f.name framework_name,f.version
    FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code IN (${codes.map(()=>'?').join(',')}) AND f.status!='retired'
    ORDER BY f.code,r.sort_order,r.ref`).all(...codes);
}

function validateWorkpaperInput(body) {
  const values = {
    title: clean(body.title,300), objective: clean(body.objective), procedure_performed: clean(body.procedure_performed),
    persons_interviewed: clean(body.persons_interviewed,4000), testing_period_start: validDate(body.testing_period_start),
    testing_period_end: validDate(body.testing_period_end), population_description: clean(body.population_description,5000),
    population_size: body.population_size === '' || body.population_size == null ? null : Number(body.population_size),
    sample_method: clean(body.sample_method,2000), sample_size: body.sample_size === '' || body.sample_size == null ? null : Number(body.sample_size),
    exceptions_count: body.exceptions_count === '' || body.exceptions_count == null ? 0 : Number(body.exceptions_count),
    exception_summary: clean(body.exception_summary,10000), conclusion_rationale: clean(body.conclusion_rationale),
    internal_notes: clean(body.internal_notes), client_visible_summary: clean(body.client_visible_summary),
    due_date: validDate(body.due_date), management_claim: String(body.management_claim || 'not_provided'),
    design_conclusion: String(body.design_conclusion || 'not_assessed'),
    implementation_conclusion: String(body.implementation_conclusion || 'not_assessed'),
    operating_effectiveness: String(body.operating_effectiveness || 'not_tested'),
    evidence_sufficiency: String(body.evidence_sufficiency || 'not_assessed'),
    client_visible: body.client_visible === '1' ? 1 : 0,
    requires_client_validation: body.requires_client_validation === '1' ? 1 : 0
  };
  if (!values.title) throw new Error('Workpaper title is required.');
  if (!MANAGEMENT_CLAIMS.has(values.management_claim) || !DESIGN_CONCLUSIONS.has(values.design_conclusion) ||
      !IMPLEMENTATION_CONCLUSIONS.has(values.implementation_conclusion) || !EFFECTIVENESS_CONCLUSIONS.has(values.operating_effectiveness) ||
      !EVIDENCE_SUFFICIENCY.has(values.evidence_sufficiency)) throw new Error('Choose valid assessment conclusions.');
  for (const field of ['population_size','sample_size','exceptions_count']) {
    if (values[field] != null && (!Number.isInteger(values[field]) || values[field] < 0)) throw new Error(`${field.replaceAll('_',' ')} must be a non-negative whole number.`);
  }
  if (values.testing_period_start && values.testing_period_end && values.testing_period_start > values.testing_period_end) throw new Error('Testing period end must be after its start.');
  if (values.sample_size != null && values.population_size != null && values.sample_size > values.population_size) throw new Error('Sample size cannot exceed the population.');
  if (values.exceptions_count > (values.sample_size || 0) && values.sample_size != null) throw new Error('Exceptions cannot exceed the sample size.');
  return values;
}

function saveWorkpaper(db, ws, engagement, userId, body, workpaperId) {
  const input = validateWorkpaperInput(body);
  const storedInternalNotes = enc.encryptIfNeeded(input.internal_notes,ws.id,!!ws.encryption_enabled);
  const ownerId = Number(body.owner_id || userId);
  const reviewerId = body.reviewer_id ? Number(body.reviewer_id) : null;
  const validatorId = body.client_validator_id ? Number(body.client_validator_id) : null;
  const owner=workspaceUser(db,ws,ownerId);
  if(owner?.user_type!=='firm'||!owner.can_prepare)throw new Error('Choose an active firm consultant with assessment-edit access as workpaper owner.');
  const currentPreparer = workpaperId ? db.prepare('SELECT prepared_by FROM consultant_workpapers WHERE id=? AND workspace_id=?').get(Number(workpaperId),ws.id)?.prepared_by : null;
  if (reviewerId && !eligibleReviewers(db,ws,[ownerId,currentPreparer || ownerId]).some(u=>u.id===reviewerId)) throw new Error('Choose an eligible independent reviewer; the owner and preparer cannot review this workpaper.');
  if (validatorId) {
    const validator = workspaceUser(db,ws,validatorId);
    if (!validator || validator.user_type !== 'client') throw new Error('Client validator must be an active client member.');
  }
  if (workpaperId) {
    const current = db.prepare('SELECT * FROM consultant_workpapers WHERE id=? AND workspace_id=? AND engagement_id=?').get(Number(workpaperId),ws.id,engagement.id);
    if (!current) throw new Error('Workpaper not found.');
    if (!['draft','changes_requested'].includes(current.status)) throw new Error('Only draft or changes-requested workpapers can be edited.');
    const version = Number(body.expected_record_version ?? body.row_version);
    const result = db.prepare(`UPDATE consultant_workpapers SET title=?,objective=?,procedure_performed=?,persons_interviewed=?,
      testing_period_start=?,testing_period_end=?,population_description=?,population_size=?,sample_method=?,sample_size=?,
      exceptions_count=?,exception_summary=?,management_claim=?,design_conclusion=?,implementation_conclusion=?,operating_effectiveness=?,
      evidence_sufficiency=?,conclusion_rationale=?,internal_notes=?,client_visible_summary=?,client_visible=?,requires_client_validation=?,
      owner_id=?,reviewer_id=?,client_validator_id=?,due_date=?,updated_at=datetime('now'),row_version=row_version+1
      WHERE id=? AND workspace_id=? AND row_version=?`).run(input.title,input.objective,input.procedure_performed,input.persons_interviewed,
        input.testing_period_start,input.testing_period_end,input.population_description,input.population_size,input.sample_method,input.sample_size,
        input.exceptions_count,input.exception_summary,input.management_claim,input.design_conclusion,input.implementation_conclusion,input.operating_effectiveness,
        input.evidence_sufficiency,input.conclusion_rationale,storedInternalNotes,input.client_visible_summary,input.client_visible,input.requires_client_validation,
        ownerId,reviewerId,validatorId,input.due_date,current.id,ws.id,version);
    if (!result.changes) throw Object.assign(new Error('The workpaper changed in another session. Compare the latest saved version before saving your changes.'),{status:409});
    event(db,ws.id,engagement.id,userId,'workpaper',current.id,'updated',{ row_version: version + 1 });
    return current.id;
  }
  const requirementId = Number(body.requirement_id);
  const requirement = db.prepare(`SELECT r.*,f.code framework_code FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE r.id=?`).get(requirementId);
  if (!requirement || !JSON.parse(engagement.framework_scope_json || '[]').includes(requirement.framework_code)) throw new Error('Choose a requirement within this engagement scope.');
  if(db.prepare('SELECT id FROM consultant_workpapers WHERE engagement_id=? AND requirement_id=?').get(engagement.id,requirementId)) throw new Error('A workpaper already exists for this requirement. Open it from the workpaper register.');
  const count = db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM consultant_workpapers').get().n;
  const ref = `${engagement.engagement_code}-WP-${String(count).padStart(4,'0')}`;
  const id = Number(db.prepare(`INSERT INTO consultant_workpapers
    (workspace_id,engagement_id,requirement_id,client_control_id,workpaper_ref,title,objective,procedure_performed,persons_interviewed,
     testing_period_start,testing_period_end,population_description,population_size,sample_method,sample_size,exceptions_count,exception_summary,
     management_claim,design_conclusion,implementation_conclusion,operating_effectiveness,evidence_sufficiency,conclusion_rationale,internal_notes,
     client_visible_summary,client_visible,requires_client_validation,owner_id,reviewer_id,client_validator_id,due_date,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ws.id,engagement.id,requirementId,body.client_control_id || null,
      ref,input.title,input.objective,input.procedure_performed,input.persons_interviewed,input.testing_period_start,input.testing_period_end,
      input.population_description,input.population_size,input.sample_method,input.sample_size,input.exceptions_count,input.exception_summary,
      input.management_claim,input.design_conclusion,input.implementation_conclusion,input.operating_effectiveness,input.evidence_sufficiency,
      input.conclusion_rationale,storedInternalNotes,input.client_visible_summary,input.client_visible,input.requires_client_validation,
      ownerId,reviewerId,validatorId,input.due_date,userId).lastInsertRowid);
  event(db,ws.id,engagement.id,userId,'workpaper',id,'created',{ requirement_id: requirementId, ref });
  return id;
}

function workpaperDetail(db, ws, id) {
  const row = db.prepare(`SELECT w.*,r.ref requirement_ref,r.title requirement_title,r.req_type,f.code framework_code,f.name framework_name,
    o.name owner_name,rv.name reviewer_name,cv.name client_validator_name,p.name prepared_by_name,a.name approved_by_name,c.control_code,c.title control_title
    FROM consultant_workpapers w JOIN requirements r ON r.id=w.requirement_id JOIN frameworks f ON f.id=r.framework_id
    LEFT JOIN users o ON o.id=w.owner_id LEFT JOIN users rv ON rv.id=w.reviewer_id LEFT JOIN users cv ON cv.id=w.client_validator_id
    LEFT JOIN users p ON p.id=w.prepared_by LEFT JOIN users a ON a.id=w.approved_by LEFT JOIN client_controls c ON c.id=w.client_control_id
    WHERE w.id=? AND w.workspace_id=?`).get(Number(id),ws.id);
  if (!row) throw new Error('Workpaper not found.');
  row.internal_notes = enc.decryptIfNeeded(row.internal_notes,ws.id);
  return row;
}

function evidenceSnapshot(db, workpaper) {
  return db.prepare(`SELECT e.id,e.filename,e.sha256,e.uploaded_at,we.purpose,we.relevance,we.period_covered_start,we.period_covered_end
    FROM consultant_workpaper_evidence we JOIN evidence e ON e.id=we.evidence_id
    WHERE we.workpaper_id=? AND e.workspace_id=? ORDER BY we.id`).all(workpaper.id,workpaper.workspace_id);
}

function assessmentConclusion(status) {
  const value = String(status || 'Not Assessed');
  if (value === 'Implemented') return {
    management_claim: 'implemented', design_conclusion: 'suitable',
    implementation_conclusion: 'implemented', evidence_sufficiency: 'sufficient'
  };
  if (value === 'Partially Implemented' || value === 'Work In Progress') return {
    management_claim: 'partially_implemented', design_conclusion: 'partially_suitable',
    implementation_conclusion: 'partially_implemented', evidence_sufficiency: 'partially_sufficient'
  };
  if (value === 'Not Implemented') return {
    management_claim: 'not_implemented', design_conclusion: 'unsuitable',
    implementation_conclusion: 'not_implemented', evidence_sufficiency: 'insufficient'
  };
  if (value === 'Not Applicable') return {
    management_claim: 'not_applicable', design_conclusion: 'not_applicable',
    implementation_conclusion: 'not_applicable', evidence_sufficiency: 'not_assessed'
  };
  return {
    management_claim: 'not_provided', design_conclusion: 'not_assessed',
    implementation_conclusion: 'not_assessed', evidence_sufficiency: 'not_assessed'
  };
}

/** Freeze a pass-specific version without replacing an existing manual working copy. */
function materializeAssessmentPass(db, ws, pass, reviewerId) {
  return db.transaction(() => {
    const storedPass = db.prepare('SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?').get(pass?.id,ws.id);
    if (!storedPass || storedPass.status !== 'in_progress') throw new Error('Only an active assessment pass can be materialized.');
    if (Number(storedPass.started_by) === Number(reviewerId)) throw new Error('Assessment workpapers require an independent reviewer.');
    const reviewer = workspaceUser(db,ws,reviewerId);
    if (!reviewer || reviewer.user_type!=='firm' || !rbac.hasPermission(require('./client-work-policy').actorContext(db,ws,reviewer).permissions,'assessment.signoff')) throw new Error('An eligible independent sign-off holder is required.');
    const prior = db.prepare('SELECT * FROM assessment_pass_manifests WHERE assessment_pass_id=? ORDER BY completion_generation DESC LIMIT 1').get(storedPass.id);
    let engagement = prior ? engagementFor(db,ws,reviewerId,prior.engagement_id) : ensureEngagement(db,ws,storedPass.started_by);
    if (['complete','cancelled'].includes(engagement.status)) throw new Error('Start a new governed engagement before changing a closed engagement.');
    if(!engagement.quality_reviewer_id) {
      db.prepare(`UPDATE consulting_engagements SET quality_reviewer_id=?,updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND workspace_id=?`).run(reviewerId,engagement.id,ws.id);
      engagement=engagementFor(db,ws,reviewerId,engagement.id);
      syncEngagementRoster(db,ws,engagement,reviewerId);
    }
    db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team (engagement_id,user_id,role,assigned_by) VALUES (?,?,'consultant',?)`).run(engagement.id,storedPass.started_by,reviewerId);
    const generation = prior ? prior.completion_generation + 1 : 1;
    const rows = db.prepare(`SELECT h.*,r.id requirement_id,r.ref requirement_ref,r.title requirement_title
      FROM control_state_history h JOIN assessment_passes hp ON hp.id=h.pass_id
      JOIN requirements r ON r.ref=h.iso_item_id JOIN frameworks f ON f.id=r.framework_id AND f.code='iso27001' AND f.status!='retired'
      WHERE h.workspace_id=? AND hp.workspace_id=? AND hp.pass_number<=? AND h.id=(
        SELECT h2.id FROM control_state_history h2 JOIN assessment_passes p2 ON p2.id=h2.pass_id
        WHERE h2.workspace_id=h.workspace_id AND p2.workspace_id=h.workspace_id AND h2.iso_item_id=h.iso_item_id AND p2.pass_number<=?
        ORDER BY p2.pass_number DESC,h2.id DESC LIMIT 1)
      ORDER BY r.sort_order,r.id`).all(ws.id,ws.id,storedPass.pass_number,storedPass.pass_number);
    if (!rows.length) throw new Error('No assessment conclusions were found for this pass.');
    const capturedAt = new Date().toISOString();
    const items = [];
    let created = 0;
    const evidenceFor = db.prepare(`SELECT DISTINCT e.id,e.filename,e.sha256,e.uploaded_at,e.valid_until
      FROM evidence e LEFT JOIN evidence_requirement_links erl ON erl.evidence_id=e.id
      LEFT JOIN requirements er ON er.id=erl.requirement_id LEFT JOIN frameworks ef ON ef.id=er.framework_id
      WHERE e.workspace_id=? AND e.superseded_at IS NULL AND (e.iso_item_id=? OR (ef.code='iso27001' AND er.ref=?)) ORDER BY e.id`);
    for (const row of rows) {
      let workpaper = db.prepare('SELECT * FROM consultant_workpapers WHERE engagement_id=? AND requirement_id=?').get(engagement.id,row.requirement_id);
      const conclusion = assessmentConclusion(row.status);
      const rationale = String(row.notes || row.inclusion_justification || row.exclusion_justification || `The independently reviewed pass concluded ${row.status}.`).trim();
      const evidence = evidenceFor.all(ws.id,row.iso_item_id,row.iso_item_id).map(e=>({...e,purpose:'Supports the signed-off assessment conclusion',relevance:'relevant',period_covered_start:null,period_covered_end:null}));
      const snapshotWorkpaper = {
        workspace_id:ws.id,engagement_id:engagement.id,requirement_id:row.requirement_id,framework_code:'iso27001',
        requirement_ref:row.requirement_ref,requirement_title:row.requirement_title,
        title:`${row.requirement_ref} assessment workpaper`,objective:`Determine the implementation position for ${row.requirement_ref} within the agreed scope.`,
        procedure_performed:`Reviewed the recorded conclusion and retained evidence for assessment pass ${storedPass.pass_number}.`,
        ...conclusion,operating_effectiveness:'not_tested',conclusion_rationale:rationale,
        client_visible_summary:`${row.requirement_title}: ${row.status}. ${rationale}`.slice(0,20000),
        client_visible:1,requires_client_validation:0,owner_id:storedPass.started_by,reviewer_id:reviewerId,
        owner_name:workspaceUser(db,ws,storedPass.started_by)?.name || 'Recorded preparer',reviewer_name:reviewer.name,
        status:'frozen',prepared_by:storedPass.started_by,approved_by:reviewerId,approved_at:capturedAt,frozen_at:capturedAt,
        assessment_answers:row.assessment_answers || null,internal_notes:null,exceptions_count:0
      };
      if (!workpaper) {
        const next = db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM consultant_workpapers').get().n;
        const ref = `${engagement.engagement_code}-WP-${String(next).padStart(4,'0')}`;
        const id = Number(db.prepare(`INSERT INTO consultant_workpapers
          (workspace_id,engagement_id,requirement_id,workpaper_ref,title,objective,procedure_performed,management_claim,design_conclusion,
           implementation_conclusion,operating_effectiveness,evidence_sufficiency,conclusion_rationale,client_visible_summary,client_visible,
           owner_id,reviewer_id,status,prepared_by,approved_by,approved_at,frozen_at,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,'not_tested',?,?,?,1,?,?,'frozen',?,?,?, ?,?)`).run(
            ws.id,engagement.id,row.requirement_id,ref,snapshotWorkpaper.title,snapshotWorkpaper.objective,snapshotWorkpaper.procedure_performed,
            conclusion.management_claim,conclusion.design_conclusion,conclusion.implementation_conclusion,conclusion.evidence_sufficiency,rationale,
            snapshotWorkpaper.client_visible_summary,storedPass.started_by,reviewerId,storedPass.started_by,reviewerId,capturedAt,capturedAt,storedPass.started_by).lastInsertRowid);
        workpaper = db.prepare('SELECT * FROM consultant_workpapers WHERE id=?').get(id);
        created++;
      }
      snapshotWorkpaper.id = workpaper.id;
      snapshotWorkpaper.workpaper_ref = workpaper.workpaper_ref;
      const snapshot = { schema_version:2,source:{type:'iso27001_assessment_pass',id:storedPass.id,pass_number:storedPass.pass_number,
        completion_generation:generation,history_id:row.id,changed_by:row.changed_by,source_pass_id:row.pass_id,inherited:Number(row.pass_id)!==storedPass.id},
        workpaper:snapshotWorkpaper,evidence,reviews:[{review_type:'assessment_pass_signoff',decision:'approved',actor_id:reviewerId,
          actor_name:reviewer.name,note:`Independent sign-off of Pass ${storedPass.pass_number}; source conclusion ${row.id}.`,created_at:capturedAt}],captured_at:capturedAt };
      const json = JSON.stringify(snapshot), hash = sha(json);
      const version = db.prepare('SELECT COALESCE(MAX(version_number),0)+1 n FROM consultant_workpaper_snapshots WHERE workpaper_id=?').get(workpaper.id).n;
      const snapshotId = Number(db.prepare(`INSERT INTO consultant_workpaper_snapshots (workpaper_id,version_number,snapshot_json,snapshot_hash,frozen_by)
        VALUES (?,?,?,?,?)`).run(workpaper.id,version,json,hash,reviewerId).lastInsertRowid);
      items.push({requirement_id:row.requirement_id,source_history_id:row.id,source_pass_id:row.pass_id,workpaper_id:workpaper.id,snapshot_id:snapshotId,
        snapshot_hash:hash,inherited:Number(row.pass_id)!==storedPass.id?1:0});
    }
    const manifest = {schema_version:1,pass:{id:storedPass.id,number:storedPass.pass_number,label:storedPass.label,generation},
      engagement:engagementSnapshot(engagement),prepared_by:storedPass.started_by,reviewed_by:reviewerId,source_cutoff:capturedAt,
      items,findings:reportFindings(db,ws.id,engagement.id)};
    const json = JSON.stringify(manifest);
    const manifestId = Number(db.prepare(`INSERT INTO assessment_pass_manifests
      (workspace_id,engagement_id,assessment_pass_id,completion_generation,supersedes_manifest_id,prepared_by,reviewed_by,source_cutoff,manifest_json,manifest_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ws.id,engagement.id,storedPass.id,generation,prior?.id||null,storedPass.started_by,reviewerId,capturedAt,json,sha(json)).lastInsertRowid);
    const insertItem = db.prepare(`INSERT INTO assessment_pass_manifest_items
      (manifest_id,requirement_id,source_history_id,source_pass_id,workpaper_id,snapshot_id,snapshot_hash,inherited) VALUES (?,?,?,?,?,?,?,?)`);
    for (const item of items) insertItem.run(manifestId,...Object.values(item));
    event(db,ws.id,engagement.id,reviewerId,'assessment_pass',storedPass.id,'materialized',{manifest_id:manifestId,generation,created,frozen:items.length});
    return {engagementId:engagement.id,manifestId,generation,created,refreshed:0,frozen:items.length};
  })();
}

function passManifests(db,ws,engagementId) {
  return db.prepare(`SELECT m.*,p.pass_number,p.label,p.status pass_status,
    (SELECT COUNT(*) FROM assessment_pass_manifest_items i WHERE i.manifest_id=m.id) item_count
    FROM assessment_pass_manifests m JOIN assessment_passes p ON p.id=m.assessment_pass_id
    WHERE m.workspace_id=? AND m.engagement_id=? ORDER BY p.pass_number DESC,m.completion_generation DESC`).all(ws.id,engagementId);
}

function passManifestDetail(db,ws,id) {
  const row=db.prepare(`SELECT m.*,p.pass_number,p.label,u.name prepared_by_name,r.name reviewed_by_name
    FROM assessment_pass_manifests m JOIN assessment_passes p ON p.id=m.assessment_pass_id
    LEFT JOIN users u ON u.id=m.prepared_by LEFT JOIN users r ON r.id=m.reviewed_by
    WHERE m.id=? AND m.workspace_id=?`).get(Number(id),ws.id);
  if(!row)throw Object.assign(new Error('Retained assessment version not found.'),{status:404});
  if(sha(row.manifest_json)!==row.manifest_hash)throw new Error('The retained assessment failed its integrity check.');
  const retained=JSON.parse(row.manifest_json);
  const sources=db.prepare('SELECT * FROM assessment_pass_manifest_items WHERE manifest_id=? ORDER BY id').all(row.id);
  const exact=sources.map(i=>({requirement_id:i.requirement_id,source_history_id:i.source_history_id,source_pass_id:i.source_pass_id,
    workpaper_id:i.workpaper_id,snapshot_id:i.snapshot_id,snapshot_hash:i.snapshot_hash,inherited:i.inherited}));
  if(!sources.length||JSON.stringify(exact)!==JSON.stringify(retained.items))throw new Error('The retained assessment source list failed its integrity check.');
  const items=sources.map(source=>({...source,version:snapshotDetail(db,ws,source.workpaper_id,source.snapshot_id)}));
  const reports=db.prepare(`SELECT r.id,r.title,r.version_number,r.report_type,r.status,r.generated_at FROM consulting_report_pass_sources s
    JOIN consulting_report_snapshots r ON r.id=s.report_id WHERE s.manifest_id=? AND r.workspace_id=? ORDER BY r.id DESC`).all(row.id,ws.id);
  return {...row,retained,items,reports};
}

function snapshotDetail(db,ws,workpaperId,snapshotId) {
  const row=db.prepare(`SELECT s.*,m.assessment_pass_id,m.completion_generation,p.pass_number FROM consultant_workpaper_snapshots s
    JOIN consultant_workpapers w ON w.id=s.workpaper_id
    LEFT JOIN assessment_pass_manifest_items i ON i.snapshot_id=s.id LEFT JOIN assessment_pass_manifests m ON m.id=i.manifest_id
    LEFT JOIN assessment_passes p ON p.id=m.assessment_pass_id
    WHERE s.id=? AND s.workpaper_id=? AND w.workspace_id=?`).get(Number(snapshotId),Number(workpaperId),ws.id);
  if(!row) throw new Error('Workpaper version not found.');
  if(sha(row.snapshot_json)!==row.snapshot_hash) throw new Error('The retained workpaper version failed its integrity check.');
  return {...row,snapshot:JSON.parse(row.snapshot_json)};
}

function readinessForSubmission(db, workpaper) {
  const evidence = evidenceSnapshot(db,workpaper);
  const problems = [];
  if (!workpaper.objective || workpaper.objective.length < 20) problems.push('document the workpaper objective');
  if (!workpaper.procedure_performed || workpaper.procedure_performed.length < 30) problems.push('document the procedure performed');
  if (!workpaper.conclusion_rationale || workpaper.conclusion_rationale.length < 30) problems.push('document a reasoned conclusion');
  if (['not_assessed'].includes(workpaper.design_conclusion) || ['not_assessed'].includes(workpaper.implementation_conclusion)) problems.push('record design and implementation conclusions');
  if (workpaper.operating_effectiveness !== 'not_tested' && (!workpaper.population_description || workpaper.sample_size == null)) problems.push('record population and sample details');
  if (workpaper.evidence_sufficiency === 'sufficient' && !evidence.some(e => e.relevance === 'relevant')) problems.push('link at least one relevant evidence item');
  if (!workpaper.reviewer_id) problems.push('assign a quality reviewer');
  else {
    const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workpaper.workspace_id);
    if (!eligibleReviewers(db,ws,[workpaper.owner_id,workpaper.prepared_by || workpaper.owner_id]).some(u=>u.id===Number(workpaper.reviewer_id))) problems.push('assign an eligible reviewer independent of the owner and preparer');
  }
  return { ready: !problems.length, problems, evidence };
}

function transitionWorkpaper(db, ws, actor, id, action, note, expectedVersion) {
  const row = workpaperDetail(db,ws,id);
  const from = row.status;
  const version = expectedVersion == null || expectedVersion === '' ? row.row_version : Number(expectedVersion);
  if (!Number.isInteger(version) || version !== row.row_version) throw Object.assign(new Error('This workpaper changed. Your decision was not applied; compare the latest version before retrying.'),{status:409});
  const normalizedNote = clean(note,10000);
  let to, reviewType, decision;
  if (action === 'submit') {
    if (!['draft','changes_requested'].includes(from)) throw new Error('Only draft workpapers can be submitted.');
    const readiness = readinessForSubmission(db,row);
    if (!readiness.ready) throw new Error(`Workpaper is not review-ready: ${readiness.problems.join('; ')}.`);
    to='manager_review'; reviewType='consultant_submission'; decision='submitted';
  } else if (action === 'approve') {
    if (from !== 'manager_review') throw new Error('Only workpapers in manager review can be approved.');
    if ([Number(row.prepared_by || row.owner_id),Number(row.owner_id)].includes(Number(actor.id))) throw new Error('The owner or preparer cannot approve their own workpaper.');
    if (!eligibleReviewers(db,ws,[row.owner_id,row.prepared_by || row.owner_id]).some(u=>u.id===Number(actor.id))) throw new Error('An eligible independent reviewer is required.');
    if (row.reviewer_id && Number(row.reviewer_id) !== Number(actor.id)) throw new Error('Only the assigned reviewer can decide this workpaper.');
    if (row.evidence_sufficiency !== 'sufficient' && row.implementation_conclusion === 'implemented') throw new Error('An implemented conclusion cannot be approved until evidence is sufficient.');
    to=row.requires_client_validation ? 'client_validation' : 'approved'; reviewType='manager_review'; decision='approved';
  } else if (action === 'changes') {
    if (!['manager_review','client_validation','approved'].includes(from)) throw new Error('Changes cannot be requested from this state.');
    if (!normalizedNote) throw new Error('Explain the required changes.');
    to='changes_requested'; reviewType=from==='client_validation'?'client_validation':'manager_review'; decision='changes_requested';
  } else if (action === 'validate') {
    if (from !== 'client_validation') throw new Error('This workpaper is not awaiting client validation.');
    if (row.client_validator_id && Number(row.client_validator_id) !== Number(actor.id)) throw new Error('Only the assigned client validator can validate this workpaper.');
    to='approved'; reviewType='client_validation'; decision='validated';
  } else if (action === 'freeze') {
    if (from !== 'approved') throw new Error('Only approved workpapers can be frozen.');
    to='frozen'; reviewType='freeze'; decision='frozen';
  } else if (action === 'reopen') {
    if (!['approved','frozen'].includes(from)) throw new Error('Only approved or frozen workpapers can be reopened.');
    if (!normalizedNote) throw new Error('A reopening reason is required.');
    to='changes_requested'; reviewType='reopen'; decision='reopened';
  } else throw new Error('Invalid workpaper action.');
  if (!WORKPAPER_STATUSES.has(to)) throw new Error('Invalid transition.');
  const tx = db.transaction(() => {
    const prepared = action === 'submit' ? actor.id : row.prepared_by;
    const approved = ['approve','validate'].includes(action) && to === 'approved' ? actor.id : row.approved_by;
    const updated = db.prepare(`UPDATE consultant_workpapers SET status=?,prepared_by=?,prepared_at=CASE WHEN ?='submit' THEN datetime('now') ELSE prepared_at END,
      approved_by=?,approved_at=CASE WHEN ?='approved' THEN datetime('now') ELSE approved_at END,
      frozen_at=CASE WHEN ?='frozen' THEN datetime('now') ELSE frozen_at END,updated_at=datetime('now'),row_version=row_version+1
      WHERE id=? AND workspace_id=? AND row_version=? AND status=?`).run(to,prepared,action,approved,to,to,row.id,ws.id,version,from);
    if (updated.changes!==1) throw Object.assign(new Error('This workpaper changed. Your decision was not applied.'),{status:409});
    db.prepare(`INSERT INTO consultant_workpaper_reviews
      (workpaper_id,review_type,decision,note,from_status,to_status,actor_id) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id,reviewType,decision,normalizedNote,from,to,actor.id);
    if (action === 'freeze') {
      const fresh = workpaperDetail(db,ws,row.id);
      const snapshot = { workpaper: fresh, evidence: evidenceSnapshot(db,fresh), reviews: db.prepare(`SELECT review_type,decision,note,from_status,to_status,actor_id,created_at FROM consultant_workpaper_reviews WHERE workpaper_id=? ORDER BY id`).all(row.id), captured_at:new Date().toISOString() };
      const json = JSON.stringify(snapshot);
      const version = db.prepare('SELECT COUNT(*) c FROM consultant_workpaper_snapshots WHERE workpaper_id=?').get(row.id).c + 1;
      db.prepare(`INSERT INTO consultant_workpaper_snapshots
        (workpaper_id,version_number,snapshot_json,snapshot_hash,frozen_by) VALUES (?,?,?,?,?)`).run(row.id,version,json,sha(json),actor.id);
    }
    const eventId=event(db,ws.id,row.engagement_id,actor.id,'workpaper',row.id,action,{ from,to,note:normalizedNote });
    const recipient=to==='manager_review'?row.reviewer_id:to==='client_validation'?row.client_validator_id:['changes_requested','approved'].includes(to)?row.owner_id:null;
    if(recipient) notificationDelivery.enqueue(db,{workspaceId:ws.id,actorId:actor.id,eventKey:`consulting_event:${eventId}`,sourceType:'validation',sourceId:row.id,
      recipientIds:[recipient],title:to==='client_validation'?'Information check ready':`Workpaper ${to.replaceAll('_',' ')}`,
      body:to==='client_validation'?'Your consultant has asked you to check the assessment summary.':`${row.workpaper_ref} · ${row.title}`,
      link:to==='client_validation'?`/workspaces/${ws.id}/client-portal/workpapers/${row.id}/validate`:`/workspaces/${ws.id}/delivery/workpapers/${row.id}`});
  });
  tx();
  return to;
}

function linkEvidence(db, ws, actorId, workpaperId, body) {
  const workpaper = workpaperDetail(db,ws,workpaperId);
  if (!['draft','changes_requested'].includes(workpaper.status)) throw new Error('Evidence links are locked while the workpaper is under review or frozen.');
  const evidence = db.prepare('SELECT id FROM evidence WHERE id=? AND workspace_id=? AND superseded_at IS NULL').get(Number(body.evidence_id),ws.id);
  if (!evidence) throw new Error('Evidence not found in this client workspace.');
  const relevance = String(body.relevance || 'pending');
  if (!new Set(['pending','relevant','partially_relevant','not_relevant']).has(relevance)) throw new Error('Invalid relevance conclusion.');
  db.prepare(`INSERT INTO consultant_workpaper_evidence
    (workpaper_id,evidence_id,purpose,relevance,period_covered_start,period_covered_end,reviewer_note,linked_by)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workpaper_id,evidence_id) DO UPDATE SET purpose=excluded.purpose,relevance=excluded.relevance,
    period_covered_start=excluded.period_covered_start,period_covered_end=excluded.period_covered_end,reviewer_note=excluded.reviewer_note`)
    .run(workpaper.id,evidence.id,clean(body.purpose,4000) || 'Supports assessment conclusion',relevance,validDate(body.period_covered_start),validDate(body.period_covered_end),clean(body.reviewer_note,4000),actorId);
  event(db,ws.id,workpaper.engagement_id,actorId,'workpaper',workpaper.id,'evidence_linked',{ evidence_id:evidence.id,relevance });
}

function createClientRequest(db, ws, actorId, workpaperId, body) {
  return db.transaction(()=>{
  const workpaper = workpaperDetail(db,ws,workpaperId);
  const assigneeId = body.assignee_id ? Number(body.assignee_id) : null;
  if (assigneeId) {
    const user = workspaceUser(db,ws,assigneeId);
    if (!user || user.user_type !== 'client') throw new Error('Assign the request to an active client member.');
  }
  const title = clean(body.title,300) || `Evidence request - ${workpaper.requirement_ref}`;
  const description = clean(body.description,20000);
  const reason = clean(body.request_reason,5000);
  const examples = clean(body.acceptable_examples,5000);
  if (!description || !reason || !examples) throw new Error('Describe the request, its purpose, and acceptable evidence examples.');
  const confidentiality = String(body.confidentiality || 'client_confidential');
  if (!new Set(['standard','client_confidential','restricted']).has(confidentiality)) throw new Error('Invalid confidentiality classification.');
  const storedDescription = enc.encryptIfNeeded(description,ws.id,!!ws.encryption_enabled);
  const id = Number(db.prepare(`INSERT INTO client_requests
    (workspace_id,request_type,title,description,priority,status,assignee_id,control_id,due_date,created_by,engagement_id,workpaper_id,
     request_reason,acceptable_examples,evidence_period_start,evidence_period_end,confidentiality,consultant_owner_id)
    VALUES (?,'evidence',?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?)`).run(ws.id,title,storedDescription,String(body.priority || 'normal'),assigneeId,
      workpaper.framework_code==='iso27001'?workpaper.requirement_ref:null,validDate(body.due_date),actorId,workpaper.engagement_id,workpaper.id,
      reason,examples,validDate(body.evidence_period_start),validDate(body.evidence_period_end),confidentiality,actorId).lastInsertRowid);
  const requestEventId=Number(db.prepare(`INSERT INTO client_request_events
    (request_id,workspace_id,actor_id,event_type,metadata) VALUES (?,?,?,'created',?)`)
    .run(id,ws.id,actorId,JSON.stringify({ workpaper_id:workpaper.id,engagement_id:workpaper.engagement_id,structured:true })).lastInsertRowid);
  if(assigneeId) notificationDelivery.enqueue(db,{workspaceId:ws.id,actorId,eventKey:`client_request_event:${requestEventId}`,sourceType:'request',sourceId:id,
    recipientIds:[assigneeId],title:'Evidence request assigned',body:title,link:`/workspaces/${ws.id}/client-portal/requests/${id}`});
  event(db,ws.id,workpaper.engagement_id,actorId,'client_request',id,'created',{ workpaper_id:workpaper.id,assignee_id:assigneeId });
  return id;
  })();
}

function createFinding(db,ws,actorId,workpaperId,body) {
  const workpaper=workpaperDetail(db,ws,workpaperId);
  const required=['title','condition_text','criteria_text','effect_text','recommendation_text'];
  const data=Object.fromEntries(required.map(key=>[key,clean(body[key],key==='title'?300:15000)]));
  if(required.some(key=>!data[key])) throw new Error('Title, condition, criteria, effect and recommendation are required.');
  const type=String(body.finding_type||'gap'),severity=String(body.severity||'medium');
  if(!new Set(['nonconformity','gap','observation','improvement']).has(type)||!new Set(['critical','high','medium','low']).has(severity)) throw new Error('Choose a valid finding type and severity.');
  const next=db.prepare('SELECT COUNT(*) c FROM consulting_findings WHERE engagement_id=?').get(workpaper.engagement_id).c+1;
  const ref=`${workpaper.workpaper_ref.replace(/-WP-\d+$/,'')}-F-${String(next).padStart(4,'0')}`;
  const internal=enc.encryptIfNeeded(clean(body.internal_notes,15000),ws.id,!!ws.encryption_enabled);
  const id=Number(db.prepare(`INSERT INTO consulting_findings
    (workspace_id,engagement_id,workpaper_id,finding_ref,title,finding_type,severity,condition_text,criteria_text,cause_text,effect_text,recommendation_text,
     internal_notes,client_visible,owner_id,due_date,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ws.id,workpaper.engagement_id,workpaper.id,ref,data.title,type,severity,data.condition_text,data.criteria_text,
      clean(body.cause_text,15000),data.effect_text,data.recommendation_text,internal,body.client_visible==='1'?1:0,body.owner_id||null,validDate(body.due_date),actorId).lastInsertRowid);
  db.prepare(`INSERT INTO consulting_finding_events (finding_id,to_status,note,actor_id) VALUES (?,'draft','Finding drafted from workpaper',?)`).run(id,actorId);
  event(db,ws.id,workpaper.engagement_id,actorId,'finding',id,'created',{ workpaper_id:workpaper.id,ref,severity });
  return id;
}

function findingDetail(db,ws,id) {
  const row=db.prepare(`SELECT f.*,w.workpaper_ref,w.title workpaper_title,o.name owner_name,c.name created_by_name,cf.name confirmed_by_name,v.name validated_by_name
    FROM consulting_findings f LEFT JOIN consultant_workpapers w ON w.id=f.workpaper_id LEFT JOIN users o ON o.id=f.owner_id
    LEFT JOIN users c ON c.id=f.created_by LEFT JOIN users cf ON cf.id=f.confirmed_by LEFT JOIN users v ON v.id=f.validated_by
    WHERE f.id=? AND f.workspace_id=?`).get(Number(id),ws.id);
  if(!row) throw new Error('Finding not found.');
  row.internal_notes=enc.decryptIfNeeded(row.internal_notes,ws.id);return row;
}

function transitionFinding(db,ws,actorId,id,action,body={}) {
  const row=findingDetail(db,ws,id);let to;
  const note=clean(body.note,10000);
  const version=Number(body.row_version);
  if(!Number.isInteger(version)||version!==Number(row.row_version)) throw new Error('The finding changed in another session. Reload before deciding.');
  if(action==='confirm'&&row.status==='draft') {
    if(Number(row.created_by)===Number(actorId)) throw new Error('The finding author cannot confirm their own finding.');
    if(!note) throw new Error('Confirmation rationale is required.');
    to='confirmed';
  }
  else if(action==='plan'&&['confirmed','remediation_planned'].includes(row.status)) {
    if(!clean(body.remediation_plan,15000)||!body.owner_id||!validDate(body.due_date)) throw new Error('A remediation plan, owner and due date are required.');
    if(!workspaceUser(db,ws,Number(body.owner_id))) throw new Error('Finding owner is not active in this workspace.');
    to='remediation_planned';
  } else if(action==='validate'&&row.status==='remediation_planned') {
    if(!clean(body.resolution_summary,15000)) throw new Error('Resolution summary is required before validation.');
    to='ready_for_validation';
  } else if(action==='close'&&row.status==='ready_for_validation') {
    if(!clean(body.validation_conclusion,15000)) throw new Error('Independent validation conclusion is required.');
    const submitter=db.prepare(`SELECT actor_id FROM consulting_finding_events WHERE finding_id=? AND to_status='ready_for_validation' ORDER BY id DESC LIMIT 1`).get(row.id);
    if(Number(row.owner_id)===Number(actorId)||Number(submitter?.actor_id)===Number(actorId)) throw new Error('Finding closure must be validated by someone independent of the owner and remediation submitter.');
    const proof=db.prepare(`SELECT COUNT(*) c FROM consulting_finding_evidence WHERE finding_id=? AND evidence_role='validation'`).get(row.id).c;
    if(!proof) throw new Error('Link validation evidence before closing the finding.');
    to='closed';
  } else if(action==='withdraw'&&['draft','confirmed'].includes(row.status)) { if(!note) throw new Error('Withdrawal reason is required.');to='withdrawn'; }
  else throw new Error(`Finding cannot ${action} from ${row.status}.`);
  db.transaction(()=>{
    const result=db.prepare(`UPDATE consulting_findings SET status=?,owner_id=COALESCE(?,owner_id),due_date=COALESCE(?,due_date),
      remediation_plan=COALESCE(?,remediation_plan),effort_estimate=COALESCE(?,effort_estimate),cost_estimate=COALESCE(?,cost_estimate),
      retest_criteria=COALESCE(?,retest_criteria),closure_evidence_requirements=COALESCE(?,closure_evidence_requirements),
      resolution_summary=COALESCE(?,resolution_summary),validation_conclusion=COALESCE(?,validation_conclusion),
      confirmed_by=CASE WHEN ?='confirmed' THEN ? ELSE confirmed_by END,confirmed_at=CASE WHEN ?='confirmed' THEN datetime('now') ELSE confirmed_at END,
      validated_by=CASE WHEN ?='closed' THEN ? ELSE validated_by END,validated_at=CASE WHEN ?='closed' THEN datetime('now') ELSE validated_at END,
      updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND workspace_id=? AND row_version=?`).run(to,body.owner_id||null,body.due_date||null,
        clean(body.remediation_plan,15000),clean(body.effort_estimate,500),clean(body.cost_estimate,500),clean(body.retest_criteria,10000),
        clean(body.closure_evidence_requirements,10000),clean(body.resolution_summary,15000),clean(body.validation_conclusion,15000),
        to,actorId,to,to,actorId,to,row.id,ws.id,version);
    if(!result.changes) throw new Error('The finding changed in another session. Reload before deciding.');
    db.prepare(`INSERT INTO consulting_finding_events (finding_id,from_status,to_status,note,actor_id) VALUES (?,?,?,?,?)`).run(row.id,row.status,to,note,actorId);
    event(db,ws.id,row.engagement_id,actorId,'finding',row.id,action,{from:row.status,to});
  })();return to;
}

function linkFindingEvidence(db,ws,actorId,id,body) {
  const row=findingDetail(db,ws,id);const evidence=db.prepare('SELECT id FROM evidence WHERE id=? AND workspace_id=?').get(Number(body.evidence_id),ws.id);
  if(!evidence) throw new Error('Evidence not found in this workspace.');
  const role=String(body.evidence_role||'remediation');if(!new Set(['source','remediation','validation']).has(role)) throw new Error('Invalid evidence role.');
  db.prepare(`INSERT OR IGNORE INTO consulting_finding_evidence (finding_id,evidence_id,evidence_role,linked_by) VALUES (?,?,?,?)`).run(row.id,evidence.id,role,actorId);
  event(db,ws.id,row.engagement_id,actorId,'finding',row.id,'evidence_linked',{evidence_id:evidence.id,role});
}

function engagementSnapshot(engagement) {
  return {id:engagement.id,code:engagement.engagement_code,name:engagement.name,type:engagement.engagement_type,
    frameworks:JSON.parse(engagement.framework_scope_json || '[]'),scope:engagement.scope_statement,
    period:[engagement.assessment_period_start,engagement.assessment_period_end]};
}

function reportFindings(db,workspaceId,engagementId) {
  return db.prepare(`SELECT finding_ref,title,finding_type,severity,condition_text,criteria_text,effect_text,recommendation_text,status,due_date,
    remediation_plan,effort_estimate,cost_estimate,retest_criteria,closure_evidence_requirements,resolution_summary,validation_conclusion
    FROM consulting_findings WHERE engagement_id=? AND workspace_id=? AND client_visible=1 AND status NOT IN ('draft','withdrawn')
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,id`).all(engagementId,workspaceId);
}

function reportWorkpaper(version) {
  const w=version.snapshot.workpaper;
  if(!w) throw new Error('The selected workpaper version has no retained conclusion.');
  const keys=['workpaper_ref','title','client_visible_summary','management_claim','design_conclusion','implementation_conclusion',
    'operating_effectiveness','evidence_sufficiency','requirement_ref','requirement_title','framework_code'];
  return {...Object.fromEntries(keys.map(k=>[k,w[k] || ''])),workpaper_id:version.workpaper_id,snapshot_id:version.id,version_number:version.version_number,snapshot_hash:version.snapshot_hash,
    source:version.snapshot.source || {type:'manual_workpaper'}};
}

function reportPermissions(db,ws,actor) {
  const context=require('./client-work-policy').actorContext(db,ws,actor);
  if(!context.active||!context.firm)return new Set();
  return rbac.isManager(actor.firm_role)?new Set(Object.keys(rbac.PERMISSIONS).concat(['*'])):context.permissions;
}
function reportActor(db,ws,actorId,permission) {
  const actor=db.prepare('SELECT * FROM users WHERE id=?').get(Number(actorId));
  if(!actor || !rbac.hasPermission(reportPermissions(db,ws,actor),permission))throw Object.assign(new Error('Your current role cannot perform this report action.'),{status:403});
  return actor;
}
function reportRecipients(db,ws,reportId,permission,excluded=[]) {
  return db.prepare("SELECT * FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY id").all(ws.firm_id)
    .filter(user=>!excluded.map(Number).includes(user.id)&&rbac.hasPermission(reportPermissions(db,ws,user),permission)
      &&notificationDelivery.canRead(db,user,{workspace_id:ws.id,user_id:user.id,source_type:'report',source_id:String(reportId),link:`/workspaces/${ws.id}/delivery/reports/${reportId}`})).map(user=>user.id);
}

function reportRevisionRequest(db,ws,reportId) {
  const row=db.prepare(`SELECT q.*,r.title,r.engagement_id,r.report_type,r.generated_by,r.version_number,u.name requested_by_name,
    p.manifest_id FROM consulting_report_revision_requests q JOIN consulting_report_snapshots r ON r.id=q.report_id
    JOIN users u ON u.id=q.requested_by LEFT JOIN consulting_report_pass_sources p ON p.report_id=r.id
    WHERE q.workspace_id=? AND q.report_id=?`).get(ws.id,Number(reportId));
  return row?{...row,request_note:enc.decryptIfNeeded(row.request_note,ws.id)}:null;
}
function generateReport(db,ws,actorId,engagementId,body) {
  return db.transaction(()=>{
    reportActor(db,ws,actorId,'report.generate');
    const engagement=engagementFor(db,ws,actorId,engagementId);
    const type=String(body.report_type||'assessment');
    const replacementId=String(body.replaces_report_id || '').trim();
    const revision=replacementId?reportRevisionRequest(db,ws,replacementId):null;
    if(replacementId && (!/^\d+$/.test(replacementId)||!revision||revision.replacement_report_id||revision.engagement_id!==engagement.id||revision.report_type!==type)) throw Object.assign(new Error('Choose an unresolved revision request for this engagement and report type.'),{status:422});
    if(!new Set(['assessment','readiness','internal_audit','management']).has(type)) throw new Error('Invalid report type.');
    const manifests=passManifests(db,ws,engagement.id);
    const manifestId=body.pass_manifest_id ? Number(body.pass_manifest_id) : null;
    const passReport=String(body.pass_manifest_id || '').trim()!=='' || body.basis_type==='assessment_pass' || (type==='assessment' && manifests.length>0 && body.basis_type!=='manual_workpapers');
    let workpapers,findings,sourceEngagement,basis,passBasis=null;
    if(passReport) {
      const manifest=manifests.find(m=>m.id===manifestId);
      if(!manifest) throw Object.assign(new Error('Choose the completed assessment pass and version to include in this report.'),{status:422});
      if(sha(manifest.manifest_json)!==manifest.manifest_hash) throw new Error('The assessment manifest failed its integrity check.');
      const retained=JSON.parse(manifest.manifest_json);
      const items=db.prepare('SELECT * FROM assessment_pass_manifest_items WHERE manifest_id=? ORDER BY id').all(manifest.id);
      if(!items.length || JSON.stringify(items.map(i=>({requirement_id:i.requirement_id,source_history_id:i.source_history_id,source_pass_id:i.source_pass_id,
        workpaper_id:i.workpaper_id,snapshot_id:i.snapshot_id,snapshot_hash:i.snapshot_hash,inherited:i.inherited})))!==JSON.stringify(retained.items)) throw new Error('The assessment manifest source list failed its integrity check.');
      workpapers=items.map(item=>{
        const version=snapshotDetail(db,ws,item.workpaper_id,item.snapshot_id);
        if(version.snapshot_hash!==item.snapshot_hash) throw new Error('A selected source version failed its integrity check.');
        return reportWorkpaper(version);
      });
      findings=retained.findings || [];
      sourceEngagement=retained.engagement;
      passBasis={manifest_id:manifest.id,manifest_hash:manifest.manifest_hash,pass_id:manifest.assessment_pass_id,
        pass_number:manifest.pass_number,completion_generation:manifest.completion_generation,source_cutoff:manifest.source_cutoff};
      basis=`Assessment Pass ${manifest.pass_number}, completion version ${manifest.completion_generation}. Conclusions, evidence references, scope and confirmed findings are retained as at ${manifest.source_cutoff}.`;
    } else {
      const versions=db.prepare(`SELECT s.id,s.workpaper_id FROM consultant_workpaper_snapshots s JOIN consultant_workpapers w ON w.id=s.workpaper_id
        WHERE w.engagement_id=? AND w.workspace_id=? AND w.status='frozen'
          AND NOT EXISTS (SELECT 1 FROM assessment_pass_manifest_items i WHERE i.snapshot_id=s.id)
          AND s.version_number=(SELECT MAX(s2.version_number) FROM consultant_workpaper_snapshots s2 WHERE s2.workpaper_id=w.id
            AND NOT EXISTS (SELECT 1 FROM assessment_pass_manifest_items i2 WHERE i2.snapshot_id=s2.id)) ORDER BY w.requirement_id`)
        .all(engagement.id,ws.id);
      workpapers=versions.map(v=>reportWorkpaper(snapshotDetail(db,ws,v.workpaper_id,v.id)));
      findings=reportFindings(db,ws.id,engagement.id);
      sourceEngagement=engagementSnapshot(engagement);
      const legacy=workpapers.some(w=>w.source?.type==='iso27001_assessment_pass');
      basis=legacy ? 'Legacy frozen workpaper sources. These versions have no exact assessment pass manifest; pass provenance is unverified. Confirmed findings are captured at report generation.'
        : 'Frozen manual workpaper versions and confirmed client-visible findings captured at report generation.';
    }
    if(!workpapers.length) throw new Error('Choose a completed assessment pass or freeze an independently approved manual workpaper first.');
    const version=db.prepare('SELECT COALESCE(MAX(version_number),0)+1 n FROM consulting_report_snapshots WHERE engagement_id=? AND report_type=?').get(engagement.id,type).n;
    const snapshot={schema_version:2,engagement:sourceEngagement,workpapers,findings,generated_at:new Date().toISOString(),basis,pass_basis:passBasis};
    const json=JSON.stringify(snapshot),title=clean(body.title,300)||`${engagement.name} - ${type.replaceAll('_',' ')} report`;
    const id=Number(db.prepare(`INSERT INTO consulting_report_snapshots
      (workspace_id,engagement_id,report_type,title,version_number,snapshot_json,snapshot_hash,generated_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(ws.id,engagement.id,type,title,version,json,sha(json),actorId).lastInsertRowid);
    if(passBasis) db.prepare('INSERT INTO consulting_report_pass_sources (report_id,manifest_id) VALUES (?,?)').run(id,passBasis.manifest_id);
    if(revision) {
      const linked=db.prepare("UPDATE consulting_report_revision_requests SET replacement_report_id=?,replaced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND workspace_id=? AND replacement_report_id IS NULL").run(id,revision.id,ws.id);
      if(!linked.changes) throw Object.assign(new Error('This revision request already has a replacement. Open its new report version.'),{status:409});
    }
    const eventId=event(db,ws.id,engagement.id,actorId,'report',id,'generated',{type,version,pass_manifest_id:passBasis?.manifest_id || null,replaces_report_id:revision?.report_id || null,workpapers:workpapers.length,findings:findings.length});
    const eligible=reportRecipients(db,ws,id,'report.approve',[actorId]);
    const preferred=[revision?.requested_by,engagement.quality_reviewer_id].filter(value=>eligible.includes(Number(value)));
    notificationDelivery.enqueue(db,{workspaceId:ws.id,actorId,eventKey:`consulting_event:${eventId}`,sourceType:'report',sourceId:id,
      recipientIds:preferred.length?preferred:eligible,title:revision?'Replacement report ready for review':'Report ready for independent review',body:title,link:`/workspaces/${ws.id}/delivery/reports/${id}`});
    return id;
  })();
}

function transitionReport(db,ws,actorId,id,action,note,expected={}) {
  return db.transaction(()=>{
    reportActor(db,ws,actorId,action==='publish'?'report.publish':'report.approve');
    const row=db.prepare('SELECT * FROM consulting_report_snapshots WHERE id=? AND workspace_id=?').get(Number(id),ws.id);
    if(!row)throw Object.assign(new Error('Report not found.'),{status:404});
    if((expected.status!==undefined&&expected.status!==row.status)||(expected.hash!==undefined&&expected.hash!==row.snapshot_hash))throw Object.assign(new Error('This report changed. Compare the current version before deciding.'),{status:409});
    const text=clean(note,5000);if(!text)throw Object.assign(new Error('Decision rationale is required.'),{status:422});
    let to;
    if(['approve','request-changes'].includes(action)&&row.status==='generated') {
      if(Number(row.generated_by)===Number(actorId))throw Object.assign(new Error('The report generator cannot independently review their own report.'),{status:403});
      to=action==='approve'?'approved':'superseded';
    }else if(action==='publish'&&row.status==='approved')to='published';
    else throw Object.assign(new Error(`Report cannot ${action.replaceAll('-',' ')} from ${row.status}.`),{status:409});
    const result=db.prepare(`UPDATE consulting_report_snapshots SET status=?,decision_note=?,approved_by=CASE WHEN ?='approved' THEN ? ELSE approved_by END,
      approved_at=CASE WHEN ?='approved' THEN datetime('now') ELSE approved_at END,published_by=CASE WHEN ?='published' THEN ? ELSE published_by END,
      published_at=CASE WHEN ?='published' THEN datetime('now') ELSE published_at END WHERE id=? AND workspace_id=? AND status=?`)
      .run(to,enc.encryptIfNeeded(text,ws.id,!!ws.encryption_enabled),to,actorId,to,to,actorId,to,row.id,ws.id,row.status);
    if(!result.changes)throw Object.assign(new Error('The report changed in another session. Reload before deciding.'),{status:409});
    if(action==='request-changes')db.prepare('INSERT INTO consulting_report_revision_requests(workspace_id,report_id,requested_by,request_note) VALUES (?,?,?,?)')
      .run(ws.id,row.id,actorId,enc.encryptIfNeeded(text,ws.id,!!ws.encryption_enabled));
    const eventId=event(db,ws.id,row.engagement_id,actorId,'report',row.id,action==='request-changes'?'report_changes_requested':action,{from:row.status,to});
    let recipients;
    if(action==='approve')recipients=reportRecipients(db,ws,row.id,'report.publish',[actorId]);
    else recipients=reportRecipients(db,ws,row.id,action==='request-changes'?'report.generate':'report.view',[actorId]).filter(userId=>userId===row.generated_by);
    notificationDelivery.enqueue(db,{workspaceId:ws.id,actorId,eventKey:`consulting_event:${eventId}`,sourceType:'report',sourceId:row.id,recipientIds:recipients,
      title:action==='request-changes'?'Report changes requested':action==='approve'?'Approved report ready to publish':'Report published',body:text,
      link:`/workspaces/${ws.id}/delivery/reports/${row.id}`,severity:action==='request-changes'?'warning':'info'});
    return to;
  })();
}

function reportDetail(db,ws,id) {
  const row=db.prepare(`SELECT r.*,g.name generated_by_name,a.name approved_by_name,p.name published_by_name FROM consulting_report_snapshots r
    LEFT JOIN users g ON g.id=r.generated_by LEFT JOIN users a ON a.id=r.approved_by LEFT JOIN users p ON p.id=r.published_by
    WHERE r.id=? AND r.workspace_id=?`).get(Number(id),ws.id);if(!row) throw new Error('Report not found.');
  const replaces=db.prepare(`SELECT q.report_id,r.title,r.version_number FROM consulting_report_revision_requests q JOIN consulting_report_snapshots r ON r.id=q.report_id WHERE q.workspace_id=? AND q.replacement_report_id=?`).get(ws.id,row.id)||null;
  return {...row,snapshot:JSON.parse(row.snapshot_json),revisionRequest:reportRevisionRequest(db,ws,row.id),replacesReport:replaces};
}

function getCockpit(db, ws, userId, engagementId) {
  const engagement = engagementId ? db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=? AND id=?').get(ws.id,Number(engagementId))
    : db.prepare("SELECT * FROM consulting_engagements WHERE workspace_id=? ORDER BY CASE WHEN status IN ('complete','cancelled') THEN 1 ELSE 0 END,id DESC LIMIT 1").get(ws.id);
  if(!engagement)throw Object.assign(new Error('Start an engagement before opening the delivery workspace.'),{status:404,code:'engagement_not_started'});
  const workpapers = db.prepare(`SELECT w.*,r.ref requirement_ref,r.title requirement_title,f.code framework_code,o.name owner_name,rv.name reviewer_name,
    (SELECT COUNT(*) FROM consultant_workpaper_evidence we WHERE we.workpaper_id=w.id) evidence_count,
    (SELECT COUNT(*) FROM client_requests cr WHERE cr.workpaper_id=w.id AND cr.status NOT IN ('accepted','cancelled')) request_count
    FROM consultant_workpapers w JOIN requirements r ON r.id=w.requirement_id JOIN frameworks f ON f.id=r.framework_id
    LEFT JOIN users o ON o.id=w.owner_id LEFT JOIN users rv ON rv.id=w.reviewer_id
    WHERE w.workspace_id=? AND w.engagement_id=? ORDER BY CASE w.status WHEN 'manager_review' THEN 0 WHEN 'changes_requested' THEN 1 WHEN 'client_validation' THEN 2 ELSE 3 END,w.due_date,w.id`).all(ws.id,engagement.id);
  const requests = db.prepare(`SELECT cr.*,a.name assignee_name,o.name consultant_owner_name,w.workpaper_ref
    FROM client_requests cr LEFT JOIN users a ON a.id=cr.assignee_id LEFT JOIN users o ON o.id=cr.consultant_owner_id
    LEFT JOIN consultant_workpapers w ON w.id=cr.workpaper_id
    WHERE cr.workspace_id=? AND cr.engagement_id=? ORDER BY CASE cr.status WHEN 'submitted' THEN 0 WHEN 'changes_requested' THEN 1 ELSE 2 END,cr.due_date,cr.id DESC`).all(ws.id,engagement.id);
  const controls = db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM client_control_requirement_links l WHERE l.client_control_id=c.id) mapping_count
    FROM client_controls c WHERE c.workspace_id=? ORDER BY c.control_code`).all(ws.id);
  const scopeChanges = db.prepare(`SELECT s.*,p.name proposed_by_name,d.name decided_by_name FROM engagement_scope_changes s
    LEFT JOIN users p ON p.id=s.proposed_by LEFT JOIN users d ON d.id=s.decided_by WHERE s.engagement_id=? ORDER BY s.id DESC`).all(engagement.id);
  const commercial = db.prepare(`SELECT ec.*,
    COALESCE((SELECT SUM(hours) FROM engagement_time_entries t WHERE t.engagement_id=ec.engagement_id),0) actual_hours,
    COALESCE((SELECT SUM(CASE WHEN billable=1 THEN hours ELSE 0 END) FROM engagement_time_entries t WHERE t.engagement_id=ec.engagement_id),0) billable_hours
    FROM engagement_commercials ec WHERE ec.engagement_id=?`).get(engagement.id);
  const timeEntries = db.prepare(`SELECT t.*,u.name user_name FROM engagement_time_entries t JOIN users u ON u.id=t.user_id WHERE t.engagement_id=? ORDER BY t.work_date DESC,t.id DESC LIMIT 50`).all(engagement.id);
  const methodology = db.prepare(`SELECT m.*,v.content_json,v.change_summary,v.approved_at,u.name approved_by_name
    FROM firm_methodologies m JOIN firm_methodology_versions v ON v.methodology_id=m.id AND v.version_number=m.current_version
    LEFT JOIN users u ON u.id=v.approved_by WHERE m.firm_id=? AND m.code='consulting-assurance'`).get(ws.firm_id);
  const engagements = db.prepare(`SELECT e.*,(SELECT COUNT(*) FROM consultant_workpapers w WHERE w.engagement_id=e.id) workpaper_count FROM consulting_engagements e WHERE e.workspace_id=? ORDER BY e.id DESC`).all(ws.id);
  const team = db.prepare(`SELECT t.*,u.name,u.email,u.user_type FROM consulting_engagement_team t JOIN users u ON u.id=t.user_id
    WHERE t.engagement_id=? ORDER BY CASE t.role WHEN 'engagement_lead' THEN 0 WHEN 'quality_reviewer' THEN 1 ELSE 2 END,u.name`).all(engagement.id);
  const requirements = requirementCatalog(db,engagement);
  const users = db.prepare(`SELECT DISTINCT u.id,u.name,u.email,u.user_type,u.firm_role,wm.role workspace_role FROM users u
    LEFT JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=? WHERE u.active=1 AND ((u.user_type='firm' AND u.firm_id=?) OR wm.workspace_id=?) ORDER BY u.user_type DESC,u.name`).all(ws.id,ws.firm_id,ws.id)
    .flatMap(user=>{const context=require('./client-work-policy').actorContext(db,ws,user);return context.active?[{...user,can_prepare:context.firm&&rbac.hasPermission(context.permissions,'control.update')}]:[];});
  const evidence = db.prepare(`SELECT id,filename,description,uploaded_at FROM evidence WHERE workspace_id=? AND superseded_at IS NULL ORDER BY uploaded_at DESC,id DESC`).all(ws.id);
  const findings=db.prepare(`SELECT f.*,w.workpaper_ref,o.name owner_name FROM consulting_findings f LEFT JOIN consultant_workpapers w ON w.id=f.workpaper_id
    LEFT JOIN users o ON o.id=f.owner_id WHERE f.workspace_id=? AND f.engagement_id=? ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,f.due_date,f.id`).all(ws.id,engagement.id);
  const reports=db.prepare(`SELECT r.id,r.report_type,r.title,r.version_number,r.status,r.snapshot_hash,r.generated_at,g.name generated_by_name,a.name approved_by_name,q.id revision_request_id,q.replacement_report_id
    FROM consulting_report_snapshots r LEFT JOIN consulting_report_revision_requests q ON q.report_id=r.id LEFT JOIN users g ON g.id=r.generated_by LEFT JOIN users a ON a.id=r.approved_by
    WHERE r.workspace_id=? AND r.engagement_id=? ORDER BY r.id DESC`).all(ws.id,engagement.id);
  const today = new Date().toISOString().slice(0,10);
  const metrics = {
    mine: workpapers.filter(w=>w.owner_id===userId && !['frozen','superseded'].includes(w.status)).length,
    review: workpapers.filter(w=>w.reviewer_id===userId && w.status==='manager_review').length,
    client: requests.filter(r=>['open','in_progress','changes_requested'].includes(r.status)).length,
    overdue: workpapers.filter(w=>w.due_date&&w.due_date<today&&!['approved','frozen','superseded'].includes(w.status)).length + requests.filter(r=>r.due_date&&r.due_date<today&&!['accepted','cancelled'].includes(r.status)).length,
    frozen: workpapers.filter(w=>w.status==='frozen').length,
    coverage: requirements.length ? Math.round(new Set(workpapers.filter(w=>requirements.some(r=>r.id===w.requirement_id)).map(w=>w.requirement_id)).size / new Set(requirements.map(r=>r.id)).size * 100) : 0
  };
  return { engagement,engagements,team,workpapers,requests,controls,findings,reports,scopeChanges,commercial:commercialProjection(commercial),timeEntries,methodology,requirements,users,evidence,metrics,manifests:passManifests(db,ws,engagement.id),reviewerCandidates:eligibleReviewers(db,ws) };
}

function portfolio(db, firmId) {
  const rows = db.prepare(`SELECT e.*,w.client_name,w.frameworks,w.engagement_outcome,l.name lead_name,q.name reviewer_name,ec.currency,ec.contract_value_minor,ec.planned_hours,
    ec.internal_cost_rate_minor,ec.invoiced_minor,ec.estimated_remaining_cost_minor,
    COALESCE((SELECT SUM(hours) FROM engagement_time_entries t WHERE t.engagement_id=e.id),0) actual_hours,
    (SELECT COUNT(*) FROM consultant_workpapers wp WHERE wp.engagement_id=e.id AND wp.status='manager_review') review_count,
    (SELECT COUNT(*) FROM consultant_workpapers wp WHERE wp.engagement_id=e.id AND wp.status='changes_requested') changes_count,
    (SELECT COUNT(*) FROM client_requests cr WHERE cr.engagement_id=e.id AND cr.status NOT IN ('accepted','cancelled')) client_waiting,
    (SELECT COUNT(*) FROM consultant_workpapers wp WHERE wp.engagement_id=e.id AND wp.due_date<date('now') AND wp.status NOT IN ('approved','frozen','superseded')) overdue_workpapers
    FROM consulting_engagements e JOIN workspaces w ON w.id=e.workspace_id
    LEFT JOIN users l ON l.id=e.lead_consultant_id LEFT JOIN users q ON q.id=e.quality_reviewer_id
    LEFT JOIN engagement_commercials ec ON ec.engagement_id=e.id WHERE w.firm_id=? ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END,e.target_date,e.id`).all(firmId);
  return rows.map(commercialProjection);
}

function commercialProjection(row) {
  if(!row) return null;
  const plannedCost=Number(row.planned_hours||0)*Number(row.internal_cost_rate_minor||0);
  const actualCost=Number(row.actual_hours||0)*Number(row.internal_cost_rate_minor||0);
  const remaining=row.estimated_remaining_cost_minor == null ? null : Number(row.estimated_remaining_cost_minor);
  return {...row,planned_cost_minor:plannedCost,actual_cost_minor:actualCost,
    margin_after_recorded_cost_minor:Number(row.contract_value_minor||0)-actualCost,
    forecast_margin_minor:remaining == null ? null : Number(row.contract_value_minor||0)-actualCost-remaining,
    utilisation_pct:Number(row.planned_hours||0)?Math.round(Number(row.actual_hours||0)/Number(row.planned_hours)*100):0};
}

function portfolioTotals(rows) {
  const totals={engagements:rows.length,hours:0,review:0,overdue:0,currencies:[]};
  const currencies=new Map();
  for(const row of rows) {
    totals.hours+=Number(row.actual_hours||0);totals.review+=Number(row.review_count||0);totals.overdue+=Number(row.overdue_workpapers||0);
    const code=row.currency || 'USD';
    const group=currencies.get(code) || {currency:code,contract:0,margin:0,forecast_missing:0,engagements:0};
    group.contract+=Number(row.contract_value_minor||0);group.engagements++;
    if(row.forecast_margin_minor==null) group.forecast_missing++; else group.margin+=Number(row.forecast_margin_minor);
    currencies.set(code,group);
  }
  totals.currencies=[...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency));
  return totals;
}

module.exports = {
  ensureEngagement,engagementFor,ensureMethodology,getCockpit,saveWorkpaper,workpaperDetail,
  readinessForSubmission,transitionWorkpaper,linkEvidence,createClientRequest,workspaceUser,
  createFinding,findingDetail,transitionFinding,linkFindingEvidence,generateReport,transitionReport,reportDetail,reportRevisionRequest,
  requirementCatalog,event,portfolio,portfolioTotals,commercialProjection,sha,clean,validDate,materializeAssessmentPass,passManifests,passManifestDetail,snapshotDetail,eligibleReviewers,syncEngagementRoster
};
