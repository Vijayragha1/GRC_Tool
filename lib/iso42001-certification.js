'use strict';

// The AI module historically stored display labels and "completed", whereas
// the shared delivery engine uses stage_1/stage_2 and "closed". Read both forms
// so retained records remain authoritative without a destructive migration.
const EVENT_TYPES = {
  stage_1: 'Stage 1 audit', stage_2: 'Stage 2 audit',
  surveillance_y1: 'Surveillance audit (year 1)', surveillance_y2: 'Surveillance audit (year 2)',
  recertification: 'Recertification audit', internal: 'Internal audit', mrm: 'Management review'
};
const ALIASES = { stage1: 'stage_1', stage2: 'stage_2', surv1: 'surveillance_y1', surv2: 'surveillance_y2', recert: 'recertification' };

function eventKey(value) {
  const text = String(value || '').trim().toLowerCase();
  return Object.keys(EVENT_TYPES).find(key => key === text || EVENT_TYPES[key].toLowerCase() === text) || ALIASES[text] || null;
}
function isClosed(status) { return ['completed', 'closed'].includes(String(status || '').toLowerCase()); }
function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function eventsForStage(db, workspaceId, stage) {
  return db.prepare('SELECT * FROM iso42001_cert_cycle_events WHERE workspace_id=? ORDER BY id')
    .all(workspaceId).filter(row => eventKey(row.event_type) === stage);
}

function validateCertificationEvent(db, workspaceId, candidate, { excludeEventId = null } = {}) {
  const stage = eventKey(candidate.event_type);
  const label = EVENT_TYPES[stage] || 'Certification event';
  const planned = String(candidate.planned_date || '').trim();
  const actual = String(candidate.actual_date || '').trim();
  const status = String(candidate.status || 'planned').toLowerCase();
  const errors = [];
  if (!stage) errors.push('Select a supported ISO 42001 certification event type.');
  if (!['planned', 'in_progress', 'completed', 'closed', 'cancelled'].includes(status)) errors.push('Select a valid certification event status.');
  if (planned && !isValidISODate(planned)) errors.push(`${label} planned date must be a valid ISO date (YYYY-MM-DD).`);
  if (actual && !isValidISODate(actual)) errors.push(`${label} actual date must be a valid ISO date (YYYY-MM-DD).`);
  if (isClosed(status) && !actual) errors.push(`${label} requires an actual audit date before it can be completed.`);
  if (['stage_1', 'stage_2'].includes(stage)) {
    const existing = eventsForStage(db, workspaceId, stage).filter(row => Number(row.id) !== Number(excludeEventId));
    if (existing.length) errors.push(`A ${label} event already exists. Update or reschedule the retained event instead of creating a duplicate.`);
    if (stage === 'stage_2' && isClosed(status)) {
      const prior = certificationAuditState(db, workspaceId, 'stage_1');
      if (!prior.auditComplete) errors.push('Stage 2 cannot complete until exactly one retained Stage 1 event is completed with valid dates.');
      else if (isValidISODate(actual) && actual < prior.actualDate) errors.push('Stage 2 actual audit date cannot be before the Stage 1 actual audit date.');
    }
    if (stage === 'stage_1') {
      const later = eventsForStage(db, workspaceId, 'stage_2').filter(row => isClosed(row.status));
      if (later.length && !isClosed(status)) errors.push('Reopen Stage 2 before reopening or cancelling its Stage 1 audit.');
      if (isValidISODate(actual) && later.some(row => isValidISODate(row.actual_date) && row.actual_date < actual)) {
        errors.push('Stage 1 actual audit date cannot be after an already completed Stage 2 audit.');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function certificationAuditState(db, workspaceId, eventType) {
  const stage = eventKey(eventType);
  if (!['stage_1', 'stage_2'].includes(stage)) throw new Error('Unsupported certification audit stage.');
  const events = eventsForStage(db, workspaceId, stage);
  const invalidDateEvents = events.filter(row => (row.planned_date && !isValidISODate(row.planned_date))
    || (row.actual_date && !isValidISODate(row.actual_date))).length;
  const closed = events.filter(row => isClosed(row.status));
  const validClosed = closed.filter(row => isValidISODate(row.actual_date));
  const auditComplete = events.length === 1 && validClosed.length === 1 && invalidDateEvents === 0;
  let frameworks;
  try { frameworks = JSON.parse(db.prepare('SELECT frameworks FROM workspaces WHERE id=?').get(workspaceId)?.frameworks || '[]'); }
  catch (_) { frameworks = []; }
  const aiOnly = Array.isArray(frameworks) && frameworks.length === 1 && frameworks[0] === 'iso42001';
  const refs = new Set(events.map(row => `iso42001_cert_cycle_event:${row.id}`));
  // Exact lineage wins. Unassigned AI findings also block assurance so leaving
  // the legacy ISO item selector empty cannot manufacture a clean audit result.
  const findings = db.prepare('SELECT source_ref,iso_item_id,severity,status FROM nonconformities WHERE workspace_id=?').all(workspaceId)
    .filter(row => {
      const ref = String(row.source_ref || '');
      if (refs.has(ref)) return true;
      if (/^(?:iso42001_)?cert_cycle_event:\d+$/.test(ref)) {
        if (!ref.startsWith('iso42001_')) return false;
        const id = Number(ref.split(':')[1]);
        return !db.prepare('SELECT 1 FROM iso42001_cert_cycle_events WHERE id=? AND workspace_id=?').get(id, workspaceId);
      }
      return aiOnly || String(row.iso_item_id || '').startsWith('ai-') || ref.startsWith('iso42001:');
    });
  const open = findings.filter(row => !['closed', 'verified'].includes(String(row.status || 'open').toLowerCase()));
  const openMaterialFindings = open.filter(row => ['major', 'minor'].includes(String(row.severity || '').toLowerCase())).length;
  return {
    eventCount: events.length, duplicateEvents: Math.max(0, events.length - 1), invalidDateEvents,
    invalidClosedDates: closed.length - validClosed.length, completedAudits: validClosed.length,
    auditComplete, actualDate: auditComplete ? validClosed[0].actual_date : null,
    totalFindings: findings.length, openFindings: open.length, openMaterialFindings,
    openObservations: open.filter(row => String(row.severity || '').toLowerCase() === 'observation').length,
    materialClear: openMaterialFindings === 0, allClear: open.length === 0
  };
}

function stage2AssuranceState(db, workspaceId) {
  const stage1 = certificationAuditState(db, workspaceId, 'stage_1');
  const stage2 = certificationAuditState(db, workspaceId, 'stage_2');
  const rawAuditComplete = stage2.auditComplete;
  const stageSequenceValid = rawAuditComplete && stage1.auditComplete && stage2.actualDate >= stage1.actualDate;
  return { ...stage2, rawAuditComplete, stageSequenceValid, auditComplete: rawAuditComplete && stageSequenceValid };
}

module.exports = { EVENT_TYPES, eventKey, isClosed, isValidISODate, validateCertificationEvent, certificationAuditState, stage2AssuranceState };
