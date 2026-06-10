#!/usr/bin/env node
/**
 * replay.js  — run the full converged-migration chain against a target DB.
 *
 * Runs the whole sequence (schema + backfills) against a target, printing every
 * reconciliation gate. Used to prove the chain replays deterministically from a
 * pristine pre-phase-0 copy. AWS is descoped (2026-06-10): dev is the single
 * instance of record, so this exists as a verification/insurance harness rather
 * than a second-environment replay. The deferred data scripts (006/007/009) have
 * no legacy data anywhere and run as no-op-safe steps.
 *
 *   DB_PATH=/path/to/target.db node migrations/replay.js
 */
const { execSync } = require('child_process');
const path = require('path');

const repo = __dirname;
const target = process.env.DB_PATH;
if (!target) { console.error('Set DB_PATH to the target database.'); process.exit(2); }
const env = { ...process.env, DB_PATH: target };

const steps = [
  ['schema (runner: 001-005)', `node "${path.join(repo, 'run.js')}"`],
  ['phase0 data: quarantine CSF seed orphans', `sqlite3 "${target}" < "${path.join(repo, 'data/001_phase0_quarantine_csf_orphans.sql')}"`],
  ['phase1 data: framework catalog backfill', `node "${path.join(repo, 'data/002_phase1_backfill.js')}"`],
  ['phase2 data: evidence links backfill', `node "${path.join(repo, 'data/003_phase2_backfill.js')}"`],
  ['phase3 data: control instances backfill', `node "${path.join(repo, 'data/004_phase3_backfill.js')}"`],
  ['phase4 data: structural backfill', `node "${path.join(repo, 'data/005_phase4_structural_backfill.js')}"`],
  ['phase4 data: responses-blob', `node "${path.join(repo, 'data/006_phase4_responses_blob.js')}"`],
  ['phase4 data: csf-engine', `node "${path.join(repo, 'data/007_phase4_csf_engine.js')}"`],
  ['phase5 data: supplier/DDQ structural', `node "${path.join(repo, 'data/008_phase5_structural.js')}"`],
  ['phase5 data: DDQ history (score recompute)', `node "${path.join(repo, 'data/009_phase5_ddq_history.js')}"`],
  ['phase5 data: schedules', `node "${path.join(repo, 'data/010_phase5_schedules.js')}"`],
  ['phase6 data: remediation pipeline', `node "${path.join(repo, 'data/011_phase6_remediation.js')}"`],
  ['phase7 job: control-exception expiry surfacing', `node "${path.join(repo, 'data/012_phase7_exception_expiry.js')}"`],
];

console.log(`# replay target: ${target}\n`);
for (const [label, cmd] of steps) {
  console.log(`\n## ${label}`);
  execSync(cmd, { env, stdio: 'inherit' });
}

// final reconciliation summary
const Database = require('better-sqlite3');
const db = new Database(target);
const n = (t) => db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
console.log('\n=== final converged-table counts ===');
for (const t of ['frameworks', 'requirements', 'requirement_mappings', 'evidence_requirement_links',
  'control_instances', 'control_instance_history', 'document_requirement_links',
  'question_sets', 'questions', 'assessments', 'responses', 'assessment_versions', 'response_snapshots',
  'assessment_schedules', 'external_assessment_tokens',
  'findings', 'finding_controls', 'recommendations', 'remediation_actions', 'control_exceptions']) {
  console.log(`  ${t}: ${n(t)}`);
}
console.log(`  migration_quarantine (by phase):`);
for (const r of db.prepare(`SELECT phase, count(*) c FROM migration_quarantine GROUP BY phase ORDER BY phase`).all()) console.log(`    ${r.phase}: ${r.c}`);
db.close();
