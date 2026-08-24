'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const risk = require('../lib/supplier-risk');
const { bootClient, makeClient } = require('./helpers');

const answersAt = score => Object.fromEntries(risk.methodology.scoring.questions.map(question => [question.id, score]));

test('methodology contains the workbook-governed catalog', () => {
  assert.equal(risk.methodology.scoring.questions.length, 25);
  assert.equal(risk.methodology.scoring.factors.length, 10);
  assert.equal(risk.methodology.scoring.floors.length, 9);
  assert.equal(risk.methodology.ddqQuestions.length, 139);
  assert.equal(risk.methodology.modules.reduce((sum, module) => sum + module.questions.length, 0), 61);
  assert.equal(risk.methodology.contractClauses.length, 47);
});

test('weighted model reproduces the 0 to 100 tier bands', () => {
  const low = risk.scoreInherent(answersAt(0));
  assert.equal(low.weightedScore, 0);
  assert.equal(low.assignedTier, 'tier_4');
  assert.equal(low.finalisable, true);
  const high = risk.scoreInherent(answersAt(5));
  assert.equal(high.weightedScore, 100);
  assert.equal(high.assignedTier, 'tier_1');
});

test('mandatory floors override a low weighted score', () => {
  const t1 = answersAt(0);
  t1.Q14 = 5;
  const t1Result = risk.scoreInherent(t1);
  assert.equal(t1Result.assignedTier, 'tier_1');
  assert.ok(t1Result.triggeredFloors.some(floor => floor.id === 'T1-01'));
  const t2 = answersAt(0);
  t2.Q04 = 4;
  const t2Result = risk.scoreInherent(t2);
  assert.equal(t2Result.assignedTier, 'tier_2');
  assert.ok(t2Result.triggeredFloors.some(floor => floor.id === 'T2-01'));
});

test('unknown and unanswered inherent inputs block finalisation', () => {
  const answers = answersAt(2);
  answers.Q01 = 'unknown';
  delete answers.Q02;
  const result = risk.scoreInherent(answers);
  assert.equal(result.finalisable, false);
  assert.deepEqual(result.unknownQuestionIds, ['Q01']);
  assert.deepEqual(result.unansweredQuestionIds, ['Q02']);
});

test('tier question sets and conditional modules match workbook scope', () => {
  assert.equal(risk.questionsForAssessment('tier_1').length, 139);
  assert.equal(risk.questionsForAssessment('tier_2').length, 112);
  assert.equal(risk.questionsForAssessment('tier_3').length, 53);
  assert.equal(risk.questionsForAssessment('tier_4').length, 22);
  const routes = risk.routeModules({ ...answersAt(0), Q12: 2, Q04: 4 }, 'no');
  assert.equal(routes.find(module => module.name === 'Cloud & Hosting').applicability, 'Yes');
  assert.equal(routes.find(module => module.name === 'Personal Data & Privacy').applicability, 'Yes');
  const scope = Object.fromEntries(routes.map(module => [module.name, module.applicability]));
  assert.equal(risk.questionsForAssessment('tier_4', scope).length, 22 + 12 + 9);
  assert.equal(routes.some(module => module.name === 'Critical Applications'), true);
  assert.equal(risk.questionsForAssessment('tier_4', { 'Trading & Critical Applications': 'Yes' }).length, 22 + 12);
});

test('DDQ row status enforces N/A, evidence, review and finding gates', () => {
  const question = { evidenceMandatory: true };
  assert.equal(risk.evaluateDdqResponse(question, {}), 'Unanswered');
  assert.equal(risk.evaluateDdqResponse(question, { response: 'Not Applicable' }), 'N/A justification required');
  assert.equal(risk.evaluateDdqResponse(question, { response: 'Not Applicable', detail: 'Service does not process client data.' }), 'N/A - Review');
  assert.equal(risk.evaluateDdqResponse(question, { response: 'Yes' }), 'Evidence Missing');
  const evidence = { response: 'Yes', evidence_reference: 'SOC2-CC6.1' };
  assert.equal(risk.evaluateDdqResponse(question, evidence), 'Awaiting Review');
  assert.equal(risk.evaluateDdqResponse(question, { ...evidence, response: 'No', reviewer_conclusion: 'Unsatisfactory' }), 'Review / Finding');
  assert.equal(risk.evaluateDdqResponse(question, { ...evidence, response: 'No', reviewer_conclusion: 'Unsatisfactory', finding_id: 42 }), 'Response Complete');
});

