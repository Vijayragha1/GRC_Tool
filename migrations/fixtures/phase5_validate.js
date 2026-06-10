#!/usr/bin/env node
/**
 * phase5_validate.js  (fixture harness; proves 009 + 010 before any real DDQ data pass)
 *
 * Scratch copy of dev (Phases 0-5 structural + migration 007 applied). Seeds:
 *   - a finalized supplier_questionnaire whose STORED score == the legacy formula (match)
 *   - a second one with a deliberately WRONG stored score (mismatch -> quarantine)
 *   - external_* fields (token lifecycle), responses, a recurring schedule, a supplier_review
 * Runs 009 + 010 against the scratch DB and asserts the gate behaviors.
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const repo = path.join(__dirname, '..', '..');
const realDb = process.env.DB_PATH || path.join(repo, 'iso27001.db');
const scratch = '/tmp/p5-scratch.db';
for (const f of [scratch, `${scratch}-wal`, `${scratch}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
execSync(`sqlite3 "${realDb}" ".backup '${scratch}'"`);

// legacy scoring (mirror of server.js) to compute the matching stored score
const scoreAnswer = (q, answer) => {
  const type = q.question_type || 'yes_no';
  if (type === 'free_text') return { weight: 0, earned: 0 };
  const weight = q.weight || 0; const exp = (q.expected_answer || '').trim();
  if (!answer || !exp) return { weight, earned: 0 };
  return { weight, earned: String(answer).trim().toLowerCase() === exp.toLowerCase() ? weight : 0 };
};

const db = new Database(scratch);
db.pragma('foreign_keys = ON');

// ensure ws16 has a usable uploader (lead consultant) for evidence
const aUser = db.prepare(`SELECT id FROM users LIMIT 1`).get().id;
const sup0 = db.prepare(`SELECT id, workspace_id FROM suppliers WHERE entity_id IS NOT NULL LIMIT 1`).get();
const WS = sup0.workspace_id; const supplier = sup0.id;
db.prepare(`UPDATE workspaces SET lead_consultant_id=? WHERE id=? AND lead_consultant_id IS NULL`).run(aUser, WS);
const TEMPLATE = 2;
const qrows = db.prepare(`SELECT id, weight, question_type, expected_answer FROM questionnaire_questions WHERE template_id=? ORDER BY id`).all(TEMPLATE);

// build responses: first 10 answered correctly, rest answered wrong; compute score
const responses = [];
qrows.forEach((q, i) => responses.push({ qid: q.id, answer: i < 10 ? (q.expected_answer || 'yes') : '___nomatch___' }));
let tw = 0, ach = 0;
for (const q of qrows) { const ans = responses.find((r) => r.qid === q.id).answer; const { weight, earned } = scoreAnswer(q, ans); tw += weight; ach += earned; }
const computedScore = tw > 0 ? Math.round(ach / tw * 100) : null;
const computedRating = computedScore === null ? null : (computedScore >= 80 ? 'low' : computedScore >= 60 ? 'medium' : 'high');

const mkQ = (id, score, rating, withToken) => {
  db.prepare(`INSERT INTO supplier_questionnaires (id,workspace_id,supplier_id,template_id,template_name,status,score,risk_rating,sent_at,responded_at,reviewed_at,external_token,external_email,external_expires_at,external_completed_at)
    VALUES (?,?,?,?,?, 'reviewed', ?,?, '2026-03-01','2026-03-05','2026-03-06', ?,?,?,?)`).run(
    id, WS, supplier, TEMPLATE, 'Privacy & Data Protection Assessment', score, rating,
    withToken ? 'TKN-abc' : null, withToken ? 'vendor@example.com' : null, withToken ? '2026-04-01' : null, withToken ? '2026-03-05' : null);
  for (const r of responses) db.prepare(`INSERT INTO supplier_questionnaire_responses (questionnaire_id,question_id,answer) VALUES (?,?,?)`).run(id, r.qid, r.answer);
};
mkQ(9001, computedScore, computedRating, true);                                  // match
mkQ(9002, (computedScore + 13) % 101, computedRating === 'low' ? 'high' : 'low', false); // mismatch

// schedules
db.prepare(`INSERT INTO recurring_questionnaire_schedules (id,workspace_id,supplier_id,tier_filter,template_id,cadence_months,next_due_date,contact_role,active) VALUES (9001,?,?, 'tier_1', ?, 12, '2026-12-01','security',1)`).run(WS, supplier, TEMPLATE);
db.prepare(`INSERT INTO supplier_reviews (id,workspace_id,supplier_id,review_date,next_review_date) VALUES (9001,?,?, '2026-03-01','2027-03-01')`).run(WS, supplier);

// populated template_version snapshot (dev is empty) -> retired question_set v99, exploded
const snap = JSON.stringify([
  { section: 'Security', question: 'TV Q1', question_type: 'yes_no', options: null, weight: 2, expected_answer: 'yes', iso_control_ref: 'A.5.1' },
  { section: 'Security', question: 'TV Q2', question_type: 'yes_no', options: null, weight: 1, expected_answer: 'yes', iso_control_ref: '6.1.2' },
]);
db.prepare(`INSERT INTO questionnaire_template_versions (id,template_id,version_number,snapshot,created_by) VALUES (9001,1,99,?,?)`).run(snap, aUser);
// populated question_bank entries (firm-scoped + system)
db.prepare(`INSERT INTO questionnaire_question_bank (id,firm_id,section,question,question_type,weight,expected_answer,iso_control_ref,tags,is_system) VALUES (9001,1,'Bank','BQ1','yes_no',1,'yes','A.8.24','tag1,tag2',0)`).run();
db.prepare(`INSERT INTO questionnaire_question_bank (id,firm_id,section,question,question_type,weight,expected_answer,iso_control_ref,tags,is_system) VALUES (9002,NULL,'Bank','BQ2 (system)','yes_no',1,'yes','A.5.1',NULL,1)`).run();
db.close();

const env = { ...process.env, DB_PATH: scratch };
console.log('--- 008 structural (re-run, idempotent: migrates the new template_version + bank rows) ---');
execSync(`node "${path.join(repo, 'migrations/data/008_phase5_structural.js')}"`, { env, stdio: 'inherit' });
console.log('--- 009 ddq-history ---');
execSync(`node "${path.join(repo, 'migrations/data/009_phase5_ddq_history.js')}"`, { env, stdio: 'inherit' });
console.log('--- 010 schedules ---');
execSync(`node "${path.join(repo, 'migrations/data/010_phase5_schedules.js')}"`, { env, stdio: 'inherit' });

// assertions
const v = new Database(scratch);
const n = (sql, ...p) => Object.values(v.prepare(sql).get(...p))[0];
const tokenHash = crypto.createHash('sha256').update('TKN-abc').digest('hex');
const supReqWithCI = n(`SELECT count(*) c FROM requirements r JOIN frameworks f ON f.id=r.framework_id
  WHERE f.code='iso27001' AND r.ref IN ('annex-a.5.19','annex-a.5.20','annex-a.5.21','annex-a.5.22','annex-a.5.23')
  AND EXISTS(SELECT 1 FROM control_instances ci WHERE ci.workspace_id=${WS} AND ci.requirement_id=r.id AND ci.entity_id IS NULL)`);

const checks = [
  ['009: match DDQ -> finalized assessment', n(`SELECT count(*) c FROM assessments WHERE migrated_from='supplier_questionnaires:9001'`), 1],
  ['009: match DDQ responses migrated', n(`SELECT count(*) c FROM responses WHERE assessment_id=(SELECT id FROM assessments WHERE migrated_from='supplier_questionnaires:9001')`), responses.length],
  ['009: match DDQ NOT score-quarantined', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase5' AND source_id='9001' AND reason LIKE 'score/rating mismatch%'`), 0],
  ['009: mismatch DDQ score-quarantined', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase5' AND source_id='9002' AND reason LIKE 'score/rating mismatch%'`), 1],
  ['009: external token issued (hash match)', n(`SELECT count(*) c FROM external_assessment_tokens WHERE token_hash=? AND migrated_from='supplier_questionnaires:9001'`, tokenHash), 1],
  ['009: token preserves expiry + completion', n(`SELECT count(*) c FROM external_assessment_tokens WHERE migrated_from='supplier_questionnaires:9001' AND expires_at='2026-04-01' AND completed_at='2026-03-05'`), 1],
  ['009: proposed_changes raised for supplier controls (== ws16 supplier-control instances)', n(`SELECT count(*) c FROM proposed_changes WHERE source='external_respondent' AND source_ref='supplier_questionnaires:9001'`), supReqWithCI],
  ['009: evidence linked to supplier-control requirements', n(`SELECT count(*) c FROM evidence_requirement_links WHERE relevance_note='ddq-evidence:9001'`), supReqWithCI],
  ['010: recurring schedule -> assessment_schedule', n(`SELECT count(*) c FROM assessment_schedules WHERE migrated_from='recurring_questionnaire_schedules:9001' AND cadence='annual'`), 1],
  ['010: supplier_review -> assessment_schedule', n(`SELECT count(*) c FROM assessment_schedules WHERE migrated_from='supplier_reviews:9001'`), 1],
  ['008: template_version snapshot exploded (2 questions)', n(`SELECT count(*) c FROM questions WHERE stable_key LIKE 'tmplver:9001:q%'`), 2],
  ['008: retired version question_set created (v99)', n(`SELECT count(*) c FROM question_sets WHERE name='Vendor Security Assessment (SIG Lite-style)' AND version=99 AND status='retired'`), 1],
  ['008: question_bank entries migrated (2)', n(`SELECT count(*) c FROM questions WHERE stable_key IN ('bank:9001','bank:9002')`), 2],
  ['008: question_bank tags preserved', n(`SELECT count(*) c FROM questions WHERE stable_key='bank:9001' AND tags='tag1,tag2'`), 1],
  ['008: question_bank iso ref mapped', n(`SELECT count(*) c FROM question_requirement_map m JOIN questions q ON q.id=m.question_id WHERE q.stable_key='bank:9001'`), 1],
];
v.close();

console.log('\n=== PHASE 5 FIXTURE ASSERTIONS ===');
let fail = 0;
for (const [name, got, want] of checks) { const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`); }
console.log(`\ncomputed match score=${computedScore} rating=${computedRating} (supplier-control instances in ws16=${supReqWithCI})`);
console.log(fail === 0 ? 'ALL PHASE 5 FIXTURE CHECKS PASS' : `${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
