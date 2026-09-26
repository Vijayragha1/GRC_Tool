'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

let env;
let db;
let manager;
let anonymous;
let workspaceAId;
let workspaceBId;
let emptyWorkspaceId;
let managerId;
let isoItemId;
let secondIsoItemId;
let linkedDocId;
let unlinkedDocId;
let unheadedDocId;
let queueBlockerDocId;
let queuedDocId;
let foreignDocId;
let withdrawnDocId;
let policyRetrieval;
let openRouterPolicyRetrieval;
let backendCalls = 0;
let externalBackendCalls = 0;
let externalPayloads = [];

function parseJson(response) {
  return JSON.parse(response.text || '{}');
}

function vectorFor(text) {
  return /access|privilege|quarter/i.test(String(text))
    ? [1, 0, 0, 0, 0, 0, 0, 0]
    : [0, 1, 0, 0, 0, 0, 0, 0];
}

function installBackend({ mutateOnRerank = null } = {}) {
  policyRetrieval._setBackendForTests({
    cacheKey: `route-backend-${Date.now()}-${Math.random()}`,
    async embed(texts) {
      backendCalls++;
      return texts.map(vectorFor);
    },
    async rerank(_query, passages) {
      backendCalls++;
      if (mutateOnRerank) mutateOnRerank();
      return passages.map(text => /quarterly access review/i.test(text) ? 7 : -9);
    }
  });
}

function installExternalBackend({ mutateOnRerank = null } = {}) {
  externalPayloads = [];
  openRouterPolicyRetrieval._setBackendForTests({
    label: 'OpenRouter',
    cacheKey: `openrouter-route-backend-${Date.now()}-${Math.random()}`,
    async embedQueries(texts) {
      externalBackendCalls++;
      externalPayloads.push({ type: 'query', texts: texts.slice() });
      return texts.map(vectorFor);
    },
    async embedDocuments(texts) {
      externalBackendCalls++;
      externalPayloads.push({ type: 'document', texts: texts.slice() });
      return texts.map(vectorFor);
    },
    async rerank(_query, passages) {
      externalBackendCalls++;
      externalPayloads.push({ type: 'rerank', texts: passages.slice() });
      if (mutateOnRerank) mutateOnRerank();
      return passages.map(text => /quarterly access review/i.test(text) ? 0.9 : 0.01);
    }
  });
}

function governedSnapshot() {
  return db.prepare(`SELECT status,applicability,maturity,notes,scope_pct,last_updated,
    review_status,review_requested_by,review_requested_at,reviewed_by,reviewed_at,review_reason
    FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`).get(workspaceAId, isoItemId);
}

async function postPolicySearch(documentIds, options = {}) {
  const targetIsoItemId = options.isoId || isoItemId;
  return manager.post(
    `/workspaces/${workspaceAId}/controls/assess/${targetIsoItemId}/policy-search`,
    { document_ids: documentIds, ...(options.body || {}) },
    {
      json: true,
      headers: options.csrf === false ? {} : { 'X-CSRF-Token': manager.getCsrfToken() }
    }
  );
}

