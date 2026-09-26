'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

const EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const RERANK_MODEL = 'nvidia/llama-nemotron-rerank-vl-1b-v2:free';
const DIMENSIONS = 2048;

let env;
let db;
let client;
let retrieval;
let managerId;
let managerFirmId;
let isoItemId;
let sourceDir;
let serial = 0;

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function unitVector(axis = 0) {
  const vector = new Array(DIMENSIONS).fill(0);
  vector[axis] = 1;
  return vector;
}

function axisFor(value) {
  return /access|privilege|review|approval/i.test(String(value || '')) ? 0 : 1;
}

function fakeBackend(options = {}) {
  const calls = options.calls || [];
  return {
    label: 'OpenRouter test backend',
    async embedDocuments(texts) {
      calls.push({ operation: 'embed_documents', texts: texts.slice() });
      if (options.onEmbedDocuments) options.onEmbedDocuments(texts);
      return texts.map(text => unitVector(axisFor(text)));
    },
    async embedQueries(texts) {
      calls.push({ operation: 'embed_queries', texts: texts.slice() });
      if (options.onEmbedQueries) options.onEmbedQueries(texts);
      return texts.map(text => unitVector(axisFor(text)));
    },
    async rerank(query, passages) {
      calls.push({ operation: 'rerank', query, passages: passages.slice() });
      if (options.onRerank) options.onRerank(query, passages);
      return passages.map(passage => /access|privilege|review|approval/i.test(passage) ? 0.95 : 0.05);
    }
  };
}

