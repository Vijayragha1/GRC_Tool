'use strict';

const crypto = require('crypto');
const auditPack = require('./audit-pack');
const { htmlToDocxPooled } = require('./workers');

const REPORTS = {
  executive_posture: {
    key: 'executive_posture',
    name: 'Executive security posture',
    short: 'A decision-focused view for boards and executive leadership.',
    audience: 'Board, executive leadership, risk committee',
    sections: ['executive_summary', 'posture', 'priority_risks', 'assurance', 'management_attention']
  },
  audit_readiness: {
    key: 'audit_readiness',
    name: 'Audit-readiness report',
    short: 'A traceable audit preparation record with evidence and source lineage.',
    audience: 'Internal audit, certification body, ISMS leadership',
    sections: ['executive_summary', 'scope', 'soa', 'controls', 'evidence', 'governance', 'nonconformities', 'source_manifest']
  },
  supplier_due_diligence: {
    key: 'supplier_due_diligence',
    name: 'Supplier due-diligence report',
    short: 'A decision-grade third-party risk record for one supplier.',
    audience: 'Procurement, security, privacy, risk committee',
    sections: ['executive_summary', 'supplier_profile', 'risk_assessment', 'questionnaire', 'evidence', 'findings', 'decision', 'monitoring', 'source_manifest']
  }
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  }
  return value;
}

