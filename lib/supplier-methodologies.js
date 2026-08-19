'use strict';

const crypto = require('crypto');
const defaultDefinition = require('../data/supplier-methodology-v2026.1.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashDefinition(definition) {
  return crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

function parseDefinition(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function validateDefinition(input) {
  const definition = parseDefinition(input);
  const errors = [];
  if (!definition) return { ok: false, errors: ['The methodology definition is not valid JSON.'] };
  if (!String(definition.title || '').trim()) errors.push('A methodology name is required.');
  const scoring = definition.scoring || {};
  const factors = Array.isArray(scoring.factors) ? scoring.factors : [];
  const inherentQuestions = Array.isArray(scoring.questions) ? scoring.questions : [];
  const factorWeight = factors.reduce((sum, factor) => sum + Number(factor.weight || 0), 0);
  if (Math.abs(factorWeight - 1) > 0.0001) errors.push('Inherent-risk factor weights must total 100%.');
  if (!inherentQuestions.length) errors.push('At least one inherent-risk question is required.');
  const inherentIds = new Set(inherentQuestions.map(question => String(question.id || '').trim()));
  if (inherentIds.size !== inherentQuestions.length || inherentIds.has('')) errors.push('Every inherent-risk question must have a unique ID.');
  factors.forEach(factor => {
    if (!String(factor.name || '').trim()) errors.push('Every factor needs a name.');
    (factor.questionIds || []).forEach(id => {
      if (!inherentIds.has(String(id))) errors.push(`Factor ${factor.name || 'Unnamed'} refers to missing question ${id}.`);
    });
  });
  inherentQuestions.forEach(question => {
    if (!String(question.question || '').trim()) errors.push(`${question.id || 'An inherent question'} needs question text.`);
    const scores = (question.options || []).map(option => Number(option.score));
    if (!scores.length || scores.some(score => !Number.isInteger(score) || score < 0 || score > 5)) errors.push(`${question.id || 'An inherent question'} needs scored options from 0 to 5.`);
  });

  const tiers = definition.tiers || {};
  const tierMinimums = ['tier_1','tier_2','tier_3','tier_4'].map(tier => Number(tiers[tier]?.minimumScore));
  if (tierMinimums.some(value => !Number.isFinite(value)) || !(tierMinimums[0] > tierMinimums[1] && tierMinimums[1] > tierMinimums[2] && tierMinimums[2] >= tierMinimums[3])) {
    errors.push('Tier minimum scores must descend from Tier 1 to Tier 4.');
  }

  const baseQuestions = Array.isArray(definition.ddqQuestions) ? definition.ddqQuestions : [];
  const modules = Array.isArray(definition.modules) ? definition.modules : [];
  const moduleQuestions = modules.flatMap(module => module.questions || []);
  const moduleQuestionIds = new Set(moduleQuestions.map(question => String(question.id || '').trim()));
  const allQuestions = [...baseQuestions, ...moduleQuestions];
  const questionIds = new Set();
  allQuestions.forEach(question => {
    const id = String(question.id || '').trim();
    if (!id || questionIds.has(id)) errors.push(`Question ID ${id || '(blank)'} is missing or duplicated.`);
    questionIds.add(id);
    if (question.enabled !== false && !String(question.question || '').trim()) errors.push(`${id || 'A DDQ question'} needs question text.`);
    if (question.enabled !== false && !moduleQuestionIds.has(id) && (!Array.isArray(question.tiers) || !question.tiers.length)) errors.push(`${id || 'A DDQ question'} must apply to at least one tier.`);
  });
  if (!allQuestions.some(question => question.enabled !== false)) errors.push('At least one due-diligence question must be enabled.');
  return { ok: errors.length === 0, errors, definition };
}

function rowWithDefinition(row) {
  if (!row) return null;
  return { ...row, definition: parseDefinition(row.definition_json) || clone(defaultDefinition) };
}

function freezeLegacyAssessments(db, workspaceId, row) {
  if (!row || !row.definition_json) return;
  const methodologyHash = row.content_hash || hashDefinition(parseDefinition(row.definition_json) || defaultDefinition);
  const assessmentTables = [
    'supplier_inherent_assessments',
    'supplier_ddq_assessments',
    'supplier_contract_reviews',
  ];
  assessmentTables.forEach(table => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) return;
    db.prepare(`UPDATE ${table}
      SET methodology_id=?, methodology_snapshot_json=?, methodology_hash=?
      WHERE workspace_id=? AND methodology_snapshot_json IS NULL`).run(
        row.id, row.definition_json, methodologyHash, workspaceId
      );
  });
}

function ensureActive(db, workspaceId, userId = null) {
  let row = db.prepare(`SELECT * FROM supplier_risk_methodologies
    WHERE workspace_id=? AND is_active=1 AND status='published' AND definition_json IS NOT NULL
    ORDER BY version DESC LIMIT 1`).get(workspaceId);
  if (row) {
    freezeLegacyAssessments(db, workspaceId, row);
    return rowWithDefinition(row);
  }
  const prior = db.prepare(`SELECT * FROM supplier_risk_methodologies WHERE workspace_id=? AND is_active=1 ORDER BY version DESC LIMIT 1`).get(workspaceId);
  if (prior) db.prepare('UPDATE supplier_risk_methodologies SET is_active=0 WHERE id=?').run(prior.id);
  const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM supplier_risk_methodologies WHERE workspace_id=?').get(workspaceId).version);
  const definition = clone(defaultDefinition);
  const hash = hashDefinition(definition);
  const id = db.prepare(`INSERT INTO supplier_risk_methodologies
    (workspace_id,version,name,domain_weights,control_weights,thresholds,review_cadence,is_active,created_by,definition_json,status,content_hash,published_by,published_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,'published',?,?,datetime('now'))`).run(
      workspaceId, version, definition.title,
      JSON.stringify(definition.scoring.factors), JSON.stringify({ questions: definition.scoring.questions }),
      JSON.stringify(definition.tiers), JSON.stringify(Object.fromEntries(Object.entries(definition.tiers).map(([id,tier]) => [id,tier.reviewCadenceMonths]))),
      userId, JSON.stringify(definition), hash, userId
    ).lastInsertRowid;
  row = db.prepare('SELECT * FROM supplier_risk_methodologies WHERE id=?').get(id);
  freezeLegacyAssessments(db, workspaceId, row);
  return rowWithDefinition(row);
}

