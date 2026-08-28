'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-runtime-safety-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(runtimeDir, 'runtime.db');
process.env.ISMS_BACKUP_DIR = path.join(runtimeDir, 'backups');
process.env.ISMS_KEY_FILE = path.join(runtimeDir, 'master.key');
process.env.ISMS_MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
process.env.ALLOW_INSECURE_DEFAULTS = '1';
process.env.UPLOAD_AV_MODE = 'disabled';

const unhandledListenersBeforeRequire = process.listenerCount('unhandledRejection');
const runtime = require('../server');
const unhandledListenersAfterRequire = process.listenerCount('unhandledRejection');
const jobs = require('../lib/jobs');
const workers = require('../lib/workers');

after(async () => {
  jobs.stop();
  await workers.close({ timeoutMs: 100, force: true });
  if (runtime.db.open) runtime.db.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

test('expired workspace overrides are excluded by the authorization lookup', () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE workspace_role_overrides (
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    permission TEXT NOT NULL,
    granted INTEGER NOT NULL,
    expires_at TEXT
  );
  INSERT INTO workspace_role_overrides VALUES (1, 7, 'active_without_expiry', 1, NULL);
  INSERT INTO workspace_role_overrides VALUES (1, 7, 'active_future', 1, datetime('now', '+1 hour'));
  INSERT INTO workspace_role_overrides VALUES (1, 7, 'expired_grant', 1, datetime('now', '-1 hour'));
  INSERT INTO workspace_role_overrides VALUES (1, 8, 'different_user', 1, NULL);`);

  try {
    const permissions = runtime.activeOverridesFor(database, 1, 7).map(row => row.permission).sort();
    assert.deepEqual(permissions, ['active_future', 'active_without_expiry']);
  } finally {
    database.close();
  }
});

test('importing the app does not install a process-level unhandled rejection handler', () => {
  assert.equal(unhandledListenersAfterRequire, unhandledListenersBeforeRequire);
});

test('rejected async route reaches an opaque, request-correlated 500 response', async () => {
  const app = express();
  runtime.installAsyncRouteSafety(app);
  app.use(runtime.requestIdMiddleware);
  app.get('/reject', async () => {
    await Promise.resolve();
    throw new Error('private database failure detail');
  });
  app.use(runtime.opaqueErrorHandler);

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('listening', () => resolve(listener));
    listener.once('error', reject);
  });
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);

  try {
    const address = server.address();
    const secretQuery = 'reset_token=must-not-enter-logs';
    const response = await fetch(`http://127.0.0.1:${address.port}/reject?${secretQuery}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000)
    });
    const requestId = response.headers.get('x-request-id');
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.match(requestId, /^[0-9a-f]{24}$/);
    assert.deepEqual(body, { error: 'internal_server_error', request_id: requestId });
    assert.doesNotMatch(JSON.stringify(body), /private database failure detail/);
    assert.equal(logged[0][1].path, '/reject');
    assert.doesNotMatch(JSON.stringify(logged), /must-not-enter-logs/);
  } finally {
    console.error = originalConsoleError;
    await new Promise(resolve => server.close(resolve));
  }
});

test('graceful shutdown drains in order, checkpoints once, and is idempotent', async () => {
  const calls = [];
  const server = {
    listening: true,
    close(callback) {
      calls.push('server.close');
      setImmediate(callback);
    },
    closeIdleConnections() { calls.push('server.closeIdleConnections'); }
  };
  const database = {
    open: true,
    pragma(value) { calls.push(`db.pragma:${value}`); },
    close() { calls.push('db.close'); this.open = false; }
  };
  const shutdown = runtime.createGracefulShutdown({
    server,
    database,
    jobsModule: { stop() { calls.push('jobs.stop'); } },
    workersModule: { async close() { calls.push('workers.close'); } },
    timeoutMs: 250,
    logger: { info() {}, error() {} }
  });

  const first = shutdown('SIGTERM');
  const second = shutdown('SIGINT');
  assert.strictEqual(first, second);
  const result = await first;

  assert.equal(result.timedOut, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls, [
    'jobs.stop',
    'server.close',
    'server.closeIdleConnections',
    'workers.close',
    'db.pragma:wal_checkpoint(PASSIVE)',
    'db.close'
  ]);
});

