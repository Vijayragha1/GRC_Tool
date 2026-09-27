'use strict';

const crypto = require('crypto');
const rbac = require('./rbac');
const conclusionFields = ['status','applicability','maturity','inclusion_justification','exclusion_justification','notes','assessment_answers'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const href = (wsId, passId) => `/workspaces/${wsId}/iso42001/gap-assessment${passId ? `/${passId}/report` : ''}`;

function requireActor(db, workspaceId, actorId, permission) {
  const actor = db.prepare(`SELECT u.* FROM users u JOIN workspaces w ON w.firm_id=u.firm_id
    WHERE w.id=? AND u.id=? AND u.user_type='firm' AND u.active=1`).get(workspaceId, actorId);
  if (!actor || !rbac.hasPermission(rbac.effectivePermissions(actor.firm_role,
    rbac.activeOverrides(db, workspaceId, actorId)), permission)) throw fail('An authorized firm reviewer is required.', 403);
  return actor;
}

function startPass(db, workspaceId, actorId) {
  requireActor(db, workspaceId, actorId, 'control.update');
  const passId = db.transaction(() => {
    if (db.prepare("SELECT id FROM iso42001_assessment_passes WHERE workspace_id=? AND status='open'").get(workspaceId)) {
      throw fail('Complete the open assessment pass with independent sign-off before starting another.');
    }
    const number = db.prepare('SELECT COALESCE(MAX(pass_number),0)+1 n FROM iso42001_assessment_passes WHERE workspace_id=?').get(workspaceId).n;
    return Number(db.prepare('INSERT INTO iso42001_assessment_passes(workspace_id,pass_number,name,started_by) VALUES (?,?,?,?)')
      .run(workspaceId, number, `Pass ${number}`, actorId).lastInsertRowid);
  })();
  reconcileDelivery(db,workspaceId,actorId,'A new ISO 42001 assessment pass was started.');
  return passId;
}

function reconcileDelivery(db, workspaceId, actorId, reason = 'ISO 42001 assessment conclusions changed.') {
  // Load the shared engine only for an existing plan, after the assessment
  // mutation. This avoids the adapter/assessment module initialization cycle.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engagement_delivery_plans'").get()
      || !db.prepare('SELECT id FROM engagement_delivery_plans WHERE workspace_id=?').get(workspaceId)) return null;
  const workspace=db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  const frameworks=require('./engagement-outcome-scope').frameworkCodes(workspace);
  if(!frameworks.includes('iso42001') || frameworks.includes('iso27001'))return null;
  return require('./engagement-delivery').reconcileCompletionState(db,workspace,actorId,{ reason });
}

function evidenceFor(db, workspaceId, itemId) {
  return db.prepare(`SELECT DISTINCT e.id,e.filename,e.sha256,e.size_bytes,e.description,e.uploaded_by,e.uploaded_at,
    e.valid_from,e.valid_until,e.period_label,e.clause_section
    FROM evidence e WHERE e.workspace_id=? AND e.superseded_at IS NULL AND (e.iso_item_id=? OR EXISTS (
      SELECT 1 FROM evidence_requirement_links l JOIN requirements r ON r.id=l.requirement_id
      JOIN frameworks f ON f.id=r.framework_id WHERE l.evidence_id=e.id AND f.code='iso42001' AND r.ref=?)) ORDER BY e.id`)
    .all(workspaceId, itemId, itemId).map(evidence=>({...evidence,requirement_links:db.prepare(`SELECT l.rowid AS link_id,l.section_ref
      FROM evidence_requirement_links l JOIN requirements r ON r.id=l.requirement_id JOIN frameworks f ON f.id=r.framework_id
      WHERE l.evidence_id=? AND f.code='iso42001' AND r.ref=? ORDER BY l.rowid`).all(evidence.id,itemId)}));
}

function assessmentContext(db, workspaceId) {
  const has = table => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return {
    scope:db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId)?.scope || '',
    intake:has('iso42001_intake_answers') ? db.prepare('SELECT question_key,answer FROM iso42001_intake_answers WHERE workspace_id=? ORDER BY question_key').all(workspaceId) : [],
    custom_controls:has('iso42001_soa_custom_controls') ? db.prepare(`SELECT id,code,title,source,summary,applicability,status,inclusion_justification,exclusion_justification FROM iso42001_soa_custom_controls WHERE workspace_id=? ORDER BY id`).all(workspaceId) : [],
    soa_metadata:has('iso42001_soa_snapshots') ? db.prepare('SELECT version,owner,approved_by,approved_at FROM iso42001_soa_snapshots WHERE workspace_id=? ORDER BY id DESC LIMIT 1').get(workspaceId) || null : null
  };
}

