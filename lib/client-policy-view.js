'use strict';
const enc=require('./encryption');
const documentHtml=require('./document-html');
const approvals=require('./doc-approvals');
function render(db,req,res,raw,options={}){
  const currentVersion=raw.current_version_id?db.prepare('SELECT * FROM doc_versions WHERE id=? AND workspace_id=?').get(raw.current_version_id,req.workspace.id):null;
  const doc={...raw,content:documentHtml.sanitizeDocumentHtml(enc.decryptIfNeeded(currentVersion?.content ?? raw.content,req.workspace.id))};
  const approvers=currentVersion?approvals.listChain(db,currentVersion.id):[];
  const comments=db.prepare(`SELECT c.*,u.name user_name FROM comments c JOIN users u ON u.id=c.user_id
    WHERE c.workspace_id=? AND c.parent_type='document' AND c.parent_id=? ${req.user.user_type==='client'?'AND c.internal_only=0':''} ORDER BY c.created_at,c.id`).all(req.workspace.id,String(doc.id)).map(c=>({...c,body:enc.decryptIfNeeded(c.body,req.workspace.id)}));
  const myApproval=approvers.find(a=>a.kind==='internal'&&a.user_id===req.user.id&&!a.decision);
  const next=currentVersion?approvals.nextPending(db,currentVersion.id):null;
  const isMyTurn=!!(myApproval&&next?.kind==='internal'&&next.row.id===myApproval.id&&currentVersion.status==='in_review');
  return res.status(options.status||200).render('client_portal_policy',{user:req.user,ws:req.workspace,active:'client-portal',title:doc.name,
    doc,currentVersion,approvers,comments,myApproval,isMyTurn,decisionError:options.error||null,decisionReason:options.reason||''});
}
module.exports={render};
