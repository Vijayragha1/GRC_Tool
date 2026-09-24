'use strict';
// ISO/IEC 42001 certification audit: the certification body's request list,
// the client hand-off, the AI system register and impact assessments.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { bootClient, makeClient } = require('./helpers');
const { readSheet } = require('../lib/xlsx-reader');
// Loaded after boot: the helper re-requires the app with the test key file,
// and these must share its encryption module to read what it wrote.
let audit, registry;

const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const us = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y.slice(2)}`; };
const STAGE1 = addDays(TODAY, 60);
const STAGE2 = addDays(TODAY, 120);

// A minimal .xlsx: stored (uncompressed and deflated) zip parts with shared
// strings, an inline string, a gap in the row and a second sheet.
function zip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const deflate = name.endsWith('.xml') && name.includes('sheet');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(crc(raw), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc(raw), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += head.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

function workbook(rows) {
  const strings = [];
  const idx = s => { const i = strings.indexOf(s); if (i >= 0) return i; strings.push(s); return strings.length - 1; };
  const col = n => String.fromCharCode(65 + n);
  const sheet = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v == null ? '' : r === 1 && c === 1
    ? `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`
    : `<c r="${col(c)}${r + 1}" t="s"><v>${idx(String(v))}</v></c>`)).join('')}</row>`).join('');
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Comments" sheetId="2" r:id="rId2"/><sheet name="IRL" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${strings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Ref ID</t></is></c></row></sheetData></worksheet>',
  });
}

