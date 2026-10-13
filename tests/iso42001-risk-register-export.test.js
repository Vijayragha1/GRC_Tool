'use strict';
// The AI risk register an auditor or the client is handed (lib/aims-reports.js):
// a sealed risk assessment record with the criteria it was rated on, and how
// each risk is being treated and who accepted what is left, as Word and CSV.
// Without a record it is the live register, marked as not sealed. The audit
// pack, the ZIP and the auditor portal keep the ISMS's and the AIMS's risk
// registers apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');

let env, client, auditor, db, actor, aimsId, bothId, ismsId, systemId, driftId, oddId, recordId, bothRaw;
const ws = (id) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const base = (id) => `/workspaces/${id}/iso42001/risks`;
const reports = () => require('../lib/aims-reports');
const loadRecord = (id) => require('../lib/ai-risk').loadRecord(db, ws(aimsId), id, 'iso42001');
const addRisk = (wsId, system, fields) => {
  const cols = { workspace_id: wsId, management_system: system, likelihood: 3, impact: 3, status: 'open', ...fields };
  const keys = Object.keys(cols);
  return Number(db.prepare(`INSERT INTO risks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => cols[k])).lastInsertRowid);
};

// The files in a ZIP, read from its central directory.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const [method, size, nameLen, extraLen, commentLen, local] = [buf.readUInt16LE(p + 10), buf.readUInt32LE(p + 20),
      buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32), buf.readUInt32LE(p + 42)];
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  auditor = makeClient(env.app);
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  const add = (name, frameworks) => Number(db.prepare(`INSERT INTO workspaces (firm_id, client_name, frameworks, engagement_outcome) VALUES (?, ?, ?, 'certification_support')`)
    .run(actor.firm_id, name, frameworks).lastInsertRowid);
  aimsId = add('Kestrel Lending', '["iso42001"]');
  bothId = add('Harbour Analytics', '["iso27001","iso42001"]');
  ismsId = add('Harbour Freight', '["iso27001"]');
  systemId = Number(db.prepare(`INSERT INTO ai_systems (workspace_id, name, lifecycle_stage, in_scope, created_by) VALUES (?, 'Credit scoring model', 'in_use', 1, ?)`).run(aimsId, actor.id).lastInsertRowid);

  driftId = addRisk(aimsId, 'iso42001', { title: 'Scores drift against older applicants', description: 'Approval rates for applicants over 60 fall as the model ages',
    ai_system_id: systemId, risk_source: 'data', likelihood: 4, impact: 4, impact_organisation: 3, impact_individuals: 4, impact_society: 2,
    treatment: 'modify', owner_name: 'Head of Credit Risk', residual_likelihood: 2, residual_impact: 3 });
  db.prepare(`INSERT INTO iso42001_risk_controls (risk_id, iso_item_id) VALUES (?, 'ai-annex-a-6-2-4')`).run(driftId);
  db.prepare(`INSERT INTO risk_treatment_actions (workspace_id, risk_id, title, owner_name, due_date, status, created_by) VALUES (?, ?, 'Quarterly fairness test by age band', 'Model risk lead', '2026-12-31', 'in_progress', ?)`)
    .run(aimsId, driftId, actor.id);
  db.prepare(`INSERT INTO risk_acceptances (workspace_id, risk_id, accepter_name, accepter_role, rationale, signature, expires_at) VALUES (?, ?, 'Dana Okafor', 'Chief Risk Officer', 'Residual within appetite after quarterly testing', 'sig', '2027-10-01')`)
    .run(aimsId, driftId);
  oddId = addRisk(aimsId, 'iso42001', { title: '=HYPERLINK("http://example.test","click")', likelihood: 2, impact: 2, treatment: 'retain' });

  addRisk(bothId, 'iso27001', { title: 'Laptop theft exposes customer files', likelihood: 3, impact: 4, treatment: 'modify' });
  addRisk(bothId, 'iso42001', { title: 'Forecast model hallucinates figures', likelihood: 3, impact: 3, impact_organisation: 3, impact_individuals: 2, impact_society: 1, treatment: 'modify' });
  addRisk(ismsId, 'iso27001', { title: 'Ransomware on the depot server' });

  bothRaw = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(bothRaw).digest('hex');
  db.prepare(`INSERT INTO auditor_shares (workspace_id, token, token_hash, token_last4, label, expires_at, created_by) VALUES (?, ?, ?, ?, 'Stage 2 auditor', ?, ?)`)
    .run(bothId, `sha256:${hash}`, hash, bothRaw.slice(-4), new Date(Date.now() + 86400000).toISOString(), actor.id);
});
test.after(async () => { db?.close(); await client?.close(); await auditor?.close(); });

test('before any assessment is recorded, the register downloads as the live register, marked not sealed', async () => {
  const res = await client.get(`${base(aimsId)}/register.csv`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.match(res.headers['content-type'], /text\/csv/);
  const [header, ...rows] = res.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.match(header, /^Risk,Title,Description,AI system,Source,Owner,Likelihood,Impact on the organisation,Impact on individuals or groups,Impact on society,/);
  assert.doesNotMatch(header, /Asset|Threat|Vulnerability/, 'not the ISO 27001 register\'s columns');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith(`R-${driftId},Scores drift against older applicants,Approval rates for applicants over 60 fall as the model ages,Credit scoring model,`
    + '"Data: quality, bias, provenance or rights",Head of Credit Risk,4,3,4,2,4,16,high,Reduce it (modify),Open,2,3,medium,A.6.2.4 AI system verification and validation,'
    + 'Open,Quarterly fairness test by age band · Model risk lead · due 2026-12-31 · In progress,"Dana Okafor, Chief Risk Officer",'), rows[0]);
  assert.match(rows[0], /,Live register,\d{4}-\d{2}-\d{2},No$/);
  assert.match(rows[1], /,"'=HYPERLINK\(""http:\/\/example\.test"",""click""\)",/, 'a title a spreadsheet would run as a formula is defused');

  const word = reports().aiRiskRegister(db, ws(aimsId), null);
  assert.match(word.title, /\(live, not sealed\)$/);
  assert.match(word.body, /It has not been recorded as a performed risk assessment, so it is not sealed\./);
  assert.match(word.body, /Next assessment due<\/th><td>Now: no AI risk assessment has been recorded/);

  const page = await client.get(base(aimsId));
  assert.match(page.text, new RegExp(`href="${base(aimsId)}/register\\.docx"[^>]*>Download the register</a>`));
});

test('a recorded assessment downloads as sealed, with its criteria, treatment and sign-off', async () => {
  const done = await client.post(`${base(aimsId)}/assessments`, { performed_on: '2026-10-01', label: 'AI risk assessment Q4', notes: 'Credit risk and data science took part' });
  recordId = Number(done.location.match(/assessments\/(\d+)/)[1]);

  const res = await client.get(`${base(aimsId)}/assessments/${recordId}/register.docx`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.match(res.headers['content-type'], /officedocument\.wordprocessingml\.document/);
  assert.equal(res.buffer.subarray(0, 2).toString('ascii'), 'PK');
  // The Word file keeps its headings, labels and column headers (lib/docx-html.js).
  const xml = unzip(res.buffer)['word/document.xml'].replace(/<[^>]+>/g, '');
  for (const kept of ['AI Risk Register - 2026-10-01', 'This register', 'Basis', 'Seal (SHA-256)', 'Risk criteria', 'Risk levels',
    'AI risks as assessed (2)', 'Impact: org · people · society', 'Treatment and sign-off on', 'Residual risk accepted by']) {
    assert.ok(xml.includes(kept), `the Word file says "${kept}"`);
  }

  const word = reports().aiRiskRegister(db, ws(aimsId), loadRecord(recordId));
  assert.equal(word.title, 'AI Risk Register - 2026-10-01');
  assert.match(word.body, /The AI risk assessment performed on 2026-10-01, as sealed when it was recorded/);
  assert.match(word.body, /AI systems covered<\/th><td>Credit scoring model/);
  assert.match(word.body, /Seal \(SHA-256\)<\/th><td>Intact\. [0-9a-f]{64}/);
  assert.match(word.body, /Credit risk and data science took part/);
  assert.match(word.body, /<h3>Likelihood<\/h3>[\s\S]*<h3>Impact<\/h3>[\s\S]*<h3>Risk levels<\/h3>/, 'the criteria the risks are rated on');
  assert.match(word.body, /Approval rates for applicants over 60 fall as the model ages/, 'the description is sealed with the risk');
  assert.match(word.body, /<td>3 · 4 · 2<\/td>/);
  assert.match(word.body, /Reduce it \(modify\)/);
  assert.match(word.body, /A\.6\.2\.4 AI system verification and validation/);
  assert.match(word.body, /Treatment and sign-off on \d{4}-\d{2}-\d{2}<\/h2><p>From the live register on the day this document was produced, not from the sealed record\.<\/p>/);
  assert.match(word.body, /Quarterly fairness test by age band<\/strong><br><span class="meta">Model risk lead · due 2026-12-31 · In progress/);
  assert.match(word.body, /Dana Okafor, Chief Risk Officer<br><span class="meta">on \d{4}-\d{2}-\d{2}, until 2027-10-01/);
  assert.match(word.body, /Next assessment due<\/th><td>2027-10-01/, 'the latest record says when the next is due');

  const csv = await client.get(`${base(aimsId)}/assessments/${recordId}/register.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /"Dana Okafor, Chief Risk Officer",\d{4}-\d{2}-\d{2},2027-10-01,AI risk assessment Q4,2026-10-01,Yes\r\n/);
  assert.match(csv.text, /,AI risk assessment Q4,2026-10-01,Yes\r\n/);

  const page = await client.get(base(aimsId));
  assert.match(page.text, new RegExp(`href="${base(aimsId)}/assessments/${recordId}/register\\.docx"[^>]*>Download the register</a>`), 'the head offers the latest record');
  assert.match(page.text, new RegExp(`assessments/${recordId}/register\\.csv">CSV</a>`));
  assert.match(page.text, /When an auditor or the client asks for the risk register, hand them the latest/);
  const recordPage = await client.get(`${base(aimsId)}/assessments/${recordId}`);
  assert.match(recordPage.text, new RegExp(`assessments/${recordId}/register\\.docx">Word</a>`));
});