function active(db, workspaceId, userId = null) {
  return ensureActive(db, workspaceId, userId);
}

function draft(db, workspaceId) {
  return rowWithDefinition(db.prepare(`SELECT * FROM supplier_risk_methodologies
    WHERE workspace_id=? AND status='draft' ORDER BY version DESC LIMIT 1`).get(workspaceId));
}

function forAssessment(db, assessment, workspaceId, userId = null) {
  const snapshot = parseDefinition(assessment && assessment.methodology_snapshot_json);
  if (snapshot) return { id: assessment.methodology_id || null, version: assessment.methodology_version, content_hash: assessment.methodology_hash || hashDefinition(snapshot), definition: snapshot, snapshot: true };
  if (assessment && assessment.methodology_id) {
    const row = rowWithDefinition(db.prepare('SELECT * FROM supplier_risk_methodologies WHERE id=? AND workspace_id=?').get(assessment.methodology_id, workspaceId));
    if (row) return row;
  }
  return active(db, workspaceId, userId);
}

function snapshot(record) {
  const definition = clone(record.definition);
  return {
    methodologyId: record.id || null,
    methodologyVersion: String(record.version || definition.version || '1'),
    methodologyJson: JSON.stringify(definition),
    methodologyHash: record.content_hash || hashDefinition(definition),
  };
}

function createDraft(db, workspaceId, userId = null) {
  const existing = draft(db, workspaceId);
  if (existing) return existing;
  const current = active(db, workspaceId, userId);
  const definition = clone(current.definition);
  const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM supplier_risk_methodologies WHERE workspace_id=?').get(workspaceId).version);
  const id = db.prepare(`INSERT INTO supplier_risk_methodologies
    (workspace_id,version,name,domain_weights,control_weights,thresholds,review_cadence,is_active,created_by,definition_json,status,content_hash,supersedes_id)
    VALUES (?,?,?,?,?,?,?,0,?,?,'draft',?,?)`).run(
      workspaceId, version, definition.title,
      JSON.stringify(definition.scoring.factors), JSON.stringify({ questions: definition.scoring.questions }),
      JSON.stringify(definition.tiers), JSON.stringify(Object.fromEntries(Object.entries(definition.tiers).map(([id,tier]) => [id,tier.reviewCadenceMonths]))),
      userId, JSON.stringify(definition), hashDefinition(definition), current.id
    ).lastInsertRowid;
  return rowWithDefinition(db.prepare('SELECT * FROM supplier_risk_methodologies WHERE id=?').get(id));
}

function saveDraft(db, row, definition) {
  if (!row || row.status !== 'draft') throw new Error('Only a draft methodology can be changed.');
  const hash = hashDefinition(definition);
  db.prepare(`UPDATE supplier_risk_methodologies SET name=?,domain_weights=?,control_weights=?,thresholds=?,review_cadence=?,definition_json=?,content_hash=? WHERE id=? AND status='draft'`).run(
    definition.title, JSON.stringify(definition.scoring.factors), JSON.stringify({ questions: definition.scoring.questions }),
    JSON.stringify(definition.tiers), JSON.stringify(Object.fromEntries(Object.entries(definition.tiers).map(([id,tier]) => [id,tier.reviewCadenceMonths]))),
    JSON.stringify(definition), hash, row.id
  );
  return rowWithDefinition(db.prepare('SELECT * FROM supplier_risk_methodologies WHERE id=?').get(row.id));
}

function publishDraft(db, row, userId = null) {
  if (!row || row.status !== 'draft') return { ok: false, errors: ['No editable methodology version exists.'] };
  const definition = clone(row.definition);
  definition.version = `workspace-${row.workspace_id}.${row.version}`;
  const validation = validateDefinition(definition);
  if (!validation.ok) return validation;
  const hash = hashDefinition(definition);
  db.transaction(() => {
    db.prepare('UPDATE supplier_risk_methodologies SET is_active=0 WHERE workspace_id=? AND is_active=1').run(row.workspace_id);
    db.prepare(`UPDATE supplier_risk_methodologies SET name=?,definition_json=?,content_hash=?,status='published',is_active=1,published_by=?,published_at=datetime('now') WHERE id=? AND status='draft'`)
      .run(definition.title, JSON.stringify(definition), hash, userId, row.id);
  })();
  return { ok: true, record: rowWithDefinition(db.prepare('SELECT * FROM supplier_risk_methodologies WHERE id=?').get(row.id)) };
}

module.exports = { defaultDefinition, clone, hashDefinition, parseDefinition, validateDefinition, ensureActive, active, draft, forAssessment, snapshot, createDraft, saveDraft, publishDraft };
