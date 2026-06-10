#!/usr/bin/env node
/**
 * 010_phase5_schedules.js  (DATA op; fixture-proven, data deferred to AWS pass)
 *
 * Consolidates the two legacy scheduling mechanisms into assessment_schedules:
 *   - recurring_questionnaire_schedules (near-exact prototype): cadence_months -> cadence,
 *     tier_filter/contact_role -> trigger_rule JSON, next_due_date -> next_run.
 *   - supplier_reviews cadence: next_review_date -> next_run (entity = supplier).
 * Retirement of recurring_questionnaire_schedules (view-then-drop) is deferred/gated.
 *
 * Idempotent via assessment_schedules.migrated_from (migration 007).
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db'));
db.pragma('foreign_keys = ON');

const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT 'phase5',@t,@id,@reason,@payload WHERE NOT EXISTS(SELECT 1 FROM migration_quarantine WHERE phase='phase5' AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ t, id: String(id), reason, payload });
const cadence = (months) => ({ 1: 'monthly', 3: 'quarterly', 6: 'semiannual', 12: 'annual' }[months] || `${months || 12} months`);
const has = (mf) => !!db.prepare(`SELECT 1 FROM assessment_schedules WHERE migrated_from=?`).get(mf);
const insSched = db.prepare(`INSERT INTO assessment_schedules (workspace_id,entity_id,question_set_id,cadence,next_run,trigger_rule,is_active,migrated_from) VALUES (?,?,?,?,?,?,?,?)`);
const orgOf = db.prepare(`SELECT id FROM entities WHERE workspace_id=? AND entity_type='organization'`);
const supEntity = db.prepare(`SELECT entity_id FROM suppliers WHERE id=?`);
const qsByTemplate = db.prepare(`SELECT qs.id FROM question_sets qs JOIN questionnaire_templates t ON t.name=qs.name AND COALESCE(t.version,1)=qs.version WHERE qs.target_entity_type='supplier' AND t.id=?`);
const anySupQs = db.prepare(`SELECT id FROM question_sets WHERE target_entity_type='supplier' ORDER BY id LIMIT 1`);

const s = { recurring: 0, reviews: 0, q: 0 };
const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase5' AND source_table IN ('recurring_questionnaire_schedules','supplier_reviews') AND resolved_at IS NULL").run();

  for (const r of db.prepare(`SELECT * FROM recurring_questionnaire_schedules`).all()) {
    const mf = `recurring_questionnaire_schedules:${r.id}`; if (has(mf)) continue;
    const qs = qsByTemplate.get(r.template_id);
    if (!qs) { quarantine('recurring_questionnaire_schedules', r.id, `no question_set for template ${r.template_id}`, JSON.stringify(r)); s.q++; continue; }
    const ent = r.supplier_id ? (supEntity.get(r.supplier_id) || {}).entity_id : (orgOf.get(r.workspace_id) || {}).id;
    if (!ent) { quarantine('recurring_questionnaire_schedules', r.id, 'no entity (supplier/org)', JSON.stringify(r)); s.q++; continue; }
    const trig = JSON.stringify({ tier_filter: r.tier_filter ?? null, contact_role: r.contact_role ?? null, src: 'recurring_questionnaire_schedules', src_id: r.id });
    insSched.run(r.workspace_id, ent, qs.id, cadence(r.cadence_months), r.next_due_date ?? null, trig, r.active ?? 1, mf);
    s.recurring++;
  }

  for (const rv of db.prepare(`SELECT * FROM supplier_reviews`).all()) {
    const mf = `supplier_reviews:${rv.id}`; if (has(mf)) continue;
    const ent = (supEntity.get(rv.supplier_id) || {}).entity_id;
    const qs = anySupQs.get();
    if (!ent || !qs) { quarantine('supplier_reviews', rv.id, 'no supplier entity or supplier question_set', JSON.stringify(rv)); s.q++; continue; }
    const trig = JSON.stringify({ src: 'supplier_reviews', src_id: rv.id, note: 'review cadence (not a DDQ send)' });
    insSched.run(rv.workspace_id, ent, qs.id, 'annual', rv.next_review_date ?? null, trig, 1, mf);
    s.reviews++;
  }
  return s;
});

run();
console.log(`schedules: recurring->${s.recurring}, reviews->${s.reviews}, quarantined=${s.q}, total assessment_schedules=${db.prepare('SELECT count(*) n FROM assessment_schedules').get().n}`);
db.close();
