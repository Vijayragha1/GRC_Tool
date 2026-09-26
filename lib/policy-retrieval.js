'use strict';

// Local-only semantic search over explicitly selected controlled documents.
// No policy text, chunks, or vectors are persisted by this module. The only
// cache contains embeddings keyed by a workspace-qualified source hash and is
// process-local, bounded, and invalidated whenever source bytes change.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sanitizeHtml = require('sanitize-html');
const documentHtml = require('./document-html');
const manifest = require('./policy-model-manifest');

const LIMITS = Object.freeze({
  maxDocuments: 20,
  // Bound HTML sanitization before any parser/model work. The lower searchable
  // text limits below are applied after markup is removed.
  maxRawDocumentCharacters: 400000,
  maxRawTotalCharacters: 1000000,
  // Stored values may be AES-GCM/base64 envelopes and are therefore larger
  // than the plaintext parsed above. Preflight them before loading/decryption.
  maxStoredDocumentCharacters: 1200000,
  maxStoredTotalCharacters: 3000000,
  maxDocumentCharacters: 200000,
  maxTotalCharacters: 500000,
  maxChunksPerDocument: 80,
  chunkWords: 150,
  overlapWords: 30,
  candidateChunks: 24,
  resultPassages: 6,
  maxQueuedRuns: 4
});

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
  'to', 'was', 'what', 'when', 'where', 'which', 'who', 'will', 'with'
]);

class PolicyRetrievalError extends Error {
  constructor(message, code = 'policy_retrieval_failed', status = 500) {
    super(message);
    this.name = 'PolicyRetrievalError';
    this.code = code;
    this.status = status;
  }
}

function modelDir() {
  return path.resolve(process.env.POLICY_MODEL_DIR || path.join(__dirname, '..', 'data', 'ai-models', 'policy-retrieval'));
}

function allManifestFiles() {
  return ['embedding', 'reranker'].flatMap(kind => manifest[kind].files.map(file => ({ kind, file })));
}

function isEnabled() {
  return String(process.env.POLICY_RETRIEVAL_ENABLED || 'true').toLowerCase() !== 'false';
}

function isConfigured() {
  if (testBackend) return true;
  if (!isEnabled()) return false;
  return allManifestFiles().every(({ file }) => {
    try {
      const stat = fs.statSync(path.join(modelDir(), file.name));
      return stat.isFile() && stat.size === file.size;
    } catch (_) { return false; }
  });
}

function configurationError() {
  if (!isEnabled()) return 'Local policy retrieval is disabled by POLICY_RETRIEVAL_ENABLED=false.';
  if (!isConfigured()) return 'Local policy models are not installed. Run npm run policy-models:install, then restart Nimbus.';
  return '';
}

