'use strict';
const fs=require('node:fs');
const GROUPS=['contributor','sponsor','coordinator','junior_consultant','experienced_consultant','manager'];
const RELIABILITY=['draftRecovery','uploadRecovery','duplicateSubmit','staleChange','roleWorkspaceIsolation','notificationRetryAccess','independentReviewPublication','retainedReportIntegrity'];
const finite=n=>typeof n==='number'&&Number.isFinite(n);
function evaluate(input){
  const failures=[],groups={},ids=new Set();
  if(input?.schemaVersion!==1)failures.push('Expected schemaVersion 1.');
  if(input?.status!=='collected')failures.push('Real participant collection is pending.');
  if(!input?.build||!input?.sessionDate)failures.push('Build and session date are required.');
  if(!Number.isInteger(input?.highSeverityOpen)||input.highSeverityOpen!==0)failures.push('Unresolved high-severity defects must be recorded as zero.');
  for(const key of RELIABILITY){const gate=input?.reliability?.[key];if(gate?.passed!==true||typeof gate.evidence!=='string'||!gate.evidence.trim())failures.push(`Reliability evidence required: ${key}.`);}
  for(const group of GROUPS){
    const participants=Array.isArray(input?.groups?.[group])?input.groups[group]:[];
    const errors=[];let ease=0,flow=0,completed=0,next=0,baseline=0,redesign=0,tasks=0;
    if(participants.length<5)errors.push('At least five participants are required.');
    for(const p of participants){
      if(!p.id||ids.has(p.id))errors.push('Participant IDs must be present and unique across groups.');ids.add(p.id);
      if(!p.device||!['baseline_first','redesign_first'].includes(p.order))errors.push(`${p.id}: device and counterbalanced order are required.`);
      if(!finite(p.ease)||p.ease<1||p.ease>10||!finite(p.flow)||p.flow<1||p.flow>10)errors.push(`${p.id}: ease and flow must be numeric 1–10 ratings.`);
      else {ease+=p.ease;flow+=p.flow;}
      const rows=Array.isArray(p.tasks)?p.tasks:[];if(rows.length<5)errors.push(`${p.id}: at least five tasks are required.`);
      const taskIds=new Set();
      for(const t of rows){
        tasks++;
        if(!t.id||taskIds.has(t.id))errors.push(`${p.id}: task IDs must be present and unique.`);taskIds.add(t.id);
        if(typeof t.completedUnaided!=='boolean'||typeof t.nextActionCorrect!=='boolean'||typeof t.nextActorCorrect!=='boolean'||!finite(t.nextActionSeconds)||t.nextActionSeconds<0||!finite(t.baselineNavigationAdminSeconds)||t.baselineNavigationAdminSeconds<=0||!finite(t.redesignNavigationAdminSeconds)||t.redesignNavigationAdminSeconds<0){errors.push(`${p.id}/${t.id}: complete observed paired task measurements are required.`);continue;}
        completed+=Number(t.completedUnaided);next+=Number(t.nextActionCorrect&&t.nextActorCorrect&&t.nextActionSeconds<=10);baseline+=t.baselineNavigationAdminSeconds;redesign+=t.redesignNavigationAdminSeconds;
      }
    }
    const metrics={participants:participants.length,tasks,easeMean:participants.length?ease/participants.length:null,flowMean:participants.length?flow/participants.length:null,completionRate:tasks?completed/tasks:null,nextActionRate:tasks?next/tasks:null,navigationAdminImprovement:baseline?1-redesign/baseline:null};
    for(const [field,threshold] of [['easeMean',9],['flowMean',9],['completionRate',.95],['nextActionRate',.9],['navigationAdminImprovement',.3]])if(metrics[field]===null||metrics[field]+1e-12<threshold)errors.push(`${field} must reach ${threshold}.`);
    groups[group]={...metrics,passed:errors.length===0,failures:errors};
    failures.push(...errors.map(error=>`${group}: ${error}`));
  }
  return {passed:failures.length===0,status:failures.length?'pending_or_failed':'passed',groups,failures};
}
if(require.main===module){
  try{if(!process.argv[2])throw new Error('Usage: node scripts/evaluate-experience-pilot.js path/to/results.json');const result=evaluate(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=result.passed?0:1;}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
module.exports={evaluate,GROUPS,RELIABILITY};