function createWorkspace(label, firmId = managerFirmId) {
  return Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,frameworks)
    VALUES (?,?, 'technology','Synthetic evidence retrieval tests','["iso27001"]')`)
    .run(firmId, `EVIDENCE-RETRIEVAL-${label}-${++serial}`).lastInsertRowid);
}

function createEvidence(workspaceId, filename, contents, options = {}) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  const storedPath = `evidence-retrieval-${process.pid}-${++serial}-${path.basename(filename)}`;
  const filePath = path.join(sourceDir, storedPath);
  fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
  const evidenceId = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,iso_item_id,filename,stored_path,sha256,size_bytes,uploaded_by,
     description,valid_until)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      workspaceId,
      options.isoItemId || null,
      filename,
      storedPath,
      hash(buffer),
      buffer.length,
      managerId,
      options.description || null,
      options.validUntil || null
    ).lastInsertRowid);
  return { evidenceId, filePath, storedPath, buffer, sha256: hash(buffer) };
}

function resolveTestUpload(storedPath) {
  return path.join(sourceDir, path.basename(String(storedPath || '')));
}

async function index(workspaceId, evidenceId, backend, beforeEgress = async () => {}) {
  return retrieval.indexEvidence({
    db,
    workspaceId,
    evidenceId,
    actorId: managerId,
    authorizationScope: 'manual_index',
    resolveUploadPath: resolveTestUpload,
    beforeEgress,
    retrievalBackend: backend,
    runWithSlot: task => task()
  });
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = new Database(env.dbPath);
  retrieval = require('../lib/evidence-retrieval');
  const manager = db.prepare("SELECT id,firm_id FROM users WHERE email='sec-test@example.com'").get();
  managerId = Number(manager.id);
  managerFirmId = Number(manager.firm_id);
  isoItemId = db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1").get().id;
  sourceDir = path.join(env.tmpDir, 'evidence-retrieval-sources');
  fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
});

test.after(async () => {
  if (db) db.close();
  if (client) await client.close();
  if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true });
});

test('TXT indexing persists fixed 2048-d Float32LE chunks without duplicate plaintext', async () => {
  const workspaceId = createWorkspace('PERSISTENCE');
  const canary = 'PERSISTED-PLAINTEXT-MUST-NOT-APPEAR-IN-CHUNK-TABLE';
  const text = `${canary} Quarterly access reviews remove excess privileges and retain manager approvals. `.repeat(28);
  const evidence = createEvidence(workspaceId, 'quarterly-access-review.txt', text, { isoItemId });
  const calls = [];
  const auditStages = [];

  const result = await index(workspaceId, evidence.evidenceId, fakeBackend({ calls }), async (stage, metadata) => {
    auditStages.push({ stage, metadata });
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.reused, false);
  assert.ok(result.chunk_count >= 2);
  assert.deepEqual(auditStages.map(row => row.stage), ['embedding']);
  assert.equal(calls.filter(call => call.operation === 'embed_documents').length, 1);

  const indexRow = db.prepare('SELECT * FROM evidence_ai_indexes WHERE id=?').get(result.index_id);
  assert.equal(indexRow.workspace_id, workspaceId);
  assert.equal(indexRow.evidence_id, evidence.evidenceId);
  assert.equal(indexRow.source_sha256, evidence.sha256);
  assert.equal(indexRow.embedding_provider, 'OpenRouter');
  assert.equal(indexRow.embedding_model_requested, EMBEDDING_MODEL);
  assert.equal(indexRow.embedding_model_canonical, EMBEDDING_MODEL);
  assert.equal(indexRow.embedding_dimensions, DIMENSIONS);
  assert.equal(indexRow.vector_format, 'float32le-v1');
  assert.equal(indexRow.pipeline_key, retrieval.PIPELINE_KEY);
  assert.equal(indexRow.disclosure_version, retrieval.DISCLOSURE_VERSION);
  assert.equal(indexRow.external_processing_acknowledged, 1);
  assert.equal(indexRow.status, 'ready');
  assert.equal(indexRow.chunk_count, result.chunk_count);
  assert.doesNotMatch(JSON.stringify(indexRow), new RegExp(canary));

  const columns = db.prepare('PRAGMA table_info(evidence_ai_chunks)').all().map(column => column.name);
  assert.equal(columns.some(column => /text|excerpt|content/i.test(column)), false);
  const chunks = db.prepare(`SELECT *,typeof(embedding) AS embedding_type,length(embedding) AS embedding_bytes
    FROM evidence_ai_chunks WHERE index_id=? ORDER BY ordinal`).all(result.index_id);
  assert.equal(chunks.length, result.chunk_count);
  for (const chunk of chunks) {
    assert.equal(chunk.workspace_id, workspaceId);
    assert.equal(chunk.evidence_id, evidence.evidenceId);
    assert.equal(chunk.embedding_type, 'blob');
    assert.equal(chunk.embedding_bytes, DIMENSIONS * 4);
    assert.match(chunk.chunk_sha256, /^[a-f0-9]{64}$/);
    assert.equal(chunk.embedding.includes(Buffer.from(canary)), false);
    const decoded = retrieval.decodeVector(chunk.embedding);
    assert.equal(decoded.length, DIMENSIONS);
    assert.equal(decoded[0], 1);
    assert.equal(decoded.slice(1).every(value => value === 0), true);
  }

  assert.deepEqual(retrieval.modelInfo(), {
    local: false,
    provider: 'OpenRouter',
    free_endpoint: true,
    provider_logging: true,
    embedding_model: EMBEDDING_MODEL,
    embedding_dimensions: DIMENSIONS,
    reranker_model: RERANK_MODEL
  });
});

test('unsupported and no-text evidence become terminal without a provider call', async () => {
  const workspaceId = createWorkspace('UNSUPPORTED');
  const unsupported = createEvidence(workspaceId, 'network-map.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const empty = createEvidence(workspaceId, 'empty.txt', '  \n\t  ');
  const calls = [];
  let auditCalls = 0;
  const backend = fakeBackend({ calls });

  const unsupportedResult = await index(workspaceId, unsupported.evidenceId, backend, async () => { auditCalls++; });
  const emptyResult = await index(workspaceId, empty.evidenceId, backend, async () => { auditCalls++; });

  assert.equal(unsupportedResult.status, 'unsupported');
  assert.equal(unsupportedResult.code, 'evidence_type_unsupported');
  assert.equal(emptyResult.status, 'unsupported');
  assert.equal(emptyResult.code, 'evidence_no_searchable_text');
  assert.equal(calls.length, 0);
  assert.equal(auditCalls, 0);

  const terminal = db.prepare(`SELECT evidence_id,status,chunk_count,last_error_code
    FROM evidence_ai_indexes WHERE workspace_id=? ORDER BY evidence_id`).all(workspaceId);
  assert.deepEqual(terminal, [
    { evidence_id: unsupported.evidenceId, status: 'unsupported', chunk_count: 0, last_error_code: 'evidence_type_unsupported' },
    { evidence_id: empty.evidenceId, status: 'unsupported', chunk_count: 0, last_error_code: 'evidence_no_searchable_text' }
  ]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM evidence_ai_chunks WHERE workspace_id=?`).get(workspaceId).count, 0);
});

