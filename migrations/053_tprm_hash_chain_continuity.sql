-- Enforce append-only hash-chain continuity at the database boundary. The
-- services already calculate these hashes; these triggers prevent a direct SQL
-- writer from omitting a hash or forking a second predecessor.

CREATE TRIGGER IF NOT EXISTS trg_tprm_lifecycle_event_hash_required
BEFORE INSERT ON tprm_lifecycle_events
WHEN NEW.event_hash IS NULL
BEGIN
  SELECT RAISE(ABORT,'TPRM lifecycle event hash is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_lifecycle_event_chain_predecessor
BEFORE INSERT ON tprm_lifecycle_events
WHEN NEW.previous_event_hash IS NOT (
  SELECT event_hash FROM tprm_lifecycle_events
  WHERE workspace_id=NEW.workspace_id
    AND module_id=NEW.module_id
    AND supplier_id IS NEW.supplier_id
    AND event_hash IS NOT NULL
  ORDER BY id DESC LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT,'TPRM lifecycle event hash-chain predecessor is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_hash_required
BEFORE INSERT ON tprm_relationship_events
WHEN NEW.event_hash IS NULL
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship event hash is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_chain_predecessor
BEFORE INSERT ON tprm_relationship_events
WHEN NEW.previous_event_hash IS NOT (
  SELECT event_hash FROM tprm_relationship_events
  WHERE workspace_id=NEW.workspace_id
    AND relationship_id IS NEW.relationship_id
    AND event_hash IS NOT NULL
  ORDER BY id DESC LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship event hash-chain predecessor is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_chain_predecessor
BEFORE INSERT ON tprm_recommendation_draft_events
WHEN NEW.previous_event_hash IS NOT (
  SELECT event_hash FROM tprm_recommendation_draft_events
  WHERE workspace_id=NEW.workspace_id AND draft_id=NEW.draft_id
  ORDER BY id DESC LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft event hash-chain predecessor is invalid');
END;
