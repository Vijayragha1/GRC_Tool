'use strict';

// Evidence-to-outcome projection for the standalone TPRM module. These are
// direct capability mappings, not a claim of certification or conformity.
// Every status is calculated from traceable Nimbus records and can be drilled
// back to the exact tenant-scoped source row.

const CAPABILITIES = Object.freeze([
  {
    key: 'programme_governance',
    label: 'Programme governance and agreed process',
    iso27001: ['A.5.19'], nistCsf: ['GV.SC-01'],
    requirements: ['moduleActive', 'publishedMethodology'],
  },
  {
    key: 'roles_and_accountability',
    label: 'Client, consultancy and provider accountability',
    iso27001: ['A.5.19', 'A.5.20'], nistCsf: ['GV.SC-02'],
    requirements: ['clientBusinessOwner', 'consultancyOwner', 'clientDecisionAuthority'],
  },
  {
    key: 'risk_integration',
    label: 'Third-party risk integrated into decision and remediation',
    iso27001: ['A.5.19'], nistCsf: ['GV.SC-03'],
    requirements: ['governedCycle', 'consultancyRecommendation', 'findingsGoverned'],
  },
  {
    key: 'inventory_and_criticality',
    label: 'Known inventory and risk-based criticality',
    iso27001: ['A.5.19'], nistCsf: ['GV.SC-04'],
    requirements: ['inventoryRecord', 'approvedInherentRisk'],
  },
  {
    key: 'contractual_security',
    label: 'Security requirements in third-party agreements',
    iso27001: ['A.5.20'], nistCsf: ['GV.SC-05'],
    requirements: ['completedContractAssurance'],
  },
  {
    key: 'pre_contract_due_diligence',
    label: 'Risk-based due diligence before onboarding',
    iso27001: ['A.5.19', 'A.5.20'], nistCsf: ['GV.SC-06'],
    requirements: ['approvedInherentRisk', 'completedDueDiligence', 'completedContractAssurance'],
  },
  {
    key: 'lifecycle_monitoring',
    label: 'Ongoing risk monitoring, review and response',
    iso27001: ['A.5.22'], nistCsf: ['GV.SC-07'],
    requirements: ['clientDecision', 'reviewSchedule', 'monitoringEvidence'],
  },
  {
    key: 'incident_coordination',
    label: 'Third parties included in incident coordination',
    iso27001: ['A.5.20', 'A.5.22', 'A.5.24', 'A.5.26'], nistCsf: ['GV.SC-08'],
    requirements: ['incidentTermsReviewed', 'incidentTermsEffective'],
  },
  {
    key: 'supply_chain_dependencies',
    label: 'Fourth-party and technology supply-chain visibility',
    iso27001: ['A.5.21'], nistCsf: ['GV.SC-09'],
    requirements: ['dependencyInventory', 'dependencyRiskReviewed'],
  },
  {
    key: 'exit_and_transition',
    label: 'Controlled termination and transition planning',
    iso27001: ['A.5.20', 'A.5.22', 'A.5.23'], nistCsf: ['GV.SC-10'],
    requirements: ['exitStrategy', 'exitReadiness'],
  },
]);

const FRAMEWORK_OUTCOMES = Object.freeze({
  iso27001: Object.freeze({
    'A.5.19': 'Information security in supplier relationships',
    'A.5.20': 'Addressing information security within supplier agreements',
    'A.5.21': 'Managing information security in the ICT supply chain',
    'A.5.22': 'Monitoring, review and change management of supplier services',
    'A.5.23': 'Information security for use of cloud services',
    'A.5.24': 'Information security incident management planning and preparation',
    'A.5.26': 'Response to information security incidents',
  }),
  nistCsf: Object.freeze({
    'GV.SC-01': 'A cybersecurity supply-chain risk programme and process are established',
    'GV.SC-02': 'Roles and responsibilities are established and coordinated',
    'GV.SC-03': 'Supply-chain risk is integrated into enterprise risk management',
    'GV.SC-04': 'Suppliers are known and prioritised by criticality',
    'GV.SC-05': 'Cybersecurity requirements are integrated into agreements',
    'GV.SC-06': 'Planning and due diligence occur before formal relationships',
    'GV.SC-07': 'Third-party risk is assessed, responded to and monitored through the relationship',
    'GV.SC-08': 'Relevant third parties are included in incident response and recovery',
    'GV.SC-09': 'Supply-chain practices are monitored through the technology lifecycle',
    'GV.SC-10': 'Plans address activities after a relationship concludes',
  }),
});

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function source(type, row, label, dateKey = 'updated_at') {
  if (!row) return null;
  return {
    sourceType: type,
    sourceId: String(row.id),
    label,
    recordedAt: row[dateKey] || row.created_at || null,
  };
}

