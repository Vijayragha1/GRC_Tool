'use strict';
// Per-client values written into document templates in place of their
// bracketed placeholders, so the consultant names the AIMS manager once rather
// than seventy times across the ISO 42001 pack. Values are applied when a
// template is adopted and, on request, to the client's documents still in
// draft. The organisation's role for its AI systems defaults from the AI
// system register, but only when every system in scope has the same single
// role: the placeholder sits in per-system records, so a mixed register
// leaves it to be filled for each system.
// A value left empty keeps the placeholder for someone to fill by hand.

const enc = require('./encryption');
const registry = require('./ai-systems');

class ValuesError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const FIELDS = Object.freeze([
  { key: 'aims_manager', label: 'AIMS manager', hint: 'The person or role who runs the AI management system, e.g. "Head of AI Governance".',
    tokens: ['[AIMS MANAGER]'] },
  { key: 'governance_committee', label: 'AI governance committee', hint: 'What the client calls the body that oversees AI, e.g. "AI Risk Council".',
    tokens: ['[AI GOVERNANCE COMMITTEE]', '[NAME OF AI GOVERNANCE COMMITTEE]'] },
  { key: 'internal_auditor', label: 'Internal auditor', hint: 'Who carries out internal audits of the AIMS.',
    tokens: ['[INTERNAL AUDITOR]'] },
  { key: 'retention_period', label: 'Records retention period', hint: 'How long AIMS records are kept, e.g. "six years".',
    tokens: ['[RETENTION PERIOD]'] },
  { key: 'ai_roles', label: 'Organisation\'s role for its AI systems', hint: 'Only when it is the same for every AI system. Taken from the register when every system in scope has one role.',
    tokens: ['[PROVIDER / PRODUCER / CUSTOMER / PARTNER]'] },
]);
const KEYS = new Set(FIELDS.map((f) => f.key));

// Short role words for a sentence, from the register's role keys.
const ROLE_WORD = { provider: 'provider', producer: 'producer', customer: 'customer', partner: 'partner' };

function rolesFromRegister(db, workspace) {
  const systems = registry.list(db, workspace).filter((s) => s.in_scope);
  const roles = new Set(systems.flatMap((s) => s.roles));
  if (!systems.length || roles.size !== 1 || systems.some((s) => s.roles.length !== 1)) return null;
  return ROLE_WORD[[...roles][0]] || null;
}

function stored(db, workspace) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM template_values WHERE workspace_id=?').all(workspace.id).map((r) => [r.key, r.value]));
}

// Each field with its stored value, the value from records, and the one used.
function values(db, workspace) {
  const saved = stored(db, workspace);
  const fromRecords = { ai_roles: rolesFromRegister(db, workspace) };
  return FIELDS.map((f) => ({ ...f, saved: saved[f.key] || '', fromRecords: fromRecords[f.key] || null, value: saved[f.key] || fromRecords[f.key] || '' }));
}

function save(db, workspace, actorId, body) {
  const upsert = db.prepare(`INSERT INTO template_values (workspace_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (workspace_id, key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`);
  const remove = db.prepare('DELETE FROM template_values WHERE workspace_id=? AND key=?');
  db.transaction(() => {
    for (const key of KEYS) {
      if (body[key] === undefined) continue;
      const value = String(body[key]).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      if (/[[\]]/.test(value)) throw new ValuesError('Values cannot contain square brackets.');
      if (value) upsert.run(workspace.id, key, value, actorId); else remove.run(workspace.id, key);
    }
  })();
}

// Replace each placeholder whose value is set.
function fill(content, fieldValues) {
  let out = String(content || '');
  let replaced = 0;
  for (const f of fieldValues) {
    if (!f.value) continue;
    for (const token of f.tokens) {
      const parts = out.split(token);
      replaced += parts.length - 1;
      out = parts.join(f.value);
    }
  }
  return { content: out, replaced };
}

// Fill the placeholders in the client's documents that are still drafts and
// not locked. Returns the documents changed.
function applyToDrafts(db, workspace) {
  const fieldValues = values(db, workspace);
  const docs = db.prepare(`SELECT id, name, content FROM generated_docs WHERE workspace_id=? AND status='draft' AND COALESCE(locked,0)=0`).all(workspace.id);
  const update = db.prepare('UPDATE generated_docs SET content=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND workspace_id=? AND status=\'draft\' AND COALESCE(locked,0)=0');
  const changed = [];
  db.transaction(() => {
    for (const d of docs) {
      const plain = enc.decryptIfNeeded(d.content || '', workspace.id);
      const { content, replaced } = fill(plain, fieldValues);
      if (!replaced) continue;
      update.run(enc.encryptIfNeeded(content, workspace.id, !!workspace.encryption_enabled), d.id, workspace.id);
      changed.push({ id: d.id, name: d.name, replaced });
    }
  })();
  return changed;
}

module.exports = { ValuesError, FIELDS, values, save, fill, applyToDrafts };