function modelInfo() {
  return {
    local: true,
    runtime: 'ONNX Runtime WebAssembly',
    embedding_model: manifest.embedding.id,
    embedding_revision: manifest.embedding.revision,
    reranker_model: manifest.reranker.id,
    reranker_revision: manifest.reranker.revision
  };
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function normalisePlainText(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isImportMetadataLine(value) {
  const line = normalisePlainText(value);
  return /^Imported from:/i.test(line)
    || /^Imported from PDF - formatting \(tables, headings, lists\)/i.test(line)
    || /^Conversion notes: \d+ formatting hints? from import/i.test(line)
    || /^Text extraction warning:/i.test(line);
}

function extractPolicySections(value, fallbackHeading = 'Document') {
  const safe = documentHtml.sanitizeDocumentHtml(value == null ? '' : String(value));
  const marker = 'NIMBUSPOLICYHEADING9F3A';
  const marked = safe
    .replace(/<h[1-6](?:\s[^>]*)?>/gi, `\n\n${marker}`)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|section|article|blockquote|figcaption|dt|dd)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' | ');
  const stripped = decodeEntities(sanitizeHtml(marked, { allowedTags: [], allowedAttributes: {} }));
  const lines = normalisePlainText(stripped).split('\n');
  const sections = [];
  let heading = normalisePlainText(fallbackHeading).slice(0, 240) || 'Document';
  let body = [];
  const flush = () => {
    const text = normalisePlainText(body.join('\n'));
    if (text) sections.push({ heading, text });
    body = [];
  };
  for (const line of lines) {
    if (line.startsWith(marker)) {
      flush();
      heading = normalisePlainText(line.slice(marker.length)).slice(0, 240) || heading;
    } else if (!isImportMetadataLine(line)) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function chunkDocument(
  document,
  remainingCharacters = LIMITS.maxTotalCharacters,
  remainingRawCharacters = LIMITS.maxRawTotalCharacters
) {
  const raw = String(document.content || '');
  const rawAvailable = Math.max(0, Math.min(LIMITS.maxRawDocumentCharacters, remainingRawCharacters));
  const boundedRaw = raw.slice(0, rawAvailable);
  const sections = extractPolicySections(boundedRaw, document.name);
  const available = Math.max(0, Math.min(LIMITS.maxDocumentCharacters, remainingCharacters));
  let consumed = 0;
  let truncated = raw.length > boundedRaw.length || !!document.raw_truncated;
  const chunks = [];
  const step = LIMITS.chunkWords - LIMITS.overlapWords;

  for (const section of sections) {
    if (consumed >= available || chunks.length >= LIMITS.maxChunksPerDocument) {
      truncated = true;
      break;
    }
    let sectionText = section.text;
    if (consumed + sectionText.length > available) {
      sectionText = sectionText.slice(0, Math.max(0, available - consumed));
      truncated = true;
    }
    consumed += sectionText.length;
    const words = sectionText.match(/\S+/g) || [];
    for (let start = 0; start < words.length; start += step) {
      if (chunks.length >= LIMITS.maxChunksPerDocument) { truncated = true; break; }
      const excerpt = words.slice(start, start + LIMITS.chunkWords).join(' ').trim();
      if (excerpt.length >= 8 && words.slice(start, start + LIMITS.chunkWords).length >= 2) {
        const index = chunks.length;
        const versionPart = document.version_id
          ? `version:${document.version_id}`
          : `working:${String(document.source_hash || hashText(document.content)).slice(0, 12)}`;
        const documentName = String(document.name || 'Untitled document').slice(0, 300);
        const heading = String(section.heading || document.name || '').slice(0, 240);
        chunks.push({
          document_id: Number(document.id),
          document_name: documentName,
          document_status: String(document.status || 'draft').slice(0, 80),
          version_id: document.version_id == null ? null : Number(document.version_id),
          version: document.version == null ? null : Number(document.version),
          heading,
          linked: !!document.linked,
          excerpt,
          chunk_ordinal: index,
          chunk_hash: hashText(`${documentName}\n${heading}\n${excerpt}`),
          source_ref: `document:${Number(document.id)}:${versionPart}:chunk:${index}`
        });
      }
      if (start + LIMITS.chunkWords >= words.length) break;
    }
  }

  return {
    chunks,
    characters: consumed,
    rawCharacters: boundedRaw.length,
    truncated,
    searchable: chunks.length > 0
  };
}

function parsePolicySourceRef(value) {
  const text = String(value || '');
  if (text.length > 160) {
    throw new PolicyRetrievalError('A selected policy citation is invalid.', 'policy_citation_invalid', 400);
  }
  const match = /^document:([1-9][0-9]*):(version:([1-9][0-9]*)|working:([a-f0-9]{12})):chunk:(0|[1-9][0-9]*)$/.exec(text);
  if (!match) {
    throw new PolicyRetrievalError('A selected policy citation is invalid.', 'policy_citation_invalid', 400);
  }
  const documentId = Number(match[1]);
  const versionId = match[3] ? Number(match[3]) : null;
  const ordinal = Number(match[5]);
  if (!Number.isSafeInteger(documentId) || documentId <= 0
      || (versionId != null && (!Number.isSafeInteger(versionId) || versionId <= 0))
      || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= LIMITS.maxChunksPerDocument) {
    throw new PolicyRetrievalError('A selected policy citation is invalid.', 'policy_citation_invalid', 400);
  }
  return {
    source_ref: text,
    document_id: documentId,
    version_id: versionId,
    working_sha_prefix: match[4] || null,
    ordinal
  };
}

// Rebuild a selected citation from the current governed policy bytes. The
// caller must tenant-load and integrity-check `document` first; this function
// never accepts a browser-supplied excerpt, label, heading, or hash as truth.
function materializePolicyCitation({ document, sourceRef, expectedChunkHash = '' }) {
  const parsed = parsePolicySourceRef(sourceRef);
  if (!document || Number(document.id) !== parsed.document_id) {
    throw new PolicyRetrievalError(
      'A selected policy citation is unavailable in this workspace.',
      'policy_citation_unavailable',
      409
    );
  }
  const currentVersionId = document.version_id == null ? null : Number(document.version_id);
  if (parsed.version_id != null) {
    if (currentVersionId !== parsed.version_id) {
      throw new PolicyRetrievalError(
        'A selected policy citation belongs to an older governed version.',
        'stale_policy_citation',
        409
      );
    }
  } else if (currentVersionId != null
      || !String(document.source_hash || '').startsWith(parsed.working_sha_prefix || '')) {
    throw new PolicyRetrievalError(
      'A selected working-policy citation changed after the search.',
      'stale_policy_citation',
      409
    );
  }

  const chunks = chunkDocument(document).chunks;
  const chunk = chunks[parsed.ordinal];
  if (!chunk || chunk.source_ref !== parsed.source_ref) {
    throw new PolicyRetrievalError(
      'A selected policy citation no longer matches the current document.',
      'stale_policy_citation',
      409
    );
  }
  if (expectedChunkHash && chunk.chunk_hash !== expectedChunkHash) {
    throw new PolicyRetrievalError(
      'A selected policy citation failed its integrity check.',
      'stale_policy_citation',
      409
    );
  }
  return {
    source_ref: chunk.source_ref,
    source_type: 'policy',
    document_id: Number(chunk.document_id),
    label: `Policy: ${String(chunk.document_name || 'Policy document').slice(0, 300)}${chunk.heading ? ` · ${String(chunk.heading).slice(0, 240)}` : ''}`,
    excerpt: chunk.excerpt,
    chunk_hash: chunk.chunk_hash,
    chunk_ordinal: parsed.ordinal,
    document_status: chunk.document_status,
    version_id: chunk.version_id,
    version: chunk.version,
    heading: chunk.heading,
    linked: !!chunk.linked,
    source_sha256: String(document.source_hash || '')
  };
}

function retrievalText(chunk) {
  return `${chunk.document_name || ''}\n${chunk.heading || ''}\n${chunk.excerpt || ''}`.trim();
}

function queryTerms(queries) {
  const terms = new Set();
  for (const query of queries) {
    const tokens = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
    for (const token of tokens) if (!STOP_WORDS.has(token)) terms.add(token);
  }
  return [...terms].slice(0, 80);
}

function lexicalScore(text, terms) {
  const lower = String(text || '').toLowerCase();
  if (!lower || !terms.length) return 0;
  let score = 0;
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = lower.match(new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'g'));
    if (matches) score += 1 + Math.log1p(matches.length);
  }
  return score / Math.sqrt(Math.max(1, lower.split(/\s+/).length));
}

