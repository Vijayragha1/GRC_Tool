'use strict';

const crypto = require('crypto');
const methodology = require('../data/nist-csf-policy-practice');

const OUTCOME_STATES = ['Not Started','Fieldwork','Assessor Complete','Reviewed','Client Validated','Approved'];
const ASSURANCE_OUTCOMES = ['not_assessed','effective','partially_effective','ineffective','alternate_control','no_visibility','not_implemented','not_applicable'];
const PRIORITIES = ['critical','high','medium','low'];
const EVIDENCE_QUALITY = ['poor','fair','good','excellent'];
const EVIDENCE_AXES = ['policy','practice','both'];

function isFirmOperator(user) {
  return !!user && (user.user_type === 'firm' || user.role === 'firm_owner');
}

function isManager(user) {
  return isFirmOperator(user) && ['manager','owner','firm_owner'].includes(user.firm_role || user.role);
}

function rolesOnEngagement(db,userId,engagementId) {
  if (!userId || !engagementId) return [];
  return db.prepare(`SELECT role_on_engagement role FROM csf_engagement_assignments WHERE user_id=? AND engagement_id=?`).all(userId,engagementId).map(r=>r.role);
}

function canView(db,user,engagement) {
  if (!user || !engagement) return false;
  if (user.user_type === 'client') return true;
  return isFirmOperator(user) || rolesOnEngagement(db,user.id,engagement.id).length > 0;
}

function canCreate(user,workspace) {
  return !!user && !!workspace && isFirmOperator(user);
}

function canAssess(db,user,engagement) {
  if (!isFirmOperator(user) || !engagement || ['Published','Closed'].includes(engagement.status)) return false;
  const roles = rolesOnEngagement(db,user.id,engagement.id);
  return isManager(user) || roles.some(r=>['ENGAGEMENT_LEAD','CONSULTANT','ANALYST'].includes(r));
}

function canScore(db,user,engagement) {
  if (!isFirmOperator(user) || !engagement || ['Published','Closed'].includes(engagement.status)) return false;
  const roles = rolesOnEngagement(db,user.id,engagement.id);
  return isManager(user) || roles.some(r=>['ENGAGEMENT_LEAD','CONSULTANT'].includes(r));
}

function canReview(db,user,engagement) {
  if (!isFirmOperator(user) || !engagement) return false;
  const roles = rolesOnEngagement(db,user.id,engagement.id);
  return isManager(user) || roles.some(r=>['ENGAGEMENT_LEAD','REVIEWER'].includes(r));
}

function canApprove(db,user,engagement) {
  if (!isFirmOperator(user) || !engagement) return false;
  return isManager(user) || rolesOnEngagement(db,user.id,engagement.id).includes('ENGAGEMENT_LEAD');
}

function ensureAssessmentRows(db,engagement) {
  const subIds = db.prepare(`SELECT id FROM csf_subcategories WHERE catalog_version=? ORDER BY id`).all(engagement.catalog_version);
  const ins = db.prepare(`INSERT OR IGNORE INTO csf_subcategory_assessments
    (engagement_id,subcategory_id,status,methodology_version) VALUES (?,?,'Not Started',?)`);
  db.transaction(()=>subIds.forEach(s=>ins.run(engagement.id,s.id,methodology.METHODOLOGY_VERSION)))();
  return subIds.length;
}