test.before(async () => {
  env = await bootClient();
  manager = env.client;
  anonymous = makeClient(env.app);
  db = new Database(env.dbPath);
  policyRetrieval = require('../lib/policy-retrieval');
  openRouterPolicyRetrieval = require('../lib/openrouter-policy-retrieval');
  installBackend();
  installExternalBackend();

  const managerRow = db.prepare("SELECT id,firm_id FROM users WHERE email='sec-test@example.com'").get();
  managerId = managerRow.id;
  const foreignFirmId = Number(db.prepare("INSERT INTO firms(name) VALUES ('POLICY-FOREIGN-FIRM-CANARY')").run().lastInsertRowid);
  workspaceAId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,frameworks)
    VALUES (?,'POLICY-CLIENT-A','technology','Cloud services','["iso27001"]')`).run(managerRow.firm_id).lastInsertRowid);
  workspaceBId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,frameworks)
    VALUES (?,'POLICY-CLIENT-B-SECRET','finance','Foreign scope','["iso27001"]')`).run(foreignFirmId).lastInsertRowid);
  emptyWorkspaceId = Number(db.prepare(`INSERT INTO workspaces
    (firm_id,client_name,industry,scope,frameworks)
    VALUES (?,'POLICY-EMPTY-CLIENT','technology','No policy documents','["iso27001"]')`).run(managerRow.firm_id).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'manager')").run(workspaceAId, managerId);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'manager')").run(emptyWorkspaceId, managerId);

  isoItemId = db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1").get().id;
  secondIsoItemId = db.prepare("SELECT id FROM iso_items WHERE type='control' AND id<>? ORDER BY sort_order LIMIT 1").get(isoItemId).id;
  const requirementId = db.prepare(`SELECT rq.id FROM requirements rq
    INNER JOIN frameworks f ON f.id=rq.framework_id
    WHERE f.code='iso27001' AND rq.ref=?`).get(isoItemId).id;
  linkedDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'A-ACCESS-POLICY-CANARY','policy','<h2>Access reviews</h2><p>Owners perform a quarterly access review, remove excess privileges, and retain approvals.</p>','draft',?)`)
    .run(workspaceAId, managerId).lastInsertRowid);
  unlinkedDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'A-TRAVEL-POLICY-CANARY','policy','<h2>Travel</h2><p>Staff submit hotel receipts to Finance within ten days.</p>','draft',?)`)
    .run(workspaceAId, managerId).lastInsertRowid);
  unheadedDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'CLIENT-SECRET-UNHEADED-POLICY-TITLE','policy','<p>Owners perform quarterly access reviews and retain approvals for this synthetic route test.</p>','draft',?)`)
    .run(workspaceAId, managerId).lastInsertRowid);
  queueBlockerDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'QUEUE-BLOCKER-POLICY','policy','<p>Quarterly access review evidence for the queue blocker.</p>','draft',?)`)
    .run(workspaceAId, managerId).lastInsertRowid);
  queuedDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'QUEUED-POLICY','policy','<p>QUEUED-ORIGINAL-CANARY access review evidence.</p>','draft',?)`)
    .run(workspaceAId, managerId).lastInsertRowid);
  foreignDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'B-FOREIGN-POLICY-SECRET','policy','B-FOREIGN-DOCUMENT-BODY-SECRET','draft',?)`)
    .run(workspaceBId, managerId).lastInsertRowid);
  withdrawnDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'A-WITHDRAWN-POLICY-SECRET','policy','A-WITHDRAWN-BODY-SECRET','withdrawn',?)`)
    .run(workspaceAId, managerId).lastInsertRowid);
  db.prepare('INSERT INTO document_requirement_links(document_id,requirement_id) VALUES (?,?)').run(linkedDocId, requirementId);
  for (let index = 1; index <= 21; index++) {
    const extraId = Number(db.prepare(`INSERT INTO generated_docs
      (workspace_id,name,category,content,status,created_by)
      VALUES (?,?, 'policy','<p>Additional linked policy text for selector boundary coverage.</p>','draft',?)`)
      .run(workspaceAId, `ZZ-LINKED-POLICY-${String(index).padStart(2, '0')}`, managerId).lastInsertRowid);
    db.prepare('INSERT INTO document_requirement_links(document_id,requirement_id) VALUES (?,?)').run(extraId, requirementId);
  }

  await manager.get(`/workspaces/${workspaceAId}/controls/assess/${isoItemId}`);
});

test.after(async () => {
  if (policyRetrieval) policyRetrieval._setBackendForTests(null);
  if (openRouterPolicyRetrieval) openRouterPolicyRetrieval._setBackendForTests(null);
  if (db) db.close();
  if (anonymous) await anonymous.close();
  if (manager) await manager.close();
});

test('assessment workpaper exposes no standalone policy-search panel or source picker', async () => {
  const page = await manager.get(`/workspaces/${workspaceAId}/controls/assess/${isoItemId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="assessmentCopilotPanel"/);
  assert.match(page.text, /Each draft automatically searches available policy and indexed Evidence Library content/);
  assert.doesNotMatch(page.text,
    /id="(?:policyCoveragePanel|policyCoverageEngine|policyCoverageButton|policyOpenRouterAcknowledgement)"|class="policy-search-doc"/);
});

