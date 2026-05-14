// Word report + CSV generator for the NIST CSF module (Stage 8).
//
// The Word doc is generated from scratch with the `docx` package - no tenant
// template upload yet. Lead opens the generated file, edits the placeholder
// narratives manually, and the edited Word becomes the deliverable master.
// PDF is intentionally deferred to a later stage.
//
// Snapshot-aware: when called with a `versionRollup`, the doc reflects that
// frozen version. Otherwise it builds from live engagement data and stamps a
// DRAFT watermark in the header.

const {
  Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, PageBreak,
} = require('docx');

const csfScoring = require('./csf-scoring');
const csfVersioning = require('./csf-versioning');

const TIER_NAMES = { 1: 'Partial', 2: 'Risk Informed', 3: 'Repeatable', 4: 'Adaptive' };

function P(text, opts = {}) {
  const runs = Array.isArray(text) ? text : [new TextRun({ text: String(text), ...opts })];
  return new Paragraph({ children: runs, ...opts });
}
function H(text, level) { return new Paragraph({ text: String(text), heading: level }); }
function TR(cells) { return new TableRow({ children: cells }); }
function TC(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: String(text ?? ''), bold: !!opts.bold, color: opts.color })],
      alignment: opts.right ? AlignmentType.RIGHT : undefined,
    })],
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.shade ? { fill: opts.shade } : undefined,
  });
}