function qualityForPass(db, workspaceId, pass) {
  if (!pass) return { ready:false, totalItems:0, assessedItems:0, defects:['Start an assessment pass.'], items:[] };
  const rows = db.prepare(`SELECT i.*,h.id source_history_id,h.pass_id source_pass_id,h.changed_by,h.snapshot_at,
    h.status,h.applicability,h.maturity,h.inclusion_justification,h.exclusion_justification,h.notes,h.assessment_answers
    FROM iso42001_items i LEFT JOIN iso42001_control_state_history h ON h.id=(
      SELECT h2.id FROM iso42001_control_state_history h2 JOIN iso42001_assessment_passes p ON p.id=h2.pass_id
      WHERE h2.workspace_id=? AND p.workspace_id=? AND h2.iso_item_id=i.id AND p.pass_number<=?
      ORDER BY p.pass_number DESC,h2.id DESC LIMIT 1)
    WHERE i.type IN ('clause','control') ORDER BY i.sort_order`).all(workspaceId, workspaceId, pass.pass_number);
  const defects = [], items = [];
  for (const row of rows) {
    const evidence = evidenceFor(db, workspaceId, row.id);
    const current = db.prepare('SELECT * FROM v_iso42001_control_states WHERE workspace_id=? AND iso_item_id=?').get(workspaceId, row.id);
    const status = row.status || 'Not Assessed';
    if (!row.source_history_id || status === 'Not Assessed') defects.push(`${row.id}: record a conclusion in the assessment history.`);
    else if (!['Implemented','Partially Implemented','Work In Progress','Not Implemented','Not Applicable'].includes(status)) defects.push(`${row.id}: invalid conclusion.`);
    if (row.source_history_id && row.source_pass_id !== pass.id) defects.push(`${row.id}: reverify this requirement in the current pass.`);
    if (row.source_history_id && !row.changed_by) defects.push(`${row.id}: reverify this conclusion with a recorded preparer.`);
    if (row.type === 'clause' && (status === 'Not Applicable' || row.applicability !== 'included')) defects.push(`${row.id}: mandatory clauses must be included.`);
    if (row.type === 'control' && !['included','excluded'].includes(row.applicability)) defects.push(`${row.id}: decide Annex A applicability.`);
    if ((status === 'Not Applicable') !== (row.applicability === 'excluded')) defects.push(`${row.id}: align the conclusion with applicability.`);
    if ((status === 'Not Applicable' || row.applicability === 'excluded') && String(row.exclusion_justification || '').trim().length < 20) defects.push(`${row.id}: record a defensible exclusion rationale.`);
    if (['Partially Implemented','Work In Progress','Not Implemented'].includes(status) && String(row.notes || '').trim().length < 20) defects.push(`${row.id}: explain the observed gap.`);
    // Coverage periods may intentionally be historical operating periods.
    // Do not mistake valid_until for file expiry; retain those dates for review.
    if (status === 'Implemented' && !evidence.some(e => /^[a-f0-9]{64}$/i.test(e.sha256 || ''))) defects.push(`${row.id}: link non-superseded evidence with a retained file hash.`);
    if (row.source_history_id && (!current || conclusionFields.some(key => String(current[key] ?? '') !== String(row[key] ?? '')))) defects.push(`${row.id}: the recorded control changed; save its current conclusion in this pass.`);
    items.push({ id:row.id, title:row.title, type:row.type, category:row.category,
      source_history_id:row.source_history_id, source_pass_id:row.source_pass_id, changed_by:row.changed_by,
      source_recorded_at:row.snapshot_at, ...Object.fromEntries(conclusionFields.map(key => [key,row[key] ?? null])), evidence });
  }
  if (!rows.length) defects.push('The ISO 42001 catalogue is unavailable.');
  if (!items.some(item => item.source_pass_id === pass.id)) defects.push('Save at least one verification decision in this pass.');
  return { ready:defects.length === 0, totalItems:rows.length,
    assessedItems:rows.filter(row => row.source_history_id && row.status !== 'Not Assessed').length, defects, items };
}

