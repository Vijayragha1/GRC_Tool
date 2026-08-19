'use strict';

const crypto = require('crypto');

const STATUS_ORDER = [
  'Implemented',
  'Partially Implemented',
  'Work In Progress',
  'Not Implemented',
  'Not Assessed',
  'Not Applicable'
];

const THEME_META = {
  org: { code: 'A.5', label: 'Organizational', total: 37 },
  people: { code: 'A.6', label: 'People', total: 8 },
  physical: { code: 'A.7', label: 'Physical', total: 14 },
  tech: { code: 'A.8', label: 'Technological', total: 34 }
};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function cleanTitle(title) {
  return String(title || '').replace(/^A\.[0-9.]+\s+/, '').replace(/^[0-9.]+\s+/, '');
}

function itemCode(id) {
  return String(id || '').replace(/^annex-/, '').replace(/^clause-/, '').toUpperCase();
}

function isoIdFromRef(ref) {
  const value = String(ref || '').trim().toLowerCase();
  if (/^a\./.test(value)) return `annex-${value}`;
  if (/^[4-9]|^10/.test(value)) return `clause-${value}`;
  return value;
}

function formatDate(value) {
  if (!value) return 'Not recorded';
  const raw = String(value).slice(0, 10);
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
  }).format(date).toUpperCase();
}

function statusClass(status) {
  return ({
    'Implemented': 'implemented',
    'Partially Implemented': 'partial',
    'Work In Progress': 'progress',
    'Not Implemented': 'missing',
    'Not Applicable': 'na'
  })[status] || 'unassessed';
}

function statusShort(status) {
  return ({
    'Implemented': 'IMPLEMENTED',
    'Partially Implemented': 'PARTIAL',
    'Work In Progress': 'IN PROGRESS',
    'Not Implemented': 'NOT IMPLEMENTED',
    'Not Applicable': 'N/A',
    'Not Assessed': 'NOT ASSESSED'
  })[status] || String(status || 'NOT ASSESSED').toUpperCase();
}

function countStatuses(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map(status => [status, 0]));
  rows.forEach(row => { counts[row.status] = (counts[row.status] || 0) + 1; });
  return counts;
}

function evidenceForItems(db, workspaceId, cutoff) {
  const evidence = db.prepare(`SELECT id, iso_item_id, filename, description, uploaded_at,
      period_label, clause_section, sha256
    FROM evidence
    WHERE workspace_id=? AND uploaded_at <= ?
    ORDER BY uploaded_at, id`).all(workspaceId, cutoff);
  const byItem = new Map();
  const byId = new Map();
  evidence.forEach((row, index) => {
    row.ref = `E-${String(index + 1).padStart(2, '0')}`;
    byId.set(row.id, row);
    if (row.iso_item_id) {
      const list = byItem.get(row.iso_item_id) || [];
      list.push(row);
      byItem.set(row.iso_item_id, list);
    }
  });
  if (evidence.length) {
    const links = db.prepare(`SELECT erl.evidence_id, r.ref
      FROM evidence_requirement_links erl
      INNER JOIN evidence e ON e.id=erl.evidence_id
      INNER JOIN requirements r ON r.id=erl.requirement_id
      WHERE e.workspace_id=? AND e.uploaded_at <= ?`).all(workspaceId, cutoff);
    links.forEach(link => {
      const row = byId.get(link.evidence_id);
      if (!row) return;
      const isoId = isoIdFromRef(link.ref);
      const list = byItem.get(isoId) || [];
      if (!list.some(item => item.id === row.id)) list.push(row);
      byItem.set(isoId, list);
    });
  }
  return { evidence, byItem };
}

function linkedEvidenceRefs(byItem, isoItemId) {
  return (byItem.get(isoItemId) || []).map(row => row.ref).join(', ');
}

function linkedTaskSummary(tasksByItem, isoItemId) {
  const task = (tasksByItem.get(isoItemId) || [])[0];
  if (!task) return null;
  return {
    action: task.title,
    owner: task.owner_name || 'Unassigned',
    due: task.due_date ? formatDate(task.due_date) : 'Not scheduled'
  };
}

function actionFor(row) {
  if (row.proofGap) return 'Link current, relevant evidence and have a reviewer confirm that it supports the recorded implementation conclusion.';
  if (row.corrective_action) return row.corrective_action;
  if (row.task && row.task.action) return row.task.action;
  if (row.status === 'Not Implemented') {
    return `Design and approve the required ${row.type === 'clause' ? 'management-system process' : 'control'}, then retain evidence of operation.`;
  }
  if (row.status === 'Partially Implemented') {
    return 'Close the documented design or coverage gap and retain evidence across the agreed operating period.';
  }
  return 'Complete implementation, assign an accountable owner, and retain evidence suitable for independent verification.';
}

