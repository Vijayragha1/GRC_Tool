// Content provenance and review cadence.
//
// Tracks when each content source was last reviewed against the standard /
// guidance it claims to cover, so an operator can spot stale content before
// an auditor does. Use `npm run content-staleness` (scripts/content-staleness.js)
// to print a report.
//
// Per-entry overrides: any entry in iso-content.js / iso42001-content.js can
// carry its own `last_reviewed` / `reviewed_against` fields and the staleness
// script will honour those over the file-level defaults.
//
// Review cadence:
//   - Set `last_reviewed` when the content was last manually walked against
//     the cited standard or guidance.
//   - Set `next_review_due` to the date you next plan to walk it. Default
//     interval is 12 months unless a standard / amendment cycle suggests
//     otherwise.
//   - Set `reviewed_against` to specific identifiers (versions, amendments,
//     IAF guidance, accreditation body technical notes) - not generic strings.

module.exports = {
  'iso-content.js': {
    description: 'Audit-grade content for ISO/IEC 27001:2022 clauses 4-10 + Annex A controls',
    last_reviewed: '2026-05-15',
    reviewed_against: [
      'ISO/IEC 27001:2022',
      'ISO/IEC 27001:2022/Amd 1:2024 (climate change)',
      'ISO/IEC 27002:2022 (implementation guidance)'
    ],
    next_review_due: '2027-05-15',
    notes: 'Climate change amendment (Amd 1:2024) reflected in clauses 4.1 and 4.2. Re-check after any IAF MD update on transitioning organisations or new technical notes from accreditation bodies (UKAS, ANAB, DAkkS).'
  },

  'iso42001-content.js': {
    description: 'Audit-grade content for ISO/IEC 42001:2023 clauses 4-10 + Annex A controls (AI management system)',
    last_reviewed: '2026-05-15',
    reviewed_against: [
      'ISO/IEC 42001:2023',
      'ISO/IEC 23894:2023 (AI risk management guidance)',
      'EU AI Act (Reg. (EU) 2024/1689)',
      'NIST AI RMF 1.0 (Jan 2023)'
    ],
    next_review_due: '2027-02-15',
    notes: 'EU AI Act enforcement dates roll through 2025-2027; expect interpretation guidance from EU AI Office. Re-check earlier if AI Office publishes high-risk system criteria updates.'
  },

  'iso-catalog.js': {
    description: 'ISO 27001:2022 clauses + Annex A control list (the catalog layer feeding controls + SoA + gap wizard)',
    last_reviewed: '2026-05-15',
    reviewed_against: [
      'ISO/IEC 27001:2022 Annex A (93 controls)',
      'ISO/IEC 27001:2022 Clauses 4-10'
    ],
    next_review_due: '2027-05-15',
    notes: 'Structural changes to Annex A are rare. Re-check on next ISO 27001 revision (no scheduled date as of 2026-05).'
  },

  'iso42001-catalog.js': {
    description: 'ISO/IEC 42001:2023 clauses + Annex A control list',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 42001:2023'],
    next_review_due: '2027-02-15',
    notes: 'First edition of the standard. Any errata or amendments will trigger re-review.'
  },

  'risk-library.js': {
    description: 'Starter risk catalogue covering ISO 27001 + AI/ML + supply chain + cloud + regulatory change',
    last_reviewed: '2026-05-25',
    reviewed_against: [
      'ISO/IEC 27001:2022 Annex A control mappings',
      'EU AI Act (Reg. (EU) 2024/1689)',
      'DORA (Reg. (EU) 2022/2554)',
      'NIS2 (Dir. (EU) 2022/2555)',
      'India DPDP Act 2023'
    ],
    next_review_due: '2026-11-25',
    notes: 'Regulatory-change domain is the fastest-decaying section. Re-check every 6 months minimum. Add new entries on each new applicable regulation or major incident pattern (e.g., new SolarWinds-class supply-chain event).'
  },

  'data/nist-csf.js': {
    description: 'NIST CSF 2.0 catalog (6 functions / 22 categories / 106 subcategories)',
    last_reviewed: '2026-05-15',
    reviewed_against: ['NIST CSF 2.0 (Feb 2024 - NIST.CSWP.29)'],
    next_review_due: '2028-02-15',
    notes: 'NIST CSF revisions take 5+ years. Default cadence: re-check annually for OLIR informative-reference updates, full re-check on a new CSF version.'
  },

  'policy-templates-organisational.js': {
    description: 'ISO 27001 Annex A.5 organisational control policy templates',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 Annex A.5', 'ISO/IEC 27002:2022 §5'],
    next_review_due: '2027-05-15'
  },
  'policy-templates-people-physical.js': {
    description: 'ISO 27001 Annex A.6 (people) + A.7 (physical) policy templates',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 Annex A.6 and A.7', 'ISO/IEC 27002:2022 §6 and §7'],
    next_review_due: '2027-05-15'
  },
  'policy-templates-technical.js': {
    description: 'ISO 27001 Annex A.8 technological control policy templates',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 Annex A.8', 'ISO/IEC 27002:2022 §8'],
    next_review_due: '2027-05-15',
    notes: 'Technical controls drift fastest with vendor and threat-landscape changes. PAM, endpoint, and crypto templates need re-review when major control updates ship (e.g., new authenticator-assurance levels, post-quantum guidance).'
  },
  'policy-templates-forms-roles.js': {
    description: 'Forms and role-description templates used across the ISMS',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 documented-information requirements'],
    next_review_due: '2027-05-15'
  },
  'policy-templates-bundles.js': {
    description: 'Bundle definitions: which templates ship together as a starter pack',
    last_reviewed: '2026-05-15',
    reviewed_against: ['ISO/IEC 27001:2022 mandatory documented information'],
    next_review_due: '2027-05-15'
  }
};