function fact(value, sources = [], note = null) {
  return { value: Boolean(value), sources: sources.filter(Boolean), note };
}

function evaluateCapabilities(facts, definitions = CAPABILITIES) {
  return definitions.map(definition => {
    const checks = definition.requirements.map(key => ({ key, ...(facts[key] || fact(false)) }));
    const satisfied = checks.filter(item => item.value).length;
    const percentage = checks.length ? Math.round((satisfied / checks.length) * 100) : 0;
    const status = satisfied === checks.length ? 'evidenced' : satisfied ? 'partial' : 'not_evidenced';
    return {
      key: definition.key,
      label: definition.label,
      status,
      percentage,
      frameworkRefs: {
        iso27001: [...definition.iso27001],
        nistCsf: [...definition.nistCsf],
      },
      checks,
      evidence: checks.flatMap(item => item.sources || []),
      gaps: checks.filter(item => !item.value).map(item => ({ key: item.key, note: item.note || null })),
    };
  });
}

function thirdPartyFacts(db, workspaceIdInput, supplierIdInput) {
  const workspaceId = Number(workspaceIdInput);
  const supplierId = Number(supplierIdInput);
  if (!Number.isInteger(workspaceId) || workspaceId < 1 || !Number.isInteger(supplierId) || supplierId < 1) {
    throw new Error('valid_workspace_and_third_party_required');
  }
  const supplier = db.prepare(`SELECT * FROM suppliers
    WHERE id=? AND workspace_id=? AND archived_at IS NULL`).get(supplierId, workspaceId);
  if (!supplier) throw new Error('third_party_not_found');
  const module = tableExists(db, 'tprm_modules')
    ? db.prepare('SELECT * FROM tprm_modules WHERE workspace_id=? ORDER BY id DESC LIMIT 1').get(workspaceId)
    : null;
  const methodology = db.prepare(`SELECT * FROM supplier_risk_methodologies
    WHERE workspace_id=? AND is_active=1 AND status='published' ORDER BY version DESC,id DESC LIMIT 1`).get(workspaceId);
  const cycle = tableExists(db, 'tprm_assessment_cycles')
    ? db.prepare(`SELECT * FROM tprm_assessment_cycles WHERE workspace_id=? AND supplier_id=?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,cycle_number DESC,id DESC LIMIT 1`).get(workspaceId, supplierId)
    : null;
  const inherent = db.prepare(`SELECT * FROM supplier_inherent_assessments
    WHERE workspace_id=? AND supplier_id=? AND status='approved' ORDER BY approved_at DESC,id DESC LIMIT 1`).get(workspaceId, supplierId);
  const ddq = db.prepare(`SELECT * FROM supplier_ddq_assessments
    WHERE workspace_id=? AND supplier_id=? AND status='complete' ORDER BY completed_at DESC,id DESC LIMIT 1`).get(workspaceId, supplierId);
  const contract = db.prepare(`SELECT * FROM supplier_contract_reviews
    WHERE workspace_id=? AND supplier_id=? AND status='complete' ORDER BY completed_at DESC,id DESC LIMIT 1`).get(workspaceId, supplierId);
  const recommendation = tableExists(db, 'tprm_recommendations')
    ? db.prepare(`SELECT * FROM tprm_recommendations WHERE workspace_id=? AND supplier_id=?
      ORDER BY version DESC,id DESC LIMIT 1`).get(workspaceId, supplierId)
    : null;
  const decision = tableExists(db, 'tprm_client_decisions')
    ? db.prepare(`SELECT * FROM tprm_client_decisions WHERE workspace_id=? AND supplier_id=?
      ORDER BY version DESC,id DESC LIMIT 1`).get(workspaceId, supplierId)
    : null;
  const schedule = tableExists(db, 'tprm_review_schedules')
    ? db.prepare(`SELECT * FROM tprm_review_schedules WHERE workspace_id=? AND supplier_id=?
      ORDER BY version DESC,id DESC LIMIT 1`).get(workspaceId, supplierId)
    : null;
  const findingCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM supplier_finding_links l
    JOIN findings f ON f.id=l.finding_id AND f.workspace_id=? WHERE l.supplier_id=?`).get(workspaceId, supplierId).count || 0);
  const signal = tableExists(db, 'tprm_monitoring_signals')
    ? db.prepare(`SELECT * FROM tprm_monitoring_signals WHERE workspace_id=? AND supplier_id=?
      ORDER BY observed_at DESC,id DESC LIMIT 1`).get(workspaceId, supplierId)
    : null;
  const review = db.prepare(`SELECT * FROM supplier_reviews WHERE workspace_id=? AND supplier_id=?
    ORDER BY review_date DESC,id DESC LIMIT 1`).get(workspaceId, supplierId);
  const relationship = tableExists(db, 'tprm_service_relationships')
    ? db.prepare(`SELECT * FROM tprm_service_relationships WHERE workspace_id=? AND supplier_id=?
      ORDER BY is_primary DESC,id LIMIT 1`).get(workspaceId, supplierId)
    : null;
  const dependency = relationship && tableExists(db, 'tprm_dependency_edges')
    ? db.prepare(`SELECT * FROM tprm_dependency_edges WHERE workspace_id=? AND source_relationship_id=?
      AND status!='ended' ORDER BY criticality DESC,id LIMIT 1`).get(workspaceId, relationship.id)
    : null;
  const approvedDependency = relationship && tableExists(db, 'tprm_dependency_edges')
    ? db.prepare(`SELECT * FROM tprm_dependency_edges WHERE workspace_id=? AND source_relationship_id=?
      AND status='approved' ORDER BY criticality DESC,id LIMIT 1`).get(workspaceId, relationship.id)
    : null;
  const legacySubprocessor = db.prepare(`SELECT * FROM supplier_subprocessors
    WHERE workspace_id=? AND supplier_id=? ORDER BY id LIMIT 1`).get(workspaceId, supplierId);
  const termination = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN done=1 THEN 1 ELSE 0 END) AS complete
    FROM supplier_termination_items WHERE workspace_id=? AND supplier_id=?`).get(workspaceId, supplierId);

  let incidentReviewed = null;
  let incidentEffective = null;
  if (contract) {
    incidentReviewed = db.prepare(`SELECT i.* FROM supplier_contract_review_items i
      WHERE i.review_id=? AND i.clause_id IN ('CT-24','CT-25') AND i.status!='Not Reviewed'
      ORDER BY i.id LIMIT 1`).get(contract.id);
    incidentEffective = db.prepare(`SELECT i.* FROM supplier_contract_review_items i
      WHERE i.review_id=? AND i.clause_id IN ('CT-24','CT-25')
        AND i.status IN ('Present - Satisfactory','Not Applicable')
      ORDER BY i.id LIMIT 1`).get(contract.id);
  }

  const exitPlanned = Boolean((relationship && relationship.exit_strategy) || supplier.exit_strategy);
  const exitReady = Boolean(relationship
    ? ['documented', 'tested', 'not_applicable'].includes(relationship.exit_plan_status)
    : termination.total > 0 && Number(termination.complete) === Number(termination.total));
  const monitoringSources = [source('tprm_monitoring_signal', signal, signal && signal.title, 'observed_at'),
    source('supplier_review', review, review && `Review ${review.review_date}`, 'review_date')].filter(Boolean);

  return {
    supplier,
    facts: {
      moduleActive: fact(module && module.status === 'active', [source('tprm_module', module, 'Active TPRM module', 'activated_at')], 'Enable and classify the Third-party risk module.'),
      publishedMethodology: fact(methodology, [source('supplier_risk_methodology', methodology, methodology && `${methodology.name} v${methodology.version}`, 'published_at')], 'Publish an active governed assessment methodology.'),
      clientBusinessOwner: fact(supplier.business_owner || relationship && relationship.business_owner, [source('third_party', supplier, 'Client business owner')], 'Assign an accountable client business owner.'),
      consultancyOwner: fact(supplier.relationship_owner || supplier.security_reviewer || relationship && relationship.relationship_owner, [source('third_party', supplier, 'Consultancy owner')], 'Assign a consultancy relationship or security owner.'),
      clientDecisionAuthority: fact(cycle && cycle.client_decision_authority_id, [source('tprm_assessment_cycle', cycle, 'Named client decision authority', 'started_at')], 'Assign the authorised client decision-maker for the assessment cycle.'),
      governedCycle: fact(cycle, [source('tprm_assessment_cycle', cycle, cycle && `Cycle ${cycle.cycle_number}`, 'started_at')], 'Start a governed assessment cycle.'),
      consultancyRecommendation: fact(recommendation, [source('tprm_recommendation', recommendation, recommendation && `Recommendation v${recommendation.version}`, 'issued_at')], 'Issue an independently reviewed consultancy recommendation.'),
      findingsGoverned: fact(cycle && recommendation && Number.isInteger(findingCount), [source('tprm_assessment_cycle', cycle, 'Assessment and remediation scope', 'started_at')], 'Link findings and recommendation conditions to the governed assessment scope.'),
      inventoryRecord: fact(supplier, [source('third_party', supplier, supplier.name, 'created_at')]),
      approvedInherentRisk: fact(inherent, [source('supplier_inherent_assessment', inherent, inherent && `Approved tier ${inherent.assigned_tier}`, 'approved_at')], 'Complete and independently approve inherent-risk tiering.'),
      completedDueDiligence: fact(ddq, [source('supplier_ddq_assessment', ddq, 'Completed provider due diligence', 'completed_at')], 'Complete consultancy review of provider responses and evidence.'),
      completedContractAssurance: fact(contract, [source('supplier_contract_review', contract, contract && contract.agreement_reference, 'completed_at')], 'Complete contract assurance against the executed agreement.'),
      clientDecision: fact(decision, [source('tprm_client_decision', decision, decision && `Client decision v${decision.version}`, 'decided_at')], 'Record the authorised client onboarding decision.'),
      reviewSchedule: fact(schedule, [source('tprm_review_schedule', schedule, schedule && `Next review ${schedule.next_review_date}`, 'created_at')], 'Create a risk-based reassessment schedule.'),
      monitoringEvidence: fact(signal || review, monitoringSources, 'Record and triage monitoring evidence or a periodic review.'),
      incidentTermsReviewed: fact(incidentReviewed, [source('supplier_contract_review_item', incidentReviewed, incidentReviewed && incidentReviewed.clause_id, 'reviewed_at')], 'Review incident-notification and coordination terms.'),
      incidentTermsEffective: fact(incidentEffective, [source('supplier_contract_review_item', incidentEffective, incidentEffective && incidentEffective.clause_id, 'reviewed_at')], 'Resolve gaps in incident-notification and coordination terms.'),
      dependencyInventory: fact(dependency || legacySubprocessor, [source('tprm_dependency_edge', dependency, dependency && dependency.service_description, 'effective_from'), source('supplier_subprocessor', legacySubprocessor, legacySubprocessor && legacySubprocessor.name, 'created_at')], 'Record material fourth parties, subprocessors and infrastructure dependencies.'),
      dependencyRiskReviewed: fact(approvedDependency || legacySubprocessor && legacySubprocessor.approved, [source('tprm_dependency_edge', approvedDependency, approvedDependency && approvedDependency.service_description, 'updated_at'), source('supplier_subprocessor', legacySubprocessor && legacySubprocessor.approved ? legacySubprocessor : null, legacySubprocessor && legacySubprocessor.name, 'approved_at')], 'Review and approve material dependencies, including concentration and substitutability.'),
      exitStrategy: fact(exitPlanned, [source('tprm_service_relationship', relationship, 'Service exit strategy'), source('third_party', supplier, 'Legacy exit strategy')], 'Document transition, access revocation, data return/deletion and continuity.'),
      exitReadiness: fact(exitReady, [source('tprm_service_relationship', relationship, relationship && `Exit plan ${relationship.exit_plan_status}`, 'last_exit_tested_at')], 'Document and test the exit plan, or complete the governed termination checklist.'),
    },
  };
}

