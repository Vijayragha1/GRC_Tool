#!/usr/bin/env node
/**
 * phase7_validate.js  (fixture harness; proves control_exceptions schema + the expiry job 012)
 * Dashboard rendering + scheduling in lib/jobs.js are gated app-integration; this proves the data path.
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repo = path.join(__dirname, '..', '..');
const realDb = process.env.DB_PATH || path.join(repo, 'iso27001.db');
const scratch = '/tmp/p7-scratch.db';
for (const f of [scratch, `${scratch}-wal`, `${scratch}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
execSync(`sqlite3 "${realDb}" ".backup '${scratch}'"`);

const checks = [];
const db = new Database(scratch);
db.pragma('foreign_keys = ON');

const risk = db.prepare(`SELECT id, workspace_id FROM risks LIMIT 1`).get();
const ci = db.prepare(`SELECT id FROM control_instances WHERE workspace_id=? AND entity_id IS NULL LIMIT 1`).get(risk.workspace_id);
const ra = db.prepare(`INSERT INTO risk_acceptances (workspace_id,risk_id,accepter_name,rationale,signature,expires_at,signed_at) VALUES (?,?,?,?,?,?,?)`)
  .run(risk.workspace_id, risk.id, 'Fixture CISO', 'Accepted residual risk pending compensating controls', 'sig-hash', '2026-12-31', '2026-01-01').lastInsertRowid;

const insEx = db.prepare(`INSERT INTO control_exceptions (workspace_id,instance_id,description,compensating_controls,risk_acceptance_id,approved_at,expiry,state) VALUES (?,?,?,?,?,?,?,?)`);
const exPast = insEx.run(risk.workspace_id, ci.id, 'Legacy system cannot enforce MFA', 'IP allowlist + monitoring', ra, '2026-01-15', '2020-01-01', 'active').lastInsertRowid;   // expired+active -> must flip + notify
insEx.run(risk.workspace_id, ci.id, 'Temp exception, current', null, ra, '2026-01-15', '2099-01-01', 'active');                                                                  // future -> untouched
insEx.run(risk.workspace_id, ci.id, 'Expired but under review', null, ra, '2026-01-15', '2019-01-01', 'under_review');                                                           // expired+under_review -> not surfaced

// schema guards
checks.push(['3 exceptions inserted (FK linkage works)', db.prepare(`SELECT count(*) c FROM control_exceptions`).get().c, 3]);
let stateRejected = false; try { insEx.run(risk.workspace_id, ci.id, 'bad', null, ra, '2026-01-15', '2026-01-01', 'bogus'); } catch { stateRejected = true; }
checks.push(['invalid state rejected by CHECK', stateRejected ? 1 : 0, 1]);
let raRequired = false; try { db.prepare(`INSERT INTO control_exceptions (workspace_id,instance_id,description,risk_acceptance_id,expiry) VALUES (?,?,?,?,?)`).run(risk.workspace_id, ci.id, 'no RA', null, '2026-01-01'); } catch { raRequired = true; }
checks.push(['risk_acceptance_id mandatory (NOT NULL)', raRequired ? 1 : 0, 1]);
db.close();

// run the expiry job twice (idempotency / dedup)
console.log('--- 012 exception-expiry (run 1) ---');
execSync(`node "${path.join(repo, 'migrations/data/012_phase7_exception_expiry.js')}"`, { env: { ...process.env, DB_PATH: scratch }, stdio: 'inherit' });
console.log('--- 012 exception-expiry (run 2, must be no-op) ---');
execSync(`node "${path.join(repo, 'migrations/data/012_phase7_exception_expiry.js')}"`, { env: { ...process.env, DB_PATH: scratch }, stdio: 'inherit' });

const v = new Database(scratch);
const n = (sql, ...p) => Object.values(v.prepare(sql).get(...p))[0];
checks.push(['expiry job: active+past exception auto-expired', n(`SELECT state FROM control_exceptions WHERE id=?`, exPast) === 'expired' ? 1 : 0, 1]);
checks.push(['expiry job: future exception left active', n(`SELECT count(*) c FROM control_exceptions WHERE expiry='2099-01-01' AND state='active'`), 1]);
checks.push(['expiry job: under_review (expired) NOT auto-flipped', n(`SELECT count(*) c FROM control_exceptions WHERE expiry='2019-01-01' AND state='under_review'`), 1]);
checks.push(['expiry job: exactly 1 notification raised (dedup across 2 runs)', n(`SELECT count(*) c FROM notifications WHERE category='control_exception_expired'`), 1]);
v.close();

console.log('\n=== PHASE 7 FIXTURE ASSERTIONS ===');
let fail = 0;
for (const [name, got, want] of checks) { const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`); }
console.log(fail === 0 ? '\nALL PHASE 7 FIXTURE CHECKS PASS' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