test('DDQ progress separates vendor completion from internal review completion', () => {
  const questions = [
    { id: 'A', evidenceMandatory: false },
    { id: 'B', evidenceMandatory: false }
  ];
  const progress = risk.ddqProgress(questions, {
    A: { response: 'Yes', reviewer_conclusion: 'Not Reviewed' }
  });
  assert.equal(progress.answered, 1);
  assert.equal(progress.unanswered, 1);
  assert.equal(progress.complete, 0);
  assert.equal(progress.open, 2);
});

test('conditional contract clauses follow the approved module scope', () => {
  const cloudClause = risk.methodology.contractClauses.find(clause => clause.id === 'CT-39');
  const universalClause = risk.methodology.contractClauses.find(clause => clause.id === 'CT-01');
  assert.equal(risk.contractClauseRequired(cloudClause, { 'Cloud & Hosting': 'No' }), false);
  assert.equal(risk.contractClauseRequired(cloudClause, { 'Cloud & Hosting': 'Yes' }), true);
  assert.equal(risk.contractClauseRequired(universalClause, {}), true);
  const progress = risk.contractProgress([cloudClause], { 'CT-39': { required: 0, status: 'Not Required' } });
  assert.deepEqual(progress, { total: 1, complete: 1, gaps: 0, open: 0, percentage: 100 });
});

test('positive supplier decision remains blocked until every governed gate passes', () => {
  const blocked = risk.decisionReadiness({ inherent: null, ddq: null, contract: null, openHighFindings: 1, unresolvedModules: 1 });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.length, 5);
  const missingAgreement = risk.decisionReadiness({
    inherent: { approved_at: '2026-08-16' }, ddq: { open: 0 },
    contract: { open: 0, agreement_reference: null, agreement_date: null },
    openHighFindings: 0, unresolvedModules: 0
  });
  assert.equal(missingAgreement.ready, false);
  assert.match(missingAgreement.blockers.join(' '), /agreement reference and valid agreement date/i);
  const ready = risk.decisionReadiness({
    inherent: { approved_at: '2026-08-16' }, ddq: { open: 0 },
    contract: { open: 0, agreement_reference: 'MSA-2026-08', agreement_date: '2026-08-01' },
    openHighFindings: 0, unresolvedModules: 0
  });
  assert.equal(ready.ready, true);
});

test('agreement identity requires trimmed reference and a real ISO calendar date', () => {
  assert.deepEqual(risk.agreementDetails('  MSA-2026-08  ', '2026-08-01'), {
    reference: 'MSA-2026-08', date: '2026-08-01', valid: true, errors: []
  });
  assert.equal(risk.agreementDetails('   ', '2026-08-01').valid, false);
  assert.equal(risk.agreementDetails('MSA-1', '').valid, false);
  assert.equal(risk.agreementDetails('MSA-1', '2026-02-29').valid, false);
  assert.equal(risk.agreementDetails('MSA-1', '2028-02-29').valid, true);
  assert.equal(risk.agreementDetails('MSA-1', '2026-8-1').valid, false);
});

