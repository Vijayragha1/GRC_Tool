-- Each completed pass retains the exact history and workpaper versions that
-- were reviewed. Existing workpaper identities and issued report bytes survive.
CREATE TABLE assessment_pass_manifests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  engagement_id INTEGER NOT NULL REFERENCES consulting_engagements(id),
  assessment_pass_id INTEGER NOT NULL REFERENCES assessment_passes(id),
  completion_generation INTEGER NOT NULL CHECK(completion_generation > 0),
  supersedes_manifest_id INTEGER REFERENCES assessment_pass_manifests(id),
  prepared_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER NOT NULL REFERENCES users(id),
  source_cutoff TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(prepared_by <> reviewed_by),
  UNIQUE(assessment_pass_id,completion_generation)
);
CREATE INDEX idx_pass_manifests_engagement ON assessment_pass_manifests(workspace_id,engagement_id,assessment_pass_id,id);

CREATE TABLE assessment_pass_manifest_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id INTEGER NOT NULL REFERENCES assessment_pass_manifests(id),
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  source_history_id INTEGER NOT NULL REFERENCES control_state_history(id),
  source_pass_id INTEGER NOT NULL REFERENCES assessment_passes(id),
  workpaper_id INTEGER NOT NULL REFERENCES consultant_workpapers(id),
  snapshot_id INTEGER NOT NULL REFERENCES consultant_workpaper_snapshots(id),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  inherited INTEGER NOT NULL CHECK(inherited IN (0,1)),
  UNIQUE(manifest_id,requirement_id),
  UNIQUE(snapshot_id)
);
CREATE TABLE consulting_report_pass_sources (
  report_id INTEGER PRIMARY KEY REFERENCES consulting_report_snapshots(id),
  manifest_id INTEGER NOT NULL REFERENCES assessment_pass_manifests(id)
);

CREATE TRIGGER trg_pass_manifest_scope BEFORE INSERT ON assessment_pass_manifests
WHEN NOT EXISTS (SELECT 1 FROM assessment_passes p JOIN consulting_engagements e
  ON e.id=NEW.engagement_id WHERE p.id=NEW.assessment_pass_id AND p.workspace_id=NEW.workspace_id AND e.workspace_id=NEW.workspace_id)
 OR (NEW.supersedes_manifest_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assessment_pass_manifests m WHERE m.id=NEW.supersedes_manifest_id AND m.assessment_pass_id=NEW.assessment_pass_id))
BEGIN SELECT RAISE(ABORT,'assessment manifest source belongs to another workspace or pass'); END;
CREATE TRIGGER trg_pass_manifest_item_scope BEFORE INSERT ON assessment_pass_manifest_items
WHEN NOT EXISTS (SELECT 1 FROM assessment_pass_manifests m
 JOIN consultant_workpapers w ON w.id=NEW.workpaper_id AND w.workspace_id=m.workspace_id AND w.engagement_id=m.engagement_id AND w.requirement_id=NEW.requirement_id
 JOIN consultant_workpaper_snapshots s ON s.id=NEW.snapshot_id AND s.workpaper_id=w.id AND s.snapshot_hash=NEW.snapshot_hash
 JOIN requirements r ON r.id=NEW.requirement_id
 JOIN assessment_passes mp ON mp.id=m.assessment_pass_id
 JOIN assessment_passes sp ON sp.id=NEW.source_pass_id AND sp.workspace_id=m.workspace_id AND sp.pass_number<=mp.pass_number
 JOIN control_state_history h ON h.id=NEW.source_history_id AND h.workspace_id=m.workspace_id AND h.iso_item_id=r.ref AND h.pass_id=NEW.source_pass_id
 WHERE m.id=NEW.manifest_id AND NEW.inherited=CASE WHEN NEW.source_pass_id=m.assessment_pass_id THEN 0 ELSE 1 END
 AND EXISTS (SELECT 1 FROM json_each(m.manifest_json,'$.items') j WHERE json_extract(j.value,'$.requirement_id')=NEW.requirement_id
   AND json_extract(j.value,'$.source_history_id')=NEW.source_history_id AND json_extract(j.value,'$.source_pass_id')=NEW.source_pass_id
   AND json_extract(j.value,'$.workpaper_id')=NEW.workpaper_id AND json_extract(j.value,'$.snapshot_id')=NEW.snapshot_id
   AND json_extract(j.value,'$.snapshot_hash')=NEW.snapshot_hash AND json_extract(j.value,'$.inherited')=NEW.inherited))