const HEADER = ['Req ID', 'Class', 'Category', 'Type', 'Description', 'Service', 'Requirement', 'Location', 'Due', 'Status', 'Example CB Guidance'];
function listRows(overrides = {}) {
  const rows = [
    ['P-1', 'General', 'Population', 'Population', 'Provide a population of newly implemented AI systems', 'ISO 42001', '', 'Main', us(STAGE2), 'Open', ''],
    ['P-2', 'General', 'Population', 'Population', 'Provide a listing of vendors involved in the AI system lifecycle', 'ISO 42001', '', 'Main', us(STAGE2), 'Open', ''],
    ['R-10', 'Management', 'Compliance', 'General', 'Provide AI management system scope document with version and approval date (S1)', 'ISO 42001', 'ISO 42001 Clause 4.3', 'Main', us(STAGE1), 'Open', 'Scope document with version and approval date'],
    ['R-11', 'Management', 'Compliance', 'Policy', 'Provide AI Policy with version and approval date (S1)', 'ISO 42001', 'ISO 42001 Clause 5.2', 'Main', us(STAGE1), 'Open', ''],
    ['R-12', 'Risk', 'Risk Management', 'General', 'Provide a Statement of applicability with version and approval date (S1)', 'ISO 42001', 'ISO 42001 Clause 6.1.3.d', 'Main', us(STAGE1), 'Open', ''],
    ['R-13', 'Management', 'Compliance', 'General', 'Provide internal audit program and internal audit plan (S1)', 'ISO 42001', 'ISO 42001 Clause 9.2.2, ISO 42001 Annex A.2.2', 'Main', us(STAGE1), 'Open', ''],
    ['R-20', 'Risk', 'Risk Management', 'General', 'Documentation of AI system impact assessments', 'ISO 42001', 'ISO 42001 Annex A.5.3, ISO 42001 Annex A.5.4', 'Main', us(STAGE2), 'Open', ''],
    ['R-21', 'Other', 'Prefieldwork', 'General', 'Request for remote audit', 'ISO 42001', 'Prefieldwork', 'Main', us(STAGE2), 'Open', ''],
    ['R-30', 'Training', 'Training Program', 'Sample', 'AI Awareness and Competency Training for a sample of new hires', 'ISO 42001', 'ISO 42001 Clause 7.2', 'Main', '', 'Potential Sample', ''],
  ];
  return rows.map(r => (overrides[r[0]] ? overrides[r[0]](r.slice()) : r)).filter(Boolean);
}
const csvOf = rows => [HEADER, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');

function multipart(fields, file) {
  const boundary = `----a42${Math.random().toString(16).slice(2)}`;
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n${file.body}\r\n--${boundary}--\r\n`);
  return { body: parts.join(''), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let env, db, client, wsId, ws, actor, clientUser, base;

async function loginAs(email, password) {
  const c = makeClient(env.app);
  const page = await c.get('/login');
  const token = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await c.post('/login', { email, password, _csrf: token }, { csrf: false });
  assert.equal(res.status, 302, `login for ${email} failed`);
  await c.get('/dashboard');
  return c;
}

const version = id => db.prepare('SELECT version FROM aims_audit_requests WHERE id=?').get(id).version;
const byRef = ref => db.prepare('SELECT * FROM aims_audit_requests WHERE workspace_id=? AND ref=?').get(wsId, ref);

async function importCsv(csv, confirm = {}) {
  const form = multipart({ _csrf: client.getCsrfToken() }, { name: 'IRL.csv', type: 'text/csv', body: csv });
  const preview = await client.post(`${base}/requests/import/preview`, form.body, { csrf: false, headers: form.headers });
  assert.equal(preview.status, 302, preview.text.slice(0, 300));
  const importId = Number((preview.location.match(/preview=(\d+)/) || [])[1]);
  assert.ok(importId, `preview should redirect to the preview page, got ${preview.location}`);
  const page = await client.get(preview.location);
  assert.equal(page.status, 200);
  const committed = await client.post(`${base}/requests/import/${importId}/commit`,
    { certification_body: 'Example CB', stage1_date: STAGE1, stage2_date: STAGE2, ...confirm });
  assert.equal(committed.status, 302);
  return { importId, page, committed };
}

test.before(async () => {
  env = await bootClient();
  audit = require('../lib/iso42001-audit');
  registry = require('../lib/ai-systems');
  client = env.client;
  db = new Database(env.dbPath);
  actor = db.prepare("SELECT id, firm_id FROM users WHERE email='sec-test@example.com'").get();
  wsId = Number(db.prepare('INSERT INTO workspaces (firm_id, client_name, frameworks) VALUES (?, ?, ?)')
    .run(actor.firm_id, 'Aurora Diagnostics', '["iso42001"]').lastInsertRowid);
  ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  base = `/workspaces/${wsId}/iso42001`;
  const hash = bcrypt.hashSync('client-pass-1234', 4);
  clientUser = Number(db.prepare(`INSERT INTO users (email, password_hash, name, user_type, active) VALUES (?, ?, 'Ines Moreau', 'client', 1)`)
    .run('ines@aurora.example', hash).lastInsertRowid);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'client_owner')").run(wsId, clientUser);
});
test.after(async () => { db?.close(); await client?.close(); });

test('the xlsx reader finds the request sheet and reads shared, inline and sparse cells', () => {
  const rows = [HEADER, ['R-1', 'Inline value', null, 'General', 'Describe & <record> it', '', 'ISO 42001 Clause 4.1', '', '11/13/26', 'Open', 'Tip']];
  const book = readSheet(workbook(rows), 'IRL');
  assert.deepEqual(book.sheets, ['Comments', 'IRL']);
  assert.equal(book.rows[1][0], 'R-1');
  assert.equal(book.rows[1][1], 'Inline value');
  assert.equal(book.rows[1][2], '', 'a missing cell reads as empty, not as the next value');
  assert.equal(book.rows[1][4], 'Describe & <record> it');
  assert.throws(() => readSheet(Buffer.from('not a zip')), /zip/i);

  const parsed = audit.parseRequestList(workbook([HEADER, ...listRows()]), 'IRL.xlsx', require('../data/iso42001-catalog').map(i => i.id));
  assert.equal(parsed.sheet, 'IRL', 'the sheet with the request columns is chosen, not the first sheet');
  assert.equal(parsed.requests.length, 9);
});

test('parsing maps sub-clauses to the catalogue, finds both audit dates and sorts request types', () => {
  const ids = require('../data/iso42001-catalog').map(i => i.id);
  const { ids: resolved, unresolved } = audit.resolveRequirementRefs('ISO 42001 Clause 6.1.3.d, Clause 9.2.1, 7.5.3, ISO 42001 Annex A.6.2.3, Prefieldwork', ids);
  assert.deepEqual(resolved, ['ai-clause-6.1.3', 'ai-clause-9.2', 'ai-clause-7.5', 'ai-annex-a-6-2-3']);
  assert.deepEqual(unresolved, ['Prefieldwork']);
  assert.deepEqual(audit.parseDueDate('11/13/26'), { date: '2026-11-13' });
  assert.equal(audit.parseDueDate('13/11/26').date, null, 'a day-first date is reported, not guessed');

  const parsed = audit.parseRequestList(Buffer.from(csvOf(listRows())), 'IRL.csv', ids);
  assert.deepEqual(parsed.schedule, { stage1: STAGE1, stage2: STAGE2 });
  const kinds = Object.fromEntries(parsed.requests.map(r => [r.ref, r.kind]));
  assert.equal(kinds['P-1'], 'population');
  assert.equal(kinds['R-11'], 'policy');
  assert.equal(kinds['R-30'], 'sample');
  const stages = Object.fromEntries(parsed.requests.map(r => [r.ref, audit.stageFor(r, parsed.schedule)]));
  assert.equal(stages['R-10'], 'stage1');
  assert.equal(stages['R-20'], 'stage2');
  assert.equal(stages['R-30'], 'fieldwork');
  const dup = audit.parseRequestList(Buffer.from(csvOf([...listRows(), listRows()[2]])), 'IRL.csv', ids);
  assert.match(dup.warnings.join(' '), /R-10 appears more than once/);
});

test('a 42001 workspace opens on the programme overview, which leads with the gap assessment until a list arrives', async () => {
  const home = await client.get(`/workspaces/${wsId}`);
  assert.equal(home.location, `${base}/overview`);
  const overview = await client.get(`${base}/overview`);
  assert.equal(overview.status, 200);
  assert.match(overview.text, /Start the gap assessment/);
  assert.match(overview.text, /Start the certification checklist/, 'the checklist can be started during the gap assessment');
  for (const label of ['Programme overview', 'Gap assessment', 'Certification requests', 'AI system register', 'Requirements', 'Statement of Applicability'])
    assert.match(overview.text, new RegExp(`>${label}<`), `${label} is in the ISO 42001 navigation`);

  const other = Number(db.prepare('INSERT INTO workspaces (firm_id, client_name, frameworks) VALUES (?, ?, ?)').run(actor.firm_id, 'No AI client', '["iso27001"]').lastInsertRowid);
  assert.equal((await client.get(`/workspaces/${other}/iso42001/overview`)).status, 404, 'the programme is not reachable where it is not enabled');
});

test('importing the list previews first, then creates stage-sorted requests with clause mappings', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM aims_audit_requests WHERE workspace_id=?').get(wsId).c;
  const { page } = await importCsv(csvOf(listRows()));
  assert.equal(before, 0);
  assert.match(page.text, /Check the import/);
  assert.match(page.text, /Import 9 requests/);
  assert.match(page.text, /R-21 \(Prefieldwork\)/, 'a request with no clause is named in the preview');

  const rows = db.prepare('SELECT ref, stage, kind, due_date, status FROM aims_audit_requests WHERE workspace_id=? ORDER BY sort_order').all(wsId);
  assert.equal(rows.length, 9);
  assert.equal(byRef('R-10').stage, 'stage1');
  assert.equal(byRef('R-30').stage, 'fieldwork');
  assert.ok(rows.every(r => r.status === 'not_started'));
  const mapped = db.prepare('SELECT item_id FROM aims_request_requirements WHERE request_id=? ORDER BY item_id').all(byRef('R-13').id).map(r => r.item_id);
  assert.deepEqual(mapped, ['ai-annex-a-2-2', 'ai-clause-9.2']);
  const prog = audit.programme(db, ws);
  assert.equal(prog.stage1_date, STAGE1);
  assert.equal(prog.certification_body, 'Example CB');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM aims_request_events WHERE workspace_id=? AND event_type='imported'").get(wsId).c, 9);

  const list = await client.get(`${base}/requests?stage=stage1`);
  assert.equal(list.status, 200);
  assert.match(list.text, /Stage 1 <span class="meta">4<\/span>/);
  assert.match(list.text, /R-10/);
  assert.doesNotMatch(list.text, /R-20/, 'the Stage 1 tab lists only Stage 1 requests');
  const overview = await client.get(`${base}/overview`);
  assert.match(overview.text, /4 Stage 1 requests have not been started/);
  assert.match(overview.text, /Not on the auditor's list/);
});

test('sending to the client creates portal requests the client can see, and the client cannot enter the programme', async () => {
  const r10 = byRef('R-10');
  const r11 = byRef('R-11');
  const sent = await client.post(`${base}/requests/send`, { request_ids: [r10.id, r11.id, byRef('R-30').id], assignee_id: clientUser, note: 'Signed PDFs please.' });
  assert.equal(sent.status, 302);
  assert.match(decodeURIComponent(sent.location), /3 sent to Ines Moreau$/);
  const again = await client.post(`${base}/requests/send`, { request_ids: [r10.id], assignee_id: clientUser });
  assert.match(decodeURIComponent(again.location), /0 sent to Ines Moreau; 1 skipped \(R-10 is with client\)/, 'a request already with the client is not sent twice');
  const req10 = byRef('R-10');
  assert.equal(req10.status, 'with_client');
  const cr = db.prepare('SELECT * FROM client_requests WHERE id=?').get(req10.client_request_id);
  assert.equal(cr.assignee_id, clientUser);
  assert.equal(cr.due_date, addDays(STAGE1, -7), 'the client is asked a week before the auditor needs it');
  assert.match(cr.title, /^R-10 · /);
  assert.match(cr.request_reason, /Example CB will ask for this when it reviews the AI management system documents at Stage 1/);
  assert.match(cr.request_reason, /Their reference is R-10/);
  assert.match(cr.request_reason, /clause 4\.3/);
  assert.equal(cr.acceptable_examples, 'Scope document with version and approval date');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title LIKE '%new requests%'").get(clientUser).c, 1, 'one notification for the batch');

  const ines = await loginAs('ines@aurora.example', 'client-pass-1234');
  try {
    const portal = await ines.get(`/workspaces/${wsId}/client-portal?view=actions`);
    assert.equal(portal.status, 200);
    assert.match(portal.text, /R-10 · Provide AI management system scope document/);
    const detail = await ines.get(`/workspaces/${wsId}/client-portal/requests/${cr.id}`);
    assert.match(detail.text, /Example CB will ask for this/);
    for (const path of ['overview', 'requests', `requests/${req10.id}`, 'ai-systems']) {
      assert.equal((await ines.get(`${base}/${path}`)).status, 403, `a client account cannot open ${path}`);
    }
  } finally { await ines.close(); }
});

test('a client response is reviewed here: returned with a reason, then accepted into the requirement evidence', async () => {
  const req10 = byRef('R-10');
  const evidenceId = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, size_bytes, uploaded_by)
    VALUES (?, 'AIMS scope v1.pdf', 'x', 'scope-v1', 100, ?)`).run(wsId, clientUser).lastInsertRowid);
  db.prepare('INSERT INTO client_request_evidence (request_id, evidence_id, linked_by) VALUES (?, ?, ?)').run(req10.client_request_id, evidenceId, clientUser);
  db.prepare("UPDATE client_requests SET status='submitted', version=version+1 WHERE id=?").run(req10.client_request_id);

  let detail = audit.requestDetail(db, ws, req10.id, TODAY);
  assert.equal(detail.request.effective, 'to_review');
  const page = await client.get(`${base}/requests/${req10.id}`);
  assert.match(page.text, /Ines Moreau responded/);
  assert.match(page.text, /Accept and mark ready/);

  const noReason = await client.post(`${base}/requests/${req10.id}/transition`, { action: 'return_to_client', version: version(req10.id), note: '' });
  assert.match(decodeURIComponent(noReason.location), /Tell the client what is missing/);
  const returned = await client.post(`${base}/requests/${req10.id}/transition`, { action: 'return_to_client', version: version(req10.id), note: 'The approval date is missing.' });
  assert.equal(returned.status, 302);
  assert.equal(db.prepare('SELECT status FROM client_requests WHERE id=?').get(req10.client_request_id).status, 'changes_requested');
  assert.equal(audit.loadRequest(db, ws, req10.id, TODAY).effective, 'with_client');

  db.prepare("UPDATE client_requests SET status='submitted', version=version+1 WHERE id=?").run(req10.client_request_id);
  const stale = await client.post(`${base}/requests/${req10.id}/transition`, { action: 'mark_ready', version: version(req10.id) - 1 });
  assert.match(decodeURIComponent(stale.location), /changed in another session/);
  const accepted = await client.post(`${base}/requests/${req10.id}/transition`, { action: 'mark_ready', version: version(req10.id) });
  assert.equal(accepted.status, 302);
  assert.equal(byRef('R-10').status, 'ready');
  const crow = db.prepare('SELECT status, evidence_quality FROM client_requests WHERE id=?').get(req10.client_request_id);
  assert.deepEqual({ ...crow }, { status: 'accepted', evidence_quality: 'sufficient' });

  // The accepted file now counts for clause 4.3, and the requirement page shows it.
  const linked = db.prepare(`SELECT COUNT(*) c FROM evidence_requirement_links erl JOIN requirements rq ON rq.id=erl.requirement_id
    WHERE erl.evidence_id=? AND rq.ref='ai-clause-4.3'`).get(evidenceId).c;
  assert.equal(linked, 1);
  const requirement = await client.get(`${base}/gap/ai-clause-4.3`);
  assert.match(requirement.text, /AIMS scope v1\.pdf/, 'evidence linked through the requirement link table appears on the requirement');
  assert.match(requirement.text, /Requested by the certification body \(1\)/);
  assert.match(requirement.text, /name="iso42001_item_ref" value="ai-clause-4.3"/, 'the upload form links ISO 42001 evidence to the requirement');
  const register = await client.get(`${base}/controls`);
  assert.match(register.text, /1 of 1 settled/);
});

