// Thin DB-driver abstraction so the same query layer can run against
// SQLite (default) or Postgres (if `DATABASE_URL` is set and `pg` is installed).
//
// This module is INTENTIONALLY thin: it wraps prepare/run/get/all so the
// rest of the codebase keeps working unchanged. Postgres support means the
// app can be run against an HA-capable database; we don't rewrite every
// query — instead we translate `?` placeholders to `$1, $2, …` on the fly.

const path = require('path');

let driver = 'sqlite';
let pgPool = null;

function init(opts = {}) {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')) {
    try {
      const { Pool } = require('pg');
      pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
      driver = 'postgres';
      console.log('[dal] Postgres driver active.');
      return;
    } catch (e) {
      console.warn('[dal] DATABASE_URL set but pg module not installed — `npm i pg` to enable Postgres. Falling back to SQLite.');
    }
  }
  driver = 'sqlite';
}

function paramize(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

// Executes a SQL with the active driver. Returns { rows: [...] }.
async function query(sql, params = []) {
  if (driver === 'postgres') {
    const r = await pgPool.query(paramize(sql), params);
    return { rows: r.rows, rowCount: r.rowCount };
  }
  // SQLite path is synchronous; wrap return shape to match
  const Database = require('better-sqlite3');
  // Reuse the project's existing connection
  const { db } = require('../db');
  const stmt = db.prepare(sql);
  if (/^\s*select/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    return { rows: stmt.all(...params) };
  }
  const info = stmt.run(...params);
  return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
}

function getDriver() { return driver; }

module.exports = { init, query, getDriver };