function frameworkRollup(capabilities) {
  const build = framework => Object.entries(FRAMEWORK_OUTCOMES[framework]).map(([ref, title]) => {
    const supporting = capabilities.filter(item => item.frameworkRefs[framework].includes(ref));
    const percentage = supporting.length
      ? Math.round(supporting.reduce((sum, item) => sum + item.percentage, 0) / supporting.length)
      : 0;
    return {
      ref,
      title,
      status: percentage === 100 ? 'evidenced' : percentage > 0 ? 'partial' : 'not_evidenced',
      percentage,
      capabilityKeys: supporting.map(item => item.key),
      evidence: supporting.flatMap(item => item.evidence),
      disclaimer: 'Supporting operational evidence only; this is not a conformity or certification conclusion.',
    };
  });
  return { iso27001: build('iso27001'), nistCsf: build('nistCsf') };
}

function thirdPartyCoverage(db, workspaceId, supplierId) {
  const built = thirdPartyFacts(db, workspaceId, supplierId);
  const capabilities = evaluateCapabilities(built.facts);
  return {
    thirdParty: built.supplier,
    capabilities,
    frameworks: frameworkRollup(capabilities),
    summary: {
      evidenced: capabilities.filter(item => item.status === 'evidenced').length,
      partial: capabilities.filter(item => item.status === 'partial').length,
      notEvidenced: capabilities.filter(item => item.status === 'not_evidenced').length,
      percentage: Math.round(capabilities.reduce((sum, item) => sum + item.percentage, 0) / capabilities.length),
    },
    generatedAt: new Date().toISOString(),
    disclaimer: 'Evidence coverage is a traceability aid, not a certification or compliance opinion.',
  };
}