test('what changed after the record is said, not hidden', () => {
  addRisk(aimsId, 'iso42001', { title: 'Vendor retires the scoring API', created_at: new Date(Date.now() + 60000).toISOString().replace('T', ' ').slice(0, 19) });
  const m = require('../db').defaultMethodology();
  db.prepare(`INSERT INTO risk_methodologies (workspace_id, management_system, name, likelihood_scale, impact_scale, matrix, thresholds, is_active)
    VALUES (?, 'iso42001', 'Kestrel AI criteria', ?, ?, ?, ?, 1)`).run(aimsId, ...[m.likelihood_scale, m.impact_scale, m.matrix, m.thresholds].map((v) => JSON.stringify(v)));
  db.prepare('DELETE FROM risks WHERE id=?').run(oddId);

  const word = reports().aiRiskRegister(db, ws(aimsId), loadRecord(recordId));
  assert.match(word.body, /One AI risk was added to the register after this assessment and is not in it: R-\d+ Vendor retires the scoring API\./);
  assert.match(word.body, /This assessment was rated on the criteria named &quot;Default 5x5&quot;\. The criteria below are the ones in use today, &quot;Kestrel AI criteria&quot;\./);
  assert.match(word.body, /Removed from the register/, 'a risk deleted since is still in the sealed record, and says so');

  assert.throws(() => db.prepare(`UPDATE risk_assessment_records SET payload='[]' WHERE id=?`).run(recordId), /cannot be changed/);
  // A record edited outside the tool no longer matches its seal.
  const tampered = { ...loadRecord(recordId), intact: false };
  assert.match(reports().aiRiskRegister(db, ws(aimsId), tampered).body, /Does not match: the record changed after it was sealed/);
  assert.match(reports().aiRiskRegisterCsv(db, ws(aimsId), tampered), /,Seal broken\r\n/);
});

