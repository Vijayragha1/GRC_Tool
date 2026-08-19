// CSV import pipeline for assets and risks. RFC-4180 parsing (quoted fields,
// embedded commas/newlines, escaped "" quotes, BOM tolerant). Schemas declare
// every accepted column with synonyms so headers like "Asset Name" or "Owner
// Name" map cleanly to internal fields without the user reading docs.
//
// The pipeline is two-phase: preview returns parsed+validated rows so the
// importer can show row-by-row status before commit, and commit runs every
// valid row through one transaction so a single bad row never leaves the
// register half-written.

'use strict';

// ---------- RFC-4180-ish parser ----------
function parseCSV(text) {
  if (text == null) return { rows: [], headers: [] };
  // Strip UTF-8 BOM if present (Excel exports include it).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Normalize line endings so quoted-newline detection works once.
  // We do this inside the parser, not as a separate pass, because CRLFs can
  // legitimately appear inside quoted fields and must be preserved verbatim.
  const out = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); field = '';
      out.push(row); row = [];
      continue;
    }
    if (c === '\n') {
      row.push(field); field = '';
      out.push(row); row = [];
      continue;
    }
    field += c;
  }
  // Trailing field / row.
  if (field !== '' || row.length) { row.push(field); out.push(row); }

  // Drop blank rows (all cells empty) - but only if every cell is truly empty.
  const nonBlank = out.filter(r => r.some(cell => String(cell).trim() !== ''));
  if (!nonBlank.length) return { rows: [], headers: [] };

  const headers = nonBlank[0].map(h => String(h).trim());
  const records = nonBlank.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return obj;
  });
  return { rows: records, headers };
}

// ---------- header normalization ----------
function normHeader(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a map from each parsed header → schema field key (or null if unknown).
function mapHeaders(headers, schema) {
  const syn = new Map();
  schema.fields.forEach(f => {
    (f.synonyms || []).concat([f.key, f.label]).forEach(s => {
      syn.set(normHeader(s), f.key);
    });
  });
  const map = {};
  const unknown = [];
  headers.forEach(h => {
    const n = normHeader(h);
    if (!n) return;
    const key = syn.get(n);
    if (key) map[h] = key;
    else unknown.push(h);
  });
  return { map, unknown };
}

// ---------- value coercion + validation ----------
function coerceValue(rawIn, field, ctx) {
  const errors = [];
  const warnings = [];
  const raw = rawIn == null ? '' : String(rawIn).trim();

  if (raw === '') {
    if (field.required) errors.push(`${field.label || field.key} is required`);
    return { value: field.default !== undefined ? field.default : null, errors, warnings };
  }

  switch (field.type) {
    case 'string': {
      return { value: raw, errors, warnings };
    }
    case 'enum': {
      const v = raw.toLowerCase();
      // Soft-match: accept the visible value or any synonym defined per-enum.
      const match = field.values.find(opt => opt === v || (field.valueSynonyms && field.valueSynonyms[opt] && field.valueSynonyms[opt].includes(v)));
      if (!match) {
        errors.push(`${field.label} "${raw}" not recognised. Use one of: ${field.values.join(', ')}`);
        return { value: null, errors, warnings };
      }
      return { value: match, errors, warnings };
    }
    case 'intRange': {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        errors.push(`${field.label} must be a whole number (got "${raw}")`);
        return { value: null, errors, warnings };
      }
      if (field.min !== undefined && n < field.min) errors.push(`${field.label} must be ≥ ${field.min}`);
      if (field.max !== undefined && n > field.max) errors.push(`${field.label} must be ≤ ${field.max}`);
      return { value: n, errors, warnings };
    }
    case 'methodologyScale': {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        errors.push(`${field.label} must be a whole number (got "${raw}")`);
        return { value: null, errors, warnings };
      }
      const scale = ctx && ctx.methodology ? ctx.methodology[field.scale + '_scale'] : null;
      if (scale) {
        const allowed = scale.map(s => s.value);
        if (!allowed.includes(n)) {
          errors.push(`${field.label} ${n} is outside the active methodology scale (${allowed[0]}–${allowed[allowed.length - 1]})`);
          return { value: null, errors, warnings };
        }
      }
      return { value: n, errors, warnings };
    }
    case 'assetRef': {
      // Resolve asset name (case-insensitive) against existing workspace assets.
      if (!ctx || !ctx.assetsByName) return { value: null, errors, warnings };
      const found = ctx.assetsByName.get(raw.toLowerCase());
      if (!found) {
        warnings.push(`Asset "${raw}" not found in this workspace - risk will be created without an asset link`);
        return { value: null, errors, warnings };
      }
      return { value: found.id, label: found.name, errors, warnings };
    }
    default:
      return { value: raw, errors, warnings };
  }
}

