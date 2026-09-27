'use strict';

const rbac = require('./rbac');
const { programmeFor, PROGRAMMES } = require('./programme-experience');
const { clientWorkPolicy } = require('./client-work-policy');
const { todayFor } = require('./dates');

const CLOSED = new Set(['done','closed','complete','completed','accepted','cancelled','superseded','frozen','published','approved','verified','waived','resolved','withdrawn']);
const day = value => value ? String(value).slice(0,10) : null;
const isOpen = value => !CLOSED.has(String(value || '').toLowerCase());
const number = value => value == null ? null : Number(value);
const REVIEW_SOURCES = new Set(['document_approval','workpaper_validation','csf_validation','csf_review','csf_profile','control_review','tprm_decision']);

function workspacePermissions(db,workspace,actor){
  const firm=actor.user_type==='firm',firmRole=rbac.normalizeRole(actor.firm_role),memberRole=rbac.normalizeRole(workspace.my_role);
  if(firm&&rbac.isManager(firmRole)&&Number(actor.firm_id)===Number(workspace.firm_id))return new Set(Object.keys(rbac.PERMISSIONS).concat(['*']));
  const crossView=firm&&rbac.rolePermissions(firmRole).includes('firm.cross_view');
  const role=firm?(crossView?firmRole:rbac.FIRM_ROLES.includes(memberRole)?memberRole:firmRole):memberRole;
  return rbac.effectivePermissions(role,rbac.activeOverrides(db,workspace.id,actor.id));
}

function authorizedWorkspaces(db, actor, requested) {
  if (!actor?.id) return [];
  const user = db.prepare('SELECT id,firm_id,user_type,firm_role,active FROM users WHERE id=?').get(actor.id);
  if (!user?.active) return [];
  const crossView = user.user_type === 'firm' && rbac.rolePermissions(user.firm_role).includes('firm.cross_view');
  const rows = db.prepare(`SELECT w.*,m.role AS my_role,
    EXISTS(SELECT 1 FROM vciso_services v WHERE v.workspace_id=w.id AND v.status IN ('active','on_hold')) AS vciso_enabled,
    EXISTS(SELECT 1 FROM tprm_modules tm WHERE tm.workspace_id=w.id AND tm.status IN ('active','needs_classification')) AS tprm_enabled
    FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=?
    WHERE (w.firm_id=? AND ?=1) OR (m.user_id=? AND (?='client' OR w.firm_id=?)) ORDER BY w.client_name,w.id`)
    .all(user.id,user.firm_id,crossView?1:0,user.id,user.user_type,user.firm_id);
  if (!requested) return rows;
  const ids = new Set(requested.map(ws => Number(typeof ws === 'object' ? ws.id : ws)));
  return rows.filter(ws => ids.has(ws.id));
}

