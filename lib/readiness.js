'use strict';
// Readiness engine: mandatory-records detection, Stage 1/2 scoring, roadmap
// derivation. Extracted from server.js (slice 16); consumed by
// routes/readiness.js, routes/workspaces.js, the exec brief, and the
// dashboard roll-ups.

const { db } = require('../db');
const ctlReads = require('./control-reads');
const { findControlledDocument, documentRegisterTruth } = require('./document-truth');
const { todayFor, ymdInZone, workspaceTimeZone } = require('./dates');

// Mandatory documented information per ISO 27001:2022.
// `tier: 'mandatory'` → explicitly required by a clause of ISO 27001:2022.
// `tier: 'expected'`  → not explicitly required but commonly produced and expected by certification auditors,
//                       or required only if the related Annex A control is included in the SoA.
// Detection is heuristic - confirms presence of an artefact in this tool; verify completeness manually.
const MANDATORY_RECORDS = [
  // ----- Explicitly mandatory per ISO 27001:2022 -----
  { key: 'isms_scope', tier: 'mandatory', clause: '4.3', name: 'ISMS scope',
    detect: (ws, db) => !!(ws.scope && ws.scope.length > 10) },
  { key: 'isms_policy', tier: 'mandatory', clause: '5.2', name: 'Information security policy',
    detect: (ws, db) => !!findControlledDocument(db, ws.id, ['Information Security Policy']) },
  { key: 'risk_assessment_process', tier: 'mandatory', clause: '6.1.2', name: 'Risk assessment process',
    detect: (ws, db) => !!findControlledDocument(db, ws.id, ['Risk Assessment Methodology','Risk Management Methodology','Risk Assessment Procedure']) },
  { key: 'risk_assessment_results', tier: 'mandatory', clause: '6.1.2 / 8.2', name: 'Risk assessment results',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(ws.id).c > 0 },
  { key: 'risk_treatment_process', tier: 'mandatory', clause: '6.1.3', name: 'Risk treatment process',
    detect: (ws, db) => !!findControlledDocument(db, ws.id, ['Risk Treatment Process','Risk Treatment Plan','Risk Management Methodology','Risk Assessment and Treatment Methodology']) },
  { key: 'soa', tier: 'mandatory', clause: '6.1.3 d)', name: 'Statement of Applicability',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, ws.id).cs} WHERE workspace_id=? AND applicability IN ('included','excluded')`).get(ws.id).c >= 93 },
  { key: 'risk_treatment_plan', tier: 'mandatory', clause: '6.1.3 e) / 8.3', name: 'Risk treatment plan',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=? AND treatment IS NOT NULL`).get(ws.id).c > 0 },
  { key: 'objectives', tier: 'mandatory', clause: '6.2', name: 'Information security objectives',
    detect: (ws, db) => {
      const cs = db.prepare(`SELECT notes FROM ${ctlReads.tables(db, ws.id).cs} WHERE workspace_id=? AND iso_item_id='clause-6.2'`).get(ws.id);
      return !!(cs && cs.notes && cs.notes.length > 30);
    } },
  { key: 'competence', tier: 'mandatory', clause: '7.2', name: 'Records of competence',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id IN ('clause-7.2','annex-a.6.3') LIMIT 1`).get(ws.id) },
  { key: 'operational_planning', tier: 'mandatory', clause: '8.1', name: 'Evidence operational processes carried out as planned',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? LIMIT 1`).get(ws.id) },
  { key: 'monitoring_results', tier: 'mandatory', clause: '9.1', name: 'Monitoring and measurement results',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id='clause-9.1' LIMIT 1`).get(ws.id) },
  { key: 'internal_audit_programme', tier: 'mandatory', clause: '9.2', name: 'Internal audit programme',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=?`).get(ws.id).c > 0 },
  { key: 'internal_audit_results', tier: 'mandatory', clause: '9.2', name: 'Internal audit results',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND status='complete'`).get(ws.id).c > 0 },
  { key: 'management_review', tier: 'mandatory', clause: '9.3', name: 'Management review results',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status='complete'`).get(ws.id).c > 0 },
  { key: 'nc_records', tier: 'mandatory', clause: '10.2', name: 'Nonconformities and corrective action results',
    detect: (ws, db) => true },

  // ----- Required if the related Annex A control is included in the SoA -----
  { key: 'asset_inventory', tier: 'expected', clause: 'A.5.9', name: 'Inventory of information and associated assets',
    detect: (ws, db) => db.prepare(`SELECT COUNT(*) c FROM assets WHERE workspace_id=?`).get(ws.id).c > 0 },
  { key: 'legal_register', tier: 'expected', clause: 'A.5.31', name: 'Register of legal, regulatory, contractual requirements',
    detect: (ws, db) => {
      const cs = db.prepare(`SELECT notes FROM ${ctlReads.tables(db, ws.id).cs} WHERE workspace_id=? AND iso_item_id='annex-a.5.31'`).get(ws.id);
      return !!(cs && cs.notes && cs.notes.length > 30);
    } },
  { key: 'access_control', tier: 'expected', clause: 'A.5.15', name: 'Topic-specific policy on access control',
    detect: (ws, db) => !!findControlledDocument(db, ws.id, ['Access Control Policy']) },
  { key: 'incident_plan', tier: 'expected', clause: 'A.5.24', name: 'Incident management procedure',
    detect: (ws, db) => !!findControlledDocument(db, ws.id, ['Information Security Incident Management Procedure','Incident Management Procedure']) },
  { key: 'continuity', tier: 'expected', clause: 'A.5.29 / A.5.30', name: 'Business continuity / ICT readiness arrangements',
    detect: (ws, db) => !!findControlledDocument(db, ws.id, ['Business Continuity Plan','Disaster Recovery Plan','ICT Readiness Plan']) },
  { key: 'awareness', tier: 'expected', clause: '7.3 / A.6.3', name: 'Awareness and training records',
    detect: (ws, db) => !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id IN ('annex-a.6.3','clause-7.3') LIMIT 1`).get(ws.id) },
  { key: 'cryptography_policy', tier: 'expected', clause: 'A.8.24', name: 'Cryptography topic-specific policy (if A.8.24 included)',
    detect: (ws, db) => !!findControlledDocument(db, ws.id, ['Cryptography Policy','Cryptographic Controls Policy']) }
];

// Implementation roadmap - PDCA-aligned, mapped to ISO 27001:2022 clauses.
// Each step is "complete" when a sensible signal exists; otherwise "pending".
// Shared between the Overview dashboard and the dedicated /roadmap page so
// they always reflect the same source of truth. Caller passes the scalars
// already prepared in the workspace overview route to avoid duplicate
// queries; the /roadmap route prepares them itself.
function computeRoadmap(ws, scalars) {
  const { stateRows, assetCount, riskCount, ncOpen } = scalars;
  const annexAssessed = stateRows.filter(r => r.type === 'control' && r.status !== 'Not Assessed').length;
  const annexTotal = stateRows.filter(r => r.type === 'control').length;
  const clausesAssessed = stateRows.filter(r => r.type === 'clause' && r.status !== 'Not Assessed').length;
  const clausesTotal = stateRows.filter(r => r.type === 'clause').length;
  const allAssessed = annexAssessed + clausesAssessed;
  const allTotal = annexTotal + clausesTotal;
  const Tns = ctlReads.tables(db, ws.id);
  const soaDecided = db.prepare(`SELECT COUNT(*) c FROM ${Tns.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability IN ('included','excluded')`).get(ws.id).c;
  const approvedDocs = db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published')`).get(ws.id).c;
  const auditsScheduled = db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND audit_date IS NOT NULL`).get(ws.id).c;
  const mrmsHeld = db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status='complete'`).get(ws.id).c;
  const supplierCount = db.prepare(`SELECT COUNT(*) c FROM suppliers WHERE workspace_id=?`).get(ws.id).c;

  const docSignal = (patterns) => {
    const ors = patterns.map(() => `name LIKE ?`).join(' OR ');
    return db.prepare(`SELECT COUNT(*) c FROM generated_docs
      WHERE workspace_id=? AND status IN ('approved','published') AND (${ors})`).get(ws.id, ...patterns).c;
  };

  const ispApproved = docSignal(['Information Security Policy%']);
  const contextApproved = docSignal(['ISMS Governance Manual%', 'ISMS Manual%', 'Context%', 'Interested Parties%']);
  const rolesApproved = docSignal(['ISMS Role -%', 'ISMS Steering%', 'Roles and Responsibilities%', 'RACI%']);
  const objectivesApproved = docSignal(['Information Security Objectives%']);
  const awarenessApproved = docSignal(['Awareness and Training%', 'Awareness%', 'Communication Plan%']);
  const monitoringApproved = docSignal(['Logging and Monitoring%', 'Monitoring%', 'Measurement%', 'KPI%']);

  const methodologyActive = db.prepare(`SELECT COUNT(*) c FROM risk_methodologies
    WHERE workspace_id=? AND is_active=1`).get(ws.id).c;
  const includedControls = db.prepare(`SELECT COUNT(*) c FROM ${Tns.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'`).get(ws.id).c;
  const implementedControls = db.prepare(`SELECT COUNT(*) c FROM ${Tns.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.status='Implemented'`).get(ws.id).c;

  return [
    { phase: 'plan', key: 'scope', label: 'Define ISMS scope', clause: 'Clause 4.3',
      done: !!(ws.scope && ws.scope.length > 10),
      detail: ws.scope ? 'Scope statement set' : 'Set the scope on workspace settings or in an ISMS Scope document',
      link: `/workspaces/${ws.id}#workspace-settings`, link_label: 'Edit scope' },
    { phase: 'plan', key: 'context', label: 'Document context - internal/external issues + interested parties', clause: 'Clauses 4.1 & 4.2',
      done: contextApproved >= 1,
      detail: contextApproved >= 1
        ? 'Context register / ISMS Governance Manual approved'
        : 'Document internal & external issues and interested-party requirements (incl. climate-related per Amendment 1:2024)',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'isp', label: 'Approve Information Security Policy', clause: 'Clause 5.2',
      done: ispApproved >= 1,
      detail: ispApproved >= 1 ? 'ISP approved' : 'Approved ISP is the foundation document - generate from template and approve',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'roles', label: 'Define ISMS roles & responsibilities', clause: 'Clause 5.3',
      done: rolesApproved >= 1,
      detail: rolesApproved >= 1
        ? 'Roles & responsibilities documented'
        : 'Assign CISO, asset owners, risk owners, internal auditor; document responsibilities and authority',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'objectives', label: 'Set information security objectives', clause: 'Clause 6.2',
      done: objectivesApproved >= 1,
      detail: objectivesApproved >= 1
        ? 'Information Security Objectives approved'
        : 'Set measurable, time-bound objectives consistent with the policy (3–7 typically)',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'methodology', label: 'Document risk-assessment methodology', clause: 'Clause 6.1.2',
      done: methodologyActive >= 1,
      detail: methodologyActive >= 1 ? 'Active methodology defined (scales, criteria)' : 'Likelihood/impact scales and risk-acceptance criteria must be set before scoring risks',
      link: `/workspaces/${ws.id}/risk-methodology`, link_label: 'Methodology' },
    { phase: 'plan', key: 'assets', label: 'Build asset register', clause: 'A.5.9 (input to 6.1.2)',
      done: assetCount >= 5, partial: assetCount > 0 && assetCount < 5,
      detail: `${assetCount} asset${assetCount === 1 ? '' : 's'} registered${assetCount > 0 && assetCount < 5 ? ' - most ISMS scopes need at least 5–10' : ''}`,
      link: `/workspaces/${ws.id}/assets`, link_label: 'Assets' },
    { phase: 'plan', key: 'gap', label: 'Gap-assess clauses & Annex A', clause: 'Project activity (covers 4–10, A.5–A.8)',
      done: allAssessed === allTotal && allTotal > 0, partial: allAssessed > 0 && allAssessed < allTotal,
      detail: `${clausesAssessed} / ${clausesTotal} clauses · ${annexAssessed} / ${annexTotal} controls assessed`,
      link: `/workspaces/${ws.id}/gap-assessment`, link_label: 'Run gap assessment' },
    { phase: 'plan', key: 'risks', label: 'Identify, score, and treat risks', clause: 'Clauses 6.1.2 & 6.1.3',
      done: riskCount >= 5, partial: riskCount > 0 && riskCount < 5,
      detail: `${riskCount} risk${riskCount === 1 ? '' : 's'} in register${riskCount === 0 ? ' - start from the library if unsure' : ''}`,
      link: `/workspaces/${ws.id}/risks`, link_label: 'Risks' },
    { phase: 'plan', key: 'soa', label: 'Finalize Statement of Applicability', clause: 'Clause 6.1.3 d',
      done: soaDecided === annexTotal && annexTotal > 0, partial: soaDecided > 0 && soaDecided < annexTotal,
      detail: `${soaDecided} / ${annexTotal} controls have inclusion/exclusion decision with justification`,
      link: `/workspaces/${ws.id}/soa`, link_label: 'SoA' },
    { phase: 'plan', key: 'awareness', label: 'Establish competence, awareness & communication', clause: 'Clauses 7.2, 7.3, 7.4',
      done: awarenessApproved >= 1,
      detail: awarenessApproved >= 1
        ? 'Awareness & Training Plan approved'
        : 'Plan competence requirements, awareness programme (induction + annual refresh), and communication channels',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'plan', key: 'docs', label: 'Approve mandatory documented information', clause: 'Clause 7.5',
      done: approvedDocs >= 8, partial: approvedDocs > 0 && approvedDocs < 8,
      detail: `${approvedDocs} document${approvedDocs === 1 ? '' : 's'} approved (target: at least the 8 mandatory artefacts)`,
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'do', key: 'controls', label: 'Implement applicable Annex A controls', clause: 'Clause 8.3 + A.5–A.8',
      done: includedControls > 0 && implementedControls === includedControls,
      partial: implementedControls > 0 && implementedControls < includedControls,
      detail: includedControls === 0
        ? 'Decide applicability in the SoA first, then implement included controls'
        : `${implementedControls} / ${includedControls} included controls marked Implemented`,
      link: `/workspaces/${ws.id}/controls`, link_label: 'Controls' },
    { phase: 'do', key: 'suppliers', label: 'Manage supplier security operationally', clause: 'Clause 8.1 + A.5.19–A.5.22',
      done: supplierCount >= 1,
      detail: supplierCount === 0 ? 'Identify in-scope suppliers; assess and review per supplier risk tier' : `${supplierCount} supplier${supplierCount === 1 ? '' : 's'} registered`,
      link: `/workspaces/${ws.id}/vendors`, link_label: 'Suppliers' },
    { phase: 'check', key: 'monitoring', label: 'Define monitoring, measurement & evaluation', clause: 'Clause 9.1',
      done: monitoringApproved >= 1,
      detail: monitoringApproved >= 1
        ? 'Monitoring approach documented'
        : 'Determine what to monitor, methods, frequency, who analyses - KPIs aligned with objectives (6.2)',
      link: `/workspaces/${ws.id}/documents`, link_label: 'Documents' },
    { phase: 'check', key: 'audit', label: 'Run an internal audit', clause: 'Clause 9.2',
      done: auditsScheduled >= 1,
      detail: auditsScheduled === 0 ? 'Plan the audit programme; first audit must precede Stage 1 cert audit' : `${auditsScheduled} audit${auditsScheduled === 1 ? '' : 's'} scheduled or run`,
      link: `/workspaces/${ws.id}/audits`, link_label: 'Internal audits' },
    { phase: 'check', key: 'mrm', label: 'Hold a management review', clause: 'Clause 9.3',
      done: mrmsHeld >= 1,
      detail: mrmsHeld === 0 ? 'Top management must review the ISMS at planned intervals; cover all 9.3.2 inputs' : `${mrmsHeld} MRM${mrmsHeld === 1 ? '' : 's'} completed`,
      link: `/workspaces/${ws.id}/mrms`, link_label: 'Management review' },
    { phase: 'act', key: 'ncs', label: 'Track nonconformities to closure with root-cause', clause: 'Clause 10.2',
      done: ncOpen === 0,
      detail: ncOpen === 0 ? 'No open NCs' : `${ncOpen} open NC${ncOpen === 1 ? '' : 's'} - RCA + corrective action + effectiveness review per NC`,
      link: `/workspaces/${ws.id}/nonconformities`, link_label: 'Nonconformities' }
  ];
}

