'use strict';
// Governed catalogue seeding, shared by every framework.
//
// Extracted from lib/dpdpa-gap-domain.js ensureFrameworkSeeded, which was the
// only implementation of this and was about to be copied for SOC 2. The
// behaviour is deliberately unchanged: register the framework version, retire
// prior versions of the same code, insert requirements once, then refuse to
// proceed if what is already in the database differs from the supplied
// catalogue by so much as a sort order.
//
// The refusal is the point. A catalogue is content-hashed and immutable; if the
// stored requirements drift from the shipped ones, every approved assessment
// pinned to that hash becomes unreproducible. Seeding fails loudly instead.
//
// The hashing helpers live here because two implementations of stableStringify
// would eventually diverge and silently change a seed hash.

const crypto = require('crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : stableStringify(value))
    .digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function frameworkRequirements(db, frameworkId, normalizeGuidance) {
  return db.prepare(`SELECT ref,parent_ref,req_type,title,summary,guidance,sort_order
    FROM requirements WHERE framework_id=? ORDER BY sort_order,ref`).all(frameworkId).map(row => ({
      ...row,
      guidance: normalizeGuidance(row.guidance),
    }));
}

/**
 * Seed one governed catalogue and lock it.
 *
 * @param db                better-sqlite3 handle
 * @param normalized        the module's normalized catalogue: { code, name, version,
 *                          sourceReference, catalogHash, seedHash, requirements,
 *                          catalogManifest }
 * @param opts.normalizeGuidance  how to read a stored guidance column back
 * @param opts.onFail       (code, message, status, details) => never. Lets each
 *                          module keep its own error type and codes.
 * @param opts.codes        error codes to raise, so existing contracts survive
 *                          the extraction unchanged
 */
function seedFrameworkCatalog(db, normalized, opts = {}) {
  const normalizeGuidance = opts.normalizeGuidance || (value => parseJson(value, {}));
  const fail = opts.onFail || ((code, message) => { throw new Error(`${code}: ${message}`); });
  const codes = {
    invalid: 'CATALOG_INVALID',
    drift: 'CATALOG_DRIFT',
    ...(opts.codes || {}),
  };
  const label = opts.label || normalized.code;

  return db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO frameworks(code,name,version,status,is_canonical)
      VALUES (?,?,?,'active',1)`).run(normalized.code, normalized.name, normalized.version);
    const framework = db.prepare('SELECT * FROM frameworks WHERE code=? AND version=?')
      .get(normalized.code, normalized.version);
    if (!framework) fail(codes.invalid, `Unable to register the ${label} framework.`, 500);

    // Promote the governed version without rewriting any historic assessment
    // foreign keys. The framework status enum has no "inactive" value, so
    // prior versions of this code are explicitly retired and made non-canonical.
    db.prepare(`UPDATE frameworks SET status='retired',is_canonical=0
      WHERE code=? AND id<>?`).run(normalized.code, framework.id);
    db.prepare(`UPDATE frameworks SET status='active',is_canonical=1 WHERE id=?`).run(framework.id);
    framework.status = 'active';
    framework.is_canonical = 1;

    let existing = frameworkRequirements(db, framework.id, normalizeGuidance);
    if (!existing.length) {
      const insert = db.prepare(`INSERT INTO requirements
        (framework_id,ref,parent_ref,req_type,title,summary,guidance,sort_order)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const requirement of normalized.requirements) {
        insert.run(framework.id, requirement.ref, requirement.parent_ref, requirement.req_type,
          requirement.title, requirement.summary, stableStringify(requirement.guidance), requirement.sort_order);
      }
      existing = frameworkRequirements(db, framework.id, normalizeGuidance);
    }
    const actualSeedHash = sha256({
      code: normalized.code,
      name: normalized.name,
      version: normalized.version,
      source_reference: normalized.sourceReference,
      requirements: existing,
    });
    if (existing.length !== normalized.requirements.length || actualSeedHash !== normalized.seedHash) {
      fail(codes.drift, `Existing ${label} requirements differ from the governed catalog. Register a new catalog version.`, 409, {
        expected_requirement_count: normalized.requirements.length,
        actual_requirement_count: existing.length,
        expected_seed_hash: normalized.seedHash,
        actual_seed_hash: actualSeedHash,
      });
    }

    const manifestJson = stableStringify(normalized.catalogManifest);
    db.prepare(`INSERT OR IGNORE INTO framework_catalog_releases
      (framework_id,framework_code,catalog_version,catalog_hash,requirement_count,
       source_reference,catalog_manifest_json,is_current)
      VALUES (?,?,?,?,?,?,?,1)`).run(
      framework.id, normalized.code, normalized.version, normalized.catalogHash,
      normalized.requirements.length, normalized.sourceReference, manifestJson
    );
    const release = db.prepare(`SELECT * FROM framework_catalog_releases
      WHERE framework_id=? AND catalog_version=? AND catalog_hash=?`).get(
      framework.id, normalized.version, normalized.catalogHash
    );
    if (!release || release.requirement_count !== normalized.requirements.length
      || release.source_reference !== normalized.sourceReference
      || stableStringify(parseJson(release.catalog_manifest_json, {})) !== manifestJson) {
      fail(codes.drift, `The registered ${label} catalog lock differs from the supplied catalog.`, 409);
    }

    // Exactly one release per framework is current. Anything else with this
    // code is marked superseded so the supersession job can find assessments
    // still pinned to it.
    db.prepare(`UPDATE framework_catalog_releases
      SET is_current=0, superseded_at=COALESCE(superseded_at, datetime('now'))
      WHERE framework_code=? AND id<>? AND is_current=1`).run(normalized.code, release.id);
    db.prepare(`UPDATE framework_catalog_releases
      SET is_current=1, superseded_at=NULL WHERE id=?`).run(release.id);

    return {
      framework,
      release,
      catalog_version: normalized.version,
      catalog_hash: normalized.catalogHash,
      requirement_count: normalized.requirements.length,
      requirements: normalized.requirements,
      source_reference: normalized.sourceReference,
    };
  })();
}

// The release currently registered for a framework code, or null.
function currentRelease(db, frameworkCode) {
  return db.prepare(`SELECT * FROM framework_catalog_releases
    WHERE framework_code=? AND is_current=1
    ORDER BY locked_at DESC, id DESC LIMIT 1`).get(frameworkCode) || null;
}

module.exports = {
  seedFrameworkCatalog,
  currentRelease,
  frameworkRequirements,
  stableValue,
  stableStringify,
  sha256,
  parseJson,
};
