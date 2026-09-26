'use strict';

// Optional remote backend for the policy-coverage retriever. Model selection is
// intentionally fixed: a browser request cannot switch to an arbitrary paid
// model, and the existing OPENROUTER_API_KEY never leaves the server.

const { PolicyRetrievalError } = require('./policy-retrieval');

const EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
const RERANK_URL = 'https://openrouter.ai/api/v1/rerank';
const EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const RERANK_MODEL = 'nvidia/llama-nemotron-rerank-vl-1b-v2:free';
const EMBEDDING_RESPONSE_MODELS = new Set([
  EMBEDDING_MODEL,
  'nvidia/llama-nemotron-embed-vl-1b-v2',
  'private/openrouter/nvidia/llama-nemotron-embed-vl-1b-v2'
]);
const RERANK_RESPONSE_MODELS = new Set([
  RERANK_MODEL,
  'nvidia/llama-nemotron-rerank-vl-1b-v2'
]);
const EMBEDDING_DIMENSIONS = 2048;
const DEFAULT_EMBEDDING_BATCH_SIZE = 128;
const MAX_DOCUMENTS = 5;
const MAX_RAW_TOTAL_CHARACTERS = 200000;
const MAX_TOTAL_CHARACTERS = 100000;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 524, 529]);
const DATA_DISCLOSURE = 'OpenRouter and NVIDIA state that these free endpoints log all inputs and outputs for model and product improvement. Do not send personal, confidential, sensitive, production, or business-critical information; use this option only with non-confidential trial data.';

let fetchOverride = null;
let backendOverride = null;

function featureFlag(feature) {
  return feature === 'evidence'
    ? 'OPENROUTER_EVIDENCE_RETRIEVAL_ENABLED'
    : 'OPENROUTER_POLICY_RETRIEVAL_ENABLED';
}

function isEnabled(feature = 'policy') {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') return false;
  return String(process.env[featureFlag(feature)] || '').trim().toLowerCase() === 'true';
}

function isConfigured(feature = 'policy') {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') return false;
  if (backendOverride) return true;
  return isEnabled(feature) && !!String(process.env.OPENROUTER_API_KEY || '').trim();
}

function configurationError(feature = 'policy') {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    return `The NVIDIA free-model ${feature === 'evidence' ? 'evidence' : 'policy'} trial is disabled in production because the provider logs inputs and prohibits confidential or business-critical use.`;
  }
  if (!isEnabled(feature)) {
    const label = feature === 'evidence' ? 'evidence' : 'policy';
    return `OpenRouter ${label} retrieval is disabled. Set ${featureFlag(feature)}=true only for non-confidential trial data.`;
  }
  if (!String(process.env.OPENROUTER_API_KEY || '').trim()) return 'OPENROUTER_API_KEY is not set.';
  return '';
}

function modelInfo() {
  return {
    local: false,
    provider: 'OpenRouter',
    free_endpoint: true,
    provider_logging: true,
    embedding_model: EMBEDDING_MODEL,
    embedding_dimensions: EMBEDDING_DIMENSIONS,
    reranker_model: RERANK_MODEL
  };
}

function limitations() {
  return [
    DATA_DISCLOSURE,
    'The selected ISO guidance and searchable text from the policies you chose were processed outside this Nimbus host.',
    'The selected models are optimized for retrieval and can still miss indirect, table-based, non-English, or unusually worded coverage.'
  ];
}

function safeHeader(value, max = 240) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function headers() {
  const result = {
    Authorization: `Bearer ${String(process.env.OPENROUTER_API_KEY || '').trim()}`,
    'content-type': 'application/json',
    'X-OpenRouter-Title': safeHeader(process.env.OPENROUTER_APP_NAME || 'Nimbus GRC') || 'Nimbus GRC'
  };
  const siteUrl = safeHeader(process.env.OPENROUTER_SITE_URL || process.env.APP_BASE_URL);
  if (siteUrl) result['HTTP-Referer'] = siteUrl;
  return result;
}

function timeoutMs() {
  const configured = Number(process.env.OPENROUTER_POLICY_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.max(10000, Math.min(180000, configured)) : 90000;
}

function embeddingBatchSize() {
  const configured = Number(process.env.OPENROUTER_POLICY_EMBED_BATCH_SIZE);
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(128, Math.floor(configured)))
    : DEFAULT_EMBEDDING_BATCH_SIZE;
}

