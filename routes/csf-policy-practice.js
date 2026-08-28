'use strict';

// Production NIST CSF 2.0 assessment workflow. The official Core remains the
// outcome taxonomy; Policy and Practice use an independent, evidence-gated,
// CMMI-aligned 0-5 scale. NIST Implementation Tiers are intentionally absent.

const fs = require('fs');
const crypto = require('crypto');
const csfCatalog = require('../data/nist-csf');
const methodology = require('../data/nist-csf-policy-practice');
const model = require('../lib/csf-policy-practice');
const reports = require('../lib/csf-policy-practice-report');
const uploadSecurity = require('../lib/upload-security');
const auditPack = require('../lib/audit-pack');
const { htmlToDocxPooled } = require('../lib/workers');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');

const FILE_EXTENSIONS = new Set(['pdf','png','jpg','jpeg','txt','csv','doc','docx','xls','xlsx','ppt','pptx','zip','json','xml']);
const PROFILE_FIELDS = [
  'business_context','mission_objectives','critical_services','critical_assets_data','threat_landscape',
  'legal_contractual_requirements','stakeholder_expectations','risk_appetite','scope_statement',
  'assessment_limitations','community_profile_reference',
];
const CATALOG_BY_CODE = new Map();
for (const fn of csfCatalog.FUNCTIONS) for (const cat of fn.categories) for (const out of cat.subcategories) {
  CATALOG_BY_CODE.set(out.code, {
    ...out,
    implementation_examples: Array.isArray(out.implementation_examples)
      ? out.implementation_examples
      : String(out.implementation_examples || '').split(/\s+(?=Ex\d+:)/).filter(Boolean),
  });
}

function integerOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function clean(value, max = 20000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, upload } = deps;
  const requireFirmWorkspaceExport = requirePermission('workspace.export');
  function requireInternalExport(req, res, next) {
    if (req.user?.user_type === 'client') return next();
    return requireFirmWorkspaceExport(req, res, next);
  }

  function renderError(req, res, status, message) {
    return res.status(status).render('error', { user:req.user, ws:req.workspace, message });
  }

  function loadEngagement(req, { portal = false } = {}) {
    const engagement = db.prepare(`SELECT e.*,u.name lead_name FROM csf_engagements e
      LEFT JOIN users u ON u.id=e.assigned_lead_id
      WHERE e.id=? AND e.workspace_id=? AND e.deleted_at IS NULL`).get(req.params.id, req.workspace.id);
    if (!engagement) return { error:{ status:404, message:'NIST CSF assessment not found.' } };
    if (req.user.user_type === 'client') {
      if (!portal) return { error:{ status:403, message:'This page is not available through your client portal.' } };
      const requested = db.prepare(`SELECT 1 FROM csf_subcategory_assessments a
        LEFT JOIN csf_action_links l ON l.assessment_id=a.id AND l.client_request_id IS NOT NULL
        LEFT JOIN client_requests cr ON cr.id=l.client_request_id
        WHERE a.engagement_id=? AND a.client_validation_status='requested'
          AND (cr.assignee_id=? OR ? IN ('client_owner','isms_manager')) LIMIT 1`)
        .get(engagement.id, req.user.id, req.workspace._userRole || req.workspace.role || '');
      if (!requested && !(engagement.status === 'Published' && engagement.visible_in_portal === 1)) {
        return { error:{ status:403, message:'This assessment has not been shared with you.' } };
      }
    } else if (!model.canView(db, req.user, engagement)) {
      return { error:{ status:403, message:'You are not assigned to this assessment.' } };
    }
    model.ensureAssessmentRows(db, engagement);
    return { engagement };
  }

  function loadAssessment(engagement, subcategoryId) {
    return db.prepare(`SELECT a.*,s.code,s.description,c.code category_code,c.name category_name,
        f.code function_code,f.name function_name
      FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id
      JOIN csf_categories c ON c.id=s.category_id JOIN csf_functions f ON f.id=c.function_id
      WHERE a.engagement_id=? AND a.subcategory_id=?`).get(engagement.id, subcategoryId);
  }

  function event(engagementId, assessmentId, eventType, fromStatus, toStatus, actorId, metadata) {
    db.prepare(`INSERT INTO csf_assessment_events
      (engagement_id,assessment_id,event_type,from_status,to_status,metadata,actor_id)
      VALUES (?,?,?,?,?,?,?)`).run(engagementId,assessmentId,eventType,fromStatus,toStatus,
        metadata ? JSON.stringify(metadata) : null,actorId);
  }

  function decision(req, engagement, assessment, axis, previousValue, newValue, rationale) {
    if (String(previousValue ?? '') === String(newValue ?? '')) return;
    db.prepare(`INSERT INTO csf_score_decisions
      (workspace_id,engagement_id,assessment_id,axis,previous_value,new_value,rationale,evidence_manifest_json,actor_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(req.workspace.id,engagement.id,assessment.id,axis,
        previousValue == null ? null : String(previousValue),newValue == null ? null : String(newValue),
        clean(rationale) || null,JSON.stringify(model.evidenceManifest(db,assessment.id)),req.user.id);
  }

  function notify(userId, req, title, body, link) {
    if (!userId || userId === req.user.id) return;
    db.prepare(`INSERT INTO notifications (workspace_id,user_id,category,severity,title,body,link)
      VALUES (?,?,'assessment','info',?,?,?)`).run(req.workspace.id,userId,title,body,link);
  }

  function assignableUsers(req) {
    return db.prepare(`SELECT DISTINCT u.id,u.name FROM users u LEFT JOIN workspace_members wm ON wm.user_id=u.id
      WHERE u.active=1 AND u.user_type='firm' AND (u.firm_id=? OR wm.workspace_id=?) ORDER BY u.name`)
      .all(req.workspace.firm_id,req.workspace.id);
  }

  app.get('/workspaces/:wsId/csf', requireAuth, requireWorkspace, (req,res) => {
    if (req.user.user_type === 'client') return res.redirect(`/workspaces/${req.workspace.id}/client-portal`);
    const engagements = model.programmeEngagements(db,req.workspace.id);
    const currentEngagement=engagements[0]||null;
    const programme=currentEngagement?model.programmeData(db,currentEngagement):null;
    res.render('csf2_engagements',{user:req.user,ws:req.workspace,active:'csf',engagements,currentEngagement,programme,
      canCreate:model.canCreate(req.user,req.workspace)});
  });

  // Stable sidebar destinations follow the most recent assessment cycle. This
  // prevents client navigation from baking a transient engagement id into the
  // shared workspace shell while still taking consultants directly to work.
  for (const section of ['scope','assessment','review','findings','report']) {
    app.get(`/workspaces/:wsId/csf/current/${section}`, requireAuth, requireWorkspace, (req,res) => {
      if (req.user.user_type === 'client') return res.redirect(`/workspaces/${req.workspace.id}/client-portal`);
      const current = model.programmeEngagements(db,req.workspace.id)[0];
      if (!current) return res.redirect(`/workspaces/${req.workspace.id}/csf`);
      const query = new URLSearchParams();
      for (const [key,value] of Object.entries(req.query||{})) if (typeof value === 'string') query.set(key,value);
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return res.redirect(`/workspaces/${req.workspace.id}/csf/${current.id}/${section}${suffix}`);
    });
  }

  app.get('/workspaces/:wsId/csf/new', requireAuth, requireWorkspace, (req,res) => {
    if (!model.canCreate(req.user,req.workspace)) return renderError(req,res,403,'You cannot create an assessment in this workspace.');
    res.render('csf2_new',{user:req.user,ws:req.workspace,active:'csf',assignableUsers:assignableUsers(req)});
  });

  app.post('/workspaces/:wsId/csf', requireAuth, requireWorkspace, (req,res) => {
    if (!model.canCreate(req.user,req.workspace)) return res.status(403).send('Forbidden');
    const name=clean(req.body.name,160), scope=clean(req.body.scope_statement);
    if (!name || scope.length<40) return redirectBack(req,res,'Name and a scope statement of at least 40 characters are required.','error');
    if (!req.body.period_start || !req.body.period_end || req.body.period_end<req.body.period_start) return redirectBack(req,res,'Enter a valid assessment period.','error');
    const lead=integerOrNull(req.body.assigned_lead_id)||req.user.id;
    const validLead=assignableUsers(req).some(u=>u.id===lead);
    if (!validLead) return res.status(400).send('Select an active consultant from this firm.');
    const engagementId=db.transaction(()=>{
      const id=Number(db.prepare(`INSERT INTO csf_engagements
        (workspace_id,catalog_version,name,period_start,period_end,target_completion_date,scope_mode,status,assigned_lead_id,created_by)
        VALUES (?,'2.0',?,?,?,?,?,'Draft',?,?)`).run(req.workspace.id,name,req.body.period_start,req.body.period_end,
          req.body.target_completion_date||null,'CURRENT_TARGET',lead,req.user.id).lastInsertRowid);
      db.prepare(`INSERT INTO csf_profile_contexts
        (engagement_id,workspace_id,scope_statement,methodology_version,status,prepared_by)
        VALUES (?,?,?,?,'draft',?)`).run(id,req.workspace.id,scope,methodology.METHODOLOGY_VERSION,req.user.id);
      db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments (engagement_id,user_id,role_on_engagement,assigned_by)
        VALUES (?,?,'ENGAGEMENT_LEAD',?)`).run(id,lead,req.user.id);
      if (lead!==req.user.id) db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments
        (engagement_id,user_id,role_on_engagement,assigned_by) VALUES (?,?,'CONSULTANT',?)`).run(id,req.user.id,req.user.id);
      const e=db.prepare(`SELECT * FROM csf_engagements WHERE id=?`).get(id); model.ensureAssessmentRows(db,e);
      return id;
    })();
    logAction(req.user.id,req.workspace.id,'csf_assessment_create','csf_engagement',engagementId,{methodology:methodology.METHODOLOGY_VERSION},auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/csf/${engagementId}/scope`);
  });

  app.get('/workspaces/:wsId/csf/catalog',requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf`));
  app.get('/workspaces/:wsId/csf/learn',requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf`));
  app.get('/workspaces/:wsId/csf/learn/:slug',requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf`));
  app.get('/workspaces/:wsId/csf/:id(\\d+)',requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf/${req.params.id}/assessment`));

  app.get('/workspaces/:wsId/csf/:id(\\d+)/scope',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req); if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    let profile=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(loaded.engagement.id);
    if(!profile){db.prepare(`INSERT INTO csf_profile_contexts (engagement_id,workspace_id,methodology_version,prepared_by) VALUES (?,?,?,?)`).run(loaded.engagement.id,req.workspace.id,methodology.METHODOLOGY_VERSION,req.user.id);profile=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(loaded.engagement.id);}
    res.render('csf2_scope',{user:req.user,ws:req.workspace,active:'csf',engagement:loaded.engagement,profile,
      canEdit:model.canAssess(db,req.user,loaded.engagement)&&profile.status!=='approved',canApprove:model.canApprove(db,req.user,loaded.engagement),
      defects:model.profileDefects(profile),methodologyVersion:methodology.METHODOLOGY_VERSION,catalogHash:methodology.CATALOG_HASH,methodologyHash:methodology.METHODOLOGY_HASH});
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/scope',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req); if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);
    if(!model.canAssess(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const profile=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(loaded.engagement.id);
    if(!profile||profile.status==='approved')return res.status(409).send('The approved Profile is frozen. Create a new assessment cycle to change its decision boundary.');
    if(Number(req.body.row_version)!==profile.row_version)return res.status(409).send('The Profile changed in another session. Reload and review the current version.');
    const action=req.body.action||'save';
    if(action==='approve'){
      if(!model.canApprove(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
      if(profile.status!=='submitted')return res.status(409).send('Submit the Profile before approval.');
      if(profile.submitted_by===req.user.id)return res.status(409).send('Independent approval is required; the submitter cannot approve the Profile.');
      if(model.profileDefects(profile).length)return res.status(409).send('The Profile is incomplete.');
      db.prepare(`UPDATE csf_profile_contexts SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP WHERE engagement_id=? AND row_version=?`).run(req.user.id,loaded.engagement.id,profile.row_version);
    } else {
      const vals=PROFILE_FIELDS.map(k=>clean(req.body[k])||null);
      db.prepare(`UPDATE csf_profile_contexts SET ${PROFILE_FIELDS.map(k=>`${k}=?`).join(',')},prepared_by=?,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP WHERE engagement_id=? AND row_version=?`).run(...vals,req.user.id,loaded.engagement.id,profile.row_version);
      const updated=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(loaded.engagement.id);
      if(action==='submit'){
        const defects=model.profileDefects(updated); if(defects.length)return res.status(409).send(defects.join(' '));
        db.prepare(`UPDATE csf_profile_contexts SET status='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP WHERE engagement_id=?`).run(req.user.id,loaded.engagement.id);
      }
    }
    logAction(req.user.id,req.workspace.id,`csf_profile_${action}`,'csf_engagement',loaded.engagement.id,null,auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/scope`,`Profile ${action==='save'?'saved':action+'ted'}`));
  });

  app.get('/workspaces/:wsId/csf/:id(\\d+)/assessment',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req); if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    const rollup=model.computeRollup(db,loaded.engagement); const filters={q:clean(req.query.q,120).toLowerCase(),function:clean(req.query.function,10).toUpperCase(),status:clean(req.query.status,40),gap:clean(req.query.gap,20)};
    const view=req.query.view==='outcomes'||filters.q||filters.status||filters.gap?'outcomes':'workbench';
    const selectedFunction=rollup.functions.find(f=>f.code===filters.function)||rollup.functions.find(f=>f.summary.assessed<f.summary.inScope)||rollup.functions[0];
    const rows=rollup.rows.filter(r=>(!filters.q||`${r.code} ${r.description}`.toLowerCase().includes(filters.q))&&(!filters.function||r.function_code===filters.function)&&(!filters.status||r.status===filters.status)&&
      (!filters.gap||(filters.gap==='divergence'&&r.policy_score!=null&&r.practice_score!=null&&Math.abs(r.policy_score-r.practice_score)>=2)||(filters.gap==='target'&&r.policy_score!=null&&r.practice_score!=null&&(r.policy_score<r.target_policy_score||r.practice_score<r.target_practice_score))||(filters.gap==='evidence'&&r.evidence_count===0)));
    res.render('csf2_assessment',{user:req.user,ws:req.workspace,active:'csf',engagement:loaded.engagement,rollup,rows,filters,view,selectedFunction,states:model.OUTCOME_STATES,maturityLabel:model.maturityLabel});
  });

  app.get('/workspaces/:wsId/csf/:id(\\d+)/assessment/category/:categoryCode',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    const rollup=model.computeRollup(db,loaded.engagement);
    let selectedFunction=null,category=null;
    for(const fn of rollup.functions){const found=fn.categories.find(c=>c.code===req.params.categoryCode);if(found){selectedFunction=fn;category=found;break;}}
    if(!category)return renderError(req,res,404,'Maturity category not found.');
    res.render('csf2_category',{user:req.user,ws:req.workspace,active:'csf',engagement:loaded.engagement,rollup,selectedFunction,category,maturityLabel:model.maturityLabel});
  });

  app.get('/workspaces/:wsId/csf/:id(\\d+)/assessment/:subId(\\d+)',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    const detail=loadAssessment(loaded.engagement,Number(req.params.subId));if(!detail)return renderError(req,res,404,'Outcome not found.');
    const method=model.methodologyRow(db,detail.subcategory_id);const methodData=CATALOG_BY_CODE.get(detail.code);
    const exceptions=db.prepare(`SELECT * FROM csf_assessment_exceptions WHERE assessment_id=? ORDER BY created_at DESC`).all(detail.id);
    const findings=db.prepare(`SELECT * FROM csf_findings WHERE assessment_id=? AND deleted_at IS NULL ORDER BY created_at DESC`).all(detail.id);
    const decisions=db.prepare(`SELECT d.*,u.name actor_name FROM csf_score_decisions d JOIN users u ON u.id=d.actor_id WHERE d.assessment_id=? ORDER BY d.created_at DESC,d.id DESC`).all(detail.id);
    res.render('csf2_outcome',{user:req.user,ws:req.workspace,active:'csf',engagement:loaded.engagement,detail,method,methodData,
      defects:model.outcomeReadiness(db,detail),evidence:model.evidenceFor(db,detail.id),tests:model.testsFor(db,detail.id),exceptions,findings,decisions,
      canAssess:model.canAssess(db,req.user,loaded.engagement),canScore:model.canScore(db,req.user,loaded.engagement),levels:methodology.LEVELS,
      priorities:model.PRIORITIES,assuranceOutcomes:model.ASSURANCE_OUTCOMES,evidenceAxes:model.EVIDENCE_AXES,evidenceQuality:model.EVIDENCE_QUALITY});
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/assessment/:subId(\\d+)',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);
    if(!model.canScore(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const old=loadAssessment(loaded.engagement,Number(req.params.subId));if(!old)return res.status(404).send('Outcome not found');
    if(Number(req.body.row_version)!==old.row_version)return res.status(409).send('This conclusion changed in another session. Reload before saving.');
    if(['Reviewed','Client Validated','Approved'].includes(old.status))return res.status(409).send('Return the conclusion to fieldwork before changing a governed decision.');
    let applicability=req.body.applicability_status==='not_applicable'?'not_applicable':'in_scope';
    let assurance=model.ASSURANCE_OUTCOMES.includes(req.body.assurance_outcome)?req.body.assurance_outcome:'not_assessed';
    let policy=integerOrNull(req.body.policy_score),practice=integerOrNull(req.body.practice_score),targetPolicy=integerOrNull(req.body.target_policy_score),targetPractice=integerOrNull(req.body.target_practice_score);
    if(applicability==='not_applicable'){policy=practice=targetPolicy=targetPractice=null;assurance='not_applicable';}
    if(assurance==='no_visibility'){policy=practice=null;}
    for(const n of [policy,practice,targetPolicy,targetPractice])if(n!=null&&(n<0||n>5))return res.status(400).send('Scores must be whole numbers from 0 to 5.');
    const action=req.body.action==='complete'?'complete':'save';
    try{db.transaction(()=>{
      db.prepare(`UPDATE csf_subcategory_assessments SET applicability_status=?,profile_priority=?,current_profile_statement=?,target_profile_statement=?,business_impact=?,exclusion_rationale=?,
        policy_score=?,practice_score=?,target_policy_score=?,target_practice_score=?,policy_rationale=?,practice_rationale=?,policy_owner=?,practice_owner=?,assurance_outcome=?,evidence_confidence=?,
        assessment_period_start=?,assessment_period_end=?,population_description=?,population_size=?,sample_size=?,sample_rationale=?,review_conclusion=?,methodology_version=?,
        policy_scored_by=?,practice_scored_by=?,status=?,row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?`).run(applicability,model.PRIORITIES.includes(req.body.profile_priority)?req.body.profile_priority:'medium',clean(req.body.current_profile_statement)||null,
          clean(req.body.target_profile_statement)||null,clean(req.body.business_impact)||null,clean(req.body.exclusion_rationale)||null,policy,practice,targetPolicy,targetPractice,
          clean(req.body.policy_rationale)||null,clean(req.body.practice_rationale)||null,clean(req.body.policy_owner,200)||null,clean(req.body.practice_owner,200)||null,assurance,
          ['low','medium','high'].includes(req.body.evidence_confidence)?req.body.evidence_confidence:null,req.body.assessment_period_start||null,req.body.assessment_period_end||null,
          clean(req.body.population_description)||null,integerOrNull(req.body.population_size),integerOrNull(req.body.sample_size),clean(req.body.sample_rationale)||null,
          clean(req.body.review_conclusion)||null,methodology.METHODOLOGY_VERSION,policy!==old.policy_score?req.user.id:old.policy_scored_by,
          practice!==old.practice_score?req.user.id:old.practice_scored_by,action==='complete'?'Assessor Complete':(old.status==='Not Started'?'Fieldwork':old.status),req.user.id,old.id,old.row_version);
      const current=db.prepare(`SELECT * FROM csf_subcategory_assessments WHERE id=?`).get(old.id);
      if(action==='complete'){const defects=model.outcomeReadiness(db,current);if(defects.length){const err=new Error(defects.join(' '));err.validation=true;throw err;}}
      decision(req,loaded.engagement,old,'policy',old.policy_score,policy,req.body.policy_rationale);
      decision(req,loaded.engagement,old,'practice',old.practice_score,practice,req.body.practice_rationale);
      decision(req,loaded.engagement,old,'target_policy',old.target_policy_score,targetPolicy,req.body.policy_rationale);
      decision(req,loaded.engagement,old,'target_practice',old.target_practice_score,targetPractice,req.body.practice_rationale);
      decision(req,loaded.engagement,old,'applicability',old.applicability_status,applicability,req.body.exclusion_rationale);
      decision(req,loaded.engagement,old,'assurance',old.assurance_outcome,assurance,req.body.review_conclusion);
      event(loaded.engagement.id,old.id,action==='complete'?'assessor_complete':'assessment_saved',old.status,current.status,req.user.id,{row_version:current.row_version});
    })();}catch(err){if(err.validation)return res.status(409).send(err.message);throw err;}
    logAction(req.user.id,req.workspace.id,`csf_assessment_${action}`,'csf_subcategory_assessment',old.id,{code:old.code},auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/assessment/${old.subcategory_id}`,action==='complete'?'Conclusion submitted for review':'Assessment decision saved'));
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/assessment/:subId(\\d+)/evidence',requireAuth,requireWorkspace,upload.single('file'),(req,res)=>{
    const cleanup=()=>{try{if(req.file?.path)fs.unlinkSync(req.file.path);}catch(_){}};
    const loaded=loadEngagement(req);if(loaded.error){cleanup();return res.status(loaded.error.status).send(loaded.error.message);}if(!model.canAssess(db,req.user,loaded.engagement)){cleanup();return res.status(403).send('Forbidden');}
    const assessment=loadAssessment(loaded.engagement,Number(req.params.subId));if(!assessment){cleanup();return res.status(404).send('Outcome not found');}
    const type=['FILE','URL','INTERVIEW','OBSERVATION'].includes(req.body.type)?req.body.type:'FILE';
    const axis=model.EVIDENCE_AXES.includes(req.body.evidence_axis)?req.body.evidence_axis:'both';const quality=model.EVIDENCE_QUALITY.includes(req.body.evidence_quality)?req.body.evidence_quality:'fair';
    const description=clean(req.body.description,1000),relevance=clean(req.body.relevance_note,4000),url=clean(req.body.url,2000)||null;
    if(!description||!relevance){cleanup();return res.status(400).send('Description and relevance are required.');}
    if(type==='FILE'&&!req.file){cleanup();return res.status(400).send('Select a file.');}
    if(type==='URL'){try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw new Error();}catch(_){cleanup();return res.status(400).send('Enter a valid HTTP or HTTPS URL.');}}
    let evidenceId=null,filePath=null;
    if(type==='FILE'){
      const inspection=uploadSecurity.validateUpload(req.file,FILE_EXTENSIONS);if(!inspection.ok){cleanup();return res.status(400).send(inspection.message);}
      const sha=crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
      const prior=db.prepare(`SELECT id,stored_path FROM evidence WHERE workspace_id=? AND sha256=? ORDER BY id DESC LIMIT 1`).get(req.workspace.id,sha);
      if(prior){evidenceId=prior.id;filePath=prior.stored_path;cleanup();}else{filePath=req.file.filename;evidenceId=Number(db.prepare(`INSERT INTO evidence
        (workspace_id,filename,stored_path,sha256,size_bytes,uploaded_by,description) VALUES (?,?,?,?,?,?,?)`).run(req.workspace.id,req.file.originalname,filePath,sha,req.file.size,req.user.id,description).lastInsertRowid);}
    }else cleanup();
    const id=Number(db.prepare(`INSERT INTO csf_evidence_items
      (assessment_id,type,file_path,url,interview_source,description,uploaded_by,evidence_id,evidence_period_start,evidence_period_end,confidentiality,relevance_note,evidence_axis,evidence_quality,source_reliability,scope_coverage,testing_method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(assessment.id,type,filePath,type==='URL'?url:null,type==='INTERVIEW'?description:null,description,req.user.id,evidenceId,
        req.body.evidence_period_start||null,req.body.evidence_period_end||null,'internal',relevance,axis,quality,['low','medium','high'].includes(req.body.source_reliability)?req.body.source_reliability:null,
        clean(req.body.scope_coverage,1000)||null,clean(req.body.testing_method,1000)||null).lastInsertRowid);
    if(assessment.status==='Not Started')db.prepare(`UPDATE csf_subcategory_assessments SET status='Fieldwork',row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id,assessment.id);
    logAction(req.user.id,req.workspace.id,'csf_evidence_add','csf_evidence_item',id,{axis,quality},auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/assessment/${assessment.subcategory_id}`,'Evidence retained'));
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/assessment/:subId(\\d+)/test',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);if(!model.canAssess(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const assessment=loadAssessment(loaded.engagement,Number(req.params.subId));if(!assessment)return res.status(404).send('Outcome not found');
    const method=model.methodologyRow(db,assessment.subcategory_id),code=clean(req.body.test_code,80),procedure=clean(req.body.procedure_text,4000);
    const allowed=method.test_procedures.some((p,i)=>code===`${assessment.code}-T${i+1}`&&procedure===p);if(!allowed)return res.status(400).send('Use a controlled methodology procedure.');
    const axis=['policy','practice','both'].includes(req.body.axis)?req.body.axis:'both',result=['not_run','pass','partial','fail','no_visibility','not_applicable'].includes(req.body.result)?req.body.result:'not_run';
    db.prepare(`INSERT INTO csf_assessment_tests (workspace_id,engagement_id,assessment_id,test_code,axis,procedure_text,sample_size,result,conclusion,performed_by,performed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='not_run' THEN NULL ELSE CURRENT_TIMESTAMP END)
      ON CONFLICT(assessment_id,test_code) DO UPDATE SET axis=excluded.axis,sample_size=excluded.sample_size,result=excluded.result,conclusion=excluded.conclusion,
      performed_by=excluded.performed_by,performed_at=excluded.performed_at,updated_at=CURRENT_TIMESTAMP`).run(req.workspace.id,loaded.engagement.id,assessment.id,code,axis,procedure,integerOrNull(req.body.sample_size),result,clean(req.body.conclusion)||null,req.user.id,result);
    logAction(req.user.id,req.workspace.id,'csf_test_save','csf_subcategory_assessment',assessment.id,{code,result},auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/assessment/${assessment.subcategory_id}`,'Test work saved'));
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/assessment/:subId(\\d+)/exception',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);if(!model.canAssess(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const assessment=loadAssessment(loaded.engagement,Number(req.params.subId));if(!assessment)return res.status(404).send('Outcome not found');
    if(!clean(req.body.title)||!clean(req.body.scope)||clean(req.body.justification).length<40||!req.body.expires_on||!req.body.next_review_on)return res.status(400).send('Complete the exception scope, justification, expiry, and review date.');
    const id=Number(db.prepare(`INSERT INTO csf_assessment_exceptions
      (workspace_id,engagement_id,assessment_id,title,scope,justification,compensating_controls,residual_risk,expires_on,next_review_on,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.workspace.id,loaded.engagement.id,assessment.id,clean(req.body.title,200),clean(req.body.scope,1000),clean(req.body.justification),
        clean(req.body.compensating_controls)||null,['low','medium','high','critical'].includes(req.body.residual_risk)?req.body.residual_risk:'medium',req.body.expires_on,req.body.next_review_on,req.user.id).lastInsertRowid);
    logAction(req.user.id,req.workspace.id,'csf_exception_create','csf_assessment_exception',id,null,auditCtx(req));res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/assessment/${assessment.subcategory_id}`,'Exception recorded'));
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/assessment/:subId(\\d+)/finding',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);if(!model.canAssess(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const assessment=loadAssessment(loaded.engagement,Number(req.params.subId));if(!assessment)return res.status(404).send('Outcome not found');
    const title=clean(req.body.title,240),description=clean(req.body.description);if(!title||description.length<40)return res.status(400).send('Finding title and a complete condition/risk statement are required.');
    const id=Number(db.prepare(`INSERT INTO csf_findings (engagement_id,assessment_id,title,description,severity,status,created_by) VALUES (?,?,?,?,?,'Draft',?)`).run(loaded.engagement.id,assessment.id,title,description,['CRITICAL','HIGH','MEDIUM','LOW'].includes(req.body.severity)?req.body.severity:'MEDIUM',req.user.id).lastInsertRowid);
    logAction(req.user.id,req.workspace.id,'csf_finding_create','csf_finding',id,null,auditCtx(req));res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/assessment/${assessment.subcategory_id}`,'Finding created'));
  });

  app.get('/workspaces/:wsId/csf/:id(\\d+)/review',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    const rollup=model.computeRollup(db,loaded.engagement);const reviewStates=new Set(['Assessor Complete','Reviewed','Client Validated','Approved']);
    const rows=rollup.rows.filter(r=>reviewStates.has(r.status)).map(r=>({...r,defects:model.outcomeReadiness(db,r)}));
    const counts={};rollup.rows.forEach(r=>{counts[r.status]=(counts[r.status]||0)+1;});
    res.render('csf2_review',{user:req.user,ws:req.workspace,active:'csf',engagement:loaded.engagement,rows,counts,totalDefects:rows.reduce((n,r)=>n+r.defects.length,0),canReview:model.canReview(db,req.user,loaded.engagement),canApprove:model.canApprove(db,req.user,loaded.engagement)});
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/review/:subId(\\d+)',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);
    const assessment=loadAssessment(loaded.engagement,Number(req.params.subId));if(!assessment)return res.status(404).send('Outcome not found');
    const action=req.body.action,note=clean(req.body.note,8000);if(note.length<40)return res.status(400).send('Record a review conclusion of at least 40 characters.');
    let next=assessment.status;
    if(action==='review'){
      if(!model.canReview(db,req.user,loaded.engagement)||assessment.status!=='Assessor Complete')return res.status(409).send('Conclusion is not ready for review.');
      if([assessment.policy_scored_by,assessment.practice_scored_by].includes(req.user.id))return res.status(409).send('Independent review is required; a scorer cannot review their own conclusion.');
      const defects=model.outcomeReadiness(db,assessment);if(defects.length)return res.status(409).send(defects.join(' '));next='Reviewed';
      db.prepare(`UPDATE csf_subcategory_assessments SET status='Reviewed',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_conclusion=?,row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id,note,req.user.id,assessment.id);
    }else if(action==='return'){
      if(!model.canReview(db,req.user,loaded.engagement)||assessment.status!=='Assessor Complete')return res.status(409).send('Only assessor-complete conclusions can be returned.');next='Fieldwork';
      db.prepare(`UPDATE csf_subcategory_assessments SET status='Fieldwork',review_conclusion=?,row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(note,req.user.id,assessment.id);
    }else if(action==='request_client'){
      if(!model.canReview(db,req.user,loaded.engagement)||assessment.status!=='Reviewed')return res.status(409).send('Complete independent review first.');
      const client=db.prepare(`SELECT u.id FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? AND u.user_type='client' AND u.active=1 ORDER BY CASE wm.role WHEN 'client_owner' THEN 1 WHEN 'isms_manager' THEN 2 ELSE 3 END,u.id LIMIT 1`).get(req.workspace.id);
      if(!client)return res.status(409).send('Add an active client contact before requesting factual validation.');
      const requestId=db.transaction(()=>{
        const rid=Number(db.prepare(`INSERT INTO client_requests (workspace_id,request_type,title,description,priority,assignee_id,created_by) VALUES (?,'action',?,?, 'normal',?,?)`).run(req.workspace.id,`Validate ${assessment.code} assessment facts`,note,client.id,req.user.id).lastInsertRowid);
        db.prepare(`INSERT INTO client_request_events (request_id,workspace_id,actor_id,event_type,note) VALUES (?,?,?,'created',?)`).run(rid,req.workspace.id,req.user.id,`NIST CSF ${assessment.code} factual validation`);
        db.prepare(`INSERT INTO csf_action_links (workspace_id,engagement_id,assessment_id,client_request_id,linked_by) VALUES (?,?,?,?,?)`).run(req.workspace.id,loaded.engagement.id,assessment.id,rid,req.user.id);
        db.prepare(`UPDATE csf_subcategory_assessments SET client_validation_status='requested',row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id,assessment.id);return rid;
      })();
      notify(client.id,req,'Assessment validation requested',`${assessment.code} requires factual validation.`,`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/portal`);
      event(loaded.engagement.id,assessment.id,'client_validation_requested',assessment.status,assessment.status,req.user.id,{request_id:requestId,note});
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/review`,'Client factual validation requested'));
    }else if(action==='approve'){
      if(!model.canApprove(db,req.user,loaded.engagement)||assessment.status!=='Client Validated')return res.status(409).send('Client factual validation must be complete.');
      if([assessment.policy_scored_by,assessment.practice_scored_by,assessment.reviewed_by].includes(req.user.id))return res.status(409).send('Independent approval is required; scorers and reviewer cannot approve this conclusion.');next='Approved';
      db.prepare(`UPDATE csf_subcategory_assessments SET status='Approved',approved_by=?,approved_at=CURRENT_TIMESTAMP,row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id,req.user.id,assessment.id);
    }else return res.status(400).send('Unknown review action.');
    event(loaded.engagement.id,assessment.id,`assessment_${action}`,assessment.status,next,req.user.id,{note});
    logAction(req.user.id,req.workspace.id,`csf_assessment_${action}`,'csf_subcategory_assessment',assessment.id,null,auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/review`,`Conclusion ${action==='return'?'returned':action+'ed'}`));
  });

  app.get('/workspaces/:wsId/csf/:id(\\d+)/findings',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    const raw=db.prepare(`SELECT f.*,s.code,(SELECT al.task_id FROM csf_action_links al WHERE al.recommendation_id=r.id AND al.task_id IS NOT NULL LIMIT 1) task_id,
        r.id rec_id,r.description rec_title,r.priority rec_priority,r.roadmap_phase rec_phase,r.target_completion_date rec_due
      FROM csf_findings f LEFT JOIN csf_subcategory_assessments a ON a.id=f.assessment_id LEFT JOIN csf_subcategories s ON s.id=a.subcategory_id
      LEFT JOIN csf_recommendations r ON r.finding_id=f.id AND r.deleted_at IS NULL WHERE f.engagement_id=? AND f.deleted_at IS NULL
      ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,f.id`).all(loaded.engagement.id);
    const map=new Map();for(const r of raw){if(!map.has(r.id))map.set(r.id,{...r,recommendations:[]});if(r.rec_id)map.get(r.id).recommendations.push({id:r.rec_id,title:r.rec_title,priority:r.rec_priority,roadmap_phase:r.rec_phase,target_completion_date:r.rec_due,task_id:r.task_id});}
    const findings=[...map.values()],severityCounts={};findings.forEach(f=>severityCounts[f.severity]=(severityCounts[f.severity]||0)+1);
    res.render('csf2_findings',{user:req.user,ws:req.workspace,active:'csf',engagement:loaded.engagement,findings,severityCounts,recommendationCount:findings.reduce((n,f)=>n+f.recommendations.length,0),canManage:model.canAssess(db,req.user,loaded.engagement),roadmapLabels:{'0_3M':'Now-3 months','3_6M':'3-6 months','6_12M':'6-12 months','12M_PLUS':'12+ months'}});
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/findings/:findingId(\\d+)/recommendation',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);if(!model.canAssess(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const finding=db.prepare(`SELECT * FROM csf_findings WHERE id=? AND engagement_id=? AND deleted_at IS NULL`).get(req.params.findingId,loaded.engagement.id);if(!finding)return res.status(404).send('Finding not found');
    const title=clean(req.body.title);if(!title)return res.status(400).send('Recommendation is required.');
    const id=Number(db.prepare(`INSERT INTO csf_recommendations (finding_id,description,priority,roadmap_phase,created_by) VALUES (?,?,?,?,?)`).run(finding.id,title,['HIGH','MED','LOW'].includes(req.body.priority)?req.body.priority:'MED',['0_3M','3_6M','6_12M','12M_PLUS'].includes(req.body.roadmap_phase)?req.body.roadmap_phase:'3_6M',req.user.id).lastInsertRowid);
    logAction(req.user.id,req.workspace.id,'csf_recommendation_create','csf_recommendation',id,null,auditCtx(req));res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/findings`,'Recommendation added'));
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/recommendations/:recId(\\d+)/task',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);if(!model.canAssess(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const rec=db.prepare(`SELECT r.*,f.title finding_title FROM csf_recommendations r JOIN csf_findings f ON f.id=r.finding_id WHERE r.id=? AND f.engagement_id=? AND r.deleted_at IS NULL AND f.deleted_at IS NULL`).get(req.params.recId,loaded.engagement.id);if(!rec)return res.status(404).send('Recommendation not found');
    if(db.prepare(`SELECT 1 FROM csf_action_links WHERE recommendation_id=? AND task_id IS NOT NULL`).get(rec.id))return res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/findings`,'A task is already linked'));
    const taskId=db.transaction(()=>{const id=Number(db.prepare(`INSERT INTO tasks (workspace_id,title,description,due_date,status,created_by) VALUES (?,?,?,?,'todo',?)`).run(req.workspace.id,`CSF: ${rec.finding_title}`,rec.description,rec.target_completion_date||null,req.user.id).lastInsertRowid);db.prepare(`INSERT INTO csf_action_links (workspace_id,engagement_id,recommendation_id,task_id,linked_by) VALUES (?,?,?,?,?)`).run(req.workspace.id,loaded.engagement.id,rec.id,id,req.user.id);return id;})();
    logAction(req.user.id,req.workspace.id,'csf_recommendation_task_create','task',taskId,{recommendation_id:rec.id},auditCtx(req));res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/findings`,'Central task created'));
  });

  app.get('/workspaces/:wsId/csf/:id(\\d+)/report',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    const versions=db.prepare(`SELECT * FROM csf_assessment_versions_v2 WHERE engagement_id=? ORDER BY id DESC`).all(loaded.engagement.id);
    res.render('csf2_report',{user:req.user,ws:req.workspace,active:'csf',engagement:loaded.engagement,rollup:model.computeRollup(db,loaded.engagement),versions,publicationDefects:model.publicationDefects(db,loaded.engagement),canCreateVersion:model.canScore(db,req.user,loaded.engagement),canReview:model.canReview(db,req.user,loaded.engagement),canApprove:model.canApprove(db,req.user,loaded.engagement)});
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/report/version',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);if(!model.canScore(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const summary=clean(req.body.change_summary,1000);if(summary.length<20)return res.status(400).send('Describe the purpose and material changes.');
    const versionId=model.createVersion(db,loaded.engagement,req.user,summary);logAction(req.user.id,req.workspace.id,'csf_version_create','csf_assessment_version_v2',versionId,null,auditCtx(req));res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/report`,'Immutable draft created'));
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/report/version/:versionId(\\d+)',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req);if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);
    const version=db.prepare(`SELECT * FROM csf_assessment_versions_v2 WHERE id=? AND engagement_id=? AND workspace_id=?`).get(req.params.versionId,loaded.engagement.id,req.workspace.id);if(!version)return res.status(404).send('Version not found');
    const action=req.body.action;
    if(action==='review'){
      if(!model.canReview(db,req.user,loaded.engagement)||version.status!=='draft')return res.status(409).send('Draft is not reviewable.');if(version.created_by===req.user.id)return res.status(409).send('The version creator cannot independently review it.');
      db.prepare(`UPDATE csf_assessment_versions_v2 SET status='reviewed',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id,version.id);
    }else if(action==='approve'){
      if(!model.canApprove(db,req.user,loaded.engagement)||version.status!=='reviewed')return res.status(409).send('Reviewed version is required.');if([version.created_by,version.reviewed_by].includes(req.user.id))return res.status(409).send('Independent approval is required.');
      db.prepare(`UPDATE csf_assessment_versions_v2 SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id,version.id);
    }else if(action==='publish'){
      if(!model.canApprove(db,req.user,loaded.engagement)||version.status!=='approved')return res.status(409).send('Approved version is required.');const defects=model.publicationDefects(db,loaded.engagement);if(defects.length)return res.status(409).send(defects.join(' '));
      db.transaction(()=>{db.prepare(`UPDATE csf_assessment_versions_v2 SET is_current=0,status=CASE WHEN status='published' THEN 'superseded' ELSE status END WHERE engagement_id=? AND is_current=1`).run(loaded.engagement.id);db.prepare(`UPDATE csf_assessment_versions_v2 SET status='published',published_by=?,published_at=CURRENT_TIMESTAMP,is_current=1 WHERE id=?`).run(req.user.id,version.id);db.prepare(`UPDATE csf_engagements SET status='Published',visible_in_portal=1,current_version=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(version.version_number,loaded.engagement.id);})();
    }else return res.status(400).send('Unknown version action.');
    logAction(req.user.id,req.workspace.id,`csf_version_${action}`,'csf_assessment_version_v2',version.id,null,auditCtx(req));res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/report`,`Version ${action}ed`));
  });

  app.get('/workspaces/:wsId/csf/:id(\\d+)/portal',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req,{portal:true});if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    let validationRows=db.prepare(`SELECT a.*,s.code,s.description FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id
      WHERE a.engagement_id=? AND a.status='Reviewed' AND a.client_validation_status='requested' ORDER BY s.code`).all(loaded.engagement.id);
    if(req.user.user_type==='client'&&['contributor'].includes(req.workspace._userRole||req.workspace.role))validationRows=validationRows.filter(r=>db.prepare(`SELECT 1 FROM csf_action_links l JOIN client_requests cr ON cr.id=l.client_request_id WHERE l.assessment_id=? AND cr.assignee_id=?`).get(r.id,req.user.id));
    const versions=db.prepare(`SELECT * FROM csf_assessment_versions_v2 WHERE engagement_id=? AND status='published' ORDER BY published_at DESC`).all(loaded.engagement.id);
    res.render('csf2_portal',{user:req.user,ws:req.workspace,active:'client-portal',engagement:loaded.engagement,validationRows,versions});
  });

  app.post('/workspaces/:wsId/csf/:id(\\d+)/portal/validate/:subId(\\d+)',requireAuth,requireWorkspace,(req,res)=>{
    const loaded=loadEngagement(req,{portal:true});if(loaded.error)return res.status(loaded.error.status).send(loaded.error.message);
    if(req.user.user_type!=='client'&&!model.canApprove(db,req.user,loaded.engagement))return res.status(403).send('Forbidden');
    const assessment=loadAssessment(loaded.engagement,Number(req.params.subId));if(!assessment||assessment.status!=='Reviewed'||assessment.client_validation_status!=='requested')return res.status(409).send('This information is not waiting for your confirmation.');
    if(req.user.user_type==='client'&&(req.workspace._userRole||req.workspace.role)==='contributor'&&!db.prepare(`SELECT 1 FROM csf_action_links l JOIN client_requests cr ON cr.id=l.client_request_id WHERE l.assessment_id=? AND cr.assignee_id=?`).get(assessment.id,req.user.id))return res.status(403).send('This information check is assigned to another person.');
    const decisionName=req.body.decision==='changes_requested'?'changes_requested':'validated',note=clean(req.body.note,8000);if(decisionName==='changes_requested'&&note.length<20)return res.status(400).send('Explain what needs to be corrected.');
    const next=decisionName==='validated'?'Client Validated':'Fieldwork';db.prepare(`UPDATE csf_subcategory_assessments SET status=?,client_validation_status=?,client_validated_by=?,client_validated_at=CASE WHEN ?='validated' THEN CURRENT_TIMESTAMP ELSE NULL END,row_version=row_version+1,last_edited_by=?,last_edited_at=CURRENT_TIMESTAMP WHERE id=?`).run(next,decisionName,decisionName==='validated'?req.user.id:null,decisionName,req.user.id,assessment.id);
    event(loaded.engagement.id,assessment.id,'client_validation',assessment.status,next,req.user.id,{decision:decisionName,note:note||null});logAction(req.user.id,req.workspace.id,'csf_client_validation','csf_subcategory_assessment',assessment.id,{decision:decisionName},auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/csf/${loaded.engagement.id}/portal`,decisionName==='validated'?'Information confirmed':'Changes requested'));
  });

  async function exportVersion(req,res,kind){
    const loaded=loadEngagement(req,{portal:req.user.user_type==='client'});if(loaded.error)return renderError(req,res,loaded.error.status,loaded.error.message);
    let version;
    if(req.query.version)version=db.prepare(`SELECT * FROM csf_assessment_versions_v2 WHERE id=? AND engagement_id=?`).get(req.query.version,loaded.engagement.id);
    else version=db.prepare(`SELECT * FROM csf_assessment_versions_v2 WHERE engagement_id=? ${req.user.user_type==='client'?"AND status='published'":""} ORDER BY is_current DESC,id DESC LIMIT 1`).get(loaded.engagement.id);
    if(!version)return res.status(404).send(req.user.user_type==='client'?'No report is available yet.':'No controlled version is available.');if(req.user.user_type==='client'&&version.status!=='published')return res.status(403).send('Only published reports are available.');
    const reportModel=reports.loadVersionModel(db,req.workspace.id,loaded.engagement.id,version.id);if(!reportModel)return res.status(404).send('Version not found.');
    const reportMeta=reports.reportMeta(reportModel);const reportSuffix=reportMeta.complete?'Assessment':'Progress';
    const base=`${loaded.engagement.name.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')}-CSF-${reportSuffix}-${version.version_number}`;
    try{
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');
      if(kind==='csv'){const data='\ufeff'+reports.csv(reportModel);res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${base}.csv"`);logAction(req.user.id,req.workspace.id,'csf_report_export_csv','csf_assessment_version_v2',version.id,{bytes:Buffer.byteLength(data),complete:reportMeta.complete},auditCtx(req));return res.send(data);}
      const html=reports.reportHtml(reportModel);
      if(kind==='pdf'){const raw=await auditPack.renderPDF(html,{headerLeft:`${loaded.engagement.name} - NIST CSF 2.0`,headerRight:`Version ${version.version_number}`,footerLeft:reportMeta.footer});const pdf=reports.asBuffer(raw);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${base}.pdf"`);res.setHeader('Content-Length',pdf.length);logAction(req.user.id,req.workspace.id,'csf_report_export_pdf','csf_assessment_version_v2',version.id,{bytes:pdf.length,complete:reportMeta.complete,published:reportMeta.published},auditCtx(req));return res.send(pdf);}
      const raw=await htmlToDocxPooled(html,null,{title:`${loaded.engagement.name} NIST CSF 2.0 ${reportSuffix.toLowerCase()} report`,creator:req.workspace.brand_display_name||req.workspace.client_name||'Compliance Sphere',pageNumber:true});const docx=reports.asBuffer(raw);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');res.setHeader('Content-Disposition',`attachment; filename="${base}.docx"`);res.setHeader('Content-Length',docx.length);logAction(req.user.id,req.workspace.id,'csf_report_export_docx','csf_assessment_version_v2',version.id,{bytes:docx.length,complete:reportMeta.complete,published:reportMeta.published},auditCtx(req));return res.send(docx);
    }catch(err){console.error('[CSF export]',err);return res.status(500).render('error',{user:req.user,ws:req.workspace,message:req.user.user_type==='client'?'The report could not be generated. Please retry or contact support.':'The controlled report could not be generated. Please retry or contact support.'});}
  }
  app.get('/workspaces/:wsId/csf/:id(\\d+)/exports/report.pdf',requireAuth,requireWorkspace,requireInternalExport,(req,res)=>exportVersion(req,res,'pdf'));
  app.get('/workspaces/:wsId/csf/:id(\\d+)/exports/report.docx',requireAuth,requireWorkspace,requireInternalExport,(req,res)=>exportVersion(req,res,'docx'));
  app.get('/workspaces/:wsId/csf/:id(\\d+)/exports/data.csv',requireAuth,requireWorkspace,requireInternalExport,(req,res)=>exportVersion(req,res,'csv'));

  // Historical deep links resolve to the corresponding replacement surface.
  for(const old of ['profile'])app.get(`/workspaces/:wsId/csf/:id(\\d+)/${old}`,requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf/${req.params.id}/scope`));
  for(const old of ['assess','scores','tiers'])app.get(`/workspaces/:wsId/csf/:id(\\d+)/${old}`,requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf/${req.params.id}/assessment`));
  app.get('/workspaces/:wsId/csf/:id(\\d+)/assess/:subId(\\d+)',requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf/${req.params.id}/assessment/${req.params.subId}`));
  for(const old of ['versions','publish'])app.get(`/workspaces/:wsId/csf/:id(\\d+)/${old}`,requireAuth,requireWorkspace,(req,res)=>res.redirect(`/workspaces/${req.workspace.id}/csf/${req.params.id}/report`));
}

module.exports={register};