function parseJson(value,fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function methodologyRow(db,subcategoryId) {
  const row = db.prepare(`SELECT * FROM csf_methodology_outcomes WHERE subcategory_id=? AND methodology_version=?`).get(subcategoryId,methodology.METHODOLOGY_VERSION);
  if (!row) return null;
  return {
    ...row,
    policy_anchors: parseJson(row.policy_anchors_json,{}),
    practice_anchors: parseJson(row.practice_anchors_json,{}),
    policy_evidence: parseJson(row.policy_evidence_json,[]),
    practice_evidence: parseJson(row.practice_evidence_json,[]),
    interview_roles: parseJson(row.interview_roles_json,[]),
    test_procedures: parseJson(row.test_procedures_json,[]),
    measures: parseJson(row.measures_json,[]),
    failure_indicators: parseJson(row.failure_indicators_json,[]),
    evidence_gates: parseJson(row.evidence_gates_json,{}),
  };
}

function evidenceFor(db,assessmentId) {
  return db.prepare(`SELECT * FROM csf_evidence_items WHERE assessment_id=? AND deleted_at IS NULL ORDER BY uploaded_at DESC,id DESC`).all(assessmentId);
}

function testsFor(db,assessmentId) {
  return db.prepare(`SELECT * FROM csf_assessment_tests WHERE assessment_id=? ORDER BY test_code`).all(assessmentId);
}

function scoreGateDefects(db,assessment,axis,score) {
  const defects = [];
  const numeric = Number(score);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 5) return [`${axis} score must be between 0 and 5.`];
  const rationale = String(assessment[`${axis}_rationale`] || '').trim();
  const owner = String(assessment[`${axis}_owner`] || '').trim();
  const minimum = [60,80,120,140,160,180][numeric];
  if (rationale.length < minimum) defects.push(`${axis} rationale requires at least ${minimum} characters for level ${numeric}.`);
  if (numeric >= 2 && !owner) defects.push(`${axis} ownership must be recorded for level ${numeric}.`);

  const evidence = evidenceFor(db,assessment.id).filter(e=>e.evidence_axis === axis || e.evidence_axis === 'both');
  const good = evidence.filter(e=>['good','excellent'].includes(e.evidence_quality));
  const excellent = evidence.filter(e=>e.evidence_quality === 'excellent');
  if (numeric >= 2 && evidence.length < 1) defects.push(`${axis} level ${numeric} requires retained evidence; interviews alone are insufficient.`);
  if (numeric >= 3 && (evidence.length < 2 || good.length < 1)) defects.push(`${axis} level ${numeric} requires at least two relevant items including Good or Excellent evidence.`);
  if (numeric >= 4 && assessment.evidence_confidence !== 'high') defects.push(`${axis} level ${numeric} requires High evidence confidence.`);
  const tests = testsFor(db,assessment.id).filter(t=>t.axis === axis || t.axis === 'both');
  const passed = tests.filter(t=>t.result === 'pass');
  if (numeric >= 4 && passed.length < 1) defects.push(`${axis} level ${numeric} requires a passed effectiveness test.`);
  if (numeric >= 5 && (passed.length < 2 || excellent.length < 1)) defects.push(`${axis} level 5 requires at least two passed tests and Excellent direct-testing evidence.`);
  if (axis === 'practice' && numeric >= 3) {
    if (!assessment.assessment_period_start || !assessment.assessment_period_end) defects.push('Practice level 3 or above requires a defined assessment period.');
    if (!assessment.population_description || assessment.population_size == null || assessment.sample_size == null || !assessment.sample_rationale) {
      defects.push('Practice level 3 or above requires population, sample size, and sampling rationale.');
    } else if (Number(assessment.sample_size) > Number(assessment.population_size)) defects.push('Sample size cannot exceed the population size.');
  }
  return defects;
}

function outcomeReadiness(db,assessment) {
  const defects = [];
  if (assessment.applicability_status === 'not_applicable') {
    if (String(assessment.exclusion_rationale || '').trim().length < 80) defects.push('Not applicable requires an evidence-based rationale of at least 80 characters.');
    if (assessment.assurance_outcome !== 'not_applicable') defects.push('Assurance outcome must be Not applicable.');
    return defects;
  }
  if (assessment.assurance_outcome === 'no_visibility') {
    if (assessment.policy_score != null || assessment.practice_score != null) defects.push('No visibility cannot carry maturity scores.');
    if ((String(assessment.policy_rationale||'')+String(assessment.practice_rationale||'')).trim().length < 120) defects.push('No visibility requires a clear limitation and impact rationale.');
    return defects;
  }
  if (assessment.policy_score == null) defects.push('Policy maturity has not been concluded.');
  if (assessment.practice_score == null) defects.push('Practice maturity has not been concluded.');
  if (assessment.target_policy_score == null || assessment.target_practice_score == null) defects.push('Target Policy and Practice levels are required.');
  if (assessment.policy_score != null && assessment.target_policy_score != null && assessment.target_policy_score < assessment.policy_score) defects.push('Target Policy level cannot be below the Current Policy level.');
  if (assessment.practice_score != null && assessment.target_practice_score != null && assessment.target_practice_score < assessment.practice_score) defects.push('Target Practice level cannot be below the Current Practice level.');
  if (assessment.assurance_outcome === 'not_assessed') defects.push('Record an assurance outcome.');
  if (!assessment.evidence_confidence) defects.push('Record evidence confidence.');
  if (assessment.policy_score != null) defects.push(...scoreGateDefects(db,assessment,'policy',assessment.policy_score));
  if (assessment.practice_score != null) defects.push(...scoreGateDefects(db,assessment,'practice',assessment.practice_score));
  return [...new Set(defects)];
}

