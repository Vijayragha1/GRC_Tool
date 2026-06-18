-- schema_current.sql
-- SCHEMA OF RECORD for the converged GRC schema. Regenerated at the close of the
-- migration program (2026-06-18) from a fresh boot of db.js + the full migration
-- chain (the canonical, reproducible end state). Do not hand-edit: regenerate from
-- a fresh boot. See MIGRATION_NOTES.md ("MIGRATION PROGRAM: CLOSED") for the model.
--
-- Notes:
--  * control_states / iso42001_control_states are NOT here: they are CREATE'd by
--    db.js only as transient chain-scaffolding (immutable migrations 013/017 attach
--    triggers ON them) and dropped by migration 019 at chain-end, so the end state
--    has neither. They disappear from db.js at the baseline collapse.
--  * The assessment-history engine (control_state_history / iso42001_control_state_history
--    + assessment_passes) is retained by decision as the converged history model.

-- ============================================================
-- TABLES (178)
-- ============================================================

CREATE TABLE access_review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  current_role TEXT,
  decision TEXT,
  decision_reason TEXT,
  reviewer TEXT,
  decided_at DATETIME,
  FOREIGN KEY (review_id) REFERENCES access_reviews(id) ON DELETE CASCADE
);

CREATE TABLE access_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  period_start DATE,
  period_end DATE,
  status TEXT DEFAULT 'open',
  reviewer TEXT,
  outcome TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at DATETIME,
  last_used_at DATETIME,
  ip_lock TEXT,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE assessment_passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    pass_number INTEGER NOT NULL,
    label TEXT,
    notes TEXT,
    status TEXT DEFAULT 'in_progress',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    started_by INTEGER,
    completed_by INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (started_by) REFERENCES users(id),
    FOREIGN KEY (completed_by) REFERENCES users(id)
  );

CREATE TABLE assessment_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
  cadence TEXT NOT NULL,
  next_run TEXT,
  trigger_rule TEXT,                                 -- JSON
  is_active INTEGER DEFAULT 1
, migrated_from TEXT);

CREATE TABLE assessment_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  published_at TEXT DEFAULT (datetime('now')),
  published_by INTEGER REFERENCES users(id),
  change_summary TEXT,
  is_current INTEGER DEFAULT 0,
  migrated_from TEXT,
  UNIQUE (assessment_id, version_number)
);

CREATE TABLE assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
  question_set_version INTEGER NOT NULL,
  label TEXT,
  pass_number INTEGER,
  period_start TEXT, period_end TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','in_review','finalized')),
  propagation_done INTEGER NOT NULL DEFAULT 0,
  started_by INTEGER REFERENCES users(id), started_at TEXT,
  completed_by INTEGER REFERENCES users(id), finalized_at TEXT,
  migrated_from TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE asset_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  parent_asset_id INTEGER NOT NULL,
  child_asset_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  notes TEXT,
  UNIQUE(parent_asset_id, child_asset_id, relation),
  FOREIGN KEY (parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY (child_asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  classification TEXT,
  owner_name TEXT,
  cia_c INTEGER DEFAULT 1,
  cia_i INTEGER DEFAULT 1,
  cia_a INTEGER DEFAULT 1,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, business_criticality TEXT, rto_hours INTEGER, rpo_hours INTEGER, bia_notes TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE audit_chain (
  id INTEGER PRIMARY KEY,
  audit_log_id INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_log_id) REFERENCES audit_log(id) ON DELETE CASCADE
);

CREATE TABLE audit_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL,
  iso_item_id TEXT,
  finding_type TEXT,
  description TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  nonconformity_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  entity_scope_id INTEGER,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  before_state TEXT,
  after_state TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE audit_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL,
  iso_item_id TEXT,
  description TEXT NOT NULL,
  recommendation TEXT,
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE audit_programmes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  description TEXT,
  approved_by TEXT,
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE audit_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id INTEGER NOT NULL,
    iso_item_id TEXT,
    description TEXT NOT NULL,
    sample_taken_at DATE,
    population_size INTEGER,
    sample_size INTEGER,
    finding TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
  );

CREATE TABLE auditor_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    label TEXT,
    expires_at DATETIME,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at DATETIME,
    access_count INTEGER DEFAULT 0,
    revoked_at DATETIME,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  scope TEXT,
  audit_date DATE,
  auditor_name TEXT,
  status TEXT DEFAULT 'planned',
  summary TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, programme_id INTEGER REFERENCES audit_programmes(id) ON DELETE SET NULL, auditor_competence TEXT, auditor_independence TEXT, sample_size INTEGER, population_size INTEGER, lifecycle_stage TEXT DEFAULT 'planned', fieldwork_started_at DATETIME, report_issued_at DATETIME, closed_at DATETIME, sampling_justification TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  encrypted INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  error TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bcp_plan_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      process_id INTEGER NOT NULL,
      UNIQUE(plan_id, process_id),
      FOREIGN KEY (plan_id) REFERENCES bcp_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (process_id) REFERENCES bcp_processes(id) ON DELETE CASCADE
    );

CREATE TABLE bcp_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      plan_type TEXT DEFAULT 'bcp',
      recovery_steps TEXT,
      key_contacts TEXT,
      alternate_site TEXT,
      status TEXT DEFAULT 'draft',
      last_reviewed_at DATETIME,
      next_review_date DATE,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

CREATE TABLE bcp_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      owner_name TEXT,
      criticality TEXT DEFAULT 'medium',
      max_tolerable_downtime_hours REAL,
      rto_hours REAL,
      rpo_hours REAL,
      dependencies TEXT,
      peak_periods TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE bcp_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      test_type TEXT DEFAULT 'tabletop',
      test_date DATE,
      participants TEXT,
      scenario_description TEXT,
      results TEXT,
      lessons_learned TEXT,
      rto_achieved_hours REAL,
      rpo_achieved_hours REAL,
      pass INTEGER,
      action_items TEXT,
      next_test_date DATE,
      conducted_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES bcp_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (conducted_by) REFERENCES users(id)
    );

CREATE TABLE ccm_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  measured_value TEXT,
  details TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rule_id) REFERENCES ccm_rules(id) ON DELETE CASCADE
);

CREATE TABLE ccm_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  firm_id INTEGER,
  iso_item_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  rule_kind TEXT NOT NULL,
  rule_config TEXT NOT NULL,
  frequency TEXT DEFAULT 'daily',
  is_active INTEGER DEFAULT 1,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cert_cycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    planned_date DATE,
    actual_date DATE,
    status TEXT DEFAULT 'planned',
    certification_body TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE change_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    approver_id INTEGER,
    approver_name TEXT NOT NULL,
    sequence INTEGER DEFAULT 1,
    decision TEXT,
    reason TEXT,
    decided_at DATETIME,
    FOREIGN KEY (change_id) REFERENCES changes(id) ON DELETE CASCADE,
    FOREIGN KEY (approver_id) REFERENCES users(id)
  );

CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    change_type TEXT DEFAULT 'normal',
    category TEXT,
    requester_name TEXT,
    requester_id INTEGER,
    risk_assessment TEXT,
    risk_level TEXT DEFAULT 'medium',
    impact_assessment TEXT,
    rollback_plan TEXT,
    status TEXT DEFAULT 'draft',
    submitted_at DATETIME,
    approved_at DATETIME,
    implemented_at DATETIME,
    closed_at DATETIME,
    implementation_notes TEXT,
    test_results TEXT,
    post_implementation_review TEXT,
    pir_date DATE,
    success INTEGER,
    linked_asset_ids TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (requester_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE comment_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  mentioned_user_id INTEGER NOT NULL,
  read_at DATETIME,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (mentioned_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  parent_type TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  internal_only INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, parent_comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE, has_mentions INTEGER DEFAULT 0,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE communication_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      what TEXT NOT NULL,
      audience TEXT,
      channel TEXT,
      frequency TEXT,
      owner_name TEXT,
      internal_external TEXT DEFAULT 'internal',
      last_sent_date DATE,
      next_due_date DATE,
      trigger_event TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE competence_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      person_name TEXT NOT NULL,
      person_email TEXT,
      competence TEXT NOT NULL,
      evidence_type TEXT,
      evidence_ref TEXT,
      recorded_at DATE,
      expires_on DATE,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES competence_roles(id) ON DELETE CASCADE
    );

CREATE TABLE competence_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      required_competences TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE control_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  compensating_controls TEXT,
  risk_acceptance_id INTEGER NOT NULL REFERENCES risk_acceptances(id),  -- structurally mandatory
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  expiry TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','under_review','expired','closed')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE control_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  entity_id INTEGER REFERENCES entities(id),          -- NULL = whole-org instance
  applicability TEXT NOT NULL DEFAULT 'undecided'
    CHECK (applicability IN ('undecided','applicable','excluded')),
  inclusion_justification TEXT,
  exclusion_justification TEXT,
  status TEXT NOT NULL DEFAULT 'not_assessed',
  maturity INTEGER,
  scope_pct INTEGER,
  notes TEXT,
  internal_notes TEXT,
  local_override_text TEXT,
  owner_id INTEGER REFERENCES users(id),
  due_date TEXT,
  next_review TEXT,
  review_status TEXT DEFAULT 'none',
  last_verified_at TEXT,
  end_dated_at TEXT,
  last_updated TEXT DEFAULT (datetime('now')),
  migrated_from TEXT, review_requested_by INTEGER REFERENCES users(id), review_requested_at TEXT, review_reason TEXT, reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT,
  UNIQUE (workspace_id, requirement_id, entity_id)
);

CREATE TABLE control_state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    iso_item_id TEXT NOT NULL,
    snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    changed_by INTEGER,
    status TEXT,
    applicability TEXT,
    maturity INTEGER,
    scope_pct INTEGER,
    inclusion_justification TEXT,
    exclusion_justification TEXT,
    notes TEXT,
    assessment_answers TEXT, pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (iso_item_id) REFERENCES iso_items(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
  );

CREATE TABLE crisis_comms_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  audience TEXT NOT NULL,
  channel TEXT,
  body TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE csf_ask_lead_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      recipient_id INTEGER,
      subcategory_id INTEGER,
      in_reply_to INTEGER,
      subject TEXT,
      body TEXT NOT NULL,
      read_at DATETIME,
      replied_at DATETIME,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (engagement_id) REFERENCES csf_engagements(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id),
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id),
      FOREIGN KEY (in_reply_to) REFERENCES csf_ask_lead_messages(id)
    );

CREATE TABLE csf_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      function_id INTEGER NOT NULL,
      catalog_version TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      display_order INTEGER NOT NULL,
      UNIQUE (catalog_version, code),
      FOREIGN KEY (function_id) REFERENCES csf_functions(id)
    );

CREATE TABLE csf_client_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_id INTEGER NOT NULL,
      client_user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      read_by_consultant INTEGER DEFAULT 0,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (finding_id) REFERENCES csf_findings(id) ON DELETE CASCADE,
      FOREIGN KEY (client_user_id) REFERENCES users(id)
    );

CREATE TABLE csf_engagement_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_on_engagement TEXT NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_by INTEGER,
      UNIQUE (engagement_id, user_id, role_on_engagement),
      FOREIGN KEY (engagement_id) REFERENCES csf_engagements(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by) REFERENCES users(id)
    );

CREATE TABLE csf_engagement_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id INTEGER NOT NULL,
      version_number TEXT NOT NULL,
      published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      published_by INTEGER,
      change_summary TEXT,
      is_current INTEGER DEFAULT 0,
      UNIQUE (engagement_id, version_number),
      FOREIGN KEY (engagement_id) REFERENCES csf_engagements(id) ON DELETE CASCADE,
      FOREIGN KEY (published_by) REFERENCES users(id)
    );

CREATE TABLE csf_engagements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      catalog_version TEXT NOT NULL,
      name TEXT NOT NULL,
      period_start DATE,
      period_end DATE,
      target_completion_date DATE,
      scope_mode TEXT NOT NULL DEFAULT 'CURRENT_ONLY',
      status TEXT NOT NULL DEFAULT 'Draft',
      assigned_lead_id INTEGER,
      weighting_profile_id INTEGER,
      current_version TEXT,
      visible_in_portal INTEGER DEFAULT 0,
      deleted_at DATETIME,
      deletion_scheduled_at DATETIME,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_lead_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

CREATE TABLE csf_evidence_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      file_path TEXT,
      url TEXT,
      interview_source TEXT,
      description TEXT,
      visible_to_client INTEGER DEFAULT 0,
      deleted_at DATETIME,
      uploaded_by INTEGER NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assessment_id) REFERENCES csf_subcategory_assessments(id) ON DELETE CASCADE
    );

CREATE TABLE csf_finding_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL,
      finding_id INTEGER NOT NULL,
      subcategory_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL,
      status TEXT,
      promoted_to_engagement_theme INTEGER DEFAULT 0,
      FOREIGN KEY (version_id) REFERENCES csf_engagement_versions(id) ON DELETE CASCADE,
      FOREIGN KEY (finding_id) REFERENCES csf_findings(id),
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id)
    );

CREATE TABLE csf_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id INTEGER NOT NULL,
      assessment_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'MEDIUM',
      status TEXT NOT NULL DEFAULT 'Draft',
      promoted_to_engagement_theme INTEGER DEFAULT 0,
      deleted_at DATETIME,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (engagement_id) REFERENCES csf_engagements(id) ON DELETE CASCADE,
      FOREIGN KEY (assessment_id) REFERENCES csf_subcategory_assessments(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

CREATE TABLE csf_functions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_version TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      display_order INTEGER NOT NULL,
      UNIQUE (catalog_version, code)
    );

CREATE TABLE csf_learn_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT,
      body_markdown TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

CREATE TABLE csf_maturity_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_version TEXT NOT NULL,
      level INTEGER NOT NULL,
      name TEXT NOT NULL,
      definition TEXT NOT NULL,
      UNIQUE (catalog_version, level)
    );

CREATE TABLE csf_recommendation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL,
      recommendation_id INTEGER NOT NULL,
      finding_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      estimated_effort TEXT,
      priority TEXT,
      target_completion_date DATE,
      roadmap_phase TEXT,
      FOREIGN KEY (version_id) REFERENCES csf_engagement_versions(id) ON DELETE CASCADE,
      FOREIGN KEY (recommendation_id) REFERENCES csf_recommendations(id),
      FOREIGN KEY (finding_id) REFERENCES csf_findings(id)
    );

CREATE TABLE csf_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      estimated_effort TEXT,
      priority TEXT,
      target_completion_date DATE,
      roadmap_phase TEXT,
      deleted_at DATETIME,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (finding_id) REFERENCES csf_findings(id) ON DELETE CASCADE
    );

CREATE TABLE csf_remediation_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'NOT_STARTED',
      client_evidence_url TEXT,
      client_note TEXT,
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recommendation_id) REFERENCES csf_recommendations(id) ON DELETE CASCADE,
      FOREIGN KEY (updated_by) REFERENCES users(id)
    );

CREATE TABLE csf_reviewer_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id INTEGER NOT NULL,
      assessment_id INTEGER,
      finding_id INTEGER,
      commenter_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      requires_revision INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      resolved_by INTEGER,
      resolved_at DATETIME,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (engagement_id) REFERENCES csf_engagements(id) ON DELETE CASCADE,
      FOREIGN KEY (assessment_id) REFERENCES csf_subcategory_assessments(id) ON DELETE CASCADE,
      FOREIGN KEY (finding_id) REFERENCES csf_findings(id) ON DELETE CASCADE,
      FOREIGN KEY (commenter_id) REFERENCES users(id)
    );

CREATE TABLE csf_self_check_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE csf_subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      catalog_version TEXT NOT NULL,
      code TEXT NOT NULL,
      description TEXT NOT NULL,
      implementation_examples TEXT,
      display_order INTEGER NOT NULL,
      UNIQUE (catalog_version, code),
      FOREIGN KEY (category_id) REFERENCES csf_categories(id)
    );

