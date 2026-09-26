'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const retrieval = require('../lib/policy-retrieval');

function vectorFor(text) {
  const access = /access|privilege|quarter/i.test(String(text));
  return access ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0];
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

test.afterEach(() => retrieval._setBackendForTests(null));

test('sanitized HTML becomes bounded, section-aware plain-text chunks', () => {
  const sections = retrieval.extractPolicySections(
    '<h2>Access &amp; identity</h2><p>Review <strong>quarterly</strong>.<script>steal()</script></p><img src=x onerror=alert(1)>',
    'Policy'
  );
  assert.deepEqual(sections, [{ heading: 'Access & identity', text: 'Review quarterly.' }]);

  const prepared = retrieval.chunkDocument({
    id: 7,
    workspace_id: 3,
    name: 'Access policy',
    status: 'approved',
    version_id: 22,
    version: 4,
    source_hash: 'a'.repeat(64),
    content: `<h2>Quarterly reviews</h2><p>${'Access owners review permissions and retain approval records. '.repeat(30)}</p>`
  });
  assert.ok(prepared.chunks.length >= 1);
  assert.equal(prepared.chunks[0].source_ref, 'document:7:version:22:chunk:0');
  assert.equal(prepared.chunks[0].heading, 'Quarterly reviews');
  assert.doesNotMatch(prepared.chunks[0].excerpt, /script|onerror|<[^>]+>/i);
});

test('policy citations are rehydrated exactly from current governed bytes without model calls', () => {
  let modelCalls = 0;
  retrieval._setBackendForTests({
    cacheKey: 'citation-materialization-must-stay-local',
    async embed() { modelCalls++; throw new Error('materialization must not embed'); },
    async rerank() { modelCalls++; throw new Error('materialization must not rerank'); }
  });

  const workingContent = '<h2>Privileged access</h2><p>Owners review privileged access quarterly, remove stale rights, and retain approvals.</p>';
  const workingDocument = {
    id: 71,
    workspace_id: 9,
    name: 'Working access policy',
    status: 'draft',
    version_id: null,
    version: null,
    source_hash: sha256(workingContent),
    linked: true,
    content: workingContent
  };
  const workingChunk = retrieval.chunkDocument(workingDocument).chunks[0];
  const workingPassage = retrieval.materializePolicyCitation({
    document: workingDocument,
    sourceRef: workingChunk.source_ref,
    expectedChunkHash: workingChunk.chunk_hash
  });
  assert.deepEqual(workingPassage, {
    source_ref: workingChunk.source_ref,
    source_type: 'policy',
    document_id: workingDocument.id,
    label: 'Policy: Working access policy · Privileged access',
    excerpt: workingChunk.excerpt,
    chunk_hash: workingChunk.chunk_hash,
    chunk_ordinal: 0,
    document_status: 'draft',
    version_id: null,
    version: null,
    heading: 'Privileged access',
    linked: true,
    source_sha256: workingDocument.source_hash
  });

  const versionContent = '<h2>Access recertification</h2><p>Control owners recertify access and retain the approved review record.</p>';
  const versionDocument = {
    id: 72,
    workspace_id: 9,
    name: 'Approved access policy',
    status: 'approved',
    version_id: 913,
    version: 4,
    source_hash: sha256(versionContent),
    linked: false,
    content: versionContent
  };
  const versionChunk = retrieval.chunkDocument(versionDocument).chunks[0];
  const versionPassage = retrieval.materializePolicyCitation({
    document: versionDocument,
    sourceRef: versionChunk.source_ref,
    expectedChunkHash: versionChunk.chunk_hash
  });
  assert.equal(versionPassage.source_ref, 'document:72:version:913:chunk:0');
  assert.equal(versionPassage.excerpt, versionChunk.excerpt);
  assert.equal(versionPassage.chunk_hash, versionChunk.chunk_hash);
  assert.equal(versionPassage.source_sha256, versionDocument.source_hash);
  assert.equal(versionPassage.version_id, 913);
  assert.equal(modelCalls, 0);
});

