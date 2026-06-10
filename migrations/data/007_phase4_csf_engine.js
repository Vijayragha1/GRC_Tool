#!/usr/bin/env node
/**
 * 007_phase4_csf_engine.js  (DATA op; proven on fixtures, data deferred to AWS pass)
 *
 * Ports the CSF engine onto the generic engine tables:
 *   - creates a system "NIST CSF 2.0 assessment" question set (one question per
 *     csf_subcategory, stable_key = subcategory code, mapped to its requirement)
 *     + a system maturity scoring model
 *   - csf_engagements                       -> assessments (entity = workspace org)
 *   - csf_subcategory_assessments           -> responses (answer = current_score, note = narrative)
 *   - csf_engagement_versions               -> assessment_versions
 *   - csf_subcategory_assessment_snapshots  -> response_snapshots
 *
 * Subcategory assessments whose parent engagement does not exist are orphaned:
 *   skipped if already Phase-0 seed-quarantined, else quarantined here.
 *
 * Reconciliation: engagements == assessments(csf); subcat == responses + orphan_quarantine
 *   + dedup + seed_skipped; versions == assessment_versions; snapshots == response_snapshots(+unresolved).
 * Idempotent (get-or-create + INSERT OR IGNORE + migrated_from guards).
 */
const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const userExists = (id) => id != null && !!db.prepare('SELECT 1 FROM users WHERE id=?').get(id);
const orgOf = db.prepare(`SELECT id FROM entities WHERE workspace_id=? AND entity_type='organization'`);
const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT 'phase4',@t,@id,@reason,@payload WHERE NOT EXISTS(SELECT 1 FROM migration_quarantine WHERE phase='phase4' AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ t, id: String(id), reason, payload });

const s = { engagements: 0, responses: 0, orphanQ: 0, dedup: 0, seedSkip: 0, versions: 0, snaps: 0, snapUnresolved: 0 };

