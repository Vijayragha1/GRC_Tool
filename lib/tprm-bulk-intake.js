'use strict';

// Governed TPRM bulk intake. A CSV row represents one exact service
// relationship. Multiple rows may intentionally share a provider reference,
// but names are never treated as identity and are never auto-merged.

const crypto = require('crypto');
const relationships = require('./tprm-relationships');
const serviceCapabilities = require('./tprm-capabilities');

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 500;
const MAX_COLUMNS = 32;
const MAX_CELL_LENGTH = 5000;

const STANDARD_CLAUSES = Object.freeze([
  ['confidentiality', 'Confidentiality / non-disclosure'],
  ['data_handling', 'Data handling and classification'],
  ['security_obligations', 'Information security obligations (referencing standards)'],
  ['breach_notification', 'Breach notification (within 72 hours of awareness)'],
  ['subprocessor_approval', 'Sub-processor approval and notification'],
  ['audit_rights', 'Right to audit / receive assurance reports'],
  ['data_return_destruction', 'Data return / destruction at termination'],
  ['liability_indemnity', 'Liability and indemnity for security failures'],
  ['compliance', 'Compliance with applicable laws and regulations'],
  ['dpa', 'Data Processing Agreement (where personal data is processed)'],
  ['change_management', 'Change management / notice of material changes'],
  ['service_levels', 'Service levels and remedies'],
]);

const FIELDS = Object.freeze([
  { key: 'provider_reference', label: 'Provider reference', required: true, aliases: ['third party reference', 'third-party reference', 'provider id'] },
  { key: 'legal_name', label: 'Legal name', required: true, aliases: ['third party', 'third-party name', 'provider name'] },
  { key: 'relationship_reference', label: 'Relationship reference', required: true, aliases: ['service reference', 'relationship id'] },
  { key: 'relationship_name', label: 'Relationship name', required: true, aliases: ['service name', 'service'] },
  { key: 'service_description', label: 'Service description', required: true, aliases: ['scope', 'service scope'] },
  { key: 'business_owner', label: 'Business owner', required: true, aliases: ['client owner'] },
  { key: 'relationship_owner', label: 'Consultancy owner', required: true, aliases: ['relationship owner', 'consultant owner'] },
  { key: 'criticality', label: 'Criticality', required: true, aliases: ['business criticality'] },
  { key: 'data_access', label: 'Data access', required: true, aliases: ['data classification'] },
  { key: 'service_category', label: 'Service category', aliases: ['category'] },
  { key: 'provision_model', label: 'Provision model', aliases: ['delivery model'] },
  { key: 'security_owner', label: 'Security owner', aliases: ['security reviewer'] },
  { key: 'registration_country_code', label: 'Registration country', aliases: ['country code', 'registration country code'] },
  { key: 'registration_number', label: 'Registration number', aliases: ['company number'] },
  { key: 'contact', label: 'Provider contact email', aliases: ['contact', 'email'] },
  { key: 'rto_hours', label: 'RTO hours', aliases: ['rto'] },
  { key: 'rpo_hours', label: 'RPO hours', aliases: ['rpo'] },
  { key: 'substitutability', label: 'Substitutability', aliases: ['replacement difficulty'] },
  { key: 'sole_source', label: 'Sole source', aliases: ['single source'] },
  { key: 'material_outsourcing', label: 'Material outsourcing', aliases: ['material service'] },
  { key: 'regulated_service', label: 'Regulated service', aliases: ['regulated'] },
  { key: 'distinct_legal_entity_confirmed', label: 'Distinct legal entity confirmed', aliases: ['same name acknowledgement'] },
]);

const ENUMS = Object.freeze({
  criticality: new Set(['low', 'moderate', 'high', 'critical', 'unknown']),
  data_access: new Set(['none', 'internal', 'confidential', 'restricted', 'mixed', 'unknown']),
  provision_model: new Set(['saas', 'paas', 'iaas', 'managed_service', 'professional_service', 'data_provider', 'physical_service', 'other']),
  substitutability: new Set(['readily_substitutable', 'substitutable_with_effort', 'difficult', 'not_substitutable', 'unknown']),
});

