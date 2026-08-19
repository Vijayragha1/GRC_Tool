#!/usr/bin/env node
// Bare-node smoke test suite. Boots a fresh DB in a tmp dir, spawns the server
// against it, and walks the most load-bearing routes.
//
//   npm test
//
// Failure mode: prints which route/assertion failed and exits non-zero.
//
// What this catches: schema migrations don't crash on a clean DB, the
// load-bearing GETs return 200, the wizard POST persists state + writes a
// history snapshot, the SoA renders linked risks, the bulk-spawn route
// derives priority. It does NOT cover auth, CSRF, or XSS - those require a
// real test framework with cookie + session handling.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iso27001-smoke-'));
const TMP_DB = path.join(TMP, 'iso27001.db');
// SESSION_SECRET pinned so the session cookie is stable; auth is now real, the
// firm-owner no-auth fallback was removed in commit a573539. DISABLE_CSRF=1 is
// the server's built-in test escape hatch - the body parser and CSRF middleware
// have a chicken-and-egg with multi-request cookie capture in this bare-node
// test, so we turn CSRF off and rely on the security.test.js suite to cover it.
const ENV = { ...process.env, ISMS_KEY_FILE: path.join(TMP, 'master.key'), ISMS_BACKUP_DIR: path.join(TMP, 'backups'), DB_PATH: TMP_DB,
  SESSION_SECRET: 'smoke-test-fixed-secret-for-deterministic-cookies-only',
  DISABLE_CSRF: '1' };

// Login credentials seeded into the test user before the server boots.
const TEST_EMAIL = 'smoke@test.local';
const TEST_PASSWORD = 'smoke-test-password-1234';

let serverProc = null;
let port = 3344;
let assertions = 0, failures = 0;

function ok(name, cond, detail) {
  assertions++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
}

// Cookie jar + CSRF token, both updated from every response. The test bench
// has to act like a real browser now that CSRF protection is on.
let cookieJar = '';
let csrfToken = null;

function captureResponse(res, body) {
  const sc = res.headers['set-cookie'];
  if (sc) {
    const newCookies = (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]);
    const existing = cookieJar ? cookieJar.split('; ').filter(c => !newCookies.some(nc => nc.startsWith(c.split('=')[0] + '='))) : [];
    cookieJar = [...existing, ...newCookies].join('; ');
  }
  const m = body && body.match(/name="csrf-token" content="([a-f0-9]+)"/);
  if (m) csrfToken = m[1];
}