test('migration 042 preserves duplicate decision history and enforces one current lineage', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '042_supplier_governance_integrity.sql'), 'utf8');
  const legacyDb = () => {
    const connection = new Database(':memory:');
    connection.pragma('foreign_keys = ON');
    connection.exec(`CREATE TABLE supplier_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        supplier_id INTEGER NOT NULL,
        decision TEXT NOT NULL,
        rationale TEXT NOT NULL,
        residual_risk_score INTEGER NOT NULL,
        methodology_version INTEGER NOT NULL,
        decider_name TEXT NOT NULL,
        decided_at TEXT DEFAULT (datetime('now')),
        superseded_at TEXT
      );
      CREATE TABLE supplier_contract_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'in_progress',
        agreement_reference TEXT,
        agreement_date TEXT
      );`);
    return connection;
  };

  const db = legacyDb();
  try {
    const insert = db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name,decided_at,superseded_at)
      VALUES (1,?,?,?,?,?,?,?,?)`);
    insert.run(7, 'approved', 'Original approval rationale.', 4, 1, 'Manager', '2026-08-19 10:00:00', null);
    insert.run(7, 'approved', 'Accidental duplicate approval.', 4, 1, 'Manager', '2026-08-19 10:01:00', '2026-08-19 10:01:00');
    insert.run(8, 'rejected', 'Different supplier decision.', 20, 1, 'Manager', '2026-08-19 10:02:00', null);
    db.prepare(`INSERT INTO supplier_contract_reviews (status,agreement_reference,agreement_date)
      VALUES ('complete',NULL,NULL)`).run();
    const beforeCount = db.prepare('SELECT COUNT(*) c FROM supplier_decisions').get().c;
    const beforeHistory = db.prepare(`SELECT id,workspace_id,supplier_id,decision,rationale,residual_risk_score,
      methodology_version,decider_name,decided_at,superseded_at FROM supplier_decisions ORDER BY id`).all();

    db.transaction(() => db.exec(migration))();

    assert.equal(db.prepare('SELECT COUNT(*) c FROM supplier_decisions').get().c, beforeCount,
      'migration must retain every legacy decision row');
    assert.deepEqual(db.prepare(`SELECT id,workspace_id,supplier_id,decision,rationale,residual_risk_score,
      methodology_version,decider_name,decided_at,superseded_at FROM supplier_decisions ORDER BY id`).all(), beforeHistory,
      'migration must not rewrite historic decision state');
    const history = db.prepare(`SELECT id,supplier_id,superseded_at,idempotency_nonce,request_fingerprint,
      expected_current_decision_id,supersedes_id FROM supplier_decisions ORDER BY id`).all();
    history.forEach(item => {
      assert.equal(item.idempotency_nonce, null);
      assert.equal(item.request_fingerprint, null);
      assert.equal(item.expected_current_decision_id, null);
      assert.equal(item.supersedes_id, null);
    });
    assert.equal(db.prepare('SELECT status,agreement_reference,agreement_date FROM supplier_contract_reviews WHERE id=1').get().status, 'complete',
      'legacy invalid review remains visible for explicit replacement');

    assert.throws(() => db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name)
      VALUES (1,7,'renewed','Competing active decision.',4,1,'Manager')`).run(), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name,
       superseded_at,request_fingerprint)
      VALUES (2,99,'rejected','Partial concurrency metadata.',20,1,'Manager',datetime('now'),?)`)
      .run('b'.repeat(64)), /invalid governed supplier decision concurrency metadata/);

    const currentId = history[0].id;
    db.prepare('UPDATE supplier_decisions SET superseded_at=datetime(\'now\') WHERE id=?').run(currentId);
    const nonce = 'a'.repeat(48);
    const fingerprint = 'b'.repeat(64);
    db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name,
       idempotency_nonce,request_fingerprint,expected_current_decision_id,supersedes_id)
      VALUES (1,7,'renewed','Valid successor decision.',4,1,'Manager',?,?,?,?)`)
      .run(nonce, fingerprint, currentId, currentId);
    assert.throws(() => db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name,
       superseded_at,idempotency_nonce,request_fingerprint)
      VALUES (2,99,'renewed','Global nonce collision.',4,1,'Manager',datetime('now'),?,?)`)
      .run(nonce, '9'.repeat(64)), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name,superseded_at,
       idempotency_nonce,request_fingerprint,expected_current_decision_id,supersedes_id)
      VALUES (1,7,'renewed','Branching lineage.',4,1,'Manager',datetime('now'),?,?,?,?)`)
      .run('c'.repeat(48), 'd'.repeat(64), currentId, currentId), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name,superseded_at,
       idempotency_nonce,request_fingerprint,expected_current_decision_id,supersedes_id)
      VALUES (1,8,'renewed','Cross-supplier lineage.',4,1,'Manager',datetime('now'),?,?,?,?)`)
      .run('e'.repeat(48), 'f'.repeat(64), currentId, currentId), /invalid governed supplier decision concurrency metadata/);

    assert.throws(() => db.prepare(`INSERT INTO supplier_contract_reviews
      (status,agreement_reference,agreement_date) VALUES ('in_progress','   ','2026-08-01')`).run(), /requires an agreement reference/);
    assert.throws(() => db.prepare(`INSERT INTO supplier_contract_reviews
      (status,agreement_reference,agreement_date) VALUES ('in_progress','MSA-BAD','2026-02-29')`).run(), /valid ISO agreement date/);
    const reviewId = Number(db.prepare(`INSERT INTO supplier_contract_reviews
      (status,agreement_reference,agreement_date) VALUES ('in_progress','MSA-VALID','2026-08-01')`).run().lastInsertRowid);
    db.prepare('UPDATE supplier_contract_reviews SET agreement_reference=NULL,agreement_date=NULL WHERE id=?').run(reviewId);
    assert.throws(() => db.prepare("UPDATE supplier_contract_reviews SET status='complete' WHERE id=?").run(reviewId), /completed supplier contract review requires/);
  } finally {
    db.close();
  }

  const ambiguous = legacyDb();
  try {
    const insert = ambiguous.prepare(`INSERT INTO supplier_decisions
      (workspace_id,supplier_id,decision,rationale,residual_risk_score,methodology_version,decider_name)
      VALUES (1,7,'approved',?,4,1,'Manager')`);
    insert.run('First unresolved current decision.');
    insert.run('Second unresolved current decision.');
    assert.throws(() => ambiguous.transaction(() => ambiguous.exec(migration))(), /UNIQUE constraint failed/,
      'ambiguous legacy current decisions must fail loud instead of being silently rewritten');
    assert.equal(ambiguous.prepare("SELECT COUNT(*) c FROM pragma_table_info('supplier_decisions') WHERE name='idempotency_nonce'").get().c, 0,
      'runner-style migration transaction must roll back every schema change on failure');
    assert.equal(ambiguous.prepare('SELECT COUNT(*) c FROM supplier_decisions').get().c, 2);
  } finally {
    ambiguous.close();
  }
});

function decisionFormState(html) {
  const nonce = (html.match(/name="decision_nonce" value="([a-f0-9]{48})"/) || [])[1];
  const expected = (html.match(/name="expected_current_decision_id" value="([^"]+)"/) || [])[1];
  assert.ok(nonce, 'decision form must render a per-action nonce');
  assert.notEqual(expected, undefined, 'decision form must render the expected current decision');
  return { decision_nonce: nonce, expected_current_decision_id: expected };
}

test('contract routes enforce agreement gates and the legacy firm-side decision action stays retired', async () => {
  const env = await bootClient();
  const client = env.client;
  const db = new Database(env.dbPath);
  try {
    const firmId = db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
    const managerId = db.prepare(`SELECT id FROM users WHERE email='sec-test@example.com'`).get().id;
    const workspaceId = Number(db.prepare(`INSERT INTO workspaces
      (firm_id,client_name,stage) VALUES (?,'Supplier Governance Client','implementation')`).run(firmId).lastInsertRowid);
    require('../lib/tprm-domain').enableModule(db, {
      workspaceId, serviceModel: 'managed_lifecycle', actorId: managerId,
      reason: 'Exercise the governed third-party assessment compatibility routes.',
    });
    const supplierId = Number(db.prepare(`INSERT INTO suppliers
      (workspace_id,name,service_provided,lifecycle_stage) VALUES (?,'Governed Route Supplier','Critical transaction service','due_diligence')`)
      .run(workspaceId).lastInsertRowid);
    const inherentId = Number(db.prepare(`INSERT INTO supplier_inherent_assessments
      (workspace_id,supplier_id,methodology_version,status,weighted_score,assigned_tier,module_applicability_json,
       unknown_count,approved_at,approved_by,created_by)
      VALUES (?,?,?,'approved',20,'tier_4','[]',0,datetime('now'),?,?)`)
      .run(workspaceId, supplierId, risk.methodology.version, managerId, managerId).lastInsertRowid);
    const contractPath = `/workspaces/${workspaceId}/vendors/${supplierId}/contract-review`;

    let response = await client.post(`${contractPath}/start`, { agreement_reference: '   ', agreement_date: '' });
    assert.equal(response.status, 302);
    assert.match(response.location, /toastKind=error/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM supplier_contract_reviews WHERE supplier_id=?').get(supplierId).c, 0);

    response = await client.post(`${contractPath}/start`, { agreement_reference: 'MSA-BAD-DATE', agreement_date: '2026-02-29' });
    assert.equal(response.status, 302);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM supplier_contract_reviews WHERE supplier_id=?').get(supplierId).c, 0);

    response = await client.post(`${contractPath}/start`, { agreement_reference: '  MSA-GOV-001  ', agreement_date: '2026-08-01' });
    assert.equal(response.status, 302);
    let contract = db.prepare(`SELECT * FROM supplier_contract_reviews WHERE supplier_id=? AND status!='superseded'`).get(supplierId);
    assert.equal(contract.agreement_reference, 'MSA-GOV-001');
    assert.equal(contract.agreement_date, '2026-08-01');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM supplier_contract_review_items WHERE review_id=?').get(contract.id).c, 47);
    assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE workspace_id=? AND entity_type='supplier_contract_review'
      AND entity_id=? AND action='start_supplier_contract_review'`).get(workspaceId, String(contract.id)));

    const contractItems = db.prepare('SELECT * FROM supplier_contract_review_items WHERE review_id=? ORDER BY id').all(contract.id);
    const contractAnswers = (agreementReference, agreementDate) => {
      const body = { action: 'complete', agreement_reference: agreementReference, agreement_date: agreementDate };
      contractItems.forEach(item => {
        body[`required_${item.clause_id}`] = item.required ? '1' : '0';
        body[`status_${item.clause_id}`] = item.required ? 'Present - Satisfactory' : 'Not Required';
        body[`reference_${item.clause_id}`] = item.required ? `MSA-${item.clause_id}` : '';
        body[`comments_${item.clause_id}`] = item.required ? 'Executed clause verified.' : 'Not required by approved scope.';
      });
      return body;
    };

    response = await client.post(contractPath, contractAnswers('', 'bad-date'));
    assert.equal(response.status, 302);
    assert.match(response.location, /toastKind=error/);
    contract = db.prepare('SELECT * FROM supplier_contract_reviews WHERE id=?').get(contract.id);
    assert.equal(contract.status, 'in_progress');
    assert.equal(contract.completed_at, null);
    assert.equal(contract.agreement_reference, null);
    assert.equal(contract.agreement_date, null);

    response = await client.post(contractPath, contractAnswers('MSA-GOV-001', '2026-08-01'));
    assert.equal(response.status, 302);
    contract = db.prepare('SELECT * FROM supplier_contract_reviews WHERE id=?').get(contract.id);
    assert.equal(contract.status, 'complete');
    assert.ok(contract.completed_at);
    const legacyDetail = await client.get(`/workspaces/${workspaceId}/vendors/${supplierId}`);
    assert.equal(legacyDetail.status, 302);
    assert.equal(legacyDetail.location, `/workspaces/${workspaceId}/tprm/third-parties/${supplierId}`);
    response = await client.post(`/workspaces/${workspaceId}/vendors/${supplierId}/decisions`, {
      decision_nonce: '8'.repeat(48), expected_current_decision_id: '', decision: 'approved',
      rationale: 'A consultancy user must not impersonate the client onboarding authority.',
    });
    assert.equal(response.status, 410);
    assert.match(response.text, /firm-side decision action is retired.*client decision authority/i);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM supplier_decisions WHERE supplier_id=?').get(supplierId).c, 0);

    const consultantEmail = 'supplier-consultant@example.test';
    const consultantPassword = 'supplier-consultant-password-1234';
    const consultantId = Number(db.prepare(`INSERT INTO users
      (email,password_hash,name,firm_id,user_type,firm_role,active)
      VALUES (?,?,'Supplier Consultant',?,'firm','consultant',1)`)
      .run(consultantEmail, bcrypt.hashSync(consultantPassword, 4), firmId).lastInsertRowid);
    db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'consultant')`)
      .run(workspaceId, consultantId);
    const consultantClient = makeClient(env.app);
    try {
      const loginPage = await consultantClient.get('/login');
      const loginToken = (loginPage.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
      response = await consultantClient.post('/login', {
        email: consultantEmail, password: consultantPassword, _csrf: loginToken
      }, { csrf: false });
      assert.equal(response.status, 302);
      const consultantPage = await consultantClient.get(`/workspaces/${workspaceId}/vendors/${supplierId}`);
      assert.equal(consultantPage.status, 302);
      assert.equal(consultantPage.location, `/workspaces/${workspaceId}/tprm/third-parties/${supplierId}`);
      response = await consultantClient.post(`/workspaces/${workspaceId}/vendors/${supplierId}/decisions`, {
        decision_nonce: '9'.repeat(48), expected_current_decision_id: '',
        decision: 'rejected', rationale: 'A consultant must not be able to record this decision.'
      });
      assert.equal(response.status, 403);
    } finally {
      await consultantClient.close();
    }
  } finally {
    db.close();
    await client.close();
  }
});