// Build the report. Returns a Buffer.
async function buildWordReport({ db, engagement, ws, firm, currentRollup, isDraft, versionRow }) {
  const r1 = csfScoring.r1;
  const tier = currentRollup.overall.tier;
  const today = new Date().toISOString().slice(0, 10);

  // Live data when isDraft, snapshot data when versionRow provided.
  const findings = versionRow
    ? db.prepare(`SELECT * FROM csf_finding_snapshots WHERE version_id=? ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END`).all(versionRow.id)
    : db.prepare(`SELECT f.*, NULL AS subcategory_id_from_snap, a.subcategory_id AS subcategory_id
        FROM csf_findings f LEFT JOIN csf_subcategory_assessments a ON a.id = f.assessment_id
        WHERE f.engagement_id=? AND f.deleted_at IS NULL
        ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END`).all(engagement.id);

  const recs = versionRow
    ? db.prepare(`SELECT r.*, f.title AS finding_title, f.severity FROM csf_recommendation_snapshots r INNER JOIN csf_finding_snapshots f ON f.finding_id = r.finding_id AND f.version_id = r.version_id WHERE r.version_id=?`).all(versionRow.id)
    : db.prepare(`SELECT r.*, f.title AS finding_title, f.severity FROM csf_recommendations r INNER JOIN csf_findings f ON f.id = r.finding_id WHERE f.engagement_id=? AND r.deleted_at IS NULL AND f.deleted_at IS NULL`).all(engagement.id);

  const versions = db.prepare(`SELECT version_number, published_at, change_summary FROM csf_engagement_versions WHERE engagement_id=? ORDER BY published_at DESC`).all(engagement.id);

  const children = [];

  // ---- Cover ----
  children.push(new Paragraph({ children: [new TextRun({ text: firm?.name || 'MSSP', bold: true, size: 28 })] }));
  children.push(P(ws.client_name || 'Client'));
  if (isDraft) {
    children.push(P([new TextRun({ text: 'DRAFT - not for distribution', bold: true, color: 'B91C1C' })]));
  }
  children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
  children.push(H('NIST Cybersecurity Framework 2.0', HeadingLevel.TITLE));
  children.push(H('Maturity Assessment Report', HeadingLevel.HEADING_2));
  children.push(P([
    new TextRun({ text: `Engagement: `, bold: true }), new TextRun({ text: engagement.name }),
  ]));
  children.push(P([
    new TextRun({ text: `Version: `, bold: true }),
    new TextRun({ text: versionRow ? `v${versionRow.version_number} (published ${versionRow.published_at})` : `DRAFT (live data, generated ${today})` }),
  ]));
  children.push(P([
    new TextRun({ text: `Catalog: `, bold: true }),
    new TextRun({ text: `NIST CSF 2.0 (NIST.CSWP.29)` }),
  ]));
  children.push(P([
    new TextRun({ text: `Scope mode: `, bold: true }),
    new TextRun({ text: engagement.scope_mode === 'CURRENT_TARGET' ? 'Current + Target Profiles' : 'Current Profile only' }),
  ]));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ---- Document control ----
  children.push(H('Document control', HeadingLevel.HEADING_1));
  if (versions.length === 0) {
    children.push(P('This engagement has not yet been published. Document control will list every version once published.'));
  } else {
    children.push(new Table({
      rows: [
        TR([TC('Version', { bold: true, shade: 'F4F4F5' }), TC('Published', { bold: true, shade: 'F4F4F5' }), TC('Change summary', { bold: true, shade: 'F4F4F5' })]),
        ...versions.map(v => TR([TC(`v${v.version_number}`), TC(v.published_at), TC(v.change_summary || '-')])),
      ],
      width: { size: 100, type: WidthType.PERCENTAGE },
    }));
  }

  // ---- Executive summary ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(H('Executive summary', HeadingLevel.HEADING_1));
  children.push(P([
    new TextRun({ text: 'Overall maturity: ', bold: true }),
    new TextRun({ text: tier ? tier.label : '(not yet computable)' }),
  ]));
  children.push(P([
    new TextRun({ text: 'Coverage: ', bold: true }),
    new TextRun({ text: `${currentRollup.coverage.scored} of ${currentRollup.coverage.total - currentRollup.coverage.excluded} in-scope subcategories scored (${currentRollup.coverage.scoredPct}%).` }),
  ]));
  children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));

  children.push(H('Maturity by Function', HeadingLevel.HEADING_2));
  children.push(new Table({
    rows: [
      TR([TC('Function', { bold: true, shade: 'F4F4F5' }), TC('Tier', { bold: true, shade: 'F4F4F5' }), TC('Score', { bold: true, shade: 'F4F4F5', right: true })]),
      ...currentRollup.functions.map(fn => TR([
        TC(`${fn.code} - ${fn.name}`),
        TC(fn.tier ? `Tier ${fn.tier.tier} - ${fn.tier.name}` : '-'),
        TC(fn.current == null ? '-' : r1(fn.current), { right: true }),
      ])),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
  }));

  // Top 5 findings
  const topFindings = findings.slice(0, 5);
  children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
  children.push(H(`Top ${topFindings.length} findings`, HeadingLevel.HEADING_2));
  if (topFindings.length === 0) {
    children.push(P('No findings recorded.'));
  } else {
    topFindings.forEach(f => {
      children.push(P([
        new TextRun({ text: `[${f.severity}] `, bold: true, color: f.severity === 'CRITICAL' ? 'B91C1C' : f.severity === 'HIGH' ? 'DC2626' : f.severity === 'MEDIUM' ? 'A16207' : '6B7280' }),
        new TextRun({ text: f.title }),
      ]));
      if (f.description) children.push(P(f.description));
    });
  }

  // Top 5 recs by priority
  const topRecs = recs.filter(r => r.priority === 'HIGH').slice(0, 5);
  children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
  children.push(H(`Top ${topRecs.length} recommendations (HIGH priority)`, HeadingLevel.HEADING_2));
  if (topRecs.length === 0) {
    children.push(P('No HIGH-priority recommendations recorded.'));
  } else {
    topRecs.forEach(r => {
      children.push(P([
        new TextRun({ text: `[${r.estimated_effort || '-'}] `, bold: true }),
        new TextRun({ text: r.description }),
      ]));
      if (r.finding_title) children.push(P([new TextRun({ text: `Linked finding: ${r.finding_title}`, italics: true, color: '6B7280' })]));
    });
  }

  // ---- Assessment approach (placeholder) ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(H('Assessment approach', HeadingLevel.HEADING_1));
  children.push(P('[Lead: describe scope, methodology, interviews conducted, document review performed, and any limitations. This section is intentionally a placeholder in the auto-generated draft; replace with your firm\'s standard approach text.]'));

  // ---- Per-Function detail ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(H('Maturity results by Function', HeadingLevel.HEADING_1));
  currentRollup.functions.forEach(fn => {
    children.push(H(`${fn.code} - ${fn.name}`, HeadingLevel.HEADING_2));
    children.push(P([
      new TextRun({ text: 'Tier: ', bold: true }),
      new TextRun({ text: fn.tier ? fn.tier.label : '-' }),
    ]));
    if (engagement.scope_mode === 'CURRENT_TARGET' && fn.target != null) {
      children.push(P([
        new TextRun({ text: 'Target tier: ', bold: true }),
        new TextRun({ text: fn.tier_target ? fn.tier_target.label : '-' }),
        new TextRun({ text: `   |   Gap: ${fn.gap == null ? '-' : (fn.gap > 0 ? '+' : '') + r1(fn.gap)}` }),
      ]));
    }

    children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
    const catRows = [
      TR([
        TC('Category', { bold: true, shade: 'F4F4F5' }),
        TC('Current', { bold: true, shade: 'F4F4F5', right: true }),
        ...(engagement.scope_mode === 'CURRENT_TARGET' ? [
          TC('Target', { bold: true, shade: 'F4F4F5', right: true }),
          TC('Gap', { bold: true, shade: 'F4F4F5', right: true }),
        ] : []),
        TC('Subs scored', { bold: true, shade: 'F4F4F5', right: true }),
      ]),
      ...fn.categories.map(cat => {
        const scored = cat.subcategories.filter(s => !s.excluded && s.current != null).length;
        const inscope = cat.subcategories.filter(s => !s.excluded).length;
        return TR([
          TC(`${cat.code} - ${cat.name}`),
          TC(cat.current == null ? '-' : r1(cat.current), { right: true }),
          ...(engagement.scope_mode === 'CURRENT_TARGET' ? [
            TC(cat.target == null ? '-' : r1(cat.target), { right: true }),
            TC(cat.gap == null ? '-' : (cat.gap > 0 ? '+' : '') + r1(cat.gap), { right: true }),
          ] : []),
          TC(`${scored}/${inscope}`, { right: true }),
        ]);
      }),
    ];
    children.push(new Table({ rows: catRows, width: { size: 100, type: WidthType.PERCENTAGE } }));

    children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
    children.push(P([new TextRun({ text: 'Narrative: ', bold: true }), new TextRun({ text: '[Lead: write Function-level narrative here. What did the assessment show? Where are the strongest practices, and where are the weakest? Cite specific Categories or Subcategories where useful.]', italics: true })]));
  });

  // ---- Findings register ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(H('Findings register', HeadingLevel.HEADING_1));
  if (findings.length === 0) {
    children.push(P('No findings recorded.'));
  } else {
    children.push(new Table({
      rows: [
        TR([
          TC('Severity', { bold: true, shade: 'F4F4F5' }),
          TC('Finding', { bold: true, shade: 'F4F4F5' }),
          TC('Subcategory', { bold: true, shade: 'F4F4F5' }),
        ]),
        ...findings.map(f => TR([
          TC(f.severity),
          TC(f.title + (f.description ? `\n${f.description.slice(0, 240)}` : '')),
          TC(f.subcategory_id ? '(see assessment)' : (f.promoted_to_engagement_theme ? 'engagement theme' : '-')),
        ])),
      ],
      width: { size: 100, type: WidthType.PERCENTAGE },
    }));
  }

  // ---- Recommendations roadmap ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(H('Recommendations roadmap', HeadingLevel.HEADING_1));
  const phases = [
    { key: '0_3M', label: '0-3 months' },
    { key: '3_6M', label: '3-6 months' },
    { key: '6_12M', label: '6-12 months' },
    { key: '12M_PLUS', label: '12 months and beyond' },
    { key: null, label: 'Unphased' },
  ];
  phases.forEach(ph => {
    const inPhase = recs.filter(r => (r.roadmap_phase || null) === ph.key);
    if (!inPhase.length) return;
    children.push(H(ph.label, HeadingLevel.HEADING_2));
    inPhase.forEach(r => {
      children.push(P([
        new TextRun({ text: `[${r.priority || '-'} / ${r.estimated_effort || '-'}] `, bold: true }),
        new TextRun({ text: r.description }),
      ]));
      if (r.target_completion_date) children.push(P([new TextRun({ text: `Target completion: ${r.target_completion_date}`, italics: true, color: '6B7280' })]));
      if (r.finding_title) children.push(P([new TextRun({ text: `Linked finding: ${r.finding_title}`, italics: true, color: '6B7280' })]));
    });
  });

  // ---- Appendices ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(H('Appendices', HeadingLevel.HEADING_1));
  children.push(H('A. Methodology', HeadingLevel.HEADING_2));
  children.push(P('Each Subcategory is scored on a CMMI 1-5 scale: 1 Initial / 2 Managed / 3 Defined / 4 Quantitatively Managed / 5 Optimising. Category scores are the weighted mean of their subcategory scores. Function scores are the equal-weighted mean of their Category scores. The Overall score is the mean of the six Function scores. The CSF Tier overlay maps the CMMI score: Tier 1 (Partial) 1.00-1.74, Tier 2 (Risk Informed) 1.75-2.74, Tier 3 (Repeatable) 2.75-3.74, Tier 4 (Adaptive) 3.75-5.00. Tier thresholds are tenant-configurable.'));
  children.push(H('B. CSF reference', HeadingLevel.HEADING_2));
  children.push(P('Functions, Categories, and Subcategories sourced from NIST.CSWP.29 (The NIST Cybersecurity Framework 2.0, published 2024-02-26). Implementation examples and informative references sourced from the NIST CSF 2.0 Reference Tool.'));

  // ---- Change log (v1.1+) ----
  if (versions.length > 1) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(H('C. Version change log', HeadingLevel.HEADING_2));
    versions.forEach(v => {
      children.push(P([new TextRun({ text: `v${v.version_number} `, bold: true }), new TextRun({ text: `(${v.published_at}): ` }), new TextRun({ text: v.change_summary || '-' })]));
    });
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// CSV export: one row per Subcategory with current state. Rollup math is
// visible per Section 7 (Excel sheet 5) - for the CSV we include the resolved
// weight, current score, target score, gap so the receiver can recompute the
// Category/Function rollups themselves.
function buildCsvExport({ db, engagement, currentRollup }) {
  const rows = [
    ['function_code', 'function_name', 'category_code', 'category_name', 'subcategory_code', 'subcategory_description',
     'status', 'current_score', 'target_score', 'gap', 'weight', 'excluded_from_scope', 'exclusion_rationale',
     'evidence_count', 'finding_count'],
  ];

  const counts = db.prepare(`
    SELECT a.subcategory_id, a.exclusion_rationale,
      (SELECT COUNT(*) FROM csf_evidence_items e WHERE e.assessment_id=a.id AND e.deleted_at IS NULL) AS evidence_count,
      (SELECT COUNT(*) FROM csf_findings f WHERE f.assessment_id=a.id AND f.deleted_at IS NULL) AS finding_count
    FROM csf_subcategory_assessments a WHERE a.engagement_id=?
  `).all(engagement.id);
  const counter = {};
  counts.forEach(c => { counter[c.subcategory_id] = c; });

  for (const fn of currentRollup.functions) {
    for (const cat of fn.categories) {
      for (const sub of cat.subcategories) {
        const c = counter[sub.id] || {};
        const gap = (sub.current != null && sub.target != null) ? (sub.target - sub.current) : '';
        rows.push([
          fn.code, fn.name, cat.code, cat.name, sub.code, sub.description,
          sub.status, sub.current ?? '', sub.target ?? '', gap, sub.weight,
          sub.excluded ? '1' : '0', c.exclusion_rationale || '',
          c.evidence_count || 0, c.finding_count || 0,
        ]);
      }
    }
  }
  return rows.map(r => r.map(v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

module.exports = {
  buildWordReport,
  buildCsvExport,
};
