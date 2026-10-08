'use strict';

const rbac = require('../lib/rbac');
const enc = require('../lib/encryption');
const consulting = require('../lib/consulting-delivery');
const engagementDelivery = require('../lib/engagement-delivery');
const isoLifecycle = require('../lib/iso-lifecycle');
const gapFieldwork = require('../lib/gap-fieldwork');
const drafts = require('../lib/form-drafts');

const ENGAGEMENT_TYPES = new Set(['implementation','readiness','internal_audit','gap_assessment','advisory','surveillance']);
const GAP_ONLY_ENGAGEMENT_TYPES = new Set(['gap_assessment','advisory']);

function register(app,deps) {
  const { db,requireAuth,requireWorkspace,requirePermission,withToast,logAction,auditCtx,listWorkspaces } = deps;
  const base = wsId => `/workspaces/${wsId}/delivery`;
  const firmOnly = (req,res,next) => req.user.user_type === 'firm'
    ? next()
    : res.status(403).render('error',{ user:req.user,ws:req.workspace,message:'Consultant workpapers and commercial records are internal to the consulting firm.' });
  const requireFirmPermission = permission => (req,res,next) => {
    if (req.user?.user_type !== 'firm') return next();
    return requirePermission(permission)(req,res,next);
  };
  const redirect = (req,res,path,message,kind) => res.redirect(withToast(path || base(req.workspace.id),message,kind));
  const run = (req,res,fn,message,path) => {
    try { const value=fn(); return redirect(req,res,typeof path==='function'?path(value):path,message); }
    catch(error) {
      if (req.params.id && req.path.includes('/delivery/workpapers/')) return renderWorkpaper(req,res,error,req.body);
      const target=typeof path==='string'?path:base(req.workspace.id);
      return redirect(req,res,target,error.message || 'The update could not be completed.','error');
    }
  };
  const num = (value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={}) => {
    const n=Number(value); if(!Number.isFinite(n)||n<min||n>max) throw new Error(`${label} is invalid.`); return n;
  };
  const money = value => Math.round(num(value||0,'Amount',{min:-1000000000,max:1000000000})*100);
  const hasIso27001 = workspace => {
    if (Array.isArray(workspace.frameworks)) return workspace.frameworks.includes('iso27001');
    try { return JSON.parse(workspace.frameworks || '[]').includes('iso27001'); }
    catch (_) { return false; }
  };
  const assertGapClosureMutable = (req, engagementId) => {
    if (!hasIso27001(req.workspace) || !isoLifecycle.isGapOnly(req.workspace.engagement_outcome)) return;
    const row = db.prepare('SELECT status FROM consulting_engagements WHERE id=? AND workspace_id=?')
      .get(Number(engagementId), req.workspace.id);
    if (row?.status === 'complete') {
      throw new Error('This gap-assessment engagement is formally closed. Start a new governed engagement before changing retained workpapers, RFIs or findings.');
    }
  };
  const reconcileDeliveryCompletion = (req, context = {}) => {
    if (!hasIso27001(req.workspace)) return;
    if (!db.prepare('SELECT 1 FROM engagement_delivery_plans WHERE workspace_id=?').get(req.workspace.id)) return;
    engagementDelivery.reconcileCompletionState(db, req.workspace, req.user.id, context);
    engagementDelivery.syncOutcomePlanStatus(db, req.workspace, req.user.id);
    engagementDelivery.syncCertificationEngagementCompletion(db, req.workspace, req.user.id);
  };
  const engagement = req => consulting.engagementFor(db,req.workspace,req.user.id,req.body.engagement_id||req.query.engagement);
  const completionPosition = (workspace,row,actorId) => {
    const isoContract=isoLifecycle.hasIsoManagementSystem(workspace);
    const aimsDelivery=require('../lib/iso42001-delivery');
    const aimsContract=aimsDelivery.isAims(workspace);
    const gapOnlyContract=isoContract&&isoLifecycle.isGapOnly(workspace.engagement_outcome);
    const gapOnly=gapOnlyContract&&row.engagement_type==='gap_assessment';
    const openWorkpapers=Number(db.prepare(`SELECT COUNT(*) c FROM consultant_workpapers
      WHERE engagement_id=? AND status NOT IN ('frozen','superseded')`).get(row.id).c||0);
    const openRequests=Number(db.prepare(`SELECT COUNT(*) c FROM client_requests
      WHERE engagement_id=? AND status NOT IN ('accepted','cancelled')`).get(row.id).c||0);
    const openFindings=Number(db.prepare(`SELECT COUNT(*) c FROM consulting_findings
      WHERE engagement_id=? AND status NOT IN ('draft','withdrawn','closed')`).get(row.id).c||0);
    let publishedReport=db.prepare(`SELECT id FROM consulting_report_snapshots
      WHERE engagement_id=? AND report_type IN ('assessment','readiness') AND status='published'
        AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND published_at IS NOT NULL
        AND approved_by<>generated_by ORDER BY published_at DESC,id DESC LIMIT 1`).get(row.id)||null;
    const blockers=[];
    if(openWorkpapers) blockers.push(`Freeze or supersede ${openWorkpapers} open workpaper${openWorkpapers===1?'':'s'}.`);
    if(openRequests) blockers.push(`Accept or cancel ${openRequests} open client request${openRequests===1?'':'s'}.`);
    if(gapOnly&&aimsContract) {
      const governance=aimsDelivery.gapContext(db,workspace);
      publishedReport=governance.publication?governance.report:null;
      if(Number(governance.engagement?.id)!==Number(row.id)) blockers.push('Close the governed ISO 42001 engagement linked to this assessment.');
      const projection=engagementDelivery.getProjection(db,workspace,actorId,{ensure:false});
      if(!projection?.summary.completionReady) {
        blockers.push(...(projection?.summary.completionBlockers?.length
          ? projection.summary.completionBlockers
          : ['Complete the governed ISO 42001 assessment, independent report publication and formal closure from the engagement plan.']));
      }
    } else if(gapOnly) {
      if(!publishedReport) blockers.push('Publish an independently approved assessment report before closing this engagement.');
      const governance=gapFieldwork.assessmentContext(db,workspace);
      if(Number(governance.engagement?.id)!==Number(row.id)) blockers.push('Close the governed gap-assessment engagement linked to this assessment.');
      if(!governance.pass||governance.pass.status!=='completed') blockers.push('Complete the independently reviewed assessment pass.');
      if(!governance.completed.mobilisation) blockers.push('Record mobilisation sign-off.');
      if(!governance.completed.fieldwork) blockers.push('Record fieldwork sign-off.');
      if(!governance.completed.validation) blockers.push('Record validation sign-off or a governed Not required decision.');
    } else if(gapOnlyContract) {
      if(!GAP_ONLY_ENGAGEMENT_TYPES.has(row.engagement_type)) blockers.push('Convert the service path to Full certification support before completing certification-only work.');
      if(openFindings) blockers.push(`Close or withdraw ${openFindings} confirmed finding${openFindings===1?'':'s'} before completing this engagement.`);
    } else {
      const isContractedCertificationEngagement=isoContract&&(row.engagement_type==='implementation'||!!db.prepare(`SELECT 1 FROM engagement_delivery_plans
        WHERE workspace_id=? AND consulting_engagement_id=? LIMIT 1`).get(workspace.id,row.id));
      if(openFindings) blockers.push(`Close or withdraw ${openFindings} confirmed finding${openFindings===1?'':'s'} before completing ${isContractedCertificationEngagement?'certification-support delivery':'this engagement'}.`);
      if(isContractedCertificationEngagement) {
        const projection=engagementDelivery.getProjection(db,workspace,actorId,{ensure:false});
        if(!projection?.summary.completionReady) {
          const summary=projection?.summary || {};
          const reasons=Array.isArray(summary.completionBlockers)
            ? summary.completionBlockers.filter(Boolean)
            : [];
          blockers.push(`The certification-support delivery plan is not complete. ${reasons.join(' ') || 'Complete all required delivery gates and Stage 2 remediation before closing the engagement.'}`);
        }
      }
    }
    blockers.push(...require('../lib/iso42001-combined-assurance').combinedAssurance(db,workspace).blockers);
    return { gapOnly,openWorkpapers,openRequests,openFindings,publishedReport,blockers:[...new Set(blockers)] };
  };
  const completionNote = (position,note) => {
    const supplied=consulting.clean(note,4000);
    if(!position.gapOnly) return consulting.clean(note,5000);
    const governed=`Gap-assessment-only scope completed at controlled report publication. ${position.openFindings} confirmed finding${position.openFindings===1?' remains':'s remain'} open as client-owned improvement recommendation${position.openFindings===1?'':'s'}; contract closure does not represent remediation or finding closure.`;
    return supplied?`${governed} ${supplied}`:governed;
  };

  function renderCockpit(req,res,options={}) {
    const chosen=options.engagementId || req.query.engagement;
    if(!db.prepare('SELECT 1 FROM consulting_engagements WHERE workspace_id=?'+(chosen?' AND id=?':'')).get(req.workspace.id,...(chosen?[chosen]:[]))) {
      if(chosen)return res.status(404).render('error',{user:req.user,ws:req.workspace,message:'Engagement not found.'});
      return res.render('delivery_setup',{user:req.user,ws:req.workspace,active:'delivery'});
    }
    const data=consulting.getCockpit(db,req.workspace,req.user.id,chosen);
    const replacesId=options.values?.replaces_report_id || req.query.replacesReportId;
    if(replacesId&&!rbac.hasPermission(res.locals.userPerms||req.userPerms||new Set(),'report.view'))return res.status(403).render('error',{user:req.user,ws:req.workspace,message:'Report viewing permission is required.'});
    const replacementRequest=replacesId?consulting.reportRevisionRequest(db,req.workspace,replacesId):null;
    if(replacesId&&(!replacementRequest||replacementRequest.replacement_report_id||replacementRequest.engagement_id!==data.engagement.id))return res.status(404).render('error',{user:req.user,ws:req.workspace,message:'The selected report revision request is unavailable.'});
    const selectedManifestId=options.values?Number(options.values.pass_manifest_id)||null:req.query.manifestId?Number(req.query.manifestId):replacementRequest?.manifest_id||data.manifests[0]?.id||null;
    if(req.query.manifestId&&!data.manifests.some(m=>m.id===selectedManifestId))return res.status(404).render('error',{user:req.user,ws:req.workspace,message:'The selected assessment version is not available in this engagement.'});
    const view=options.view || (new Set(['overview','workpapers','findings','requests','frameworks','reports','commercial','methodology','qa']).has(req.query.view)?req.query.view:'overview');
    const iso27001Contract=hasIso27001(req.workspace);
    const outcome=iso27001Contract?isoLifecycle.normalizeOutcome(req.workspace.engagement_outcome):null;
    const outcomeOption=iso27001Contract?isoLifecycle.OUTCOME_OPTIONS.find(option=>option.value===outcome):null;
    data.requests=data.requests.map(row=>({...row,description:enc.decryptIfNeeded(row.description,req.workspace.id)}));
    res.status(options.status||200).render('delivery_cockpit',{ user:req.user,ws:req.workspace,active:'delivery',view,...data,selectedManifestId,replacementRequest,reportValues:options.values||{},reportError:options.error||null,
      completion:completionPosition(req.workspace,data.engagement,req.user.id),
      servicePath:{
        value:outcome,
        label:iso27001Contract?isoLifecycle.label(outcome):(req.workspace.vciso_enabled?'vCISO advisory':'Framework-specific consulting'),
        description:iso27001Contract?outcomeOption.description:(req.workspace.vciso_enabled
          ? 'Virtual security leadership delivered through governed scope, advisory work, evidence, decisions and executive reporting.'
          : 'The delivery endpoint follows this engagement\'s approved framework scope, deliverables and completion conditions.'),
        iso27001:iso27001Contract,
        gapOnly:iso27001Contract&&isoLifecycle.isGapOnly(outcome),
        allowedEngagementTypes:iso27001Contract&&isoLifecycle.isGapOnly(outcome)
          ? [...GAP_ONLY_ENGAGEMENT_TYPES]
          : [...ENGAGEMENT_TYPES]
      }
    });
  }
  app.get('/workspaces/:wsId/delivery',requireAuth,requireWorkspace,firmOnly,(req,res)=>renderCockpit(req,res));
  app.post('/workspaces/:wsId/delivery/start',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>db.transaction(()=>consulting.ensureEngagement(db,req.workspace,req.user.id))(),'Engagement started.',row=>`${base(req.workspace.id)}?engagement=${row.id}`));

  app.post('/workspaces/:wsId/delivery/engagements',requireAuth,requireWorkspace,firmOnly,requirePermission('workspace.update'),(req,res)=>run(req,res,()=>db.transaction(()=>{
    const name=consulting.clean(req.body.name,300); if(!name) throw new Error('Engagement name is required.');
    const type=String(req.body.engagement_type||'implementation');
    if(!ENGAGEMENT_TYPES.has(type)) throw new Error('Choose a valid engagement type.');
    if(isoLifecycle.isGapOnly(req.workspace.engagement_outcome)&&!GAP_ONLY_ENGAGEMENT_TYPES.has(type)) {
      throw new Error('This workspace is contracted for Gap assessment only. Convert the service path to Full certification support before creating implementation, readiness, internal audit, or surveillance work.');
    }
    const frameworks=Array.isArray(req.body.frameworks)?req.body.frameworks:[req.body.frameworks].filter(Boolean);
    const valid=frameworks.length?db.prepare(`SELECT code FROM frameworks WHERE code IN (${frameworks.map(()=>'?').join(',')}) AND status!='retired' GROUP BY code`).all(...frameworks).map(r=>r.code):[];
    if(!valid.length) throw new Error('Choose at least one active framework.');
    const code=consulting.clean(req.body.engagement_code,40)||`ENG-${req.workspace.id}-${Date.now().toString().slice(-6)}`;
    const lead=req.body.lead_consultant_id?Number(req.body.lead_consultant_id):req.user.id;
    const reviewer=req.body.quality_reviewer_id?Number(req.body.quality_reviewer_id):null;
    if(consulting.workspaceUser(db,req.workspace,lead)?.user_type!=='firm') throw new Error('Choose an active firm consultant as engagement lead.');
    if(reviewer&&!consulting.eligibleReviewers(db,req.workspace,[lead]).some(u=>u.id===reviewer)) throw new Error('Choose an eligible independent engagement reviewer.');
    const id=Number(db.prepare(`INSERT INTO consulting_engagements
      (workspace_id,engagement_code,name,engagement_type,framework_scope_json,scope_statement,included_entities,included_locations,included_systems,exclusions,
       assessment_period_start,assessment_period_end,status,lead_consultant_id,quality_reviewer_id,start_date,target_date,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)`).run(req.workspace.id,code,name,type,JSON.stringify(valid),consulting.clean(req.body.scope_statement),
        consulting.clean(req.body.included_entities),consulting.clean(req.body.included_locations),consulting.clean(req.body.included_systems),consulting.clean(req.body.exclusions),
        consulting.validDate(req.body.assessment_period_start),consulting.validDate(req.body.assessment_period_end),lead,reviewer,
        consulting.validDate(req.body.start_date),consulting.validDate(req.body.target_date),req.user.id).lastInsertRowid);
    db.prepare(`INSERT INTO engagement_commercials (engagement_id,updated_by) VALUES (?,?)`).run(id,req.user.id);
    db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team (engagement_id,user_id,role,assigned_by) VALUES (?,?,'engagement_lead',?)`).run(id,lead,req.user.id);
    if(reviewer) db.prepare(`INSERT OR IGNORE INTO consulting_engagement_team (engagement_id,user_id,role,assigned_by) VALUES (?,?,'quality_reviewer',?)`).run(id,reviewer,req.user.id);
    const engagementOutcome=hasIso27001(req.workspace)?isoLifecycle.normalizeOutcome(req.workspace.engagement_outcome):null;
    consulting.event(db,req.workspace.id,id,req.user.id,'engagement',id,'created',{ frameworks:valid,engagement_outcome:engagementOutcome });
    logAction(req.user.id,req.workspace.id,'create_consulting_engagement','consulting_engagement',id,{ frameworks:valid,engagement_outcome:engagementOutcome },auditCtx(req));
    return id;
  })(),'Engagement created.',id=>`${base(req.workspace.id)}?engagement=${id}`));

  app.post('/workspaces/:wsId/delivery/engagements/:id',requireAuth,requireWorkspace,firmOnly,requirePermission('workspace.update'),(req,res)=>run(req,res,()=>db.transaction(()=>{
    const row=consulting.engagementFor(db,req.workspace,req.user.id,req.params.id);
    const status=String(req.body.status||row.status);
    if(!new Set(['draft','active','on_hold','quality_review','complete','cancelled']).has(status)) throw new Error('Invalid engagement status.');
    const iso27001Contract=hasIso27001(req.workspace);
    const gapOnlyContract=iso27001Contract&&isoLifecycle.isGapOnly(req.workspace.engagement_outcome);
    const reopeningCompleted=row.status==='complete'&&status!=='complete';
    if(row.status==='complete'&&gapOnlyContract&&row.engagement_type==='gap_assessment') {
      throw new Error('This governed gap-assessment engagement is formally closed at the controlled report. Its retained settings and evidence history are frozen; start a new governed engagement for any further work.');
    }
    let position=null;
    if(status==='complete') {
      position=completionPosition(req.workspace,row,req.user.id);
      if(position.blockers.length) throw new Error(position.blockers.join(' '));
    }
    const version=Number(req.body.row_version);
    const requestedLead=req.body.lead_consultant_id===undefined?row.lead_consultant_id:(req.body.lead_consultant_id?Number(req.body.lead_consultant_id):null);
    const requestedReviewer=req.body.quality_reviewer_id===undefined?row.quality_reviewer_id:(req.body.quality_reviewer_id?Number(req.body.quality_reviewer_id):null);
    if(requestedLead && consulting.workspaceUser(db,req.workspace,requestedLead)?.user_type!=='firm') throw new Error('Choose an active firm consultant as engagement lead.');
    if(requestedReviewer && !consulting.eligibleReviewers(db,req.workspace,[requestedLead]).some(u=>u.id===requestedReviewer)) throw new Error('Choose an eligible independent engagement reviewer.');
    const result=db.prepare(`UPDATE consulting_engagements SET name=?,scope_statement=?,included_entities=?,included_locations=?,included_systems=?,exclusions=?,
      assessment_period_start=?,assessment_period_end=?,status=?,lead_consultant_id=?,quality_reviewer_id=?,client_sponsor_id=?,start_date=?,target_date=?,
      completed_at=CASE WHEN ?='complete' THEN datetime('now') ELSE NULL END,completion_note=?,updated_at=datetime('now'),row_version=row_version+1
      WHERE id=? AND workspace_id=? AND row_version=?`).run(consulting.clean(req.body.name,300)||row.name,consulting.clean(req.body.scope_statement),
        consulting.clean(req.body.included_entities),consulting.clean(req.body.included_locations),consulting.clean(req.body.included_systems),consulting.clean(req.body.exclusions),
        consulting.validDate(req.body.assessment_period_start),consulting.validDate(req.body.assessment_period_end),status,requestedLead,
        requestedReviewer,req.body.client_sponsor_id||null,consulting.validDate(req.body.start_date),consulting.validDate(req.body.target_date),status,
        position?completionNote(position,req.body.completion_note):consulting.clean(req.body.completion_note,5000),row.id,req.workspace.id,version);
    if(!result.changes) throw new Error('The engagement changed in another session. Reload before saving.');
    consulting.syncEngagementRoster(db,req.workspace,{...row,lead_consultant_id:requestedLead,quality_reviewer_id:requestedReviewer},req.user.id);
    consulting.event(db,req.workspace.id,row.id,req.user.id,'engagement',row.id,'updated',{ from_status:row.status,to_status:status });
    logAction(req.user.id,req.workspace.id,'update_consulting_engagement','consulting_engagement',row.id,{ status },auditCtx(req));
    if(status==='complete') engagementDelivery.syncOutcomePlanStatus(db,req.workspace,req.user.id);
    else if(reopeningCompleted&&iso27001Contract&&!gapOnlyContract) {
      engagementDelivery.reopenForConsultingEngagement(db,req.workspace,req.user.id,row.id);
    }
  })(),'Engagement settings updated.',`${base(req.workspace.id)}?engagement=${req.params.id}`));

  app.post('/workspaces/:wsId/delivery/engagements/:id/complete-gap-assessment',requireAuth,requireWorkspace,firmOnly,requirePermission('workspace.update'),(req,res)=>{
    const fieldworkPath=`/workspaces/${req.workspace.id}/gap-assessment/fieldwork`;
    try {
      const row=consulting.engagementFor(db,req.workspace,req.user.id,req.params.id);
      const position=completionPosition(req.workspace,row,req.user.id);
      if(!position.gapOnly) throw new Error('This action is available only when the agreed engagement outcome is gap assessment only.');
      if(position.blockers.length) throw new Error(position.blockers.join(' '));
      const version=Number(req.body.row_version);
      const note=completionNote(position,req.body.completion_note);
      const result=db.prepare(`UPDATE consulting_engagements SET status='complete',completed_at=datetime('now'),completion_note=?,
        updated_at=datetime('now'),row_version=row_version+1 WHERE id=? AND workspace_id=? AND row_version=?`).run(
          note,row.id,req.workspace.id,version);
      if(!result.changes) throw new Error('The engagement changed in another session. Reload before closing it.');
      consulting.event(db,req.workspace.id,row.id,req.user.id,'engagement',row.id,'completed_at_report',{
        from_status:row.status,open_findings_retained:position.openFindings,report_id:position.publishedReport.id
      });
      logAction(req.user.id,req.workspace.id,'complete_gap_assessment_at_report','consulting_engagement',row.id,{
        report_id:position.publishedReport.id,open_findings_retained:position.openFindings
      },auditCtx(req));
      engagementDelivery.syncOutcomePlanStatus(db,req.workspace,req.user.id);
      return redirect(req,res,fieldworkPath,'Gap-assessment engagement closed. Open findings remain visible as client-owned recommendations.');
    } catch(error) {
      return redirect(req,res,fieldworkPath,error.message||'The gap-assessment engagement could not be closed.','error');
    }
  });

  app.post('/workspaces/:wsId/delivery/engagements/:id/team',requireAuth,requireWorkspace,firmOnly,requirePermission('workspace.update'),(req,res)=>run(req,res,()=>{
    const eng=consulting.engagementFor(db,req.workspace,req.user.id,req.params.id);
    const userId=Number(req.body.user_id); if(!consulting.workspaceUser(db,req.workspace,userId)) throw new Error('Team member is not active in this workspace.');
    const role=String(req.body.role||'consultant'); if(!new Set(['consultant','subject_matter_expert','client_sponsor','client_contributor']).has(role)) throw new Error('Set the engagement lead and quality reviewer in Engagement scope and governance.');
    const member=consulting.workspaceUser(db,req.workspace,userId);
    if((role.startsWith('client_')?'client':'firm')!==member.user_type) throw new Error('Choose a member whose account type matches the engagement role.');
    db.prepare(`INSERT INTO consulting_engagement_team (engagement_id,user_id,role,planned_hours,assigned_by) VALUES (?,?,?,?,?)
      ON CONFLICT(engagement_id,user_id,role) DO UPDATE SET planned_hours=excluded.planned_hours`).run(eng.id,userId,role,num(req.body.planned_hours||0,'Planned hours',{max:100000}),req.user.id);
    consulting.event(db,req.workspace.id,eng.id,req.user.id,'team',userId,'assigned',{ role });
  },'Engagement team updated.',`${base(req.workspace.id)}?engagement=${req.params.id}`));

  app.post('/workspaces/:wsId/delivery/workpapers',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>{
    const eng=engagement(req); assertGapClosureMutable(req,eng.id);
    const id=consulting.saveWorkpaper(db,req.workspace,eng,req.user.id,req.body,null);
    reconcileDeliveryCompletion(req,{ reason:'A new consultant workpaper was opened.',details:{ workpaper_id:id,engagement_id:eng.id } });
    logAction(req.user.id,req.workspace.id,'create_consultant_workpaper','consultant_workpaper',id,{ engagement_id:eng.id,requirement_id:req.body.requirement_id },auditCtx(req));
    return id;
  },'Workpaper created.',id=>`${base(req.workspace.id)}/workpapers/${id}`));

  function renderWorkpaper(req,res,error=null,posted=null) {
    const current=consulting.workpaperDetail(db,req.workspace,req.params.id);
    const users=consulting.getCockpit(db,req.workspace,req.user.id,current.engagement_id).users;
    const snapshots=db.prepare(`SELECT s.id,s.version_number,s.snapshot_hash,s.frozen_at,u.name frozen_by_name,
      m.assessment_pass_id,m.completion_generation,p.pass_number FROM consultant_workpaper_snapshots s LEFT JOIN users u ON u.id=s.frozen_by
      LEFT JOIN assessment_pass_manifest_items i ON i.snapshot_id=s.id LEFT JOIN assessment_pass_manifests m ON m.id=i.manifest_id
      LEFT JOIN assessment_passes p ON p.id=m.assessment_pass_id WHERE s.workpaper_id=? ORDER BY s.version_number DESC`).all(current.id);
    const selectedSnapshot=req.query.snapshot ? consulting.snapshotDetail(db,req.workspace,current.id,req.query.snapshot) : null;
    let workpaper=selectedSnapshot ? {...selectedSnapshot.snapshot.workpaper,id:current.id,workpaper_ref:current.workpaper_ref,engagement_id:current.engagement_id,
      framework_code:selectedSnapshot.snapshot.workpaper.framework_code||current.framework_code,requirement_ref:selectedSnapshot.snapshot.workpaper.requirement_ref||current.requirement_ref,
      requirement_title:selectedSnapshot.snapshot.workpaper.requirement_title||current.requirement_title,status:'frozen'} : current;
    const fieldNames=['title','objective','procedure_performed','persons_interviewed','testing_period_start','testing_period_end','population_description','population_size','sample_method','sample_size','exceptions_count','exception_summary','management_claim','design_conclusion','implementation_conclusion','operating_effectiveness','evidence_sufficiency','conclusion_rationale','internal_notes','client_visible_summary','client_visible','requires_client_validation','owner_id','reviewer_id','client_validator_id','due_date','row_version','note'];
    const ownForm=posted && req.path===`${base(req.workspace.id)}/workpapers/${current.id}`;
    const recoveryFields=ownForm?fieldNames:Object.keys(posted||{}).filter(k=>!['_csrf','draft_id','draft_version','draft_generation','mutation_key'].includes(k)).slice(0,50);
    const attempted=posted ? Object.fromEntries(recoveryFields.filter(k=>Object.hasOwn(posted,k)).map(k=>[k,String(posted[k]??'').slice(0,20000)])) : null;
    if(ownForm && attempted && ['draft','changes_requested'].includes(current.status)) workpaper={...workpaper,...attempted};
    const reviews=selectedSnapshot ? selectedSnapshot.snapshot.reviews || [] : db.prepare(`SELECT r.*,u.name actor_name FROM consultant_workpaper_reviews r JOIN users u ON u.id=r.actor_id WHERE r.workpaper_id=? ORDER BY r.id`).all(current.id);
    const linkedEvidence=selectedSnapshot ? selectedSnapshot.snapshot.evidence || [] : db.prepare(`SELECT we.*,e.filename,e.description,e.sha256,e.uploaded_at,u.name linked_by_name FROM consultant_workpaper_evidence we
      JOIN evidence e ON e.id=we.evidence_id LEFT JOIN users u ON u.id=we.linked_by WHERE we.workpaper_id=? AND e.workspace_id=? ORDER BY we.id`).all(current.id,req.workspace.id);
    const requests=db.prepare(`SELECT cr.*,a.name assignee_name FROM client_requests cr LEFT JOIN users a ON a.id=cr.assignee_id WHERE cr.workpaper_id=? AND cr.workspace_id=? ORDER BY cr.id DESC`).all(current.id,req.workspace.id);
    const findings=db.prepare(`SELECT f.*,o.name owner_name FROM consulting_findings f LEFT JOIN users o ON o.id=f.owner_id WHERE f.workpaper_id=? AND f.workspace_id=? ORDER BY f.id`).all(current.id,req.workspace.id);
    const evidenceQuery=String(req.query.evidence_q || '').trim().slice(0,200);
    const evidenceCatalog=db.prepare(`SELECT id,filename,description,uploaded_at FROM evidence WHERE workspace_id=? AND superseded_at IS NULL
      AND (?='' OR instr(lower(filename||' '||COALESCE(description,'')),lower(?))>0) ORDER BY uploaded_at DESC,id DESC`).all(req.workspace.id,evidenceQuery,evidenceQuery);
    const status=error ? (Number(error.status) || (/changed|another session/i.test(error.message)?409:422)) : 200;
    return res.status(status).render('consultant_workpaper',{user:req.user,ws:req.workspace,active:'delivery',workpaper,reviews,linkedEvidence,snapshots,requests,findings,users,evidenceCatalog,evidenceQuery,
      readiness:consulting.readinessForSubmission(db,current),reviewerCandidates:consulting.eligibleReviewers(db,req.workspace,[current.owner_id,current.prepared_by || current.owner_id]),
      selectedSnapshot,formError:error?.message || null,attemptedValues:attempted,recoveryPath:posted?req.path:null,recordedValues:selectedSnapshot?{}:Object.fromEntries(fieldNames.filter(k=>k!=='note').map(k=>[k,current[k]])),storedVersion:current.row_version});
  }

  app.get('/workspaces/:wsId/delivery/workpapers/:id',requireAuth,requireWorkspace,firmOnly,(req,res)=>{
    try { return renderWorkpaper(req,res); }
    catch(error) { res.status(404).render('error',{user:req.user,ws:req.workspace,message:error.message}); }
  });

  app.post('/workspaces/:wsId/delivery/workpapers/:id',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>{
    const current=consulting.workpaperDetail(db,req.workspace,req.params.id);
    assertGapClosureMutable(req,current.engagement_id);
    const eng=consulting.engagementFor(db,req.workspace,req.user.id,current.engagement_id);
    return drafts.commit(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'workpaper',recordId:String(current.id),contextKey:'',encryptionEnabled:!!req.workspace.encryption_enabled},req.body,effectiveBody=>{
      req.body=effectiveBody;
      const id=consulting.saveWorkpaper(db,req.workspace,eng,req.user.id,effectiveBody,current.id);
      if(effectiveBody.intent==='submit') {
        const saved=consulting.workpaperDetail(db,req.workspace,id);
        consulting.transitionWorkpaper(db,req.workspace,req.user,id,'submit',effectiveBody.note,saved.row_version);
      }
      reconcileDeliveryCompletion(req,{reason:'The consultant workpaper was formally saved.',details:{workpaper_id:id,engagement_id:eng.id}});
      logAction(req.user.id,req.workspace.id,'update_consultant_workpaper','consultant_workpaper',id,null,auditCtx(req));
      return id;
    });
  },req.body.intent==='submit'?'Workpaper saved and submitted for independent review.':'Workpaper saved.',id=>`${base(req.workspace.id)}/workpapers/${id}`));

  app.post('/workspaces/:wsId/delivery/workpapers/:id/:action(submit|approve|changes|freeze|reopen)',requireAuth,requireWorkspace,firmOnly,(req,res,next)=>{
    const action=req.params.action;
    const permission=action==='submit'?'control.update':action==='freeze'||action==='reopen'?'assessment.signoff':'document.review';
    return requirePermission(permission)(req,res,()=>run(req,res,()=>{
      const current=consulting.workpaperDetail(db,req.workspace,req.params.id);
      assertGapClosureMutable(req,current.engagement_id);
      const status=consulting.transitionWorkpaper(db,req.workspace,req.user,req.params.id,action,req.body.note,req.body.row_version);
      reconcileDeliveryCompletion(req,{reason:`Consultant workpaper moved from ${current.status} to ${status}.`,details:{workpaper_id:current.id,engagement_id:current.engagement_id}});
      logAction(req.user.id,req.workspace.id,`${action}_consultant_workpaper`,'consultant_workpaper',req.params.id,{status},auditCtx(req));
      return status;
    },`Workpaper moved to ${action==='changes'?'changes requested':action}.`,`${base(req.workspace.id)}/workpapers/${req.params.id}`));
  });

  app.post('/workspaces/:wsId/delivery/workpapers/:id/evidence',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>{
    consulting.linkEvidence(db,req.workspace,req.user.id,req.params.id,req.body);
    logAction(req.user.id,req.workspace.id,'link_workpaper_evidence','consultant_workpaper',req.params.id,{ evidence_id:req.body.evidence_id },auditCtx(req));
  },'Evidence linked and classified.',`${base(req.workspace.id)}/workpapers/${req.params.id}`));

  app.post('/workspaces/:wsId/delivery/workpapers/:id/client-request',requireAuth,requireWorkspace,firmOnly,requirePermission('client_request.create'),(req,res)=>run(req,res,()=>{
    const workpaper=consulting.workpaperDetail(db,req.workspace,req.params.id);
    assertGapClosureMutable(req,workpaper.engagement_id);
    const id=consulting.createClientRequest(db,req.workspace,req.user.id,req.params.id,req.body);
    reconcileDeliveryCompletion(req,{ reason:'A new client evidence request was opened.',details:{ request_id:id,workpaper_id:workpaper.id,engagement_id:workpaper.engagement_id } });
    logAction(req.user.id,req.workspace.id,'create_structured_evidence_request','client_request',id,{ workpaper_id:req.params.id },auditCtx(req)); return id;
  },'Structured client request created.',id=>`/workspaces/${req.workspace.id}/client-portal/requests/${id}`));

  app.post('/workspaces/:wsId/delivery/workpapers/:id/findings',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>{
    const workpaper=consulting.workpaperDetail(db,req.workspace,req.params.id);
    assertGapClosureMutable(req,workpaper.engagement_id);
    const id=consulting.createFinding(db,req.workspace,req.user.id,req.params.id,req.body);
    logAction(req.user.id,req.workspace.id,'create_consulting_finding','consulting_finding',id,{workpaper_id:req.params.id},auditCtx(req));return id;
  },'Finding drafted.',id=>`${base(req.workspace.id)}/findings/${id}`));

  app.get('/workspaces/:wsId/delivery/findings/:id',requireAuth,requireWorkspace,firmOnly,(req,res)=>{
    try{
      const finding=consulting.findingDetail(db,req.workspace,req.params.id);
      const events=db.prepare(`SELECT e.*,u.name actor_name FROM consulting_finding_events e JOIN users u ON u.id=e.actor_id WHERE e.finding_id=? ORDER BY e.id`).all(finding.id);
      const evidence=db.prepare(`SELECT fe.*,e.filename,e.sha256,u.name linked_by_name FROM consulting_finding_evidence fe JOIN evidence e ON e.id=fe.evidence_id LEFT JOIN users u ON u.id=fe.linked_by WHERE fe.finding_id=? AND e.workspace_id=? ORDER BY fe.linked_at`).all(finding.id,req.workspace.id);
      const data=consulting.getCockpit(db,req.workspace,req.user.id,finding.engagement_id);
      res.render('consulting_finding',{user:req.user,ws:req.workspace,active:'delivery',finding,events,findingEvidence:evidence,users:data.users,evidenceCatalog:data.evidence});
    }catch(error){res.status(404).render('error',{user:req.user,ws:req.workspace,message:error.message});}
  });

  app.post('/workspaces/:wsId/delivery/findings/:id/:action(confirm|plan|validate|close|withdraw)',requireAuth,requireWorkspace,firmOnly,(req,res)=>{
    const action=req.params.action,permission=['confirm','close','withdraw'].includes(action)?'document.review':'control.update';
    return requirePermission(permission)(req,res,()=>run(req,res,()=>{
      const current=consulting.findingDetail(db,req.workspace,req.params.id);
      assertGapClosureMutable(req,current.engagement_id);
      const status=consulting.transitionFinding(db,req.workspace,req.user.id,req.params.id,action,req.body);
      reconcileDeliveryCompletion(req,{ reason:`Consulting finding moved from ${current.status} to ${status}.`,details:{ finding_id:current.id,engagement_id:current.engagement_id } });
      logAction(req.user.id,req.workspace.id,`${action}_consulting_finding`,'consulting_finding',req.params.id,{status},auditCtx(req));return status;
    },`Finding moved to ${action}.`,`${base(req.workspace.id)}/findings/${req.params.id}`));
  });

  app.post('/workspaces/:wsId/delivery/findings/:id/evidence',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>{
    consulting.linkFindingEvidence(db,req.workspace,req.user.id,req.params.id,req.body);
    logAction(req.user.id,req.workspace.id,'link_consulting_finding_evidence','consulting_finding',req.params.id,{evidence_id:req.body.evidence_id,role:req.body.evidence_role},auditCtx(req));
  },'Finding evidence linked.',`${base(req.workspace.id)}/findings/${req.params.id}`));

  app.get('/workspaces/:wsId/delivery/pass-manifests/:id',requireAuth,requireWorkspace,firmOnly,requirePermission('control.view'),(req,res)=>{
    try {
      const manifest=consulting.passManifestDetail(db,req.workspace,req.params.id);
      res.render('consulting_pass_manifest',{user:req.user,ws:req.workspace,active:'delivery',manifest});
    }catch(error){res.status(Number(error.status)||422).render('error',{user:req.user,ws:req.workspace,message:error.message});}
  });

  app.post('/workspaces/:wsId/delivery/reports',requireAuth,requireWorkspace,firmOnly,requirePermission('report.generate'),(req,res)=>{
    try{
      const id=consulting.generateReport(db,req.workspace,req.user.id,req.body.engagement_id,req.body);
      logAction(req.user.id,req.workspace.id,'generate_consulting_report','consulting_report',id,{type:req.body.report_type,replaces_report_id:req.body.replaces_report_id||null},auditCtx(req));
      return res.redirect(withToast(`${base(req.workspace.id)}/reports/${id}`,'Immutable report version generated.'));
    }catch(error){return renderCockpit(req,res,{engagementId:req.body.engagement_id,view:'reports',values:req.body,error:error.message,status:error.status||422});}
  });

  function renderReport(req,res,options={}) {
    try{const report=consulting.reportDetail(db,req.workspace,req.params.id);return res.status(options.status||200).render('consulting_report',{user:req.user,ws:req.workspace,active:'delivery',report,clientView:false,decisionError:options.error||null,decisionNote:options.note||''});}
    catch(error){return res.status(404).render('error',{user:req.user,ws:req.workspace,message:error.message});}
  }
  app.get('/workspaces/:wsId/delivery/reports/:id',requireAuth,requireWorkspace,firmOnly,requirePermission('report.view'),(req,res)=>renderReport(req,res));

  app.post('/workspaces/:wsId/delivery/reports/:id/:action(approve|publish|request-changes)',requireAuth,requireWorkspace,firmOnly,(req,res)=>{
    const permission=req.params.action==='publish'?'report.publish':'report.approve';
    return requirePermission(permission)(req,res,()=>{
      try{
        const status=consulting.transitionReport(db,req.workspace,req.user.id,req.params.id,req.params.action,req.body.note,{status:req.body.expected_status,hash:req.body.expected_snapshot_hash});
        logAction(req.user.id,req.workspace.id,`${req.params.action}_consulting_report`,'consulting_report',req.params.id,{status},auditCtx(req));
        return res.redirect(withToast(`${base(req.workspace.id)}/reports/${req.params.id}`,{'approve':'Report approved.','publish':'Report published.','request-changes':'Changes requested. The report author has a linked revision task.'}[req.params.action]));
      }catch(error){return renderReport(req,res,{status:error.status||422,error:error.message,note:String(req.body.note||'')});}
    });
  });

  app.get('/workspaces/:wsId/client-portal/reports/:id',requireAuth,requireWorkspace,
    requirePermission('client_portal.view'),requireFirmPermission('report.view'),(req,res)=>{
    try{const report=consulting.reportDetail(db,req.workspace,req.params.id);if(report.status!=='published') throw new Error('Published report not found.');res.render('consulting_report',{user:req.user,ws:req.workspace,active:'client-portal',report,clientView:true});}
    catch(error){res.status(404).render('error',{user:req.user,ws:req.workspace,message:'Published report not found.'});}
  });

  app.get('/workspaces/:wsId/client-portal/workpapers/:id/validate',requireAuth,requireWorkspace,requirePermission('client_portal.view'),(req,res)=>{
    try {
      const row=consulting.workpaperDetail(db,req.workspace,req.params.id);
      if(!row.client_visible||!row.requires_client_validation||row.status!=='client_validation'||Number(row.client_validator_id)!==Number(req.user.id)) return res.status(404).render('error',{ user:req.user,ws:req.workspace,message:'This information check is unavailable or is not assigned to you.' });
      res.render('client_workpaper_validation',{ user:req.user,ws:req.workspace,active:'client-portal',workpaper:row });
    } catch(error) { res.status(404).render('error',{ user:req.user,ws:req.workspace,message:error.message }); }
  });

  app.post('/workspaces/:wsId/client-portal/workpapers/:id/validate',requireAuth,requireWorkspace,requirePermission('client_request.respond'),(req,res)=>run(req,res,()=>{
    const row=consulting.workpaperDetail(db,req.workspace,req.params.id);
    assertGapClosureMutable(req,row.engagement_id);
    if(!row.client_visible||!row.requires_client_validation||Number(row.client_validator_id)!==Number(req.user.id)) throw new Error('This information check is not assigned to you.');
    const action=req.body.decision==='changes'?'changes':'validate';
    const status=consulting.transitionWorkpaper(db,req.workspace,req.user,row.id,action,req.body.note,req.body.row_version);
    reconcileDeliveryCompletion(req,{ reason:`Client validation moved a workpaper from ${row.status} to ${status}.`,details:{ workpaper_id:row.id,engagement_id:row.engagement_id } });
    logAction(req.user.id,req.workspace.id,`${action}_client_workpaper`,'consultant_workpaper',row.id,null,auditCtx(req));
  },req.body.decision==='changes'?'Changes requested.':'Information confirmed.',`/workspaces/${req.workspace.id}/client-portal`));

  app.post('/workspaces/:wsId/delivery/client-controls',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>{
    const title=consulting.clean(req.body.title,300); if(!title) throw new Error('Control title is required.');
    const code=consulting.clean(req.body.control_code,60); if(!code) throw new Error('Control code is required.');
    const id=Number(db.prepare(`INSERT INTO client_controls
      (workspace_id,control_code,title,description,control_owner_id,process_owner,frequency,control_type,nature,status,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,'active',?)`).run(req.workspace.id,code,title,consulting.clean(req.body.description),req.body.control_owner_id||null,
        consulting.clean(req.body.process_owner,300),consulting.clean(req.body.frequency,100),req.body.control_type||null,req.body.nature||null,req.user.id).lastInsertRowid);
    consulting.event(db,req.workspace.id,engagement(req).id,req.user.id,'client_control',id,'created',{ code }); return id;
  },'Client control created.',`${base(req.workspace.id)}?view=frameworks&engagement=${req.body.engagement_id||''}`));

  app.post('/workspaces/:wsId/delivery/client-controls/:id/mappings',requireAuth,requireWorkspace,firmOnly,requirePermission('control.update'),(req,res)=>run(req,res,()=>{
    const control=db.prepare('SELECT * FROM client_controls WHERE id=? AND workspace_id=?').get(Number(req.params.id),req.workspace.id); if(!control) throw new Error('Client control not found.');
    const requirement=db.prepare('SELECT id FROM requirements WHERE id=?').get(Number(req.body.requirement_id)); if(!requirement) throw new Error('Requirement not found.');
    const coverage=String(req.body.coverage||'supporting'); if(!new Set(['full','partial','supporting']).has(coverage)) throw new Error('Invalid mapping coverage.');
    const rationale=consulting.clean(req.body.mapping_rationale,5000); if(!rationale) throw new Error('Mapping rationale is required.');
    db.prepare(`INSERT INTO client_control_requirement_links (client_control_id,requirement_id,coverage,mapping_rationale,mapped_by)
      VALUES (?,?,?,?,?) ON CONFLICT(client_control_id,requirement_id) DO UPDATE SET coverage=excluded.coverage,mapping_rationale=excluded.mapping_rationale,mapped_by=excluded.mapped_by,reviewed_by=NULL,reviewed_at=NULL`)
      .run(control.id,requirement.id,coverage,rationale,req.user.id);
    consulting.event(db,req.workspace.id,engagement(req).id,req.user.id,'client_control',control.id,'requirement_mapped',{ requirement_id:requirement.id,coverage });
  },'Requirement mapping saved.',`${base(req.workspace.id)}?view=frameworks&engagement=${req.body.engagement_id||''}`));

  app.post('/workspaces/:wsId/delivery/commercial',requireAuth,requireWorkspace,firmOnly,requirePermission('firm.manage'),(req,res)=>run(req,res,()=>{
    const eng=engagement(req); const version=Number(req.body.row_version);
    const currency=String(req.body.currency||'USD').toUpperCase(); if(!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter currency code.');
    const result=db.prepare(`UPDATE engagement_commercials SET currency=?,contract_value_minor=?,planned_hours=?,internal_cost_rate_minor=?,billing_model=?,billing_status=?,
      invoiced_minor=?,collected_minor=?,estimated_remaining_cost_minor=?,updated_by=?,updated_at=datetime('now'),row_version=row_version+1 WHERE engagement_id=? AND row_version=?`).run(currency,
      money(req.body.contract_value),num(req.body.planned_hours||0,'Planned hours',{max:100000}),money(req.body.internal_cost_rate),req.body.billing_model||'fixed_fee',
      req.body.billing_status||'not_started',money(req.body.invoiced),money(req.body.collected),req.body.estimated_remaining_cost==null || req.body.estimated_remaining_cost==='' ? null : Math.round(num(req.body.estimated_remaining_cost,'Estimated remaining cost',{max:1000000000})*100),req.user.id,eng.id,version);
    if(!result.changes) throw new Error('Commercial data changed in another session. Reload before saving.');
    consulting.event(db,req.workspace.id,eng.id,req.user.id,'commercial',eng.id,'updated',{ currency });
    logAction(req.user.id,req.workspace.id,'update_engagement_commercials','consulting_engagement',eng.id,null,auditCtx(req));
  },'Commercial baseline updated.',`${base(req.workspace.id)}?view=commercial&engagement=${req.body.engagement_id}`));

  app.post('/workspaces/:wsId/delivery/time',requireAuth,requireWorkspace,firmOnly,(req,res)=>run(req,res,()=>{
    const eng=engagement(req); const userId=req.body.user_id?Number(req.body.user_id):req.user.id;
    if(userId!==req.user.id&&!rbac.isManager(req.user.firm_role)) throw new Error('Only managers can enter time for another consultant.');
    if(!consulting.workspaceUser(db,req.workspace,userId)) throw new Error('Consultant is not active in this workspace.');
    const category=String(req.body.category||'workpaper'); if(!new Set(['planning','assessment','client_meeting','workpaper','review','reporting','remediation','administration']).has(category)) throw new Error('Invalid time category.');
    const description=consulting.clean(req.body.description,1000); if(!description) throw new Error('Time-entry description is required.');
    const id=Number(db.prepare(`INSERT INTO engagement_time_entries (engagement_id,user_id,work_date,hours,category,description,billable)
      VALUES (?,?,?,?,?,?,?)`).run(eng.id,userId,consulting.validDate(req.body.work_date),num(req.body.hours,'Hours',{min:.01,max:24}),category,description,req.body.billable==='0'?0:1).lastInsertRowid);
    consulting.event(db,req.workspace.id,eng.id,req.user.id,'time_entry',id,'created',{ hours:Number(req.body.hours),user_id:userId });
  },'Time recorded.',`${base(req.workspace.id)}?view=commercial&engagement=${req.body.engagement_id}`));

  app.post('/workspaces/:wsId/delivery/scope-changes',requireAuth,requireWorkspace,firmOnly,requirePermission('workspace.update'),(req,res)=>run(req,res,()=>{
    const eng=engagement(req); const title=consulting.clean(req.body.title,300),description=consulting.clean(req.body.description,10000),reason=consulting.clean(req.body.reason,5000);
    if(!title||!description||!reason) throw new Error('Title, description and reason are required.');
    const id=Number(db.prepare(`INSERT INTO engagement_scope_changes (engagement_id,title,description,reason,schedule_impact_days,fee_impact_minor,proposed_by)
      VALUES (?,?,?,?,?,?,?)`).run(eng.id,title,description,reason,Math.round(num(req.body.schedule_impact_days||0,'Schedule impact',{min:-3650,max:3650})),money(req.body.fee_impact),req.user.id).lastInsertRowid);
    consulting.event(db,req.workspace.id,eng.id,req.user.id,'scope_change',id,'proposed',null); return id;
  },'Scope change proposed.',`${base(req.workspace.id)}?view=commercial&engagement=${req.body.engagement_id}`));

  app.post('/workspaces/:wsId/delivery/scope-changes/:id/decision',requireAuth,requireWorkspace,firmOnly,requirePermission('firm.manage'),(req,res)=>run(req,res,()=>{
    const eng=engagement(req); const row=db.prepare('SELECT * FROM engagement_scope_changes WHERE id=? AND engagement_id=?').get(Number(req.params.id),eng.id); if(!row) throw new Error('Scope change not found.');
    const decision=String(req.body.decision); if(!new Set(['approved','rejected']).has(decision)) throw new Error('Invalid scope decision.');
    const note=consulting.clean(req.body.decision_note,5000); if(!note) throw new Error('Decision note is required.');
    db.prepare(`UPDATE engagement_scope_changes SET status=?,decided_by=?,decided_at=datetime('now'),decision_note=? WHERE id=? AND status='proposed'`).run(decision,req.user.id,note,row.id);
    consulting.event(db,req.workspace.id,eng.id,req.user.id,'scope_change',row.id,decision,{ note });
  },'Scope-change decision recorded.',`${base(req.workspace.id)}?view=commercial&engagement=${req.body.engagement_id}`));

  app.post('/workspaces/:wsId/delivery/methodology',requireAuth,requireWorkspace,firmOnly,requirePermission('firm.manage'),(req,res)=>run(req,res,()=>{
    const method=consulting.ensureMethodology(db,req.workspace.firm_id,req.user.id);
    const content={ purpose:consulting.clean(req.body.purpose,5000),required_procedures:consulting.clean(req.body.required_procedures,15000),evidence_standard:consulting.clean(req.body.evidence_standard,15000),review_standard:consulting.clean(req.body.review_standard,15000),reporting_standard:consulting.clean(req.body.reporting_standard,15000),segregation_of_duties:true };
    if(!content.purpose||!content.required_procedures||!content.evidence_standard||!content.review_standard) throw new Error('Purpose, procedures, evidence and review standards are required.');
    const next=method.current_version+1,json=JSON.stringify(content),summary=consulting.clean(req.body.change_summary,2000); if(!summary) throw new Error('Change summary is required.');
    db.transaction(()=>{ db.prepare(`INSERT INTO firm_methodology_versions (methodology_id,version_number,content_json,change_summary,snapshot_hash,approved_by) VALUES (?,?,?,?,?,?)`).run(method.id,next,json,summary,consulting.sha(json),req.user.id); db.prepare(`UPDATE firm_methodologies SET current_version=? WHERE id=? AND firm_id=?`).run(next,method.id,req.workspace.firm_id); })();
    logAction(req.user.id,req.workspace.id,'approve_methodology_version','firm_methodology',method.id,{ version:next },auditCtx(req));
  },'A new immutable methodology version was approved.',`${base(req.workspace.id)}?view=methodology`));

  app.get('/delivery-portfolio',requireAuth,(req,res)=>{
    if(req.user.user_type!=='firm'||!rbac.rolePermissions(req.user.firm_role).includes('firm.cross_view')) return res.status(403).render('error',{ user:req.user,message:'Portfolio access is restricted to authorised firm users.' });
    const rows=consulting.portfolio(db,req.user.firm_id);
    const totals=consulting.portfolioTotals(rows);
    res.render('delivery_portfolio',{ user:req.user,active:'delivery-portfolio',rows,totals,firmWorkspaces:listWorkspaces(req.user) });
  });
}

module.exports={ register };
