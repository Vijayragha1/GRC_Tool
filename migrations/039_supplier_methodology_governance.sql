-- Governed supplier methodology versions and exact assessment snapshots.
-- Published definitions are immutable. A workspace activates one published
-- version, and every assessment retains the definition it started with.

ALTER TABLE supplier_risk_methodologies ADD COLUMN definition_json TEXT;
ALTER TABLE supplier_risk_methodologies ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE supplier_risk_methodologies ADD COLUMN content_hash TEXT;
ALTER TABLE supplier_risk_methodologies ADD COLUMN supersedes_id INTEGER REFERENCES supplier_risk_methodologies(id);
ALTER TABLE supplier_risk_methodologies ADD COLUMN published_by INTEGER REFERENCES users(id);
ALTER TABLE supplier_risk_methodologies ADD COLUMN published_at TEXT;

ALTER TABLE supplier_inherent_assessments ADD COLUMN methodology_id INTEGER REFERENCES supplier_risk_methodologies(id);
ALTER TABLE supplier_inherent_assessments ADD COLUMN methodology_snapshot_json TEXT;
ALTER TABLE supplier_inherent_assessments ADD COLUMN methodology_hash TEXT;

ALTER TABLE supplier_ddq_assessments ADD COLUMN methodology_id INTEGER REFERENCES supplier_risk_methodologies(id);
ALTER TABLE supplier_ddq_assessments ADD COLUMN methodology_snapshot_json TEXT;
ALTER TABLE supplier_ddq_assessments ADD COLUMN methodology_hash TEXT;
ALTER TABLE supplier_ddq_assessments ADD COLUMN delivery_status TEXT;
ALTER TABLE supplier_ddq_assessments ADD COLUMN delivery_provider TEXT;
ALTER TABLE supplier_ddq_assessments ADD COLUMN delivery_error TEXT;
ALTER TABLE supplier_ddq_assessments ADD COLUMN email_outbox_id INTEGER REFERENCES email_outbox(id);
ALTER TABLE supplier_ddq_assessments ADD COLUMN last_delivery_at TEXT;

ALTER TABLE supplier_contract_reviews ADD COLUMN methodology_id INTEGER REFERENCES supplier_risk_methodologies(id);
ALTER TABLE supplier_contract_reviews ADD COLUMN methodology_snapshot_json TEXT;
ALTER TABLE supplier_contract_reviews ADD COLUMN methodology_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_supplier_methodology_status
  ON supplier_risk_methodologies(workspace_id,status,version DESC);

CREATE TRIGGER IF NOT EXISTS trg_supplier_methodology_published_definition_immutable
BEFORE UPDATE OF name,domain_weights,control_weights,thresholds,review_cadence,definition_json,content_hash
ON supplier_risk_methodologies
WHEN OLD.status='published'
BEGIN
  SELECT RAISE(ABORT,'published supplier methodology is immutable');
END;
