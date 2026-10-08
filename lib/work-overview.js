'use strict';

// Read-only presentation data for the manager's delivery overview: one health
// row per client engagement, built from the delivery plan projection (never
// ensurePlan, which writes) and the consulting portfolio's hours.
const delivery=require('./engagement-delivery');
const consulting=require('./consulting-delivery');
const {PROGRAMMES}=require('./programme-experience');

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function shortDate(iso,today){
  if(!iso)return '';
  const [year,month,dayOfMonth]=String(iso).slice(0,10).split('-').map(Number);
  return `${dayOfMonth} ${MONTHS[month-1]}${String(year)===String(today).slice(0,4)?'':` ${year}`}`;
}

function weekday(iso){return DAYS[new Date(`${String(iso).slice(0,10)}T12:00:00Z`).getUTCDay()];}

function daysFrom(from,to){
  return Math.round((Date.parse(`${String(to).slice(0,10)}T12:00:00Z`)-Date.parse(`${String(from).slice(0,10)}T12:00:00Z`))/86400000);
}

function plural(count,word){return `${count} ${word}${count===1?'':'s'}`;}

function relativeDue(due,today){
  if(!due)return{label:'No due date',tone:'neutral'};
  const days=daysFrom(today,due);
  if(days<0)return{label:`${plural(-days,'day')} late`,tone:'bad'};
  if(days===0)return{label:'Due today',tone:'warn'};
  if(days===1)return{label:'Due tomorrow',tone:'warn'};
  return{label:`Due ${shortDate(due,today)}`,tone:days<=7?'warn':'neutral'};
}

function hours(value){return Number(value||0).toLocaleString('en-GB',{maximumFractionDigits:1});}

function schedule(projection,late,today){
  if(!projection)return{label:'No delivery plan',tone:'neutral',detail:''};
  const {target_completion_date:target,forecast_completion_date:forecast}=projection.plan;
  const variance=Number(projection.summary.varianceDays)||0;
  if(!projection.currentPhase)return{label:'Complete',tone:'good',detail:projection.outcome.label};
  if(variance>0)return{label:`${plural(variance,'day')} behind`,tone:'bad',detail:`Forecast ${shortDate(forecast,today)}, target ${shortDate(target,today)}`};
  if(late.length)return{label:`${plural(late.length,'phase')} overdue`,tone:'warn',detail:target?`Target ${shortDate(target,today)}`:''};
  if(target)return{label:'On target',tone:'good',detail:`Target ${shortDate(target,today)}`};
  return{label:'No target set',tone:'neutral',detail:''};
}

function healthRow(ws,projection,engagement,counts,today){
  const name=ws.brand_display_name||ws.client_name;
  const phases=projection?projection.phases.filter(phase=>!phase.is_continuous):[];
  const isDone=phase=>['complete','waived'].includes(phase.effective_status);
  const late=phases.filter(phase=>!isDone(phase)&&phase.planned_end_date&&phase.planned_end_date<today);
  const current=projection?.currentPhase||null;
  // The phase the plan says is running today, when it differs from the first open one.
  const running=phases.find(phase=>!isDone(phase)&&phase.planned_start_date&&phase.planned_start_date<=today&&(!phase.planned_end_date||phase.planned_end_date>=today));
  let phaseNote='';
  if(current&&late.includes(current))phaseNote=`Planned to end ${shortDate(current.planned_end_date,today)}`;
  else if(current?.planned_end_date)phaseNote=`Due to end ${shortDate(current.planned_end_date,today)}`;
  const planAt=running&&current&&running.id!==current.id?`Plan has reached ${running.name}`:'';
  const planned=Number(engagement?.planned_hours)||0,actual=Number(engagement?.actual_hours)||0;
  return{
    id:ws.id,name,
    href:projection?`/workspaces/${ws.id}/engagement-plan`:`/workspaces/${ws.id}`,
    programme:PROGRAMMES[projection?.outcome.frameworkCode]?.label||'',
    service:projection?.outcome.label||(engagement?String(engagement.engagement_type||'').replaceAll('_',' '):''),
    phase:current?current.name:projection?'All phases complete':'No delivery plan',
    phaseNote,planAt,phaseLate:!!(current&&late.includes(current)),done:phases.filter(isDone).length,total:phases.length,
    schedule:schedule(projection,late,today),variance:Number(projection?.summary.varianceDays)||0,late:late.length,
    counts,status:projection?(current?'active':'complete'):(engagement?.status==='complete'?'complete':'active'),
    hours:planned||actual?{actual:hours(actual),planned:planned?hours(planned):null,pct:planned?Math.round(actual/planned*100):null}:null,
    lead:engagement?.lead_name||null,reviewer:engagement?.reviewer_name||null,
    // Phase ends inside the next 30 days feed the overview's dated list.
    milestones:phases.filter(phase=>!isDone(phase)&&phase.planned_end_date&&phase.planned_end_date>=today&&daysFrom(today,phase.planned_end_date)<=30)
      .map(phase=>({date:phase.planned_end_date,title:`${phase.name} due to finish`,client:name,href:`/workspaces/${ws.id}/engagement-plan`}))
  };
}

function engagementHealth(db,workspaces,actor,today,byWorkspace={}){
  const ids=new Set(workspaces.map(ws=>Number(ws.id)));
  const engagements=new Map();
  for(const row of consulting.portfolio(db,actor.firm_id)){
    if(!ids.has(Number(row.workspace_id)))continue;
    const kept=engagements.get(Number(row.workspace_id));
    if(!kept||kept.status!=='active'&&row.status==='active')engagements.set(Number(row.workspace_id),row);
  }
  const rows=[],quiet=[];
  for(const ws of workspaces){
    const counts=byWorkspace[ws.id]||{open:0,overdue:0,unassigned:0,waiting:0};
    let projection=null;
    // One unreadable plan must not take the firm's home page down with it.
    try{projection=delivery.getProjection(db,ws,actor.id,{ensure:false});}
    catch(error){console.warn(`[work-overview] plan for workspace ${ws.id} unavailable: ${error.message}`);}
    if(projection&&!projection.phases.length)projection=null;
    const engagement=engagements.get(Number(ws.id))||null;
    if(!projection&&!engagement&&!counts.open){quiet.push({id:ws.id,name:ws.brand_display_name||ws.client_name,href:`/workspaces/${ws.id}`});continue;}
    rows.push(healthRow(ws,projection,engagement,counts,today));
  }
  const risk=row=>row.variance+row.late*30+row.counts.overdue*2;
  rows.sort((a,b)=>(a.status==='complete')-(b.status==='complete')||risk(b)-risk(a)||a.name.localeCompare(b.name));
  return{active:rows.filter(row=>row.status!=='complete'),complete:rows.filter(row=>row.status==='complete'),quiet};
}

module.exports={engagementHealth,relativeDue,shortDate,weekday};
