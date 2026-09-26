'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const remote = require('../lib/openrouter-policy-retrieval');

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_POLICY_RETRIEVAL_ENABLED: process.env.OPENROUTER_POLICY_RETRIEVAL_ENABLED,
  OPENROUTER_RETRY_BASE_MS: process.env.OPENROUTER_RETRY_BASE_MS,
  OPENROUTER_POLICY_EMBED_BATCH_SIZE: process.env.OPENROUTER_POLICY_EMBED_BATCH_SIZE
};

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; }
  };
}

function rawVector(index = 0) {
  const vector = new Array(remote.EMBEDDING_DIMENSIONS).fill(0);
  vector[index % remote.EMBEDDING_DIMENSIONS] = index + 2;
  return vector;
}

test.beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.OPENROUTER_API_KEY = 'sk-or-test-policy-secret';
  process.env.OPENROUTER_POLICY_RETRIEVAL_ENABLED = 'true';
  process.env.OPENROUTER_RETRY_BASE_MS = '0';
  process.env.OPENROUTER_POLICY_EMBED_BATCH_SIZE = '128';
  remote._setBackendForTests(null);
  remote._setFetchForTests(null);
});

test.after(() => {
  remote._setBackendForTests(null);
  remote._setFetchForTests(null);
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) restoreEnv(name, value);
});

test('uses the two fixed NVIDIA OpenRouter endpoints and reconstructs provider indexes', async () => {
  const calls = [];
  remote._setFetchForTests(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    if (url.endsWith('/embeddings')) {
      return jsonResponse({
        model: body.input_type === 'query'
          ? 'private/openrouter/nvidia/llama-nemotron-embed-vl-1b-v2'
          : 'nvidia/llama-nemotron-embed-vl-1b-v2',
        data: body.input.map((_, index) => ({ index, embedding: rawVector(index) })).reverse()
      });
    }
    return jsonResponse({
      model: 'nvidia/llama-nemotron-rerank-vl-1b-v2',
      results: [
        { index: 1, relevance_score: 0.91, document: { text: 'INJECTED_PROVIDER_ECHO' } },
        { index: 0, relevance_score: 0.23, document: { text: 'INJECTED_PROVIDER_ECHO' } }
      ]
    });
  });

  const backend = await remote.backend();
  const queryVectors = await backend.embedQueries(['ISO access control query']);
  const documentVectors = await backend.embedDocuments(['Policy passage one', 'Policy passage two']);
  const scores = await backend.rerank('ISO access control query', ['Policy passage one', 'Policy passage two']);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/embeddings');
  assert.equal(calls[0].body.model, 'nvidia/llama-nemotron-embed-vl-1b-v2:free');
  assert.equal(calls[0].body.input_type, 'query');
  assert.equal(calls[0].body.encoding_format, 'float');
  assert.equal(calls[1].body.model, 'nvidia/llama-nemotron-embed-vl-1b-v2:free');
  assert.equal(calls[1].body.input_type, 'passage');
  assert.equal(calls[2].url, 'https://openrouter.ai/api/v1/rerank');
  assert.deepEqual(calls[2].body, {
    model: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
    query: 'ISO access control query',
    documents: ['Policy passage one', 'Policy passage two'],
    top_n: 2
  });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-or-test-policy-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(queryVectors[0].length, 2048);
  assert.equal(documentVectors[0][0], 1);
  assert.equal(documentVectors[1][1], 1);
  assert.deepEqual(scores, [0.23, 0.91]);
  assert.equal(JSON.stringify(scores).includes('INJECTED_PROVIDER_ECHO'), false);
  assert.deepEqual(remote.modelInfo(), {
    local: false,
    provider: 'OpenRouter',
    free_endpoint: true,
    provider_logging: true,
    embedding_model: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    embedding_dimensions: 2048,
    reranker_model: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free'
  });
});

test('batches document embeddings and preserves input order within every response', async () => {
  process.env.OPENROUTER_POLICY_EMBED_BATCH_SIZE = '2';
  const batches = [];
  remote._setFetchForTests(async (_url, options) => {
    const body = JSON.parse(options.body);
    batches.push(body.input.slice());
    return jsonResponse({
      model: remote.EMBEDDING_MODEL,
      data: body.input.map((_, index) => ({ index, embedding: rawVector(index) })).reverse()
    });
  });
  const backend = await remote.backend();
  const result = await backend.embedDocuments(['one', 'two', 'three']);
  assert.deepEqual(batches, [['one', 'two'], ['three']]);
  assert.equal(result.length, 3);
  assert.equal(result[0][0], 1);
  assert.equal(result[1][1], 1);
  assert.equal(result[2][0], 1);
});