test('policy citation materialization rejects invalid refs, stale source identity, and chunk tampering without model calls', () => {
  let modelCalls = 0;
  retrieval._setBackendForTests({
    cacheKey: 'citation-rejection-must-stay-local',
    async embed() { modelCalls++; throw new Error('materialization must not embed'); },
    async rerank() { modelCalls++; throw new Error('materialization must not rerank'); }
  });

  const content = '<h2>Access review</h2><p>Owners review access quarterly and retain manager approval.</p>';
  const document = {
    id: 81,
    workspace_id: 10,
    name: 'Access review policy',
    status: 'draft',
    version_id: null,
    source_hash: sha256(content),
    linked: true,
    content
  };
  const chunk = retrieval.chunkDocument(document).chunks[0];

  assert.throws(
    () => retrieval.materializePolicyCitation({
      document,
      sourceRef: `document:${document.id}:working:${document.source_hash.slice(0, 12).toUpperCase()}:chunk:0`
    }),
    error => error && error.code === 'policy_citation_invalid' && error.status === 400
  );

  const changedContent = '<h2>Access review</h2><p>The working policy changed after its cited search result.</p>';
  assert.throws(
    () => retrieval.materializePolicyCitation({
      document: { ...document, content: changedContent, source_hash: sha256(changedContent) },
      sourceRef: chunk.source_ref,
      expectedChunkHash: chunk.chunk_hash
    }),
    error => error && error.code === 'stale_policy_citation' && error.status === 409
  );

  assert.throws(
    () => retrieval.materializePolicyCitation({
      document,
      sourceRef: chunk.source_ref,
      expectedChunkHash: 'f'.repeat(64)
    }),
    error => error && error.code === 'stale_policy_citation' && error.status === 409
  );

  const governed = {
    ...document,
    id: 82,
    status: 'approved',
    version_id: 120,
    version: 2
  };
  const governedChunk = retrieval.chunkDocument(governed).chunks[0];
  assert.throws(
    () => retrieval.materializePolicyCitation({
      document: { ...governed, version_id: 121, version: 3 },
      sourceRef: governedChunk.source_ref,
      expectedChunkHash: governedChunk.chunk_hash
    }),
    error => error && error.code === 'stale_policy_citation' && error.status === 409
  );
  assert.equal(modelCalls, 0);
});

test('local vector retrieval reranks passages and suppresses irrelevant candidates', async () => {
  let embeddedText = [];
  retrieval._setBackendForTests({
    cacheKey: 'unit-backend-v1',
    async embed(texts) {
      embeddedText.push(...texts);
      return texts.map(vectorFor);
    },
    async rerank(_query, passages) {
      return passages.map(text => /quarterly user access/i.test(text) ? 6 : -8);
    }
  });
  const result = await retrieval.retrievePolicyPassages({
    documents: [
      {
        id: 1, workspace_id: 10, name: 'Access control policy', status: 'approved',
        version_id: 11, version: 2, source_hash: 'one', linked: true,
        content: '<h2>User access reviews</h2><p>Control owners perform quarterly user access reviews, remove excess privileges, and retain signed approvals.</p>'
      },
      {
        id: 2, workspace_id: 10, name: 'Travel policy', status: 'approved',
        version_id: 12, version: 1, source_hash: 'two', linked: false,
        content: '<h2>Expenses</h2><p>Staff submit hotel and meal receipts to Finance within ten days.</p>'
      }
    ],
    queries: ['Review user access rights at planned intervals and remove unnecessary access.']
  });
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].document_id, 1);
  assert.match(result.passages[0].excerpt, /quarterly user access reviews/i);
  assert.equal(result.passages[0].linked, true);
  assert.ok(embeddedText.some(text => /Travel policy|hotel and meal|expenses/i.test(text)));
  assert.equal(result.models.local, true);
  assert.match(result.limitations.join(' '), /manual/i);
});