function buildGapAssessmentReportData(db, workspace, pass, options = {}) {
  if (!workspace) throw new Error('Workspace is required');
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const currentState = options.currentState === true || !pass;
  pass = pass || {
    id: null,
    pass_number: null,
    label: 'Current workspace status',
    notes: 'Point-in-time working status generated directly from the current control register.',
    status: 'in_progress',
    started_at: workspace.created_at || null,
    completed_at: null,
    started_by: workspace.lead_consultant_id || null,
    completed_by: null
  };
  const cutoff = currentState ? generatedAt : (pass.completed_at || generatedAt);
  const items = db.prepare(`SELECT id, type, category, title, summary, evidence_needed,
      what_good_looks_like, minimum_certifiable, sort_order
    FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order`).all();
  const state = currentState
    ? db.prepare(`SELECT status, maturity, applicability, notes,
        last_updated AS snapshot_at, NULL AS changed_by
      FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`)
    : db.prepare(`SELECT h.status, h.maturity, h.applicability, h.notes,
        h.snapshot_at, h.changed_by
      FROM control_state_history h
      INNER JOIN assessment_passes p ON p.id=h.pass_id
      WHERE h.workspace_id=? AND h.iso_item_id=? AND p.pass_number <= ?
      ORDER BY p.pass_number DESC, h.snapshot_at DESC, h.id DESC LIMIT 1`);
  const { evidence, byItem } = evidenceForItems(db, workspace.id, cutoff);

  const tasks = db.prepare(`SELECT t.iso_item_id, t.title, t.due_date, t.priority, t.status,
      u.name AS owner_name
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.workspace_id=? AND t.iso_item_id IS NOT NULL AND t.status NOT IN ('done','cancelled')
    ORDER BY t.due_date IS NULL, t.due_date, t.id`).all(workspace.id);
  const tasksByItem = new Map();
  tasks.forEach(task => {
    const list = tasksByItem.get(task.iso_item_id) || [];
    list.push(task);
    tasksByItem.set(task.iso_item_id, list);
  });

  const nonconformities = db.prepare(`SELECT id, title, description, severity, iso_item_id,
      corrective_action, responsible, due_date, status
    FROM nonconformities WHERE workspace_id=? ORDER BY
      CASE severity WHEN 'major' THEN 0 WHEN 'critical' THEN 0 WHEN 'minor' THEN 1 ELSE 2 END, id`).all(workspace.id);
  const ncByItem = new Map();
  nonconformities.forEach(nc => {
    if (!nc.iso_item_id) return;
    const list = ncByItem.get(nc.iso_item_id) || [];
    list.push(nc);
    ncByItem.set(nc.iso_item_id, list);
  });

  const rows = items.map(item => {
    const snapshot = (currentState
      ? state.get(workspace.id, item.id)
      : state.get(workspace.id, item.id, pass.pass_number)) || {
      status: 'Not Assessed', maturity: null, applicability: 'undecided', notes: null,
      snapshot_at: null, changed_by: null
    };
    const nc = (ncByItem.get(item.id) || [])[0] || null;
    const task = linkedTaskSummary(tasksByItem, item.id);
    return {
      ...item,
      ...snapshot,
      code: itemCode(item.id),
      cleanTitle: cleanTitle(item.title),
      evidenceRefs: linkedEvidenceRefs(byItem, item.id),
      nc,
      task,
      corrective_action: nc && nc.corrective_action,
      owner: (nc && nc.responsible) || (task && task.owner) || 'Unassigned',
      due: (nc && nc.due_date && formatDate(nc.due_date)) || (task && task.due) || 'Not scheduled'
    };
  });

  const clauseRows = rows.filter(row => row.type === 'clause');
  const annexRows = rows.filter(row => row.type === 'control');
  const clauseCounts = countStatuses(clauseRows);
  const annexCounts = countStatuses(annexRows);
  const counts = countStatuses(rows);
  const applicable = rows.filter(row => row.status !== 'Not Applicable');
  const weighted = applicable.reduce((sum, row) => sum + (({
    'Implemented': 1,
    'Partially Implemented': 0.5,
    'Work In Progress': 0.25
  })[row.status] || 0), 0);
  const readiness = applicable.length ? Math.round((weighted / applicable.length) * 100) : 0;
  const gapStatuses = new Set(['Not Implemented', 'Partially Implemented', 'Work In Progress']);
  const proofGaps = rows.filter(row => row.status === 'Implemented' && !row.evidenceRefs)
    .map(row => ({ ...row, proofGap: true }));
  const proofGapIds = new Set(proofGaps.map(row => row.id));
  const clauseGaps = clauseRows.filter(row => gapStatuses.has(row.status) || proofGapIds.has(row.id))
    .map(row => proofGapIds.has(row.id) ? { ...row, proofGap: true } : row);
  const annexGaps = annexRows.filter(row => gapStatuses.has(row.status) || proofGapIds.has(row.id))
    .map(row => proofGapIds.has(row.id) ? { ...row, proofGap: true } : row);

  let findingCounter = 0;
  const toFinding = row => {
    findingCounter += 1;
    const severity = row.proofGap ? 'EVIDENCE GAP' : row.nc
      ? String(row.nc.severity || 'minor').toUpperCase()
      : (row.status === 'Not Implemented' ? 'MAJOR GAP' : 'MINOR GAP');
    return {
      ...row,
      findingRef: row.nc ? `NC-${String(row.nc.id).padStart(2, '0')}` : `GAP-${String(findingCounter).padStart(2, '0')}`,
      severity,
      currentState: row.proofGap
        ? 'The requirement is recorded as Implemented, but no current evidence was linked at the reporting cutoff.'
        : (row.nc && (row.nc.description || row.nc.title)) || row.notes || 'No assessment narrative was recorded for this gap.',
      requiredAction: actionFor(row)
    };
  };
  const clauseFindings = clauseGaps.map(toFinding);
  const annexFindings = annexGaps.map(toFinding);
  const findingByItem = new Map([...clauseFindings, ...annexFindings].map(finding => [finding.id, finding]));

  const themes = Object.entries(THEME_META).map(([key, meta]) => {
    const themeRows = annexRows.filter(row => row.category === key);
    const themeCounts = countStatuses(themeRows);
    return { key, ...meta, rows: themeRows, counts: themeCounts };
  });

  const firm = db.prepare('SELECT name FROM firms WHERE id=?').get(workspace.firm_id);
  const people = db.prepare(`SELECT u.id, u.name, u.email, u.user_type, wm.role
    FROM workspace_members wm INNER JOIN users u ON u.id=wm.user_id
    WHERE wm.workspace_id=? ORDER BY u.user_type, u.name`).all(workspace.id);
  const userById = id => id ? db.prepare('SELECT id,name,email FROM users WHERE id=?').get(id) : null;
  const preparedBy = userById(pass.started_by || workspace.lead_consultant_id || pass.completed_by);
  const clientOwner = people.find(person => person.user_type === 'client' && person.role === 'client_owner')
    || people.find(person => person.user_type === 'client');
  const reviewRecorded = pass.completed_by && pass.started_by && pass.completed_by !== pass.started_by;
  const reviewer = reviewRecorded ? userById(pass.completed_by) : null;
  const assessmentActivity = currentState
    ? db.prepare(`SELECT COALESCE(u.name,u.email,'Unknown assessor') AS name,
        COUNT(*) AS decisions, MIN(h.snapshot_at) AS first_activity, MAX(h.snapshot_at) AS last_activity
      FROM control_state_history h
      LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.workspace_id=?
      GROUP BY h.changed_by, COALESCE(u.name,u.email,'Unknown assessor')
      ORDER BY decisions DESC, name`).all(workspace.id)
    : db.prepare(`SELECT COALESCE(u.name,u.email,'Unknown assessor') AS name,
        COUNT(*) AS decisions, MIN(h.snapshot_at) AS first_activity, MAX(h.snapshot_at) AS last_activity
      FROM control_state_history h
      INNER JOIN assessment_passes p ON p.id=h.pass_id
      LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.workspace_id=? AND p.pass_number <= ?
      GROUP BY h.changed_by, COALESCE(u.name,u.email,'Unknown assessor')
      ORDER BY decisions DESC, name`).all(workspace.id, pass.pass_number);
  const intakeRows = db.prepare(`SELECT question_id, answer FROM engagement_intake
    WHERE workspace_id=? AND TRIM(COALESCE(answer,''))<>'' ORDER BY question_id`).all(workspace.id);
  const audits = db.prepare(`SELECT title, scope, audit_date, auditor_name, status, summary,
      sample_size, population_size, sampling_justification
    FROM audits WHERE workspace_id=? ORDER BY audit_date DESC, id DESC`).all(workspace.id);

  const majorCount = clauseFindings.filter(finding => /MAJOR|CRITICAL/.test(finding.severity)).length;
  const minorCount = clauseFindings.filter(finding => /MINOR/.test(finding.severity)).length;
  const reportDate = cutoff;
  const reportId = currentState
    ? `GA-${String(workspace.id).padStart(4, '0')}-STATUS-${cutoff.slice(0, 10).replace(/-/g, '')}`
    : `GA-${String(workspace.id).padStart(4, '0')}-P${String(pass.pass_number).padStart(2, '0')}`;
  const revision = currentState ? 'WORKING' : `${pass.pass_number}.0`;
  const reportHash = crypto.createHash('sha256').update(JSON.stringify({
    workspace: workspace.id,
    scope: workspace.scope,
    mode: currentState ? 'current_state' : 'assessment_pass',
    pass: pass.id || null,
    passNumber: pass.pass_number || null,
    cutoff,
    rows: rows.map(row => [row.id, row.status, row.maturity, row.applicability, row.notes, row.evidenceRefs]),
    evidence: evidence.map(row => [row.ref, row.filename, row.sha256, row.uploaded_at, row.period_label]),
    nonconformities: nonconformities.map(row => [row.id, row.severity, row.iso_item_id, row.status, row.corrective_action, row.due_date]),
    tasks: tasks.map(row => [row.iso_item_id, row.title, row.owner_name, row.due_date, row.status])
  })).digest('hex');

  const targetDate = workspace.target_cert_date ? formatDate(workspace.target_cert_date) : 'Not scheduled';
  const scope = String(workspace.scope || '').trim() || 'The formal ISMS scope has not been recorded in the workspace.';
  const reportStatus = currentState ? 'WORKING STATUS'
    : pass.status !== 'completed' ? 'CONTROLLED DRAFT'
    : !reviewRecorded ? 'INDEPENDENT REVIEW REQUIRED'
    : proofGaps.length ? 'EVIDENCE REMEDIATION REQUIRED'
    : 'FINAL';
  const firmName = (firm && firm.name) || 'Compliance Sphere';
  const frameworkGaps = clauseGaps.length + annexGaps.length;
  const notAssessedCount = counts['Not Assessed'];
  const evidenceBackedImplemented = Math.max(0, counts['Implemented'] - proofGaps.length);
  const evidenceBackedPct = applicable.length ? Math.round((evidenceBackedImplemented / applicable.length) * 100) : 0;

  const roadmap = [
    {
      phase: 'P1', name: 'ISMS foundation', window: 'First priority',
      deliverable: clauseCounts['Not Assessed']
        ? `Complete the assessment of ${clauseCounts['Not Assessed']} management-system requirements and retain the basis for each conclusion.`
        : clauseGaps.length
        ? `Close ${clauseGaps.length} management-system clause gaps and approve the governing documents.`
        : 'Confirm the management-system foundation and retain approval evidence.',
      owner: 'ISMS sponsor and programme owner'
    },
    {
      phase: 'P2', name: 'Control decisions', window: 'After P1',
      deliverable: annexCounts['Not Assessed']
        ? `Assess ${annexCounts['Not Assessed']} Annex A controls and record applicability, implementation status, and supporting evidence.`
        : annexCounts['Not Implemented']
        ? `Design or formally exclude ${annexCounts['Not Implemented']} Annex A controls currently not implemented.`
        : 'Confirm remaining Statement of Applicability decisions and control ownership.',
      owner: 'Control owners'
    },
    {
      phase: 'P3', name: 'Control build-out', window: 'After P2',
      deliverable: annexCounts['Not Assessed']
        ? 'Sequence implementation work only after the outstanding control assessments establish the actual gaps.'
        : `${annexCounts['Partially Implemented'] + annexCounts['Work In Progress']} controls require completion or broader operating coverage.`,
      owner: 'Control owners and delivery teams'
    },
    {
      phase: 'P4', name: 'Evidence window', window: 'Before audit',
      deliverable: 'Retain evidence across the agreed operating period, complete internal audit, and complete management review.',
      owner: 'ISMS manager'
    },
    {
      phase: 'AUDIT', name: 'Certification assessment', window: targetDate,
      deliverable: 'Proceed only after the readiness gates and independent assurance conditions are met.',
      owner: 'Executive sponsor'
    }
  ];

  return {
    workspace,
    pass,
    cutoff,
    rows,
    clauseRows,
    annexRows,
    clauseCounts,
    annexCounts,
    counts,
    themes,
    clauseFindings,
    annexFindings,
    findingByItem,
    evidence,
    tasks,
    nonconformities,
    people,
    preparedBy,
    clientOwner,
    reviewer,
    assessmentActivity,
    intakeRows,
    audits,
    roadmap,
    readiness,
    evidenceBackedImplemented,
    evidenceBackedPct,
    proofGaps,
    frameworkGaps,
    majorCount,
    minorCount,
    reportDate,
    reportId,
    revision,
    reportHash,
    reportStatus,
    currentState,
    notAssessedCount,
    firmName,
    targetDate,
    scope,
    accent: /^#[0-9a-f]{6}$/i.test(workspace.brand_primary_color || '') ? workspace.brand_primary_color : '#17354d'
  };
}

