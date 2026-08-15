-- 033_asset_edit_concurrency.sql
-- Asset-register edits need optimistic concurrency and a durable modification
-- timestamp. A monotonically increasing version avoids same-second collisions.

ALTER TABLE assets ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN updated_at DATETIME;
ALTER TABLE assets ADD COLUMN updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

UPDATE assets SET updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP);
