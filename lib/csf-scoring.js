// Scoring engine for the NIST CSF module.
//
// Pure helpers. No DB I/O except for `computeEngagementRollup` which loads the
// engagement's subcategory assessments, weighting profile, and tier mappings in
// one pass and returns a nested rollup structure.
//
// Per handoff Section 6:
//   Category.Current  = Σ(sub.current × weight) / Σ(weights)    // weighted mean
//   Category.Target   = Σ(sub.target  × weight) / Σ(weights)    // ditto
//   Function          = mean of Category scores (equal weights at Cat level)
//   Overall           = mean of 6 Function scores
//   Tier overlay      = at Function and Overall only, from csf_tier_mappings
//   Gap               = Target - Current at every layer
//
// Excluded subcategories (excluded_from_scope=1) drop out of the denominator.
// Null scores drop out of the denominator (not treated as 0). Empty categories
// (no scored subs) return null, not zero. Decimals carried at full precision;
// callers round for display.

// Round to 2dp for storage / math comparisons.
function r2(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

// Round to 1dp for display.
function r1(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

function weightedMean(items, valueKey, weightKey = 'weight') {
  let sumWX = 0, sumW = 0;
  for (const it of items) {
    const v = it[valueKey];
    if (v === null || v === undefined) continue;
    const w = it[weightKey] == null ? 1 : it[weightKey];
    sumWX += v * w;
    sumW += w;
  }
  if (sumW === 0) return null;
  return sumWX / sumW;
}

function mean(values) {
  const nums = values.filter(v => v !== null && v !== undefined);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Resolve a CMMI score to its Tier (1-4 with name + label).
// `tierMappings` is the array from csf_tier_mappings ORDER BY tier.
function applyTierOverlay(cmmiScore, tierMappings) {
  if (cmmiScore === null || cmmiScore === undefined) return null;
  for (const t of tierMappings) {
    if (cmmiScore >= t.cmmi_lower && cmmiScore <= t.cmmi_upper) {
      return { tier: t.tier, name: t.name, label: `Tier ${t.tier} - ${t.name} (${r1(cmmiScore)})` };
    }
  }
  // Above max upper bound — clamp to top tier.
  const top = tierMappings[tierMappings.length - 1];
  return top ? { tier: top.tier, name: top.name, label: `Tier ${top.tier} - ${top.name} (${r1(cmmiScore)})` } : null;
}

// Load + roll up an engagement in one call. Returns nested structure used by
// the Scores view and (later) the deliverable generators.
//
//   {
//     overall: { current, target, gap, tier: { ... } },
//     functions: [
//       { code, name, current, target, gap, tier, categories: [
//         { code, name, current, target, gap, subcategories: [
//           { code, current, target, weight, excluded }
//         ]}
//       ]}
//     ],
//     coverage: { total, scored, excluded, scoredPct }
//   }
function computeEngagementRollup(db, engagement) {
  if (!engagement) return null;
  const catalog = engagement.catalog_version;

  // Pull catalog hierarchy (functions / categories / subcategories) in
  // display order so the output structure naturally reflects NIST's intent.
  const fns = db.prepare(`SELECT * FROM csf_functions WHERE catalog_version=? ORDER BY display_order`).all(catalog);
  const cats = db.prepare(`SELECT * FROM csf_categories WHERE catalog_version=? ORDER BY display_order`).all(catalog);
  const subs = db.prepare(`SELECT * FROM csf_subcategories WHERE catalog_version=? ORDER BY display_order`).all(catalog);

  // Pull this engagement's assessments + weights in one shot.
  const assessRows = db.prepare(`
    SELECT a.subcategory_id, a.current_score, a.target_score, a.excluded_from_scope, a.status,
      COALESCE(wpi.weight, 1.0) AS weight
    FROM csf_subcategory_assessments a
    LEFT JOIN csf_weighting_profile_items wpi
      ON wpi.subcategory_id = a.subcategory_id AND wpi.profile_id = ?
    WHERE a.engagement_id = ?
  `).all(engagement.weighting_profile_id || 0, engagement.id);

  const tierMappings = db.prepare(`SELECT tier, name, cmmi_lower, cmmi_upper FROM csf_tier_mappings WHERE catalog_version=? ORDER BY tier`).all(catalog);

  // Index everything by id for fast lookup.
  const byId = {};
  for (const r of assessRows) byId[r.subcategory_id] = r;
  const subsByCat = {};
  subs.forEach(s => { (subsByCat[s.category_id] = subsByCat[s.category_id] || []).push(s); });
  const catsByFn = {};
  cats.forEach(c => { (catsByFn[c.function_id] = catsByFn[c.function_id] || []).push(c); });

  let totalSubs = 0, scoredSubs = 0, excludedSubs = 0;

  const functions = fns.map(fn => {
    const fnCats = (catsByFn[fn.id] || []).map(cat => {
      const catSubs = (subsByCat[cat.id] || []).map(s => {
        const a = byId[s.id] || {};
        totalSubs++;
        if (a.excluded_from_scope) excludedSubs++;
        if (a.current_score != null && !a.excluded_from_scope) scoredSubs++;
        return {
          id: s.id, code: s.code, description: s.description,
          current: a.excluded_from_scope ? null : a.current_score,
          target: a.excluded_from_scope ? null : a.target_score,
          weight: a.weight == null ? 1 : a.weight,
          excluded: !!a.excluded_from_scope,
          status: a.status || 'Not Started',
        };
      });
      const eligibleSubs = catSubs.filter(s => !s.excluded);
      const cur = weightedMean(eligibleSubs, 'current');
      const tgt = weightedMean(eligibleSubs, 'target');
      return {
        id: cat.id, code: cat.code, name: cat.name, description: cat.description,
        current: r2(cur), target: r2(tgt),
        gap: (cur != null && tgt != null) ? r2(tgt - cur) : null,
        subcategories: catSubs,
      };
    });

    // Function = mean of Category scores (equal weights at Cat level, #24).
    const fnCur = mean(fnCats.map(c => c.current));
    const fnTgt = mean(fnCats.map(c => c.target));
    const fnTier = applyTierOverlay(fnCur, tierMappings);
    const fnTierTarget = applyTierOverlay(fnTgt, tierMappings);
    return {
      id: fn.id, code: fn.code, name: fn.name, description: fn.description,
      current: r2(fnCur), target: r2(fnTgt),
      gap: (fnCur != null && fnTgt != null) ? r2(fnTgt - fnCur) : null,
      tier: fnTier, tier_target: fnTierTarget,
      categories: fnCats,
    };
  });

  // Overall = mean of 6 Function scores.
  const overallCur = mean(functions.map(f => f.current));
  const overallTgt = mean(functions.map(f => f.target));

  return {
    overall: {
      current: r2(overallCur), target: r2(overallTgt),
      gap: (overallCur != null && overallTgt != null) ? r2(overallTgt - overallCur) : null,
      tier: applyTierOverlay(overallCur, tierMappings),
      tier_target: applyTierOverlay(overallTgt, tierMappings),
    },
    functions,
    coverage: {
      total: totalSubs,
      scored: scoredSubs,
      excluded: excludedSubs,
      scoredPct: totalSubs === 0 ? 0 : Math.round((scoredSubs / (totalSubs - excludedSubs || 1)) * 100),
    },
    tierMappings,
  };
}

// Diff two rollups (e.g. for snapshot-to-snapshot delta in Stage 7). Pure.
// Returns nested deltas where each level has { from, to, delta }.
function scoreDelta(prevRollup, currentRollup) {
  if (!prevRollup || !currentRollup) return null;
  const delta = (a, b) => (a == null || b == null) ? null : r2(b - a);
  const out = {
    overall: { from: prevRollup.overall.current, to: currentRollup.overall.current, delta: delta(prevRollup.overall.current, currentRollup.overall.current) },
    functions: [],
  };
  for (const cf of currentRollup.functions) {
    const pf = prevRollup.functions.find(p => p.code === cf.code);
    if (!pf) continue;
    out.functions.push({
      code: cf.code, name: cf.name,
      from: pf.current, to: cf.current,
      delta: delta(pf.current, cf.current),
      categories: cf.categories.map(cc => {
        const pc = pf.categories.find(p => p.code === cc.code);
        return {
          code: cc.code, name: cc.name,
          from: pc ? pc.current : null, to: cc.current,
          delta: pc ? delta(pc.current, cc.current) : null,
        };
      }),
    });
  }
  return out;
}

module.exports = {
  r1, r2,
  weightedMean,
  mean,
  applyTierOverlay,
  computeEngagementRollup,
  scoreDelta,
};
