'use strict';

// Incidents and changes as ISO 42001 reads them. The two registers are shared
// by a client's management systems (routes/registers.js); this module adds
// what an AI management system needs from them, defined once for the
// registers, the readiness check and the path:
//
//  - Incidents (A.8.4, A.6.2.6, 10.2): an AI incident is one linked to an AI
//    system or filed under an AI category. Who must be told is recorded on
//    the incident (notify_who, migration 082) with the deadline and the time
//    they were told, the same columns the regulator clock uses
//    (notification_required_by, notification_sent_at).
//  - Changes (6.3, 8.1, 8.2, 8.4): an AI change is one linked to an AI
//    system. A change marked significant, or not yet judged, means the
//    system's impact assessment and the AI risk assessment are done again; a
//    change judged not significant does not. `significant` is 1, 0 or NULL,
//    and NULL counts as significant, so changes recorded before the flag
//    existed keep triggering a reassessment as they did.
const riskOwner = require('./risk-owner');

const INCIDENT_AI = Object.freeze([
  ['ai_output', 'Harmful or wrong output'],
  ['ai_bias', 'Unfair outcome for a person or group'],
  ['ai_drift', 'Model performance degraded or drifted'],
  ['ai_misuse', 'Used outside its intended use'],
  ['ai_data', 'Personal or protected data in training or inputs'],
  ['ai_oversight', 'Human oversight failed'],
]);
const INCIDENT_SECURITY = Object.freeze([
  ['malware', 'Malware'], ['phishing', 'Phishing / social engineering'], ['breach', 'Data breach / unauthorized access'],
  ['dos', 'Denial of service'], ['physical', 'Physical security'], ['insider', 'Insider threat'], ['supplier', 'Supplier-originated'],
]);
const CHANGE_AI = Object.freeze([
  ['ai_model', 'Model retrained, fine-tuned or replaced'],
  ['ai_data', 'New or changed data'],
  ['ai_use', 'New use, users or deployment context'],
  ['ai_supplier', 'Supplier model or service updated'],
]);
const CHANGE_GENERAL = Object.freeze([
  ['infrastructure', 'Infrastructure'], ['application', 'Application'], ['network', 'Network'],
  ['security', 'Security'], ['policy', 'Policy / procedure'],
]);
const LABELS = Object.fromEntries([...INCIDENT_AI, ...INCIDENT_SECURITY, ...CHANGE_AI, ...CHANGE_GENERAL, ['other', 'Other']]);

function label(category) {
  return LABELS[category] || String(category || '').replace(/_/g, ' ');
}

// Which standards the client runs, for the registers' wording.
function framing(ws) {
  const systems = riskOwner.systemsOf(ws);
  const iso42001 = systems.includes('iso42001');
  const iso27001 = systems.includes('iso27001');
  return { iso42001, iso27001, aimsOnly: iso42001 && !iso27001, both: iso42001 && iso27001 };
}

// The category groups a register offers this client.
function incidentCategories(ws) {
  const f = framing(ws);
  return f.iso42001
    ? [{ label: 'AI system', options: INCIDENT_AI }, { label: 'Information security', options: INCIDENT_SECURITY }]
    : [{ label: null, options: INCIDENT_SECURITY }];
}
function changeCategories(ws) {
  const f = framing(ws);
  return f.iso42001
    ? [{ label: 'AI system', options: CHANGE_AI }, { label: 'General', options: CHANGE_GENERAL }]
    : [{ label: null, options: CHANGE_GENERAL }];
}

const AI_INCIDENT = (alias) => `(${alias}.category LIKE 'ai\\_%' ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM ai_system_links l WHERE l.workspace_id=${alias}.workspace_id AND l.link_type='incident' AND l.target_id=${alias}.id))`;

// The client's AI systems, for the "affected AI system" choice.
function systemChoices(db, ws) {
  return db.prepare(`SELECT id, name FROM ai_systems WHERE workspace_id=? AND lifecycle_stage != 'retired' ORDER BY name`).all(ws.id);
}

// The AI systems an incident or change is linked to.
function linkedSystems(db, ws, type, targetId) {
  return db.prepare(`SELECT s.id, s.name FROM ai_system_links l JOIN ai_systems s ON s.id=l.ai_system_id
    WHERE l.workspace_id=? AND l.link_type=? AND l.target_id=? ORDER BY s.name`).all(ws.id, type, Number(targetId));
}

// Link an incident or change to one of the client's AI systems. Returns false
// when the system is not this client's (the link table's trigger refuses a
// cross-client link as well).
function linkSystem(db, ws, actorId, type, targetId, systemId) {
  const id = Number(systemId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!db.prepare('SELECT 1 FROM ai_systems WHERE id=? AND workspace_id=?').get(id, ws.id)) return false;
  db.prepare(`INSERT OR IGNORE INTO ai_system_links (ai_system_id, workspace_id, link_type, target_id, linked_by)
    VALUES (?, ?, ?, ?, ?)`).run(id, ws.id, type, Number(targetId), actorId);
  return true;
}

// 1, 0 or NULL from a yes / no / not-decided answer.
function significance(value) {
  if (value === 'yes' || value === '1') return 1;
  if (value === 'no' || value === '0') return 0;
  return null;
}

// AI incidents whose notice is overdue: a deadline passed with nobody told,
// on an incident still open.
function lateNotices(db, ws) {
  return db.prepare(`SELECT i.id, i.title, i.notification_required_by AS due FROM incidents i
    WHERE i.workspace_id=? AND ${AI_INCIDENT('i')} AND COALESCE(i.status,'open') != 'closed'
      AND i.notification_required_by IS NOT NULL AND i.notification_sent_at IS NULL
      AND datetime(i.notification_required_by) < datetime('now')
    ORDER BY i.notification_required_by`).all(ws.id);
}

function openIncidents(db, ws) {
  return db.prepare(`SELECT COUNT(*) c FROM incidents i WHERE i.workspace_id=? AND ${AI_INCIDENT('i')} AND COALESCE(i.status,'open') != 'closed'`).get(ws.id).c;
}

// Significant AI changes not yet followed by a reassessment: recorded after
// the system's latest approved impact assessment, or after the latest AI risk
// assessment. A system with no approved impact assessment and no risk
// assessment yet is a step of its own on the path, not a change to catch up
// on.
function unassessedChanges(db, ws) {
  const aiRecords = riskOwner.hasBoth(ws) ? " AND r.scope='ai'" : '';
  return db.prepare(`SELECT c.id, c.title, c.created_at, GROUP_CONCAT(DISTINCT s.name) AS systems FROM changes c
    JOIN ai_system_links l ON l.workspace_id=c.workspace_id AND l.link_type='change' AND l.target_id=c.id
    JOIN ai_systems s ON s.id=l.ai_system_id
    WHERE c.workspace_id=? AND COALESCE(c.significant, 1) <> 0 AND (
      c.created_at > (SELECT MAX(ia.approved_at) FROM ai_impact_assessments ia WHERE ia.ai_system_id=s.id AND ia.status='approved')
      OR date(c.created_at) > (SELECT MAX(r.performed_on) FROM risk_assessment_records r WHERE r.workspace_id=c.workspace_id${aiRecords}))
    GROUP BY c.id ORDER BY c.created_at`).all(ws.id);
}

module.exports = {
  INCIDENT_AI, INCIDENT_SECURITY, CHANGE_AI, CHANGE_GENERAL, AI_INCIDENT,
  label, framing, incidentCategories, changeCategories, systemChoices, linkedSystems, linkSystem, significance,
  lateNotices, openIncidents, unassessedChanges,
};
