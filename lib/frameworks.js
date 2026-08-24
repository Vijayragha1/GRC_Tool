'use strict';
// The single source of truth for which assessment programmes exist.
//
// Treated as a closed set so a malformed workspace.frameworks value can't
// introduce phantom nav groups. Every consumer that needs to enumerate the
// programmes - pickers, evidence cross-links, the integrated dashboard - reads
// this registry instead of re-typing the codes. That enumeration used to be
// hand-copied into six places, one of them inside SQL
// (lib/evidence-reads.js), where a missing code made a framework's evidence
// cross-links render as nothing with no error.
//
// Fields, and who consumes them:
//   label        formal name.               integrated dashboard, engagement plan
//   shortLabel   compact name.              nav, headings
//   tagLabel     inline count badge.        evidence library ("3 ISO 27001")
//   systemCode   management-system marker.  integrated dashboard programme card
//   descriptor   one line on what it is.    integrated dashboard programme card
//   pickerLabel  create-form option name.   dashboard quick-create, client setup
//   formalName   full standard designation. public site, controlled outputs.
//                Differs from pickerLabel: a picker wants 'ISO 27001:2022',
//                an external reader wants 'ISO/IEC 27001:2022'.
//   pickerNote   create-form option gloss.  dashboard quick-create, client setup
//   tagRgb       badge tint, "r,g,b", or    evidence library. null keeps the
//                null for the house default default .tag-info styling.
//   tagInk       badge text colour, or null evidence library
//   order        display order everywhere
//
// Adding a framework means adding one entry here plus its catalogue; it should
// not mean editing a view.
const FRAMEWORK_REGISTRY = Object.freeze({
  iso27001: Object.freeze({
    code: 'iso27001',
    label: 'ISO/IEC 27001:2022',
    shortLabel: 'ISO 27001',
    tagLabel: 'ISO 27001',
    systemCode: 'ISMS',
    descriptor: 'Information security management system',
    pickerLabel: 'ISO 27001:2022',
    formalName: 'ISO/IEC 27001:2022',
    pickerNote: 'Information security',
    tagRgb: null,
    tagInk: null,
    order: 1,
  }),
  iso42001: Object.freeze({
    code: 'iso42001',
    label: 'ISO/IEC 42001:2023',
    shortLabel: 'ISO 42001',
    tagLabel: 'ISO 42001',
    systemCode: 'AIMS',
    descriptor: 'Artificial intelligence management system',
    pickerLabel: 'ISO 42001:2023',
    formalName: 'ISO/IEC 42001:2023',
    pickerNote: 'AI management',
    tagRgb: '8,145,178',
    tagInk: '#0e7490',
    order: 2,
  }),
  csf: Object.freeze({
    code: 'csf',
    label: 'NIST Cybersecurity Framework 2.0',
    shortLabel: 'NIST CSF 2.0',
    tagLabel: 'CSF',
    systemCode: 'CSF',
    descriptor: 'Cybersecurity maturity assessment',
    pickerLabel: 'NIST CSF 2.0',
    formalName: 'NIST CSF 2.0',
    pickerNote: 'Cyber maturity',
    tagRgb: '71,85,105',
    tagInk: '#334155',
    order: 3,
  }),
  dpdpa: Object.freeze({
    code: 'dpdpa',
    label: 'India Digital Personal Data Protection Act 2023',
    shortLabel: 'DPDPA',
    tagLabel: 'DPDPA',
    systemCode: 'DPDPA',
    descriptor: 'Evidence-backed data protection gap assessment',
    pickerLabel: 'India DPDPA',
    formalName: 'India Digital Personal Data Protection Act 2023',
    pickerNote: 'Gap assessment',
    tagRgb: '124,58,237',
    tagInk: '#6d28d9',
    order: 4,
  }),
});

const ALLOWED_FRAMEWORKS = Object.freeze(Object.keys(FRAMEWORK_REGISTRY));
const LEGACY_DEFAULT_FRAMEWORKS = Object.freeze(['iso27001', 'iso42001', 'csf']);

// Registry entries in display order. Views iterate this rather than hardcoding
// a list of codes.
const FRAMEWORK_LIST = Object.freeze(
  ALLOWED_FRAMEWORKS
    .map(code => FRAMEWORK_REGISTRY[code])
    .sort((a, b) => a.order - b.order)
);

function frameworkMeta(code) {
  return FRAMEWORK_REGISTRY[code] || null;
}

// An object keyed by every framework code, each starting from a fresh value.
// Used wherever a per-framework bucket is built up, so a new framework gets its
// bucket automatically instead of arriving as `undefined` at a `.push`.
function byFramework(initial = () => []) {
  return Object.fromEntries(ALLOWED_FRAMEWORKS.map(code => [code, initial()]));
}

// Parse the workspace.frameworks JSON column into an Array. A stored empty
// array is intentional: clients can be created before a programme is chosen.
// Null or malformed legacy values retain the historical all-framework fallback.
function parseWorkspaceFrameworks(raw) {
  if (Array.isArray(raw)) return raw.filter(x => ALLOWED_FRAMEWORKS.includes(x));
  // DPDPA is opt-in. A null legacy value preserves the historical three
  // programmes, but must never silently enable a new legal assessment.
  if (!raw) return LEGACY_DEFAULT_FRAMEWORKS.slice();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return LEGACY_DEFAULT_FRAMEWORKS.slice();
    return arr.filter(x => ALLOWED_FRAMEWORKS.includes(x));
  } catch (_) { return LEGACY_DEFAULT_FRAMEWORKS.slice(); }
}

// Size of each framework's catalogue, read from the content modules rather
// than the database so a public page can state a number without touching
// tenant data. Returns 0 for anything unrecognised, and callers filter on that
// rather than printing a bare zero.
function catalogueSize(code) {
  try {
    switch (code) {
      case 'iso27001':
        return Object.keys(require('../data/iso-content.js')).length;
      case 'iso42001':
        return Object.keys(require('../data/iso42001-content.js')).length;
      case 'csf': {
        const { FUNCTIONS } = require('../data/nist-csf.js');
        return FUNCTIONS.reduce(
          (n, fn) => n + (fn.categories || []).reduce((m, c) => m + (c.subcategories || []).length, 0),
          0
        );
      }
      case 'dpdpa': {
        const cat = require('../data/dpdpa-catalog.js');
        const obligations = (cat.DPDPA_CATALOG || cat).obligations || [];
        return obligations.length;
      }
      default:
        return 0;
    }
  } catch {
    // A public page must not fail to render because a catalogue moved.
    return 0;
  }
}

module.exports = {
  catalogueSize,
  FRAMEWORK_REGISTRY,
  FRAMEWORK_LIST,
  ALLOWED_FRAMEWORKS,
  LEGACY_DEFAULT_FRAMEWORKS,
  frameworkMeta,
  byFramework,
  parseWorkspaceFrameworks,
};