test('readiness needs something attached; submission and auditor follow-up are recorded with notes', async () => {
  const r12 = byRef('R-12');
  const empty = await client.post(`${base}/requests/${r12.id}/transition`, { action: 'mark_ready', version: version(r12.id) });
  assert.match(decodeURIComponent(empty.location), /Attach at least one file/);
  const ev = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, size_bytes, uploaded_by)
    VALUES (?, 'SoA v1.1.xlsx', 'y', 'soa-v11', 100, ?)`).run(wsId, actor.id).lastInsertRowid);
  assert.equal((await client.post(`${base}/requests/${r12.id}/records`, { record_type: 'evidence', record_id: ev })).status, 302);
  await client.post(`${base}/requests/${r12.id}/transition`, { action: 'mark_ready', version: version(r12.id) });
  assert.equal(byRef('R-12').status, 'ready');
  const removeWhileReady = await client.post(`${base}/requests/${r12.id}/records/${db.prepare('SELECT id FROM aims_request_records WHERE request_id=?').get(r12.id).id}/delete`, {});
  assert.match(decodeURIComponent(removeWhileReady.location), /Reopen the request/);

  const future = await client.post(`${base}/requests/${r12.id}/transition`, { action: 'record_submission', version: version(r12.id), submitted_on: addDays(TODAY, 3) });
  assert.match(decodeURIComponent(future.location), /cannot be in the future/);
  await client.post(`${base}/requests/${r12.id}/transition`, { action: 'record_submission', version: version(r12.id), submitted_on: TODAY });
  assert.equal(byRef('R-12').status, 'submitted');
  const locked = await client.post(`${base}/requests/${r12.id}/records`, { record_type: 'evidence', record_id: ev });
  assert.match(decodeURIComponent(locked.location), /gone to the auditor/);

  const silent = await client.post(`${base}/requests/${r12.id}/transition`, { action: 'auditor_follow_up', version: version(r12.id), note: '' });
  assert.match(decodeURIComponent(silent.location), /Record what the auditor asked for/);
  await client.post(`${base}/requests/${r12.id}/transition`, { action: 'auditor_follow_up', version: version(r12.id), note: 'Show the approval signature.' });
  assert.equal(byRef('R-12').status, 'follow_up');
  const overview = await client.get(`${base}/overview`);
  assert.match(overview.text, /The auditor has come back on 1 request/);

  const r21 = byRef('R-21');
  const bare = await client.post(`${base}/requests/${r21.id}/transition`, { action: 'mark_not_applicable', version: version(r21.id), note: '' });
  assert.match(decodeURIComponent(bare.location), /Record why this request does not apply/);
  await client.post(`${base}/requests/${r21.id}/transition`, { action: 'mark_not_applicable', version: version(r21.id), note: 'Fieldwork is on site.' });
  assert.equal(byRef('R-21').status, 'not_applicable');

  const history = db.prepare('SELECT event_type, to_status FROM aims_request_events WHERE request_id=? ORDER BY id').all(r12.id).map(e => e.to_status || e.event_type);
  assert.deepEqual(history, ['not_started', 'record_linked', 'ready', 'submitted', 'follow_up']);
  assert.throws(() => db.prepare('UPDATE aims_request_events SET note=NULL WHERE request_id=?').run(r12.id), /immutable/);
});

test('a sample is ready only when every selected item is evidenced or has a recorded exception', async () => {
  const r30 = byRef('R-30');
  await client.post(`${base}/requests/${r30.id}/samples`, { labels: 'EMP-1 Ana\nEMP-2 Ben\nEMP-1 Ana' });
  const samples = db.prepare('SELECT * FROM aims_request_samples WHERE request_id=? ORDER BY id').all(r30.id);
  assert.equal(samples.length, 2, 'duplicate selections are recorded once');
  const blocked = await client.post(`${base}/requests/${r30.id}/transition`, { action: 'mark_ready', version: version(r30.id) });
  assert.match(decodeURIComponent(blocked.location), /Every selected item needs evidence/);
  const ev = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, size_bytes, uploaded_by)
    VALUES (?, 'Ana training.pdf', 'z', 'ana', 10, ?)`).run(wsId, actor.id).lastInsertRowid);
  await client.post(`${base}/requests/${r30.id}/samples/${samples[0].id}`, { status: 'evidenced', evidence_id: ev });
  const noNote = await client.post(`${base}/requests/${r30.id}/samples/${samples[1].id}`, { status: 'exception', note: '' });
  assert.match(decodeURIComponent(noNote.location), /Describe the exception/);
  await client.post(`${base}/requests/${r30.id}/samples/${samples[1].id}`, { status: 'exception', note: 'Joined after the audit period.' });
  await client.post(`${base}/requests/${r30.id}/transition`, { action: 'mark_ready', version: version(r30.id) });
  assert.equal(byRef('R-30').status, 'ready');
});