test('retrieval remains tenant-partitioned and reranks only materialized workspace citations', async () => {
  const foreignFirmId = Number(db.prepare("INSERT INTO firms(name) VALUES ('EVIDENCE-RETRIEVAL-FOREIGN-FIRM')").run().lastInsertRowid);
  const workspaceA = createWorkspace('TENANT-A');
  const workspaceB = createWorkspace('TENANT-B', foreignFirmId);
  const evidenceA = createEvidence(
    workspaceA,
    'tenant-a-access.txt',
    'TENANT-A-CITATION Quarterly access reviews remove privileges and retain signed approvals.',
    { isoItemId }
  );
  const evidenceB = createEvidence(
    workspaceB,
    'tenant-b-secret.txt',
    'TENANT-B-SECRET-CONTENT Quarterly access reviews contain foreign client secrets.',
    { isoItemId }
  );
  const setupBackend = fakeBackend();
  await index(workspaceA, evidenceA.evidenceId, setupBackend);
  await index(workspaceB, evidenceB.evidenceId, setupBackend);

  const calls = [];
  const stages = [];
  const result = await retrieval.searchEvidence({
    db,
    workspaceId: workspaceA,
    isoItemId,
    queries: ['quarterly access review privileges approvals'],
    resolveUploadPath: resolveTestUpload,
    beforeEgress: async (stage, metadata) => { stages.push({ stage, metadata }); },
    retrievalBackend: fakeBackend({ calls }),
    runWithSlot: task => task()
  });

  assert.deepEqual(stages.map(row => row.stage), ['query_embedding', 'reranking']);
  assert.equal(result.searched_evidence_count, 1);
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].evidence_id, evidenceA.evidenceId);
  assert.equal(result.passages[0].filename, 'tenant-a-access.txt');
  assert.equal(result.passages[0].linked, true);
  assert.match(result.passages[0].excerpt, /TENANT-A-CITATION/);
  assert.match(result.passages[0].source_ref, new RegExp(`^evidence:${evidenceA.evidenceId}:sha:${evidenceA.sha256.slice(0, 12)}:chunk:0$`));
  assert.doesNotMatch(JSON.stringify(result), /TENANT-B-SECRET/);
  assert.doesNotMatch(JSON.stringify(calls), /TENANT-B-SECRET/);
  assert.equal(calls.filter(call => call.operation === 'embed_queries').length, 1);
  assert.equal(calls.filter(call => call.operation === 'rerank').length, 1);

  const foreignCalls = [];
  await assert.rejects(
    index(workspaceA, evidenceB.evidenceId, fakeBackend({ calls: foreignCalls })),
    error => error && error.code === 'stale_evidence_source' && error.status === 409
  );
  assert.equal(foreignCalls.length, 0);
});

test('selected evidence citations are rehydrated exactly from governed bytes without provider calls', async () => {
  const workspaceId = createWorkspace('CITATION-MATERIALIZATION');
  const text = [
    'CANONICAL-EVIDENCE-FIRST Access owners review privileged access and retain signed approvals.',
    ...Array.from({ length: 185 }, (_, index) => `control-record-${index + 1}`),
    'CANONICAL-EVIDENCE-SECOND Independent reviewers confirm stale privileges were removed.'
  ].join(' ');
  const evidence = createEvidence(
    workspaceId,
    'canonical-access-review.txt',
    text,
    { isoItemId, validUntil: '2099-12-31' }
  );
  const calls = [];
  const indexed = await index(workspaceId, evidence.evidenceId, fakeBackend({ calls }));
  const expectedChunks = retrieval.chunkText(retrieval.normaliseText(text));
  assert.ok(expectedChunks.length >= 2);
  const ordinal = 1;
  const sourceRef = `evidence:${evidence.evidenceId}:sha:${evidence.sha256.slice(0, 12)}:chunk:${ordinal}`;
  const providerCallCount = calls.length;

  const passages = await retrieval.materializeEvidencePassages({
    db,
    workspaceId,
    sourceRefs: [sourceRef],
    resolveUploadPath: resolveTestUpload,
    maxPassages: 1
  });

  assert.equal(calls.length, providerCallCount, 'materialization must not invoke embedding or reranking');
  assert.equal(passages.length, 1);
  assert.deepEqual(passages[0], {
    source_ref: sourceRef,
    source_type: 'evidence',
    evidence_id: evidence.evidenceId,
    label: `Evidence: canonical-access-review.txt (chunk ${ordinal + 1})`,
    excerpt: expectedChunks[ordinal].excerpt,
    source_sha256: evidence.sha256,
    chunk_sha256: expectedChunks[ordinal].chunk_sha256,
    index_id: indexed.index_id,
    chunk_ordinal: ordinal,
    valid_until: '2099-12-31',
    linked: false,
    freshness: 'current_or_unspecified',
    status: 'current or validity unspecified'
  });
});

