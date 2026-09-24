'use strict';
// ISO/IEC 42001 certification audit: the certification body's information
// request list, tracked request by request from import to the auditor's
// acceptance.
//
// The list is the acceptance test the engagement works towards. Everything
// the consultant does in this programme (gap assessment, SoA, policies,
// impact assessments) ends up as an answer to one of these requests, so the
// programme is organised around them rather than around internal worksheets.
//
// Ownership rule: the certification body owns what a request asks for
// (description, guidance, due date, clause mapping) and a newer list replaces
// those fields. The consulting team owns how it is answered (status, owner,
// the client hand-off, linked records) and an import never touches them.
//
// Functions take `today` (YYYY-MM-DD) where the answer depends on the date, so
// tests and exports do not read the clock implicitly.

const crypto = require('crypto');
const path = require('path');
const enc = require('./encryption');
const { openWorkbook } = require('./xlsx-reader');
const { parseCSV } = require('./csv-import');
const { VERSION: CHECKLIST_VERSION, CHECKLIST } = require('../data/iso42001-audit-checklist');

const MAX_REQUESTS = 2000;
const MAX_DESCRIPTION = 8000;
const MAX_GUIDANCE = 20000;
const MAX_NOTE = 8000;
const MAX_SAMPLES = 250;

const KIND_LABELS = Object.freeze({
  evidence: 'Evidence', policy: 'Policy or procedure', population: 'Population', sample: 'Sample',
});
const STAGE_LABELS = Object.freeze({ stage1: 'Stage 1', stage2: 'Stage 2', fieldwork: 'Samples' });
const STAGE_HINTS = Object.freeze({
  stage1: 'Documents the auditor reviews at Stage 1',
  stage2: 'Evidence that the AIMS operates, checked at Stage 2',
  fieldwork: 'Items the auditor selects during Stage 2 fieldwork',
});

// Stored statuses plus the two derived ones: `to_review` (the client has
// responded through the portal) and `withdrawn` (dropped from a later list).
const STATUS_LABELS = Object.freeze({
  not_started: 'Not started',
  with_client: 'With client',
  to_review: 'Client responded',
  ready: 'Ready to submit',
  submitted: 'Submitted',
  accepted: 'Accepted by auditor',
  follow_up: 'Auditor follow-up',
  not_applicable: 'Not applicable',
  withdrawn: 'Withdrawn by auditor',
});
// Maps onto the house quiet-text status classes in app.css.
const STATUS_CLASS = Object.freeze({
  not_started: 's-todo', with_client: 's-in_progress', to_review: 's-in_review', ready: 's-done',
  submitted: 's-in_progress', accepted: 's-closed', follow_up: 's-open', not_applicable: 's-na', withdrawn: 's-na',
});
// A request is finished from the consultant's side once it reaches the
// auditor, is accepted, or is concluded not applicable.
const SETTLED = new Set(['submitted', 'accepted', 'not_applicable', 'withdrawn']);
const DONE_FOR_STAGE = new Set(['ready', 'submitted', 'accepted', 'not_applicable', 'withdrawn']);

const CLIENT_OPEN = new Set(['open', 'in_progress', 'changes_requested']);

class AuditError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ------------------------------------------------------------------ helpers

function clean(value, max) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  if (text.length > max) throw new AuditError(`Keep this to ${max.toLocaleString()} characters or fewer.`);
  return text || null;
}

function validDate(value, label = 'date') {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new AuditError(`Enter a valid ${label}.`);
  }
  return text;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requirementCode(itemId) {
  const id = String(itemId || '');
  if (id.startsWith('ai-annex-')) return id.replace('ai-annex-', '').toUpperCase().replace(/-/g, '.');
  if (id.startsWith('ai-clause-')) return id.replace('ai-clause-', '');
  return id;
}

function requirementSort(itemId) {
  const code = requirementCode(itemId);
  const annex = code.startsWith('A.');
  const parts = code.replace(/^A\./, '').split('.').map(n => String(Number(n) || 0).padStart(3, '0'));
  return `${annex ? 1 : 0}.${parts.join('.')}`;
}