test('an empty policy library still exposes only Copilot, without a standalone policy-search fallback', async () => {
  const page = await manager.get(`/workspaces/${emptyWorkspaceId}/controls/assess/${isoItemId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="assessmentCopilotPanel"/);
  assert.doesNotMatch(page.text,
    /id="(?:policyCoveragePanel|policyCoverageEngine|policyCoverageButton|policyOpenRouterAcknowledgement)"|class="policy-search-doc"/);
});

test('local-model unavailability never reveals a standalone external policy engine picker', async () => {
  const priorEnabled = process.env.POLICY_RETRIEVAL_ENABLED;
  policyRetrieval._setBackendForTests(null);
  process.env.POLICY_RETRIEVAL_ENABLED = 'false';
  try {
    const page = await manager.get(`/workspaces/${workspaceAId}/controls/assess/${isoItemId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /id="assessmentCopilotPanel"/);
    assert.doesNotMatch(page.text,
      /id="(?:policyCoveragePanel|policyCoverageEngine|policyCoverageButton|policyOpenRouterDisclosure)"|value="openrouter-nemotron"/);
  } finally {
    if (priorEnabled === undefined) delete process.env.POLICY_RETRIEVAL_ENABLED;
    else process.env.POLICY_RETRIEVAL_ENABLED = priorEnabled;
    installBackend();
  }
});

test('OpenRouter engine requires a literal fresh acknowledgement before external model use', async () => {
  externalBackendCalls = 0;
  installExternalBackend();
  for (const acknowledgement of [undefined, false, 'true', 1]) {
    const response = await postPolicySearch([linkedDocId], {
      body: {
        engine: 'openrouter-nemotron',
        ...(acknowledgement === undefined ? {} : { external_processing_acknowledged: acknowledgement })
      }
    });
    assert.equal(response.status, 400, response.text);
    assert.equal(parseJson(response).code, 'external_processing_acknowledgement_required');
  }
  const unknown = await postPolicySearch([linkedDocId], {
    body: { engine: 'attacker-model', external_processing_acknowledged: true }
  });
  assert.equal(unknown.status, 400);
  assert.equal(parseJson(unknown).code, 'policy_engine_invalid');
  assert.equal(externalBackendCalls, 0);
});

