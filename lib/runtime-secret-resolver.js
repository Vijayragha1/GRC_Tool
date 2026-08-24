'use strict';

// Resolve external-integration verification material without ever persisting
// it in the application database. The first production transport is
// deliberately environment-backed because it works in a single-node
// deployment and in container secret injection. Cloud-vault reference schemes
// remain valid configuration contracts, but fail closed until their runtime
// provider is explicitly installed and attested.

class SecretReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretReferenceError';
    this.code = code;
  }
}

function resolveRuntimeSecret(reference) {
  const value = String(reference || '').trim();
  const envMatch = value.match(/^env:\/\/([A-Z][A-Z0-9_]{2,127})$/);
  if (envMatch) {
    const secret = process.env[envMatch[1]];
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 16) {
      throw new SecretReferenceError(
        'TPRM_SECRET_UNAVAILABLE',
        'The configured integration verification secret is unavailable.'
      );
    }
    return secret;
  }

  if (/^(?:vault|aws-secretsmanager|azure-keyvault|gcp-secretmanager|keychain):\/\//.test(value)) {
    throw new SecretReferenceError(
      'TPRM_SECRET_PROVIDER_NOT_CONFIGURED',
      'The configured secret-provider transport is not installed on this deployment.'
    );
  }

  throw new SecretReferenceError(
    'TPRM_SECRET_REFERENCE_INVALID',
    'The integration secret reference is invalid.'
  );
}

module.exports = { SecretReferenceError, resolveRuntimeSecret };
