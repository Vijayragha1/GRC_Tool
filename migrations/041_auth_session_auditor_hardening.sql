-- 041_auth_session_auditor_hardening.sql
-- Account-recovery sessions are epoch-bound and auditor credentials are
-- represented by one-way digests. Keep every schema change in this migration
-- so `npm run migrate` and application startup produce the same schema.

ALTER TABLE users ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;
UPDATE users SET auth_epoch = 0 WHERE auth_epoch IS NULL;

ALTER TABLE auditor_shares ADD COLUMN token_hash TEXT;
ALTER TABLE auditor_shares ADD COLUMN token_last4 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auditor_shares_token_hash
  ON auditor_shares(token_hash)
  WHERE token_hash IS NOT NULL;