CREATE TABLE csf_subcategory_assessment_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL,
      subcategory_id INTEGER NOT NULL,
      current_score INTEGER,
      target_score INTEGER,
      narrative TEXT,
      status TEXT,
      is_bulk_set INTEGER DEFAULT 0,
      excluded_from_scope INTEGER DEFAULT 0,
      exclusion_rationale TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      UNIQUE (version_id, subcategory_id),
      FOREIGN KEY (version_id) REFERENCES csf_engagement_versions(id) ON DELETE CASCADE,
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id)
    );

CREATE TABLE csf_subcategory_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id INTEGER NOT NULL,
      subcategory_id INTEGER NOT NULL,
      current_score INTEGER,
      target_score INTEGER,
      narrative TEXT,
      status TEXT NOT NULL DEFAULT 'Not Started',
      is_bulk_set INTEGER DEFAULT 0,
      excluded_from_scope INTEGER DEFAULT 0,
      exclusion_rationale TEXT,
      evidence_collected_by INTEGER,
      evidence_collected_at DATETIME,
      narrative_drafted_by INTEGER,
      narrative_drafted_at DATETIME,
      scored_by INTEGER,
      scored_at DATETIME,
      reviewed_by INTEGER,
      reviewed_at DATETIME,
      last_edited_by INTEGER,
      last_edited_at DATETIME,
      locked_by_user_id INTEGER,
      locked_at DATETIME,
      UNIQUE (engagement_id, subcategory_id),
      FOREIGN KEY (engagement_id) REFERENCES csf_engagements(id) ON DELETE CASCADE,
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id)
    );

CREATE TABLE csf_subcategory_evidence_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subcategory_id INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      evidence_type TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id) ON DELETE CASCADE
    );

CREATE TABLE csf_subcategory_explainers (
      subcategory_id INTEGER PRIMARY KEY,
      plain_what TEXT,
      plain_why TEXT,
      signs_of_strength TEXT,
      signs_of_weakness TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id) ON DELETE CASCADE
    );

CREATE TABLE csf_subcategory_iso_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subcategory_id INTEGER NOT NULL,
      ref_type TEXT NOT NULL,
      ref_value TEXT NOT NULL,
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id) ON DELETE CASCADE
    );

CREATE TABLE csf_subcategory_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subcategory_id INTEGER NOT NULL,
      question_type TEXT NOT NULL,
      question TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id) ON DELETE CASCADE
    );

CREATE TABLE csf_tier_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_version TEXT NOT NULL,
      tier INTEGER NOT NULL,
      name TEXT NOT NULL,
      cmmi_lower REAL NOT NULL,
      cmmi_upper REAL NOT NULL,
      UNIQUE (catalog_version, tier)
    );

CREATE TABLE csf_weighting_profile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      subcategory_id INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      UNIQUE (profile_id, subcategory_id),
      FOREIGN KEY (profile_id) REFERENCES csf_weighting_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (subcategory_id) REFERENCES csf_subcategories(id)
    );

CREATE TABLE csf_weighting_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id INTEGER,
      workspace_id INTEGER,
      name TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (engagement_id) REFERENCES csf_engagements(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE custom_field_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options TEXT,
  required INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, entity_type, field_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE custom_field_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_def_id INTEGER NOT NULL,
  value TEXT,
  UNIQUE(entity_type, entity_id, field_def_id),
  FOREIGN KEY (field_def_id) REFERENCES custom_field_defs(id) ON DELETE CASCADE
);

CREATE TABLE dashboard_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  widget_key TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  config TEXT,
  UNIQUE(workspace_id, user_id, widget_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE doc_ack_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status TEXT DEFAULT 'active',
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE
);

CREATE TABLE doc_ack_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT,
  recipient_role TEXT,
  token TEXT UNIQUE NOT NULL,
  acknowledged_at DATETIME,
  signature_id INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  reminded_count INTEGER DEFAULT 0,
  last_reminded_at DATETIME,
  FOREIGN KEY (campaign_id) REFERENCES doc_ack_campaigns(id) ON DELETE CASCADE
);

CREATE TABLE doc_approvers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_label TEXT,
  decision TEXT,
  decision_reason TEXT,
  decided_at DATETIME,
  notified_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES doc_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE doc_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  signature_role TEXT,
  intent TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES doc_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE doc_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  content TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, tier TEXT DEFAULT 'recommended', controls TEXT, clauses TEXT,
  FOREIGN KEY (firm_id) REFERENCES firms(id)
);

CREATE TABLE doc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  change_summary TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  submitted_at DATETIME,
  approved_at DATETIME,
  published_at DATETIME,
  retired_at DATETIME,
  UNIQUE(document_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE document_requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES generated_docs(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  section_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (document_id, requirement_id)
);

CREATE TABLE dpias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_id INTEGER,
  title TEXT NOT NULL,
  processing_description TEXT,
  data_categories TEXT,
  data_subjects TEXT,
  lawful_basis TEXT,
  necessity_test TEXT,
  proportionality_test TEXT,
  data_flows TEXT,
  retention_period TEXT,
  international_transfers TEXT,
  consultations TEXT,
  identified_risks TEXT,
  mitigations TEXT,
  residual_risk_level TEXT,
  outcome TEXT,
  approver TEXT,
  approver_signature TEXT,
  approved_at DATETIME,
  status TEXT DEFAULT 'draft',
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  workspace_id INTEGER,
  to_email TEXT NOT NULL,
  from_email TEXT,
  subject TEXT NOT NULL,
  body_html TEXT,
  body_text TEXT,
  related_type TEXT,
  related_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT,
  provider_message_id TEXT,
  error_message TEXT,
  sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE TABLE engagement_intake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT,
    answered_by INTEGER,
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, question_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE engagement_plan_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    milestone_id TEXT NOT NULL,
    completed_at DATETIME,
    target_date DATE,
    notes TEXT,
    UNIQUE(workspace_id, milestone_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  entity_type TEXT DEFAULT 'business_unit',
  region TEXT,
  scope_statement TEXT,
  contact TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, attributes TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  iso_item_id TEXT,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER NOT NULL,
  description TEXT,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, retention_until DATE, retention_rule_id INTEGER, valid_from DATE, valid_until DATE, period_label TEXT, clause_section TEXT, supersedes_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL, superseded_at TEXT, superseded_by_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL, tags TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE evidence_requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  relevance_note TEXT,
  section_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (evidence_id, requirement_id)
);

CREATE TABLE external_approvers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role_label TEXT,
  token_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  decision TEXT,
  decision_reason TEXT,
  decided_at DATETIME,
  ip_address TEXT,
  user_agent TEXT,
  notified_at DATETIME,
  revoked_at DATETIME,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES doc_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE external_assessment_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id INTEGER REFERENCES assessments(id) ON DELETE CASCADE,
  entity_id INTEGER REFERENCES entities(id),          -- the supplier / external entity
  email TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  issued_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  revoked_at TEXT,
  created_by INTEGER REFERENCES users(id),
  migrated_from TEXT,
  UNIQUE (token_hash)
);

CREATE TABLE feature_flags (
  key TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE finding_controls (
  finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  PRIMARY KEY (finding_id, instance_id)
);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('assessment','audit','incident','risk','manual','migration')),
  source_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  severity_scheme TEXT NOT NULL DEFAULT 'hml',     -- 'hml' | 'nc' | custom (per-source / per-row)
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('draft','open','in_remediation','verified','closed','accepted_risk')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);

CREATE TABLE firm_email_settings (
  firm_id INTEGER PRIMARY KEY,
  from_name TEXT,
  from_email TEXT,
  reply_to TEXT,
  enabled INTEGER DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE firm_recommendation_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL,
  domain TEXT, default_effort TEXT, tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE firm_risk_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firm_id INTEGER NOT NULL,
    code TEXT,
    title TEXT NOT NULL,
    description TEXT,
    threat TEXT,
    vulnerability TEXT,
    suggested_likelihood INTEGER,
    suggested_impact INTEGER,
    suggested_treatment TEXT,
    suggested_controls TEXT,  -- comma-separated iso_item ids
    domain TEXT,
    sector TEXT,              -- optional: "SaaS", "Healthcare", etc.
    tags TEXT,                -- comma-separated free-form tags
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
  );

