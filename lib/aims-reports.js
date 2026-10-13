'use strict';
// Report bodies for the records an ISO 42001 engagement hands over: an
// approved impact assessment, management review minutes, an internal audit
// report, the approved Statement of Applicability, the AI system register and
// the AI risk register.
// Each builds an HTML body for the branded Word export in
// routes/engagement-ops.js (brandedDocx), from the records already kept, so
// the consultant does not retype them into Word.

const reqOpts = require('./requirement-options');
const registry = require('./ai-systems');
const aiRisk = require('./ai-risk');
const aimsRisks = require('./aims-risks');
const { getActiveMethodology } = require('../db');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const para = (v) => (v ? String(v).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : '<p class="meta">Not recorded.</p>');
const date = (v) => (v ? String(v).slice(0, 10) : 'Not recorded');
const facts = (rows) => `<table><tbody>${rows.map(([k, v]) => `<tr><th width="30%">${esc(k)}</th><td>${esc(v == null || v === '' ? 'Not recorded' : v)}</td></tr>`).join('')}</tbody></table>`;

function impactAssessment(db, workspace, systemId, iaId) {
  const system = db.prepare('SELECT * FROM ai_systems WHERE id=? AND workspace_id=?').get(systemId, workspace.id);
  const ia = system && db.prepare('SELECT * FROM ai_impact_assessments WHERE id=? AND ai_system_id=? AND workspace_id=?').get(iaId, system.id, workspace.id);
  if (!ia) return null;
  const who = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id=?').get(id) || {}).name : null);
  const editors = db.prepare(`SELECT u.name FROM ai_impact_assessment_editors e JOIN users u ON u.id=e.user_id WHERE e.assessment_id=? ORDER BY e.last_edited_at`).all(ia.id).map((r) => r.name);
  let body = `<h2>AI system</h2>${facts([
    ['System', system.name], ['Purpose', system.purpose], ['Lifecycle stage', registry.LIFECYCLE[system.lifecycle_stage]],
    ['Human oversight', system.human_oversight], ['Owner', system.system_owner],
  ])}`;
  body += `<h2>Assessment</h2>${facts([
    ['Version', ia.version_no], ['Status', ia.status], ['Prepared and edited by', editors.join(', ') || who(ia.prepared_by)],
    ['Approved by', who(ia.approved_by)], ['Approved on', date(ia.approved_at)], ['Next review', date(ia.next_review_date)],
    ['Result kept for', ia.retention_period],
    ['Severity of the worst harm', ia.harm_severity ? `${ia.harm_severity} - ${registry.HARM_SEVERITY[ia.harm_severity]}` : null],
    ['Likelihood of that harm', ia.harm_likelihood ? `${ia.harm_likelihood} - ${registry.HARM_LIKELIHOOD[ia.harm_likelihood]}` : null],
    ['Residual impact', ia.residual_level ? registry.RESIDUAL[ia.residual_level] : null],
    ['Decision', ia.decision ? registry.DECISIONS[ia.decision] : null],
  ])}`;
  for (const [key, label] of registry.IA_FIELDS) body += `<h3>${esc(label)}</h3>${para(ia[key])}`;
  const areas = registry.decodeAreas(ia.impact_areas);
  body += `<h3>Areas of impact (${registry.areasConsidered(ia.impact_areas)} of ${registry.IMPACT_AREAS.length} considered)</h3>`;
  body += `<table><thead><tr><th width="34%">Area</th><th width="18%">Finding</th><th>Why</th></tr></thead><tbody>${registry.IMPACT_AREAS.map(([key, label]) => {
    const a = areas[key] || {};
    return `<tr><td>${esc(label)}</td><td>${esc(a.state ? registry.AREA_STATES[a.state] : 'Not yet considered')}</td><td>${esc(a.note || '')}</td></tr>`;
  }).join('')}</tbody></table>`;
  if (ia.snapshot_hash) body += `<p class="meta">Content hash at approval (SHA-256): ${esc(ia.snapshot_hash)}</p>`;
  return { title: `AI System Impact Assessment - ${system.name} v${ia.version_no}${ia.status === 'approved' ? '' : ' (draft)'}`, body, filename: `impact-assessment-${system.id}-v${ia.version_no}` };
}

