'use strict';

// Content-based upload validation plus an optional/required ClamAV gate.
// Browser-supplied MIME types and filename extensions are treated only as
// hints; the file header must match the claimed family before it is retained.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'json', 'xml']);
const ZIP_EXTENSIONS = new Set(['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods']);
const CFB_EXTENSIONS = new Set(['doc', 'xls', 'ppt']);

function starts(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.toString('utf8');
  if (sample.includes('\uFFFD')) return false;
  let control = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code < 32 && ![9, 10, 13].includes(code)) control++;
  }
  return sample.length === 0 || control / sample.length < 0.01;
}

function signatureMatches(ext, header) {
  if (TEXT_EXTENSIONS.has(ext)) return looksLikeText(header);
  if (ext === 'pdf') return header.slice(0, 5).toString('ascii') === '%PDF-';
  if (ext === 'png') return starts(header, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if (['jpg','jpeg'].includes(ext)) return starts(header, [0xff,0xd8,0xff]);
  if (ext === 'gif') return ['GIF87a','GIF89a'].includes(header.slice(0,6).toString('ascii'));
  if (ext === 'webp') return header.slice(0,4).toString('ascii') === 'RIFF' && header.slice(8,12).toString('ascii') === 'WEBP';
  if (ext === 'rtf') return /^\{\\rtf/.test(header.slice(0,16).toString('ascii'));
  if (ZIP_EXTENSIONS.has(ext)) return starts(header, [0x50,0x4b,0x03,0x04]) || starts(header, [0x50,0x4b,0x05,0x06]);
  if (CFB_EXTENSIONS.has(ext)) return starts(header, [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
  return false;
}

function scanWithClamAv(filePath) {
  const mode = process.env.UPLOAD_AV_MODE || (process.env.NODE_ENV === 'production' ? 'required' : 'optional');
  if (mode === 'off') return { ok: true, scanner: 'disabled' };
  const binary = process.env.CLAMAV_BIN || 'clamscan';
  const args = path.basename(binary).startsWith('clamdscan')
    ? ['--no-summary', '--fdpass', filePath]
    : ['--no-summary', filePath];
  const result = spawnSync(binary, args, {
    encoding: 'utf8', timeout: Number(process.env.CLAMAV_TIMEOUT_MS || 30000), maxBuffer: 1024 * 1024
  });
  if (result.error && result.error.code === 'ENOENT') {
    return mode === 'required'
      ? { ok: false, message: 'Evidence scanning is temporarily unavailable. Contact the engagement team.' }
      : { ok: true, scanner: 'unavailable' };
  }
  if (result.error || result.status == null || result.status > 1) {
    return mode === 'required'
      ? { ok: false, message: 'Evidence scanning could not complete. Try again or contact the engagement team.' }
      : { ok: true, scanner: 'error' };
  }
  if (result.status === 1) return { ok: false, message: 'The file was rejected by the malware scanner.' };
  return { ok: true, scanner: 'clamav' };
}

function scannerAvailable() {
  const binary = process.env.CLAMAV_BIN || 'clamscan';
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return !result.error && result.status === 0;
}

function validateUpload(file, allowedExtensions) {
  if (!file || !file.path) return { ok: false, message: 'Choose a file to upload.' };
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  if (!allowedExtensions.has(ext)) return { ok: false, message: 'This file type is not allowed.' };
  let header;
  try {
    const fd = fs.openSync(file.path, 'r');
    try {
      const size = Math.min(8192, Math.max(0, file.size || 8192));
      header = Buffer.alloc(size);
      const read = fs.readSync(fd, header, 0, size, 0);
      header = header.slice(0, read);
    } finally { fs.closeSync(fd); }
  } catch (_) {
    return { ok: false, message: 'The uploaded file could not be inspected.' };
  }
  if (!signatureMatches(ext, header)) {
    return { ok: false, message: 'The file contents do not match its extension. Export the file again and retry.' };
  }
  return scanWithClamAv(file.path);
}

module.exports = { validateUpload, signatureMatches, scanWithClamAv, scannerAvailable };
