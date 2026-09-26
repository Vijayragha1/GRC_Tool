'use strict';
const crypto=require('crypto');
const rbac=require('./rbac');
const controlWrites=require('./control-writes');
const enc=require('./encryption');
const notifications=require('./notification-delivery');
const frameworks=new Set(['iso27001','iso42001']);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function permissions(db,ws,actor){const c=require('./client-work-policy').actorContext(db,ws,actor);return c.active&&c.firm?c.permissions:new Set();}
function snapshot(row){
  const fields=['status','applicability','maturity','scope_pct','notes','inclusion_justification','exclusion_justification','assessment_answers','owner_id','due_date'];
  return Object.fromEntries(fields.map(key=>[key,row[key]??null]));
}
function context(db,ws,actor,framework,itemId){
  if(!frameworks.has(framework))throw fail('Unsupported assessment programme.',422);
  const requirementId=controlWrites.requirementId(db,framework,itemId);
  const row=requirementId?db.prepare('SELECT * FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL').get(ws.id,requirementId):null;
  const historyTable=framework==='iso27001'?'control_state_history':'iso42001_control_state_history';
  const latest=db.prepare(`SELECT changed_by FROM ${historyTable} WHERE workspace_id=? AND iso_item_id=? ORDER BY id DESC LIMIT 1`).get(ws.id,itemId);
  const request=requirementId?db.prepare(`SELECT * FROM assessment_review_events WHERE workspace_id=? AND requirement_id=? AND action='request' ORDER BY id DESC LIMIT 1`).get(ws.id,requirementId):null;
  const fresh=!!(row&&request&&row.review_status==='requested'&&request.result_record_version===row.record_version&&request.snapshot_hash===hash(JSON.stringify(snapshot(row))));
  const allowed=actor.user_type==='firm'&&rbac.hasPermission(permissions(db,ws,actor),'assessment.signoff');
  const independent=![Number(row?.review_requested_by),Number(latest?.changed_by),Number(request?.prepared_by)].includes(Number(actor.id));
  const canClear=!!row&&row.review_status!=='none'&&(Number(row.review_requested_by)===Number(actor.id)||allowed);
  return {requirementId,row,recordVersion:row?.record_version||0,latestPreparerId:latest?.changed_by||null,request,requestFresh:fresh,
    canReview:allowed&&independent&&fresh,canClear,hasAuthority:allowed};
}
function transition(db,{workspace:ws,actor,framework,itemId,action,expectedRecordVersion,note},audit){
  return db.transaction(()=>{
    const active=db.prepare('SELECT * FROM users WHERE id=? AND active=1 AND user_type=\'firm\' AND firm_id=?').get(actor.id,ws.firm_id);
    if(!active||!require('./client-work-policy').actorContext(db,ws,active).active)throw fail('Only an active firm consultant with workspace access can manage assessment review.',403);
    const c=context(db,ws,active,framework,itemId);
    if(!c.requirementId)throw fail('The assessment requirement is unavailable.',404);
    if(expectedRecordVersion===undefined||expectedRecordVersion===null||expectedRecordVersion==='')throw fail('Reload the assessment before deciding; its recorded version is required.',422);
    const expected=Number(expectedRecordVersion);
    if(!Number.isInteger(expected)||expected!==c.recordVersion)throw fail('The assessment changed. Your review action was not applied. Reload and compare the recorded conclusion.');
    if(!['request','approve','send_back','clear'].includes(action))throw fail('Choose a valid review action.',422);
    const text=String(note||'').trim();if(text.length>4000)throw fail('Review rationale must be 4,000 characters or fewer.',422);
    let to,recipients=[];
    if(action==='request'){
      if(!rbac.hasPermission(permissions(db,ws,active),'control.update'))throw fail('You cannot request an assessment review.',403);
      if(c.row?.review_status==='requested'&&c.requestFresh)throw fail('An independent review is already pending for this recorded version.');
      to='requested';
      recipients=db.prepare("SELECT * FROM users WHERE firm_id=? AND user_type='firm' AND active=1").all(ws.firm_id)
        .filter(user=>![Number(actor.id),Number(c.latestPreparerId)].includes(user.id)&&rbac.hasPermission(permissions(db,ws,user),'assessment.signoff')).map(user=>user.id);
      if(!recipients.length)throw fail('Assign an independent consultant with assessment sign-off permission before requesting review.',422);
    }else if(action==='clear'){
      if(!c.canClear)throw fail('Only the requester or an assessment reviewer can clear this review flag.',403);
      to='none';recipients=[c.row.review_requested_by];
    }else{
      if(!c.hasAuthority)throw fail('Assessment sign-off permission is required.',403);
      if(!c.row||c.row.review_status!=='requested')throw fail('This assessment is not awaiting review.');
      if([Number(c.row.review_requested_by),Number(c.latestPreparerId),Number(c.request?.prepared_by)].includes(Number(actor.id)))throw fail('The requester or latest preparer cannot review their own assessment.',403);
      if(!c.requestFresh)throw fail('The assessment changed after review was requested. Request a new review of the current recorded conclusion.');
      if(!text)throw fail('Record a review rationale before approving or sending back the assessment.',422);
      to=action==='approve'?'reviewed':'needs_changes';recipients=[c.row.review_requested_by];
    }
    if(!c.row)db.prepare('INSERT INTO control_instances(workspace_id,requirement_id,entity_id) VALUES (?,?,NULL)').run(ws.id,c.requirementId);
    const before=db.prepare('SELECT * FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL').get(ws.id,c.requirementId);
    const json=JSON.stringify(snapshot(before)),from=before.review_status||'none';
    let changed;
    if(action==='request')changed=db.prepare(`UPDATE control_instances SET review_status='requested',review_requested_by=?,review_requested_at=CURRENT_TIMESTAMP,
      review_reason=?,reviewed_by=NULL,reviewed_at=NULL WHERE id=? AND record_version=?`).run(actor.id,text||null,before.id,before.record_version);
    else if(action==='clear')changed=db.prepare(`UPDATE control_instances SET review_status='none',review_requested_by=NULL,review_requested_at=NULL,
      review_reason=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=? AND record_version=? AND review_status=?`).run(before.id,before.record_version,from);
    else changed=db.prepare(`UPDATE control_instances SET review_status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP
      WHERE id=? AND record_version=? AND review_status='requested'`).run(to,actor.id,before.id,before.record_version);
    if(changed.changes!==1)throw fail('The assessment changed before this review action could be applied.');
    const after=db.prepare('SELECT record_version FROM control_instances WHERE id=?').get(before.id);
    const eventId=Number(db.prepare(`INSERT INTO assessment_review_events(workspace_id,requirement_id,framework_code,actor_id,prepared_by,action,
      request_event_id,source_record_version,result_record_version,from_status,to_status,note,source_snapshot,snapshot_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ws.id,c.requirementId,framework,actor.id,c.latestPreparerId||c.request?.prepared_by||actor.id,action,
        action==='request'?null:c.request?.id||null,expected,after.record_version,from,to,text||null,enc.encryptIfNeeded(json,ws.id,!!ws.encryption_enabled),hash(json)).lastInsertRowid);
    if(audit)audit({eventId,action,from,to,source_record_version:expected,result_record_version:after.record_version,note:text});
    const link=framework==='iso27001'?`/workspaces/${ws.id}/controls/assess/${itemId}`:`/workspaces/${ws.id}/iso42001/gap/${itemId}`;
    notifications.enqueue(db,{workspaceId:ws.id,actorId:actor.id,eventKey:`assessment_review_event:${eventId}`,sourceType:'assessment_review',sourceId:c.requirementId,
      recipientIds:recipients,title:action==='request'?'Assessment review requested':action==='approve'?'Assessment reviewed':action==='send_back'?'Assessment changes requested':'Assessment review cancelled',
      body:`${framework.toUpperCase()} · ${itemId}`,link});
    return {eventId,status:to,recordVersion:after.record_version};
  })();
}
module.exports={context,transition,snapshot};