function event(db, ws, actorId, requestId, type, fields = {}) {
  const note = fields.note == null ? null
    : enc.encryptIfNeeded(String(fields.note).slice(0, MAX_NOTE), ws.id, !!ws.encryption_enabled);
  db.prepare(`INSERT INTO aims_request_events
    (request_id, workspace_id, actor_id, event_type, from_status, to_status, note, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(requestId, ws.id, actorId, type,
    fields.from || null, fields.to || null, note, fields.metadata ? JSON.stringify(fields.metadata) : null);
}

function catalogIds(db) {
  return db.prepare('SELECT id FROM iso42001_items ORDER BY sort_order').all().map(r => r.id);
}

// ------------------------------------------------------------------ parsing

const HEADER_ALIASES = Object.freeze({
  ref: ['req id', 'request id', 'request ref', 'id', 'ref', 'reference', 'irl id'],
  cls: ['class'],
  category: ['category', 'domain', 'area'],
  type: ['type', 'request type'],
  description: ['description', 'request', 'request description', 'evidence requested'],
  requirement: ['requirement', 'requirements', 'clause', 'control', 'controls', 'criteria', 'mapping', 'standard reference'],
  due: ['due', 'due date', 'deadline'],
  status: ['status'],
  guidance: ['guidance', 'auditor guidance', 'cb guidance'],
  advice: ['consultant advice'],
});

function headerMap(header) {
  const norm = header.map(h => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    let idx = norm.findIndex(h => aliases.includes(h));
    // Certification bodies often brand the guidance column with their own name.
    if (idx < 0 && key === 'guidance') idx = norm.findIndex(h => /\bguidance$/.test(h) && !h.startsWith('consultant'));
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

// "ISO 42001 Clause 6.1.3.d" -> ai-clause-6.1.3, "Clause 9.2.1" -> ai-clause-9.2,
// "ISO 42001 Annex A.6.2.3" -> ai-annex-a-6-2-3. The numbering is walked up
// until it reaches an item the catalogue holds, so a sub-clause the catalogue
// folds into its parent still lands on a real requirement.
function resolveRequirementRefs(text, ids) {
  const known = ids instanceof Set ? ids : new Set(ids);
  const resolved = [];
  const unresolved = [];
  for (const part of String(text || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)) {
    const annex = part.match(/\bA\s*\.?\s*(\d+(?:\.\d+)*)/i);
    const clause = !annex && part.match(/\b(?:clause|cl\.?|§)\s*(\d+(?:\.\d+)*)/i);
    const bare = !annex && !clause && part.match(/^(\d+(?:\.\d+)+)/);
    let id = null;
    if (annex) {
      const segs = annex[1].split('.');
      while (segs.length && !id) { const c = `ai-annex-a-${segs.join('-')}`; if (known.has(c)) id = c; else segs.pop(); }
    } else if (clause || bare) {
      const segs = (clause || bare)[1].split('.').filter(Boolean);
      while (segs.length && !id) { const c = `ai-clause-${segs.join('.')}`; if (known.has(c)) id = c; else segs.pop(); }
    }
    if (id) { if (!resolved.includes(id)) resolved.push(id); } else unresolved.push(part);
  }
  return { ids: resolved, unresolved };
}

// Certification-body exports use US month/day/year. ISO dates and Excel serial
// numbers are accepted too; anything else is reported, not guessed.
function parseDueDate(value) {
  const s = String(value || '').trim();
  if (!s) return { date: null };
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((Number(s) - 25569) * 86400000));
    return Number.isNaN(d.getTime()) ? { date: null, invalid: s } : { date: d.toISOString().slice(0, 10) };
  }
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const iso = `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || Number(m[1]) > 12 ? { date: null, invalid: s } : { date: iso };
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}` };
  return { date: null, invalid: s };
}

function kindOf(type, ref) {
  const t = String(type || '').toLowerCase();
  if (t.includes('population') || /^P-\d/i.test(ref)) return 'population';
  if (t.includes('sample')) return 'sample';
  if (t.includes('policy') || t.includes('procedure')) return 'policy';
  return 'evidence';
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const map = headerMap(rows[i] || []);
    if (map.ref != null && map.description != null) return { index: i, map };
  }
  return null;
}

function rowsFromUpload(buffer, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.xlsx') {
    const book = openWorkbook(buffer);
    for (const sheet of book.sheets) {
      const rows = book.rows(sheet);
      if (findHeaderRow(rows)) return { sheet, rows };
    }
    throw new AuditError('No sheet in this workbook has a request ID column and a description column.');
  }
  if (ext === '.csv') {
    const text = buffer.toString('utf8');
    const parsed = parseCSV(text);
    const rows = [parsed.headers, ...parsed.rows.map(r => (Array.isArray(r) ? r : parsed.headers.map(h => r[h])))];
    return { sheet: null, rows };
  }
  throw new AuditError('Upload the request list as an .xlsx workbook or a .csv file.');
}

// Returns normalised requests plus everything the preview needs to explain
// what will happen: unresolved references, bad dates and the Stage 1 / Stage 2
// dates the list implies.
function parseRequestList(buffer, filename, ids) {
  const { sheet, rows } = rowsFromUpload(buffer, filename);
  const header = findHeaderRow(rows);
  if (!header) throw new AuditError('The file needs a request ID column and a description column.');
  const col = header.map;
  const known = new Set(ids);
  const requests = [];
  const warnings = [];
  const seen = new Set();
  rows.slice(header.index + 1).forEach((row, i) => {
    const get = key => (col[key] == null ? '' : String(row[col[key]] ?? '').trim());
    const ref = get('ref').slice(0, 40);
    if (!ref) return;
    if (seen.has(ref)) { warnings.push(`${ref} appears more than once; only the first row is used.`); return; }
    seen.add(ref);
    const description = get('description');
    if (!description) { warnings.push(`${ref} has no description and was skipped.`); return; }
    const due = parseDueDate(get('due'));
    if (due.invalid) warnings.push(`${ref} has a due date that could not be read ("${due.invalid.slice(0, 20)}").`);
    const requirementText = get('requirement');
    const refs = resolveRequirementRefs(requirementText, known);
    requests.push({
      ref,
      kind: kindOf(get('type'), ref),
      description: description.slice(0, MAX_DESCRIPTION),
      guidance: get('guidance').slice(0, MAX_GUIDANCE) || null,
      cb_advice: get('advice').slice(0, MAX_GUIDANCE) || null,
      cb_class: get('cls').slice(0, 120) || null,
      cb_category: get('category').slice(0, 120) || null,
      cb_type: get('type').slice(0, 60) || null,
      cb_status: get('status').slice(0, 60) || null,
      requirement_text: requirementText.slice(0, 1000) || null,
      requirement_ids: refs.ids,
      unresolved_refs: refs.unresolved,
      stage1_flag: /\((?:S1|Stage 1)\)/i.test(description),
      due_date: due.date,
      sort_order: requests.length,
    });
    if (requests.length > MAX_REQUESTS) throw new AuditError(`A request list is limited to ${MAX_REQUESTS} requests.`);
  });
  if (!requests.length) throw new AuditError('No requests were found under the header row.');
  return { sheet, requests, warnings, schedule: inferSchedule(requests) };
}

// Stage 1 is the date the "(S1)" requests share, or the earlier of two due
// dates. Stage 2 is the latest due date on the list.
function inferSchedule(requests) {
  const dates = [...new Set(requests.map(r => r.due_date).filter(Boolean))].sort();
  const s1 = requests.filter(r => r.stage1_flag && r.due_date).map(r => r.due_date).sort();
  const stage1 = s1.length ? s1[0] : (dates.length > 1 ? dates[0] : null);
  const stage2 = dates.length ? dates[dates.length - 1] : null;
  return { stage1, stage2: stage2 && stage2 !== stage1 ? stage2 : (stage1 ? null : stage2) };
}

function stageFor(request, schedule) {
  if (request.kind === 'sample') return 'fieldwork';
  if (request.stage1_flag) return 'stage1';
  if (schedule.stage1 && request.due_date && request.due_date <= schedule.stage1) return 'stage1';
  return 'stage2';
}

const CB_FIELDS = ['kind', 'description', 'guidance', 'cb_advice', 'cb_class', 'cb_category', 'cb_type', 'cb_status', 'requirement_text', 'due_date'];

function mappingFor(db, requestId) {
  return db.prepare('SELECT item_id FROM aims_request_requirements WHERE request_id=? ORDER BY item_id').all(requestId).map(r => r.item_id);
}

function diffAgainstExisting(db, ws, requests, schedule) {
  const existing = new Map(db.prepare('SELECT * FROM aims_audit_requests WHERE workspace_id=?').all(ws.id).map(r => [r.ref, r]));
  const out = { added: [], changed: [], unchanged: 0, restored: [], withdrawn: [] };
  const seen = new Set();
  for (const r of requests) {
    seen.add(r.ref);
    const prev = existing.get(r.ref);
    if (!prev) { out.added.push(r.ref); continue; }
    const fields = CB_FIELDS.filter(f => (prev[f] ?? null) !== (r[f] ?? null));
    if (prev.stage !== stageFor(r, schedule)) fields.push('stage');
    if (mappingFor(db, prev.id).join(',') !== [...r.requirement_ids].sort().join(',')) fields.push('requirements');
    if (prev.withdrawn_at) out.restored.push(r.ref);
    if (fields.length) out.changed.push({ ref: r.ref, fields });
    else if (!prev.withdrawn_at) out.unchanged++;
  }
  for (const [ref, prev] of existing) {
    if (!seen.has(ref) && !prev.withdrawn_at && prev.source === 'import') out.withdrawn.push(ref);
  }
  return out;
}

function summarise(requests, schedule) {
  // Grouped the way the request list tabs group them: populations apart from
  // the Stage 2 documents they are due with.
  const byStage = { stage1: 0, stage2: 0, population: 0, fieldwork: 0 };
  const byKind = { evidence: 0, policy: 0, population: 0, sample: 0 };
  for (const r of requests) { byStage[r.kind === 'population' ? 'population' : stageFor(r, schedule)]++; byKind[r.kind]++; }
  return {
    total: requests.length, byStage, byKind,
    unmapped: requests.filter(r => !r.requirement_ids.length && r.kind !== 'population').map(r => ({ ref: r.ref, text: r.requirement_text })),
    unresolved: requests.filter(r => r.unresolved_refs.length).map(r => ({ ref: r.ref, refs: r.unresolved_refs })),
    guessedBody: null,
  };
}

// A branded guidance column ("<Body> Guidance") names the certification body.
function guessCertificationBody(buffer, filename) {
  try {
    const { rows } = rowsFromUpload(buffer, filename);
    const header = findHeaderRow(rows);
    const cell = header && rows[header.index][header.map.guidance];
    const m = String(cell || '').match(/^(.+?)\s+guidance$/i);
    if (m && !/^(auditor|cb|certification body)$/i.test(m[1])) return m[1].slice(0, 80);
  } catch (_) {}
  return null;
}

function previewImport(db, ws, actorId, file) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw new AuditError('Choose the request list to upload.');
  const parsed = parseRequestList(file.buffer, file.originalname, catalogIds(db));
  const diff = diffAgainstExisting(db, ws, parsed.requests, parsed.schedule);
  const summary = {
    ...summarise(parsed.requests, parsed.schedule),
    guessedBody: guessCertificationBody(file.buffer, file.originalname),
    schedule: parsed.schedule, warnings: parsed.warnings, diff,
  };
  // An older preview for the same workspace is superseded by this one.
  db.prepare("UPDATE aims_request_imports SET status='discarded' WHERE workspace_id=? AND status='preview'").run(ws.id);
  const id = Number(db.prepare(`INSERT INTO aims_request_imports
    (workspace_id, status, source_filename, source_sha256, sheet_name, payload_json, summary_json, created_by)
    VALUES (?, 'preview', ?, ?, ?, ?, ?, ?)`).run(ws.id, String(file.originalname).slice(0, 200), sha256(file.buffer),
    parsed.sheet, JSON.stringify({ requests: parsed.requests, schedule: parsed.schedule }), JSON.stringify(summary), actorId).lastInsertRowid);
  return id;
}

function loadImport(db, ws, importId) {
  const row = db.prepare('SELECT * FROM aims_request_imports WHERE id=? AND workspace_id=?').get(Number(importId), ws.id);
  if (!row) return null;
  return { ...row, summary: JSON.parse(row.summary_json) };
}

// Applies a set of requests from one source (the standard checklist or an
// imported list) to a client's programme. The source owns wording, guidance,
// mapping and any due date; the consulting team owns everything else, which
// is never touched. A request of this source that is no longer in the set is
// withdrawn, not deleted. Requests from other sources are left alone.
function mergeRequests(db, ws, actorId, requests, { source, importId = null, eventMeta = {} }) {
  const ids = new Set(catalogIds(db));
  const result = { added: 0, updated: 0, withdrawn: 0, restored: 0, conflicts: [] };
  const existing = new Map(db.prepare('SELECT * FROM aims_audit_requests WHERE workspace_id=?').all(ws.id).map(r => [r.ref, r]));
  const insert = db.prepare(`INSERT INTO aims_audit_requests
    (workspace_id, ref, source, kind, stage, description, guidance, cb_advice, cb_class, cb_category, cb_type, cb_status,
     requirement_text, due_date, sort_order, first_import_id, last_import_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE aims_audit_requests SET kind=?, stage=?, description=?, guidance=?, cb_advice=?,
    cb_class=?, cb_category=?, cb_type=?, cb_status=?, requirement_text=?, due_date=?, sort_order=?, withdrawn_at=NULL,
    last_import_id=COALESCE(?, last_import_id), updated_at=datetime('now'), version=version+1 WHERE id=?`);
  const clearMap = db.prepare('DELETE FROM aims_request_requirements WHERE request_id=?');
  const addMap = db.prepare('INSERT OR IGNORE INTO aims_request_requirements (request_id, workspace_id, item_id) VALUES (?, ?, ?)');
  const seen = new Set();
  for (const r of requests) {
    const prev = existing.get(r.ref);
    if (prev && prev.source !== source) { result.conflicts.push(r.ref); continue; }
    seen.add(r.ref);
    const mapped = r.requirement_ids.filter(id => ids.has(id));
    const v = { ...r, due_date: r.due_date || null, guidance: r.guidance || null, cb_advice: r.cb_advice || null, cb_class: r.cb_class || null,
      cb_category: r.cb_category || null, cb_type: r.cb_type || null, cb_status: r.cb_status || null, requirement_text: r.requirement_text || null };
    let id;
    if (!prev) {
      id = Number(insert.run(ws.id, v.ref, source, v.kind, v.stage, v.description, v.guidance, v.cb_advice, v.cb_class, v.cb_category,
        v.cb_type, v.cb_status, v.requirement_text, v.due_date, v.sort_order, importId, importId).lastInsertRowid);
      event(db, ws, actorId, id, 'imported', { to: 'not_started', metadata: { ...eventMeta, source, stage: v.stage, due_date: v.due_date } });
      result.added++;
    } else {
      id = prev.id;
      const fields = CB_FIELDS.filter(f => (prev[f] ?? null) !== (v[f] ?? null));
      if (prev.stage !== v.stage) fields.push('stage');
      if (mappingFor(db, id).join(',') !== [...mapped].sort().join(',')) fields.push('requirements');
      if (!fields.length && !prev.withdrawn_at) continue;
      update.run(v.kind, v.stage, v.description, v.guidance, v.cb_advice, v.cb_class, v.cb_category, v.cb_type, v.cb_status,
        v.requirement_text, v.due_date, v.sort_order, importId, id);
      if (prev.withdrawn_at) { event(db, ws, actorId, id, 'restored_by_cb', { metadata: { ...eventMeta, source } }); result.restored++; }
      if (fields.length) {
        event(db, ws, actorId, id, 'updated_by_cb', { metadata: { ...eventMeta, source, fields, previous_due_date: prev.due_date } });
        result.updated++;
      }
    }
    clearMap.run(id);
    for (const item of mapped) addMap.run(id, ws.id, item);
  }
  for (const [ref, prev] of existing) {
    if (seen.has(ref) || prev.withdrawn_at || prev.source !== source) continue;
    db.prepare(`UPDATE aims_audit_requests SET withdrawn_at=datetime('now'), last_import_id=COALESCE(?, last_import_id), updated_at=datetime('now'),
      version=version+1 WHERE id=?`).run(importId, prev.id);
    event(db, ws, actorId, prev.id, 'withdrawn_by_cb', { metadata: { ...eventMeta, source } });
    result.withdrawn++;
  }
  return result;
}

function commitImport(db, ws, actorId, importId, input = {}) {
  const row = db.prepare('SELECT * FROM aims_request_imports WHERE id=? AND workspace_id=?').get(Number(importId), ws.id);
  if (!row) throw new AuditError('That import preview was not found.', 404);
  if (row.status !== 'preview') throw new AuditError('This preview has already been used or replaced. Upload the list again.', 409);
  const payload = JSON.parse(row.payload_json);
  // Audit dates are optional. They only decide which of an imported list's
  // due dates fall in Stage 1, and are saved for the client only when the
  // consultant enters them.
  const entered = {
    stage1: validDate(input.stage1_date, 'Stage 1 date') || null,
    stage2: validDate(input.stage2_date, 'Stage 2 date') || null,
  };
  if (entered.stage1 && entered.stage2 && entered.stage1 >= entered.stage2) throw new AuditError('Stage 1 must come before Stage 2.');
  const schedule = entered.stage1 || entered.stage2 ? entered : payload.schedule;
  const body = clean(input.certification_body, 120);
  let result;
  db.transaction(() => {
    const requests = payload.requests.map(r => ({ ...r, stage: stageFor(r, schedule) }));
    result = mergeRequests(db, ws, actorId, requests, { source: 'import', importId: row.id, eventMeta: { import_id: row.id } });
    db.prepare(`INSERT INTO aims_audit_programmes (workspace_id, certification_body, stage1_date, stage2_date, current_import_id, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET certification_body=COALESCE(excluded.certification_body, certification_body),
        stage1_date=COALESCE(excluded.stage1_date, stage1_date), stage2_date=COALESCE(excluded.stage2_date, stage2_date),
        current_import_id=excluded.current_import_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(ws.id, body, entered.stage1, entered.stage2, row.id, actorId);
    db.prepare("UPDATE aims_request_imports SET status='committed', committed_by=?, committed_at=datetime('now') WHERE id=?").run(actorId, row.id);
  })();
  return result;
}

