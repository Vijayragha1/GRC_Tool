'use strict';

const LEVELS = [
  'Incomplete', 'Initial', 'Managed', 'Defined', 'Quantitatively Managed', 'Optimizing',
];
const PHASES = [
  ['0_3M', 'Now to 3 months'], ['3_6M', '3 to 6 months'],
  ['6_12M', '6 to 12 months'], ['12M_PLUS', '12+ months'],
];
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function fmtDate(value) {
  if (!value) return 'Not recorded';
  const raw = String(value).slice(0, 10);
  const parts = raw.split('-');
  return parts.length === 3 ? `${parts[2]} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(parts[1]) - 1] || parts[1]} ${parts[0]}` : esc(value);
}

function median(values) {
  const nums = values.filter(v => v != null).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function pct(value, total) { return total ? Math.round(Number(value) * 100 / Number(total)) : 0; }
function score(value) { return value == null ? '-' : String(value); }
function scoreName(value) {
  if (value == null) return 'Not concluded';
  const numeric = Number(value);
  if (Number.isInteger(numeric)) return `${numeric} - ${LEVELS[numeric] || 'Not concluded'}`;
  return `${numeric} - Between ${LEVELS[Math.floor(numeric)]} and ${LEVELS[Math.ceil(numeric)]}`;
}
function sentence(value, fallback) { const text = String(value || '').trim(); return text || fallback; }
function validColor(value) { return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : '#17434b'; }
function label(value) { return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }

function loadVersionModel(db, workspaceId, engagementId, versionId) {
  const engagement = db.prepare(`SELECT e.*,w.client_name,w.brand_display_name,w.brand_primary_color,w.brand_logo_path,
      w.industry,w.scope workspace_scope,f.name firm_name
    FROM csf_engagements e JOIN workspaces w ON w.id=e.workspace_id JOIN firms f ON f.id=w.firm_id
    WHERE e.id=? AND e.workspace_id=?`).get(engagementId, workspaceId);
  if (!engagement) return null;
  const version = db.prepare(`SELECT v.*,cu.name created_by_name,ru.name reviewed_by_name,au.name approved_by_name,pu.name published_by_name
    FROM csf_assessment_versions_v2 v LEFT JOIN users cu ON cu.id=v.created_by LEFT JOIN users ru ON ru.id=v.reviewed_by
    LEFT JOIN users au ON au.id=v.approved_by LEFT JOIN users pu ON pu.id=v.published_by
    WHERE v.id=? AND v.engagement_id=? AND v.workspace_id=?`).get(versionId, engagementId, workspaceId);
  if (!version) return null;
  const outcomes = db.prepare(`SELECT o.*,s.description,c.code category_code,c.name category_name,f.code function_code,f.name function_name
    FROM csf_assessment_version_outcomes_v2 o JOIN csf_subcategories s ON s.id=o.subcategory_id
    JOIN csf_categories c ON c.id=s.category_id JOIN csf_functions f ON f.id=c.function_id
    WHERE o.version_id=? ORDER BY f.display_order,c.display_order,s.display_order`).all(version.id);
  return {
    engagement, version, profile: parseJson(version.profile_snapshot_json, {}),
    rollup: parseJson(version.rollup_snapshot_json, { summary: {}, functions: [] }), outcomes,
  };
}

function unpackFindings(outcomes) {
  const findings = [];
  for (const outcome of outcomes) {
    for (const raw of parseJson(outcome.findings_snapshot_json, [])) {
      const recommendations = Array.isArray(raw.recommendations)
        ? raw.recommendations : parseJson(raw.recommendations, []);
      findings.push({ ...raw, outcome_code: outcome.outcome_code, recommendations });
    }
  }
  return findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

function derive(model) {
  const { engagement, version, profile, rollup } = model;
  const outcomes = model.outcomes.map(o => ({
    ...o,
    evidence: parseJson(o.evidence_manifest_json, []),
    tests: parseJson(o.tests_snapshot_json, []),
    exceptions: parseJson(o.exceptions_snapshot_json, []),
  }));
  const inScope = outcomes.filter(o => o.applicability_status !== 'not_applicable');
  const assessed = inScope.filter(o => o.policy_score != null && o.practice_score != null);
  const noVisibility = inScope.filter(o => o.assurance_outcome === 'no_visibility');
  const pending = inScope.filter(o => o.assurance_outcome !== 'no_visibility' && (o.policy_score == null || o.practice_score == null));
  const complete = pending.length === 0;
  const published = version.status === 'published';
  const findings = unpackFindings(outcomes);
  const recommendations = findings.flatMap(f => (f.recommendations || []).map(r => ({ ...r, finding: f })));
  const evidence = outcomes.flatMap(o => o.evidence);
  const tests = outcomes.flatMap(o => o.tests);
  const passedTests = tests.filter(t => t.result === 'pass').length;
  const confidence = ['high', 'medium', 'low'].map(level => ({
    level, count: assessed.filter(o => o.evidence_confidence === level).length,
  }));

  const functionMap = new Map();
  for (const outcome of outcomes) {
    if (!functionMap.has(outcome.function_code)) functionMap.set(outcome.function_code, { code: outcome.function_code, name: outcome.function_name, rows: [] });
    functionMap.get(outcome.function_code).rows.push(outcome);
  }
  const functions = [...functionMap.values()].map(fn => {
    const scoped = fn.rows.filter(o => o.applicability_status !== 'not_applicable');
    const done = scoped.filter(o => o.policy_score != null && o.practice_score != null);
    const atTarget = done.filter(o => o.target_policy_score != null && o.target_practice_score != null && o.policy_score >= o.target_policy_score && o.practice_score >= o.target_practice_score);
    return {
      ...fn, inScope: scoped.length, assessed: done.length, coveragePct: pct(done.length, scoped.length),
      policyMedian: median(done.map(o => o.policy_score)), practiceMedian: median(done.map(o => o.practice_score)),
      achievedMedian: median(done.map(o => Math.min(o.policy_score, o.practice_score))), targetPct: pct(atTarget.length, done.length),
      divergence: done.filter(o => Math.abs(o.policy_score - o.practice_score) >= 2).length,
    };
  });

  const categoryMap = new Map();
  for (const outcome of outcomes) {
    if (!categoryMap.has(outcome.category_code)) categoryMap.set(outcome.category_code, {
      code: outcome.category_code, name: outcome.category_name, function_code: outcome.function_code, rows: [],
    });
    categoryMap.get(outcome.category_code).rows.push(outcome);
  }
  const categories = [...categoryMap.values()].map(category => {
    const scoped = category.rows.filter(o => o.applicability_status !== 'not_applicable');
    const done = scoped.filter(o => o.policy_score != null && o.practice_score != null);
    return { ...category, inScope: scoped.length, assessed: done.length, achievedMedian: median(done.map(o => Math.min(o.policy_score, o.practice_score))) };
  });

  const maturityPriorities = assessed.filter(o => {
    const targetGap = (o.target_policy_score != null && o.policy_score < o.target_policy_score) || (o.target_practice_score != null && o.practice_score < o.target_practice_score);
    return targetGap || o.assurance_outcome === 'ineffective' || o.evidence_confidence === 'low';
  }).sort((a, b) => {
    const gap = o => Math.max((o.target_policy_score ?? o.policy_score) - o.policy_score, (o.target_practice_score ?? o.practice_score) - o.practice_score);
    const risk = o => (o.assurance_outcome === 'ineffective' ? 20 : 0) + (o.evidence_confidence === 'low' ? 10 : 0) + gap(o) * 5 - Math.min(o.policy_score, o.practice_score);
    return risk(b) - risk(a);
  });
  const strengths = assessed.filter(o => o.policy_score >= 3 && o.practice_score >= 3 &&
    o.policy_score >= (o.target_policy_score ?? o.policy_score) && o.practice_score >= (o.target_practice_score ?? o.practice_score) &&
    ['high', 'medium'].includes(o.evidence_confidence)).sort((a, b) => Math.min(b.policy_score, b.practice_score) - Math.min(a.policy_score, a.practice_score));

  const missing = [
    ['Policy conclusions', inScope.filter(o => o.assurance_outcome !== 'no_visibility' && o.policy_score == null).length],
    ['Practice conclusions', inScope.filter(o => o.assurance_outcome !== 'no_visibility' && o.practice_score == null).length],
    ['Target levels', inScope.filter(o => o.target_policy_score == null || o.target_practice_score == null).length],
    ['Assurance outcomes', inScope.filter(o => o.assurance_outcome === 'not_assessed').length],
    ['Evidence confidence decisions', inScope.filter(o => !o.evidence_confidence).length],
  ].filter(([, count]) => count > 0);

  const clientName = engagement.brand_display_name || engagement.client_name;
  const reportTitle = complete ? 'Cybersecurity maturity assessment' : 'Assessment progress and completeness report';
  return {
    ...model, engagement, version, profile, rollup, outcomes, inScope, assessed, pending, noVisibility,
    complete, published, relianceReady: complete && published, findings, recommendations, evidence, tests, passedTests,
    confidence, functions, categories, maturityPriorities, strengths, missing, clientName,
    firmName: engagement.firm_name || 'Compliance Sphere', accent: validColor(engagement.brand_primary_color),
    coveragePct: pct(assessed.length, inScope.length), reportTitle,
  };
}

function reportMeta(model) {
  const d = derive(model);
  return {
    complete: d.complete, published: d.published, relianceReady: d.relianceReady,
    title: d.reportTitle,
    footer: d.relianceReady ? 'Confidential - Controlled assessment deliverable' : 'Internal draft - Not for reliance',
  };
}

function bar(value, tone) {
  const width = value == null ? 0 : Math.max(0, Math.min(100, Number(value) * 20));
  return `<div class="bar"><i class="${tone || ''}" style="width:${width}%"></i></div>`;
}

function progressBar(value) {
  return `<div class="bar progress"><i style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></i></div>`;
}

function documentControl(d) {
  const v = d.version;
  return `<section class="page"><div class="section-label">Report control</div><h2>Document control and intended use</h2>
    <table class="facts"><tbody>
      <tr><th>Prepared for</th><td>${esc(d.clientName)}</td><th>Prepared by</th><td>${esc(d.firmName)}</td></tr>
      <tr><th>Report version</th><td>${esc(v.version_number)} (${esc(label(v.status))})</td><th>Snapshot date</th><td>${fmtDate(v.created_at)}</td></tr>
      <tr><th>Assessment period</th><td>${fmtDate(d.engagement.period_start)} to ${fmtDate(d.engagement.period_end)}</td><th>Classification</th><td>Confidential</td></tr>
      <tr><th>Methodology</th><td>${esc(v.methodology_version)}</td><th>Catalog</th><td>NIST CSF ${esc(v.catalog_version)}</td></tr>
      <tr><th>Prepared by</th><td>${esc(v.created_by_name || 'Not recorded')}</td><th>Approved by</th><td>${esc(v.approved_by_name || 'Not approved')}</td></tr>
    </tbody></table>
    <div class="notice ${d.relianceReady ? 'notice-ok' : 'notice-warn'}"><strong>${d.relianceReady ? 'Controlled client deliverable' : 'Internal working document - no reliance'}</strong><p>${d.relianceReady
      ? 'This immutable snapshot completed the configured approval and publication workflow. Read it with the stated scope, evidence confidence, and limitations.'
      : 'This snapshot is not published. It must not be presented as a completed maturity opinion or relied on for investment, assurance, regulatory, or certification decisions.'}</p></div>
    <h3>Contents</h3><table class="contents"><tbody>${(d.complete ? [
      ['01','Executive assessment opinion'],['02','Function maturity profile'],['03','Outcome heatmap'],['04','Findings and priority themes'],['05','Improvement roadmap'],['06','Scope, evidence, and methodology'],['A','Outcome-level appendix'],
    ] : [
      ['01','Assessment completeness'],['02','Fieldwork readiness by function'],['03','Outstanding decision gates'],['04','Scope and methodology'],
    ]).map(([n, text]) => `<tr><td>${n}</td><td>${text}</td></tr>`).join('')}</tbody></table>
    <div class="integrity"><span>Snapshot identifier</span><code>${esc(v.snapshot_hash)}</code></div></section>`;
}

function cover(d) {
  const status = d.relianceReady ? 'Published' : 'Internal draft - not for reliance';
  return `<section class="cover">
    <div class="cover-band"><span>${esc(d.firmName)}</span><strong>${esc(status)}</strong></div>
    <div class="cover-main"><div class="section-label light">NIST Cybersecurity Framework 2.0</div><h1>${esc(d.reportTitle)}</h1><p>Independent Policy and Practice maturity conclusions using a CMMI-aligned 0-5 scale.</p></div>
    <div class="cover-client"><span>Prepared for</span><strong>${esc(d.clientName)}</strong><small>${esc(d.engagement.industry || 'Industry not recorded')}</small></div>
    <table class="cover-facts"><tbody><tr><td><span>Engagement</span>${esc(d.engagement.name)}</td><td><span>Assessment period</span>${fmtDate(d.engagement.period_start)} to ${fmtDate(d.engagement.period_end)}</td></tr><tr><td><span>Version</span>${esc(d.version.version_number)} - ${esc(label(d.version.status))}</td><td><span>Prepared</span>${fmtDate(d.version.created_at)}</td></tr></tbody></table>
    <div class="cover-footer">CONFIDENTIAL <b></b> Snapshot ${esc(d.version.snapshot_hash.slice(0, 16))}</div>
  </section>`;
}

function functionProgressTable(d, maturity) {
  return `<table class="function-table"><thead><tr><th>Function</th>${maturity ? '<th>Policy</th><th>Practice</th><th>Conservative</th><th>At target</th>' : '<th>Assessed</th><th>Completion</th><th>Remaining</th>'}</tr></thead><tbody>${d.functions.map(f => maturity
    ? `<tr><td><code>${esc(f.code)}</code><strong>${esc(f.name)}</strong><small>${f.assessed}/${f.inScope} assessed; ${f.divergence} material divergences</small></td><td><b>${score(f.policyMedian)}</b>${bar(f.policyMedian, 'policy')}</td><td><b>${score(f.practiceMedian)}</b>${bar(f.practiceMedian, 'practice')}</td><td><b>${score(f.achievedMedian)}</b><small>${esc(scoreName(f.achievedMedian))}</small></td><td><b>${f.targetPct}%</b></td></tr>`
    : `<tr><td><code>${esc(f.code)}</code><strong>${esc(f.name)}</strong></td><td><b>${f.assessed}/${f.inScope}</b></td><td>${progressBar(f.coveragePct)}<small>${f.coveragePct}% complete</small></td><td><b>${Math.max(0, f.inScope - f.assessed)}</b></td></tr>`).join('')}</tbody></table>`;
}

function readinessBody(d) {
  const categoryBacklog = d.categories.filter(c => c.assessed < c.inScope).sort((a, b) => (b.inScope - b.assessed) - (a.inScope - a.assessed));
  return `${documentControl(d)}
    <section class="page"><div class="section-label">01 - Assessment completeness</div><h2>No maturity opinion has been issued</h2>
      <p class="lead">This snapshot records assessment progress only. ${d.assessed.length} of ${d.inScope.length} in-scope NIST CSF outcomes have both Policy and Practice conclusions. Incomplete coverage would make a maturity opinion misleading.</p>
      <div class="hero-kpis"><div><strong>${d.coveragePct}%</strong><span>Outcome coverage</span></div><div><strong>${d.assessed.length}/${d.inScope.length}</strong><span>Dual-axis conclusions</span></div><div><strong>${d.noVisibility.length}</strong><span>No-visibility decisions</span></div><div><strong>${d.evidence.length}</strong><span>Evidence items retained</span></div></div>
      <div class="notice notice-warn"><strong>Publication safeguard</strong><p>The client-facing assessment, maturity profile, heatmap, findings opinion, and roadmap remain withheld until all in-scope outcomes have governed conclusions and the snapshot is independently approved and published.</p></div>
      <h3>What this report can support</h3><div class="three-col"><div><strong>Supported</strong><p>Fieldwork planning, completeness monitoring, evidence chase, and reviewer workload decisions.</p></div><div><strong>Not supported</strong><p>Enterprise maturity claims, peer comparisons, target-state investment decisions, or assurance reliance.</p></div><div><strong>Next decision gate</strong><p>Complete dual-axis conclusions and evidence confidence, then run independent review and publication checks.</p></div></div>
    </section>
    <section class="page"><div class="section-label">02 - Fieldwork readiness</div><h2>Coverage by CSF Function</h2><p class="lead">Completion is based only on outcomes with both Policy and Practice conclusions. Evidence volume alone does not count as an assessed outcome.</p>${functionProgressTable(d, false)}
      <h3>Largest category backlogs</h3><table><thead><tr><th>Category</th><th>Function</th><th>Completed</th><th>Remaining</th></tr></thead><tbody>${categoryBacklog.slice(0, 12).map(c => `<tr><td><code>${esc(c.code)}</code> ${esc(c.name)}</td><td>${esc(c.function_code)}</td><td>${c.assessed}/${c.inScope}</td><td><b>${c.inScope - c.assessed}</b></td></tr>`).join('') || '<tr><td colspan="4">No category backlog was identified.</td></tr>'}</tbody></table>
    </section>
    <section class="page"><div class="section-label">03 - Outstanding decision gates</div><h2>Work required before publication</h2>
      <div class="gate-list">${d.missing.map(([name, count], index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><p><strong>${esc(name)}</strong><br>${count} in-scope outcome${count === 1 ? '' : 's'} require${count === 1 ? 's' : ''} a governed decision.</p></div>`).join('') || '<div><span>01</span><p><strong>Conclusion coverage is complete</strong><br>Proceed with independent review, approval, and publication.</p></div>'}</div>
      <h3>Recommended completion sequence</h3><ol class="sequence"><li>Confirm the Organizational Profile, scope boundary, critical services, and stated limitations.</li><li>Complete Policy and Practice fieldwork independently for every in-scope outcome.</li><li>Retain axis-specific evidence, testing, sampling, exceptions, and confidence conclusions.</li><li>Convert material deficiencies into governed findings and time-bound recommendations.</li><li>Complete independent review, client factual validation where required, approval, and controlled publication.</li></ol>
    </section>
    ${scopeMethodBody(d, false)}`;
}

function opinionText(d) {
  const achieved = d.rollup.summary.achievedMedian;
  const level = scoreName(achieved);
  const direction = d.rollup.summary.policyMedian > d.rollup.summary.practiceMedian
    ? 'Practice maturity trails documented Policy maturity at the portfolio level.'
    : d.rollup.summary.practiceMedian > d.rollup.summary.policyMedian
      ? 'Practice maturity exceeds the degree of formal Policy institutionalization at the portfolio level.'
      : 'Policy and Practice medians are aligned at the portfolio level.';
  return `The conservative achieved maturity is ${level}. ${direction} ${d.rollup.summary.atTarget || 0} of ${d.assessed.length} assessed outcomes meet both target levels. ${d.noVisibility.length ? `${d.noVisibility.length} outcome(s) have a governed no-visibility conclusion and should be read as an explicit limitation.` : 'No governed no-visibility conclusions were recorded.'}`;
}

function executiveBody(d) {
  return `${documentControl(d)}
    <section class="page"><div class="section-label">01 - Executive assessment opinion</div><h2>Cybersecurity maturity conclusion</h2><div class="opinion"><span>Conservative achieved maturity</span><strong>${score(d.rollup.summary.achievedMedian)} <small>${esc(LEVELS[Number(d.rollup.summary.achievedMedian)] || 'Not concluded')}</small></strong><p>${esc(opinionText(d))}</p></div>
      <div class="hero-kpis"><div><strong>${score(d.rollup.summary.policyMedian)}</strong><span>Policy median</span></div><div><strong>${score(d.rollup.summary.practiceMedian)}</strong><span>Practice median</span></div><div><strong>${d.rollup.summary.targetPct || 0}%</strong><span>Target attainment</span></div><div><strong>${d.rollup.summary.divergence || 0}</strong><span>Material divergences</span></div></div>
      <h3>Evidence and confidence</h3><table class="facts"><tbody><tr><th>Outcome coverage</th><td>${d.assessed.length}/${d.inScope.length} (${d.coveragePct}%)</td><th>Retained evidence</th><td>${d.evidence.length} items</td></tr><tr><th>Executed tests</th><td>${d.tests.length} (${d.passedTests} passed)</td><th>Evidence confidence</th><td>${d.confidence.map(c => `${label(c.level)} ${c.count}`).join(' / ')}</td></tr></tbody></table>
      <div class="notice"><strong>Interpretation</strong><p>Medians communicate the center of the distribution but do not override weak outcomes. The heatmap, material gaps, formal findings, evidence confidence, and scope limitations are integral to this opinion.</p></div>
    </section>
    <section class="page"><div class="section-label">02 - Function maturity profile</div><h2>Policy and Practice by CSF Function</h2><p class="lead">Each axis is concluded separately. The conservative achieved level is the lower of Policy and Practice for an outcome.</p>${functionProgressTable(d, true)}
      <div class="scale">${LEVELS.map((name, i) => `<span><b>${i}</b>${esc(name)}</span>`).join('')}</div>
      <div class="notice"><strong>Decision signal</strong><p>${esc(opinionText(d))}</p></div>
    </section>
    ${heatmapBody(d)}
    ${themesBody(d)}
    ${findingsBody(d)}
    ${roadmapBody(d)}
    ${scopeMethodBody(d, true)}
    ${appendixBody(d)}`;
}

function heatmapCell(outcome) {
  if (outcome.applicability_status === 'not_applicable') return `<i class="heat na" title="${esc(outcome.outcome_code)} - Not applicable">NA</i>`;
  if (outcome.assurance_outcome === 'no_visibility') return `<i class="heat nv" title="${esc(outcome.outcome_code)} - No visibility">?</i>`;
  if (outcome.policy_score == null || outcome.practice_score == null) return `<i class="heat pending" title="${esc(outcome.outcome_code)} - Not concluded">-</i>`;
  const achieved = Math.min(outcome.policy_score, outcome.practice_score);
  return `<i class="heat s${achieved}" title="${esc(outcome.outcome_code)} - ${achieved}">${achieved}</i>`;
}

function heatmapBody(d) {
  const midpoint = Math.ceil(d.categories.length / 2);
  const table = rows => `<table class="heatmap-table"><thead><tr><th>Category</th><th>Outcomes</th><th>Median</th></tr></thead><tbody>${rows.map(c => `<tr><td><code>${esc(c.function_code)} / ${esc(c.code)}</code><strong>${esc(c.name)}</strong><small>${c.assessed}/${c.inScope} assessed</small></td><td class="heat-cells">${c.rows.map(heatmapCell).join('')}</td><td><b>${score(c.achievedMedian)}</b></td></tr>`).join('')}</tbody></table>`;
  return `<section class="page"><div class="section-label">03 - Outcome heatmap</div><h2>Conservative maturity across 106 outcomes</h2><p class="lead">Each square is one official NIST CSF 2.0 outcome and shows the lower of its Policy and Practice levels. Category medians do not replace the outcome-level result.</p>
    <div class="heat-columns"><div>${table(d.categories.slice(0, midpoint))}</div><div>${table(d.categories.slice(midpoint))}</div></div>
    <div class="legend"><span><i class="heat s0">0</i> Incomplete</span><span><i class="heat s1">1</i> Initial</span><span><i class="heat s2">2</i> Managed</span><span><i class="heat s3">3</i> Defined</span><span><i class="heat s4">4</i> Quantitatively Managed</span><span><i class="heat s5">5</i> Optimizing</span><span><i class="heat nv">?</i> No visibility</span></div>
  </section>`;
}

function themesBody(d) {
  return `<section class="page"><div class="section-label">04 - Decision themes</div><h2>Strengths and maturity priorities</h2>
    <div class="two-col"><div><h3>Demonstrated strengths</h3>${d.strengths.slice(0, 6).map(o => `<article class="theme good"><code>${esc(o.outcome_code)}</code><strong>${esc(o.category_name)}</strong><p>${esc(o.description)}</p><small>Policy ${score(o.policy_score)} / Practice ${score(o.practice_score)} / ${esc(label(o.evidence_confidence))} confidence</small></article>`).join('') || '<div class="empty"><strong>No evidence-backed strengths met the reporting threshold.</strong><p>This does not mean no strengths exist; it means none met the snapshot criteria used for this section.</p></div>'}</div>
    <div><h3>Priority outcome themes</h3>${d.maturityPriorities.slice(0, 6).map(o => `<article class="theme risk"><code>${esc(o.outcome_code)}</code><strong>${esc(o.category_name)}</strong><p>${esc(sentence(o.business_impact, o.description))}</p><small>Current P${score(o.policy_score)} / R${score(o.practice_score)} - Target P${score(o.target_policy_score)} / R${score(o.target_practice_score)}</small></article>`).join('') || '<div class="empty"><strong>No target shortfalls met the reporting threshold.</strong><p>Review the full appendix and stated limitations before relying on this result.</p></div>'}</div></div>
  </section>`;
}

function findingsBody(d) {
  const cards = d.findings.map((f, index) => `<article class="finding"><div class="finding-head"><span>${String(index + 1).padStart(2, '0')}</span><div><em class="sev ${String(f.severity || 'MEDIUM').toLowerCase()}">${esc(f.severity || 'MEDIUM')}</em><h3>${esc(f.title)}</h3><small>${esc(f.outcome_code)} - ${esc(label(f.status || 'Draft'))}</small></div></div><p>${esc(f.description)}</p>${f.recommendations.length ? `<h4>Governed recommendations</h4><ul>${f.recommendations.map(r => `<li>${esc(r.title || r.description)} <small>${esc(label(r.priority || 'MED'))} - ${esc(PHASES.find(p => p[0] === r.roadmap_phase)?.[1] || r.roadmap_phase || 'Unscheduled')}</small></li>`).join('')}</ul>` : '<div class="inline-warning">No governed recommendation is attached to this finding.</div>'}</article>`).join('');
  return `<section class="page"><div class="section-label">04A - Formal findings</div><h2>Governed assessment findings</h2><p class="lead">Only findings frozen into this controlled snapshot are reported here. Priority outcome themes are not silently converted into formal findings.</p>${cards || '<div class="empty large"><strong>No formal findings were recorded in this snapshot.</strong><p>This statement is not equivalent to a clean assurance opinion. Target shortfalls and low-confidence conclusions may still appear in the preceding themes and outcome appendix.</p></div>'}</section>`;
}

function roadmapBody(d) {
  const cards = PHASES.map(([key, title], index) => { const rows = d.recommendations.filter(r => r.roadmap_phase === key); return `<div class="roadmap-card"><span>0${index + 1}</span><h3>${esc(title)}</h3>${rows.length ? `<ul>${rows.map(r => `<li><strong>${esc(r.title || r.description)}</strong><small>${esc(r.finding.outcome_code)} - ${esc(label(r.priority || 'MED'))}${r.target_completion_date ? ` - due ${fmtDate(r.target_completion_date)}` : ''}</small></li>`).join('')}</ul>` : '<p>No governed recommendation scheduled.</p>'}</div>`; });
  return `<section class="page"><div class="section-label">05 - Improvement roadmap</div><h2>Governed recommendations by horizon</h2><p class="lead">The roadmap reports only approved assessment recommendations captured in the snapshot. It does not invent management commitments or delivery dates.</p>
    <div class="hero-kpis"><div><strong>${d.findings.length}</strong><span>Formal findings</span></div><div><strong>${d.recommendations.length}</strong><span>Governed recommendations</span></div><div><strong>${PHASES.filter(([key]) => d.recommendations.some(r => r.roadmap_phase === key)).length}/4</strong><span>Horizons in use</span></div><div><strong>${d.recommendations.filter(r => !r.roadmap_phase).length}</strong><span>Unscheduled</span></div></div>
    <div class="roadmap-grid"><div>${cards[0]}${cards[2]}</div><div>${cards[1]}${cards[3]}</div></div>
    <div class="notice"><strong>Delivery governance</strong><p>Management should assign accountable owners, confirm dependencies and due dates, define acceptance evidence, and govern material changes through the engagement plan. Completion should be based on accepted evidence, not task status alone.</p></div>
    ${d.recommendations.length ? '' : '<div class="notice notice-warn"><strong>Roadmap not established</strong><p>No governed recommendations were frozen into this snapshot. Before publication, management should confirm accountable owners, effort, dependencies, due dates, and measurable completion evidence for each material finding.</p></div>'}
  </section>`;
}

function scopeMethodBody(d, complete) {
  const p = d.profile;
  return `<section class="page"><div class="section-label">${complete ? '06' : '04'} - Scope and methodology</div><h2>Basis of assessment</h2>
    <table class="profile"><tbody><tr><th>Assessment boundary</th><td>${esc(sentence(p.scope_statement, d.engagement.workspace_scope || 'Not recorded'))}</td></tr><tr><th>Business context</th><td>${esc(sentence(p.business_context, 'Not recorded'))}</td></tr><tr><th>Mission objectives</th><td>${esc(sentence(p.mission_objectives, 'Not recorded'))}</td></tr><tr><th>Critical services</th><td>${esc(sentence(p.critical_services, 'Not recorded'))}</td></tr><tr><th>Threat landscape</th><td>${esc(sentence(p.threat_landscape, 'Not recorded'))}</td></tr><tr><th>Risk appetite</th><td>${esc(sentence(p.risk_appetite, 'Not recorded'))}</td></tr><tr><th>Limitations</th><td>${esc(sentence(p.assessment_limitations, 'No additional limitations were recorded.'))}</td></tr></tbody></table>
    <h3>Scoring model</h3><p>Each official NIST CSF 2.0 outcome was assessed on two independent axes. Policy maturity considers governance, formal requirements, ownership, and institutionalization. Practice maturity considers implementation, consistency, testing, and demonstrated effectiveness. The lower axis is the conservative achieved level.</p>
    <table class="levels"><tbody>${LEVELS.map((name, level) => `<tr><th>${level}</th><td><strong>${esc(name)}</strong></td><td>${esc(['Absent or not performed','Ad hoc and person-dependent','Owned, repeatable, and evidenced','Standardized across the agreed scope','Measured and controlled against targets','Continuously improved using evidence'][level])}</td></tr>`).join('')}</tbody></table>
    <h3>Method and lineage</h3><table class="facts"><tbody><tr><th>Catalog hash</th><td><code>${esc(d.version.catalog_hash)}</code></td><th>Methodology hash</th><td><code>${esc(d.version.methodology_hash)}</code></td></tr><tr><th>Reviewed by</th><td>${esc(d.version.reviewed_by_name || 'Not reviewed')}</td><th>Published by</th><td>${esc(d.version.published_by_name || 'Not published')}</td></tr></tbody></table>
    <div class="notice"><strong>Important qualification</strong><p>This is an advisory maturity assessment using the official NIST CSF 2.0 Core as its outcome taxonomy. It is not a NIST certification, a NIST Implementation Tier determination, or a formal CMMI appraisal.</p></div>
  </section>`;
}

function appendixBody(d) {
  const findingCodes = new Set(d.findings.map(f => f.outcome_code));
  const priority = d.outcomes.filter(o => findingCodes.has(o.outcome_code) || o.assurance_outcome === 'no_visibility' || o.evidence_confidence === 'low' ||
    (o.policy_score != null && o.practice_score != null && (Math.abs(o.policy_score - o.practice_score) >= 2 || o.policy_score < (o.target_policy_score ?? o.policy_score) || o.practice_score < (o.target_practice_score ?? o.practice_score))));
  priority.sort((a, b) => Number(findingCodes.has(b.outcome_code)) - Number(findingCodes.has(a.outcome_code)) || Number(b.evidence_confidence === 'low') - Number(a.evidence_confidence === 'low') || Math.min(a.policy_score ?? 9, a.practice_score ?? 9) - Math.min(b.policy_score ?? 9, b.practice_score ?? 9));
  const rows = priority.slice(0, 16);
  return `<section class="page appendix"><div class="section-label">Appendix A - Material outcome register</div><h2>Outcome-level exceptions and traceability</h2><p class="lead">The heatmap reports all ${d.outcomes.length} frozen outcomes. This appendix isolates ${priority.length} outcomes meeting the materiality rule: formal finding linkage, no visibility, low evidence confidence, a material Policy-Practice divergence, or a target shortfall. The complete 106-outcome register is available in the controlled CSV export and assessment workpapers.</p>
    <table><thead><tr><th>Outcome</th><th>Description</th><th>P</th><th>R</th><th>Target</th><th>Conclusion</th></tr></thead><tbody>${rows.map(o => `<tr><td><code>${esc(o.outcome_code)}</code><small>${esc(o.category_code)}</small></td><td>${esc(o.description)}</td><td class="num">${score(o.policy_score)}</td><td class="num">${score(o.practice_score)}</td><td class="num">${score(o.target_policy_score)}/${score(o.target_practice_score)}</td><td><span class="status">${esc(label(o.assurance_outcome))}</span><small>${esc(label(o.evidence_confidence || 'confidence not set'))}</small></td></tr>`).join('') || '<tr><td colspan="6">No outcomes met the materiality rule in this snapshot.</td></tr>'}</tbody></table>
    ${priority.length > rows.length ? `<div class="footer-note">Showing the ${rows.length} highest-priority outcomes. ${priority.length - rows.length} additional material outcomes remain in the controlled CSV and workpaper record.</div>` : ''}
  </section>`;
}

function reportHtml(model) {
  const d = derive(model);
  const watermark = d.relianceReady ? '' : '<div class="watermark">INTERNAL DRAFT - NOT FOR RELIANCE</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.engagement.name)} - ${esc(d.reportTitle)}</title><style>
    @page{size:A4;margin:16mm 14mm 18mm}*{box-sizing:border-box}html{--accent:${d.accent};--ink:#152429;--muted:#627176;--line:#d8e0e2;--pale:#f2f6f6;--navy:#102f37}body{font-family:Arial,Helvetica,sans-serif;color:var(--ink);font-size:9.2px;line-height:1.45;margin:0;background:#fff}h1,h2,h3,h4,p{margin-top:0}h1,h2{font-family:Georgia,'Times New Roman',serif}h1{font-size:31px;line-height:1.08}h2{font-size:21px;line-height:1.15;margin-bottom:10px}h3{font-size:12px;margin:16px 0 7px}h4{font-size:10px;margin:10px 0 4px}p{margin-bottom:8px}.page{page-break-before:always}.section-label{text-transform:uppercase;letter-spacing:.17em;font-size:7.5px;font-weight:bold;color:var(--accent);margin-bottom:8px}.section-label.light{color:#b8d1d5}.lead{font-size:11px;line-height:1.55;color:#495b61;max-width:660px}.cover{min-height:250mm;background:var(--navy);color:#fff;padding:22mm 17mm 15mm;display:flex;flex-direction:column;border-left:7px solid var(--accent)}.cover-band{display:flex;justify-content:space-between;text-transform:uppercase;letter-spacing:.12em;font-size:8px}.cover-band strong{border:1px solid rgba(255,255,255,.35);padding:4px 7px}.cover-main{margin-top:45mm;max-width:590px}.cover-main h1{color:#fff;font-size:38px;margin:0 0 14px}.cover-main p{font-size:13px;color:#c5d6da;max-width:520px}.cover-client{margin-top:auto;border-top:1px solid rgba(255,255,255,.25);padding-top:18px}.cover-client span,.cover-client small,.cover-facts span{display:block;color:#9fb7bc;text-transform:uppercase;letter-spacing:.12em;font-size:7px}.cover-client strong{display:block;font:23px Georgia,serif;margin:4px 0}.cover-facts{width:100%;border-collapse:collapse;margin-top:18px}.cover-facts td{width:50%;border:1px solid rgba(255,255,255,.18);padding:9px;color:#fff}.cover-facts span{margin-bottom:3px}.cover-footer{margin-top:15px;font-size:7px;letter-spacing:.13em;color:#a9c0c4}.cover-footer b{display:inline-block;width:4px;height:4px;background:var(--accent);border-radius:50%;margin:0 8px}.watermark{position:fixed;top:46%;left:9%;z-index:0;transform:rotate(-31deg);font-size:29px;font-weight:bold;letter-spacing:.11em;color:rgba(128,47,39,.09);white-space:nowrap}.page,.cover{position:relative;z-index:1}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:6px 7px;vertical-align:top;text-align:left}thead th{background:var(--pale);text-transform:uppercase;letter-spacing:.08em;color:#526268;font-size:7px}code{font-family:'Courier New',monospace;font-size:8px;color:#1b5661}.facts th{width:17%;font-size:7px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:var(--pale)}.facts td{width:33%}.facts code{font-size:6.5px;word-break:break-all}.notice{border-left:4px solid var(--accent);background:var(--pale);padding:10px 12px;margin:14px 0;page-break-inside:avoid}.notice strong{font-size:10px}.notice p{margin:3px 0 0;color:#526268}.notice-warn{border-color:#b45309;background:#fff8e8}.notice-ok{border-color:#28755b;background:#edf8f3}.contents{margin-top:5px}.contents td:first-child{width:45px;color:var(--accent);font-family:Georgia,serif;font-size:14px}.integrity{margin-top:18px;border-top:1px solid var(--line);padding-top:8px}.integrity span{display:block;text-transform:uppercase;font-size:7px;color:var(--muted)}.integrity code{word-break:break-all}.hero-kpis{display:table;width:100%;table-layout:fixed;margin:14px 0}.hero-kpis>div{display:table-cell;border:1px solid var(--line);padding:11px}.hero-kpis strong{display:block;font:24px Georgia,serif;color:var(--accent)}.hero-kpis span{font-size:7px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.three-col,.two-col{display:table;width:100%;table-layout:fixed}.three-col>div{display:table-cell;width:33.33%;padding:10px;border:1px solid var(--line)}.two-col>div{display:table-cell;width:50%;vertical-align:top;padding-right:9px}.two-col>div+div{padding-right:0;padding-left:9px}.function-table td:first-child{width:34%}.function-table td:first-child code,.function-table td:first-child strong,.function-table small{display:block}.function-table td b{font:16px Georgia,serif}.bar{height:5px;background:#e4eaeb;margin-top:4px;border-radius:5px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar i.practice{background:#a96736}.bar.progress i{background:#2d7b67}.function-table small,.theme small,.finding small,.appendix small{font-size:7px;color:var(--muted);margin-top:2px}.scale{display:table;width:100%;table-layout:fixed;margin:14px 0}.scale span{display:table-cell;border:1px solid var(--line);padding:6px;font-size:6.5px}.scale b{display:block;font:14px Georgia,serif}.gate-list>div{display:table;width:100%;border-bottom:1px solid var(--line);page-break-inside:avoid}.gate-list span,.gate-list p{display:table-cell;padding:9px 4px}.gate-list span{width:38px;color:var(--accent);font:18px Georgia,serif}.sequence{padding-left:18px}.sequence li{padding:4px 0}.opinion{background:var(--navy);color:#fff;padding:18px;border-radius:3px}.opinion>span{font-size:7px;text-transform:uppercase;letter-spacing:.12em;color:#a9c0c4}.opinion>strong{display:block;font:32px Georgia,serif;margin:4px 0}.opinion>strong small{font:14px Arial}.opinion p{color:#cfdddf;font-size:10.5px;margin:8px 0 0}.heatmap-table td:first-child{width:7%}.heatmap-table td:nth-child(2){width:29%}.heatmap-table td:nth-child(4){width:8%;text-align:center}.heatmap-table strong,.heatmap-table small{display:block}.heat-cells{line-height:23px}.heat{display:inline-block;width:19px;height:19px;line-height:19px;text-align:center;margin:1px;border-radius:2px;font-style:normal;font-size:7px;color:#fff;background:#899497}.heat.s0{background:#9f3131}.heat.s1{background:#c05a3b}.heat.s2{background:#c58b30}.heat.s3{background:#437382}.heat.s4{background:#2f7461}.heat.s5{background:#17553f}.heat.na{background:#dfe4e5;color:#68757a}.heat.nv,.heat.pending{background:#6b7280}.legend{margin-top:10px}.legend span{display:inline-block;margin:2px 7px 2px 0;font-size:7px}.legend .heat{vertical-align:middle}.theme{border:1px solid var(--line);padding:9px;margin-bottom:7px;page-break-inside:avoid}.theme code,.theme strong{display:block}.theme p{margin:5px 0}.theme.good{border-top:3px solid #2d7b67}.theme.risk{border-top:3px solid #b45309}.empty{border:1px dashed #b9c4c6;padding:12px;color:var(--muted)}.empty.large{padding:22px;margin-top:15px}.finding{border-top:4px solid var(--accent);border-left:1px solid var(--line);border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px;margin-bottom:11px;page-break-inside:avoid}.finding-head{display:table;width:100%}.finding-head>span,.finding-head>div{display:table-cell;vertical-align:top}.finding-head>span{width:42px;font:22px Georgia,serif;color:#91a0a4}.finding h3{margin:3px 0}.sev{font-style:normal;font-size:7px;font-weight:bold;letter-spacing:.08em;color:#9f3131}.sev.medium{color:#a76716}.sev.low{color:#2b6f61}.finding ul{margin:5px 0;padding-left:18px}.finding li small{display:block}.inline-warning{background:#fff8e8;padding:6px;color:#8b5316}.roadmap>div{border-top:1px solid var(--line);display:table;width:100%;padding:10px 0;page-break-inside:avoid}.roadmap>div>span,.roadmap>div>h3,.roadmap>div>ul,.roadmap>div>p{display:table-cell;vertical-align:top}.roadmap>div>span{width:40px;font:18px Georgia,serif;color:var(--accent)}.roadmap>div>h3{width:110px;margin:0}.roadmap ul{margin:0;padding-left:18px}.roadmap li{margin-bottom:5px}.roadmap li small{display:block;color:var(--muted)}.profile th{width:21%;background:var(--pale);font-size:7px;text-transform:uppercase;color:var(--muted)}.levels th{width:7%;font:17px Georgia,serif;color:var(--accent)}.appendix table{font-size:7.5px}.appendix th,.appendix td{padding:4px}.appendix td:first-child{width:12%}.appendix td:nth-child(2){width:45%}.appendix .num{text-align:center;font-weight:bold}.status{display:block;text-transform:capitalize}.appendix tr{page-break-inside:avoid}
    thead{display:table-header-group}
    .heat-columns{display:table;width:100%;table-layout:fixed}.heat-columns>div{display:table-cell;width:50%;vertical-align:top;padding-right:5px}.heat-columns>div+div{padding:0 0 0 5px}.heat-columns .heatmap-table{font-size:8.4px;line-height:1.28}.heat-columns .heatmap-table td:first-child{width:44%}.heat-columns .heatmap-table td:nth-child(2){width:46%}.heat-columns .heatmap-table td:nth-child(3){width:10%;text-align:center}.heat-columns .heatmap-table th,.heat-columns .heatmap-table td{padding:3px 4px}.heat-columns .heatmap-table small{font-size:6px}.heat-columns .heat-cells{line-height:15px}.heat-columns .heat{width:13px;height:13px;line-height:13px;font-size:5.8px;margin:1px}.heat-columns+.legend{margin-top:5px}.heat-columns+.legend span{font-size:6.5px;margin-right:5px}.heat-columns+.legend .heat{width:16px;height:16px;line-height:16px}
    .roadmap-grid{display:table;width:100%;table-layout:fixed}.roadmap-grid>div{display:table-cell;width:50%;vertical-align:top;padding-right:5px}.roadmap-grid>div+div{padding:0 0 0 5px}.roadmap-card{border:1px solid var(--line);padding:10px;margin-bottom:10px;min-height:92px;page-break-inside:avoid}.roadmap-card>span{font:18px Georgia,serif;color:var(--accent)}.roadmap-card h3{margin:2px 0 7px}.roadmap-card ul{margin:0;padding-left:16px}.roadmap-card li{margin-bottom:5px}.roadmap-card li small{display:block;color:var(--muted)}.roadmap-card p{color:var(--muted)}
    .hard-page-break{page-break-before:always;break-before:page;height:0}.appendix{position:static}.appendix td:first-child code,.appendix td:first-child small{display:block}.appendix-inner{padding-top:10mm}.appendix .appendix-sentinel th{height:1px;line-height:0;font-size:0;padding:0;border:0;background:#fff}.appendix .appendix-heading th{background:#fff;border:0;padding:0 0 10px;text-transform:none;letter-spacing:normal}.appendix-heading h2{margin-bottom:6px}.appendix-heading .lead{font-weight:normal;margin-bottom:2px}
  </style></head><body>${watermark}${cover(d)}${d.complete ? executiveBody(d) : readinessBody(d)}</body></html>`;
}

function csv(model) {
  const q = v => `"${String(v == null ? '' : v).replaceAll('"', '""')}"`;
  const header = ['Function','Category','Outcome','Description','Applicability','Priority','Policy score','Practice score','Achieved level','Target Policy','Target Practice','Policy rationale','Practice rationale','Assurance outcome','Evidence confidence','Business impact'];
  const lines = [header.map(q).join(',')];
  for (const o of model.outcomes) lines.push([o.function_code,o.category_code,o.outcome_code,o.description,o.applicability_status,o.profile_priority,o.policy_score,o.practice_score,o.policy_score == null || o.practice_score == null ? '' : Math.min(o.policy_score,o.practice_score),o.target_policy_score,o.target_practice_score,o.policy_rationale,o.practice_rationale,o.assurance_outcome,o.evidence_confidence,o.business_impact].map(q).join(','));
  return lines.join('\n');
}

function asBuffer(value) { return Buffer.isBuffer(value) ? value : Buffer.from(value); }

module.exports = { loadVersionModel, reportHtml, reportMeta, csv, asBuffer, derive };
