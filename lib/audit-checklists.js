'use strict';
// Internal audit checklists, for every framework with a management system and
// an Annex A control set. An ISO 42001 internal audit is generated from the
// ISO 42001 Statement of Applicability and its own sections, just as an ISO
// 27001 audit is from its own; a client working to both gets both.
//
// Checklist items are audit_observations rows naming a requirement in
// iso_item_id (see lib/requirement-options for why that column can hold any
// framework's requirement).

const reqOpts = require('./requirement-options');
const docLinks = require('./doc-links');
const evReads = require('./evidence-reads');

const CATALOGUE = Object.freeze({ iso27001: 'iso_items', iso42001: 'iso42001_items' });
// Each framework's control-state view (lib/control-reads tables()).
const STATES = Object.freeze({ iso27001: 'v_control_states', iso42001: 'v_iso42001_control_states' });

// Sections of each catalogue a checklist can be generated for. The keys are
// the catalogue's own category values; 'clauses' is the management-system
// clauses 4 to 10.
const SECTIONS = Object.freeze({
  iso27001: [
    ['org', 'A.5 Organisational controls'],
    ['people', 'A.6 People controls'],
    ['physical', 'A.7 Physical controls'],
    ['tech', 'A.8 Technological controls'],
    ['clauses', 'Clauses 4 to 10'],
  ],
  iso42001: [
    ['a-policies', 'A.2 AI policies'],
    ['b-internal-organization', 'A.3 Internal organisation'],
    ['c-resources', 'A.4 Resources for AI systems'],
    ['d-impact-assessment', 'A.5 Impact assessment'],
    ['e-lifecycle', 'A.6 AI system life cycle'],
    ['f-data', 'A.7 Data for AI systems'],
    ['g-information', 'A.8 Information for interested parties'],
    ['h-use', 'A.9 Use of AI systems'],
    ['i-third-party', 'A.10 Third parties and customers'],
    ['clauses', 'Clauses 4 to 10'],
  ],
});

// Sample-size hints the auditor pastes into an observation. Practice norms,
// not requirements of either standard.
const SAMPLE_HINTS = Object.freeze({
  // ISO 27001
  'annex-a.5.15': 'Sample 10 users (mix of joiner / mover / leaver).',
  'annex-a.5.16': 'Sample 10 user accounts created in the last 6 months.',
  'annex-a.5.17': 'Sample 5 authentication records (MFA enrolment, password reset).',
  'annex-a.5.18': 'Sample 10 access rights changes; verify approval evidence.',
  'annex-a.8.2': 'Sample 5 privileged-access requests; verify approval + revocation.',
  'annex-a.8.3': 'Sample 5 systems for least-privilege configuration.',
  'annex-a.8.5': 'Sample 5 admin authentications; verify phishing-resistant MFA.',
  'annex-a.8.15': 'Sample 10 consecutive days of logs; verify retention.',
  'annex-a.8.16': 'Sample 3 alert investigations from the last 90 days.',
  'annex-a.8.13': 'Sample 3 restore tests; verify RTO/RPO met.',
  'annex-a.5.29': 'Sample 1 BCP test conducted in the last 12 months.',
  'annex-a.5.30': 'Sample evidence of ICT readiness for BC.',
  'annex-a.5.19': 'Sample 5 active suppliers; verify security clauses + review records.',
  'annex-a.5.20': 'Sample 5 supplier contracts.',
  'annex-a.5.21': 'Sample 5 ICT supply-chain risk assessments.',
  'annex-a.5.22': 'Sample 5 supplier reviews from the last 12 months.',
  'annex-a.5.24': 'Verify incident response procedure exists + has been exercised.',
  'annex-a.5.25': 'Sample 5 incidents from the last 12 months.',
  'annex-a.5.26': 'Sample 5 incident responses; verify lessons-learned captured.',
  'annex-a.5.27': 'Sample 3 post-incident reviews.',
  'annex-a.6.3': 'Sample 5 training completion records.',
  // ISO 42001
  'ai-annex-a-3-3': 'Sample 3 concerns raised in the period, or test the reporting channel end to end.',
  'ai-annex-a-4-2': 'Sample 3 in-scope AI systems; check each has its data, tooling, compute and people resources recorded.',
  'ai-annex-a-5-2': 'Sample 3 AI systems; check each had an impact assessment before go-live or significant change.',
  'ai-annex-a-5-3': 'Sample 3 approved impact assessments; check approval, version and retention.',
  'ai-annex-a-5-4': 'Sample 3 impact assessments; check affected individuals and groups are named with the harms and mitigations.',
  'ai-annex-a-5-5': 'Sample 2 impact assessments; check wider societal effects were considered, or why they do not arise.',
  'ai-annex-a-6-2-4': 'Sample 3 releases; check verification and validation results and the acceptance decision.',
  'ai-annex-a-6-2-5': 'Sample 3 deployments; check the release approval and the deployment plan.',
  'ai-annex-a-6-2-6': 'Sample 2 AI systems in operation; check monitoring results, thresholds and follow-up of alerts.',
  'ai-annex-a-6-2-8': 'Sample 2 AI systems; check event logs are kept as specified and can be retrieved.',
  'ai-annex-a-7-3': 'Sample 3 datasets; check how each was acquired and on what terms.',
  'ai-annex-a-7-4': 'Sample 3 datasets; check the quality criteria and the results of quality checks.',
  'ai-annex-a-7-5': 'Sample 3 datasets; check provenance is recorded from source to use.',
  'ai-annex-a-8-4': 'Sample 2 AI incidents; check who was told, when, and whether the plan was followed.',
  'ai-annex-a-9-4': 'Sample 3 AI systems; check intended use is documented and uses outside it are prevented or detected.',
  'ai-annex-a-10-3': 'Sample 3 AI suppliers; check responsibilities, assessments and review records.',
  _default: 'Sample 3 to 5 records or 1 process walkthrough.',
});