function stableStringify(value) { return JSON.stringify(stable(value)); }
function sha(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex'); }
function rowHash(row) { return sha(stableStringify(row)); }
function e(v) { return String(v == null ? '' : v).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function date(v) { return v ? String(v).slice(0, 10) : '—'; }
function num(v) { return Number(v || 0); }
function safeJson(v, fallback) { try { return JSON.parse(v); } catch (_) { return fallback; } }
function slug(v) { return String(v || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80); }

function addSources(manifest, section, type, rows, labelFn, updatedKey) {
  for (const row of rows || []) {
    manifest.push({
      section_key: section,
      source_type: type,
      source_id: String(row.id == null ? 'workspace' : row.id),
      source_label: String(labelFn ? labelFn(row) : `${type} ${row.id}`),
      source_hash: rowHash(row),
      source_updated_at: row[updatedKey || 'updated_at'] || row.created_at || null
    });
  }
}

function workspaceBase(db, wsId) {
  return db.prepare(`SELECT w.*, f.name AS firm_name
    FROM workspaces w JOIN firms f ON f.id=w.firm_id WHERE w.id=?`).get(wsId);
}

function commonData(db, wsId, manifest) {
  const workspace = workspaceBase(db, wsId);
  if (!workspace) throw new Error('workspace_not_found');
  addSources(manifest, 'scope', 'workspace', [workspace], r => r.client_name, 'updated_at');

  const controls = db.prepare(`SELECT cs.id, cs.iso_item_id, i.type, i.category, i.title,
      cs.status, cs.applicability, cs.inclusion_justification, cs.exclusion_justification,
      cs.maturity, cs.notes, cs.due_date, cs.last_updated, cs.last_verified_at
    FROM v_control_states cs JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? ORDER BY i.sort_order, cs.iso_item_id`).all(wsId);
  const risks = db.prepare(`SELECT id,title,description,likelihood,impact,treatment,owner_name,status,
      residual_likelihood,residual_impact,accepted_until,created_at
    FROM risks WHERE workspace_id=? ORDER BY COALESCE(residual_likelihood,likelihood)*COALESCE(residual_impact,impact) DESC, id`).all(wsId);
  const evidence = db.prepare(`SELECT id,iso_item_id,filename,sha256,size_bytes,description,uploaded_at,
      valid_from,valid_until,period_label,superseded_at,tags
    FROM evidence WHERE workspace_id=? ORDER BY uploaded_at DESC,id DESC`).all(wsId);
  const documents = db.prepare(`SELECT id,name,category,status,version,reference_code,controlled_copy,
      approved_at,published_at,next_review_date,updated_at,retired_at
    FROM generated_docs WHERE workspace_id=? ORDER BY name,id`).all(wsId);
  const audits = db.prepare(`SELECT id,title,scope,audit_date,auditor_name,status,summary,lifecycle_stage,
      report_issued_at,closed_at,created_at FROM audits WHERE workspace_id=? ORDER BY audit_date DESC,id DESC`).all(wsId);
  const mrms = db.prepare(`SELECT id,meeting_date,status,attendees,performance_review,risk_treatment_status,
      decisions,action_items,created_at FROM mrms WHERE workspace_id=? ORDER BY meeting_date DESC,id DESC`).all(wsId);
  const ncs = db.prepare(`SELECT id,title,source,source_ref,description,severity,iso_item_id,responsible,
      due_date,status,created_at,closed_at FROM nonconformities WHERE workspace_id=? ORDER BY created_at DESC,id DESC`).all(wsId);

  addSources(manifest, 'controls', 'control_state', controls, r => `${r.iso_item_id} ${r.title}`, 'last_updated');
  addSources(manifest, 'priority_risks', 'risk', risks, r => r.title, 'created_at');
  addSources(manifest, 'evidence', 'evidence', evidence, r => r.filename, 'uploaded_at');
  addSources(manifest, 'governance', 'document', documents, r => r.name, 'updated_at');
  addSources(manifest, 'governance', 'audit', audits, r => r.title, 'created_at');
  addSources(manifest, 'governance', 'management_review', mrms, r => `Management review ${date(r.meeting_date)}`, 'created_at');
  addSources(manifest, 'nonconformities', 'nonconformity', ncs, r => r.title, 'created_at');

  const implemented = controls.filter(r => /implemented|approved|effective|complete/i.test(r.status || '')).length;
  const partial = controls.filter(r => /partial|progress/i.test(r.status || '')).length;
  const openRisks = risks.filter(r => !/closed|treated/i.test(r.status || ''));
  const criticalRisks = openRisks.filter(r => num(r.residual_likelihood || r.likelihood) * num(r.residual_impact || r.impact) >= 16);
  const liveEvidence = evidence.filter(r => !r.superseded_at);
  const expiredEvidence = liveEvidence.filter(r => r.valid_until && String(r.valid_until).slice(0,10) < new Date().toISOString().slice(0,10));
  const openNcs = ncs.filter(r => !/closed|verified/i.test(r.status || ''));
  const stats = {
    controls_total: controls.length,
    controls_implemented: implemented,
    controls_partial: partial,
    controls_not_ready: Math.max(0, controls.length - implemented - partial),
    readiness_pct: controls.length ? Math.round(((implemented + partial * .5) / controls.length) * 100) : 0,
    risks_open: openRisks.length,
    risks_critical: criticalRisks.length,
    evidence_current: liveEvidence.length - expiredEvidence.length,
    evidence_expired: expiredEvidence.length,
    ncs_open: openNcs.length,
    ncs_major: openNcs.filter(r => String(r.severity).toLowerCase() === 'major').length,
    audits_complete: audits.filter(r => /complete|closed|issued/i.test(`${r.status} ${r.lifecycle_stage}`)).length,
    documents_approved: documents.filter(r => /approved|published/i.test(r.status || '')).length,
    documents_total: documents.filter(r => !r.retired_at).length
  };
  return { workspace, controls, risks, evidence, documents, audits, mrms, ncs, stats };
}

function supplierData(db, wsId, supplierId, manifest) {
  const supplier = db.prepare(`SELECT * FROM suppliers WHERE id=? AND workspace_id=? AND archived_at IS NULL`).get(supplierId, wsId);
  if (!supplier) throw new Error('supplier_not_found');
  const riskSnapshots = db.prepare(`SELECT * FROM supplier_risk_snapshots WHERE supplier_id=? AND workspace_id=? ORDER BY recorded_at DESC,id DESC`).all(supplierId, wsId);
  const decisions = db.prepare(`SELECT sd.*,u.name AS actor_name FROM supplier_decisions sd LEFT JOIN users u ON u.id=sd.decided_by WHERE sd.supplier_id=? AND sd.workspace_id=? ORDER BY sd.decided_at DESC,sd.id DESC`).all(supplierId, wsId);
  const questionnaires = db.prepare(`SELECT * FROM supplier_questionnaires WHERE supplier_id=? AND workspace_id=? ORDER BY created_at DESC,id DESC`).all(supplierId, wsId);
  const responses = questionnaires.length ? db.prepare(`SELECT r.*,q.question,q.section,q.iso_control_ref FROM supplier_questionnaire_responses r LEFT JOIN questionnaire_questions q ON q.id=r.question_id WHERE r.questionnaire_id IN (${questionnaires.map(() => '?').join(',')}) ORDER BY r.questionnaire_id,q.question_order,r.id`).all(...questionnaires.map(q => q.id)) : [];
  const documents = db.prepare(`SELECT id,doc_type,name,filename,sha256,size_bytes,effective_date,expiry_date,notes,uploaded_at FROM supplier_documents WHERE supplier_id=? AND workspace_id=? ORDER BY uploaded_at DESC,id DESC`).all(supplierId, wsId);
  const subprocessors = db.prepare(`SELECT * FROM supplier_subprocessors WHERE supplier_id=? AND workspace_id=? ORDER BY name,id`).all(supplierId, wsId);
  const clauses = db.prepare(`SELECT * FROM supplier_clauses WHERE supplier_id=? AND workspace_id=? ORDER BY clause_label,id`).all(supplierId, wsId);
  const reviews = db.prepare(`SELECT * FROM supplier_reviews WHERE supplier_id=? AND workspace_id=? ORDER BY review_date DESC,id DESC`).all(supplierId, wsId);
  const monitoring = db.prepare(`SELECT * FROM supplier_monitoring WHERE supplier_id=? AND workspace_id=? ORDER BY recorded_at DESC,id DESC`).all(supplierId, wsId);
  const findings = db.prepare(`SELECT f.*,l.questionnaire_id,l.domain,l.due_date,l.owner_name,l.risk_acceptance_reason,l.risk_acceptance_expires_at,l.accepted_at FROM findings f JOIN supplier_finding_links l ON l.finding_id=f.id WHERE l.supplier_id=? AND f.workspace_id=? ORDER BY f.created_at DESC,f.id DESC`).all(supplierId, wsId);

  addSources(manifest, 'supplier_profile', 'supplier', [supplier], r => r.name, 'created_at');
  addSources(manifest, 'risk_assessment', 'supplier_risk_snapshot', riskSnapshots, r => `Risk snapshot #${r.id}`, 'recorded_at');
  addSources(manifest, 'questionnaire', 'supplier_questionnaire', questionnaires, r => r.template_name || `Questionnaire #${r.id}`, 'created_at');
  addSources(manifest, 'questionnaire', 'supplier_response', responses, r => r.question || `Response #${r.id}`, 'created_at');
  addSources(manifest, 'evidence', 'supplier_document', documents, r => r.name, 'uploaded_at');
  addSources(manifest, 'supplier_profile', 'subprocessor', subprocessors, r => r.name, 'created_at');
  addSources(manifest, 'supplier_profile', 'contract_clause', clauses, r => r.clause_label, 'reviewed_at');
  addSources(manifest, 'decision', 'supplier_decision', decisions, r => `${r.decision} ${date(r.decided_at)}`, 'decided_at');
  addSources(manifest, 'monitoring', 'supplier_review', reviews, r => `Review ${date(r.review_date)}`, 'created_at');
  addSources(manifest, 'monitoring', 'supplier_monitoring', monitoring, r => `${r.source || 'Monitoring'} ${date(r.recorded_at)}`, 'recorded_at');
  addSources(manifest, 'findings', 'supplier_finding', findings, r => r.title, 'created_at');
  return { supplier, riskSnapshots, decisions, questionnaires, responses, documents, subprocessors, clauses, reviews, monitoring, findings };
}

function qualityChecks(key, data) {
  const q = [];
  const add = (severity, code, message, href) => q.push({ severity, code, message, href });
  const c = data.common;
  if (!c.workspace.scope || !c.workspace.scope_confirmed_at) add('critical', 'scope_unconfirmed', 'The ISMS scope is missing or not formally confirmed.', `/workspaces/${c.workspace.id}/intake`);
  if (!c.controls.length) add('critical', 'controls_missing', 'No control-state records are available for this workspace.', `/workspaces/${c.workspace.id}/controls`);
  if (key === 'executive_posture') {
    if (c.stats.risks_critical) add('warning', 'critical_risks', `${c.stats.risks_critical} critical residual risk(s) remain open.`, `/workspaces/${c.workspace.id}/risks`);
    if (!c.audits.length) add('warning', 'audit_missing', 'No internal audit has been recorded.', `/workspaces/${c.workspace.id}/audits`);
    if (!c.mrms.length) add('warning', 'mrm_missing', 'No management review has been recorded.', `/workspaces/${c.workspace.id}/mrms`);
  }
  if (key === 'audit_readiness') {
    const undecided = c.controls.filter(r => !r.applicability || r.applicability === 'undecided').length;
    const noJustification = c.controls.filter(r => r.applicability === 'included' && !r.inclusion_justification || r.applicability === 'excluded' && !r.exclusion_justification).length;
    if (undecided) add('critical', 'soa_undecided', `${undecided} SoA item(s) have no applicability decision.`, `/workspaces/${c.workspace.id}/soa`);
    if (noJustification) add('warning', 'soa_justification', `${noJustification} SoA decision(s) are missing justification.`, `/workspaces/${c.workspace.id}/soa`);
    if (c.stats.documents_total && c.stats.documents_approved < c.stats.documents_total) add('warning', 'documents_unapproved', `${c.stats.documents_total - c.stats.documents_approved} controlled document(s) are not approved or published.`, `/workspaces/${c.workspace.id}/documents`);
    if (!c.audits.length) add('critical', 'audit_missing', 'No internal audit has been recorded.', `/workspaces/${c.workspace.id}/audits`);
    if (!c.mrms.length) add('critical', 'mrm_missing', 'No management review has been recorded.', `/workspaces/${c.workspace.id}/mrms`);
    if (c.stats.ncs_major) add('critical', 'major_nc_open', `${c.stats.ncs_major} major nonconformity record(s) remain open.`, `/workspaces/${c.workspace.id}/nonconformities`);
    if (!c.evidence.length) add('critical', 'evidence_missing', 'No evidence items are available.', `/workspaces/${c.workspace.id}/evidence`);
  }
  if (key === 'supplier_due_diligence') {
    const s = data.supplier;
    if (!s.supplier.business_owner) add('critical', 'business_owner_missing', 'The supplier has no accountable business owner.', `/workspaces/${c.workspace.id}/vendors/${s.supplier.id}`);
    if (!s.riskSnapshots.length) add('critical', 'risk_snapshot_missing', 'No versioned supplier risk assessment exists.', `/workspaces/${c.workspace.id}/vendors/${s.supplier.id}`);
    if (!s.decisions.find(d => !d.superseded_at)) add('critical', 'decision_missing', 'No current supplier approval decision exists.', `/workspaces/${c.workspace.id}/vendors/${s.supplier.id}`);
    if (!s.questionnaires.find(qr => qr.reviewed_at || qr.status === 'reviewed')) add('warning', 'questionnaire_unreviewed', 'No supplier questionnaire has completed internal review.', `/workspaces/${c.workspace.id}/vendors/${s.supplier.id}`);
    if (!s.documents.length) add('warning', 'supplier_evidence_missing', 'No supplier assurance documents are attached.', `/workspaces/${c.workspace.id}/vendors/${s.supplier.id}`);
    if (s.findings.some(f => !/closed|resolved/i.test(f.status || '') && /high|critical/i.test(f.severity || ''))) add('critical', 'high_findings_open', 'High or critical supplier findings remain open.', `/workspaces/${c.workspace.id}/vendors/${s.supplier.id}`);
    if (!s.supplier.exit_strategy) add('warning', 'exit_strategy_missing', 'No supplier exit strategy is documented.', `/workspaces/${c.workspace.id}/vendors/${s.supplier.id}`);
  }
  if (!q.length) add('pass', 'quality_pass', 'No blocking data-quality issues were detected.', null);
  return q;
}

function buildSnapshot(db, wsId, key, config) {
  const definition = REPORTS[key];
  if (!definition) throw new Error('report_type_invalid');
  const manifest = [];
  const common = commonData(db, wsId, manifest);
  const supplier = key === 'supplier_due_diligence' ? supplierData(db, wsId, Number(config.supplier_id), manifest) : null;
  const generatedAt = new Date().toISOString();
  const snapshot = {
    schema_version: 1,
    report_key: key,
    generated_at: generatedAt,
    cutoff_at: config.cutoff_at || generatedAt,
    reporting_period: { start: config.reporting_period_start || null, end: config.reporting_period_end || null },
    metadata: {
      title: config.title || definition.name,
      audience: config.audience || definition.audience,
      classification: config.classification || 'Confidential',
      watermark: config.watermark || '',
      prepared_for: config.prepared_for || common.workspace.client_name,
      prepared_by: config.prepared_by || common.workspace.firm_name,
      framework: config.framework || 'ISO/IEC 27001:2022',
      scope_label: config.scope_label || common.workspace.scope || 'Organisation-wide ISMS scope',
      executive_summary: config.executive_summary || '',
      selected_sections: config.selected_sections && config.selected_sections.length ? config.selected_sections : definition.sections
    },
    common,
    supplier
  };
  const quality = qualityChecks(key, snapshot);
  return { definition, snapshot, quality, manifest, snapshotHash: sha(stableStringify(snapshot)) };
}

function badge(value, kind) { return `<span class="badge ${kind || ''}">${e(value)}</span>`; }
function td(v) { return `<td>${v == null || v === '' ? '—' : e(v)}</td>`; }
function table(headers, rows, empty) {
  if (!rows || !rows.length) return `<div class="empty">${e(empty || 'No records in the frozen snapshot.')}</div>`;
  return `<table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function metric(label, value, note) { return `<div class="metric"><div class="metric-label">${e(label)}</div><div class="metric-value">${e(value)}</div>${note ? `<div class="metric-note">${e(note)}</div>` : ''}</div>`; }
function section(title, kicker, body) { return `<section><div class="section-kicker">${e(kicker || '')}</div><h2>${e(title)}</h2>${body}</section>`; }

function reportBody(run, snapshot, quality, manifest) {
  const c = snapshot.common;
  const s = snapshot.supplier;
  const selected = new Set(snapshot.metadata.selected_sections || []);
  const out = [];
  if (selected.has('executive_summary')) {
    const summary = snapshot.metadata.executive_summary || (snapshot.report_key === 'supplier_due_diligence'
      ? `${s.supplier.name} is assessed at ${s.supplier.residual_risk_score == null ? 'an unrecorded' : s.supplier.residual_risk_score} residual risk score. This report preserves the evidence and decision context available at the cutoff date.`
      : `${c.workspace.client_name} has ${c.stats.readiness_pct}% calculated control readiness at the reporting cutoff, with ${c.stats.risks_critical} critical residual risks and ${c.stats.ncs_open} open nonconformities.`);
    out.push(section('Executive summary', 'Decision context', `<p class="lead">${e(summary)}</p><div class="quality ${quality.some(q => q.severity === 'critical') ? 'quality-warn' : ''}"><strong>Data-quality assessment</strong><ul>${quality.map(q => `<li><span class="quality-dot ${e(q.severity)}"></span>${e(q.message)}</li>`).join('')}</ul></div>`));
  }
  if (selected.has('posture')) out.push(section('Security posture', 'Control environment', `<div class="metrics">${metric('Readiness', `${c.stats.readiness_pct}%`, `${c.stats.controls_implemented} of ${c.stats.controls_total} implemented`)}${metric('Open risks', c.stats.risks_open, `${c.stats.risks_critical} critical`)}${metric('Current evidence', c.stats.evidence_current, `${c.stats.evidence_expired} expired`)}${metric('Open NCs', c.stats.ncs_open, `${c.stats.ncs_major} major`)}</div>${table(['Control state','Count','Share'], [['Implemented',c.stats.controls_implemented],['Partially implemented',c.stats.controls_partial],['Not ready',c.stats.controls_not_ready]].map(r => `<tr>${td(r[0])}${td(r[1])}${td(c.stats.controls_total ? `${Math.round(r[1]/c.stats.controls_total*100)}%` : '0%')}</tr>`))}`));
  if (selected.has('priority_risks')) out.push(section('Priority risks', 'Management attention', table(['Risk','Owner','Residual score','Treatment','Status'], c.risks.slice(0,12).map(r => `<tr>${td(r.title)}${td(r.owner_name)}${td(num(r.residual_likelihood || r.likelihood)*num(r.residual_impact || r.impact))}${td(r.treatment)}${td(r.status)}</tr>`), 'No risks recorded.')));
  if (selected.has('assurance')) out.push(section('Assurance activity', 'Governance signal', `<div class="metrics">${metric('Audits complete', c.stats.audits_complete, `${c.audits.length} recorded`)}${metric('Management reviews', c.mrms.length, c.mrms[0] ? `Latest ${date(c.mrms[0].meeting_date)}` : 'None recorded')}${metric('Approved documents', c.stats.documents_approved, `${c.stats.documents_total} active documents`)}</div>${table(['Activity','Date','Status','Outcome'], [...c.audits.slice(0,6).map(a => ({a:a.title,d:a.audit_date,s:a.status,o:a.summary})),...c.mrms.slice(0,4).map(m => ({a:'Management review',d:m.meeting_date,s:m.status,o:m.decisions}))].map(r => `<tr>${td(r.a)}${td(date(r.d))}${td(r.s)}${td(r.o)}</tr>`), 'No assurance activity recorded.')}`));
  if (selected.has('management_attention')) out.push(section('Management attention', 'Required decisions', table(['Priority','Issue','Owner / action'], [
    ...c.risks.filter(r => num(r.residual_likelihood || r.likelihood)*num(r.residual_impact || r.impact)>=12 && !/closed|treated/i.test(r.status || '')).slice(0,8).map(r => `<tr>${td('Risk')}${td(r.title)}${td(r.owner_name || r.treatment)}</tr>`),
    ...c.ncs.filter(r => !/closed|verified/i.test(r.status || '')).slice(0,8).map(r => `<tr>${td(`NC · ${r.severity}`)}${td(r.title)}${td(r.responsible || `Due ${date(r.due_date)}`)}</tr>`)
  ], 'No priority decisions were identified.')));
  if (selected.has('scope')) out.push(section('Scope and report basis', 'Audit boundary', `<dl class="facts"><div><dt>ISMS scope</dt><dd>${e(c.workspace.scope || 'Not documented')}</dd></div><div><dt>Framework</dt><dd>${e(snapshot.metadata.framework)}</dd></div><div><dt>Reporting period</dt><dd>${e(date(snapshot.reporting_period.start))} to ${e(date(snapshot.reporting_period.end))}</dd></div><div><dt>Data cutoff</dt><dd>${e(snapshot.cutoff_at)}</dd></div></dl>`));
  if (selected.has('soa')) out.push(section('Statement of Applicability', 'Decision completeness', `<div class="metrics">${metric('Total controls', c.controls.length)}${metric('Included', c.controls.filter(r=>r.applicability==='included').length)}${metric('Excluded', c.controls.filter(r=>r.applicability==='excluded').length)}${metric('Undecided', c.controls.filter(r=>!r.applicability||r.applicability==='undecided').length)}</div>${table(['Reference','Control','Applicability','Status','Justification'], c.controls.map(r => `<tr>${td(r.iso_item_id)}${td(r.title)}${td(r.applicability)}${td(r.status)}${td(r.applicability==='excluded'?r.exclusion_justification:r.inclusion_justification)}</tr>`))}`));
  if (selected.has('controls')) out.push(section('Control implementation', 'Frozen control register', table(['Reference','Control','Status','Maturity','Last updated'], c.controls.map(r => `<tr>${td(r.iso_item_id)}${td(r.title)}${td(r.status)}${td(r.maturity)}${td(date(r.last_updated))}</tr>`))));
  if (selected.has('evidence') && !s) out.push(section('Evidence index', 'Metadata and integrity', table(['Evidence','Control','SHA-256','Validity','Uploaded'], c.evidence.map(r => `<tr>${td(r.filename)}${td(r.iso_item_id)}${td(r.sha256 ? r.sha256.slice(0,16)+'…' : '')}${td(`${date(r.valid_from)} – ${date(r.valid_until)}`)}${td(date(r.uploaded_at))}</tr>`), 'No evidence recorded.')));
  if (selected.has('governance')) out.push(section('Governance evidence', 'Audit and management review', `${table(['Audit','Date','Lifecycle','Report issued'], c.audits.map(r => `<tr>${td(r.title)}${td(date(r.audit_date))}${td(r.lifecycle_stage || r.status)}${td(date(r.report_issued_at))}</tr>`), 'No audits recorded.')}${table(['Management review','Status','Decisions','Actions'], c.mrms.map(r => `<tr>${td(date(r.meeting_date))}${td(r.status)}${td(r.decisions)}${td(r.action_items)}</tr>`), 'No management reviews recorded.')}`));
  if (selected.has('nonconformities')) out.push(section('Nonconformities', 'Corrective action status', table(['NC','Severity','Status','Owner','Due'], c.ncs.map(r => `<tr>${td(r.title)}${td(r.severity)}${td(r.status)}${td(r.responsible)}${td(date(r.due_date))}</tr>`), 'No nonconformities recorded.')));
  if (s && selected.has('supplier_profile')) out.push(section('Supplier profile', 'Third-party context', `<dl class="facts"><div><dt>Supplier</dt><dd>${e(s.supplier.name)}</dd></div><div><dt>Service</dt><dd>${e(s.supplier.service_provided)}</dd></div><div><dt>Tier</dt><dd>${e(s.supplier.tier)}</dd></div><div><dt>Business owner</dt><dd>${e(s.supplier.business_owner || 'Not assigned')}</dd></div><div><dt>Data access</dt><dd>${e(s.supplier.data_access)}</dd></div><div><dt>Hosting locations</dt><dd>${e(s.supplier.hosting_locations || 'Not documented')}</dd></div><div><dt>Critical processes</dt><dd>${e(s.supplier.critical_processes || 'Not documented')}</dd></div><div><dt>Exit strategy</dt><dd>${e(s.supplier.exit_strategy || 'Not documented')}</dd></div></dl>${table(['Subprocessor','Service','Data access','Location','Approved'], s.subprocessors.map(r => `<tr>${td(r.name)}${td(r.service_provided)}${td(r.data_access)}${td(r.location)}${td(r.approved ? 'Yes' : 'No')}</tr>`), 'No subprocessors declared.')}`));
  if (s && selected.has('risk_assessment')) { const latest=s.riskSnapshots[0]; out.push(section('Risk assessment', 'Versioned methodology', latest ? `<div class="metrics">${metric('Inherent risk', latest.inherent_score)}${metric('Control effectiveness', `${latest.control_effectiveness}%`)}${metric('Residual risk', latest.effective_residual_score)}${metric('Risk band', latest.risk_band)}</div><p>${e(latest.rationale || 'No additional rationale recorded.')}</p>${table(['Version','Recorded','Residual','Band','Event'], s.riskSnapshots.map(r => `<tr>${td(r.methodology_version)}${td(date(r.recorded_at))}${td(r.effective_residual_score)}${td(r.risk_band)}${td(r.event_type)}</tr>`))}` : '<div class="empty">No versioned risk assessment exists.</div>')); }
  if (s && selected.has('questionnaire')) out.push(section('Questionnaire assessment', 'Supplier response and review', `${table(['Questionnaire','Status','Progress','Score','Reviewed'], s.questionnaires.map(r => `<tr>${td(r.template_name)}${td(r.invitation_status || r.status)}${td(`${r.answered_questions}/${r.total_questions}`)}${td(r.score)}${td(date(r.reviewed_at))}</tr>`), 'No questionnaire exists.')}${table(['Domain','Question','Answer','Comment'], s.responses.map(r => `<tr>${td(r.section)}${td(r.question)}${td(r.answer)}${td(r.comment)}</tr>`), 'No supplier responses recorded.')}`));
  if (s && selected.has('evidence')) out.push(section('Supplier evidence', 'Document integrity and currency', table(['Document','Type','Effective','Expires','SHA-256'], s.documents.map(r => `<tr>${td(r.name)}${td(r.doc_type)}${td(date(r.effective_date))}${td(date(r.expiry_date))}${td(r.sha256 ? r.sha256.slice(0,16)+'…' : '')}</tr>`), 'No supplier assurance documents attached.')));
  if (s && selected.has('findings')) out.push(section('Findings and exceptions', 'Remediation and acceptance', table(['Finding','Severity','Status','Domain','Owner','Due'], s.findings.map(r => `<tr>${td(r.title)}${td(r.severity)}${td(r.status)}${td(r.domain)}${td(r.owner_name)}${td(date(r.due_date))}</tr>`), 'No supplier findings recorded.')));
  if (s && selected.has('decision')) out.push(section('Approval decision', 'Accountable risk acceptance', table(['Decision','Date','Decider','Residual risk','Valid until','Rationale'], s.decisions.map(r => `<tr>${td(r.decision)}${td(date(r.decided_at))}${td(r.decider_name || r.actor_name)}${td(r.residual_risk_score)}${td(date(r.valid_until))}${td(r.rationale)}</tr>`), 'No approval decision recorded.')));
  if (s && selected.has('monitoring')) out.push(section('Ongoing monitoring', 'Review history', `${table(['Review date','Reviewer','Outcome','Residual risk','Next review'], s.reviews.map(r => `<tr>${td(date(r.review_date))}${td(r.reviewer)}${td(r.outcome)}${td(r.residual_risk)}${td(date(r.next_review_date))}</tr>`), 'No periodic reviews recorded.')}${table(['Signal','Date','Score','Grade','Notes'], s.monitoring.map(r => `<tr>${td(r.source)}${td(date(r.recorded_at))}${td(r.score)}${td(r.grade)}${td(r.notes)}</tr>`), 'No monitoring signals recorded.')}`));
  if (selected.has('source_manifest')) out.push(section('Source manifest', 'Lineage and integrity', `<p>This frozen report is backed by ${manifest.length} source records. Each digest is calculated from the record values captured when the report was generated.</p>${table(['Section','Source','Record','Digest','Updated'], manifest.map(r => `<tr>${td(r.section_key)}${td(r.source_type)}${td(r.source_label)}${td(r.source_hash.slice(0,16)+'…')}${td(date(r.source_updated_at))}</tr>`))}`));
  return out.join('');
}

function styleBlock() {
  return `<style>
    :root{--ink:#18212b;--muted:#667085;--line:#d9dee7;--accent:#6f1d2b;--soft:#f5f2f0;--good:#217a50;--warn:#a15c00}
    *{box-sizing:border-box}body{margin:0;color:var(--ink);font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;line-height:1.45;background:#fff}
    .cover{min-height:245mm;padding:25mm 19mm 20mm;display:flex;flex-direction:column;border-top:9mm solid var(--accent);page-break-after:always}.brand{font-size:10pt;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--accent)}.cover h1{font-family:Georgia,serif;font-size:35pt;line-height:1.05;margin:38mm 0 8mm;max-width:150mm}.cover-deck{font-size:15pt;color:var(--muted);max-width:145mm}.cover-meta{margin-top:auto;border-top:1px solid var(--line);padding-top:8mm;display:grid;grid-template-columns:1fr 1fr;gap:5mm 14mm}.cover-meta span{display:block;font-size:8pt;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
    main{padding:0 4mm}section{page-break-before:always;padding-top:4mm}section:first-child{page-break-before:auto}h2{font-family:Georgia,serif;font-size:22pt;line-height:1.15;margin:2mm 0 7mm;color:var(--ink)}.section-kicker{font-size:8pt;font-weight:700;color:var(--accent);letter-spacing:.1em;text-transform:uppercase}.lead{font-size:13pt;line-height:1.55;max-width:165mm}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:6mm 0}.metric{border:1px solid var(--line);border-top:2px solid var(--accent);padding:4mm;min-height:25mm}.metric-label{font-size:8pt;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.metric-value{font-family:Georgia,serif;font-size:22pt;font-weight:700}.metric-note{font-size:8pt;color:var(--muted)}
    table{width:100%;border-collapse:collapse;margin:5mm 0 8mm;font-size:8.5pt;page-break-inside:auto}tr{page-break-inside:avoid}th{background:#27313d;color:#fff;text-align:left;padding:2.8mm 2.3mm;font-size:7.5pt;letter-spacing:.03em}td{border-bottom:1px solid var(--line);vertical-align:top;padding:2.5mm 2.3mm}tbody tr:nth-child(even){background:#f8f9fb}.empty{padding:8mm;border:1px dashed var(--line);color:var(--muted);background:#fafafa}.facts{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--line)}.facts div{padding:4mm;border-bottom:1px solid var(--line)}.facts dt{font-size:8pt;text-transform:uppercase;color:var(--muted);letter-spacing:.04em}.facts dd{margin:1mm 0 0;font-weight:600}.quality{margin:8mm 0;padding:5mm;border-left:3px solid var(--good);background:#f1f8f4}.quality-warn{border-color:var(--warn);background:#fff8ec}.quality ul{margin:3mm 0 0;padding-left:5mm}.quality-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--good);margin-right:5px}.quality-dot.critical{background:#b42318}.quality-dot.warning{background:var(--warn)}.report-footer-note{margin-top:12mm;padding-top:4mm;border-top:1px solid var(--line);font-size:8pt;color:var(--muted)}.watermark{position:fixed;z-index:99;top:43%;left:10%;width:80%;transform:rotate(-28deg);text-align:center;font-size:50pt;font-weight:800;letter-spacing:.08em;color:rgba(111,29,43,.09);pointer-events:none;text-transform:uppercase}
    @page{size:A4;margin:22mm 16mm 20mm}@media print{.cover{margin:-22mm -16mm -20mm}.no-print{display:none!important}}
  </style>`;
}

function renderHtml(run, snapshot, quality, manifest) {
  const ws = snapshot.common.workspace;
  const body = reportBody(run, snapshot, quality, manifest);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(run.title)}</title>${styleBlock()}</head><body>${snapshot.metadata.watermark ? `<div class="watermark">${e(snapshot.metadata.watermark)}</div>` : ''}
    <div class="cover"><div class="brand">${e(ws.brand_display_name || ws.firm_name)}</div><h1>${e(run.title)}</h1><div class="cover-deck">${e(REPORTS[snapshot.report_key].short)}</div><div class="cover-meta"><div><span>Prepared for</span>${e(snapshot.metadata.prepared_for)}</div><div><span>Prepared by</span>${e(snapshot.metadata.prepared_by)}</div><div><span>Reporting period</span>${e(date(snapshot.reporting_period.start))} to ${e(date(snapshot.reporting_period.end))}</div><div><span>Data cutoff</span>${e(snapshot.cutoff_at)}</div><div><span>Classification</span>${e(snapshot.metadata.classification)}</div><div><span>Report version</span>v${e(run.version_number)} · ${e(run.status)}</div></div></div>
    <main>${body}<div class="report-footer-note">Frozen snapshot ${e(run.snapshot_hash)} · Generated ${e(run.generated_at)} · Report ID ${e(run.id)}</div></main>
  </body></html>`;
}

function docFacts(rows) {
  return `<table class="facts-table"><tbody>${rows.map(r => `<tr><th>${e(r[0])}</th><td>${e(r[1] == null || r[1] === '' ? '—' : r[1])}</td></tr>`).join('')}</tbody></table>`;
}

function docMetrics(rows) {
  return `<table class="metric-table"><thead><tr>${rows.map(r => `<th>${e(r[0])}</th>`).join('')}</tr></thead><tbody><tr>${rows.map(r => `<td><strong>${e(r[1])}</strong>${r[2] ? `<br><span>${e(r[2])}</span>` : ''}</td>`).join('')}</tr></tbody></table>`;
}

function docSection(title, kicker, body, pageBreak) {
  return `<div class="doc-section"${pageBreak ? ' style="page-break-before:always"' : ''}><p class="kicker">${e(kicker || '')}</p><h2>${e(title)}</h2>${body}</div>`;
}

function docxReportBody(run, snapshot, quality, manifest) {
  const c = snapshot.common;
  const s = snapshot.supplier;
  const selected = new Set(snapshot.metadata.selected_sections || []);
  const out = [];
  const summary = snapshot.metadata.executive_summary || (snapshot.report_key === 'supplier_due_diligence'
    ? `${s.supplier.name} is assessed at ${s.supplier.residual_risk_score == null ? 'an unrecorded' : s.supplier.residual_risk_score} residual risk score. This report preserves the evidence and decision context available at the cutoff date.`
    : `${c.workspace.client_name} has ${c.stats.readiness_pct}% calculated control readiness at the reporting cutoff, with ${c.stats.risks_critical} critical residual risks and ${c.stats.ncs_open} open nonconformities.`);
  if (selected.has('executive_summary')) out.push(docSection('Executive summary', 'Decision context', `<p class="lead">${e(summary)}</p><div class="quality"><strong>Data-quality assessment</strong><ul>${quality.map(q => `<li><strong>${e(q.severity.toUpperCase())}:</strong> ${e(q.message)}</li>`).join('')}</ul></div>`, false));
  if (selected.has('posture')) out.push(docSection('Security posture', 'Control environment', `${docMetrics([['Readiness',`${c.stats.readiness_pct}%`,`${c.stats.controls_implemented} of ${c.stats.controls_total} implemented`],['Open risks',c.stats.risks_open,`${c.stats.risks_critical} critical`],['Current evidence',c.stats.evidence_current,`${c.stats.evidence_expired} expired`],['Open NCs',c.stats.ncs_open,`${c.stats.ncs_major} major`]])}${table(['Control state','Count','Share'], [['Implemented',c.stats.controls_implemented],['Partially implemented',c.stats.controls_partial],['Not ready',c.stats.controls_not_ready]].map(r => `<tr>${td(r[0])}${td(r[1])}${td(c.stats.controls_total ? `${Math.round(r[1]/c.stats.controls_total*100)}%` : '0%')}</tr>`))}`, true));
  if (selected.has('priority_risks')) out.push(docSection('Priority risks', 'Management attention', table(['Risk','Owner','Residual score','Treatment','Status'], c.risks.slice(0,12).map(r => `<tr>${td(r.title)}${td(r.owner_name)}${td(num(r.residual_likelihood || r.likelihood)*num(r.residual_impact || r.impact))}${td(r.treatment)}${td(r.status)}</tr>`), 'No risks recorded.'), true));
  if (selected.has('assurance')) out.push(docSection('Assurance activity', 'Governance signal', `${docMetrics([['Audits complete',c.stats.audits_complete,`${c.audits.length} recorded`],['Management reviews',c.mrms.length,c.mrms[0]?`Latest ${date(c.mrms[0].meeting_date)}`:'None recorded'],['Approved documents',c.stats.documents_approved,`${c.stats.documents_total} active documents`]])}${table(['Activity','Date','Status','Outcome'], [...c.audits.slice(0,6).map(a=>({a:a.title,d:a.audit_date,s:a.status,o:a.summary})),...c.mrms.slice(0,4).map(m=>({a:'Management review',d:m.meeting_date,s:m.status,o:m.decisions}))].map(r=>`<tr>${td(r.a)}${td(date(r.d))}${td(r.s)}${td(r.o)}</tr>`), 'No assurance activity recorded.')}`, true));
  if (selected.has('management_attention')) out.push(docSection('Management attention', 'Required decisions', table(['Priority','Issue','Owner / action'], [...c.risks.filter(r=>num(r.residual_likelihood||r.likelihood)*num(r.residual_impact||r.impact)>=12&&!/closed|treated/i.test(r.status||'')).slice(0,8).map(r=>`<tr>${td('Risk')}${td(r.title)}${td(r.owner_name||r.treatment)}</tr>`),...c.ncs.filter(r=>!/closed|verified/i.test(r.status||'')).slice(0,8).map(r=>`<tr>${td(`NC · ${r.severity}`)}${td(r.title)}${td(r.responsible||`Due ${date(r.due_date)}`)}</tr>`)], 'No priority decisions were identified.'), true));
  if (selected.has('scope')) out.push(docSection('Scope and report basis', 'Audit boundary', docFacts([['ISMS scope',c.workspace.scope||'Not documented'],['Framework',snapshot.metadata.framework],['Reporting period',`${date(snapshot.reporting_period.start)} to ${date(snapshot.reporting_period.end)}`],['Data cutoff',snapshot.cutoff_at]]), true));
  if (selected.has('soa')) out.push(docSection('Statement of Applicability', 'Decision completeness', `${docMetrics([['Total controls',c.controls.length],['Included',c.controls.filter(r=>r.applicability==='included').length],['Excluded',c.controls.filter(r=>r.applicability==='excluded').length],['Undecided',c.controls.filter(r=>!r.applicability||r.applicability==='undecided').length]])}${table(['Reference','Control','Applicability','Status','Justification'],c.controls.map(r=>`<tr>${td(r.iso_item_id)}${td(r.title)}${td(r.applicability)}${td(r.status)}${td(r.applicability==='excluded'?r.exclusion_justification:r.inclusion_justification)}</tr>`))}`, true));
  if (selected.has('controls')) out.push(docSection('Control implementation', 'Frozen control register', table(['Reference','Control','Status','Maturity','Last updated'],c.controls.map(r=>`<tr>${td(r.iso_item_id)}${td(r.title)}${td(r.status)}${td(r.maturity)}${td(date(r.last_updated))}</tr>`)), true));
  if (selected.has('evidence') && !s) out.push(docSection('Evidence index', 'Metadata and integrity', table(['Evidence','Control','SHA-256','Validity','Uploaded'],c.evidence.map(r=>`<tr>${td(r.filename)}${td(r.iso_item_id)}${td(r.sha256?r.sha256.slice(0,16)+'…':'')}${td(`${date(r.valid_from)} – ${date(r.valid_until)}`)}${td(date(r.uploaded_at))}</tr>`),'No evidence recorded.'), true));
  if (selected.has('governance')) out.push(docSection('Governance evidence', 'Audit and management review', `${table(['Audit','Date','Lifecycle','Report issued'],c.audits.map(r=>`<tr>${td(r.title)}${td(date(r.audit_date))}${td(r.lifecycle_stage||r.status)}${td(date(r.report_issued_at))}</tr>`),'No audits recorded.')}${table(['Management review','Status','Decisions','Actions'],c.mrms.map(r=>`<tr>${td(date(r.meeting_date))}${td(r.status)}${td(r.decisions)}${td(r.action_items)}</tr>`),'No management reviews recorded.')}`, true));
  if (selected.has('nonconformities')) out.push(docSection('Nonconformities', 'Corrective action status', table(['NC','Severity','Status','Owner','Due'],c.ncs.map(r=>`<tr>${td(r.title)}${td(r.severity)}${td(r.status)}${td(r.responsible)}${td(date(r.due_date))}</tr>`),'No nonconformities recorded.'), true));
  if (s && selected.has('supplier_profile')) out.push(docSection('Supplier profile', 'Third-party context', `${docFacts([['Supplier',s.supplier.name],['Service',s.supplier.service_provided],['Tier',s.supplier.tier],['Business owner',s.supplier.business_owner||'Not assigned'],['Data access',s.supplier.data_access],['Hosting locations',s.supplier.hosting_locations||'Not documented'],['Critical processes',s.supplier.critical_processes||'Not documented'],['Exit strategy',s.supplier.exit_strategy||'Not documented']])}${table(['Subprocessor','Service','Data access','Location','Approved'],s.subprocessors.map(r=>`<tr>${td(r.name)}${td(r.service_provided)}${td(r.data_access)}${td(r.location)}${td(r.approved?'Yes':'No')}</tr>`),'No subprocessors declared.')}`, true));
  if (s && selected.has('risk_assessment')) { const latest=s.riskSnapshots[0]; out.push(docSection('Risk assessment','Versioned methodology',latest?`${docMetrics([['Inherent risk',latest.inherent_score],['Control effectiveness',`${latest.control_effectiveness}%`],['Residual risk',latest.effective_residual_score],['Risk band',latest.risk_band]])}<p>${e(latest.rationale||'No additional rationale recorded.')}</p>${table(['Version','Recorded','Residual','Band','Event'],s.riskSnapshots.map(r=>`<tr>${td(r.methodology_version)}${td(date(r.recorded_at))}${td(r.effective_residual_score)}${td(r.risk_band)}${td(r.event_type)}</tr>`))}`:'<p>No versioned risk assessment exists.</p>',true)); }
  if (s && selected.has('questionnaire')) out.push(docSection('Questionnaire assessment','Supplier response and review',`${table(['Questionnaire','Status','Progress','Score','Reviewed'],s.questionnaires.map(r=>`<tr>${td(r.template_name)}${td(r.invitation_status||r.status)}${td(`${r.answered_questions}/${r.total_questions}`)}${td(r.score)}${td(date(r.reviewed_at))}</tr>`),'No questionnaire exists.')}${table(['Domain','Question','Answer','Comment'],s.responses.map(r=>`<tr>${td(r.section)}${td(r.question)}${td(r.answer)}${td(r.comment)}</tr>`),'No supplier responses recorded.')}`,true));
  if (s && selected.has('evidence')) out.push(docSection('Supplier evidence','Document integrity and currency',table(['Document','Type','Effective','Expires','SHA-256'],s.documents.map(r=>`<tr>${td(r.name)}${td(r.doc_type)}${td(date(r.effective_date))}${td(date(r.expiry_date))}${td(r.sha256?r.sha256.slice(0,16)+'…':'')}</tr>`),'No supplier assurance documents attached.'),true));
  if (s && selected.has('findings')) out.push(docSection('Findings and exceptions','Remediation and acceptance',table(['Finding','Severity','Status','Domain','Owner','Due'],s.findings.map(r=>`<tr>${td(r.title)}${td(r.severity)}${td(r.status)}${td(r.domain)}${td(r.owner_name)}${td(date(r.due_date))}</tr>`),'No supplier findings recorded.'),true));
  if (s && selected.has('decision')) out.push(docSection('Approval decision','Accountable risk acceptance',table(['Decision','Date','Decider','Residual risk','Valid until','Rationale'],s.decisions.map(r=>`<tr>${td(r.decision)}${td(date(r.decided_at))}${td(r.decider_name||r.actor_name)}${td(r.residual_risk_score)}${td(date(r.valid_until))}${td(r.rationale)}</tr>`),'No approval decision recorded.'),true));
  if (s && selected.has('monitoring')) out.push(docSection('Ongoing monitoring','Review history',`${table(['Review date','Reviewer','Outcome','Residual risk','Next review'],s.reviews.map(r=>`<tr>${td(date(r.review_date))}${td(r.reviewer)}${td(r.outcome)}${td(r.residual_risk)}${td(date(r.next_review_date))}</tr>`),'No periodic reviews recorded.')}${table(['Signal','Date','Score','Grade','Notes'],s.monitoring.map(r=>`<tr>${td(r.source)}${td(date(r.recorded_at))}${td(r.score)}${td(r.grade)}${td(r.notes)}</tr>`),'No monitoring signals recorded.')}`,true));
  if (selected.has('source_manifest')) out.push(docSection('Source manifest','Lineage and integrity',`<p>This frozen report is backed by ${manifest.length} source records. Each digest is calculated from the values captured at generation.</p>${table(['Section','Source','Record','Digest','Updated'],manifest.map(r=>`<tr>${td(r.section_key)}${td(r.source_type)}${td(r.source_label)}${td(r.source_hash.slice(0,16)+'…')}${td(date(r.source_updated_at))}</tr>`))}`,true));
  return out.join('');
}

function docxHtml(run, snapshot, quality, manifest) {
  const ws = snapshot.common.workspace;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;color:#18212b;font-size:11pt;line-height:1.35}h1{font-family:Georgia,serif;font-size:30pt;line-height:1.05;margin:110pt 0 16pt}h2{font-family:Georgia,serif;font-size:20pt;color:#18212b;margin:4pt 0 14pt}.brand{font-size:10pt;font-weight:bold;color:#6f1d2b;text-transform:uppercase;letter-spacing:1pt}.deck{font-size:14pt;color:#667085}.cover{height:660pt;page-break-after:always}.cover-meta{margin-top:190pt}.watermark-banner{font-size:10pt;font-weight:bold;letter-spacing:2pt;color:#6f1d2b;text-align:center;border:1px solid #6f1d2b;padding:7pt;text-transform:uppercase}.kicker{font-size:8pt;font-weight:bold;color:#6f1d2b;text-transform:uppercase;letter-spacing:1pt}.lead{font-size:13pt;line-height:1.45}.quality{background:#fff8e9;border-left:3pt solid #a15c00;padding:12pt;margin:16pt 0}table{border-collapse:collapse;width:100%;margin:10pt 0 18pt;font-size:9pt}th{background:#27313d;color:white;text-align:left;padding:6pt}td{border:1px solid #cfd5dd;padding:6pt;vertical-align:top}.facts-table th{width:28%;background:#f0f2f5;color:#18212b}.metric-table td strong{font-size:17pt;color:#6f1d2b}.metric-table td span{font-size:8pt;color:#667085}.doc-section{margin-bottom:18pt}li{margin-bottom:4pt}.footer-note{font-size:8pt;color:#667085;border-top:1px solid #cfd5dd;padding-top:8pt}
  </style></head><body><div class="cover"><div class="brand">${e(ws.brand_display_name||ws.firm_name)}</div><h1>${e(run.title)}</h1><p class="deck">${e(REPORTS[snapshot.report_key].short)}</p><div class="cover-meta">${snapshot.metadata.watermark ? `<p class="watermark-banner">${e(snapshot.metadata.watermark)}</p>` : ''}${docFacts([['Prepared for',snapshot.metadata.prepared_for],['Prepared by',snapshot.metadata.prepared_by],['Reporting period',`${date(snapshot.reporting_period.start)} to ${date(snapshot.reporting_period.end)}`],['Data cutoff',snapshot.cutoff_at],['Classification',snapshot.metadata.classification],['Report version',`v${run.version_number} · ${run.status}`]])}</div></div><div style="page-break-after:always"><br></div>${docxReportBody(run,snapshot,quality,manifest)}<p class="footer-note">Frozen snapshot ${e(run.snapshot_hash)} · Generated ${e(run.generated_at)} · Report ID ${e(run.id)}</p></body></html>`;
}

async function renderDocx(run, snapshot, quality, manifest) {
  const brand = snapshot.common.workspace.brand_display_name || snapshot.common.workspace.firm_name;
  const header = `<div style="font-family:Arial;font-size:9pt;color:#667085;border-bottom:1px solid #d9dee7;padding-bottom:6px"><strong>${e(brand)}</strong><span style="float:right">${e(snapshot.metadata.classification)} · Report #${e(run.id)}</span></div>`;
  return htmlToDocxPooled(docxHtml(run, snapshot, quality, manifest), header, {
    orientation: 'portrait',
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 },
    font: 'Arial', fontSize: 22, table: { row: { cantSplit: true } }, pageNumber: true,
    footer: true
  });
}

async function renderPdf(run, snapshot, quality, manifest) {
  return auditPack.renderPDF(renderHtml(run, snapshot, quality, manifest), {
    headerLeft: snapshot.common.workspace.brand_display_name || snapshot.common.workspace.firm_name,
    headerRight: `${snapshot.metadata.classification} · Report #${run.id}`,
    footerLeft: `Snapshot ${run.snapshot_hash.slice(0, 16)}…`
  });
}

function hydrateRun(row) {
  if (!row) return null;
  return { ...row, snapshot: safeJson(row.snapshot_json, {}), quality: safeJson(row.data_quality_json, []), manifest: safeJson(row.source_manifest_json, []), selected_sections: safeJson(row.selected_sections, []) };
}

function getRun(db, wsId, runId) {
  return hydrateRun(db.prepare(`SELECT r.*,d.report_key,d.name AS definition_name,
      cu.name AS creator_name,su.name AS submitter_name,ru.name AS reviewer_name,
      au.name AS approver_name,pu.name AS publisher_name
    FROM assurance_report_runs r JOIN assurance_report_definitions d ON d.id=r.definition_id
    LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users su ON su.id=r.submitted_by
    LEFT JOIN users ru ON ru.id=r.reviewed_by LEFT JOIN users au ON au.id=r.approved_by
    LEFT JOIN users pu ON pu.id=r.published_by WHERE r.id=? AND r.workspace_id=?`).get(runId, wsId));
}

function createRun(db, wsId, userId, key, config) {
  const built = buildSnapshot(db, wsId, key, config);
  const defRow = db.prepare('SELECT * FROM assurance_report_definitions WHERE report_key=? AND is_active=1').get(key);
  if (!defRow) throw new Error('definition_not_found');
  const create = db.transaction(() => {
    const nextVersion = db.prepare('SELECT COALESCE(MAX(version_number),0)+1 n FROM assurance_report_runs WHERE workspace_id=? AND definition_id=?').get(wsId, defRow.id).n;
    const info = db.prepare(`INSERT INTO assurance_report_runs
      (workspace_id,definition_id,version_number,title,reporting_period_start,reporting_period_end,cutoff_at,scope_label,framework,supplier_id,audience,classification,watermark,prepared_for,prepared_by,executive_summary,selected_sections,status,snapshot_json,snapshot_hash,data_quality_json,source_manifest_json,created_by,generated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'generated',?,?,?,?,?,?)`).run(
        wsId, defRow.id, nextVersion, built.snapshot.metadata.title,
        built.snapshot.reporting_period.start, built.snapshot.reporting_period.end, built.snapshot.cutoff_at,
        built.snapshot.metadata.scope_label, built.snapshot.metadata.framework, config.supplier_id || null,
        built.snapshot.metadata.audience, built.snapshot.metadata.classification, built.snapshot.metadata.watermark,
        built.snapshot.metadata.prepared_for, built.snapshot.metadata.prepared_by, built.snapshot.metadata.executive_summary,
        JSON.stringify(built.snapshot.metadata.selected_sections), stableStringify(built.snapshot), built.snapshotHash,
        JSON.stringify(built.quality), JSON.stringify(built.manifest), userId, built.snapshot.generated_at
      );
    const runId = info.lastInsertRowid;
    const sourceStmt = db.prepare(`INSERT INTO assurance_report_sources (run_id,section_key,source_type,source_id,source_label,source_hash,source_updated_at) VALUES (?,?,?,?,?,?,?)`);
    for (const src of built.manifest) sourceStmt.run(runId, src.section_key, src.source_type, src.source_id, src.source_label, src.source_hash, src.source_updated_at);
    db.prepare(`INSERT INTO assurance_report_events (run_id,action,from_status,to_status,note,actor_id,snapshot_hash) VALUES (?,'generated',NULL,'generated',?,?,?)`).run(runId, 'Immutable data snapshot created', userId, built.snapshotHash);
    return runId;
  });
  return getRun(db, wsId, create());
}

function artifactFilename(run, format) { return `${slug(run.snapshot.common.workspace.client_name)}-${slug(run.report_key)}-v${run.version_number}.${format}`; }

async function getOrCreateArtifact(db, run, format, userId) {
  const existing = db.prepare('SELECT * FROM assurance_report_artifacts WHERE run_id=? AND format=?').get(run.id, format);
  if (existing) return existing;
  let content, mime;
  if (format === 'pdf') { content = await renderPdf(run, run.snapshot, run.quality, run.manifest); mime = 'application/pdf'; }
  else if (format === 'docx') { content = await renderDocx(run, run.snapshot, run.quality, run.manifest); mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
  else if (format === 'json') { content = Buffer.from(stableStringify({ run: { id:run.id,title:run.title,version:run.version_number,status:run.status,snapshot_hash:run.snapshot_hash }, snapshot:run.snapshot, quality:run.quality, manifest:run.manifest }), 'utf8'); mime = 'application/json'; }
  else throw new Error('format_invalid');
  content = Buffer.from(content);
  const hash = sha(content);
  try {
    db.prepare(`INSERT INTO assurance_report_artifacts (run_id,format,filename,mime_type,content_blob,content_hash,size_bytes,generated_by) VALUES (?,?,?,?,?,?,?,?)`).run(run.id, format, artifactFilename(run, format), mime, content, hash, content.length, userId);
  } catch (err) {
    if (!/UNIQUE/.test(err.message)) throw err;
  }
  return db.prepare('SELECT * FROM assurance_report_artifacts WHERE run_id=? AND format=?').get(run.id, format);
}

module.exports = { REPORTS, buildSnapshot, createRun, getRun, renderHtml, renderDocx, renderPdf, getOrCreateArtifact, stableStringify, sha, safeJson, slug };