function managementReview(db, workspace, mrmId) {
  const m = db.prepare('SELECT * FROM mrms WHERE id=? AND workspace_id=?').get(mrmId, workspace.id);
  if (!m) return null;
  const sections = [
    ['Status of actions from previous reviews', m.prior_actions_status],
    ['Changes in external and internal issues', m.context_changes],
    ['Changes in the needs and expectations of interested parties', m.interested_party_changes],
    ['Performance of the management system', m.performance_review],
    ['Feedback from interested parties', m.feedback_interested_parties],
    ['Results of risk assessment and status of risk treatment', m.risk_treatment_status],
    ['Opportunities for continual improvement', m.improvement_opportunities],
  ];
  let body = facts([['Meeting date', date(m.meeting_date)], ['Attendees', m.attendees], ['Status', m.status]]);
  body += '<h2>Inputs considered</h2>';
  for (const [label, value] of sections) body += `<h3>${esc(label)}</h3>${para(value)}`;
  body += `<h2>Decisions</h2>${para(m.decisions)}<h2>Actions</h2>${para(m.action_items)}`;
  return { title: `Management Review Minutes - ${date(m.meeting_date)}`, body, filename: `management-review-${m.id}` };
}

function internalAudit(db, workspace, auditId) {
  const a = db.prepare('SELECT * FROM audits WHERE id=? AND workspace_id=?').get(auditId, workspace.id);
  if (!a) return null;
  const named = (rows) => reqOpts.nameRows(workspace, rows);
  const findings = named(db.prepare(`SELECT f.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM audit_findings f
    ${reqOpts.joinSql('f.iso_item_id')} WHERE f.audit_id=? ORDER BY f.created_at, f.id`).all(a.id));
  const observations = named(db.prepare(`SELECT o.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM audit_observations o
    ${reqOpts.joinSql('o.iso_item_id')} WHERE o.audit_id=? ORDER BY o.id`).all(a.id));
  const samples = named(db.prepare(`SELECT s.*, rq.title AS iso_title, rq_fw.code AS iso_framework FROM audit_samples s
    ${reqOpts.joinSql('s.iso_item_id')} WHERE s.audit_id=? ORDER BY s.sample_taken_at, s.id`).all(a.id));
  let body = facts([
    ['Audit', a.title], ['Scope', a.scope], ['Date', date(a.audit_date)], ['Auditor', a.auditor_name],
    ['Auditor competence', a.auditor_competence], ['Auditor independence', a.auditor_independence],
    ['Stage', a.lifecycle_stage], ['Sample', a.sample_size && a.population_size ? `${a.sample_size} of ${a.population_size}` : a.sample_size],
  ]);
  body += `<h2>Summary</h2>${para(a.summary)}`;
  if (a.sampling_justification) body += `<h3>Sampling</h3>${para(a.sampling_justification)}`;
  body += `<h2>Findings (${findings.length})</h2>`;
  body += findings.length
    ? `<table><thead><tr><th width="16%">Type</th><th width="10%">Severity</th><th width="28%">Requirement</th><th>Finding</th><th width="10%">Status</th></tr></thead><tbody>${findings.map((f) => `<tr><td>${esc(String(f.finding_type || '').replace(/_/g, ' '))}</td><td>${esc(f.severity)}</td><td>${esc(f.iso_title || '-')}</td><td>${esc(f.description)}${f.nonconformity_id ? `<br><span class="meta">Nonconformity NC-${f.nonconformity_id}</span>` : ''}</td><td>${esc(f.status)}</td></tr>`).join('')}</tbody></table>`
    : '<p>No findings were raised.</p>';
  body += `<h2>Audit checklist (${observations.length})</h2>`;
  body += observations.length
    ? `<table><thead><tr><th width="30%">Requirement</th><th>Result</th><th width="10%">Status</th></tr></thead><tbody>${observations.map((o) => `<tr><td>${esc(o.iso_title || '-')}</td><td>${esc(o.description || '')}${o.recommendation ? `<br><span class="meta">Recommendation: ${esc(o.recommendation)}</span>` : ''}</td><td>${esc(o.status)}</td></tr>`).join('')}</tbody></table>`
    : '<p>No checklist items were recorded.</p>';
  if (samples.length) {
    body += `<h2>Samples taken (${samples.length})</h2><table><thead><tr><th width="28%">Requirement</th><th>What was sampled</th><th width="14%">Size</th><th width="24%">Result</th></tr></thead><tbody>${samples.map((s) => `<tr><td>${esc(s.iso_title || '-')}</td><td>${esc(s.description)}</td><td>${esc(s.sample_size && s.population_size ? `${s.sample_size} of ${s.population_size}` : '-')}</td><td>${esc(s.finding || '-')}</td></tr>`).join('')}</tbody></table>`;
  }
  return { title: `Internal Audit Report - ${a.title}`, body, filename: `internal-audit-${a.id}` };
}