function get(pathStr) {
  return new Promise((resolve, reject) => {
    const headers = cookieJar ? { cookie: cookieJar } : {};
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'GET', headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { captureResponse(res, body); resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(pathStr, formObj) {
  return new Promise((resolve, reject) => {
    // Auto-attach the live CSRF token unless caller already supplied one.
    const payload = { ...formObj };
    if (csrfToken && !payload._csrf) payload._csrf = csrfToken;
    const body = Object.entries(payload).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map(vi => `${encodeURIComponent(k)}=${encodeURIComponent(vi)}`)
                       : [`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`]
    ).join('&');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    };
    if (cookieJar) headers['cookie'] = cookieJar;
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'POST', headers }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => { captureResponse(res, resp); resolve({ status: res.statusCode, body: resp, headers: res.headers }); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postMultipart(pathStr, fieldName, filename, content, contentType = 'text/plain') {
  return new Promise((resolve, reject) => {
    const boundary = `----nimbus-smoke-${Date.now().toString(16)}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(String(content)), tail]);
    const headers = {
      Accept: 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    };
    if (cookieJar) headers.cookie = cookieJar;
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'POST', headers }, res => {
      let resp = '';
      res.on('data', chunk => { resp += chunk; });
      res.on('end', () => { captureResponse(res, resp); resolve({ status: res.statusCode, body: resp, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function startServer() {
  // Copy a freshly-seeded DB from the live one - gives us a workspace + iso_items.
  // db.js honours DB_PATH so the server writes its migrations to the tmp copy.
  // In CI (no live DB, it's gitignored) build a seeded DB instead;
  // FORCE_BUILT_DB=1 exercises that path locally.
  const seedDb = path.join(ROOT, 'iso27001.db');
  if (fs.existsSync(seedDb) && process.env.FORCE_BUILT_DB !== '1') {
    fs.copyFileSync(seedDb, TMP_DB);
  } else {
    console.log('smoke.test: no live DB (or FORCE_BUILT_DB=1); building a seeded one…');
    const build = require('child_process').spawnSync(process.execPath,
      [path.join(ROOT, 'scripts', 'build-test-db.js'), TMP_DB],
      { env: { ...process.env, ISMS_KEY_FILE: ENV.ISMS_KEY_FILE }, stdio: ['ignore', 'ignore', 'pipe'] });
    if (build.status !== 0) throw new Error('build-test-db failed:\n' + build.stderr);
  }

  // Auth is real now (commit a573539). Seed a known test user with a known
  // password so the test can log in before walking the assertions. Reuse the
  // first firm so the user lands as its manager. Low bcrypt rounds for speed.
  const bcrypt = require('bcrypt');
  const Database = require('better-sqlite3');
  const seedConn = new Database(TMP_DB);
  const firm = seedConn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
  if (!firm) {
    seedConn.prepare(`INSERT INTO firms (name) VALUES (?)`).run('Smoke Test Firm');
  }
  const firmId = firm ? firm.id : seedConn.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get().id;
  const hash = bcrypt.hashSync(TEST_PASSWORD, 4);
  const existing = seedConn.prepare('SELECT id FROM users WHERE email=?').get(TEST_EMAIL);
  if (existing) {
    seedConn.prepare(`UPDATE users SET password_hash=?, active=1, firm_role='manager', firm_id=?, user_type='firm' WHERE id=?`)
      .run(hash, firmId, existing.id);
  } else {
    seedConn.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active)
                      VALUES (?, ?, 'Smoke Tester', ?, 'firm', 'manager', 1)`)
      .run(TEST_EMAIL, hash, firmId);
  }
  seedConn.close();

  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...ENV, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  // Server is ready once /login responds (it's public and doesn't require auth).
  const ready = await waitFor(async () => (await get('/login')).status < 500);
  if (!ready) throw new Error('server did not start within 8s');

  // Authenticate: GET /login to capture CSRF token + initial session cookie,
  // then POST /login with the seeded credentials. The login handler regenerates
  // the session id and sets userId; subsequent requests via cookieJar are auth'd.
  await get('/login');
  const loginRes = await post('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  if (loginRes.status < 300 || loginRes.status >= 400) {
    throw new Error(`login failed: expected 3xx, got ${loginRes.status}. Body preview: ${(loginRes.body || '').slice(0, 200)}`);
  }
}

function stopServer() {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
}

(async () => {
  console.log(`smoke tests in ${TMP}\n`);
  try {
    await startServer();

    console.log('boot');
    const dash = await get('/dashboard');
    ok('GET /dashboard returns 200', dash.status === 200, `got ${dash.status}`);

    // Discover the active workspace ID from the seeded DB so the test isn't
    // pinned to a specific id (which the user's live DB no longer matches).
    // Pick the first workspace whose firm_id matches the lowest-id firm -
    // that matches the server's getActiveFirmId fallback.
    const Database = require('better-sqlite3');
    const dbDiscover = new Database(TMP_DB, { readonly: true });
    const firm = dbDiscover.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get();
    let wsRow = firm ? dbDiscover.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firm.id) : null;
    if (!wsRow) wsRow = dbDiscover.prepare('SELECT id, firm_id FROM workspaces ORDER BY id LIMIT 1').get();
    dbDiscover.close();
    if (!wsRow) throw new Error('no workspace in seeded DB to test against');
    const wsId = wsRow.id;
    // If the workspace is in a non-default firm, switch the session active firm
    // so requireWorkspace doesn't 403.
    if (wsRow.firm_id && firm && wsRow.firm_id !== firm.id) {
      await post(`/tenants/${wsRow.firm_id}/switch`, {});
    }
    console.log(`  (using workspace id=${wsId})`);

    console.log('\nworkspace pages');
    for (const [pathStr, name] of [
      [`/workspaces/${wsId}/controls/assess/clause-4.1`, 'wizard renders for clause-4.1'],
      [`/workspaces/${wsId}/controls/assess/annex-a.5.1`, 'wizard renders for annex-a.5.1'],
      [`/workspaces/${wsId}/controls/assess/summary`, 'post-assessment summary renders'],
      [`/workspaces/${wsId}/soa`, 'SoA renders'],
      [`/workspaces/${wsId}/risks`, 'risks list renders'],
      [`/workspaces/${wsId}/tasks`, 'tasks list renders'],
      [`/workspaces/${wsId}/readiness/blockers`, 'blockers page renders'],
      [`/workspaces/${wsId}/export/soa.csv`, 'SoA CSV exports']
    ]) {
      const r = await get(pathStr);
      ok(name, r.status === 200, `got ${r.status} for ${pathStr}`);
    }

    console.log('\nstarter risk library');
    const starterRisk = require(path.join(ROOT, 'data', 'risk-library'))[0];
    const starterBeforeDb = new Database(TMP_DB, { readonly: true });
    const starterBefore = starterBeforeDb.prepare('SELECT COUNT(*) c FROM risks WHERE workspace_id=?').get(wsId).c;
    starterBeforeDb.close();
    const addStarterRisk = await post(`/workspaces/${wsId}/risks/library`, { pick: '0' });
    ok('starter risk selection reaches its dedicated import route',
      addStarterRisk.status >= 300 && addStarterRisk.status < 400 && /^\/workspaces\/\d+\/risks\?toast=/.test(addStarterRisk.headers.location || ''),
      `got ${addStarterRisk.status} ${addStarterRisk.headers.location || ''}`);
    const starterAfterDb = new Database(TMP_DB, { readonly: true });
    const starterAfter = starterAfterDb.prepare('SELECT COUNT(*) c FROM risks WHERE workspace_id=?').get(wsId).c;
    const insertedStarter = starterAfterDb.prepare('SELECT id FROM risks WHERE workspace_id=? AND title=? ORDER BY id DESC LIMIT 1').get(wsId, starterRisk.title);
    const starterAudit = starterAfterDb.prepare("SELECT id FROM audit_log WHERE workspace_id=? AND action='add_risks_from_library' ORDER BY id DESC LIMIT 1").get(wsId);
    starterAfterDb.close();
    ok('selected starter risk is inserted into the register', starterAfter === starterBefore + 1 && !!insertedStarter,
      `before=${starterBefore}, after=${starterAfter}, title=${starterRisk.title}`);
    ok('starter risk import retains an audit record', !!starterAudit, 'add_risks_from_library audit entry missing');

    console.log('\nsupplier governed workflow');
    const createSupplier = await post(`/workspaces/${wsId}/vendors`, {
      name: 'Smoke Governed Supplier', service_provided: 'Critical transaction processing',
      service_category: 'Technology', contact: 'vendor@example.test', business_owner: 'Business Owner',
      relationship_owner: 'Relationship Owner', security_reviewer: 'Security Reviewer', privacy_owner: 'Privacy Owner'
    });
    ok('supplier intake redirects to inherent risk', createSupplier.status >= 300 && createSupplier.status < 400 && /\/inherent-risk/.test(createSupplier.headers.location || ''), `got ${createSupplier.status} ${createSupplier.headers.location || ''}`);
    const supplierMatch = String(createSupplier.headers.location || '').match(/\/vendors\/(\d+)\/inherent-risk/);
    const supplierId = supplierMatch && Number(supplierMatch[1]);
    ok('supplier id returned after intake', Number.isInteger(supplierId), `location=${createSupplier.headers.location || ''}`);
    const inherentPage = await get(`/workspaces/${wsId}/vendors/${supplierId}/inherent-risk`);
    ok('inherent-risk assessment renders', inherentPage.status === 200 && /25 owner inputs|Inherent-risk assessment/.test(inherentPage.body), `got ${inherentPage.status}`);
    const inherentAnswers = { action: 'submit', physical_data_centre_applicability: 'no' };
    for (let i = 1; i <= 25; i++) inherentAnswers[`score_Q${String(i).padStart(2, '0')}`] = 0;
    inherentAnswers.score_Q14 = 5;
    const submitInherent = await post(`/workspaces/${wsId}/vendors/${supplierId}/inherent-risk`, inherentAnswers);
    ok('complete inherent assessment submits', submitInherent.status >= 300 && submitInherent.status < 400, `got ${submitInherent.status}`);
    const approveInherent = await post(`/workspaces/${wsId}/vendors/${supplierId}/inherent-risk/approve`, { approval_rationale: 'Validated with the accountable service, technology and privacy owners.' });
    ok('mandatory floor tier is approved', approveInherent.status >= 300 && approveInherent.status < 400, `got ${approveInherent.status}`);
    const supplierRecord = await get(`/workspaces/${wsId}/vendors/${supplierId}`);
    ok('five-stage supplier decision record renders', supplierRecord.status === 200 && /Assessment path/.test(supplierRecord.body) && /Tier 1/.test(supplierRecord.body), `got ${supplierRecord.status}`);
    const startDdq = await post(`/workspaces/${wsId}/vendors/${supplierId}/due-diligence/start`, { vendor_contact_name: 'Vendor Owner', vendor_contact_email: 'vendor@example.test', due_date: '2027-03-31' });
    ok('tiered DDQ starts after inherent approval', startDdq.status >= 300 && startDdq.status < 400, `got ${startDdq.status}`);
    const ddqPage = await get(`/workspaces/${wsId}/vendors/${supplierId}/due-diligence`);
    ok('scoped DDQ reviewer page renders', ddqPage.status === 200 && /151 scoped questions|Questions/.test(ddqPage.body), `got ${ddqPage.status}`);
    const shareDdq = await post(`/workspaces/${wsId}/vendors/${supplierId}/due-diligence/share`, { vendor_contact_name: 'Vendor Owner', vendor_contact_email: 'vendor@example.test', due_date: '2027-03-31' });
    ok('secure vendor DDQ link is issued', shareDdq.status >= 300 && shareDdq.status < 400, `got ${shareDdq.status}`);
    const sharedDdqPage = await get(shareDdq.headers.location || `/workspaces/${wsId}/vendors/${supplierId}/due-diligence`);
    const tokenMatch = sharedDdqPage.body.match(/\/supplier-ddq\/([a-f0-9]{64})/);
    ok('raw vendor token is shown once to the issuer', !!tokenMatch, 'secure link not found in response');
    const externalDdq = tokenMatch ? await get(`/supplier-ddq/${tokenMatch[1]}`) : { status: 0, body: '' };
    ok('external vendor DDQ renders without an account', externalDdq.status === 200 && /Critical transaction processing|Supplier due diligence|Smoke Governed Supplier/.test(externalDdq.body), `got ${externalDdq.status}`);
    ok('external vendor DDQ does not ask for a manual evidence reference', !/Evidence reference for/.test(externalDdq.body), 'manual evidence reference field is present');
    ok('external vendor DDQ does not ask for evidence dates', !/Evidence date for/.test(externalDdq.body) && !/name="evidence_date_/.test(externalDdq.body), 'evidence date field is present');
    ok('external vendor DDQ does not ask for evidence owners', !/Evidence owner for/.test(externalDdq.body) && !/name="evidence_owner_/.test(externalDdq.body), 'evidence owner field is present');
    ok('response submission is separate from per-question evidence uploads',
      externalDdq.body.includes('id="ddq-response-form"') &&
      externalDdq.body.includes(`/supplier-ddq/${tokenMatch && tokenMatch[1]}/evidence/GOV-01`) &&
      !/<form id="ddq-response-form"[^>]*multipart\/form-data/.test(externalDdq.body),
      'single all-question multipart form is still present');
    const evidenceUpload = tokenMatch ? await postMultipart(
      `/supplier-ddq/${tokenMatch[1]}/evidence/GOV-01`, 'evidence', 'governance-policy.txt',
      'Approved information security policy, version 3, approved 2026-08-01.'
    ) : { status: 0, body: '' };
    let evidenceUploadPayload = {};
    try { evidenceUploadPayload = JSON.parse(evidenceUpload.body || '{}'); } catch (_) {}
    ok('vendor can upload inspected evidence for one question without submitting all answers',
      evidenceUpload.status === 200 && evidenceUploadPayload.ok === true && evidenceUploadPayload.files.includes('governance-policy.txt'),
      `got ${evidenceUpload.status} ${evidenceUpload.body}`);
    const partialVendorSubmit = tokenMatch ? await post(`/supplier-ddq/${tokenMatch[1]}`, {
      action: 'submit', response_GOV_01: 'Yes', detail_GOV_01: 'Approved policy is current.'
    }) : { status: 0, headers: {} };
    ok('vendor submission is blocked while scoped rows remain incomplete', partialVendorSubmit.status >= 300 && partialVendorSubmit.status < 400 && /blocked=/.test(partialVendorSubmit.headers.location || ''), `got ${partialVendorSubmit.status} ${partialVendorSubmit.headers.location || ''}`);
    const startContract = await post(`/workspaces/${wsId}/vendors/${supplierId}/contract-review/start`, { agreement_reference: 'MSA-SMOKE-001' });
    ok('contract review starts', startContract.status >= 300 && startContract.status < 400, `got ${startContract.status}`);
    const contractPage = await get(`/workspaces/${wsId}/vendors/${supplierId}/contract-review`);
    ok('47-clause contract review renders', contractPage.status === 200 && /47/.test(contractPage.body), `got ${contractPage.status}`);

    const supplierRisk = require(path.join(ROOT, 'lib', 'supplier-risk'));
    const supplierDb = new Database(TMP_DB);
    const ddqAssessment = supplierDb.prepare(`SELECT * FROM supplier_ddq_assessments WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(supplierId);
    const modules = JSON.parse(ddqAssessment.modules_json || '[]');
    const scopedQuestions = supplierRisk.questionsForAssessment(ddqAssessment.tier, Object.fromEntries(modules.map(module => [module.name, module.applicability])), 'Smoke Client');
    const seedEvidence = supplierDb.prepare(`INSERT INTO supplier_ddq_evidence
      (workspace_id,assessment_id,question_id,filename,stored_path,sha256,size_bytes,mime_type,source)
      VALUES (?,?,?,?,?,'0000000000000000000000000000000000000000000000000000000000000000',1,'text/plain','vendor')`);
    for (const question of scopedQuestions.filter(item => item.evidenceMandatory)) {
      const exists = supplierDb.prepare('SELECT 1 FROM supplier_ddq_evidence WHERE assessment_id=? AND question_id=? LIMIT 1').get(ddqAssessment.id, question.id);
      if (!exists) seedEvidence.run(ddqAssessment.workspace_id, ddqAssessment.id, question.id, `SMOKE-${question.id}.txt`, `SMOKE-${question.id}.txt`);
    }
    supplierDb.close();
    const completeVendorAnswers = { action: 'submit' };
    for (const question of scopedQuestions) {
      completeVendorAnswers[`response_${question.id}`] = 'Yes';
      completeVendorAnswers[`detail_${question.id}`] = 'Implemented for the service scope.';
    }
    const completeVendorSubmit = tokenMatch ? await post(`/supplier-ddq/${tokenMatch[1]}`, completeVendorAnswers) : { status: 0, body: '' };
    ok('vendor can submit only after every scoped response is complete', completeVendorSubmit.status === 200 && /Responses submitted/.test(completeVendorSubmit.body), `got ${completeVendorSubmit.status}`);
    const lockedVendorDdq = tokenMatch ? await get(`/supplier-ddq/${tokenMatch[1]}`) : { status: 0, body: '' };
    ok('submitted vendor questionnaire is locked against later edits', lockedVendorDdq.status === 200 && /Responses submitted/.test(lockedVendorDdq.body) && !/Save progress/.test(lockedVendorDdq.body), `got ${lockedVendorDdq.status}`);

    const reviewAnswers = { action: 'complete' };
    for (const question of scopedQuestions) {
      reviewAnswers[`reviewer_${question.id}`] = 'Satisfactory';
      reviewAnswers[`reviewer_comments_${question.id}`] = 'Evidence scope, currency and ownership verified.';
    }
    const completeDdq = await post(`/workspaces/${wsId}/vendors/${supplierId}/due-diligence/review`, reviewAnswers);
    ok('internal reviewer can conclude the evidence-backed DDQ', completeDdq.status >= 300 && completeDdq.status < 400, `got ${completeDdq.status}`);
    const completedDdqPage = await get(`/workspaces/${wsId}/vendors/${supplierId}/due-diligence`);
    ok('completed DDQ shows no review items', completedDdqPage.status === 200 && /complete/.test(completedDdqPage.body) && /Review items[\s\S]*?<div class="kpi-num">0<\/div>/.test(completedDdqPage.body), `got ${completedDdqPage.status}`);

    const contractDb = new Database(TMP_DB, { readonly: true });
    const contractReview = contractDb.prepare(`SELECT * FROM supplier_contract_reviews WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(supplierId);
    const contractItems = contractDb.prepare('SELECT * FROM supplier_contract_review_items WHERE review_id=?').all(contractReview.id);
    contractDb.close();
    const contractAnswers = { action: 'complete' };
    for (const item of contractItems) {
      contractAnswers[`required_${item.clause_id}`] = item.required ? '1' : '0';
      contractAnswers[`status_${item.clause_id}`] = item.required ? 'Present - Satisfactory' : 'Not Required';
      contractAnswers[`reference_${item.clause_id}`] = item.required ? `MSA-${item.clause_id}` : '';
      contractAnswers[`comments_${item.clause_id}`] = item.required ? 'Executed clause verified.' : 'Excluded by approved module scope.';
    }
    const completeContract = await post(`/workspaces/${wsId}/vendors/${supplierId}/contract-review`, contractAnswers);
    ok('contract review completes when all required clauses are concluded', completeContract.status >= 300 && completeContract.status < 400, `got ${completeContract.status}`);
    const readyRecord = await get(`/workspaces/${wsId}/vendors/${supplierId}`);
    ok('supplier becomes ready for a governed risk decision', readyRecord.status === 200 && /Ready for risk decision/.test(readyRecord.body), `got ${readyRecord.status}`);
    const decision = await post(`/workspaces/${wsId}/vendors/${supplierId}/decisions`, {
      decision: 'approved', residual_risk_band: 'moderate', valid_until: '2027-08-16',
      rationale: 'Inherent scope, vendor evidence, internal review and contract controls support approval.',
      residual_risk_rationale: 'A material dependency remains and is accepted subject to annual reassessment.'
    });
    ok('governed supplier decision records only after all gates pass', decision.status >= 300 && decision.status < 400, `got ${decision.status}`);

    console.log('\nbespoke question coverage');
    const { getQuestions } = require(path.join(ROOT, 'data', 'assessment-questions'));
    const db = new Database(TMP_DB, { readonly: true });
    const items = db.prepare('SELECT id, title, evidence_needed FROM iso_items').all();
    let mech = 0;
    for (const it of items) {
      const qs = getQuestions(it);
      if (!qs || qs.length === 0) mech++;
      for (const q of qs || []) if (/^Are you doing this:/.test(q)) mech++;
    }
    ok('all 118 items return bespoke questions (no mechanical fallthrough)', items.length === 118 && mech === 0, `${items.length} items, ${mech} mechanical`);

    console.log('\nwizard POST + history snapshot');
    const before = db.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId).c;
    db.close();
    const saveResp = await post(`/workspaces/${wsId}/controls/assess/clause-5.1`, {
      status: 'Partially Implemented',
      maturity: 2,
      scope_pct: 70,
      notes: 'smoke-test note',
      action: 'save',
      q_0: 'yes', q_1: 'partial', q_2: 'no'
    });
    ok('wizard POST returns 3xx redirect', saveResp.status >= 300 && saveResp.status < 400, `got ${saveResp.status}`);
    const dbCheck = new Database(TMP_DB, { readonly: true });
    const after = dbCheck.prepare(`SELECT COUNT(*) c FROM control_state_history WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId).c;
    ok('history snapshot was appended', after === before + 1, `before=${before}, after=${after}`);
    // control_states was demolished (migration 019); persistence is read from the
    // converged compat view over control_instances.
    const cur = dbCheck.prepare(`SELECT status, scope_pct, notes FROM v_control_states WHERE workspace_id=? AND iso_item_id='clause-5.1'`).get(wsId);
    ok('control state status persisted (converged)', cur && cur.status === 'Partially Implemented', JSON.stringify(cur));
    ok('control state scope_pct persisted (converged)', cur && cur.scope_pct === 70, JSON.stringify(cur));
    ok('control state notes persisted (converged)', cur && cur.notes === 'smoke-test note', JSON.stringify(cur));
    dbCheck.close();

    console.log('\ncontrol history page');
    const histResp = await get(`/workspaces/${wsId}/controls/clause-5.1/history`);
    ok('history page renders', histResp.status === 200, `got ${histResp.status}`);
    ok('history page lists the snapshot', histResp.body.includes('Partially Implemented'), 'snapshot row missing');
    ok('history page shows scope %', histResp.body.includes('70%'), 'scope % missing');

    console.log('\nbulk-spawn priority derivation');
    const spawnResp = await post(`/workspaces/${wsId}/controls/assess/summary/spawn-tasks`, {
      iso_id: ['clause-5.1'],
      due_date: ''
    });
    ok('spawn-tasks returns 3xx redirect', spawnResp.status >= 300 && spawnResp.status < 400, `got ${spawnResp.status}`);
    const dbTask = new Database(TMP_DB, { readonly: true });
    const tasks = dbTask.prepare(`SELECT priority, iso_item_id FROM tasks WHERE workspace_id=? AND iso_item_id='clause-5.1' ORDER BY id DESC LIMIT 1`).get(wsId);
    ok('task created with priority field', tasks && ['low','normal','high','critical'].includes(tasks.priority), JSON.stringify(tasks));
    dbTask.close();

    console.log('\nSoA shows risk linkage');
    const soaResp = await get(`/workspaces/${wsId}/soa`);
    ok('SoA includes "Risks treated" header', soaResp.body.includes('Risks treated'), 'header missing');

    // Firm-manager cross-engagement surfaces (portfolio + calendar). The seeded
    // user is a firm manager, so they clear the firm.cross_view gate. Markers
    // are structural (grid scaffolding), not data-dependent, so these pass on
    // any seed - they catch render/route regressions, not specific content.
    console.log('\nfirm manager surfaces');
    const portfolioResp = await get('/portfolio');
    ok('GET /portfolio returns 200', portfolioResp.status === 200, `got ${portfolioResp.status}`);
    ok('portfolio renders the health board', portfolioResp.body.includes('Portfolio health'), 'heading missing');

    const calYear = await get('/calendar');
    ok('GET /calendar (year overview) returns 200', calYear.status === 200, `got ${calYear.status}`);
    ok('year view renders the connected month grid', calYear.body.includes('mc-year'), 'mc-year grid missing');
    ok('year view renders the 3 month rows', calYear.body.includes('mc-yrow'), 'mc-yrow rows missing');

    const calMonth = await get('/calendar?month=2026-05');
    ok('GET /calendar?month= (month detail) returns 200', calMonth.status === 200, `got ${calMonth.status}`);
    ok('month view renders the weekday day-grid header', calMonth.body.includes('mc-cal-head'), 'mc-cal-head missing');

    const wsCal = await get(`/workspaces/${wsId}/calendar`);
    ok('GET /workspaces/:id/calendar returns 200', wsCal.status === 200, `got ${wsCal.status}`);

    // Glossary is a firm-level reference page. The run has already visited
    // workspace pages above, so last_ws_id is set - that is the exact condition
    // that used to make /glossary inherit a stale client sidebar ("lands in a
    // client page"). Assert it renders the firm sidebar (Glossary nav present +
    // active) and did NOT leak the client sidebar.
    const glossary = await get('/glossary');
    ok('GET /glossary returns 200', glossary.status === 200, `got ${glossary.status}`);
    ok('glossary renders the firm sidebar with Glossary active',
       glossary.body.includes('href="/glossary" class="nav-item active"'),
       'firm-level active Glossary nav item missing');
    ok('glossary did not inherit the client sidebar',
       !glossary.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /glossary');

    // Playbooks, Firm library, and Admin email are the other firm-level pages
    // that shared the glossary defect (they rendered with the sticky client
    // sidebar). Same guard: firm sidebar present + active, client sidebar absent.
    // last_ws_id is still set from the workspace visits above.
    const playbooks = await get('/playbooks');
    ok('GET /playbooks returns 200', playbooks.status === 200, `got ${playbooks.status}`);
    ok('playbooks renders the firm sidebar with Playbooks active',
       playbooks.body.includes('href="/playbooks" class="nav-item active"'),
       'firm-level active Playbooks nav item missing');
    ok('playbooks did not inherit the client sidebar',
       !playbooks.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /playbooks');

    const playbookDetail = await get('/playbooks/kickoff');
    ok('GET /playbooks/:id (detail) returns 200', playbookDetail.status === 200, `got ${playbookDetail.status}`);
    ok('playbook detail did not inherit the client sidebar',
       playbookDetail.body.includes('href="/playbooks" class="nav-item active"') &&
       !playbookDetail.body.includes('>Compliance calendar<'),
       'playbook detail did not render the firm sidebar');

    const firmLib = await get('/firm/library');
    ok('GET /firm/library returns 200', firmLib.status === 200, `got ${firmLib.status}`);
    ok('firm library renders the firm sidebar with Library active',
       firmLib.body.includes('href="/firm/library" class="nav-item active"'),
       'firm-level active Library nav item missing');
    ok('firm library did not inherit the client sidebar',
       !firmLib.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /firm/library');

    const firmLibRisks = await get('/firm/library/risks');
    ok('GET /firm/library/risks returns 200', firmLibRisks.status === 200, `got ${firmLibRisks.status}`);
    ok('firm library risks did not inherit the client sidebar',
       firmLibRisks.body.includes('href="/firm/library" class="nav-item active"') &&
       !firmLibRisks.body.includes('>Compliance calendar<'),
       'firm library risks did not render the firm sidebar');

    // /admin/email is gated by isFirmOwner(), which in this codebase resolves to
    // rbac.isManager() - a firm manager IS allowed in. The seeded smoke user is a
    // manager, so this page is reachable and renders the same firm-level chrome.
    const adminEmail = await get('/admin/email');
    ok('GET /admin/email returns 200 (managers allowed)', adminEmail.status === 200, `got ${adminEmail.status}`);
    ok('admin email renders the firm sidebar with Admin email active',
       adminEmail.body.includes('href="/admin/email" class="nav-item active"'),
       'firm-level active Admin email nav item missing');
    ok('admin email did not inherit the client sidebar',
       !adminEmail.body.includes('>Compliance calendar<'),
       'client sidebar leaked into /admin/email');

  } catch (e) {
    failures++;
    console.error(`\n✗ test crashed: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    stopServer();
    console.log(`\n${assertions} assertions, ${failures} failure${failures === 1 ? '' : 's'}`);
    process.exit(failures > 0 ? 1 : 0);
  }
})();