CREATE TABLE firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE framework_mappings (
  iso_item_id TEXT NOT NULL,
  framework TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  notes TEXT,
  PRIMARY KEY (iso_item_id, framework, external_ref)
);

CREATE TABLE frameworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','transitional','retired')),
  is_canonical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (code, version)
);

CREATE TABLE generated_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  template_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  content TEXT,
  status TEXT DEFAULT 'draft',
  version INTEGER DEFAULT 1,
  approved_by INTEGER,
  approved_at DATETIME,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, locked INTEGER DEFAULT 0, retired_at DATETIME, published_at DATETIME, approval_due DATETIME, review_period_months INTEGER DEFAULT 12, next_review_date DATE, current_version_id INTEGER REFERENCES doc_versions(id) ON DELETE SET NULL, parent_doc_id INTEGER REFERENCES generated_docs(id) ON DELETE SET NULL, doc_kind TEXT, reference_code TEXT, controlled_copy INTEGER DEFAULT 0, source_filename TEXT, source_stored_path TEXT, source_mime TEXT, source_size_bytes INTEGER, source_sha256 TEXT, requires_training INTEGER DEFAULT 0, training_audience TEXT, watermark TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES doc_templates(id)
);

CREATE TABLE improvements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source TEXT,                  -- audit / mrm / monitoring / ad-hoc
    source_ref TEXT,              -- optional reference to source artefact
    owner_name TEXT,
    due_date DATE,
    status TEXT DEFAULT 'open',   -- open / in_progress / done / cancelled
    closed_at DATETIME,
    impact_notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  incident_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  event_at DATETIME NOT NULL,
  description TEXT,
  actor TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  severity TEXT DEFAULT 'medium',
  detected_at DATETIME,
  reported_by TEXT,
  status TEXT DEFAULT 'open',
  description TEXT,
  affected_assets TEXT,
  containment_actions TEXT,
  eradication_actions TEXT,
  recovery_actions TEXT,
  lessons_learned TEXT,
  external_notification TEXT,
  nonconformity_id INTEGER,
  closed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, notification_required_by DATETIME, notification_sent_at DATETIME, pir_completed INTEGER DEFAULT 0, pir_summary TEXT, is_tabletop INTEGER DEFAULT 0, runbook_id INTEGER, contained_at DATETIME, eradicated_at DATETIME, recovered_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE interested_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    party TEXT NOT NULL,
    party_type TEXT,
    needs TEXT,
    how_addressed TEXT,
    owner TEXT,
    review_cadence TEXT,
    last_reviewed TEXT,
    next_review TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE isms_metric_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_id INTEGER NOT NULL,
    value REAL NOT NULL,
    measured_at DATE NOT NULL,
    status TEXT,
    notes TEXT,
    recorded_by INTEGER,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (metric_id) REFERENCES isms_metrics(id) ON DELETE CASCADE,
    FOREIGN KEY (recorded_by) REFERENCES users(id)
  );

CREATE TABLE isms_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    metric_key TEXT NOT NULL,
    ref TEXT,
    name TEXT NOT NULL,
    category TEXT,
    unit TEXT,
    direction TEXT DEFAULT 'higher',
    formula TEXT,
    target_value REAL,
    target_text TEXT,
    frequency TEXT,
    owner_name TEXT,
    notes TEXT,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, metric_key),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE iso42001_assessment_passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      pass_number INTEGER NOT NULL,
      name TEXT,
      started_by INTEGER,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT DEFAULT 'open',
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (started_by) REFERENCES users(id)
    );

CREATE TABLE iso42001_cert_cycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      planned_date DATE,
      actual_date DATE,
      status TEXT DEFAULT 'planned',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE iso42001_control_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      iso_item_id TEXT NOT NULL,
      pass_id INTEGER,
      changed_by INTEGER,
      snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT,
      applicability TEXT,
      maturity INTEGER,
      inclusion_justification TEXT,
      exclusion_justification TEXT,
      notes TEXT,
      assessment_answers TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (pass_id) REFERENCES iso42001_assessment_passes(id) ON DELETE SET NULL,
      FOREIGN KEY (changed_by) REFERENCES users(id)
    );

CREATE TABLE iso42001_engagement_plan_progress (
      workspace_id INTEGER NOT NULL,
      phase_key TEXT NOT NULL,
      completed_at DATETIME,
      completed_by INTEGER,
      notes TEXT,
      PRIMARY KEY (workspace_id, phase_key),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (completed_by) REFERENCES users(id)
    );

CREATE TABLE iso42001_intake_answers (
      workspace_id INTEGER NOT NULL,
      question_key TEXT NOT NULL,
      answer TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, question_key),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE iso42001_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      questions TEXT,
      evidence_needed TEXT,
      documentation_needed TEXT,
      sort_order INTEGER
    , purpose TEXT, what_good_looks_like TEXT, common_pitfalls TEXT, evidence_to_look_for TEXT, scoping_notes TEXT, maturity_ladder TEXT, related_items TEXT);

CREATE TABLE iso42001_risk_controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      risk_id INTEGER NOT NULL,
      iso_item_id TEXT NOT NULL,
      UNIQUE(risk_id, iso_item_id),
      FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE,
      FOREIGN KEY (iso_item_id) REFERENCES iso42001_items(id) ON DELETE CASCADE
    );

CREATE TABLE iso42001_soa_custom_controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT,
      summary TEXT,
      applicability TEXT DEFAULT 'included',
      inclusion_justification TEXT,
      exclusion_justification TEXT,
      status TEXT DEFAULT 'Not Assessed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE iso42001_soa_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      label TEXT,
      reason TEXT,
      version TEXT,
      owner TEXT,
      approved_by TEXT,
      approved_at DATE,
      payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      control_count INTEGER,
      included_count INTEGER,
      excluded_count INTEGER,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

CREATE TABLE iso_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  questions TEXT,
  evidence_needed TEXT,
  documentation_needed TEXT,
  sort_order INTEGER
, purpose TEXT, what_good_looks_like TEXT, common_pitfalls TEXT, evidence_to_look_for TEXT, scoping_notes TEXT, maturity_ladder TEXT, related_items TEXT, minimum_certifiable TEXT);

CREATE TABLE key_rotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prev_key_fp TEXT NOT NULL,
  new_key_fp TEXT NOT NULL,
  rotated_by INTEGER,
  rows_reencrypted INTEGER,
  status TEXT NOT NULL,
  notes TEXT,
  rotated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE kri_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kri_id INTEGER NOT NULL,
  value REAL NOT NULL,
  measured_at DATE NOT NULL,
  notes TEXT,
  recorded_by INTEGER,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (kri_id) REFERENCES kris(id) ON DELETE CASCADE
);

CREATE TABLE kris (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  risk_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  green_max REAL,
  amber_max REAL,
  red_above_amber INTEGER DEFAULT 1,
  measurement_frequency TEXT DEFAULT 'monthly',
  owner_name TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE SET NULL
);

CREATE TABLE member_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('control','risk','asset','document')),
      scope_id TEXT NOT NULL,
      granted_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, user_id, scope_type, scope_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id)
    );

CREATE TABLE migration_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT,
  reason TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution_note TEXT
);

CREATE TABLE mrms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  meeting_date DATE,
  attendees TEXT,
  status TEXT DEFAULT 'planned',
  context_changes TEXT,
  prior_actions_status TEXT,
  performance_review TEXT,
  feedback_interested_parties TEXT,
  risk_treatment_status TEXT,
  improvement_opportunities TEXT,
  decisions TEXT,
  action_items TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE nonconformities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  source_ref TEXT,
  description TEXT,
  severity TEXT DEFAULT 'minor',
  iso_item_id TEXT,
  root_cause TEXT,
  corrective_action TEXT,
  responsible TEXT,
  due_date DATE,
  effectiveness_check TEXT,
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE notification_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(notification_id, user_id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  user_id INTEGER,
  category TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at DATETIME,
  dismissed_at DATETIME,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE onboarding_progress (
  workspace_id INTEGER PRIMARY KEY,
  step_workspace INTEGER DEFAULT 0,
  step_scope INTEGER DEFAULT 0,
  step_assets INTEGER DEFAULT 0,
  step_risk INTEGER DEFAULT 0,
  step_methodology INTEGER DEFAULT 0,
  step_policies INTEGER DEFAULT 0,
  step_team INTEGER DEFAULT 0,
  step_supplier INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      requested_ip TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

CREATE TABLE permission_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE phishing_simulations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  campaign_date DATE,
  recipients_count INTEGER,
  clicked_count INTEGER,
  reported_count INTEGER,
  credentials_entered_count INTEGER,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE proposed_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  proposed_status TEXT,
  proposed_maturity INTEGER,
  source TEXT NOT NULL CHECK (source IN
    ('assessment','audit','remediation','evidence','external_respondent','ai_suggestion')),
  source_ref TEXT,
  rationale TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id),
  decision TEXT CHECK (decision IN ('accepted','rejected','superseded')),
  decided_at TEXT
);

