'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRuntimeSecret } = require('../lib/runtime-secret-resolver');

test('TPRM webhook secret resolver accepts only referenced environment material', () => {
  const name = 'TPRM_TEST_WEBHOOK_SECRET';
  const previous = process.env[name];
  process.env[name] = 'test-only-secret-material-32-bytes';
  try {
    assert.equal(resolveRuntimeSecret(`env://${name}`), process.env[name]);
    assert.throws(() => resolveRuntimeSecret('test-only-secret-material-32-bytes'), error =>
      error.code === 'TPRM_SECRET_REFERENCE_INVALID');
    assert.throws(() => resolveRuntimeSecret('vault://tprm/client/secret'), error =>
      error.code === 'TPRM_SECRET_PROVIDER_NOT_CONFIGURED');
    delete process.env[name];
    assert.throws(() => resolveRuntimeSecret(`env://${name}`), error =>
      error.code === 'TPRM_SECRET_UNAVAILABLE');
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});
