-- 027_consulting_findings_and_reports.sql
-- Formal finding lifecycle and immutable client-ready reporting sourced only
-- from governed consultant workpapers.

CREATE TABLE IF NOT EXISTS consulting_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  workpaper_id INTEGER REFERENCES consultant_workpapers(id) ON DELETE SET NULL,
  finding_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  finding_type TEXT NOT NULL DEFAULT 'gap' CHECK(finding_type IN ('nonconformity','gap','observation','improvement')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('critical','high','medium','low')),
  condition_text TEXT NOT NULL,
  criteria_text TEXT NOT NULL,
  cause_text TEXT,
  effect_text TEXT NOT NULL,
  recommendation_text TEXT NOT NULL,
  internal_notes TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0 CHECK(client_visible IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','remediation_planned','ready_for_validation','closed','withdrawn')),
  owner_id INTEGER REFERENCES users(id),
  due_date DATE,
  remediation_plan TEXT,
  resolution_summary TEXT,
  validation_conclusion TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  validated_by INTEGER REFERENCES users(id),
  validated_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(engagement_id,finding_ref)
);
CREATE INDEX IF NOT EXISTS idx_consulting_findings_eng ON consulting_findings(engagement_id,status,severity,due_date);
CREATE INDEX IF NOT EXISTS idx_consulting_findings_owner ON consulting_findings(workspace_id,owner_id,status);

CREATE TABLE IF NOT EXISTS consulting_finding_evidence (
  finding_id INTEGER NOT NULL REFERENCES consulting_findings(id) ON DELETE CASCADE,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('source','remediation','validation')),
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(finding_id,evidence_id,evidence_role)
);

CREATE TABLE IF NOT EXISTS consulting_finding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES consulting_findings(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finding_events_finding ON consulting_finding_events(finding_id,created_at,id);

CREATE TABLE IF NOT EXISTS consulting_report_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK(report_type IN ('assessment','readiness','internal_audit','management')),
  title TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated','approved','published','superseded')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  generated_by INTEGER NOT NULL REFERENCES users(id),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  published_by INTEGER REFERENCES users(id),
  published_at TEXT,
  decision_note TEXT,
  UNIQUE(engagement_id,report_type,version_number)
);
CREATE INDEX IF NOT EXISTS idx_consulting_reports_eng ON consulting_report_snapshots(engagement_id,report_type,version_number DESC);

CREATE TRIGGER IF NOT EXISTS trg_finding_events_no_update BEFORE UPDATE ON consulting_finding_events
BEGIN SELECT RAISE(ABORT,'finding events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_finding_events_no_delete BEFORE DELETE ON consulting_finding_events
BEGIN SELECT RAISE(ABORT,'finding events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_consulting_reports_no_update_payload BEFORE UPDATE OF snapshot_json,snapshot_hash,version_number,engagement_id,workspace_id ON consulting_report_snapshots
BEGIN SELECT RAISE(ABORT,'report snapshot payload is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_consulting_reports_no_delete BEFORE DELETE ON consulting_report_snapshots
BEGIN SELECT RAISE(ABORT,'report snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_finding_evidence_tenant BEFORE INSERT ON consulting_finding_evidence
WHEN NOT EXISTS (SELECT 1 FROM consulting_findings f JOIN evidence e ON e.id=NEW.evidence_id WHERE f.id=NEW.finding_id AND f.workspace_id=e.workspace_id)
BEGIN SELECT RAISE(ABORT,'finding evidence belongs to another workspace'); END;