CREATE TABLE question_requirement_map (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  PRIMARY KEY (question_id, requirement_id)
);

CREATE TABLE question_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER REFERENCES firms(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  scoring_model_id INTEGER REFERENCES scoring_models(id),
  target_entity_type TEXT,
  created_at TEXT DEFAULT (datetime('now')), cloned_from INTEGER REFERENCES question_sets(id),
  UNIQUE (firm_id, name, version)
);

CREATE TABLE questionnaire_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    questionnaire_id INTEGER NOT NULL,
    question_id INTEGER,
    workspace_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    source TEXT DEFAULT 'vendor',     -- vendor / consultant
    uploaded_by INTEGER,              -- users.id when source='consultant', else NULL
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (questionnaire_id) REFERENCES supplier_questionnaires(id) ON DELETE CASCADE
  );

CREATE TABLE questionnaire_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  question_order INTEGER,
  section TEXT,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'yes_no',
  options TEXT,
  weight INTEGER DEFAULT 1,
  expected_answer TEXT,
  iso_control_ref TEXT,
  FOREIGN KEY (template_id) REFERENCES questionnaire_templates(id) ON DELETE CASCADE
);

CREATE TABLE questionnaire_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER DEFAULT 0,
  category TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,                          -- 'A.5.19:q2' survives reordering
  ordinal INTEGER NOT NULL,
  section TEXT,
  text TEXT NOT NULL,
  answer_type TEXT NOT NULL DEFAULT 'single_select'
    CHECK (answer_type IN ('single_select','multi_select','yes_no','free_text','evidence_required','na_with_justification')),
  options TEXT,                                      -- JSON
  weight REAL DEFAULT 1.0,
  expected_answer TEXT,
  guidance TEXT,
  conditional_on TEXT, tags TEXT,                               -- JSON
  UNIQUE (question_set_id, stable_key)
);

CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_id INTEGER REFERENCES findings(id) ON DELETE CASCADE,
  library_id INTEGER REFERENCES firm_recommendation_library(id),
  text TEXT NOT NULL,
  priority TEXT, effort_estimate TEXT,
  client_decision TEXT CHECK (client_decision IN ('accepted','rejected','deferred')),
  decided_at TEXT, decision_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);

CREATE TABLE remediation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_id INTEGER REFERENCES findings(id),
  recommendation_id INTEGER REFERENCES recommendations(id),
  title TEXT NOT NULL, description TEXT,
  owner_kind TEXT CHECK (owner_kind IN ('consultant','client')),
  owner_user_id INTEGER REFERENCES users(id), owner_name TEXT,
  roadmap_phase_id INTEGER REFERENCES roadmap_phases(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','done_unverified','verified','closed','cancelled')),
  verification_evidence_id INTEGER REFERENCES evidence(id),
  verified_by INTEGER REFERENCES users(id), verified_at TEXT,
  closed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);

CREATE TABLE report_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  body TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE requirement_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  mapped_requirement_id    INTEGER NOT NULL REFERENCES requirements(id),
  coverage TEXT NOT NULL CHECK (coverage IN ('full','partial','supporting')),
  residual_gap_note TEXT,
  mapped_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (canonical_requirement_id, mapped_requirement_id)
);

CREATE TABLE requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_id INTEGER NOT NULL REFERENCES frameworks(id),
  ref TEXT NOT NULL,
  parent_ref TEXT,
  req_type TEXT NOT NULL
    CHECK (req_type IN ('clause','control','function','category','subcategory')),
  title TEXT NOT NULL,
  summary TEXT,
  guidance TEXT,                 -- JSON
  sort_order INTEGER,
  UNIQUE (framework_id, ref)
);

CREATE TABLE response_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer TEXT,
  assessor_note TEXT,
  weight REAL DEFAULT 1.0,
  UNIQUE (version_id, question_id)
);

CREATE TABLE responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer TEXT,
  assessor_note TEXT,
  respondent_id INTEGER REFERENCES users(id),
  respondent_kind TEXT NOT NULL DEFAULT 'consultant'
    CHECK (respondent_kind IN ('consultant','client','external')),
  raw_source TEXT,                                   -- original JSON fragment (drop post-cleanup)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (assessment_id, question_id)
);

CREATE TABLE retention_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  applies_to TEXT NOT NULL,
  pattern TEXT,
  retain_years INTEGER NOT NULL,
  reason TEXT,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE risk_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  risk_id INTEGER NOT NULL,
  accepter_name TEXT NOT NULL,
  accepter_role TEXT,
  accepter_user_id INTEGER,
  rationale TEXT NOT NULL,
  residual_score INTEGER,
  expires_at DATE,
  signature TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE
);

CREATE TABLE risk_appetites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL UNIQUE,
  statement TEXT,
  appetite_low_max REAL,
  appetite_med_max REAL,
  auto_accept_below INTEGER DEFAULT 0,
  approver_role TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE risk_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  risk_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  UNIQUE(risk_id, iso_item_id),
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
);

CREATE TABLE risk_methodologies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  likelihood_scale TEXT NOT NULL,
  impact_scale TEXT NOT NULL,
  matrix TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE risk_treatment_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    risk_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    owner_name TEXT,
    due_date DATE,
    status TEXT DEFAULT 'planned',
    residual_likelihood INTEGER,
    residual_impact INTEGER,
    closed_at DATETIME,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE risk_treatments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  risk_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  owner_name TEXT,
  owner_id INTEGER,
  due_date DATE,
  completed_date DATE,
  status TEXT DEFAULT 'planned',
  cost_estimate TEXT,
  expected_residual_l INTEGER,
  expected_residual_i INTEGER,
  iso_item_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE
);

CREATE TABLE risks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  asset_id INTEGER,
  threat TEXT,
  vulnerability TEXT,
  likelihood INTEGER DEFAULT 3,
  impact INTEGER DEFAULT 3,
  treatment TEXT DEFAULT 'modify',
  owner_name TEXT,
  status TEXT DEFAULT 'open',
  residual_likelihood INTEGER,
  residual_impact INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, is_systemic INTEGER DEFAULT 0, is_dpia INTEGER DEFAULT 0, accepted_until DATE, last_acceptance_id INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE roadmap_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort_order INTEGER, target_date TEXT
);

CREATE TABLE runbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  trigger_severity TEXT,
  trigger_category TEXT,
  steps TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now')),
    checksum TEXT
  );

CREATE TABLE scoring_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER REFERENCES firms(id),              -- NULL = system
  name TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('conformity','maturity','weighted_risk')),
  scale_def TEXT NOT NULL,                           -- JSON
  rollup_rules TEXT NOT NULL,                        -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE search_index USING fts5(
  workspace_id UNINDEXED, entity_type UNINDEXED, entity_id UNINDEXED,
  title, body
);

CREATE TABLE 'search_index_config'(k PRIMARY KEY, v) WITHOUT ROWID;

CREATE TABLE 'search_index_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4);

CREATE TABLE 'search_index_data'(id INTEGER PRIMARY KEY, block BLOB);

CREATE TABLE 'search_index_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

CREATE TABLE 'search_index_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