function badge(status) {
  return `<span class="status ${statusClass(status)}">${esc(statusShort(status))}</span>`;
}

function metric(label, value, note) {
  return `<td class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></td>`;
}

function findingHtml(finding) {
  return `<article class="finding">
    <div class="finding-head">
      <div><strong>${esc(finding.findingRef)}</strong> ${badge(finding.proofGap ? 'Work In Progress' : (/MAJOR|CRITICAL/.test(finding.severity) ? 'Not Implemented' : 'Partially Implemented'))} <b>${esc(finding.cleanTitle)}</b></div>
      <small>${esc(finding.code)}</small>
    </div>
    <table class="finding-body"><tr>
      <td><span class="field-label">CURRENT STATE</span><p>${esc(finding.currentState)}</p></td>
      <td><span class="field-label">REQUIRED ACTION</span><p>${esc(finding.requiredAction)}</p></td>
    </tr></table>
    <div class="finding-meta">Owner: ${esc(finding.owner)} &nbsp; | &nbsp; Due: ${esc(finding.due)} &nbsp; | &nbsp; Evidence: ${esc(finding.evidenceRefs || 'None linked')}</div>
  </article>`;
}

function reportCss(data) {
  return `
    :root{--ink:#142c3d;--accent:${data.accent};--muted:#687681;--line:#b8c1c7;--pale:#eef2f4;--paper:#fff;}
    *{box-sizing:border-box;} html,body{margin:0;padding:0;background:#fff;color:#17232b;}
    body{font-family:Arial,Helvetica,sans-serif;font-size:9.2pt;line-height:1.42;}
    @page{size:A4;margin:17mm 15mm 18mm;}
    .sheet{page-break-before:always;break-before:page;min-height:245mm;position:relative;}
    .sheet:first-of-type{page-break-before:auto;break-before:auto;}
    h1,h2,h3{font-family:"Arial Narrow",Arial,Helvetica,sans-serif;color:#111d25;margin:0;}
    h1{font-size:30pt;line-height:.98;letter-spacing:-.5pt;}
    h2{font-size:19pt;line-height:1.08;margin:5pt 0 10pt;max-width:145mm;}
    h3{font-size:11pt;margin:12pt 0 4pt;}
    p{margin:0 0 7pt;} small{color:var(--muted);}
    .eyebrow{font-family:"Arial Narrow",Arial,sans-serif;font-size:7.2pt;font-weight:700;letter-spacing:1.35pt;color:#526a7a;text-transform:uppercase;}
    .rule{border-top:1.2pt solid var(--ink);margin:6pt 0 10pt;}
    .hairline{border-top:.6pt solid #d8dde0;margin:8pt 0;}
    .cover{padding-top:7mm;}
    .cover .client-row{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1.2pt solid var(--ink);padding-bottom:6pt;margin-bottom:21mm;}
    .cover .firm{font-size:8pt;font-weight:700;letter-spacing:1.4pt;text-transform:uppercase;color:var(--ink);}
    .cover .client{text-align:right;font-size:10pt;}
    .cover .client span{display:block;font-size:6.5pt;letter-spacing:1pt;color:var(--muted);text-transform:uppercase;}
    .cover h1{font-size:34pt;width:110mm;margin:8pt 0 9pt;}
    .cover h1 span{font-weight:400;}
    .cover .scope-deck{font-size:12pt;color:#4d5c66;width:125mm;margin-bottom:17mm;}
    table{width:100%;border-collapse:collapse;}
    .metrics{border:1pt solid #c4cbd0;margin-bottom:12mm;table-layout:fixed;}
    .metric{border-right:1pt solid #c4cbd0;padding:7pt 8pt;vertical-align:top;}
    .metric:last-child{border-right:none;}
    .metric span{display:block;font-size:6.5pt;letter-spacing:.75pt;color:#5d6b74;text-transform:uppercase;}
    .metric strong{display:block;font-family:"Arial Narrow",Arial,sans-serif;font-size:20pt;color:var(--ink);line-height:1.15;margin:2pt 0;}
    .metric small{display:block;font-size:6.8pt;line-height:1.25;}
    .facts td{padding:3pt 0;vertical-align:top;}
    .facts td:first-child{width:31mm;font-size:6.5pt;letter-spacing:.8pt;color:#677680;text-transform:uppercase;}
    .notice{border:1pt solid #c4cbd0;padding:8pt 10pt;margin-top:12mm;font-size:7.4pt;color:#52616a;}
    .notice strong{display:block;font-size:6.6pt;letter-spacing:.85pt;margin-bottom:3pt;color:#344b5a;}
    .toc{margin-top:12pt;}
    .toc tr{border-bottom:.5pt solid #d8dde0;}
    .toc td{padding:8pt 0;vertical-align:top;}
    .toc td:first-child{width:12mm;color:#526a7a;font-family:"Arial Narrow",Arial,sans-serif;font-weight:700;}
    .toc strong{display:block;font-size:10pt;}.toc small{font-size:7.4pt;}
    .two-col{table-layout:fixed;}.two-col>tbody>tr>td{vertical-align:top;}.two-col>tbody>tr>td:first-child{padding-right:10mm;}.two-col>tbody>tr>td:last-child{padding-left:7mm;border-left:.7pt solid #d4dade;}
    .score-box{border:1pt solid #c2cbd1;padding:8pt 9pt;margin:0 0 9pt;}
    .score-box .score{font-family:"Arial Narrow",Arial,sans-serif;font-size:24pt;color:var(--ink);}
    .bar{height:5pt;background:#e8ecee;margin:4pt 0 2pt;overflow:hidden;}.bar>i{display:block;height:100%;background:var(--accent);}
    .decision-list{margin:5pt 0 0;padding-left:16pt;}.decision-list li{margin:0 0 5pt;}
    .scope-box{border:1pt solid #cbd2d7;background:#f5f7f8;padding:9pt 10pt;margin:7pt 0;white-space:pre-line;}
    .classification{table-layout:fixed;margin:7pt 0 12pt;border:1pt solid #cbd2d7;}.classification td{padding:7pt;border-right:.6pt solid #d5dade;vertical-align:top;}.classification td:last-child{border-right:none;}.classification strong{display:block;font-size:8pt;}.classification small{font-size:7pt;}
    .bullets{margin:5pt 0 0;padding-left:15pt;}.bullets li{margin-bottom:5pt;}
    .status{display:inline-block;padding:1pt 4pt;font-size:6.2pt;font-weight:700;letter-spacing:.35pt;border:1pt solid currentColor;white-space:nowrap;}
    .status.implemented{color:#fff;background:#17354d;border-color:#17354d;}.status.partial{color:#17354d;background:#cfe0ec;border-color:#cfe0ec;}.status.progress{color:#36566c;background:#e5edf2;border-color:#c8d4db;}.status.missing{color:#303b42;background:#fff;border-color:#8f9ba3;}.status.na,.status.unassessed{color:#6f777d;background:#f4f5f5;border-color:#cfd4d7;}
    .finding{border-top:1.2pt solid var(--ink);padding:7pt 0 8pt;break-inside:avoid;page-break-inside:avoid;}.finding-head{display:flex;justify-content:space-between;gap:7pt;align-items:flex-start;}.finding-head>div{display:flex;align-items:center;gap:5pt;}.finding-head small{white-space:nowrap;font-size:6.5pt;}.finding-body{table-layout:fixed;margin-top:5pt;}.finding-body td{width:50%;vertical-align:top;padding-right:9pt;}.finding-body td+td{padding-left:9pt;padding-right:0;border-left:.6pt solid #d6dbde;}.field-label{display:block;font-size:6.2pt;letter-spacing:.7pt;color:#6d7b83;margin-bottom:2pt;}.finding-body p{font-size:8pt;line-height:1.35;}.finding-meta{font-size:6.7pt;color:#64717a;border-top:.5pt solid #e0e4e6;padding-top:4pt;}
    .trace{font-size:7.2pt;}.trace thead{display:table-header-group;}.trace tr{border-bottom:.5pt solid #d4dadd;break-inside:avoid;}.trace th{font-size:6.2pt;letter-spacing:.65pt;text-align:left;color:#596a75;padding:5pt 4pt;border-bottom:1pt solid var(--ink);}.trace td{padding:4pt;vertical-align:top;}.trace .ref{white-space:nowrap;font-weight:700;color:#385466;}
    .matrix{margin:8pt 0 13pt;font-size:8pt;}.matrix th,.matrix td{padding:5pt 7pt;text-align:center;border-bottom:.5pt solid #d4dadd;}.matrix th:first-child,.matrix td:first-child{text-align:left;}.matrix th{font-size:6.4pt;letter-spacing:.65pt;color:#5c6a73;border-bottom:1pt solid var(--ink);}.matrix .hot{background:#244960;color:#fff;}.matrix .warm{background:#a8c5d8;color:#143043;}.matrix .cool{background:#e1eaf0;color:#244250;}
    .roadmap{font-size:7.5pt;}.roadmap tr{border-bottom:.6pt solid #cfd6da;break-inside:avoid;}.roadmap th{font-size:6.2pt;letter-spacing:.6pt;text-align:left;border-bottom:1pt solid var(--ink);padding:5pt 4pt;}.roadmap td{padding:7pt 4pt;vertical-align:top;}.roadmap .phase{font-weight:700;color:#325267;width:11mm;}.roadmap .phase-name{font-weight:700;}.assumption{border:1pt solid #cbd2d7;padding:8pt 10pt;margin-top:11pt;font-size:7.2pt;}
    .evidence-list{font-size:7.1pt;}.evidence-list tr{border-bottom:.5pt solid #d8dde0;}.evidence-list td{padding:4pt 3pt;vertical-align:top;}.evidence-list td:first-child{font-weight:700;color:#39576a;width:12mm;}.evidence-list td:last-child{width:28mm;color:#66737b;}
    .appendix{font-size:6.5pt;}.appendix thead{display:table-header-group;}.appendix tr{border-bottom:.4pt solid #d9dde0;break-inside:avoid;}.appendix th{padding:4pt 3pt;text-align:left;border-bottom:1pt solid var(--ink);font-size:5.8pt;letter-spacing:.55pt;color:#5c6c76;}.appendix td{padding:3pt;vertical-align:top;}.appendix td:first-child{width:15mm;color:#385468;font-weight:700;}.appendix td:nth-child(3){width:28mm;}.appendix td:nth-child(4){width:10mm;text-align:center;}.appendix td:last-child{width:25mm;color:#5c6b74;}
    .section-note{color:#5f6d75;max-width:150mm;margin-bottom:8pt;}.section-number{font-size:6.5pt;font-weight:700;letter-spacing:1pt;color:#5a7383;text-transform:uppercase;}
    .hash{font-family:monospace;font-size:6.3pt;word-break:break-all;color:#64727a;}
  `;
}