function soaSnapshot(db, workspace, snapshot) {
  const c = snapshot.content || { rows: [], customs: [] };
  const code = (r) => reqOpts.codeOf(r);
  const clean = (t) => String(t || '').replace(/^A\.[0-9.]+ /, '');
  let body = facts([
    ['Version', snapshot.version], ['Owner', snapshot.owner], ['Captured', date(snapshot.created_at)],
    ['Approval', snapshot.approval_status === 'approved' ? `Approved by ${snapshot.approved_by_name} on ${date(snapshot.approved_on)}` : 'Not approved'],
    ['Controls', `${snapshot.control_count} (${snapshot.included_count} included, ${snapshot.excluded_count} excluded)`],
  ]);
  body += `<table><thead><tr><th width="9%">Control</th><th width="25%">Title</th><th width="10%">Applicability</th><th width="13%">Status</th><th>Justification</th><th width="16%">Risks and documents</th></tr></thead><tbody>`;
  for (const r of c.rows) {
    body += `<tr><td>${esc(code(r))}</td><td>${esc(clean(r.title))}</td><td>${esc(r.applicability)}</td><td>${esc(r.status)}</td><td>${esc(r.applicability === 'excluded' ? r.exclusion_justification : r.inclusion_justification)}</td><td>${esc([...(r.risks || []).map((x) => `R-${x.id}`), ...(r.documents || []).map((x) => x.name)].join(', '))}</td></tr>`;
  }
  for (const r of c.customs) {
    body += `<tr><td>${esc(r.code)}</td><td>${esc(r.title)}</td><td>${esc(r.applicability)}</td><td>${esc(r.status)}</td><td>${esc(r.applicability === 'excluded' ? r.exclusion_justification : r.inclusion_justification)}</td><td>${esc(r.source || '')}</td></tr>`;
  }
  body += `</tbody></table><p class="meta">Snapshot hash (SHA-256): ${esc(snapshot.payload_hash)}</p>`;
  return { title: `Statement of Applicability${snapshot.version ? ` v${snapshot.version}` : ''}`, body, filename: `iso42001-soa-${snapshot.id}` };
}

