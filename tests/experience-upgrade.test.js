'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'experience-upgrade-'));
process.env.DB_PATH=path.join(temp,'populated-061.db');
process.env.ISMS_KEY_FILE=path.join(temp,'upgrade.key');
const core=require('../db');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

test.after(()=>core.db.close());

test('populated 061 database upgrades additively and presentation rollback preserves governed records',()=>{
  // Boot the real pre-experience chain. Only this isolated fixture's migration
  // directory listing is bounded; no migration file or application source changes.
  const readDirectory=fs.readdirSync;
  fs.readdirSync=function(directory,...args){
    const entries=readDirectory.call(fs,directory,...args);
    return path.resolve(String(directory))===path.join(root,'migrations')?entries.filter(file=>!/^\d+.*\.(sql|js)$/.test(file)||Number(file.slice(0,3))<=61):entries;
  };
  try{core.init();}finally{fs.readdirSync=readDirectory;}
  const db=core.db;
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{try{const statement=prepare(sql),run=statement.run.bind(statement);statement.run=(...args)=>{try{return run(...args);}catch(error){throw new Error(`${error.message}; SQL: ${sql}`);}};return statement;}catch(error){throw new Error(`${error.message}; SQL: ${sql}`);}};
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE id GLOB '06[2-7]*'").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='form_drafts'").get().n,0);
  const firmId=db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const user=Number(db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES ('upgrade@example.test','!test','Upgrade manager',?,'firm','manager',1)").run(firmId).lastInsertRowid);
  const reviewer=Number(db.prepare("INSERT INTO users(email,password_hash,name,firm_id,user_type,firm_role,active) VALUES ('upgrade-reviewer@example.test','!test','Independent reviewer',?,'firm','manager',1)").run(firmId).lastInsertRowid);
  const client=Number(db.prepare("INSERT INTO users(email,password_hash,name,user_type,active) VALUES ('upgrade-client@example.test','!test','Upgrade client','client',1)").run().lastInsertRowid);
  const wsId=Number(db.prepare("INSERT INTO workspaces(firm_id,client_name,frameworks,engagement_outcome) VALUES (?,'Existing governed client','[\"iso27001\"]','gap_assessment_only')").run(firmId).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'client_owner')").run(wsId,client);
  const requirement=db.prepare("SELECT r.* FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' ORDER BY r.id LIMIT 1").get();
  const pass=Number(db.prepare("INSERT INTO assessment_passes(workspace_id,pass_number,label,status,started_by,completed_by,completed_at) VALUES (?,1,'Issued baseline','completed',?,?,'2026-07-01')").run(wsId,user,reviewer).lastInsertRowid);
  const control=Number(db.prepare("INSERT INTO control_instances(workspace_id,requirement_id,status,applicability,maturity,notes,review_status,reviewed_by,reviewed_at) VALUES (?,?,'implemented','applicable',3,'Recorded human conclusion','approved',?,'2026-07-01')").run(wsId,requirement.id,reviewer).lastInsertRowid);
  db.prepare("INSERT INTO control_state_history(workspace_id,iso_item_id,changed_by,status,applicability,maturity,notes,assessment_answers,pass_id) VALUES (?,?,?,'Implemented','Applicable',3,'Historical assessment','{\"0\":\"yes\"}',?)").run(wsId,requirement.ref,user,pass);
  const engagement=Number(db.prepare("INSERT INTO consulting_engagements(workspace_id,engagement_code,name,engagement_type,status,created_by) VALUES (?,'EXISTING-1','Issued assessment','gap_assessment','complete',?)").run(wsId,user).lastInsertRowid);
  const workpaper=Number(db.prepare("INSERT INTO consultant_workpapers(workspace_id,engagement_id,requirement_id,workpaper_ref,title,owner_id,reviewer_id,prepared_by,status,internal_notes,created_by) VALUES (?,?,?,'MANUAL-1','Manual retained workpaper',?,?,?,'frozen','Human sample rationale retained',?)").run(wsId,engagement,requirement.id,user,reviewer,user,user).lastInsertRowid);
  const evidence=Number(db.prepare("INSERT INTO evidence(workspace_id,filename,stored_path,sha256,uploaded_by) VALUES (?,'Original evidence.pdf','fixture-original-evidence',?,?)").run(wsId,hash('original evidence bytes'),user).lastInsertRowid);
  db.prepare("INSERT INTO evidence_requirement_links(evidence_id,requirement_id,relevance_note,section_ref) VALUES (?,?,'Relevant sampled procedure','Page 4')").run(evidence,requirement.id);
  db.prepare("INSERT INTO consultant_workpaper_evidence(workpaper_id,evidence_id,purpose,relevance,linked_by) VALUES (?,?,'Sample test','relevant',?)").run(workpaper,evidence,user);
  db.prepare("INSERT INTO consultant_workpaper_reviews(workpaper_id,review_type,decision,note,from_status,to_status,actor_id) VALUES (?,'approval','approved','Independent conclusion approval','manager_review','approved',?)").run(workpaper,reviewer);
  const snapshot=JSON.stringify({workpaper,conclusion:'Human approved conclusion',evidence:[evidence]});
  db.prepare('INSERT INTO consultant_workpaper_snapshots(workpaper_id,version_number,snapshot_json,snapshot_hash,frozen_by) VALUES (?,1,?,?,?)').run(workpaper,snapshot,hash(snapshot),reviewer);
  const report=JSON.stringify({issued:'2026-07-01',scope:'Original contracted gap assessment',workpapers:[workpaper]});
  db.prepare("INSERT INTO consulting_report_snapshots(workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,generated_by,approved_by,approved_at,published_by,published_at,decision_note) VALUES (?,?,'assessment','Issued report',1,'published',?,?,?,?, '2026-07-01',?,'2026-07-01','Independent approval retained')").run(wsId,engagement,report,hash(report),user,reviewer,reviewer);
  db.prepare("INSERT INTO client_requests(workspace_id,title,request_type,status,created_by,assignee_id,response_note) VALUES (?,'Existing accepted response','evidence','accepted',?,?,'Accepted response bytes')").run(wsId,user,client);
  db.prepare("INSERT INTO client_requests(workspace_id,title,request_type,status,created_by) VALUES (?,'Existing unreleased preparation','evidence','open',?)").run(wsId,user);
  const notification=Number(db.prepare("INSERT INTO notifications(workspace_id,user_id,category,title,read_at) VALUES (?,?,'request','Historical update','2026-07-01')").run(wsId,client).lastInsertRowid);
  db.prepare("INSERT INTO notification_emails(notification_id,user_id,sent_at) VALUES (?,?,'2026-07-01')").run(notification,client);

  const tables=['control_instances','control_state_history','assessment_passes','consulting_engagements','consultant_workpapers','consultant_workpaper_evidence','consultant_workpaper_reviews','consultant_workpaper_snapshots','consulting_report_snapshots','evidence','evidence_requirement_links','client_requests','notifications','notification_emails'];
  const preserved=tables.map(table=>{const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);return{table,columns,rows:db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY id`).all()};});
  const upgraded=require('../migrations/run').applyPending(db);
  // Every migration after 061 on disk is applied; counted rather than typed so
  // a new forward migration does not need this assertion edited.
  assert.equal(upgraded.applied,fs.readdirSync(path.join(root,'migrations')).filter(file=>/^\d+.*\.(sql|js)$/.test(file)&&Number(file.slice(0,3))>61).length);
  for(const saved of preserved)assert.deepEqual(db.prepare(`SELECT ${saved.columns.join(',')} FROM ${saved.table} ORDER BY id`).all(),saved.rows,`${saved.table}: existing columns must remain byte-for-byte equivalent`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,0,'upgrade never queues historical notification emails');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consulting_report_revision_requests').get().n,0,'upgrade never invents revision requests from historical report states');
  assert.deepEqual(db.prepare('SELECT read_at FROM notification_receipts WHERE notification_id=? AND user_id=?').get(notification,client),{read_at:'2026-07-01'});
  const released=db.prepare('SELECT released_at,released_by FROM client_requests WHERE assignee_id=?').get(client);
  assert.ok(released.released_at);assert.equal(released.released_by,user);
  assert.equal(db.prepare('SELECT released_at FROM client_requests WHERE assignee_id IS NULL').get().released_at,null);
  const upgradedControl=db.prepare('SELECT * FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(wsId,requirement.ref);
  assert.equal(upgradedControl.record_version,1);assert.equal(upgradedControl.assessment_answers,null);
  assert.equal(require('../lib/assessment-diagnostics').read(upgradedControl.assessment_answers,requirement.ref,['Historical unanswered question']).available,false,'legacy answers are unavailable, never inferred from old scores');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assessment_pass_manifests').get().n,0,'legacy passes are not fabricated into newly governed manifests');
  const drafts=require('../lib/form-drafts');
  const draft=drafts.save(db,{workspaceId:wsId,actorId:user,kind:'assessment',recordId:requirement.ref,recordVersion:1},{payload:{notes:'New personal draft'},generation:0,expectedDraftVersion:0,baseVersion:1,clientSaveId:'upgrade-save'});
  assert.equal(draft.version,1);assert.equal(db.prepare('SELECT notes FROM control_instances WHERE id=?').get(control).notes,'Recorded human conclusion');
  const actor=db.prepare('SELECT * FROM users WHERE id=?').get(user),ws=db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  const flag=require('../lib/experience-flags'),project=require('../lib/work-projection').listWork;
  const oldEnv=process.env.EXPERIENCE_ENABLED;
  try{
    process.env.EXPERIENCE_ENABLED='1';const enabled=project({db,actor,workspaces:[ws],scope:'all',filters:{status:'all'}});
    assert.equal(flag.enabledFor(db,{actor,workspace:ws}),true);
    const clientActor=db.prepare('SELECT * FROM users WHERE id=?').get(client);
    assert.equal(flag.enabledFor(db,{actor:clientActor,workspace:ws}),true,'client membership selects the workspace firm even when client firm_id is NULL');
    process.env.EXPERIENCE_ENABLED='0';assert.equal(flag.enabledFor(db,{actor,workspace:ws}),false);
    assert.deepEqual(project({db,actor,workspaces:[ws],scope:'all',filters:{status:'all'}}).items,enabled.items,'rollback changes presentation, never authorized work or source decisions');
    assert.equal(drafts.get(db,{workspaceId:wsId,actorId:user,kind:'assessment',recordId:requirement.ref}).draft.payload.notes,'New personal draft');
  }finally{if(oldEnv===undefined)delete process.env.EXPERIENCE_ENABLED;else process.env.EXPERIENCE_ENABLED=oldEnv;}
  const rolloutCommand=require('../scripts/experience-rollout').run;
  const cohort=rolloutCommand(db,['enable',String(firmId),'2','isolated-pilot']);
  assert.deepEqual([cohort.rollout.enabled,cohort.rollout.wave,cohort.rollout.cohort],[1,2,'isolated-pilot']);
  db.prepare('INSERT INTO experience_workspace_overrides(workspace_id,enabled) VALUES (?,1)').run(wsId);
  const rollback=rolloutCommand(db,['disable',String(firmId)]);
  assert.equal(rollback.rollout.enabled,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM experience_workspace_overrides WHERE workspace_id=?').get(wsId).n,0);
  assert.equal(drafts.get(db,{workspaceId:wsId,actorId:user,kind:'assessment',recordId:requirement.ref}).draft.payload.notes,'New personal draft');
  for(const saved of preserved)assert.deepEqual(db.prepare(`SELECT ${saved.columns.join(',')} FROM ${saved.table} ORDER BY id`).all(),saved.rows,`${saved.table}: cohort rollback must not change governed records`);
  assert.equal(require('../migrations/run').applyPending(db).applied,0);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('early 062 installations reconcile without rewriting records or migration history',()=>{
  const db=core.db,runner=require('../migrations/run');
  const migration='067_experience_diagnostic_view_reconciliation.js';
  const oldHash=runner.RECONCILED_DRIFTS['062_personal_drafts_and_diagnostics.js'].applied;
  const view=db.prepare("SELECT sql FROM sqlite_master WHERE name='v_iso42001_control_states'").get().sql;
  db.exec('DROP VIEW v_iso42001_control_states');
  db.exec(view.replace(', ci.record_version AS record_version, ci.assessment_answers AS assessment_answers',''));
  db.prepare('DELETE FROM schema_migrations WHERE id=?').run(migration);
  db.prepare('UPDATE schema_migrations SET checksum=? WHERE id=?').run(oldHash,'062_personal_drafts_and_diagnostics.js');
  const rows=db.prepare('SELECT * FROM control_instances ORDER BY id').all();
  assert.equal(runner.applyPending(db).applied,1);
  assert.deepEqual(db.prepare('SELECT * FROM control_instances ORDER BY id').all(),rows);
  assert.equal(db.prepare('SELECT checksum FROM schema_migrations WHERE id=?').get('062_personal_drafts_and_diagnostics.js').checksum,oldHash);
  const columns=db.pragma('table_info(v_iso42001_control_states)').map(row=>row.name);
  assert.ok(columns.includes('record_version'));assert.ok(columns.includes('assessment_answers'));
  assert.equal(runner.applyPending(db).applied,0);
  db.prepare('UPDATE schema_migrations SET checksum=? WHERE id=?').run('f'.repeat(64),'062_personal_drafts_and_diagnostics.js');
  assert.throws(()=>runner.applyPending(db),/Migration checksum drift: 062/);
  db.prepare('UPDATE schema_migrations SET checksum=? WHERE id=?').run(oldHash,'062_personal_drafts_and_diagnostics.js');
});

test('blank install applies the complete pinned migration chain and clean integrity checks',()=>{
  const output=execFileSync(process.execPath,['-e',"const core=require('./db');core.init();const db=core.db;console.log('UPGRADE_RESULT '+JSON.stringify({latest:db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get().id,integrity:db.pragma('integrity_check',{simple:true}),foreignKeys:db.pragma('foreign_key_check'),pending:require('./migrations/run').applyPending(db).applied}));db.close();"],{cwd:root,env:{...process.env,DB_PATH:path.join(temp,'blank.db'),ISMS_KEY_FILE:path.join(temp,'blank.key')},encoding:'utf8'});
  const result=JSON.parse(output.match(/UPGRADE_RESULT (.+)/)[1]);
  const latestOnDisk=fs.readdirSync(path.join(root,'migrations')).filter(file=>/^\d+.*\.(sql|js)$/.test(file)).sort().pop();
  assert.equal(result.latest,latestOnDisk);assert.equal(result.integrity,'ok');assert.deepEqual(result.foreignKeys,[]);assert.equal(result.pending,0);
});
