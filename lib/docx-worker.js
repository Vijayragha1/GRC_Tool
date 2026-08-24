'use strict';
// Worker-thread entry for DOCX generation. See lib/workers.js.
const { parentPort } = require('node:worker_threads');
const htmlToDocx = require('html-to-docx');
const { generateDocxBuffer } = require('./docx-gen');

// html-to-docx 1.1.x contains an unconditional console.log(headerEnabled)
// in its conversion path. Keep the pinned converter, but prevent its bare
// true/false debug value from polluting application and test logs. Each worker
// handles only one dispatched job at a time, so the scoped override cannot
// overlap another conversion in this thread.
async function convertHtmlQuietly(html, headerHtml, options) {
  const originalLog = console.log;
  console.log = (...args) => {
    if (args.length === 1 && typeof args[0] === 'boolean') return;
    originalLog(...args);
  };
  try {
    return await htmlToDocx(html, headerHtml, options);
  } finally {
    console.log = originalLog;
  }
}

parentPort.on('message', async (job) => {
  try {
    const result = job.kind === 'html'
      ? await convertHtmlQuietly(job.html, job.headerHtml || null, job.options || {})
      : await generateDocxBuffer(job.doc, job.ws);
    // html-to-docx 1.1.x returns a standards-based Blob on newer Node
    // runtimes, while later releases returned Buffer. Normalize at the worker
    // boundary so callers always receive bytes and the safer pinned package
    // can be used without coupling the rest of the application to its return
    // type.
    const buf = Buffer.isBuffer(result)
      ? result
      : result && typeof result.arrayBuffer === 'function'
        ? Buffer.from(await result.arrayBuffer())
        : Buffer.from(result);
    parentPort.postMessage({ id: job.id, ok: true, buf });
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, error: e.message });
  }
});
