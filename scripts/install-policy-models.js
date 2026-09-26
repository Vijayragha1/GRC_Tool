#!/usr/bin/env node
'use strict';

// Installs the exact local ONNX assets declared in policy-model-manifest.js.
// This is an explicit install/build step: production retrieval never downloads
// models on demand and therefore does not require runtime internet access.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const manifest = require('../lib/policy-model-manifest');

function defaultModelDir() {
  return path.resolve(process.env.POLICY_MODEL_DIR || path.join(__dirname, '..', 'data', 'ai-models', 'policy-retrieval'));
}

function parseArgs(argv) {
  let dir = defaultModelDir();
  let verifyOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) dir = path.resolve(argv[++i]);
    else if (argv[i] === '--verify-only') verifyOnly = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { dir, verifyOnly };
}

function allAssets() {
  return ['embedding', 'reranker'].flatMap(kind => {
    const model = manifest[kind];
    return model.files.map(file => ({ kind, model, file }));
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyAsset(filePath, file) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return { ok: false, reason: 'missing' }; }
  if (!stat.isFile() || stat.size !== file.size) return { ok: false, reason: 'size mismatch' };
  const digest = await sha256File(filePath);
  if (digest !== file.sha256) return { ok: false, reason: 'SHA-256 mismatch' };
  return { ok: true };
}

function modelUrl(model, file) {
  const encodedPath = file.remotePath.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${model.id}/resolve/${model.revision}/${encodedPath}`;
}

async function downloadAsset(targetDir, model, file) {
  const target = path.join(targetDir, file.name);
  const current = await verifyAsset(target, file);
  if (current.ok) {
    console.log(`[policy-models] verified ${file.name}`);
    return;
  }

  const temp = path.join(targetDir, `.${file.name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    console.log(`[policy-models] downloading ${model.id}@${model.revision.slice(0, 12)} / ${file.remotePath}`);
    const response = await fetch(modelUrl(model, file), {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Nimbus-GRC-policy-model-installer/1' }
    });
    if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    const verified = await verifyAsset(temp, file);
    if (!verified.ok) throw new Error(`${file.name}: ${verified.reason}`);
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o444);
    console.log(`[policy-models] installed ${file.name}`);
  } finally {
    clearTimeout(timeout);
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
  }
}

async function main(argv = process.argv.slice(2)) {
  const { dir, verifyOnly } = parseArgs(argv);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const { model, file } of allAssets()) {
    const target = path.join(dir, file.name);
    if (verifyOnly) {
      const result = await verifyAsset(target, file);
      if (!result.ok) throw new Error(`${file.name}: ${result.reason}`);
      console.log(`[policy-models] verified ${file.name}`);
    } else {
      await downloadAsset(dir, model, file);
    }
  }
  console.log(`[policy-models] ready in ${dir}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[policy-models] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { allAssets, defaultModelDir, modelUrl, parseArgs, sha256File, verifyAsset, main };
