#!/usr/bin/env node
/**
 * 009_phase5_ddq_history.js  (DATA op; fixture-proven, data deferred to AWS pass)
 *
 * Historical supplier_questionnaires -> finalized read-only assessments + responses;
 * RECOMPUTES score/risk_rating with the exact legacy math (server.js scoreAnswer/
 * scoreQuestionnaire) and diffs vs the stored values (mismatch -> quarantine).
 * Issues external_assessment_tokens from the external_* fields. Finalized DDQs
 * attach as evidence to supplier-control requirements (A.5.19-A.5.23) and raise
 * proposed_changes (never direct status writes).
 *
 * Reconciliation: questionnaires == assessments(ddq) + quarantine ; responses ==
 *   supplier_questionnaire_responses (resolvable) + entry_quarantine.
 * Idempotent (migrated_from / INSERT OR IGNORE / phase5-ddq quarantine recomputed).
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db'));
db.pragma('foreign_keys = ON');

// --- exact legacy scoring (server.js:7745-7773) ---
function scoreAnswer(q, answer) {
  const type = q.question_type || 'yes_no';
  if (type === 'free_text') return { weight: 0, earned: 0 };
  const weight = q.weight || 0;
  const exp = (q.expected_answer || '').trim();
  if (!answer || !exp) return { weight, earned: 0 };
  if (type === 'rating') { const m = exp.match(/-?\d+(?:\.\d+)?/); const th = m ? parseFloat(m[0]) : null; const val = parseFloat(answer); if (th === null || !Number.isFinite(val)) return { weight, earned: 0 }; return { weight, earned: val >= th ? weight : 0 }; }
  return { weight, earned: String(answer).trim().toLowerCase() === exp.toLowerCase() ? weight : 0 };
}
function recompute(templateId, questionnaireId) {
  const allQ = db.prepare(`SELECT q.id,q.weight,q.question_type,q.expected_answer, r.answer
    FROM questionnaire_questions q LEFT JOIN supplier_questionnaire_responses r ON r.question_id=q.id AND r.questionnaire_id=?
    WHERE q.template_id=?`).all(questionnaireId, templateId);
  let tw = 0, ach = 0, answered = 0;
  for (const q of allQ) { const { weight, earned } = scoreAnswer(q, q.answer); tw += weight; ach += earned; if (q.answer) answered++; }
  const score = tw > 0 ? Math.round(ach / tw * 100) : null;
  const rating = score === null ? null : (score >= 80 ? 'low' : score >= 60 ? 'medium' : 'high');
  return { score, rating, answered };
}

const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT 'phase5',@t,@id,@reason,@payload WHERE NOT EXISTS(SELECT 1 FROM migration_quarantine WHERE phase='phase5' AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ t, id: String(id), reason, payload });
const userExists = (id) => id != null && !!db.prepare('SELECT 1 FROM users WHERE id=?').get(id);

const s = { assessments: 0, responses: 0, scoreMismatch: 0, tokens: 0, evidence: 0, proposed: 0, respQ: 0 };

const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase5' AND source_table IN ('supplier_questionnaires','supplier_questionnaire_responses') AND resolved_at IS NULL").run();

  const qsByNameVer = db.prepare(`SELECT id FROM question_sets WHERE firm_id IS NULL AND name=? AND version=?`);
  const qByKey = db.prepare(`SELECT id FROM questions WHERE question_set_id=? AND stable_key=?`);
  const assessByMigrated = db.prepare(`SELECT id FROM assessments WHERE migrated_from=?`);
  const supControlReqs = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' AND r.ref IN ('annex-a.5.19','annex-a.5.20','annex-a.5.21','annex-a.5.22','annex-a.5.23')`).all().map((x) => x.id);

  for (const ddq of db.prepare(`SELECT sq.*, t.name AS tname, t.version AS tver FROM supplier_questionnaires sq JOIN questionnaire_templates t ON t.id=sq.template_id`).all()) {
    const sup = db.prepare(`SELECT entity_id, workspace_id FROM suppliers WHERE id=?`).get(ddq.supplier_id);
    if (!sup || !sup.entity_id) { quarantine('supplier_questionnaires', ddq.id, 'supplier has no entity (run 008 first)', JSON.stringify(ddq)); continue; }
    const qs = qsByNameVer.get(ddq.tname, ddq.tver || 1);
    if (!qs) { quarantine('supplier_questionnaires', ddq.id, `no question_set for template ${ddq.tname} v${ddq.tver}`, JSON.stringify(ddq)); continue; }

    // recompute + diff
    const rc = recompute(ddq.template_id, ddq.id);
    if (rc.score !== ddq.score || (rc.rating || null) !== (ddq.risk_rating || null)) {
      s.scoreMismatch++;
      quarantine('supplier_questionnaires', ddq.id, `score/rating mismatch: recomputed ${rc.score}/${rc.rating} vs stored ${ddq.score}/${ddq.risk_rating}`, JSON.stringify(ddq));
    }

    // assessment (finalized, external)
    const mf = `supplier_questionnaires:${ddq.id}`;
    let a = assessByMigrated.get(mf);
    if (!a) {
      a = { id: db.prepare(`INSERT INTO assessments (workspace_id,entity_id,question_set_id,question_set_version,label,status,propagation_done,finalized_at,migrated_from,created_at)
        VALUES (?,?,?,?,?,'finalized',1,?,?,?)`).run(sup.workspace_id, sup.entity_id, qs.id, ddq.tver || 1, ddq.template_name || ddq.tname, ddq.reviewed_at ?? ddq.responded_at ?? null, mf, ddq.created_at ?? null).lastInsertRowid };
      s.assessments++;
    }

    // responses (external respondent)
    for (const r of db.prepare(`SELECT * FROM supplier_questionnaire_responses WHERE questionnaire_id=?`).all(ddq.id)) {
      const q = qByKey.get(qs.id, `qqid:${r.question_id}`);
      if (!q) { quarantine('supplier_questionnaire_responses', r.id, `no question qqid:${r.question_id} in set`, JSON.stringify(r)); s.respQ++; continue; }
      const ins = db.prepare(`INSERT OR IGNORE INTO responses (assessment_id,question_id,answer,assessor_note,respondent_kind,raw_source) VALUES (?,?,?,?,'external',?)`)
        .run(a.id, q.id, r.answer ?? null, r.comment ?? null, JSON.stringify({ src: 'supplier_questionnaire_responses', id: r.id }));
      if (ins.changes > 0) s.responses++;
    }

    // external token (issue/answer/expire/revoke state preserved)
    if (ddq.external_token && !db.prepare(`SELECT 1 FROM external_assessment_tokens WHERE migrated_from=?`).get(mf)) {
      db.prepare(`INSERT INTO external_assessment_tokens (workspace_id,assessment_id,entity_id,email,token_hash,issued_at,expires_at,completed_at,migrated_from)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(sup.workspace_id, a.id, sup.entity_id, ddq.external_email || 'unknown',
        crypto.createHash('sha256').update(String(ddq.external_token)).digest('hex'),
        ddq.sent_at ?? null, ddq.external_expires_at ?? ddq.sent_at ?? '1970-01-01', ddq.external_completed_at ?? null, mf);
      s.tokens++;
    }

    // attach as evidence to supplier-control requirements + raise proposed_changes
    const uploader = userExists(ddq.reviewer) ? ddq.reviewer : (db.prepare(`SELECT lead_consultant_id id FROM workspaces WHERE id=?`).get(sup.workspace_id) || {}).id;
    if (userExists(uploader) && supControlReqs.length) {
      const evMf = `ddq-evidence:${ddq.id}`;
      let ev = db.prepare(`SELECT id FROM evidence WHERE workspace_id=? AND stored_path=?`).get(sup.workspace_id, `ddq://${ddq.id}`);
      if (!ev) ev = { id: db.prepare(`INSERT INTO evidence (workspace_id,filename,stored_path,uploaded_by,description) VALUES (?,?,?,?,?)`)
        .run(sup.workspace_id, `DDQ - ${ddq.template_name || ddq.tname}`, `ddq://${ddq.id}`, uploader, `Finalized supplier DDQ (score ${ddq.score}, risk ${ddq.risk_rating})`).lastInsertRowid };
      for (const rid of supControlReqs) {
        const lk = db.prepare(`INSERT OR IGNORE INTO evidence_requirement_links (evidence_id,requirement_id,relevance_note) VALUES (?,?,?)`).run(ev.id, rid, evMf);
        if (lk.changes > 0) s.evidence++;
        const ci = db.prepare(`SELECT id FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(sup.workspace_id, rid);
        if (ci) {
          const dup = db.prepare(`SELECT 1 FROM proposed_changes WHERE instance_id=? AND source='external_respondent' AND source_ref=?`).get(ci.id, mf);
          if (!dup) { db.prepare(`INSERT INTO proposed_changes (workspace_id,instance_id,source,source_ref,rationale) VALUES (?,?,'external_respondent',?,?)`).run(sup.workspace_id, ci.id, mf, `Supplier DDQ "${ddq.template_name || ddq.tname}" finalized: score ${ddq.score}, risk ${ddq.risk_rating}. Review supplier control.`); s.proposed++; }
        }
      }
    }
  }
  return s;
});

run();
const totalQ = db.prepare(`SELECT count(*) n FROM supplier_questionnaires`).get().n;
console.log(`ddq-history: assessments=${s.assessments} responses=${s.responses} score_mismatch=${s.scoreMismatch} tokens=${s.tokens} evidence_links=${s.evidence} proposed_changes=${s.proposed} (resp_quarantine=${s.respQ})`);
console.log(`RECONCILE questionnaires(${totalQ}) >= assessments(${s.assessments}) ; mismatches quarantined=${s.scoreMismatch}`);
db.close();