test('graceful shutdown has a hard deadline and force-closes remaining work', async () => {
  const calls = [];
  const server = {
    listening: true,
    close() { calls.push('server.close'); },
    closeIdleConnections() { calls.push('server.closeIdleConnections'); },
    closeAllConnections() { calls.push('server.closeAllConnections'); }
  };
  const database = {
    open: true,
    pragma() { calls.push('db.pragma'); },
    close() { calls.push('db.close'); this.open = false; }
  };
  const workersModule = {
    close(options) {
      calls.push(options.force ? 'workers.force' : 'workers.drain');
      return options.force ? Promise.resolve() : new Promise(() => {});
    }
  };
  const shutdown = runtime.createGracefulShutdown({
    server,
    database,
    jobsModule: { stop() { calls.push('jobs.stop'); } },
    workersModule,
    timeoutMs: 25,
    logger: { info() {}, error() {} }
  });

  const started = Date.now();
  const result = await shutdown('test-timeout');
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 1000, 'shutdown exceeded its bounded timeout');
  assert.ok(calls.includes('server.closeAllConnections'));
  assert.ok(calls.includes('workers.force'));
  assert.ok(calls.includes('db.close'));
});

test('a main-runtime unhandled rejection drains once and exits nonzero', async () => {
  const processRef = new EventEmitter();
  const calls = [];
  const remove = runtime.installUnhandledRejectionShutdown(reason => {
    calls.push(`shutdown:${reason}`);
    return Promise.resolve({ timedOut: false, errors: [] });
  }, {
    processRef,
    exit: code => calls.push(`exit:${code}`),
    logger: { error: (...args) => calls.push(`log:${args[0]}`) },
  });

  processRef.emit('unhandledRejection', new Error('fatal async failure'));
  processRef.emit('unhandledRejection', new Error('duplicate failure'));
  await new Promise(resolve => setImmediate(resolve));
  remove();

  assert.deepEqual(calls, [
    'log:[unhandledRejection] draining runtime before fatal exit',
    'shutdown:unhandledRejection',
    'exit:1',
  ]);
  assert.equal(processRef.listenerCount('unhandledRejection'), 0);
});

test('only a recent successful restore drill suppresses the retry job', () => {
  const now = Date.UTC(2026, 7, 25, 12, 0, 0);
  let drills = 0;
  const failedRecent = {
    lastDrill: () => ({ status: 'fail', ran_at: '2026-08-25 11:59:00' }),
    runDrill: () => { drills++; return { ok: false, error: 'still bad' }; },
  };
  assert.equal(jobs.jobRestoreDrill(failedRecent, () => now), 'FAILED: still bad');
  assert.equal(drills, 1);

  const successfulRecent = {
    lastDrill: () => ({
      status: 'ok', ran_at: '2026-08-25 11:59:00',
      error: JSON.stringify({ fullGenerationVerified: true }),
    }),
    runDrill: () => { drills++; return { ok: true, ms: 1 }; },
  };
  assert.equal(jobs.jobRestoreDrill(successfulRecent, () => now), 'not due');
  assert.equal(drills, 1);
});

test('scheduled jobs cancel both startup and recurring timers', () => {
  jobs.start(60);
  assert.deepEqual(jobs.status(), { startupScheduled: true, intervalScheduled: true });
  jobs.stop();
  assert.deepEqual(jobs.status(), { startupScheduled: false, intervalScheduled: false });
});

test('forced worker close rejects in-flight work and does not respawn threads', async () => {
  const work = workers.htmlToDocxPooled('<p>shutdown test</p>', null, {});
  const closing = workers.close({ timeoutMs: 0, force: true });
  await assert.rejects(work, /worker pool closed/);
  const result = await closing;

  assert.equal(result.forced, true);
  assert.deepEqual(workers.status(), {
    started: false,
    shuttingDown: false,
    workers: 0,
    idle: 0,
    queued: 0,
    inflight: 0
  });
});