function computeReadiness(ws) {
  const today = todayFor(ws);
  const oneYearAgo = ymdInZone(new Date(Date.now() - (365 * 86400000)), workspaceTimeZone(ws));
  const checks = MANDATORY_RECORDS.map(m => ({
    key: m.key, name: m.name, clause: m.clause, tier: m.tier,
    found: !!m.detect(ws, db)
  }));
  const mandatoryChecks = checks.filter(c => c.tier === 'mandatory');
  const expectedChecks = checks.filter(c => c.tier === 'expected');
  const mandFound = mandatoryChecks.filter(c => c.found).length;
  const mandTotal = mandatoryChecks.length;
  const expFound = expectedChecks.filter(c => c.found).length;
  const expTotal = expectedChecks.length;
  const recordsFound = mandFound;
  const recordsTotal = mandTotal;

  // Validation flags - actionable issues, not tutorials
  const flags = [];
  const T = ctlReads.tables(db, ws.id);

  const implNoEvidence = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.status='Implemented'
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.workspace_id=? AND e.iso_item_id=cs.iso_item_id)
    ORDER BY i.sort_order
  `).all(ws.id, ws.id);
  if (implNoEvidence.length) flags.push({ kind: 'implemented_no_evidence', severity: 'high',
    label: `${implNoEvidence.length} requirements and controls marked Implemented without evidence`,
    items: implNoEvidence.slice(0, 10) });

  const implNoOwner = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.status IN ('Implemented','Partially Implemented') AND cs.owner_id IS NULL
    ORDER BY i.sort_order
  `).all(ws.id);
  if (implNoOwner.length) flags.push({ kind: 'no_owner', severity: 'medium',
    label: `${implNoOwner.length} active requirements and controls without an owner`,
    items: implNoOwner.slice(0, 10) });

  const includedNoRisk = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.applicability='included' AND i.type='control'
    AND NOT EXISTS (SELECT 1 FROM risk_controls rc INNER JOIN risks r ON r.id=rc.risk_id WHERE rc.iso_item_id=i.id AND r.workspace_id=?)
    AND (cs.inclusion_justification IS NULL OR length(cs.inclusion_justification) < 10)
    ORDER BY i.sort_order
  `).all(ws.id, ws.id);
  if (includedNoRisk.length) flags.push({ kind: 'included_no_basis', severity: 'high',
    label: `${includedNoRisk.length} SoA-included controls have no driving risk and no justification`,
    items: includedNoRisk.slice(0, 10) });

  const excludedNoJust = db.prepare(`
    SELECT i.id, i.title FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id = cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.applicability='excluded' AND i.type='control'
    AND (cs.exclusion_justification IS NULL OR length(cs.exclusion_justification) < 10)
    ORDER BY i.sort_order
  `).all(ws.id);
  if (excludedNoJust.length) flags.push({ kind: 'excluded_no_basis', severity: 'high',
    label: `${excludedNoJust.length} SoA-excluded controls without justification`,
    items: excludedNoJust.slice(0, 10) });

  const undecidedSoA = db.prepare(`
    SELECT COUNT(*) c FROM iso_items i
    LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND COALESCE(cs.applicability,'undecided')='undecided'
  `).get(ws.id).c;
  if (undecidedSoA > 0) flags.push({ kind: 'undecided_soa', severity: 'medium',
    label: `${undecidedSoA} Annex A controls still undecided in the SoA`, items: [] });

  const openMajorNCs = db.prepare(`
    SELECT id, title FROM nonconformities WHERE workspace_id=? AND severity='major' AND status NOT IN ('closed','verified')
  `).all(ws.id);
  if (openMajorNCs.length) flags.push({ kind: 'open_major_ncs', severity: 'high',
    label: `${openMajorNCs.length} major nonconformities open`,
    items: openMajorNCs });

  const overdueNCs = db.prepare(`
    SELECT id, title, due_date FROM nonconformities
    WHERE workspace_id=? AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < ?
  `).all(ws.id, today);
  if (overdueNCs.length) flags.push({ kind: 'overdue_ncs', severity: 'high',
    label: `${overdueNCs.length} nonconformities past due`,
    items: overdueNCs });

  const orphanRisks = db.prepare(`
    SELECT id, title FROM risks WHERE workspace_id=? AND status='open'
    AND NOT EXISTS (SELECT 1 FROM risk_controls WHERE risk_id=risks.id)
  `).all(ws.id);
  if (orphanRisks.length) flags.push({ kind: 'orphan_risks', severity: 'medium',
    label: `${orphanRisks.length} open risks not linked to any control`,
    items: orphanRisks.slice(0, 10) });

  const noOwnerRisks = db.prepare(`
    SELECT id, title FROM risks WHERE workspace_id=? AND (owner_name IS NULL OR owner_name='')
  `).all(ws.id);
  if (noOwnerRisks.length) flags.push({ kind: 'no_owner_risks', severity: 'medium',
    label: `${noOwnerRisks.length} risks without an owner`,
    items: noOwnerRisks.slice(0, 10) });

  // Supplier-related flags
  const expiredSupplierDocs = db.prepare(`
    SELECT s.name AS title, s.id, d.name AS doc, d.expiry_date FROM supplier_documents d
    INNER JOIN suppliers s ON s.id=d.supplier_id
    WHERE s.workspace_id=? AND d.expiry_date < ?`).all(ws.id, today);
  if (expiredSupplierDocs.length) flags.push({ kind: 'expired_supplier_docs', severity: 'high',
    label: `${expiredSupplierDocs.length} supplier attestations / contracts expired`,
    items: expiredSupplierDocs.map(d => ({ id: d.id, title: `${d.title} - ${d.doc}` })).slice(0, 10) });

  const overdueSupplierReviews = db.prepare(`
    SELECT id, name AS title FROM suppliers
    WHERE workspace_id=? AND lifecycle_stage NOT IN ('terminated') AND next_review_date < ?`).all(ws.id, today);
  if (overdueSupplierReviews.length) flags.push({ kind: 'overdue_supplier_reviews', severity: 'medium',
    label: `${overdueSupplierReviews.length} supplier reviews overdue`,
    items: overdueSupplierReviews.slice(0, 10) });

  const tier1NoAttestation = db.prepare(`
    SELECT s.id, s.name AS title FROM suppliers s
    WHERE s.workspace_id=? AND s.lifecycle_stage NOT IN ('terminated')
    AND EXISTS (SELECT 1 FROM supplier_inherent_assessments ia
      WHERE ia.supplier_id=s.id AND ia.workspace_id=s.workspace_id AND ia.status='approved' AND ia.assigned_tier='tier_1'
      AND ia.id=(SELECT MAX(ia2.id) FROM supplier_inherent_assessments ia2 WHERE ia2.supplier_id=s.id AND ia2.status='approved'))
    AND NOT EXISTS (SELECT 1 FROM supplier_documents d WHERE d.supplier_id=s.id AND d.doc_type IN ('iso_27001','soc2_type2','soc2_type1'))`).all(ws.id);
  if (tier1NoAttestation.length) flags.push({ kind: 'tier1_no_attestation', severity: 'high',
    label: `${tier1NoAttestation.length} critical-tier suppliers without ISO 27001 / SOC 2 attestation`,
    items: tier1NoAttestation.slice(0, 10) });

  const overdueAccessReview = db.prepare(`
    SELECT i.id, i.title, cs.last_updated FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND cs.iso_item_id IN ('annex-a.5.15','annex-a.5.18','annex-a.8.2')
    AND cs.status='Implemented' AND cs.last_updated < datetime('now','-180 days')
    ORDER BY i.sort_order
  `).all(ws.id);
  if (overdueAccessReview.length) flags.push({ kind: 'stale_access_review', severity: 'medium',
    label: `Access controls reviewed > 180 days ago`,
    items: overdueAccessReview });

  // Quantitative metrics
  const totals = db.prepare(`SELECT
    SUM(CASE WHEN status='Implemented' THEN 1 ELSE 0 END) AS implemented,
    SUM(CASE WHEN status='Partially Implemented' THEN 1 ELSE 0 END) AS partial,
    SUM(CASE WHEN status='Work In Progress' THEN 1 ELSE 0 END) AS wip,
    SUM(CASE WHEN status='Not Implemented' THEN 1 ELSE 0 END) AS not_impl,
    SUM(CASE WHEN status='Not Applicable' THEN 1 ELSE 0 END) AS na,
    AVG(CASE WHEN maturity > 0 THEN maturity END) AS avg_maturity,
    COUNT(*) AS total
    FROM ${T.cs} WHERE workspace_id=?`).get(ws.id) || {};

  const totalItems = db.prepare(`SELECT COUNT(*) c FROM iso_items`).get().c;
  const assessed = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} WHERE workspace_id=? AND status != 'Not Assessed'`).get(ws.id).c;

  // =====================================================================
  // TWO-LAYER READINESS MODEL (per the ISO 27001:2022 readiness rubric,
  // anchored in ISO/IEC 17021-1 + 27006-1:2024)
  //
  // Layer 1 - Hard gate (boolean). Any single FAIL = Not Ready, no matter
  //           how high the maturity score is (mirrors 17021-1 §9.5.2).
  // Layer 2 - Maturity % (0-5 averaged across applicable Annex A controls).
  //           Forecasting only; informs but never overrides Layer 1.
  //           Stage 1 floor 60%; Stage 2 floor 75% with no control at 0/1.
  // =====================================================================
  const wsId = ws.id;
  const evidenceCount = db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=?`).get(wsId).c;

  const controlledDocuments = documentRegisterTruth(db, wsId);
  const docApproved = (likeClauses) => {
    const names = likeClauses.map(value => String(value).replaceAll('%',' ').replace(/\s+/g,' ').trim());
    return !!findControlledDocument(db, wsId, names, { documents: controlledDocuments.documents });
  };
  const itemHasSubstance = (isoId) => {
    const cs = db.prepare(`SELECT notes, maturity FROM ${T.cs} WHERE workspace_id=? AND iso_item_id=?`).get(wsId, isoId);
    return !!(cs && ((cs.notes && cs.notes.trim().length > 30) || (cs.maturity && cs.maturity >= 2)));
  };
  const annexADecided = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability IN ('included','excluded')`).get(wsId).c;
  const soaJustGaps = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control'
      AND ((cs.applicability='included' AND (cs.inclusion_justification IS NULL OR length(trim(cs.inclusion_justification)) < 10))
        OR (cs.applicability='excluded' AND (cs.exclusion_justification IS NULL OR length(trim(cs.exclusion_justification)) < 10)))`).get(wsId).c;
  const interestedPartiesCount = db.prepare(`SELECT COUNT(*) c FROM interested_parties WHERE workspace_id=?`).get(wsId).c;
  const objectivesOk = db.prepare(`SELECT COUNT(*) c FROM security_objectives WHERE workspace_id=?
    AND target_value IS NOT NULL AND length(trim(target_value)) > 0
    AND owner IS NOT NULL AND length(trim(owner)) > 0`).get(wsId).c >= 3;
  const trainingComplete = db.prepare(`SELECT COUNT(*) c FROM training_records WHERE workspace_id=? AND status='complete'`).get(wsId).c;
  const commPlanCount = db.prepare(`SELECT COUNT(*) c FROM communication_plan WHERE workspace_id=?`).get(wsId).c;
  const docRegisterCount = controlledDocuments.current.length;
  const internalAuditClosed = db.prepare(`SELECT COUNT(*) c FROM audits WHERE workspace_id=? AND status IN ('complete','closed')`).get(wsId).c > 0;
  const mrmFull = db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=?
    AND status IN ('complete','closed')
    AND prior_actions_status IS NOT NULL AND length(trim(prior_actions_status)) > 0
    AND context_changes IS NOT NULL AND length(trim(context_changes)) > 0
    AND performance_review IS NOT NULL AND length(trim(performance_review)) > 0
    AND feedback_interested_parties IS NOT NULL AND length(trim(feedback_interested_parties)) > 0
    AND risk_treatment_status IS NOT NULL AND length(trim(risk_treatment_status)) > 0
    AND improvement_opportunities IS NOT NULL AND length(trim(improvement_opportunities)) > 0`).get(wsId).c > 0;
  const mandRecordsAllFound = mandatoryChecks.every(c => c.found);
  const ismsPolicyDoc = docApproved(['%information security policy%']);
  const policyApprovedRecent = (() => {
    const d = db.prepare(`SELECT MAX(v.created_at) AS approved_at FROM doc_versions v
      INNER JOIN generated_docs g ON g.id=v.document_id
      WHERE g.workspace_id=? AND lower(g.name) LIKE '%information security policy%' AND v.status='approved'`).get(wsId);
    if (!d || !d.approved_at) return false;
    return (Date.now() - new Date(d.approved_at).getTime()) <= 365 * 86400000;
  })();
  const risksCount = db.prepare(`SELECT COUNT(*) c FROM risks WHERE workspace_id=?`).get(wsId).c;
  const rtpPresent = docApproved(['%risk treatment plan%']) || db.prepare(`SELECT COUNT(*) c FROM risk_treatment_actions WHERE workspace_id=?`).get(wsId).c > 0;

  // ----- Layer 1: Stage 1 hard gate (17 items, rubric §2.2) -----
  const s1 = (key, clause, name, pass, detail, action, href) => ({ key, clause, name, pass, detail, action, href });
  const stage1Gate = [
    s1('context', '4.1', 'Context analysis documented',
      itemHasSubstance('clause-4.1'),
      itemHasSubstance('clause-4.1') ? 'Context issues recorded against clause 4.1' : 'No documented internal/external context analysis',
      'Document internal + external issues (clause 4.1)', '/workspaces/' + wsId + '/controls/assess/clause-4.1'),
    s1('interested_parties', '4.2', 'Interested parties + requirements documented',
      interestedPartiesCount >= 3 || itemHasSubstance('clause-4.2'),
      (interestedPartiesCount >= 3 ? interestedPartiesCount + ' interested parties in the register' : 'Interested-parties register thin or empty'),
      'Build the interested-parties register incl. 2022 sub-point (c)', '/workspaces/' + wsId + '/intake'),
    s1('scope', '4.3', 'ISMS scope documented + approved',
      !!(ws.scope && ws.scope.length > 10 && ws.scope_confirmed_at),
      ws.scope_confirmed_at ? ('Scope confirmed ' + String(ws.scope_confirmed_at).slice(0,10)) : (ws.scope && ws.scope.length > 10 ? 'Scope drafted, not confirmed' : 'No scope defined'),
      'Define scope + confirm boundaries', '/workspaces/' + wsId + '/intake'),
    s1('policy', '5.2', 'Information security policy approved (≤12 mo)',
      ismsPolicyDoc && policyApprovedRecent,
      ismsPolicyDoc ? (policyApprovedRecent ? 'Approved policy within 12 months' : 'Policy approved but older than 12 months') : 'No approved information security policy',
      'Adopt + approve the ISMS policy', '/workspaces/' + wsId + '/templates'),
    s1('roles', '5.3', 'Roles, responsibilities + authorities documented',
      itemHasSubstance('clause-5.3') || docApproved(['%roles%','%responsibilit%']),
      (itemHasSubstance('clause-5.3') || docApproved(['%roles%','%responsibilit%'])) ? 'Roles documented' : 'No documented ISMS roles + responsibilities',
      'Document ISMS roles + responsibilities (clause 5.3)', '/workspaces/' + wsId + '/controls/assess/clause-5.3'),
    s1('risk_method', '6.1.2', 'Risk assessment process documented',
      docApproved(['%risk%methodology%','%risk%procedure%','%risk management%']),
      docApproved(['%risk%methodology%','%risk%procedure%','%risk management%']) ? 'Approved risk methodology found' : 'No approved risk methodology',
      'Adopt the Risk Management Methodology template', '/workspaces/' + wsId + '/templates'),
    s1('risk_assessment', '8.2', 'Risk assessment completed; results retained',
      risksCount >= 10,
      risksCount + ' risks in the register',
      'Complete the first risk assessment (10+ risks)', '/workspaces/' + wsId + '/risks'),
    s1('rtp', '6.1.3 e) / 8.3', 'Risk treatment plan; owners + deadlines',
      rtpPresent,
      rtpPresent ? 'RTP present' : 'No risk treatment plan',
      'Adopt the Risk Treatment Plan + assign owners/deadlines', '/workspaces/' + wsId + '/templates'),
    s1('soa', '6.1.3 d)', 'SoA: all 93 controls + justifications',
      annexADecided >= 93 && soaJustGaps === 0,
      annexADecided >= 93 ? (soaJustGaps === 0 ? 'All 93 decided + justified' : annexADecided + '/93 decided but ' + soaJustGaps + ' missing justification') : annexADecided + '/93 controls decided',
      'Complete + justify every Annex A control', '/workspaces/' + wsId + '/soa'),
    s1('objectives', '6.2', 'Measurable security objectives + evaluation',
      objectivesOk,
      objectivesOk ? '3+ measurable objectives with owners' : 'Fewer than 3 objectives with target + owner',
      'Add 3+ measurable objectives with owners', '/workspaces/' + wsId + '/objectives'),
    s1('planning_changes', '6.3', 'Planning of ISMS changes (method documented)',
      itemHasSubstance('clause-6.3') || docApproved(['%change management%','%management of change%']),
      (itemHasSubstance('clause-6.3') || docApproved(['%change management%','%management of change%'])) ? 'ISMS-change method documented' : 'No documented method for ISMS-level changes',
      'Document an ISMS-change method (clause 6.3, distinct from A.8.32)', '/workspaces/' + wsId + '/controls/assess/clause-6.3'),
    s1('awareness', '7.3', 'Awareness programme documented',
      trainingComplete > 0 || docApproved(['%awareness%']),
      (trainingComplete > 0 || docApproved(['%awareness%'])) ? 'Awareness programme / records present' : 'No awareness programme or completed records',
      'Document the awareness programme + record completion', '/workspaces/' + wsId + '/training'),
    s1('communication', '7.4', 'Communication plan (matrix, internal + external)',
      commPlanCount >= 2,
      commPlanCount >= 2 ? commPlanCount + ' communication-plan entries' : 'No communication matrix',
      'Build the communication matrix (what/when/whom/how)', '/workspaces/' + wsId + '/communication-plan'),
    s1('doc_control', '7.5', 'Documented information control in place',
      docRegisterCount >= 3,
      docRegisterCount >= 3 ? docRegisterCount + ' version-controlled approved documents' : 'Document register thin (version control unproven)',
      'Adopt + version-control the mandatory documents', '/workspaces/' + wsId + '/documents'),
    s1('internal_audit', '9.2', 'Internal audit completed (full ISMS scope)',
      internalAuditClosed,
      internalAuditClosed ? 'At least one internal audit closed' : 'No completed internal audit',
      'Run + close one internal audit covering clauses 4-10', '/workspaces/' + wsId + '/audits'),
    s1('mgmt_review', '9.3', 'Management review (all 9.3.2 inputs + outputs)',
      mrmFull,
      mrmFull ? 'MRM closed with all six 9.3.2 inputs' : 'No MRM closed with all required inputs',
      'Hold one MRM with all 9.3.2 inputs documented', '/workspaces/' + wsId + '/mrms'),
    s1('mandatory_docs', '4–10', 'All mandatory documented information present',
      mandRecordsAllFound,
      mandRecordsAllFound ? 'All mandatory clause 4-10 records detected' : (mandTotal - mandFound) + ' of ' + mandTotal + ' mandatory records missing',
      'Produce the remaining mandatory clause 4-10 records', '/workspaces/' + wsId + '/readiness')
  ];

  // ----- Layer 2: maturity % across applicable Annex A controls -----
  const maturityRows = db.prepare(`SELECT cs.maturity FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'`).all(wsId);
  const applicableControls = maturityRows.length;
  const maturitySum = maturityRows.reduce((s, r) => s + (r.maturity || 0), 0);
  const maturityPct = applicableControls > 0 ? Math.round((maturitySum / (applicableControls * 5)) * 100) : 0;
  const controlsAtZeroOrOne = maturityRows.filter(r => (r.maturity || 0) <= 1).length;

  // ----- Stage 1 verdict -----
  const stage1GatePassed = stage1Gate.filter(g => g.pass).length;
  const stage1GateTotal = stage1Gate.length;
  const stage1GateClear = stage1GatePassed === stage1GateTotal;
  const stage1MaturityOk = maturityPct >= 60;
  const stage1Ready = stage1GateClear && stage1MaturityOk;
  const stage1 = maturityPct;
  const stage1Blocked = !stage1Ready;

  // ----- Layer 1: Stage 2 hard gate (9 items, rubric §3.2) -----
  const controlsWithOwnerAndEvidence = db.prepare(`SELECT COUNT(*) c FROM ${T.cs} cs
    INNER JOIN iso_items i ON i.id=cs.iso_item_id
    WHERE cs.workspace_id=? AND i.type='control' AND cs.applicability='included'
      AND cs.owner_id IS NOT NULL
      AND (SELECT COUNT(*) FROM evidence e WHERE e.workspace_id=cs.workspace_id AND e.iso_item_id=cs.iso_item_id) >= 2`).get(wsId).c;
  const oldestEvRow = db.prepare(`SELECT MIN(uploaded_at) AS d FROM evidence WHERE workspace_id=?`).get(wsId);
  const evidenceAgeDays = oldestEvRow && oldestEvRow.d ? Math.floor((Date.now() - new Date(oldestEvRow.d).getTime()) / 86400000) : 0;
  const auditFindingsTracked = db.prepare(`SELECT COUNT(*) c FROM audit_findings f
    INNER JOIN audits a ON a.id=f.audit_id
    WHERE a.workspace_id=? AND f.status NOT IN ('closed') AND f.finding_type IN ('major_nc','minor_nc')`).get(wsId).c === 0;
  const mrmRecent = db.prepare(`SELECT COUNT(*) c FROM mrms WHERE workspace_id=? AND status IN ('complete','closed')
    AND meeting_date >= ?`).get(wsId, oneYearAgo).c > 0;
  const ncRcaOk = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?
    AND status NOT IN ('closed','verified')
    AND (root_cause IS NULL OR length(trim(root_cause)) < 10)`).get(wsId).c === 0;
  const overdueNCs2 = db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=?
    AND status NOT IN ('closed','verified') AND due_date IS NOT NULL AND due_date < ?`).get(wsId, today).c;
  const legalRegisterOk = itemHasSubstance('annex-a.5.31') || docApproved(['%legal%','%regulatory%','%compliance register%']);
  const bcpTestOk = itemHasSubstance('annex-a.5.30') || !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id IN ('annex-a.5.30','annex-a.5.29') LIMIT 1`).get(wsId);
  const irExerciseOk = itemHasSubstance('annex-a.5.24') || db.prepare(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=?`).get(wsId).c > 0;
  const monitoringOk = itemHasSubstance('clause-9.1') || !!db.prepare(`SELECT 1 FROM evidence WHERE workspace_id=? AND iso_item_id='clause-9.1' LIMIT 1`).get(wsId);

  const s2 = (key, clause, name, pass, detail, href) => ({ key, clause, name, pass, detail, href });
  const stage2Gate = [
    s2('operating', 'IAF MD 5', 'ISMS operating with normal-cycle records',
      evidenceAgeDays >= 90,
      oldestEvRow && oldestEvRow.d ? ('Oldest evidence ' + evidenceAgeDays + ' days old') : 'No evidence files',
      '/workspaces/' + wsId + '/evidence'),
    s2('control_evidence', 'SoA', 'Every applicable control: owner + ≥2 evidence samples',
      applicableControls > 0 && controlsWithOwnerAndEvidence >= applicableControls,
      controlsWithOwnerAndEvidence + ' of ' + applicableControls + ' applicable controls have owner + 2 evidence samples',
      '/workspaces/' + wsId + '/evidence-coverage'),
    s2('monitoring', '9.1', 'Monitoring / measurement outputs exist',
      monitoringOk,
      monitoringOk ? 'Monitoring outputs recorded' : 'No monitoring/measurement outputs',
      '/workspaces/' + wsId + '/metrics/adopted'),
    s2('audit_closed', '9.2', 'Internal-audit cycle complete; findings closed/tracked',
      internalAuditClosed && auditFindingsTracked,
      (internalAuditClosed ? (auditFindingsTracked ? 'Audit closed; NC findings closed' : 'Audit closed but NC findings still open') : 'No closed internal audit'),
      '/workspaces/' + wsId + '/audits'),
    s2('mrm_recent', '9.3', 'Management review within last 12 months',
      mrmRecent,
      mrmRecent ? 'MRM held in last 12 months' : 'No MRM in last 12 months',
      '/workspaces/' + wsId + '/mrms'),
    s2('nc_rca', '10.2', 'Corrective actions: root cause + effectiveness',
      ncRcaOk,
      ncRcaOk ? 'Open NCs carry root-cause analysis' : 'Open NCs missing root-cause analysis',
      '/workspaces/' + wsId + '/nonconformities'),
    s2('stage1_closed', '17021-1', 'Stage 1 findings / overdue NCs closed',
      overdueNCs2 === 0,
      overdueNCs2 === 0 ? 'No overdue nonconformities' : overdueNCs2 + ' overdue NCs',
      '/workspaces/' + wsId + '/nonconformities'),
    s2('legal_register', 'A.5.31', 'Legal / regulatory / contractual register current',
      legalRegisterOk,
      legalRegisterOk ? 'Legal register present' : 'No legal/regulatory register',
      '/workspaces/' + wsId + '/controls/assess/annex-a.5.31'),
    s2('tests', 'A.5.30 / A.5.24', 'BCP test + incident-response exercise performed',
      bcpTestOk && irExerciseOk,
      (bcpTestOk && irExerciseOk) ? 'BCP + IR tests recorded' : ((bcpTestOk ? '' : 'BCP test missing. ') + (irExerciseOk ? '' : 'IR exercise missing.')),
      '/workspaces/' + wsId + '/controls/assess/annex-a.5.30')
  ];

  const stage2GatePassed = stage2Gate.filter(g => g.pass).length;
  const stage2GateTotal = stage2Gate.length;
  const stage2GateClear = stage2GatePassed === stage2GateTotal;
  const stage2MaturityOk = maturityPct >= 75 && controlsAtZeroOrOne === 0;
  const stage2Ready = stage1Ready && stage2GateClear && stage2MaturityOk;
  const stage2 = maturityPct;
  const stage2Blocked = !stage2Ready;

  // Per-section breakdown so the readiness Stage panels can render the
  // same gap-assessment / implementation summary the workspace overview
  // shows. Requirements = clauses 4-10; org/people/physical/tech = the
  // four Annex A themes.
  const themeStateRows = db.prepare(`SELECT i.id, i.type, i.category, COALESCE(cs.status,'Not Assessed') AS status
                                     FROM iso_items i
                                     LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?`).all(ws.id);
  const themes = {
    requirements: { label: 'Requirements', total: 0, assessed: 0, implemented: 0 },
    org:          { label: 'A.5 Org',      total: 0, assessed: 0, implemented: 0 },
    people:       { label: 'A.6 People',   total: 0, assessed: 0, implemented: 0 },
    physical:     { label: 'A.7 Physical', total: 0, assessed: 0, implemented: 0 },
    tech:         { label: 'A.8 Tech',     total: 0, assessed: 0, implemented: 0 }
  };
  const statusCounts = { impl: 0, partial: 0, wip: 0, notImpl: 0, na: 0, notAss: 0 };
  themeStateRows.forEach(row => {
    let key = null;
    if (row.type === 'clause') key = 'requirements';
    else if (themes[row.category]) key = row.category;
    if (!key) return;
    themes[key].total++;
    if (row.status !== 'Not Assessed') themes[key].assessed++;
    if (row.status === 'Implemented') themes[key].implemented++;
    if (row.status === 'Implemented') statusCounts.impl++;
    else if (row.status === 'Partially Implemented') statusCounts.partial++;
    else if (row.status === 'Work In Progress') statusCounts.wip++;
    else if (row.status === 'Not Implemented') statusCounts.notImpl++;
    else if (row.status === 'Not Applicable') statusCounts.na++;
    else if (row.status === 'Not Assessed') statusCounts.notAss++;
  });
  const totalSoaItems = themeStateRows.length;
  const totalAssessed = totalSoaItems - statusCounts.notAss;

  // Days remaining to the workspace's target cert date (null if unset).
  let daysToTarget = null;
  if (ws.target_cert_date) {
    daysToTarget = Math.ceil((new Date(ws.target_cert_date) - new Date()) / 86400000);
  }

  return {
    stage1, stage2,
    daysToTarget,
    records: { found: recordsFound, total: recordsTotal, checks,
               mandatory: { found: mandFound, total: mandTotal, checks: mandatoryChecks },
               expected:  { found: expFound,  total: expTotal,  checks: expectedChecks } },
    flags,
    stage1Gate, stage1GatePassed, stage1GateTotal, stage1GateClear,
    stage1MaturityOk, stage1Ready, stage1Blocked,
    stage2Gate, stage2GatePassed, stage2GateTotal, stage2GateClear,
    stage2MaturityOk, stage2Ready, stage2Blocked,
    maturityPct, applicableControls, controlsAtZeroOrOne,
    themes,
    statusCounts,
    totalSoaItems,
    totalAssessed,
    metrics: {
      assessed, totalItems,
      implemented: totals.implemented || 0,
      partial: totals.partial || 0,
      wip: totals.wip || 0,
      notImpl: totals.not_impl || 0,
      na: totals.na || 0,
      avgMaturity: totals.avg_maturity ? Number(totals.avg_maturity).toFixed(1) : '-',
      evidenceCount
    }
  };
}


module.exports = { computeReadiness, computeRoadmap, MANDATORY_RECORDS };