function median(values) {
  const nums = values.filter(v=>v != null).map(Number).sort((a,b)=>a-b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length/2);
  return nums.length%2 ? nums[mid] : (nums[mid-1]+nums[mid])/2;
}

function distribution(rows,key) {
  const out = [0,0,0,0,0,0];
  rows.forEach(r=>{ if (r[key] != null) out[Number(r[key])]++; });
  return out;
}

function summarize(rows) {
  const inScope = rows.filter(r=>r.applicability_status !== 'not_applicable');
  const assessed = inScope.filter(r=>r.policy_score != null && r.practice_score != null);
  const atTarget = assessed.filter(r=>r.target_policy_score != null && r.target_practice_score != null &&
    r.policy_score >= r.target_policy_score && r.practice_score >= r.target_practice_score);
  const achieved = assessed.map(r=>Math.min(r.policy_score,r.practice_score));
  return {
    total: rows.length,
    inScope: inScope.length,
    excluded: rows.length-inScope.length,
    assessed: assessed.length,
    assessedPct: inScope.length ? Math.round(assessed.length*100/inScope.length) : 0,
    policyMedian: median(assessed.map(r=>r.policy_score)),
    practiceMedian: median(assessed.map(r=>r.practice_score)),
    targetPolicyMedian: median(assessed.map(r=>r.target_policy_score)),
    targetPracticeMedian: median(assessed.map(r=>r.target_practice_score)),
    achievedMedian: median(achieved),
    atTarget: atTarget.length,
    targetPct: assessed.length ? Math.round(atTarget.length*100/assessed.length) : 0,
    lowConfidence: inScope.filter(r=>r.evidence_confidence === 'low').length,
    noVisibility: inScope.filter(r=>r.assurance_outcome === 'no_visibility').length,
    divergence: assessed.filter(r=>Math.abs(r.policy_score-r.practice_score)>=2).length,
    policyDistribution: distribution(assessed,'policy_score'),
    practiceDistribution: distribution(assessed,'practice_score'),
    achievedDistribution: achieved.reduce((a,v)=>(a[v]++,a),[0,0,0,0,0,0]),
  };
}