function dot(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Number(a[i]) * Number(b[i]);
  return Number.isFinite(sum) ? sum : -1;
}

function validateVectors(vectors, expectedCount, modelLabel = 'local embedding model') {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new PolicyRetrievalError(`The ${modelLabel} returned an unexpected result.`, 'policy_embedding_failed', 503);
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length < 8 || vector.some(value => !Number.isFinite(Number(value)))) {
      throw new PolicyRetrievalError(`The ${modelLabel} returned an invalid vector.`, 'policy_embedding_failed', 503);
    }
  }
}

const embeddingCache = new Map();
const MAX_EMBEDDING_CACHE_DOCUMENTS = 40;

function cachePut(key, value) {
  if (embeddingCache.has(key)) embeddingCache.delete(key);
  embeddingCache.set(key, value);
  while (embeddingCache.size > MAX_EMBEDDING_CACHE_DOCUMENTS) {
    embeddingCache.delete(embeddingCache.keys().next().value);
  }
}

async function embeddingsForChunks(backend, chunks, documents, textForChunk = retrievalText) {
  const byDocument = new Map();
  chunks.forEach((chunk, index) => {
    if (!byDocument.has(chunk.document_id)) byDocument.set(chunk.document_id, []);
    byDocument.get(chunk.document_id).push({ chunk, index });
  });
  const vectors = new Array(chunks.length);
  const missing = [];
  const cacheNamespace = backend.cacheKey || manifest.embedding.revision;
  for (const document of documents) {
    const rows = byDocument.get(Number(document.id)) || [];
    if (!rows.length) continue;
    const cacheKey = `${Number(document.workspace_id || 0)}:${Number(document.id)}:${document.source_hash}:${cacheNamespace}`;
    const hashes = rows.map(row => row.chunk.chunk_hash);
    const cached = embeddingCache.get(cacheKey);
    if (cached && cached.hashes.length === hashes.length && cached.hashes.every((hash, i) => hash === hashes[i])) {
      rows.forEach((row, i) => { vectors[row.index] = cached.vectors[i]; });
    } else {
      missing.push({ cacheKey, hashes, rows });
    }
  }
  if (missing.length) {
    const flatRows = missing.flatMap(entry => entry.rows);
    const embedDocuments = backend.embedDocuments || backend.embed;
    if (typeof embedDocuments !== 'function') {
      throw new PolicyRetrievalError('The configured embedding backend cannot embed documents.', 'policy_embedding_failed', 503);
    }
    const embedded = await embedDocuments.call(backend, flatRows.map(row => textForChunk(row.chunk)));
    validateVectors(embedded, flatRows.length, backend.label ? `${backend.label} embedding model` : 'embedding model');
    let cursor = 0;
    for (const entry of missing) {
      const entryVectors = embedded.slice(cursor, cursor + entry.rows.length);
      entry.rows.forEach((row, i) => { vectors[row.index] = entryVectors[i]; });
      cachePut(entry.cacheKey, { hashes: entry.hashes, vectors: entryVectors });
      cursor += entry.rows.length;
    }
  }
  validateVectors(vectors, chunks.length, backend.label ? `${backend.label} embedding model` : 'embedding model');
  return vectors;
}

