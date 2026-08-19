'use strict';

function metricRag(value, target, direction) {
  if (value == null || target == null) return null;
  const lowerIsBetter = direction === 'lower';
  if (lowerIsBetter ? value <= target : value >= target) return 'green';
  if (lowerIsBetter ? value <= target * 1.1 : value >= target * 0.9) return 'amber';
  return 'red';
}

function formatNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return String(Math.round(number * 100) / 100);
}

function formatMetricValue(value, unit) {
  const formatted = formatNumber(value);
  if (formatted == null) return null;
  if (unit === '%') return `${formatted}%`;
  if (unit === 'days') return `${formatted} days`;
  return unit ? `${formatted} ${unit}` : formatted;
}

function objectiveStatusFromMetric(row) {
  if (!row.metric_id || row.status_mode !== 'metric') return row.status || 'on_track';
  const rag = metricRag(row.latest_value, row.metric_target_value, row.metric_direction);
  if (!rag) return 'no_data';
  return rag === 'green' ? 'on_track' : rag === 'amber' ? 'at_risk' : 'off_track';
}

function decorateObjective(row) {
  const linked = Boolean(row.metric_id && row.metric_name);
  const metricDriven = linked && row.status_mode === 'metric';
  return {
    ...row,
    linked,
    metricDriven,
    effectiveMeasurement: linked ? `${row.metric_ref || 'Measure'} · ${row.metric_name}` : (row.measurement || null),
    effectiveTarget: metricDriven ? formatMetricValue(row.metric_target_value, row.metric_unit) : (row.target_value || null),
    effectiveCurrent: metricDriven ? formatMetricValue(row.latest_value, row.metric_unit) : (row.current_value || null),
    effectiveStatus: objectiveStatusFromMetric(row),
    readingMissing: metricDriven && row.latest_value == null,
  };
}

function listObjectives(db, workspaceId) {
  return db.prepare(`
    SELECT o.*,m.ref AS metric_ref,m.name AS metric_name,m.unit AS metric_unit,
      m.direction AS metric_direction,m.target_value AS metric_target_value,
      m.frequency AS metric_frequency,m.owner_name AS metric_owner,
      (SELECT r.value FROM isms_metric_readings r WHERE r.metric_id=m.id
        ORDER BY r.measured_at DESC,r.id DESC LIMIT 1) AS latest_value,
      (SELECT r.measured_at FROM isms_metric_readings r WHERE r.metric_id=m.id
        ORDER BY r.measured_at DESC,r.id DESC LIMIT 1) AS latest_at
    FROM security_objectives o
    LEFT JOIN isms_metrics m ON m.id=o.metric_id AND m.workspace_id=o.workspace_id
    WHERE o.workspace_id=?
    ORDER BY o.due_date IS NULL,o.due_date,o.id`).all(workspaceId).map(decorateObjective);
}

function listAdoptedMetrics(db, workspaceId) {
  return db.prepare(`
    SELECT m.*,
      (SELECT r.value FROM isms_metric_readings r WHERE r.metric_id=m.id
        ORDER BY r.measured_at DESC,r.id DESC LIMIT 1) AS latest_value,
      (SELECT r.measured_at FROM isms_metric_readings r WHERE r.metric_id=m.id
        ORDER BY r.measured_at DESC,r.id DESC LIMIT 1) AS latest_at,
      (SELECT COUNT(*) FROM security_objectives o WHERE o.metric_id=m.id) AS objective_count
    FROM isms_metrics m
    WHERE m.workspace_id=? AND m.is_active=1
    ORDER BY m.category,m.name`).all(workspaceId).map(metric => ({
      ...metric,
      rag: metricRag(metric.latest_value, metric.target_value, metric.direction),
      latestDisplay: formatMetricValue(metric.latest_value, metric.unit),
      targetDisplay: formatMetricValue(metric.target_value, metric.unit),
    }));
}

function metricForWorkspace(db, metricId, workspaceId) {
  const id = Number(metricId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(`SELECT * FROM isms_metrics WHERE id=? AND workspace_id=? AND is_active=1`).get(id, workspaceId) || null;
}

module.exports = {
  metricRag,
  formatMetricValue,
  objectiveStatusFromMetric,
  decorateObjective,
  listObjectives,
  listAdoptedMetrics,
  metricForWorkspace,
};