test('control.update and manager-controlled external-processing authority fail before OpenRouter use', async () => {
  externalBackendCalls = 0;
  installExternalBackend();
  db.prepare("UPDATE users SET firm_role='consultant' WHERE id=?").run(managerId);
  db.prepare("UPDATE workspace_members SET role='consultant' WHERE workspace_id=? AND user_id=?").run(workspaceAId, managerId);
  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,'control.update',0,?,'external policy egress test')`).run(workspaceAId, managerId, managerId);
  try {
    const deniedControl = await postPolicySearch([linkedDocId], {
      body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
    });
    assert.equal(deniedControl.status, 403);
    assert.equal(externalBackendCalls, 0);
  } finally {
    db.prepare(`DELETE FROM workspace_role_overrides
      WHERE workspace_id=? AND user_id=? AND permission='control.update'`).run(workspaceAId, managerId);
  }

  db.prepare("UPDATE users SET firm_role='senior_consultant' WHERE id=?").run(managerId);
  db.prepare("UPDATE workspace_members SET role='senior_consultant' WHERE workspace_id=? AND user_id=?").run(workspaceAId, managerId);
  try {
    const deniedExternal = await postPolicySearch([linkedDocId], {
      body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
    });
    assert.equal(deniedExternal.status, 403, deniedExternal.text);
    assert.equal(parseJson(deniedExternal).code, 'external_processing_forbidden');
    assert.equal(externalBackendCalls, 0);
  } finally {
    db.prepare("UPDATE workspace_members SET role='manager' WHERE workspace_id=? AND user_id=?").run(workspaceAId, managerId);
    db.prepare("UPDATE users SET firm_role='manager' WHERE id=?").run(managerId);
  }
});

test('a failed strict pre-egress audit blocks every OpenRouter model call', async () => {
  externalBackendCalls = 0;
  installExternalBackend();
  db.exec(`CREATE TRIGGER policy_search_audit_block
    BEFORE INSERT ON audit_log
    WHEN NEW.action='ai_policy_search_started'
    BEGIN SELECT RAISE(ABORT, 'policy search audit blocked for test'); END`);
  try {
    const response = await postPolicySearch([linkedDocId], {
      body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
    });
    assert.equal(response.status, 500, response.text);
    assert.equal(externalBackendCalls, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS policy_search_audit_block');
  }
});

test('authentication, CSRF, workspace isolation, and document.view fail before local model use', async () => {
  backendCalls = 0;
  const anon = await anonymous.post(
    `/workspaces/${workspaceAId}/controls/assess/${isoItemId}/policy-search`,
    { document_ids: [linkedDocId] }, { json: true }
  );
  assert.equal(anon.status, 403);

  const noCsrf = await postPolicySearch([linkedDocId], { csrf: false });
  assert.equal(noCsrf.status, 403);

  const foreignWorkspace = await manager.post(
    `/workspaces/${workspaceBId}/controls/assess/${isoItemId}/policy-search`,
    { document_ids: [foreignDocId] },
    { json: true, headers: { 'X-CSRF-Token': manager.getCsrfToken() } }
  );
  assert.equal(foreignWorkspace.status, 403);

  const craftedForeignId = await postPolicySearch([foreignDocId]);
  assert.equal(craftedForeignId.status, 400);
  assert.equal(parseJson(craftedForeignId).code, 'policy_document_unavailable');
  assert.equal(backendCalls, 0);

  db.prepare("UPDATE users SET firm_role='consultant' WHERE id=?").run(managerId);
  db.prepare("UPDATE workspace_members SET role='consultant' WHERE workspace_id=? AND user_id=?").run(workspaceAId, managerId);
  db.prepare(`INSERT INTO workspace_role_overrides
    (workspace_id,user_id,permission,granted,granted_by,reason)
    VALUES (?,?,'document.view',0,?,'policy coverage test')`).run(workspaceAId, managerId, managerId);
  try {
    const denied = await postPolicySearch([linkedDocId]);
    assert.equal(denied.status, 403);
    assert.equal(backendCalls, 0);
  } finally {
    db.prepare(`DELETE FROM workspace_role_overrides
      WHERE workspace_id=? AND user_id=? AND permission='document.view'`).run(workspaceAId, managerId);
    db.prepare("UPDATE workspace_members SET role='manager' WHERE workspace_id=? AND user_id=?").run(workspaceAId, managerId);
    db.prepare("UPDATE users SET firm_role='manager' WHERE id=?").run(managerId);
  }
});

test('successful local search returns only cited selected-workspace text and mutates no assessment state', async () => {
  backendCalls = 0;
  installBackend();
  const before = governedSnapshot();
  const response = await postPolicySearch([linkedDocId, unlinkedDocId]);
  assert.equal(response.status, 200, response.text);
  assert.match(String(response.headers['cache-control']), /no-store/);
  const data = parseJson(response);
  assert.equal(data.ok, true);
  assert.equal(data.local_only, true);
  assert.equal(data.passages.length, 1);
  assert.equal(data.passages[0].document_id, linkedDocId);
  assert.match(data.passages[0].excerpt, /quarterly access review/i);
  assert.match(data.passages[0].source_ref, new RegExp(`^document:${linkedDocId}:working:`));
  assert.doesNotMatch(JSON.stringify(data), /B-FOREIGN|A-WITHDRAWN|BODY-SECRET/);
  assert.deepEqual(governedSnapshot(), before);
  assert.ok(backendCalls >= 2);
});

test('successful OpenRouter trial sends only selected HTML-converted retrieval text and mutates no assessment state', async () => {
  externalBackendCalls = 0;
  installExternalBackend();
  const before = governedSnapshot();
  const response = await postPolicySearch([linkedDocId], {
    body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
  });
  assert.equal(response.status, 200, response.text);
  const data = parseJson(response);
  assert.equal(data.ok, true);
  assert.equal(data.engine, 'openrouter-nemotron');
  assert.equal(data.provider, 'OpenRouter');
  assert.equal(data.local_only, false);
  assert.equal(data.models.embedding_model, 'nvidia/llama-nemotron-embed-vl-1b-v2:free');
  assert.equal(data.models.reranker_model, 'nvidia/llama-nemotron-rerank-vl-1b-v2:free');
  assert.equal(data.passages[0].document_id, linkedDocId);
  assert.match(data.passages[0].excerpt, /quarterly access review/i);
  assert.deepEqual(governedSnapshot(), before);
  assert.ok(externalBackendCalls >= 3);

  const externalText = JSON.stringify(externalPayloads);
  assert.match(externalText, /quarterly access review/i);
  assert.doesNotMatch(externalText, /A-ACCESS-POLICY-CANARY|A-TRAVEL-POLICY-CANARY|B-FOREIGN|A-WITHDRAWN|BODY-SECRET/);
  const started = db.prepare(`SELECT details FROM audit_log
    WHERE workspace_id=? AND action='ai_policy_search_started'
    ORDER BY id DESC LIMIT 1`).get(workspaceAId);
  const details = JSON.parse(started.details);
  assert.equal(details.engine, 'openrouter-nemotron');
  assert.equal(details.local_only, false);
  assert.equal(details.external_processing_acknowledged, true);
  assert.equal(details.embedding_model, 'nvidia/llama-nemotron-embed-vl-1b-v2:free');
  assert.equal(details.reranker_model, 'nvidia/llama-nemotron-rerank-vl-1b-v2:free');
  assert.match(JSON.stringify(details.data_categories), /sent_to_openrouter_logged_free_trial/);
  assert.doesNotMatch(JSON.stringify(details), /quarterly access review|OPENROUTER_API_KEY|sk-or-/i);
});

test('headingless policies do not disclose their document title to OpenRouter', async () => {
  externalBackendCalls = 0;
  installExternalBackend();
  const response = await postPolicySearch([unheadedDocId], {
    body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
  });
  assert.equal(response.status, 200, response.text);
  const externalText = JSON.stringify(externalPayloads);
  assert.match(externalText, /quarterly access reviews/i);
  assert.doesNotMatch(externalText, /CLIENT-SECRET-UNHEADED-POLICY-TITLE/);
});

test('governed-version integrity is checked against immutable plaintext before sanitization', async () => {
  const rawVersion = '<h2>Access reviews</h2><p><a href="https://example.test" target="_blank">Quarterly access review</a> evidence is retained by control owners.</p>';
  const governedDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,locked,created_by)
    VALUES (?,'LEGACY-GOVERNED-POLICY','policy',?,'approved',1,?)`)
    .run(workspaceAId, rawVersion, managerId).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO doc_versions
    (workspace_id,document_id,version,name,content,content_hash,status,change_summary,created_by)
    VALUES (?,?,1,'LEGACY-GOVERNED-POLICY',?,?,'approved','legacy raw-byte snapshot',?)`)
    .run(workspaceAId, governedDocId, rawVersion, crypto.createHash('sha256').update(rawVersion).digest('hex'), managerId).lastInsertRowid);
  db.prepare('UPDATE generated_docs SET current_version_id=?,version=1 WHERE id=?').run(versionId, governedDocId);

  installBackend();
  const response = await postPolicySearch([governedDocId]);
  assert.equal(response.status, 200, response.text);
  const data = parseJson(response);
  assert.equal(data.passages[0].document_id, governedDocId);
  assert.match(data.passages[0].excerpt, /Quarterly access review/i);
});

test('oversized stored policy content is rejected before decryption or model work', async () => {
  const oversizedDocId = Number(db.prepare(`INSERT INTO generated_docs
    (workspace_id,name,category,content,status,created_by)
    VALUES (?,'OVERSIZED-POLICY','policy',?,'draft',?)`)
    .run(workspaceAId, 'X'.repeat(policyRetrieval.LIMITS.maxStoredDocumentCharacters + 1), managerId).lastInsertRowid);
  backendCalls = 0;
  installBackend();
  const response = await postPolicySearch([oversizedDocId]);
  assert.equal(response.status, 413, response.text);
  assert.equal(parseJson(response).code, 'policy_document_too_large');
  assert.equal(backendCalls, 0);
});

test('withdrawn sources are rejected and mid-search document edits discard the result', async () => {
  backendCalls = 0;
  const withdrawn = await postPolicySearch([withdrawnDocId]);
  assert.equal(withdrawn.status, 400);
  assert.equal(backendCalls, 0);

  installBackend({
    mutateOnRerank() {
      db.prepare(`UPDATE generated_docs SET content='<p>CONCURRENT POLICY CHANGE</p>', updated_at='2099-01-01 00:00:00'
        WHERE id=? AND workspace_id=?`).run(linkedDocId, workspaceAId);
    }
  });
  const before = governedSnapshot();
  const stale = await postPolicySearch([linkedDocId]);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(parseJson(stale).code, 'stale_policy_source');
  assert.deepEqual(governedSnapshot(), before);
});

test('OpenRouter results are discarded if a selected policy changes during external inference', async () => {
  externalBackendCalls = 0;
  installExternalBackend({
    mutateOnRerank() {
      db.prepare(`UPDATE generated_docs SET content='<p>EXTERNAL CONCURRENT POLICY CHANGE</p>', updated_at='2099-02-01 00:00:00'
        WHERE id=? AND workspace_id=?`).run(unlinkedDocId, workspaceAId);
    }
  });
  const before = governedSnapshot();
  const response = await postPolicySearch([unlinkedDocId], {
    body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
  });
  assert.equal(response.status, 409, response.text);
  assert.equal(parseJson(response).code, 'stale_policy_source');
  assert.deepEqual(governedSnapshot(), before);
  assert.ok(externalBackendCalls >= 3);
});

test('a policy changed while queued is rejected before any of its text reaches OpenRouter', async () => {
  externalBackendCalls = 0;
  externalPayloads = [];
  let releaseFirstQuery;
  let markFirstQueryStarted;
  const firstQueryStarted = new Promise(resolve => { markFirstQueryStarted = resolve; });
  const holdFirstQuery = new Promise(resolve => { releaseFirstQuery = resolve; });
  let queryCalls = 0;
  openRouterPolicyRetrieval._setBackendForTests({
    label: 'OpenRouter',
    cacheKey: `openrouter-queued-stale-${Date.now()}`,
    async embedQueries(texts) {
      externalBackendCalls++;
      queryCalls++;
      externalPayloads.push({ type: 'query', texts: texts.slice() });
      if (queryCalls === 1) {
        markFirstQueryStarted();
        await holdFirstQuery;
      }
      return texts.map(vectorFor);
    },
    async embedDocuments(texts) {
      externalBackendCalls++;
      externalPayloads.push({ type: 'document', texts: texts.slice() });
      return texts.map(vectorFor);
    },
    async rerank(_query, passages) {
      externalBackendCalls++;
      externalPayloads.push({ type: 'rerank', texts: passages.slice() });
      return passages.map(() => 0.9);
    }
  });

  const firstRequest = postPolicySearch([queueBlockerDocId], {
    body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
  });
  await firstQueryStarted;

  const priorStartedAudits = db.prepare(`SELECT COUNT(*) AS count FROM audit_log
    WHERE workspace_id=? AND action='ai_policy_search_started' AND entity_id=?`)
    .get(workspaceAId, secondIsoItemId).count;
  const queuedRequest = postPolicySearch([queuedDocId], {
    isoId: secondIsoItemId,
    body: { engine: 'openrouter-nemotron', external_processing_acknowledged: true }
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM audit_log
      WHERE workspace_id=? AND action='ai_policy_search_started' AND entity_id=?`)
      .get(workspaceAId, secondIsoItemId).count;
    if (count > priorStartedAudits) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const queuedAuditCount = db.prepare(`SELECT COUNT(*) AS count FROM audit_log
    WHERE workspace_id=? AND action='ai_policy_search_started' AND entity_id=?`)
    .get(workspaceAId, secondIsoItemId).count;
  assert.ok(queuedAuditCount > priorStartedAudits, 'second request did not enter the external queue');

  db.prepare(`UPDATE generated_docs
    SET content='<p>QUEUED-MUTATED-CANARY</p>', updated_at='2099-03-01 00:00:00'
    WHERE id=? AND workspace_id=?`).run(queuedDocId, workspaceAId);
  releaseFirstQuery();

  const [firstResponse, queuedResponse] = await Promise.all([firstRequest, queuedRequest]);
  assert.equal(firstResponse.status, 200, firstResponse.text);
  assert.equal(queuedResponse.status, 409, queuedResponse.text);
  assert.equal(parseJson(queuedResponse).code, 'stale_policy_source');
  assert.equal(queryCalls, 1);
  assert.doesNotMatch(JSON.stringify(externalPayloads), /QUEUED-(?:ORIGINAL|MUTATED)-CANARY/);
});

test('assessment UI contains no standalone policy-search client and renders automatic grounding safely', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'controls_assess.ejs'), 'utf8');
  assert.doesNotMatch(source,
    /const policyCoveragePanel|class="policy-search-doc"|id="policyCoveragePanel"|id="policyCoverageEngine"/);
  const script = source.slice(source.indexOf('const assessmentCopilotPanel'));
  assert.match(script, /assessmentCopilotGroundingSummary/);
  assert.match(script, /document\.createElement\('li'\)/);
  assert.doesNotMatch(script, /innerHTML\s*=/);
  assert.doesNotMatch(script, /fetch\([^\n]*policy-search/);
  assert.doesNotMatch(script, /OPENROUTER_API_KEY/);
});