CREATE TABLE security_objectives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    measurement TEXT,
    target_value TEXT,
    current_value TEXT,
    owner TEXT,
    due_date TEXT,
    status TEXT DEFAULT 'on_track',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE soa_custom_controls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source_framework TEXT,
    applicability TEXT DEFAULT 'included',
    inclusion_justification TEXT,
    exclusion_justification TEXT,
    status TEXT DEFAULT 'Not Assessed',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE soa_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_id INTEGER,
  label TEXT,
  reason TEXT,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  control_count INTEGER,
  included_count INTEGER,
  excluded_count INTEGER,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, version TEXT, owner TEXT, approved_by TEXT, approved_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE supplier_clauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  clause_key TEXT NOT NULL,
  clause_label TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  notes TEXT,
  reviewed_at DATETIME,
  UNIQUE(supplier_id, clause_key),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, iso_item_id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
);

CREATE TABLE supplier_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  doc_type TEXT,
  name TEXT NOT NULL,
  filename TEXT,
  stored_path TEXT,
  sha256 TEXT,
  size_bytes INTEGER,
  effective_date DATE,
  expiry_date DATE,
  notes TEXT,
  uploaded_by INTEGER,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_monitoring (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  source TEXT,
  score REAL,
  grade TEXT,
  recorded_at DATE NOT NULL,
  notes TEXT,
  recorded_by INTEGER,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  user_name TEXT,
  body TEXT,
  internal_only INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_questionnaire_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer TEXT,
  comment TEXT,
  evidence_ref TEXT,
  UNIQUE(questionnaire_id, question_id),
  FOREIGN KEY (questionnaire_id) REFERENCES supplier_questionnaires(id) ON DELETE CASCADE
);

CREATE TABLE supplier_questionnaires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  template_name TEXT,
  status TEXT DEFAULT 'draft',
  sent_at DATETIME,
  responded_at DATETIME,
  reviewed_at DATETIME,
  reviewer TEXT,
  total_questions INTEGER DEFAULT 0,
  answered_questions INTEGER DEFAULT 0,
  score INTEGER,
  risk_rating TEXT,
  reviewer_comments TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, external_token TEXT, external_email TEXT, external_completed_at DATETIME, external_expires_at DATETIME,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES questionnaire_templates(id)
);

CREATE TABLE supplier_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  review_date DATE,
  reviewer TEXT,
  outcome TEXT,
  inherent_risk INTEGER,
  residual_risk INTEGER,
  findings TEXT,
  action_items TEXT,
  next_review_date DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_subprocessors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  service_provided TEXT,
  data_access TEXT,
  location TEXT,
  approved INTEGER DEFAULT 0,
  approved_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_termination_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  done_at DATETIME,
  evidence TEXT,
  notes TEXT,
  UNIQUE(supplier_id, item_key),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  service_provided TEXT,
  tier TEXT DEFAULT 'tier_2',
  data_access TEXT DEFAULT 'none',
  contract_start DATE,
  contract_end DATE,
  next_review_date DATE,
  attestations TEXT,
  contact TEXT,
  notes TEXT,
  status TEXT DEFAULT 'active',
  last_assessed DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, termination_started_at DATETIME, termination_owner TEXT, lifecycle_stage TEXT DEFAULT 'active', inherent_risk_score INTEGER, residual_risk_score INTEGER, business_criticality TEXT DEFAULT 'medium', data_volume TEXT DEFAULT 'low', industry TEXT, location TEXT, parent_company TEXT, regulatory_exposure TEXT, dependency_type TEXT DEFAULT 'multi_source', annual_spend TEXT, renewal_notice_days INTEGER, auto_renew INTEGER DEFAULT 0, approved_by TEXT, approved_at DATETIME, terminated_at DATETIME, data_return_completed INTEGER DEFAULT 0, website TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE task_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  is_system INTEGER DEFAULT 0,
  steps TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  iso_item_id TEXT,
  risk_id INTEGER,
  assignee_id INTEGER,
  due_date DATE,
  status TEXT DEFAULT 'todo',
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, recurrence TEXT, recurrence_until DATE, depends_on_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, estimated_minutes INTEGER, template_id INTEGER REFERENCES task_templates(id) ON DELETE SET NULL, nonconformity_id INTEGER REFERENCES nonconformities(id) ON DELETE SET NULL, priority TEXT DEFAULT 'normal',
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE SET NULL
);

CREATE TABLE tenant_onboarding (
    firm_id INTEGER PRIMARY KEY,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    current_step INTEGER DEFAULT 1,
    skipped INTEGER DEFAULT 0,
    FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
  );

CREATE TABLE time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  task_id INTEGER,
  date DATE NOT NULL,
  minutes INTEGER NOT NULL,
  description TEXT,
  billable INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE training_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER,
  validity_months INTEGER DEFAULT 12,
  required_for_roles TEXT,
  content_url TEXT,
  has_quiz INTEGER DEFAULT 0,
  passing_score INTEGER,
  iso_control_ref TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE training_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  user_role TEXT,
  training_name TEXT NOT NULL,
  assigned_date DATE,
  due_date DATE,
  completed_date DATE,
  score TEXT,
  status TEXT DEFAULT 'assigned',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, source_doc_id INTEGER REFERENCES generated_docs(id) ON DELETE SET NULL, course_id INTEGER REFERENCES training_courses(id) ON DELETE SET NULL, attestation_signed_at DATETIME, attestation_ip TEXT, quiz_score INTEGER, expiry_date DATE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE user_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT,
      firm_id INTEGER NOT NULL,
      user_type TEXT NOT NULL CHECK(user_type IN ('firm','client')),
      firm_role TEXT,
      workspace_id INTEGER,
      workspace_role TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME,
      accepted_user_id INTEGER,
      revoked_at DATETIME,
      invited_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (firm_id) REFERENCES firms(id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (accepted_user_id) REFERENCES users(id),
      FOREIGN KEY (invited_by) REFERENCES users(id)
    );

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  user_type TEXT NOT NULL CHECK(user_type IN ('firm','client')),
  firm_id INTEGER,
  firm_role TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_active_at DATETIME, locale TEXT DEFAULT 'en', idp_subject TEXT, idp_kind TEXT, email_notify TEXT DEFAULT 'immediate',
  FOREIGN KEY (firm_id) REFERENCES firms(id)
);

CREATE TABLE workspace_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE workspace_role_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  granted_by INTEGER,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME,
  UNIQUE(workspace_id, user_id, permission),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL,
  client_name TEXT NOT NULL,
  industry TEXT,
  scope TEXT,
  target_cert_date DATE,
  stage TEXT DEFAULT 'gap_assessment',
  lead_consultant_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, encryption_enabled INTEGER DEFAULT 1, monthly_plan TEXT, scope_confirmed_at DATETIME, scope_confirmed_by INTEGER REFERENCES users(id), updated_at DATETIME, brand_display_name TEXT, brand_primary_color TEXT, brand_logo_path TEXT, sector TEXT, locale TEXT DEFAULT 'en', frameworks TEXT DEFAULT '["iso27001","iso42001","csf"]',
  FOREIGN KEY (firm_id) REFERENCES firms(id),
  FOREIGN KEY (lead_consultant_id) REFERENCES users(id)
);

-- ============================================================
-- INDEXES (130)
-- ============================================================

CREATE INDEX idx_ack_campaign ON doc_ack_recipients(campaign_id);

CREATE INDEX idx_api_tokens ON api_tokens(workspace_id, user_id);

CREATE INDEX idx_assessments_ws ON assessments(workspace_id, status);

CREATE INDEX idx_asset_rels ON asset_relationships(parent_asset_id, child_asset_id);

CREATE INDEX idx_assets_workspace ON assets(workspace_id);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE INDEX idx_audit_user_action ON audit_log(user_id, action);

CREATE INDEX idx_audit_workspace ON audit_log(workspace_id);

CREATE INDEX idx_auditor_shares_token ON auditor_shares(token);

CREATE INDEX idx_auditor_shares_ws ON auditor_shares(workspace_id);

CREATE INDEX idx_audits_workspace ON audits(workspace_id);

CREATE INDEX idx_audsamp_audit ON audit_samples(audit_id);

CREATE INDEX idx_av_assessment ON assessment_versions(assessment_id);

CREATE INDEX idx_bcp_plan_ws ON bcp_plans(workspace_id);

CREATE INDEX idx_bcp_proc_ws ON bcp_processes(workspace_id);