BEGIN SELECT RAISE(ABORT,'assessment manifest item source does not match'); END;
CREATE TRIGGER trg_report_pass_source_scope BEFORE INSERT ON consulting_report_pass_sources
WHEN NOT EXISTS (SELECT 1 FROM consulting_report_snapshots r JOIN assessment_pass_manifests m
 ON m.id=NEW.manifest_id AND m.workspace_id=r.workspace_id AND m.engagement_id=r.engagement_id WHERE r.id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'report pass source belongs to another engagement'); END;

CREATE TRIGGER trg_pass_manifests_no_update BEFORE UPDATE ON assessment_pass_manifests BEGIN SELECT RAISE(ABORT,'assessment manifests are immutable'); END;
CREATE TRIGGER trg_pass_manifests_no_delete BEFORE DELETE ON assessment_pass_manifests BEGIN SELECT RAISE(ABORT,'assessment manifests are immutable'); END;
CREATE TRIGGER trg_pass_manifest_items_no_update BEFORE UPDATE ON assessment_pass_manifest_items BEGIN SELECT RAISE(ABORT,'assessment manifest items are immutable'); END;
CREATE TRIGGER trg_pass_manifest_items_no_delete BEFORE DELETE ON assessment_pass_manifest_items BEGIN SELECT RAISE(ABORT,'assessment manifest items are immutable'); END;
CREATE TRIGGER trg_report_pass_sources_no_update BEFORE UPDATE ON consulting_report_pass_sources BEGIN SELECT RAISE(ABORT,'report pass sources are immutable'); END;
CREATE TRIGGER trg_report_pass_sources_no_delete BEFORE DELETE ON consulting_report_pass_sources BEGIN SELECT RAISE(ABORT,'report pass sources are immutable'); END;

-- NULL means no forecast was supplied, rather than a misleading zero cost.
ALTER TABLE engagement_commercials ADD COLUMN estimated_remaining_cost_minor INTEGER CHECK(estimated_remaining_cost_minor IS NULL OR estimated_remaining_cost_minor >= 0);

-- A review decision binds to the requested recorded assessment, including edits
-- made after the request. Legacy flags require a fresh governed request.
CREATE TABLE assessment_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  framework_code TEXT NOT NULL CHECK(framework_code IN ('iso27001','iso42001')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  prepared_by INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('request','approve','send_back','clear')),
  request_event_id INTEGER REFERENCES assessment_review_events(id),
  source_record_version INTEGER NOT NULL,
  result_record_version INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT,
  source_snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_assessment_review_source ON assessment_review_events(workspace_id,requirement_id,id);
CREATE TRIGGER trg_assessment_review_event_scope BEFORE INSERT ON assessment_review_events
WHEN NOT EXISTS (SELECT 1 FROM requirements r JOIN frameworks f ON f.id=r.framework_id
  WHERE r.id=NEW.requirement_id AND f.code=NEW.framework_code)
 OR (NEW.request_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assessment_review_events e
  WHERE e.id=NEW.request_event_id AND e.workspace_id=NEW.workspace_id AND e.requirement_id=NEW.requirement_id AND e.action='request'))
BEGIN SELECT RAISE(ABORT,'assessment review source does not match'); END;
CREATE TRIGGER trg_assessment_review_events_no_update BEFORE UPDATE ON assessment_review_events BEGIN SELECT RAISE(ABORT,'assessment review history is immutable'); END;
CREATE TRIGGER trg_assessment_review_events_no_delete BEFORE DELETE ON assessment_review_events BEGIN SELECT RAISE(ABORT,'assessment review history is immutable'); END;