// ---------- schemas ----------
const ASSET_SCHEMA = {
  key: 'asset',
  singular: 'asset',
  plural: 'assets',
  fields: [
    { key: 'name', label: 'Name', required: true, type: 'string',
      synonyms: ['name', 'asset name', 'asset', 'title'] },
    { key: 'type', label: 'Type', type: 'enum',
      values: ['information', 'hardware', 'software', 'service', 'people', 'intangible'],
      valueSynonyms: { people: ['person', 'staff'], intangible: ['reputation', 'brand'] },
      synonyms: ['type', 'asset type', 'category'] },
    { key: 'classification', label: 'Classification', type: 'enum',
      values: ['public', 'internal', 'confidential', 'restricted'],
      valueSynonyms: { restricted: ['secret', 'top secret'] },
      synonyms: ['classification', 'class', 'sensitivity'] },
    { key: 'owner_name', label: 'Owner', type: 'string',
      synonyms: ['owner', 'owner name', 'asset owner', 'responsible'] },
    { key: 'cia_c', label: 'Confidentiality', type: 'intRange', min: 1, max: 3, default: 2,
      synonyms: ['confidentiality', 'c', 'cia c', 'conf'] },
    { key: 'cia_i', label: 'Integrity', type: 'intRange', min: 1, max: 3, default: 2,
      synonyms: ['integrity', 'i', 'cia i', 'int'] },
    { key: 'cia_a', label: 'Availability', type: 'intRange', min: 1, max: 3, default: 2,
      synonyms: ['availability', 'a', 'cia a', 'avail'] },
    { key: 'description', label: 'Description', type: 'string',
      synonyms: ['description', 'notes', 'detail'] },
    { key: 'business_criticality', label: 'Business criticality', type: 'enum',
      values: ['low', 'medium', 'high', 'critical'],
      synonyms: ['business criticality', 'criticality', 'bia level'] },
    { key: 'rto_hours', label: 'RTO (hours)', type: 'intRange', min: 0, max: 99999,
      synonyms: ['rto', 'rto hours', 'recovery time objective'] },
    { key: 'rpo_hours', label: 'RPO (hours)', type: 'intRange', min: 0, max: 99999,
      synonyms: ['rpo', 'rpo hours', 'recovery point objective'] },
    { key: 'bia_notes', label: 'BIA notes', type: 'string',
      synonyms: ['bia notes', 'impact notes'] }
  ],
  exampleRows: [
    {
      name: 'Customer CRM database',
      type: 'information',
      classification: 'confidential',
      owner_name: 'Head of Sales',
      cia_c: 3, cia_i: 3, cia_a: 2,
      description: 'Production CRM holding customer PII and contract data',
      business_criticality: 'high',
      rto_hours: 4, rpo_hours: 1,
      bia_notes: 'Sales pipeline blocked if down >4h'
    },
    {
      name: 'Office Wi-Fi network',
      type: 'service',
      classification: 'internal',
      owner_name: 'IT Manager',
      cia_c: 2, cia_i: 2, cia_a: 2,
      description: 'Corporate Wi-Fi for staff and BYOD',
      business_criticality: 'medium',
      rto_hours: 8, rpo_hours: '',
      bia_notes: ''
    }
  ]
};

