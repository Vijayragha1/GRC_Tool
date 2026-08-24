-- 056_dpdpa_gap_assessment.sql
-- Governed DPDPA gap-assessment foundation.
--
-- This migration is deliberately limited to assessment workpapers. It reuses
-- the canonical framework, requirement, control-instance, evidence, finding,
-- recommendation and remediation tables. It does not introduce privacy
-- operations such as consent, data-principal requests, processing inventories
-- or breach handling.

-- Composite candidate keys let every DPDPA child relationship carry and
-- enforce workspace/framework ownership instead of trusting route filters.
CREATE UNIQUE INDEX IF NOT EXISTS uq_requirements_framework_id
  ON requirements(framework_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_control_instances_workspace_requirement_id
  ON control_instances(workspace_id,requirement_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dpdpa_gap_finding_source
  ON findings(workspace_id,source_type,source_id)
  WHERE source_type='assessment' AND source_id GLOB 'dpdpa:*';

-- A catalog lock records the exact canonical requirement manifest used by an
-- assessment. The domain computes the hash using deterministic JSON and will
-- refuse a supplied catalog whose claimed hash differs.
CREATE TABLE IF NOT EXISTS dpdpa_gap_catalog_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_id INTEGER NOT NULL REFERENCES frameworks(id),
  catalog_version TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  requirement_count INTEGER NOT NULL CHECK(requirement_count > 0),
  source_reference TEXT NOT NULL,
  catalog_manifest_json TEXT NOT NULL CHECK(json_valid(catalog_manifest_json)),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(framework_id,catalog_version,catalog_hash),
  CHECK(length(catalog_hash)=64 AND catalog_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX IF NOT EXISTS idx_dpdpa_gap_catalog_framework
  ON dpdpa_gap_catalog_versions(framework_id,catalog_version,locked_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_catalog_no_update
BEFORE UPDATE ON dpdpa_gap_catalog_versions
BEGIN
  SELECT RAISE(ABORT,'DPDPA catalog locks are immutable; register a new version');
END;
CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_catalog_no_delete
BEFORE DELETE ON dpdpa_gap_catalog_versions
BEGIN
  SELECT RAISE(ABORT,'DPDPA catalog locks cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS dpdpa_gap_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  framework_id INTEGER NOT NULL REFERENCES frameworks(id),
  title TEXT NOT NULL,
  scope_statement TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft'
    CHECK(status IN ('Draft','In Progress','Under Review','Approved','Superseded')),
  catalog_version TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  catalog_requirement_count INTEGER NOT NULL CHECK(catalog_requirement_count > 0),
  applicability_profile_version TEXT NOT NULL DEFAULT 'DPDPA-APPLICABILITY-1.0',
  applicability_profile_json TEXT NOT NULL CHECK(json_valid(applicability_profile_json)),
  applicability_profile_hash TEXT NOT NULL,
  baseline_assessment_id INTEGER,
  baseline_snapshot_id INTEGER,
  created_by INTEGER NOT NULL REFERENCES users(id),
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  superseded_by_assessment_id INTEGER,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,id,framework_id),
  FOREIGN KEY(framework_id,catalog_version,catalog_hash)
    REFERENCES dpdpa_gap_catalog_versions(framework_id,catalog_version,catalog_hash),
  FOREIGN KEY(workspace_id,superseded_by_assessment_id)
    REFERENCES dpdpa_gap_assessments(workspace_id,id),
  FOREIGN KEY(workspace_id,baseline_assessment_id)
    REFERENCES dpdpa_gap_assessments(workspace_id,id),
  CHECK(length(catalog_hash)=64 AND catalog_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(applicability_profile_hash)=64 AND applicability_profile_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(as_of_date)=10 AND as_of_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK((submitted_by IS NULL)=(submitted_at IS NULL)),
  CHECK((approved_by IS NULL)=(approved_at IS NULL)),
  CHECK((baseline_assessment_id IS NULL)=(baseline_snapshot_id IS NULL)),
  CHECK(status NOT IN ('Approved','Superseded') OR approved_by IS NOT NULL),
  CHECK(status!='Superseded' OR superseded_by_assessment_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_dpdpa_gap_assessment_workspace
  ON dpdpa_gap_assessments(workspace_id,status,updated_at DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dpdpa_gap_current_approved
  ON dpdpa_gap_assessments(workspace_id) WHERE status='Approved';

-- Pinned requirement text prevents a later catalog revision from rewriting an
-- historic workpaper. control_instance_id connects conclusions to the shared
-- GRC truth model and, through finding_controls, to remediation.
CREATE TABLE IF NOT EXISTS dpdpa_gap_assessment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  assessment_id INTEGER NOT NULL,
  framework_id INTEGER NOT NULL,
  requirement_id INTEGER NOT NULL,
  control_instance_id INTEGER NOT NULL,
  requirement_ref TEXT NOT NULL,
  requirement_title TEXT NOT NULL,
  requirement_description TEXT,
  requirement_domain TEXT NOT NULL,
  source_section TEXT,
  source_rule TEXT,
  effective_date TEXT,
  legal_effective_status TEXT NOT NULL
    CHECK(legal_effective_status IN ('Effective','Future Effective','Effective Date Not Set')),
  applicability_hint TEXT NOT NULL DEFAULT 'In Scope'
    CHECK(applicability_hint IN ('In Scope','Potentially Out of Scope','Requires Review')),
  applicability_reason TEXT,
  status TEXT NOT NULL DEFAULT 'Not Assessed'
    CHECK(status IN ('Not Assessed','Implemented','Partially Implemented','Not Implemented','Not Applicable')),
  assessment_note TEXT,
  gap_description TEXT,
  recommendation TEXT,
  na_rationale TEXT,
  owner_id INTEGER REFERENCES users(id),
  due_date TEXT,
  evidence_sufficient INTEGER NOT NULL DEFAULT 1 CHECK(evidence_sufficient IN (0,1)),
  assessed_by INTEGER REFERENCES users(id),
  assessed_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,assessment_id,requirement_id),
  UNIQUE(workspace_id,assessment_id,id),
  FOREIGN KEY(workspace_id,assessment_id,framework_id)
    REFERENCES dpdpa_gap_assessments(workspace_id,id,framework_id) ON DELETE CASCADE,
  FOREIGN KEY(framework_id,requirement_id)
    REFERENCES requirements(framework_id,id),
  FOREIGN KEY(workspace_id,requirement_id,control_instance_id)
    REFERENCES control_instances(workspace_id,requirement_id,id) ON DELETE CASCADE,
  CHECK(status!='Not Applicable' OR length(trim(COALESCE(na_rationale,'')))>=80),
  CHECK(status='Not Applicable' OR na_rationale IS NULL),
  CHECK(effective_date IS NULL OR (length(effective_date)=10 AND effective_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  CHECK(due_date IS NULL OR (length(due_date)=10 AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  CHECK((assessed_by IS NULL)=(assessed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_dpdpa_gap_items_assessment
  ON dpdpa_gap_assessment_items(workspace_id,assessment_id,requirement_domain,status,requirement_ref);
CREATE INDEX IF NOT EXISTS idx_dpdpa_gap_items_control
  ON dpdpa_gap_assessment_items(workspace_id,control_instance_id);

-- Append-only review history is both the lifecycle ledger and the explicit
-- reviewer acceptance record for every Not Applicable rationale.
CREATE TABLE IF NOT EXISTS dpdpa_gap_assessment_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  assessment_id INTEGER NOT NULL,
  assessment_item_id INTEGER,
  item_row_version INTEGER,
  action TEXT NOT NULL
    CHECK(action IN ('Submitted','Returned','N/A Accepted','Approved')),
  from_status TEXT NOT NULL
    CHECK(from_status IN ('Draft','In Progress','Under Review','Approved','Superseded')),
  to_status TEXT NOT NULL
    CHECK(to_status IN ('Draft','In Progress','Under Review','Approved','Superseded')),
  note TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,assessment_id,id),
  FOREIGN KEY(workspace_id,assessment_id)
    REFERENCES dpdpa_gap_assessments(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,assessment_id,assessment_item_id)
    REFERENCES dpdpa_gap_assessment_items(workspace_id,assessment_id,id),
  CHECK(
    (action='Submitted' AND assessment_item_id IS NULL AND item_row_version IS NULL AND from_status IN ('Draft','In Progress') AND to_status='Under Review')
    OR (action='Returned' AND assessment_item_id IS NULL AND item_row_version IS NULL AND from_status='Under Review' AND to_status='In Progress' AND length(trim(COALESCE(note,'')))>=20)
    OR (action='N/A Accepted' AND assessment_item_id IS NOT NULL AND item_row_version IS NOT NULL AND from_status='Under Review' AND to_status='Under Review')
    OR (action='Approved' AND assessment_item_id IS NULL AND item_row_version IS NULL AND from_status='Under Review' AND to_status='Approved')
  )
);
CREATE INDEX IF NOT EXISTS idx_dpdpa_gap_reviews_assessment
  ON dpdpa_gap_assessment_reviews(workspace_id,assessment_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dpdpa_gap_na_acceptance
  ON dpdpa_gap_assessment_reviews(workspace_id,assessment_id,assessment_item_id,actor_id,item_row_version)
  WHERE action='N/A Accepted';

-- Frozen, deterministic assessment payloads. No report renderer is coupled to
-- live workpaper tables once a snapshot has been created.
CREATE TABLE IF NOT EXISTS dpdpa_gap_assessment_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  assessment_id INTEGER NOT NULL,
  sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
  assessment_row_version INTEGER NOT NULL CHECK(assessment_row_version > 0),
  status_at_capture TEXT NOT NULL
    CHECK(status_at_capture IN ('Under Review','Approved','Superseded')),
  catalog_version TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  payload_version TEXT NOT NULL DEFAULT 'DPDPA-GAP-1.0',
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,assessment_id,sequence_number),
  UNIQUE(workspace_id,assessment_id,snapshot_hash),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,assessment_id)
    REFERENCES dpdpa_gap_assessments(workspace_id,id) ON DELETE CASCADE,
  CHECK(length(catalog_hash)=64 AND catalog_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX IF NOT EXISTS idx_dpdpa_gap_snapshots_assessment
  ON dpdpa_gap_assessment_snapshots(workspace_id,assessment_id,sequence_number DESC);

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_assessment_baseline
BEFORE INSERT ON dpdpa_gap_assessments
WHEN NEW.baseline_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM dpdpa_gap_assessment_snapshots s
  JOIN dpdpa_gap_assessments a
    ON a.workspace_id=s.workspace_id AND a.id=s.assessment_id
  WHERE s.workspace_id=NEW.workspace_id
    AND s.assessment_id=NEW.baseline_assessment_id
    AND s.id=NEW.baseline_snapshot_id
    AND a.status IN ('Approved','Superseded')
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA reassessment baseline is not an approved workspace snapshot');
END;

-- Keep direct domain calls aligned with requireWorkspace: managers and senior
-- consultants may act firm-wide; ordinary consultants and all client users
-- must be explicitly assigned to this workspace.
CREATE VIEW IF NOT EXISTS v_dpdpa_gap_workspace_actors AS
SELECT DISTINCT w.id AS workspace_id,u.id AS user_id
FROM workspaces w
JOIN users u ON u.active=1
LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=u.id
WHERE (u.user_type='firm' AND u.firm_id=w.firm_id
       AND (u.firm_role IN ('manager','firm_owner','owner','senior_consultant','lead_consultant')
            OR wm.id IS NOT NULL));

-- Accountable remediation owners may also be active, explicitly assigned
-- client members. They are not assessment actors and receive no workbench or
-- transition authority from this view.
CREATE VIEW IF NOT EXISTS v_dpdpa_gap_workspace_owners AS
SELECT DISTINCT w.id AS workspace_id,u.id AS user_id
FROM workspaces w
JOIN users u ON u.active=1
LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=u.id
WHERE (u.user_type='firm' AND u.firm_id=w.firm_id
       AND (u.firm_role IN ('manager','firm_owner','owner','senior_consultant','lead_consultant')
            OR wm.id IS NOT NULL))
   OR (u.user_type='client' AND wm.id IS NOT NULL);

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_assessment_actor
BEFORE INSERT ON dpdpa_gap_assessments
WHEN NOT EXISTS (
  SELECT 1 FROM v_dpdpa_gap_workspace_actors a
  WHERE a.workspace_id=NEW.workspace_id AND a.user_id=NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment actor does not belong to this workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_assessment_identity_immutable
BEFORE UPDATE OF workspace_id,framework_id,title,scope_statement,as_of_date,
  catalog_version,catalog_hash,catalog_requirement_count,
  applicability_profile_version,applicability_profile_json,
  applicability_profile_hash,baseline_assessment_id,baseline_snapshot_id,
  created_by,created_at
ON dpdpa_gap_assessments
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment identity and catalog baseline are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_assessment_row_version
BEFORE UPDATE ON dpdpa_gap_assessments
WHEN NEW.row_version != OLD.row_version + 1
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment row version must advance by one');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_assessment_transition
BEFORE UPDATE OF status ON dpdpa_gap_assessments
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status='Draft' AND NEW.status IN ('In Progress','Under Review'))
  OR (OLD.status='In Progress' AND NEW.status='Under Review')
  OR (OLD.status='Under Review' AND NEW.status IN ('In Progress','Approved'))
  OR (OLD.status='Approved' AND NEW.status='Superseded')
)
BEGIN
  SELECT RAISE(ABORT,'invalid DPDPA assessment lifecycle transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_assessment_terminal_lock
BEFORE UPDATE ON dpdpa_gap_assessments
WHEN OLD.status='Superseded'
  OR (OLD.status='Approved' AND NEW.status!='Superseded')
BEGIN
  SELECT RAISE(ABORT,'approved or superseded DPDPA assessments are locked');
END;

-- Submission cannot rely on a cached evidence flag. It queries canonical,
-- current evidence links at the assessment as-of date.
CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_submission_gate
BEFORE UPDATE OF status ON dpdpa_gap_assessments
WHEN NEW.status='Under Review' AND (
  EXISTS (
    SELECT 1 FROM dpdpa_gap_assessment_items i
    WHERE i.workspace_id=NEW.workspace_id AND i.assessment_id=NEW.id
      AND i.status='Not Assessed'
  )
  OR EXISTS (
    SELECT 1 FROM dpdpa_gap_assessment_items i
    WHERE i.workspace_id=NEW.workspace_id AND i.assessment_id=NEW.id
      AND i.status='Not Applicable'
      AND length(trim(COALESCE(i.na_rationale,'')))<80
  )
  OR EXISTS (
    SELECT 1 FROM dpdpa_gap_assessment_items i
    WHERE i.workspace_id=NEW.workspace_id AND i.assessment_id=NEW.id
      AND i.status IN ('Implemented','Partially Implemented','Not Implemented')
      AND length(trim(COALESCE(i.assessment_note,'')))<20
  )
  OR EXISTS (
    SELECT 1 FROM dpdpa_gap_assessment_items i
    WHERE i.workspace_id=NEW.workspace_id AND i.assessment_id=NEW.id
      AND i.status IN ('Partially Implemented','Not Implemented')
      AND (length(trim(COALESCE(i.gap_description,'')))<20
        OR length(trim(COALESCE(i.recommendation,'')))<20)
  )
  OR EXISTS (
    SELECT 1 FROM dpdpa_gap_assessment_items i
    WHERE i.workspace_id=NEW.workspace_id AND i.assessment_id=NEW.id
      AND i.status IN ('Implemented','Partially Implemented')
      AND NOT EXISTS (
        SELECT 1 FROM evidence_requirement_links erl
        JOIN evidence e ON e.id=erl.evidence_id
        WHERE erl.requirement_id=i.requirement_id
          AND e.workspace_id=NEW.workspace_id
          AND e.superseded_at IS NULL
          AND substr(e.uploaded_at,1,10)<=NEW.as_of_date
          AND (e.valid_from IS NULL OR e.valid_from<=NEW.as_of_date)
          AND (e.valid_until IS NULL OR e.valid_until>=NEW.as_of_date)
      )
  )
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment is incomplete or has insufficient evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_approval_actor
BEFORE UPDATE OF status ON dpdpa_gap_assessments
WHEN NEW.status='Approved' AND (
  NEW.approved_by IS NULL
  OR NEW.approved_by=OLD.created_by
  OR NEW.approved_by=OLD.submitted_by
  OR NOT EXISTS (
    SELECT 1 FROM v_dpdpa_gap_workspace_actors a
    WHERE a.workspace_id=NEW.workspace_id AND a.user_id=NEW.approved_by
  )
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA approval requires an independent workspace reviewer');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_approval_na_acceptance
BEFORE UPDATE OF status ON dpdpa_gap_assessments
WHEN NEW.status='Approved' AND EXISTS (
  SELECT 1 FROM dpdpa_gap_assessment_items i
  WHERE i.workspace_id=NEW.workspace_id AND i.assessment_id=NEW.id
    AND i.status='Not Applicable'
    AND NOT EXISTS (
      SELECT 1 FROM dpdpa_gap_assessment_reviews r
      WHERE r.workspace_id=i.workspace_id AND r.assessment_id=i.assessment_id
        AND r.assessment_item_id=i.id AND r.action='N/A Accepted'
        AND r.actor_id=NEW.approved_by AND r.item_row_version=i.row_version
    )
)
BEGIN
  SELECT RAISE(ABORT,'reviewer must explicitly accept every Not Applicable rationale');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_assessment_no_delete
BEFORE DELETE ON dpdpa_gap_assessments
WHEN EXISTS (SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_item_catalog_match
BEFORE INSERT ON dpdpa_gap_assessment_items
WHEN NOT EXISTS (
  SELECT 1 FROM requirements r
  WHERE r.id=NEW.requirement_id AND r.framework_id=NEW.framework_id
    AND r.ref=NEW.requirement_ref AND r.title=NEW.requirement_title
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment item does not match its pinned requirement');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_item_identity_immutable
BEFORE UPDATE OF workspace_id,assessment_id,framework_id,requirement_id,
  control_instance_id,requirement_ref,requirement_title,
  requirement_description,requirement_domain,source_section,source_rule,effective_date,
  legal_effective_status,applicability_hint,applicability_reason,created_at
ON dpdpa_gap_assessment_items
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment item identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_item_row_version
BEFORE UPDATE ON dpdpa_gap_assessment_items
WHEN NEW.row_version != OLD.row_version + 1
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment item row version must advance by one');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_item_workpaper_lock
BEFORE UPDATE ON dpdpa_gap_assessment_items
WHEN NOT EXISTS (
  SELECT 1 FROM dpdpa_gap_assessments a
  WHERE a.workspace_id=OLD.workspace_id AND a.id=OLD.assessment_id
    AND a.status IN ('Draft','In Progress')
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA workpapers are locked during and after review');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_item_owner_insert
BEFORE INSERT ON dpdpa_gap_assessment_items
WHEN NEW.owner_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM v_dpdpa_gap_workspace_owners a
  WHERE a.workspace_id=NEW.workspace_id AND a.user_id=NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment item owner does not belong to this workspace');
END;
CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_item_owner_update
BEFORE UPDATE OF owner_id ON dpdpa_gap_assessment_items
WHEN NEW.owner_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM v_dpdpa_gap_workspace_owners a
  WHERE a.workspace_id=NEW.workspace_id AND a.user_id=NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment item owner does not belong to this workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_item_no_delete
BEFORE DELETE ON dpdpa_gap_assessment_items
WHEN EXISTS (SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment workpapers cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_review_actor
BEFORE INSERT ON dpdpa_gap_assessment_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM v_dpdpa_gap_workspace_actors a
  WHERE a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_id
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA reviewer does not belong to this workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_review_na_item
BEFORE INSERT ON dpdpa_gap_assessment_reviews
WHEN NEW.action='N/A Accepted' AND NOT EXISTS (
  SELECT 1 FROM dpdpa_gap_assessment_items i
  WHERE i.workspace_id=NEW.workspace_id AND i.assessment_id=NEW.assessment_id
    AND i.id=NEW.assessment_item_id AND i.status='Not Applicable'
    AND i.row_version=NEW.item_row_version
    AND length(trim(COALESCE(i.na_rationale,'')))>=80
)
BEGIN
  SELECT RAISE(ABORT,'only a supported Not Applicable rationale can be accepted');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_review_no_update
BEFORE UPDATE ON dpdpa_gap_assessment_reviews
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment reviews are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_review_no_delete
BEFORE DELETE ON dpdpa_gap_assessment_reviews
WHEN EXISTS (SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment reviews cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_snapshot_lineage
BEFORE INSERT ON dpdpa_gap_assessment_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM dpdpa_gap_assessments a
  WHERE a.workspace_id=NEW.workspace_id AND a.id=NEW.assessment_id
    AND a.row_version=NEW.assessment_row_version
    AND a.status=NEW.status_at_capture
    AND a.catalog_version=NEW.catalog_version
    AND a.catalog_hash=NEW.catalog_hash
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA snapshot lineage does not match the assessment baseline');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_snapshot_actor
BEFORE INSERT ON dpdpa_gap_assessment_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM v_dpdpa_gap_workspace_actors a
  WHERE a.workspace_id=NEW.workspace_id AND a.user_id=NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT,'DPDPA snapshot actor does not belong to this workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_snapshot_no_update
BEFORE UPDATE ON dpdpa_gap_assessment_snapshots
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment snapshots are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_dpdpa_gap_snapshot_no_delete
BEFORE DELETE ON dpdpa_gap_assessment_snapshots
WHEN EXISTS (SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'DPDPA assessment snapshots cannot be deleted');
END;