function aiRegister(db, workspace) {
  const systems = registry.list(db, workspace);
  let body = `<p>${systems.length} AI system${systems.length === 1 ? '' : 's'} recorded.</p>`;
  for (const s of systems) {
    const detail = registry.detail(db, workspace, s.id) || { system: s, suppliers: [] };
    const sys = detail.system;
    const status = registry.reassessment(db, workspace, s.id);
    body += `<h2>${esc(sys.name)}</h2>${facts([
      ['Purpose', sys.purpose], ['Intended users', sys.intended_users],
      ['Organisation\'s role', (Array.isArray(sys.roles) ? sys.roles : []).map((r) => registry.ROLES[r] || r).join(', ')],
      ['Lifecycle stage', registry.LIFECYCLE[sys.lifecycle_stage]], ['In scope', sys.in_scope ? 'Yes' : `No - ${sys.scope_note || ''}`],
      ['Go-live', date(sys.go_live_date)], ['Owner', sys.system_owner],
      ['Automation', registry.AUTOMATION[sys.automation_level]], ['Human oversight', sys.human_oversight],
      ['Data', sys.data_resources], ['Tooling', sys.tooling_resources], ['Compute', sys.compute_resources], ['People', sys.human_resources],
      ['Suppliers', (detail.suppliers || []).map((x) => x.supplier_name).filter(Boolean).join(', ')],
      ['Impact assessment', status.reason],
    ])}`;
  }
  return { title: 'AI System Register', body, filename: 'ai-system-register' };
}