const RISK_SCHEMA = {
  key: 'risk',
  singular: 'risk',
  plural: 'risks',
  fields: [
    { key: 'title', label: 'Title', required: true, type: 'string',
      synonyms: ['title', 'risk title', 'risk', 'name'] },
    { key: 'description', label: 'Description', type: 'string',
      synonyms: ['description', 'notes', 'detail'] },
    { key: 'asset', label: 'Asset', type: 'assetRef',
      synonyms: ['asset', 'asset name', 'related asset', 'linked asset'] },
    { key: 'threat', label: 'Threat', type: 'string',
      synonyms: ['threat', 'threat source'] },
    { key: 'vulnerability', label: 'Vulnerability', type: 'string',
      synonyms: ['vulnerability', 'vuln', 'weakness'] },
    { key: 'likelihood', label: 'Likelihood', type: 'methodologyScale', scale: 'likelihood',
      synonyms: ['likelihood', 'l', 'probability'] },
    { key: 'impact', label: 'Impact', type: 'methodologyScale', scale: 'impact',
      synonyms: ['impact', 'i', 'consequence'] },
    { key: 'treatment', label: 'Treatment', type: 'enum',
      values: ['modify', 'retain', 'avoid', 'share'],
      valueSynonyms: { modify: ['mitigate', 'reduce'], retain: ['accept'], share: ['transfer'] },
      default: 'modify',
      synonyms: ['treatment', 'response', 'risk response'] },
    { key: 'owner_name', label: 'Owner', type: 'string',
      synonyms: ['owner', 'owner name', 'risk owner', 'responsible'] }
  ],
  exampleRows: [
    {
      title: 'Customer PII leaked via stolen credentials',
      description: 'Attacker obtains valid SSO credentials and downloads customer records',
      asset: 'Customer CRM database',
      threat: 'Credential theft (phishing, leaked password)',
      vulnerability: 'No phishing-resistant MFA on customer-facing admin panel',
      likelihood: 3,
      impact: 4,
      treatment: 'modify',
      owner_name: 'CISO'
    },
    {
      title: 'Office network outage halts on-site operations',
      description: 'Wi-Fi access point failure isolates staff from cloud services',
      asset: 'Office Wi-Fi network',
      threat: 'Hardware failure / ISP outage',
      vulnerability: 'Single uplink, no LTE failover',
      likelihood: 2,
      impact: 2,
      treatment: 'modify',
      owner_name: 'IT Manager'
    }
  ]
};

// ---------- pipeline ----------
function processFile(text, schema, ctx) {
  const { rows, headers } = parseCSV(text);
  const headerErrors = [];
  if (!headers.length) {
    return {
      headers: [], headerMap: {}, unknownHeaders: [], headerErrors: ['File appears empty - no header row found.'],
      rows: [], summary: { total: 0, valid: 0, invalid: 0, withWarnings: 0 }
    };
  }
  const { map: headerMap, unknown: unknownHeaders } = mapHeaders(headers, schema);
  // Ensure every required field has *some* header pointed at it.
  const mappedKeys = new Set(Object.values(headerMap));
  schema.fields.forEach(f => {
    if (f.required && !mappedKeys.has(f.key)) {
      headerErrors.push(`Missing required column "${f.label}". Accepted header names: ${[f.label, ...(f.synonyms || [])].slice(0, 4).join(', ')}`);
    }
  });

  const processed = rows.map((row, idx) => {
    const parsed = {};
    const errors = [];
    const warnings = [];
    schema.fields.forEach(field => {
      // Find a header that maps to this field key. If multiple, prefer the first.
      const matchingHeader = Object.keys(headerMap).find(h => headerMap[h] === field.key);
      const raw = matchingHeader ? row[matchingHeader] : '';
      const { value, label, errors: fErr, warnings: fWarn } = coerceValue(raw, field, ctx);
      parsed[field.key] = value;
      if (label) parsed[field.key + '_label'] = label;
      fErr.forEach(e => errors.push(e));
      fWarn.forEach(w => warnings.push(w));
    });
    return {
      index: idx + 2, // +1 for 0-base, +1 for header row → CSV-line number users see in Excel
      raw: row,
      parsed,
      errors,
      warnings,
      valid: errors.length === 0
    };
  });

  const summary = {
    total: processed.length,
    valid: processed.filter(r => r.valid).length,
    invalid: processed.filter(r => !r.valid).length,
    withWarnings: processed.filter(r => r.valid && r.warnings.length).length
  };

  return { headers, headerMap, unknownHeaders, headerErrors, rows: processed, summary };
}

// ---------- template generator ----------
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildTemplate(schema) {
  const headers = schema.fields.map(f => f.label);
  const lines = [headers.map(csvCell).join(',')];
  (schema.exampleRows || []).forEach(ex => {
    lines.push(schema.fields.map(f => csvCell(ex[f.key])).join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  parseCSV,
  mapHeaders,
  processFile,
  buildTemplate,
  ASSET_SCHEMA,
  RISK_SCHEMA
};
