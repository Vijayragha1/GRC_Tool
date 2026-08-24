-- Bounded operational counters for the public TPRM monitoring ingress.
-- These rows deliberately aggregate untrusted traffic rather than creating an
-- immutable connector-run row for every bad signature or malformed request.
CREATE TABLE IF NOT EXISTS tprm_webhook_ingress_buckets (
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  source_key_hash TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count>=0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK(rejected_count>=0),
  last_rejection_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,connector_id,source_key_hash),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  CHECK(length(source_key_hash)=64 AND source_key_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(last_rejection_code IS NULL OR (
    length(last_rejection_code) BETWEEN 3 AND 100
    AND last_rejection_code NOT GLOB '*[^A-Z0-9_]*'
  ))
);

CREATE INDEX IF NOT EXISTS idx_tprm_webhook_ingress_bucket_retention
  ON tprm_webhook_ingress_buckets(updated_at);

CREATE TRIGGER IF NOT EXISTS trg_tprm_webhook_bucket_identity
BEFORE UPDATE OF workspace_id,connector_id,source_key_hash
ON tprm_webhook_ingress_buckets
BEGIN
  SELECT RAISE(ABORT,'TPRM webhook ingress bucket identity is immutable');
END;