test('a newer list updates what the auditor owns, keeps consultant work, and withdraws dropped requests', async () => {
  const manual = await client.post(`${base}/requests/new`, { ref: 'EMAIL-1', description: 'Send the model card for the triage model.', stage: 'stage2', kind: 'evidence', requirements: 'A.6.2.7' });
  assert.equal(manual.status, 302);
  const bad = await client.post(`${base}/requests/new`, { ref: 'EMAIL-2', description: 'x', requirements: 'Clause 99' });
  assert.match(decodeURIComponent(bad.location), /Not recognised as ISO 42001 references/);

  const newDue = addDays(STAGE1, 7);
  const csv = csvOf(listRows({
    'R-10': r => { r[4] = 'Provide the approved AIMS scope document (S1)'; return r; },
    'R-11': r => { r[8] = us(newDue); return r; },
    'R-21': () => null,
  }));
  await importCsv(csv);
  const r10 = byRef('R-10');
  assert.equal(r10.description, 'Provide the approved AIMS scope document (S1)');
  assert.equal(r10.status, 'ready', 'an import never touches the consultant status');
  assert.ok(r10.client_request_id, 'or the client hand-off');
  assert.equal(byRef('R-11').due_date, newDue);
  assert.ok(byRef('R-21').withdrawn_at, 'a request missing from the newer list is withdrawn, not deleted');
  assert.equal(byRef('EMAIL-1').withdrawn_at, null, 'a request added by hand is never withdrawn by an import');
  const changed = db.prepare("SELECT metadata FROM aims_request_events WHERE request_id=? AND event_type='updated_by_cb'").get(byRef('R-11').id);
  assert.match(changed.metadata, /due_date/);

  await importCsv(csvOf(listRows()));
  assert.equal(byRef('R-21').withdrawn_at, null, 'a request back on the list is restored');
  assert.equal(byRef('R-21').status, 'not_applicable', 'with its conclusion intact');
});