function sampleHintFor(id) {
  return SAMPLE_HINTS[id] || SAMPLE_HINTS._default;
}

// The frameworks this workspace can generate internal audit checklists for,
// each with its sections, for the audit page.
function sources(workspace) {
  return reqOpts.enabledCodes(workspace)
    .filter((code) => CATALOGUE[code])
    .map((code) => ({
      framework: code,
      label: reqOpts.label(code),
      sections: SECTIONS[code].map(([key, name]) => ({ value: `${code}:${key}`, label: name })),
    }));
}

// A section value from the form: 'iso42001:e-lifecycle'. A bare category is
// an ISO 27001 section, as the form sent before other frameworks were offered.
function parseSection(workspace, value) {
  const raw = String(value || '');
  const [framework, category] = raw.includes(':') ? raw.split(':', 2) : ['iso27001', raw];
  if (!sources(workspace).some((s) => s.framework === framework)) return null;
  if (!SECTIONS[framework].some(([key]) => key === category)) return null;
  return { framework, category };
}

function sectionItems(db, { framework, category }) {
  const table = CATALOGUE[framework];
  return category === 'clauses'
    ? db.prepare(`SELECT id, title FROM ${table} WHERE type='clause' ORDER BY sort_order`).all()
    : db.prepare(`SELECT id, title FROM ${table} WHERE type='control' AND category=? ORDER BY sort_order`).all(category);
}

// Controls included on each of the workspace's SoAs, with the number of
// linked documents and evidence files for each.
function includedControls(db, workspace) {
  const rows = [];
  for (const { framework } of sources(workspace)) {
    rows.push(...db.prepare(`SELECT i.id, i.title, i.category, cs.status, ? AS framework,
        ${docLinks.docCountSubquery(framework)} AS doc_count,
        ${evReads.checklistEvidenceCountSubquery(framework)} AS evi_count
      FROM ${CATALOGUE[framework]} i
      INNER JOIN ${STATES[framework]} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type='control' AND cs.applicability='included'
      ORDER BY i.sort_order`).all(framework, workspace.id, workspace.id, workspace.id));
  }
  return rows;
}

// The reference and plain title of a catalogue row: 'A.6.2.4' and
// 'AI system verification and validation'.
function split(row) {
  const code = reqOpts.codeOf(row);
  const title = String(row.title || '').replace(/^(?:Clause\s+)?(?:A\.)?[0-9.]+\s+/, '');
  return { code, title };
}

function prefix(workspace, framework) {
  return reqOpts.enabledCodes(workspace).length > 1 ? `${reqOpts.label(framework)} ` : '';
}

function soaItemText(workspace, row) {
  const { code, title } = split(row);
  return `${prefix(workspace, row.framework)}${code} - ${title}\n\n`
    + 'Test: (1) Is there a documented procedure? (2) Is it operating in practice - sample evidence below. (3) Has it been reviewed in the last 12 months?\n\n'
    + `Linked policies: ${row.doc_count} - Linked evidence: ${row.evi_count}\n`
    + `Sample size suggestion: ${sampleHintFor(row.id)}\n\n`
    + 'Finding template: [Conformance / Observation / Minor NC / Major NC] - [describe what was tested, what was seen, root cause if NC, evidence references]';
}

function sectionItemText(workspace, framework, row) {
  const { code, title } = split(row);
  return `${prefix(workspace, framework)}${code} - ${title}: Is there a documented process? Is it operating in practice (sample evidence)? Has it been reviewed in the last 12 months?`;
}

module.exports = { CATALOGUE, SECTIONS, sources, parseSection, sectionItems, includedControls, soaItemText, sectionItemText, sampleHintFor };