function workspaceItems(db, workspace, actor, today) {
  const ws = workspace, items = [], firm = actor.user_type === 'firm';
  const perms = workspacePermissions(db,ws,actor);
  const has = permission => rbac.hasPermission(perms,permission);
  const base = `/workspaces/${ws.id}`;
  const people = new Map(db.prepare(`SELECT u.id,u.name,u.user_type,u.firm_role,u.firm_id,
    EXISTS(SELECT 1 FROM workspace_members m WHERE m.user_id=u.id AND m.workspace_id=?) AS member
    FROM users u WHERE u.active=1 AND ((u.user_type='firm' AND u.firm_id=?) OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.user_id=u.id AND m.workspace_id=?))`)
    .all(ws.id,ws.firm_id,ws.id).filter(p=>p.user_type==='firm'?Number(p.firm_id)===Number(ws.firm_id)&&(p.member||rbac.rolePermissions(p.firm_role).includes('firm.cross_view')):p.member).map(p=>[p.id,p]));
  const add = (type,row,options={}) => {
    const status = String(options.status || row.effective_status || row.status || 'open');
    const ownerId = number(options.ownerId === undefined ? row.owner_id ?? row.assignee_id : options.ownerId);
    const owner = people.get(ownerId);
    const ownerUnavailable=ownerId!=null&&!owner;
    const commands = options.allowedCommands || [];
    const item = {
      id: `${type}:${row.id}`, sourceType:type, sourceId:row.id,
      workspaceId:ws.id,workspaceName:ws.brand_display_name||ws.client_name,
      programme:programmeFor(ws,options.programme),engagementId:row.engagement_id||null,
      title:String(options.title || row.title || row.name || type),status,
      actionState:options.complete||!isOpen(status)&&!options.forceOpen?'complete':options.waitingOn?'waiting':status.toLowerCase()==='blocked'||(options.blocked===undefined?!!options.blockedReason:options.blocked)?'blocked':'action_required',
      actionLabel:options.actionLabel||'Open work',href:options.href||base,
      ownerId,ownerName:options.ownerName||owner?.name||(ownerUnavailable?'Assignment needs attention':null),ownerUnavailable,reviewerId:number(options.reviewerId||row.reviewer_id),
      waitingOn:options.waitingOn||null,dueDate:day(options.dueDate===undefined?row.due_date:options.dueDate),
      priority:options.priority||row.priority||row.severity||'normal',blockedReason:options.blockedReason||null,
      allowedCommands:commands,sourceVersion:row.row_version||row.version||row.version_number||null,
      updatedAt:row.updated_at||row.created_at||row.generated_at||null,
      estimatedMinutes:row.estimated_minutes==null?null:Number(row.estimated_minutes),
      relatedSourceKeys:options.relatedSourceKeys||[],assignedToActor:ownerId===Number(actor.id),
      participantToActor:(options.participantIds||[]).some(id=>id!=null&&Number(id)===Number(actor.id)),
      actionableByActor:commands.length>0,kind:options.kind||'work',
      review:options.review===undefined?(REVIEW_SOURCES.has(type)||commands.some(command=>['review','approve'].includes(command))):!!options.review,
    };
    // Plain enums only; no native records, internal notes or evidence payloads escape.
    item.programmeLabel=PROGRAMMES[item.programme].label;
    if(ownerUnavailable&&item.actionState!=='complete'){
      item.actionState='blocked';item.waitingOn=null;
      item.blockedReason='The assigned user is inactive or no longer has workspace access. Reassign the next step.';
      item.actionLabel='Review assignment';
    }
    if(!firm&&!commands.length)item.actionLabel=item.kind==='report'?'Read published report':'View status';
    item.overdue=item.actionState!=='complete'&&!!item.dueDate&&item.dueDate<today;
    items.push(item);
    return item;
  };
  const reportVisible = require('./iso42001-client-publication').createReportVisibility(db, ws);
  const policy = (sourceType,row) => clientWorkPolicy({db,workspace:ws,actor,sourceType,row,reportVisible});

  for (const row of db.prepare('SELECT id,workspace_id,engagement_id,workpaper_id,title,priority,status,assignee_id,consultant_owner_id,created_by,released_at,due_date,version,created_at,updated_at FROM client_requests WHERE workspace_id=?').all(ws.id)) {
    const access=policy('client_request',row);if(!access.visible) continue;
    const submitted=row.status==='submitted';
    const released=!!row.released_at;
    add('client_request',row,{ownerId:submitted||!released?row.consultant_owner_id||row.created_by:row.assignee_id,
      participantIds:[row.assignee_id,row.consultant_owner_id||row.created_by],
      title:row.title,actionLabel:!released?'Prepare and release request':submitted?'Review response':'Respond to request',
      waitingOn:isOpen(row.status)&&firm&&released&&!submitted?'client':!firm&&submitted?'firm':null,
      href:`${base}/client-portal/requests/${row.id}`,allowedCommands:access.allowedCommands,
      relatedSourceKeys:row.workpaper_id?[`workpaper:${row.workpaper_id}`]:[]});
  }

  // The existing delivery projection has an explicit read-only mode. It supplies
  // effective verification status and contracted phase scope without repairing data.
  const delivery=require('./engagement-delivery').getProjection(db,ws,actor.id,{ensure:false});
  if(delivery){
    for(const row of delivery.milestones.flatMap(m=>m.deliverables)){
      const access=policy('engagement_deliverable',row);
      if(!firm&&!access.visible)continue;
      if(firm&&!has('workspace.update')&&!has('client_portal.view'))continue;
      const status=row.effective_status||row.status;
      const reviewing=['submitted','workspace_verified'].includes(status);
      const who=reviewing?row.approver_id:row.owner_id;
      add('engagement_deliverable',row,{programme:row.framework_code || delivery.outcome.frameworkCode,ownerId:who,status,review:reviewing,
        participantIds:[row.owner_id,row.approver_id],
        title:!firm?(row.client_title||row.title):row.title,
        actionLabel:reviewing?'Review deliverable':'Prepare deliverable',
        waitingOn:firm&&people.get(who)?.user_type==='client'?'client':!firm&&Number(who)!==Number(actor.id)?people.get(who)?.user_type||null:null,
        href:!firm?`${base}/client-portal/deliverables/${row.id}`:`${base}/engagement-plan?view=deliverables#deliverable-${row.id}`,
        allowedCommands:access.allowedCommands});
    }
    if(firm&&has('workspace.update'))for(const phase of delivery.phases){
      if(!['blocked','waiting','in_progress','ready'].includes(phase.effective_status))continue;
      add('delivery_gate',{...phase,id:phase.id},{programme:delivery.outcome.frameworkCode,title:phase.name,status:phase.effective_status,
        ownerId:phase.owner_id||ws.lead_consultant_id,actionLabel:'Inspect phase gates',href:`${base}/engagement-plan`,
        waitingOn:!phase.gate_ready&&phase.effective_status!=='blocked'?'firm':null,blocked:phase.effective_status==='blocked',
        dueDate:phase.forecast_end_date||phase.planned_end_date,kind:'gate',allowedCommands:['inspect'],
        blockedReason:phase.criteria?.filter(c=>!c.pass).map(c=>c.label).join('; ')||null});
    }
  }

  const workpapers=db.prepare(`SELECT w.id,w.workspace_id,w.engagement_id,w.requirement_id,w.title,w.owner_id,w.reviewer_id,w.client_validator_id,w.prepared_by,w.status,w.client_visible,${firm?'NULL':'w.client_visible_summary'} AS client_visible_summary,w.due_date,w.row_version,w.created_at,w.updated_at,f.code framework_code FROM consultant_workpapers w JOIN requirements r ON r.id=w.requirement_id JOIN frameworks f ON f.id=r.framework_id WHERE w.workspace_id=?`).all(ws.id);
  for(const row of workpapers){
    if(!firm){
      const access=policy('workpaper_validation',row);if(!access.visible)continue;
      add('workpaper_validation',row,{programme:row.framework_code,ownerId:row.client_validator_id,title:row.client_visible_summary||row.title,
        actionLabel:'Validate assessment facts',href:`${base}/client-portal/workpapers/${row.id}/validate`,allowedCommands:access.allowedCommands});continue;
    }
    if(!has('control.view'))continue;
    const reviewing=row.status==='manager_review',validation=row.status==='client_validation',freeze=row.status==='approved';
    const reviewerEligible=has('document.review')&&Number(row.reviewer_id)===Number(actor.id)&&Number(row.prepared_by||row.owner_id)!==Number(actor.id);
    const commands=reviewing?(reviewerEligible?['review']:[]):freeze?(has('assessment.signoff')?['freeze']:[]):
      ['draft','changes_requested'].includes(row.status)&&has('control.update')?['prepare']:[];
    add('workpaper',row,{programme:row.framework_code,ownerId:reviewing?row.reviewer_id:validation?row.client_validator_id:row.owner_id,review:reviewing,participantIds:[row.owner_id,row.reviewer_id,row.client_validator_id],
      forceOpen:freeze,actionLabel:reviewing?'Review workpaper':validation?'Await factual validation':freeze?'Freeze approved workpaper':'Prepare workpaper',
      waitingOn:validation?'client':null,href:`${base}/delivery/workpapers/${row.id}`,allowedCommands:commands,
      blockedReason:reviewing&&!row.reviewer_id?'Assign an eligible independent reviewer':null});
  }

  for(const row of db.prepare(`SELECT d.id,d.workspace_id,d.name,d.status,d.current_version_id,d.approval_due,d.version,d.created_at FROM generated_docs d WHERE d.workspace_id=? AND d.current_version_id IS NOT NULL AND d.status NOT IN ('retired','published','approved')`).all(ws.id)){
    const access=policy('document_approval',row);if(!access.visible)continue;
    const next=require('./doc-approvals').nextPending(db,row.current_version_id);if(!next)continue;
    add('document_approval',row,{title:row.name,ownerId:next.row.user_id||null,ownerName:next.row.person_name,
      participantIds:!firm?[actor.id]:[],
      actionLabel:'Review policy',dueDate:row.approval_due,
      waitingOn:firm&&(next.kind==='external'||people.get(next.row.user_id)?.user_type==='client')?'client':!firm&&Number(next.row.user_id)!==Number(actor.id)?next.kind==='external'?'provider':people.get(next.row.user_id)?.user_type||null:null,
      href:firm?`${base}/documents/${row.id}`:`${base}/client-portal/policies/${row.id}`,allowedCommands:access.allowedCommands,
      blockedReason:next.kind==='external'?'Waiting for the current external approver':null});
  }

  // Specialist adapters retain source-specific eligibility and never infer that
  // a completed assessment is approved or that client validation is sign-off.
  const csf=require('./csf-policy-practice');
  const csfEngagements=db.prepare('SELECT * FROM csf_engagements WHERE workspace_id=? AND deleted_at IS NULL').all(ws.id);
  for(const engagement of csfEngagements){
    if(firm&&csf.canView(db,actor,engagement)){
      const profile=db.prepare("SELECT engagement_id,workspace_id,status,prepared_by,submitted_by,row_version,created_at,updated_at FROM csf_profile_contexts WHERE engagement_id=? AND status='submitted'").get(engagement.id);
      if(profile)add('csf_profile',{...profile,id:engagement.id},{programme:'csf',title:`Approve ${engagement.name} business profile`,ownerId:null,
        href:`${base}/csf/${engagement.id}/scope`,actionLabel:'Independently review business profile',
        allowedCommands:csf.canApprove(db,actor,engagement)&&![profile.prepared_by,profile.submitted_by].includes(actor.id)?['approve']:[]});
    }
    for(const row of db.prepare(`SELECT a.*,s.code,s.description,e.workspace_id FROM csf_subcategory_assessments a JOIN csf_subcategories s ON s.id=a.subcategory_id JOIN csf_engagements e ON e.id=a.engagement_id WHERE a.engagement_id=? AND a.status IN ('Assessor Complete','Reviewed','Client Validated')`).all(engagement.id)){
      if(!firm){
        if(row.status!=='Reviewed'||row.client_validation_status!=='requested')continue;
        const linked=db.prepare('SELECT cr.* FROM csf_action_links l JOIN client_requests cr ON cr.id=l.client_request_id WHERE l.assessment_id=? AND cr.workspace_id=? ORDER BY l.id DESC LIMIT 1').get(row.id,ws.id);
        const access=policy('csf_validation',{...row,assignee_id:linked?.assignee_id});if(!access.visible)continue;
        add('csf_validation',row,{programme:'csf',title:`Validate ${row.code} facts`,ownerId:linked?.assignee_id,
          href:`${base}/csf/${engagement.id}/portal`,actionLabel:'Validate assessment facts',allowedCommands:access.allowedCommands,
          relatedSourceKeys:linked?[`client_request:${linked.id}`]:[]});continue;
      }
      if(!csf.canView(db,actor,engagement))continue;
      const review=row.status==='Assessor Complete';
      const eligible=review?csf.canReview(db,actor,engagement)&&![row.policy_scored_by,row.practice_scored_by].includes(actor.id):csf.canApprove(db,actor,engagement)&&![row.policy_scored_by,row.practice_scored_by,row.reviewed_by].includes(actor.id);
      add('csf_review',row,{programme:'csf',title:`${row.code}: ${row.description}`,ownerId:engagement.assigned_lead_id,
        actionLabel:review?'Review Policy and Practice':'Inspect approval or validation',href:`${base}/csf/${engagement.id}/review`,
        waitingOn:row.client_validation_status==='requested'?'client':null,allowedCommands:eligible?['inspect']:[],dueDate:engagement.target_completion_date});
    }
    if(firm)for(const row of db.prepare('SELECT id,workspace_id,engagement_id,version_number,status,created_by,reviewed_by,created_at FROM csf_assessment_versions_v2 WHERE engagement_id=?').all(engagement.id)){
      const canReview=csf.canReview(db,actor,engagement)&&row.created_by!==actor.id;
      const canApprove=csf.canApprove(db,actor,engagement)&&![row.created_by,row.reviewed_by].includes(actor.id);
      const commands=row.status==='draft'&&canReview?['review']:row.status==='reviewed'&&canApprove?['approve']:row.status==='approved'&&csf.canApprove(db,actor,engagement)?['publish']:[];
      add('csf_report',row,{programme:'csf',title:`${engagement.name} - report v${row.version_number}`,forceOpen:row.status==='approved',kind:'report',review:['draft','reviewed'].includes(row.status),
        ownerId:row.status==='draft'?null:engagement.assigned_lead_id,href:`${base}/csf/${engagement.id}/report`,actionLabel:row.status==='approved'?'Publish approved version':'Review report version',allowedCommands:commands});
    }
  }

  if(firm){
    if(has('control.view'))for(const [table,programme] of [['assessment_passes','iso27001'],['iso42001_assessment_passes','iso42001']]){
      for(const row of db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).all(ws.id)){
        if(!isOpen(row.status))continue;
        add('assessment_pass',{...row,id:`${programme}:${row.id}`},{programme,title:`${PROGRAMMES[programme].label} ${row.label||row.name||`Pass ${row.pass_number}`}`,
          ownerId:row.started_by,href:`${base}/${programme==='iso27001'?'gap-assessment':'iso42001/gap-assessment'}`,
          actionLabel:'Continue assessment pass',allowedCommands:has('control.update')?['assess']:[]});
      }
    }
    if(has('workspace.update'))for(const row of db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=? AND target_date IS NOT NULL').all(ws.id))add('engagement',row,{
      programme:row.engagement_type==='advisory'&&ws.vciso_enabled?'vciso':undefined,
      ownerId:row.lead_consultant_id,dueDate:row.target_date,href:`${base}/delivery?engagement=${row.id}`,
      actionLabel:'Review engagement commitments',kind:'schedule',allowedCommands:['inspect']});
    if(has('control.view'))for(const [table,framework,hrefPrefix] of [['v_control_states','iso27001','controls/assess'],['v_iso42001_control_states','iso42001','iso42001/gap']]){
      for(const row of db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND review_status IN ('requested','needs_changes')`).all(ws.id)){
        add('control_review',{...row,id:`${framework}:${row.iso_item_id}`,status:row.review_status},{programme:framework,title:`Review ${row.iso_item_id}`,
          ownerId:row.review_status==='needs_changes'?row.review_requested_by:null,actionLabel:row.review_status==='requested'?'Review assessment conclusion':'Address review feedback',
          href:`${base}/${hrefPrefix}/${row.iso_item_id}`,allowedCommands:has('assessment.signoff')?['review']:[],dueDate:row.due_date});
      }
    }
    if(has('dpdpa.view'))for(const row of db.prepare('SELECT id,workspace_id,title,status,created_by,submitted_by,row_version,created_at,updated_at FROM dpdpa_gap_assessments WHERE workspace_id=?').all(ws.id)){
      const review=row.status==='Under Review',independent=![row.created_by,row.submitted_by].includes(actor.id);
      add('dpdpa_assessment',row,{programme:'dpdpa',ownerId:review?null:row.created_by,review,actionLabel:review?'Review assessment and N/A decisions':'Continue DPDPA assessment',
        href:`${base}/dpdpa/assessments/${row.id}${review?'/review':''}`,
        allowedCommands:review&&has('dpdpa.review')&&independent?['review']:!review&&has('dpdpa.assess')?['assess']:[],kind:'assessment'});
    }
    if(has('dpdpa.export'))for(const row of db.prepare(`SELECT s.id,s.workspace_id,s.assessment_id,s.sequence_number,s.status_at_capture,s.created_by,s.created_at,a.title FROM dpdpa_gap_assessment_snapshots s JOIN dpdpa_gap_assessments a ON a.id=s.assessment_id AND a.workspace_id=s.workspace_id WHERE s.workspace_id=?`).all(ws.id))add('dpdpa_report',row,{
      programme:'dpdpa',title:`${row.title} - snapshot ${row.sequence_number}`,status:row.status_at_capture==='Approved'?'approved':'captured',
      kind:'report',complete:true,ownerId:row.created_by,href:`${base}/dpdpa/assessments/${row.assessment_id}/report?snapshot=${row.id}`,
      actionLabel:'Inspect frozen snapshot',allowedCommands:['read'],blocked:false,blockedReason:row.status_at_capture==='Approved'?null:'Internal snapshot; assessment was not approved at capture'});
    if(has('report.view'))for(const [table,type] of [['consulting_report_snapshots','consulting_report'],['assurance_report_runs','assurance_report']]){
      const columns=type==='consulting_report'?'id,workspace_id,engagement_id,title,status,version_number,generated_by,generated_at':'id,workspace_id,title,status,framework,version_number,created_by,created_at,generated_at';
      for(const row of db.prepare(`SELECT ${columns} FROM ${table} WHERE workspace_id=?`).all(ws.id)){
        const maker=row.generated_by||row.created_by,readyReview=type==='consulting_report'?row.status==='generated':row.status==='in_review';
        const commands=readyReview&&has('report.approve')&&Number(maker)!==Number(actor.id)?['approve']:
          row.status==='approved'&&has('report.publish')?['publish']:row.status==='generated'&&has('report.generate')?['submit']:[];
        add(type,row,{programme:row.framework,ownerId:row.status==='generated'?maker:null,forceOpen:row.status==='approved',kind:'report',review:readyReview,
          href:type==='consulting_report'?`${base}/delivery/reports/${row.id}`:`${base}/assurance/runs/${row.id}`,
          actionLabel:row.status==='approved'?'Publish approved report':readyReview?'Independently review report':'Inspect report version',allowedCommands:commands});
      }
    }
    if(has('report.view'))for(const row of db.prepare(`SELECT q.id,q.workspace_id,q.report_id,q.requested_by,q.requested_at,
      r.title,r.engagement_id,r.generated_by,r.version_number FROM consulting_report_revision_requests q
      JOIN consulting_report_snapshots r ON r.id=q.report_id AND r.workspace_id=q.workspace_id
      WHERE q.workspace_id=? AND q.replacement_report_id IS NULL`).all(ws.id)){
      add('report_revision',{...row,status:'changes_requested',created_at:row.requested_at},{
        title:`Revise report: ${row.title} (v${row.version_number})`,ownerId:row.generated_by,
        participantIds:[row.generated_by,row.requested_by],kind:'report',review:false,
        href:`${base}/delivery/reports/${row.report_id}`,actionLabel:'Revise source work and generate replacement',
        allowedCommands:has('report.generate')?['generate_replacement']:[]});
    }
    if(has('control.view'))for(const row of db.prepare('SELECT * FROM consulting_findings WHERE workspace_id=?').all(ws.id)){
      add('consulting_finding',row,{href:`${base}/delivery/findings/${row.id}`,actionLabel:'Inspect finding and remediation',allowedCommands:has('control.update')?['inspect']:[]});
    }
    if(has('task.manage'))for(const row of db.prepare('SELECT * FROM tasks WHERE workspace_id=?').all(ws.id)){
      add('task',row,{href:`${base}/tasks?task=${row.id}`,actionLabel:'Open task',allowedCommands:['manage'],
        relatedSourceKeys:row.engagement_deliverable_id?[`engagement_deliverable:${row.engagement_deliverable_id}`]:[]});
    }
    for(const [table,type,permission,dateKey,titleKey] of [['audits','audit','audit.manage','audit_date','title'],['mrms','management_review','mrm.manage','meeting_date',null]]){
      if(!has(permission))continue;
      for(const row of db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).all(ws.id))add(type,row,{title:titleKey?row[titleKey]:'Management review',
        ownerId:row.created_by,href:`${base}/${table}/${row.id}`,dueDate:row[dateKey],actionLabel:'Open scheduled review',allowedCommands:['manage'],kind:'schedule'});
    }
    for(const [table,type,permission,ownerKey,path] of [['nonconformities','nonconformity','nc.manage','responsible','nonconformities'],['improvements','improvement','workspace.update','owner_name','improvements'],['risk_treatment_actions','risk_treatment','risk.view','owner_name','risks']]){
      if(!has(permission))continue;
      for(const row of db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).all(ws.id))add(type,row,{ownerId:null,ownerName:row[ownerKey]||null,
        href:`${base}/${path}${type==='nonconformity'?`/${row.id}`:type==='risk_treatment'?`/${row.risk_id}`:''}`,
        actionLabel:'Open assigned action',allowedCommands:['inspect'],blocked:false,blockedReason:row[ownerKey]?'Named legacy owner: link to a user before using personal workload':null});
    }
  }

  if(!firm&&has('client_portal.view')){
    for(const row of db.prepare("SELECT id,workspace_id,engagement_id,title,status,version_number,generated_at FROM consulting_report_snapshots WHERE workspace_id=? AND status='published'").all(ws.id))add('consulting_report',row,{
      kind:'report',ownerId:null,href:`${base}/client-portal/reports/${row.id}`,actionLabel:'Read published report'});
    for(const engagement of csfEngagements.filter(e=>e.visible_in_portal))for(const row of db.prepare("SELECT id,workspace_id,engagement_id,version_number,status,created_at FROM csf_assessment_versions_v2 WHERE engagement_id=? AND status='published'").all(engagement.id))add('csf_report',row,{
      programme:'csf',kind:'report',title:`${engagement.name} - report v${row.version_number}`,ownerId:null,href:`${base}/csf/${engagement.id}/portal`,actionLabel:'Read published report'});
  }
  if((firm&&has('tprm.portfolio.view'))||(!firm&&has('tprm.client_portal.view'))){
    const providers=new Map(db.prepare('SELECT id,name FROM suppliers WHERE workspace_id=?').all(ws.id).map(p=>[p.id,p.name]));
    const tprmHref=id=>`${base}/tprm/third-parties/${id}`;
    for(const row of db.prepare(`SELECT c.*,r.id recommendation_id,d.id decision_id FROM tprm_assessment_cycles c
      LEFT JOIN tprm_recommendations r ON r.cycle_id=c.id AND r.version=(SELECT MAX(r2.version) FROM tprm_recommendations r2 WHERE r2.cycle_id=c.id)
      LEFT JOIN tprm_client_decisions d ON d.cycle_id=c.id AND d.version=(SELECT MAX(d2.version) FROM tprm_client_decisions d2 WHERE d2.cycle_id=c.id)
      WHERE c.workspace_id=? AND EXISTS(SELECT 1 FROM tprm_modules m WHERE m.id=c.module_id AND m.status='active')`).all(ws.id)){
      const clientWaiting=!!row.recommendation_id&&!row.decision_id;
      if(!firm){
        if(!clientWaiting||!isOpen(row.status))continue;
        const access=policy('tprm_decision',row);if(!access.visible)continue;
        add('tprm_decision',row,{programme:'tprm',title:`Decide on ${providers.get(row.supplier_id)||'provider'}`,ownerId:row.client_decision_authority_id,
          href:`${base}/client-portal/tprm/${row.supplier_id}`,actionLabel:'Review recommendation and decide',dueDate:row.due_at,allowedCommands:access.allowedCommands});continue;
      }
      add('tprm_cycle',row,{programme:'tprm',title:`${providers.get(row.supplier_id)||'Provider'} - ${row.cycle_type.replaceAll('_',' ')}`,
        ownerId:clientWaiting?row.client_decision_authority_id:row.started_by,dueDate:row.due_at,
        waitingOn:clientWaiting?'client':null,href:tprmHref(row.supplier_id),actionLabel:clientWaiting?'Await client risk decision':'Inspect assessment cycle',
        allowedCommands:has('tprm.assessment.manage')?['inspect']:[]});
    }
    for(const row of db.prepare("SELECT c.* FROM tprm_conditions c JOIN tprm_assessment_cycles cycle ON cycle.id=c.cycle_id JOIN tprm_modules m ON m.id=cycle.module_id WHERE c.workspace_id=? AND m.status='active'").all(ws.id)){
      const access=firm?null:policy('tprm_condition',row);if(!firm&&!access.visible)continue;
      add('tprm_condition',row,{programme:'tprm',
      ownerId:row.owner_user_id,ownerName:row.owner_name,waitingOn:firm&&row.owner_type==='client'&&isOpen(row.status)?'client':!firm&&row.status==='evidence_submitted'?'firm':null,
      href:firm?`${tprmHref(row.supplier_id)}#conditions`:`${base}/client-portal/tprm/${row.supplier_id}#conditions`,actionLabel:'Inspect condition evidence and decision',allowedCommands:firm?(has('tprm.conditions.manage')?['inspect']:[]):access.allowedCommands});
    }
    if(firm)for(const row of db.prepare(`SELECT s.* FROM tprm_review_schedules s JOIN tprm_modules m ON m.id=s.module_id WHERE s.workspace_id=? AND m.status='active' AND NOT EXISTS(SELECT 1 FROM tprm_review_schedules newer WHERE newer.supersedes_id=s.id) AND NOT EXISTS(SELECT 1 FROM tprm_review_schedule_closures c WHERE c.schedule_id=s.id)`).all(ws.id))add('tprm_review',row,{programme:'tprm',
      title:`Review ${providers.get(row.supplier_id)||'provider'}`,status:'scheduled',ownerId:null,dueDate:row.next_review_date,
      href:tprmHref(row.supplier_id),actionLabel:'Open scheduled provider review',allowedCommands:has('tprm.monitoring.manage')?['inspect']:[],kind:'schedule'});
    if(firm)for(const row of db.prepare("SELECT c.* FROM tprm_clarifications c JOIN tprm_assessment_cycles cycle ON cycle.id=c.cycle_id JOIN tprm_modules m ON m.id=cycle.module_id WHERE c.workspace_id=? AND m.status='active'").all(ws.id))add('tprm_clarification',row,{programme:'tprm',
      title:`${providers.get(row.supplier_id)||'Provider'} clarification`,ownerId:row.status==='responded'?row.requested_by:null,
      waitingOn:row.status==='open'?'provider':null,href:tprmHref(row.supplier_id),actionLabel:row.status==='responded'?'Review provider response':'Await provider response',allowedCommands:has('tprm.assessment.manage')?['inspect']:[]});
  }
  return items;
}

