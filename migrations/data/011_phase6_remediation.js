#!/usr/bin/env node
/**
 * 011_phase6_remediation.js  (DATA op; dev real data + fixture-proven CSF/risk/dedup paths)
 *
 * Six legacy trackers -> findings / recommendations / remediation_actions.
 *   nonconformities       -> findings (severity_scheme 'nc')
 *   audit_findings        -> findings (per-row scheme: minor/major=nc, low/medium/high=hml);
 *                            orphaned (audit deleted): seed-like 'test' rows quarantined, genuine
 *                            rows migrated with source_id NULL + lost-parent note
 *   audit_observations    -> findings (distinct severity 'observation', scheme 'nc'); recommendation -> recommendations
 *   improvements          -> findings (source_type 'manual')
 *   csf_findings/recs/status -> findings/recommendations/remediation_actions (source_type 'assessment');
 *                            orphaned (no engagement = Phase 0 seed) -> quarantined under the seed label
 *   risk_treatment_actions-> remediation_actions, hung off a per-risk finding (source_type 'risk')
 *   supplier_findings     -> findings (source from .source); DEDUP vs nonconformities on nonconformity_id
 *                            (matched -> link to existing finding, no duplicate; ambiguous -> quarantine)
 * Idempotent (migrated_from guards; phase6 quarantine recomputed). finding_controls linked via iso refs.
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', '..', 'iso27001.db'));
db.pragma('foreign_keys = ON');

const reqIso = db.prepare(`SELECT r.id FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' AND r.ref=?`);
const ciFor = db.prepare(`SELECT id FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`);
const insFinding = db.prepare(`INSERT INTO findings (workspace_id,source_type,source_id,title,description,severity,severity_scheme,status,migrated_from)
  SELECT @ws,@st,@sid,@title,@desc,@sev,@scheme,@status,@mf WHERE NOT EXISTS(SELECT 1 FROM findings WHERE migrated_from=@mf)`);
const findingByMf = db.prepare(`SELECT id FROM findings WHERE migrated_from=?`);
const insFC = db.prepare(`INSERT OR IGNORE INTO finding_controls (finding_id,instance_id) VALUES (?,?)`);
const insRec = db.prepare(`INSERT INTO recommendations (workspace_id,finding_id,text,migrated_from) SELECT @ws,@fid,@text,@mf WHERE NOT EXISTS(SELECT 1 FROM recommendations WHERE migrated_from=@mf)`);
const recByMf = db.prepare(`SELECT id FROM recommendations WHERE migrated_from=?`);
const insAction = db.prepare(`INSERT INTO remediation_actions (workspace_id,finding_id,recommendation_id,title,description,status,migrated_from)
  SELECT @ws,@fid,@rid,@title,@desc,@status,@mf WHERE NOT EXISTS(SELECT 1 FROM remediation_actions WHERE migrated_from=@mf)`);
const insQ = db.prepare(`INSERT INTO migration_quarantine (phase,source_table,source_id,reason,raw_payload)
  SELECT 'phase6',@t,@id,@reason,@payload WHERE NOT EXISTS(SELECT 1 FROM migration_quarantine WHERE phase='phase6' AND source_table=@t AND source_id=@id AND reason=@reason)`);
const quarantine = (t, id, reason, payload) => insQ.run({ t, id: String(id), reason, payload });

const fStatus = (st) => ({ open: 'open', closed: 'closed', in_progress: 'in_remediation', done: 'closed', resolved: 'closed', cancelled: 'closed' }[String(st || 'open').toLowerCase()] || 'open');
const aStatus = (st) => ({ planned: 'planned', in_progress: 'in_progress', done: 'done_unverified', completed: 'closed', verified: 'verified', closed: 'closed', cancelled: 'cancelled' }[String(st || 'planned').toLowerCase()] || 'planned');
const linkControls = (fid, ws, isoRef) => { if (!isoRef) return; const r = reqIso.get(isoRef); if (!r) return; const ci = ciFor.get(ws, r.id); if (ci) insFC.run(fid, ci.id); };
const mkFinding = (o) => { insFinding.run(o); const f = findingByMf.get(o.mf); return f ? f.id : null; };

const s = {};
const bump = (k) => { s[k] = (s[k] || 0) + 1; };

const run = db.transaction(() => {
  db.prepare("DELETE FROM migration_quarantine WHERE phase='phase6' AND resolved_at IS NULL").run();

  // 1. nonconformities -> findings (nc)
  for (const nc of db.prepare(`SELECT * FROM nonconformities`).all()) {
    const stype = /incident/i.test(nc.source || '') ? 'incident' : 'audit';
    const fid = mkFinding({ ws: nc.workspace_id, st: stype, sid: `nonconformities:${nc.id}`, title: nc.title, desc: nc.description ?? null, sev: nc.severity || 'minor', scheme: 'nc', status: fStatus(nc.status), mf: `nonconformities:${nc.id}` });
    if (fid) { linkControls(fid, nc.workspace_id, nc.iso_item_id); bump('nc'); }
  }

  // 2. audit_findings -> findings (per-row scheme); orphaned handled per content
  for (const f of db.prepare(`SELECT f.*, a.workspace_id AS ws FROM audit_findings f LEFT JOIN audits a ON a.id=f.audit_id`).all()) {
    const sev = (f.severity || 'medium').toLowerCase();
    const scheme = ['minor', 'major'].includes(sev) ? 'nc' : 'hml';
    let ws = f.ws, note = f.description ?? null, sid = null;
    if (ws == null) { // orphaned: parent audit deleted
      const seedLike = !((f.description || '').trim()) || (f.description || '').trim().toLowerCase() === 'test' || !f.iso_item_id;
      if (seedLike) { quarantine('audit_findings', f.id, 'orphaned + seed-like (no real content / no iso ref)', JSON.stringify(f)); bump('af_quar'); continue; }
      // genuine but lost parent: need a workspace. Derive from iso requirement's instances is ambiguous; require an explicit ws.
      ws = (db.prepare(`SELECT ci.workspace_id FROM control_instances ci JOIN requirements r ON r.id=ci.requirement_id JOIN frameworks fr ON fr.id=r.framework_id WHERE fr.code='iso27001' AND r.ref=? LIMIT 1`).get(f.iso_item_id) || {}).workspace_id;
      if (ws == null) { quarantine('audit_findings', f.id, 'orphaned + genuine but workspace unresolved', JSON.stringify(f)); bump('af_quar'); continue; }
      note = `[lost parent audit_id=${f.audit_id}] ${note || ''}`.trim();
    }
    const fid = mkFinding({ ws, st: 'audit', sid, title: (f.description || 'Audit finding').slice(0, 120), desc: note, sev, scheme, status: fStatus(f.status), mf: `audit_findings:${f.id}` });
    if (fid) { linkControls(fid, ws, f.iso_item_id); bump(f.ws == null ? 'af_lostparent' : 'af'); }
  }

  // 3. audit_observations -> findings (severity 'observation', nc) + recommendation
  for (const o of db.prepare(`SELECT o.*, a.workspace_id AS ws FROM audit_observations o JOIN audits a ON a.id=o.audit_id`).all()) {
    const fid = mkFinding({ ws: o.ws, st: 'audit', sid: `audit_observations:${o.id}`, title: (o.description || 'Observation').slice(0, 120), desc: o.description ?? null, sev: 'observation', scheme: 'nc', status: fStatus(o.status), mf: `audit_observations:${o.id}` });
    if (fid) { linkControls(fid, o.ws, o.iso_item_id); bump('ao'); if (o.recommendation && o.recommendation.trim()) insRec.run({ ws: o.ws, fid, text: o.recommendation, mf: `audit_observations_rec:${o.id}` }); }
  }

  // 4. improvements -> findings (manual)
  for (const im of db.prepare(`SELECT * FROM improvements`).all()) {
    const fid = mkFinding({ ws: im.workspace_id, st: 'manual', sid: `improvements:${im.id}`, title: im.title, desc: im.description ?? null, sev: 'medium', scheme: 'hml', status: fStatus(im.status), mf: `improvements:${im.id}` });
    if (fid) bump('imp');
  }

  // 5. CSF findings/recs/status (orphaned = seed -> quarantine; real -> migrate chain)
  for (const cf of db.prepare(`SELECT * FROM csf_findings`).all()) {
    const eng = db.prepare(`SELECT workspace_id FROM csf_engagements WHERE id=?`).get(cf.engagement_id);
    if (!eng) { quarantine('csf_findings', cf.id, 'orphaned seed data: no parent engagement', JSON.stringify(cf)); bump('csf_seed'); continue; }
    const fid = mkFinding({ ws: eng.workspace_id, st: 'assessment', sid: `csf_findings:${cf.id}`, title: cf.title, desc: cf.description ?? null, sev: (cf.severity || 'MEDIUM').toLowerCase(), scheme: 'hml', status: fStatus(cf.status), mf: `csf_findings:${cf.id}` });
    if (!fid) continue; bump('csf');
    for (const rc of db.prepare(`SELECT * FROM csf_recommendations WHERE finding_id=?`).all(cf.id)) {
      insRec.run({ ws: eng.workspace_id, fid, text: rc.description, mf: `csf_recommendations:${rc.id}` });
      const recId = (recByMf.get(`csf_recommendations:${rc.id}`) || {}).id;
      const st = db.prepare(`SELECT * FROM csf_remediation_status WHERE recommendation_id=?`).get(rc.id);
      if (recId && st) insAction.run({ ws: eng.workspace_id, fid, rid: recId, title: (rc.description || 'Remediation').slice(0, 120), desc: st.client_note ?? null, status: aStatus(st.status), mf: `csf_remediation_status:${st.id}` });
    }
  }

  // 6. risk_treatment_actions -> remediation_actions, hung off a per-risk finding (source_type='risk')
  for (const rta of db.prepare(`SELECT rta.*, r.title AS risk_title FROM risk_treatment_actions rta JOIN risks r ON r.id=rta.risk_id`).all()) {
    const riskMf = `risk:${rta.risk_id}`;
    let fid = (findingByMf.get(riskMf) || {}).id;
    if (!fid) fid = mkFinding({ ws: rta.workspace_id, st: 'risk', sid: `risks:${rta.risk_id}`, title: `Risk treatment: ${rta.risk_title}`.slice(0, 120), desc: null, sev: 'medium', scheme: 'hml', status: 'in_remediation', mf: riskMf });
    insAction.run({ ws: rta.workspace_id, fid, rid: null, title: rta.title, desc: rta.description ?? null, status: aStatus(rta.status), mf: `risk_treatment_actions:${rta.id}` });
    bump('rta');
  }

  // 7. supplier_findings -> findings, with dedup vs nonconformities on nonconformity_id
  for (const sf of db.prepare(`SELECT * FROM supplier_findings`).all()) {
    if (sf.nonconformity_id != null) {
      const ncFinding = findingByMf.get(`nonconformities:${sf.nonconformity_id}`);
      if (ncFinding) { // dedup: same underlying finding -> link controls, no duplicate
        if (sf.iso_control_ref) linkControls(ncFinding.id, sf.workspace_id, /^a\./i.test(sf.iso_control_ref) ? 'annex-a.' + sf.iso_control_ref.replace(/^a\./i, '') : sf.iso_control_ref);
        quarantine('supplier_findings', sf.id, `DEDUP: merged into finding for nonconformities:${sf.nonconformity_id} (no duplicate created)`, JSON.stringify(sf));
        bump('sf_dedup'); continue;
      }
      quarantine('supplier_findings', sf.id, `AMBIGUOUS: nonconformity_id=${sf.nonconformity_id} set but no migrated NC finding`, JSON.stringify(sf));
      bump('sf_ambiguous'); continue;
    }
    const stype = /question|review/i.test(sf.source || '') ? 'assessment' : 'manual';
    const fid = mkFinding({ ws: sf.workspace_id, st: stype, sid: `supplier_findings:${sf.id}`, title: sf.title, desc: sf.description ?? null, sev: (sf.severity || 'medium').toLowerCase(), scheme: 'hml', status: fStatus(sf.status), mf: `supplier_findings:${sf.id}` });
    if (fid) { if (sf.iso_control_ref) linkControls(fid, sf.workspace_id, /^a\./i.test(sf.iso_control_ref) ? 'annex-a.' + sf.iso_control_ref.replace(/^a\./i, '') : sf.iso_control_ref); bump('sf'); }
  }
  return s;
});

run();
console.log('Phase 6 backfill by source:', JSON.stringify(s));
console.log(`totals -> findings=${db.prepare('SELECT count(*) n FROM findings').get().n}, recommendations=${db.prepare('SELECT count(*) n FROM recommendations').get().n}, remediation_actions=${db.prepare('SELECT count(*) n FROM remediation_actions').get().n}, finding_controls=${db.prepare('SELECT count(*) n FROM finding_controls').get().n}, phase6_quarantine=${db.prepare("SELECT count(*) n FROM migration_quarantine WHERE phase='phase6'").get().n}`);
db.close();