class TprmBulkIntakeError extends Error {
  constructor(code, message, status = 400, result = null) {
    super(message);
    this.name = 'TprmBulkIntakeError';
    this.code = code;
    this.status = status;
    this.result = result;
  }
}

function fail(code, message, status = 400, result = null) {
  throw new TprmBulkIntakeError(code, message, status, result);
}

function clean(value, max = MAX_CELL_LENGTH) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max) fail('TPRM_BULK_CELL_TOO_LONG', `A CSV value exceeds the ${max}-character limit.`, 413);
  return text;
}

function normalizedHeader(value) {
  return clean(value, 200).toLowerCase().replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ');
}

function parseCsv(csvInput) {
  const csv = String(csvInput == null ? '' : csvInput).replace(/^\uFEFF/, '');
  if (!csv || csv.includes('\u0000')) fail('TPRM_BULK_FILE_INVALID', 'Choose a non-empty UTF-8 CSV file.');
  if (Buffer.byteLength(csv, 'utf8') > MAX_BYTES) fail('TPRM_BULK_FILE_TOO_LARGE', 'The CSV exceeds the 1 MB intake limit.', 413);
  const matrix = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && csv[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some(value => String(value).trim())) matrix.push(row);
      row = [];
      if (matrix.length > MAX_ROWS + 1) fail('TPRM_BULK_ROW_LIMIT', `A maximum of ${MAX_ROWS} data rows is accepted per intake.`, 413);
    } else cell += char;
    if (cell.length > MAX_CELL_LENGTH) fail('TPRM_BULK_CELL_TOO_LONG', `A CSV value exceeds the ${MAX_CELL_LENGTH}-character limit.`, 413);
  }
  if (quoted) fail('TPRM_BULK_FORMAT_INVALID', 'The CSV contains an unterminated quoted value.');
  if (cell || row.length) {
    row.push(cell);
    if (row.some(value => String(value).trim())) matrix.push(row);
  }
  if (matrix.length > MAX_ROWS + 1) fail('TPRM_BULK_ROW_LIMIT', `A maximum of ${MAX_ROWS} data rows is accepted per intake.`, 413);
  if (matrix.length < 2) fail('TPRM_BULK_ROWS_REQUIRED', 'The CSV must contain a header and at least one data row.');
  if (matrix[0].length > MAX_COLUMNS) fail('TPRM_BULK_COLUMN_LIMIT', `A maximum of ${MAX_COLUMNS} columns is accepted.`, 413);
  const rawHeaders = matrix.shift().map(value => clean(value, 200));
  const normalized = rawHeaders.map(normalizedHeader);
  if (normalized.some(value => !value) || new Set(normalized).size !== normalized.length) {
    fail('TPRM_BULK_HEADERS_INVALID', 'CSV headers must be non-empty and unique.');
  }
  matrix.forEach((values, index) => {
    if (values.length !== rawHeaders.length) fail('TPRM_BULK_COLUMN_MISMATCH', `CSV line ${index + 2} has the wrong number of columns.`);
  });
  return { rawHeaders, normalized, matrix, csv };
}

