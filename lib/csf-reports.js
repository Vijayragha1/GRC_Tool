// Client-ready Word, PDF/HTML, and CSV generators for NIST CSF 2.0.
//
// The Word doc is generated from scratch with the `docx` package - no tenant
// Reports are generated only from governed engagement data; no placeholder
// narratives or inferred NIST Implementation Tiers are emitted.
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
  let profile = null;
  if (versionRow?.profile_context_json) { try { profile = JSON.parse(versionRow.profile_context_json); } catch (_) {} }
  if (!profile) profile = db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagement.id) || {};

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
    new TextRun({ text: 'Overall capability result: ', bold: true }),
    new TextRun({ text: currentRollup.overall.current == null ? 'Not concluded' : `${r1(currentRollup.overall.current)} / 5` }),
  ]));
  children.push(P([new TextRun({ text: 'Overall NIST Implementation Tier: ', bold: true }), new TextRun({ text: tier ? tier.label : 'Not concluded' })]));
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

  // ---- Assessment approach ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(H('Assessment approach', HeadingLevel.HEADING_1));
  children.push(P('This assessment evaluates the 106 NIST CSF 2.0 Subcategory outcomes using the firm-defined CSF-CAP-1.0 evidence-led capability scale. Conclusions are based on retained evidence, interviews, sampling, and consultant evaluation within the approved scope. Capability averages support prioritization and are not NIST Implementation Tiers. Tier conclusions are assessed and approved separately against risk-governance and risk-management characteristics.'));
  children.push(H('Organizational context and scope', HeadingLevel.HEADING_2));
  [['Business context',profile.business_context],['Mission objectives',profile.mission_objectives],['Risk appetite',profile.risk_appetite],['Scope statement',profile.scope_statement],['Assessment limitations',profile.assessment_limitations]].forEach(([label,value]) => {
    children.push(P([new TextRun({ text: `${label}: `, bold: true }),new TextRun({ text: value || 'Not recorded' })]));
  });

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
    const ranked = fn.categories.filter(c => c.current != null).slice().sort((a,b) => b.current-a.current);
    const strongest = ranked.slice(0,2).map(c => `${c.code} ${c.name} (${r1(c.current)}/5)`).join('; ');
    const weakest = ranked.slice(-2).reverse().map(c => `${c.code} ${c.name} (${r1(c.current)}/5)`).join('; ');
    children.push(P([new TextRun({ text: 'Result narrative: ', bold: true }), new TextRun({ text: ranked.length ? `The strongest assessed Categories were ${strongest}. The largest capability constraints were observed in ${weakest}. These results should be read with the evidence coverage, findings, and approved scope limitations in this report.` : 'No in-scope capability conclusions were available for this Function.' })]));
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
  children.push(P('Each Subcategory is assessed using the firm-defined CSF-CAP-1.0 capability scale: 1 Ad hoc; 2 Partially implemented; 3 Defined and implemented; 4 Measured and effective; 5 Continuously improved. Category results are weighted means of assessed Subcategories; Function results are equal-weighted means of their Categories; Overall is the mean of the six Functions. Null conclusions are excluded rather than treated as zero. NIST Implementation Tiers are separate, evidence-backed governance conclusions and are never inferred from capability scores.'));
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
     'profile_priority','current_profile_statement','target_profile_statement','business_impact','effectiveness_conclusion','evidence_confidence','client_validation_status',
     'evidence_count', 'finding_count'],
  ];

  const counts = db.prepare(`
    SELECT a.subcategory_id, a.exclusion_rationale,a.profile_priority,a.current_profile_statement,a.target_profile_statement,
      a.business_impact,a.effectiveness_conclusion,a.evidence_confidence,a.client_validation_status,
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
          sub.excluded ? '1' : '0', c.exclusion_rationale || '', c.profile_priority || '', c.current_profile_statement || '',
          c.target_profile_statement || '', c.business_impact || '', c.effectiveness_conclusion || '', c.evidence_confidence || '', c.client_validation_status || '',
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

function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function buildHtmlReport({ db, engagement, ws, firm, currentRollup, isDraft, versionRow }) {
  let profile = null;
  if (versionRow?.profile_context_json) { try { profile = JSON.parse(versionRow.profile_context_json); } catch (_) {} }
  if (!profile) profile = db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagement.id) || {};
  const findings = versionRow
    ? db.prepare(`SELECT * FROM csf_finding_snapshots WHERE version_id=? ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END`).all(versionRow.id)
    : db.prepare(`SELECT * FROM csf_findings WHERE engagement_id=? AND deleted_at IS NULL ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END`).all(engagement.id);
  const r1 = csfScoring.r1;
  const tier = currentRollup.overall.tier;
  const contextRows = [['Business context',profile.business_context],['Mission objectives',profile.mission_objectives],['Critical services',profile.critical_services],['Risk appetite',profile.risk_appetite],['Scope statement',profile.scope_statement],['Limitations',profile.assessment_limitations]];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:20mm 16mm}*{box-sizing:border-box}body{font:10.5pt Arial,sans-serif;color:#172026;line-height:1.45}h1{font:700 28pt Georgia,serif;margin:0 0 8px}h2{font:700 17pt Georgia,serif;margin:28px 0 10px;border-bottom:1px solid #d7ddda;padding-bottom:6px}h3{font-size:12pt;margin:20px 0 7px}.cover{min-height:230mm;padding-top:38mm}.eyebrow{text-transform:uppercase;letter-spacing:.12em;color:#60706a;font-size:8pt}.meta{color:#60706a}.draft{color:#a32020;font-weight:700}.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.kpi{border:1px solid #d7ddda;border-radius:8px;padding:12px}.num{font:700 22pt Georgia,serif}table{width:100%;border-collapse:collapse;margin:10px 0 18px;page-break-inside:auto}th,td{text-align:left;border-bottom:1px solid #d7ddda;padding:6px;vertical-align:top}th{font-size:8pt;text-transform:uppercase;letter-spacing:.06em;background:#f4f6f5}.tag{display:inline-block;border:1px solid #bfc8c4;border-radius:10px;padding:1px 6px;font-size:8pt}.page{page-break-before:always}.keep{page-break-inside:avoid}.conf{position:fixed;bottom:-12mm;left:0;color:#60706a;font-size:8pt}
  </style></head><body>
  <section class="cover"><div class="eyebrow">${esc(firm?.name || 'Consulting assurance')}</div><h1>NIST Cybersecurity Framework 2.0<br>Capability Assessment</h1><p>${esc(ws.client_name || 'Client')} · ${esc(engagement.name)}</p><p class="meta">${versionRow ? `Controlled version ${esc(versionRow.version_number)} · published ${esc(versionRow.published_at)}` : `Live working report · generated ${new Date().toISOString().slice(0,10)}`}</p>${isDraft?'<p class="draft">DRAFT · NOT FOR EXTERNAL DISTRIBUTION</p>':''}</section>
  <section class="page"><h2>Executive summary</h2><div class="kpis"><div class="kpi"><div class="num">${currentRollup.overall.current==null?'-':esc(r1(currentRollup.overall.current))}<small>/5</small></div><div>Overall capability</div></div><div class="kpi"><div class="num">${esc(currentRollup.coverage.scoredPct)}%</div><div>Assessment coverage</div></div><div class="kpi"><div class="num">${tier?`Tier ${esc(tier.tier)}`:'-'}</div><div>${tier?esc(tier.name):'Tier not concluded'}</div></div></div>
  <p>The capability result uses the firm-defined CSF-CAP-1.0 evidence-led scale. The NIST Implementation Tier shown above is a separately evidenced and approved governance conclusion; it is not derived from the capability average.</p>
  <h3>Function results</h3><table><thead><tr><th>Function</th><th>Capability</th><th>Target</th><th>Tier conclusion</th></tr></thead><tbody>${currentRollup.functions.map(fn=>`<tr><td><strong>${esc(fn.code)} · ${esc(fn.name)}</strong></td><td>${fn.current==null?'-':esc(r1(fn.current))}</td><td>${fn.target==null?'-':esc(r1(fn.target))}</td><td>${fn.tier?esc(fn.tier.label):'Not concluded'}</td></tr>`).join('')}</tbody></table></section>
  <section class="page"><h2>Context, scope, and limitations</h2>${contextRows.map(([k,v])=>`<div class="keep"><h3>${esc(k)}</h3><p>${esc(v||'Not recorded')}</p></div>`).join('')}</section>
  <section class="page"><h2>Detailed results</h2>${currentRollup.functions.map(fn=>`<div class="keep"><h3>${esc(fn.code)} · ${esc(fn.name)}</h3><p><strong>Capability:</strong> ${fn.current==null?'Not concluded':esc(r1(fn.current))+' / 5'} · <strong>Tier:</strong> ${fn.tier?esc(fn.tier.label):'Not concluded'}</p><table><thead><tr><th>Category</th><th>Current</th><th>Target</th><th>Gap</th><th>Coverage</th></tr></thead><tbody>${fn.categories.map(c=>{const ins=c.subcategories.filter(s=>!s.excluded),sc=ins.filter(s=>s.current!=null);return `<tr><td>${esc(c.code)} · ${esc(c.name)}</td><td>${c.current==null?'-':esc(r1(c.current))}</td><td>${c.target==null?'-':esc(r1(c.target))}</td><td>${c.gap==null?'-':esc(r1(c.gap))}</td><td>${sc.length}/${ins.length}</td></tr>`}).join('')}</tbody></table></div>`).join('')}</section>
  <section class="page"><h2>Findings</h2>${findings.length?`<table><thead><tr><th>Severity</th><th>Finding</th><th>Status</th></tr></thead><tbody>${findings.map(f=>`<tr><td><span class="tag">${esc(f.severity)}</span></td><td><strong>${esc(f.title)}</strong><br>${esc(f.description||'')}</td><td>${esc(f.status)}</td></tr>`).join('')}</tbody></table>`:'<p>No findings were recorded in this report version.</p>'}
  <h2>Methodology</h2><p>Each NIST CSF 2.0 Subcategory is assessed on the firm-defined capability scale: 1 Ad hoc; 2 Partially implemented; 3 Defined and implemented; 4 Measured and effective; 5 Continuously improved. Null conclusions are excluded from rollups. NIST Implementation Tiers are separately assessed against risk-governance and risk-management characteristics and require independent review and approval.</p><p class="meta">Reference: NIST.CSWP.29, The NIST Cybersecurity Framework 2.0 (26 February 2024). Methodology version: ${esc(profile.methodology_version||'CSF-CAP-1.0')}.</p></section>
  <div class="conf">Confidential · Controlled assessment deliverable · ${esc(ws.client_name||'Client')}</div></body></html>`;
}

module.exports = {
  buildWordReport,
  buildCsvExport,
  buildHtmlReport,
};
