'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { bootClient } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const RERANK_MODEL = 'nvidia/llama-nemotron-rerank-vl-1b-v2:free';
const DIMENSIONS = 2048;
const VALID_ACK = Object.freeze({
  ai_external_ack: 'accepted',
  ai_data_classification: 'non_confidential_trial'
});

let env;
let db;
let manager;
let evidenceRetrieval;
let openRouter;
let managerId;
let managerFirmId;
let workspaceAId;
let workspaceBId;
let isoItemId;
let evidenceA;
let evidenceB;
let backendCalls = [];
let originalEvidenceEnabled;
let serial = 0;
const createdFiles = [];

function parseJson(response) {
  return JSON.parse(response.text || '{}');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function vector(axis = 0) {
  const values = new Array(DIMENSIONS).fill(0);
  values[axis] = 1;
  return values;
}

function relevant(value) {
  return /access|privilege|review|approval/i.test(String(value || ''));
}

function installRouteBackend() {
  backendCalls = [];
  openRouter._setBackendForTests({
    label: 'OpenRouter route test backend',
    cacheKey: `evidence-route-${Date.now()}-${Math.random()}`,
    async embedDocuments(texts) {
      backendCalls.push({ operation: 'embed_documents', texts: texts.slice() });
      return texts.map(text => vector(relevant(text) ? 0 : 1));
    },
    async embedQueries(texts) {
      backendCalls.push({ operation: 'embed_queries', texts: texts.slice() });
      return texts.map(text => vector(relevant(text) ? 0 : 1));
    },
    async rerank(query, passages) {
      backendCalls.push({ operation: 'rerank', query, passages: passages.slice() });
      return passages.map(passage => relevant(passage) ? 0.97 : 0.03);
    }
  });
}

function resolveStoredPath(storedPath, firmId) {
  return path.join(ROOT, 'uploads', `firm_${firmId}`, path.basename(String(storedPath || '')));
}

function createEvidence(workspaceId, firmId, filename, contents, options = {}) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  const storedPath = `evidence-route-${process.pid}-${++serial}-${path.basename(filename)}`;
  const directory = path.join(ROOT, 'uploads', `firm_${firmId}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, storedPath);
  fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
  createdFiles.push(filePath);
  const evidenceId = Number(db.prepare(`INSERT INTO evidence
    (workspace_id,iso_item_id,filename,stored_path,sha256,size_bytes,uploaded_by,
     description,valid_until)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      workspaceId,
      options.isoItemId || null,
      filename,
      storedPath,
      sha256(buffer),
      buffer.length,
      managerId,
      options.description || null,
      options.validUntil || null
    ).lastInsertRowid);
  return { evidenceId, filePath, storedPath, sha256: sha256(buffer) };
}

async function createReadyIndex(workspaceId, evidence, backend) {
  return evidenceRetrieval.indexEvidence({
    db,
    workspaceId,
    evidenceId: evidence.evidenceId,
    actorId: managerId,
    authorizationScope: 'manual_index',
    resolveUploadPath: resolveStoredPath,
    beforeEgress: async () => {},
    retrievalBackend: backend,
    runWithSlot: task => task()
  });
}

async function postSearch(body = VALID_ACK, workspaceId = workspaceAId) {
  return manager.post(
    `/workspaces/${workspaceId}/controls/assess/${isoItemId}/evidence-search`,
    body,
    { json: true, headers: { 'X-CSRF-Token': manager.getCsrfToken() } }
  );
}

async function postManualIndex(evidenceId, body = VALID_ACK) {
  return manager.post(`/workspaces/${workspaceAId}/evidence/${evidenceId}/ai-index`, { ...body });
}

function governedSnapshot() {
  return {
    state: db.prepare(`SELECT status,applicability,maturity,notes,scope_pct,last_updated,
      review_status,review_requested_by,review_requested_at,reviewed_by,reviewed_at,review_reason
      FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`).get(workspaceAId, isoItemId),
    stateHistory: db.prepare(`SELECT COUNT(*) AS count FROM control_state_history
      WHERE workspace_id=? AND iso_item_id=?`).get(workspaceAId, isoItemId).count,
    requirementLinks: db.prepare(`SELECT COUNT(*) AS count FROM evidence_requirement_links erl
      INNER JOIN evidence e ON e.id=erl.evidence_id WHERE e.workspace_id=?`).get(workspaceAId).count,
    evidenceRows: db.prepare(`SELECT id,iso_item_id,sha256,superseded_at FROM evidence
      WHERE workspace_id=? ORDER BY id`).all(workspaceAId)
  };
}

