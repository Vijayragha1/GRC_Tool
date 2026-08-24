'use strict';
// Phase 0 guards: the framework set is enumerated once, catalogues are locked
// through one shared table, and an assessment pinned to a retired catalogue
// raises a notification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const {
  FRAMEWORK_REGISTRY, FRAMEWORK_LIST, ALLOWED_FRAMEWORKS, byFramework, frameworkMeta,
} = require('../lib/frameworks');

test('every registry entry carries the fields its consumers read', () => {
  const required = [
    'code', 'label', 'shortLabel', 'tagLabel', 'systemCode',
    'descriptor', 'pickerLabel', 'pickerNote', 'order',
    // The public programme register renders this one. A framework without it
    // would appear on the marketing site with an empty name.
    'formalName',
  ];
  for (const code of ALLOWED_FRAMEWORKS) {
    const entry = FRAMEWORK_REGISTRY[code];
    assert.equal(entry.code, code, `${code} entry must be keyed by its own code`);
    for (const field of required) {
      assert.ok(entry[field] !== undefined && entry[field] !== '',
        `${code} is missing ${field}, which a picker or dashboard card reads`);
    }
    // A tint is optional, but half a tint renders an invalid style attribute.
    assert.equal(entry.tagRgb === null, entry.tagInk === null,
      `${code} must define both tagRgb and tagInk, or neither`);
  }
  assert.equal(FRAMEWORK_LIST.length, ALLOWED_FRAMEWORKS.length);
  assert.deepEqual(FRAMEWORK_LIST.map(f => f.order), [...FRAMEWORK_LIST.map(f => f.order)].sort((a, b) => a - b),
    'FRAMEWORK_LIST must be pre-sorted for views that iterate it directly');
  assert.deepEqual(Object.keys(byFramework()).sort(), [...ALLOWED_FRAMEWORKS].sort());
  assert.equal(frameworkMeta('nope'), null);
});

test('no consumer re-types the framework set', () => {
  // The enumeration used to be hand-copied into six places, one of them inside
  // SQL, where a missing code silently dropped a framework's evidence links.
  const enumeration = /'iso27001'\s*,\s*'iso42001'|"iso27001"\s*,\s*"iso42001"/;
  for (const file of [
    'lib/evidence-reads.js',
    'lib/integrated-dashboard.js',
    'views/dashboard.ejs',
    'views/workspace_new.ejs',
    'views/engagement_plan.ejs',
    'views/evidence_library.ejs',
  ]) {
    assert.doesNotMatch(read(file), enumeration,
      `${file} enumerates the framework codes by hand; read lib/frameworks.js instead`);
  }
  // The one deliberate literal: the legacy null-frameworks fallback, which must
  // stay pinned to the historical three and never pick up a new programme.
  assert.match(read('lib/frameworks.js'), /LEGACY_DEFAULT_FRAMEWORKS = Object\.freeze\(\['iso27001', 'iso42001', 'csf'\]\)/);
});

test('programme pickers render from the registry', () => {
  for (const file of ['views/dashboard.ejs', 'views/workspace_new.ejs']) {
    const view = read(file);
    assert.match(view, /frameworkList\.forEach/, `${file} must loop the registry`);
    assert.doesNotMatch(view, /name="frameworks"\s+value="[a-z0-9]+"/,
      `${file} still hand-writes a framework checkbox`);
  }
});

test('catalogue seeding and the release lock are shared, not per framework', () => {
  const seed = read('lib/catalog-seed.js');
  assert.match(seed, /function seedFrameworkCatalog/);
  assert.match(seed, /framework_catalog_releases/);
  // Drift refusal is the reason the seeder exists; losing it makes every
  // hash-pinned assessment unreproducible.
  assert.match(seed, /codes\.drift/);

  const domain = read('lib/dpdpa-gap-domain.js');
  assert.match(domain, /catalogSeed\.seedFrameworkCatalog/,
    'DPDPA must seed through the shared path, not its own copy');

  const migration = read('migrations/058_framework_catalog_releases.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS framework_catalog_releases/);
  assert.match(migration, /FROM dpdpa_gap_catalog_versions/, 'DPDPA locks must be backfilled');
  assert.match(migration, /FROM csf_catalog_versions/, 'CSF locks must be backfilled');
});

test('the supersession job is registered and reads the shared release table', () => {
  const jobs = read('lib/jobs.js');
  assert.match(jobs, /function jobCatalogSupersession/);
  assert.match(jobs, /\['catalogSupersession',\s*jobCatalogSupersession\]/,
    'the job must be in the JOBS array, not only defined');
  assert.match(jobs, /FROM framework_catalog_releases WHERE is_current=1/);
  assert.match(jobs, /catalog_superseded/);
});
