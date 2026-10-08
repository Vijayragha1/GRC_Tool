'use strict';
// Report bodies for the records an ISO 42001 engagement hands over: an
// approved impact assessment, management review minutes, an internal audit
// report, the approved Statement of Applicability and the AI system register.
// Each builds an HTML body for the branded Word export in
// routes/engagement-ops.js (brandedDocx), from the records already kept, so
// the consultant does not retype them into Word.

const reqOpts = require('./requirement-options');
const registry = require('./ai-systems');

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

// The register as a spreadsheet, one row per system. Cells that a spreadsheet
// would read as a formula are prefixed with an apostrophe.
function aiRegisterCsv(db, workspace) {
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
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
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { impactAssessment, managementReview, internalAudit, soaSnapshot, aiRegister, aiRegisterCsv };