test('the AI system register feeds the populations, and an impact assessment needs a second person to approve', async () => {
  const excluded = await client.post(`${base}/ai-systems`, { name: 'Shadow tool', in_scope: '0' });
  assert.match(decodeURIComponent(excluded.location), /why this system is outside the AIMS scope/);
  const created = await client.post(`${base}/ai-systems`, { name: 'Sepsis early warning', purpose: 'Flags patients at risk of sepsis.', org_roles: ['provider', 'producer'],
    lifecycle_stage: 'in_use', go_live_date: addDays(TODAY, -30), automation_level: 'human_in_loop' });
  assert.equal(created.status, 302);
  const systemId = Number(created.location.match(/ai-systems\/(\d+)/)[1]);
  await client.post(`${base}/ai-systems/${systemId}/suppliers`, { supplier_name: 'Northwind Cloud', lifecycle_role: 'Hosting and compute', service: '=HYPERLINK("x")' });
  const changeId = Number(db.prepare(`INSERT INTO changes (workspace_id, title, status, implemented_at, created_by) VALUES (?, 'Retrain on Q3 data', 'implemented', ?, ?)`).run(wsId, TODAY, actor.id).lastInsertRowid);
  await client.post(`${base}/ai-systems/${systemId}/links`, { link_type: 'change', target_id: changeId });

  audit.updateProgramme(db, ws, actor.id, { certification_body: 'Example CB', stage1_date: STAGE1, stage2_date: STAGE2, review_period_start: addDays(TODAY, -365), review_period_end: TODAY });
  const vendors = await client.get(`${base}/populations/ai-vendors.csv`);
  assert.equal(vendors.status, 200);
  assert.match(vendors.text, /Northwind Cloud,Sepsis early warning,Hosting and compute,"?'=HYPERLINK/, 'spreadsheet formulas are neutralised');
  const systemsCsv = await client.get(`${base}/populations/ai-systems.csv`);
  assert.match(systemsCsv.text, /Review period/);
  assert.match(systemsCsv.text, /Sepsis early warning/);

  const p2 = byRef('P-2');
  const attach = await client.post(`${base}/requests/${p2.id}/population`, {});
  assert.match(decodeURIComponent(attach.location), /Population attached \(1 rows?\)/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM aims_request_records WHERE request_id=? AND record_type='evidence'").get(p2.id).c, 1);

  // The manager prepares the assessment through the page, so the manager cannot approve it.
  const started = await client.post(`${base}/ai-systems/${systemId}/impact-assessments`, {});
  const iaId = Number(started.location.match(/impact-assessments\/(\d+)/)[1]);
  const fields = { affected_parties: 'Inpatients', potential_harms: 'Missed sepsis; alert fatigue', mitigations: 'Clinician review of every alert', residual_level: 'medium', decision: 'proceed' };
  await client.post(`${base}/ai-systems/${systemId}/impact-assessments/${iaId}`, { ...fields, version: 1 });
  const ia = () => db.prepare('SELECT * FROM ai_impact_assessments WHERE id=?').get(iaId);
  const selfApprove = await client.post(`${base}/ai-systems/${systemId}/impact-assessments/${iaId}/approve`, { version: ia().version });
  assert.match(decodeURIComponent(selfApprove.location), /cannot approve it/);
  const consultant = Number(db.prepare(`INSERT INTO users (email, password_hash, name, firm_id, user_type, firm_role, active) VALUES ('rui@firm.example', '!noauth', 'Rui', ?, 'firm', 'consultant', 1)`).run(actor.firm_id).lastInsertRowid);
  db.prepare('UPDATE ai_impact_assessments SET prepared_by=? WHERE id=?').run(consultant, iaId);
  const approved = await client.post(`${base}/ai-systems/${systemId}/impact-assessments/${iaId}/approve`, { version: ia().version });
  assert.equal(approved.status, 302);
  assert.equal(ia().status, 'approved');
  assert.equal(ia().snapshot_hash, registry.contentHash(ia()));
  assert.throws(() => db.prepare("UPDATE ai_impact_assessments SET potential_harms='edited later' WHERE id=?").run(iaId), /frozen/);
  const view = await client.get(`${base}/ai-systems/${systemId}/impact-assessments/${iaId}`);
  assert.match(view.text, /matches the stored text/);

  const re = await client.post(`${base}/ai-systems/${systemId}/impact-assessments`, {});
  const v2 = db.prepare('SELECT * FROM ai_impact_assessments WHERE id=?').get(Number(re.location.match(/impact-assessments\/(\d+)/)[1]));
  assert.equal(v2.version_no, 2);
  assert.equal(v2.potential_harms, fields.potential_harms, 'a reassessment starts from the approved position');
  assert.throws(() => registry.approveAssessment(db, ws, actor.id, systemId, v2.id, { version: v2.version }), /cannot approve it/);
  assert.equal(v2.decision, null, 'a reassessment records its own decision');
  registry.saveAssessment(db, ws, consultant, systemId, v2.id, { ...fields, trigger_reason: 'Retrained model', version: v2.version });
  registry.approveAssessment(db, ws, actor.id, systemId, v2.id, { version: v2.version + 1 });
  assert.equal(ia().status, 'superseded');
});

test('records, links and requests never cross a workspace boundary', async () => {
  const otherWs = Number(db.prepare('INSERT INTO workspaces (firm_id, client_name, frameworks) VALUES (?, ?, ?)').run(actor.firm_id, 'Other AI client', '["iso42001"]').lastInsertRowid);
  const foreignEvidence = Number(db.prepare(`INSERT INTO evidence (workspace_id, filename, stored_path, sha256, size_bytes, uploaded_by)
    VALUES (?, 'foreign.pdf', 'f', 'foreign', 1, ?)`).run(otherWs, actor.id).lastInsertRowid);
  const r20 = byRef('R-20');
  const linked = await client.post(`${base}/requests/${r20.id}/records`, { record_type: 'evidence', record_id: foreignEvidence });
  assert.match(decodeURIComponent(linked.location), /not in this client workspace/);
  assert.throws(() => db.prepare(`INSERT INTO aims_request_records (request_id, workspace_id, record_type, record_id, linked_by) VALUES (?, ?, 'evidence', ?, ?)`)
    .run(r20.id, wsId, foreignEvidence, actor.id), /crosses workspace boundary/);
  assert.equal((await client.get(`/workspaces/${otherWs}/iso42001/requests/${r20.id}`)).status, 404, 'a request id from another client is not found');
  const foreignChange = Number(db.prepare(`INSERT INTO changes (workspace_id, title, created_by) VALUES (?, 'Foreign change', ?)`).run(otherWs, actor.id).lastInsertRowid);
  const systemId = db.prepare('SELECT id FROM ai_systems WHERE workspace_id=? LIMIT 1').get(wsId).id;
  const cross = await client.post(`${base}/ai-systems/${systemId}/links`, { link_type: 'change', target_id: foreignChange });
  assert.match(decodeURIComponent(cross.location), /not in this client workspace/);
});

test('the request list exports for the status call with the certification body', async () => {
  const csv = await client.get(`${base}/requests/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /^Request,Stage,Type,Requirements,Due,Status/);
  assert.match(csv.text, /R-12,Stage 1,Evidence,6\.1\.3,[\d-]+,Auditor follow-up/);
  assert.match(csv.text, /R-10,Stage 1,Evidence,4\.3,[\d-]+,Ready to submit,Ines Moreau/);
});