// A spreadsheet cell. Cells that a spreadsheet would read as a formula are
// prefixed with an apostrophe.
function cell(v) {
  const s = String(v == null ? '' : v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csv = (header, rows) => [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

// The register as a spreadsheet, one row per system.
function aiRegisterCsv(db, workspace) {
  const header = ['ID', 'Name', 'Purpose', 'Intended users', 'Organisation role', 'Lifecycle stage', 'In scope', 'Scope note', 'Go-live date',
    'Retired date', 'Owner', 'Automation', 'Human oversight', 'Data', 'Tooling', 'Compute', 'People', 'Suppliers', 'Impact assessment', 'Residual impact'];
  const rows = registry.list(db, workspace).map((s) => {
    const suppliers = db.prepare('SELECT supplier_name FROM ai_system_suppliers WHERE ai_system_id=? AND workspace_id=? ORDER BY supplier_name')
      .all(s.id, workspace.id).map((x) => x.supplier_name).join('; ');
    return [`AI-${s.id}`, s.name, s.purpose, s.intended_users, s.roles.map((r) => registry.ROLES[r] || r).join('; '),
      registry.LIFECYCLE[s.lifecycle_stage] || s.lifecycle_stage, s.in_scope ? 'Yes' : 'No', s.scope_note, s.go_live_date, s.retired_date,
      s.system_owner, registry.AUTOMATION[s.automation_level] || s.automation_level, s.human_oversight, s.data_resources, s.tooling_resources,
      s.compute_resources, s.human_resources, suppliers, registry.reassessment(db, workspace, s.id).reason,
      s.ia_residual ? registry.RESIDUAL[s.ia_residual] : ''];
  });
  return csv(header, rows);
}

// The AI risk register: what to hand an auditor or the client who asks for
// the risk register (clauses 6.1.2, 8.2, 8.3). The risks come from a risk
// assessment record as it was sealed (lib/ai-risk.js), rated on the AIMS's
// risk criteria; how each is being treated and who accepted what is left come
// from the live register on the day, and the document says which is which.
// Without a record it is the live register, marked as not sealed.
const today = () => new Date().toISOString().slice(0, 10);
const riskId = (id) => `R-${id}`;
const score = (l, i) => (l && i ? `${l}×${i}` : '');
const treatmentLabel = (t) => aimsRisks.TREATMENTS[t] || (t ? String(t).charAt(0).toUpperCase() + String(t).slice(1) : '');
const statusLabel = (s) => aimsRisks.STATUSES[s] || s || '';
const actionStatus = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '');
const impacts = (r) => `${r.impact_organisation ?? r.impact ?? '-'} · ${r.impact_individuals ?? '-'} · ${r.impact_society ?? '-'}`;

function riskRegisterData(db, workspace, record = null) {
  const method = getActiveMethodology(workspace.id, 'iso42001');
  const sealed = record ? record.rows : aiRisk.snapshotRows(db, workspace, 'ai');
  const ids = sealed.map((r) => r.id);
  const live = {};
  const actions = {};
  const accepted = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT id, status FROM risks WHERE workspace_id=? AND id IN (${ph})`).all(workspace.id, ...ids)
      .forEach((r) => { live[r.id] = r; });
    db.prepare(`SELECT risk_id, title, owner_name, due_date, status FROM risk_treatment_actions WHERE workspace_id=? AND risk_id IN (${ph})
      ORDER BY due_date IS NULL, due_date, id`).all(workspace.id, ...ids)
      .forEach((a) => { (actions[a.risk_id] = actions[a.risk_id] || []).push(a); });
    db.prepare(`SELECT risk_id, accepter_name, accepter_role, signed_at, expires_at FROM risk_acceptances
      WHERE workspace_id=? AND risk_id IN (${ph}) AND revoked_at IS NULL ORDER BY signed_at, id`).all(workspace.id, ...ids)
      .forEach((a) => { accepted[a.risk_id] = a; });
  }
  const rows = sealed.map((r) => ({
    ...r,
    band: aimsRisks.bandOf(method, r.likelihood, r.impact),
    residualBand: aimsRisks.bandOf(method, r.residual_likelihood, r.residual_impact),
    statusToday: live[r.id] ? live[r.id].status : null,
    treatmentText: treatmentLabel(r.treatment),
    sourceText: aiRisk.SOURCE_LABEL[r.risk_source] || r.risk_source || null,
    actions: actions[r.id] || [],
    acceptance: accepted[r.id] || null,
  }));
  // The record keeps the criteria's name only, so the criteria printed are
  // today's; say so when they may not be the ones the risks were rated on.
  let criteriaNote = null;
  if (record && record.methodology_name !== method.name) {
    criteriaNote = `This assessment was rated on the criteria named "${record.methodology_name || 'not recorded'}". The criteria below are the ones in use today, "${method.name}".`;
  } else if (record && method.updated_at && method.updated_at > record.created_at) {
    criteriaNote = `These criteria were changed on ${date(method.updated_at)}, after this assessment was recorded. The bands below are worked out on today's criteria.`;
  }
  const latest = aiRisk.records(db, workspace, 'iso42001')[0];
  return {
    record, method, criteriaNote, rows, asOf: today(),
    above: record ? record.above_appetite : rows.filter((r) => aimsRisks.aboveCriteria(method, r)).length,
    systems: [...new Set(rows.map((r) => r.ai_system).filter(Boolean))],
    addedSince: record ? db.prepare(`SELECT r.id, r.title FROM risks r WHERE r.workspace_id=? AND ${aiRisk.isAiRiskSql('r')} AND r.created_at > ? ORDER BY r.id`)
      .all(workspace.id, record.created_at).filter((r) => !ids.includes(r.id)) : [],
    // When the next assessment is due belongs on the latest record only.
    due: !record || (latest && latest.id === record.id) ? aiRisk.nextDue(db, workspace, 'iso42001') : null,
  };
}

function aiRiskRegister(db, workspace, record = null) {
  const d = riskRegisterData(db, workspace, record);
  const m = d.method;
  const about = [
    ['Basis', record ? `The AI risk assessment performed on ${date(record.performed_on)}, as sealed when it was recorded`
      : `The live register on ${d.asOf}. It has not been recorded as a performed risk assessment, so it is not sealed.`],
  ];
  if (record) about.push(['Assessment', record.label], ['Recorded by', `${record.recorded_by_name || 'Unknown'} on ${date(record.created_at)}`]);
  about.push(
    ['AI systems covered', d.systems.join(', ') || 'No risk names an AI system'],
    ['Risk criteria', record ? record.methodology_name : m.name],
    ['AI risks', `${d.rows.length}, of which ${d.above} above the risk criteria`],
  );
  if (d.due) about.push(['Next assessment due', d.due.due ? `${d.due.due}${d.due.reason ? ` (${d.due.reason})` : ''}` : 'Now: no AI risk assessment has been recorded']);
  if (record) about.push(['Seal (SHA-256)', `${record.intact ? 'Intact' : 'Does not match: the record changed after it was sealed'}. ${record.payload_hash}`]);
  let body = `<h2>This register</h2>${facts(about)}`;
  if (record && record.notes) body += `<h3>Notes</h3>${para(record.notes)}`;
  if (d.addedSince.length) {
    body += `<p>${d.addedSince.length === 1 ? 'One AI risk was' : `${d.addedSince.length} AI risks were`} added to the register after this assessment and ${d.addedSince.length === 1 ? 'is' : 'are'} not in it: ${d.addedSince.map((r) => `${riskId(r.id)} ${esc(r.title)}`).join('; ')}.</p>`;
  }

  body += '<h2>Risk criteria</h2>';
  if (d.criteriaNote) body += `<p><em>${esc(d.criteriaNote)}</em></p>`;
  body += '<p>Each AI risk is rated for its impact on the organisation, on individuals or groups, and on society, and is scored on the highest of the three.</p>';
  const scale = (heading, items) => `<h3>${heading}</h3><table><thead><tr><th width="10%">Rating</th><th width="24%">${heading}</th><th>Meaning</th></tr></thead><tbody>${
    items.map((x) => `<tr><td>${esc(x.value)}</td><td>${esc(x.label)}</td><td>${esc(x.description || '')}</td></tr>`).join('')}</tbody></table>`;
  body += scale('Likelihood', m.likelihood_scale) + scale('Impact', m.impact_scale);
  body += `<h3>Risk levels</h3><table><thead><tr><th width="18%">Likelihood</th>${m.impact_scale.map((i) => `<th>Impact ${esc(i.value)}</th>`).join('')}</tr></thead><tbody>${
    m.likelihood_scale.map((l, li) => `<tr><td>${esc(l.value)} ${esc(l.label)}</td>${m.impact_scale.map((_, ii) => `<td>${esc((m.matrix[li] || [])[ii] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const thresholds = Object.entries(m.thresholds || {});
  if (thresholds.length) {
    body += `<table><thead><tr><th width="18%">Level</th><th>What it calls for</th><th width="20%">Review at least every</th></tr></thead><tbody>${
      thresholds.map(([band, t]) => `<tr><td>${esc(band)}</td><td>${esc(t.action || '')}</td><td>${t.review_months ? `${esc(t.review_months)} months` : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  body += `<h2>${record ? 'AI risks as assessed' : 'AI risks'} (${d.rows.length})</h2>`;
  body += d.rows.length ? `<table><thead><tr><th width="7%">Risk</th><th>Description</th><th width="6%">L</th><th width="13%">Impact: org · people · society</th><th width="9%">Score</th><th width="12%">Treatment</th><th width="9%">Residual</th><th width="18%">Controls</th></tr></thead><tbody>${
    d.rows.map((r) => {
      const context = [r.ai_system, aiRisk.SOURCE_LABEL[r.risk_source]].filter(Boolean).map(esc).join(' · ');
      return `<tr><td>${riskId(r.id)}</td><td><strong>${esc(r.title)}</strong>${context ? `<br><span class="meta">${context}</span>` : ''}${
        r.owner ? `<br><span class="meta">Owner: ${esc(r.owner)}</span>` : ''}${r.description ? `<br>${esc(r.description)}` : ''}</td><td>${esc(r.likelihood || '-')}</td><td>${impacts(r)}</td><td>${
        score(r.likelihood, r.impact) || '-'}${r.band ? `<br>${esc(r.band)}` : ''}</td><td>${esc(treatmentLabel(r.treatment) || '-')}</td><td>${
        score(r.residual_likelihood, r.residual_impact) || '-'}${r.residualBand ? `<br>${esc(r.residualBand)}` : ''}</td><td>${(r.controls || []).map(esc).join('<br>') || '-'}</td></tr>`;
    }).join('')}</tbody></table>` : `<p>${record ? 'The register was empty when this assessment was recorded.' : 'No AI risk has been recorded yet.'}</p>`;

  if (d.rows.length) {
    body += `<h2>Treatment and sign-off on ${d.asOf}</h2>`;
    if (record) body += '<p>From the live register on the day this document was produced, not from the sealed record.</p>';
    body += `<table><thead><tr><th width="7%">Risk</th><th width="22%">Title</th><th width="11%">Status</th><th>Treatment actions</th><th width="24%">Residual risk accepted by</th></tr></thead><tbody>${
      d.rows.map((r) => `<tr><td>${riskId(r.id)}</td><td>${esc(r.title)}</td><td>${esc(r.statusToday ? statusLabel(r.statusToday) : 'Removed from the register')}</td><td>${
        r.actions.map((a) => `<strong>${esc(a.title)}</strong><br><span class="meta">${[a.owner_name, a.due_date ? `due ${a.due_date}` : null, actionStatus(a.status)].filter(Boolean).map(esc).join(' · ')}</span>`).join('<br>') || '-'}</td><td>${
        r.acceptance ? `${esc(r.acceptance.accepter_name || 'Unnamed')}${r.acceptance.accepter_role ? `, ${esc(r.acceptance.accepter_role)}` : ''}<br><span class="meta">on ${date(r.acceptance.signed_at)}${
          r.acceptance.expires_at ? `, until ${date(r.acceptance.expires_at)}` : ''}</span>` : 'Not accepted'}</td></tr>`).join('')}</tbody></table>`;
  }
  return {
    title: `AI Risk Register - ${record ? date(record.performed_on) : `${d.asOf} (live, not sealed)`}`,
    body,
    filename: record ? `ai-risk-register-${date(record.performed_on)}-record-${record.id}` : 'ai-risk-register-live',
  };
}

// The same register as a spreadsheet, one row per risk, for an auditor who
// samples from it. Each row names the assessment it comes from.
function aiRiskRegisterCsv(db, workspace, record = null) {
  const d = riskRegisterData(db, workspace, record);
  const header = ['Risk', 'Title', 'Description', 'AI system', 'Source', 'Owner', 'Likelihood', 'Impact on the organisation',
    'Impact on individuals or groups', 'Impact on society', 'Impact (highest)', 'Score', 'Level', 'Treatment', 'Status when assessed',
    'Residual likelihood', 'Residual impact', 'Residual level', 'Controls', `Status on ${d.asOf}`, `Treatment actions on ${d.asOf}`,
    'Residual risk accepted by', 'Accepted on', 'Acceptance expires', 'Assessment', 'Performed on', 'Sealed'];
  const basis = record ? [record.label, date(record.performed_on), record.intact ? 'Yes' : 'Seal broken'] : ['Live register', d.asOf, 'No'];
  const rows = d.rows.map((r) => [riskId(r.id), r.title, r.description, r.ai_system, aiRisk.SOURCE_LABEL[r.risk_source] || r.risk_source, r.owner,
    r.likelihood, r.impact_organisation ?? r.impact, r.impact_individuals, r.impact_society, r.impact, r.likelihood && r.impact ? r.likelihood * r.impact : '',
    r.band, treatmentLabel(r.treatment), statusLabel(r.status), r.residual_likelihood, r.residual_impact, r.residualBand, (r.controls || []).join('; '),
    r.statusToday ? statusLabel(r.statusToday) : 'Removed from the register',
    r.actions.map((a) => [a.title, a.owner_name, a.due_date ? `due ${a.due_date}` : null, actionStatus(a.status)].filter(Boolean).join(' · ')).join('; '),
    r.acceptance ? [r.acceptance.accepter_name, r.acceptance.accepter_role].filter(Boolean).join(', ') : '',
    r.acceptance ? date(r.acceptance.signed_at) : '', r.acceptance && r.acceptance.expires_at ? date(r.acceptance.expires_at) : '', ...basis]);
  return csv(header, rows);
}

module.exports = { impactAssessment, managementReview, internalAudit, soaSnapshot, aiRegister, aiRegisterCsv,
  riskRegisterData, aiRiskRegister, aiRiskRegisterCsv };