function renderGapAssessmentHtml(data) {
  const coverScope = data.workspace.scope
    ? String(data.workspace.scope).split('\n').find(line => line.trim()) || data.workspace.scope
    : `${data.workspace.industry || 'Organization'} information security management system`;
  const applicableAnnex = data.annexRows.filter(row => row.status !== 'Not Applicable').length;
  const executiveHeadline = data.notAssessedCount
    ? `${data.notAssessedCount} requirements have not yet been assessed; this report shows the current recorded position without implying completion.`
    : (data.proofGaps.length
      ? `${data.proofGaps.length} implementation claim${data.proofGaps.length === 1 ? '' : 's'} lack linked evidence and cannot support an assurance conclusion.`
    : (data.frameworkGaps
      ? `The assessment identified ${data.frameworkGaps} gaps that prevent an unqualified readiness conclusion.`
      : 'No implementation or evidence gaps were identified in the concluded assessment population.'));
  const topFindings = [...data.clauseFindings, ...data.annexFindings].slice(0, 5);
  const statusNarrative = `${data.counts['Implemented']} of ${data.rows.length} requirements are implemented, `
    + `${data.counts['Partially Implemented']} are partial, ${data.counts['Work In Progress']} are in progress, `
    + `${data.counts['Not Implemented']} are not implemented, and ${data.counts['Not Assessed']} are not assessed.`;
  const reportDate = formatDate(data.reportDate);
  const positionLabel = data.currentState
    ? 'Current workspace status - no formal pass selected'
    : `Pass ${data.pass.pass_number}${data.pass.label ? ` - ${data.pass.label}` : ''}`;
  const assessmentWindow = data.currentState
    ? `Point-in-time snapshot generated ${reportDate}`
    : `${formatDate(data.pass.started_at)} to ${data.pass.completed_at ? formatDate(data.pass.completed_at) : 'IN PROGRESS'}`;
  const clausePosition = data.clauseCounts['Not Assessed']
    ? `${data.clauseCounts['Not Assessed']} management-system clauses are Not Assessed. No conclusion should be drawn for those requirements until fieldwork is recorded.`
    : (data.clauseFindings.length
      ? `Management-system weaknesses remain across ${data.clauseFindings.length} clauses. These gaps affect the organization's ability to demonstrate a functioning ISMS before control effectiveness is considered.`
      : `The management-system clauses in this ${data.currentState ? 'snapshot' : 'pass'} do not contain recorded implementation gaps.`);
  const annexPosition = data.annexCounts['Not Assessed']
    ? `${data.annexCounts['Not Assessed']} Annex A controls are Not Assessed. They are not counted as implementation gaps because no assessment conclusion exists yet.`
    : (data.annexFindings.length
      ? `${data.annexFindings.length} Annex A controls require design, implementation, broader coverage, or a stronger evidence trail.`
      : 'No Annex A implementation gaps were identified in the concluded population.');
  const leadershipActions = [];
  if (data.notAssessedCount) {
    leadershipActions.push({
      findingRef: 'ASSESS',
      requiredAction: `Complete and evidence the ${data.notAssessedCount} outstanding requirement assessments before using this report as a readiness conclusion.`
    });
  }
  leadershipActions.push(...topFindings);
  if (!leadershipActions.length) {
    leadershipActions.push({
      findingRef: '-',
      requiredAction: 'Protect the current control position and retain evidence through the assurance window.'
    });
  }

  const contents = [
    ['01', 'Executive summary', 'Current position, material gaps, and the decision the report supports'],
    ['02', 'Scope and method', 'Boundary assessed, classification rules, and evidence approach'],
    ['03', 'Management-system findings', 'Clauses 4 to 10 and the issues that determine readiness'],
    ['04', 'Clause traceability', 'Every management-system requirement, status, finding, and evidence reference'],
    ['05', 'Annex A control assessment', 'Theme-level position and the detailed control gaps'],
    ['06', 'Remediation roadmap', 'Sequenced work packages and assurance conditions'],
    ['07', 'Evidence and assessment activity', 'Documents and recorded assessment decisions supporting the report'],
    ['A', 'Appendix A - Full Annex A register', 'All 93 controls in ISO/IEC 27001:2022 order']
  ];

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(data.reportId)} Gap Assessment</title>
    <style>${reportCss(data)}</style></head><body>

    <section class="sheet cover">
      <div class="client-row"><div class="firm">${esc(data.firmName)}</div><div class="client"><span>Client</span>${esc(data.workspace.client_name)}</div></div>
      <div class="eyebrow">Nimbus advisory gap assessment - ${esc(data.reportStatus)}</div>
      <h1>ISO/IEC<br>27001:2022<br><span>Gap Assessment</span></h1>
      <p class="scope-deck">${esc(coverScope)}</p>
      <table class="metrics"><tr>
        ${metric('Assessment coverage', `${Math.round(((data.rows.length - data.notAssessedCount) / data.rows.length) * 100)}%`, `${data.rows.length - data.notAssessedCount} of ${data.rows.length} concluded`)}
        ${metric('Evidence-backed position', `${data.evidenceBackedPct}%`, `${data.evidenceBackedImplemented} applicable requirements supported`)}
        ${metric('Not assessed', data.notAssessedCount, `${data.rows.length - data.notAssessedCount} requirements have a conclusion`)}
        ${metric('Open obligations', data.frameworkGaps, `${data.proofGaps.length} evidence gaps included`)}
      </tr></table>
      <table class="facts">
        <tr><td>Prepared for</td><td>${esc(data.clientOwner ? `${data.clientOwner.name}, ${data.clientOwner.role.replace(/_/g, ' ')}` : data.workspace.client_name)}</td></tr>
        <tr><td>Prepared by</td><td>${esc(data.preparedBy ? `${data.preparedBy.name} - ${data.preparedBy.email}` : 'Assessor not recorded')}</td></tr>
        <tr><td>Assessment window</td><td>${esc(assessmentWindow)}</td></tr>
        <tr><td>Status</td><td>${esc(data.reportStatus)} - ${esc(positionLabel)}</td></tr>
        <tr><td>Independent review</td><td>${esc(data.reviewer ? `${data.reviewer.name} - recorded at pass completion` : (data.currentState ? 'Not applicable to this working status snapshot' : 'Not recorded in the assessment pass'))}</td></tr>
        <tr><td>Distribution</td><td>Confidential - client copy. Controlled report generated from the assessment record.</td></tr>
      </table>
      <div class="notice"><strong>THIS IS NOT A CERTIFICATION AUDIT</strong>
        This report uses the Nimbus proprietary advisory method to assess recorded implementation and evidence against ISO/IEC 27001:2022. The percentage positions are not scores issued or endorsed by ISO, an accreditation body, or a certification body. It does not provide certification, legal advice, or an auditor's certification opinion. Findings reflect records available up to ${esc(formatDate(data.cutoff))}.${data.currentState ? ` This is a working point-in-time status report; ${data.notAssessedCount} requirements are explicitly reported as Not Assessed.` : ''}
      </div>
    </section>

    <section class="sheet">
      <div class="eyebrow">Contents</div><h2>What is in this report</h2>
      <table class="toc">${contents.map(row => `<tr><td>${row[0]}</td><td><strong>${esc(row[1])}</strong><small>${esc(row[2])}</small></td></tr>`).join('')}</table>
    </section>

    <section class="sheet">
      <div class="section-number">01 - Executive summary</div>
      <h2>${esc(executiveHeadline)}</h2>
      <table class="two-col"><tr><td>
        <p>${esc(statusNarrative)} The evidence-backed position is <strong>${data.evidenceBackedPct}%</strong>. Only Implemented conclusions with linked evidence contribute to this position; the individual records remain authoritative.</p>
        <p>${esc(clausePosition)}</p>
        <p>${esc(annexPosition)}</p>
        <p>${data.evidence.length
          ? `${data.evidence.length} evidence records were available by the reporting cutoff. Evidence references in this report resolve to that controlled register.`
          : 'No evidence records were available by the reporting cutoff. This is a material limitation and prevents evidence-based assurance even where implementation was concluded.'}</p>
      </td><td>
        <div class="score-box"><div class="eyebrow">Evidence-backed position</div><div class="score">${data.evidenceBackedPct}%</div><div class="bar"><i style="width:${data.evidenceBackedPct}%"></i></div><small>${data.evidenceBackedImplemented} supported - ${data.proofGaps.length} unsupported claims - ${data.frameworkGaps} open obligations</small></div>
        <h3>What leadership should do next</h3>
        <ol class="decision-list">${leadershipActions.slice(0, 5).map(finding => `<li><strong>${esc(finding.findingRef)}</strong> ${esc(finding.requiredAction)}</li>`).join('')}</ol>
      </td></tr></table>
    </section>

    <section class="sheet">
      <div class="section-number">02 - Scope and method</div><h2>What was assessed, how, and what the sample does not cover</h2>
      <h3>2.1 Assessment boundary</h3><div class="scope-box">${esc(data.scope)}</div>
      <h3>2.2 Assessment method</h3>
      <p>The assessment population covers the 25 management-system requirements in Clauses 4 to 10 and the 93 Annex A controls. ${data.currentState ? 'Each status is the current workspace value at the reporting cutoff. Requirements without a recorded conclusion are shown as Not Assessed.' : `Each conclusion is the latest recorded assessment decision in Pass ${data.pass.pass_number}, including inherited conclusions from earlier passes where applicable.`} Implementation status, maturity, notes, linked evidence, and remediation records were read from the controlled workspace.</p>
      <p>A conclusion of Implemented records the assessor's claim only. It contributes to the evidence-backed position only when current evidence is linked. Linked evidence still requires professional review for relevance, sufficiency, period coverage, and operating effectiveness.</p>
      <h3>2.3 Finding classification</h3>
      <table class="classification"><tr>
        <td><strong>Major gap</strong><small>A requirement or control is not implemented, or a recorded nonconformity is classified as major or critical.</small></td>
        <td><strong>Minor gap</strong><small>The requirement is partial or in progress and needs completion, coverage, or stronger evidence.</small></td>
        <td><strong>Observation</strong><small>No immediate implementation gap, but an assurance or evidence condition should be monitored.</small></td>
        <td><strong>Not applicable</strong><small>The control has an approved exclusion decision; the Statement of Applicability remains authoritative.</small></td>
      </tr></table>
      <h3>2.4 Sampling and limitations</h3>
      <ul class="bullets">
        <li>The report is limited to data and evidence recorded in the workspace by ${esc(formatDate(data.cutoff))}.</li>
        <li>${data.evidence.length ? `${data.evidence.length} evidence records were available. A document count is not proof of sufficiency, relevance, period coverage, or operating effectiveness.` : 'No evidence records were available; implementation conclusions therefore lack a retained evidence basis in this report.'}</li>
        <li>${data.audits.length ? `${data.audits.length} audit records were present. Detailed auditor sampling remains governed by each audit record.` : 'No completed internal-audit record was available to corroborate the assessment conclusions.'}</li>
        <li>Technical testing, independent penetration testing, and legal review are outside this report unless explicitly represented by linked evidence.</li>
        <li>Changes after the reporting cutoff are not reflected. Regenerate the controlled report after material assessment changes.</li>
      </ul>
    </section>

    <section class="sheet">
      <div class="section-number">03 - Management-system findings</div><h2>Clauses 4 to 10 - findings that determine readiness</h2>
      <p class="section-note">These findings address the management system before individual Annex A control conclusions. Each item shows the recorded current state, the required action, ownership, due date, and linked evidence.</p>
      ${data.clauseFindings.length ? data.clauseFindings.map(findingHtml).join('') : `<p>No management-system implementation gaps were recorded in this ${data.currentState ? 'snapshot' : 'pass'}.${data.clauseCounts['Not Assessed'] ? ` ${data.clauseCounts['Not Assessed']} clauses remain Not Assessed.` : ''}</p>`}
    </section>

    <section class="sheet">
      <div class="section-number">04 - Clause traceability</div><h2>Every requirement of Clauses 4 to 10, its status, and its evidence</h2>
      <table class="trace"><thead><tr><th>Clause</th><th>Requirement</th><th>Status</th><th>Finding</th><th>Evidence</th></tr></thead><tbody>
        ${data.clauseRows.map(row => `<tr><td class="ref">${esc(row.code)}</td><td>${esc(row.cleanTitle)}</td><td>${badge(row.status)}</td><td>${esc((data.findingByItem.get(row.id) || {}).findingRef || '-')}</td><td>${esc(row.evidenceRefs || '-')}</td></tr>`).join('')}
      </tbody></table>
    </section>

    <section class="sheet">
      <div class="section-number">05 - Annex A control assessment</div><h2>All 93 controls, placed before any one of them is read</h2>
      <p class="section-note">Theme roll-ups show implementation status only. Applicability decisions and exclusion justifications remain governed by the Statement of Applicability.</p>
      <table class="matrix"><thead><tr><th>Annex A theme</th><th>Implemented</th><th>Partial</th><th>In progress</th><th>Not implemented</th><th>Not assessed</th><th>N/A</th><th>Total</th></tr></thead><tbody>
        ${data.themes.map(theme => `<tr><td><strong>${esc(theme.code)} ${esc(theme.label)}</strong></td><td class="hot">${theme.counts['Implemented']}</td><td class="warm">${theme.counts['Partially Implemented']}</td><td class="cool">${theme.counts['Work In Progress']}</td><td>${theme.counts['Not Implemented']}</td><td>${theme.counts['Not Assessed']}</td><td>${theme.counts['Not Applicable']}</td><td>${theme.rows.length}</td></tr>`).join('')}
        <tr><td><strong>Total</strong></td><td>${data.annexCounts['Implemented']}</td><td>${data.annexCounts['Partially Implemented']}</td><td>${data.annexCounts['Work In Progress']}</td><td>${data.annexCounts['Not Implemented']}</td><td>${data.annexCounts['Not Assessed']}</td><td>${data.annexCounts['Not Applicable']}</td><td>${data.annexRows.length}</td></tr>
      </tbody></table>
      <h3>Detail - ${data.annexFindings.length} controls with a recorded implementation gap</h3>
      ${data.annexFindings.length ? data.annexFindings.map(findingHtml).join('') : `<p>No Annex A implementation gaps were recorded in this ${data.currentState ? 'snapshot' : 'pass'}.${data.annexCounts['Not Assessed'] ? ` ${data.annexCounts['Not Assessed']} controls remain Not Assessed and are listed in Appendix A.` : ''}</p>`}
    </section>

    <section class="sheet">
      <div class="section-number">06 - Remediation roadmap</div><h2>A sequenced path from assessment findings to assurance</h2>
      <p class="section-note">The roadmap is ordered by dependency, not by cosmetic score improvement. Dates in governed tasks take precedence over the indicative phase sequence below.</p>
      <table class="roadmap"><thead><tr><th>Phase</th><th>Work package</th><th>Sequence</th><th>Deliverable and readiness condition</th><th>Accountable role</th></tr></thead><tbody>
        ${data.roadmap.map(row => `<tr><td class="phase">${esc(row.phase)}</td><td class="phase-name">${esc(row.name)}</td><td>${esc(row.window)}</td><td>${esc(row.deliverable)}</td><td>${esc(row.owner)}</td></tr>`).join('')}
      </tbody></table>
      <div class="assumption"><strong>ASSURANCE CONDITION</strong><br>The certification date is a planning target, not a readiness conclusion. Stage 1 should be scheduled only after the ISMS foundation is documented and approved. Stage 2 should follow an evidence window, internal audit, management review, and closure of material nonconformities.</div>
      ${data.tasks.length ? `<h3>Governed remediation tasks</h3><table class="trace"><thead><tr><th>Requirement</th><th>Task</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>${data.tasks.slice(0, 25).map(task => `<tr><td>${esc(itemCode(task.iso_item_id))}</td><td>${esc(task.title)}</td><td>${esc(task.owner_name || 'Unassigned')}</td><td>${esc(task.due_date ? formatDate(task.due_date) : 'Not scheduled')}</td><td>${esc(task.status)}</td></tr>`).join('')}</tbody></table>` : ''}
    </section>

    <section class="sheet">
      <div class="section-number">07 - Evidence and assessment activity</div><h2>What every conclusion in this report is based on</h2>
      <h3>Documents and records reviewed</h3>
      ${data.evidence.length ? `<table class="evidence-list"><tbody>${data.evidence.map(row => `<tr><td>${esc(row.ref)}</td><td><strong>${esc(row.filename)}</strong>${row.description ? `<br><small>${esc(row.description)}</small>` : ''}</td><td>${esc(formatDate(row.uploaded_at))}${row.period_label ? `<br>${esc(row.period_label)}` : ''}</td></tr>`).join('')}</tbody></table>` : '<p>No controlled evidence records were available by the reporting cutoff.</p>'}
      <h3>Recorded assessment activity</h3>
      ${data.assessmentActivity.length ? `<table class="trace"><thead><tr><th>Assessor</th><th>Recorded decisions</th><th>First activity</th><th>Last activity</th></tr></thead><tbody>${data.assessmentActivity.map(row => `<tr><td>${esc(row.name)}</td><td>${row.decisions}</td><td>${esc(formatDate(row.first_activity))}</td><td>${esc(formatDate(row.last_activity))}</td></tr>`).join('')}</tbody></table>` : '<p>No assessment activity was recorded.</p>'}
      <h3>Report provenance</h3>
      <table class="facts"><tr><td>Report ID</td><td>${esc(data.reportId)}</td></tr><tr><td>Revision</td><td>${esc(data.revision)}</td></tr><tr><td>Assessment position</td><td>${esc(positionLabel)}</td></tr><tr><td>Cutoff</td><td>${esc(formatDate(data.cutoff))}</td></tr><tr><td>Snapshot hash</td><td class="hash">${esc(data.reportHash)}</td></tr></table>
    </section>

    <section class="sheet">
      <div class="section-number">Appendix A</div><h2>Full Annex A register - all 93 controls in order</h2>
      <p class="section-note">The register presents the assessment position at the reporting cutoff. The Statement of Applicability remains the authoritative record for applicability and exclusion decisions.</p>
      <table class="appendix"><thead><tr><th>Ref</th><th>Control</th><th>Status</th><th>Mat.</th><th>Finding</th><th>Evidence</th></tr></thead><tbody>
        ${data.annexRows.map(row => `<tr><td>${esc(row.code)}</td><td>${esc(row.cleanTitle)}</td><td>${badge(row.status)}</td><td>${row.maturity == null ? '-' : esc(row.maturity)}</td><td>${esc((data.findingByItem.get(row.id) || {}).findingRef || '-')}</td><td>${esc(row.evidenceRefs || '-')}</td></tr>`).join('')}
      </tbody></table>
    </section>
  </body></html>`;
  return html;
}

function reportHeader(data) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;font-size:7pt;color:#60717d;margin:0;}
    table{width:100%;border-collapse:collapse;}td{padding:0 0 3pt;border-bottom:1pt solid #17354d;}
    td:last-child{text-align:right;letter-spacing:.3pt;}
  </style></head><body><table><tr><td>${esc(data.firmName)}</td><td>ISO/IEC 27001:2022 GAP ASSESSMENT - ${esc(data.workspace.client_name)}</td></tr></table></body></html>`;
}

function reportFooter(data) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;font-size:6.5pt;color:#71808a;margin:0;}
    table{width:100%;border-collapse:collapse;}td{padding-top:3pt;border-top:.6pt solid #cbd2d7;}td:nth-child(2){text-align:center;}td:last-child{text-align:right;}
  </style></head><body><table><tr><td>CONFIDENTIAL - CLIENT COPY</td><td>${esc(data.reportId)} - REV ${esc(data.revision)} - ${esc(formatDate(data.reportDate))}</td><td>Page </td></tr></table></body></html>`;
}

module.exports = {
  buildGapAssessmentReportData,
  renderGapAssessmentHtml,
  reportHeader,
  reportFooter,
  formatDate
};
