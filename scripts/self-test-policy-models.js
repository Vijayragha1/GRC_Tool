'use strict';

// Executes both pinned ONNX models through the production tokenizer/tensor path.
// The Docker build runs this on Alpine so ABI, WASM, model and feed-name drift
// fail before an image can be published.

const assert = require('node:assert/strict');
const path = require('node:path');

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
if (dirIndex !== -1) {
  if (!args[dirIndex + 1]) throw new Error('--dir requires a path');
  process.env.POLICY_MODEL_DIR = path.resolve(args[dirIndex + 1]);
}
process.env.POLICY_RETRIEVAL_ENABLED = 'true';
process.env.POLICY_MODEL_THREADS = process.env.POLICY_MODEL_THREADS || '1';

const retrieval = require('../lib/policy-retrieval');

async function main() {
  assert.equal(retrieval.isConfigured(), true, retrieval.configurationError());
  const result = await retrieval.retrievePolicyPassages({
    documents: [
      {
        id: 1,
        workspace_id: 1,
        name: 'Access Control Policy',
        status: 'approved',
        version_id: 1,
        version: 1,
        source_hash: 'policy-model-self-test-access',
        linked: true,
        content: '<h2>Access reviews</h2><p>Control owners perform quarterly user access reviews, remove excess privileges, and retain signed approvals.</p>'
      },
      {
        id: 2,
        workspace_id: 1,
        name: 'Travel Policy',
        status: 'approved',
        version_id: 2,
        version: 1,
        source_hash: 'policy-model-self-test-travel',
        linked: false,
        content: '<h2>Expenses</h2><p>Staff submit hotel and meal receipts to Finance within ten days.</p>'
      }
    ],
    queries: ['Review user access rights at planned intervals and remove unnecessary privileges.'],
    limit: 2
  });
  assert.ok(result.passages.length >= 1, 'reranker returned no relevant passage');
  assert.equal(result.passages[0].document_id, 1, 'relevant policy was not ranked first');
  assert.match(result.passages[0].excerpt, /quarterly user access reviews/i);
  process.stdout.write('Policy model self-test passed: embedding and reranker inference are usable.\n');
}

main().catch(error => {
  process.stderr.write(`Policy model self-test failed: ${error.message}\n`);
  process.exitCode = 1;
});