function rrfCandidates(chunks, denseScores, lexicalScores) {
  const denseOrder = chunks.map((_, index) => index).sort((a, b) => denseScores[b] - denseScores[a]);
  const lexicalOrder = chunks.map((_, index) => index)
    .filter(index => lexicalScores[index] > 0)
    .sort((a, b) => lexicalScores[b] - lexicalScores[a]);
  const fusion = new Map();
  denseOrder.slice(0, 60).forEach((index, rank) => fusion.set(index, (fusion.get(index) || 0) + 1 / (60 + rank + 1)));
  lexicalOrder.slice(0, 60).forEach((index, rank) => fusion.set(index, (fusion.get(index) || 0) + 1 / (60 + rank + 1)));
  return [...fusion.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LIMITS.candidateChunks)
    .map(([index, fused]) => ({ index, fused }));
}

function passageTerms(chunk) {
  return new Set(String(chunk.excerpt || '').toLowerCase().match(/[a-z0-9]{2,}/g) || []);
}

function substantiallyOverlaps(left, right) {
  if (left.document_id !== right.document_id) return false;
  const a = passageTerms(left);
  const b = passageTerms(right);
  if (!a.size || !b.size) return false;
  let common = 0;
  for (const term of a) if (b.has(term)) common++;
  return common / Math.min(a.size, b.size) >= 0.72;
}