// ------------------------------------------------------------------ standard checklist

function standardRequests() {
  return CHECKLIST.map((e, i) => ({
    ref: e.key, kind: e.kind, stage: e.stage, description: e.title, guidance: e.checks,
    requirement_ids: e.refs, requirement_text: null, due_date: null, sort_order: i,
  }));
}

// Starts a client's certification checklist, or brings it up to the latest
// version of the standard checklist. Safe to repeat: unchanged requests are
// untouched and consultant work is never reset.
function applyStandardChecklist(db, ws, actorId) {
  let result;
  db.transaction(() => {
    result = mergeRequests(db, ws, actorId, standardRequests(), { source: 'standard', eventMeta: { checklist_version: CHECKLIST_VERSION } });
    db.prepare(`INSERT INTO aims_audit_programmes (workspace_id, checklist_version, updated_by, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET checklist_version=excluded.checklist_version, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(ws.id, CHECKLIST_VERSION, actorId);
  })();
  return { ...result, version: CHECKLIST_VERSION };
}

function checklistStatus(db, ws) {
  const prog = db.prepare('SELECT checklist_version FROM aims_audit_programmes WHERE workspace_id=?').get(ws.id) || {};
  const applied = !!db.prepare("SELECT 1 FROM aims_audit_requests WHERE workspace_id=? AND source='standard' LIMIT 1").get(ws.id);
  return {
    applied, version: prog.checklist_version || null, latest: CHECKLIST_VERSION, size: CHECKLIST.length,
    updateAvailable: applied && prog.checklist_version !== CHECKLIST_VERSION,
  };
}

function discardImport(db, ws, importId) {
  db.prepare("UPDATE aims_request_imports SET status='discarded' WHERE id=? AND workspace_id=? AND status='preview'").run(Number(importId), ws.id);
}

// ------------------------------------------------------------------ programme

function programme(db, ws) {
  const row = db.prepare(`SELECT p.*, i.source_filename, i.committed_at AS imported_at, u.name AS imported_by_name
    FROM aims_audit_programmes p LEFT JOIN aims_request_imports i ON i.id=p.current_import_id
    LEFT JOIN users u ON u.id=i.committed_by WHERE p.workspace_id=?`).get(ws.id);
  return row || { workspace_id: ws.id, certification_body: null, stage1_date: null, stage2_date: null, review_period_start: null, review_period_end: null };
}

function updateProgramme(db, ws, actorId, input) {
  const values = {
    certification_body: clean(input.certification_body, 120),
    stage1_date: validDate(input.stage1_date, 'Stage 1 date'),
    stage2_date: validDate(input.stage2_date, 'Stage 2 date'),
    review_period_start: validDate(input.review_period_start, 'review period start'),
    review_period_end: validDate(input.review_period_end, 'review period end'),
  };
  if (values.stage1_date && values.stage2_date && values.stage1_date >= values.stage2_date) throw new AuditError('Stage 1 must come before Stage 2.');
  if (values.review_period_start && values.review_period_end && values.review_period_start > values.review_period_end) {
    throw new AuditError('The review period must start before it ends.');
  }
  db.prepare(`INSERT INTO aims_audit_programmes (workspace_id, certification_body, stage1_date, stage2_date, review_period_start, review_period_end, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id) DO UPDATE SET certification_body=excluded.certification_body, stage1_date=excluded.stage1_date,
      stage2_date=excluded.stage2_date, review_period_start=excluded.review_period_start, review_period_end=excluded.review_period_end,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .run(ws.id, values.certification_body, values.stage1_date, values.stage2_date, values.review_period_start, values.review_period_end, actorId);
}

// ------------------------------------------------------------------ reads

const REQUEST_SELECT = `SELECT r.*, cr.status AS client_status, cr.assignee_id AS client_assignee_id, cr.due_date AS client_due_date,
    cr.version AS client_version, ca.name AS client_assignee_name, o.name AS owner_name,
    (SELECT COUNT(*) FROM aims_request_records rr WHERE rr.request_id=r.id)
      + (SELECT COUNT(*) FROM client_request_evidence cre WHERE r.client_request_id IS NOT NULL AND cre.request_id=r.client_request_id) AS record_count,
    (SELECT COUNT(*) FROM aims_request_samples s WHERE s.request_id=r.id) AS sample_count,
    (SELECT COUNT(*) FROM aims_request_samples s WHERE s.request_id=r.id AND s.status='open') AS samples_open,
    (SELECT group_concat(item_id) FROM aims_request_requirements m WHERE m.request_id=r.id) AS item_ids
  FROM aims_audit_requests r
  LEFT JOIN client_requests cr ON cr.id=r.client_request_id AND cr.workspace_id=r.workspace_id
  LEFT JOIN users ca ON ca.id=cr.assignee_id
  LEFT JOIN users o ON o.id=r.consultant_owner_id`;

function effectiveStatus(r) {
  if (r.withdrawn_at) return 'withdrawn';
  if (r.status === 'with_client') {
    if (!r.client_status || r.client_status === 'cancelled') return 'not_started';
    if (r.client_status === 'submitted' || r.client_status === 'accepted') return 'to_review';
  }
  return r.status;
}

function decorate(r, today) {
  const effective = effectiveStatus(r);
  const items = String(r.item_ids || '').split(',').filter(Boolean).sort((a, b) => requirementSort(a).localeCompare(requirementSort(b)));
  const overdue = !!(r.due_date && today && r.due_date < today && !DONE_FOR_STAGE.has(effective));
  return {
    ...r,
    effective,
    status_label: STATUS_LABELS[effective],
    status_class: STATUS_CLASS[effective],
    kind_label: KIND_LABELS[r.kind],
    stage_label: STAGE_LABELS[r.stage],
    items,
    codes: items.map(requirementCode),
    overdue,
    days_left: r.due_date && today ? daysBetween(today, r.due_date) : null,
    title: shortTitle(r.description),
  };
}

// The CB's descriptions are imperative sentences, often with a stage tag and a
// second sentence. The first sentence without the tag reads as a title.
function shortTitle(description) {
  const text = String(description || '').replace(/\s*\((?:S1|S2|A2|Stage \d)\)/gi, '').replace(/\s+/g, ' ').trim();
  const first = text.split(/(?<=[.;])\s+|\n/)[0].replace(/[.;]$/, '');
  return first.length > 150 ? `${first.slice(0, 147).replace(/\s+\S*$/, '')}...` : first;
}

function listRequests(db, ws, today, filters = {}) {
  const rows = db.prepare(`${REQUEST_SELECT} WHERE r.workspace_id=? ORDER BY
      CASE r.stage WHEN 'stage1' THEN 0 WHEN 'stage2' THEN 1 ELSE 2 END, r.sort_order, r.id`).all(ws.id)
    .map(r => decorate(r, today));
  const q = String(filters.q || '').trim().toLowerCase();
  return rows.filter(r => {
    if (filters.stage && filters.stage !== 'all') {
      if (filters.stage === 'population' ? r.kind !== 'population' : (r.stage !== filters.stage || r.kind === 'population')) return false;
    }
    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'open' ? SETTLED.has(r.effective) : r.effective !== filters.status) return false;
    }
    if (filters.status !== 'withdrawn' && !filters.includeWithdrawn && r.effective === 'withdrawn') return false;
    if (filters.item && !r.items.includes(filters.item)) return false;
    if (q && !`${r.ref} ${r.description} ${r.codes.join(' ')} ${r.cb_category || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function loadRequest(db, ws, id, today) {
  const row = db.prepare(`${REQUEST_SELECT} WHERE r.id=? AND r.workspace_id=?`).get(Number(id), ws.id);
  return row ? decorate(row, today) : null;
}

function requestDetail(db, ws, id, today) {
  const request = loadRequest(db, ws, id, today);
  if (!request) return null;
  const requirements = request.items.length ? db.prepare(`SELECT i.id, i.title, i.type, s.status, s.applicability
      FROM iso42001_items i LEFT JOIN v_iso42001_control_states s ON s.iso_item_id=i.id AND s.workspace_id=?
      WHERE i.id IN (${request.items.map(() => '?').join(',')})`).all(ws.id, ...request.items)
    .sort((a, b) => requirementSort(a.id).localeCompare(requirementSort(b.id)))
    .map(i => ({ ...i, code: requirementCode(i.id), label: String(i.title).replace(/^(A\.)?[\d.]+\s+/, '') })) : [];
  const clientRequest = request.client_request_id ? db.prepare(`SELECT cr.*, u.name AS assignee_name FROM client_requests cr
      LEFT JOIN users u ON u.id=cr.assignee_id WHERE cr.id=? AND cr.workspace_id=?`).get(request.client_request_id, ws.id) : null;
  if (clientRequest) clientRequest.response_note = enc.decryptIfNeeded(clientRequest.response_note, ws.id);
  const clientEvidence = clientRequest ? db.prepare(`SELECT e.id, e.filename, e.description, e.size_bytes, e.uploaded_at, u.name AS uploader
      FROM client_request_evidence cre JOIN evidence e ON e.id=cre.evidence_id AND e.workspace_id=?
      LEFT JOIN users u ON u.id=e.uploaded_by WHERE cre.request_id=? ORDER BY cre.linked_at DESC`).all(ws.id, clientRequest.id) : [];
  const records = db.prepare(`SELECT rr.*, u.name AS linked_by_name,
      e.filename, e.description AS evidence_description, e.size_bytes, e.uploaded_at,
      d.name AS document_name, d.status AS document_status, d.version AS document_version
    FROM aims_request_records rr LEFT JOIN users u ON u.id=rr.linked_by
    LEFT JOIN evidence e ON rr.record_type='evidence' AND e.id=rr.record_id AND e.workspace_id=rr.workspace_id
    LEFT JOIN generated_docs d ON rr.record_type='document' AND d.id=rr.record_id AND d.workspace_id=rr.workspace_id
    WHERE rr.request_id=? AND rr.workspace_id=? ORDER BY rr.linked_at DESC`).all(request.id, ws.id)
    .map(r => ({ ...r, note: enc.decryptIfNeeded(r.note, ws.id) }));
  const samples = db.prepare(`SELECT s.*, e.filename FROM aims_request_samples s LEFT JOIN evidence e ON e.id=s.evidence_id
    WHERE s.request_id=? AND s.workspace_id=? ORDER BY s.id`).all(request.id, ws.id)
    .map(s => ({ ...s, note: enc.decryptIfNeeded(s.note, ws.id) }));
  const events = db.prepare(`SELECT ev.*, u.name AS actor_name FROM aims_request_events ev LEFT JOIN users u ON u.id=ev.actor_id
    WHERE ev.request_id=? AND ev.workspace_id=? ORDER BY ev.id DESC`).all(request.id, ws.id)
    .map(ev => ({ ...ev, note: enc.decryptIfNeeded(ev.note, ws.id), metadata: ev.metadata ? JSON.parse(ev.metadata) : null }));
  return {
    request: { ...request, status_note: enc.decryptIfNeeded(request.status_note, ws.id) },
    requirements, clientRequest, clientEvidence, records, samples, events,
    evidenceCount: clientEvidence.length + records.length,
    actions: allowedActions(request, clientRequest),
  };
}

// What the consultant can do next from the request page, derived from the
// effective status so the page only offers moves that will succeed.
function allowedActions(request, clientRequest) {
  const s = request.effective;
  const clientOpen = clientRequest && CLIENT_OPEN.has(clientRequest.status);
  const a = new Set();
  if (s === 'withdrawn') return a;
  if (['not_started', 'follow_up'].includes(s)) a.add('send_to_client');
  if (['not_started', 'with_client', 'to_review', 'follow_up'].includes(s)) a.add('mark_ready');
  if (s === 'to_review' && clientRequest && clientRequest.status === 'submitted') a.add('return_to_client');
  if (['not_started', 'with_client', 'follow_up'].includes(s)) a.add('mark_not_applicable');
  if (['ready', 'not_applicable'].includes(s)) a.add('reopen');
  if (s === 'ready') a.add('record_submission');
  if (['submitted', 'follow_up'].includes(s)) a.add('auditor_accepted');
  if (['submitted', 'accepted'].includes(s)) a.add('auditor_follow_up');
  if (clientOpen && s === 'with_client') a.delete('send_to_client');
  return a;
}

// ------------------------------------------------------------------ writes

function requireVersion(request, body) {
  const version = Number(body && body.version);
  if (!Number.isInteger(version)) throw new AuditError('Refresh the page before changing this request.', 409);
  if (version !== Number(request.version)) throw new AuditError('This request changed in another session. Refresh it and try again.', 409);
}

function setStatus(db, ws, actorId, request, to, fields = {}) {
  const note = fields.note == null ? undefined : enc.encryptIfNeeded(fields.note, ws.id, !!ws.encryption_enabled);
  const result = db.prepare(`UPDATE aims_audit_requests SET status=?,
      status_note=COALESCE(?, status_note),
      submitted_at=CASE WHEN ?='submitted' THEN COALESCE(?, datetime('now')) ELSE submitted_at END,
      submitted_by=CASE WHEN ?='submitted' THEN ? ELSE submitted_by END,
      client_request_id=COALESCE(?, client_request_id),
      updated_at=datetime('now'), version=version+1
    WHERE id=? AND workspace_id=? AND version=?`).run(to, note ?? null, to, fields.submittedAt || null, to, actorId,
    fields.clientRequestId || null, request.id, ws.id, request.version);
  if (!result.changes) throw new AuditError('This request changed in another session. Refresh it and try again.', 409);
  event(db, ws, actorId, request.id, fields.eventType || 'status_changed', {
    from: request.effective, to, note: fields.note || null, metadata: fields.metadata || null,
  });
}

function clientTransition(db, ws, actorId, clientRequest, to, note) {
  const encrypted = note ? enc.encryptIfNeeded(note, ws.id, !!ws.encryption_enabled) : null;
  const result = db.prepare(`UPDATE client_requests SET status=?, response_note=COALESCE(?, response_note),
      reviewed_by=CASE WHEN ? IN ('accepted','changes_requested') THEN ? ELSE reviewed_by END,
      evidence_quality=CASE WHEN ?='accepted' THEN 'sufficient' WHEN ?='changes_requested' THEN 'insufficient' ELSE evidence_quality END,
      closed_at=CASE WHEN ? IN ('accepted','cancelled') THEN CURRENT_TIMESTAMP ELSE NULL END,
      updated_at=CURRENT_TIMESTAMP, version=version+1
    WHERE id=? AND workspace_id=? AND version=?`).run(to, encrypted, to, actorId, to, to, to, clientRequest.id, ws.id, clientRequest.version);
  if (!result.changes) throw new AuditError('The client request changed in another session. Refresh and try again.', 409);
  db.prepare(`INSERT INTO client_request_events (request_id, workspace_id, actor_id, event_type, from_status, to_status, note, metadata)
    VALUES (?, ?, ?, 'status_changed', ?, ?, ?, ?)`).run(clientRequest.id, ws.id, actorId, clientRequest.status, to, encrypted,
    JSON.stringify({ source: 'iso42001_audit_request' }));
  if (clientRequest.assignee_id && clientRequest.assignee_id !== actorId) {
    db.prepare(`INSERT INTO notifications (workspace_id, user_id, category, severity, title, body, link)
      VALUES (?, ?, 'client_request', ?, ?, ?, ?)`).run(ws.id, clientRequest.assignee_id,
      to === 'changes_requested' ? 'warning' : 'info',
      ({ changes_requested: 'Changes requested', cancelled: 'No longer needed', accepted: 'Accepted' }[to] || 'Updated') + `: ${clientRequest.title}`,
      note || null, `/workspaces/${ws.id}/client-portal/requests/${clientRequest.id}`);
  }
}

// Evidence accepted for a certification request also counts as evidence for
// the clauses and controls it answers, so the requirement pages see it.
function linkEvidenceToRequirements(db, ws, request, evidenceIds) {
  if (!evidenceIds.length || !request.items.length) return;
  const reqIds = db.prepare(`SELECT r.id, r.ref FROM requirements r JOIN frameworks f ON f.id=r.framework_id
    WHERE f.code='iso42001' AND f.status='active' AND r.ref IN (${request.items.map(() => '?').join(',')})`).all(...request.items);
  const ins = db.prepare(`INSERT OR IGNORE INTO evidence_requirement_links (evidence_id, requirement_id, relevance_note)
    SELECT e.id, ?, ? FROM evidence e WHERE e.id=? AND e.workspace_id=?`);
  for (const evidenceId of evidenceIds) {
    for (const r of reqIds) ins.run(r.id, `Answers certification request ${request.ref}`, evidenceId, ws.id);
  }
}

function transition(db, ws, actorId, requestId, action, body, today) {
  const detail = requestDetail(db, ws, requestId, today);
  if (!detail) throw new AuditError('Request not found.', 404);
  const { request, clientRequest, evidenceCount, samples } = detail;
  requireVersion(request, body);
  if (!detail.actions.has(action)) {
    throw new AuditError(`This request is ${request.status_label.toLowerCase()} and cannot be changed that way.`, 409);
  }
  const note = clean(body.note, MAX_NOTE);
  db.transaction(() => {
    switch (action) {
      case 'mark_ready': {
        if (request.kind === 'sample') {
          if (!samples.length) throw new AuditError('Record the items the auditor selected before marking this sample ready.');
          if (samples.some(s => s.status === 'open')) throw new AuditError('Every selected item needs evidence or a recorded exception first.');
        } else if (!evidenceCount) {
          throw new AuditError('Attach at least one file or record before marking this ready to submit.');
        }
        if (clientRequest && clientRequest.status === 'submitted') {
          clientTransition(db, ws, actorId, clientRequest, 'accepted', note);
          event(db, ws, actorId, request.id, 'client_response_accepted', { note });
        } else if (clientRequest && CLIENT_OPEN.has(clientRequest.status)) {
          // Answered from what the consulting team already holds: close the
          // client's copy so they stop working on it.
          clientTransition(db, ws, actorId, clientRequest, 'cancelled', note || 'Answered by the consulting team; nothing more is needed from you.');
        }
        const evidenceIds = [...detail.clientEvidence.map(e => e.id), ...detail.records.filter(r => r.record_type === 'evidence').map(r => r.record_id)];
        linkEvidenceToRequirements(db, ws, request, evidenceIds);
        setStatus(db, ws, actorId, request, 'ready', { note });
        break;
      }
      case 'return_to_client': {
        if (!note) throw new AuditError('Tell the client what is missing before returning the request.');
        clientTransition(db, ws, actorId, clientRequest, 'changes_requested', note);
        event(db, ws, actorId, request.id, 'client_response_returned', { note });
        db.prepare("UPDATE aims_audit_requests SET updated_at=datetime('now'), version=version+1 WHERE id=?").run(request.id);
        break;
      }
      case 'mark_not_applicable': {
        if (!note) throw new AuditError('Record why this request does not apply. The auditor will ask.');
        if (clientRequest && CLIENT_OPEN.has(clientRequest.status)) clientTransition(db, ws, actorId, clientRequest, 'cancelled', note);
        setStatus(db, ws, actorId, request, 'not_applicable', { note });
        break;
      }
      case 'reopen': {
        const back = clientRequest && CLIENT_OPEN.has(clientRequest.status) ? 'with_client' : 'not_started';
        setStatus(db, ws, actorId, request, back, { note });
        break;
      }
      case 'record_submission': {
        const on = validDate(body.submitted_on, 'submission date') || today;
        if (today && on > today) throw new AuditError('The submission date cannot be in the future.');
        setStatus(db, ws, actorId, request, 'submitted', { note, submittedAt: `${on} 00:00:00`, metadata: { submitted_on: on } });
        break;
      }
      case 'auditor_accepted':
        setStatus(db, ws, actorId, request, 'accepted', { note });
        break;
      case 'auditor_follow_up':
        if (!note) throw new AuditError('Record what the auditor asked for.');
        setStatus(db, ws, actorId, request, 'follow_up', { note });
        break;
      default:
        throw new AuditError('Unknown action.');
    }
  })();
}

function clientMembers(db, ws) {
  return db.prepare(`SELECT u.id, u.name, u.email, wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? AND u.active=1 AND u.user_type='client'
    ORDER BY CASE wm.role WHEN 'client_owner' THEN 1 WHEN 'isms_manager' THEN 2 ELSE 3 END, u.name`).all(ws.id);
}

function firmMembers(db, ws) {
  return db.prepare(`SELECT id, name FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name`).all(ws.firm_id);
}

// A suggested date to ask the client for evidence by, leaving time for the
// consultant to review it. It is anchored to the request's own due date when a
// certification body's list gave one, otherwise to this client's Stage 1 or
// Stage 2 date if the consultant has recorded it. With neither, there is no
// suggestion: audit dates are optional and differ from client to client.
function defaultClientDueDate(request, prog, today) {
  const stageDate = request.stage === 'stage1' ? prog && prog.stage1_date
    : request.stage === 'stage2' ? prog && prog.stage2_date : null;
  const target = request.due_date || stageDate || null;
  if (!target) return null;
  if (today && target <= today) return null;
  const buffered = addDays(target, request.due_date ? -7 : -14);
  return today && buffered <= today ? target : buffered;
}

function clientReason(request, programmeRow) {
  const when = request.stage === 'fieldwork'
    ? 'during Stage 2 fieldwork, for the items the auditor selects'
    : request.stage === 'stage1' ? 'when it reviews the AI management system documents at Stage 1'
      : 'at Stage 2, to confirm the AI management system operates as documented';
  const who = programmeRow.certification_body || 'The certification auditor';
  const refs = request.codes.length ? ` It relates to ISO/IEC 42001:2023 ${request.codes.map(c => (c.startsWith('A.') ? `Annex ${c}` : `clause ${c}`)).join(', ')}.` : '';
  const by = request.due_date ? ` The auditor's date for it is ${request.due_date}.` : '';
  const ref = request.source === 'import' ? ` Their reference is ${request.ref}.` : ` Checklist reference ${request.ref}.`;
  return `${who} will ask for this ${when}.${ref}${refs}${by}`;
}

function sendToClient(db, ws, actorId, requestIds, input, today) {
  const assigneeId = Number(input.assignee_id);
  const assignee = clientMembers(db, ws).find(m => m.id === assigneeId);
  if (!assignee) throw new AuditError('Choose someone from the client team to send these to.');
  const note = clean(input.note, 4000);
  const askBy = validDate(input.due_date, 'due date');
  if (askBy && today && askBy < today) throw new AuditError('The date you ask the client for cannot be in the past.');
  const ids = [...new Set((Array.isArray(requestIds) ? requestIds : [requestIds]).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new AuditError('Select at least one request to send.');
  if (ids.length > 200) throw new AuditError('Send at most 200 requests at a time.');
  const prog = programme(db, ws);
  const sent = [];
  const skipped = [];
  db.transaction(() => {
    for (const id of ids) {
      const request = loadRequest(db, ws, id, today);
      if (!request) { skipped.push({ ref: `#${id}`, reason: 'not found' }); continue; }
      if (!['not_started', 'follow_up'].includes(request.effective)) { skipped.push({ ref: request.ref, reason: request.status_label.toLowerCase() }); continue; }
      const due = askBy || defaultClientDueDate(request, prog, today);
      const description = [request.description, note ? `\nFrom your consultant: ${note}` : ''].join('').trim();
      const title = `${request.ref} · ${request.title}`.slice(0, 180);
      const priority = request.stage === 'stage1' && request.days_left != null && request.days_left <= 21 ? 'high' : 'normal';
      const clientId = Number(db.prepare(`INSERT INTO client_requests
        (workspace_id, request_type, title, description, priority, status, assignee_id, due_date, created_by,
         request_reason, acceptable_examples, confidentiality, consultant_owner_id)
        VALUES (?, 'evidence', ?, ?, ?, 'open', ?, ?, ?, ?, ?, 'client_confidential', ?)`).run(ws.id, title,
        enc.encryptIfNeeded(description, ws.id, !!ws.encryption_enabled), priority, assignee.id, due, actorId,
        clientReason(request, prog), request.guidance ? request.guidance.slice(0, 5000) : null, actorId).lastInsertRowid);
      db.prepare(`INSERT INTO client_request_events (request_id, workspace_id, actor_id, event_type, metadata)
        VALUES (?, ?, ?, 'created', ?)`).run(clientId, ws.id, actorId,
        JSON.stringify({ source: 'iso42001_audit_request', audit_request_id: request.id, ref: request.ref, assignee_id: assignee.id, due_date: due }));
      setStatus(db, ws, actorId, request, 'with_client', {
        eventType: 'sent_to_client', clientRequestId: clientId, note,
        metadata: { client_request_id: clientId, assignee_id: assignee.id, assignee_name: assignee.name, due_date: due },
      });
      sent.push({ ref: request.ref, clientRequestId: clientId });
    }
    if (sent.length && assignee.id !== actorId) {
      const one = sent.length === 1;
      db.prepare(`INSERT INTO notifications (workspace_id, user_id, category, severity, title, body, link)
        VALUES (?, ?, 'client_request', 'info', ?, ?, ?)`).run(ws.id, assignee.id,
        one ? `New request: ${sent[0].ref}` : `${sent.length} new requests for the ISO 42001 audit`,
        note || null, one ? `/workspaces/${ws.id}/client-portal/requests/${sent[0].clientRequestId}` : `/workspaces/${ws.id}/client-portal?view=actions`);
    }
  })();
  return { sent, skipped, assignee };
}

function setOwner(db, ws, actorId, requestId, ownerId, body, today) {
  const request = loadRequest(db, ws, requestId, today);
  if (!request) throw new AuditError('Request not found.', 404);
  requireVersion(request, body);
  const owner = ownerId ? firmMembers(db, ws).find(m => m.id === Number(ownerId)) : null;
  if (ownerId && !owner) throw new AuditError('Choose a consultant from your firm.');
  db.prepare(`UPDATE aims_audit_requests SET consultant_owner_id=?, updated_at=datetime('now'), version=version+1
    WHERE id=? AND workspace_id=?`).run(owner ? owner.id : null, request.id, ws.id);
  event(db, ws, actorId, request.id, 'owner_changed', { metadata: { owner_id: owner ? owner.id : null, owner_name: owner ? owner.name : null } });
}

function linkRecord(db, ws, actorId, requestId, input, today) {
  const request = loadRequest(db, ws, requestId, today);
  if (!request) throw new AuditError('Request not found.', 404);
  if (['submitted', 'accepted', 'withdrawn'].includes(request.effective)) {
    throw new AuditError('This request has gone to the auditor. Record a follow-up before changing what was sent.', 409);
  }
  const type = String(input.record_type || '');
  const recordId = Number(input.record_id);
  if (!['evidence', 'document'].includes(type) || !Number.isInteger(recordId)) throw new AuditError('Choose a file or document to link.');
  const exists = type === 'evidence'
    ? db.prepare('SELECT id FROM evidence WHERE id=? AND workspace_id=?').get(recordId, ws.id)
    : db.prepare("SELECT id FROM generated_docs WHERE id=? AND workspace_id=? AND status NOT IN ('retired','withdrawn')").get(recordId, ws.id);
  if (!exists) throw new AuditError(type === 'evidence' ? 'That file is not in this client workspace.' : 'That document is not an active document in this workspace.');
  const note = clean(input.note, 2000);
  db.transaction(() => {
    const r = db.prepare(`INSERT OR IGNORE INTO aims_request_records (request_id, workspace_id, record_type, record_id, note, linked_by)
      VALUES (?, ?, ?, ?, ?, ?)`).run(request.id, ws.id, type, recordId, note ? enc.encryptIfNeeded(note, ws.id, !!ws.encryption_enabled) : null, actorId);
    if (!r.changes) return;
    db.prepare("UPDATE aims_audit_requests SET updated_at=datetime('now'), version=version+1 WHERE id=?").run(request.id);
    event(db, ws, actorId, request.id, 'record_linked', { metadata: { record_type: type, record_id: recordId } });
    if (type === 'evidence' && request.effective === 'ready') linkEvidenceToRequirements(db, ws, request, [recordId]);
  })();
}

function unlinkRecord(db, ws, actorId, requestId, recordRowId, today) {
  const request = loadRequest(db, ws, requestId, today);
  if (!request) throw new AuditError('Request not found.', 404);
  if (['ready', 'submitted', 'accepted', 'withdrawn'].includes(request.effective)) {
    throw new AuditError('Reopen the request before removing what supports it.', 409);
  }
  const row = db.prepare('SELECT * FROM aims_request_records WHERE id=? AND request_id=? AND workspace_id=?').get(Number(recordRowId), request.id, ws.id);
  if (!row) throw new AuditError('That link was not found.', 404);
  db.transaction(() => {
    db.prepare('DELETE FROM aims_request_records WHERE id=?').run(row.id);
    db.prepare("UPDATE aims_audit_requests SET updated_at=datetime('now'), version=version+1 WHERE id=?").run(request.id);
    event(db, ws, actorId, request.id, 'record_unlinked', { metadata: { record_type: row.record_type, record_id: row.record_id } });
  })();
}

function addManualRequest(db, ws, actorId, input) {
  const ref = clean(input.ref, 40);
  const description = clean(input.description, MAX_DESCRIPTION);
  if (!ref || !description) throw new AuditError('Give the request a reference and say what the auditor asked for.');
  if (db.prepare('SELECT 1 FROM aims_audit_requests WHERE workspace_id=? AND ref=?').get(ws.id, ref)) {
    throw new AuditError(`${ref} is already on the request list.`);
  }
  const kind = Object.prototype.hasOwnProperty.call(KIND_LABELS, input.kind) ? input.kind : 'evidence';
  const stage = kind === 'sample' ? 'fieldwork' : (['stage1', 'stage2'].includes(input.stage) ? input.stage : 'stage2');
  const due = validDate(input.due_date, 'due date');
  const refs = resolveRequirementRefs(input.requirements, catalogIds(db));
  if (refs.unresolved.length) throw new AuditError(`Not recognised as ISO 42001 references: ${refs.unresolved.join(', ')}. Use forms like "6.1.4" or "A.5.2".`);
  let id;
  db.transaction(() => {
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 n FROM aims_audit_requests WHERE workspace_id=?').get(ws.id).n;
    id = Number(db.prepare(`INSERT INTO aims_audit_requests (workspace_id, ref, source, kind, stage, description, requirement_text, due_date, sort_order, consultant_owner_id)
      VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`).run(ws.id, ref, kind, stage, description, clean(input.requirements, 1000), due, order, actorId).lastInsertRowid);
    for (const item of refs.ids) db.prepare('INSERT INTO aims_request_requirements (request_id, workspace_id, item_id) VALUES (?, ?, ?)').run(id, ws.id, item);
    event(db, ws, actorId, id, 'added_manually', { to: 'not_started', metadata: { stage, due_date: due } });
  })();
  return id;
}

function addSamples(db, ws, actorId, requestId, input, today) {
  const request = loadRequest(db, ws, requestId, today);
  if (!request) throw new AuditError('Request not found.', 404);
  if (request.kind !== 'sample') throw new AuditError('Only sample requests take a list of selected items.');
  if (['submitted', 'accepted', 'withdrawn'].includes(request.effective)) throw new AuditError('This sample has gone to the auditor.', 409);
  const labels = [...new Set(String(input.labels || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean))];
  if (!labels.length) throw new AuditError('List the items the auditor selected, one per line.');
  if (labels.some(l => l.length > 200)) throw new AuditError('Keep each item to 200 characters or fewer.');
  const current = db.prepare('SELECT COUNT(*) c FROM aims_request_samples WHERE request_id=?').get(request.id).c;
  if (current + labels.length > MAX_SAMPLES) throw new AuditError(`A sample is limited to ${MAX_SAMPLES} items.`);
  let added = 0;
  db.transaction(() => {
    const ins = db.prepare(`INSERT OR IGNORE INTO aims_request_samples (request_id, workspace_id, label, created_by) VALUES (?, ?, ?, ?)`);
    for (const label of labels) added += ins.run(request.id, ws.id, label, actorId).changes;
    if (added) {
      db.prepare("UPDATE aims_audit_requests SET updated_at=datetime('now'), version=version+1 WHERE id=?").run(request.id);
      event(db, ws, actorId, request.id, 'sample_added', { metadata: { added } });
    }
  })();
  return added;
}

function updateSample(db, ws, actorId, requestId, sampleId, input, today) {
  const request = loadRequest(db, ws, requestId, today);
  if (!request) throw new AuditError('Request not found.', 404);
  if (['submitted', 'accepted', 'withdrawn'].includes(request.effective)) throw new AuditError('This sample has gone to the auditor.', 409);
  const sample = db.prepare('SELECT * FROM aims_request_samples WHERE id=? AND request_id=? AND workspace_id=?').get(Number(sampleId), request.id, ws.id);
  if (!sample) throw new AuditError('That sample item was not found.', 404);
  const evidenceId = input.evidence_id ? Number(input.evidence_id) : null;
  if (evidenceId && !db.prepare('SELECT 1 FROM evidence WHERE id=? AND workspace_id=?').get(evidenceId, ws.id)) {
    throw new AuditError('That file is not in this client workspace.');
  }
  const note = clean(input.note, 2000);
  let status = ['open', 'evidenced', 'exception'].includes(input.status) ? input.status : sample.status;
  if (status === 'evidenced' && !evidenceId) throw new AuditError('Choose the file that evidences this item.');
  if (status === 'exception' && !note) throw new AuditError('Describe the exception so it can be reported to the auditor.');
  if (evidenceId && status === 'open') status = 'evidenced';
  db.transaction(() => {
    db.prepare(`UPDATE aims_request_samples SET status=?, evidence_id=?, note=?, updated_at=datetime('now') WHERE id=?`)
      .run(status, evidenceId, note ? enc.encryptIfNeeded(note, ws.id, !!ws.encryption_enabled) : null, sample.id);
    db.prepare("UPDATE aims_audit_requests SET updated_at=datetime('now'), version=version+1 WHERE id=?").run(request.id);
    event(db, ws, actorId, request.id, 'sample_updated', { metadata: { sample: sample.label, status } });
  })();
}

// ------------------------------------------------------------------ overview

function stageSummary(rows, stage, date, today) {
  const list = rows.filter(r => (stage === 'population' ? r.kind === 'population' : r.stage === stage && r.kind !== 'population'));
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map(k => [k, 0]));
  for (const r of list) counts[r.effective]++;
  const live = list.filter(r => r.effective !== 'withdrawn');
  const done = live.filter(r => DONE_FOR_STAGE.has(r.effective)).length;
  return {
    stage, date, total: live.length, done, counts,
    remaining: live.length - done,
    overdue: live.filter(r => r.overdue).length,
    days: date && today ? daysBetween(today, date) : null,
  };
}

function uncitedRequirements(db, ws) {
  return db.prepare(`SELECT i.id, i.title FROM iso42001_items i WHERE NOT EXISTS (
      SELECT 1 FROM aims_request_requirements m JOIN aims_audit_requests r ON r.id=m.request_id
      WHERE m.item_id=i.id AND r.workspace_id=? AND r.withdrawn_at IS NULL) ORDER BY i.sort_order`).all(ws.id)
    .map(i => ({ ...i, code: requirementCode(i.id) }));
}

// The one thing that most needs the consultant's attention, in the order an
// engagement lead would triage it.
function nextStep(model) {
  const { total, stage1, stage2, fieldwork, queues, base, gap } = model;
  // Every engagement starts with the gap assessment; the certification body's
  // list only arrives once Stage 1 is booked. Until it does, the gap
  // assessment is the work.
  if (!total && gap.concluded < gap.total) return {
    key: 'gap',
    title: gap.concluded
      ? `${gap.total - gap.concluded} of ${gap.total} requirements still need a gap conclusion`
      : 'Start the gap assessment',
    body: 'Conclude each clause and Annex A control against evidence. The certification checklist can be started at any time; it tracks everything the auditor will ask for, from the client to the auditor.',
    action: { label: gap.concluded ? 'Continue the gap assessment' : 'Open the gap assessment', href: `${base}/gap-assessment` },
    secondary: { label: 'Start the certification checklist', post: `${base}/checklist` },
  };
  if (!total) return {
    key: 'start',
    title: 'Start the certification checklist',
    body: `The standard ISO 42001 checklist lists the ${CHECKLIST.length} documents, records, populations and samples a certification auditor asks for, sorted into Stage 1 and Stage 2 and mapped to each clause and Annex A control. Starting it gives this client its own copy to work through; audit dates are optional.`,
    action: { label: 'Start the checklist', post: `${base}/checklist` },
  };
  if (queues.toReview.length) return {
    key: 'review',
    title: `${queues.toReview.length} client response${queues.toReview.length === 1 ? ' is' : 's are'} waiting for your review`,
    body: 'The client has uploaded evidence through the portal. Check each file answers what the auditor asked for, then mark it ready or send it back with what is missing.',
    action: { label: 'Review responses', href: `${base}/requests?status=to_review` },
  };
  if (queues.followUp.length) return {
    key: 'follow_up',
    title: `The auditor has come back on ${queues.followUp.length} request${queues.followUp.length === 1 ? '' : 's'}`,
    body: 'Each follow-up records what the auditor asked for. Answer it before fieldwork moves on, or it is likely to become a finding.',
    action: { label: 'Open follow-ups', href: `${base}/requests?status=follow_up` },
  };
  for (const s of [stage1, stage2]) {
    if (!s.total || s.remaining === 0) continue;
    const label = STAGE_LABELS[s.stage];
    const when = s.days == null ? '' : s.days < 0 ? ` The ${label} date passed ${-s.days} day${s.days === -1 ? '' : 's'} ago.` : ` ${label} is in ${s.days} day${s.days === 1 ? '' : 's'}.`;
    if (s.counts.not_started) return {
      key: `${s.stage}_send`,
      title: `${s.counts.not_started} ${label} request${s.counts.not_started === 1 ? ' has' : 's have'} not been started`,
      body: `Send them to the client team, or attach what you already hold.${when}`,
      action: { label: `Open ${label} requests`, href: `${base}/requests?stage=${s.stage}&status=not_started` },
    };
    if (s.counts.with_client) return {
      key: `${s.stage}_chase`,
      title: `${s.counts.with_client} ${label} request${s.counts.with_client === 1 ? ' is' : 's are'} with the client`,
      body: `${s.overdue ? `${s.overdue} ${s.overdue === 1 ? 'is' : 'are'} already past the auditor's due date. ` : ''}Nothing else is waiting on you for ${label}.${when}`,
      action: { label: 'See what the client owes', href: `${base}/requests?stage=${s.stage}&status=with_client` },
    };
    if (s.counts.ready) return {
      key: `${s.stage}_submit`,
      title: `${s.counts.ready} ${label} request${s.counts.ready === 1 ? ' is' : 's are'} ready to go to the auditor`,
      body: `Upload them to the certification body's portal and record the submission here, so the trail shows what was sent and when.${when}`,
      action: { label: 'Record submissions', href: `${base}/requests?stage=${s.stage}&status=ready` },
    };
  }
  if (fieldwork.total && fieldwork.remaining) return {
    key: 'samples',
    title: `${fieldwork.remaining} sample request${fieldwork.remaining === 1 ? ' is' : 's are'} still open`,
    body: 'The auditor selects sample items from the populations during fieldwork. Record each selection on its request and attach evidence item by item.',
    action: { label: 'Open samples', href: `${base}/requests?stage=fieldwork` },
  };
  return {
    key: 'done',
    title: 'Every request is with the auditor',
    body: 'All requests are submitted, accepted or concluded not applicable. Record the auditor\'s acceptance or follow-ups as they come back.',
    action: { label: 'Open the request list', href: `${base}/requests` },
  };
}

function overview(db, ws, today) {
  const rows = listRequests(db, ws, today, { includeWithdrawn: true, status: 'all' });
  const prog = programme(db, ws);
  const base = `/workspaces/${ws.id}/iso42001`;
  const live = rows.filter(r => r.effective !== 'withdrawn');
  const model = {
    base, programme: prog, total: live.length,
    stage1: stageSummary(rows, 'stage1', prog.stage1_date, today),
    stage2: stageSummary(rows, 'stage2', prog.stage2_date, today),
    fieldwork: stageSummary(rows, 'fieldwork', null, today),
    populations: stageSummary(rows, 'population', prog.stage2_date, today),
    queues: {
      toReview: live.filter(r => r.effective === 'to_review'),
      followUp: live.filter(r => r.effective === 'follow_up'),
      overdueWithClient: live.filter(r => r.effective === 'with_client' && r.overdue),
      dueSoon: live.filter(r => !DONE_FOR_STAGE.has(r.effective) && r.days_left != null && r.days_left >= 0 && r.days_left <= 14 && r.effective !== 'with_client'),
    },
    populationRows: live.filter(r => r.kind === 'population'),
    withdrawn: rows.filter(r => r.effective === 'withdrawn').length,
    uncited: live.length ? uncitedRequirements(db, ws) : [],
    gap: gapProgress(db, ws),
  };
  model.next = nextStep(model);
  return model;
}

function gapProgress(db, ws) {
  const total = db.prepare('SELECT COUNT(*) c FROM iso42001_items').get().c;
  const concluded = db.prepare(`SELECT COUNT(*) c FROM v_iso42001_control_states
    WHERE workspace_id=? AND status IS NOT NULL AND status != 'Not Assessed'`).get(ws.id).c;
  return { total, concluded: Math.min(concluded, total) };
}

// Requests that cite one requirement, for the requirement's own page.
function requestsForItem(db, ws, itemId, today) {
  return listRequests(db, ws, today, { item: itemId, status: 'all' });
}

function requestCountsByItem(db, ws, today) {
  const map = {};
  for (const r of listRequests(db, ws, today, { status: 'all' })) {
    for (const item of r.items) {
      const m = map[item] || (map[item] = { total: 0, done: 0 });
      m.total++;
      if (DONE_FOR_STAGE.has(r.effective)) m.done++;
    }
  }
  return map;
}

// CSV of the request list with its current position, for the engagement
// lead's status call with the certification body.
function requestsCsv(db, ws, today) {
  const esc = v => {
    const s = String(v == null ? '' : v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = listRequests(db, ws, today, { status: 'all', includeWithdrawn: true });
  const header = ['Request', 'Stage', 'Type', 'Requirements', 'Due', 'Status', 'Client owner', 'Files and records', 'Submitted', 'Description'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.ref, r.stage_label, r.kind_label, r.codes.join(' '), r.due_date || '', r.status_label, r.client_assignee_name || '',
      r.record_count, r.submitted_at ? String(r.submitted_at).slice(0, 10) : '', r.description].map(esc).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = {
  AuditError, KIND_LABELS, STAGE_LABELS, STAGE_HINTS, STATUS_LABELS, STATUS_CLASS,
  parseRequestList, resolveRequirementRefs, parseDueDate, inferSchedule, stageFor, shortTitle, requirementCode,
  previewImport, loadImport, commitImport, discardImport, applyStandardChecklist, checklistStatus, CHECKLIST_VERSION,
  programme, updateProgramme,
  listRequests, loadRequest, requestDetail, transition, sendToClient, setOwner, linkRecord, unlinkRecord,
  addManualRequest, addSamples, updateSample, clientMembers, firmMembers, defaultClientDueDate,
  overview, requestsForItem, requestCountsByItem, requestsCsv, uncitedRequirements,
};
