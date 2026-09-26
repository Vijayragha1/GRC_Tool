-- 061_evidence_ai_retrieval.sql
-- Durable, tenant-qualified semantic index for Evidence Library uploads.
--
-- The index is derived operational data, not assessment evidence. Raw chunk
-- text is deliberately not persisted here: deterministic extraction and the
-- ordinal/hash pair let the query path reconstruct and integrity-check only
-- the candidate chunks needed for reranking. Embeddings are normalized
-- Float32LE vectors for the fixed 2,048-dimension retrieval contract.

-- SQLite requires the parent columns of a composite foreign key to be covered
-- by one PRIMARY KEY or UNIQUE constraint with the same column order. Migration
-- 045 creates this index; repeat the idempotent declaration so this migration's
-- tenant boundary remains explicit and independently reviewable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_workspace_id
  ON evidence(workspace_id,id);

CREATE TABLE IF NOT EXISTS evidence_ai_indexes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,

  source_sha256 TEXT NOT NULL,
  source_size_bytes INTEGER NOT NULL CHECK(source_size_bytes >= 0),
  extracted_text_sha256 TEXT,
  extractor_version TEXT NOT NULL,
  chunker_version TEXT NOT NULL,

  embedding_provider TEXT NOT NULL,
  embedding_model_requested TEXT NOT NULL,
  embedding_model_canonical TEXT,
  embedding_dimensions INTEGER NOT NULL CHECK(embedding_dimensions = 2048),
  vector_format TEXT NOT NULL CHECK(vector_format = 'float32le-v1'),
  pipeline_key TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','processing','ready','failed','stale','unsupported')),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0),
  extracted_character_count INTEGER NOT NULL DEFAULT 0
    CHECK(extracted_character_count >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),

  external_processing_acknowledged INTEGER NOT NULL DEFAULT 1
    CHECK(external_processing_acknowledged = 1),
  disclosure_version TEXT NOT NULL,
  authorization_scope TEXT NOT NULL
    CHECK(authorization_scope IN ('single_upload','bulk_upload','manual_index','workspace_auto_index')),
  authorized_by INTEGER NOT NULL,
  authorized_at TEXT NOT NULL,

  -- One provider submission per row. A manual retry creates another retained
  -- row after the failed row leaves the partial active-identity index below.
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count IN (0,1)),
  claimed_at TEXT,
  lease_expires_at TEXT,
  ready_at TEXT,
  failed_at TEXT,
  stale_at TEXT,
  last_error_code TEXT,
  last_error_redacted TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(workspace_id,evidence_id,id),
  FOREIGN KEY(workspace_id,evidence_id)
    REFERENCES evidence(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(authorized_by) REFERENCES users(id) ON DELETE NO ACTION,

  CHECK(length(source_sha256) = 64
    AND source_sha256 = lower(source_sha256)
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(extracted_text_sha256 IS NULL OR (
    length(extracted_text_sha256) = 64
    AND extracted_text_sha256 = lower(extracted_text_sha256)
    AND extracted_text_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(pipeline_key) = 64
    AND pipeline_key = lower(pipeline_key)
    AND pipeline_key NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(trim(extractor_version)) BETWEEN 1 AND 120),
  CHECK(length(trim(chunker_version)) BETWEEN 1 AND 120),
  CHECK(length(trim(embedding_provider)) BETWEEN 1 AND 120),
  CHECK(length(trim(embedding_model_requested)) BETWEEN 1 AND 300),
  CHECK(embedding_model_canonical IS NULL
    OR length(trim(embedding_model_canonical)) BETWEEN 1 AND 300),
  CHECK(length(trim(disclosure_version)) BETWEEN 1 AND 160),
  CHECK(length(trim(authorized_at)) >= 10),
  CHECK(last_error_code IS NULL OR length(last_error_code) <= 160),
  CHECK(last_error_redacted IS NULL OR length(last_error_redacted) <= 1000),

  CHECK(
    (status = 'queued'
      AND attempt_count = 0
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND ready_at IS NULL
      AND failed_at IS NULL
      AND stale_at IS NULL)
    OR
    (status = 'processing'
      AND attempt_count = 1
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND ready_at IS NULL
      AND failed_at IS NULL
      AND stale_at IS NULL)
    OR
    (status = 'ready'
      AND attempt_count = 1
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND ready_at IS NOT NULL
      AND failed_at IS NULL
      AND stale_at IS NULL
      AND extracted_text_sha256 IS NOT NULL
      AND embedding_model_canonical IS NOT NULL
      AND extracted_character_count > 0
      AND chunk_count > 0
      AND last_error_code IS NULL
      AND last_error_redacted IS NULL)
    OR
    (status IN ('failed','unsupported')
      AND attempt_count = 1
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND ready_at IS NULL
      AND failed_at IS NOT NULL
      AND stale_at IS NULL
      AND last_error_code IS NOT NULL)
    OR
    (status = 'stale'
      AND lease_expires_at IS NULL
      AND stale_at IS NOT NULL)
  )
);

-- Prevent duplicate queued/processing/ready work for the same evidence bytes
-- and embedding pipeline while retaining failed and stale attempt history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_ai_indexes_active_identity
  ON evidence_ai_indexes(workspace_id,evidence_id,source_sha256,pipeline_key)
  WHERE status IN ('queued','processing','ready');

CREATE INDEX IF NOT EXISTS idx_evidence_ai_indexes_work
  ON evidence_ai_indexes(status,lease_expires_at,created_at);

CREATE INDEX IF NOT EXISTS idx_evidence_ai_indexes_workspace_ready
  ON evidence_ai_indexes(workspace_id,status,pipeline_key,evidence_id);

CREATE INDEX IF NOT EXISTS idx_evidence_ai_indexes_evidence
  ON evidence_ai_indexes(workspace_id,evidence_id,status,created_at);

CREATE TABLE IF NOT EXISTS evidence_ai_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  index_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  chunk_sha256 TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(index_id,ordinal),
  FOREIGN KEY(workspace_id,evidence_id,index_id)
    REFERENCES evidence_ai_indexes(workspace_id,evidence_id,id)
    ON DELETE CASCADE,

  CHECK(length(chunk_sha256) = 64
    AND chunk_sha256 = lower(chunk_sha256)
    AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(typeof(embedding) = 'blob' AND length(embedding) = 8192)
);

CREATE INDEX IF NOT EXISTS idx_evidence_ai_chunks_workspace_index
  ON evidence_ai_chunks(workspace_id,index_id,ordinal);

-- Source, model, pipeline and consent identity are immutable. A retry is a new
-- attempt row with fresh authorization, never a rewrite of retained lineage.
CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_identity_immutable
BEFORE UPDATE OF
  workspace_id,evidence_id,source_sha256,source_size_bytes,
  extractor_version,chunker_version,embedding_provider,
  embedding_model_requested,embedding_dimensions,vector_format,pipeline_key,
  external_processing_acknowledged,disclosure_version,authorization_scope,
  authorized_by,authorized_at,created_at
ON evidence_ai_indexes
BEGIN
  SELECT RAISE(ABORT,'evidence AI index identity and authorization are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_transition
BEFORE UPDATE OF status ON evidence_ai_indexes
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('processing','stale'))
  OR (OLD.status = 'processing' AND NEW.status IN ('ready','failed','stale','unsupported'))
  OR (OLD.status = 'ready' AND NEW.status = 'stale')
)
BEGIN
  SELECT RAISE(ABORT,'invalid evidence AI index status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_version
BEFORE UPDATE ON evidence_ai_indexes
WHEN NEW.row_version <> OLD.row_version + 1
BEGIN
  SELECT RAISE(ABORT,'evidence AI index update requires the next row version');
END;

-- A generation cannot become queryable unless its persisted chunk count is
-- complete. The surrounding application transaction owns all-or-nothing
-- insertion of the vectors and the ready transition.
CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_ready_chunks
BEFORE UPDATE OF status ON evidence_ai_indexes
WHEN NEW.status = 'ready'
 AND OLD.status <> 'ready'
 AND NEW.chunk_count <> (
   SELECT COUNT(*) FROM evidence_ai_chunks c
   WHERE c.workspace_id = NEW.workspace_id
     AND c.evidence_id = NEW.evidence_id
     AND c.index_id = NEW.id
 )
BEGIN
  SELECT RAISE(ABORT,'evidence AI index chunk count is incomplete');
END;

-- Chunk rows may only be staged while their exact tenant-qualified generation
-- is being processed. Once written they are immutable derived data.
CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_chunk_processing_parent
BEFORE INSERT ON evidence_ai_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM evidence_ai_indexes i
  WHERE i.workspace_id = NEW.workspace_id
    AND i.evidence_id = NEW.evidence_id
    AND i.id = NEW.index_id
    AND i.status = 'processing'
)
BEGIN
  SELECT RAISE(ABORT,'evidence AI chunks require a processing parent index');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_chunk_no_update
BEFORE UPDATE ON evidence_ai_chunks
BEGIN
  SELECT RAISE(ABORT,'evidence AI chunks are immutable');
END;

-- Supersession or any source-identity mutation makes queued, in-flight and
-- ready generations ineligible immediately. Hard deletion uses the composite
-- foreign-key cascade and removes this derived index with its evidence row.
CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_source_stale
AFTER UPDATE OF workspace_id,stored_path,sha256,size_bytes,superseded_at ON evidence
FOR EACH ROW
WHEN NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.stored_path IS NOT OLD.stored_path
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.superseded_at IS NOT OLD.superseded_at
BEGIN
  UPDATE evidence_ai_indexes
     SET status = 'stale',
         lease_expires_at = NULL,
         stale_at = datetime('now'),
         last_error_code = COALESCE(last_error_code,'evidence_source_changed'),
         last_error_redacted = COALESCE(last_error_redacted,
           'The evidence source changed or was superseded; this derived index is no longer queryable.'),
         updated_at = datetime('now'),
         row_version = row_version + 1
   WHERE workspace_id = OLD.workspace_id
     AND evidence_id = OLD.id
     AND status IN ('queued','processing','ready');
END;