function headerMap(normalized) {
  const lookup = new Map();
  for (const field of FIELDS) {
    [field.key, field.label, ...(field.aliases || [])].forEach(value => lookup.set(normalizedHeader(value), field.key));
  }
  const mapped = normalized.map(header => lookup.get(header) || null);
  const unknown = normalized.filter((header, index) => !mapped[index]);
  const duplicateTargets = mapped.filter(Boolean).filter((key, index, values) => values.indexOf(key) !== index);
  if (unknown.length) fail('TPRM_BULK_UNKNOWN_HEADERS', `Unrecognised column${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Remove or rename them before preview.`);
  if (duplicateTargets.length) fail('TPRM_BULK_DUPLICATE_HEADERS', `More than one column maps to ${[...new Set(duplicateTargets)].join(', ')}.`);
  const missing = FIELDS.filter(field => field.required && !mapped.includes(field.key)).map(field => field.label);
  if (missing.length) fail('TPRM_BULK_REQUIRED_HEADERS', `Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
  return mapped;
}

function boolValue(value, field, errors) {
  const text = clean(value, 20).toLowerCase();
  if (!text) return false;
  if (['yes', 'true', '1'].includes(text)) return true;
  if (['no', 'false', '0'].includes(text)) return false;
  errors.push(`${field} must be yes or no.`);
  return false;
}

function integerValue(value, field, errors) {
  const text = clean(value, 20);
  if (!text) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0 || number > 1000000) {
    errors.push(`${field} must be a whole number from 0 to 1,000,000.`);
    return null;
  }
  return number;
}

function referenceValue(value, label, errors) {
  const text = clean(value, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,99}$/.test(text)) errors.push(`${label} must be 2–100 letters, numbers, dots, colons, underscores or hyphens.`);
  return text;
}

function enumValue(value, key, fallback, errors) {
  const text = clean(value, 100).toLowerCase().replace(/[ -]+/g, '_') || fallback;
  if (!ENUMS[key].has(text)) errors.push(`${FIELDS.find(field => field.key === key)?.label || key} must be one of: ${[...ENUMS[key]].join(', ')}.`);
  return text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function identityKeys(workspaceId, providerReference, relationshipReference) {
  const providerHash = sha256(`${workspaceId}:provider:${providerReference.toLowerCase()}`);
  const relationshipHash = sha256(`${workspaceId}:relationship:${providerReference.toLowerCase()}:${relationshipReference.toLowerCase()}`);
  return {
    providerPrefix: `bulk-p-${providerHash.slice(0, 24)}`,
    relationshipKey: `bulk-p-${providerHash.slice(0, 24)}-r-${relationshipHash.slice(0, 24)}`,
    idempotencyKey: relationshipHash,
  };
}

function normalizedRow(values, mapped, line) {
  const raw = {};
  mapped.forEach((key, index) => { raw[key] = clean(values[index]); });
  const errors = [];
  const requiredText = (key, label, minimum = 2, maximum = 300) => {
    const value = clean(raw[key], maximum);
    if (value.length < minimum) errors.push(`${label} is required and must contain at least ${minimum} characters.`);
    return value;
  };
  const parsed = {
    provider_reference: referenceValue(raw.provider_reference, 'Provider reference', errors),
    legal_name: requiredText('legal_name', 'Legal name', 2, 300),
    relationship_reference: referenceValue(raw.relationship_reference, 'Relationship reference', errors),
    relationship_name: requiredText('relationship_name', 'Relationship name', 2, 300),
    service_description: requiredText('service_description', 'Service description', 2, 5000),
    business_owner: requiredText('business_owner', 'Business owner', 2, 300),
    relationship_owner: requiredText('relationship_owner', 'Consultancy owner', 2, 300),
    criticality: enumValue(raw.criticality, 'criticality', 'unknown', errors),
    data_access: enumValue(raw.data_access, 'data_access', 'unknown', errors),
    service_category: clean(raw.service_category, 200) || null,
    provision_model: enumValue(raw.provision_model, 'provision_model', 'other', errors),
    security_owner: clean(raw.security_owner, 300) || null,
    registration_country_code: clean(raw.registration_country_code, 2).toUpperCase() || null,
    registration_number: clean(raw.registration_number, 200) || null,
    contact: clean(raw.contact, 320) || null,
    rto_hours: integerValue(raw.rto_hours, 'RTO hours', errors),
    rpo_hours: integerValue(raw.rpo_hours, 'RPO hours', errors),
    substitutability: enumValue(raw.substitutability, 'substitutability', 'unknown', errors),
    sole_source: boolValue(raw.sole_source, 'Sole source', errors),
    material_outsourcing: boolValue(raw.material_outsourcing, 'Material outsourcing', errors),
    regulated_service: boolValue(raw.regulated_service, 'Regulated service', errors),
    distinct_legal_entity_confirmed: boolValue(raw.distinct_legal_entity_confirmed, 'Distinct legal entity confirmed', errors),
  };
  if (parsed.registration_country_code && !/^[A-Z]{2}$/.test(parsed.registration_country_code)) errors.push('Registration country must be a two-letter ISO country code.');
  if (parsed.contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.contact)) errors.push('Provider contact email is not valid.');
  return { line, parsed, errors, warnings: [], outcome: errors.length ? 'error' : 'pending', valid: errors.length === 0 };
}

function comparableMatches(existing, legalEntity, supplier, parsed, expectedPrimary) {
  const actual = {
    legal_name: clean(legalEntity && legalEntity.legal_name),
    relationship_name: clean(existing.relationship_name),
    service_description: clean(existing.service_description),
    business_owner: clean(existing.business_owner),
    relationship_owner: clean(existing.relationship_owner),
    security_owner: clean(existing.security_owner),
    criticality: clean(existing.criticality),
    data_access: clean(existing.data_access),
    service_category: clean(existing.service_category),
    provision_model: clean(existing.provision_model),
    registration_country_code: clean(legalEntity && legalEntity.registration_country_code),
    registration_number: clean(legalEntity && legalEntity.registration_number),
    contact: clean(supplier && supplier.contact),
    rto_hours: existing.rto_hours == null ? null : Number(existing.rto_hours),
    rpo_hours: existing.rpo_hours == null ? null : Number(existing.rpo_hours),
    substitutability: clean(existing.substitutability),
    sole_source: Boolean(existing.sole_source),
    material_outsourcing: Boolean(existing.material_outsourcing),
    regulated_service: Boolean(existing.regulated_service),
    is_primary: Boolean(existing.is_primary),
  };
  const expected = {
    legal_name: parsed.legal_name,
    relationship_name: parsed.relationship_name,
    service_description: parsed.service_description,
    business_owner: parsed.business_owner,
    relationship_owner: parsed.relationship_owner,
    security_owner: parsed.security_owner || '',
    criticality: parsed.criticality,
    data_access: parsed.data_access,
    service_category: parsed.service_category || '',
    provision_model: parsed.provision_model,
    registration_country_code: parsed.registration_country_code || '',
    registration_number: parsed.registration_number || '',
    contact: parsed.contact || '',
    rto_hours: parsed.rto_hours,
    rpo_hours: parsed.rpo_hours,
    substitutability: parsed.substitutability,
    sole_source: parsed.sole_source,
    material_outsourcing: parsed.material_outsourcing,
    regulated_service: parsed.regulated_service,
    is_primary: Boolean(expectedPrimary),
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function inspectDatabase(db, workspaceId, rows) {
  const pairSeen = new Map();
  const providerFacts = new Map();
  for (const row of rows) {
    if (!row.valid) continue;
    const parsed = row.parsed;
    const keys = identityKeys(workspaceId, parsed.provider_reference, parsed.relationship_reference);
    Object.assign(row, keys);
    const pair = `${parsed.provider_reference.toLowerCase()}\u0000${parsed.relationship_reference.toLowerCase()}`;
    if (pairSeen.has(pair)) {
      row.errors.push(`Provider and relationship reference duplicates CSV line ${pairSeen.get(pair)}.`);
      row.valid = false;
      row.outcome = 'error';
      continue;
    }
    pairSeen.set(pair, row.line);
    const providerKey = parsed.provider_reference.toLowerCase();
    const prior = providerFacts.get(providerKey);
    const currentFacts = JSON.stringify({
      legalName: parsed.legal_name.toLowerCase(),
      registrationCountry: parsed.registration_country_code || '',
      registrationNumber: (parsed.registration_number || '').toLowerCase(),
      providerContact: (parsed.contact || '').toLowerCase(),
    });
    if (prior && prior.facts !== currentFacts) {
      row.errors.push(`Provider reference conflicts with the legal-entity identity on CSV line ${prior.line}.`);
      row.valid = false;
      row.outcome = 'error';
      continue;
    }
    providerFacts.set(providerKey, { facts: currentFacts, line: row.line });
  }

  const grouped = new Map();
  for (const row of rows.filter(item => item.valid)) {
    const key = row.parsed.provider_reference.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  for (const group of grouped.values()) {
    const sample = group[0];
    const escapedPrefix = sample.providerPrefix.replace(/[\\%_]/g, value => `\\${value}`);
    const mapped = db.prepare(`SELECT DISTINCT supplier_id FROM tprm_service_relationships
      WHERE workspace_id=? AND relationship_key LIKE ? ESCAPE '\\'`).all(workspaceId, `${escapedPrefix}-r-%`);
    if (mapped.length > 1) {
      group.forEach(row => { row.errors.push('Provider reference is already mapped to more than one record. Resolve the identity conflict before importing.'); row.valid = false; row.outcome = 'error'; });
      continue;
    }
    const mappedSupplierId = mapped[0] && Number(mapped[0].supplier_id);
    const mappedSupplier = mappedSupplierId ? db.prepare('SELECT * FROM suppliers WHERE workspace_id=? AND id=?').get(workspaceId, mappedSupplierId) : null;
    const mappedLegal = mappedSupplierId ? db.prepare('SELECT * FROM tprm_legal_entities WHERE workspace_id=? AND supplier_id=?').get(workspaceId, mappedSupplierId) : null;
    const mappedIdentityConflicts = mappedSupplier && (
      clean(mappedLegal && mappedLegal.legal_name).toLowerCase() !== sample.parsed.legal_name.toLowerCase()
      || clean(mappedLegal && mappedLegal.registration_country_code).toUpperCase() !== (sample.parsed.registration_country_code || '')
      || clean(mappedLegal && mappedLegal.registration_number).toLowerCase() !== (sample.parsed.registration_number || '').toLowerCase()
      || clean(mappedSupplier.contact).toLowerCase() !== (sample.parsed.contact || '').toLowerCase()
    );
    if (mappedIdentityConflicts) {
      group.forEach(row => { row.errors.push('Provider reference is already bound to different legal-entity or provider-contact facts. No record was changed.'); row.valid = false; row.outcome = 'error'; });
      continue;
    }
    if (!mappedSupplier) {
      const sameNames = db.prepare(`SELECT id,name FROM suppliers WHERE workspace_id=? AND archived_at IS NULL
        AND lower(trim(name))=lower(trim(?)) ORDER BY id`).all(workspaceId, sample.parsed.legal_name);
      if (sameNames.length && !group.every(row => row.parsed.distinct_legal_entity_confirmed)) {
        group.forEach(row => {
          row.errors.push(`A same-named third party already exists (record ${sameNames[0].id}). Names are never auto-merged; use the existing record or set “Distinct legal entity confirmed” to yes after verification.`);
          row.valid = false;
          row.outcome = 'error';
        });
        continue;
      }
      if (sameNames.length) group.forEach(row => row.warnings.push('A same-named record exists. This intake will create a separate legal-entity record because explicit confirmation was supplied.'));
    }
    let willHavePrimary = mappedSupplierId
      ? Boolean(db.prepare('SELECT 1 FROM tprm_service_relationships WHERE workspace_id=? AND supplier_id=? AND is_primary=1').get(workspaceId, mappedSupplierId))
      : false;
    for (const row of group) {
      const existing = db.prepare(`SELECT * FROM tprm_service_relationships
        WHERE workspace_id=? AND (relationship_key=? OR idempotency_key=?)`).get(workspaceId, row.relationshipKey, row.idempotencyKey);
      const supplier = existing ? db.prepare('SELECT * FROM suppliers WHERE workspace_id=? AND id=?').get(workspaceId, existing.supplier_id) : mappedSupplier;
      const legal = existing ? db.prepare('SELECT * FROM tprm_legal_entities WHERE workspace_id=? AND supplier_id=?').get(workspaceId, existing.supplier_id) : mappedLegal;
      const expectedPrimary = existing ? Boolean(existing.is_primary) : !willHavePrimary;
      if (existing) {
        if (mappedSupplierId && Number(existing.supplier_id) !== mappedSupplierId) {
          row.errors.push('Relationship reference conflicts with the provider identity. No record was changed.');
          row.valid = false;
          row.outcome = 'error';
        } else if (!comparableMatches(existing, legal, supplier, row.parsed, expectedPrimary)) {
          row.errors.push('This relationship reference was imported before with different facts. Existing governed facts were retained; use the relationship change workflow instead.');
          row.valid = false;
          row.outcome = 'error';
        } else {
          row.outcome = 'already_imported';
          row.existingSupplierId = Number(existing.supplier_id);
          row.existingRelationshipId = Number(existing.id);
          willHavePrimary ||= Boolean(existing.is_primary);
        }
      } else {
        row.outcome = mappedSupplierId || willHavePrimary ? 'create_relationship' : 'create_provider';
        willHavePrimary = true;
      }
    }
  }
  rows.forEach(row => { row.valid = row.errors.length === 0; if (!row.valid) row.outcome = 'error'; });
  return rows;
}

function preview(db, input) {
  const workspaceId = Number(input.workspaceId);
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) fail('TPRM_BULK_WORKSPACE_REQUIRED', 'A valid client workspace is required.');
  const parsedCsv = parseCsv(input.csvText);
  const mapped = headerMap(parsedCsv.normalized);
  const rows = parsedCsv.matrix.map((values, index) => normalizedRow(values, mapped, index + 2));
  inspectDatabase(db, workspaceId, rows);
  const summary = {
    total: rows.length,
    valid: rows.filter(row => row.valid).length,
    invalid: rows.filter(row => !row.valid).length,
    createProviders: rows.filter(row => row.valid && row.outcome === 'create_provider').length,
    createRelationships: rows.filter(row => row.valid && row.outcome === 'create_relationship').length,
    alreadyImported: rows.filter(row => row.valid && row.outcome === 'already_imported').length,
    warnings: rows.filter(row => row.warnings.length).length,
  };
  return { rows, summary, digest: sha256(parsedCsv.csv), allValid: summary.invalid === 0, limits: { maxBytes: MAX_BYTES, maxRows: MAX_ROWS } };
}

function createSupplier(db, workspaceId, actorId, parsed) {
  const entityId = Number(db.prepare(`INSERT INTO entities
    (workspace_id,name,description,entity_type,region,contact,attributes)
    VALUES (?, ?, ?, 'supplier', ?, ?, ?)`).run(
      workspaceId, parsed.legal_name, parsed.service_description,
      parsed.registration_country_code || null, parsed.contact || null,
      JSON.stringify({ lifecycle_stage: 'prospect', criticality: parsed.criticality, data_access: parsed.data_access, governed_bulk_intake: true })
    ).lastInsertRowid);
  const criticality = parsed.criticality === 'moderate' || parsed.criticality === 'unknown' ? 'medium' : parsed.criticality;
  const legacyDataAccess = ({ none: 'none', internal: 'metadata', confidential: 'confidential', restricted: 'sensitive', mixed: 'sensitive', unknown: 'none' })[parsed.data_access];
  const supplierId = Number(db.prepare(`INSERT INTO suppliers
    (workspace_id,entity_id,name,service_provided,business_criticality,data_access,dependency_type,
     lifecycle_stage,business_owner,relationship_owner,security_reviewer,service_category,rto_hours,rpo_hours,contact,location)
    VALUES (?,?,?,?,?,?,?,'prospect',?,?,?,?,?,?,?,?)`).run(
      workspaceId, entityId, parsed.legal_name, parsed.relationship_name, criticality, legacyDataAccess,
      parsed.sole_source ? 'single_source' : 'multi_source', parsed.business_owner, parsed.relationship_owner,
      parsed.security_owner || null, parsed.service_category || null, parsed.rto_hours, parsed.rpo_hours,
      parsed.contact || null, parsed.registration_country_code || null
    ).lastInsertRowid);
  const insertClause = db.prepare(`INSERT INTO supplier_clauses
    (workspace_id,supplier_id,clause_key,clause_label,status) VALUES (?,?,?,?,'pending')`);
  STANDARD_CLAUSES.forEach(([key, label]) => insertClause.run(workspaceId, supplierId, key, label));
  return supplierId;
}

function commit(db, input) {
  const workspaceId = Number(input.workspaceId);
  const actorId = Number(input.actorId);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('TPRM_BULK_ACTOR_REQUIRED', 'An authenticated consulting-team actor is required.', 403);
  return db.transaction(() => {
    const result = preview(db, { workspaceId, csvText: input.csvText });
    if (input.previewDigest && input.previewDigest !== result.digest) {
      fail('TPRM_BULK_PREVIEW_CHANGED', 'The CSV changed after preview. Preview the exact file again before committing.', 409, result);
    }
    if (!result.allValid) fail('TPRM_BULK_VALIDATION_FAILED', 'Nothing was imported because one or more rows require correction.', 409, result);
    const suppliersByProvider = new Map();
    const createdSupplierIds = [];
    const createdRelationshipIds = [];
    const replayedRelationshipIds = [];
    for (const row of result.rows) {
      if (row.outcome === 'already_imported') {
        suppliersByProvider.set(row.parsed.provider_reference.toLowerCase(), row.existingSupplierId);
        replayedRelationshipIds.push(row.existingRelationshipId);
        continue;
      }
      const providerKey = row.parsed.provider_reference.toLowerCase();
      let supplierId = suppliersByProvider.get(providerKey);
      if (!supplierId) {
        const escapedPrefix = row.providerPrefix.replace(/[\\%_]/g, value => `\\${value}`);
        const mapped = db.prepare(`SELECT DISTINCT supplier_id FROM tprm_service_relationships
          WHERE workspace_id=? AND relationship_key LIKE ? ESCAPE '\\'`).get(workspaceId, `${escapedPrefix}-r-%`);
        supplierId = mapped && Number(mapped.supplier_id);
      }
      if (!supplierId) {
        supplierId = createSupplier(db, workspaceId, actorId, row.parsed);
        createdSupplierIds.push(supplierId);
      }
      suppliersByProvider.set(providerKey, supplierId);
      const hasPrimary = Boolean(db.prepare('SELECT 1 FROM tprm_service_relationships WHERE workspace_id=? AND supplier_id=? AND is_primary=1').get(workspaceId, supplierId));
      const created = relationships.createRelationship(db, {
        workspaceId,
        supplierId,
        actorId,
        legalName: row.parsed.legal_name,
        registrationCountryCode: row.parsed.registration_country_code,
        registrationNumber: row.parsed.registration_number,
        relationshipKey: row.relationshipKey,
        relationshipName: row.parsed.relationship_name,
        serviceCategory: row.parsed.service_category,
        serviceDescription: row.parsed.service_description,
        provisionModel: row.parsed.provision_model,
        status: 'intake',
        criticality: row.parsed.criticality,
        dataAccess: row.parsed.data_access,
        relationshipOwner: row.parsed.relationship_owner,
        businessOwner: row.parsed.business_owner,
        securityOwner: row.parsed.security_owner,
        rtoHours: row.parsed.rto_hours,
        rpoHours: row.parsed.rpo_hours,
        substitutability: row.parsed.substitutability,
        soleSource: row.parsed.sole_source,
        materialOutsourcing: row.parsed.material_outsourcing,
        regulatedService: row.parsed.regulated_service,
        isPrimary: !hasPrimary,
        idempotencyKey: row.idempotencyKey,
        reason: `Governed bulk intake from CSV line ${row.line}; provider and relationship references were validated before commit.`,
      });
      createdRelationshipIds.push(Number(created.relationship.id));
    }
    const committed = {
      preview: result,
      createdSupplierIds,
      createdRelationshipIds,
      replayedRelationshipIds,
      counts: {
        thirdPartiesCreated: createdSupplierIds.length,
        relationshipsCreated: createdRelationshipIds.length,
        alreadyImported: replayedRelationshipIds.length,
      },
    };
    if (typeof input.onBeforeCommit === 'function') input.onBeforeCommit(committed);
    return committed;
  }).immediate();
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function templateCsv() {
  const examples = [
    {
      provider_reference: 'PROV-001', legal_name: 'Example Cloud Services Ltd', relationship_reference: 'SVC-HOSTING',
      relationship_name: 'Production hosting', service_description: 'Hosts the client production application and encrypted customer data.',
      business_owner: 'Head of Product', relationship_owner: 'TPRM Consultant', criticality: 'critical', data_access: 'restricted',
      service_category: 'Cloud infrastructure', provision_model: 'iaas', security_owner: 'CISO', registration_country_code: 'GB',
      contact: 'security@example.invalid', rto_hours: '4', rpo_hours: '1', substitutability: 'difficult', sole_source: 'yes',
      material_outsourcing: 'yes', regulated_service: 'yes', distinct_legal_entity_confirmed: 'no',
    },
    {
      provider_reference: 'PROV-001', legal_name: 'Example Cloud Services Ltd', relationship_reference: 'SVC-BACKUP',
      relationship_name: 'Backup vault', service_description: 'Stores immutable encrypted production backups in a separate service relationship.',
      business_owner: 'Head of Product', relationship_owner: 'TPRM Consultant', criticality: 'high', data_access: 'restricted',
      service_category: 'Backup', provision_model: 'saas', security_owner: 'CISO', registration_country_code: 'GB',
      contact: 'security@example.invalid', rto_hours: '24', rpo_hours: '4', substitutability: 'substitutable_with_effort', sole_source: 'no',
      material_outsourcing: 'no', regulated_service: 'yes', distinct_legal_entity_confirmed: 'no',
    },
  ];
  const headers = FIELDS.map(field => field.label);
  const lines = [headers.map(csvCell).join(',')];
  examples.forEach(example => lines.push(FIELDS.map(field => csvCell(example[field.key])).join(',')));
  return `${lines.join('\r\n')}\r\n`;
}

function errorCsv(result) {
  const headers = ['CSV line', 'Status', 'Provider reference', 'Relationship reference', 'Legal name', 'Relationship name', 'Errors', 'Warnings'];
  const lines = [headers.map(csvCell).join(',')];
  (result && result.rows || []).forEach(row => {
    lines.push([
      row.line, row.valid ? row.outcome : 'error', row.parsed.provider_reference, row.parsed.relationship_reference,
      row.parsed.legal_name, row.parsed.relationship_name, row.errors.join(' | '), row.warnings.join(' | '),
    ].map(csvCell).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = {
  TprmBulkIntakeError,
  MAX_BYTES,
  MAX_ROWS,
  FIELDS,
  preview,
  commit: serviceCapabilities.withCapability(serviceCapabilities.CAPABILITIES.DRAFT_INTAKE, commit),
  templateCsv,
  errorCsv,
  identityKeys,
  serviceCapabilities,
};