test('evidence citation materialization rejects invalid, stale, and tampered sources without provider calls', async () => {
  const workspaceId = createWorkspace('CITATION-REJECTION');
  const evidence = createEvidence(
    workspaceId,
    'citation-rejection.txt',
    'CITATION-REJECTION Quarterly access reviewers remove stale privileges and retain approvals.',
    { isoItemId }
  );
  const calls = [];
  await index(workspaceId, evidence.evidenceId, fakeBackend({ calls }));
  const sourceRef = `evidence:${evidence.evidenceId}:sha:${evidence.sha256.slice(0, 12)}:chunk:0`;
  const providerCallCount = calls.length;

  await assert.rejects(
    retrieval.materializeEvidencePassages({
      db,
      workspaceId,
      sourceRefs: [`evidence:${evidence.evidenceId}:sha:${evidence.sha256.slice(0, 12)}:chunk:00`],
      resolveUploadPath: resolveTestUpload
    }),
    error => error && error.code === 'evidence_citation_invalid' && error.status === 400
  );

  const changedPrefix = `${evidence.sha256[0] === 'a' ? 'b' : 'a'}${evidence.sha256.slice(1, 12)}`;
  await assert.rejects(
    retrieval.materializeEvidencePassages({
      db,
      workspaceId,
      sourceRefs: [`evidence:${evidence.evidenceId}:sha:${changedPrefix}:chunk:0`],
      resolveUploadPath: resolveTestUpload
    }),
    error => error && error.code === 'stale_evidence_citation' && error.status === 409
  );

  fs.writeFileSync(evidence.filePath, 'TAMPERED-EVIDENCE-BYTES must not be materialized', { mode: 0o600 });
  await assert.rejects(
    retrieval.materializeEvidencePassages({
      db,
      workspaceId,
      sourceRefs: [sourceRef],
      resolveUploadPath: resolveTestUpload
    }),
    error => error && error.code === 'evidence_source_hash_mismatch' && error.status === 409
  );
  assert.equal(calls.length, providerCallCount, 'rejected citations must not invoke embedding or reranking');
});

test('governed SHA mutation makes an index stale and source-byte mismatch blocks egress', async () => {
  const workspaceId = createWorkspace('STALE');
  const evidence = createEvidence(
    workspaceId,
    'stale-access.txt',
    'STALE-ORIGINAL Quarterly access review approvals are retained.',
    { isoItemId }
  );
  const result = await index(workspaceId, evidence.evidenceId, fakeBackend());
  assert.equal(result.status, 'ready');

  const changedSha = hash(Buffer.from('governed source identity changed'));
  db.prepare('UPDATE evidence SET sha256=? WHERE workspace_id=? AND id=?')
    .run(changedSha, workspaceId, evidence.evidenceId);
  const stale = db.prepare('SELECT status,stale_at FROM evidence_ai_indexes WHERE id=?').get(result.index_id);
  assert.equal(stale.status, 'stale');
  assert.ok(stale.stale_at);
  assert.equal(retrieval.readyEvidenceCount(db, workspaceId), 0);

  const searchCalls = [];
  let searchAuditCalls = 0;
  const emptyResult = await retrieval.searchEvidence({
    db,
    workspaceId,
    isoItemId,
    queries: ['access review'],
    resolveUploadPath: resolveTestUpload,
    beforeEgress: async () => { searchAuditCalls++; },
    retrievalBackend: fakeBackend({ calls: searchCalls }),
    runWithSlot: task => task()
  });
  assert.equal(emptyResult.passages.length, 0);
  assert.equal(emptyResult.searched_evidence_count, 0);
  assert.equal(searchCalls.length, 0);
  assert.equal(searchAuditCalls, 0);

  const mismatched = createEvidence(
    workspaceId,
    'mutated-before-index.txt',
    'ORIGINAL-BYTES Quarterly access review.',
    { isoItemId }
  );
  fs.writeFileSync(mismatched.filePath, 'MUTATED-BYTES must never leave this host', { mode: 0o600 });
  const indexCalls = [];
  let indexAuditCalls = 0;
  await assert.rejects(
    index(workspaceId, mismatched.evidenceId, fakeBackend({ calls: indexCalls }), async () => { indexAuditCalls++; }),
    error => error && error.code === 'evidence_source_hash_mismatch' && error.status === 409
  );
  assert.equal(indexCalls.length, 0);
  assert.equal(indexAuditCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evidence_ai_indexes WHERE evidence_id=?').get(mismatched.evidenceId).count, 0);
});