function setOverride(permission, granted) {
  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,?,?,?,'evidence retrieval route test')
    ON CONFLICT(workspace_id,user_id,permission) DO UPDATE SET
      granted=excluded.granted,granted_by=excluded.granted_by,reason=excluded.reason,created_at=CURRENT_TIMESTAMP`)
    .run(workspaceAId, managerId, permission, granted ? 1 : 0, managerId);
}

function clearOverrides() {
  db.prepare('DELETE FROM workspace_role_overrides WHERE workspace_id=? AND user_id=?')
    .run(workspaceAId, managerId);
}

test.before(async () => {
  originalEvidenceEnabled = process.env.OPENROUTER_EVIDENCE_RETRIEVAL_ENABLED;
  process.env.OPENROUTER_EVIDENCE_RETRIEVAL_ENABLED = 'true';
  env = await bootClient();
  manager = env.client;
  db = new Database(env.dbPath);
  evidenceRetrieval = require('../lib/evidence-retrieval');
  openRouter = require('../lib/openrouter-policy-retrieval');
  installRouteBackend();

  const managerRow = db.prepare("SELECT id,firm_id FROM users WHERE email='sec-test@example.com'").get();
  managerId = Number(managerRow.id);
  managerFirmId = Number(managerRow.firm_id);
  const foreignFirmId = Number(db.prepare("INSERT INTO firms(name) VALUES ('EVIDENCE-ROUTE-FOREIGN-FIRM')").run().lastInsertRowid);
  workspaceAId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,frameworks)
    VALUES (?,'EVIDENCE-ROUTE-CLIENT-A','technology','Synthetic route scope','["iso27001"]')`)
    .run(managerFirmId).lastInsertRowid);
  workspaceBId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,frameworks)
    VALUES (?,'EVIDENCE-ROUTE-CLIENT-B-SECRET','finance','Foreign route scope','["iso27001"]')`)
    .run(foreignFirmId).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'manager')")
    .run(workspaceAId, managerId);
  isoItemId = db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1").get().id;

  evidenceA = createEvidence(
    workspaceAId,
    managerFirmId,
    'route-access-review.txt',
    'ROUTE-A-CITATION Quarterly access reviews remove stale privileges and retain signed manager approvals.',
    { isoItemId, validUntil: '2099-12-31' }
  );
  evidenceB = createEvidence(
    workspaceBId,
    foreignFirmId,
    'route-foreign-secret.txt',
    'ROUTE-B-FOREIGN-SECRET Quarterly access review contains another tenant secret.',
    { isoItemId }
  );

  const setupBackend = {
    async embedDocuments(texts) { return texts.map(text => vector(relevant(text) ? 0 : 1)); }
  };
  await createReadyIndex(workspaceAId, evidenceA, setupBackend);
  await createReadyIndex(workspaceBId, evidenceB, setupBackend);
  const page = await manager.get(`/workspaces/${workspaceAId}/controls/assess/${isoItemId}`);
  assert.equal(page.status, 200, page.text.slice(0, 500));
  installRouteBackend();
});

test.after(async () => {
  if (openRouter) openRouter._setBackendForTests(null);
  clearOverrides();
  if (db) {
    try {
      db.prepare("UPDATE users SET firm_role='manager' WHERE id=?").run(managerId);
      db.prepare("UPDATE workspace_members SET role='manager' WHERE workspace_id=? AND user_id=?")
        .run(workspaceAId, managerId);
    } catch (_) {}
    db.close();
  }
  if (manager) await manager.close();
  for (const filePath of createdFiles) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
  if (originalEvidenceEnabled === undefined) delete process.env.OPENROUTER_EVIDENCE_RETRIEVAL_ENABLED;
  else process.env.OPENROUTER_EVIDENCE_RETRIEVAL_ENABLED = originalEvidenceEnabled;
});

test('search returns tenant-scoped reranked citations and never mutates assessment or evidence links', async () => {
  installRouteBackend();
  const before = governedSnapshot();
  const response = await postSearch();
  assert.equal(response.status, 200, response.text);
  assert.match(String(response.headers['cache-control']), /no-store/);
  const payload = parseJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.passages.length, 1);
  assert.equal(payload.result.passages[0].evidence_id, evidenceA.evidenceId);
  assert.equal(payload.result.passages[0].filename, 'route-access-review.txt');
  assert.equal(payload.result.passages[0].linked, true);
  assert.equal(payload.result.passages[0].freshness, 'current_or_unspecified');
  assert.match(payload.result.passages[0].excerpt, /ROUTE-A-CITATION/);
  assert.match(payload.result.passages[0].source_ref,
    new RegExp(`^evidence:${evidenceA.evidenceId}:sha:${evidenceA.sha256.slice(0, 12)}:chunk:0$`));
  assert.equal(payload.result.models.embedding_model, EMBEDDING_MODEL);
  assert.equal(payload.result.models.embedding_dimensions, DIMENSIONS);
  assert.equal(payload.result.models.reranker_model, RERANK_MODEL);
  assert.doesNotMatch(JSON.stringify(payload), /ROUTE-B-FOREIGN-SECRET|EVIDENCE-ROUTE-CLIENT-B-SECRET/);
  assert.doesNotMatch(JSON.stringify(backendCalls), /ROUTE-B-FOREIGN-SECRET/);
  assert.equal(backendCalls.filter(call => call.operation === 'embed_queries').length, 1);
  assert.equal(backendCalls.filter(call => call.operation === 'rerank').length, 1);
  assert.deepEqual(governedSnapshot(), before);

  const audits = db.prepare(`SELECT action,details FROM audit_log
    WHERE workspace_id=? AND action IN ('ai_evidence_query_egress_started','ai_evidence_rerank_egress_started')
    ORDER BY id DESC LIMIT 2`).all(workspaceAId).reverse();
  assert.deepEqual(audits.map(row => row.action), [
    'ai_evidence_query_egress_started',
    'ai_evidence_rerank_egress_started'
  ]);
  const queryDetails = JSON.parse(audits[0].details);
  const rerankDetails = JSON.parse(audits[1].details);
  assert.equal(queryDetails.embedding_model, EMBEDDING_MODEL);
  assert.equal(queryDetails.reranker_model, RERANK_MODEL);
  assert.equal(rerankDetails.embedding_model, EMBEDDING_MODEL);
  assert.equal(rerankDetails.reranker_model, RERANK_MODEL);
  assert.doesNotMatch(JSON.stringify(audits), /ROUTE-A-CITATION|ROUTE-B-FOREIGN-SECRET/);
});

test('literal per-run acknowledgement is required before any provider operation', async () => {
  installRouteBackend();
  const invalidBodies = [
    {},
    { ai_external_ack: true, ai_data_classification: 'non_confidential_trial' },
    { ai_external_ack: 'accepted' },
    { ai_external_ack: 'accepted', ai_data_classification: true },
    { ai_external_ack: 'accepted', ai_data_classification: 'internal' }
  ];
  for (const body of invalidBodies) {
    const response = await postSearch(body);
    assert.equal(response.status, 400, response.text);
    assert.equal(parseJson(response).code, 'external_evidence_acknowledgement_required');
  }
  assert.equal(backendCalls.length, 0);

  const unindexed = createEvidence(
    workspaceAId,
    managerFirmId,
    'manual-consent-check.txt',
    'Manual indexing consent must be literal before access review text leaves Nimbus.',
    { isoItemId }
  );
  for (const body of invalidBodies) {
    const response = await postManualIndex(unindexed.evidenceId, body);
    assert.equal(response.status, 302, response.text);
  }
  assert.equal(backendCalls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evidence_ai_indexes WHERE evidence_id=?').get(unindexed.evidenceId).count, 0);
});

test('control, evidence-content, and external-processing permissions fail before provider use', async () => {
  installRouteBackend();
  db.prepare("UPDATE users SET firm_role='consultant' WHERE id=?").run(managerId);
  db.prepare("UPDATE workspace_members SET role='consultant' WHERE workspace_id=? AND user_id=?")
    .run(workspaceAId, managerId);
  clearOverrides();
  try {
    const noExternal = await postSearch();
    assert.equal(noExternal.status, 403, noExternal.text);
    assert.equal(parseJson(noExternal).code, 'external_evidence_processing_forbidden');

    setOverride('ai.external_process', true);
    for (const permission of ['control.update', 'evidence.view', 'evidence.download']) {
      setOverride(permission, false);
      const denied = await postSearch();
      assert.equal(denied.status, 403, `${permission}: ${denied.text}`);
      assert.equal(backendCalls.length, 0, permission);
      db.prepare(`DELETE FROM workspace_role_overrides
        WHERE workspace_id=? AND user_id=? AND permission=?`).run(workspaceAId, managerId, permission);
    }
  } finally {
    clearOverrides();
    db.prepare("UPDATE workspace_members SET role='manager' WHERE workspace_id=? AND user_id=?")
      .run(workspaceAId, managerId);
    db.prepare("UPDATE users SET firm_role='manager' WHERE id=?").run(managerId);
  }
  assert.equal(backendCalls.length, 0);
});

test('strict query audit failure blocks all search egress', async () => {
  installRouteBackend();
  db.exec(`CREATE TRIGGER evidence_search_audit_block
    BEFORE INSERT ON audit_log
    WHEN NEW.action='ai_evidence_query_egress_started'
    BEGIN SELECT RAISE(ABORT, 'evidence search audit blocked for test'); END`);
  try {
    const response = await postSearch();
    assert.equal(response.status, 500, response.text);
    assert.equal(parseJson(response).code, 'evidence_retrieval_failed');
    assert.equal(backendCalls.length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS evidence_search_audit_block');
  }
});

test('strict index audit failure prevents embedding and leaves no queryable chunks', async () => {
  installRouteBackend();
  const evidence = createEvidence(
    workspaceAId,
    managerFirmId,
    'blocked-index-audit.txt',
    'BLOCKED-INDEX-CONTENT Quarterly access review evidence must not leave without audit.',
    { isoItemId }
  );
  db.exec(`CREATE TRIGGER evidence_index_audit_block
    BEFORE INSERT ON audit_log
    WHEN NEW.action='ai_evidence_index_egress_started'
    BEGIN SELECT RAISE(ABORT, 'evidence index audit blocked for test'); END`);
  try {
    const response = await postManualIndex(evidence.evidenceId);
    assert.equal(response.status, 302, response.text);
    assert.equal(backendCalls.length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS evidence_index_audit_block');
  }
  const indexRow = db.prepare(`SELECT status,chunk_count,last_error_code
    FROM evidence_ai_indexes WHERE evidence_id=? ORDER BY id DESC LIMIT 1`).get(evidence.evidenceId);
  assert.equal(indexRow.status, 'failed');
  assert.equal(indexRow.chunk_count, 0);
  assert.match(indexRow.last_error_code, /^(?:SQLITE_CONSTRAINT_TRIGGER|evidence_index_failed)$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evidence_ai_chunks WHERE evidence_id=?').get(evidence.evidenceId).count, 0);
});

test('manual indexing records unsupported and no-text outcomes without provider use', async () => {
  installRouteBackend();
  const unsupported = createEvidence(
    workspaceAId,
    managerFirmId,
    'unsupported-diagram.png',
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  );
  const empty = createEvidence(workspaceAId, managerFirmId, 'no-searchable-text.txt', ' \n\t ');

  const unsupportedResponse = await postManualIndex(unsupported.evidenceId);
  const emptyResponse = await postManualIndex(empty.evidenceId);
  assert.equal(unsupportedResponse.status, 302, unsupportedResponse.text);
  assert.equal(emptyResponse.status, 302, emptyResponse.text);
  assert.equal(backendCalls.length, 0);

  const rows = db.prepare(`SELECT evidence_id,status,chunk_count,last_error_code
    FROM evidence_ai_indexes WHERE evidence_id IN (?,?) ORDER BY evidence_id`)
    .all(unsupported.evidenceId, empty.evidenceId);
  assert.deepEqual(rows, [
    { evidence_id: unsupported.evidenceId, status: 'unsupported', chunk_count: 0, last_error_code: 'evidence_type_unsupported' },
    { evidence_id: empty.evidenceId, status: 'unsupported', chunk_count: 0, last_error_code: 'evidence_no_searchable_text' }
  ].sort((left, right) => left.evidence_id - right.evidence_id));
});

test('foreign workspace routes cannot expose or process another tenant index', async () => {
  installRouteBackend();
  const response = await postSearch(VALID_ACK, workspaceBId);
  assert.equal(response.status, 403, response.text);
  assert.equal(backendCalls.length, 0);
});
