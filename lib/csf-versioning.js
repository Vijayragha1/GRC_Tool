// Snapshot + diff helpers for the NIST CSF module (Stage 7).
//
// A snapshot is a frozen, normalised copy of an engagement at the moment of
// publish. Subcategory assessments, findings, and recommendations are cloned
// into snapshot tables. Once written, snapshot rows are read-only forever -
// republish creates a new version with a fresh snapshot rather than mutating
// the old one. This is what makes "show me the SoA we published last March"
// auditable.

const crypto = require('crypto');
const csfScoring = require('./csf-scoring');

// Capture the state of an engagement under a new version_number. Returns the
// new version_id. Runs in a transaction so a half-snapshot can never persist.
function createSnapshot(db, engagement, versionNumber, publishedBy, changeSummary) {
  if (!engagement) throw new Error('createSnapshot: engagement required');
  if (!versionNumber) throw new Error('createSnapshot: versionNumber required');

  const tx = db.transaction(() => {
    const assessRows = db.prepare(`
      SELECT a.subcategory_id, a.current_score, a.target_score, a.narrative, a.status,
        a.is_bulk_set, a.excluded_from_scope, a.exclusion_rationale,
        a.profile_priority, a.current_profile_statement, a.target_profile_statement,
        a.business_impact, a.effectiveness_conclusion, a.evidence_confidence,
        a.client_validation_status, COALESCE(wpi.weight, 1.0) AS weight
      FROM csf_subcategory_assessments a
      LEFT JOIN csf_weighting_profile_items wpi
        ON wpi.subcategory_id = a.subcategory_id AND wpi.profile_id = ?
      WHERE a.engagement_id = ?
      ORDER BY a.subcategory_id
    `).all(engagement.weighting_profile_id || 0, engagement.id);
    const findingRows = db.prepare(`
      SELECT f.id, f.assessment_id, a.subcategory_id, f.title, f.description, f.severity,
        f.status, f.promoted_to_engagement_theme
      FROM csf_findings f
      LEFT JOIN csf_subcategory_assessments a ON a.id = f.assessment_id
      WHERE f.engagement_id=? AND f.deleted_at IS NULL
      ORDER BY f.id
    `).all(engagement.id);
    let recRows = [];
    if (findingRows.length) {
      const placeholders = findingRows.map(() => '?').join(',');
      recRows = db.prepare(`
        SELECT id, finding_id, description, estimated_effort, priority,
          target_completion_date, roadmap_phase
        FROM csf_recommendations
        WHERE finding_id IN (${placeholders}) AND deleted_at IS NULL
        ORDER BY id
      `).all(...findingRows.map(f => f.id));
    }
    const profileContext = db.prepare(`SELECT * FROM csf_profile_contexts WHERE engagement_id=?`).get(engagement.id) || null;
    const tierAssessments = db.prepare(`SELECT * FROM csf_tier_assessments WHERE engagement_id=? ORDER BY
      CASE scope_type WHEN 'overall' THEN 0 ELSE 1 END,
      CASE function_code WHEN 'GV' THEN 1 WHEN 'ID' THEN 2 WHEN 'PR' THEN 3 WHEN 'DE' THEN 4 WHEN 'RS' THEN 5 WHEN 'RC' THEN 6 ELSE 99 END`).all(engagement.id);
    const snapshotHash = crypto.createHash('sha256').update(JSON.stringify({
      engagement: { id: engagement.id, catalog_version: engagement.catalog_version, name: engagement.name },
      profileContext,
      tierAssessments,
      assessments: assessRows,
      findings: findingRows,
      recommendations: recRows,
    })).digest('hex');

    // Mark prior versions as not current.
    db.prepare(`UPDATE csf_engagement_versions SET is_current=0 WHERE engagement_id=?`).run(engagement.id);

    // Create the version row.
    const versionId = db.prepare(`
      INSERT INTO csf_engagement_versions (engagement_id, version_number, published_by, change_summary,
        profile_context_json, tier_snapshot_json, snapshot_hash, is_current)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(engagement.id, versionNumber, publishedBy || null, changeSummary || null,
      JSON.stringify(profileContext), JSON.stringify(tierAssessments), snapshotHash).lastInsertRowid;

    // Clone subcategory assessments (with weight resolved from the engagement's profile).
    const insAssess = db.prepare(`
      INSERT INTO csf_subcategory_assessment_snapshots (version_id, subcategory_id, current_score, target_score,
        narrative, status, is_bulk_set, excluded_from_scope, exclusion_rationale, weight,
        profile_priority, current_profile_statement, target_profile_statement, business_impact,
        effectiveness_conclusion, evidence_confidence, client_validation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    assessRows.forEach(r => insAssess.run(versionId, r.subcategory_id, r.current_score, r.target_score,
      r.narrative, r.status, r.is_bulk_set, r.excluded_from_scope, r.exclusion_rationale, r.weight,
      r.profile_priority, r.current_profile_statement, r.target_profile_statement, r.business_impact,
      r.effectiveness_conclusion, r.evidence_confidence, r.client_validation_status));

    // Clone findings (live, undeleted only).
    const insFinding = db.prepare(`
      INSERT INTO csf_finding_snapshots (version_id, finding_id, subcategory_id, title, description,
        severity, status, promoted_to_engagement_theme)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    findingRows.forEach(f => insFinding.run(versionId, f.id, f.subcategory_id, f.title, f.description,
      f.severity, f.status, f.promoted_to_engagement_theme));

    // Clone recommendations attached to live findings.
    if (recRows.length) {
      const insRec = db.prepare(`
        INSERT INTO csf_recommendation_snapshots (version_id, recommendation_id, finding_id, description,
          estimated_effort, priority, target_completion_date, roadmap_phase)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      recRows.forEach(r => insRec.run(versionId, r.id, r.finding_id, r.description,
        r.estimated_effort, r.priority, r.target_completion_date, r.roadmap_phase));
    }

    return versionId;
  });
  return tx();
}

// Build a rollup structure from a snapshot. Same shape as
// csfScoring.computeEngagementRollup so the same view can render either.
function loadSnapshotRollup(db, version) {
  if (!version) return null;
  const eng = db.prepare(`SELECT catalog_version FROM csf_engagements WHERE id=?`).get(version.engagement_id);
  const catalog = eng.catalog_version;

  const fns = db.prepare(`SELECT * FROM csf_functions WHERE catalog_version=? ORDER BY display_order`).all(catalog);
  const cats = db.prepare(`SELECT * FROM csf_categories WHERE catalog_version=? ORDER BY display_order`).all(catalog);
  const subs = db.prepare(`SELECT * FROM csf_subcategories WHERE catalog_version=? ORDER BY display_order`).all(catalog);
  const snaps = db.prepare(`SELECT * FROM csf_subcategory_assessment_snapshots WHERE version_id=?`).all(version.id);
  let tierAssessments = [];
  try { tierAssessments = JSON.parse(version.tier_snapshot_json || '[]') || []; } catch (_) { tierAssessments = []; }
  const tierByScope = Object.fromEntries(tierAssessments.map(t => [`${t.scope_type}:${t.scope_code || ''}`, t]));

  const byId = {};
  snaps.forEach(s => { byId[s.subcategory_id] = s; });
  const subsByCat = {};
  subs.forEach(s => { (subsByCat[s.category_id] = subsByCat[s.category_id] || []).push(s); });
  const catsByFn = {};
  cats.forEach(c => { (catsByFn[c.function_id] = catsByFn[c.function_id] || []).push(c); });

  let totalSubs = 0, scoredSubs = 0, excludedSubs = 0;
  const functions = fns.map(fn => {
    const fnCats = (catsByFn[fn.id] || []).map(cat => {
      const catSubs = (subsByCat[cat.id] || []).map(s => {
        const snap = byId[s.id] || {};
        totalSubs++;
        if (snap.excluded_from_scope) excludedSubs++;
        if (snap.current_score != null && !snap.excluded_from_scope) scoredSubs++;
        return {
          id: s.id, code: s.code, description: s.description,
          current: snap.excluded_from_scope ? null : snap.current_score,
          target: snap.excluded_from_scope ? null : snap.target_score,
          weight: snap.weight == null ? 1 : snap.weight,
          excluded: !!snap.excluded_from_scope,
          status: snap.status || 'Not Started',
          profilePriority: snap.profile_priority || 'Moderate',
          currentProfileStatement: snap.current_profile_statement || null,
          targetProfileStatement: snap.target_profile_statement || null,
          businessImpact: snap.business_impact || null,
          effectiveness: snap.effectiveness_conclusion || null,
          evidenceConfidence: snap.evidence_confidence || null,
          clientValidationStatus: snap.client_validation_status || null,
        };
      });
      const eligible = catSubs.filter(s => !s.excluded);
      const cur = csfScoring.weightedMean(eligible, 'current');
      const tgt = csfScoring.weightedMean(eligible, 'target');
      return {
        id: cat.id, code: cat.code, name: cat.name, description: cat.description,
        current: csfScoring.r2(cur), target: csfScoring.r2(tgt),
        gap: (cur != null && tgt != null) ? csfScoring.r2(tgt - cur) : null,
        subcategories: catSubs,
      };
    });
    const fnCur = csfScoring.mean(fnCats.map(c => c.current));
    const fnTgt = csfScoring.mean(fnCats.map(c => c.target));
    return {
      id: fn.id, code: fn.code, name: fn.name, description: fn.description,
      current: csfScoring.r2(fnCur), target: csfScoring.r2(fnTgt),
      gap: (fnCur != null && fnTgt != null) ? csfScoring.r2(fnTgt - fnCur) : null,
      tier: csfScoring.tierConclusion(tierByScope[`function:${fn.code}`]?.current_tier,
        tierByScope[`function:${fn.code}`]?.status, tierByScope[`function:${fn.code}`]?.governance_rationale),
      tier_target: csfScoring.tierConclusion(tierByScope[`function:${fn.code}`]?.target_tier,
        tierByScope[`function:${fn.code}`]?.status, tierByScope[`function:${fn.code}`]?.risk_management_rationale),
      categories: fnCats,
    };
  });
  const overallCur = csfScoring.mean(functions.map(f => f.current));
  const overallTgt = csfScoring.mean(functions.map(f => f.target));
  return {
    overall: {
      current: csfScoring.r2(overallCur), target: csfScoring.r2(overallTgt),
      gap: (overallCur != null && overallTgt != null) ? csfScoring.r2(overallTgt - overallCur) : null,
      tier: csfScoring.tierConclusion(tierByScope['overall:']?.current_tier,
        tierByScope['overall:']?.status, tierByScope['overall:']?.governance_rationale),
      tier_target: csfScoring.tierConclusion(tierByScope['overall:']?.target_tier,
        tierByScope['overall:']?.status, tierByScope['overall:']?.risk_management_rationale),
    },
    functions,
    coverage: {
      total: totalSubs, scored: scoredSubs, excluded: excludedSubs,
      scoredPct: totalSubs === 0 ? 0 : Math.round((scoredSubs / (totalSubs - excludedSubs || 1)) * 100),
    },
    tierMethod: 'separate_evidence_backed_assessment',
    tierAssessments,
  };
}

// Diff two versions. Returns score deltas (via csfScoring.scoreDelta) plus
// findings + recommendations added / removed / modified between the two.
function computeVersionDiff(db, oldVersion, newVersion) {
  if (!oldVersion || !newVersion) return null;

  const oldRollup = loadSnapshotRollup(db, oldVersion);
  const newRollup = loadSnapshotRollup(db, newVersion);
  const scoreDeltas = csfScoring.scoreDelta(oldRollup, newRollup);

  const oldFindings = db.prepare(`SELECT * FROM csf_finding_snapshots WHERE version_id=?`).all(oldVersion.id);
  const newFindings = db.prepare(`SELECT * FROM csf_finding_snapshots WHERE version_id=?`).all(newVersion.id);

  const oldFindingIds = new Set(oldFindings.map(f => f.finding_id));
  const newFindingIds = new Set(newFindings.map(f => f.finding_id));
  const added = newFindings.filter(f => !oldFindingIds.has(f.finding_id));
  const removed = oldFindings.filter(f => !newFindingIds.has(f.finding_id));
  // Modified = same finding_id but title/description/severity/status changed
  const modified = [];
  for (const nf of newFindings) {
    const of = oldFindings.find(f => f.finding_id === nf.finding_id);
    if (!of) continue;
    const changes = {};
    ['title', 'description', 'severity', 'status'].forEach(k => {
      if ((of[k] || null) !== (nf[k] || null)) changes[k] = { from: of[k], to: nf[k] };
    });
    if (Object.keys(changes).length) modified.push({ finding_id: nf.finding_id, title: nf.title, changes });
  }

  const oldRecs = db.prepare(`SELECT * FROM csf_recommendation_snapshots WHERE version_id=?`).all(oldVersion.id);
  const newRecs = db.prepare(`SELECT * FROM csf_recommendation_snapshots WHERE version_id=?`).all(newVersion.id);
  const oldRecIds = new Set(oldRecs.map(r => r.recommendation_id));
  const newRecIds = new Set(newRecs.map(r => r.recommendation_id));
  const addedRecs = newRecs.filter(r => !oldRecIds.has(r.recommendation_id));
  const removedRecs = oldRecs.filter(r => !newRecIds.has(r.recommendation_id));

  return {
    oldVersion, newVersion,
    scoreDeltas,
    findings: { added, removed, modified },
    recommendations: { added: addedRecs, removed: removedRecs },
  };
}

// Compute the next default version number. v1.0 if no versions; bump the
// minor of the current is_current otherwise.
function nextVersionNumber(db, engagement) {
  const current = db.prepare(`SELECT version_number FROM csf_engagement_versions WHERE engagement_id=? ORDER BY published_at DESC LIMIT 1`).get(engagement.id);
  if (!current) return '1.0';
  const m = String(current.version_number).match(/^(\d+)\.(\d+)$/);
  if (!m) return '1.0';
  const major = parseInt(m[1], 10), minor = parseInt(m[2], 10);
  return `${major}.${minor + 1}`;
}

module.exports = {
  createSnapshot,
  loadSnapshotRollup,
  computeVersionDiff,
  nextVersionNumber,
};
