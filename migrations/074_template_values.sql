-- 074_template_values.sql
-- Values a consultant sets once per client and the tool writes into document
-- templates in place of their bracketed placeholders: who the AIMS manager is,
-- what the AI governance committee is called, the records retention period.
-- lib/template-values.js holds the list of keys and the placeholders each one
-- replaces; a value left empty keeps the placeholder for the client to fill.

CREATE TABLE IF NOT EXISTS template_values (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, key)
);
