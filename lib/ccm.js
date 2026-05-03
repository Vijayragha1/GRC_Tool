// Continuous Control Monitoring rule engine. Evaluates rules against the
// tool's own state — no external network calls. Each evaluation produces a
// ccm_results row (pass/fail/warn) and feeds into readiness flags.

const { db, verifyAuditChain } = require('../db');

function runRule(rule, workspaceId) {
  const cfg = JSON.parse(rule.rule_config);
  try {
    if (rule.rule_kind === 'sql_count') {
      const row = db.prepare(cfg.sql).get(workspaceId);
      const count = row ? Object.values(row)[0] : 0;
      const pass = (cfg.max != null) ? count <= cfg.max
                : (cfg.min != null) ? count >= cfg.min
                : false;
      return {
        status: pass ? 'pass' : 'fail',
        measured_value: String(count),
        details: pass ? `count=${count} within bound` : `count=${count} violates threshold (${cfg.max != null ? 'max '+cfg.max : 'min '+cfg.min})`
      };
    }
    if (rule.rule_kind === 'sql_max_age_days') {
      const row = db.prepare(cfg.sql).get(workspaceId);
      const ts = row ? Object.values(row)[0] : null;
      if (!ts) return { status: 'fail', measured_value: 'never', details: 'No record found.' };
      const ageDays = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
      const pass = ageDays <= cfg.max_days;
      return {
        status: pass ? 'pass' : 'fail',
        measured_value: `${ageDays}d`,
        details: pass ? `Last record ${ageDays} days old (≤ ${cfg.max_days}).`
                      : `Last record ${ageDays} days old (> ${cfg.max_days}).`
      };
    }
    if (rule.rule_kind === 'sql_min_count') {
      const row = db.prepare(cfg.sql).get(workspaceId);
      const count = row ? Object.values(row)[0] : 0;
      const pass = count >= (cfg.min || 1);
      return {
        status: pass ? 'pass' : 'fail',
        measured_value: String(count),
        details: pass ? `count=${count} ≥ ${cfg.min}` : `count=${count} < required ${cfg.min}`
      };
    }
    if (rule.rule_kind === 'tool_setting') {
      if (cfg.setting === 'audit_log_chain_clean') {
        const issues = verifyAuditChain(workspaceId);
        return {
          status: issues.length === 0 ? 'pass' : 'fail',
          measured_value: String(issues.length),
          details: issues.length === 0 ? 'Hash chain verifies clean.' : `${issues.length} integrity issues detected.`
        };
      }
      if (cfg.setting === 'workspace_encryption_enabled') {
        const w = db.prepare('SELECT encryption_enabled FROM workspaces WHERE id=?').get(workspaceId);
        const ok = !!(w && w.encryption_enabled);
        return {
          status: ok ? 'pass' : 'fail',
          measured_value: ok ? '1' : '0',
          details: ok ? 'Workspace has field-level encryption enabled.'
                      : 'Workspace does not have field-level encryption enabled.'
        };
      }
      return { status: 'warn', measured_value: '', details: 'Unknown setting: ' + cfg.setting };
    }
    return { status: 'warn', measured_value: '', details: 'Unknown rule_kind: ' + rule.rule_kind };
  } catch (e) {
    return { status: 'warn', measured_value: '', details: 'Rule error: ' + e.message };
  }
}

function runAll(workspaceId) {
  const rules = db.prepare(`SELECT * FROM ccm_rules WHERE is_active=1 AND (workspace_id IS NULL OR workspace_id=?)`).all(workspaceId);
  const ins = db.prepare(`INSERT INTO ccm_results (workspace_id, rule_id, status, measured_value, details) VALUES (?, ?, ?, ?, ?)`);
  const out = { pass: 0, fail: 0, warn: 0, total: rules.length };
  for (const rule of rules) {
    const r = runRule(rule, workspaceId);
    ins.run(workspaceId, rule.id, r.status, r.measured_value, r.details);
    out[r.status]++;
  }
  return out;
}

function latestResults(workspaceId) {
  // Most recent result per rule
  return db.prepare(`SELECT r.*, c.iso_item_id, c.name, c.description, c.frequency
    FROM ccm_rules c
    LEFT JOIN ccm_results r ON r.id = (SELECT MAX(id) FROM ccm_results WHERE rule_id=c.id AND workspace_id=?)
    WHERE c.is_active=1 AND (c.workspace_id IS NULL OR c.workspace_id=?)
    ORDER BY CASE r.status WHEN 'fail' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END, c.name`).all(workspaceId, workspaceId);
}

module.exports = { runRule, runAll, latestResults };
