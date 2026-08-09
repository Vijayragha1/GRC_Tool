-- 023_assurance_reporting_center.sql
-- Immutable assurance report definitions, frozen data snapshots, stored
-- artifacts, source lineage, and maker-checker lifecycle events.

CREATE TABLE IF NOT EXISTS assurance_report_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  audience TEXT NOT NULL,
  default_sections TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO assurance_report_definitions
  (report_key, name, description, audience, default_sections)
VALUES
  ('executive_posture', 'Executive security posture',
   'Board-ready view of control implementation, priority risk, assurance activity, and management attention.',
   'Board, executive leadership, risk committee',
   '["executive_summary","posture","priority_risks","assurance","management_attention"]'),
  ('audit_readiness', 'Audit-readiness report',
   'Frozen audit preparation record covering scope, SoA quality, controls, evidence, governance, and open nonconformities.',
   'Internal audit, certification body, ISMS leadership',
   '["executive_summary","scope","soa","controls","evidence","governance","nonconformities","source_manifest"]'),
  ('supplier_due_diligence', 'Supplier due-diligence report',
   'Decision-grade third-party risk report with supplier profile, questionnaire, risk calculation, evidence, findings, and approval history.',
   'Procurement, security, privacy, risk committee',
   '["executive_summary","supplier_profile","risk_assessment","questionnaire","evidence","findings","decision","monitoring","source_manifest"]');

CREATE TABLE IF NOT EXISTS assurance_report_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id INTEGER NOT NULL REFERENCES assurance_report_definitions(id),
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  reporting_period_start TEXT,
  reporting_period_end TEXT,
  cutoff_at TEXT NOT NULL,
  scope_label TEXT,
  framework TEXT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  audience TEXT,
  classification TEXT NOT NULL DEFAULT 'Confidential',
  watermark TEXT,
  prepared_for TEXT,
  prepared_by TEXT,
  executive_summary TEXT,
  selected_sections TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK(status IN ('generated','in_review','changes_requested','approved','published','superseded')),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  data_quality_json TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
  published_by INTEGER REFERENCES users(id),
  published_at TEXT,
  superseded_at TEXT,
  UNIQUE(workspace_id, definition_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_assurance_runs_workspace
  ON assurance_report_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assurance_runs_status
  ON assurance_report_runs(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS assurance_report_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES assurance_report_runs(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_updated_at TEXT,
  UNIQUE(run_id, section_key, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_assurance_sources_run
  ON assurance_report_sources(run_id, section_key);

CREATE TABLE IF NOT EXISTS assurance_report_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES assurance_report_runs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assurance_events_run
  ON assurance_report_events(run_id, created_at, id);

CREATE TABLE IF NOT EXISTS assurance_report_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES assurance_report_runs(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK(format IN ('pdf','docx','html','json')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content_blob BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  generated_by INTEGER NOT NULL REFERENCES users(id),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, format)
);
CREATE INDEX IF NOT EXISTS idx_assurance_artifacts_run
  ON assurance_report_artifacts(run_id, format);
