-- 038_performance_objective_measurement.sql
-- Connect clause 6.2 objectives to the governed ISO/IEC 27004 measurement
-- programme. Existing objectives remain manual; a linked objective derives its
-- current value and performance status from the latest metric reading.

ALTER TABLE security_objectives
  ADD COLUMN metric_id INTEGER REFERENCES isms_metrics(id) ON DELETE SET NULL;

ALTER TABLE security_objectives
  ADD COLUMN status_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK(status_mode IN ('manual','metric'));

CREATE INDEX IF NOT EXISTS idx_security_objectives_metric
  ON security_objectives(workspace_id,metric_id);
