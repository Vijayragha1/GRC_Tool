'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const assessment = require('../lib/iso42001-assessment');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,firm_id INTEGER);
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,firm_id INTEGER,user_type TEXT,firm_role TEXT,active INTEGER);
    CREATE TABLE workspace_role_overrides(workspace_id INTEGER,user_id INTEGER,permission TEXT,granted INTEGER,expires_at TEXT);
    CREATE TABLE iso42001_assessment_passes(id INTEGER PRIMARY KEY,workspace_id INTEGER,pass_number INTEGER,name TEXT,started_by INTEGER,started_at TEXT DEFAULT CURRENT_TIMESTAMP,completed_at TEXT,status TEXT DEFAULT 'open');
    CREATE TABLE iso42001_items(id TEXT PRIMARY KEY,title TEXT,type TEXT,category TEXT,sort_order INTEGER);
    CREATE TABLE iso42001_control_state_history(id INTEGER PRIMARY KEY,workspace_id INTEGER,iso_item_id TEXT,pass_id INTEGER,changed_by INTEGER,snapshot_at TEXT DEFAULT CURRENT_TIMESTAMP,status TEXT,applicability TEXT,maturity INTEGER,inclusion_justification TEXT,exclusion_justification TEXT,notes TEXT,assessment_answers TEXT);
    CREATE TABLE control_states(workspace_id INTEGER,iso_item_id TEXT,status TEXT,applicability TEXT,maturity INTEGER,inclusion_justification TEXT,exclusion_justification TEXT,notes TEXT,assessment_answers TEXT);
    CREATE VIEW v_iso42001_control_states AS SELECT * FROM control_states;
    CREATE TABLE frameworks(id INTEGER PRIMARY KEY,code TEXT);
    CREATE TABLE requirements(id INTEGER PRIMARY KEY,framework_id INTEGER,ref TEXT);
    CREATE TABLE evidence(id INTEGER PRIMARY KEY,workspace_id INTEGER,iso_item_id TEXT,filename TEXT,sha256 TEXT,size_bytes INTEGER,description TEXT,uploaded_by INTEGER,uploaded_at TEXT,valid_from TEXT,valid_until TEXT,period_label TEXT,clause_section TEXT,superseded_at TEXT);
    CREATE TABLE evidence_requirement_links(evidence_id INTEGER,requirement_id INTEGER,section_ref TEXT);
    INSERT INTO workspaces VALUES(1,1),(2,2);
    INSERT INTO users VALUES(1,'Preparer',1,'firm','manager',1),(2,'Reviewer',1,'firm','manager',1),(3,'Other firm',2,'firm','manager',1),(4,'Junior',1,'firm','junior_consultant',1);
    INSERT INTO iso42001_items VALUES('ai-clause-4.1','Context','clause','context',1),('ai-annex-a.2.2','AI policy','control','policy',2);
    INSERT INTO frameworks VALUES(1,'iso42001');
    INSERT INTO requirements VALUES(1,1,'ai-clause-4.1'),(2,1,'ai-annex-a.2.2');
  `);
  db.exec(fs.readFileSync(path.join(__dirname,'../migrations/070_iso42001_assessment_signoff.sql'),'utf8'));
  const passId = assessment.startPass(db,1,1);
  function save(itemId,status='Not Implemented',options={}) {
    const values={workspace_id:1,iso_item_id:itemId,status,applicability:'included',maturity:0,
      inclusion_justification:null,exclusion_justification:null,notes:'Observed governance control is not yet established.',assessment_answers:null,...options};
    db.prepare('DELETE FROM control_states WHERE workspace_id=? AND iso_item_id=?').run(values.workspace_id,itemId);
    db.prepare(`INSERT INTO control_states(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(()=>'?').join(',')})`).run(...Object.values(values));
    db.prepare(`INSERT INTO iso42001_control_state_history(${Object.keys(values).join(',')},pass_id,changed_by) VALUES(${Object.keys(values).map(()=>'?').join(',')},?,?)`).run(...Object.values(values),passId,1);
  }
  function both(){save('ai-clause-4.1');save('ai-annex-a.2.2');}
  return {db,passId,save,both};
}

test('AIMS sign-off rejects self-review, unauthorized reviewers and cross-workspace access',()=>{
  const f=fixture();try{
    f.both();
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,1),/Independent sign-off/);
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,3),/authorized firm reviewer/);
    f.db.prepare("INSERT INTO workspace_role_overrides VALUES(1,4,'assessment.signoff',0,NULL)").run();
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,4),/authorized firm reviewer/);
    assert.throws(()=>assessment.completePass(f.db,2,f.passId,3),/not found/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM iso42001_assessment_snapshots').get().n,0);
  }finally{f.db.close();}
});

test('completion requires every conclusion, gap rationale and decided justified applicability',()=>{
  const f=fixture();try{
    f.save('ai-clause-4.1');
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/record a conclusion/);
    f.save('ai-annex-a.2.2','Not Implemented',{notes:'short'});
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/explain the observed gap/);
    f.save('ai-annex-a.2.2','Not Applicable',{applicability:'excluded',exclusion_justification:'short'});
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/defensible exclusion/);
    f.save('ai-annex-a.2.2','Not Applicable',{applicability:'excluded',exclusion_justification:'Outside the stated operational scope for the documented reason.'});
    assert.equal(assessment.qualityForPass(f.db,1,f.db.prepare('SELECT * FROM iso42001_assessment_passes').get()).ready,true);
  }finally{f.db.close();}
});

test('implementation requires workspace-scoped, non-superseded hashed evidence',()=>{
  const f=fixture();try{
    f.both();f.save('ai-clause-4.1','Implemented');
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/link non-superseded evidence/);
    f.db.prepare('INSERT INTO evidence(id,workspace_id,iso_item_id,filename,sha256) VALUES(1,2,?,?,?)').run('ai-clause-4.1','other-client.txt','a'.repeat(64));
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/link non-superseded evidence/);
    f.db.prepare("UPDATE evidence SET workspace_id=1,superseded_at='2026-01-01' WHERE id=1").run();
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/link non-superseded evidence/);
    f.db.prepare('UPDATE evidence SET iso_item_id=NULL,superseded_at=NULL WHERE id=1').run();
    f.db.prepare("INSERT INTO evidence_requirement_links VALUES(1,1,'Section 2')").run();
    f.db.prepare("UPDATE evidence SET valid_from='1999-01-01',valid_until='2000-01-01' WHERE id=1").run();
    const snapshot=assessment.completePass(f.db,1,f.passId,2);
    assert.equal(snapshot.data.items[0].evidence[0].id,1);
    assert.equal(snapshot.data.items[0].evidence[0].valid_until,'2000-01-01','historical operating coverage is not expiration');
  }finally{f.db.close();}
});

test('review freezes exact conclusions, actor, time and SHA-256; later live edits require a new pass',()=>{
  const f=fixture();try{
    f.both();const snapshot=assessment.completePass(f.db,1,f.passId,2);
    assert.equal(snapshot.snapshot_hash,crypto.createHash('sha256').update(snapshot.snapshot_json).digest('hex'));
    assert.equal(snapshot.data.prepared_by.id,1);assert.equal(snapshot.data.reviewed_by.id,2);
    assert.ok(snapshot.reviewed_at);assert.equal(snapshot.data.items.length,2);
    let gap=assessment.getGapState(f.db,1);assert.equal(gap.complete,true);assert.equal(gap.reviewed,true);
    assert.equal(gap.href,`/workspaces/1/iso42001/gap-assessment/${f.passId}/report`);
    assert.throws(()=>f.db.prepare("UPDATE iso42001_assessment_snapshots SET snapshot_json='{}'").run(),/immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM iso42001_assessment_snapshots').run(),/immutable/);
    f.db.prepare("UPDATE control_states SET notes='Changed after review' WHERE iso_item_id='ai-clause-4.1'").run();
    gap=assessment.getGapState(f.db,1);assert.equal(gap.complete,false);assert.equal(gap.reviewed,true);
    assert.equal(assessment.loadSnapshot(f.db,1,f.passId).snapshot_json,snapshot.snapshot_json);
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/closed/);
  }finally{f.db.close();}
});

test('a reviewer who authored retained conclusions is not independent even when another person started the pass',()=>{
  const f=fixture();try{
    f.both();f.db.prepare('UPDATE iso42001_control_state_history SET changed_by=2 WHERE id=2').run();
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/Independent sign-off/);
  }finally{f.db.close();}
});

test('completed passes and their history cannot be edited or extended; legacy completion is not reviewed',()=>{
  const f=fixture();try{
    f.both();f.db.prepare("UPDATE iso42001_assessment_passes SET status='completed' WHERE id=?").run(f.passId);
    const gap=assessment.getGapState(f.db,1);assert.equal(gap.complete,false);assert.equal(gap.reviewed,false);assert.match(gap.blockers[0],/Legacy completion/);
    assert.equal(assessment.loadSnapshot(f.db,1,f.passId),null);
    assert.throws(()=>f.db.prepare("UPDATE iso42001_assessment_passes SET status='open'").run(),/immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM iso42001_assessment_passes').run(),/immutable/);
    assert.throws(()=>f.db.prepare("UPDATE iso42001_control_state_history SET notes='Rewritten'").run(),/immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM iso42001_control_state_history').run(),/immutable/);
    assert.throws(()=>f.db.prepare("INSERT INTO iso42001_control_state_history(workspace_id,iso_item_id,pass_id) VALUES(1,'ai-clause-4.1',?)").run(f.passId),/open pass/);
    assert.ok(assessment.startPass(f.db,1,1)>f.passId);
  }finally{f.db.close();}
});

test('parallel open passes are rejected and a new pass invalidates engagement completion',()=>{
  const f=fixture();try{
    assert.throws(()=>assessment.startPass(f.db,1,1),/open assessment pass/);
    f.both();assessment.completePass(f.db,1,f.passId,2);assessment.startPass(f.db,1,1);
    const gap=assessment.getGapState(f.db,1);assert.equal(gap.complete,false);assert.equal(gap.reviewed,false);
    assert.match(gap.quality.defects.join(' '),/at least one verification/);
    assert.equal(gap.quality.defects.filter(message=>message.includes('reverify this requirement')).length,2);
  }finally{f.db.close();}
});

test('out-of-pass canonical changes cannot be signed off as a stale conclusion',()=>{
  const f=fixture();try{
    f.both();f.db.prepare("UPDATE control_states SET status='Implemented' WHERE iso_item_id='ai-clause-4.1'").run();
    assert.throws(()=>assessment.completePass(f.db,1,f.passId,2),/recorded control changed/);
  }finally{f.db.close();}
});
