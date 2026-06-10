#!/usr/bin/env node
/**
 * 005_phase4_structural_backfill.js  (DATA op; run after migrations/005 schema)
 *
 * Phase 4 STRUCTURAL half (works in dev; no answer/CSF data involved):
 *  - system conformity scoring model
 *  - ISO 27001:2022 gap question set, exploded from iso_items.questions
 *    (stable_key '{iso_item_id}:q{n}'), each question mapped to its requirement;
 *    prints a PER-ITEM question count report
 *  - one 'organization' entity per workspace
 *  - assessment_passes -> shell assessments (no responses; responses come from
 *    migrations/data/006_phase4_responses_blob.js on the data pass)
 *
 * Idempotent (get-or-create + INSERT OR IGNORE + NOT EXISTS guards).
 *   node migrations/data/005_phase4_structural_backfill.js
 */
const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const jparse = (v) => { if (v == null || v === '') return null; try { return JSON.parse(v); } catch { return undefined; } };

const run = db.transaction(() => {
  // 1. system conformity scoring model (get-or-create by name, firm NULL)
  let sm = db.prepare(`SELECT id FROM scoring_models WHERE firm_id IS NULL AND name=?`).get('ISO 27001 conformity');
  if (!sm) {
    const scale = JSON.stringify({ type: 'conformity', values: [
      { key: 'not_implemented', score: 0 }, { key: 'partially_implemented', score: 0.5 },
      { key: 'implemented', score: 1 }, { key: 'not_applicable', score: null }, { key: 'not_assessed', score: null }] });
    const rollup = JSON.stringify({ domain_rollup: 'mean', na_handling: 'exclude', unanswered_handling: 'exclude' });
    const id = db.prepare(`INSERT INTO scoring_models (firm_id,name,model_type,scale_def,rollup_rules) VALUES (NULL,?,?,?,?)`)
      .run('ISO 27001 conformity', 'conformity', scale, rollup).lastInsertRowid;
    sm = { id };
  }

  // 2. ISO 27001 gap question set (get-or-create by name+version, firm NULL)
  const QS_NAME = 'ISO 27001:2022 gap assessment', QS_VER = 1;
  let qs = db.prepare(`SELECT id FROM question_sets WHERE firm_id IS NULL AND name=? AND version=?`).get(QS_NAME, QS_VER);
  if (!qs) {
    const id = db.prepare(`INSERT INTO question_sets (firm_id,name,version,status,scoring_model_id,target_entity_type) VALUES (NULL,?,?,?,?,?)`)
      .run(QS_NAME, QS_VER, 'published', sm.id, 'organization').lastInsertRowid;
    qs = { id };
  }

  // explode iso_items.questions -> questions (+ question_requirement_map)
  const insQ = db.prepare(`INSERT OR IGNORE INTO questions (question_set_id,stable_key,ordinal,section,text,answer_type) VALUES (?,?,?,?,?,'free_text')`);
  const getQ = db.prepare(`SELECT id FROM questions WHERE question_set_id=? AND stable_key=?`);
  const insQR = db.prepare(`INSERT OR IGNORE INTO question_requirement_map (question_id,requirement_id) VALUES (?,?)`);
  const reqId = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' AND r.ref=?`);
  const insQuar = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
    SELECT 'phase4','iso_items',@id,@reason,@payload WHERE NOT EXISTS (SELECT 1 FROM migration_quarantine WHERE phase='phase4' AND source_table='iso_items' AND source_id=@id AND reason=@reason)`);

  let ordinal = 0; const perItem = {}; let mapped = 0;
  for (const it of db.prepare(`SELECT id, category, questions FROM iso_items ORDER BY sort_order, id`).all()) {
    const arr = jparse(it.questions);
    if (arr === undefined) { insQuar.run({ id: it.id, reason: 'questions not valid JSON', payload: String(it.questions).slice(0, 500) }); perItem[it.id] = 0; continue; }
    const list = Array.isArray(arr) ? arr : [];
    perItem[it.id] = list.length;
    const rid = reqId.get(it.id);
    list.forEach((qtext, i) => {
      const key = `${it.id}:q${i + 1}`;
      insQ.run(qs.id, key, ++ordinal, it.category ?? it.id, String(qtext));
      const q = getQ.get(qs.id, key);
      if (q && rid) { insQR.run(q.id, rid.id); mapped++; }
    });
  }

  // 3. one organization entity per workspace (guarded)
  let orgs = 0;
  for (const w of db.prepare(`SELECT id, client_name FROM workspaces`).all()) {
    const exists = db.prepare(`SELECT 1 FROM entities WHERE workspace_id=? AND entity_type='organization'`).get(w.id);
    if (exists) continue;
    db.prepare(`INSERT INTO entities (workspace_id,name,code,entity_type,is_active,attributes) VALUES (?,?,?,'organization',1,?)`)
      .run(w.id, w.client_name || `Workspace ${w.id}`, 'ORG', JSON.stringify({ auto_created: true, source: 'phase4_structural' }));
    orgs++;
  }

  // 4. assessment_passes -> shell assessments (guarded by migrated_from)
  const userExists = (id) => id != null && !!db.prepare('SELECT 1 FROM users WHERE id=?').get(id);
  const orgOf = db.prepare(`SELECT id FROM entities WHERE workspace_id=? AND entity_type='organization'`);
  const statusMap = { in_progress: 'in_progress', completed: 'finalized', finalized: 'finalized', planned: 'planned' };
  let shells = 0;
  for (const p of db.prepare(`SELECT * FROM assessment_passes`).all()) {
    if (db.prepare(`SELECT 1 FROM assessments WHERE migrated_from=?`).get(`assessment_passes:${p.id}`)) continue;
    const org = orgOf.get(p.workspace_id);
    if (!org) continue;
    db.prepare(`INSERT INTO assessments
      (workspace_id,entity_id,question_set_id,question_set_version,label,pass_number,status,propagation_done,started_by,started_at,completed_by,finalized_at,migrated_from)
      VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?)`).run(
      p.workspace_id, org.id, qs.id, QS_VER, p.label ?? null, p.pass_number ?? null,
      statusMap[p.status] || 'planned', userExists(p.started_by) ? p.started_by : null, p.started_at ?? null,
      userExists(p.completed_by) ? p.completed_by : null, p.completed_at ?? null, `assessment_passes:${p.id}`);
    shells++;
  }

  return { perItem, ordinal, mapped, orgs, shells };
});

const r = run();
const counts = Object.values(r.perItem);
const withQ = counts.filter((n) => n > 0).length;
console.log(`ISO question set: ${r.ordinal} questions across ${withQ}/${Object.keys(r.perItem).length} items; ${r.mapped} question->requirement maps`);
console.log('per-item question counts:');
for (const [id, n] of Object.entries(r.perItem)) console.log(`  ${id}: ${n}`);
console.log(`organization entities created this run: ${r.orgs}`);
console.log(`shell assessments from passes: ${r.shells}`);
console.log(`totals -> questions=${db.prepare('SELECT count(*) n FROM questions').get().n}, q_req_map=${db.prepare('SELECT count(*) n FROM question_requirement_map').get().n}, org_entities=${db.prepare("SELECT count(*) n FROM entities WHERE entity_type='organization'").get().n}, assessments=${db.prepare('SELECT count(*) n FROM assessments').get().n}`);
db.close();
