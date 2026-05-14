#!/usr/bin/env node
// Demo seed for the NIST CSF module.
//
//   npm run csf-demo
//
// Creates an "Acme Corp" workspace under the first firm in the database and
// builds a Govern-Function-complete CSF engagement on it. Per handoff
// decision #40, the practice engagement covers one Function (Govern) for v1.
//
// Idempotent: if Acme Corp already exists with a CSF engagement on it, the
// script reports and exits without changes. To force a re-run, delete the
// workspace via the UI first.
//
// This is SYNTHETIC DATA only. The prototype is not licensed for real client
// information until Stage 13 (production security) ships.

const path = require('path');
const Database = require('better-sqlite3');
const dbPath = path.resolve(__dirname, '..', 'iso27001.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// Ensure schema is up to date (in case the demo is run before the app boots).
const { init } = require('../db');
// db.js's init() needs the same db handle; the module exports its own.
init();

function log(s) { console.log(`[csf-demo] ${s}`); }

const firm = db.prepare(`SELECT id, name FROM firms ORDER BY id LIMIT 1`).get();
if (!firm) {
  console.error('[csf-demo] No firm found. Boot the app once and create a firm via /register before running the demo.');
  process.exit(1);
}
log(`Using firm "${firm.name}" (id=${firm.id})`);

const owner = db.prepare(`SELECT id, name FROM users WHERE firm_id=? AND user_type='firm' ORDER BY id LIMIT 1`).get(firm.id);
if (!owner) {
  console.error('[csf-demo] No firm user found. Create one via /register.');
  process.exit(1);
}
log(`Using firm user "${owner.name}" (id=${owner.id})`);

// Workspace
let workspace = db.prepare(`SELECT * FROM workspaces WHERE firm_id=? AND client_name='Acme Corp (CSF demo)'`).get(firm.id);
if (!workspace) {
  const wsId = db.prepare(`
    INSERT INTO workspaces (firm_id, client_name, industry, scope, lead_consultant_id)
    VALUES (?, 'Acme Corp (CSF demo)', 'SaaS', 'Acme Corp production environment', ?)
  `).run(firm.id, owner.id).lastInsertRowid;
  db.prepare(`INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'firm_owner')`).run(wsId, owner.id);
  workspace = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(wsId);
  log(`Created workspace "${workspace.client_name}" (id=${workspace.id})`);
} else {
  log(`Workspace "${workspace.client_name}" already exists (id=${workspace.id})`);
}

// Engagement
let engagement = db.prepare(`SELECT * FROM csf_engagements WHERE workspace_id=? AND name LIKE 'CSF demo%' AND deleted_at IS NULL`).get(workspace.id);
if (engagement) {
  log(`Engagement already exists (id=${engagement.id}). Demo seed is idempotent - no further changes.`);
  log(`Open it at /workspaces/${workspace.id}/csf/${engagement.id}`);
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const inThreeMonths = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

const engId = db.prepare(`
  INSERT INTO csf_engagements (workspace_id, catalog_version, name, period_start, period_end,
    target_completion_date, scope_mode, status, assigned_lead_id, created_by)
  VALUES (?, '2.0', 'CSF demo - Acme baseline', ?, ?, ?, 'CURRENT_TARGET', 'Draft', ?, ?)
`).run(workspace.id, today, inThreeMonths, inThreeMonths, owner.id, owner.id).lastInsertRowid;
engagement = db.prepare(`SELECT * FROM csf_engagements WHERE id=?`).get(engId);
log(`Created engagement "${engagement.name}" (id=${engagement.id})`);

// Default weighting profile
const profileId = db.prepare(`INSERT INTO csf_weighting_profiles (engagement_id, workspace_id, name, is_default) VALUES (?, ?, 'Default (equal weighting)', 1)`).run(engId, workspace.id).lastInsertRowid;
const subs = db.prepare(`SELECT id FROM csf_subcategories WHERE catalog_version='2.0'`).all();
const insWPI = db.prepare(`INSERT INTO csf_weighting_profile_items (profile_id, subcategory_id, weight) VALUES (?, ?, 1.0)`);
const seedWPI = db.transaction(() => subs.forEach(s => insWPI.run(profileId, s.id)));
seedWPI();
db.prepare(`UPDATE csf_engagements SET weighting_profile_id=? WHERE id=?`).run(profileId, engId);
log(`Seeded weighting profile (${subs.length} entries)`);

// Self-assignment as Lead
db.prepare(`INSERT OR IGNORE INTO csf_engagement_assignments (engagement_id, user_id, role_on_engagement, assigned_by) VALUES (?, ?, 'ENGAGEMENT_LEAD', ?)`).run(engId, owner.id, owner.id);

// Seed assessment rows
const csfPolicy = require('../lib/csf-policy');
csfPolicy.ensureAssessmentRows(db, engagement);
log(`Assessment rows seeded`);

// Walk through Govern function: for every GV.* subcategory, attach one evidence
// link + mark Evidence Collected + score current/target. Realistic spread of
// CMMI scores (1-4) so the rollup looks like a credible baseline.
const govSubs = db.prepare(`
  SELECT a.id AS assess_id, s.id AS sub_id, s.code, s.description
  FROM csf_subcategory_assessments a
  INNER JOIN csf_subcategories s ON s.id = a.subcategory_id
  INNER JOIN csf_categories c ON c.id = s.category_id
  INNER JOIN csf_functions f ON f.id = c.function_id
  WHERE a.engagement_id=? AND f.code='GV'
  ORDER BY s.display_order
`).all(engId);
log(`Working ${govSubs.length} Govern subcategories...`);

// Pseudo-realistic baseline distribution. Bias toward 2 (Managed) with some 1s
// and 3s scattered, to demo Tier 2 (Risk Informed) overall.
const scoreFor = (i) => {
  const pattern = [2, 1, 3, 2, 2, 3, 1, 2, 2, 3, 2, 1, 4, 2, 3, 2, 1, 3, 2, 2, 3, 1, 2, 3, 2, 2, 3, 4, 1, 2, 3];
  return pattern[i % pattern.length];
};
const targetFor = (cur) => Math.min(5, cur + 1 + (Math.random() < 0.3 ? 1 : 0));

const tx = db.transaction(() => {
  govSubs.forEach((s, i) => {
    const cur = scoreFor(i);
    const tgt = targetFor(cur);
    const narrative = csfPolicy.buildStructuredNarrative({
      practice_observed: `Acme has an informal practice for ${s.code.toLowerCase()}: it exists but is inconsistent across teams.`,
      evidence_reviewed: `Confluence page on ${s.code}, interview with Acme Head of Security on ${today}.`,
      gaps_or_concerns: cur < 3 ? `No documented standard; depends on which team is doing the work.` : `Practice is documented but metrics not yet tracked.`,
      follow_up_needed: `Re-check at 90 days against the revised information-security policy.`,
    });
    db.prepare(`
      UPDATE csf_subcategory_assessments
      SET narrative=?, status='Draft Complete',
          current_score=?, target_score=?,
          evidence_collected_by=?, evidence_collected_at=CURRENT_TIMESTAMP,
          narrative_drafted_by=?, narrative_drafted_at=CURRENT_TIMESTAMP,
          scored_by=?, scored_at=CURRENT_TIMESTAMP,
          last_edited_by=?, last_edited_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(narrative, cur, tgt, owner.id, owner.id, owner.id, owner.id, s.assess_id);

    // One evidence link per subcategory
    db.prepare(`
      INSERT INTO csf_evidence_items (assessment_id, type, url, description, uploaded_by)
      VALUES (?, 'LINK', ?, ?, ?)
    `).run(s.assess_id, `https://confluence.acme.example/security/${s.code.toLowerCase()}`, `Internal write-up of ${s.code} practice`, owner.id);
  });
});
tx();
log(`Govern subcategories walked through (Draft Complete, evidence attached)`);

// Two demo findings (one engagement-theme, one tied to GV.OC-01)
const ocSub = govSubs.find(s => s.code === 'GV.OC-01');
const findingThemeId = db.prepare(`
  INSERT INTO csf_findings (engagement_id, assessment_id, title, description, severity, status, promoted_to_engagement_theme, created_by)
  VALUES (?, NULL, ?, ?, ?, 'Draft', 1, ?)
`).run(engId,
  'Risk management is treated as a compliance exercise, not a strategic input',
  'Across multiple GV interviews, risk register entries are tracked but rarely surface in product or operational decisions. Strategic decisions are made on revenue/feature criteria with security/risk reviewed afterwards.',
  'HIGH', owner.id).lastInsertRowid;

const findingOcId = ocSub ? db.prepare(`
  INSERT INTO csf_findings (engagement_id, assessment_id, title, description, severity, status, created_by)
  VALUES (?, ?, ?, ?, ?, 'Draft', ?)
`).run(engId, ocSub.assess_id,
  'Mission statement does not inform cybersecurity priorities',
  'GV.OC-01: the published mission ("Acme makes work simpler") is broad enough that it provides no decision input. Risk register entries cite generic compliance drivers rather than mission-critical outcomes.',
  'MEDIUM', owner.id).lastInsertRowid : null;

// Two recommendations on the theme
db.prepare(`
  INSERT INTO csf_recommendations (finding_id, description, estimated_effort, priority, roadmap_phase, created_by)
  VALUES (?, ?, 'M', 'HIGH', '0_3M', ?)
`).run(findingThemeId, 'Add a "risk review" step to the quarterly strategy review. Risks above the appetite threshold must be discussed by name with the leadership team and the decision logged.', owner.id);
db.prepare(`
  INSERT INTO csf_recommendations (finding_id, description, estimated_effort, priority, roadmap_phase, created_by)
  VALUES (?, ?, 'L', 'MED', '3_6M', ?)
`).run(findingThemeId, 'Tie cybersecurity objectives to specific mission outcomes (e.g., "uptime of customer-facing service" rather than "implement Annex A controls").', owner.id);

log(`Seeded 2 findings + 2 recommendations`);

console.log('');
console.log('[csf-demo] Done.');
console.log(`[csf-demo] Open the engagement at /workspaces/${workspace.id}/csf/${engagement.id}`);
console.log(`[csf-demo] Scores: /workspaces/${workspace.id}/csf/${engagement.id}/scores`);
console.log(`[csf-demo] Findings: /workspaces/${workspace.id}/csf/${engagement.id}/findings`);
console.log('');
console.log('[csf-demo] To exercise the publish flow: move engagement Draft -> In Progress -> Under Review -> Approved, then Publish v1.0.');
