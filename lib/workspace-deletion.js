'use strict';

// Workspace deletion is an explicit tenant-lifecycle operation. Normal record
// deletion must continue to respect immutable-history triggers, but those same
// triggers must not make it impossible to remove an entire client workspace.
//
// SQLite schema changes are transactional. We therefore suspend only the
// mutation triggers that deliberately abort changes, remove every
// workspace-scoped record, and restore every trigger before committing. The
// write transaction holds the schema/write lock throughout, so another writer
// cannot observe the database without those protections.

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function immutableMutationTriggers(db) {
  return db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type='trigger'
      AND sql IS NOT NULL
      AND (
        upper(sql) LIKE '%BEFORE DELETE%'
        OR upper(sql) LIKE '%BEFORE UPDATE%'
      )
      AND upper(sql) LIKE '%RAISE(ABORT%'
    ORDER BY name
  `).all();
}

function workspaceScopedTables(db) {
  // Do not use a correlated pragma_table_info() query here. Both the outer
  // sqlite_master result and pragma output expose a `name` column, which can
  // make SQLite resolve the table argument ambiguously and silently omit
  // tables such as audit_log. Inspecting each table explicitly is slower by a
  // few milliseconds but deterministic for this rare lifecycle operation.
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name != 'workspaces'
    ORDER BY name
  `).all()
    .filter(({ name }) => db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all()
      .some(column => column.name === 'workspace_id'))
    .map(row => row.name);
}

function workspaceStoredPaths(db, workspace) {
  const id = Number(workspace && workspace.id);
  if (!Number.isInteger(id) || id < 1) throw new TypeError('A valid workspace is required.');

  const paths = new Set();
  const addRows = sql => {
    for (const row of db.prepare(sql).all(id)) {
      const storedPath = String(row.stored_path || '').trim();
      if (storedPath) paths.add(storedPath);
    }
  };

  // These columns represent retained uploads rather than generated blobs.
  // Collect them before the database transaction removes their owning rows.
  addRows('SELECT stored_path FROM evidence WHERE workspace_id=? AND stored_path IS NOT NULL');
  addRows('SELECT source_stored_path AS stored_path FROM generated_docs WHERE workspace_id=? AND source_stored_path IS NOT NULL');
  addRows('SELECT stored_path FROM questionnaire_attachments WHERE workspace_id=? AND stored_path IS NOT NULL');
  addRows('SELECT stored_path FROM supplier_ddq_evidence WHERE workspace_id=? AND stored_path IS NOT NULL');
  addRows('SELECT stored_path FROM supplier_documents WHERE workspace_id=? AND stored_path IS NOT NULL');

  const logoPath = String(workspace.brand_logo_path || '').trim();
  if (logoPath) paths.add(logoPath);
  return [...paths];
}

function deleteWorkspace(db, workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id < 1) throw new TypeError('A valid workspace id is required.');

  const purge = db.transaction(() => {
    const workspace = db.prepare('SELECT firm_id FROM workspaces WHERE id=?').get(id);
    if (!workspace) throw new Error('Workspace no longer exists.');
    const triggers = immutableMutationTriggers(db);
    const scopedTables = workspaceScopedTables(db);

    // The schema intentionally has cross-links between workspace records, for
    // example evidence referenced by remediation actions. Defer those checks
    // until every workspace-scoped table has been cleared, while keeping
    // foreign-key enforcement enabled for the final commit.
    db.pragma('defer_foreign_keys = ON');

    for (const trigger of triggers) {
      db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
    }

    for (const table of scopedTables) {
      db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE workspace_id=?`).run(id);
    }

    const deleted = db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
    if (deleted.changes !== 1) throw new Error('Workspace no longer exists.');

    // Firm onboarding is a live first-client signal. If the final client is
    // deliberately removed, preserve an explicit dismissal but invalidate a
    // prior completion so the neutral create-client guide can become current
    // again. Keep this in the purge transaction so the two states cannot drift.
    const onboardingTable = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='tenant_onboarding'`).get();
    const hasRemainingClient = db.prepare('SELECT 1 FROM workspaces WHERE firm_id=? LIMIT 1').get(workspace.firm_id);
    if (onboardingTable && !hasRemainingClient) {
      db.prepare('UPDATE tenant_onboarding SET completed_at=NULL WHERE firm_id=?').run(workspace.firm_id);
    }

    for (const trigger of triggers) db.exec(trigger.sql);

    return {
      workspaceId: id,
      suspendedTriggers: triggers.length,
      clearedTables: scopedTables.length,
    };
  });

  return purge();
}

module.exports = {
  deleteWorkspace,
  immutableMutationTriggers,
  workspaceScopedTables,
  workspaceStoredPaths,
};