async function readJsonBounded(response, operation) {
  const maximum = operation === 'embedding' ? 32 * 1024 * 1024 : 2 * 1024 * 1024;
  const declared = Number(response && response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new PolicyRetrievalError('OpenRouter returned an oversized response.', 'openrouter_policy_response_too_large', 502);
  }
  let text;
  if (response && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => {});
        throw new PolicyRetrievalError('OpenRouter returned an oversized response.', 'openrouter_policy_response_too_large', 502);
      }
      chunks.push(Buffer.from(part.value));
    }
    text = Buffer.concat(chunks, total).toString('utf8');
  } else if (response && typeof response.text === 'function') {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximum) {
      throw new PolicyRetrievalError('OpenRouter returned an oversized response.', 'openrouter_policy_response_too_large', 502);
    }
  } else if (response && typeof response.json === 'function') {
    return response.json().catch(() => ({}));
  } else {
    return {};
  }
  try { return JSON.parse(text || '{}'); } catch (_) { return {}; }
}

function publicProviderMessage(code) {
  if ([401, 403].includes(code)) return 'The server-side OpenRouter key is invalid or lacks access';
  if (code === 402) return 'The OpenRouter account cannot run this request';
  if (code === 404) return 'The fixed NVIDIA free model is currently unavailable';
  if (code === 413) return 'The selected text is too large for OpenRouter; select fewer policies';
  if (code === 429) return 'The OpenRouter free model is rate limited; retry later';
  if (TRANSIENT_STATUS.has(code)) return 'The OpenRouter/NVIDIA free model is temporarily unavailable';
  return 'OpenRouter rejected the policy-retrieval request';
}

async function postJson(url, body, operation, feature = 'policy') {
  if (!isConfigured(feature)) {
    throw new PolicyRetrievalError(configurationError(feature), 'openrouter_policy_not_configured', 503);
  }
  const fetcher = fetchOverride || global.fetch;
  if (typeof fetcher !== 'function') {
    throw new PolicyRetrievalError('This runtime does not provide fetch for OpenRouter requests.', 'openrouter_policy_unavailable', 503);
  }
  // These free trial endpoints log submitted content. Do not automatically
  // resend policy text: the user must make and acknowledge each retry.
  const maxAttempts = 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error'
      });
      const json = await readJsonBounded(response, operation);
      const responseCode = Number(json && json.error && json.error.code || response.status);
      if (!response.ok || (json && json.error)) {
        const transient = TRANSIENT_STATUS.has(responseCode);
        // Provider error bodies are deliberately not reflected: they may echo
        // submitted policy text or internal diagnostics.
        const providerMessage = publicProviderMessage(responseCode);
        const attempts = attempt > 1 ? ` after ${attempt} attempts` : '';
        const publicStatus = responseCode === 413 ? 413
          : responseCode === 429 ? 429
            : responseCode === 408 || responseCode === 524 ? 504
              : 503;
        throw new PolicyRetrievalError(
          `OpenRouter ${operation} error${responseCode ? ` (${responseCode})` : ''}: ${providerMessage}${attempts}.`,
          `openrouter_policy_${operation}_failed`,
          publicStatus
        );
      }
      return json;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new PolicyRetrievalError(`OpenRouter ${operation} timed out.`, `openrouter_policy_${operation}_timeout`, 504);
      }
      if (error instanceof PolicyRetrievalError) throw error;
      throw new PolicyRetrievalError(`OpenRouter ${operation} could not be reached after ${attempt} attempts.`, `openrouter_policy_${operation}_unavailable`, 503);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new PolicyRetrievalError(`OpenRouter ${operation} failed.`, `openrouter_policy_${operation}_failed`, 503);
}

function boundedInputs(values, maxCharacters) {
  if (!Array.isArray(values) || !values.length) {
    throw new PolicyRetrievalError('The OpenRouter request contained no searchable text.', 'openrouter_policy_input_empty', 400);
  }
  return values.map(value => String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxCharacters));
}

function validateEmbeddingResponse(json, expectedCount) {
  if (!json || !EMBEDDING_RESPONSE_MODELS.has(String(json.model || ''))) {
    throw new PolicyRetrievalError('OpenRouter returned embeddings from an unexpected model.', 'openrouter_policy_embedding_model_mismatch', 502);
  }
  if (!json || !Array.isArray(json.data) || json.data.length !== expectedCount) {
      throw new PolicyRetrievalError('OpenRouter returned an incomplete embedding response.', 'openrouter_policy_embedding_invalid', 502);
  }
  const vectors = new Array(expectedCount);
  const seen = new Set();
  for (const item of json.data) {
    const index = Number(item && item.index);
    const vector = item && item.embedding;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount || seen.has(index)
      || !Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS
      || vector.some(value => !Number.isFinite(Number(value)))) {
      throw new PolicyRetrievalError('OpenRouter returned invalid embedding vectors.', 'openrouter_policy_embedding_invalid', 502);
    }
    seen.add(index);
    const numeric = vector.map(Number);
    const norm = Math.sqrt(numeric.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm <= 0) {
      throw new PolicyRetrievalError('OpenRouter returned a zero or invalid embedding vector.', 'openrouter_policy_embedding_invalid', 502);
    }
    vectors[index] = numeric.map(value => value / norm);
  }
  if (vectors.some(vector => !vector)) {
    throw new PolicyRetrievalError('OpenRouter omitted an embedding vector.', 'openrouter_policy_embedding_invalid', 502);
  }
  return vectors;
}