test('retrieval enforces an explicit bounded source set', async () => {
  retrieval._setBackendForTests({
    cacheKey: 'limit-backend',
    embed: async texts => texts.map(vectorFor),
    rerank: async (_query, passages) => passages.map(() => 1)
  });
  await assert.rejects(
    retrieval.retrievePolicyPassages({
      documents: Array.from({ length: retrieval.LIMITS.maxDocuments + 1 }, (_, index) => ({
        id: index + 1, workspace_id: 1, name: `Policy ${index + 1}`, status: 'draft',
        source_hash: String(index), content: '<p>Enough searchable policy content for the local retrieval boundary.</p>'
      })),
      queries: ['policy content']
    }),
    error => error.code === 'policy_document_limit' && error.status === 413
  );
});

test('concise heading-led requirements remain searchable with document context', async () => {
  const embedded = [];
  retrieval._setBackendForTests({
    cacheKey: 'concise-backend',
    async embed(texts) {
      embedded.push(...texts);
      return texts.map(vectorFor);
    },
    async rerank(_query, passages) {
      return passages.map(text => /multi-factor authentication[\s\S]*privileged users/i.test(text) ? 5 : -5);
    }
  });
  const result = await retrieval.retrievePolicyPassages({
    documents: [{
      id: 8, workspace_id: 2, name: 'Identity Policy', status: 'approved',
      source_hash: 'concise', content: '<h2>Multi-factor authentication</h2><p>Required for privileged users.</p>'
    }],
    queries: ['Require strong authentication for privileged access.']
  });
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].excerpt, 'Required for privileged users.');
  assert.ok(embedded.some(text => /Identity Policy[\s\S]*Multi-factor authentication/i.test(text)));
});

test('image-only PDF imports are skipped with an OCR warning', async () => {
  let modelCalled = false;
  retrieval._setBackendForTests({
    cacheKey: 'empty-pdf-backend',
    async embed() { modelCalled = true; throw new Error('should not run'); },
    async rerank() { modelCalled = true; throw new Error('should not run'); }
  });
  const result = await retrieval.retrievePolicyPassages({
    documents: [{
      id: 9, workspace_id: 2, name: 'Scanned policy', status: 'draft',
      source_hash: 'scanned', source_filename: 'scanned.pdf', source_mime: 'application/pdf',
      content: '<h1>Scanned policy</h1><p><em>Imported from: scanned.pdf (sha256 abc)</em></p><p><strong>Text extraction warning:</strong> No searchable text was found.</p>'
    }],
    queries: ['information security policy']
  });
  assert.equal(modelCalled, false);
  assert.equal(result.searched_document_count, 0);
  assert.equal(result.skipped_documents.length, 1);
  assert.match(result.skipped_documents[0].reason, /scanned|image-only|OCR/i);
});

test('results are diversified instead of returning only overlapping chunks from one policy', async () => {
  retrieval._setBackendForTests({
    cacheKey: 'diversity-backend',
    embed: async texts => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
    rerank: async (_query, passages) => passages.map(text => text.includes('Verbose Policy') ? 9 : 8)
  });
  const repeated = Array.from({ length: 8 }, (_, index) =>
    `<h2>Access review ${index + 1}</h2><p>${`Quarterly access review evidence ${index + 1} is retained by control owners. `.repeat(18)}</p>`
  ).join('');
  const result = await retrieval.retrievePolicyPassages({
    documents: [
      { id: 10, workspace_id: 2, name: 'Verbose Policy', status: 'approved', source_hash: 'verbose', content: repeated },
      { id: 11, workspace_id: 2, name: 'Concise Policy', status: 'approved', source_hash: 'other', content: '<h2>Privileged access</h2><p>Owners review privileged access quarterly and record approvals.</p>' }
    ],
    queries: ['quarterly access reviews and retained approvals'],
    limit: 6
  });
  assert.ok(result.passages.some(passage => passage.document_id === 11));
  const verboseCount = result.passages.filter(passage => passage.document_id === 10).length;
  assert.ok(verboseCount <= 2, `expected at most two passages from one document, got ${verboseCount}`);
});
