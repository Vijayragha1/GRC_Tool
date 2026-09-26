'use strict';
const drafts = require('../lib/form-drafts');
const rbac = require('../lib/rbac');

function register(app, deps) {
  const {db,requireAuth,requireWorkspace} = deps;
  function target(req,res) {
    const kind=req.params.kind,recordId=String(req.params.recordId);
    const ws=req.workspace,actor=req.user;
    const authority=require('../lib/client-work-policy').actorContext(db,ws,actor);
    if(!authority.active)throw drafts.failure('This workspace is no longer available to your account.',403);
    const perms=authority.permissions;
    const can=p=>rbac.hasPermission(perms,p);
    let record, contextKey='';
    if (kind==='assessment' && authority.firm && can('control.view') && can('control.update')) {
      record=db.prepare(`SELECT i.id,COALESCE(c.record_version,0) version FROM iso_items i
        LEFT JOIN v_control_states c ON c.workspace_id=? AND c.iso_item_id=i.id
        WHERE i.id=? AND i.type IN ('clause','control')`).get(ws.id,recordId);
      contextKey=String(db.prepare("SELECT id FROM assessment_passes WHERE workspace_id=? AND status='in_progress' ORDER BY pass_number DESC LIMIT 1").get(ws.id)?.id || '');
    } else if (kind==='assessment-iso42001' && authority.firm && can('control.view') && can('control.update')) {
      record=db.prepare(`SELECT i.id,COALESCE(c.record_version,0) version FROM iso42001_items i
        LEFT JOIN v_iso42001_control_states c ON c.workspace_id=? AND c.iso_item_id=i.id WHERE i.id=? AND i.type IN ('clause','control')`).get(ws.id,recordId);
      contextKey=String(db.prepare("SELECT id FROM iso42001_assessment_passes WHERE workspace_id=? AND status='open' ORDER BY pass_number DESC LIMIT 1").get(ws.id)?.id || '');
    } else if (kind==='workpaper' && authority.firm && can('control.view') && can('control.update')) {
      record=db.prepare("SELECT id,row_version version,status FROM consultant_workpapers WHERE workspace_id=? AND id=?").get(ws.id,recordId);
      if (record && !['draft','changes_requested'].includes(record.status) && req.method!=='GET') throw drafts.failure('This workpaper is no longer editable. Your private draft is retained.',409);
    } else if (['client-response','client-comment'].includes(kind)) {
      record=db.prepare('SELECT * FROM client_requests WHERE workspace_id=? AND id=?').get(ws.id,recordId);
      if (record) {
        const policy=require('../lib/client-request-policy').requestPolicy({db,workspace:ws,actor,row:record});
        if (!policy.visible || (kind==='client-response' ? !policy.canRespond && !policy.commands.length : !can('client_request.respond'))) record=null;
      }
    } else if (kind==='policy-decision' && can('document.review')) {
      record=db.prepare('SELECT id,current_version_id version FROM generated_docs WHERE workspace_id=? AND id=?').get(ws.id,recordId);
      if (record) {
        const policy=require('../lib/client-work-policy').clientWorkPolicy({db,workspace:ws,actor,sourceType:'document_approval',row:{id:record.id,workspace_id:ws.id}});
        if (!policy.commands.some(c=>['approve','changes'].includes(c))) record=null;
        else contextKey=String(record.version);
      }
    } else if ((kind==='deliverable-comment' && can('comment.create') && can('client_request.respond')) || kind==='deliverable-decision') {
      record=db.prepare(`SELECT d.*,p.workspace_id FROM engagement_delivery_deliverables d
        JOIN engagement_delivery_milestones m ON m.id=d.milestone_id
        JOIN engagement_delivery_phases ph ON ph.id=m.phase_id
        JOIN engagement_delivery_plans p ON p.id=ph.plan_id WHERE p.workspace_id=? AND d.id=?`).get(ws.id,recordId);
      if (record) {
        const policy=require('../lib/client-work-policy').clientWorkPolicy({db,workspace:ws,actor,sourceType:'deliverable',row:record});
        if (!require('../lib/engagement-delivery').isDeliverableInOutcomeScope(db,ws,record.id) || !policy.visible || (kind==='deliverable-decision' && !policy.commands.some(c=>['submit','accept','changes'].includes(c)))) record=null;
      }
    }
    if (!record) throw drafts.failure('This draft is not available to your account.',403);
    return {workspaceId:ws.id,actorId:actor.id,kind,recordId,contextKey,recordVersion:record.version ?? record.row_version ?? 0,encryptionEnabled:!!ws.encryption_enabled};
  }
  function assessmentContext(c,key) {
    if (!['assessment','assessment-iso42001'].includes(c.kind)) throw drafts.failure('Historical draft contexts are unavailable for this form.',422);
    const value=String(key ?? '');
    const table=c.kind==='assessment'?'assessment_passes':'iso42001_assessment_passes';
    if (value!=='' && (!/^\d+$/.test(value) || !db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? AND id=?`).get(c.workspaceId,value))) throw drafts.failure('This assessment context is unavailable.',403);
    return value;
  }
  function priorDrafts(c) {
    if (!['assessment','assessment-iso42001'].includes(c.kind)) return [];
    const table=c.kind==='assessment'?'assessment_passes':'iso42001_assessment_passes';
    return drafts.previous(db,c).flatMap(d=>{
      if(d.contextKey==='')return [{...d,label:'Before an assessment pass was started'}];
      const pass=db.prepare(`SELECT pass_number,status FROM ${table} WHERE workspace_id=? AND id=?`).get(c.workspaceId,d.contextKey);
      return pass?[{...d,label:`Pass ${pass.pass_number} (${pass.status.replaceAll('_',' ')})`}]:[];
    });
  }
  function handler(action) { return (req,res)=>{
    try {
      const c=target(req,res);
      if (req.body?.contextKey != null && String(req.body.contextKey)!==c.contextKey) throw drafts.failure('The assessment pass changed. Your previous draft is retained; reopen it in its original pass.');
      let value;
      if (action==='get') { const selected=req.query.contextKey===undefined?c:{...c,contextKey:assessmentContext(c,req.query.contextKey)};value={...drafts.get(db,selected),selectedContextKey:selected.contextKey,previousDrafts:priorDrafts(c)}; }
      else if (action==='recover') {assessmentContext(c,req.body.sourceContextKey);value={draft:drafts.recover(db,c,req.body)};}
      else if (action==='save') value={draft:drafts.save(db,c,req.body)};
      else value=drafts.discard(db,c,req.body);
      res.set('Cache-Control','no-store').json({...value,contextKey:c.contextKey,recordVersion:c.recordVersion});
    } catch(e) { res.status(e.status||500).json({error:e.status?e.message:'The draft could not be saved. Your edits are still on this screen.',code:e.code||'draft_error'}); }
  }; }
  for (const prefix of ['/workspaces/:wsId/form-drafts','/workspaces/:wsId/client-portal/form-drafts']) {
    app.get(prefix+'/:kind/:recordId',requireAuth,requireWorkspace,handler('get'));
    app.post(prefix+'/:kind/:recordId/recover',requireAuth,requireWorkspace,handler('recover'));
    app.put(prefix+'/:kind/:recordId',requireAuth,requireWorkspace,handler('save'));
    app.delete(prefix+'/:kind/:recordId',requireAuth,requireWorkspace,handler('discard'));
  }
}
module.exports={register};