async function embedAll(values, inputType, feature = 'policy') {
  const inputs = boundedInputs(values, 12000);
  if (inputs.some(value => !value)) {
    throw new PolicyRetrievalError('The OpenRouter request contained empty searchable text.', 'openrouter_policy_input_empty', 400);
  }
  const vectors = [];
  const batchSize = embeddingBatchSize();
  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize);
    const json = await postJson(EMBEDDINGS_URL, {
      model: EMBEDDING_MODEL,
      input: batch,
      input_type: inputType,
      encoding_format: 'float'
    }, 'embedding', feature);
    vectors.push(...validateEmbeddingResponse(json, batch.length));
  }
  return vectors;
}

function validateRerankResponse(json, expectedCount) {
  if (!json || !RERANK_RESPONSE_MODELS.has(String(json.model || ''))) {
    throw new PolicyRetrievalError('OpenRouter returned reranking data from an unexpected model.', 'openrouter_policy_rerank_model_mismatch', 502);
  }
  if (!json || !Array.isArray(json.results) || json.results.length !== expectedCount) {
    throw new PolicyRetrievalError('OpenRouter returned an incomplete rerank response.', 'openrouter_policy_rerank_invalid', 502);
  }
  const scores = new Array(expectedCount);
  const seen = new Set();
  for (const item of json.results) {
    const index = Number(item && item.index);
    const score = Number(item && item.relevance_score);
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount || seen.has(index) || !Number.isFinite(score)) {
      throw new PolicyRetrievalError('OpenRouter returned invalid rerank scores.', 'openrouter_policy_rerank_invalid', 502);
    }
    seen.add(index);
    scores[index] = score;
  }
  if (scores.some(score => !Number.isFinite(score))) {
    throw new PolicyRetrievalError('OpenRouter omitted a rerank score.', 'openrouter_policy_rerank_invalid', 502);
  }
  return scores;
}

function createBackend(feature = 'policy') {
  if (!isConfigured(feature)) {
    throw new PolicyRetrievalError(configurationError(feature), 'openrouter_policy_not_configured', 503);
  }
  return {
    label: 'OpenRouter',
    cacheKey: `openrouter:${EMBEDDING_MODEL}`,
    embedQueries(values) {
      return embedAll(values, 'query', feature);
    },
    embedDocuments(values) {
      return embedAll(values, 'passage', feature);
    },
    async rerank(query, passages) {
      const documents = boundedInputs(passages, 12000);
      const boundedQuery = boundedInputs([query], 4000)[0];
      if (documents.some(value => !value) || !boundedQuery) {
        throw new PolicyRetrievalError('The OpenRouter rerank request contained empty text.', 'openrouter_policy_input_empty', 400);
      }
      const json = await postJson(RERANK_URL, {
        model: RERANK_MODEL,
        query: boundedQuery,
        documents,
        top_n: documents.length
      }, 'rerank', feature);
      return validateRerankResponse(json, documents.length);
    }
  };
}

async function backend(feature = 'policy') {
  return backendOverride || createBackend(feature);
}

let queueTail = Promise.resolve();
let queuedRuns = 0;

async function withRunSlot(task) {
  if (queuedRuns >= 4) {
    throw new PolicyRetrievalError('OpenRouter policy analysis is busy. Try again after the current searches finish.', 'openrouter_policy_busy', 429);
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

function minimumScore() {
  const configured = Number(process.env.OPENROUTER_POLICY_RERANK_MIN_SCORE);
  return Number.isFinite(configured) ? configured : 0;
}

function _setFetchForTests(value) {
  fetchOverride = value || null;
}

function _setBackendForTests(value) {
  backendOverride = value || null;
}

module.exports = {
  DATA_DISCLOSURE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  MAX_DOCUMENTS,
  MAX_RAW_TOTAL_CHARACTERS,
  MAX_TOTAL_CHARACTERS,
  RERANK_MODEL,
  backend,
  configurationError,
  isConfigured,
  isEnabled,
  limitations,
  minimumScore,
  modelInfo,
  withRunSlot,
  _setBackendForTests,
  _setFetchForTests
};