function diversifyCandidates(ranked, chunks, limit) {
  const selected = [];
  const selectedIndexes = new Set();
  const perDocument = new Map();
  const add = candidate => {
    const chunk = chunks[candidate.index];
    selected.push(candidate);
    selectedIndexes.add(candidate.index);
    perDocument.set(chunk.document_id, (perDocument.get(chunk.document_id) || 0) + 1);
  };

  // First show the best passage from each matching document. A second pass can
  // add one more non-duplicate passage per document for useful context.
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const chunk = chunks[candidate.index];
    if (!perDocument.has(chunk.document_id)) add(candidate);
  }
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (selectedIndexes.has(candidate.index)) continue;
    const chunk = chunks[candidate.index];
    if ((perDocument.get(chunk.document_id) || 0) >= 2) continue;
    if (selected.some(existing => substantiallyOverlaps(chunk, chunks[existing.index]))) continue;
    add(candidate);
  }
  return selected;
}

let runtimePromise = null;
let testBackend = null;

function verifiedBuffer(file) {
  const filePath = path.join(modelDir(), file.name);
  let value;
  try { value = fs.readFileSync(filePath); } catch (_) {
    throw new PolicyRetrievalError(configurationError(), 'policy_models_missing', 503);
  }
  if (value.length !== file.size || crypto.createHash('sha256').update(value).digest('hex') !== file.sha256) {
    throw new PolicyRetrievalError(`Local policy model verification failed for ${file.name}. Re-run npm run policy-models:install.`, 'policy_model_integrity_failed', 503);
  }
  return value;
}

function manifestFile(kind, name) {
  const file = manifest[kind].files.find(entry => entry.name === name);
  if (!file) throw new Error(`Unknown policy model asset: ${kind}/${name}`);
  return file;
}

function truncateEncoding(encoding, maxTokens) {
  if (encoding.ids.length <= maxTokens) return encoding;
  const take = (values, finalValue) => {
    const out = values.slice(0, maxTokens);
    out[maxTokens - 1] = finalValue;
    return out;
  };
  return {
    ids: take(encoding.ids, encoding.ids[encoding.ids.length - 1]),
    attention_mask: take(encoding.attention_mask, 1),
    token_type_ids: take(encoding.token_type_ids || new Array(encoding.ids.length).fill(0),
      (encoding.token_type_ids || [0])[encoding.ids.length - 1] || 0)
  };
}

function tensorise(ort, tokenizer, texts, pairs, maxTokens) {
  const encoded = texts.map((text, index) => truncateEncoding(tokenizer.encode(String(text || ''), {
    text_pair: pairs ? String(pairs[index] || '') : null,
    add_special_tokens: true,
    return_token_type_ids: true
  }), maxTokens));
  const width = Math.max(1, ...encoded.map(row => row.ids.length));
  const size = encoded.length * width;
  const ids = new BigInt64Array(size);
  const masks = new BigInt64Array(size);
  const types = new BigInt64Array(size);
  encoded.forEach((row, batch) => {
    for (let i = 0; i < row.ids.length; i++) {
      const offset = batch * width + i;
      ids[offset] = BigInt(row.ids[i]);
      masks[offset] = BigInt(row.attention_mask[i]);
      types[offset] = BigInt((row.token_type_ids || [])[i] || 0);
    }
  });
  return {
    feeds: {
      input_ids: new ort.Tensor('int64', ids, [encoded.length, width]),
      attention_mask: new ort.Tensor('int64', masks, [encoded.length, width]),
      token_type_ids: new ort.Tensor('int64', types, [encoded.length, width])
    },
    encoded,
    width
  };
}