CREATE INDEX idx_bcp_test_plan ON bcp_tests(plan_id);

CREATE INDEX idx_bcp_test_ws ON bcp_tests(workspace_id);

CREATE INDEX idx_ccev_workspace ON cert_cycle_events(workspace_id, planned_date);

CREATE INDEX idx_ccm_results ON ccm_results(rule_id, ran_at);

CREATE INDEX idx_cfv ON custom_field_values(entity_type, entity_id);

CREATE INDEX idx_chain_log ON audit_chain(audit_log_id);

CREATE INDEX idx_change_approvals ON change_approvals(change_id);

CREATE INDEX idx_changes_ws ON changes(workspace_id);

CREATE INDEX idx_ci_req ON control_instances(requirement_id);

CREATE UNIQUE INDEX idx_ci_wholeorg
  ON control_instances(workspace_id, requirement_id) WHERE entity_id IS NULL;

CREATE INDEX idx_ci_ws ON control_instances(workspace_id);

CREATE INDEX idx_comments_parent ON comments(workspace_id, parent_type, parent_id);

CREATE INDEX idx_communication_plan_ws ON communication_plan(workspace_id, next_due_date);

CREATE INDEX idx_competence_records_ws ON competence_records(workspace_id, role_id);

CREATE INDEX idx_competence_roles_ws ON competence_roles(workspace_id);

CREATE INDEX idx_csf_aml_eng ON csf_ask_lead_messages(engagement_id);

CREATE INDEX idx_csf_aml_recipient ON csf_ask_lead_messages(recipient_id, read_at);

CREATE INDEX idx_csf_assess_eng ON csf_subcategory_assessments(engagement_id);

CREATE INDEX idx_csf_assess_snap_ver ON csf_subcategory_assessment_snapshots(version_id);

CREATE INDEX idx_csf_assess_status ON csf_subcategory_assessments(status);

CREATE INDEX idx_csf_assign_eng ON csf_engagement_assignments(engagement_id);

CREATE INDEX idx_csf_assign_user ON csf_engagement_assignments(user_id);

CREATE INDEX idx_csf_cats_fn ON csf_categories(function_id);

CREATE INDEX idx_csf_cc_finding ON csf_client_comments(finding_id);

CREATE INDEX idx_csf_eng_status ON csf_engagements(status);

CREATE INDEX idx_csf_eng_ws ON csf_engagements(workspace_id);

CREATE INDEX idx_csf_ep_sub ON csf_subcategory_evidence_prompts(subcategory_id);

CREATE INDEX idx_csf_ev_assess ON csf_evidence_items(assessment_id);

CREATE INDEX idx_csf_ev_eng ON csf_engagement_versions(engagement_id);

CREATE INDEX idx_csf_finding_snap_ver ON csf_finding_snapshots(version_id);

CREATE INDEX idx_csf_findings_assess ON csf_findings(assessment_id);

CREATE INDEX idx_csf_findings_eng ON csf_findings(engagement_id);

CREATE INDEX idx_csf_iso_refs_sub ON csf_subcategory_iso_refs(subcategory_id);

CREATE INDEX idx_csf_q_sub ON csf_subcategory_questions(subcategory_id);

CREATE INDEX idx_csf_rc_assess ON csf_reviewer_comments(assessment_id);

CREATE INDEX idx_csf_rc_finding ON csf_reviewer_comments(finding_id);

CREATE INDEX idx_csf_rec_snap_ver ON csf_recommendation_snapshots(version_id);

CREATE INDEX idx_csf_recs_finding ON csf_recommendations(finding_id);

CREATE INDEX idx_csf_subs_cat ON csf_subcategories(category_id);

CREATE INDEX idx_csf_wpi_profile ON csf_weighting_profile_items(profile_id);

CREATE INDEX idx_csh_ws_item ON control_state_history(workspace_id, iso_item_id, snapshot_at DESC);

CREATE INDEX idx_doc_approvers ON doc_approvers(document_id, version_id, sequence);

CREATE INDEX idx_doc_sig_doc ON doc_signatures(document_id, version_id);

CREATE INDEX idx_doc_versions_doc ON doc_versions(document_id);

CREATE INDEX idx_docreq_doc ON document_requirement_links(document_id);

CREATE INDEX idx_docreq_req ON document_requirement_links(requirement_id);

CREATE INDEX idx_docs_workspace ON generated_docs(workspace_id);

CREATE INDEX idx_email_outbox_firm ON email_outbox(firm_id, created_at DESC);

CREATE INDEX idx_email_outbox_workspace ON email_outbox(workspace_id, created_at DESC);

CREATE INDEX idx_entities_workspace ON entities(workspace_id);

CREATE INDEX idx_evidence_workspace ON evidence(workspace_id);

CREATE INDEX idx_evreq_ev ON evidence_requirement_links(evidence_id);

CREATE INDEX idx_evreq_req ON evidence_requirement_links(requirement_id);

CREATE INDEX idx_exceptions_ws ON control_exceptions(workspace_id, expiry);

CREATE INDEX idx_external_approvers_token ON external_approvers(token_hash);

CREATE INDEX idx_external_approvers_version ON external_approvers(version_id, sequence);

CREATE INDEX idx_extok_assessment ON external_assessment_tokens(assessment_id);

CREATE INDEX idx_extok_ws ON external_assessment_tokens(workspace_id, expires_at);

CREATE UNIQUE INDEX idx_feature_flags_global
  ON feature_flags(key) WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX idx_feature_flags_ws
  ON feature_flags(key, workspace_id) WHERE workspace_id IS NOT NULL;

CREATE INDEX idx_findings_audit ON audit_findings(audit_id);

CREATE INDEX idx_findings_ws ON findings(workspace_id, status);

CREATE INDEX idx_imp_ws ON improvements(workspace_id, status);

CREATE INDEX idx_inc_events ON incident_events(incident_id);

CREATE INDEX idx_incidents_workspace ON incidents(workspace_id);

CREATE INDEX idx_ip_ws ON interested_parties(workspace_id);

CREATE INDEX idx_isms_metric_readings ON isms_metric_readings(metric_id, measured_at);

CREATE INDEX idx_isms_metrics_ws ON isms_metrics(workspace_id);

CREATE INDEX idx_iso42001_ccev_workspace ON iso42001_cert_cycle_events(workspace_id, planned_date);

CREATE INDEX idx_iso42001_csh_ws_item ON iso42001_control_state_history(workspace_id, iso_item_id, snapshot_at DESC);

CREATE UNIQUE INDEX idx_iso42001_passes_ws_num ON iso42001_assessment_passes(workspace_id, pass_number);

CREATE INDEX idx_iso42001_soa_custom_ws ON iso42001_soa_custom_controls(workspace_id);

CREATE INDEX idx_iso42001_soa_snap_ws ON iso42001_soa_snapshots(workspace_id, created_at DESC);

CREATE INDEX idx_kri_readings ON kri_readings(kri_id, measured_at);

CREATE INDEX idx_member_scopes_lookup ON member_scopes(workspace_id, user_id, scope_type);

CREATE INDEX idx_methodology_ws ON risk_methodologies(workspace_id);

CREATE INDEX idx_mrms_workspace ON mrms(workspace_id);

CREATE INDEX idx_nc_workspace ON nonconformities(workspace_id);

CREATE INDEX idx_notif_user ON notifications(user_id, read_at);

CREATE UNIQUE INDEX idx_passes_ws_num ON assessment_passes(workspace_id, pass_number);

CREATE INDEX idx_passes_ws_status ON assessment_passes(workspace_id, status);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);

CREATE INDEX idx_pc_inst ON proposed_changes(instance_id);

CREATE INDEX idx_pc_ws_open ON proposed_changes(workspace_id, decision);

CREATE INDEX idx_qattach_q ON questionnaire_attachments(questionnaire_id);

CREATE INDEX idx_qattach_question ON questionnaire_attachments(question_id);

CREATE INDEX idx_recs_finding ON recommendations(finding_id);

CREATE INDEX idx_remact_finding ON remediation_actions(finding_id);

CREATE INDEX idx_remact_ws ON remediation_actions(workspace_id, status);

CREATE INDEX idx_requirements_fw ON requirements(framework_id, sort_order);

