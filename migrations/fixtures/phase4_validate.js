#!/usr/bin/env node
/**
 * phase4_validate.js  (fixture harness; proves 006 + 007 before any real data pass)
 *
 * Makes a consistent scratch copy of the dev DB (which already has Phases 0-4
 * structural applied), seeds synthetic fixtures covering the documented blob shape
 * plus edge cases (malformed JSON, null pass_id, retired-item ref, out-of-range
 * answer index, CSF engagement with versions + snapshots), runs 006 + 007 against
 * the scratch DB, and asserts reconciliation gates + routing expectations.
 *
 *   node migrations/fixtures/phase4_validate.js
 * Leaves the scratch DB at /tmp/p4-scratch.db for inspection.
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repo = path.join(__dirname, '..', '..');
const realDb = process.env.DB_PATH || path.join(repo, 'iso27001.db');
const scratch = '/tmp/p4-scratch.db';

// 1. consistent copy (checkpoints WAL into the backup)
for (const f of [scratch, `${scratch}-wal`, `${scratch}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
execSync(`sqlite3 "${realDb}" ".backup '${scratch}'"`);

// 2. seed fixtures
const db = new Database(scratch);
db.pragma('foreign_keys = ON');

// retired item: present in iso_items (FK ok) but NOT in requirements -> 006 sees "retired"
db.prepare(`INSERT OR IGNORE INTO iso_items (id,type,title) VALUES ('annex-a.RETIRED','control','Retired control')`).run();

const insH = db.prepare(`INSERT INTO control_state_history (id,workspace_id,iso_item_id,pass_id,assessment_answers,snapshot_at) VALUES (?,?,?,?,?,?)`);
//                              id   ws  item            pass   blob                                 reason
insH.run(9001, 16, 'clause-4.1', 16, JSON.stringify(['a1', 'a2', 'a3', 'a4']), '2026-02-01');       // normal array, 4q -> 4 resp
insH.run(9002, 16, 'clause-4.3', 16, JSON.stringify({ '1': 'x', '2': 'y', '3': 'z' }), '2026-02-01'); // object numeric, 3q -> 3 resp
insH.run(9003, 16, 'clause-4.2', null, JSON.stringify(['p', 'q']), '2026-02-01');                    // null pass -> pre-passes synthetic, 2 resp
insH.run(9004, 16, 'clause-4.4', 16, JSON.stringify(['only', 'two', 'THREE']), '2026-02-01');        // 2q item, 3rd entry out-of-range -> 2 resp + 1 entryQ
insH.run(9005, 16, 'annex-a.5.1', 16, '{not valid json', '2026-02-01');                              // malformed -> row quarantine
insH.run(9006, 16, 'annex-a.RETIRED', 16, JSON.stringify(['z']), '2026-02-01');                      // retired item -> row quarantine

// current control_states blob -> working synthetic (ws30); ensure clean slot
db.prepare(`DELETE FROM control_states WHERE workspace_id=30 AND iso_item_id='clause-10.1'`).run();
db.prepare(`INSERT INTO control_states (workspace_id,iso_item_id,status,assessment_answers) VALUES (30,'clause-10.1','Not Assessed',?)`).run(JSON.stringify({ q1: 'current state answer' }));

// CSF engagement with versions + snapshots
const subs = db.prepare(`SELECT id, code FROM csf_subcategories ORDER BY display_order, id LIMIT 3`).all();
db.prepare(`INSERT INTO csf_engagements (id,workspace_id,catalog_version,name,scope_mode,status,created_at) VALUES (100,16,'2.0','Fixture CSF Engagement','CURRENT_ONLY','Approved','2026-01-01')`).run();
let said = 9001;
for (const sub of subs) db.prepare(`INSERT INTO csf_subcategory_assessments (id,engagement_id,subcategory_id,current_score,target_score,narrative,status) VALUES (?,100,?,?,4,?,'Approved')`).run(said++, sub.id, 3, `narrative for ${sub.code}`);
db.prepare(`INSERT INTO csf_engagement_versions (id,engagement_id,version_number,is_current,published_at) VALUES (100,100,'1.0',1,'2026-01-02')`).run();
let snid = 9001;
for (const sub of subs) db.prepare(`INSERT INTO csf_subcategory_assessment_snapshots (id,version_id,subcategory_id,current_score,target_score,weight) VALUES (?,100,?,3,4,1.0)`).run(snid++, sub.id);
db.close();

// 3. run the data migrations against the scratch DB
const env = { ...process.env, DB_PATH: scratch };
console.log('--- 006 responses-blob ---');
execSync(`node "${path.join(repo, 'migrations/data/006_phase4_responses_blob.js')}"`, { env, stdio: 'inherit' });
console.log('--- 007 csf-engine ---');
execSync(`node "${path.join(repo, 'migrations/data/007_phase4_csf_engine.js')}"`, { env, stdio: 'inherit' });

// 4. assertions
const v = new Database(scratch);
const one = (sql, ...p) => v.prepare(sql).get(...p);
const n = (sql, ...p) => Object.values(one(sql, ...p))[0];
const assessId = (mf) => { const a = one(`SELECT id FROM assessments WHERE migrated_from=?`, mf); return a ? a.id : -1; };

const respFor = (mf) => n(`SELECT count(*) c FROM responses WHERE assessment_id=?`, assessId(mf));
const checks = [
  ['006: pass-16 assessment responses (normal 4 + object 3 + out-of-range 2)', respFor('assessment_passes:16'), 9],
  ['006: pre-passes synthetic ws16 responses (null pass_id)', respFor('synthetic:pre-passes-import:ws16'), 2],
  ['006: working synthetic ws30 responses (current blob)', respFor('synthetic:working:ws30'), 1],
  ['006: malformed row quarantined', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase4' AND source_table='control_state_history' AND reason LIKE 'assessment_answers malformed%'`), 1],
  ['006: retired-item row quarantined', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase4' AND reason LIKE 'iso_item_id retired%'`), 1],
  ['006: out-of-range entry quarantined', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase4' AND reason LIKE 'no question%out of range%'`), 1],
  ['007: engagement -> 1 assessment', assessId('csf_engagements:100') > 0 ? 1 : 0, 1],
  ['007: subcat -> 3 responses', respFor('csf_engagements:100'), 3],
  ['007: version -> 1 assessment_version', n(`SELECT count(*) c FROM assessment_versions WHERE migrated_from='csf_engagement_versions:100'`), 1],
  ['007: snapshot -> 3 response_snapshots', n(`SELECT count(*) c FROM response_snapshots rs JOIN assessment_versions av ON av.id=rs.version_id WHERE av.migrated_from='csf_engagement_versions:100'`), 3],
  ['007: 212 seed subcats skipped (not quarantined as orphan under phase4)', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase4' AND source_table='csf_subcategory_assessments' AND reason LIKE 'orphaned%'`), 0],
];
v.close();

console.log('\n=== FIXTURE ASSERTIONS ===');
let fail = 0;
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
}
console.log(`\n${fail === 0 ? 'ALL FIXTURE CHECKS PASS' : fail + ' FIXTURE CHECK(S) FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
