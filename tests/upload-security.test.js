'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const uploadSecurity = require('../lib/upload-security');

test('upload validation checks content signatures rather than trusting names', () => {
  const previous = process.env.UPLOAD_AV_MODE;
  process.env.UPLOAD_AV_MODE = 'off';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-security-'));
  try {
    const fakePdf = path.join(dir, 'fake.pdf');
    fs.writeFileSync(fakePdf, '<script>alert(1)</script>');
    const rejected = uploadSecurity.validateUpload({ path: fakePdf, originalname: 'evidence.pdf', size: 25 }, new Set(['pdf']));
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /do not match/i);

    const realPdf = path.join(dir, 'real.pdf');
    fs.writeFileSync(realPdf, '%PDF-1.7\n% test document');
    assert.equal(uploadSecurity.validateUpload({ path: realPdf, originalname: 'evidence.pdf', size: 24 }, new Set(['pdf'])).ok, true);

    const executable = path.join(dir, 'payload.exe');
    fs.writeFileSync(executable, 'MZ');
    assert.equal(uploadSecurity.validateUpload({ path: executable, originalname: 'payload.exe', size: 2 }, new Set(['pdf'])).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.UPLOAD_AV_MODE;
    else process.env.UPLOAD_AV_MODE = previous;
  }
});