function computeRollup(db,engagement) {
  ensureAssessmentRows(db,engagement);
  const rows = db.prepare(`SELECT a.*,s.code,s.description,c.id category_id,c.code category_code,c.name category_name,
      f.id function_id,f.code function_code,f.name function_name,
      (SELECT COUNT(*) FROM csf_evidence_items ev WHERE ev.assessment_id=a.id AND ev.deleted_at IS NULL) evidence_count,
      (SELECT COUNT(*) FROM csf_assessment_tests t WHERE t.assessment_id=a.id AND t.result!='not_run') test_count,
      (SELECT COUNT(*) FROM csf_findings fi WHERE fi.assessment_id=a.id AND fi.deleted_at IS NULL) finding_count
    FROM csf_subcategory_assessments a
    JOIN csf_subcategories s ON s.id=a.subcategory_id
    JOIN csf_categories c ON c.id=s.category_id
    JOIN csf_functions f ON f.id=c.function_id
    WHERE a.engagement_id=? ORDER BY f.display_order,c.display_order,s.display_order`).all(engagement.id);
  rows.forEach(r=>{ r.achieved_level = r.policy_score == null || r.practice_score == null ? null : Math.min(r.policy_score,r.practice_score); });
  const fnMap = new Map();
  for (const row of rows) {
    if (!fnMap.has(row.function_code)) fnMap.set(row.function_code,{ code:row.function_code,name:row.function_name,rows:[],categories:new Map() });
    const fn = fnMap.get(row.function_code); fn.rows.push(row);
    if (!fn.categories.has(row.category_code)) fn.categories.set(row.category_code,{code:row.category_code,name:row.category_name,rows:[]});
    fn.categories.get(row.category_code).rows.push(row);
  }
  const functions = [...fnMap.values()].map(fn=>({
    code:fn.code,name:fn.name,summary:summarize(fn.rows),
    categories:[...fn.categories.values()].map(c=>({code:c.code,name:c.name,summary:summarize(c.rows),rows:c.rows})),
  }));
  return { methodologyVersion:methodology.METHODOLOGY_VERSION, summary:summarize(rows), functions, rows };
}

function maturityLabel(value) {
  if (value == null) return 'Not concluded';
  const labels=['Unperformed','Initial','Managed','Defined','Measured','Optimizing'];
  if (Number.isInteger(value)) return `${value} · ${labels[value]}`;
  return `${value} · Between ${labels[Math.floor(value)]} and ${labels[Math.ceil(value)]}`;
}

function programmeEngagements(db,workspaceId) {
  return db.prepare(`SELECT e.*,u.name lead_name,p.scope_statement,
      (SELECT COUNT(*) FROM csf_subcategory_assessments a WHERE a.engagement_id=e.id AND a.policy_score IS NOT NULL AND a.practice_score IS NOT NULL) assessed_count,
      (SELECT COUNT(*) FROM csf_subcategory_assessments a WHERE a.engagement_id=e.id AND a.status='Approved') approved_count,
      (SELECT COUNT(*) FROM csf_assessment_versions_v2 v WHERE v.engagement_id=e.id) version_count
    FROM csf_engagements e LEFT JOIN users u ON u.id=e.assigned_lead_id
    LEFT JOIN csf_profile_contexts p ON p.engagement_id=e.id
    WHERE e.workspace_id=? AND e.deleted_at IS NULL ORDER BY e.created_at DESC,e.id DESC`).all(workspaceId);
}

function programmeData(db,engagement) {
  const rollup=computeRollup(db,engagement);
  const profile=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagement.id)||{};
  const findings=db.prepare(`SELECT f.*,s.code outcome_code,
      (SELECT COUNT(*) FROM csf_recommendations r WHERE r.finding_id=f.id AND r.deleted_at IS NULL) recommendation_count
    FROM csf_findings f LEFT JOIN csf_subcategory_assessments a ON a.id=f.assessment_id
    LEFT JOIN csf_subcategories s ON s.id=a.subcategory_id
    WHERE f.engagement_id=? AND f.deleted_at IS NULL
    ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,f.created_at DESC`).all(engagement.id);
  const roadmap=Object.fromEntries(['0_3M','3_6M','6_12M','12M_PLUS'].map(phase=>[phase,0]));
  db.prepare(`SELECT r.roadmap_phase,COUNT(*) count FROM csf_recommendations r JOIN csf_findings f ON f.id=r.finding_id
    WHERE f.engagement_id=? AND f.deleted_at IS NULL AND r.deleted_at IS NULL GROUP BY r.roadmap_phase`).all(engagement.id)
    .forEach(r=>{if(Object.hasOwn(roadmap,r.roadmap_phase))roadmap[r.roadmap_phase]=r.count;});
  const categories=rollup.functions.flatMap(fn=>fn.categories.map(category=>{
    const achieved=category.summary.achievedMedian;
    const targetCandidates=[category.summary.targetPolicyMedian,category.summary.targetPracticeMedian].filter(v=>v!=null);
    const target=targetCandidates.length?Math.max(...targetCandidates):null;
    return {...category,functionCode:fn.code,functionName:fn.name,achieved,target,gap:achieved==null||target==null?null:target-achieved};
  }));
  const priorities=categories.filter(c=>c.summary.assessed>0).sort((a,b)=>(b.gap??-1)-(a.gap??-1)||b.summary.lowConfidence-a.summary.lowConfidence).slice(0,5);
  const versions=db.prepare(`SELECT id,version_number,status,created_at,published_at FROM csf_assessment_versions_v2 WHERE engagement_id=? ORDER BY id DESC`).all(engagement.id);
  const published=versions.find(v=>v.status==='published');
  const reviewed=rollup.rows.filter(r=>['Reviewed','Client Validated','Approved'].includes(r.status)).length;
  const approved=rollup.rows.filter(r=>r.status==='Approved').length;
  const profileReady=profile.status==='approved';
  return {rollup,profile,findings,roadmap,priorities,versions,published,reviewed,approved,profileReady,
    maturityLabel,currentLabel:maturityLabel(rollup.summary.achievedMedian),
    targetLabel:maturityLabel(Math.max(...[rollup.summary.targetPolicyMedian,rollup.summary.targetPracticeMedian].filter(v=>v!=null),0))};
}