function normaliseVector(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map(value => value / norm);
}

async function loadRuntime() {
  if (!isConfigured()) throw new PolicyRetrievalError(configurationError(), 'policy_models_missing', 503);
  const ort = require('onnxruntime-web');
  const { Tokenizer } = require('@huggingface/tokenizers');
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, Number(process.env.POLICY_MODEL_THREADS) || 1));

  const embeddingTokenizer = new Tokenizer(
    JSON.parse(verifiedBuffer(manifestFile('embedding', 'embedding-tokenizer.json')).toString('utf8')),
    JSON.parse(verifiedBuffer(manifestFile('embedding', 'embedding-tokenizer-config.json')).toString('utf8'))
  );
  const rerankerTokenizer = new Tokenizer(
    JSON.parse(verifiedBuffer(manifestFile('reranker', 'reranker-tokenizer.json')).toString('utf8')),
    JSON.parse(verifiedBuffer(manifestFile('reranker', 'reranker-tokenizer-config.json')).toString('utf8'))
  );
  const [embeddingSession, rerankerSession] = await Promise.all([
    ort.InferenceSession.create(verifiedBuffer(manifestFile('embedding', 'embedding-model.onnx')), { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(verifiedBuffer(manifestFile('reranker', 'reranker-model.onnx')), { executionProviders: ['wasm'] })
  ]);
  const batchSize = Math.max(1, Math.min(16, Number(process.env.POLICY_MODEL_BATCH_SIZE) || 8));

  return {
    cacheKey: `${manifest.embedding.id}@${manifest.embedding.revision}`,
    async embed(texts) {
      const vectors = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const input = tensorise(ort, embeddingTokenizer, batch, null, manifest.embedding.maxTokens);
        const output = await embeddingSession.run(input.feeds);
        const hidden = output.last_hidden_state || output[embeddingSession.outputNames[0]];
        if (!hidden || hidden.dims.length !== 3 || hidden.dims[2] !== manifest.embedding.dimensions) {
          throw new PolicyRetrievalError('The local embedding model returned an unexpected tensor.', 'policy_embedding_failed', 503);
        }
        const dimensions = hidden.dims[2];
        for (let b = 0; b < batch.length; b++) {
          const vector = new Array(dimensions).fill(0);
          let weight = 0;
          for (let token = 0; token < input.width; token++) {
            const mask = Number(input.encoded[b].attention_mask[token] || 0);
            if (!mask) continue;
            weight += mask;
            const base = (b * input.width + token) * dimensions;
            for (let d = 0; d < dimensions; d++) vector[d] += Number(hidden.data[base + d]);
          }
          vectors.push(normaliseVector(vector.map(value => value / Math.max(1, weight))));
        }
      }
      return vectors;
    },
    async rerank(query, passages) {
      const scores = [];
      for (let start = 0; start < passages.length; start += batchSize) {
        const batch = passages.slice(start, start + batchSize);
        const input = tensorise(ort, rerankerTokenizer, new Array(batch.length).fill(query), batch, manifest.reranker.maxTokens);
        const output = await rerankerSession.run(input.feeds);
        const logits = output.logits || output[rerankerSession.outputNames[0]];
        if (!logits || logits.data.length !== batch.length) {
          throw new PolicyRetrievalError('The local reranker returned an unexpected tensor.', 'policy_reranker_failed', 503);
        }
        scores.push(...Array.from(logits.data, Number));
      }
      return scores;
    }
  };
}

async function backend() {
  if (testBackend) return testBackend;
  if (!runtimePromise) {
    runtimePromise = loadRuntime().catch(error => {
      runtimePromise = null;
      if (error instanceof PolicyRetrievalError) throw error;
      throw new PolicyRetrievalError(`Local policy models could not start: ${error.message}`, 'policy_model_start_failed', 503);
    });
  }
  return runtimePromise;
}