CREATE INDEX idx_risks_workspace ON risks(workspace_id);

CREATE INDEX idx_role_overrides ON workspace_role_overrides(workspace_id, user_id);

CREATE INDEX idx_rta_risk ON risk_treatment_actions(risk_id);

CREATE INDEX idx_rta_workspace ON risk_treatment_actions(workspace_id, status);

CREATE INDEX idx_scc_ws ON soa_custom_controls(workspace_id);

CREATE INDEX idx_so_ws ON security_objectives(workspace_id);

CREATE INDEX idx_soa_ws ON soa_snapshots(workspace_id);

CREATE INDEX idx_subproc_supplier ON supplier_subprocessors(supplier_id);

CREATE INDEX idx_sup_ctrl_iso ON supplier_controls(iso_item_id);

CREATE INDEX idx_sup_ctrl_sup ON supplier_controls(supplier_id);

CREATE INDEX idx_supclauses_supplier ON supplier_clauses(supplier_id);

CREATE INDEX idx_supdocs_supplier ON supplier_documents(supplier_id);

CREATE INDEX idx_supmon ON supplier_monitoring(supplier_id, recorded_at);

CREATE INDEX idx_supnotes_supplier ON supplier_notes(supplier_id);

CREATE INDEX idx_suppliers_workspace ON suppliers(workspace_id);

CREATE INDEX idx_supq_responses ON supplier_questionnaire_responses(questionnaire_id);

CREATE INDEX idx_supq_supplier ON supplier_questionnaires(supplier_id);

CREATE INDEX idx_supreviews_supplier ON supplier_reviews(supplier_id);

CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);

CREATE INDEX idx_time_user ON time_entries(workspace_id, user_id, date);

CREATE INDEX idx_training_workspace ON training_records(workspace_id);

CREATE INDEX idx_treatments_risk ON risk_treatments(risk_id);

CREATE INDEX idx_user_invitations_email ON user_invitations(email);

CREATE INDEX idx_user_invitations_firm ON user_invitations(firm_id);

CREATE INDEX idx_workspace_members ON workspace_members(workspace_id, user_id);

-- ============================================================
-- VIEWS (4)
-- ============================================================

CREATE VIEW v_control_states AS
SELECT
  ci.id                       AS id,
  ci.workspace_id             AS workspace_id,
  rq.ref                      AS iso_item_id,
  CASE ci.status
    WHEN 'implemented'           THEN 'Implemented'
    WHEN 'partially_implemented' THEN 'Partially Implemented'
    WHEN 'work_in_progress'      THEN 'Work In Progress'
    WHEN 'not_implemented'       THEN 'Not Implemented'
    WHEN 'not_applicable'        THEN 'Not Applicable'
    WHEN 'not_assessed'          THEN 'Not Assessed'
    ELSE '!!UNMAPPED:' || ci.status
  END                         AS status,
  CASE ci.applicability
    WHEN 'applicable' THEN 'included'
    WHEN 'excluded'   THEN 'excluded'
    WHEN 'undecided'  THEN 'undecided'
    ELSE '!!UNMAPPED:' || ci.applicability
  END                         AS applicability,
  ci.inclusion_justification  AS inclusion_justification,
  ci.exclusion_justification  AS exclusion_justification,
  ci.maturity                 AS maturity,
  ci.notes                    AS notes,
  ci.internal_notes           AS internal_notes,
  ci.owner_id                 AS owner_id,
  ci.due_date                 AS due_date,
  ci.last_updated             AS last_updated,
  ci.last_verified_at         AS last_verified_at,
  ci.scope_pct                AS scope_pct,
  ci.review_status            AS review_status,
  NULL                        AS assessment_answers,
  ci.review_requested_by      AS review_requested_by,
  ci.review_requested_at      AS review_requested_at,
  ci.review_reason            AS review_reason,
  ci.reviewed_by              AS reviewed_by,
  ci.reviewed_at              AS reviewed_at
FROM control_instances ci
JOIN requirements rq ON rq.id = ci.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso27001'
WHERE ci.entity_id IS NULL;

CREATE VIEW v_iso42001_control_states AS
SELECT
  ci.id                       AS id,
  ci.workspace_id             AS workspace_id,
  rq.ref                      AS iso_item_id,
  CASE ci.status
    WHEN 'implemented'           THEN 'Implemented'
    WHEN 'partially_implemented' THEN 'Partially Implemented'
    WHEN 'work_in_progress'      THEN 'Work In Progress'
    WHEN 'not_implemented'       THEN 'Not Implemented'
    WHEN 'not_applicable'        THEN 'Not Applicable'
    WHEN 'not_assessed'          THEN 'Not Assessed'
    ELSE '!!UNMAPPED:' || ci.status
  END                         AS status,
  CASE ci.applicability
    WHEN 'applicable' THEN 'included'
    WHEN 'excluded'   THEN 'excluded'
    WHEN 'undecided'  THEN 'undecided'
    ELSE '!!UNMAPPED:' || ci.applicability
  END                         AS applicability,
  ci.inclusion_justification  AS inclusion_justification,
  ci.exclusion_justification  AS exclusion_justification,
  ci.maturity                 AS maturity,
  ci.notes                    AS notes,
  ci.internal_notes           AS internal_notes,
  ci.owner_id                 AS owner_id,
  ci.due_date                 AS due_date,
  ci.last_updated             AS last_updated,
  ci.review_status            AS review_status,
  ci.review_requested_by      AS review_requested_by,
  ci.review_requested_at      AS review_requested_at,
  ci.review_reason            AS review_reason,
  ci.reviewed_by              AS reviewed_by,
  ci.reviewed_at              AS reviewed_at
FROM control_instances ci
JOIN requirements rq ON rq.id = ci.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso42001'
WHERE ci.entity_id IS NULL;

CREATE VIEW v_iso42001_items AS
SELECT r.ref AS id,
       r.req_type AS type,
       json_extract(r.guidance,'$.category') AS category,
       r.title AS title,
       r.summary AS summary,
       json_extract(r.guidance,'$.questions') AS questions,
       json_extract(r.guidance,'$.evidence_needed') AS evidence_needed,
       json_extract(r.guidance,'$.documentation_needed') AS documentation_needed,
       r.sort_order AS sort_order,
       json_extract(r.guidance,'$.purpose') AS purpose,
       json_extract(r.guidance,'$.what_good_looks_like') AS what_good_looks_like,
       json_extract(r.guidance,'$.common_pitfalls') AS common_pitfalls,
       json_extract(r.guidance,'$.evidence_to_look_for') AS evidence_to_look_for,
       json_extract(r.guidance,'$.scoping_notes') AS scoping_notes,
       json_extract(r.guidance,'$.maturity_ladder') AS maturity_ladder,
       json_extract(r.guidance,'$.related_items') AS related_items
FROM requirements r
JOIN frameworks f ON f.id = r.framework_id
WHERE f.code = 'iso42001' AND f.version = '2023';

CREATE VIEW v_iso_items AS
SELECT r.ref AS id,
       r.req_type AS type,
       json_extract(r.guidance,'$.category') AS category,
       r.title AS title,
       r.summary AS summary,
       json_extract(r.guidance,'$.questions') AS questions,
       json_extract(r.guidance,'$.evidence_needed') AS evidence_needed,
       json_extract(r.guidance,'$.documentation_needed') AS documentation_needed,
       r.sort_order AS sort_order,
       json_extract(r.guidance,'$.purpose') AS purpose,
       json_extract(r.guidance,'$.what_good_looks_like') AS what_good_looks_like,
       json_extract(r.guidance,'$.common_pitfalls') AS common_pitfalls,
       json_extract(r.guidance,'$.evidence_to_look_for') AS evidence_to_look_for,
       json_extract(r.guidance,'$.scoping_notes') AS scoping_notes,
       json_extract(r.guidance,'$.maturity_ladder') AS maturity_ladder,
       json_extract(r.guidance,'$.related_items') AS related_items,
       json_extract(r.guidance,'$.minimum_certifiable') AS minimum_certifiable
FROM requirements r
JOIN frameworks f ON f.id = r.framework_id
WHERE f.code = 'iso27001' AND f.version = '2022';
