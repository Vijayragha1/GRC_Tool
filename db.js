const Database = require('better-sqlite3');
const path = require('path');
const catalog = require('./data/iso-catalog');
const policyTemplates = require('./data/policy-templates');
const frameworkMappings = require('./data/framework-mappings');
const questionnaireTemplates = require('./data/questionnaire-templates');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'iso27001.db');
const dbDir = path.dirname(dbPath);
const fs = require('fs');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  user_type TEXT NOT NULL CHECK(user_type IN ('firm','client')),
  firm_id INTEGER,
  firm_role TEXT CHECK(firm_role IN ('owner','consultant')),
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firm_id) REFERENCES firms(id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL,
  client_name TEXT NOT NULL,
  industry TEXT,
  scope TEXT,
  target_cert_date DATE,
  stage TEXT DEFAULT 'gap_assessment',
  lead_consultant_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firm_id) REFERENCES firms(id),
  FOREIGN KEY (lead_consultant_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('lead_consultant','consultant','client_admin','contributor','reviewer')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS iso_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  questions TEXT,
  evidence_needed TEXT,
  documentation_needed TEXT,
  sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS control_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  status TEXT DEFAULT 'Not Assessed',
  applicability TEXT DEFAULT 'undecided',
  inclusion_justification TEXT,
  exclusion_justification TEXT,
  maturity INTEGER DEFAULT 0,
  notes TEXT,
  internal_notes TEXT,
  owner_id INTEGER,
  due_date DATE,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, iso_item_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS assets (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risks (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS risk_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  risk_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  UNIQUE(risk_id, iso_item_id),
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
);

CREATE TABLE IF NOT EXISTS document_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  section_ref TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, iso_item_id),
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
);
CREATE INDEX IF NOT EXISTS idx_doc_controls_doc ON document_controls(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_controls_iso ON document_controls(iso_item_id);

CREATE TABLE IF NOT EXISTS supplier_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, iso_item_id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
);
CREATE INDEX IF NOT EXISTS idx_sup_ctrl_sup ON supplier_controls(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sup_ctrl_iso ON supplier_controls(iso_item_id);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  iso_item_id TEXT,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER NOT NULL,
  description TEXT,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  parent_type TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  internal_only INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
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

CREATE INDEX IF NOT EXISTS idx_control_states_workspace ON control_states(workspace_id);
CREATE INDEX IF NOT EXISTS idx_risks_workspace ON risks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_assets_workspace ON assets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_evidence_workspace ON evidence(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(workspace_id, parent_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members ON workspace_members(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS doc_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  content TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firm_id) REFERENCES firms(id)
);

CREATE TABLE IF NOT EXISTS generated_docs (
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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES doc_templates(id)
);

CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  scope TEXT,
  audit_date DATE,
  auditor_name TEXT,
  status TEXT DEFAULT 'planned',
  summary TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_findings (
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

CREATE TABLE IF NOT EXISTS mrms (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nonconformities (
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
  closed_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS framework_mappings (
  iso_item_id TEXT NOT NULL,
  framework TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  notes TEXT,
  PRIMARY KEY (iso_item_id, framework, external_ref)
);

CREATE INDEX IF NOT EXISTS idx_docs_workspace ON generated_docs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audits_workspace ON audits(workspace_id);
CREATE INDEX IF NOT EXISTS idx_findings_audit ON audit_findings(audit_id);
CREATE INDEX IF NOT EXISTS idx_mrms_workspace ON mrms(workspace_id);
CREATE INDEX IF NOT EXISTS idx_nc_workspace ON nonconformities(workspace_id);

CREATE TABLE IF NOT EXISTS incidents (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suppliers (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_records (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_incidents_workspace ON incidents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_workspace ON suppliers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_training_workspace ON training_records(workspace_id);

CREATE TABLE IF NOT EXISTS supplier_documents (
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

CREATE TABLE IF NOT EXISTS supplier_subprocessors (
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

CREATE TABLE IF NOT EXISTS supplier_reviews (
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

CREATE TABLE IF NOT EXISTS supplier_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  user_name TEXT,
  body TEXT,
  internal_only INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_clauses (
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

CREATE TABLE IF NOT EXISTS questionnaire_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER DEFAULT 0,
  category TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questionnaire_questions (
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

CREATE TABLE IF NOT EXISTS supplier_questionnaires (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES questionnaire_templates(id)
);

CREATE TABLE IF NOT EXISTS supplier_questionnaire_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer TEXT,
  comment TEXT,
  evidence_ref TEXT,
  UNIQUE(questionnaire_id, question_id),
  FOREIGN KEY (questionnaire_id) REFERENCES supplier_questionnaires(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_supdocs_supplier ON supplier_documents(supplier_id);
CREATE INDEX IF NOT EXISTS idx_subproc_supplier ON supplier_subprocessors(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supreviews_supplier ON supplier_reviews(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supnotes_supplier ON supplier_notes(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supclauses_supplier ON supplier_clauses(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supq_supplier ON supplier_questionnaires(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supq_responses ON supplier_questionnaire_responses(questionnaire_id);

-- Multi-entity / business-unit scoping. NULL entity_id on artifacts = workspace-wide.
CREATE TABLE IF NOT EXISTS entities (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entities_workspace ON entities(workspace_id);

-- RBAC permission overrides on top of role bundles.
CREATE TABLE IF NOT EXISTS workspace_role_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  granted_by INTEGER,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id, permission),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_role_overrides ON workspace_role_overrides(workspace_id, user_id);

-- Document version history (immutable snapshots per major revision)
CREATE TABLE IF NOT EXISTS doc_versions (
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
CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON doc_versions(document_id);

-- Approver chain for a specific version (sequenced multi-step approval)
CREATE TABLE IF NOT EXISTS doc_approvers (
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
CREATE INDEX IF NOT EXISTS idx_doc_approvers ON doc_approvers(document_id, version_id, sequence);

-- E-signatures: tamper-evident records (HMAC over content_hash, user_id, ts).
CREATE TABLE IF NOT EXISTS doc_signatures (
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
CREATE INDEX IF NOT EXISTS idx_doc_sig_doc ON doc_signatures(document_id, version_id);

-- Risk methodology (per workspace, customizable likelihood × impact matrix)
CREATE TABLE IF NOT EXISTS risk_methodologies (
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
CREATE INDEX IF NOT EXISTS idx_methodology_ws ON risk_methodologies(workspace_id);

CREATE INDEX IF NOT EXISTS idx_audit_user_action ON audit_log(user_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

-- ========== Risk treatment plans ==========
CREATE TABLE IF NOT EXISTS risk_treatments (
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
CREATE INDEX IF NOT EXISTS idx_treatments_risk ON risk_treatments(risk_id);

-- ========== KRIs (key risk indicators) ==========
CREATE TABLE IF NOT EXISTS kris (
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
CREATE TABLE IF NOT EXISTS kri_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kri_id INTEGER NOT NULL,
  value REAL NOT NULL,
  measured_at DATE NOT NULL,
  notes TEXT,
  recorded_by INTEGER,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (kri_id) REFERENCES kris(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kri_readings ON kri_readings(kri_id, measured_at);

-- ========== SoA snapshots (versioning) ==========
CREATE TABLE IF NOT EXISTS soa_snapshots (
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_soa_ws ON soa_snapshots(workspace_id);

-- Per-entity SoA overrides (control state can differ per entity)
CREATE TABLE IF NOT EXISTS entity_control_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  applicability TEXT,
  status TEXT,
  inclusion_justification TEXT,
  exclusion_justification TEXT,
  notes TEXT,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_id, iso_item_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ecs ON entity_control_states(entity_id, iso_item_id);

-- ========== Document hierarchy (parent_doc_id self-ref) ==========
-- column added via migration

-- ========== Document acknowledgement campaigns ==========
CREATE TABLE IF NOT EXISTS doc_ack_campaigns (
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
CREATE TABLE IF NOT EXISTS doc_ack_recipients (
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
CREATE INDEX IF NOT EXISTS idx_ack_campaign ON doc_ack_recipients(campaign_id);

-- ========== Audit programme + sampling ==========
CREATE TABLE IF NOT EXISTS audit_programmes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  description TEXT,
  approved_by TEXT,
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
-- Add programme_id and competence/independence fields to audits via migration

-- ========== Incident timeline events + runbooks ==========
CREATE TABLE IF NOT EXISTS incident_events (
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
CREATE INDEX IF NOT EXISTS idx_inc_events ON incident_events(incident_id);

-- Runbook templates (system + firm-defined)
CREATE TABLE IF NOT EXISTS runbooks (
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

-- ========== Supplier monitoring + tokenized questionnaires ==========
CREATE TABLE IF NOT EXISTS supplier_monitoring (
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
CREATE INDEX IF NOT EXISTS idx_supmon ON supplier_monitoring(supplier_id, recorded_at);

-- Add token to supplier_questionnaires via migration

-- Termination checklist items per supplier
CREATE TABLE IF NOT EXISTS supplier_termination_items (
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

-- ========== Training catalogue + assignments + phishing ==========
CREATE TABLE IF NOT EXISTS training_courses (
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
-- Add course_id and attestation fields to training_records via migration

CREATE TABLE IF NOT EXISTS phishing_simulations (
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

-- ========== Task templates + recurring + time tracking + dependencies ==========
CREATE TABLE IF NOT EXISTS task_templates (
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
-- Add recurring/parent/dependency/time fields to tasks via migration

CREATE TABLE IF NOT EXISTS time_entries (
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
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(workspace_id, user_id, date);

-- ========== Asset relationships ==========
CREATE TABLE IF NOT EXISTS asset_relationships (
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
CREATE INDEX IF NOT EXISTS idx_asset_rels ON asset_relationships(parent_asset_id, child_asset_id);

-- ========== Notifications / reminders ==========
CREATE TABLE IF NOT EXISTS notifications (
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
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

-- ========== Permission templates (named override bundles) ==========
CREATE TABLE IF NOT EXISTS permission_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ========== Access reviews ==========
CREATE TABLE IF NOT EXISTS access_reviews (
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
CREATE TABLE IF NOT EXISTS access_review_items (
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

-- ========== Audit log hash chain (tamper-evidence) ==========
CREATE TABLE IF NOT EXISTS audit_chain (
  id INTEGER PRIMARY KEY,
  audit_log_id INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_log_id) REFERENCES audit_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chain_log ON audit_chain(audit_log_id);

-- ===== API tokens (scoped, expiring, hashed) =====
CREATE TABLE IF NOT EXISTS api_tokens (
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
CREATE INDEX IF NOT EXISTS idx_api_tokens ON api_tokens(workspace_id, user_id);

-- ===== Custom fields per artifact type =====
CREATE TABLE IF NOT EXISTS custom_field_defs (
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
CREATE TABLE IF NOT EXISTS custom_field_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_def_id INTEGER NOT NULL,
  value TEXT,
  UNIQUE(entity_type, entity_id, field_def_id),
  FOREIGN KEY (field_def_id) REFERENCES custom_field_defs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cfv ON custom_field_values(entity_type, entity_id);

-- ===== Risk appetite (per workspace) =====
CREATE TABLE IF NOT EXISTS risk_appetites (
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

-- ===== Risk acceptance attestations (e-signed) =====
CREATE TABLE IF NOT EXISTS risk_acceptances (
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

-- ===== DPIA module =====
CREATE TABLE IF NOT EXISTS dpias (
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

-- ===== Audit observations (lighter than findings) =====
CREATE TABLE IF NOT EXISTS audit_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL,
  iso_item_id TEXT,
  description TEXT NOT NULL,
  recommendation TEXT,
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

-- ===== Evidence retention rules =====
CREATE TABLE IF NOT EXISTS retention_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  applies_to TEXT NOT NULL,
  pattern TEXT,
  retain_years INTEGER NOT NULL,
  reason TEXT,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- ===== Per-user dashboard widget config =====
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  widget_key TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  config TEXT,
  UNIQUE(workspace_id, user_id, widget_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- ===== Threaded comments + @-mention reactions =====
CREATE TABLE IF NOT EXISTS comment_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  mentioned_user_id INTEGER NOT NULL,
  read_at DATETIME,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (mentioned_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ===== Custom report templates =====
CREATE TABLE IF NOT EXISTS report_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  body TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===== Crisis communications templates =====
CREATE TABLE IF NOT EXISTS crisis_comms_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  audience TEXT NOT NULL,
  channel TEXT,
  body TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===== Continuous control monitoring rules + check results =====
CREATE TABLE IF NOT EXISTS ccm_rules (
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
CREATE TABLE IF NOT EXISTS ccm_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  measured_value TEXT,
  details TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rule_id) REFERENCES ccm_rules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ccm_results ON ccm_results(rule_id, ran_at);

-- ===== Backup runs =====
CREATE TABLE IF NOT EXISTS backup_runs (
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

-- ===== Master key rotation log =====
CREATE TABLE IF NOT EXISTS key_rotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prev_key_fp TEXT NOT NULL,
  new_key_fp TEXT NOT NULL,
  rotated_by INTEGER,
  rows_reencrypted INTEGER,
  status TEXT NOT NULL,
  notes TEXT,
  rotated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===== Onboarding progress per workspace =====
CREATE TABLE IF NOT EXISTS onboarding_progress (
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

-- ===== FTS5 virtual table for full-text search =====
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  workspace_id UNINDEXED, entity_type UNINDEXED, entity_id UNINDEXED,
  title, body
);
`;

function addColumnIfMissing(table, column, defn) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${defn}`).run(); }
  catch (e) { /* column already exists */ }
}

function init() {
  db.exec(SCHEMA);

  // Migrations: add entity_id scoping to artifact tables.
  const entityScoped = ['assets','risks','suppliers','incidents','generated_docs',
                        'audits','mrms','nonconformities','training_records','tasks'];
  entityScoped.forEach(t => addColumnIfMissing(t, 'entity_id', 'INTEGER REFERENCES entities(id) ON DELETE SET NULL'));

  // Migrations: enhanced audit log columns (idempotent)
  ['entity_scope_id INTEGER','before_state TEXT','after_state TEXT',
   'ip_address TEXT','user_agent TEXT','request_id TEXT'].forEach(c => {
    const [name, ...defParts] = c.split(' ');
    addColumnIfMissing('audit_log', name, defParts.join(' '));
  });

  // Migrations: documents — add live version pointer and locking flags.
  ['locked INTEGER DEFAULT 0','retired_at DATETIME',
   'published_at DATETIME','approval_due DATETIME',
   'review_period_months INTEGER DEFAULT 12','next_review_date DATE',
   'current_version_id INTEGER REFERENCES doc_versions(id) ON DELETE SET NULL']
    .forEach(c => {
      const [name, ...defParts] = c.split(' ');
      addColumnIfMissing('generated_docs', name, defParts.join(' '));
    });

  // Migrations: encryption flag on workspaces (per-tenant opt-in)
  addColumnIfMissing('workspaces', 'encryption_enabled', 'INTEGER DEFAULT 1');

  // Documents — hierarchy and watermarking
  ['parent_doc_id INTEGER REFERENCES generated_docs(id) ON DELETE SET NULL',
   'doc_kind TEXT', 'reference_code TEXT', 'controlled_copy INTEGER DEFAULT 0']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('generated_docs', n, d.join(' ')); });

  // Documents — uploaded source (preserves the originally approved file alongside the editable markdown)
  ['source_filename TEXT', 'source_stored_path TEXT', 'source_mime TEXT', 'source_size_bytes INTEGER', 'source_sha256 TEXT']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('generated_docs', n, d.join(' ')); });

  // Phase E: training trigger on doc approval (Clauses 7.2, 7.3, A.6.3)
  ['requires_training INTEGER DEFAULT 0', 'training_audience TEXT']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('generated_docs', n, d.join(' ')); });
  addColumnIfMissing('training_records', 'source_doc_id', 'INTEGER REFERENCES generated_docs(id) ON DELETE SET NULL');

  // Document templates — flag ISO-mandatory vs recommended (so freshers know what's required vs nice-to-have)
  addColumnIfMissing('doc_templates', 'tier', "TEXT DEFAULT 'recommended'");
  // Re-tag every run (idempotent) so newly added templates get the right tier.
  const MANDATORY_PATTERNS = [
    'Information Security Policy',
    'Risk Assessment Methodology', 'Risk Methodology', 'Risk Assessment Process', 'Risk Management Process',
    'Risk Treatment Plan',
    'Statement of Applicability',
    'ISMS Scope',
    'Information Security Objectives',
    'Roles and Responsibilities',
    'Internal Audit Programme', 'Internal Audit Plan', 'Internal Audit Procedure',
    'Management Review',
    'Nonconformity', 'Corrective Action',
    'Operations Security Procedure'
  ];
  const EXPECTED_PATTERNS = [
    'Access Control', 'Acceptable Use', 'Asset Management', 'Asset Inventory',
    'Cryptography', 'Cryptographic', 'Backup', 'Business Continuity',
    'Incident Response', 'Incident Management', 'Change Management',
    'Supplier', 'Vendor', 'Secure Development', 'Communication Plan',
    'Physical and Environmental', 'Logging', 'Monitoring',
    'Awareness', 'Competence', 'Legal', 'Regulatory', 'Compliance Register',
    'Data Classification', 'Information Classification',
    'Privileged Access', 'Authentication', 'ISMS Governance'
  ];
  const tagOne = db.prepare(`UPDATE doc_templates SET tier=? WHERE is_system=1 AND name LIKE ?`);
  // Reset all to recommended first, then promote
  db.prepare(`UPDATE doc_templates SET tier='recommended' WHERE is_system=1`).run();
  EXPECTED_PATTERNS.forEach(p => tagOne.run('expected', `%${p}%`));
  MANDATORY_PATTERNS.forEach(p => tagOne.run('mandatory', `%${p}%`));

  // Audits — programme link, competence, independence
  ['programme_id INTEGER REFERENCES audit_programmes(id) ON DELETE SET NULL',
   'auditor_competence TEXT', 'auditor_independence TEXT',
   'sample_size INTEGER', 'population_size INTEGER']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('audits', n, d.join(' ')); });

  // Incidents — regulator clock, post-incident review, tabletop flag, runbook
  ['notification_required_by DATETIME', 'notification_sent_at DATETIME',
   'pir_completed INTEGER DEFAULT 0', 'pir_summary TEXT',
   'is_tabletop INTEGER DEFAULT 0', 'runbook_id INTEGER',
   'contained_at DATETIME', 'eradicated_at DATETIME', 'recovered_at DATETIME']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('incidents', n, d.join(' ')); });

  // Suppliers — termination workflow flags
  ['termination_started_at DATETIME', 'termination_owner TEXT']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('suppliers', n, d.join(' ')); });

  // Supplier questionnaires — tokenized external link
  ['external_token TEXT', 'external_email TEXT', 'external_completed_at DATETIME']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('supplier_questionnaires', n, d.join(' ')); });

  // Training records — link to course catalogue + attestation/quiz
  ['course_id INTEGER REFERENCES training_courses(id) ON DELETE SET NULL',
   'attestation_signed_at DATETIME', 'attestation_ip TEXT',
   'quiz_score INTEGER', 'expiry_date DATE']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('training_records', n, d.join(' ')); });

  // Tasks — recurring, dependencies, parent, time
  ['parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL',
   'recurrence TEXT', 'recurrence_until DATE',
   'depends_on_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL',
   'estimated_minutes INTEGER',
   'template_id INTEGER REFERENCES task_templates(id) ON DELETE SET NULL',
   'nonconformity_id INTEGER REFERENCES nonconformities(id) ON DELETE SET NULL']
    .forEach(c => { const [n, ...d] = c.split(' '); addColumnIfMissing('tasks', n, d.join(' ')); });

  // Phase C: control verification timestamp on closure of NC / audit
  addColumnIfMissing('control_states', 'last_verified_at', 'DATETIME');

  // Tasks — priority for triage of bulk-spawned remediation backlogs.
  addColumnIfMissing('tasks', 'priority', "TEXT DEFAULT 'normal'");

  // Audit-grade content for each clause/control. Authored in data/iso-content.js
  // and synced into iso_items on every boot — change the file, restart, content
  // updates. Existing summary/questions/evidence_needed columns stay (legacy).
  addColumnIfMissing('iso_items', 'purpose', 'TEXT');
  addColumnIfMissing('iso_items', 'what_good_looks_like', 'TEXT');
  addColumnIfMissing('iso_items', 'common_pitfalls', 'TEXT');         // JSON array
  addColumnIfMissing('iso_items', 'evidence_to_look_for', 'TEXT');    // JSON array
  addColumnIfMissing('iso_items', 'scoping_notes', 'TEXT');
  addColumnIfMissing('iso_items', 'maturity_ladder', 'TEXT');         // JSON {1,2,3,4}
  addColumnIfMissing('iso_items', 'related_items', 'TEXT');           // JSON array of ids
  try {
    const content = require('./data/iso-content');
    const upd = db.prepare(`UPDATE iso_items SET
      purpose=?, what_good_looks_like=?, common_pitfalls=?, evidence_to_look_for=?,
      scoping_notes=?, maturity_ladder=?, related_items=? WHERE id=?`);
    let n = 0;
    for (const [id, c] of Object.entries(content)) {
      const r = upd.run(
        c.purpose || null,
        c.what_good_looks_like || null,
        c.common_pitfalls ? JSON.stringify(c.common_pitfalls) : null,
        c.evidence_to_look_for ? JSON.stringify(c.evidence_to_look_for) : null,
        c.scoping_notes || null,
        c.maturity_ladder ? JSON.stringify(c.maturity_ladder) : null,
        c.related_items ? JSON.stringify(c.related_items) : null,
        id
      );
      if (r.changes > 0) n++;
    }
    if (n > 0) console.log(`[content] synced ${n} ISO item(s) from data/iso-content.js`);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') console.warn('[content] failed to sync:', e.message);
  }

  // Gap-assessment universal questions — JSON-encoded answers per item.
  addColumnIfMissing('control_states', 'assessment_answers', 'TEXT');

  // Scope-of-implementation: 0-100 percentage of in-scope systems/processes where
  // the control is actually operating. A control can be "Implemented" globally yet
  // applied to only 60% of in-scope systems — auditors care about that gap.
  addColumnIfMissing('control_states', 'scope_pct', 'INTEGER');

  // Append-only version history of every wizard save. Lets you show an auditor
  // exactly how a control's status, scope, and notes changed over time without
  // tampering with the live row.
  db.exec(`CREATE TABLE IF NOT EXISTS control_state_history (
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
    assessment_answers TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (iso_item_id) REFERENCES iso_items(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_csh_ws_item ON control_state_history(workspace_id, iso_item_id, snapshot_at DESC);`);

  // Risks — KRI link convenience
  addColumnIfMissing('risks', 'is_systemic', 'INTEGER DEFAULT 0');

  // RBAC overrides — expiry support
  addColumnIfMissing('workspace_role_overrides', 'expires_at', 'DATETIME');

  // Users — last_active for member profile, locale + IdP linkage
  addColumnIfMissing('users', 'last_active_at', 'DATETIME');
  addColumnIfMissing('users', 'locale', "TEXT DEFAULT 'en'");
  addColumnIfMissing('users', 'idp_subject', 'TEXT');
  addColumnIfMissing('users', 'idp_kind', 'TEXT');

  // Risks — DPIA flag, risk acceptance lifecycle
  addColumnIfMissing('risks', 'is_dpia', 'INTEGER DEFAULT 0');
  addColumnIfMissing('risks', 'accepted_until', 'DATE');
  addColumnIfMissing('risks', 'last_acceptance_id', 'INTEGER');

  // Evidence — retention metadata
  addColumnIfMissing('evidence', 'retention_until', 'DATE');
  addColumnIfMissing('evidence', 'retention_rule_id', 'INTEGER');

  // ========================================================================
  // Tier-1, Tier-2, Tier-3 expansion — see roadmap in README.
  // ========================================================================

  // Tier 1.1 — Risk treatment plan as a tracked workflow (clause 6.1.3).
  // Each open risk gets a list of treatment actions with owners, dates,
  // status, and (optionally) a residual L×I re-evaluation when the action
  // closes. This is the artefact auditors sample most for 6.1.3.
  db.exec(`CREATE TABLE IF NOT EXISTS risk_treatment_actions (
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
  CREATE INDEX IF NOT EXISTS idx_rta_risk ON risk_treatment_actions(risk_id);
  CREATE INDEX IF NOT EXISTS idx_rta_workspace ON risk_treatment_actions(workspace_id, status);`);

  // Tier 1.2 — Evidence freshness/expiry. valid_from / valid_until reflect
  // the period the evidence covers (e.g., a Q1-2026 access review is valid
  // for that period). Distinct from retention_until which is how long we
  // keep the file, not how long the audit will accept it as current.
  addColumnIfMissing('evidence', 'valid_from', 'DATE');
  addColumnIfMissing('evidence', 'valid_until', 'DATE');
  addColumnIfMissing('evidence', 'period_label', 'TEXT'); // e.g. "Q1 2026", "January 2026"
  // Tier 3.9 — Section/sub-clause that this evidence specifically addresses
  // (e.g., A.5.18.b for the leaver-revocation aspect of access rights).
  addColumnIfMissing('evidence', 'clause_section', 'TEXT');

  // Tier 1.3 — Certification cycle calendar. Stage 1 → Stage 2 →
  // surveillance year 1 → surveillance year 2 → recertification.
  // One row per planned/actual cert event per workspace.
  db.exec(`CREATE TABLE IF NOT EXISTS cert_cycle_events (
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
  CREATE INDEX IF NOT EXISTS idx_ccev_workspace ON cert_cycle_events(workspace_id, planned_date);`);

  // Tier 1.4 — Internal audit lifecycle. The existing 'audits' table is
  // metadata-only; add columns to track the engagement workflow.
  addColumnIfMissing('audits', 'lifecycle_stage', "TEXT DEFAULT 'planned'");
  // Stages: planned, fieldwork, findings_review, report, follow_up, closed
  addColumnIfMissing('audits', 'fieldwork_started_at', 'DATETIME');
  addColumnIfMissing('audits', 'report_issued_at', 'DATETIME');
  addColumnIfMissing('audits', 'closed_at', 'DATETIME');

  // Tier 3.8 — Asset criticality / BIA modeling. Existing CIA scoring
  // covers confidentiality/integrity/availability; BIA adds business
  // criticality + recovery objectives.
  addColumnIfMissing('assets', 'business_criticality', 'TEXT'); // low / medium / high / critical
  addColumnIfMissing('assets', 'rto_hours', 'INTEGER'); // recovery time objective
  addColumnIfMissing('assets', 'rpo_hours', 'INTEGER'); // recovery point objective
  addColumnIfMissing('assets', 'bia_notes', 'TEXT');

  // Tier 3.10 — Onboarding state per tenant (firm). Tracks which onboarding
  // steps the tenant has completed so the wizard can resume where left off.
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_onboarding (
    firm_id INTEGER PRIMARY KEY,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    current_step INTEGER DEFAULT 1,
    skipped INTEGER DEFAULT 0,
    FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
  );`);

  // ========================================================================
  // Final-pass expansion (12 features across Tiers A/B/C).
  // ========================================================================

  // A.1 — Evidence-to-many-controls. The same evidence file often satisfies
  // several controls (and clauses). Mirror the document_controls pattern:
  // join table with optional section_ref. Existing evidence.iso_item_id stays
  // as the "primary" link for backwards-compat; views UNION both sources.
  db.exec(`CREATE TABLE IF NOT EXISTS evidence_controls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id INTEGER NOT NULL,
    iso_item_id TEXT NOT NULL,
    section_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(evidence_id, iso_item_id),
    FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE,
    FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
  );
  CREATE INDEX IF NOT EXISTS idx_ec_evidence ON evidence_controls(evidence_id);
  CREATE INDEX IF NOT EXISTS idx_ec_iso ON evidence_controls(iso_item_id);`);

  // Backfill: every existing evidence row with an iso_item_id seeds a row in
  // evidence_controls (idempotent — INSERT OR IGNORE).
  db.exec(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id)
    SELECT id, iso_item_id FROM evidence WHERE iso_item_id IS NOT NULL`);

  // C.10 — Continual improvement register (clause 10.1). Improvements driven
  // by data — distinct from corrective actions on NCs (10.2).
  db.exec(`CREATE TABLE IF NOT EXISTS improvements (
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
  CREATE INDEX IF NOT EXISTS idx_imp_ws ON improvements(workspace_id, status);`);

  // C.9 — Per-audit sampling justification + per-control sample records.
  // The audits table already has sample_size/population_size; add a
  // narrative sampling-justification column and a child table for per-
  // control sampled items.
  addColumnIfMissing('audits', 'sampling_justification', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS audit_samples (
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
  CREATE INDEX IF NOT EXISTS idx_audsamp_audit ON audit_samples(audit_id);`);

  // Workspaces — locale + retention defaults
  addColumnIfMissing('workspaces', 'locale', "TEXT DEFAULT 'en'");

  // Comments — threading, mentions
  addColumnIfMissing('comments', 'parent_comment_id', 'INTEGER REFERENCES comments(id) ON DELETE CASCADE');
  addColumnIfMissing('comments', 'has_mentions', 'INTEGER DEFAULT 0');

  // Generated_docs — watermark text
  addColumnIfMissing('generated_docs', 'watermark', 'TEXT');

  // Migrations: extend suppliers with TPRM fields
  const supplierCols = [
    ['lifecycle_stage', "TEXT DEFAULT 'active'"],
    ['inherent_risk_score', 'INTEGER'],
    ['residual_risk_score', 'INTEGER'],
    ['business_criticality', "TEXT DEFAULT 'medium'"],
    ['data_volume', "TEXT DEFAULT 'low'"],
    ['industry', 'TEXT'],
    ['location', 'TEXT'],
    ['parent_company', 'TEXT'],
    ['regulatory_exposure', 'TEXT'],
    ['dependency_type', "TEXT DEFAULT 'multi_source'"],
    ['annual_spend', 'TEXT'],
    ['renewal_notice_days', 'INTEGER'],
    ['auto_renew', 'INTEGER DEFAULT 0'],
    ['approved_by', 'TEXT'],
    ['approved_at', 'DATETIME'],
    ['terminated_at', 'DATETIME'],
    ['data_return_completed', 'INTEGER DEFAULT 0'],
    ['website', 'TEXT']
  ];
  supplierCols.forEach(([c, d]) => addColumnIfMissing('suppliers', c, d));

  const count = db.prepare('SELECT COUNT(*) as c FROM iso_items').get().c;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO iso_items
      (id, type, category, title, summary, questions, evidence_needed, documentation_needed, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction((items) => {
      for (const it of items) {
        insert.run(
          it.id, it.type, it.category, it.title, it.summary,
          JSON.stringify(it.questions || []),
          JSON.stringify(it.evidence_needed || []),
          JSON.stringify(it.documentation_needed || []),
          it.sort_order
        );
      }
    });
    tx(catalog);
    console.log(`[db] Seeded ${catalog.length} ISO items`);
  }

  // Seed system policy templates (idempotent — adds any missing by name)
  const tplCount = db.prepare('SELECT COUNT(*) AS c FROM doc_templates WHERE is_system = 1').get().c;
  if (true) {
    const tIns = db.prepare(`INSERT INTO doc_templates (firm_id, name, category, description, content, is_system)
                             VALUES (NULL, ?, ?, ?, ?, 1)`);
    const tplExistsStmt = db.prepare('SELECT 1 FROM doc_templates WHERE name = ? AND is_system = 1');
    const tTx = db.transaction((tpls) => {
      let added = 0;
      for (const t of tpls) {
        if (!tplExistsStmt.get(t.name)) { tIns.run(t.name, t.category, t.description, t.content); added++; }
      }
      return added;
    });
    // Core 15 + ISO 27001:2022 expanded pack (people, physical, technical, organisational, forms, roles)
    const peoplePhysical = require('./data/policy-templates-people-physical');
    const technical = require('./data/policy-templates-technical');
    const organisational = require('./data/policy-templates-organisational');
    const formsRoles = require('./data/policy-templates-forms-roles');
    const bundles = require('./data/policy-templates-bundles');
    const allTemplates = [...policyTemplates, ...peoplePhysical, ...technical, ...organisational, ...formsRoles, ...bundles];
    const tplAdded = tTx(allTemplates);
    if (tplAdded) console.log(`[db] Added ${tplAdded} new system policy templates (catalog now: ${allTemplates.length})`);
  }

  // Seed default firm + user (no-auth mode)
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const firmId = db.prepare(`INSERT INTO firms (name) VALUES (?)`).run('My firm').lastInsertRowid;
    db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role)
                VALUES (?, ?, ?, 'firm', ?, 'owner')`)
      .run('local@local', '!noauth', 'You', firmId);
    console.log('[db] Seeded default firm and user (no auth)');
  }

  // Seed system questionnaire templates
  const qtCount = db.prepare('SELECT COUNT(*) AS c FROM questionnaire_templates WHERE is_system = 1').get().c;
  if (qtCount === 0) {
    const insTpl = db.prepare(`INSERT INTO questionnaire_templates (firm_id, name, description, is_system, category) VALUES (NULL, ?, ?, 1, ?)`);
    const insQ = db.prepare(`INSERT INTO questionnaire_questions (template_id, question_order, section, question, question_type, weight, expected_answer, iso_control_ref) VALUES (?, ?, ?, ?, 'yes_no', 1, ?, ?)`);
    const tx = db.transaction((tpls) => {
      for (const t of tpls) {
        const tid = insTpl.run(t.name, t.description, t.category).lastInsertRowid;
        t.questions.forEach((q, i) => insQ.run(tid, i + 1, q.section, q.q, q.expected, q.iso || null));
      }
    });
    tx(questionnaireTemplates);
    console.log(`[db] Seeded ${questionnaireTemplates.length} questionnaire templates with ${questionnaireTemplates.reduce((s,t)=>s+t.questions.length,0)} questions`);
  }

  // Seed framework mappings
  const fmCount = db.prepare('SELECT COUNT(*) AS c FROM framework_mappings').get().c;
  if (fmCount === 0) {
    const fIns = db.prepare(`INSERT OR IGNORE INTO framework_mappings (iso_item_id, framework, external_ref, notes)
                             VALUES (?, ?, ?, ?)`);
    const fTx = db.transaction((rows) => {
      for (const r of rows) fIns.run(r.iso_item_id, r.framework, r.external_ref, r.notes || null);
    });
    fTx(frameworkMappings);
    console.log(`[db] Seeded ${frameworkMappings.length} framework mappings`);
  }

  // Seed runbooks
  const rbCount = db.prepare('SELECT COUNT(*) AS c FROM runbooks WHERE is_system=1').get().c;
  if (rbCount === 0) {
    const runbooks = require('./data/runbooks');
    const ins = db.prepare('INSERT INTO runbooks (firm_id, name, category, trigger_severity, trigger_category, steps, is_system) VALUES (NULL, ?, ?, ?, ?, ?, 1)');
    runbooks.forEach(r => ins.run(r.name, r.category, r.trigger_severity || null, r.trigger_category || null, JSON.stringify(r.steps)));
    console.log(`[db] Seeded ${runbooks.length} runbooks`);
  }

  // Seed task templates
  const ttCount = db.prepare('SELECT COUNT(*) AS c FROM task_templates WHERE is_system=1').get().c;
  if (ttCount === 0) {
    const tts = require('./data/task-templates');
    const ins = db.prepare('INSERT INTO task_templates (workspace_id, firm_id, name, description, category, is_system, steps) VALUES (NULL, NULL, ?, ?, ?, 1, ?)');
    tts.forEach(t => ins.run(t.name, t.description, t.category, JSON.stringify(t.steps)));
    console.log(`[db] Seeded ${tts.length} task templates`);
  }

  // Seed permission templates
  const ptCount = db.prepare('SELECT COUNT(*) AS c FROM permission_templates WHERE is_system=1').get().c;
  if (ptCount === 0) {
    const pts = require('./data/permission-templates');
    const ins = db.prepare('INSERT INTO permission_templates (firm_id, name, description, permissions, is_system) VALUES (NULL, ?, ?, ?, 1)');
    pts.forEach(p => ins.run(p.name, p.description, JSON.stringify(p.permissions)));
    console.log(`[db] Seeded ${pts.length} permission templates`);
  }

  // Seed CCM rules
  const ccmCount = db.prepare('SELECT COUNT(*) AS c FROM ccm_rules WHERE is_system=1').get().c;
  if (ccmCount === 0) {
    const rules = require('./data/ccm-rules');
    const ins = db.prepare('INSERT INTO ccm_rules (workspace_id, firm_id, iso_item_id, name, description, rule_kind, rule_config, frequency, is_active, is_system) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, 1, 1)');
    rules.forEach(r => ins.run(r.iso_item_id || null, r.name, r.description, r.rule_kind, JSON.stringify(r.rule_config), r.frequency || 'daily'));
    console.log(`[db] Seeded ${rules.length} CCM rules`);
  }

  // Seed report templates
  const rtCount = db.prepare('SELECT COUNT(*) AS c FROM report_templates WHERE is_system=1').get().c;
  if (rtCount === 0) {
    const rts = require('./data/report-templates');
    const ins = db.prepare('INSERT INTO report_templates (workspace_id, firm_id, name, description, body, is_system) VALUES (NULL, NULL, ?, ?, ?, 1)');
    rts.forEach(r => ins.run(r.name, r.description, r.body));
    console.log(`[db] Seeded ${rts.length} report templates`);
  }

  // Seed crisis comms templates
  const ccCount = db.prepare('SELECT COUNT(*) AS c FROM crisis_comms_templates WHERE is_system=1').get().c;
  if (ccCount === 0) {
    const ccs = require('./data/crisis-comms');
    const ins = db.prepare('INSERT INTO crisis_comms_templates (firm_id, name, audience, channel, body, is_system) VALUES (NULL, ?, ?, ?, ?, 1)');
    ccs.forEach(c => ins.run(c.name, c.audience, c.channel, c.body));
    console.log(`[db] Seeded ${ccs.length} crisis comms templates`);
  }
}

const crypto = require('crypto');

function logAction(userId, workspaceId, action, entityType, entityId, details, ctx = {}) {
  try {
    if (!userId || userId === 0) {
      // Resolve the external-signer sentinel user (or create on demand).
      let ext = db.prepare(`SELECT id FROM users WHERE email='external@isms.local'`).get();
      if (!ext) {
        const uid = db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active) VALUES ('external@isms.local','!external','External signer','client',0)`).run().lastInsertRowid;
        ext = { id: uid };
      }
      userId = ext.id;
    }
    const info = db.prepare(`INSERT INTO audit_log (
        workspace_id, entity_scope_id, user_id, action, entity_type, entity_id,
        details, before_state, after_state, ip_address, user_agent, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      workspaceId || null,
      ctx.entityScopeId || null,
      userId, action,
      entityType || null,
      entityId == null ? null : String(entityId),
      details ? JSON.stringify(details) : null,
      ctx.before ? JSON.stringify(ctx.before) : null,
      ctx.after ? JSON.stringify(ctx.after) : null,
      ctx.ip || null,
      ctx.userAgent || null,
      ctx.requestId || null
    );
    appendChain(info.lastInsertRowid);
    // Touch user last_active
    if (userId) {
      try { db.prepare('UPDATE users SET last_active_at=CURRENT_TIMESTAMP WHERE id=?').run(userId); } catch(_){}
    }
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}

// Hash-chain each audit_log row so insertion / deletion / mutation is detectable.
// Each entry's hash = SHA-256(prev_hash || canonical_row).
function appendChain(auditLogId) {
  const row = db.prepare('SELECT * FROM audit_log WHERE id=?').get(auditLogId);
  if (!row) return;
  const prev = db.prepare('SELECT entry_hash FROM audit_chain ORDER BY id DESC LIMIT 1').get();
  const prevHash = prev ? prev.entry_hash : '0'.repeat(64);
  const canonical = JSON.stringify({
    i: row.id, w: row.workspace_id, u: row.user_id, a: row.action,
    et: row.entity_type, ei: row.entity_id, d: row.details,
    b: row.before_state, af: row.after_state,
    ip: row.ip_address, ua: row.user_agent, rid: row.request_id,
    t: row.created_at
  });
  const entryHash = crypto.createHash('sha256').update(prevHash + canonical).digest('hex');
  db.prepare('INSERT INTO audit_chain (audit_log_id, prev_hash, entry_hash) VALUES (?, ?, ?)')
    .run(auditLogId, prevHash, entryHash);
}

// Walk the chain end-to-end, return list of issues (empty = clean).
// The hash chain is GLOBAL across all workspaces — we walk every row to verify,
// then filter the issue list to those whose audit_log row belongs to the
// requested workspace (so each tenant only sees their own integrity report).
function verifyAuditChain(workspaceId) {
  const rows = db.prepare(`SELECT a.*, c.prev_hash, c.entry_hash
    FROM audit_log a LEFT JOIN audit_chain c ON c.audit_log_id=a.id
    ORDER BY a.id`).all();
  const issues = [];
  let prevHash = '0'.repeat(64);
  for (const row of rows) {
    if (!row.entry_hash) { issues.push({ id: row.id, kind: 'no_chain', desc: 'Missing chain entry — log row was inserted without going through logAction()' }); continue; }
    const canonical = JSON.stringify({
      i: row.id, w: row.workspace_id, u: row.user_id, a: row.action,
      et: row.entity_type, ei: row.entity_id, d: row.details,
      b: row.before_state, af: row.after_state,
      ip: row.ip_address, ua: row.user_agent, rid: row.request_id,
      t: row.created_at
    });
    const expected = crypto.createHash('sha256').update(prevHash + canonical).digest('hex');
    if (expected !== row.entry_hash) {
      issues.push({ id: row.id, kind: 'mutated', desc: 'Row content does not match recorded chain hash — entry was modified after the fact.' });
    }
    if (row.prev_hash !== prevHash) {
      issues.push({ id: row.id, kind: 'broken_link', desc: 'Recorded prev_hash does not match preceding entry — earlier rows may have been removed.' });
    }
    prevHash = row.entry_hash;
  }
  if (!workspaceId) return issues;
  // Per-workspace filter: keep only issues whose row belongs to this workspace.
  const wsRowIds = new Set(rows.filter(r => r.workspace_id === workspaceId).map(r => r.id));
  return issues.filter(i => wsRowIds.has(i.id));
}

// Default 5x5 risk methodology used to seed new workspaces.
function defaultMethodology() {
  return {
    name: 'Default 5x5',
    description: '5×5 likelihood × impact matrix with low/medium/high/critical bands.',
    likelihood_scale: [
      { value: 1, label: 'Rare',          description: 'May occur only in exceptional circumstances' },
      { value: 2, label: 'Unlikely',      description: 'Could occur at some time' },
      { value: 3, label: 'Possible',      description: 'Might occur at some time' },
      { value: 4, label: 'Likely',        description: 'Will probably occur in most circumstances' },
      { value: 5, label: 'Almost certain',description: 'Expected to occur in most circumstances' }
    ],
    impact_scale: [
      { value: 1, label: 'Insignificant', description: 'Minor inconvenience, no measurable damage' },
      { value: 2, label: 'Minor',         description: 'Limited internal impact, easily contained' },
      { value: 3, label: 'Moderate',      description: 'Noticeable disruption, recovery within days' },
      { value: 4, label: 'Major',         description: 'Significant business / regulatory impact' },
      { value: 5, label: 'Severe',        description: 'Existential / catastrophic impact' }
    ],
    // matrix[likelihood-1][impact-1] -> band key
    matrix: [
      ['low','low','low','medium','medium'],
      ['low','low','medium','medium','high'],
      ['low','medium','medium','high','high'],
      ['medium','medium','high','high','critical'],
      ['medium','high','high','critical','critical']
    ],
    thresholds: {
      low:      { color: '#16a34a', action: 'Accept',                 review_months: 24 },
      medium:   { color: '#ca8a04', action: 'Treat or accept',        review_months: 12 },
      high:     { color: '#ea580c', action: 'Treat (mitigate)',       review_months: 6 },
      critical: { color: '#b91c1c', action: 'Treat or transfer ASAP', review_months: 3 }
    }
  };
}

function ensureWorkspaceMethodology(wsId) {
  const existing = db.prepare(`SELECT id FROM risk_methodologies WHERE workspace_id=? AND is_active=1`).get(wsId);
  if (existing) return existing.id;
  const m = defaultMethodology();
  const id = db.prepare(`INSERT INTO risk_methodologies (workspace_id, name, description, likelihood_scale, impact_scale, matrix, thresholds, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
      wsId, m.name, m.description,
      JSON.stringify(m.likelihood_scale),
      JSON.stringify(m.impact_scale),
      JSON.stringify(m.matrix),
      JSON.stringify(m.thresholds)
    ).lastInsertRowid;
  return id;
}

function getActiveMethodology(wsId) {
  ensureWorkspaceMethodology(wsId);
  const row = db.prepare(`SELECT * FROM risk_methodologies WHERE workspace_id=? AND is_active=1`).get(wsId);
  return {
    ...row,
    likelihood_scale: JSON.parse(row.likelihood_scale),
    impact_scale: JSON.parse(row.impact_scale),
    matrix: JSON.parse(row.matrix),
    thresholds: JSON.parse(row.thresholds)
  };
}

function methodologyBand(m, likelihood, impact) {
  const l = Math.max(1, Math.min(m.likelihood_scale.length, parseInt(likelihood) || 1));
  const i = Math.max(1, Math.min(m.impact_scale.length, parseInt(impact) || 1));
  return m.matrix[l - 1][i - 1];
}

module.exports = {
  db, init, logAction, verifyAuditChain,
  defaultMethodology, ensureWorkspaceMethodology, getActiveMethodology, methodologyBand
};
