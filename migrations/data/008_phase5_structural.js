#!/usr/bin/env node
/**
 * 008_phase5_structural.js  (DATA op; structural half, real dev data)
 *
 *  - one 'supplier' entity per suppliers row; backfill suppliers.entity_id (column exists)
 *  - weighted_risk scoring model reproducing scoreQuestionnaire() (server.js:7745-7773)
 *  - questionnaire_templates -> question_sets (target_entity_type='supplier'); clone lineage
 *  - questionnaire_questions -> questions (stable_key 'qqid:{id}'); iso_control_ref ->
 *    question_requirement_map (A.x->annex-a.x, N.M->clause-N.M, comma-split, parent expansion)
 *  - questionnaire_template_versions -> historical (retired) question_sets versions, snapshot JSON
 *    (array of {section,question,question_type,options,weight,expected_answer,iso_control_ref}) exploded into questions
 *  - questionnaire_question_bank -> a firm-scoped (or system, when is_system) "Question Bank" question_set,
 *    tags -> questions.tags, iso_control_ref -> question_requirement_map [RECOMMENDED DEFAULT; treatment pending Vijay]
 *    (both are 0-row in dev; this logic runs when AWS has data, and is fixture-proven)
 *
 * Idempotent. node migrations/data/008_phase5_structural.js
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db'));
db.pragma('foreign_keys = ON');

const isoFwId = db.prepare(`SELECT id FROM frameworks WHERE code='iso27001'`).get().id;
const getKids = db.prepare(`SELECT id FROM requirements WHERE framework_id=? AND ref LIKE ? ORDER BY ref`);
const reqExact = db.prepare(`SELECT id FROM requirements WHERE framework_id=? AND ref=?`);
function isoReqIds(ref) {
  // 'A.5.1' -> annex-a.5.1 ; '6.1.2' -> clause-6.1.2 ; comma-split ; parent clause -> children
  const out = [];
  for (const part of String(ref).split(',').map((s) => s.trim()).filter(Boolean)) {
    let id;
    if (/^a\./i.test(part)) id = 'annex-a.' + part.replace(/^a\./i, '');
    else if (/^\d/.test(part)) id = 'clause-' + part;
    else { out.push({ unresolved: part }); continue; }
    const ex = reqExact.get(isoFwId, id);
    if (ex) { out.push(ex.id); continue; }
    const kids = getKids.all(isoFwId, id + '.%');
    if (kids.length) out.push(...kids.map((k) => k.id));
    else out.push({ unresolved: id });
  }
  return out;
}

const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT 'phase5',@t,@id,@reason,@payload WHERE NOT EXISTS(SELECT 1 FROM migration_quarantine WHERE phase='phase5' AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ t, id: String(id), reason, payload });

const s = { suppliers: 0, qsets: 0, questions: 0, qmap: 0, qmapQ: 0 };

const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase5' AND resolved_at IS NULL").run();

  // 1. supplier entities + suppliers.entity_id backfill
  for (const sup of db.prepare(`SELECT * FROM suppliers WHERE entity_id IS NULL`).all()) {
    const attrs = JSON.stringify({
      tier: sup.tier, data_access: sup.data_access, business_criticality: sup.business_criticality,
      data_volume: sup.data_volume, industry: sup.industry, location: sup.location,
      regulatory_exposure: sup.regulatory_exposure, dependency_type: sup.dependency_type,
      lifecycle_stage: sup.lifecycle_stage, migrated_from: `suppliers:${sup.id}`,
    });
    const eid = db.prepare(`INSERT INTO entities (workspace_id,name,code,entity_type,is_active,attributes) VALUES (?,?,?,'supplier',1,?)`)
      .run(sup.workspace_id, sup.name, `SUP-${sup.id}`, attrs).lastInsertRowid;
    db.prepare(`UPDATE suppliers SET entity_id=? WHERE id=?`).run(eid, sup.id);
    s.suppliers++;
  }

  // 2. weighted_risk scoring model (reproduces scoreQuestionnaire)
  let sm = db.prepare(`SELECT id FROM scoring_models WHERE firm_id IS NULL AND name=?`).get('Supplier DDQ weighted risk');
  if (!sm) {
    const scale = JSON.stringify({ type: 'weighted_risk', per_answer: 'earned=weight if answer matches expected_answer (case-insensitive); rating type: val>=threshold; free_text weight 0' });
    const rollup = JSON.stringify({ score: 'round(sum(earned)/sum(weight)*100) over ALL questions', rating: { low: '>=80', medium: '>=60', high: '<60' } });
    sm = { id: db.prepare(`INSERT INTO scoring_models (firm_id,name,model_type,scale_def,rollup_rules) VALUES (NULL,?, 'weighted_risk',?,?)`).run('Supplier DDQ weighted risk', scale, rollup).lastInsertRowid };
  }

  // 3. templates -> question_sets (get-or-create), then 4. questions + iso map
  const atypeMap = { yes_no: 'yes_no', rating: 'single_select', free_text: 'free_text', single_select: 'single_select', multi_select: 'multi_select' };
  const tmplToQs = new Map();
  for (const t of db.prepare(`SELECT * FROM questionnaire_templates`).all()) {
    const ver = t.version || 1;
    let qs = db.prepare(`SELECT id FROM question_sets WHERE firm_id IS NULL AND name=? AND version=?`).get(t.name, ver);
    if (!qs) qs = { id: db.prepare(`INSERT INTO question_sets (firm_id,name,version,status,scoring_model_id,target_entity_type) VALUES (NULL,?,?,?,?,'supplier')`).run(t.name, ver, t.archived ? 'retired' : 'published', sm.id).lastInsertRowid, fresh: true };
    if (qs.fresh) s.qsets++;
    tmplToQs.set(t.id, { qsId: qs.id, clonedFromTmpl: t.cloned_from });

    for (const q of db.prepare(`SELECT * FROM questionnaire_questions WHERE template_id=? ORDER BY question_order, id`).all(t.id)) {
      const key = `qqid:${q.id}`;
      const res = db.prepare(`INSERT OR IGNORE INTO questions (question_set_id,stable_key,ordinal,section,text,answer_type,options,weight,expected_answer) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(qs.id, key, q.question_order ?? q.id, q.section ?? null, q.question, atypeMap[q.question_type] || 'single_select', q.options ?? null, q.weight ?? 1, q.expected_answer ?? null);
      if (res.changes > 0) s.questions++;
      const qid = db.prepare(`SELECT id FROM questions WHERE question_set_id=? AND stable_key=?`).get(qs.id, key).id;
      if (q.iso_control_ref && q.iso_control_ref.trim()) {
        for (const r of isoReqIds(q.iso_control_ref)) {
          if (typeof r === 'object' && r.unresolved) { quarantine('questionnaire_questions', `${q.id}:${r.unresolved}`, `iso_control_ref unresolved: ${r.unresolved}`, JSON.stringify(q)); s.qmapQ++; continue; }
          const ins = db.prepare(`INSERT OR IGNORE INTO question_requirement_map (question_id,requirement_id) VALUES (?,?)`).run(qid, r);
          if (ins.changes > 0) s.qmap++;
        }
      }
    }
  }
  // clone lineage: set question_sets.cloned_from from template lineage
  for (const [, info] of tmplToQs) {
    if (info.clonedFromTmpl && tmplToQs.has(info.clonedFromTmpl)) {
      db.prepare(`UPDATE question_sets SET cloned_from=? WHERE id=? AND cloned_from IS NULL`).run(tmplToQs.get(info.clonedFromTmpl).qsId, info.qsId);
    }
  }

  const mapIso = (srcTable, srcId, qid, ref, payload) => {
    for (const r of isoReqIds(ref)) {
      if (typeof r === 'object' && r.unresolved) { quarantine(srcTable, `${srcId}:${r.unresolved}`, `iso_control_ref unresolved: ${r.unresolved}`, payload); s.qmapQ++; continue; }
      if (db.prepare(`INSERT OR IGNORE INTO question_requirement_map (question_id,requirement_id) VALUES (?,?)`).run(qid, r).changes > 0) s.qmap++;
    }
  };

  // questionnaire_template_versions -> historical (retired) question_sets versions; explode snapshot array
  for (const v of db.prepare(`SELECT * FROM questionnaire_template_versions`).all()) {
    const tmpl = db.prepare(`SELECT name FROM questionnaire_templates WHERE id=?`).get(v.template_id);
    if (!tmpl) { quarantine('questionnaire_template_versions', v.id, `template ${v.template_id} missing`, JSON.stringify(v)); continue; }
    let snap; try { snap = JSON.parse(v.snapshot); } catch { quarantine('questionnaire_template_versions', v.id, 'snapshot not valid JSON', String(v.snapshot).slice(0, 500)); continue; }
    if (!Array.isArray(snap)) { quarantine('questionnaire_template_versions', v.id, 'snapshot not an array', String(v.snapshot).slice(0, 500)); continue; }
    let qs = db.prepare(`SELECT id FROM question_sets WHERE firm_id IS NULL AND name=? AND version=?`).get(tmpl.name, v.version_number);
    if (!qs) { qs = { id: db.prepare(`INSERT INTO question_sets (firm_id,name,version,status,scoring_model_id,target_entity_type) VALUES (NULL,?,?, 'retired',?, 'supplier')`).run(tmpl.name, v.version_number, sm.id).lastInsertRowid }; s.qsetVersions = (s.qsetVersions || 0) + 1; }
    snap.forEach((q, i) => {
      const key = `tmplver:${v.id}:q${i + 1}`;
      db.prepare(`INSERT OR IGNORE INTO questions (question_set_id,stable_key,ordinal,section,text,answer_type,options,weight,expected_answer) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(qs.id, key, i + 1, q.section ?? null, q.question, atypeMap[q.question_type] || 'single_select', q.options ?? null, q.weight ?? 1, q.expected_answer ?? null);
      const qid = db.prepare(`SELECT id FROM questions WHERE question_set_id=? AND stable_key=?`).get(qs.id, key).id;
      if (q.iso_control_ref && String(q.iso_control_ref).trim()) mapIso('questionnaire_template_versions', v.id, qid, q.iso_control_ref, JSON.stringify(q));
    });
  }

  // questionnaire_question_bank -> firm-scoped (or system) "Question Bank" question_set [DEFAULT; treatment pending Vijay]
  const bankSetFor = (firmId) => {
    const row = firmId == null
      ? db.prepare(`SELECT id FROM question_sets WHERE firm_id IS NULL AND name='Question Bank' AND version=1`).get()
      : db.prepare(`SELECT id FROM question_sets WHERE firm_id=? AND name='Question Bank' AND version=1`).get(firmId);
    if (row) return row.id;
    return db.prepare(`INSERT INTO question_sets (firm_id,name,version,status,scoring_model_id,target_entity_type) VALUES (?, 'Question Bank',1,'published',?, 'supplier')`).run(firmId, sm.id).lastInsertRowid;
  };
  for (const b of db.prepare(`SELECT * FROM questionnaire_question_bank`).all()) {
    const setId = bankSetFor(b.is_system ? null : b.firm_id);
    const key = `bank:${b.id}`;
    db.prepare(`INSERT OR IGNORE INTO questions (question_set_id,stable_key,ordinal,section,text,answer_type,options,weight,expected_answer,tags) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(setId, key, b.id, b.section ?? null, b.question, atypeMap[b.question_type] || 'single_select', b.options ?? null, b.weight ?? 1, b.expected_answer ?? null, b.tags ?? null);
    const qid = db.prepare(`SELECT id FROM questions WHERE question_set_id=? AND stable_key=?`).get(setId, key).id;
    if (b.iso_control_ref && String(b.iso_control_ref).trim()) mapIso('questionnaire_question_bank', b.id, qid, b.iso_control_ref, JSON.stringify(b));
    s.bank = (s.bank || 0) + 1;
  }
  return s;
});

const r = run();
console.log(`supplier entities backfilled: ${r.suppliers}`);
console.log(`supplier question_sets created: ${r.qsets}; questions: ${r.questions}; iso maps: ${r.qmap} (unresolved iso refs quarantined: ${r.qmapQ})`);
console.log(`template-version sets: ${r.qsetVersions || 0}; question-bank questions: ${r.bank || 0}`);
console.log(`totals -> supplier_entities=${db.prepare("SELECT count(*) n FROM entities WHERE entity_type='supplier'").get().n}, suppliers_null_entity=${db.prepare('SELECT count(*) n FROM suppliers WHERE entity_id IS NULL').get().n}, supplier_question_sets=${db.prepare("SELECT count(*) n FROM question_sets WHERE target_entity_type='supplier'").get().n}`);
db.close();