let queueTail = Promise.resolve();
let queuedRuns = 0;

async function withModelSlot(task) {
  if (queuedRuns >= LIMITS.maxQueuedRuns) {
    throw new PolicyRetrievalError('Local policy analysis is busy. Try again after the current searches finish.', 'policy_retrieval_busy', 429);
  }
  queuedRuns++;
  const previous = queueTail;
  let release;
  queueTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await task(); }
  finally {
    queuedRuns--;
    release();
  }
}

async function retrievePolicyPassages({
  documents,
  queries,
  limit = LIMITS.resultPassages,
  retrievalBackend = null,
  retrievalModels = null,
  retrievalLimitations = null,
  minimumScore: requestedMinimumScore,
  maxTotalCharacters = LIMITS.maxTotalCharacters,
  maxRawTotalCharacters = LIMITS.maxRawTotalCharacters,
  includeDocumentNames = true
}) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new PolicyRetrievalError('Select at least one policy to search.', 'policy_documents_required', 400);
  }
  if (documents.length > LIMITS.maxDocuments) {
    throw new PolicyRetrievalError(`Select no more than ${LIMITS.maxDocuments} documents per search.`, 'policy_document_limit', 413);
  }
  const cleanQueries = (Array.isArray(queries) ? queries : [queries])
    .map(value => normalisePlainText(value).slice(0, 1800))
    .filter(Boolean)
    .slice(0, 4);
  if (!cleanQueries.length) throw new PolicyRetrievalError('The control has no searchable guidance.', 'policy_query_empty', 400);
  const runRetrieval = async () => {
    const activeModels = retrievalModels || modelInfo();
    const external = activeModels && activeModels.local === false;
    const backendLabel = external
      ? String(activeModels.provider || 'external provider')
      : 'local';
    const requestedTextLimit = Number(maxTotalCharacters);
    const requestedRawLimit = Number(maxRawTotalCharacters);
    let remaining = Number.isFinite(requestedTextLimit)
      ? Math.max(1, Math.min(LIMITS.maxTotalCharacters, Math.floor(requestedTextLimit)))
      : LIMITS.maxTotalCharacters;
    let remainingRaw = Number.isFinite(requestedRawLimit)
      ? Math.max(1, Math.min(LIMITS.maxRawTotalCharacters, Math.floor(requestedRawLimit)))
      : LIMITS.maxRawTotalCharacters;
    const chunks = [];
    const skipped = [];
    const limitations = Array.isArray(retrievalLimitations)
      ? retrievalLimitations.map(value => normalisePlainText(value).slice(0, 1000)).filter(Boolean)
      : ['The local models are optimized for English-language policies; other languages may be missed.'];
    for (const document of documents) {
      const prepared = chunkDocument(document, remaining, remainingRaw);
      remaining -= prepared.characters;
      remainingRaw -= prepared.rawCharacters;
      if (!prepared.searchable) {
        const pdfSource = String(document.source_mime || '').toLowerCase() === 'application/pdf'
          || /\.pdf$/i.test(String(document.source_filename || ''));
        skipped.push({
          document_id: Number(document.id),
          name: String(document.name || ''),
          reason: pdfSource
            ? 'No searchable text was extracted. The PDF may be scanned or image-only; run OCR and import the text before relying on this search.'
            : 'No searchable text was extracted.'
        });
      }
      chunks.push(...prepared.chunks);
      if (prepared.truncated) limitations.push(`Search input was capped for ${String(document.name || 'a selected document')}; review the document manually for complete coverage.`);
      if (remaining <= 0 || remainingRaw <= 0) {
        limitations.push('The total text limit was reached; not every selected document was searched in full.');
        break;
      }
    }
    if (!chunks.length) {
      return {
        passages: [], skipped_documents: skipped, limitations: [...new Set(limitations)],
        searched_document_count: 0, selected_document_count: documents.length, chunks_considered: 0,
        models: activeModels
      };
    }

    const activeBackend = retrievalBackend || await backend();
    const backendText = includeDocumentNames
      ? retrievalText
      : chunk => {
        // A heading-less import uses the document name as its local fallback.
        // Do not let that fallback cross the external-provider boundary.
        const heading = chunk.heading && chunk.heading !== chunk.document_name ? chunk.heading : '';
        return `${heading}\n${chunk.excerpt || ''}`.trim();
      };
    const embedQueries = activeBackend.embedQueries || activeBackend.embed;
    if (typeof embedQueries !== 'function') {
      throw new PolicyRetrievalError('The configured embedding backend cannot embed queries.', 'policy_embedding_failed', 503);
    }
    const queryVectors = await embedQueries.call(activeBackend, cleanQueries);
    validateVectors(queryVectors, cleanQueries.length, `${backendLabel} embedding model`);
    const chunkVectors = await embeddingsForChunks(activeBackend, chunks, documents, backendText);
    const denseScores = chunkVectors.map(vector => Math.max(...queryVectors.map(queryVector => dot(queryVector, vector))));
    const terms = queryTerms(cleanQueries);
    const lexicalScores = chunks.map(chunk => lexicalScore(retrievalText(chunk), terms));
    const candidates = rrfCandidates(chunks, denseScores, lexicalScores);
    const primaryQuery = cleanQueries.join('\n').slice(0, 1400);
    const rerankScores = await activeBackend.rerank(primaryQuery, candidates.map(candidate => backendText(chunks[candidate.index])));
    if (!Array.isArray(rerankScores) || rerankScores.length !== candidates.length || rerankScores.some(score => !Number.isFinite(Number(score)))) {
      throw new PolicyRetrievalError(`The ${backendLabel} reranker returned invalid relevance scores.`, 'policy_reranker_failed', 503);
    }
    const configuredThreshold = requestedMinimumScore === undefined
      ? Number(process.env.POLICY_RERANK_MIN_SCORE)
      : Number(requestedMinimumScore);
    const minimumScore = Number.isFinite(configuredThreshold) ? configuredThreshold : 0;
    const ranked = candidates.map((candidate, index) => ({ ...candidate, rerank: Number(rerankScores[index]) }))
      .sort((a, b) => b.rerank - a.rerank || b.fused - a.fused)
      .filter(candidate => candidate.rerank >= minimumScore);
    const resultLimit = Math.max(1, Math.min(LIMITS.resultPassages, Number(limit) || LIMITS.resultPassages));
    const diversified = diversifyCandidates(ranked, chunks, resultLimit);
    limitations.push('Automated relevance ranking can miss indirect, table-based, or unusually worded coverage; inspect the selected policies manually before concluding that information is absent.');
    const passages = diversified.map((candidate, index) => ({
      rank: index + 1,
      ...chunks[candidate.index]
    }));
    const searchedIds = new Set(chunks.map(chunk => chunk.document_id));
    return {
      passages,
      skipped_documents: skipped,
      limitations: [...new Set(limitations)],
      searched_document_count: searchedIds.size,
      selected_document_count: documents.length,
      chunks_considered: chunks.length,
      models: activeModels
    };
  };
  // Local ONNX inference is serialized because it is CPU/memory intensive on
  // small deployments. External backends own their concurrency boundary so a
  // slow network request cannot block a local-only search queued behind it.
  return retrievalBackend ? runRetrieval() : withModelSlot(runRetrieval);
}

function _setBackendForTests(value) {
  testBackend = value || null;
  runtimePromise = null;
  embeddingCache.clear();
}

module.exports = {
  LIMITS,
  PolicyRetrievalError,
  chunkDocument,
  configurationError,
  extractPolicySections,
  isConfigured,
  isEnabled,
  modelDir,
  modelInfo,
  materializePolicyCitation,
  parsePolicySourceRef,
  retrievePolicyPassages,
  _setBackendForTests
};
