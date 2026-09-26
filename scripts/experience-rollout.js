'use strict';
// Operator-only presentation rollout. This CLI never changes domain permissions.
const Database=require('better-sqlite3');
function run(db,args){
  const [action,firmValue,waveValue='1',cohort='pilot']=args;
  if(!['view','enable','disable'].includes(action)||!/^\d+$/.test(firmValue||''))throw new Error('Usage: DB_PATH=... node scripts/experience-rollout.js view|enable|disable FIRM_ID [WAVE_1_TO_6] [COHORT]');
  const firmId=Number(firmValue),firm=db.prepare('SELECT id,name FROM firms WHERE id=?').get(firmId);
  if(!firm)throw new Error('Firm not found.');
  if(action==='enable'){
    const wave=Number(waveValue);if(!Number.isInteger(wave)||wave<1||wave>6||cohort.length>100)throw new Error('Choose wave 1–6 and a cohort name of at most 100 characters.');
    db.prepare(`INSERT INTO experience_rollouts(firm_id,enabled,wave,cohort) VALUES (?,1,?,?) ON CONFLICT(firm_id) DO UPDATE SET enabled=1,wave=excluded.wave,cohort=excluded.cohort,updated_at=CURRENT_TIMESTAMP`).run(firmId,wave,cohort);
  }else if(action==='disable'){
    db.prepare(`INSERT INTO experience_rollouts(firm_id,enabled) VALUES (?,0) ON CONFLICT(firm_id) DO UPDATE SET enabled=0,updated_at=CURRENT_TIMESTAMP`).run(firmId);
    // Clear explicit workspace presentation overrides so the firm rollback is complete.
    db.prepare('DELETE FROM experience_workspace_overrides WHERE workspace_id IN (SELECT id FROM workspaces WHERE firm_id=?)').run(firmId);
  }
  return {firm,rollout:db.prepare('SELECT enabled,wave,cohort,updated_at FROM experience_rollouts WHERE firm_id=?').get(firmId)||null,
    environmentOverride:process.env.EXPERIENCE_ENABLED??null,note:'Presentation only. Canonical decisions, permissions and personal drafts are retained.'};
}
if(require.main===module){let db;try{if(!process.env.DB_PATH)throw new Error('Set DB_PATH explicitly to the intended database.');db=new Database(process.env.DB_PATH,{fileMustExist:true});console.log(JSON.stringify(db.transaction(()=>run(db,process.argv.slice(2)))(),null,2));}catch(error){console.error(error.message);process.exitCode=1;}finally{db?.close();}}
module.exports={run};
