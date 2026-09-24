'use strict';
// Minimal .xlsx reader: enough to read a certification body's request list.
// An .xlsx file is a zip of XML parts. This reads the zip central directory,
// inflates only the parts it needs (workbook, rels, shared strings, one
// sheet) and returns each row as an array of cell text. It does not evaluate
// formulas (it reads their cached values), styles, or merged cells.
//
// Written instead of adding a spreadsheet dependency: the one input this
// product needs to read is a flat table, and the popular parsers carry either
// unpatched advisories or a large transitive tree for features never used.

const zlib = require('zlib');

const MAX_ENTRY_BYTES = 20 * 1024 * 1024; // inflated size ceiling per part
const MAX_ENTRIES = 2000;
const MAX_ROWS = 20000;
const MAX_COLUMNS = 200;

function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a zip archive.');
  // End of central directory record: scan back over a possible comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive.');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('Workbook has too many parts.');
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Corrupt zip directory.');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const local = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compSize, size, local });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    if (e.size > MAX_ENTRY_BYTES) throw new Error(`Workbook part ${name} is too large.`);
    if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('Corrupt zip entry.');
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const raw = buf.slice(start, start + e.compSize);
    if (e.method === 0) return raw.toString('utf8');
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    throw new Error('Unsupported zip compression.');
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  }).replace(/_x000D_/g, '');
}

// Text of an <si> or <is> element: concatenate every <t>, skipping phonetic runs.
function runText(xml) {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  body.replace(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g, (m, t) => { out += t ? decode(t) : ''; return m; });
  return out;
}

function colIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetList(read) {
  const wb = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels') || '';
  if (!wb) throw new Error('This file is not an Excel workbook.');
  const targets = {};
  rels.replace(/<Relationship\b([^>]*)\/?>/g, (m, attrs) => {
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1];
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && target) targets[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
    return m;
  });
  const sheets = [];
  wb.replace(/<sheet\b([^>]*)\/?>/g, (m, attrs) => {
    const name = decode((attrs.match(/\bname="([^"]*)"/) || [])[1] || '');
    const rid = (attrs.match(/\br:id="([^"]+)"/) || attrs.match(/\bid="([^"]+)"/) || [])[1];
    sheets.push({ name, path: targets[rid] || null });
    return m;
  });
  return sheets;
}

// Opens a workbook once. `sheets` lists the sheet names in workbook order and
// `rows(name)` returns that sheet as arrays of cell text.
function openWorkbook(buf) {
  const read = readZip(buf);
  const sheets = sheetList(read);
  if (!sheets.length) throw new Error('The workbook has no readable sheet.');
  let sst = null;
  const sharedStrings = () => {
    if (sst) return sst;
    sst = [];
    const shared = read('xl/sharedStrings.xml');
    if (shared) shared.replace(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g, (m, inner) => { sst.push(inner ? runText(inner) : ''); return m; });
    return sst;
  };
  return {
    sheets: sheets.map(s => s.name),
    rows(name) {
      const target = sheets.find(s => s.name === name);
      if (!target || !target.path) throw new Error('The workbook sheet is missing.');
      return sheetRows(read(target.path), sharedStrings());
    },
  };
}

// Returns { sheets: [names], sheet, rows: [[cell text]] } for the named sheet,
// or the first sheet when no name is given.
function readSheet(buf, wantedName) {
  const book = openWorkbook(buf);
  const name = (wantedName && book.sheets.find(s => s.toLowerCase() === String(wantedName).toLowerCase())) || book.sheets[0];
  return { sheets: book.sheets, sheet: name, rows: book.rows(name) };
}

function sheetRows(xml, sst) {
  if (!xml) throw new Error('The workbook sheet is missing.');
  const rows = [];
  xml.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g, (m, attrs, inner) => {
    const rowNo = Number(((attrs || '').match(/\br="(\d+)"/) || [])[1]) || rows.length + 1;
    if (rowNo > MAX_ROWS) throw new Error(`The sheet has more than ${MAX_ROWS.toLocaleString()} rows.`);
    const cells = [];
    let next = 0;
    (inner || '').replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (cm, cattrs, cinner) => {
      const ref = (cattrs.match(/\br="([A-Z]+\d+)"/i) || [])[1];
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      if (idx < 0 || idx >= MAX_COLUMNS) return cm;
      const type = (cattrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      let value = '';
      if (type === 'inlineStr') value = runText(((cinner || '').match(/<is\b[^>]*>([\s\S]*?)<\/is>/) || [])[1] || '');
      else {
        const v = ((cinner || '').match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (v != null) value = type === 's' ? (sst[Number(v)] ?? '') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : decode(v);
      }
      cells[idx] = value;
      return cm;
    });
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    rows[rowNo - 1] = cells;
    return m;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

module.exports = { openWorkbook, readSheet };