const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase4' AND source_table LIKE 'csf_%' AND resolved_at IS NULL").run();

  // --- system maturity scoring model + CSF question set ---
  let sm = db.prepare(`SELECT id FROM scoring_models WHERE firm_id IS NULL AND name=?`).get('NIST CSF 2.0 maturity');
  if (!sm) {
    const scale = JSON.stringify({ type: 'maturity', min: 1, max: 4, na: 0 });
    const rollup = JSON.stringify({ domain_rollup: 'weighted_mean', na_handling: 'exclude', unanswered_handling: 'exclude' });
    sm = { id: db.prepare(`INSERT INTO scoring_models (firm_id,name,model_type,scale_def,rollup_rules) VALUES (NULL,?,?,?,?)`).run('NIST CSF 2.0 maturity', 'maturity', scale, rollup).lastInsertRowid };
  }
  const QS_NAME = 'NIST CSF 2.0 assessment', QS_VER = 1;
  let qs = db.prepare(`SELECT id FROM question_sets WHERE firm_id IS NULL AND name=? AND version=?`).get(QS_NAME, QS_VER);
  if (!qs) qs = { id: db.prepare(`INSERT INTO question_sets (firm_id,name,version,status,scoring_model_id,target_entity_type) VALUES (NULL,?,?,?,?,?)`).run(QS_NAME, QS_VER, 'published', sm.id, 'organization').lastInsertRowid };

  const insQn = db.prepare(`INSERT OR IGNORE INTO questions (question_set_id,stable_key,ordinal,section,text,answer_type) VALUES (?,?,?,?,?,'single_select')`);
  const getQn = db.prepare(`SELECT id FROM questions WHERE question_set_id=? AND stable_key=?`);
  const insQR = db.prepare(`INSERT OR IGNORE INTO question_requirement_map (question_id,requirement_id) VALUES (?,?)`);
  const reqCsf = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='csf' AND r.ref=?`);
  let ord = 0;
  for (const sub of db.prepare(`SELECT id, code, description FROM csf_subcategories ORDER BY display_order, id`).all()) {
    insQn.run(qs.id, sub.code, ++ord, sub.code.split('.')[0], sub.description || sub.code);
    const q = getQn.get(qs.id, sub.code); const r = reqCsf.get(sub.code);
    if (q && r) insQR.run(q.id, r.id);
  }
  const qBySubCode = db.prepare(`SELECT id FROM questions WHERE question_set_id=${qs.id} AND stable_key=?`);

  // --- engagements -> assessments ---
  const insAssess = db.prepare(`INSERT INTO assessments (workspace_id,entity_id,question_set_id,question_set_version,label,status,propagation_done,started_by,started_at,migrated_from,created_at)
    VALUES (?,?,?,?,?,?,1,?,?,?,?)`);
  const assessByMigrated = db.prepare(`SELECT id FROM assessments WHERE migrated_from=?`);
  const STMAP = { Draft: 'planned', 'In Progress': 'in_progress', 'In Review': 'in_review', Finalized: 'finalized', Approved: 'finalized', Published: 'finalized' };
  const engToAssess = new Map();
  for (const e of db.prepare(`SELECT * FROM csf_engagements`).all()) {
    const mf = `csf_engagements:${e.id}`;
    let a = assessByMigrated.get(mf);
    if (!a) {
      const org = orgOf.get(e.workspace_id);
      if (!org) { quarantine('csf_engagements', e.id, 'no org entity for workspace', JSON.stringify(e)); continue; }
      a = { id: insAssess.run(e.workspace_id, org.id, qs.id, QS_VER, e.name, STMAP[e.status] || 'planned',
        userExists(e.created_by) ? e.created_by : null, e.created_at ?? null, mf, e.created_at ?? null).lastInsertRowid };
      s.engagements++;
    }
    engToAssess.set(e.id, a.id);
  }

  // --- subcategory assessments -> responses ---
  const seedSet = new Set(db.prepare(`SELECT source_id FROM migration_quarantine WHERE source_table='csf_subcategory_assessments' AND reason='orphaned seed data'`).all().map((r) => String(r.source_id)));
  const subCodeById = new Map(db.prepare(`SELECT id, code FROM csf_subcategories`).all().map((r) => [r.id, r.code]));
  const insResp = db.prepare(`INSERT OR IGNORE INTO responses (assessment_id,question_id,answer,assessor_note,respondent_kind,raw_source) VALUES (?,?,?,?,'consultant',?)`);
  for (const a of db.prepare(`SELECT * FROM csf_subcategory_assessments`).all()) {
    const assessId = engToAssess.get(a.engagement_id);
    if (!assessId) { if (seedSet.has(String(a.id))) { s.seedSkip++; } else { quarantine('csf_subcategory_assessments', a.id, 'orphaned: no parent engagement', JSON.stringify(a)); s.orphanQ++; } continue; }
    const code = subCodeById.get(a.subcategory_id); const q = code ? qBySubCode.get(code) : null;
    if (!q) { quarantine('csf_subcategory_assessments', a.id, `subcategory unresolved: ${a.subcategory_id}`, JSON.stringify(a)); s.orphanQ++; continue; }
    const res = insResp.run(assessId, q.id, a.current_score == null ? null : String(a.current_score), a.narrative ?? null,
      JSON.stringify({ src: 'csf_subcategory_assessments', id: a.id, target_score: a.target_score, status: a.status }));
    if (res.changes > 0) s.responses++; else s.dedup++;
  }

  // --- engagement versions -> assessment_versions ---
  const insAV = db.prepare(`INSERT INTO assessment_versions (assessment_id,version_number,published_at,published_by,change_summary,is_current,migrated_from)
    SELECT @aid,@vn,@pa,@pb,@cs,@cur,@mf WHERE NOT EXISTS(SELECT 1 FROM assessment_versions WHERE migrated_from=@mf)`);
  const avByMigrated = db.prepare(`SELECT id FROM assessment_versions WHERE migrated_from=?`);
  const verToAV = new Map();
  for (const v of db.prepare(`SELECT * FROM csf_engagement_versions`).all()) {
    const aid = engToAssess.get(v.engagement_id);
    if (!aid) { quarantine('csf_engagement_versions', v.id, 'orphaned: no migrated engagement', JSON.stringify(v)); continue; }
    const mf = `csf_engagement_versions:${v.id}`;
    insAV.run({ aid, vn: String(v.version_number), pa: v.published_at ?? null, pb: userExists(v.published_by) ? v.published_by : null, cs: v.change_summary ?? null, cur: v.is_current ?? 0, mf });
    const av = avByMigrated.get(mf); if (av) { verToAV.set(v.id, av.id); s.versions++; }
  }

  // --- subcategory assessment snapshots -> response_snapshots ---
  const insRS = db.prepare(`INSERT OR IGNORE INTO response_snapshots (version_id,question_id,answer,assessor_note,weight) VALUES (?,?,?,?,?)`);
  for (const sn of db.prepare(`SELECT * FROM csf_subcategory_assessment_snapshots`).all()) {
    const av = verToAV.get(sn.version_id); const code = subCodeById.get(sn.subcategory_id); const q = code ? qBySubCode.get(code) : null;
    if (!av || !q) { quarantine('csf_subcategory_assessment_snapshots', sn.id, `unresolved version=${sn.version_id} sub=${sn.subcategory_id}`, JSON.stringify(sn)); s.snapUnresolved++; continue; }
    const res = insRS.run(av, q.id, sn.current_score == null ? null : String(sn.current_score), sn.narrative ?? null, sn.weight ?? 1.0);
    if (res.changes > 0) s.snaps++;
  }
  return s;
});

run();
console.log(`csf-engine: engagements->assessments=${s.engagements} | subcat->responses=${s.responses} (orphan_q=${s.orphanQ}, dedup=${s.dedup}, seed_skip=${s.seedSkip}) | versions=${s.versions} | snapshots=${s.snaps} (unresolved=${s.snapUnresolved})`);
const total = db.prepare(`SELECT count(*) n FROM csf_subcategory_assessments`).get().n;
console.log(`RECONCILE subcat(${total}) == responses + orphan_q + dedup + seed_skip : ${total === s.responses + s.orphanQ + s.dedup + s.seedSkip ? 'PASS' : 'FAIL'}`);
db.close();