test('the register is the AIMS\'s alone: other systems\' records and clients without ISO 42001 get nothing', async () => {
  const ismsRecord = Number(db.prepare(`INSERT INTO risk_assessment_records (workspace_id, scope, label, performed_on, risk_count, above_appetite, payload, payload_hash, recorded_by)
    VALUES (?, 'all', 'ISMS risk assessment', '2026-09-01', 0, 0, '[]', 'x', ?)`).run(bothId, actor.id).lastInsertRowid);
  assert.equal((await client.get(`${base(bothId)}/assessments/${ismsRecord}/register.docx`)).status, 404, 'the ISMS\'s record is not the AI register');
  assert.equal((await client.get(`${base(bothId)}/assessments/${ismsRecord}`)).status, 404);
  assert.equal((await client.get(`${base(bothId)}/assessments/${recordId}/register.csv`)).status, 404, 'another client\'s record');
  assert.notEqual((await client.get(`${base(ismsId)}/register.docx`)).status, 200);

  const live = reports().aiRiskRegisterCsv(db, ws(bothId), null);
  assert.match(live, /Forecast model hallucinates figures/);
  assert.doesNotMatch(live, /Laptop theft/);
});

test('the audit pack, the ZIP and the auditor portal keep the two registers apart', async () => {
  const zip = unzip((await client.get(`/workspaces/${bothId}/audit-pack/zip`)).buffer);
  assert.match(zip['02_Risk_Register.csv'], /Laptop theft/);
  assert.doesNotMatch(zip['02_Risk_Register.csv'], /Forecast model/);
  assert.match(zip['02_AI_Risk_Register.csv'], /Forecast model hallucinates figures/);
  assert.doesNotMatch(zip['02_AI_Risk_Register.csv'], /Laptop theft/);
  assert.match(zip['00_MANIFEST.txt'], /02_AI_Risk_Register\.csv \(1 AI risks, live register; no AI risk assessment has been recorded\)/);

  const shared = (await client.get(`/workspaces/${bothId}/export/risks.csv`)).text;
  assert.match(shared, /Laptop theft/);
  assert.doesNotMatch(shared, /Forecast model/, 'the shared register\'s CSV is the ISMS\'s on a client with both');

  const aimsZip = unzip((await client.get(`/workspaces/${aimsId}/audit-pack/zip`)).buffer);
  assert.equal(aimsZip['02_Risk_Register.csv'], undefined, 'no ISO 27001-shaped register for an ISO 42001-only client');
  assert.match(aimsZip['00_MANIFEST.txt'], /02_AI_Risk_Register\.csv \(\d+ AI risks, from the risk assessment performed 2026-10-01, sealed\)/);

  const preview = (await client.get(`/workspaces/${bothId}/audit-pack/preview`)).text;
  const isms = preview.slice(preview.indexOf('Risk register · ISO/IEC 27001'), preview.indexOf('AI risk register · ISO/IEC 42001'));
  const ai = preview.slice(preview.indexOf('AI risk register · ISO/IEC 42001'));
  assert.match(isms, /Laptop theft/);
  assert.doesNotMatch(isms, /Forecast model/);
  assert.match(ai, /No AI risk assessment has been recorded\. This is the live register/);
  assert.match(ai, /Forecast model hallucinates figures/);
  assert.doesNotMatch(ai.slice(0, ai.indexOf('Evidence index')), /Laptop theft/);
  const numbers = [...preview.matchAll(/<div class="section-eyebrow">Section (\d+)<\/div>/g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), 'sections are still numbered in order');

  const ismsView = (await auditor.get(`/auditor/${bothRaw}/risks`)).text;
  assert.match(ismsView, /Risk register · ISO\/IEC 27001/);
  assert.match(ismsView, /Laptop theft/);
  assert.doesNotMatch(ismsView, /Forecast model/);
  assert.match(ismsView, new RegExp(`href="/auditor/${bothRaw}/risks\\?system=iso42001">ISO 42001 AI risk register</a>`));
  const aiView = (await auditor.get(`/auditor/${bothRaw}/risks?system=iso42001`)).text;
  assert.match(aiView, /AI risk register · ISO\/IEC 42001/);
  assert.match(aiView, /Forecast model hallucinates figures/);
  assert.doesNotMatch(aiView, /Laptop theft/);
  assert.match(aiView, /Impact: org · people · society/);
  assert.match(aiView, /No AI risk assessment has been recorded yet\./);
});
