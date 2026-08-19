'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeDisplayPunctuation } = require('../lib/typography');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATHS = ['views', 'routes', 'lib', 'data', 'scripts', 'public', 'server.js'];
const TEXT_EXTENSIONS = new Set(['.css', '.ejs', '.html', '.js', '.json', '.md', '.txt']);

function sourceFiles(entry) {
  const absolute = path.join(ROOT, entry);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(item => {
    if (item.name === 'node_modules' || item.name.startsWith('.')) return [];
    const child = path.join(absolute, item.name);
    if (item.isDirectory()) return sourceFiles(path.relative(ROOT, child));
    return TEXT_EXTENSIONS.has(path.extname(item.name)) ? [child] : [];
  });
}

test('rendered application copy never contains an em dash', () => {
  const dash = String.fromCodePoint(0x2014);
  const entity = '&' + 'mdash;';
  const rendered = normalizeDisplayPunctuation(`Before ${dash} after ${entity} done`);
  assert.equal(rendered, 'Before - after - done');
});

test('application source contains no authored em dashes', () => {
  const dash = String.fromCodePoint(0x2014);
  const entity = '&' + 'mdash;';
  const offenders = SOURCE_PATHS.flatMap(sourceFiles).filter(file => {
    const content = fs.readFileSync(file, 'utf8');
    return content.includes(dash) || content.toLowerCase().includes(entity);
  });
  assert.deepEqual(offenders, []);
});