function workspaceCoverage(db, workspaceIdInput) {
  const workspaceId = Number(workspaceIdInput);
  const suppliers = db.prepare(`SELECT id FROM suppliers WHERE workspace_id=? AND archived_at IS NULL ORDER BY name,id`).all(workspaceId);
  const records = suppliers.map(row => thirdPartyCoverage(db, workspaceId, row.id));
  const aggregateFramework = framework => Object.entries(FRAMEWORK_OUTCOMES[framework]).map(([ref, title]) => {
    const items = records.map(record => record.frameworks[framework].find(item => item.ref === ref)).filter(Boolean);
    const percentage = items.length ? Math.round(items.reduce((sum, item) => sum + item.percentage, 0) / items.length) : 0;
    return {
      ref,
      title,
      status: percentage === 100 ? 'evidenced' : percentage > 0 ? 'partial' : 'not_evidenced',
      percentage,
      thirdPartyCount: items.length,
      evidenceCount: items.reduce((sum, item) => sum + item.evidence.length, 0),
      disclaimer: 'Supporting operational evidence only; this is not a conformity or certification conclusion.',
    };
  });
  return {
    records,
    frameworks: {
      iso27001: aggregateFramework('iso27001'),
      nistCsf: aggregateFramework('nistCsf'),
    },
    totals: {
      thirdParties: records.length,
      averageCoverage: records.length
        ? Math.round(records.reduce((sum, item) => sum + item.summary.percentage, 0) / records.length)
        : 0,
      fullyEvidenced: records.filter(item => item.summary.evidenced === CAPABILITIES.length).length,
    },
    generatedAt: new Date().toISOString(),
    disclaimer: 'Evidence coverage is a traceability aid, not a certification or compliance opinion.',
  };
}

module.exports = {
  CAPABILITIES,
  FRAMEWORK_OUTCOMES,
  evaluateCapabilities,
  frameworkRollup,
  thirdPartyFacts,
  thirdPartyCoverage,
  workspaceCoverage,
};
