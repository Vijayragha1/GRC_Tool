'use strict';
// Which shared records belong to the AI management system.
//
// Internal audits, management reviews and nonconformities live in tables the
// ISO 27001 programme shares, and audits and reviews carry no framework of
// their own. ISO 42001 readiness and the ISO 42001 delivery plan both read
// them through this module, so the two never disagree about what counts.
//
// On a client whose only programme is ISO 42001, every such record is the
// AIMS's. On a client with ISO 27001 as well, an audit or nonconformity counts
// only when it is tied to an ISO 42001 requirement or certification event; a
// management review counts either way, because one integrated review serves
// both management systems.

const { frameworkCodes } = require('./engagement-outcome-scope');

// Statuses a completed review or audit has been saved with. The forms save
// 'complete'; older records and imports use the others.
const DONE = ['complete', 'completed', 'done', 'closed'];
const DONE_SQL = DONE.map((s) => `'${s}'`).join(',');

function aiOnly(workspace) {
  const codes = frameworkCodes(workspace);
  return codes.length === 1 && codes[0] === 'iso42001';
}

const count = (db, sql, ...params) => {
  try { return db.prepare(sql).get(...params).c || 0; } catch (_) { return 0; }
};

// Internal audits that have reached their report.
function reportedAudits(db, workspace) {
  const reported = `(COALESCE(a.lifecycle_stage,'') IN ('report','follow_up','closed') OR lower(COALESCE(a.status,'')) IN (${DONE_SQL}))`;
  if (aiOnly(workspace)) return count(db, `SELECT COUNT(*) c FROM audits a WHERE a.workspace_id=? AND ${reported}`, workspace.id);
  return count(db, `SELECT COUNT(*) c FROM audits a WHERE a.workspace_id=? AND ${reported}
    AND (EXISTS (SELECT 1 FROM audit_observations o WHERE o.audit_id=a.id AND o.iso_item_id LIKE 'ai-%')
      OR EXISTS (SELECT 1 FROM audit_findings f WHERE f.audit_id=a.id AND f.iso_item_id LIKE 'ai-%')
      OR EXISTS (SELECT 1 FROM audit_samples s WHERE s.audit_id=a.id AND s.iso_item_id LIKE 'ai-%'))`, workspace.id);
}

// Completed management reviews, optionally only those held in the last months.
function heldReviews(db, workspace, { withinMonths = null } = {}) {
  const recent = withinMonths ? ` AND meeting_date >= date('now','-${Number(withinMonths)} months')` : '';
  return count(db, `SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND lower(COALESCE(status,'')) IN (${DONE_SQL})${recent}`, workspace.id);
}

// Open nonconformities against the AIMS: tied to an ISO 42001 requirement, or
// raised at an ISO 42001 certification audit (lib/iso42001-cycle.js).
function openNonconformities(db, workspace) {
  const open = `lower(COALESCE(status,'open')) NOT IN ('closed','verified')`;
  if (aiOnly(workspace)) return count(db, `SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND ${open}`, workspace.id);
  return count(db, `SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND ${open}
    AND (iso_item_id LIKE 'ai-%' OR COALESCE(source_ref,'') LIKE 'iso42001%' OR COALESCE(source_ref,'') LIKE 'aims_cert_event:%')`, workspace.id);
}

module.exports = { DONE, aiOnly, reportedAudits, heldReviews, openNonconformities };
