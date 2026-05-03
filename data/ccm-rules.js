// Continuous control monitoring rules. Each rule is evaluated by lib/ccm.js
// against the tool's own state. They produce ccm_results rows (pass/fail/warn)
// and feed into the readiness flag stream.
//
// rule_kind values understood by lib/ccm.js:
//   sql_count        — count rows from a SQL query; assert against threshold
//   sql_max_age_days — find newest row by date column; assert age in days
//   sql_min_count    — assert at least N rows match a query
//   tool_setting     — assert a tool-level setting holds (encryption, audit log integrity, etc.)

module.exports = [
  {
    iso_item_id: 'annex-a.5.18',
    name: 'Access reviews completed at least quarterly',
    description: 'A.5.18 requires periodic review of user access. Fails if no closed access_review in last 95 days.',
    rule_kind: 'sql_max_age_days',
    rule_config: { sql: "SELECT MAX(closed_at) AS d FROM access_reviews WHERE workspace_id = ?", max_days: 95 }
  },
  {
    iso_item_id: 'annex-a.8.5',
    name: 'MFA enforced (no admin without sign-on attestation)',
    description: 'Asserts that the workspace has at least one document acknowledging MFA enforcement.',
    rule_kind: 'sql_min_count',
    rule_config: { sql: "SELECT COUNT(*) c FROM generated_docs WHERE workspace_id = ? AND status IN ('approved','published') AND lower(name) LIKE '%mfa%' OR lower(name) LIKE '%multi-factor%' OR lower(name) LIKE '%authentication%'", min: 1 }
  },
  {
    iso_item_id: 'annex-a.8.13',
    name: 'Backups verified within 30 days',
    description: 'A.8.13 asks for tested backups. Asserts backup_runs has a successful entry in last 30 days.',
    rule_kind: 'sql_max_age_days',
    rule_config: { sql: "SELECT MAX(ran_at) AS d FROM backup_runs WHERE status='ok'", max_days: 30 }
  },
  {
    iso_item_id: 'annex-a.5.24',
    name: 'Incident response process exercised in last 365 days',
    description: 'Asserts that at least one incident (real or tabletop) was logged in the past year.',
    rule_kind: 'sql_max_age_days',
    rule_config: { sql: "SELECT MAX(created_at) AS d FROM incidents WHERE workspace_id = ?", max_days: 365 }
  },
  {
    iso_item_id: 'annex-a.5.31',
    name: 'Risk register updated in last 90 days',
    rule_kind: 'sql_max_age_days',
    rule_config: { sql: "SELECT MAX(created_at) AS d FROM risks WHERE workspace_id = ?", max_days: 90 }
  },
  {
    iso_item_id: 'annex-a.6.3',
    name: 'Security awareness training in last 12 months',
    rule_kind: 'sql_max_age_days',
    rule_config: { sql: "SELECT MAX(completed_date) AS d FROM training_records WHERE workspace_id = ? AND status='completed'", max_days: 365 }
  },
  {
    iso_item_id: 'annex-a.5.19',
    name: 'Critical suppliers re-assessed in last 12 months',
    description: 'High-risk suppliers should have a review or questionnaire response in past year.',
    rule_kind: 'sql_count',
    rule_config: {
      sql: "SELECT COUNT(*) c FROM suppliers WHERE workspace_id = ? AND lifecycle_stage NOT IN ('terminated') AND residual_risk_score >= 18 AND (last_assessed IS NULL OR last_assessed < date('now','-365 days'))",
      max: 0
    }
  },
  {
    iso_item_id: 'clause-9.2',
    name: 'Internal audit completed in last 12 months',
    rule_kind: 'sql_max_age_days',
    rule_config: { sql: "SELECT MAX(audit_date) AS d FROM audits WHERE workspace_id = ? AND status='complete'", max_days: 365 }
  },
  {
    iso_item_id: 'clause-9.3',
    name: 'Management review completed in last 12 months',
    rule_kind: 'sql_max_age_days',
    rule_config: { sql: "SELECT MAX(meeting_date) AS d FROM mrms WHERE workspace_id = ? AND status='complete'", max_days: 365 }
  },
  {
    iso_item_id: 'annex-a.5.33',
    name: 'Audit log integrity verifies clean',
    description: 'Hash chain on audit_log must verify with zero issues.',
    rule_kind: 'tool_setting',
    rule_config: { setting: 'audit_log_chain_clean' }
  },
  {
    iso_item_id: 'annex-a.8.24',
    name: 'Encryption-at-rest enabled for the workspace',
    rule_kind: 'tool_setting',
    rule_config: { setting: 'workspace_encryption_enabled' }
  },
  {
    iso_item_id: 'annex-a.5.31',
    name: 'No high residual risks past acceptance expiry',
    rule_kind: 'sql_count',
    rule_config: {
      sql: "SELECT COUNT(*) c FROM risks WHERE workspace_id = ? AND status='open' AND (residual_likelihood*residual_impact) >= 15 AND (accepted_until IS NULL OR accepted_until < date('now'))",
      max: 0
    }
  }
];
