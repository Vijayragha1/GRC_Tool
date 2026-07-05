'use strict';
// Worker-thread entry for DOCX generation. See lib/workers.js.
const { parentPort } = require('node:worker_threads');
const htmlToDocx = require('html-to-docx');
const { generateDocxBuffer } = require('./docx-gen');

parentPort.on('message', async (job) => {
  try {
    const buf = job.kind === 'html'
      ? await htmlToDocx(job.html, job.headerHtml || null, job.options || {})
      : await generateDocxBuffer(job.doc, job.ws);
    parentPort.postMessage({ id: job.id, ok: true, buf });
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, error: e.message });
  }
});
