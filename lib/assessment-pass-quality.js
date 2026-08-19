'use strict';

const evReads = require('./evidence-reads');

// Formal assessment-pass quality gates. A reportable pass must have a
// traceable conclusion for every ISO 27001 requirement in its lineage and
// must contain at least one verification saved in the pass itself.

function qualityForPass(db, workspaceId, pass) {
  const totalItems = db.prepare(`SELECT COUNT(*) AS c FROM iso_items
    WHERE type IN ('clause','control')`).get().c;

  if (!pass) {
    return {
      ready: false,
      totalItems,
      assessedItems: 0,
      remainingItems: totalItems,
      coveragePct: 0,
      itemsTouched: 0,
      saveCount: 0,
      defects: ['Start an assessment pass before producing formal deliverables.']
    };
  }

  const conclusions = db.prepare(`SELECT i.id, i.title,
      COALESCE((SELECT h.status FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id=h.pass_id
        WHERE h.workspace_id=? AND p.workspace_id=? AND h.iso_item_id=i.id AND p.pass_number<=?
        ORDER BY p.pass_number DESC,h.id DESC LIMIT 1),'Not Assessed') AS status,
      COALESCE((SELECT h.applicability FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id=h.pass_id
        WHERE h.workspace_id=? AND p.workspace_id=? AND h.iso_item_id=i.id AND p.pass_number<=?
        ORDER BY p.pass_number DESC,h.id DESC LIMIT 1),'included') AS applicability,
      COALESCE((SELECT h.notes FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id=h.pass_id
        WHERE h.workspace_id=? AND p.workspace_id=? AND h.iso_item_id=i.id AND p.pass_number<=?
        ORDER BY p.pass_number DESC,h.id DESC LIMIT 1),'') AS notes,
      COALESCE((SELECT h.exclusion_justification FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id=h.pass_id
        WHERE h.workspace_id=? AND p.workspace_id=? AND h.iso_item_id=i.id AND p.pass_number<=?
        ORDER BY p.pass_number DESC,h.id DESC LIMIT 1),'') AS exclusion_justification
    FROM iso_items i WHERE i.type IN ('clause','control') ORDER BY i.sort_order`)
    .all(
      workspaceId,workspaceId,pass.pass_number,
      workspaceId,workspaceId,pass.pass_number,
      workspaceId,workspaceId,pass.pass_number,
      workspaceId,workspaceId,pass.pass_number
    );
  const assessedItems = conclusions.filter(row => row.status !== 'Not Assessed').length;

  const activity = db.prepare(`SELECT
      COUNT(DISTINCT iso_item_id) AS items_touched,
      COUNT(*) AS save_count
    FROM control_state_history
    WHERE workspace_id=? AND pass_id=?`).get(workspaceId, pass.id);

  const remainingItems = Math.max(0, totalItems - assessedItems);
  const itemsTouched = activity.items_touched || 0;
  const saveCount = activity.save_count || 0;
  const defects = [];
  if (remainingItems > 0) {
    defects.push(`${remainingItems} requirement${remainingItems === 1 ? '' : 's'} still need${remainingItems === 1 ? 's' : ''} a recorded conclusion.`);
  }
  if (itemsTouched === 0) {
    defects.push('Save at least one verification decision in this pass.');
  }

  const evidenceCoverage = evReads.coverageEvidenceByControl(db, workspaceId);
  const unsupportedImplemented = conclusions.filter(row =>
    row.status === 'Implemented' && !(evidenceCoverage[row.id] && evidenceCoverage[row.id].attached > 0));
  const gapStatuses = new Set(['Partially Implemented','Work In Progress','Not Implemented']);
  const unsupportedGapNarratives = conclusions.filter(row =>
    gapStatuses.has(row.status) && String(row.notes || '').trim().length < 20);
  const unsupportedExclusions = conclusions.filter(row =>
    (row.status === 'Not Applicable' || row.applicability === 'excluded') &&
    String(row.exclusion_justification || '').trim().length < 20);

  if (unsupportedImplemented.length) {
    defects.push(`${unsupportedImplemented.length} Implemented claim${unsupportedImplemented.length === 1 ? '' : 's'} need linked, current evidence.`);
  }
  if (unsupportedGapNarratives.length) {
    defects.push(`${unsupportedGapNarratives.length} gap conclusion${unsupportedGapNarratives.length === 1 ? '' : 's'} need a specific observed-state rationale.`);
  }
  if (unsupportedExclusions.length) {
    defects.push(`${unsupportedExclusions.length} exclusion${unsupportedExclusions.length === 1 ? '' : 's'} need a defensible scope justification.`);
  }

  return {
    ready: totalItems > 0 && remainingItems === 0 && itemsTouched > 0 &&
      unsupportedImplemented.length === 0 && unsupportedGapNarratives.length === 0 && unsupportedExclusions.length === 0,
    totalItems,
    assessedItems,
    remainingItems,
    coveragePct: totalItems ? Math.round((assessedItems / totalItems) * 100) : 0,
    itemsTouched,
    saveCount,
    unsupportedImplemented,
    unsupportedGapNarratives,
    unsupportedExclusions,
    defects
  };
}

function gateMessage(quality) {
  return quality && quality.defects && quality.defects.length
    ? quality.defects.join(' ')
    : 'The assessment pass has not met its completion gates.';
}

function nextUnconcludedItem(db, workspaceId, pass, afterSortOrder) {
  if (!pass) return null;
  const find = db.prepare(`SELECT i.id, i.sort_order
    FROM iso_items i
    WHERE i.type IN ('clause','control')
      AND i.sort_order>?
      AND COALESCE((
        SELECT h.status
        FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id=h.pass_id
        WHERE h.workspace_id=? AND p.workspace_id=?
          AND h.iso_item_id=i.id AND p.pass_number<=?
        ORDER BY p.pass_number DESC, h.id DESC
        LIMIT 1
      ), 'Not Assessed')='Not Assessed'
    ORDER BY i.sort_order
    LIMIT 1`);
  const after = Number.isFinite(Number(afterSortOrder)) ? Number(afterSortOrder) : -1;
  return find.get(after, workspaceId, workspaceId, pass.pass_number)
    || (after >= 0 ? find.get(-1, workspaceId, workspaceId, pass.pass_number) : null);
}

module.exports = { qualityForPass, gateMessage, nextUnconcludedItem };