function profileDefects(profile) {
  if (!profile) return ['Organizational Profile has not been created.'];
  const fields = [
    ['business_context','business context'],['mission_objectives','mission objectives'],['critical_services','critical services'],
    ['critical_assets_data','critical assets and data'],
    ['threat_landscape','threat landscape'],['legal_contractual_requirements','legal and contractual requirements'],
    ['stakeholder_expectations','stakeholder expectations'],['risk_appetite','risk appetite'],['scope_statement','scope statement'],
    ['assessment_limitations','assessment limitations'],
  ];
  return fields.filter(([key])=>String(profile[key]||'').trim().length<40).map(([,label])=>`Complete ${label} with at least 40 characters.`);
}

function publicationDefects(db,engagement) {
  const defects=[];
  const profile=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagement.id);
  if (!profile || profile.status!=='approved') defects.push('The Organizational Profile is not independently approved.');
  const notApproved=db.prepare(`SELECT COUNT(*) c FROM csf_subcategory_assessments WHERE engagement_id=? AND status!='Approved'`).get(engagement.id).c;
  if (notApproved) defects.push(`${notApproved} outcome conclusions are not approved.`);
  const unresolved=db.prepare(`SELECT COUNT(*) c FROM csf_reviewer_comments WHERE engagement_id=? AND resolved_at IS NULL AND deleted_at IS NULL`).get(engagement.id).c;
  if (unresolved) defects.push(`${unresolved} reviewer comments remain unresolved.`);
  const rollup=computeRollup(db,engagement);
  if (rollup.summary.assessed < rollup.summary.inScope-rollup.summary.noVisibility) defects.push('Some in-scope outcomes do not have Policy and Practice conclusions.');
  return defects;
}

function evidenceManifest(db,assessmentId) {
  return evidenceFor(db,assessmentId).map(e=>({id:e.id,evidence_id:e.evidence_id,type:e.type,axis:e.evidence_axis,quality:e.evidence_quality,
    description:e.description,period_start:e.evidence_period_start,period_end:e.evidence_period_end,confidentiality:e.confidentiality,
    source_reliability:e.source_reliability,scope_coverage:e.scope_coverage,testing_method:e.testing_method,test_result:e.test_result}));
}