test('rejects incomplete, duplicate, wrong-sized, zero, and non-finite embeddings', async t => {
  const cases = [
    { name: 'incomplete', data: [] },
    { name: 'duplicate index', data: [{ index: 0, embedding: rawVector(0) }, { index: 0, embedding: rawVector(1) }] },
    { name: 'wrong dimension', data: [{ index: 0, embedding: [1, 2, 3] }] },
    { name: 'zero vector', data: [{ index: 0, embedding: new Array(2048).fill(0) }] },
    { name: 'non-finite', data: [{ index: 0, embedding: rawVector(0).map((value, index) => index === 7 ? Infinity : value) }] }
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      remote._setFetchForTests(async () => jsonResponse({ model: remote.EMBEDDING_MODEL, data: entry.data }));
      const backend = await remote.backend();
      const inputs = entry.name === 'duplicate index' ? ['one', 'two'] : ['one'];
      await assert.rejects(backend.embedDocuments(inputs), error => error.code === 'openrouter_policy_embedding_invalid' && error.status === 502);
    });
  }
});

test('rejects malformed rerank indexes and scores without trusting echoed documents', async t => {
  const cases = [
    { name: 'missing', results: [{ index: 0, relevance_score: 0.4 }] },
    { name: 'duplicate', results: [{ index: 0, relevance_score: 0.4 }, { index: 0, relevance_score: 0.3 }] },
    { name: 'out of range', results: [{ index: 0, relevance_score: 0.4 }, { index: 7, relevance_score: 0.3 }] },
    { name: 'non-finite', results: [{ index: 0, relevance_score: 0.4 }, { index: 1, relevance_score: 'not-a-number' }] }
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      remote._setFetchForTests(async () => jsonResponse({ model: remote.RERANK_MODEL, results: entry.results }));
      const backend = await remote.backend();
      await assert.rejects(backend.rerank('query', ['one', 'two']), error => error.code === 'openrouter_policy_rerank_invalid' && error.status === 502);
    });
  }
});

test('does not automatically resend logged trial data and never exposes provider bodies or the API key', async () => {
  let transientCalls = 0;
  remote._setFetchForTests(async () => {
    transientCalls++;
    return jsonResponse({ error: { code: 502, message: 'upstream overloaded POLICY-CANARY sk-or-test-policy-secret' } }, 502);
  });
  const backend = await remote.backend();
  await assert.rejects(
    backend.embedQueries(['query']),
    error => error.code === 'openrouter_policy_embedding_failed'
      && !error.message.includes('POLICY-CANARY')
      && !error.message.includes('sk-or-test-policy-secret')
  );
  assert.equal(transientCalls, 1);

  let authCalls = 0;
  remote._setFetchForTests(async () => {
    authCalls++;
    return jsonResponse({ error: { code: 401, message: 'POLICY-CANARY sk-or-test-policy-secret' } }, 401);
  });
  await assert.rejects(
    backend.embedQueries(['query']),
    error => error.code === 'openrouter_policy_embedding_failed'
      && !error.message.includes('POLICY-CANARY')
      && !error.message.includes('sk-or-test-policy-secret')
  );
  assert.equal(authCalls, 1);
});

test('rejects an oversized provider response before parsing it', async () => {
  let calls = 0;
  remote._setFetchForTests(async () => {
    calls++;
    return {
      ...jsonResponse({ model: remote.EMBEDDING_MODEL, data: [] }),
      headers: { get: name => name === 'content-length' ? String(33 * 1024 * 1024) : null }
    };
  });
  const backend = await remote.backend();
  await assert.rejects(
    backend.embedQueries(['query']),
    error => error.code === 'openrouter_policy_response_too_large' && error.status === 502
  );
  assert.equal(calls, 1);
});

test('rejects missing or unexpected response model identities', async () => {
  const backend = await remote.backend();
  for (const model of [undefined, 'attacker/other-embedding-model']) {
    remote._setFetchForTests(async () => jsonResponse({
      ...(model ? { model } : {}),
      data: [{ index: 0, embedding: rawVector(0) }]
    }));
    await assert.rejects(
      backend.embedQueries(['query']),
      error => error.code === 'openrouter_policy_embedding_model_mismatch' && error.status === 502
    );
  }
  remote._setFetchForTests(async () => jsonResponse({
    model: 'attacker/other-reranker',
    results: [{ index: 0, relevance_score: 0.5 }]
  }));
  await assert.rejects(
    backend.rerank('query', ['passage']),
    error => error.code === 'openrouter_policy_rerank_model_mismatch' && error.status === 502
  );
});

test('requires an explicit development feature flag and is always disabled in production', () => {
  delete process.env.OPENROUTER_POLICY_RETRIEVAL_ENABLED;
  assert.equal(remote.isConfigured(), false);
  assert.match(remote.configurationError(), /disabled/i);
  process.env.OPENROUTER_POLICY_RETRIEVAL_ENABLED = 'true';
  assert.equal(remote.isConfigured(), true);
  process.env.NODE_ENV = 'production';
  assert.equal(remote.isConfigured(), false);
  assert.match(remote.configurationError(), /disabled in production/i);
});
