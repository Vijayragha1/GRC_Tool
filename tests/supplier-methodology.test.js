'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const supplierMethodologies = require('../lib/supplier-methodologies');
const supplierRisk = require('../lib/supplier-risk');

function testDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY);
    CREATE TABLE supplier_risk_methodologies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, version INTEGER NOT NULL,
      name TEXT NOT NULL, domain_weights TEXT NOT NULL, control_weights TEXT NOT NULL,
      thresholds TEXT NOT NULL, review_cadence TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), definition_json TEXT,
      status TEXT NOT NULL DEFAULT 'published', content_hash TEXT, supersedes_id INTEGER,
      published_by INTEGER, published_at TEXT, UNIQUE(workspace_id,version)
    );
    CREATE UNIQUE INDEX idx_test_active ON supplier_risk_methodologies(workspace_id) WHERE is_active=1;
    INSERT INTO workspaces (id) VALUES (1);
    INSERT INTO users (id) VALUES (7);
  `);
  return db;
}

test('supplier methodology changes are drafted, validated and published as a new active version', () => {
  const db = testDb();
  const first = supplierMethodologies.active(db, 1, 7);
  const draft = supplierMethodologies.createDraft(db, 1, 7);
  assert.equal(first.status, 'published');
  assert.equal(draft.status, 'draft');
  assert.notEqual(first.id, draft.id);

  const changed = supplierMethodologies.clone(draft.definition);
  changed.title = 'Firm supplier assurance methodology';
  changed.tiers.tier_1.minimumScore = 75;
  changed.ddqQuestions[0].question = 'Configured supplier question';
  supplierMethodologies.saveDraft(db, draft, changed);

  const stillActive = supplierMethodologies.active(db, 1, 7);
  assert.equal(stillActive.id, first.id);
  assert.notEqual(stillActive.definition.ddqQuestions[0].question, 'Configured supplier question');

  const result = supplierMethodologies.publishDraft(db, supplierMethodologies.draft(db, 1), 7);
  assert.equal(result.ok, true);
  assert.equal(result.record.definition.title, 'Firm supplier assurance methodology');
  assert.equal(supplierMethodologies.active(db, 1, 7).id, result.record.id);
  db.close();
});

test('assessment snapshots and configured scope remain stable after later edits', () => {
  const db = testDb();
  const first = supplierMethodologies.active(db, 1, 7);
  const snapshot = supplierMethodologies.snapshot(first);
  const assessment = {
    workspace_id: 1,
    methodology_id: snapshot.methodologyId,
    methodology_version: snapshot.methodologyVersion,
    methodology_snapshot_json: snapshot.methodologyJson,
    methodology_hash: snapshot.methodologyHash,
  };
  const draft = supplierMethodologies.createDraft(db, 1, 7);
  const changed = supplierMethodologies.clone(draft.definition);
  changed.ddqQuestions[0].enabled = false;
  supplierMethodologies.saveDraft(db, draft, changed);
  supplierMethodologies.publishDraft(db, supplierMethodologies.draft(db, 1), 7);

  const retained = supplierMethodologies.forAssessment(db, assessment, 1);
  assert.equal(retained.definition.ddqQuestions[0].enabled, undefined);
  assert.equal(retained.content_hash, snapshot.methodologyHash);
  db.close();
});

test('configured tier thresholds and disabled questions drive the calculation and issued scope', () => {
  const definition = supplierMethodologies.clone(supplierRisk.methodology);
  definition.tiers.tier_1.minimumScore = 90;
  definition.tiers.tier_2.minimumScore = 60;
  const answers = Object.fromEntries(definition.scoring.questions.map(question => [question.id, 4]));
  const score = supplierRisk.scoreInherent(answers, definition);
  assert.equal(score.weightedScore, 80);
  assert.equal(score.assignedTier, 'tier_2');

  const firstTierTwo = definition.ddqQuestions.find(question => question.tiers.includes('tier_2'));
  firstTierTwo.enabled = false;
  const questions = supplierRisk.questionsForAssessment('tier_2', {}, 'Test client', definition);
  assert.equal(questions.some(question => question.id === firstTierTwo.id), false);
});

test('legacy assessments are frozen to the active methodology before later versions are published', () => {
  const db = testDb();
  db.exec(`
    CREATE TABLE supplier_inherent_assessments (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, methodology_id INTEGER,
      methodology_snapshot_json TEXT, methodology_hash TEXT
    );
    CREATE TABLE supplier_ddq_assessments (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, methodology_id INTEGER,
      methodology_snapshot_json TEXT, methodology_hash TEXT
    );
    CREATE TABLE supplier_contract_reviews (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, methodology_id INTEGER,
      methodology_snapshot_json TEXT, methodology_hash TEXT
    );
    INSERT INTO supplier_inherent_assessments (id,workspace_id) VALUES (1,1);
    INSERT INTO supplier_ddq_assessments (id,workspace_id) VALUES (1,1);
    INSERT INTO supplier_contract_reviews (id,workspace_id) VALUES (1,1);
  `);

  const active = supplierMethodologies.active(db, 1, 7);
  ['supplier_inherent_assessments','supplier_ddq_assessments','supplier_contract_reviews'].forEach(table => {
    const assessment = db.prepare(`SELECT * FROM ${table} WHERE id=1`).get();
    assert.equal(assessment.methodology_id, active.id);
    assert.equal(assessment.methodology_hash, active.content_hash);
    assert.equal(JSON.parse(assessment.methodology_snapshot_json).title, active.definition.title);
  });
  db.close();
});
