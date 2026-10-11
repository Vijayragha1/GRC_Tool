'use strict';
// The pinned html-to-docx drops headings, header cells, header rows, <em> and
// <b>, and crashes on a <strong> holding a <span>. lib/docx-html.js rewrites
// report HTML into markup it keeps; tests/iso42001-risk-register-export.test.js
// checks a real Word file through the worker.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalise } = require('../lib/docx-html');

test('header rows become the first body rows, with shaded bold cells', () => {
  assert.equal(normalise('<table><thead><tr><th width="8%">ID</th><th>Risk</th></tr></thead><tbody><tr><td>R-1</td><td>Drift</td></tr></tbody></table>'),
    '<table><tbody><tr><td width="8%" style="background-color:#F4F4F5;"><strong>ID</strong></td><td style="background-color:#F4F4F5;"><strong>Risk</strong></td></tr><tr><td>R-1</td><td>Drift</td></tr></tbody></table>');
  assert.equal(normalise('<table><thead><tr><th>Only</th></tr></thead></table>'), '<table><tbody><tr><td style="background-color:#F4F4F5;"><strong>Only</strong></td></tr></tbody></table>');
  assert.equal(normalise('<tr><th style="color:red">Kept</th></tr>'), '<tr><td style="color:red"><strong>Kept</strong></td></tr>', 'its own style is left alone');
  assert.equal(normalise('<tr><th>Line one<br><span>two</span></th></tr>'), '<tr><td style="background-color:#F4F4F5;">Line one<br><span>two</span></td></tr>',
    'markup inside is not wrapped in <strong>, which the converter cannot hold a <span> in');
});

test('headings become bold paragraphs, as text', () => {
  assert.equal(normalise('<h1>AI Risk Register</h1><h2 class="x">This <span class="meta">register</span></h2><h3>Notes &amp; more</h3>'),
    '<p><strong>AI Risk Register</strong></p><p><strong>This register</strong></p><p><strong>Notes &amp; more</strong></p>');
  assert.equal(normalise('<h2></h2>'), '');
});

test('emphasis the converter drops becomes markup it keeps, and nothing else is touched', () => {
  assert.equal(normalise('<p><em>Note</em> and <b>bold</b><br><body><blockquote>q</blockquote><embed></p>'),
    '<p><i>Note</i> and <strong>bold</strong><br><body><blockquote>q</blockquote><embed></p>');
  assert.equal(normalise('<html><head><title>T</title><style>th,td{border:1pt} h1{font-size:22pt}</style></head></html>'),
    '<html><head><title>T</title><style>th,td{border:1pt} h1{font-size:22pt}</style></head></html>');
  assert.equal(normalise(null), null);
});

test('a whole report converts without the converter failing', async () => {
  const htmlToDocx = require('html-to-docx');
  const html = normalise(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div><h1>Title</h1><h2>Section</h2>
    <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><strong>x</strong><br><span class="meta">y</span></td><td><em>z</em></td></tr></tbody></table></div></body></html>`);
  const log = console.log;
  console.log = (...a) => { if (!(a.length === 1 && typeof a[0] === 'boolean')) log(...a); };
  try {
    const out = await htmlToDocx(html, null, {});
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(await out.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString('ascii'), 'PK');
  } finally { console.log = log; }
});
