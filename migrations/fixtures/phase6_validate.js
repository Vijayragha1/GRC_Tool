#!/usr/bin/env node
/**
 * phase6_validate.js  (fixture harness; proves the CSF / dedup / risk paths 011 has no/seed data for in dev)
 *
 * Scratch copy of dev (Phase 6 applied). Seeds:
 *   - a REAL csf_engagement -> finding -> recommendation -> remediation_status chain (so the AWS replay
 *     re-executes a proven CSF remediation path)
 *   - a supplier_finding whose nonconformity_id matches an already-migrated NC (dedup -> no duplicate)
 *   - a supplier_finding with a dangling nonconformity_id (ambiguous -> quarantine)
 *   - a risk_treatment_action (-> per-risk finding source_type='risk' + remediation_action)
 * Re-runs 011 against scratch and asserts.
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repo = path.join(__dirname, '..', '..');
const realDb = process.env.DB_PATH || path.join(repo, 'iso27001.db');
const scratch = '/tmp/p6-scratch.db';
for (const f of [scratch, `${scratch}-wal`, `${scratch}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
execSync(`sqlite3 "${realDb}" ".backup '${scratch}'"`);

const db = new Database(scratch);
db.pragma('foreign_keys = ON');

const sub = db.prepare(`SELECT id FROM csf_subcategories ORDER BY id LIMIT 1`).get();   // for finding link (not required)
const supplier = db.prepare(`SELECT id, workspace_id FROM suppliers WHERE entity_id IS NOT NULL LIMIT 1`).get();
const nc = db.prepare(`SELECT id, workspace_id FROM nonconformities WHERE workspace_id=? LIMIT 1`).get(supplier.workspace_id)
        || db.prepare(`SELECT id, workspace_id FROM nonconformities LIMIT 1`).get();
const risk = db.prepare(`SELECT id, workspace_id FROM risks LIMIT 1`).get();

// CSF chain (real engagement so it is NOT treated as orphaned seed)
db.prepare(`INSERT INTO csf_engagements (id,workspace_id,catalog_version,name,scope_mode,status,created_at) VALUES (200,?,'2.0','Fixture CSF Engagement P6','CURRENT_ONLY','Approved','2026-01-01')`).run(risk.workspace_id);
db.prepare(`INSERT INTO csf_findings (id,engagement_id,title,description,severity,status) VALUES (9001,200,'CSF gap GV.OC','Context not documented','HIGH','Draft')`).run();
db.prepare(`INSERT INTO csf_recommendations (id,finding_id,description,priority) VALUES (9001,9001,'Document organizational context','high')`).run();
db.prepare(`INSERT INTO csf_remediation_status (id,recommendation_id,status,client_note) VALUES (9001,9001,'IN_PROGRESS','started')`).run();

// supplier_findings dedup: matched (existing NC) + ambiguous (dangling NC id)
db.prepare(`INSERT INTO supplier_findings (id,workspace_id,supplier_id,title,severity,status,source,nonconformity_id,iso_control_ref) VALUES (9001,?,?,'Vendor SLA breach (same as NC)','medium','open','review',?, 'A.5.19')`).run(nc.workspace_id, supplier.id, nc.id);
db.prepare(`INSERT INTO supplier_findings (id,workspace_id,supplier_id,title,severity,status,source,nonconformity_id) VALUES (9002,?,?,'Vendor finding w/ dangling NC','high','open','manual',999999)`).run(supplier.workspace_id, supplier.id);

// risk_treatment_action -> per-risk finding (source_type='risk') + remediation_action
db.prepare(`INSERT INTO risk_treatment_actions (id,workspace_id,risk_id,title,description,status) VALUES (9001,?,?,'Implement MFA','Roll out MFA to all admins','in_progress')`).run(risk.workspace_id, risk.id);
db.close();

console.log('--- 011 remediation (re-run, idempotent; migrates fixture CSF/dedup/risk rows) ---');
execSync(`node "${path.join(repo, 'migrations/data/011_phase6_remediation.js')}"`, { env: { ...process.env, DB_PATH: scratch }, stdio: 'inherit' });

const v = new Database(scratch);
const n = (sql, ...p) => Object.values(v.prepare(sql).get(...p))[0];
const checks = [
  ['CSF finding -> finding (source_type=assessment)', n(`SELECT count(*) c FROM findings WHERE migrated_from='csf_findings:9001' AND source_type='assessment'`), 1],
  ['CSF recommendation -> recommendation', n(`SELECT count(*) c FROM recommendations WHERE migrated_from='csf_recommendations:9001'`), 1],
  ['CSF remediation_status -> remediation_action', n(`SELECT count(*) c FROM remediation_actions WHERE migrated_from='csf_remediation_status:9001' AND status='in_progress'`), 1],
  ['supplier_finding (matched NC) -> NO duplicate finding', n(`SELECT count(*) c FROM findings WHERE migrated_from='supplier_findings:9001'`), 0],
  ['supplier_finding (matched NC) -> DEDUP quarantine', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase6' AND source_table='supplier_findings' AND source_id='9001' AND reason LIKE 'DEDUP%'`), 1],
  ['supplier_finding (dangling NC) -> AMBIGUOUS quarantine', n(`SELECT count(*) c FROM migration_quarantine WHERE phase='phase6' AND source_table='supplier_findings' AND source_id='9002' AND reason LIKE 'AMBIGUOUS%'`), 1],
  ['risk_treatment_action -> per-risk finding (source_type=risk)', n(`SELECT count(*) c FROM findings WHERE migrated_from=? AND source_type='risk'`, `risk:${risk.id}`), 1],
  ['risk_treatment_action -> remediation_action', n(`SELECT count(*) c FROM remediation_actions WHERE migrated_from='risk_treatment_actions:9001' AND status='in_progress'`), 1],
];
v.close();

console.log('\n=== PHASE 6 FIXTURE ASSERTIONS ===');
let fail = 0;
for (const [name, got, want] of checks) { const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`); }
console.log(fail === 0 ? '\nALL PHASE 6 FIXTURE CHECKS PASS' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