function createVersion(db,engagement,user,changeSummary) {
  const profile=db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagement.id)||{};
  const rollup=computeRollup(db,engagement);
  const previous=db.prepare(`SELECT version_number FROM csf_assessment_versions_v2 WHERE engagement_id=? ORDER BY id DESC LIMIT 1`).get(engagement.id);
  const next=previous ? `1.${Number(String(previous.version_number).split('.').pop()||0)+1}` : '1.0';
  const profileJson=JSON.stringify(profile);
  const rollupJson=JSON.stringify({summary:rollup.summary,functions:rollup.functions.map(f=>({code:f.code,name:f.name,summary:f.summary,categories:f.categories.map(c=>({code:c.code,name:c.name,summary:c.summary}))}))});
  const outcomePayload=rollup.rows.map(r=>({code:r.code,policy:r.policy_score,practice:r.practice_score,targetPolicy:r.target_policy_score,targetPractice:r.target_practice_score,
    applicability:r.applicability_status,assurance:r.assurance_outcome,evidence:evidenceManifest(db,r.id),tests:testsFor(db,r.id)}));
  const hash=crypto.createHash('sha256').update(JSON.stringify({engagement:engagement.id,version:next,catalog:methodology.CATALOG_HASH,methodology:methodology.METHODOLOGY_HASH,profile:profileJson,rollup:rollupJson,outcomes:outcomePayload})).digest('hex');
  const create=db.transaction(()=>{
    const versionId=Number(db.prepare(`INSERT INTO csf_assessment_versions_v2
      (workspace_id,engagement_id,version_number,status,catalog_version,catalog_hash,methodology_version,methodology_hash,
       profile_snapshot_json,rollup_snapshot_json,snapshot_hash,change_summary,created_by)
      VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?)`).run(engagement.workspace_id,engagement.id,next,engagement.catalog_version,
        methodology.CATALOG_HASH,methodology.METHODOLOGY_VERSION,methodology.METHODOLOGY_HASH,profileJson,rollupJson,hash,String(changeSummary||'Assessment snapshot'),user.id).lastInsertRowid);
    const ins=db.prepare(`INSERT INTO csf_assessment_version_outcomes_v2
      (version_id,assessment_id,subcategory_id,outcome_code,applicability_status,profile_priority,policy_score,practice_score,
       target_policy_score,target_practice_score,policy_rationale,practice_rationale,assurance_outcome,evidence_confidence,
       business_impact,assessment_period_start,assessment_period_end,population_description,population_size,sample_size,
       sample_rationale,evidence_manifest_json,tests_snapshot_json,exceptions_snapshot_json,findings_snapshot_json,methodology_content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rollup.rows) {
      const exceptions=db.prepare(`SELECT * FROM csf_assessment_exceptions WHERE assessment_id=? ORDER BY id`).all(r.id);
      const findings=db.prepare(`SELECT f.*,COALESCE(json_group_array(json_object('id',rec.id,'title',rec.description,'priority',rec.priority,'roadmap_phase',rec.roadmap_phase)),'[]') recommendations
        FROM csf_findings f LEFT JOIN csf_recommendations rec ON rec.finding_id=f.id AND rec.deleted_at IS NULL
        WHERE f.assessment_id=? AND f.deleted_at IS NULL GROUP BY f.id ORDER BY f.id`).all(r.id);
      const method=methodology.forCode(r.code);
      ins.run(versionId,r.id,r.subcategory_id,r.code,r.applicability_status,r.profile_priority,r.policy_score,r.practice_score,
        r.target_policy_score,r.target_practice_score,r.policy_rationale,r.practice_rationale,r.assurance_outcome,r.evidence_confidence,
        r.business_impact,r.assessment_period_start,r.assessment_period_end,r.population_description,r.population_size,r.sample_size,
        r.sample_rationale,JSON.stringify(evidenceManifest(db,r.id)),JSON.stringify(testsFor(db,r.id)),JSON.stringify(exceptions),JSON.stringify(findings),method.content_hash);
    }
    return versionId;
  });
  return create();
}

module.exports={
  OUTCOME_STATES,ASSURANCE_OUTCOMES,PRIORITIES,EVIDENCE_QUALITY,EVIDENCE_AXES,
  isFirmOperator,isManager,rolesOnEngagement,canView,canCreate,canAssess,canScore,canReview,canApprove,
  ensureAssessmentRows,methodologyRow,evidenceFor,testsFor,scoreGateDefects,outcomeReadiness,computeRollup,
  maturityLabel,programmeEngagements,programmeData,
  profileDefects,publicationDefects,evidenceManifest,createVersion,
};
