-- Governed consultancy recommendation drafting and quality review.
-- Draft content is revisioned and never client-visible. Only an exact submitted
-- revision can be issued into the immutable tprm_recommendations ledger.

CREATE TABLE IF NOT EXISTS tprm_recommendation_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft','in_review','changes_requested','issued','withdrawn'
  )),
  author_id INTEGER NOT NULL REFERENCES users(id),
  reviewer_id INTEGER REFERENCES users(id),
  current_revision_number INTEGER NOT NULL DEFAULT 0 CHECK(current_revision_number>=0),
  submitted_revision_number INTEGER,
  submitted_at TEXT,
  changes_requested_note TEXT,
  issued_recommendation_id INTEGER,
  issued_at TEXT,
  withdrawn_at TEXT,
  withdrawal_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,issued_recommendation_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  CHECK(status!='in_review' OR (submitted_at IS NOT NULL AND submitted_revision_number IS NOT NULL)),
  CHECK((status='issued')=(issued_recommendation_id IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK((status='withdrawn')=(withdrawn_at IS NOT NULL AND length(trim(COALESCE(withdrawal_reason,'')))>=10)),
  CHECK(reviewer_id IS NULL OR reviewer_id<>author_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_recommendation_draft_open_cycle
  ON tprm_recommendation_drafts(workspace_id,supplier_id,cycle_id)
  WHERE status NOT IN ('issued','withdrawn');
CREATE INDEX IF NOT EXISTS idx_tprm_recommendation_drafts_review
  ON tprm_recommendation_drafts(workspace_id,status,reviewer_id,updated_at);

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_actor_insert
BEFORE INSERT ON tprm_recommendation_drafts
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.author_id
  WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft author must be an active consultancy user');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_reviewer
BEFORE UPDATE OF reviewer_id ON tprm_recommendation_drafts
WHEN NEW.reviewer_id IS NOT NULL AND (
  NEW.reviewer_id=NEW.author_id OR NOT EXISTS (
    SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.reviewer_id
    WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
  )
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation reviewer must be a distinct active consultancy user');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_identity
BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,author_id,created_at
ON tprm_recommendation_drafts
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_status
BEFORE UPDATE OF status ON tprm_recommendation_drafts
WHEN NOT (
  (OLD.status IN ('draft','changes_requested') AND NEW.status='in_review')
  OR (OLD.status='in_review' AND NEW.status IN ('changes_requested','issued','withdrawn'))
  OR (OLD.status IN ('draft','changes_requested') AND NEW.status='withdrawn')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM recommendation draft status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_no_delete
BEFORE DELETE ON tprm_recommendation_drafts
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation drafts cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_recommendation_draft_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number>0),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'recommend_onboard','recommend_with_conditions','do_not_recommend','insufficient_information'
  )),
  executive_summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  residual_risk_score INTEGER CHECK(residual_risk_score BETWEEN 0 AND 100),
  residual_risk_band TEXT CHECK(residual_risk_band IN ('low','moderate','high','critical','unknown')),
  valid_until TEXT,
  conditions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(conditions_json) AND json_type(conditions_json)='array'),
  revision_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(draft_id,revision_number),
  UNIQUE(workspace_id,supplier_id,cycle_id,draft_id,revision_number),
  UNIQUE(revision_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,draft_id)
    REFERENCES tprm_recommendation_drafts(workspace_id,supplier_id,cycle_id,id),
  CHECK(length(trim(executive_summary))>=20),
  CHECK(length(trim(rationale))>=20),
  CHECK(length(revision_hash)=64 AND revision_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(valid_until IS NULL OR (valid_until GLOB '????-??-??' AND strftime('%Y-%m-%d',valid_until||' 00:00:00','+0 days')=valid_until))
);
CREATE INDEX IF NOT EXISTS idx_tprm_recommendation_revisions_draft
  ON tprm_recommendation_draft_revisions(draft_id,revision_number DESC);

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_revision_scope
BEFORE INSERT ON tprm_recommendation_draft_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_recommendation_drafts d
  JOIN workspaces w ON w.id=d.workspace_id
  JOIN users u ON u.id=NEW.created_by
  WHERE d.id=NEW.draft_id AND d.workspace_id=NEW.workspace_id
    AND d.supplier_id=NEW.supplier_id AND d.cycle_id=NEW.cycle_id
    AND d.status IN ('draft','changes_requested')
    AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation revision is outside an editable consultancy draft');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_revision_no_update
BEFORE UPDATE ON tprm_recommendation_draft_revisions
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft revisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_revision_no_delete
BEFORE DELETE ON tprm_recommendation_draft_revisions
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft revisions cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS tprm_recommendation_draft_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('created','revision_saved','submitted','changes_requested','issued','withdrawn')),
  from_status TEXT,
  to_status TEXT,
  revision_number INTEGER,
  note TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  request_fingerprint TEXT,
  idempotency_key TEXT,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_hash),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,draft_id)
    REFERENCES tprm_recommendation_drafts(workspace_id,supplier_id,cycle_id,id),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK(previous_event_hash IS NULL OR (length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
);
CREATE INDEX IF NOT EXISTS idx_tprm_recommendation_draft_events
  ON tprm_recommendation_draft_events(draft_id,occurred_at,id);
CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_actor
BEFORE INSERT ON tprm_recommendation_draft_events
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.actor_id
  WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft event requires an active consultancy actor');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_no_update
BEFORE UPDATE ON tprm_recommendation_draft_events
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_no_delete
BEFORE DELETE ON tprm_recommendation_draft_events
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft events cannot be deleted');
END;
