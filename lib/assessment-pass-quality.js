'use strict';

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

  const assessedItems = db.prepare(`SELECT COUNT(*) AS c
    FROM iso_items i
    WHERE i.type IN ('clause','control')
      AND COALESCE((
        SELECT h.status
        FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id=h.pass_id
        WHERE h.workspace_id=? AND p.workspace_id=?
          AND h.iso_item_id=i.id AND p.pass_number<=?
        ORDER BY p.pass_number DESC, h.id DESC
        LIMIT 1
      ), 'Not Assessed') != 'Not Assessed'`).get(workspaceId, workspaceId, pass.pass_number).c;

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

  return {
    ready: totalItems > 0 && remainingItems === 0 && itemsTouched > 0,
    totalItems,
    assessedItems,
    remainingItems,
    coveragePct: totalItems ? Math.round((assessedItems / totalItems) * 100) : 0,
    itemsTouched,
    saveCount,
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