function summarize(items,today){
  const soon=new Date(`${today}T12:00:00Z`);soon.setUTCDate(soon.getUTCDate()+7);const week=day(soon.toISOString());
  const counts={total:items.length,actionRequired:0,waiting:0,blocked:0,complete:0,overdue:0,dueSoon:0,unassigned:0,byProgramme:{},byType:{}};
  for(const item of items){
    counts[item.actionState==='action_required'?'actionRequired':item.actionState]++;
    if(item.actionState!=='complete'){
      if(item.dueDate&&item.dueDate<today)counts.overdue++;
      if(item.dueDate&&item.dueDate>=today&&item.dueDate<=week)counts.dueSoon++;
      if((!item.ownerId||item.ownerUnavailable)&&!item.waitingOn)counts.unassigned++;
    }
    counts.byProgramme[item.programme]=(counts.byProgramme[item.programme]||0)+1;
    counts.byType[item.sourceType]=(counts.byType[item.sourceType]||0)+1;
  }
  return counts;
}

function listWork({db,workspaces,actor,scope,filters={},today,cursor,limit=50}){
  const saved=actor?.id?db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(actor.id):null;
  if(!saved)return{items:[],counts:summarize([],today||day(new Date().toISOString())),facets:{owners:[],reviewers:[],sources:[]},workload:[],programmeSummaries:[],nextAction:null,asOf:new Date().toISOString(),today:today||day(new Date().toISOString()),cursor:'0',nextCursor:null,scope:scope||'mine'};
  const authorized=authorizedWorkspaces(db,saved,workspaces);
  const localToday=today||todayFor({firm_timezone:db.prepare('SELECT timezone FROM firms WHERE id=?').get(saved.firm_id||authorized[0]?.firm_id||null)?.timezone||'UTC'});
  let items=authorized.flatMap(ws=>workspaceItems(db,ws,saved,localToday));
  // A generated task is an alias for the same deliverable; factual validation
  // requests are similarly represented by the specialist decision when visible.
  const ids=new Set(items.map(i=>i.id));
  const aliases=new Set(items.filter(i=>['csf_validation'].includes(i.sourceType)).flatMap(i=>i.relatedSourceKeys));
  items=items.filter(i=>!aliases.has(i.id)&&!(i.sourceType==='task'&&i.relatedSourceKeys.some(key=>ids.has(key))));
  const resolvedScope=scope|| (saved.user_type==='client'?'client':rbac.isManager(saved.firm_role)?'all':'mine');
  if(resolvedScope==='mine')items=items.filter(i=>i.assignedToActor||i.participantToActor||i.actionableByActor&&i.review);
  const facets={owners:[...new Map(items.filter(i=>i.ownerId).map(i=>[i.ownerId,{id:i.ownerId,name:i.ownerName||`User ${i.ownerId}`}])).values()].sort((a,b)=>a.name.localeCompare(b.name)),
    reviewers:[...new Set(items.filter(i=>i.reviewerId).map(i=>i.reviewerId))].map(id=>({id,name:db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name||`User ${id}`})),
    sources:[...new Set(items.map(i=>i.sourceType))].sort()};
  if(filters.programme&&PROGRAMMES[filters.programme])items=items.filter(i=>i.programme===filters.programme);
  if(filters.type)items=items.filter(i=>filters.type==='review'?i.review:i.sourceType===filters.type);
  if(filters.owner==='unassigned')items=items.filter(i=>(!i.ownerId||i.ownerUnavailable)&&!i.waitingOn);
  else if(filters.owner)items=items.filter(i=>i.ownerId===Number(filters.owner));
  if(filters.reviewer==='me')items=items.filter(i=>i.review&&i.actionableByActor);
  else if(filters.reviewer)items=items.filter(i=>i.reviewerId===Number(filters.reviewer));
  if(filters.priority)items=items.filter(i=>String(i.priority).toLowerCase()===String(filters.priority).toLowerCase());
  if(filters.waiting)items=items.filter(i=>i.waitingOn===filters.waiting);
  if(filters.deadline==='unscheduled')items=items.filter(i=>!i.dueDate);
  else if(filters.deadline==='today')items=items.filter(i=>i.dueDate===localToday);
  else if(filters.deadline==='week'){const end=new Date(`${localToday}T12:00:00Z`);end.setUTCDate(end.getUTCDate()+7);items=items.filter(i=>i.dueDate>=localToday&&i.dueDate<=day(end.toISOString()));}
  if(filters.workspace)items=items.filter(i=>i.workspaceId===Number(filters.workspace));
  if(filters.kind)items=items.filter(i=>i.kind===filters.kind);
  if(filters.q){const term=String(filters.q).toLowerCase();items=items.filter(i=>[i.title,i.workspaceName,i.ownerName,i.programmeLabel].some(v=>String(v||'').toLowerCase().includes(term)));}
  if(filters.status==='overdue')items=items.filter(i=>i.actionState!=='complete'&&i.dueDate&&i.dueDate<localToday);
  else if(filters.status==='waiting')items=items.filter(i=>i.actionState==='waiting');
  else if(filters.status==='blocked')items=items.filter(i=>i.actionState==='blocked');
  else if(filters.status==='action_required')items=items.filter(i=>i.actionState==='action_required');
  else if(filters.status==='complete')items=items.filter(i=>i.actionState==='complete');
  else if(filters.status!=='all')items=items.filter(i=>i.actionState!=='complete');
  if(filters.from)items=items.filter(i=>i.dueDate&&i.dueDate>=filters.from);
  if(filters.to)items=items.filter(i=>i.dueDate&&i.dueDate<=filters.to);
  const rank={critical:0,urgent:0,high:1,major:1,medium:2,normal:3,minor:3,low:4};
  items.sort((a,b)=>(a.actionState==='complete')-(b.actionState==='complete')||Number(b.overdue)-Number(a.overdue)||(rank[a.priority]??3)-(rank[b.priority]??3)||String(a.dueDate||'9999').localeCompare(String(b.dueDate||'9999'))||a.id.localeCompare(b.id));
  const counts=summarize(items,localToday);
  const workload=Object.values(items.filter(i=>i.actionState!=='complete').reduce((groups,item)=>{
    const key=item.waitingOn?`waiting:${item.waitingOn}`:item.ownerId&&!item.ownerUnavailable?`user:${item.ownerId}`:'unassigned';
    const group=groups[key]||={key,ownerId:item.waitingOn||item.ownerUnavailable?null:item.ownerId,name:item.waitingOn?`Waiting on ${item.waitingOn}`:key==='unassigned'?'Needs assignment':item.ownerName,waitingOn:item.waitingOn,total:0,overdue:0,estimatedMinutes:0,unestimated:0};
    group.total++;if(item.overdue)group.overdue++;
    if(item.estimatedMinutes==null)group.unestimated++;else group.estimatedMinutes+=item.estimatedMinutes;
    return groups;
  },{})).sort((a,b)=>b.overdue-a.overdue||b.total-a.total||a.name.localeCompare(b.name));
  const programmeSummaries=Object.keys(counts.byProgramme).map(code=>({code,label:PROGRAMMES[code].label,
    ...summarize(items.filter(i=>i.programme===code),localToday),endpoint:PROGRAMMES[code].endpoint,
    nextAction:items.find(i=>i.programme===code&&i.actionState==='action_required'&&i.actionableByActor)||null}));
  const pageSize=Math.min(200,Math.max(1,Number(limit)||50));
  const offset=/^\d+$/.test(String(cursor||''))?Number(cursor):0;
  return{items:items.slice(offset,offset+pageSize),counts,facets,workload,programmeSummaries,nextAction:items.find(i=>i.actionableByActor&&i.actionState==='action_required')||null,
    asOf:new Date().toISOString(),today:localToday,cursor:String(offset),nextCursor:offset+pageSize<items.length?String(offset+pageSize):null,scope:resolvedScope};
}

module.exports={listWork,authorizedWorkspaces,workspaceItems,workspacePermissions,summarize};
