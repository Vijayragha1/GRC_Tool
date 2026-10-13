'use strict';

const rbac=require('../lib/rbac');
const {listWork,authorizedWorkspaces,workspacePermissions}=require('../lib/work-projection');
const {PROGRAMMES,programmeCards}=require('../lib/programme-experience');
const {experienceFor}=require('../lib/experience-flags');
const {engagementHealth,relativeDue,shortDate,weekday}=require('../lib/work-overview');

function register(app,{db,requireAuth}){
  function page(view){return(req,res)=>{
    const actor=req.user;
    const workspaces=authorizedWorkspaces(db,actor,req.params.wsId?[Number(req.params.wsId)]:undefined);
    const ws=req.params.wsId?workspaces[0]:null;
    if(req.params.wsId&&!ws)return res.status(404).render('error',{user:actor,message:'This workspace is unavailable.'});
    if(actor.user_type==='client'){
      const target=ws||workspaces[0];
      if(!target)return res.status(404).render('error',{user:actor,message:'No client workspace is available.'});
      const section=view==='reports'?'reports':view==='overview'?'home':'actions';
      return res.redirect(`/workspaces/${target.id}/client-portal?view=${section}`);
    }
    const crossView=actor.user_type==='firm'&&rbac.rolePermissions(actor.firm_role).includes('firm.cross_view');
    const isManager=actor.user_type==='firm'&&rbac.isManager(actor.firm_role);
    const scope=view==='reports'?'team':req.query.scope==='mine'?'mine':req.query.scope==='team'?'team':isManager?'all':'mine';
    const filters=Object.fromEntries(['q','programme','owner','reviewer','priority','waiting','deadline','status','type','from','to','workspace'].map(key=>[key,String(req.query[key]||'').slice(0,180)]));
    if(view==='reports'){filters.kind='report';filters.status='all';}
    if(view==='calendar'){
      filters.from=/^\d{4}-\d{2}-\d{2}$/.test(filters.from)?filters.from:'';
      filters.to=/^\d{4}-\d{2}-\d{2}$/.test(filters.to)?filters.to:'';
    }
    const result=listWork({db,workspaces,actor,scope,filters,cursor:req.query.cursor,limit:50,digest:view==='overview'});
    const base=ws?`/workspaces/${ws.id}/work`:'/work';
    const query=(changes={},path=req.path)=>{
      const params=new URLSearchParams();
      for(const [key,value]of Object.entries({...req.query,...changes}))if(value!==undefined&&value!==null&&value!=='')params.set(key,String(value));
      return path+(params.size?'?'+params:'');
    };
    // Populate workspace presentation locals without the legacy ensure middleware.
    if(ws){
      res.locals.userPerms=workspacePermissions(db,ws,actor);
      res.locals.entitySelectorWs=ws;res.locals.workspaceEntities=[];
    }
    const rollout=experienceFor(db,{actor,workspace:ws});
    res.locals.experienceEnabled=rollout.enabled;
    const detailHref=href=>{const url=new URL(href,'http://work.local');url.searchParams.set('return_to',query());return url.pathname+url.search+url.hash;};
    const locals={user:actor,ws,active:'work',view,result,filters,workScope:scope,crossView,isManager,base,query,detailHref,workspaces,PROGRAMMES,
      programmes:ws&&actor.user_type==='firm'?programmeCards(ws):[],rollout,
      health:view==='overview'&&isManager?engagementHealth(db,workspaces,actor,result.today,result.counts.byWorkspace):null,relativeDue,shortDate,weekday,
      title:view==='overview'?(isManager?'Delivery overview':'My overview'):view==='calendar'?'Calendar':view==='workload'?'Team workload':view==='reports'?'Reports':scope==='mine'?'My work':'Work queue'};
    return res.render(view==='overview'?'experience_overview':'work_queue',locals);
  };}
  for(const prefix of ['/work','/workspaces/:wsId/work']){
    app.get(prefix,requireAuth,page('queue'));
    for(const view of ['overview','calendar','workload','reports'])app.get(`${prefix}/${view}`,requireAuth,page(view));
  }
}

module.exports={register};
