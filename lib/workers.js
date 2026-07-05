'use strict';
// Small worker-thread pool for CPU-bound document generation. html-to-docx
// spends hundreds of ms of pure CPU per document; on the single-threaded main
// loop that blocks every other user (synchronous better-sqlite3 makes the
// event loop the whole app). The transform is pure (lib/docx-gen.js), so
// workers need no database connection: jobs and results are structured-cloned
// across the thread boundary.
//
//   const { generateDocx } = require('./lib/workers');
//   const buf = await generateDocx(doc, ws);
//
// Pool size 2: enough to keep a pack build off the hot path without starving
// the main thread on small machines. Workers respawn on crash; jobs queued
// while all workers are busy run FIFO.

const { Worker } = require('node:worker_threads');
const path = require('path');

const POOL_SIZE = 2;
const WORKER_FILE = path.join(__dirname, 'docx-worker.js');

let seq = 0;
const idle = [];
const queue = [];        // [{ job, resolve, reject }]
const inflight = new Map(); // worker -> { id, resolve, reject }

function spawn() {
  const w = new Worker(WORKER_FILE);
  w.unref(); // an idle pool must not hold the process open (tests, scripts)
  w.on('message', (msg) => {
    const cur = inflight.get(w);
    if (!cur || msg.id !== cur.id) return;
    inflight.delete(w);
    if (msg.ok) cur.resolve(Buffer.from(msg.buf));
    else cur.reject(new Error(msg.error));
    dispatch(w);
  });
  w.on('error', (err) => {
    const cur = inflight.get(w);
    inflight.delete(w);
    if (cur) cur.reject(err);
    replace(w);
  });
  w.on('exit', (code) => {
    const cur = inflight.get(w);
    inflight.delete(w);
    if (cur) cur.reject(new Error(`docx worker exited (code ${code})`));
    replace(w, true);
  });
  return w;
}

function replace(dead, exited) {
  const i = idle.indexOf(dead);
  if (i !== -1) idle.splice(i, 1);
  if (!exited) { try { dead.terminate(); } catch (_) {} }
  const fresh = spawn();
  dispatch(fresh);
}

function dispatch(w) {
  const next = queue.shift();
  if (!next) { if (!idle.includes(w)) idle.push(w); return; }
  inflight.set(w, next);
  w.postMessage(next.msg);
}

let started = false;
function ensurePool() {
  if (started) return;
  started = true;
  for (let i = 0; i < POOL_SIZE; i++) idle.push(spawn());
}

function run(msg) {
  ensurePool();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const job = { id, msg: { ...msg, id }, resolve, reject };
    const w = idle.pop();
    if (w) { inflight.set(w, job); w.postMessage(job.msg); }
    else queue.push(job);
  });
}

// Plain-object snapshots: worker messages are structured-cloned; strip
// anything non-cloneable from DB rows.
function generateDocx(doc, ws) {
  return run({ kind: 'doc', doc: JSON.parse(JSON.stringify(doc)), ws: { client_name: ws.client_name } });
}

// Raw html-to-docx on the pool, same signature as the library.
function htmlToDocxPooled(html, headerHtml, options) {
  return run({ kind: 'html', html, headerHtml: headerHtml || null, options: options || {} });
}

module.exports = { generateDocx, htmlToDocxPooled };