function loadSnapshot(db, workspaceId, passId) {
  const row = db.prepare('SELECT * FROM iso42001_assessment_snapshots WHERE workspace_id=? AND pass_id=?').get(workspaceId, passId);
  if (!row) return null;
  if (hash(row.snapshot_json) !== row.snapshot_hash) throw fail('The retained assessment snapshot failed its integrity check.');
  return { ...row, data:JSON.parse(row.snapshot_json) };
}

function completePass(db, workspaceId, passId, actorId) {
  const reviewer = requireActor(db, workspaceId, actorId, 'assessment.signoff');
  return db.transaction(() => {
    const pass = db.prepare('SELECT * FROM iso42001_assessment_passes WHERE id=? AND workspace_id=?').get(passId, workspaceId);
    if (!pass) throw fail('Assessment pass not found.',404);
    if (pass.status !== 'open') throw fail('This pass is closed. Start a new pass; historical completions cannot be retrospectively signed off.');
    const quality = qualityForPass(db, workspaceId, pass);
    if (!pass.started_by || Number(pass.started_by) === Number(actorId) || quality.items.some(item => Number(item.changed_by) === Number(actorId))) {
      throw fail('Independent sign-off requires a reviewer who did not prepare this pass or its retained conclusions.',403);
    }
    if (!quality.ready) throw fail(`This pass cannot be completed. ${quality.defects.join(' ')}`,422);
    const preparedBy = db.prepare('SELECT id,name FROM users WHERE id=?').get(pass.started_by);
    const reviewedAt = new Date().toISOString();
    const snapshot = { version:1, framework:'iso42001', workspace_id:workspaceId, pass_id:pass.id,
      pass_number:pass.pass_number, name:pass.name, prepared_by:preparedBy, reviewed_by:{ id:reviewer.id,name:reviewer.name },
      reviewed_at:reviewedAt, conclusion:'Assessment conclusions independently reviewed; this is not a certification decision.',
      assessment_context:assessmentContext(db,workspaceId), items:quality.items };
    const json = JSON.stringify(snapshot), digest = hash(json);
    db.prepare(`INSERT INTO iso42001_assessment_snapshots(workspace_id,pass_id,prepared_by,reviewed_by,reviewed_at,snapshot_json,snapshot_hash)
      VALUES (?,?,?,?,?,?,?)`).run(workspaceId,pass.id,pass.started_by,actorId,reviewedAt,json,digest);
    const result = db.prepare("UPDATE iso42001_assessment_passes SET status='completed',completed_at=? WHERE id=? AND workspace_id=? AND status='open'")
      .run(reviewedAt,pass.id,workspaceId);
    if (result.changes !== 1) throw fail('The assessment pass changed before sign-off.');
    return loadSnapshot(db,workspaceId,pass.id);
  })();
}

// Complete means the latest work is independently reviewed and its retained
// conclusions/evidence still match the live records. The frozen report itself
// remains available after later edits or a new pass.
function getGapState(db, workspaceId) {
  const pass = db.prepare(`SELECT * FROM iso42001_assessment_passes WHERE workspace_id=?
    ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,pass_number DESC LIMIT 1`).get(workspaceId) || null;
  const snapshot = pass ? loadSnapshot(db,workspaceId,pass.id) : null;
  const quality = qualityForPass(db,workspaceId,pass);
  const reviewed = !!(pass?.status === 'completed' && snapshot);
  const blockers = !pass ? ['Start an ISO 42001 assessment pass.'] : !reviewed
    ? [pass.status === 'completed' ? 'Legacy completion has no independent review snapshot. Start a new governed pass.' : 'Complete independent assessment sign-off.', ...quality.defects]
    : !quality.ready || JSON.stringify(snapshot.data.items) !== JSON.stringify(quality.items)
      || JSON.stringify(snapshot.data.assessment_context) !== JSON.stringify(assessmentContext(db,workspaceId))
      ? ['The live assessment or evidence changed after review. Complete a new assessment pass.', ...quality.defects] : [];
  return { complete:reviewed && !blockers.length, reviewed, pass, snapshot, quality, blockers,
    snapshot_id:snapshot?.id || null, snapshot_hash:snapshot?.snapshot_hash || null,
    href:href(workspaceId,reviewed ? pass.id : null) };
}

module.exports = { startPass, qualityForPass, completePass, loadSnapshot, getGapState, reconcileDelivery };
